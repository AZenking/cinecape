/**
 * 010 T055 — 独立导航序列纯函数(纯领域,零依赖)。
 *
 * 纯 TS:零依赖、零 import(.dependency-cruiser.cjs R1a 对 domain 层的框架/内建/
 * platform/外部包硬禁令 + audit:purity 符号级门禁;本文件连类型 import 都没有,
 * 与 @contexts/playback/domain/transition.rules.ts 同惯例)。
 * 零真实时钟:一切时刻皆不入参(序列判定与时间无关);零网络、零持久化、零 IO。
 *
 * 行为契约(本文件使其全绿):apps/server/test/unit/online-vod/episode-sequence.spec.ts
 * (010 T053 测试先行,文件头钉死建议导出面/判定序/缺集保守读法/季界/重复键钉面)。
 *
 * 来源标注(实现侧不自创语义,契约冻结面):
 * - docs/specs/010-online-vod/data-model.md §2 vod_episode_sequence 行(逐字):
 *   「状态ordered/ambiguous/special;导航与身份分开;只同线明确N+1,缺集/重复/季边界
 *   不能跳」;vod_line 行:「(title_id,line_key)唯一;重复/空key详情显示unsupported」;
 *   vod_episode 行:「(line_id,episode_key)…唯一」。
 * - docs/specs/010-online-vod/data-model.md §3(逐字):「sequenceRevision为同标题/
 *   线路导航快照版本(>=1),仅成员/顺序/年季/常规集资格变化时递增,与引用的
 *   detailRevision一同发布;不因签名URL变化单独推进。next计划固定两者,详情版本
 *   变化即要求重选,以保守处理无法可靠区分的外部变化」。
 * - tasks.md T055(逐字):「发布独立导航序列,"状态ordered/ambiguous/special";
 *   只同源同线常规N+1,不改稳定标签身份,不因特殊集/空/重复编号猜下一集」。
 * - spec.md FR-025(逐字):「仅对同源同线路明确连续的下一常规集生效。编号缺失/重复、
 *   季边界、花絮或影片末尾停止,不能自动跨来源或跨电影」。
 *
 * 钉面摘要(与测试一一对应,详见 spec 文件头):
 * - 行状态推导按序首条命中:special → 线内 (lineKey,episodeKey) 重复(全部重复行标
 *   ambiguous)→ ordinal === null(空编号不猜)→ ordered;
 * - 线可导航性:同标题内 lineKey 首次出现(按声明序)且非空 → navigable;后续同键线 →
 *   'duplicate_line_key';空键线 → 'empty_line_key';unsupported 线整线不参与标题级
 *   导航,但仍携带行事实(详情呈现用);
 * - computeLineNext 判定序逐字钉死(不可导航 → unknown_episode → special →
 *   ambiguous(duplicate/unpositioned) → end_of_line → missing_ordinal →
 *   duplicate_ordinal → ordered),5b/5c 产生的 next 恒 null(不猜 03、不跳 04、
 *   不猜重复位);special 行永不作为 next 目标;候选只在当前线内收集(跨线/跨源
 *   结构上不可能);
 * - 季界:seasonKey 只是序列行的记录字段(「导航与身份分开」),年季变化不阻断同线
 *   明确 N+1;跨线的季界不导航(线内无更大 ordinal → end_of_line);
 * - 键身份不改写:episodeKey/lineKey 假定已 NFC+trim(§1 身份层职责),本文件原样
 *   透传,不做任何归一/截断(「不改稳定标签身份」)。
 */

/* ------------------------------------------------------------------ */
/* 枚举(data-model §2 字段词表,与存储 CHECK 枚举一一对应)                 */
/* ------------------------------------------------------------------ */

/** 序列状态全集(data-model §2 sequence_status;与 0007 迁移 CHECK 枚举逐字对应) */
export const SEQUENCE_STATUSES = ['ordered', 'ambiguous', 'special'] as const;

