/**
 * epg 仓储 Drizzle 实现（008-repository-extraction T007，ADR-0015 D1）。
 *
 * 查询代码自 application/{epg,manual-epg-binding,guide-window}.service.ts 逐字迁移
 * （008 FR-002：join 链、谓词、排序、返回形态均不变）。manual-epg-binding 的
 * better-sqlite3 原生 SQL 文本逐字保留，位置参数 `?` 改由 drizzle sql 模板绑定
 * （同一 prepared 参数化机制，语义等价，与 policy 试点 loadAvailableMediaIdSet 同模式）。
 *
 * 句柄解析语义与迁移前 getDb() 一致：缺省形态每方法惰性经 getDb() 解析，
 * Database 单例 close/重开自动重建包装（不在构造期捕获句柄）；测试 rig 经
 * drizzleEpgStore(db) 以固定句柄构造（内存库）。句柄来自 @platform/database/drizzle
 * （008 实施修正：句柄归属平台层，infrastructure→platform 为 R1c 合法边，
 * 且不经任何发布面——避免测试 setup 预加载 identity-access 面破坏 vi.mock）。
 */
import { and, eq, gt, inArray, isNull, sql } from 'drizzle-orm';
import {
  device,
  deviceSession,
  epgChannel,
  epgProgramme,
  manualEpgBinding,
  mediaItem,
  mediaSource,
  profile,
  programmePoster,
  sourceEntry,
} from '@platform/database/schema';
import { getDb, type Db } from '@platform/database/drizzle';
import type {
  EpgProgrammeRow,
  EpgStore,
  EpgTxStore,
  GuideProgrammeWindowRow,
  HouseholdMediaCandidateRow,
  ManualBindingRawRow,
  ProgrammeMatchKeyCandidateRow,
  ProgrammePosterRow,
  ProgrammeProjectionRow,
  ProgrammeRekeyRow,
} from '@contexts/epg/application/epg-store.port';

/** 020:programme_poster 行 → 应用层投影(列名 camelCase) */
function toProgrammePosterRow(raw: typeof programmePoster.$inferSelect): ProgrammePosterRow {
  return {
    householdId: raw.householdId,
    matchKey: raw.matchKey,
    ref: raw.ref,
    state: raw.state as ProgrammePosterRow['state'],
    tmdbId: raw.tmdbId,
    mediaType: raw.mediaType as ProgrammePosterRow['mediaType'],
    title: raw.title,
    originalTitle: raw.originalTitle,
    posterPath: raw.posterPath,
    releaseDate: raw.releaseDate,
    voteAverage: raw.voteAverage,
    popularity: raw.popularity,
    matchScore: raw.matchScore,
    yearHint: raw.yearHint,
    attempts: raw.attempts,
    lastAttemptAt: raw.lastAttemptAt,
    expiresAt: raw.expiresAt,
    createdAt: raw.createdAt,
    updatedAt: raw.updatedAt,
  };
}

/** 020:分块大小(避免 SQLite 绑定参数过多) */
const POSTER_KEY_CHUNK = 500;

/** 句柄来源：固定句柄（测试 rig / 事务内 tx）或惰性 getDb()（生产，单例重开安全） */
type HandleSource = Db | (() => Db);

function resolveHandle(source: HandleSource): Db {
  return typeof source === 'function' ? source() : source;
}

class DrizzleEpgTxStore implements EpgTxStore {
  constructor(private readonly source: HandleSource) {}

  protected db(): Db {
    return resolveHandle(this.source);
  }

