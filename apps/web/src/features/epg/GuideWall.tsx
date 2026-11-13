import { memo, useEffect, useMemo, useRef, useState } from 'react';
import { Star } from 'lucide-react';
import type { ReactNode } from 'react';
import type { ExperienceProgrammeDto, GuideWindowDto } from '@hmp/shared';
import { Card, Chip, Tooltip } from '@heroui/react';
import { ChannelLogo } from '../live/components/channel-logo';
import { useServerNow } from '../../shared/time/use-server-now';
import {
  PX_PER_MINUTE,
  formatTimeInZone,
  formatWindowEndInZone,
  formatZoneLabel,
  hourTicksInWindow,
  utcToPx,
  windowSpanPx,
  zoneOffsetLabel,
} from './guide-time';

/**
 * EPG 墙视图(T117;FR-025~027、A-008、ui.md §6;015 T013:R6、ui-layout §3.2;SC-006;
 * 016 spec 服务端基准时间条款):
 * - 时间来源 = 服务端基准时钟 useServerNow(planby 模式:单一 ticking 来源同时驱动
 *   NOW 指示线/直播判定/进度条;016 spec「进度条以服务器返回的基准时间戳计算漂移
 *   差值」):每 15s tick 一次,NOW 线 x 坐标、hasNowInWindow、直播胶囊时刻、当前
 *   节目判定(pickCurrentProgramme)、isPast、liveProgressPercent 全部随真实时间
 *   平滑推进,不再冻结在响应快照;未校准回落 Date.parse(data.now),不臆造本地
 *   时钟(禁止裸 Date.now());
 * - 参考 Planby (https://github.com/karolkozer/planby) EPG 架构与交互设计进行优化
 *   (仅借鉴设计模式,零依赖/零源码引用;license 约束见 docs/frontend-home-live-epg-design.md §6):
 *   1. 侧边栏频道项 (ChannelItem): 频道序号(小字 muted)+ 频道 Logo 身份盒
 *      (posterRef 有则渲染 ChannelLogo,无则首字回退徽标——复用 list 视图模式)
 *      + 频道名称 + 紧凑「直播」动作按钮,层级与边界分割清晰;
 *   2. 时间轴标尺 (Timeline Header): 黏性吸顶、小时刻度线、当前时间「Jetzt」式
 *      accent 胶囊徽章(吸附在头部视觉带内,pill + 脉动圆点 + 下指三角;aria
 *      role=status 元素与文案契约不变);
 *   3. 节目卡片 (ProgramItem): 两行内容(标题行 + `HH:mm – HH:mm` muted 行);
 *      区分已结束、正在直播、即将播放三态;正在直播节目提供 Planby 标志性的
 *      播放进度条 (progress percentage) 与动态 LIVE 徽章;hover 提亮;
 *   4. 当前时间基准线 (NOW Line): 纵贯节目区 2px accent 竖线指示器,
 *      与头部胶囊同一 x 坐标(ticking now 每 15s 更新);
 * - 纵向为频道、横向为时间:固定频道列(sticky left)+ 时间头(sticky top),
 *   节目位置用同一 UTC 坐标轴计算(utcToPx),按家庭时区格式化(不依赖浏览器时区);
 *   CHANNEL_COL_PX 导出供宿主(GuidePage)换算居中定位锚点(015 ui-layout §3.2.1
 *   页面初始化自动水平居中当前时刻线);
 * - 窗口为服务端响应的 [from,to](一次展示该日完整 24 小时,真实日界派生;
 *   23/25 小时日按真实日长,DST 重复小时刻度附 GMT 偏移、缺失小时不补造);
 * - 节目块展示名称与起止;当前节目判定沿用 R8(start<=now<end,取 startsAt 最近、
 *   同起点按 key 升序 —— pickCurrentProgramme),块上加绿色 LIVE 角标
 *   (015 T013:HeroUI Chip success 语义 token + 文字「LIVE」,不以颜色为唯一区分,
 *   aria 保留「正在直播」语义);
 * - 节目块点击分流(015 T013,R6/ui-layout §3.2):与 NOW 相交的 current 块 =
 *   直播语义,点击直接起播该频道当前直播(onPlayChannel 统一入口,游客先登录、
 *   登录前零媒体流请求);upcoming/ended 块保持 onSelectProgramme 详情面板路径
 *   (未来节目禁止直接播放,FR-024 延续);
 * - 重叠节目按泳道分行布局,不遮住频道列(sticky 独立列,节目块绝不越轴);
 * - 长名称截断 + title 完整可读;时间等宽数字;节目标题/简介按不可信内容渲染
 *   (React 文本节点转义,不注入 HTML);
 * - z 序约定(只允许 0/10/20/30/40/50 与 z-[N]):头部 z-40 > 频道列 z-30 >
 *   NOW 竖线 z-20 > 选中块 z-10/current 块 z-[5] > 普通块 0 —— NOW 线纵贯节目区
 *   但不越过吸顶头部与 sticky 频道列(对齐参考页:品牌线止于头部下缘)。
 */

/** 频道列宽(px;导出:GuidePage 换算 GuideAutoPosition.anchorX 时加此偏移) */
export const CHANNEL_COL_PX = 176;
const ROW_HEIGHT_PX = 72;
/** 次日尾巴段时长(分钟):6 小时 = 2160px,足以把日界拖到视口左缘 */
const TAIL_MINUTES = 360;
/** 稳定空数组:memo 行在无尾巴段时不因每次新建 [] 而重渲染 */
const EMPTY_TAIL_BLOCKS: readonly TailBlock[] = [];
/** 稳定空集合:未登录/无收藏时不因每次新建 Set 触发重渲染 */
const EMPTY_FAVORITE_IDS: ReadonlySet<string> = new Set<string>();
/** 时间头高度(刻度标签 + 短刻度线的视觉带;NOW 胶囊也在此高度内居中偏上) */
const HEADER_HEIGHT_PX = 36;
const MAX_LANES = 3;

