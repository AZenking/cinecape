import { Injectable } from '@nestjs/common';
import {
  RATE_LIMIT_MAX_KEYS,
  RATE_LIMIT_POLICIES,
  RATE_LIMIT_WINDOW_MS,
  type RateLimitPolicyName,
} from '@platform/http-common/rate-limit/rate-limit.policies';

/**
 * 可复用滑动窗口限频器(T009 底座,005 contracts/api.md §1)——
 * 内存实现(单实例部署;重启清零只影响瞬时配额),同 004 playback-rate-limit 口径:
 *
 * - 滑动窗口:每 key 保留最近 RATE_LIMIT_WINDOW_MS 内的通过时刻升序序列;
 *   判定「窗口内通过次数 ≥ 限额」即拒绝,否则记账。计数点为通过检查的请求
 *   (含随后被业务拒绝的请求),防绕过;
 * - 「检查+记账」原子于同步执行内(Node 单线程),无并发竞态;
 * - 内存有界:每次检查修剪窗口外时刻(即 TTL 语义);key 数超 RATE_LIMIT_MAX_KEYS
 *   软上限时全表清扫无窗口键(数量上限兜底);
 * - 拒绝时返回 Retry-After 秒数(最旧存活时刻离开窗口的剩余时间,向上取整,恒 ≥1),
 *   由调用方/守卫动态注入响应头(问题注册表不持静态 Retry-After)。
 */

export interface RateLimitAllow {
  readonly ok: true;
}

export interface RateLimitDeny {
  readonly ok: false;
  /** Retry-After 响应头秒数(向上取整,恒 ≥1) */
  readonly retryAfterSeconds: number;
}

export type RateLimitOutcome = RateLimitAllow | RateLimitDeny;

/** key = `<policy>\u0000<scopeValue>`:策略间隔离,同策略跨端点合并计数(契约口径为每维度总额) */
function windowKey(policy: RateLimitPolicyName, scopeValue: string): string {
  return `${policy}\u0000${scopeValue}`;
}

@Injectable()
export class RateLimitService {
  /** key → 窗口内通过时刻升序序列 */
  private readonly windows = new Map<string, number[]>();

  /**
   * 申请一个配额槽:通过即记账并返回 ok;超限返回 ok:false 与 Retry-After 秒数。
   * scopeValue 由调用方按策略作用域给出(IP 或 DeviceSession id,见 rate-limit.guard)。
   */
  acquire(policy: RateLimitPolicyName, scopeValue: string, atMs: number = Date.now()): RateLimitOutcome {
    const limit = RATE_LIMIT_POLICIES[policy].limitPerMinute;
    const key = windowKey(policy, scopeValue);
    let stamps = this.windows.get(key);
    if (stamps === undefined) {
      stamps = [];
      this.windows.set(key, stamps);
    }
    // 修剪窗口外时刻(升序序列:头部连续过期直接截断,即 TTL 淘汰)
    const cutoff = atMs - RATE_LIMIT_WINDOW_MS;
    let firstLive = 0;
    while (firstLive < stamps.length && (stamps[firstLive] as number) <= cutoff) {
      firstLive += 1;
    }
    if (firstLive > 0) {
      stamps.splice(0, firstLive);
    }
    if (stamps.length >= limit) {
      // 最旧存活时刻离开窗口(再过 X 毫秒)即腾出槽位;向上取整且恒 ≥1
      const oldest = stamps[0] as number;
      const retryAfterSeconds = Math.max(1, Math.ceil((oldest + RATE_LIMIT_WINDOW_MS - atMs) / 1000));
      return { ok: false, retryAfterSeconds };
    }
    stamps.push(atMs);
    if (this.windows.size > RATE_LIMIT_MAX_KEYS) {
      this.sweepIdleKeys(atMs);
    }
    return { ok: true };
  }

  /** 观测面:当前 key 数(诊断/测试用) */
  size(): number {
    return this.windows.size;
  }

  /** 全表清扫:窗口完全为空的 key 移除(有界内存兜底) */
  private sweepIdleKeys(atMs: number): void {
    const cutoff = atMs - RATE_LIMIT_WINDOW_MS;
    for (const [key, stamps] of this.windows) {
      let live = false;
      for (let index = stamps.length - 1; index >= 0; index -= 1) {
        const stamp = stamps[index];
        if (stamp !== undefined && stamp > cutoff) {
          live = true;
          break;
        }
      }
      if (!live) {
        this.windows.delete(key);
      }
    }
  }
}

/**
 * 模块级共享单例(T036 接线):本仓库运行时(esbuild/tsx)不产出
 * design:paramtypes 元数据,经 @UseGuards 免装配挂载的守卫无法走构造注入 ——
 * 提供唯一共享实例,保证限频计数跨路由累计(「限频才跨路由累计」口径)。
 */
let sharedRateLimitInstance: RateLimitService | null = null;

export function sharedRateLimitService(): RateLimitService {
  sharedRateLimitInstance ??= new RateLimitService();
  return sharedRateLimitInstance;
}
