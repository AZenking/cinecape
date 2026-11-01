import { createHash } from 'node:crypto';
import { createDomainError, DomainError } from '@platform/http-common/domain-error';
import {
  ingestObservation,
  maxPlausibleAdvanceSeconds,
  OBSERVATION_GAP_UNKNOWN_SECONDS,
  type ObservationIngestOutcome,
  type PhaseObservation,
  type PhaseObservationEvent,
} from '@contexts/playback/domain/finish.rules';
import type {
  ObservationTx,
  PhaseObservationInsertValues,
  PhaseObservationRow,
  PlaybackDeliveryFactReader,
  PlaybackIdentityReader,
  PlaybackSessionRow,
  PlaybackSessionTx,
} from '@contexts/playback/application/playback-work-set.port';

/**
 * 010-online-vod T057 — 播放相位观测服务(US3;T054 ingestObservation 的持久化包装)。
 *
 * 职责边界(tasks.md T057 原文 + 审查补充):
 * - 「最新event_seq幂等;seek/pause/buffering/error/未知跳跃重置anchor;不写个人历史;
 *   最高2Hz/会话,正常playing每1s,固定TTL会话生命周期」;rate 0.5–2、推进 ≤ 服务器间隔×
 *   rate+0.5s、gap>3s 为 unknown;「不能用观测当授权证明」;
 * - 审查补充:「playing观测与session.playback_started_at同事务,交付/身份/代次校验,
 *   不写 ledger/history」。
 *
 * 来源标注(实现侧不自创语义,契约冻结面):
 * - docs/specs/010-online-vod/data-model.md §5 playback_phase_observation 行:
 *   「session_id,generation,event_seq,digest,event_type,position,rate,server_received_at,
 *   tail_anchor_position/time,delivered_seen;最新event_seq幂等;seek/pause/buffering/error/
 *   未知跳跃重置anchor;不写个人历史;最高2Hz/会话,正常playing每1s,固定TTL会话生命周期」;
 *   §5 正文「观测匹配generation、服务端接收时间和已交付;允许0.5–2倍速,推进不得大于服务器
 *   间隔×rate+0.5s;gap>3s、跳跃/暂停/缓冲使资格unknown,需新的连续末段」;§9「独立
 *   playback_started_at由已交付后的合格playing观测设置后解除该期限(不要求进度可保存)」;
 *   §10「playing观测与session标记同短事务、CAS重验当前代/活动态/交付及授权;无时长仍可
 *   设置,不能据此写历史、完成或carry」。
 * - docs/specs/010-online-vod/contracts/api.md §4 observations 行:「200{accepted,lastEventSeq};
 *   同seq同载荷重放,冲突409、陈旧false;无历史/epoch写;授权/交付/phase检查」+ §7 I4
 *   「observations回复追加playbackStarted:boolean;服务器在当前身份/策略、generation、
 *   ready/playing/paused及受控交付事实均有效时,接受playing观测并原子设置独立
 *   playback_started_at…收到playing的HTTP确认后UI才视为解除等待」+ §0「phase观测独立
 *   120/min/session」「限流429+Retry-After」。
 * - domain/finish.rules(T054 共享纯函数面):ingestObservation 七态为本文件锚语义唯一
 *   权威;「T057 接线点:逐条调用 ingestObservation 落 playback_phase_observation
 *   (tail_anchor_position/time 随 accepted/anchor_reset 持久化;duplicate/conflict/stale/
 *   rejected 不改锚);同 seq 幂等比较只比对业务载荷(event/position/rate/generation),
 *   serverReceivedAtMs 由服务端写入、不参与重放比对;同 seq 冲突(409)的权威判定在
 *   持久 digest(playback_phase_observation.digest 列)——服务层先查 digest 再调用本函数,
 *   不得以纯函数为冲突唯一裁决」。
 * - T044 交付面:PlaybackDeliveryFactReader.findDeliveryFacts(受控交付/代次/会话态事实,
 *   delivery 非空即「已交付」判定接缝);T045 交付面:PlaybackSessionTx.markPlaybackStartedAt
 *   (playback_started_at NULL→值 单向 CAS,与 watchdog 同一 session CAS 竞争)。
 *
 * 七态落库映射(本文件 ⇄ finish.rules ingestObservation 的权威对照):
 * | 纯函数 outcome                  | HTTP/落库形态                                          |
 * | -------------------------------- | ------------------------------------------------------ |
 * | accepted(playing 延伸/ratechange 透传) | 200 accepted=true,lastEventSeq=seq,落行(锚=既有 streak 头/透传不变) |
 * | anchor_reset(显式 seek/pause/waiting/error/gap_over_3s/回跳 unknown_jump) | 200 accepted=true,lastEventSeq=seq,落行(新 streak 头为锚;空 streak 行锚成对 NULL) |
 * | anchor_reset(unknown_jump,推进>界) | 200 accepted=false,lastEventSeq 不动,**不落行**(契约 A7 钉面:「不可行推进被拒…拒绝观测不落数据行、不入尾段证据」) |
 * | duplicate                        | 200 accepted=true,lastEventSeq=seq,零写入(持久 digest 相等) |
 * | conflict                         | 409 PROGRESS_SAMPLE_CONFLICT(持久 digest 相异),零写入 |
 * | stale                            | 200 accepted=false,lastEventSeq=最新游标,零写入 |
 * | rejected(rate/generation)        | 200 accepted=false(schema 已先行 400 拒越界倍速;此处为纵深防御),零写入 |
 *
 * 2Hz 限流取态裁决(任务要求「钉一种并注释依据」):**429 + Retry-After**。依据 api.md §0
 * 「phase观测独立120/min/session」与「限流429+Retry-After」「资源忙返回429不堆无界队列」;
 * accepted=false 形态保留给「陈旧」(§4「陈旧false」)与不可行推进(A7),限流是传输面资源
 * 保护而非观测语义,不入 accepted 布尔。2Hz=120/min 同一预算的两种表述(data-model §5
 * 「最高2Hz/会话」= api.md §0「120/min/session」),落地为**会话级滑动 60s 窗、上限 120**:
 * 不做硬性 500ms 最小间隔门 —— 契约钉面 A4(相邻毫秒级重放)/A5(0.4s 步进 × 25ms 真实
 * 间隔)/B 组尾段 rig 均依赖突发容忍,硬间隔门会使冻结契约失绿;滑动窗平均 2Hz 与两个
 * 契约源逐字一致。桶为进程内存态(与 PlaybackRateLimitService/RateLimitService 同口径),
 * 键即会话生命周期:固定 60s TTL 淘汰窗口外时刻、空键清扫(T057「固定TTL会话生命周期」
 * 的限流面落点;观测行本身的保留/回收归 data-model §9 既有保留面,不在本服务)。
 *
 * 不变量(逐条对应契约断言):
 * - 观测不是授权证明:本服务不写 playback_progress_state/ledger、不写
 *   profile_viewing_history、不分配 epoch、不产生任何完成/carry 资格(A1 存储面钉);
 *   playback_started_at 仅解除 60s 未起播回收期限(data-model §9),无时长仍可设置。
 * - 观测不当授权证明:所有写入前在事务内重验身份(撤销/过期/上下文版本)、会话归属、
 *   当前代、活动态与受控交付事实;授权失败优先于专用错误(api.md §0)。
 * - 冲突权威 = 持久 digest:先查 (session,eventSeq) 行再 ingest;同 seq 同 digest →
 *   duplicate 重放;异 digest → 409 PROGRESS_SAMPLE_CONFLICT(共用既有稳定码,api.md
 *   §0 错误白名单不新增枚举)。
 * - 推进/gap 校验先行(gap 先于推进,与 finish.rules extendOrResetStreak 判序逐字一致,
 *   E5 互检共用 maxPlausibleAdvanceSeconds/OBSERVATION_GAP_UNKNOWN_SECONDS 常量,不得
 *   私自复写阈值)。
 */

