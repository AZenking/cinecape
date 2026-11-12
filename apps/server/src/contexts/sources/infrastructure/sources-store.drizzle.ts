/**
 * sources 仓储 Drizzle 实现（008-repository-extraction T009，ADR-0015 D1）。
 *
 * 查询代码自 application/sources.service.ts、refresh-executor.service.ts 与
 * refresh-publish.service.ts 逐字迁移（008 FR-002：join 链、谓词、占位顺序、
 * 分块参数、返回形态均不变）。刷新管线的原生 prepare 查询逐字保留
 * better-sqlite3 的 Database.db.prepare 调用形态（infra→platform 合法边，
 * 不经任何发布面）；发布事务的缺列容忍守卫（pragma_table_info）随语句面一并迁移。
 *
 * 句柄解析语义与迁移前一致：缺省形态每方法惰性解析——drizzle 走 getDb()、原生
 * 查询走 Database.db（两者跟随同一 SQLite 单例 close/重开自动重建，不在构造期
 * 捕获句柄）；测试 rig 经 drizzleSourcesStore(db, conn) 以固定句柄构造（内存库）。
 */
import { randomUUID } from 'node:crypto';
import { and, count, eq, sql } from 'drizzle-orm';
import type DatabaseConstructor from 'better-sqlite3';
import { Database } from '@platform/database/database';
import { getDb, type Db } from '@platform/database/drizzle';
import type { TransactionBinding } from '@platform/database/unit-of-work';
// 014 T033(边界收敛,替代 US1 期间的唯一 infrastructure 深导入边):channel_logo 注册表
// 归 media-catalog 域所有,sources 发布经其事务参与者执行 M1/M2 合并与墓碑 GC,绝不直写
// 他域 SQL(internal-ports.md §1/§5)。参与者工厂现经 media-catalog 发布面(index.ts)
// 显式导出,本文件改走 `@contexts/media-catalog`(R2:跨上下文 import 唯一合法落点);
// 端口形状仍经 sources-store.port.ts 结构镜像类型消费(ChannelLogoParticipant,
// 编译期赋值强制一致)。
import { createMediaCatalogTxParticipants } from '@contexts/media-catalog';
import { catalogState, mediaSource, sourceRefresh, vodSourceConfig } from '@platform/database/schema';
import {
  clearStagedEntries as clearStagedRows,
  loadStagedEntries as loadStagedRows,
  stageEntries as stageRows,
  type StageEntriesParams,
  type StageEntriesResult,
} from '@contexts/sources/infrastructure/refresh-staging.service';
import type {
  ChannelLogoParticipant,
  EpgChannelIconRow,
  EnabledVodSourceSnapshotRow,
  MediaSource,
  MediaSourceRow,
  NewMediaSource,
  RefreshTxStore,
  SessionDeviceValidityRow,
  SourceEntryRow,
  SourceRefreshRow,
  SourcesStore,
  SourcesTxStore,
  VodSourceConfigKey,
} from '@contexts/sources/application/sources-store.port';

/** 句柄来源：固定句柄（测试 rig / 事务内 tx）或惰性 getDb()（生产，单例重开安全） */
type HandleSource = Db | (() => Db);

/** 原生查询句柄来源：固定连接（测试 rig / 事务内 tx）或惰性 Database.db（生产，单例重开安全） */
type RawSource = DatabaseConstructor.Database | (() => DatabaseConstructor.Database);

function resolveDb(source: HandleSource): Db {
  return typeof source === 'function' ? source() : source;
}

function resolveRaw(source: RawSource): DatabaseConstructor.Database {
  return typeof source === 'function' ? source() : source;
}

/**
 * 014 T015:把本语句面的原生连接以平台 TransactionBinding 形态适配给 media-catalog
 * 事务参与者(仅 exec/get/all;每次调用惰性解析连接,单例重开安全)。better-sqlite3
 * 事务为连接级:发布事务回调内取用即随同一事务提交/回滚,语义与本文件其余语句面一致。
 */
function transactionBindingOf(source: RawSource): TransactionBinding {
  return {
    credential: { transactionId: randomUUID(), behavior: 'immediate' },
    exec(sqlText: string, params: readonly unknown[] = []): void {
      resolveRaw(source)
        .prepare(sqlText)
        .run(...params);
    },
    get<Row>(sqlText: string, params: readonly unknown[] = []): Row | undefined {
      return resolveRaw(source).prepare(sqlText).get(...params) as Row | undefined;
    },
    all<Row>(sqlText: string, params: readonly unknown[] = []): Row[] {
      return resolveRaw(source).prepare(sqlText).all(...params) as Row[];
    },
  };
}

/** 来源管理写事务作用域（drizzle tx；createSource/updateSource 逐字迁移） */
class DrizzleSourcesTxStore implements SourcesTxStore {
  constructor(private readonly source: HandleSource) {}

  protected db(): Db {
    return resolveDb(this.source);
  }