  upsertManualBinding(
    householdId: string,
    mediaId: string,
    mode: 'manual' | 'auto',
    target: { epgSourceId: string | null; xmltvChannelId: string | null },
    nextVersion: number,
    nowIso: string,
  ): void {
    this.db().run(sql`
      INSERT INTO manual_epg_binding (household_id, media_id, mode, epg_source_id, xmltv_channel_id, version, updated_at)
      VALUES (${householdId}, ${mediaId}, ${mode}, ${target.epgSourceId}, ${target.xmltvChannelId}, ${nextVersion}, ${nowIso})
      ON CONFLICT(household_id, media_id) DO UPDATE SET
        mode = excluded.mode,
        epg_source_id = excluded.epg_source_id,
        xmltv_channel_id = excluded.xmltv_channel_id,
        version = excluded.version,
        updated_at = excluded.updated_at
    `);
  }

  incrementCatalogRevision(householdId: string): void {
    this.db().run(sql`
      INSERT INTO catalog_state (household_id, revision) VALUES (${householdId}, 2)
      ON CONFLICT(household_id) DO UPDATE SET revision = revision + 1
    `);
  }

  upsertProgrammePoster(row: ProgrammePosterRow): void {
    this.db().run(sql`
      INSERT INTO programme_poster (
        household_id, match_key, ref, state, tmdb_id, media_type, title, original_title,
        poster_path, release_date, vote_average, popularity, match_score, year_hint,
        attempts, last_attempt_at, expires_at, created_at, updated_at
      ) VALUES (
        ${row.householdId}, ${row.matchKey}, ${row.ref}, ${row.state}, ${row.tmdbId}, ${row.mediaType},
        ${row.title}, ${row.originalTitle}, ${row.posterPath}, ${row.releaseDate}, ${row.voteAverage},
        ${row.popularity}, ${row.matchScore}, ${row.yearHint}, ${row.attempts}, ${row.lastAttemptAt},
        ${row.expiresAt}, ${row.createdAt}, ${row.updatedAt}
      )
      ON CONFLICT(household_id, match_key) DO UPDATE SET
        ref = excluded.ref,
        state = excluded.state,
        tmdb_id = excluded.tmdb_id,
        media_type = excluded.media_type,
        title = excluded.title,
        original_title = excluded.original_title,
        poster_path = excluded.poster_path,
        release_date = excluded.release_date,
        vote_average = excluded.vote_average,
        popularity = excluded.popularity,
        match_score = excluded.match_score,
        year_hint = excluded.year_hint,
        attempts = excluded.attempts,
        last_attempt_at = excluded.last_attempt_at,
        expires_at = excluded.expires_at,
        updated_at = excluded.updated_at
    `);
  }

  updateProgrammePosterRefs(
    householdId: string,
    entries: ReadonlyArray<{ matchKey: string; ref: string | null }>,
  ): void {
    for (const entry of entries) {
      this.db().run(sql`
        UPDATE epg_programme
        SET poster_ref = ${entry.ref}
        WHERE household_id = ${householdId} AND poster_match_key = ${entry.matchKey}
      `);
    }
  }

  updateProgrammeMatchKeys(
    householdId: string,
    entries: ReadonlyArray<{ id: string; matchKey: string | null }>,
  ): void {
    for (const entry of entries) {
      this.db().run(sql`
        UPDATE epg_programme
        SET poster_match_key = ${entry.matchKey}, poster_ref = NULL
        WHERE household_id = ${householdId} AND id = ${entry.id}
      `);
    }
  }

  deleteExpiredProgrammePosterRows(householdId: string, cutoffIso: string): number {
    const result = this.db().run(sql`
      DELETE FROM programme_poster
      WHERE household_id = ${householdId} AND expires_at < ${cutoffIso}
    `);
    return Number(result.changes);
  }
}

class DrizzleEpgStore extends DrizzleEpgTxStore implements EpgStore {
  constructor(handle?: Db) {
    // 缺省 getDb（惰性函数引用，不在构造期解析）；显式句柄用于测试 rig。
    super(handle === undefined ? getDb : () => handle);
  }

  /* —— epg.service —— */

  findAnyProfileId(householdId: string) {
    return this.db().select({ id: profile.id }).from(profile).where(eq(profile.householdId, householdId)).limit(1).get();
  }

