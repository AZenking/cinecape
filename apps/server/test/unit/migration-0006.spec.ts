import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import DatabaseConstructor from 'better-sqlite3';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { Database } from '@platform/database/database';
import { loadEnv } from '@platform/config/env.schema';
import { setEnvOverride } from '@platform/config/env';
import { runMigrationCommand } from '@platform/database/migrate';
import {
  MigrationGateError,
  precheckDatabaseFile,
  precheckForStartup,
} from '@platform/database/precheck';

/**
 * T008(005-pc-browsing-flow · Phase 2):0006_pc_experience 迁移与预检测试。
 *
 * - 独立临时目录夹具(照 epg/manual-binding.spec 模式:setEnvOverride + Database.close
 *   单例重置,不复用 test/helpers.ts),每用例独立 DATA_DIR/DB 文件;
 * - 覆盖 T006 全部新表/索引/复合FK/CHECK、空库 up/down/up(drill)、user_version 断言;
 * - 覆盖 T007:旧已初始化库(0001~0005)只读拒绝 STORAGE_GENERATION_UNSUPPORTED 且
 *   文件字节不变;损坏/未知状态拒绝;
 * - grant 撤销 / 活动播放恢复的完整业务行为由 T140 验证,本文件不要求。
 */

/** 与生产 migrate.ts 同目录权威:全部迁移(含 0006)与旧代际(0001~0005)清单 */
const ALL_MIGRATIONS = [
  '0001_init',
  '0002_profile_policy',
  '0003_media_catalog',
  '0004_manual_epg_binding',
  '0005_playback',
  '0006_pc_experience',
];

const LEGACY_MIGRATIONS = ALL_MIGRATIONS.filter((name) => name !== '0006_pc_experience');

const T0 = '2026-10-26T00:00:00.000Z';

interface Rig {
  dataDir: string;
  dbFilename: string;
  dbFile: string;
}

const rigs: Rig[] = [];

function newRig(prefix: string): Rig {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const dbFilename = `${randomUUID()}.hmp.db`;
  const rig: Rig = { dataDir, dbFilename, dbFile: path.join(dataDir, dbFilename) };
  rigs.push(rig);
  return rig;
}

function applyEnv(rig: Rig): void {
  setEnvOverride(loadEnv({ NODE_ENV: 'test', DATA_DIR: rig.dataDir, DB_FILENAME: rig.dbFilename }));
}

function migrationSql(name: string, file: 'up.sql' | 'down.sql'): string {
  const p = path.join(process.cwd(), 'src/platform/database/migrations', name, file);
  return fs.readFileSync(p, 'utf8');
}

/** 与 migrate.ts 同语义应用单条 up.sql 并记录 _migrations(测试夹具内联实现) */
function applyMigrationUp(name: string): void {
  Database.db.exec(migrationSql(name, 'up.sql'));
  Database.db.prepare('INSERT INTO _migrations (name, applied_at) VALUES (?, ?)').run(name, T0);
}

/** 旧代际库(0001~0005 + _migrations,无 user_version 设置 —— 旧应用从不设置) */
function buildLegacyRig(): Rig {
  const rig = newRig('hmp-0006-legacy-');
  applyEnv(rig);
  Database.db.exec(
    'CREATE TABLE IF NOT EXISTS _migrations (name TEXT PRIMARY KEY NOT NULL, applied_at TEXT NOT NULL)',
  );
  for (const name of LEGACY_MIGRATIONS) {
    applyMigrationUp(name);
  }
  // 一行真实业务数据:拒绝时必须原样保留(字节不变)
  Database.db
    .prepare(
      "INSERT INTO household (id, name, created_at) VALUES ('hh-legacy', '旧库家庭', ?)",
    )
    .run(T0);
  return rig;
}

/** 全新库:应用目录全量迁移(含 0006,即 runMigrationCommand('up') 的产物形态) */
function buildGeneration2Rig(): Rig {
  const rig = newRig('hmp-0006-fresh-');
  applyEnv(rig);
  runMigrationCommand('up');
  return rig;
}

/** 二号家庭的合法主档案:构造"真实跨家庭"负向用例(父行存在,仅家庭错位) */
function seedSecondMain(): void {
  Database.db
    .prepare(
      "INSERT INTO profile (id, household_id, account_id, name, type, pin_hash, status, is_main, created_at) VALUES ('prof-main-h2', 'hh-2', 'acc-2', '二号主档案', 'adult', 'pin-2', 'active', 1, ?)",
    )
    .run(T0);
}

