/**
 * settings 仓储端口（008-repository-extraction T012，ADR-0015 D1）。
 *
 * 应用层数据访问的唯一合法形态：本文件定义纯 TS 端口接口 + 模块级 seam 槽；
 * Drizzle 实现位于 infrastructure/settings-store.drizzle.ts，由 settings.module.ts
 * 装配期绑定（useFactory），单元测试 rig 经 bindSettingsStore 自行绑定。
 *
 * - 行类型经 `import type` 取自 @platform/database/schema（type-only 导入不产生
 *   依赖边，schema 保持单一事实源；depcruise 与 audit:purity 均放行）；
 * - 自有事务经 withTransaction 端口形态表达，事务句柄（tx）不越出 infrastructure；
 *   与 profile 上下文 identity-transition 的协作沿用 profile 端口先例：回调第二参
 *   handle 是不透明的连接凭证，仅用于穿透 application 交给
 *   clearDeviceSessionsProfile(handle, …)（其内部经 profileStore().txStore(handle)
 *   加入同一物理事务），其上的查询构造全部留在各上下文 infrastructure；
 * - 存储就绪门禁（Database.isReady，启动撤销 fail-closed 判定）以 isReady 端口
 *   形态表达，Database 类值引用收敛进仓储实现；
 * - 方法签名与实现逐字对应既有查询（008 FR-002：SQL 构造与谓词逐字迁移），
 *   行→DTO 映射（toHouseholdSettings / toSessionRecord 等）与应用判定逻辑
 *   （授予重检、版本 CAS、PIN 状态机）留在 application。
 */
import type { Db } from '@platform/database/drizzle';
import type {
  deviceSession,
  household,
  playbackFailureEvent,
  playbackSession,
  profile,
  profilePolicy,
  settingsAccessGrant,
} from '@platform/database/schema';

export type DeviceSessionRow = typeof deviceSession.$inferSelect;
export type HouseholdRow = typeof household.$inferSelect;
export type ProfileRow = typeof profile.$inferSelect;
export type ProfileInsert = typeof profile.$inferInsert;
export type ProfilePolicyInsert = typeof profilePolicy.$inferInsert;
export type SettingsAccessGrantRow = typeof settingsAccessGrant.$inferSelect;
export type PlaybackSessionRow = typeof playbackSession.$inferSelect;
export type PlaybackFailureEventRow = typeof playbackFailureEvent.$inferSelect;

/** 账号凭据快照（readAccountRow 装载形态，列集与迁移前一致） */
export interface AccountCredentialRow {
  id: string;
  householdId: string;
  credentialVersion: number;
}

/** 主档案 PIN 状态投影（readMainProfileRow 装载形态，列集与迁移前一致） */
export interface MainProfilePinRow {
  id: string;
  accountId: string;
  pinHash: string | null;
  pinVersion: number;
  failedPinCount: number;
  pinLockedUntil: string | null;
}

/** PIN 失败计数/锁定窗口写入形态（registerPinFailure / PIN_STATE_CLEARED 的 .set() 形态） */
export interface ProfilePinStatePatch {
  failedPinCount: number;
  pinLockedUntil: string | null;
}

/** profile 行可写字段集（patchManagedProfile / transferMainProfile 的 .set(patch) 形态） */
export interface ProfileRowPatch {
  name?: string;
  avatar?: string | null;
  isDefault?: number;
  status?: string;
  pinHash?: string | null;
  failedPinCount?: number;
  pinLockedUntil?: string | null;
  pinVersion?: number;
  isMain?: number;
  version: number;
}

/** household 行可写字段集（patchHouseholdSettings / transferMainProfile 的 .set(patch) 形态） */
export interface HouseholdRowPatch {
  name?: string;
  defaultLanguage?: string;
  timezone?: string;
  version?: number;
  mainProfileVersion?: number;
}

/** 设置授予覆盖写输入（issueSettingsGrantTx 的新签发形态；issued/expires 由调用方计算） */
export interface SettingsGrantUpsertInput {
  householdId: string;
  deviceSessionId: string;
  profileId: string;
  profileContextVersion: number;
  pinVersion: number;
  mainProfileVersion: number;
  issuedAt: string;
  expiresAt: string;
}

