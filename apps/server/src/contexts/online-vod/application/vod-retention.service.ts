/**
 * 010-online-vod T084(US5 · Phase 8)—— vod 保留清扫服务(应用层纯类,单测直构)。
 *
 * 职责(tasks.md T084 原文):「物化24h保护后按引用图整组清理:历史/名单/活动或保留
 * 终态session/slot/intent/operation保护、先过期幂等/意图;不删历史释放配额,重复运行
 * 不破坏FK。审查补充:补偏好operation24h、计划受引用保护、登记候选与operation联合
 * 回收」。T081 报告移交面:vod_registered_candidate 的 24h 清理归本任务 —— 本服务
 * 的核心交付。
 *
 * 权威依据(实现侧不自创语义):
 * - docs/specs/010-online-vod/data-model.md §4:10 启用源/5000 父/100000 子;未观看且
 *   无历史/名单/会话FK/意图/幂等保护/其他持久引用的组,materialized_at 至少 24h 后才
 *   可整组清理,ID 不复用;先过期幂等/意图,再按完整引用图清理;活动/保留的终态记录
 *   不能破坏FK;schema 不能靠删除历史释放配额;
 * - data-model.md §9:过期后先删不再可消费/重放的 intent,再按依赖清理 slot/receipt/
 *   终态 ledger/session;Profile 历史长期保留且不依赖这些行 —— 历史/会话行不在本服务
 *   删除面(T062 既有收口同款);
 * - data-model.md §10:profile_vod_preference_operation 过期清理**不删偏好**;
 *   playback_next_plan 被 pending/consumed intent 引用后按 intent 保留(计划受引用
 *   保护);vod_registered_candidate 至少 24h 保护映射/目标,过期按引用清理 —— 与
 *   operation(同保护期、同事务提交)联合回收;
 * - contracts/api.md §3 物化 24h 目标保护段:目标 24h 受回收保护;满额 409 不挤占
 *   既有目标、不删除个人历史。
 *
 * ───────────────────────── 引用矩阵(硬编码对照 data-model §4)─────────────────────────
 * 标题组 = vod_title 行 + 父媒体 + 全部 vod_line/vod_episode/子媒体 + media_relation +
 * vod_detail_snapshot + vod_episode_sequence + source_entry(vod) + playback_source(online)。
 * 整组删除的前置:materialized_at 已过 24h 保护窗 **且** 以下任一引用都不存在(哪怕
 * 24h 已过,任何引用存在 → 整组保留):
 *
 * | # | 引用类           | 持久事实(表.列)                                          | 清除方          |
 * |---|------------------|----------------------------------------------------------|-----------------|
 * | 1 | 历史             | profile_viewing_history.media_id(父+全部子媒体)          | 无(长期保留)   |
 * | 2 | 名单             | profile_policy.allowed/blocked_media_ids JSON 含组媒体    | 用户改名单      |
 * | 3 | 会话FK           | playback_session.media_id(任意状态:活动+保留终态)        | 无(行不删,T062)|
 * | 4 | 意图             | playback_transition_intent.target_media_id(任意状态)      | T062(仅consumed)|
 * | 5 | 幂等保护         | vod_materialization_operation.expires_at>now 指向组媒体   | 本服务(过期优先)|
 * | 6 | 登记候选         | vod_registered_candidate.expires_at>now.target_media_id   | 本服务(过期优先)|
 * | 7 | 计划             | playback_next_plan.target_media_id(受引用保留,T059 面)    | T059/T062 面    |
 * | + | 其他持久引用     | playback_failure_event / playback_progress_state /
 * |   | (§4 兜底)        | profile_channel_favorite / manual_epg_binding 的 media_id | 各自所有者      |
 *
 * 会话类覆盖 slot/receipt/ledger/binding 的传递保护:这些行全部 FK 指向 playback_session
 * (行不删),其存在即意味着同名会话行存在 → 会话类引用成立;playback_source 删除另带
 * 「无 session/input_binding 直指该资源行」守卫。到期顺序(§4「先过期幂等/意图,再按
 * 完整引用图清理」):先删过期登记候选(FK 子行,与过期 operation 联合回收)→ 过期
 * operation → 过期偏好 operation(不删偏好)→ 过期未引用 next plan(T059 面已有则
 * 复用:结构性端口缺位 = 交由 retention 节拍链上先行执行的 T062 runCleanupSweep,
 * 其 deleteExpiredUnreferencedNextPlans 同谓词;本服务不重复实现)→ 组清扫。
 *
 * ───────────────────────── 配额与幂等语义 ─────────────────────────
 * - 配额口径:QuotaStore(T070)净额 = COUNT(vod_title)/COUNT(vod_episode) 当前在册行数;
 *   本服务**不删历史/名单/会话/意图**,组清扫后计数自然回落,新物化即有净额(配额回升
 *   不是显式动作);
 * - ID 不复用:全部 DELETE,无任何 sequence/rowid 重置;媒体身份为服务端 UUID,删除后
 *   同上游键重物化获得全新 ID;
 * - 重复运行幂等:每个删除语句带完整保护谓词(逐删除带守卫),第二拍全零;单组删除在
 *   BEGIN IMMEDIATE 短事务内(重验窗口/引用矩阵后落删除),foreign_keys=ON 下依赖序
 *   (sequence→snapshot→playback_source→source_entry→vod_episode→media_relation→
 *   子媒体→父媒体→vod_line→vod_title)全程不破坏 FK。
 *
 * ───────────────────────── 节拍与装配 ─────────────────────────
 * - 独立可测入口:runRetentionSweep(nowMs?)(纯编排,store 注入);start()/stopTimers()
 *   为 lifecycle 同款定时链(每日节拍 + 启动首拍追赶,T045/T081 先例),缺省不自动启动;
 * - T081 retention 节拍链挂点:playback-retention.service.ts 增设可选结构端口
 *   vodRetention + 独立入口 runVodRetentionSweep + watchdog 节拍链第三链(缺位 no-op,
 *   先例照 T062 transitionCleanup)——生产装配由 online-vod.module 以自有每日节拍链
 *   装配(跨上下文发布面未放开本服务的出口,组合根接线归后续任务;两处调度同谓词
 *   幂等,并存无害)。
 *
 * 依赖边界(ADR-0015 D1):应用层零 drizzle/better-sqlite3/@platform/database 值导入;
 * 持久原语经本文件声明的结构端口 VodRetentionStore 由 infrastructure/online-vod-store.
 * drizzle.ts 提供(装配/单测 rig 绑定);零网络。
 */