  findMediaSourceById(sourceId: string) {
    return this.db().select().from(mediaSource).where(eq(mediaSource.id, sourceId)).get();
  }

  findOwnedMediaSource(sourceId: string, householdId: string) {
    return this.db()
      .select()
      .from(mediaSource)
      .where(and(eq(mediaSource.id, sourceId), eq(mediaSource.householdId, householdId)))
      .get();
  }

  insertMediaSource(values: NewMediaSource): void {
    this.db().insert(mediaSource).values(values).run();
  }

  updateOwnedMediaSource(sourceId: string, householdId: string, patch: Record<string, string | number | null>): void {
    this.db()
      .update(mediaSource)
      .set(patch)
      .where(and(eq(mediaSource.id, sourceId), eq(mediaSource.householdId, householdId)))
      .run();
  }

  markAwaitingSnapshotsStale(householdId: string, sourceId: string): void {
    this.db()
      .update(sourceRefresh)
      .set({ status: 'stale', version: sql`${sourceRefresh.version} + 1` })
      .where(
        and(
          eq(sourceRefresh.householdId, householdId),
          eq(sourceRefresh.sourceId, sourceId),
          eq(sourceRefresh.status, 'awaiting_confirmation'),
        ),
      )
      .run();
  }

  bumpCatalogRevision(householdId: string): void {
    this.db()
      .insert(catalogState)
      .values({ householdId, revision: 2 })
      .onConflictDoUpdate({
        target: catalogState.householdId,
        set: { revision: sql`${catalogState.revision} + 1` },
      })
      .run();
  }

  /* —— 010 T026（api.md §2「限10启用源」/data-model §2 vod_source_config/§4 净配额）—— */

  countEnabledVodSources(householdId: string): number {
    return (
      this.db()
        .select({ value: count() })
        .from(mediaSource)
        .where(
          and(
            eq(mediaSource.householdId, householdId),
            eq(mediaSource.kind, 'vod'),
            eq(mediaSource.enabled, 1),
          ),
        )
        .get()?.value ?? 0
    );
  }

  insertVodSourceConfig(values: VodSourceConfigKey & { adapter: string }): void {
    this.db().insert(vodSourceConfig).values(values).run();
  }

  /** locator_revision +1（010 data-model §2「启停均locator_revision+1防ABA」；单语句原子增量） */
  incrementLocatorRevision(sourceId: string, householdId: string): void {
    this.db()
      .update(mediaSource)
      .set({ locatorRevision: sql`${mediaSource.locatorRevision} + 1` })
      .where(and(eq(mediaSource.id, sourceId), eq(mediaSource.householdId, householdId)))
      .run();
  }
}

/** 刷新管线语句面（better-sqlite3 原生 prepared statements 逐字迁移；事务内外同形） */
class DrizzleRefreshTxStore implements RefreshTxStore {
  /** channel_logo 参与者缓存（惰性构造一次；连接经 binding 惰性解析,重开安全） */
  private channelLogo: ChannelLogoParticipant | null = null;

  constructor(private readonly source: RawSource) {}

  protected raw(): DatabaseConstructor.Database {
    return resolveRaw(this.source);
  }

  /* ---------- source_refresh 单语句读写 ---------- */

  getRefreshJobRow(householdId: string, refreshId: string): SourceRefreshRow | undefined {
    return this.raw().prepare('SELECT * FROM source_refresh WHERE id = ? AND household_id = ?').get(
      refreshId,
      householdId,
    ) as SourceRefreshRow | undefined;
  }

  findRefreshJobByOperationKey(householdId: string, operationKey: string): SourceRefreshRow | undefined {
    return this.raw()
      .prepare('SELECT * FROM source_refresh WHERE household_id = ? AND operation_key = ?')
      .get(householdId, operationKey) as SourceRefreshRow | undefined;
  }  findRefreshJobVersionAndDigest(
    householdId: string,
    refreshId: string,
  ): { version: number; snapshotDigest: string | null } | undefined {
    const row = this.raw()
      .prepare('SELECT version, snapshot_digest FROM source_refresh WHERE id = ? AND household_id = ?')
      .get(refreshId, householdId) as { version: number; snapshot_digest: string | null } | undefined;
    return row === undefined ? undefined : { version: row.version, snapshotDigest: row.snapshot_digest };
  }

  sessionExistsInHousehold(sessionId: string, householdId: string): boolean {
    return (
      this.raw()
        .prepare('SELECT id FROM device_session WHERE id = ? AND household_id = ?')
        .get(sessionId, householdId) !== undefined
    );
  }

  accountExistsInHousehold(accountId: string, householdId: string): boolean {
    return (
      this.raw()
        .prepare('SELECT id FROM account WHERE id = ? AND household_id = ?')
        .get(accountId, householdId) !== undefined
    );
  }

  hasActiveRefreshJob(householdId: string, sourceId: string): boolean {
    return (
      this.raw()
        .prepare(
          "SELECT id FROM source_refresh WHERE household_id = ? AND source_id = ? AND status IN ('queued', 'running', 'awaiting_confirmation')",
        )
        .get(householdId, sourceId) !== undefined
    );
  }

