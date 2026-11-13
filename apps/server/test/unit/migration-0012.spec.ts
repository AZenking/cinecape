import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { Database } from '@platform/database/database';
import { loadEnv } from '@platform/config/env.schema';
import { setEnvOverride } from '@platform/config/env';
import { runMigrationCommand } from '@platform/database/migrate';

/**
 * 020 T003: 0012_programme_posters 迁移证据测试。
 * ① 全新库 up 后 programme_poster 表、epg_programme 两列、索引存在；
 * ② 既有 epg_programme 行升级后保留，新列默认 NULL；
 * ③ programme_poster 关键 CHECK（matched 字段齐备、ref 形态）生效；
 * ④ down 回滚删除表/列/索引，既有 epg_programme 行保留；
 * ⑤ up→down→up 循环正常；
 * ⑥ migrate.ts EXPECTED_* 与 database.ts REQUIRED_COLUMNS 注册一致（通过 drill/readiness 覆盖）。
 */

const ALL_MIGRATIONS = [
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
  '0011_channel_visibility',
  '0012_programme_posters',
  '0013_source_governance',
];

const PRE_0012_MIGRATIONS = ALL_MIGRATIONS.filter((name) => name !== '0012_programme_posters' && name !== '0013_source_governance');
const T0 = '2026-11-13T00:00:00.000Z';

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
  return fs.readFileSync(
    path.join(process.cwd(), 'src/platform/database/migrations', name, file),
    'utf8',
  );
}

function applyMigrationUp(name: string): void {
  Database.db.exec(migrationSql(name, 'up.sql'));
  Database.db.prepare('INSERT INTO _migrations (name, applied_at) VALUES (?, ?)').run(name, T0);
}

function buildFreshRig(): Rig {
  const rig = newRig('hmp-0012-fresh-');
  applyEnv(rig);
  runMigrationCommand('up');
  return rig;
}

function buildPre0012Rig(): Rig {
  const rig = newRig('hmp-0012-legacy-');
  applyEnv(rig);
  Database.db.exec(
    'CREATE TABLE IF NOT EXISTS _migrations (name TEXT PRIMARY KEY NOT NULL, applied_at TEXT NOT NULL)',
  );
  for (const name of PRE_0012_MIGRATIONS) {
    applyMigrationUp(name);
  }
  return rig;
}

function appliedMigrations(): string[] {
  return (
    Database.db.prepare('SELECT name FROM _migrations ORDER BY name').all() as { name: string }[]
  ).map((row) => row.name);
}

function columnsOf(table: string): { name: string; notnull: number }[] {
  return (Database.db.pragma(`table_info(${table})`) as { name: string; notnull: number }[]).map(
    (row) => ({ name: row.name, notnull: row.notnull }),
  );
}

function hasColumn(table: string, column: string): boolean {
  return columnsOf(table).some((row) => row.name === column);
}

function tableExists(table: string): boolean {
  return (
    Database.db
      .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?")
      .get(table) !== undefined
  );
}

function indexExists(index: string): boolean {
  return (
    Database.db
      .prepare("SELECT 1 FROM sqlite_master WHERE type = 'index' AND name = ?")
      .get(index) !== undefined
  );
}

function seedEpgRow(): void {
  Database.db.exec(`
    INSERT INTO household (id, name, default_language, timezone, created_at, version, main_profile_version)
    VALUES ('h1', '测试家庭', 'zh-CN', 'Asia/Shanghai', '${T0}', 1, 1);

    INSERT INTO media_source (
      id, household_id, kind, name, remote_url, private_access_approved, enabled, version, created_at, updated_at
    ) VALUES (
      's1', 'h1', 'epg', 'EPG 源', 'https://example.com/epg.xml', 1, 1, 1, '${T0}', '${T0}'
    );

    INSERT INTO epg_channel (household_id, source_id, xmltv_channel_id, display_name, conflicted)
    VALUES ('h1', 's1', 'ch1', 'CCTV-1', 0);

    INSERT INTO epg_programme (id, household_id, source_id, xmltv_channel_id, title, description, starts_at, ends_at)
    VALUES ('p1', 'h1', 's1', 'ch1', '流浪地球', NULL, '${T0}', '2026-11-13T02:00:00.000Z');
  `);
}

