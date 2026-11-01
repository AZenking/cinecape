import { describe, expect, it } from 'vitest';
import {
  evaluateFinish,
  evaluateTailEligibility,
  FINISH_REASONS_BLOCKING_MANUAL_NEXT,
  ingestObservation,
  isRateAllowed,
  maxPlausibleAdvanceSeconds,
  OBSERVATION_ADVANCE_SLACK_SECONDS,
  OBSERVATION_GAP_UNKNOWN_SECONDS,
  OBSERVATION_MAX_RATE,
  OBSERVATION_MIN_RATE,
  resolveFinishInvocation,
  TAIL_FINAL_WINDOW_CAP_SECONDS,
  TAIL_STREAK_CAP_SECONDS,
  TAIL_WINDOW_RATIO,
  tailFinalWindowSeconds,
  tailStreakSeconds,
  type FinishEvaluationInput,
  type FinishReason,
  type ObservationTailState,
  type PhaseObservation,
  type PhaseObservationEvent,
  type TailEligibilityInput,
  type TailEligibilityOutcome,
} from '@contexts/playback/domain/finish.rules';
import {
  createFixtureFakeClock,
  FIXTURE_UPSTREAM_FIXED_NOW_MS,
  type FixtureFakeClock,
} from '../../fixtures/online-vod/fixture-world';

