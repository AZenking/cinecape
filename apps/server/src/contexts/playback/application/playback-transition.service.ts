/**
 * 010-online-vod T060(US3)—— next/manual_next 过渡编排服务(应用层纯类,单测直构)。
 *
 * 职责(tasks.md T060 原文):next/manual_next、显式替换 pending、GET 恢复及 cancel
 * 输家返回 successor;NEXT_HISTORY_CHOICE_REQUIRED 阻止覆盖目标记录,重验偏好/序列/
 * 双方上下文及目标权限;switch 分支在 US4 完成前明确拒绝。审查补充:next-plans 端点
 * 编排,next/manual_next 必须 nextPlanRef,禁止旧 historyChoiceConfirmed(400 归
 * 控制器严格 schema;本服务消费的 IntentInput 由该 schema 产出)。
 *
 * 编排面(T059 接线点逐条):
 * - POST /playback/next-plans → createNextPlan:来源只读上下文授权(T059)→ next 资格
 *   =context.finishReceipt.autoNextEligible(经 findFinishReceiptBySession;manual_next
 *   免查)→ 序列目标经 nextEpisodeFor(online-vod 发布面;fromSession 的 mediaId→
 *   episodeKey/lineId→标题级 next)→ 目标策略(authorizeResolve;拒绝 404 MEDIA_NOT_FOUND
 *   同形)→ 快照冻结(序列/详情/目标三维修订/历史 revision/偏好)→
 *   store.createNextPlan(values,{keepCount:20})(A6 上限淘汰必经 cap 参数,不另写淘汰);
 * - POST /playback/transition-intents → createIntent:switch/recover_switch 经
 *   US4/T072 真实分支(候选绑定 registeredCandidateRef+previewRevision CAS/匹配结论
 *   carryPositionEligibility/carry checkpoint 精确匹配当前代 ledger/recover 60s 故障
 *   窗与禁源拒绝);计划 ref 绑定校验(设备/Profile/context/
 *   来源代次/action;淘汰 ref 与未知 ref 同形 404 NOT_FOUND)→ next 资格(manual_next
 *   免查)→ 计划行快照对比当前序列/详情/目标三维/历史 revision(NEXT_PLAN_CHANGED
 *   判定归本服务;A3/A4/A5)→ 偏好(next 必开)→ store.createTransitionIntent
 *   (created/replayed/idempotency_conflict/slot_conflict/410 判别映射 201/200/409×2/410);
 * - GET /playback/transition-intents/:id → getIntent:归属(设备/Profile/context 全等,
 *   跨设备/跨 Profile/旧 context/随机 id 404 同形)+ findIntentById + isIntentExpired
 *   (pending 过 TTL → 410 TRANSITION_EXPIRED,不误作可重新消费);
 * - POST …/:id/cancel → cancelIntent:store.cancelTransitionIntent outcome 直映射
 *   (cancelled/superseded/expired/already_consumed+successor;D1 的 cancelled 回执
 *   slotRevision=释放前 revision,已终态分支回执当前 revision);
 * - resolve 消费分支(T061 完整判别面)→ resolveTransition:归属 →
 *   consumed 重放 200 同后继不重验且经 successorPreparer.toDto 全保真(「成功消费重放
 *   不再执行计划过期/变化检查」;不因计划过期再建会话)→
 *   终态意图 409 / 过期 410 → 目标权限重验 → 消费事务(TransitionConsumeWorkSet 步骤序:
 *   来源只读上下文授权(T059 完整端口,事务首步:data-model §7)→ intent/slot 校验 →
 *   计划快照与偏好事务内重验(personalData.findVodPreferences/findTargetHistory)→
 *   preparing session → epoch/ledger → store.consumeTransition
 *   提交 consumed/后继;任一失败整体回滚零残留,F 组注入粒度锚=playback/personalData
 *   参与者触达序)→ 固定输入绑定(frozen_start_seconds 保持 NULL 直到 probe)→
 *   fire-and-forget 后继准备(携计划快照历史 revision;probe/冻结经既有管线,漂移重验
 *   与冻结一次归 resolver 过渡终段)。过渡桶限频 10/min/DeviceSession(api §0;§7
 *   next-plans 沿用同桶)。
 *
 * NEXT_HISTORY_CHOICE_REQUIRED 语义(T052 钉死形态):positionMode 即用户对计划快照的
 * 显式选择(无单独确认字段);historyChoiceConfirmed 一律 400(控制器 strict schema);
 * 「阻止覆盖目标记录」由计划快照历史 revision 对比承担 —— 计划后目标历史变化即
 * 409 NEXT_PLAN_CHANGED,不用新位置替换用户确认(创建 A5 与消费 C6 双重验)。
 *
 * 依赖边界(ADR-0015 D1/R2):跨上下文仅消费发布面(nextEpisodeFor/readTargetHistory,
 * 纯函数 + 纯类型);目录/身份只读事实经本文件声明的结构端口注入(装配层 SQL 适配,
 * VodTreePolicyGate 只读投影先例);持久写经 T059 store seam 与 UNIT_OF_WORK 工作集,
 * 事务句柄不越出 infrastructure。零网络:probe/上游访问全部在事务外的既有管线。
 */
import { createHash, randomUUID } from 'node:crypto';
import { ProblemCode } from '@hmp/shared';
import { createDomainError, DomainError } from '@platform/http-common/domain-error';
import type { SessionContext } from '@platform/http-common/current-session.decorator';
import { nextEpisodeFor, type NextEpisodeOutcome, type SequenceNavigationStore } from '@contexts/online-vod';
import { carryPositionEligibility } from '@contexts/online-vod';
import type { TargetHistorySnapshot } from '@contexts/personal-data';
import type { PlaybackTransitionStore } from '@contexts/playback/application/playback-transition-store.port';
import type { TransitionSourceContextService, ReadonlyTransitionSourceContext } from '@contexts/playback/application/transition-source-context.service';
import { carryCheckpointDecision, isRecoverableMediaFailure, isRecoverWindowOpen } from '@contexts/playback/domain/transition.rules';
import { isIntentExpired } from '@contexts/playback/domain/transition.rules';
import type {
  PlaybackErrorCode,
  PlaybackSessionView,
} from '@contexts/playback/domain/playback.types';
import type { PlaybackDto } from '@contexts/playback/application/playback-resolver.service';
import type {
  NextPlanRow,
  TransitionIntentRow,
  TransitionSlotRow,
} from '@contexts/playback/application/playback-work-set.port';
import type {
  FinishReceiptRow,
  TransitionIntentCancelOutcome,
  TransitionIntentCreateOutcome,
  TransitionIntentCreateValues,
} from '@contexts/playback/application/playback-transition-store.port';

/* ------------------------------------------------------------------ */
/* 回执形态(api.md §1 IntentReply 11 键 / §7 I3 NextPlanReply 9 键)      */
/* ------------------------------------------------------------------ */

/** IntentReply(api.md §1;additionalProperties:false,键集恒定) */
export interface TransitionIntentReply {
  readonly id: string;
  readonly fromSessionId: string;
  readonly fromGeneration: number;
  readonly action: string;
  readonly targetMediaId: string;
  readonly positionMode: string;
  readonly matchConfidence: string;
  readonly slotRevision: number;
  readonly status: string;
  readonly expiresAt: string;
  readonly successorSessionId: string | null;
}

/** NextPlanReply(api.md §7 I3;9 键恒定) */
export interface NextPlanReply {
  readonly nextPlanRef: string;
  readonly targetMediaId: string;
  readonly label: string;
  readonly sequenceRevision: number;
  readonly detailRevision: number;
  readonly historyRevision: number;
  readonly historyChoiceRequired: boolean;
  readonly history: Record<string, unknown> | null;
  readonly expiresAt: string;
}

/** TransitionCancelReply(api.md §5;3 键恒定) */
export interface TransitionCancelReply {
  readonly outcome: 'cancelled' | 'already_cancelled' | 'superseded' | 'expired' | 'already_consumed';
  readonly successorSessionId: string | null;
  readonly slotRevision: number;
}

/* ------------------------------------------------------------------ */
/* 请求值面(控制器严格 schema 产物)                                      */
/* ------------------------------------------------------------------ */

/** POST /playback/next-plans 请求(api.md §7 I3) */
export interface NextPlanCommand {
  readonly fromSessionId: string;
  readonly expectedGeneration: number;
  readonly action: 'next' | 'manual_next';
}

/** POST /playback/transition-intents 请求(api.md §5 严格 oneOf 判别分支;控制器 schema 产出) */
export interface TransitionIntentCommand {
  readonly fromSessionId: string;
  readonly expectedGeneration: number;
  readonly action: 'next' | 'manual_next' | 'switch' | 'recover_switch';
  readonly nextPlanRef?: string;
  readonly positionMode?: 'beginning' | 'target_history' | 'carry';
  /** switch/recover_switch 分支(api.md §5):已登记候选映射引用 + 预览修订 CAS */
  readonly targetCandidateRef?: string;
  readonly previewRevision?: number;
  readonly confirmedAmbiguous?: boolean;
  readonly sourceCheckpoint?: { readonly expectedGeneration: number; readonly sampleSeq: number };
  readonly allowEarlierAcceptedPosition?: boolean;
  readonly expectedSlotRevision: number;
  readonly operationKey: string;
}

