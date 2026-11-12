/**
 * 播放器控制栏(自绘;替换 video.js 原生控件)。
 *
 * 设计约束:
 * - 全部控件收拢在**播放器内底部一条**控制栏内(产品要求:不再四角浮动/独立面板),
 *   右侧动作区以 `children` 插槽组合(播放设置/换源/线路/节目单等由宿主传入),
 *   保证「控制栏只管基础播放,业务动作只挂不散」;
 * - 样式全走 HeroUI 语义 token(半透明黑底 + 前景白),不引入裸色值;
 * - 播放/暂停/音量/全屏直接操作 PlayerView 持有的原生 `<video>` 元素(video.js
 *   只做包装,媒体语义同原生),不经过第二套状态机;
 * - 直播(isLive)不呈现进度条,改呈现 LIVE 状态胶囊;点播呈现可拖动进度条;
 *   seek 能力不满足(canSeek=false)时进度条为只读外观(与既有 I4 语义一致);
 * - 控制栏 3 秒无操作自动隐藏(播放中);鼠标移动/键盘聚焦/暂停时保持可见,
 *   触屏与键盘均可操作(React Aria Button/Slider 自带焦点与键盘语义)。
 */
import { useCallback, useEffect, useRef, useState, type ReactNode, type RefObject } from 'react';
import { Button, Slider } from '@heroui/react';
import { Maximize, Minimize2, Pause, Play, Volume2, VolumeX } from 'lucide-react';

export interface PlayerControlsProps {
  /** 媒体元素(video.js 包装的同一节点;播放语义同原生) */
  readonly videoRef: RefObject<HTMLVideoElement | null>;
  /** 全屏宿主容器(默认取媒体元素的父级) */
  readonly containerRef?: RefObject<HTMLDivElement | null>;
  /** 直播流(无时长/无进度条) */
  readonly isLive: boolean;
  /** 是否允许拖动定位(010 I4:能力不满足时进度条只读) */
  readonly canSeek: boolean;
  /** 缩小为右下角 mini 播放器(已最小化时按钮呈还原态) */
  readonly minimized?: boolean;
  readonly onToggleMinimize?: () => void;
  /** 右侧业务动作区(播放设置/换源/线路/节目单) */
  readonly children?: ReactNode;
}

/** 秒 → mm:ss / h:mm:ss(NaN/Infinity 归零,不显示假时长) */
function formatClock(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) {
    return '00:00';
  }
  const total = Math.floor(seconds);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const mm = `${m < 10 ? '0' : ''}${m}`;
  const ss = `${s < 10 ? '0' : ''}${s}`;
  return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}

