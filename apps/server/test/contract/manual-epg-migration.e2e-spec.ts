import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import DatabaseConstructor from 'better-sqlite3';
import { Database } from '@platform/database/database';
import { setEnvOverride } from '@platform/config/env';
import { loadEnv } from '@platform/config/env.schema';

/**
 * T067(阶段 3 US5 契约 e2e):0004_manual_epg_binding 迁移升级/回滚矩阵,对照
 * docs/specs/003-media-catalog/data-model.md「## 0004 增补」、ADR-0008 与 quickstart H 第 1 条:
 * - 升级:既有 0003 库(家庭/档案/PIN/策略/来源/媒体/条目/EPG 种子)应用 0004 后,
 *   原目录/节目/身份/PIN/策略逐值不变;无绑定行(自动行为不变);既有来源 epg_generation=0;
 *   integrity_check / foreign_key_check 通过。
 * - 回滚:manual_epg_binding 表/索引与 media_source.epg_generation 列移除,原目录/身份/PIN/策略
 *   不变;_migrations 记录正确;含手动绑定行时 down 亦成功(绑定随表删除,行为回落自动)。
 * - 再升级:目录为空(0004 不恢复目录)、binding 表空、generation=0;两项 PRAGMA 通过。
 * - down/up 链路:绑定行 + generation=2 → down(表/列消失)→ up(空表、归零),
 *   不宣称恢复手动配置(ADR-0008:恢复须回滚前备份)。
 * - 就绪(T009 就绪语义变更):Database.isReady 在缺 0004 记录/缺新表/缺新列时 false;
 *   目录含 0005 后,仅应用 0001~0004 的部分形态库始终安全拒绝(完整迁移库就绪由 playback-readiness 覆盖)。
 * - drill:独立临时 DATA_DIR 上 `tsx src/platform/database/migrate.ts drill` 通过(CLI 层面)。
 *
 * 独立临时 DATA_DIR:本文件内联实现夹具(setEnvOverride + Database.close 单例重置),
 * 不复用 test/helpers.ts(该文件由并行任务所有);迁移以 src/platform/database/migrations 权威 DDL 直读。
 */

interface MigrationRig {
  dataDir: string;
  dbFilename: string;
}

const rigs: MigrationRig[] = [];

/** 与 0004 同步的就绪/演练常量(实现落在 database.ts / migrate.ts,测试按目录权威直读) */
const MIGRATION_NAME = '0004_manual_epg_binding';

function migrationsDir(): string {
  return path.join(process.cwd(), 'src/platform/database/migrations');
}

function migrationSql(name: string, file: 'up.sql' | 'down.sql'): string {
  const p = path.join(migrationsDir(), name, file);
  if (!fs.existsSync(p)) {
    throw new Error(`未找到迁移文件 ${p} —— 本测试须以 apps/server 为工作目录运行(pnpm --filter @hmp/server test)`);
  }
  return fs.readFileSync(p, 'utf8');
}

/** 全新环境:独立临时数据目录 + 空版本表(与 catalog-migration 同模式,只做迁移不做 HTTP) */
function startFreshDb(): void {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hmp-manual-epg-mig-'));
  const dbFilename = `${randomUUID()}.hmp.db`;
  setEnvOverride(loadEnv({ NODE_ENV: 'test', DATA_DIR: dataDir, DB_FILENAME: dbFilename }));
  Database.close();
  Database.db.exec('CREATE TABLE IF NOT EXISTS _migrations (name TEXT PRIMARY KEY NOT NULL, applied_at TEXT NOT NULL)');
  rigs.push({ dataDir, dbFilename });
}

/** 应用单条迁移 up.sql 并记录 _migrations(与 migrate.ts 同语义:DDL 与版本记录同事务) */
function applyMigration(name: string): void {
  const conn = Database.db;
  conn.transaction(() => {
    conn.exec(migrationSql(name, 'up.sql'));
    conn.prepare('INSERT INTO _migrations (name, applied_at) VALUES (?, ?)').run(name, new Date().toISOString());
  })();
}