  countQueuedRefreshJobs(): number {
    return (this.raw().prepare("SELECT COUNT(*) AS n FROM source_refresh WHERE status = 'queued'").get() as { n: number })
      .n;
  }

  insertQueuedRefreshJob(values: {
    id: string;
    householdId: string;
    sourceId: string;
    initiatorAccountId: string;
    initiatorSessionId: string;
    operationKey: string;
    sourceVersion: number;
    baselineRevision: number;
    createdAt: string;
  }): void {
    this.raw()
      .prepare(
        "INSERT INTO source_refresh (id, household_id, source_id, initiator_account_id, initiator_session_id, operation_key, status, version, source_version, baseline_revision, snapshot_digest, item_count, summary_json, error_code, created_at, started_at, finished_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, 'queued', 1, ?, ?, NULL, NULL, NULL, NULL, ?, NULL, NULL, NULL)",
      )
      .run(
        values.id,
        values.householdId,
        values.sourceId,
        values.initiatorAccountId,
        values.initiatorSessionId,
        values.operationKey,
        values.sourceVersion,
        values.baselineRevision,
        values.createdAt,
      );
  }

  recordRefreshJobStagedMeta(householdId: string, refreshId: string, snapshotDigest: string, itemCount: number): void {
    this.raw()
      .prepare('UPDATE source_refresh SET snapshot_digest = ?, item_count = ? WHERE id = ? AND household_id = ?')
      .run(snapshotDigest, itemCount, refreshId, householdId);
  }

  markRefreshJobAwaitingConfirmation(householdId: string, refreshId: string, summaryJson: string, expiresAtIso: string): void {
    this.raw()
      .prepare(
        "UPDATE source_refresh SET status = 'awaiting_confirmation', version = version + 1, summary_json = ?, expires_at = ? WHERE id = ? AND household_id = ? AND status = 'running'",
      )
      .run(summaryJson, expiresAtIso, refreshId, householdId);
  }

  markRefreshJobStaleAndClearStaged(householdId: string, refreshId: string, finishedAtIso: string): void {
    this.raw()
      .prepare(
        "UPDATE source_refresh SET status = 'stale', version = version + 1, finished_at = ? WHERE id = ? AND household_id = ?",
      )
      .run(finishedAtIso, refreshId, householdId);
    clearStagedRows(this.raw(), { householdId, refreshId });
  }

  markRefreshJobSucceeded(householdId: string, refreshId: string, finishedAtIso: string, summaryJson: string): void {
    this.raw()
      .prepare(
        "UPDATE source_refresh SET status = 'succeeded', version = version + 1, finished_at = ?, summary_json = ?, error_code = NULL WHERE id = ? AND household_id = ?",
      )
      .run(finishedAtIso, summaryJson, refreshId, householdId);
  }

  /* ---------- media_source / catalog_state / source_entry 读 ---------- */

  // 0010(016 data-model §1.1):media_source.priority 列随 `SELECT *` 投影自然带出
  // (行类型 MediaSourceRow 已加 priority;写入经 insertMediaSource 直传 NewMediaSource,
  // 未显式给值时由 DDL DEFAULT 100 兜底),本文件无需增改列清单。
  findMediaSourceRecordById(sourceId: string): MediaSourceRow | undefined {
    return this.raw().prepare('SELECT * FROM media_source WHERE id = ?').get(sourceId) as MediaSourceRow | undefined;
  }

  findMediaSourceRecordInHousehold(sourceId: string, householdId: string): MediaSourceRow | undefined {
    return this.raw()
      .prepare('SELECT * FROM media_source WHERE id = ? AND household_id = ?')
      .get(sourceId, householdId) as MediaSourceRow | undefined;
  }

  findMediaSourceEnabledVersion(sourceId: string, householdId: string): { enabled: number; version: number } | undefined {
    return this.raw()
      .prepare('SELECT enabled, version FROM media_source WHERE id = ? AND household_id = ?')
      .get(sourceId, householdId) as { enabled: number; version: number } | undefined;
  }

  getCatalogRevision(householdId: string): number | undefined {
    return (
      this.raw().prepare('SELECT revision FROM catalog_state WHERE household_id = ?').get(householdId) as
        | { revision: number }
        | undefined
    )?.revision;
  }

  listPresentEntryKeys(householdId: string, sourceId: string): string[] {
    const rows = this.raw()
      .prepare(
        "SELECT identity_kind || ':' || identity_digest AS entry_key FROM source_entry WHERE household_id = ? AND source_id = ? AND present = 1",
      )
      .all(householdId, sourceId) as Array<{ entry_key: string }>;
    return rows.map((row) => row.entry_key);
  }

  listSourceEntryBaselineRows(householdId: string, sourceId: string): SourceEntryRow[] {
    return this.raw()
      .prepare(
        'SELECT id, identity_kind, identity_digest, media_id, present, file_size_text, file_mtime_ns FROM source_entry WHERE household_id = ? AND source_id = ?',
      )
      .all(householdId, sourceId) as SourceEntryRow[];
  }