import { Injectable, type OnApplicationShutdown } from '@nestjs/common';
import { MATERIALIZATION_RETENTION_MS } from './publication.service';

/* ------------------------------------------------------------------ */
/* 结构端口(基础设施实现于 online-vod-store.drizzle.ts;单测可直构)      */
/* ------------------------------------------------------------------ */

/** 标题组引用(清扫清单行) */
export interface VodGroupRef {
  readonly householdId: string;
  readonly titleId: string;
  readonly materializedAt: string;
}

/** 引用矩阵逐项(七类命名引用 + §4 其他持久引用兜底;供清扫判定与单测断言) */
export type VodGroupReferenceMatrix = {
  /** 历史:profile_viewing_history 指向组媒体(长期保留,不随清扫消失) */
  history: boolean;
  /** 名单:profile_policy allowed/blocked JSON 列表含组媒体 */
  policyList: boolean;
  /** 会话FK:playback_session 任意状态指向组媒体(覆盖 slot/receipt/ledger 传递保护) */
  session: boolean;
  /** 意图:playback_transition_intent 任意状态目标为组媒体 */
  intent: boolean;
  /** 幂等保护:未过期(24h 内)vod_materialization_operation 指向组媒体 */
  materializationOperation: boolean;
  /** 登记候选:未过期 vod_registered_candidate 目标为组媒体 */
  registeredCandidate: boolean;
  /** 计划:playback_next_plan 目标为组媒体(受引用保留,T059 面) */
  nextPlan: boolean;
  /** 其他持久引用(§4 兜底):failure_event/progress_state/channel_favorite/manual_epg_binding */
  otherPersistent: boolean;
};

/** 单组清扫结论:deleted=整组已删;protected=窗满但引用矩阵命中(整组保留);
 *  window_active=保护窗未过(或组已消失,清单竞态)——不落入任一删除/保留计数 */
