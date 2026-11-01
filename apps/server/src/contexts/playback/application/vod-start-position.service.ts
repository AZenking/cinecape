import type { InputBindingTx } from '@contexts/playback/application/playback-work-set.port';
import {
  compareTargetHistoryRevision,
  type PlaybackResumePositionPort,
  type TargetHistoryChangeSignal,
  type TargetHistoryReaderPort,
} from '@contexts/personal-data';

/**
 * VOD 起点计算端口(010 T041,US2)—— beginning/target_history/transition_carry
 * 三起点唯一计算面 + 「本次 probe 后只冻结一次」接缝。
 *
 * 定位(tasks.md T041 原文 + 审查补充):本服务是 online-vod continuity.service(T039)
 * 「唯一权威起点语义」的**端口化封装 + 历史读取**,不重写任何裁决 —— resume 的资格
 * 8 步裁决(computeResumeEligibility)与冻结语义(resolveStartPoint)全部经
 * StartPointAdjudicatorPort 注入,由组合根(playback.module,T043 接线)绑定 T039
 * 纯函数(结构兼容端口面,零跨上下文深导入,R2);本服务自身只做:
 * - 三起点入口判别(T073 三互斥形式化,入参判别一途):carry 快照在场 → transition_carry
 *   路径(不读目标历史、不做容差降级);否则 requestedMode:beginning=显式从头(0);
 *   resume/target_history=经 T039 裁决;requestedMode='transition_carry' 而无快照 =
 *   直呼未接线,稳定错误形态拒绝;
 * - 目标历史读取:经 personal-data TargetHistoryReaderPort(T041 读取面,api.md §7 I3
 *   「target_history 在 probe 后仍读取当前历史」),expectedHistoryRevision 不一致返回
 *   {kind:'history-changed'} 供调用方映射 NEXT_PLAN_CHANGED(probe 前后都可调用);
 * - 线上 duration 不从历史兜底:data-model §5「本次 probe 未知则不能用历史 duration
 *   作为在线兜底」—— currentDurationSeconds 恒为本次 probe 原样(E1 写入侧已由 T040
 *   拒绝,本读取侧同样不兜底);静态媒体沿用既有静态续播语义(经 history.service
 *   readResumeFreezePosition 判定,FR-020「静态媒体原续播行为保持不变」零变化);
 * - nearEnd 仅返回提示字段(FR-019「接近结尾窗口只提示,不能仅因位于最后 30 秒强制
 *   从头」),不参与任何资格判定;
 * - 冻结一次接缝(FR-021):决策产出后由调用方(T043 resolver / T042 location.service)
 *   经 freezeOnce 落 playback_input_binding.frozen_start_seconds —— 冻结写面归属 T016
 *   InputBindingTx.freezeStartSeconds(transaction-participants;frozen_at 持久列守卫
 *   「已冻结(无论值)」,NULL 起点亦属合法冻结;T042 playback-input-store.drizzle 文件头
 *   裁决「本 store 不重复暴露 freeze」),本服务只提供 freezeOnce 纯编排帮助函数,
 *   已冻结(command.frozen 非 null)时原样返回冻结起点,不再第二次读取历史覆盖。
 *
 * 结果面(供 T046 PlaybackDto.startBasis/resumeDisposition/resumeReason 与 T043
 * ready 提交消费;HTTP 形态归 T046):
 * - {kind:'computed', startBasis, disposition, resumeReason, startSeconds, nearEnd,
 *   historyRevision}:本次起点决策(startBasis ∈ beginning|target_history|transition_carry;
 *   carry 自 T073 起由 carry 快照在场产出 —— 不再由调用方直构);
 * - {kind:'history-changed', currentHistoryRevision}:next 计划目标历史已变化 —— 调用方
 *   映射 409 NEXT_PLAN_CHANGED(会话进入 failed,不复活源,不用新位置替换用户确认);
 * - {kind:'carry-not-wired'}:requestedMode='transition_carry' 但未携 carry 快照
 *   (US4 消费过渡不经此形态;仅直呼未接线请求的稳定拒绝形态)。
 */

/* ------------------------------------------------------------------ */
/* 值模型(裁决面类型为 T039 continuity.service 结构镜像;端口注解同构,      */
/* 组合根以 T039 纯函数直接满足,零深导入)                                */
/* ------------------------------------------------------------------ */

