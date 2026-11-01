import { createHash } from 'node:crypto';
import { DomainError, createDomainError } from '@platform/http-common/domain-error';
import {
  evaluateFinish,
  resolveFinishInvocation,
  type FinishEvaluation,
  type FinishReason,
  type PhaseObservation,
  type PhaseObservationEvent,
} from '@contexts/playback/domain/finish.rules';
import { isPlaybackTerminalSessionState } from '@contexts/playback/domain/playback.types';
import type {
  FinishReceiptInsertValues,
  FinishReceiptOutcome,
  FinishReceiptRow,
  FinishReceiptTx,
  InputBindingTx,
  LedgerStateRow,
  PhaseObservationRow,
  PlaybackIdentityReader,
  PlaybackSessionRow,
  PlaybackSessionTx,
  PlaybackTrustedFactsReader,
} from '@contexts/playback/application/playback-work-set.port';

/**
 * 010-online-vod T058 — 播放完成/结束编排服务(US3;ProgressFinishWorkSet 同事务原子提交)。
 *
 * 职责边界(tasks.md T058 原文 + T054/T057 接线点):
 * - POST finish:ProgressFinishWorkSet 同事务 —— 身份/归属重验 → resolveFinishInvocation
 *   分支(replay→200 原 receipt / already_recorded→409 FINISH_ALREADY_RECORDED /
 *   not_completed→只登记 receipt 不写 final / evaluate)→ evaluate 分支在「同事务接受
 *   final→更新 ledger→按 epoch 可选历史」后以独立四值(finalSessionAccepted/historyApplied/
 *   sessionCompleted/autoNextEligible)组装 receipt → 写 receipt → ended → 输入待清理,
 *   一个 commit;硬错误整次回滚无 receipt;stale final 可 ended 但 autoNext=false;
 * - GET finish-result:原设备/原上下文只读恢复(丢响应恢复;禁止跨上下文读旧结果,
 *   无 receipt 返回 null,FinishReceipt|null 形态)。
 *
 * 来源标注(实现侧不自创语义,契约冻结面):
 * - docs/specs/010-online-vod/contracts/api.md §4 finish/finish-result 行 + 语义段:
 *   「finish operationKey 必须 UUID;final 先校验接受再判尾段;same operationKey 异
 *   payload 409;已有 receipt 且新 key 不同则 409 FINISH_ALREADY_RECORDED 附恢复路径
 *   而不重算;旧 stop 先赢时首次 finish 只登记『别处停止』形态回执而不写新 final,
 *   endedAt 取原终态时刻,不得给 ended 任意升级资格;finish 重放先校验身份/归属再读
 *   receipt,不要求活动态;无权读取时只允许既有最小空 stop清理」;
 * - contracts/internal-ports.md §2 ProgressFinishWorkSet:「finish:final 校验 → 完成资格 →
 *   receipt → ended+输入待清理;已授权不能替代事务内重验;必须使用同一 source 绑定,
 *   不可借全局历史时长回填在线 probe;任务取消/回收在 commit 后」;
 * - contracts/playback-state.md §4:「finish流程:停周期→按序flush尾段观测→分配一次final
 *   seq/payload→同事务接受final→更新ledger→按epoch可选历史→计算sessionCompleted/
 *   autoNextEligible→写receipt→ended。保存硬错误回滚,不部分终态化;stale final可ended
 *   但不可auto-next。superseded final可sessionAccepted/completed而historyApplied=false;
 *   finish先赢后stop仅清理;stop先赢后finish返回not_completed」;
 * - data-model.md §5:「final位置先被验证接受,再计算尾部min(5s,duration×5%)及末段
 *   min(2s,duration×5%);gap>3s、跳跃/暂停/缓冲使资格unknown;观测缺失保守unknown;
   completed是会话观测结果,不影响目标授权;个人历史归属和会话完成独立:superseded 可
 *   ledger接受且session_completed=true,绝不把其完成写到另设备 owner 历史」;
 *   playback_finish_receipt 行:「session_id唯一;终态不得由新finish升级;重放仅返回既有结果」;
 * - domain/finish.rules(T054 共享纯函数面,T058 接线点注):先调 resolveFinishInvocation
 *   决定分支;evaluateFinish 得 sessionCompleted/autoNextEligible/reason/tailStreakSamples;
 *   hard_invalid→400 整次回滚;stale_final 可 ended 但 autoNext=false;historyApplied 是
 *   receipt 组装输入,不经本判定;stopped_elsewhere 保留类型值,按 T053 裁决 stop-先赢
 *   产出钉 not_completed,本服务不在 receipt 组装层产出 stopped_elsewhere;
 * - T057 接线点:finish 按事件序升序 flush 会话全部观测行(playback 参与者 listObservations
 *   只读投影,沿 findLatestObservation 先例)喂 evaluateFinish/evaluateTailEligibility;
 *   ledger started 门/游标在 personal-data(progress_state.started/last_sample_seq);
 *   A8 gap>3s 语义由 T057 重锚 + 本服务 flush 折叠自然成立(保守 unknown→no_tail_observation)。
 *
 * 判定序裁决(为何 evaluateFinish 先于 final 接受;T054「接受后调 evaluateFinish」的等价形):
 * - final 的「验证接受」必须先于一切写入(api.md「final位置先被验证接受」),而四个软形态
 *   (not_started/stale_final/no_duration/尾段不合格)按契约必须 **200 receipt 落库**而非
 *   抛错 —— personal-data 写入状态机(applyFinalInTransaction)对未 started/陈旧 seq/未知
 *   duration 是硬拒绝(409),不能作为软形态的第一道闸;
 * - 故本服务先以纯函数 evaluateFinish 做完整闸门(hard_invalid→400 抛错整次回滚,零写入;
 *   软形态→据其独立四值组装 receipt),对「accepted 且 duration 已知」的样本再调用
 *   personal-data 状态机完成「接受 final→ledger→epoch 历史」(duration 未知时机器必 409,
 *   与 no_duration 软形态冲突,故跳过接受 —— 无证据不等于接口失败,可 ended=true);
 * - evaluateFinish 的尾段判定输入 = 本次事务内 flush 的有序持久观测 + final 落点,与
 *   「接受后再计算尾部」在结果上逐值等价(尾段判定是纯读,不依赖接受产生的写入);
 *   一个事务内(含 savepoint)全部成功或整体回滚,「硬错误回滚、不部分终态化」成立。
 *
 * 不可变终态与幂等面:
 * - receipt session_id 唯一(playback_finish_receipt 主键):已有 receipt 时同 key 同 digest
 *   重放返回原结果(replayed=true、零写入、endedAt 不刷新);同 key 异 digest → 409
 *   IDEMPOTENCY_CONFLICT;异 key → 409 FINISH_ALREADY_RECORDED(detail 指向 finish-result
 *   恢复入口),均不重算、不改写既有行;
 * - (household,device_session,contextVersion,operationKey) 幂等四元组唯一索引为存储层
 *   兜底,应用层以 session 唯一 receipt 先行裁决;
 * - 请求摘要(finishRequestDigest)只覆盖业务载荷(seq/generation/position/cause),不含
 *   服务端接收时刻 —— 「重放仅返回既有结果」的比较基准(progress 摘要领域机同纪律)。
 *
 * 与 stop 竞争(双向;stop 204 语义不变,由 playback-lifecycle.service 承担):
 * - stop 先赢(session 终态 ∧ 无 receipt):首次 finish 只登记 reason='not_completed' receipt,
 *   不写 final、不补写历史、endedAt 取原终态时刻(session.ended_at),资格全否;
 * - finish 先赢(receipt 已存在):后到 stop 经既有 lifecycle 幂等终态守卫 204 仅清理,
 *   receipt/endedAt 零副作用。
 *
 * 协作与边界:
 * - final 接受/ledger/历史经 personal-data 发布面 IProgressWriteService.applyFinalInTransaction
 *   (T101 既有协作端口;在 uow BEGIN IMMEDIATE 内嵌套 savepoint 同连接执行,T040 报告
 *   「lifecycle 嵌套事务语义不变」同款;本服务不重复实现 seq/digest/epoch 机器);
 * - 历史 completed=1 只由本服务的有效 finish 写(historyApplied ∧ sessionCompleted 时经
 *   playback 参与者 markHistoryCompletedByFinishSession,守卫 writer_playback_session_id);
 * - 可信 duration = ledger 已接受样本记录的 trusted 事实(progress_state.ledger_duration;
 *   与 personal-data 状态机同一注册表源,T092 seam 注入对 finish 自然生效),未知为 null
 *   不以 0 冒充、不借全局历史时长回填在线 probe;
 * - 时间全走注入 clock(缺省真实系统时钟);观测行 server_received_at 为服务端接收事实;
 * - 错误一律稳定码:401 SESSION_INVALID / 404 PLAYBACK_NOT_FOUND(同形,不泄露存在性)/
 *   400 VALIDATION_FAILED(硬非法)/ 409 IDEMPOTENCY_CONFLICT / 409 FINISH_ALREADY_RECORDED。
 */