/** 回滚单条迁移(事务内执行,与 migrate.ts 同语义) */
function rollbackMigration(name: string): void {
  const conn = Database.db;
  conn.transaction(() => {
    conn.exec(migrationSql(name, 'down.sql'));
    conn.prepare('DELETE FROM _migrations WHERE name = ?').run(name);
  })();
}

function appliedMigrations(): string[] {
  return (Database.db.prepare('SELECT name FROM _migrations ORDER BY name').all() as { name: string }[]).map(
    (row) => row.name,
  );
}

async function cleanupRigs(): Promise<void> {
  while (rigs.length > 0) {
    const rig = rigs.pop();
    if (rig === undefined) {
      break;
    }
    Database.close();
    setEnvOverride(null);
    fs.rmSync(rig.dataDir, { recursive: true, force: true });
  }
}

function tableExists(name: string): boolean {
  return Database.db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name) !== undefined;
}

function indexExists(name: string): boolean {
  return Database.db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'index' AND name = ?").get(name) !== undefined;
}

function columnExists(table: string, column: string): boolean {
  return (Database.db.pragma(`table_info(${table})`) as { name: string }[]).some((row) => row.name === column);
}

function expectIntegrityOk(): void {
  expect(Database.db.pragma('integrity_check')).toEqual([{ integrity_check: 'ok' }]);
  expect(Database.db.pragma('foreign_key_check')).toEqual([]);
}

/* ------------------------------------------------------------------ */
/* 阶段 1/2 夹具:家庭/账号/档案/PIN/策略(与 catalog-migration 同构)     */
/* ------------------------------------------------------------------ */

interface LegacyFixture {
  householdAId: string;
  householdBId: string;
  accountId: string;
  adultWithPinId: string;
  childId: string;
}

/** 直写阶段 1 形态身份行(家庭甲:账号+有 PIN 成人+儿童;家庭乙:空家庭),不经 HTTP */
function injectLegacyData(): LegacyFixture {
  const ids: LegacyFixture = {
    householdAId: randomUUID(),
    householdBId: randomUUID(),
    accountId: randomUUID(),
    adultWithPinId: randomUUID(),
    childId: randomUUID(),
  };
  const now = new Date().toISOString();
  const db = Database.db;
  const insertHousehold = db.prepare(
    'INSERT INTO household (id, name, default_language, timezone, created_at) VALUES (?, ?, ?, ?, ?)',
  );
  insertHousehold.run(ids.householdAId, '手动绑定迁移家庭甲', 'zh-CN', 'Asia/Shanghai', now);
  insertHousehold.run(ids.householdBId, '手动绑定迁移家庭乙', 'zh-CN', 'Asia/Shanghai', now);
  db.prepare(
    'INSERT INTO account (id, household_id, username, username_normalized, password_hash, role, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
  ).run(ids.accountId, ids.householdAId, 'binder', 'binder', '$argon2id$fixture-hash', 'owner', now);
  const insertProfile = db.prepare(
    'INSERT INTO profile (id, household_id, account_id, name, avatar, type, is_default, pin_hash, status, failed_pin_count, pin_locked_until, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
  );
  insertProfile.run(ids.adultWithPinId, ids.householdAId, ids.accountId, '有码家长', null, 'adult', 1, '$argon2id$pin', 'active', 0, null, now);
  insertProfile.run(ids.childId, ids.householdAId, ids.accountId, '儿童', null, 'child', 0, null, 'active', 0, null, now);
  return ids;
}

/** 在 0002 之上写入自定义策略值,证明 0004 up/down 全程不动策略 */
function customizePolicy(fixture: LegacyFixture): void {
  Database.db
    .prepare('UPDATE profile_policy SET max_content_level = 12, version = 6 WHERE profile_id = ?')
    .run(fixture.childId);
}

