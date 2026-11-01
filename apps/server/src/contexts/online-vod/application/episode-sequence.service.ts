/**
 * 010 T055 — 独立导航序列发布/查询服务(应用层纯函数模块,对齐 continuity.service 惯例:
 * 零 Nest 装饰器,store 以首参注入,方法体同步、零时钟/随机)。
 *
 * 职责(tasks.md T055 + 审查补充):
 * - publishSequence:从 detail 快照私有载荷事实(线路/集键/年季/序位/special 裸事实)
 *   构建导航序列(buildSequence 规则面),写入 vod_episode_sequence 行,并落实
 *   sequenceRevision 递增语义(data-model §3:「仅成员/顺序/年季/常规集资格变化时
 *   递增,与引用的 detailRevision 一同发布;不因签名URL变化单独推进」)——由物化
 *   工作集在 map/commit 步骤同事务调用(materialization.service 最小接线);
 * - nextEpisodeFor:标题级/线级导航查询(消费 T027 store 读面),供 playback
 *   next/manual_next(T059/T060)在创建 next 计划时取得「同源同线常规 N+1」事实;
 *   计划固定 sequenceRevision/detailRevision 两者(§3),本服务只发布序列事实与修订,
 *   不创建/不持久 next 计划(playback/application/next-plan.service 归 T059/T060 域)。
 *
 * 导航语义(实现侧不自创,判定在规则层):
 * - 「状态ordered/ambiguous/special」「只同线明确N+1,缺集/重复/季边界不能跳」
 *   (data-model §2)全部由 domain/episode-sequence.rules 判定;本服务只做事实装载
 *   (行→线→facts)与持久编排,不改写键身份(episodeKey/lineKey 原样透传);
 * - 集行身份:序列行 episode_id 引用 vod_episode.id(稳定标签身份不动);导航行的
 *   episodeKey 经联查读出,行级身份仍以 episodeId 为准;
 * - 无序位集(ordinal null)不入序列行(0007 DDL ordinal NOT NULL CHECK >=1,
 *   「导航与身份分开」:无序位即无导航位,规则面按 ambiguous/unpositioned 判);
 * - ordinal 非 1 起始/重复等破坏性输入由 CHECK 与唯一事实回滚(fail-loud),
 *   本服务不静默纠正。
 *
 * 修订语义(publishSequence 判定序,首条命中):
 * 1. 该标题无任何已发布序列行 → sequenceRevision=1(初版,>=1);
 * 2. 最新已发布快照(同标题最大 detail_revision 下最大 sequence_revision 的行)与
 *    本次候选成员 sameNavigationSnapshot 相等 → 修订不变(重复发布/纯详情变化
 *    不虚增;行按 (line,detail_revision,sequence_revision,episode) 幂等跳过);
 * 3. 否则 sequenceRevision=最新+1,整片新快照随本 detailRevision 同事务发布。
 * 旧修订行不可变不删除(快照行按 detail_revision 留存,24h 组回收按引用图整组
 * 清理,data-model §4)。
 */
import {
  buildSequence,
  computeLineNext,
  computeNextEpisode,
  sameNavigationSnapshot,
  type NextEpisodeOutcome,
  type SequenceEpisodeInput,
  type SequenceEpisodeRow,
  type SequenceFacts,
  type SequenceLineFacts,
  type SequenceLineInput,
  type SequenceSnapshotMember,
  type SequenceStatus,
} from '../domain/episode-sequence.rules';
import type {
  VodEpisodeSequenceInsert,
  VodEpisodeSequenceRow,
  VodLineRow,
  VodTitleRow,
} from './publication-work-set.port';

/* ------------------------------------------------------------------ */
/* 读数投影(行 + 联出线键/集键/媒体身份;store 以同名列别名返回同形行)      */
/* ------------------------------------------------------------------ */

