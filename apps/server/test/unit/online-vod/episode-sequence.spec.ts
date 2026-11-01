import { describe, expect, it } from 'vitest';
import {
  buildSequence,
  computeLineNext,
  computeNextEpisode,
  type NextEpisodeBlockReason,
  type NextEpisodeOutcome,
  type SequenceEpisodeInput,
  type SequenceEpisodeRow,
  type SequenceFacts,
  type SequenceLineFacts,
  type SequenceLineInput,
  type SequenceStatus,
} from '@contexts/online-vod/domain/episode-sequence.rules';
import {
  createFixtureTitleWorld,
  createGappedDuplicateWorld,
  createStandardEpisodePresentation,
  createThreeEpisodeSerialWorld,
  createVersionConflictWorld,
  FIXTURE_TITLE_KEYS,
  type FixtureTitleWorld,
} from '../../fixtures/online-vod/fixture-upstream';

/**
 * 010 T053(测试先行,US3)—— 独立导航序列契约钉面(计划内红,待 T055 转绿)。
 *
 * ⚠️ 计划内红(文件顶部声明):被测模块由 T055 创建,当前不存在——
 *   `@contexts/online-vod/domain/episode-sequence.rules`(序列构建/同线 N+1 导航,纯领域,零依赖)。
 * 当前阶段预期(对齐 continuity-resume.spec.ts 的 T037 先例):
 *   1. `pnpm --filter @hmp/server exec vitest run test/unit/online-vod/episode-sequence.spec.ts`
 *      收集期失败(模块不存在);
 *   2. `pnpm --filter @hmp/server typecheck` 恰好新增一条 TS2307(上述模块),零其他错误;
 *   3. eslint 零错误。
 * 本文件即 T055 行为契约:实现须使本文件全绿,且只允许通过该模块导出面满足;
 * 纯函数、零网络、零时钟、零随机(与 continuity.rules 同惯例)。
 *
 * 被测范围(tasks.md T053 原文):「先新增 apps/server/test/unit/online-vod/episode-sequence.spec.ts
 * …覆盖同线明确N+1/缺集/重复/季界/special」(依赖:T005, T039)。
 *
 * 契约权威(实现侧不自创语义):
 * - data-model.md §2 vod_episode_sequence 行:「状态ordered/ambiguous/special;导航与身份分开;
 *   只同线明确N+1,缺集/重复/季边界不能跳」;vod_line 行:「(title_id,line_key)唯一;
 *   重复/空key详情显示unsupported」;vod_episode 行:「(line_id,episode_key)…唯一」。
 * - data-model.md §3:「sequenceRevision为同标题/线路导航快照版本(>=1),仅成员/顺序/年季/
 *   常规集资格变化时递增,与引用的detailRevision一同发布…next计划固定两者」。
 * - tasks.md T055 原文:「发布独立导航序列,"状态ordered/ambiguous/special";只同源同线常规N+1,
 *   不改稳定标签身份,不因特殊集/空/重复编号猜下一集」。
 * - spec.md FR-025:「仅对同源同线路明确连续的下一常规集生效。编号缺失/重复、季边界、花絮或
 *   影片末尾停止,不能自动跨来源或跨电影」;US3 验收场景 2:「下一集…缺失、重复编号、季边界
 *   或无法确定…停止自动前进并提示手动选择,不跳过限制也不自动跨来源」。
 * - contracts/api.md:VodPreview 集状态 candidate|unsupported(reason null|identity_ambiguous|
 *   format_unsupported)——重复集键的详情呈现形态;StableEpisodes.sequenceOrdinal。
 *
 * 缺集钉法(B 组,保守读法,逐字钉死):当前集 ordinal+1 缺位、但线内存在更大 ordinal 时,
 * computeNextEpisode → { status:'ambiguous', next:null, reason:'missing_ordinal' }——
 * 「缺集不能跳」:既不猜 03,也不跳到 04;01/02/04 世界中 02 之后的自动连播停止,提示手动选择。
 * 依据:data-model §2「缺集…不能跳」+ FR-025「编号缺失…停止」+ US3 场景 2。
 * (对照读法「next=04」被本钉面显式排除。)
 *
 * 季界钉法(D 组):season_key 只是序列行的记录字段(「导航与身份分开」),年季变化不阻断
 * 同线明确 N+1——S01 末集(ordinal N)→ S02 首集(ordinal N+1)仍 { status:'ordered' }。
 * FR-025「季边界停止」在本规则面落为:跨线的季界不导航(F 组/ D 组跨线用例)——
 * 「只同源同线常规N+1」(T055)+「不能自动跨来源或跨电影」;季界处不满足同线明确 N+1 时
 * 按 B 组缺集/端点语义停止。
 *
 * 建议导出面(T055 实现者照钉;本文件 import 面即契约,语义见各表):
 *   - type SequenceStatus = 'ordered' | 'ambiguous' | 'special'      // data-model §2 三值
 *   - interface SequenceEpisodeInput { episodeKey: string; mediaId: string | null;
 *       seasonKey: string | null; ordinal: number | null; special: boolean }
 *       // special=上游/adapter 判定的非常规集(特典/花絮/正片电影);key 假定已 NFC+trim(§1 身份层职责)
 *   - interface SequenceLineInput { lineKey: string; displayName: string; sortOrder: number;
 *       episodes: readonly SequenceEpisodeInput[] }
 *   - interface SequenceEpisodeRow { lineKey; episodeKey; mediaId: string | null;
 *       seasonKey: string | null; ordinal: number | null; sequenceStatus: SequenceStatus }
 *   - interface SequenceLineFacts { lineKey; displayName; sortOrder;
 *       navigable: boolean;                                    // 本标题内 lineKey 首次出现且非空
 *       unsupportedReason: 'duplicate_line_key' | 'empty_line_key' | null;
 *       episodes: readonly SequenceEpisodeRow[] }
 *   - interface SequenceFacts { sourceId: string; titleId: string;
 *       detailRevision: number; sequenceRevision: number;      // §3 next 计划固定两者
 *       lines: readonly SequenceLineFacts[] }
 *   - function buildSequence(input: { sourceId; titleId; detailRevision; sequenceRevision;
 *       lines: readonly SequenceLineInput[] }): SequenceFacts
 *   - type NextEpisodeBlockReason = 'end_of_line' | 'missing_ordinal' | 'duplicate_ordinal' |
 *       'duplicate_episode_key' | 'duplicate_line_key' | 'unpositioned_episode' |
 *       'special_episode' | 'unknown_episode'
 *   - interface NextEpisodeOutcome { status: SequenceStatus;
 *       next: SequenceEpisodeRow | null;                       // 仅 status='ordered' 时非空
 *       reason: NextEpisodeBlockReason | null }                // next=null 时必非空
 *   - function computeNextEpisode(facts: SequenceFacts, currentEpisodeKey: string): NextEpisodeOutcome
 *       // 标题级:定位首个包含该键的可导航线(按 sortOrder),委托 computeLineNext
 *   - function computeLineNext(line: SequenceLineFacts, currentEpisodeKey: string): NextEpisodeOutcome
 *       // 线级 N+1 原语(重复键线/镜像线的显式消歧入口)
 *
 * buildSequence 行状态推导(按序首条命中;input 是裸事实,分类由规则层负责):
 *   | 输入事实                                    | sequenceStatus | 依据                       |
 *   | special=true                                | 'special'      | 特典/花絮/电影不进常规链   |
 *   | 线内 (lineKey,episodeKey) 重复(全部重复行)  | 'ambiguous'    | §2 (line_id,episode_key)唯一|
 *   | ordinal === null(非 special)               | 'ambiguous'    | T055「空…编号不猜」        |
 *   | 其余                                        | 'ordered'      | 有明确常规序位             |
 *   线可导航性:同标题内 lineKey 首次出现(按声明序)且非空 → navigable:true;
 *   后续同键线 → unsupported 'duplicate_line_key';空键线 → unsupported 'empty_line_key'
 *   (§2 vod_line「重复/空key详情显示unsupported」)。unsupported 线整线不参与标题级导航,
 *   但仍携带行事实(详情呈现用)。
 *
 * computeLineNext 判定序(逐字钉死,首条命中即返回):
 *   1. 线不可导航 → { 'ambiguous', null, 'duplicate_line_key'|'empty_line_key' };
 *   2. 找不到 currentEpisodeKey → { 'ambiguous', null, 'unknown_episode' };
 *   3. 行 status='special' → { 'special', null, 'special_episode' };
 *   4. 行 status='ambiguous' → { 'ambiguous', null, 'duplicate_episode_key'|'unpositioned_episode' };
 *   5. 行 ordered:候选=本线内 ordinal 非 null 且 > 当前 ordinal 的 ordered 行;
 *      a) 无更大 ordinal → { 'ordered', null, 'end_of_line' }(线内走完,FR-025 影片末尾:
 *         以 next=null 表达停止;auto-next 仅在 status='ordered' 且 next≠null 时放行);
 *      b) ordinal+1 恰位缺、但存在更大 ordinal → { 'ambiguous', null, 'missing_ordinal' }(B 组);
 *      c) ordinal+1 位有多个候选(ordinal 重复)→ { 'ambiguous', null, 'duplicate_ordinal' };
 *      d) 否则 { 'ordered', next=该行(同一行对象), reason:null }。
 *   纯度钉面:步骤 5b/5c 产生的 next 恒 null——「不猜 03、不跳 04、不猜重复位」;
 *   special 行永不作为 next 目标(候选只取 ordered 行,见 E 组中间特典用例);
 *   跨线/跨源在结构上不可能:候选只在当前 facts 的当前线内收集(F 组)。
 *
 * 用例↔契约映射:基线=夹具素材锁面+buildSequence 回显;A N+1/ordinal 语义(§2「只同线明确
 * N+1」+T055「常规N+1」);B 缺集保守读法(§2「缺集不能跳」+FR-025+US3 场景2);C 重复
 * (§2 行/线唯一键 + api VodPreview identity_ambiguous/unsupported 呈现);D 季界(§2 season_key
 * 记录不阻断 + T055「只同源同线」);E special(T055「不因特殊集…猜」+FR-025「花絮…停止」);
 * F 跨线/跨源(T055「只同源同线」+FR-025「不能自动跨来源或跨电影」)。
 */

