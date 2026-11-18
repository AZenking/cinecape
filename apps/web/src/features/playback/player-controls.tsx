/**
 * 播放器控制栏(自绘;替换 video.js 原生控件)。
 *
 * 设计约束:
 * - 全部控件收拢在**播放器内底部两行**控制栏内(019 操作台 mock;产品要求:不再
 *   四角浮动/独立面板):
 *   第 1 行 = 时间轴(直播:节目起止时间 + 只读 ProgressBar;点播:当前时间 +
 *   可拖动 Slider + 总时长);第 2 行 = 动作行(左:播放/暂停与音量;中:直播
 *   Chip 或点播播放/暂停;右:业务动作 + 最小化/全屏)。
 *   业务动作区以 `children` 插槽组合(播放设置/换源/线路/节目单等由宿主传入),
 *   保证「控制栏只管基础播放,业务动作只挂不散」;
 * - 样式全走 HeroUI 语义 token(半透明底 + 前景色),不引入裸色值;
 * - 播放/暂停/音量/全屏直接操作 PlayerView 持有的原生 `<video>` 元素(video.js
 *   只做包装,媒体语义同原生),不经过第二套状态机;
 * - 直播(isLive)不呈现可拖动进度条,第 1 行呈现只读节目进度(数据由宿主经
 *   `liveWindow` 注入;无节目数据时整行隐藏),第 2 行中央呈现 LIVE Chip;
 *   点播第 1 行呈现可拖动进度条(seek 能力不满足 canSeek=false 时为只读外观,
 *   与既有 I4 语义一致),第 2 行中央承载播放/暂停;
 * - 控制栏 3 秒无操作自动隐藏(播放中);鼠标移动/键盘聚焦/暂停时保持可见,
 *   触屏与键盘均可操作(React Aria Button/Slider 自带焦点与键盘语义)。
 * - 密度按**播放器容器宽度**适配(PlayerView 根 `@container`),不用视口断点 ——
 *   同一子树同时服务 1120px 大窗与 390px 手机全出血面:
 *   < 28rem(`@max-[28rem]:`,448px)为紧凑档 —— 隐藏音量滑杆(保留静音按钮)、
 *   收紧横向/顶部间距;≥ 28rem 保持完整大窗排版。
 */
import { useCallback, useEffect, useRef, useState, type ReactNode, type RefObject } from 'react';
import { Button, Chip, ProgressBar, Slider } from '@heroui/react';
import { Maximize, Minimize2, Pause, Play, Volume2, VolumeX } from 'lucide-react';

/** 直播第 1 行节目时间窗(标签已按家庭时区格式化;progress 为 0–100 百分比) */
export interface PlayerLiveWindow {
  readonly startLabel: string;
  readonly endLabel: string;
  readonly progress: number;
}

export interface PlayerControlsProps {
  /** 媒体元素(video.js 包装的同一节点;播放语义同原生) */
  readonly videoRef: RefObject<HTMLVideoElement | null>;
  /** 全屏宿主容器(默认取媒体元素的父级) */
  readonly containerRef?: RefObject<HTMLDivElement | null>;
  /** 直播流(无时长/无进度条) */
  readonly isLive: boolean;
  /** 是否允许拖动定位(010 I4:能力不满足时进度条只读) */
  readonly canSeek: boolean;
  /**
   * 直播第 1 行节目时间窗(起止时刻 + 只读进度)。
   * null/缺省 = 无节目元数据 → 第 1 行整行隐藏(不以假数据占位)。
   */
  readonly liveWindow?: PlayerLiveWindow | null;
  /** 缩小为右下角 mini 播放器(mini 态不渲染本控制栏,还原入口在播放面外壳) */
  readonly onToggleMinimize?: () => void;
  /**
   * 业务面板打开期间保持控制栏可见(如播放设置 Popover):置 true 时强制可见并
   * 暂停 3 秒自动隐藏(触发钮不能随栏消失,否则面板失去锚点)。
   */
  readonly keepVisible?: boolean;
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
  liveWindow = null,
  onToggleMinimize,
  keepVisible = false,
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
  /** 面板打开期间保持可见(计时器闭包读 ref,避免闭包捕获旧值) */
  const keepVisibleRef = useRef(keepVisible);

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
      // 业务面板打开期间不隐藏(触发钮是面板锚点;关面板后由下方 effect 重新计时)
      if (keepVisibleRef.current) {
        return;
      }
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

  // 保持可见开关:打开即强制可见并清掉计时器;关闭后恢复自动隐藏计时
  useEffect(() => {
    keepVisibleRef.current = keepVisible;
    if (keepVisible) {
      setVisible(true);
      if (hideTimerRef.current !== null) {
        clearTimeout(hideTimerRef.current);
        hideTimerRef.current = null;
      }
      return;
    }
    revealControls();
  }, [keepVisible, revealControls]);

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

  const playButton = (
    <Button
      size="sm"
      variant="ghost"
      isIconOnly
      aria-label={playing ? '暂停' : '播放'}
      className="shrink-0 text-foreground data-[hovered=true]:bg-foreground/15 @max-[28rem]:size-8"
      onPress={togglePlay}
    >
      {playing ? <Pause className="size-4" aria-hidden="true" /> : <Play className="size-4" aria-hidden="true" />}
    </Button>
  );

