/**
 * live-tv 仓储 Drizzle 实现（008-repository-extraction T008，ADR-0015 D1）。
 *
 * 查询代码自 application/live-projection.service.ts 逐字迁移
 * （008 FR-002：join 链、谓词、返回形态均不变——含频道窗口投影的
 * source_entry ⋈ media_source 启用链、programme 关联对 char(0) 拼接
 * inArray 过滤与 MIN(starts_at) 子查询 join）。
 *
 * 句柄解析语义与迁移前 getDb() 一致：缺省形态每方法惰性经 getDb() 解析，
 * Database 单例 close/重开自动重建包装（不在构造期捕获句柄）；测试 rig 经
 * drizzleLiveTvStore(db) 以固定句柄构造（内存库）。句柄来自
 * @platform/database/drizzle（infrastructure→platform 为 R1c 合法边）。
 */
import { and, eq, inArray, sql } from 'drizzle-orm';
import { epgChannel, epgProgramme, manualEpgBinding, mediaItem, mediaSource, sourceEntry } from '@platform/database/schema';
import { getDb, type Db } from '@platform/database/drizzle';
import type {
  ChannelMetaRow,
  EpgChannelRow,
  LiveTvStore,
  ManualEpgBindingRow,
  MediaSourceRow,
  ProgrammeRow,
  SourceEntryRow,
} from '@contexts/live-tv/application/live-tv-store.port';

/** programme 行映射（snake_case 查询列 → 判定视图行；逐字迁移自 live-projection.service） */
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

/** 句柄来源：固定句柄（测试 rig）或惰性 getDb()（生产，单例重开安全） */
type HandleSource = Db | (() => Db);

function resolveHandle(source: HandleSource): Db {
  return typeof source === 'function' ? source() : source;
}

class DrizzleLiveTvStore implements LiveTvStore {
  private readonly source: HandleSource;

  constructor(handle?: Db) {
    // 缺省 getDb（惰性函数引用，不在构造期解析）；显式句柄用于测试 rig。
    this.source = handle === undefined ? getDb : () => handle;
  }

  private db(): Db {
    return resolveHandle(this.source);
  }

  listChannelRows(householdId: string, mediaIds?: readonly string[]): ChannelMetaRow[] {
    return this.db()
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
          ? and(eq(mediaItem.householdId, householdId), eq(mediaItem.type, 'channel'), eq(mediaItem.visible, 1))
          : and(eq(mediaItem.householdId, householdId), eq(mediaItem.type, 'channel'), eq(mediaItem.visible, 1), inArray(mediaItem.id, [...mediaIds])),
      )
      .all();
  }

  listPresentIptvEntryRows(householdId: string): SourceEntryRow[] {
    return this.db()
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
  }

  listMediaSourceRows(householdId: string): MediaSourceRow[] {
    // 016 T014:priority 并入既有投影列(级联排序输入;0010 列,零新增 SQL)
    return this.db()
      .select({ id: mediaSource.id, kind: mediaSource.kind, enabled: mediaSource.enabled, epgSourceId: mediaSource.epgSourceId, priority: mediaSource.priority })
      .from(mediaSource)
      .where(eq(mediaSource.householdId, householdId))
      .all();
  }

  listManualBindingRows(householdId: string): ManualEpgBindingRow[] {
    return this.db()
      .select({ mediaId: manualEpgBinding.mediaId, epgSourceId: manualEpgBinding.epgSourceId, xmltvChannelId: manualEpgBinding.xmltvChannelId })
      .from(manualEpgBinding)
      .where(and(eq(manualEpgBinding.householdId, householdId), eq(manualEpgBinding.mode, 'manual')))
      .all();
  }

  listEpgChannelRows(householdId: string): EpgChannelRow[] {
    // 016 T014:display_name 并入既有投影列(L4 别名索引输入;0004 非空列,零新增 SQL)
    return this.db()
      .select({ sourceId: epgChannel.sourceId, xmltvChannelId: epgChannel.xmltvChannelId, conflicted: epgChannel.conflicted, displayName: epgChannel.displayName })
      .from(epgChannel)
      .where(eq(epgChannel.householdId, householdId))
      .all();
  }

  listCoveringProgrammeRows(householdId: string, nowIso: string, pairKeys: readonly string[]): ProgrammeRow[] {
    const db = this.db();
    const pairExpression = sql`(${epgProgramme.sourceId} || char(0) || ${epgProgramme.xmltvChannelId})`;
    const pairFilter = inArray(pairExpression, pairKeys);
    return db
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
  }

  listNextEarliestProgrammeRows(householdId: string, nowIso: string, pairKeys: readonly string[]): ProgrammeRow[] {
    const db = this.db();
    const pairExpression = sql`(${epgProgramme.sourceId} || char(0) || ${epgProgramme.xmltvChannelId})`;
    const pairFilter = inArray(pairExpression, pairKeys);
    // 最早未来行:每关联对 MIN(starts_at>now) 的全部并列行(同起点并列由 key 升序决胜)
    return db
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
  }
}

/** 装配/测试工厂：缺省 getDb() 惰性解析（生产）；显式句柄用于测试 rig（内存库） */
export function drizzleLiveTvStore(handle?: Db): LiveTvStore {
  return new DrizzleLiveTvStore(handle);
}