/* ------------------------------------------------------------------ */
/* 限流预算(api.md §0「phase观测独立120/min/session」= data-model §5「最高2Hz/会话」) */
/* ------------------------------------------------------------------ */

/** 每会话观测桶上限(滑动 60s 窗;2Hz 的每分钟表述,数值冻结不自 env 调节) */
export const OBSERVATION_RATE_LIMIT_PER_SESSION_PER_MINUTE = 120;

/** 滑动窗口宽度(契约口径「每分钟」;同既有限频器 60_000ms) */
const OBSERVATION_WINDOW_MS = 60_000;

/** 会话键数软上限(超过触发全表空窗清扫;会话维度键域有界,兜底防异常增长) */
const OBSERVATION_MAX_KEYS = 10_000;

/* ------------------------------------------------------------------ */
/* 请求/回复形状(controller zod 解析后的服务侧输入;api.md §4 observations 行) */
/* ------------------------------------------------------------------ */

/** 单条相位观测请求(严格面;身份一律服务端推导,无 body 身份字段) */
export interface PhaseObservationInput {
  readonly eventSeq: number;
  readonly expectedGeneration: number;
  readonly event: PhaseObservationEvent;
  readonly positionSeconds: number;
  readonly playbackRate: number;
}

/** 观测回复(api.md §4/§7 I4:200{accepted,lastEventSeq} + playbackStarted 追加键) */
export interface ObservationReply {
  readonly accepted: boolean;
  readonly lastEventSeq: number;
  readonly playbackStarted: boolean;
}

