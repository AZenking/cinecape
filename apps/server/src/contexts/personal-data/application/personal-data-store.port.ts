/**
 * personal-data 仓储端口（008-repository-extraction T005，ADR-0015 D1）。
 *
 * 应用层数据访问的唯一合法形态：本文件定义纯 TS 端口接口 + 模块级 seam 槽；
 * Drizzle 实现位于 infrastructure/personal-data-store.drizzle.ts，由
 * personal-data.module.ts 装配期绑定（useFactory），单元测试 rig 经
 * bindPersonalDataStore 自行绑定。
 *
 * - 行类型经 `import type` 取自 @platform/database/schema（type-only 导入不产生
 *   依赖边，schema 保持单一事实源；depcruise 与 audit:purity 均放行）；
 * - 事务经 withTransaction 端口形态表达，事务句柄（tx）不越出 infrastructure；
 *   stop 协作路径的嵌套事务（调用方事务内 → savepoint）语义由实现侧
 *   getDb().transaction 透传原样保留；
 * - 方法签名与实现逐字对应既有查询（008 FR-002：SQL 构造与谓词逐字迁移）；
 * - 行→DTO/判定视图的映射留在 application（favorites/history 的摘要拼装、
 *   canResume/writeRight 判定不随查询下沉）。
 *
 * 010 T040 增量（data-model §5 会话 ledger 与 epoch 历史分离）：HistoryUpsertInput
 * 携带可选在线保存证据；PersonalDataTxStore 新增 applyLedgerSample（接受样本先更新
 * ledger 游标）与 findVodEpisodeEvidenceFacts（在线证据事实/静态媒体判别）。
 * 既有成员与语义零变化（favorites/history 路径不受影响）。
 */
import type {
  mediaItem,
  playbackProgressState,
  playbackSession,
  profileChannelFavorite,
  profileViewingHistory,
} from '@platform/database/schema';

export type FavoriteRow = typeof profileChannelFavorite.$inferSelect;
export type HistoryRow = typeof profileViewingHistory.$inferSelect;
export type ProgressStateRow = typeof playbackProgressState.$inferSelect;
export type PlaybackSessionRow = typeof playbackSession.$inferSelect;
export type MediaItemRow = typeof mediaItem.$inferSelect;

/** 键集分页锚点（favorites: (created_at, media_id) DESC；history: (last_viewed_at, media_id) DESC；双列严格后继） */
export interface KeysetAnchor {
  readonly sortAt: string;
  readonly mediaId: string;
}

/** 历史写入 upsert 输入(取得写入权/owner 继续;revision 由实现按既有行递增计算并返回) */
export interface HistoryUpsertInput {
  readonly householdId: string;
  readonly profileId: string;
  readonly mediaId: string;
  readonly candidateEpoch: number;
  readonly playbackSessionId: string;
  readonly sampleSeq: number;
  readonly contentRevision: number;
  readonly positionSeconds: number;
  readonly trustedDuration: number | null;
  readonly at: string;
  /**
   * 010 T040 在线证据(可选;data-model §5「保存产生时的内容/连续性修订及证据」):
   * - 省略(undefined)= 静态媒体旧义:INSERT 落 NULL、UPDATE 不动(旧静态行不冒充在线证据);
   * - 显式值 = 在线媒体保存证据:continuity_revision >= 1、evidence_state(unverified|verified)、
   *   evidence_digest(probe 证据摘要;与 ledger 同事务)。
   */
  readonly evidence?: HistoryEvidenceInput;
}

/** 在线保存证据值集(010 T040;仅在线媒体携带,静态媒体省略保持 NULL 旧义) */
export interface HistoryEvidenceInput {
  readonly continuityRevision: number;
  readonly evidenceState: 'unverified' | 'verified';
  readonly evidenceDigest: string;
}

/**
 * 会话 ledger 接受样本写入集(010 T040;data-model §5「新有效样本先更新 ledger,
 * 再按 epoch 决定历史」)。与 T016 SessionLedgerTx.applyAcceptedSample 值集同构
 * (差异:last_result 由结果簿记单独维护 —— duplicate 重放依赖原始结果记忆,
 * 见 progress-write.service 编排说明),本写仅接受分支,由应用层先读后判 stale。
 */
export interface LedgerSampleApplySet {
  readonly sampleSeq: number;
  readonly sampleDigest: string;
  readonly generation: number;
  readonly positionSeconds: number;
  /** 本次受信时长(已知必须 > 0;未知场景在应用层已 409,不以 0 冒充) */
  readonly durationSeconds: number | null;
  /** 接受样本时的子项连续性修订(静态媒体 1 基线) */
  readonly continuityRevision: number;
  /** 服务端接受时间(UTC ISO8601) */
  readonly acceptedAt: string;
  /** 会话是否已有已接受样本(列只升不降) */
  readonly sessionStarted: boolean;
}

/** 在线子项证据事实投影(010 T040;无 vod_episode 行 = 静态媒体,返回 undefined) */
export interface VodEpisodeEvidenceFacts {
  readonly contentVersionState: 'unverified' | 'verified';
  readonly evidenceDigest: string | null;
  readonly continuityRevision: number | null;
}

/** 状态簿记写入集（键集与迁移前 bookkeepState 的 .set() 一致；started 省略 = 不更新该列） */
export interface ProgressStateBookkeepingSet {
  readonly started?: 1;
  readonly lastSampleSeq: number;
  readonly lastSampleDigest: string;
  readonly lastGeneration: number;
  readonly lastResult: string;
}