/* ------------------------------------------------------------------ */
/* 夹具世界(纯构造,零网络)                                              */
/* ------------------------------------------------------------------ */

const VOD_ORIGIN = 'http://127.0.0.1:18081';

/** 世界一:三集连续剧(同线明确 N+1,ordinal 1→2→3,全部 ordered,S01) */
const serialWorld = createThreeEpisodeSerialWorld(VOD_ORIGIN);
/** 世界二:缺集(主线 01/02/04)+ 重复编号(备用线两个 '02')+ 特典 SP00 + 重复 lineKey 镜像线 */
const gappedWorld = createGappedDuplicateWorld(VOD_ORIGIN);
/** 世界三两端:同名版本冲突正片电影(ordinal 1 + special)——影片末尾/跨电影停止素材 */
const theatricalWorld = createVersionConflictWorld(VOD_ORIGIN, 'theatrical');
const directorsCutWorld = createVersionConflictWorld(VOD_ORIGIN, 'directors-cut');

/** D 组素材:同线 S01→S02 季界(ordinal 12→13 明确连续,年季变化) */
const seasonBridgeWorld = createFixtureTitleWorld({
  titleKey: 'episode-sequence:season-bridge',
  searchKeyword: 'seasonbridge',
  upstreamVodId: 1101,
  name: 'fixture·季界信使',
  year: '2025',
  area: '夹具地区',
  lang: '夹具语言',
  episodesTotal: 2,
  synopsis: 'T053 D 组素材:同线 S01→S02 季界,S01E12(ordinal 12)→S02E01(ordinal 13)明确 N+1。',
  lines: [
    {
      lineKey: 'main',
      displayName: 'fixture正片',
      sortOrder: 1,
      episodes: [
        {
          episodeKey: 'S01E12',
          label: '第12集',
          presentation: createStandardEpisodePresentation({
            presentationKey: 'episode-sequence:season-bridge:s01e12',
            episodeKey: 'S01E12',
            origin: VOD_ORIGIN,
            rootPath: '/vod/hls/1101/ep-s01e12',
            segmentCount: 2,
            segmentDurationSeconds: 45,
          }),
          seasonKey: 'S01',
          ordinal: 12,
          sequenceStatus: 'ordered',
        },
        {
          episodeKey: 'S02E01',
          label: '第2季第1集',
          presentation: createStandardEpisodePresentation({
            presentationKey: 'episode-sequence:season-bridge:s02e01',
            episodeKey: 'S02E01',
            origin: VOD_ORIGIN,
            rootPath: '/vod/hls/1101/ep-s02e01',
            segmentCount: 2,
            segmentDurationSeconds: 45,
          }),
          seasonKey: 'S02',
          ordinal: 13,
          sequenceStatus: 'ordered',
        },
      ],
    },
  ],
});

