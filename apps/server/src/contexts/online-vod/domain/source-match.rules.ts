/**
 * 010 T070 — 换源候选匹配规则(纯领域,零依赖)。
 *
 * 纯 TS:零依赖、零 import(.dependency-cruiser.cjs R1a 对 domain 层的框架/内建/
 * platform/外部包硬禁令 + audit:purity 符号级门禁;本文件连类型 import 都没有,
 * 与 provider-model/continuity.rules/episode-sequence.rules 同惯例)。
 * 匹配判定不抛错——歧义/冲突就是正常结论,无 Error 子类;零时钟/零网络/零随机
 * (结论只由输入事实决定;候选过期把门在 isSwitchCandidateFresh,不混入语义)。
 *
 * 行为仲裁面(本文件使其全绿):apps/server/test/unit/online-vod/source-match.spec.ts
 * (010 T068 测试先行,32 用例;文件头钉死导出面/判定表,T070 以使其全绿为完成定义)。
 *
 * 来源标注(实现侧不自创语义,契约冻结面):
 * - spec.md FR-030(逐字):「匹配充分至少要求规范标题、电影年份或剧集年份/季/集一致
 *   且语言/版本无冲突;缺关键字段归歧义,明确不同版本归冲突。歧义需确认具体目标才能
 *   携带位置,冲突不允许携带,标题相同或列表下标不构成充分匹配。」
 * - spec.md FR-029(候选/测速只元数据、不暴露地址、未授权目标不得探测)、FR-031(carry
 *   只取当前设备来源会话已接受样本与可信时长)。
 * - contracts/api.md §1 SwitchCandidate:「candidateRef,title,label,year:string|null,
 *   season:string|null,versionLabel:string|null,sourceLabel,lineLabel,
 *   matchConfidence:high|ambiguous|conflict,matchReasons:string[],previewRevision,
 *   expiresAt;source内部ID/位置不下发」;§5 候选语义:「同线/跨源候选只元数据,
 *   服务端从来源标题构造搜索,不接任意q/URL;failed可恢复来源仅60s」「target必须可
 *   验证候选;high可carry,ambiguous需confirmed且具体集,conflict只beginning/
 *   target_history且不能继承源位置」。
 * - data-model.md §3(逐字):「continuitySignature包含规范身份/已知年份季度语言版本/
 *   匹配规则版本,不含URL/采集时间,不是媒体hash;缺关键字段不自动制造"内容一致"的
 *   证据」;§7 intent 记录 match_revision/confidence 与 confirmed_ambiguous——授权面
 *   消费匹配结论,不回写匹配等级。
 * - tasks.md T070(逐字):实现「matchConfidence=high|ambiguous|conflict」及匹配规则
 *   版本/候选TTL;从已授权fromSession可信标题构造搜索,返回opaque具体集,不接受任意
 *   q/URL;可恢复failed仅60s。
 * - T025 provider-model(已落地):ProviderTitleIdentity{upstreamVodId,name,year,
 *   version} 为候选事实的解析投影;身份字符串 NFC+trim 由解析层保证,本规则面按精确
 *   字符串比较(对齐 episode-sequence「key 假定已 NFC+trim(§1 身份层职责)」惯例)。
 *
 * 匹配面/授权面分离(D 组钉法):matchCandidate 只吃服务端事实(输入类型无
 * confirmedAmbiguous 入口——类型面即钉面),产出事实性结论;用户确认只经
 * carryPositionEligibility 解锁 intent 提交(api §5),从不改写 confidence/reasons——
 * SwitchCandidate 与 IntentReply 上报的 matchConfidence 恒为匹配事实等级。
 *
 * matchCandidate 判定表(source-match.spec 文件头逐字钉死;五个事实位独立评估,
 * reasons 按枚举序全量报告):
 * | 事实位(双侧)        | 双方已知且相等         | 双方已知不等           | 任一侧缺失(null)       |
 * | canonicalName      | title_match            | title_conflict         | (输入前提:恒非空)     |
 * | year               | year_match             | year_conflict          | year_missing          |
 * | seasonKey+episodeKey | season_episode_match  | season_episode_conflict | season_episode_missing |
 * | languageVersion    | language_match         | language_conflict      | language_missing      |
 * | knownVersionLabel  | version_label_match    | version_label_conflict | version_label_missing |
 * - season/episode 事实位仅在任一侧声明结构(season 或 episode 非 null)时评估;
 *   双侧均 null(电影形态)→ 该位沉默,不出任何 reason;
 *   ⚠️ 钉面偏差说明(以测试为准,对齐 continuity.service 先例):版本标签位明确冲突
 *   (version_label_conflict)时季集位沉默——「明确不同版本」已确立双侧非同一已知作品
 *   版本,季集同一性比较不再出具结论(FR-030 conflict 足以定级);版本位 match/
 *   missing/silent 均不关闭季集位。该门由契约文件联合钉死:B8(电影源 vs 声明 S01/02
 *   的同版候选)钉「任一侧声明 + 版本一致 → season_episode_missing」,C2(同年不同
 *   版本标签、候选声明 S01/02)钉「version_label_conflict → 季集位不出 reason」,
 *   C5(同名不同年 + version_label_missing)钉「版本位 missing 不吞并季集门」——
 *   三者联合排除「无门」与「missing 也关门」两种对照读法,唯一满足全部分组的是
 *   conflict-only 门。
 * - 语言/版本双侧均 null(均未声明区分)→ 该位沉默:无版本区分,亦无冲突证据,不阻断 high;
 * - confidence 位序:任一 *_conflict → 'conflict';否则任一 *_missing → 'ambiguous';
 *   否则 'high'(high 需 title/year/结构位齐备——缺位已被 missing 分支拦截)。
 * - 「缺字段降歧义」覆盖 year/season/episode(FR-030 关键字段)以及语言/版本一侧未知
 *   (一侧未知时无法建立「无冲突」,保守归歧义,由用户确认解锁 carry);「明确不同归
 *   冲突」覆盖年/季集/语言/版本标签的显式不等(含同名不同年、同题明确不同集)。
 */

