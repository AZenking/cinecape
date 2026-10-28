import type DatabaseConstructor from 'better-sqlite3';
import { drizzle, type BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { Database } from '@platform/database/database';
import * as schema from '@platform/database/schema';

/**
 * drizzle 查询句柄 —— 复用 Database SQLite 单例与 schema.ts 表定义,
 * 供 auth / household / profile 模块共享,不重复建立连接。
 * Database 单例被 close 后重开时(Database.db 返回新句柄),此处自动重建包装。
 */
export type Db = BetterSQLite3Database<typeof schema>;

let wrapper: { connection: DatabaseConstructor.Database; handle: Db } | null = null;

export function getDb(): Db {
  const connection = Database.db;
  if (wrapper === null || wrapper.connection !== connection) {
    wrapper = { connection, handle: drizzle(connection, { schema }) };
  }
  return wrapper.handle;
}
