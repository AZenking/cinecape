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
 * T003/T004(016-multi-source-live-epg):0010_multi_source_priority 迁移证据测试。
 *
 * 宪章原则一(证据先行):对 data-model §1.1 DDL 逐字验证 ——
 * ① 全新库 up 后 media_source 存在 priority 列(INTEGER NOT NULL DEFAULT 100);
 * ② 既有行(0001~0009 建好后插入、再补 0010)priority=100(DEFAULT 兜底向后兼容);
 * ③ 排序索引 idx_media_source_household_kind_prio 存在且定义逐字一致;
 * ④ 排序语义:同家庭同 kind 按 priority ASC(10 < 50 < 100),与插入顺序无关,
 *    且 household/kind 维度隔离;
 * ⑤ down 能力:up→down→up 循环(索引先于列删除;门禁重新 up 放行;user_version 保持 2);
 * ⑥ drill 全链通过(migrate.ts EXPECTED_COLUMNS 注册证据)+ isReady(database.ts
 *    REQUIRED_COLUMNS 注册证据)。
 *
 * 夹具:独立临时目录(migration-0006.spec.ts 先例;setEnvOverride + Database.close
 * 单例重置,不复用 test/helpers.ts),每用例独立 DATA_DIR/DB 文件。
 */

/** 与生产 migrate.ts 同目录权威:全部迁移(含 0010)清单 */
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

