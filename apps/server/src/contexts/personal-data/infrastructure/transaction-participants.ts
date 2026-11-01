/**
 * personal-data 事务参与者(T016,同连接绑定实现)。
 *
 * 端口归属说明:
 * - PreferenceTx / PreferenceOperationTx / PreferenceIdentityReader / PreferenceProfileReader
 *   来源于本上下文 application(preference-work-set.port.ts,T015 范围扩展文件,直接导入);
 * - SessionLedgerTx / HistoryTx / ProgressClockTx / PlaybackPersonalFactsReader 由 playback
 *   工作集端口文件声明、所有者标注为 personal-data(internal-ports.md §1
 *   SessionProgressPort / HistoryPort;§5 历史 revision 读取)。因 R2 跨上下文深导入
 *   禁令(import type 亦成边),该部分以**结构镜像类型**声明(逐字段一致,镜像源在
 *   注释标明),结构一致性由消费侧工作集装配处编译期强制。
 *
 * 与 UnitOfWork 的接合:装配期注册进 createUnitOfWork txStores(键 'personalData'),
 * 每次 run 由平台以同一连接 TransactionBinding 调用工厂;全部方法同步执行,
 * 任何方法抛错即整体回滚。列名对照 schema.ts(0006 五表 + 0007 偏好两表)。
 */
import type { TransactionBinding } from '@platform/database/unit-of-work';
import type {
  PreferenceOperationInsertValues,
  PreferenceOperationRow,
  PreferenceOperationTx,
  PreferenceTx,
  PreferenceUpdateValues,
  VodPreferencesSnapshot,
} from '@contexts/personal-data/application/preference-work-set.port';

/* -------------------- 跨上下文类型镜像(R2 禁深导入;源: playback playback-work-set.port.ts,所有者 personal-data) -------------------- */

/** 镜像 LedgerStateRow(playback_progress_state $inferSelect,010 ledger_* 扩展;
 * 010 收敛:游标列名随规范命名 ledger_position/ledger_duration 对齐 —— 别名旧列
 * ledger_position_seconds/ledger_duration_seconds 已自 0007 本体删除) */
export interface LedgerStateRowMirror {
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
  readonly continuityRevision: number;
  readonly ledgerPosition: number | null;
  readonly ledgerDuration: number | null;
  readonly ledgerGeneration: number | null;
  readonly ledgerAcceptedAt: string | null;
  readonly sessionStarted: number;
}

/** 镜像 SessionLedgerInsertValues(会话 ledger 首次建档值集) */
export interface SessionLedgerInsertValuesMirror {
  readonly householdId: string;
  readonly playbackSessionId: string;
  readonly profileId: string;
  readonly mediaId: string;
  readonly candidateEpoch: number;
  readonly contentRevision: number;
  readonly profileContextVersion: number;
  readonly lastGeneration: number;
  readonly continuityRevision: number;
  readonly lastResult: string | null;
}

/** 镜像 LedgerSampleApplyValues(已接受样本写入值集) */
export interface LedgerSampleApplyValuesMirror {
  readonly sampleSeq: number;
  readonly sampleDigest: string;
  readonly generation: number;
  readonly positionSeconds: number;
  readonly durationSeconds: number | null;
  readonly continuityRevision: number;
  readonly acceptedAt: string;
  readonly sessionStarted: boolean;
}

/** 镜像 SessionLedgerTx(会话 ledger 事务端口;所有者 personal-data) */
export interface SessionLedgerTxMirror {
  findLedgerRow(householdId: string, sessionId: string): LedgerStateRowMirror | undefined;
  insertLedgerRow(values: SessionLedgerInsertValuesMirror): void;
  applyAcceptedSample(householdId: string, sessionId: string, values: LedgerSampleApplyValuesMirror): void;
  /** 010 T040 增补:接受分支结果簿记(applyAcceptedSample 后由用例写入,见方法注) */
  recordSampleResult(householdId: string, sessionId: string, resultJson: string): void;
}

