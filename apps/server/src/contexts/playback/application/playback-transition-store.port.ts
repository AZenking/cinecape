/**
 * 过渡持久仓储端口(010-online-vod T059,US3;ADR-0015 D1 application 端口角色)。
 *
 * 职责(T059 tasks.md 原文):slot/intent/receipt 持久查询、scope 幂等、60s 固定
 * TTL/24h 消费结果保护、持久 NextPlan 快照及 intent 引用保留;初始 revision=0/open
 * 只作响应默认(持久行 slot_revision>=1,0007 CHECK 同口径)。审查补充面:创建/消费
 * 所需的序列/目标/历史 revision 读取(计划行精确快照)与每设备 20 活计划上限淘汰
 * (引用保护:被 pending/consumed intent 引用的计划不因配额淘汰,data-model §10)。
 *
 * 行为契约:apps/server/test/unit/playback/transition-store.spec.ts(真实 DDL+真实
 * store;本端口以使其全绿为完成定义之一)。实现位于
 * infrastructure/playback-transition-store.drizzle.ts(BEGIN IMMEDIATE 多写并入惯例,
 * 同事务 CAS 返回新状态或冲突信号),由 playback.module.ts 装配期绑定;
 * 单元测试 rig 经 bindTransitionStore 自行绑定。
 *
 * 与 T016 事务参与者(playback-work-set.port.ts 的 TransitionIntentTx/TransitionSlotTx/
 * NextPlanTx/FinishReceiptTx)的分工:Tx 面服务 TransitionConsumeWorkSet(uow run 内
 * 同连接绑定,消费事务);本端口服务事务外创建/查询/取消/清理面(T060 next-plans/
 * intents 端点、T062 清理扫描)。行类型经 `import type` 取自 work-set 端口(type-only
 * 单一事实源,不产生依赖边);多写原子性由实现层封装(008 FR-003:事务句柄不越出
 * infrastructure),端口只见「组合操作 + 判别结果」,不见连接/事务对象。
 *
 * 消费位置(契约来源,实现侧不自创语义):
 * - docs/specs/010-online-vod/data-model.md §7(唯一(household,from_session,generation);
 *   TTL 固定 60s 重试不续期;pending 显式替换 expectedSlotRevision、旧意图 superseded、
 *   slot_revision+1;取消成功 open+revision;consumed 槽永久不能再建立第二后继;
 *   同设备上下文操作 key 唯一)+ §9(finish receipt/已消费 intent/slot 至少 24h)+
 *   §10(playback_next_plan 不可变 60s/有界/引用保护;intent 冻结快照随 next_plan_id);
 * - docs/specs/010-online-vod/contracts/playback-state.md §5(来源只读上下文:终态也可
 *   读,不重新发源票;A→B→A contextVersion 不等即 404)+ §7(slot open→reserved→
 *   consumed;pending 替换/取消 CAS revision,旧 intent 状态不可逆);
 * - docs/specs/010-online-vod/contracts/api.md §5/§7(同 key 重放 200 不续 TTL/异摘要
 *   409 IDEMPOTENCY_CONFLICT;slot 消费后任何新 key 409 附原后继引用;淘汰 ref 与未知
 *   ref 404 同形;pending 到期不晚于计划 expiresAt 与 createdAt+60s 较早者);
 * - apps/server/src/contexts/playback/domain/transition.rules.ts(T054 纯状态机:
 *   INTENT_TTL_SECONDS=60/intentExpiresAtMs/TTL 判定;本持久层消费其判定,不重复实现)。
 */
import type { TransitionAction, TransitionPositionFacts } from '@contexts/playback/application/playback-work-set.port';
import type {
  FinishReceiptInsertValues,
  FinishReceiptRow,
  NextPlanFreezeSnapshot,
  NextPlanRow,
  TransitionIntentRow,
  TransitionSlotRow,
} from '@contexts/playback/application/playback-work-set.port';

/** 持久 slot 行 / intent 行 / 计划行 / 回执行(T015 行投影,type-only 单一事实源) */
export type {
  FinishReceiptRow,
  NextPlanRow,
  TransitionIntentRow,
  TransitionSlotRow,
};

/* ------------------------------------------------------------------ */
/* 值集(创建/写面输入)                                                  */
/* ------------------------------------------------------------------ */

/** 一期开放动作面(next/manual_next;switch/recover_switch 类型承载,T072 开放) */
export type TransitionStoreAction = TransitionAction;