/** resolve 过渡分支请求(api.md §4:{mediaId,transitionIntentId};startMode 被控制器拒绝) */
export interface TransitionResolveCommand {
  readonly mediaId: string;
  readonly transitionIntentId: string;
}

/** resolve 过渡分支结果(replayed → 200 同后继当前状态;consumed → 201 preparing 形态) */
export type TransitionResolveOutcome =
  | { readonly kind: 'consumed'; readonly sessionId: string; readonly dto: Record<string, unknown> }
  | { readonly kind: 'replayed'; readonly sessionId: string; readonly dto: PlaybackDto | Record<string, unknown> };

/* ------------------------------------------------------------------ */
/* 依赖端口(结构最小面;装配层适配,单测直构真实 store/规则面)             */
/* ------------------------------------------------------------------ */

/** 身份只读事实(当前 DeviceSession 的激活档案与上下文版本;装配=playbackStore 投影) */
export interface TransitionIdentityPort {
  findTrustedSession(
    deviceSessionId: string,
  ): { readonly activeProfileId: string | null; readonly profileContextVersion: number } | undefined;
}

/**
 * 在线目录只读事实端口(计划目标确定与快照对比;装配层 SQL 只读投影 ——
 * 目录行等级/序列为权威,T017 VodTreePolicyGate 同先例,禁逐集 N+1)。
 */
export interface TransitionVodFactsPort {
  /** nextEpisodeFor(online-vod 发布面)的导航读面(装配层结构适配) */
  readonly navigation: SequenceNavigationStore;
  /** fromSession mediaId → vod 分集导航身份(非 vod 子项 undefined) */
  findEpisodeRefByMedia(
    householdId: string,
    mediaId: string,
  ): { readonly lineId: string; readonly episodeKey: string } | undefined;
  /** 线 → 标题 id(导航归属) */
  findTitleIdOfLine(householdId: string, lineId: string): string | undefined;
  /** 当前导航快照修订(当前详情指针下最大 sequence_revision) */
  currentSequenceRevision(householdId: string, titleId: string): number;
  /** 标题当前指针修订 + 定位修订(计划 detail/locator 快照权威) */
  titlePointerFacts(
    householdId: string,
    titleId: string,
  ): { readonly detailRevision: number; readonly locatorRevision: number } | undefined;
  /** 目标集行(展示标签 + 内容/连续性修订;目标 mediaId 权威) */
  findTargetEpisodeRow(
    householdId: string,
    mediaId: string,
  ): { readonly label: string; readonly contentRevision: number | null; readonly continuityRevision: number | null } | undefined;
}

/** 目标授权端口(目标策略/可见性;装配=PlaybackAuthorizationService.authorizeResolve) */
export interface TransitionTargetAuthorizerPort {
  authorizeResolve(
    context: SessionContext,
    mediaId: string,
  ): Promise<{
    readonly snapshot: { readonly deviceId: string; readonly profileContextVersion: number };
    readonly candidates: readonly { readonly playbackSourceId: string; readonly sourceId: string }[];
  }>;
}

/**
 * 换源候选只读事实端口(T072,US4;装配层适配 —— 登记映射为 SQL 投影,匹配结论为
 * online-vod VodCache 候选绑定子面,同一单例;ADR-0015 结构端口惯例):
 * - intent 只接受已登记目标的候选映射(api §7 I1「intent.targetCandidateRef使用
 *   registeredCandidateRef」);伪造/跨家庭/未登记 ref 与不存在同形(调用方 404 同形);
 * - 匹配结论(matchConfidence)是候选列表面的匹配事实 —— 缓存条目过期/缺失
 *   (含登记桥直种候选)返回 undefined,调用方以「登记映射=已验证具体目标」处理
 *   (登记时已通过预览/策略/定位验证;缺结论不降级,报告注记)。
 */
export interface TransitionCandidateFactsPort {
  /** registeredCandidateRef 反查登记映射(伪造/跨家庭 undefined;调用方 404 同形) */
  findRegisteredCandidate(
    householdId: string,
    registeredCandidateRef: string,
  ): {
    readonly candidateRef: string;
    readonly sourceSessionId: string;
    readonly sourceGeneration: number;
    readonly previewRevision: number;
    readonly targetMediaId: string;
    readonly targetContentRevision: number;
    readonly targetContinuityRevision: number;
    readonly targetDetailRevision: number;
    readonly expiresAt: string;
  } | undefined;
  /** 原候选 ref 的列表匹配结论(过期/缺失/登记桥直种 → undefined) */
  findCandidateMatch(
    candidateRef: string,
  ): { readonly matchConfidence: 'high' | 'ambiguous' | 'conflict' } | undefined;
  /**
   * 来源播放资源所属 media_source 启用事实(recover_switch 禁源资格;E3):
   * true=启用 / false=已停用 / undefined=来源会话或播放资源行缺失(调用方按归属
   * 失配处理)。以来源会话 id 为锚(playback_session → playback_source → media_source)。
   */
  isSessionSourceEnabled(householdId: string, fromSessionId: string): boolean | undefined;
}

/** 消费事务工作集 stores(internal-ports §2 TransitionConsumeWorkSet 的 T060 子集) */
export interface TransitionConsumeWorkSetStores {
  readonly playback: {
    findIntent(householdId: string, intentId: string): TransitionIntentRow | undefined;
    findSlot(householdId: string, fromSessionId: string, fromGeneration: number): TransitionSlotRow | undefined;
    findPlan(householdId: string, nextPlanId: string): NextPlanRow | undefined;
    insertPreparingSession(values: {
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
    }): void;
  };
  readonly personalData: {
    findVodPreferences(householdId: string, profileId: string): { readonly autoplayNext: boolean };
    allocateProgressEpoch(householdId: string, profileId: string): number;
    insertLedgerRow(values: {
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
    }): void;
  };
}

/** 消费事务端口(单一 BEGIN IMMEDIATE;抛错即整体回滚;装配=UNIT_OF_WORK 桥) */
export interface TransitionConsumeTxPort {
  runConsumeTx(work: (stores: TransitionConsumeWorkSetStores) => void): void;
}

/** 固定输入绑定端口(消费后继的 start_basis 绑定;装配=PLAYBACK_VOD_INPUT_PORT 桥) */
export interface TransitionInputBinderPort {
  bindFixedInput(input: {
    readonly householdId: string;
    readonly sessionId: string;
    readonly generation: number;
    readonly mediaId: string;
    readonly playbackSourceId: string;
    readonly sourceId: string;
    readonly startBasis: 'beginning' | 'target_history' | 'transition_carry';
  }): Promise<{ readonly bindingId: string }>;
}

/** 后继准备端口(消费提交后 fire-and-forget;装配=resolver.prepareTransitionSuccessor) */
export interface TransitionSuccessorPreparerPort {
  prepareTransitionSuccessor(input: {
    readonly householdId: string;
    readonly profileId: string;
    readonly sessionId: string;
    readonly generation: number;
    readonly version: number;
    readonly bindingId: string;
    readonly mediaId: string;
    readonly deviceSessionId: string;
    readonly candidates: readonly { readonly playbackSourceId: string; readonly sourceId: string }[];
    readonly startBasis: 'beginning' | 'target_history' | 'transition_carry';
    /** target_history 起点冻结值(消费时刻目标历史位置;创建/消费已按计划 revision 重验) */
    readonly frozenStartSeconds?: number;
    /**
     * 计划冻结历史 revision(T061 I3:intent 冻结的计划快照;resolver 在 probe 后经
     * T041 computeStartPosition 带该基准重读当前历史,漂移即准备失败 NEXT_PLAN_CHANGED
     * 语义 —— 会话 failed,不用新位置替换用户确认)。
     */
    readonly expectedHistoryRevision?: number;
  }): void;
  /**
   * 会话状态全保真 DTO(T061 consumed 重放面;装配=resolver.toDto —— PlaybackDto 形态:
   * 含 probe facts 时长/轨道、冻结起点 presentationStart、起点视图 startBasis/
   * resumeDisposition/resumeReason 与 failed failureCode)。缺位(单测装配)时消费方
   * 回退最小状态视图。
   */
  readonly toDto?: (session: PlaybackSessionView) => PlaybackDto;
}

/** 会话读/失败落档端口(重放状态视图 + 绑定失败稳定落档;装配=PlaybackRepository) */
export interface TransitionSessionStorePort {
  getSession(householdId: string, sessionId: string): { readonly ok: boolean; readonly value?: PlaybackSessionView; readonly code?: string; readonly detail?: string };
  failSession(
    sessionId: string,
    input: { readonly cas: { readonly expectedVersion: number; readonly expectedGeneration: number }; readonly failureCode: PlaybackErrorCode; readonly at?: string },
  ): void;
}