/** 世界种子 → buildSequence 裸事实输入(mediaId 为确定性合成占位,仅透传) */
function sequenceLineInputs(world: FixtureTitleWorld): SequenceLineInput[] {
  return world.seed.lines.map((line) => ({
    lineKey: line.lineKey,
    displayName: line.displayName,
    sortOrder: line.sortOrder,
    episodes: line.episodes.map((episode, index): SequenceEpisodeInput => ({
      episodeKey: episode.episodeKey,
      mediaId: `fixture-media:${world.seed.upstreamVodId}:${line.lineKey}#${line.sortOrder}:${index}:${episode.episodeKey}`,
      seasonKey: episode.seasonKey ?? null,
      ordinal: episode.ordinal ?? null,
      special: episode.sequenceStatus === 'special',
    })),
  }));
}

/** 直接构造规则层裸事实(不经过夹具世界的边界用例用) */
function lineInput(
  lineKey: string,
  sortOrder: number,
  episodes: readonly SequenceEpisodeInput[],
): SequenceLineInput {
  return { lineKey, displayName: `fixture线·${lineKey}`, sortOrder, episodes };
}

function episodeInput(episodeKey: string, overrides: Partial<SequenceEpisodeInput> = {}): SequenceEpisodeInput {
  return {
    episodeKey,
    mediaId: `fixture-media:${episodeKey}`,
    seasonKey: 'S01',
    ordinal: null,
    special: false,
    ...overrides,
  };
}