/** 起点计算请求模式:startMode 面(beginning|resume)+ positionMode 面(target_history) + carry */
export type VodRequestedStartMode = 'beginning' | 'resume' | 'target_history' | 'transition_carry';

/** 本服务可产出的起点依据(三互斥:beginning/target_history 由本服务计算;transition_carry
 * 自 T073 起由 carry 快照在场产出 —— 同一 freezeOnce 冻结 seam,US4 过渡面消费) */
export type VodComputedStartBasis = 'beginning' | 'target_history' | 'transition_carry';

/**
 * disposition 的 resumeReason 全集(api.md §1 PlaybackDto.resumeReason;与 T039
 * ResumeDispositionReason 同域的结构镜像)。'pending'/'match_conflict'/'unavailable'
 * 不由本服务产出(preparing 未冻结属 DTO 默认值/match_conflict 属 US4/unavailable 属接口层)。
 */
export type VodResumeDispositionReason =
  | 'accepted'
  | 'requested_beginning'
  | 'no_history'
  | 'content_changed'
  | 'continuity_changed'
  | 'duration_changed'
  | 'completed'
  | 'invalid_position'
  | 'duration_unknown';

/** 历史记录事实(T039 ResumeHistoryRecord 结构镜像;保存产生时快照,只读消费) */
export interface VodResumeHistoryRecordFacts {
  readonly mediaId: string;
  readonly positionSeconds: number;
  /** 保存产生时的可信时长;未知 → null */
  readonly durationSeconds: number | null;
  readonly completed: boolean;
  readonly contentRevision: number;
  readonly continuityRevision: number;
}

/** 本次 probe 当前事实(T039 ResumeCurrentFacts 结构镜像) */
export interface VodResumeCurrentFacts {
  readonly mediaId: string;
  readonly contentRevision: number;
  readonly continuityRevision: number;
  /** 本次 probe 可信时长;未知 → null(绝不以历史 duration 兜底冒充本次事实) */
  readonly currentDurationSeconds: number | null;
}

/** 已冻结起点(T039 FrozenStartPoint 结构镜像;FR-021 冻结一次) */
export interface VodFrozenStartPoint {
  readonly startBasis: VodComputedStartBasis;
  readonly disposition: 'resume' | 'beginning';
  /** 冻结时处置原因;恒 ≠ 'pending'(preparing 未冻结属 DTO 层默认值) */
  readonly resumeReason: VodResumeDispositionReason | null;
  readonly startSeconds: number;
}

/**
 * 起点裁决端口(T039「唯一权威起点语义」的端口化落点):组合根(playback.module,T043
 * 接线)以 online-vod continuity.service 的 resolveStartPoint 纯函数绑定(结构兼容:
 * 该函数签名与本端口输入/输出面同构;8 步资格裁决 computeResumeEligibility 与冻结
 * pass-through 均在其内部,本服务零裁决逻辑)。
 */
export interface StartPointAdjudicatorPort {
  resolveStartPoint(input: {
    readonly requestedMode: 'beginning' | 'resume';
    readonly history: VodResumeHistoryRecordFacts | null;
    readonly current: VodResumeCurrentFacts;
    /** 已冻结起点;非 null → 原样返回(FR-021),不再读取历史 */
    readonly frozen: VodFrozenStartPoint | null;
  }): VodFrozenStartPoint;
}

/** 起点计算上下文(目标历史读取身份;服务端事实,不接受客户端声明) */
export interface VodStartPositionContext {
  readonly householdId: string;
  readonly profileId: string;
}

/** 来源接受游标身份(api §5 sourceCheckpoint 形态;T072 intent 冻结快照原样) */
export interface VodTransitionCarryCheckpoint {
  /** 游标所属来源代(carry 只冻结来源当前代 ledger;跨代游标不构成 checkpoint) */
  readonly expectedGeneration: number;
  /** 来源 ledger 接受游标 seq(「未接受样本不作为checkpoint」,api §5) */
  readonly sampleSeq: number;
}