  findSessionRow(sessionId: string) {
    return this.db().select().from(deviceSession).where(eq(deviceSession.id, sessionId)).get();
  }

  findDeviceRow(deviceId: string) {
    return this.db().select().from(device).where(eq(device.id, deviceId)).get();
  }

  listMediaCandidateRows(householdId: string): HouseholdMediaCandidateRow[] {
    return this.db()
      .select({
        id: mediaItem.id,
        type: mediaItem.type,
        title: mediaItem.title,
        description: mediaItem.description,
        contentLevel: mediaItem.contentLevel,
        version: mediaItem.version,
      })
      .from(mediaItem)
      .where(eq(mediaItem.householdId, householdId))
      .all();
  }

  listPresentSourceEntries(householdId: string, mediaId: string) {
    return this.db()
      .select({ sourceId: sourceEntry.sourceId, upstreamChannelId: sourceEntry.upstreamChannelId })
      .from(sourceEntry)
      .where(and(eq(sourceEntry.householdId, householdId), eq(sourceEntry.mediaId, mediaId), eq(sourceEntry.present, 1)))
      .all();
  }

  findMediaSourceRow(householdId: string, sourceId: string) {
    return this.db()
      .select()
      .from(mediaSource)
      .where(and(eq(mediaSource.householdId, householdId), eq(mediaSource.id, sourceId)))
      .get();
  }

  findEpgChannelConflictedRow(householdId: string, sourceId: string, xmltvChannelId: string) {
    return this.db()
      .select({ conflicted: epgChannel.conflicted })
      .from(epgChannel)
      .where(
        and(
          eq(epgChannel.householdId, householdId),
          eq(epgChannel.sourceId, sourceId),
          eq(epgChannel.xmltvChannelId, xmltvChannelId),
        ),
      )
      .get();
  }

  findManualBindingTarget(householdId: string, mediaId: string) {
    return this.db()
      .select({
        mode: manualEpgBinding.mode,
        epgSourceId: manualEpgBinding.epgSourceId,
        xmltvChannelId: manualEpgBinding.xmltvChannelId,
      })
      .from(manualEpgBinding)
      .where(and(eq(manualEpgBinding.householdId, householdId), eq(manualEpgBinding.mediaId, mediaId)))
      .get();
  }

  findMediaSourceEnabledRow(householdId: string, sourceId: string) {
    return this.db()
      .select({ enabled: mediaSource.enabled })
      .from(mediaSource)
      .where(and(eq(mediaSource.householdId, householdId), eq(mediaSource.id, sourceId)))
      .get();
  }

  listProgrammeRowsByChannel(householdId: string, sourceId: string, xmltvChannelId: string): ProgrammeProjectionRow[] {
    return this.db()
      .select({
        title: epgProgramme.title,
        description: epgProgramme.description,
        posterRef: epgProgramme.posterRef,
        startsAt: epgProgramme.startsAt,
        endsAt: epgProgramme.endsAt,
      })
      .from(epgProgramme)
      .where(
        and(
          eq(epgProgramme.householdId, householdId),
          eq(epgProgramme.sourceId, sourceId),
          eq(epgProgramme.xmltvChannelId, xmltvChannelId),
        ),
      )
      .orderBy(epgProgramme.startsAt)
      .all();
  }

  /* —— manual-epg-binding.service（raw SQL 段，文本逐字）—— */

  findWriterSessionRow(sessionId: string, householdId: string) {
    return this.db().get<{
      session_revoked_at: string | null;
      expires_at: string;
      device_revoked_at: string | null;
    }>(sql`SELECT s.revoked_at AS session_revoked_at, s.expires_at AS expires_at, d.revoked_at AS device_revoked_at FROM device_session s JOIN device d ON d.id = s.device_id WHERE s.id = ${sessionId} AND s.household_id = ${householdId}`);
  }

  findAccountRow(accountId: string, householdId: string) {
    return this.db().get<{ id: string }>(sql`SELECT id FROM account WHERE id = ${accountId} AND household_id = ${householdId}`);
  }

