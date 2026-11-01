import { describe, expect, it } from 'vitest';
import {
  MATCH_RULE_VERSION,
  SWITCH_CANDIDATE_TTL_MS,
  candidateIdentityKey,
  carryPositionEligibility,
  isMatchConclusionCurrent,
  isSwitchCandidateFresh,
  matchCandidate,
  type CandidateFacts,
  type MatchConclusion,
  type MatchConfidence,
  type MatchReason,
  type SourceTitleFacts,
} from '@contexts/online-vod/domain/source-match.rules';
import {
  createStandaloneMovieWorld,
  createThreeEpisodeSerialWorld,
  createVersionConflictWorld,
  FIXTURE_TITLE_KEYS,
  FIXTURE_UPSTREAM_FIXED_NOW_MS,
  type FixtureTitleWorld,
} from '../../fixtures/online-vod/fixture-upstream';

/**
 * 010 T068(测试先行,US4)—— 换源候选匹配契约钉面(计划内红,待 T070 转绿)→T070。
 *
 * ⚠️ 计划内红(文件顶部声明):被测模块由 T070 创建,当前不存在——
 *   `@contexts/online-vod/domain/source-match.rules`(匹配置信/规则版本/候选 TTL,纯领域,零依赖)。
 * 当前阶段预期(对齐 continuity-resume.spec.ts 的 T037 / episode-sequence.spec.ts 的 T053 先例):
 *   1. `pnpm --filter @hmp/server exec vitest run test/unit/online-vod/source-match.spec.ts`
 *      收集期失败(模块不存在);
 *   2. `pnpm --filter @hmp/server typecheck` 恰好新增一条 TS2307(上述模块),零其他错误;
 *   3. eslint 零错误。
 * 本文件即 T070 行为契约:实现须使本文件全绿,且只允许通过该模块导出面满足;
 * 纯函数、零网络、零时钟、零随机(与 continuity.rules 同惯例;本测试自身只用夹具固定时钟)。
 *
 * 被测范围(tasks.md T068 原文):「先新增 apps/server/test/unit/online-vod/source-match.spec.ts:
 * high/ambiguous/conflict、电影年/剧集年季集、版本语言冲突、缺字段降歧义、确认不提升冲突、
 * 不能按列表下标对应。」(依赖:T005, T025)
 *
 * 契约权威(实现侧不自创语义):
 * - spec.md FR-030(逐字):「匹配充分至少要求规范标题、电影年份或剧集年份/季/集一致且语言/版本
 *   无冲突;缺关键字段归歧义,明确不同版本归冲突。歧义需确认具体目标才能携带位置,冲突不允许
 *   携带,标题相同或列表下标不构成充分匹配。」
 * - spec.md FR-029(候选/测速只元数据、不暴露地址、未授权目标不得探测)、FR-031(carry 只取
 *   当前设备来源会话已接受样本与可信时长,不取客户端任意起点)。
 * - contracts/api.md §1 SwitchCandidate:「candidateRef,title,label,year:string|null,
 *   season:string|null,versionLabel:string|null,sourceLabel,lineLabel,
 *   matchConfidence:high|ambiguous|conflict,matchReasons:string[],previewRevision,expiresAt;
 *   source内部ID/位置不下发」;§5 候选语义:「同线/跨源候选只元数据,服务端从来源标题构造搜索,
 *   不接任意q/URL;failed可恢复来源仅60s」「target必须可验证候选;high可carry,ambiguous需
 *   confirmed且具体集,conflict只beginning/target_history且不能继承源位置」。
 * - data-model.md §3:「continuitySignature包含规范身份/已知年份季度语言版本/匹配规则版本,
 *   不含URL/采集时间,不是媒体hash;缺关键字段不自动制造"内容一致"的证据」;§7 intent 记录
 *   match_revision/confidence 与 confirmed_ambiguous——授权面消费匹配结论,不回写匹配等级。
 * - tasks.md T070 原文(实现目标):「实现"matchConfidence=high|ambiguous|conflict"及匹配规则
 *   版本/候选TTL;从已授权fromSession可信标题构造搜索,返回opaque具体集,不接受任意q/URL;
 *   可恢复failed仅60s」。
 * - T025 provider-model(已落地):ProviderTitleIdentity{upstreamVodId,name,year,version}——
 *   候选事实的解析形态;身份字符串 NFC+trim 由解析层保证,本规则面按精确字符串比较
 *   (对齐 episode-sequence「key 假定已 NFC+trim(§1 身份层职责)」惯例)。
 * - fixture-upstream 素材(T005,已落地):三集连续剧 1001(fixture·星尘信使 2024/S01/01–03/
 *   夹具语言/无版本标签)、版本冲突世界两端 1003(fixture·回声双城 2019 剧场版)与 2003
 *   (fixture·回声双城 2023 导演剪辑版,同名同检索词——US4 match_conflict 素材)、独立影片
 *   1004(fixture·静默哨站 2022,无版本标签)。
 *
 * 匹配面/授权面分离(D 组钉法):matchCandidate 只吃服务端事实(输入类型无 confirmedAmbiguous
 * 入口——类型面即钉面),产出事实性结论;用户确认只经 carryPositionEligibility 解锁 intent 提交
 * (api §5),从不改写 confidence/reasons——SwitchCandidate 与 IntentReply 上报的 matchConfidence
 * 恒为匹配事实等级。「服务端从已授权 fromSession 可信标题构造搜索、不接受任意 q/URL」在本钉面
 * 落为:匹配输入只有服务端事实字段,无 q/URL/客户端候选/列表下标字段(基线键集断言)。
 *
 * 建议导出面(T070 实现者照钉;本文件 import 面即契约,语义见判定表与各组):
 * domain/source-match.rules(纯领域,零 import,对齐 provider-model/continuity.rules 惯例;
 * 匹配判定不抛错——歧义/冲突就是正常结论,无 Error 子类):
 *   - const MATCH_RULE_VERSION: string
 *       // 匹配规则版本(data-model §3 continuitySignature.matchRuleVersion 同源语义);
 *       // 非空字符串,值由实现定,结论恒钉版(F 组)
 *   - const SWITCH_CANDIDATE_TTL_MS = 60_000
 *       // 候选 TTL:api §1 SwitchCandidate.expiresAt 载体 + T070 原文「可恢复failed仅60s」同族
 *   - type MatchConfidence = 'high' | 'ambiguous' | 'conflict'      // api §1 枚举,逐字
 *   - type MatchReason =
 *       | 'title_match' | 'title_conflict'
 *       | 'year_match' | 'year_conflict' | 'year_missing'
 *       | 'season_episode_match' | 'season_episode_conflict' | 'season_episode_missing'
 *       | 'language_match' | 'language_conflict' | 'language_missing'
 *       | 'version_label_match' | 'version_label_conflict' | 'version_label_missing'
 *       // api §1 matchReasons:string[] 的领域码集;固定按上述枚举序输出、去重
 *   - interface MatchFacts { canonicalName: string; year: string|null; seasonKey: string|null;
 *       episodeKey: string|null; languageVersion: string|null; knownVersionLabel: string|null }
 *       // 匹配语义面双侧同构;字段假定已经解析层 NFC+trim(T025 §1 身份层职责)
 *   - type SourceTitleFacts = MatchFacts
 *       // 来自已授权 fromSession 的服务端可信标题事实;类型面无 q/URL/客户端输入字段
 *   - interface CandidateFacts extends MatchFacts { upstreamVodId: string; expiresAtMs: number }
 *       // upstreamVodId=T025 ProviderTitleIdentity 投影(参与身份键,不参与语义比对);
 *       // expiresAtMs=候选 TTL(api §1);无 URL/locator/采集时间/列表下标字段(data-model §3)
 *   - interface MatchConclusion { confidence: MatchConfidence; reasons: readonly MatchReason[];
 *       matchRuleVersion: string }                                   // 结论恒钉 MATCH_RULE_VERSION
 *   - function matchCandidate(input: { sourceTitleFacts: SourceTitleFacts;
 *       candidateFacts: CandidateFacts }): MatchConclusion           // 纯函数,零时钟/网络/随机
 *   - function candidateIdentityKey(facts: CandidateFacts): string
 *       // 稳定身份键:全部事实字段的确定性编码;不含列表下标(E)/expiresAt(G)/规则版本(F)/
 *       // URL/采集时间(data-model §3);规则版本变不改变身份键,只作废旧结论
 *   - function isMatchConclusionCurrent(conclusion: { matchRuleVersion: string }): boolean
 *       // 仅 matchRuleVersion === MATCH_RULE_VERSION 为 true;否则必须经 matchCandidate 重评,
 *       // 不得沿用旧结论(F 组)
 *   - function isSwitchCandidateFresh(candidate: { expiresAtMs: number }, nowMs: number): boolean
 *       // nowMs < expiresAtMs → true;nowMs >= expiresAtMs 即过期(恰界失效),
 *       // 过期候选不可再作为 api §5 的「可验证候选」
 *   - type CarryPositionEligibility =
 *       | { allowed: true; viaConfirmation: false }      // high:直接可 carry
 *       | { allowed: true; viaConfirmation: true }       // ambiguous+confirmed:解锁,事实仍 ambiguous
 *       | { allowed: false; reason: 'ambiguous_needs_confirmation' }
 *       | { allowed: false; reason: 'conflict_forbidden' } // conflict:确认也不解锁
 *   - function carryPositionEligibility(input: { confidence: MatchConfidence;
 *       confirmedAmbiguous: boolean }): CarryPositionEligibility
 *       // api §5「high可carry,ambiguous需confirmed且具体集,conflict只beginning/target_history
 *       // 且不能继承源位置」的规则面投影;「具体集」锚定在候选映射/登记面验证(T072 消费)
 *
 * matchCandidate 判定表(逐字钉死;五个事实位独立评估,reasons 按枚举序全量报告):
 * | 事实位(双侧)      | 双方已知且相等       | 双方已知不等           | 任一侧缺失(null)      |
 * | canonicalName     | title_match          | title_conflict         | (输入前提:恒非空)     |
 * | year              | year_match           | year_conflict          | year_missing          |
 * | seasonKey+episodeKey | season_episode_match | season_episode_conflict | season_episode_missing |
 * | languageVersion   | language_match       | language_conflict      | language_missing      |
 * | knownVersionLabel | version_label_match  | version_label_conflict | version_label_missing |
 *   - season/episode 事实位仅在任一侧声明结构(season 或 episode 非 null)时评估;双侧均 null
 *     (电影形态)→ 该位沉默,不出任何 reason。
 *   - 语言/版本双侧均 null(均未声明区分,如基础剧集无版本标签)→ 该位沉默:无版本区分,
 *     亦无冲突证据,不阻断 high。
 *   - confidence 位序:任一 *_conflict → 'conflict';否则任一 *_missing → 'ambiguous';
 *     否则 'high'(high 需 title/year/结构位齐备——缺位已被 missing 分支拦截)。
 *   钉法依据与被显式排除的对照读法:
 *   - 「缺字段降歧义」覆盖 year/season/episode(FR-030 关键字段)以及语言/版本一侧未知
 *     (data-model §3「缺关键字段不自动制造『内容一致』的证据」:语言/版本是一致性证据的组成位,
 *     一侧未知时无法建立「无冲突」,保守归歧义,由用户确认解锁 carry);对照读法「未知=无已知
 *     冲突即可 high」被本钉面排除。
 *   - 「明确不同归冲突」覆盖年/季集/语言/版本标签的显式不等(含同名不同年——夹具版本冲突世界
 *     1003/2003 素材;含同题明确不同集——矛盾事实,确认无法修正,故 D 组钉死确认不改 conflict)。
 *   - 匹配面零时钟:matchCandidate 对过期候选照常给出语义结论;过期把门在
 *     isSwitchCandidateFresh(可验证面),不混入 confidence(G 组)。
 *
 * 用例↔契约映射:基线=夹具素材锁面+事实类型键集(api §5 服务端事实输入/data-model §3 无 URL)+
 * 纯函数确定性;A high=FR-030 充分集(电影年/剧集年季集,语言版本无冲突)+T070「matchConfidence
 * =high」;B ambiguous=FR-030「缺关键字段归歧义」+T068「缺字段降歧义,不猜 high」;C conflict=
 * FR-030「明确不同版本归冲突」+T068「版本语言冲突」+夹具版本冲突世界 1003/2003;D 确认不提升=
 * api §5「ambiguous需confirmed且具体集,conflict…不能继承源位置」的匹配面/授权面分离(data-model
 * §7 confirmed_ambiguous 属 intent 面);E 下标无关=FR-030「标题相同或列表下标不构成充分匹配」+
 * T070「opaque 具体集」按身份键区分;F 规则版本=data-model §3「匹配规则版本」+T070「匹配规则
 * 版本」;G 候选 TTL=api §1 SwitchCandidate.expiresAt+T070「候选TTL/可恢复failed仅60s」。
 */

