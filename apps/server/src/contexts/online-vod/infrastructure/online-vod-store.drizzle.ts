/**
 * online-vod 仓储 Drizzle/better-sqlite3 实现（010 T027，ADR-0015 D1；T055 接管扩展导航序列读写）。
 *
 * 职责：
 * - OnlineVodStore（application/online-vod-store.port.ts，非事务读面）的绑定实现与
 *   装配/测试工厂 drizzleOnlineVodStore；
 * - T055 导航序列读写扩展（OnlineVodReadStatements 内，事务/非事务共享）：发布比对
 *   基线 listLatestEpisodeSequences、当前快照 listCurrentEpisodeSequences(ByLine)、
 *   行级幂等守卫 findEpisodeSequenceAtRevision（INSERT 仍走 T016 参与者,按
 *   detail_revision 快照落行、无行级唯一）——消费方为 application/episode-sequence.service.ts
 *   的 publishSequence/nextEpisodeFor;
 * - 事务参与者（infrastructure/transaction-participants.ts，T016/T027）与本实现
 *   **共享同一份查询原语**：行投影 SQL 常量 + OnlineVodSqlExecutor 执行面 +
 *   OnlineVodReadStatements 只读基类 —— 事务内（TransactionBinding）与非事务
 *   （Database.db 原生连接）同一语句文本、同一谓词、同一投影，去重不失语义；
 * - T084 保留清扫持久原语（DrizzleVodRetentionStore + 工厂 drizzleVodRetentionStore）：
 *   application/vod-retention.service.ts 声明的 VodRetentionStore 结构端口实现 ——
 *   过期行回收（登记候选/物化 operation/偏好 operation）与 24h 窗满标题组的引用图
 *   整组删除（逐删除带保护谓词；BEGIN IMMEDIATE 单组短事务；foreign_keys=ON 依赖序）。
 *
 * 实现形态：与 transaction-participants（T016）同款 —— better-sqlite3 原生 prepared
 * statements，SELECT 以列别名投影端口行类型（camelCase，$inferSelect 形状），列名逐一
 * 对照 schema.ts / migrations/0007_online_vod（DDL 权威）。语句与 T016 逐字保留
 * （T016 真实 DDL 冒烟通过的语义基准）；非事务读 = 单语句自动提交。
 *
 * 查询纪律（010 data-model §1/§2/§4、api.md §3/§7 I1）：
 * - 所有语句强制 household_id 条件（复合键/唯一键均带家庭）；全库过期行回收例外 ——
 *   expires_at 谓词自身限定回收面（行内 household_id 随行删除）；
 * - vod_detail_snapshot 只读（不可变，只 INSERT；当前指针 current_detail_revision 由
 *   VodParticipant 在事务内推进）；validated_private_payload 为私有载荷（含上游地址），
 *   绝不进公共 DTO/日志；
 * - 幂等查询只认 committed_at 非空的成功结果；不触碰他上下文私表（media_item /
 *   source_entry / playback_source 归各所有者 participant）—— T084 清理例外：整组
 *   删除按 data-model §4「按完整引用图清理」必须连带组内组员行（media_item vod 角色/
 *   media_relation/source_entry vod/playback_source online），全部语句经组媒体集合
 *   参数限定在标题组内，且删除组员前逐删除带七类引用 + §4 兜底保护谓词。
 */
import type DatabaseConstructor from 'better-sqlite3';
import { Database } from '@platform/database/database';
import type {
  MaterializationOperationRow,
  RegisteredCandidateRow,
  VodDetailSnapshotRow,
  VodEpisodeRow,
  VodEpisodeSequenceRow,
  VodLineRow,
  VodTitleRow,
} from '@contexts/online-vod/application/publication-work-set.port';
import type { OnlineVodStore } from '@contexts/online-vod/application/online-vod-store.port';
import type { EpisodeSequenceRowWithKey } from '@contexts/online-vod/application/episode-sequence.service';
import type {
  VodGroupRef,
  VodGroupReferenceMatrix,
  VodGroupSweepResult,
  VodRetentionStore,
} from '@contexts/online-vod/application/vod-retention.service';
import { MATERIALIZATION_RETENTION_MS } from '@contexts/online-vod/application/publication.service';

/* ------------------------------ 共享行投影（列别名 camelCase，与 $inferSelect 形状一致） ------------------------------ */

/** vod_title 行投影（列别名 camelCase，与 $inferSelect 形状一致） */
export const VOD_TITLE_SELECT = `
  SELECT
    id,
    household_id AS householdId,
    source_id AS sourceId,
    upstream_vod_id AS upstreamVodId,
    parent_media_id AS parentMediaId,
    current_detail_revision AS currentDetailRevision,
    materialized_at AS materializedAt
  FROM vod_title
`;

/** vod_line 行投影 */
export const VOD_LINE_SELECT = `
  SELECT
    id,
    household_id AS householdId,
    title_id AS titleId,
    line_key AS lineKey,
    display_name AS displayName,
    sort_order AS sortOrder
  FROM vod_line
`;

/** vod_episode 行投影 */
export const VOD_EPISODE_SELECT = `
  SELECT
    id,
    household_id AS householdId,
    line_id AS lineId,
    episode_key AS episodeKey,
    label,
    media_id AS mediaId,
    content_version_state AS contentVersionState,
    evidence_kind AS evidenceKind,
    evidence_digest AS evidenceDigest,
    schema_version AS schemaVersion,
    continuity_revision AS continuityRevision,
    continuity_signature AS continuitySignature
  FROM vod_episode
`;

/** vod_episode_sequence 行投影 */
export const VOD_EPISODE_SEQUENCE_SELECT = `
  SELECT
    household_id AS householdId,
    title_id AS titleId,
    line_id AS lineId,
    detail_revision AS detailRevision,
    sequence_revision AS sequenceRevision,
    episode_id AS episodeId,
    season_key AS seasonKey,
    ordinal,
    sequence_status AS sequenceStatus
  FROM vod_episode_sequence
`;

