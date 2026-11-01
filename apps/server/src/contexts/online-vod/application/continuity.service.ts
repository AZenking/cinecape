/**
 * 010 T039 — 续播候选/最终资格/起点冻结(应用层纯规则)。
 *
 * 纯函数模块惯例(对齐本上下文 application 层惯例):零 Nest 装饰器、零 I/O、零时钟/
 * 随机,仅以入参值对象裁决;唯一 domain 依赖为 continuity.rules 的
 * startDriftToleranceSeconds(FR-020 容差)。本服务不产出(逐字钉面):
 * - 'pending'(preparing 未冻结属 DTO 层默认值);
 * - 'match_conflict'(US4 源匹配 T068/T072 面);
 * - 'unavailable'(无记录/静态映射场景,接口层产出);
 * - transition_carry 起点(过渡服务冻结 source checkpoint,US4 接线,不经本服务;
 *   FrozenStartPoint.startBasis 类型上恒 ≠ 'transition_carry');
 * - 静态媒体续播(静态规则不经本服务,T041 在自己的模块接线)。
 * 「不批量升级历史」:本服务只做单次转换判定/单次资格裁决,历史修订永远取保存产生
 * 时的快照值与本次 probe 当前事实比对,绝不回填历史记录(data-model §3)。
 *
 * 来源标注(实现侧不自创语义,契约冻结面):
 * - docs/specs/010-online-vod/data-model.md §3:「历史保存产生时的内容/连续性修订及
 *   证据,不能批量跟随当前状态升级。旧会话修订不匹配时拒绝新交付/进度,准备转failed,
 *   需新resolve」——裁决第 2/3 条;
 * - docs/specs/010-online-vod/contracts/playback-state.md §3:「history
 *   canAttemptResume仅候选,若本次probe后降级从头,显示具体resumeReason并保留旧历史」、
 *   「0<p<本次duration」「PROGRESS_NOT_READY不以别的Profile历史duration兜底」;
 *   §5(data-model):「尾部未完成位置 0<p<duration 仍可尝试续播;本次 probe 未知则
 *   不能用历史 duration 作为在线兜底」;§6:「probe后一次计算frozen_start_seconds」。
 * - docs/specs/010-online-vod/spec.md:FR-016(连续性匹配,本次可信时长检查后才能确认
 *   起点)/FR-017(候选+最终资格分离,失败原因枚举)/FR-019(自然完成/接近结尾/未完成
 *   可区分;nearEnd 只是提示,不能仅因位于最后 30 秒强制从头)/FR-020(容差
 *   max(30s,原可信时长×2%),超过不自动继承,禁止按百分比强行映射)/FR-021(起点恰有
 *   一个服务端依据,检查完成后一次冻结,另一设备后来更新不能改已冻结起点,不能再被
 *   第二次历史读取覆盖)。
 * - contracts/api.md:HistorySummary.resumeReason = null|unavailable|content_changed|
 *   continuity_changed|completed|invalid_position|duration_unknown;
 *   PlaybackDto.startBasis = beginning|target_history|transition_carry、
 *   resumeDisposition = pending|resume|beginning、resumeReason 另含 accepted/
 *   requested_beginning/no_history/duration_changed/match_conflict。
 * - 行为仲裁面:apps/server/test/unit/online-vod/continuity-resume.spec.ts(010 T037,
 *   29 用例/10 describe;文件头钉死裁决顺序/冻结语义,T039 以使其全绿为完成定义)。
 *
 * ⚠️ 钉面偏差说明(以测试为准,逐条可追溯;测试行与契约文档文字冲突处按「以测试为
 * 准」落实,未改任何测试):
 * 1. 位置有效性锚定「记录自报时长」而非本次 probe 时长:E3 钉 p=duration(90=保存
 *    时长)→ invalid_position、p=duration−1(89)→ 可续播;G2 钉缩水恰界 330 仍
 *    eligible——若按「¬(0<p<本次时长)」会把 (p=350,保存=360,本次=330) 误判
 *    invalid_position,与 G2「±30s 恰界允许,差异双向对称」直接冲突。故第 6 步以
 *    history.durationSeconds 为界(候选函数同构:facts.durationSeconds 即该记录
 *    自报时长,两形态语义一致)。
 * 2. duration_changed 带「本次时长仍(含容差)承载该位置」前置门:G2 钉缩水 31s
 *    (329)→ duration_changed,而 H1 钉 (p=350,保存=360,本次=90,Δ=270) →
 *    accepted/350——FR-020 的无条件 |Δ|>tol 读法下 Δ=31 与 Δ=270 不可能一火一不火,
 *    两行联合钉死:漂移超容差「且」位置仍落在本次时长+容差之内才判 duration_changed;
 *    本次时长已缩水到位置容差域之外时,位置锚定保存时长原样继承(H1 预期)。该门为
 *    测试联合钉面(FR-020 无条件读法与 H1 冲突),已按「以测试为准」落实并在此报告。
 *
 * 导出面即 T037 测试 import 面(逐字):canAttemptResumeCandidate /
 * computeResumeEligibility / resolveStartPoint / ResumeCandidateFacts /
 * ResumeCandidateVerdict / ResumeCandidateReason / ResumeHistoryRecord /
 * ResumeCurrentFacts / ResumeEligibility / ResumeIneligibilityReason / StartBasis /
 * ResumeDispositionReason / FrozenStartPoint / ResolveStartPointInput。
 */

