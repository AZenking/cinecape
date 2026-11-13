import { randomUUID } from 'node:crypto';
import { ProblemCode } from '@hmp/shared';
import { Database } from '@platform/database/database';
import { DomainError } from '@platform/http-common/domain-error';

/**
 * 数据治理查询/清理(021-source-governance,contracts/api.md §3)。
 *
 * 这是 settings 管理面的跨表治理投影:来源、EPG、快照、刷新任务与线路分属不同上下文,
 * 但「按家庭 + 保留期」的清理必须在一个事务内完成。本模块只执行显式 target 的白名单 SQL,
 * 不暴露通用查询能力;所有谓词显式带 household_id;不做后台静默清理。
 */

export const DEFAULT_RETENTION_DAYS = 30;

export const CLEANUP_TARGETS = [
  'expired-programmes',
  'stale-entries',
  'snapshots',
  'refresh-jobs',
  'archived-sources',
] as const;

export type CleanupTarget = (typeof CLEANUP_TARGETS)[number];

export interface GovernanceOverview {
  retentionDays: number;
  archivedSources: Array<{
    id: string;
    name: string;
    kind: string;
    archivedAt: string;
    lastSuccessAt: string | null;
    version: number;
  }>;
  counts: {
    expiredProgrammes: number;
    staleEntries: number;
    snapshots: number;
    snapshotBytes: number;
    refreshJobs: number;
    archivedSources: number;
  };
}

export interface CleanupResult {
  target: CleanupTarget;
  dryRun: boolean;
  deleted: number;
  bytesFreed: number;
  detail: Record<string, number>;
}

interface CountRow {
  n: number;
}

interface BytesRow {
  n: number;
  bytes: number;
}

function cutoffIso(days: number, nowMs = Date.now()): string {
  return new Date(nowMs - days * 24 * 60 * 60 * 1000).toISOString();
}

function count(db = Database.db, sql: string, ...params: unknown[]): number {
  const row = db.prepare(sql).get(...params) as CountRow | undefined;
  return row?.n ?? 0;
}

/** 概览:全部按默认保留期计算(服务端 now,不信任客户端)。 */
export function readGovernanceOverview(householdId: string, retentionDays = DEFAULT_RETENTION_DAYS): GovernanceOverview {
  const db = Database.db;
  const cutoff = cutoffIso(retentionDays);
  const archivedSources = db
    .prepare(
      `SELECT ms.id, ms.name, ms.kind, sa.archived_at AS archivedAt,
              ms.last_success_at AS lastSuccessAt, ms.version
         FROM source_archive sa
         JOIN media_source ms ON ms.household_id = sa.household_id AND ms.id = sa.source_id
        WHERE sa.household_id = ?
        ORDER BY sa.archived_at DESC, ms.id`,
    )
    .all(householdId) as GovernanceOverview['archivedSources'];

  const snapshotCandidates = db
    .prepare(
      `SELECT COUNT(*) AS n, COALESCE(SUM(byte_size), 0) AS bytes
         FROM source_import_snapshot s
        WHERE s.household_id = ? AND s.captured_at < ?
          AND s.id NOT IN (
            SELECT latest.id FROM source_import_snapshot latest
             WHERE latest.household_id = s.household_id AND latest.source_id = s.source_id
             ORDER BY latest.captured_at DESC, latest.id DESC LIMIT 1
          )`,
    )
    .get(householdId, cutoff) as BytesRow;

  return {
    retentionDays,
    archivedSources,
    counts: {
      expiredProgrammes: count(
        db,
        'SELECT COUNT(*) AS n FROM epg_programme WHERE household_id = ? AND ends_at < ?',
        householdId,
        cutoff,
      ),
      staleEntries: count(
        db,
        `SELECT COUNT(*) AS n FROM source_entry
          WHERE household_id = ? AND present = 0 AND missing_since IS NOT NULL AND missing_since < ?`,
        householdId,
        cutoff,
      ),
      snapshots: snapshotCandidates.n,
      snapshotBytes: snapshotCandidates.bytes,
      refreshJobs: count(
        db,
        `SELECT COUNT(*) AS n FROM source_refresh
          WHERE household_id = ? AND created_at < ?
            AND status IN ('succeeded','failed','interrupted','discarded','expired','stale')`,
        householdId,
        cutoff,
      ),
      archivedSources: archivedSources.length,
    },
  };
}


