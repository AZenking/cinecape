import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { Database } from '@platform/database/database';
import { setEnvOverride } from '@platform/config/env';
import { loadEnv } from '@platform/config/env.schema';

/**
 * T008(阶段 3 契约 e2e):0003_media_catalog 迁移升级/回滚矩阵,对照
 * docs/specs/003-media-catalog/data-model.md「迁移与回滚」与 spec SC-006 前置:
 * - 升级路径:以仅应用 0001/0002 的库构造阶段 1/2 数据(直写 SQL 夹具,不经 HTTP),
 *   再应用 0003 up.sql,断言既有 Household/Account/Profile/PIN/策略值不变,
 *   且每个既有 Household 获得 catalog_state(revision=1)。
 * - 回滚路径:down 仅删除本阶段新表/索引,阶段 1/2 数据保留;策略中的媒体引用
 *   保留为失效引用,不自行清空(data-model.md「迁移与回滚」)。
 * - 再升级路径:up 得到空目录,不恢复原媒体 ID;catalog_state 重建为 revision=1。
 * - 完整性:PRAGMA integrity_check 与 foreign_key_check 通过;应用全部迁移后 isReady()。
 *
 * 独立临时 DATA_DIR:本文件内联实现夹具(setEnvOverride + Database.close 单例重置),
 * 不复用 test/helpers.ts(该文件由并行任务所有);迁移以 src/platform/database/migrations 权威 DDL 直读。
 */

interface CatalogMigrationRig {
  dataDir: string;
  dbFilename: string;
}

const rigs: CatalogMigrationRig[] = [];

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