/**
 * 过渡限频端口(T061;api §0「创建intent/测速各10/min/DeviceSession」+ §7 next-plans
 * 「沿用过渡10/min限流」):桶数值权威=playback-budgets
 * (transitionIntentsPerDeviceSessionPerMinute=10),词表=playback-rate-limit.service
 * 'transition_intent' 桶。缺位(单测装配)时不限频;计数点=「通过检查」的请求(含随后
 * 被业务拒绝者,防绕过);Retry-After 响应头属控制器装配面(ProblemJsonFilter 无动态头)。
 */
export interface TransitionRateLimitPort {
  acquire(deviceId: string): { readonly ok: true } | { readonly ok: false; readonly retryAfterSeconds: number };
}

export interface PlaybackTransitionServiceDeps {
  readonly store: PlaybackTransitionStore;
  readonly sourceContext: TransitionSourceContextService;
  readonly identity: TransitionIdentityPort;
  readonly vodFacts: TransitionVodFactsPort;
  /** 目标历史只读事实(计划冻结与创建期重验;装配=personal-data 发布面 readTargetHistory) */
  readonly personalFacts: {
    findTargetHistory(householdId: string, profileId: string, mediaId: string): TargetHistorySnapshot | null;
  };
  readonly targetAuthorizer: TransitionTargetAuthorizerPort;
  /**
   * 换源候选只读事实(switch/recover_switch 候选绑定校验;T072)。可选(单测装配面:
   * 既有 next/manual_next 单测直构不含本端口);switch/recover_switch 分支缺位时
   * fail-closed(稳定 500 形态,不静默放行未装配的候选面)。
   */
  readonly candidateFacts?: TransitionCandidateFactsPort;
  readonly consumeTx: TransitionConsumeTxPort;
  readonly inputBinder: TransitionInputBinderPort;
  readonly successorPreparer: TransitionSuccessorPreparerPort;
  readonly sessionStore: TransitionSessionStorePort;
  /** 过渡限频桶(10/min/DeviceSession;缺位不限频 —— 单测装配面) */
  readonly transitionRateLimit?: TransitionRateLimitPort;
  /** 注入时钟(ms;缺省真实系统时钟;单测注入确定值) */
  readonly clock?: () => number;
}

/* ------------------------------------------------------------------ */
/* 服务                                                                  */
/* ------------------------------------------------------------------ */

/** 每设备活计划上限(data-model §10;store cap 参数语义,勿另写淘汰) */
const NEXT_PLAN_KEEP_COUNT = 20;

/** 同形 404 身份封套(归属失配/不存在共用同一 detail,不可借错误判别存在性) */
function notFoundSameShape(): DomainError {
  return new DomainError(404, ProblemCode.PLAYBACK_NOT_FOUND, '播放会话不存在');
}

function intentReplyOf(row: TransitionIntentRow): TransitionIntentReply {
  return {
    id: row.id,
    fromSessionId: row.fromSessionId,
    fromGeneration: row.fromGeneration,
    action: row.action,
    targetMediaId: row.targetMediaId,
    positionMode: row.positionMode,
    matchConfidence: row.matchConfidence,
    slotRevision: row.slotRevision,
    status: row.status,
    expiresAt: row.expiresAt,
    successorSessionId: row.successorId,
  };
}

/** preparing 形态状态 DTO(消费响应;票字段恒空,发票仍走 renew) */
function preparingDto(
  sessionId: string,
  startBasis: 'beginning' | 'target_history' | 'transition_carry',
): Record<string, unknown> {
  return {
    id: sessionId,
    state: 'preparing',
    version: 1,
    generation: 1,
    desiredPaused: false,
    delivery: null,
    positionSeconds: 0,
    durationSeconds: null,
    timelineOffsetSeconds: 0,
    presentationStartSeconds: 0,
    ticketExpiresAt: null,
    playbackUrl: null,
    tracks: { audio: [], subtitles: [] },
    startBasis,
    resumeDisposition: 'pending',
    resumeReason: null,
  };
}

export class PlaybackTransitionService {
  private readonly clock: () => number;

  constructor(private readonly deps: PlaybackTransitionServiceDeps) {
    this.clock = deps.clock ?? (() => Date.now());
  }

  private nowIso(): string {
    return new Date(this.clock()).toISOString();
  }

  /**
   * 过渡桶限频(T061;api §0 10/min/DeviceSession):next-plans 与 transition-intents
   * 共享同一 DeviceSession 过渡桶,超限 429 PLAYBACK_RATE_LIMITED。计数点=进入本服务
   * 的请求(含随后被业务拒绝者,与播放控制桶同款防绕过口径);Retry-After 秒数进 detail
   * (响应头注入属控制器装配面,ProblemJsonFilter 注册表无动态头)。
   */
  private requireTransitionSlot(context: SessionContext): void {
    const limiter = this.deps.transitionRateLimit;
    if (limiter === undefined) {
      return;
    }
    const outcome = limiter.acquire(context.session.deviceId);
    if (!outcome.ok) {
      throw new DomainError(
        429,
        ProblemCode.PLAYBACK_RATE_LIMITED,
        `过渡请求超出 10 次/分钟限频,请 ${outcome.retryAfterSeconds} 秒后重试`,
      );
    }
  }

  /** 当前身份事实(无激活档案 403 既有语义;SessionGuard 已验令牌) */
  private requireIdentity(context: SessionContext): { readonly profileId: string; readonly contextVersion: number } {
    const trusted = this.deps.identity.findTrustedSession(context.session.id);
    if (trusted === undefined) {
      throw notFoundSameShape();
    }
    if (trusted.activeProfileId === null) {
      throw new DomainError(403, ProblemCode.ACTIVE_PROFILE_REQUIRED, '请先选择当前观看档案');
    }
    return { profileId: trusted.activeProfileId, contextVersion: trusted.profileContextVersion };
  }

  /** 意图归属校验(设备/Profile/context 全等;跨设备/跨 Profile/旧 context/随机 id 404 同形) */
  private requireOwnedIntent(householdId: string, context: SessionContext, intentId: string, identity: { readonly profileId: string; readonly contextVersion: number }): TransitionIntentRow {
    const intent = this.deps.store.findIntentById(householdId, intentId);
    if (
      intent === undefined ||
      intent.deviceSessionId !== context.session.id ||
      intent.profileId !== identity.profileId ||
      intent.profileContextVersion !== identity.contextVersion
    ) {
      throw notFoundSameShape();
    }
    return intent;
  }

  /* ---------------------------------------------------------------- */
  /* POST /playback/next-plans(§7 I3)                                   */
  /* ---------------------------------------------------------------- */

  async createNextPlan(context: SessionContext, command: NextPlanCommand): Promise<NextPlanReply> {
    // 过渡桶限频(§7 next-plans「沿用过渡10/min限流」;§0 10/min/DeviceSession)
    this.requireTransitionSlot(context);
    const identity = this.requireIdentity(context);
    const householdId = context.session.householdId;
    // 1. 来源只读上下文授权(A7 同形:来源不存在/跨设备/旧 context 与目标策略拒绝
    //    一律 404 MEDIA_NOT_FOUND,不可借错误判别旧会话存在性)
    const source = this.authorizeSourceContextMediaShape(householdId, context, identity, command.fromSessionId, command.expectedGeneration);
    // 2. next 资格(§5:next 必须有 finish receipt;manual_next 免查)
    this.requireNextEligibility(source, command.action);
    // 3. 序列目标(nextEpisodeFor,online-vod 发布面;标题级导航)
    const target = this.resolveNextTarget(householdId, source.mediaId);
    // 4. 目标策略(authorizeResolve;拒绝 404 MEDIA_NOT_FOUND 同形)
    await this.deps.targetAuthorizer.authorizeResolve(context, target.mediaId);
    // 5. 快照冻结(序列/详情/目标三维修订 + 历史 revision)
    const facts = this.freezePlanSnapshot(householdId, identity.profileId, target);
    // 6. 持久不可变计划(每设备 20 上限淘汰必经 store cap 参数)
    const nowIso = this.nowIso();
    const row = this.deps.store.createNextPlan(
      {
        id: randomUUID(),
        ref: randomUUID(),
        householdId,
        deviceSessionId: context.session.id,
        profileId: identity.profileId,
        profileContextVersion: identity.contextVersion,
        fromSessionId: command.fromSessionId,
        fromGeneration: command.expectedGeneration,
        action: command.action,
        targetMediaId: target.mediaId,
        sequenceRevision: facts.sequenceRevision,
        detailRevision: facts.detailRevision,
        targetContentRevision: facts.targetContentRevision,
        targetContinuityRevision: facts.targetContinuityRevision,
        targetLocatorRevision: facts.targetLocatorRevision,
        historyRevision: facts.historyRevision,
        historyChoiceRequired: facts.historyChoiceRequired,
        createdAt: nowIso,
      },
      { keepCount: NEXT_PLAN_KEEP_COUNT },
    );
    return {
      nextPlanRef: row.ref ?? '',
      targetMediaId: row.targetMediaId,
      label: target.label,
      sequenceRevision: row.sequenceRevision,
      detailRevision: row.detailRevision,
      historyRevision: row.historyRevision,
      historyChoiceRequired: facts.historyChoiceRequired,
      history: facts.history,
      expiresAt: row.expiresAt,
    };
  }

