import { describe, expect, it } from 'vitest';
import {
  ContinuityPublicationError,
  START_DRIFT_ABSOLUTE_TOLERANCE_SECONDS,
  START_DRIFT_RELATIVE_TOLERANCE,
  evaluateContinuityTransition,
  startDriftToleranceSeconds,
  type ContinuityEpisodeSnapshot,
  type ContinuityPublicationErrorCode,
  type ContinuitySignature,
} from '@contexts/online-vod/domain/continuity.rules';
import {
  canAttemptResumeCandidate,
  computeResumeEligibility,
  resolveStartPoint,
  type FrozenStartPoint,
  type ResolveStartPointInput,
  type ResumeCandidateFacts,
  type ResumeCurrentFacts,
  type ResumeEligibility,
  type ResumeHistoryRecord,
  type ResumeIneligibilityReason,
} from '@contexts/online-vod/application/continuity.service';
import {
  createStandardEpisodePresentation,
  createStandaloneMovieWorld,
  createThreeEpisodeSerialWorld,
  createVersionConflictWorld,
  FIXTURE_UPSTREAM_FIXED_NOW_MS,
  type FixtureHlsPresentation,
  type FixtureTitleWorld,
} from '../../fixtures/online-vod/fixture-upstream';

/**
 * 010 T037(测试先行)—— 内容/连续性转换与续播起点规则契约钉面(计划内红,待 T039 转绿)。
 *
 * ⚠️ 计划内红(文件顶部声明):被测模块由 T039 创建,当前不存在——
 *   - `@contexts/online-vod/domain/continuity.rules`(修订转换/容差常量,纯领域,零依赖);
 *   - `@contexts/online-vod/application/continuity.service`(续播资格/起点冻结,应用层纯规则)。
 * 当前阶段预期(对齐 provider-parser.spec.ts 的 T023 先例 / vod-parent-child-policy.spec.ts 的 T009 先例):
 *   1. `pnpm --filter @hmp/server exec vitest run test/unit/online-vod/continuity-resume.spec.ts`
 *      收集期失败(模块不存在);
 *   2. `pnpm --filter @hmp/server typecheck` 恰好新增两条 TS2307(上述两模块),零其他错误;
 *   3. eslint 零错误。
 * 本文件即 T039 行为契约:实现须使本文件全绿,且只允许通过上述两模块导出面满足;
 * 不得引入网络/时钟/随机(纯函数),不得反向依赖 playback/personal-data(T041 在自己的
 * 模块接线,通过调用本文件钉死的规则函数满足 FR-021)。
 *
 * 被测范围(tasks.md T037 原文):「内容/连续性转换、token 不重置、追加别集不影响旧集、
 * 尾部未完成允许续播、短片、差异 max(30s,旧 duration×2%) 及冻结后他设备更新不改变起点」。
 *
 * 契约权威(实现侧不自创语义):
 * - data-model.md §3:contentRevision=已知内容替换/可信证据更换;continuityRevision=
 *   稳定定位/已知年季版本匹配条件变化;continuitySignature 含规范身份/已知年份季度语言版本/
 *   匹配规则版本,不含 URL/采集时间,不是媒体 hash;「URL token/采集时间变化不加」;
 *   「verified 证据更换/降级/从 unverified 升级均 contentRevision+1;unverified 结构相同仅
 *   地址更新不变;关键结构变更 continuityRevision+1,明确内容替换两者可同次变更,各最多+1;
 *   失败/截断不发布」;「新增其他集不使已有子 revision 改变」;「缺关键字段不自动制造
 *   『内容一致』的证据」;「旧会话修订不匹配时拒绝新交付/进度」。
 * - data-model.md §5:「短片/尾部未完成位置 0<p<duration 仍可尝试续播;本次 probe 未知则
 *   不能用历史 duration 作为在线兜底」;§6:「起点冻结一次」「ready 提交只重验不再读取
 *   不同历史覆盖」。
 * - playback-state.md §3:canAttemptResume 仅候选,probe 后可降级从头并显示 resumeReason;
 *   「0<p<本次duration」;PROGRESS_NOT_READY 不以别的 Profile 历史 duration 兜底;§8:
 *   「未知 duration 时允许起播确认,但进度/续播/carry/完成均不能据此放行」。
 * - spec.md FR-016(连续性匹配,本次可信时长检查后才能确认起点)/FR-017(候选+最终资格
 *   分离,失败原因枚举)/FR-019(自然完成/接近结尾/未完成可区分;nearEnd 只是提示,不能仅因
 *   位于最后 30 秒强制从头)/FR-020(时长差异容差 max(30s,原可信时长×2%),超过不自动继承,
 *   禁止按百分比强行映射)/FR-021(起点恰有一个服务端依据,检查完成后一次冻结,另一设备
 *   后来更新不能改已冻结起点,不能再被第二次历史读取覆盖)。
 * - contracts/api.md:HistorySummary.resumeReason =
 *   null|unavailable|content_changed|continuity_changed|completed|invalid_position|duration_unknown;
 *   PlaybackDto.startBasis = beginning|target_history|transition_carry、resumeDisposition =
 *   pending|resume|beginning、resumeReason 另含 accepted/requested_beginning/no_history/
 *   duration_changed/match_conflict。本钉面不产出 pending(preparing 未冻结属 DTO 层默认值)、
 *   不产出 match_conflict(US4 源匹配 T068/T072 面)、不产出 transition_carry
 *   (过渡服务冻结 source checkpoint,US4 接线,不经本服务)。
 *
 * 建议导出面(T039 实现者照钉;本文件 import 面即契约,函数语义见各组钉面):
 * domain/continuity.rules(纯领域,零 import,对齐 provider-model/vod-budgets 惯例,
 * 失败语义为纯 Error 子类,interface 层负责翻译 HTTP 语义):
 *   - const START_DRIFT_ABSOLUTE_TOLERANCE_SECONDS = 30      // FR-020 max(30s,·) 绝对下限(秒)
 *   - const START_DRIFT_RELATIVE_TOLERANCE = 0.02            // FR-020 旧可信时长×2%
 *   - function startDriftToleranceSeconds(previousTrustedDurationSeconds: number): number
 *       // = max(START_DRIFT_ABSOLUTE_TOLERANCE_SECONDS, previous×START_DRIFT_RELATIVE_TOLERANCE);
 *       // 位置/时长以秒为单位的有限正数(存储层保证 duration>0,非正输入不属本契约面)
 *   - function evaluateContinuityTransition(previous: ContinuityEpisodeSnapshot,
 *       next: ContinuityEpisodeSnapshot): ContinuityTransitionOutcome
 *   - class ContinuityPublicationError extends Error { readonly code: ContinuityPublicationErrorCode }
 *   - type ContinuityPublicationErrorCode = 'incomplete_evidence' | 'signature_incomplete'
 *   - type ContinuityEvidenceState = 'unverified' | 'verified'
 *   - interface ContinuitySignature { canonicalName: string; year: string|null; seasonKey: string|null;
 *       languageVersion: string|null; knownVersionLabel: string|null; matchRuleVersion: string }
 *   - interface ContinuityEpisodeSnapshot { episodeKey: string; contentRevision: number;
 *       continuityRevision: number; signature: ContinuitySignature;
 *       evidenceState: ContinuityEvidenceState; evidenceDigest: string|null;
 *       evidenceSchemaVersion: string|null; siblingEpisodeKeys: readonly string[];
 *       locatorUrl: string; collectedAtMs: number }
 *   - interface ContinuityTransitionOutcome { contentBumped: boolean; continuityBumped: boolean }
 * application/continuity.service(应用层纯规则;续播判定/起点语义,playback-state §3):
 *   - function canAttemptResumeCandidate(facts: ResumeCandidateFacts): ResumeCandidateVerdict
 *   - function computeResumeEligibility(input: { history: ResumeHistoryRecord|null;
 *       current: ResumeCurrentFacts }): ResumeEligibility
 *   - function resolveStartPoint(input: ResolveStartPointInput): FrozenStartPoint
 *   - interface ResumeCandidateFacts { positionSeconds: number; durationSeconds: number|null;
 *       completed: boolean; contentRevisionChanged: boolean; continuityRevisionChanged: boolean }
 *   - interface ResumeCandidateVerdict { canAttemptResume: boolean;
 *       resumeReason: ResumeCandidateReason|null }
 *   - type ResumeCandidateReason = 'unavailable'|'content_changed'|'continuity_changed'|'completed'|
 *       'invalid_position'|'duration_unknown'   // HistorySummary 枚举;unavailable 仅接口层
 *       产出(无记录/静态映射场景),纯候选函数不产出
 *   - interface ResumeHistoryRecord { mediaId: string; positionSeconds: number;
 *       durationSeconds: number|null; completed: boolean; contentRevision: number;
 *       continuityRevision: number }   // 历史保存产生时的修订/证据快照,不批量跟随当前状态升级
 *   - interface ResumeCurrentFacts { mediaId: string; contentRevision: number;
 *       continuityRevision: number; currentDurationSeconds: number|null }  // 本次 probe 可信事实;
 *       // 类型面即钉面:无任何 URL/locator/采集时间字段(A 组),无他 Profile 历史入口(I 组)
 *   - type ResumeEligibility = { eligible: true; startSeconds: number } |
 *       { eligible: false; reason: ResumeIneligibilityReason }
 *   - type ResumeIneligibilityReason = 'no_history'|'content_changed'|'continuity_changed'|'completed'|
 *       'duration_unknown'|'invalid_position'|'duration_changed'   // 裁决枚举与顺序见 E/G/I 组
 *   - type StartBasis = 'beginning'|'target_history'|'transition_carry'   // DTO 全集;
 *       FrozenStartPoint.startBasis 恒 ≠ 'transition_carry'
 *   - type ResumeDispositionReason = 'accepted'|'requested_beginning'|'no_history'|'content_changed'|
 *       'continuity_changed'|'duration_changed'|'completed'|'invalid_position'|'duration_unknown'
 *   - interface FrozenStartPoint { startBasis: Exclude<StartBasis,'transition_carry'>;
 *       disposition: 'resume'|'beginning'; resumeReason: ResumeDispositionReason|null;
 *       startSeconds: number }
 *   - interface ResolveStartPointInput { requestedMode: 'beginning'|'resume';
 *       history: ResumeHistoryRecord|null; current: ResumeCurrentFacts;
 *       frozen: FrozenStartPoint|null }
 *
 * evaluateContinuityTransition 语义钉面(变化信号→修订推进;「其余字段不变」前提):
 *   | 变化信号(previous→next)                                | contentBumped | continuityBumped | 依据(data-model §3)          |
 *   | locatorUrl(sign token)/collectedAtMs 仅变化             |      ✗        |        ✗         | token/采集时间变化不加        |
 *   | evidenceState verified→unverified(降级)                |      ✓        |        ✗         | 降级 → content+1             |
 *   | evidenceState unverified→verified(升级,证据完整)       |      ✓        |        ✗         | 从 unverified 升级 → content+1 |
 *   | 双 verified 且 evidenceDigest 变化(可信证据更换)        |      ✓        |        ✗         | verified 证据更换 → content+1 |
 *   | 双 unverified 且 evidenceDigest 变化                    |      ✗        |        ✗         | 「unverified 结构相同仅地址   |
 *   |                                                        |               |                  |  更新不变」——unverified 证据  |
 *   |                                                        |               |                  |  不构成可信更换信号           |
 *   | signature.knownVersionLabel 变化(剧场版→导演剪辑版)     |      ✓        |        ✓         | 明确内容替换:内容替换+匹配   |
 *   | signature.canonicalName 变化(规范身份换内容)            |      ✓        |        ✓         | 条件变化可同次变更,各最多+1  |
 *   | signature.year/seasonKey/languageVersion/matchRuleVersion |      ✗        |        ✓         | 已知年季版本匹配条件变化      |
 *   | 子项自身 episodeKey 从 next.siblingEpisodeKeys 消失      |      ✗        |        ✓         | 关键结构变更 → continuity+1   |
 *   | siblingEpisodeKeys 追加/移除「其他集」(自身键仍在)      |      ✗        |        ✗         | 新增其他集不使已有子 revision 改变 |
 *   「各最多 +1」钉法:outcome 为布尔对,单次事件结构上至多各一次;applyOnce 重放
 *   (推进后的快照对同一 next 再评估)必须 {false,false}——同一变化不产生第二次推进。
 *   拒绝发布(先于一切比较,next 为发布候选):next 声明 verified 但 evidenceDigest/
 *   evidenceSchemaVersion 缺失 → ContinuityPublicationError('incomplete_evidence')
 *   (§2「verified 需完整证据」+ §3「失败不发布」,抛错即不产出 outcome、不更新 revision);
 *   next.signature.canonicalName/matchRuleVersion 归一后为空 → ('signature_incomplete')
 *   (§3「缺关键字段不自动制造『内容一致』的证据」)。previous 为已持久可信状态,不重验。
 *
 * computeResumeEligibility 裁决顺序(逐字钉死,首条命中即返回;修订单位:历史产生时快照 vs
 * 本次 probe 当前事实):
 *   1. history 为 null 或 history.mediaId ≠ current.mediaId → 'no_history'(FR-018 只读同目标历史);
 *   2. contentRevision 不等 → 'content_changed'(§3 旧会话修订不匹配,拒绝并需新 resolve);
 *   3. continuityRevision 不等 → 'continuity_changed'(同上;内容失配优先于连续性失配——
 *      已知内容替换是更强失配,api resumeReason 枚举序同序);
 *   4. history.completed → 'completed'(completed 只由有效 finish 写,规则层只读消费);
 *   5. history.durationSeconds == null 或 current.currentDurationSeconds == null → 'duration_unknown'
 *      (FR-020「没有可信时长不能以旧历史冒充本次事实」+ §5 本次 probe 未知不用历史兜底:
 *      任一侧缺可信时长都无法建立 FR-016 的「时长兼容」;绝不以另一侧时长补齐);
 *   6. ¬(0 < positionSeconds < currentDurationSeconds) → 'invalid_position'(playback-state §3
 *      「0<p<本次duration」;p≤0 无可续落点,p≥本次时长越界);
 *   7. |current − history.duration| > startDriftToleranceSeconds(history.duration) → 'duration_changed'
 *      (FR-020 容差 max(30s,旧可信时长×2%),超界不自动继承位置,禁止按百分比强行映射);
 *   8. 否则 eligible,startSeconds = history.positionSeconds(不重映射、不百分比换算)。
 *   在线专用钉面:静态媒体原续播行为不变(T041,静态规则不经本服务);本服务无偏好入口
 *   (switch_carry_position 等只影响过渡,FR-021 起点依据仅 beginning/target_history/carry)。
 *
 * resolveStartPoint 语义钉面(FR-021 冻结一次):
 *   - frozen ≠ null → 原样返回 frozen(逐字段相等):他设备后来更新历史、偏好变化、本次
 *     duration 微漂移都不改变已冻结起点,「不能再被第二次历史读取覆盖」;重验失败
 *     (修订在冻结后变化 → 准备转 failed)属 resolver CAS 面,不在本函数。
 *   - frozen == null → 本次 probe 后一次计算并冻结:requestedMode=beginning →
 *     {beginning, beginning, 'requested_beginning', 0};requestedMode=resume →
 *     eligible → {target_history, resume, 'accepted', position},否则 →
 *     {beginning, beginning, <拒绝原因>, 0}。disposition 恒 ≠ 'pending'(preparing 未冻结
 *     是 DTO 层默认值,非本服务产出)。
 *
 * canAttemptResumeCandidate 语义钉面(HistorySummary 候选形态,probe 前;canAttemptResume
 * 不是最终资格):revision 失配 → content_changed/continuity_changed;completed → completed;
 * durationSeconds == null → duration_unknown;¬(0 < p < duration) → invalid_position(与裁决
 * 顺序同构,仅少漂移检查——漂移在 probe 后才可判);否则 {true, null}。nearEnd 只是 UI 提示,
 * 不在本函数产生任何原因。
 *
 * 用例↔契约映射:基线=夹具输入素材锁面;A token/采集时间(data-model §3 + provider-parser
 * G 组的规则层锚点);B 内容/连续性转换(§3 修订触发表);C 追加别集(§3「新增其他集…」+
 * FR-018 同目标历史);D 证据升降级与拒绝发布(§3 + §2「verified 需完整证据」);E 尾部未
 * 完成/canAttemptResume(FR-017/019 + §5「0<p<duration」);F 短片(FR-020 绝对下限不误杀);
 * G 差异容差边界(FR-020 max(30s,2%),恰界允许/超界降级);H 冻结一次(FR-021 + §6);
 * I 时长未知(§5 + playback-state §3「PROGRESS_NOT_READY 不以别的 Profile 历史 duration 兜底」)。
 */