/* ------------------------------------------------------------------ */
/* 契约常量                                                            */
/* ------------------------------------------------------------------ */

/**
 * 匹配规则版本(data-model §3 continuitySignature.matchRuleVersion 同源语义)。
 * 非空字符串;值由实现定,结论恒钉版(F 组):版本演进只作废旧结论(isMatchConclusionCurrent
 * 为 false 必须重评),不改变候选身份键(candidateIdentityKey 不含规则版本)。
 */
export const MATCH_RULE_VERSION = 'online-vod-source-match-v1';

/**
 * 候选 TTL 毫秒:api §1 SwitchCandidate.expiresAt 载体 + T070「可恢复failed仅60s」
 * 同族常量(60s 固定;服务层按 nowMs + 本值派生候选 expiresAtMs 与 failed 恢复窗)。
 */
export const SWITCH_CANDIDATE_TTL_MS = 60_000;

/* ------------------------------------------------------------------ */
/* 值模型(双侧同构的匹配语义面;全部 readonly 纯值)                       */
/* ------------------------------------------------------------------ */

/** 匹配置信(api §1 matchConfidence 枚举,逐字) */
export type MatchConfidence = 'high' | 'ambiguous' | 'conflict';

/**
 * 匹配原因领域码集(api §1 matchReasons:string[] 的领域码全集)。
 * 固定按下列枚举序输出、去重:标题 → 年 → 季集 → 语言 → 版本标签。
 */
export type MatchReason =
  | 'title_match'
  | 'title_conflict'
  | 'year_match'
  | 'year_conflict'
  | 'year_missing'
  | 'season_episode_match'
  | 'season_episode_conflict'
  | 'season_episode_missing'
  | 'language_match'
  | 'language_conflict'
  | 'language_missing'
  | 'version_label_match'
  | 'version_label_conflict'
  | 'version_label_missing';

/** 全部原因码的固定输出序(枚举声明序;判定实现按此序收集,不重排不去不全) */
const MATCH_REASON_ORDER: readonly MatchReason[] = [
  'title_match',
  'title_conflict',
  'year_match',
  'year_conflict',
  'year_missing',
  'season_episode_match',
  'season_episode_conflict',
  'season_episode_missing',
  'language_match',
  'language_conflict',
  'language_missing',
  'version_label_match',
  'version_label_conflict',
  'version_label_missing',
];