describe('0012_programme_posters 迁移与回滚验证', () => {
  beforeEach(() => {
    Database.close();
  });

  afterAll(() => {
    Database.close();
    setEnvOverride(null);
    for (const rig of rigs) {
      try {
        fs.rmSync(rig.dataDir, { recursive: true, force: true });
      } catch {
        // ignore
      }
    }
  });

  it('全新库 up: programme_poster 表、epg_programme 两列与索引存在', () => {
    buildFreshRig();

    expect(appliedMigrations()).toContain('0012_programme_posters');
    expect(tableExists('programme_poster')).toBe(true);
    expect(hasColumn('epg_programme', 'poster_match_key')).toBe(true);
    expect(hasColumn('epg_programme', 'poster_ref')).toBe(true);
    expect(indexExists('epg_programme_household_match_key_idx')).toBe(true);
    expect(indexExists('programme_poster_household_id_ref_key')).toBe(true);
    expect(indexExists('programme_poster_expiry_idx')).toBe(true);

    // 关键列存在
    for (const column of ['household_id', 'match_key', 'ref', 'state', 'poster_path', 'expires_at']) {
      expect(hasColumn('programme_poster', column)).toBe(true);
    }
  });

  it('旧库升级: 既有 epg_programme 行保留且新列为 NULL', () => {
    buildPre0012Rig();
    seedEpgRow();

    runMigrationCommand('up');

    expect(appliedMigrations()).toContain('0012_programme_posters');
    const row = Database.db
      .prepare('SELECT title, poster_match_key, poster_ref FROM epg_programme WHERE id = ?')
      .get('p1') as { title: string; poster_match_key: string | null; poster_ref: string | null };
    expect(row.title).toBe('流浪地球');
    expect(row.poster_match_key).toBeNull();
    expect(row.poster_ref).toBeNull();
  });

  it('programme_poster CHECK: matched 必须字段齐备、ref 必须 32 位小写 hex', () => {
    buildFreshRig();
    Database.db.exec(`
      INSERT INTO household (id, name, default_language, timezone, created_at, version, main_profile_version)
      VALUES ('h1', '测试家庭', 'zh-CN', 'Asia/Shanghai', '${T0}', 1, 1);
    `);

    expect(() =>
      Database.db
        .prepare(
          `INSERT INTO programme_poster (household_id, match_key, state, expires_at, created_at, updated_at)
           VALUES ('h1', '流浪地球', 'matched', '${T0}', '${T0}', '${T0}')`,
        )
        .run(),
    ).toThrow();

    expect(() =>
      Database.db
        .prepare(
          `INSERT INTO programme_poster (
             household_id, match_key, ref, state, tmdb_id, media_type, poster_path, expires_at, created_at, updated_at
           ) VALUES ('h1', '流浪地球', 'XYZ', 'matched', 1, 'movie', '/a.jpg', '${T0}', '${T0}', '${T0}')`,
        )
        .run(),
    ).toThrow();

    Database.db
      .prepare(
        `INSERT INTO programme_poster (
           household_id, match_key, ref, state, tmdb_id, media_type, poster_path, expires_at, created_at, updated_at
         ) VALUES ('h1', '流浪地球', '0123456789abcdef0123456789abcdef', 'matched', 1, 'movie', '/a.jpg', '${T0}', '${T0}', '${T0}')`,
      )
      .run();

    const row = Database.db
      .prepare('SELECT state, media_type FROM programme_poster WHERE household_id = ? AND match_key = ?')
      .get('h1', '流浪地球') as { state: string; media_type: string };
    expect(row.state).toBe('matched');
    expect(row.media_type).toBe('movie');
  });

  it('回滚演练: up → down → up 循环正常且既有 epg_programme 数据保留', () => {
    buildFreshRig();
    seedEpgRow();

    // 0013 为 0012 之后的尾段:先回滚 0013,再回滚 0012
    runMigrationCommand('down');
    expect(appliedMigrations()).not.toContain('0013_source_governance');
    runMigrationCommand('down');
    expect(appliedMigrations()).not.toContain('0012_programme_posters');
    expect(tableExists('programme_poster')).toBe(false);
    expect(hasColumn('epg_programme', 'poster_match_key')).toBe(false);
    expect(hasColumn('epg_programme', 'poster_ref')).toBe(false);
    const stillThere = Database.db.prepare('SELECT title FROM epg_programme WHERE id = ?').get('p1') as
      | { title: string }
      | undefined;
    expect(stillThere?.title).toBe('流浪地球');

    runMigrationCommand('up');
    expect(appliedMigrations()).toContain('0012_programme_posters');
    expect(appliedMigrations()).toContain('0013_source_governance');
    expect(hasColumn('epg_programme', 'poster_match_key')).toBe(true);
    expect(hasColumn('epg_programme', 'poster_ref')).toBe(true);
  });
});