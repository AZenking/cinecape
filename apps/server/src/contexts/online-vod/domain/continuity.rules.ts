/**
 * 010 T039 — 内容/连续性修订转换与起点漂移容差(纯领域,零依赖)。
 *
 * 纯 TS:零依赖、零 import(.dependency-cruiser.cjs R1a 对 domain 层的框架/内建/
 * platform/外部包硬禁令 + audit:purity 符号级门禁;本文件连类型 import 都没有)。
 * 失败语义为纯 Error 子类,interface 层负责翻译为 HTTP 语义(对齐 provider-model.ts
 * / vod-budgets.ts 惯例)。本模块不做任何持久化/批量回填:每次调用只做「一次转换
 * 判定」,历史修订升级由发布流程逐次调用本函数完成(「不批量升级历史」,data-model §3)。
 *
 * 来源标注(实现侧不自创语义,契约冻结面):
 * - docs/specs/010-online-vod/data-model.md §3(修订与连续性,逐字):
 *   「contentRevision表示已知内容替换/可信证据更换;continuityRevision反映该子项稳定
 *   定位/已知年季版本匹配条件变化。新增其他集不使已有子revision改变」;
 *   「continuitySignature包含规范身份/已知年份季度语言版本/匹配规则版本,不含URL/
 *   采集时间,不是媒体hash;缺关键字段不自动制造"内容一致"的证据」;
 *   「verified证据更换/降级/从unverified升级均contentRevision+1;unverified结构相同
 *   仅地址更新不变。关键结构变更continuityRevision+1,明确内容替换两者可同次变更,
 *   各最多+1。失败/截断不发布」;
 *   「历史保存产生时的内容/连续性修订及证据,不能批量跟随当前状态升级」。
 * - docs/specs/010-online-vod/tasks.md T039:实现上述两条;signature 不含 URL/采集
 *   时间;证据升降级和关键结构修订各最多+1,失败不发布,不批量升级历史(依赖 T037)。
 * - docs/specs/010-online-vod/spec.md FR-020:「时长差异超过 max(30秒,原可信时长的
 *   2%)不自动继承位置,禁止按百分比强行映射」——本文件只提供容差函数,裁决顺序在
 *   application/continuity.service.ts(T041 接线消费)。
 * - 行为仲裁面:apps/server/test/unit/online-vod/continuity-resume.spec.ts(010 T037
 *   测试先行,24 用例;文件头钉死导出面/语义表,T039 以使其全绿为完成定义)。
 *
 * 导出面即 T037 测试 import 面(逐字):START_DRIFT_ABSOLUTE_TOLERANCE_SECONDS /
 * START_DRIFT_RELATIVE_TOLERANCE / startDriftToleranceSeconds /
 * evaluateContinuityTransition / ContinuityPublicationError /
 * ContinuityPublicationErrorCode / ContinuityEvidenceState / ContinuitySignature /
 * ContinuityEpisodeSnapshot / ContinuityTransitionOutcome。
 *
 * evaluateContinuityTransition 修订触发表(data-model §3 逐条钉面;「其余字段不变」前提;
 *  表中 ✓/✗ 指 contentBumped/continuityBumped):
 * | 变化信号(previous→next)                          | content | continuity | 依据(§3)                      |
 * | locatorUrl(sign token)/collectedAtMs 仅变化      |    ✗    |     ✗      | URL token/采集时间变化不加     |
 * | evidenceState verified→unverified(降级)          |    ✓    |     ✗      | 降级 → content+1              |
 * | evidenceState unverified→verified(升级,证据完整) |    ✓    |     ✗      | 从 unverified 升级 → content+1 |
 * | 双 verified 且 evidenceDigest 变化                |    ✓    |     ✗      | 可信证据更换 → content+1       |
 * | 双 unverified 且 evidenceDigest 变化              |    ✗    |     ✗      | 「unverified 结构相同仅地址    |
 * |                                                  |         |            |  更新不变」:不构成可信更换信号 |
 * | signature.knownVersionLabel 变化(剧场版→导演剪辑) |    ✓    |     ✓      | 明确内容替换:内容替换+匹配条件 |
 * | signature.canonicalName 变化(规范身份换内容)      |    ✓    |     ✓      | 可同次变更,各最多+1           |
 * | signature.year/seasonKey/languageVersion/         |    ✗    |     ✓      | 已知年季版本匹配条件变化       |
 * | matchRuleVersion 变化                             |         |            |                               |
 * | 自身 episodeKey 从 next.siblingEpisodeKeys 消失    |    ✗    |     ✓      | 关键结构变更 → continuity+1    |
 * | siblings 追加/移除「其他集」(自身键仍在)           |    ✗    |     ✗      | 新增其他集不使已有子revision改变|
 *
 * 「各最多 +1」钉法:outcome 为布尔对,单次事件结构上至多各一次;applyOnce 重放
 * (发布推进后的快照对同一 next 再评估)必须 {false,false}——同一变化不产生第二次
 * 推进(信号均以「前态→后态」转移表达,发布后前态即后态,无新事件)。
 *
 * 拒绝发布(先于一切比较,next 为发布候选):next 声明 verified 但 evidenceDigest/
 * evidenceSchemaVersion 缺失(归一后为空/null)→ ContinuityPublicationError
 * ('incomplete_evidence')(§2「verified 需完整证据」+ §3「失败/截断不发布」——抛错即
 * 不产出 outcome、不更新 revision);next.signature.canonicalName/matchRuleVersion
 * 归一后为空 → ('signature_incomplete')(§3「缺关键字段不自动制造『内容一致』的证据」)。
 * previous 为已持久可信状态,不重验。
 */