/**
 * 匹配语义面(双侧同构;字段假定已经解析层 NFC+trim,T025 §1 身份层职责)。
 * 类型面即钉面:只有服务端事实字段——无 q/URL/客户端候选/列表下标/confirmedAmbiguous/
 * 采集时间字段(api §5 服务端构造搜索 + data-model §3 不含 URL/采集时间)。
 */
export interface MatchFacts {
  /** 规范标题(输入前提:恒非空;双侧精确字符串比较) */
  readonly canonicalName: string;
  /** 已知年份;上游未给 → null(不自动制造) */
  readonly year: string | null;
  /** 已知季键;无季概念/解析面未投影 → null */
  readonly seasonKey: string | null;
  /** 已知集键;未锚定具体集 → null */
  readonly episodeKey: string | null;
  /** 已知语言版本;未区分/一侧未知 → null */
  readonly languageVersion: string | null;
  /** 已知版本标签(剧场版/导演剪辑版等);无版本区分 → null */
  readonly knownVersionLabel: string | null;
}

/** 源侧标题事实:来自已授权 fromSession 的服务端可信标题事实(T070) */
export type SourceTitleFacts = MatchFacts;

/**
 * 候选侧事实:MatchFacts + 候选实例身份与 TTL 载体。
 * - upstreamVodId = T025 ProviderTitleIdentity 投影(参与身份键,不参与语义比对——
 *   跨源实例语义等价,身份键只区分实例,A 组);
 * - expiresAtMs = 候选 TTL 绝对到期 epoch ms(api §1 expiresAt;不进身份键、不影响
 *   置信结论——过期仅由 isSwitchCandidateFresh 在可验证面把门,G 组);
 * - 无 URL/locator/采集时间/列表下标字段(data-model §3)。
 */
export interface CandidateFacts extends MatchFacts {
  readonly upstreamVodId: string;
  readonly expiresAtMs: number;
}

/** 匹配结论:置信等级 + 全量原因(枚举序)+ 钉版标记(F 组) */
export interface MatchConclusion {
  readonly confidence: MatchConfidence;
  readonly reasons: readonly MatchReason[];
  /** 恒 === MATCH_RULE_VERSION;消费方经 isMatchConclusionCurrent 判定是否可沿用 */
  readonly matchRuleVersion: string;
}

/* ------------------------------------------------------------------ */
/* 三值事实位求值(内部;known-unknown-silent 统一形态)                    */
/* ------------------------------------------------------------------ */

/** 单事实位求值结果:match/conflict/missing 之一,或 silent(双侧均未声明区分) */
type FactBit = 'match' | 'conflict' | 'missing' | 'silent';

/** 双侧已知字符串位的比较(null=缺失;双侧 null 属调用方 silent 分支,不经此) */
function compareKnownBit(source: string | null, candidate: string | null): FactBit {
  if (source === null || candidate === null) return 'missing';
  return source === candidate ? 'match' : 'conflict';
}

/**
 * 季集复合位(seasonKey+episodeKey 作为一个事实位):
 * - 双侧均完全未声明结构(四个字段全 null)→ silent(电影形态对电影形态);
 * - 双侧四字段全已知 → 全等 match / 任一不等 conflict(矛盾事实,确认无法修正);
 * - 其余(任一侧缺季或缺集)→ missing(不猜电影等价某集,不猜半锚定等价)。
 * 版本标签位明确冲突时本位恒 silent(见文件头钉面偏差说明:不同已知版本的作品,
 * 季集同一性比较不出具结论)——由调用方经 versionGateClosed 传入。
 */
