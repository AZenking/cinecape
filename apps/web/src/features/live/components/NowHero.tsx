import type { ReactNode } from 'react';
import type { ChannelRowDto } from '@hmp/shared';
import type { ExperienceProgrammeDto } from '@hmp/shared';
import { formatRangeInZone, formatTimeInZone } from '../live-format';
import { PlayButton } from '../../playback/use-play-action';
import { progressOf, type OpenProgrammeHandler } from './ChannelTile';

/**
 * 此刻直播精选横幅(T067 布局演进;Netflix 式 Billboard,克制版;012 T017 FR-010 六信息):
 * - 精选对象 = 正在直播区按服务端稳定排序(A-007)的首个频道当前节目,
 *   不引入虚构热度/推荐算法(frontend-home-live-epg-design.md §3.4 同一原则);
 * - FR-010 六信息齐备:频道标识(频道名信息层)、当前节目(标题)、直播状态
 *   (「正在直播」文字 + 状态点,非仅颜色)、进度(底部进度线 + 「已播出 N%」文字,
 *   以服务端快照 nowIso 计算,无 now 不画进度不臆造本地时钟)、起止时间(家庭时区)、
 *   「播放」主按钮;语义为直播状态横幅,非点播宣传位(无票价/预约/促销文案);
 * - 交互与瓦片卡同源:点击「接下来」节目行打开共享节目详情面板(FR-013/FR-024),
 *   播放经 US3 统一入口(PlayButton,播放该频道当前直播),不自动轮播/背景自动播放;
 * - 语义刻意保持「哑」:section 可读名「此刻直播精选」与四个分区 region 名
 *   (所有节目单入口/正在直播/即将播放/各分组正在直播)互不为子串,标题用 h2
 *   (内容为节目名,不与分区标题断言冲突),内部不用 article/region ——
 *   e2e「分区顺序 + 正在直播区卡片标题 100% 一致(SC-005)」只统计正直播区本体;
 * - 数据未就绪/首频道无当前节目时整体不渲染;刷新后随 now 区一起换新(旧文案即消失)。
 */

export interface NowHeroProps {
  readonly row: ChannelRowDto;
  /** 服务端同步快照时区(家庭时区标注与换算唯一依据) */
  readonly timezone: string;
  /** 服务端快照 now(计算当前节目进度线;缺省/无效时不画进度,不臆造本地时钟) */
  readonly nowIso: string | null;
  /** 「接下来」节目行:打开节目时段详情(与瓦片卡同一回调载荷) */
  readonly onOpenProgramme: OpenProgrammeHandler;
}

export function NowHero({ row, timezone, nowIso, onOpenProgramme }: NowHeroProps): ReactNode {
  const current = row.current;
  if (current === null) {
    return null;
  }
  const channelTitle = row.media.title;
  const progress = progressOf(current.startsAt, current.endsAt, nowIso);
  return (
    <section
      aria-label="此刻直播精选"
      className="relative overflow-hidden rounded-xl border border-border bg-surface-secondary"
    >
      <div className="relative h-[280px] w-full md:h-[340px]">
        {/* 底板艺术层(与瓦片卡同一表达:token 渐变 + 频道首字 + 红色光斑;装饰节点 aria-hidden) */}
        <span
          aria-hidden="true"
          className="absolute -right-16 -top-16 h-72 w-72 rounded-full bg-accent/20 blur-3xl"
        />
        <span
          aria-hidden="true"
          className="absolute inset-0 flex select-none items-center justify-center text-[10rem] font-black leading-none text-foreground/5 md:text-[13rem]"
        >
          {channelTitle.slice(0, 1)}
        </span>
        <span aria-hidden="true" className="absolute inset-0 bg-gradient-to-t from-surface via-surface/60 to-transparent" />

        <span className="absolute left-4 top-4 inline-flex items-center gap-1.5 rounded bg-background/75 px-2 py-1 text-xs text-foreground backdrop-blur-sm md:left-6 md:top-6">
          <span aria-hidden="true" className="size-2 rounded-full bg-accent" />
          正在直播
        </span>

        {/* 当前节目进度线(红 = 直播/时间线;只描述服务端快照,不臆测本地时钟;
            与 ChannelTile 同款表达,FR-010 六信息之「进度」) */}
        {progress !== null ? (
          <span
            aria-hidden="true"
            className="absolute bottom-0 left-0 h-0.5 w-full bg-background/40"
          >
            <span className="block h-full bg-accent" style={{ width: `${Math.round(progress * 100)}%` }} />
          </span>
        ) : null}

        {/* 信息层:分组/状态 → 节目名 → 频道与时段与进度 → 下一节目 → 统一播放入口 */}
        <div className="absolute inset-x-0 bottom-0 flex min-w-0 flex-col gap-1.5 p-5 md:p-8">
          <p className="text-xs font-medium text-accent">{row.groupLabel} · 此刻直播</p>
          <h2 className="hmp-truncate text-2xl font-bold text-foreground md:text-4xl" title={current.title}>
            {current.title}
          </h2>
          <p className="hmp-tabular-nums text-sm text-muted">
            {channelTitle} · {formatRangeInZone(current.startsAt, current.endsAt, timezone)}
            {/* 进度文字表达(状态不只靠颜色,ui.md §6.1):与进度线同源同快照 */}
            {progress !== null ? ` · 已播出 ${Math.round(progress * 100)}%` : ''}
          </p>
          {row.next !== null ? (
            <button
              type="button"
              className="min-w-0 self-start rounded text-left focus:outline-none focus-visible:ring-2 focus-visible:ring-focus"
              onClick={(event) => {
                event.preventDefault();
                onOpenProgramme({
                  mediaId: row.media.id,
                  channelTitle,
                  groupLabel: row.groupLabel,
                  programme: row.next as ExperienceProgrammeDto,
                  kind: 'upcoming',
                });
              }}
            >
              <span className="hmp-truncate block text-xs text-muted" title={row.next.title}>
                接下来:{row.next.title} · {formatTimeInZone(row.next.startsAt, timezone)} 开始
              </span>
            </button>
          ) : null}
          <div className="mt-2">
            <PlayButton
              mediaId={row.media.id}
              title={channelTitle}
              size="md"
              label="播放"
              ariaLabel={`播放 ${channelTitle} 当前直播`}
            />
          </div>
        </div>
      </div>
    </section>
  );
}
