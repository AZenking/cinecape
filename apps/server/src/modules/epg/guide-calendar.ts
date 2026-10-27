import { fromAbsolute, parseDate, toCalendarDate, toZoned, type CalendarDate } from '@internationalized/date';

/**
 * EPG 日历日转换核心(T113;data-model.md §8 逐字;T106 单测钉住):
 *
 * 「以固定 nowMs + Household IANA timezone 求今天,日期范围今天~today+6;
 *   7 个日历日整体区间 [todayStart,todayPlus7Start)。
 *   使用直接依赖 @internationalized/date@3.12.4 的 CalendarDate、fromAbsolute、
 *   toCalendarDate、parseDate、toZoned(date,zone,'compatible');
 *   相邻日历日期分别转换为 UTC 日界。
 *   该版本无 startOfDay 导出,不采用此 API;禁止简单加 24 小时构造日期边界。」
 *
 * - 日界:对日历日与其相邻日分别 toZoned(…,'compatible').toDate() 取 UTC 毫秒,
 *   因此 DST 23/25 小时日(America/New_York 2026-03-08 / 2026-11-01)按 IANA 真实日界;
 * - 本模块为纯函数:全部时间以入参 nowMs 固定,不读系统时钟,不做 IO。
 */

/** 可浏览日历日数(今天~today+6) */
export const GUIDE_DATE_COUNT = 7;

/** 默认窗口起点回看量(「现在前 30 分钟起 6 小时」,A-008) */
export const GUIDE_LOOKBACK_MS = 30 * 60_000;

/** 默认窗口跨度 = 单窗口上限(契约「单日内连续<=6小时窗口」) */
export const GUIDE_DEFAULT_SPAN_MS = 6 * 3_600_000;

/** 单窗口跨度上限(「跨度<=6 小时」) */
export const GUIDE_MAX_SPAN_MS = 6 * 3_600_000;

/** 家庭时区下的「今天」日历日(toCalendarDate(fromAbsolute(nowMs, zone))) */
export function todayCalendarDateOf(nowMs: number, timezone: string): CalendarDate {
  return toCalendarDate(fromAbsolute(nowMs, timezone));
}

/** 日历日加減(仅移动日历日;时长语义一律经 guideDayWindowMs 换算) */
export function addCalendarDays(date: CalendarDate, days: number): CalendarDate {
  return date.add({ days });
}

/** 日历日 → 'YYYY-MM-DD'(Gregorian 下 toString 即 ISO 日期) */
export function guideDateString(date: CalendarDate): string {
  return date.toString();
}

/** 'YYYY-MM-DD' → 日历日(T004 锁定依赖的 parseDate;非法格式由调用方 zod 管道先行拒绝) */
export function guideDateOf(value: string): CalendarDate {
  return parseDate(value);
}

/** 该日历日在家庭时区的真实 UTC 边界 [dayStart, nextDayStart)(相邻日分别转换,DST 真实日长) */
export function guideDayWindowMs(date: CalendarDate, timezone: string): { readonly fromMs: number; readonly toMs: number } {
  const fromMs = toZoned(date, timezone, 'compatible').toDate().getTime();
  const toMs = toZoned(addCalendarDays(date, 1), timezone, 'compatible').toDate().getTime();
  return { fromMs, toMs };
}

/** 允许日期集合(今天~today+6 的 7 个 'YYYY-MM-DD') */
export function allowedGuideDates(nowMs: number, timezone: string): string[] {
  const today = todayCalendarDateOf(nowMs, timezone);
  const dates: string[] = [];
  for (let index = 0; index < GUIDE_DATE_COUNT; index += 1) {
    dates.push(guideDateString(addCalendarDays(today, index)));
  }
  return dates;
}

/** 7 个日历日整体区间 [todayStart, todayPlus7Start)(逐日转换后取首尾,DST 周期按真实日长) */
export function allowedOverallWindowMs(nowMs: number, timezone: string): { readonly fromMs: number; readonly toMs: number } {
  const today = todayCalendarDateOf(nowMs, timezone);
  const from = guideDayWindowMs(today, timezone);
  const last = guideDayWindowMs(addCalendarDays(today, GUIDE_DATE_COUNT - 1), timezone);
  return { fromMs: from.fromMs, toMs: last.toMs };
}

/** 日历日是否在 [today, today+6] 内(基于日历日比较,不经毫秒折算) */
function isAllowedDate(date: CalendarDate, today: CalendarDate): boolean {
  if (date.compare(today) < 0) {
    return false;
  }
  return date.compare(addCalendarDays(today, GUIDE_DATE_COUNT - 1)) <= 0;
}

