/**
 * playback 事务参与者(T016,同连接绑定实现)。
 *
 * 端口来源(本上下文 application,冻结于 T015):
 * contexts/playback/application/playback-work-set.port.ts ——
 * PlaybackSessionTx / InputBindingTx / TransitionIntentTx / TransitionSlotTx /
 * FinishReceiptTx / ObservationTx / NextPlanTx(§5)与读面
 * PlaybackTrustedFactsReader / TransitionSourceQualificationReader / PlaybackDeliveryFactReader。
 *
 * 与 UnitOfWork 的接合:装配期注册进 createUnitOfWork txStores(键 'playback'),
 * 每次 run 由平台以同一连接 TransactionBinding 调用工厂;全部方法同步执行,
 * 任何方法抛错即整体回滚。列名对照 schema.ts / migrations/0007_online_vod。
 *
 * CAS 语义说明:绑定面按 T008 契约仅含 exec/get/all(无 changes 计数),故
 * 「expected revision 命中才写」的 CAS 以同事务先读后判再写实现 —— BEGIN IMMEDIATE
 * 下本连接持写锁、无并发写者可插入读-写之间,读判写原子;判定失败即抛错,
 * 由工作集整体回滚(端口注释「冲突整体回滚」)。
 * probe 受信时长:probe 事实由 playback registry 运行时持有(§3 租约/引用),
 * 持久层无列,findSessionTrustedFacts 恒返回 null(未知),不以 0 冒充;
 * 运行时注入点归 T051+ 工作集组装。
 */
import type { TransactionBinding } from '@platform/database/unit-of-work';
import type {
  DeliveryFacts,
  FinishReceiptInsertValues,
  FinishReceiptRow,
  FinishReceiptTx,
  InputBindingInsertValues,
  InputBindingRow,
  InputBindingTx,
  NextPlanInsertValues,
  NextPlanRow,
  NextPlanTx,
  ObservationTx,
  PhaseObservationInsertValues,
  PhaseObservationRow,
  PlaybackDeliveryFactReader,
  PlaybackSessionRow,
  PlaybackSessionTx,
  PlaybackTrustedFactsReader,
  PreparingSessionInsert,
  SessionTrustedFacts,
  SourceQualificationFacts,
  TransitionIntentInsertValues,
  TransitionIntentRow,
  TransitionIntentTx,
  TransitionSlotRow,
  TransitionSlotTx,
  TransitionSourceQualificationReader,
} from '@contexts/playback/application/playback-work-set.port';

/* ---------------------------------------------- 行投影(camelCase 别名,与 $inferSelect 一致) ---------------------------------------------- */

const PLAYBACK_SESSION_SELECT = `
  SELECT
    id,
    household_id AS householdId,
    device_session_id AS deviceSessionId,
    device_id AS deviceId,
    profile_id AS profileId,
    media_id AS mediaId,
    playback_source_id AS playbackSourceId,
    state,
    delivery,
    generation,
    version,
    position_seconds AS positionSeconds,
    audio_track_id AS audioTrackId,
    subtitle_track_id AS subtitleTrackId,
    desired_paused AS desiredPaused,
    profile_context_version AS profileContextVersion,
    playback_started_at AS playbackStartedAt,
    cleanup_requested AS cleanupRequested,
    cleanup_reason AS cleanupReason,
    cleanup_state AS cleanupState,
    created_at AS createdAt,
    started_at AS startedAt,
    ended_at AS endedAt,
    last_heartbeat_at AS lastHeartbeatAt,
    failure_code AS failureCode
  FROM playback_session
`;

const INPUT_BINDING_SELECT = `
  SELECT
    id,
    household_id AS householdId,
    session_id AS sessionId,
    generation,
    playback_source_id AS playbackSourceId,
    source_id AS sourceId,
    locator_revision AS locatorRevision,
    detail_revision AS detailRevision,
    content_revision AS contentRevision,
    continuity_revision AS continuityRevision,
    evidence_state AS evidenceState,
    evidence_digest AS evidenceDigest,
    resolved_input_id AS resolvedInputId,
    resolved_at AS resolvedAt,
    expires_at AS expiresAt,
    start_basis AS startBasis,
    frozen_start_seconds AS frozenStartSeconds,
    frozen_at AS frozenAt,
    cleanup_requested AS cleanupRequested,
    cleanup_reason AS cleanupReason,
    cleanup_state AS cleanupState
  FROM playback_input_binding
`;

