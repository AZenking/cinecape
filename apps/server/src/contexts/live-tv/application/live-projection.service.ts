import { createHash } from 'node:crypto';
import type { ExperienceProgrammeDto } from '@hmp/shared';
import { normalizeChannelName } from '@contexts/live-tv/domain/channel-normalizer';
import { pickCurrentNext } from '@contexts/live-tv/domain/live-time';
import { pickMainGroupLabel, type GroupTitleSource } from '@contexts/live-tv/domain/live-grouping';
import { loadAvailableMediaIdSet } from '@contexts/policy';
import { liveTvStore } from '@contexts/live-tv/application/live-tv-store.port';
import type {
  ChannelMetaRow,
  EpgChannelRow,
  ManualEpgBindingRow,
  MediaSourceRow,
  ProgrammeRow,
  SourceEntryRow,
} from '@contexts/live-tv/application/live-tv-store.port';

/**
 * 公共直播批量投影(T063/T065/T066;005 data-model §8、contracts/api.md §2、research R8;
 * 016 US2 T014 起扩展五级级联解析,016 research R2 / data-model §2.3/§3.2 / FR-003):
 *
 * 关联解析核心(自既有 EPG 匹配核心提取,不含 ProfilePolicy —— 公共直播不进入
 * 会话/档案/策略授权链):五级级联判定链(016 research R2,兼容 ADR-0008 手动锁定):
 * - L1 manual 锁定优先:绑定存在且有效 → 只用绑定对(终态,无排期也不回退,无节目 ≠ 失效);
 *   绑定失效(EPG 来源禁用/目标频道缺失/冲突)→ 关联与候选双双为空,保持无排期,
 *   **绝不回退 L2~L4**(ADR-0008:失效是配置事实,不自动改用其他来源);
 * - L2 precise:该频道 present 条目 × 启用 IPTV 来源(source_id 升序)→ 其启用的 EPG 目标源
 *   → epg_channel 以 upstream 标识精确匹配(SQLite BINARY 相等,不合并、不模糊猜测,
 *   conflicted=0 才胜出;多来源按 (source_id, entry_id) 升序取第一个有效关联)且有排期;
 * - L3 cascade:L2 未命中或排期空 → 家庭下 kind='epg' 且启用的源按
 *   priority ASC(数值越小越优先;同 priority 按源 id 升序稳定排序)逐源 tvg-id 精确补位,
 *   命中源 id 记入 epgSourceId;
 * - L4 alias:tvg-id 全未命中 → normalizeChannelName(频道名) 与各源 EPG 频道显示名
 *   归一化键在内存 Map 中比对(纯函数 T005,去标点/大小写/清晰度后缀);
 * - L5 none:全链未命中 → 无关联(matchMode='none'),频道正常可播。
 * 排期裁决:候选按上述顺序排序,取首个「有节目窗口」的命中;manual 候选不经排期判定
 * (终态)。associationByMedia 保持既有语义(manual 有效→绑定对/失效→null/否则精确关联对,
 * 不含级联),guide 窗口与 refresh-publish 等 016 前消费方零适配。
 *
 * 集合查询(防 N+1 不变式;次数不随频道数/源数线性增长):
 *   1 频道 + 1 可用性(复用 policy.batch-context 的集合查询,join 链一致)+
 *   1 source_entry + 1 media_source + 1 manual_epg_binding + 1 epg_channel +
 *   2 programme 窗口(按「候选关联对全集」IN 过滤;all 区固定 9 次同步查询,与 016
 *   之前完全一致 —— 级联所需的源 priority 与 EPG 频道显示名分别并入既有 media_source /
 *   epg_channel 投影列,级联/别名裁决全部在内存 Map 完成,零新增 SQL,绝不在频道
 *   循环体内逐频道/逐源查询)。
 *
 * 同步快照:better-sqlite3 同步驱动,单请求全部查询之间无并发写穿插;
 * now 由调用方冻结传入(同一响应的 now/timezone/catalogRevision 同源)。
 *
 * 不透明 programme key:由内部 epg_programme.id 经单向 sha256 映射生成,
 * 不下发来源 ID / XMLTV 原始标识 / 路径;同起点并列的稳定性判定亦使用该公共 key。
 *
 * 008-repository-extraction(T008,ADR-0015 D1):SQL 构造自本文件逐字迁移至
 * infrastructure/live-tv-store.drizzle.ts(LiveTvStore 端口 + seam 槽),
 * 关联/分组/窗口判定逻辑原样留存;loadLiveChannelWindows 签名(无 db 参数)
 * 不变,跨上下文消费方(personal-data favorites / epg binding-core)零适配。
 */