  findSessionDeviceValidity(sessionId: string, householdId: string): SessionDeviceValidityRow | undefined {
    return this.raw()
      .prepare(
        'SELECT s.revoked_at AS session_revoked_at, s.expires_at AS expires_at, d.revoked_at AS device_revoked_at FROM device_session s JOIN device d ON d.id = s.device_id WHERE s.id = ? AND s.household_id = ?',
      )
      .get(sessionId, householdId) as SessionDeviceValidityRow | undefined;
  }

  /* ---------- 未就绪库守卫 ---------- */

  hasSourceRefreshTable(): boolean {
    const row = this.raw()
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'source_refresh'")
      .get() as { name: string } | undefined;
    return row !== undefined;
  }

  /* ---------- 暂存层委托 ---------- */

  stageEntries(params: StageEntriesParams): StageEntriesResult {
    return stageRows(this.raw(), params);
  }

  loadStagedEntries(params: { householdId: string; refreshId: string }) {
    return loadStagedRows(this.raw(), params);
  }

  clearStagedEntries(params: { householdId: string; refreshId: string }): number {
    return clearStagedRows(this.raw(), params);
  }

  /* ---------- 发布事务语句面 ---------- */

  markSourceEntryMissing(entryId: string, householdId: string, missingSinceIso: string): void {
    this.raw()
      .prepare('UPDATE source_entry SET present = 0, missing_since = ? WHERE id = ? AND household_id = ? AND present = 1')
      .run(missingSinceIso, entryId, householdId);
  }

  mediaItemHasContentRevisionColumn(): boolean {
    return (
      (
        this.raw()
          .prepare("SELECT COUNT(*) AS n FROM pragma_table_info('media_item') WHERE name = 'content_revision'")
          .get() as { n: number }
      ).n === 1
    );
  }

  bumpMediaItemContentRevision(mediaId: string, householdId: string, updatedAtIso: string): void {
    this.raw()
      .prepare(
        'UPDATE media_item SET content_revision = content_revision + 1, version = version + 1, updated_at = ? WHERE id = ? AND household_id = ?',
      )
      .run(updatedAtIso, mediaId, householdId);
  }

  insertMediaItem(
    mediaId: string,
    householdId: string,
    type: string,
    title: string,
    createdAtIso: string,
    updatedAtIso: string,
  ): void {
    const initialVisible = type === 'channel' ? 0 : 1;
    this.raw()
      .prepare(
        "INSERT INTO media_item (id, household_id, type, title, description, poster_ref, content_level, title_overridden, type_overridden, visible, version, created_at, updated_at) VALUES (?, ?, ?, ?, NULL, NULL, NULL, 0, 0, ?, 1, ?, ?)",
      )
      .run(mediaId, householdId, type, title, initialVisible, createdAtIso, updatedAtIso);
  }

  findMediaItemPresentation(
    mediaId: string,
    householdId: string,
  ): { title: string; type: string; title_overridden: number; type_overridden: number } | undefined {
    return this.raw()
      .prepare('SELECT title, type, title_overridden, type_overridden FROM media_item WHERE id = ? AND household_id = ?')
      .get(mediaId, householdId) as
      | { title: string; type: string; title_overridden: number; type_overridden: number }
      | undefined;
  }

  updateMediaItemPresentation(mediaId: string, householdId: string, title: string, type: string, updatedAtIso: string): void {
    this.raw()
      .prepare('UPDATE media_item SET title = ?, type = ?, version = version + 1, updated_at = ? WHERE id = ? AND household_id = ?')
      .run(title, type, updatedAtIso, mediaId, householdId);
  }

  nullMediaItemContentLevel(mediaId: string, householdId: string, updatedAtIso: string): void {
    this.raw()
      .prepare(
        'UPDATE media_item SET content_level = NULL, version = version + 1, updated_at = ? WHERE id = ? AND household_id = ?',
      )
      .run(updatedAtIso, mediaId, householdId);
  }

  sourceEntryHasGroupTitleColumn(): boolean {
    return (
      (
        this.raw()
          .prepare("SELECT COUNT(*) AS n FROM pragma_table_info('source_entry') WHERE name = 'group_title'")
          .get() as { n: number }
      ).n === 1
    );
  }

  /** 014 T015:logo_url 缺列容忍守卫(0009 原子增补;仅应用 0001~0008 的部分迁移库为 false) */
  sourceEntryHasLogoUrlColumn(): boolean {
    return (
      (
        this.raw()
          .prepare("SELECT COUNT(*) AS n FROM pragma_table_info('source_entry') WHERE name = 'logo_url'")
          .get() as { n: number }
      ).n === 1
    );
  }

