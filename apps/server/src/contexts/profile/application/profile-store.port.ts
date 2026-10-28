/**
 * profile 仓储端口（008-repository-extraction T006，ADR-0015 D1）。
 *
 * 应用层数据访问的唯一合法形态：本文件定义纯 TS 端口接口 + 模块级 seam 槽；
 * Drizzle 实现位于 infrastructure/profile-store.drizzle.ts，由 profile.module.ts
 * 装配期绑定（useFactory），单元测试 rig 经 bindProfileStore 自行绑定。
 *
 * - 行类型经 `import type` 取自 @platform/database/schema（type-only 导入不产生
 *   依赖边，schema 保持单一事实源；depcruise 与 audit:purity 均放行）；
 * - 自有事务经 withTransaction 端口形态表达，事务句柄（tx）不越出 infrastructure；
 * - identity-transition 挂钩（clearDeviceSessionsProfile 等）被 settings /
 *   identity-access 跨上下文在「调用方自己的事务内」消费（签名维持 tx 显式传递，
 *   008 各上下文独立抽取，消费方迁移属其后续任务），故端口另设 txStore(tx)
 *   把调用方事务句柄包装为事务作用域存储 —— 句柄仅作为不透明的连接凭证穿透
 *   application，其上的查询构造全部留在 infrastructure；
 * - 方法签名与实现逐字对应既有查询（008 FR-002：SQL 构造与谓词逐字迁移），
 *   行→DTO 映射（toProfileDto / toProfileSummary）与应用判定逻辑留在 application。
 */
import type { Db } from '@platform/database/drizzle';
import type { profile, profilePolicy } from '@platform/database/schema';
import type { PinFailureState } from './pin.service';

export type ProfileRow = typeof profile.$inferSelect;
export type ProfileInsert = typeof profile.$inferInsert;
export type ProfilePolicyInsert = typeof profilePolicy.$inferInsert;

/** 身份变化终态化输入（finalizePlaybackForIdentityChange / clearDeviceSessionsProfile 形态，与迁移前一致） */
export interface IdentityChangePlaybackInput {
  householdId: string;
  deviceSessionIds: string[];
  profileId: string;
}

/** 撤销设置授予输入（revokeSettingsGrantsForSessions 形态，与迁移前一致） */
export interface RevokeSettingsGrantsInput {
  householdId: string;
  deviceSessionIds: string[];
}

/** 实际换档输入（switchDeviceSessionProfile 形态，与迁移前一致） */
export interface SwitchProfileInput {
  householdId: string;
  sessionId: string;
  fromProfileId: string | null;
  toProfileId: string;
}

/** 事务作用域内的 profile 表操作（unlock/select/create 事务块形态） */
export interface ProfileTxStore {
  /** 归属精确匹配读（id + household + account；requireOwnedProfile 与 unlock 事务内重读共用谓词） */
  findOwnedProfile(profileId: string, householdId: string, accountId: string): ProfileRow | undefined;
  /** 会话身份上下文版本；行缺失返回 undefined（401 判定留 application） */
  findSessionContextVersion(sessionId: string): number | undefined;
  /** 会话当前 active_profile_id；行缺失返回 undefined（401 判定留 application） */
  findSessionActiveProfileId(householdId: string, sessionId: string): string | null | undefined;
  /** PIN 失败计数/锁定窗口写入（set(failedPinCount, pinLockedUntil) 形态，与迁移前一致） */
  updateProfilePinState(profileId: string, state: PinFailureState): void;
  /** 家庭内全部可用档案的默认标记（swapDefault 互换读路径） */
  listActiveProfileDefaultFlags(householdId: string): Array<{ id: string; isDefault: number }>;
  /** 单行清默认（差量互换写路径；目标行由调用方的 insert/patch 写入） */
  clearProfileDefault(profileId: string): void;
  insertProfile(row: ProfileInsert): void;
  insertProfilePolicy(values: ProfilePolicyInsert): void;
  // —— identity-transition 挂钩（自 application/identity-transition.ts 逐字迁移）——
  finalizePlaybackForIdentityChange(input: IdentityChangePlaybackInput): void;
  revokeSettingsGrantsForSessions(input: RevokeSettingsGrantsInput): void;
  switchDeviceSessionProfile(input: SwitchProfileInput): void;
  clearDeviceSessionsProfile(input: IdentityChangePlaybackInput): void;
}

/** profile 上下文仓储端口（读路径 + 事务入口 + 跨上下文事务句柄接合） */
export interface ProfileStore extends ProfileTxStore {
  listProfilesByHousehold(householdId: string): ProfileRow[];
  /** 家庭是否存在任一儿童档案（含停用；无 PIN 成人切换保护判定读路径） */
  householdHasChildProfile(householdId: string): boolean;
  /**
   * 事务入口：省略 behavior 与迁移前 `getDb().transaction(fn)`（deferred）一致；
   * 'immediate' 与迁移前 `{ behavior: 'immediate' }`（unlock/select 短事务）一致。
   */
  withTransaction<T>(fn: (tx: ProfileTxStore) => T, behavior?: 'immediate'): T;
  /** 以调用方事务句柄构造事务作用域存储（跨上下文 identity-transition 挂钩加入调用方事务） */
  txStore(tx: Db): ProfileTxStore;
}

/**
 * seam 槽（ADR-0015 D1）：未绑定即调用为编程错误（显式失败，不静默空转）；
 * 重复绑定幂等覆盖（测试 rig 在 Database 单例重开后重建需要）。
 */
let boundStore: ProfileStore | null = null;

export function bindProfileStore(store: ProfileStore): void {
  boundStore = store;
}

export function profileStore(): ProfileStore {
  if (boundStore === null) {
    throw new Error(
      'PROFILE_STORE 未绑定：profile 仓储端口需在模块装配（profile.module.ts）或测试 rig 中经 bindProfileStore 绑定（ADR-0015 D1 / 规格 008 FR-004）',
    );
  }
  return boundStore;
}