/**
 * 序列行读数(vod_episode_sequence × vod_line × vod_episode 联查投影):
 * 序列表只引用 line_id/episode_id,导航与发布比对需要的线键/集键/媒体身份经联查
 * 读出;行身份仍以 lineId/episodeId 为准(键不改写,原样透传)。
 */
export interface EpisodeSequenceRowWithKey {
  readonly householdId: string;
  readonly titleId: string;
  readonly lineId: string;
  readonly lineKey: string;
  readonly detailRevision: number;
  readonly sequenceRevision: number;
  readonly episodeId: string;
  readonly episodeKey: string;
  readonly mediaId: string;
  readonly seasonKey: string | null;
  readonly ordinal: number;
  readonly sequenceStatus: SequenceStatus;
}

/* ------------------------------------------------------------------ */
/* 发布面(publishSequence;物化工作集 map/commit 步骤同事务调用)           */
/* ------------------------------------------------------------------ */

/**
 * 发布所需最小参与者面(结构子集):MaterializeWorkSet 的 ws.vod
 * (DrizzleOnlineVodTxParticipants = VodParticipant & OnlineVodStore 读面)满足之;
 * 测试以真实参与者装配,不经任何内存替身写路径。
 */
export interface SequencePublicationStore {
  /** 最新已发布导航快照(同标题最大 detail_revision 下最大 sequence_revision 的行) */
  listLatestEpisodeSequences(householdId: string, titleId: string): EpisodeSequenceRowWithKey[];
  /** 行级幂等守卫:同 (line, detail_revision, sequence_revision, episode) 已发布即跳过 */
  findEpisodeSequenceAtRevision(
    householdId: string,
    lineId: string,
    detailRevision: number,
    sequenceRevision: number,
    episodeId: string,
  ): VodEpisodeSequenceRow | undefined;
  /** 写独立导航序列行(无行级唯一,行身份为 rowid;重复快照由上方守卫拦截) */
  insertEpisodeSequence(values: VodEpisodeSequenceInsert): void;
}

/** 发布输入单集(详情快照私有载荷事实的集投影;special 为上游/adapter 判定的裸事实) */
export interface PublishSequenceEpisodeFacts {
  /** vod_episode 行 id(序列行 episode_id 引用;稳定标签身份,发布不改写) */
  readonly episodeId: string;
  readonly episodeKey: string;
  readonly mediaId: string | null;
  readonly seasonKey: string | null;
  /** 明确常规序位;null=上游未给(无导航位,不入序列行) */
  readonly ordinal: number | null;
  readonly special: boolean;
}

/** 发布输入单线(全部为已持久线路:vod_line 行存在,lineId 必填) */
export interface PublishSequenceLineFacts {
  /** vod_line 行 id(序列行 line_id 引用) */
  readonly lineId: string;
  readonly lineKey: string;
  readonly displayName: string;
  readonly sortOrder: number;
  readonly episodes: readonly PublishSequenceEpisodeFacts[];
}

/** 发布输入(单源单标题;detailRevision 即本次同事务发布的详情修订) */
export interface PublishSequenceInput {
  readonly householdId: string;
  readonly sourceId: string;
  readonly titleId: string;
  readonly detailRevision: number;
  readonly lines: readonly PublishSequenceLineFacts[];
}

/** 发布结果(revision 为本次发布使用的导航快照版本;facts 为该版本完整导航事实) */
export interface PublishSequenceOutcome {
  readonly sourceId: string;
  readonly titleId: string;
  readonly detailRevision: number;
  readonly sequenceRevision: number;
  /** 本次是否递增修订(false=初版沿用 1,或事实未变沿用原值) */
  readonly revisionAdvanced: boolean;
  /** 实际落行数(幂等重发=0;新 detail_revision 快照=全部行) */
  readonly rowsWritten: number;
  readonly facts: SequenceFacts;
}