/** 观测写入范围(会话归属防御输入;身份只从服务端会话上下文推导) */
export interface PhaseObservationScope {
  readonly householdId: string;
  readonly deviceSessionId: string;
  readonly sessionId: string;
}

/**
 * 会话观测限流 429(api.md §0「限流429+Retry-After」;Retry-After 由控制器按窗口余量
 * 动态注入响应头,同 004 播放限频口径 —— ProblemJsonFilter 注册表无动态头)。
 */
export class PlaybackObservationRateLimitedError extends DomainError {
  constructor(readonly retryAfterSeconds: number) {
    super(429, 'PLAYBACK_RATE_LIMITED', '观测上报过于频繁,请稍后重试');
    this.name = 'PlaybackObservationRateLimitedError';
  }
}

/* ------------------------------------------------------------------ */
/* digest(同 seq 幂等/冲突权威;T054「payload 不含接收时刻」)              */
/* ------------------------------------------------------------------ */

/**
 * 观测业务载荷规范化摘要:只比对 (generation,event,position,rate) —— eventSeq 是幂等键
 * 本身不入摘要,serverReceivedAtMs 由服务端写入、不参与重放比对(T054 接线点注)。数字
 * 以可逆十进制文本编码(规避 -0/科学计数法差异)、键序固定,与 personal-data
 * progressSampleDigest 同款规范化纪律;领域前缀隔离,禁与其他摘要族互撞。
 */
export function phaseObservationDigest(input: {
  readonly generation: number;
  readonly event: PhaseObservationEvent;
  readonly positionSeconds: number;
  readonly playbackRate: number;
}): string {
  const payload = JSON.stringify({
    g: input.generation,
    e: input.event,
    p: Object.is(input.positionSeconds, -0) ? '-0' : String(input.positionSeconds),
    r: Object.is(input.playbackRate, -0) ? '-0' : String(input.playbackRate),
  });
  return createHash('sha256').update(`hmp-playback-observation\u0000${payload}`, 'utf8').digest('hex');
}

/* ------------------------------------------------------------------ */
/* UnitOfWork 结构镜像(不深导 platform/database;对齐 playback-vod-resolve.providers 先例) */
/* ------------------------------------------------------------------ */

