import { useCallback, useEffect, useRef, useState, type RefObject } from 'react';
import type { Vod } from '@hmp/shared';
import { FetchApiError, isAbortError, privateFetch } from '../../shared/fetch';
import type { FinishReceiptDto } from './progress-controller';

/**
 * 连播(自动下一集)意图 hook(010 T064;api.md §5/§7 I3、ui.md §3/§6):
 *
 * - 触发唯一入口=FinishReceipt.autoNextEligible(经 ProgressController finish 队列
 *   上报的回执;A2/G2:资格只看 receipt 布尔独立值,false 一律不倒计时);
 * - 偏好门(Profile 键):GET /me/vod/preferences,autoplayNext=false 终止连播
 *   (finish 的 final 保存不受影响,B4;消费时服务端仍会重验);
 * - 倒计时开始前取计划(api.md §7 I3):POST /playback/next-plans(action='next',
 *   同一快照绑定目标/修订/历史)—— 计划未决不出倒计时(A3);目标有未完成历史
 *   (historyChoiceRequired)暂停倒计时等待显式选择(C1/C1b;选择即 positionMode);
 * - 5s 倒计时(ui.md §3)到期自动建意图:POST /playback/transition-intents
 *   (SequentialNextIntentRequest:action='next'/positionMode=beginning/
 *   expectedSlotRevision=0/operationKey UUID,C2 钉面);
 * - 目标变化重新确认(审查补充;ui.md §6):意图撞 409 NEXT_PLAN_CHANGED /
 *   410 NEXT_PLAN_EXPIRED → 重新取计划并重新展示(requireExplicitConfirm=true,
 *   仅显式确认推进,先前到期选择不自动套到新目标,F1/F2);
 * - 取消/切档/卸载清理:cancel 终态(倒计时收口、零 intent、后续 receipt 忽略,
 *   E1);sessionId 变化/卸载取消定时器与在途请求(切档旧会话零意图,B2/B3);
 *   计划快照绑定属主会话(T080 收口):旧计划不随新身份建意图 —— 到期回调/
 *   显式动作凭 planSession 守卫拒绝跨身份意图(渲染已提交、清理未及的窗口内
 *   亦不发出载荷身份错配的请求);
 * - 本 hook 不实现 UI:仅暴露状态面(phase/plan/countdownDeadline/…)与动作回调
 *   (cancel/confirmImmediate/choosePosition),倒计时容器、历史询问与手势面归
 *   T065(ui.md §3 键盘可达面)。
 */

type NextPlanReplyDto = Vod.components['schemas']['NextPlanReply'];
type IntentReplyDto = Vod.components['schemas']['IntentReply'];

/** 目标位置模式(SequentialNextIntentRequest.positionMode 的 next 分支枚举) */
export type VodAutoplayPositionMode = 'beginning' | 'target_history';

/** 倒计时长度(ui.md §3:仅 autoNextEligible 才倒计时 5s) */
const COUNTDOWN_MS = 5_000;

/** hook 状态机(T065 UI 面的稳定契约;未实现 UI 前 player-view 以最小面透传) */
export type VodAutoplayPhase =
  /** 无资格 receipt(未触发/资格否决) */
  | 'idle'
  /** 偏好门/计划请求进行中(倒计时开始前取计划;计划未决不出倒计时,A3) */
  | 'preparing'
  /** 计划就绪:自动模式 5s 倒计时;requireExplicitConfirm=true 时仅显式确认推进 */
  | 'countdown'
  /** 目标有未完成历史:倒计时暂停,等待 choosePosition 显式选择(C1/C1b) */
  | 'awaiting_history_choice'
  /** 意图已建立(IntentReply;T065 后继会话消费入口) */
  | 'intent_created'
  /** 用户取消(终态;后续 receipt 忽略,E1) */
  | 'cancelled'
  /** 连播终止(偏好关/无下一集/错误;终态,不悬挂不误杀,G2) */
  | 'stopped';