/**
 * 解绑 playback_session / 删除 playback_input_binding 对指定线路的引用。
 *
 * playback_source 被 playback_session、playback_input_binding 以 NO ACTION 引用,
 * 直接 DELETE 会 `FOREIGN KEY constraint failed`(真实库:看完的历史会话仍指向线路)。
 * - 活动会话(preparing/ready/playing/paused)不允许解绑 —— 会话 CHECK 要求
 *   可播状态必须同时有源与交付模式;此时以 409 SOURCE_BUSY 拒绝,等播放结束再清理;
 * - 历史/终态会话解绑后保留观看记录,仅丢失「当时用的哪条线路」;
 * - 输入绑定是播放准备期的临时状态,直接删除。
 *
 * @param lineIdsSql 选出待删除 playback_source.id 的子查询(须以 household_id 为首参)
 * @param params 子查询参数(不含外层 household_id)
 */
function detachPlaybackReferences(
  db: typeof Database.db,
  householdId: string,
  lineIdsSql: string,
  params: readonly unknown[],
): void {
  const activeSessions = count(
    db,
    `SELECT COUNT(*) AS n FROM playback_session
      WHERE household_id = ? AND state IN ('preparing','ready','playing','paused')
        AND playback_source_id IN (${lineIdsSql})`,
    householdId,
    ...params,
  );
  if (activeSessions > 0) {
    throw new DomainError(409, ProblemCode.SOURCE_BUSY, '该来源仍有进行中的播放会话,请结束后再清理。');
  }
  db.prepare(
    `UPDATE playback_session SET playback_source_id = NULL
      WHERE household_id = ? AND playback_source_id IN (${lineIdsSql})`,
  ).run(householdId, ...params);
  db.prepare(
    `DELETE FROM playback_input_binding
      WHERE household_id = ? AND playback_source_id IN (${lineIdsSql})`,
  ).run(householdId, ...params);
}

/** 单来源永久清理(内部;调用方负责事务与归属)。 */
function purgeSourceRows(db: typeof Database.db, householdId: string, sourceId: string): number {
  const snapshotBytes =
    (db
      .prepare('SELECT COALESCE(SUM(byte_size), 0) AS bytes FROM source_import_snapshot WHERE household_id = ? AND source_id = ?')
      .get(householdId, sourceId) as { bytes: number } | undefined)?.bytes ?? 0;
  db.prepare('DELETE FROM source_import_snapshot WHERE household_id = ? AND source_id = ?').run(householdId, sourceId);
  // VOD 标题以 media_source(source_id) 外键引用来源:永久清理当前不级联删除媒体库,
  // 明确拒绝而不是落到 500,避免留下孤儿媒资。
  if (count(db, 'SELECT COUNT(*) AS n FROM vod_title WHERE household_id = ? AND source_id = ?', householdId, sourceId) > 0) {
    throw new DomainError(409, ProblemCode.SOURCE_BUSY, '该来源仍关联点播标题,暂不支持永久清理。');
  }
  // 解除 media_source.last_job_id / source_entry.last_seen_job_id 对 refresh 行的复合外键,
  // 解除播放会话/输入绑定对线路的引用,再按「播放资源 → 来源条目 → 暂存 → 刷新任务」顺序删除。
  db.prepare('UPDATE media_source SET last_job_id = NULL WHERE household_id = ? AND id = ?').run(householdId, sourceId);
  db.prepare('UPDATE source_entry SET last_seen_job_id = NULL WHERE household_id = ? AND source_id = ?').run(householdId, sourceId);
  detachPlaybackReferences(
    db,
    householdId,
    'SELECT id FROM playback_source WHERE household_id = ? AND source_id = ?',
    [householdId, sourceId],
  );
  // playback_input_binding 同时以 source_id 引用 media_source(可能尚未绑定线路)。
  db.prepare('DELETE FROM playback_input_binding WHERE household_id = ? AND source_id = ?').run(householdId, sourceId);
  // EPG 源可能被频道来源以 media_source.epg_source_id 引用:解绑保留频道,再删源。
  db.prepare('UPDATE media_source SET epg_source_id = NULL WHERE household_id = ? AND epg_source_id = ?').run(householdId, sourceId);
  db.prepare('DELETE FROM playback_source WHERE household_id = ? AND source_id = ?').run(householdId, sourceId);
  db.prepare('DELETE FROM source_entry WHERE household_id = ? AND source_id = ?').run(householdId, sourceId);
  db.prepare(
    `DELETE FROM refresh_stage_entry
      WHERE household_id = ? AND refresh_id IN (SELECT id FROM source_refresh WHERE household_id = ? AND source_id = ?)`,
  ).run(householdId, householdId, sourceId);
  db.prepare('DELETE FROM source_refresh WHERE household_id = ? AND source_id = ?').run(householdId, sourceId);
  db.prepare('DELETE FROM manual_epg_binding WHERE household_id = ? AND epg_source_id = ?').run(householdId, sourceId);
  db.prepare('DELETE FROM epg_programme WHERE household_id = ? AND source_id = ?').run(householdId, sourceId);
  db.prepare('DELETE FROM epg_channel WHERE household_id = ? AND source_id = ?').run(householdId, sourceId);
  db.prepare('DELETE FROM channel_logo WHERE household_id = ? AND source_id = ?').run(householdId, sourceId);
  db.prepare('DELETE FROM vod_source_config WHERE household_id = ? AND source_id = ?').run(householdId, sourceId);
  db.prepare('DELETE FROM source_archive WHERE household_id = ? AND source_id = ?').run(householdId, sourceId);
  db.prepare('DELETE FROM media_source WHERE household_id = ? AND id = ?').run(householdId, sourceId);
  return snapshotBytes;
}