/**
 * 默认窗口:「现在前 30 分钟起 6 小时」裁剪到该日真实边界(A-008、ui.md §6「裁剪日界」)。
 * 若默认窗口与该日完全不相交(纯未来日),回落到该日前 6 小时([dayStart, min(dayStart+6h, dayEnd)])。
 */
export function defaultGuideWindowMs(nowMs: number, day: { readonly fromMs: number; readonly toMs: number }): {
  readonly fromMs: number;
  readonly toMs: number;
} {
  const rawFrom = nowMs - GUIDE_LOOKBACK_MS;
  const rawTo = rawFrom + GUIDE_DEFAULT_SPAN_MS;
  const fromMs = Math.max(rawFrom, day.fromMs);
  const toMs = Math.min(rawTo, day.toMs);
  if (fromMs < toMs) {
    return { fromMs, toMs };
  }
  // 默认窗口与该日无交集:回落该日首个 6 小时(仍受真实日界与跨度上限约束)
  return { fromMs: day.fromMs, toMs: Math.min(day.fromMs + GUIDE_DEFAULT_SPAN_MS, day.toMs) };
}

/** 纯校验拒绝原因(409/400/422 语义来源;HTTP 渲染由 guide-window.service 承担) */
export type GuideWindowRejection =
  | { readonly reason: 'expired'; readonly allowedDates: readonly string[] }
  | { readonly reason: 'beyond' }
  | { readonly reason: 'window' }
  | { readonly reason: 'inverted' };

export type GuideWindowResolution =
  | {
      readonly ok: true;
      readonly date: string;
      readonly allowedDates: readonly string[];
      readonly window: { readonly fromMs: number; readonly toMs: number };
    }
  | ({ readonly ok: false } & GuideWindowRejection);

export interface GuideDayWindowInput {
  readonly nowMs: number;
  readonly timezone: string;
  /** 'YYYY-MM-DD';缺省 = 家庭今天(非法格式调用方先行 400,此处视为编程错误) */
  readonly date?: string;
  readonly fromMs?: number;
  readonly toMs?: number;
}

/**
 * 解析一次 guide 查询的日期与窗口(纯校验,不查询数据):
 * - date < 今天 → expired(409 GUIDE_DATE_EXPIRED 语义,携带新 allowedDates);
 * - date > today+6 → beyond(400 VALIDATION_FAILED 语义,「尚未到允许未来范围」);
 * - 显式 from/to:to<=from → inverted(400,非法输入);跨出该日真实边界或跨度>6h →
 *   window(422 GUIDE_WINDOW_TOO_LARGE 语义,「跨日或>6小时」);
 * - 缺省 from/to → 默认窗口(现在前 30 分钟起 6 小时,裁剪日界)。
 */
export function resolveGuideDayWindow(input: GuideDayWindowInput): GuideWindowResolution {
  const { nowMs, timezone } = input;
  const today = todayCalendarDateOf(nowMs, timezone);
  const allowedDates = allowedGuideDates(nowMs, timezone);
  const requested = input.date === undefined ? today : guideDateOf(input.date);
  if (!isAllowedDate(requested, today)) {
    // 日历日早于今天 → 已过期(含跨日滚动后原「今天」);晚于 today+6 → 尚未开放
    return requested.compare(today) < 0
      ? { ok: false, reason: 'expired', allowedDates }
      : { ok: false, reason: 'beyond' };
  }
  const day = guideDayWindowMs(requested, timezone);
  if (input.fromMs !== undefined || input.toMs !== undefined) {
    // from/to 必须成对提供(调用方 schema 保证同现;此处只做窗口形态校验)
    const fromMs = input.fromMs;
    const toMs = input.toMs;
    if (fromMs === undefined || toMs === undefined) {
      return { ok: false, reason: 'inverted' };
    }
    if (toMs <= fromMs) {
      return { ok: false, reason: 'inverted' };
    }
    if (fromMs < day.fromMs || toMs > day.toMs || toMs - fromMs > GUIDE_MAX_SPAN_MS) {
      return { ok: false, reason: 'window' };
    }
    return { ok: true, date: guideDateString(requested), allowedDates, window: { fromMs, toMs } };
  }
  return { ok: true, date: guideDateString(requested), allowedDates, window: defaultGuideWindowMs(nowMs, day) };
}
