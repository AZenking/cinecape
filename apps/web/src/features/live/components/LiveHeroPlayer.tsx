import { useState } from 'react';
import type { ReactNode } from 'react';
import { Button, ProgressBar } from '@heroui/react';
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
 *   页面保持可交互;
 * - 布局(2026-11-13 修订,宽视口通栏大屏高度失控):md 及以上「左侧舞台（基础 16:9，随信息栏高度拉伸）+ 右
 *   20~22rem 信息栏」,更窄视口舞台在上、信息面板在下。舞台 = token 渐变 + 光斑 + 频道
 *   台标 ident(有 posterRef 用 CSS background,无台标回落频道名水印(加载失败由右上角身份角标兜底)),不再
 *   依赖节目海报也有一眼可辨的频道身份;信息栏承载节目/时段/进度/操作,总高度
 *   约 480px 封顶,保证「正在直播」与首行卡片进入首屏;
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
 * - 信息栏:分组·此刻直播 → 当前节目(h2)→ 频道·档期(家庭时区)→ 本档进度
 *   (文字百分比 + HeroUI ProgressBar;进度以服务端快照 nowIso 计算,不臆造本地
 *   时钟)→ 接下来预告(打开节目详情)→ 主/次操作;
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
    play({ mediaId: row.media.id, title: channelTitle, startMode: 'beginning', posterRef: row.media.posterRef });
  };

  /** 信息栏元数据:频道 · 档期 · 进度(无节目单频道不臆造时间,只保留频道身份) */
  const scheduleLabel =
    current !== null ? formatRangeInZone(current.startsAt, current.endsAt, timezone) : null;
  const progressLabel =
    progress !== null ? `已播出 ${Math.round(progress * 100)}%` : null;
  const metaText = [channelTitle, scheduleLabel]
    .filter((part): part is string => part !== null && part !== '')
    .join(' · ');
  const progressPercent = progress !== null ? Math.round(progress * 100) : 0;

  return (
    <section
      aria-label="直播精选大屏"
      data-testid="live-hero-player"
      className="min-w-0"
    >
      {/* 2026-11-13 布局修订:通栏 16:9 大屏在宽视口下高度失控(1440 宽约 780px),
          且无节目海报时整屏只剩渐变。改为「左侧 16:9 舞台 + 右侧信息栏」——
          舞台负责频道身份与直播氛围,信息栏承载节目/时段/进度/操作;总高度由
          舞台宽度自然收敛(约 480px 封顶),「正在直播」首屏可见。移动端仍为
          舞台在上、信息面板在下,保持 16:9 语义。 */}
      <div className="grid overflow-hidden rounded-xl border border-border bg-surface md:grid-cols-[minmax(0,1fr)_20rem] lg:grid-cols-[minmax(0,1fr)_22rem]">
        <div
          data-testid="live-hero-stage"
          className="relative aspect-video max-h-[30rem] w-full overflow-hidden bg-surface-secondary"
          style={{ background: `linear-gradient(${plateAngle}deg, var(--surface-secondary) 0%, var(--surface-tertiary) 55%, var(--surface) 100%)` }}
        >
          {/* 舞台艺术层(token 渐变 + 光斑;装饰节点 aria-hidden,同瓦片卡表达) */}
          <span
            aria-hidden="true"
            className={`absolute -bottom-16 h-72 w-72 rounded-full bg-accent/15 blur-3xl ${
              glowOnRight ? '-right-12' : '-left-12'
            }`}
          />
          {/* 舞台身份锚点:有台标时用 CSS background 放大为「频道 ident」,失败/无台标
              时回落频道名水印 —— 两种情况都不再是一整块空渐变。用 background 而非
              <img>,不新增图片节点/裂图占位,也不影响角标的加载相位与测试断言。 */}
          {row.media.posterRef === null ? (
            <span
              aria-hidden="true"
              className="pointer-events-none absolute inset-0 flex items-center justify-center overflow-hidden px-8"
            >
              <span className="hmp-truncate max-w-full text-center text-5xl font-bold tracking-tight text-foreground/10 md:text-7xl">
                {channelTitle}
              </span>
            </span>
          ) : null}
          {row.media.posterRef !== null ? (
            <span
              aria-hidden="true"
              className="pointer-events-none absolute inset-0 bg-center bg-no-repeat opacity-80"
              style={{
                backgroundImage: `url(/api/public/media/logos/${encodeURIComponent(row.media.posterRef)})`,
                backgroundSize: 'min(38%, 18rem) auto',
              }}
            />
          ) : null}

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

          {/* 底部压暗层:只为进度线过渡,不再承载信息层(信息已移至右侧面板) */}
          <span
            aria-hidden="true"
            className="absolute inset-x-0 bottom-0 h-24 bg-gradient-to-t from-background/45 to-transparent"
          />

          {/* 当前节目进度线(红 = 直播/时间线;只描述服务端快照,不臆测本地时钟) */}
          {progress !== null ? (
            <span aria-hidden="true" className="absolute bottom-0 left-0 h-0.5 w-full bg-background/40">
              <span className="block h-full bg-accent" style={{ width: `${Math.round(progress * 100)}%` }} />
            </span>
          ) : null}
        </div>

        {/* 信息栏:分组 → 节目主标题 → 频道/档期/进度 → 接下来 → 主次操作。
            窄屏置于舞台下方,宽屏作为右栏与舞台等高;操作区 mt-auto 底部对齐。 */}
        <div className="flex min-w-0 flex-col justify-center gap-4 border-t border-border p-5 md:border-l md:border-t-0 md:p-5 lg:p-6">
          <p className="text-xs font-medium text-accent">{row.groupLabel} · 此刻直播</p>

          <div className="min-w-0">
            <h2
              className="line-clamp-3 text-2xl font-bold leading-tight text-foreground"
              title={current?.title ?? undefined}
            >
              {current !== null ? current.title : '暂无节目单'}
            </h2>
            <p className="mt-2 hmp-tabular-nums text-sm leading-relaxed text-muted">{metaText}</p>
          </div>

          {/* 进度从大屏底边细线升级为信息栏可读进度:文字百分比 + HeroUI ProgressBar,
              与卡片同一语义(直播时间线,非仅颜色)。无节目单频道整块隐藏。 */}
          {progress !== null ? (
            <div className="flex flex-col gap-1.5">
              <div className="flex items-baseline justify-between gap-3 text-xs">
                <span className="text-muted">本档进度</span>
                <span className="hmp-tabular-nums text-foreground/80">{progressLabel}</span>
              </div>
              <ProgressBar aria-label="节目播放进度" value={progressPercent} size="sm" color="accent">
                <ProgressBar.Track>
                  <ProgressBar.Fill />
                </ProgressBar.Track>
              </ProgressBar>
            </div>
          ) : null}

          <div className="flex flex-col gap-2.5 border-t border-border/60 pt-4">
            {row.next !== null ? (
              <Button
                variant="ghost"
                size="sm"
                className="h-auto min-w-0 justify-start px-0 py-0.5 text-left text-xs font-normal text-muted"
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
        </div>
      </div>
    </section>
  );
}
