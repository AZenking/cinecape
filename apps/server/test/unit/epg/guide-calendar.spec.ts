import { describe, expect, it } from 'vitest';
import { parseDate } from '@internationalized/date';
import {
  GUIDE_DATE_COUNT,
  GUIDE_MAX_SPAN_MS,
  addCalendarDays,
  allowedGuideDates,
  allowedOverallWindowMs,
  defaultGuideWindowMs,
  guideDateString,
  guideDayWindowMs,
  resolveGuideDayWindow,
  todayCalendarDateOf,
} from '../../../src/modules/epg/guide-calendar';

/**
 * EPG 日历日转换核心单元测试(T106;data-model.md §8 逐字):
 * - 「以固定 nowMs + Household IANA timezone 求今天,日期范围今天~today+6;
 *   7 个日历日整体区间 [todayStart,todayPlus7Start)」;
 * - 「使用直接依赖 @internationalized/date@3.12.4 的 CalendarDate、fromAbsolute、
 *   toCalendarDate、parseDate、toZoned(date,zone,'compatible');相邻日历日期分别转换为
 *   UTC 日界。该版本无 startOfDay 导出,不采用此 API;禁止简单加 24 小时构造日期边界」
 *   —— DST 23/25 小时日(America/New_York 2026-03-08 / 2026-11-01)按 IANA 真实日界,
 *   若实现采用 +24h 构造,23/25 小时断言必然失败;
 * - 「家庭跨日后过期 date 返回 409 GUIDE_DATE_EXPIRED 和新的 allowedDates」语义在纯层
 *   以 reason:'expired' + allowedDates 表达(409 渲染由 guide-window.service 承担)。
 *
 * 全部用例固定 nowMs,不读系统时钟。
 */

const CST = 'Asia/Shanghai';
const NY = 'America/New_York';

function utc(isoUtc: string): number {
  const ms = Date.parse(isoUtc);
  expect(Number.isNaN(ms)).toBe(false);
  return ms;
}

describe('guide-calendar:今天与 7 个日历日(T106)', () => {
  it('固定 now + 家庭时区求今天:2026-11-04T12:05Z 在 Asia/Shanghai 为 2026-11-04(20:05 CST)', () => {
    const nowMs = utc('2026-11-04T12:05:00.000Z');
    const today = todayCalendarDateOf(nowMs, CST);
    expect(guideDateString(today)).toBe('2026-11-04');
  });

  it('同一时刻在 America/New_York 为 2026-11-04(07:05 EST)——今天由家庭时区决定,不由 UTC/浏览器决定', () => {
    const nowMs = utc('2026-11-04T12:05:00.000Z');
    expect(guideDateString(todayCalendarDateOf(nowMs, NY))).toBe('2026-11-04');
    // UTC 日期同为 11-04,但取 16:30Z 这类跨日时刻时两者分野(见下一用例)
  });

  it('UTC 日期已翻日而家庭时区未翻日:15:59Z 在 CST 仍为前一天', () => {
    const nowMs = utc('2026-11-04T15:59:00.000Z'); // 23:59 CST 11-04 / 10:59 EST 11-04
    expect(guideDateString(todayCalendarDateOf(nowMs, CST))).toBe('2026-11-04');
    const rolled = utc('2026-11-04T16:00:00.000Z'); // 00:00 CST 11-05
    expect(guideDateString(todayCalendarDateOf(rolled, CST))).toBe('2026-11-05');
  });

  it('allowedDates 恰为今天~today+6 共 7 个日历日', () => {
    const nowMs = utc('2026-11-04T12:05:00.000Z');
    expect(GUIDE_DATE_COUNT).toBe(7);
    expect(allowedGuideDates(nowMs, CST)).toEqual([
      '2026-11-04',
      '2026-11-05',
      '2026-11-06',
      '2026-11-07',
      '2026-11-08',
      '2026-11-09',
      '2026-11-10',
    ]);
  });

  it('7 个日历日整体区间 = [todayStart, todayPlus7Start)(相邻日历日分别转换,非 7×24h 累加)', () => {
    const nowMs = utc('2026-11-04T12:05:00.000Z');
    const overall = allowedOverallWindowMs(nowMs, CST);
    expect(overall.fromMs).toBe(utc('2026-11-03T16:00:00.000Z')); // 11-04 00:00 CST
    expect(overall.toMs).toBe(utc('2026-11-10T16:00:00.000Z')); // 11-11 00:00 CST
    expect(overall.toMs - overall.fromMs).toBe(7 * 24 * 3_600_000);
  });

  it('家庭时区跨日后 allowedDates 滚动:23:59 CST 与次日 00:00 CST 给出不同 7 天范围', () => {
    const before = allowedGuideDates(utc('2026-11-10T15:59:00.000Z'), CST);
    expect(before[0]).toBe('2026-11-10');
    expect(before[6]).toBe('2026-11-16');
    const after = allowedGuideDates(utc('2026-11-10T16:00:00.000Z'), CST);
    expect(after[0]).toBe('2026-11-11');
    expect(after[6]).toBe('2026-11-17');
  });
});

