/**
 * 010-online-vod T015：播放/过渡事务工作集与每所有者事务感知端口（纯 TS，零实现）。
 *
 * 契约来源：docs/specs/010-online-vod/contracts/internal-ports.md
 * - §2「UnitOfWork 与三类原子范围」：ProgressFinishWorkSet / TransitionConsumeWorkSet；
 * - §5「审查新增工作集」：PlayingObservationWorkSet / TransitionCleanupWorkSet /
 *   NextPlanTx 与历史 revision 读取；
 * - §1「所有者与依赖」：SessionProgressPort / HistoryPort（personal-data）/
 *   PlaybackTransitionSourcePort / PlaybackInputLifecyclePort（playback）；
 * - 结果类型对齐 contracts/api.md §1（ProgressReply / FinishReceipt / IntentReply）
 *   与 §7（I3/I4/I5 审查闭环）。
 *
 * 与 T008 UnitOfWork API（apps/server/test/unit/online-vod/unit-of-work.spec.ts）对齐：
 * - 本文件只声明各所有者 Tx 端口(010 T090 knip 清理:文件尾工作集聚合接口已删,
 *   见尾注记)；run 机制由
 *   @platform/database/unit-of-work（T016 实现）提供 ——
 *   createUnitOfWork({ resolveDatabase, txStores }) 经各上下文 TxStore 工厂注册，
 *   run(workSetFactory, callback, { behavior: 'immediate' }) 把同一连接事务绑定到
 *   每个端口实现；application 只见绑定后的工作集成员，不接触
 *   TransactionBinding / 连接句柄 / ORM（事务凭证不暴露 ORM 句柄）；
 * - callback 同步签名（SyncResult），全部 Tx 端口方法同步返回；网络 probe、ffmpeg、
 *   任务取消一律在 commit 之后（§2：不能持写锁等 ffmpeg；重复消费不再次启动 probe）；
 * - 任何端口方法抛错即整体回滚；已授权不能替代事务内重验。
 */
import type {
  playbackFinishReceipt,
  playbackInputBinding,
  playbackNextPlan,
  playbackPhaseObservation,
  playbackProgressState,
  playbackSession,
  playbackTransitionIntent,
  playbackTransitionSlot,
  /* (010 T090 knip 清理:原 profile/profilePolicy import 已随 ProfileRow/PolicyRow 投影删除) */
} from '@platform/database/schema';

/* ------------------------------ schema 行投影（type-only 单一事实源） ------------------------------ */

/** 播放会话行（playback_session；含 010 增补 playback_started_at 与 cleanup 标记列） */
export type PlaybackSessionRow = typeof playbackSession.$inferSelect;
/** 会话 ledger 行（playback_progress_state；含 010 ledger_* 接受游标扩展） */
export type LedgerStateRow = typeof playbackProgressState.$inferSelect;
/** 完成回执行（playback_finish_receipt；session 唯一一份不可变终态） */
export type FinishReceiptRow = typeof playbackFinishReceipt.$inferSelect;
/** 固定输入绑定行（playback_input_binding；每 session/generation 至多一有效绑定） */
export type InputBindingRow = typeof playbackInputBinding.$inferSelect;
/** 过渡意图行（playback_transition_intent；含 next_plan 冻结快照列） */
export type TransitionIntentRow = typeof playbackTransitionIntent.$inferSelect;
/** 单后继槽行（playback_transition_slot） */
export type TransitionSlotRow = typeof playbackTransitionSlot.$inferSelect;
/** 下一集计划行（playback_next_plan；不可变、TTL 60s） */
export type NextPlanRow = typeof playbackNextPlan.$inferSelect;
/** 播放阶段观测行（playback_phase_observation；event_seq 幂等，不写个人历史） */
export type PhaseObservationRow = typeof playbackPhaseObservation.$inferSelect;
/* (010 T090 knip 清理:原 ProfileRow/PolicyRow 行投影已删除——零消费,profile/policy 行类型由所有者上下文端口面提供) */

/* ------------------------------------ 配套纯值类型（事实/结果） ------------------------------------ */

/** 设备会话身份快照（identity-access 读取投影；事务内重验输入） */
export interface PlaybackIdentitySnapshot {
  readonly deviceSessionId: string;
  readonly accountId: string;
  readonly deviceId: string;
  readonly profileId: string;
  readonly profileContextVersion: number;
  readonly revokedAt: string | null;
  readonly expiresAt: string;
}