/**
 * US4 过渡 carry 快照(T072 消费事务的 intent 冻结快照形态;playback-state §2):
 * - carryPositionSeconds/carryDurationSeconds = 冻结精确 checkpoint 读取后自来源当前代
 *   ledger 复制的 position/duration(data-model §10「所有值服务端读取」;创建
 *   resolveSwitchPositionFacts + 消费事务 (0.5) 双重精确复核,不等即 409
 *   SOURCE_PROGRESS_PENDING 不消费);
 * - sourceCheckpoint = 来源接受游标身份 —— 精确性已由 T072 消费事务复核完毕,本服务
 *   **不复核也不据此裁决**;resolver 后继准备端口(T072 定稿面)仅透传
 *   frozenStartSeconds 时缺省 null(不参与任何裁决,仅钉输入形态与溯源);
 * - carry 路径三不(T073):不读目标历史(historyRevision 恒 0)、不做容差降级
 *   (「目标时长/匹配不兼容回退」族不适用于 carry —— 位置来自已复核的精确游标)、
 *   不做位置越界回退(同前;越界门属 resume 资格裁决,carry 不进 T039)。
 */
export interface VodTransitionCarrySnapshot {
  /** 冻结 carry 起点:精确接受游标位置(computeStartPosition 原样透出为 startSeconds) */
  readonly carryPositionSeconds: number;
  /** 冻结来源 ledger 可信时长;未知 → null(绝不以此兜底本次 probe 时长,data-model §5) */
  readonly carryDurationSeconds: number | null;
  /** 来源接受游标身份;T072 端口面未透传(消费事务已复核)→ null */
  readonly sourceCheckpoint: VodTransitionCarryCheckpoint | null;
}

/** 起点计算命令(computeStartPosition 输入面;全部服务端事实,无客户端位置声明) */
export interface VodStartPositionCommand {
  readonly mediaId: string;
  readonly requestedMode: VodRequestedStartMode;
  /**
   * 本次 probe 可信时长(probe 完成后调用传入 outcome.facts.durationSeconds;probe 前
   * 或未知 → null)。在线媒体路径恒以本值为其 currentDurationSeconds —— 历史.duration
   * 只作为「保存产生时快照」参与 T039 裁决,绝不做本次时长兜底。
   */
  readonly probeDurationSeconds?: number | null;
  /**
   * next 计划冻结的目标历史 revision(api.md §7 I3;无历史=0)。省略 = 非计划路径,
   * 不比对;给出时与当前历史 revision 不一致 → {kind:'history-changed'}(probe 前后
   * 都可调用)。
   */
  readonly expectedHistoryRevision?: number;
  /**
   * US4 过渡 carry 快照(T072 消费事务的 intent 冻结快照;非 null 即入参判别为 carry
   * 路径 —— 三互斥一途,见 VodTransitionCarrySnapshot)。缺省 = 非 carry 路径。
   */
  readonly carry?: VodTransitionCarrySnapshot;
  /**
   * 已冻结起点(调用方从绑定行 frozen_start_seconds/start_basis 读回;FR-021「冻结后
   * 不能再被第二次历史读取覆盖」)。非 null → 原样返回冻结起点(他设备后来更新历史、
   * 偏好变化、时长微漂移都不改变已冻结起点);缺省 null = 本次 probe 后一次计算。
   */
  readonly frozen?: VodFrozenStartPoint | null;
}

/** 起点决策判别联合(见文件头「结果面」) */
export type VodStartPointDecision =
  | {
      readonly kind: 'computed';
      readonly startBasis: VodComputedStartBasis;
      readonly disposition: 'resume' | 'beginning';
      readonly resumeReason: VodResumeDispositionReason | null;
      readonly startSeconds: number;
      /** UI 提示字段(FR-019 接近结尾窗口 min(30s,时长×10%));不影响资格 */
      readonly nearEnd: boolean;
      /** 计算时刻当前目标历史 revision(无历史行 = 0;仅随决策附带的快照信息) */
      readonly historyRevision: number;
    }
  | TargetHistoryChangeSignal
  | { readonly kind: 'carry-not-wired' };