/* ------------------------------------------------------------------ */
/* 夹具世界与输入素材(纯构造,零网络)                                    */
/* ------------------------------------------------------------------ */

const VOD_ORIGIN = 'http://127.0.0.1:18081';

/** 世界一:三集连续剧(星尘信使 2024,S01 EP01–03,夹具语言,无版本标签) */
const serialWorld = createThreeEpisodeSerialWorld(VOD_ORIGIN);
/** 世界三两端:同名版本冲突(2019 剧场版 upstreamVodId=1003 / 2023 导演剪辑版 upstreamVodId=2003) */
const theatricalWorld = createVersionConflictWorld(VOD_ORIGIN, 'theatrical');
const directorsCutWorld = createVersionConflictWorld(VOD_ORIGIN, 'directors-cut');
/** 独立影片:静默哨站 2022(完全不同标题的对照素材) */
const standaloneWorld = createStandaloneMovieWorld(VOD_ORIGIN);

/** 剧集 high 基线 reason 序(枚举序;版本位双侧均 null → 沉默) */
const SERIAL_HIGH_REASONS: readonly MatchReason[] = [
  'title_match',
  'year_match',
  'season_episode_match',
  'language_match',
];
/** 电影 high 基线 reason 序(剧场版双侧同标签;结构位双侧均 null → 沉默) */
const MOVIE_HIGH_REASONS: readonly MatchReason[] = [
  'title_match',
  'year_match',
  'language_match',
  'version_label_match',
];