/** 频道级投影结果(media 投影字段 + 稳定主分组 + current/next) */
export interface LiveChannelProjection {
  readonly mediaId: string;
  readonly title: string;
  readonly description: string | null;
  readonly posterRef: string | null;
  readonly contentLevel: number | null;
  /** 稳定主分组显示名;null = 无分组(呈现为「其他」) */
  readonly mainGroupLabel: string | null;
  readonly current: ExperienceProgrammeDto | null;
  readonly next: ExperienceProgrammeDto | null;
  /** 016 US2 五级链命中方式(manual>precise>cascade>alias>none);optional 供 016 前消费方零适配 */
  readonly matchMode?: 'manual' | 'precise' | 'cascade' | 'alias' | 'none';
  /** 016 US2 本次命中排期的 EPG 源 ID(诊断用);未命中为 null;includeProgrammes=false 时不判定缺省 */
  readonly epgSourceId?: string | null;
}

/** programme 公共不透明 key(内部 ID → sha256 截断;不含来源/XMLTV/路径信息) */
export function programmeKeyOf(internalId: string): string {
  const digest = createHash('sha256').update(`hmp-programme\u0000${internalId}`, 'utf8').digest('hex');
  return `pg-${digest.slice(0, 24)}`;
}


/** 关联对键(source_id + \u0000 + xmltv_channel_id;SQL 端以 char(0) 拼接比较) */
function pairKeyOf(sourceId: string, xmltvChannelId: string): string {
  return `${sourceId}\u0000${xmltvChannelId}`;
}

/** 单频道级联候选(016 US2 T014;matchMode 为命中方式,L5 none 仅由裁决产生) */
export interface AssociationCandidate {
  readonly sourceId: string;
  readonly xmltvChannelId: string;
  readonly matchMode: 'manual' | 'precise' | 'cascade' | 'alias';
}

/** L4 别名索引单源视图(归一化显示名键 → xmltvChannelId;同源同键取 id 升序首个) */
export interface AliasSourceIndex {
  readonly sourceId: string;
  readonly byKey: ReadonlyMap<string, string>;
}

/** 级联候选构建输入(全部为集合装载产物;纯函数零 IO,T012 直测) */
export interface CascadeCandidateInput {
  readonly channelTitle: string;
  /** manual 模式绑定行(仓储仅装载 mode='manual';undefined = 无行或 auto 墓碑) */
  readonly manual: ManualEpgBindingRow | undefined;
  readonly entries: readonly SourceEntryRow[];
  readonly sourceById: ReadonlyMap<string, MediaSourceRow>;
  readonly epgChannelByKey: ReadonlyMap<string, EpgChannelRow>;
  /** 启用 EPG 源,已按 (priority ASC, id ASC) 排序 */
  readonly epgSourcesOrdered: readonly MediaSourceRow[];
  /** L4 别名索引(与 epgSourcesOrdered 同序) */
  readonly aliasIndex: readonly AliasSourceIndex[];
}

/** 级联裁决结果(pairKey null = L5 全落空) */
export interface CascadeAdjudication {
  readonly pairKey: string | null;
  readonly matchMode: 'manual' | 'precise' | 'cascade' | 'alias' | 'none';
  readonly epgSourceId: string | null;
}

/**
 * L4 别名索引(纯函数):启用 EPG 源 × 非冲突频道显示名归一化键。
 * 归一化空串(纯噪音)不收录;同源同键取 xmltvChannelId 升序首个(确定性);
 * 输出按 epgSourcesOrdered 顺序排列,保证别名候选的源级优先级序。
 */
export function buildAliasIndex(
  epgChannelRows: readonly EpgChannelRow[],
  sourceById: ReadonlyMap<string, MediaSourceRow>,
  epgSourcesOrdered: readonly MediaSourceRow[],
): AliasSourceIndex[] {
  const bySource = new Map<string, Map<string, string>>();
  for (const row of epgChannelRows) {
    if (row.conflicted !== 0) {
      continue;
    }
    const source = sourceById.get(row.sourceId);
    if (source === undefined || source.kind !== 'epg' || source.enabled !== 1) {
      continue;
    }
    const key = normalizeChannelName(row.displayName);
    if (key === '') {
      continue;
    }
    const bucket = bySource.get(row.sourceId);
    if (bucket === undefined) {
      bySource.set(row.sourceId, new Map([[key, row.xmltvChannelId]]));
      continue;
    }
    const current = bucket.get(key);
    if (current === undefined || row.xmltvChannelId < current) {
      bucket.set(key, row.xmltvChannelId);
    }
  }
  const index: AliasSourceIndex[] = [];
  for (const source of epgSourcesOrdered) {
    const bucket = bySource.get(source.id);
    if (bucket !== undefined) {
      index.push({ sourceId: source.id, byKey: bucket });
    }
  }
  return index;
}

