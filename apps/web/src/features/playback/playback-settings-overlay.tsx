/**
 * 播放设置浮层(012 T028 修补;FR-020 第 4 项「字幕/音轨/清晰度当前控制」、
 * FR-023「浮层开关不中断播放、不跳转完整设置页」、ui.md §4.4/§4.5、§5.5):
 *
 * - 浮层形态:HeroUI v3 `Popover` 复合组件(019 T015 迁移,替换自绘绝对定位弹层)。
 *   `Popover.Content` 走 portal 渲染到 body,锚定触发钮(`placement="top end"`),
 *   脱离播放器外壳的 `overflow-hidden` 裁切;`isNonModal` 不做焦点陷阱/不 aria-hidden
 *   播放面,打开/关闭不触媒体元素 —— 无 src/pause/play 副作用,播放不中断;
 * - Esc / 外部点击关闭:React Aria 的非模态 popover 只关闭 aria-hidden 与焦点陷阱,
 *   不接管外部指针关闭。这里补一个最小收口监听(触发钮自身除外,点触发钮仍由
 *   React Aria 的 toggle 语义关闭),使面板行为符合浮层预期;
 * - 音轨/字幕:已探测轨道的当前值控制(选择经 usePlaybackTrackSelection → 既有
 *   PUT selection;无已探测轨道时显示「暂无可切换轨道」,不虚构);
 * - 清晰度:服务端探测交付的**只读**当前值(无质量阶梯端点 —— 红线「不新增端点/
 *   偏好项」,清晰度由服务端按内容与家庭网络自动选择);
 * - 无设置页入口:浮层内不渲染任何跳转完整设置页的链接/按钮(FR-023;e2e 钉面);
 * - 状态表达:选中态以文字「当前」+ aria-pressed + 尾部 Check 图标表达,不仅靠
 *   颜色(FR-030);选项行左对齐,当前项 accent 淡染;
 * - 视觉:语义 token(bg-accent/10、text-accent、text-muted 等),无硬编码色值。
 */
import { useEffect, useRef, type ReactNode } from 'react';
import { Button, Popover } from '@heroui/react';
import { Check, Settings } from 'lucide-react';
import type { StreamLineDto } from '@hmp/shared';
import { DELIVERY_LABEL, type PlaybackTrackSelectionApi } from './use-playback-track-selection';

export interface PlaybackSettingsOverlayProps {
  readonly settings: PlaybackTrackSelectionApi;
  /** 服务端探测交付模式(当前清晰度只读展示;null=探测未完成) */
  readonly delivery: string | null;
  /** 直播线路清单(≥2 条时在设置内呈现「线路」选择;单线路不渲染) */
  readonly lines?: readonly StreamLineDto[];
  readonly selectedLineId?: string | null;
  /** 手动换线(仅上报 lineId;由协调器原地换装) */
  readonly onSelectLine?: (lineId: string) => void;
  /** 打开换源面板(点播换源入口;直播不呈现 —— 直播换流走「线路」) */
  readonly onOpenSourceSwitch?: () => void;
  /** 是否直播流:决定「换流」只给一个入口(线路 / 换源 二选一,不并列) */
  readonly isLive?: boolean;
}

function deliveryLabel(delivery: string | null): string {
  if (delivery === null || delivery === '') {
    return '探测中';
  }
  return DELIVERY_LABEL[delivery] ?? delivery;
}

/** 选项行:整行可点(Button 默认 w-fit)、统一左对齐;当前项 accent 淡染 + 尾部 Check */
function optionRowClass(active: boolean): string {
  return active ? 'w-full justify-start bg-accent/10 text-accent' : 'w-full justify-start';
}