function compareSeasonEpisodeBit(
  source: { readonly seasonKey: string | null; readonly episodeKey: string | null },
  candidate: { readonly seasonKey: string | null; readonly episodeKey: string | null },
  versionGateClosed: boolean,
): FactBit {
  if (versionGateClosed) return 'silent';
  const sourceDeclares = source.seasonKey !== null || source.episodeKey !== null;
  const candidateDeclares = candidate.seasonKey !== null || candidate.episodeKey !== null;
  if (!sourceDeclares && !candidateDeclares) return 'silent';
  if (
    source.seasonKey === null ||
    source.episodeKey === null ||
    candidate.seasonKey === null ||
    candidate.episodeKey === null
  ) {
    return 'missing';
  }
  return source.seasonKey === candidate.seasonKey && source.episodeKey === candidate.episodeKey
    ? 'match'
    : 'conflict';
}

/** 语言/版本位:null=未声明区分;双侧 null → silent(无区分亦无冲突证据,不阻断 high) */
function compareOptionalBit(source: string | null, candidate: string | null): FactBit {
  if (source === null && candidate === null) return 'silent';
  return compareKnownBit(source, candidate);
}

/** FactBit → 该位的 MatchReason(枚举序由 MATCH_REASON_ORDER 收集保证) */
function reasonOfBit(
  bit: FactBit,
  codes: { readonly match: MatchReason; readonly conflict: MatchReason; readonly missing: MatchReason },
): MatchReason | null {
  switch (bit) {
    case 'match':
      return codes.match;
    case 'conflict':
      return codes.conflict;
    case 'missing':
      return codes.missing;
    case 'silent':
      return null;
  }
}

/* ------------------------------------------------------------------ */
/* 匹配判定(纯函数)                                                    */
/* ------------------------------------------------------------------ */

/**
 * 换源候选匹配判定(文件头判定表逐字;纯函数,零时钟/网络/随机):
 * 五个事实位独立评估,reasons 按 MATCH_REASON_ORDER 全量报告(去重);
 * 置信位序:任一 conflict → 'conflict' > 任一 missing → 'ambiguous' > 'high'。
 * 匹配面零时钟:对过期候选照常给出语义结论;过期把门在 isSwitchCandidateFresh(G 组)。
 */
export function matchCandidate(input: {
  readonly sourceTitleFacts: SourceTitleFacts;
  readonly candidateFacts: CandidateFacts;
}): MatchConclusion {
  const source = input.sourceTitleFacts;
  const candidate = input.candidateFacts;

  // 规范标题:输入前提恒非空,精确字符串比较(标题相同本身不构成充分匹配,E 组)
  const titleBit: FactBit = source.canonicalName === candidate.canonicalName ? 'match' : 'conflict';
  const yearBit = compareKnownBit(source.year, candidate.year);
  // 版本标签位先求值:其 conflict 关闭季集位(文件头钉面偏差说明)
  const versionBit = compareOptionalBit(source.knownVersionLabel, candidate.knownVersionLabel);
  const seasonEpisodeBit = compareSeasonEpisodeBit(source, candidate, versionBit === 'conflict');
  const languageBit = compareOptionalBit(source.languageVersion, candidate.languageVersion);

  const bits: readonly { readonly bit: FactBit; readonly codes: {
    readonly match: MatchReason;
    readonly conflict: MatchReason;
    readonly missing: MatchReason;
  } }[] = [
    { bit: titleBit, codes: { match: 'title_match', conflict: 'title_conflict', missing: 'title_match' } },
    { bit: yearBit, codes: { match: 'year_match', conflict: 'year_conflict', missing: 'year_missing' } },
    {
      bit: seasonEpisodeBit,
      codes: {
        match: 'season_episode_match',
        conflict: 'season_episode_conflict',
        missing: 'season_episode_missing',
      },
    },
    {
      bit: languageBit,
      codes: { match: 'language_match', conflict: 'language_conflict', missing: 'language_missing' },
    },
    {
      bit: versionBit,
      codes: {
        match: 'version_label_match',
        conflict: 'version_label_conflict',
        missing: 'version_label_missing',
      },
    },
  ];

  // reasons 按枚举序收集 + 去重(位与码一一对应,集合去重为防御性保证)
  const collected = new Set<MatchReason>();
  for (const entry of bits) {
    const reason = reasonOfBit(entry.bit, entry.codes);
    if (reason !== null) collected.add(reason);
  }
  const reasons: readonly MatchReason[] = MATCH_REASON_ORDER.filter((reason) => collected.has(reason));

  const hasConflict = bits.some((entry) => entry.bit === 'conflict');
  const hasMissing = bits.some((entry) => entry.bit === 'missing');
  const confidence: MatchConfidence = hasConflict ? 'conflict' : hasMissing ? 'ambiguous' : 'high';

  return { confidence, reasons, matchRuleVersion: MATCH_RULE_VERSION };
}