const FINISH_RECEIPT_SELECT = `
  SELECT
    household_id AS householdId,
    session_id AS sessionId,
    device_session_id AS deviceSessionId,
    profile_context_version AS profileContextVersion,
    generation,
    operation_key AS operationKey,
    request_digest AS requestDigest,
    final_seq AS finalSeq,
    final_session_accepted AS finalSessionAccepted,
    history_applied AS historyApplied,
    history_revision AS historyRevision,
    session_completed AS sessionCompleted,
    auto_next_eligible AS autoNextEligible,
    reason,
    position_seconds AS positionSeconds,
    duration_seconds AS durationSeconds,
    ended_at AS endedAt,
    content_revision AS contentRevision,
    continuity_revision AS continuityRevision,
    locator_revision AS locatorRevision
  FROM playback_finish_receipt
`;

const TRANSITION_INTENT_SELECT = `
  SELECT
    id,
    household_id AS householdId,
    from_session_id AS fromSessionId,
    from_generation AS fromGeneration,
    device_session_id AS deviceSessionId,
    profile_id AS profileId,
    profile_context_version AS profileContextVersion,
    action,
    target_media_id AS targetMediaId,
    target_content_revision AS targetContentRevision,
    target_continuity_revision AS targetContinuityRevision,
    target_locator_revision AS targetLocatorRevision,
    match_revision AS matchRevision,
    match_confidence AS matchConfidence,
    confirmed_ambiguous AS confirmedAmbiguous,
    position_mode AS positionMode,
    carry_position_seconds AS carryPositionSeconds,
    carry_duration_seconds AS carryDurationSeconds,
    source_ledger_seq AS sourceLedgerSeq,
    source_checkpoint_generation AS sourceCheckpointGeneration,
    source_checkpoint_seq AS sourceCheckpointSeq,
    allow_earlier_accepted_position AS allowEarlierAcceptedPosition,
    finish_receipt_id AS finishReceiptId,
    operation_key AS operationKey,
    request_digest AS requestDigest,
    slot_revision AS slotRevision,
    created_at AS createdAt,
    expires_at AS expiresAt,
    status,
    successor_id AS successorId,
    next_plan_id AS nextPlanId,
    plan_sequence_revision AS planSequenceRevision,
    plan_detail_revision AS planDetailRevision,
    plan_history_revision AS planHistoryRevision,
    plan_history_choice_required AS planHistoryChoiceRequired
  FROM playback_transition_intent
`;

const TRANSITION_SLOT_SELECT = `
  SELECT
    household_id AS householdId,
    from_session_id AS fromSessionId,
    from_generation AS fromGeneration,
    slot_revision AS slotRevision,
    status,
    active_intent_id AS activeIntentId,
    successor_session_id AS successorSessionId
  FROM playback_transition_slot
`;

const PHASE_OBSERVATION_SELECT = `
  SELECT
    household_id AS householdId,
    session_id AS sessionId,
    generation,
    event_seq AS eventSeq,
    digest,
    event_type AS eventType,
    position_seconds AS positionSeconds,
    playback_rate AS playbackRate,
    server_received_at AS serverReceivedAt,
    tail_anchor_position_seconds AS tailAnchorPositionSeconds,
    tail_anchor_time AS tailAnchorTime,
    delivered_seen AS deliveredSeen
  FROM playback_phase_observation
`;

const NEXT_PLAN_SELECT = `
  SELECT
    id,
    household_id AS householdId,
    device_session_id AS deviceSessionId,
    profile_id AS profileId,
    profile_context_version AS profileContextVersion,
    from_session_id AS fromSessionId,
    from_generation AS fromGeneration,
    action,
    ref,
    target_media_id AS targetMediaId,
    sequence_revision AS sequenceRevision,
    detail_revision AS detailRevision,
    target_content_revision AS targetContentRevision,
    target_continuity_revision AS targetContinuityRevision,
    target_locator_revision AS targetLocatorRevision,
    history_revision AS historyRevision,
    history_choice_required AS historyChoiceRequired,
    created_at AS createdAt,
    expires_at AS expiresAt
  FROM playback_next_plan
`;

/** 槽/意图 CAS 失败(应用层翻译 409;抛错即工作集整体回滚) */
function casConflict(message: string): Error {
  return new Error(`playback tx CAS conflict: ${message}`);
}

/**
 * playback 事务参与者绑定实现(会话/输入绑定/过渡意图与槽/回执/观测/下一集计划 + 读面)。
 */
