/**
 * sources 仓储端口（008-repository-extraction T009，ADR-0015 D1）。
 *
 * 应用层数据访问的唯一合法形态：本文件定义纯 TS 端口接口 + 模块级 seam 槽；
 * Drizzle/better-sqlite3 实现位于 infrastructure/sources-store.drizzle.ts，
 * 由 sources.module.ts 装配期绑定（useFactory），单元测试 rig 经 bindSourcesStore
 * 自行绑定。
 *
 * 本上下文两类数据访问形态并存（迁移前事实）：
 * - 来源管理（sources.service）：drizzle 查询构建器 + drizzle 事务 —— 端口以
 *   SourcesTxStore（写事务）/ SourcesStore 顶层读方法表达，事务经 withTransaction；
 * - 刷新管线（refresh-executor/refresh-publish）：better-sqlite3 原生 prepared
 *   statements + db.transaction 同步回调 —— SQL 逐字迁移至 RefreshTxStore 语句面
 *   （008 FR-002：谓词、占位顺序、返回形态均不变），事务经 withSqlTransaction
 *   端口形态表达，事务句柄（tx）不越出 infrastructure。
 *
 * - 行类型经 `import type` 取自 @platform/database/schema（type-only 导入不产生
 *   依赖边，schema 保持单一事实源；原生 SQL 的 snake_case 投影行在本文件显式声明，
 *   与迁移前服务内局部接口逐字一致）；
 * - 暂存层（infrastructure/refresh-staging.service，合法层）经端口语句面委托，
 *   application 不再持有 db 句柄实参；
 * - seam 未绑定即调用为编程错误（显式失败，不静默空转；008 FR-004）。
 */
import type { deviceSession, mediaSource } from '@platform/database/schema';
import type {
  LoadedStagedEntry,
  StageEntriesParams,
  StageEntriesResult,
} from '@contexts/sources/infrastructure/refresh-staging.service';

/** 会话行（drizzle 投影；sources.service 会话/设备重验读取形态） */
export type SessionRow = typeof deviceSession.$inferSelect;

/** 媒体来源行（drizzle 投影，camelCase；来源管理读路径与写事务的行形态） */
export type MediaSource = typeof mediaSource.$inferSelect;

/** 媒体来源新行（drizzle insert values 形态；createSource 事务写入） */
export type NewMediaSource = typeof mediaSource.$inferInsert;

/** 任务状态（与 source_refresh_status_check CHECK 一致；自 refresh-executor.service 原样迁移） */
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