/** noUncheckedIndexedAccess 下取列表项(缺项即测试失败) */
function requireAt<T>(items: readonly T[], index: number): T {
  const item = items[index];
  if (item === undefined) {
    throw new Error(`缺列表项 index=${index}`);
  }
  return item;
}

/** 结论三面断言:置信等级、reasons 全量(枚举序)、结论钉当前规则版本(F 组全局锚) */
function expectConclusion(
  conclusion: MatchConclusion,
  confidence: MatchConfidence,
  reasons: readonly MatchReason[],
): void {
  expect(conclusion.confidence).toBe(confidence);
  expect(conclusion.reasons).toEqual(reasons);
  expect(conclusion.matchRuleVersion).toBe(MATCH_RULE_VERSION);
}

/* ------------------------------------------------------------------ */
/* 匹配事实构造(默认=剧集基线;全部为服务端事实形态,零客户端输入)        */
/* ------------------------------------------------------------------ */

/** 默认源事实:已授权 fromSession 正播世界一 EP02(服务端可信标题;无任何 q/URL/下标字段) */
function sourceFacts(overrides: Partial<SourceTitleFacts> = {}): SourceTitleFacts {
  return {
    canonicalName: 'fixture·星尘信使',
    year: '2024',
    seasonKey: 'S01',
    episodeKey: '02',
    languageVersion: '夹具语言',
    knownVersionLabel: null,
    ...overrides,
  };
}