/* ------------------------------------------------------------------ */
/* 夹具世界与输入素材(纯构造,零网络)                                    */
/* ------------------------------------------------------------------ */

const VOD_ORIGIN = 'http://127.0.0.1:18081';

/** 世界一:三集连续剧(EP1=3×120=360s,EP2=2×45=90s,EP3=1×30=30s 短片) */
const serialWorld = createThreeEpisodeSerialWorld(VOD_ORIGIN);
/** 世界三两端:同名版本冲突(2019 剧场版 180s / 2023 导演剪辑版 240s) */
const theatricalWorld = createVersionConflictWorld(VOD_ORIGIN, 'theatrical');
const directorsCutWorld = createVersionConflictWorld(VOD_ORIGIN, 'directors-cut');
/** 必超时源独占影片:清单无 #EXT-X-ENDLIST(totalDurationSeconds=null,duration 未知形态) */
const standaloneMovieWorld = createStandaloneMovieWorld(VOD_ORIGIN);
/** 2% 主导边界的长片素材:15×120=1800s(2%=36s > 30s 下限) */
const longPresentation = createStandardEpisodePresentation({
  presentationKey: 'continuity-resume:long-1800s',
  episodeKey: 'long',
  origin: VOD_ORIGIN,
  rootPath: '/vod/hls/continuity/long',
  segmentCount: 15,
  segmentDurationSeconds: 120,
});