describe('guide-calendar:DST 23/25 小时日按 IANA 真实日界(T106;禁止 +24h 构造)', () => {
  it('America/New_York 2026-03-08(春令时)为 23 小时日:[05:00Z, 次日 04:00Z)', () => {
    const day = guideDayWindowMs(parseDate('2026-03-08'), NY);
    expect(day.fromMs).toBe(utc('2026-03-08T05:00:00.000Z'));
    expect(day.toMs).toBe(utc('2026-03-09T04:00:00.000Z'));
    expect(day.toMs - day.fromMs).toBe(23 * 3_600_000);
  });

  it('America/New_York 2026-11-01(秋令时)为 25 小时日:[04:00Z, 次日 05:00Z)', () => {
    const day = guideDayWindowMs(parseDate('2026-11-01'), NY);
    expect(day.fromMs).toBe(utc('2026-11-01T04:00:00.000Z'));
    expect(day.toMs).toBe(utc('2026-11-02T05:00:00.000Z'));
    expect(day.toMs - day.fromMs).toBe(25 * 3_600_000);
  });

  it('普通日恒为 24 小时(2026-06-01,EDT)', () => {
    const day = guideDayWindowMs(parseDate('2026-06-01'), NY);
    expect(day.fromMs).toBe(utc('2026-06-01T04:00:00.000Z'));
    expect(day.toMs - day.fromMs).toBe(24 * 3_600_000);
  });

  it('含 DST 日的 7 天整体区间按真实日长累计:today=2026-03-07 → 总长 167 小时(非 168)', () => {
    const nowMs = utc('2026-03-07T10:00:00.000Z'); // 05:00 EST 03-07
    expect(guideDateString(todayCalendarDateOf(nowMs, NY))).toBe('2026-03-07');
    const overall = allowedOverallWindowMs(nowMs, NY);
    expect(overall.fromMs).toBe(utc('2026-03-07T05:00:00.000Z'));
    expect(overall.toMs).toBe(utc('2026-03-14T04:00:00.000Z'));
    expect(overall.toMs - overall.fromMs).toBe(167 * 3_600_000);
  });

  it('addCalendarDays 只移动日历日,不承担时长语义(2026-03-08 +1 = 2026-03-09)', () => {
    expect(guideDateString(addCalendarDays(parseDate('2026-03-08'), 1))).toBe('2026-03-09');
    expect(guideDateString(addCalendarDays(parseDate('2026-11-01'), 6))).toBe('2026-11-07');
  });
});