/** 默认候选事实:另一来源(91001)的同剧同集——跨源实例,身份键区分实例、匹配走语义面 */
function candidateFacts(overrides: Partial<CandidateFacts> = {}): CandidateFacts {
  return {
    upstreamVodId: '91001',
    canonicalName: 'fixture·星尘信使',
    year: '2024',
    seasonKey: 'S01',
    episodeKey: '02',
    languageVersion: '夹具语言',
    knownVersionLabel: null,
    expiresAtMs: FIXTURE_UPSTREAM_FIXED_NOW_MS + SWITCH_CANDIDATE_TTL_MS,
    ...overrides,
  };
}

/** 电影源事实(取自夹具世界种子):电影形态=无季集结构声明 */
function movieSourceFacts(world: FixtureTitleWorld): SourceTitleFacts {
  return {
    canonicalName: world.seed.name,
    year: world.seed.year ?? null,
    seasonKey: null,
    episodeKey: null,
    languageVersion: world.seed.lang ?? null,
    knownVersionLabel: world.seed.versionLabel ?? null,
  };
}

/** 电影候选事实(另一来源实例;upstreamVodId 由调用方给,模拟跨源同片) */
function candidateFactsFromWorld(world: FixtureTitleWorld, upstreamVodId: string): CandidateFacts {
  return candidateFacts({
    upstreamVodId,
    canonicalName: world.seed.name,
    year: world.seed.year ?? null,
    seasonKey: null,
    episodeKey: null,
    languageVersion: world.seed.lang ?? null,
    knownVersionLabel: world.seed.versionLabel ?? null,
  });
}

/* ------------------------------------------------------------------ */
/* 基线:夹具素材锁面、事实类型键集与纯函数确定性                         */
/* ------------------------------------------------------------------ */

describe('基线:夹具素材锁面、匹配输入类型面与纯函数确定性', () => {
  it('素材锁面:三集连续剧 1001/版本冲突两端 1003+2003/独立影片 1004 种子事实与夹具固定时钟(T005 已落地)', () => {
    expect(serialWorld.titleKey).toBe(FIXTURE_TITLE_KEYS.threeEpisodeSerial);
    expect(serialWorld.seed).toMatchObject({ upstreamVodId: 1001, name: 'fixture·星尘信使', year: '2024', lang: '夹具语言' });
    expect(serialWorld.seed.versionLabel).toBeUndefined();
    expect(theatricalWorld.titleKey).toBe(FIXTURE_TITLE_KEYS.echoTheatrical);
    expect(theatricalWorld.seed).toMatchObject({
      upstreamVodId: 1003,
      name: 'fixture·回声双城',
      year: '2019',
      versionLabel: '剧场版',
      lang: '夹具语言',
    });
    expect(directorsCutWorld.titleKey).toBe(FIXTURE_TITLE_KEYS.echoDirectorsCut);
    expect(directorsCutWorld.seed).toMatchObject({
      upstreamVodId: 2003,
      name: 'fixture·回声双城',
      year: '2023',
      versionLabel: '导演剪辑版',
      lang: '夹具语言',
    });
    expect(standaloneWorld.seed).toMatchObject({ upstreamVodId: 1004, name: 'fixture·静默哨站', year: '2022' });
    expect(FIXTURE_UPSTREAM_FIXED_NOW_MS).toBe(Date.UTC(2026, 0, 1));
  });

  it('类型面键集:匹配事实只有服务端事实字段——无 q/URL/下标/confirmedAmbiguous/采集时间(api §5+data-model §3)', () => {
    expect(Object.keys(sourceFacts()).sort()).toEqual([
      'canonicalName',
      'episodeKey',
      'knownVersionLabel',
      'languageVersion',
      'seasonKey',
      'year',
    ]);
    expect(Object.keys(candidateFacts()).sort()).toEqual([
      'canonicalName',
      'episodeKey',
      'expiresAtMs',
      'knownVersionLabel',
      'languageVersion',
      'seasonKey',
      'upstreamVodId',
      'year',
    ]);
  });

  it('纯函数确定性:同输入重复求值结论逐字段相等(零时钟/零随机)', () => {
    const input = { sourceTitleFacts: sourceFacts(), candidateFacts: candidateFacts() };
    expect(matchCandidate(input)).toEqual(matchCandidate(input));
  });
});

/* ------------------------------------------------------------------ */
/* A. high:同名+同年(电影)/同题+同年同季同集(剧集)+语言版本无冲突        */
/* ------------------------------------------------------------------ */