/**
 * 010 T053(测试先行,US3)—— 完成判定(尾段/末段/finish 调用面)契约钉面(计划内红,待 T054/T058 转绿)。
 *
 * ⚠️ 计划内红(文件顶部声明):被测模块由 T054 创建(判定/调用面)、T058 消费
 * (playback-finish.service/lifecycle 原子提交),当前不存在——
 *   `@contexts/playback/domain/finish.rules`(完成判定与 finish 调用规则,纯领域,零依赖)。
 * 当前阶段预期(对齐 continuity-resume.spec.ts 的 T037 先例):
 *   1. `pnpm --filter @hmp/server exec vitest run test/unit/playback/vod-completion.spec.ts`
 *      收集期失败(模块不存在);
 *   2. `pnpm --filter @hmp/server typecheck` 恰好新增一条 TS2307(上述模块),零其他错误;
 *   3. eslint 零错误。
 * 本文件即 T054/T058 行为契约(ingestObservation 部分同时是 T057 锚语义的共享纯函数面):
 * 实现须使本文件全绿;纯函数、零网络、零真实时钟(FakeClock 只用于生成样本时刻)。
 *
 * 被测范围(tasks.md T053 原文):「先新增 …apps/server/test/unit/playback/vod-completion.spec.ts,
 * 覆盖…0.5–2倍速/短片/seek到尾/周期样本距尾8s/断网尾段未知等规则」(依赖:T005, T039)。
 *
 * 契约权威(实现侧不自创语义):
 * - data-model.md §5:「观测不是不可伪造观看证明:仅作用于产品连播资格。final位置先被验证接受,
 *   再计算尾部min(5s,duration×5%)及末段min(2s,duration×5%)。观测匹配generation、服务端接收时间
 *   和已交付;允许0.5–2倍速,推进不得大于服务器间隔×rate+0.5s;gap>3s、跳跃/暂停/缓冲使资格
 *   unknown,需新的连续末段。finish前flush有序末段观测再提交final。末段太短且无法收集有效观测
 *   则拒绝auto-next,允许manual_next。completed是会话观测结果,不影响目标授权」;
 *   playback_finish_receipt 行:「session_id唯一…旧stop先赢则receipt=not_completed;终态不得由
 *   新finish升级;重放仅返回既有结果」。
 * - contracts/playback-state.md §4:「finish流程:停周期→按序flush尾段观测→分配一次final
 *   seq/payload→同事务接受final→更新ledger→按epoch可选历史→计算sessionCompleted/
 *   autoNextEligible→写receipt→ended。保存硬错误回滚,不部分终态化;stale final可ended但不可
 *   auto-next。superseded final可sessionAccepted/completed而historyApplied=false」;「完成只是
 *   一组可观测产品条件:本次started与交付、可信duration、最终样本落min(5s,d×5%)、尾段
 *   min(2s,d×5%)连续推进,observations服务器接收时间/rate可行且无已知中断/seek。观测缺失或
 *   gap>3s保守unknown;不要求上次10s进度已在最后5秒。到尾seek立即ended没有新的合格尾段→
 *   不连播;seek到稍早位置再连续播放足够尾段可以合格,不声称用户看完整集」;「普通stop仍204…
 *   stop先赢后finish返回not_completed,不能给ended任意升级资格」。
 * - contracts/api.md §1 FinishReceipt.reason 七值:completed|stale_final|no_tail_observation|
 *   not_started|no_duration|not_completed|stopped_elsewhere;§4 finish 行:「无证据不等于接口
 *   失败,可ended=true/autoNextEligible=false」「已有receipt且新key不同则409
 *   FINISH_ALREADY_RECORDED」;observations 行:rate 0.5–2、同seq同载荷重放/冲突409/陈旧false。
 * - spec.md FR-022(会话级结束结果独立表示)/FR-023(先处理最终样本再判定,不能要求上一次周期
 *   样本已在尾部)/FR-024(跳到尾部、倍速、临近尾部续播、短片、断网补报执行一致的末段连续播放
 *   检查;允许的正常倍速不得仅因墙钟时长不足被拒绝);T054/T057/T058 tasks 原文。
 *
 * 数值勘误(T053 任务文 vs 公式):任务文「短片 min(2s,5%)=0.6s」对应 12s 媒体;
 * 按 data-model §5 公式 min(2s,d×5%),30s 媒体的末段=1.5s、12s 媒体=0.6s。本钉面按公式钉死,
 * 0.6s 形态以 12s 素材覆盖(B 组)。
 *
 * 建议导出面(T054 实现者照钉;本文件 import 面即契约,语义见各表):
 *   - const OBSERVATION_MIN_RATE = 0.5; OBSERVATION_MAX_RATE = 2            // api.md 闭区间
 *   - const OBSERVATION_ADVANCE_SLACK_SECONDS = 0.5                         // 推进松弛
 *   - const OBSERVATION_GAP_UNKNOWN_SECONDS = 3                             // gap>3s → unknown
 *   - const TAIL_FINAL_WINDOW_CAP_SECONDS = 5; TAIL_STREAK_CAP_SECONDS = 2  // min 上限
 *   - const TAIL_WINDOW_RATIO = 0.05                                        // d×5%
 *   - function tailFinalWindowSeconds(durationSeconds): number              // min(5, d×5%)
 *   - function tailStreakSeconds(durationSeconds): number                   // min(2, d×5%)
 *   - function maxPlausibleAdvanceSeconds(intervalSeconds, rate): number    // interval×rate+0.5
 *   - function isRateAllowed(rate): boolean                                 // 0.5 ≤ rate ≤ 2
 *   - type PhaseObservationEvent = 'playing'|'pause'|'seeking'|'seeked'|'waiting'|'ratechange'|'error'
 *   - interface PhaseObservation { generation; eventSeq; event; positionSeconds; rate; serverReceivedAtMs }
 *   - interface ObservationTailState { generation; latestEventSeq; streak: readonly PhaseObservation[] }
 *   - type AnchorResetCause = 'seeking'|'seeked'|'pause'|'buffering'|'error'|'unknown_jump'|'gap_over_3s'
 *   - type ObservationIngestOutcome = { kind:'accepted'; state } | { kind:'duplicate' } |
 *       { kind:'conflict' } | { kind:'stale' } |
 *       { kind:'rejected'; cause:'rate_out_of_range'|'generation_mismatch' } |
 *       { kind:'anchor_reset'; cause: AnchorResetCause; state }
 *   - function ingestObservation(previous: ObservationTailState|null, incoming: PhaseObservation,
 *       sessionGeneration: number): ObservationIngestOutcome        // T057 锚语义共享纯函数
 *   - type FinishReason = 'completed'|'stale_final'|'no_tail_observation'|'not_started'|
 *       'no_duration'|'not_completed'|'stopped_elsewhere'           // api.md 七值全集;
 *       // 本规则面产出前五值;not_completed 仅经 resolveFinishInvocation;
 *       // stopped_elsewhere 属多上下文/他处终态形态,由 T058 实现层产出,本面不产出
 *   - interface TailEligibilityInput { sessionGeneration; durationSeconds: number|null;
 *       finalPositionSeconds; finishedAtMs; samples: readonly PhaseObservation[] }
 *   - interface TailEligibilityOutcome { sessionCompleted: boolean; autoNextEligible: boolean;
 *       reason: 'completed'|'no_tail_observation';
 *       tailStreakSamples: readonly PhaseObservation[] }            // 仅 completed 时非空
 *   - function evaluateTailEligibility(input): TailEligibilityOutcome
 *   - type FinishEvaluation = { kind:'evaluated'; finalSessionAccepted; sessionCompleted;
 *       autoNextEligible; reason: FinishReason; tailStreakSamples } |
 *       { kind:'hard_invalid'; field:'final_position' }             // 硬非法→400 整次回滚,无 receipt
 *   - interface FinishEvaluationInput { sessionStarted; sessionGeneration; durationSeconds;
 *       finalPositionSeconds; finalSampleSeq; latestAcceptedSampleSeq; finishedAtMs;
 *       samples: readonly PhaseObservation[] }
 *   - function evaluateFinish(input): FinishEvaluation              // 判定序编排,见下
 *   - type FinishInvocationOutcome = { kind:'evaluate' } | { kind:'replay' } |
 *       { kind:'not_completed'; receiptReason:'not_completed' } | { kind:'already_recorded' }
 *   - function resolveFinishInvocation(input: { hasExistingReceipt; sameOperationKey;
 *       stopWonFirst }): FinishInvocationOutcome                    // T054 receipt 调用面
 *   - const FINISH_REASONS_BLOCKING_MANUAL_NEXT: readonly FinishReason[]    // 恒 [](B 组)
 *
 * evaluateFinish 判定序(逐字钉死,首条命中即返回;「final 位置先验证接受,再判尾段」):
 *   1. ¬sessionStarted → { evaluated, accepted:false, completed:false, autoNext:false,
 *      'not_started', streak:[] }(无 started 无从谈 final);
 *   2. finalSampleSeq < latestAcceptedSampleSeq → { …, accepted:false, 'stale_final' }
 *      (stale final 可 ended 但不可 auto-next;ended 由 receipt 层表达);
 *   3. finalPositionSeconds 无限/负/(duration 已知且 > duration)→ { kind:'hard_invalid',
 *      field:'final_position' }(api.md「硬非法…整次回滚」,不产生 receipt);
 *   4. durationSeconds == null → { accepted:true, completed:false, autoNext:false,
 *      'no_duration', streak:[] }(无证据不等于接口失败,可 ended=true);
 *   5. 委托 evaluateTailEligibility(尾段/末段判定)。
 *
 * 连续末段(streak)算法(T057 ingest 与 T058 evaluate 必须一致,E5 互检):
 *   - 逐条消费按序 flush 的样本;generation ≠ sessionGeneration 的样本整体忽略(不计入、不重置);
 *   - 'playing':streak 空则开创;否则与 streak 末条比对:interval=(接收差)/1000 秒,
 *     interval > 3 → anchor_reset('gap_over_3s')并以当前样本开创新 streak;
 *     advance=位置差,<0 或 > interval×本样本rate+0.5 → anchor_reset('unknown_jump')并以当前样本
 *     开创新 streak(推进超界=「拒」入链,非硬拒绝——资格保守 unknown);
 *     否则延伸;'seeking'|'pause'|'waiting'(缓冲)|'error'|'seeked' → 清空 streak(锚重置);
 *     'ratechange' → 透传不重置(推进界按相邻两 playing 样本的接收差与后者 rate 计算);
 *   - final 链接:streak 非空时以 finishedAtMs−末条接收时刻为 interval、finalPosition−末条位置为
 *     advance 执行同一连续性检查(0 ≤ interval ≤ 3、0 ≤ advance ≤ interval×rate+0.5);
 *   - 裁决:windowOK=(duration−finalPosition) ≤ tailFinalWindow(duration)(恰界允许);
 *     streakOK=streak 非空 ∧ final 链接成立 ∧ (finalPosition−streak[0].position) ≥
 *     tailStreak(duration)(恰界允许);两者皆立 → completed(autoNext true),否则
 *     no_tail_observation(completed=false, autoNext=false)。「周期样本距尾 8s」的对照只作用于
 *     final 落窗(D 组)——不要求历史周期样本进过尾窗(FR-023);「不声称用户看完整集」:
 *     completed 是会话观测结果,seek 后的新合格末段同样成立(playback-state §4)。
 *
 * resolveFinishInvocation(T054 receipt 调用面;session_id 唯一/终态不得升级的纯形态):
 *   1. 已有 receipt ∧ 同 operationKey → replay(重放仅返回既有结果,不刷新末段证据/不改 final);
 *   2. 已有 receipt ∧ 异 operationKey → already_recorded(→409 FINISH_ALREADY_RECORDED);
 *   3. 无 receipt ∧ stopWonFirst → not_completed(首次 finish 只登记 receipt
 *      reason='not_completed',不写 final,不能给 ended 任意升级资格);
 *   4. 其余 → evaluate(进入 evaluateFinish 正常路径)。
 *
 * 用例↔契约映射:基线=常量/窗口公式锁面;A 倍速(0.5–2 闭区间+推进界+FR-024 墙钟不误杀);
 * B 短片(min 公式 30s→1.5s、12s→0.6s;末段太短→拒 auto-next 允 manual_next);C seek(锚重置+
 * 到尾 seek 无合格尾段→不连播;稍早 seek+新末段→合格);D 距尾 8s(final 落窗对照:8s>5s 窗→
 * 非尾段;落入→eligible);E 断网(gap>3s unknown→不连播;恢复后新连续末段);F final 判定序
 * (先验证接受再判尾段;duration 未知→no_duration);G stop 先赢/superseded(receipt 独立值形态)。
 */