/* ------------------------------------------------------------------ */
/* 阶段 3(0003)夹具:IPTV/EPG 来源、媒体、条目、频道与节目              */
/* ------------------------------------------------------------------ */

interface CatalogFixture {
  iptvSourceId: string;
  epgSourceId: string;
  mediaId: string;
  entryId: string;
  xmltvChannelId: string;
}

/** 在 0003 之上写入最小目录数据:IPTV 来源(默认 EPG)+ EPG 来源 + 媒体频道 + 条目 + 频道/节目 */
function injectCatalogData(householdId: string): CatalogFixture {
  const ids: CatalogFixture = {
    iptvSourceId: randomUUID(),
    epgSourceId: randomUUID(),
    mediaId: randomUUID(),
    entryId: randomUUID(),
    xmltvChannelId: 'cctv-1',
  };
  const now = new Date().toISOString();
  const db = Database.db;
  // EPG 来源(kind=epg)
  db.prepare(
    "INSERT INTO media_source (id, household_id, kind, name, remote_url, root_key, relative_directory, private_access_approved, epg_source_id, enabled, version, last_success_at, last_job_id, created_at, updated_at) VALUES (?, ?, 'epg', ?, ?, NULL, NULL, 1, NULL, 1, 1, ?, NULL, ?, ?)",
  ).run(ids.epgSourceId, householdId, '指南EPG', 'http://lan.example/guide.xml', now, now, now);
  // IPTV 来源(kind=iptv,默认 EPG 指向指南来源)
  db.prepare(
    "INSERT INTO media_source (id, household_id, kind, name, remote_url, root_key, relative_directory, private_access_approved, epg_source_id, enabled, version, last_success_at, last_job_id, created_at, updated_at) VALUES (?, ?, 'iptv', ?, ?, NULL, NULL, 1, ?, 1, 1, ?, NULL, ?, ?)",
  ).run(ids.iptvSourceId, householdId, '受控IPTV', 'http://lan.example/list.m3u8', ids.epgSourceId, now, now, now);
  // 媒体频道 + 身份稳定条目
  db.prepare(
    "INSERT INTO media_item (id, household_id, type, title, description, poster_ref, content_level, title_overridden, type_overridden, version, created_at, updated_at) VALUES (?, ?, 'channel', ?, NULL, NULL, NULL, 0, 0, 1, ?, ?)",
  ).run(ids.mediaId, householdId, '频道甲', now, now);
  db.prepare(
    "INSERT INTO source_entry (id, household_id, source_id, identity_kind, identity_digest, media_id, upstream_channel_id, present, last_seen_job_id, first_seen_at, last_seen_at, missing_since, file_size_text, file_mtime_ns) VALUES (?, ?, ?, 'tvg_id', ?, ?, NULL, 1, NULL, ?, ?, NULL, NULL, NULL)",
  ).run(
    ids.entryId,
    householdId,
    ids.iptvSourceId,
    createHash('sha256').update(`tvg_id:${ids.xmltvChannelId}`).digest('hex'),
    ids.mediaId,
    now,
    now,
  );
  // EPG 频道与节目(挂在 EPG 来源上)
  db.prepare(
    "INSERT INTO epg_channel (household_id, source_id, xmltv_channel_id, display_name, conflicted) VALUES (?, ?, ?, 'CCTV-1 综合', 0)",
  ).run(householdId, ids.epgSourceId, ids.xmltvChannelId);
  db.prepare(
    "INSERT INTO epg_programme (id, household_id, source_id, xmltv_channel_id, title, description, starts_at, ends_at) VALUES (?, ?, ?, ?, '新闻节目', NULL, '2026-10-24T01:00:00Z', '2026-10-24T01:30:00Z')",
  ).run(randomUUID(), householdId, ids.epgSourceId, ids.xmltvChannelId);
  return ids;
}