describe('A. high:FR-030 充分集齐备(规范标题+电影年 或 剧集年/季/集,语言版本无冲突)→ high', () => {
  it('电影:同名+同年+同语言+同版本标签(回声双城 2019 剧场版跨源实例)→ high,结构位沉默', () => {
    expectConclusion(
      matchCandidate({
        sourceTitleFacts: movieSourceFacts(theatricalWorld),
        candidateFacts: candidateFactsFromWorld(theatricalWorld, '91003'),
      }),
      'high',
      MOVIE_HIGH_REASONS,
    );
  });

  it('剧集:同题+同年+同季+同集(星尘信使 S01 EP02)+同语言,版本位双侧均 null 沉默 → high', () => {
    expectConclusion(
      matchCandidate({ sourceTitleFacts: sourceFacts(), candidateFacts: candidateFacts() }),
      'high',
      SERIAL_HIGH_REASONS,
    );
  });

  it('跨源实例语义等价:同事实不同 upstreamVodId 均为 high(身份键只区分实例,置信走语义面)', () => {
    const first = candidateFacts({ upstreamVodId: '91001' });
    const second = candidateFacts({ upstreamVodId: '92001' });
    expect(candidateIdentityKey(first)).not.toBe(candidateIdentityKey(second));
    expectConclusion(
      matchCandidate({ sourceTitleFacts: sourceFacts(), candidateFacts: second }),
      'high',
      SERIAL_HIGH_REASONS,
    );
    expect(matchCandidate({ sourceTitleFacts: sourceFacts(), candidateFacts: first })).toEqual(
      matchCandidate({ sourceTitleFacts: sourceFacts(), candidateFacts: second }),
    );
  });
});

/* ------------------------------------------------------------------ */
/* B. ambiguous:缺字段降歧义(缺年/缺季集/语言或版本一侧未知),不猜 high   */
/* ------------------------------------------------------------------ */

describe('B. ambiguous:FR-030「缺关键字段归歧义」——缺字段降歧义,不猜 high,也不虚构 conflict', () => {
  it('候选缺年(上游未给 vod_year,T025 投影 null)→ ambiguous:year_missing,不猜 high', () => {
    expectConclusion(
      matchCandidate({ sourceTitleFacts: sourceFacts(), candidateFacts: candidateFacts({ year: null }) }),
      'ambiguous',
      ['title_match', 'year_missing', 'season_episode_match', 'language_match'],
    );
  });

  it('源侧缺年同样降歧义:缺字段在任一侧即无法建立「年份一致」', () => {
    expectConclusion(
      matchCandidate({ sourceTitleFacts: sourceFacts({ year: null }), candidateFacts: candidateFacts() }),
      'ambiguous',
      ['title_match', 'year_missing', 'season_episode_match', 'language_match'],
    );
  });

  it('剧集缺集或缺季(服务端未锚定具体集)→ ambiguous:season_episode_missing', () => {
    expectConclusion(
      matchCandidate({ sourceTitleFacts: sourceFacts(), candidateFacts: candidateFacts({ episodeKey: null }) }),
      'ambiguous',
      ['title_match', 'year_match', 'season_episode_missing', 'language_match'],
    );
    expectConclusion(
      matchCandidate({ sourceTitleFacts: sourceFacts(), candidateFacts: candidateFacts({ seasonKey: null }) }),
      'ambiguous',
      ['title_match', 'year_match', 'season_episode_missing', 'language_match'],
    );
  });

  it('候选完全未锚定季集(无具体集形态)→ ambiguous:confirmedAmbiguous 需「具体集」才有意义', () => {
    expectConclusion(
      matchCandidate({
        sourceTitleFacts: sourceFacts(),
        candidateFacts: candidateFacts({ seasonKey: null, episodeKey: null }),
      }),
      'ambiguous',
      ['title_match', 'year_match', 'season_episode_missing', 'language_match'],
    );
  });

  it('语言一侧未知(候选未给 vod_lang)→ ambiguous:language_missing(无法建立「无冲突」,不自动制造内容一致)', () => {
    expectConclusion(
      matchCandidate({
        sourceTitleFacts: sourceFacts(),
        candidateFacts: candidateFacts({ languageVersion: null }),
      }),
      'ambiguous',
      ['title_match', 'year_match', 'season_episode_match', 'language_missing'],
    );
  });

  it('版本标签一侧未知(源剧场版 vs 候选未标注)→ ambiguous:version_label_missing(不排除同片也不放行为 high)', () => {
    // 对照:版本标签双侧同为「剧场版」→ high(见 A 组);候选一侧未标注即无法建立「无版本冲突」
    expectConclusion(
      matchCandidate({
        sourceTitleFacts: movieSourceFacts(theatricalWorld),
        candidateFacts: candidateFactsFromWorld(theatricalWorld, '91003'),
      }),
      'high',
      MOVIE_HIGH_REASONS,
    );
    expectConclusion(
      matchCandidate({
        sourceTitleFacts: movieSourceFacts(theatricalWorld),
        candidateFacts: { ...candidateFactsFromWorld(theatricalWorld, '91003'), knownVersionLabel: null },
      }),
      'ambiguous',
      ['title_match', 'year_match', 'language_match', 'version_label_missing'],
    );
  });

  it('多字段齐缺(缺年+缺集+缺语言)全量报告仍只 ambiguous:缺 ≠ 明确不同,不猜也不升级 conflict', () => {
    expectConclusion(
      matchCandidate({
        sourceTitleFacts: sourceFacts(),
        candidateFacts: candidateFacts({ year: null, episodeKey: null, languageVersion: null }),
      }),
      'ambiguous',
      ['title_match', 'year_missing', 'season_episode_missing', 'language_missing'],
    );
  });

  it('结构声明不对称:电影源 vs 剧集形态候选(候选声明 S01/02)→ ambiguous:不猜电影等价某集', () => {
    expectConclusion(
      matchCandidate({
        sourceTitleFacts: movieSourceFacts(theatricalWorld),
        candidateFacts: {
          ...candidateFactsFromWorld(theatricalWorld, '91003'),
          seasonKey: 'S01',
          episodeKey: '02',
        },
      }),
      'ambiguous',
      ['title_match', 'year_match', 'season_episode_missing', 'language_match', 'version_label_match'],
    );
  });
});