/** 取世界内呈现(带类型收窄;noUncheckedIndexedAccess 下缺呈现即测试失败) */
function requirePresentation(world: FixtureTitleWorld, index: number): FixtureHlsPresentation {
  const presentation = world.presentations[index];
  if (presentation === undefined) {
    throw new Error(`夹具世界 ${world.titleKey} 缺呈现 index=${index}`);
  }
  return presentation;
}

/* ------------------------------------------------------------------ */
/* 连续性快照构造(世界一 EP2 为默认子项)                                */
/* ------------------------------------------------------------------ */

/** 默认签名:世界一 EP2 的已知年季语言版本(knownVersionLabel 缺省 null,基础剧集无版本) */
const BASE_SIGNATURE: ContinuitySignature = {
  canonicalName: 'fixture·星尘信使',
  year: '2024',
  seasonKey: 'S01',
  languageVersion: '夹具语言',
  knownVersionLabel: null,
  matchRuleVersion: 'fixture-continuity-match-v1',
};

/** 默认子项快照:世界一 EP2,verified 证据,修订 1/1,主线三集 ['01','02','03'] */
const BASE_SNAPSHOT: ContinuityEpisodeSnapshot = {
  episodeKey: '02',
  contentRevision: 1,
  continuityRevision: 1,
  signature: BASE_SIGNATURE,
  evidenceState: 'verified',
  evidenceDigest: 'fixture-ep02-verified-digest',
  evidenceSchemaVersion: 'fixture-evidence-v1',
  siblingEpisodeKeys: ['01', '02', '03'],
  locatorUrl: requirePresentation(serialWorld, 1).masterUri,
  collectedAtMs: FIXTURE_UPSTREAM_FIXED_NOW_MS,
};

