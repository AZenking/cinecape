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
import type { mediaSource } from '@platform/database/schema';
import type {
  LoadedStagedEntry,
  StageEntriesParams,
  StageEntriesResult,
} from '@contexts/sources/infrastructure/refresh-staging.service';

/** 媒体来源行（drizzle 投影，camelCase；来源管理读路径与写事务的行形态） */
export type MediaSource = typeof mediaSource.$inferSelect;

/** 媒体来源新行（drizzle insert values 形态；createSource 事务写入） */
export type NewMediaSource = typeof mediaSource.$inferInsert;

/** vod_source_config 行键（010 T026；一源一行，复合主键 (household_id, source_id)） */
export interface VodSourceConfigKey {
  householdId: string;
  sourceId: string;
}

/** 启用 vod 来源快照行（010 T028/T031；media_source × vod_source_config JOIN 投影） */
export interface EnabledVodSourceSnapshotRow {
  sourceId: string;
  name: string;
  adapter: string;
  locatorRevision: number;
  /** 私有定位（上游读取装配消费；绝不进入公共 DTO） */
  remoteUrl: string | null;
}

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
  /** 0010(016 data-model §1.1):多源优先级,数值越小越优先;SELECT * 经 DDL DEFAULT 100 兜底 */
  readonly priority: number;
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

/* ------------------------------------------------------------------ */
/* 014 T015:channel_logo 胜者注册表参与者端口（跨上下文类型镜像）          */
/* ------------------------------------------------------------------ */

/**
 * 镜像 ChannelLogoWinnerRow（源：media-catalog infrastructure/transaction-participants.ts，
 * internal-ports.md §2 findChannelLogo 返回形状；R2 禁深导入，结构一致性由
 * infrastructure 装配处编译期赋值强制）。channel_logo 行归 media-catalog 域所有，
 * sources 发布只经参与者读写，绝不直写他域表（internal-ports.md §1/§5）。
 */
export interface ChannelLogoWinnerRowMirror {
  readonly mediaId: string;
  /** 私有上游地址；墓碑态必须为 NULL（data-model §2 CHECK） */
  readonly upstreamUrl: string | null;
  readonly ref: string;
  readonly sourceKind: 'iptv' | 'epg' | 'custom';
  /** 来源证据（media_source 同家庭行） */
  readonly sourceId: string;
  readonly revision: number;
  /** 墓碑时间（ISO-8601）；NULL=active */
  readonly revokedAt: string | null;
}

/** 镜像 ChannelLogoWinnerCommand（源同上；upsertChannelLogoWinner 命令形状） */
export interface ChannelLogoWinnerCommandMirror {
  readonly householdId: string;
  readonly mediaId: string;
  readonly upstreamUrl: string;
  readonly sourceKind: 'iptv' | 'epg';
  readonly sourceId: string;
  /** 事务内时间戳（ISO-8601）；缺省 = 参与者内取当前时间 */
  readonly nowIso?: string;
}

/**
 * 镜像 ChannelLogoParticipantMirror（014 internal-ports.md §2「发布参与者」）：
 * channel_logo 注册表事务参与者端口 —— 合并语义（data-model §4 M1–M4）由参与者
 * 内部执行（active 同源同 url 无操作不换 ref；epg 不覆盖 iptv；墓碑复 active 换
 * ref/revision+1；引用签发在参与者内完成），发布方只接收「要写到 media_item.poster_ref
 * 的值」（internal-ports.md §2 规则）。
 */
export interface ChannelLogoParticipant {
  findChannelLogo(householdId: string, mediaId: string): ChannelLogoWinnerRowMirror | undefined;
  upsertChannelLogoWinner(command: ChannelLogoWinnerCommandMirror): { ref: string };
  revokeChannelLogo(householdId: string, mediaId: string, nowIso: string): void;
  gcExpiredChannelLogoTombstones(householdId: string, olderThanIso: string): void;
  setChannelPosterRef(householdId: string, mediaId: string, ref: string | null): void;
}