/** 镜像 HistoryApplyResult(历史写入结果) */
export interface HistoryApplyResultMirror {
  readonly applied: boolean;
  readonly revision: number;
}

/**
 * 镜像 HistoryUpsertValues(epoch 历史写入值集;与冻结端口逐字段一致 ——
 * 该值集原未携带 continuityRevision/evidenceDigest;010 T040 增补**可选**在线保存
 * 证据完整携带:缺省(undefined)= 旧义 INSERT NULL/UPDATE 不动;显式携带时与
 * ledger 同事务落库。可选字段保持结构一致:既有消费方(无该字段)继续相容)。
 */
export interface HistoryUpsertValuesMirror {
  readonly householdId: string;
  readonly profileId: string;
  readonly mediaId: string;
  readonly candidateEpoch: number;
  readonly playbackSessionId: string;
  readonly sampleSeq: number;
  readonly contentRevision: number;
  readonly positionSeconds: number;
  readonly trustedDuration: number | null;
  readonly evidenceState: 'unverified' | 'verified' | null;
  readonly at: string;
  /** 010 T040:保存产生时的子项连续性修订;缺省 = INSERT NULL/UPDATE 不动 */
  readonly continuityRevision?: number;
  /** 010 T040:在线保存证据摘要;缺省 = INSERT NULL/UPDATE 不动 */
  readonly evidenceDigest?: string;
}

/** 镜像 HistoryTx(epoch 历史事务端口;所有者 personal-data) */
export interface HistoryTxMirror {
  findHistoryRevision(householdId: string, profileId: string, mediaId: string): number;
  upsertHistoryWithEpoch(values: HistoryUpsertValuesMirror): HistoryApplyResultMirror;
}

/** 镜像 ProgressClockTx(点播写入权时钟;所有者 personal-data) */
export interface ProgressClockTxMirror {
  allocateProgressEpoch(householdId: string, profileId: string): number;
}

/** 镜像 TargetHistorySnapshot(目标历史快照) */
export interface TargetHistorySnapshotMirror {
  readonly revision: number;
  readonly positionSeconds: number;
  readonly durationSeconds: number | null;
  readonly completed: boolean;
  readonly evidenceState: 'unverified' | 'verified' | null;
}

/** 镜像 PlaybackPersonalFactsReader(个人事实读取;偏好快照形状与偏好端口一致) */
export interface PlaybackPersonalFactsReaderMirror {
  findVodPreferences(householdId: string, profileId: string): VodPreferencesSnapshot;
  findTargetHistory(householdId: string, profileId: string, mediaId: string): TargetHistorySnapshotMirror | undefined;
}

/* ---------------------------------------------- 行投影(camelCase 别名) ---------------------------------------------- */

const LEDGER_STATE_SELECT = `
  SELECT
    household_id AS householdId,
    playback_session_id AS playbackSessionId,
    profile_id AS profileId,
    media_id AS mediaId,
    candidate_epoch AS candidateEpoch,
    content_revision AS contentRevision,
    profile_context_version AS profileContextVersion,
    started,
    last_sample_seq AS lastSampleSeq,
    last_sample_digest AS lastSampleDigest,
    last_generation AS lastGeneration,
    last_result AS lastResult,
    continuity_revision AS continuityRevision,
    ledger_position AS ledgerPosition,
    ledger_duration AS ledgerDuration,
    ledger_generation AS ledgerGeneration,
    ledger_accepted_at AS ledgerAcceptedAt,
    session_started AS sessionStarted
  FROM playback_progress_state
`;

const PREFERENCE_OPERATION_SELECT = `
  SELECT
    id,
    household_id AS householdId,
    device_session_id AS deviceSessionId,
    profile_id AS profileId,
    profile_context_version AS profileContextVersion,
    operation_key AS operationKey,
    request_digest AS requestDigest,
    result_json AS resultJson,
    committed_at AS committedAt,
    expires_at AS expiresAt
  FROM profile_vod_preference_operation
`;