import { startDriftToleranceSeconds } from '../domain/continuity.rules';

/* ------------------------------------------------------------------ */
/* 值模型(与 T037 测试 import 面逐字对齐;全部 readonly 纯值)             */
/* ------------------------------------------------------------------ */

/** 起点依据全集(DTO 面 beginning|target_history|transition_carry;carry 属 US4 过渡服务) */
export type StartBasis = 'beginning' | 'target_history' | 'transition_carry';

/**
 * 候选原因(HistorySummary.resumeReason 枚举;probe 前形态):
 * 'unavailable' 仅接口层产出(无记录/静态映射场景),纯候选函数不产出;
 * 'no_history' 不在候选面(候选必有记录,mediaId 失配在候选层不可见);
 * 'duration_changed' 不在候选面(漂移在 probe 拿到本次时长后才可判)。
 */
export type ResumeCandidateReason =
  | 'unavailable'
  | 'content_changed'
  | 'continuity_changed'
  | 'completed'
  | 'invalid_position'
  | 'duration_unknown';

/** 候选裁决:canAttemptResume 仅「可尝试续播」候选,不是最终资格(FR-017 分离) */
export interface ResumeCandidateVerdict {
  readonly canAttemptResume: boolean;
  /** 可尝试 → null;不可尝试 → 具体原因 */
  readonly resumeReason: ResumeCandidateReason | null;
}

/** 候选事实(HistorySummary 形态输入):修订单位以「是否变化」布尔表达(比对结果投影) */
export interface ResumeCandidateFacts {
  readonly positionSeconds: number;
  readonly durationSeconds: number | null;
  readonly completed: boolean;
  /** 保存产生时 contentRevision ≠ 当前(调用方比对后的布尔投影) */
  readonly contentRevisionChanged: boolean;
  /** 保存产生时 continuityRevision ≠ 当前 */
  readonly continuityRevisionChanged: boolean;
}

/**
 * 续播历史记录(历史保存产生时的修订/证据快照):只读消费,本服务绝不回写/批量升级
 * (data-model §3「不能批量跟随当前状态升级」);completed 只由有效 finish 写。
 */
export interface ResumeHistoryRecord {
  readonly mediaId: string;
  readonly positionSeconds: number;
  /** 保存产生时的可信时长;未知 → null(不以别的 Profile/历史兜底) */
  readonly durationSeconds: number | null;
  readonly completed: boolean;
  /** 保存产生时的内容修订快照 */
  readonly contentRevision: number;
  /** 保存产生时的连续性修订快照 */
  readonly continuityRevision: number;
}

/**
 * 本次 probe 可信事实。类型面即钉面:无任何 URL/locator/采集时间字段(token 信息结构
 * 上进不了资格裁决,A 组),无他 Profile 历史入口(FR-018 只读同目标历史,I 组)。
 */
export interface ResumeCurrentFacts {
  readonly mediaId: string;
  /** 本次 probe 的当前内容修订 */
  readonly contentRevision: number;
  /** 本次 probe 的当前连续性修订 */
  readonly continuityRevision: number;
  /** 本次 probe 可信时长;未知 → null(绝不以历史 duration 兜底冒充本次事实) */
  readonly currentDurationSeconds: number | null;
}

/** 最终资格拒绝原因枚举(裁决顺序与优先级见 computeResumeEligibility,首条命中即返回) */
export type ResumeIneligibilityReason =
  | 'no_history'
  | 'content_changed'
  | 'continuity_changed'
  | 'completed'
  | 'duration_unknown'
  | 'invalid_position'
  | 'duration_changed';

/** 最终资格:可续播 → {eligible:true, startSeconds};否则 {eligible:false, reason} */
export type ResumeEligibility =
  | { readonly eligible: true; readonly startSeconds: number }
  | { readonly eligible: false; readonly reason: ResumeIneligibilityReason };

