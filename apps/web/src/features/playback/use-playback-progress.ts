import { useCallback, useEffect, useRef, useState, type RefObject } from 'react';
import { isFetchApiError, privateFetch } from '../../shared/fetch';

/**
 * 播放进度上报队列(T104,005 api.md §5 progress、research R7、ui/FR-019;语义=T095):
 *
 * - 首次实际 playing 上报 reason=started,并在收到 ACK 前按同一 sampleSeq/payload
 *   重试(指数退避封顶 2 秒);周期/暂停样本在确认前排队,不越过首次样本;
 * - 每 10 秒周期与暂停立即上报;seq 为会话生命周期单调序号(换轨/seek/重渲染不重置);
 * - ACK 前禁用(回弹)用户 seek 与会重建输出的音轨切换(经 canSwitchTracks/canSeek
 *   暴露给播放器层),确认后恢复执行;
 * - 未确认 started 即停止:发送空 stop 并提示未保存(不伪造 final);
 * - 断网:保留最后成功保存值,提示同步失败;网络恢复后以原 seq/payload 重试;
 * - 服务端稳定拒绝(401/403/404/409):终止重试并上报拒绝(不静默丢样本);
 * - 换档/退出:废弃在途请求(AbortController),不向旧身份回写。
 */

/** 上报节拍与重试参数(常量;测试经全局 fetch mock 断言行为) */
const PERIOD_MS = 10_000;
const RETRY_MIN_MS = 500;
const RETRY_MAX_MS = 2_000;

interface QueuedSample {
  readonly sampleSeq: number;
  readonly payload: {
    readonly sampleSeq: number;
    readonly expectedGeneration: number;
    readonly positionSeconds: number;
    readonly reason: 'started' | 'periodic' | 'pause';
  };
}

export interface UsePlaybackProgressOptions {
  readonly sessionId: string;
  readonly generation: number;
  readonly videoRef: RefObject<HTMLVideoElement | null>;
  /** 未确认 started 即停止(空 stop)时的用户提示 */
  readonly onUnsavedProgress?: () => void;
  /** 服务端稳定拒绝(授权/会话/冲突)时的终止提示 */
  readonly onRejected?: (message: string) => void;
}

export interface PlaybackProgressApi {
  /** 首次 started 是否已确认(确认前禁用 seek 与重建输出的音轨切换) */
  readonly startedAcked: boolean;
  /** 断网/同步失败(保留最后成功值;恢复后原 seq/payload 重试) */
  readonly syncFailed: boolean;
  /** 用户 seek 是否放行(ACK 前 false) */
  readonly canSeek: boolean;
  /** 音轨切换等重建输出操作是否放行(ACK 前 false) */
  readonly canSwitchTracks: boolean;
  /** 主动停止(携 finalProgress;由播放面关闭路径调用) */
  readonly requestStop: () => void;
}

function readPosition(video: HTMLVideoElement | null, fallback: number): number {
  const value = video?.currentTime;
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : fallback;
}

function isNetworkError(error: unknown): boolean {
  return !(error instanceof DOMException && error.name === 'AbortError') && !isFetchApiError(error);
}