/** 以基准快照派生 next(其余字段不变) */
function withSnapshot(base: ContinuityEpisodeSnapshot, overrides: Partial<ContinuityEpisodeSnapshot>): ContinuityEpisodeSnapshot {
  return { ...base, ...overrides };
}

/** 应用一次 outcome(推进修订)得到的「已发布」快照;applyOnce 重放评估用 */
function applyOnce(previous: ContinuityEpisodeSnapshot, next: ContinuityEpisodeSnapshot): ContinuityEpisodeSnapshot {
  const outcome = evaluateContinuityTransition(previous, next);
  return withSnapshot(next, {
    contentRevision: next.contentRevision + (outcome.contentBumped ? 1 : 0),
    continuityRevision: next.continuityRevision + (outcome.continuityBumped ? 1 : 0),
  });
}

/** 断言评估抛出指定 code 的 ContinuityPublicationError(拒绝发布语义载体;抛错即不更新) */
function expectContinuityReject(code: ContinuityPublicationErrorCode, run: () => unknown): void {
  let caught: unknown;
  try {
    run();
  } catch (error) {
    caught = error;
  }
  expect(caught, `预期抛 ContinuityPublicationError(${code}),实际:${String(caught)}`).toBeInstanceOf(
    ContinuityPublicationError,
  );
  expect((caught as ContinuityPublicationError).code).toBe(code);
}

/* ------------------------------------------------------------------ */
/* 续播历史/当前事实/候选构造(世界一 EP2,位置/时长单位=秒)              */
/* ------------------------------------------------------------------ */

const EP02_MEDIA_ID = 'fixture-media-serial-ep02';

/** 默认历史:EP2 看到第 40 秒/共 90 秒,未完成,修订 1/1(与 BASE_SNAPSHOT 同代) */
function historyRecord(overrides: Partial<ResumeHistoryRecord> = {}): ResumeHistoryRecord {
  return {
    mediaId: EP02_MEDIA_ID,
    positionSeconds: 40,
    durationSeconds: 90,
    completed: false,
    contentRevision: 1,
    continuityRevision: 1,
    ...overrides,
  };
}

/** 默认本次 probe 事实:修订 1/1,本次可信时长 90 秒 */
function currentFacts(overrides: Partial<ResumeCurrentFacts> = {}): ResumeCurrentFacts {
  return {
    mediaId: EP02_MEDIA_ID,
    contentRevision: 1,
    continuityRevision: 1,
    currentDurationSeconds: 90,
    ...overrides,
  };
}

/** 默认候选事实(HistorySummary 形态输入):修订比对结果以「是否变化」布尔表达 */
function candidateFacts(overrides: Partial<ResumeCandidateFacts> = {}): ResumeCandidateFacts {
  return {
    positionSeconds: 40,
    durationSeconds: 90,
    completed: false,
    contentRevisionChanged: false,
    continuityRevisionChanged: false,
    ...overrides,
  };
}

/** 默认起点解析输入:resume 请求 + 无已冻结起点 */
function resolveInput(overrides: Partial<ResolveStartPointInput> = {}): ResolveStartPointInput {
  return { requestedMode: 'resume', history: historyRecord(), current: currentFacts(), frozen: null, ...overrides };
}

/** 资格裁决收窄:预期可续播(缺 eligible 即测试失败) */
function requireEligible(eligibility: ResumeEligibility): { eligible: true; startSeconds: number } {
  if (eligibility.eligible !== true) {
    throw new Error(`预期可续播,实际:${JSON.stringify(eligibility)}`);
  }
  return eligibility;
}

/** 资格裁决收窄:预期拒绝并取原因 */
function requireIneligible(eligibility: ResumeEligibility): { eligible: false; reason: ResumeIneligibilityReason } {
  if (eligibility.eligible !== false) {
    throw new Error(`预期拒绝续播,实际:${JSON.stringify(eligibility)}`);
  }
  return eligibility;
}

/* ------------------------------------------------------------------ */
/* 基线:夹具输入素材与恒等转换锁面                                      */
/* ------------------------------------------------------------------ */