/** 默认 buildSequence 输入(单源单片;边界用例覆盖 sourceId/titleId 维度) */
function buildFrom(
  lines: readonly SequenceLineInput[],
  overrides: Partial<{ sourceId: string; titleId: string; detailRevision: number; sequenceRevision: number }> = {},
): SequenceFacts {
  return buildSequence({
    sourceId: overrides.sourceId ?? 'fixture-vod-source-alpha',
    titleId: overrides.titleId ?? 'fixture-title',
    detailRevision: overrides.detailRevision ?? 1,
    sequenceRevision: overrides.sequenceRevision ?? 1,
    lines,
  });
}

/* ------------------------------------------------------------------ */
/* 取值收窄(noUncheckedIndexedAccess 下缺行即测试失败)                   */
/* ------------------------------------------------------------------ */

function requireLine(facts: SequenceFacts, lineKey: string): SequenceLineFacts {
  const line = facts.lines.find((candidate: SequenceLineFacts) => candidate.lineKey === lineKey);
  if (line === undefined) {
    throw new Error(`facts 缺线路 ${lineKey}`);
  }
  return line;
}

function requireRow(line: SequenceLineFacts, episodeKey: string): SequenceEpisodeRow {
  const row = line.episodes.find((candidate: SequenceEpisodeRow) => candidate.episodeKey === episodeKey);
  if (row === undefined) {
    throw new Error(`线路 ${line.lineKey} 缺集 ${episodeKey}`);
  }
  return row;
}

/** 收窄:预期明确 N+1 命中(缺 next 即测试失败) */
function requireOrderedNext(outcome: NextEpisodeOutcome): SequenceEpisodeRow {
  expect(outcome.status).toBe('ordered');
  if (outcome.next === null) {
    throw new Error(`预期明确下一集,实际:${JSON.stringify(outcome)}`);
  }
  return outcome.next;
}

/** 收窄:预期无 next 并钉死三值状态与块定原因 */
function expectNoNext(
  outcome: NextEpisodeOutcome,
  status: SequenceStatus,
  reason: NextEpisodeBlockReason,
): void {
  expect(outcome.next).toBeNull();
  expect(outcome.status).toBe(status);
  expect(outcome.reason).toBe(reason);
}

/* ------------------------------------------------------------------ */
/* 基线:夹具素材锁面 + buildSequence 回显与行状态推导                    */
/* ------------------------------------------------------------------ */