/* ------------------------------------------------------------------ */
/* 请求/范围形状(controller zod 解析后的服务侧输入;api.md §4 finish 行)      */
/* ------------------------------------------------------------------ */

/** finish 写入范围(会话归属防御输入;身份只从服务端会话上下文推导) */
export interface PlaybackFinishScope {
  readonly householdId: string;
  readonly deviceSessionId: string;
  readonly sessionId: string;
}

/** finish 请求(api.md §4:operationKey UUID;final=本次样本;cause 仅 natural_end) */
export interface PlaybackFinishInput {
  readonly operationKey: string;
  readonly finalProgress: {
    readonly sampleSeq: number;
    readonly expectedGeneration: number;
    readonly positionSeconds: number;
  };
  readonly cause: 'natural_end';
}

/**
 * stop/finish 与 personal-data 写入状态机的同事务协作端口(T101 既有面;lifecycle
 * PlaybackFinalProgressPort 同构):调用方持事务,实现只做同一机器的校验与写入。
 * 硬性非法抛 DomainError → 调用方事务整体回滚;stale/superseded 返回 applied=false;
 * 无进度绑定返回 null。
 */
export interface PlaybackFinishProgressPort {
  applyFinalInTransaction(input: {
    readonly householdId: string;
    readonly sessionId: string;
    readonly at: string;
    readonly final: {
      readonly sampleSeq: number;
      readonly expectedGeneration: number;
      readonly positionSeconds: number;
    };
  }): { readonly applied: boolean; readonly reason: string; readonly historyRevision: number | null } | null;
}

