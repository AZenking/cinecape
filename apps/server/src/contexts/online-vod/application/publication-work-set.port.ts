/**
 * 010-online-vod T015：物化发布事务工作集与每所有者事务感知端口（纯 TS，零实现）。
 *
 * 契约来源：docs/specs/010-online-vod/contracts/internal-ports.md
 * - §1「所有者与依赖」：VodSourceConfigurationPort（sources）/ OnlineVodProviderPort
 *   （online-vod；010 T090 knip 清理:TS 接口面已删,见文件尾注记）/ CatalogMaterializationParticipant（media-catalog）/
 *   SourceEntryPublicationParticipant（sources）/ OnlineVodPublicationParticipant（online-vod）；
 * - §2「UnitOfWork 与三类原子范围」：MaterializeWorkSet 读/写面与步骤顺序；
 * - §5「审查新增工作集」：RegisteredCandidateParticipant（候选分支同事务登记）。
 *
 * 与 T008 UnitOfWork API（apps/server/test/unit/online-vod/unit-of-work.spec.ts）对齐：
 * - 本文件只声明工作集聚合接口与各所有者的 Tx 端口；run 机制由
 *   @platform/database/unit-of-work（T016 实现）提供 ——
 *   createUnitOfWork({ resolveDatabase, txStores }) 经各上下文 TxStore 工厂注册，
 *   run(workSetFactory, callback, { behavior: 'immediate' }) 把同一连接事务绑定到
 *   每个端口实现；application 消费端只见绑定后的工作集成员，不接触
 *   TransactionBinding / 连接句柄 / ORM（事务凭证不暴露 ORM 句柄）；
 * - callback 为同步签名（SyncResult），本文件全部 Tx 端口方法同步返回；
 *   网络/HTML 一律在事务外（经下方 VodSourceConfigurationPort / OnlineVodProviderPort
 *   在 run 边界前后消费），不在 callback 内 await；
 * - 任何端口方法抛错即整体回滚（T008 用例 2/3：多参与者同事务可见、失败原样上抛）。
 *
 * MaterializeWorkSet 步骤顺序（§2，消费方必须按此编排，实现归 T016/T029）：
 * 幂等已提交恢复 → 重验上下文（身份/来源/目标策略）→ 预分配稳定身份/人工元数据 →
 * 目标策略 → 预览/配置/详情 CAS → 净配额 → 完整映射/资源 → 幂等结果 →
 * 公共 revision（仅公开变化时递增）→（§5 候选分支）同事务登记 registeredCandidateRef
 * 与操作结果。已有 ID 复用先查映射；首次 ID 只内存预分配，不能为策略先提交占位资源；
 * 后台详情更新同工作集但不要求用户物化 operationKey，公共 rev 只改一次。
 */
import type {
  mediaItem,
  profile,
  profilePolicy,
  vodDetailSnapshot,
  vodEpisode,
  vodEpisodeSequence,
  vodLine,
  vodMaterializationOperation,
  vodRegisteredCandidate,
  vodSourceConfig,
  vodTitle,
} from '@platform/database/schema';

/* ------------------------------ schema 行投影（type-only 单一事实源） ------------------------------ */

/** 目录媒体行（media_item；已有 ID 复用判定与人工元数据保留判定的行形态） */
export type CatalogMediaRow = typeof mediaItem.$inferSelect;
/** 当前主档案行（profile） */
export type ProfileRow = typeof profile.$inferSelect;
/** 有效媒体策略行（profile_policy；ADR-0006 名单/分级判定输入） */
export type PolicyRow = typeof profilePolicy.$inferSelect;
/** vod 来源适配配置行（vod_source_config；一源一行） */
export type VodSourceConfigRow = typeof vodSourceConfig.$inferSelect;
/** 稳定标题映射行（vod_title；(source, upstream_vod_id) 唯一、父媒体唯一） */
export type VodTitleRow = typeof vodTitle.$inferSelect;
/** 播放线路行（vod_line） */
export type VodLineRow = typeof vodLine.$inferSelect;
/** 稳定子项行（vod_episode；(line, episode_key) 与 media_id 均唯一） */
export type VodEpisodeRow = typeof vodEpisode.$inferSelect;
/** 私有详情快照行（vod_detail_snapshot；(title, revision) 唯一、不可变） */
export type VodDetailSnapshotRow = typeof vodDetailSnapshot.$inferSelect;
/** 独立导航序列行（vod_episode_sequence） */
export type VodEpisodeSequenceRow = typeof vodEpisodeSequence.$inferSelect;
/** 物化幂等操作行（vod_materialization_operation；committed_at 非空才可重放） */
export type MaterializationOperationRow = typeof vodMaterializationOperation.$inferSelect;
/** 登记候选映射行（vod_registered_candidate；registered_candidate_ref 唯一可反查） */
export type RegisteredCandidateRow = typeof vodRegisteredCandidate.$inferSelect;