/* (010 T090 knip 清理:原 PlaybackPolicyTargetRow 投影已删除——零消费) */

/* (010 T090 knip 清理:原 PlaybackMediaPolicyVerdict 接口已删除——零消费,判定输出
 *  由 policy 上下文 effective-media-policy 纯函数面承担) */

/** 会话受信事实（Catalog/Source 版本 + 本次 probe 受信事实；必须使用同一 source 绑定） */
export interface SessionTrustedFacts {
  readonly sessionId: string;
  readonly generation: number;
  readonly state: PlaybackSessionRow['state'];
  readonly delivery: PlaybackSessionRow['delivery'];
  readonly playbackSourceId: string | null;
  readonly sourceId: string | null;
  readonly mediaId: string;
  readonly mediaContentRevision: number;
  readonly locatorRevision: number | null;
  readonly detailRevision: number | null;
  readonly contentRevision: number | null;
  readonly continuityRevision: number | null;
  readonly startBasis: InputBindingRow['startBasis'] | null;
  readonly frozenStartSeconds: number | null;
  /** 本次 probe 受信时长（未知为 null，不以 0 冒充；不可借全局历史时长回填） */
  readonly probeDurationSeconds: number | null;
}

/** 源会话终态资格事实（next 需 receipt、recover_switch 60s 窗口等判定的原始输入） */
export interface SourceQualificationFacts {
  readonly sessionId: string;
  readonly generation: number;
  readonly state: PlaybackSessionRow['state'];
  readonly delivery: PlaybackSessionRow['delivery'];
  readonly endedAt: string | null;
  readonly failureCode: string | null;
  readonly profileContextVersion: number;
}

/** 交付受信事实（观测资格判定输入：受控交付/代次/会话态） */
export interface DeliveryFacts {
  readonly sessionId: string;
  readonly generation: number;
  readonly state: PlaybackSessionRow['state'];
  readonly delivery: PlaybackSessionRow['delivery'];
  readonly playbackSourceId: string | null;
  readonly playbackStartedAt: string | null;
}

/* (010 T090 knip 清理:原 TargetHistorySnapshot/VodPreferencesSnapshot 已删除——零消费,同名快照形态以 @contexts/personal-data 发布面为单一事实源) */

/* (010 T090 knip 清理:原 ProgressApplyOutcome 接口已删除——零消费,progress 应用
 *  结果由 playback-finish.service 自有结果簿记形态承载) */

/** finish 终态原因（与 playback_finish_receipt.reason CHECK 一致） */
export type FinishReason =
  | 'completed'
  | 'stale_final'
  | 'no_tail_observation'
  | 'not_started'
  | 'no_duration'
  | 'not_completed'
  | 'stopped_elsewhere';

/** finish 回执结果（api §1 FinishReceipt DTO 形态；position/duration 未知为 null 不以 0 冒充） */
export interface FinishReceiptOutcome {
  readonly sessionId: string;
  readonly generation: number;
  readonly ended: boolean;
  readonly finalSessionAccepted: boolean;
  readonly historyApplied: boolean;
  readonly historyRevision: number | null;
  readonly sessionCompleted: boolean;
  readonly autoNextEligible: boolean;
  readonly reason: FinishReason;
  readonly positionSeconds: number | null;
  readonly durationSeconds: number | null;
  readonly endedAt: string;
  readonly replayed: boolean;
}

/** 过渡动作（intent.action 域） */
export type TransitionAction = 'next' | 'manual_next' | 'switch' | 'recover_switch';
/** 起播基准（input_binding.start_basis 域；intent.positionMode 映射唯一 startBasis） */
export type StartBasis = 'beginning' | 'target_history' | 'transition_carry';
/* (010 T090 knip 清理:原 TransitionPositionMode/TransitionIntentStatus/
 *  TransitionSlotStatus 三个域类型已删除——零消费,域词表以 data-model §7 与
 *  存储 CHECK 枚举为权威) */

/** 位置事实判别联合（编码 intent carry 三件套/非 carry 必空 CHECK；仅 carry 允许 earlier 放宽） */
export type TransitionPositionFacts =
  | { readonly mode: 'beginning' | 'target_history' }
  | {
      readonly mode: 'carry';
      readonly carryPositionSeconds: number;
      readonly carryDurationSeconds: number;
      readonly sourceLedgerSeq: number;
      readonly sourceCheckpointGeneration: number;
      readonly sourceCheckpointSeq: number;
      readonly allowEarlierAcceptedPosition: boolean | null;
    };

