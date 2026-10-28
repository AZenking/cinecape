import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ProblemCode } from '@hmp/shared';
import { DomainError, createDomainError } from '@platform/http-common/domain-error';
import { getConfig } from '@platform/config/env';
import { IMPORT_BUDGETS } from '@platform/config/import-budgets';
import { Database } from '@platform/database/database';
import {
  CatalogDiffFailure,
  canonicalJson,
  computeSnapshotDigest as canonicalSnapshotDigest,
  diffSnapshot,
  evaluateExceptions,
  type DiffCounts,
  type RefreshExceptionReason,
} from '@contexts/sources/infrastructure/catalog-diff';
import {
  clearStagedEntries,
  computeSnapshotDigest as stagedSnapshotDigest,
  loadStagedEntries,
  stageEntries,
} from '@contexts/sources/infrastructure/refresh-staging.service';
import { M3UParseFailure, parseM3U } from '@contexts/sources/infrastructure/m3u.parser';
import { NasScanFailure, scanNasRoot } from '@contexts/sources/infrastructure/nas-scanner';
import { XMLTVParseFailure, parseXMLTV, type XMLTVParseResult } from '@contexts/sources/infrastructure/xmltv.parser';
import { RemoteReadFailure, openRemoteSource } from '@contexts/sources/infrastructure/safe-http-reader';
import { RefreshPublishService, isPolicyCorruptionError } from '@contexts/sources/application/refresh-publish.service';

/**
 * 刷新执行器服务(T026;research R5/data-model「状态流转」「发布事务」,contracts/api.md 刷新与待确认):
 * - requestRefresh:来源归属(404 同形)→ 禁用 422 → operationKey 幂等(同语义返回原任务,
 *   异语义 409 IDEMPOTENCY_CONFLICT)→ expectedVersion 与来源版本 409 → 同来源活动任务
 *   409 SOURCE_BUSY → 全局 queued 满 429 IMPORT_QUEUE_FULL → 事务内创建 queued 任务
 *   (version=1、source_version/baseline_revision 快照、initiator 只存 ID,不存密码);
 * - 串行执行器:同一时刻至多 1 个 running。runQueuedOnce() 取最早 queued → running
 *   (事务+version+1+started_at),按 kind 分派:iptv=openRemoteSource→parseM3U→暂存;
 *   nas=scanNasRoot→暂存;epg=解析后窗口发布。网络/文件 IO 绝不出现在写事务内;
 *   暂存后 diff(baseline=present 条目投影):异常 → awaiting_confirmation(数量化 summary,
 *   expires_at=now+24h);否则重验发起会话/设备仍有效后进入发布事务;
 * - 任务失败(errorCode=稳定 code)只改任务行并清理暂存,绝不触碰已发布目录;
 * - 恢复:recoverInterrupted() 将 queued/running → interrupted(不自动重跑);
 *   expireStaleConfirmations() 懒过期 awaiting_confirmation → expired;
 * - 确认/丢弃:仅 awaiting_confirmation;expectedVersion 不匹配 409;过期 409 REFRESH_STALE
 *   (顺带标 expired);确认重验来源版本/目录 revision/快照摘要,NAS 再核对磁盘 size/mtime,
 *   失败 → 409 REFRESH_STALE 并标 stale;成功走发布事务;丢弃清暂存并释放来源锁;
 * - 终态 immutable:任何状态迁移都以「当前状态 + version」为守卫,终态不再被本服务改写。
 */

/** 任务状态(与 source_refresh_status_check CHECK 一致) */
export type RefreshJobStatus =
  | 'queued'
  | 'running'
  | 'succeeded'
  | 'failed'
  | 'awaiting_confirmation'
  | 'interrupted'
  | 'discarded'
  | 'expired'
  | 'stale';

/** 数量统计(RefreshDto counts 全字段;summary_json 只存本次适用的子集,缺失按 0 补齐) */
export interface RefreshSummaryCounts {
  added: number;
  updated: number;
  missing: number;
  failed: number;
  channels: number;
  programmes: number;
}

/** 待确认原因(contracts/api.md RefreshDto.confirmationReason) */
export type RefreshConfirmationReason = RefreshExceptionReason;

/** 任务概览(供 T028 控制器映射 RefreshDto;不携带来源地址/条目内容) */
export interface RefreshJobView {
  id: string;
  householdId: string;
  sourceId: string;
  status: RefreshJobStatus;
  version: number;
  sourceVersion: number;
  baselineRevision: number;
  snapshotDigest: string | null;
  itemCount: number | null;
  /** summary_json.counts(本次适用子集;T028 用 toRefreshDtoCounts 补零) */
  counts: Partial<RefreshSummaryCounts>;
  confirmationReason: RefreshConfirmationReason | null;
  errorCode: string | null;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  expiresAt: string | null;
}

