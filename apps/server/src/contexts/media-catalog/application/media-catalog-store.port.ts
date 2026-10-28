/**
 * media-catalog 仓储端口（008-repository-extraction T010，ADR-0015 D1）。
 *
 * 应用层数据访问的唯一合法形态：本文件定义纯 TS 端口接口 + 模块级 seam 槽；
 * Drizzle 实现位于 infrastructure/media-catalog-store.drizzle.ts，由
 * media-catalog.module.ts 装配期绑定（useFactory），单元测试 rig 经
 * bindMediaCatalogStore 自行绑定。
 *
 * - 行类型经 `import type` 取自 @platform/database/schema（type-only 导入不产生
 *   依赖边，schema 保持单一事实源；depcruise 与 audit:purity 均放行）；
 * - 事务经 withTransaction 端口形态表达，事务句柄（tx）不越出 infrastructure；
 * - 方法签名与实现逐字对应既有查询（008 FR-002：SQL 构造与谓词逐字迁移）；
 * - public-catalog 的原生 prepare 查询（better-sqlite3）同样经本端口表达，
 *   实现侧逐字保留 Database.db.prepare 调用形态（infra→platform 合法边）。
 */
import type { deviceSession, mediaItem } from '@platform/database/schema';

export type MediaItemRow = typeof mediaItem.$inferSelect;
export type DeviceSessionRow = typeof deviceSession.$inferSelect;

/** 家庭候选媒体投影列（queryCandidates 装载形态，列集与迁移前一致） */
export interface HouseholdMediaRow {
  id: string;
  type: string;
  title: string;
  description: string | null;
  contentLevel: number | null;
  version: number;
}

/**
 * 公共目录白名单来源行（MEDIA_ROWS_SQL 投影列，逐字对应）：
 * 仅声明白名单投影输入列；available 不在 SQL 输出中，由应用层按可用集合补齐后
 * 交 domain/public-media-projection 投影（迁移前 `as PublicMediaRow[]` 的实际行形态）。
 */
export interface PublicMediaSourceRow {
  readonly id: string;
  readonly type: string;
  readonly title: string;
  readonly description: string | null;
  readonly posterRef: string | null;
  readonly contentLevel: number | null;
}

/** 可用性查询形态（infrastructure/resource-reader 的 AvailabilityQuery 逐字对应） */
export interface AvailabilityQuery {
  householdId: string;
  /** 缺省 = 家庭全部媒体；提供时仅评估给定集合（空集合直接返回空表） */
  mediaIds?: string[];
}

/** media_item 条件字段更新补丁（patchMediaMetadata 的 .set 形态；键集由应用层判定） */
export type MediaItemPatch = Record<string, string | number | null>;

/** 事务作用域内的目录表操作（patchMediaMetadata 的事务块形态） */
export interface MediaCatalogTxStore {
  findMediaItemRow(householdId: string, mediaId: string): MediaItemRow | undefined;
  /** 条件字段补丁更新（.set(patch)；patch 键集与迁移前各调用点一致） */
  updateMediaItemRow(householdId: string, mediaId: string, patch: MediaItemPatch): void;
  /** catalog_state.revision +1（行缺失按「创建后应为 2」语义补建；逐字迁移自 bumpCatalogRevision） */
  bumpCatalogRevision(householdId: string): void;
}

/** media-catalog 上下文仓储端口（读路径 + 事务入口） */
export interface MediaCatalogStore extends MediaCatalogTxStore {
  /** 家长验证通过后的会话行重读（requireParentVerification 的撤销/过期竞态不放行判定） */
  findDeviceSession(sessionId: string): DeviceSessionRow | undefined;
  /** 家庭候选全集（queryCandidates 装载列集；可用性由 loadMediaAvailabilityFacts 单独装载） */
  listHouseholdMediaRows(householdId: string): HouseholdMediaRow[];
  /** 批量可用性事实：mediaId → 是否可用（resource-reader 的 EXISTS 链逐字迁移） */
  loadMediaAvailabilityFacts(query: AvailabilityQuery): Map<string, boolean>;
  /** 目录修订单查（无行视为初版 1；catalog_state 行由发布/来源配置事务维护） */
  findCatalogRevision(householdId: string): { revision: number } | undefined;
  /** 家庭媒体白名单来源列全集（poster_ref 仅为白名单投影输入；不查播放/来源身份列） */
  listPublicMediaRows(householdId: string): PublicMediaSourceRow[];
  /** 单条白名单来源行（`${MEDIA_ROWS_SQL} AND id = ?` 逐字） */
  findPublicMediaRowById(householdId: string, mediaId: string): PublicMediaSourceRow | undefined;
  withTransaction<T>(fn: (tx: MediaCatalogTxStore) => T): T;
}

/**
 * seam 槽（ADR-0015 D1）：未绑定即调用为编程错误（显式失败，不静默空转）；
 * 重复绑定幂等覆盖（测试 rig 在 Database 单例重开后重建需要）。
 */
let boundStore: MediaCatalogStore | null = null;

export function bindMediaCatalogStore(store: MediaCatalogStore): void {
  boundStore = store;
}

export function mediaCatalogStore(): MediaCatalogStore {
  if (boundStore === null) {
    throw new Error(
      'MEDIA_CATALOG_STORE 未绑定：media-catalog 仓储端口需在模块装配（media-catalog.module.ts）或测试 rig 中经 bindMediaCatalogStore 绑定（ADR-0015 D1 / 规格 008 FR-004）',
    );
  }
  return boundStore;
}