/** 设备播放记录键集游标（(time,id) 内部形态；base64url 编解码与 400 判定留 application） */
export interface RecordCursor {
  time: string;
  id: string;
}

/** 事务作用域内的 settings 表操作（各 BEGIN IMMEDIATE 事务块形态；缺省句柄下亦可用作共享连接读） */
export interface SettingsTxStore {
  // —— settings_access_grant 签发/撤销（自 settings-access-grant.service / settings-access-revocation 逐字迁移）——
  findSettingsGrant(householdId: string, deviceSessionId: string): SettingsAccessGrantRow | undefined;
  /** 联合主键 (household_id, device_session_id) 覆盖写（onConflictDoUpdate，键集与迁移前一致） */
  upsertSettingsGrant(input: SettingsGrantUpsertInput): void;
  /** 仅未撤销行写 revoked_at（失效后不再恢复，幂等） */
  revokeSessionGrant(householdId: string, deviceSessionId: string): void;
  /** 撤销家庭全部未撤销设置授予（授权域事件统一收口） */
  revokeAllGrantsForHousehold(householdId: string): void;
  /** 撤销指定档案名下全部设置授予 */
  revokeGrantsForProfile(input: { householdId: string; profileId: string }): void;
  /** 撤销账号全部设置授予（经该账号的会话；无会话时零写入） */
  revokeGrantsForAccount(accountId: string): void;
  /** 启动撤销：撤销所有家庭全部未撤销设置授予 */
  revokeAllGrants(): void;

  // —— 授予重检读路径（validateSettingsGrant 的连接查询；401/403 判定留 application）——
  /** 会话行（household + id 精确匹配；撤销/过期判定留 application） */
  findSessionRow(householdId: string, sessionId: string): DeviceSessionRow | undefined;
  /** 会话行（仅 id 匹配；当次密码验证后的会话重验读路径） */
  findSessionRowById(sessionId: string): DeviceSessionRow | undefined;
  findDeviceRevocation(householdId: string, deviceId: string): { revokedAt: string | null } | undefined;
  /** 设备归属行(仅 id 匹配;跨家庭 404 同形判定留 application) */
  findDeviceHousehold(deviceId: string): { householdId: string } | undefined;
  findAccountRole(householdId: string, accountId: string): { role: string } | undefined;
  /** 当前主档案行（household + is_main=1） */
  findMainProfileRow(householdId: string): ProfileRow | undefined;
  findHouseholdMainProfileVersion(householdId: string): { mainProfileVersion: number } | undefined;

  // —— 账号密码改动（changeAccountPassword 事务块）——
  findAccountCredentialRow(householdId: string, accountId: string): AccountCredentialRow | undefined;
  /** 该账号在家庭的全部会话（含 activeProfileId；身份失效分组读路径） */
  listAccountSessions(accountId: string, householdId: string): Array<{ id: string; householdId: string; activeProfileId: string | null }>;
  /** 整体撤销该账号未撤销会话（revokedAt 由调用方计算，时序与迁移前一致） */
  revokeAccountSessions(accountId: string, householdId: string, revokedAt: string): void;
  updateAccountCredentials(householdId: string, accountId: string, patch: { passwordHash: string; credentialVersion: number }): void;

  // —— 通用设置（household GET/PATCH）——
  findHouseholdRow(householdId: string): HouseholdRow | undefined;
  updateHouseholdRow(id: string, patch: HouseholdRowPatch): void;

  // —— 设置 PIN 验证（verifyAndIssueSettingsAccess 快照捕获与事务内重读/写入）——
  findMainProfilePinRow(householdId: string): MainProfilePinRow | undefined;
  findSessionActiveProfileId(householdId: string, sessionId: string): { activeProfileId: string | null } | undefined;
  findSessionContextVersion(householdId: string, sessionId: string): { profileContextVersion: number } | undefined;
  findSessionActiveProfileWithContext(
    householdId: string,
    sessionId: string,
  ): { activeProfileId: string | null; profileContextVersion: number } | undefined;
  findAccountCredentialVersion(householdId: string, accountId: string): { credentialVersion: number } | undefined;
  /** PIN 失败计数/锁定窗口写入（set(state)；state 为 registerPinFailure/PIN_STATE_CLEARED 输出） */
  updateProfilePinState(householdId: string, profileId: string, state: ProfilePinStatePatch): void;