/** next 计划冻结快照（intent 引用 next_plan 时随行固定；计划不可变，变化即 NEXT_PLAN_CHANGED） */
export interface NextPlanFreezeSnapshot {
  readonly nextPlanId: string;
  readonly sequenceRevision: number;
  readonly detailRevision: number;
  readonly historyRevision: number;
  readonly historyChoiceRequired: boolean;
}

/* (010 T090 knip 清理:原 TransitionConsumeOutcome/TransitionCleanupOutcome 两个
 *  结果形态已删除——零消费;同名语义分别由 playback-transition-store.port 与
 *  transition-cleanup.service 自有形态承载) */

/* ------------------------------------------ Read 面（每所有者一个事务感知端口） ------------------------------------------ */

/**
 * 身份快照读取端口。
 * 所有者：identity-access（T016 经 txStores 注册同连接绑定实现）。
 */
export interface PlaybackIdentityReader {
  /** 事务内重验当前设备会话身份（已授权不能替代事务内重验；旧上下文/撤销即拒绝） */
  findDeviceContext(deviceSessionId: string): PlaybackIdentitySnapshot | undefined;
}

/* (010 T090 knip 清理:原 PlaybackProfileReader 端口已删除——零消费,Profile 行读取由消费方自有读取面承担) */

/* (010 T090 knip 清理:原 PlaybackPolicyReader 端口已删除——零消费,策略读取由消费方自有读取面承担) */

/**
 * 会话受信事实读取端口。
 * 所有者：playback（Catalog/Source 版本 + 本次 probe 受信事实；必须使用同一 source 绑定）。
 */
export interface PlaybackTrustedFactsReader {
  /** 读会话 + 当前代输入绑定 + 媒体/来源修订与 probe 受信事实，缺失即拒绝本次写入 */
  findSessionTrustedFacts(householdId: string, sessionId: string): SessionTrustedFacts | undefined;
}

/**
 * 源会话资格事实读取端口。
 * 所有者：playback（§1 PlaybackTransitionSourcePort 的事务读取面：终态也可读合法来源上下文）。
 */
export interface TransitionSourceQualificationReader {
  /** 读源会话终态资格事实（next 要求 finish receipt、recover_switch 60s 窗口等判定输入） */
  findSourceQualification(householdId: string, sessionId: string): SourceQualificationFacts | undefined;
}

/* (010 T090 knip 清理:原 PlaybackPersonalFactsReader 端口已删除——零消费,偏好/目标历史读取由消费方自有读取面承担) */

/**
 * 交付受信事实读取端口。
 * 所有者：playback（观测资格：受控交付/代次/会话态，无交付不解除起播期限）。
 */
export interface PlaybackDeliveryFactReader {
  /** 读交付受信事实（generation/state/delivery/已起播标记；资格判定输入） */
  findDeliveryFacts(householdId: string, sessionId: string): DeliveryFacts | undefined;
}

/* ------------------------------------ Write 面（每所有者一个事务感知端口） ------------------------------------ */

/** preparing 会话建档值集（playback_session 新行；过渡消费/普通 resolve 的同事务建档输入） */
export interface PreparingSessionInsert {
  readonly sessionId: string;
  readonly householdId: string;
  readonly deviceSessionId: string;
  readonly deviceId: string;
  readonly profileId: string;
  readonly mediaId: string;
  readonly generation: number;
  readonly version: number;
  readonly profileContextVersion: number;
  readonly createdAt: string;
  readonly lastHeartbeatAt: string;
}

/**
 * 播放会话事务端口。
 * 所有者：playback（会话行状态迁移；终态不可复活，CAS 由 application 以 version/generation 执行）。
 */