/* ------------------------------------------------------------------ */
/* 请求摘要(同 key 幂等/异载荷冲突权威;「payload 不含接收时刻」同纪律)        */
/* ------------------------------------------------------------------ */

/**
 * finish 请求业务载荷规范化摘要:只比对 (sampleSeq,expectedGeneration,positionSeconds,
 * cause) —— operationKey 是幂等键本身不入摘要,服务端接收时刻不入摘要(api.md §4
 * 「same operationKey 异 payload 409」「同payload重放」;personal-data
 * progressSampleDigest / phase-observation phaseObservationDigest 同款规范化纪律:
 * 数字以可逆十进制文本编码、键序固定、领域前缀隔离)。
 */
export function finishRequestDigest(input: {
  readonly sampleSeq: number;
  readonly expectedGeneration: number;
  readonly positionSeconds: number;
  readonly cause: string;
}): string {
  const payload = JSON.stringify({
    s: input.sampleSeq,
    g: input.expectedGeneration,
    p: Object.is(input.positionSeconds, -0) ? '-0' : String(input.positionSeconds),
    c: input.cause,
  });
  return createHash('sha256').update(`hmp-playback-finish\u0000${payload}`, 'utf8').digest('hex');
}

/* ------------------------------------------------------------------ */
/* UnitOfWork 结构镜像(不深导 platform/database;phase-observation 同先例)     */
/* ------------------------------------------------------------------ */

/** finish 观测 flush 读面(T058 增量;transaction-participants 具体参与者附加成员) */
export interface FinishObservationFlushReader {
  /** 按 event_seq 升序 flush 会话全部观测行(T057 listObservations 只读投影) */
  listObservations(householdId: string, sessionId: string): PhaseObservationRow[];
}

/** finish 完成标记写面(T058 增量;history completed 只由有效 finish 写) */
export interface FinishHistoryCompletionTx {
  /** 仅 owner 命中置位(守卫 writer_playback_session_id;绝不写他 owner 历史) */
  markHistoryCompletedByFinishSession(
    householdId: string,
    profileId: string,
    mediaId: string,
    playbackSessionId: string,
  ): void;
}

/** finish 事务工作集消费的 playback 绑定参与者面(结构收窄,具体参与者逐成员满足) */
export interface PlaybackFinishTxStores {
  /* PlaybackSessionTx(收窄) */
  findSession: PlaybackSessionTx['findSession'];
  markSessionTerminal: PlaybackSessionTx['markSessionTerminal'];
  requestCleanup: PlaybackSessionTx['requestCleanup'];
  /* FinishReceiptTx(session 唯一不可变回执) */
  findReceipt: FinishReceiptTx['findReceipt'];
  insertReceipt: FinishReceiptTx['insertReceipt'];
  /* InputBindingTx / PlaybackTrustedFactsReader(收窄;receipt 修订快照与 fallback) */
  findActiveBinding: InputBindingTx['findActiveBinding'];
  findSessionTrustedFacts: PlaybackTrustedFactsReader['findSessionTrustedFacts'];
  /* T058 装配增量面 */
  listObservations: FinishObservationFlushReader['listObservations'];
  markHistoryCompletedByFinishSession: FinishHistoryCompletionTx['markHistoryCompletedByFinishSession'];
}

