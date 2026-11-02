import { useEffect, useMemo, useRef } from 'react';
import type { ReactNode } from 'react';
import type { ExperienceProgrammeDto, GuideWindowDto } from '@hmp/shared';
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
 * EPG 墙视图(T117;FR-025~027、A-008、ui.md §6):
 * - 纵向为频道、横向为时间:固定频道列(sticky left)+ 时间头(sticky top),
 *   节目位置用同一 UTC 坐标轴计算(utcToPx),按家庭时区格式化(不依赖浏览器时区);
 * - 窗口为服务端响应的 [from,to](一次展示该日完整 24 小时,真实日界派生;
 *   23/25 小时日按真实日长,DST 重复小时刻度附 GMT 偏移、缺失小时不补造);
 * - 节目块展示名称与起止;当前节目判定沿用 R8(start<=now<end,取 startsAt 最近、
 *   同起点按 key 升序 —— pickCurrentProgramme),块上加「正在直播」标注;
 * - 重叠节目按泳道分行布局,不遮住频道列(sticky 独立列,节目块绝不越轴);
 * - 长名称截断 + title 完整可读;时间等宽数字;节目标题/简介按不可信内容渲染
 *   (React 文本节点转义,不注入 HTML)。
 */

const CHANNEL_COL_PX = 176;
const ROW_HEIGHT_PX = 56;
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
}