export interface PlaybackSessionTx {
  /** 事务内读会话行（状态/代次/版本/绑定），缺失或跨家庭返回 undefined */
  findSession(householdId: string, sessionId: string): PlaybackSessionRow | undefined;
  /** 创建 preparing 会话（过渡消费/普通 resolve 建档，先于 epoch 绑定，失败整体回滚） */
  insertPreparingSession(values: PreparingSessionInsert): void;
  /** 终态提交（ended/failed/interrupted + endedAt 必填；终态不得由后续写入升级） */
  markSessionTerminal(householdId: string, sessionId: string, state: 'ended' | 'failed' | 'interrupted', failureCode: string | null, endedAt: string): void;
  /** generation 原子换绑（期望代次 CAS，推进 version；旧代输出不得再 ready） */
  advanceGeneration(householdId: string, sessionId: string, expectedGeneration: number, nextGeneration: number): void;
  /** 合格 playing 观测同事务设置独立起播标记 playback_started_at（不写 ledger/历史） */
  markPlaybackStartedAt(householdId: string, sessionId: string, startedAt: string): void;
  /** 写持久清理标记/原因（cleanup_requested=1、cleanup_state=pending；先阻止新票/新资产） */
  requestCleanup(householdId: string, sessionId: string, reason: string): void;
  /** 心跳/活动性簿记（last_heartbeat_at 推进；不写历史） */
  touchHeartbeat(householdId: string, sessionId: string, at: string): void;
}