describe('基线:夹具输入素材锁面与恒等转换', () => {
  it('时长素材锁面:EP1=360s/EP2=90s/EP3=30s(短片)、版本冲突 180s/240s、定制长片 1800s、独立影片清单无 ENDLIST(totalDurationSeconds=null)', () => {
    expect(requirePresentation(serialWorld, 0).totalDurationSeconds).toBe(360);
    expect(requirePresentation(serialWorld, 1).totalDurationSeconds).toBe(90);
    expect(requirePresentation(serialWorld, 2).totalDurationSeconds).toBe(30);
    expect(requirePresentation(theatricalWorld, 0).totalDurationSeconds).toBe(180);
    expect(requirePresentation(directorsCutWorld, 0).totalDurationSeconds).toBe(240);
    expect(longPresentation.totalDurationSeconds).toBe(1800);
    expect(requirePresentation(standaloneMovieWorld, 0).totalDurationSeconds).toBeNull();
    expect(theatricalWorld.seed.versionLabel).toBe('剧场版');
    expect(directorsCutWorld.seed.versionLabel).toBe('导演剪辑版');
  });

  it('恒等转换:相同快照(previous===next)→ {contentBumped:false, continuityBumped:false},无事件不推进', () => {
    expect(evaluateContinuityTransition(BASE_SNAPSHOT, BASE_SNAPSHOT)).toEqual({
      contentBumped: false,
      continuityBumped: false,
    });
  });
});

/* ------------------------------------------------------------------ */
/* A. 身份/token:URL sign token 与采集时间变化不重置任何 revision/资格   */
/* ------------------------------------------------------------------ */

describe('A. token 不重置:data-model §3「URL token/采集时间变化不加」(provider-parser G 组的规则层锚点)', () => {
  it('locator sign token 轮换 + 采集时间推进(其余不变)→ 不推进任何修订:{false,false}', () => {
    const next = withSnapshot(BASE_SNAPSHOT, {
      locatorUrl: `${BASE_SNAPSHOT.locatorUrl}?sign=rotated-token`,
      collectedAtMs: BASE_SNAPSHOT.collectedAtMs + 86_400_000,
    });
    expect(evaluateContinuityTransition(BASE_SNAPSHOT, next)).toEqual({
      contentBumped: false,
      continuityBumped: false,
    });
  });

  it('token/采集时间不参与续播资格:同修订下 token 轮换后的集仍可续播且起点为历史位置', () => {
    // 规则层锚点:ResumeCurrentFacts 类型面无任何 URL/采集时间字段——token 信息进不了资格裁决
    const eligible = requireEligible(computeResumeEligibility({ history: historyRecord(), current: currentFacts() }));
    expect(eligible.startSeconds).toBe(40);
    expect(resolveStartPoint(resolveInput())).toEqual({
      startBasis: 'target_history',
      disposition: 'resume',
      resumeReason: 'accepted',
      startSeconds: 40,
    });
  });
});

/* ------------------------------------------------------------------ */
/* B. 内容/连续性转换:data-model §3 修订触发钉面                         */
/* ------------------------------------------------------------------ */

describe('B. 内容/连续性转换:「contentRevision=已知内容替换/可信证据更换;continuityRevision=稳定定位/匹配条件变化」', () => {
  it('可信证据更换:双 verified 且 evidenceDigest 变化 → 仅 content+1;applyOnce 重放不再推进(各最多 +1)', () => {
    const next = withSnapshot(BASE_SNAPSHOT, { evidenceDigest: 'fixture-ep02-renewed-digest' });
    expect(evaluateContinuityTransition(BASE_SNAPSHOT, next)).toEqual({ contentBumped: true, continuityBumped: false });
    // 同一变化事件只产生一次推进:发布(content+1)后对同一 next 重评 → 无第二次 bump
    const published = applyOnce(BASE_SNAPSHOT, next);
    expect(published.contentRevision).toBe(2);
    expect(evaluateContinuityTransition(published, next)).toEqual({ contentBumped: false, continuityBumped: false });
  });

  it('已知内容替换(规范身份换内容):canonicalName 变化 → 两者同次各 +1(明确内容替换可同次变更)', () => {
    const next = withSnapshot(BASE_SNAPSHOT, {
      signature: { ...BASE_SIGNATURE, canonicalName: 'fixture·星尘信使·重制版' },
    });
    expect(evaluateContinuityTransition(BASE_SNAPSHOT, next)).toEqual({ contentBumped: true, continuityBumped: true });
  });

  it('明确内容替换(版本冲突世界素材:剧场版→导演剪辑版):knownVersionLabel 变化 → 两者同次各 +1;发布后重评各不再 +1', () => {
    const before = withSnapshot(BASE_SNAPSHOT, {
      episodeKey: 'movie',
      siblingEpisodeKeys: ['movie'],
      signature: {
        canonicalName: 'fixture·回声双城',
        year: '2019',
        seasonKey: null,
        languageVersion: '夹具语言',
        knownVersionLabel: '剧场版',
        matchRuleVersion: 'fixture-continuity-match-v1',
      },
      evidenceDigest: 'fixture-echo-2019-digest',
    });
    const next = withSnapshot(before, {
      signature: { ...before.signature, year: '2023', knownVersionLabel: '导演剪辑版' },
      evidenceDigest: 'fixture-echo-2023-digest',
    });
    expect(evaluateContinuityTransition(before, next)).toEqual({ contentBumped: true, continuityBumped: true });
    const published = applyOnce(before, next);
    expect(published.contentRevision).toBe(2);
    expect(published.continuityRevision).toBe(2);
    expect(evaluateContinuityTransition(published, next)).toEqual({ contentBumped: false, continuityBumped: false });
  });

  it('匹配条件变化:year/seasonKey/languageVersion/matchRuleVersion 任一变化 → 仅 continuity+1(已知年季版本匹配条件变化)', () => {
    const cases: readonly (Partial<ContinuitySignature>)[] = [
      { year: '2025' },
      { seasonKey: 'S02' },
      { languageVersion: '英语配音版' },
      { matchRuleVersion: 'fixture-continuity-match-v2' },
    ];
    for (const signatureOverrides of cases) {
      const next = withSnapshot(BASE_SNAPSHOT, { signature: { ...BASE_SIGNATURE, ...signatureOverrides } });
      expect(evaluateContinuityTransition(BASE_SNAPSHOT, next)).toEqual(
        { contentBumped: false, continuityBumped: true },
      );
    }
  });

  it('关键结构变更:子项自身 episodeKey 从 next.siblingEpisodeKeys 消失(集被改名/移除)→ 仅 continuity+1', () => {
    const next = withSnapshot(BASE_SNAPSHOT, { siblingEpisodeKeys: ['01', '03'] });
    expect(evaluateContinuityTransition(BASE_SNAPSHOT, next)).toEqual({ contentBumped: false, continuityBumped: true });
  });

  it('修订失配即拒绝旧历史续播:发布推进后的修订与历史产生时快照不等 → content_changed/continuity_changed', () => {
    // §3「历史保存产生时的内容/连续性修订…不能批量跟随当前状态升级。旧会话修订不匹配时拒绝」
    expect(
      requireIneligible(
        computeResumeEligibility({ history: historyRecord(), current: currentFacts({ contentRevision: 2 }) }),
      ).reason,
    ).toBe('content_changed');
    expect(
      requireIneligible(
        computeResumeEligibility({ history: historyRecord(), current: currentFacts({ continuityRevision: 2 }) }),
      ).reason,
    ).toBe('continuity_changed');
  });
});

