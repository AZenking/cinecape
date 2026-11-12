/**
 * playback 仓储端口（008-repository-extraction T013，ADR-0015 D1）。
 *
 * 应用层数据访问的唯一合法形态：本文件定义纯 TS 端口接口 + 模块级 seam 槽；
 * Drizzle 实现位于 infrastructure/playback-store.drizzle.ts，由 playback.module.ts
 * 装配期绑定（useFactory），单元测试 rig 经 bindPlaybackStore 自行绑定。
 *
 * 迁移前事实（本上下文 6 个 application 服务、26 处 getDb() 调用点）：
 * - playback-authorization（10）/ playback-audit（5）/ playback-resolver（3）/
 *   playback-selection（1，另 2 处注释）/ playback-ticket（3）/ playback-retention（4）；
 * - 全部为事务外单语句（自动提交）——generation CAS / 票据签发短事务 /
 *   BEGIN IMMEDIATE 写路径均已在 infrastructure/playback.repository（合法层），
 *   故本端口无 withTransaction 形态（008 FR-003：事务句柄不越出 infrastructure，
 *   既有事务路径不经本端口，行为零变化）；
 * - 装配桥接（playback.module 的 PlaybackConversionBridge）原有 3 处 getDb()
 *   只读投影随本抽取一并收敛（模块文件原属审计自由区，收敛为单一数据面）。
 *
 * - 行类型经 `import type` 取自 @platform/database/schema（type-only 导入不产生
 *   依赖边，schema 保持单一事实源；depcruise 与 audit:purity 均放行）；
 * - 行→DTO/判定视图的映射留在 application（FR-002：会话上下文拼装、可见性判定、
 *   票据校验状态机、保留清理的先筛后删逻辑不随查询下沉）；
 * - 方法签名与实现逐字对应既有查询（008 FR-002：SQL 构造与谓词逐字迁移，
 *   join 链、分块参数、返回形态均不变）。
 */
import type {
  mediaItem,
  playbackSession,
  playbackTicket,
  profile,
} from '@platform/database/schema';

export type ProfileRow = typeof profile.$inferSelect;
export type MediaItemRow = typeof mediaItem.$inferSelect;
export type PlaybackSessionRow = typeof playbackSession.$inferSelect;
export type TicketRow = typeof playbackTicket.$inferSelect;

/**
 * 可信会话自联查询投影（id 键控，与 SessionGuard 的 token 键控同管线同字段口径；
 * 自 playback-authorization.service 的 loadTrustedSessionRow 原样迁移）。
 */
export interface TrustedSessionRow {
  sessionId: string;
  sessionHouseholdId: string;
  sessionAccountId: string;
  sessionDeviceId: string;
  activeProfileId: string | null;
  sessionExpiresAt: string;
  sessionRevokedAt: string | null;
  accountUsername: string;
  accountRole: string;
  accountHouseholdId: string;
  deviceRevokedAt: string | null;
  profileHouseholdId: string | null;
  profileAccountId: string | null;
  /** 当前身份上下文版本(005 data-model §2;授权快照捕获与控制链路重验的唯一事实源) */
  profileContextVersion: number;
}

/** 授权候选只读投影（listEnabledPlaybackResources 的 join 投影；刻意排除 location/mime 等私有字段） */
export interface EnabledPlaybackResourceRow {
  readonly playbackSourceId: string;
  readonly sourceId: string;
  readonly protocol: string;
}

/**
 * 016 T019(US3 多线路)线路事实只读投影(resolve 多线路下发的判定输入)：
 * 与 listEnabledPlaybackResourceRows 同 join 链同谓词(present 条目 × 启用父源 × 播放资源),
 * 另带线路公开事实 —— lineId 即 source_entry.id(不透明),sourceTitle 为来源显示名,
 * linePriority 为线路排序权重(playback_source.priority,导入发布按「来源 priority + 清晰度」
 * 派生落库)。不含 location/mime 等私有字段(线路投影绝不下发源地址/凭据)。
 */