/** 手动绑定行(manual 保存即锁定;version 无行=0,首写 1) */
function insertManualBinding(
  householdId: string,
  mediaId: string,
  epgSourceId: string,
  xmltvChannelId: string,
  version: number,
): void {
  Database.db
    .prepare(
      "INSERT INTO manual_epg_binding (household_id, media_id, mode, epg_source_id, xmltv_channel_id, version, updated_at) VALUES (?, ?, 'manual', ?, ?, ?, ?)",
    )
    .run(householdId, mediaId, epgSourceId, xmltvChannelId, version, new Date().toISOString());
}

function bindingCount(): number {
  return (Database.db.prepare('SELECT COUNT(*) AS n FROM manual_epg_binding').get() as { n: number }).n;
}

function sourceGeneration(sourceId: string): number {
  const row = Database.db.prepare('SELECT epg_generation FROM media_source WHERE id = ?').get(sourceId) as
    | { epg_generation: number }
    | undefined;
  if (row === undefined) {
    throw new Error(`media_source ${sourceId} 不存在`);
  }
  return row.epg_generation;
}

/* ------------------------------------------------------------------ */
/* 快照:身份/PIN/策略 与 目录(显式列,剔除 0004 新增的 epg_generation)  */
/* ------------------------------------------------------------------ */

function snapshotLegacy(): string {
  const households = Database.db.prepare('SELECT * FROM household ORDER BY id').all();
  const accounts = Database.db.prepare('SELECT * FROM account ORDER BY id').all();
  const profiles = Database.db.prepare('SELECT * FROM profile ORDER BY id').all();
  const policies = Database.db.prepare('SELECT * FROM profile_policy ORDER BY household_id, profile_id').all();
  return JSON.stringify({ households, accounts, profiles, policies });
}

const MEDIA_SOURCE_COLUMNS =
  'id, household_id, kind, name, remote_url, root_key, relative_directory, private_access_approved, epg_source_id, enabled, version, last_success_at, last_job_id, created_at, updated_at';

function snapshotCatalog(): string {
  const db = Database.db;
  return JSON.stringify({
    sources: db.prepare(`SELECT ${MEDIA_SOURCE_COLUMNS} FROM media_source ORDER BY id`).all(),
    items: db.prepare('SELECT * FROM media_item ORDER BY id').all(),
    entries: db.prepare('SELECT * FROM source_entry ORDER BY id').all(),
    channels: db
      .prepare('SELECT * FROM epg_channel ORDER BY household_id, source_id, xmltv_channel_id')
      .all(),
    programmes: db.prepare('SELECT * FROM epg_programme ORDER BY id').all(),
    catalogState: db.prepare('SELECT * FROM catalog_state ORDER BY household_id').all(),
  });
}

/** 阶段 1/2 业务表 + 阶段 3 九张表 + 0004 一张表 + 版本表 */
const LEGACY_TABLES = [
  'household',
  'account',
  'profile',
  'device',
  'device_session',
  'profile_policy',
  'parent_verification_state',
] as const;

const CATALOG_TABLES = [
  'catalog_state',
  'media_source',
  'media_item',
  'source_entry',
  'playback_source',
  'epg_channel',
  'epg_programme',
  'source_refresh',
  'refresh_stage_entry',
] as const;

function expectFullTableSet(): void {
  expect([...tableNames()].sort()).toEqual(
    [...LEGACY_TABLES, ...CATALOG_TABLES, 'manual_epg_binding', '_migrations'].sort(),
  );
}

function tableNames(): string[] {
  return (
    Database.db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'").all() as {
      name: string;
    }[]
  ).map((row) => row.name);
}

/** 从 0001 起完整搭到 0003(含身份/策略/目录种子),返回夹具 */
function buildThrough0003WithCatalog(): { legacy: LegacyFixture; catalog: CatalogFixture } {
  startFreshDb();
  applyMigration('0001_init');
  const legacy = injectLegacyData();
  applyMigration('0002_profile_policy');
  customizePolicy(legacy);
  applyMigration('0003_media_catalog');
  const catalog = injectCatalogData(legacy.householdAId);
  return { legacy, catalog };
}