/**
 * 序列状态:ordered=有明确常规序位;ambiguous=重复集键/空编号(不可导航位);
 * special=特典/花絮/正片电影(不进常规连播链)。
 */
export type SequenceStatus = (typeof SEQUENCE_STATUSES)[number];

/* ------------------------------------------------------------------ */
/* 输入/输出值模型(与 episode-sequence.spec.ts import 面逐字对齐)          */
/* ------------------------------------------------------------------ */

/** 序列构建单集裸事实(special=上游/adapter 判定的非常规集;key 假定已 NFC+trim) */
export interface SequenceEpisodeInput {
  readonly episodeKey: string;
  readonly mediaId: string | null;
  readonly seasonKey: string | null;
  readonly ordinal: number | null;
  readonly special: boolean;
}

/** 序列构建单线裸事实(声明序即输入序;sortOrder 为标题级导航线选择依据) */
export interface SequenceLineInput {
  readonly lineKey: string;
  readonly displayName: string;
  readonly sortOrder: number;
  readonly episodes: readonly SequenceEpisodeInput[];
}

/** 序列行事实(buildSequence 产物;字段面与 vod_episode_sequence 行语义对应) */
export interface SequenceEpisodeRow {
  readonly lineKey: string;
  readonly episodeKey: string;
  readonly mediaId: string | null;
  readonly seasonKey: string | null;
  readonly ordinal: number | null;
  readonly sequenceStatus: SequenceStatus;
}

/** 线不参与导航的原因(§2 vod_line「重复/空key详情显示unsupported」;navigable=true 时为 null) */
export type SequenceLineUnsupportedReason = 'duplicate_line_key' | 'empty_line_key';

/** 序列线事实:行事实 + 本标题内的可导航性判定(unsupported 线仍携带行事实) */
export interface SequenceLineFacts {
  readonly lineKey: string;
  readonly displayName: string;
  readonly sortOrder: number;
  /** 本标题内 lineKey 首次出现(按声明序)且非空 */
  readonly navigable: boolean;
  readonly unsupportedReason: SequenceLineUnsupportedReason | null;
  readonly episodes: readonly SequenceEpisodeRow[];
}

/** 单源单标题导航快照(§3:sequenceRevision 与 detailRevision 一同发布,next 计划固定两者) */
export interface SequenceFacts {
  readonly sourceId: string;
  readonly titleId: string;
  readonly detailRevision: number;
  readonly sequenceRevision: number;
  readonly lines: readonly SequenceLineFacts[];
}

/**
 * 线级/标题级导航阻断原因全集(computeLineNext 判定序中的 reason 词表)。
 * ⚠️ 钉面偏差说明(以测试为准,对齐 continuity.service 先例):spec 文件头建议导出面的
 * NextEpisodeBlockReason 联合未列 'empty_line_key',但同文件 computeLineNext 判定序
 * 第 1 步逐字写明「线不可导航 → { 'ambiguous', null, 'duplicate_line_key'|
 * 'empty_line_key' }」——两处冲突;测试断言面从未穷举该联合,而空键线的不可导航
 * 原因是判定序钉面的一部分,故按判定序补入该成员(严格超集,零既有断言受影响)。
 */
export const NEXT_EPISODE_BLOCK_REASONS = [
  'end_of_line',
  'missing_ordinal',
  'duplicate_ordinal',
  'duplicate_episode_key',
  'duplicate_line_key',
  'empty_line_key',
  'unpositioned_episode',
  'special_episode',
  'unknown_episode',
] as const;

/** 导航阻断原因(end_of_line 特殊:线内走完属正常停止,非异常阻断) */
export type NextEpisodeBlockReason = (typeof NEXT_EPISODE_BLOCK_REASONS)[number];

