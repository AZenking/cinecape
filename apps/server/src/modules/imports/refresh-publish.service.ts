import { randomUUID } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import type DatabaseConstructor from 'better-sqlite3';
import { canonicalJson, type DiffCounts } from './catalog-diff';
import {
  clearStagedEntries,
  computeSnapshotDigest as stagedSnapshotDigest,
  loadStagedEntries,
  type LoadedStagedEntry,
} from './refresh-staging.service';
import { parseStoredList } from '../policy/policy.rules';
import type { XMLTVChannel, XMLTVProgramme } from './xmltv.parser';
import { Database } from '../../database/database';

/**
 * 刷新发布事务(T026/T027;data-model「发布事务」/research R5,FR-022/SC-009):
 * - 单个同步 better-sqlite3 事务内完成:重验(来源启用、source.version、catalog revision、
 *   job version、快照摘要与暂存一致)→ 稳定 upsert(media_item/source_entry/playback_source,
 *   IPTV 与 NAS 同规则)→ mark missing(只改 present,不动 media_item 与名单引用)→
 *   NAS 同路径替换清理(T027)→ 来源成功信息 + job succeeded + catalog revision+1,同事务提交;
 * - 任一重验失败 → status='stale'(version+1)并清理暂存,不发布,绝不部分写入;
 * - IPTV/NAS 暂存数据经 refresh_stage_entry 回读,网络/文件 IO 绝不出现在本事务;
 *   EPG 无暂存(T043 前不由暂存层承载),发布数据由执行器解析后传入,事务内窗口原子替换:
 *   完全相同节目按唯一键去重、冲突标记照解析器结论、不创建 MediaItem、不改任何分级;
 * - 人工配置保护:media_item 仅在未人工覆盖(title_overridden/type_overridden)时更新
 *   标题/类型;既有 content_level 一律不由普通刷新改写,仅 NAS 替换清理显式置 null;
 * - NAS 替换清理(T027):staged 条目与既有 entry 的 file_size_text/file_mtime_ns 任一不同 →
 *   同事务内该媒体 content_level=null,并从当前 Household 全部 Profile 的 allowedMediaIds
 *   移除该媒体 id(blockedMediaIds 保留),每个发生名单变化的档案 version 只 +1(单次发布内
 *   无论影响多少媒体);策略名单读取经 policy.rules 的 parseStoredList 严格校验,
 *   损坏即抛 PolicyCorruptionError 使整个发布事务回滚,绝不带着旧允许项继续;
 *   同 size 同 mtime 未变 → 不触碰该媒体的任何配置。
 */

/** 策略损坏信号:发布事务内抛出即整体回滚,由执行器映射为 POLICY_UNAVAILABLE */
export class PolicyCorruptionError extends Error {
  constructor(field: string) {
    super(`策略损坏(${field}),发布事务已中止`);
    this.name = 'PolicyCorruptionError';
  }
}

export function isPolicyCorruptionError(error: unknown): error is PolicyCorruptionError {
  return error instanceof PolicyCorruptionError;
}

/** 条目发布参数(kind=iptv|nas;暂存数据由本服务自 refresh_stage_entry 回读) */
export interface EntryPublishParams {
  householdId: string;
  sourceId: string;
  refreshId: string;
  kind: 'iptv' | 'nas';
  /** 发布时期望的任务 version(并发修改防护) */
  jobVersion: number;
  /** 发布时期望的来源 version */
  sourceVersion: number;
  /** 发布时期望的家庭目录 revision */
  baselineRevision: number;
  /** 期望的暂存快照摘要(SHA-256 hex) */
  snapshotDigest: string;
  /** 差异计数(执行器 diffSnapshot 结果,落 summary_json) */
  counts: DiffCounts;
  nowMs: number;
}

/** EPG 窗口发布参数(解析结果由执行器传入;无暂存层) */
export interface EpgPublishParams {
  householdId: string;
  sourceId: string;
  refreshId: string;
  jobVersion: number;
  sourceVersion: number;
  baselineRevision: number;
  snapshotDigest: string;
  channels: readonly XMLTVChannel[];
  programmes: readonly XMLTVProgramme[];
  conflictedChannelIds: readonly string[];
  nowMs: number;
}

