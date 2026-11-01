/**
 * 过渡持久仓储 Drizzle 实现(010-online-vod T059,US3;ADR-0015 D1 infrastructure 角色)。
 *
 * 职责(T059 tasks.md 原文):slot/intent/receipt 持久查询、scope 幂等、60s 固定
 * TTL/24h 消费结果保护、持久 NextPlan 快照及 intent 引用保留;初始 revision=0/open
 * 只作响应默认(持久行 slot_revision>=1)。审查补充面:创建/消费校验所需的计划精确
 * 快照读取与每设备 20 活计划上限淘汰(引用保护)。
 *
 * 行为契约:apps/server/test/unit/playback/transition-store.spec.ts(真实 DDL+真实
 * store;[T059-*] 用例即本文件行为定义)。
 *
 * 实现形态(与 playback-input-store.drizzle(T042)/transaction-participants(T016)同款):
 * - better-sqlite3 原生 prepared statements,SELECT 以列别名投影 camelCase 行;
 * - 多写语句包 BEGIN IMMEDIATE 短事务(失败整体回滚);若调用时连接已处于事务中
 *   (uow run 内)则并入外层事务,不再嵌套 BEGIN(T043 组合根可按两种形态接线);
 * - CAS 语义:BEGIN IMMEDIATE 下本连接持写锁、无并发写者可插入读-写之间,读判写
 *   原子;CAS 失败以判别结果返回(端口面「返回新状态或冲突信号」),不抛非领域异常,
   * 由调用方(T060/T061)翻译稳定错误码;
 * - 时间全部 UTC ISO-8601 毫秒 Z(与迁移/事务参与者时间列同格式);ISO Z 串字典序
 *   即时间序,SQL 时间谓词按字符串比较同口径;
 * - TTL/状态机判定消费 @contexts/playback/domain/transition.rules(T054 纯函数,
 *   「TTL固定60s,重试不续期」「consumed槽永久不能再建立第二后继」),不重复实现。
 *
 * 契约钉面来源(与 T052 e2e 逐一对齐,实现不自创语义):
 * - B1:首键创建 expectedSlotRevision=0(「无槽行」响应默认)→ 槽行落库 reserved、
 *   slot_revision=1(持久>=1)、intent.slot_revision=1;
 * - B4:同 key 同摘要重放 200 同行不续 TTL(expires_at 不变)、同 key 异摘要 409
 *   IDEMPOTENCY_CONFLICT 判定输入;scope=家庭/DeviceSession/contextVersion/operationKey
 *   (0007 唯一索引 playback_transition_intent_scope_key);
 * - B5:显式替换 expected 命中 reserved 槽 → 旧 active intent 同事务 superseded、
 *   slot_revision+1;
 * - B6:陈旧/超前 expected → 槽 CAS 输家信号,零写入(不落 intent、槽不动);
 * - C1/D5:消费不 bump 槽 revision(仅替换/取消 bump);consumed 永久,任何新 key
 *   CAS 信号携带原 successorSessionId(api §5「附原后继引用(仅原上下文可见)」);
 * - D1/D4:取消成功/过期 → 槽 open+revision+1;重复取消/取消 superseded 不再改槽;
 * - A6:第 21 个活计划创建触发淘汰 —— 最早过期未保护计划解绑 ref(行保留:FK 引用
 *   完整性 + T062 清理面回收;解绑后 findByRef 与未知 ref 同形 404);被 pending/
 *   consumed intent 引用计划与本次新建计划受保护(data-model §10 引用保留);
 * - A3/§7「pending到期不晚于计划expiresAt与createdAt+60s较早者」:intent expiresAt =
 *   min(createdAt+60s, plan.expiresAt);夹出非正窗口(过期计划)即 410 NEXT_PLAN_EXPIRED。
 */
import type DatabaseConstructor from 'better-sqlite3';
import { ProblemCode } from '@hmp/shared';
import { Database } from '@platform/database/database';
import { DomainError } from '@platform/http-common/domain-error';
import { INTENT_TTL_SECONDS, intentExpiresAtMs, isIntentExpired } from '@contexts/playback/domain/transition.rules';
import type {
  ActiveNextPlanRow,
  NextPlanCreateValues,
  PlaybackTransitionStore,
  SourceBindingRow,
  SourceLedgerCheckpointRow,
  SourceSessionContextRow,
  TransitionConsumeOutcome,
  TransitionIntentCancelOutcome,
  TransitionIntentCreateOutcome,
  TransitionIntentCreateValues,
} from '@contexts/playback/application/playback-transition-store.port';
import type {
  FinishReceiptInsertValues,
  FinishReceiptRow,
  NextPlanFreezeSnapshot,
  NextPlanRow,
  TransitionIntentRow,
  TransitionSlotRow,
} from '@contexts/playback/application/playback-work-set.port';

