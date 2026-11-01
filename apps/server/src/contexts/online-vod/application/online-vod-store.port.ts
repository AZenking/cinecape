/**
 * online-vod 仓储端口（010 T027，ADR-0015 D1；对齐 sources-store.port.ts seam 惯例）。
 *
 * 本文件是应用层**非事务读面**的唯一合法形态：纯 TS 端口接口；
 * Drizzle/better-sqlite3 实现位于 infrastructure/online-vod-store.drizzle.ts，
 * 由 online-vod.module.ts 装配期绑定（useFactory）。事务读写面（VodParticipant /
 * MaterializationOperationStore / QuotaStore /
 * RegisteredCandidateParticipant）不在此处 —— 由 T015 publication-work-set.port.ts 声明、
 * infrastructure/transaction-participants.ts 经平台 UnitOfWork 同连接绑定（T016/T027）。
 *
 * 查询纪律（010 data-model §1/§2/§4、api.md §3/§7 I1，实现与消费方共同遵守）：
 * - 所有查询强制 household_id 条件（复合键均带家庭，唯一键都带家庭）；
 * - vod_detail_snapshot 为不可变快照（只 INSERT 不 UPDATE；当前指针
 *   current_detail_revision 由 VodParticipant.advanceCurrentDetailPointer 在事务内推进），
 *   读面只读；validated_private_payload 与全部上游地址为**私有载荷**，只供本上下文
 *   application 内部消费（详情 CAS / 物化 / T042 定位），绝不进入任何公共 DTO/日志；
 * - 幂等查询只认 committed_at 非空的成功结果（NULL=未提交，不得重放）；
 *   operation 行含 24h 语义字段（committed_at/expires_at，固定 24h 保留、重放不延长）；
 * - 不触碰他上下文私表：media_item / source_entry / playback_source 分别经
 *   media-catalog / sources 各自所有者 participant（发布工作集）或其上下文端口访问，
 *   本端口只读本上下文私表（vod_* / vod_materialization_operation /
 *   vod_registered_candidate）与共享投影行类型。
 *
 * - 行类型全部经 `import type` 取自 T015 publication-work-set.port.ts 的 schema 投影
 *   （type-only 单一事实源，$inferSelect 形状；零 ORM 泄漏到 application）。
 */
import type {
  MaterializationOperationRow,
  RegisteredCandidateRow,
  VodDetailSnapshotRow,
  VodEpisodeRow,
  VodEpisodeSequenceRow,
  VodLineRow,
  VodTitleRow,
} from '@contexts/online-vod/application/publication-work-set.port';

/**
 * online-vod 非事务读面仓储端口（供 T028 search/preview 与后续服务消费）。
 * 全部方法为单语句同步读（自动提交语义）；事务内重验一律走 MaterializeWorkSet
 * 各 Tx 参与者，不经本端口。
 */
export interface OnlineVodStore {
  /* ---------- 稳定映射（vod_title；(source, upstream_vod_id) 唯一、parent_media_id 唯一） ---------- */

  /** 按 (家庭, 来源, 上游 VOD ID) 查稳定映射（含 parent_media_id / current_detail_revision） */
  findTitleMapping(householdId: string, sourceId: string, upstreamVodId: string): VodTitleRow | undefined;
  /** 按家庭内 title 行 id 查稳定映射（titleRef 服务端绑定解析用） */
  findTitle(householdId: string, titleId: string): VodTitleRow | undefined;
  /** 按父媒体 id 查稳定映射（parent_media_id 家庭内唯一；定位/目录侧反查用） */
  findTitleByParentMedia(householdId: string, parentMediaId: string): VodTitleRow | undefined;

  /* ---------- 私有详情快照（vod_detail_snapshot；(title, revision) 唯一、不可变） ---------- */

  /**
   * 读 title 的**当前**详情快照（含私有 payload）：经 vod_title.current_detail_revision
   * 指针联查；指针未推进/快照缺失返回 undefined。载荷为私有（含上游地址），
   * 不进公共 DTO。
   */
  findCurrentDetailSnapshot(householdId: string, titleId: string): VodDetailSnapshotRow | undefined;
  /** 读指定修订详情快照（详情 CAS 基准；不可变行，只读） */
  findDetailSnapshot(householdId: string, titleId: string, revision: number): VodDetailSnapshotRow | undefined;

