import { useCallback, useEffect, useRef, useState, type RefObject } from 'react';
import {
  ProgressController,
  type AcceptedCheckpoint,
  type FinishReceiptDto,
  type PlaybackSaveOutcome,
} from './progress-controller';

/**
 * 播放进度上报 hook(010 T048;语义承载见 ProgressController):
 *
 * - ProgressController 生命周期=session:hook 仅按 sessionId 建/换控制器并桥接
 *   React 状态面;generation 更新只调用 setPhase(只更新 phase,不重置 seq、
 *   不触发卸载 stop 路径 —— playback-state §7);
 * - 会话/代次身份面:sessionId 变化=身份撤销(T079),旧控制器经统一收口
 *   (revoke=同一 stopOnce 唯一 Promise:abort 在途+立即 /stop,不等待保存),
 *   新控制器 seq 从 1 重新开始;确认/失败/历史应用/保存三态随会话重置;
 * - hook 面:startedAcked/canSeek/canSwitchTracks/syncFailed 语义不变,新增
 *   historyApplied(ProgressReply.applied;superseded → false 供「他设备更新」
 *   提示)、pauseAndFlush/stopOnce(awaitable 命令,ui.md §2)、onFinishReceipt
 *   (T064 自然结束回执接出)、boundedSave/saveOutcome(T079 有界保存原语与
 *   收口三态状态面 —— 保存失败/superseded/仅投递区分,供 UI 提示)。
 */

export type { AcceptedCheckpoint, FinishReceiptDto, PlaybackSaveOutcome } from './progress-controller';

export interface UsePlaybackProgressOptions {
  readonly sessionId: string;
  readonly generation: number;
  readonly videoRef: RefObject<HTMLVideoElement | null>;
  /** 未确认 started 即停止(空 stop)时的用户提示 */
  readonly onUnsavedProgress?: () => void;
  /** 服务端稳定拒绝(授权/会话/冲突)时的终止提示 */
  readonly onRejected?: (message: string) => void;
  /** 自然结束回执到达(唯一 finish 命令决议;连播资格事实唯一入口,T064) */
  readonly onFinishReceipt?: (receipt: FinishReceiptDto) => void;
  /** 保存收口三态变化(T079):有界保存决议/空停投递时发布,供 UI 区分提示 */
  readonly onSaveOutcome?: (outcome: PlaybackSaveOutcome) => void;
}

export interface PlaybackProgressApi {
  /** 首次 started 是否已确认(依据 sessionAccepted+sessionStarted;确认前禁用 seek 与重建输出的音轨切换) */
  readonly startedAcked: boolean;
  /** 断网/同步失败(保留最后成功值;恢复后原 seq/payload 重试) */
  readonly syncFailed: boolean;
  /** 本次会话历史是否已应用(ProgressReply.applied);superseded 时 false ——
   *  「已同步历史」成功提示的唯一依据,绝不以 2xx 充当(ui.md §2) */
  readonly historyApplied: boolean;
  /** 用户 seek 是否放行(ACK 前 false) */
  readonly canSeek: boolean;
  /** 音轨切换等重建输出操作是否放行(ACK 前 false) */
  readonly canSwitchTracks: boolean;
  /** 主动停止(仅标记;final 由 stopOnce/卸载兜底统一发送) */
  readonly requestStop: () => void;
  /** 暂停并按序等待在途/排队样本全部确认,决议为精确接受 checkpoint(ui.md §2/api.md §5) */
  readonly pauseAndFlush: () => Promise<AcceptedCheckpoint>;
  /** 幂等停止:唯一 Promise,重复调用复用同一命令与不可变 final 载荷(ui.md §2) */
  readonly stopOnce: () => Promise<void>;
  /** 有界保存(T079):pauseAndFlush 竞速 ≤1s 超时即放弃,决议非严格 checkpoint;
   *  绝不阻塞身份撤销(stopOnce/revoke 不等待本方法)。永不 reject。 */
  readonly boundedSave: (timeoutMs?: number) => Promise<AcceptedCheckpoint>;
  /** 最近一次保存收口三态(T079 状态面):saved/superseded/failed/delivery-only;
   *  null=尚无收口事实。随会话身份重置。 */
  readonly saveOutcome: PlaybackSaveOutcome | null;
}

/** 控制器缺位(空 sessionId)时的中性 checkpoint(无接受游标) */
const IDLE_CHECKPOINT: AcceptedCheckpoint = {
  sessionAccepted: false,
  acceptedSampleSeq: 0,
  acceptedPositionSeconds: null,
  acceptedGeneration: 0,
};

/** 待发终局收口(T082 StrictMode 双挂载修复;模块级单播放面语义):
 * cleanup 同步 disposeLocal(abort 在途/摘监听/停拍 —— 「旧会话请求立即失效」契约
 * 不变),终局命令(stopOnce 唯一 Promise)挂**微任务**延迟:StrictMode dev 的
 * 同步 unmount→remount 在 setup 内取消之(挂载期空 stop 不再早于首帧击穿会话,
 * e2e 实测时间线:空停先于 VHS 清单请求 → 网关 401 → 播放必中断);真实卸载/
 * 换会话在该微任务照常收口(T079 同一 Promise/载荷零变化)。微任务在同一任务内
 * 冲刷 —— 不用 setTimeout(真实时钟会把收口泄漏进相邻测试的 fetch mock,vitest
 * 全量实测),也不跨任务延迟。 */