export function usePlaybackProgress(options: UsePlaybackProgressOptions): PlaybackProgressApi {
  const { sessionId, generation, videoRef, onUnsavedProgress, onRejected } = options;
  const [startedAcked, setStartedAcked] = useState(false);
  const [syncFailed, setSyncFailed] = useState(false);

  // 会话内可变状态(seq 单调;换 session/generation 即整体重置)
  const seqRef = useRef(0);
  const inFlightRef = useRef<QueuedSample | null>(null);
  const queueRef = useRef<QueuedSample[]>([]);
  const ackedRef = useRef(false);
  const lastConfirmedRef = useRef(0);
  const lastKnownTimeRef = useRef(0);
  const retryTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const stoppedRef = useRef(false);
  const periodTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // 稳定回调面(父层提示回调/videoRef 经 ref 转发,监听/定时器效果不因重渲染重排:
  // 依赖面只含 sessionId/generation —— videoRef 容器对象每次渲染重建,不得进依赖)
  const unsavedRef = useRef(onUnsavedProgress);
  unsavedRef.current = onUnsavedProgress;
  const rejectedRef = useRef(onRejected);
  rejectedRef.current = onRejected;
  const videoRefRef = useRef(videoRef);
  videoRefRef.current = videoRef;

  /** 推进队列:无在途样本时取队首发送(重试同 seq/payload;确认后按序 flush) */
  const pumpRef = useRef<() => void>(() => undefined);

  useEffect(() => {
    // 会话/代次变化:整体重置(废弃在途请求,不向旧身份回写)
    seqRef.current = 0;
    inFlightRef.current = null;
    queueRef.current = [];
    ackedRef.current = false;
    lastConfirmedRef.current = 0;
    lastKnownTimeRef.current = 0;
    stoppedRef.current = false;
    setStartedAcked(false);
    setSyncFailed(false);
    abortRef.current?.abort();
    abortRef.current = null;
    if (retryTimerRef.current !== null) {
      clearTimeout(retryTimerRef.current);
      retryTimerRef.current = null;
    }

    // 解引用媒体元素(videoRefRef.current = 外层 ref 容器;.current = 元素)
    const video = videoRefRef.current?.current ?? null;
    if (sessionId === '') {
      return;
    }

    let disposed = false;
    let retryAttempts = 0;

    const send = (sample: QueuedSample, attempt: number): void => {
      if (disposed || stoppedRef.current) {
        return;
      }
      const controller = new AbortController();
      abortRef.current = controller;
      void privateFetch<void>(`/playback/sessions/${encodeURIComponent(sessionId)}/progress`, {
        method: 'POST',
        body: sample.payload,
        signal: controller.signal,
      })
        .then(() => {
          if (disposed) {
            return;
          }
          // ACK(2xx,含 applied=false 的 stale/superseded:投递已确认)
          inFlightRef.current = null;
          retryAttempts = 0;
          setSyncFailed(false);
          lastConfirmedRef.current = sample.payload.positionSeconds;
          if (sample.payload.reason === 'started' && !ackedRef.current) {
            ackedRef.current = true;
            setStartedAcked(true);
          }
          pumpRef.current();
        })
        .catch((error: unknown) => {
          if (disposed || controller.signal.aborted) {
            return;
          }
          if (isNetworkError(error)) {
            // 断网:保留最后成功值,原 seq/payload 重试(退避;不推进 seq)
            setSyncFailed(true);
            retryTimerRef.current = setTimeout(() => {
              retryTimerRef.current = null;
              send(sample, attempt + 1);
            }, Math.min(RETRY_MIN_MS * 2 ** attempt, RETRY_MAX_MS));
            return;
          }
          // 服务端稳定拒绝:终止重试,上报稳定提示
          inFlightRef.current = null;
          if (isFetchApiError(error)) {
            rejectedRef.current?.('进度保存已被服务端拒绝,播放将终止。');
          }
        });
    };

    const enqueue = (reason: QueuedSample['payload']['reason'], positionSeconds: number): void => {
      if (stoppedRef.current || disposed) {
        return;
      }
      // 在途重试中的同 seq 同载荷:去重(重试语义由 send 承担)
      const candidate: QueuedSample = {
        sampleSeq: seqRef.current + 1,
        payload: { sampleSeq: seqRef.current + 1, expectedGeneration: generation, positionSeconds, reason },
      };
      if (inFlightRef.current !== null) {
        // 已有在途(重试中):排队,不越过在途样本
        queueRef.current.push(candidate);
        return;
      }
      seqRef.current = candidate.sampleSeq;
      inFlightRef.current = candidate;
      send(candidate, retryAttempts);
    };

    pumpRef.current = () => {
      const next = queueRef.current.shift();
      if (next === undefined || inFlightRef.current !== null) {
        return;
      }
      seqRef.current = Math.max(seqRef.current, next.sampleSeq);
      inFlightRef.current = next;
      send(next, retryAttempts);
    };

    const onPlaying = (): void => {
      lastKnownTimeRef.current = readPosition(video, lastKnownTimeRef.current);
      // 首次实际 playing 上报 started(已确认后的 playing 事件不重复上报)
      if (!ackedRef.current && inFlightRef.current === null && seqRef.current === 0) {
        enqueue('started', lastKnownTimeRef.current);
      }
    };
    const onPause = (): void => {
      lastKnownTimeRef.current = readPosition(video, lastKnownTimeRef.current);
      // 暂停立即上报(未确认时入队,不越过首次样本)
      enqueue('pause', lastKnownTimeRef.current);
    };
    const onSeeking = (): void => {
      if (!ackedRef.current && video !== null) {
        // ACK 前禁用用户 seek:回弹到确认前位置(确认后恢复执行)
        video.currentTime = lastKnownTimeRef.current;
      } else if (video !== null) {
        lastKnownTimeRef.current = video.currentTime;
      }
    };
    const onTimeUpdate = (): void => {
      if (ackedRef.current && video !== null) {
        lastKnownTimeRef.current = video.currentTime;
      }
    };
    video?.addEventListener('playing', onPlaying);
    video?.addEventListener('pause', onPause);
    video?.addEventListener('seeking', onSeeking);
    video?.addEventListener('timeupdate', onTimeUpdate);
    periodTimerRef.current = setInterval(() => {
      // 周期样本:未确认期间入队(确认后按序上报);在途重试中也排队(不越过)
      enqueue('periodic', readPosition(video, lastKnownTimeRef.current));
    }, PERIOD_MS);

    return () => {
      disposed = true;
      video?.removeEventListener('playing', onPlaying);
      video?.removeEventListener('pause', onPause);
      video?.removeEventListener('seeking', onSeeking);
      video?.removeEventListener('timeupdate', onTimeUpdate);
      if (periodTimerRef.current !== null) {
        clearInterval(periodTimerRef.current);
        periodTimerRef.current = null;
      }
      if (retryTimerRef.current !== null) {
        clearTimeout(retryTimerRef.current);
        retryTimerRef.current = null;
      }
      // 卸载即停止:尽力发送(周期保存是主要异常恢复保障)
      stoppedRef.current = true;
      abortRef.current?.abort();
      if (sessionId !== '') {
        const acked = ackedRef.current;
        const position = readPosition(videoRefRef.current.current, lastConfirmedRef.current);
        if (acked) {
          const finalSeq = seqRef.current + 1;
          void privateFetch<void>(`/playback/sessions/${encodeURIComponent(sessionId)}/stop`, {
            method: 'POST',
            body: {
              finalProgress: {
                sampleSeq: finalSeq,
                expectedGeneration: generation,
                positionSeconds: Math.max(position, 0),
              },
            },
            // 卸载路径尽力送达;失败不阻塞关闭(服务端身份变化/失联扫描兜底终态化)
          }).catch(() => undefined);
        } else {
          // 未确认 started 即停止:空 stop + 提示未保存(不伪造 final)
          void privateFetch<void>(`/playback/sessions/${encodeURIComponent(sessionId)}/stop`, {
            method: 'POST',
            body: {},
          })
            .then(() => unsavedRef.current?.())
            .catch(() => unsavedRef.current?.());
        }
      }
    };
    // sessionId/generation 变化 = 会话身份变化:整段重置(含 stop flush)
  }, [sessionId, generation]);

  /** 主动停止(播放面关闭路径):同步停止周期链并由卸载清理承担 final;此处仅标记 */
  const requestStop = useCallback((): void => {
    stoppedRef.current = true;
  }, []);

  return {
    startedAcked,
    syncFailed,
    canSeek: startedAcked,
    canSwitchTracks: startedAcked,
    requestStop,
  };
}
