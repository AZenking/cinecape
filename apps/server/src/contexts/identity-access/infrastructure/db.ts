/**
 * drizzle 句柄再导出（兼容层）。
 *
 * 008-repository-extraction（ADR-0015 D1 实施修正）：实现原样上提至
 * @platform/database/drizzle（句柄随 Database 单例归属平台层，各上下文
 * infrastructure 直接消费，不经发布面）。本文件保留深导入与
 * identity-access 发布面的既有消费路径；008-T011 identity-access 应用层
 * 抽取完成后，随其应用层 getDb 消费清零评估收口（interface 层消费可直连 platform）。
 */
export { getDb } from '@platform/database/drizzle';
export type { Db } from '@platform/database/drizzle';