  /** 来源上下文授权(next-plans 面 404 MEDIA_NOT_FOUND 同形;A7 同形钉面) */
  private authorizeSourceContextMediaShape(
    householdId: string,
    context: SessionContext,
    identity: { readonly profileId: string; readonly contextVersion: number },
    fromSessionId: string,
    expectedGeneration: number,
  ): ReadonlyTransitionSourceContext {
    let source: ReadonlyTransitionSourceContext;
    try {
      source = this.deps.sourceContext.authorizeReadonlySourceContext({
        householdId,
        deviceSessionId: context.session.id,
        profileId: identity.profileId,
        profileContextVersion: identity.contextVersion,
        fromSessionId,
      });
    } catch (error) {
      if (error instanceof DomainError && error.status === 404) {
        throw new DomainError(404, ProblemCode.MEDIA_NOT_FOUND, '播放媒体不存在');
      }
      throw error;
    }
    if (source.generation !== expectedGeneration) {
      // 来源代次失配 = 调用方来源视图陈旧,与不存在同形(不泄露代次事实)
      throw new DomainError(404, ProblemCode.MEDIA_NOT_FOUND, '播放媒体不存在');
    }
    return source;
  }

  /** next 资格 = finish receipt.autoNextEligible(经 findFinishReceiptBySession;manual_next 免查) */
  private requireNextEligibility(source: ReadonlyTransitionSourceContext, action: 'next' | 'manual_next'): FinishReceiptRow | undefined {
    if (action !== 'next') {
      return undefined;
    }
    const receipt = source.finishReceipt;
    if (receipt === undefined || !receipt.autoNextEligible) {
      throw createDomainError('SOURCE_NOT_TERMINAL');
    }
    return receipt;
  }

  /** 序列目标确定(fromSession mediaId → episodeKey/lineId → 标题级 next;无确定下一集 404) */
  private resolveNextTarget(householdId: string, fromMediaId: string): {
    readonly mediaId: string;
    readonly label: string;
    readonly episodeKey: string;
    readonly lineKey: string;
    readonly titleId: string;
  } {
    const episodeRef = this.deps.vodFacts.findEpisodeRefByMedia(householdId, fromMediaId);
    const titleId = episodeRef === undefined ? undefined : this.deps.vodFacts.findTitleIdOfLine(householdId, episodeRef.lineId);
    if (episodeRef === undefined || titleId === undefined) {
      throw createDomainError('VOD_NEXT_UNAVAILABLE');
    }
    const outcome: NextEpisodeOutcome = nextEpisodeFor(this.deps.vodFacts.navigation, {
      householdId,
      titleId,
      lineId: null,
      currentEpisodeKey: episodeRef.episodeKey,
    });
    if (outcome.next === null || outcome.next.mediaId === null) {
      // 末集/缺集/歧义同归:无确定下一集,停止连播(api §6;不落计划行)
      throw createDomainError('VOD_NEXT_UNAVAILABLE');
    }
    const row = this.deps.vodFacts.findTargetEpisodeRow(householdId, outcome.next.mediaId);
    if (row === undefined) {
      throw createDomainError('VOD_NEXT_UNAVAILABLE');
    }
    return {
      mediaId: outcome.next.mediaId,
      label: row.label,
      episodeKey: outcome.next.episodeKey,
      lineKey: outcome.next.lineKey,
      titleId,
    };
  }

  /** 计划快照冻结(序列/详情/目标三维修订 + 历史;无历史 revision=0 仅快照语义) */
  private freezePlanSnapshot(
    householdId: string,
    profileId: string,
    target: { readonly mediaId: string; readonly titleId: string },
  ): {
    readonly sequenceRevision: number;
    readonly detailRevision: number;
    readonly targetContentRevision: number;
    readonly targetContinuityRevision: number;
    readonly targetLocatorRevision: number;
    readonly historyRevision: number;
    readonly historyChoiceRequired: boolean;
    readonly history: Record<string, unknown> | null;
  } {
    const pointer = this.deps.vodFacts.titlePointerFacts(householdId, target.titleId);
    if (pointer === undefined) {
      throw createDomainError('VOD_NEXT_UNAVAILABLE');
    }
    const row = this.deps.vodFacts.findTargetEpisodeRow(householdId, target.mediaId);
    if (row === undefined) {
      throw createDomainError('VOD_NEXT_UNAVAILABLE');
    }
    const history = this.deps.personalFacts.findTargetHistory(householdId, profileId, target.mediaId);
    const historyChoiceRequired = history !== null && !history.completed;
    return {
      sequenceRevision: Math.max(1, this.deps.vodFacts.currentSequenceRevision(householdId, target.titleId)),
      detailRevision: Math.max(1, pointer.detailRevision),
      targetContentRevision: Math.max(1, row.contentRevision ?? 1),
      targetContinuityRevision: Math.max(1, row.continuityRevision ?? 1),
      targetLocatorRevision: Math.max(1, pointer.locatorRevision),
      historyRevision: history?.revision ?? 0,
      historyChoiceRequired,
      history: history === null ? null : this.historySummaryOf(history),
    };
  }

  /** 计划 history 摘要(HistorySummary 判定面最小子集;不泄writer身份) */
  private historySummaryOf(history: TargetHistorySnapshot): Record<string, unknown> {
    return {
      mediaId: history.mediaId,
      positionSeconds: history.positionSeconds,
      durationSeconds: history.durationSeconds,
      completed: history.completed,
      revision: history.revision,
    };
  }

  /* ---------------------------------------------------------------- */
  /* POST /playback/transition-intents(§5)                              */
  /* ---------------------------------------------------------------- */

  async createIntent(
    context: SessionContext,
    command: TransitionIntentCommand,
  ): Promise<{ readonly httpStatus: 200 | 201; readonly reply: TransitionIntentReply }> {
    // 过渡桶限频(api §0「创建intent 10/min/DeviceSession」;重放/冲突同样计数防绕过)
    this.requireTransitionSlot(context);
    const identity = this.requireIdentity(context);
    const householdId = context.session.householdId;
    // 1. 分支判别:switch/recover_switch 走 US4/T072 真实分支(候选绑定/carry
    //    checkpoint/故障恢复窗),next/manual_next 走计划分支(T060 既有语义不变)
    if (command.action === 'switch' || command.action === 'recover_switch') {
      return this.createSwitchIntent(context, command, identity, householdId);
    }
    if (command.nextPlanRef === undefined || (command.positionMode !== 'beginning' && command.positionMode !== 'target_history')) {
      throw new DomainError(400, ProblemCode.VALIDATION_FAILED, 'next/manual_next 必须携带 nextPlanRef 与 positionMode');
    }
    // 收窄(上两步守卫后 TS 可判定;后续面只服务 next/manual_next)
    const action: 'next' | 'manual_next' = command.action;
    const nextPlanRef: string = command.nextPlanRef;
    const positionMode: 'beginning' | 'target_history' = command.positionMode;
    // 2. 双方上下文授权(来源只读上下文;A→B→A 不等即 404 同形)
    const source = this.deps.sourceContext.authorizeReadonlySourceContext({
      householdId,
      deviceSessionId: context.session.id,
      profileId: identity.profileId,
      profileContextVersion: identity.contextVersion,
      fromSessionId: command.fromSessionId,
    });
    if (source.generation !== command.expectedGeneration) {
      throw notFoundSameShape();
    }
    // 3. 计划 ref 绑定校验(设备/Profile/context/来源代次/action;淘汰 ref 与未知 ref 404 同形 NOT_FOUND)
    const plan = this.requireBoundPlan(householdId, context, identity, command, nextPlanRef);
    // 4. next 资格(finish receipt.autoNextEligible;manual_next 免查)
    const receipt = this.requireNextEligibility(source, action);
    // 5. 计划行快照对比当前值(NEXT_PLAN_CHANGED 判定;创建与消费双重验)
    this.assertPlanSnapshotCurrent(householdId, plan, identity.profileId);
    // 6. 偏好重验(next 必开;manual_next 免偏好)
    if (action === 'next' && !this.currentAutoplayNext(householdId, identity.profileId)) {
      throw createDomainError('NEXT_PLAN_CHANGED');
    }
    // 7. scope 摘要(同 key 同摘要重放/异摘要冲突;TTL/槽 CAS 判定在 store 单事务)
    const requestDigest = createHash('sha256')
      .update(
        JSON.stringify({
          fromSessionId: command.fromSessionId,
          expectedGeneration: command.expectedGeneration,
          action,
          nextPlanRef,
          positionMode,
          expectedSlotRevision: command.expectedSlotRevision,
        }),
      )
      .digest('hex');
    const values: TransitionIntentCreateValues = {
      id: randomUUID(),
      householdId,
      fromSessionId: command.fromSessionId,
      fromGeneration: command.expectedGeneration,
      deviceSessionId: context.session.id,
      profileId: identity.profileId,
      profileContextVersion: identity.contextVersion,
      action,
      targetMediaId: plan.targetMediaId,
      targetContentRevision: plan.targetContentRevision,
      targetContinuityRevision: plan.targetContinuityRevision,
      targetLocatorRevision: plan.targetLocatorRevision,
      matchRevision: 1,
      matchConfidence: 'high',
      confirmedAmbiguous: false,
      position: { mode: positionMode },
      finishReceiptId: receipt !== undefined ? command.fromSessionId : null,
      operationKey: command.operationKey,
      requestDigest,
      createdAt: this.nowIso(),
      plan: {
        nextPlanId: plan.id,
        sequenceRevision: plan.sequenceRevision,
        detailRevision: plan.detailRevision,
        historyRevision: plan.historyRevision,
        historyChoiceRequired: plan.historyChoiceRequired === 1,
        expiresAt: plan.expiresAt,
      },
    };
    const outcome: TransitionIntentCreateOutcome = this.deps.store.createTransitionIntent(values, command.expectedSlotRevision);
    switch (outcome.kind) {
      case 'created':
        return { httpStatus: 201, reply: intentReplyOf(outcome.intent) };
      case 'replayed':
        // 同 key 重放 200 同结果,不续 TTL、不改槽(api §5)
        return { httpStatus: 200, reply: intentReplyOf(outcome.intent) };
      case 'idempotency_conflict':
        throw createDomainError('IDEMPOTENCY_CONFLICT');
      case 'slot_conflict':
        throw this.slotConflict(outcome.slot);
    }
  }

