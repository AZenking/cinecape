/**
 * settings 仓储 Drizzle 实现（008-repository-extraction T012，ADR-0015 D1）。
 *
 * 查询代码自 application 各服务文件逐字迁移（008 FR-002：join 链、谓词、
 * 分块参数、返回形态均不变）：
 * - settings-access-grant.service.ts / settings-access-revocation.ts（授予签发/撤销/重检）；
 * - settings-account.service.ts（密码改动级联）；
 * - settings-household.service.ts（通用设置）；
 * - settings-pin-verification.service.ts（PIN 状态机读写）；
 * - settings-profiles.service.ts（档案管理/主档案转移）；
 * - settings-devices.service.ts（设备归属重验与播放记录 keyset 查询）。
 *
 * 句柄解析语义与迁移前 getDb() 一致：缺省形态每方法惰性经 getDb() 解析，
 * Database 单例 close/重开自动重建包装（不在构造期捕获句柄）；测试 rig 经
 * drizzleSettingsStore(db) 以固定句柄构造（内存库）。句柄来自 @platform/database/drizzle
 * （008 实施修正：句柄归属平台层，infrastructure→platform 为 R1c 合法边，
 * 且不经任何发布面——避免测试 setup 预加载 identity-access 面破坏 vi.mock）。
 * Database.isReady 值引用（启动撤销 fail-closed 门禁）随之收敛至此。
 */
import { and, desc, eq, inArray, isNull, lt, ne, or } from 'drizzle-orm';
import {
  account,
  device,
  deviceSession,
  household,
  playbackFailureEvent,
  playbackSession,
  profile,
  profilePolicy,
  settingsAccessGrant,
} from '@platform/database/schema';
import { Database } from '@platform/database/database';
import { getDb, type Db } from '@platform/database/drizzle';
import type {
  HouseholdRowPatch,
  PlaybackFailureEventRow,
  PlaybackSessionRow,
  ProfileInsert,
  ProfilePolicyInsert,
  ProfileRowPatch,
  ProfilePinStatePatch,
  RecordCursor,
  SettingsGrantUpsertInput,
  SettingsStore,
  SettingsTxStore,
} from '@contexts/settings/application/settings-store.port';

function isoNow(): string {
  return new Date().toISOString();
}

/** 句柄来源：固定句柄（测试 rig / 事务内 tx）或惰性 getDb()（生产，单例重开安全） */
type HandleSource = Db | (() => Db);

function resolveHandle(source: HandleSource): Db {
  return typeof source === 'function' ? source() : source;
}

class DrizzleSettingsTxStore implements SettingsTxStore {
  constructor(private readonly source: HandleSource) {}

  protected db(): Db {
    return resolveHandle(this.source);
  }

  // —— settings_access_grant 签发/撤销 ——

  findSettingsGrant(householdId: string, deviceSessionId: string) {
    return this.db()
      .select()
      .from(settingsAccessGrant)
      .where(
        and(
          eq(settingsAccessGrant.householdId, householdId),
          eq(settingsAccessGrant.deviceSessionId, deviceSessionId),
        ),
      )
      .get();
  }

  upsertSettingsGrant(input: SettingsGrantUpsertInput): void {
    this.db()
      .insert(settingsAccessGrant)
      .values({
        householdId: input.householdId,
        deviceSessionId: input.deviceSessionId,
        profileId: input.profileId,
        profileContextVersion: input.profileContextVersion,
        pinVersion: input.pinVersion,
        mainProfileVersion: input.mainProfileVersion,
        issuedAt: input.issuedAt,
        expiresAt: input.expiresAt,
        revokedAt: null,
      })
      .onConflictDoUpdate({
        target: [settingsAccessGrant.householdId, settingsAccessGrant.deviceSessionId],
        set: {
          profileId: input.profileId,
          profileContextVersion: input.profileContextVersion,
          pinVersion: input.pinVersion,
          mainProfileVersion: input.mainProfileVersion,
          issuedAt: input.issuedAt,
          expiresAt: input.expiresAt,
          // 全新授予:旧撤销行被覆盖取代(不是恢复 —— 原到期时间不复用)
          revokedAt: null,
        },
      })
      .run();
  }