/**
 * 观测尾段状态读取面(T057 最小装配增量,transaction-participants 具体类承载):
 * 端口面 ObservationTx 只有按 seq 精确查(冲突权威),锚语义重建还需「最新一行」
 * (幂等游标 + 既有尾锚)与「最新 playing 一行」(连续推进界比对基准)。端口文件已冻结,
 * 不扩端口 —— 以具体参与者类的附加读投影承载(与 PlaybackDeliveryFactReader 同文件同
 * 先例),键域均为 (household,session) 复合主键前缀,LIMIT 1 有界。
 */
export interface ObservationTailStateReader {
  /** 最新一条观测(幂等游标 + 当前尾锚;event_seq DESC LIMIT 1) */
  findLatestObservation(householdId: string, sessionId: string): PhaseObservationRow | undefined;
  /** 最新一条 playing 观测(连续推进/gap 比对基准;ratechange/重置类不入链) */
  findLatestPlayingObservation(householdId: string, sessionId: string): PhaseObservationRow | undefined;
}

/** 观测事务工作集消费的绑定后 txStores(键名与组合根注册表一致,按需取用) */
export interface ObservationTxBoundStores {
  readonly credential: { readonly transactionId: string; readonly behavior: 'immediate' };
  readonly identityAccess: PlaybackIdentityReader;
  readonly playback: PlaybackSessionTx & ObservationTx & PlaybackDeliveryFactReader & ObservationTailStateReader;
}

/** 平台 UnitOfWork.run 的同步返回形态镜像(thenable 压 never;与平台逐字同构) */
export type ObservationSyncResult<T> = [T] extends [PromiseLike<unknown>] ? never : T;

/** 平台 UnitOfWork 的结构镜像(方法语法 → 参数双向协变;编译期结构校验) */
export interface ObservationUnitOfWork {
  run<TWorkSet, TResult>(
    workSetFactory: (txStores: ObservationTxBoundStores) => TWorkSet,
    callback: (workSet: TWorkSet) => TResult,
    options: { readonly behavior: 'immediate'; readonly busyBudgetMs?: number },
  ): ObservationSyncResult<TResult>;
}

/* ------------------------------------------------------------------ */
/* 内部形状                                                              */
/* ------------------------------------------------------------------ */

/** 尾锚成对值(持久化形态;空 streak ⇒ 成对 NULL,CHECK 落实) */
interface TailAnchorPair {
  readonly positionSeconds: number;
  readonly timeIso: string;
}

/** 事务内校验后的会话与尾段状态快照(单事务内一致,出作用域即弃) */
interface IngestFacts {
  readonly session: PlaybackSessionRow;
  readonly latest: PhaseObservationRow | undefined;
  readonly lastPlaying: PhaseObservationRow | undefined;
}

/** 判定会话状态是否为可观测活动态(I4「ready/playing/paused及受控交付事实均有效」) */
function observableStateOf(state: PlaybackSessionRow['state']): 'active' | 'preparing' | 'terminal' {
  if (state === 'ready' || state === 'playing' || state === 'paused') {
    return 'active';
  }
  return state === 'preparing' ? 'preparing' : 'terminal';
}

/** 行 → 纯函数样本投影(serverReceivedAt 解析回毫秒;Facts 均为服务端写入值) */
function toPhaseObservation(row: PhaseObservationRow): PhaseObservation {
  return {
    generation: row.generation,
    eventSeq: row.eventSeq,
    // 列值域由 schema CHECK(七值枚举)保证;越域形态按编程错误 fail-closed(不入锚)
    event: OBSERVATION_EVENTS.includes(row.eventType as PhaseObservationEvent)
      ? (row.eventType as PhaseObservationEvent)
      : failClosedEventType(row.eventType),
    positionSeconds: row.positionSeconds,
    rate: row.playbackRate,
    serverReceivedAtMs: Date.parse(row.serverReceivedAt),
  };
}

