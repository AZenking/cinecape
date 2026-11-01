/**
 * media-catalog 仓储 Drizzle 实现（008-repository-extraction T010，ADR-0015 D1）。
 *
 * 查询代码自 application/catalog-admin.service.ts、application/public-catalog.service.ts
 * 与 infrastructure/resource-reader.ts 逐字迁移（008 FR-002：join 链、谓词、条件字段
 * 补丁、返回形态均不变）；public-catalog 的原生 prepare 查询逐字保留
 * Database.db.prepare 调用形态（infra→platform 合法边，不经任何发布面）。
 *
 * 句柄解析语义与迁移前一致：缺省形态每方法惰性解析——drizzle 走 getDb()、原生查询
 * 走 Database.db（两者跟随同一 SQLite 单例 close/重开自动重建，不在构造期捕获句柄）；
 * 测试 rig 经 drizzleMediaCatalogStore(db, conn) 以固定句柄构造（内存库）。
 */
import { and, eq, inArray, sql } from 'drizzle-orm';
import type DatabaseConstructor from 'better-sqlite3';
import { Database } from '@platform/database/database';
import { getDb, type Db } from '@platform/database/drizzle';
import { catalogState, deviceSession, mediaItem } from '@platform/database/schema';
import type {
  AvailabilityQuery,
  HouseholdMediaRow,
  MediaCatalogStore,
  MediaCatalogTxStore,
  MediaItemPatch,
  PublicCatalogSourceRow,
  PublicMediaSourceRow,
  VodEpisodePageRow,
  VodParentFacet,
} from '@contexts/media-catalog/application/media-catalog-store.port';

function mediaItemWhere(householdId: string, mediaId: string) {
  return and(eq(mediaItem.householdId, householdId), eq(mediaItem.id, mediaId));
}

/** 目录修订单查(无行视为初版 1;catalog_state 行由发布/来源配置事务维护)——逐字迁移自 public-catalog.service */
const CATALOG_REVISION_SQL = 'SELECT revision FROM catalog_state WHERE household_id = ?';

/** 家庭媒体白名单来源列单查(poster_ref 仅为白名单投影输入;不查播放/来源身份列)——逐字迁移自 public-catalog.service */
const MEDIA_ROWS_SQL =
  'SELECT id, type, title, description, poster_ref AS posterRef, content_level AS contentLevel FROM media_item WHERE household_id = ?';

/* ─────────────── 010 T030:父级公共可用性/角色/分页分集投影 ───────────────
 * 列名逐一对照 schema.ts / migrations/0007_online_vod(DDL 权威);全部单查询,
 * 聚合/分页在应用层内存完成,禁止逐条 N+1。 */

/**
 * 目录行(010):既有白名单列 + media_role(detailKind 词汇)+ vod_episode 子项父链接。
 * LEFT JOIN media_relation 不增行:(household_id, child_id) 复合主键(0007 收敛)保证
 * 子项至多一行;standalone/vod_title 行 parentMediaId 恒 NULL。
 */
const CATALOG_ROWS_SQL = `
  SELECT mi.id AS id, mi.type AS type, mi.title AS title, mi.description AS description,
         mi.poster_ref AS posterRef, mi.content_level AS contentLevel,
         mi.media_role AS mediaRole, mr.parent_id AS parentMediaId
  FROM media_item mi
  LEFT JOIN media_relation mr
    ON mr.household_id = mi.household_id AND mr.child_id = mi.id AND mr.kind = 'vod_episode'
  WHERE mi.household_id = ?
`;

/**
 * 父级公共可用链(010 data-model §2「父可浏览=至少一个已发布 present 子项、启用来源、
 * 完整 locator;与子可解析候选集合分开」):已物化 vod_title × ≥1 已发布稳定子项
 * (media_relation+vod_episode)× 启用来源 × 完整根 locator(remote_url 非空,vod 来源
 * 根地址不可 PATCH)。刻意不含 source_entry/playback_source——那是「子可解析候选」链
 * (AVAILABLE_EXISTS / policy-store loadAvailableMediaIdSet 同源),子项链缺失不隐藏父卡
 * 浏览面;两条链各司其职,修改任一侧必须核对其余副本(与 AVAILABLE_EXISTS 三处同纪律)。
 * 该链文本被 loadVodBrowsableParentIds(批量)与 findVodParentFacet(内层 EXISTS,别名
 * vt/mr/ve/ms 不变、外层 pt 关联)共享,两处必须同步修改。
 */