function bumpCatalogRevision(db: typeof Database.db, householdId: string): void {
  db.prepare(
    `INSERT INTO catalog_state (household_id, revision) VALUES (?, 2)
     ON CONFLICT(household_id) DO UPDATE SET revision = revision + 1`,
  ).run(householdId);
}

/** 永久清理一条已归档来源(带 CAS);不存在/未归档/跨家庭返回 null 供控制器 404。 */
export function purgeArchivedSource(
  householdId: string,
  sourceId: string,
  expectedVersion: number,
): { deleted: number; bytesFreed: number } | null {
  const db = Database.db;
  return db.transaction(() => {
    const row = db
      .prepare(
        `SELECT ms.version, sa.archived_at AS archivedAt
           FROM media_source ms
           JOIN source_archive sa ON sa.household_id = ms.household_id AND sa.source_id = ms.id
          WHERE ms.household_id = ? AND ms.id = ?`,
      )
      .get(householdId, sourceId) as { version: number; archivedAt: string } | undefined;
    if (row === undefined) {
      return null;
    }
    if (row.version !== expectedVersion) {
      throw Object.assign(new Error('SOURCE_VERSION_CONFLICT'), { code: 'SOURCE_VERSION_CONFLICT' });
    }
    const bytesFreed = purgeSourceRows(db, householdId, sourceId);
    bumpCatalogRevision(db, householdId);
    return { deleted: 1, bytesFreed };
  })();
}