  revokeSessionGrant(householdId: string, deviceSessionId: string): void {
    this.db()
      .update(settingsAccessGrant)
      .set({ revokedAt: isoNow() })
      .where(
        and(
          eq(settingsAccessGrant.householdId, householdId),
          eq(settingsAccessGrant.deviceSessionId, deviceSessionId),
          isNull(settingsAccessGrant.revokedAt),
        ),
      )
      .run();
  }

  revokeAllGrantsForHousehold(householdId: string): void {
    this.db()
      .update(settingsAccessGrant)
      .set({ revokedAt: isoNow() })
      .where(and(eq(settingsAccessGrant.householdId, householdId), isNull(settingsAccessGrant.revokedAt)))
      .run();
  }

  revokeGrantsForProfile(input: { householdId: string; profileId: string }): void {
    this.db()
      .update(settingsAccessGrant)
      .set({ revokedAt: isoNow() })
      .where(
        and(
          eq(settingsAccessGrant.householdId, input.householdId),
          eq(settingsAccessGrant.profileId, input.profileId),
          isNull(settingsAccessGrant.revokedAt),
        ),
      )
      .run();
  }

  revokeGrantsForAccount(accountId: string): void {
    const sessionIds = this.db()
      .select({ id: deviceSession.id })
      .from(deviceSession)
      .where(eq(deviceSession.accountId, accountId))
      .all()
      .map((row) => row.id);
    if (sessionIds.length === 0) {
      return;
    }
    this.db()
      .update(settingsAccessGrant)
      .set({ revokedAt: isoNow() })
      .where(and(inArray(settingsAccessGrant.deviceSessionId, sessionIds), isNull(settingsAccessGrant.revokedAt)))
      .run();
  }

  revokeAllGrants(): void {
    this.db()
      .update(settingsAccessGrant)
      .set({ revokedAt: isoNow() })
      .where(isNull(settingsAccessGrant.revokedAt))
      .run();
  }

  // —— 授予重检读路径 ——

  findSessionRow(householdId: string, sessionId: string) {
    return this.db()
      .select()
      .from(deviceSession)
      .where(and(eq(deviceSession.householdId, householdId), eq(deviceSession.id, sessionId)))
      .get();
  }

  findSessionRowById(sessionId: string) {
    return this.db().select().from(deviceSession).where(eq(deviceSession.id, sessionId)).get();
  }

  findDeviceRevocation(householdId: string, deviceId: string) {
    return this.db()
      .select({ revokedAt: device.revokedAt })
      .from(device)
      .where(and(eq(device.householdId, householdId), eq(device.id, deviceId)))
      .get();
  }

  findDeviceHousehold(deviceId: string) {
    return this.db()
      .select({ householdId: device.householdId })
      .from(device)
      .where(eq(device.id, deviceId))
      .get();
  }

  findAccountRole(householdId: string, accountId: string) {
    return this.db()
      .select({ role: account.role })
      .from(account)
      .where(and(eq(account.householdId, householdId), eq(account.id, accountId)))
      .get();
  }

  findMainProfileRow(householdId: string) {
    return this.db()
      .select()
      .from(profile)
      .where(and(eq(profile.householdId, householdId), eq(profile.isMain, 1)))
      .get();
  }

  findHouseholdMainProfileVersion(householdId: string) {
    return this.db()
      .select({ mainProfileVersion: household.mainProfileVersion })
      .from(household)
      .where(eq(household.id, householdId))
      .get();
  }

  // —— 账号密码改动 ——

  findAccountCredentialRow(householdId: string, accountId: string) {
    return this.db()
      .select({ id: account.id, householdId: account.householdId, credentialVersion: account.credentialVersion })
      .from(account)
      .where(and(eq(account.householdId, householdId), eq(account.id, accountId)))
      .get();
  }

  listAccountSessions(accountId: string, householdId: string) {
    return this.db()
      .select({ id: deviceSession.id, householdId: deviceSession.householdId, activeProfileId: deviceSession.activeProfileId })
      .from(deviceSession)
      .where(and(eq(deviceSession.accountId, accountId), eq(deviceSession.householdId, householdId)))
      .all();
  }

