/**
 * 010 T054/T059/T060 — transition 领域纯函数(纯领域,零依赖)。
 *
 * 纯 TS:零依赖、零 import(.dependency-cruiser.cjs R1a 对 domain 层的框架/内建/
 * platform/外部包硬禁令 + audit:purity 符号级门禁)。
 * 零真实时钟:一切时刻皆入参;零网络、零持久化、零 IO(纯判定)。
 *
 * 010 T090 knip 清理:删除零消费面——slot 状态机(TRANSITION_SLOT_TRANSITIONS/
 * slotTransition/canCreateSuccessor/SLOT_STATUSES/TransitionSlotStatus)、intent
 * 消费/替换/取消判定(canConsumeIntent/cancelOrSupersede/CancelOrSupersede 三件套/
 * INTENT_STATUSES/TransitionIntentStatus)、动作枚举(INTENT_ACTIONS/TransitionIntentAction/
 * SWITCH_PATH_ACTIONS/SwitchPathAction)与一期 switch 拒绝面(SwitchPathPhase1
 * Rejection/isSwitchPathAction/rejectSwitchPathInPhase1)——T059/T060 实际落库/服务
 * 层以自身校验承担同语义(消费前置=canConsumeIntent∧¬isIntentExpired∧slot reserved
 * 在消费事务内并联;switch 分支在 transition.service 显式拒绝)。契约词表仍以
 * data-model §7/playback-state §7 与存储 CHECK 枚举为权威;US4 后续开放 switch 时
 * 自契约文档重建规则。保留面:TTL(固定60s/重试不续期)、recover 窗口、可恢复故障
 * 词表、carry checkpoint 判定(均为 T059/T060 实际消费)。
 */

/* ------------------------------------------------------------------ */
/* intent TTL(「TTL固定60s,重试不续期」)                                 */
/* ------------------------------------------------------------------ */

/** 意图固定 TTL(秒):data-model §7「TTL固定60s」;常量钉死,禁止调用方自传 */
export const INTENT_TTL_SECONDS = 60;

/**
 * 意图绝对到期时刻(ms):恒为 createdAtMs + 60s。
 * 「重试不续期」的落点:expires_at 只在创建意图时由本函数一次性算出写库,此后任何
 * 重试/读取/恢复都不得用它重新计算——重试后到期时刻不后移(T059 写库、T060 重验
 * 均以此为准)。
 */
export function intentExpiresAtMs(createdAtMs: number): number {
  return createdAtMs + INTENT_TTL_SECONDS * 1000;
}

/**
 * 意图是否已过期:nowMs 严格晚于 createdAtMs+60s 才过期(恰 60s 边界仍有效——
 * §7「超时走普通明确新播放」与 recover_switch「60s内允许」同口径:60s 内含界)。
 * 「重试不续期=固定从 createdAt 计」:本函数只依赖 createdAt,不存在可续期的
 * last-active 时刻;TTL/身份变化/修订/政策拒绝使 pending 失效,停止来源不使
 * pending 失效(playback-state §7,后者是服务层校验,不在本纯函数)。
 */
export function isIntentExpired(createdAtMs: number, nowMs: number): boolean {
  return nowMs > intentExpiresAtMs(createdAtMs);
}

/* ------------------------------------------------------------------ */
/* US4/T072:recover_switch 恢复窗与 carry checkpoint 纯判定               */
/* ------------------------------------------------------------------ */

/**
 * recover_switch 可恢复窗口(秒):api §5「recover_switch允许网络/格式/媒体上游故障
 * failed后60s」+ data-model §7「原会话网络/格式故障后60s内允许recover_switch」。
 * 与 INTENT_TTL_SECONDS 同族常量(60s 固定;含界口径与 isIntentExpired 一致 ——
 * 「恰 60s 边界仍有效」,§7「超时走普通明确新播放」)。
 */
export const RECOVER_WINDOW_SECONDS = 60;

/**
 * recover_switch 窗口判定:nowMs - failedAtMs <= 60s 才可恢复(含界;failedAtMs 取
 * 来源终态时刻 ended_at)。窗口外资格关闭 —— 「超时走普通明确新播放,无旧 carry」,
 * 不抛错,由调用方映射稳定 4xx。
 */
