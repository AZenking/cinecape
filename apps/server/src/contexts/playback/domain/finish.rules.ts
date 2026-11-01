/**
 * 010 T054 — 完成判定(尾段/末段)与 finish 调用规则(纯领域,零依赖)。
 *
 * 纯 TS:零依赖、零 import(.dependency-cruiser.cjs R1a 对 domain 层的框架/内建/
 * platform/外部包硬禁令 + audit:purity 符号级门禁;本文件连类型 import 都没有)。
 * 零真实时钟:一切时刻皆入参(FakeClock 只用于测试生成样本时刻);零网络、零持久化。
 * 本文件是 T057(phase-observation.service 的 ingest 锚语义)与 T058(playback-finish.
 * service / lifecycle 原子提交)的共享纯函数面——判定只产出「一组可观测产品条件」,
 * 不做授权、不写 ledger/history、不影响目标授权(data-model §5「观测不是不可伪造
 * 观看证明…completed是会话观测结果,不影响目标授权」)。
 *
 * 来源标注(实现侧不自创语义,契约冻结面):
 * - docs/specs/010-online-vod/data-model.md §5(逐字):
 *   「观测不是不可伪造观看证明:仅作用于产品连播资格。final位置先被验证接受,
 *   再计算尾部min(5s,duration×5%)及末段min(2s,duration×5%)。观测匹配generation、服务端接收时间
 *   和已交付;允许0.5–2倍速,推进不得大于服务器间隔×rate+0.5s;gap>3s、跳跃/暂停/缓冲使资格
 *   unknown,需新的连续末段。finish前flush有序末段观测再提交final。末段太短且无法收集有效观测
 *   则拒绝auto-next,允许manual_next。completed是会话观测结果,不影响目标授权」;
 *   playback_finish_receipt 行:「session_id唯一…旧stop先赢则receipt=not_completed;
 *   终态不得由新finish升级;重放仅返回既有结果」。
 * - docs/specs/010-online-vod/contracts/playback-state.md §4(逐字):
 *   「finish流程:停周期→按序flush尾段观测→分配一次final seq/payload→同事务接受final→更新ledger
 *   →按epoch可选历史→计算sessionCompleted/autoNextEligible→写receipt→ended。保存硬错误回滚,
 *   不部分终态化;stale final可ended但不可auto-next。superseded final可sessionAccepted/completed
 *   而historyApplied=false」;「完成只是一组可观测产品条件:本次started与交付、可信duration、
 *   最终样本落min(5s,d×5%)、尾段min(2s,d×5%)连续推进…观测缺失或gap>3s保守unknown;不要求
 *   上次10s进度已在最后5秒。到尾seek立即ended没有新的合格尾段→不连播;seek到稍早位置再连续播放
 *   足够尾段可以合格,不声称用户看完整集」;「普通stop仍204…stop先赢后finish返回not_completed,
 *   不能给ended任意升级资格」。
 * - docs/specs/010-online-vod/contracts/api.md §1/§4:FinishReceipt.reason 七值
 *   completed|stale_final|no_tail_observation|not_started|no_duration|not_completed|stopped_elsewhere;
 *   finish 行「无证据不等于接口失败,可ended=true/autoNextEligible=false」「已有receipt且新key
 *   不同则409 FINISH_ALREADY_RECORDED」;observations 行「rate 0.5–2、同seq同载荷重放/冲突409/
 *   陈旧false」。
 * - spec.md FR-022(会话级结束结果独立表示)/FR-023(先处理最终样本再判定,不能要求上一次周期
 *   样本已在尾部)/FR-024(跳到尾部、倍速、临近尾部续播、短片、断网补报执行一致的末段连续播放
 *   检查;允许的正常倍速不得仅因墙钟时长不足被拒绝)。
 * - tasks.md T054:receipt「session_id唯一」「终态不得由新finish升级」;T053 先行契约测试
 *   apps/server/test/unit/playback/vod-completion.spec.ts 即行为仲裁面(实现使其全绿为完成定义)。
 *
 * 数值勘误(T053 任务文 vs 公式):任务文「30s 媒体末段 0.6s」按 data-model §5 公式
 * min(2s,d×5%) 应为 1.5s(0.6s 是 12s 媒体的形态);本实现以 data-model 公式为权威,
 * 与测试钉面一致(B 组以 12s 素材覆盖 0.6s 形态)。
 *
 * not_completed vs stopped_elsewhere(T053 报告的契约张力裁决):两契约文案存在张力
 * (data-model §5 receipt 行「旧stop先赢则receipt=not_completed」vs api.md §4「旧stop先赢时
 * 首次finish只登记stopped_elsewhere receipt」)。按 data-model(冻结权威)钉 not_completed
 * 为 stop-先赢产出(resolveFinishInvocation 第 3 步);stopped_elsewhere 保留为 FinishReason
 * 类型值,注明属「多上下文/他处终态」的实现层形态,由 T058 在 receipt 组装层产出,本规则面
 * 不产出该值(见 FinishReason 注)。
 *
 * 导出面即 T053 测试 import 面(逐字):OBSERVATION_MIN_RATE / OBSERVATION_MAX_RATE /
 * OBSERVATION_ADVANCE_SLACK_SECONDS / OBSERVATION_GAP_UNKNOWN_SECONDS /
 * TAIL_FINAL_WINDOW_CAP_SECONDS / TAIL_STREAK_CAP_SECONDS / TAIL_WINDOW_RATIO /
 * tailFinalWindowSeconds / tailStreakSeconds / maxPlausibleAdvanceSeconds / isRateAllowed /
 * PhaseObservationEvent / PhaseObservation / ObservationTailState / AnchorResetCause /
 * ObservationIngestOutcome / ingestObservation / FinishReason / TailEligibilityInput /
 * TailEligibilityOutcome / evaluateTailEligibility / FinishEvaluation /
 * FinishEvaluationInput / evaluateFinish / FinishInvocationOutcome /
 * resolveFinishInvocation / FINISH_REASONS_BLOCKING_MANUAL_NEXT。
 *
 * T057 接线点:phase-observation.service 逐条调用 ingestObservation 落
 * playback_phase_observation(tail_anchor_position/time 随 accepted/anchor_reset 持久化;
 * duplicate/conflict/stale/rejected 不改锚);「payload 不含接收时刻」指同 seq 幂等比较
 * 只比对业务载荷(event/position/rate/generation),serverReceivedAtMs 由服务端写入、
 * 不参与重放比对(api.md「同seq同载荷重放」)。
 *
 * T058 接线点:playback-finish.service 在「同事务接受 final→更新 ledger→按 epoch 可选
 * 历史」后调用 evaluateFinish 得 sessionCompleted/autoNextEligible/reason/tailStreakSamples;
 * 先调 resolveFinishInvocation 决定 evaluate/replay/already_recorded/not_completed 分支;
 * hard_invalid→400 整次回滚不产生 receipt;stale_final 可 ended 但 autoNext=false;
 * historyApplied 是 receipt 组装输入,不经本判定(superseded 可 completed 而 historyApplied=false)。
 */