  revokeAccountSessions(accountId: string, householdId: string, revokedAt: string): void {
    this.db()
      .update(deviceSession)
      .set({ revokedAt })
      .where(and(eq(deviceSession.accountId, accountId), eq(deviceSession.householdId, householdId), isNull(deviceSession.revokedAt)))
      .run();
  }

  updateAccountCredentials(householdId: string, accountId: string, patch: { passwordHash: string; credentialVersion: number }): void {
    this.db()
      .update(account)
      .set(patch)
      .where(and(eq(account.householdId, householdId), eq(account.id, accountId)))
      .run();
  }

  // —— 通用设置（household）——

  findHouseholdRow(householdId: string) {
    return this.db().select().from(household).where(eq(household.id, householdId)).get();
  }

  updateHouseholdRow(id: string, patch: HouseholdRowPatch): void {
    this.db()
      .update(household)
      .set(patch)
      .where(eq(household.id, id))
      .run();
  }

  // —— 设置 PIN 验证 ——

  findMainProfilePinRow(householdId: string) {
    return this.db()
      .select({
        id: profile.id,
        accountId: profile.accountId,
        pinHash: profile.pinHash,
        pinVersion: profile.pinVersion,
        failedPinCount: profile.failedPinCount,
        pinLockedUntil: profile.pinLockedUntil,
      })
      .from(profile)
      .where(and(eq(profile.householdId, householdId), eq(profile.isMain, 1)))
      .get();
  }

  findSessionActiveProfileId(householdId: string, sessionId: string) {
    return this.db()
      .select({ activeProfileId: deviceSession.activeProfileId })
      .from(deviceSession)
      .where(and(eq(deviceSession.householdId, householdId), eq(deviceSession.id, sessionId)))
      .get();
  }

  findSessionContextVersion(householdId: string, sessionId: string) {
    return this.db()
      .select({ profileContextVersion: deviceSession.profileContextVersion })
      .from(deviceSession)
      .where(and(eq(deviceSession.householdId, householdId), eq(deviceSession.id, sessionId)))
      .get();
  }

  findSessionActiveProfileWithContext(householdId: string, sessionId: string) {
    return this.db()
      .select({ activeProfileId: deviceSession.activeProfileId, profileContextVersion: deviceSession.profileContextVersion })
      .from(deviceSession)
      .where(and(eq(deviceSession.householdId, householdId), eq(deviceSession.id, sessionId)))
      .get();
  }

  findAccountCredentialVersion(householdId: string, accountId: string) {
    return this.db()
      .select({ credentialVersion: account.credentialVersion })
      .from(account)
      .where(and(eq(account.householdId, householdId), eq(account.id, accountId)))
      .get();
  }

  updateProfilePinState(householdId: string, profileId: string, state: ProfilePinStatePatch): void {
    this.db()
      .update(profile)
      .set(state)
      .where(and(eq(profile.householdId, householdId), eq(profile.id, profileId)))
      .run();
  }

  // —— 档案管理（profiles）——

  findProfileOfHousehold(householdId: string, accountId: string, profileId: string) {
    return this.db()
      .select()
      .from(profile)
      .where(and(eq(profile.id, profileId), eq(profile.householdId, householdId), eq(profile.accountId, accountId)))
      .get();
  }

  findProfileRow(profileId: string) {
    return this.db().select().from(profile).where(eq(profile.id, profileId)).get();
  }

  listManagedProfileRows(householdId: string, accountId: string) {
    return this.db()
      .select()
      .from(profile)
      .where(and(eq(profile.householdId, householdId), eq(profile.accountId, accountId)))
      .all();
  }

  listActiveProfileDefaultFlags(householdId: string) {
    return this.db()
      .select({ id: profile.id, isDefault: profile.isDefault })
      .from(profile)
      .where(and(eq(profile.householdId, householdId), eq(profile.status, 'active')))
      .all();
  }