/** 发起刷新入参(家长验证由调用方完成后置 ownerPasswordVerified=true;本服务只做业务) */
export interface RequestRefreshInput {
  householdId: string;
  accountId: string;
  sessionId: string;
  sourceId: string;
  expectedVersion: number;
  operationKey: string;
  ownerPasswordVerified: boolean;
}

/** 确认/丢弃入参(sessionId 提供时发布前重验会话与设备仍有效) */
export interface RefreshDecisionInput {
  householdId: string;
  refreshId: string;
  expectedVersion: number;
  sessionId?: string;
}

interface SourceRefreshRow {
  id: string;
  household_id: string;
  source_id: string;
  initiator_account_id: string;
  initiator_session_id: string;
  operation_key: string;
  status: RefreshJobStatus;
  version: number;
  source_version: number;
  baseline_revision: number;
  snapshot_digest: string | null;
  item_count: number | null;
  summary_json: string | null;
  error_code: string | null;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
  expires_at: string | null;
}

interface MediaSourceRow {
  id: string;
  household_id: string;
  kind: 'iptv' | 'nas' | 'epg';
  remote_url: string | null;
  root_key: string | null;
  relative_directory: string | null;
  enabled: number;
  version: number;
}

/** EPG 指南窗口:刷新时刻前 24h ~ 后 7d(data-model;解析器按闭区间相交过滤) */
const EPG_WINDOW_PAST_MS = 24 * 3_600_000;
const EPG_WINDOW_FUTURE_MS = 7 * 24 * 3_600_000;
/** 生产串行循环空闲轮询间隔(有 queued 任务时连续执行,不受此间隔影响) */
export const REFRESH_WORKER_POLL_MS = 500;

function iso(ms: number): string {
  return new Date(ms).toISOString();
}

function getJobRow(householdId: string, refreshId: string): SourceRefreshRow | undefined {
  return Database.db.prepare('SELECT * FROM source_refresh WHERE id = ? AND household_id = ?').get(
    refreshId,
    householdId,
  ) as SourceRefreshRow | undefined;
}

function parseSummary(text: string | null): {
  counts: Partial<RefreshSummaryCounts>;
  confirmationReason: RefreshConfirmationReason | null;
} {
  if (text === null) {
    return { counts: {}, confirmationReason: null };
  }
  try {
    const parsed = JSON.parse(text) as { counts?: Partial<RefreshSummaryCounts>; confirmationReason?: string };
    const reason =
      parsed.confirmationReason === 'empty_snapshot' || parsed.confirmationReason === 'deletion_ratio_exceeded'
        ? parsed.confirmationReason
        : null;
    return { counts: parsed.counts ?? {}, confirmationReason: reason };
  } catch {
    return { counts: {}, confirmationReason: null };
  }
}

function toView(row: SourceRefreshRow): RefreshJobView {
  const summary = parseSummary(row.summary_json);
  return {
    id: row.id,
    householdId: row.household_id,
    sourceId: row.source_id,
    status: row.status,
    version: row.version,
    sourceVersion: row.source_version,
    baselineRevision: row.baseline_revision,
    snapshotDigest: row.snapshot_digest,
    itemCount: row.item_count,
    counts: summary.counts,
    confirmationReason: summary.confirmationReason,
    errorCode: row.error_code,
    createdAt: row.created_at,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    expiresAt: row.expires_at,
  };
}

/** summary 子集 → RefreshDto 六字段全量 counts(缺失补 0,恒非负) */
export function toRefreshDtoCounts(counts: Partial<RefreshSummaryCounts>): RefreshSummaryCounts {
  return {
    added: counts.added ?? 0,
    updated: counts.updated ?? 0,
    missing: counts.missing ?? 0,
    failed: counts.failed ?? 0,
    channels: counts.channels ?? 0,
    programmes: counts.programmes ?? 0,
  };
}

/** 执行失败稳定 code:解析器/读取器/身份失败的 code 原样透出,其余归 INTERNAL */
function errorCodeOf(error: unknown): string {
  if (
    error instanceof RemoteReadFailure ||
    error instanceof M3UParseFailure ||
    error instanceof NasScanFailure ||
    error instanceof CatalogDiffFailure ||
    error instanceof XMLTVParseFailure
  ) {
    return error.code;
  }
  if (isPolicyCorruptionError(error)) {
    return ProblemCode.POLICY_UNAVAILABLE;
  }
  return ProblemCode.INTERNAL;
}