/** 本服务依赖端口(组合根装配;单测以真实实现注入) */
export interface VodStartPositionPorts {
  /** 目标历史读取(personal-data T041 读取面;readTargetHistory/readTargetMediaFacts) */
  readonly targetHistory: TargetHistoryReaderPort;
  /** 起点裁决(T039 continuity.service resolveStartPoint;唯一权威,本服务不重写) */
  readonly adjudicator: StartPointAdjudicatorPort;
  /** 静态媒体续播冻结(personal-data 既有 PlaybackResumePositionPort 旧义;零变化) */
  readonly staticResumeFreeze: PlaybackResumePositionPort;
}

/**
 * 保守失配修订值:历史/媒体当前修订缺失(null)时的输入映射值 —— 与任何合法修订
 * (>=1,0007 CHECK)必不等,使 T039 裁决自然落入 content_changed/continuity_changed
 * 降级从头(0007「旧记录不冒充在线 continuity 证据」;缺证据不自动制造「内容一致」,
 * data-model §3)。裁决本身仍在 T039,本值仅是读取面 → 裁决输入的保守投影。
 */
const NEVER_MATCHES_REVISION = -1;

/** FR-019 接近结尾提示窗口:min(30 秒,总时长 × 10%);只提示,不自动算完成/强制从头 */
const NEAR_END_ABSOLUTE_WINDOW_SECONDS = 30;
const NEAR_END_RELATIVE_WINDOW = 0.1;

/**
 * nearEnd 提示计算(FR-019):0<p<duration 且距结尾落入 min(30s,时长×10%) 窗口 →
 * true。duration 未知/位置越界恒 false。仅 UI 消费,任何资格/冻结路径不得引用本值。
 */
export function nearEndHintOf(positionSeconds: number, durationSeconds: number | null): boolean {
  if (durationSeconds === null || !Number.isFinite(durationSeconds) || durationSeconds <= 0) {
    return false;
  }
  if (!Number.isFinite(positionSeconds) || positionSeconds <= 0 || positionSeconds >= durationSeconds) {
    return false;
  }
  const windowSeconds = Math.min(NEAR_END_ABSOLUTE_WINDOW_SECONDS, durationSeconds * NEAR_END_RELATIVE_WINDOW);
  return durationSeconds - positionSeconds <= windowSeconds;
}

/* ------------------------------------------------------------------ */
/* 服务                                                                  */
/* ------------------------------------------------------------------ */

/**
 * VodStartPositionService(纯类;依赖经构造注入,生产由 playback.module 组合根装配,
 * T043 接线消费)。computeStartPosition 为起点计算唯一入口 —— beginning/resume/
 * target_history/transition_carry 三起点互斥,每次调用恰有一个 startBasis 依据
 * (FR-021「起点必须恰有一个服务端依据」)。
 */
export class VodStartPositionService {
  constructor(private readonly ports: VodStartPositionPorts) {}