export interface PlaybackLineRow {
  readonly playbackSourceId: string;
  readonly lineId: string;
  readonly sourceId: string;
  readonly sourceTitle: string;
  readonly linePriority: number;
}

/**
 * 缺失策略行的默认回填值集（backfillDefaultPolicyRow 的 insert values 形态；
 * defaultPolicyValues 由 application 按档案类型计算，port 只承载值集落库）。
 */
export interface ProfilePolicyDefaultInsert {
  readonly householdId: string;
  readonly profileId: string;
  readonly maxContentLevel: number;
  readonly allowUnrated: number;
  readonly allowedMediaIds: string;
  readonly blockedMediaIds: string;
  readonly allowedChannelIds: string;
  readonly version: number;
  readonly updatedAt: string;
}

/** 审计失败事件 insert 值集（档案可解性/媒体可见性由 application 判定后传入） */
export interface FailureEventInsert {
  readonly id: string;
  readonly householdId: string;
  readonly deviceSessionId: string;
  readonly deviceId: string;
  readonly profileId: string | null;
  readonly mediaId: string | null;
  readonly occurredAt: string;
  readonly stableCode: string;
}

/** playback 上下文仓储端口（授权/审计/解析/换代卫生/票据校验/保留清理/装配桥接的只读与单语句写） */
export interface PlaybackStore {
  /* ---------- 授权管线（playback-authorization.service 消费） ---------- */
  /** 可信会话自联投影（deviceSession ⨝ account ⨝ device ⟕ profile；逐字迁移） */
  findTrustedSessionRow(sessionId: string): TrustedSessionRow | undefined;
  /** 设备会话当前身份上下文版本（resolver 的上下文复查共用） */
  findDeviceSessionContextVersion(sessionId: string): { profileContextVersion: number } | undefined;
  /** 按 id 读档案整行（requireActiveProfileRow / backfillDefaultPolicyRow 回读） */
  findProfileRowById(profileId: string): ProfileRow | undefined;
  /** 按 (householdId, id) 读档案整行（assertBoundProfileCurrent 的 PIN 判定） */
  findProfileRowInHousehold(householdId: string, profileId: string): ProfileRow | undefined;
  /** 按 (householdId, id) 读档案 id 投影（audit 的复合 FK 可满足性判定） */
  findHouseholdProfileId(householdId: string, profileId: string): { id: string } | undefined;
  /** 按 (householdId, id) 读媒体 id 投影（audit 可见性第一段） */
  findHouseholdMediaId(householdId: string, mediaId: string): { id: string } | undefined;
  /** 按 (householdId, mediaId, present=1) 读条目 id 投影（audit 可见性第二段） */
  findPresentSourceEntryId(householdId: string, mediaId: string): { id: string } | undefined;
  /** 按 (householdId, mediaItemId) 读播放资源 id 投影（audit 可见性第三段） */
  findPlaybackSourceIdByMedia(householdId: string, mediaId: string): { id: string } | undefined;
  /** 按 (householdId, id) 读媒体整行（readTrustedMediaFacts 的策略事实读取器） */
  findMediaItemRowInHousehold(householdId: string, mediaId: string): MediaItemRow | undefined;
  /** 按 (householdId, id) 读媒体 type 投影（readTrustedMediaType；startMode 透传校验用） */
  findMediaItemType(householdId: string, mediaId: string): { type: string } | undefined;
  /** 按档案 id 读策略行 profileId 投影（backfill 的既有行检查；含损坏行不触碰） */
  findProfilePolicyProfileId(profileId: string): { profileId: string } | undefined;
  /** 默认策略行补种（onConflictDoNothing：竞态下另一请求已回填则收敛，不覆盖） */
  insertProfilePolicyOnConflictNothing(values: ProfilePolicyDefaultInsert): void;
  /** 家庭可用资源候选（present 条目 × 启用父源 × 播放资源 join 链；逐字迁移） */
  listEnabledPlaybackResourceRows(householdId: string, mediaId: string): EnabledPlaybackResourceRow[];
  /**
   * 016 T019(US3 多线路):同 join 链同谓词的线路事实投影(resolve 在授权通过后读取,
   * 换线不得绕过授权管线)。零行 = 单线路/无线路语义(既有键面保持)。
   */
  listPlaybackLineRows(householdId: string, mediaId: string): PlaybackLineRow[];