@Injectable()
export class RefreshExecutorService implements OnModuleInit, OnModuleDestroy {
  private readonly publish: RefreshPublishService;
  /** 串行执行器守卫:同一时刻至多一个任务在处理(research R5 全局单执行器) */
  private working = false;
  private stopped = false;

  constructor(publish?: RefreshPublishService) {
    this.publish = publish ?? new RefreshPublishService();
  }

  /* ---------------------------------------------------------------- */
  /* 排队创建                                                          */
  /* ---------------------------------------------------------------- */

  /**
   * 发起刷新(请求事务内创建 queued 任务;返回原任务 = 202 语义,由 T028 包装)。
   * 校验次序:家长验证声明 → 来源 404 同形 → 禁用 422 → 幂等 → 版本 409 →
   * 同来源互斥 409 → 全局排队 429 → 创建。
   */
  requestRefresh(input: RequestRefreshInput): RefreshJobView {
    if (input.ownerPasswordVerified !== true) {
      throw new DomainError(403, ProblemCode.PARENT_VERIFICATION_REQUIRED, '需要主账号密码完成家长验证');
    }
    const db = Database.db;
    const source = db.prepare('SELECT * FROM media_source WHERE id = ?').get(input.sourceId) as MediaSourceRow | undefined;
    if (source === undefined || source.household_id !== input.householdId) {
      throw new DomainError(404, ProblemCode.NOT_FOUND);
    }
    if (source.enabled !== 1) {
      throw createDomainError('SOURCE_DISABLED');
    }

    const existing = db
      .prepare('SELECT * FROM source_refresh WHERE household_id = ? AND operation_key = ?')
      .get(input.householdId, input.operationKey) as SourceRefreshRow | undefined;
    if (existing !== undefined) {
      if (existing.source_id === input.sourceId && existing.source_version === input.expectedVersion) {
        return toView(existing);
      }
      throw createDomainError('IDEMPOTENCY_CONFLICT');
    }
    if (source.version !== input.expectedVersion) {
      throw createDomainError('SOURCE_VERSION_CONFLICT');
    }
    const session = db
      .prepare('SELECT id FROM device_session WHERE id = ? AND household_id = ?')
      .get(input.sessionId, input.householdId);
    if (session === undefined) {
      throw new DomainError(401, ProblemCode.SESSION_INVALID, '会话无效或已撤销');
    }
    const account = db
      .prepare('SELECT id FROM account WHERE id = ? AND household_id = ?')
      .get(input.accountId, input.householdId);
    if (account === undefined) {
      throw new DomainError(403, ProblemCode.FORBIDDEN);
    }
    const busy = db
      .prepare(
        "SELECT id FROM source_refresh WHERE household_id = ? AND source_id = ? AND status IN ('queued', 'running', 'awaiting_confirmation')",
      )
      .get(input.householdId, input.sourceId);
    if (busy !== undefined) {
      throw createDomainError('SOURCE_BUSY');
    }
    const queued = db.prepare("SELECT COUNT(*) AS n FROM source_refresh WHERE status = 'queued'").get() as { n: number };
    if (queued.n >= IMPORT_BUDGETS.IMPORT_QUEUE_CAPACITY) {
      throw createDomainError('IMPORT_QUEUE_FULL');
    }
    const catalog = db
      .prepare('SELECT revision FROM catalog_state WHERE household_id = ?')
      .get(input.householdId) as { revision: number } | undefined;
    if (catalog === undefined) {
      throw new DomainError(500, ProblemCode.INTERNAL, '目录状态缺失');
    }

    const id = randomUUID();
    const now = new Date().toISOString();
    try {
      db.prepare(
        "INSERT INTO source_refresh (id, household_id, source_id, initiator_account_id, initiator_session_id, operation_key, status, version, source_version, baseline_revision, snapshot_digest, item_count, summary_json, error_code, created_at, started_at, finished_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, 'queued', 1, ?, ?, NULL, NULL, NULL, NULL, ?, NULL, NULL, NULL)",
      ).run(
        id,
        input.householdId,
        input.sourceId,
        input.accountId,
        input.sessionId,
        input.operationKey,
        source.version,
        catalog.revision,
        now,
      );
    } catch (error) {
      // 并发竞态兜底:部分唯一索引/幂等键冲突映射回稳定业务码
      const message = error instanceof Error ? error.message : String(error);
      if (message.includes('one_active_refresh_per_source')) {
        throw createDomainError('SOURCE_BUSY');
      }
      if (message.includes('source_refresh_operation_key')) {
        throw createDomainError('IDEMPOTENCY_CONFLICT');
      }
      throw error;
    }
    return toView(getJobRow(input.householdId, id) as SourceRefreshRow);
  }

