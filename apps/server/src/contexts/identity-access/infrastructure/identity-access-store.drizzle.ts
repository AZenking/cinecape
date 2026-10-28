/**
 * identity-access 仓储 Drizzle 实现（008-repository-extraction T011，ADR-0015 D1）。
 *
 * 查询代码自 application/{household,session,device,setup,bootstrap,
 * parent-verification}.service.ts 逐字迁移（008 FR-002：join 链、谓词、投影列集、
 * 返回形态均不变）；行→DTO 映射（toHouseholdDto / toDeviceDto / toProfileSummary）
 * 与用例编排（错误码、校验顺序、锁定状态机、版本 CAS）留在 application。
 *
 * 句柄解析语义与迁移前 getDb() 一致：缺省形态每方法惰性经 getDb() 解析，
 * Database 单例 close/重开自动重建包装（不在构造期捕获句柄）；测试 rig 经
 * drizzleIdentityAccessStore(db) 以固定句柄构造（内存库）。句柄来自
 * @platform/database/drizzle（008 实施修正：句柄归属平台层，infrastructure→platform
 * 为 R1c 合法边，且不经任何发布面——避免测试 setup 预加载 identity-access 面破坏
 * vi.mock）。
 *
 * 事务：bootstrap/setup 的 BEGIN IMMEDIATE 短事务经 withTransaction(fn,
 * 'immediate') 原样传递；device-revoke / parent-verification 省略 behavior
 * （drizzle 缺省 deferred），与迁移前逐字一致。txHandle() 把当前事务句柄作为
 * 不透明连接凭证交给 profile identity-transition 挂钩（clearDeviceSessionsProfile
 * 加入同一物理事务，调用形态保持迁移前 clearDeviceSessionsProfile(tx, input)）。
 */
import { and, asc, eq, isNull } from 'drizzle-orm';
import {
  account,
  device,
  deviceSession,
  household,
  parentVerificationState,
  profile,
  profilePolicy,
  profileProgressClock,
} from '@platform/database/schema';
import { getDb, type Db } from '@platform/database/drizzle';
import type {
  IdentityAccessStore,
  IdentityAccessTxStore,
  MainProfilePinResetPatch,
  NewAccount,
  NewDevice,
  NewDeviceSession,
  NewHousehold,
  NewParentVerificationState,
  NewProfile,
  NewProfilePolicy,
  NewProfileProgressClock,
} from '@contexts/identity-access/application/identity-access-store.port';

/** 句柄来源：固定句柄（测试 rig / 事务内 tx）或惰性 getDb()（生产，单例重开安全） */
type HandleSource = Db | (() => Db);

function resolveHandle(source: HandleSource): Db {
  return typeof source === 'function' ? source() : source;
}

class DrizzleIdentityAccessTxStore implements IdentityAccessTxStore {
  constructor(private readonly source: HandleSource) {}

  protected db(): Db {
    return resolveHandle(this.source);
  }

  findCredentialVersion(householdId: string, accountId: string) {
    return this.db()
      .select({ credentialVersion: account.credentialVersion })
      .from(account)
      .where(and(eq(account.householdId, householdId), eq(account.id, accountId)))
      .get();
  }

  countHouseholdProfiles(householdId: string): number {
    return this.db()
      .select({ id: profile.id })
      .from(profile)
      .where(eq(profile.householdId, householdId))
      .all().length;
  }

  findMainProfileSnapshot(householdId: string) {
    return this.db()
      .select({ id: profile.id, pinVersion: profile.pinVersion, version: profile.version })
      .from(profile)
      .where(and(eq(profile.householdId, householdId), eq(profile.isMain, 1)))
      .get();
  }

  findParentVerificationState(householdId: string, accountId: string) {
    return this.db()
      .select()
      .from(parentVerificationState)
      .where(
        and(
          eq(parentVerificationState.householdId, householdId),
          eq(parentVerificationState.accountId, accountId),
        ),
      )
      .get();
  }

  findDeviceRevocationState(deviceId: string, householdId: string) {
    return this.db()
      .select({ id: device.id, revokedAt: device.revokedAt })
      .from(device)
      .where(and(eq(device.id, deviceId), eq(device.householdId, householdId)))
      .get();
  }

  listUnrevokedSessionsByDevice(deviceId: string) {
    return this.db()
      .select({ id: deviceSession.id, activeProfileId: deviceSession.activeProfileId })
      .from(deviceSession)
      .where(and(eq(deviceSession.deviceId, deviceId), isNull(deviceSession.revokedAt)))
      .all();
  }

  listActiveProfileSessionIds(householdId: string, profileId: string): string[] {
    return this.db()
      .select({ id: deviceSession.id })
      .from(deviceSession)
      .where(and(eq(deviceSession.householdId, householdId), eq(deviceSession.activeProfileId, profileId)))
      .all()
      .map((row) => row.id);
  }

