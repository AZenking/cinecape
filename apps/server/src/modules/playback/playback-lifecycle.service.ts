import fsp from 'node:fs/promises';
import path from 'node:path';
import { and, asc, eq, inArray } from 'drizzle-orm';
import { Injectable, type OnApplicationShutdown } from '@nestjs/common';
import type { PlaybackBudgets } from '../../config/playback-budgets';
import { playbackConversion, playbackSession } from '../../database/schema';
import { getDb } from '../auth/db';
import type { PlaybackRepository } from './playback.repository';
import {
  PLAYBACK_ACTIVE_SESSION_STATES,
  PLAYBACK_CONVERSION_ACTIVE_STATES,
  isPlaybackStableErrorCode,
  isPlaybackTerminalSessionState,
  playbackErr,
  type PlaybackErrorCode,
  type PlaybackResult,
  type PlaybackSessionView,
} from './playback.types';

/**
 * 播放生命周期服务(T028,spec 004)—— 心跳/失联/权限复核/终止/启动恢复/退出清理:
 *
 * 权威依据(先读后写):
 * - tasks.md T028:实现 15 秒心跳、45 秒失联、每 15 秒后台权限复核、stop/cancel/失败/失权
 *   终止及退出后 60 秒清理;启动先标 interrupted/扫私有根再接转换,不按旧 PID 杀进程;
 *   关闭 hook 处理子进程并保留目录可用。
 * - research.md R5:前端每 15 秒 heartbeat(暂停也发,paused 心跳≠失联);45 秒无心跳判失联;
 *   stop/cancel/失败/权限失效立即终止任务;终止后 60 秒内清理目录,失败每 60 秒重试并保持
 *   cleanup_state=pending,磁盘占用仍计预算;启动时将活动 session/job 标 interrupted 并扫
 *   本实例私有根,不使用旧 PID 杀无关进程;清理完成才接受新转换;后台每 15 秒复核活动任务授权。
 * - data-model.md「## playback_session」:任一活动态→ended/failed/interrupted,终态不可复活;
 *   ended_at 在 interrupted 必填、failure_code 仅 failed 非空。「## playback_conversion」:
 *   任务 PID 仅进程内持有,不作为重启后杀进程依据;重启先标 interrupted;cleanup_state 仅
 *   pending/complete,删除失败仍为 pending。
 * - 数值唯一来源 budgets.lifecycle:heartbeatIntervalSeconds 15 / heartbeatLostSeconds 45 /
 *   authRecheckSeconds 15 / cleanupDelaySeconds 60 / cleanupRetrySeconds 60。
 *
 * 终态选择依据(集中说明,测试 lifecycle.spec 同源):
 * - 失联(45 秒无心跳)→ interrupted:系统回收而非用户优雅结束(ended)或媒体失败(failed);
 *   repository.markInterrupted(T011)注释明确「活动态→interrupted(失联/重启恢复)」。
 * - 权限失效(策略收紧/档案切换/会话撤销,复核拒绝)→ interrupted:R5「权限失效立即终止
 *   任务」「心跳和媒体请求均可触发权限失效回收」同属系统回收;稳定失败码词表(PLAYBACK_*)
 *   无授权失败码,failSession 需稳定码,语义不合。
 * - stopSession(用户主动)→ ended;markFailure(运行中失败,resolver/supervisor 通知;
 *   prepare 失败已由 resolver 处理)→ failed + 稳定失败码。
 * - 三条终态路径统一效果:取消该会话全部活动转换(监督者 cancel → SIGTERM→5s→SIGKILL →
 *   确认退出后 releaseOnExit 释放额度)+ 会话级去重安排 cleanupDelaySeconds 后清理私有目录。
 *
 * 协作与边界:
 * - 不新增/不修改 PlaybackRepository 方法(T011 API 面被 repository.spec 钉死):活动行枚举
 *   经 getDb() 只读投影直查(与 playback-authorization.service 同一先例),迁移一律走仓储
 *   既有原子方法(heartbeat/endSession/failSession/markInterrupted/releaseOnExit);
 * - cleanup 语义委托 ConversionStorageService:releaseSession 删除失败由 storage 保持
 *   pending 计预算并按 cleanupRetrySeconds 自主重试(本服务只负责延迟触发与意外拒绝兜底);
 * - 时间全走注入 clock(缺省真实系统时钟),入库时间统一 UTC ISO-8601;错误一律稳定码。
 */