export type VodGroupSweepResult = 'deleted' | 'protected' | 'window_active';

/**
 * vod 保留清扫持久原语(单语句同步;全部语句强制 household_id 条件,唯一例外为
 * 全库过期行回收 —— expires_at 谓词自身限定回收面,行内 household_id 随行删除)。
 */
export interface VodRetentionStore {
  /** 过期登记候选删除数:expires_at 已过 **或** 其物化 operation 已过期(联合回收,FK 子行先行) */
  deleteExpiredRegisteredCandidates(nowIso: string): number;
  /** 过期物化幂等 operation 删除数(候选已先行;committed 结果 24h 固定保留到期) */
  deleteExpiredMaterializationOperations(nowIso: string): number;
  /** 过期偏好写入 operation 删除数(绝不触碰 profile_vod_preferences,data-model §10) */
  deleteExpiredPreferenceOperations(nowIso: string): number;
  /** 24h 保护窗已过的标题组清单(清扫候选;确定序 household,id) */
  listVodGroupsPastProtection(cutoffIso: string): VodGroupRef[];
  /** 单组引用矩阵(七类命名引用 + 兜底;清扫判定与单测断言面) */
  describeVodGroupReferences(group: VodGroupRef, nowIso: string): VodGroupReferenceMatrix;
  /**
   * 单组清扫:BEGIN IMMEDIATE 短事务内重验保护窗与引用矩阵,干净则按 FK 依赖序整组
   * 删除(逐删除带保护谓词);返回 deleted/protected/window_active。
   */
  sweepVodGroup(group: VodGroupRef, nowMs: number): VodGroupSweepResult;
}

/* ------------------------------------------------------------------ */
/* 服务依赖与结果                                                        */
/* ------------------------------------------------------------------ */

/** 过期未引用 next plan 回收的结构端口(T059 面已有则复用;缺位 = 交由节拍链先行面) */
export interface VodNextPlanRecyclePort {
  /** 与 PlaybackTransitionStore.deleteExpiredUnreferencedNextPlans 同谓词(过期且 ref 已解绑且无 intent 引用) */
  deleteExpiredUnreferencedNextPlans(nowIso: string): number;
}

export interface VodRetentionServiceDeps {
  readonly store: VodRetentionStore;
  /** 注入时钟(ms;缺省真实系统时钟;单测注入 FakeClock) */
  readonly clock?: () => number;
  /** 过期未引用计划回收(T059 面;缺位 no-op —— 节拍链上 T062 扫描先行覆盖) */
  readonly nextPlanRecycle?: VodNextPlanRecyclePort;
}

/** 清扫单拍结果(type alias:对象字面量别名具隐式索引签名,结构端口相容) */
export type VodRetentionSweepOutcome = {
  /** 过期登记候选删除数(含与过期 operation 的联合回收) */
  readonly expiredRegisteredCandidatesDeleted: number;
  /** 过期物化幂等 operation 删除数 */
  readonly expiredMaterializationOperationsDeleted: number;
  /** 过期偏好写入 operation 删除数(偏好行不动) */
  readonly expiredPreferenceOperationsDeleted: number;
  /** 过期未引用 next plan 回收数(nextPlanRecycle 端口缺位恒 0,T059 面自有计数) */
  readonly expiredUnreferencedNextPlansRecycled: number;
  /** 本拍整组删除的标题组数 */
  readonly groupsDeleted: number;
  /** 本拍窗满但受引用保护(整组保留)的标题组数 */
  readonly groupsRetainedProtected: number;
};

/** 全零结果(幂等二拍/缺位形态断言面) */
export function emptyVodRetentionSweepOutcome(): VodRetentionSweepOutcome {
  return {
    expiredRegisteredCandidatesDeleted: 0,
    expiredMaterializationOperationsDeleted: 0,
    expiredPreferenceOperationsDeleted: 0,
    expiredUnreferencedNextPlansRecycled: 0,
    groupsDeleted: 0,
    groupsRetainedProtected: 0,
  };
}

/** 每日清扫节拍(24h 保护窗的执行粒度;与 T045 每日清理同量纲) */
export const VOD_RETENTION_SWEEP_INTERVAL_MS = 24 * 60 * 60 * 1000;