export interface VodAutoplayState {
  readonly phase: VodAutoplayPhase;
  /** 资格事实(收到的 FinishReceipt;null=尚无) */
  readonly receipt: FinishReceiptDto | null;
  /** 服务端计划快照(I3 倒计时开始前取得;展示绑定目标用 plan.label) */
  readonly plan: NextPlanReplyDto | null;
  /** 倒计时截止(epoch ms);null=无自动推进(awaiting_history_choice/显式确认面) */
  readonly countdownDeadline: number | null;
  /** 409/410 重新展示:true=仅 confirmImmediate 显式推进,不自动到期(ui.md §6) */
  readonly requireExplicitConfirm: boolean;
  /** 终止原因(phase='stopped' 时非 null) */
  readonly stopReason: 'preference_off' | 'no_next_plan' | 'error' | null;
  /** 已建立意图(成功回复;状态面供 T065 后继解析) */
  readonly intent: IntentReplyDto | null;
}

export interface UseVodAutoplayOptions {
  readonly sessionId: string;
  readonly generation: number;
  /** 当前媒体元素(保留接缝;T065 手势面/后继会话起播复用) */
  readonly videoRef: RefObject<HTMLVideoElement | null>;
}

export interface VodAutoplayApi {
  /** 状态面(T065 UI 渲染契约;见 VodAutoplayState) */
  readonly state: VodAutoplayState;
  /** finish 回执入口(PlayerView 从 usePlaybackProgress.onFinishReceipt 一行接出) */
  readonly onReceipt: (receipt: FinishReceiptDto) => void;
  /** 取消连播(终态:倒计时收口、零 intent、后续 receipt 忽略;ui.md §3 可键盘操作面归 T065) */
  readonly cancel: () => void;
  /** 立即下一集(消费当前计划;requireExplicitConfirm 重新展示后同样适用,F1/F2) */
  readonly confirmImmediate: () => void;
  /** 目标历史询问的显式位置选择(选择即 positionMode;T065 询问 UI 调用,C1/C1b) */
  readonly choosePosition: (mode: VodAutoplayPositionMode) => void;
}

const IDLE_STATE: VodAutoplayState = {
  phase: 'idle',
  receipt: null,
  plan: null,
  countdownDeadline: null,
  requireExplicitConfirm: false,
  stopReason: null,
  intent: null,
};