/* ------------------------------------------------------------------ */
/* C. 追加别集:「新增其他集不使已有子 revision 改变」(旧集续播资格不变)   */
/* ------------------------------------------------------------------ */

describe('C. 追加别集:data-model §3「新增其他集不使已有子 revision 改变」', () => {
  it('主线追加第 04 集(01/02/03 → 01/02/03/04,EP2 自身不变)→ {false,false};EP2 历史续播资格原样保留', () => {
    const next = withSnapshot(BASE_SNAPSHOT, { siblingEpisodeKeys: ['01', '02', '03', '04'] });
    expect(evaluateContinuityTransition(BASE_SNAPSHOT, next)).toEqual({
      contentBumped: false,
      continuityBumped: false,
    });
    // 追加后旧集候选/最终资格不变:仍可尝试续播,起点仍为历史位置 40
    expect(canAttemptResumeCandidate(candidateFacts())).toEqual({ canAttemptResume: true, resumeReason: null });
    expect(requireEligible(computeResumeEligibility({ history: historyRecord(), current: currentFacts() })).startSeconds).toBe(40);
  });

  it('别集历史不适用于本集:mediaId 失配(EP3 历史 vs EP2 目标)→ no_history,不跨集继承(FR-018 只读同目标历史)', () => {
    const foreignHistory = historyRecord({ mediaId: 'fixture-media-serial-ep03', positionSeconds: 20, durationSeconds: 30 });
    expect(requireIneligible(computeResumeEligibility({ history: foreignHistory, current: currentFacts() })).reason).toBe(
      'no_history',
    );
    expect(
      resolveStartPoint(resolveInput({ history: foreignHistory })),
    ).toEqual({ startBasis: 'beginning', disposition: 'beginning', resumeReason: 'no_history', startSeconds: 0 });
  });
});

/* ------------------------------------------------------------------ */
/* D. 证据升降级与拒绝发布                                               */
/* ------------------------------------------------------------------ */

describe('D. 证据升降级:「verified 证据更换/降级/从 unverified 升级均 contentRevision+1」「失败/截断不发布」', () => {
  it('verified→unverified 降级(digest 归空,基础 adapter 形态)→ 仅 content+1;发布后重评不再 +1(各最多 +1)', () => {
    const next = withSnapshot(BASE_SNAPSHOT, { evidenceState: 'unverified', evidenceDigest: null, evidenceSchemaVersion: null });
    expect(evaluateContinuityTransition(BASE_SNAPSHOT, next)).toEqual({ contentBumped: true, continuityBumped: false });
    const published = applyOnce(BASE_SNAPSHOT, next);
    expect(evaluateContinuityTransition(published, next)).toEqual({ contentBumped: false, continuityBumped: false });
  });

  it('unverified→verified 升级(证据补全)→ 仅 content+1;声明 verified 但证据不完整(digest/schema 缺失)→ 拒绝发布不更新', () => {
    const unverified = withSnapshot(BASE_SNAPSHOT, { evidenceState: 'unverified', evidenceDigest: null, evidenceSchemaVersion: null });
    const upgraded = withSnapshot(unverified, {
      evidenceState: 'verified',
      evidenceDigest: 'fixture-ep02-verified-digest',
      evidenceSchemaVersion: 'fixture-evidence-v1',
    });
    expect(evaluateContinuityTransition(unverified, upgraded)).toEqual({ contentBumped: true, continuityBumped: false });
    // §2「verified 需完整证据」+ §3「失败/截断不发布」:抛 ContinuityPublicationError,不产出 outcome
    expectContinuityReject('incomplete_evidence', () =>
      evaluateContinuityTransition(unverified, withSnapshot(unverified, { evidenceState: 'verified' })),
    );
    expectContinuityReject('incomplete_evidence', () =>
      evaluateContinuityTransition(
        unverified,
        withSnapshot(unverified, { evidenceState: 'verified', evidenceDigest: 'fixture-digest-only' }),
      ),
    );
  });

  it('签名关键字段缺失(canonicalName/matchRuleVersion 归一后为空)→ signature_incomplete 拒绝发布(不自动制造「内容一致」)', () => {
    expectContinuityReject('signature_incomplete', () =>
      evaluateContinuityTransition(BASE_SNAPSHOT, withSnapshot(BASE_SNAPSHOT, { signature: { ...BASE_SIGNATURE, canonicalName: '' } })),
    );
    expectContinuityReject('signature_incomplete', () =>
      evaluateContinuityTransition(BASE_SNAPSHOT, withSnapshot(BASE_SNAPSHOT, { signature: { ...BASE_SIGNATURE, canonicalName: '   ' } })),
    );
    expectContinuityReject('signature_incomplete', () =>
      evaluateContinuityTransition(BASE_SNAPSHOT, withSnapshot(BASE_SNAPSHOT, { signature: { ...BASE_SIGNATURE, matchRuleVersion: '' } })),
    );
  });
});

/* ------------------------------------------------------------------ */
/* E. 尾部未完成与 canAttemptResume 候选形态                             */
/* ------------------------------------------------------------------ */