export type PublishOutcome = 'succeeded' | 'stale';

/** 事务句柄(better-sqlite3 同步事务回调入参,与 sources.service 同惯用法) */
type Tx = Parameters<Parameters<DatabaseConstructor.Database['transaction']>[0]>[0];

interface MediaSourceRow {
  id: string;
  household_id: string;
  kind: string;
  root_key: string | null;
  enabled: number;
  version: number;
}

interface SourceEntryRow {
  id: string;
  identity_kind: string;
  identity_digest: string;
  media_id: string | null;
  present: number;
  file_size_text: string | null;
  file_mtime_ns: string | null;
}

/** 发布用暂存条目投影(payload 回读) */
interface StagedEntry {
  entryKey: string;
  identityKind: string;
  identityDigest: string;
  title: string | null;
  url: string | null;
  tvgId: string | null;
  relativePath: string | null;
  sizeText: string | null;
  mtimeNsText: string | null;
}

function iso(ms: number): string {
  return new Date(ms).toISOString();
}

/** entry_key = identity_kind + ':' + identity_digest(与 catalog-diff 拼接规则一致) */
function entryKeyOf(kind: string, digest: string): string {
  return `${kind}:${digest}`;
}

/** NAS 媒体标题:文件名去扩展名(点开头文件不剥) */
function nasTitleOf(relativePath: string): string {
  const base = relativePath.split('/').pop() ?? relativePath;
  const dot = base.lastIndexOf('.');
  return dot > 0 ? base.slice(0, dot) : base;
}

/** 条目标题:IPTV 取解析标题;NAS 取去扩展名文件名 */
function entryTitleOf(kind: 'iptv' | 'nas', entry: StagedEntry): string {
  if (kind === 'nas') {
    return nasTitleOf(entry.relativePath ?? '');
  }
  return entry.title ?? '';
}

/** 条目媒体类型:IPTV 恒为 channel;NAS 恒为 video */
function entryMediaType(kind: 'iptv' | 'nas'): 'channel' | 'video' {
  return kind === 'nas' ? 'video' : 'channel';
}

/** 资源协议推断:IPTV URL 以 .m3u8 结尾 → hls 否则 http;NAS 为 file,location=rootKey+相对路径 */
function playbackOf(kind: 'iptv' | 'nas', entry: StagedEntry, source: Pick<MediaSourceRow, 'root_key'>): {
  protocol: 'hls' | 'http' | 'file';
  location: string;
} {
  if (kind === 'nas') {
    return { protocol: 'file', location: `${source.root_key}/${entry.relativePath ?? ''}` };
  }
  const url = entry.url ?? '';
  return { protocol: url.toLowerCase().endsWith('.m3u8') ? 'hls' : 'http', location: url };
}

function stagedEntryOf(row: LoadedStagedEntry): StagedEntry {
  const payload = row.payload as Record<string, unknown>;
  const text = (key: string): string | null => {
    const value = payload[key];
    return typeof value === 'string' ? value : null;
  };
  const kind = text('identityKind');
  const digest = text('identityDigest');
  if (kind === null || digest === null || row.entryKey !== entryKeyOf(kind, digest)) {
    throw new Error(`暂存条目身份字段缺失或不一致(${row.entryKey})`);
  }
  return {
    entryKey: row.entryKey,
    identityKind: kind,
    identityDigest: digest,
    title: text('title'),
    url: text('url'),
    tvgId: text('tvgId'),
    relativePath: text('relativePath'),
    sizeText: text('sizeText'),
    mtimeNsText: text('mtimeNsText'),
  };
}

/**
 * T027 NAS 替换清理(发布事务内):媒体分级置空 + 全档案 allowedMediaIds 移除。
 * 策略缺失不补建(FR-003/FR-008);名单解析损坏抛 PolicyCorruptionError 整体回滚。
 */
