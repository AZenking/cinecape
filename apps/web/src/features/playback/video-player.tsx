/**
 * video.js 播放器封装(引擎替换:hls.js + 原生控件 → video.js 8 内置 VHS):
 * - 只做引擎层:初始化/换源/销毁与致命错误上抛;票据续期、心跳、进度上报、
 *   续播定位仍由 PlayerView 挂接在底层媒体元素 —— video.js 包装但不替换
 *   React 持有的 <video> 节点,媒体事件(loadedmetadata/playing/pause/
 *   timeupdate)与 currentTime/paused 语义同原生;
 * - HLS 入口(hls_proxy/remux/audio_transcode/video_transcode)由内置
 *   http-streaming 消费(ADR-0009:不新增转码承诺,仅消费受控网关产物);
 *   direct 入口为媒体文件本体,不指定 MIME 交由引擎按扩展名处理;
 * - StrictMode 双挂载(010 回归修复:双挂载元素归位):video.js 8 对
 *   data-vjs-player 容器走 playerElIngest(React 容器即播放器元素),dispose()
 *   实际会把 <video> 摘离容器、并把被 ingest 的容器整体移出文档 —— cleanup 按
 *   React 容器 ref + isConnected 判定活容器,先元素后容器两步原位归位,
 *   重挂引擎落在文档内元素上(再次初始化安全);
 * - 无媒体实现的环境(jsdom)或初始化失败:保持原生 <video> 兜底(直接设 src),
 *   行为与旧实现一致,单测/无障碍环境不受影响;
 * - data-testid="playback-video" 与既有选择器/语义保持不变;
 * - 手势面接出(010 T065):自动播放策略拒绝(play() NotAllowedError)经
 *   onPlayGestureRequired 回报 PlayerView 呈现 awaitingGesture 面;「点击播放」经
 *   onManualPlayReady 注册的引擎 play() 恢复 —— 只回报事实,不重试、不伪造 started。
 */
import { useCallback, useEffect, useRef, type ReactNode, type RefObject } from 'react';
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
  /** 010 I4(T049):seek 能力不满足(none)时隐藏可用拖动入口;缺省/未知能力保持开启 */
  readonly controlsEnabled?: boolean;
  /** 是否启用引擎(native/video.js)自带控制条。自绘 HeroUI 控制栏时传 false,
   *  底层仍保留媒体元素语义(timeupdate/currentTime/paused 同原生) */
  readonly nativeControls?: boolean;
  /** 010 T065:自动播放策略拒绝(NotAllowedError)回调 —— PlayerView 据此呈现
   *  awaitingGesture 面(ui.md §3;拒绝期零伪造 started/零 playing 观测由泵保证) */
  readonly onPlayGestureRequired?: () => void;
  /** 010 T065:手势恢复入口注册(参数为引擎 play();null=引擎未就绪/已卸载)。
   *  PlayerView 的「点击播放」经此调用引擎 play(),不经第二播放器旁路 */
  readonly onManualPlayReady?: (play: (() => void) | null) => void;
}

/** 引擎初始化选项(fill 模式铺满容器) */
function engineOptions(nativeControls: boolean): { controls: boolean; preload: 'auto'; fill: true } {
  return { controls: nativeControls, preload: 'auto', fill: true };
}

/** 自动播放策略拒绝判定(ui.md §3:NotAllowedError → awaitingGesture,非媒体错误码) */
function isPlayGestureRejection(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as { name?: unknown }).name === 'NotAllowedError';
}