  // —— 档案管理（profiles 创建/编辑/停用/主档案转移事务块）——
  /** 归属精确匹配读（id + household + account；404 同形判定留 application） */
  findProfileOfHousehold(householdId: string, accountId: string, profileId: string): ProfileRow | undefined;
  /** 单行重读（编辑后投影；行缺失判定留 application） */
  findProfileRow(profileId: string): ProfileRow | undefined;
  /** 家庭内本账号全部档案（管理列表白名单投影读路径） */
  listManagedProfileRows(householdId: string, accountId: string): ProfileRow[];
  /** 家庭内全部可用档案的默认标记（swapDefault 互换读路径） */
  listActiveProfileDefaultFlags(householdId: string): Array<{ id: string; isDefault: number }>;
  /** 单行清默认（差量互换写路径；目标行由调用方的 insert/patch 写入） */
  clearProfileDefault(profileId: string): void;
  insertProfile(row: ProfileInsert): void;
  insertProfilePolicy(values: ProfilePolicyInsert): void;
  /** 除目标外可用档案 id（「不能停用最后一个可用档案」判定读路径） */
  listOtherActiveProfileIds(householdId: string, excludeProfileId: string): Array<{ id: string }>;
  updateProfileRow(profileId: string, patch: ProfileRowPatch): void;
  /** 使用指定档案的会话 id（身份失效级联读路径） */
  listSessionIdsUsingProfile(householdId: string, profileId: string): Array<{ id: string }>;
  /** 本账号在家庭的全部档案 id（提交后撤销内存选档授予的读路径） */
  listAccountProfileIds(householdId: string, accountId: string): Array<{ id: string }>;

  // —— 设备播放记录（(time,id) 倒序 keyset；游标谓词逐字迁移，limit+1 形态不变）——
  listPlaybackSessionRows(householdId: string, deviceId: string, cursor: RecordCursor | undefined, limit: number): PlaybackSessionRow[];
  listPlaybackFailureRows(householdId: string, deviceId: string, cursor: RecordCursor | undefined, limit: number): PlaybackFailureEventRow[];
}

/** settings 上下文仓储端口（读路径 + 事务入口 + 存储就绪门禁） */
export interface SettingsStore extends SettingsTxStore {
  /**
   * 事务入口：省略 behavior 与迁移前 `getDb().transaction(fn)`（deferred）一致；
   * 'immediate' 与迁移前 `{ behavior: 'immediate' }`（管理写路径短事务）一致。
   * 回调第二参 handle 为不透明连接凭证，仅供 clearDeviceSessionsProfile 等
   * profile 上下文 identity-transition 挂钩加入同一物理事务（profile 端口先例）。
   */
  withTransaction<T>(fn: (tx: SettingsTxStore, handle: Db) => T, behavior?: 'immediate'): T;
  /** 存储就绪门禁（Database.isReady 同一门禁；启动撤销 fail-closed 判定） */
  isReady(): boolean;
}

/**
 * seam 槽（ADR-0015 D1）：未绑定即调用为编程错误（显式失败，不静默空转）；
 * 重复绑定幂等覆盖（测试 rig 在 Database 单例重开后重建需要）。
 */
let boundStore: SettingsStore | null = null;

export function bindSettingsStore(store: SettingsStore): void {
  boundStore = store;
}

export function settingsStore(): SettingsStore {
  if (boundStore === null) {
    throw new Error(
      'SETTINGS_STORE 未绑定：settings 仓储端口需在模块装配（settings.module.ts）或测试 rig 中经 bindSettingsStore 绑定（ADR-0015 D1 / 规格 008 FR-004）',
    );
  }
  return boundStore;
}
