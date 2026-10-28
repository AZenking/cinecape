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
  PublicMediaSourceRow,
} from '@contexts/media-catalog/application/media-catalog-store.port';

function mediaItemWhere(householdId: string, mediaId: string) {
  return and(eq(mediaItem.householdId, householdId), eq(mediaItem.id, mediaId));
}

/** 目录修订单查(无行视为初版 1;catalog_state 行由发布/来源配置事务维护)——逐字迁移自 public-catalog.service */
const CATALOG_REVISION_SQL = 'SELECT revision FROM catalog_state WHERE household_id = ?';

/** 家庭媒体白名单来源列单查(poster_ref 仅为白名单投影输入;不查播放/来源身份列)——逐字迁移自 public-catalog.service */
const MEDIA_ROWS_SQL =
  'SELECT id, type, title, description, poster_ref AS posterRef, content_level AS contentLevel FROM media_item WHERE household_id = ?';

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