  /* ---------- 线路/分集/导航序列（带家庭） ---------- */

  /** 按家庭内线路 id 查线路行 */
  findLine(householdId: string, lineId: string): VodLineRow | undefined;
  /** 列 title 全部线路（display 顺序：sort_order, id） */
  listLinesByTitle(householdId: string, titleId: string): VodLineRow[];
  /** 按家庭内分集行 id 查分集 */
  findEpisode(householdId: string, episodeId: string): VodEpisodeRow | undefined;
  /** 按 (家庭, 线路, episode_key) 查子项映射（(line, episode_key) 唯一） */
  findEpisodeMapping(householdId: string, lineId: string, episodeKey: string): VodEpisodeRow | undefined;
  /** 按子媒体 id 查分集（media_id 家庭内唯一；播放/历史侧反查用） */
  findEpisodeByMedia(householdId: string, mediaId: string): VodEpisodeRow | undefined;
  /** 列线路全部子项（确定序：id；导航顺序以 vod_episode_sequence 为准，不入库排序语义） */
  listEpisodesByLine(householdId: string, lineId: string): VodEpisodeRow[];
  /**
   * 列指定导航序列修订的全部行（导航与身份分开：行身份为 rowid、无行级唯一，
   * 同一集可有多条不同 sequence_revision 快照；确定序：ordinal, episode_id）
   */
  listEpisodeSequences(householdId: string, lineId: string, sequenceRevision: number): VodEpisodeSequenceRow[];
  /** 读单条序列行（连续性复核投影；与 VodParticipant.findEpisodeSequence 同语义） */
  findEpisodeSequence(
    householdId: string,
    lineId: string,
    sequenceRevision: number,
    episodeId: string,
  ): VodEpisodeSequenceRow | undefined;

  /* ---------- 物化幂等操作（vod_materialization_operation；只认 committed_at 非空） ---------- */

  /**
   * 非事务幂等恢复：按唯一 (家庭, device_session, context_version, operation_key)
   * 读**已提交**成功结果（committed_at 非空；NULL=未提交不返回）。
   * 事务内同语义查询经 MaterializationOperationStore.findCommittedOperation。
   */
  findCommittedOperation(
    householdId: string,
    deviceSessionId: string,
    profileContextVersion: number,
    operationKey: string,
  ): MaterializationOperationRow | undefined;

  /* ---------- 登记候选映射（vod_registered_candidate；api.md §7 I1 查询面） ---------- */

  /** 由 registeredCandidateRef 反查登记映射（家庭内唯一；跨家庭/伪造 = undefined 交由用例判 404） */
  findRegisteredCandidateByRef(householdId: string, registeredCandidateRef: string): RegisteredCandidateRow | undefined;
  /** 按唯一键 (家庭, operation, 原 candidate_ref) 查登记映射（重放/恢复判定投影） */
  findRegisteredCandidateBySourceRef(
    householdId: string,
    materializationOperationId: string,
    candidateRef: string,
  ): RegisteredCandidateRow | undefined;
  /**
   * 由原 candidateRef 反查最新登记映射（api.md §7 I1「新 key 不得使用过期原候选」的
   * 非事务判定读：同家庭同原候选取 created_at/id 最末行；无任何登记 = undefined 交由
   * 用例按「绑定缺失 404 / 已登记但过期 410」区分）。
   */
  findLatestRegisteredCandidateByCandidateRef(householdId: string, candidateRef: string): RegisteredCandidateRow | undefined;
}

/**
 * 010 T090 knip 清理:原 bindOnlineVodStore/onlineVodStore seam 槽已删除——本上下文
 * 消费方全部经 DI(ONLINE_VOD_STORE 令牌/deps 注入)取 store,槽位无任何读者;
 * ONLINE_VOD_STORE 令牌装配(useFactory)不受影响。
 */
