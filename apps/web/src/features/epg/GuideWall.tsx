import { useEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import type { ExperienceProgrammeDto, GuideWindowDto } from '@hmp/shared';
import { Card, Chip } from '@heroui/react';
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
const MAX_LANES = 3;

/** 墙面节目引用(详情面板/播放衔接入参) */
export interface GuideProgrammeRef {
  readonly mediaId: string;
  readonly channelTitle: string;
  readonly programme: ExperienceProgrammeDto;
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
}

export function GuideWall({ data, focusSignal, selectedKey, onSelectProgramme, onPlayChannel, onGoNow = () => undefined }: GuideWallProps): ReactNode {
  const fromMs = Date.parse(data.from);
  const toMs = Date.parse(data.to);
  // 服务端基准钟 ticking(15s;016 spec 基准时间条款);未校准回落响应快照 data.now
  const { nowMs: tickingNowMs } = useServerNow();
  const nowMs = tickingNowMs ?? Date.parse(data.now);
  const spanPx = windowSpanPx(fromMs, toMs);
  const titleRef = useRef<HTMLParagraphElement>(null);
  const rootRef = useRef<HTMLDivElement | null>(null);
  /** 墙内可视区(用于 NOW 浮标贴边:超出时钉在左右边缘) */
  const [viewport, setViewport] = useState<{ scrollLeft: number; clientWidth: number }>({
    scrollLeft: 0,
    clientWidth: 0,
  });

  useEffect(() => {
    const scroller = rootRef.current?.closest('[role="region"]') as HTMLElement | null;
    if (scroller === null) {
      return;
    }
    const update = (): void => {
      setViewport({ scrollLeft: scroller.scrollLeft, clientWidth: scroller.clientWidth });
    };
    update();
    scroller.addEventListener('scroll', update, { passive: true });
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(update);
    observer?.observe(scroller);
    return () => {
      scroller.removeEventListener('scroll', update);
      observer?.disconnect();
    };
  }, []);

  const ticks = useMemo(() => hourTicksInWindow(fromMs, toMs, data.timezone), [fromMs, toMs, data.timezone]);

  // 翻页后焦点定位到新窗口标题(初始渲染不抢焦点)
  useEffect(() => {
    if (focusSignal > 0) {
      titleRef.current?.focus();
    }
  }, [focusSignal]);

  const nowX = Math.min(Math.max(utcToPx(nowMs, fromMs), 0), spanPx);
  const hasNowInWindow = nowMs >= fromMs && nowMs < toMs;
  // formatTimeInZone 需要 ISO 字符串:ticking nowMs(UTC 毫秒)转 ISO
  const nowIso = new Date(nowMs).toISOString();

  /**
   * NOW 浮标 x(时间刻度条坐标系):未测量(jsdom)用真实 nowX;已测量则限制在
   * 可视区内(左缘让出频道列,两侧留 28px 让胶囊完整可见)——越界即贴边。
   */
  const nowPillX = ((): number => {
    if (viewport.clientWidth <= 0) {
      return nowX;
    }
    const leftEdge = viewport.scrollLeft + 28;
    const rightEdge = viewport.scrollLeft + viewport.clientWidth - CHANNEL_COL_PX - 28;
    return Math.min(Math.max(nowX, leftEdge), Math.max(leftEdge, rightEdge));
  })();

  return (
    <div ref={rootRef} className="relative select-none" style={{ width: CHANNEL_COL_PX + spanPx }}>
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
      <div className="sticky top-0 z-40 flex border-b border-border bg-surface shadow-xs">
        {/* 左上角频道头:sticky left + sticky top(015 线框全中文:仅中文「频道」) */}
        <div
          className="sticky left-0 z-10 flex shrink-0 items-center border-r border-border bg-surface px-3 text-xs font-semibold text-muted tracking-wider"
          style={{ width: CHANNEL_COL_PX, height: 32 }}
        >
          <span>频道</span>
        </div>

        {/* 时间刻度条(相对定位:承载 NOW 胶囊) */}
        <div className="relative h-8 shrink-0" style={{ width: spanPx }}>
          {ticks.map((tick) => (
            <div
              key={tick.ms}
              className="hmp-tabular-nums absolute top-0 bottom-0 flex flex-col justify-center border-l border-border/70 pl-2 text-xs font-medium text-muted/90"
              style={{ left: utcToPx(tick.ms, fromMs) }}
            >
              <span>{tick.label}</span>
            </div>
          ))}
          {/* 浮标恒渲染:now 在窗口外(浏览其他日期)时钉在最近边缘,始终提供「回到现在」入口 */}
          <div className="absolute top-0 z-10 flex -translate-x-1/2 flex-col items-center" style={{ left: nowPillX }}>
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
        {data.channels.map((channel, channelIndex) => {
          const lanes = assignLanes(channel.programmes);
          const laneCount = Math.max(1, ...lanes.values(), 1);
          const laneHeight = ROW_HEIGHT_PX / Math.min(laneCount, MAX_LANES);
          const current = pickCurrentProgramme(channel.programmes, nowMs);
          // 两行布局(标题 + 时段)仅在单行高泳道放得下;多泳道压缩时回落单行标题
          const showTimeLine = laneHeight >= 34;

          return (
            <div key={channel.media.id} className="group/row flex border-b border-border/60 transition-colors last:border-b-0 hover:bg-surface-secondary/20">
              {/* 频道列:sticky left;整格即「播放该频道当前直播」按钮(不再单列直播按钮)。
                  背景与节目区区分,右缘渐变阴影提示可横向滚动 */}
              <button
                type="button"
                aria-label={`播放 ${channel.media.title} 当前直播`}
                onClick={() => {
                  onPlayChannel(channel.media.id, channel.media.title);
                }}
                className="sticky left-0 z-30 flex shrink-0 items-center gap-1.5 border-r border-border bg-surface-secondary/70 px-2 text-left transition-colors hover:bg-surface-secondary focus:outline-none focus-visible:ring-2 focus-visible:ring-focus"
                style={{ width: CHANNEL_COL_PX, height: ROW_HEIGHT_PX }}
              >
                <span
                  aria-hidden="true"
                  className="hmp-tabular-nums w-3 shrink-0 text-right text-3xs leading-none text-muted/70"
                >
                  {channelIndex + 1}
                </span>
                {/* SC-006 范围守护:时间轴内零 img——身份盒只用纯 CSS 首字徽标,
                    不渲染 ChannelLogo(图片仅出现在列表视图/直播卡片) */}
                <span
                  aria-hidden="true"
                  className="inline-flex size-8 shrink-0 items-center justify-center overflow-hidden rounded-md border border-border/50 bg-surface-secondary text-xs font-bold text-muted"
                >
                  {channel.media.title.slice(0, 1).toUpperCase()}
                </span>
                <span className="hmp-truncate min-w-0 flex-1 text-xs font-medium text-foreground" title={channel.media.title}>
                  {channel.media.title}
                </span>
                {/* 右缘渐变阴影:区分频道列与时间轴,并暗示可横向滚动 */}
                <span
                  aria-hidden="true"
                  className="pointer-events-none absolute inset-y-0 right-0 w-3 translate-x-full bg-gradient-to-r from-background/70 to-transparent"
                />
              </button>

              {/* 节目轴:相对定位 + 背景刻度网格 + 绝对位置节目块 (Planby Program Grid) */}
              <div className="relative shrink-0" style={{ width: spanPx, height: ROW_HEIGHT_PX }}>
                {/* 背景小时对齐参考线 */}
                {ticks.map((tick) => (
                  <div
                    key={`grid-${tick.ms}`}
                    aria-hidden="true"
                    className="pointer-events-none absolute top-0 bottom-0 border-l border-border/20"
                    style={{ left: utcToPx(tick.ms, fromMs) }}
                  />
                ))}

                {channel.programmes.length === 0 ? (
                  <div className="absolute inset-y-2 left-2 right-2 flex items-center rounded-md border border-dashed border-border/50 bg-surface-secondary/20 px-3">
                    <span className="text-xs text-muted">暂无节目</span>
                  </div>
                ) : (
                  channel.programmes.map((programme) => {
                    const startsAtMs = Date.parse(programme.startsAt);
                    const endsAtMs = Date.parse(programme.endsAt);
                    const left = Math.min(Math.max(utcToPx(startsAtMs, fromMs), 0), spanPx);
                    const right = Math.min(Math.max(utcToPx(endsAtMs, fromMs), 0), spanPx);
                    const width = Math.max(right - left, 2);
                    const lane = lanes.get(programme.key) ?? 0;
                    const isCurrent = current?.key === programme.key;
                    const isPast = endsAtMs <= nowMs;
                    const rangeLabel = `${formatTimeInZone(programme.startsAt, data.timezone)}–${formatTimeInZone(programme.endsAt, data.timezone)}`;

                    return (
                      <Card
                        key={programme.key}
                        className={`hmp-truncate hmp-tabular-nums absolute overflow-hidden p-0 ${
                          selectedKey === programme.key
                            ? 'z-10 border-accent bg-accent/20 text-foreground shadow-md ring-2 ring-accent/40'
                            : isCurrent
                              ? 'z-[5] border-accent/50 bg-accent/12 text-foreground shadow-xs hover:border-accent/80 hover:bg-accent/20 hover:shadow-md'
                              : isPast
                                ? 'border-border/40 bg-surface/60 text-muted/70 shadow-none hover:bg-surface-secondary/60'
                                : 'border-border/60 bg-surface/90 text-foreground/90 shadow-xs hover:border-foreground/25 hover:bg-surface-secondary hover:shadow-md'
                        }`}
                        style={{
                          left: left + 1,
                          width: Math.max(width - 2, 2),
                          top: (lane % MAX_LANES) * laneHeight + 4,
                          height: laneHeight - 8,
                          minHeight: 18,
                        }}
                      >
                      <button
                        type="button"
                        // T025:详情返回焦点恢复锚(会话内存快照按 key 查块;不进 URL/storage)
                        data-programme-key={programme.key}
                        aria-label={`${channel.media.title},${programme.title},${rangeLabel}${isCurrent ? ',正在直播' : ''}`}
                        title={`${programme.title} ${rangeLabel}`}
                        onClick={() => {
                          // 产品统一:所有节目块(含正在直播)都进详情抽屉;
                          // 「正在直播」只在详情里多一个播放按钮,不再块内直接起播。
                          onSelectProgramme({ mediaId: channel.media.id, channelTitle: channel.media.title, programme });
                        }}
                        className="group/prog flex h-full w-full flex-col text-left focus:outline-none focus-visible:ring-2 focus-visible:ring-focus"
                      >
                        {/* 两行内容:标题行(+LIVE 角标)+ `HH:mm – HH:mm` muted 行 */}
                        <span className="flex h-full min-w-0 flex-col justify-center gap-0.5 px-2.5">
                          <span className="flex min-w-0 items-center gap-1">
                            <span className="hmp-truncate min-w-0 text-2xs font-medium leading-tight">
                              {programme.title}
                            </span>
                            {isCurrent && showTimeLine ? (
                              // 绿色 LIVE 角标(015 T013,R6/ui-layout §3.2):HeroUI Chip
                              // success 语义 token;文字「LIVE」+ aria「正在直播」承载语义,
                              // 不以颜色为唯一区分;装饰性节点(可读名由按钮 aria-label 承担)。
                              <Chip
                                aria-hidden="true"
                                color="success"
                                size="sm"
                                variant="soft"
                                className="h-4 shrink-0 px-1 text-3xs"
                              >
                                LIVE
                              </Chip>
                            ) : null}
                          </span>
                          {showTimeLine ? (
                            <span
                              aria-hidden="true"
                              className="hmp-truncate min-w-0 text-3xs leading-tight text-muted"
                            >
                              {`${formatTimeInZone(programme.startsAt, data.timezone)} – ${formatTimeInZone(programme.endsAt, data.timezone)}`}
                            </span>
                          ) : null}
                        </span>

                      </button>
                      </Card>
                    );
                  })
                )}
              </div>
            </div>
          );
        })}

        {/* 当前时间指示线 (Planby NOW Line 纵贯指示器;2px accent 竖线,ticking now 驱动;
            可读语义由头部 role=status 胶囊承担,此为纯视觉装饰线) */}
        {hasNowInWindow ? (
          <div
            aria-hidden="true"
            className="pointer-events-none absolute top-0 bottom-0 z-20 w-[2px] bg-accent"
            style={{ left: CHANNEL_COL_PX + nowX }}
          />
        ) : null}
      </div>

      {/* 底部留白:Px 比例说明(像素/分钟;不渲染附加时间) */}
      <span className="hmp-sr-only">{`${PX_PER_MINUTE} 像素每分钟`}</span>
    </div>
  );
}