/* ------------------------------------ 配套纯值类型（命令/结果） ------------------------------------ */

/** titleRef/episodeRef 稳定分支（api §3 严格 oneOf 之一；previewRevision 绑定预览快照） */
export interface MaterializeByStableRefCommand {
  readonly kind: 'stableRef';
  readonly titleRef: string;
  readonly episodeRef: string;
  readonly previewRevision: number;
  readonly operationKey: string;
}

/** candidateRef 候选分支（api §3 严格 oneOf 之二；ref 由服务端记录绑定，Controller 不解析上游键） */
export interface MaterializeByCandidateRefCommand {
  readonly kind: 'candidateRef';
  readonly candidateRef: string;
  readonly previewRevision: number;
  readonly operationKey: string;
}

/** 物化命令（api §3 POST /vod/materializations 请求的 oneOf 判别联合） */
export type MaterializeCommand = MaterializeByStableRefCommand | MaterializeByCandidateRefCommand;

/** 物化结果（api §1 Materialized DTO 形态；revision 为提交时值，不表示当前仍未变化） */
export interface MaterializeOutcome {
  readonly parentMediaId: string;
  readonly mediaId: string;
  readonly detailRevision: number;
  readonly catalogRevision: number;
  readonly replayed: boolean;
  readonly candidateRef: string | null;
  readonly registeredCandidateRef: string | null;
}

/** 设备会话身份快照（identity-access 读取投影；事务内重验的输入事实） */
export interface DeviceIdentitySnapshot {
  readonly deviceSessionId: string;
  readonly accountId: string;
  readonly deviceId: string;
  readonly profileId: string;
  readonly profileContextVersion: number;
  readonly revokedAt: string | null;
  readonly expiresAt: string;
}

/** 策略判定目标媒体投影（批量装载的 catalog 事实列集；判定顺序归 application） */
export interface PolicyTargetMediaRow {
  readonly id: string;
  readonly type: string;
  readonly title: string;
  readonly contentLevel: number | null;
  readonly version: number;
}

/* (010 T090 knip 清理:原 MediaPolicyVerdict 接口已删除——零消费,策略判定输出由
 *  policy 上下文 effective-media-policy 纯函数面承担) */

/* ------------------------------------------ Read 面（每所有者一个事务感知端口） ------------------------------------------ */

/**
 * 身份快照读取端口。
 * 所有者：identity-access（T016 经 txStores 注册同连接绑定实现）。
 */
export interface IdentitySnapshotReader {
  /** 事务内重验设备会话身份快照（账号/设备/Profile/上下文版本与撤销过期事实），缺失即拒绝 */
  findDeviceContext(deviceSessionId: string): DeviceIdentitySnapshot | undefined;
}

/**
 * 主档案读取端口。
 * 所有者：profile。
 */
export interface ProfileReader {
  /** 读当前 Profile 行（存在性/年龄分级输入），跨家庭/不存在返回 undefined 交由用例判 404 */
  findProfile(householdId: string, profileId: string): ProfileRow | undefined;
}

/**
 * 有效媒体策略读取端口。
 * 所有者：policy（保留 ADR-0006 允许名单规则；判定顺序不随端口下沉）。
 */
export interface PolicyReader {
  /** 读当前有效策略行（名单与分级基线），行缺失按策略拒绝语义交由用例处理 */
  findEffectivePolicy(householdId: string, profileId: string): PolicyRow | undefined;
  /** 批量装载目标媒体事实（父/子一次查询，禁每集 N+1），供 application 执行 ADR-0006 判定 */
  listPolicyTargetMedia(householdId: string, mediaIds: readonly string[]): PolicyTargetMediaRow[];
}