/** resolve 绑定的 progress_state 行（键集与迁移前 bindVodResolveCandidate 的 insert 值一致） */
export interface ProgressStateInsertValues {
  readonly householdId: string;
  readonly playbackSessionId: string;
  readonly profileId: string;
  readonly mediaId: string;
  readonly candidateEpoch: number;
  readonly contentRevision: number;
  readonly profileContextVersion: number;
  readonly started: number;
  readonly lastSampleSeq: number;
  readonly lastSampleDigest: string | null;
  readonly lastGeneration: number;
  readonly lastResult: string | null;
}

/** 事务作用域内的表操作（progress 样本/stop final/resolve 绑定的事务块形态） */
export interface PersonalDataTxStore {
  findPlaybackSessionRow(householdId: string, sessionId: string): PlaybackSessionRow | undefined;
  findSessionGeneration(householdId: string, sessionId: string): number | undefined;
  findProgressStateRow(householdId: string, sessionId: string): ProgressStateRow | undefined;
  findHistoryRow(householdId: string, profileId: string, mediaId: string): HistoryRow | undefined;
  findMediaRow(householdId: string, mediaId: string): MediaItemRow | undefined;
  findMediaType(householdId: string, mediaId: string): string | undefined;
  findMediaContentRevision(householdId: string, mediaId: string): number | undefined;
  findMediaIdAndType(householdId: string, mediaId: string): { id: string; type: string } | undefined;
  /** 历史 upsert（INSERT ... ON CONFLICT DO UPDATE；返回实际写入的 revision） */
  upsertHistoryRow(input: HistoryUpsertInput): number;
  /** 状态簿记（seq/digest/started/last_result；仅接受路径推进序号） */
  updateProgressStateRow(householdId: string, sessionId: string, set: ProgressStateBookkeepingSet): void;
  /**
   * 会话 ledger 接受样本推进(010 T040;与历史同事务,应用层保证「先 ledger 后 epoch
   * 历史」):seq/digest/generation/continuity + ledger_position/duration/generation/
   * accepted_at 游标 + session_started 只升不降。stale/duplicate 不调用本写(零更新)。
   */
  applyLedgerSample(householdId: string, sessionId: string, values: LedgerSampleApplySet): void;
  /**
   * 在线子项证据事实读取(010 T040;按 household+media 唯一 vod_episode 投影)。
   * undefined = 静态媒体/无在线子项事实(时长历史兜底旧义保留、历史证据列保持 NULL)。
   */
  findVodEpisodeEvidenceFacts(householdId: string, mediaId: string): VodEpisodeEvidenceFacts | undefined;
  findProgressClockNextEpoch(householdId: string, profileId: string): number | undefined;
  /** clock 行不存在则建（nextEpoch = allocated + 1） */
  insertProgressClockRow(householdId: string, profileId: string, nextEpoch: number): void;
  /** next_epoch 原子自增（sql 模板 `next_epoch + 1`） */
  bumpProgressClockNextEpoch(householdId: string, profileId: string): void;
  insertProgressStateRow(values: ProgressStateInsertValues): void;
}

/** personal-data 上下文仓储端口（读路径 + 写路径 + 事务入口） */
export interface PersonalDataStore extends PersonalDataTxStore {
  /** 收藏键集分页（(created_at DESC, media_id DESC)；anchor = null 取首页） */
  listFavoriteRowsAfter(householdId: string, profileId: string, anchor: KeysetAnchor | null, limit: number): FavoriteRow[];
  /** 历史键集分页（(last_viewed_at DESC, media_id DESC)；anchor = null 取首页） */
  listHistoryRowsAfter(householdId: string, profileId: string, anchor: KeysetAnchor | null, limit: number): HistoryRow[];
  /** 批量媒体摘要行（同家庭 IN 查询；不可用媒体行缺失由 application 兜底） */
  listMediaRowsByIds(householdId: string, mediaIds: readonly string[]): MediaItemRow[];
  /** 历史可信时长兜底读取（按 household+media，不按 profile —— 与迁移前一致） */
  findHistoryDurationByMedia(householdId: string, mediaId: string): { durationSeconds: number | null } | undefined;
  /** INSERT OR IGNORE：主键三元组冲突时保留首行（created_at 首次收藏固定） */
  insertFavoriteRow(householdId: string, profileId: string, mediaId: string, createdAt: string): void;
  /** 按主键三元组删除（幂等；不校验可用性/类型） */
  deleteFavoriteRow(householdId: string, profileId: string, mediaId: string): void;
  withTransaction<T>(fn: (tx: PersonalDataTxStore) => T): T;
}

/**
 * seam 槽（ADR-0015 D1）：未绑定即调用为编程错误（显式失败，不静默空转）；
 * 重复绑定幂等覆盖（测试 rig 在 Database 单例重开后重建需要）。
 */
let boundStore: PersonalDataStore | null = null;

export function bindPersonalDataStore(store: PersonalDataStore): void {
  boundStore = store;
}

export function personalDataStore(): PersonalDataStore {
  if (boundStore === null) {
    throw new Error(
      'PERSONAL_DATA_STORE 未绑定：personal-data 仓储端口需在模块装配（personal-data.module.ts）或测试 rig 中经 bindPersonalDataStore 绑定（ADR-0015 D1 / 规格 008 FR-004）',
    );
  }
  return boundStore;
}