/* ------------------------------------------------------------------ */
/* FR-020 起点漂移容差常量                                              */
/* ------------------------------------------------------------------ */

/** 容差绝对下限 30 秒(spec FR-020「max(30秒,原可信时长的2%)」的绝对项;单位秒) */
export const START_DRIFT_ABSOLUTE_TOLERANCE_SECONDS = 30;

/** 容差相对项:旧可信时长 × 2%(spec FR-020;0.02 以常量钉死,禁止调用方自传比例) */
export const START_DRIFT_RELATIVE_TOLERANCE = 0.02;

/**
 * FR-020 起点漂移容差:max(30s,旧可信时长×2%)。
 * 1800s → 36s(2% 主导;IEEE754 下 1800*0.02 恰为 36,无浮点漂移)、360s → 30s、
 * 30s 短片 → 30s(2%=0.6s 不收缩绝对下限,极短媒体不被 2% 误杀)。
 * 输入约定:previousTrustedDurationSeconds 为有限正数(存储层保证 duration>0,
 * 非正输入不属本契约面,不做防御校验);返回值单位=秒。
 */
export function startDriftToleranceSeconds(previousTrustedDurationSeconds: number): number {
  return Math.max(
    START_DRIFT_ABSOLUTE_TOLERANCE_SECONDS,
    previousTrustedDurationSeconds * START_DRIFT_RELATIVE_TOLERANCE,
  );
}

/* ------------------------------------------------------------------ */
/* 连续性签名/快照值模型(§3:signature 不含 URL/采集时间,不是媒体 hash)   */
/* ------------------------------------------------------------------ */

/** 证据可信状态:verified=完整可信证据;unverified=基础 adapter 证据(data-model §2) */
export type ContinuityEvidenceState = 'unverified' | 'verified';

/**
 * 连续性签名(§3 逐字投影):规范身份/已知年份季度语言版本/匹配规则版本。
 * 不含 URL/采集时间/媒体 hash——locatorUrl/collectedAtMs 只在快照层,永不进入本签名,
 * 因此 token 轮换/采集时间推进结构上进不了任何修订信号(A 组钉面)。
 */