  /** 014 T015:私有证据列落值(发布事务内;NULL=本次快照无有效 Logo,清旧证据) */
  setSourceEntryLogoUrl(logoUrl: string | null, entryId: string, householdId: string): void {
    this.raw()
      .prepare('UPDATE source_entry SET logo_url = ? WHERE id = ? AND household_id = ?')
      .run(logoUrl, entryId, householdId);
  }

  /** 014 T015:channel_logo 表守卫(0009;与 logo_url 列同迁移原子出现) */
  hasChannelLogoTable(): boolean {
    return (
      this.raw()
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'channel_logo'")
        .get() !== undefined
    );
  }

  /** 014 T015:media-catalog 事务参与者绑定(同连接;发布事务回调内取用即随事务提交) */
  channelLogoParticipant(): ChannelLogoParticipant {
    if (this.channelLogo === null) {
      this.channelLogo = createMediaCatalogTxParticipants(transactionBindingOf(this.source));
    }
    return this.channelLogo;
  }

  insertSourceEntry(
    entryId: string,
    householdId: string,
    sourceId: string,
    identityKind: string,
    identityDigest: string,
    mediaId: string,
    upstreamChannelId: string | null,
    lastSeenJobId: string,
    firstSeenAtIso: string,
    lastSeenAtIso: string,
    fileSizeText: string | null,
    fileMtimeNsText: string | null,
  ): void {
    this.raw()
      .prepare(
        "INSERT INTO source_entry (id, household_id, source_id, identity_kind, identity_digest, media_id, upstream_channel_id, present, last_seen_job_id, first_seen_at, last_seen_at, missing_since, file_size_text, file_mtime_ns) VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, NULL, ?, ?)",
      )
      .run(
        entryId,
        householdId,
        sourceId,
        identityKind,
        identityDigest,
        mediaId,
        upstreamChannelId,
        lastSeenJobId,
        firstSeenAtIso,
        lastSeenAtIso,
        fileSizeText,
        fileMtimeNsText,
      );
  }

  insertSourceEntryWithGroup(
    entryId: string,
    householdId: string,
    sourceId: string,
    identityKind: string,
    identityDigest: string,
    mediaId: string,
    upstreamChannelId: string | null,
    lastSeenJobId: string,
    firstSeenAtIso: string,
    lastSeenAtIso: string,
    fileSizeText: string | null,
    fileMtimeNsText: string | null,
    groupTitle: string | null,
  ): void {
    this.raw()
      .prepare(
        "INSERT INTO source_entry (id, household_id, source_id, identity_kind, identity_digest, media_id, upstream_channel_id, present, last_seen_job_id, first_seen_at, last_seen_at, missing_since, file_size_text, file_mtime_ns, group_title) VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, NULL, ?, ?, ?)",
      )
      .run(
        entryId,
        householdId,
        sourceId,
        identityKind,
        identityDigest,
        mediaId,
        upstreamChannelId,
        lastSeenJobId,
        firstSeenAtIso,
        lastSeenAtIso,
        fileSizeText,
        fileMtimeNsText,
        groupTitle,
      );
  }

  updateSourceEntry(
    mediaId: string,
    upstreamChannelId: string | null,
    lastSeenJobId: string,
    lastSeenAtIso: string,
    fileSizeText: string | null,
    fileMtimeNsText: string | null,
    entryId: string,
    householdId: string,
  ): void {
    this.raw()
      .prepare(
        'UPDATE source_entry SET media_id = ?, upstream_channel_id = ?, present = 1, last_seen_job_id = ?, last_seen_at = ?, missing_since = NULL, file_size_text = ?, file_mtime_ns = ? WHERE id = ? AND household_id = ?',
      )
      .run(mediaId, upstreamChannelId, lastSeenJobId, lastSeenAtIso, fileSizeText, fileMtimeNsText, entryId, householdId);
  }

  updateSourceEntryWithGroup(
    mediaId: string,
    upstreamChannelId: string | null,
    lastSeenJobId: string,
    lastSeenAtIso: string,
    fileSizeText: string | null,
    fileMtimeNsText: string | null,
    groupTitle: string | null,
    entryId: string,
    householdId: string,
  ): void {
    this.raw()
      .prepare(
        'UPDATE source_entry SET media_id = ?, upstream_channel_id = ?, present = 1, last_seen_job_id = ?, last_seen_at = ?, missing_since = NULL, file_size_text = ?, file_mtime_ns = ?, group_title = ? WHERE id = ? AND household_id = ?',
      )
      .run(mediaId, upstreamChannelId, lastSeenJobId, lastSeenAtIso, fileSizeText, fileMtimeNsText, groupTitle, entryId, householdId);
  }

  insertPlaybackSource(
    playbackId: string,
    householdId: string,
    sourceId: string,
    sourceEntryId: string,
    mediaItemId: string,
    protocol: string,
    location: string,
    createdAtIso: string,
    updatedAtIso: string,
    priority: number,
  ): void {
    this.raw()
      .prepare(
        "INSERT INTO playback_source (id, household_id, source_id, source_entry_id, media_item_id, protocol, location, mime_type, priority, requires_proxy, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?, 0, ?, ?)",
      )
      .run(playbackId, householdId, sourceId, sourceEntryId, mediaItemId, protocol, location, priority, createdAtIso, updatedAtIso);
  }