const VOD_BROWSABLE_CHAIN = `
  INNER JOIN media_source ms
    ON ms.household_id = vt.household_id AND ms.id = vt.source_id
   AND ms.enabled = 1 AND ms.remote_url IS NOT NULL
  INNER JOIN media_relation mr
    ON mr.household_id = vt.household_id AND mr.parent_id = vt.parent_media_id
   AND mr.kind = 'vod_episode'
  INNER JOIN vod_episode ve
    ON ve.household_id = vt.household_id AND ve.media_id = mr.child_id
`;

/**
 * 分集页全量单查(010):线路 × 稳定子项 × 当前修订序列 × 子候选,一次装载。
 * - 线路/子项身份:media_relation(parent→child)× vod_episode(media_id 唯一 → 子项单线)
 *   × media_item(公共展示 label;title_overridden 派生保护在发布侧维护);
 * - 序列映射:vod_episode_sequence 无行级唯一(同集不同 sequence_revision 按序落行),
 *   LEFT JOIN 取当前 detail_revision 下 sequence_revision 最高(平局取最新 rowid)的
 *   单行,related 子查询为语句内关联,非应用层 N+1;
 * - 子候选 resolvable:与 AVAILABLE_EXISTS 逐字同一「present 条目 × enabled 来源 ×
 *   playback 记录」链(等价纪律同上),candidate/unavailable 由应用层映射;
 * - 排序:(line.sort_order, relation.sort_order, episode_key) 全序确定 → 跨页重放稳定。
 */
const VOD_EPISODE_PAGE_SQL = `
  SELECT
    vl.id AS lineId,
    vl.display_name AS lineName,
    mi.id AS mediaId,
    mi.title AS label,
    ves.ordinal AS sequenceOrdinalRaw,
    ves.sequence_status AS sequenceStatusRaw,
    EXISTS (
      SELECT 1
      FROM source_entry se
      INNER JOIN media_source ses ON ses.household_id = se.household_id AND ses.id = se.source_id AND ses.enabled = 1
      INNER JOIN playback_source ps ON ps.household_id = se.household_id AND ps.source_entry_id = se.id AND ps.media_item_id = se.media_id
      WHERE se.household_id = mi.household_id
        AND se.media_id = mi.id
        AND se.present = 1
    ) AS resolvable
  FROM vod_title vt
  INNER JOIN vod_line vl
    ON vl.household_id = vt.household_id AND vl.title_id = vt.id
  INNER JOIN vod_episode ve
    ON ve.household_id = vt.household_id AND ve.line_id = vl.id
  INNER JOIN media_item mi
    ON mi.household_id = ve.household_id AND mi.id = ve.media_id AND mi.media_role = 'vod_episode'
  INNER JOIN media_relation mr
    ON mr.household_id = vt.household_id AND mr.parent_id = vt.parent_media_id
   AND mr.child_id = mi.id AND mr.kind = 'vod_episode'
  LEFT JOIN vod_episode_sequence ves
    ON ves.rowid = (
      SELECT cand.rowid
      FROM vod_episode_sequence cand
      WHERE cand.household_id = ve.household_id
        AND cand.line_id = ve.line_id
        AND cand.episode_id = ve.id
        AND cand.detail_revision = ?
      ORDER BY cand.sequence_revision DESC, cand.rowid DESC
      LIMIT 1
    )
  WHERE vt.household_id = ? AND vt.parent_media_id = ?
  ORDER BY vl.sort_order, mr.sort_order, ve.episode_key
`;

/** vod_episode_sequence 行原始投影(ordinal/status 归一为 sequenceOrdinal 前的中间形态) */
interface VodEpisodePageRawRow {
  lineId: string;
  lineName: string;
  mediaId: string;
  label: string;
  sequenceOrdinalRaw: number | null;
  sequenceStatusRaw: string | null;
  resolvable: number;
}