/** 刷新任务原始行（原生 SQL `SELECT * FROM source_refresh` 投影，snake_case；自 refresh-executor.service 原样迁移） */
export interface SourceRefreshRow {
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

/** 媒体来源原始行（原生 SQL `SELECT * FROM media_source` 投影，snake_case；自 refresh-executor.service 原样迁移） */
export interface MediaSourceRow {
  id: string;
  household_id: string;
  kind: 'iptv' | 'nas' | 'epg';
  remote_url: string | null;
  root_key: string | null;
  relative_directory: string | null;
  enabled: number;
  version: number;
}

/** source_entry 基线行（发布事务 mark missing/替换判定投影；自 refresh-publish.service 原样迁移） */
export interface SourceEntryRow {
  id: string;
  identity_kind: string;
  identity_digest: string;
  media_id: string | null;
  present: number;
  file_size_text: string | null;
  file_mtime_ns: string | null;
}

/** 发起会话/设备有效性投影（initiatorSessionValid 的 join 投影，snake_case 原样） */
export interface SessionDeviceValidityRow {
  session_revoked_at: string | null;
  expires_at: string;
  device_revoked_at: string | null;
}

/** queued 任务创建参数（requestRefresh 事务外单语句 INSERT 的值集） */
export interface QueuedRefreshJobInsert {
  id: string;
  householdId: string;
  sourceId: string;
  initiatorAccountId: string;
  initiatorSessionId: string;
  operationKey: string;
  sourceVersion: number;
  baselineRevision: number;
  createdAt: string;
}

/**
 * 来源管理写事务作用域（drizzle tx；createSource/updateSource 的事务块形态）。
 * patch 键集与迁移前各调用点一致（.set(patch) 直传）。
 */
export interface SourcesTxStore {
  /** 按 id 读来源（resolveEpgTarget/createSource 回读；where 仅 id） */
  findMediaSourceById(sourceId: string): MediaSource | undefined;
  /** 按 (id, householdId) 读来源（updateSource 事务内版本检查与回读） */
  findOwnedMediaSource(sourceId: string, householdId: string): MediaSource | undefined;
  insertMediaSource(values: NewMediaSource): void;
  /** 部分更新（.set(patch)；version/updatedAt 由调用方计算，保持迁移前语义） */
  updateOwnedMediaSource(sourceId: string, householdId: string, patch: Record<string, string | number | null>): void;
  /** 旧 awaiting_confirmation 快照标 stale（version+1；逐字迁移自 updateSource 事务） */
  markAwaitingSnapshotsStale(householdId: string, sourceId: string): void;
  /** catalog_state.revision +1（onConflictDoUpdate 补建语义，逐字迁移自 bumpCatalogRevision） */
  bumpCatalogRevision(householdId: string): void;
}

/**
 * 刷新管线语句面（better-sqlite3 原生 prepared statements 逐字迁移）。
 * 事务内外同形：事务外调用 = 单语句自动提交（与迁移前一致）；事务内（withSqlTransaction
 * 的 tx 作用域）= 随事务句柄执行。复合状态迁移（claim/fail/recover/expire/discard/
 * markTerminal）内嵌各自的多语句事务，见 SourcesStore 顶层方法。
 */
export interface RefreshTxStore {
  /* ---------- source_refresh 单语句读写 ---------- */
  getRefreshJobRow(householdId: string, refreshId: string): SourceRefreshRow | undefined;
  findRefreshJobByOperationKey(householdId: string, operationKey: string): SourceRefreshRow | undefined;
  findRefreshJobVersionAndDigest(
    householdId: string,
    refreshId: string,
  ): { version: number; snapshotDigest: string | null } | undefined;
  sessionExistsInHousehold(sessionId: string, householdId: string): boolean;
  accountExistsInHousehold(accountId: string, householdId: string): boolean;
  hasActiveRefreshJob(householdId: string, sourceId: string): boolean;
  countQueuedRefreshJobs(): number;
  insertQueuedRefreshJob(values: QueuedRefreshJobInsert): void;
  recordRefreshJobStagedMeta(householdId: string, refreshId: string, snapshotDigest: string, itemCount: number): void;
  markRefreshJobAwaitingConfirmation(householdId: string, refreshId: string, summaryJson: string, expiresAtIso: string): void;
  /** 发布事务 stale 分支：标 stale（version+1）+ 清暂存（markStaleAndClear 逐字迁移） */
  markRefreshJobStaleAndClearStaged(householdId: string, refreshId: string, finishedAtIso: string): void;
  markRefreshJobSucceeded(householdId: string, refreshId: string, finishedAtIso: string, summaryJson: string): void;

  /* ---------- media_source / catalog_state / source_entry 读 ---------- */
  findMediaSourceRecordById(sourceId: string): MediaSourceRow | undefined;
  findMediaSourceRecordInHousehold(sourceId: string, householdId: string): MediaSourceRow | undefined;
  findMediaSourceEnabledVersion(sourceId: string, householdId: string): { enabled: number; version: number } | undefined;
  getCatalogRevision(householdId: string): number | undefined;
  /** baseline=present 条目身份键投影（diff 计数与确认重算共用；entry_key 别名在仓储侧收拢） */
  listPresentEntryKeys(householdId: string, sourceId: string): string[];
  listSourceEntryBaselineRows(householdId: string, sourceId: string): SourceEntryRow[];
  findSessionDeviceValidity(sessionId: string, householdId: string): SessionDeviceValidityRow | undefined;

