import { loadEnv, type Env } from './env.schema';
import { existsSync } from 'node:fs';
import { loadEnvFile } from 'node:process';

/**
 * 部署配置读取(契约测试驱动的小改动:导入期不再冻结):
 * - `getConfig()`:首次访问时解析 process.env 并缓存(生产行为不变,fail-fast 语义保留);
 * - `setEnvOverride()`:仅测试使用,注入独立配置(如按用例独立的 DATA_DIR),
 *   传 null 恢复按 process.env 惰性解析;
 * - `env`:保持既有 `env.X` 读取方式向后兼容,内部代理到 getConfig()。
 * ⚠️ 使用方须在调用时(而非模块加载时)读取 env,才能感知 override。
 */
let cached: Env | null = null;
let override: Env | null = null;

export function getConfig(): Env {
  if (override !== null) {
    return override;
  }
  if (cached === null) {
    // pnpm --filter 在包目录运行；已有进程环境优先于本地 .env。
    if (existsSync('.env')) loadEnvFile('.env');
    cached = loadEnv();
  }
  return cached;
}

/** 测试专用:注入固定配置;传 null 恢复惰性解析。 */
export function setEnvOverride(next: Env | null): void {
  override = next;
}

export const env: Env = new Proxy({} as Env, {
  get(_target, property: string | symbol) {
    return getConfig()[property as keyof Env];
  },
});
