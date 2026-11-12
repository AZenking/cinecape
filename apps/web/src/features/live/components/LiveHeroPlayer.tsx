import { useState } from 'react';
import type { ReactNode } from 'react';
import { Button } from '@heroui/react';
import { Info, Play, Volume2, VolumeX } from 'lucide-react';
import type { ChannelRowDto } from '@hmp/shared';
import { usePlayAction } from '../../playback/use-play-action';
import { useSession } from '../../../app/session-provider';
import { formatRangeInZone, formatTimeInZone } from '../live-format';
import { ChannelIdentityBadge } from './channel-identity-badge';
import { progressOf, type OpenProgrammeHandler } from './ChannelTile';

/**
 * 直播首页顶部【直接播放】大屏(015 T008;FR-002、FR-014;research.md R2、
 * contracts/ui-layout.md §1.1/§1.2——替代 012 NowHero 静态横幅,spec 出处
 * spec.md US1 验收场景 1「顶部大屏区域作为直接播放核心,无需跳转即可直接收看」):
 *
 * - 播放架构硬约束:本组件**不内嵌任何播放器实例**,不建第二条播放管线 ——
 *   主操作「全屏播放」一律经 usePlayAction().play() 发起,ActionCoordinator 统一
 *   authorize/prepare,全局播放面(playback-surface 浮层 + PlayerView)随即浮现,
 *   页面保持可交互;Hero 自身是 16:9 语义 token 舞台(token 渐变 + 光斑,同
 *   ChannelTile 底板表达;渐变角度/光斑位置由稳定 media.id 散列决定,跨刷新不闪变);
 * - 静音开关(默认静音意图,R2「静音起播免打扰」):**意图状态**——全局播放面
 *   PlayerView/ActionCoordinator 当前未暴露 muted/音量 API(实查 player-view.tsx
 *   PlayerViewProps 无音量属性,action-coordinator PlayActionRequest 仅
 *   mediaId/title/startMode),故本开关仅承载本地意图并随语义标注翻转,不臆造 API;
 *   待播放面提供音量控制后在此接线(注释留档);
 * - 游客/未选档呈现形态分流(presentation only):高保真预览海报(ChannelIdentityBadge
 *   的 posterRef Logo 链路)+「直接收看」醒目主操作。**播放行为零登录自判**——
 *   无论会话状态,主操作一律直接 play(),由 ActionCoordinator 统一拦截进登录选档
 *   意图、授权前零媒体流请求(FR-014;与 ChannelTile 收藏按钮的会话分流同先例);
 * - 频道选择沿用 NowHero 语义:now 区服务端稳定排序首频道(宿主 LivePage 传入,
 *   不引入虚构热度/推荐算法);无节目单频道(current=null)保留频道身份与播放入口,
 *   节目标题位显示「暂无节目单」(FR-023 可用性不由 EPG 决定);
 * - 信息层:分组·此刻直播 → 当前节目(h2)→ 频道·档期(家庭时区)·已播出 N%
 *   (进度以服务端快照 nowIso 计算,不臆造本地时钟)→ 接下来预告(打开节目详情);
 * - [ℹ️ 节目详情] 次操作走既有 ProgrammeDetailPanel 回调链(kind='current',
 *   宿主 panelStatusOf 裁决 now/ended/none);
 * - 加载/无数据态优雅降级:row/数据未就绪由宿主(LivePage)不渲染 Hero(隐藏降级,
 *   页面其余分区照常,不白屏);row 缺 current 时舞台照常渲染(见上);
 * - 语义:region 可读名「直播精选大屏」与三分区 region 名(正在直播/即将播放/
 *   各分类正在直播)互不为子串,避免分区断言互相命中;
 * - 经 HeroUI v3(Button onPress/isIconOnly;文档:.heroui-docs/react
 *   components/(buttons)/button.mdx,3.2.6);样式只用语义 token,禁硬编码颜色。
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
  // 统一播放入口(US3;015 硬约束):全屏播放/直接收看同源消费,零第二播放器实例
  const { play } = usePlayAction();
  // 游客/未选档呈现形态(presentation only;播放行为不随会话分流,见组件头注)
  const session = useSession();
  const guestPresentation =
    session.status !== 'authenticated' || session.session?.activeProfile == null;
  // 静音意图(默认静音免打扰;全局播放面暂无音量 API,仅本地意图状态,见头注)
  const [mutedIntent, setMutedIntent] = useState(true);
  const hash = hashOf(row.media.id);
  const plateAngle = 100 + (hash % 140);
  const glowOnRight = hash % 2 === 1;
  const progress = current !== null ? progressOf(current.startsAt, current.endsAt, nowIso) : null;

  /** 主操作:全屏播放/直接收看 —— 一律直接 play(),登录拦截归 ActionCoordinator */
  const startPlayback = (): void => {
    play({ mediaId: row.media.id, title: channelTitle, startMode: 'beginning' });
  };

  return (
    <section
      aria-label="直播精选大屏"
      data-testid="live-hero-player"
      className="min-w-0"
    >
      <div
        data-testid="live-hero-stage"
        className="relative aspect-video w-full overflow-hidden rounded-xl border border-border bg-surface-secondary"
        style={{ background: `linear-gradient(${plateAngle}deg, var(--surface-secondary) 0%, var(--surface-tertiary) 55%, var(--surface) 100%)` }}
      >
        {/* 舞台艺术层(token 渐变 + 光斑;装饰节点 aria-hidden,同瓦片卡表达) */}
        <span
          aria-hidden="true"
          className={`absolute -bottom-16 h-72 w-72 rounded-full bg-accent/15 blur-3xl ${
            glowOnRight ? '-right-12' : '-left-12'
          }`}
        />
        {/* 频道身份角标(014 呈现修订;posterRef=高保真预览海报链路,右上位与状态签对称) */}
        <ChannelIdentityBadge
          key={row.media.posterRef ?? 'no-logo'}
          posterRef={row.media.posterRef}
          channelTitle={channelTitle}
          className="absolute right-4 top-4 md:right-6 md:top-6"
        />

        {/* LIVE 语义标注:文字 + 状态点(状态不只靠颜色),取代静态横幅语义 */}
        <span
          data-testid="live-hero-live-badge"
          className="absolute left-4 top-4 inline-flex items-center gap-1.5 rounded bg-background/75 px-2 py-1 text-xs text-foreground backdrop-blur-sm md:left-6 md:top-6"
        >
          <span aria-hidden="true" className="size-2 rounded-full bg-accent" />
          正在直播
        </span>

        {/* 静音切换(默认静音意图;意图状态——播放面暂无音量 API,见组件头注) */}
        <Button
          isIconOnly
          size="sm"
          variant="ghost"
          data-testid="live-hero-mute"
          aria-pressed={mutedIntent}
          aria-label={mutedIntent ? '取消静音' : '静音'}
          className="absolute right-4 top-16 z-10 bg-background/70 backdrop-blur-sm md:right-6 md:top-20"
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

        {/* 底部护读 scrim + 信息层(同 NowHero 信息结构,升级为直接播放舞台) */}
        <span aria-hidden="true" className="absolute inset-0 bg-gradient-to-t from-surface via-surface/60 to-transparent" />
        <div className="absolute inset-x-0 bottom-0 flex min-w-0 flex-col gap-1.5 p-5 md:p-8">
          <p className="text-xs font-medium text-accent">{row.groupLabel} · 此刻直播</p>
          <h2 className="hmp-truncate text-2xl font-bold text-foreground md:text-4xl" title={current?.title ?? undefined}>
            {current !== null ? current.title : '暂无节目单'}
          </h2>
          <p className="hmp-tabular-nums text-sm text-muted">
            {channelTitle}
            {/* 档期/进度仅在节目存在时表达(无节目单频道不臆造时间) */}
            {current !== null
              ? ` · ${formatRangeInZone(current.startsAt, current.endsAt, timezone)}${
                  progress !== null ? ` · 已播出 ${Math.round(progress * 100)}%` : ''
                }`
              : ''}
          </p>
          {row.next !== null ? (
            <Button
              variant="ghost"
              size="sm"
              className="h-auto min-w-0 self-start px-1 py-0.5 justify-start text-xs font-normal text-muted"
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
              <span className="hmp-truncate min-w-0">接下来:{row.next.title} · {formatTimeInZone(row.next.startsAt, timezone)} 开始</span>
            </Button>
          ) : null}

          {/* 操作层:主操作(全屏播放/直接收看;游客零登录自判,统一拦截)+ 次操作(节目详情) */}
          <div className="mt-2 flex flex-wrap items-center gap-2">
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
                variant="primary"
                aria-label={`全屏播放 ${channelTitle}`}
                onPress={startPlayback}
              >
                <Play aria-hidden="true" className="size-4 fill-current" />
                全屏播放
              </Button>
            )}
            <Button
              size="md"
              variant="outline"
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

        {/* 当前节目进度线(红 = 直播/时间线;只描述服务端快照,不臆测本地时钟) */}
        {progress !== null ? (
          <span aria-hidden="true" className="absolute bottom-0 left-0 h-0.5 w-full bg-background/40">
            <span className="block h-full bg-accent" style={{ width: `${Math.round(progress * 100)}%` }} />
          </span>
        ) : null}
      </div>
    </section>
  );
}