/** 结构化最小时钟(ManualClock / systemClock 结构兼容) */
export interface LifecycleClock {
  now(): number;
  delay(ms: number): Promise<void>;
}

/** 授权重验端口(结构对齐 PlaybackAuthorizationService.revalidate;测试注入 fake) */
export interface PlaybackRevalidatePort {
  revalidate(deviceSessionId: string, profileId: string, mediaId: string): Promise<unknown>;
}

/** 转换存储端口(结构对齐 ConversionStorageService 的清理/观察面) */
export interface LifecycleStoragePort {
  /** 释放整会话全部代窗口(删除失败由实现保持 pending 计预算并自主重试,R5) */
  releaseSession(householdId: string, sessionId: string): Promise<void>;
  /** 释放单个代窗口(启动私有根扫描的孤儿目录清理入口) */
  releaseTask(task: { readonly householdId: string; readonly sessionId: string; readonly generation: number }): Promise<void>;
  /** 处于 pending 重试态的任务键(cleanup_state=pending 观察;预算仍计) */
  pendingCleanupTasks(): readonly string[];
}

/** 转换监督端口(结构对齐 ConversionSupervisorService.cancel:SIGTERM→5s→SIGKILL 内部承担) */
export interface LifecycleSupervisorPort {
  cancel(conversionId: string): Promise<void>;
}

export interface PlaybackLifecycleDeps {
  readonly repository: PlaybackRepository;
  readonly authorization: PlaybackRevalidatePort;
  readonly storage: LifecycleStoragePort;
  readonly supervisor: LifecycleSupervisorPort;
  readonly budgets: PlaybackBudgets;
  /** 缺省真实系统时钟;测试注入 ManualClock */
  readonly clock?: LifecycleClock;
  /**
   * 本实例转换私有根(生产装配传 <DATA_DIR>/playback,与 ConversionStorageService 的
   * rootDir 派生一致)。recoverOnBoot 据此扫描孤儿目录;缺省跳过磁盘扫描(仍完成 DB 标记)。
   */
  readonly privateRootDir?: string;
}

export interface LifecycleHeartbeatOptions {
  readonly positionSeconds?: number;
  /** 暂停意图随心跳更新;暂停心跳照发、同样刷新 last_heartbeat_at(R5:paused≠失联) */
  readonly paused?: boolean;
  /** 缺省注入时钟当前时刻(UTC) */
  readonly at?: string;
}

export interface LifecycleTerminateOptions {
  readonly at?: string;
}

/** DB 行投影(drizzle select 原始行;state 列为 string,判定走 playback.types 纯函数) */
type PlaybackSessionDbRow = typeof playbackSession.$inferSelect;
type PlaybackConversionDbRow = typeof playbackConversion.$inferSelect;

/** 回收目标终态(stop→ended / 失败→failed / 失联与失权与重启→interrupted) */
type ReclaimTarget = 'ended' | 'failed' | 'interrupted';

function defaultLifecycleClock(): LifecycleClock {
  return {
    now: () => Date.now(),
    delay: (ms: number) =>
      new Promise<void>((resolve) => {
        setTimeout(resolve, ms);
      }),
  };
}

@Injectable()
export class PlaybackLifecycleService implements OnApplicationShutdown {
  private readonly clock: LifecycleClock;
  /** 定时链运转标志与纪元(stopTimers 后 start 可重启,旧循环凭纪元自退出,不双链) */
  private timersRunning = false;
  private epoch = 0;
  /** 启动恢复完成前拒绝接受新转换(R5:清理完成才接受新转换) */
  private bootCompleted = false;
  /** 会话级清理去重:每会话至多一条 cleanupDelaySeconds 延迟链(重复终止无副作用) */
  private readonly cleanupScheduled = new Set<string>();

  constructor(private readonly deps: PlaybackLifecycleDeps) {
    this.clock = deps.clock ?? defaultLifecycleClock();
  }

  // -------------------------------------------------------------------------
  // 心跳(15 秒节拍由前端发起;暂停心跳走同一路径)
  // -------------------------------------------------------------------------

