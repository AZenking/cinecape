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

/* ─────────────── 010 T030 增量：父级公共可用性/角色/分页分集投影 ───────────────
 * 以下类型与方法为 010 在线点播新增读面；既有方法（上方 MediaCatalogTxStore 与
 * findDeviceSession/listHouseholdMediaRows/loadMediaAvailabilityFacts/findCatalogRevision/
 * listPublicMediaRows/findPublicMediaRowById）签名与行为零变化（NAS/IPTV 面不动）。
 * 数据事实（010 data-model §2）：media_item.media_role ∈ standalone|vod_title|vod_episode；
 * 「父可浏览=至少一个已发布 present 子项、启用来源、完整 locator；与子可解析候选集合分开」。
 */

/**
 * 目录行（公共列表/详情投影的 010 统一输入列：既有白名单列 + 媒体角色 + 子项父链接）。
 * media_role 即 detailKind 词汇（standalone/vod_title/vod_episode）；parentMediaId 仅
 * vod_episode 非空（media_relation (household_id, child_id) 主键保证单父）。
 */
export interface PublicCatalogSourceRow {
  readonly id: string;
  readonly type: string;
  readonly title: string;
  readonly description: string | null;
  readonly posterRef: string | null;
  readonly contentLevel: number | null;
  readonly mediaRole: string;
  readonly parentMediaId: string | null;
}

/** vod 父级分集门面（稳定映射 + 当前修订指针；分页 cursor 修订指纹的签发来源） */
export interface VodParentFacet {
  readonly titleId: string;
  /** vod_title.current_detail_revision（cursor 修订绑定基准） */
  readonly detailRevision: number;
  readonly materializedAt: string;
  /** 当前修订详情快照 fetched_at；快照行缺失为 null（应用层回退 materializedAt） */
  readonly snapshotFetchedAt: string | null;
  /** 父级公共可用性：≥1 已发布子项 × 启用来源 × 完整根 locator（不含子项播放资源链） */
  readonly browsable: boolean;
}

/** 分集页行（单查询装载；线路聚合由应用层内存分组，lineRef 跨页稳定） */
export interface VodEpisodePageRow {
  /** 线路稳定标识（vod_line.id；线路可跨页重复，消费者按 lineRef 聚合） */
  readonly lineId: string;
  readonly lineName: string;
  readonly mediaId: string;
  readonly label: string;
  /** 确定序列序号：ordered 取 ordinal；ambiguous/special/缺序为 null（store 归一后输出） */
  readonly sequenceOrdinal: number | null;
  /** 子项可解析候选（present 条目 × 启用来源 × 播放资源；与 AVAILABLE_EXISTS 同链同步） */
  readonly resolvable: boolean;
}

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
  /* ───── 010 T030 增量读面（实现于 media-catalog-store.drizzle；单查询禁 N+1） ───── */
  /** 家庭目录行全集（含 media_role/子项父链接；「不重复铺子项」的列表裁定在应用层） */
  listPublicCatalogRows(householdId: string): PublicCatalogSourceRow[];
  /** 单条目录行（同上列集；不存在/跨家庭 undefined） */
  findPublicCatalogRowById(householdId: string, mediaId: string): PublicCatalogSourceRow | undefined;
  /** 父级公共可用集合：已物化 vod_title 且 ≥1 已发布子项 × 启用来源 × 完整根 locator（批量单查询） */
  loadVodBrowsableParentIds(householdId: string): Set<string>;
  /** 父级分集门面（非 vod 父/不存在 → undefined；stale=false 的稳定详情读面） */
  findVodParentFacet(householdId: string, parentMediaId: string): VodParentFacet | undefined;
  /** 分集全量单查询（线路×稳定子项×当前修订序列×子候选；应用层内存分页，禁止逐条 N+1） */
  listVodEpisodePageRows(householdId: string, parentMediaId: string, detailRevision: number): VodEpisodePageRow[];
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
