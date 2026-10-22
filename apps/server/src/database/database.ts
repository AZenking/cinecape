import fs from 'node:fs';
import path from 'node:path';
import DatabaseConstructor from 'better-sqlite3';
import { env } from '../config/env';

/**
 * SQLite 连接单例(WAL 模式,research D4)。
 * 全部领域查询经由此句柄;显式 household_id 边界由各查询自行携带(FR-006)。
 */
export class Database {
  private static instance: DatabaseConstructor.Database | null = null;
  private static openError: unknown = null;

  static get db(): DatabaseConstructor.Database {
    if (Database.instance === null) {
      const dir = path.resolve(env.DATA_DIR);
      fs.mkdirSync(dir, { recursive: true });
      const file = path.join(dir, env.DB_FILENAME);
      const conn = new DatabaseConstructor(file);
      conn.pragma('journal_mode = WAL');
      conn.pragma('foreign_keys = ON');
      conn.pragma('busy_timeout = 5000');
      Database.instance = conn;
    }
    return Database.instance;
  }

  /** 可连接、迁移记录齐备且所有业务表存在才可接受身份请求。 */
  static isReady(): boolean {
    try {
      const conn = Database.db;
      const migrationsDir = path.join(__dirname, 'migrations');
      const expected = fs.readdirSync(migrationsDir, { withFileTypes: true })
        .filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort();
      const applied = conn.prepare('SELECT name FROM _migrations ORDER BY name').all() as { name: string }[];
      if (expected.length === 0 || JSON.stringify(applied.map((row) => row.name)) !== JSON.stringify(expected)) return false;
      for (const table of ['household', 'account', 'profile', 'device', 'device_session']) {
        if (!conn.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table)) return false;
      }
      Database.openError = null;
      return true;
    } catch (err) {
      Database.openError = err;
      return false;
    }
  }

  static lastError(): unknown {
    return Database.openError;
  }

  static close(): void {
    Database.instance?.close();
    Database.instance = null;
  }
}