/**
 * vod_episode_sequence 导航行投影(T055;联出线键/集键/媒体身份):
 * 序列表只引用 line_id/episode_id,导航与发布比对需要 line_key/episode_key/media_id,
 * 经 vod_line/vod_episode 家庭复合联查读出(键原样透传,不改写)。
 */
export const VOD_EPISODE_SEQUENCE_WITH_KEY_SELECT = `
  SELECT
    s.household_id AS householdId,
    s.title_id AS titleId,
    s.line_id AS lineId,
    l.line_key AS lineKey,
    s.detail_revision AS detailRevision,
    s.sequence_revision AS sequenceRevision,
    s.episode_id AS episodeId,
    e.episode_key AS episodeKey,
    e.media_id AS mediaId,
    s.season_key AS seasonKey,
    s.ordinal,
    s.sequence_status AS sequenceStatus
  FROM vod_episode_sequence s
  JOIN vod_line l ON l.household_id = s.household_id AND l.id = s.line_id
  JOIN vod_episode e ON e.household_id = s.household_id AND e.id = s.episode_id
`;

/** vod_detail_snapshot 行投影 */
export const VOD_DETAIL_SNAPSHOT_SELECT = `
  SELECT
    household_id AS householdId,
    title_id AS titleId,
    revision,
    locator_revision AS locatorRevision,
    validated_private_payload AS validatedPrivatePayload,
    fetched_at AS fetchedAt,
    expires_at AS expiresAt
  FROM vod_detail_snapshot
`;

/** vod_materialization_operation 行投影 */
export const VOD_OPERATION_SELECT = `
  SELECT
    id,
    household_id AS householdId,
    device_session_id AS deviceSessionId,
    profile_id AS profileId,
    profile_context_version AS profileContextVersion,
    operation_key AS operationKey,
    request_digest AS requestDigest,
    parent_media_id AS parentMediaId,
    selected_media_id AS selectedMediaId,
    selected_content_revision AS selectedContentRevision,
    selected_continuity_revision AS selectedContinuityRevision,
    detail_revision AS detailRevision,
    catalog_revision AS catalogRevision,
    result,
    committed_at AS committedAt,
    expires_at AS expiresAt
  FROM vod_materialization_operation
`;

/** vod_registered_candidate 行投影 */
export const VOD_CANDIDATE_SELECT = `
  SELECT
    id,
    household_id AS householdId,
    device_session_id AS deviceSessionId,
    profile_id AS profileId,
    profile_context_version AS profileContextVersion,
    registered_candidate_ref AS registeredCandidateRef,
    candidate_ref AS candidateRef,
    source_session_id AS sourceSessionId,
    source_generation AS sourceGeneration,
    preview_revision AS previewRevision,
    target_media_id AS targetMediaId,
    target_content_revision AS targetContentRevision,
    target_continuity_revision AS targetContinuityRevision,
    target_detail_revision AS targetDetailRevision,
    materialization_operation_id AS materializationOperationId,
    created_at AS createdAt,
    expires_at AS expiresAt
  FROM vod_registered_candidate
`;

/* ------------------------------------ 共享执行面（事务绑定 ≅ 原生连接） ------------------------------------ */

/**
 * 共享语句执行面：TransactionBinding（platform/database/unit-of-work）的结构子集 ——
 * 事务参与者以其绑定直通，非事务读面以原生连接适配出同形执行器；
 * 读原语对两者无感知（同一语句、同一参数序、同一行投影）。
 */
export interface OnlineVodSqlExecutor {
  /** 同步执行写语句（读基类不用；参与者写面经同一执行器走绑定） */
  exec(sql: string, params?: readonly unknown[]): void;
  /** 同步取单行（无行返回 undefined） */
  get<Row>(sql: string, params?: readonly unknown[]): Row | undefined;
  /** 同步取全部行 */
  all<Row>(sql: string, params?: readonly unknown[]): Row[];
}

/** 原生连接 → 共享执行器（非事务读面；prepare 缓存交由 better-sqlite3 语句表） */
export function onlineVodExecutorOf(connection: DatabaseConstructor.Database): OnlineVodSqlExecutor {
  return {
    exec(sql: string, params: readonly unknown[] = []): void {
      connection.prepare(sql).run(...params);
    },
    get<Row>(sql: string, params: readonly unknown[] = []): Row | undefined {
      return connection.prepare(sql).get(...params) as Row | undefined;
    },
    all<Row>(sql: string, params: readonly unknown[] = []): Row[] {
      return connection.prepare(sql).all(...params) as Row[];
    },
  };
}

/** 惰性执行器：每次调用解析 Database.db（跟随 SQLite 单例 close/重开自动重建，不在构造期捕获句柄） */
function lazyOnlineVodExecutor(): OnlineVodSqlExecutor {
  return {
    exec(sql: string, params: readonly unknown[] = []): void {
      Database.db.prepare(sql).run(...params);
    },
    get<Row>(sql: string, params: readonly unknown[] = []): Row | undefined {
      return Database.db.prepare(sql).get(...params) as Row | undefined;
    },
    all<Row>(sql: string, params: readonly unknown[] = []): Row[] {
      return Database.db.prepare(sql).all(...params) as Row[];
    },
  };
}

/* ------------------------------------ 共享只读原语（事务/非事务同一实现） ------------------------------------ */

/**
 * online-vod 只读查询原语（T027）：OnlineVodStore 读面与事务参与者读面共享的唯一实现。
 * 语句全部带 household_id 条件；幂等查询只认 committed_at 非空。
 */
export class OnlineVodReadStatements {
  constructor(protected readonly sql: OnlineVodSqlExecutor) {}

  /* ---------- 稳定映射（vod_title） ---------- */