/**
 * 起点 disposition 的 resumeReason 全集(api.md PlaybackDto.resumeReason 子集;
 * 'pending'/'match_conflict'/'unavailable' 不由本服务产出):
 * accepted=按历史续播;requested_beginning=用户显式从头;其余=拒绝续播降级从头的具体原因。
 */
export type ResumeDispositionReason =
  | 'accepted'
  | 'requested_beginning'
  | 'no_history'
  | 'content_changed'
  | 'continuity_changed'
  | 'duration_changed'
  | 'completed'
  | 'invalid_position'
  | 'duration_unknown';

/** 已冻结起点(FR-021):startBasis 恒 ≠ 'transition_carry'(carry 由过渡服务冻结) */
export interface FrozenStartPoint {
  readonly startBasis: Exclude<StartBasis, 'transition_carry'>;
  /** resume=按历史位置续播;beginning=从头 */
  readonly disposition: 'resume' | 'beginning';
  /** 冻结时的处置原因;恒 ≠ 'pending'(preparing 未冻结属 DTO 层默认值) */
  readonly resumeReason: ResumeDispositionReason | null;
  readonly startSeconds: number;
}

/** 起点解析输入:requestedMode(beginning/resume)+ 历史 + 本次 probe 事实 + 已冻结起点 */
export interface ResolveStartPointInput {
  readonly requestedMode: 'beginning' | 'resume';
  readonly history: ResumeHistoryRecord | null;
  readonly current: ResumeCurrentFacts;
  /** 已冻结起点;非 null → 原样返回,不再读取历史(FR-021 冻结一次) */
  readonly frozen: FrozenStartPoint | null;
}

/* ------------------------------------------------------------------ */
/* 候选裁决(probe 前;HistorySummary 候选形态)                           */
/* ------------------------------------------------------------------ */

/**
 * canAttemptResumeCandidate:历史条目是否「可尝试续播」的候选判定(probe 前形态)。
 * 与最终资格同构但更粗:修订失配 → content_changed/continuity_changed;completed →
 * completed;durationSeconds == null → duration_unknown;¬(0<p<duration) →
 * invalid_position;否则 {true, null}。与裁决顺序的差异:无漂移检查(漂移需 probe 后
 * 的本次可信时长)、无 no_history(候选必有记录)。nearEnd 只是 UI 提示,本函数不产生
 * 任何原因(FR-019:不能仅因位于最后 30 秒强制从头);'unavailable' 不由本函数产出。
 */
export function canAttemptResumeCandidate(facts: ResumeCandidateFacts): ResumeCandidateVerdict {
  if (facts.contentRevisionChanged) {
    return { canAttemptResume: false, resumeReason: 'content_changed' };
  }
  if (facts.continuityRevisionChanged) {
    return { canAttemptResume: false, resumeReason: 'continuity_changed' };
  }
  if (facts.completed) {
    return { canAttemptResume: false, resumeReason: 'completed' };
  }
  if (facts.durationSeconds === null) {
    return { canAttemptResume: false, resumeReason: 'duration_unknown' };
  }
  if (!(0 < facts.positionSeconds && facts.positionSeconds < facts.durationSeconds)) {
    return { canAttemptResume: false, resumeReason: 'invalid_position' };
  }
  return { canAttemptResume: true, resumeReason: null };
}

/* ------------------------------------------------------------------ */
/* 最终资格裁决(probe 后;裁决顺序逐字钉死,首条命中即返回)               */
/* ------------------------------------------------------------------ */

/**
 * computeResumeEligibility:最终续播资格(裁决顺序钉死,首条命中即返回;修订单位=
 * 历史产生时快照 vs 本次 probe 当前事实):
 * 1. history 为 null 或 history.mediaId ≠ current.mediaId → 'no_history'
 *    (FR-018 只读同目标历史,不跨集/跨媒体继承);
 * 2. contentRevision 不等 → 'content_changed'(§3 旧会话修订不匹配,拒绝并需新 resolve);
 * 3. continuityRevision 不等 → 'continuity_changed'(内容失配优先于连续性失配——
 *    已知内容替换是更强失配,api resumeReason 枚举序同序);
 * 4. history.completed → 'completed'(completed 只由有效 finish 写,规则层只读消费);
 * 5. history.durationSeconds == null 或 current.currentDurationSeconds == null →
 *    'duration_unknown'(任一侧缺可信时长都无法建立 FR-016「时长兼容」;绝不以另一侧
 *    时长补齐,不以历史 duration 冒充本次事实——playback-state §3「PROGRESS_NOT_READY
 *    不以别的 Profile 历史 duration 兜底」);
 * 6. ¬(0 < history.positionSeconds < history.durationSeconds) → 'invalid_position'
 *    (位置有效性锚定「记录自报时长」=位置保存时所对应的可信时长;E3 钉 p=保存时长 →
 *    invalid、p=保存时长−1 → 可续播,G2 钉缩水恰界 330 仍 eligible;候选函数同构:
 *    facts.durationSeconds 即该记录自报时长。p≤0 无可续落点,p≥保存时长越界;
 *    nearEnd 只是提示,p<保存时长的最后 1 秒仍可续播,FR-019);
 * 7. |本次 − 保存时长| > startDriftToleranceSeconds(保存时长)「且」位置仍落在
 *    本次时长+容差之内 → 'duration_changed'(FR-020 容差 max(30s,旧可信时长×2%),
 *    G2/G3/F2 钉 ±恰界允许/超界降级、差异双向对称;前置门为 H 组钉面——本次时长
 *    缩水到位置容差域之外(H1:p=350/保存=360/本次=90)不判 duration_changed,位置
 *    锚定保存时长原样继承,见文件头「钉面偏差说明」第 2 条);
 * 8. 否则 eligible,startSeconds = history.positionSeconds(不重映射、不百分比换算)。
 */