export function isRecoverWindowOpen(failedAtMs: number, nowMs: number): boolean {
  return nowMs - failedAtMs <= RECOVER_WINDOW_SECONDS * 1000;
}

/**
 * recover_switch 可恢复故障类(playback-session failure_code 注册词表子集):
 * api §5「网络/格式/媒体上游故障」= 格式不支持 / 资源不可用(网络/上游)/ 准备超时。
 * 权限/修订/禁源/切档导致的终态不在其中 —— 「权限/修订/禁源导致终态不能恢复」,
 * 禁源与授权失配在调用方以授权族错误优先拒绝(api §6)。
 */
export const RECOVERABLE_MEDIA_FAILURE_CODES: readonly string[] = [
  'PLAYBACK_FORMAT_UNSUPPORTED',
  'PLAYBACK_RESOURCE_UNAVAILABLE',
  'PLAYBACK_PREPARE_TIMEOUT',
];

/** 来源 failed 终态是否属可恢复媒体故障(词表判定;非可恢复类不得借 recover_switch) */
export function isRecoverableMediaFailure(failureCode: string | null): boolean {
  return failureCode !== null && RECOVERABLE_MEDIA_FAILURE_CODES.includes(failureCode);
}

/** carry checkpoint 判定结果(纯形态;调用方映射 409 SOURCE_PROGRESS_PENDING) */
export type CarryCheckpointDecision =
  | { readonly kind: 'exact'; readonly allowEarlierAcceptedPosition: boolean }
  | {
      readonly kind: 'source_progress_pending';
      /** 不等维度(诊断用;稳定错误不泄露其他设备游标,api §6) */
      readonly dimension: 'generation' | 'sequence';
    };

/**
 * carry sourceCheckpoint 精确匹配判定(api §5 逐字 + §10):
 * 「事务读取的当前代ledger必须精确等于该游标,否则409 SOURCE_PROGRESS_PENDING;
 * 选择更早位置时…以该游标及allowEarlierAcceptedPosition=true提交,**仍须精确相等**;
 * 不自动挑另一个旧位置。ledger已前进则重新展示/确认;未接受样本不作为checkpoint」。
 *
 * 判定序:
 * 1. checkpoint.expectedGeneration ≠ 来源会话当前代 → generation 不等
 *    (ledger 已换代/陈旧声明;allowEarlierAcceptedPosition 不放宽代次);
 * 2. checkpoint.sampleSeq ≠ 当前代 ledger 接受游标(lastSampleSeq)→ sequence 不等
 *    —— **allowEarlierAcceptedPosition 仅记录「用户明确确认已显示的接受游标」,
 *    不放宽相等性**(「仍须精确相等」);ledger 已前进 → 重新展示/确认,不自动挑旧位置;
 * 3. 全等 → exact(位置/时长由调用方自 ledger 复制,data-model §10「所有值服务端读取」)。
 *
 * 注:T0 实测钉面 —— 会话 ledger 仅保留最新接受游标(playback_progress_state 单行,
 * data-model §10「不需要保留全部历史样本」),故更早已接受游标的位置服务端不可证;
 * 精确相等是唯一可实现且与契约逐字一致的解释(C4b 的旧游标 180 在现行 DDL 下不可得)。
 */
export function carryCheckpointDecision(input: {
  readonly checkpointGeneration: number;
  readonly checkpointSeq: number;
  readonly sourceGeneration: number;
  /** 当前代 ledger 接受游标(无已接受样本 = null) */
  readonly ledgerLastSampleSeq: number | null;
  readonly ledgerGeneration: number | null;
  readonly allowEarlierAcceptedPosition: boolean;
}): CarryCheckpointDecision {
  if (input.checkpointGeneration !== input.sourceGeneration) {
    return { kind: 'source_progress_pending', dimension: 'generation' };
  }
  if (input.ledgerGeneration !== null && input.ledgerGeneration !== input.sourceGeneration) {
    return { kind: 'source_progress_pending', dimension: 'generation' };
  }
  if (input.ledgerLastSampleSeq === null || input.checkpointSeq !== input.ledgerLastSampleSeq) {
    return { kind: 'source_progress_pending', dimension: 'sequence' };
  }
  return { kind: 'exact', allowEarlierAcceptedPosition: input.allowEarlierAcceptedPosition };
}