/** 下一集计划创建值集(playback_next_plan 新行;expiresAt 由实现按 60s 固定 TTL 派生) */
export interface NextPlanCreateValues {
  readonly id: string;
  /** 对外不透明引用(与 id 并列;淘汰即解绑 ref —— 见 evictSurplusNextPlans 说明) */
  readonly ref: string;
  readonly householdId: string;
  readonly deviceSessionId: string;
  readonly profileId: string;
  readonly profileContextVersion: number;
  readonly fromSessionId: string;
  readonly fromGeneration: number;
  readonly action: 'next' | 'manual_next';
  readonly targetMediaId: string;
  readonly sequenceRevision: number;
  readonly detailRevision: number;
  readonly targetContentRevision: number;
  readonly targetContinuityRevision: number;
  readonly targetLocatorRevision: number;
  /** 无历史快照=0(仅快照语义,不是持久历史 revision;0007 CHECK >=0) */
  readonly historyRevision: number;
  readonly historyChoiceRequired: boolean;
  /** 计划创建时刻(ISO);expiresAt = createdAt + INTENT_TTL_SECONDS(恰 60s,不可变) */
  readonly createdAt: string;
}

/** 过渡意图创建值集(playback_transition_intent 新行;随 plan 携带冻结快照与计划到期) */
export interface TransitionIntentCreateValues {
  readonly id: string;
  readonly householdId: string;
  readonly fromSessionId: string;
  readonly fromGeneration: number;
  readonly deviceSessionId: string;
  readonly profileId: string;
  readonly profileContextVersion: number;
  readonly action: TransitionStoreAction;
  readonly targetMediaId: string;
  readonly targetContentRevision: number;
  readonly targetContinuityRevision: number;
  readonly targetLocatorRevision: number;
  readonly matchRevision: number;
  readonly matchConfidence: 'high' | 'ambiguous' | 'conflict';
  readonly confirmedAmbiguous: boolean;
  /** 位置事实判别联合(carry 三件套/检查点;非 carry 必空,由 0007 CHECK 落实) */
  readonly position: TransitionPositionFacts;
  readonly finishReceiptId: string | null;
  readonly operationKey: string;
  /** 请求摘要(scope 幂等判定:同 key 同摘要重放、异摘要冲突) */
  readonly requestDigest: string;
  /** 意图创建时刻(ISO);expiresAt = min(createdAt+60s, plan.expiresAt)(api §7 较早者) */
  readonly createdAt: string;
  /** next 计划冻结快照 + 计划到期时刻(null=无计划绑定;T072 switch 路径) */
  readonly plan: (NextPlanFreezeSnapshot & { readonly expiresAt: string }) | null;
}

/* ------------------------------------------------------------------ */
/* CAS 判别结果(同事务 CAS 返回新状态或冲突信号;应用层翻译稳定错误码)      */
/* ------------------------------------------------------------------ */

/** 意图创建 + 槽预留组合结果(单一 BEGIN IMMEDIATE;冲突即整体无写入) */
export type TransitionIntentCreateOutcome =
  /** 新 key 首建:pending intent + 槽 reserved(slot_revision 为落库新值) */
  | { readonly kind: 'created'; readonly intent: TransitionIntentRow; readonly slot: TransitionSlotRow }
  /** 同 key 同摘要重放:返回原行,不续 TTL、不改槽(api §5;expectedSlotRevision 不参与) */
  | { readonly kind: 'replayed'; readonly intent: TransitionIntentRow }
  /** 同 key 异摘要:409 IDEMPOTENCY_CONFLICT 的判定输入(既有行原样携带) */
  | { readonly kind: 'idempotency_conflict'; readonly existing: TransitionIntentRow }
  /** 槽 CAS 输家:409 TRANSITION_SLOT_CONFLICT 的判定输入(consumed 槽携带原后继引用) */
  | {
      readonly kind: 'slot_conflict';
      readonly expectedSlotRevision: number;
      readonly slot: TransitionSlotRow | undefined;
    };

/** 取消/终局结果(api §5 cancel 行;outcome 语义与 TransitionCancelReply 对齐) */
export type TransitionIntentCancelOutcome =
  /** pending 未过期取消成功:槽 open + revision+1 */
  | { readonly kind: 'cancelled'; readonly slotRevision: number }
  /** 已取消重复取消(幂等;槽不再变化) */
  | { readonly kind: 'already_cancelled'; readonly slotRevision: number }
  /** 取消 superseded 意图:槽归替换者不变,仅回报当前 revision */
  | { readonly kind: 'superseded'; readonly slotRevision: number }
  /** pending 已过 TTL(或已标 expired):意图标 expired、槽释放 open(首次)/不动(重复) */
  | { readonly kind: 'expired'; readonly slotRevision: number }
  /** 取消输给消费:返回原后继引用(仅原上下文可见),后继不受影响 */
  | { readonly kind: 'already_consumed'; readonly successorSessionId: string; readonly slotRevision: number }
  | { readonly kind: 'not_found' };