export class DrizzlePlaybackTxParticipants
  implements
    PlaybackSessionTx,
    InputBindingTx,
    TransitionIntentTx,
    TransitionSlotTx,
    FinishReceiptTx,
    ObservationTx,
    NextPlanTx,
    PlaybackTrustedFactsReader,
    TransitionSourceQualificationReader,
    PlaybackDeliveryFactReader
{
  constructor(private readonly binding: TransactionBinding) {}

  /* -------------------------------- PlaybackSessionTx(会话行状态迁移) -------------------------------- */

  findSession(householdId: string, sessionId: string): PlaybackSessionRow | undefined {
    return this.binding.get<PlaybackSessionRow>(
      `${PLAYBACK_SESSION_SELECT} WHERE household_id = ? AND id = ?`,
      [householdId, sessionId],
    );
  }

  insertPreparingSession(values: PreparingSessionInsert): void {
    // preparing:source/delivery 允许 NULL(准备失败禁止补造);起播/终态/清理标记初值
    this.binding.exec(
      `INSERT INTO playback_session (
        id, household_id, device_session_id, device_id, profile_id, media_id,
        playback_source_id, state, delivery, generation, version,
        position_seconds, audio_track_id, subtitle_track_id, desired_paused,
        profile_context_version, playback_started_at, cleanup_requested, cleanup_reason, cleanup_state,
        created_at, started_at, ended_at, last_heartbeat_at, failure_code
      ) VALUES (?, ?, ?, ?, ?, ?, NULL, 'preparing', NULL, ?, ?, 0, NULL, NULL, 0, ?, NULL, 0, NULL, 'pending', ?, NULL, NULL, ?, NULL)`,
      [
        values.sessionId,
        values.householdId,
        values.deviceSessionId,
        values.deviceId,
        values.profileId,
        values.mediaId,
        values.generation,
        values.version,
        values.profileContextVersion,
        values.createdAt,
        values.lastHeartbeatAt,
      ],
    );
  }

  markSessionTerminal(
    householdId: string,
    sessionId: string,
    state: 'ended' | 'failed' | 'interrupted',
    failureCode: string | null,
    endedAt: string,
  ): void {
    // 终态不可复活:仅活动态可提交终态(WHERE 守卫);failed 的 failure_code 必填
    // 由 CHECK(playback_session_failure_code_check)落实,冲突即回滚
    this.binding.exec(
      `UPDATE playback_session SET state = ?, failure_code = ?, ended_at = ?
       WHERE household_id = ? AND id = ? AND state NOT IN ('ended', 'failed', 'interrupted')`,
      [state, failureCode, endedAt, householdId, sessionId],
    );
  }

  advanceGeneration(householdId: string, sessionId: string, expectedGeneration: number, nextGeneration: number): void {
    // generation 原子换绑(CAS):期望代次命中才推进并 version+1
    this.binding.exec(
      `UPDATE playback_session SET generation = ?, version = version + 1
       WHERE household_id = ? AND id = ? AND generation = ?`,
      [nextGeneration, householdId, sessionId, expectedGeneration],
    );
  }

  markPlaybackStartedAt(householdId: string, sessionId: string, startedAt: string): void {
    // 独立起播标记:仅首次设置(NULL → 值),与 ledger.session_started 分离
    this.binding.exec(
      `UPDATE playback_session SET playback_started_at = ?
       WHERE household_id = ? AND id = ? AND playback_started_at IS NULL`,
      [startedAt, householdId, sessionId],
    );
  }

  requestCleanup(householdId: string, sessionId: string, reason: string): void {
    // 持久清理标记:先阻止新票/新资产;网络与进程取消在 commit 后(应用层语义)
    this.binding.exec(
      `UPDATE playback_session SET cleanup_requested = 1, cleanup_reason = ?, cleanup_state = 'pending'
       WHERE household_id = ? AND id = ?`,
      [reason, householdId, sessionId],
    );
  }

  touchHeartbeat(householdId: string, sessionId: string, at: string): void {
    this.binding.exec(
      'UPDATE playback_session SET last_heartbeat_at = ? WHERE household_id = ? AND id = ?',
      [at, householdId, sessionId],
    );
  }

  /* -------------------------------- TransitionSourceQualificationReader / PlaybackDeliveryFactReader(读面) -------------------------------- */

  findSourceQualification(householdId: string, sessionId: string): SourceQualificationFacts | undefined {
    // 终态也可读合法来源上下文(§1 PlaybackTransitionSourcePort 读取面)
    return this.binding.get<SourceQualificationFacts>(
      `SELECT
        id AS sessionId,
        generation,
        state,
        delivery,
        ended_at AS endedAt,
        failure_code AS failureCode,
        profile_context_version AS profileContextVersion
       FROM playback_session
       WHERE household_id = ? AND id = ?`,
      [householdId, sessionId],
    );
  }

  findDeliveryFacts(householdId: string, sessionId: string): DeliveryFacts | undefined {
    return this.binding.get<DeliveryFacts>(
      `SELECT
        id AS sessionId,
        generation,
        state,
        delivery,
        playback_source_id AS playbackSourceId,
        playback_started_at AS playbackStartedAt
       FROM playback_session
       WHERE household_id = ? AND id = ?`,
      [householdId, sessionId],
    );
  }

  /* -------------------------------- PlaybackTrustedFactsReader(会话受信事实) -------------------------------- */

  findSessionTrustedFacts(householdId: string, sessionId: string): SessionTrustedFacts | undefined {
    // 会话 + 当前代输入绑定 + 媒体修订一次 JOIN 装载;绑定缺行(未 bind)时
    // source/locator/detail/continuity/startBasis 等为 NULL(资格判定输入)
    const row = this.binding.get<{
      sessionId: string;
      generation: number;
      state: PlaybackSessionRow['state'];
      delivery: PlaybackSessionRow['delivery'];
      playbackSourceId: string | null;
      sourceId: string | null;
      mediaId: string;
      mediaContentRevision: number;
      locatorRevision: number | null;
      detailRevision: number | null;
      contentRevision: number | null;
      continuityRevision: number | null;
      startBasis: InputBindingRow['startBasis'] | null;
      frozenStartSeconds: number | null;
    }>(
      `SELECT
        s.id AS sessionId,
        s.generation,
        s.state,
        s.delivery,
        s.playback_source_id AS playbackSourceId,
        b.source_id AS sourceId,
        s.media_id AS mediaId,
        mi.content_revision AS mediaContentRevision,
        b.locator_revision AS locatorRevision,
        b.detail_revision AS detailRevision,
        b.content_revision AS contentRevision,
        b.continuity_revision AS continuityRevision,
        b.start_basis AS startBasis,
        b.frozen_start_seconds AS frozenStartSeconds
       FROM playback_session s
       JOIN media_item mi ON mi.household_id = s.household_id AND mi.id = s.media_id
       LEFT JOIN playback_input_binding b
         ON b.household_id = s.household_id AND b.session_id = s.id AND b.generation = s.generation
       WHERE s.household_id = ? AND s.id = ?`,
      [householdId, sessionId],
    );
    if (row === undefined) {
      return undefined;
    }
    return {
      sessionId: row.sessionId,
      generation: row.generation,
      state: row.state,
      delivery: row.delivery,
      playbackSourceId: row.playbackSourceId,
      sourceId: row.sourceId,
      mediaId: row.mediaId,
      mediaContentRevision: row.mediaContentRevision,
      locatorRevision: row.locatorRevision,
      detailRevision: row.detailRevision,
      contentRevision: row.contentRevision,
      continuityRevision: row.continuityRevision,
      startBasis: row.startBasis,
      frozenStartSeconds: row.frozenStartSeconds,
      // probe 受信时长为运行时事实(playback registry),持久层无列,未知为 null
      probeDurationSeconds: null,
    };
  }

  /* -------------------------------- InputBindingTx(固定输入绑定) -------------------------------- */

  findActiveBinding(householdId: string, sessionId: string, generation: number): InputBindingRow | undefined {
    return this.binding.get<InputBindingRow>(
      `${INPUT_BINDING_SELECT} WHERE household_id = ? AND session_id = ? AND generation = ?`,
      [householdId, sessionId, generation],
    );
  }

  insertBinding(values: InputBindingInsertValues): void {
    // session/generation 唯一(唯一索引);resolved_input_id 私有不透明,入口 URL 不入库;
    // 010 收敛:cleanup_requested/cleanup_reason 省略即落列默认 0/NULL(0007 列面一致)
    this.binding.exec(
      `INSERT INTO playback_input_binding (
        id, household_id, session_id, generation, playback_source_id, source_id,
        locator_revision, detail_revision, content_revision, continuity_revision,
        evidence_state, evidence_digest, resolved_input_id, resolved_at, expires_at,
        start_basis, frozen_start_seconds, cleanup_state
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending')`,
      [
        values.id,
        values.householdId,
        values.sessionId,
        values.generation,
        values.playbackSourceId,
        values.sourceId,
        values.locatorRevision,
        values.detailRevision,
        values.contentRevision,
        values.continuityRevision,
        values.evidenceState,
        values.evidenceDigest,
        values.resolvedInputId,
        values.resolvedAt,
        values.expiresAt,
        values.startBasis,
        values.frozenStartSeconds,
      ],
    );
  }

  freezeStartSeconds(householdId: string, bindingId: string, frozenStartSeconds: number | null): void {
    // probe 后仅冻结一次,无论取值(NULL 为合法冻结结果;010 data-model §6「本次probe后
    // 统一冻结一次位置」)。T042 freeze-NULL 缺口修复(选项 b):frozen_at 持久冻结标记
    // 由首次冻结落值,此后任何 freeze 调用不再写 —— 「已冻结为 NULL」与「尚未冻结」
    // 经持久列区分(跨连接/跨事务参与者实例),旧 `frozen_start_seconds IS NULL` 守卫
    // 在 NULL 冻结后失守的缺口自 0007 起由该列补齐。
    this.binding.exec(
      `UPDATE playback_input_binding SET frozen_start_seconds = ?, frozen_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
       WHERE household_id = ? AND id = ? AND frozen_at IS NULL`,
      [frozenStartSeconds, householdId, bindingId],
    );
  }

  markBindingCleanupComplete(householdId: string, bindingId: string): void {
    this.binding.exec(
      `UPDATE playback_input_binding SET cleanup_state = 'complete'
       WHERE household_id = ? AND id = ? AND cleanup_state = 'pending'`,
      [householdId, bindingId],
    );
  }

  /* -------------------------------- TransitionIntentTx(过渡意图) -------------------------------- */

  findIntentByOperationKey(
    householdId: string,
    deviceSessionId: string,
    profileContextVersion: number,
    operationKey: string,
  ): TransitionIntentRow | undefined {
    return this.binding.get<TransitionIntentRow>(
      `${TRANSITION_INTENT_SELECT}
       WHERE household_id = ? AND device_session_id = ? AND profile_context_version = ? AND operation_key = ?`,
      [householdId, deviceSessionId, profileContextVersion, operationKey],
    );
  }

  findIntent(householdId: string, intentId: string): TransitionIntentRow | undefined {
    return this.binding.get<TransitionIntentRow>(
      `${TRANSITION_INTENT_SELECT} WHERE household_id = ? AND id = ?`,
      [householdId, intentId],
    );
  }

  insertPendingIntent(values: TransitionIntentInsertValues): void {
    // 位置事实判别联合 → 列(carry 三件套/检查点;非 carry 必空,由 CHECK 落实);
    // next_plan 冻结快照随 plan 引用固定;TTL 从 createdAt 固定不续期
    const position = values.position;
    const carry = position.mode === 'carry' ? position : null;
    const allowEarlierParam =
      carry === null || carry.allowEarlierAcceptedPosition === null
        ? null
        : carry.allowEarlierAcceptedPosition
          ? 1
          : 0;
    const plan = values.plan;
    const planHistoryChoiceParam =
      plan === null || plan.historyChoiceRequired === null ? null : plan.historyChoiceRequired ? 1 : 0;
    this.binding.exec(
      `INSERT INTO playback_transition_intent (
        id, household_id, from_session_id, from_generation, device_session_id, profile_id,
        profile_context_version, action, target_media_id, target_content_revision,
        target_continuity_revision, target_locator_revision, match_revision, match_confidence,
        confirmed_ambiguous, position_mode, carry_position_seconds, carry_duration_seconds,
        source_ledger_seq, source_checkpoint_generation, source_checkpoint_seq,
        allow_earlier_accepted_position, finish_receipt_id, operation_key, request_digest,
        slot_revision, created_at, expires_at, status, successor_id,
        next_plan_id, plan_sequence_revision, plan_detail_revision, plan_history_revision, plan_history_choice_required
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', NULL, ?, ?, ?, ?, ?)`,
      [
        values.id,
        values.householdId,
        values.fromSessionId,
        values.fromGeneration,
        values.deviceSessionId,
        values.profileId,
        values.profileContextVersion,
        values.action,
        values.targetMediaId,
        values.targetContentRevision,
        values.targetContinuityRevision,
        values.targetLocatorRevision,
        values.matchRevision,
        values.matchConfidence,
        values.confirmedAmbiguous ? 1 : 0,
        position.mode,
        carry?.carryPositionSeconds ?? null,
        carry?.carryDurationSeconds ?? null,
        carry?.sourceLedgerSeq ?? null,
        carry?.sourceCheckpointGeneration ?? null,
        carry?.sourceCheckpointSeq ?? null,
        allowEarlierParam,
        values.finishReceiptId,
        values.operationKey,
        values.requestDigest,
        values.slotRevision,
        values.createdAt,
        values.expiresAt,
        plan?.nextPlanId ?? null,
        plan?.sequenceRevision ?? null,
        plan?.detailRevision ?? null,
        plan?.historyRevision ?? null,
        planHistoryChoiceParam,
      ],
    );
  }

  markIntentSuperseded(householdId: string, intentId: string): void {
    // pending 替换(显式 replace 语义);已 consumed/cancelled 不动
    this.binding.exec(
      `UPDATE playback_transition_intent SET status = 'superseded'
       WHERE household_id = ? AND id = ? AND status = 'pending'`,
      [householdId, intentId],
    );
  }

  markIntentConsumed(householdId: string, intentId: string, successorSessionId: string): void {
    // 消费提交:consumed + successorId(与槽 consume 同事务;失败整体回滚)
    this.binding.exec(
      `UPDATE playback_transition_intent SET status = 'consumed', successor_id = ?
       WHERE household_id = ? AND id = ? AND status = 'pending'`,
      [successorSessionId, householdId, intentId],
    );
  }

  markIntentCancelled(householdId: string, intentId: string): void {
    // 取消迁移:仅 pending 可取消;已输给消费( successId 非空)由读侧判定
    this.binding.exec(
      `UPDATE playback_transition_intent SET status = 'cancelled'
       WHERE household_id = ? AND id = ? AND status = 'pending'`,
      [householdId, intentId],
    );
  }

  /* -------------------------------- TransitionSlotTx(单后继槽) -------------------------------- */

  findSlot(householdId: string, fromSessionId: string, fromGeneration: number): TransitionSlotRow | undefined {
    return this.binding.get<TransitionSlotRow>(
      `${TRANSITION_SLOT_SELECT} WHERE household_id = ? AND from_session_id = ? AND from_generation = ?`,
      [householdId, fromSessionId, fromGeneration],
    );
  }

  ensureOpenSlot(householdId: string, fromSessionId: string, fromGeneration: number): number {
    // 首次建槽(slot_revision=1 open);已存在(任意状态)原样返回当前 revision,
    // open/reserved/consumed 的资格判定归 application(consumed 槽新 key 为 409 语义)
    const existing = this.findSlot(householdId, fromSessionId, fromGeneration);
    if (existing !== undefined) {
      return existing.slotRevision;
    }
    this.binding.exec(
      `INSERT INTO playback_transition_slot (household_id, from_session_id, from_generation, slot_revision, status)
       VALUES (?, ?, ?, 1, 'open')`,
      [householdId, fromSessionId, fromGeneration],
    );
    return 1;
  }

  reserveSlot(
    householdId: string,
    fromSessionId: string,
    fromGeneration: number,
    expectedSlotRevision: number,
    activeIntentId: string,
  ): number {
    const slot = this.findSlot(householdId, fromSessionId, fromGeneration);
    if (slot === undefined || slot.slotRevision !== expectedSlotRevision || slot.status !== 'open') {
      throw casConflict(
        `slot ${fromSessionId}#${fromGeneration} expected revision ${expectedSlotRevision}/open, got ${slot?.slotRevision ?? 'none'}/${slot?.status ?? 'none'}`,
      );
    }
    this.binding.exec(
      `UPDATE playback_transition_slot SET status = 'reserved', active_intent_id = ?, slot_revision = slot_revision + 1
       WHERE household_id = ? AND from_session_id = ? AND from_generation = ?`,
      [activeIntentId, householdId, fromSessionId, fromGeneration],
    );
    return expectedSlotRevision + 1;
  }

  consumeSlot(
    householdId: string,
    fromSessionId: string,
    fromGeneration: number,
    expectedSlotRevision: number,
    intentId: string,
    successorSessionId: string,
  ): void {
    const slot = this.findSlot(householdId, fromSessionId, fromGeneration);
    if (
      slot === undefined ||
      slot.slotRevision !== expectedSlotRevision ||
      slot.status !== 'reserved' ||
      slot.activeIntentId !== intentId
    ) {
      throw casConflict(
        `consume slot ${fromSessionId}#${fromGeneration} expected revision ${expectedSlotRevision}/reserved/${intentId}, got ${slot?.slotRevision ?? 'none'}/${slot?.status ?? 'none'}/${slot?.activeIntentId ?? 'none'}`,
      );
    }
    // consumed 永久:consumed 槽任何新 key 由读侧判 409;本写仅 reserved → consumed
    this.binding.exec(
      `UPDATE playback_transition_slot SET status = 'consumed', successor_session_id = ?, slot_revision = slot_revision + 1
       WHERE household_id = ? AND from_session_id = ? AND from_generation = ?`,
      [successorSessionId, householdId, fromSessionId, fromGeneration],
    );
  }

  releaseSlot(
    householdId: string,
    fromSessionId: string,
    fromGeneration: number,
    expectedSlotRevision: number,
  ): void {
    const slot = this.findSlot(householdId, fromSessionId, fromGeneration);
    if (slot === undefined || slot.slotRevision !== expectedSlotRevision || slot.status !== 'reserved') {
      throw casConflict(
        `release slot ${fromSessionId}#${fromGeneration} expected revision ${expectedSlotRevision}/reserved, got ${slot?.slotRevision ?? 'none'}/${slot?.status ?? 'none'}`,
      );
    }
    // cleanup 释放:reserved → open,pending intent 取消由用例同事务另行调用
    this.binding.exec(
      `UPDATE playback_transition_slot SET status = 'open', active_intent_id = NULL, slot_revision = slot_revision + 1
       WHERE household_id = ? AND from_session_id = ? AND from_generation = ?`,
      [householdId, fromSessionId, fromGeneration],
    );
  }

  /* -------------------------------- FinishReceiptTx(完成回执) -------------------------------- */

  findReceipt(householdId: string, sessionId: string): FinishReceiptRow | undefined {
    return this.binding.get<FinishReceiptRow>(
      `${FINISH_RECEIPT_SELECT} WHERE household_id = ? AND session_id = ?`,
      [householdId, sessionId],
    );
  }

  insertReceipt(values: FinishReceiptInsertValues): void {
    // session 唯一一份不可变终态(主键冲突即回滚);布尔列 0/1 落库;
    // 010 收敛:终态序号列即规范命名 final_seq(别名旧列 final_sample_seq 已自 0007 删除)
    this.binding.exec(
      `INSERT INTO playback_finish_receipt (
        household_id, session_id, device_session_id, profile_context_version, generation,
        operation_key, request_digest, final_seq, final_session_accepted,
        history_applied, history_revision, session_completed, auto_next_eligible,
        reason, position_seconds, duration_seconds, ended_at,
        content_revision, continuity_revision, locator_revision
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        values.householdId,
        values.sessionId,
        values.deviceSessionId,
        values.profileContextVersion,
        values.generation,
        values.operationKey,
        values.requestDigest,
        values.finalSeq,
        values.finalSessionAccepted ? 1 : 0,
        values.historyApplied ? 1 : 0,
        values.historyRevision,
        values.sessionCompleted ? 1 : 0,
        values.autoNextEligible ? 1 : 0,
        values.reason,
        values.positionSeconds,
        values.durationSeconds,
        values.endedAt,
        values.contentRevision,
        values.continuityRevision,
        values.locatorRevision,
      ],
    );
  }

  /* -------------------------------- ObservationTx(播放阶段观测) -------------------------------- */

  findObservation(householdId: string, sessionId: string, eventSeq: number): PhaseObservationRow | undefined {
    return this.binding.get<PhaseObservationRow>(
      `${PHASE_OBSERVATION_SELECT} WHERE household_id = ? AND session_id = ? AND event_seq = ?`,
      [householdId, sessionId, eventSeq],
    );
  }

  /**
   * T057 最小装配增量(phase-observation.service 锚语义重建面;端口文件已冻结不扩,
   * 具体参与者附加读投影 —— 与 PlaybackDeliveryFactReader 同文件同先例):
   * - findLatestObservation:最新一行 = 幂等游标(陈旧判定)+ 当前尾锚(成对);
   * - findLatestPlayingObservation:最新 playing 行 = 连续推进界比对基准
   *   (ratechange/重置类不入链,推进界按相邻两 playing 样本计算,finish.rules E5)。
   * 两读均为 (household,session) 复合键前缀 + LIMIT 1 有界查询,服务端事实只读。
   */
  findLatestObservation(householdId: string, sessionId: string): PhaseObservationRow | undefined {
    return this.binding.get<PhaseObservationRow>(
      `${PHASE_OBSERVATION_SELECT} WHERE household_id = ? AND session_id = ? ORDER BY event_seq DESC LIMIT 1`,
      [householdId, sessionId],
    );
  }

  findLatestPlayingObservation(householdId: string, sessionId: string): PhaseObservationRow | undefined {
    return this.binding.get<PhaseObservationRow>(
      `${PHASE_OBSERVATION_SELECT} WHERE household_id = ? AND session_id = ? AND event_type = 'playing' ORDER BY event_seq DESC LIMIT 1`,
      [householdId, sessionId],
    );
  }

  /**
   * T058 最小装配增量(finish 尾段判定 flush 面;端口文件已冻结不扩,具体参与者附加
   * 读投影 —— 与 findLatestObservation 同先例):按 event_seq 升序 flush 会话全部观测行,
   * 喂 finish.rules evaluateFinish/evaluateTailEligibility(data-model §5「finish前flush
   * 有序末段观测再提交final」;跨代样本的忽略归纯函数,不在此过滤)。
   * (household,session) 复合键前缀 + 全量升序,行域有界(观测为会话生命周期 2Hz 预算)。
   */
  listObservations(householdId: string, sessionId: string): PhaseObservationRow[] {
    return this.binding.all<PhaseObservationRow>(
      `${PHASE_OBSERVATION_SELECT} WHERE household_id = ? AND session_id = ? ORDER BY event_seq ASC`,
      [householdId, sessionId],
    );
  }

  /**
   * T058 最小装配增量(完成标记写;data-model §5「completed只由有效finish写或新实际
   * started重置」):finish 事务内在「接受 final→ledger→epoch 历史」后、与 receipt/
   * ended 同 commit 标记历史 completed=1。端口文件已冻结不扩(HistoryTx 仅 find/upsert,
   * upsert 语义=新实际活动重置 completed=0 —— 「只由有效finish写」的正向写无处承载),
   * 以具体参与者附加成员承载(与 findLatestObservation 装配增量同先例);仅当本会话是
   * 历史 owner(writer_playback_session_id 命中)才置位 —— 「绝不把其完成写到另设备
   * owner 历史」(superseded 会话 historyApplied=false,调用方本就不调用,守卫为纵深),
   * 幂等(重复 finish 由 receipt session_id 唯一收口,不会二次进入 evaluate 分支)。
   */
  markHistoryCompletedByFinishSession(householdId: string, profileId: string, mediaId: string, playbackSessionId: string): void {
    this.binding.exec(
      `UPDATE profile_viewing_history SET completed = 1
       WHERE household_id = ? AND profile_id = ? AND media_id = ? AND writer_playback_session_id = ?`,
      [householdId, profileId, mediaId, playbackSessionId],
    );
  }

  insertObservation(values: PhaseObservationInsertValues): void {
    // event_seq 幂等由主键落实(同 seq 冲突即回滚,重放比对归 application);
    // 尾锚 position/time 成对由 CHECK 落实;不写个人 ledger/历史
    this.binding.exec(
      `INSERT INTO playback_phase_observation (
        household_id, session_id, generation, event_seq, digest, event_type,
        position_seconds, playback_rate, server_received_at,
        tail_anchor_position_seconds, tail_anchor_time, delivered_seen
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        values.householdId,
        values.sessionId,
        values.generation,
        values.eventSeq,
        values.digest,
        values.eventType,
        values.positionSeconds,
        values.playbackRate,
        values.serverReceivedAt,
        values.tailAnchorPositionSeconds,
        values.tailAnchorTime,
        values.deliveredSeen ? 1 : 0,
      ],
    );
  }

  /* -------------------------------- NextPlanTx(下一集计划,§5) -------------------------------- */

  findPlan(householdId: string, nextPlanId: string): NextPlanRow | undefined {
    return this.binding.get<NextPlanRow>(
      `${NEXT_PLAN_SELECT} WHERE household_id = ? AND id = ?`,
      [householdId, nextPlanId],
    );
  }

  insertImmutablePlan(values: NextPlanInsertValues): void {
    // 不可变、TTL 60s 固定;无 slot/epoch 写;无历史 history_revision=0 由 CHECK 放行;
    // 010 收敛:ref 为数据模型 §10 计划对外引用(可空,由 application 生成后随行携带,
    // 未提供即 NULL —— 列位与 0007 对齐)
    this.binding.exec(
      `INSERT INTO playback_next_plan (
        id, household_id, device_session_id, profile_id, profile_context_version,
        from_session_id, from_generation, action, target_media_id,
        sequence_revision, detail_revision, target_content_revision, target_continuity_revision,
        target_locator_revision, history_revision, history_choice_required, created_at, expires_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        values.id,
        values.householdId,
        values.deviceSessionId,
        values.profileId,
        values.profileContextVersion,
        values.fromSessionId,
        values.fromGeneration,
        values.action,
        values.targetMediaId,
        values.sequenceRevision,
        values.detailRevision,
        values.targetContentRevision,
        values.targetContinuityRevision,
        values.targetLocatorRevision,
        values.historyRevision,
        values.historyChoiceRequired ? 1 : 0,
        values.createdAt,
        values.expiresAt,
      ],
    );
  }

  evictSurplusPlans(householdId: string, deviceSessionId: string, keepCount: number): void {
    // 每设备活计划上限淘汰:最早过期优先;被 pending/consumed intent 引用者不淘汰
    this.binding.exec(
      `DELETE FROM playback_next_plan
       WHERE household_id = ? AND device_session_id = ?
         AND id NOT IN (
           SELECT id FROM playback_next_plan
           WHERE household_id = ? AND device_session_id = ?
           ORDER BY expires_at ASC, created_at ASC, id ASC
           LIMIT ?
         )
         AND id NOT IN (
           SELECT next_plan_id FROM playback_transition_intent
           WHERE household_id = ? AND next_plan_id IS NOT NULL AND status IN ('pending', 'consumed')
         )`,
      [householdId, deviceSessionId, householdId, deviceSessionId, keepCount, householdId],
    );
  }
}

/** TxStore 工厂(装配期注册进 UnitOfWork txStores,键 'playback') */
export function createPlaybackTxParticipants(binding: TransactionBinding): DrizzlePlaybackTxParticipants {
  return new DrizzlePlaybackTxParticipants(binding);
}