/** 会话 ledger 首次建档值集（playback_progress_state 新行；session+epoch/完整 ledger 同事务） */
export interface SessionLedgerInsertValues {
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

/** 已接受样本写入值集（先更新 ledger 游标；seq 跨 generation 递增） */
export interface LedgerSampleApplyValues {
  readonly sampleSeq: number;
  readonly sampleDigest: string;
  readonly generation: number;
  readonly positionSeconds: number;
  readonly durationSeconds: number | null;
  readonly continuityRevision: number;
  readonly acceptedAt: string;
  readonly sessionStarted: boolean;
}

/**
 * 会话 ledger 事务端口。
 * 所有者：personal-data（§1 SessionProgressPort 写面：本 session ledger/绑定 epoch；
 * 新有效样本先更新 ledger，再按 epoch 决定历史，两者同事务）。
 */
export interface SessionLedgerTx {
  /** 读会话 ledger 精确游标（seq/digest/generation/ledger 游标列与 checkpoint；carry 校验基准） */
  findLedgerRow(householdId: string, sessionId: string): LedgerStateRow | undefined;
  /** session+epoch/完整 ledger 首次建档（与 session 创建同一用例事务，避免半建档） */
  insertLedgerRow(values: SessionLedgerInsertValues): void;
  /** 接受样本推进 ledger 游标（ledger_position/duration/generation/accepted_at；stale 不更新） */
  applyAcceptedSample(householdId: string, sessionId: string, values: LedgerSampleApplyValues): void;
}

/* (010 T090 knip 清理:原 HistoryTx 端口与 HistoryUpsertValues/HistoryApplyResult 已删除——零消费,epoch 历史写入由 personal-data transaction-participants 镜像面承担) */

/** 完成回执写入值集（playback_finish_receipt 新行；session 唯一一份不可变终态） */
export interface FinishReceiptInsertValues {
  readonly householdId: string;
  readonly sessionId: string;
  readonly deviceSessionId: string;
  readonly profileContextVersion: number;
  readonly generation: number;
  readonly operationKey: string;
  readonly requestDigest: string;
  /** 010 收敛:随规范列 final_seq 对齐(别名旧列 final_sample_seq 已自 0007 删除) */
  readonly finalSeq: number;
  readonly finalSessionAccepted: boolean;
  readonly historyApplied: boolean;
  readonly historyRevision: number | null;
  readonly sessionCompleted: boolean;
  readonly autoNextEligible: boolean;
  readonly reason: FinishReason;
  readonly positionSeconds: number | null;
  readonly durationSeconds: number | null;
  readonly endedAt: string;
  readonly contentRevision: number;
  readonly continuityRevision: number;
  readonly locatorRevision: number;
}

/**
 * 完成回执事务端口。
 * 所有者：playback（finish 幂等与不可变终态；旧 stop 先赢写 stopped_elsewhere receipt）。
 */
export interface FinishReceiptTx {
  /** 读回执（重放/stopped_elsewhere 判定；finish 重放先校验身份归属再读 receipt） */
  findReceipt(householdId: string, sessionId: string): FinishReceiptRow | undefined;
  /** 写唯一一份不可变回执（与 session 终态/输入待清理同 commit；已有 receipt 再写即冲突） */
  insertReceipt(values: FinishReceiptInsertValues): void;
}

/** 过渡意图创建值集（playback_transition_intent 新行；TTL 60s 从 createdAt 固定不续期） */
export interface TransitionIntentInsertValues {
  readonly id: string;
  readonly householdId: string;
  readonly fromSessionId: string;
  readonly fromGeneration: number;
  readonly deviceSessionId: string;
  readonly profileId: string;
  readonly profileContextVersion: number;
  readonly action: TransitionAction;
  readonly targetMediaId: string;
  readonly targetContentRevision: number;
  readonly targetContinuityRevision: number;
  readonly targetLocatorRevision: number;
  readonly matchRevision: number;
  readonly matchConfidence: 'high' | 'ambiguous' | 'conflict';
  readonly confirmedAmbiguous: boolean;
  readonly position: TransitionPositionFacts;
  readonly finishReceiptId: string | null;
  readonly operationKey: string;
  readonly requestDigest: string;
  readonly slotRevision: number;
  readonly createdAt: string;
  readonly expiresAt: string;
  readonly plan: NextPlanFreezeSnapshot | null;
}

/**
 * 过渡意图事务端口。
 * 所有者：playback（同设备上下文 operation key 唯一；consumed/superseded/cancelled 迁移）。
 */
export interface TransitionIntentTx {
  /** 按幂等键读 intent（同 key 重放以 (operationKey, digest) 判定，不续 TTL） */
  findIntentByOperationKey(householdId: string, deviceSessionId: string, profileContextVersion: number, operationKey: string): TransitionIntentRow | undefined;
  /** 按意图归属读 intent（cleanup 分支：仅原 Profile/完全相同 contextVersion 可用） */
  findIntent(householdId: string, intentId: string): TransitionIntentRow | undefined;
  /** 创建 pending intent（expectedSlotRevision 不符即槽冲突，整体回滚） */
  insertPendingIntent(values: TransitionIntentInsertValues): void;
  /** pending 替换：旧 intent 标 superseded（显式 replace 语义） */
  markIntentSuperseded(householdId: string, intentId: string): void;
  /** 消费提交：consumed + successorId（与槽 consume 同事务；失败整体回滚） */
  markIntentConsumed(householdId: string, intentId: string, successorSessionId: string): void;
  /** 取消迁移（cleanup/协调器显式 stop；已输给消费返回 successor 由读侧判定） */
  markIntentCancelled(householdId: string, intentId: string): void;
}

/**
 * 单后继槽事务端口。
 * 所有者：playback（一来源代次至多一槽；并发不同 operationKey 争用同槽 CAS）。
 */
export interface TransitionSlotTx {
  /** 读槽行（revision/status/successor；首次槽不存在 revision=0 仅为传输初值） */
  findSlot(householdId: string, fromSessionId: string, fromGeneration: number): TransitionSlotRow | undefined;
  /** 首次建槽（slot_revision>=1 持久行；open 态） */
  ensureOpenSlot(householdId: string, fromSessionId: string, fromGeneration: number): number;
  /** CAS 预留槽（expectedSlotRevision 命中才 reserved + 绑定 activeIntent；冲突整体回滚） */
  reserveSlot(householdId: string, fromSessionId: string, fromGeneration: number, expectedSlotRevision: number, activeIntentId: string): number;
  /** 消费闭合槽（consumed 永久，绑定 successor；consumed 槽任何新 key 409 语义） */
  consumeSlot(householdId: string, fromSessionId: string, fromGeneration: number, expectedSlotRevision: number, intentId: string, successorSessionId: string): void;
  /** cleanup 释放槽（reserved→open；pending intent 取消同事务） */
  releaseSlot(householdId: string, fromSessionId: string, fromGeneration: number, expectedSlotRevision: number): void;
}

/**
 * 点播写入权时钟事务端口。
 * 所有者：personal-data（epoch 分配：可跳号不可重置，不接受客户端指定）。
 */
export interface ProgressClockTx {
  /** 短事务分配 epoch 并自增（与 session/绑定写入同 commit，失败回滚不消耗号） */
  allocateProgressEpoch(householdId: string, profileId: string): number;
}

/** 固定输入绑定写入值集（playback_input_binding 新行；resolved_input_id 私有不透明） */
export interface InputBindingInsertValues {
  readonly id: string;
  readonly householdId: string;
  readonly sessionId: string;
  readonly generation: number;
  readonly playbackSourceId: string;
  readonly sourceId: string;
  readonly locatorRevision: number;
  readonly detailRevision: number | null;
  readonly contentRevision: number;
  readonly continuityRevision: number | null;
  readonly evidenceState: 'unverified' | 'verified' | null;
  readonly evidenceDigest: string | null;
  readonly resolvedInputId: string;
  readonly resolvedAt: string;
  readonly expiresAt: string;
  readonly startBasis: StartBasis;
  readonly frozenStartSeconds: number | null;
}

/**
 * 固定输入绑定事务端口。
 * 所有者：playback（§1 PlaybackInputLifecyclePort 写面：probe/资产/转换/seek 统一消费输入 ID；
 * 每 session/generation 至多一有效绑定）。
 */
export interface InputBindingTx {
  /** 读当前代有效绑定（同 source 校验与 probe 事实核对基准） */
  findActiveBinding(householdId: string, sessionId: string, generation: number): InputBindingRow | undefined;
  /** 写 generation 绑定（session/generation 唯一；transition_carry 冻结值随行落库） */
  insertBinding(values: InputBindingInsertValues): void;
  /** probe 后冻结起点（frozen_start_seconds；NULL 合法，仅冻结一次） */
  freezeStartSeconds(householdId: string, bindingId: string, frozenStartSeconds: number | null): void;
  /** 绑定清理推进（cleanup_state pending→complete；租约过期由用例判 failed） */
  markBindingCleanupComplete(householdId: string, bindingId: string): void;
}

/** 下一集计划写入值集（playback_next_plan 新行；不可变、无 slot/epoch 写） */
export interface NextPlanInsertValues {
  readonly id: string;
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
  readonly historyRevision: number;
  readonly historyChoiceRequired: boolean;
  readonly createdAt: string;
  readonly expiresAt: string;
}

/**
 * 下一集计划事务端口（§5 审查新增）。
 * 所有者：playback（NextPlanPort：事务内复核修订后持久不可变计划；创建/消费检查精确快照）。
 */
export interface NextPlanTx {
  /** 读计划精确快照（创建/消费复核；序列/详情/目标修订/历史变化即 NEXT_PLAN_CHANGED 输入） */
  findPlan(householdId: string, nextPlanId: string): NextPlanRow | undefined;
  /** 持久不可变计划（TTL 60s 固定；history_revision 无历史=0） */
  insertImmutablePlan(values: NextPlanInsertValues): void;
  /** 每设备活计划上限淘汰（最早过期优先；被 pending/consumed intent 引用者不淘汰） */
  evictSurplusPlans(householdId: string, deviceSessionId: string, keepCount: number): void;
}

/** 播放阶段观测写入值集（playback_phase_observation 新行；event_seq 幂等、不写 ledger/历史） */
export interface PhaseObservationInsertValues {
  readonly householdId: string;
  readonly sessionId: string;
  readonly generation: number;
  readonly eventSeq: number;
  readonly digest: string;
  readonly eventType: 'playing' | 'pause' | 'seeking' | 'seeked' | 'waiting' | 'ratechange' | 'error';
  readonly positionSeconds: number;
  readonly playbackRate: number;
  readonly serverReceivedAt: string;
  readonly tailAnchorPositionSeconds: number | null;
  readonly tailAnchorTime: string | null;
  readonly deliveredSeen: boolean;
}

/**
 * 播放阶段观测事务端口。
 * 所有者：playback（最新 event_seq 幂等：同 seq 同载荷重放、冲突 409；限流 2Hz/会话由用例执行）。
 */
export interface ObservationTx {
  /** 读既存观测（同 seq digest 比对：相同重放返回原结果，不同即冲突判定输入） */
  findObservation(householdId: string, sessionId: string, eventSeq: number): PhaseObservationRow | undefined;
  /** 写观测行（尾锚 position/time 成对由 CHECK 落实；不写个人 ledger/历史） */
  insertObservation(values: PhaseObservationInsertValues): void;
}
/* 010 T090 knip 清理:原文件尾「工作集聚合」段(ProgressFinishWorkSet/
 * TransitionConsumeWorkSet/PlayingObservationWorkSet/TransitionCleanupWorkSet 四个
 * 聚合接口)已删除——零代码消费;实际编排以 playback-finish/transition/transition-
 * cleanup 等服务 deps 注入函数束 + 组合根绑定后 txStores 承载(对齐 T029
 * materialization.service 先例),§2/§5 步骤顺序契约仍以 internal-ports.md 为权威。
 */