/**
 * 镜像 CHANNEL_LOGO_TOMBSTONE_WINDOW_MS（源：media-catalog transaction-participants.ts；
 * data-model §4「墓碑窗口：revoked_at ≤ now−7d 的行在任一发布事务内集合 DELETE」）。
 * 发布方据此计算 gcExpiredChannelLogoTombstones 的 olderThanIso。
 */
export const CHANNEL_LOGO_TOMBSTONE_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * epg_channel 证据行投影（014 T033 M2 epg 填补判定输入；本域自有表，非镜像）。
 * icon_url = XMLTV 首个 <icon src> 解析层归一化产物（NULL 或 http(s) 且 9~2048）。
 */
export interface EpgChannelIconRow {
  readonly sourceId: string;
  readonly xmltvChannelId: string;
  readonly conflicted: number;
  /** 私有证据列；NULL = 该 XMLTV 频道无有效图标 */
  readonly iconUrl: string | null;
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
  /** 021:归档注册表读取（有行=已归档） */
  findSourceArchive(sourceId: string, householdId: string): { archivedAt: string } | undefined;
  /** 021:写入归档注册表（有则覆盖） */
  insertSourceArchive(values: { householdId: string; sourceId: string; archivedAt: string; archivedBy: string | null }): void;
  /** 021:删除归档注册表行（恢复） */
  deleteSourceArchive(sourceId: string, householdId: string): void;
  /** 旧 awaiting_confirmation 快照标 stale（version+1；逐字迁移自 updateSource 事务） */
  markAwaitingSnapshotsStale(householdId: string, sourceId: string): void;
  /** catalog_state.revision +1（onConflictDoUpdate 补建语义，逐字迁移自 bumpCatalogRevision） */
  bumpCatalogRevision(householdId: string): void;
  /* —— 010 T026（api.md §2「限10启用源」/data-model §2 vod_source_config/§4 净配额）—— */
  /** kind=vod 且 enabled=1 的来源净数（createSource/PATCH 启用的事务内配额检查读数） */
  countEnabledVodSources(householdId: string): number;
  /** vod 适配配置写入（一源一行，adapter=apple-cms-json；createSource vod 分支同事务） */
  insertVodSourceConfig(values: VodSourceConfigKey & { adapter: string }): void;
  /** locator_revision +1（010 data-model §2「启停均locator_revision+1防ABA」；改名不递增） */
  incrementLocatorRevision(sourceId: string, householdId: string): void;
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
  /** 缺列容忍守卫（pragma_table_info）：仅应用 0001~0008 的部分迁移库为 false（0009 原子增补） */
  sourceEntryHasLogoUrlColumn(): boolean;
  /** source_entry.logo_url 私有证据列落值（IPTV 发布事务内；014 T015，同事务） */
  setSourceEntryLogoUrl(logoUrl: string | null, entryId: string, householdId: string): void;
  /** 未就绪库守卫：channel_logo 表（0009）缺失时 Logo 合并/墓碑 GC 静默跳过 */
  hasChannelLogoTable(): boolean;
  /**
   * channel_logo 胜者注册表参与者（同事务连接绑定；014 T015）。经 media-catalog
   * 参与者执行 M1 合并（upsert → poster_ref）与墓碑 GC，sources 绝不直写他域 SQL
   * （internal-ports.md §1/§5）；绑定生命周期与所属事务回调一致（连接级事务语义）。
   */
  channelLogoParticipant(): ChannelLogoParticipant;
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
    /** 016 T018:线路排序权重(播放解析按 priority ASC 选默认线路;playback_source 列自 0003 即存在) */
    priority: number,
  ): void;
  updatePlaybackSource(
    mediaItemId: string,
    protocol: string,
    location: string,
    updatedAtIso: string,
    playbackId: string,
    householdId: string,
    /** 016 T018:线路排序权重随发布刷新(来源 priority/清晰度变化时重算) */
    priority: number,
  ): void;
  /**
   * 016 T018(US3 多线路聚合):家庭内可聚合频道行投影(type='channel' 且
   * title_overridden=0 —— 人工改名的频道不参与自动归并,保住家长人工修正)。
   * 跨来源同名归并键 = normalizeChannelKey(title);单次集合查询,发布事务内消费。
   */
  listAggregatableChannelMediaRows(householdId: string): Array<{ id: string; title: string }>;
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
  /** 缺列容忍守卫（pragma_table_info）：仅应用 0001~0008 的部分迁移库为 false（0009 原子增补） */
  epgChannelHasIconUrlColumn(): boolean;
  /**
   * epg_channel.icon_url 私有证据列随窗口 upsert 写入（XMLTV 解析层归一化产物；
   * 014 T033，发布事务内同事务）。hasIconUrlColumn=false 的未就绪库静默跳过 icon 写入。
   */
  insertEpgChannelWithIcon(
    householdId: string,
    sourceId: string,
    xmltvChannelId: string,
    displayName: string,
    conflicted: number,
    iconUrl: string | null,
  ): void;
  /**
   * 家庭全部 EPG 频道证据行（icon_url + conflicted 投影；014 T033 M2 epg 填补的
   * 判定输入）：单次集合查询，查询次数不随频道数线性增长（对齐 live-projection
   * 集合查询纪律）。icon_url 为私有载荷，绝不进入公共 DTO（internal-ports §5）。
   */
  listEpgChannelIconRows(householdId: string): EpgChannelIconRow[];
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
    posterMatchKey: string | null,
    posterRef: string | null,
  ): number;
  /** 020:0012 迁移能力守卫（缺列的部分迁移库走旧 SQL，不崩溃） */
  epgProgrammeHasPosterColumns(): boolean;
  mediaSourceHasEpgGenerationColumn(): boolean;
  bumpMediaSourceEpgGeneration(sourceId: string, householdId: string): void;
}