/** 发布输入 → 规则层裸事实(mediaId 原样透传;special 即上游判定,分类归规则层) */
function toSequenceLineInput(line: PublishSequenceLineFacts): SequenceLineInput {
  const episodes: SequenceEpisodeInput[] = line.episodes.map((episode) => ({
    episodeKey: episode.episodeKey,
    mediaId: episode.mediaId,
    seasonKey: episode.seasonKey,
    ordinal: episode.ordinal,
    special: episode.special,
  }));
  return { lineKey: line.lineKey, displayName: line.displayName, sortOrder: line.sortOrder, episodes };
}

/** 候选/已发布行 → 快照成员(比对最小事实集;仅有序位行参与导航快照) */
function toSnapshotMember(
  lineKey: string,
  episodeKey: string,
  ordinal: number,
  seasonKey: string | null,
  sequenceStatus: SequenceStatus,
): SequenceSnapshotMember {
  return { lineKey, episodeKey, ordinal, seasonKey, sequenceStatus };
}

/** 规则构建事实中的行状态(按线键+集键定位;找不到返回 null 交由调用方显式失败) */
function findBuiltRowStatus(
  facts: SequenceFacts,
  lineKey: string,
  episodeKey: string,
): SequenceStatus | null {
  for (const line of facts.lines) {
    if (line.lineKey !== lineKey) {
      continue;
    }
    for (const row of line.episodes) {
      if (row.episodeKey === episodeKey) {
        return row.sequenceStatus;
      }
    }
  }
  return null;
}

/**
 * publishSequence:发布独立导航序列(修订判定 + 行写入;调用方保证同事务)。
 *
 * 判定序(见文件头「修订语义」):初版 1 → 事实未变沿用 → 否则最新+1。
 * - 比对基准 = store.listLatestEpisodeSequences(同标题最大 detail_revision 下最大
 *   sequence_revision 的行)——「最新已发布导航快照」;
 * - 候选成员只含有序位集(ordinal !== null)行:无序位集无导航位(不入表),
 *   其增减不构成导航成员变化;
 * - 行状态取规则推导值(special 为上游裸事实,ordered/ambiguous 由重复键/序位推导),
 *   不回写调用方声明的分类;
 * - 写入按 (line, detail_revision, sequence_revision, episode) 逐行幂等:同快照
 *   重复发布(同 key 重放/异 key 重发)零新行;detail_revision 推进时同修订快照
 *   随新详情修订整片重发布(「与引用的 detailRevision 一同发布」),旧修订行不动;
 * - ordinal 非法(<=0)由 0007 CHECK 拒绝整体回滚(fail-loud,不静默纠正)。
 */