/* ------------------------------------------------------------------ */
/* C. conflict:同名不同年/版本标签冲突/语言冲突/明确不同季集/不同标题     */
/* ------------------------------------------------------------------ */

describe('C. conflict:FR-030「明确不同版本归冲突」——版本语言冲突是事实矛盾,确认无法修正', () => {
  it('同名不同年(夹具版本冲突世界:2019 剧场版 1003 vs 2023 导演剪辑版 2003)→ conflict', () => {
    expectConclusion(
      matchCandidate({
        sourceTitleFacts: movieSourceFacts(theatricalWorld),
        candidateFacts: candidateFactsFromWorld(directorsCutWorld, '92003'),
      }),
      'conflict',
      ['title_match', 'year_conflict', 'language_match', 'version_label_conflict'],
    );
  });

  it('同年不同版本标签(2019 剧场版 vs 2019 导演剪辑版组合素材)→ conflict:version_label_conflict', () => {
    expectConclusion(
      matchCandidate({
        sourceTitleFacts: movieSourceFacts(theatricalWorld),
        candidateFacts: candidateFacts({
          upstreamVodId: '92003',
          canonicalName: 'fixture·回声双城',
          year: '2019',
          languageVersion: '夹具语言',
          knownVersionLabel: '导演剪辑版',
        }),
      }),
      'conflict',
      ['title_match', 'year_match', 'language_match', 'version_label_conflict'],
    );
  });

  it('语言冲突(夹具语言 vs 英语配音版)→ conflict:language_conflict(FR-030「语言/版本无冲突」破缺)', () => {
    expectConclusion(
      matchCandidate({
        sourceTitleFacts: sourceFacts(),
        candidateFacts: candidateFacts({ languageVersion: '英语配音版' }),
      }),
      'conflict',
      ['title_match', 'year_match', 'season_episode_match', 'language_conflict'],
    );
  });

  it('剧集明确不同集/不同季(S01E02 vs S01E03、S01E02 vs S02E01)→ conflict:矛盾事实,不归歧义', () => {
    expectConclusion(
      matchCandidate({
        sourceTitleFacts: sourceFacts(),
        candidateFacts: candidateFacts({ upstreamVodId: '93001', episodeKey: '03' }),
      }),
      'conflict',
      ['title_match', 'year_match', 'season_episode_conflict', 'language_match'],
    );
    expectConclusion(
      matchCandidate({
        sourceTitleFacts: sourceFacts(),
        candidateFacts: candidateFacts({ upstreamVodId: '93001', seasonKey: 'S02', episodeKey: '01' }),
      }),
      'conflict',
      ['title_match', 'year_match', 'season_episode_conflict', 'language_match'],
    );
  });

  it('完全不同标题(静默哨站 vs 回声双城)→ conflict;且 conflict 位序高于 missing(冲突吞并版本未知)', () => {
    expectConclusion(
      matchCandidate({
        sourceTitleFacts: movieSourceFacts(theatricalWorld),
        candidateFacts: candidateFactsFromWorld(standaloneWorld, '94004'),
      }),
      'conflict',
      ['title_conflict', 'year_conflict', 'language_match', 'version_label_missing'],
    );
  });
});

/* ------------------------------------------------------------------ */
/* D. 确认不提升:匹配面与授权面分离(确认只解锁 intent 提交)              */
/* ------------------------------------------------------------------ */