  /* ---------- 未就绪库守卫（sqlite_master 表存在检查） ---------- */
  hasSourceRefreshTable(): boolean;

  /* ---------- 暂存层委托（infrastructure/refresh-staging.service） ---------- */
  stageEntries(params: StageEntriesParams): StageEntriesResult;
  loadStagedEntries(params: { householdId: string; refreshId: string }): LoadedStagedEntry[];
  clearStagedEntries(params: { householdId: string; refreshId: string }): number;

  /* ---------- 发布事务语句面（refresh-publish.service 消费） ---------- */
  markSourceEntryMissing(entryId: string, householdId: string, missingSinceIso: string): void;
  /** 缺列容忍守卫（pragma_table_info）：仅应用 0001~0005 的部分迁移库为 false */
  mediaItemHasContentRevisionColumn(): boolean;
  bumpMediaItemContentRevision(mediaId: string, householdId: string, updatedAtIso: string): void;
  insertMediaItem(
    mediaId: string,
    householdId: string,
    type: string,
    title: string,
    createdAtIso: string,
    updatedAtIso: string,
  ): void;
  findMediaItemPresentation(
    mediaId: string,
    householdId: string,
  ): { title: string; type: string; title_overridden: number; type_overridden: number } | undefined;
  updateMediaItemPresentation(
    mediaId: string,
    householdId: string,
    title: string,
    type: string,
    updatedAtIso: string,
  ): void;
  nullMediaItemContentLevel(mediaId: string, householdId: string, updatedAtIso: string): void;
  sourceEntryHasGroupTitleColumn(): boolean;
  insertSourceEntry(
    entryId: string,
    householdId: string,
    sourceId: string,
    identityKind: string,
    identityDigest: string,
    mediaId: string,
    upstreamChannelId: string | null,
    lastSeenJobId: string,
    firstSeenAtIso: string,
    lastSeenAtIso: string,
    fileSizeText: string | null,
    fileMtimeNsText: string | null,
  ): void;
  insertSourceEntryWithGroup(
    entryId: string,
    householdId: string,
    sourceId: string,
    identityKind: string,
    identityDigest: string,
    mediaId: string,
    upstreamChannelId: string | null,
    lastSeenJobId: string,
    firstSeenAtIso: string,
    lastSeenAtIso: string,
    fileSizeText: string | null,
    fileMtimeNsText: string | null,
    groupTitle: string | null,
  ): void;
  updateSourceEntry(
    mediaId: string,
    upstreamChannelId: string | null,
    lastSeenJobId: string,
    lastSeenAtIso: string,
    fileSizeText: string | null,
    fileMtimeNsText: string | null,
    entryId: string,
    householdId: string,
  ): void;
  updateSourceEntryWithGroup(
    mediaId: string,
    upstreamChannelId: string | null,
    lastSeenJobId: string,
    lastSeenAtIso: string,
    fileSizeText: string | null,
    fileMtimeNsText: string | null,
    groupTitle: string | null,
    entryId: string,
    householdId: string,
  ): void;
  insertPlaybackSource(
    playbackId: string,
    householdId: string,
    sourceId: string,
    sourceEntryId: string,
    mediaItemId: string,
    protocol: string,
    location: string,
    createdAtIso: string,
    updatedAtIso: string,
  ): void;
  updatePlaybackSource(
    mediaItemId: string,
    protocol: string,
    location: string,
    updatedAtIso: string,
    playbackId: string,
    householdId: string,
  ): void;
  findPlaybackSourceId(householdId: string, sourceEntryId: string): string | undefined;
  /** NAS 替换清理（发布事务内）：profile_policy 名单行（严格解析由 application 承担） */
  listProfileIdsInHousehold(householdId: string): string[];
  findProfilePolicyLists(
    householdId: string,
    profileId: string,
  ): { allowed_media_ids: string; blocked_media_ids: string } | undefined;
  updateProfilePolicyAllowedMediaIds(
    householdId: string,
    profileId: string,
    allowedMediaIdsJson: string,
    updatedAtIso: string,
  ): void;
  recordMediaSourceSuccess(sourceId: string, householdId: string, refreshId: string, nowIso: string): void;
  incrementCatalogRevision(householdId: string): void;