/* ------------------------------------------------------------------ */
/* 观测常量(data-model §5 / api.md 闭区间,0.5–2 闭区间恰界合法)          */
/* ------------------------------------------------------------------ */

/** 观测允许的最小倍速(api.md playbackRate 0.5–2 闭区间下界) */
export const OBSERVATION_MIN_RATE = 0.5;

/** 观测允许的最大倍速(api.md playbackRate 0.5–2 闭区间上界) */
export const OBSERVATION_MAX_RATE = 2;

/** 推进松弛常数:推进不得大于 服务器间隔×rate+0.5s(data-model §5 逐字 +0.5s) */
export const OBSERVATION_ADVANCE_SLACK_SECONDS = 0.5;

/** gap 未知阈值:相邻观测接收差超过 3 秒 → 资格保守 unknown,需新的连续末段(§5「gap>3s」) */
export const OBSERVATION_GAP_UNKNOWN_SECONDS = 3;

/** 尾窗(最终样本落点)上限:min(5s,d×5%) 的 5s 项(§5「尾部min(5s,duration×5%)」) */
export const TAIL_FINAL_WINDOW_CAP_SECONDS = 5;

/** 末段(连续推进覆盖)上限:min(2s,d×5%) 的 2s 项(§5「末段min(2s,duration×5%)」) */
export const TAIL_STREAK_CAP_SECONDS = 2;

/** 尾窗/末段共同比例项:d×5%(§5;0.05 以常量钉死,禁止调用方自传比例) */
export const TAIL_WINDOW_RATIO = 0.05;