describe('基线:夹具输入素材锁面与 buildSequence 回显', () => {
  it('素材锁面:三集 serial ordinal 1/2/3;gapped 主线 01/02/04、备用线 02/02/SP00、镜像线重复 main;电影 ordinal 1+special;季界 12/13(S01/S02)', () => {
    const serialLine = serialWorld.seed.lines[0];
    expect(serialLine?.lineKey).toBe('main');
    expect(serialLine?.episodes.map((episode) => episode.episodeKey)).toEqual(['01', '02', '03']);
    expect(serialLine?.episodes.map((episode) => episode.ordinal)).toEqual([1, 2, 3]);
    const gappedLines = gappedWorld.seed.lines;
    expect(gappedLines.map((line) => line.lineKey)).toEqual(['main', 'backup', 'main']);
    expect(gappedLines[0]?.episodes.map((episode) => episode.episodeKey)).toEqual(['01', '02', '04']);
    expect(gappedLines[1]?.episodes.map((episode) => episode.episodeKey)).toEqual(['02', '02', 'SP00']);
    expect(gappedLines[2]?.episodes.map((episode) => episode.episodeKey)).toEqual(['01']);
    expect(theatricalWorld.seed.lines[0]?.episodes[0]?.sequenceStatus).toBe('special');
    expect(seasonBridgeWorld.seed.lines[0]?.episodes.map((episode) => episode.seasonKey)).toEqual(['S01', 'S02']);
    expect(seasonBridgeWorld.seed.lines[0]?.episodes.map((episode) => episode.ordinal)).toEqual([12, 13]);
    expect(Object.values(FIXTURE_TITLE_KEYS)).toContain(FIXTURE_TITLE_KEYS.threeEpisodeSerial);
  });

  it('回显与行状态:sourceId/titleId/detailRevision/sequenceRevision 原样;行状态与夹具声明逐一吻合(推导复现分类)', () => {
    for (const world of [serialWorld, gappedWorld]) {
      const facts = buildFrom(sequenceLineInputs(world), { titleId: world.seed.titleKey });
      expect(facts.sourceId).toBe('fixture-vod-source-alpha');
      expect(facts.titleId).toBe(world.seed.titleKey);
      expect(facts.detailRevision).toBe(1);
      expect(facts.sequenceRevision).toBe(1);
      for (const [index, seedLine] of world.seed.lines.entries()) {
        const builtLine = facts.lines[index];
        expect(builtLine?.lineKey).toBe(seedLine.lineKey);
        expect(builtLine?.episodes.map((row: SequenceEpisodeRow) => row.sequenceStatus)).toEqual(
          seedLine.episodes.map((episode) => episode.sequenceStatus),
        );
      }
    }
  });
});

/* ------------------------------------------------------------------ */
/* A. 同线明确 N+1 与 ordinal 语义                                       */
/* ------------------------------------------------------------------ */

describe('A. N+1:data-model §2「只同线明确N+1」+ T055「只同源同线常规N+1」', () => {
  it('三集链:01→02→03 逐集 ordered,next 行携带完整身份(episodeKey/mediaId/ordinal/seasonKey 不改)', () => {
    const facts = buildFrom(sequenceLineInputs(serialWorld), { titleId: serialWorld.seed.titleKey });
    const main = requireLine(facts, 'main');
    expect(main.navigable).toBe(true);
    expect(main.episodes.map((row: SequenceEpisodeRow) => row.sequenceStatus)).toEqual(['ordered', 'ordered', 'ordered']);

    const nextOf01 = requireOrderedNext(computeNextEpisode(facts, '01'));
    expect(nextOf01).toBe(requireRow(main, '02'));
    expect(nextOf01).toEqual({
      lineKey: 'main',
      episodeKey: '02',
      mediaId: 'fixture-media:1001:main#1:1:02',
      seasonKey: 'S01',
      ordinal: 2,
      sequenceStatus: 'ordered',
    });
    const nextOf02 = requireOrderedNext(computeNextEpisode(facts, '02'));
    expect(nextOf02).toBe(requireRow(main, '03'));
  });

  it('线内走完:03 之后无更大 ordinal → { ordered, null, end_of_line }(影片末尾停止,next=null 表达)', () => {
    const facts = buildFrom(sequenceLineInputs(serialWorld));
    expectNoNext(computeNextEpisode(facts, '03'), 'ordered', 'end_of_line');
  });

  it('ordinal 语义:声明顺序打乱([03,01,02])不改变链;键字典序陷阱([\'1\',\'2\',\'10\'])按 ordinal 而非字符串排序', () => {
    const shuffled = buildFrom([
      lineInput('main', 1, [
        episodeInput('03', { ordinal: 3 }),
        episodeInput('01', { ordinal: 1 }),
        episodeInput('02', { ordinal: 2 }),
      ]),
    ]);
    expect(requireOrderedNext(computeNextEpisode(shuffled, '01')).episodeKey).toBe('02');
    expect(requireOrderedNext(computeNextEpisode(shuffled, '02')).episodeKey).toBe('03');

    const lexicographic = buildFrom([
      lineInput('main', 1, [
        episodeInput('1', { ordinal: 1 }),
        episodeInput('2', { ordinal: 2 }),
        episodeInput('10', { ordinal: 3 }),
      ]),
    ]);
    // 字符串序 '10' < '2',但 ordinal 3 > 2 → next('2') = '10'
    expect(requireOrderedNext(computeNextEpisode(lexicographic, '2')).episodeKey).toBe('10');
  });
});

