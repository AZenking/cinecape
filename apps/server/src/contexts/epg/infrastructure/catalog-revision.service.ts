import type DatabaseConstructor from 'better-sqlite3';
import { Database } from '@platform/database/database';

/**
 * 家庭目录修订(T114;005 data-model.md §8):
 *
 * 「EPG 发布/绑定修改同事务递增家庭 catalog revision,读取将 revision 与 now、
 *   timezone 一起返回」—— 本文件是 revision 读取与递增的唯一实现(纯函数模块,
 *   对齐 epg/catalog 惯例;数据访问经 Database 共享 SQLite 单例):
 *
 * - 读取:`readCatalogRevision` 单查询返回 catalog_state.revision,行缺失按
 *   「创建后应为 1」语义取 1。US6 起 live 控制器 T063 阶段的最小读取点平移至此
 *   (contexts/live-tv/interface/live.controller.ts 仅改为调用本函数),guide 响应同源读取,
 *   不存在第二套读取实现。
 * - 递增:`incrementCatalogRevision` 为唯一写入实现,行缺失按「创建后应为 2」补建
 *   (CHECK ≥1),必须在调用方事务内执行。消费方:manual-epg-binding.service
 *   (绑定保存/解除,T071)经本函数递增;imports 的 refresh-publish.service
 *   (EPG 窗口发布,T026)在发布事务内以同语义 SQL 递增(imports 模块非本任务
 *   边界,不改动;契约一致性由 public-guide 契约测试核对)。
 * - 同步快照:better-sqlite3 同步驱动,调用方在单请求内冻结 nowMs 后读取,
 *   响应内 now/timezone/revision 同源;不要求不同 HTTP 请求的 now 相等。
 */

/** 事务内句柄(与 manual-epg-binding.service 同一形态;better-sqlite3 事务回调不注入句柄) */
type DbHandle = DatabaseConstructor.Database;

/** 读家庭目录修订(单查询;行缺失=1)。 */
export function readCatalogRevision(householdId: string): number {
  const catalog = Database.db.prepare('SELECT revision FROM catalog_state WHERE household_id = ?').get(householdId) as
    | { revision: number }
    | undefined;
  return catalog?.revision ?? 1;
}

/**
 * 同事务递增家庭目录修订(唯一写入实现):
 * 行缺失按「创建后应为 2」补建;调用方保证处于自己的写事务内。
 */
export function incrementCatalogRevision(db: DbHandle, householdId: string): void {
  db.prepare(
    `INSERT INTO catalog_state (household_id, revision) VALUES (?, 2)
     ON CONFLICT(household_id) DO UPDATE SET revision = revision + 1`,
  ).run(householdId);
}