/**
 * 尾窗宽度:min(5s,d×5%)。最终样本(final)必须落在媒体末尾该窗内(恰界允许)。
 * 12s→0.6、30s→1.5(勘误:任务文 0.6s 是 12s 媒体的值)、90s→4.5、≥100s→5。
 * 输入约定:有限正数(存储层保证 duration>0;null 由 evaluateFinish 第 4 步先行截停)。
 */
export function tailFinalWindowSeconds(durationSeconds: number): number {
  return Math.min(TAIL_FINAL_WINDOW_CAP_SECONDS, durationSeconds * TAIL_WINDOW_RATIO);
}

/**
 * 末段宽度:min(2s,d×5%)。连续末段覆盖(finalPosition−streak 首条位置)须 ≥ 该值(恰界允许)。
 * 12s→0.6、30s→1.5、≥40s→2。末段太短且无法收集有效观测 → 拒绝 auto-next,允许
 * manual_next(§5;FINISH_REASONS_BLOCKING_MANUAL_NEXT 恒空与此同源)。
 */
export function tailStreakSeconds(durationSeconds: number): number {
  return Math.min(TAIL_STREAK_CAP_SECONDS, durationSeconds * TAIL_WINDOW_RATIO);
}

/**
 * 可信推进上界:服务器接收间隔×倍速+0.5s(§5「推进不得大于服务器间隔×rate+0.5s」)。
 * rate 取「相邻两样本中后者」的倍速(final 链接取末条已观测倍速,见 evaluateTailEligibility)。
 */
export function maxPlausibleAdvanceSeconds(intervalSeconds: number, rate: number): number {
  return intervalSeconds * rate + OBSERVATION_ADVANCE_SLACK_SECONDS;
}

/** 倍速闭区间判定:0.5 ≤ rate ≤ 2(api.md;恰界 0.5/2 合法,界外一律拒绝) */
export function isRateAllowed(rate: number): boolean {
  return rate >= OBSERVATION_MIN_RATE && rate <= OBSERVATION_MAX_RATE;
}

/* ------------------------------------------------------------------ */
/* 观测值模型与 ingest(T057 共享锚语义)                                  */
/* ------------------------------------------------------------------ */

/** 观测事件类型(api.md observations 行 event 七值;eventSeq 每 generation 独立) */
export type PhaseObservationEvent =
  | 'playing'
  | 'pause'
  | 'seeking'
  | 'seeked'
  | 'waiting'
  | 'ratechange'
  | 'error';

/** 单条相位观测(§5 playback_phase_observation 投影;服务端接收时刻由服务层写入) */
export interface PhaseObservation {
  /** 样本所属会话代(generation 不匹配 → 整条拒绝,不入锚) */
  readonly generation: number;
  /** 观测序号(每 generation 独立、单调;最新 event_seq 幂等) */
  readonly eventSeq: number;
  readonly event: PhaseObservationEvent;
  readonly positionSeconds: number;
  readonly rate: number;
  /** 服务端接收时刻 ms(仅记录;不参与同 seq 重放比对——「payload 不含接收时刻」) */
  readonly serverReceivedAtMs: number;
}

/** 观测尾段状态:当前连续末段锚(playback_phase_observation.tail_anchor_* 的领域形态) */
export interface ObservationTailState {
  readonly generation: number;
  /** 已接受的最大 eventSeq(幂等/冲突/陈旧判定的基准) */
  readonly latestEventSeq: number;
  /** 当前连续 playing 末段(锚重置即清空;ratechange 透传不清空) */
  readonly streak: readonly PhaseObservation[];
}

/** 锚重置原因:显式事件映射 + playing 对的两种连续性破环(§5「seek/pause/buffering/error/未知跳跃」) */
export type AnchorResetCause =
  | 'seeking'
  | 'seeked'
  | 'pause'
  | 'buffering'
  | 'error'
  | 'unknown_jump'
  | 'gap_over_3s';

/** 单条观测 ingest 七态结果(api.md「同seq同载荷重放,冲突409、陈旧false」的领域形态;
 * 六个 kind——rejected 按 cause 分率/代两态,计满七态) */