/** finish 事务工作集消费的 personal-data 绑定参与者面(started 门/游标/owner 归属) */
export interface PlaybackFinishLedgerReader {
  findLedgerRow(householdId: string, sessionId: string): LedgerStateRow | undefined;
}

/** finish 事务工作集消费的绑定后 txStores(键名与组合根注册表一致,按需取用) */
export interface FinishTxBoundStores {
  readonly credential: { readonly transactionId: string; readonly behavior: 'immediate' };
  readonly identityAccess: PlaybackIdentityReader;
  readonly playback: PlaybackFinishTxStores;
  readonly personalData: PlaybackFinishLedgerReader;
}

/** 平台 UnitOfWork.run 的同步返回形态镜像(thenable 压 never;与平台逐字同构) */
export type FinishSyncResult<T> = [T] extends [PromiseLike<unknown>] ? never : T;

/** 平台 UnitOfWork 的结构镜像(方法语法 → 参数双向协变;编译期结构校验) */
export interface FinishUnitOfWork {
  run<TWorkSet, TResult>(
    workSetFactory: (txStores: FinishTxBoundStores) => TWorkSet,
    callback: (workSet: TWorkSet) => TResult,
    options: { readonly behavior: 'immediate'; readonly busyBudgetMs?: number },
  ): FinishSyncResult<TResult>;
}

/* ------------------------------------------------------------------ */
/* 内部形状                                                              */
/* ------------------------------------------------------------------ */

/** finish 事务内校验后的会话事实快照(单事务内一致,出作用域即弃) */
interface FinishFacts {
  readonly session: PlaybackSessionRow;
  readonly ledger: LedgerStateRow | undefined;
  /** 可信 duration(finite>0;未知为 null,不以 0 冒充) */
  readonly durationSeconds: number | null;
  /** receipt 修订快照(content/continuity/locator;均 >=1,schema CHECK 域) */
  readonly revisions: {
    readonly contentRevision: number;
    readonly continuityRevision: number;
    readonly locatorRevision: number;
  };
}
/** 观测事件七值(api.md §4;与 schema CHECK 同源,防御性收窄用) */
const FINISH_OBSERVATION_EVENTS: readonly PhaseObservationEvent[] = [
  'playing',
  'pause',
  'seeking',
  'seeked',
  'waiting',
  'ratechange',
  'error',
];

function failClosedEventType(value: string): never {
  throw new Error(`playback_phase_observation.event_type 越域(CHECK 失守): ${value}`);
}

/** 观测行 → 纯函数样本投影(serverReceivedAt 解析回毫秒;均为服务端写入值) */
function sampleOfRow(row: PhaseObservationRow): PhaseObservation {
  return {
    generation: row.generation,
    eventSeq: row.eventSeq,
    event: FINISH_OBSERVATION_EVENTS.includes(row.eventType as PhaseObservationEvent)
      ? (row.eventType as PhaseObservationEvent)
      : failClosedEventType(row.eventType),
    positionSeconds: row.positionSeconds,
    rate: row.playbackRate,
    serverReceivedAtMs: Date.parse(row.serverReceivedAt),
  };
}

/**
 * receipt 行 → FinishReceipt DTO(api.md §1 13 键;唯一组装路径 —— finish 首次响应/
 * 同 key 重放/GET finish-result 三入口共用,保证逐字段一致)。
 * ended/replayed 由 receipt 层表达:receipt 存在即会话已终态(ended=true);replayed 仅
 * finish 同 key 重放为 true,GET finish-result 恒 false(「GET 返回与 finish 响应一致
 * 的原 receipt」—— E2 形态)。
 */
function receiptOutcomeOf(row: FinishReceiptRow, replayed: boolean): FinishReceiptOutcome {
  return {
    sessionId: row.sessionId,
    generation: row.generation,
    ended: true,
    finalSessionAccepted: row.finalSessionAccepted === 1,
    historyApplied: row.historyApplied === 1,
    historyRevision: row.historyRevision,
    sessionCompleted: row.sessionCompleted === 1,
    autoNextEligible: row.autoNextEligible === 1,
    reason: row.reason as FinishReason,
    positionSeconds: row.positionSeconds,
    durationSeconds: row.durationSeconds,
    endedAt: row.endedAt,
    replayed,
  };
}

/* ------------------------------------------------------------------ */
/* 服务(纯类;单测直接 new 注入 clock/UnitOfWork/协作端口,生产经 playback.module 工厂装配) */
/* ------------------------------------------------------------------ */