  findMediaItemTypeRow(mediaId: string, householdId: string) {
    return this.db().get<{ type: string }>(sql`SELECT type FROM media_item WHERE id = ${mediaId} AND household_id = ${householdId}`);
  }

  hasIptvSourceEntry(householdId: string, mediaId: string): boolean {
    // 逐字迁移自 requireBindableChannel 的存在性探测（SELECT 1 ... LIMIT 1）
    return (
      this.db().get(
        sql`SELECT 1 FROM source_entry se JOIN media_source ms ON ms.household_id = se.household_id AND ms.id = se.source_id AND ms.kind = 'iptv' WHERE se.household_id = ${householdId} AND se.media_id = ${mediaId} LIMIT 1`,
      ) !== undefined
    );
  }

  findBindingVersionRow(householdId: string, mediaId: string) {
    return this.db()
      .get<{ version: number }>(sql`SELECT version FROM manual_epg_binding WHERE household_id = ${householdId} AND media_id = ${mediaId}`);
  }

  findManualBindingRow(householdId: string, mediaId: string) {
    return this.db()
      .get<ManualBindingRawRow>(
        sql`SELECT mode, epg_source_id, xmltv_channel_id, version, updated_at FROM manual_epg_binding WHERE household_id = ${householdId} AND media_id = ${mediaId}`,
      );
  }

  findSourceEnabledRowById(epgSourceId: string, householdId: string) {
    return this.db()
      .get<{ enabled: number }>(sql`SELECT enabled FROM media_source WHERE id = ${epgSourceId} AND household_id = ${householdId}`);
  }

  findChannelConflictedRawRow(householdId: string, sourceId: string, xmltvChannelId: string) {
    return this.db()
      .get<{ conflicted: number }>(
        sql`SELECT conflicted FROM epg_channel WHERE household_id = ${householdId} AND source_id = ${sourceId} AND xmltv_channel_id = ${xmltvChannelId}`,
      );
  }

  findBindingTargetSourceRow(epgSourceId: string, householdId: string) {
    return this.db()
      .get<{ kind: string; enabled: number; epg_generation: number }>(
        sql`SELECT kind, enabled, epg_generation FROM media_source WHERE id = ${epgSourceId} AND household_id = ${householdId}`,
      );
  }

  /* —— listEpgCandidates —— */

  listNonConflictedChannelRows(householdId: string, sourceId: string) {
    return this.db()
      .select({ xmltvChannelId: epgChannel.xmltvChannelId, displayName: epgChannel.displayName })
      .from(epgChannel)
      .where(and(eq(epgChannel.householdId, householdId), eq(epgChannel.sourceId, sourceId), eq(epgChannel.conflicted, 0)))
      .orderBy(epgChannel.xmltvChannelId)
      .all();
  }

  listLiveChannelIdRows(householdId: string, sourceId: string, nowIso: string) {
    return this.db()
      .selectDistinct({ xmltvChannelId: epgProgramme.xmltvChannelId })
      .from(epgProgramme)
      .where(
        and(
          eq(epgProgramme.householdId, householdId),
          eq(epgProgramme.sourceId, sourceId),
          gt(epgProgramme.endsAt, nowIso),
        ),
      )
      .all();
  }

  listProgrammeRowsForChannels(householdId: string, sourceId: string, xmltvChannelIds: readonly string[]): EpgProgrammeRow[] {
    return this.db()
      .select()
      .from(epgProgramme)
      .where(
        and(
          eq(epgProgramme.householdId, householdId),
          eq(epgProgramme.sourceId, sourceId),
          inArray(epgProgramme.xmltvChannelId, xmltvChannelIds),
        ),
      )
      .orderBy(epgProgramme.xmltvChannelId, epgProgramme.startsAt)
      .all();
  }

  /* —— 020 programme-poster.service（缓存读取/回填） —— */