let pendingTerminal: { sessionId: string; controller: ProgressController } | null = null;

export function usePlaybackProgress(options: UsePlaybackProgressOptions): PlaybackProgressApi {
  const { sessionId, generation, videoRef, onUnsavedProgress, onRejected, onFinishReceipt, onSaveOutcome } = options;
  const [startedAcked, setStartedAcked] = useState(false);
  const [syncFailed, setSyncFailed] = useState(false);
  const [historyApplied, setHistoryApplied] = useState(true);
  const [saveOutcome, setSaveOutcome] = useState<PlaybackSaveOutcome | null>(null);

  const controllerRef = useRef<ProgressController | null>(null);

  // 稳定回调面(父层提示回调/videoRef 经 ref 转发,控制器生命周期不因重渲染重排:
  // 控制器效果依赖只含 sessionId —— videoRef 容器对象每次渲染重建,不得进依赖)
  const unsavedRef = useRef(onUnsavedProgress);
  unsavedRef.current = onUnsavedProgress;
  const rejectedRef = useRef(onRejected);
  rejectedRef.current = onRejected;
  const finishedRef = useRef(onFinishReceipt);
  finishedRef.current = onFinishReceipt;
  const saveOutcomeCbRef = useRef(onSaveOutcome);
  saveOutcomeCbRef.current = onSaveOutcome;
  const videoRefRef = useRef(videoRef);
  videoRefRef.current = videoRef;
  // phase 上下文(generation 更新只 setPhase;渲染期同步,建控制器时取当前值)
  const generationRef = useRef(generation);
  generationRef.current = generation;

  useEffect(() => {
    // 身份撤销/会话变化(T079):旧控制器统一收口(revoke=同一 stopOnce 唯一
    // Promise:abort 在途+立即 /stop,不等待保存),状态面随会话重置
    setStartedAcked(false);
    setSyncFailed(false);
    setHistoryApplied(true);
    setSaveOutcome(null);
    if (sessionId === '') {
      controllerRef.current = null;
      return;
    }
    // StrictMode dev 双挂载的同步重入:取消上一拍待发的终局命令(挂载期空 stop
    // 不再发生)。旧控制器已 disposeLocal(挂载初态、无样本),径直新建等价安全。
    const pending = pendingTerminal;
    if (pending !== null && pending.sessionId === sessionId) {
      pendingTerminal = null;
    }
    const controller = new ProgressController(sessionId, {
      onStartedAcked: setStartedAcked,
      onSyncFailed: setSyncFailed,
      onHistoryApplied: setHistoryApplied,
      onUnsavedProgress: () => unsavedRef.current?.(),
      onRejected: (message) => rejectedRef.current?.(message),
      onFinishReceipt: (receipt) => finishedRef.current?.(receipt),
      // 三态状态面:hook 内状态 + 调用方回调双通道(T079)
      onSaveOutcome: (outcome) => {
        setSaveOutcome(outcome);
        saveOutcomeCbRef.current?.(outcome);
      },
    });
    controllerRef.current = controller;
    controller.setPhase(generationRef.current);
    controller.attach(videoRefRef.current?.current ?? null);
    return () => {
      if (controllerRef.current === controller) {
        controllerRef.current = null;
      }
      // 卸载/换会话(身份撤销)统一收口(T079):同步本地回收(abort 在途/摘监听/
      // 停拍),终局命令 stopOnce 唯一 Promise 挂微任务 —— 同步 StrictMode remount
      // 由上方 setup 取消;真实卸载/换会话在该微任务照常收口,不等待保存。
      controller.disposeLocal();
      pendingTerminal = { sessionId, controller };
      queueMicrotask(() => {
        if (pendingTerminal !== null && pendingTerminal.controller === controller) {
          pendingTerminal = null;
          controller.collectTerminal();
        }
      });
    };
    // 生命周期=session:generation 变化只经下方效果 setPhase(不发 session stop)
  }, [sessionId]);

  useEffect(() => {
    // generation 更新只更新 phase:不重置 seq、不触发卸载 stop 路径
    controllerRef.current?.setPhase(generation);
  }, [generation]);

  /** 主动停止(播放面关闭路径):仅标记;stop 网络由 stopOnce/卸载兜底统一发送 */
  const requestStop = useCallback((): void => {
    controllerRef.current?.requestStop();
  }, []);

  const pauseAndFlush = useCallback(
    (): Promise<AcceptedCheckpoint> => controllerRef.current?.pauseAndFlush() ?? Promise.resolve(IDLE_CHECKPOINT),
    [],
  );

  const stopOnce = useCallback((): Promise<void> => {
    const controller = controllerRef.current;
    if (controller === null) {
      return Promise.resolve();
    }
    return controller.stopOnce();
  }, []);

  const boundedSave = useCallback(
    (timeoutMs?: number): Promise<AcceptedCheckpoint> =>
      controllerRef.current?.boundedSave(timeoutMs) ??
      Promise.resolve(IDLE_CHECKPOINT),
    [],
  );

  return {
    startedAcked,
    syncFailed,
    historyApplied,
    canSeek: startedAcked,
    canSwitchTracks: startedAcked,
    requestStop,
    pauseAndFlush,
    stopOnce,
    boundedSave,
    saveOutcome,
  };
}