export function VideoPlayer({
  videoRef,
  src,
  mimeType,
  onFatalError,
  controlsEnabled = true,
  nativeControls = true,
  onPlayGestureRequired,
  onManualPlayReady,
}: VideoPlayerProps): ReactNode {
  const playerRef = useRef<Player | null>(null);
  // 010 回归修复(StrictMode 双挂载元素归位):React 渲染层持有的挂载容器 ref。
  // video.js 对 data-vjs-player 容器走 playerElIngest(容器即播放器元素),
  // dispose() 会把容器与其中的 <video> 一并移出文档;归位只信本 ref 与
  // isConnected,不信任 cleanup 时刻的 parentElement(彼时已 detached)。
  const containerRef = useRef<HTMLDivElement | null>(null);
  // 稳定回调面:错误回调经 ref 转发,监听效果不因父层重渲染重排
  const fatalErrorRef = useRef(onFatalError);
  fatalErrorRef.current = onFatalError;
  const gestureRequiredRef = useRef(onPlayGestureRequired);
  gestureRequiredRef.current = onPlayGestureRequired;
  const manualPlayReadyRef = useRef(onManualPlayReady);
  manualPlayReadyRef.current = onManualPlayReady;
  /** 引擎初始化时的控制条意图(挂载即冻结;后续切换由 1b 效果同步) */
  const nativeControlsRef = useRef(nativeControls);
  nativeControlsRef.current = nativeControls;

  /** 引擎 play() 统一入口(src 安装自动起播与手势恢复共用;拒绝只回报事实,不重试) */
  const attemptPlay = useCallback((): void => {
    const report = (error: unknown): void => {
      if (isPlayGestureRejection(error)) {
        gestureRequiredRef.current?.();
      }
    };
    try {
      const player = playerRef.current;
      const playPromise =
        player !== null
          ? player.play()
          : (videoRef.current && typeof videoRef.current.play === 'function' ? videoRef.current.play() : undefined);
      if (playPromise !== undefined && typeof playPromise.catch === 'function') {
        playPromise.then(
          () => undefined, // 起播成功:恢复事实由真实 playing 媒体事件承担(泵观测)
          (error: unknown) => {
            report(error);
          },
        );
      }
    } catch (error) {
      report(error);
    }
  }, [videoRef]);

  // 1. 引擎生命周期(挂载初始化/卸载销毁;StrictMode 双挂载安全)
  useEffect(() => {
    const el = videoRef.current;
    if (el === null) {
      return;
    }
    const container = containerRef.current;
    // React 容器原位锚点(初始化前捕获;cleanup 时刻的 parentNode 已被 dispose
    // 摘除,不可信):归位按原位 insertBefore,保持 React 管辖的兄弟序不变
    const hostParent = container?.parentNode ?? null;
    const hostNext = container?.nextSibling ?? null;
    // 断言面:引擎必须初始化在文档内元素上(归位失效时第一时间显形,不静默降级)
    if (import.meta.env.DEV && !document.contains(el)) {
      console.error('[video-player] 媒体元素不在文档内(StrictMode 归位失效)');
    }
    let player: Player;
    try {
      player = videojs(el, engineOptions(nativeControlsRef.current));
    } catch {
      return; // jsdom 等无媒体实现:保持原生 <video> 兜底
    }
    playerRef.current = player;
    // 010 回归修复:引擎启动定位不得被「ACK 前防漂移回弹」劫持(真浏览器实测:
    // 直播 VHS 起播的 live-edge 定位与进度泵 T079 的 ACK 前 seek 回弹互相夺写
    // currentTime,seeking 事件形成每秒数千次的自持循环,分片加载永久停滞 ——
    // jsdom 不派发媒体事件,单测不可达)。引擎层先于消费方监听位注册守卫:首个
    // playing 观测前(引擎/服务端批准的启动定位期:直播 live-edge、续播 restore,
    // 该期零进度样本、零服务端语义)拦截 seeking 向后续监听传播;首个 playing 后
    // 守卫退位,T079 的「ACK 前禁用用户 seek」防漂移语义照常生效。
    let enginePositioningSettled = false;
    const guardStartupSeeking = (event: Event): void => {
      if (!enginePositioningSettled) {
        event.stopImmediatePropagation();
      }
    };
    const settleEnginePositioning = (): void => {
      enginePositioningSettled = true;
    };
    el.addEventListener('seeking', guardStartupSeeking);
    el.addEventListener('playing', settleEnginePositioning, { once: true });
    // ingest 复制面修复:video.js 初始化会把媒体元素的属性/类名复制到播放器元素
    // (playerElIngest 时 = React 容器)—— data-testid 副本会让测试选择器命中
    // 两个元素(strict 语义击穿);二次初始化(StrictMode 重挂)时 class 副本
    // (vjs-tech)会顶掉 video-js 基类。初始化后统一修复副本面,不触 React 原属性
    // (测试假引擎无 el() 时跳过)。
    const playerEl = typeof player.el === 'function' ? player.el() : null;
    playerEl?.removeAttribute('data-testid');
    playerEl?.classList.add('video-js');
    // 品牌皮肤类(video-player-skin.css 作用域;全 token 派生,无硬编码色值)
    player.addClass('hmp-player');
    player.on('error', () => {
      fatalErrorRef.current();
    });
    return () => {
      // dispose 前快照:真实卸载时 React 已先摘除整棵子树(容器已 disconnected
      // ——此时不归位,避免与 React 争抢 DOM);StrictMode 重挂时容器仍在文档内
      const containerInDocument = container !== null && container.isConnected;
      playerRef.current = null;
      el.removeEventListener('seeking', guardStartupSeeking);
      el.removeEventListener('playing', settleEnginePositioning);
      try {
        player.dispose(); // 销毁引擎包装(会移动 React 管辖节点,见下)
      } catch {
        // 销毁异常不阻塞卸载
      }
      // 010 回归修复:StrictMode 双挂载元素归位 —— video.js 8 dispose 的实际行为
      // 是「tech 清理把 <video> 摘离容器 + Component 清理把被 ingest 的 React 容器
      // 整体移出文档」;T082 §5.2 的「appendChild 回 cleanup 时刻 parentElement」
      // 实为把节点放回 detached 容器,重挂引擎仍跑在文档外(VIDEOJS: WARN: The
      // element supplied is not included in the DOM,currentTime/readyState 恒 0)。
      // 现按 React 管辖结构两步归位:①<video> 放回容器 ref(React 管理的挂载容器,
      // 以 el.parentNode 判定是否需放回);②容器以 isConnected 判定活容器后,按
      // 初始化前捕获的原位锚点放回文档 —— 重挂初始化落在文档内元素上。
      if (container !== null && containerInDocument) {
        try {
          if (el.parentNode !== container) {
            container.appendChild(el); // dispose 后容器已被清空,追加即 React 期望的首位
          }
          if (!container.isConnected && hostParent !== null) {
            if (hostNext !== null && hostNext.parentNode === hostParent) {
              hostParent.insertBefore(container, hostNext);
            } else {
              hostParent.appendChild(container); // 原位锚点已失效:退化为末位放回
            }
          }
        } catch {
          // 归位异常不阻塞卸载/重挂(React 后续 DOM 操作会收敛兄弟序)
        }
      }
    };
  }, [videoRef]);

  // 1a-2. 手势恢复入口注册(T065):PlayerView 经此调用引擎 play();卸载即回收
  useEffect(() => {
    manualPlayReadyRef.current?.(attemptPlay);
    return () => {
      manualPlayReadyRef.current?.(null);
    };
  }, [attemptPlay]);

  // 1b. 拖动入口开关(010 I4:能力不满足不显示;引擎控制条与原生 controls 同步;
  // 测试假引擎无 controls API 时跳过,不影响行为断言)
  useEffect(() => {
    // 自绘控制栏(nativeControls=false)恒关引擎控件;否则按 seek 能力开关
    const wanted = nativeControls === false ? false : controlsEnabled !== false;
    const player = playerRef.current;
    if (player !== null) {
      if (typeof player.controls === 'function') {
        try {
          player.controls(wanted);
        } catch {
          // 引擎开关异常不阻塞播放
        }
      }
      return;
    }
    const el = videoRef.current;
    if (el !== null) {
      el.controls = wanted;
    }
  }, [controlsEnabled, nativeControls, videoRef]);

  // 2. 源安装/换装(src 随票据续期变化;位置保持由 PlayerView 的 restore 回填)
  useEffect(() => {
    if (src === '') {
      return;
    }
    const player = playerRef.current;
    if (player !== null) {
      player.src(mimeType === null ? { src } : { src, type: mimeType });
      // 自动起播与手势恢复共用 attemptPlay:NotAllowedError 回报 awaitingGesture,
      // 其余拒绝保持静默(环境无媒体实现等)
      attemptPlay();
      return;
    }
    // 引擎不可用兜底:原生直装(与旧实现同形)
    const el = videoRef.current;
    if (el === null) {
      return;
    }
    el.src = src;
    el.load();
    attemptPlay();
  }, [src, mimeType, videoRef, attemptPlay]);

  return (
    <div ref={containerRef} data-vjs-player className="h-full w-full bg-black">
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