/* ------------------------------------------------------------------ */
/* 样本构造(FakeClock 推进生成接收时刻;纯数据,零网络)                   */
/* ------------------------------------------------------------------ */

/** final 在末条观测后的固定提交延迟(1s,处于推进界 1×rate+0.5 之内) */
const FINISH_LAG_MS = 1_000;

function newClock(): FixtureFakeClock {
  return createFixtureFakeClock();
}

interface PlayingRunOptions {
  clock: FixtureFakeClock;
  /** 首条样本位置 = fromPositionSeconds + stepSeconds */
  fromPositionSeconds: number;
  stepSeconds: number;
  intervalMs: number;
  count: number;
  rate?: number;
  generation?: number;
  startSeq?: number;
}

/** 依序产出 playing 观测:每条前推进 intervalMs,接收时刻=clock.nowMs() */
async function runPlaying(options: PlayingRunOptions): Promise<PhaseObservation[]> {
  const rate = options.rate ?? 1;
  const generation = options.generation ?? 1;
  const samples: PhaseObservation[] = [];
  let seq = options.startSeq ?? 1;
  for (let index = 0; index < options.count; index += 1) {
    await options.clock.advanceMs(options.intervalMs);
    samples.push({
      generation,
      eventSeq: seq,
      event: 'playing',
      positionSeconds: options.fromPositionSeconds + options.stepSeconds * (index + 1),
      rate,
      serverReceivedAtMs: options.clock.nowMs(),
    });
    seq += 1;
  }
  return samples;
}

/** 产出单条非 playing(或指定速率)观测 */
async function emitEvent(
  clock: FixtureFakeClock,
  input: {
    seq: number;
    event: PhaseObservationEvent;
    positionSeconds: number;
    rate?: number;
    advanceMs?: number;
    generation?: number;
  },
): Promise<PhaseObservation> {
  await clock.advanceMs(input.advanceMs ?? 250);
  return {
    generation: input.generation ?? 1,
    eventSeq: input.seq,
    event: input.event,
    positionSeconds: input.positionSeconds,
    rate: input.rate ?? 1,
    serverReceivedAtMs: clock.nowMs(),
  };
}

function lastSampleOf(samples: readonly PhaseObservation[]): PhaseObservation {
  const last = samples[samples.length - 1];
  if (last === undefined) {
    throw new Error('样本为空,无法定位末条观测');
  }
  return last;
}

/** 大时长媒体默认形态:3600s、final 落在媒体末尾、final 在末条观测后 1s 提交 */
function evaluateTail(
  samples: readonly PhaseObservation[],
  overrides: Partial<TailEligibilityInput> = {},
): TailEligibilityOutcome {
  return evaluateTailEligibility({
    sessionGeneration: 1,
    durationSeconds: 3600,
    finalPositionSeconds: 3600,
    finishedAtMs: lastSampleOf(samples).serverReceivedAtMs + FINISH_LAG_MS,
    samples,
    ...overrides,
  });
}

