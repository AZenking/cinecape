/**
 * 播放设置浮层(012 T028 修补;FR-020 第 4 项「字幕/音轨/清晰度当前控制」、
 * FR-023「浮层开关不中断播放、不跳转完整设置页」、ui.md §4.4/§4.5、§5.5):
 *
 * - 浮层形态:播放面内绝对定位非阻塞浮层(009 非模态框架同源;打开/关闭不触媒体
 *   元素 —— 无 src/pause/play 副作用,播放不中断);
 * - 音轨/字幕:已探测轨道的当前值控制(选择经 usePlaybackTrackSelection → 既有
 *   PUT selection;无已探测轨道时显示「暂无可切换轨道」,不虚构);
 * - 清晰度:服务端探测交付的**只读**当前值(无质量阶梯端点 —— 红线「不新增端点/
 *   偏好项」,清晰度由服务端按内容与家庭网络自动选择);
 * - 无设置页入口:浮层内不渲染任何跳转完整设置页的链接/按钮(FR-023;e2e 钉面);
 * - 状态表达:选中态以文字「当前」+ aria-pressed 表达,不仅靠颜色(FR-030);
 * - 视觉:语义 token(bg-surface/border-border/text-foreground 等),无硬编码色值。
 */
import type { ReactNode } from 'react';
import { Button } from '@heroui/react';
import { DELIVERY_LABEL, type PlaybackTrackSelectionApi } from './use-playback-track-selection';

export interface PlaybackSettingsOverlayProps {
  readonly settings: PlaybackTrackSelectionApi;
  /** 服务端探测交付模式(当前清晰度只读展示;null=探测未完成) */
  readonly delivery: string | null;
}

function deliveryLabel(delivery: string | null): string {
  if (delivery === null || delivery === '') {
    return '探测中';
  }
  return DELIVERY_LABEL[delivery] ?? delivery;
}

export function PlaybackSettingsOverlay({ settings, delivery }: PlaybackSettingsOverlayProps): ReactNode {
  const { open, toggle, close, pending, failure, tracks, activeAudioId, activeSubtitleId, canSwitchAudio } = settings;
  const audioTracks = tracks?.audio ?? [];
  const subtitleTracks = tracks?.subtitles ?? [];
  return (
    <>
      <Button
        size="sm"
        variant="ghost"
        aria-label="播放设置"
        aria-expanded={open}
        aria-haspopup="dialog"
        className="absolute end-3 top-14 z-10"
        onPress={toggle}
      >
        播放设置
      </Button>
      {open ? (
        <div
          role="dialog"
          aria-label="播放设置"
          data-testid="playback-settings"
          className="absolute end-3 top-28 z-20 flex w-72 flex-col gap-3 rounded-lg border border-border bg-surface p-3 shadow-lg"
        >
          <p className="text-sm font-medium text-foreground">播放设置</p>
          {/* 音轨(当前值控制;探测未完成为空,不虚构可选轨) */}
          <section aria-label="音轨" className="flex flex-col gap-1">
            <p className="text-xs text-muted">音轨</p>
            {audioTracks.length === 0 ? (
              <p className="text-xs text-muted">暂无可切换音轨</p>
            ) : (
              audioTracks.map((track) => {
                const active = activeAudioId === track.id;
                return (
                  <Button
                    key={track.id}
                    size="sm"
                    variant="ghost"
                    aria-pressed={active}
                    isDisabled={pending || !canSwitchAudio}
                    onPress={() => settings.selectAudio(track.id)}
                  >
                    {`${track.label}${active ? '(当前)' : ''}`}
                  </Button>
                );
              })
            )}
          </section>
          {/* 字幕(当前值控制;null=关闭;初始不自动开启) */}
          <section aria-label="字幕" className="flex flex-col gap-1">
            <p className="text-xs text-muted">字幕</p>
            {subtitleTracks.length === 0 ? (
              <p className="text-xs text-muted">暂无可切换字幕</p>
            ) : (
              <>
                <Button
                  size="sm"
                  variant="ghost"
                  aria-pressed={activeSubtitleId === null}
                  isDisabled={pending}
                  onPress={() => settings.selectSubtitle(null)}
                >
                  {`关闭${activeSubtitleId === null ? '(当前)' : ''}`}
                </Button>
                {subtitleTracks.map((track) => {
                  const active = activeSubtitleId === track.id;
                  return (
                    <Button
                      key={track.id}
                      size="sm"
                      variant="ghost"
                      aria-pressed={active}
                      isDisabled={pending}
                      onPress={() => settings.selectSubtitle(track.id)}
                    >
                      {`${track.label}${active ? '(当前)' : ''}`}
                    </Button>
                  );
                })}
              </>
            )}
          </section>
          {/* 清晰度:服务端探测交付只读事实(无质量切换端点,不新增) */}
          <section aria-label="清晰度" className="flex flex-col gap-1">
            <p className="text-xs text-muted">清晰度</p>
            <p className="text-xs text-foreground" data-testid="playback-quality">
              {`自动(当前交付:${deliveryLabel(delivery)})`}
            </p>
            <p className="text-xs text-muted">清晰度由服务端按内容与家庭网络自动选择。</p>
          </section>
          {failure !== null ? (
            <p role="alert" data-testid="playback-settings-failure" className="text-xs text-danger">
              {failure}
            </p>
          ) : null}
          <Button size="sm" variant="ghost" onPress={close} aria-label="关闭播放设置">
            关闭
          </Button>
        </div>
      ) : null}
    </>
  );
}
