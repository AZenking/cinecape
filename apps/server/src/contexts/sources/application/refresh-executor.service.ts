import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { Inject, Injectable, Logger, OnModuleDestroy, OnModuleInit, Optional } from '@nestjs/common';
import { ProblemCode } from '@hmp/shared';
import { DomainError, createDomainError } from '@platform/http-common/domain-error';
import { getConfig } from '@platform/config/env';
import { IMPORT_BUDGETS } from '@platform/config/import-budgets';
import type { IRefreshExecutorService } from '@contexts/sources/application/ports';
// 008-T009(ADR-0015 D1):数据访问经仓储端口 seam(原生 SQL 逐字迁移至 infrastructure/
// sources-store.drizzle.ts;行类型与任务状态枚举随端口走,行为零变化)
import {
  sourcesStore,
  type MediaSourceRow,
  type RefreshJobStatus,
  type SourceRefreshRow,
} from '@contexts/sources/application/sources-store.port';
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
  computeSnapshotDigest as stagedSnapshotDigest,
} from '@contexts/sources/infrastructure/refresh-staging.service';
import { M3UParseFailure, parseM3U } from '@contexts/sources/infrastructure/m3u.parser';
import { NasScanFailure, scanNasRoot } from '@contexts/sources/infrastructure/nas-scanner';
import { XMLTVParseFailure, parseXMLTV, type XMLTVParseResult } from '@contexts/sources/infrastructure/xmltv.parser';
import { RemoteReadFailure, openRemoteSource } from '@contexts/sources/infrastructure/safe-http-reader';
import { captureStream, saveImportSnapshot } from '@contexts/sources/infrastructure/import-snapshot';
import { RefreshPublishService, isPolicyCorruptionError } from '@contexts/sources/application/refresh-publish.service';
import { EPG_PROGRAMME_POSTER_PORT, type IEpgProgrammePosterService, type ProgrammePosterRef } from '@contexts/epg';

/** 任务状态(随仓储端口迁移;再导出维持本模块既有发布面) */
export type { RefreshJobStatus };

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

/**
 * 发起刷新入参(013/ADR-0017:执行器内部不变式 —— ownerPasswordVerified 声明位保留,
 * 公开入口 requestSourceRefresh 恒置 true;常规刷新已免当次密码,该标志仅表达
 * 「入口已通过自身校验链」的执行器内部契约,本服务只做业务)。
 */
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

/** EPG 指南窗口:刷新时刻前 24h ~ 后 7d(data-model;解析器按闭区间相交过滤) */
const EPG_WINDOW_PAST_MS = 24 * 3_600_000;
const EPG_WINDOW_FUTURE_MS = 7 * 24 * 3_600_000;
/** 生产串行循环空闲轮询间隔(有 queued 任务时连续执行,不受此间隔影响) */
export const REFRESH_WORKER_POLL_MS = 500;