/* ------------------------------------------------------------------ */
/* 语句常量(camelCase 投影;全部强制 household_id 条件)                   */
/* ------------------------------------------------------------------ */

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

/** 被活动意图(pending/consumed)引用而受保留保护的计划集合(data-model §10 引用保留) */
const ACTIVE_INTENT_REFERENCED_PLAN_IDS = `
  SELECT next_plan_id FROM playback_transition_intent
  WHERE household_id = ? AND next_plan_id IS NOT NULL AND status IN ('pending', 'consumed')
`;

/** UTC ISO-8601 毫秒 Z */
function iso(ms: number): string {
  return new Date(ms).toISOString();
}

/** 已消费结果保留窗(data-model §9「至少24h」;本层落实,调用方传 now 即可) */
const CONSUMED_RESULT_PROTECTION_MS = 24 * 3600 * 1000;

function parseMs(isoString: string): number {
  const ms = Date.parse(isoString);
  if (Number.isNaN(ms)) {
    throw new DomainError(500, ProblemCode.INTERNAL, '过渡持久层收到非 ISO 时刻入参');
  }
  return ms;
}

/* ------------------------------------------------------------------ */
/* store 实现                                                            */
/* ------------------------------------------------------------------ */

type HandleSource = () => DatabaseConstructor.Database;

class DrizzleTransitionStore implements PlaybackTransitionStore {
  private readonly handleSource: HandleSource;

  constructor(handleSource: HandleSource) {
    this.handleSource = handleSource;
  }

  private handle(): DatabaseConstructor.Database {
    return this.handleSource();
  }

  /** BEGIN IMMEDIATE 短事务;连接已处于事务中(uow run 内)则并入外层,不嵌套 BEGIN */
  private inTx<T>(fn: () => T): T {
    const handle = this.handle();
    if (handle.inTransaction) {
      return fn();
    }
    return handle.transaction(fn).immediate();
  }

  private prepare(sql: string): DatabaseConstructor.Statement {
    return this.handle().prepare(sql);
  }

  /* ---------- 下一集计划(playback_next_plan) ---------- */