/* ------------------------------------------------------------------ */
/* B. 缺集:保守读法——缺集处非 ordered,不猜 03、不跳 04                  */
/* ------------------------------------------------------------------ */

describe('B. 缺集:data-model §2「缺集…不能跳」+ FR-025「编号缺失…停止」(US3 场景2 停止自动前进)', () => {
  it('主线 01/02/04:行全部 ordered(有明确序位);02 的 next 缺 ordinal 3 → { ambiguous, null, missing_ordinal }——不猜 03、不跳 04', () => {
    const facts = buildFrom(sequenceLineInputs(gappedWorld), { titleId: gappedWorld.seed.titleKey });
    const main = requireLine(facts, 'main');
    expect(main.episodes.map((row: SequenceEpisodeRow) => row.sequenceStatus)).toEqual(['ordered', 'ordered', 'ordered']);
    const outcome = computeNextEpisode(facts, '02');
    expectNoNext(outcome, 'ambiguous', 'missing_ordinal');
    // 显式排除对照读法:next 不是 04(「缺集不能跳」,04 的存在不使跳缺集合法化)
    expect(outcome.next?.episodeKey).not.toBe('04');
  });

  it('缺集只影响缺口处:01 的 N+1 明确段不受影响(→02);04 之后无更大 ordinal → end_of_line(末尾,非缺集)', () => {
    const facts = buildFrom(sequenceLineInputs(gappedWorld));
    expect(requireOrderedNext(computeNextEpisode(facts, '01')).episodeKey).toBe('02');
    expectNoNext(computeNextEpisode(facts, '04'), 'ordered', 'end_of_line');
  });
});

/* ------------------------------------------------------------------ */
/* C. 重复:重复集键 → ambiguous;重复/空 lineKey → unsupported 不参与导航 */
/* ------------------------------------------------------------------ */

describe('C. 重复:§2「(line_id,episode_key)唯一」「重复/空key详情显示unsupported」', () => {
  it('备用线两个 \'02\' → 行均 ambiguous;线级导航从重复键出发 → { ambiguous, null, duplicate_episode_key }', () => {
    const facts = buildFrom(sequenceLineInputs(gappedWorld));
    const backup = requireLine(facts, 'backup');
    expect(backup.navigable).toBe(true);
    expect(backup.episodes.map((row: SequenceEpisodeRow) => row.sequenceStatus)).toEqual(['ambiguous', 'ambiguous', 'special']);
    expectNoNext(computeLineNext(backup, '02'), 'ambiguous', 'duplicate_episode_key');
  });

  it('镜像线重复 lineKey → navigable:false + duplicate_line_key,整线不参与标题级导航;标题级 \'01\' 解析到主线的 02(非镜像行)', () => {
    const facts = buildFrom(sequenceLineInputs(gappedWorld));
    const mirrorLine = facts.lines[2];
    if (mirrorLine === undefined) {
      throw new Error('facts 缺镜像线(index 2)');
    }
    expect(mirrorLine.lineKey).toBe('main');
    expect(mirrorLine.navigable).toBe(false);
    expect(mirrorLine.unsupportedReason).toBe('duplicate_line_key');
    expectNoNext(computeLineNext(mirrorLine, '01'), 'ambiguous', 'duplicate_line_key');

    // 标题级解析按 sortOrder 取首个可导航线(main sortOrder=1 < backup=2 < mirror=3 unsupported)
    const nextOf01 = requireOrderedNext(computeNextEpisode(facts, '01'));
    expect(nextOf01.lineKey).toBe('main');
    expect(nextOf01).toBe(requireRow(requireLine(facts, 'main'), '02'));
  });

  it('空 lineKey → unsupported empty_line_key(§2「重复/空key详情显示unsupported」)', () => {
    const facts = buildFrom([
      lineInput('', 1, [episodeInput('01', { ordinal: 1 })]),
    ]);
    const emptyLine = facts.lines[0];
    expect(emptyLine?.navigable).toBe(false);
    expect(emptyLine?.unsupportedReason).toBe('empty_line_key');
  });

  it('ordinal 重复:ordinal+1 槽位多候选 → { ambiguous, null, duplicate_ordinal }(不猜重复位)', () => {
    const facts = buildFrom([
      lineInput('main', 1, [
        episodeInput('a', { ordinal: 1 }),
        episodeInput('b', { ordinal: 2 }),
        episodeInput('c', { ordinal: 2 }),
      ]),
    ]);
    expectNoNext(computeNextEpisode(facts, 'a'), 'ambiguous', 'duplicate_ordinal');
  });
});