  findAnyHousehold(): { id: string } | undefined {
    return this.db().select({ id: household.id }).from(household).limit(1).get();
  }

  updateProfilePinReset(householdId: string, profileId: string, patch: MainProfilePinResetPatch): void {
    this.db()
      .update(profile)
      .set(patch)
      .where(and(eq(profile.householdId, householdId), eq(profile.id, profileId)))
      .run();
  }

  deleteParentVerificationState(householdId: string, accountId: string): void {
    this.db()
      .delete(parentVerificationState)
      .where(
        and(
          eq(parentVerificationState.householdId, householdId),
          eq(parentVerificationState.accountId, accountId),
        ),
      )
      .run();
  }

  upsertParentVerificationState(values: NewParentVerificationState): void {
    this.db()
      .insert(parentVerificationState)
      .values(values)
      .onConflictDoUpdate({
        target: [parentVerificationState.householdId, parentVerificationState.accountId],
        set: { failedAttempts: values.failedAttempts, lockedUntil: values.lockedUntil },
      })
      .run();
  }

  revokeDevice(deviceId: string, revokedAtIso: string): void {
    this.db()
      .update(device)
      .set({ revokedAt: revokedAtIso })
      .where(and(eq(device.id, deviceId), isNull(device.revokedAt)))
      .run();
  }

  revokeDeviceSessions(deviceId: string, revokedAtIso: string): void {
    this.db()
      .update(deviceSession)
      .set({ revokedAt: revokedAtIso })
      .where(and(eq(deviceSession.deviceId, deviceId), isNull(deviceSession.revokedAt)))
      .run();
  }

  insertHousehold(values: NewHousehold): void {
    this.db().insert(household).values(values).run();
  }

  insertAccount(values: NewAccount): void {
    this.db().insert(account).values(values).run();
  }

  insertProfile(row: NewProfile): void {
    this.db().insert(profile).values(row).run();
  }

  insertProfilePolicy(values: NewProfilePolicy): void {
    this.db().insert(profilePolicy).values(values).run();
  }

  insertProfileProgressClock(values: NewProfileProgressClock): void {
    this.db().insert(profileProgressClock).values(values).run();
  }

  txHandle(): Db {
    return this.db();
  }
}

class DrizzleIdentityAccessStore extends DrizzleIdentityAccessTxStore implements IdentityAccessStore {
  constructor(handle?: Db) {
    // 缺省 getDb（惰性函数引用，不在构造期解析）；显式句柄用于测试 rig。
    super(handle === undefined ? getDb : () => handle);
  }

  findHousehold(householdId: string) {
    return this.db().select().from(household).where(eq(household.id, householdId)).get();
  }

  findAccountByUsernameNormalized(usernameNormalized: string) {
    return this.db()
      .select()
      .from(account)
      .where(eq(account.usernameNormalized, usernameNormalized))
      .get();
  }

  findAccountByIdAndHousehold(accountId: string, householdId: string) {
    return this.db()
      .select()
      .from(account)
      .where(and(eq(account.id, accountId), eq(account.householdId, householdId)))
      .get();
  }

  findSessionExpiry(sessionId: string) {
    return this.db()
      .select({ expiresAt: deviceSession.expiresAt, createdAt: deviceSession.createdAt })
      .from(deviceSession)
      .where(eq(deviceSession.id, sessionId))
      .get();
  }

  updateSessionRenewal(sessionId: string, lastActiveAtIso: string, expiresAtIso: string): void {
    this.db()
      .update(deviceSession)
      .set({ lastActiveAt: lastActiveAtIso, expiresAt: expiresAtIso })
      .where(eq(deviceSession.id, sessionId))
      .run();
  }

  insertDeviceSession(values: NewDeviceSession): void {
    this.db().insert(deviceSession).values(values).run();
  }

  insertDevice(values: NewDevice): void {
    this.db().insert(device).values(values).run();
  }

  listDevicesByHousehold(householdId: string) {
    return this.db()
      .select()
      .from(device)
      .where(eq(device.householdId, householdId))
      .orderBy(asc(device.createdAt))
      .all();
  }

  withTransaction<T>(fn: (tx: IdentityAccessTxStore) => T, behavior?: 'immediate'): T {
    // 省略 behavior ≡ 迁移前 getDb().transaction(fn)（drizzle 缺省 deferred）；
    // 'immediate' ≡ 迁移前 { behavior: 'immediate' }（bootstrap/setup BEGIN IMMEDIATE 短事务）。
    return this.db().transaction((tx) => fn(new DrizzleIdentityAccessTxStore(tx)), behavior === undefined ? undefined : { behavior });
  }
}

/** 装配/测试工厂：缺省 getDb() 惰性解析（生产）；显式句柄用于测试 rig（内存库） */
export function drizzleIdentityAccessStore(handle?: Db): IdentityAccessStore {
  return new DrizzleIdentityAccessStore(handle);
}