  findTitleMapping(householdId: string, sourceId: string, upstreamVodId: string): VodTitleRow | undefined {
    return this.sql.get<VodTitleRow>(
      `${VOD_TITLE_SELECT} WHERE household_id = ? AND source_id = ? AND upstream_vod_id = ?`,
      [householdId, sourceId, upstreamVodId],
    );
  }

  findTitle(householdId: string, titleId: string): VodTitleRow | undefined {
    return this.sql.get<VodTitleRow>(`${VOD_TITLE_SELECT} WHERE household_id = ? AND id = ?`, [householdId, titleId]);
  }

  findTitleByParentMedia(householdId: string, parentMediaId: string): VodTitleRow | undefined {
    return this.sql.get<VodTitleRow>(`${VOD_TITLE_SELECT} WHERE household_id = ? AND parent_media_id = ?`, [
      householdId,
      parentMediaId,
    ]);
  }

  /* ---------- 私有详情快照（vod_detail_snapshot；只读，不可变） ---------- */

  findCurrentDetailSnapshot(householdId: string, titleId: string): VodDetailSnapshotRow | undefined {
    // 当前指针 = vod_title.current_detail_revision（仅 VodParticipant.advanceCurrentDetailPointer
    // 在事务内推进）；快照行不可变，指针联查即当前快照。
    // 联查形态下投影需表限定（VOD_DETAIL_SNAPSHOT_SELECT 裸列名会与 vod_title 同名列歧义）
    return this.sql.get<VodDetailSnapshotRow>(
      `SELECT
        s.household_id AS householdId,
        s.title_id AS titleId,
        s.revision,
        s.locator_revision AS locatorRevision,
        s.validated_private_payload AS validatedPrivatePayload,
        s.fetched_at AS fetchedAt,
        s.expires_at AS expiresAt
       FROM vod_detail_snapshot s
       JOIN vod_title t ON t.household_id = s.household_id AND t.id = s.title_id
       WHERE s.household_id = ? AND s.title_id = ? AND s.revision = t.current_detail_revision`,
      [householdId, titleId],
    );
  }

  findDetailSnapshot(householdId: string, titleId: string, revision: number): VodDetailSnapshotRow | undefined {
    return this.sql.get<VodDetailSnapshotRow>(
      `${VOD_DETAIL_SNAPSHOT_SELECT} WHERE household_id = ? AND title_id = ? AND revision = ?`,
      [householdId, titleId, revision],
    );
  }

  /* ---------- 线路（vod_line） ---------- */

  findLine(householdId: string, lineId: string): VodLineRow | undefined {
    return this.sql.get<VodLineRow>(`${VOD_LINE_SELECT} WHERE household_id = ? AND id = ?`, [householdId, lineId]);
  }

  listLinesByTitle(householdId: string, titleId: string): VodLineRow[] {
    return this.sql.all<VodLineRow>(
      `${VOD_LINE_SELECT} WHERE household_id = ? AND title_id = ? ORDER BY sort_order, id`,
      [householdId, titleId],
    );
  }

  /* ---------- 子项（vod_episode） ---------- */

  findEpisode(householdId: string, episodeId: string): VodEpisodeRow | undefined {
    return this.sql.get<VodEpisodeRow>(`${VOD_EPISODE_SELECT} WHERE household_id = ? AND id = ?`, [
      householdId,
      episodeId,
    ]);
  }

  findEpisodeMapping(householdId: string, lineId: string, episodeKey: string): VodEpisodeRow | undefined {
    return this.sql.get<VodEpisodeRow>(
      `${VOD_EPISODE_SELECT} WHERE household_id = ? AND line_id = ? AND episode_key = ?`,
      [householdId, lineId, episodeKey],
    );
  }

  findEpisodeByMedia(householdId: string, mediaId: string): VodEpisodeRow | undefined {
    return this.sql.get<VodEpisodeRow>(`${VOD_EPISODE_SELECT} WHERE household_id = ? AND media_id = ?`, [
      householdId,
      mediaId,
    ]);
  }

  listEpisodesByLine(householdId: string, lineId: string): VodEpisodeRow[] {
    // 确定序=id；导航顺序语义以 vod_episode_sequence 为准（导航与身份分开）
    return this.sql.all<VodEpisodeRow>(`${VOD_EPISODE_SELECT} WHERE household_id = ? AND line_id = ? ORDER BY id`, [
      householdId,
      lineId,
    ]);
  }

  /* ---------- 导航序列（vod_episode_sequence；无行级唯一，行身份为 rowid） ---------- */

  listEpisodeSequences(householdId: string, lineId: string, sequenceRevision: number): VodEpisodeSequenceRow[] {
    return this.sql.all<VodEpisodeSequenceRow>(
      `${VOD_EPISODE_SEQUENCE_SELECT} WHERE household_id = ? AND line_id = ? AND sequence_revision = ? ORDER BY ordinal, episode_id`,
      [householdId, lineId, sequenceRevision],
    );
  }

  findEpisodeSequence(
    householdId: string,
    lineId: string,
    sequenceRevision: number,
    episodeId: string,
  ): VodEpisodeSequenceRow | undefined {
    return this.sql.get<VodEpisodeSequenceRow>(
      `${VOD_EPISODE_SEQUENCE_SELECT} WHERE household_id = ? AND line_id = ? AND sequence_revision = ? AND episode_id = ?`,
      [householdId, lineId, sequenceRevision, episodeId],
    );
  }

  /* ---------- 导航序列 T055 扩展(发布比对/当前快照/行级幂等守卫) ---------- */