function expectCompleted(outcome: TailEligibilityOutcome): void {
  expect(outcome.sessionCompleted).toBe(true);
  expect(outcome.autoNextEligible).toBe(true);
  expect(outcome.reason).toBe('completed');
  expect(outcome.tailStreakSamples.length).toBeGreaterThan(0);
}

function expectNoTail(outcome: TailEligibilityOutcome): void {
  expect(outcome.sessionCompleted).toBe(false);
  expect(outcome.autoNextEligible).toBe(false);
  expect(outcome.reason).toBe('no_tail_observation');
}

/** evaluateFinish 默认输入:started、当前代、3600s、final=3600、seq 不 stale */
function finishInput(
  samples: readonly PhaseObservation[],
  overrides: Partial<FinishEvaluationInput> = {},
): FinishEvaluationInput {
  return {
    sessionStarted: true,
    sessionGeneration: 1,
    durationSeconds: 3600,
    finalPositionSeconds: 3600,
    finalSampleSeq: 10,
    latestAcceptedSampleSeq: 10,
    finishedAtMs: lastSampleOf(samples).serverReceivedAtMs + FINISH_LAG_MS,
    samples,
    ...overrides,
  };
}

/** 完整合格末段:3598/3599/3600 逐秒推进,final=3600(覆盖恰界 2s) */
async function perfectTailSamples(clock: FixtureFakeClock): Promise<PhaseObservation[]> {
  return runPlaying({ clock, fromPositionSeconds: 3597, stepSeconds: 1, intervalMs: 1_000, count: 3 });
}

/* ------------------------------------------------------------------ */
/* 基线:常量与窗口公式锁面                                                */
/* ------------------------------------------------------------------ */

describe('基线:常量与 min(5s,d×5%)/min(2s,d×5%) 公式锁面(data-model §5)', () => {
  it('常量:rate 0.5–2、推进松弛 0.5s、gap 3s、尾窗上限 5s、末段上限 2s、比例 5%', () => {
    expect(OBSERVATION_MIN_RATE).toBe(0.5);
    expect(OBSERVATION_MAX_RATE).toBe(2);
    expect(OBSERVATION_ADVANCE_SLACK_SECONDS).toBe(0.5);
    expect(OBSERVATION_GAP_UNKNOWN_SECONDS).toBe(3);
    expect(TAIL_FINAL_WINDOW_CAP_SECONDS).toBe(5);
    expect(TAIL_STREAK_CAP_SECONDS).toBe(2);
    expect(TAIL_WINDOW_RATIO).toBe(0.05);
  });

  it('窗口/末段公式:12s→0.6/0.6;30s→1.5/1.5;90s→4.5/2;100s→5/2;3600s→5/2(任务文「30s→0.6s」为 12s 媒体的值)', () => {
    expect(tailFinalWindowSeconds(12)).toBeCloseTo(0.6, 10);
    expect(tailStreakSeconds(12)).toBeCloseTo(0.6, 10);
    expect(tailFinalWindowSeconds(30)).toBeCloseTo(1.5, 10);
    expect(tailStreakSeconds(30)).toBeCloseTo(1.5, 10);
    expect(tailFinalWindowSeconds(90)).toBeCloseTo(4.5, 10);
    expect(tailStreakSeconds(90)).toBe(2);
    expect(tailFinalWindowSeconds(100)).toBe(5);
    expect(tailStreakSeconds(100)).toBe(2);
    expect(tailFinalWindowSeconds(3600)).toBe(5);
    expect(tailStreakSeconds(3600)).toBe(2);
  });

  it('推进界 interval×rate+0.5s:(1,1)→1.5、(1,2)→2.5、(2,0.5)→1.5、(3,2)→6.5;FakeClock 起点=夹具固定 now', () => {
    expect(maxPlausibleAdvanceSeconds(1, 1)).toBe(1.5);
    expect(maxPlausibleAdvanceSeconds(1, 2)).toBe(2.5);
    expect(maxPlausibleAdvanceSeconds(2, 0.5)).toBe(1.5);
    expect(maxPlausibleAdvanceSeconds(3, 2)).toBe(6.5);
    expect(createFixtureFakeClock().nowMs()).toBe(FIXTURE_UPSTREAM_FIXED_NOW_MS);
  });
});

/* ------------------------------------------------------------------ */
/* A. 倍速:0.5/1/2 合法;推进>间隔×rate+0.5s 拒;2.5 拒                    */
/* ------------------------------------------------------------------ */

