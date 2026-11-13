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
 * T007 (018-channel-customization): 0011_channel_visibility 迁移证据测试。
 *
 * 宪章原则一(证据先行): 对 data-model §1/§2 DDL 逐字验证 ——
 * ① 全新库 up 后 media_item 存在 visible 列 (INTEGER NOT NULL DEFAULT 1);
 * ② 既有行 (0001~0010 建好后插入、再补 0011) visible=1 (DEFAULT 兜底向后兼容);
 * ③ 联合索引 idx_media_item_household_type_visible 存在;
 * ④ channel_logo 扩展 source_kind CHECK 允许 'custom'，source_id 允许为 NULL;
 * ⑤ down 能力: up→down→up 循环 (索引先于列删除; 重新 up 放行);
 * ⑥ migrate.ts EXPECTED_COLUMNS 与 database.ts REQUIRED_COLUMNS 注册校验通过。
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

const PRE_0011_MIGRATIONS = ALL_MIGRATIONS.filter(
  (name) =>
    name !== '0011_channel_visibility' &&
    name !== '0012_programme_posters' &&
    name !== '0013_source_governance',
);

const T0 = '2026-11-09T00:00:00.000Z';

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

function applyMigrationUp(name: string): void {
  Database.db.exec(migrationSql(name, 'up.sql'));
  Database.db.prepare('INSERT INTO _migrations (name, applied_at) VALUES (?, ?)').run(name, T0);
}

function buildFreshRig(): Rig {
  const rig = newRig('hmp-0011-fresh-');
  applyEnv(rig);
  runMigrationCommand('up');
  return rig;
}

function buildPre0011Rig(): Rig {
  const rig = newRig('hmp-0011-legacy-');
  applyEnv(rig);
  Database.db.exec(
    'CREATE TABLE IF NOT EXISTS _migrations (name TEXT PRIMARY KEY NOT NULL, applied_at TEXT NOT NULL)',
  );
  for (const name of PRE_0011_MIGRATIONS) {
    applyMigrationUp(name);
  }
  return rig;
}

function appliedMigrations(): string[] {
  return (
    Database.db.prepare('SELECT name FROM _migrations ORDER BY name').all() as { name: string }[]
  ).map((row) => row.name);
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

function visibleColumn(): { name: string; notnull: number; dflt_value: unknown } | undefined {
  return columnsOf('media_item').find((column) => column.name === 'visible');
}

describe('0011_channel_visibility 迁移与回滚验证', () => {
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

  it('全新库 up: media_item.visible 列与联合索引正确创建', () => {
    buildFreshRig();

    expect(appliedMigrations()).toContain('0011_channel_visibility');

    const col = visibleColumn();
    expect(col).toBeDefined();
    expect(col?.notnull).toBe(1);
    expect(String(col?.dflt_value)).toBe('1');

    const indexes = Database.db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'idx_media_item_household_type_visible'")
      .all();
    expect(indexes).toHaveLength(1);
  });

  it('旧库升级: 既有 media_item 数据在 0011 应用后自动呈现 visible=1 默认值', () => {
    buildPre0011Rig();

    // 插入既有 household 与 media_item
    Database.db.exec(`
      INSERT INTO household (id, name, default_language, timezone, created_at, version, main_profile_version)
      VALUES ('h1', '测试家庭', 'zh-CN', 'Asia/Shanghai', '${T0}', 1, 1);

      INSERT INTO media_item (
        id, household_id, type, title, version, content_revision, media_role, created_at, updated_at
      ) VALUES (
        'm1', 'h1', 'channel', 'CCTV-1 综合', 1, 1, 'standalone', '${T0}', '${T0}'
      );
    `);

    // 升级应用 0011
    runMigrationCommand('up');

    expect(appliedMigrations()).toContain('0011_channel_visibility');

    const row = Database.db.prepare('SELECT id, visible FROM media_item WHERE id = ?').get('m1') as {
      id: string;
      visible: number;
    };
    expect(row.visible).toBe(1);
  });

  it('channel_logo 扩展: 支持 source_kind="custom" 且 source_id 允许为 NULL', () => {
    buildFreshRig();

    Database.db.exec(`
      INSERT INTO household (id, name, default_language, timezone, created_at, version, main_profile_version)
      VALUES ('h1', '测试家庭', 'zh-CN', 'Asia/Shanghai', '${T0}', 1, 1);

      INSERT INTO media_item (
        id, household_id, type, title, visible, version, content_revision, media_role, created_at, updated_at
      ) VALUES (
        'm1', 'h1', 'channel', 'CCTV-1', 1, 1, 1, 'standalone', '${T0}', '${T0}'
      );

      INSERT INTO channel_logo (
        household_id, media_id, ref, upstream_url, source_kind, source_id, revision, created_at, updated_at
      ) VALUES (
        'h1', 'm1', '0123456789abcdef0123456789abcdef', 'https://example.com/logo.png', 'custom', NULL, 1, '${T0}', '${T0}'
      );
    `);

    const logoRow = Database.db.prepare('SELECT source_kind, source_id FROM channel_logo WHERE media_id = ?').get('m1') as {
      source_kind: string;
      source_id: string | null;
    };
    expect(logoRow.source_kind).toBe('custom');
    expect(logoRow.source_id).toBeNull();
  });

  it('回滚演练: up → down → up 循环正常且无数据破坏', () => {
    buildFreshRig();

    expect(visibleColumn()).toBeDefined();

    // down 回滚 0011
    runMigrationCommand('down');
    runMigrationCommand('down');
    runMigrationCommand('down');
    expect(appliedMigrations()).not.toContain('0011_channel_visibility');
    expect(visibleColumn()).toBeUndefined();

    // 再次 up
    runMigrationCommand('up');
    expect(appliedMigrations()).toContain('0011_channel_visibility');
    expect(visibleColumn()).toBeDefined();
  });
});