  /**
   * 起点计算(决策流,顺序钉死;T073 三互斥入参判别一途 —— carry 快照在场与否是
   * 第一判别,其后 requestedMode 才参与):
   * 0. carry 快照在场 → transition_carry(基于 T072 消费事务复核的冻结 source ledger
   *    快照:startSeconds=carryPositionSeconds 原样透出;不读目标历史、不做容差降级、
   *    不进 T039 资格裁决;expectedHistoryRevision/frozen 均不在本路径消费 —— carry
   *    判别先于一切读取与比对);
   * 0.5 requestedMode='transition_carry' 且无快照 → {kind:'carry-not-wired'}(直呼
   *    未接线的稳定拒绝形态;不读历史不猜起点);
   * 1. 读当前目标历史快照(historyRevision=快照 revision,无行 0);
   * 2. frozen 非 null → 冻结起点原样返回(FR-021;expectedHistoryRevision 比对属冻结
   *    前的 probe 时刻检查,冻结后历史更新不改起点,api.md §7 I3 末句);
   * 3. beginning → {beginning, requested_beginning, 0}(唯一依据 = 用户显式从头;
   *    静态/在线同形,不读裁决);
   * 4. expectedHistoryRevision 给出 → compareTargetHistoryRevision 比对(probe 前后都可
   *    调用;不一致 → {kind:'history-changed'},调用方映射 NEXT_PLAN_CHANGED);
   * 5. resume/target_history(同义:positionMode 面与 startMode 面同一起点裁决):
   *    5a. 静态媒体 → 既有静态续播语义(readResumeFreezePosition 判定,零变化);
   *    5b. 在线媒体 → T039 resolveStartPoint 裁决(currentDurationSeconds=本次 probe
   *        原样,线上 duration 绝不从历史兜底)。
   */
  computeStartPosition(context: VodStartPositionContext, command: VodStartPositionCommand): VodStartPointDecision {
    const { householdId, profileId } = context;
    const { mediaId, requestedMode } = command;

    // 0. carry 路径(三互斥第一判别):carry 快照在场 → transition_carry —— 起点唯一
    //    来源 = T072 消费事务复核过的冻结 checkpoint 位置(carryPositionSeconds 原样
    //    透出,「禁止第二次resume读取覆盖carry」,api §5):
    //    - 不读目标历史:readTargetHistory 零触达,historyRevision 恒 0(carry 只冻结
    //      来源 ledger,他设备目标历史不劫持位置 —— e2e C1 钉面);
    //    - 不做容差降级:carryDurationSeconds 与本次 probe duration 的差异不触发任何
    //      「回退beginning」族判定(位置来自已复核的精确游标,非历史推断;checkpoint
    //      精确性由 T072 创建+消费双重复核,本服务不复核);
    //    - 不进 T039 资格裁决:无 invalid_position/duration_changed 降级面;
    //    - nearEnd 仅提示(FR-019),以本次 probe duration(目标时间轴)计算;
    //      carryDurationSeconds 为冻结来源时长溯源,不参与任何资格判定;
    //    - final 不覆盖:本决策经调用方 freezeOnce 落 frozen_start_seconds 后,frozen_at
    //      守卫吸收一切二次冻结、绑定行回读透传已冻结值(全链验证归 T058;本入口钉
    //      输入形态:快照值即冻结值)。
    if (command.carry !== undefined) {
      const carry = command.carry;
      return {
        kind: 'computed',
        startBasis: 'transition_carry',
        disposition: 'resume',
        resumeReason: 'accepted',
        startSeconds: carry.carryPositionSeconds,
        nearEnd: nearEndHintOf(carry.carryPositionSeconds, command.probeDurationSeconds ?? null),
        historyRevision: 0,
      };
    }

    // 0.5 transition_carry 直呼无快照:US4 接线前的稳定错误形态保留(不读历史不猜起点)
    if (requestedMode === 'transition_carry') {
      return { kind: 'carry-not-wired' };
    }

    // 1. 当前目标历史快照(唯一读取点;revision 无历史行 = 0)
    const snapshot = this.ports.targetHistory.readTargetHistory({ householdId, profileId, mediaId });
    const currentHistoryRevision = snapshot?.revision ?? 0;

    // 2. 冻结一次(FR-021):已冻结起点原样返回,不再第二次历史读取覆盖
    if (command.frozen !== undefined && command.frozen !== null) {
      const frozen = command.frozen;
      return {
        kind: 'computed',
        startBasis: frozen.startBasis,
        disposition: frozen.disposition,
        resumeReason: frozen.resumeReason,
        startSeconds: frozen.startSeconds,
        nearEnd: nearEndHintOf(frozen.startSeconds, command.probeDurationSeconds ?? null),
        historyRevision: currentHistoryRevision,
      };
    }

    // 3. beginning:显式从头(0;不读裁决 —— 唯一依据即用户请求)
    if (requestedMode === 'beginning') {
      return {
        kind: 'computed',
        startBasis: 'beginning',
        disposition: 'beginning',
        resumeReason: 'requested_beginning',
        startSeconds: 0,
        nearEnd: false,
        historyRevision: currentHistoryRevision,
      };
    }

    // 4. next 计划目标历史快照比对(api.md §7 I3;resume/target_history 专属 —— beginning
    //    不受计划历史变化影响:用户已显式选择从头)
    const signal = compareTargetHistoryRevision(snapshot, command.expectedHistoryRevision);
    if (signal !== null) {
      return signal;
    }

    // 5. resume/target_history 裁决
    const mediaFacts = this.ports.targetHistory.readTargetMediaFacts({ householdId, mediaId });
    if (!mediaFacts.online) {
      // 5a. 静态媒体:既有静态续播语义零变化(history.service readResumeFreezePosition 判定;
      //     静态 duration 历史兜底旧义保留 —— FR-020「静态媒体原续播行为保持不变」)。
      //     静态面不新增 resumeReason 语义:有有效位置=accepted,否则 null(旧义无从头原因枚举)。
      const seconds = this.ports.staticResumeFreeze.readResumeFreeze({
        householdId,
        profileId,
        mediaId,
        probeDurationSeconds: command.probeDurationSeconds ?? null,
      });
      return {
        kind: 'computed',
        ...(seconds > 0
          ? { startBasis: 'target_history' as const, disposition: 'resume' as const, resumeReason: 'accepted' as const, startSeconds: seconds }
          : { startBasis: 'beginning' as const, disposition: 'beginning' as const, resumeReason: null, startSeconds: 0 }),
        nearEnd: nearEndHintOf(seconds, snapshot?.durationSeconds ?? null),
        historyRevision: currentHistoryRevision,
      };
    }
    // 5b. 在线媒体:T039 resolveStartPoint 唯一裁决(端口化封装;读取面 → 裁决输入的
    //     保守投影见 NEVER_MATCHES_REVISION)
    const history: VodResumeHistoryRecordFacts | null =
      snapshot === null
        ? null
        : {
            mediaId: snapshot.mediaId,
            positionSeconds: snapshot.positionSeconds,
            durationSeconds: snapshot.durationSeconds,
            completed: snapshot.completed,
            contentRevision: snapshot.contentRevision,
            continuityRevision: snapshot.continuityRevision ?? NEVER_MATCHES_REVISION,
          };
    const current: VodResumeCurrentFacts = {
      mediaId,
      contentRevision: mediaFacts.contentRevision ?? NEVER_MATCHES_REVISION,
      continuityRevision: mediaFacts.continuityRevision ?? NEVER_MATCHES_REVISION,
      // 线上 duration 不兜底:data-model §5「本次 probe 未知则不能用历史 duration 作为
      // 在线兜底」—— 恒为本次 probe 原样(E1 写入侧 T040 已拒绝,读取侧同规)
      currentDurationSeconds: command.probeDurationSeconds ?? null,
    };
    const point = this.ports.adjudicator.resolveStartPoint({ requestedMode: 'resume', history, current, frozen: null });
    return {
      kind: 'computed',
      startBasis: point.startBasis,
      disposition: point.disposition,
      resumeReason: point.resumeReason,
      startSeconds: point.startSeconds,
      nearEnd: nearEndHintOf(point.startSeconds, current.currentDurationSeconds),
      historyRevision: currentHistoryRevision,
    };
  }
}

