import { Injectable, type OnApplicationShutdown } from '@nestjs/common';
import type { PlaybackBudgets } from '@platform/config/playback-budgets';
import { playbackStore } from '@contexts/playback/application/playback-store.port';
import { PLAYBACK_ACTIVE_SESSION_STATES } from '@contexts/playback/domain/playback.types';
import type { VodInputStore } from '@contexts/playback/infrastructure/playback-input-store.drizzle';
import type { TransitionCleanupSweepOutcome } from '@contexts/playback/application/transition-cleanup.service';

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
 *   票一律不清理 —— 过期只代表不可用,不代表可回收;保护经本上下文仓储端口直查实现,
 *   不新增/不修改 PlaybackRepository 方法,T011 API 面保持不变);
 * - playback_session / playback_conversion / 媒体身份行不在清理面内:活跃或终态
 *   session、转换与目录身份全部原样保留。
 *
 * 调度(lifecycle 同款):注入时钟(缺省真实系统时钟)+ 纪元守卫的定时链;
 * start/stopTimers 可重复启停,单拍异常吞并不中断定时链(清理幂等,下一拍续扫);
 * 关闭 hook(stopTimers)由 Nest onApplicationShutdown 承担。
 *
 * T045 增量(010 在线 vod,既有保留面零变化):未起播 ready 会话 60s 固定期限回收的
 * 节拍调度面 —— store(T042/T045 playback-input-store)持持久原语
 * (listReclaimableUnstartedReadySessions / reclaimExpiredUnstartedReadySession),
 * 本服务持节拍:watchdog 扫描链按固定间隔先扫清单再逐会话条件回收(两 watcher CAS
 * 由 store 条件 UPDATE 收口,本层只消费输赢);期限锚点 created_at、解除条件
 * playback_started_at、heartbeat/renew 不续命均为 store 侧判定,调度层不复制语义。
 * 端口缺位(单测直构/未装配)时扫描为 no-op;既有每日清理(runRetention)与
 * lifecycle 启动恢复(cleanup pending 持久标记推进)保持原样。
 *
 * 010 T081 收口(US5 服务端收口;data-model §9 逐条对照):
 * - 启动首拍三链:过渡清理扫描(内含过期 pending 翻转=失效 intent 翻转)→ 未起播
 *   ready 回收,同一首拍先后完成(T062 此前只挂了前两链;未起播回收原先等首个 15s
 *   节拍,重启停机窗口内过期的 ready 会话现重启即收口 —— I5「失败/重启扫描重试」);
 * - watchdog 节拍链覆盖顺序:每拍先过渡清理扫描(授权面终止:cleanup 标记补投幂等
 *   空 stop,经生命周期端口结算资源)后未起播回收(期限兜底:interrupted)——
 *   cleanup 标记会话不被期限回收抢先落 interrupted 而绕过资源结算面;两链独立
 *   可测入口不变;
 * - 双标记覆盖:补投谓词 cleanup_requested=1 AND cleanup_state='pending' AND 活动态
 *   与原因无关,transition_cleanup(T062/I5)与 finish_receipt(T058)标记同面收口
 *   (finish 事务同 commit 终态化,故其标记会话天然不入补投清单,由本谓词钉死);
 * - 保护窗/引用图顺序:slot(FK 子行)→ intent → 未引用 receipt → 未引用过期计划,
 *   受引用 nextPlan/登记映射不在删除面(证据见 transition-store 清理原语守卫谓词)。
 *
 * 010 T084 增量(物化 24h 保护后整组回收的节拍挂链,既有链零变化):可选结构端口
 * vodRetention + 独立入口 runVodRetentionSweep + watchdog 节拍第三链(缺位 no-op,
 * 先例照 T062 transitionCleanup)—— 过期幂等/候选/偏好 operation 回收与窗满组引用图
 * 清扫的原语面归 online-vod 上下文(application/vod-retention.service.ts +
 * infrastructure/online-vod-store.drizzle.ts),本服务只持节拍调度面。
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
  /**
   * T045 未起播回收持久原语(T042/T045 playback-input-store;缺位 = watchdog 扫描 no-op):
   * 节拍调度归本服务,期限/解除/CAS 判定归 store(data-model §9)。
   */
  readonly vodInput?: VodInputStore;
  /**
   * 010 T062 过渡清理扫描面(TransitionCleanupService.runCleanupSweep 的结构子集;
   * 缺位 = 过渡清理 no-op,既有保留面零变化):过期 pending 翻转/24h 保护窗消费/
   * 引用图清理/cleanup 持久标记补投 —— 挂本服务既有节拍链(启动恢复首拍 + watchdog
   * 15s 同拍),全部原语守卫状态谓词幂等可重试(I5「失败/重启扫描重试」)。
   */
  readonly transitionCleanup?: {
    runCleanupSweep(nowMs?: number): Promise<TransitionCleanupSweepOutcome>;
  };
  /**
   * 010 T084 vod 保留清扫面(VodRetentionService.runRetentionSweep 的结构子集;
   * 缺位 = vod 清扫 no-op,既有保留面零变化,先例同 transitionCleanup):过期幂等
   * operation/偏好 operation/登记候选回收 + 物化 24h 保护窗满组按引用图整组清理
   * (data-model §4;T081 报告移交的 vod_registered_candidate 24h 清理归 T084)。
   * 生产装配:online-vod.module 以自有每日节拍链装配同一入口(跨上下文发布面未放开
   * 该服务的出口);本端口是 T081 节拍链的挂点 —— 组合根一旦传入即并入 watchdog 链,
   * 两处调度同谓词幂等,并存无害。结果形状经 type alias 隐式索引签名结构相容。
   */
  readonly vodRetention?: {
    runRetentionSweep(nowMs?: number): Promise<Record<string, number>>;
  };
}

