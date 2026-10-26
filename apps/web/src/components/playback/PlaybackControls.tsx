/**
 * 播放控制条 PlaybackControls(T051,US3)——完整影片逻辑进度条与轨/字幕/状态控件。
 *
 * 职责(docs/specs/004-playback-resolver/tasks.md T051 + contracts/api.md「时间轴及请求预算」
 * + research.md R8):
 * - 逻辑进度条:duration=state.durationSeconds(完整影片逻辑时长,不依赖 HLS seekable,R8);
 *   显示位置=state.positionSeconds(逻辑时间;媒体时间→逻辑时间换算由 MediaPlayer 完成);
 *   拖动/点击/键盘步进 → onSeekIntent(目标逻辑秒)。seek 本体(api.seekPlayback +
 *   expectedVersion/operationEpoch 竞态守卫)由 T053 接线,控件层只发起意图;
 *   直播(durationSeconds=null)不渲染进度条,以「直播」Chip 标识(US3-07 直播无 seek);
 *   seek 受理后(phase→preparing)进度条禁用进入「跳转中」视觉态,滑块保持目标位置不闪回
 *   目标前画面;state.presentationStartSeconds>0 时附加「将跳过目标前画面」提示
 *   (timelineOffset/presentationStart 的实际消费在 MediaPlayer/T053,US3-07);
 * - 字幕/音轨菜单:state.tracks 快照渲染(音轨列表 + 字幕列表 + 「关闭字幕」);选择 →
 *   onSelectTracks(audioTrackId?, subtitleTrackId?|null)(api.selectTracks 由 T053 接线)。
 *   纯字幕切换显示「字幕切换中…不中断播放」瞬时提示;音轨重建(经 preparing)显示
 *   「正在切换音轨…」;当前选中态由 tracks default 与最近一次选择意图推断(US3-08);
 * - 状态提示条:preparing(Spinner「内容准备中…」+ 取消 → controller.stop());failed
 *   (PLAYBACK_ERROR_LABELS 稳定码文案 + 重试 → controller.retry(),覆盖忙/超时/资源不足/
 *   性能不足各码,US3-03/04/09);ended(PLAYBACK_ERROR_LABELS.PLAYBACK_ENDED + 重看)。
 *   文案一律取 PLAYBACK_ERROR_LABELS,不重复硬编码;
 * - 播放/暂停:经 controller.play()/pause()(T051 在 MediaPlayer.Controller 的最小增补,
 *   实现基于同一 video 元素);
 * - 可达性:全部控件 Tab 可聚焦、Enter/Space 可操作(HeroUI/React Aria 默认);进度条
 *   Slider 键盘步进(方向键 1 秒/PageUpDown/Home/End);aria-label 全中文;状态变化经
 *   role="status" aria-live="polite" 播报(准备中/跳转中/失败/直播等)。
 *
 * 接线边界(T052):本组件不触 api、不持有会话与票;由详情页持有 MediaPlayer 的
 * onStateChange/onController 输出并回填 props;onSeekIntent/onSelectTracks 由 T053 的
 * usePlaybackSession 实现后传入(内部调用 api.seekPlayback/api.selectTracks 并驱动
 * MediaPlayer 重新进入 preparing→ready→续期)。世代/竞态守卫亦在 T053,本组件只保证
 * preparing 期间不再发起第二次意图(契约:preparing 中第二次 seek/selection 被拒绝)。
 */
import { useCallback, useEffect, useState } from 'react';
import type { Key } from 'react';
import { Alert, Button, Chip, Label, ListBox, Select, Slider, Spinner } from '@heroui/react';
import { PLAYBACK_ERROR_LABELS } from '../../lib/api';
import type { TrackAudio, TrackSubtitle } from '@hmp/shared';
import type { MediaPlayerController, MediaPlayerState } from './MediaPlayer';

/* ---------------------------------- 常量 ---------------------------------- */