/** 消费组合结果(intent consumed + slot consumed/后继,单一事务) */
export type TransitionConsumeOutcome =
  | {
      readonly kind: 'consumed';
      readonly intent: TransitionIntentRow;
      readonly slot: TransitionSlotRow;
    }
  /** 消费资格失配(intent 非 pending/已过期/槽 CAS 不符);携带当前行供判定 */
  | {
      readonly kind: 'conflict';
      readonly reason: 'intent_not_found' | 'intent_not_pending' | 'intent_expired' | 'slot_mismatch';
      readonly intent: TransitionIntentRow | undefined;
      readonly slot: TransitionSlotRow | undefined;
    };

/* ------------------------------------------------------------------ */
/* 只读投影(来源上下文/清理面)                                           */
/* ------------------------------------------------------------------ */

/** 来源会话上下文只读投影(同上下文终态只读来源授权的会话事实;不含任何票据材料) */
export interface SourceSessionContextRow {
  readonly id: string;
  readonly deviceSessionId: string;
  readonly profileId: string;
  readonly profileContextVersion: number;
  readonly generation: number;
  readonly state: string;
  readonly mediaId: string;
  readonly endedAt: string | null;
}

/** 来源会话 ledger 接受游标只读投影(carry 精确 checkpoint 基准;US4 消费,只读) */
export interface SourceLedgerCheckpointRow {
  readonly generation: number;
  readonly lastSampleSeq: number;
  readonly ledgerGeneration: number | null;
  readonly ledgerPosition: number | null;
  readonly ledgerDuration: number | null;
}

/** 来源历史输入绑定只读投影(终态来源的合法上下文事实;不重发源票) */
export interface SourceBindingRow {
  readonly generation: number;
  readonly playbackSourceId: string;
  readonly sourceId: string;
  readonly startBasis: string;
  readonly frozenStartSeconds: number | null;
}

/** 活计划行投影(带引用保护标记;每设备 20 上限语义的读取面) */
export interface ActiveNextPlanRow extends NextPlanRow {
  /** 是否被 pending/consumed intent 引用(受引用者不参与上限计数、不被配额淘汰) */
  readonly referencedByActiveIntent: boolean;
}

/* ------------------------------------------------------------------ */
/* 端口                                                                  */
/* ------------------------------------------------------------------ */

/**
 * 过渡持久仓储端口(下一集计划/单后继槽/过渡意图/完成回执/清理面)。
 * 全部方法同步返回;多写操作由实现以 BEGIN IMMEDIATE 原子封装(连接已处于事务中
 * 则并入外层),任何冲突以判别结果返回,不抛非领域异常。
 */
export interface PlaybackTransitionStore {
  /* ---------- 下一集计划(playback_next_plan;不可变,TTL 60s 固定) ---------- */

  /**
   * 持久不可变计划(有界):单事务 INSERT + 每设备上限淘汰。
   * expiresAt = createdAt + 60s(恰);keepCount 缺省 20(每设备活计划上限)。
   * 淘汰 = 解绑最早过期未保护计划的 ref(行保留:受 FK 引用完整性约束,且过期行由
   * T062 清理面回收;解绑后 findByRef 与未知 ref 同形不可见 —— api §7 淘汰 ref 404 同形)。
   * 保护面:本次新建计划、被 pending/consumed intent 引用的计划(data-model §10)。
   */
  createNextPlan(values: NextPlanCreateValues, cap?: { readonly keepCount: number }): NextPlanRow;
  /** 按 ref 读计划精确快照(ref 已解绑/不存在一律 undefined —— 上层同形 404) */
  findNextPlanByRef(householdId: string, ref: string): NextPlanRow | undefined;
  /** 按 id 读计划精确快照(消费复核输入) */
  findNextPlanById(householdId: string, nextPlanId: string): NextPlanRow | undefined;
  /** 设备活计划清单(ref 未解绑行;带引用保护标记,上限/诊断读取面) */
  listActiveNextPlanRows(householdId: string, deviceSessionId: string, nowIso: string): ActiveNextPlanRow[];

  /* ---------- 单后继槽(playback_transition_slot;唯一(家庭,来源,代次)) ---------- */

  /** 读槽行(无行 = 响应默认 0/open 的持久事实;持久行 slot_revision>=1) */
  findSlot(householdId: string, fromSessionId: string, fromGeneration: number): TransitionSlotRow | undefined;
  /** 幂等建槽:无行建 open/revision=1;已有行原样返回(资格判定归调用方) */
  ensureOpenSlot(householdId: string, fromSessionId: string, fromGeneration: number): TransitionSlotRow;

