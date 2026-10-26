import { createHash } from 'node:crypto';
import { and, eq, inArray, sql } from 'drizzle-orm';
import type { ExperienceProgrammeDto } from '@hmp/shared';
import { pickCurrentNext } from './live-time';
import { normalizeGroupTitle, pickMainGroupLabel, type GroupTitleSource } from './live-grouping';
import { getDb } from '../auth/db';
import { loadAvailableMediaIdSet } from '../policy/policy.batch-context';
import { epgChannel, epgProgramme, manualEpgBinding, mediaItem, mediaSource, sourceEntry } from '../../database/schema';

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

interface SourceEntryRow {
  sourceId: string;
  entryId: string;
  mediaId: string;
  upstreamChannelId: string | null;
  groupTitle: string | null;
}

interface MediaSourceRow {
  id: string;
  kind: string;
  enabled: number;
  epgSourceId: string | null;
}

interface EpgChannelRow {
  sourceId: string;
  xmltvChannelId: string;
  conflicted: number;
}

interface ProgrammeRow {
  id: string;
  sourceId: string;
  xmltvChannelId: string;
  title: string;
  description: string | null;
  startsAt: string;
  endsAt: string;
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

function programmeRowOf(raw: {
  id: string;
  source_id: string;
  xmltv_channel_id: string;
  title: string;
  description: string | null;
  starts_at: string;
  ends_at: string;
}): ProgrammeRow {
  return {
    id: raw.id,
    sourceId: raw.source_id,
    xmltvChannelId: raw.xmltv_channel_id,
    title: raw.title,
    description: raw.description,
    startsAt: raw.starts_at,
    endsAt: raw.ends_at,
  };
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
  const db = getDb();
  const nowIso = new Date(nowMs).toISOString();

  // 1) 频道集合 + 家庭真实可用性(集合查询:present 条目 × 启用来源 × 播放资源)
  const channelRows = db
    .select({
      id: mediaItem.id,
      title: mediaItem.title,
      description: mediaItem.description,
      posterRef: mediaItem.posterRef,
      contentLevel: mediaItem.contentLevel,
    })
    .from(mediaItem)
    .where(
      mediaIds === undefined
        ? and(eq(mediaItem.householdId, householdId), eq(mediaItem.type, 'channel'))
        : and(eq(mediaItem.householdId, householdId), eq(mediaItem.type, 'channel'), inArray(mediaItem.id, [...mediaIds])),
    )
    .all();
  const availableIds = loadAvailableMediaIdSet(db, householdId);

  // 2) 启用 IPTV 来源 × present 条目(一次查询同时供主分组与关联解析)
  const entryRows: SourceEntryRow[] = db
    .select({
      sourceId: sourceEntry.sourceId,
      entryId: sourceEntry.id,
      mediaId: sourceEntry.mediaId,
      upstreamChannelId: sourceEntry.upstreamChannelId,
      groupTitle: sourceEntry.groupTitle,
    })
    .from(sourceEntry)
    .innerJoin(
      mediaSource,
      and(
        eq(mediaSource.householdId, sourceEntry.householdId),
        eq(mediaSource.id, sourceEntry.sourceId),
        eq(mediaSource.kind, 'iptv'),
        eq(mediaSource.enabled, 1),
      ),
    )
    .where(
      and(
        eq(sourceEntry.householdId, householdId),
        eq(sourceEntry.present, 1),
        sql`${sourceEntry.mediaId} IS NOT NULL`,
      ),
    )
    .all()
    .filter((row): row is SourceEntryRow & { mediaId: string } => row.mediaId !== null);
  const sourceRows: MediaSourceRow[] = db
    .select({ id: mediaSource.id, kind: mediaSource.kind, enabled: mediaSource.enabled, epgSourceId: mediaSource.epgSourceId })
    .from(mediaSource)
    .where(eq(mediaSource.householdId, householdId))
    .all();
  const manualRows = db
    .select({ mediaId: manualEpgBinding.mediaId, epgSourceId: manualEpgBinding.epgSourceId, xmltvChannelId: manualEpgBinding.xmltvChannelId })
    .from(manualEpgBinding)
    .where(and(eq(manualEpgBinding.householdId, householdId), eq(manualEpgBinding.mode, 'manual')))
    .all();
  const epgChannelRows: EpgChannelRow[] = db
    .select({ sourceId: epgChannel.sourceId, xmltvChannelId: epgChannel.xmltvChannelId, conflicted: epgChannel.conflicted })
    .from(epgChannel)
    .where(eq(epgChannel.householdId, householdId))
    .all();

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
  const associationByMedia = new Map<string, { pairKey: string } | 'invalid'>();
  const neededPairs = new Set<string>();
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
        associationByMedia.set(channel.id, 'invalid');
        continue;
      }
      associationByMedia.set(channel.id, { pairKey: key });
      neededPairs.add(key);
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
    if (resolved !== null) {
      associationByMedia.set(channel.id, { pairKey: resolved });
      neededPairs.add(resolved);
    }
  }

  // 4) 批量节目窗口:覆盖 now 的行 + 每关联对最早未来行(两次集合查询)
  const pairKeys = includeProgrammes ? [...neededPairs] : [];
  const rowsByPair = new Map<string, ProgrammeRow[]>();
  if (pairKeys.length > 0) {
    const pairExpression = sql`(${epgProgramme.sourceId} || char(0) || ${epgProgramme.xmltvChannelId})`;
    const pairFilter = inArray(pairExpression, pairKeys);
    const covering = db
      .select({
        id: epgProgramme.id,
        source_id: epgProgramme.sourceId,
        xmltv_channel_id: epgProgramme.xmltvChannelId,
        title: epgProgramme.title,
        description: epgProgramme.description,
        starts_at: epgProgramme.startsAt,
        ends_at: epgProgramme.endsAt,
      })
      .from(epgProgramme)
      .where(
        and(
          eq(epgProgramme.householdId, householdId),
          sql`${epgProgramme.startsAt} <= ${nowIso}`,
          sql`${epgProgramme.endsAt} > ${nowIso}`,
          pairFilter,
        ),
      )
      .all()
      .map(programmeRowOf);
    // 最早未来行:每关联对 MIN(starts_at>now) 的全部并列行(同起点并列由 key 升序决胜)
    const nextEarliest = db
      .select({
        id: epgProgramme.id,
        source_id: epgProgramme.sourceId,
        xmltv_channel_id: epgProgramme.xmltvChannelId,
        title: epgProgramme.title,
        description: epgProgramme.description,
        starts_at: epgProgramme.startsAt,
        ends_at: epgProgramme.endsAt,
      })
      .from(epgProgramme)
      .innerJoin(
        db
          .select({
            sourceId: epgProgramme.sourceId,
            xmltvChannelId: epgProgramme.xmltvChannelId,
            minStart: sql<string>`MIN(${epgProgramme.startsAt})`.as('min_start'),
          })
          .from(epgProgramme)
          .where(and(eq(epgProgramme.householdId, householdId), sql`${epgProgramme.startsAt} > ${nowIso}`, pairFilter))
          .groupBy(epgProgramme.sourceId, epgProgramme.xmltvChannelId)
          .as('m'),
        and(
          eq(epgProgramme.sourceId, sql`m.source_id`),
          eq(epgProgramme.xmltvChannelId, sql`m.xmltv_channel_id`),
          eq(epgProgramme.startsAt, sql`m.min_start`),
        ),
      )
      .where(eq(epgProgramme.householdId, householdId))
      .all()
      .map(programmeRowOf);
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
    const pairKey = typeof association === 'object' ? association.pairKey : null;
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
    const groupSources: GroupTitleSource[] = (entriesByMedia.get(channel.id) ?? []).map((row) => ({
      sourceId: row.sourceId,
      entryId: row.entryId,
      groupTitle: row.groupTitle,
    }));
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

export { normalizeGroupTitle };