function applyNasReplacementCleanup(
  tx: Tx,
  householdId: string,
  replacedMediaIds: ReadonlySet<string>,
  nowIso: string,
): void {
  const nullLevel = tx.prepare(
    'UPDATE media_item SET content_level = NULL, version = version + 1, updated_at = ? WHERE id = ? AND household_id = ?',
  );
  for (const mediaId of replacedMediaIds) {
    nullLevel.run(nowIso, mediaId, householdId);
  }
  const profiles = tx.prepare('SELECT id FROM profile WHERE household_id = ? ORDER BY id').all(householdId) as Array<{
    id: string;
  }>;
  const readPolicy = tx.prepare('SELECT * FROM profile_policy WHERE household_id = ? AND profile_id = ?');
  const writePolicy = tx.prepare(
    'UPDATE profile_policy SET allowed_media_ids = ?, version = version + 1, updated_at = ? WHERE household_id = ? AND profile_id = ?',
  );
  for (const profile of profiles) {
    const policy = readPolicy.get(householdId, profile.id) as
      | { allowed_media_ids: string; blocked_media_ids: string }
      | undefined;
    if (policy === undefined) {
      continue; // 不自动补建缺失策略;该档案本就没有允许项可清理
    }
    let allowed: string[];
    let blocked: string[];
    try {
      // allowed 与 blocked 都严格解析:任一名单损坏即整体失败,不带着旧允许项继续
      allowed = parseStoredList(policy.allowed_media_ids, 'allowedMediaIds');
      blocked = parseStoredList(policy.blocked_media_ids, 'blockedMediaIds');
    } catch {
      throw new PolicyCorruptionError(`profile ${profile.id} 的 allowedMediaIds/blockedMediaIds`);
    }
    void blocked; // blocked 仅用于严格解析(任一名单损坏即整体失败),本事务不写入禁止项
    const filtered = allowed.filter((mediaId) => !replacedMediaIds.has(mediaId));
    if (filtered.length === allowed.length) {
      continue; // 该档案名单未变化:version 不加
    }
    writePolicy.run(JSON.stringify(filtered), nowIso, householdId, profile.id);
  }
}