export interface ContinuitySignature {
  /** NFC 归一后的规范身份名;归一后为空 → signature_incomplete 拒绝发布 */
  readonly canonicalName: string;
  /** 已知年份;上游未给 → null(不自动制造) */
  readonly year: string | null;
  /** 已知季键;无季概念 → null */
  readonly seasonKey: string | null;
  /** 已知语言版本;未区分 → null */
  readonly languageVersion: string | null;
  /** 已知版本标签(剧场版/导演剪辑版等);无版本区分 → null */
  readonly knownVersionLabel: string | null;
  /** 匹配规则版本(判定语义自身的版本);归一后为空 → signature_incomplete 拒绝发布 */
  readonly matchRuleVersion: string;
}

/** 单集连续性快照:修订计数 + 签名 + 证据状态 + 结构邻域(兄弟集键集) */
export interface ContinuityEpisodeSnapshot {
  /** 本子项集键(在 siblingEpisodeKeys 内的自身身份) */
  readonly episodeKey: string;
  /** 内容修订:已知内容替换/可信证据更换时 +1(§3;发布方负责落盘推进) */
  readonly contentRevision: number;
  /** 连续性修订:稳定定位/已知年季版本匹配条件变化时 +1(§3) */
  readonly continuityRevision: number;
  /** 连续性签名(不含 URL/采集时间) */
  readonly signature: ContinuitySignature;
  /** 证据可信状态 */
  readonly evidenceState: ContinuityEvidenceState;
  /** 可信证据摘要;unverified → null(不自动制造) */
  readonly evidenceDigest: string | null;
  /** 可信证据结构版本;unverified → null */
  readonly evidenceSchemaVersion: string | null;
  /** 同标题/线路兄弟集键全集(结构邻域;readonly 数组,追加别集不推进本子项修订) */
  readonly siblingEpisodeKeys: readonly string[];
  /** 定位地址(仅记录;sign token 变化不参与任何信号,§3「不含URL」) */
  readonly locatorUrl: string;
  /** 采集时间戳 ms(仅记录;推进不参与任何信号,§3「不含采集时间」) */
  readonly collectedAtMs: number;
}

/** 转换判定结果:布尔对,单次事件各修订至多推进一次(「各最多+1」) */
export interface ContinuityTransitionOutcome {
  /** 已知内容替换/可信证据更换 → true(发布方将 contentRevision+1) */
  readonly contentBumped: boolean;
  /** 匹配条件变化/关键结构变更 → true(发布方将 continuityRevision+1) */
  readonly continuityBumped: boolean;
}

/* ------------------------------------------------------------------ */
/* 拒绝发布错误(纯 Error 子类;interface 层翻译为 HTTP 语义)              */
/* ------------------------------------------------------------------ */

/** 拒绝发布错误码(恰两值;T037 钉面) */
export type ContinuityPublicationErrorCode = 'incomplete_evidence' | 'signature_incomplete';

/**
 * 拒绝发布错误(§3「失败/截断不发布」语义载体;抛错即不产出 outcome、不更新 revision,
 * 绝不静默降级为「无变化」——§3「缺关键字段不自动制造『内容一致』的证据」)。
 */
export class ContinuityPublicationError extends Error {
  readonly code: ContinuityPublicationErrorCode;

  constructor(code: ContinuityPublicationErrorCode, message: string) {
    super(message);
    this.name = 'ContinuityPublicationError';
    this.code = code;
  }
}

/* ------------------------------------------------------------------ */
/* 转换判定                                                             */
/* ------------------------------------------------------------------ */

/** 归一化(对齐 provider-model.normalizeIdentity 口径):仅 NFC + 首尾 trim */
function normalizeSignatureField(value: string): string {
  return value.normalize('NFC').trim();
}

/** 字段缺失判定:null 或归一后为空即视为缺失(§3「缺关键字段」;不自动制造) */
function isMissingField(value: string | null): boolean {
  return value === null || normalizeSignatureField(value) === '';
}

