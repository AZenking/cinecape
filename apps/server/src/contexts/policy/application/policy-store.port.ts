/**
 * policy 仓储端口（008-repository-extraction，ADR-0015 D1）。
 *
 * 应用层数据访问的唯一合法形态：本文件定义纯 TS 端口接口 + 模块级 seam 槽；
 * Drizzle 实现位于 infrastructure/policy-store.drizzle.ts，由 policy.module.ts
 * 装配期绑定（useFactory），单元测试 rig 经 bindPolicyStore 自行绑定。
 *
 * - 行类型经 `import type` 取自 @platform/database/schema（type-only 导入不产生
 *   依赖边，schema 保持单一事实源；depcruise 与 audit:purity 均放行）；
 * - 事务经 withTransaction 端口形态表达，事务句柄（tx）不越出 infrastructure；
 * - 方法签名与实现逐字对应既有查询（008 FR-002：SQL 构造与谓词逐字迁移）。
 */
import type {
  device,
  deviceSession,
  profile,
  profilePolicy,
} from '@platform/database/schema';

export type DeviceRow = typeof device.$inferSelect;
export type SessionRow = typeof deviceSession.$inferSelect;
export type ProfileRow = typeof profile.$inferSelect;
export type PolicyRow = typeof profilePolicy.$inferSelect;

/** 家庭候选媒体投影列（loadBatchCatalogContext 装载形态，列集与迁移前一致） */
export interface HouseholdMediaCandidateRow {
  id: string;
  type: string;
  title: string;
  description: string | null;
  contentLevel: number | null;
  version: number;
}

/** 事务作用域内的策略表操作（writePolicyLists / updatePolicy 的事务块形态） */
export interface PolicyTxStore {
  findPolicy(householdId: string, profileId: string): PolicyRow | undefined;
  /** 整体替换可编辑配置/名单（.set(patch)；patch 键集与迁移前各调用点一致） */
  updatePolicyRow(householdId: string, profileId: string, patch: Record<string, string | number>): void;
  /** 分块 IN 查询（500/批，逐字迁移自 assertListsReferenceHouseholdMedia） */
  findMediaTypesByIds(householdId: string, ids: readonly string[]): Array<{ id: string; type: string }>;
}

/** policy 上下文仓储端口（读路径 + 事务入口） */
export interface PolicyStore extends PolicyTxStore {
  findDeviceSession(sessionId: string): SessionRow | undefined;
  findDevice(deviceId: string): DeviceRow | undefined;
  findProfile(profileId: string): ProfileRow | undefined;
  findPolicy(householdId: string, profileId: string): PolicyRow | undefined;
  listHouseholdMediaRows(householdId: string): HouseholdMediaCandidateRow[];
  /** 「present × 启用来源 × 播放资源」可用 media_id 集合（与 resource-reader EXISTS 链等价，逐字迁移） */
  loadAvailableMediaIdSet(householdId: string): Set<string>;
  withTransaction<T>(fn: (tx: PolicyTxStore) => T): T;
}

/**
 * seam 槽（ADR-0015 D1）：未绑定即调用为编程错误（显式失败，不静默空转）；
 * 重复绑定幂等覆盖（测试 rig 在 Database 单例重开后重建需要）。
 */
let boundStore: PolicyStore | null = null;

export function bindPolicyStore(store: PolicyStore): void {
  boundStore = store;
}

export function policyStore(): PolicyStore {
  if (boundStore === null) {
    throw new Error(
      'POLICY_STORE 未绑定：policy 仓储端口需在模块装配（policy.module.ts）或测试 rig 中经 bindPolicyStore 绑定（ADR-0015 D1 / 规格 008 FR-004）',
    );
  }
  return boundStore;
}
