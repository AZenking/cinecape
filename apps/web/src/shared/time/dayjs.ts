/**
 * dayjs 统一配置(前端时间处理的唯一入口)。
 *
 * - 只在这里注册插件,业务代码一律 `import { dayjs } from 'shared/time/dayjs'`,
 *   禁止直接 `import dayjs from 'dayjs'`——避免插件重复 extend 与行为分叉;
 * - utc + timezone 插件:所有跨时区展示都显式 `dayjs(iso).tz(家庭时区)`,
 *   不读浏览器本地时区(与 live-format / guide-time 的时区条款一致);
 * - EPG 日历日与 DST 日界的 CalendarDate 语义仍由 @internationalized/date 承担
 *   (spec data-model §8 锁定),dayjs 不替代那部分。
 */
import dayjs from 'dayjs';
import timezone from 'dayjs/plugin/timezone';
import utc from 'dayjs/plugin/utc';

dayjs.extend(utc);
dayjs.extend(timezone);

export { dayjs };
export type { Dayjs } from 'dayjs';