/** 墙面节目引用(详情面板/播放衔接入参) */
export interface GuideProgrammeRef {
  readonly mediaId: string;
  readonly channelTitle: string;
  readonly programme: ExperienceProgrammeDto;
  /** 频道台标引用(详情抽屉海报区用;不参与播放请求) */
  readonly posterRef?: string | null;
}

/** R8 当前判定:覆盖 now(start<=now<end)中 startsAt 最近者,同起点 key 升序;无覆盖 null */
export function pickCurrentProgramme(
  rows: readonly ExperienceProgrammeDto[],
  nowMs: number,
): ExperienceProgrammeDto | null {
  let current: ExperienceProgrammeDto | null = null;
  for (const row of rows) {
    const startsAtMs = Date.parse(row.startsAt);
    const endsAtMs = Date.parse(row.endsAt);
    if (Number.isNaN(startsAtMs) || Number.isNaN(endsAtMs)) {
      continue;
    }
    if (startsAtMs <= nowMs && nowMs < endsAtMs) {
      if (
        current === null ||
        startsAtMs > Date.parse(current.startsAt) ||
        (startsAtMs === Date.parse(current.startsAt) && row.key < current.key)
      ) {
        current = row;
      }
    }
  }
  return current;
}

/** 泳道分配(重叠节目分行;超出 MAX_LANES 共用末道,视觉压缩不丢数据) */
function assignLanes(rows: readonly ExperienceProgrammeDto[]): Map<string, number> {
  const laneEnds: number[] = [];
  const laneOf = new Map<string, number>();
  for (const row of rows) {
    const start = Date.parse(row.startsAt);
    let lane = laneEnds.findIndex((end) => end <= start);
    if (lane === -1) {
      lane = Math.min(laneEnds.length, MAX_LANES - 1);
      laneEnds[lane] = Date.parse(row.endsAt);
    } else {
      laneEnds[lane] = Date.parse(row.endsAt);
    }
    laneOf.set(row.key, lane);
  }
  return laneOf;
}

export interface GuideWallProps {
  readonly data: GuideWindowDto;
  /** 导航代次(>0 时把焦点定位到窗口标题,FR-044:翻页不掉到页面起点) */
  readonly focusSignal: number;
  readonly selectedKey: string | null;
  readonly onSelectProgramme: (ref: GuideProgrammeRef) => void;
  /** 频道列播放该频道当前直播(US3 统一入口) */
  readonly onPlayChannel: (mediaId: string, channelTitle: string) => void;
  /** NOW 浮标点击 = 回到现在(原工具栏按钮入口已移除;缺省 no-op 便于直挂测试) */
  readonly onGoNow?: () => void;
  /**
   * 次日窗口(无级横向拖拽):有值时在当天时间轴右侧追加 TAIL_MINUTES 的「尾巴段」,
   * 拖到当天 24:00 后可直接看到次日节目;宿主在边界到达视口左缘时提交切日,
   * 位置换算保证视觉连续(见 GuidePage)。
   */
  readonly nextDay?: GuideWindowDto | null;
  /** 前一日窗口(对称的「头部段」):当天 00:00 左侧接上前一日最后 TAIL_MINUTES */
  readonly prevDay?: GuideWindowDto | null;
  /** 已收藏频道 id 集合(频道列表打标用) */
  readonly favoriteIds?: ReadonlySet<string>;
  /** 相邻日是否存在于可选日期范围(决定是否预留段宽;数据可稍后到达) */
  readonly hasPrevDay?: boolean;
  readonly hasNextDay?: boolean;
}

interface ProgrammeMeta {
  readonly startsAtMs: number;
  readonly endsAtMs: number;
  readonly rangeLabel: string;
}

interface TailBlock {
  readonly programme: ExperienceProgrammeDto;
  readonly left: number;
  readonly width: number;
  readonly rangeLabel: string;
}

interface GuideChannelRowProps {
  readonly channel: GuideWindowDto['channels'][number];
  readonly channelIndex: number;
  readonly currentKey: string | null;
  readonly nowMinuteMs: number;
  readonly selectedKey: string | null;
  readonly fromMs: number;
  readonly ticks: readonly { readonly ms: number; readonly label: string }[];
  readonly programmeMeta: ReadonlyMap<string, ProgrammeMeta>;
  /** 当天 + 尾巴段的总宽度、尾巴段刻度偏移、该频道的次日节目块 */
  readonly totalSpanPx: number;
  readonly tailOffsets: readonly number[];
  readonly tailBlocks: readonly TailBlock[];
  /** 尾巴段所属日期标签(如 11月13日);无尾巴段为 null */
  readonly tailDateLabel: string | null;
  /** 横向可见窗口(内容坐标;窗口外节目块不渲染) */
  readonly visibleFrom: number;
  readonly visibleTo: number;
  /** 时间轴起点偏移(前一日头部段宽度)与总宽(头部段 + 当天 + 尾巴段) */
  readonly timelineOffsetPx: number;
  readonly timelineWidth: number;
  /** 前一日头部段节目块 + 其日期标签 */
  readonly headBlocks: readonly TailBlock[];
  readonly headDateLabel: string | null;
  /** 该频道是否已收藏(频道列打标) */
  readonly favorite: boolean;
  readonly onSelectProgramme: (ref: GuideProgrammeRef) => void;
  readonly onPlayChannel: (mediaId: string, channelTitle: string) => void;
}