  /** 按 id 读取任务概览(供 T028 GET /refreshes/{refreshId};跨家庭/未知 → null 由调用方 404) */
  getRefreshJob(householdId: string, refreshId: string): RefreshJobView | null {
    const row = getJobRow(householdId, refreshId);
    return row === undefined ? null : toView(row);
  }

  /* ---------------------------------------------------------------- */
  /* 串行执行                                                          */
  /* ---------------------------------------------------------------- */

  /**
   * 取最早 queued 任务执行一次(供测试直接调用;生产由 onModuleInit 启动的串行循环调用)。
   * 无排队任务或执行器忙时返回 null。任务 outcome 落库后返回任务终态视图。
   */
  async runQueuedOnce(nowMs: number = Date.now()): Promise<RefreshJobView | null> {
    if (this.working) {
      return null;
    }
    this.working = true;
    try {
      return await this.processNextQueued(nowMs);
    } finally {
      this.working = false;
    }
  }

  private async processNextQueued(nowMs: number): Promise<RefreshJobView | null> {
    const db = Database.db;
    if (!this.hasSourceRefreshTable(db)) {
      return null;
    }
    const claim = db.transaction((): SourceRefreshRow | null => {
      const candidate = db
        .prepare("SELECT id, household_id FROM source_refresh WHERE status = 'queued' ORDER BY created_at ASC, id ASC LIMIT 1")
        .get() as { id: string; household_id: string } | undefined;
      if (candidate === undefined) {
        return null;
      }
      const claimed = db
        .prepare("UPDATE source_refresh SET status = 'running', version = version + 1, started_at = ? WHERE id = ? AND household_id = ? AND status = 'queued'")
        .run(iso(nowMs), candidate.id, candidate.household_id);
      if (Number(claimed.changes) !== 1) {
        return null;
      }
      return getJobRow(candidate.household_id, candidate.id) ?? null;
    });
    const job = claim();
    if (job === null) {
      return null;
    }
    try {
      await this.executeJob(job, nowMs);
    } catch (error) {
      this.failJob(job, nowMs, errorCodeOf(error));
    }
    const finalRow = getJobRow(job.household_id, job.id);
    return finalRow === undefined ? null : toView(finalRow);
  }

  /** 按 kind 分派:暂存(IPTV/NAS)或解析(EPG)→ 异常判定 → 发布/待确认 */
  private async executeJob(job: SourceRefreshRow, nowMs: number): Promise<void> {
    const db = Database.db;
    const source = db
      .prepare('SELECT * FROM media_source WHERE id = ? AND household_id = ?')
      .get(job.source_id, job.household_id) as MediaSourceRow | undefined;
    if (source === undefined) {
      this.failJob(job, nowMs, ProblemCode.NOT_FOUND);
      return;
    }
    if (source.enabled !== 1) {
      this.failJob(job, nowMs, 'SOURCE_DISABLED');
      return;
    }
    if (source.kind === 'epg') {
      await this.executeEpgJob(job, source, nowMs);
      return;
    }
    await this.executeEntryJob(job, source, nowMs);
  }