export type ObservationIngestOutcome =
  /** 接受:延伸既有 streak 或(空链时)开创 */
  | { readonly kind: 'accepted'; readonly state: ObservationTailState }
  /** 同 seq 同业务载荷重放:返回既有结果,状态不变(服务层按幂等回 200) */
  | { readonly kind: 'duplicate' }
  /** 同 seq 异业务载荷:冲突(服务层映射 409,不改状态) */
  | { readonly kind: 'conflict' }
  /** seq 落后于最新已接受:陈旧(服务层按 api.md 回 accepted=false 形态) */
  | { readonly kind: 'stale' }
  /** 结构性拒绝:倍速越界/代不匹配(不入锚、不改状态) */
  | {
      readonly kind: 'rejected';
      readonly cause: 'rate_out_of_range' | 'generation_mismatch';
    }
  /** 锚重置:清空 streak,以当前 playing 样本开创新末段(非 playing 则空链) */
  | {
      readonly kind: 'anchor_reset';
      readonly cause: AnchorResetCause;
      readonly state: ObservationTailState;
    };

/** 显式重置事件 → 锚重置原因映射(§5「seek/pause/buffering/error」+ playback-state §4「seeking立即重置」) */
const RESET_CAUSE_BY_EVENT: Readonly<
  Record<Exclude<PhaseObservationEvent, 'playing' | 'ratechange'>, AnchorResetCause>
> = {
  pause: 'pause',
  seeking: 'seeking',
  seeked: 'seeked',
  waiting: 'buffering',
  error: 'error',
};

/**
 * playing 对连续性检查(共享算法,T057 ingest 与本文件 evaluate 必须一致,E5 互检):
 * - 空链 → 开创(不做间隔/推进检查——重置后的首条样本就是新锚);
 * - interval=(接收差)/1000 秒,interval > 3 → 破环(gap_over_3s);
 * - advance=位置差,advance < 0 或 advance > interval×本样本rate+0.5 → 破环(unknown_jump:
 *   推进超界=「拒」入链而非硬拒绝——资格保守 unknown,§5);
 * - 否则连续,可延伸。
 */
function extendOrResetStreak(
  streak: readonly PhaseObservation[],
  incoming: PhaseObservation,
): { readonly kind: 'extend' } | { readonly kind: 'reset'; readonly cause: AnchorResetCause } {
  const last = streak[streak.length - 1];
  if (last === undefined) {
    return { kind: 'extend' };
  }
  const intervalSeconds = (incoming.serverReceivedAtMs - last.serverReceivedAtMs) / 1000;
  if (intervalSeconds > OBSERVATION_GAP_UNKNOWN_SECONDS) {
    return { kind: 'reset', cause: 'gap_over_3s' };
  }
  const advanceSeconds = incoming.positionSeconds - last.positionSeconds;
  if (
    advanceSeconds < 0 ||
    advanceSeconds > maxPlausibleAdvanceSeconds(intervalSeconds, incoming.rate)
  ) {
    return { kind: 'reset', cause: 'unknown_jump' };
  }
  return { kind: 'extend' };
}

/** 同 seq 重放的业务载荷比对(刻意不含 serverReceivedAtMs——接收时刻由服务端写入) */
function sameObservationPayload(
  recorded: PhaseObservation,
  incoming: PhaseObservation,
): boolean {
  return (
    recorded.generation === incoming.generation &&
    recorded.event === incoming.event &&
    recorded.positionSeconds === incoming.positionSeconds &&
    recorded.rate === incoming.rate
  );
}

/**
 * 单条观测 ingest(T057 phase-observation.service 逐条调用;纯函数,不落库)。
 *
 * 判定序(先身份与合法性,再幂等,再锚语义):
 * 1. generation ≠ sessionGeneration → rejected generation_mismatch(跨代样本不入本代锚);
 * 2. rate 越出 0.5–2 闭区间 → rejected rate_out_of_range(api.md observations 行);
 * 3. seq == latestEventSeq → 同业务载荷 duplicate / 异载荷 conflict(api.md「同seq同载荷
 *    重放,冲突409」;载荷不含接收时刻);
 * 4. seq < latestEventSeq → stale(陈旧,状态不变);
 * 5. playing → extendOrResetStreak:延伸=accepted(streak 追加),破环=anchor_reset
 *    (gap_over_3s / unknown_jump,以本样本开创新 streak);
 * 6. ratechange → accepted 透传不重置(streak 原样保留,seq 前移——推进界按相邻两
 *    playing 样本的接收差与后者 rate 计算,ratechange 自身不入链);
 * 7. pause/seeking/seeked/waiting/error → anchor_reset,cause 按映射表,streak 清空。
 *
 * 调用方(T057)据此落 playback_phase_observation 并同步 tail_anchor_*;本函数零 IO。
 */