/**
 * 单个频道行(memo):
 * - 全天窗口下每频道约 30 个节目块,父级 useServerNow 每 15s tick 会整体重渲染;
 *   本组件以「分钟桶」(nowMinuteMs)+ 预计算时间表(programmeMeta)为输入,
 *   同一分钟内 tick 不触发重渲染(4 次 tick 只渲染 1 次);
 * - content-visibility:auto:离屏频道行跳过布局与绘制,纵向滚动更顺。
 */
const GuideChannelRow = memo(function GuideChannelRow({
  channel,
  channelIndex,
  currentKey,
  nowMinuteMs,
  selectedKey,
  fromMs,
  ticks,
  programmeMeta,
  totalSpanPx,
  tailOffsets,
  tailBlocks,
  tailDateLabel,
  visibleFrom,
  visibleTo,
  timelineOffsetPx,
  timelineWidth,
  headBlocks,
  headDateLabel,
  favorite,
  onSelectProgramme,
  onPlayChannel,
}: GuideChannelRowProps): ReactNode {
  const lanes = useMemo(() => assignLanes(channel.programmes), [channel.programmes]);
  const laneCount = Math.max(1, ...lanes.values(), 1);
  const laneHeight = ROW_HEIGHT_PX / Math.min(laneCount, MAX_LANES);
  // 两行布局(标题 + 时段)仅在单行高泳道放得下;多泳道压缩时回落单行标题
  const showTimeLine = laneHeight >= 34;

  /** 节目块渲染(当天与次日尾巴段共用同一套卡片/语义/交互) */
  const renderBlock = ({
    programme,
    left,
    width,
    lane,
    isCurrent,
    isPast,
    rangeLabel,
    dayKind = 'current',
    dateLabel = null,
  }: {
    programme: ExperienceProgrammeDto;
    left: number;
    width: number;
    lane: number;
    isCurrent: boolean;
    isPast: boolean;
    rangeLabel: string;
    /** 所属日段:当天 / 次日尾巴段 / 前一日头部段 */
    dayKind?: 'current' | 'tail' | 'head';
    dateLabel?: string | null;
  }): ReactNode => {
    // 短标题不会被截断:不挂 Tooltip(减少组件实例),仍保留原生 title 兜底
    const needsTooltip = programme.title.length > 10;
    const blockButtonProps = {
      type: 'button' as const,
      'data-programme-key': programme.key,
      'aria-label': `${channel.media.title},${programme.title},${dateLabel === null ? '' : `${dateLabel},`}${rangeLabel}${isCurrent ? ',正在直播' : ''}`,
      title: `${programme.title} ${rangeLabel}`,
      'data-day': dayKind,
      onClick: () => {
        onSelectProgramme({
          mediaId: channel.media.id,
          channelTitle: channel.media.title,
          programme,
          posterRef: channel.media.posterRef,
        });
      },
      className:
        'group/prog flex h-full w-full flex-col text-left focus:outline-none focus-visible:ring-2 focus-visible:ring-focus',
    };
    const blockContent = (
      <span className="relative flex h-full min-w-0 flex-col justify-center gap-0.5 px-2.5">
        <span className="flex min-w-0 items-center gap-1">
          <span className="hmp-truncate min-w-0 text-2xs font-medium leading-tight">{programme.title}</span>
          {isCurrent && showTimeLine ? (
            <Chip aria-hidden="true" color="success" size="sm" variant="soft" className="h-4 shrink-0 px-1 text-3xs">
              LIVE
            </Chip>
          ) : null}
        </span>
        {showTimeLine ? (
          <span aria-hidden="true" className="hmp-truncate min-w-0 text-3xs leading-tight text-muted">
            {rangeLabel}
          </span>
        ) : null}
      </span>
    );
    const card = (
    <Card
      key={programme.key}
      className={`hmp-truncate hmp-tabular-nums absolute overflow-hidden rounded-lg p-0 ${
        selectedKey === programme.key
          ? 'z-10 border border-accent bg-accent/20 text-foreground shadow-md ring-2 ring-accent/40'
          : isCurrent
            ? 'z-[5] border border-accent/60 bg-accent/20 text-foreground shadow-sm hover:border-accent hover:bg-accent/25'
            : isPast
              ? 'border border-border/50 bg-surface-secondary/40 text-muted/70 shadow-none hover:bg-surface-secondary/60'
              : 'border border-border/70 bg-surface-secondary/65 text-foreground shadow-sm hover:border-foreground/30 hover:bg-surface-secondary hover:shadow-md'
      }`}
      style={{
        left: left + 2,
        width: Math.max(width - 4, 2),
        top: (lane % MAX_LANES) * laneHeight + 5,
        height: laneHeight - 10,
        minHeight: 18,
      }}
    >
      {needsTooltip ? (
        <Tooltip delay={400}>
          <Tooltip.Trigger<"button">
            render={({ children, ...triggerProps }) => (
              <button {...triggerProps} {...blockButtonProps}>
                {children}
              </button>
            )}
          >
            {blockContent}
          </Tooltip.Trigger>
          <Tooltip.Content>{programme.title}</Tooltip.Content>
        </Tooltip>
      ) : (
        <button {...blockButtonProps}>{blockContent}</button>
      )}
    </Card>
    );
    return card;
  };

  return (
    <div
      key={channel.media.id}
      className="group/row flex transition-colors [contain-intrinsic-size:auto_72px] [content-visibility:auto] hover:bg-surface-secondary/25"
    >
      {/* 频道列:sticky left;整格即「播放该频道当前直播」按钮。
          产品要求:列内只展示台标(logo 接口),频道名改由 Tooltip 悬浮展示;
          背景与节目区区分,右缘渐变阴影提示可横向滚动 */}
      <Tooltip delay={200}>
        <Tooltip.Trigger
          className="sticky left-0 z-30 flex shrink-0 items-center justify-center gap-1.5 bg-surface-secondary/70 px-2 transition-colors hover:bg-surface-secondary"
          style={{ width: CHANNEL_COL_PX, height: ROW_HEIGHT_PX }}
        >
        <button
          type="button"
          aria-label={`播放 ${channel.media.title} 当前直播`}
          onClick={() => {
            onPlayChannel(channel.media.id, channel.media.title);
          }}
          className="flex h-full w-full items-center justify-center gap-1.5 text-left focus:outline-none focus-visible:ring-2 focus-visible:ring-focus"
        >
          <span
            aria-hidden="true"
            className="hmp-tabular-nums w-3 shrink-0 text-right text-3xs leading-none text-muted/70"
          >
            {channelIndex + 1}
          </span>
          {/* 台标:posterRef → 同源 logo 接口;无 ref 时回退首字(仍不展示全名)。
              星标必须放在 overflow-hidden 之外,否则会被台标盒裁掉(实测)。 */}
          <span aria-hidden="true" className="relative inline-flex shrink-0">
            <span className="inline-flex size-14 items-center justify-center overflow-hidden rounded-md bg-transparent">
              {channel.media.posterRef !== null ? (
                <ChannelLogo
                  key={channel.media.posterRef}
                  posterRef={channel.media.posterRef}
                  channelTitle={channel.media.title}
                  fallbackClassName="text-lg font-black leading-none text-muted"
                />
              ) : (
                <span className="text-lg font-bold text-muted">
                  {channel.media.title.slice(0, 1).toUpperCase()}
                </span>
              )}
            </span>
            {/* 已收藏标记:右上角实心星标(不参与裁切;aria 由整格 aria-label 承担) */}
            {favorite ? (
              <>
                <Star className="absolute -right-2 -top-2 size-4 fill-current text-accent drop-shadow-[0_0_2px_rgba(0,0,0,0.9)]" />
                <span className="hmp-sr-only">(已收藏)</span>
              </>
            ) : null}
          </span>
          {/* 右缘渐变阴影:区分频道列与时间轴,并暗示可横向滚动 */}
          <span
            aria-hidden="true"
            className="pointer-events-none absolute inset-y-0 right-0 w-3 translate-x-full bg-gradient-to-r from-background/70 to-transparent"
          />
        </button>
        </Tooltip.Trigger>
        <Tooltip.Content>
          <p>{channel.media.title}</p>
        </Tooltip.Content>
      </Tooltip>

      {/* 节目轴:当天节目块 + 次日尾巴段(无级横向拖拽);行宽 = 当天 + 尾巴 */}
      <div className="relative shrink-0" style={{ width: timelineWidth, height: ROW_HEIGHT_PX }}>
        {/* 背景小时对齐参考线(延续到尾巴段) */}
        {[...ticks.map((tick) => timelineOffsetPx + utcToPx(tick.ms, fromMs)), ...tailOffsets].map((left, index) => (
          <div
            key={`grid-${index}`}
            aria-hidden="true"
            className="pointer-events-none absolute top-0 bottom-0"
            style={{ left }}
          />
        ))}

        {channel.programmes.length === 0 && tailBlocks.length === 0 ? (
          <div className="absolute inset-y-2 left-2 right-2 flex items-center rounded-md border border-dashed border-border/60 px-3">
            <span className="text-xs text-muted">暂无节目</span>
          </div>
        ) : (
          <>
            {headBlocks.map((block) =>
              block.left + block.width < visibleFrom || block.left > visibleTo
                ? null
                : renderBlock({
                    programme: block.programme,
                    left: block.left,
                    width: block.width,
                    lane: 0,
                    isCurrent: false,
                    isPast: true,
                    rangeLabel: block.rangeLabel,
                    dayKind: 'head',
                    dateLabel: headDateLabel,
                  }),
            )}
            {channel.programmes.map((programme) => {
              const meta = programmeMeta.get(programme.key);
              const startsAtMs = meta?.startsAtMs ?? Date.parse(programme.startsAt);
              const endsAtMs = meta?.endsAtMs ?? Date.parse(programme.endsAt);
              // 跨日节目不在 24:00 处断开:允许延伸到尾巴段(无尾巴段时 totalSpanPx == spanPx)
              const left = Math.min(
                Math.max(timelineOffsetPx + utcToPx(startsAtMs, fromMs), 0),
                timelineOffsetPx + totalSpanPx,
              );
              const right = Math.min(
                Math.max(timelineOffsetPx + utcToPx(endsAtMs, fromMs), 0),
                timelineOffsetPx + totalSpanPx,
              );
              // 横向窗口化:完全在可视窗口外的块不渲染(大幅降低切日/拖动时的渲染量)
              if (right < visibleFrom || left > visibleTo) {
                return null;
              }
              return renderBlock({
                programme,
                left,
                width: Math.max(right - left, 2),
                lane: lanes.get(programme.key) ?? 0,
                isCurrent: currentKey === programme.key,
                isPast: endsAtMs <= nowMinuteMs,
                rangeLabel: meta?.rangeLabel ?? `${programme.startsAt}–${programme.endsAt}`,
              });
            })}
            {tailBlocks.map((block) =>
              block.left + block.width < visibleFrom || block.left > visibleTo
                ? null
                : renderBlock({
                programme: block.programme,
                left: block.left,
                width: block.width,
                lane: 0,
                isCurrent: false,
                isPast: false,
                    rangeLabel: block.rangeLabel,
                    dayKind: 'tail',
                    dateLabel: tailDateLabel,
                  }),
            )}
          </>
        )}
      </div>
    </div>
  );
});