  /** IPTV/NAS:网络/文件 IO + 暂存(写事务外)→ diff → 待确认或发布 */
  private async executeEntryJob(job: SourceRefreshRow, source: MediaSourceRow, nowMs: number): Promise<void> {
    const db = Database.db;
    let staged: { digest: string; stagedCount: number };
    if (source.kind === 'iptv') {
      const remoteUrl = source.remote_url ?? '';
      const opened = await openRemoteSource(remoteUrl, { allowedTargets: getConfig().LAN_ALLOWED_TARGETS });
      try {
        const parsed = await parseM3U(opened.stream);
        const result = stageEntries(db, {
          householdId: job.household_id,
          refreshId: job.id,
          kind: 'iptv',
          entries: parsed.entries,
        });
        staged = { digest: result.snapshotDigest, stagedCount: result.stagedCount };
      } finally {
        await opened.close();
      }
    } else {
      const scanned = await scanNasRoot({
        roots: getConfig().MEDIA_ROOTS,
        rootKey: source.root_key ?? '',
        relativeDirectory: source.relative_directory ?? '',
      });
      const result = stageEntries(db, {
        householdId: job.household_id,
        refreshId: job.id,
        kind: 'nas',
        entries: scanned.entries,
      });
      staged = { digest: result.snapshotDigest, stagedCount: result.stagedCount };
    }

    this.recordStagedMeta(job, staged.digest, staged.stagedCount);

    const stagedRows = loadStagedEntries(db, { householdId: job.household_id, refreshId: job.id });
    const baseline = db
      .prepare(
        "SELECT identity_kind || ':' || identity_digest AS entry_key FROM source_entry WHERE household_id = ? AND source_id = ? AND present = 1",
      )
      .all(job.household_id, job.source_id) as Array<{ entry_key: string }>;
    const { counts } = diffSnapshot(
      baseline.map((row) => ({ entryKey: row.entry_key, present: true })),
      stagedRows.map((row) => ({ entryKey: row.entryKey })),
    );
    const evaluation = evaluateExceptions({
      counts,
      baselinePresentCount: baseline.length,
      isFirstImport: baseline.length === 0,
      emptySnapshotAllowed: false,
    });
    if (evaluation.requiresConfirmation) {
      // 异常快照:数量化 summary(脱敏,只有数量),TTL 内等待家长确认
      db.prepare(
        "UPDATE source_refresh SET status = 'awaiting_confirmation', version = version + 1, summary_json = ?, expires_at = ? WHERE id = ? AND household_id = ? AND status = 'running'",
      ).run(
        canonicalJson({ counts, confirmationReason: evaluation.reason }),
        iso(nowMs + IMPORT_BUDGETS.AWAITING_CONFIRMATION_TTL_MS),
        job.id,
        job.household_id,
      );
      return;
    }
    if (!this.initiatorSessionValid(job.household_id, job.initiator_session_id, nowMs)) {
      this.failJob(job, nowMs, ProblemCode.SESSION_INVALID);
      return;
    }
    this.publishEntrySnapshot(job, source.kind === 'nas' ? 'nas' : 'iptv', staged.digest, counts, nowMs);
  }

  /**
   * EPG:解析(网络 IO 在事务外)→ 窗口原子发布(不创建 MediaItem/不改分级)。
   * US5/ADR-0008(T070):成功发布由发布事务同事务 epg_generation+1(失败/中断不加);
   * 全程不写/删 manual_epg_binding(手动配置跨刷新/重启保留)。
   */
  private async executeEpgJob(job: SourceRefreshRow, source: MediaSourceRow, nowMs: number): Promise<void> {
    const remoteUrl = source.remote_url ?? '';
    const opened = await openRemoteSource(remoteUrl, { allowedTargets: getConfig().LAN_ALLOWED_TARGETS });
    let parsed: XMLTVParseResult;
    try {
      parsed = await parseXMLTV(opened.stream, {
        windowStartUtc: new Date(nowMs - EPG_WINDOW_PAST_MS),
        windowEndUtc: new Date(nowMs + EPG_WINDOW_FUTURE_MS),
      });
    } finally {
      await opened.close();
    }
    const digest = canonicalSnapshotDigest([
      ...parsed.channels.map((channel) => ({
        entryKey: `epg-channel:${channel.xmltvChannelId}`,
        payload: { displayName: channel.displayName },
      })),
      ...parsed.programmes.map((programme) => ({
        entryKey: `epg-programme:${programme.xmltvChannelId}`,
        payload: {
          title: programme.title,
          description: programme.description,
          startsAt: programme.startsAtUtc.toISOString(),
          endsAt: programme.endsAtUtc.toISOString(),
        },
      })),
    ]);
    this.recordStagedMeta(job, digest, parsed.programmes.length);
    const outcome = this.publish.publishEpgWindow({
      householdId: job.household_id,
      sourceId: job.source_id,
      refreshId: job.id,
      jobVersion: job.version,
      sourceVersion: job.source_version,
      baselineRevision: job.baseline_revision,
      snapshotDigest: digest,
      channels: parsed.channels,
      programmes: parsed.programmes,
      conflictedChannelIds: Array.from(parsed.conflictedChannelIds),
      nowMs,
    });
    void outcome; // stale/succeeded 均已在事务内落库
  }

  /** 暂存完成元数据落库(非状态迁移,不加 version;发布重验 snapshot_digest 用) */
  private recordStagedMeta(job: SourceRefreshRow, digest: string, itemCount: number): void {
    Database.db
      .prepare('UPDATE source_refresh SET snapshot_digest = ?, item_count = ? WHERE id = ? AND household_id = ?')
      .run(digest, itemCount, job.id, job.household_id);
  }