export interface PlaybackFinishServiceDeps {
  readonly uow: FinishUnitOfWork;
  /** personal-data 写入状态机协作端口(生产 = PROGRESS_WRITE_PORT 发布面实例) */
  readonly progressFinal: PlaybackFinishProgressPort;
  /** 缺省真实系统时钟;测试注入 FakeClock */
  readonly clock?: { now(): number };
}

export class PlaybackFinishService {
  private readonly clock: { now(): number };

  constructor(private readonly deps: PlaybackFinishServiceDeps) {
    this.clock = deps.clock ?? { now: () => Date.now() };
  }

  /**
   * finish 编排(ProgressFinishWorkSet 同事务;BEGIN IMMEDIATE,事务边界即调用栈边界):
   *
   * 1. 事务内身份重验(撤销/过期 → 401;已授权不能替代重验);
   * 2. 会话归属防御(非本设备/绑定上下文版本不等/绑定档案不等 → 404 同形,不泄露存在性;
   *    finish 重放先校验身份/归属再读 receipt,不要求活动态);
   * 3. receipt 裁决(resolveFinishInvocation 分支;session_id 唯一):
   *    - 已有 receipt ∧ 同 key ∧ 同 digest → replay(返回既有结果,replayed=true,零写入);
   *    - 已有 receipt ∧ 同 key ∧ 异 digest → 409 IDEMPOTENCY_CONFLICT(零写入);
   *    - 已有 receipt ∧ 异 key → 409 FINISH_ALREADY_RECORDED(附 finish-result 恢复路径);
   *    - 无 receipt ∧ 会话已终态(stop/失败/失权先赢)→ 只登记 not_completed receipt
   *      (endedAt=原终态时刻,不写 final、不补写历史,资格全否,ended=true);
   *    - 其余 → evaluate;
   * 4. evaluate 分支:ledger 事实(started 门/游标)→ 按 event_seq 升序 flush 全部观测 →
   *    可信时长 → evaluateFinish 纯闸门(hard_invalid→400 整次回滚零写入;软形态按独立
   *    四值)→ accepted∧duration 已知时经 personal-data 状态机同事务「接受 final→ledger→
   *    epoch 历史」(historyApplied/historyRevision 即 receipt 组装输入;superseded 可
   *    sessionAccepted/completed 而 historyApplied=false)→ historyApplied∧sessionCompleted
   *    时标记历史 completed=1 → 写 receipt → ended → 输入待清理,同 commit;
   * 5. 返回 13 键 FinishReceipt(replayed=false;与重放/GET 共用唯一组装路径)。
   *
   * 提交后收口(任务取消/回收)不在本方法:uow 同步事务不持写锁等取消,由控制器在
   * commit 后经 lifecycle 结算面执行(internal-ports §2「任务取消/回收在 commit 后」)。
   */
  finish(scope: PlaybackFinishScope, input: PlaybackFinishInput): FinishReceiptOutcome {
    const nowMs = this.clock.now();
    const nowIso = new Date(nowMs).toISOString();
    const digest = finishRequestDigest({
      sampleSeq: input.finalProgress.sampleSeq,
      expectedGeneration: input.finalProgress.expectedGeneration,
      positionSeconds: input.finalProgress.positionSeconds,
      cause: input.cause,
    });
    return this.deps.uow.run(
      (txStores) => ({ identity: txStores.identityAccess, store: txStores.playback, ledger: txStores.personalData }),
      (workSet) => {
        const session = this.verifyIdentityAndOwnership(workSet, scope, nowMs);
        /* session_id 唯一:先读 receipt 再裁决(同 key 幂等/异 key 冲突/stop 先赢) */
        const existing = workSet.store.findReceipt(scope.householdId, scope.sessionId);
        const invocation = resolveFinishInvocation({
          hasExistingReceipt: existing !== undefined,
          sameOperationKey: existing?.operationKey === input.operationKey,
          /* stop 先赢 = 会话已终态且无 receipt(终态不可复活,资格全否;ended/failed/
           * interrupted 同收 —— 他处终态的首次 finish 只登记 not_completed) */
          stopWonFirst: existing === undefined && isPlaybackTerminalSessionState(session.state),
        });

        /* 分支一/二:已有 receipt —— 不可变终态,重放或拒绝,零写入 */
        if (invocation.kind === 'replay' || invocation.kind === 'already_recorded') {
          const existing = requireReceiptRow(workSet.store, scope);
          if (invocation.kind === 'replay') {
            if (existing.requestDigest !== digest) {
              /* 同 key 异 payload:幂等 scope 摘要冲突(materializations「同key异摘要」同族) */
              throw createDomainError('IDEMPOTENCY_CONFLICT');
            }
            return receiptOutcomeOf(existing, true);
          }
          /* 已有 receipt 且新 key 不同:附恢复路径而不重算(api.md §4) */
          throw createDomainError(
            'FINISH_ALREADY_RECORDED',
            `结束结果已记录:请经 GET /playback/sessions/${scope.sessionId}/finish-result 恢复原回执(不重算)`,
          );
        }

        /* 事务内事实(started 门/游标/时长/修订快照;receipt 组装与判定共用) */
        const facts = this.loadFinishFacts(workSet, scope, session);

        /* 分支三:stop(或他处终态)先赢 —— 只登记「别处停止」形态回执,不写 final */
        if (invocation.kind === 'not_completed') {
          workSet.store.insertReceipt(this.notCompletedReceiptValues(session, facts, input, digest, nowIso));
          return receiptOutcomeOf(requireReceiptRow(workSet.store, scope), false);
        }

        /* 分支四:evaluate —— final 先校验(纯闸门)→ 同事务接受 → receipt → ended */
        const evaluation = this.evaluate(workSet, scope, session, facts, input, nowMs);
        if (evaluation.kind === 'hard_invalid') {
          /* 硬性非法:整次回滚,不产生 receipt(会话保持活动态;零写入) */
          throw new DomainError(400, 'VALIDATION_FAILED', 'final 位置硬性非法,本次结束已整体回滚');
        }
        const applied = this.acceptFinal(workSet, scope, session, facts, evaluation, input, nowIso);
        workSet.store.insertReceipt(this.evaluateReceiptValues(session, facts, input, digest, nowIso, evaluation, applied));
        /* receipt → ended → 输入待清理(同事务;playback-state §4 finish 流程收口) */
        workSet.store.markSessionTerminal(scope.householdId, scope.sessionId, 'ended', null, nowIso);
        workSet.store.requestCleanup(scope.householdId, scope.sessionId, 'finish_receipt');
        return receiptOutcomeOf(requireReceiptRow(workSet.store, scope), false);
      },
      { behavior: 'immediate' },
    );
  }