/** 导航判定结果:auto-next 仅在 status='ordered' 且 next≠null 时放行(FR-025) */
export interface NextEpisodeOutcome {
  readonly status: SequenceStatus;
  /** 仅 status='ordered' 且 reason='end_of_line' 之外的有链命中时非空 */
  readonly next: SequenceEpisodeRow | null;
  /** next=null 时必非空(可判定的停止/阻断原因,绝不静默) */
  readonly reason: NextEpisodeBlockReason | null;
}

/* ------------------------------------------------------------------ */
/* buildSequence:裸事实 → 导航快照(行状态/线可导航性推导)                  */
/* ------------------------------------------------------------------ */

/**
 * 单集行状态推导(按序首条命中;input 是裸事实,分类由规则层负责):
 * 1. special=true → 'special'(特典/花絮/电影不进常规链);
 * 2. 线内 (lineKey,episodeKey) 重复 → 'ambiguous'(§2 (line_id,episode_key) 唯一,
 *    全部重复行都标,不挑首个——「重复键两处都标」);
 * 3. ordinal === null(非 special)→ 'ambiguous'(「空…编号不猜」);
 * 4. 其余 → 'ordered'(有明确常规序位)。
 */
function deriveEpisodeStatus(
  episode: SequenceEpisodeInput,
  sameKeyRowCount: number,
): SequenceStatus {
  if (episode.special) {
    return 'special';
  }
  if (sameKeyRowCount > 1) {
    return 'ambiguous';
  }
  if (episode.ordinal === null) {
    return 'ambiguous';
  }
  return 'ordered';
}

/**
 * buildSequence:单源单标题导航快照构建(纯函数,输入回显 + 行状态/线可导航性推导)。
 *
 * - sourceId/titleId/detailRevision/sequenceRevision 原样回显(§3 next 计划固定两者;
 *   修订数值的推进语义归发布方/application,T055 episode-sequence.service 依 §3 判定);
 * - lines 保序输出(声明序;标题级导航按 sortOrder 排序选择,不重排本数组);
 * - 线可导航性:lineKey 非空且同标题内首次出现(按声明序)→ navigable=true;
 *   空键线 → unsupported 'empty_line_key'(§2 空 key 详情 unsupported);后续同键线 →
 *   unsupported 'duplicate_line_key';unsupported 线整线不参与标题级导航。
 */
export function buildSequence(input: {
  readonly sourceId: string;
  readonly titleId: string;
  readonly detailRevision: number;
  readonly sequenceRevision: number;
  readonly lines: readonly SequenceLineInput[];
}): SequenceFacts {
  const seenLineKeys = new Set<string>();
  const lines: SequenceLineFacts[] = input.lines.map((line) => {
    let navigable = true;
    let unsupportedReason: SequenceLineUnsupportedReason | null = null;
    if (line.lineKey === '') {
      navigable = false;
      unsupportedReason = 'empty_line_key';
    } else if (seenLineKeys.has(line.lineKey)) {
      navigable = false;
      unsupportedReason = 'duplicate_line_key';
    } else {
      seenLineKeys.add(line.lineKey);
    }

    const sameKeyRowCount = new Map<string, number>();
    for (const episode of line.episodes) {
      sameKeyRowCount.set(episode.episodeKey, (sameKeyRowCount.get(episode.episodeKey) ?? 0) + 1);
    }
    const episodes: SequenceEpisodeRow[] = line.episodes.map((episode) => ({
      lineKey: line.lineKey,
      episodeKey: episode.episodeKey,
      mediaId: episode.mediaId,
      seasonKey: episode.seasonKey,
      ordinal: episode.ordinal,
      sequenceStatus: deriveEpisodeStatus(episode, sameKeyRowCount.get(episode.episodeKey) ?? 1),
    }));

    return {
      lineKey: line.lineKey,
      displayName: line.displayName,
      sortOrder: line.sortOrder,
      navigable,
      unsupportedReason,
      episodes,
    };
  });

  return {
    sourceId: input.sourceId,
    titleId: input.titleId,
    detailRevision: input.detailRevision,
    sequenceRevision: input.sequenceRevision,
    lines,
  };
}