  /** 发布事务包装(错误向上抛给 processNextQueued 统一映射失败) */
  private publishEntrySnapshot(
    job: SourceRefreshRow,
    kind: 'iptv' | 'nas',
    snapshotDigest: string,
    counts: DiffCounts,
    nowMs: number,
  ): void {
    const outcome = this.publish.publishEntrySnapshot({
      householdId: job.household_id,
      sourceId: job.source_id,
      refreshId: job.id,
      kind,
      jobVersion: job.version,
      sourceVersion: job.source_version,
      baselineRevision: job.baseline_revision,
      snapshotDigest,
      counts,
      nowMs,
    });
    void outcome;
  }

  /** 发起会话/设备仍有效(自动发布前置;撤销/过期 → false) */
  private initiatorSessionValid(householdId: string, sessionId: string, nowMs: number): boolean {
    const row = Database.db
      .prepare(
        'SELECT s.revoked_at AS session_revoked_at, s.expires_at AS expires_at, d.revoked_at AS device_revoked_at FROM device_session s JOIN device d ON d.id = s.device_id WHERE s.id = ? AND s.household_id = ?',
      )
      .get(sessionId, householdId) as
      | { session_revoked_at: string | null; expires_at: string; device_revoked_at: string | null }
      | undefined;
    return (
      row !== undefined &&
      row.session_revoked_at === null &&
      row.device_revoked_at === null &&
      Date.parse(row.expires_at) > nowMs
    );
  }

  /** 任务失败(终态):稳定 errorCode + finished_at + version+1;清理暂存,不触碰已发布目录 */
  private failJob(job: SourceRefreshRow, nowMs: number, errorCode: string): void {
    const db = Database.db;
    db.transaction(() => {
      db.prepare(
        "UPDATE source_refresh SET status = 'failed', version = version + 1, error_code = ?, finished_at = ? WHERE id = ? AND household_id = ? AND status = 'running'",
      ).run(errorCode, iso(nowMs), job.id, job.household_id);
      clearStagedEntries(db, { householdId: job.household_id, refreshId: job.id });
    })();
  }

  /* ---------------------------------------------------------------- */
  /* 恢复与过期                                                        */
  /* ---------------------------------------------------------------- */

  /**
   * 表存在守卫:AppModule 可能在仅应用 0001/0002 的临时库上启动
   * (readiness 语义即缺表降级 503,不允许 onModuleInit 崩溃)。
   * source_refresh 表缺失时自动路径静默跳过,循环下一轮重新检查(建表后自动恢复)。
   */
  private hasSourceRefreshTable(db: typeof Database.db): boolean {
    const row = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'source_refresh'")
      .get() as { name: string } | undefined;
    return row !== undefined;
  }

  /** 重启恢复:queued/running → interrupted(version+1,finished_at),不自动重跑;返回任务数 */
  recoverInterrupted(nowMs: number = Date.now()): number {
    const db = Database.db;
    if (!this.hasSourceRefreshTable(db)) {
      return 0;
    }
    return db.transaction((): number => {
      const rows = db
        .prepare("SELECT id, household_id FROM source_refresh WHERE status IN ('queued', 'running')")
        .all() as Array<{ id: string; household_id: string }>;
      for (const row of rows) {
        db.prepare(
          "UPDATE source_refresh SET status = 'interrupted', version = version + 1, finished_at = ? WHERE id = ? AND household_id = ? AND status IN ('queued', 'running')",
        ).run(iso(nowMs), row.id, row.household_id);
      }
      return rows.length;
    })();
  }

  /** 懒过期:awaiting_confirmation 超 expires_at → expired(version+1)+清暂存;返回过期任务数 */
  expireStaleConfirmations(nowMs: number = Date.now()): number {
    const db = Database.db;
    if (!this.hasSourceRefreshTable(db)) {
      return 0;
    }
    return db.transaction((): number => {
      const rows = db
        .prepare(
          "SELECT id, household_id FROM source_refresh WHERE status = 'awaiting_confirmation' AND expires_at IS NOT NULL AND expires_at <= ?",
        )
        .all(iso(nowMs)) as Array<{ id: string; household_id: string }>;
      for (const row of rows) {
        db.prepare(
          "UPDATE source_refresh SET status = 'expired', version = version + 1, finished_at = ? WHERE id = ? AND household_id = ? AND status = 'awaiting_confirmation'",
        ).run(iso(nowMs), row.id, row.household_id);
        clearStagedEntries(db, { householdId: row.household_id, refreshId: row.id });
      }
      return rows.length;
    })();
  }