  /**
   * GET finish-result 编排(原设备/原上下文只读恢复;api.md §4 finish-result 行):
   * 身份/归属校验与 finish 同闸(跨设备/旧上下文/随机 id 一律 404 同形,不泄露存在性;
   * 不要求活动态),无 receipt 返回 null(FinishReceipt|null 形态),有则原样返回既有
   * 结果(replayed=false —— 与 finish 首次响应逐字段一致,丢响应恢复面)。
   */
  finishResult(scope: PlaybackFinishScope): FinishReceiptOutcome | null {
    const nowMs = this.clock.now();
    return this.deps.uow.run(
      (txStores) => ({ identity: txStores.identityAccess, store: txStores.playback }),
      (workSet) => {
        this.verifyIdentityAndOwnership(workSet, scope, nowMs);
        const receipt = workSet.store.findReceipt(scope.householdId, scope.sessionId);
        return receipt === undefined ? null : receiptOutcomeOf(receipt, false);
      },
      { behavior: 'immediate' },
    );
  }

  /* ---------------- 内部:事务内身份/归属重验(与 phase-observation 同闸) ---------------- */

  /**
   * 身份重验 + 会话归属防御(「finish 重放先校验身份/归属再读 receipt」;404 同形族
   * 一律 createDomainError('PLAYBACK_NOT_FOUND'),跨设备/旧上下文/随机 id 不可区分)。
   */
  private verifyIdentityAndOwnership(
    workSet: {
      readonly identity: PlaybackIdentityReader;
      readonly store: Pick<PlaybackFinishTxStores, 'findSession'>;
    },
    scope: PlaybackFinishScope,
    nowMs: number,
  ): PlaybackSessionRow {
    const identity = workSet.identity.findDeviceContext(scope.deviceSessionId);
    if (identity === undefined || identity.revokedAt !== null || Date.parse(identity.expiresAt) <= nowMs) {
      throw new DomainError(401, 'SESSION_INVALID', undefined);
    }
    const session = workSet.store.findSession(scope.householdId, scope.sessionId);
    if (session === undefined || session.deviceSessionId !== scope.deviceSessionId) {
      /* 跨设备/不存在同形 404,不泄露存在性 */
      throw createDomainError('PLAYBACK_NOT_FOUND');
    }
    if (session.profileContextVersion !== identity.profileContextVersion || session.profileId !== identity.profileId) {
      /* 旧上下文/档案错位 → 与不存在同形 404(A→B→A 旧上下文稳定拒绝) */
      throw createDomainError('PLAYBACK_NOT_FOUND');
    }
    return session;
  }

  /* ---------------- 内部:事务内事实装载(started 门/游标/时长/修订快照) ---------------- */