  /* ---------- 审计（playback-audit.service 消费） ---------- */
  /** resolve 拒绝落 playback_failure_event（值集由 application 判定拼装） */
  insertFailureEvent(values: FailureEventInsert): void;

  /* ---------- 解析（playback-resolver.service 消费） ---------- */
  /** 会话媒体 ID 只读投影（resume 冻结读取；行缺失由调用方兜底空串） */
  findSessionMediaId(sessionId: string): { mediaId: string } | undefined;
  /** 会话捕获的上下文版本与设备会话绑定（identityContextCurrent 复查输入） */
  findSessionContextBinding(sessionId: string): { profileContextVersion: number; deviceSessionId: string } | undefined;

  /* ---------- 换代票撤销卫生层（playback-selection.service 消费） ---------- */
  /** 会话全部票行的 (id, revokedAt) 投影（撤销幂等跳过判定） */
  listSessionTicketRows(sessionId: string): Array<{ id: string; revokedAt: string | null }>;

  /* ---------- 票据校验（playback-ticket.service 消费） ---------- */
  /** 按 token hash 读票据整行（明文不入库，hash 由 application 以 hashToken 计算） */
  findTicketRowByTokenHash(tokenHash: string): TicketRow | undefined;
  /** 按 id 读播放会话整行（终态票门/家庭边界/设备绑定/实时 generation 的判定输入） */
  findPlaybackSessionRowById(sessionId: string): PlaybackSessionRow | undefined;
  /** 设备会话家庭投影（跨家庭 404 同形判定） */
  findDeviceSessionHouseholdId(deviceSessionId: string): { householdId: string } | undefined;

  /* ---------- 保留清理（playback-retention.service 消费） ---------- */
  /** occurred_at <= cutoff 的审计行删除（返回删除行数；恰好 30 天删/29 天留） */
  deleteFailureEventsAtOrBefore(cutoffIso: string): number;
  /** expires_at 严格早于 cutoff 的票行（恰好 cutoff 保留；活跃 session 保护由调用方承担） */
  listExpiredTicketRowsBefore(cutoffIso: string): Array<{ id: string; sessionId: string }>;
  /** 状态集合内的会话 id（活跃 session 票保护集合；states 由 application 传域常量） */
  listSessionIdsInStates(states: readonly string[]): string[];
  /** 按主键批量删票（先筛后删；返回删除行数） */
  deleteTicketsByIds(ids: readonly string[]): number;

  /* ---------- 装配桥接（playback.module 的 PlaybackConversionBridge 消费） ---------- */
  /** 指定会话指定代的活跃转换行（换代协同取消枚举；states 由调用方传域常量） */
  listActiveConversionRowsForGeneration(
    sessionId: string,
    generation: number,
    states: readonly string[],
  ): Array<{ id: string; householdId: string }>;
  /** 转换任务行状态投影（首产物等待臂的任务行终态兜底观察） */
  findConversionState(conversionId: string): { state: string; failureCode: string | null } | undefined;
  /** 会话归属家庭投影（换代资源回收键） */
  findSessionHouseholdId(sessionId: string): { householdId: string } | undefined;
}

/**
 * seam 槽（ADR-0015 D1）：未绑定即调用为编程错误（显式失败，不静默空转）；
 * 重复绑定幂等覆盖（测试 rig 在 Database 单例重开后重建需要）。
 */
let boundStore: PlaybackStore | null = null;

export function bindPlaybackStore(store: PlaybackStore): void {
  boundStore = store;
}

export function playbackStore(): PlaybackStore {
  if (boundStore === null) {
    throw new Error(
      'PLAYBACK_STORE 未绑定：playback 仓储端口需在模块装配（playback.module.ts）或测试 rig 中经 bindPlaybackStore 绑定（ADR-0015 D1 / 规格 008 FR-004）',
    );
  }
  return boundStore;
}