describe('E. 尾部未完成:§5「0<p<duration 仍可尝试续播」+ FR-017 候选/最终资格分离', () => {
  it('0<p<duration 未完成 → 候选 {true,null};probe 后最终资格 eligible(start=位置);disposition=resume/accepted', () => {
    expect(canAttemptResumeCandidate(candidateFacts())).toEqual({ canAttemptResume: true, resumeReason: null });
    expect(requireEligible(computeResumeEligibility({ history: historyRecord(), current: currentFacts() }))).toEqual({
      eligible: true,
      startSeconds: 40,
    });
    expect(resolveStartPoint(resolveInput())).toEqual({
      startBasis: 'target_history',
      disposition: 'resume',
      resumeReason: 'accepted',
      startSeconds: 40,
    });
  });

  it('completed 只由有效 finish 写:规则层只读消费——completed=true 的记录判 completed、不再候选、起点从头', () => {
    expect(canAttemptResumeCandidate(candidateFacts({ completed: true }))).toEqual({
      canAttemptResume: false,
      resumeReason: 'completed',
    });
    expect(requireIneligible(computeResumeEligibility({ history: historyRecord({ completed: true }), current: currentFacts() })).reason).toBe(
      'completed',
    );
    expect(resolveStartPoint(resolveInput({ history: historyRecord({ completed: true }) }))).toEqual({
      startBasis: 'beginning',
      disposition: 'beginning',
      resumeReason: 'completed',
      startSeconds: 0,
    });
  });

  it('位置边界:p=0/p=duration/p>duration → invalid_position;p=duration−1(最后 1 秒,近结尾)仍可续播(nearEnd 只是提示)', () => {
    for (const positionSeconds of [0, 90, 91]) {
      expect(canAttemptResumeCandidate(candidateFacts({ positionSeconds }))).toEqual({
        canAttemptResume: false,
        resumeReason: 'invalid_position',
      });
      expect(
        requireIneligible(computeResumeEligibility({ history: historyRecord({ positionSeconds }), current: currentFacts() })).reason,
      ).toBe('invalid_position');
    }
    expect(canAttemptResumeCandidate(candidateFacts({ positionSeconds: 89 }))).toEqual({
      canAttemptResume: true,
      resumeReason: null,
    });
    expect(
      requireEligible(computeResumeEligibility({ history: historyRecord({ positionSeconds: 89 }), current: currentFacts() }))
        .startSeconds,
    ).toBe(89);
  });

  it('多重拒绝按钉死顺序取首个原因:content > continuity > completed > duration_unknown', () => {
    expect(
      requireIneligible(
        computeResumeEligibility({
          history: historyRecord({ completed: true }),
          current: currentFacts({ contentRevision: 2, continuityRevision: 2 }),
        }),
      ).reason,
    ).toBe('content_changed');
    expect(
      requireIneligible(
        computeResumeEligibility({
          history: historyRecord({ completed: true }),
          current: currentFacts({ continuityRevision: 2 }),
        }),
      ).reason,
    ).toBe('continuity_changed');
    expect(
      requireIneligible(
        computeResumeEligibility({
          history: historyRecord({ completed: true, durationSeconds: null }),
          current: currentFacts({ currentDurationSeconds: null }),
        }),
      ).reason,
    ).toBe('completed');
  });
});

/* ------------------------------------------------------------------ */
/* F. 短片:绝对下限不误杀                                               */
/* ------------------------------------------------------------------ */

describe('F. 短片:FR-020 容差下限保证极短媒体不被 2% 误杀(世界一 EP3=30s)', () => {
  it('30s 短片:0<p<duration 可续播(含最后 1 秒);容差取绝对下限 30s(2%=0.6s 不收缩下限)', () => {
    expect(startDriftToleranceSeconds(30)).toBe(START_DRIFT_ABSOLUTE_TOLERANCE_SECONDS);
    expect(startDriftToleranceSeconds(30)).toBe(30);
    const shortHistory = (positionSeconds: number): ResumeHistoryRecord =>
      historyRecord({ mediaId: 'fixture-media-serial-ep03', positionSeconds, durationSeconds: 30 });
    const shortCurrent = currentFacts({ mediaId: 'fixture-media-serial-ep03', currentDurationSeconds: 30 });
    expect(requireEligible(computeResumeEligibility({ history: shortHistory(20), current: shortCurrent })).startSeconds).toBe(20);
    expect(requireEligible(computeResumeEligibility({ history: shortHistory(29), current: shortCurrent })).startSeconds).toBe(29);
  });

  it('短片时长变化在 ±30s 下限内不误杀(30→55 仍续播);超过下限(30→61,delta 31)→ duration_changed 从头', () => {
    const shortHistory = historyRecord({ mediaId: 'fixture-media-serial-ep03', positionSeconds: 20, durationSeconds: 30 });
    expect(
      requireEligible(
        computeResumeEligibility({
          history: shortHistory,
          current: currentFacts({ mediaId: 'fixture-media-serial-ep03', currentDurationSeconds: 55 }),
        }),
      ).startSeconds,
    ).toBe(20);
    expect(
      requireIneligible(
        computeResumeEligibility({
          history: shortHistory,
          current: currentFacts({ mediaId: 'fixture-media-serial-ep03', currentDurationSeconds: 61 }),
        }),
      ).reason,
    ).toBe('duration_changed');
  });
});

/* ------------------------------------------------------------------ */
/* G. 差异容差边界:max(30s,旧可信时长×2%),恰界允许/超界降级             */
/* ------------------------------------------------------------------ */