  /* ---------- 过渡意图(playback_transition_intent;五态不可逆) ---------- */

  /** 按意图归属读 intent 行(GET/cleanup 归属判定的持久输入) */
  findIntentById(householdId: string, intentId: string): TransitionIntentRow | undefined;
  /** 按幂等 scope(家庭/DeviceSession/contextVersion/operationKey)读 intent 行 */
  findIntentByOperationKey(
    householdId: string,
    deviceSessionId: string,
    profileContextVersion: number,
    operationKey: string,
  ): TransitionIntentRow | undefined;

  /**
   * 创建 pending 意图 + 槽 CAS 预留(单一 BEGIN IMMEDIATE;任一冲突整体无写入)。
   * 判定序:scope 幂等(同 key 同摘要 replayed/异摘要 idempotency_conflict,均不动槽)
   * → 槽 CAS(expectedSlotRevision=0 表示「尚无槽行」响应默认;命中 open/reserved 行
   * 则按 revision CAS,reserved 命中即显式替换:旧 active intent 同事务标 superseded、
   * slot_revision+1)→ 插入 intent(携带 plan 冻结快照)→ 写槽 reserved。
   * TTL:expiresAt = min(createdAt+60s, plan.expiresAt)(api §7 较早者;无计划绑定即
   * 恰 60s);夹出非正窗口(过期计划)直接 410 NEXT_PLAN_EXPIRED 形态领域错误。
   */
  createTransitionIntent(
    values: TransitionIntentCreateValues,
    expectedSlotRevision: number,
  ): TransitionIntentCreateOutcome;

  /** pending → superseded(显式替换原语;仅 pending 命中,返回受影响行数) */
  markIntentSuperseded(householdId: string, intentId: string): number;
  /** pending → cancelled(取消原语;仅 pending 命中) */
  markIntentCancelled(householdId: string, intentId: string): number;
  /** pending → expired(TTL watchdog 原语;仅 pending 命中) */
  markIntentExpired(householdId: string, intentId: string): number;
  /** pending → consumed + 后继引用(消费提交原语;仅 pending 命中;consumed 永久无第二后继) */
  markIntentConsumed(householdId: string, intentId: string, successorSessionId: string): number;

  /* ---------- 槽 CAS 原语(读判写原子由实现封装;冲突返回 undefined/无写入) ---------- */

  /** open/reserved→reserved CAS(expected 命中才写;reserved 命中=显式替换占位,旧 intent 终局由调用方同事务处理) */
  reserveSlot(
    householdId: string,
    fromSessionId: string,
    fromGeneration: number,
    expectedSlotRevision: number,
    activeIntentId: string,
  ): TransitionSlotRow | undefined;
  /** reserved→consumed CAS(永久终态;revision 不变 —— 消费不 bump,仅替换/取消 bump) */
  consumeSlot(
    householdId: string,
    fromSessionId: string,
    fromGeneration: number,
    expectedSlotRevision: number,
    intentId: string,
    successorSessionId: string,
  ): TransitionSlotRow | undefined;
  /** reserved→open CAS(取消/清理释放;revision+1、清 active intent) */
  releaseSlot(
    householdId: string,
    fromSessionId: string,
    fromGeneration: number,
    expectedSlotRevision: number,
  ): TransitionSlotRow | undefined;

  /* ---------- 组合终局(意图终局与槽联动,单一事务;api §5 cancel 语义) ---------- */

  /** 取消/终局意图:按当前状态判别(cancelled/superseded/expired/already_consumed/not_found);pending 过 TTL 即 expired 分支 */
  cancelTransitionIntent(householdId: string, intentId: string, nowIso: string): TransitionIntentCancelOutcome;
  /** 消费组合:pending 未过期 + 槽 reserved CAS → intent consumed + slot consumed/后继(单一事务,失败整体无写入) */
  consumeTransition(householdId: string, intentId: string, successorSessionId: string, nowIso: string): TransitionConsumeOutcome;

  /* ---------- 完成回执(playback_finish_receipt;session 唯一不可变) ---------- */

  /** 按来源会话读回执(next 资格/来源终态只读事实;不存在=undefined) */
  findFinishReceiptBySession(householdId: string, sessionId: string): FinishReceiptRow | undefined;
  /** 幂等写回执(session 唯一;已有行原样返回 created=false,不升级 —— 「终态不得由新 finish 升级」) */
  insertFinishReceiptIfAbsent(values: FinishReceiptInsertValues): { readonly created: boolean; readonly receipt: FinishReceiptRow };