  /**
   * 最新已发布导航快照(发布比对基准;T055 publishSequence):
   * 同标题最大 detail_revision 下、该修订下最大 sequence_revision 的全部行
   * (「sequenceRevision 与引用的 detailRevision 一同发布」——最新详情修订上的
   * 最新导航版本即当前已发布快照;键/媒体身份经联查读出)。确定序:line_id, ordinal,
   * episode_id。
   */
  listLatestEpisodeSequences(householdId: string, titleId: string): EpisodeSequenceRowWithKey[] {
    return this.sql.all<EpisodeSequenceRowWithKey>(
      `${VOD_EPISODE_SEQUENCE_WITH_KEY_SELECT}
       WHERE s.household_id = ? AND s.title_id = ?
         AND s.detail_revision = (
           SELECT MAX(x.detail_revision) FROM vod_episode_sequence x
           WHERE x.household_id = s.household_id AND x.title_id = s.title_id
         )
         AND s.sequence_revision = (
           SELECT MAX(y.sequence_revision) FROM vod_episode_sequence y
           WHERE y.household_id = s.household_id AND y.title_id = s.title_id
             AND y.detail_revision = s.detail_revision
         )
       ORDER BY s.line_id, s.ordinal, s.episode_id`,
      [householdId, titleId],
    );
  }

  /**
   * 当前导航快照(标题级导航;T055 nextEpisodeFor):
   * 当前详情指针修订(vod_title.current_detail_revision,仅 VodParticipant 在事务内
   * 推进)下、该指针下最大 sequence_revision 的全部行——「与 detailRevision 一同
   * 发布」的读侧对偶。确定序:line_id, ordinal, episode_id。
   */
  listCurrentEpisodeSequences(householdId: string, titleId: string): EpisodeSequenceRowWithKey[] {
    return this.sql.all<EpisodeSequenceRowWithKey>(
      `${VOD_EPISODE_SEQUENCE_WITH_KEY_SELECT}
       JOIN vod_title t ON t.household_id = s.household_id AND t.id = s.title_id
       WHERE s.household_id = ? AND s.title_id = ?
         AND s.detail_revision = t.current_detail_revision
         AND s.sequence_revision = (
           SELECT MAX(y.sequence_revision) FROM vod_episode_sequence y
           WHERE y.household_id = s.household_id AND y.title_id = s.title_id
             AND y.detail_revision = t.current_detail_revision
         )
       ORDER BY s.line_id, s.ordinal, s.episode_id`,
      [householdId, titleId],
    );
  }

  /**
   * 当前导航快照(线级;T055 nextEpisodeFor 线级消歧入口):
   * 同 listCurrentEpisodeSequences 谓词,范围收窄单线(标题指针经 s.title_id 联查,
   * 不经 vod_line 反查)。确定序:ordinal, episode_id。
   */
  listCurrentEpisodeSequencesByLine(householdId: string, lineId: string): EpisodeSequenceRowWithKey[] {
    return this.sql.all<EpisodeSequenceRowWithKey>(
      `${VOD_EPISODE_SEQUENCE_WITH_KEY_SELECT}
       JOIN vod_title t ON t.household_id = s.household_id AND t.id = s.title_id
       WHERE s.household_id = ? AND s.line_id = ?
         AND s.detail_revision = t.current_detail_revision
         AND s.sequence_revision = (
           SELECT MAX(y.sequence_revision) FROM vod_episode_sequence y
           WHERE y.household_id = s.household_id AND y.line_id = s.line_id
             AND y.detail_revision = t.current_detail_revision
         )
       ORDER BY s.ordinal, s.episode_id`,
      [householdId, lineId],
    );
  }

  /**
   * 行级幂等守卫(T055 publishSequence):同
   * (line, detail_revision, sequence_revision, episode) 的序列行已存在即跳过——
   * vod_episode_sequence 无行级唯一(行身份为 rowid),重复快照拦截在写入方。
   */
  findEpisodeSequenceAtRevision(
    householdId: string,
    lineId: string,
    detailRevision: number,
    sequenceRevision: number,
    episodeId: string,
  ): VodEpisodeSequenceRow | undefined {
    return this.sql.get<VodEpisodeSequenceRow>(
      `${VOD_EPISODE_SEQUENCE_SELECT}
       WHERE household_id = ? AND line_id = ? AND detail_revision = ? AND sequence_revision = ? AND episode_id = ?`,
      [householdId, lineId, detailRevision, sequenceRevision, episodeId],
    );
  }

  /* ---------- 物化幂等操作（vod_materialization_operation） ---------- */

  findCommittedOperation(
    householdId: string,
    deviceSessionId: string,
    profileContextVersion: number,
    operationKey: string,
  ): MaterializationOperationRow | undefined {
    // 仅 committed_at 非空可重放（committed_at IS NULL 表示未提交，不得返回）；
    // 24h 语义字段（committed_at/expires_at）随行投影返回
    return this.sql.get<MaterializationOperationRow>(
      `${VOD_OPERATION_SELECT}
       WHERE household_id = ? AND device_session_id = ? AND profile_context_version = ? AND operation_key = ?
         AND committed_at IS NOT NULL`,
      [householdId, deviceSessionId, profileContextVersion, operationKey],
    );
  }

  /* ---------- 登记候选映射（vod_registered_candidate） ---------- */

  findRegisteredCandidateByRef(householdId: string, registeredCandidateRef: string): RegisteredCandidateRow | undefined {
    return this.sql.get<RegisteredCandidateRow>(
      `${VOD_CANDIDATE_SELECT} WHERE household_id = ? AND registered_candidate_ref = ?`,
      [householdId, registeredCandidateRef],
    );
  }

  findRegisteredCandidateBySourceRef(
    householdId: string,
    materializationOperationId: string,
    candidateRef: string,
  ): RegisteredCandidateRow | undefined {
    // 010 收敛：唯一键列即规范命名 candidate_ref（别名旧列 source_candidate_ref 已删除）
    return this.sql.get<RegisteredCandidateRow>(
      `${VOD_CANDIDATE_SELECT} WHERE household_id = ? AND materialization_operation_id = ? AND candidate_ref = ?`,
      [householdId, materializationOperationId, candidateRef],
    );
  }