export function ingestObservation(
  previous: ObservationTailState | null,
  incoming: PhaseObservation,
  sessionGeneration: number,
): ObservationIngestOutcome {
  if (incoming.generation !== sessionGeneration) {
    return { kind: 'rejected', cause: 'generation_mismatch' };
  }
  if (!isRateAllowed(incoming.rate)) {
    return { kind: 'rejected', cause: 'rate_out_of_range' };
  }
  if (previous !== null) {
    if (incoming.eventSeq === previous.latestEventSeq) {
      const recorded = previous.streak.find((sample) => sample.eventSeq === incoming.eventSeq);
      if (recorded === undefined) {
        /* 锚状态不含该 seq 的样本(末条接受的是 ratechange/重置事件——pinned 状态形态
         * 的 streak 不保留非 playing 样本),纯状态面无法比对载荷:按重放偏置返回
         * duplicate(两种结果都不改状态,锚语义不受影响);同 seq 冲突(409)的权威
         * 判定在 T057 的持久 digest(playback_phase_observation.digest 列)——服务层
         * 先查 digest 再调用本函数,不得以本函数为冲突唯一裁决 */
        return { kind: 'duplicate' };
      }
      return sameObservationPayload(recorded, incoming)
        ? { kind: 'duplicate' }
        : { kind: 'conflict' };
    }
    if (incoming.eventSeq < previous.latestEventSeq) {
      return { kind: 'stale' };
    }
  }

  if (incoming.event === 'playing') {
    const step = extendOrResetStreak(previous?.streak ?? [], incoming);
    if (step.kind === 'extend') {
      return {
        kind: 'accepted',
        state: {
          generation: sessionGeneration,
          latestEventSeq: incoming.eventSeq,
          streak: [...(previous?.streak ?? []), incoming],
        },
      };
    }
    return {
      kind: 'anchor_reset',
      cause: step.cause,
      state: {
        generation: sessionGeneration,
        latestEventSeq: incoming.eventSeq,
        streak: [incoming],
      },
    };
  }

  if (incoming.event === 'ratechange') {
    return {
      kind: 'accepted',
      state: {
        generation: sessionGeneration,
        latestEventSeq: incoming.eventSeq,
        streak: previous?.streak ?? [],
      },
    };
  }

  return {
    kind: 'anchor_reset',
    cause: RESET_CAUSE_BY_EVENT[incoming.event],
    state: {
      generation: sessionGeneration,
      latestEventSeq: incoming.eventSeq,
      streak: [],
    },
  };
}

/* ------------------------------------------------------------------ */
/* 尾段/末段判定(evaluateFinish 第 5 步委托面)                            */
/* ------------------------------------------------------------------ */

/** 尾段判定输入:按序 flush 的有序观测 + final 落点(§5「finish前flush有序末段观测再提交final」) */
export interface TailEligibilityInput {
  readonly sessionGeneration: number;
  /** 可信 duration;null 形态由 evaluateFinish 第 4 步先行截停,本面保守判不合格 */
  readonly durationSeconds: number | null;
  readonly finalPositionSeconds: number;
  /** final 提交时刻 ms(服务端接收 final 的时刻;FakeClock 只用于测试生成) */
  readonly finishedAtMs: number;
  /** 按 eventSeq 有序 flush 的观测(同代样本;跨代样本整体忽略:不计入、不重置) */
  readonly samples: readonly PhaseObservation[];
}

/** 尾段判定结果:reason 仅二值(completed|no_tail_observation);streak 仅 completed 时非空 */
export interface TailEligibilityOutcome {
  readonly sessionCompleted: boolean;
  readonly autoNextEligible: boolean;
  readonly reason: 'completed' | 'no_tail_observation';
  readonly tailStreakSamples: readonly PhaseObservation[];
}

/** 不合格统一形态(保守 unknown:completed=false、autoNext=false,streak 不外泄) */
const NO_TAIL_OBSERVATION: TailEligibilityOutcome = {
  sessionCompleted: false,
  autoNextEligible: false,
  reason: 'no_tail_observation',
  tailStreakSamples: [],
};

