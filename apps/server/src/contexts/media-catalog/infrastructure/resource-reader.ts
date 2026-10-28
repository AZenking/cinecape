import { and, eq, inArray, sql } from 'drizzle-orm';
import { mediaItem } from '@platform/database/schema';
import type { Db } from '@contexts/identity-access';

/**
 * 真实资源读取器(T034;data-model.md「media_item 可用性」节):
 * 家庭可用 = 存在 present=1 的来源条目,且该条目所属来源启用,且该条目有对应播放资源记录;
 * 某一来源失效(停用/缺条目/无资源)不屏蔽其他有效来源(EXISTS 语义)。
 * 只按调用方提供的家庭标识查询;跨家庭/不存在一律视为不可用,不泄露存在性。
 * 全部为同步读取(better-sqlite3),供详情授权与批量上下文(policy.batch-context)复用。
 */

export interface AvailabilityQuery {
  householdId: string;
  /** 缺省 = 家庭全部媒体;提供时仅评估给定集合(空集合直接返回空表) */
  mediaIds?: string[];
}

/**
 * 相关 EXISTS 子查询:一条「present 条目 + enabled 来源 + playback 记录」链即可用。
 * 外层表以限定名 media_item.* 关联(drizzle 在 select 字段的 sql 模板中渲染列不带表前缀,
 * 故此处用字面限定文本,避免与子查询别名 se/ms 的 household_id 歧义)。
 */
const AVAILABLE_EXISTS = sql<number>`EXISTS (
  SELECT 1
  FROM source_entry se
  INNER JOIN media_source ms ON ms.household_id = se.household_id AND ms.id = se.source_id AND ms.enabled = 1
  INNER JOIN playback_source ps ON ps.household_id = se.household_id AND ps.source_entry_id = se.id AND ps.media_item_id = se.media_id
  WHERE se.household_id = media_item.household_id
    AND se.media_id = media_item.id
    AND se.present = 1
)`;

/** 批量读取家庭可用性事实:mediaId → 是否可用(单条查询,无逐条 N+1) */
export function loadMediaAvailabilityFacts(db: Db, query: AvailabilityQuery): Map<string, boolean> {
  if (query.mediaIds !== undefined && query.mediaIds.length === 0) {
    return new Map();
  }
  const conditions = [eq(mediaItem.householdId, query.householdId)];
  if (query.mediaIds !== undefined) {
    conditions.push(inArray(mediaItem.id, query.mediaIds));
  }
  const rows = db
    .select({ id: mediaItem.id, available: AVAILABLE_EXISTS })
    .from(mediaItem)
    .where(and(...conditions))
    .all();
  return new Map(rows.map((row) => [row.id, row.available === 1]));
}

/** 单条可用性:媒体不存在/跨家庭/无有效链 → false(与不存在统一不可区分) */
export function isMediaAvailable(db: Db, query: { householdId: string; mediaId: string }): boolean {
  const row = db
    .select({ available: AVAILABLE_EXISTS })
    .from(mediaItem)
    .where(and(eq(mediaItem.householdId, query.householdId), eq(mediaItem.id, query.mediaId)))
    .get();
  return row !== undefined && row.available === 1;
}