  clearProfileDefault(profileId: string): void {
    this.db().update(profile).set({ isDefault: 0 }).where(eq(profile.id, profileId)).run();
  }

  insertProfile(row: ProfileInsert): void {
    this.db().insert(profile).values(row).run();
  }

  insertProfilePolicy(values: ProfilePolicyInsert): void {
    this.db().insert(profilePolicy).values(values).run();
  }

  listOtherActiveProfileIds(householdId: string, excludeProfileId: string) {
    return this.db()
      .select({ id: profile.id })
      .from(profile)
      .where(and(eq(profile.householdId, householdId), eq(profile.status, 'active'), ne(profile.id, excludeProfileId)))
      .all();
  }

  updateProfileRow(profileId: string, patch: ProfileRowPatch): void {
    this.db()
      .update(profile)
      .set(patch)
      .where(eq(profile.id, profileId))
      .run();
  }

  listSessionIdsUsingProfile(householdId: string, profileId: string) {
    return this.db()
      .select({ id: deviceSession.id })
      .from(deviceSession)
      .where(and(eq(deviceSession.householdId, householdId), eq(deviceSession.activeProfileId, profileId)))
      .all();
  }

  listAccountProfileIds(householdId: string, accountId: string) {
    return this.db()
      .select({ id: profile.id })
      .from(profile)
      .where(and(eq(profile.householdId, householdId), eq(profile.accountId, accountId)))
      .all();
  }

  // —— 设备播放记录（(time,id) 倒序 keyset）——

  listPlaybackSessionRows(householdId: string, deviceId: string, cursor: RecordCursor | undefined, limit: number): PlaybackSessionRow[] {
    const sessionWhere = [eq(playbackSession.householdId, householdId), eq(playbackSession.deviceId, deviceId)];
    if (cursor !== undefined) {
      const sessionCursor = or(
        lt(playbackSession.createdAt, cursor.time),
        and(eq(playbackSession.createdAt, cursor.time), lt(playbackSession.id, cursor.id)),
      );
      if (sessionCursor !== undefined) {
        sessionWhere.push(sessionCursor);
      }
    }
    return this.db()
      .select()
      .from(playbackSession)
      .where(and(...sessionWhere))
      .orderBy(desc(playbackSession.createdAt), desc(playbackSession.id))
      .limit(limit + 1)
      .all();
  }

  listPlaybackFailureRows(householdId: string, deviceId: string, cursor: RecordCursor | undefined, limit: number): PlaybackFailureEventRow[] {
    const failureWhere = [eq(playbackFailureEvent.householdId, householdId), eq(playbackFailureEvent.deviceId, deviceId)];
    if (cursor !== undefined) {
      const failureCursor = or(
        lt(playbackFailureEvent.occurredAt, cursor.time),
        and(eq(playbackFailureEvent.occurredAt, cursor.time), lt(playbackFailureEvent.id, cursor.id)),
      );
      if (failureCursor !== undefined) {
        failureWhere.push(failureCursor);
      }
    }
    return this.db()
      .select()
      .from(playbackFailureEvent)
      .where(and(...failureWhere))
      .orderBy(desc(playbackFailureEvent.occurredAt), desc(playbackFailureEvent.id))
      .limit(limit + 1)
      .all();
  }
}

class DrizzleSettingsStore extends DrizzleSettingsTxStore implements SettingsStore {
  constructor(handle?: Db) {
    // 缺省 getDb（惰性函数引用，不在构造期解析）；显式句柄用于测试 rig。
    super(handle === undefined ? getDb : () => handle);
  }

  withTransaction<T>(fn: (tx: SettingsTxStore, handle: Db) => T, behavior?: 'immediate'): T {
    return this.db().transaction((tx) => fn(new DrizzleSettingsTxStore(tx), tx), behavior === undefined ? undefined : { behavior });
  }

  isReady(): boolean {
    return Database.isReady();
  }
}

/** 装配/测试工厂：缺省 getDb() 惰性解析（生产）；显式句柄用于测试 rig（内存库） */
export function drizzleSettingsStore(handle?: Db): SettingsStore {
  return new DrizzleSettingsStore(handle);
}
