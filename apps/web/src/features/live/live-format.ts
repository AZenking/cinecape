import { parseAbsolute } from '@internationalized/date';

/**
 * 直播时间呈现(T068;R8「服务端返回 now/timezone/revision,避免依赖浏览器本地时区」、
 * FR-022「时间按家庭时区显示并标注」):
 * - 一律以服务端响应携带的 IANA timezone 显式转换(data-model §8 同源
 *   @internationalized/date 依赖),绝不使用浏览器本地时区;
 * - 时刻显示 HH:mm(24 小时),日期显示 M/D;区间用「起–止」;
 * - 时区标注:IANA 名称 + UTC 偏移(GMT±H),随分区头部一次标注。
 */

function toZonedOrNull(iso: string, timezone: string): ReturnType<typeof parseAbsolute> | null {
  // 无效时区降级 UTC;无效时刻(存储/传输损坏)返回 null,调用方回退原文,渲染不抛错
  try {
    return parseAbsolute(iso, timezone);
  } catch {
    try {
      return parseAbsolute(iso, 'UTC');
    } catch {
      return null;
    }
  }
}

function pad2(value: number): string {
  return value < 10 ? `0${value}` : String(value);
}

/** 时刻 HH:mm(家庭时区;等宽数字渲染由样式类承担) */
export function formatTimeInZone(iso: string, timezone: string): string {
  const zoned = toZonedOrNull(iso, timezone);
  return zoned === null ? iso : `${pad2(zoned.hour)}:${pad2(zoned.minute)}`;
}

/** 日期 M/D(家庭时区) */
export function formatDayInZone(iso: string, timezone: string): string {
  const zoned = toZonedOrNull(iso, timezone);
  return zoned === null ? iso : `${zoned.month}/${zoned.day}`;
}

/** 起止区间「HH:mm–HH:mm」;跨日时止侧附 (次日 M/D) */
export function formatRangeInZone(startsAt: string, endsAt: string, timezone: string): string {
  const start = toZonedOrNull(startsAt, timezone);
  const end = toZonedOrNull(endsAt, timezone);
  if (start === null || end === null) {
    return `${startsAt}–${endsAt}`;
  }
  const startLabel = `${pad2(start.hour)}:${pad2(start.minute)}`;
  const endLabel = `${pad2(end.hour)}:${pad2(end.minute)}`;
  if (start.day !== end.day || start.month !== end.month) {
    return `${startLabel}–${endLabel} (次日 ${formatDayInZone(endsAt, timezone)})`;
  }
  return `${startLabel}–${endLabel}`;
}

/** 时区标注:IANA 名称 + 偏移(如「Asia/Shanghai · GMT+8」);偏移取自服务端时刻本身 */
export function formatZoneLabel(timezone: string, serverNowIso: string): string {
  const zoned = toZonedOrNull(serverNowIso, timezone);
  if (zoned === null) {
    return timezone;
  }
  const totalMinutes = zoned.offset / 60_000;
  const sign = totalMinutes < 0 ? '-' : '+';
  const abs = Math.abs(totalMinutes);
  const hours = Math.floor(abs / 60);
  const minutes = abs % 60;
  const offset = minutes === 0 ? `GMT${sign}${hours}` : `GMT${sign}${hours}:${pad2(minutes)}`;
  return `${timezone} · ${offset}`;
}