  updatePlaybackSource(
    mediaItemId: string,
    protocol: string,
    location: string,
    updatedAtIso: string,
    playbackId: string,
    householdId: string,
    priority: number,
  ): void {
    this.raw()
      .prepare('UPDATE playback_source SET media_item_id = ?, protocol = ?, location = ?, priority = ?, updated_at = ? WHERE id = ? AND household_id = ?')
      .run(mediaItemId, protocol, location, priority, updatedAtIso, playbackId, householdId);
  }

  /** 016 T018:家庭内可聚合频道行(type='channel' 且未人工改名);聚合键由 application 派生 */
  listAggregatableChannelMediaRows(householdId: string): Array<{ id: string; title: string }> {
    return this.raw()
      .prepare(
        "SELECT id, title FROM media_item WHERE household_id = ? AND type = 'channel' AND title_overridden = 0 ORDER BY created_at ASC, id ASC",
      )
      .all(householdId) as Array<{ id: string; title: string }>;
  }

  findPlaybackSourceId(householdId: string, sourceEntryId: string): string | undefined {
    return (this.raw()
      .prepare('SELECT id FROM playback_source WHERE household_id = ? AND source_entry_id = ?')
      .get(householdId, sourceEntryId) as { id: string } | undefined)?.id;
  }

  listProfileIdsInHousehold(householdId: string): string[] {
    const rows = this.raw().prepare('SELECT id FROM profile WHERE household_id = ? ORDER BY id').all(householdId) as Array<{
      id: string;
    }>;
    return rows.map((row) => row.id);
  }

  findProfilePolicyLists(
    householdId: string,
    profileId: string,
  ): { allowed_media_ids: string; blocked_media_ids: string } | undefined {
    return this.raw()
      .prepare('SELECT * FROM profile_policy WHERE household_id = ? AND profile_id = ?')
      .get(householdId, profileId) as { allowed_media_ids: string; blocked_media_ids: string } | undefined;
  }

  updateProfilePolicyAllowedMediaIds(
    householdId: string,
    profileId: string,
    allowedMediaIdsJson: string,
    updatedAtIso: string,
  ): void {
    this.raw()
      .prepare(
        'UPDATE profile_policy SET allowed_media_ids = ?, version = version + 1, updated_at = ? WHERE household_id = ? AND profile_id = ?',
      )
      .run(allowedMediaIdsJson, updatedAtIso, householdId, profileId);
  }

  recordMediaSourceSuccess(sourceId: string, householdId: string, refreshId: string, nowIso: string): void {
    this.raw()
      .prepare('UPDATE media_source SET last_success_at = ?, last_job_id = ?, updated_at = ? WHERE id = ? AND household_id = ?')
      .run(nowIso, refreshId, nowIso, sourceId, householdId);
  }

  incrementCatalogRevision(householdId: string): void {
    this.raw().prepare('UPDATE catalog_state SET revision = revision + 1 WHERE household_id = ?').run(householdId);
  }

  /* ---------- EPG 窗口发布 ---------- */

  deleteEpgProgrammes(householdId: string, sourceId: string): void {
    this.raw().prepare('DELETE FROM epg_programme WHERE household_id = ? AND source_id = ?').run(householdId, sourceId);
  }

  deleteEpgChannels(householdId: string, sourceId: string): void {
    this.raw().prepare('DELETE FROM epg_channel WHERE household_id = ? AND source_id = ?').run(householdId, sourceId);
  }

  insertEpgChannel(householdId: string, sourceId: string, xmltvChannelId: string, displayName: string, conflicted: number): void {
    this.raw()
      .prepare(
        'INSERT INTO epg_channel (household_id, source_id, xmltv_channel_id, display_name, conflicted) VALUES (?, ?, ?, ?, ?)',
      )
      .run(householdId, sourceId, xmltvChannelId, displayName, conflicted);
  }

  /** 014 T033:icon_url 缺列容忍守卫(0009 原子增补;仅应用 0001~0008 的部分迁移库为 false) */
  epgChannelHasIconUrlColumn(): boolean {
    return (
      (
        this.raw()
          .prepare("SELECT COUNT(*) AS n FROM pragma_table_info('epg_channel') WHERE name = 'icon_url'")
          .get() as { n: number }
      ).n === 1
    );
  }

  /** 014 T033:XMLTV 频道图标私有证据列随窗口 upsert 同事务写入(解析层已归一化) */
  insertEpgChannelWithIcon(
    householdId: string,
    sourceId: string,
    xmltvChannelId: string,
    displayName: string,
    conflicted: number,
    iconUrl: string | null,
  ): void {
    this.raw()
      .prepare(
        'INSERT INTO epg_channel (household_id, source_id, xmltv_channel_id, display_name, conflicted, icon_url) VALUES (?, ?, ?, ?, ?, ?)',
      )
      .run(householdId, sourceId, xmltvChannelId, displayName, conflicted, iconUrl);
  }