/**
 * final 链接检查:streak 非空时以「finishedAt−末条接收时刻」为 interval、
 * 「finalPosition−末条位置」为 advance 执行与 playing 对同一的连续性检查
 * (0 ≤ interval ≤ 3、0 ≤ advance ≤ interval×rate+0.5);rate 取末条已观测倍速
 * (final 自身不带 rate,末条观测倍速是服务端最后已知的播放速率事实)。
 */
function finalLinkHolds(
  streak: readonly PhaseObservation[],
  finalPositionSeconds: number,
  finishedAtMs: number,
): boolean {
  const last = streak[streak.length - 1];
  if (last === undefined) {
    return false;
  }
  const intervalSeconds = (finishedAtMs - last.serverReceivedAtMs) / 1000;
  if (intervalSeconds < 0 || intervalSeconds > OBSERVATION_GAP_UNKNOWN_SECONDS) {
    return false;
  }
  const advanceSeconds = finalPositionSeconds - last.positionSeconds;
  return (
    advanceSeconds >= 0 &&
    advanceSeconds <= maxPlausibleAdvanceSeconds(intervalSeconds, last.rate)
  );
}

/**
 * 尾段/末段判定(§5 逐字;evaluateFinish 第 5 步委托面,亦可被 T058 直接复用):
 *
 * 1. 折叠有序样本得当前 streak(与 ingestObservation 共享同一锚算法——generation 不匹配
 *    的样本整体忽略不计入不重置;playing 延伸/破环;非 playing 清空;ratechange 透传);
 * 2. final 链接(finalLinkHolds):「不要求上次10s进度已在最后5秒」(FR-023)——周期样本
 *    不要求进过尾窗,只要求 final 前的末段链在提交时刻仍连续;
 * 3. 裁决:windowOK=(duration−finalPosition) ≤ tailFinalWindow(duration)(恰界允许);
 *    streakOK=streak 非空 ∧ final 链接成立 ∧ (finalPosition−streak[0].position) ≥
 *    tailStreak(duration)(恰界允许);两者皆立 → completed(autoNext=true,返回 streak),
 *    否则 no_tail_observation(completed=false、autoNext=false、streak 置空——末段太短
 *    无法收集有效观测只拒 auto-next,manual_next 不受此判定阻止,§5)。
 *
 * 「不声称用户看完整集」(playback-state §4):completed 是会话观测结果,seek 后的新合格
 * 末段同样成立;到尾 seek 立即 ended(无 playing 新末段)→ streak 空 → 不连播。
 */
export function evaluateTailEligibility(input: TailEligibilityInput): TailEligibilityOutcome {
  /* 与 ingestObservation 同一锚算法的批量折叠(有序 flush 前提下逐条等价,E5 互检) */
  let streak: PhaseObservation[] = [];
  for (const sample of input.samples) {
    if (sample.generation !== input.sessionGeneration) {
      continue;
    }
    if (sample.event === 'playing') {
      const step = extendOrResetStreak(streak, sample);
      streak = step.kind === 'extend' ? [...streak, sample] : [sample];
    } else if (sample.event !== 'ratechange') {
      streak = [];
    }
  }

  const duration = input.durationSeconds;
  if (duration === null) {
    /* 无可信 duration 无法计算窗口/末段:本面不判该形态(evaluateFinish 第 4 步先行
     * 产出 no_duration),直接调用按保守不合格处理 */
    return NO_TAIL_OBSERVATION;
  }

  const first = streak[0];
  if (first === undefined) {
    return NO_TAIL_OBSERVATION;
  }
  const windowOK = duration - input.finalPositionSeconds <= tailFinalWindowSeconds(duration);
  const streakOK =
    finalLinkHolds(streak, input.finalPositionSeconds, input.finishedAtMs) &&
    input.finalPositionSeconds - first.positionSeconds >= tailStreakSeconds(duration);
  if (!windowOK || !streakOK) {
    return NO_TAIL_OBSERVATION;
  }
  return {
    sessionCompleted: true,
    autoNextEligible: true,
    reason: 'completed',
    tailStreakSamples: streak,
  };
}

/* ------------------------------------------------------------------ */
/* finish 判定序(「final位置先被验证接受,再判尾段」)                       */
/* ------------------------------------------------------------------ */