export interface RetentionOutcome {
  /** 本次删除的审计失败事件行数 */
  readonly failureEventsDeleted: number;
  /** 本次删除的过期票行数(不含活跃 session 名下受保护票) */
  readonly expiredTicketsDeleted: number;
}

/** 未起播回收单拍结果(可测入口返回;供 spec/装配观察) */
export interface UnstartedReclaimOutcome {
  /** 本拍进入清单的会话数(store 扫描面输出) */
  readonly scanned: number;
  /** 本拍条件回收成功的会话数(两 watcher CAS 赢家数) */
  readonly reclaimed: number;
}

/** 每日清理节拍(每日一次;data-model「审计保留 30 天后清理」的执行频率) */
const DAILY_INTERVAL_MS = 24 * 60 * 60 * 1000;

/**
 * 未起播回收扫描节拍(固定;与 lifecycle 失联扫描 15s 同量纲,60s 期限留 ≥3 拍裕度)。
 * 期限值本身(60s)是 store 侧判定(data-model §9 锚点 created_at),本常量仅是扫描频率。
 */
const UNSTARTED_READY_WATCHDOG_INTERVAL_MS = 15_000;

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

  /**
   * 未起播 ready 会话固定期限回收(T045 可测入口;节拍链每拍调用):
   * 先扫清单(listReclaimableUnstartedReadySessions:created_at 起 60s 未 playback_started_at
   * 的 ready 会话;heartbeat/renew 不续命、暂停不重开期限均为 store 判定)再逐会话条件回收
   * (reclaimExpiredUnstartedReadySession:两 watcher CAS,输家 {reclaimed:false} 零写入)。
   * 扫描与回收之间的起播/终态漂移由 store 条件 UPDATE 守卫(playing 解除后不会被触达);
   * 端口缺位 no-op(既有装配/单测形态零变化)。
   */
  async runUnstartedReadyReclaim(nowMs?: number): Promise<UnstartedReclaimOutcome> {
    const vodInput = this.deps.vodInput;
    if (vodInput === undefined) {
      return { scanned: 0, reclaimed: 0 };
    }
    const at = nowMs ?? this.clock.now();
    const rows = await vodInput.listReclaimableUnstartedReadySessions({ nowMs: at });
    let reclaimed = 0;
    for (const row of rows) {
      const outcome = await vodInput.reclaimExpiredUnstartedReadySession({
        householdId: row.householdId,
        sessionId: row.sessionId,
        nowMs: at,
      });
      if (outcome.reclaimed) {
        reclaimed += 1;
      }
    }
    return { scanned: rows.length, reclaimed };
  }

  /**
   * 过渡清理扫描(010 T062 可测入口;启动恢复首拍 + watchdog 节拍每拍调用):
   * 过期 pending 翻转/槽释放、24h 保护窗消费(已消费 intent/slot/receipt 依赖序删除,
   * 引用图保护:session/ledger/被引用 receipt 与计划不在删除面)、cleanup 持久标记
   * 仍 pending 的活动会话补投幂等空 stop。端口缺位 no-op(既有装配零变化);
   * 单拍异常不中断节拍链(全原语幂等,下一拍续扫)。
   */
  async runTransitionCleanupSweep(nowMs?: number): Promise<TransitionCleanupSweepOutcome | undefined> {
    const transitionCleanup = this.deps.transitionCleanup;
    if (transitionCleanup === undefined) {
      return undefined;
    }
    return transitionCleanup.runCleanupSweep(nowMs ?? this.clock.now());
  }

  /**
   * vod 保留清扫(010 T084 可测入口;watchdog 节拍每拍 + 启动首拍调用):过期幂等
   * operation/偏好 operation/登记候选联合回收 → 物化 24h 窗满组按引用图整组清理。
   * 端口缺位 no-op 返回 undefined(既有装配/单测形态零变化);单拍异常不中断节拍链
   * (全原语幂等,下一拍续扫)。
   */
  async runVodRetentionSweep(nowMs?: number): Promise<Record<string, number> | undefined> {
    const vodRetention = this.deps.vodRetention;
    if (vodRetention === undefined) {
      return undefined;
    }
    return vodRetention.runRetentionSweep(nowMs ?? this.clock.now());
  }

  /** 启动定时链(缺省关闭;生产装配在启动引导就绪门后调用):每日清理 + 未起播回收两条 */
  start(): void {
    if (this.timersRunning) {
      return;
    }
    this.timersRunning = true;
    const epoch = this.epoch + 1;
    this.epoch = epoch;
    void this.retentionLoop(epoch);
    void this.unstartedReclaimLoop(epoch);
    // 010 T081 收口:启动首拍三链(过渡清理扫描[含失效 intent 翻转]→ 未起播回收)。
    // T062 首拍只挂过渡清理;未起播 ready 会话在重启停机窗口内到期的,原实现要等
    // 首个 15s 节拍 —— 现重启即收口(data-model §9「失败/重启扫描重试」;异常吞并不
    // 阻断启动,两链全原语幂等可重试)
    void this.startupRecoveryBeat();
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

  /** 未起播回收扫描链(固定节拍;单拍异常吞并不中断,回收幂等 —— store 条件 UPDATE) */
  private async unstartedReclaimLoop(epoch: number): Promise<void> {
    while (this.timersRunning && epoch === this.epoch) {
      await this.clock.delay(UNSTARTED_READY_WATCHDOG_INTERVAL_MS);
      if (!this.timersRunning || epoch !== this.epoch) {
        return;
      }
      await this.watchdogBeat();
    }
  }

  /**
   * watchdog 单拍(010 T081 收口:节拍链覆盖顺序;010 T084 增第三链)—— 先过渡清理
   * 扫描,后未起播回收,末尾 vod 保留清扫:cleanup 持久标记会话由授权面终止(补投幂等
   * 空 stop,经生命周期端口取消任务并安排资源结算),期限回收兜底剩余者;vod 清扫
   * 置末(过渡过期行/计划回收已在同拍先行,窗满组的引用矩阵按持久事实判定,顺序仅
   * 影响同拍收敛轮数,不影响正确性)。三链独立可测入口(runTransitionCleanupSweep /
   * runUnstartedReadyReclaim / runVodRetentionSweep)不变;单拍异常各自吞并不中断
   * 定时链(全原语幂等,下一拍续扫)。
   */
  private async watchdogBeat(): Promise<void> {
    try {
      await this.runTransitionCleanupSweep();
    } catch {
      // 单拍扫描异常不中断定时链(幂等,下一拍继续;调度链常驻)
    }
    try {
      await this.runUnstartedReadyReclaim();
    } catch {
      // 同上:单拍异常不中断定时链
    }
    try {
      await this.runVodRetentionSweep();
    } catch {
      // 010 T084:单拍 vod 清扫异常不中断定时链(清扫幂等,下一拍继续)
    }
  }

  /**
   * 启动首拍(010 T081 收口):与 watchdog 单拍同序(过渡清理扫描 → 未起播回收),
   * 不等首个 15s 节拍 —— 重启停机窗口内过期的失效 intent / cleanup 持久标记 /
   * 未起播 ready 会话在启动即收口一轮,再交由节拍链接续(I5「失败/重启扫描重试」)。
   * 异常吞并不阻断启动(全原语幂等,下一节拍续扫)。
   */
  private async startupRecoveryBeat(): Promise<void> {
    await this.watchdogBeat();
  }

  /**
   * 审计清理:occurred_at <= now-recordRetentionDays 的 failure_event 删除
   * (保留满 30 天即清理:恰好 30 天删/29 天留)。仅删审计子行,
   * 父级媒体身份行不受影响(FK RESTRICT 语义 + 本方法根本不触父表)。
   */
  private pruneExpiredFailureEvents(nowMs: number): number {
    const horizonMs = nowMs - this.deps.budgets.lifecycle.recordRetentionDays * 86_400_000;
    return playbackStore().deleteFailureEventsAtOrBefore(iso(horizonMs));
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
    const expired = playbackStore().listExpiredTicketRowsBefore(iso(cutoffMs));
    if (expired.length === 0) {
      return 0;
    }
    const activeSessionIds = new Set(
      playbackStore().listSessionIdsInStates([...PLAYBACK_ACTIVE_SESSION_STATES]),
    );
    const deletableIds = expired.filter((row) => !activeSessionIds.has(row.sessionId)).map((row) => row.id);
    if (deletableIds.length === 0) {
      return 0;
    }
    return playbackStore().deleteTicketsByIds(deletableIds);
  }
}