  /**
   * 心跳:更新 last_heartbeat_at(可携带位置推进与暂停意图),绝不递增 version/generation。
   * CAS 基准取读取时刻的行版本:seek/字幕切换并发窗口内的一次冲突由客户端下一拍心跳
   * 自然覆盖(失联阈值 45 秒容忍 2 个缺失节拍,不因单次 VERSION_CONFLICT 误回收)。
   */
  heartbeat(sessionId: string, options: LifecycleHeartbeatOptions = {}): PlaybackResult<PlaybackSessionView> {
    const row = this.readSessionRow(sessionId);
    if (row === undefined) {
      return playbackErr('PLAYBACK_NOT_FOUND', '播放会话不存在');
    }
    return this.deps.repository.heartbeat(sessionId, {
      cas: { expectedVersion: row.version },
      ...(options.positionSeconds !== undefined ? { positionSeconds: options.positionSeconds } : {}),
      ...(options.paused !== undefined ? { desiredPaused: options.paused } : {}),
      at: options.at ?? this.isoNow(),
    });
  }

  // -------------------------------------------------------------------------
  // 终止路径:stop(→ended)/失败通知(→failed);失联与失权走内部 reclaim(→interrupted)
  // -------------------------------------------------------------------------

  /** 用户主动停止:活动态→ended + 取消转换 + 安排清理;重复 stop 幂等(终态零副作用) */
  async stopSession(sessionId: string, options: LifecycleTerminateOptions = {}): Promise<PlaybackResult<PlaybackSessionView>> {
    return this.reclaim(sessionId, { to: 'ended' }, options);
  }

  /**
   * 运行中失败通知(resolver/supervisor 回调口;prepare 失败已由 resolver 自处理):
   * 活动态→failed + 稳定失败码 + 取消转换 + 安排清理;终态会话 no-op。
   */
  async markFailure(
    sessionId: string,
    failureCode: PlaybackErrorCode,
    options: LifecycleTerminateOptions = {},
  ): Promise<PlaybackResult<PlaybackSessionView>> {
    if (!isPlaybackStableErrorCode(failureCode)) {
      // 与仓储同约定:非稳定失败码属编程性约定违反,抛错而非伪装领域结果
      throw new Error(`markFailure 需要稳定失败码,收到:${String(failureCode)}`);
    }
    return this.reclaim(sessionId, { to: 'failed', failureCode }, options);
  }

  /**
   * 统一回收:终态守卫(已终态 → 返回现状零副作用)→ 仓储原子迁移 → 取消该会话全部
   * 活动转换 → 会话级去重安排 60 秒清理。CAS 冲突(竞态 seek/换代)时返回 err 且会话仍
   * 活动,由后续节拍(失联扫描/复核每 15 秒)自愈重收。
   */
  private async reclaim(
    sessionId: string,
    decision: { to: ReclaimTarget; failureCode?: PlaybackErrorCode },
    options: LifecycleTerminateOptions,
  ): Promise<PlaybackResult<PlaybackSessionView>> {
    const row = this.readSessionRow(sessionId);
    if (row === undefined) {
      return playbackErr('PLAYBACK_NOT_FOUND', '播放会话不存在');
    }
    if (isPlaybackTerminalSessionState(row.state)) {
      // 幂等:终态不可复活(data-model)——不重写、不重复取消、不重复安排清理
      return this.deps.repository.getSession(row.householdId, sessionId);
    }
    const at = options.at ?? this.isoNow();
    const cas = { expectedVersion: row.version };
    const result =
      decision.to === 'ended'
        ? this.deps.repository.endSession(sessionId, { cas, at })
        : decision.to === 'failed'
          ? this.deps.repository.failSession(sessionId, { cas, failureCode: decision.failureCode as PlaybackErrorCode, at })
          : this.deps.repository.markInterrupted(sessionId, { cas, at });
    if (!result.ok) {
      return result;
    }
    await this.cancelSessionConversions(sessionId);
    this.scheduleCleanup(row.householdId, sessionId);
    return result;
  }

  /** 取消该会话全部活动转换(枚举 DB 活动行;监督者对未知任务幂等 no-op) */
  private async cancelSessionConversions(sessionId: string): Promise<void> {
    const rows = this.listActiveConversionRows(sessionId);
    await Promise.allSettled(rows.map((row) => this.deps.supervisor.cancel(row.id)));
  }