/** 字幕菜单「关闭字幕」哨兵 key(仅菜单内部;不与真实轨道 id 冲突,选择时映射为 null) */
const SUBTITLE_OFF_KEY = '__subtitle_off__';

/** 纯字幕切换瞬时提示时长(契约:纯字幕切换同步 200 不进 preparing,提示短暂即隐) */
const SUBTITLE_HINT_MS = 2500;

/** 音轨切换提示兜底上限(契约:重建音轨 ready 预算 30s;正常由相位迁出提前清除) */
const AUDIO_SWITCH_HINT_MS = 30_000;

/** seek 提示兜底上限(契约:目标位置恢复上限 15 秒;正常由相位迁出提前清除) */
const SEEK_HINT_MS = 20_000;

/* ---------------------------------- Props ---------------------------------- */

export interface PlaybackControlsProps {
  /** 播放器状态快照(MediaPlayer.onStateChange 回填;不含票/播放地址) */
  state: MediaPlayerState;
  /** 播放器命令句柄(MediaPlayer.onController 回填;null=尚未挂载,全部命令禁用) */
  controller: MediaPlayerController | null;
  /** seek 意图:目标影片逻辑秒(经控制端点换 generation;T053 实现) */
  onSeekIntent: (logicalPositionSeconds: number) => void;
  /** 换轨/字幕意图:未提供的轴保持现值;字幕 null=关闭(T053 实现) */
  onSelectTracks: (audioTrackId?: string, subtitleTrackId?: string | null) => void;
  /**
   * 失败/结束提示是否由本组件渲染(默认 true)。MediaPlayer 覆盖层已含同文案 Alert,
   * 详情页两者同屏时可置 false 去重;重试/取消按钮不受此开关影响。
   */
  showFailureAlert?: boolean;
  /** 追加到容器类名 */
  className?: string;
}

/* ---------------------------------- 纯工具 ---------------------------------- */

/** 秒 → mm:ss / h:mm:ss(影片逻辑时间显示;非有限/负值按 0 处理) */
function formatSeconds(total: number): string {
  const safe = Number.isFinite(total) && total > 0 ? Math.floor(total) : 0;
  const hours = Math.floor(safe / 3600);
  const minutes = Math.floor((safe % 3600) / 60);
  const seconds = safe % 60;
  const mm = String(minutes).padStart(2, '0');
  const ss = String(seconds).padStart(2, '0');
  return hours > 0 ? `${hours}:${mm}:${ss}` : `${mm}:${ss}`;
}

/** 轨道展示名:label 优先,空回落语言,再空回落序号;语言与名不同时括注 */
function trackDisplayName(label: string, language: string, index: number): string {
  const name = label.trim() !== '' ? label.trim() : language.trim() !== '' ? language.trim() : `轨道 ${index + 1}`;
  return language.trim() !== '' && language.trim() !== name ? `${name}（${language.trim()}）` : name;
}

function audioTrackName(track: TrackAudio, index: number): string {
  const name = trackDisplayName(track.label, track.language, index);
  return track.default ? `${name}（默认）` : name;
}

function subtitleTrackName(track: TrackSubtitle, index: number): string {
  return trackDisplayName(track.label, track.language, index);
}

/** Slider onChange/onChangeEnd 的取值归一(单滑块取首值) */
function sliderValue(value: number | number[]): number {
  return Array.isArray(value) ? (value[0] ?? 0) : value;
}

/* ---------------------------------- 组件 ---------------------------------- */