describe('guide-calendar:默认窗口「现在前 30 分钟起 6 小时」裁剪日界(T106/T116 A-008)', () => {
  it('now-30min 起整整 6 小时且都在日内(16:05 CST 起)→ 直接采用不裁剪', () => {
    const nowMs = utc('2026-11-04T08:05:00.000Z'); // 16:05 CST
    const day = guideDayWindowMs(parseDate('2026-11-04'), CST);
    const win = defaultGuideWindowMs(nowMs, day);
    expect(win.fromMs).toBe(utc('2026-11-04T07:35:00.000Z'));
    expect(win.toMs).toBe(utc('2026-11-04T13:35:00.000Z'));
  });

  it('now+5.5h 越过当日日界(20:05 CST)→ 终点裁剪到真实日界(from 不变)', () => {
    const nowMs = utc('2026-11-04T12:05:00.000Z'); // 20:05 CST
    const day = guideDayWindowMs(parseDate('2026-11-04'), CST);
    const win = defaultGuideWindowMs(nowMs, day);
    expect(win.fromMs).toBe(utc('2026-11-04T11:35:00.000Z'));
    expect(win.toMs).toBe(utc('2026-11-04T16:00:00.000Z')); // 24:00 CST(裁剪)
  });

  it('now-30min 落在前一日历日(家庭时区凌晨 00:10)→ 起点裁剪到当天真实日界', () => {
    const nowMs = utc('2026-11-04T16:10:00.000Z'); // 00:10 CST 11-05
    const day = guideDayWindowMs(parseDate('2026-11-05'), CST);
    const win = defaultGuideWindowMs(nowMs, day);
    expect(win.fromMs).toBe(utc('2026-11-04T16:00:00.000Z')); // 00:00 CST(裁剪)
    expect(win.toMs).toBe(utc('2026-11-04T21:40:00.000Z')); // 05:40 CST
  });

  it('now+5.5h 越过当日日界(20:00 CST 起 6 小时)→ 终点裁剪到真实日界', () => {
    const nowMs = utc('2026-11-04T12:00:00.000Z'); // 20:00 CST
    const day = guideDayWindowMs(parseDate('2026-11-04'), CST);
    const win = defaultGuideWindowMs(nowMs, day);
    expect(win.fromMs).toBe(utc('2026-11-04T11:30:00.000Z'));
    expect(win.toMs).toBe(utc('2026-11-04T16:00:00.000Z')); // 24:00 CST(裁剪)
  });
});

