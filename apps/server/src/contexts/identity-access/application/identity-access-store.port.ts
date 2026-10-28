/**
 * identity-access 仓储端口（008-repository-extraction T011，ADR-0015 D1）。
 *
 * 应用层数据访问的唯一合法形态：本文件定义纯 TS 端口接口 + 模块级 seam 槽；
 * Drizzle 实现位于 infrastructure/identity-access-store.drizzle.ts，由
 * identity-access.module.ts 装配期绑定（useFactory），单元测试 rig 经
 * bindIdentityAccessStore 自行绑定。
 *
 * - 行类型经 `import type` 取自 @platform/database/schema（type-only 导入不产生
 *   依赖边，schema 保持单一事实源；depcruise 与 audit:purity 均放行）；
 * - 自有事务经 withTransaction 端口形态表达（bootstrap/setup 的 BEGIN IMMEDIATE
 *   短事务以 behavior: 'immediate' 参数原样传递），事务句柄不越出 infrastructure；
 * - 与 profile 上下文 identity-transition 的协作边（clearDeviceSessionsProfile）
 *   保持原调用形态：句柄经 txHandle() 以不透明连接凭证穿透 application 加入
 *   同一物理事务（对齐 profile-store.port txStore(tx) 的既定接合方向）；
 * - 方法签名与实现逐字对应既有查询（008 FR-002：SQL 构造与谓词逐字迁移），
 *   行→DTO 映射（toHouseholdDto / toDeviceDto / toProfileSummary）与应用判定
 *   （404/401/409/423 错误码与校验顺序）留在 application；
 * - seam 未绑定即调用为编程错误（显式失败，不静默空转；008 FR-004）。
 */
import type { Db } from '@platform/database/drizzle';
import type {
  account,
  device,
  deviceSession,
  household,
  parentVerificationState,
  profile,
  profilePolicy,
  profileProgressClock,
} from '@platform/database/schema';

export type HouseholdRow = typeof household.$inferSelect;
export type AccountRow = typeof account.$inferSelect;
export type DeviceRow = typeof device.$inferSelect;
export type ParentVerificationStateRow = typeof parentVerificationState.$inferSelect;

export type NewHousehold = typeof household.$inferInsert;
export type NewAccount = typeof account.$inferInsert;
export type NewDevice = typeof device.$inferInsert;
export type NewDeviceSession = typeof deviceSession.$inferInsert;
export type NewProfile = typeof profile.$inferInsert;
export type NewProfilePolicy = typeof profilePolicy.$inferInsert;
export type NewProfileProgressClock = typeof profileProgressClock.$inferInsert;
export type NewParentVerificationState = typeof parentVerificationState.$inferInsert;

/** 凭据版本投影（credentialVersionOf 的列集，与迁移前一致） */
export interface CredentialVersionRow {
  credentialVersion: number;
}

/** 主档案快照投影（readMainProfileRow 的列集，与迁移前一致） */
export interface MainProfileSnapshotRow {
  id: string;
  pinVersion: number;
  version: number;
}

/** 主档案 PIN 重设 patch（recoverMainProfilePin 事务 .set 键集，与迁移前一致） */
export interface MainProfilePinResetPatch {
  pinHash: string;
  failedPinCount: number;
  pinLockedUntil: string | null;
  pinVersion: number;
  version: number;
}

/** 设备撤销判定投影（revokeHouseholdDevice 事务读，列集与迁移前一致） */
export interface DeviceRevocationStateRow {
  id: string;
  revokedAt: string | null;
}

/** 未注销会话身份投影（revokeHouseholdDevice 事务读，列集与迁移前一致） */
export interface DeviceSessionIdentityRow {
  id: string;
  activeProfileId: string | null;
}

/** 会话续期读路径投影（renewSession 的列集，与迁移前一致） */
export interface SessionExpiryRow {
  expiresAt: string;
  createdAt: string;
}

/**
 * 事务作用域内的操作（bootstrap / setup / device-revoke / parent-verification
 * 事务块形态）。顶层只读入口（bootstrap 预检、parent-verification 初读等）经
 * IdentityAccessStore 继承同一方法面，句柄解析差异见 infrastructure 实现。
 */
export interface IdentityAccessTxStore {
  /* ---------- 事务块内读 ---------- */
  /** (household_id, id) 账号凭据版本（首建/PIN 恢复事务提交前重读） */
  findCredentialVersion(householdId: string, accountId: string): CredentialVersionRow | undefined;
  /** 家庭档案计数（零档案预检/事务内复检；id 投影计数形态与迁移前一致） */
  countHouseholdProfiles(householdId: string): number;
  /** 主档案快照（is_main=1 投影，PIN 恢复事务提交前重读） */
  findMainProfileSnapshot(householdId: string): MainProfileSnapshotRow | undefined;
  /** (household_id, account_id) 家长验证状态（事务内重读，异步哈希窗口并发安全） */
  findParentVerificationState(householdId: string, accountId: string): ParentVerificationStateRow | undefined;
  /** 设备撤销判定读（不存在/跨家庭 → undefined，404 判定留 application） */
  findDeviceRevocationState(deviceId: string, householdId: string): DeviceRevocationStateRow | undefined;
  /** 设备全部未注销会话及其当前身份（撤销事务的身份清理分组读） */
  listUnrevokedSessionsByDevice(deviceId: string): DeviceSessionIdentityRow[];
  /** 当前选用指定档案的会话 id（PIN 恢复清空身份读，id 投影收拢） */
  listActiveProfileSessionIds(householdId: string, profileId: string): string[];
  /** 家庭表任意行存在性（initializeDeployment 事务内复检；limit 1 投影） */
  findAnyHousehold(): { id: string } | undefined;