/**
 * L2 精确关联候选(既有自动精确关联语义逐字保持):
 * present 条目按 (source_id, entry_id) 升序;来源链两端启用;upstream 非空;
 * epg_channel 精确命中且 conflicted=0;同来源首条目胜出(triedSources 去重)。
 */
function resolvePreciseCandidate(
  entries: readonly SourceEntryRow[],
  sourceById: ReadonlyMap<string, MediaSourceRow>,
  epgChannelByKey: ReadonlyMap<string, EpgChannelRow>,
): AssociationCandidate | null {
  const sorted = [...entries].sort((left, right) =>
    left.sourceId !== right.sourceId
      ? left.sourceId < right.sourceId
        ? -1
        : 1
      : left.entryId < right.entryId
        ? -1
        : 1,
  );
  const triedSources = new Set<string>();
  for (const entry of sorted) {
    if (triedSources.has(entry.sourceId)) {
      continue;
    }
    triedSources.add(entry.sourceId);
    const iptv = sourceById.get(entry.sourceId);
    if (iptv === undefined || iptv.kind !== 'iptv' || iptv.enabled !== 1 || iptv.epgSourceId === null) {
      continue;
    }
    const epg = sourceById.get(iptv.epgSourceId);
    if (epg === undefined || epg.kind !== 'epg' || epg.enabled !== 1) {
      continue;
    }
    if (entry.upstreamChannelId === null || entry.upstreamChannelId === '') {
      continue;
    }
    const channelRow = epgChannelByKey.get(pairKeyOf(iptv.epgSourceId, entry.upstreamChannelId));
    if (channelRow !== undefined && channelRow.conflicted === 0) {
      return { sourceId: iptv.epgSourceId, xmltvChannelId: entry.upstreamChannelId, matchMode: 'precise' };
    }
  }
  return null;
}

/**
 * 五级级联候选构建(纯函数;016 research R2 L1~L4,内存夹具/集合装载产物直算):
 * - L1 manual 锁定(ADR-0008):有效 → 唯一 manual 候选(终态);失效(源禁用/频道缺失/
 *   冲突)→ 空候选,绝不产出 L2~L4 候选(不回退是配置事实语义);
 * - L2 precise → L3 cascade(priority ASC 逐源 tvg-id;conflicted=0)→ L4 alias;
 * - 同关联对只保留最高优先级形态(precise>cascade>alias 各一次,首见优先)。
 */
export function buildAssociationCandidates(input: CascadeCandidateInput): readonly AssociationCandidate[] {
  const { channelTitle, manual, entries, sourceById, epgChannelByKey, epgSourcesOrdered, aliasIndex } = input;
  if (manual !== undefined) {
    const key =
      manual.epgSourceId === null || manual.xmltvChannelId === null
        ? null
        : pairKeyOf(manual.epgSourceId, manual.xmltvChannelId);
    const source = manual.epgSourceId === null ? undefined : sourceById.get(manual.epgSourceId);
    const target =
      key === null || source === undefined || source.kind !== 'epg' || source.enabled !== 1
        ? undefined
        : epgChannelByKey.get(key);
    if (key === null || target === undefined || target.conflicted !== 0) {
      // 失效不回退:手动失效是配置事实,候选为空(裁决落到 L5 none,保持无排期)
      return [];
    }
    return [
      {
        sourceId: manual.epgSourceId as string,
        xmltvChannelId: manual.xmltvChannelId as string,
        matchMode: 'manual',
      },
    ];
  }
  const candidates: AssociationCandidate[] = [];
  const seenPairs = new Set<string>();
  const push = (candidate: AssociationCandidate): void => {
    const key = pairKeyOf(candidate.sourceId, candidate.xmltvChannelId);
    if (seenPairs.has(key)) {
      return;
    }
    seenPairs.add(key);
    candidates.push(candidate);
  };
  // L2 精确(既有语义)
  const precise = resolvePreciseCandidate(entries, sourceById, epgChannelByKey);
  if (precise !== null) {
    push(precise);
  }
  // L3 级联:启用 EPG 源 priority ASC(同 priority id ASC)逐源 tvg-id 精确,每源首个命中
  const tvgIds = [
    ...new Set(
      entries
        .filter((row) => row.upstreamChannelId !== null && row.upstreamChannelId !== '')
        .map((row) => row.upstreamChannelId as string),
    ),
  ].sort();
  for (const epgSource of epgSourcesOrdered) {
    for (const tvgId of tvgIds) {
      const channelRow = epgChannelByKey.get(pairKeyOf(epgSource.id, tvgId));
      if (channelRow !== undefined && channelRow.conflicted === 0) {
        push({ sourceId: epgSource.id, xmltvChannelId: tvgId, matchMode: 'cascade' });
        break;
      }
    }
  }
  // L4 别名:归一化键内存比对(每源取 id 升序首个;频道名无法归一化则跳过)
  const aliasKey = normalizeChannelName(channelTitle);
  if (aliasKey !== '') {
    for (const index of aliasIndex) {
      const xmltvChannelId = index.byKey.get(aliasKey);
      if (xmltvChannelId !== undefined) {
        push({ sourceId: index.sourceId, xmltvChannelId, matchMode: 'alias' });
      }
    }
  }
  return candidates;
}

