import dayjs from 'dayjs';
import timezone from 'dayjs/plugin/timezone';
import utc from 'dayjs/plugin/utc';

/**
 * 服务端 dayjs 统一配置(platform/time)。
 *
 * 边界(遵循 007 依赖矩阵):
 * - 只允许 application / interface / infrastructure 层经 `@platform/time` 引用;
 * - **domain 层不引入 dayjs**——领域纯函数只用 epoch ms 运算(domain → platform 禁止),
 *   EPG 日历日/DST 日界继续由 @internationalized/date 承担(既有合法残留);
 * - 存储与传输仍是 UTC ISO:所有 `now`/时间戳出口经 `toIso()`,与原生
 *   `new Date(ms).toISOString()` 字节等价;
 * - 只在这里注册插件,业务代码禁止直接 `import dayjs from 'dayjs'`。
 */
dayjs.extend(utc);
dayjs.extend(timezone);

export { dayjs };

/** epoch ms → UTC ISO(传输/存储格式;dayjs 的 toISOString 与原生一致) */
export function toIso(ms: number): string {
  return dayjs(ms).toISOString();
}