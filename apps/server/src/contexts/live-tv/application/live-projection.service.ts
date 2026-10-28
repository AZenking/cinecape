import { createHash } from 'node:crypto';
import type { ExperienceProgrammeDto } from '@hmp/shared';
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
 * 公共直播批量投影(T063/T065/T066;005 data-model §8、contracts/api.md §2、research R8):
 *
 * 关联解析核心(自既有 EPG 匹配核心提取,不含 ProfilePolicy —— 公共直播不进入
 * 会话/档案/策略授权链;语义与 epg.service 手动优先规则一致,批量集合化实现):
 * - manual 有效 → 只用 manual 目标;manual 失效(EPG 来源禁用/目标频道缺失/冲突)
 *   → 该频道无节目(不回退自动/其他来源,data-model「手动 EPG 关联失效保持 unavailable,
 *   不回退其他来源」);无行或 auto 墓碑 → 沿用自动精确关联;
 * - 自动:该频道 present 条目 × 启用 IPTV 来源(source_id 升序)→ 其启用的 EPG 目标源
 *   → epg_channel 以 upstream 标识精确匹配(SQLite BINARY 相等,不合并、不模糊猜测,
 *   conflicted=0 才胜出);多来源按 (source_id, entry_id) 升序取第一个有效关联。
 *
 * 集合查询(次数不随频道数线性增长;all 区固定 9 次同步查询):
 *   1 频道 + 1 可用性(复用 policy.batch-context 的集合查询,join 链一致)+
 *   1 source_entry + 1 media_source + 1 manual_epg_binding + 1 epg_channel +
 *   2 programme 窗口(覆盖 now 的行 / 每关联对最早未来行,均按关联对过滤)
 *   (+ 单频道路径同样固定次数);绝不在循环内调用单频道授权服务或逐频道取节目。
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

/** 频道元数据行发布面(index.ts 既有再导出落点不变;定义自 008 起位于仓储端口) */
export type { ChannelMetaRow };

/** 关联解析核心的集合装载结果(US6 T113 起供 contexts/epg/domain/binding-core 复用) */
export interface ChannelAssociationCore {
  /** 家庭全部频道元数据行(含不可用;可用性由 availableIds 判定) */
  readonly channelRows: ChannelMetaRow[];
  /** 家庭真实可用频道集合(present 条目 × 启用来源 × 播放资源,无政策语义) */
  readonly availableIds: Set<string>;
  /** mediaId → 关联对 pairKey;null = 无有效关联(manual 失效不回退/自动无匹配) */
  readonly associationByMedia: Map<string, string | null>;
  /** mediaId → 分组标题来源集合(主分组选择输入;guide 不消费) */
  readonly groupSourcesByMedia: Map<string, GroupTitleSource[]>;
}

/**
 * 关联解析核心(T063 内联逻辑自 US6 T113 起平移为独立导出,语义逐字不变;
 * 供 live 投影与 epg guide 窗口共用,不建立第二套匹配算法):
 * 固定 6 次集合查询 —— 1 频道 + 1 可用性 + 1 source_entry + 1 media_source +
 * 1 manual_epg_binding + 1 epg_channel;可用性复用 policy.batch-context 的
 * loadAvailableMediaIdSet(join 链一致、无政策语义);关联解析规则见文件头注释。
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

  // 3) 关联解析(手动优先/失效不回退/自动精确),收集每频道目标对
  const associationByMedia = new Map<string, string | null>();
  for (const channel of channelRows) {
    if (!availableIds.has(channel.id)) {
      continue;
    }
    const manual = manualByMedia.get(channel.id);
    if (manual !== undefined) {
      // manual 目标校验:EPG 源存在且启用 + 目标频道存在且未冲突
      const source = manual.epgSourceId === null ? undefined : sourceById.get(manual.epgSourceId);
      const key =
        manual.epgSourceId === null || manual.xmltvChannelId === null
          ? null
          : pairKeyOf(manual.epgSourceId, manual.xmltvChannelId);
      const target =
        key === null || source === undefined || source.kind !== 'epg' || source.enabled !== 1
          ? undefined
          : epgChannelByKey.get(key);
      if (key === null || target === undefined || target.conflicted !== 0) {
        // 失效不回退:手动失效是配置事实,不自动改用其他来源
        associationByMedia.set(channel.id, null);
        continue;
      }
      associationByMedia.set(channel.id, key);
      continue;
    }
    // 自动精确关联:present 条目按 (source_id, entry_id) 升序;来源链两端启用;conflicted=0
    const entries = [...(entriesByMedia.get(channel.id) ?? [])].sort((left, right) =>
      left.sourceId !== right.sourceId ? (left.sourceId < right.sourceId ? -1 : 1) : left.entryId < right.entryId ? -1 : 1,
    );
    const triedSources = new Set<string>();
    let resolved: string | null = null;
    for (const entry of entries) {
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
      const key = pairKeyOf(iptv.epgSourceId, entry.upstreamChannelId);
      const channelRow = epgChannelByKey.get(key);
      if (channelRow !== undefined && channelRow.conflicted === 0) {
        resolved = key;
        break;
      }
    }
    associationByMedia.set(channel.id, resolved);
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
  return { channelRows, availableIds, associationByMedia, groupSourcesByMedia };
}

/**
 * 批量直播投影:可用频道 → 稳定主分组 → 关联(手动优先/失效不回退/自动精确)→
 * 批量节目窗口。options.mediaIds 过滤供单频道路径复用同一管线(仍是同一套集合查询);
 * options.includeProgrammes=false 供分组列表跳过节目窗口(分组不依赖节目)。
 */
export function loadLiveChannelWindows(
  householdId: string,
  nowMs: number,
  options: { readonly mediaIds?: readonly string[]; readonly includeProgrammes?: boolean } = {},
): LiveChannelProjection[] {
  const mediaIds = options.mediaIds;
  const includeProgrammes = options.includeProgrammes ?? true;
  const nowIso = new Date(nowMs).toISOString();

  // 1~3) 频道 + 可用性 + 关联解析(集合查询核心,T113 平移为 loadChannelAssociationCore 共用)
  const core = loadChannelAssociationCore(householdId, { mediaIds });
  const { channelRows, availableIds, associationByMedia, groupSourcesByMedia } = core;

  // 4) 批量节目窗口:覆盖 now 的行 + 每关联对最早未来行(两次集合查询)
  const neededPairs = new Set<string>();
  for (const pairKey of associationByMedia.values()) {
    if (pairKey !== null) {
      neededPairs.add(pairKey);
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

  // 5) 组装投影(仅可用频道;current/next 经时间判定核心;主分组按 (source_id, entry_id) 升序取第一非空)
  const projections: LiveChannelProjection[] = [];
  for (const channel of channelRows) {
    if (!availableIds.has(channel.id)) {
      continue;
    }
    const association = associationByMedia.get(channel.id);
    const pairKey = association ?? null;
    const rows = pairKey === null ? [] : rowsByPair.get(pairKey) ?? [];
    const windows = pickCurrentNext(
      rows.map((row) => ({
        key: programmeKeyOf(row.id),
        title: row.title,
        description: row.description,
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
    });
  }
  // 稳定顺序:名称 + 稳定标识(分区排序核心在其上按 section 再排)
  projections.sort((left, right) =>
    left.title !== right.title ? (left.title < right.title ? -1 : 1) : left.mediaId < right.mediaId ? -1 : 1,
  );
  return projections;
}