export function GuideWall({ data, focusSignal, selectedKey, onSelectProgramme, onPlayChannel }: GuideWallProps): ReactNode {
  const fromMs = Date.parse(data.from);
  const toMs = Date.parse(data.to);
  const nowMs = Date.parse(data.now);
  const spanPx = windowSpanPx(fromMs, toMs);
  const titleRef = useRef<HTMLParagraphElement>(null);

  const ticks = useMemo(() => hourTicksInWindow(fromMs, toMs, data.timezone), [fromMs, toMs, data.timezone]);

  // 翻页后焦点定位到新窗口标题(初始渲染不抢焦点)
  useEffect(() => {
    if (focusSignal > 0) {
      titleRef.current?.focus();
    }
  }, [focusSignal]);

  const nowX = Math.min(Math.max(utcToPx(nowMs, fromMs), 0), spanPx);
  const hasNowInWindow = nowMs >= fromMs && nowMs < toMs;

  return (
    <div className="relative" style={{ width: CHANNEL_COL_PX + spanPx }}>
      {/* 窗口标题:翻页后的焦点锚(FR-044);全天窗口终点按 EPG 惯例显示 24:00 */}
      <p
        ref={titleRef}
        id="guide-window-title"
        tabIndex={-1}
        className="hmp-tabular-nums mb-1 px-2 py-1 text-xs text-muted focus:outline-none"
      >
        {`${data.date} ${formatTimeInZone(data.from, data.timezone)}–${formatWindowEndInZone(fromMs, toMs, data.timezone)}(家庭时区 ${formatZoneLabel(data.timezone, data.now)})全天节目单`}
      </p>
      {/* 时间头:sticky top */}
      <div className="sticky top-0 z-20 flex border-b border-border bg-surface">
        <div
          className="sticky left-0 z-30 flex shrink-0 items-center justify-center border-r border-border bg-surface text-xs text-muted"
          style={{ width: CHANNEL_COL_PX, height: 28 }}
        >
          频道
        </div>
        <div className="relative h-7 shrink-0" style={{ width: spanPx }}>
          {ticks.map((tick) => (
            <span
              key={tick.ms}
              className="hmp-tabular-nums absolute top-1 border-l border-border pl-1 text-xs text-muted"
              style={{ left: utcToPx(tick.ms, fromMs) }}
            >
              {tick.label}
            </span>
          ))}
        </div>
      </div>
      {/* 频道行 */}
      {data.channels.map((channel) => {
        const lanes = assignLanes(channel.programmes);
        const laneCount = Math.max(1, ...lanes.values(), 1);
        const laneHeight = ROW_HEIGHT_PX / Math.min(laneCount, MAX_LANES);
        const current = pickCurrentProgramme(channel.programmes, nowMs);
        return (
          <div key={channel.media.id} className="flex border-b border-border last:border-b-0">
            {/* 频道列:sticky left;频道点击对象(播放当前直播)不被节目块遮挡 */}
            <div
              className="sticky left-0 z-10 flex shrink-0 items-center justify-between gap-1 border-r border-border bg-surface px-2"
              style={{ width: CHANNEL_COL_PX, height: ROW_HEIGHT_PX }}
            >
              <span className="hmp-truncate text-sm text-foreground" title={channel.media.title}>
                {channel.media.title}
              </span>
              <button
                type="button"
                aria-label={`播放 ${channel.media.title} 当前直播`}
                className="shrink-0 rounded border border-border px-1.5 py-0.5 text-xs text-accent focus:outline-none focus-visible:ring-2 focus-visible:ring-focus hover:underline"
                onClick={() => {
                  onPlayChannel(channel.media.id, channel.media.title);
                }}
              >
                直播
              </button>
            </div>
            {/* 节目轴:相对定位 + 绝对位置节目块 */}
            <div className="relative shrink-0" style={{ width: spanPx, height: ROW_HEIGHT_PX }}>
              {channel.programmes.length === 0 ? (
                <span className="absolute left-2 top-1/2 -translate-y-1/2 text-xs text-muted">暂无节目</span>
              ) : (
                channel.programmes.map((programme) => {
                  const left = Math.min(Math.max(utcToPx(Date.parse(programme.startsAt), fromMs), 0), spanPx);
                  const right = Math.min(Math.max(utcToPx(Date.parse(programme.endsAt), fromMs), 0), spanPx);
                  const width = Math.max(right - left, 2);
                  const lane = lanes.get(programme.key) ?? 0;
                  const isCurrent = current?.key === programme.key;
                  const rangeLabel = `${formatTimeInZone(programme.startsAt, data.timezone)}–${formatTimeInZone(programme.endsAt, data.timezone)}`;
                  return (
                    <button
                      key={programme.key}
                      type="button"
                      // T025:详情返回焦点恢复锚(会话内存快照按 key 查块;不进 URL/storage)
                      data-programme-key={programme.key}
                      aria-label={`${channel.media.title},${programme.title},${rangeLabel}${isCurrent ? ',正在直播' : ''}`}
                      title={`${programme.title} ${rangeLabel}`}
                      onClick={() => {
                        onSelectProgramme({ mediaId: channel.media.id, channelTitle: channel.media.title, programme });
                      }}
                      className={`hmp-truncate hmp-tabular-nums absolute rounded border text-left text-xs focus:outline-none focus-visible:ring-2 focus-visible:ring-focus ${
                        selectedKey === programme.key
                          ? 'border-accent bg-accent/20 text-foreground'
                          : isCurrent
                            ? 'border-accent/60 bg-accent/10 text-foreground'
                            : 'border-border bg-surface-secondary text-muted'
                      }`}
                      style={{ left, width, top: (lane % MAX_LANES) * laneHeight + 3, height: laneHeight - 6, minHeight: 18 }}
                    >
                      <span className="hmp-truncate px-1">
                        {programme.title} {rangeLabel}
                        {isCurrent ? ' · 正在直播' : ''}
                      </span>
                    </button>
                  );
                })
              )}
            </div>
          </div>
        );
      })}
      {/* 当前时间标识(服务端 now;窗口内显示,含偏移标注) */}
      {hasNowInWindow ? (
        <div
          role="status"
          aria-label={`当前时间 ${formatTimeInZone(data.now, data.timezone)}(${zoneOffsetLabel(nowMs, data.timezone)})`}
          className="pointer-events-none absolute top-0 bottom-0 z-40 w-px bg-accent"
          style={{ left: CHANNEL_COL_PX + nowX }}
        >
          <span
            className="hmp-tabular-nums absolute top-7 -translate-x-1/2 rounded bg-accent px-1 text-[10px] text-accent-foreground"
          >
            {formatTimeInZone(data.now, data.timezone)}
          </span>
        </div>
      ) : null}
      {/* 底部留白:Px 比例说明(像素/分钟;不渲染附加时间) */}
      <span className="hmp-sr-only">{`${PX_PER_MINUTE} 像素每分钟`}</span>
    </div>
  );
}