/**
 * personal-data 事务参与者绑定实现(会话 ledger/epoch 历史/时钟 + 偏好 CAS 与幂等操作)。
 */
export class DrizzlePersonalDataTxParticipants
  implements
    SessionLedgerTxMirror,
    HistoryTxMirror,
    ProgressClockTxMirror,
    PlaybackPersonalFactsReaderMirror,
    PreferenceTx,
    PreferenceOperationTx
{
  constructor(private readonly binding: TransactionBinding) {}

  /* -------------------------------- SessionLedgerTx(会话 ledger;所有者 personal-data) -------------------------------- */

  findLedgerRow(householdId: string, sessionId: string): LedgerStateRowMirror | undefined {
    return this.binding.get<LedgerStateRowMirror>(
      `${LEDGER_STATE_SELECT} WHERE household_id = ? AND playback_session_id = ?`,
      [householdId, sessionId],
    );
  }

  insertLedgerRow(values: SessionLedgerInsertValuesMirror): void {
    // session+epoch/完整 ledger 首次建档(与 session 创建同一用例事务,避免半建档);
    // 游标初值:seq=0、digest NULL、ledger_* NULL(未知不以 0 冒充)、started/session_started 0;
    // 010 收敛:游标列即规范命名 ledger_position/ledger_duration
    this.binding.exec(
      `INSERT INTO playback_progress_state (
        household_id, playback_session_id, profile_id, media_id, candidate_epoch,
        content_revision, profile_context_version, started, last_sample_seq, last_sample_digest,
        last_generation, last_result, continuity_revision, ledger_position,
        ledger_duration, ledger_generation, ledger_accepted_at, session_started
      ) VALUES (?, ?, ?, ?, ?, ?, ?, 0, 0, NULL, ?, ?, ?, NULL, NULL, NULL, NULL, 0)`,
      [
        values.householdId,
        values.playbackSessionId,
        values.profileId,
        values.mediaId,
        values.candidateEpoch,
        values.contentRevision,
        values.profileContextVersion,
        values.lastGeneration,
        values.lastResult,
        values.continuityRevision,
      ],
    );
  }

  applyAcceptedSample(householdId: string, sessionId: string, values: LedgerSampleApplyValuesMirror): void {
    // 接受样本推进 ledger 游标(seq/digest/generation/位置/时长/接受时间 + continuity);
    // stale 不更新由 application 先读后判(seq/digest 比对),本写仅接受分支;
    // last_result 清空(旧序号重试记忆随新样本失效);session_started 只升不降;
    // 010 收敛:游标列即规范命名 ledger_position/ledger_duration
    this.binding.exec(
      `UPDATE playback_progress_state SET
        last_sample_seq = ?,
        last_sample_digest = ?,
        last_generation = ?,
        last_result = NULL,
        continuity_revision = ?,
        ledger_position = ?,
        ledger_duration = ?,
        ledger_generation = ?,
        ledger_accepted_at = ?,
        session_started = MAX(session_started, ?)
       WHERE household_id = ? AND playback_session_id = ?`,
      [
        values.sampleSeq,
        values.sampleDigest,
        values.generation,
        values.continuityRevision,
        values.positionSeconds,
        values.durationSeconds,
        values.generation,
        values.acceptedAt,
        values.sessionStarted ? 1 : 0,
        householdId,
        sessionId,
      ],
    );
  }

  /**
   * 010 T040:接受分支结果簿记(编排顺序 ③)。
   * applyAcceptedSample 按其契约清空 last_result(旧序号重试记忆随游标推进失效);
   * 但 duplicate 幂等(api.md §1「duplicate 返回原存储结果」)需要保留「最新已接受
   * 样本」的结果记忆 —— 因此用例编排为:①ledger 游标(本方法)→ ②epoch 历史 →
   * ③本方法写入全量 8 键结果 JSON。仅接受分支调用(stale/duplicate 零写)。
   */
  recordSampleResult(householdId: string, sessionId: string, resultJson: string): void {
    this.binding.exec('UPDATE playback_progress_state SET last_result = ? WHERE household_id = ? AND playback_session_id = ?', [
      resultJson,
      householdId,
      sessionId,
    ]);
  }

  /* -------------------------------- HistoryTx(epoch 历史;所有者 personal-data) -------------------------------- */

  findHistoryRevision(householdId: string, profileId: string, mediaId: string): number {
    // 无历史 revision=0(CAS 基准初值,仅表示快照无历史)
    const row = this.binding.get<{ revision: number }>(
      'SELECT revision FROM profile_viewing_history WHERE household_id = ? AND profile_id = ? AND media_id = ?',
      [householdId, profileId, mediaId],
    );
    return row?.revision ?? 0;
  }

  upsertHistoryWithEpoch(values: HistoryUpsertValuesMirror): HistoryApplyResultMirror {
    // 按epoch可选历史:candidateEpoch < writer_epoch → 非写权所有者,applied=false 带
    // 当前 revision(superseded 判定归 application);epoch 持平/更高 → 写入 revision+1。
    // 时长 COALESCE 保留既有可信值(在线 probe 不回填/不清除全局历史时长);
    // 新活动重置 completed=0;continuity_revision/evidence_digest 为 T040 可选在线证据
    // (缺省 INSERT NULL/UPDATE 不动 —— 旧静态行不冒充在线证据;显式携带时与 ledger
    // 同事务落库);evidence_state 随值集落库(旧静态行 NULL 不冒充在线证据)
    const existing = this.binding.get<{ writerEpoch: number; revision: number }>(
      'SELECT writer_epoch AS writerEpoch, revision FROM profile_viewing_history WHERE household_id = ? AND profile_id = ? AND media_id = ?',
      [values.householdId, values.profileId, values.mediaId],
    );
    // 可选证据列(缺省 undefined = 不出现于语句,行为与 T016 原实现逐字一致)
    const evidenceInsertColumns = [
      ...(values.continuityRevision !== undefined ? ['continuity_revision'] : []),
      ...(values.evidenceDigest !== undefined ? ['evidence_digest'] : []),
    ];
    const evidenceInsertPlaceholders = evidenceInsertColumns.map(() => '?');
    const evidenceInsertParams = [
      ...(values.continuityRevision !== undefined ? [values.continuityRevision] : []),
      ...(values.evidenceDigest !== undefined ? [values.evidenceDigest] : []),
    ];
    const evidenceUpdateAssignments = [
      ...(values.continuityRevision !== undefined ? ['continuity_revision = ?'] : []),
      ...(values.evidenceDigest !== undefined ? ['evidence_digest = ?'] : []),
    ];
    const evidenceUpdateParams = [
      ...(values.continuityRevision !== undefined ? [values.continuityRevision] : []),
      ...(values.evidenceDigest !== undefined ? [values.evidenceDigest] : []),
    ];
    if (existing === undefined) {
      this.binding.exec(
        `INSERT INTO profile_viewing_history (
          household_id, profile_id, media_id, writer_epoch, writer_playback_session_id,
          last_sample_seq, content_revision, position_seconds, duration_seconds,
          last_viewed_at, revision${evidenceInsertColumns.length > 0 ? `, ${evidenceInsertColumns.join(', ')}` : ''}, evidence_state, completed
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1${evidenceInsertPlaceholders.length > 0 ? `, ${evidenceInsertPlaceholders.join(', ')}` : ''}, ?, 0)`,
        [
          values.householdId,
          values.profileId,
          values.mediaId,
          values.candidateEpoch,
          values.playbackSessionId,
          values.sampleSeq,
          values.contentRevision,
          values.positionSeconds,
          values.trustedDuration,
          values.at,
          ...evidenceInsertParams,
          values.evidenceState,
        ],
      );
      return { applied: true, revision: 1 };
    }
    if (values.candidateEpoch < existing.writerEpoch) {
      return { applied: false, revision: existing.revision };
    }
    this.binding.exec(
      `UPDATE profile_viewing_history SET
        writer_epoch = ?,
        writer_playback_session_id = ?,
        last_sample_seq = ?,
        content_revision = ?,
        position_seconds = ?,
        duration_seconds = COALESCE(?, duration_seconds),
        last_viewed_at = ?,
        revision = revision + 1,${evidenceUpdateAssignments.length > 0 ? `\n        ${evidenceUpdateAssignments.join(', ')},` : ''}
        evidence_state = ?,
        completed = 0
       WHERE household_id = ? AND profile_id = ? AND media_id = ?`,
      [
        values.candidateEpoch,
        values.playbackSessionId,
        values.sampleSeq,
        values.contentRevision,
        values.positionSeconds,
        values.trustedDuration,
        values.at,
        ...evidenceUpdateParams,
        values.evidenceState,
        values.householdId,
        values.profileId,
        values.mediaId,
      ],
    );
    return { applied: true, revision: existing.revision + 1 };
  }

  /* -------------------------------- ProgressClockTx(点播写入权时钟) -------------------------------- */

  allocateProgressEpoch(householdId: string, profileId: string): number {
    // 单语句原子分配:缺行建行(next_epoch=2,分配 1);有行自增;
    // RETURNING next_epoch-1 即本次分配值(可跳号不可重置;失败随事务回滚不消耗号)
    const row = this.binding.get<{ allocated: number }>(
      `INSERT INTO profile_progress_clock (household_id, profile_id, next_epoch) VALUES (?, ?, 2)
       ON CONFLICT(household_id, profile_id) DO UPDATE SET next_epoch = profile_progress_clock.next_epoch + 1
       RETURNING next_epoch - 1 AS allocated`,
      [householdId, profileId],
    );
    if (row === undefined) {
      throw new Error(`progress clock allocate failed: ${householdId}/${profileId}`);
    }
    return row.allocated;
  }

  /* -------------------------------- PlaybackPersonalFactsReader(个人事实读取) -------------------------------- */

  findVodPreferences(householdId: string, profileId: string): VodPreferencesSnapshot {
    // 无持久行返回传输初值 true/true/version=0(不偷偷落库)
    const row = this.binding.get<{ autoplayNext: number; switchCarryPosition: number; version: number }>(
      'SELECT autoplay_next AS autoplayNext, switch_carry_position AS switchCarryPosition, version FROM profile_vod_preferences WHERE household_id = ? AND profile_id = ?',
      [householdId, profileId],
    );
    if (row === undefined) {
      return { autoplayNext: true, switchCarryPosition: true, version: 0 };
    }
    return {
      autoplayNext: row.autoplayNext === 1,
      switchCarryPosition: row.switchCarryPosition === 1,
      version: row.version,
    };
  }

  findTargetHistory(householdId: string, profileId: string, mediaId: string): TargetHistorySnapshotMirror | undefined {
    const row = this.binding.get<{
      revision: number;
      positionSeconds: number;
      durationSeconds: number | null;
      completed: number;
      evidenceState: string | null;
    }>(
      `SELECT
        revision,
        position_seconds AS positionSeconds,
        duration_seconds AS durationSeconds,
        completed,
        evidence_state AS evidenceState
       FROM profile_viewing_history
       WHERE household_id = ? AND profile_id = ? AND media_id = ?`,
      [householdId, profileId, mediaId],
    );
    if (row === undefined) {
      return undefined;
    }
    return {
      revision: row.revision,
      positionSeconds: row.positionSeconds,
      durationSeconds: row.durationSeconds,
      completed: row.completed === 1,
      evidenceState: row.evidenceState === null ? null : (row.evidenceState as TargetHistorySnapshotMirror['evidenceState']),
    };
  }

  /* -------------------------------- PreferenceTx(偏好 CAS;本上下文端口) -------------------------------- */

  findPreferences(householdId: string, profileId: string): VodPreferencesSnapshot {
    return this.findVodPreferences(householdId, profileId);
  }

  updatePreferencesWithCas(values: PreferenceUpdateValues): VodPreferencesSnapshot | undefined {
    // CAS:expectedVersion 与持久行 version(无行约定 0)失配返回 undefined(用例判 409);
    // 至少一项偏好字段由 application 校验;version 服务端 +1(绝不写 0);
    // null 字段按「不覆盖」处理;同事务由工作集保证(先成功重放→CAS→写不可变响应)
    const row = this.binding.get<{ version: number; autoplayNext: number; switchCarryPosition: number }>(
      'SELECT version, autoplay_next AS autoplayNext, switch_carry_position AS switchCarryPosition FROM profile_vod_preferences WHERE household_id = ? AND profile_id = ?',
      [values.householdId, values.profileId],
    );
    if (row === undefined) {
      if (values.expectedVersion !== 0) {
        return undefined;
      }
      const nextAutoplay = values.autoplayNext === null ? true : values.autoplayNext;
      const nextSwitch = values.switchCarryPosition === null ? true : values.switchCarryPosition;
      this.binding.exec(
        'INSERT INTO profile_vod_preferences (household_id, profile_id, autoplay_next, switch_carry_position, version) VALUES (?, ?, ?, ?, 1)',
        [values.householdId, values.profileId, nextAutoplay ? 1 : 0, nextSwitch ? 1 : 0],
      );
      return { autoplayNext: nextAutoplay, switchCarryPosition: nextSwitch, version: 1 };
    }
    if (row.version !== values.expectedVersion) {
      return undefined;
    }
    const nextAutoplay = values.autoplayNext === null ? row.autoplayNext === 1 : values.autoplayNext;
    const nextSwitch = values.switchCarryPosition === null ? row.switchCarryPosition === 1 : values.switchCarryPosition;
    this.binding.exec(
      `UPDATE profile_vod_preferences SET autoplay_next = ?, switch_carry_position = ?, version = version + 1
       WHERE household_id = ? AND profile_id = ? AND version = ?`,
      [nextAutoplay ? 1 : 0, nextSwitch ? 1 : 0, values.householdId, values.profileId, values.expectedVersion],
    );
    return { autoplayNext: nextAutoplay, switchCarryPosition: nextSwitch, version: values.expectedVersion + 1 };
  }

  /* -------------------------------- PreferenceOperationTx(偏好幂等操作) -------------------------------- */

  findCommittedOperation(
    householdId: string,
    deviceSessionId: string,
    profileContextVersion: number,
    operationKey: string,
  ): PreferenceOperationRow | undefined {
    // 同 scope 已提交成功操作:命中即先成功重放(原样返回 result,不更新偏好版本)
    return this.binding.get<PreferenceOperationRow>(
      `${PREFERENCE_OPERATION_SELECT}
       WHERE household_id = ? AND device_session_id = ? AND profile_context_version = ? AND operation_key = ?`,
      [householdId, deviceSessionId, profileContextVersion, operationKey],
    );
  }

  recordCommittedOperation(values: PreferenceOperationInsertValues): void {
    // 仅成功操作占 key(与偏好 CAS 同 commit;失败分支不落本表)
    this.binding.exec(
      `INSERT INTO profile_vod_preference_operation (
        id, household_id, device_session_id, profile_id, profile_context_version,
        operation_key, request_digest, result_json, committed_at, expires_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        values.id,
        values.householdId,
        values.deviceSessionId,
        values.profileId,
        values.profileContextVersion,
        values.operationKey,
        values.requestDigest,
        values.resultJson,
        values.committedAt,
        values.expiresAt,
      ],
    );
  }
}

/** TxStore 工厂(装配期注册进 UnitOfWork txStores,键 'personalData') */
export function createPersonalDataTxParticipants(binding: TransactionBinding): DrizzlePersonalDataTxParticipants {
  return new DrizzlePersonalDataTxParticipants(binding);
}