  /** 计划 ref 绑定校验(淘汰 ref 与未知 ref 同形 404 NOT_FOUND,不可判别存在性) */
  private requireBoundPlan(
    householdId: string,
    context: SessionContext,
    identity: { readonly profileId: string; readonly contextVersion: number },
    command: TransitionIntentCommand,
    nextPlanRef: string,
  ): NextPlanRow {
    const plan = this.deps.store.findNextPlanByRef(householdId, nextPlanRef);
    if (
      plan === undefined ||
      plan.deviceSessionId !== context.session.id ||
      plan.profileId !== identity.profileId ||
      plan.profileContextVersion !== identity.contextVersion ||
      plan.fromSessionId !== command.fromSessionId ||
      plan.fromGeneration !== command.expectedGeneration
      // 注:计划 action 不参与绑定判定 —— 计划是目标快照(§7 I3「计划按设备/Profile/
      // context/来源代次/action 绑定」的 action 维度约束计划自身落库面);同一计划可被
      // next 或 manual_next 意图消费(B3 钉面:manual_next 计划 + next 意图 + 资格校验)。
    ) {
      throw new DomainError(404, ProblemCode.NOT_FOUND, '下一集计划不存在或已淘汰,请重新获取');
    }
    return plan;
  }

  /**
   * 计划行快照 vs 当前值(NEXT_PLAN_CHANGED 判定维度:详情/序列/目标内容/连续性/定位/
   * 历史;A4/A5/C5/C6)。任一变化即 409,不消耗槽、不落 intent、不建后继。
   */
  private assertPlanSnapshotCurrent(householdId: string, plan: NextPlanRow, profileId: string): void {
    const episodeRef = this.deps.vodFacts.findEpisodeRefByMedia(householdId, plan.targetMediaId);
    const titleId = episodeRef === undefined ? undefined : this.deps.vodFacts.findTitleIdOfLine(householdId, episodeRef.lineId);
    const pointer = titleId === undefined ? undefined : this.deps.vodFacts.titlePointerFacts(householdId, titleId);
    const row = this.deps.vodFacts.findTargetEpisodeRow(householdId, plan.targetMediaId);
    const current = {
      detailRevision: pointer?.detailRevision ?? -1,
      sequenceRevision: titleId === undefined ? -1 : this.deps.vodFacts.currentSequenceRevision(householdId, titleId),
      targetContentRevision: row === undefined ? -1 : Math.max(1, row.contentRevision ?? 1),
      targetContinuityRevision: row === undefined ? -1 : Math.max(1, row.continuityRevision ?? 1),
      targetLocatorRevision: pointer?.locatorRevision ?? -1,
      historyRevision: this.deps.personalFacts.findTargetHistory(householdId, profileId, plan.targetMediaId)?.revision ?? 0,
    };
    if (
      current.detailRevision !== plan.detailRevision ||
      current.sequenceRevision !== plan.sequenceRevision ||
      current.targetContentRevision !== plan.targetContentRevision ||
      current.targetContinuityRevision !== plan.targetContinuityRevision ||
      current.targetLocatorRevision !== plan.targetLocatorRevision ||
      current.historyRevision !== plan.historyRevision
    ) {
      throw createDomainError('NEXT_PLAN_CHANGED');
    }
  }

  /** 当前偏好(经事务工作集 personalData 参与者;无持久行=传输初值 true) */
  private currentAutoplayNext(householdId: string, profileId: string): boolean {
    let autoplayNext = true;
    this.deps.consumeTx.runConsumeTx((stores) => {
      autoplayNext = stores.personalData.findVodPreferences(householdId, profileId).autoplayNext;
    });
    return autoplayNext;
  }

  /** 槽冲突 409(consumed 槽附原后继引用,detail 承载 —— api §5/§0 错误收敛) */
  private slotConflict(slot: TransitionSlotRow | undefined): DomainError {
    const successor = slot?.successorSessionId ?? null;
    return new DomainError(
      409,
      ProblemCode.TRANSITION_SLOT_CONFLICT,
      successor === null
        ? '过渡槽位已被其他操作占用,请恢复既有操作'
        : `过渡槽位已被消费,原后继会话 ${successor}`,
    );
  }

  /* ---------------------------------------------------------------- */
  /* POST /playback/transition-intents —— switch/recover_switch(§5;T072) */
  /* ---------------------------------------------------------------- */