describe('0004_manual_epg_binding 迁移升级/回滚(US5 契约 e2e)', () => {
  afterEach(cleanupRigs);

  it('升级:既有目录/节目/身份/PIN/策略逐值不变;无绑定行;既有来源 epg_generation=0;新来源默认 0;PRAGMA 通过', () => {
    const { legacy, catalog } = buildThrough0003WithCatalog();
    const legacyBefore = snapshotLegacy();
    const catalogBefore = snapshotCatalog();

    applyMigration(MIGRATION_NAME);

    // 阶段 1/2 身份/PIN/策略与阶段 3 目录/节目逐值不变
    expect(snapshotLegacy()).toBe(legacyBefore);
    expect(snapshotCatalog()).toBe(catalogBefore);

    // 无绑定行 = 既有频道保持自动行为;不回填既有数据
    expect(bindingCount()).toBe(0);

    // 既有来源(含已成功导入的 EPG 来源)generation 一律为 0,不以 generation>0 判断已导入
    expect(sourceGeneration(catalog.epgSourceId)).toBe(0);
    expect(sourceGeneration(catalog.iptvSourceId)).toBe(0);

    // 新增列 NOT NULL DEFAULT 0 + 非负 CHECK:新行缺省 0;显式 NULL/负数拒绝
    const probeId = randomUUID();
    const now = new Date().toISOString();
    Database.db
      .prepare(
        "INSERT INTO media_source (id, household_id, kind, name, remote_url, root_key, relative_directory, private_access_approved, epg_source_id, enabled, version, last_success_at, last_job_id, created_at, updated_at) VALUES (?, ?, 'iptv', ?, ?, NULL, NULL, 1, NULL, 1, 1, NULL, NULL, ?, ?)",
      )
      .run(probeId, legacy.householdBId, '探针来源', 'http://lan.example/probe.m3u8', now, now);
    expect(sourceGeneration(probeId)).toBe(0);
    const insertSource = Database.db.prepare(
      "INSERT INTO media_source (id, household_id, kind, name, remote_url, epg_generation, enabled, version, created_at, updated_at) VALUES (?, ?, 'iptv', ?, ?, ?, 1, 1, ?, ?)",
    );
    expect(() =>
      insertSource.run(randomUUID(), legacy.householdBId, '空代来源', 'http://lan.example/n.m3u8', null, now, now),
    ).toThrow();
    expect(() =>
      insertSource.run(randomUUID(), legacy.householdBId, '负代来源', 'http://lan.example/n.m3u8', -1, now, now),
    ).toThrow();

    // 表全集 = 既有表 + manual_epg_binding + 版本表;查询辅助索引存在
    expectFullTableSet();
    expect(indexExists('manual_epg_binding_household_source_key')).toBe(true);

    expectIntegrityOk();
    // T009 就绪语义变更:目录已含 0005_playback,本库仅应用 0001~0004(缺 0005 表/列)→ 安全拒绝
    expect(Database.isReady()).toBe(false);
  });

  it('回滚:manual_epg_binding 表/索引与 epg_generation 列移除;原目录/身份/PIN/策略不变;_migrations 记录正确', () => {
    const { legacy, catalog } = buildThrough0003WithCatalog();
    applyMigration(MIGRATION_NAME);
    const legacyBefore = snapshotLegacy();
    const catalogBefore = snapshotCatalog();

    rollbackMigration(MIGRATION_NAME);

    // 0004 新增对象全部移除
    expect(tableExists('manual_epg_binding')).toBe(false);
    expect(indexExists('manual_epg_binding_household_source_key')).toBe(false);
    expect(columnExists('media_source', 'epg_generation')).toBe(false);

    // 原目录(来源/媒体/条目/EPG)与身份/PIN/策略逐值不变
    expect(snapshotLegacy()).toBe(legacyBefore);
    expect(snapshotCatalog()).toBe(catalogBefore);

    // _migrations 记录正确:0004 记录删除,0001~0003 保留且有序
    expect(appliedMigrations()).toEqual(['0001_init', '0002_profile_policy', '0003_media_catalog']);
    expect(tableNames()).not.toContain('manual_epg_binding');

    expectIntegrityOk();
    // 迁移目录含 0004 而记录缺失 → 未就绪(就绪要求记录与目录完全一致)
    expect(Database.isReady()).toBe(false);
    // 防止未使用变量告警:夹具字段在快照中已逐值校验
    expect(catalog.mediaId).toBeDefined();
    expect(legacy.householdBId).toBeDefined();
  });

  it('含手动绑定行的回滚亦成功:绑定随表删除,行为回落自动(不宣称恢复手动配置)', () => {
    const { legacy, catalog } = buildThrough0003WithCatalog();
    applyMigration(MIGRATION_NAME);
    insertManualBinding(legacy.householdAId, catalog.mediaId, catalog.epgSourceId, catalog.xmltvChannelId, 1);
    Database.db.prepare('UPDATE media_source SET epg_generation = 2 WHERE id = ?').run(catalog.epgSourceId);
    expect(bindingCount()).toBe(1);
    expect(sourceGeneration(catalog.epgSourceId)).toBe(2);
    const legacyBefore = snapshotLegacy();
    const catalogBefore = snapshotCatalog();

    rollbackMigration(MIGRATION_NAME);

    // 绑定随表删除:手动配置丢失,行为回落自动(恢复须回滚前备份,迁移自身不宣称恢复)
    expect(tableExists('manual_epg_binding')).toBe(false);
    expect(columnExists('media_source', 'epg_generation')).toBe(false);
    // 原目录/身份/PIN/策略仍逐值不变(0004 down 不删目录数据)
    expect(snapshotLegacy()).toBe(legacyBefore);
    expect(snapshotCatalog()).toBe(catalogBefore);

    expectIntegrityOk();
  });

  it('再升级:目录为空(0004 不恢复目录)、binding 表空、generation=0;_migrations 含 0004;PRAGMA 通过', () => {
    const { legacy, catalog } = buildThrough0003WithCatalog();
    applyMigration(MIGRATION_NAME);

    // 降级序:先回滚 0004(0003 down 不感知 0004 新表)再回滚 0003;再整体升级
    rollbackMigration(MIGRATION_NAME);
    rollbackMigration('0003_media_catalog');
    applyMigration('0003_media_catalog');
    applyMigration(MIGRATION_NAME);

    // 目录为空:0003 不恢复目录,0004 也不恢复(catalog_state 除外:按既有家庭重建修订,见下)
    for (const table of CATALOG_TABLES.filter((name) => name !== 'catalog_state')) {
      const row = Database.db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number };
      expect(row.n).toBe(0);
    }
    expect(Database.db.prepare('SELECT id FROM media_item WHERE id = ?').get(catalog.mediaId)).toBeUndefined();
    // catalog_state 按既有家庭重建,修订重置为 1(与 0003 契约一致)
    const states = Database.db
      .prepare('SELECT household_id, revision FROM catalog_state ORDER BY household_id')
      .all();
    const expectedStates = [
      { household_id: legacy.householdAId, revision: 1 },
      { household_id: legacy.householdBId, revision: 1 },
    ].sort((a, b) => (a.household_id < b.household_id ? -1 : 1));
    expect(states).toEqual(expectedStates);

    // binding 表空;generation 列重建后缺省 0
    expect(bindingCount()).toBe(0);
    const probeId = randomUUID();
    const now = new Date().toISOString();
    Database.db
      .prepare(
        "INSERT INTO media_source (id, household_id, kind, name, remote_url, enabled, version, created_at, updated_at) VALUES (?, ?, 'epg', ?, ?, 1, 1, ?, ?)",
      )
      .run(probeId, legacy.householdBId, '再升级探针', 'http://lan.example/re.xml', now, now);
    expect(sourceGeneration(probeId)).toBe(0);

    expect(appliedMigrations()).toEqual([
      '0001_init',
      '0002_profile_policy',
      '0003_media_catalog',
      '0004_manual_epg_binding',
    ]);
    expectFullTableSet();

    expectIntegrityOk();
    // T009 就绪语义变更:目录已含 0005_playback,本库仅应用 0001~0004(缺 0005 表/列)→ 安全拒绝
    expect(Database.isReady()).toBe(false);
  });

  it('带绑定行与 generation=2 的 down→up 链路:表/列消失后重建为空表、generation 归零,不宣称恢复手动配置', () => {
    const { legacy, catalog } = buildThrough0003WithCatalog();
    applyMigration(MIGRATION_NAME);
    // 手动绑定(manual1→auto2→manual3 的历史终态)与 EPG 发布 generation=2
    insertManualBinding(legacy.householdAId, catalog.mediaId, catalog.epgSourceId, catalog.xmltvChannelId, 3);
    Database.db.prepare('UPDATE media_source SET epg_generation = 2 WHERE id = ?').run(catalog.epgSourceId);

    // 配对 CHECK 与 version 约束在库层生效:auto 墓碑不得携带目标;manual 必须成对;version >= 1
    const insertBinding = Database.db.prepare(
      'INSERT INTO manual_epg_binding (household_id, media_id, mode, epg_source_id, xmltv_channel_id, version, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    );
    const now = new Date().toISOString();
    expect(() =>
      insertBinding.run(legacy.householdAId, catalog.mediaId, 'auto', catalog.epgSourceId, catalog.xmltvChannelId, 9, now),
    ).toThrow(); // auto 墓碑带目标 → 违反成对 CHECK(同 PK 也冲突,约束层仍拒绝)
    expect(() =>
      insertBinding.run(randomUUID(), randomUUID(), 'auto', catalog.epgSourceId, catalog.xmltvChannelId, 9, now),
    ).toThrow();
    expect(() =>
      insertBinding.run(randomUUID(), randomUUID(), 'manual', catalog.epgSourceId, null, 1, now),
    ).toThrow(); // manual 缺频道 → 违反成对 CHECK
    expect(() =>
      insertBinding.run(randomUUID(), randomUUID(), 'auto', null, null, 0, now),
    ).toThrow(); // version=0 → 违反 version CHECK

    const catalogBefore = snapshotCatalog();
    const legacyBefore = snapshotLegacy();

    // down:表与列消失,但 0004 down 不删目录数据(与 0003 down 范围不同)
    rollbackMigration(MIGRATION_NAME);
    expect(tableExists('manual_epg_binding')).toBe(false);
    expect(columnExists('media_source', 'epg_generation')).toBe(false);
    expect(snapshotCatalog()).toBe(catalogBefore);
    expect(snapshotLegacy()).toBe(legacyBefore);

    // up:空表(不恢复手动配置)、既有来源 generation 归零(即使来源行带着原数据存活)
    applyMigration(MIGRATION_NAME);
    expect(bindingCount()).toBe(0);
    expect(sourceGeneration(catalog.epgSourceId)).toBe(0);
    expect(sourceGeneration(catalog.iptvSourceId)).toBe(0);
    expect(snapshotCatalog()).toBe(catalogBefore);
    expect(snapshotLegacy()).toBe(legacyBefore);

    expectIntegrityOk();
    // T009 就绪语义变更:目录已含 0005_playback,本库仅应用 0001~0004(缺 0005 表/列)→ 安全拒绝
    expect(Database.isReady()).toBe(false);
  });

  it('就绪:缺 0004 记录/缺新表/缺新列均未就绪;T009 后缺 0005 的部分形态库始终安全拒绝', () => {
    startFreshDb();
    applyMigration('0001_init');
    applyMigration('0002_profile_policy');
    applyMigration('0003_media_catalog');
    // 迁移目录已含 0004(实现落地后),记录缺失 → 未就绪
    expect(Database.isReady()).toBe(false);

    applyMigration(MIGRATION_NAME);
    // T009 就绪语义变更:目录已含 0005_playback,应用 0004 后仍缺 0005 记录/表/列 → 安全拒绝
    expect(Database.isReady()).toBe(false);

    // 缺新列:表在列不在(升级中断/降级残留)同样不可就绪
    Database.db.exec('ALTER TABLE media_source DROP COLUMN epg_generation');
    expect(Database.isReady()).toBe(false); // 缺列与缺 0005 双重缺失,一律未就绪
    Database.db.exec('ALTER TABLE media_source ADD COLUMN epg_generation INTEGER NOT NULL DEFAULT 0');
    // T009 就绪语义变更:列已补回,但缺 0005 记录/表/列 → 仍安全拒绝
    expect(Database.isReady()).toBe(false);

    // 缺新表:重命名模拟表缺失
    Database.db.exec('ALTER TABLE manual_epg_binding RENAME TO manual_epg_binding_absent');
    expect(Database.isReady()).toBe(false); // 缺表与缺 0005 双重缺失,一律未就绪
    Database.db.exec('ALTER TABLE manual_epg_binding_absent RENAME TO manual_epg_binding');
    // T009 就绪语义变更:表已还原,但缺 0005 记录/表/列 → 仍安全拒绝
    expect(Database.isReady()).toBe(false);

    expectIntegrityOk();
  });

  it('drill:独立临时 DATA_DIR 上 migration:drill 通过(0004/0005 参与终态表/列校验)', () => {
    const drillDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hmp-manual-epg-drill-'));
    const drillDb = `${randomUUID()}.hmp.db`;
    rigs.push({ dataDir: drillDir, dbFilename: drillDb });
    const dbFile = path.join(drillDir, drillDb);
    const tsxCli = path.join(process.cwd(), 'node_modules', 'tsx', 'dist', 'cli.mjs');

    // CLI 层面演练:up → down → up(终态须全部已应用、表/列齐备),与 pnpm migration:drill 同命令
    const stdout = execFileSync(process.execPath, [tsxCli, 'src/platform/database/migrate.ts', 'drill'], {
      cwd: process.cwd(),
      env: { ...process.env, NODE_ENV: 'test', DATA_DIR: drillDir, DB_FILENAME: drillDb },
      encoding: 'utf8',
    });

    expect(stdout).toContain('已应用 0004_manual_epg_binding');
    expect(stdout).toContain('drill 通过');
    expect(stdout).toContain('manual_epg_binding');

    // 演练终态独立核验:0004/0005 已应用(T009:drill 终态 _migrations 为 5 条;0006 起为 6 条;
    // 010 0007 起为 7 条;013 0008 起为 8 条;014 0009 起为 9 条;016 0010 起为 10 条)、
    // 0004 新列在、绑定表空、完整性通过
    const conn = new DatabaseConstructor(dbFile);
    try {
      const applied = (conn.prepare('SELECT name FROM _migrations ORDER BY name').all() as { name: string }[]).map(
        (row) => row.name,
      );
      expect(applied).toEqual([
        '0001_init',
        '0002_profile_policy',
        '0003_media_catalog',
        '0004_manual_epg_binding',
        '0005_playback',
        '0006_pc_experience',
        '0007_online_vod',
        '0008_profile_preferences',
        '0009_channel_logos',
        '0010_multi_source_priority',
      ]);
      expect(
        (conn.pragma('table_info(media_source)') as { name: string }[]).some((row) => row.name === 'epg_generation'),
      ).toBe(true);
      expect((conn.prepare('SELECT COUNT(*) AS n FROM manual_epg_binding').get() as { n: number }).n).toBe(0);
      expect(conn.pragma('integrity_check')).toEqual([{ integrity_check: 'ok' }]);
      expect(conn.pragma('foreign_key_check')).toEqual([]);
    } finally {
      conn.close();
    }
  });
});