  /** 014 T033:M2 epg 填补判定输入(单次集合查询;私有证据不进公共 DTO) */
  listEpgChannelIconRows(householdId: string): EpgChannelIconRow[] {
    return this.raw()
      .prepare(
        'SELECT source_id AS sourceId, xmltv_channel_id AS xmltvChannelId, conflicted, icon_url AS iconUrl FROM epg_channel WHERE household_id = ?',
      )
      .all(householdId) as EpgChannelIconRow[];
  }

  insertEpgProgrammeIfAbsent(
    programmeId: string,
    householdId: string,
    sourceId: string,
    xmltvChannelId: string,
    title: string,
    description: string | null,
    startsAtIso: string,
    endsAtIso: string,
  ): number {
    const result = this.raw()
      .prepare(
        'INSERT OR IGNORE INTO epg_programme (id, household_id, source_id, xmltv_channel_id, title, description, starts_at, ends_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      )
      .run(programmeId, householdId, sourceId, xmltvChannelId, title, description, startsAtIso, endsAtIso);
    return Number(result.changes);
  }

  mediaSourceHasEpgGenerationColumn(): boolean {
    return (
      (
        this.raw()
          .prepare("SELECT COUNT(*) AS n FROM pragma_table_info('media_source') WHERE name = 'epg_generation'")
          .get() as { n: number }
      ).n === 1
    );
  }

  bumpMediaSourceEpgGeneration(sourceId: string, householdId: string): void {
    this.raw()
      .prepare(
        "UPDATE media_source SET epg_generation = epg_generation + 1 WHERE id = ? AND household_id = ? AND kind = 'epg'",
      )
      .run(sourceId, householdId);
  }
}

class DrizzleSourcesStore extends DrizzleRefreshTxStore implements SourcesStore {
  private readonly dbSource: HandleSource;

  constructor(handle?: Db, raw?: DatabaseConstructor.Database) {
    // 缺省 getDb / Database.db（惰性函数引用，不在构造期解析）；显式句柄用于测试 rig。
    super(raw === undefined ? () => Database.db : () => raw);
    this.dbSource = handle === undefined ? getDb : () => handle;
  }

  private db(): Db {
    return resolveDb(this.dbSource);
  }

  /* ---------- 来源管理（drizzle） ---------- */

  // 013/ADR-0017:findDeviceSession(家长验证后的会话行重读)随验证闸门摘除而删除。

  findMediaSourceById(sourceId: string): MediaSource | undefined {
    return this.db().select().from(mediaSource).where(eq(mediaSource.id, sourceId)).get();
  }

  findOwnedMediaSource(sourceId: string, householdId: string): MediaSource | undefined {
    return this.db()
      .select()
      .from(mediaSource)
      .where(and(eq(mediaSource.id, sourceId), eq(mediaSource.householdId, householdId)))
      .get();
  }

  listMediaSourcePage(householdId: string, page: number, pageSize: number): { rows: MediaSource[]; total: number } {
    const where = eq(mediaSource.householdId, householdId);
    const total = this.db().select({ value: count() }).from(mediaSource).where(where).get()?.value ?? 0;
    const rows = this.db()
      .select()
      .from(mediaSource)
      .where(where)
      .orderBy(mediaSource.createdAt, mediaSource.id)
      .limit(pageSize)
      .offset((page - 1) * pageSize)
      .all();
    return { rows, total };
  }

  /** vod 适配配置读取（010 T026 testSource compatible 判定；一源一行，未配置返回 undefined） */
  findVodSourceConfig(householdId: string, sourceId: string): (VodSourceConfigKey & { adapter: string }) | undefined {
    return this.db()
      .select({ householdId: vodSourceConfig.householdId, sourceId: vodSourceConfig.sourceId, adapter: vodSourceConfig.adapter })
      .from(vodSourceConfig)
      .where(and(eq(vodSourceConfig.householdId, householdId), eq(vodSourceConfig.sourceId, sourceId)))
      .get();
  }

  /**
   * 010 T028/T031 启用 vod 来源快照（与事务参与者 listEnabledVodSources 同一谓词/排序
   * —— media_source × vod_source_config JOIN，kind=vod 且 enabled=1，ORDER BY created_at,id；
   * 另投影 remote_url 供 online-vod 上游定位构建，属私有定位不进公共 DTO）。
   */
  listEnabledVodSourceSnapshots(householdId: string): EnabledVodSourceSnapshotRow[] {
    return this.raw()
      .prepare(
        `SELECT
          ms.id AS sourceId,
          ms.name AS name,
          c.adapter AS adapter,
          ms.locator_revision AS locatorRevision,
          ms.remote_url AS remoteUrl
         FROM media_source ms
         JOIN vod_source_config c ON c.household_id = ms.household_id AND c.source_id = ms.id
         WHERE ms.household_id = ? AND ms.kind = 'vod' AND ms.enabled = 1
         ORDER BY ms.created_at, ms.id`,
      )
      .all(householdId) as EnabledVodSourceSnapshotRow[];
  }

