import { useState } from 'react';
import type { ReactNode } from 'react';
import { Button, Card, ProgressBar } from '@heroui/react';
import { Info, Play, Volume2, VolumeX } from 'lucide-react';
import type { ChannelRowDto } from '@hmp/shared';
import { usePlayAction } from '../../playback/use-play-action';
import { useSession } from '../../../app/session-provider';
import { formatRangeInZone, formatTimeInZone } from '../live-format';
import { ProgrammePoster } from '../../shared-programme/programme-poster';
import { ChannelIdentityBadge } from './channel-identity-badge';
import { progressOf, type OpenProgrammeHandler } from './ChannelTile';

/**
 * 直播首页顶部【直接播放】大屏(015 T008;FR-002、FR-014):
 *
 * - 2026-11-18 设计稿调整:当前节目有 16:9 剧照时铺满舞台,无海报回退频道标识
 *   渐变舞台;信息层收进左下(分组 · 频道 → 节目名 → 时段 → 已播出进度),「接下来」
 *   与「全屏观看 / 节目详情」同一行排布在底部,右侧顶部保留频道台标与静音。
 * - 播放架构硬约束:本组件不内嵌播放器实例,主操作一律经 usePlayAction().play(),
 *   ActionCoordinator 统一 authorize/prepare,全局播放面浮现。
 * - 静音开关默认静音意图;全局播放面当前未暴露音量 API,本开关仅承载本地意图。
 * - 游客/未选档呈现形态分流:主操作文案「直接收看」;播放行为零登录自判,
 *   由 ActionCoordinator 统一拦截。
 * - 无节目单频道(current=null)保留频道身份与播放入口,标题位「暂无节目单」。
 * - 语义:region 可读名「直播精选大屏」与三个分区 region 名互不为子串。
 */

export interface LiveHeroPlayerProps {
  /** 精选频道行:now 区服务端稳定排序首频道(宿主下发;未就绪时宿主不渲染本组件) */
  readonly row: ChannelRowDto;
  /** 服务端同步快照时区(家庭时区标注与换算唯一依据) */
  readonly timezone: string;
  /** 服务端快照 now(计算当前节目进度线;缺省/无效时不画进度,不臆造本地时钟) */
  readonly nowIso: string | null;
  /** 「节目详情/接下来」:打开共享节目详情面板(与瓦片卡同一回调载荷) */
  readonly onOpenProgramme: OpenProgrammeHandler;
}

/** djb2 散列:舞台渐变角度与光斑位置由稳定 id 派生(同 ChannelTile,跨刷新不变) */
function hashOf(key: string): number {
  let hash = 5381;
  for (let index = 0; index < key.length; index += 1) {
    hash = ((hash << 5) + hash + key.charCodeAt(index)) | 0;
  }
  return Math.abs(hash);
}