/**
 * 内容/连续性单次转换判定(文件头修订触发表逐条;previous 为已持久可信状态不重验,
 * next 为发布候选先做拒绝发布检查再比较)。
 *
 * 各信号均以「前态→后态」转移表达,保证 applyOnce 重放恒 {false,false}
 * (同一变化事件只产生一次推进,「各最多+1」):
 * - 证据类:verified→unverified 降级 / unverified→verified 升级 / 双 verified digest
 *   更换 → content;双 unverified digest 变化不是可信更换信号(§3「unverified 结构
 *   相同仅地址更新不变」);
 * - 匹配条件类:signature 任一字段变化 → continuity;其中 canonicalName/
 *   knownVersionLabel 变化属「明确内容替换」,content 与 continuity 可同次变更;
 * - 结构类:自身 episodeKey 此前在兄弟集中、next 中消失(集被改名/移除)→ continuity;
 *   兄弟集追加/移除「其他集」(自身键仍在)不推进(§3「新增其他集不使已有子revision改变」);
 * - locatorUrl/collectedAtMs/修订计数本身不参与任何信号(§3「URL token/采集时间变化不加」)。
 *
 * @throws ContinuityPublicationError('incomplete_evidence')  next 声明 verified 但
 *         evidenceDigest/evidenceSchemaVersion 缺失(§2「verified 需完整证据」)
 * @throws ContinuityPublicationError('signature_incomplete') next.signature.
 *         canonicalName/matchRuleVersion 归一后为空
 */
export function evaluateContinuityTransition(
  previous: ContinuityEpisodeSnapshot,
  next: ContinuityEpisodeSnapshot,
): ContinuityTransitionOutcome {
  /* 拒绝发布先于一切比较(§3「失败/截断不发布」):next 不合格即抛错,不产出 outcome */
  if (next.evidenceState === 'verified') {
    if (isMissingField(next.evidenceDigest) || isMissingField(next.evidenceSchemaVersion)) {
      throw new ContinuityPublicationError(
        'incomplete_evidence',
        'verified 证据不完整:evidenceDigest/evidenceSchemaVersion 缺失,拒绝发布(data-model §2/§3)',
      );
    }
  }
  if (
    normalizeSignatureField(next.signature.canonicalName) === '' ||
    normalizeSignatureField(next.signature.matchRuleVersion) === ''
  ) {
    throw new ContinuityPublicationError(
      'signature_incomplete',
      '连续性签名缺关键字段(canonicalName/matchRuleVersion 归一后为空),不自动制造「内容一致」(data-model §3)',
    );
  }

  /* 内容信号:证据升降级/可信证据更换/明确内容替换(规范身份或版本标签变化) */
  const evidenceDowngraded = previous.evidenceState === 'verified' && next.evidenceState === 'unverified';
  const evidenceUpgraded = previous.evidenceState === 'unverified' && next.evidenceState === 'verified';
  const verifiedEvidenceReplaced =
    previous.evidenceState === 'verified' &&
    next.evidenceState === 'verified' &&
    previous.evidenceDigest !== next.evidenceDigest;
  const identityContentReplaced =
    previous.signature.canonicalName !== next.signature.canonicalName ||
    previous.signature.knownVersionLabel !== next.signature.knownVersionLabel;
  const contentBumped =
    evidenceDowngraded || evidenceUpgraded || verifiedEvidenceReplaced || identityContentReplaced;

  /* 连续性信号:匹配条件任一字段变化 / 自身集键从结构邻域消失(前在→后不在) */
  const matchConditionChanged =
    previous.signature.canonicalName !== next.signature.canonicalName ||
    previous.signature.year !== next.signature.year ||
    previous.signature.seasonKey !== next.signature.seasonKey ||
    previous.signature.languageVersion !== next.signature.languageVersion ||
    previous.signature.knownVersionLabel !== next.signature.knownVersionLabel ||
    previous.signature.matchRuleVersion !== next.signature.matchRuleVersion;
  const ownKeyDisappeared =
    previous.siblingEpisodeKeys.includes(previous.episodeKey) &&
    !next.siblingEpisodeKeys.includes(previous.episodeKey);
  const continuityBumped = matchConditionChanged || ownKeyDisappeared;

  return { contentBumped, continuityBumped };
}