function iso(ms: number): string {
  return new Date(ms).toISOString();
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
export class RefreshExecutorService implements OnModuleInit, OnModuleDestroy, IRefreshExecutorService {
  private readonly publish: RefreshPublishService;
  private readonly logger = new Logger(RefreshExecutorService.name);
  /** 串行执行器守卫:同一时刻至多一个任务在处理(research R5 全局单执行器) */
  private working = false;
  private stopped = false;

  constructor(
    @Optional()
    @Inject(RefreshPublishService)
    publish?: RefreshPublishService,
    @Optional()
    @Inject(EPG_PROGRAMME_POSTER_PORT)
    private readonly programmePoster?: IEpgProgrammePosterService,
  ) {
    this.publish = publish ?? new RefreshPublishService();
  }

  /* ---------------------------------------------------------------- */
  /* 排队创建                                                          */
  /* ---------------------------------------------------------------- */

  /**
   * 发起刷新(请求事务内创建 queued 任务;返回原任务 = 202 语义,由 T028 包装)。
   * 校验次序(013 起公开入口恒满足声明,内部不变式校验保留为最小防线):ownerPasswordVerified
   * 声明 → 来源 404 同形 → 禁用 422 → 幂等 → 版本 409 → 同来源互斥 409 → 全局排队 429 → 创建。
   */
  requestRefresh(input: RequestRefreshInput): RefreshJobView {
    if (input.ownerPasswordVerified !== true) {
      throw new DomainError(403, ProblemCode.PARENT_VERIFICATION_REQUIRED, '需要主账号密码完成家长验证');
    }
    const store = sourcesStore();
    const source = store.findMediaSourceRecordById(input.sourceId);
    if (source === undefined || source.household_id !== input.householdId) {
      throw new DomainError(404, ProblemCode.NOT_FOUND);
    }
    if (source.enabled !== 1) {
      throw createDomainError('SOURCE_DISABLED');
    }

    const existing = store.findRefreshJobByOperationKey(input.householdId, input.operationKey);
    if (existing !== undefined) {
      if (existing.source_id === input.sourceId && existing.source_version === input.expectedVersion) {
        return toView(existing);
      }
      throw createDomainError('IDEMPOTENCY_CONFLICT');
    }
    if (source.version !== input.expectedVersion) {
      throw createDomainError('SOURCE_VERSION_CONFLICT');
    }
    if (!store.sessionExistsInHousehold(input.sessionId, input.householdId)) {
      throw new DomainError(401, ProblemCode.SESSION_INVALID, '会话无效或已撤销');
    }
    if (!store.accountExistsInHousehold(input.accountId, input.householdId)) {
      throw new DomainError(403, ProblemCode.FORBIDDEN);
    }
    if (store.hasActiveRefreshJob(input.householdId, input.sourceId)) {
      throw createDomainError('SOURCE_BUSY');
    }
    if (store.countQueuedRefreshJobs() >= IMPORT_BUDGETS.IMPORT_QUEUE_CAPACITY) {
      throw createDomainError('IMPORT_QUEUE_FULL');
    }
    const baselineRevision = store.getCatalogRevision(input.householdId);
    if (baselineRevision === undefined) {
      throw new DomainError(500, ProblemCode.INTERNAL, '目录状态缺失');
    }

    const id = randomUUID();
    const now = new Date().toISOString();
    try {
      store.insertQueuedRefreshJob({
        id,
        householdId: input.householdId,
        sourceId: input.sourceId,
        initiatorAccountId: input.accountId,
        initiatorSessionId: input.sessionId,
        operationKey: input.operationKey,
        sourceVersion: source.version,
        baselineRevision,
        createdAt: now,
      });
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
    return toView(store.getRefreshJobRow(input.householdId, id) as SourceRefreshRow);
  }

  /** 按 id 读取任务概览(供 T028 GET /refreshes/{refreshId};跨家庭/未知 → null 由调用方 404) */
  getRefreshJob(householdId: string, refreshId: string): RefreshJobView | null {
    const row = sourcesStore().getRefreshJobRow(householdId, refreshId);
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
    const store = sourcesStore();
    if (!store.hasSourceRefreshTable()) {
      return null;
    }
    const job = store.claimNextQueuedJob(iso(nowMs));
    if (job === null) {
      return null;
    }
    try {
      await this.executeJob(job, nowMs);
    } catch (error) {
      this.failJob(job, nowMs, errorCodeOf(error));
    }
    const finalRow = store.getRefreshJobRow(job.household_id, job.id);
    return finalRow === undefined ? null : toView(finalRow);
  }

  /** 按 kind 分派:暂存(IPTV/NAS)或解析(EPG)→ 异常判定 → 发布/待确认 */
  private async executeJob(job: SourceRefreshRow, nowMs: number): Promise<void> {
    const source = sourcesStore().findMediaSourceRecordInHousehold(job.source_id, job.household_id);
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
    const store = sourcesStore();
    let staged: { digest: string; stagedCount: number };
    if (source.kind === 'iptv') {
      const remoteUrl = source.remote_url ?? '';
      const opened = await openRemoteSource(remoteUrl, { allowedTargets: getConfig().LAN_ALLOWED_TARGETS });
      try {
        const captured = captureStream(opened.stream, IMPORT_BUDGETS.M3U_MAX_BYTES);
        const parsed = await parseM3U(captured.stream);
        this.captureSnapshot(job, source, 'iptv', captured.snapshot(), nowMs);
        const result = store.stageEntries({
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
      const result = store.stageEntries({
        householdId: job.household_id,
        refreshId: job.id,
        kind: 'nas',
        entries: scanned.entries,
      });
      staged = { digest: result.snapshotDigest, stagedCount: result.stagedCount };
    }

    this.recordStagedMeta(job, staged.digest, staged.stagedCount);

    const stagedRows = store.loadStagedEntries({ householdId: job.household_id, refreshId: job.id });
    const baseline = store.listPresentEntryKeys(job.household_id, job.source_id);
    const { counts } = diffSnapshot(
      baseline.map((entryKey) => ({ entryKey, present: true })),
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
      store.markRefreshJobAwaitingConfirmation(
        job.household_id,
        job.id,
        canonicalJson({ counts, confirmationReason: evaluation.reason }),
        iso(nowMs + IMPORT_BUDGETS.AWAITING_CONFIRMATION_TTL_MS),
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
      const captured = captureStream(opened.stream, IMPORT_BUDGETS.XMLTV_MAX_TRANSFER_BYTES);
      parsed = await parseXMLTV(captured.stream, {
        windowStartUtc: new Date(nowMs - EPG_WINDOW_PAST_MS),
        windowEndUtc: new Date(nowMs + EPG_WINDOW_FUTURE_MS),
      });
      this.captureSnapshot(job, source, 'epg', captured.snapshot(), nowMs);
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
    const titles = [...new Set(parsed.programmes.map((programme) => programme.title))];
    // 020:发布前只读本地缓存恢复有效 ref（零网络）；失败不阻塞 EPG 发布。
    let posterByTitle: ReadonlyMap<string, ProgrammePosterRef> = new Map();
    if (this.programmePoster !== undefined) {
      try {
        posterByTitle = this.programmePoster.resolveCachedRefs({
          householdId: job.household_id,
          titles,
          nowMs,
        });
      } catch (error) {
        this.logger.warn(`节目海报缓存预读失败，按无海报发布: ${error instanceof Error ? error.name : 'unknown'}`);
      }
    }
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
      posterByTitle,
    });
    if (outcome === 'succeeded' && this.programmePoster !== undefined) {
      try {
        await this.programmePoster.enrichAfterEpgPublish({
          householdId: job.household_id,
          titles,
          nowMs: Date.now(),
        });
      } catch (error) {
        // 补全失败不影响已成功的刷新状态；下次刷新/CLI 会重试。
        this.logger.warn(`节目海报补全失败（刷新已成功）: ${error instanceof Error ? error.name : 'unknown'}`);
      }
    }
  }

  /** 原始快照旁路写入:失败只告警,不影响刷新成功语义(FR-005)。 */
  private captureSnapshot(
    job: SourceRefreshRow,
    source: MediaSourceRow,
    kind: 'iptv' | 'epg',
    raw: Buffer | null,
    nowMs: number,
  ): void {
    if (raw === null || raw.length === 0) {
      return;
    }
    try {
      saveImportSnapshot({
        householdId: job.household_id,
        sourceId: job.source_id,
        refreshId: job.id,
        kind,
        raw,
        capturedAtIso: new Date(nowMs).toISOString(),
      });
    } catch (error) {
      this.logger.warn(
        `原始导入快照写入失败(刷新继续,kinds=${source.kind}): ${error instanceof Error ? error.name : 'unknown'}`,
      );
    }
  }

  /** 暂存完成元数据落库(非状态迁移,不加 version;发布重验 snapshot_digest 用) */
  private recordStagedMeta(job: SourceRefreshRow, digest: string, itemCount: number): void {
    sourcesStore().recordRefreshJobStagedMeta(job.household_id, job.id, digest, itemCount);
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
    const row = sourcesStore().findSessionDeviceValidity(sessionId, householdId);
    return (
      row !== undefined &&
      row.session_revoked_at === null &&
      row.device_revoked_at === null &&
      Date.parse(row.expires_at) > nowMs
    );
  }

  /** 任务失败(终态):稳定 errorCode + finished_at + version+1;清理暂存,不触碰已发布目录 */
  private failJob(job: SourceRefreshRow, nowMs: number, errorCode: string): void {
    sourcesStore().failRefreshJob(job.household_id, job.id, errorCode, iso(nowMs));
  }

  /* ---------------------------------------------------------------- */
  /* 恢复与过期                                                        */
  /* ---------------------------------------------------------------- */

  /**
   * 表存在守卫:AppModule 可能在仅应用 0001/0002 的临时库上启动
   * (readiness 语义即缺表降级 503,不允许 onModuleInit 崩溃)。
   * source_refresh 表缺失时自动路径静默跳过,循环下一轮重新检查(建表后自动恢复)。
   */
  private hasSourceRefreshTable(): boolean {
    return sourcesStore().hasSourceRefreshTable();
  }

  /** 重启恢复:queued/running → interrupted(version+1,finished_at),不自动重跑;返回任务数 */
  recoverInterrupted(nowMs: number = Date.now()): number {
    if (!this.hasSourceRefreshTable()) {
      return 0;
    }
    return sourcesStore().recoverInterruptedJobs(iso(nowMs));
  }

  /** 懒过期:awaiting_confirmation 超 expires_at → expired(version+1)+清暂存;返回过期任务数 */
  expireStaleConfirmations(nowMs: number = Date.now()): number {
    if (!this.hasSourceRefreshTable()) {
      return 0;
    }
    return sourcesStore().expireStaleConfirmationJobs(iso(nowMs));
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
    const store = sourcesStore();
    const source = store.findMediaSourceRecordInHousehold(job.source_id, job.household_id);
    const stagedRows = store.loadStagedEntries({ householdId: job.household_id, refreshId: job.id });
    const digest = stagedSnapshotDigest(stagedRows);
    const rejectStale = (detail: string): DomainError => {
      store.markAwaitingJobTerminal(job.household_id, job.id, 'stale', iso(nowMs));
      return createDomainError('REFRESH_STALE', detail);
    };
    if (source === undefined || source.enabled !== 1 || source.version !== job.source_version) {
      throw rejectStale('来源配置已变化,快照失效');
    }
    const baselineRevision = store.getCatalogRevision(job.household_id);
    if (baselineRevision === undefined || baselineRevision !== job.baseline_revision) {
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
        store.markAwaitingJobTerminal(job.household_id, job.id, 'stale', iso(nowMs));
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
    return toView(store.getRefreshJobRow(job.household_id, job.id) as SourceRefreshRow);
  }

  /** 丢弃待确认快照:仅 awaiting;成功 → discarded + 清暂存 + 释放来源锁 */
  discardRefresh(input: RefreshDecisionInput): RefreshJobView {
    const job = this.requireAwaitingJob(input);
    sourcesStore().discardAwaitingJob(job.household_id, job.id, iso(Date.now()));
    return toView(sourcesStore().getRefreshJobRow(job.household_id, job.id) as SourceRefreshRow);
  }

  /** 确认/丢弃共用前置:任务存在(404)→ 会话可选重验(401)→ 过期懒标(REFRESH_STALE)→ 状态/版本(409) */
  private requireAwaitingJob(input: RefreshDecisionInput): SourceRefreshRow {
    const store = sourcesStore();
    const job = store.getRefreshJobRow(input.householdId, input.refreshId);
    if (job === undefined) {
      throw new DomainError(404, ProblemCode.NOT_FOUND);
    }
    if (input.sessionId !== undefined) {
      this.assertCallerSessionValid(input.householdId, input.sessionId);
    }
    const nowMs = Date.now();
    if (job.status === 'awaiting_confirmation' && job.expires_at !== null && Date.parse(job.expires_at) <= nowMs) {
      store.markAwaitingJobTerminal(job.household_id, job.id, 'expired', iso(nowMs));
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

  /** 确认发布用的差异计数(重算,保证 summary 与发布内容一致) */
  private recomputeEntryCounts(
    job: SourceRefreshRow,
    stagedRows: ReadonlyArray<{ entryKey: string }>,
  ): { counts: DiffCounts } {
    const baseline = sourcesStore().listPresentEntryKeys(job.household_id, job.source_id);
    return diffSnapshot(
      baseline.map((entryKey) => ({ entryKey, present: true })),
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