describe('A. 倍速:api.md playbackRate 0.5–2 + 「推进不得大于服务器间隔×rate+0.5s」', () => {
  it('rate 闭区间:0.5/1/2 合法(恰界含);0.49/2.01/2.5 非法', () => {
    expect(isRateAllowed(0.5)).toBe(true);
    expect(isRateAllowed(1)).toBe(true);
    expect(isRateAllowed(2)).toBe(true);
    expect(isRateAllowed(0.49)).toBe(false);
    expect(isRateAllowed(2.01)).toBe(false);
    expect(isRateAllowed(2.5)).toBe(false);
  });

  it('推进恰界延伸、超界重置:间隔 1s/rate 1 下推进 1.5s 连续合格;间隔 0.5s 下推进 1.5s 每步超界 → 末段被毁 → no_tail_observation', async () => {
    const exact = newClock();
    // 间隔 1s(界 1.5s),每步推进恰 1.5s:3595.5→3597→3598.5→3600,final=3600(覆盖 3s)
    const exactSamples = await runPlaying({
      clock: exact, fromPositionSeconds: 3595.5, stepSeconds: 1.5, intervalMs: 1_000, count: 3,
    });
    expectCompleted(evaluateTail(exactSamples));

    const exceeded = newClock();
    // 间隔 0.5s(界 1.0s),每步推进 1.5s:每条 playing 都被当跳跃重置,末段只余末条
    const exceededSamples = await runPlaying({
      clock: exceeded, fromPositionSeconds: 3597, stepSeconds: 1.5, intervalMs: 500, count: 2,
    });
    expectNoTail(evaluateTail(exceededSamples));
  });

  it('ingestObservation:rate 2.5 → rejected rate_out_of_range;跨代样本 → rejected generation_mismatch', async () => {
    const clock = newClock();
    const badRate = await emitEvent(clock, { seq: 1, event: 'playing', positionSeconds: 3598, rate: 2.5 });
    expect(ingestObservation(null, badRate, 1)).toEqual({ kind: 'rejected', cause: 'rate_out_of_range' });
    const foreign = await emitEvent(clock, { seq: 2, event: 'playing', positionSeconds: 3599, generation: 2 });
    expect(ingestObservation(null, foreign, 1)).toEqual({ kind: 'rejected', cause: 'generation_mismatch' });
  });

  it('FR-024 墙钟不误杀:2× 倍速(墙钟减半)与 0.5× 倍速(墙钟加倍)的连续末段均 completed', async () => {
    const fast = newClock();
    const fastSamples = await runPlaying({
      clock: fast, fromPositionSeconds: 3594, stepSeconds: 2, intervalMs: 1_000, count: 3, rate: 2,
    });
    // 每步推进 2s ≤ 1s×2+0.5=2.5(墙钟只有位置时长一半,不因墙钟不足被拒)
    expectCompleted(evaluateTail(fastSamples));

    const slow = newClock();
    const slowSamples = await runPlaying({
      clock: slow, fromPositionSeconds: 3597, stepSeconds: 0.5, intervalMs: 2_000, count: 6, rate: 0.5,
    });
    // 每步推进 0.5s ≤ 2s×0.5+0.5=1.5(墙钟加倍同样不拒)
    expectCompleted(evaluateTail(slowSamples));
  });
});

/* ------------------------------------------------------------------ */
/* B. 短片:30s→尾窗1.5s/末段1.5s;12s→0.6/0.6;末段太短→拒 auto-next      */
/* ------------------------------------------------------------------ */

describe('B. 短片:min 公式在短媒体取 5% 支;「末段太短且无法收集有效观测则拒绝auto-next,允许manual_next」', () => {
  it('30s 媒体:观测 28/29/30 + final 30(覆盖 2s ≥ 末段 1.5s,窗内)→ completed', async () => {
    const clock = newClock();
    const samples = await runPlaying({ clock, fromPositionSeconds: 27, stepSeconds: 1, intervalMs: 1_000, count: 3 });
    expectCompleted(evaluateTail(samples, { durationSeconds: 30, finalPositionSeconds: 30 }));
  });

  it('30s 媒体:仅 1 条尾内观测(29)+ final 30 → 覆盖 1s < 末段 1.5s → no_tail_observation(短尾段收集不足)', async () => {
    const clock = newClock();
    const samples = await runPlaying({ clock, fromPositionSeconds: 28, stepSeconds: 1, intervalMs: 1_000, count: 1 });
    expectNoTail(evaluateTail(samples, { durationSeconds: 30, finalPositionSeconds: 30 }));
  });

  it('12s 媒体(末段=0.6s 形态):观测 11.25/12 → 覆盖 0.75s ≥ 0.6s → completed', async () => {
    const clock = newClock();
    const samples = await runPlaying({ clock, fromPositionSeconds: 10.5, stepSeconds: 0.75, intervalMs: 1_000, count: 2 });
    expectCompleted(evaluateTail(samples, { durationSeconds: 12, finalPositionSeconds: 12 }));
  });

  it('12s 媒体:单条观测 11.75 + final 12 → 覆盖 0.25s < 0.6s → no_tail_observation(末段太短无法收集→拒绝 auto-next)', async () => {
    const clock = newClock();
    const samples = await runPlaying({ clock, fromPositionSeconds: 11.5, stepSeconds: 0.25, intervalMs: 1_000, count: 1 });
    expectNoTail(evaluateTail(samples, { durationSeconds: 12, finalPositionSeconds: 12 }));
  });

  it('manual_next 独立钉面:FINISH_REASONS_BLOCKING_MANUAL_NEXT 恒为空——完成质量的任何拒绝(含 no_tail_observation/no_duration/stale_final)都不阻止手动下一集', () => {
    expect(FINISH_REASONS_BLOCKING_MANUAL_NEXT).toEqual([]);
    const blocking: readonly FinishReason[] = FINISH_REASONS_BLOCKING_MANUAL_NEXT;
    expect(blocking.includes('no_tail_observation')).toBe(false);
    expect(blocking.includes('no_duration')).toBe(false);
    expect(blocking.includes('stale_final')).toBe(false);
  });
});

/* ------------------------------------------------------------------ */
/* C. seek 到尾:seeking/pause/buffering/error/seeked 重置锚 → 新末段      */
/* ------------------------------------------------------------------ */