describe('D. 确认不提升:confirmedAmbiguous 属授权面(data-model §7 intent 面),不改写匹配事实等级', () => {
  it('匹配面无确认入口:ambiguous 结论「确认前/确认后」重算逐字段不变(类型面无 confirmedAmbiguous 字段)', () => {
    const input = { sourceTitleFacts: sourceFacts(), candidateFacts: candidateFacts({ episodeKey: null }) };
    const before = matchCandidate(input);
    expectConclusion(before, 'ambiguous', ['title_match', 'year_match', 'season_episode_missing', 'language_match']);
    // 用户确认后再次求值:输入不含确认位、事实不变 → 结论不变;上报 IntentReply 的
    // matchConfidence 仍是 ambiguous(确认只解锁 intent 提交,匹配面与授权面分离)
    const after = matchCandidate(input);
    expect(after).toEqual(before);
    expect(after.confidence).toBe('ambiguous');
  });

  it('carry 授权象限:high 直接可 carry;ambiguous 未确认需确认;确认后解锁但事实仍 ambiguous;conflict 确认也不解锁(api §5)', () => {
    expect(carryPositionEligibility({ confidence: 'high', confirmedAmbiguous: false })).toEqual({
      allowed: true,
      viaConfirmation: false,
    });
    expect(carryPositionEligibility({ confidence: 'high', confirmedAmbiguous: true })).toEqual({
      allowed: true,
      viaConfirmation: false,
    });
    expect(carryPositionEligibility({ confidence: 'ambiguous', confirmedAmbiguous: false })).toEqual({
      allowed: false,
      reason: 'ambiguous_needs_confirmation',
    });
    expect(carryPositionEligibility({ confidence: 'ambiguous', confirmedAmbiguous: true })).toEqual({
      allowed: true,
      viaConfirmation: true,
    });
  });

  it('确认不提升冲突:conflict 候选即使 confirmedAmbiguous=true 仍不可 carry(冲突只 beginning/target_history)', () => {
    const conflictConclusion = matchCandidate({
      sourceTitleFacts: movieSourceFacts(theatricalWorld),
      candidateFacts: candidateFactsFromWorld(directorsCutWorld, '92003'),
    });
    expect(conflictConclusion.confidence).toBe('conflict');
    expect(carryPositionEligibility({ confidence: conflictConclusion.confidence, confirmedAmbiguous: true })).toEqual({
      allowed: false,
      reason: 'conflict_forbidden',
    });
    expect(carryPositionEligibility({ confidence: 'conflict', confirmedAmbiguous: false })).toEqual({
      allowed: false,
      reason: 'conflict_forbidden',
    });
  });
});

/* ------------------------------------------------------------------ */
/* E. 不能按列表下标对应:同列表同名候选按身份键区分,与顺序无关            */
/* ------------------------------------------------------------------ */

describe('E. 下标无关:FR-030「标题相同或列表下标不构成充分匹配」——候选按身份键区分', () => {
  /** 版本冲突世界候选列表素材:同名「回声双城」两实例(剧场版/导演剪辑版) */
  const sourceMovie = movieSourceFacts(theatricalWorld);
  const theatricalCandidate = candidateFactsFromWorld(theatricalWorld, '91003');
  const directorsCutCandidate = candidateFactsFromWorld(directorsCutWorld, '92003');
  const keyTheatrical = candidateIdentityKey(theatricalCandidate);
  const keyDirectorsCut = candidateIdentityKey(directorsCutCandidate);

  it('同名候选身份键不同:同列表两个「回声双城」按事实身份区分,不靠名称或位置', () => {
    expect(keyTheatrical).not.toBe(keyDirectorsCut);
    expect(candidateIdentityKey(directorsCutCandidate)).toBe(candidateIdentityKey(directorsCutCandidate));
  });

  it('任意排列下按身份键的结论恒定(剧场版→high,导演剪辑版→conflict);下标 0 结论随排列翻转 → 匹配不按下标', () => {
    const permutations: readonly (readonly CandidateFacts[])[] = [
      [directorsCutCandidate, theatricalCandidate],
      [theatricalCandidate, directorsCutCandidate],
    ];
    const conclusionsByKey = permutations.map((list) => {
      const byKey = new Map<string, MatchConfidence>();
      for (const candidate of list) {
        byKey.set(
          candidateIdentityKey(candidate),
          matchCandidate({ sourceTitleFacts: sourceMovie, candidateFacts: candidate }).confidence,
        );
      }
      return byKey;
    });
    for (const byKey of conclusionsByKey) {
      expect(byKey.get(keyTheatrical)).toBe('high');
      expect(byKey.get(keyDirectorsCut)).toBe('conflict');
    }
    // 下标视角不可能稳定:同一 index=0 在两种排列下置信相反,而身份键结论不变
    const firstConfidences = permutations.map(
      (list) => matchCandidate({ sourceTitleFacts: sourceMovie, candidateFacts: requireAt(list, 0) }).confidence,
    );
    expect(requireAt(firstConfidences, 0)).toBe('conflict');
    expect(requireAt(firstConfidences, 1)).toBe('high');
  });

  it('重复候选:同一事实出现两次 → 同键同结论(按身份键去重,不按 index 造新身份);标题相同本身不构成 high', () => {
    const duplicated: readonly CandidateFacts[] = [theatricalCandidate, theatricalCandidate];
    expect(candidateIdentityKey(requireAt(duplicated, 0))).toBe(candidateIdentityKey(requireAt(duplicated, 1)));
    expect(matchCandidate({ sourceTitleFacts: sourceMovie, candidateFacts: requireAt(duplicated, 0) })).toEqual(
      matchCandidate({ sourceTitleFacts: sourceMovie, candidateFacts: requireAt(duplicated, 1) }),
    );
    expect(new Set(duplicated.map((candidate) => candidateIdentityKey(candidate))).size).toBe(1);
    // 标题相同 ≠ 充分:导演剪辑版与源同名仍 conflict(FR-030 前半句),故同名列表必须按身份键逐项判定
    expect(
      matchCandidate({ sourceTitleFacts: sourceMovie, candidateFacts: directorsCutCandidate }).confidence,
    ).toBe('conflict');
  });
});

