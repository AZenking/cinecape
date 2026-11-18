import type { ReactNode } from 'react';
import { Button, Card, Chip, ProgressBar, Tooltip } from '@heroui/react';
import { Bell } from 'lucide-react';
import type { ChannelRowDto, ExperienceProgrammeDto } from '@hmp/shared';
import { usePlayAction } from '../../playback/use-play-action';
import { useCurrentProgramme } from '../hooks/use-current-programme';
import { useProgrammeReminder } from '../hooks/use-programme-reminder';
import { ChannelLogo } from './channel-logo';
import { ProgrammePoster } from '../../shared-programme/programme-poster';
import { formatRangeInZone, formatTimeInZone } from '../live-format';

/**
 * 直播频道瓦片卡(Netflix 式 16:9 瓦片;T069/T070/T071 演进,FR-021/023/024):
 *
 * - 容器 = HeroUI v3 `Card`(唯一外壳;`render={<article />}` 保留 role=article,
 *   信息区用 Card.Header/Card.Content);Card 追加 p-0/overflow-hidden 让海报通栏。
 * - 2026-11-18 设计稿调整:节目有海报时优先用 16:9 节目剧照铺满底板,无海报才回退
 *   频道标识渐变底板;左上角频道台标、右上角状态角标(正在直播=直播 / 即将播放=
 *   开播时刻);信息区第一行频道名(+ 当前档时段),第二行节目名;即将播放卡在
 *   节目名右侧提供开播提醒铃铛。
 * - 台标回退链:posterRef 非空 → ChannelLogo(加载中/失败回退首字);null → 频道名。
 * - 播放入口:整块 16:9 底板是透明热区(current=播放;upcoming=节目详情);信息区
 *   节目名仍按档位分流,current 起播、upcoming 打开共享详情面板(FR-024)。
 * - 无节目频道显示「暂无节目单」占位,播放入口保留(FR-023)。
 * - 开播提醒见 useProgrammeReminder(页面会话内提醒,不承诺站外推送)。
*/

/**
 * 节目时段详情回调载荷(即将播放/当前节目共用;打开频道/节目信息):
 * programme 为 null 表示无节目单频道(current/next 双 null,FR-012/T018)——
 * 宿主按 none 态打开共享详情面板。
 */
export interface ProgrammeOpenDetail {
  readonly mediaId: string;
  readonly channelTitle: string;
  readonly groupLabel: string;
  readonly programme: ExperienceProgrammeDto | null;
  readonly kind: 'current' | 'upcoming';
  /** 频道台标不透明引用(详情页/播放浮层回退用) */
  readonly channelPosterRef?: string | null;
}

export type OpenProgrammeHandler = (input: ProgrammeOpenDetail) => void;

/** 首页/分类横滑行统一卡片宽度(1519 宽一屏 6 张,分类行与直播行同尺寸) */
export const LIVE_TILE_WIDTH_CLASS = 'w-[13rem] shrink-0 snap-start sm:w-[14rem] lg:w-[14.4rem]';

/** 卡片承载的节目档位:current=当前节目(正在直播类分区);upcoming=下一档节目(即将播放分区) */
export type TileSlot = 'current' | 'upcoming';

export interface ChannelTileProps {
  readonly row: ChannelRowDto;
  /** 卡片承载的节目档位(缺省 current):决定信息区节目名与详情面板 kind */
  readonly slot?: TileSlot;
  /**
   * 服务端快照 now(016 T010 起仅作入参兼容保留,分区宿主仍传)。
   * 卡面进度已升级为 useCurrentProgramme 智能时钟,进度与到点翻转按本地时钟推进,
   * 服务端快照真值由 30s 周期刷新收敛。
   */
  readonly nowIso: string | null;
  /**
   * 家庭时区(分区响应携带):信息区展示该节目时段/开播时刻。
   * 缺省(单元测试直接挂载/无时区数据)时不渲染时间标签,只保留频道名与节目名。
   */
  readonly timezone?: string;
  /** 节目时段详情回调(即将播放/当前节目共用;打开频道/节目信息) */
  readonly onOpenProgramme: OpenProgrammeHandler;
  /** @deprecated 2026-11-14 瓦片不再提供收藏入口;保留仅为宿主兼容,将被移除 */
  readonly onRequireAuth?: (actionLabel: string) => void;
}