describe('C. seek 到尾:playback-state §4「到尾seek立即ended没有新的合格尾段→不连播;seek到稍早再连续播放足够尾段可以合格」', () => {
  it('到尾 seek 后立即 ended(seeked 3599.5 → final 3600,无 playing)→ streak 空 → no_tail_observation(不连播)', async () => {
    const clock = newClock();
    const playing = await runPlaying({ clock, fromPositionSeconds: 3595, stepSeconds: 1, intervalMs: 1_000, count: 1 });
    const seeking = await emitEvent(clock, { seq: 2, event: 'seeking', positionSeconds: 3599.5 });
    const seeked = await emitEvent(clock, { seq: 3, event: 'seeked', positionSeconds: 3599.5 });
    expectNoTail(evaluateTail([...playing, seeking, seeked]));
  });

  it('seek 到稍早(3597)再逐秒连续播放 3598/3599/3600 + final → 新末段覆盖 2s → completed(seek 后的新末段同样成立)', async () => {
    const clock = newClock();
    const before = await runPlaying({ clock, fromPositionSeconds: 3595, stepSeconds: 1, intervalMs: 1_000, count: 1 });
    const seeking = await emitEvent(clock, { seq: 2, event: 'seeking', positionSeconds: 3597 });
    const seeked = await emitEvent(clock, { seq: 3, event: 'seeked', positionSeconds: 3597 });
    const after = await runPlaying({ clock, fromPositionSeconds: 3597, stepSeconds: 1, intervalMs: 1_000, count: 3, startSeq: 4 });
    expectCompleted(evaluateTail([...before, seeking, seeked, ...after]));
  });

  it('ingestObservation 锚重置映射:pause→pause、seeking→seeking、waiting→buffering、error→error、seeked→seeked(各自清空 streak);ratechange 透传不重置', async () => {
    const clock = newClock();
    const first = await emitEvent(clock, { seq: 1, event: 'playing', positionSeconds: 3596 });
    const accepted = ingestObservation(null, first, 1);
    expect(accepted.kind).toBe('accepted');
    let state = (accepted as { kind: 'accepted'; state: ObservationTailState }).state;
    expect(state.streak).toEqual([first]);

    // ratechange 不在重置清单(T057):透传接受,streak 原样保留,eventSeq 前移
    const rateChange = await emitEvent(clock, { seq: 2, event: 'ratechange', positionSeconds: 3596.5, rate: 2 });
    const passthrough = ingestObservation(state, rateChange, 1);
    expect(passthrough.kind).toBe('accepted');
    const passthroughState = (passthrough as { kind: 'accepted'; state: ObservationTailState }).state;
    expect(passthroughState.streak).toEqual([first]);
    expect(passthroughState.latestEventSeq).toBe(2);
    state = passthroughState;

    const cases: readonly { event: PhaseObservationEvent; cause: string }[] = [
      { event: 'pause', cause: 'pause' },
      { event: 'seeking', cause: 'seeking' },
      { event: 'waiting', cause: 'buffering' },
      { event: 'error', cause: 'error' },
      { event: 'seeked', cause: 'seeked' },
    ];
    let seq = 3;
    for (const item of cases) {
      const incoming = await emitEvent(clock, { seq, event: item.event, positionSeconds: 3597 });
      const outcome = ingestObservation(state, incoming, 1);
      expect(outcome.kind).toBe('anchor_reset');
      const reset = outcome as { kind: 'anchor_reset'; cause: string; state: ObservationTailState };
      expect(reset.cause).toBe(item.cause);
      expect(reset.state.streak).toEqual([]);
      expect(reset.state.latestEventSeq).toBe(seq);
      state = reset.state;
      seq += 1;
    }
  });
});

/* ------------------------------------------------------------------ */
/* D. 距尾 8s:final 落窗对照(8s>min(5s,5%)=5s → 非尾段;落入→eligible)    */
/* ------------------------------------------------------------------ */

describe('D. 距尾 8s:「最终样本落min(5s,d×5%)」作用于 final(大时长媒体窗=5s);周期样本不要求进过尾窗(FR-023)', () => {
  it('final 距尾 8s(3592/3600):观测完美覆盖末段 2s 也 → no_tail_observation(final 未落尾窗,非尾段)', async () => {
    const clock = newClock();
    const samples = await runPlaying({ clock, fromPositionSeconds: 3589, stepSeconds: 1, intervalMs: 1_000, count: 3 });
    expectNoTail(evaluateTail(samples, { finalPositionSeconds: 3592 }));
  });

  it('final 距尾恰 5s(3595,恰界)+ 末段覆盖恰 2s(3593→3595)→ completed(双恰界允许)', async () => {
    const clock = newClock();
    const samples = await runPlaying({ clock, fromPositionSeconds: 3592, stepSeconds: 1, intervalMs: 1_000, count: 3 });
    expectCompleted(evaluateTail(samples, { finalPositionSeconds: 3595 }));
  });

  it('final 距尾 5.5s(3594.5)→ no_tail_observation;距尾 4s(3596,窗内中部)+ 覆盖 2s → completed(对照)', async () => {
    const clock = newClock();
    const outside = await runPlaying({ clock, fromPositionSeconds: 3592.5, stepSeconds: 1, intervalMs: 1_000, count: 2 });
    expectNoTail(evaluateTail(outside, { finalPositionSeconds: 3594.5 }));

    const inside = newClock();
    const insideSamples = await runPlaying({ clock: inside, fromPositionSeconds: 3593, stepSeconds: 1, intervalMs: 1_000, count: 3 });
    expectCompleted(evaluateTail(insideSamples, { finalPositionSeconds: 3596 }));
  });
});

/* ------------------------------------------------------------------ */
/* E. 断网尾段未知:gap>3s → unknown → 不连播;恢复后新连续末段             */
/* ------------------------------------------------------------------ */

