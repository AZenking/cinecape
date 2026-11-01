/**
 * 010-online-vod T062(US3)—— 过渡最小清理编排服务(应用层纯类,单测直构)。
 *
 * 职责(tasks.md T062 审查补充原文):「新增 transition-cleanup.service.ts 及
 * controller 最小 cleanup 端点/工作集,先撤交付再 commit 后 stop,重启可重试」。
 *
 * 权威依据(实现侧不自创语义):
 * - docs/specs/010-online-vod/contracts/api.md §7 I5( cleanup 权威):POST
 *   /playback/transition-intents/:id/cleanup,body={},200
 *   {outcome:cancelled|already_cancelled|cleanup_pending|stopped};仅当前有效
 *   DeviceSession、原 Profile 及完全相同 contextVersion 可用;跨家庭/设备/Profile/
 *   旧 context 及不存在均 404;不要求源或目标当前内容策略放行;不返回目标 ID/元数据/
 *   位置/票据;事务内 pending 则取消/释放槽、consumed 则为唯一已关联后继写持久
 *   cleanup_requested,标记后拒绝其 renew/新资产并投递幂等空 stop;已终态仍清理资源;
 *   提交后执行任务取消,不写 final/history、不重建、不重消费;失败/重启扫描重试;
 *   响应丢失重试同入口;context 变更后禁止调用。另 §5 GET 行「完整 IntentReply 要求
 *   当前源/目标权限;失权时不返回完整结果,使用 cleanup 最小清理接口,不借 GET 发票」
 *   —— 失权判定由本服务 assertFullReplyEntitlement 承担(GET 路由先经此再委托既有
 *   getIntent;playback-transition.service.ts 归 T061 在途,本任务不改动);
 * - docs/specs/010-online-vod/contracts/internal-ports.md §5(TransitionCleanupWorkSet):
 *   当前 Identity/Profile/context 及 intent 归属 + IntentTx/SlotTx/PlaybackSessionTx/
 *   InputBindingTx;不执行内容放行以授予播放,只标记取消/撤交付/cleanup,session 终止
 *   由既有生命周期发布端口执行;提交后任务取消可重试;新资产/renew 检查持久清理标记;
 *   不得以最小清理分支替代正常 resolve/renew/progress 权限检查;
 * - docs/specs/010-online-vod/data-model.md §7(consumed 槽永久不能再建立第二后继)
 *   + §9(receipt/已消费 intent/slot 至少 24h 且不短于会话保留;资产可按原短 TTL 清理,
 *   但不能连带删去受引用保护的 session 行/ledger;过期后先删不再可消费/重放的 intent,
 *   再按依赖清理 slot/receipt/终态 ledger/session;cleanup 未完成或活动租约不允许清理
 *   输入)+ §10(cleanup_requested/cleanup_reason/cleanup_state 持久标记;标记先阻止
 *   新票/资产,网络和进程取消在 commit 后执行;策略失权不阻止最小清理;context 失配
 *   仍 404;不依赖前端取得后继 ID,不写个人进度)。
 *
 * 交付形态:
 * - cleanupIntent:身份三键校验(设备/Profile/contextVersion 全等,同形 404)→ 归属内
 *   intent 分支 —— pending:同事务 markIntentCancelled + releaseSlot(不查 TTL、不要求
 *   策略放行)→ cancelled;consumed:同事务为唯一后继写持久 cleanup_requested(session
 *   经 PlaybackSessionTx 面 + 撤交付标记(session+当前代绑定)经 markDeliveryCleanupRequested
 *   并入同一 BEGIN IMMEDIATE),提交后经既有生命周期发布端口投递幂等空 stop,会话已
 *   终态 → stopped,终止未落定 → cleanup_pending(重试同入口幂等);终态
 *   (cancelled/superseded/expired)→ already_cancelled(已终态仍收口的资源面无过渡
 *   专属残留);不写 final/history、不重建、不重消费、不返回目标 ID/元数据;
 * - assertFullReplyEntitlement:GET 完整 IntentReply 的失权判定 —— 归属同形 404 先行,
 *   再以当前源/目标媒体授权(装配=PlaybackAuthorizationService.authorizeResolve,与
 *   resolve 同一权威)判定;任一失权即 4xx problem(不返回完整结果,客户端转 cleanup);
 *   cleanupIntent 自身绝不调用该端口(I5「不要求源或目标当前内容策略放行」);
 * - runCleanupSweep:扫描面(挂 retention 节拍链/启动恢复,独立可测入口)——
 *   markExpiredPendingIntents(过期 pending 翻转+槽释放,T059 原语)→ 24h 保护窗消费
 *   (listConsumedSlots/Intents/FinishReceiptsReadyForCleanup 驱动,按依赖序
 *   slot→intent→receipt 删除;引用图保护:被 intent 引用的 receipt、被引用且 ref 未
 *   解绑的计划一律不删,session/ledger/binding 行不在删除面内)→ 过期未引用计划回收
 *   (ref 已解绑行;ref 仍在的过期行保持 410 可判别面)→ cleanup_requested 仍 pending
 *   的活动会话补投幂等空 stop(失败/重启扫描重试)。幂等:全部原语守卫状态谓词,
 *   重复扫描第二轮零删除/零补投。
 *
 * 依赖边界(ADR-0015 D1):跨上下文仅消费结构端口(授权/终止/撤交付,装配层适配);
 * 持久写经 T059 store seam 与 UNIT_OF_WORK 工作集,事务句柄不越出 infrastructure;
 * 零网络:不做任何上游/交付网络调用(投递面取消由既有生命周期/监督者端口执行)。
 */