  /**
   * 事务内事实(started 门/游标在 personal-data —— T057 接线点 progress_state.started/
   * last_sample_seq;可信 duration = ledger 已接受样本记录的 trusted 事实
   * (playback_progress_state.ledger_duration —— T040 机器逐样本落库的同一时长源,
   * 与 personal-data 写入状态机内部 trustedDurationOf 同一注册表,T092 seam 注入在
   * finish 侧自然生效;未知为 null 不以 0 冒充、不借全局历史时长回填在线 probe);
   * receipt 修订快照取 ledger 绑定值,fallback 链为「resolve 绑定 → 当前目录事实 →
   * 基线 1」,全部落在 schema CHECK >=1 域)。
   */
  private loadFinishFacts(
    workSet: {
      readonly store: PlaybackFinishTxStores;
      readonly ledger: PlaybackFinishLedgerReader;
    },
    scope: PlaybackFinishScope,
    session: PlaybackSessionRow,
  ): FinishFacts {
    const ledger = workSet.ledger.findLedgerRow(scope.householdId, scope.sessionId);
    const recorded = ledger?.ledgerDuration ?? null;
    const trusted = workSet.store.findSessionTrustedFacts(scope.householdId, scope.sessionId);
    const binding = workSet.store.findActiveBinding(scope.householdId, scope.sessionId, session.generation);
    return {
      session,
      ledger,
      durationSeconds: recorded !== null && Number.isFinite(recorded) && recorded > 0 ? recorded : null,
      revisions: {
        contentRevision: ledger?.contentRevision ?? trusted?.mediaContentRevision ?? 1,
        continuityRevision: ledger?.continuityRevision ?? binding?.continuityRevision ?? 1,
        locatorRevision: binding?.locatorRevision ?? 1,
      },
    };
  }

  /* ---------------- 内部:evaluateFinish 纯闸门(final 先校验再判尾段) ---------------- */

  /**
   * evaluateFinish 调用(T054 共享纯函数面;判定序逐字钉死):
   * started 门 → stale final(seq 落后游标)→ 位置硬非法(hard_invalid)→ duration 未知
   * (no_duration 软形态)→ 尾段/末段判定(有序 flush 观测折叠 + final 链接 + 双窗恰界)。
   * 观测 flush 按事件序升序读取持久行(T057 listObservations 只读投影),跨代样本的忽略
   * 归纯函数(A8 gap>3s 重锚语义由 T057 落行 + 本 flush 折叠自然成立)。
   */
  private evaluate(
    workSet: {
      readonly store: PlaybackFinishTxStores;
      readonly ledger: PlaybackFinishLedgerReader;
    },
    scope: PlaybackFinishScope,
    session: PlaybackSessionRow,
    facts: FinishFacts,
    input: PlaybackFinishInput,
    finishedAtMs: number,
  ): FinishEvaluation {
    const ledger = workSet.ledger.findLedgerRow(scope.householdId, scope.sessionId);
    return evaluateFinish({
      sessionStarted: (ledger?.started ?? 0) === 1,
      sessionGeneration: session.generation,
      durationSeconds: facts.durationSeconds,
      finalPositionSeconds: input.finalProgress.positionSeconds,
      finalSampleSeq: input.finalProgress.sampleSeq,
      latestAcceptedSampleSeq: ledger?.lastSampleSeq ?? 0,
      finishedAtMs,
      samples: workSet.store.listObservations(scope.householdId, scope.sessionId).map(sampleOfRow),
    });
  }

  /* ---------------- 内部:final 接受(personal-data 状态机同事务协作) ---------------- */