  listProgrammePosterRows(householdId: string, matchKeys: readonly string[]): ProgrammePosterRow[] {
    if (matchKeys.length === 0) {
      return [];
    }
    const unique = [...new Set(matchKeys)];
    const rows: ProgrammePosterRow[] = [];
    for (let offset = 0; offset < unique.length; offset += POSTER_KEY_CHUNK) {
      const chunk = unique.slice(offset, offset + POSTER_KEY_CHUNK);
      rows.push(
        ...this.db()
          .select()
          .from(programmePoster)
          .where(and(eq(programmePoster.householdId, householdId), inArray(programmePoster.matchKey, chunk)))
          .all()
          .map(toProgrammePosterRow),
      );
    }
    return rows;
  }

  findProgrammePosterByRef(householdId: string, ref: string): ProgrammePosterRow | undefined {
    const row = this.db()
      .select()
      .from(programmePoster)
      .where(and(eq(programmePoster.householdId, householdId), eq(programmePoster.ref, ref)))
      .limit(1)
      .get();
    return row === undefined ? undefined : toProgrammePosterRow(row);
  }

  listProgrammeRowsForRekey(
    householdId: string,
    afterId: string | null,
    limit: number,
  ): ProgrammeRekeyRow[] {
    return this.db()
      .select({ id: epgProgramme.id, title: epgProgramme.title, posterMatchKey: epgProgramme.posterMatchKey })
      .from(epgProgramme)
      .where(
        and(
          eq(epgProgramme.householdId, householdId),
          afterId === null ? undefined : gt(epgProgramme.id, afterId),
        ),
      )
      .orderBy(epgProgramme.id)
      .limit(limit)
      .all();
  }

  listProgrammeMatchKeyCandidateRows(
    householdId: string,
    afterId: string | null,
    limit: number,
  ): ProgrammeMatchKeyCandidateRow[] {
    return this.db()
      .select({ id: epgProgramme.id, title: epgProgramme.title })
      .from(epgProgramme)
      .where(
        and(
          eq(epgProgramme.householdId, householdId),
          isNull(epgProgramme.posterMatchKey),
          afterId === null ? undefined : gt(epgProgramme.id, afterId),
        ),
      )
      .orderBy(epgProgramme.id)
      .limit(limit)
      .all();
  }

  /* —— guide-window.service —— */

  listProgrammeWindowRows(
    householdId: string,
    fromIso: string,
    toIso: string,
    pairKeys: readonly string[],
    limit: number,
  ): GuideProgrammeWindowRow[] {
    // 逐字迁移自 guide-window.service 的批量窗口查询（交叠条件 + pair 表达式 + LIMIT 有界探测）
    const pairExpression = sql`(${epgProgramme.sourceId} || char(0) || ${epgProgramme.xmltvChannelId})`;
    return this.db()
      .select({
        id: epgProgramme.id,
        source_id: epgProgramme.sourceId,
        xmltv_channel_id: epgProgramme.xmltvChannelId,
        title: epgProgramme.title,
        description: epgProgramme.description,
        poster_ref: epgProgramme.posterRef,
        starts_at: epgProgramme.startsAt,
        ends_at: epgProgramme.endsAt,
      })
      .from(epgProgramme)
      .where(
        and(
          eq(epgProgramme.householdId, householdId),
          sql`${epgProgramme.startsAt} < ${toIso}`,
          sql`${epgProgramme.endsAt} > ${fromIso}`,
          inArray(pairExpression, pairKeys),
        ),
      )
      .limit(limit)
      .all();
  }

  withTransaction<T>(fn: (tx: EpgTxStore) => T): T {
    return this.db().transaction((tx) => fn(new DrizzleEpgTxStore(tx)));
  }
}

/** 装配/测试工厂：缺省 getDb() 惰性解析（生产）；显式句柄用于测试 rig（内存库） */
export function drizzleEpgStore(handle?: Db): EpgStore {
  return new DrizzleEpgStore(handle);
}