  /**
   * switch/recover_switch 意图创建编排(api.md §5 IntentRequest switch 分支 +
   * §7 I1/I2 + data-model §7/§10;T072):
   * 1. 形态校验(控制器 strict schema 之后的语义面):beginning/target_history 禁
   *    sourceCheckpoint/allowEarlierAcceptedPosition(§10「仅 carry 必填」);carry 必须
   *    携带 sourceCheckpoint(§5「carry必须提供sourceCheckpoint,不接用户position」);
   * 2. 来源只读上下文授权(与 next 分支同形:失配/旧 context 404;A→B→A 不等即 404);
   * 3. recover_switch 来源资格:failed + 可恢复媒体故障类(transition.rules 词表)+
   *    终态后 60s 窗(含界);禁源以授权族 404 优先拒绝(api §6「来源/上下文授权失败
   *    优先于专用错误」);窗口外/非可恢复终态 409 SOURCE_NOT_TERMINAL(「超时走普通
   *    明确新播放,无旧 carry」);
   * 4. 候选绑定(I1):registeredCandidateRef 反查登记映射 —— 伪造/跨家庭/未登记与
   *    源会话/代次绑定失配一律 404 同形(「源阶段/权限变化不能据它创建意图」)+
   *    previewRevision CAS(失配 409 VOD_DETAIL_CHANGED)+ 登记有效期(410
   *    VOD_PREVIEW_EXPIRED);
   * 5. 匹配结论(carry 资格象限,carryPositionEligibility):conflict 禁 carry(400,
   *    「conflict只beginning/target_history且不能继承源位置」);ambiguous 需「confirmed
   *    且具体集」—— 登记映射即具体集锚(ui.md 候选抽屉流:具体目标+版本警告确认发生在
   *    物化/登记之前),confirmedAmbiguous 随意图落库审计(取舍见交付报告);
   * 6. carry checkpoint 精确匹配(carryCheckpointDecision):不等(含明确旧游标)一律
   *    409 SOURCE_PROGRESS_PENDING —— 「仍须精确相等;不自动挑另一个旧位置;未接受样本
   *    不作为 checkpoint」,allowEarlierAcceptedPosition 仅记录用户确认;精确命中后自
   *    ledger 复制 position/duration(§10「所有值服务端读取」;时长未知不得放行 carry
   *    —— playback-state §2「未知duration…carry…均不能据此放行」);
   * 7. 意图落库(carry 三件套+checkpoint+allow 标志满足 0007 CHECK;requestDigest 含
   *    checkpoint/回退选择 —— 同 key 摘要,改变须新 key + slot CAS)。
   */
  private createSwitchIntent(
    context: SessionContext,
    command: TransitionIntentCommand,
    identity: { readonly profileId: string; readonly contextVersion: number },
    householdId: string,
  ): { readonly httpStatus: 200 | 201; readonly reply: TransitionIntentReply } {
    // 1. 形态校验(carry 三件套/检查点与非 carry 的 0007 CHECK 对齐)—— 纯载荷判定
    //    无需候选事实端口:形态非法先 400,候选面装配缺口只在真正读候选事实时
    //    fail-closed(既有 I5 形态用例保持 400 面不变)
    const positionMode = command.positionMode;
    if (positionMode !== 'carry' && positionMode !== 'target_history' && positionMode !== 'beginning') {
      throw new DomainError(400, ProblemCode.VALIDATION_FAILED, 'switch/recover_switch 必须携带 positionMode');
    }
    if (command.targetCandidateRef === undefined || command.previewRevision === undefined) {
      throw new DomainError(400, ProblemCode.VALIDATION_FAILED, 'switch/recover_switch 必须绑定已登记候选与预览修订');
    }
    if (positionMode === 'carry') {
      if (command.sourceCheckpoint === undefined) {
        // carry 必须提供 sourceCheckpoint(api §5;C2 钉面:400 不落 intent)
        throw new DomainError(400, ProblemCode.VALIDATION_FAILED, 'carry 位置模式必须携带来源检查点(sourceCheckpoint)');
      }
    } else if (command.sourceCheckpoint !== undefined || command.allowEarlierAcceptedPosition !== undefined) {
      // beginning/target_history 禁止 checkpoint/回退标志(api §5「禁止sourceCheckpoint和
      // allowEarlierAcceptedPosition字段」;§10「仅 carry 必填」)
      throw new DomainError(400, ProblemCode.VALIDATION_FAILED, 'beginning/target_history 不接受 sourceCheckpoint/allowEarlierAcceptedPosition');
    }
    // 2. 来源只读上下文授权(404 同形)与代次绑定
    const source = this.deps.sourceContext.authorizeReadonlySourceContext({
      householdId,
      deviceSessionId: context.session.id,
      profileId: identity.profileId,
      profileContextVersion: identity.contextVersion,
      fromSessionId: command.fromSessionId,
    });
    if (source.generation !== command.expectedGeneration) {
      throw notFoundSameShape();
    }
    // 3. recover_switch 来源资格(failed + 可恢复媒体故障 + 60s 窗;禁源优先 404)
    if (command.action === 'recover_switch') {
      this.requireRecoverableFailedSource(householdId, source, this.requireCandidateFacts());
    }
    // 4. 候选绑定校验(registeredCandidateRef;I1)
    const candidateFacts = this.requireCandidateFacts();
    const registered = this.requireRegisteredCandidate(householdId, command, source, candidateFacts);
    // 5. carry 资格象限(conflict 禁 carry;报告注记:ambiguous 以登记映射为具体集确认锚)
    const match = candidateFacts.findCandidateMatch(registered.candidateRef);
    const matchConfidence = match?.matchConfidence ?? 'high';
    if (positionMode === 'carry') {
      const eligibility = carryPositionEligibility({
        confidence: matchConfidence,
        confirmedAmbiguous: command.confirmedAmbiguous ?? false,
      });
      if (!eligibility.allowed && eligibility.reason === 'conflict_forbidden') {
        throw new DomainError(400, ProblemCode.VALIDATION_FAILED, '版本冲突候选禁止继承源位置,请选择从头或目标记录');
      }
    }
    // 6. carry checkpoint 精确匹配 + ledger 事实复制(§7 I2/§10)
    const position = this.resolveSwitchPositionFacts(command, source);
    // 7. scope 摘要(checkpoint/回退选择属于摘要 —— 改变须新 key + slot CAS)
    const requestDigest = createHash('sha256')
      .update(
        JSON.stringify({
          fromSessionId: command.fromSessionId,
          expectedGeneration: command.expectedGeneration,
          action: command.action,
          targetCandidateRef: command.targetCandidateRef,
          previewRevision: command.previewRevision,
          positionMode,
          confirmedAmbiguous: command.confirmedAmbiguous ?? false,
          sourceCheckpoint: command.sourceCheckpoint ?? null,
          allowEarlierAcceptedPosition: command.allowEarlierAcceptedPosition ?? null,
          expectedSlotRevision: command.expectedSlotRevision,
        }),
      )
      .digest('hex');
    const values: TransitionIntentCreateValues = {
      id: randomUUID(),
      householdId,
      fromSessionId: command.fromSessionId,
      fromGeneration: command.expectedGeneration,
      deviceSessionId: context.session.id,
      profileId: identity.profileId,
      profileContextVersion: identity.contextVersion,
      action: command.action,
      targetMediaId: registered.targetMediaId,
      targetContentRevision: Math.max(1, registered.targetContentRevision),
      targetContinuityRevision: Math.max(1, registered.targetContinuityRevision),
      targetLocatorRevision: Math.max(1, registered.targetDetailRevision),
      matchRevision: 1,
      matchConfidence,
      confirmedAmbiguous: command.confirmedAmbiguous ?? false,
      position,
      finishReceiptId: null,
      operationKey: command.operationKey,
      requestDigest,
      createdAt: this.nowIso(),
      plan: null,
    };
    const outcome: TransitionIntentCreateOutcome = this.deps.store.createTransitionIntent(values, command.expectedSlotRevision);
    switch (outcome.kind) {
      case 'created':
        return { httpStatus: 201, reply: intentReplyOf(outcome.intent) };
      case 'replayed':
        // 同 key 重放 200 同结果,不续 TTL、不改槽(api §5)
        return { httpStatus: 200, reply: intentReplyOf(outcome.intent) };
      case 'idempotency_conflict':
        throw createDomainError('IDEMPOTENCY_CONFLICT');
      case 'slot_conflict':
        throw this.slotConflict(outcome.slot);
    }
  }

  /**
   * 候选只读事实端口(可选装配)收敛读取:缺位 fail-closed(稳定 500,不静默放行)。
   */
  private requireCandidateFacts(): TransitionCandidateFactsPort {
    const candidateFacts = this.deps.candidateFacts;
    if (candidateFacts === undefined) {
      throw new DomainError(500, ProblemCode.INTERNAL, '换源候选事实端口未装配(switch 分支不可用)');
    }
    return candidateFacts;
  }

  /**
   * recover_switch 来源资格(failed + 可恢复媒体故障类 + 60s 窗;T072):
   * - 禁源(来源播放资源所属 media_source 已停用)以授权族 404 同形优先(api §6
   *   「来源/上下文授权失败优先于专用错误,防止借新错误判别旧会话存在性」;E3);
   * - 非 failed 终态 / 可恢复窗外 / 故障类不可恢复 → 409 SOURCE_NOT_TERMINAL
   *   (「超时走普通明确新播放,无旧 carry」;E2)。
   * 会话全量事实(ended_at/failure_code)经 sessionStore 只读视图,与授权面
   * (sourceContext)分离 —— 授权先行,资格判定读真实 state。
   */
  private requireRecoverableFailedSource(
    householdId: string,
    source: ReadonlyTransitionSourceContext,
    candidateFacts: TransitionCandidateFactsPort,
  ): void {
    const loaded = this.deps.sessionStore.getSession(householdId, source.fromSessionId);
    if (!loaded.ok || loaded.value === undefined) {
      throw notFoundSameShape();
    }
    const session = loaded.value;
    // 禁源:来源播放资源所属来源已停用 → 授权族 404 同形(不得借恢复;E3)
    const sourceEnabled = candidateFacts.isSessionSourceEnabled(householdId, source.fromSessionId);
    if (sourceEnabled === false) {
      throw new DomainError(404, ProblemCode.NOT_FOUND, '来源不可用');
    }
    if (session.state !== 'failed' || !isRecoverableMediaFailure(session.failureCode)) {
      throw createDomainError('SOURCE_NOT_TERMINAL');
    }
    const failedAtMs = session.endedAt !== null ? Date.parse(session.endedAt) : Number.NaN;
    if (Number.isNaN(failedAtMs) || !isRecoverWindowOpen(failedAtMs, this.clock())) {
      // 可恢复窗外:资格关闭,超时走普通明确新播放(data-model §7;E2)
      throw createDomainError('SOURCE_NOT_TERMINAL');
    }
  }

  /**
   * 候选绑定校验(I1):registeredCandidateRef 反查登记映射;伪造/跨家庭/未登记与
   * 源会话/代次绑定失配一律 404 同形(不可判别存在性);previewRevision CAS 失配
   * 409 VOD_DETAIL_CHANGED;登记映射过期 410 VOD_PREVIEW_EXPIRED。
   */
  private requireRegisteredCandidate(
    householdId: string,
    command: TransitionIntentCommand,
    source: ReadonlyTransitionSourceContext,
    candidateFacts: TransitionCandidateFactsPort,
  ): {
    readonly candidateRef: string;
    readonly targetMediaId: string;
    readonly targetContentRevision: number;
    readonly targetContinuityRevision: number;
    readonly targetDetailRevision: number;
  } {
    const registered = candidateFacts.findRegisteredCandidate(householdId, command.targetCandidateRef ?? '');
    if (
      registered === undefined ||
      // 登记映射绑定原来源会话/代次(I1「来源session/generation」;源阶段变化不能据它创建意图)
      registered.sourceSessionId !== source.fromSessionId ||
      registered.sourceGeneration !== source.generation
    ) {
      throw new DomainError(404, ProblemCode.NOT_FOUND, '换源候选不存在或未登记,请重新获取候选');
    }
    if (Date.parse(registered.expiresAt) <= this.clock()) {
      throw new DomainError(410, ProblemCode.VOD_PREVIEW_EXPIRED, '候选登记映射已过期,请重新物化候选');
    }
    if (registered.previewRevision !== command.previewRevision) {
      // 预览修订 CAS 失配:候选登记后的预览/详情已前进(D2 钉面 409 VOD_DETAIL_CHANGED)
      throw new DomainError(409, ProblemCode.VOD_DETAIL_CHANGED, '候选预览修订已变化,请重读候选并明确重选');
    }
    return registered;
  }