/**
 * 五级裁决(纯函数):L1 manual 终态(不经排期判定,无节目 ≠ 失效);L2~L4 按候选序取
 * 首个有节目窗口的命中;全落空 → L5 none(pairKey/epgSourceId 双 null)。
 */
export function adjudicateCascade(
  candidates: readonly AssociationCandidate[],
  hasWindows: (pairKey: string) => boolean,
): CascadeAdjudication {
  const manual = candidates.find((candidate) => candidate.matchMode === 'manual');
  if (manual !== undefined) {
    return {
      pairKey: pairKeyOf(manual.sourceId, manual.xmltvChannelId),
      matchMode: 'manual',
      epgSourceId: manual.sourceId,
    };
  }
  for (const candidate of candidates) {
    const pairKey = pairKeyOf(candidate.sourceId, candidate.xmltvChannelId);
    if (hasWindows(pairKey)) {
      return { pairKey, matchMode: candidate.matchMode, epgSourceId: candidate.sourceId };
    }
  }
  return { pairKey: null, matchMode: 'none', epgSourceId: null };
}

/** 频道元数据行发布面(index.ts 既有再导出落点不变;定义自 008 起位于仓储端口) */
export type { ChannelMetaRow };

/** 关联解析核心的集合装载结果(US6 T113 起供 contexts/epg/domain/binding-core 复用) */
export interface ChannelAssociationCore {
  /** 家庭全部频道元数据行(含不可用;可用性由 availableIds 判定) */
  readonly channelRows: ChannelMetaRow[];
  /** 家庭真实可用频道集合(present 条目 × 启用来源 × 播放资源,无政策语义) */
  readonly availableIds: Set<string>;
  /** mediaId → 关联对 pairKey;null = 无有效关联(manual 失效不回退/自动无匹配;
   *  016 起不含级联/别名 —— 级联属投影增强,guide/publish 消费方语义不变) */
  readonly associationByMedia: Map<string, string | null>;
  /** mediaId → 五级级联有序候选(016 US2 T014;仅可用频道;manual 失效 → [](锁定不回退)) */
  readonly candidatesByMedia: Map<string, readonly AssociationCandidate[]>;
  /** mediaId → 分组标题来源集合(主分组选择输入;guide 不消费) */
  readonly groupSourcesByMedia: Map<string, GroupTitleSource[]>;
}

/**
 * 关联解析核心(T063 内联逻辑自 US6 T113 起平移为独立导出;016 T014 扩展五级级联候选;
 * 供 live 投影与 epg guide 窗口共用,不建立第二套匹配算法):
 * 固定 6 次集合查询 —— 1 频道 + 1 可用性 + 1 source_entry + 1 media_source +
 * 1 manual_epg_binding + 1 epg_channel(priority/displayName 为既有查询投影列增量,
 * 零新增 SQL);级联源序(priority ASC, id ASC)与别名索引均在内存构建;可用性复用
 * policy.batch-context 的 loadAvailableMediaIdSet(join 链一致、无政策语义);
 * 解析规则见文件头注释。
 */
