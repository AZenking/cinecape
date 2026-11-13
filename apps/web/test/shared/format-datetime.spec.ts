import { describe, expect, it } from 'vitest';
import { formatDateTimeInZone } from '../../src/shared/time/format-datetime';

/**
 * format-datetime 单测(设置域时间戳按家庭时区展示):
 * - 服务端时间戳一律 UTC ISO,展示必须换算到家庭 IANA 时区(Asia/Shanghai = +8);
 * - 跨日换算不截断日期;
 * - 家庭时区未知时返回占位,不拿浏览器时区冒充;
 * - 非法时间原样返回,非法时区回退 UTC 并显式标注。
 */
describe('formatDateTimeInZone', () => {
  it('UTC ISO 按家庭时区展示到秒', () => {
    expect(formatDateTimeInZone('2026-11-13T07:55:09.000Z', 'Asia/Shanghai', { seconds: true })).toBe(
      '2026-11-13 15:55:09',
    );
  });

  it('缺省到分,并正确跨日', () => {
    expect(formatDateTimeInZone('2026-11-13T16:05:00.000Z', 'Asia/Shanghai')).toBe('2026-11-14 00:05');
  });

  it('家庭时区未知返回占位', () => {
    expect(formatDateTimeInZone('2026-11-13T07:55:00.000Z', null)).toBe('—');
    expect(formatDateTimeInZone('2026-11-13T07:55:00.000Z', '  ')).toBe('—');
  });

  it('非法时间原样返回', () => {
    expect(formatDateTimeInZone('not-a-date', 'Asia/Shanghai')).toBe('not-a-date');
  });

  it('非法时区回退 UTC 并标注', () => {
    expect(formatDateTimeInZone('2026-11-13T07:55:00.000Z', 'Not/AZone')).toBe('2026-11-13 07:55 UTC');
  });
});