  /* ---------------------------------------------------------------- */
  /* 确认 / 丢弃(供 T028 控制器调用;家长验证由调用方完成)                */
  /* ---------------------------------------------------------------- */

  /**
   * 确认待确认快照:仅 awaiting_confirmation(否则 409 REFRESH_STATE_CONFLICT);
   * expectedVersion 不匹配 409;已过期 409 REFRESH_STALE(顺带标 expired);
   * 发布前重验:来源启用/source.version/baseline_revision/暂存摘要一致,NAS 再核对
   * 磁盘 size/mtime —— 任一失败 409 REFRESH_STALE 并标 stale,不发布。
   */
  confirmRefresh(input: RefreshDecisionInput): RefreshJobView {
    const job = this.requireAwaitingJob(input);
    const nowMs = Date.now();
    const db = Database.db;
    const source = db
      .prepare('SELECT * FROM media_source WHERE id = ? AND household_id = ?')
      .get(job.source_id, job.household_id) as MediaSourceRow | undefined;
    const stagedRows = loadStagedEntries(db, { householdId: job.household_id, refreshId: job.id });
    const digest = stagedSnapshotDigest(stagedRows);
    const rejectStale = (detail: string): DomainError => {
      this.markJobStatus(job, 'stale', nowMs);
      return createDomainError('REFRESH_STALE', detail);
    };
    if (source === undefined || source.enabled !== 1 || source.version !== job.source_version) {
      throw rejectStale('来源配置已变化,快照失效');
    }
    const catalog = db.prepare('SELECT revision FROM catalog_state WHERE household_id = ?').get(job.household_id) as
      | { revision: number }
      | undefined;
    if (catalog === undefined || catalog.revision !== job.baseline_revision) {
      throw rejectStale('目录基线已变化,快照失效');
    }
    if (job.snapshot_digest === null || digest !== job.snapshot_digest) {
      throw rejectStale('暂存快照与确认摘要不一致');
    }
    if (source.kind === 'nas') {
      try {
        this.verifyNasStagedFacts(source, stagedRows);
      } catch (error) {
        // 磁盘事实与快照不符:与来源/基线失效同样处理(标 stale + 409 REFRESH_STALE)
        this.markJobStatus(job, 'stale', nowMs);
        throw error;
      }
    }
    const { counts } = this.recomputeEntryCounts(job, stagedRows);
    const outcome = this.publish.publishEntrySnapshot({
      householdId: job.household_id,
      sourceId: job.source_id,
      refreshId: job.id,
      kind: source.kind === 'nas' ? 'nas' : 'iptv',
      jobVersion: job.version,
      sourceVersion: job.source_version,
      baselineRevision: job.baseline_revision,
      snapshotDigest: digest,
      counts,
      nowMs,
    });
    if (outcome === 'stale') {
      throw createDomainError('REFRESH_STALE');
    }
    return toView(getJobRow(job.household_id, job.id) as SourceRefreshRow);
  }

  /** 丢弃待确认快照:仅 awaiting;成功 → discarded + 清暂存 + 释放来源锁 */
  discardRefresh(input: RefreshDecisionInput): RefreshJobView {
    const job = this.requireAwaitingJob(input);
    const db = Database.db;
    db.transaction(() => {
      db.prepare(
        "UPDATE source_refresh SET status = 'discarded', version = version + 1, finished_at = ? WHERE id = ? AND household_id = ? AND status = 'awaiting_confirmation'",
      ).run(iso(Date.now()), job.id, job.household_id);
      clearStagedEntries(db, { householdId: job.household_id, refreshId: job.id });
    })();
    return toView(getJobRow(job.household_id, job.id) as SourceRefreshRow);
  }

  /** 确认/丢弃共用前置:任务存在(404)→ 会话可选重验(401)→ 过期懒标(REFRESH_STALE)→ 状态/版本(409) */
  private requireAwaitingJob(input: RefreshDecisionInput): SourceRefreshRow {
    const job = getJobRow(input.householdId, input.refreshId);
    if (job === undefined) {
      throw new DomainError(404, ProblemCode.NOT_FOUND);
    }
    if (input.sessionId !== undefined) {
      this.assertCallerSessionValid(input.householdId, input.sessionId);
    }
    const nowMs = Date.now();
    if (job.status === 'awaiting_confirmation' && job.expires_at !== null && Date.parse(job.expires_at) <= nowMs) {
      this.markJobStatus(job, 'expired', nowMs);
      throw createDomainError('REFRESH_STALE', '待确认快照已过期');
    }
    if (job.status !== 'awaiting_confirmation') {
      throw createDomainError('REFRESH_STATE_CONFLICT');
    }
    if (job.version !== input.expectedVersion) {
      throw createDomainError('REFRESH_STATE_CONFLICT', '任务版本已变化,请重新加载');
    }
    return job;
  }

