import fs from 'node:fs';
import path from 'node:path';
import type DatabaseConstructor from 'better-sqlite3';
import { env } from '../config/env';
import { Database } from './database';

/**
 * 迁移执行器(T009):`tsx src/database/migrate.ts <up|down|drill>`
 *
 * - up:按目录名字典序应用所有未应用的迁移;
 * - down:逆序回滚最近一个已应用迁移;
 * - drill:up → down → up,结束必须全部已应用(SC-006 回滚演练);
 * - 每次 up/down 前,用 `VACUUM INTO` 生成一致性备份 `<db>.bak-<Date.now()>`
 *   (WAL 下 VACUUM INTO 产出已检查点的完整快照);
 * - 每条迁移与版本记录同事务提交;任何一步失败输出错误并以非零码退出。
 */

type DbHandle = DatabaseConstructor.Database;

interface MigrationFile {
  name: string;
  upPath: string;
  downPath: string;
}

/** drill 结束时必须全部存在的表(7 业务表 + 版本表) */
const EXPECTED_TABLES = ['household', 'account', 'profile', 'device', 'device_session', 'profile_policy', 'parent_verification_state', '_migrations'] as const;

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
  log(`drill 通过:已应用 [${all.map((migration) => migration.name).join(', ')}],表 [${EXPECTED_TABLES.join(', ')}] 全部存在`);
}

function main(): void {
  const command = process.argv[2];
  if (command !== 'up' && command !== 'down' && command !== 'drill') {
    console.error('用法: tsx src/database/migrate.ts <up|down|drill>');
    process.exitCode = 1;
    return;
  }

  const dbFile = resolveDbFile();
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
  } catch (err) {
    console.error(`[migrate] ${command} 失败:`, err);
    process.exitCode = 1;
  } finally {
    Database.close();
  }
}

main();