  /**
   * 退出后清理:cleanupDelaySeconds 后调 storage.releaseSession(删除失败由 storage 保持
   * pending 计预算并按 cleanupRetrySeconds 自主重试 —— R5/data-model cleanup_state 语义)。
   * releaseSession 意外拒绝时按 cleanupRetrySeconds 兜底补试一次;每会话只排一次。
   */
  private scheduleCleanup(householdId: string, sessionId: string): void {
    if (this.cleanupScheduled.has(sessionId)) {
      return;
    }
    this.cleanupScheduled.add(sessionId);
    const release = (): Promise<void> => this.deps.storage.releaseSession(householdId, sessionId);
    void this.clock
      .delay(this.deps.budgets.lifecycle.cleanupDelaySeconds * 1000)
      .then(release, release)
      .catch(() => {
        void this.clock
          .delay(this.deps.budgets.lifecycle.cleanupRetrySeconds * 1000)
          .then(release, release)
          .catch(() => {
            // 清理链尽力而为:storage 内部 pending 状态仍是预算与重试的权威
          });
      });
  }

  // -------------------------------------------------------------------------
  // 内部定时链(可测):失联扫描 × heartbeatIntervalSeconds;权限复核 × authRecheckSeconds
  // -------------------------------------------------------------------------

  /** 启动两条定时链(缺省关闭;生产装配在 recoverOnBoot 后调用) */
  start(): void {
    if (this.timersRunning) {
      return;
    }
    this.timersRunning = true;
    const epoch = this.epoch + 1;
    this.epoch = epoch;
    void this.heartbeatLossLoop(epoch);
    void this.authorizationRecheckLoop(epoch);
  }

  /** 停转定时链(挂起中的 delay 到期后凭标志/纪元退出;关闭 hook 复用) */
  stopTimers(): void {
    this.timersRunning = false;
  }

  private async heartbeatLossLoop(epoch: number): Promise<void> {
    const intervalMs = this.deps.budgets.lifecycle.heartbeatIntervalSeconds * 1000;
    while (this.timersRunning && epoch === this.epoch) {
      await this.clock.delay(intervalMs);
      if (!this.timersRunning || epoch !== this.epoch) {
        return;
      }
      try {
        await this.runHeartbeatLossScan();
      } catch {
        // 单拍扫描异常不中断定时链(下一拍继续;回收具备幂等性)
      }
    }
  }

  private async authorizationRecheckLoop(epoch: number): Promise<void> {
    const intervalMs = this.deps.budgets.lifecycle.authRecheckSeconds * 1000;
    while (this.timersRunning && epoch === this.epoch) {
      await this.clock.delay(intervalMs);
      if (!this.timersRunning || epoch !== this.epoch) {
        return;
      }
      try {
        await this.runAuthorizationRecheck();
      } catch {
        // 同上:节拍链常驻,失败不累积不传播
      }
    }
  }

  /** 失联扫描:活动会话中 last_heartbeat_at 距今 ≥ heartbeatLostSeconds → interrupted */
  async runHeartbeatLossScan(): Promise<void> {
    const nowMs = this.clock.now();
    const lostMs = this.deps.budgets.lifecycle.heartbeatLostSeconds * 1000;
    for (const row of this.listActiveSessionRows()) {
      const lastMs = Date.parse(row.lastHeartbeatAt);
      if (Number.isFinite(lastMs) && nowMs - lastMs >= lostMs) {
        // 失联属系统回收 → interrupted(依据见文件头「终态选择依据」)
        await this.reclaim(row.id, { to: 'interrupted' }, {});
      }
    }
  }

  /** 权限复核扫描:每拍对全部活动会话重验授权;拒绝(抛错)→ interrupted 立即回收 */
  async runAuthorizationRecheck(): Promise<void> {
    for (const row of this.listActiveSessionRows()) {
      try {
        await this.deps.authorization.revalidate(row.deviceSessionId, row.profileId, row.mediaId);
      } catch {
        await this.reclaim(row.id, { to: 'interrupted' }, {});
      }
    }
  }

  // -------------------------------------------------------------------------
  // 启动恢复与就绪门
  // -------------------------------------------------------------------------

  /**
   * 启动恢复(R5 顺序:先标 interrupted → 扫私有根 → 才接受新转换):
   * 1) 活动 session 全部标 interrupted;2) 活动转换经 releaseOnExit(interrupted) 确认退出
   * 并释放额度 —— 单实例语义下上一进程必已不在,重启事实即退出确认;
   * 3) 扫描私有根孤儿目录逐代清理(删除失败由 storage 转 pending 重试);
   * 不读取、不依赖任何旧 PID:任务 PID 仅进程内持有,重启后不存在可杀依据(data-model)。
   */
  async recoverOnBoot(options: LifecycleTerminateOptions = {}): Promise<void> {
    if (this.bootCompleted) {
      return;
    }
    const at = options.at ?? this.isoNow();
    for (const row of this.listActiveSessionRows()) {
      this.deps.repository.markInterrupted(row.id, { cas: { expectedVersion: row.version }, at });
    }
    for (const row of this.listActiveConversionRows()) {
      this.deps.repository.releaseOnExit(row.id, { finalState: 'interrupted', at });
    }
    await this.scanPrivateRoot();
    this.bootCompleted = true;
  }