@Injectable()
export class RefreshPublishService {
  /**
   * 条目快照发布(IPTV/NAS):单事务重验 + upsert + mark missing + NAS 替换清理 + 收尾。
   * 返回 'stale' 时任务已在事务内被标记 stale(终态),调用方无须再改状态。
   */
  publishEntrySnapshot(params: EntryPublishParams): PublishOutcome {
    const db = Database.db;
    const nowIso = iso(params.nowMs);
    const run = db.transaction((): PublishOutcome => {
      const stale = this.markStaleAndClear(db, params, nowIso);
      if (!this.revalidate(db, params, stale)) {
        return 'stale';
      }
      const stagedRows = loadStagedEntries(db, { householdId: params.householdId, refreshId: params.refreshId });
      if (stagedSnapshotDigest(stagedRows) !== params.snapshotDigest) {
        stale();
        return 'stale';
      }
      const staged = stagedRows.map(stagedEntryOf).sort((left, right) => (left.entryKey < right.entryKey ? -1 : 1));

      const baselineRows = db
        .prepare(
          'SELECT id, identity_kind, identity_digest, media_id, present, file_size_text, file_mtime_ns FROM source_entry WHERE household_id = ? AND source_id = ?',
        )
        .all(params.householdId, params.sourceId) as SourceEntryRow[];
      const existingByKey = new Map<string, SourceEntryRow>(
        baselineRows.map((row) => [entryKeyOf(row.identity_kind, row.identity_digest), row] as const),
      );
      const stagedKeys = new Set(staged.map((entry) => entry.entryKey));

      // mark missing:baseline present 而 staged 缺席 → present=0 + missing_since(不删行、不动媒体)
      const markMissing = db.prepare(
        'UPDATE source_entry SET present = 0, missing_since = ? WHERE id = ? AND household_id = ? AND present = 1',
      );
      for (const row of baselineRows) {
        if (row.present === 1 && !stagedKeys.has(entryKeyOf(row.identity_kind, row.identity_digest))) {
          markMissing.run(nowIso, row.id, params.householdId);
        }
      }

      const source = db.prepare('SELECT * FROM media_source WHERE id = ? AND household_id = ?').get(
        params.sourceId,
        params.householdId,
      ) as MediaSourceRow;
      const replacedMediaIds = new Set<string>();
      const insertMedia = db.prepare(
        "INSERT INTO media_item (id, household_id, type, title, description, poster_ref, content_level, title_overridden, type_overridden, version, created_at, updated_at) VALUES (?, ?, ?, ?, NULL, NULL, NULL, 0, 0, 1, ?, ?)",
      );
      const readMedia = db.prepare(
        'SELECT title, type, title_overridden, type_overridden FROM media_item WHERE id = ? AND household_id = ?',
      );
      const updateMediaPresentation = db.prepare(
        'UPDATE media_item SET title = ?, type = ?, version = version + 1, updated_at = ? WHERE id = ? AND household_id = ?',
      );
      const insertEntry = db.prepare(
        "INSERT INTO source_entry (id, household_id, source_id, identity_kind, identity_digest, media_id, upstream_channel_id, present, last_seen_job_id, first_seen_at, last_seen_at, missing_since, file_size_text, file_mtime_ns) VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, NULL, ?, ?)",
      );
      const updateEntry = db.prepare(
        'UPDATE source_entry SET media_id = ?, upstream_channel_id = ?, present = 1, last_seen_job_id = ?, last_seen_at = ?, missing_since = NULL, file_size_text = ?, file_mtime_ns = ? WHERE id = ? AND household_id = ?',
      );
      const insertPlayback = db.prepare(
        "INSERT INTO playback_source (id, household_id, source_id, source_entry_id, media_item_id, protocol, location, mime_type, priority, requires_proxy, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, NULL, 100, 0, ?, ?)",
      );
      const updatePlayback = db.prepare(
        'UPDATE playback_source SET media_item_id = ?, protocol = ?, location = ?, updated_at = ? WHERE id = ? AND household_id = ?',
      );
      const readPlayback = db.prepare('SELECT id FROM playback_source WHERE household_id = ? AND source_entry_id = ?');

      for (const entry of staged) {
        const existing = existingByKey.get(entry.entryKey);
        let mediaId = existing?.media_id ?? null;
        if (mediaId === null) {
          mediaId = randomUUID();
          insertMedia.run(mediaId, params.householdId, entryMediaType(params.kind), entryTitleOf(params.kind, entry), nowIso, nowIso);
        } else {
          // 人工标题/类型不被刷新覆盖;既有 content_level 一律不改写
          const media = readMedia.get(mediaId, params.householdId) as
            | { title: string; type: string; title_overridden: number; type_overridden: number }
            | undefined;
          if (media !== undefined) {
            const nextTitle = media.title_overridden === 1 ? media.title : entryTitleOf(params.kind, entry);
            const nextType = media.type_overridden === 1 ? media.type : entryMediaType(params.kind);
            if (nextTitle !== media.title || nextType !== media.type) {
              updateMediaPresentation.run(nextTitle, nextType, nowIso, mediaId, params.householdId);
            }
          }
        }

        const entryId = existing?.id ?? randomUUID();
        const upstreamChannelId = params.kind === 'iptv' ? entry.tvgId : null;
        const sizeText = params.kind === 'nas' ? entry.sizeText : null;
        const mtimeNsText = params.kind === 'nas' ? entry.mtimeNsText : null;
        if (existing === undefined) {
          insertEntry.run(
            entryId,
            params.householdId,
            params.sourceId,
            entry.identityKind,
            entry.identityDigest,
            mediaId,
            upstreamChannelId,
            params.refreshId,
            nowIso,
            nowIso,
            sizeText,
            mtimeNsText,
          );
        } else {
          // T027:先以更新前事实判定替换,再写入新事实
          if (
            params.kind === 'nas' &&
            (existing.file_size_text !== sizeText || existing.file_mtime_ns !== mtimeNsText)
          ) {
            replacedMediaIds.add(mediaId);
          }
          updateEntry.run(
            mediaId,
            upstreamChannelId,
            params.refreshId,
            nowIso,
            sizeText,
            mtimeNsText,
            entryId,
            params.householdId,
          );
        }

        const playback = readPlayback.get(params.householdId, entryId) as { id: string } | undefined;
        const resource = playbackOf(params.kind, entry, source);
        if (playback === undefined) {
          insertPlayback.run(
            randomUUID(),
            params.householdId,
            params.sourceId,
            entryId,
            mediaId,
            resource.protocol,
            resource.location,
            nowIso,
            nowIso,
          );
        } else {
          updatePlayback.run(mediaId, resource.protocol, resource.location, nowIso, playback.id, params.householdId);
        }
      }

      if (params.kind === 'nas' && replacedMediaIds.size > 0) {
        applyNasReplacementCleanup(db, params.householdId, replacedMediaIds, nowIso);
      }

      this.finalizeSuccess(db, params, nowIso, canonicalJson({ counts: params.counts }));
      return 'succeeded';
    });
    return run();
  }