  /* ---------- 只读来源事实(transition-source-context.service 消费;零票据材料) ---------- */

  /** 来源会话上下文只读投影(缺失/跨家庭 undefined) */
  findSourceSessionContext(householdId: string, sessionId: string): SourceSessionContextRow | undefined;
  /** 来源 ledger 接受游标只读投影(carry checkpoint 基准;无行=undefined) */
  findSourceLedgerCheckpoint(householdId: string, sessionId: string): SourceLedgerCheckpointRow | undefined;
  /** 来源当前代输入绑定只读投影 */
  findSourceActiveBinding(householdId: string, sessionId: string, generation: number): SourceBindingRow | undefined;

  /* ---------- 清理面(data-model §9 24h 保护;T062 消费) ---------- */

  /** 已过 TTL 的 pending intent 行(watchdog/清理扫描输入,按 expires_at 升序) */
  listExpiredPendingIntentRows(nowIso: string): TransitionIntentRow[];
  /**
   * 批量过期 + 释放槽(单一事务):pending 且过 TTL → status='expired',
   * 其 reserved 槽(active_intent_id 命中)→ open + revision+1;返回翻转行数。
   */
  markExpiredPendingIntents(nowIso: string): number;
  /** 已消费且超出 24h 保留窗的 intent(有效截止 = cutoff - 24h,由实现落实;先删不再可重放的 intent) */
  listConsumedIntentsReadyForCleanup(cutoffIso: string): TransitionIntentRow[];
  /** active intent 已消费且超出保留窗的槽(按依赖序随 intent 之后清理) */
  listConsumedSlotsReadyForCleanup(cutoffIso: string): TransitionSlotRow[];
  /** ended_at 超出保留窗的 finish receipt(有效截止 = cutoff - 24h;不短于会话保留的最终裁决归 T062) */
  listFinishReceiptsReadyForCleanup(cutoffIso: string): FinishReceiptRow[];

  /* ---------- 清理执行面(010 T062;引用图依赖序,data-model §9) ---------- */

  /**
   * 删除已消费槽行(仅 status='consumed' 命中;slot.active_intent_id 的 FK 子行先于
   * intent 删除)。守卫谓词防扫描与端点竞态:状态已漂移的行零删除。
   */
  deleteConsumedTransitionSlots(rows: readonly TransitionSlotRow[]): number;
  /**
   * 删除已消费 intent 行(仅 status='consumed' 命中;调用方按依赖序先删其槽行 ——
   * data-model §9「过期后先删不再可消费/重放的 intent,再按依赖清理 slot/receipt」;
   * successor 引用的 session/ledger 行不在删除面内,T062 清理绝不连带删会话)。
   */
  deleteConsumedTransitionIntents(rows: readonly TransitionIntentRow[]): number;
  /**
   * 删除 finish receipt(仅无任何 intent 以 finish_receipt_id 引用者命中 ——
   * 引用图保护:被引用 receipt 是 intent 消费证据,须待引用它的 intent 先行清理)。
   */
  deleteFinishReceipts(rows: readonly FinishReceiptRow[]): number;
  /**
   * 回收过期且未引用的下一集计划行(expires_at <= now 且 ref 已解绑且无任何 intent
   * 引用;ref 仍在的过期行保持 A3 的 410 NEXT_PLAN_EXPIRED 判定面,不删除)。
   */
  deleteExpiredUnreferencedNextPlans(nowIso: string): number;
  /** cleanup_requested=1 且仍处活动态的会话清单(失败/重启扫描对幂等空 stop 补投的输入) */
  listActiveSessionsRequestingCleanup(): { readonly householdId: string; readonly sessionId: string }[];
}

/* ------------------------------------------------------------------ */
/* seam 槽(ADR-0015 D1;与 playback-store.port 同款)                      */
/* ------------------------------------------------------------------ */

let boundStore: PlaybackTransitionStore | null = null;

/** 装配/测试绑定(幂等覆盖);返回 store 便于 provider 链与测试 rig 取用 */
export function bindTransitionStore(store: PlaybackTransitionStore): PlaybackTransitionStore {
  boundStore = store;
  return store;
}

/** 取已绑定 store(未绑定即编程错误:显式失败,不静默空转) */
export function transitionStore(): PlaybackTransitionStore {
  if (boundStore === null) {
    throw new Error(
      'PLAYBACK_TRANSITION_STORE 未绑定:过渡持久端口需在模块装配(playback.module.ts)或测试 rig 中经 bindTransitionStore 绑定(ADR-0015 D1)',
    );
  }
  return boundStore;
}