/**
 * FinishReceipt.reason 七值全集(api.md §1)。本规则面产出前五值
 * (not_started/stale_final/no_tail_observation/completed/no_duration);
 * not_completed 仅经 resolveFinishInvocation(receipt 登记形态);
 * stopped_elsewhere 属多上下文/他处终态的实现层形态——T053 裁决按 data-model 钉
 * not_completed 为 stop-先赢产出,本值保留类型位由 T058 receipt 组装层决定是否产出,
 * 本面不产出(见文件头「not_completed vs stopped_elsewhere」裁决注)。
 */
export type FinishReason =
  | 'completed'
  | 'stale_final'
  | 'no_tail_observation'
  | 'not_started'
  | 'no_duration'
  | 'not_completed'
  | 'stopped_elsewhere';

/** finish 判定结果:evaluated=进入正常判定(可能不合格);hard_invalid=400 整次回滚无 receipt */
export type FinishEvaluation =
  | {
      readonly kind: 'evaluated';
      /** final 是否被验证接受(stale_final/not_started → false;硬非法不产生本形态) */
      readonly finalSessionAccepted: boolean;
      readonly sessionCompleted: boolean;
      readonly autoNextEligible: boolean;
      readonly reason: FinishReason;
      readonly tailStreakSamples: readonly PhaseObservation[];
    }
  /** api.md「硬非法…整次回滚」:不产生 receipt,服务层回滚整个 finish 事务并映射 400 */
  | { readonly kind: 'hard_invalid'; readonly field: 'final_position' };

/** finish 判定输入(final 的身份/合法性事实由服务层先按 session/generation 校验) */
export interface FinishEvaluationInput {
  /** 本次会话是否已有效 started(playback-state §4「本次started与交付」) */
  readonly sessionStarted: boolean;
  readonly sessionGeneration: number;
  /** 可信 duration;未知 → no_duration(「无证据不等于接口失败」,可 ended=true) */
  readonly durationSeconds: number | null;
  readonly finalPositionSeconds: number;
  /** final 样本序号(跨 generation 单调的样本 seq,非观测 eventSeq) */
  readonly finalSampleSeq: number;
  /** ledger 最新已接受样本 seq;finalSampleSeq 落后 → stale_final */
  readonly latestAcceptedSampleSeq: number;
  readonly finishedAtMs: number;
  readonly samples: readonly PhaseObservation[];
}

/**
 * finish 判定序(逐字钉死,首条命中即返回;「final位置先被验证接受,再计算尾部…」):
 * 1. ¬sessionStarted → evaluated{accepted:false, 'not_started', streak:[]}(无 started
 *    无从谈 final);
 * 2. finalSampleSeq < latestAcceptedSampleSeq → evaluated{accepted:false,
 *    'stale_final'}(stale final 可 ended 但不可 auto-next,ended 由 receipt 层表达);
 * 3. finalPosition 非有限/负/(duration 已知且 > duration)→ hard_invalid{'final_position'}
 *    (api.md「硬非法…整次回滚」,不产生 receipt;NaN/±∞ 一律非有限);
 * 4. durationSeconds == null → evaluated{accepted:true, completed:false, autoNext:false,
 *    'no_duration', streak:[]}(无证据不等于接口失败,可 ended=true/autoNextEligible=false);
 * 5. 委托 evaluateTailEligibility(尾段/末段判定),accepted 恒 true。
 */
export function evaluateFinish(input: FinishEvaluationInput): FinishEvaluation {
  if (!input.sessionStarted) {
    return {
      kind: 'evaluated',
      finalSessionAccepted: false,
      sessionCompleted: false,
      autoNextEligible: false,
      reason: 'not_started',
      tailStreakSamples: [],
    };
  }
  if (input.finalSampleSeq < input.latestAcceptedSampleSeq) {
    return {
      kind: 'evaluated',
      finalSessionAccepted: false,
      sessionCompleted: false,
      autoNextEligible: false,
      reason: 'stale_final',
      tailStreakSamples: [],
    };
  }
  const positionInvalid =
    !Number.isFinite(input.finalPositionSeconds) ||
    input.finalPositionSeconds < 0 ||
    (input.durationSeconds !== null && input.finalPositionSeconds > input.durationSeconds);
  if (positionInvalid) {
    return { kind: 'hard_invalid', field: 'final_position' };
  }
  if (input.durationSeconds === null) {
    return {
      kind: 'evaluated',
      finalSessionAccepted: true,
      sessionCompleted: false,
      autoNextEligible: false,
      reason: 'no_duration',
      tailStreakSamples: [],
    };
  }
  const tail = evaluateTailEligibility({
    sessionGeneration: input.sessionGeneration,
    durationSeconds: input.durationSeconds,
    finalPositionSeconds: input.finalPositionSeconds,
    finishedAtMs: input.finishedAtMs,
    samples: input.samples,
  });
  return {
    kind: 'evaluated',
    finalSessionAccepted: true,
    sessionCompleted: tail.sessionCompleted,
    autoNextEligible: tail.autoNextEligible,
    reason: tail.reason,
    tailStreakSamples: tail.tailStreakSamples,
  };
}

