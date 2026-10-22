import { z } from 'zod';

/**
 * 部署配置 —— 唯一来源是环境变量(FR-004:密钥/配置不进代码与镜像)。
 * 启动时 fail-fast:任何缺失/非法配置直接阻止服务启动。
 */
export const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(3000),
  /** SQLite 数据目录(容器内为 /data 卷) */
  DATA_DIR: z.string().default('./data'),
  DB_FILENAME: z.string().default('hmp.db'),
  /**
   * 会话滑动过期天数(每次认证使用刷新,research D5)。
   * 放宽为正数(允许小数天,T032 契约测试注入秒级极小 TTL 驱动过期场景;
   * 生产配置仍可继续使用整数天)。
   */
  SESSION_TTL_DAYS: z.coerce.number().positive().default(30),
  /** 会话绝对上限天数 —— 超过即强制重新登录 */
  SESSION_ABSOLUTE_DAYS: z.coerce.number().int().positive().default(90),
  /** PIN 连续失败上限 */
  PIN_MAX_ATTEMPTS: z.coerce.number().int().positive().default(5),
  /** PIN 锁定分钟数 */
  PIN_LOCK_MINUTES: z.coerce.number().int().positive().default(5),
  /** 局域网 HTTP 部署时为 false;公网/HTTPS 必须为 true */
  COOKIE_SECURE: z
    .enum(['true', 'false'])
    .default('false')
    .transform((v) => v === 'true'),
  LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
});

export type Env = z.infer<typeof envSchema>;

export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  const parsed = envSchema.safeParse(source);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `${i.path.join('.')}: ${i.message}`)
      .join('; ');
    throw new Error(`环境配置校验失败(fail-fast): ${issues}`);
  }
  return parsed.data;
}