  /* ---------- EPG 窗口发布 ---------- */
  deleteEpgProgrammes(householdId: string, sourceId: string): void;
  deleteEpgChannels(householdId: string, sourceId: string): void;
  insertEpgChannel(
    householdId: string,
    sourceId: string,
    xmltvChannelId: string,
    displayName: string,
    conflicted: number,
  ): void;
  /** INSERT OR IGNORE：返回 changes（完全相同节目按唯一键去重计数） */
  insertEpgProgrammeIfAbsent(
    programmeId: string,
    householdId: string,
    sourceId: string,
    xmltvChannelId: string,
    title: string,
    description: string | null,
    startsAtIso: string,
    endsAtIso: string,
  ): number;
  mediaSourceHasEpgGenerationColumn(): boolean;
  bumpMediaSourceEpgGeneration(sourceId: string, householdId: string): void;
}

/** sources 上下文仓储端口（来源管理读写 + 刷新管线语句面 + 事务入口 + 复合状态迁移） */
export interface SourcesStore extends RefreshTxStore {
  /* ---------- 来源管理（drizzle；sources.service 消费） ---------- */
  findDeviceSession(sessionId: string): SessionRow | undefined;
  findMediaSourceById(sourceId: string): MediaSource | undefined;
  findOwnedMediaSource(sourceId: string, householdId: string): MediaSource | undefined;
  /** GET /sources 分页读（count 与 page 查询同一 where；total 缺行补 0） */
  listMediaSourcePage(
    householdId: string,
    page: number,
    pageSize: number,
  ): { rows: MediaSource[]; total: number };
  withTransaction<T>(fn: (tx: SourcesTxStore) => T): T;

  /* ---------- 刷新管线事务（better-sqlite3 同步回调语义） ---------- */
  withSqlTransaction<T>(fn: (tx: RefreshTxStore) => T): T;

  /* ---------- 复合状态迁移（内嵌各自的多语句事务，SQL 逐字迁移） ---------- */
  /** 认领最早 queued 任务（SELECT candidate → UPDATE running/version+1/started_at → changes 守卫 → 回读） */
  claimNextQueuedJob(startedAtIso: string): SourceRefreshRow | null;
  /** 任务失败终态：UPDATE failed + 清暂存（同事务） */
  failRefreshJob(householdId: string, refreshId: string, errorCode: string, finishedAtIso: string): void;
  /** 重启恢复：queued/running → interrupted（version+1, finished_at）；返回任务数 */
  recoverInterruptedJobs(finishedAtIso: string): number;
  /** 懒过期：awaiting_confirmation 超时 → expired + 清暂存；返回过期任务数 */
  expireStaleConfirmationJobs(nowIso: string): number;
  /** 丢弃待确认快照：UPDATE discarded + 清暂存（同事务） */
  discardAwaitingJob(householdId: string, refreshId: string, finishedAtIso: string): void;
  /** 终态迁移（stale/expired；awaiting 守卫 + version+1 + finished_at + 清暂存） */
  markAwaitingJobTerminal(
    householdId: string,
    refreshId: string,
    status: 'stale' | 'expired',
    finishedAtIso: string,
  ): void;
}

/**
 * seam 槽（ADR-0015 D1）：未绑定即调用为编程错误（显式失败，不静默空转）；
 * 重复绑定幂等覆盖（测试 rig 在 Database 单例重开后重建需要）。
 */
let boundStore: SourcesStore | null = null;

export function bindSourcesStore(store: SourcesStore): void {
  boundStore = store;
}

export function sourcesStore(): SourcesStore {
  if (boundStore === null) {
    throw new Error(
      'SOURCES_STORE 未绑定：sources 仓储端口需在模块装配（sources.module.ts）或测试 rig 中经 bindSourcesStore 绑定（ADR-0015 D1 / 规格 008 FR-004）',
    );
  }
  return boundStore;
}