/** 0010 前的既有清单(旧库升级路径:0001~0009 已应用、0010 待补) */
const PRE_0010_MIGRATIONS = ALL_MIGRATIONS.filter(
  (name) =>
    name !== '0010_multi_source_priority' &&
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

/** 与 migrate.ts 同语义应用单条 up.sql 并记录 _migrations(测试夹具内联实现) */
function applyMigrationUp(name: string): void {
  Database.db.exec(migrationSql(name, 'up.sql'));
  Database.db.prepare('INSERT INTO _migrations (name, applied_at) VALUES (?, ?)').run(name, T0);
}

/** 全新库:目录全量迁移(runMigrationCommand('up') 产物形态) */
function buildFreshRig(): Rig {
  const rig = newRig('hmp-0010-fresh-');
  applyEnv(rig);
  runMigrationCommand('up');
  return rig;
}

/** 0010 前旧库:0001~0009 全量应用(0010 待补),可再插入既有业务行 */
function buildPre0010Rig(): Rig {
  const rig = newRig('hmp-0010-legacy-');
  applyEnv(rig);
  Database.db.exec(
    'CREATE TABLE IF NOT EXISTS _migrations (name TEXT PRIMARY KEY NOT NULL, applied_at TEXT NOT NULL)',
  );
  for (const name of PRE_0010_MIGRATIONS) {
    applyMigrationUp(name);
  }
  return rig;
}

function appliedMigrations(): string[] {
  return (
    Database.db.prepare('SELECT name FROM _migrations ORDER BY name').all() as { name: string }[]
  ).map((row) => row.name);
}

function userVersion(): number {
  return Database.db.pragma('user_version', { simple: true }) as number;
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

function priorityColumn(): { name: string; notnull: number; dflt_value: unknown } | undefined {
  return columnsOf('media_source').find((column) => column.name === 'priority');
}

function priorityIndex(): { name: string; tbl_name: string; sql: string } | undefined {
  return Database.db
    .prepare(
      "SELECT name, tbl_name, sql FROM sqlite_master WHERE type = 'index' AND name = 'idx_media_source_household_kind_prio'",
    )
    .get() as { name: string; tbl_name: string; sql: string } | undefined;
}

/** 插入一条 media_source:列清单不携带 priority(0010 前旧 schema 合法;0010 后走 DDL DEFAULT 100 兜底) */
function insertMediaSource(
  id: string,
  householdId: string,
  kind: 'iptv' | 'epg',
): void {
  Database.db
    .prepare(
      "INSERT INTO media_source (id, household_id, kind, name, remote_url, created_at, updated_at) VALUES (?, ?, ?, ?, 'http://example.invalid/list.m3u', ?, ?)",
    )
    .run(id, householdId, kind, `源-${id}`, T0, T0);
}

/** 显式携带 priority 的插入(排序语义用;仅 0010 后合法) */
function insertMediaSourceWithPriority(
  id: string,
  householdId: string,
  kind: 'iptv' | 'epg',
  priority: number,
): void {
  Database.db
    .prepare(
      "INSERT INTO media_source (id, household_id, kind, name, remote_url, priority, created_at, updated_at) VALUES (?, ?, ?, ?, 'http://example.invalid/list.m3u', ?, ?, ?)",
    )
    .run(id, householdId, kind, `源-${id}`, priority, T0, T0);
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

describe('0010_multi_source_priority · 全新库 up(①列形态/③索引/⑥注册证据)', () => {
  it('全新空库 up:priority 列 NOT NULL DEFAULT 100、索引逐字落位、_migrations 齐全、isReady', () => {
    buildFreshRig();

    // ① 列形态:NOT NULL + DEFAULT 100(data-model §1.1 逐字)
    const column = priorityColumn();
    expect(column, 'media_source.priority 应存在').toBeDefined();
    expect(column?.notnull).toBe(1);
    expect(column?.dflt_value).toBe('100');

    // ③ 索引:存在、挂在 media_source、定义(列序/方向)与 DDL 一致
    const index = priorityIndex();
    expect(index, 'idx_media_source_household_kind_prio 应存在').toBeDefined();
    expect(index?.tbl_name).toBe('media_source');
    expect(index?.sql.replace(/\s+/g, ' ')).toContain(
      'ON media_source(household_id, kind, priority ASC)',
    );

    // ⑥ 注册证据:_migrations 与目录全量一致;database.ts REQUIRED_COLUMNS 注册后 isReady
    expect(appliedMigrations()).toEqual(ALL_MIGRATIONS);
    expect(userVersion()).toBe(2);
    expect(Database.isReady()).toBe(true);
  });
});

describe('0010_multi_source_priority · 既有行默认兜底(②)', () => {
  it('0001~0009 旧库已有行 → 补 0010 后 priority=100,且仅补应用 0010', () => {
    buildPre0010Rig();
    // 0010 之前的既有业务行(旧 schema,无 priority 列)
    Database.db.prepare('INSERT INTO household (id, name, created_at) VALUES (?, ?, ?)').run(
      'hh-old',
      '旧库家庭',
      T0,
    );
    insertMediaSource('src-old-iptv', 'hh-old', 'iptv');
    insertMediaSource('src-old-epg', 'hh-old', 'epg');
    expect(priorityColumn()).toBeUndefined(); // 前置:旧库确无该列

    runMigrationCommand('up'); // 门禁判定「未应用尾段」→ 补齐 0010~0013

    expect(appliedMigrations()).toEqual(ALL_MIGRATIONS);
    const column = priorityColumn();
    expect(column?.notnull).toBe(1);
    expect(column?.dflt_value).toBe('100');
    const rows = Database.db
      .prepare('SELECT id, priority FROM media_source ORDER BY id')
      .all() as { id: string; priority: number }[];
    expect(rows).toEqual([
      { id: 'src-old-epg', priority: 100 },
      { id: 'src-old-iptv', priority: 100 },
    ]);
  });
});

describe('0010_multi_source_priority · 排序语义(④)', () => {
  it('同家庭同 kind 按 priority ASC(与插入顺序无关);household/kind 维度隔离;新行缺省 100', () => {
    buildFreshRig();
    Database.db.prepare('INSERT INTO household (id, name, created_at) VALUES (?, ?, ?)').run(
      'hh-1',
      '一号家庭',
      T0,
    );
    Database.db.prepare('INSERT INTO household (id, name, created_at) VALUES (?, ?, ?)').run(
      'hh-2',
      '二号家庭',
      T0,
    );
    // 乱序插入:100 → 10 → 50(证明顺序来自 priority 而非插入序)
    insertMediaSourceWithPriority('src-p100', 'hh-1', 'epg', 100);
    insertMediaSourceWithPriority('src-p10', 'hh-1', 'epg', 10);
    insertMediaSourceWithPriority('src-p50', 'hh-1', 'epg', 50);
    // 隔离样本:同家庭 iptv(priority=5)与跨家庭 epg(缺省 → DEFAULT 100)
    insertMediaSourceWithPriority('src-iptv-p5', 'hh-1', 'iptv', 5);
    insertMediaSource('src-hh2', 'hh-2', 'epg');

    const epgHh1 = Database.db
      .prepare(
        "SELECT id, priority FROM media_source WHERE household_id = 'hh-1' AND kind = 'epg' ORDER BY priority ASC",
      )
      .all() as { id: string; priority: number }[];
    expect(epgHh1.map((row) => row.id)).toEqual(['src-p10', 'src-p50', 'src-p100']);

    // iptv 不混入 epg 查询(线路权重独立演进)
    const iptvHh1 = Database.db
      .prepare(
        "SELECT id FROM media_source WHERE household_id = 'hh-1' AND kind = 'iptv' ORDER BY priority ASC",
      )
      .all() as { id: string }[];
    expect(iptvHh1.map((row) => row.id)).toEqual(['src-iptv-p5']);

    // 跨家庭隔离 + 缺省行 DEFAULT 100
    const hh2 = Database.db
      .prepare("SELECT id, priority FROM media_source WHERE household_id = 'hh-2' AND kind = 'epg'")
      .all() as { id: string; priority: number }[];
    expect(hh2).toEqual([{ id: 'src-hh2', priority: 100 }]);
  });
});

describe('0010_multi_source_priority · down/up 循环与 drill(⑤/⑥)', () => {
  it('up→down→up:down 删索引与列(其余对象不动,uv 保持 2),再 up 全量恢复且默认 100', () => {
    buildFreshRig();

    // 0013/0012/0011/0010 依次回滚,直到 0010 从栈顶移除
    runMigrationCommand('down');
    runMigrationCommand('down');
    runMigrationCommand('down');
    runMigrationCommand('down');
    expect(userVersion()).toBe(2);
    expect(columnsOf('media_source').map((column) => column.name)).not.toContain('priority');
    expect(priorityIndex()).toBeUndefined();
    expect(appliedMigrations()).toEqual(PRE_0010_MIGRATIONS);
    // down 不触碰同代表内其他列/相邻迁移对象
    expect(columnsOf('media_source').map((column) => column.name)).toContain('locator_revision');
    expect(
      Database.db
        .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'channel_logo'")
        .get(),
    ).toBeTruthy();

    runMigrationCommand('up'); // 门禁「恰缺尾段 0010」重新放行
    expect(appliedMigrations()).toEqual(ALL_MIGRATIONS);
    const column = priorityColumn();
    expect(column?.dflt_value).toBe('100');
    expect(priorityIndex()).toBeDefined();
    // 回滚→重放后默认兜底依旧
    Database.db.prepare('INSERT INTO household (id, name, created_at) VALUES (?, ?, ?)').run(
      'hh-re',
      '重放家庭',
      T0,
    );
    insertMediaSource('src-re', 'hh-re', 'epg');
    const row = Database.db
      .prepare('SELECT priority FROM media_source WHERE id = ?')
      .get('src-re') as { priority: number };
    expect(row.priority).toBe(100);
  });

  it('drill(up→down→up)一次通过:EXPECTED_COLUMNS 注册证据,终态 _migrations 齐全', () => {
    const rig = newRig('hmp-0010-drill-');
    applyEnv(rig);
    runMigrationCommand('drill');
    expect(appliedMigrations()).toEqual(ALL_MIGRATIONS);
    expect(priorityColumn()?.dflt_value).toBe('100');
    expect(priorityIndex()).toBeDefined();
  });
});