function userVersion(): number {
  return Database.db.pragma('user_version', { simple: true }) as number;
}

function tableNames(): string[] {
  return (
    Database.db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")
      .all() as { name: string }[]
  ).map((row) => row.name);
}

function indexNames(table?: string): string[] {
  const rows = table === undefined
    ? (Database.db.prepare("SELECT name FROM sqlite_master WHERE type = 'index'").all() as {
        name: string;
      }[])
    : (Database.db.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = ?").all(
        table,
      ) as { name: string }[]);
  return rows.map((row) => row.name);
}

function columnsOf(table: string): { name: string; notnull: number; dflt_value: unknown }[] {
  return (
    Database.db.pragma(`table_info(${table})`) as {
      name: string;
      notnull: number;
      dflt_value: unknown;
    }[]
  ).map((row) => ({ name: row.name, notnull: row.notnull, dflt_value: row.dflt_value }));
}

function expectColumns(table: string, expected: string[]): void {
  expect(columnsOf(table).map((column) => column.name)).toEqual(expected);
}

function sha256(file: string): string {
  return createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

/** 负向插入:断言以 SQLITE 约束错误拒绝(片段匹配 CHECK/UNIQUE/FOREIGN KEY) */
function expectRejected(run: () => void, fragment: RegExp): void {
  expect(run).toThrowError(fragment);
}

/* ------------------------------------------------------------------ */
/* 有效父行种子:覆盖五张新表 FK 的全部父表(主档案+副档案+设备会话+播放会话) */
/* ------------------------------------------------------------------ */

interface Seed {
  householdId: string;
  secondHouseholdId: string;
  accountId: string;
  mainProfileId: string;
  childProfileId: string;
  deviceId: string;
  deviceSessionId: string;
  mediaChannelId: string;
  mediaChannelId2: string;
  playbackSessionId: string;
}

function seedParents(): Seed {
  const db = Database.db;
  const s: Seed = {
    householdId: 'hh-1',
    secondHouseholdId: 'hh-2',
    accountId: 'acc-1',
    mainProfileId: 'prof-main',
    childProfileId: 'prof-child',
    deviceId: 'dev-1',
    deviceSessionId: 'sess-1',
    mediaChannelId: 'media-ch-1',
    mediaChannelId2: 'media-ch-2',
    playbackSessionId: 'pbs-1',
  };
  db.prepare('INSERT INTO household (id, name, created_at) VALUES (?, ?, ?)').run(
    s.householdId,
    '一号家庭',
    T0,
  );
  db.prepare('INSERT INTO household (id, name, created_at) VALUES (?, ?, ?)').run(
    s.secondHouseholdId,
    '二号家庭',
    T0,
  );
  db.prepare(
    'INSERT INTO account (id, household_id, username, username_normalized, password_hash, role, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
  ).run(s.accountId, s.householdId, 'admin', 'admin', 'hash-1', 'owner', T0);
  db.prepare(
    'INSERT INTO account (id, household_id, username, username_normalized, password_hash, role, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
  ).run('acc-2', s.secondHouseholdId, 'admin2', 'admin2', 'hash-2', 'owner', T0);
  // 主档案:成人/启用/有 PIN(is_main=1)
  db.prepare(
    "INSERT INTO profile (id, household_id, account_id, name, type, pin_hash, status, is_main, created_at) VALUES (?, ?, ?, '主档案', 'adult', 'pin-hash', 'active', 1, ?)",
  ).run(s.mainProfileId, s.householdId, s.accountId, T0);
  // 副档案:儿童无 PIN(is_main 缺省 0)
  db.prepare(
    "INSERT INTO profile (id, household_id, account_id, name, type, status, created_at) VALUES (?, ?, ?, '儿童档案', 'child', 'active', ?)",
  ).run(s.childProfileId, s.householdId, s.accountId, T0);
  db.prepare("INSERT INTO device (id, household_id, type, created_at) VALUES (?, ?, 'web', ?)").run(
    s.deviceId,
    s.householdId,
    T0,
  );
  db.prepare(
    'INSERT INTO device_session (id, household_id, account_id, device_id, token_hash, expires_at, last_active_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
  ).run(s.deviceSessionId, s.householdId, s.accountId, s.deviceId, `tok-${s.deviceSessionId}`, '2026-12-31T00:00:00.000Z', T0, T0);
  db.prepare(
    "INSERT INTO media_item (id, household_id, type, title, version, created_at, updated_at) VALUES (?, ?, 'channel', '频道一', 1, ?, ?)",
  ).run(s.mediaChannelId, s.householdId, T0, T0);
  db.prepare(
    "INSERT INTO media_item (id, household_id, type, title, version, created_at, updated_at) VALUES (?, ?, 'channel', '频道二', 1, ?, ?)",
  ).run(s.mediaChannelId2, s.secondHouseholdId, T0, T0);
  db.prepare(
    "INSERT INTO playback_session (id, household_id, device_session_id, device_id, profile_id, media_id, state, generation, version, position_seconds, created_at, last_heartbeat_at) VALUES (?, ?, ?, ?, ?, ?, 'preparing', 1, 1, 0, ?, ?)",
  ).run(s.playbackSessionId, s.householdId, s.deviceSessionId, s.deviceId, s.mainProfileId, s.mediaChannelId, T0, T0);
  return s;
}

beforeEach(() => {
  Database.close();
});

afterAll(() => {
  while (rigs.length > 0) {
    const rig = rigs.pop();
    if (rig === undefined) break;
    fs.rmSync(rig.dataDir, { recursive: true, force: true });
  }
  Database.close();
  setEnvOverride(null);
});

describe('0006_pc_experience · 空库 up:结构逐字落地(T006)', () => {
  it('全新空库 up:五张新表落位、user_version=2、迁移记录齐全', () => {
    const rig = newRig('hmp-0006-up-');
    applyEnv(rig);
    runMigrationCommand('up');

    expect(userVersion()).toBe(2);
    const applied = (
      Database.db.prepare('SELECT name FROM _migrations ORDER BY name').all() as { name: string }[]
    ).map((row) => row.name);
    expect(applied).toEqual(ALL_MIGRATIONS);

    const tables = tableNames();
    for (const table of [
      'settings_access_grant',
      'profile_channel_favorite',
      'profile_progress_clock',
      'playback_progress_state',
      'profile_viewing_history',
    ]) {
      expect(tables).toContain(table);
    }
  });

  it('五张新表列形态逐字一致(联合主键/可空性/默认值)', () => {
    buildGeneration2Rig();
    expectColumns('settings_access_grant', [
      'household_id',
      'device_session_id',
      'profile_id',
      'profile_context_version',
      'pin_version',
      'main_profile_version',
      'issued_at',
      'expires_at',
      'revoked_at',
    ]);
    expectColumns('profile_channel_favorite', [
      'household_id',
      'profile_id',
      'media_id',
      'created_at',
    ]);
    expectColumns('profile_progress_clock', ['household_id', 'profile_id', 'next_epoch']);
    expectColumns('playback_progress_state', [
      'household_id',
      'playback_session_id',
      'profile_id',
      'media_id',
      'candidate_epoch',
      'content_revision',
      'profile_context_version',
      'started',
      'last_sample_seq',
      'last_sample_digest',
      'last_generation',
      'last_result',
    ]);
    expectColumns('profile_viewing_history', [
      'household_id',
      'profile_id',
      'media_id',
      'writer_epoch',
      'writer_playback_session_id',
      'last_sample_seq',
      'content_revision',
      'position_seconds',
      'duration_seconds',
      'last_viewed_at',
      'revision',
    ]);
    // started/last_sample_seq 默认值(0)
    const started = columnsOf('playback_progress_state').find((c) => c.name === 'started');
    expect(started?.dflt_value).toBe('0');
  });

  it('既有实体扩展列与默认值(§2)', () => {
    buildGeneration2Rig();
    const expectColumn = (table: string, name: string, dflt: string | null): void => {
      const column = columnsOf(table).find((entry) => entry.name === name);
      expect(column, `${table}.${name} 应存在`).toBeDefined();
      expect(column?.notnull).toBe(1);
      expect(column?.dflt_value).toBe(dflt);
    };
    expectColumn('household', 'version', '1');
    expectColumn('household', 'main_profile_version', '1');
    expectColumn('account', 'credential_version', '1');
    expectColumn('profile', 'is_main', '0');
    expectColumn('profile', 'pin_version', '1');
    expectColumn('profile', 'version', '1');
    expectColumn('device_session', 'profile_context_version', '1');
    expectColumn('playback_session', 'profile_context_version', '1');
    expectColumn('media_item', 'content_revision', '1');
    // group_title 可空,无默认
    const groupTitle = columnsOf('source_entry').find((entry) => entry.name === 'group_title');
    expect(groupTitle?.notnull).toBe(0);
    expect(groupTitle?.dflt_value).toBeNull();
  });

  it('索引:one_main_profile 部分唯一索引/收藏与历史列表索引/programme 窗口索引确认', () => {
    buildGeneration2Rig();
    // profile(household_id) WHERE is_main=1
    const oneMain = Database.db
      .prepare("SELECT sql FROM sqlite_master WHERE type = 'index' AND name = 'one_main_profile'")
      .get() as { sql: string } | undefined;
    expect(oneMain?.sql).toContain('WHERE');
    expect(oneMain?.sql).toContain('is_main = 1');
    // data-model §4/§7 列表索引((created_at|last_viewed_at) DESC, media_id DESC)
    expect(indexNames('profile_channel_favorite')).toContain(
      'profile_channel_favorite_profile_listed_key',
    );
    const favIdx = Database.db
      .prepare(
        "SELECT sql FROM sqlite_master WHERE name = 'profile_channel_favorite_profile_listed_key'",
      )
      .get() as { sql: string };
    expect(favIdx.sql.replace(/\s+/g, ' ')).toContain(
      '(household_id, profile_id, created_at DESC, media_id DESC)',
    );
    expect(indexNames('profile_viewing_history')).toContain(
      'profile_viewing_history_profile_recent_key',
    );
    // data-model §8 programme 窗口索引:0003 的 UNIQUE epg_programme_slot_key 恰为同五列
    const slot = Database.db
      .prepare("SELECT sql FROM sqlite_master WHERE name = 'epg_programme_slot_key'")
      .get() as { sql: string };
    expect(slot.sql.replace(/\s+/g, ' ')).toContain(
      '(household_id, source_id, xmltv_channel_id, starts_at, ends_at)',
    );
  });
});

describe('0006_pc_experience · 数据层约束负向(复合FK/CHECK)', () => {
  beforeEach(() => {
    buildGeneration2Rig();
    seedParents();
  });

  it('主档案唯一索引:同家庭第二个 is_main=1 被拒,跨家庭允许', () => {
    const db = Database.db;
    expectRejected(
      () =>
        db
          .prepare(
            "INSERT INTO profile (id, household_id, account_id, name, type, pin_hash, status, is_main, created_at) VALUES ('prof-main-2', 'hh-1', 'acc-1', '第二主档案', 'adult', 'pin', 'active', 1, ?)",
          )
          .run(T0),
      /UNIQUE constraint failed/,
    );
    expect(() =>
      db
        .prepare(
          "INSERT INTO profile (id, household_id, account_id, name, type, pin_hash, status, is_main, created_at) VALUES ('prof-main-h2', 'hh-2', 'acc-2', '二号主档案', 'adult', 'pin', 'active', 1, ?)",
        )
        .run(T0),
    ).not.toThrow();
  });

  it('主档案 CHECK:儿童/停用/无 PIN 写 is_main=1 被拒', () => {
    const base =
      'INSERT INTO profile (id, household_id, account_id, name, type, pin_hash, status, is_main, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?)';
    const db = Database.db;
    // 儿童
    expectRejected(
      () => db.prepare(base).run('p-c', 'hh-1', 'acc-1', '儿童主', 'child', 'pin', 'active', T0),
      /CHECK constraint failed: profile_main_profile_check/,
    );
    // 停用
    expectRejected(
      () =>
        db.prepare(base).run('p-d', 'hh-1', 'acc-1', '停用主', 'adult', 'pin', 'disabled', T0),
      /CHECK constraint failed: profile_main_profile_check/,
    );
    // 无 PIN
    expectRejected(
      () => db.prepare(base).run('p-n', 'hh-1', 'acc-1', '无PIN主', 'adult', null, 'active', T0),
      /CHECK constraint failed: profile_main_profile_check/,
    );
  });

  it('settings_access_grant:同家庭复合FK、版本与有效期 CHECK', () => {
    const db = Database.db;
    seedSecondMain();
    const insert =
      'INSERT INTO settings_access_grant (household_id, device_session_id, profile_id, profile_context_version, pin_version, main_profile_version, issued_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)';
    // 合法行
    expect(() =>
      db.prepare(insert).run('hh-1', 'sess-1', 'prof-main', 1, 1, 1, T0, '2026-10-26T00:15:00.000Z'),
    ).not.toThrow();
    // 联合主键:每设备会话一行
    expectRejected(
      () =>
        db.prepare(insert).run('hh-1', 'sess-1', 'prof-main', 2, 1, 1, T0, '2026-10-26T00:15:00.000Z'),
      /UNIQUE constraint failed/,
    );
    // 跨家庭 device_session:复合FK拒绝
    expectRejected(
      () =>
        db.prepare(insert).run('hh-2', 'sess-1', 'prof-main-h2', 1, 1, 1, T0, '2026-10-26T00:15:00.000Z'),
      /FOREIGN KEY constraint failed/,
    );
    // expires_at = issued_at(相等亦拒绝)
    expectRejected(
      () => db.prepare(insert).run('hh-1', 'sess-2', 'prof-main', 1, 1, 1, T0, T0),
      /CHECK constraint failed: settings_access_grant_expiry_check/,
    );
    // 版本 < 1
    expectRejected(
      () =>
        db.prepare(insert).run('hh-1', 'sess-2', 'prof-main', 0, 1, 1, T0, '2026-10-26T00:15:00.000Z'),
      /CHECK constraint failed/,
    );
  });

  it('profile_channel_favorite:三元联合主键与 Profile/Media 同家庭复合FK', () => {
    const db = Database.db;
    seedSecondMain();
    const insert =
      'INSERT INTO profile_channel_favorite (household_id, profile_id, media_id, created_at) VALUES (?, ?, ?, ?)';
    expect(() => db.prepare(insert).run('hh-1', 'prof-main', 'media-ch-1', T0)).not.toThrow();
    expectRejected(
      () => db.prepare(insert).run('hh-1', 'prof-main', 'media-ch-1', T0),
      /UNIQUE constraint failed/,
    );
    // 媒体跨家庭 → 复合FK拒绝
    expectRejected(
      () => db.prepare(insert).run('hh-1', 'prof-main', 'media-ch-2', T0),
      /FOREIGN KEY constraint failed/,
    );
    // Profile 跨家庭 → 复合FK拒绝
    expectRejected(
      () => db.prepare(insert).run('hh-1', 'prof-main-h2', 'media-ch-1', T0),
      /FOREIGN KEY constraint failed/,
    );
  });

  it('profile_progress_clock:联合主键与 next_epoch >= 1', () => {
    const db = Database.db;
    const insert =
      'INSERT INTO profile_progress_clock (household_id, profile_id, next_epoch) VALUES (?, ?, ?)';
    expect(() => db.prepare(insert).run('hh-1', 'prof-main', 1)).not.toThrow();
    expectRejected(
      () => db.prepare(insert).run('hh-1', 'prof-main', 2),
      /UNIQUE constraint failed/,
    );
    expectRejected(
      () => db.prepare(insert).run('hh-1', 'prof-child', 0),
      /CHECK constraint failed: profile_progress_clock_next_epoch_check/,
    );
  });

  it('playback_progress_state:联合主键/三向复合FK/状态 CHECK', () => {
    const db = Database.db;
    const insert =
      'INSERT INTO playback_progress_state (household_id, playback_session_id, profile_id, media_id, candidate_epoch, content_revision, profile_context_version, started, last_sample_seq, last_sample_digest, last_generation, last_result) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)';
    const valid = ['hh-1', 'pbs-1', 'prof-main', 'media-ch-1', 1, 1, 1, 0, 0, null, 1, null];
    expect(() => db.prepare(insert).run(...valid)).not.toThrow();
    expectRejected(() => db.prepare(insert).run(...valid), /UNIQUE constraint failed/);
    // candidate_epoch 0(data-model ">0")
    expectRejected(
      () => db.prepare(insert).run('hh-1', 'pbs-2', 'prof-main', 'media-ch-1', 0, 1, 1, 0, 0, null, 1, null),
      /CHECK constraint failed: playback_progress_state_candidate_epoch_check/,
    );
    // started 非 0/1
    expectRejected(
      () => db.prepare(insert).run('hh-1', 'pbs-2', 'prof-main', 'media-ch-1', 1, 1, 1, 2, 0, null, 1, null),
      /CHECK constraint failed: playback_progress_state_started_check/,
    );
    // last_sample_seq < 0
    expectRejected(
      () => db.prepare(insert).run('hh-1', 'pbs-2', 'prof-main', 'media-ch-1', 1, 1, 1, 0, -1, null, 1, null),
      /CHECK constraint failed: playback_progress_state_last_sample_seq_check/,
    );
    // last_generation < 1
    expectRejected(
      () => db.prepare(insert).run('hh-1', 'pbs-2', 'prof-main', 'media-ch-1', 1, 1, 1, 0, 0, null, 0, null),
      /CHECK constraint failed: playback_progress_state_last_generation_check/,
    );
    // media 跨家庭 → 复合FK拒绝
    expectRejected(
      () => db.prepare(insert).run('hh-1', 'pbs-2', 'prof-main', 'media-ch-2', 1, 1, 1, 0, 0, null, 1, null),
      /FOREIGN KEY constraint failed/,
    );
    // playback_session 跨家庭 → 复合FK拒绝
    expectRejected(
      () => db.prepare(insert).run('hh-2', 'pbs-1', 'prof-main', 'media-ch-1', 1, 1, 1, 0, 0, null, 1, null),
      /FOREIGN KEY constraint failed/,
    );
  });

  it('profile_viewing_history:主键/FK/CHECK(writer_epoch、位置/时长/修订)', () => {
    const db = Database.db;
    seedSecondMain();
    const insert =
      'INSERT INTO profile_viewing_history (household_id, profile_id, media_id, writer_epoch, writer_playback_session_id, last_sample_seq, content_revision, position_seconds, duration_seconds, last_viewed_at, revision) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)';
    const valid = ['hh-1', 'prof-main', 'media-ch-1', 1, 'pbs-1', 3, 1, 12.5, 100, T0, 1];
    expect(() => db.prepare(insert).run(...valid)).not.toThrow();
    expectRejected(() => db.prepare(insert).run(...valid), /UNIQUE constraint failed/);
    // writer_epoch < 1
    expectRejected(
      () => db.prepare(insert).run('hh-1', 'prof-main', 'media-ch-2', 0, 'pbs-x', 0, 1, 0, null, T0, 1),
      /CHECK constraint failed: profile_viewing_history_writer_epoch_check/,
    );
    // position < 0
    expectRejected(
      () => db.prepare(insert).run('hh-1', 'prof-main', 'media-ch-2', 1, 'pbs-x', 0, 1, -0.5, null, T0, 1),
      /CHECK constraint failed: profile_viewing_history_position_check/,
    );
    // duration < 0
    expectRejected(
      () => db.prepare(insert).run('hh-1', 'prof-main', 'media-ch-2', 1, 'pbs-x', 0, 1, 0, -1, T0, 1),
      /CHECK constraint failed: profile_viewing_history_duration_check/,
    );
    // 位置超过可信时长
    expectRejected(
      () => db.prepare(insert).run('hh-1', 'prof-main', 'media-ch-2', 1, 'pbs-x', 0, 1, 101, 100, T0, 1),
      /CHECK constraint failed: profile_viewing_history_position_duration_check/,
    );
    // revision < 1
    expectRejected(
      () => db.prepare(insert).run('hh-1', 'prof-main', 'media-ch-2', 1, 'pbs-x', 0, 1, 0, null, T0, 0),
      /CHECK constraint failed: profile_viewing_history_revision_check/,
    );
    // profile 跨家庭 → 复合FK拒绝
    expectRejected(
      () => db.prepare(insert).run('hh-1', 'prof-main-h2', 'media-ch-1', 1, 'pbs-x', 0, 1, 0, null, T0, 1),
      /FOREIGN KEY constraint failed/,
    );
    // writer_playback_session_id 不设 FK(不透明 ID,避免审计清理影响历史)
    expect(() =>
      db.prepare(insert).run('hh-1', 'prof-child', 'media-ch-1', 1, 'gone-session', 0, 1, 0, null, T0, 1),
    ).not.toThrow();
  });

  it('source_entry.group_title:存储值域 CHECK(已 trim 1~100,空白/超长拒绝,NULL 合法)', () => {
    const db = Database.db;
    db.prepare(
      "INSERT INTO media_source (id, household_id, kind, name, remote_url, created_at, updated_at) VALUES ('src-1', 'hh-1', 'iptv', '直播源', 'http://example.invalid/list.m3u', ?, ?)",
    ).run(T0, T0);
    const insert =
      "INSERT INTO source_entry (id, household_id, source_id, identity_kind, identity_digest, group_title, first_seen_at, last_seen_at) VALUES (?, 'hh-1', 'src-1', 'url', ?, ?, ?, ?)";
    const digest = (n: number) => String(n).repeat(64).replace(/9/g, 'a');
    // NULL 合法
    expect(() =>
      db.prepare(insert).run('se-1', digest(1), null, T0, T0),
    ).not.toThrow();
    // 合法分组(内部空格允许,两端必须已 trim)
    expect(() =>
      db.prepare(insert).run('se-2', digest(2), '央视 央视', T0, T0),
    ).not.toThrow();
    // 未 trim(带首尾空白)拒绝
    expectRejected(
      () => db.prepare(insert).run('se-3', digest(3), '  央视  ', T0, T0),
      /CHECK constraint failed: source_entry_group_title_check/,
    );
    // 纯空白拒绝
    expectRejected(
      () => db.prepare(insert).run('se-4', digest(4), '   ', T0, T0),
      /CHECK constraint failed: source_entry_group_title_check/,
    );
    // 超长(101)拒绝
    expectRejected(
      () => db.prepare(insert).run('se-5', digest(5), '组'.repeat(101), T0, T0),
      /CHECK constraint failed: source_entry_group_title_check/,
    );
    // 100 字符合法
    expect(() =>
      db.prepare(insert).run('se-6', digest(6), '组'.repeat(100), T0, T0),
    ).not.toThrow();
  });

  it('device_session/playback_session.profile_context_version >= 1', () => {
    const db = Database.db;
    expectRejected(
      () =>
        db
          .prepare(
            "INSERT INTO device_session (id, household_id, account_id, device_id, token_hash, expires_at, last_active_at, created_at, profile_context_version) VALUES ('sess-9', 'hh-1', 'acc-1', 'dev-1', 'tok-9', ?, ?, ?, 0)",
          )
          .run('2026-12-31T00:00:00.000Z', T0, T0),
      /CHECK constraint failed: device_session_profile_context_version_check/,
    );
    expectRejected(
      () =>
        db
          .prepare(
            "INSERT INTO playback_session (id, household_id, device_session_id, device_id, profile_id, media_id, state, generation, version, position_seconds, created_at, last_heartbeat_at, profile_context_version) VALUES ('pbs-9', 'hh-1', 'sess-1', 'dev-1', 'prof-main', 'media-ch-1', 'preparing', 1, 1, 0, ?, ?, 0)",
          )
          .run(T0, T0),
      /CHECK constraint failed: playback_session_profile_context_version_check/,
    );
  });
});

describe('0006_pc_experience · 空库 up/down/up 与 user_version(T008 drill)', () => {
  it('up → down → up:user_version 2→1→2;down 移除全部 0006 对象且保留 0001~0005', () => {
    const rig = newRig('hmp-0006-cycle-');
    applyEnv(rig);
    runMigrationCommand('up');
    expect(userVersion()).toBe(2);

    runMigrationCommand('down');
    expect(userVersion()).toBe(1); // down 后与旧代际一致(0006 down 恢复 1)
    const tables = tableNames();
    for (const table of [
      'settings_access_grant',
      'profile_channel_favorite',
      'profile_progress_clock',
      'playback_progress_state',
      'profile_viewing_history',
    ]) {
      expect(tables).not.toContain(table);
    }
    expect(tableNames()).toEqual(expect.arrayContaining(['household', 'playback_session']));
    expect(indexNames()).not.toContain('one_main_profile');
    expect(columnsOf('household').map((c) => c.name)).not.toContain('version');
    expect(columnsOf('profile').map((c) => c.name)).not.toContain('is_main');
    expect(columnsOf('source_entry').map((c) => c.name)).not.toContain('group_title');
    const applied = (
      Database.db.prepare('SELECT name FROM _migrations ORDER BY name').all() as { name: string }[]
    ).map((row) => row.name);
    expect(applied).toEqual(LEGACY_MIGRATIONS);

    runMigrationCommand('up');
    expect(userVersion()).toBe(2);
    expect(tableNames()).toContain('settings_access_grant');
    expect(
      (Database.db.prepare('SELECT name FROM _migrations ORDER BY name').all() as { name: string }[])
        .map((row) => row.name),
    ).toEqual(ALL_MIGRATIONS);
  });

  it('drill 命令一次通过且终态 user_version=2', () => {
    const rig = newRig('hmp-0006-drill-');
    applyEnv(rig);
    runMigrationCommand('drill');
    expect(userVersion()).toBe(2);
  });
});

describe('0006_pc_experience · 旧库只读预检与拒绝(T007)', () => {
  it('旧已初始化库(0001~0005+数据):up/down 拒绝 STORAGE_GENERATION_UNSUPPORTED 且文件字节不变', () => {
    const rig = buildLegacyRig();
    Database.close();

    const hashBefore = sha256(rig.dbFile);
    const dirBefore = fs.readdirSync(rig.dataDir).sort();
    expect(dirBefore).toEqual([rig.dbFilename]); // 干净关闭后无 -wal/-shm

    // 只读预检判定
    const verdict = precheckDatabaseFile(rig.dbFile);
    expect(verdict.kind).toBe('reject');
    expect(verdict.code).toBe('STORAGE_GENERATION_UNSUPPORTED');

    // 迁移入口拒绝(先于任何写连接/备份/_migrations 创建)
    let gateError: unknown = null;
    try {
      runMigrationCommand('up');
    } catch (err) {
      gateError = err;
    }
    expect(gateError).toBeInstanceOf(MigrationGateError);
    expect((gateError as MigrationGateError).code).toBe('STORAGE_GENERATION_UNSUPPORTED');
    expect(() => runMigrationCommand('down')).toThrowError(MigrationGateError);

    // 文件字节不变;目录除 SQLite 只读检查的空 WAL 副产物(-shm/-wal,-wal 恒 0 字节,
    // 见 precheck.ts 副产物说明)外无任何新文件 —— 尤其不允许 .bak 备份
    expect(sha256(rig.dbFile)).toBe(hashBefore);
    const allowed = new Set([rig.dbFilename, `${rig.dbFilename}-shm`, `${rig.dbFilename}-wal`]);
    const extra = fs.readdirSync(rig.dataDir).filter((name) => !allowed.has(name));
    expect(extra).toEqual([]);
    const walPath = `${rig.dbFile}-wal`;
    if (fs.existsSync(walPath)) {
      expect(fs.statSync(walPath).size).toBe(0);
    }

    // 只读复核:旧库原样(user_version 仍为 0,数据仍在)
    const ro = new DatabaseConstructor(rig.dbFile, { readonly: true, fileMustExist: true });
    expect(ro.pragma('user_version', { simple: true })).toBe(0);
    expect(ro.prepare('SELECT COUNT(*) AS c FROM household').get()).toEqual({ c: 1 });
    expect(ro.prepare('SELECT COUNT(*) AS c FROM _migrations').get()).toEqual({
      c: LEGACY_MIGRATIONS.length,
    });
    ro.close();
  });

  it('服务启动门禁:旧库拒绝、回滚后状态拒绝、空库放行、代际 2 放行(原因可判读)', () => {
    // 旧库 → 拒绝
    const legacy = buildLegacyRig();
    Database.close();
    applyEnv(legacy);
    const legacyGate = precheckForStartup();
    expect(legacyGate.allowed).toBe(false);
    expect(legacyGate.code).toBe('STORAGE_GENERATION_UNSUPPORTED');
    expect(legacyGate.reason.length).toBeGreaterThan(0);

    // 0006 down 后(user_version=1,恰 0001~0005)→ 启动拒绝但可重新 up
    applyEnv(legacy);
    expect(() => runMigrationCommand('up')).toThrowError(MigrationGateError);
    Database.close();

    const fresh = newRig('hmp-0006-gate-');
    applyEnv(fresh);
    expect(precheckForStartup().allowed).toBe(true); // 全新空库:放行启动,readiness 503 直至迁移
    runMigrationCommand('up');
    expect(precheckForStartup().allowed).toBe(true); // 代际 2 就绪
    Database.close();
  });

  it('损坏文件:拒绝 STORAGE_CORRUPT 且字节不变', () => {
    const rig = newRig('hmp-0006-corrupt-');
    applyEnv(rig);
    fs.writeFileSync(rig.dbFile, Buffer.alloc(4096, 7));
    const hashBefore = sha256(rig.dbFile);

    const verdict = precheckDatabaseFile(rig.dbFile);
    expect(verdict.kind).toBe('reject');
    expect(verdict.code).toBe('STORAGE_CORRUPT');
    expect(() => runMigrationCommand('up')).toThrowError(MigrationGateError);
    expect(sha256(rig.dbFile)).toBe(hashBefore);
  });

  it('代际 2 库但迁移记录缺失:拒绝 STORAGE_STATE_UNKNOWN', () => {
    const rig = buildGeneration2Rig();
    Database.db.prepare("DELETE FROM _migrations WHERE name = '0006_pc_experience'").run();
    Database.close();
    const verdict = precheckDatabaseFile(rig.dbFile);
    expect(verdict.kind).toBe('reject');
    expect(verdict.code).toBe('STORAGE_STATE_UNKNOWN');
    // 与启动入口同一路径(env.DATA_DIR/DB_FILENAME)的判定一致
    applyEnv(rig);
    const gate = precheckForStartup();
    expect(gate.allowed).toBe(false);
    expect(gate.code).toBe('STORAGE_STATE_UNKNOWN');
  });

  it('就绪门禁:完整 up 后 isReady=true;down 恢复 user_version=1 后 isReady=false', () => {
    const rig = newRig('hmp-0006-ready-');
    applyEnv(rig);
    runMigrationCommand('up');
    expect(userVersion()).toBe(2);
    expect(Database.isReady()).toBe(true);
    runMigrationCommand('down');
    expect(userVersion()).toBe(1);
    expect(Database.isReady()).toBe(false);
  });
});