/* ------------------------------------------------------------------ */
/* finish 调用面(receipt:session_id 唯一 / 终态不得由新 finish 升级)        */
/* ------------------------------------------------------------------ */

/** finish 调用裁决(T054 receipt 调用面;T058 据此分支,本面不落库) */
export type FinishInvocationOutcome =
  /** 正常路径:进入 evaluateFinish 判定 */
  | { readonly kind: 'evaluate' }
  /** 同 operationKey 重放:仅返回既有 receipt,不刷新末段证据/不改 final */
  | { readonly kind: 'replay' }
  /** stop 先赢的首次 finish:只登记 receipt reason='not_completed',不写 final,
   *  不能给 ended 任意升级资格(data-model §5 receipt 行逐字) */
  | { readonly kind: 'not_completed'; readonly receiptReason: 'not_completed' }
  /** 已有 receipt 且新 operationKey 不同:服务层映射 409 FINISH_ALREADY_RECORDED(api.md §4) */
  | { readonly kind: 'already_recorded' };

/** resolveFinishInvocation 输入:receipt 存在性/操作键一致性/stop 竞争事实(服务层查明) */
export interface FinishInvocationInput {
  /** 该 session 是否已存在 finish receipt(session_id 唯一,至多一份不可变结果) */
  readonly hasExistingReceipt: boolean;
  /** 本次 operationKey 与既有 receipt 的 operationKey 是否相同 */
  readonly sameOperationKey: boolean;
  /** 普通 stop 是否已先赢(先赢的 stop 使后到 finish 只登记 not_completed) */
  readonly stopWonFirst: boolean;
}

/**
 * finish 调用裁决序(逐字;「session_id唯一」「终态不得由新finish升级;重放仅返回既有结果」):
 * 1. 已有 receipt ∧ 同 operationKey → replay(重放仅返回既有结果,不刷新末段证据/不改
 *    final——「重试不能刷新末段证据或重新保存不同final」);
 * 2. 已有 receipt ∧ 异 operationKey → already_recorded(→409 FINISH_ALREADY_RECORDED,
 *    附恢复路径而不重算);
 * 3. 无 receipt ∧ stopWonFirst → not_completed(首次 finish 只登记 receipt
 *    reason='not_completed',不写 final,不能给 ended 任意升级资格);
 * 4. 其余 → evaluate(进入 evaluateFinish 正常路径)。
 *
 * T053 裁决:stop-先赢产出钉 not_completed(以 data-model §5 receipt 行为冻结权威);
 * stopped_elsewhere 保留类型值、注明为多上下文/他处终态的实现层形态,本面不产出。
 */
export function resolveFinishInvocation(input: FinishInvocationInput): FinishInvocationOutcome {
  if (input.hasExistingReceipt) {
    return input.sameOperationKey ? { kind: 'replay' } : { kind: 'already_recorded' };
  }
  if (input.stopWonFirst) {
    return { kind: 'not_completed', receiptReason: 'not_completed' };
  }
  return { kind: 'evaluate' };
}

/* ------------------------------------------------------------------ */
/* manual_next 解耦(§5「末段太短…拒绝auto-next,允许manual_next」)          */
/* ------------------------------------------------------------------ */

/**
 * 被完成质量阻止的 manual_next 原因集:恒为空数组。
 * manual_next 是独立用户动作,与完成质量解耦——完成质量的任何拒绝
 * (含 no_tail_observation/no_duration/stale_final/not_started)都不阻止手动下一集
 * (§5「允许manual_next」;manual_next 授权面在 T060 transition.service,不消费本判定)。
 * 冻结为空数组形态:后续任务若需加入原因必须先修订 data-model §5,不得在本面私自扩表。
 */
export const FINISH_REASONS_BLOCKING_MANUAL_NEXT: readonly FinishReason[] = [];