  /**
   * switch 位置事实(carry checkpoint 精确匹配矩阵;非 carry 为空 CHECK 组):
   * - carry:checkpoint 必填(缺失 400 由 createSwitchIntent 形态段承担)→
   *   carryCheckpointDecision 精确匹配当前代 ledger(不等 409 SOURCE_PROGRESS_PENDING;
   *   allowEarlierAcceptedPosition 仅记录确认不放宽)→ 命中后自 ledger 复制
   *   position/duration(时长未知不放行 —— playback-state §2);
   * - beginning/target_history:位置事实为空组(0007 CHECK;消费面按 startBasis 冻结)。
   */
  private resolveSwitchPositionFacts(
    command: TransitionIntentCommand,
    source: ReadonlyTransitionSourceContext,
  ): TransitionIntentCreateValues['position'] {
    const positionMode = command.positionMode;
    if (positionMode !== 'carry' && positionMode !== 'target_history' && positionMode !== 'beginning') {
      throw new DomainError(400, ProblemCode.VALIDATION_FAILED, 'switch/recover_switch 必须携带 positionMode');
    }
    if (positionMode !== 'carry') {
      return { mode: positionMode };
    }
    const checkpoint = command.sourceCheckpoint;
    if (checkpoint === undefined) {
      throw new DomainError(400, ProblemCode.VALIDATION_FAILED, 'carry 位置模式必须携带来源检查点(sourceCheckpoint)');
    }
    const ledger = source.ledgerCheckpoint;
    const decision = carryCheckpointDecision({
      checkpointGeneration: checkpoint.expectedGeneration,
      checkpointSeq: checkpoint.sampleSeq,
      sourceGeneration: source.generation,
      ledgerLastSampleSeq: ledger?.lastSampleSeq ?? null,
      ledgerGeneration: ledger?.ledgerGeneration ?? null,
      allowEarlierAcceptedPosition: command.allowEarlierAcceptedPosition ?? false,
    });
    if (decision.kind !== 'exact') {
      // 「ledger已前进则重新展示/确认;未接受样本不作为checkpoint」——稳定 409 不泄露
      // 其他设备游标(api §6 SOURCE_PROGRESS_PENDING)
      throw createDomainError('SOURCE_PROGRESS_PENDING');
    }
    if (ledger === undefined || ledger.ledgerPosition === null || ledger.ledgerDuration === null) {
      // 接受游标缺位置/可信时长:carry 不得放行(未知 duration 不能据此放行 carry)
      throw createDomainError('SOURCE_PROGRESS_PENDING');
    }
    return {
      mode: 'carry',
      carryPositionSeconds: ledger.ledgerPosition,
      carryDurationSeconds: ledger.ledgerDuration,
      sourceLedgerSeq: checkpoint.sampleSeq,
      sourceCheckpointGeneration: checkpoint.expectedGeneration,
      sourceCheckpointSeq: checkpoint.sampleSeq,
      allowEarlierAcceptedPosition: command.allowEarlierAcceptedPosition ?? false,
    };
  }

  /* ---------------------------------------------------------------- */
  /* GET /playback/transition-intents/:id(§5)                           */
  /* ---------------------------------------------------------------- */

  getIntent(context: SessionContext, intentId: string): TransitionIntentReply {
    const identity = this.requireIdentity(context);
    const intent = this.requireOwnedIntent(context.session.householdId, context, intentId, identity);
    if (intent.status === 'pending' && isIntentExpired(Date.parse(intent.createdAt), this.clock())) {
      // 过期未消费 410,不误作可重新消费(api §5 GET 行)
      throw createDomainError('TRANSITION_EXPIRED');
    }
    return intentReplyOf(intent);
  }

  /* ---------------------------------------------------------------- */
  /* POST /playback/transition-intents/:id/cancel(§5)                   */
  /* ---------------------------------------------------------------- */

  cancelIntent(context: SessionContext, intentId: string): TransitionCancelReply {
    const identity = this.requireIdentity(context);
    const householdId = context.session.householdId;
    const intent = this.requireOwnedIntent(householdId, context, intentId, identity);
    // 释放前槽快照(D1:cancelled 回执 slotRevision=释放前 revision;终态分支回执当前值)
    const slotBefore = this.deps.store.findSlot(householdId, intent.fromSessionId, intent.fromGeneration);
    const outcome: TransitionIntentCancelOutcome = this.deps.store.cancelTransitionIntent(householdId, intentId, this.nowIso());
    switch (outcome.kind) {
      case 'not_found':
        throw notFoundSameShape();
      case 'cancelled':
        return {
          outcome: 'cancelled',
          successorSessionId: null,
          slotRevision:
            slotBefore !== undefined && slotBefore.status === 'reserved' && slotBefore.activeIntentId === intentId
              ? slotBefore.slotRevision
              : outcome.slotRevision,
        };
      case 'already_cancelled':
        return { outcome: 'already_cancelled', successorSessionId: null, slotRevision: outcome.slotRevision };
      case 'superseded':
        return { outcome: 'superseded', successorSessionId: null, slotRevision: outcome.slotRevision };
      case 'expired':
        return { outcome: 'expired', successorSessionId: null, slotRevision: outcome.slotRevision };
      case 'already_consumed':
        // 取消输给消费:返回原后继引用(仅原上下文可见),后继不受影响
        return { outcome: 'already_consumed', successorSessionId: outcome.successorSessionId, slotRevision: outcome.slotRevision };
    }
  }

  /* ---------------------------------------------------------------- */
  /* resolve 过渡分支(§4;T061 完整判别面,本交付最小接线)                  */
  /* ---------------------------------------------------------------- */