/** 按 target 执行清理;dryRun 只统计不写库。 */
export function runCleanup(
  householdId: string,
  actorAccountId: string,
  target: CleanupTarget,
  retentionDays: number,
  dryRun: boolean,
): CleanupResult {
  const db = Database.db;
  const cutoff = cutoffIso(retentionDays);
  const result = db.transaction((): Omit<CleanupResult, 'target' | 'dryRun'> => {
    switch (target) {
      case 'expired-programmes': {
        const n = count(db, 'SELECT COUNT(*) AS n FROM epg_programme WHERE household_id = ? AND ends_at < ?', householdId, cutoff);
        if (!dryRun) {
          db.prepare('DELETE FROM epg_programme WHERE household_id = ? AND ends_at < ?').run(householdId, cutoff);
        }
        return { deleted: n, bytesFreed: 0, detail: { programmes: n } };
      }
      case 'stale-entries': {
        const entries = count(
          db,
          `SELECT COUNT(*) AS n FROM source_entry
            WHERE household_id = ? AND present = 0 AND missing_since IS NOT NULL AND missing_since < ?`,
          householdId,
          cutoff,
        );
        const lines = count(
          db,
          `SELECT COUNT(*) AS n FROM playback_source
            WHERE household_id = ? AND source_entry_id IN (
              SELECT id FROM source_entry
               WHERE household_id = ? AND present = 0 AND missing_since IS NOT NULL AND missing_since < ?
            )`,
          householdId,
          householdId,
          cutoff,
        );
        if (!dryRun) {
          const staleLineIds = `SELECT id FROM playback_source
              WHERE household_id = ? AND source_entry_id IN (
                SELECT id FROM source_entry
                 WHERE household_id = ? AND present = 0 AND missing_since IS NOT NULL AND missing_since < ?
              )`;
          detachPlaybackReferences(db, householdId, staleLineIds, [householdId, householdId, cutoff]);
          db.prepare(
            `DELETE FROM playback_source
              WHERE household_id = ? AND source_entry_id IN (
                SELECT id FROM source_entry
                 WHERE household_id = ? AND present = 0 AND missing_since IS NOT NULL AND missing_since < ?
              )`,
          ).run(householdId, householdId, cutoff);
          db.prepare(
            `DELETE FROM source_entry
              WHERE household_id = ? AND present = 0 AND missing_since IS NOT NULL AND missing_since < ?`,
          ).run(householdId, cutoff);
        }
        return { deleted: entries + lines, bytesFreed: 0, detail: { entries, lines } };
      }
      case 'snapshots': {
        const rows = db
          .prepare(
            `SELECT COUNT(*) AS n, COALESCE(SUM(byte_size), 0) AS bytes
               FROM source_import_snapshot s
              WHERE s.household_id = ? AND s.captured_at < ?
                AND s.id NOT IN (
                  SELECT latest.id FROM source_import_snapshot latest
                   WHERE latest.household_id = s.household_id AND latest.source_id = s.source_id
                   ORDER BY latest.captured_at DESC, latest.id DESC LIMIT 1
                )`,
          )
          .get(householdId, cutoff) as BytesRow;
        if (!dryRun) {
          db.prepare(
            `DELETE FROM source_import_snapshot
              WHERE household_id = ? AND captured_at < ?
                AND id NOT IN (
                  SELECT latest.id FROM source_import_snapshot latest
                   WHERE latest.household_id = source_import_snapshot.household_id
                     AND latest.source_id = source_import_snapshot.source_id
                   ORDER BY latest.captured_at DESC, latest.id DESC LIMIT 1
                )`,
          ).run(householdId, cutoff);
        }
        return { deleted: rows.n, bytesFreed: rows.bytes, detail: { snapshots: rows.n } };
      }
      case 'refresh-jobs': {
        const n = count(
          db,
          `SELECT COUNT(*) AS n FROM source_refresh
            WHERE household_id = ? AND created_at < ?
              AND status IN ('succeeded','failed','interrupted','discarded','expired','stale')`,
          householdId,
          cutoff,
        );
        if (!dryRun) {
          const terminal =
            "SELECT id FROM source_refresh WHERE household_id = ? AND created_at < ? AND status IN ('succeeded','failed','interrupted','discarded','expired','stale')";
          db.prepare(
            `UPDATE media_source SET last_job_id = NULL
              WHERE household_id = ? AND last_job_id IN (${terminal})`,
          ).run(householdId, householdId, cutoff);
          db.prepare(
            `UPDATE source_entry SET last_seen_job_id = NULL
              WHERE household_id = ? AND last_seen_job_id IN (${terminal})`,
          ).run(householdId, householdId, cutoff);
          db.prepare(
            `DELETE FROM refresh_stage_entry WHERE household_id = ? AND refresh_id IN (${terminal})`,
          ).run(householdId, householdId, cutoff);
          db.prepare(
            `DELETE FROM source_refresh WHERE household_id = ? AND created_at < ?
              AND status IN ('succeeded','failed','interrupted','discarded','expired','stale')`,
          ).run(householdId, cutoff);
        }
        return { deleted: n, bytesFreed: 0, detail: { jobs: n } };
      }
      case 'archived-sources': {
        const rows = db
          .prepare('SELECT source_id AS id FROM source_archive WHERE household_id = ? AND archived_at < ?')
          .all(householdId, cutoff) as Array<{ id: string }>;
        let bytesFreed = 0;
        if (!dryRun) {
          for (const row of rows) {
            bytesFreed += purgeSourceRows(db, householdId, row.id);
          }
          if (rows.length > 0) {
            bumpCatalogRevision(db, householdId);
          }
        } else {
          for (const row of rows) {
            bytesFreed +=
              (db
                .prepare(
                  'SELECT COALESCE(SUM(byte_size), 0) AS bytes FROM source_import_snapshot WHERE household_id = ? AND source_id = ?',
                )
                .get(householdId, row.id) as { bytes: number } | undefined)?.bytes ?? 0;
          }
        }
        return { deleted: rows.length, bytesFreed, detail: { sources: rows.length } };
      }
      default: {
        const exhaustive: never = target;
        throw new Error(`unknown cleanup target: ${String(exhaustive)}`);
      }
    }
  })();

  if (!dryRun) {
    db.prepare(
      `INSERT INTO governance_cleanup_run
        (id, household_id, actor_account_id, target, dry_run, deleted_count, bytes_freed, detail_json, created_at)
       VALUES (?, ?, ?, ?, 0, ?, ?, ?, ?)`,
    ).run(
      randomUUID(),
      householdId,
      actorAccountId,
      target,
      result.deleted,
      result.bytesFreed,
      JSON.stringify(result.detail),
      new Date().toISOString(),
    );
  }

  return { target, dryRun, ...result };
}