export function LiveHeroPlayer({ row, timezone, nowIso, onOpenProgramme }: LiveHeroPlayerProps): ReactNode {
  const channelTitle = row.media.title;
  const current = row.current;
  // 统一播放入口(US3;015 硬约束):全屏观看/直接收看同源消费,零第二播放器实例
  const { play } = usePlayAction();
  const session = useSession();
  const guestPresentation =
    session.status !== 'authenticated' || session.session?.activeProfile == null;
  // 静音意图(默认静音免打扰;全局播放面暂无音量 API,仅本地意图状态)
  const [mutedIntent, setMutedIntent] = useState(true);
  const hash = hashOf(row.media.id);
  const plateAngle = 100 + (hash % 140);
  const glowOnRight = hash % 2 === 1;
  const progress = current !== null ? progressOf(current.startsAt, current.endsAt, nowIso) : null;
  const progressPercent = progress !== null ? Math.round(progress * 100) : 0;
  const posterRef = current?.posterRef ?? null;

  /** 主操作:全屏观看/直接收看 —— 一律直接 play(),登录拦截归 ActionCoordinator */
  const startPlayback = (): void => {
    play({ mediaId: row.media.id, title: channelTitle, startMode: 'beginning', posterRef: row.media.posterRef });
  };

  /** 档期(家庭时区;无节目单频道不臆造时间) */
  const scheduleLabel =
    current !== null ? formatRangeInZone(current.startsAt, current.endsAt, timezone) : null;
  const progressLabel = progress !== null ? `已播出 ${String(progressPercent)}%` : null;

  return (
    // HeroUI Card「With Images」背景图卡用法:舞台铺满 Card,内容层叠在上方。
    <Card
      render={(props) => <section {...props} />}
      aria-label="直播精选大屏"
      data-testid="live-hero-player"
      className="relative min-h-[17rem] min-w-0 overflow-hidden md:min-h-[17.5rem]"
    >
      {/* 背景层:节目剧照(有则铺满)或频道标识渐变舞台 + 可读性压暗层。
          aria-hidden:装饰层,可读语义全部由上层内容承担。 */}
      <div
        data-testid="live-hero-stage"
        aria-hidden="true"
        className="absolute inset-0 aspect-video h-full w-full overflow-hidden bg-surface-secondary"
        style={posterRef === null
          ? { background: `linear-gradient(${plateAngle}deg, var(--surface-secondary) 0%, var(--surface-tertiary) 55%, var(--surface) 100%)` }
          : undefined}
      >
        {posterRef !== null ? (
          <ProgrammePoster
            posterRef={posterRef}
            title={current?.title ?? channelTitle}
            className="absolute inset-0 h-full w-full object-cover"
          />
        ) : (
          <>
            <span
              className={`absolute -bottom-16 h-72 w-72 rounded-full bg-accent/15 blur-3xl ${
                glowOnRight ? '-right-12' : '-left-12'
              }`}
            />
            {/* 频道 ident:有台标时用 CSS background 放大(不新增 img 节点);无台标回落频道名水印。 */}
            {row.media.posterRef === null ? (
              <span className="pointer-events-none absolute inset-0 flex items-center justify-center overflow-hidden px-8">
                <span className="hmp-truncate max-w-full text-center text-5xl font-bold tracking-tight text-foreground/10 md:text-7xl">
                  {channelTitle}
                </span>
              </span>
            ) : (
              <span
                className="pointer-events-none absolute inset-0 bg-no-repeat opacity-60"
                style={{
                  backgroundImage: `url(/api/public/media/logos/${encodeURIComponent(row.media.posterRef)})`,
                  backgroundSize: 'min(18%, 11rem) auto',
                  backgroundPosition: '80% 35%',
                }}
              />
            )}
          </>
        )}
        {/* 压暗层:底部为主、左侧为辅,保证叠加文字在任意剧照上都有对比度 */}
        <span className="absolute inset-0 bg-gradient-to-t from-background/95 via-background/40 to-background/10" />
        <span className="absolute inset-0 bg-gradient-to-r from-background/80 via-background/20 to-transparent" />
      </div>

      {/* 内容层:Header(直播状态 + 频道身份 + 静音)与 Footer(节目/进度/预告/操作)。 */}
      <div className="relative z-10 flex min-h-[17rem] flex-col justify-between gap-6 p-2 md:min-h-[17.5rem]">
        <div className="flex items-start justify-between gap-3">
          <span
            data-testid="live-hero-live-badge"
            className="inline-flex items-center gap-1.5 rounded bg-background/70 px-2 py-1 text-xs text-foreground backdrop-blur-sm"
          >
            <span aria-hidden="true" className="size-2 rounded-full bg-success" />
            正在直播
          </span>
          <div className="flex items-center gap-2">
            <ChannelIdentityBadge
              key={row.media.posterRef ?? 'no-logo'}
              posterRef={row.media.posterRef}
              channelTitle={channelTitle}
              size="md"
            />
            <Button
              isIconOnly
              size="sm"
              variant="ghost"
              data-testid="live-hero-mute"
              aria-pressed={mutedIntent}
              aria-label={mutedIntent ? '取消静音' : '静音'}
              className="bg-background/70 backdrop-blur-sm"
              onPress={() => {
                setMutedIntent((previous) => !previous);
              }}
            >
              {mutedIntent ? (
                <VolumeX aria-hidden="true" className="size-4" />
              ) : (
                <Volume2 aria-hidden="true" className="size-4" />
              )}
            </Button>
          </div>
        </div>

        <div className="flex min-w-0 flex-col gap-2.5">
          {/* 分组 · 频道(身份行,替代旧「分组 · 此刻直播」) */}
          <p className="text-xs font-medium text-foreground/70">
            {row.groupLabel} · {channelTitle}
          </p>

          <h2
            className="line-clamp-2 text-2xl font-bold leading-tight text-foreground md:text-3xl"
            title={current?.title ?? undefined}
          >
            {current !== null ? current.title : '暂无节目单'}
          </h2>

          {scheduleLabel !== null ? (
            <p className="hmp-tabular-nums text-sm text-foreground/75">{scheduleLabel}</p>
          ) : null}

          {progress !== null ? (
            <div className="flex w-full max-w-sm flex-col gap-1.5">
              <span className="hmp-tabular-nums self-end text-xs text-foreground/80">{progressLabel}</span>
              <ProgressBar aria-label="节目播放进度" value={progressPercent} size="sm" color="accent">
                <ProgressBar.Track>
                  <ProgressBar.Fill />
                </ProgressBar.Track>
              </ProgressBar>
            </div>
          ) : null}

          <div className="flex flex-wrap items-end justify-between gap-3 border-t border-border/30 pt-3">
            {row.next !== null ? (
              <Button
                variant="ghost"
                size="sm"
                className="h-auto min-w-0 justify-start px-0 py-0.5 text-left text-xs font-normal text-foreground/70"
                onPress={() => {
                  onOpenProgramme({
                    mediaId: row.media.id,
                    channelTitle,
                    groupLabel: row.groupLabel,
                    programme: row.next,
                    kind: 'upcoming',
                  });
                }}
              >
                <span className="hmp-truncate min-w-0">
                  接下来 {formatTimeInZone(row.next.startsAt, timezone)} · {row.next.title}
                </span>
              </Button>
            ) : <span />}

            <div className="flex flex-wrap items-center gap-2">
              {guestPresentation ? (
                <Button
                  size="md"
                  variant="primary"
                  aria-label={`直接收看 ${channelTitle}`}
                  onPress={startPlayback}
                >
                  <Play aria-hidden="true" className="size-4 fill-current" />
                  直接收看
                </Button>
              ) : (
                <Button
                  size="md"
                  variant="outline"
                  aria-label={`全屏观看 ${channelTitle}`}
                  onPress={startPlayback}
                >
                  <Play aria-hidden="true" className="size-4 fill-current" />
                  全屏观看
                </Button>
              )}
              <Button
                size="md"
                variant="ghost"
                aria-label={`节目详情 ${channelTitle}`}
                onPress={() => {
                  onOpenProgramme({
                    mediaId: row.media.id,
                    channelTitle,
                    groupLabel: row.groupLabel,
                    programme: current,
                    kind: 'current',
                  });
                }}
              >
                <Info aria-hidden="true" className="size-4" />
                节目详情
              </Button>
            </div>
          </div>
        </div>
      </div>
    </Card>
  );
}