describe('E. 断网:「gap>3s、跳跃/暂停/缓冲使资格unknown,需新的连续末段」(保守)', () => {
  it('断网 5s 打断链,恢复后 3598/3598.5/3599 新连续末段 + final 3600(覆盖 2s)→ completed(恢复后新末段)', async () => {
    const clock = newClock();
    const before = await runPlaying({ clock, fromPositionSeconds: 3595, stepSeconds: 1, intervalMs: 1_000, count: 2 });
    await clock.advanceMs(5_000);
    const recovered = await runPlaying({
      clock, fromPositionSeconds: 3597.5, stepSeconds: 0.5, intervalMs: 1_000, count: 3, startSeq: 3,
    });
    expectCompleted(evaluateTail([...before, ...recovered]));
  });

  it('断网后无新末段直接 final(末观测→final 间隔 6s>3s)→ 链接断 → no_tail_observation(断网尾段未知→不连播)', async () => {
    const clock = newClock();
    const samples = await runPlaying({ clock, fromPositionSeconds: 3596, stepSeconds: 1, intervalMs: 1_000, count: 2 });
    expectNoTail(evaluateTail(samples, {
      finalPositionSeconds: 3597.5,
      finishedAtMs: lastSampleOf(samples).serverReceivedAtMs + 6_000,
    }));
  });

  it('gap 恰 3s 不断链(≤3 连续)→ completed;gap 3.001s 断链且余量不足 → no_tail_observation(恰界)', async () => {
    const exact = newClock();
    const first = await runPlaying({ clock: exact, fromPositionSeconds: 3595, stepSeconds: 1, intervalMs: 1_000, count: 1 });
    const afterGap = await emitEvent(exact, { seq: 2, event: 'playing', positionSeconds: 3597, advanceMs: 3_000 });
    const tail = await runPlaying({ clock: exact, fromPositionSeconds: 3597, stepSeconds: 1.5, intervalMs: 1_000, count: 2, startSeq: 3 });
    // 3596→3597 接收恰隔 3s(≤3 不断链);其后 1.5s 步进(界 1.5 恰界)到 3598.5/3600;覆盖 3600−3596=4 ≥ 2
    expectCompleted(evaluateTail([...first, afterGap, ...tail]));

    const exceeded = newClock();
    const gapSamples = await runPlaying({ clock: exceeded, fromPositionSeconds: 3595, stepSeconds: 1, intervalMs: 1_000, count: 1 });
    const resumed = await emitEvent(exceeded, { seq: 2, event: 'playing', positionSeconds: 3597, advanceMs: 3_001 });
    const final = await emitEvent(exceeded, { seq: 3, event: 'playing', positionSeconds: 3597.5 });
    // 断链后新 streak 仅 [3597],链接到 final 3597.5 → 覆盖 0.5 < 2
    expectNoTail(evaluateTail([...gapSamples, resumed, final], { finalPositionSeconds: 3597.5 }));
  });

  it('ingestObservation:接收间隔 >3s → anchor_reset gap_over_3s,以当前样本开创新 streak', async () => {
    const clock = newClock();
    const first = await emitEvent(clock, { seq: 1, event: 'playing', positionSeconds: 3596 });
    const accepted = ingestObservation(null, first, 1);
    const state = (accepted as { kind: 'accepted'; state: ObservationTailState }).state;
    const late = await emitEvent(clock, { seq: 2, event: 'playing', positionSeconds: 3596.5, advanceMs: 5_000 });
    const outcome = ingestObservation(state, late, 1);
    expect(outcome.kind).toBe('anchor_reset');
    expect((outcome as { kind: 'anchor_reset'; cause: string; state: ObservationTailState }).cause).toBe('gap_over_3s');
    expect((outcome as { kind: 'anchor_reset'; cause: string; state: ObservationTailState }).state.streak).toEqual([late]);
  });

  it('T057/T058 算法一致性:逐条 ingest 的最终 streak ≡ evaluateTailEligibility 判定所用的 tailStreakSamples', async () => {
    const clock = newClock();
    const before = await runPlaying({ clock, fromPositionSeconds: 3595, stepSeconds: 1, intervalMs: 1_000, count: 2 });
    await clock.advanceMs(5_000);
    const recovered = await runPlaying({
      clock, fromPositionSeconds: 3597.5, stepSeconds: 0.5, intervalMs: 1_000, count: 3, startSeq: 3,
    });
    const samples = [...before, ...recovered];

    let state: ObservationTailState | null = null;
    for (const sample of samples) {
      const outcome = ingestObservation(state, sample, 1);
      if (outcome.kind === 'accepted' || outcome.kind === 'anchor_reset') {
        state = outcome.state;
      } else {
        throw new Error(`一致性用例出现意外 ingest 结果:${outcome.kind}`);
      }
    }
    const evaluated = evaluateTail(samples);
    expect(evaluated.reason).toBe('completed');
    expect(state?.streak).toEqual(evaluated.tailStreakSamples);
  });
});

/* ------------------------------------------------------------------ */
/* F. final 判定序:先验证接受(not_started/stale/硬非法),再判尾段          */
/* ------------------------------------------------------------------ */