/* ------------------------------------------------------------------ */
/* F. 规则版本:matchRuleVersion 纳入结论比对,版本变 → 重评不沿用旧结论    */
/* ------------------------------------------------------------------ */

describe('F. 规则版本:data-model §3「匹配规则版本」——结论钉版,异版结论必须重评', () => {
  it('结论恒钉当前 MATCH_RULE_VERSION(非空字符串;A–C 各组结论已由 expectConclusion 全局校验)', () => {
    expect(typeof MATCH_RULE_VERSION).toBe('string');
    expect(MATCH_RULE_VERSION.length).toBeGreaterThan(0);
    expect(
      matchCandidate({ sourceTitleFacts: sourceFacts(), candidateFacts: candidateFacts() }).matchRuleVersion,
    ).toBe(MATCH_RULE_VERSION);
  });

  it('isMatchConclusionCurrent 只认当前版:当前版 true;异版/空版 false → 旧结论不得沿用', () => {
    expect(isMatchConclusionCurrent({ matchRuleVersion: MATCH_RULE_VERSION })).toBe(true);
    expect(isMatchConclusionCurrent({ matchRuleVersion: 'online-vod-source-match-v0' })).toBe(false);
    expect(isMatchConclusionCurrent({ matchRuleVersion: '' })).toBe(false);
  });

  it('版本变 → 重评不沿用旧结论:同身份候选的异版 high 结论作废,当前规则重评为 conflict(身份键不含规则版本,键稳定)', () => {
    const staleConclusion: MatchConclusion = {
      confidence: 'high',
      reasons: ['title_match', 'year_match', 'language_match', 'version_label_match'],
      matchRuleVersion: 'online-vod-source-match-v0',
    };
    expect(isMatchConclusionCurrent(staleConclusion)).toBe(false);
    // 同一身份键的候选在当前规则下重评:版本冲突世界素材判 conflict,异版旧 high 不被沿用
    const fresh = matchCandidate({
      sourceTitleFacts: movieSourceFacts(theatricalWorld),
      candidateFacts: candidateFactsFromWorld(directorsCutWorld, '92003'),
    });
    expect(isMatchConclusionCurrent(fresh)).toBe(true);
    expect(fresh.confidence).toBe('conflict');
    expect(fresh.confidence).not.toBe(staleConclusion.confidence);
  });
});

/* ------------------------------------------------------------------ */
/* G. 候选 TTL:候选事实带 expiresAt;过期由新鲜度把门,不混入匹配语义      */
/* ------------------------------------------------------------------ */

describe('G. 候选 TTL:api §1 SwitchCandidate.expiresAt + T070「候选TTL/可恢复failed仅60s」', () => {
  it('候选 TTL 常量 60s(与 T070「可恢复failed仅60s」同族;载体为候选事实 expiresAtMs)', () => {
    expect(SWITCH_CANDIDATE_TTL_MS).toBe(60_000);
  });

  it('新鲜度边界:now < expiresAt 新鲜;恰界即过期(到期候选不可再作为可验证目标)', () => {
    const expiresAtMs = FIXTURE_UPSTREAM_FIXED_NOW_MS + SWITCH_CANDIDATE_TTL_MS;
    expect(isSwitchCandidateFresh({ expiresAtMs }, FIXTURE_UPSTREAM_FIXED_NOW_MS)).toBe(true);
    expect(isSwitchCandidateFresh({ expiresAtMs }, expiresAtMs - 1)).toBe(true);
    expect(isSwitchCandidateFresh({ expiresAtMs }, expiresAtMs)).toBe(false);
    expect(isSwitchCandidateFresh({ expiresAtMs }, expiresAtMs + 1)).toBe(false);
  });

  it('TTL 与身份/语义分离:expiresAt 不进身份键、不影响置信结论;过期仅由新鲜度在可验证面把门', () => {
    const fresh = candidateFacts();
    const expired = candidateFacts({ expiresAtMs: FIXTURE_UPSTREAM_FIXED_NOW_MS - 1 });
    expect(candidateIdentityKey(expired)).toBe(candidateIdentityKey(fresh));
    expect(matchCandidate({ sourceTitleFacts: sourceFacts(), candidateFacts: expired })).toEqual(
      matchCandidate({ sourceTitleFacts: sourceFacts(), candidateFacts: fresh }),
    );
    expect(isSwitchCandidateFresh(expired, FIXTURE_UPSTREAM_FIXED_NOW_MS)).toBe(false);
    expect(isSwitchCandidateFresh(fresh, FIXTURE_UPSTREAM_FIXED_NOW_MS)).toBe(true);
  });
});