  /**
   * final 接受分支(accepted ∧ duration 已知时):
   * personal-data 写入状态机 applyFinalInTransaction 在本事务内以 savepoint 执行
   * 「验证 final→ledger 接受游标→按 epoch 可选历史」(T101 既有协作面;硬性非法抛
   * DomainError → 本事务整体回滚;superseded 返回 applied=false —— 历史不写、ledger
   * 已接受,即「superseded final 可 sessionAccepted/completed 而 historyApplied=false」)。
   * 返回 historyApplied/historyRevision 作为 receipt 组装输入(不经 finish.rules 判定);
   * 有效完成(historyApplied ∧ sessionCompleted)时同事务标记历史 completed=1 ——
   * 「completed 只由有效 finish 写」,守卫 writer_playback_session_id 绝不写他 owner 历史。
   */
  private acceptFinal(
    workSet: {
      readonly store: PlaybackFinishTxStores;
      readonly ledger: PlaybackFinishLedgerReader;
    },
    scope: PlaybackFinishScope,
    session: PlaybackSessionRow,
    facts: FinishFacts,
    evaluation: Extract<FinishEvaluation, { kind: 'evaluated' }>,
    input: PlaybackFinishInput,
    at: string,
  ): { readonly historyApplied: boolean; readonly historyRevision: number | null } {
    if (!evaluation.finalSessionAccepted || facts.durationSeconds === null) {
      /* not_started/stale_final:不写 final(ledger/历史零更新);
       * no_duration:duration 未知时 personal-data 机器必硬拒(409),与软形态冲突 ——
       * 跳过接受,「无证据不等于接口失败」,receipt 如实登记 historyApplied=false。 */
      return { historyApplied: false, historyRevision: null };
    }
    const applied = this.deps.progressFinal.applyFinalInTransaction({
      householdId: scope.householdId,
      sessionId: scope.sessionId,
      at,
      final: input.finalProgress,
    });
    const historyApplied = applied?.applied ?? false;
    const historyRevision = historyApplied ? applied?.historyRevision ?? null : null;
    if (historyApplied && evaluation.sessionCompleted) {
      const ledger = workSet.ledger.findLedgerRow(scope.householdId, scope.sessionId);
      workSet.store.markHistoryCompletedByFinishSession(
        scope.householdId,
        ledger?.profileId ?? session.profileId,
        ledger?.mediaId ?? session.mediaId,
        scope.sessionId,
      );
    }
    return { historyApplied, historyRevision };
  }

  /* ---------------- 内部:receipt 值集组装(两分支) ---------------- */

  /** not_completed receipt(stop 先赢;endedAt=原终态时刻,不补写 final,资格全否) */
  private notCompletedReceiptValues(
    session: PlaybackSessionRow,
    facts: FinishFacts,
    input: PlaybackFinishInput,
    digest: string,
    nowIso: string,
  ): FinishReceiptInsertValues {
    return {
      householdId: session.householdId,
      sessionId: session.id,
      deviceSessionId: session.deviceSessionId,
      profileContextVersion: session.profileContextVersion,
      generation: session.generation,
      operationKey: input.operationKey,
      requestDigest: digest,
      finalSeq: input.finalProgress.sampleSeq,
      finalSessionAccepted: false,
      historyApplied: false,
      historyRevision: null,
      sessionCompleted: false,
      autoNextEligible: false,
      reason: 'not_completed',
      /* 不写 final:位置不以请求值冒充(NULL;ledger/历史零更新) */
      positionSeconds: null,
      durationSeconds: facts.durationSeconds,
      /* 「endedAt 取原终态时刻」:逐字取 stop/他处终态落库值,绝不刷新为本次时刻 */
      endedAt: session.endedAt ?? nowIso,
      ...facts.revisions,
    };
  }

  /** evaluate receipt(evaluateFinish 独立四值 + 接受簿记;ended/endedAt 由本层表达) */
  private evaluateReceiptValues(
    session: PlaybackSessionRow,
    facts: FinishFacts,
    input: PlaybackFinishInput,
    digest: string,
    nowIso: string,
    evaluation: Extract<FinishEvaluation, { kind: 'evaluated' }>,
    applied: { readonly historyApplied: boolean; readonly historyRevision: number | null },
  ): FinishReceiptInsertValues {
    return {
      householdId: session.householdId,
      sessionId: session.id,
      deviceSessionId: session.deviceSessionId,
      profileContextVersion: session.profileContextVersion,
      generation: session.generation,
      operationKey: input.operationKey,
      requestDigest: digest,
      finalSeq: input.finalProgress.sampleSeq,
      finalSessionAccepted: evaluation.finalSessionAccepted,
      historyApplied: applied.historyApplied,
      historyRevision: applied.historyRevision,
      sessionCompleted: evaluation.sessionCompleted,
      autoNextEligible: evaluation.autoNextEligible,
      reason: evaluation.reason,
      /* final 先校验接受:仅接受样本落位置(未接受的 final 不冒充) */
      positionSeconds: evaluation.finalSessionAccepted ? input.finalProgress.positionSeconds : null,
      durationSeconds: facts.durationSeconds,
      /* 本次 finish 即终态时刻(ended 由 receipt 层表达;stale/软形态同样可 ended) */
      endedAt: nowIso,
      ...facts.revisions,
    };
  }
}

/** receipt 读兜底(insert 后回读;缺失即编程错误,显式失败) */
function requireReceiptRow(
  store: Pick<PlaybackFinishTxStores, 'findReceipt'>,
  scope: PlaybackFinishScope,
): FinishReceiptRow {
  const row = store.findReceipt(scope.householdId, scope.sessionId);
  if (row === undefined) {
    throw new Error(`playback_finish_receipt 缺失:finish 事务内回读失败(session=${scope.sessionId})`);
  }
  return row;
}