  /** 转换接受门:启动恢复(含私有根扫描)完成前为 false,装配层据此拒绝新转换 */
  readyToAcceptConversions(): boolean {
    return this.bootCompleted;
  }

  /** 私有根孤儿目录扫描:<root>/<household>/<session>/<generation> 任务形状目录逐个释放 */
  private async scanPrivateRoot(): Promise<void> {
    const root = this.deps.privateRootDir;
    if (root === undefined) {
      return;
    }
    let households: string[];
    try {
      households = await fsp.readdir(root);
    } catch {
      return; // 私有根不存在 = 无孤儿
    }
    for (const householdId of households) {
      let sessions: string[];
      try {
        sessions = await fsp.readdir(path.join(root, householdId));
      } catch {
        continue; // 非目录项/瞬时不可读:跳过
      }
      for (const sessionId of sessions) {
        let generations: string[];
        try {
          generations = await fsp.readdir(path.join(root, householdId, sessionId));
        } catch {
          continue;
        }
        for (const generationSegment of generations) {
          if (!/^\d+$/.test(generationSegment)) {
            continue; // 非任务目录形状(代目录恒为正整数段)不按任务清理
          }
          const generation = Number(generationSegment);
          if (generation < 1) {
            continue;
          }
          // 已清理键的重复释放幂等(storage releaseTask:不存在目录按成功收尾)
          await this.deps.storage.releaseTask({ householdId, sessionId, generation });
        }
      }
    }
  }

  // -------------------------------------------------------------------------
  // 关闭 hook(Nest 生命周期)
  // -------------------------------------------------------------------------

  /**
   * 关闭 hook:停转定时链;取消全部活动转换(SIGTERM→5 秒宽限→SIGKILL 与确认退出释放
   * 额度由监督者内部时钟链承担,此处只发出取消并等待派发完成)。
   * 不删除任何目录、不安排清理:私有目录保持可用,遗留回收由下次启动 recoverOnBoot 的
   * 私有根扫描统一接管(进程退出即定时器终止,60 秒清理链自然停止)。
   */
  async onApplicationShutdown(): Promise<void> {
    this.stopTimers();
    const active = this.listActiveConversionRows();
    await Promise.allSettled(active.map((row) => this.deps.supervisor.cancel(row.id)));
  }

  // -------------------------------------------------------------------------
  // 只读投影(经 getDb() 直查,保持仓储 T011 API 面不变 —— authorization 同一先例)
  // -------------------------------------------------------------------------

  private readSessionRow(sessionId: string): PlaybackSessionDbRow | undefined {
    return getDb().select().from(playbackSession).where(eq(playbackSession.id, sessionId)).get();
  }

  /** 全部活动会话(preparing/ready/playing/paused),按 (created_at,id) 稳定序 */
  private listActiveSessionRows(): PlaybackSessionDbRow[] {
    return getDb()
      .select()
      .from(playbackSession)
      .where(inArray(playbackSession.state, [...PLAYBACK_ACTIVE_SESSION_STATES]))
      .orderBy(asc(playbackSession.createdAt), asc(playbackSession.id))
      .all();
  }

  /** 活动转换(reserved～stopping),可按会话过滤(取消路径)或全量(启动恢复/关闭) */
  private listActiveConversionRows(sessionId?: string): PlaybackConversionDbRow[] {
    return getDb()
      .select()
      .from(playbackConversion)
      .where(
        and(
          ...(sessionId !== undefined ? [eq(playbackConversion.sessionId, sessionId)] : []),
          inArray(playbackConversion.state, [...PLAYBACK_CONVERSION_ACTIVE_STATES]),
        ),
      )
      .orderBy(asc(playbackConversion.id))
      .all();
  }

  /** 注入时钟 → UTC ISO-8601(毫秒,Z);入库时间一律出自此刻 */
  private isoNow(): string {
    return new Date(this.clock.now()).toISOString();
  }
}