export function PlayerControls({
  videoRef,
  containerRef,
  isLive,
  canSeek,
  minimized = false,
  onToggleMinimize,
  children,
}: PlayerControlsProps): ReactNode {
  const [playing, setPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [volume, setVolume] = useState(1);
  const [muted, setMuted] = useState(false);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [visible, setVisible] = useState(true);
  /** 拖动进度条期间以本地值显示,松手才写回媒体(避免 timeupdate 抢写) */
  const [scrubValue, setScrubValue] = useState<number | null>(null);
  const hideTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // 媒体事件 → 控件状态(单一事实来源:媒体元素本身)
  useEffect(() => {
    const el = videoRef.current;
    if (el === null) {
      return;
    }
    const syncTime = (): void => {
      if (Number.isFinite(el.currentTime)) {
        setCurrentTime(el.currentTime);
      }
    };
    const syncDuration = (): void => {
      setDuration(Number.isFinite(el.duration) ? el.duration : 0);
    };
    const syncPlay = (): void => {
      setPlaying(!el.paused);
    };
    const syncVolume = (): void => {
      setVolume(Number.isFinite(el.volume) ? el.volume : 1);
      setMuted(el.muted);
    };
    syncTime();
    syncDuration();
    syncPlay();
    syncVolume();
    el.addEventListener('timeupdate', syncTime);
    el.addEventListener('durationchange', syncDuration);
    el.addEventListener('loadedmetadata', syncDuration);
    el.addEventListener('play', syncPlay);
    el.addEventListener('pause', syncPlay);
    el.addEventListener('volumechange', syncVolume);
    return () => {
      el.removeEventListener('timeupdate', syncTime);
      el.removeEventListener('durationchange', syncDuration);
      el.removeEventListener('loadedmetadata', syncDuration);
      el.removeEventListener('play', syncPlay);
      el.removeEventListener('pause', syncPlay);
      el.removeEventListener('volumechange', syncVolume);
    };
  }, [videoRef]);

  // 全屏状态跟随(document 级事实,含 Esc 退出)
  useEffect(() => {
    const onChange = (): void => {
      setIsFullscreen(document.fullscreenElement !== null);
    };
    document.addEventListener('fullscreenchange', onChange);
    return () => {
      document.removeEventListener('fullscreenchange', onChange);
    };
  }, []);

  /** 播放中 3 秒无操作自动隐藏;暂停/菜单聚焦时保持可见 */
  const revealControls = useCallback((): void => {
    setVisible(true);
    if (hideTimerRef.current !== null) {
      clearTimeout(hideTimerRef.current);
    }
    hideTimerRef.current = setTimeout(() => {
      const el = videoRef.current;
      if (el !== null && !el.paused) {
        setVisible(false);
      }
    }, 3000);
  }, [videoRef]);

  useEffect(() => {
    revealControls();
    return () => {
      if (hideTimerRef.current !== null) {
        clearTimeout(hideTimerRef.current);
      }
    };
  }, [revealControls]);

  // 唤出监听挂在**整个播放器容器**上(而非控制栏自身):控制栏隐藏后是
  // pointer-events-none,鼠标移到画面上时事件根本到不了栏内 —— 只挂栏上会导致
  // 「隐藏后再也唤不出来」(实测回归)。移动/点击/触摸/键盘聚焦任一路径都唤出。
  useEffect(() => {
    const host = containerRef?.current ?? videoRef.current?.parentElement ?? null;
    if (host === null) {
      return;
    }
    const onPointer = (): void => {
      revealControls();
    };
    host.addEventListener('pointermove', onPointer);
    host.addEventListener('pointerdown', onPointer);
    host.addEventListener('touchstart', onPointer, { passive: true });
    return () => {
      host.removeEventListener('pointermove', onPointer);
      host.removeEventListener('pointerdown', onPointer);
      host.removeEventListener('touchstart', onPointer);
    };
  }, [containerRef, videoRef, revealControls]);

  const togglePlay = useCallback((): void => {
    const el = videoRef.current;
    if (el === null) {
      return;
    }
    if (el.paused) {
      void el.play().catch(() => undefined);
    } else {
      el.pause();
    }
    revealControls();
  }, [videoRef, revealControls]);

  const toggleMute = useCallback((): void => {
    const el = videoRef.current;
    if (el === null) {
      return;
    }
    el.muted = !el.muted;
  }, [videoRef]);

  const applyVolume = useCallback(
    (next: number): void => {
      const el = videoRef.current;
      if (el === null) {
        return;
      }
      el.volume = Math.min(1, Math.max(0, next));
      if (el.volume > 0 && el.muted) {
        el.muted = false;
      }
    },
    [videoRef],
  );

  const toggleFullscreen = useCallback((): void => {
    if (document.fullscreenElement !== null) {
      void document.exitFullscreen().catch(() => undefined);
      return;
    }
    const host = containerRef?.current ?? videoRef.current?.parentElement ?? null;
    if (host !== null && typeof host.requestFullscreen === 'function') {
      void host.requestFullscreen().catch(() => undefined);
    }
  }, [containerRef, videoRef]);

  const seekTo = useCallback(
    (next: number): void => {
      const el = videoRef.current;
      if (el === null || !Number.isFinite(next)) {
        return;
      }
      el.currentTime = next;
      setCurrentTime(next);
    },
    [videoRef],
  );

  const shownTime = scrubValue ?? currentTime;
  const progressMax = duration > 0 ? duration : 0;

  return (
    <div
      data-testid="player-controls"
      className={`absolute inset-x-0 bottom-0 z-20 flex flex-col gap-1 bg-gradient-to-t from-background/85 via-background/45 to-transparent px-3 pb-2 pt-8 transition-opacity duration-200 ${
        visible ? 'opacity-100' : 'pointer-events-none opacity-0'
      }`}
      onPointerMove={revealControls}
      onPointerEnter={() => {
        // 指针停在控制栏上时不自动隐藏(避免「正要点就消失」)
        if (hideTimerRef.current !== null) {
          clearTimeout(hideTimerRef.current);
        }
        setVisible(true);
      }}
      onPointerLeave={revealControls}
      onFocusCapture={revealControls}
    >
      {/* 进度条(点播):拖动期间本地值,松手写回媒体 */}
      {!isLive && progressMax > 0 ? (
        <Slider
          aria-label="播放进度"
          className="w-full"
          minValue={0}
          maxValue={progressMax}
          step={1}
          value={Math.min(shownTime, progressMax)}
          isDisabled={!canSeek}
          onChange={(next) => {
            const value = typeof next === 'number' ? next : (next[0] ?? 0);
            setScrubValue(value);
          }}
          onChangeEnd={(next) => {
            const value = typeof next === 'number' ? next : (next[0] ?? 0);
            seekTo(value);
            setScrubValue(null);
          }}
        >
          <Slider.Track className="h-1">
            <Slider.Fill />
            <Slider.Thumb />
          </Slider.Track>
        </Slider>
      ) : (
        <div className="h-1" aria-hidden="true" />
      )}

      <div className="flex items-center gap-1.5 text-foreground">
        <Button
          size="sm"
          variant="ghost"
          isIconOnly
          aria-label={playing ? '暂停' : '播放'}
          className="text-foreground data-[hovered=true]:bg-foreground/15"
          onPress={togglePlay}
        >
          {playing ? <Pause className="size-4" aria-hidden="true" /> : <Play className="size-4" aria-hidden="true" />}
        </Button>

        {isLive ? (
          <span className="flex items-center gap-1 rounded-sm bg-danger/90 px-1.5 py-0.5 text-2xs font-semibold text-danger-foreground">
            <span className="size-1.5 rounded-full bg-danger-foreground animate-pulse" aria-hidden="true" />
            直播
          </span>
        ) : (
          <span className="hmp-tabular-nums text-2xs text-foreground/85">
            {formatClock(shownTime)} / {formatClock(progressMax)}
          </span>
        )}

        <div className="mx-auto" />

        {/* 业务动作区(播放设置/换源/线路/节目单),样式由控制栏统一约束 */}
        <div className="flex items-center gap-1 [&_button]:text-foreground">{children}</div>

        {/* 音量 */}
        <div className="group/vol flex items-center gap-1">
          <Button
            size="sm"
            variant="ghost"
            isIconOnly
            aria-label={muted ? '取消静音' : '静音'}
            className="text-foreground data-[hovered=true]:bg-foreground/15"
            onPress={toggleMute}
          >
            {muted || volume === 0 ? <VolumeX className="size-4" aria-hidden="true" /> : <Volume2 className="size-4" aria-hidden="true" />}
          </Button>
          <Slider
            aria-label="音量"
            className="w-16"
            minValue={0}
            maxValue={1}
            step={0.05}
            value={muted ? 0 : volume}
            onChange={(next) => {
              const value = typeof next === 'number' ? next : (next[0] ?? 0);
              applyVolume(value);
            }}
          >
            <Slider.Track className="h-1">
              <Slider.Fill />
              <Slider.Thumb />
            </Slider.Track>
          </Slider>
        </div>

        <Button
          size="sm"
          variant="ghost"
          isIconOnly
          aria-label={isFullscreen ? '退出全屏' : '全屏'}
          className="text-foreground data-[hovered=true]:bg-foreground/15"
          onPress={toggleFullscreen}
        >
          {isFullscreen ? <Minimize2 className="size-4" aria-hidden="true" /> : <Maximize className="size-4" aria-hidden="true" />}
        </Button>

        {/* 最小化:收起为右下角 mini 播放器(宿主实现悬浮与拖动) */}
        {onToggleMinimize !== undefined ? (
          <Button
            size="sm"
            variant="ghost"
            isIconOnly
            aria-label={minimized ? '还原播放器' : '最小化播放器'}
            className="text-foreground data-[hovered=true]:bg-foreground/15"
            onPress={onToggleMinimize}
          >
            {minimized ? <Maximize className="size-4" aria-hidden="true" /> : <Minimize2 className="size-4" aria-hidden="true" />}
          </Button>
        ) : null}
      </div>
    </div>
  );
}