/** 毫秒 → UTC ISO-8601 毫秒 Z(与持久层时间文本同形态;字典序=时间序) */
function iso(ms: number): string {
  return new Date(ms).toISOString();
}

/* ------------------------------------------------------------------ */
/* 服务                                                                  */
/* ------------------------------------------------------------------ */

@Injectable()
export class VodRetentionService implements OnApplicationShutdown {
  private readonly clock: () => number;
  /** 定时链运转标志与纪元(stopTimers 后 start 可重启,旧循环凭纪元自退出,不双链) */
  private timersRunning = false;
  private epoch = 0;

  constructor(private readonly deps: VodRetentionServiceDeps) {
    this.clock = deps.clock ?? (() => Date.now());
  }

  /**
   * 单拍保留清扫(独立可测入口;nowMs 缺省取注入时钟):过期优先(候选→operation→
   * 偏好 operation→过期未引用计划)→ 24h 窗满组按引用图整组清扫。幂等 —— 对同一库
   * 重复执行,第二拍全零;单组失败只回滚该组(逐组短事务),不中断整拍。
   */
  async runRetentionSweep(nowMs?: number): Promise<VodRetentionSweepOutcome> {
    const at = nowMs ?? this.clock();
    const nowIso = iso(at);
    const store = this.deps.store;
    // ── 过期优先(data-model §4:先过期幂等/意图,再按完整引用图清理)──
    // 候选是 operation 的 FK 子行(联合回收)必须先行;两语句各自单语句自动提交,
    // 中断窗口内(候选已删/operation 未删)下一拍续扫即收敛。
    const expiredRegisteredCandidatesDeleted = store.deleteExpiredRegisteredCandidates(nowIso);
    const expiredMaterializationOperationsDeleted = store.deleteExpiredMaterializationOperations(nowIso);
    // 偏好 operation 过期清理;profile_vod_preferences 永不在本服务删除面(§10)
    const expiredPreferenceOperationsDeleted = store.deleteExpiredPreferenceOperations(nowIso);
    // 过期未引用 next plan(T059 面已有则复用;缺位 = 节拍链 T062 扫描先行覆盖同谓词)
    const expiredUnreferencedNextPlansRecycled =
      this.deps.nextPlanRecycle?.deleteExpiredUnreferencedNextPlans(nowIso) ?? 0;
    // ── 引用图整组清理(24h 窗满组)──
    const groups = store.listVodGroupsPastProtection(iso(at - MATERIALIZATION_RETENTION_MS));
    let groupsDeleted = 0;
    let groupsRetainedProtected = 0;
    for (const group of groups) {
      const result = store.sweepVodGroup(group, at);
      if (result === 'deleted') {
        groupsDeleted += 1;
      } else if (result === 'protected') {
        groupsRetainedProtected += 1;
      }
    }
    return {
      expiredRegisteredCandidatesDeleted,
      expiredMaterializationOperationsDeleted,
      expiredPreferenceOperationsDeleted,
      expiredUnreferencedNextPlansRecycled,
      groupsDeleted,
      groupsRetainedProtected,
    };
  }

  /** 启动定时链(缺省关闭;生产装配在就绪门后调用):启动首拍追赶 + 每日节拍 */
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

  /** 关闭 hook:停转清扫链(进程退出即定时器终止,遗留清理由下次启动接续) */
  onApplicationShutdown(): void {
    this.stopTimers();
  }

  /**
   * 清扫定时链(T045/T081 lifecycle 同款):启动首拍立即追赶(停机窗口内到期的
   * 过期行/窗满组重启即收口),此后每日一拍;单拍异常吞并不中断定时链(清扫幂等,
   * 下一拍续扫)。
   */
  private async retentionLoop(epoch: number): Promise<void> {
    while (this.timersRunning && epoch === this.epoch) {
      try {
        await this.runRetentionSweep();
      } catch {
        // 单拍清扫异常不中断定时链(幂等,下一拍继续;调度链常驻)
      }
      if (!this.timersRunning || epoch !== this.epoch) {
        return;
      }
      await this.clockDelay(VOD_RETENTION_SWEEP_INTERVAL_MS);
    }
  }

  private async clockDelay(ms: number): Promise<void> {
    await new Promise<void>((resolve) => {
      setTimeout(resolve, ms);
    });
  }
}