  findLatestRegisteredCandidateByCandidateRef(householdId: string, candidateRef: string): RegisteredCandidateRow | undefined {
    // api §7 I1「新 key 不得使用过期原候选」的非事务判定读：同家庭同原候选取
    // created_at 降序、id 降序最末行（确定序；同事务权威复核仍走工作集参与者）。
    return this.sql.get<RegisteredCandidateRow>(
      `${VOD_CANDIDATE_SELECT} WHERE household_id = ? AND candidate_ref = ?
       ORDER BY created_at DESC, id DESC LIMIT 1`,
      [householdId, candidateRef],
    );
  }
}

/* ------------------------------------ OnlineVodStore 绑定实现与工厂 ------------------------------------ */

/** online-vod 非事务读面绑定实现（共享读原语 + 惰性单例句柄；rig 可注入固定原生连接） */
class DrizzleOnlineVodStore extends OnlineVodReadStatements implements OnlineVodStore {
  constructor(raw?: DatabaseConstructor.Database) {
    // 缺省 Database.db 惰性函数引用（单例重开安全，不在构造期解析）；显式句柄用于测试 rig（内存库）
    super(raw === undefined ? lazyOnlineVodExecutor() : onlineVodExecutorOf(raw));
  }
}

/** 装配/测试工厂：缺省惰性解析（生产）；显式原生连接用于测试 rig（内存库） */
export function drizzleOnlineVodStore(raw?: DatabaseConstructor.Database): OnlineVodStore {
  return new DrizzleOnlineVodStore(raw);
}

/* ------------------------------------------------------------------ */
/* T084 保留清扫持久原语(VodRetentionStore 实现)                          */
/* ------------------------------------------------------------------ */

/**
 * SQL 片段载体(匿名 `?` 参数;better-sqlite3 按数组逐位绑定,语句占位符总数必须与
 * 值数一致 —— 片段拼接时值按出现顺序连接,占位符/值由同一构造路径产出,不错位)。
 */
interface SqlFrag {
  readonly sql: string;
  readonly values: readonly unknown[];
}

function frag(sql: string, ...values: readonly unknown[]): SqlFrag {
  return { sql, values };
}

/** AND/OR 拼接(每片段外层加括号;值数组按片段顺序连接,保持占位符/值一一对应) */
function joinFrags(parts: readonly SqlFrag[], separator: string): SqlFrag {
  return {
    sql: parts.map((part) => `(${part.sql})`).join(separator),
    values: parts.flatMap((part) => [...part.values]),
  };
}

/** 组媒体集合暂存表(temp;单连接单线程,清扫各拍先清后填,语句经其做成员判定) */
const GROUP_MEDIA_STAGE_TABLE = 'temp.vod_retention_group_media';

/**
 * 引用矩阵单类(组媒体集合口径;集合由调用方先暂存至 GROUP_MEDIA_STAGE_TABLE,成员
 * 判定独立于组员行删除顺序)。类目与 data-model §4 硬编码对照(见
 * application/vod-retention.service.ts 文件头矩阵):任何引用存在 → 整组保留。
 * 未过期幂等/候选以 expires_at > nowIso 判定(过期行已由「过期优先」阶段先行回收)。
 */
function referenceClassFrags(householdId: string, nowIso: string): ReadonlyArray<{
  readonly key: keyof VodGroupReferenceMatrix;
  readonly frag: SqlFrag;
}> {
  const inGroupSet = (colExpr: string): string =>
    `EXISTS (SELECT 1 FROM ${GROUP_MEDIA_STAGE_TABLE} gm WHERE gm.media_id = ${colExpr})`;
  return [
    {
      key: 'history',
      frag: frag(
        `EXISTS (SELECT 1 FROM profile_viewing_history h WHERE h.household_id = ? AND ${inGroupSet('h.media_id')})`,
        householdId,
      ),
    },
    {
      key: 'policyList',
      frag: frag(
        `EXISTS (
          SELECT 1 FROM profile_policy pp
          WHERE pp.household_id = ?
            AND (
              EXISTS (SELECT 1 FROM json_each(pp.allowed_media_ids) ja WHERE ${inGroupSet('ja.value')})
              OR EXISTS (SELECT 1 FROM json_each(pp.blocked_media_ids) jb WHERE ${inGroupSet('jb.value')})
            )
        )`,
        householdId,
      ),
    },
    {
      // 任意状态:活动(preparing/ready/playing/paused)与保留终态(ended/failed/interrupted)行同权保护
      key: 'session',
      frag: frag(`EXISTS (SELECT 1 FROM playback_session s WHERE s.household_id = ? AND ${inGroupSet('s.media_id')})`, householdId),
    },
    {
      // 任意状态:pending 与保留终态(consumed/cancelled/superseded/expired)行同权保护
      key: 'intent',
      frag: frag(
        `EXISTS (SELECT 1 FROM playback_transition_intent i WHERE i.household_id = ? AND ${inGroupSet('i.target_media_id')})`,
        householdId,
      ),
    },
    {
      key: 'materializationOperation',
      frag: frag(
        `EXISTS (
          SELECT 1 FROM vod_materialization_operation o
          WHERE o.household_id = ? AND o.expires_at > ?
            AND (${inGroupSet('o.parent_media_id')} OR ${inGroupSet('o.selected_media_id')})
        )`,
        householdId,
        nowIso,
      ),
    },
    {
      key: 'registeredCandidate',
      frag: frag(
        `EXISTS (
          SELECT 1 FROM vod_registered_candidate c
          WHERE c.household_id = ? AND c.expires_at > ? AND ${inGroupSet('c.target_media_id')}
        )`,
        householdId,
        nowIso,
      ),
    },
    {
      // 计划受引用保护(§10):被引用/未解绑计划行保留,其目标媒体随之受保护
      key: 'nextPlan',
      frag: frag(`EXISTS (SELECT 1 FROM playback_next_plan p WHERE p.household_id = ? AND ${inGroupSet('p.target_media_id')})`, householdId),
    },
    {
      // §4「其他持久引用」兜底:审计失败事件 / 会话 ledger / 频道收藏 / 手动 EPG 绑定
      key: 'otherPersistent',
      frag: joinFrags(
        [
          frag(`EXISTS (SELECT 1 FROM playback_failure_event f WHERE f.household_id = ? AND ${inGroupSet('f.media_id')})`, householdId),
          frag(`EXISTS (SELECT 1 FROM playback_progress_state l WHERE l.household_id = ? AND ${inGroupSet('l.media_id')})`, householdId),
          frag(`EXISTS (SELECT 1 FROM profile_channel_favorite fav WHERE fav.household_id = ? AND ${inGroupSet('fav.media_id')})`, householdId),
          frag(`EXISTS (SELECT 1 FROM manual_epg_binding mb WHERE mb.household_id = ? AND ${inGroupSet('mb.media_id')})`, householdId),
        ],
        ' OR ',
      ),
    },
  ];
}