describe('F. final 判定序:「final位置先被验证接受,再计算尾部…」;「未知duration…完成…不能据此放行」', () => {
  it('not_started:未 started → reason not_started、finalSessionAccepted=false(autoNext=false),其余输入再好也不判尾段', async () => {
    const clock = newClock();
    const samples = await perfectTailSamples(clock);
    expect(evaluateFinish(finishInput(samples, { sessionStarted: false }))).toEqual({
      kind: 'evaluated',
      finalSessionAccepted: false,
      sessionCompleted: false,
      autoNextEligible: false,
      reason: 'not_started',
      tailStreakSamples: [],
    });
  });

  it('stale_final:finalSampleSeq 5 < 最新已接受 9 → accepted=false、autoNext=false(stale final 可 ended 但不可 auto-next)', async () => {
    const clock = newClock();
    const samples = await perfectTailSamples(clock);
    const outcome = evaluateFinish(finishInput(samples, { finalSampleSeq: 5, latestAcceptedSampleSeq: 9 }));
    expect(outcome).toEqual({
      kind: 'evaluated',
      finalSessionAccepted: false,
      sessionCompleted: false,
      autoNextEligible: false,
      reason: 'stale_final',
      tailStreakSamples: [],
    });
  });

  it('硬非法位置 → hard_invalid(final_position):负数、超出已知 duration(3700>3600)、非有限值——400 整次回滚,不产生 receipt', async () => {
    const clock = newClock();
    const samples = await perfectTailSamples(clock);
    expect(evaluateFinish(finishInput(samples, { finalPositionSeconds: -1 }))).toEqual({
      kind: 'hard_invalid',
      field: 'final_position',
    });
    expect(evaluateFinish(finishInput(samples, { finalPositionSeconds: 3700 }))).toEqual({
      kind: 'hard_invalid',
      field: 'final_position',
    });
    expect(evaluateFinish(finishInput(samples, { finalPositionSeconds: Number.POSITIVE_INFINITY }))).toEqual({
      kind: 'hard_invalid',
      field: 'final_position',
    });
  });

  it('duration 未知:null → accepted=true 但 completed=false、autoNext=false、no_duration(无证据≠接口失败,可 ended=true)', async () => {
    const clock = newClock();
    const samples = await perfectTailSamples(clock);
    expect(evaluateFinish(finishInput(samples, { durationSeconds: null }))).toEqual({
      kind: 'evaluated',
      finalSessionAccepted: true,
      sessionCompleted: false,
      autoNextEligible: false,
      reason: 'no_duration',
      tailStreakSamples: [],
    });
  });

  it('判定序多因命中取先:not_started > stale_final > hard_invalid > no_duration > 尾段', async () => {
    const clock = newClock();
    const samples = await perfectTailSamples(clock);
    // started=false + stale + 非法位置 → not_started(第 1 步)
    expect(
      evaluateFinish(finishInput(samples, {
        sessionStarted: false, finalSampleSeq: 5, latestAcceptedSampleSeq: 9, finalPositionSeconds: -1,
      })),
    ).toMatchObject({ reason: 'not_started' });
    // stale + 非法位置 → stale_final(第 2 步先于硬非法)
    expect(
      evaluateFinish(finishInput(samples, { finalSampleSeq: 5, latestAcceptedSampleSeq: 9, finalPositionSeconds: -1 })),
    ).toMatchObject({ reason: 'stale_final', finalSessionAccepted: false });
    // stale + duration 未知 → stale_final(第 2 步先于 no_duration)
    expect(
      evaluateFinish(finishInput(samples, { finalSampleSeq: 5, latestAcceptedSampleSeq: 9, durationSeconds: null })),
    ).toMatchObject({ reason: 'stale_final' });
    // 合法 final + duration 未知 + 尾段证据再差 → no_duration(第 4 步先于尾段)
    expect(
      evaluateFinish(finishInput(samples, { durationSeconds: null, finalPositionSeconds: 100 })),
    ).toMatchObject({ reason: 'no_duration', finalSessionAccepted: true });
  });
});

/* ------------------------------------------------------------------ */
/* G. stop 先赢:not_completed;superseded 独立完成形态;重放/已登记       */
/* ------------------------------------------------------------------ */

describe('G. finish 调用面:「旧stop先赢则receipt=not_completed」「终态不得由新finish升级;重放仅返回既有结果」', () => {
  it('stop 先赢(首次 finish)→ { not_completed, receiptReason:not_completed };无竞争 → evaluate', () => {
    expect(resolveFinishInvocation({ hasExistingReceipt: false, sameOperationKey: false, stopWonFirst: true })).toEqual({
      kind: 'not_completed',
      receiptReason: 'not_completed',
    });
    expect(resolveFinishInvocation({ hasExistingReceipt: false, sameOperationKey: false, stopWonFirst: false })).toEqual({
      kind: 'evaluate',
    });
  });

  it('已有 receipt:同 operationKey → replay(重放仅返回既有);异 operationKey → already_recorded(409 FINISH_ALREADY_RECORDED)', () => {
    expect(resolveFinishInvocation({ hasExistingReceipt: true, sameOperationKey: true, stopWonFirst: false })).toEqual({
      kind: 'replay',
    });
    expect(resolveFinishInvocation({ hasExistingReceipt: true, sameOperationKey: false, stopWonFirst: false })).toEqual({
      kind: 'already_recorded',
    });
  });

  it('竞争优先序:已有 receipt + 同 key + stop 先赢 → replay(重放优先,终态不得升级);已有 receipt + 异 key + stop 先赢 → already_recorded', () => {
    expect(resolveFinishInvocation({ hasExistingReceipt: true, sameOperationKey: true, stopWonFirst: true })).toEqual({
      kind: 'replay',
    });
    expect(resolveFinishInvocation({ hasExistingReceipt: true, sameOperationKey: false, stopWonFirst: true })).toEqual({
      kind: 'already_recorded',
    });
  });

  it('superseded 独立完成形态:全好输入 → { accepted, completed, autoNext 全 true, completed, 非空末段 };形状无任何 history 字段——historyApplied 是 receipt 组装输入,不经本判定(superseded 可 sessionAccepted/completed 而 historyApplied=false)', async () => {
    const clock = newClock();
    const samples = await perfectTailSamples(clock);
    expect(evaluateFinish(finishInput(samples))).toEqual({
      kind: 'evaluated',
      finalSessionAccepted: true,
      sessionCompleted: true,
      autoNextEligible: true,
      reason: 'completed',
      tailStreakSamples: samples,
    });
  });
});