/** 全新环境:独立临时数据目录 + 空版本表(与 helpers.startFreshApp 同模式,但只做迁移不做 HTTP) */
function startFreshDb(): void {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hmp-catalog-mig-'));
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

/** 回滚单条迁移(事务内执行:down.sql 的 defer_foreign_keys 依赖事务边界) */
function rollbackMigration(name: string): void {
  const conn = Database.db;
  conn.transaction(() => {
    conn.exec(migrationSql(name, 'down.sql'));
    conn.prepare('DELETE FROM _migrations WHERE name = ?').run(name);
  })();
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

function currentTables(): string[] {
  return (
    Database.db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'").all() as {
      name: string;
    }[]
  ).map((row) => row.name);
}

function expectIntegrityOk(): void {
  expect(Database.db.pragma('integrity_check')).toEqual([{ integrity_check: 'ok' }]);
  expect(Database.db.pragma('foreign_key_check')).toEqual([]);
}

interface Stage2Fixture {
  householdAId: string;
  householdBId: string;
  accountId: string;
  adultWithPinId: string;
  childId: string;
  /** 仅存在于策略名单、媒体表中从未出现的"失效引用"媒体 ID */
  staleMediaId: string;
}

/** 直写阶段 1 形态身份行(家庭甲:账号+有 PIN 成人+儿童;家庭乙:空家庭),不经 HTTP */
function injectStage2Data(): Stage2Fixture {
  const ids: Stage2Fixture = {
    householdAId: randomUUID(),
    householdBId: randomUUID(),
    accountId: randomUUID(),
    adultWithPinId: randomUUID(),
    childId: randomUUID(),
    staleMediaId: randomUUID(),
  };
  const now = new Date().toISOString();
  const db = Database.db;
  const insertHousehold = db.prepare(
    'INSERT INTO household (id, name, default_language, timezone, created_at) VALUES (?, ?, ?, ?, ?)',
  );
  insertHousehold.run(ids.householdAId, '目录迁移家庭甲', 'zh-CN', 'Asia/Shanghai', now);
  insertHousehold.run(ids.householdBId, '目录迁移家庭乙', 'zh-CN', 'Asia/Shanghai', now);
  db.prepare(
    'INSERT INTO account (id, household_id, username, username_normalized, password_hash, role, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
  ).run(ids.accountId, ids.householdAId, 'cataloger', 'cataloger', '$argon2id$fixture-hash', 'owner', now);
  const insertProfile = db.prepare(
    'INSERT INTO profile (id, household_id, account_id, name, avatar, type, is_default, pin_hash, status, failed_pin_count, pin_locked_until, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
  );
  insertProfile.run(ids.adultWithPinId, ids.householdAId, ids.accountId, '有码成人', null, 'adult', 1, '$argon2id$pin', 'active', 0, null, now);
  insertProfile.run(ids.childId, ids.householdAId, ids.accountId, '儿童', null, 'child', 0, null, 'active', 0, null, now);
  return ids;
}

/** 在 0002 之上写入自定义策略值(含指向不存在媒体的名单引用),证明 down/up 全程不动策略 */
function customizePolicy(fixture: Stage2Fixture): void {
  Database.db
    .prepare(
      "UPDATE profile_policy SET max_content_level = 9, version = 4, allowed_media_ids = ? WHERE profile_id = ?",
    )
    .run(JSON.stringify([fixture.staleMediaId]), fixture.childId);
}

interface CatalogFixture {
  sourceId: string;
  mediaId: string;
  entryId: string;
}

/** 在 0003 之上写入最小目录数据(IPTV 来源 + 媒体 + 条目),用于验证 down 后目录清空 */
function injectCatalogData(householdId: string): CatalogFixture {
  const ids = { sourceId: randomUUID(), mediaId: randomUUID(), entryId: randomUUID() };
  const now = new Date().toISOString();
  const db = Database.db;
  db.prepare(
    "INSERT INTO media_source (id, household_id, kind, name, remote_url, root_key, relative_directory, private_access_approved, epg_source_id, enabled, version, last_success_at, last_job_id, created_at, updated_at) VALUES (?, ?, 'iptv', ?, ?, NULL, NULL, 1, NULL, 1, 1, NULL, NULL, ?, ?)",
  ).run(ids.sourceId, householdId, '受控IPTV', 'http://lan.example/list.m3u8', now, now);
  db.prepare(
    "INSERT INTO media_item (id, household_id, type, title, description, poster_ref, content_level, title_overridden, type_overridden, version, created_at, updated_at) VALUES (?, ?, 'channel', ?, NULL, NULL, NULL, 0, 0, 1, ?, ?)",
  ).run(ids.mediaId, householdId, '频道甲', now, now);
  db.prepare(
    "INSERT INTO source_entry (id, household_id, source_id, identity_kind, identity_digest, media_id, upstream_channel_id, present, last_seen_job_id, first_seen_at, last_seen_at, missing_since, file_size_text, file_mtime_ns) VALUES (?, ?, ?, 'tvg_id', ?, ?, NULL, 1, NULL, ?, ?, NULL, NULL, NULL)",
  ).run(
    ids.entryId,
    householdId,
    ids.sourceId,
    createHash('sha256').update(`tvg_id:cctv-1`).digest('hex'),
    ids.mediaId,
    now,
    now,
  );
  return ids;
}

/** 阶段 1/2 数据快照:身份行 + 策略行,确定性排序后 JSON 序列化,用于前后对比 */
function snapshotLegacyData(): string {
  const households = Database.db.prepare('SELECT * FROM household ORDER BY id').all();
  const accounts = Database.db.prepare('SELECT * FROM account ORDER BY id').all();
  const profiles = Database.db.prepare('SELECT * FROM profile ORDER BY id').all();
  const policies = Database.db.prepare('SELECT * FROM profile_policy ORDER BY household_id, profile_id').all();
  return JSON.stringify({ households, accounts, profiles, policies });
}

/** 阶段 3 全部业务表(含版本表之外的既有表数量校验在用例内断言) */
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

const LEGACY_TABLES = [
  'household',
  'account',
  'profile',
  'device',
  'device_session',
  'profile_policy',
  'parent_verification_state',
] as const;

describe('0003_media_catalog 迁移升级/回滚(阶段 3 契约 e2e)', () => {
  afterEach(cleanupRigs);

  it('升级:既有 Household/Account/Profile/PIN/策略值不变;每个既有 Household 获得 catalog_state(revision=1);PRAGMA 通过', () => {
    startFreshDb();
    applyMigration('0001_init');
    // 与 policy-migration 同序:先注入阶段 1 身份行,再应用 0002 回填策略,构造真实升级前形态
    const f = injectStage2Data();
    applyMigration('0002_profile_policy');
    customizePolicy(f);
    const before = snapshotLegacyData();

    applyMigration('0003_media_catalog');

    // 阶段 1/2 身份/PIN/策略(含自定义值与名单)逐字节不变
    expect(snapshotLegacyData()).toBe(before);

    // 每个既有 Household 恰好一行 catalog_state,revision 默认 1(与 SQLite 二进制序一致)
    const states = Database.db.prepare('SELECT household_id, revision FROM catalog_state ORDER BY household_id').all();
    const expectedStates = [
      { household_id: f.householdAId, revision: 1 },
      { household_id: f.householdBId, revision: 1 },
    ].sort((a, b) => (a.household_id < b.household_id ? -1 : 1));
    expect(states).toEqual(expectedStates);

    // 表全集 = 阶段 1/2 业务表 + 阶段 3 九张新表 + 版本表,无多余表
    expect([...currentTables()].sort()).toEqual(
      [...LEGACY_TABLES, ...CATALOG_TABLES, '_migrations'].sort(),
    );
    // 运行锁部分唯一索引存在
    expect(indexExists('one_active_refresh_per_source')).toBe(true);

    expectIntegrityOk();
  });

  it('回滚:仅删除本阶段新表/索引;阶段 1/2 数据保留,策略中的媒体引用保留为失效引用不清空', () => {
    startFreshDb();
    applyMigration('0001_init');
    const f = injectStage2Data();
    applyMigration('0002_profile_policy');
    customizePolicy(f);
    applyMigration('0003_media_catalog');
    injectCatalogData(f.householdAId);
    const before = snapshotLegacyData();

    rollbackMigration('0003_media_catalog');

    // 本阶段九张新表与自建索引全部移除(device_session 为既有表,仅移除其上的新索引)
    for (const table of CATALOG_TABLES) {
      expect(tableExists(table)).toBe(false);
    }
    expect(indexExists('one_active_refresh_per_source')).toBe(false);
    expect(indexExists('device_session_household_id_id_key')).toBe(false);
    // 阶段 1/2 业务表全部保留
    for (const table of LEGACY_TABLES) {
      expect(tableExists(table)).toBe(true);
    }

    // 身份/PIN/策略逐字节不变:allowed_media_ids 仍指向已不存在的媒体(失效引用保留)
    expect(snapshotLegacyData()).toBe(before);
    const policy = Database.db.prepare('SELECT * FROM profile_policy WHERE profile_id = ?').get(f.childId) as {
      max_content_level: number;
      version: number;
      allowed_media_ids: string;
    };
    expect(policy).toMatchObject({ max_content_level: 9, version: 4 });
    expect(JSON.parse(policy.allowed_media_ids)).toEqual([f.staleMediaId]);

    expectIntegrityOk();
  });

  it('再升级:目录为空、原媒体 ID 不恢复;catalog_state 重建为 revision=1;库整体就绪', () => {
    startFreshDb();
    applyMigration('0001_init');
    const f = injectStage2Data();
    applyMigration('0002_profile_policy');
    customizePolicy(f);
    applyMigration('0003_media_catalog');
    const catalog = injectCatalogData(f.householdAId);
    const before = snapshotLegacyData();

    rollbackMigration('0003_media_catalog');
    applyMigration('0003_media_catalog');

    // 目录为空:媒体 ID 不恢复(完整恢复须使用停服下回滚前的一致性备份)
    for (const table of ['media_source', 'media_item', 'source_entry', 'playback_source', 'epg_channel', 'epg_programme', 'source_refresh', 'refresh_stage_entry']) {
      const row = Database.db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number };
      expect(row.n).toBe(0);
    }
    expect(Database.db.prepare('SELECT id FROM media_item WHERE id = ?').get(catalog.mediaId)).toBeUndefined();
    // catalog_state 按既有家庭重建,修订重置为 1
    const states = Database.db.prepare('SELECT household_id, revision FROM catalog_state ORDER BY household_id').all();
    const expectedStates = [
      { household_id: f.householdAId, revision: 1 },
      { household_id: f.householdBId, revision: 1 },
    ].sort((a, b) => (a.household_id < b.household_id ? -1 : 1));
    expect(states).toEqual(expectedStates);
    // 阶段 1/2 数据与失效引用仍不受再升级影响
    expect(snapshotLegacyData()).toBe(before);

    expectIntegrityOk();
    // 就绪语义同步(US5 增补):目录含 0004 后,0003-only 库不再就绪
    expect(Database.isReady()).toBe(false);
    applyMigration('0004_manual_epg_binding');
    // T009 就绪语义变更:目录已含 0005_playback,仅应用 0001~0004 的部分形态库缺 0005 表/列 → 仍安全拒绝(未就绪)
    expect(Database.isReady()).toBe(false);
  });
});
