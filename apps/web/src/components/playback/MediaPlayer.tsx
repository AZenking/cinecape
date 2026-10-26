/**
 * 播放器 MediaPlayer(T050/T053,US3)——原生 HLS/MSE 完整播放器(渲染外壳)。
 *
 * T053 已将会话状态机(resolve→轮询→renew→心跳→续期调度→交付分派→runId 守卫,
 * 及 seek/selection 的 operationEpoch 竞态守卫)抽取为 usePlaybackSession
 * (./usePlaybackSession,职责与 T048 场景对照详见其文件头);本组件只负责:
 * - 渲染视频本体与准备/终态覆盖层(Props/渲染对 T050/T051/T052 完全兼容;
 *   原生 controls 不启用:进度条为应用影片逻辑时间轴,由 T051 PlaybackControls 提供);
 * - 把 hook 的状态快照经 onStateChange、命令句柄经 onController、播放操作面
 *   (seek/selection/stop/retry)经 onMediaApi 交给父级(T051 控件/T052 详情页消费;
 *   onMediaApi 为 T053 新增可选回调,替代 T052 页面内 seek/selection 过渡接线);
 * - 档案/id 变化销毁仍由页面 key 驱动(MediaPlayer 重挂载即新会话,hook 内 runId
 *   守卫再兜一层;US3-05)。
 */
import { Alert, Spinner } from '@heroui/react';
import { usePlaybackSession } from './usePlaybackSession';
import type { MediaPlayerController, MediaPlayerState, PlaybackMediaApi } from './usePlaybackSession';

/** 播放器可理解状态(UI 视角六态)——定义随 T053 迁移至 usePlaybackSession */
export type { MediaPlayerController, MediaPlayerEngine, MediaPlayerPhase, MediaPlayerState } from './usePlaybackSession';

export interface MediaPlayerProps {
  /** 媒体 id(resolve 入参;变化即销毁旧会话并重新解析——档案切换由父级换 key/mediaId) */
  mediaId: string;
  /** 状态变化回调(phase 迁移与失败原因;不随 timeupdate 高频触发) */
  onStateChange?: (state: MediaPlayerState) => void;
  /** 命令句柄回调:挂载后交出 controller,卸载时交出 null */
  onController?: (controller: MediaPlayerController | null) => void;
  /** 播放操作面回调(T053):挂载后交出 mediaApi(seek/selection/stop/retry),卸载时交出 null */
  onMediaApi?: (mediaApi: PlaybackMediaApi | null) => void;
  /** 追加到容器类名 */
  className?: string;
}

export function MediaPlayer({
  mediaId,
  onStateChange,
  onController,
  onMediaApi,
  className,
}: MediaPlayerProps) {
  const { state, videoRef } = usePlaybackSession(mediaId, {
    onStateChange,
    onController,
    onMediaApi,
  });

  return (
    <div
      className={`relative w-full overflow-hidden rounded-xl bg-black ${className ?? ''}`}
      data-phase={state.phase}
    >
      <video
        ref={videoRef}
        className="block h-full w-full"
        playsInline
        preload="auto"
        // 原生 controls 不启用:进度条为应用影片逻辑时间轴,由 T051 PlaybackControls 提供
        controls={false}
      />
      {state.phase === 'preparing' && (
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 bg-black/80">
          <Spinner size="lg" />
          <p className="text-sm text-white/80">准备中…</p>
        </div>
      )}
      {(state.phase === 'failed' || state.phase === 'ended') && (
        <div className="absolute inset-x-4 bottom-4">
          <Alert status={state.phase === 'failed' ? 'danger' : 'default'}>
            <Alert.Indicator />
            <Alert.Content>
              <Alert.Title>{state.phase === 'failed' ? '播放失败' : '播放已结束'}</Alert.Title>
              <Alert.Description>{state.failureMessage}</Alert.Description>
            </Alert.Content>
          </Alert>
        </div>
      )}
    </div>
  );
}
