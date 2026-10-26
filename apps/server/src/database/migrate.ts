import fs from 'node:fs';
import path from 'node:path';
import type DatabaseConstructor from 'better-sqlite3';
import { env } from '../config/env';
import { Database } from './database';
import {
  MigrationGateError,
  evaluateMigrationGate,
  precheckDatabaseFile,
} from './precheck';

/**
 * 迁移执行器(T009):`tsx src/database/migrate.ts <up|down|drill>`
 *
 * - up:按目录名字典序应用所有未应用的迁移;
 * - down:逆序回滚最近一个已应用迁移;
 * - drill:up → down → up,结束必须全部已应用(SC-006 回滚演练);
 * - 每次 up/down 前,用 `VACUUM INTO` 生成一致性备份 `<db>.bak-<Date.now()>`
 *   (WAL 下 VACUUM INTO 产出已检查点的完整快照);
 * - 每条迁移与版本记录同事务提交;任何一步失败输出错误并以非零码退出。
 * - T007:任何命令在打开写连接之前先以只读方式预检旧库(precheck.ts),
 *   旧已初始化库/损坏/未知状态拒绝且不修改旧文件(不备份、不建 _migrations)。
 */

type DbHandle = DatabaseConstructor.Database;

interface MigrationFile {
  name: string;
  upPath: string;
  downPath: string;
}

/**
 * drill 结束时必须全部存在的表(阶段 1/2/3 业务表 + 0004/0005 增补表 + 版本表;
 * 阶段 3 对照 003 data-model.md,0005 对照 004 data-model.md 四节,
 * 0006 对照 005 data-model.md §3~§7 五张新表)
 */
const EXPECTED_TABLES = [
  'household',
  'account',
  'profile',
  'device',
  'device_session',
  'profile_policy',
  'parent_verification_state',
  'catalog_state',
  'media_source',
  'media_item',
  'source_entry',
  'playback_source',
  'epg_channel',
  'epg_programme',
  'source_refresh',
  'refresh_stage_entry',
  'manual_epg_binding',
  // 0005_playback(T009):受控播放四表
  'playback_session',
  'playback_ticket',
  'playback_conversion',
  'playback_failure_event',
  // 0006_pc_experience(T006,数据代际 2):个人观看体验五表
  'settings_access_grant',
  'profile_channel_favorite',
  'profile_progress_clock',
  'playback_progress_state',
  'profile_viewing_history',
  '_migrations',
] as const;

/**
 * drill 结束时必须存在的关键列(0004 起就绪语义含「必需列」;T009 增补 0005 四表,
 * T006 增补 0006 扩展列与新表):
 * 键为表名,值为必须存在的列。对照 database.ts 的 REQUIRED_COLUMNS 与 0004/0005/0006 up.sql。
 */
const EXPECTED_COLUMNS: Readonly<Record<string, readonly string[]>> = {
  // 0004_manual_epg_binding(ADR-0008)
  media_source: ['epg_generation'],
  manual_epg_binding: [
    'household_id',
    'media_id',
    'mode',
    'epg_source_id',
    'xmltv_channel_id',
    'version',
    'updated_at',
  ],
  // 0005_playback(T009):四表关键列,对照 docs/specs/004-playback-resolver/data-model.md 四节
  playback_session: [
    'desired_paused',
    'generation',
    'version',
    'position_seconds',
    'state',
    'delivery',
    // 0006_pc_experience(T006):身份上下文版本
    'profile_context_version',
  ],
  playback_ticket: ['token_hash', 'expires_at'],
  playback_conversion: ['mode', 'state', 'cleanup_state', 'bytes_on_disk'],
  playback_failure_event: ['stable_code', 'occurred_at'],
  // 0006_pc_experience(T006,数据代际 2):既有实体扩展列(对照 005 data-model §2)
  household: ['version', 'main_profile_version'],
  account: ['credential_version'],
  profile: ['is_main', 'pin_version', 'version'],
  media_item: ['content_revision'],
  source_entry: ['group_title'],
  // 0006_pc_experience(T006):五张新表关键列(对照 005 data-model §3~§7)
  settings_access_grant: [
    'household_id',
    'device_session_id',
    'profile_id',
    'profile_context_version',
    'pin_version',
    'main_profile_version',
    'issued_at',
    'expires_at',
    'revoked_at',
  ],
  profile_channel_favorite: ['household_id', 'profile_id', 'media_id', 'created_at'],
  profile_progress_clock: ['household_id', 'profile_id', 'next_epoch'],
  playback_progress_state: [
    'household_id',
    'playback_session_id',
    'profile_id',
    'media_id',
    'candidate_epoch',
    'content_revision',
    'profile_context_version',
    'started',
    'last_sample_seq',
    'last_generation',
  ],
  profile_viewing_history: [
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
  ],
};