export function loadChannelAssociationCore(
  householdId: string,
  options: { readonly mediaIds?: readonly string[] } = {},
): ChannelAssociationCore {
  const mediaIds = options.mediaIds;
  const store = liveTvStore();

  // 1) 频道集合 + 家庭真实可用性(集合查询:present 条目 × 启用来源 × 播放资源)
  const channelRows: ChannelMetaRow[] = store.listChannelRows(householdId, mediaIds);
  const availableIds = loadAvailableMediaIdSet(householdId);

  // 2) 启用 IPTV 来源 × present 条目(一次查询同时供主分组与关联解析)
  const entryRows: SourceEntryRow[] = store.listPresentIptvEntryRows(householdId);
  const sourceRows: MediaSourceRow[] = store.listMediaSourceRows(householdId);
  const manualRows: ManualEpgBindingRow[] = store.listManualBindingRows(householdId);
  const epgChannelRows: EpgChannelRow[] = store.listEpgChannelRows(householdId);

  const sourceById = new Map(sourceRows.map((row) => [row.id, row] as const));
  const epgChannelByKey = new Map(
    epgChannelRows.map((row) => [pairKeyOf(row.sourceId, row.xmltvChannelId), row] as const),
  );
  const manualByMedia = new Map(manualRows.map((row) => [row.mediaId, row] as const));
  const entriesByMedia = new Map<string, SourceEntryRow[]>();
  for (const row of entryRows) {
    const list = entriesByMedia.get(row.mediaId);
    if (list === undefined) {
      entriesByMedia.set(row.mediaId, [row]);
    } else {
      list.push(row);
    }
  }

  // 3) 关联解析(五级级联,内存裁决):启用 EPG 源 (priority ASC, id ASC) + 别名索引
  const epgSourcesOrdered = sourceRows
    .filter((row) => row.kind === 'epg' && row.enabled === 1)
    .sort((left, right) =>
      left.priority !== right.priority ? left.priority - right.priority : left.id < right.id ? -1 : 1,
    );
  const aliasIndex = buildAliasIndex(epgChannelRows, sourceById, epgSourcesOrdered);

  const associationByMedia = new Map<string, string | null>();
  const candidatesByMedia = new Map<string, readonly AssociationCandidate[]>();
  for (const channel of channelRows) {
    if (!availableIds.has(channel.id)) {
      continue;
    }
    const manual = manualByMedia.get(channel.id);
    const candidates = buildAssociationCandidates({
      channelTitle: channel.title,
      manual,
      entries: entriesByMedia.get(channel.id) ?? [],
      sourceById,
      epgChannelByKey,
      epgSourcesOrdered,
      aliasIndex,
    });
    candidatesByMedia.set(channel.id, candidates);
    // 关联面(向后兼容):manual 有效 → 绑定对;manual 失效 → null(不回退);
    // 无 manual → 精确关联对(与 016 之前逐字一致,不含级联/别名)
    if (manual !== undefined) {
      const manualCandidate = candidates.find((candidate) => candidate.matchMode === 'manual');
      associationByMedia.set(
        channel.id,
        manualCandidate === undefined
          ? null
          : pairKeyOf(manualCandidate.sourceId, manualCandidate.xmltvChannelId),
      );
      continue;
    }
    const precise = candidates.find((candidate) => candidate.matchMode === 'precise');
    associationByMedia.set(
      channel.id,
      precise === undefined ? null : pairKeyOf(precise.sourceId, precise.xmltvChannelId),
    );
  }
  // 分组标题来源集合(主分组选择输入;live 消费,guide 不消费)
  const groupSourcesByMedia = new Map<string, GroupTitleSource[]>();
  for (const row of entryRows) {
    const list = groupSourcesByMedia.get(row.mediaId);
    const source: GroupTitleSource = { sourceId: row.sourceId, entryId: row.entryId, groupTitle: row.groupTitle };
    if (list === undefined) {
      groupSourcesByMedia.set(row.mediaId, [source]);
    } else {
      list.push(source);
    }
  }
  return { channelRows, availableIds, associationByMedia, candidatesByMedia, groupSourcesByMedia };
}