/* ------------------------------------------------------------------ */
/* 候选身份键(下标无关的实例区分)                                        */
/* ------------------------------------------------------------------ */

/**
 * 候选稳定身份键:全部事实字段的确定性编码(含 upstreamVodId 实例身份)。
 * - 不含列表下标(FR-030「列表下标不构成充分匹配」/E 组)与 expiresAt(TTL 与身份
 *   分离,G 组)、不含规则版本(版本变不改变身份键,只作废旧结论,F 组)、不含 URL/
 *   采集时间(data-model §3);
 * - JSON 编码逐字段定序,同事实恒同键、异事实不碰撞(字符串字段经 JSON 转义,
 *   分隔符不进入键空间)。
 */
export function candidateIdentityKey(facts: CandidateFacts): string {
  return JSON.stringify([
    facts.upstreamVodId,
    facts.canonicalName,
    facts.year,
    facts.seasonKey,
    facts.episodeKey,
    facts.languageVersion,
    facts.knownVersionLabel,
  ]);
}

/* ------------------------------------------------------------------ */
/* 结论新鲜度/候选 TTL 把门(可验证面)                                    */
/* ------------------------------------------------------------------ */

/**
 * 匹配结论是否钉当前规则版本:仅 matchRuleVersion === MATCH_RULE_VERSION 为 true;
 * 否则必须经 matchCandidate 重评,不得沿用旧结论(F 组)。
 */
export function isMatchConclusionCurrent(conclusion: { readonly matchRuleVersion: string }): boolean {
  return conclusion.matchRuleVersion === MATCH_RULE_VERSION;
}

/**
 * 候选是否仍新鲜:nowMs < expiresAtMs → true;nowMs >= expiresAtMs 即过期(恰界失效)。
 * 过期候选不可再作为 api §5 的「可验证候选」(消费方映射引用失效语义)。
 */
export function isSwitchCandidateFresh(candidate: { readonly expiresAtMs: number }, nowMs: number): boolean {
  return nowMs < candidate.expiresAtMs;
}

/* ------------------------------------------------------------------ */
/* carry 授权象限(api §5 位置模式资格;授权面,不改写匹配事实)             */
/* ------------------------------------------------------------------ */

/** carry 位置资格:high 直接可 carry;ambiguous 确认解锁;conflict 确认也不解锁 */
export type CarryPositionEligibility =
  | { readonly allowed: true; readonly viaConfirmation: false }
  | { readonly allowed: true; readonly viaConfirmation: true }
  | { readonly allowed: false; readonly reason: 'ambiguous_needs_confirmation' }
  | { readonly allowed: false; readonly reason: 'conflict_forbidden' };

/**
 * carry 授权象限(api §5「high可carry,ambiguous需confirmed且具体集,conflict只
 * beginning/target_history且不能继承源位置」的规则面投影):
 * - high → 直接可 carry(与确认位无关——确认属 ambiguous 专属入口);
 * - ambiguous 且未确认 → 需确认;确认后解锁但事实仍 ambiguous(viaConfirmation=true,
 *   上报的 matchConfidence 不提升,D 组);
 * - conflict → 确认也不解锁(冲突只 beginning/target_history);
 * - 「具体集」锚定在候选映射/登记面验证(T072 消费),不在本函数。
 */
export function carryPositionEligibility(input: {
  readonly confidence: MatchConfidence;
  readonly confirmedAmbiguous: boolean;
}): CarryPositionEligibility {
  if (input.confidence === 'conflict') {
    return { allowed: false, reason: 'conflict_forbidden' };
  }
  if (input.confidence === 'ambiguous') {
    return input.confirmedAmbiguous
      ? { allowed: true, viaConfirmation: true }
      : { allowed: false, reason: 'ambiguous_needs_confirmation' };
  }
  return { allowed: true, viaConfirmation: false };
}