export function GuideWall({
  data,
  focusSignal,
  selectedKey,
  onSelectProgramme,
  onPlayChannel,
  onGoNow = () => undefined,
  nextDay = null,
  prevDay = null,
  favoriteIds = EMPTY_FAVORITE_IDS,
  hasPrevDay = false,
  hasNextDay = false,
}: GuideWallProps): ReactNode {
  const fromMs = Date.parse(data.from);
  const toMs = Date.parse(data.to);
  // 服务端基准钟 ticking(15s;016 spec 基准时间条款);未校准回落响应快照 data.now
  const { nowMs: tickingNowMs } = useServerNow();
  const nowMs = tickingNowMs ?? Date.parse(data.now);
  const spanPx = windowSpanPx(fromMs, toMs);
  const titleRef = useRef<HTMLParagraphElement>(null);
  const rootRef = useRef<HTMLDivElement | null>(null);
  /** NOW 浮标容器(滚动时同步写 left,避免一帧滞后) */
  const pillRef = useRef<HTMLDivElement | null>(null);
  /** 最新 nowX(滚动回调里读,避免闭包过期) */
  const nowXRef = useRef(0);
  /** 最新头部段宽度(滚动回调里读) */
  const headSpanPxRef = useRef(0);
  /** 墙内可视区(用于 NOW 浮标贴边:超出时钉在左右边缘) */
  /**
   * 视口宽度(只用于首次/宽度变化定位浮标)。**不再随每次滚动 setState**:
   * 滚动帧内只做同步写样式 + 阈值判定,避免每帧重渲染整面墙(拖动卡顿的主因)。
   */
  const [viewport, setViewport] = useState<{ scrollLeft: number; clientWidth: number }>({
    scrollLeft: 0,
    clientWidth: 0,
  });

  /**
   * 次日尾巴段:固定 6 小时(足够覆盖一屏)。仅在视口接近日界(距末尾不足一屏)
   * 时才挂载——避免与当日同名节目在 DOM/可访问名上重复,也省掉常态渲染。
   */
  /**
   * 横向渲染窗口起点(内容坐标,含频道列)。滚动超过半屏才推进一次——
   * 配合行 memo,把「拖动时每帧全量重渲染」变成「每半屏一次局部重渲染」。
   */
  const [windowLeft, setWindowLeft] = useState(0);
  /** 首帧定位(滚到「现在」附近)需要同步建立渲染窗口,否则首屏是空的 */
  const windowInitRef = useRef(false);
  /**
   * 头/尾段宽度按「相邻日是否在可选范围内」恒定预留,与数据是否加载无关:
   * 否则数据到达时整体位移 2160px,会闪出空白区(实测「有时候一片空白」的根因)。
   */
  const tailSpanPx = hasNextDay ? TAIL_MINUTES * PX_PER_MINUTE : 0;
  const headSpanPx = hasPrevDay ? TAIL_MINUTES * PX_PER_MINUTE : 0;
  /** 当天 00:00 在容器坐标中的位置(频道列 + 头部段) */
  const dayStartX = CHANNEL_COL_PX + headSpanPx;
  /** 时间轴总宽 = 当天 + 尾巴段 */
  const totalSpanPx = spanPx + tailSpanPx;

  useEffect(() => {
    const scroller = rootRef.current?.closest('[role="region"]') as HTMLElement | null;
    if (scroller === null) {
      return;
    }
    // 滚动时**同步**写浮标样式:React 状态更新有一帧滞后,瞬时大跨度滚动
    // (回到现在)会先看到浮标飞出视口再 snap 回来。
    const syncPill = (): void => {
      const el = pillRef.current;
      if (el === null) {
        return;
      }
      const clientWidth = scroller.clientWidth;
      // 34 ≈ 胶囊半宽:让胶囊整体留在可视区内,左缘正好停在频道列右侧
      const leftEdge = scroller.scrollLeft + 34;
      const rightEdge = scroller.scrollLeft + clientWidth - CHANNEL_COL_PX - 34;
      el.style.left = `${Math.min(Math.max(headSpanPxRef.current + nowXRef.current, leftEdge), Math.max(leftEdge, rightEdge))}px`;
    };
    const update = (): void => {
      syncPill();
      // 只有宽度变化(挂载/窗口 resize)才需要重渲染
      const width = scroller.clientWidth;
      setViewport((prev) => (prev.clientWidth === width ? prev : { scrollLeft: scroller.scrollLeft, clientWidth: width }));
      // 接近日界才挂载尾巴段:用 transition 让这次「变重」的渲染不阻塞拖动
      // 渲染窗口:左侧留 2 屏余量、跨过 1 屏才推进(减少拖动过程中的重渲染次数),
      // 推进用 transition 让 React 可中断,不阻塞手势
      const nextWindowLeft = Math.max(0, Math.round(scroller.scrollLeft - width * 2));
      if (!windowInitRef.current) {
        // 首次测量:同步建立窗口(此时页面还没画节目块)
        windowInitRef.current = true;
        setWindowLeft(nextWindowLeft);
      } else {
        // 单一状态源 + 函数式更新:ref 先行/transition 延后会造成 state 滞后,
        // 窗口停在旧位置 → 整屏空白且不再自愈(实测)。
        setWindowLeft((prev) => (Math.abs(nextWindowLeft - prev) >= width ? nextWindowLeft : prev));
      }
    };
    update();
    scroller.addEventListener('scroll', update, { passive: true });
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(update);
    observer?.observe(scroller);
    return () => {
      scroller.removeEventListener('scroll', update);
      observer?.disconnect();
    };
  });

  // 日期窗口变化(切日)时按当前 scrollLeft 重建渲染窗口:切日若落在与原来相同的
  // scrollLeft 上不会产生 scroll 事件,窗口会停留在旧值 → 整屏空白(实测)。
  useEffect(() => {
    const scroller = rootRef.current?.closest('[role="region"]') as HTMLElement | null;
    if (scroller === null || scroller.clientWidth <= 0) {
      return;
    }
    setWindowLeft(Math.max(0, Math.round(scroller.scrollLeft - scroller.clientWidth * 2)));
  }, [data.from, data.to]);

  const ticks = useMemo(() => hourTicksInWindow(fromMs, toMs, data.timezone), [fromMs, toMs, data.timezone]);
  /**
   * 分钟桶:行的 isPast/当前档判定只需分钟级精度,tick(15s)不改变桶值时行组件
   * 被 memo 跳过重渲染。
   */
  const nowMinuteMs = Math.floor(nowMs / 60_000) * 60_000;
  /** 时间格式与时间戳预计算(每块每次渲染都做 Date.parse + Intl 很贵) */
  const programmeMeta = useMemo(() => {
    const map = new Map<string, ProgrammeMeta>();
    for (const channel of data.channels) {
      for (const programme of channel.programmes) {
        map.set(programme.key, {
          startsAtMs: Date.parse(programme.startsAt),
          endsAtMs: Date.parse(programme.endsAt),
          rangeLabel: `${formatTimeInZone(programme.startsAt, data.timezone)}–${formatTimeInZone(programme.endsAt, data.timezone)}`,
        });
      }
    }
    return map;
  }, [data]);
  /** 次日尾巴段:每小时刻度在总轴上的偏移(0 起算) */
  const tailOffsets = useMemo(() => {
    if (nextDay === null || tailSpanPx <= 0) {
      return [] as number[];
    }
    const tailFrom = toMs;
    const tailTo = toMs + TAIL_MINUTES * 60_000;
    return hourTicksInWindow(tailFrom, tailTo, nextDay.timezone).map(
      (tick) => headSpanPx + spanPx + utcToPx(tick.ms, tailFrom),
    );
  }, [nextDay, tailSpanPx, toMs, spanPx]);

  /** 横向可见窗口:可视区左缘前一屏 ~ 右缘后两屏(clientWidth 未测量时渲染全部) */
  const visibleFrom = viewport.clientWidth > 0 ? windowLeft : 0;
  // 未测量(jsdom/首帧)时渲染全部:坐标含头部段偏移,上界需一并计入
  const visibleTo = viewport.clientWidth > 0 ? windowLeft + viewport.clientWidth * 4 : headSpanPx + totalSpanPx;

  /** 前一日头部段(最后 TAIL_MINUTES):位置以当天 00:00 为基准向左推算 */
  const headBlocksByChannel = useMemo(() => {
    const map = new Map<string, TailBlock[]>();
    if (prevDay === null || headSpanPx <= 0) {
      return map;
    }
    const headFrom = fromMs - TAIL_MINUTES * 60_000;
    for (const channel of prevDay.channels) {
      const blocks: TailBlock[] = [];
      for (const programme of channel.programmes) {
        const startMs = Date.parse(programme.startsAt);
        const endMs = Date.parse(programme.endsAt);
        if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs <= headFrom || startMs >= fromMs) {
          continue;
        }
        const rawLeft = headSpanPx - ((fromMs - startMs) / 60_000) * PX_PER_MINUTE;
        const rawRight = headSpanPx - ((fromMs - endMs) / 60_000) * PX_PER_MINUTE;
        const left = Math.max(rawLeft, 0);
        const right = Math.min(rawRight, headSpanPx);
        if (right <= left) {
          continue;
        }
        blocks.push({
          programme,
          left,
          width: Math.max(right - left, 2),
          rangeLabel: `${formatTimeInZone(programme.startsAt, prevDay.timezone)}–${formatTimeInZone(programme.endsAt, prevDay.timezone)}`,
        });
      }
      map.set(channel.media.id, blocks);
    }
    return map;
  }, [prevDay, headSpanPx, fromMs]);

  /** 次日尾巴段整点刻度(标签 + 总轴偏移) */
  const tailTickItems = useMemo(() => {
    if (nextDay === null || tailSpanPx <= 0) {
      return [] as { readonly ms: number; readonly label: string; readonly left: number }[];
    }
    return hourTicksInWindow(toMs, toMs + TAIL_MINUTES * 60_000, nextDay.timezone).map((tick) => ({
      ms: tick.ms,
      label: tick.label,
      left: spanPx + utcToPx(tick.ms, toMs),
    }));
  }, [nextDay, tailSpanPx, spanPx, toMs]);

  /** 次日尾巴段节目块(按频道 mediaId 归组;位置以总轴坐标计算) */
  const tailBlocksByChannel = useMemo(() => {
    const map = new Map<string, TailBlock[]>();
    if (nextDay === null || tailSpanPx <= 0) {
      return map;
    }
    const tailFrom = toMs;
    const tailTo = toMs + TAIL_MINUTES * 60_000;
    for (const channel of nextDay.channels) {
      const blocks: TailBlock[] = [];
      for (const programme of channel.programmes) {
        const startMs = Date.parse(programme.startsAt);
        const endMs = Date.parse(programme.endsAt);
        // startMs < tailFrom:该节目在日界前已开播,由当天那一侧整体渲染(不再重复画)
        if (
          !Number.isFinite(startMs) ||
          !Number.isFinite(endMs) ||
          endMs <= tailFrom ||
          startMs < tailFrom ||
          startMs >= tailTo
        ) {
          continue;
        }
        const rawLeft = headSpanPx + spanPx + utcToPx(startMs, tailFrom);
        const rawRight = headSpanPx + spanPx + utcToPx(endMs, tailFrom);
        const left = Math.max(rawLeft, headSpanPx + spanPx);
        const right = Math.min(rawRight, headSpanPx + spanPx + tailSpanPx);
        if (right <= left) {
          continue;
        }
        blocks.push({
          programme,
          left,
          width: Math.max(right - left, 2),
          rangeLabel: `${formatTimeInZone(programme.startsAt, nextDay.timezone)}–${formatTimeInZone(programme.endsAt, nextDay.timezone)}`,
        });
      }
      map.set(channel.media.id, blocks);
    }
    return map;
  }, [nextDay, tailSpanPx, toMs, spanPx]);

  /** 各频道当前节目键(按分钟桶计算,供行组件作 memo 输入) */
  const channelCurrentKeys = useMemo(() => {
    const map = new Map<string, string | null>();
    for (const channel of data.channels) {
      map.set(channel.media.id, pickCurrentProgramme(channel.programmes, nowMinuteMs)?.key ?? null);
    }
    return map;
  }, [data, nowMinuteMs]);

  // 翻页后焦点定位到新窗口标题(初始渲染不抢焦点)
  useEffect(() => {
    if (focusSignal > 0) {
      // preventScroll:焦点锚在内容左上角,默认聚焦会把滚动容器拉回起点,
      // 从而抵消「回到现在」的平滑滚动(实测回归)。
      titleRef.current?.focus({ preventScroll: true });
    }
  }, [focusSignal]);

  const nowX = Math.min(Math.max(utcToPx(nowMs, fromMs), 0), spanPx);
  nowXRef.current = nowX;
  headSpanPxRef.current = headSpanPx;
  const hasNowInWindow = nowMs >= fromMs && nowMs < toMs;
  // formatTimeInZone 需要 ISO 字符串:ticking nowMs(UTC 毫秒)转 ISO
  const nowIso = new Date(nowMs).toISOString();

  /**
   * NOW 浮标 x(时间刻度条坐标系):未测量(jsdom)用真实 nowX;已测量则限制在
   * 可视区内(左缘让出频道列,两侧留 28px 让胶囊完整可见)——越界即贴边。
   */
  const nowPillX = ((): number => {
    const base = headSpanPx + nowX;
    if (viewport.clientWidth <= 0) {
      return base;
    }
    const leftEdge = viewport.scrollLeft + 34;
    const rightEdge = viewport.scrollLeft + viewport.clientWidth - CHANNEL_COL_PX - 34;
    return Math.min(Math.max(base, leftEdge), Math.max(leftEdge, rightEdge));
  })();

  return (
    <div ref={rootRef} className="relative select-none"
      style={{ width: dayStartX + totalSpanPx }}
    >
      {/* 窗口标题:翻页后的焦点锚(FR-044)与读屏窗口说明。应产品要求不再**可见**
          (日期已由页头日期条承担),降为 hmp-sr-only——id/tabIndex/文案逐字保留,
          焦点定位(toBeFocused)、getAllByText(家庭时区/全天节目单)契约不受影响。 */}
      <p
        ref={titleRef}
        id="guide-window-title"
        tabIndex={-1}
        className="hmp-sr-only hmp-tabular-nums focus:outline-none"
      >
        {`${data.date} ${formatTimeInZone(data.from, data.timezone)}–${formatWindowEndInZone(fromMs, toMs, data.timezone)}(家庭时区 ${formatZoneLabel(data.timezone, data.now)})全天节目单`}
      </p>

      {/* 时间头:sticky top (Planby Timeline Header 规范):频道列头 + 小时刻度 +
          NOW 胶囊徽章(accent 底 + 脉动圆点,吸附在头部视觉带内;role=status
          元素与 aria 文案契约不变,仅位置/样式对齐参考页) */}
      <div className="sticky top-0 z-40 flex border-b border-border/80 bg-surface-secondary/70 shadow-sm backdrop-blur-sm">
        {/* 左上角频道头:sticky left + sticky top(015 线框全中文:仅中文「频道」) */}
        <div
          className="sticky left-0 z-20 flex shrink-0 items-center bg-surface-secondary/80 px-3 text-xs font-semibold text-muted tracking-wider"
          style={{ width: CHANNEL_COL_PX, height: HEADER_HEIGHT_PX }}
        >
          <span>频道</span>
        </div>

        {/* 时间刻度条(相对定位:承载 NOW 胶囊) */}
        <div className="relative shrink-0" style={{ width: headSpanPx + totalSpanPx, height: HEADER_HEIGHT_PX }}>
          {/* 半小时短刻度:只画短竖线不写标签,给时间轴一个更密的节奏锚点 */}
          {ticks.map((tick) =>
            tick.ms + 1_800_000 < toMs ? (
              <span
                key={`half-${tick.ms}`}
                aria-hidden="true"
                className="pointer-events-none absolute bottom-0 h-2 w-px bg-border/70"
                style={{ left: utcToPx(tick.ms + 1_800_000, fromMs) }}
              />
            ) : null,
          )}
          {/* 整点刻度:短竖线 + 标签;包含当前时刻的小时用 accent 刻度线 + 前景色标签强调 */}
          {ticks.map((tick) => {
            const isNowHour = nowMs >= tick.ms && nowMs < tick.ms + 3_600_000;
            return (
              <div
                key={tick.ms}
                className="absolute top-0 bottom-0 flex items-center gap-1.5 pl-2"
                style={{ left: headSpanPx + utcToPx(tick.ms, fromMs) }}
              >
                <span
                  aria-hidden="true"
                  className={`h-3 w-px shrink-0 ${isNowHour ? 'bg-accent' : 'bg-border'}`}
                />
                <span
                  className={`hmp-tabular-nums text-xs leading-none ${
                    isNowHour ? 'font-semibold text-foreground' : 'font-medium text-muted'
                  }`}
                >
                  {tick.label}
                </span>
              </div>
            );
          })}
          {/* 次日尾巴段刻度(与当天刻度同款;当前小时强调只属于当天) */}
          {tailTickItems.map((tick) => (
            <div
              key={`tail-${tick.ms}`}
              className="absolute top-0 bottom-0 flex items-center gap-1.5 pl-2"
              style={{ left: headSpanPx + tick.left }}
            >
              <span aria-hidden="true" className="h-3 w-px shrink-0 bg-border" />
              <span className="hmp-tabular-nums text-xs font-medium leading-none text-muted">{tick.label}</span>
            </div>
          ))}
          {/* 日界不单独画日期:当天 24:00 与次日 00:00 是同一点,叠两个标签会糊成
              「00/04」;此处只由次日首个整点标签 00:00 承担(产品要求)。 */}
          {/* 连接线:补上胶囊下指三角与节目区 NOW 竖线之间的空隙(头部内 16→32px)。
              仅在 now 落在窗口内(未被贴边钳制)时绘制,避免钳制态给出错误的"当前时刻"位置。 */}
          {hasNowInWindow ? (
            <span
              aria-hidden="true"
              className="pointer-events-none absolute top-3 -bottom-px w-[2px] -translate-x-1/2 bg-accent"
              style={{ left: nowX }}
            />
          ) : null}
          {/* 浮标恒渲染:now 在窗口外(浏览其他日期)时钉在最近边缘,始终提供「回到现在」入口 */}
          <div ref={pillRef} className="absolute top-0 z-10 flex -translate-x-1/2 flex-col items-center" style={{ left: nowPillX }}>
              {/* NOW 浮标 = 「回到现在」入口(原工具栏按钮已移除)。滚动/拖拽把 now
                  推出可视区时浮标钉在左/右边缘(左缘不越过频道列),见 nowPillX。 */}
              <button
                type="button"
                aria-label="回到现在"
                title="回到现在"
                onClick={() => {
                  onGoNow();
                }}
                className="hmp-tabular-nums mt-0.5 flex items-center gap-1 rounded-full bg-accent px-2 py-0.5 text-3xs font-semibold text-accent-foreground shadow-xs transition-transform hover:scale-105 focus:outline-none focus-visible:ring-2 focus-visible:ring-focus"
              >
                <span aria-hidden="true" className="size-1.5 animate-pulse rounded-full bg-accent-foreground" />
                {formatTimeInZone(nowIso, data.timezone)}
              </button>
              <span aria-hidden="true" className="size-0 border-x-4 border-x-transparent border-t-4 border-t-accent" />
              {/* 读屏的当前时间语义(role=status 契约保留) */}
              <span
                role="status"
                aria-label={`当前时间 ${formatTimeInZone(nowIso, data.timezone)}(${zoneOffsetLabel(nowMs, data.timezone)})`}
                className="hmp-sr-only"
              />
          </div>
        </div>
      </div>

      {/* 频道行区:相对定位容器承载纵贯 NOW 竖线(止于头部下缘,不越频道列) */}
      <div className="relative">
        {data.channels.map((channel, channelIndex) => (
          <GuideChannelRow
            key={channel.media.id}
            channel={channel}
            channelIndex={channelIndex}
            currentKey={channelCurrentKeys.get(channel.media.id) ?? null}
            nowMinuteMs={nowMinuteMs}
            selectedKey={selectedKey}
            fromMs={fromMs}
            ticks={ticks}
            programmeMeta={programmeMeta}
            totalSpanPx={totalSpanPx}
            tailOffsets={tailOffsets}
            tailBlocks={tailBlocksByChannel.get(channel.media.id) ?? EMPTY_TAIL_BLOCKS}
            tailDateLabel={
              nextDay === null ? null : `${Number(nextDay.date.slice(5, 7))}月${Number(nextDay.date.slice(8, 10))}日`
            }
            visibleFrom={visibleFrom}
            visibleTo={visibleTo}
            timelineOffsetPx={headSpanPx}
            timelineWidth={headSpanPx + totalSpanPx}
            headBlocks={headBlocksByChannel.get(channel.media.id) ?? EMPTY_TAIL_BLOCKS}
            headDateLabel={
              prevDay === null ? null : `${Number(prevDay.date.slice(5, 7))}月${Number(prevDay.date.slice(8, 10))}日`
            }
            favorite={favoriteIds.has(channel.media.id)}
            onSelectProgramme={onSelectProgramme}
            onPlayChannel={onPlayChannel}
          />
        ))}

        {/* 当前时间指示线 (Planby NOW Line 纵贯指示器;2px accent 竖线,ticking now 驱动;
            可读语义由头部 role=status 胶囊承担,此为纯视觉装饰线) */}
        {hasNowInWindow ? (
          <div
            aria-hidden="true"
            // -translate-x-1/2:与头部连接线/胶囊一致地「以 nowX 为中心」,
            // 否则竖线以 left 为左边缘,与连接线差 1px(实测像素错位)
            className="pointer-events-none absolute top-0 bottom-0 z-20 w-[2px] -translate-x-1/2 bg-accent"
            style={{ left: dayStartX + nowX }}
          />
        ) : null}
      </div>

      {/* 底部留白:Px 比例说明(像素/分钟;不渲染附加时间) */}
      <span className="hmp-sr-only">{`${PX_PER_MINUTE} 像素每分钟`}</span>
    </div>
  );
}