/* ------------------------------------------------------------------ */
/* D. 季界:年季变化不阻断同线明确 N+1;跨线季界不导航                     */
/* ------------------------------------------------------------------ */

describe('D. 季界:season_key 只是记录字段(导航与身份分开);T055「只同源同线常规N+1」', () => {
  it('同线 S01E12(ordinal 12)→ S02E01(ordinal 13):年季变化不阻断 → { ordered, next=S02E01 };行 seasonKey S01/S02 原样携带', () => {
    const facts = buildFrom(sequenceLineInputs(seasonBridgeWorld), { titleId: seasonBridgeWorld.seed.titleKey });
    const main = requireLine(facts, 'main');
    expect(requireRow(main, 'S01E12').seasonKey).toBe('S01');
    expect(requireRow(main, 'S02E01').seasonKey).toBe('S02');
    const next = requireOrderedNext(computeNextEpisode(facts, 'S01E12'));
    expect(next).toBe(requireRow(main, 'S02E01'));
    // 新季首集之后线内走完
    expectNoNext(computeNextEpisode(facts, 'S02E01'), 'ordered', 'end_of_line');
  });

  it('跨线季界不导航:S01 在 main、S02E01(ordinal 13)在另一线 → main 的 S01E12 next=null(跨线候选永不出现)', () => {
    const facts = buildFrom([
      lineInput('main', 1, [episodeInput('S01E12', { seasonKey: 'S01', ordinal: 12 })]),
      lineInput('s02', 2, [episodeInput('S02E01', { seasonKey: 'S02', ordinal: 13 })]),
    ]);
    const outcome = computeNextEpisode(facts, 'S01E12');
    expectNoNext(outcome, 'ordered', 'end_of_line');
    expect(outcome.next?.episodeKey).not.toBe('S02E01');
    expectNoNext(computeLineNext(requireLine(facts, 's02'), 'S02E01'), 'ordered', 'end_of_line');
  });
});

/* ------------------------------------------------------------------ */
/* E. special:特典不进入自动连播链(不作为起点,也不作为目标)              */
/* ------------------------------------------------------------------ */

