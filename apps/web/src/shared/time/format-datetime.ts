import { dayjs } from './dayjs';

/**
 * 管理/设置类时间戳的家庭时区格式化(dayjs 版)。
 *
 * 背景:设置域多处直接把服务端 UTC ISO 截成 `YYYY-MM-DD HH:mm` 展示,在
 * Asia/Shanghai 下会早 8 小时(「上次同步」「最近活跃」等)。此处统一按家庭
 * IANA 时区转换,与节目单/直播的时间条款保持一致:
 * - 时间非法:原样返回入参(不伪造);
 * - 家庭时区未知(设置查询未就绪):返回占位 `—`,不拿浏览器时区冒充;
 * - 时区 ID 非法:回退 UTC 并显式追加 ` UTC`,让读者知道基准。
 */
export const DATE_TIME_MINUTE_FORMAT = 'YYYY-MM-DD HH:mm';

export interface FormatDateTimeOptions {
  /** 输出到秒(`YYYY-MM-DD HH:mm:ss`);缺省到分 */
  readonly seconds?: boolean;
  /** 家庭时区未知时的占位文案(缺省 `—`) */
  readonly placeholder?: string;
}

export function formatDateTimeInZone(
  iso: string,
  timezone: string | null | undefined,
  options: FormatDateTimeOptions = {},
): string {
  const value = dayjs(iso);
  if (!value.isValid()) {
    return iso;
  }
  const zone = typeof timezone === 'string' ? timezone.trim() : '';
  if (zone === '') {
    return options.placeholder ?? '—';
  }
  const format = options.seconds === true ? `${DATE_TIME_MINUTE_FORMAT}:ss` : DATE_TIME_MINUTE_FORMAT;
  try {
    return value.tz(zone).format(format);
  } catch {
    return `${value.utc().format(format)} UTC`;
  }
}