  /**
   * EPG 窗口原子发布:同事务删除本来源旧窗口并写入新频道/节目;
   * 完全相同节目按唯一键去重,冲突标记照解析器结论;不创建 MediaItem、不改分级;
   * 成功路径同事务 media_source.epg_generation+1(US5/ADR-0008;失败/回滚/stale 不加),
   * 且绝不触碰 manual_epg_binding(手动配置跨刷新保留)。
   */
  publishEpgWindow(params: EpgPublishParams): PublishOutcome {
    const db = Database.db;
    const nowIso = iso(params.nowMs);
    const run = db.transaction((): PublishOutcome => {
      const stale = this.markStaleAndClear(db, params, nowIso);
      if (!this.revalidate(db, params, stale)) {
        return 'stale';
      }
      db.prepare('DELETE FROM epg_programme WHERE household_id = ? AND source_id = ?').run(params.householdId, params.sourceId);
      db.prepare('DELETE FROM epg_channel WHERE household_id = ? AND source_id = ?').run(params.householdId, params.sourceId);

      const conflicted = new Set(params.conflictedChannelIds);
      const insertChannel = db.prepare(
        'INSERT INTO epg_channel (household_id, source_id, xmltv_channel_id, display_name, conflicted) VALUES (?, ?, ?, ?, ?)',
      );
      for (const channel of params.channels) {
        insertChannel.run(params.householdId, params.sourceId, channel.xmltvChannelId, channel.displayName ?? channel.xmltvChannelId, conflicted.has(channel.xmltvChannelId) ? 1 : 0);
      }

      const insertProgramme = db.prepare(
        'INSERT OR IGNORE INTO epg_programme (id, household_id, source_id, xmltv_channel_id, title, description, starts_at, ends_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      );
      const seenSlots = new Set<string>();
      let storedProgrammes = 0;
      for (const programme of params.programmes) {
        const startsAt = programme.startsAtUtc.toISOString();
        const endsAt = programme.endsAtUtc.toISOString();
        const slot = `${programme.xmltvChannelId}\u0000${startsAt}\u0000${endsAt}`;
        if (seenSlots.has(slot)) {
          continue; // 完全相同节目去重
        }
        seenSlots.add(slot);
        const result = insertProgramme.run(
          randomUUID(),
          params.householdId,
          params.sourceId,
          programme.xmltvChannelId,
          programme.title,
          programme.description,
          startsAt,
          endsAt,
        );
        storedProgrammes += Number(result.changes);
      }

      this.finalizeSuccess(
        db,
        params,
        nowIso,
        canonicalJson({ counts: { channels: params.channels.length, programmes: storedProgrammes } }),
      );
      // US5/ADR-0008(T070):EPG 成功发布的同事务内 epg_generation+1 —— 与窗口替换/收尾原子;
      // 仅 kind=epg 的该来源行;失败/回滚/stale 均不会执行到此(事务早退或整体回滚)。
      // EPG 刷新绝不写/删 manual_epg_binding(手动配置跨刷新/重启保留)。
      // 缺列容忍(照 hasSourceRefreshTable 的未就绪库降级惯例):仅应用 0001~0003 的
      // 部分迁移库(就绪检查应 503)没有 epg_generation 列,bump 静默跳过不使发布崩溃;
      // 已就绪库(含 0004)恒有该列,bump 恒执行。
      const hasGenerationColumn = (
        db.prepare("SELECT COUNT(*) AS n FROM pragma_table_info('media_source') WHERE name = 'epg_generation'").get() as { n: number }
      ).n === 1;
      if (hasGenerationColumn) {
        db.prepare(
          "UPDATE media_source SET epg_generation = epg_generation + 1 WHERE id = ? AND household_id = ? AND kind = 'epg'",
        ).run(params.sourceId, params.householdId);
      }
      return 'succeeded';
    });
    return run();
  }

  /** 发布重验:来源存在且启用、source.version、catalog revision、job version、摘要落库一致 */
  private revalidate(
    db: DatabaseConstructor.Database,
    params: {
      householdId: string;
      sourceId: string;
      refreshId: string;
      jobVersion: number;
      sourceVersion: number;
      baselineRevision: number;
      snapshotDigest: string;
    },
    stale: () => void,
  ): boolean {
    const source = db
      .prepare('SELECT enabled, version FROM media_source WHERE id = ? AND household_id = ?')
      .get(params.sourceId, params.householdId) as { enabled: number; version: number } | undefined;
    if (source === undefined || source.enabled !== 1 || source.version !== params.sourceVersion) {
      stale();
      return false;
    }
    const catalog = db
      .prepare('SELECT revision FROM catalog_state WHERE household_id = ?')
      .get(params.householdId) as { revision: number } | undefined;
    if (catalog === undefined || catalog.revision !== params.baselineRevision) {
      stale();
      return false;
    }
    const job = db
      .prepare('SELECT version, snapshot_digest FROM source_refresh WHERE id = ? AND household_id = ?')
      .get(params.refreshId, params.householdId) as { version: number; snapshot_digest: string | null } | undefined;
    if (job === undefined || job.version !== params.jobVersion || job.snapshot_digest !== params.snapshotDigest) {
      stale();
      return false;
    }
    return true;
  }

  /** stale 标记(发布事务内,原子):status='stale'、version+1、finished_at、清理暂存 */
  private markStaleAndClear(
    db: DatabaseConstructor.Database,
    params: { householdId: string; refreshId: string },
    nowIso: string,
  ): () => void {
    return (): void => {
      db.prepare(
        "UPDATE source_refresh SET status = 'stale', version = version + 1, finished_at = ? WHERE id = ? AND household_id = ?",
      ).run(nowIso, params.refreshId, params.householdId);
      clearStagedEntries(db, { householdId: params.householdId, refreshId: params.refreshId });
    };
  }

  /** 收尾(同一事务):来源成功信息、job succeeded、catalog revision+1、清理已发布快照的暂存 */
  private finalizeSuccess(
    db: DatabaseConstructor.Database,
    params: { householdId: string; sourceId: string; refreshId: string },
    nowIso: string,
    summaryJson: string,
  ): void {
    db.prepare(
      'UPDATE media_source SET last_success_at = ?, last_job_id = ?, updated_at = ? WHERE id = ? AND household_id = ?',
    ).run(nowIso, params.refreshId, nowIso, params.sourceId, params.householdId);
    db.prepare(
      "UPDATE source_refresh SET status = 'succeeded', version = version + 1, finished_at = ?, summary_json = ?, error_code = NULL WHERE id = ? AND household_id = ?",
    ).run(nowIso, summaryJson, params.refreshId, params.householdId);
    db.prepare('UPDATE catalog_state SET revision = revision + 1 WHERE household_id = ?').run(params.householdId);
    // 快照已发布:暂存数据完成使命,同事务清理(与成功终态原子)
    clearStagedEntries(db, { householdId: params.householdId, refreshId: params.refreshId });
  }
}