/** 组媒体行级守卫(media_item 删除的七类 + 兜底逐行对照;alias.id 即行媒体身份) */
function mediaRowProtectionGuard(householdId: string, nowIso: string, alias: string): SqlFrag {
  return joinFrags(
    [
      frag(`NOT EXISTS (SELECT 1 FROM profile_viewing_history h WHERE h.household_id = ? AND h.media_id = ${alias}.id)`, householdId),
      frag(
        `NOT EXISTS (
          SELECT 1 FROM profile_policy pp
          WHERE pp.household_id = ?
            AND (
              EXISTS (SELECT 1 FROM json_each(pp.allowed_media_ids) ja WHERE ja.value = ${alias}.id)
              OR EXISTS (SELECT 1 FROM json_each(pp.blocked_media_ids) jb WHERE jb.value = ${alias}.id)
            )
        )`,
        householdId,
      ),
      frag(`NOT EXISTS (SELECT 1 FROM playback_session s WHERE s.household_id = ? AND s.media_id = ${alias}.id)`, householdId),
      frag(`NOT EXISTS (SELECT 1 FROM playback_transition_intent i WHERE i.household_id = ? AND i.target_media_id = ${alias}.id)`, householdId),
      frag(`NOT EXISTS (SELECT 1 FROM playback_next_plan p WHERE p.household_id = ? AND p.target_media_id = ${alias}.id)`, householdId),
      frag(
        `NOT EXISTS (
          SELECT 1 FROM vod_materialization_operation o
          WHERE o.household_id = ? AND o.expires_at > ?
            AND (o.parent_media_id = ${alias}.id OR o.selected_media_id = ${alias}.id)
        )`,
        householdId,
        nowIso,
      ),
      frag(
        `NOT EXISTS (
          SELECT 1 FROM vod_registered_candidate c
          WHERE c.household_id = ? AND c.expires_at > ? AND c.target_media_id = ${alias}.id
        )`,
        householdId,
        nowIso,
      ),
      frag(`NOT EXISTS (SELECT 1 FROM playback_failure_event f WHERE f.household_id = ? AND f.media_id = ${alias}.id)`, householdId),
      frag(`NOT EXISTS (SELECT 1 FROM playback_progress_state l WHERE l.household_id = ? AND l.media_id = ${alias}.id)`, householdId),
      frag(`NOT EXISTS (SELECT 1 FROM profile_channel_favorite fav WHERE fav.household_id = ? AND fav.media_id = ${alias}.id)`, householdId),
      frag(`NOT EXISTS (SELECT 1 FROM manual_epg_binding mb WHERE mb.household_id = ? AND mb.media_id = ${alias}.id)`, householdId),
    ],
    ' AND ',
  );
}

/** VodRetentionStore Drizzle 实现(T084;真实 DDL,better-sqlite3 原生语句) */
export class DrizzleVodRetentionStore implements VodRetentionStore {
  /** 惰性句柄解析:缺省随 Database 单例重开重建;rig 注入固定原生连接 */
  private readonly resolveHandle: () => DatabaseConstructor.Database;

  constructor(raw?: DatabaseConstructor.Database) {
    this.resolveHandle = raw === undefined ? () => Database.db : () => raw;
  }

  private handle(): DatabaseConstructor.Database {
    return this.resolveHandle();
  }

  private prepare(sql: string): DatabaseConstructor.Statement {
    return this.handle().prepare(sql);
  }

  /** BEGIN IMMEDIATE 单组短事务;连接已处于事务中(rig/调用方事务内)则并入外层 */
  private inTx<T>(fn: () => T): T {
    const handle = this.handle();
    if (handle.inTransaction) {
      return fn();
    }
    return handle.transaction(fn).immediate();
  }

  /* ---------- 过期行回收(先过期幂等/候选;偏好 operation 不删偏好) ---------- */

  deleteExpiredRegisteredCandidates(nowIso: string): number {
    // 联合回收:自身 expires_at 已过,或其物化 operation 已过期(两保护期同事务提交、
    // 同为 24h,重叠窗口按并集回收);候选是 operation 的 FK 子行,必须先于 operation 删除
    return this.prepare(
      `DELETE FROM vod_registered_candidate
       WHERE expires_at <= ?
         OR materialization_operation_id IN (
           SELECT id FROM vod_materialization_operation WHERE expires_at <= ?
         )`,
    ).run(nowIso, nowIso).changes;
  }

  deleteExpiredMaterializationOperations(nowIso: string): number {
    // 仅过期行(固定 24h 保留、重放不延长);候选子行已先行(上一语句)
    return this.prepare('DELETE FROM vod_materialization_operation WHERE expires_at <= ?').run(nowIso).changes;
  }