/** vod_title 门面原始行(EXISTS/快照列为 SQL 数值/原生形态,归一前) */
interface VodParentFacetRawRow {
  titleId: string;
  detailRevision: number;
  materializedAt: string;
  snapshotFetchedAt: string | null;
  browsable: number;
}

/**
 * 相关 EXISTS 子查询:一条「present 条目 + enabled 来源 + playback 记录」链即可用——
 * 逐字迁移自 infrastructure/resource-reader(该模块保留 db 参数导出供测试等价守卫;
 * AVAILABLE_EXISTS 的 join 链与 policy-store.drizzle 的 loadAvailableMediaIdSet 同源,
 * 修改任何一侧 join 链必须同步其余两侧,否则 batch-policy-context.spec 双跑对比失败)。
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

/** 句柄来源：固定句柄（测试 rig / 事务内 tx）或惰性 getDb()（生产，单例重开安全） */
type HandleSource = Db | (() => Db);

/** 原生查询句柄来源：固定连接（测试 rig）或惰性 Database.db（生产，单例重开安全） */
type RawSource = DatabaseConstructor.Database | (() => DatabaseConstructor.Database);

function resolveDb(source: HandleSource): Db {
  return typeof source === 'function' ? source() : source;
}

function resolveRaw(source: RawSource): DatabaseConstructor.Database {
  return typeof source === 'function' ? source() : source;
}

class DrizzleMediaCatalogTxStore implements MediaCatalogTxStore {
  constructor(private readonly source: HandleSource) {}

  protected db(): Db {
    return resolveDb(this.source);
  }

  findMediaItemRow(householdId: string, mediaId: string) {
    return this.db().select().from(mediaItem).where(mediaItemWhere(householdId, mediaId)).get();
  }

  updateMediaItemRow(householdId: string, mediaId: string, patch: MediaItemPatch): void {
    this.db().update(mediaItem).set(patch).where(mediaItemWhere(householdId, mediaId)).run();
  }

  bumpCatalogRevision(householdId: string): void {
    this.db()
      .insert(catalogState)
      .values({ householdId, revision: 2 })
      .onConflictDoUpdate({
        target: catalogState.householdId,
        set: { revision: sql`${catalogState.revision} + 1` },
      })
      .run();
  }
}

class DrizzleMediaCatalogStore extends DrizzleMediaCatalogTxStore implements MediaCatalogStore {
  private readonly rawSource: RawSource;

  constructor(handle?: Db, raw?: DatabaseConstructor.Database) {
    // 缺省 getDb / Database.db（惰性函数引用，不在构造期解析）；显式句柄用于测试 rig。
    super(handle === undefined ? getDb : () => handle);
    this.rawSource = raw === undefined ? () => Database.db : () => raw;
  }

  private raw(): DatabaseConstructor.Database {
    return resolveRaw(this.rawSource);
  }

  findDeviceSession(sessionId: string) {
    return this.db().select().from(deviceSession).where(eq(deviceSession.id, sessionId)).get();
  }

  listHouseholdMediaRows(householdId: string): HouseholdMediaRow[] {
    return this.db()
      .select({
        id: mediaItem.id,
        type: mediaItem.type,
        title: mediaItem.title,
        description: mediaItem.description,
        contentLevel: mediaItem.contentLevel,
        version: mediaItem.version,
      })
      .from(mediaItem)
      .where(eq(mediaItem.householdId, householdId))
      .all();
  }

  loadMediaAvailabilityFacts(query: AvailabilityQuery): Map<string, boolean> {
    if (query.mediaIds !== undefined && query.mediaIds.length === 0) {
      return new Map();
    }
    const conditions = [eq(mediaItem.householdId, query.householdId)];
    if (query.mediaIds !== undefined) {
      conditions.push(inArray(mediaItem.id, query.mediaIds));
    }
    const rows = this.db()
      .select({ id: mediaItem.id, available: AVAILABLE_EXISTS })
      .from(mediaItem)
      .where(and(...conditions))
      .all();
    return new Map(rows.map((row) => [row.id, row.available === 1]));
  }

  findCatalogRevision(householdId: string): { revision: number } | undefined {
    return this.raw().prepare(CATALOG_REVISION_SQL).get(householdId) as { revision: number } | undefined;
  }