  async resolveTransition(
    context: SessionContext,
    command: TransitionResolveCommand,
  ): Promise<TransitionResolveOutcome> {
    const identity = this.requireIdentity(context);
    const householdId = context.session.householdId;
    const intent = this.requireOwnedIntent(householdId, context, command.transitionIntentId, identity);
    // 1. 已消费重放:200 同后继当前状态,不重建、不再次执行计划过期/变化检查(api §4;
    //    成功重放不因计划过期再建会话)。DTO 经 resolver.toDto 全保真(PlaybackDto 形态:
    //    probe facts 时长/轨道、冻结起点、起点视图与 failed failureCode;T061)—— 缺位
    //    装配回退最小状态视图。
    if (intent.status === 'consumed') {
      const successorId = intent.successorId;
      if (successorId === null) {
        throw notFoundSameShape();
      }
      const loaded = this.deps.sessionStore.getSession(householdId, successorId);
      if (!loaded.ok || loaded.value === undefined) {
        throw notFoundSameShape();
      }
      // 成员调用形态(this=端口对象;装配=resolver 实例方法,不可先提取再调用)
      const preparer = this.deps.successorPreparer;
      return {
        kind: 'replayed',
        sessionId: successorId,
        dto: preparer.toDto !== undefined ? preparer.toDto(loaded.value) : this.statusViewOf(householdId, successorId),
      };
    }
    // 2. 终态意图不可再用(cancelled/superseded);过期未消费 410 不误作可重新消费
    if (intent.status !== 'pending') {
      throw createDomainError('TRANSITION_SLOT_CONFLICT');
    }
    if (isIntentExpired(Date.parse(intent.createdAt), this.clock())) {
      throw createDomainError('TRANSITION_EXPIRED');
    }
    if (command.mediaId !== intent.targetMediaId) {
      // 请求目标与意图绑定目标失配 = 陈旧客户端视图(槽归属冲突族,零写入)
      throw this.slotConflict(this.deps.store.findSlot(householdId, intent.fromSessionId, intent.fromGeneration));
    }
    // 3. 目标权限重验(身份/档案/最新策略;拒绝不建后继;事务外 —— 授权管线含异步面)
    const grant = await this.deps.targetAuthorizer.authorizeResolve(context, intent.targetMediaId);
    // 4. 消费事务(§2 步骤序;任一失败整体回滚零残留,intent 保持 pending)
    //    位置基准:switch/carry 意图 positionMode 映射唯一 startBasis(api §5 消费位置
    //    语义:carry 来自冻结 ledger;target_history=计划路径既有语义;beginning=0)
    const startBasis: 'beginning' | 'target_history' | 'transition_carry' =
      intent.positionMode === 'carry' ? 'transition_carry' : intent.positionMode === 'target_history' ? 'target_history' : 'beginning';
    const nowIso = this.nowIso();
    let successorSessionId: string | undefined;
    this.deps.consumeTx.runConsumeTx((stores) => {
      // (0) 来源只读上下文授权(T061;data-model §7 消费事务首步)——T059 完整端口
      //     (原设备/Profile/contextVersion 全等,失配 404 同形)+ 终态资格(「先停止再
      //     消费」;未终态 409 SOURCE_NOT_TERMINAL 不消耗 intent)。事务内读取与消费
      //     同连接,来源状态/上下文漂移与本事务原子判定。
      //     终态门按 action 判别(T072):正常 switch/next/manual_next 要求 ended
      //     (「正常switch旧来源必须先stop到ended」);recover_switch 要求 failed
      //     (「recover来自可恢复failed」—— failed 即终态,免 stop,E1)。
      //     ⚠️ 真实 state 判定:本面(sourceContext)返回 playback_session 原始 state,
     //      与 online-vod 候选/测速面的「非 failed 投影 ended」投影无关(报告注记)。
      const source = this.deps.sourceContext.authorizeReadonlySourceContext({
        householdId,
        deviceSessionId: context.session.id,
        profileId: identity.profileId,
        profileContextVersion: identity.contextVersion,
        fromSessionId: intent.fromSessionId,
      });
      const requiredState = intent.action === 'recover_switch' ? 'failed' : 'ended';
      if (source.state !== requiredState) {
        throw createDomainError('SOURCE_NOT_TERMINAL');
      }
      // (0.5) carry checkpoint 消费期复核(carry 基准冻结语义;零写入 409):intent 冻结
      //     的 sourceCheckpoint 必须仍精确等于来源当前代 ledger 接受游标 —— 创建后来源
      //     已终态(ended/failed),ledger 不再前进;不等即挂起保存恢复,不消耗 intent。
      if (intent.positionMode === 'carry') {
        const ledger = source.ledgerCheckpoint;
        if (
          ledger === undefined ||
          ledger.lastSampleSeq !== intent.sourceLedgerSeq ||
          ledger.ledgerGeneration !== intent.sourceCheckpointGeneration
        ) {
          throw createDomainError('SOURCE_PROGRESS_PENDING');
        }
      }
      // (a) intent/slot 校验(F 组 reserve-slot 注入锚 = playback 参与者第 1 次触达)
      const intentTx = stores.playback.findIntent(householdId, intent.id);
      if (intentTx === undefined || intentTx.status !== 'pending') {
        throw createDomainError('TRANSITION_SLOT_CONFLICT');
      }
      const slot = stores.playback.findSlot(householdId, intentTx.fromSessionId, intentTx.fromGeneration);
      if (slot === undefined || slot.status !== 'reserved' || slot.activeIntentId !== intentTx.id) {
        throw this.slotConflict(slot);
      }
      // (b) 计划快照全维重验(详情/序列/目标三维/历史;C5/C6:任一改变 409 不消耗槽
      //     不建后继)+ 偏好事务内重验(next 必开;E1 经 personalData 参与者读当前偏好)
      if (intentTx.nextPlanId !== null) {
        const plan = stores.playback.findPlan(householdId, intentTx.nextPlanId);
        if (plan === undefined) {
          throw createDomainError('NEXT_PLAN_CHANGED');
        }
        this.assertPlanSnapshotCurrent(householdId, plan, identity.profileId);
        if (intentTx.action === 'next' && !stores.personalData.findVodPreferences(householdId, identity.profileId).autoplayNext) {
          throw createDomainError('NEXT_PLAN_CHANGED');
        }
      }
      // (c) 创建 preparing session(F 组 create-successor-session 锚)
      const sessionId = randomUUID();
      stores.playback.insertPreparingSession({
        sessionId,
        householdId,
        deviceSessionId: context.session.id,
        deviceId: grant.snapshot.deviceId,
        profileId: identity.profileId,
        mediaId: intentTx.targetMediaId,
        generation: 1,
        version: 1,
        profileContextVersion: grant.snapshot.profileContextVersion,
        createdAt: nowIso,
        lastHeartbeatAt: nowIso,
      });
      // (d) epoch 分配 + ledger 首次建档(personalData 触达;失败回滚不消耗号)
      const epoch = stores.personalData.allocateProgressEpoch(householdId, identity.profileId);
      const targetRow = this.deps.vodFacts.findTargetEpisodeRow(householdId, intentTx.targetMediaId);
      stores.personalData.insertLedgerRow({
        householdId,
        playbackSessionId: sessionId,
        profileId: identity.profileId,
        mediaId: intentTx.targetMediaId,
        candidateEpoch: epoch,
        contentRevision: Math.max(1, targetRow?.contentRevision ?? 1),
        profileContextVersion: grant.snapshot.profileContextVersion,
        lastGeneration: 1,
        continuityRevision: Math.max(1, targetRow?.continuityRevision ?? 1),
        lastResult: null,
      });
      // (e) consumed/后继提交(T059 store 并入外层事务;consumed 槽永久无第二后继)
      const outcome = this.deps.store.consumeTransition(householdId, intentTx.id, sessionId, nowIso);
      if (outcome.kind === 'conflict') {
        throw this.slotConflict(outcome.slot);
      }
      successorSessionId = sessionId;
    });
    const sessionId = successorSessionId;
    if (sessionId === undefined) {
      // 防御:提交面已校验 consumed 成功;不可达路径按未分类失败收口(过滤器 500 INTERNAL)
      throw new Error('过渡消费提交未产出后继会话(存储一致性失败)');
    }
    // 5. 固定输入绑定(事务外;绑定不可建时会话稳定失败,不悬挂半建档;
    //    frozen_start_seconds 保持 NULL 直到 probe,冻结归 resolver 过渡终段)
    const candidate = grant.candidates[0];
    let bindingId: string;
    try {
      const bound = await this.deps.inputBinder.bindFixedInput({
        householdId,
        sessionId,
        generation: 1,
        mediaId: intent.targetMediaId,
        playbackSourceId: candidate?.playbackSourceId ?? '',
        sourceId: candidate?.sourceId ?? '',
        startBasis,
      });
      bindingId = bound.bindingId;
    } catch (error) {
      this.deps.sessionStore.failSession(sessionId, {
        cas: { expectedVersion: 1, expectedGeneration: 1 },
        failureCode: 'PLAYBACK_RESOURCE_UNAVAILABLE',
        at: nowIso,
      });
      throw error;
    }
    // 5. fire-and-forget 后继准备(probe→ready;起点=positionMode 显式选择 ——
    //    beginning=0 / target_history 以消费时刻目标历史位置为冻结基准(携计划快照历史
    //    revision 由 resolver 在 probe 后经 T041 重读当前历史)/ transition_carry 以
    //    intent 冻结的 carry 快照为起点(T072 消费面提供 carry 快照事实:checkpoint
    //    精确匹配当前代 ledger 后复制 position/duration;T073 接缝 —— vod-start-position
    //    的 transition_carry 分支据此消费 frozen 起点,frozen_at 守卫吸收二次冻结)。
    //    target_history 漂移即准备失败 NEXT_PLAN_CHANGED 语义,会话 failed 不复活源;
    //    冻结移至 probe 后,FR-021 冻结一次)
    const targetHistory = this.deps.personalFacts.findTargetHistory(householdId, identity.profileId, intent.targetMediaId);
    this.deps.successorPreparer.prepareTransitionSuccessor({
      householdId,
      profileId: identity.profileId,
      sessionId,
      generation: 1,
      version: 1,
      bindingId,
      mediaId: intent.targetMediaId,
      deviceSessionId: context.session.id,
      candidates: grant.candidates,
      startBasis,
      frozenStartSeconds:
        startBasis === 'transition_carry'
          ? (intent.carryPositionSeconds ?? 0)
          : startBasis === 'target_history'
            ? (targetHistory?.positionSeconds ?? 0)
            : undefined,
      expectedHistoryRevision: intent.planHistoryRevision ?? undefined,
    });
    return { kind: 'consumed', sessionId, dto: preparingDto(sessionId, startBasis) };
  }

  /** 已消费重放的后继当前状态视图(200 同后继;终态/换代仍返回当前真实状态) */
  private statusViewOf(householdId: string, sessionId: string): Record<string, unknown> {
    const loaded = this.deps.sessionStore.getSession(householdId, sessionId);
    if (!loaded.ok || loaded.value === undefined) {
      throw notFoundSameShape();
    }
    const session = loaded.value;
    return {
      id: session.id,
      state: session.state,
      version: session.version,
      generation: session.generation,
      desiredPaused: session.desiredPaused,
      delivery: session.delivery,
      positionSeconds: session.positionSeconds,
      durationSeconds: null,
      timelineOffsetSeconds: 0,
      presentationStartSeconds: 0,
      ticketExpiresAt: null,
      playbackUrl: null,
      tracks: { audio: [], subtitles: [] },
    };
  }
}