/** djb2 散列:底板渐变角度与光斑位置由稳定 id 派生(伪随机但跨刷新不变) */
function hashOf(key: string): number {
  let hash = 5381;
  for (let index = 0; index < key.length; index += 1) {
    hash = ((hash << 5) + hash + key.charCodeAt(index)) | 0;
  }
  return Math.abs(hash);
}

/**
 * 当前节目进度 0..1(以服务端快照 now 计;无 now/区间无效/时刻解析失败返回 null)。
 * 导出供 LiveHeroPlayer 大屏复用(012 T017:FR-010 六信息之「进度」,同一快照语义)。
 */
export function progressOf(startsAt: string, endsAt: string, nowIso: string | null): number | null {
  if (nowIso === null) {
    return null;
  }
  const start = Date.parse(startsAt);
  const end = Date.parse(endsAt);
  const now = Date.parse(nowIso);
  if (!Number.isFinite(start) || !Number.isFinite(end) || !Number.isFinite(now) || end <= start) {
    return null;
  }
  return Math.min(1, Math.max(0, (now - start) / (end - start)));
}

export function ChannelTile({ row, slot = 'current', timezone, onOpenProgramme }: ChannelTileProps): ReactNode {
  const channelTitle = row.media.title;
  // 统一播放入口(US3):整块底板即播放热区,不渲染可见按钮
  const { play } = usePlayAction();
  // 智能事件定时器:15s 本地 tick 平滑推进、到点本地翻转(零网络)
  const programme = useCurrentProgramme({ initialCurrent: row.current, initialNext: row.next });
  /** 智能时钟下的当前节目(到点本地翻转;空档 → null,信息区「暂无节目单」降级) */
  const liveCurrent = programme.current;
  /** 本卡承载的节目(档位决定:current=智能时钟当前节目,upcoming=下一档;双缺时走「暂无节目单」占位) */
  const slotProgramme: ExperienceProgrammeDto | null = slot === 'upcoming' ? row.next : liveCurrent;
  /**
   * 信息区时段标签(家庭时区):current 档 = 起止区间;upcoming 档 = 开播时刻。
   * 无时区数据/无节目时省略,不臆造本地时间(与 Hero/分区时间语义一致)。
   */
  const timeLabel =
    slotProgramme === null || timezone === undefined
      ? null
      : slot === 'upcoming'
        ? `${formatTimeInZone(slotProgramme.startsAt, timezone)} 开始`
        : formatRangeInZone(slotProgramme.startsAt, slotProgramme.endsAt, timezone);
  const reminder = useProgrammeReminder(
    slot === 'upcoming' ? (slotProgramme?.key ?? null) : null,
    slotProgramme?.title ?? channelTitle,
    slotProgramme?.startsAt ?? null,
  );
  const hash = hashOf(row.media.id);
  const plateAngle = 100 + (hash % 140);
  const glowOnRight = hash % 2 === 1;
  const posterRef = slotProgramme?.posterRef ?? null;

  return (
    // HeroUI v3 Card 作为唯一容器;p-0/overflow-hidden 让海报通栏,圆角/阴影走原生样式。
    // render 成 <article> 保留可访问语义(role=article)与既有查询契约。
    <Card<"article">
      render={(props) => <article {...props} />}
      className="group min-w-0 gap-0 overflow-hidden p-0"
      aria-label={`频道 ${channelTitle}`}
    >
      {/* 16:9 底板:有节目海报用剧照铺满,无海报回退频道标识渐变底板(装饰层 aria-hidden) */}
      <div
        className="relative aspect-video w-full overflow-hidden bg-surface-secondary"
        style={posterRef === null
          ? { background: `linear-gradient(${plateAngle}deg, var(--surface-secondary) 0%, var(--surface-tertiary) 55%, var(--surface) 100%)` }
          : undefined}
      >
        {posterRef !== null ? (
          <ProgrammePoster
            posterRef={posterRef}
            title={slotProgramme?.title ?? channelTitle}
            className="pointer-events-none absolute inset-0 h-full w-full object-cover"
          />
        ) : (
          <>
            <span
              aria-hidden="true"
              className={`absolute -bottom-12 h-36 w-36 rounded-full bg-accent/15 blur-3xl transition duration-300 group-hover:bg-accent/25 ${
                glowOnRight ? '-right-8' : '-left-8'
              }`}
            />
            {/* 无节目海报回退:居中放大的频道台标(与左上角身份台标同源,低透明度作底板水印)。
                用 CSS background 而非第二个 <img>,避免同一卡片出现两条台标加载相位。 */}
            {row.media.posterRef !== null ? (
              <span
                aria-hidden="true"
                className="pointer-events-none absolute inset-0 bg-contain bg-center bg-no-repeat opacity-15"
                style={{
                  backgroundImage: `url(/api/public/media/logos/${encodeURIComponent(row.media.posterRef)})`,
                }}
              />
            ) : (
              <span
                aria-hidden="true"
                className="pointer-events-none absolute inset-0 flex items-center justify-center px-6"
              >
                <span className="hmp-truncate max-w-full text-center text-2xl font-bold tracking-tight text-foreground/10">
                  {channelTitle}
                </span>
              </span>
            )}
          </>
        )}

        {/* 顶部压暗层:保证台标与状态角标在任意剧照上可读(装饰) */}
        <span
          aria-hidden="true"
          className="pointer-events-none absolute inset-x-0 top-0 h-1/2 bg-gradient-to-b from-background/55 to-transparent"
        />

        {/* 左上角频道台标(2026-11-18:按设计稿直接叠在剧照上,不加衬底) */}
        <div
          data-testid="tile-logo"
          className="pointer-events-none absolute left-3 top-2.5 z-[1] flex h-9 w-24 items-center justify-start drop-shadow-lg"
        >
          {row.media.posterRef !== null ? (
            <div className="relative h-full w-full">
              <ChannelLogo
                key={row.media.posterRef}
                posterRef={row.media.posterRef}
                channelTitle={channelTitle}
                fallbackClassName="text-xs font-semibold text-foreground"
              />
            </div>
          ) : (
            <span
              data-testid="tile-logo-fallback"
              className="line-clamp-2 text-xs font-semibold leading-tight text-foreground"
            >
              {channelTitle}
            </span>
          )}
        </div>

        {/* 右上角状态角标:正在直播=「直播」;即将播放=开播时刻(与分区语义一致) */}
        <Chip
          size="sm"
          variant="soft"
          className="pointer-events-none absolute right-2.5 top-2.5 z-[1] bg-surface-tertiary/90 text-xs text-foreground backdrop-blur-sm"
        >
          {slot === 'upcoming' ? (timeLabel ?? '即将开始') : '直播'}
        </Chip>

        {/* 整块 16:9 底板是卡片的主点击区(无可见按钮/图标):
            current=播放该频道当前直播;upcoming=打开节目详情(未来节目不直接播放)。 */}
        <button
          type="button"
          aria-label={slot === 'upcoming' ? `查看 ${channelTitle} 节目详情` : `播放 ${channelTitle}`}
          className="absolute inset-0 z-10 cursor-pointer focus:outline-none focus-visible:ring-2 focus-visible:ring-focus"
          onClick={() => {
            if (slot === 'upcoming') {
              onOpenProgramme({
                mediaId: row.media.id,
                channelTitle,
                groupLabel: row.groupLabel,
                programme: row.next,
                kind: 'upcoming',
                channelPosterRef: row.media.posterRef,
              });
              return;
            }
            play({ mediaId: row.media.id, title: channelTitle, startMode: 'beginning', posterRef: row.media.posterRef });
          }}
        />

        {/* 当前节目进度微条(恢复 016 T010 的卡面进度):智能时钟 15s 平滑推进,
            current=null 时整条隐藏;覆盖在底板下沿,不拦截底板播放入口。 */}
        {slot === 'current' && liveCurrent !== null ? (
          <ProgressBar
            aria-label="节目播放进度"
            value={programme.progressPercent}
            size="sm"
            color="accent"
            className="pointer-events-none absolute inset-x-0 bottom-0 z-[2]"
          >
            <ProgressBar.Track>
              <ProgressBar.Fill />
            </ProgressBar.Track>
          </ProgressBar>
        ) : null}
      </div>

      {/* 信息区(按 HeroUI Card 解剖):Header 承载「频道名 + 时段」,
          Content 承载节目名(可交互按钮)+ 即将播放的开播提醒铃铛。 */}
      <Card.Header className="min-w-0 gap-0 p-3 pb-1.5">
        <div className="flex min-w-0 items-baseline justify-between gap-2">
          <span className="hmp-truncate text-xs font-medium text-foreground/80">{channelTitle}</span>
          {slot === 'current' && timeLabel !== null ? (
            <span className="hmp-tabular-nums shrink-0 text-xs text-muted">{timeLabel}</span>
          ) : null}
        </div>
      </Card.Header>
      <Card.Content className="min-w-0 p-3 pt-0">
        <div className="flex min-w-0 items-end justify-between gap-2">
          {slotProgramme !== null ? (
            <Card.Title className="min-w-0 text-sm font-semibold leading-snug">
              <Tooltip>
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-auto min-h-11 w-full min-w-0 justify-start whitespace-normal px-0 py-0.5 text-left text-sm font-semibold leading-snug"
                  onPress={() => {
                    // 节目名点击统一交给宿主裁决:now → 直接播放;非直播 → 详情页
                    onOpenProgramme({
                      mediaId: row.media.id,
                      channelTitle,
                      groupLabel: row.groupLabel,
                      programme: slotProgramme,
                      kind: slot === 'upcoming' ? 'upcoming' : 'current',
                      channelPosterRef: row.media.posterRef,
                    });
                  }}
                >
                  <span className="line-clamp-2">{slotProgramme.title}</span>
                </Button>
                <Tooltip.Content>{slotProgramme.title}</Tooltip.Content>
              </Tooltip>
            </Card.Title>
          ) : (
            /* 无节目占位可点开共享详情面板(none 态:保留频道身份 +「暂无节目单」,
               主操作仍可播放当前直播,FR-012/012 T018;焦点环同相邻节目按钮) */
            <button
              type="button"
              data-testid="no-programme"
              className="block min-h-11 w-full min-w-0 rounded-sm p-1 text-left focus:outline-none focus-visible:ring-2 focus-visible:ring-focus"
              onClick={(event) => {
                event.preventDefault();
                onOpenProgramme({
                  mediaId: row.media.id,
                  channelTitle,
                  groupLabel: row.groupLabel,
                  programme: null,
                  kind: 'current',
                  channelPosterRef: row.media.posterRef,
                });
              }}
            >
              <span className="block text-sm text-muted">暂无节目单</span>
            </button>
          )}

          {slot === 'upcoming' && slotProgramme !== null ? (
            <Button
              isIconOnly
              size="sm"
              variant="ghost"
              aria-pressed={reminder.reminded}
              aria-label={reminder.reminded ? `取消《${slotProgramme.title}》开播提醒` : `预约《${slotProgramme.title}》开播提醒`}
              className={`shrink-0 ${reminder.reminded ? 'text-accent' : 'text-muted'}`}
              onPress={reminder.toggle}
            >
              <Bell aria-hidden="true" className={`size-4 ${reminder.reminded ? 'fill-current' : ''}`} />
            </Button>
          ) : null}
        </div>
      </Card.Content>
    </Card>
  );
}