/* ------------------------------------------------------------------ */
/* computeLineNext:线级 N+1 原语(判定序逐字钉死,首条命中即返回)           */
/* ------------------------------------------------------------------ */

/** noUncheckedIndexedAccess 收窄:候选槽位恰一行 */
function sole<T>(rows: readonly T[]): T | undefined {
  return rows.length === 1 ? rows[0] : undefined;
}

/**
 * computeLineNext:线级明确 N+1 判定(重复键线/镜像线的显式消歧入口;判定序首条命中
 * 即返回,与 spec 文件头表格逐字一致):
 * 1. 线不可导航 → { 'ambiguous', null, 'duplicate_line_key'|'empty_line_key' };
 * 2. 找不到 currentEpisodeKey → { 'ambiguous', null, 'unknown_episode' }(不抛错、不猜);
 * 3. 行 status='special' → { 'special', null, 'special_episode' }(特典不作导航起点);
 * 4. 行 status='ambiguous' → { 'ambiguous', null, 'duplicate_episode_key'|
 *    'unpositioned_episode' }(重复键优先于空编号——判定序钉面);
 * 5. 行 ordered:候选=本线内 ordinal 非 null 且 > 当前 ordinal 的 ordered 行;
 *    a) 无更大 ordinal → { 'ordered', null, 'end_of_line' }(线内走完/影片末尾:
 *       以 next=null 表达停止;FR-025);
 *    b) ordinal+1 恰位缺、但存在更大 ordinal → { 'ambiguous', null, 'missing_ordinal' }
 *       (「缺集不能跳」:不猜 03、不跳 04);
 *    c) ordinal+1 位有多个候选(ordinal 重复)→ { 'ambiguous', null, 'duplicate_ordinal' }
 *       (不猜重复位);
 *    d) 否则 { 'ordered', next=该行(同一行对象,引用恒等), reason:null }。
 *
 * 纯度钉面:5b/5c 的 next 恒 null;special 行永不作为 next 目标(候选只取 ordered 行);
 * 候选只在当前 facts 的当前线内收集——跨线/跨源在结构上不可能。seasonKey 只是记录
 * 字段,年季变化不阻断同线明确 N+1(候选判定只看 ordinal)。
 */
export function computeLineNext(
  line: SequenceLineFacts,
  currentEpisodeKey: string,
): NextEpisodeOutcome {
  if (!line.navigable) {
    return { status: 'ambiguous', next: null, reason: line.unsupportedReason ?? 'duplicate_line_key' };
  }
  const current = line.episodes.find((row) => row.episodeKey === currentEpisodeKey);
  if (current === undefined) {
    return { status: 'ambiguous', next: null, reason: 'unknown_episode' };
  }
  if (current.sequenceStatus === 'special') {
    return { status: 'special', next: null, reason: 'special_episode' };
  }
  if (current.sequenceStatus === 'ambiguous') {
    const duplicated =
      line.episodes.filter((row) => row.episodeKey === currentEpisodeKey).length > 1;
    return {
      status: 'ambiguous',
      next: null,
      reason: duplicated ? 'duplicate_episode_key' : 'unpositioned_episode',
    };
  }

  // 行 ordered:ordinal 必非 null(推导序保证;防御性回落 unpositioned 不掩盖不变量破坏)
  const currentOrdinal = current.ordinal;
  if (currentOrdinal === null) {
    return { status: 'ambiguous', next: null, reason: 'unpositioned_episode' };
  }
  const larger = line.episodes.filter(
    (row) => row.sequenceStatus === 'ordered' && row.ordinal !== null && row.ordinal > currentOrdinal,
  );
  if (larger.length === 0) {
    return { status: 'ordered', next: null, reason: 'end_of_line' };
  }
  const atTarget = larger.filter((row) => row.ordinal === currentOrdinal + 1);
  if (atTarget.length === 0) {
    return { status: 'ambiguous', next: null, reason: 'missing_ordinal' };
  }
  const next = sole(atTarget);
  if (next === undefined) {
    return { status: 'ambiguous', next: null, reason: 'duplicate_ordinal' };
  }
  return { status: 'ordered', next, reason: null };
}

