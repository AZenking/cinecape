/**
 * 限频策略常量(T009,005 contracts/api.md §1)——
 * 「公共读取每连接 IP 120 次/分钟,guide 30 次/分钟;进度每 DeviceSession 60 次/分钟;
 * 429 返回 Retry-After,限制表有 TTL 和数量上限,代理信任显式配置。」
 *
 * 数值权威 = 本文件(契约固定值,不提供 env 调节入口,防止调出契约外行为);
 * 播放控制限频沿用 004 playback-rate-limit.service 独立实现,不并入本底座。
 */

/** 窗口宽度(契约口径「每分钟」) */
export const RATE_LIMIT_WINDOW_MS = 60_000;

/** 单维度 key 数软上限:超过触发全表过期清扫(内存有界兜底;正常键域远小于此) */
export const RATE_LIMIT_MAX_KEYS = 10_000;

/** 限频作用域:按连接客户端 IP 计数,或按服务端 DeviceSession 计数 */
export type RateLimitScope = 'ip' | 'deviceSession';

export interface RateLimitPolicy {
  readonly scope: RateLimitScope;
  readonly limitPerMinute: number;
}

export const RATE_LIMIT_POLICIES = {
  /** 公共只读(public 路径):每连接 IP 120 次/分钟 */
  public: { scope: 'ip', limitPerMinute: 120 },
  /** EPG 墙(guide 路径):每连接 IP 30 次/分钟 */
  guide: { scope: 'ip', limitPerMinute: 30 },
  /** 个人进度写入(progress 路径):每 DeviceSession 60 次/分钟 */
  progress: { scope: 'deviceSession', limitPerMinute: 60 },
} as const satisfies Record<string, RateLimitPolicy>;

export type RateLimitPolicyName = keyof typeof RATE_LIMIT_POLICIES;