  deleteExpiredPreferenceOperations(nowIso: string): number {
    // §10:清理过期 operation 不删偏好 —— profile_vod_preferences 不在本语句删除面
    return this.prepare('DELETE FROM profile_vod_preference_operation WHERE expires_at <= ?').run(nowIso).changes;
  }

  /* ---------- 24h 窗满标题组(清扫候选清单) ---------- */

  listVodGroupsPastProtection(cutoffIso: string): VodGroupRef[] {
    return this.prepare(
      `SELECT id AS titleId, household_id AS householdId, materialized_at AS materializedAt
       FROM vod_title WHERE materialized_at <= ?
       ORDER BY household_id, id`,
    ).all(cutoffIso) as VodGroupRef[];
  }

  /* ---------- 引用矩阵与单组清扫 ---------- */

  describeVodGroupReferences(group: VodGroupRef, nowIso: string): VodGroupReferenceMatrix {
    return this.inTx(() => {
      const captured = this.stageGroupMedia(group.householdId, group.titleId);
      if (captured === undefined) {
        return {
          history: false,
          policyList: false,
          session: false,
          intent: false,
          materializationOperation: false,
          registeredCandidate: false,
          nextPlan: false,
          otherPersistent: false,
        };
      }
      return this.readReferenceMatrix(group.householdId, nowIso);
    });
  }

  sweepVodGroup(group: VodGroupRef, nowMs: number): VodGroupSweepResult {
    return this.inTx(() => {
      const nowIso = new Date(nowMs).toISOString();
      const cutoffIso = new Date(nowMs - MATERIALIZATION_RETENTION_MS).toISOString();
      // 组事实捕获 + 组媒体集合暂存(事务内;矩阵判定与逐删除共用同一集合,独立于
      // 组员行删除顺序)。temp 表随事务回滚自动还原,下一拍先清后填。
      const captured = this.stageGroupMedia(group.householdId, group.titleId);
      // 组已消失(清单竞态/重复运行):无可清扫物,按窗内形态汇报(不入两计数)
      if (captured === undefined) {
        return 'window_active';
      }
      // 保护窗重验(事务内;恰好 24h 即可整组清理 —— data-model §4「至少 24h 后」)
      if (captured.materializedAt > cutoffIso) {
        return 'window_active';
      }
      // 引用矩阵重验(任一命中 → 整组保留,哪怕 24h 已过;data-model §4)
      const matrix = this.readReferenceMatrix(group.householdId, nowIso);
      if (
        matrix.history ||
        matrix.policyList ||
        matrix.session ||
        matrix.intent ||
        matrix.materializationOperation ||
        matrix.registeredCandidate ||
        matrix.nextPlan ||
        matrix.otherPersistent
      ) {
        return 'protected';
      }
      // ── FK 依赖序整组删除(逐删除带保护谓词;foreign_keys=ON 下全程不破坏 FK)──
      const inGroupSet = (colExpr: string): string =>
        `EXISTS (SELECT 1 FROM ${GROUP_MEDIA_STAGE_TABLE} gm WHERE gm.media_id = ${colExpr})`;
      // 1 导航序列(FK→title/line/episode)
      this.runGuarded(
        frag(
          `DELETE FROM vod_episode_sequence AS s
           WHERE s.household_id = ? AND s.title_id = ?`,
          group.householdId,
          group.titleId,
        ),
        nowIso,
      );
      // 2 私有详情快照(FK→title;(title,revision) 不可变行,整组随之退役)
      this.runGuarded(
        frag(
          `DELETE FROM vod_detail_snapshot AS d
           WHERE d.household_id = ? AND d.title_id = ?`,
          group.householdId,
          group.titleId,
        ),
        nowIso,
      );
      // 3 播放资源(FK→entry/media/episode;先于组员删除;直指本资源行的会话/输入绑定守卫)
      this.runGuarded(
        frag(
          `DELETE FROM playback_source AS ps
           WHERE ps.household_id = ? AND ${inGroupSet('ps.media_item_id')}
             AND NOT EXISTS (
               SELECT 1 FROM playback_session ss
               WHERE ss.household_id = ps.household_id AND ss.playback_source_id = ps.id
             )
             AND NOT EXISTS (
               SELECT 1 FROM playback_input_binding b
               WHERE b.household_id = ps.household_id AND b.playback_source_id = ps.id
             )`,
          group.householdId,
        ),
        nowIso,
      );
      // 4 在线条目(FK→media/source;present 权威随组退役)
      this.runGuarded(
        frag(`DELETE FROM source_entry AS se WHERE se.household_id = ? AND ${inGroupSet('se.media_id')}`, group.householdId),
        nowIso,
      );
      // 5 稳定子项(FK→line/media;成员资格经组线锚定)
      this.runGuarded(
        frag(
          `DELETE FROM vod_episode AS ve
           WHERE ve.household_id = ?
             AND EXISTS (
               SELECT 1 FROM vod_line vlg
               WHERE vlg.household_id = ve.household_id AND vlg.title_id = ? AND vlg.id = ve.line_id
             )`,
          group.householdId,
          group.titleId,
        ),
        nowIso,
      );
      // 6 父子关系(FK→media;组子项唯一父即本组父媒体)
      this.runGuarded(
        frag('DELETE FROM media_relation AS mr WHERE mr.household_id = ? AND mr.parent_id = ?', group.householdId, captured.parentMediaId),
        nowIso,
      );
      // 7 子媒体行(FK 目标:entry/source/episode/relation 已清;行级引用矩阵守卫)
      this.runGuarded(
        frag(
          `DELETE FROM media_item AS mi
           WHERE mi.household_id = ? AND mi.media_role = 'vod_episode' AND ${inGroupSet('mi.id')}`,
          group.householdId,
        ),
        nowIso,
        'mi',
      );
      // 8 线路(FK→title)
      this.runGuarded(
        frag(
          `DELETE FROM vod_line AS vl
           WHERE vl.household_id = ? AND vl.title_id = ?`,
          group.householdId,
          group.titleId,
        ),
        nowIso,
      );
      // 9 稳定映射(组根;窗守卫随删除重验 —— ID 不复用,无任何 sequence 重置)
      const titleDelete = this.runGuarded(
        frag(
          `DELETE FROM vod_title AS t
           WHERE t.household_id = ? AND t.id = ? AND t.materialized_at <= ?`,
          group.householdId,
          group.titleId,
          cutoffIso,
        ),
        nowIso,
      );
      // 10 父媒体行(vod_title 已先行解除其 parent_media_id FK 引用;行级引用矩阵守卫)
      this.runGuarded(
        frag('DELETE FROM media_item AS mp WHERE mp.household_id = ? AND mp.id = ?', group.householdId, captured.parentMediaId),
        nowIso,
        'mp',
      );
      return titleDelete === 1 ? 'deleted' : 'protected';
    });
  }

