import { inArray, lt, lte } from 'drizzle-orm';
import { Injectable, type OnApplicationShutdown } from '@nestjs/common';
import type { PlaybackBudgets } from '@platform/config/playback-budgets';
import { playbackFailureEvent, playbackSession, playbackTicket } from '@platform/database/schema';
import { getDb } from '@contexts/identity-access/infrastructure/db';
import { PLAYBACK_ACTIVE_SESSION_STATES } from '@contexts/playback/domain/playback.types';

/**
 * 播放保留清理服务(T045,spec 004,US2b)—— 每日清理审计与过期票:
 *
 * 权威依据(先读后写):
 * - tasks.md T045:每日清理 30 天审计、过期票 24 小时内清理,活跃 session/转换不删、
 *   FK 父级 RESTRICT 不误删媒体身份;runRetention(now?) 可测入口 + 定时调度对齐
 *   lifecycle 的时钟/定时器模式(start/stopTimers)。
 * - data-model.md「验证与恢复」:审计保留 30 天后清理,避免删除目录身份;
 *   budgets.lifecycle.recordRetentionDays=30 / budgets.ticket.expiredRetentionSeconds=24h
 *   (数值唯一权威 playback-budgets.ts,由 T010 config.spec 锁定)。
 *
 * 清理面(只删两类行,绝不触碰其他表):
 * - playback_failure_event:occurred_at <= now-30d 删除(保留满 30 天即清理 ——
 *   恰好 30 天删/29 天留);audit 行是 media_item/profile/device/device_session 的
 *   子行,删除子行不影响任何父级(SQLite RESTRICT 阻止的是「有子行的父级删除」,
 *   媒体身份目录因此天然不动,单测显式断言);
 * - playback_ticket:expires_at 严格早于 now-24h 的过期票删除(与仓储既有
 *   deleteExpiredTickets 同一判定基准,语义由 repository.spec 钉死;恰好 24h 保留);
 *   并叠加「活跃 session 的票不删」保护(preparing/ready/playing/paused 会话名下的
 *   票一律不清理 —— 过期只代表不可用,不代表可回收;保护经 getDb() 直查实现,
 *   不新增/不修改 PlaybackRepository 方法,T011 API 面保持不变);
 * - playback_session / playback_conversion / 媒体身份行不在清理面内:活跃或终态
 *   session、转换与目录身份全部原样保留。
 *
 * 调度(lifecycle 同款):注入时钟(缺省真实系统时钟)+ 纪元守卫的单条每日循环;
 * start/stopTimers 可重复启停,单拍异常吞并不中断定时链(清理幂等,下一拍续扫);
 * 关闭 hook(stopTimers)由 Nest onApplicationShutdown 承担。
 */

/** 结构化最小时钟(ManualClock / systemClock 结构兼容;lifecycle 同款) */
export interface RetentionClock {
  now(): number;
  delay(ms: number): Promise<void>;
}

export interface PlaybackRetentionDeps {
  readonly budgets: PlaybackBudgets;
  /** 缺省真实系统时钟;测试注入 ManualClock */
  readonly clock?: RetentionClock;
}

export interface RetentionOutcome {
  /** 本次删除的审计失败事件行数 */
  readonly failureEventsDeleted: number;
  /** 本次删除的过期票行数(不含活跃 session 名下受保护票) */
  readonly expiredTicketsDeleted: number;
}

/** 每日清理节拍(每日一次;data-model「审计保留 30 天后清理」的执行频率) */
const DAILY_INTERVAL_MS = 24 * 60 * 60 * 1000;

/** 毫秒 → UTC ISO-8601(毫秒,Z);入库时间文本统一此形态(字典序=时间序) */
function iso(ms: number): string {
  return new Date(ms).toISOString();
}

function defaultRetentionClock(): RetentionClock {
  return {
    now: () => Date.now(),
    delay: (ms: number) =>
      new Promise<void>((resolve) => {
        setTimeout(resolve, ms);
      }),
  };
}

@Injectable()
export class PlaybackRetentionService implements OnApplicationShutdown {
  private readonly clock: RetentionClock;
  /** 定时链运转标志与纪元(stopTimers 后 start 可重启,旧循环凭纪元自退出,不双链) */
  private timersRunning = false;
  private epoch = 0;