export function publishSequence(
  store: SequencePublicationStore,
  input: PublishSequenceInput,
): PublishSequenceOutcome {
  // 1. 规则面构建(行状态/线可导航性判定全在 domain;修订先占位,下方按语义回填)
  const built = buildSequence({
    sourceId: input.sourceId,
    titleId: input.titleId,
    detailRevision: input.detailRevision,
    sequenceRevision: 0,
    lines: input.lines.map(toSequenceLineInput),
  });

  // 2. 候选成员(仅有序位行;行状态用规则推导值)
  const candidateMembers: SequenceSnapshotMember[] = [];
  for (const line of built.lines) {
    for (const row of line.episodes) {
      if (row.ordinal !== null) {
        candidateMembers.push(
          toSnapshotMember(line.lineKey, row.episodeKey, row.ordinal, row.seasonKey, row.sequenceStatus),
        );
      }
    }
  }

  // 3. 修订判定(初版 1 → 未变沿用 → 最新+1;data-model §3)
  const latestRows = store.listLatestEpisodeSequences(input.householdId, input.titleId);
  let sequenceRevision = 1;
  let revisionAdvanced = false;
  if (latestRows.length > 0) {
    const latestRevision = latestRows.reduce((max, row) => Math.max(max, row.sequenceRevision), 0);
    const latestMembers = latestRows.map((row) =>
      toSnapshotMember(row.lineKey, row.episodeKey, row.ordinal, row.seasonKey, row.sequenceStatus),
    );
    if (sameNavigationSnapshot(latestMembers, candidateMembers)) {
      sequenceRevision = latestRevision;
    } else {
      sequenceRevision = latestRevision + 1;
      revisionAdvanced = true;
    }
  }
  const facts: SequenceFacts = { ...built, sequenceRevision };

  // 4. 行写入(逐行幂等守卫;仅有序位集入表)
  let rowsWritten = 0;
  for (const line of input.lines) {
    for (const episode of line.episodes) {
      if (episode.ordinal === null) {
        continue;
      }
      const rowStatus = findBuiltRowStatus(facts, line.lineKey, episode.episodeKey);
      if (rowStatus === null) {
        // 规则面缺行 = 输入与构建事实不一致(编程错误),显式失败不静默
        throw new Error(
          `publishSequence:构建事实缺行 line=${line.lineKey} episode=${episode.episodeKey}`,
        );
      }
      const existing = store.findEpisodeSequenceAtRevision(
        input.householdId,
        line.lineId,
        input.detailRevision,
        sequenceRevision,
        episode.episodeId,
      );
      if (existing !== undefined) {
        continue;
      }
      store.insertEpisodeSequence({
        householdId: input.householdId,
        titleId: input.titleId,
        lineId: line.lineId,
        detailRevision: input.detailRevision,
        sequenceRevision,
        episodeId: episode.episodeId,
        seasonKey: episode.seasonKey,
        ordinal: episode.ordinal,
        sequenceStatus: rowStatus,
      });
      rowsWritten += 1;
    }
  }

  return {
    sourceId: input.sourceId,
    titleId: input.titleId,
    detailRevision: input.detailRevision,
    sequenceRevision,
    revisionAdvanced,
    rowsWritten,
    facts,
  };
}

/* ------------------------------------------------------------------ */
/* 导航查询面(nextEpisodeFor;T059/T060 消费)                            */
/* ------------------------------------------------------------------ */

/**
 * 导航查询所需最小读面(结构子集):T027 store 绑定实现
 * (OnlineVodReadStatements 子类)满足之;全部单语句同步读、强制 household 条件。
 */
export interface SequenceNavigationStore {
  /** 稳定映射行(sourceId/current_detail_revision 事实源) */
  findTitle(householdId: string, titleId: string): VodTitleRow | undefined;
  /** 线路行(确定序 sort_order, id;线可导航性按本序首次出现判定) */
  listLinesByTitle(householdId: string, titleId: string): VodLineRow[];
  /** 单线行(线级导航入参归属校验) */
  findLine(householdId: string, lineId: string): VodLineRow | undefined;
  /** 当前导航快照(标题级:当前详情指针修订下、该指针下最大 sequence_revision 的行) */
  listCurrentEpisodeSequences(householdId: string, titleId: string): EpisodeSequenceRowWithKey[];
  /** 当前导航快照(线级) */
  listCurrentEpisodeSequencesByLine(householdId: string, lineId: string): EpisodeSequenceRowWithKey[];
}

/** nextEpisodeFor 入参(lineId=null → 标题级;指定 → 线级显式消歧入口) */
export interface NextEpisodeForInput {
  readonly householdId: string;
  readonly titleId: string;
  readonly lineId: string | null;
  readonly currentEpisodeKey: string;
}

/** 持久行 → 规则层行事实(键原样透传;mediaId 为子媒体稳定身份) */
function rowOfRulesRow(row: EpisodeSequenceRowWithKey): SequenceEpisodeRow {
  return {
    lineKey: row.lineKey,
    episodeKey: row.episodeKey,
    mediaId: row.mediaId,
    seasonKey: row.seasonKey,
    ordinal: row.ordinal,
    sequenceStatus: row.sequenceStatus,
  };
}