  /* ---------- 事务块内写 ---------- */
  /** 重设主档案 PIN（patch 键集与迁移前一致；谓词 (household_id, id)） */
  updateProfilePinReset(householdId: string, profileId: string, patch: MainProfilePinResetPatch): void;
  /** 验证成功清零：删除状态行（谓词与迁移前一致） */
  deleteParentVerificationState(householdId: string, accountId: string): void;
  /** 失败累加/落锁：upsert（onConflictDoUpdate target/set 与迁移前一致，set 键取自 values） */
  upsertParentVerificationState(values: NewParentVerificationState): void;
  /** 设备撤销（已撤销跳过判定由调用方承担；谓词含 revoked_at IS NULL） */
  revokeDevice(deviceId: string, revokedAtIso: string): void;
  /** 设备全部未注销会话立即失效（谓词与迁移前一致） */
  revokeDeviceSessions(deviceId: string, revokedAtIso: string): void;
  insertHousehold(values: NewHousehold): void;
  insertAccount(values: NewAccount): void;
  insertProfile(row: NewProfile): void;
  insertProfilePolicy(values: NewProfilePolicy): void;
  insertProfileProgressClock(values: NewProfileProgressClock): void;

  /* ---------- 跨上下文事务接合 ---------- */
  /**
   * 当前作用域句柄（不透明连接凭证，type-only）：profile 上下文 identity-transition
   * 挂钩（clearDeviceSessionsProfile）加入调用方事务时经此传递，加入的是同一物理
   * 事务（对齐 profile-store.port 的 txStore(tx) 接合方向，调用形态保持迁移前
   * clearDeviceSessionsProfile(tx, input)）；句柄上的查询构造不回到 application。
   */
  txHandle(): Db;
}

/** identity-access 上下文仓储端口（读路径 + 事务入口） */
export interface IdentityAccessStore extends IdentityAccessTxStore {
  /* ---------- household ---------- */
  findHousehold(householdId: string): HouseholdRow | undefined;

  /* ---------- session（签发/认证/滑动续期） ---------- */
  /** 按规范化用户名查账号（谓词值 username.toLowerCase() 由调用方计算，与迁移前一致） */
  findAccountByUsernameNormalized(usernameNormalized: string): AccountRow | undefined;
  /** 会话上下文与账号行一致性读（(id, household_id) 谓词） */
  findAccountByIdAndHousehold(accountId: string, householdId: string): AccountRow | undefined;
  findSessionExpiry(sessionId: string): SessionExpiryRow | undefined;
  /** 滑动续期写（.set(lastActiveAt, expiresAt) 形态，值由调用方计算） */
  updateSessionRenewal(sessionId: string, lastActiveAtIso: string, expiresAtIso: string): void;
  insertDeviceSession(values: NewDeviceSession): void;

  /* ---------- device ---------- */
  insertDevice(values: NewDevice): void;
  /** 家庭设备列表（含已撤销，created_at 升序，与迁移前一致） */
  listDevicesByHousehold(householdId: string): DeviceRow[];

  /**
   * 事务入口：省略 behavior ≡ 迁移前 `getDb().transaction(fn)`（drizzle 缺省
   * deferred，device-revoke / parent-verification）；'immediate' ≡ 迁移前
   * `{ behavior: 'immediate' }`（bootstrap / setup 短事务）。
   */
  withTransaction<T>(fn: (tx: IdentityAccessTxStore) => T, behavior?: 'immediate'): T;
}

/**
 * seam 槽（ADR-0015 D1）：未绑定即调用为编程错误（显式失败，不静默空转）；
 * 重复绑定幂等覆盖（测试 rig 在 Database 单例重开后重建需要）。
 */
let boundStore: IdentityAccessStore | null = null;

export function bindIdentityAccessStore(store: IdentityAccessStore): void {
  boundStore = store;
}

export function identityAccessStore(): IdentityAccessStore {
  if (boundStore === null) {
    throw new Error(
      'IDENTITY_ACCESS_STORE 未绑定：identity-access 仓储端口需在模块装配（identity-access.module.ts）或测试 rig 中经 bindIdentityAccessStore 绑定（ADR-0015 D1 / 规格 008 FR-004）',
    );
  }
  return boundStore;
}