  constructor(private readonly deps: PlaybackRetentionDeps) {
    this.clock = deps.clock ?? defaultRetentionClock();
  }

  /**
   * 单轮保留清理(可测入口;now 缺省取注入时钟当前时刻,可显式传入 UTC ISO-8601
   * 以确定边界)。返回两类删除行数;幂等 —— 对同一库重复执行,第二轮零删除。
   */
  runRetention(now?: string): RetentionOutcome {
    const nowMs = now === undefined ? this.clock.now() : Date.parse(now);
    if (!Number.isFinite(nowMs)) {
      throw new Error(`runRetention 需要可解析的 UTC 时刻,收到:${String(now)}`);
    }
    const failureEventsDeleted = this.pruneExpiredFailureEvents(nowMs);
    const expiredTicketsDeleted = this.pruneExpiredTickets(nowMs);
    return { failureEventsDeleted, expiredTicketsDeleted };
  }

  /** 启动每日清理定时链(缺省关闭;生产装配在启动引导就绪门后调用) */
  start(): void {
    if (this.timersRunning) {
      return;
    }
    this.timersRunning = true;
    const epoch = this.epoch + 1;
    this.epoch = epoch;
    void this.retentionLoop(epoch);
  }

  /** 停转定时链(挂起中的 delay 到期后凭标志/纪元退出;关闭 hook 复用) */
  stopTimers(): void {
    this.timersRunning = false;
  }

  /** 关闭 hook:停转每日清理链(进程退出即定时器终止,遗留清理由下次启动接续) */
  onApplicationShutdown(): void {
    this.stopTimers();
  }

  // -------------------------------------------------------------------------
  // 内部
  // -------------------------------------------------------------------------

  private async retentionLoop(epoch: number): Promise<void> {
    while (this.timersRunning && epoch === this.epoch) {
      await this.clock.delay(DAILY_INTERVAL_MS);
      if (!this.timersRunning || epoch !== this.epoch) {
        return;
      }
      try {
        this.runRetention();
      } catch {
        // 单拍清理异常不中断定时链(清理幂等,下一拍继续;调度链常驻)
      }
    }
  }

  /**
   * 审计清理:occurred_at <= now-recordRetentionDays 的 failure_event 删除
   * (保留满 30 天即清理:恰好 30 天删/29 天留)。仅删审计子行,
   * 父级媒体身份行不受影响(FK RESTRICT 语义 + 本方法根本不触父表)。
   */
  private pruneExpiredFailureEvents(nowMs: number): number {
    const horizonMs = nowMs - this.deps.budgets.lifecycle.recordRetentionDays * 86_400_000;
    const result = getDb()
      .delete(playbackFailureEvent)
      .where(lte(playbackFailureEvent.occurredAt, iso(horizonMs)))
      .run();
    return result.changes;
  }

  /**
   * 过期票清理:expires_at 严格早于 now-expiredRetentionSeconds(24h)的票删除
   * (与仓储 deleteExpiredTickets 同一严格 lt 判定;恰好 24h 保留),
   * 但活跃 session(preparing/ready/playing/paused)名下的票一律受保护不删。
   * 两段式「先筛后删」:避免 drizzle 空列表 inArray/notInArray 形态问题,
   * 且保护集合小(仅活动会话),可读性优先。
   */
  private pruneExpiredTickets(nowMs: number): number {
    const cutoffMs = nowMs - this.deps.budgets.ticket.expiredRetentionSeconds * 1000;
    const expired = getDb()
      .select({ id: playbackTicket.id, sessionId: playbackTicket.sessionId })
      .from(playbackTicket)
      .where(lt(playbackTicket.expiresAt, iso(cutoffMs)))
      .all();
    if (expired.length === 0) {
      return 0;
    }
    const activeSessionIds = new Set(
      getDb()
        .select({ id: playbackSession.id })
        .from(playbackSession)
        .where(inArray(playbackSession.state, [...PLAYBACK_ACTIVE_SESSION_STATES]))
        .all()
        .map((row) => row.id),
    );
    const deletableIds = expired.filter((row) => !activeSessionIds.has(row.sessionId)).map((row) => row.id);
    if (deletableIds.length === 0) {
      return 0;
    }
    const result = getDb()
      .delete(playbackTicket)
      .where(inArray(playbackTicket.id, deletableIds))
      .run();
    return result.changes;
  }
}