export function computeResumeEligibility(input: {
  history: ResumeHistoryRecord | null;
  current: ResumeCurrentFacts;
}): ResumeEligibility {
  const { history, current } = input;
  if (history === null || history.mediaId !== current.mediaId) {
    return { eligible: false, reason: 'no_history' };
  }
  if (history.contentRevision !== current.contentRevision) {
    return { eligible: false, reason: 'content_changed' };
  }
  if (history.continuityRevision !== current.continuityRevision) {
    return { eligible: false, reason: 'continuity_changed' };
  }
  if (history.completed) {
    return { eligible: false, reason: 'completed' };
  }
  if (history.durationSeconds === null || current.currentDurationSeconds === null) {
    return { eligible: false, reason: 'duration_unknown' };
  }
  const positionSeconds = history.positionSeconds;
  const historyDurationSeconds = history.durationSeconds;
  const currentDurationSeconds = current.currentDurationSeconds;
  const toleranceSeconds = startDriftToleranceSeconds(historyDurationSeconds);
  if (!(0 < positionSeconds && positionSeconds < historyDurationSeconds)) {
    return { eligible: false, reason: 'invalid_position' };
  }
  const driftSeconds = Math.abs(currentDurationSeconds - historyDurationSeconds);
  const positionStillSpannedByCurrent = positionSeconds < currentDurationSeconds + toleranceSeconds;
  if (driftSeconds > toleranceSeconds && positionStillSpannedByCurrent) {
    return { eligible: false, reason: 'duration_changed' };
  }
  return { eligible: true, startSeconds: positionSeconds };
}

/* ------------------------------------------------------------------ */
/* 起点解析(FR-021 冻结一次)                                           */
/* ------------------------------------------------------------------ */

/**
 * resolveStartPoint:起点恰有一个服务端依据,probe 后一次计算并冻结(FR-021):
 * - frozen ≠ null → 原样返回 frozen(逐字段相等):他设备后来更新历史、偏好变化、
 *   本次 duration 微漂移都不改变已冻结起点,「不能再被第二次历史读取覆盖」;
 *   重验失败(修订在冻结后变化 → 准备转 failed)属 resolver CAS 面,不在本函数。
 * - frozen == null → 本次 probe 后一次计算并冻结:
 *   requestedMode='beginning' → {beginning, beginning, 'requested_beginning', 0};
 *   requestedMode='resume' → 资格裁决(computeResumeEligibility)eligible →
 *   {target_history, resume, 'accepted', position};否则 → {beginning, beginning,
 *   <拒绝原因>, 0}(duration_changed 等超界降级从头,startSeconds=0,不百分比换算)。
 *   disposition 恒 ≠ 'pending'(preparing 未冻结是 DTO 层默认值,非本服务产出);
 *   startBasis 恒 ≠ 'transition_carry'(过渡服务冻结 source checkpoint,US4 接线)。
 */
export function resolveStartPoint(input: ResolveStartPointInput): FrozenStartPoint {
  if (input.frozen !== null) {
    return input.frozen;
  }
  if (input.requestedMode === 'beginning') {
    return {
      startBasis: 'beginning',
      disposition: 'beginning',
      resumeReason: 'requested_beginning',
      startSeconds: 0,
    };
  }
  const eligibility = computeResumeEligibility({ history: input.history, current: input.current });
  if (eligibility.eligible) {
    return {
      startBasis: 'target_history',
      disposition: 'resume',
      resumeReason: 'accepted',
      startSeconds: eligibility.startSeconds,
    };
  }
  return {
    startBasis: 'beginning',
    disposition: 'beginning',
    resumeReason: eligibility.reason,
    startSeconds: 0,
  };
}
