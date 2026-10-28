import type DatabaseConstructor from 'better-sqlite3';
import { drizzle, type BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { Database } from '@platform/database/database';
import * as schema from '@platform/database/schema';

/**
 * drizzle 查询句柄（平台横切，008-repository-extraction 自 identity-access/infrastructure/db.ts
 * 原样上提——ADR-0015 D1 实施修正：句柄随 Database 单例归属 platform/database，
 * 各上下文 infrastructure 直接消费（R1c platform 合法），不经任何发布面）。
 *
 * - 复用 Database SQLite 单例与 schema.ts 表定义，不重复建立连接;
 * - Database 单例被 close 后重开时(Database.db 返回新句柄),此处自动重建包装;
 * - identity-access/infrastructure/db.ts 现为对本模块的再导出(兼容既有深导入/发布面消费,
 *   008-T011 identity-access 抽取完成后随其应用层消费清零一并收口)。
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