/** sources 上下文仓储端口（来源管理读写 + 刷新管线语句面 + 事务入口 + 复合状态迁移） */
export interface SourcesStore extends RefreshTxStore {
  /* ---------- 来源管理（drizzle；sources.service 消费） ---------- */
  // 013/ADR-0017:原「家长验证后重读会话行」专设的 findDeviceSession 随验证闸门摘除
  // （常规运维免当次密码,会话有效性由 SessionGuard 逐请求承担）。
  findMediaSourceById(sourceId: string): MediaSource | undefined;
  findOwnedMediaSource(sourceId: string, householdId: string): MediaSource | undefined;
  /** 021:来源是否已归档（常规管理/刷新准入/优先级投影共用） */
  isSourceArchived(sourceId: string, householdId: string): boolean;
  /** GET /sources 分页读（count 与 page 查询同一 where；total 缺行补 0） */
  listMediaSourcePage(
    householdId: string,
    page: number,
    pageSize: number,
  ): { rows: MediaSource[]; total: number };
  /** vod 适配配置读取（010 T026 testSource compatible 判定；一源一行，未配置返回 undefined） */
  findVodSourceConfig(householdId: string, sourceId: string): (VodSourceConfigKey & { adapter: string }) | undefined;
  /**
   * 010 T028/T031（api.md §2 搜索轮转缓冲输入）：本家庭启用 vod 来源快照
   * （media_source × vod_source_config JOIN；与事务参与者 listEnabledVodSources
   * 同一谓词/排序，另带 remote_url 供上游定位构建）。remote_url 为私有定位，
   * 只供 online-vod 上游读取装配消费，绝不进入公共 DTO。
   */
  listEnabledVodSourceSnapshots(householdId: string): EnabledVodSourceSnapshotRow[];
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