describe('guide-calendar:resolveGuideDayWindow 纯校验(409/400/422 语义来源)', () => {
  const NOW = utc('2026-11-06T12:05:00.000Z'); // 20:05 CST,今天 = 2026-11-06

  it('缺省 date+from/to → 今天 + 默认窗口(允许日期与窗口同响应)', () => {
    const result = resolveGuideDayWindow({ nowMs: NOW, timezone: CST });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.date).toBe('2026-11-06');
    expect(result.allowedDates).toHaveLength(7);
    expect(result.allowedDates[0]).toBe('2026-11-06');
    expect(result.allowedDates[6]).toBe('2026-11-12');
    expect(result.window.fromMs).toBe(utc('2026-11-06T11:35:00.000Z'));
    expect(result.window.toMs).toBe(utc('2026-11-06T16:00:00.000Z')); // 20:05 CST 起 6h 越日界 → 裁剪
  });

  it('昨天(家庭时区)→ reason expired + 新 allowedDates(409 GUIDE_DATE_EXPIRED 语义)', () => {
    const result = resolveGuideDayWindow({ nowMs: NOW, timezone: CST, date: '2026-11-05' });
    expect(result.ok).toBe(false);
    if (result.ok || result.reason !== 'expired') throw new Error(`期望 expired,实得 ${JSON.stringify(result)}`);
    expect(result.allowedDates[0]).toBe('2026-11-06');
    expect(result.allowedDates[6]).toBe('2026-11-12');
  });

  it('刚跨日:昨天的今天立即过期(allowedDates 滚动后同 date 判 expired)', () => {
    const beforeMidnight = utc('2026-11-10T15:59:00.000Z');
    const afterMidnight = utc('2026-11-10T16:00:00.000Z');
    expect(resolveGuideDayWindow({ nowMs: beforeMidnight, timezone: CST, date: '2026-11-10' }).ok).toBe(true);
    const result = resolveGuideDayWindow({ nowMs: afterMidnight, timezone: CST, date: '2026-11-10' });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('expired');
  });

  it('尚未到允许未来范围(today+7)→ reason beyond(400 VALIDATION_FAILED 语义)', () => {
    const result = resolveGuideDayWindow({ nowMs: NOW, timezone: CST, date: '2026-11-13' });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('beyond');
  });

  it('today+6 恰好允许(today+7 不允许)', () => {
    expect(resolveGuideDayWindow({ nowMs: NOW, timezone: CST, date: '2026-11-12' }).ok).toBe(true);
  });

  it('显式 from/to 在该日真实边界内且跨度≤6h → ok', () => {
    const result = resolveGuideDayWindow({
      nowMs: NOW,
      timezone: CST,
      date: '2026-11-08',
      fromMs: utc('2026-11-07T18:00:00.000Z'), // 11-08 02:00 CST
      toMs: utc('2026-11-07T21:00:00.000Z'), // 11-08 05:00 CST
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.window.fromMs).toBe(utc('2026-11-07T18:00:00.000Z'));
      expect(result.window.toMs).toBe(utc('2026-11-07T21:00:00.000Z'));
    }
  });

  it('from 早于该日真实日界(跨日)→ reason window(422 GUIDE_WINDOW_TOO_LARGE 语义)', () => {
    const result = resolveGuideDayWindow({
      nowMs: NOW,
      timezone: CST,
      date: '2026-11-08',
      fromMs: utc('2026-11-07T15:00:00.000Z'), // 前一日 23:00 CST < 日界
      toMs: utc('2026-11-07T18:00:00.000Z'),
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('window');
  });

  it('to 晚于该日真实日界(跨日)→ reason window', () => {
    const result = resolveGuideDayWindow({
      nowMs: NOW,
      timezone: CST,
      date: '2026-11-08',
      fromMs: utc('2026-11-07T20:00:00.000Z'),
      toMs: utc('2026-11-08T17:00:00.000Z'), // 越过 16:00Z 日界
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('window');
  });

  it('跨度 > 6 小时 → reason window(GUIDE_MAX_SPAN_MS 恒为 6h)', () => {
    expect(GUIDE_MAX_SPAN_MS).toBe(6 * 3_600_000);
    const result = resolveGuideDayWindow({
      nowMs: NOW,
      timezone: CST,
      date: '2026-11-08',
      fromMs: utc('2026-11-07T16:30:00.000Z'),
      toMs: utc('2026-11-07T23:00:00.000Z'), // 6.5h
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('window');
  });

  it('to <= from(倒置窗口,非法输入)→ reason inverted(400 VALIDATION_FAILED 语义)', () => {
    const equal = resolveGuideDayWindow({
      nowMs: NOW,
      timezone: CST,
      date: '2026-11-08',
      fromMs: utc('2026-11-07T18:00:00.000Z'),
      toMs: utc('2026-11-07T18:00:00.000Z'),
    });
    expect(equal.ok).toBe(false);
    if (!equal.ok) expect(equal.reason).toBe('inverted');
    const reversed = resolveGuideDayWindow({
      nowMs: NOW,
      timezone: CST,
      date: '2026-11-08',
      fromMs: utc('2026-11-07T19:00:00.000Z'),
      toMs: utc('2026-11-07T18:00:00.000Z'),
    });
    expect(reversed.ok).toBe(false);
    if (!reversed.ok) expect(reversed.reason).toBe('inverted');
  });

  it('恰好 6 小时且贴齐日界 → ok(边界含起不含止的窗口语义允许)', () => {
    const result = resolveGuideDayWindow({
      nowMs: NOW,
      timezone: CST,
      date: '2026-11-08',
      fromMs: utc('2026-11-07T16:00:00.000Z'),
      toMs: utc('2026-11-07T22:00:00.000Z'),
    });
    expect(result.ok).toBe(true);
  });

  it('DST 23 小时日(NY 2026-03-08)内 6 小时显式窗口照常有效;窗口按真实日界判定', () => {
    const result = resolveGuideDayWindow({
      nowMs: utc('2026-03-07T10:00:00.000Z'),
      timezone: NY,
      date: '2026-03-08',
      fromMs: utc('2026-03-08T05:00:00.000Z'), // 00:00 EST(真实日界)
      toMs: utc('2026-03-08T10:00:00.000Z'),
    });
    expect(result.ok).toBe(true);
    const crossing = resolveGuideDayWindow({
      nowMs: utc('2026-03-07T10:00:00.000Z'),
      timezone: NY,
      date: '2026-03-08',
      fromMs: utc('2026-03-08T06:00:00.000Z'),
      toMs: utc('2026-03-09T04:30:00.000Z'), // 越过 23 小时日的真实终点 04:00Z
    });
    expect(crossing.ok).toBe(false);
    if (!crossing.ok) expect(crossing.reason).toBe('window');
  });
});