  /* ---------- 内部 ---------- */

  /**
   * 组媒体集合暂存(事务内调用;temp 表先清后填):父媒体 + 全部子媒体(经组线锚定,
   * 与清扫删除序无关)。返回标题行事实;标题行缺失(组已消失)返回 undefined。
   */
  private stageGroupMedia(
    householdId: string,
    titleId: string,
  ): { readonly materializedAt: string; readonly parentMediaId: string } | undefined {
    this.prepare('CREATE TEMP TABLE IF NOT EXISTS vod_retention_group_media (media_id TEXT PRIMARY KEY)').run();
    this.prepare(`DELETE FROM ${GROUP_MEDIA_STAGE_TABLE}`).run();
    const title = this.prepare(
      'SELECT id, materialized_at AS materializedAt, parent_media_id AS parentMediaId FROM vod_title WHERE household_id = ? AND id = ?',
    ).get(householdId, titleId) as
      | { readonly id: string; readonly materializedAt: string; readonly parentMediaId: string }
      | undefined;
    if (title === undefined) {
      return undefined;
    }
    const insert = this.prepare(`INSERT OR IGNORE INTO ${GROUP_MEDIA_STAGE_TABLE} (media_id) VALUES (?)`);
    insert.run(title.parentMediaId);
    const childMediaIds = this.prepare(
      `SELECT ge.media_id AS mediaId
       FROM vod_episode ge
       JOIN vod_line gl ON gl.household_id = ge.household_id AND gl.id = ge.line_id
       WHERE gl.household_id = ? AND gl.title_id = ?`,
    ).all(householdId, titleId) as ReadonlyArray<{ readonly mediaId: string }>;
    for (const row of childMediaIds) {
      insert.run(row.mediaId);
    }
    return { materializedAt: title.materializedAt, parentMediaId: title.parentMediaId };
  }

  /** 引用矩阵读数(暂存集合口径;单 SELECT 七类命名引用 + 兜底) */
  private readReferenceMatrix(householdId: string, nowIso: string): VodGroupReferenceMatrix {
    const classes = referenceClassFrags(householdId, nowIso);
    const columns = classes.map(({ key, frag: classFrag }) => `${classFrag.sql} AS ${key}`).join(',\n  ');
    const row = this.prepare(`SELECT\n  ${columns}`).get(
      ...classes.flatMap(({ frag: classFrag }) => [...classFrag.values]),
    ) as Record<keyof VodGroupReferenceMatrix, number>;
    return {
      history: (row.history ?? 0) !== 0,
      policyList: (row.policyList ?? 0) !== 0,
      session: (row.session ?? 0) !== 0,
      intent: (row.intent ?? 0) !== 0,
      materializationOperation: (row.materializationOperation ?? 0) !== 0,
      registeredCandidate: (row.registeredCandidate ?? 0) !== 0,
      nextPlan: (row.nextPlan ?? 0) !== 0,
      otherPersistent: (row.otherPersistent ?? 0) !== 0,
    };
  }

  /**
   * 带保护谓词的删除执行(逐删除带守卫):body(DELETE 语句 + 自身参数;values[0] 为
   * household_id)后拼接整组保护谓词(七类 + 兜底);mediaItemAlias 给定时再拼行级
   * 引用矩阵守卫。返回 SQLite changes(删除行数;D10 以 1 判定整组删除成立)。
   */
  private runGuarded(body: SqlFrag, nowIso: string, mediaItemAlias?: string): number {
    const householdId = body.values[0] as string;
    // DELETE 语句本体不可加括号参与布尔组合:直接顺序拼接 body AND 守卫谓词
    // (守卫 = 七类 + 兜底逐类取反:任一引用存在 → 整组保留)
    const guard = joinFrags(
      referenceClassFrags(householdId, nowIso).map(({ frag: classFrag }) => frag(`NOT ${classFrag.sql}`, ...classFrag.values)),
      ' AND ',
    );
    const rowGuard = mediaItemAlias === undefined ? undefined : mediaRowProtectionGuard(householdId, nowIso, mediaItemAlias);
    const sql = rowGuard === undefined ? `${body.sql} AND ${guard.sql}` : `${body.sql} AND ${guard.sql} AND ${rowGuard.sql}`;
    const values = [...body.values, ...guard.values, ...(rowGuard === undefined ? [] : [...rowGuard.values])];
    const changes = this.prepare(sql).run(...values).changes;
    return changes;
  }
}

/** T084 装配/测试工厂:缺省惰性解析(生产);显式原生连接用于测试 rig(内存/临时库) */
export function drizzleVodRetentionStore(raw?: DatabaseConstructor.Database): VodRetentionStore {
  return new DrizzleVodRetentionStore(raw);
}