import { ProblemCode } from '@hmp/shared';
import { DomainError } from '@platform/http-common/domain-error';
import type { SessionContext } from '@platform/http-common/current-session.decorator';
import type { PlaybackTransitionStore } from '@contexts/playback/application/playback-transition-store.port';
import type { TransitionIntentRow, TransitionSlotRow } from '@contexts/playback/application/playback-work-set.port';
import { isPlaybackTerminalSessionState } from '@contexts/playback/domain/playback.types';

/* ------------------------------------------------------------------ */
/* 回执形态(api.md §7 I5 TransitionCleanupReply:仅 outcome 键)            */
/* ------------------------------------------------------------------ */

export type TransitionCleanupOutcome = 'cancelled' | 'already_cancelled' | 'cleanup_pending' | 'stopped';

/** TransitionCleanupReply(api.md §7 I5:最小 1 键,不返回目标 ID/元数据/位置/票据) */
export interface TransitionCleanupReply {
  readonly outcome: TransitionCleanupOutcome;
}

/* ------------------------------------------------------------------ */
/* 依赖端口(结构最小面;装配层适配,单测直构真实 store/规则面)             */
/* ------------------------------------------------------------------ */

/** 身份只读事实(与 playback-transition.service 同形;装配=playbackStore 投影) */
export interface TransitionCleanupIdentityPort {
  findTrustedSession(
    deviceSessionId: string,
  ): { readonly activeProfileId: string | null; readonly profileContextVersion: number } | undefined;
}

/**
 * 失权判定端口(GET 完整 IntentReply 的当前源/目标权限;装配=PlaybackAuthorizationService
 * —— 与 resolve 同一授权权威,拒绝 404 MEDIA_NOT_FOUND 同形)。cleanupIntent 不消费
 * 本端口(最小清理不要求策略放行,I5)。
 */
export interface TransitionEntitlementPort {
  authorizeResolve(context: SessionContext, mediaId: string): Promise<unknown>;
}

/** 撤交付端口(装配=markDeliveryCleanupRequested;uow 事务内调用并入同一提交) */
export interface TransitionDeliveryRevokePort {
  revokeDelivery(input: { householdId: string; sessionId: string; generation: number; reason: string }): void;
}

/** 会话终止端口(既有生命周期发布面;装配=PlaybackLifecycleService.stopSession;幂等) */
export interface TransitionSessionTerminatorPort {
  /** 幂等空 stop:活动态 → ended + 提交后资源取消;已终态零副作用返回现状;无行 undefined */
  stopSession(sessionId: string): Promise<{ readonly state: string } | undefined>;
}

/** cleanup 事务工作集 stores(internal-ports §5 TransitionCleanupWorkSet 的本交付子集) */
export interface TransitionCleanupWorkSetStores {
  readonly intent: {
    findIntent(householdId: string, intentId: string): TransitionIntentRow | undefined;
    markCancelled(householdId: string, intentId: string): void;
  };
  readonly slot: {
    findSlot(householdId: string, fromSessionId: string, fromGeneration: number): TransitionSlotRow | undefined;
    release(householdId: string, fromSessionId: string, fromGeneration: number, expectedSlotRevision: number): void;
  };
  readonly session: {
    findSession(
      householdId: string,
      sessionId: string,
    ): { readonly state: string; readonly generation: number; readonly cleanupRequested: number } | undefined;
  };
}