export function PlaybackControls({
  state,
  controller,
  onSeekIntent,
  onSelectTracks,
  showFailureAlert = true,
  className,
}: PlaybackControlsProps) {
  const { phase } = state;
  const duration = state.durationSeconds;
  const isLive = duration === null;

  /* ---- 交互相位:进度条/菜单/播放暂停仅在这些相可用(preparing/终态一律禁用) ---- */
  const interactive = phase === 'ready' || phase === 'playing' || phase === 'paused';
  const seekable = interactive && !isLive && duration !== null && controller !== null;

  /* ---- 意图在途标记(控件层本地;相位迁出即清除,另有兜底上限防卡死) ---- */
  const [dragSeconds, setDragSeconds] = useState<number | null>(null);
  const [seekTarget, setSeekTarget] = useState<number | null>(null);
  const [audioSwitching, setAudioSwitching] = useState(false);
  const [subtitleSwitching, setSubtitleSwitching] = useState(false);

  /* ---- 最近选择意图(选中态高亮;null=回落 tracks default / 字幕默认关闭) ---- */
  const [chosenAudioId, setChosenAudioId] = useState<string | null>(null);
  const [chosenSubtitleId, setChosenSubtitleId] = useState<string | null | undefined>(undefined);

  /** seek 受理后滑块保持目标位置(不闪回目标前画面;US3-07) */
  const displaySeconds = dragSeconds ?? seekTarget ?? state.positionSeconds;
  const seekingNow = phase === 'preparing' && seekTarget !== null;

  /* ---- 相位收敛:回到可播相清除 seek/音轨在途;终态再清字幕提示与拖动预览 ---- */
  useEffect(() => {
    if (phase === 'ready' || phase === 'playing' || phase === 'paused') {
      setSeekTarget(null);
      setAudioSwitching(false);
      setDragSeconds(null);
    } else if (phase === 'failed' || phase === 'ended') {
      setSeekTarget(null);
      setAudioSwitching(false);
      setSubtitleSwitching(false);
      setDragSeconds(null);
    }
  }, [phase]);

  /** 字幕提示定时收敛 */
  useEffect(() => {
    if (!subtitleSwitching) {
      return;
    }
    const timer = setTimeout(() => setSubtitleSwitching(false), SUBTITLE_HINT_MS);
    return () => clearTimeout(timer);
  }, [subtitleSwitching]);

  /** 音轨提示兜底上限(正常先经相位收敛清除) */
  useEffect(() => {
    if (!audioSwitching) {
      return;
    }
    const timer = setTimeout(() => setAudioSwitching(false), AUDIO_SWITCH_HINT_MS);
    return () => clearTimeout(timer);
  }, [audioSwitching]);

  /** seek 提示兜底上限(正常先经相位收敛清除;超时视觉退回由状态条继续呈现 preparing) */
  useEffect(() => {
    if (seekTarget === null) {
      return;
    }
    const timer = setTimeout(() => setSeekTarget(null), SEEK_HINT_MS);
    return () => clearTimeout(timer);
  }, [seekTarget]);

  /** 换会话(retry/重开 resolve 产生新 session id)即重置全部本地选择意图 */
  const sessionId = state.sessionId;
  useEffect(() => {
    setChosenAudioId(null);
    setChosenSubtitleId(undefined);
    setAudioSwitching(false);
    setSubtitleSwitching(false);
    setSeekTarget(null);
    setDragSeconds(null);
  }, [sessionId]);

  /* ---- 菜单数据与选中态推断 ---- */
  const audioTracks = state.tracks.audio;
  const subtitleTracks = state.tracks.subtitles;
  /** 选中音轨:最近选择意图优先,回落 default,再回落首个已探测轨道 */
  const effectiveAudioId =
    chosenAudioId ?? audioTracks.find((track) => track.default)?.id ?? audioTracks[0]?.id ?? null;
  /** 选中字幕:undefined(初始,默认关)/null(明确关)/id;菜单值映射到哨兵 key */
  const effectiveSubtitleId = chosenSubtitleId !== undefined ? chosenSubtitleId : null;
  /** preparing 中契约拒绝第二次 seek/selection;终态无可操作;controller 未就绪一并禁用 */
  const menusDisabled = controller === null || !interactive;

  /* ---- 意图回调 ---- */

  const commitSeek = useCallback(
    (value: number | number[]): void => {
      const raw = sliderValue(value);
      setDragSeconds(null);
      if (duration === null || controller === null || (phase !== 'ready' && phase !== 'playing' && phase !== 'paused')) {
        return;
      }
      if (!Number.isFinite(raw)) {
        return;
      }
      const target = Math.min(Math.max(Math.round(raw), 0), Math.max(duration, 0));
      setSeekTarget(target);
      onSeekIntent(target);
    },
    [controller, duration, onSeekIntent, phase],
  );

  const handleAudioChange = useCallback(
    (key: Key | null): void => {
      if (typeof key !== 'string' || key === effectiveAudioId) {
        return;
      }
      setChosenAudioId(key);
      setAudioSwitching(true);
      onSelectTracks(key, undefined);
    },
    [effectiveAudioId, onSelectTracks],
  );

  const handleSubtitleChange = useCallback(
    (key: Key | null): void => {
      if (typeof key !== 'string') {
        return;
      }
      const subtitleId = key === SUBTITLE_OFF_KEY ? null : key;
      if (subtitleId === effectiveSubtitleId) {
        return;
      }
      setChosenSubtitleId(subtitleId);
      setSubtitleSwitching(true);
      onSelectTracks(undefined, subtitleId);
    },
    [effectiveSubtitleId, onSelectTracks],
  );

  /* ---- 状态播报文案(role="status" aria-live="polite" 单一播报源) ---- */
  const transientHint =
    phase === 'preparing'
      ? null
      : subtitleSwitching
        ? '字幕切换中…不中断播放'
        : audioSwitching
          ? '正在切换音轨…'
          : null;

  let statusText: string;
  if (phase === 'preparing') {
    if (seekingNow) {
      statusText =
        state.presentationStartSeconds > 0
          ? '跳转中…正在定位到目标位置，将跳过目标前画面'
          : '跳转中…正在定位到目标位置';
    } else if (audioSwitching) {
      statusText = '正在切换音轨…';
    } else if (subtitleSwitching) {
      statusText = '字幕切换中…不中断播放';
    } else {
      statusText = '内容准备中…';
    }
  } else if (phase === 'failed' || phase === 'ended') {
    // 文案一律取 PLAYBACK_ERROR_LABELS 映射结果(由 MediaPlayer 经 failureMessage 提供)
    const message = state.failureMessage ?? PLAYBACK_ERROR_LABELS.PLAYBACK_NOT_FOUND;
    const prefix = phase === 'failed' ? '播放失败' : '播放已结束';
    statusText = message === prefix ? message : `${prefix}：${message}`;
  } else if (transientHint !== null) {
    statusText = transientHint;
  } else if (isLive) {
    statusText = interactive ? '正在直播播放，不支持拖动进度' : '直播准备中…';
  } else {
    statusText = phase === 'playing' ? '正在播放' : phase === 'paused' ? '已暂停' : '已就绪';
  }

  const isPlaying = phase === 'playing';
  const canTogglePlay = interactive && controller !== null;

  return (
    <div className={`flex flex-col gap-3 ${className ?? ''}`} data-phase={phase}>
      {/* 逻辑进度条:duration=完整影片逻辑时长(R8);直播隐藏并以 Chip 标识 */}
      {!isLive && duration !== null && (
        <div className={`flex items-center gap-3 ${seekingNow ? 'opacity-70' : ''}`}>
          <span className="w-14 shrink-0 text-right text-xs tabular-nums text-muted" aria-hidden="true">
            {formatSeconds(displaySeconds)}
          </span>
          <Slider
            className="min-w-0 flex-1"
            aria-label="影片进度"
            minValue={0}
            maxValue={Math.max(duration, 1)}
            step={1}
            value={displaySeconds}
            onChange={(value) => {
              if (!seekable) {
                return;
              }
              setDragSeconds(sliderValue(value));
            }}
            onChangeEnd={commitSeek}
            isDisabled={!seekable}
          >
            <Slider.Track>
              <Slider.Fill />
            </Slider.Track>
            <Slider.Thumb aria-label="播放位置" />
          </Slider>
          <span className="w-14 shrink-0 text-xs tabular-nums text-muted" aria-hidden="true">
            {formatSeconds(duration)}
          </span>
        </div>
      )}

      {/* 控件行:直播标识/播放暂停/音轨/字幕/取消/重试 */}
      <div className="flex flex-wrap items-center gap-2">
        {isLive && (
          <Chip size="sm" variant="soft" color="accent" aria-label="直播播放，不支持拖动进度">
            直播
          </Chip>
        )}

        <Button
          variant="primary"
          size="sm"
          onPress={() => (isPlaying ? controller?.pause() : controller?.play())}
          isDisabled={!canTogglePlay}
        >
          {isPlaying ? '暂停' : '播放'}
        </Button>

        <Select
          className="w-44"
          aria-label="音轨"
          placeholder="暂无可用音轨"
          value={effectiveAudioId}
          onChange={handleAudioChange}
          isDisabled={menusDisabled || audioTracks.length === 0}
        >
          <Label className="text-xs text-muted">音轨</Label>
          <Select.Trigger>
            <Select.Value />
            <Select.Indicator />
          </Select.Trigger>
          <Select.Popover>
            <ListBox aria-label="音轨列表">
              {audioTracks.map((track, index) => (
                <ListBox.Item key={track.id} id={track.id} textValue={audioTrackName(track, index)}>
                  {audioTrackName(track, index)}
                  <ListBox.ItemIndicator />
                </ListBox.Item>
              ))}
            </ListBox>
          </Select.Popover>
        </Select>

        <Select
          className="w-44"
          aria-label="字幕"
          placeholder="暂无可用字幕"
          value={effectiveSubtitleId ?? SUBTITLE_OFF_KEY}
          onChange={handleSubtitleChange}
          isDisabled={menusDisabled || subtitleTracks.length === 0}
        >
          <Label className="text-xs text-muted">字幕</Label>
          <Select.Trigger>
            <Select.Value />
            <Select.Indicator />
          </Select.Trigger>
          <Select.Popover>
            <ListBox aria-label="字幕列表">
              <ListBox.Item id={SUBTITLE_OFF_KEY} textValue="关闭字幕">
                关闭字幕
                <ListBox.ItemIndicator />
              </ListBox.Item>
              {subtitleTracks.map((track, index) => (
                <ListBox.Item key={track.id} id={track.id} textValue={subtitleTrackName(track, index)}>
                  {subtitleTrackName(track, index)}
                  <ListBox.ItemIndicator />
                </ListBox.Item>
              ))}
            </ListBox>
          </Select.Popover>
        </Select>

        {phase === 'preparing' && (
          <Button
            variant="outline"
            size="sm"
            onPress={() => controller?.stop()}
            isDisabled={controller === null}
            aria-label="取消准备并停止播放"
          >
            取消
          </Button>
        )}
        {(phase === 'failed' || phase === 'ended') && (
          <Button
            variant="primary"
            size="sm"
            onPress={() => controller?.retry()}
            isDisabled={controller === null}
            aria-label={phase === 'failed' ? '重试播放' : '重新播放'}
          >
            重试
          </Button>
        )}
      </div>

      {/* 状态提示条:preparing 忙碌 + 稳定码文案;aria-live 播报状态变化 */}
      <div role="status" aria-live="polite" className="flex items-center gap-2 text-sm text-muted">
        {phase === 'preparing' && <Spinner size="sm" aria-hidden="true" />}
        <span>{statusText}</span>
      </div>

      {/* 失败/结束详情(忙碌/超时/资源不足等稳定码经 PLAYBACK_ERROR_LABELS 呈现) */}
      {showFailureAlert && (phase === 'failed' || phase === 'ended') && (
        <Alert status={phase === 'failed' ? 'danger' : 'warning'}>
          <Alert.Indicator />
          <Alert.Content>
            <Alert.Title>{phase === 'failed' ? '播放失败' : '播放已结束'}</Alert.Title>
            {state.failureMessage !== null && <Alert.Description>{state.failureMessage}</Alert.Description>}
          </Alert.Content>
        </Alert>
      )}
    </div>
  );
}