/** 观测事件七值(api.md §4;与 schema CHECK 同源,防御性收窄用) */
const OBSERVATION_EVENTS: readonly PhaseObservationEvent[] = [
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

/** 行尾锚成对读取(CHECK 保证成对;防御性双非空判定) */
function anchorPairOf(row: PhaseObservationRow | undefined): TailAnchorPair | null {
  if (
    row !== undefined &&
    row.tailAnchorPositionSeconds !== null &&
    row.tailAnchorTime !== null
  ) {
    return { positionSeconds: row.tailAnchorPositionSeconds, timeIso: row.tailAnchorTime };
  }
  return null;
}

/**
 * 本次落行应携带的尾锚(七态映射的锚持久化面):
 * - accepted(playing):空链开创 → 本样本;延伸 → 既有 streak 头不变(锚=当前连续末段
 *   起点,A5 存储面:同 streak 各行锚成对一致);
 * - accepted(ratechange):透传不清空 → 锚原样(空链仍空);
 * - anchor_reset:新 streak 非空(playing 重锚/回跳)→ 本样本;空(seek/pause/buffering/
 *   error)→ 成对 NULL;
 * - duplicate/conflict/stale/rejected:不落行,不经过本函数(duplicate/conflict/stale/
 *   rejected 不改锚 —— 既有行锚不被任何路径改写,本服务对观测行零 UPDATE)。
 */
function anchorForOutcome(
  outcome: ObservationIngestOutcome,
  previousAnchor: TailAnchorPair | null,
  incoming: PhaseObservation,
  serverReceivedAtIso: string,
): TailAnchorPair | null {
  if (outcome.kind === 'accepted') {
    if (incoming.event === 'ratechange') {
      return previousAnchor;
    }
    return previousAnchor ?? { positionSeconds: incoming.positionSeconds, timeIso: serverReceivedAtIso };
  }
  if (outcome.kind === 'anchor_reset') {
    return outcome.state.streak.length > 0
      ? { positionSeconds: incoming.positionSeconds, timeIso: serverReceivedAtIso }
      : null;
  }
  return null;
}

/* ------------------------------------------------------------------ */
/* 服务(纯类;单测直接 new 注入时钟与 UnitOfWork,生产经 playback.module 工厂装配) */
/* ------------------------------------------------------------------ */

export class PhaseObservationService {
  /** 会话观测滑动窗:键 `${householdId}\u0000${sessionId}` → 窗口内通过时刻升序序列 */
  private readonly windows = new Map<string, number[]>();
  private readonly clock: { now(): number };

  constructor(
    private readonly uow: ObservationUnitOfWork,
    clock?: { now(): number },
  ) {
    this.clock = clock ?? { now: () => Date.now() };
  }

  /**
   * 逐条观测 ingest(同步短事务;任何校验失败零写入):
   *
   * 判定序(先传输面限流,再事务内身份/归属/代次/phase/交付,再幂等 digest,再锚语义):
   * 1. 会话滑动窗 acquire(120/min/session;超限 429+Retry-After,请求计数先于业务判定,
   *    防绕过 —— 与既有限频器「计数点为通过检查的请求」同口径);
   * 2. 事务内身份重验(findDeviceContext:行缺失/已撤销/已过期 → 401 SESSION_INVALID);
   * 3. 会话归属防御(非本设备会话/绑定上下文版本不等/绑定档案不等 → 404 同形,不泄露
   *    存在性;api.md §0「来源/上下文授权失败优先于专用错误」);
   * 4. phase 校验(终态 → 409 PLAYBACK_ENDED;preparing → 409 PLAYBACK_NOT_READY;
   *    delivery 空 → 409 PLAYBACK_NOT_READY —— I4「受控交付事实均有效」);
   * 5. 代次校验(expectedGeneration ≠ 当前 generation → 409 PLAYBACK_GENERATION_STALE,
   *    与 progress 写入状态机同形;纯函数 generation_mismatch 态保留为纵深防御);
   * 6. 幂等 digest(同 seq 行存在:digest 相等且为最新 → duplicate 重放;相异 → 409
   *    PROGRESS_SAMPLE_CONFLICT;非最新 → stale);
   * 7. 锚语义(gap 先于推进,与 finish.rules 判序一致):gap>3s → anchor_reset 落行重锚;
   *    推进 > 间隔×rate+0.5 → accepted=false 不落行(契约 A7);其余经 ingestObservation
   *    七态映射落行;
   * 8. playing 特例:落行成功即同事务 markPlaybackStartedAt(NULL→值 CAS;不写
   *    ledger/history;终态已在前置拒绝,与 watchdog 同一 session CAS 竞争)。
   */
  ingest(scope: PhaseObservationScope, input: PhaseObservationInput): ObservationReply {
    const nowMs = this.clock.now();
    this.acquireSessionSlot(scope, nowMs);
    const serverReceivedAtIso = new Date(nowMs).toISOString();
    const digest = phaseObservationDigest({
      generation: input.expectedGeneration,
      event: input.event,
      positionSeconds: input.positionSeconds,
      playbackRate: input.playbackRate,
    });
    return this.uow.run(
      (txStores) => ({ identity: txStores.identityAccess, store: txStores.playback }),
      (workSet) => {
        const facts = this.verifyFacts(workSet, scope, input, nowMs);
        /* 幂等 digest(权威=持久行;先查 digest 再 ingest,T054 接线点) */
        const latestSeq = facts.latest?.eventSeq ?? 0;
        const existing = facts.latest !== undefined && facts.latest.eventSeq === input.eventSeq
          ? facts.latest
          : workSet.store.findObservation(scope.householdId, scope.sessionId, input.eventSeq);
        if (existing !== undefined) {
          if (input.eventSeq < latestSeq) {
            /* 陈旧:游标不回退,零写入(api.md §4「陈旧false」) */
            return this.reply(false, latestSeq, facts.session);
          }
          if (existing.digest === digest) {
            /* 同 seq 同载荷重放:返回既有结果,零写入(不重复落行) */
            return this.reply(true, existing.eventSeq, facts.session);
          }
          /* 同 seq 异载荷:409(共用既有 PROGRESS_SAMPLE_CONFLICT 稳定码,白名单不新增) */
          throw createDomainError('PROGRESS_SAMPLE_CONFLICT');
        }
        /* 锚语义:锚状态重建 → 推进预检(A7)→ 纯函数七态 */
        const incoming: PhaseObservation = {
          generation: facts.session.generation,
          eventSeq: input.eventSeq,
          event: input.event,
          positionSeconds: input.positionSeconds,
          rate: input.playbackRate,
          serverReceivedAtMs: nowMs,
        };
        const previousAnchor = anchorPairOf(facts.latest);
        const streakEmpty = facts.latest === undefined || previousAnchor === null;
        const tailRow = streakEmpty ? undefined : this.streakTailOf(facts);
        if (incoming.event === 'playing' && tailRow !== undefined) {
          /* 推进/gap 校验先行(判序与 finish.rules extendOrResetStreak 逐字一致:E5 互检),
           * 且仅约束 playing 连续推进(契约 A5 注:「推进约束仅约束 playing 连续推进」;
           * seek/pause 等重置类事件按契约必须可携带跳变位置上报):
           * gap(>3s)不在此拒绝 —— 交由纯函数 anchor_reset 落行重锚(需新的连续末段);
           * 仅「可行间隔内的超界推进」在落行前拒(契约 A7:accepted=false/游标不动/不落行)。
           * advance<0(无 seek 事件的回跳)不在此拒 —— 归纯函数 unknown_jump 落行重锚,
           * 保守 unknown 资格语义(data-model §5「跳跃…使资格unknown」)。 */
          const intervalSeconds = (nowMs - Date.parse(tailRow.serverReceivedAt)) / 1000;
          if (intervalSeconds <= OBSERVATION_GAP_UNKNOWN_SECONDS) {
            const advanceSeconds = incoming.positionSeconds - tailRow.positionSeconds;
            if (advanceSeconds > maxPlausibleAdvanceSeconds(intervalSeconds, incoming.rate)) {
              return this.reply(false, latestSeq, facts.session);
            }
          }
        }
        const previous = {
          generation: facts.session.generation,
          latestEventSeq: latestSeq,
          streak: tailRow === undefined ? [] : [toPhaseObservation(tailRow)],
        };
        const outcome = ingestObservation(previous, incoming, facts.session.generation);
        if (outcome.kind === 'rejected' || outcome.kind === 'duplicate' || outcome.kind === 'conflict' || outcome.kind === 'stale') {
          /* rejected:倍速由 schema 先行 400、代次已在前置 409 —— 纵深防御形态,零写入;
           * duplicate/conflict/stale:已在持久 digest 段收口,此处不可达(防御归一) */
          return this.reply(false, latestSeq, facts.session);
        }
        const anchor = anchorForOutcome(outcome, previousAnchor, incoming, serverReceivedAtIso);
        const values: PhaseObservationInsertValues = {
          householdId: scope.householdId,
          sessionId: scope.sessionId,
          generation: facts.session.generation,
          eventSeq: input.eventSeq,
          digest,
          eventType: input.event,
          positionSeconds: input.positionSeconds,
          playbackRate: input.playbackRate,
          serverReceivedAt: serverReceivedAtIso,
          tailAnchorPositionSeconds: anchor?.positionSeconds ?? null,
          tailAnchorTime: anchor?.timeIso ?? null,
          deliveredSeen: true,
        };
        workSet.store.insertObservation(values);
        /* playing 特例(I4):落行成功即同事务设置独立起播标记(NULL→值 CAS;与 watchdog
         * 同一 session CAS 竞争;不写 ledger/history;无时长仍可设置)。 */
        if (input.event === 'playing' && facts.session.playbackStartedAt === null) {
          workSet.store.markPlaybackStartedAt(scope.householdId, scope.sessionId, serverReceivedAtIso);
        }
        return this.reply(true, input.eventSeq, facts.session, true);
      },
      { behavior: 'immediate' },
    );
  }

  /* ---------------- 内部:限流桶(会话级滑动窗,TTL=窗口宽度) ---------------- */

  /**
   * 会话观测槽申请:通过即记账并返回;超限抛 429(附 Retry-After 秒,最旧存活时刻离开
   * 窗口的剩余时间向上取整)。键域为播放会话(120/min/session),进程内存态,重启清零
   * 只影响瞬时配额(与既有限频器同口径);TTL:窗口外时刻逐次修剪、空键全表清扫。
   */
  private acquireSessionSlot(scope: PhaseObservationScope, atMs: number): void {
    const key = `${scope.householdId}\u0000${scope.sessionId}`;
    let stamps = this.windows.get(key);
    if (stamps === undefined) {
      stamps = [];
      this.windows.set(key, stamps);
    }
    const cutoff = atMs - OBSERVATION_WINDOW_MS;
    let firstLive = 0;
    while (firstLive < stamps.length && (stamps[firstLive] as number) <= cutoff) {
      firstLive += 1;
    }
    if (firstLive > 0) {
      stamps.splice(0, firstLive);
    }
    if (stamps.length >= OBSERVATION_RATE_LIMIT_PER_SESSION_PER_MINUTE) {
      const oldest = stamps[0] as number;
      throw new PlaybackObservationRateLimitedError(
        Math.max(1, Math.ceil((oldest + OBSERVATION_WINDOW_MS - atMs) / 1000)),
      );
    }
    stamps.push(atMs);
    if (this.windows.size > OBSERVATION_MAX_KEYS) {
      this.sweepIdleKeys(atMs);
    }
  }

  /** 全表清扫:窗口完全为空的会话键移除(有界内存兜底;固定 TTL 生命周期面) */
  private sweepIdleKeys(atMs: number): void {
    const cutoff = atMs - OBSERVATION_WINDOW_MS;
    for (const [key, stamps] of this.windows) {
      let live = false;
      for (let index = stamps.length - 1; index >= 0; index -= 1) {
        const stamp = stamps[index];
        if (stamp !== undefined && stamp > cutoff) {
          live = true;
          break;
        }
      }
      if (!live) {
        this.windows.delete(key);
      }
    }
  }

  /* ---------------- 内部:事务内事实校验(身份/归属/phase/代次/交付) ---------------- */

  /** 事务内校验(I4「CAS重验当前代/活动态/交付及授权」);失败一律抛稳定码,零写入 */
  private verifyFacts(
    workSet: { readonly identity: PlaybackIdentityReader } & {
      readonly store: PlaybackSessionTx & PlaybackDeliveryFactReader & ObservationTailStateReader;
    },
    scope: PhaseObservationScope,
    input: PhaseObservationInput,
    nowMs: number,
  ): IngestFacts {
    /* 身份重验(撤销/过期/无当前观看者即拒绝;已授权不能替代事务内重验) */
    const identity = workSet.identity.findDeviceContext(scope.deviceSessionId);
    if (
      identity === undefined ||
      identity.revokedAt !== null ||
      Date.parse(identity.expiresAt) <= nowMs
    ) {
      throw new DomainError(401, 'SESSION_INVALID', undefined);
    }
    const session = workSet.store.findSession(scope.householdId, scope.sessionId);
    if (session === undefined || session.deviceSessionId !== scope.deviceSessionId) {
      /* 跨设备/不存在同形 404,不泄露存在性 */
      throw createDomainError('PLAYBACK_NOT_FOUND');
    }
    if (
      session.profileContextVersion !== identity.profileContextVersion ||
      session.profileId !== identity.profileId
    ) {
      /* 旧上下文/档案错位 → 与不存在同形 404(T045 A→B→A 旧上下文稳定拒绝) */
      throw createDomainError('PLAYBACK_NOT_FOUND');
    }
    /* phase 校验:终态不可观测(PLAYBACK_ENDED);preparing 未就绪(PLAYBACK_NOT_READY) */
    const phase = observableStateOf(session.state);
    if (phase === 'terminal') {
      throw createDomainError('PLAYBACK_ENDED');
    }
    if (phase === 'preparing' || session.delivery === null) {
      /* 受控交付事实无效(I4「受控交付事实均有效时,接受playing观测」) */
      throw createDomainError('PLAYBACK_NOT_READY');
    }
    /* 代次校验(与 progress 写入状态机同形;纯函数 generation_mismatch 为纵深防御) */
    if (session.generation !== input.expectedGeneration) {
      throw createDomainError('PLAYBACK_GENERATION_STALE');
    }
    return {
      session,
      latest: workSet.store.findLatestObservation(scope.householdId, scope.sessionId),
      lastPlaying: workSet.store.findLatestPlayingObservation(scope.householdId, scope.sessionId),
    };
  }

  /**
   * 当前连续末段末条(推进/gap 比对基准)。不变量:最新行尾锚非空 ⇒ streak 非空且全部
   * 成员为 playing 行、各行情同锚(=streak 头);最新 playing 行即末条(同锚校验为防御,
   * 失配按空链处理 —— 保守开创新段,不做推进拒绝)。
   */
  private streakTailOf(facts: IngestFacts): PhaseObservationRow | undefined {
    const latestAnchor = anchorPairOf(facts.latest);
    const candidate = facts.lastPlaying;
    if (latestAnchor === null || candidate === undefined) {
      return undefined;
    }
    const candidateAnchor = anchorPairOf(candidate);
    if (
      candidateAnchor === null ||
      candidateAnchor.positionSeconds !== latestAnchor.positionSeconds ||
      candidateAnchor.timeIso !== latestAnchor.timeIso
    ) {
      return undefined;
    }
    return candidate;
  }

  /** 回复组装(playbackStarted=会话级起播事实;本次刚设置或既有均报告 true) */
  private reply(
    accepted: boolean,
    lastEventSeq: number,
    session: PlaybackSessionRow,
    startedJustNow = false,
  ): ObservationReply {
    return {
      accepted,
      lastEventSeq,
      playbackStarted: startedJustNow || session.playbackStartedAt !== null,
    };
  }
}
