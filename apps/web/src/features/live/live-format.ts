import { dayjs, type Dayjs } from '../../shared/time/dayjs';

/**
 * 直播时间呈现(T068;R8「服务端返回 now/timezone/revision,避免依赖浏览器本地时区」、
 * FR-022「时间按家庭时区显示并标注」):
 * - 一律以服务端响应携带的 IANA timezone 显式转换(dayjs utc/timezone 插件,
 *   与 shared/time/dayjs 同一配置),绝不使用浏览器本地时区;
 * - 时刻显示 HH:mm(24 小时),日期显示 M/D;区间用「起–止」;
 * - 时区标注:IANA 名称 + UTC 偏移(GMT±H),随分区头部一次标注。
 */

/**
 * ISO → 家庭时区的 dayjs 实例;无效时区降级 UTC,无效时刻返回 null
 * (调用方回退原文,渲染不抛错)。
 */
function zonedOrNull(iso: string, timezone: string): Dayjs | null {
  const value = dayjs(iso);
  if (!value.isValid()) {
    return null;
  }
  try {
    return value.tz(timezone);
  } catch {
    return value.utc();
  }
}

/** 时刻 HH:mm(家庭时区;等宽数字渲染由样式类承担) */
export function formatTimeInZone(iso: string, timezone: string): string {
  const zoned = zonedOrNull(iso, timezone);
  return zoned === null ? iso : zoned.format('HH:mm');
}

/** 日期 M/D(家庭时区) */
export function formatDayInZone(iso: string, timezone: string): string {
  const zoned = zonedOrNull(iso, timezone);
  return zoned === null ? iso : zoned.format('M/D');
}

/** 起止区间「HH:mm–HH:mm」;跨日时止侧附 (次日 M/D) */
export function formatRangeInZone(startsAt: string, endsAt: string, timezone: string): string {
  const start = zonedOrNull(startsAt, timezone);
  const end = zonedOrNull(endsAt, timezone);
  if (start === null || end === null) {
    return `${startsAt}–${endsAt}`;
  }
  const startLabel = start.format('HH:mm');
  const endLabel = end.format('HH:mm');
  if (start.format('YYYY-MM-DD') !== end.format('YYYY-MM-DD')) {
    return `${startLabel}–${endLabel} (次日 ${end.format('M/D')})`;
  }
  return `${startLabel}–${endLabel}`;
}

/** 时区标注:IANA 名称 + 偏移(如「Asia/Shanghai · GMT+8」);偏移取自服务端时刻本身 */
export function formatZoneLabel(timezone: string, serverNowIso: string): string {
  const zoned = zonedOrNull(serverNowIso, timezone);
  if (zoned === null) {
    return timezone;
  }
  const totalMinutes = zoned.utcOffset();
  const sign = totalMinutes < 0 ? '-' : '+';
  const abs = Math.abs(totalMinutes);
  const hours = Math.floor(abs / 60);
  const minutes = abs % 60;
  const offset = minutes === 0 ? `GMT${sign}${hours}` : `GMT${sign}${hours}:${String(minutes).padStart(2, '0')}`;
  return `${timezone} · ${offset}`;
}