/* ------------------------------------------------------------------ */
/* computeNextEpisode:标题级导航(首个包含该键的可导航线,委托线级原语)      */
/* ------------------------------------------------------------------ */

/**
 * computeNextEpisode:标题级导航(只同源同线;跨线/跨源结构上不可能):
 * - 线选择按 sortOrder 升序(facts.lines 保声明序回显,标题级导航另排序);
 * - 定位首个「可导航且包含 currentEpisodeKey」的线,委托 computeLineNext
 *   (unsupported 线整线跳过——「重复/空key详情显示unsupported」,不入导航);
 * - 无任何可导航线包含该键 → { 'ambiguous', null, 'unknown_episode' }(保守防御,
 *   不抛错、不猜)。
 */
export function computeNextEpisode(facts: SequenceFacts, currentEpisodeKey: string): NextEpisodeOutcome {
  const orderedLines = [...facts.lines].sort((a, b) => a.sortOrder - b.sortOrder);
  for (const line of orderedLines) {
    if (!line.navigable) {
      continue;
    }
    if (!line.episodes.some((row) => row.episodeKey === currentEpisodeKey)) {
      continue;
    }
    return computeLineNext(line, currentEpisodeKey);
  }
  return { status: 'ambiguous', next: null, reason: 'unknown_episode' };
}

/* ------------------------------------------------------------------ */
/* 导航快照比对(§3 sequenceRevision 递增判定的纯核心)                      */
/* ------------------------------------------------------------------ */

/** 导航快照成员(行级最小事实集;发布方按 vod_episode_sequence 行投影喂入) */
export interface SequenceSnapshotMember {
  readonly lineKey: string;
  readonly episodeKey: string;
  readonly ordinal: number;
  readonly seasonKey: string | null;
  readonly sequenceStatus: SequenceStatus;
}

/**
 * sameNavigationSnapshot:两次发布间「成员/顺序/年季/常规集资格」是否全部未变
 * (§3:「sequenceRevision…仅成员/顺序/年季/常规集资格变化时递增」的纯判定):
 * - 成员全集按 (lineKey,episodeKey) 一一对应,ordinal/seasonKey/sequenceStatus
 *   逐字段相等 → 未变(不因签名 URL/采集时间/纯详情字段变化推进,§3);
 * - 任一新增/移除/换位/年季变化/常规集资格(状态)变化 → 已变(发布方据此 +1);
 * - 「顺序」以成员 ordinal 字段承载:同一成员集内任何 ordinal 换位即逐成员不等 →
 *   已变(本比较按键配对,不依赖输入排列序)。
 */
export function sameNavigationSnapshot(
  previous: readonly SequenceSnapshotMember[],
  candidate: readonly SequenceSnapshotMember[],
): boolean {
  if (previous.length !== candidate.length) {
    return false;
  }
  const keyOf = (member: SequenceSnapshotMember): string => `${member.lineKey}\u0000${member.episodeKey}`;
  const previousByKey = new Map<string, SequenceSnapshotMember>();
  for (const member of previous) {
    previousByKey.set(keyOf(member), member);
  }
  if (previousByKey.size !== previous.length) {
    // 键重复即结构异常,保守判「已变」(发布方推进修订,不静默吞并)
    return false;
  }
  for (const member of candidate) {
    const before = previousByKey.get(keyOf(member));
    if (before === undefined) {
      return false;
    }
    if (
      before.ordinal !== member.ordinal ||
      before.seasonKey !== member.seasonKey ||
      before.sequenceStatus !== member.sequenceStatus
    ) {
      return false;
    }
  }
  return true;
}