/** cleanup 事务端口(单一 BEGIN IMMEDIATE;工作函数抛错即整体回滚;装配=UNIT_OF_WORK 桥) */
export interface TransitionCleanupTxPort {
  runCleanupTx(work: (stores: TransitionCleanupWorkSetStores) => void): void;
}

export interface TransitionCleanupServiceDeps {
  readonly store: PlaybackTransitionStore;
  readonly identity: TransitionCleanupIdentityPort;
  readonly cleanupTx: TransitionCleanupTxPort;
  /** 失权判定(GET 面;装配=PlaybackAuthorizationService;cleanupIntent 不消费) */
  readonly entitlement: TransitionEntitlementPort;
  readonly deliveryRevoke: TransitionDeliveryRevokePort;
  readonly sessionTerminator: TransitionSessionTerminatorPort;
  /** 注入时钟(ms;缺省真实系统时钟;单测注入确定值) */
  readonly clock?: () => number;
}

/** 扫描单拍结果(可测入口返回;供 retention/装配观察) */
export interface TransitionCleanupSweepOutcome {
  /** 过期 pending 翻转数(markExpiredPendingIntents;含同事务槽释放) */
  readonly expiredPendingFlipped: number;
  /** 24h 窗满已消费槽删除数(先于 intent,FK 子行依赖序) */
  readonly consumedSlotsDeleted: number;
  /** 24h 窗满已消费 intent 删除数(不再可消费/重放) */
  readonly consumedIntentsDeleted: number;
  /** 24h 窗满且无 intent 引用的 finish receipt 删除数(引用图保护) */
  readonly finishReceiptsDeleted: number;
  /** 过期且 ref 已解绑且无 intent 引用的计划行回收数 */
  readonly nextPlansRecycled: number;
  /** cleanup_requested 仍 pending 的活动会话补投幂等空 stop 成功数(失败/重启重试面) */
  readonly cleanupStopsRedelivered: number;
}

/** cleanup 持久标记原因(I5 consumed 分支;finish 面另有 'finish_receipt',互不混用) */
const TRANSITION_CLEANUP_REASON = 'transition_cleanup';

/** 毫秒 → UTC ISO-8601 毫秒 Z(与持久层时间文本同形态) */
function iso(ms: number): string {
  return new Date(ms).toISOString();
}

/** 同形 404 身份封套(归属失配/不存在共用同一 detail,不可借错误判别存在性) */
function notFoundSameShape(): DomainError {
  return new DomainError(404, ProblemCode.PLAYBACK_NOT_FOUND, '播放会话不存在');
}

export class TransitionCleanupService {
  private readonly clock: () => number;

  constructor(private readonly deps: TransitionCleanupServiceDeps) {
    this.clock = deps.clock ?? (() => Date.now());
  }