describe('E. special:T055「不因特殊集…猜下一集」+ FR-025「花絮或影片末尾停止」', () => {
  it('SP00 → 行 special;从特典出发 → { special, null, special_episode }(不作为导航起点)', () => {
    const facts = buildFrom(sequenceLineInputs(gappedWorld));
    expect(requireRow(requireLine(facts, 'backup'), 'SP00').sequenceStatus).toBe('special');
    expectNoNext(computeNextEpisode(facts, 'SP00'), 'special', 'special_episode');
  });

  it('特典不是合法 N+1 目标:中间特典占据序位空档时,01 → { ambiguous, missing_ordinal }(跳不过特典,不猜)', () => {
    const facts = buildFrom([
      lineInput('main', 1, [
        episodeInput('01', { ordinal: 1 }),
        episodeInput('SP00', { ordinal: null, special: true }),
        episodeInput('03', { ordinal: 3 }),
      ]),
    ]);
    expectNoNext(computeNextEpisode(facts, '01'), 'ambiguous', 'missing_ordinal');
    expectNoNext(computeNextEpisode(facts, 'SP00'), 'special', 'special_episode');
  });

  it('正片电影(ordinal 1 + special)→ { special, null, special_episode }:影片本身不构成连播链(影片末尾停止)', () => {
    const facts = buildFrom(sequenceLineInputs(theatricalWorld), { titleId: theatricalWorld.seed.titleKey });
    expectNoNext(computeNextEpisode(facts, 'movie'), 'special', 'special_episode');
  });

  it('非特殊集缺序位(ordinal null)→ 行 ambiguous + { ambiguous, unpositioned_episode }(空编号不猜)', () => {
    const facts = buildFrom([
      lineInput('main', 1, [
        episodeInput('01', { ordinal: 1 }),
        episodeInput('x', { ordinal: null }),
      ]),
    ]);
    expectNoNext(computeNextEpisode(facts, 'x'), 'ambiguous', 'unpositioned_episode');
  });
});

/* ------------------------------------------------------------------ */
/* F. 跨线/跨源:导航候选只在当前线、当前 facts 内收集                     */
/* ------------------------------------------------------------------ */

describe('F. 跨线/跨源:T055「只同源同线」+ FR-025「不能自动跨来源或跨电影」', () => {
  it('跨线不接龙:lineA [01,02] 走完后,另一可导航线的 ordinal 3 不产生 next(线内无更大 ordinal → end_of_line)', () => {
    const facts = buildFrom([
      lineInput('lineA', 1, [
        episodeInput('01', { ordinal: 1 }),
        episodeInput('02', { ordinal: 2 }),
      ]),
      lineInput('lineB', 2, [episodeInput('03', { ordinal: 3 })]),
    ]);
    const outcome = computeNextEpisode(facts, '02');
    expectNoNext(outcome, 'ordered', 'end_of_line');
    expect(outcome.next?.episodeKey).not.toBe('03');
  });

  it('跨源结构隔离:同一片不同 sourceId 各自建 facts,导航行是本 facts 的行对象(标识恒等,互不串行)', () => {
    const inputs = sequenceLineInputs(serialWorld);
    const alphaFacts = buildFrom(inputs, { sourceId: 'fixture-vod-source-alpha', titleId: serialWorld.seed.titleKey });
    const betaFacts = buildFrom(inputs, { sourceId: 'fixture-vod-source-beta', titleId: serialWorld.seed.titleKey });
    expect(alphaFacts.sourceId).toBe('fixture-vod-source-alpha');
    expect(betaFacts.sourceId).toBe('fixture-vod-source-beta');
    const alphaNext = requireOrderedNext(computeNextEpisode(alphaFacts, '02'));
    expect(alphaNext).toBe(requireRow(requireLine(alphaFacts, 'main'), '03'));
    const betaNext = requireOrderedNext(computeNextEpisode(betaFacts, '02'));
    expect(betaNext).toBe(requireRow(requireLine(betaFacts, 'main'), '03'));
    expect(alphaNext).not.toBe(betaNext);
  });

  it('跨源跨电影:alpha 剧场版与 gamma 导演剪辑版同名单片互不接龙——两源 next 均为 special/无(完结电影不跨来源续接)', () => {
    const alphaFacts = buildFrom(sequenceLineInputs(theatricalWorld), {
      sourceId: 'fixture-vod-source-alpha',
      titleId: theatricalWorld.seed.titleKey,
    });
    const gammaFacts = buildFrom(sequenceLineInputs(directorsCutWorld), {
      sourceId: 'fixture-vod-source-gamma',
      titleId: directorsCutWorld.seed.titleKey,
    });
    expectNoNext(computeNextEpisode(alphaFacts, 'movie'), 'special', 'special_episode');
    expectNoNext(computeNextEpisode(gammaFacts, 'movie'), 'special', 'special_episode');
  });

  it('未知集键防御:{ ambiguous, null, unknown_episode }(不抛错、不猜)', () => {
    const facts = buildFrom(sequenceLineInputs(serialWorld));
    expectNoNext(computeNextEpisode(facts, '99'), 'ambiguous', 'unknown_episode');
  });
});
