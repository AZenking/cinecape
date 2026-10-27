import { fromAbsolute, parseDate, toCalendarDate, toZoned } from '@internationalized/date';

/**
 * EPG 前端时间轴工具(T116/T117;data-model.md §8 同源约束):
 * - 与服务端同一 @internationalized/date 直接依赖(3.12.4,无 startOfDay 导出):
 *   日界由「日历日与其相邻日分别 toZoned(date,zone,'compatible')」求得,
 *   禁止简单加 24 小时构造日界;DST 23/25 小时日按 IANA 真实日长;
 * - 节目位置一律用同一 UTC 坐标轴(UTC 毫秒差 × px/分钟)计算,
 *   显示时才按家庭时区格式化(formatTimeInZone/formatZoneLabel 复用 live-format);
 * - DST 重复小时:整点刻度按真实 UTC 时刻推进,本地标签重复时附加 GMT 偏移;
 *   缺失小时不补造(刻度只产生于窗口内真实存在的 UTC 整点)。
 */

/** 墙面横向比例(像素/分钟;6 小时窗 = 720px 内容宽) */
export const PX_PER_MINUTE = 2;

/** 单个日历日在家庭时区的真实 UTC 边界 [fromMs, toMs) */
export function guideDayBoundsMs(date: string, timezone: string): { readonly fromMs: number; readonly toMs: number } {
  const day = parseDate(date);
  const fromMs = toZoned(day, timezone, 'compatible').toDate().getTime();
  const toMs = toZoned(day.add({ days: 1 }), timezone, 'compatible').toDate().getTime();
  return { fromMs, toMs };
}

/** 'YYYY-MM-DD' + 家庭时区 → 该日 00:00 的本地日历标签(M/D) */
export function guideDateLabel(date: string, timezone: string): string {
  try {
    const zoned = toZoned(parseDate(date), timezone, 'compatible');
    return `${zoned.month}月${zoned.day}日`;
  } catch {
    return date;
  }
}

/** 时刻 HH:mm(家庭时区;复用 live-format 的服务端时区语义) */
export { formatTimeInZone, formatRangeInZone, formatZoneLabel } from '../live/live-format';

/** UTC 毫秒 → 窗口内像素 x(不裁剪;调用方负责 clamp 到 [0, spanPx]) */
export function utcToPx(ms: number, windowFromMs: number): number {
  return ((ms - windowFromMs) / 60_000) * PX_PER_MINUTE;
}

/** 窗口总像素宽 */
export function windowSpanPx(windowFromMs: number, windowToMs: number): number {
  return Math.max(0, ((windowToMs - windowFromMs) / 60_000) * PX_PER_MINUTE);
}

/** 窗口内真实 UTC 整点刻度(DST 重复/缺失自然呈现;标签重复时附偏移) */
export function hourTicksInWindow(windowFromMs: number, windowToMs: number, timezone: string): {
  readonly ms: number;
  readonly label: string;
}[] {
  const ticks: { ms: number; label: string }[] = [];
  // 第一个 ≥ from 的 UTC 整点(3600_000 对齐;窗口边界由真实日界派生,不需要本地对齐)
  const firstHour = Math.ceil(windowFromMs / 3_600_000) * 3_600_000;
  const seen = new Map<string, number>();
  for (let ms = firstHour; ms < windowToMs; ms += 3_600_000) {
    const zoned = toCalendarDate(fromAbsolute(ms, timezone));
    void zoned;
    let label: string;
    try {
      const time = toZoned(fromAbsolute(ms, timezone), timezone, 'compatible');
      const hh = `${time.hour < 10 ? '0' : ''}${time.hour}:00`;
      // 重复本地标签(DST 秋季回拨):附加 GMT 偏移区分,不补造缺失小时
      const count = seen.get(hh) ?? 0;
      seen.set(hh, count + 1);
      label = count === 0 ? hh : `${hh} (GMT${time.offset < 0 ? '-' : '+'}${Math.abs(time.offset / 3_600_000)})`;
    } catch {
      label = new Date(ms).toISOString().slice(11, 16);
    }
    ticks.push({ ms, label });
  }
  return ticks;
}

/** 家庭时区当前偏移标签(GMT±H;用于「重复小时」与头部标注) */
export function zoneOffsetLabel(ms: number, timezone: string): string {
  try {
    const time = toZoned(fromAbsolute(ms, timezone), timezone, 'compatible');
    const hours = time.offset / 3_600_000;
    return `GMT${hours < 0 || Object.is(hours, -0) ? '-' : '+'}${Math.abs(hours)}`;
  } catch {
    return 'GMT+0';
  }
}