describe('G. 差异阈值:FR-020「max(30秒,原可信时长的2%);超过容差不自动继承位置,禁止按百分比强行映射」', () => {
  it('常量与函数:RELATIVE=0.02;360s → 下限主导(30s);定制长片 1800s → 2% 主导(36s,浮点精确)', () => {
    expect(START_DRIFT_RELATIVE_TOLERANCE).toBe(0.02);
    expect(START_DRIFT_ABSOLUTE_TOLERANCE_SECONDS).toBe(30);
    expect(startDriftToleranceSeconds(360)).toBe(30);
    expect(startDriftToleranceSeconds(1800)).toBe(36);
  });

  it('下限主导边界(360s):±30s 恰界允许(390/330 仍续播),±31s 超界 duration_changed(391/329),差异双向对称', () => {
    const history = historyRecord({ positionSeconds: 350, durationSeconds: 360 });
    const eligibilityFor = (currentDurationSeconds: number): ResumeEligibility =>
      computeResumeEligibility({ history, current: currentFacts({ currentDurationSeconds }) });
    expect(requireEligible(eligibilityFor(390)).startSeconds).toBe(350);
    expect(requireEligible(eligibilityFor(330)).startSeconds).toBe(350);
    expect(requireIneligible(eligibilityFor(391)).reason).toBe('duration_changed');
    expect(requireIneligible(eligibilityFor(329)).reason).toBe('duration_changed');
  });

  it('2% 主导边界(1800s 素材):恰 +2%(1836,delta=36)允许;+1 秒超界(1837)→ duration_changed', () => {
    const history = historyRecord({ mediaId: 'fixture-media-continuity-long', positionSeconds: 1700, durationSeconds: 1800 });
    const longCurrent = (currentDurationSeconds: number): ResumeCurrentFacts =>
      currentFacts({ mediaId: 'fixture-media-continuity-long', currentDurationSeconds });
    expect(requireEligible(computeResumeEligibility({ history, current: longCurrent(1836) })).startSeconds).toBe(1700);
    expect(requireIneligible(computeResumeEligibility({ history, current: longCurrent(1837) })).reason).toBe('duration_changed');
  });

  it('超界降级形态:duration_changed → 起点从头(reason=duration_changed 而非 invalid_position),startSeconds=0、不百分比换算', () => {
    expect(resolveStartPoint(resolveInput({ current: currentFacts({ currentDurationSeconds: 391 }) }))).toEqual({
      startBasis: 'beginning',
      disposition: 'beginning',
      resumeReason: 'duration_changed',
      startSeconds: 0,
    });
  });
});

/* ------------------------------------------------------------------ */
/* H. 起点冻结一次:他设备更新不改变已冻结起点                           */
/* ------------------------------------------------------------------ */

describe('H. 冻结不变性:FR-021「检查完成后一次冻结,另一设备后来更新不能改已冻结起点」', () => {
  it('resume 冻结起点 350s 后,他设备推进历史(350→120)且本次时长微漂移(360→365)→ 已冻结起点逐字段原样不变', () => {
    const frozen: FrozenStartPoint = resolveStartPoint(
      resolveInput({ history: historyRecord({ positionSeconds: 350, durationSeconds: 360 }) }),
    );
    expect(frozen).toEqual({ startBasis: 'target_history', disposition: 'resume', resumeReason: 'accepted', startSeconds: 350 });
    // 同 session 再次求解(如 ready 提交重验路径):只回放冻结值,不第二次读历史
    const afterOtherDeviceUpdate = resolveStartPoint(
      resolveInput({
        history: historyRecord({ positionSeconds: 120, durationSeconds: 365 }),
        current: currentFacts({ currentDurationSeconds: 365 }),
        frozen,
      }),
    );
    expect(afterOtherDeviceUpdate).toEqual(frozen);
    expect(afterOtherDeviceUpdate.startSeconds).toBe(350);
  });

  it('冻结语义 ≠ 历史不可变:同一更新输入在未冻结路径(frozen=null)按更新后历史重算起点 120;beginning 冻结同样不被覆盖', () => {
    const updatedHistory = historyRecord({ positionSeconds: 120, durationSeconds: 365 });
    const updatedCurrent = currentFacts({ currentDurationSeconds: 365 });
    // 对照:无冻结时读取的是当前历史 → 起点 120(证明 H 前一用例的不变来自冻结,而非输入被忽略)
    expect(resolveStartPoint(resolveInput({ history: updatedHistory, current: updatedCurrent })).startSeconds).toBe(120);
    // beginning 模式冻结 {beginning, requested_beginning, 0} 后同样不被他设备更新覆盖
    const beginningFrozen = resolveStartPoint(resolveInput({ requestedMode: 'beginning' }));
    expect(beginningFrozen).toEqual({
      startBasis: 'beginning',
      disposition: 'beginning',
      resumeReason: 'requested_beginning',
      startSeconds: 0,
    });
    expect(resolveStartPoint(resolveInput({ requestedMode: 'beginning', history: updatedHistory, current: updatedCurrent, frozen: beginningFrozen }))).toEqual(
      beginningFrozen,
    );
  });
});

/* ------------------------------------------------------------------ */
/* I. 时长未知:不用历史/他 Profile duration 兜底                        */
/* ------------------------------------------------------------------ */

describe('I. 时长未知:§5「本次 probe 未知则不能用历史 duration 作为在线兜底」(独立影片 endList=false 形态)', () => {
  it('本次 probe duration 未知(currentDurationSeconds=null)→ duration_unknown 拒绝——尽管历史上 0<100<360 成立', () => {
    const history = historyRecord({ mediaId: 'fixture-media-standalone-hd', positionSeconds: 100, durationSeconds: 360 });
    const current = currentFacts({ mediaId: 'fixture-media-standalone-hd', currentDurationSeconds: null });
    expect(requireIneligible(computeResumeEligibility({ history, current })).reason).toBe('duration_unknown');
    expect(resolveStartPoint(resolveInput({ history, current }))).toEqual({
      startBasis: 'beginning',
      disposition: 'beginning',
      resumeReason: 'duration_unknown',
      startSeconds: 0,
    });
    // 对照:同一事实仅本次可信时长恢复为已知 → 允许续播(证明拒绝仅因「本次未知」,非位置/修订问题)
    expect(requireEligible(computeResumeEligibility({ history, current: { ...current, currentDurationSeconds: 360 } })).startSeconds).toBe(100);
  });

  it('历史侧时长未知(durationSeconds=null)同样 duration_unknown:任一侧缺可信时长都无法建立「时长兼容」,不虚构基线', () => {
    expect(
      requireIneligible(
        computeResumeEligibility({
          history: historyRecord({ durationSeconds: null }),
          current: currentFacts({ currentDurationSeconds: 360 }),
        }),
      ).reason,
    ).toBe('duration_unknown');
    // HistorySummary 候选形态同构:durationSeconds=null → {false, duration_unknown}
    expect(canAttemptResumeCandidate(candidateFacts({ durationSeconds: null }))).toEqual({
      canAttemptResume: false,
      resumeReason: 'duration_unknown',
    });
  });
});