/**
 * nextEpisodeFor:标题级/线级导航查询(「物化后即可回答 EP01→EP02→EP03」)。
 *
 * - 当前快照 = 当前详情指针修订(vod_title.current_detail_revision)下、该指针下
 *   最大 sequence_revision 的序列行(「与 detailRevision 一同发布」的读侧对偶);
 * - 标题级(lineId=null):按线序装载全部线事实,委托规则面 computeNextEpisode
 *   (首个包含该键的可导航线;跨线/跨源不可能);
 * - 线级(lineId 指定):装载该线事实委托 computeLineNext(重复键线/镜像线的显式
 *   消歧入口);lineId 不存在/不属本标题 → unknown_episode(保守,不抛错、不猜);
 * - 线可导航性按持久线路序(sort_order,id)内 lineKey 首次出现重演规则面判据
 *   (vod_line 行键非空由 CHECK 保证,判据保留空键分支为防御性完整);
 * - 无序列行(未发布/空线)→ unknown_episode;判定语义全部在规则层,本函数只装载。
 */
export function nextEpisodeFor(
  store: SequenceNavigationStore,
  input: NextEpisodeForInput,
): NextEpisodeOutcome {
  const { householdId, titleId, lineId, currentEpisodeKey } = input;
  const title = store.findTitle(householdId, titleId);
  if (title === undefined) {
    return { status: 'ambiguous', next: null, reason: 'unknown_episode' };
  }

  // 线级:归属校验(跨标题 lineId 视同未知,不跨标题导航)
  const targetLineRow =
    lineId === null ? undefined : store.findLine(householdId, lineId);
  if (lineId !== null && (targetLineRow === undefined || targetLineRow.titleId !== titleId)) {
    return { status: 'ambiguous', next: null, reason: 'unknown_episode' };
  }

  const lines = store.listLinesByTitle(householdId, titleId);
  if (lines.length === 0) {
    return { status: 'ambiguous', next: null, reason: 'unknown_episode' };
  }
  const rows =
    lineId === null
      ? store.listCurrentEpisodeSequences(householdId, titleId)
      : store.listCurrentEpisodeSequencesByLine(householdId, lineId);

  // 线事实装载(线序 = sort_order,id;行按 ordinal,episode_id 有序)
  const rowsByLineId = new Map<string, EpisodeSequenceRowWithKey[]>();
  for (const row of rows) {
    const bucket = rowsByLineId.get(row.lineId);
    if (bucket === undefined) {
      rowsByLineId.set(row.lineId, [row]);
    } else {
      bucket.push(row);
    }
  }
  const seenLineKeys = new Set<string>();
  let targetLineFacts: SequenceLineFacts | undefined;
  const lineFacts: SequenceLineFacts[] = [];
  for (const line of lines) {
    const navigable = line.lineKey !== '' && !seenLineKeys.has(line.lineKey);
    if (navigable) {
      seenLineKeys.add(line.lineKey);
    }
    const lineRows = rowsByLineId.get(line.id) ?? [];
    const facts: SequenceLineFacts = {
      lineKey: line.lineKey,
      displayName: line.displayName,
      sortOrder: line.sortOrder,
      navigable,
      unsupportedReason: navigable ? null : 'duplicate_line_key',
      episodes: lineRows
        .slice()
        .sort((a, b) =>
          a.ordinal - b.ordinal !== 0 ? a.ordinal - b.ordinal : a.episodeId.localeCompare(b.episodeId),
        )
        .map(rowOfRulesRow),
    };
    lineFacts.push(facts);
    if (lineId !== null && line.id === lineId) {
      targetLineFacts = facts;
    }
  }

  if (lineId === null) {
    return computeNextEpisode(
      {
        sourceId: title.sourceId,
        titleId,
        detailRevision: title.currentDetailRevision,
        sequenceRevision: rows[0]?.sequenceRevision ?? 0,
        lines: lineFacts,
      },
      currentEpisodeKey,
    );
  }
  if (targetLineFacts === undefined) {
    // 线级入参已在上方归属校验,此处缺装载即结构异常;保守按未知键停止(不抛错、不猜)
    return { status: 'ambiguous', next: null, reason: 'unknown_episode' };
  }
  return computeLineNext(targetLineFacts, currentEpisodeKey);
}