  listPublicMediaRows(householdId: string): PublicMediaSourceRow[] {
    return this.raw().prepare(MEDIA_ROWS_SQL).all(householdId) as PublicMediaSourceRow[];
  }

  findPublicMediaRowById(householdId: string, mediaId: string): PublicMediaSourceRow | undefined {
    return this.raw().prepare(`${MEDIA_ROWS_SQL} AND id = ?`).get(householdId, mediaId) as
      | PublicMediaSourceRow
      | undefined;
  }

  /* ─────────────── 010 T030 增量读面 ─────────────── */

  listPublicCatalogRows(householdId: string): PublicCatalogSourceRow[] {
    return this.raw().prepare(CATALOG_ROWS_SQL).all(householdId) as PublicCatalogSourceRow[];
  }

  findPublicCatalogRowById(householdId: string, mediaId: string): PublicCatalogSourceRow | undefined {
    return this.raw().prepare(`${CATALOG_ROWS_SQL} AND mi.id = ?`).get(householdId, mediaId) as
      | PublicCatalogSourceRow
      | undefined;
  }

  loadVodBrowsableParentIds(householdId: string): Set<string> {
    const rows = this.raw()
      .prepare(
        `SELECT vt.parent_media_id AS parentMediaId FROM vod_title vt ${VOD_BROWSABLE_CHAIN} WHERE vt.household_id = ?`,
      )
      .all(householdId) as Array<{ parentMediaId: string }>;
    return new Set(rows.map((row) => row.parentMediaId));
  }

  findVodParentFacet(householdId: string, parentMediaId: string): VodParentFacet | undefined {
    // 外层别名 pt:父级可浏览链内层固定 vt/mr/ve/ms,经 pt.household_id/pt.parent_media_id 关联
    const row = this.raw()
      .prepare(
        `SELECT pt.id AS titleId, pt.current_detail_revision AS detailRevision,
                pt.materialized_at AS materializedAt,
                snap.fetched_at AS snapshotFetchedAt,
                EXISTS (
                  SELECT 1 FROM vod_title vt ${VOD_BROWSABLE_CHAIN}
                  WHERE vt.household_id = pt.household_id AND vt.parent_media_id = pt.parent_media_id
                ) AS browsable
         FROM vod_title pt
         LEFT JOIN vod_detail_snapshot snap
           ON snap.household_id = pt.household_id AND snap.title_id = pt.id
          AND snap.revision = pt.current_detail_revision
         WHERE pt.household_id = ? AND pt.parent_media_id = ?`,
      )
      .get(householdId, parentMediaId) as VodParentFacetRawRow | undefined;
    if (row === undefined) {
      return undefined;
    }
    return {
      titleId: row.titleId,
      detailRevision: row.detailRevision,
      materializedAt: row.materializedAt,
      snapshotFetchedAt: row.snapshotFetchedAt,
      browsable: row.browsable === 1,
    };
  }

  listVodEpisodePageRows(householdId: string, parentMediaId: string, detailRevision: number): VodEpisodePageRow[] {
    const rows = this.raw()
      .prepare(VOD_EPISODE_PAGE_SQL)
      .all(detailRevision, householdId, parentMediaId) as VodEpisodePageRawRow[];
    // 序列归一(010 openapi StableEpisodeItem):ordered 取 ordinal;ambiguous/special/缺序为 null
    return rows.map((row) => ({
      lineId: row.lineId,
      lineName: row.lineName,
      mediaId: row.mediaId,
      label: row.label,
      sequenceOrdinal:
        row.sequenceStatusRaw === 'ordered' && row.sequenceOrdinalRaw !== null ? row.sequenceOrdinalRaw : null,
      resolvable: row.resolvable === 1,
    }));
  }

  withTransaction<T>(fn: (tx: MediaCatalogTxStore) => T): T {
    return this.db().transaction((tx) => fn(new DrizzleMediaCatalogTxStore(tx)));
  }
}

/** 装配/测试工厂：缺省惰性解析（生产）；显式句柄用于测试 rig（内存库；原生查询需同步传 raw 连接） */
export function drizzleMediaCatalogStore(
  handle?: Db,
  raw?: DatabaseConstructor.Database,
): MediaCatalogStore {
  return new DrizzleMediaCatalogStore(handle, raw);
}