  createNextPlan(values: NextPlanCreateValues, cap?: { readonly keepCount: number }): NextPlanRow {
    // TTL 60s 固定(不可变):expiresAt 只在创建时派生,此后任何读取不重算
    const expiresAt = iso(parseMs(values.createdAt) + INTENT_TTL_SECONDS * 1000);
    return this.inTx(() => {
      this.prepare(
        `INSERT INTO playback_next_plan (
          id, household_id, device_session_id, profile_id, profile_context_version,
          from_session_id, from_generation, action, ref, target_media_id,
          sequence_revision, detail_revision, target_content_revision, target_continuity_revision,
          target_locator_revision, history_revision, history_choice_required, created_at, expires_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run([
        values.id,
        values.householdId,
        values.deviceSessionId,
        values.profileId,
        values.profileContextVersion,
        values.fromSessionId,
        values.fromGeneration,
        values.action,
        values.ref,
        values.targetMediaId,
        values.sequenceRevision,
        values.detailRevision,
        values.targetContentRevision,
        values.targetContinuityRevision,
        values.targetLocatorRevision,
        values.historyRevision,
        values.historyChoiceRequired ? 1 : 0,
        values.createdAt,
        expiresAt,
      ]);
      if (cap !== undefined) {
        this.evictSurplusNextPlansTx(values.householdId, values.deviceSessionId, cap.keepCount, [values.id]);
      }
      const created = this.findNextPlanById(values.householdId, values.id);
      if (created === undefined) {
        throw new DomainError(500, ProblemCode.INTERNAL, '下一集计划落库后不可读(存储一致性失败)');
      }
      return created;
    });
  }

  /**
   * 每设备活计划上限淘汰(事务内):「活计划」= ref 未解绑且未过期;超出 keepCount 的
   * 最早过期者解绑 ref(行保留 —— FK 引用完整性 + 24h/TTL 清理面回收)。保护面:
   * protectedRefs(本次新建)与被 pending/consumed intent 引用的计划(data-model §10)。
   * 返回解绑行数。
   */
  private evictSurplusNextPlansTx(
    householdId: string,
    deviceSessionId: string,
    keepCount: number,
    protectedPlanIds: readonly string[],
  ): number {
    const nowIso = iso(Date.now());
    const liveCount = this.prepare(
      `SELECT COUNT(*) AS n FROM playback_next_plan
       WHERE household_id = ? AND device_session_id = ? AND ref IS NOT NULL AND expires_at > ?`,
    ).get(householdId, deviceSessionId, nowIso) as { n: number };
    const surplus = liveCount.n - keepCount;
    if (surplus <= 0) {
      return 0;
    }
    const protectedPlaceholders = protectedPlanIds.map(() => '?').join(', ');
    const result = this.prepare(
      `UPDATE playback_next_plan SET ref = NULL
       WHERE id IN (
         SELECT id FROM playback_next_plan
         WHERE household_id = ? AND device_session_id = ? AND ref IS NOT NULL
           AND id NOT IN (${protectedPlaceholders.length > 0 ? protectedPlaceholders : "''"})
           AND id NOT IN (${ACTIVE_INTENT_REFERENCED_PLAN_IDS})
         ORDER BY expires_at ASC, created_at ASC, id ASC
         LIMIT ?
       )`,
    ).run([
      householdId,
      deviceSessionId,
      ...protectedPlanIds,
      householdId,
      surplus,
    ]);
    return result.changes;
  }

  findNextPlanByRef(householdId: string, ref: string): NextPlanRow | undefined {
    // ref 已解绑(NULL)与不存在同形不可见(淘汰 ref 与随机 ref 404 同形)
    return this.prepare(`${NEXT_PLAN_SELECT} WHERE household_id = ? AND ref = ?`).get(householdId, ref) as
      | NextPlanRow
      | undefined;
  }

  findNextPlanById(householdId: string, nextPlanId: string): NextPlanRow | undefined {
    return this.prepare(`${NEXT_PLAN_SELECT} WHERE household_id = ? AND id = ?`).get(householdId, nextPlanId) as
      | NextPlanRow
      | undefined;
  }

  listActiveNextPlanRows(householdId: string, deviceSessionId: string, nowIso: string): ActiveNextPlanRow[] {
    const rows = this.prepare(
      `${NEXT_PLAN_SELECT}
       WHERE household_id = ? AND device_session_id = ? AND ref IS NOT NULL AND expires_at > ?
       ORDER BY expires_at ASC, created_at ASC, id ASC`,
    ).all(householdId, deviceSessionId, nowIso) as Omit<ActiveNextPlanRow, 'referencedByActiveIntent'>[];
    if (rows.length === 0) {
      return [];
    }
    // 引用保护标记:一次装载被活动意图引用的计划 id 集合(禁逐行 N+1)
    const referencedIds = new Set(
      (
        this.prepare(
          `SELECT next_plan_id AS id FROM playback_transition_intent
           WHERE household_id = ? AND next_plan_id IS NOT NULL AND status IN ('pending', 'consumed')`,
        ).all(householdId) as { id: string }[]
      ).map((row) => row.id),
    );
    return rows.map((row) => ({ ...row, referencedByActiveIntent: referencedIds.has(row.id) }));
  }

  /* ---------- 单后继槽(playback_transition_slot) ---------- */

  findSlot(householdId: string, fromSessionId: string, fromGeneration: number): TransitionSlotRow | undefined {
    return this.prepare(`${TRANSITION_SLOT_SELECT} WHERE household_id = ? AND from_session_id = ? AND from_generation = ?`).get(
      householdId,
      fromSessionId,
      fromGeneration,
    ) as TransitionSlotRow | undefined;
  }

  ensureOpenSlot(householdId: string, fromSessionId: string, fromGeneration: number): TransitionSlotRow {
    return this.inTx(() => {
      const existing = this.findSlot(householdId, fromSessionId, fromGeneration);
      if (existing !== undefined) {
        return existing;
      }
      // 首次建槽:持久行 revision=1、open(响应默认 0/open 只在无行时)
      this.prepare(
        `INSERT INTO playback_transition_slot (household_id, from_session_id, from_generation, slot_revision, status)
         VALUES (?, ?, ?, 1, 'open')`,
      ).run(householdId, fromSessionId, fromGeneration);
      const created = this.findSlot(householdId, fromSessionId, fromGeneration);
      if (created === undefined) {
        throw new DomainError(500, ProblemCode.INTERNAL, '过渡槽落库后不可读(存储一致性失败)');
      }
      return created;
    });
  }

  /* ---------- 过渡意图(playback_transition_intent)读取 ---------- */

  findIntentById(householdId: string, intentId: string): TransitionIntentRow | undefined {
    return this.prepare(`${TRANSITION_INTENT_SELECT} WHERE household_id = ? AND id = ?`).get(householdId, intentId) as
      | TransitionIntentRow
      | undefined;
  }

  findIntentByOperationKey(
    householdId: string,
    deviceSessionId: string,
    profileContextVersion: number,
    operationKey: string,
  ): TransitionIntentRow | undefined {
    return this.prepare(
      `${TRANSITION_INTENT_SELECT}
       WHERE household_id = ? AND device_session_id = ? AND profile_context_version = ? AND operation_key = ?`,
    ).get(householdId, deviceSessionId, profileContextVersion, operationKey) as TransitionIntentRow | undefined;
  }

  /* ---------- 意图创建 + 槽 CAS(单一事务) ---------- */

  createTransitionIntent(
    values: TransitionIntentCreateValues,
    expectedSlotRevision: number,
  ): TransitionIntentCreateOutcome {
    return this.inTx<TransitionIntentCreateOutcome>(() => {
      // 1) scope 幂等:同 key 先判重放/冲突,均不动槽、不新建(api §5「同 key 重放不续 TTL」)
      const existing = this.findIntentByOperationKey(
        values.householdId,
        values.deviceSessionId,
        values.profileContextVersion,
        values.operationKey,
      );
      if (existing !== undefined) {
        return existing.requestDigest === values.requestDigest
          ? { kind: 'replayed', intent: existing }
          : { kind: 'idempotency_conflict', existing };
      }

      // 2) TTL:min(createdAt+60s, plan.expiresAt)(api §7 较早者);非正窗口=过期计划
      const createdAtMs = parseMs(values.createdAt);
      const intentExpiryMs = intentExpiresAtMs(createdAtMs);
      const expiresAtMs =
        values.plan === null ? intentExpiryMs : Math.min(intentExpiryMs, parseMs(values.plan.expiresAt));
      if (expiresAtMs <= createdAtMs) {
        throw new DomainError(410, ProblemCode.NEXT_PLAN_EXPIRED, '下一集计划已过期,请重新获取计划');
      }

      // 3) 槽 CAS(expected=0 表示「尚无槽行」响应默认;命中 open/reserved 行按 revision CAS)
      const slot = this.findSlot(values.householdId, values.fromSessionId, values.fromGeneration);
      if (expectedSlotRevision === 0) {
        if (slot !== undefined) {
          return { kind: 'slot_conflict', expectedSlotRevision, slot };
        }
      } else {
        if (
          slot === undefined ||
          slot.slotRevision !== expectedSlotRevision ||
          slot.status === 'consumed'
        ) {
          return { kind: 'slot_conflict', expectedSlotRevision, slot };
        }
        // 显式替换:reserved 命中 → 旧 active intent 同事务标 superseded(B5;终态不可逆)
        if (slot.status === 'reserved' && slot.activeIntentId !== null) {
          this.markIntentSuperseded(values.householdId, slot.activeIntentId);
        }
      }
      const slotRevisionAfter = expectedSlotRevision === 0 ? 1 : expectedSlotRevision + 1;

      // 4) 插入 intent(槽 FK 先有 intent 行;plan 冻结快照随行固定)
      const plan: (NextPlanFreezeSnapshot & { readonly expiresAt: string }) | null = values.plan;
      const position = values.position;
      const carry = position.mode === 'carry' ? position : null;
      this.prepare(
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
      ).run([
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
        carry === null || carry.allowEarlierAcceptedPosition === null
          ? null
          : carry.allowEarlierAcceptedPosition
            ? 1
            : 0,
        values.finishReceiptId,
        values.operationKey,
        values.requestDigest,
        slotRevisionAfter,
        values.createdAt,
        iso(expiresAtMs),
        plan?.nextPlanId ?? null,
        plan?.sequenceRevision ?? null,
        plan?.detailRevision ?? null,
        plan?.historyRevision ?? null,
        plan === null ? null : plan.historyChoiceRequired ? 1 : 0,
      ]);

      // 5) 槽写面:首键 INSERT reserved/rev1;替换/再预留 CAS UPDATE(双保险 revision 谓词)
      if (expectedSlotRevision === 0) {
        this.prepare(
          `INSERT INTO playback_transition_slot (household_id, from_session_id, from_generation, slot_revision, status, active_intent_id)
           VALUES (?, ?, ?, 1, 'reserved', ?)`,
        ).run(values.householdId, values.fromSessionId, values.fromGeneration, values.id);
      } else {
        this.prepare(
          `UPDATE playback_transition_slot
           SET status = 'reserved', active_intent_id = ?, slot_revision = ?
           WHERE household_id = ? AND from_session_id = ? AND from_generation = ? AND slot_revision = ?`,
        ).run(values.id, slotRevisionAfter, values.householdId, values.fromSessionId, values.fromGeneration, expectedSlotRevision);
      }

      const intent = this.findIntentById(values.householdId, values.id);
      const slotAfter = this.findSlot(values.householdId, values.fromSessionId, values.fromGeneration);
      if (intent === undefined || slotAfter === undefined) {
        throw new DomainError(500, ProblemCode.INTERNAL, '过渡意图落库后不可读(存储一致性失败)');
      }
      return { kind: 'created', intent, slot: slotAfter };
    });
  }

  /* ---------- 意图终局原语(仅 pending 命中;终态不可逆) ---------- */

  markIntentSuperseded(householdId: string, intentId: string): number {
    return this.prepare(
      `UPDATE playback_transition_intent SET status = 'superseded'
       WHERE household_id = ? AND id = ? AND status = 'pending'`,
    ).run(householdId, intentId).changes;
  }

  markIntentCancelled(householdId: string, intentId: string): number {
    return this.prepare(
      `UPDATE playback_transition_intent SET status = 'cancelled'
       WHERE household_id = ? AND id = ? AND status = 'pending'`,
    ).run(householdId, intentId).changes;
  }

  markIntentExpired(householdId: string, intentId: string): number {
    return this.prepare(
      `UPDATE playback_transition_intent SET status = 'expired'
       WHERE household_id = ? AND id = ? AND status = 'pending'`,
    ).run(householdId, intentId).changes;
  }

  markIntentConsumed(householdId: string, intentId: string, successorSessionId: string): number {
    // consumed 永久无第二后继:仅 pending 可迁移,successor 一次定格
    return this.prepare(
      `UPDATE playback_transition_intent SET status = 'consumed', successor_id = ?
       WHERE household_id = ? AND id = ? AND status = 'pending'`,
    ).run(successorSessionId, householdId, intentId).changes;
  }

  /* ---------- 槽 CAS 原语(读判写原子;输家 undefined/无写入) ---------- */

  reserveSlot(
    householdId: string,
    fromSessionId: string,
    fromGeneration: number,
    expectedSlotRevision: number,
    activeIntentId: string,
  ): TransitionSlotRow | undefined {
    return this.inTx(() => {
      const slot = this.findSlot(householdId, fromSessionId, fromGeneration);
      if (
        slot === undefined ||
        slot.slotRevision !== expectedSlotRevision ||
        slot.status === 'consumed'
      ) {
        return undefined;
      }
      const nextRevision = expectedSlotRevision + 1;
      const changed = this.prepare(
        `UPDATE playback_transition_slot
         SET status = 'reserved', active_intent_id = ?, slot_revision = ?
         WHERE household_id = ? AND from_session_id = ? AND from_generation = ? AND slot_revision = ?`,
      ).run(activeIntentId, nextRevision, householdId, fromSessionId, fromGeneration, expectedSlotRevision);
      return changed.changes === 1 ? this.findSlot(householdId, fromSessionId, fromGeneration) : undefined;
    });
  }

  consumeSlot(
    householdId: string,
    fromSessionId: string,
    fromGeneration: number,
    expectedSlotRevision: number,
    intentId: string,
    successorSessionId: string,
  ): TransitionSlotRow | undefined {
    return this.inTx(() => {
      const slot = this.findSlot(householdId, fromSessionId, fromGeneration);
      if (
        slot === undefined ||
        slot.slotRevision !== expectedSlotRevision ||
        slot.status !== 'reserved' ||
        slot.activeIntentId !== intentId
      ) {
        return undefined;
      }
      // consumed 永久:revision 不变(消费不 bump,仅替换/取消 bump;C1/D5 钉面)
      const changed = this.prepare(
        `UPDATE playback_transition_slot
         SET status = 'consumed', successor_session_id = ?
         WHERE household_id = ? AND from_session_id = ? AND from_generation = ?
           AND slot_revision = ? AND status = 'reserved' AND active_intent_id = ?`,
      ).run(successorSessionId, householdId, fromSessionId, fromGeneration, expectedSlotRevision, intentId);
      return changed.changes === 1 ? this.findSlot(householdId, fromSessionId, fromGeneration) : undefined;
    });
  }

  releaseSlot(
    householdId: string,
    fromSessionId: string,
    fromGeneration: number,
    expectedSlotRevision: number,
  ): TransitionSlotRow | undefined {
    return this.inTx(() => {
      const slot = this.findSlot(householdId, fromSessionId, fromGeneration);
      if (slot === undefined || slot.slotRevision !== expectedSlotRevision || slot.status !== 'reserved') {
        return undefined;
      }
      const changed = this.prepare(
        `UPDATE playback_transition_slot
         SET status = 'open', active_intent_id = NULL, slot_revision = slot_revision + 1
         WHERE household_id = ? AND from_session_id = ? AND from_generation = ? AND slot_revision = ?`,
      ).run(householdId, fromSessionId, fromGeneration, expectedSlotRevision);
      return changed.changes === 1 ? this.findSlot(householdId, fromSessionId, fromGeneration) : undefined;
    });
  }

  /* ---------- 组合终局(意图终局与槽联动;api §5 cancel 语义) ---------- */

  cancelTransitionIntent(householdId: string, intentId: string, nowIso: string): TransitionIntentCancelOutcome {
    return this.inTx<TransitionIntentCancelOutcome>(() => {
      const intent = this.findIntentById(householdId, intentId);
      if (intent === undefined) {
        return { kind: 'not_found' };
      }
      const slot = this.findSlot(householdId, intent.fromSessionId, intent.fromGeneration);
      const slotRevisionNow = slot?.slotRevision ?? intent.slotRevision;
      // 终态不可逆:cancelled/superseded/expired 重复取消不再改槽(幂等回报)
      if (intent.status === 'cancelled') {
        return { kind: 'already_cancelled', slotRevision: slotRevisionNow };
      }
      if (intent.status === 'superseded') {
        return { kind: 'superseded', slotRevision: slotRevisionNow };
      }
      if (intent.status === 'expired') {
        return { kind: 'expired', slotRevision: slotRevisionNow };
      }
      // 取消输给消费:返回原后继(仅原上下文可见;后继不受影响)
      if (intent.status === 'consumed') {
        return {
          kind: 'already_consumed',
          successorSessionId: intent.successorId ?? '',
          slotRevision: slotRevisionNow,
        };
      }
      // pending:TTL 过期即 expired 分支(意图标 expired;槽释放 open),否则 cancelled
      const pastTtl = isIntentExpired(parseMs(intent.createdAt), parseMs(nowIso));
      const releaseSlotTx = (): number => {
        if (
          slot !== undefined &&
          slot.status === 'reserved' &&
          slot.activeIntentId === intentId
        ) {
          const released = this.releaseSlot(householdId, intent.fromSessionId, intent.fromGeneration, slot.slotRevision);
          if (released !== undefined) {
            return released.slotRevision;
          }
        }
        return slotRevisionNow;
      };
      if (pastTtl) {
        this.markIntentExpired(householdId, intentId);
        return { kind: 'expired', slotRevision: releaseSlotTx() };
      }
      this.markIntentCancelled(householdId, intentId);
      return { kind: 'cancelled', slotRevision: releaseSlotTx() };
    });
  }

  consumeTransition(
    householdId: string,
    intentId: string,
    successorSessionId: string,
    nowIso: string,
  ): TransitionConsumeOutcome {
    return this.inTx<TransitionConsumeOutcome>(() => {
      const intent = this.findIntentById(householdId, intentId);
      if (intent === undefined) {
        return { kind: 'conflict', reason: 'intent_not_found', intent: undefined, slot: undefined };
      }
      if (intent.status !== 'pending') {
        return { kind: 'conflict', reason: 'intent_not_pending', intent, slot: this.findSlot(householdId, intent.fromSessionId, intent.fromGeneration) };
      }
      if (isIntentExpired(parseMs(intent.createdAt), parseMs(nowIso))) {
        return { kind: 'conflict', reason: 'intent_expired', intent, slot: this.findSlot(householdId, intent.fromSessionId, intent.fromGeneration) };
      }
      const slot = this.findSlot(householdId, intent.fromSessionId, intent.fromGeneration);
      if (
        slot === undefined ||
        slot.status !== 'reserved' ||
        slot.slotRevision !== intent.slotRevision ||
        slot.activeIntentId !== intentId
      ) {
        return { kind: 'conflict', reason: 'slot_mismatch', intent, slot };
      }
      // 单事务提交:consumed 槽永久 + intent consumed/后继;任何失败整体回滚
      const consumedSlot = this.consumeSlot(
        householdId,
        intent.fromSessionId,
        intent.fromGeneration,
        intent.slotRevision,
        intentId,
        successorSessionId,
      );
      const consumedIntentChanges = this.markIntentConsumed(householdId, intentId, successorSessionId);
      const intentAfter = this.findIntentById(householdId, intentId);
      const slotAfter = this.findSlot(householdId, intent.fromSessionId, intent.fromGeneration);
      if (consumedSlot === undefined || consumedIntentChanges !== 1 || intentAfter === undefined || slotAfter === undefined) {
        throw new DomainError(500, ProblemCode.INTERNAL, '过渡消费提交不一致(存储一致性失败)');
      }
      return { kind: 'consumed', intent: intentAfter, slot: slotAfter };
    });
  }

  /* ---------- 完成回执(playback_finish_receipt;session 唯一不可变) ---------- */

  findFinishReceiptBySession(householdId: string, sessionId: string): FinishReceiptRow | undefined {
    return this.prepare(`${FINISH_RECEIPT_SELECT} WHERE household_id = ? AND session_id = ?`).get(householdId, sessionId) as
      | FinishReceiptRow
      | undefined;
  }

  insertFinishReceiptIfAbsent(values: FinishReceiptInsertValues): { readonly created: boolean; readonly receipt: FinishReceiptRow } {
    return this.inTx(() => {
      const result = this.prepare(
        `INSERT INTO playback_finish_receipt (
          household_id, session_id, device_session_id, profile_context_version, generation,
          operation_key, request_digest, final_seq, final_session_accepted,
          history_applied, history_revision, session_completed, auto_next_eligible,
          reason, position_seconds, duration_seconds, ended_at,
          content_revision, continuity_revision, locator_revision
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT (household_id, session_id) DO NOTHING`,
      ).run([
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
      ]);
      const existing = this.findFinishReceiptBySession(values.householdId, values.sessionId);
      if (existing === undefined) {
        throw new DomainError(500, ProblemCode.INTERNAL, '完成回执落库后不可读(存储一致性失败)');
      }
      return { created: result.changes === 1, receipt: existing };
    });
  }

  /* ---------- 只读来源事实(零票据材料) ---------- */

  findSourceSessionContext(householdId: string, sessionId: string): SourceSessionContextRow | undefined {
    return this.prepare(
      `SELECT
        id,
        device_session_id AS deviceSessionId,
        profile_id AS profileId,
        profile_context_version AS profileContextVersion,
        generation,
        state,
        media_id AS mediaId,
        ended_at AS endedAt
       FROM playback_session
       WHERE household_id = ? AND id = ?`,
    ).get(householdId, sessionId) as SourceSessionContextRow | undefined;
  }

  findSourceLedgerCheckpoint(householdId: string, sessionId: string): SourceLedgerCheckpointRow | undefined {
    return this.prepare(
      `SELECT
        last_generation AS generation,
        last_sample_seq AS lastSampleSeq,
        ledger_generation AS ledgerGeneration,
        ledger_position AS ledgerPosition,
        ledger_duration AS ledgerDuration
       FROM playback_progress_state
       WHERE household_id = ? AND playback_session_id = ?`,
    ).get(householdId, sessionId) as SourceLedgerCheckpointRow | undefined;
  }

  findSourceActiveBinding(householdId: string, sessionId: string, generation: number): SourceBindingRow | undefined {
    return this.prepare(
      `SELECT
        generation,
        playback_source_id AS playbackSourceId,
        source_id AS sourceId,
        start_basis AS startBasis,
        frozen_start_seconds AS frozenStartSeconds
       FROM playback_input_binding
       WHERE household_id = ? AND session_id = ? AND generation = ?`,
    ).get(householdId, sessionId, generation) as SourceBindingRow | undefined;
  }

  /* ---------- 清理面(data-model §9 24h 保护;T062 消费) ---------- */

  listExpiredPendingIntentRows(nowIso: string): TransitionIntentRow[] {
    return this.prepare(
      `${TRANSITION_INTENT_SELECT}
       WHERE status = 'pending' AND expires_at <= ?
       ORDER BY expires_at ASC, created_at ASC, id ASC`,
    ).all(nowIso) as TransitionIntentRow[];
  }

  markExpiredPendingIntents(nowIso: string): number {
    return this.inTx(() => {
      const expired = this.listExpiredPendingIntentRows(nowIso);
      let flipped = 0;
      for (const intent of expired) {
        if (this.markIntentExpired(intent.householdId, intent.id) === 1) {
          flipped += 1;
        }
        // 仍被该意图占用的 reserved 槽同事务释放(open + revision+1)
        const slot = this.findSlot(intent.householdId, intent.fromSessionId, intent.fromGeneration);
        if (slot !== undefined && slot.status === 'reserved' && slot.activeIntentId === intent.id) {
          this.releaseSlot(intent.householdId, intent.fromSessionId, intent.fromGeneration, slot.slotRevision);
        }
      }
      return flipped;
    });
  }

  listConsumedIntentsReadyForCleanup(cutoffIso: string): TransitionIntentRow[] {
    // 24h 保留窗由本层落实:data-model §9「已消费intent结果…至少24h」——
    // 有效截止 = cutoffIso - 24h(expires_at 早于该者才可清理);调用方传 now 即可
    const effectiveCutoff = iso(parseMs(cutoffIso) - CONSUMED_RESULT_PROTECTION_MS);
    return this.prepare(
      `${TRANSITION_INTENT_SELECT}
       WHERE status = 'consumed' AND expires_at <= ?
       ORDER BY expires_at ASC, created_at ASC, id ASC`,
    ).all(effectiveCutoff) as TransitionIntentRow[];
  }

  listConsumedSlotsReadyForCleanup(cutoffIso: string): TransitionSlotRow[] {
    const effectiveCutoff = iso(parseMs(cutoffIso) - CONSUMED_RESULT_PROTECTION_MS);
    return this.prepare(
      `${TRANSITION_SLOT_SELECT}
       WHERE active_intent_id IS NOT NULL
         AND active_intent_id IN (
           SELECT id FROM playback_transition_intent
           WHERE playback_transition_intent.household_id = playback_transition_slot.household_id
             AND status = 'consumed' AND expires_at <= ?
         )`,
    ).all(effectiveCutoff) as TransitionSlotRow[];
  }

  listFinishReceiptsReadyForCleanup(cutoffIso: string): FinishReceiptRow[] {
    const effectiveCutoff = iso(parseMs(cutoffIso) - CONSUMED_RESULT_PROTECTION_MS);
    return this.prepare(`${FINISH_RECEIPT_SELECT} WHERE ended_at <= ? ORDER BY ended_at ASC`).all(effectiveCutoff) as FinishReceiptRow[];
  }

  /* ---------- 清理执行面(010 T062;引用图依赖序;守卫谓词防扫描/端点竞态) ---------- */

  deleteConsumedTransitionSlots(rows: readonly TransitionSlotRow[]): number {
    if (rows.length === 0) {
      return 0;
    }
    let deleted = 0;
    for (const row of rows) {
      deleted += this.prepare(
        `DELETE FROM playback_transition_slot
         WHERE household_id = ? AND from_session_id = ? AND from_generation = ?
           AND status = 'consumed' AND active_intent_id IS NOT NULL`,
      ).run(row.householdId, row.fromSessionId, row.fromGeneration).changes;
    }
    return deleted;
  }

  deleteConsumedTransitionIntents(rows: readonly TransitionIntentRow[]): number {
    if (rows.length === 0) {
      return 0;
    }
    let deleted = 0;
    for (const row of rows) {
      deleted += this.prepare(
        `DELETE FROM playback_transition_intent WHERE household_id = ? AND id = ? AND status = 'consumed'`,
      ).run(row.householdId, row.id).changes;
    }
    return deleted;
  }

  deleteFinishReceipts(rows: readonly FinishReceiptRow[]): number {
    if (rows.length === 0) {
      return 0;
    }
    let deleted = 0;
    for (const row of rows) {
      // 引用图保护:仍被任何 intent 以 finish_receipt_id 引用的回执不删(FK 子行未清)
      deleted += this.prepare(
        `DELETE FROM playback_finish_receipt
         WHERE household_id = ? AND session_id = ?
           AND NOT EXISTS (
             SELECT 1 FROM playback_transition_intent i
             WHERE i.household_id = playback_finish_receipt.household_id
               AND i.finish_receipt_id = playback_finish_receipt.session_id
           )`,
      ).run(row.householdId, row.sessionId).changes;
    }
    return deleted;
  }

  deleteExpiredUnreferencedNextPlans(nowIso: string): number {
    // 仅回收 ref 已解绑(淘汰遗留)且无任何 intent 引用的过期行;ref 仍在的过期行保持
    // 「过期计划建 intent 410 NEXT_PLAN_EXPIRED」的可判别面(A3),不删除
    return this.prepare(
      `DELETE FROM playback_next_plan
       WHERE expires_at <= ? AND ref IS NULL
         AND NOT EXISTS (
           SELECT 1 FROM playback_transition_intent i
           WHERE i.household_id = playback_next_plan.household_id AND i.next_plan_id = playback_next_plan.id
         )`,
    ).run(nowIso).changes;
  }

  listActiveSessionsRequestingCleanup(): { readonly householdId: string; readonly sessionId: string }[] {
    return this.prepare(
      `SELECT household_id AS householdId, id AS sessionId
       FROM playback_session
       WHERE cleanup_requested = 1 AND cleanup_state = 'pending'
         AND state IN ('preparing', 'ready', 'playing', 'paused')
       ORDER BY created_at ASC, id ASC`,
    ).all() as { readonly householdId: string; readonly sessionId: string }[];
  }
}

/** 装配/测试工厂:缺省 Database.db 惰性解析(单例重开安全);显式句柄用于测试 rig(内存/临时库) */
export function drizzleTransitionStore(handle?: DatabaseConstructor.Database): PlaybackTransitionStore {
  const handleSource: HandleSource = handle === undefined ? () => Database.db : () => handle;
  return new DrizzleTransitionStore(handleSource);
}