  private nowIso(): string {
    return new Date(this.clock()).toISOString();
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
  private requireOwnedIntent(
    householdId: string,
    context: SessionContext,
    intentId: string,
    identity: { readonly profileId: string; readonly contextVersion: number },
  ): TransitionIntentRow {
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
  /* POST /playback/transition-intents/:id/cleanup(api.md §7 I5)        */
  /* ---------------------------------------------------------------- */

  /**
   * 最小清理(事务内判定 + 提交后任务取消;不要求策略放行,不返回目标元数据):
   * - pending:同事务取消 + 释放槽 → cancelled;
   * - consumed:同事务为唯一后继写持久 cleanup_requested(会话标记 + 撤交付标记),
   *   提交后投递幂等空 stop → 会话已终态 stopped / 终止未落定 cleanup_pending;
   * - cancelled/superseded/expired:already_cancelled(已终态,过渡专属资源无残留);
   * - 响应丢失重试同入口:各分支幂等(取消原语仅 pending 命中、标记同值覆盖、
   *   终态 stop 零副作用)。
   */
  async cleanupIntent(context: SessionContext, intentId: string): Promise<TransitionCleanupReply> {
    const identity = this.requireIdentity(context);
    const householdId = context.session.householdId;
    // 归属校验在事务外先行(同形 404;事务内再读一次作分支判定的权威)
    const intent = this.requireOwnedIntent(householdId, context, intentId, identity);
    if (intent.status === 'consumed') {
      return this.cleanupConsumedIntent(householdId, intentId);
    }
    if (intent.status !== 'pending') {
      // cancelled/superseded/expired:已终态(G2 重试 already_cancelled 同源;无后继可标记)
      return { outcome: 'already_cancelled' };
    }
    // pending 分支:单一事务取消 + 释放槽(不查 TTL、不要求内容策略放行 —— I5)
    let cancelled = false;
    this.deps.cleanupTx.runCleanupTx((stores) => {
      const current = stores.intent.findIntent(householdId, intentId);
      if (current === undefined) {
        throw notFoundSameShape();
      }
      if (current.status === 'pending') {
        stores.intent.markCancelled(householdId, intentId);
        const slot = stores.slot.findSlot(householdId, current.fromSessionId, current.fromGeneration);
        if (slot !== undefined && slot.status === 'reserved' && slot.activeIntentId === intentId) {
          stores.slot.release(householdId, current.fromSessionId, current.fromGeneration, slot.slotRevision);
        }
        cancelled = true;
      }
      // 竞态已消费/已终态:零写入,按事务后重读的当前状态出回执
    });
    if (cancelled) {
      return { outcome: 'cancelled' };
    }
    // pending → consumed 竞态:按 consumed 分支幂等补标记(响应丢失重试同语义)
    const after = this.deps.store.findIntentById(householdId, intentId);
    if (after !== undefined && after.status === 'consumed') {
      return this.cleanupConsumedIntent(householdId, intentId);
    }
    return { outcome: 'already_cancelled' };
  }

  /**
   * consumed 分支:同事务为唯一已关联后继写持久 cleanup_requested(PlaybackSessionTx
   * 会话标记 + 撤交付标记[session+当前代绑定]同一 BEGIN IMMEDIATE);提交后经既有
   * 生命周期发布端口投递幂等空 stop —— 会话已终态 → stopped,终止未落定 →
   * cleanup_pending(失败/重启由扫描面按持久标记补投)。不写 final/history、不重建、
   * 不重消费;后继行/ledger 不在删除面内(引用图保护,data-model §9)。
   */
  private async cleanupConsumedIntent(householdId: string, intentId: string): Promise<TransitionCleanupReply> {
    let successorId: string | undefined;
    this.deps.cleanupTx.runCleanupTx((stores) => {
      const current = stores.intent.findIntent(householdId, intentId);
      // 竞态已取消/已终态:零写入(重试按终态分支回 already_cancelled 形态语义)
      if (current === undefined || current.status !== 'consumed') {
        return;
      }
      const successor = current.successorId;
      if (successor === null) {
        // consumed 必有唯一后继(消费事务同提交);缺失属存储一致性失败,整体回滚
        throw new Error('consumed 过渡意图缺失后继引用(存储一致性失败)');
      }
      const session = stores.session.findSession(householdId, successor);
      if (session === undefined) {
        // 后继会话行受 intent.successor_id FK 引用保护,缺失即存储一致性失败(整体回滚)
        throw new Error('consumed 后继会话行缺失(存储一致性失败)');
      }
      // 撤交付 + 会话持久清理标记同提交(先阻止新票/新资产/在途分片;不写终态)
      this.deps.deliveryRevoke.revokeDelivery({
        householdId,
        sessionId: successor,
        generation: session.generation,
        reason: TRANSITION_CLEANUP_REASON,
      });
      successorId = successor;
    });
    if (successorId === undefined) {
      // 事务内发现已非 consumed(竞态取消):终态幂等回执
      return { outcome: 'already_cancelled' };
    }
    // 提交后执行任务取消:幂等空 stop(既有生命周期发布端口;终态守卫零副作用)
    const stopped = await this.deps.sessionTerminator.stopSession(successorId);
    if (stopped !== undefined && isPlaybackTerminalSessionState(stopped.state)) {
      return { outcome: 'stopped' };
    }
    return { outcome: 'cleanup_pending' };
  }

  /* ---------------------------------------------------------------- */
  /* GET 失权判定(api.md §5 GET 行「完整 IntentReply 要求当前源/目标权限」) */
  /* ---------------------------------------------------------------- */

  /**
   * GET 完整 IntentReply 前的失权判定:归属同形 404 先行(跨设备/跨 Profile/旧
   * context/随机 id 不可判别存在性),再按当前源(fromSession 媒体)与目标(媒体)
   * 授权判定 —— 任一失权即由授权端口抛稳定 4xx problem(GET 不返回完整结果,客户端
   * 直接走 cleanup 最小清理入口,不借 GET 发票)。不产生任何持久写入。
   */
  async assertFullReplyEntitlement(context: SessionContext, intentId: string): Promise<void> {
    const identity = this.requireIdentity(context);
    const householdId = context.session.householdId;
    const intent = this.requireOwnedIntent(householdId, context, intentId, identity);
    // 目标媒体当前权限(resolve 同一权威;拒绝 404 MEDIA_NOT_FOUND 同形)
    await this.deps.entitlement.authorizeResolve(context, intent.targetMediaId);
    // 来源媒体当前权限(来源会话只读投影取媒体身份;缺失与失权同形 —— 不可判别)
    const source = this.deps.store.findSourceSessionContext(householdId, intent.fromSessionId);
    if (source === undefined) {
      throw new DomainError(404, ProblemCode.MEDIA_NOT_FOUND, '播放媒体不存在');
    }
    await this.deps.entitlement.authorizeResolve(context, source.mediaId);
  }

  /* ---------------------------------------------------------------- */
  /* 扫描面(retention 节拍链/启动恢复;独立可测入口;I5「失败/重启扫描重试」) */
  /* ---------------------------------------------------------------- */

  /**
   * 过渡清理单拍(幂等;重复执行第二轮零删除/零补投):
   * 1) markExpiredPendingIntents:过 TTL pending 翻转 expired + reserved 槽同事务释放;
   * 2) 24h 保护窗消费(store 内建 cutoff-24h):按依赖序删已消费槽 → 已消费 intent →
   *    无引用 finish receipt(data-model §9 依赖序;session/ledger/binding 不在删除面);
   * 3) 过期未引用且 ref 已解绑计划行回收(ref 仍在的过期行保持 410 可判别面);
   * 4) cleanup_requested 仍 pending 的活动会话补投幂等空 stop(端点提交后终止丢失的
   *    重启重试面;终态会话不入清单,补投后自然出清)。
   */
  async runCleanupSweep(nowMs?: number): Promise<TransitionCleanupSweepOutcome> {
    const at = nowMs ?? this.clock();
    const nowIso = iso(at);
    const store = this.deps.store;
    const expiredPendingFlipped = store.markExpiredPendingIntents(nowIso);
    // 依赖序:槽(intent 的 FK 子行)先于 intent;receipt 待引用它的 intent 清理后再删
    const readySlots = store.listConsumedSlotsReadyForCleanup(nowIso);
    const consumedSlotsDeleted = readySlots.length === 0 ? 0 : store.deleteConsumedTransitionSlots(readySlots);
    const readyIntents = store.listConsumedIntentsReadyForCleanup(nowIso);
    const consumedIntentsDeleted = readyIntents.length === 0 ? 0 : store.deleteConsumedTransitionIntents(readyIntents);
    const readyReceipts = store.listFinishReceiptsReadyForCleanup(nowIso);
    const finishReceiptsDeleted = readyReceipts.length === 0 ? 0 : store.deleteFinishReceipts(readyReceipts);
    const nextPlansRecycled = store.deleteExpiredUnreferencedNextPlans(nowIso);
    // 失败/重启重试:持久标记仍 pending 的活动会话补投幂等空 stop(终态自然出清)
    const pendingStops = store.listActiveSessionsRequestingCleanup();
    let cleanupStopsRedelivered = 0;
    for (const row of pendingStops) {
      const stopped = await this.deps.sessionTerminator.stopSession(row.sessionId);
      if (stopped !== undefined && isPlaybackTerminalSessionState(stopped.state)) {
        cleanupStopsRedelivered += 1;
      }
    }
    return {
      expiredPendingFlipped,
      consumedSlotsDeleted,
      consumedIntentsDeleted,
      finishReceiptsDeleted,
      nextPlansRecycled,
      cleanupStopsRedelivered,
    };
  }
}