/** 本家庭启用 vod 来源快照（media_source × vod_source_config 发布投影；配置 CAS 基准） */
export interface OwnedVodSourceSnapshot {
  readonly sourceId: string;
  readonly name: string;
  readonly adapter: 'apple-cms-json';
  readonly enabled: boolean;
  readonly version: number;
  readonly locatorRevision: number;
}

/**
 * 来源读取端口。
 * 所有者：sources（本工作集内的事务读取面；发布面端口见下方 VodSourceConfigurationPort）。
 */
export interface SourceReader {
  /** 读本家庭指定 vod 来源及配置 CAS 基准（locatorRevision/version），未配置或禁用返回 undefined */
  findOwnedVodSource(householdId: string, sourceId: string): OwnedVodSourceSnapshot | undefined;
  /** 读本家庭全部启用 vod 来源（≤10；搜索轮转与发布预检共用投影） */
  listEnabledVodSources(householdId: string): OwnedVodSourceSnapshot[];
}

/* ------------------------------------ Write 面（每所有者一个事务感知端口） ------------------------------------ */

/** vod_title 父媒体发布值集（media_item 新行；ID 由 application 内存预分配，落库不再生成） */
export interface VodParentMediaInsert {
  readonly id: string;
  readonly householdId: string;
  readonly type: 'movie' | 'series' | 'video';
  readonly title: string;
  readonly description: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/** vod_episode 子媒体发布值集（media_item 新行；type=episode） */
export interface VodEpisodeMediaInsert {
  readonly id: string;
  readonly householdId: string;
  readonly title: string;
  readonly description: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/**
 * 父子关系写入值集（media_relation；child 唯一父、自环与多层由 CHECK/领域校验拒绝）。
 * 010 收敛：media_relation 行身份即 (household_id, child_id) 复合主键、无独立
 * id/created_at 列（010 data-model §2 / migrations/0007），值集随列面对齐。
 */
export interface MediaRelationInsert {
  readonly householdId: string;
  readonly parentId: string;
  readonly childId: string;
  readonly sortOrder: number;
}

/**
 * 目录物化参与者端口。
 * 所有者：media-catalog（§1 CatalogMaterializationParticipant：发布父子媒体、角色、关系、
 * 元数据及公共 revision；独立维护目录，不混个人历史）。
 */
export interface CatalogParticipant {
  /** 已有 ID 复用先查映射：读目录媒体行（mediaRole/contentRevision/version），缺失即首次发布 */
  findCatalogMedia(householdId: string, mediaId: string): CatalogMediaRow | undefined;
  /** 发布 vod_title 父媒体（media_role=vod_title，与 type 配对由 CHECK 落实） */
  insertVodTitleMedia(values: VodParentMediaInsert): void;
  /** 发布 vod_episode 子媒体（media_role=vod_episode、type=episode） */
  insertVodEpisodeMedia(values: VodEpisodeMediaInsert): void;
  /** 写 child 唯一父关系（media_relation；重复子项整体回滚） */
  insertEpisodeParentRelation(values: MediaRelationInsert): void;
  /** 仅覆盖派生展示字段（人工 title/type_overridden 保留不动），返回实际是否变更 */
  updateDerivedPresentation(householdId: string, mediaId: string, patch: { title?: string; description?: string | null }, updatedAt: string): boolean;
  /** 公共 revision 仅公开变化时 +1（catalog_state.revision；与资源同提交，重放不虚增） */
  bumpPublicCatalogRevision(householdId: string): void;
}

/** vod 在线条目登记值集（source_entry 新行；identity_kind=vod_episode、摘要覆盖稳定定位不含 URL） */
export interface OnlineSourceEntryInsert {
  readonly entryId: string;
  readonly householdId: string;
  readonly sourceId: string;
  readonly identityDigest: string;
  readonly mediaId: string;
  readonly firstSeenAt: string;
  readonly lastSeenAt: string;
}

/** 在线播放资源写入值集（playback_source 判别联合 online 分支：location 空/vodEpisodeId 绑定/protocol=hls） */
export interface OnlinePlaybackResourceUpsert {
  readonly playbackSourceId: string;
  readonly householdId: string;
  readonly sourceId: string;
  readonly sourceEntryId: string;
  readonly mediaItemId: string;
  readonly vodEpisodeId: string;
  readonly priority: number;
  readonly requiresProxy: boolean;
  readonly updatedAt: string;
}

/**
 * 来源条目发布参与者端口。
 * 所有者：sources（§1 SourceEntryPublicationParticipant：登记 present 条目、静态/在线判别
 * 资源及索引，校验同源同媒体）。
 */
export interface SourceEntryParticipant {
  /** 同源同媒体查重：读 entry 存在性与 present 权威（(source, identity_kind, digest) 唯一基准） */
  findSourceEntryByMedia(householdId: string, sourceId: string, mediaId: string): { entryId: string; present: boolean } | undefined;
  /** 登记 present 在线条目（identity_kind=vod_episode；索引归属本来源，无 refresh job） */
  insertOnlineSourceEntry(values: OnlineSourceEntryInsert): void;
  /** 写/换 online 判别播放资源（entry 唯一资源；locator_kind/location/vod 引用配对由 CHECK 落实） */
  upsertOnlinePlaybackResource(values: OnlinePlaybackResourceUpsert): void;
}

/** 稳定标题映射写入值集（vod_title 新行；(source, upstream_vod_id) 唯一、父媒体唯一） */
export interface VodTitleMappingInsert {
  readonly titleId: string;
  readonly householdId: string;
  readonly sourceId: string;
  readonly upstreamVodId: string;
  readonly parentMediaId: string;
  readonly currentDetailRevision: number;
  readonly materializedAt: string;
}

/** 不可变详情快照写入值集（vod_detail_snapshot 新行；私有载荷地址不进公共 DTO） */
export interface VodDetailSnapshotInsert {
  readonly householdId: string;
  readonly titleId: string;
  readonly revision: number;
  readonly locatorRevision: number;
  readonly validatedPrivatePayload: string;
  readonly fetchedAt: string;
  readonly expiresAt: string;
}

/** 线路写入值集（vod_line 新行；(title, line_key) 唯一） */
export interface VodLineInsert {
  readonly lineId: string;
  readonly householdId: string;
  readonly titleId: string;
  readonly lineKey: string;
  readonly displayName: string;
  readonly sortOrder: number;
}

/** 子项写入值集（vod_episode 新行；(line, episode_key) 与 media_id 均唯一；verified 需完整证据） */
export interface VodEpisodeInsert {
  readonly episodeId: string;
  readonly householdId: string;
  readonly lineId: string;
  readonly episodeKey: string;
  readonly label: string;
  readonly mediaId: string;
  readonly contentVersionState: 'unverified' | 'verified';
  readonly evidenceKind: string | null;
  readonly evidenceDigest: string | null;
  readonly schemaVersion: string | null;
  readonly continuityRevision: number;
  readonly continuitySignature: string | null;
}

/** 序列写入值集（vod_episode_sequence 新行；010 收敛：表无行级唯一 —— 「导航与身份分开」，
 * 行身份为 rowid，同一集不同 sequence_revision/状态快照按序落行，写入不依赖主键冲突） */
export interface VodEpisodeSequenceInsert {
  readonly householdId: string;
  readonly titleId: string;
  readonly lineId: string;
  readonly detailRevision: number;
  readonly sequenceRevision: number;
  readonly episodeId: string;
  readonly seasonKey: string | null;
  readonly ordinal: number;
  readonly sequenceStatus: 'ordered' | 'ambiguous' | 'special';
}

/** 物化幂等结果写入值集（vod_materialization_operation 新行；committed_at 非空、24h 保留重放不延长） */
export interface MaterializationOperationInsert {
  readonly id: string;
  readonly householdId: string;
  readonly deviceSessionId: string;
  readonly profileId: string;
  readonly profileContextVersion: number;
  readonly operationKey: string;
  readonly requestDigest: string;
  readonly parentMediaId: string;
  readonly selectedMediaId: string;
  readonly selectedContentRevision: number;
  readonly selectedContinuityRevision: number;
  readonly detailRevision: number;
  readonly catalogRevision: number;
  /** 当时 MaterializeOutcome 的 JSON（重放原样返回，不重算） */
  readonly result: string;
  readonly committedAt: string;
  readonly expiresAt: string;
}

/**
 * 稳定映射/详情/序列参与者端口。
 * 所有者：online-vod（§1 OnlineVodPublicationParticipant，令牌 ONLINE_VOD_PUBLICATION_PARTICIPANT：
 * 稳定映射、不可变详情/当前指针、连续性/序列及物化幂等）。
 */
export interface VodParticipant {
  /** 已有 ID 复用先查稳定映射（(source, upstream_vod_id) 唯一），命中即复用父/子身份不占新配额 */
  findTitleMapping(householdId: string, sourceId: string, upstreamVodId: string): VodTitleRow | undefined;
  /** 首次身份落稳定映射（父媒体唯一；同提交冲突即整体回滚） */
  insertTitleMapping(values: VodTitleMappingInsert): void;
  /** 写不可变详情快照（(title, revision) 唯一；已存在同 revision 即冲突拒绝） */
  insertImmutableDetailSnapshot(values: VodDetailSnapshotInsert): void;
  /** 推进当前指针 current_detail_revision（后台详情更新公共 rev 只改一次） */
  advanceCurrentDetailPointer(householdId: string, titleId: string, detailRevision: number): void;
  /** 读当前详情快照（详情 CAS：previewRevision/detailRevision 失配即 409 语义交由用例） */
  findDetailSnapshot(householdId: string, titleId: string, revision: number): VodDetailSnapshotRow | undefined;
  /** 子项映射查复用（(line, episode_key) 唯一），命中即复用 mediaId */
  findEpisodeMapping(householdId: string, lineId: string, episodeKey: string): VodEpisodeRow | undefined;
  /** 写线路（重复/空 key 由 CHECK 拒绝，不支持线路按 unsupported 展示不入库） */
  insertLine(values: VodLineInsert): void;
  /** 写子项（连续性 revision/signature 随行落库；静态基线为 1） */
  insertEpisode(values: VodEpisodeInsert): void;
  /** 写独立导航序列（缺集/季边界不跳序列，状态由 application 判定） */
  insertEpisodeSequence(values: VodEpisodeSequenceInsert): void;
  /** 读序列行（连续性复核：目标连续性变化即拒绝旧位置语义） */
  findEpisodeSequence(householdId: string, lineId: string, sequenceRevision: number, episodeId: string): VodEpisodeSequenceRow | undefined;
}

/**
 * 物化幂等操作端口。
 * 所有者：online-vod（§2 MaterializeWorkSet 幂等面：唯一 (household, device_session,
 * context_version, operation_key)）。
 */
export interface MaterializationOperationStore {
  /** 幂等已提交恢复：读同 scope 操作行，仅 committedAt 非空可重放原结果 */
  findCommittedOperation(householdId: string, deviceSessionId: string, profileContextVersion: number, operationKey: string): MaterializationOperationRow | undefined;
  /** 幂等结果与资源同 commit 写入（同 key 异 digest 冲突由 application 依 requestDigest 判 409） */
  recordCommittedOperation(values: MaterializationOperationInsert): void;
}

/**
 * 净配额端口。
 * 所有者：online-vod（data-model §4：10 启用源/5000 父/100000 子，事务内按新增净额检查）。
 */
export interface QuotaStore {
  /** 读父项存量（5000 净配额基数；与本事务写入同连接即 BEGIN IMMEDIATE 下不可被并发突破） */
  countVodTitleParents(householdId: string): number;
  /** 读子项存量（100000 净配额基数） */
  countVodEpisodes(householdId: string): number;
  /** 读启用 vod 来源数（10 净配额基数） */
  countEnabledVodSources(householdId: string): number;
}

/** 登记候选映射写入值集（vod_registered_candidate 新行；与物化结果同事务提交）。
 * 010 收敛：原候选引用列名取数据模型 §10 I1 规范命名 candidate_ref（唯一键
 * (家庭,operation_id,candidate_ref) 组成列；别名旧列 source_candidate_ref 已自 0007 删除） */
export interface RegisteredCandidateInsert {
  readonly id: string;
  readonly householdId: string;
  readonly deviceSessionId: string;
  readonly profileId: string;
  readonly profileContextVersion: number;
  readonly registeredCandidateRef: string;
  readonly candidateRef: string;
  readonly sourceSessionId: string;
  readonly sourceGeneration: number;
  readonly previewRevision: number;
  readonly targetMediaId: string;
  readonly targetContentRevision: number;
  readonly targetContinuityRevision: number;
  readonly targetDetailRevision: number;
  readonly materializationOperationId: string;
  readonly createdAt: string;
  readonly expiresAt: string;
}

/**
 * 登记候选参与者端口（§5 审查新增）。
 * 所有者：online-vod（候选分支从本上下文发布的候选快照读真实键，身份/来源/目标策略重验后
 * 同事务提交登记映射 + operation 结果；Controller 不能解析 ref 猜上游键）。
 */
export interface RegisteredCandidateParticipant {
  /** 由 registeredCandidateRef 反查登记映射（intent 只接受已登记目标；跨家庭/伪造 404 语义） */
  findRegisteredCandidateByRef(householdId: string, registeredCandidateRef: string): RegisteredCandidateRow | undefined;
  /** 按唯一键 (operation, 原 candidate_ref) 查重/恢复（同物化重复登记整体回滚；
   * 010 收敛：参数名随规范列 candidate_ref 对齐，语义不变） */
  findRegisteredCandidateBySourceRef(householdId: string, materializationOperationId: string, candidateRef: string): RegisteredCandidateRow | undefined;
  /** 候选分支同事务登记映射（含目标 media 与修订，受 operation 保护；过期按引用清理） */
  registerCandidateMapping(values: RegisteredCandidateInsert): void;
}

/* ------------------- 工作集聚合(T008 run 同步 callback 消费形态) -------------------
 * (010 T090 knip 清理:原 MaterializeWorkSet 聚合接口已删除——零代码消费,实现侧
 *  materialization.service 以 deps 注入函数束/绑定后 txStores 自建工作集形态;
 *  §2 步骤顺序契约仍以 internal-ports.md 为权威,注释中的 MaterializeWorkSet 字样
 *  指该契约概念)
 * ----------------------------------------------------------------------------- */

/* ------------------------- 发布面端口（非事务；§1 所有者标注，网络在 run 边界外） ------------------------- */

/** vod 来源端点快照（发布面搜索输入；只携带已登记来源的非私有事实） */
export interface VodSourceEndpointSnapshot {
  readonly sourceId: string;
  readonly name: string;
  readonly adapter: 'apple-cms-json';
  readonly locatorRevision: number;
}

/**
 * vod 来源配置端口（私有配置不直接暴露 Controller）。
 * 所有者：sources；允许消费方：online-vod/playback（§1）。事务内重验经 MaterializeWorkSet.source。
 */
export interface VodSourceConfigurationPort {
  /** 读本家庭启用 vod 来源端点（≤10；搜索轮转缓冲输入） */
  listEnabledVodSources(householdId: string): VodSourceEndpointSnapshot[];
  /** 配置 CAS 读数：locatorRevision 失配即拒绝旧配置消费（启停递增防 ABA 由 sources 保证） */
  readLocatorRevision(householdId: string, sourceId: string): number | undefined;
  /** 读单源配置行（adapter 判别；未配置返回 undefined） */
  findSourceConfig(householdId: string, sourceId: string): VodSourceConfigRow | undefined;
}

/** 公共搜索卡片值（api §1 PublicVodCard；无源配置 ID，posterRef 恒 null） */
export interface PublicVodCardValues {
  readonly titleRef: string;
  readonly title: string;
  readonly year: string | null;
  readonly sourceLabel: string;
  readonly posterRef: null;
}

/** 单源搜索状态值（api §1 SearchPage.sources 元素） */
export interface VodSourceSearchStatus {
  readonly sourceId: string;
  readonly status: 'ok' | 'empty' | 'timeout' | 'invalid' | 'unavailable';
  readonly hasMore: boolean;
}

/** 多源搜索页快照（api §1 SearchPage 形态；纯值，预览/搜索不物化、不建个人记录） */
export interface VodSearchPageSnapshot {
  readonly searchId: string;
  readonly items: readonly PublicVodCardValues[];
  readonly sources: readonly VodSourceSearchStatus[];
  readonly nextCursor: string | null;
  readonly partial: boolean;
  readonly reasons: readonly string[];
  readonly expiresAt: string;
}

/* (010 T090 knip 清理:原文件尾「发布面端口」段的 VodSearchRequest/VodDetailRequest/
 * VodDetailPayloadSnapshot/CandidateBindingSnapshot/CandidateMatchRequest 与
 * OnlineVodProviderPort 聚合端口接口已删除——零代码消费;搜索/详情/候选的实际装配
 * 经 VOD_SEARCH_SERVICE/VOD_PREVIEW_SERVICE 等服务令牌与 apple-cms.adapter 具体实现
 * 完成,快照形态以 domain/provider-model 与 application 服务自有形变为准) */
