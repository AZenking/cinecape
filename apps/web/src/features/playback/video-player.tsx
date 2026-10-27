/**
 * video.js 播放器封装(引擎替换:hls.js + 原生控件 → video.js 8 内置 VHS):
 * - 只做引擎层:初始化/换源/销毁与致命错误上抛;票据续期、心跳、进度上报、
 *   续播定位仍由 PlayerView 挂接在底层媒体元素 —— video.js 包装但不替换
 *   React 持有的 <video> 节点,媒体事件(loadedmetadata/playing/pause/
 *   timeupdate)与 currentTime/paused 语义同原生;
 * - HLS 入口(hls_proxy/remux/audio_transcode/video_transcode)由内置
 *   http-streaming 消费(ADR-0009:不新增转码承诺,仅消费受控网关产物);
 *   direct 入口为媒体文件本体,不指定 MIME 交由引擎按扩展名处理;
 * - StrictMode 双挂载:dispose() 会把原 <video> 还原回 DOM,再次初始化安全;
 * - 无媒体实现的环境(jsdom)或初始化失败:保持原生 <video> 兜底(直接设 src),
 *   行为与旧实现一致,单测/无障碍环境不受影响;
 * - data-testid="playback-video" 与既有选择器/语义保持不变。
 */
import { useEffect, useRef, type ReactNode, type RefObject } from 'react';
import videojs from 'video.js';
import type Player from 'video.js/dist/types/player';
import 'video.js/dist/video-js.css';
import './video-player-skin.css';

export interface VideoPlayerProps {
  /** 外层持有的媒体元素 ref(心跳/进度/续播定位读取;video.js 包装同一节点) */
  readonly videoRef: RefObject<HTMLVideoElement | null>;
  /** 播放入口 URL(受控网关产物;随票据续期换装变化) */
  readonly src: string;
  /** null = direct 媒体文件本体(按扩展名);否则为 HLS 清单 MIME */
  readonly mimeType: string | null;
  /** 引擎致命错误(流中断等)的稳定终止回调 */
  readonly onFatalError: () => void;
}

/** 引擎初始化选项(fill 模式铺满容器;控制条由引擎提供) */
const ENGINE_OPTIONS = { controls: true, preload: 'auto', fill: true } as const;

export function VideoPlayer({ videoRef, src, mimeType, onFatalError }: VideoPlayerProps): ReactNode {
  const playerRef = useRef<Player | null>(null);
  // 稳定回调面:错误回调经 ref 转发,监听效果不因父层重渲染重排
  const fatalErrorRef = useRef(onFatalError);
  fatalErrorRef.current = onFatalError;

  // 1. 引擎生命周期(挂载初始化/卸载销毁;StrictMode 双挂载安全)
  useEffect(() => {
    const el = videoRef.current;
    if (el === null) {
      return;
    }
    let player: Player;
    try {
      player = videojs(el, ENGINE_OPTIONS);
    } catch {
      return; // jsdom 等无媒体实现:保持原生 <video> 兜底
    }
    playerRef.current = player;
    // 品牌皮肤类(video-player-skin.css 作用域;全 token 派生,无硬编码色值)
    player.addClass('hmp-player');
    player.on('error', () => {
      fatalErrorRef.current();
    });
    return () => {
      playerRef.current = null;
      try {
        player.dispose(); // 还原原 <video> 节点,React 树保持有效
      } catch {
        // 销毁异常不阻塞卸载
      }
    };
  }, [videoRef]);

  // 2. 源安装/换装(src 随票据续期变化;位置保持由 PlayerView 的 restore 回填)
  useEffect(() => {
    if (src === '') {
      return;
    }
    const player = playerRef.current;
    if (player !== null) {
      player.src(mimeType === null ? { src } : { src, type: mimeType });
      // 自动播放被策略拒绝时保持用户手势可控;环境无媒体实现时静默跳过
      const playPromise = player.play();
      if (playPromise !== undefined && typeof playPromise.catch === 'function') {
        playPromise.catch(() => undefined);
      }
      return;
    }
    // 引擎不可用兜底:原生直装(与旧实现同形)
    const el = videoRef.current;
    if (el === null) {
      return;
    }
    el.src = src;
    el.load();
    const nativePlay = typeof el.play === 'function' ? el.play() : undefined;
    if (nativePlay !== undefined && typeof nativePlay.catch === 'function') {
      nativePlay.catch(() => undefined);
    }
  }, [src, mimeType, videoRef]);

  return (
    <div data-vjs-player className="h-full w-full bg-black">
      <video
        ref={videoRef}
        data-testid="playback-video"
        className="video-js h-full w-full"
        playsInline
        aria-label="播放器"
      />
    </div>
  );
}