  withTransaction<T>(fn: (tx: SourcesTxStore) => T): T {
    return this.db().transaction((tx) => fn(new DrizzleSourcesTxStore(tx)));
  }

  withSqlTransaction<T>(fn: (tx: RefreshTxStore) => T): T {
    // 与迁移前形态一致:零参事务回调 + 回调内经外层 db 句柄执行语句
    // (better-sqlite3 事务为连接级,同连接语句自然参与事务)。
    const db = this.raw();
    const run = db.transaction((): T => fn(new DrizzleRefreshTxStore(db)));
    return run();
  }

  /* ---------- 复合状态迁移（内嵌多语句事务，逐字迁移） ---------- */

  claimNextQueuedJob(startedAtIso: string): SourceRefreshRow | null {
    const db = this.raw();
    const claim = db.transaction((): SourceRefreshRow | null => {
      const candidate = db
        .prepare("SELECT id, household_id FROM source_refresh WHERE status = 'queued' ORDER BY created_at ASC, id ASC LIMIT 1")
        .get() as { id: string; household_id: string } | undefined;
      if (candidate === undefined) {
        return null;
      }
      const claimed = db
        .prepare("UPDATE source_refresh SET status = 'running', version = version + 1, started_at = ? WHERE id = ? AND household_id = ? AND status = 'queued'")
        .run(startedAtIso, candidate.id, candidate.household_id);
      if (Number(claimed.changes) !== 1) {
        return null;
      }
      return this.getRefreshJobRow(candidate.household_id, candidate.id) ?? null;
    });
    return claim();
  }

  failRefreshJob(householdId: string, refreshId: string, errorCode: string, finishedAtIso: string): void {
    const db = this.raw();
    db.transaction(() => {
      db.prepare(
        "UPDATE source_refresh SET status = 'failed', version = version + 1, error_code = ?, finished_at = ? WHERE id = ? AND household_id = ? AND status = 'running'",
      ).run(errorCode, finishedAtIso, refreshId, householdId);
      clearStagedRows(db, { householdId, refreshId });
    })();
  }

  recoverInterruptedJobs(finishedAtIso: string): number {
    const db = this.raw();
    return db.transaction((): number => {
      const rows = db
        .prepare("SELECT id, household_id FROM source_refresh WHERE status IN ('queued', 'running')")
        .all() as Array<{ id: string; household_id: string }>;
      for (const row of rows) {
        db.prepare(
          "UPDATE source_refresh SET status = 'interrupted', version = version + 1, finished_at = ? WHERE id = ? AND household_id = ? AND status IN ('queued', 'running')",
        ).run(finishedAtIso, row.id, row.household_id);
      }
      return rows.length;
    })();
  }

  expireStaleConfirmationJobs(nowIso: string): number {
    const db = this.raw();
    return db.transaction((): number => {
      const rows = db
        .prepare(
          "SELECT id, household_id FROM source_refresh WHERE status = 'awaiting_confirmation' AND expires_at IS NOT NULL AND expires_at <= ?",
        )
        .all(nowIso) as Array<{ id: string; household_id: string }>;
      for (const row of rows) {
        db.prepare(
          "UPDATE source_refresh SET status = 'expired', version = version + 1, finished_at = ? WHERE id = ? AND household_id = ? AND status = 'awaiting_confirmation'",
        ).run(nowIso, row.id, row.household_id);
        clearStagedRows(db, { householdId: row.household_id, refreshId: row.id });
      }
      return rows.length;
    })();
  }

  discardAwaitingJob(householdId: string, refreshId: string, finishedAtIso: string): void {
    const db = this.raw();
    db.transaction(() => {
      db.prepare(
        "UPDATE source_refresh SET status = 'discarded', version = version + 1, finished_at = ? WHERE id = ? AND household_id = ? AND status = 'awaiting_confirmation'",
      ).run(finishedAtIso, refreshId, householdId);
      clearStagedRows(db, { householdId, refreshId });
    })();
  }

  markAwaitingJobTerminal(
    householdId: string,
    refreshId: string,
    status: 'stale' | 'expired',
    finishedAtIso: string,
  ): void {
    const db = this.raw();
    db.transaction(() => {
      db.prepare(
        `UPDATE source_refresh SET status = '${status}', version = version + 1, finished_at = ? WHERE id = ? AND household_id = ? AND status = 'awaiting_confirmation'`,
      ).run(finishedAtIso, refreshId, householdId);
      clearStagedRows(db, { householdId, refreshId });
    })();
  }
}

/** 装配/测试工厂：缺省惰性解析（生产）；显式句柄用于测试 rig（内存库；原生查询需同步传 raw 连接） */
export function drizzleSourcesStore(
  handle?: Db,
  raw?: DatabaseConstructor.Database,
): SourcesStore {
  return new DrizzleSourcesStore(handle, raw);
}
