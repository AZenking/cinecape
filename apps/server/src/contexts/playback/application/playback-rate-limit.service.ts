import { Injectable } from '@nestjs/common';
import type { PlaybackBudgets } from '@platform/config/playback-budgets';

/**
 * 播放解析控制限频器(T031,spec 004)—— 每设备滑动窗口内存限流:
 *
 * 权威依据:
 * - contracts/api.md 控制端点节:「解析控制请求限每设备每分钟 30 次(resolve/seek/selection),
 *   renew 每分钟 10 次,超限 429+Retry-After;媒体分片不套此频率」;
 * - budgets.rateLimit(T010):controlPerDevicePerMinute=30 / renewPerMinute=10,
 *   数值唯一来源为本预算对象,本文件不持有任何阈值常量;
 * - 稳定错误:429 PLAYBACK_RATE_LIMITED,Retry-After(秒,向上取整)由调用方按
 *   retryAfterSeconds 注入响应头(ProblemJsonFilter 的注册表无动态头,故在控制器层设置)。
 *
 * 实现说明:
 * - 滑动窗口:每 key 保留最近 60_000ms 内的通过时刻序列;判定「窗口内通过次数 ≥ 限额」
 *   即拒绝,否则记录本次时刻。计数点为「通过检查」的请求(含随后被业务拒绝的请求):
 *   与常规 API 限流一致,防绕过(失败请求同样消耗配额);
 * - key = `${deviceId}\u0000${bucket}`:resolve/seek/selection 共享 'control' 桶
 *   (跨端点合并计数,契约 e2e:30 次 resolve 后第 31 个 seek 亦 429),renew 独立 'renew' 桶;
 * - 进程内存态:与 AssetMap 同款语义(单实例部署;重启即清零,不影响正确性只影响瞬时配额);
 * - 内存有界:每次检查顺带修剪过期时刻;key 数超软上限时全表清扫无窗口键
 *   (设备维度键域有界,兜底防异常增长)。
 */

/** 限频桶:control = resolve/seek/selection 共享;renew 独立 */
export type PlaybackRateLimitBucket = 'control' | 'renew';

export interface PlaybackRateLimitAllow {
  readonly ok: true;
}

export interface PlaybackRateLimitDeny {
  readonly ok: false;
  /** Retry-After 响应头秒数(向上取整,恒 ≥1) */
  readonly retryAfterSeconds: number;
}

export type PlaybackRateLimitOutcome = PlaybackRateLimitAllow | PlaybackRateLimitDeny;

/** 滑动窗口宽度(契约口径「每分钟」) */
const WINDOW_MS = 60_000;

/** key 数软上限(超过即触发全表过期清扫;正常设备维度键域远小于此) */
const MAX_KEYS = 10_000;

@Injectable()
export class PlaybackRateLimitService {
  /** key → 窗口内通过时刻升序序列 */
  private readonly windows = new Map<string, number[]>();

  constructor(private readonly budgets: PlaybackBudgets) {}

  /**
   * 申请一个配额槽:通过即记账并返回 ok;超限返回 ok:false 与 Retry-After 秒数。
   * 「检查+记账」原子于同步执行内(Node 单线程),无并发竞态。
   */
  acquire(deviceId: string, bucket: PlaybackRateLimitBucket, atMs: number = Date.now()): PlaybackRateLimitOutcome {
    const limit =
      bucket === 'control' ? this.budgets.rateLimit.controlPerDevicePerMinute : this.budgets.rateLimit.renewPerMinute;
    const key = `${deviceId}\u0000${bucket}`;
    let stamps = this.windows.get(key);
    if (stamps === undefined) {
      stamps = [];
      this.windows.set(key, stamps);
    }
    // 修剪窗口外时刻(升序序列:头部连续过期直接截断)
    const cutoff = atMs - WINDOW_MS;
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
      const retryAfterSeconds = Math.max(1, Math.ceil((oldest + WINDOW_MS - atMs) / 1000));
      return { ok: false, retryAfterSeconds };
    }
    stamps.push(atMs);
    if (this.windows.size > MAX_KEYS) {
      this.sweepIdleKeys(atMs);
    }
    return { ok: true };
  }

  /** 观测面:当前 key 数(装配诊断/测试用) */
  size(): number {
    return this.windows.size;
  }

  /** 全表清扫:窗口完全为空的 key 移除(有界内存兜底) */
  private sweepIdleKeys(atMs: number): void {
    const cutoff = atMs - WINDOW_MS;
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