  const volumeGroup = (
    <div className="group/vol flex shrink-0 items-center gap-1">
      <Button
        size="sm"
        variant="ghost"
        isIconOnly
        aria-label={muted ? '取消静音' : '静音'}
        className="text-foreground data-[hovered=true]:bg-foreground/15 @max-[28rem]:size-8"
        onPress={toggleMute}
      >
        {muted || volume === 0 ? <VolumeX className="size-4" aria-hidden="true" /> : <Volume2 className="size-4" aria-hidden="true" />}
      </Button>
      <Slider
        aria-label="音量"
        className="w-16 @max-[28rem]:hidden"
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
  );

  return (
    <div
      data-testid="player-controls"
      className={`absolute inset-x-0 bottom-0 z-20 flex flex-col gap-1 bg-gradient-to-t from-background/85 via-background/45 to-transparent px-3 pb-2 pt-8 @max-[28rem]:px-1.5 @max-[28rem]:pt-5 transition-opacity duration-200 ${
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
      {/* 第 1 行 · 直播:节目起止时间 + 只读节目进度(无元数据时整行隐藏) */}
      {isLive && liveWindow !== null ? (
        <div className="flex items-center gap-2 @max-[28rem]:gap-1 text-2xs text-foreground/85">
          <span className="hmp-tabular-nums shrink-0 whitespace-nowrap">{liveWindow.startLabel}</span>
          <ProgressBar
            aria-label="节目进度"
            value={liveWindow.progress}
            color="accent"
            size="sm"
            className="min-w-0 flex-1"
          >
            <ProgressBar.Track className="h-1">
              <ProgressBar.Fill />
            </ProgressBar.Track>
          </ProgressBar>
          <span className="hmp-tabular-nums shrink-0 whitespace-nowrap">{liveWindow.endLabel}</span>
        </div>
      ) : null}

      {/* 第 1 行 · 点播:当前时间 + 可拖动进度 + 总时长(拖动期本地值,松手写回媒体) */}
      {!isLive && progressMax > 0 ? (
        <div className="flex items-center gap-2 @max-[28rem]:gap-1">
          <span className="hmp-tabular-nums shrink-0 whitespace-nowrap text-2xs text-foreground/85">
            {formatClock(shownTime)}
          </span>
          <Slider
            aria-label="播放进度"
            className="min-w-0 flex-1"
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
          <span className="hmp-tabular-nums shrink-0 whitespace-nowrap text-2xs text-foreground/85">
            {formatClock(progressMax)}
          </span>
        </div>
      ) : null}

      {/* 第 2 行 · 动作行:左(直播播放/暂停 + 音量)/ 中(直播 Chip 或点播播放/暂停)/
          右(业务动作 + 最小化 + 全屏)。三列等分两侧,中央组在栏内水平居中。 */}
      <div className="grid grid-cols-[1fr_auto_1fr] items-center gap-1.5 @max-[28rem]:gap-0 text-foreground">
        <div className="flex min-w-0 items-center gap-1.5 @max-[28rem]:gap-0.5">
          {isLive ? playButton : null}
          {volumeGroup}
        </div>

        <div className="flex shrink-0 items-center justify-center @max-[24rem]:hidden">
          {isLive ? (
            <Chip size="sm" variant="soft" color="success" className="shrink-0">
              <span aria-hidden="true" className="size-1.5 rounded-full bg-success" />
              <Chip.Label>LIVE · 正在直播</Chip.Label>
            </Chip>
          ) : (
            playButton
          )}
        </div>

        <div className="flex min-w-0 items-center justify-end gap-1.5 @max-[28rem]:gap-0.5">
          {/* 业务动作区(播放设置/换源/线路/节目单),样式由控制栏统一约束 */}
          <div className="flex shrink-0 items-center gap-1 @max-[28rem]:gap-0.5 [&_button]:text-foreground @max-[28rem]:[&_button]:size-8">{children}</div>

          {/* 最小化:收起为右下角 mini 播放器(宿主实现悬浮与拖动);
              本栏只在大窗渲染,故这里只保留「最小化」一种动作 */}
          {onToggleMinimize !== undefined ? (
            <Button
              size="sm"
              variant="ghost"
              isIconOnly
              aria-label="最小化播放器"
              className="shrink-0 text-foreground data-[hovered=true]:bg-foreground/15 @max-[28rem]:size-8"
              onPress={onToggleMinimize}
            >
              <Minimize2 className="size-4" aria-hidden="true" />
            </Button>
          ) : null}

          <Button
            size="sm"
            variant="ghost"
            isIconOnly
            aria-label={isFullscreen ? '退出全屏' : '全屏'}
            className="shrink-0 text-foreground data-[hovered=true]:bg-foreground/15 @max-[28rem]:size-8"
            onPress={toggleFullscreen}
          >
            {isFullscreen ? <Minimize2 className="size-4" aria-hidden="true" /> : <Maximize className="size-4" aria-hidden="true" />}
          </Button>
        </div>
      </div>
    </div>
  );
}