/* ------------------------------------------------------------------ */
/* 冻结一次接缝(FR-021)                                                 */
/* ------------------------------------------------------------------ */

/**
 * freezeOnce:probe 后把本次起点决策冻结进固定输入绑定(每 session/generation 最多一
 * 有效绑定,frozen_start_seconds nullable 直到 probe,data-model §6)。
 *
 * 归属说明(报告注记):冻结写面归 T016 InputBindingTx.freezeStartSeconds
 * (infrastructure/transaction-participants;0007 新增持久列 frozen_at 守卫「已冻结
 * (无论值)」——NULL 起点亦属合法冻结,仅首冻结落值);T042 的
 * playback-input-store.drizzle 文件头裁决「本 store 不重复暴露 freeze」,故本接缝不经
 * T042 store,而由调用方(T043 resolver 事务工作集 / T042 location.service)以事务内
 * InputBindingTx 调用本函数。本函数为纯编排:decision.kind ≠ 'computed'(history-changed
 * / carry-not-wired)不产生冻结(调用方按各自语义转 failed/拒绝);computed 分支只落
 * startSeconds,重复调用被 frozen_at 守卫吸收(仅一次生效)。
 */
export function freezeOnce(input: {
  readonly householdId: string;
  readonly bindingId: string;
  readonly decision: VodStartPointDecision;
  /** 事务内固定输入绑定写面(T016 参与者;调用方持有事务) */
  readonly inputBinding: InputBindingTx;
}): void {
  if (input.decision.kind !== 'computed') {
    return;
  }
  input.inputBinding.freezeStartSeconds(input.householdId, input.bindingId, input.decision.startSeconds);
}