/**
 * 批量直播投影:可用频道 → 稳定主分组 → 五级级联关联(L1 manual 锁定 / L2 精确 /
 * L3 priority 级联 / L4 别名 / L5 none)→ 批量节目窗口。options.mediaIds 过滤供单频道
 * 路径复用同一管线(仍是同一套集合查询);options.includeProgrammes=false 供分组列表
 * 跳过节目窗口(分组不依赖节目;此时不做级联排期裁决,matchMode/epgSourceId 缺省)。
 *
 * 防 N+1 不变式(FR-007):SQL 查询总次数为固定预算 —— 集合装载(频道/可用性/条目/
 * 来源/绑定/EPG 频道各 1 次)+ 节目窗口恒定 2 次(按「候选关联对全集」IN 过滤,
 * 候选对=各频道 precise/cascade/alias/manual 候选的并集,来自内存 Map,不随频道数或
 * EPG 源数增加查询次数);级联裁决(adjudicateCascade)纯内存完成,绝不在频道循环体内
 * 执行逐频道/逐源 SQL。
 */
export function loadLiveChannelWindows(
  householdId: string,
  nowMs: number,
  options: { readonly mediaIds?: readonly string[]; readonly includeProgrammes?: boolean } = {},
): LiveChannelProjection[] {
  const mediaIds = options.mediaIds;
  const includeProgrammes = options.includeProgrammes ?? true;
  const nowIso = new Date(nowMs).toISOString();

  // 1~3) 频道 + 可用性 + 五级级联候选解析(集合查询核心,T113 平移为 loadChannelAssociationCore 共用)
  const core = loadChannelAssociationCore(householdId, { mediaIds });
  const { channelRows, availableIds, candidatesByMedia, groupSourcesByMedia } = core;

  // 4) 批量节目窗口:覆盖 now 的行 + 每候选关联对最早未来行(两次集合查询,次数固定)
  const neededPairs = new Set<string>();
  for (const candidates of candidatesByMedia.values()) {
    for (const candidate of candidates) {
      neededPairs.add(pairKeyOf(candidate.sourceId, candidate.xmltvChannelId));
    }
  }
  const pairKeys = includeProgrammes ? [...neededPairs] : [];
  const rowsByPair = new Map<string, ProgrammeRow[]>();
  if (pairKeys.length > 0) {
    const store = liveTvStore();
    const covering = store.listCoveringProgrammeRows(householdId, nowIso, pairKeys);
    // 最早未来行:每关联对 MIN(starts_at>now) 的全部并列行(同起点并列由 key 升序决胜)
    const nextEarliest = store.listNextEarliestProgrammeRows(householdId, nowIso, pairKeys);
    for (const row of [...covering, ...nextEarliest]) {
      const key = pairKeyOf(row.sourceId, row.xmltvChannelId);
      const list = rowsByPair.get(key);
      if (list === undefined) {
        rowsByPair.set(key, [row]);
      } else {
        list.push(row);
      }
    }
  }
  // 排期存在性(内存判定,输入仅来自上述固定两次窗口查询)
  const hasWindows = (pairKey: string): boolean => (rowsByPair.get(pairKey)?.length ?? 0) > 0;

  // 5) 组装投影(仅可用频道;级联裁决纯内存;主分组按 (source_id, entry_id) 升序取第一非空)
  const projections: LiveChannelProjection[] = [];
  for (const channel of channelRows) {
    if (!availableIds.has(channel.id)) {
      continue;
    }
    // 五级裁决:L1 manual 终态;L2~L4 首个有排期候选;L5 none;includeProgrammes=false 不判定
    const adjudication = includeProgrammes
      ? adjudicateCascade(candidatesByMedia.get(channel.id) ?? [], hasWindows)
      : null;
    const pairKey = adjudication?.pairKey ?? null;
    const rows = pairKey === null ? [] : rowsByPair.get(pairKey) ?? [];
    const windows = pickCurrentNext(
      rows.map((row) => ({
        key: programmeKeyOf(row.id),
        title: row.title,
        description: row.description,
        posterRef: row.posterRef,
        startsAt: row.startsAt,
        endsAt: row.endsAt,
      })),
      nowMs,
    );
    const groupSources: GroupTitleSource[] = groupSourcesByMedia.get(channel.id) ?? [];
    projections.push({
      mediaId: channel.id,
      title: channel.title,
      description: channel.description,
      posterRef: channel.posterRef,
      contentLevel: channel.contentLevel,
      mainGroupLabel: pickMainGroupLabel(groupSources),
      current: windows.current,
      next: windows.next,
      ...(adjudication === null
        ? {}
        : { matchMode: adjudication.matchMode, epgSourceId: adjudication.epgSourceId }),
    });
  }
  // 稳定顺序:名称 + 稳定标识(分区排序核心在其上按 section 再排)
  projections.sort((left, right) =>
    left.title !== right.title ? (left.title < right.title ? -1 : 1) : left.mediaId < right.mediaId ? -1 : 1,
  );
  return projections;
}