const MIGRATIONS_DIR = path.join(__dirname, 'migrations');

function log(message: string): void {
  console.log(`[migrate] ${message}`);
}

function discoverMigrations(): MigrationFile[] {
  const entries = fs
    .readdirSync(MIGRATIONS_DIR, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();

  const migrations = entries.map((name) => {
    const dir = path.join(MIGRATIONS_DIR, name);
    const upPath = path.join(dir, 'up.sql');
    const downPath = path.join(dir, 'down.sql');
    if (!fs.existsSync(upPath) || !fs.existsSync(downPath)) {
      throw new Error(`迁移 ${name} 缺少 up.sql / down.sql 配对文件`);
    }
    return { name, upPath, downPath };
  });

  if (migrations.length === 0) {
    throw new Error(`未在 ${MIGRATIONS_DIR} 发现任何迁移目录`);
  }
  return migrations;
}

/** 与 database.ts 同规则解析数据库文件路径(env.DATA_DIR / env.DB_FILENAME) */
function resolveDbFile(): string {
  const dir = path.resolve(env.DATA_DIR);
  fs.mkdirSync(dir, { recursive: true });
  return path.join(dir, env.DB_FILENAME);
}

/** VACUUM INTO 目标必须不存在;时间戳撞名时追加序号 */
function createBackup(db: DbHandle, dbFile: string): string {
  const stamp = Date.now();
  let target = `${dbFile}.bak-${stamp}`;
  let attempt = 1;
  while (fs.existsSync(target)) {
    target = `${dbFile}.bak-${stamp}-${attempt}`;
    attempt += 1;
  }
  const escaped = target.replaceAll("'", "''");
  db.exec(`VACUUM INTO '${escaped}'`);
  return target;
}

function ensureMigrationsTable(db: DbHandle): void {
  db.exec('CREATE TABLE IF NOT EXISTS _migrations (name TEXT PRIMARY KEY NOT NULL, applied_at TEXT NOT NULL)');
}

function getApplied(db: DbHandle): Set<string> {
  const rows = db.prepare('SELECT name FROM _migrations').all() as { name: string }[];
  return new Set(rows.map((row) => row.name));
}

function applyUp(db: DbHandle, migration: MigrationFile): void {
  const insertApplied = db.prepare('INSERT INTO _migrations (name, applied_at) VALUES (?, ?)');
  const run = db.transaction(() => {
    db.exec(fs.readFileSync(migration.upPath, 'utf8'));
    insertApplied.run(migration.name, new Date().toISOString());
  });
  run();
  log(`已应用 ${migration.name}`);
}

function applyDown(db: DbHandle, migration: MigrationFile): void {
  const deleteApplied = db.prepare('DELETE FROM _migrations WHERE name = ?');
  const run = db.transaction(() => {
    db.exec(fs.readFileSync(migration.downPath, 'utf8'));
    deleteApplied.run(migration.name);
  });
  run();
  log(`已回滚 ${migration.name}`);
}

function cmdUp(db: DbHandle, dbFile: string): void {
  const backup = createBackup(db, dbFile);
  ensureMigrationsTable(db);
  const applied = getApplied(db);
  const pending = discoverMigrations().filter((migration) => !applied.has(migration.name));
  if (pending.length === 0) {
    log(`无待应用迁移(备份: ${path.basename(backup)})`);
    return;
  }
  for (const migration of pending) {
    applyUp(db, migration);
  }
  log(`完成:共 ${pending.length} 条(备份: ${path.basename(backup)})`);
}

function cmdDown(db: DbHandle, dbFile: string): void {
  const backup = createBackup(db, dbFile);
  ensureMigrationsTable(db);
  const applied = getApplied(db);
  const last = [...discoverMigrations()].reverse().find((migration) => applied.has(migration.name));
  if (last === undefined) {
    log(`无已应用迁移,无需回滚(备份: ${path.basename(backup)})`);
    return;
  }
  applyDown(db, last);
  log(`完成(备份: ${path.basename(backup)})`);
}

function currentTables(db: DbHandle): string[] {
  const rows = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")
    .all() as { name: string }[];
  return rows.map((row) => row.name);
}

function cmdDrill(db: DbHandle, dbFile: string): void {
  log('drill 阶段 1/3:up');
  cmdUp(db, dbFile);
  log('drill 阶段 2/3:down');
  cmdDown(db, dbFile);
  log('drill 阶段 3/3:up');
  cmdUp(db, dbFile);

  // 终态校验:全部迁移已应用 + 全部表存在
  const all = discoverMigrations();
  const applied = getApplied(db);
  const missingMigrations = all.filter((migration) => !applied.has(migration.name)).map((migration) => migration.name);
  if (missingMigrations.length > 0) {
    throw new Error(`drill 失败:迁移未全部已应用: ${missingMigrations.join(', ')}`);
  }
  const tables = new Set(currentTables(db));
  const missingTables = EXPECTED_TABLES.filter((table) => !tables.has(table));
  if (missingTables.length > 0) {
    throw new Error(`drill 失败:表缺失: ${missingTables.join(', ')}`);
  }
  for (const [table, columns] of Object.entries(EXPECTED_COLUMNS)) {
    const present = db.pragma(`table_info(${table})`) as { name: string }[];
    const missingColumns = columns.filter((column) => !present.some((row) => row.name === column));
    if (missingColumns.length > 0) {
      throw new Error(`drill 失败:${table} 缺列: ${missingColumns.join(', ')}`);
    }
  }
  log(`drill 通过:已应用 [${all.map((migration) => migration.name).join(', ')}],表 [${EXPECTED_TABLES.join(', ')}] 全部存在`);
}

/**
 * T007:命令入口门禁 —— 在任何写连接、WAL 设置或迁移元数据创建之前先只读预检;
 * 拒绝时抛 MigrationGateError(不备份、不建 _migrations、不触碰旧文件)。
 */
function gateCommand(command: 'up' | 'down' | 'drill', dbFile: string): void {
  const verdict = precheckDatabaseFile(dbFile);
  const decision = evaluateMigrationGate(verdict, command);
  if (!decision.allowed) {
    throw new MigrationGateError(
      decision.code ?? 'STORAGE_STATE_UNKNOWN',
      `[${command}] ${decision.reason}`,
    );
  }
  log(`预检通过(${verdict.kind}):${verdict.reason}`);
}

/**
 * 迁移命令执行(供 CLI 与测试调用):先只读预检,再打开写连接执行。
 * 失败抛错(MigrationGateError = 门禁拒绝;其余为 SQL/IO 错误),由调用方决定退出码。
 */
export function runMigrationCommand(command: 'up' | 'down' | 'drill'): void {
  const dbFile = resolveDbFile();
  gateCommand(command, dbFile);
  const db = Database.db;
  log(`命令=${command} 数据库=${dbFile}`);
  try {
    switch (command) {
      case 'up':
        cmdUp(db, dbFile);
        break;
      case 'down':
        cmdDown(db, dbFile);
        break;
      case 'drill':
        cmdDrill(db, dbFile);
        break;
    }
  } finally {
    Database.close();
  }
}

function main(): void {
  const command = process.argv[2];
  if (command !== 'up' && command !== 'down' && command !== 'drill') {
    console.error('用法: tsx src/database/migrate.ts <up|down|drill>');
    process.exitCode = 1;
    return;
  }
  try {
    runMigrationCommand(command);
  } catch (err) {
    console.error(`[migrate] ${command} 失败:`, err);
    process.exitCode = 1;
  }
}

// CLI 入口:仅直接执行本文件时运行(tsx src/database/migrate.ts <cmd>);
// 测试进程 import 本模块时不触发(不得以 vitest 的 argv 误跑迁移)。
if (typeof require !== 'undefined' && typeof require.main !== 'undefined' && require.main === module) {
  main();
}