  /** 调用方会话重验(提供 sessionId 时):行存在、归属一致、未撤销、未过期且设备未撤销 */
  private assertCallerSessionValid(householdId: string, sessionId: string): void {
    if (!this.initiatorSessionValid(householdId, sessionId, Date.now())) {
      throw new DomainError(401, ProblemCode.SESSION_INVALID, '会话无效或已撤销');
    }
  }

  /** 终态迁移(stale/expired):version+1 + finished_at + 清暂存(带状态守卫,终态 immutable) */
  private markJobStatus(job: SourceRefreshRow, status: 'stale' | 'expired', nowMs: number): void {
    const db = Database.db;
    db.transaction(() => {
      db.prepare(
        `UPDATE source_refresh SET status = '${status}', version = version + 1, finished_at = ? WHERE id = ? AND household_id = ? AND status = 'awaiting_confirmation'`,
      ).run(iso(nowMs), job.id, job.household_id);
      clearStagedEntries(db, { householdId: job.household_id, refreshId: job.id });
    })();
  }

  /** 确认发布用的差异计数(重算,保证 summary 与发布内容一致) */
  private recomputeEntryCounts(
    job: SourceRefreshRow,
    stagedRows: ReadonlyArray<{ entryKey: string }>,
  ): { counts: DiffCounts } {
    const baseline = Database.db
      .prepare(
        "SELECT identity_kind || ':' || identity_digest AS entry_key FROM source_entry WHERE household_id = ? AND source_id = ? AND present = 1",
      )
      .all(job.household_id, job.source_id) as Array<{ entry_key: string }>;
    return diffSnapshot(
      baseline.map((row) => ({ entryKey: row.entry_key, present: true })),
      stagedRows,
    );
  }

  /** NAS 确认前核对:staged 文件事实与当前磁盘 size/mtime 一致(缺失/链接/越界/变化 → REFRESH_STALE) */
  private verifyNasStagedFacts(source: MediaSourceRow, stagedRows: ReadonlyArray<{ payload: Record<string, unknown> }>): void {
    const reject = (): DomainError => createDomainError('REFRESH_STALE', 'NAS 文件已变化,快照失效');
    const roots = getConfig().MEDIA_ROOTS;
    const rootPath = source.root_key === null ? undefined : roots[source.root_key];
    if (rootPath === undefined || rootPath === '') {
      throw reject();
    }
    for (const row of stagedRows) {
      const relativePath = row.payload['relativePath'];
      const sizeText = row.payload['sizeText'];
      const mtimeNsText = row.payload['mtimeNsText'];
      if (typeof relativePath !== 'string' || relativePath === '' || relativePath.includes('\\') || relativePath.startsWith('/')) {
        throw reject();
      }
      if (relativePath.split('/').some((segment) => segment === '' || segment === '.' || segment === '..')) {
        throw reject();
      }
      let stat: fs.BigIntStats;
      try {
        stat = fs.lstatSync(path.join(rootPath, ...relativePath.split('/')), { bigint: true });
      } catch {
        throw reject();
      }
      if (!stat.isFile()) {
        throw reject();
      }
      if (typeof sizeText !== 'string' || typeof mtimeNsText !== 'string') {
        throw reject();
      }
      if (String(stat.size) !== sizeText || String(stat.mtimeNs) !== mtimeNsText) {
        throw reject();
      }
    }
  }

  /* ---------------------------------------------------------------- */
  /* 生产串行循环(测试不经此路径;直接调用 runQueuedOnce)                */
  /* ---------------------------------------------------------------- */

  /** Nest 生命周期:恢复上次中断任务并启动串行循环(全局至多 1 个 running) */
  onModuleInit(): void {
    this.recoverInterrupted();
    this.stopped = false;
    void this.workerLoop();
  }

  onModuleDestroy(): void {
    this.stopped = true;
  }

  private async workerLoop(): Promise<void> {
    while (!this.stopped) {
      const processed = await this.runQueuedOnce();
      if (this.stopped) {
        break;
      }
      if (processed !== null) {
        this.expireStaleConfirmations();
        continue;
      }
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, REFRESH_WORKER_POLL_MS);
        // 不阻塞进程退出(测试进程不会被空闲轮询拖住)
        timer.unref?.();
      });
    }
  }
}