export function PlaybackSettingsOverlay({
  settings,
  delivery,
  lines = [],
  selectedLineId = null,
  onSelectLine,
  onOpenSourceSwitch,
  isLive = false,
}: PlaybackSettingsOverlayProps): ReactNode {
  const { open, toggle, close, pending, failure, tracks, activeAudioId, activeSubtitleId, canSwitchAudio } = settings;
  const audioTracks = tracks?.audio ?? [];
  const subtitleTracks = tracks?.subtitles ?? [];
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const dialogRef = useRef<HTMLElement | null>(null);

  // 非模态 popover 的关闭收口(见文件头):外部指针按下 + Esc。触发钮自身不在此
  // 收口范围内 —— 点触发钮由 React Aria 的 DialogTrigger toggle 关闭,避免双击式重开。
  useEffect(() => {
    if (!open) {
      return;
    }
    const isInside = (target: EventTarget | null): boolean =>
      target instanceof Node &&
      (dialogRef.current?.contains(target) === true || triggerRef.current?.contains(target) === true);
    const onPointerDown = (event: PointerEvent): void => {
      if (!isInside(event.target)) {
        close();
      }
    };
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        close();
      }
    };
    document.addEventListener('pointerdown', onPointerDown, true);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown, true);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [open, close]);

  return (
    <Popover
      isOpen={open}
      onOpenChange={(next) => {
        if (next === open) {
          return;
        }
        if (next) {
          toggle();
        } else {
          close();
        }
      }}
    >
      {/* 触发钮 = 控制栏里的齿轮;aria-expanded/aria-haspopup 由 React Aria 注入 */}
      <Button ref={triggerRef} size="sm" variant="ghost" isIconOnly aria-label="播放设置" className="text-foreground">
        <Settings className="size-4" aria-hidden="true" />
      </Button>
      <Popover.Content placement="top end" isNonModal offset={8} className="w-72 max-w-[calc(100vw-1rem)]">
        <Popover.Dialog
          ref={dialogRef}
          aria-label="播放设置"
          data-testid="playback-settings"
          className="max-h-[min(60vh,420px)] overflow-y-auto p-3"
        >
          <Popover.Heading className="text-sm font-medium text-foreground">播放设置</Popover.Heading>
          <div className="mt-3 flex flex-col gap-3">
            {/* 音轨(当前值控制;探测未完成为空,不虚构可选轨) */}
            <section aria-label="音轨" className="flex flex-col gap-1">
              <p className="text-2xs font-medium text-muted">音轨</p>
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
                      className={optionRowClass(active)}
                      onPress={() => settings.selectAudio(track.id)}
                    >
                      <span className="hmp-truncate min-w-0">{`${track.label}${active ? '(当前)' : ''}`}</span>
                      {active ? <Check className="ms-auto size-3.5 shrink-0" aria-hidden="true" /> : null}
                    </Button>
                  );
                })
              )}
            </section>
            {/* 字幕(当前值控制;null=关闭;初始不自动开启) */}
            <section aria-label="字幕" className="flex flex-col gap-1">
              <p className="text-2xs font-medium text-muted">字幕</p>
              {subtitleTracks.length === 0 ? (
                <p className="text-xs text-muted">暂无可切换字幕</p>
              ) : (
                <>
                  <Button
                    size="sm"
                    variant="ghost"
                    aria-pressed={activeSubtitleId === null}
                    isDisabled={pending}
                    className={optionRowClass(activeSubtitleId === null)}
                    onPress={() => settings.selectSubtitle(null)}
                  >
                    <span className="hmp-truncate min-w-0">{`关闭${activeSubtitleId === null ? '(当前)' : ''}`}</span>
                    {activeSubtitleId === null ? <Check className="ms-auto size-3.5 shrink-0" aria-hidden="true" /> : null}
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
                        className={optionRowClass(active)}
                        onPress={() => settings.selectSubtitle(track.id)}
                      >
                        <span className="hmp-truncate min-w-0">{`${track.label}${active ? '(当前)' : ''}`}</span>
                        {active ? <Check className="ms-auto size-3.5 shrink-0" aria-hidden="true" /> : null}
                      </Button>
                    );
                  })}
                </>
              )}
            </section>
            {/* 清晰度:服务端探测交付只读事实(无质量切换端点,不新增) */}
            <section aria-label="清晰度" className="flex flex-col gap-1">
              <p className="text-2xs font-medium text-muted">清晰度</p>
              <p className="text-xs text-foreground" data-testid="playback-quality">
                {`自动(当前交付:${deliveryLabel(delivery)})`}
              </p>
              <p className="text-xs text-muted">清晰度由服务端按内容与家庭网络自动选择。</p>
            </section>
            {/* 换流入口只保留一个(产品:两个入口并列不成立)——
                直播 = 线路切换(≥2 条时),点播 = 换源;两者互斥渲染 */}
            {isLive && lines.length >= 2 && onSelectLine !== undefined ? (
              <section aria-label="线路" className="flex flex-col gap-1">
                <p className="text-2xs font-medium text-muted">线路</p>
                {lines.map((line) => {
                  const active = line.lineId === selectedLineId;
                  return (
                    <Button
                      key={line.lineId}
                      size="sm"
                      variant="ghost"
                      aria-pressed={active}
                      className={optionRowClass(active)}
                      aria-label={`${line.label}${line.sourceTitle !== undefined ? ` · ${line.sourceTitle}` : ''}${active ? '(当前)' : ''}`}
                      onPress={() => {
                        onSelectLine(line.lineId);
                        close();
                      }}
                    >
                      <span className="hmp-truncate min-w-0">{`${line.label}${active ? '(当前)' : ''}`}</span>
                      {active ? <Check className="ms-auto size-3.5 shrink-0" aria-hidden="true" /> : null}
                    </Button>
                  );
                })}
              </section>
            ) : null}
            {/* 换源(仅点播):直播的换流入口是上面的「线路」,不并列 */}
            {!isLive && onOpenSourceSwitch !== undefined ? (
              <section aria-label="换源" className="flex flex-col gap-1">
                <p className="text-2xs font-medium text-muted">来源</p>
                <Button
                  size="sm"
                  variant="ghost"
                  className="w-full justify-start"
                  aria-label="换源"
                  onPress={() => {
                    onOpenSourceSwitch();
                    close();
                  }}
                >
                  换源
                </Button>
              </section>
            ) : null}
            {failure !== null ? (
              <p role="alert" data-testid="playback-settings-failure" className="text-xs text-danger">
                {failure}
              </p>
            ) : null}
            <Button size="sm" variant="ghost" className="w-full" onPress={close} aria-label="关闭播放设置">
              关闭
            </Button>
          </div>
        </Popover.Dialog>
      </Popover.Content>
    </Popover>
  );
}