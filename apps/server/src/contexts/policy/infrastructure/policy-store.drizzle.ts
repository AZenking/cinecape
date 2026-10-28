/**
 * policy 仓储 Drizzle 实现（008-repository-extraction，ADR-0015 D1）。
 *
 * 查询代码自 application/policy.service.ts 与 policy.batch-context.ts 逐字迁移
 * （008 FR-002：join 链、谓词、分块参数、返回形态均不变）。
 *
 * 句柄解析语义与迁移前 getDb() 一致：缺省形态每方法惰性经 getDb() 解析，
 * Database 单例 close/重开自动重建包装（不在构造期捕获句柄）；测试 rig 经
 * drizzlePolicyStore(db) 以固定句柄构造（内存库）。句柄来自 @platform/database/drizzle
 * （008 实施修正：句柄归属平台层，infrastructure→platform 为 R1c 合法边，
 * 且不经任何发布面——避免测试 setup 预加载 identity-access 面破坏 vi.mock）。
 */
import { and, eq, inArray, sql } from 'drizzle-orm';
import { device, deviceSession, mediaItem, profile, profilePolicy } from '@platform/database/schema';
import { getDb, type Db } from '@platform/database/drizzle';
import type {
  HouseholdMediaCandidateRow,
  PolicyStore,
  PolicyTxStore,
} from '@contexts/policy/application/policy-store.port';

function policyRowWhere(householdId: string, profileId: string) {
  return and(eq(profilePolicy.householdId, householdId), eq(profilePolicy.profileId, profileId));
}

/** 句柄来源：固定句柄（测试 rig / 事务内 tx）或惰性 getDb()（生产，单例重开安全） */
type HandleSource = Db | (() => Db);

function resolveHandle(source: HandleSource): Db {
  return typeof source === 'function' ? source() : source;
}

class DrizzlePolicyTxStore implements PolicyTxStore {
  constructor(private readonly source: HandleSource) {}

  protected db(): Db {
    return resolveHandle(this.source);
  }

  findPolicy(householdId: string, profileId: string) {
    return this.db().select().from(profilePolicy).where(policyRowWhere(householdId, profileId)).get();
  }

  updatePolicyRow(householdId: string, profileId: string, patch: Record<string, string | number>): void {
    this.db().update(profilePolicy).set(patch).where(policyRowWhere(householdId, profileId)).run();
  }

  findMediaTypesByIds(householdId: string, ids: readonly string[]): Array<{ id: string; type: string }> {
    const rows: Array<{ id: string; type: string }> = [];
    for (let start = 0; start < ids.length; start += 500) {
      const chunk = ids.slice(start, start + 500);
      rows.push(
        ...this.db()
          .select({ id: mediaItem.id, type: mediaItem.type })
          .from(mediaItem)
          .where(and(eq(mediaItem.householdId, householdId), inArray(mediaItem.id, chunk)))
          .all(),
      );
    }
    return rows;
  }
}

class DrizzlePolicyStore extends DrizzlePolicyTxStore implements PolicyStore {
  constructor(handle?: Db) {
    // 缺省 getDb（惰性函数引用，不在构造期解析）；显式句柄用于测试 rig。
    super(handle === undefined ? getDb : () => handle);
  }

  findDeviceSession(sessionId: string) {
    return this.db().select().from(deviceSession).where(eq(deviceSession.id, sessionId)).get();
  }

  findDevice(deviceId: string) {
    return this.db().select().from(device).where(eq(device.id, deviceId)).get();
  }

  findProfile(profileId: string) {
    return this.db().select().from(profile).where(eq(profile.id, profileId)).get();
  }

  listHouseholdMediaRows(householdId: string): HouseholdMediaCandidateRow[] {
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

  loadAvailableMediaIdSet(householdId: string): Set<string> {
    // 逐字迁移自 loadAvailableMediaIdSet 的 join 链（等价性由 batch-policy-context.spec 双跑对比钉住）
    const rows = this.db().all<{ id: string }>(sql`
    SELECT se.media_id AS id
    FROM source_entry se
    INNER JOIN media_source ms ON ms.household_id = se.household_id AND ms.id = se.source_id AND ms.enabled = 1
    INNER JOIN playback_source ps ON ps.household_id = se.household_id AND ps.source_entry_id = se.id AND ps.media_item_id = se.media_id
    WHERE se.household_id = ${householdId}
      AND se.present = 1
      AND se.media_id IS NOT NULL
  `);
    return new Set(rows.map((row) => row.id));
  }

  withTransaction<T>(fn: (tx: PolicyTxStore) => T): T {
    return this.db().transaction((tx) => fn(new DrizzlePolicyTxStore(tx)));
  }
}

/** 装配/测试工厂：缺省 getDb() 惰性解析（生产）；显式句柄用于测试 rig（内存库） */
export function drizzlePolicyStore(handle?: Db): PolicyStore {
  return new DrizzlePolicyStore(handle);
}