/** 请求一次性 operationKey(UUID;api.md §5 IntentRequest) */
function newOperationKey(): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) {
    return crypto.randomUUID();
  }
  return `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

export function useVodAutoplay(options: UseVodAutoplayOptions): VodAutoplayApi {
  const { sessionId } = options;
  const [state, setState] = useState<VodAutoplayState>(IDLE_STATE);

  // 异步延续面:sessionId/generation/状态以 ref 取当前值(回调身份稳定,重渲染不重排)
  const sessionIdRef = useRef(sessionId);
  sessionIdRef.current = sessionId;
  const generationRef = useRef(options.generation);
  generationRef.current = options.generation;
  const stateRef = useRef(state);
  stateRef.current = state;
  /** 取消终态(E1:取消后再次 ended/重放回执不重建倒计时) */
  const cancelledRef = useRef(false);
  /** 已消费回执(重复回执幂等;receipt 不可变) */
  const receiptRef = useRef<FinishReceiptDto | null>(null);
  /** 当前计划快照(I3 同一快照:倒计时展示/意图提交共用) */
  const planRef = useRef<NextPlanReplyDto | null>(null);
  /**
   * 计划快照属主会话(T080 收口:计划与意图同身份守卫)。切档后旧计划不得作为
   * 新身份意图的载荷 —— 身份变化到 effect 清理收口之间存在渲染已提交、清理未及
   * 的窗口,倒计时到期回调凭本守卫拒绝跨身份建意图(不发出载荷身份错配的请求)。
   */
  const planSessionRef = useRef<string | null>(null);
  /** 在途偏好/计划/意图请求(切档/卸载取消) */
  const abortRef = useRef<AbortController | null>(null);
  /** 自动到期定时器 */
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const clearCountdownTimer = useCallback((): void => {
    if (timerRef.current !== null) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  }, []);

  // 会话身份变化/卸载清理(B2/B3):倒计时定时器与在途请求全部收口,零 intent;
  // 新会话状态面重置(旧会话 receipt/计划不跨身份存活)
  useEffect(() => {
    cancelledRef.current = false;
    receiptRef.current = null;
    planRef.current = null;
    planSessionRef.current = null;
    setState(IDLE_STATE);
    return () => {
      clearCountdownTimer();
      abortRef.current?.abort();
      abortRef.current = null;
    };
  }, [sessionId, clearCountdownTimer]);

  /** 建意图(不可变载荷;一次性 UUID operationKey):成功/409·410 重展示/其余终止 */
  const buildIntent = useCallback(
    async (positionMode: VodAutoplayPositionMode): Promise<void> => {
      const plan = planRef.current;
      if (
        plan === null ||
        planSessionRef.current !== sessionIdRef.current || // 旧计划不随新身份建意图(T080 收口)
        stateRef.current.phase === 'cancelled' ||
        stateRef.current.phase === 'intent_created'
      ) {
        return;
      }
      const payload = Object.freeze({
        fromSessionId: sessionIdRef.current,
        expectedGeneration: generationRef.current,
        action: 'next' as const,
        nextPlanRef: plan.nextPlanRef,
        positionMode,
        expectedSlotRevision: 0,
        operationKey: newOperationKey(),
      });
      const controller = new AbortController();
      abortRef.current?.abort();
      abortRef.current = controller;
      try {
        const reply = await privateFetch<IntentReplyDto>('/playback/transition-intents', {
          method: 'POST',
          body: payload,
          signal: controller.signal,
        });
        if (controller.signal.aborted) {
          return; // 切档/卸载:在途意图不回写(ui.md §5 身份守卫)
        }
        setState((prev) => ({ ...prev, phase: 'intent_created', intent: reply, countdownDeadline: null }));
      } catch (error) {
        if (isAbortError(error) || controller.signal.aborted) {
          return;
        }
        if (
          error instanceof FetchApiError &&
          (error.code === 'NEXT_PLAN_CHANGED' || error.code === 'NEXT_PLAN_EXPIRED')
        ) {
          // 目标变化重新确认(ui.md §6):重新取计划并重新展示,先前选择不自动套用;
          // requireExplicitConfirm=true → 仅显式确认推进,不静默消费新目标(F1/F2)
          void fetchPlan(true);
          return;
        }
        setState((prev) => ({ ...prev, phase: 'stopped', stopReason: 'error', countdownDeadline: null }));
      }
    },
    // fetchPlan 在下方以函数声明提升,引用稳定
    [],
  );

  /** 取计划(倒计时开始前;I3 同一快照):就绪后按历史形态进入倒计时或询问暂停 */
  async function fetchPlan(requireExplicitConfirm: boolean): Promise<void> {
    // 快照属主身份(T080 收口):计划冻结于发起会话,意图/到期回调据此守卫
    const fetchedForSessionId = sessionIdRef.current;
    setState((prev) => ({ ...prev, phase: 'preparing', plan: null, countdownDeadline: null }));
    const controller = new AbortController();
    abortRef.current?.abort();
    abortRef.current = controller;
    try {
      const plan = await privateFetch<NextPlanReplyDto>('/playback/next-plans', {
        method: 'POST',
        body: { fromSessionId: fetchedForSessionId, expectedGeneration: generationRef.current, action: 'next' },
        signal: controller.signal,
      });
      if (controller.signal.aborted) {
        return;
      }
      planRef.current = plan;
      planSessionRef.current = fetchedForSessionId;
      if (plan.historyChoiceRequired) {
        // 目标有未完成历史:暂停倒计时等待显式选择(ui.md §3;选择即 positionMode)
        setState((prev) => ({ ...prev, phase: 'awaiting_history_choice', plan, countdownDeadline: null }));
        return;
      }
      const deadline = requireExplicitConfirm ? null : Date.now() + COUNTDOWN_MS;
      setState((prev) => ({
        ...prev,
        phase: 'countdown',
        plan,
        requireExplicitConfirm,
        countdownDeadline: deadline,
      }));
      if (timerRef.current !== null) {
        clearTimeout(timerRef.current);
        timerRef.current = null;
      }
      if (!requireExplicitConfirm) {
        // 自动模式:到期建意图(C2);显式确认模式不定时(ui.md §6 不静默消费)
        timerRef.current = setTimeout(() => {
          timerRef.current = null;
          const current = stateRef.current;
          if (current.phase !== 'countdown' || current.requireExplicitConfirm || current.plan === null) {
            return; // 已取消/已建意图/已切显式确认:到期不动作
          }
          void buildIntent('beginning');
        }, COUNTDOWN_MS);
      }
    } catch (error) {
      if (isAbortError(error) || controller.signal.aborted) {
        return;
      }
      // 404 VOD_NEXT_UNAVAILABLE=无确定下一集;其余失败同样终止连播(不悬挂,G2)
      setState((prev) => ({
        ...prev,
        phase: 'stopped',
        stopReason: error instanceof FetchApiError && error.status === 404 ? 'no_next_plan' : 'error',
        countdownDeadline: null,
      }));
    }
  }

  /** finish 回执 → 偏好门 → 取计划(触发唯一入口;幂等/取消终态守卫) */
  const onReceipt = useCallback((receipt: FinishReceiptDto): void => {
    // 重复回执/已取消:E1 幂等(取消后再次 ended 不重建倒计时、不补意图)
    if (cancelledRef.current || receiptRef.current !== null) {
      return;
    }
    receiptRef.current = receipt;
    // 资格只看 receipt 布尔独立值(A2/G2):no_tail_observation/no_duration/…
    // 一律不倒计时、不取计划
    if (receipt.autoNextEligible !== true) {
      setState((prev) => ({ ...prev, receipt }));
      return;
    }
    setState((prev) => ({ ...prev, receipt }));
    // 偏好门(Profile 键):autoplayNext=false 终止(B4;final 保存已由 finish 完成)
    const controller = new AbortController();
    abortRef.current?.abort();
    abortRef.current = controller;
    void privateFetch<Vod.components['schemas']['Preferences']>('/me/vod/preferences', {
      signal: controller.signal,
    })
      .then((preferences) => {
        if (controller.signal.aborted || cancelledRef.current) {
          return;
        }
        if (preferences.autoplayNext !== true) {
          setState((prev) => ({ ...prev, phase: 'stopped', stopReason: 'preference_off' }));
          return;
        }
        void fetchPlan(false);
      })
      .catch((error: unknown) => {
        if (isAbortError(error) || controller.signal.aborted || cancelledRef.current) {
          return;
        }
        // 偏好不可达:保守终止连播(final 保存不受影响)
        setState((prev) => ({ ...prev, phase: 'stopped', stopReason: 'error' }));
      });
  }, []);

  /** 取消连播(终态):倒计时收口、零意图、后续 receipt 忽略 */
  const cancel = useCallback((): void => {
    cancelledRef.current = true;
    clearCountdownTimer();
    setState((prev) => ({ ...prev, phase: 'cancelled', countdownDeadline: null }));
  }, [clearCountdownTimer]);

  /** 立即下一集:跳过剩余倒计时消费当前计划(同计划 ref;后续到点不重复建,A4) */
  const confirmImmediate = useCallback((): void => {
    clearCountdownTimer();
    void buildIntent('beginning');
  }, [buildIntent, clearCountdownTimer]);

  /** 目标历史询问显式选择(选择即 positionMode;不静默覆盖,C1/C1b) */
  const choosePosition = useCallback(
    (mode: VodAutoplayPositionMode): void => {
      if (stateRef.current.phase !== 'awaiting_history_choice') {
        return;
      }
      void buildIntent(mode);
    },
    [buildIntent],
  );

  return { state, onReceipt, cancel, confirmImmediate, choosePosition };
}
