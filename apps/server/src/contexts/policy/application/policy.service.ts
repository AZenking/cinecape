import { ProblemCode } from '@hmp/shared';
import type { ProfilePolicy } from '@platform/database/schema';
import { DomainError } from '@platform/http-common/domain-error';
import type { SessionContext } from '@platform/http-common/current-session.decorator';
import { verifyParentPassword } from '@contexts/identity-access';
import { requireOwnedProfile } from '@contexts/profile';
import { policyStore } from '@contexts/policy/application/policy-store.port';
import type { PolicyTxStore } from '@contexts/policy/application/policy-store.port';
import {
  assertPolicyRowInvariant,
  evaluatePolicy,
  parseStoredList,
  type MediaPolicyFacts,
  type PolicyDecision,
  type PolicyDecisionReason,
  type PolicyListTriple,
  normalizeMediaIdList,
} from '@contexts/policy/domain/policy.rules';

/**
 * ProfilePolicy 服务(阶段 2,T011):策略查询/整体保存/名单持久化 + 服务端授权入口(T018)。
 *
 * 契约次序(contracts/api.md):身份(SessionGuard)→ 角色(owner,控制器)→ 格式(严格 zod,控制器)
 * → 家长验证(403 REQUIRED / 403 FAILED / 423 LOCKED)→ 目标归属(404 同形)→ 版本(409)→ 事务保存。
 *
 * - 保存为「可编辑配置原子整体替换」(FR-009):三名单由服务端原样保留,不接受请求覆盖/清空;
 * - 每次成功保存 version+1(相同值仍 +1);
 * - 读取时重新解析校验存量名单与数值不变量:损坏一律 503 POLICY_UNAVAILABLE,默认拒绝;
 * - 运行时不自动补建缺失策略(FR-003/FR-008);
 * - writePolicyLists 为服务端名单写入路径:阶段 2 夹具/运维语义保持不变(不带 options);
 *   阶段 3 T051 增加严格模式(expectedVersion 同事务校验 + 每 ID 归属/频道类型校验),
 *   供 replacePolicyLists(PUT /profiles/{id}/policy/lists)使用,两入口共享同一策略版本。
 *
 * 008-repository-extraction:数据访问经 PolicyStore 端口(ADR-0015 D1,查询逐字迁移至
 * infrastructure/policy-store.drizzle.ts;事务经 withTransaction 端口,语义不变)。
 */

/** PolicyDto 响应体(契约 components/schemas/PolicyDto;不返回 householdId/凭据/验证计数) */
export interface PolicyDtoBody {
  profileId: string;
  maxContentLevel: number;
  allowUnrated: boolean;
  allowedMediaIds: string[];
  blockedMediaIds: string[];
  allowedChannelIds: string[];
  version: number;
  updatedAt: string;
}

export interface UpdatePolicyInput {
  ownerPassword?: string;
  expectedVersion: number;
  policy: {
    maxContentLevel: number;
    allowUnrated: boolean;
  };
}

function unavailable(): DomainError {
  return new DomainError(503, ProblemCode.POLICY_UNAVAILABLE, '策略缺失或损坏,已拒绝访问');
}

function rowToDto(row: ProfilePolicy): PolicyDtoBody {
  assertPolicyRowInvariant(row);
  return {
    profileId: row.profileId,
    maxContentLevel: row.maxContentLevel,
    allowUnrated: row.allowUnrated === 1,
    allowedMediaIds: parseStoredList(row.allowedMediaIds, 'allowedMediaIds'),
    blockedMediaIds: parseStoredList(row.blockedMediaIds, 'blockedMediaIds'),
    allowedChannelIds: parseStoredList(row.allowedChannelIds, 'allowedChannelIds'),
    version: row.version,
    updatedAt: row.updatedAt,
  };
}

/** 读取并校验策略行(损坏/缺失 → 503);授权入口与 API 共用 */
export function loadPolicyForRead(householdId: string, profileId: string): PolicyDtoBody {
  const row = policyStore().findPolicy(householdId, profileId);
  if (row === undefined) {
    throw unavailable();
  }
  return rowToDto(row);
}

/** GET /profiles/{id}/policy:目标经归属校验(404 同形),管理目标无须是当前观看者 */
export function getPolicy(profileId: string, context: SessionContext): PolicyDtoBody {
  const target = requireOwnedProfile(profileId, context);
  return loadPolicyForRead(target.householdId, target.id);
}

/**
 * PUT /profiles/{id}/policy:家长验证 → 目标归属 → 版本比较 → 单事务整体替换可编辑配置。
 * 失败路径(验证/版本/损坏)不改变任何策略值。
 */
export async function updatePolicy(profileId: string, context: SessionContext, input: UpdatePolicyInput): Promise<PolicyDtoBody> {
  if (input.ownerPassword === undefined || input.ownerPassword === '') {
    throw new DomainError(403, ProblemCode.PARENT_VERIFICATION_REQUIRED, '需要主账号密码完成家长验证');
  }
  await verifyParentPassword(context, input.ownerPassword);

  const target = requireOwnedProfile(profileId, context);
  return policyStore().withTransaction((tx) => {
    const row = tx.findPolicy(target.householdId, target.id);
    if (row === undefined) {
      throw unavailable();
    }
    rowToDto(row); // 事务内先校验损坏,损坏行不进入保存路径
    if (row.version !== input.expectedVersion) {
      throw new DomainError(409, ProblemCode.POLICY_VERSION_CONFLICT, '策略已被其他会话修改,请重新加载');
    }
    tx.updatePolicyRow(target.householdId, target.id, {
      maxContentLevel: input.policy.maxContentLevel,
      allowUnrated: input.policy.allowUnrated ? 1 : 0,
      version: row.version + 1,
      updatedAt: new Date().toISOString(),
    });
    const fresh = tx.findPolicy(target.householdId, target.id);
    if (fresh === undefined) {
      throw unavailable();
    }
    return rowToDto(fresh);
  });
}

/**
 * writePolicyLists 严格模式选项(T051;省略 = 阶段 2 夹具语义,行为与既有调用完全一致):
 * - expectedVersion:同事务乐观锁,不匹配 → 409 POLICY_VERSION_CONFLICT;
 * - validateResourceOwnership:每个名单 ID 必须是本 Household 真实媒体
 *   (不存在/跨家庭 → 400 VALIDATION_FAILED,整体拒绝且原策略不变),
 *   allowedChannelIds 的每个 ID 还必须 type=channel。
 */
export interface WritePolicyListsOptions {
  expectedVersion?: number;
  validateResourceOwnership?: boolean;
}

/**
 * PUT /profiles/{profileId}/policy/lists 请求体(T049 契约 UpdateLists;
 * 三名单必填数组,整体替换;zod 形态校验在控制器,语义校验在 writePolicyLists 严格模式)。
 */
export interface ReplacePolicyListsInput {
  ownerPassword?: string;
  expectedVersion: number;
  allowedMediaIds: string[];
  blockedMediaIds: string[];
  allowedChannelIds: string[];
}

/**
 * 名单 ID 归属/类型校验(T051):全部 ID 必须存在于本 Household 的 media_item;
 * allowedChannelIds 的每个 ID 还必须 type=channel(缺失同样失败)。
 * 分块 IN 查询经仓储端口(500/批,逐字迁移),任一非法 → 400 VALIDATION_FAILED,
 * 由事务整体回滚保证原策略不变。
 */
function assertListsReferenceHouseholdMedia(
  tx: PolicyTxStore,
  householdId: string,
  allowedMediaIds: string[],
  blockedMediaIds: string[],
  channelIds: string[],
): void {
  const typeById = new Map<string, string>();
  const uniqueIds = [...new Set([...allowedMediaIds, ...blockedMediaIds, ...channelIds])];
  const rows = tx.findMediaTypesByIds(householdId, uniqueIds);
  for (const row of rows) {
    typeById.set(row.id, row.type);
  }
  const missing = uniqueIds.filter((id) => !typeById.has(id));
  if (missing.length > 0) {
    throw new DomainError(400, ProblemCode.VALIDATION_FAILED, `名单引用了本家庭不存在的媒体(共 ${missing.length} 个),整体拒绝`);
  }
  const nonChannel = channelIds.filter((id) => typeById.get(id) !== 'channel');
  if (nonChannel.length > 0) {
    throw new DomainError(400, ProblemCode.VALIDATION_FAILED, `allowedChannelIds 仅接受频道类型媒体(非法 ${nonChannel.length} 个),整体拒绝`);
  }
}

/**
 * 服务端名单写入路径(阶段 2 为夹具/迁移运维入口;阶段 3 T051 扩展严格模式):
 * 应用层校验(非空 1～128、去重、排序、去重后 ≤1000)→ 同事务整体持久化,version+1。
 * 未提供的名单保持原值;允许∩禁止交集保留(不跨名单删除,禁止优先由判定核心负责)。
 * 严格模式(options 携带 expectedVersion/validateResourceOwnership)供 HTTP 名单入口使用,
 * 校验失败(404/409/400)整体回滚,原策略不变。
 */
export function writePolicyLists(
  householdId: string,
  profileId: string,
  lists: Partial<PolicyListTriple>,
  options: WritePolicyListsOptions = {},
): PolicyDtoBody {
  const normalized: Partial<Record<keyof PolicyListTriple, string>> = {
    allowedMediaIds: lists.allowedMediaIds !== undefined ? JSON.stringify(normalizeMediaIdList(lists.allowedMediaIds)) : undefined,
    blockedMediaIds: lists.blockedMediaIds !== undefined ? JSON.stringify(normalizeMediaIdList(lists.blockedMediaIds)) : undefined,
    allowedChannelIds: lists.allowedChannelIds !== undefined ? JSON.stringify(normalizeMediaIdList(lists.allowedChannelIds)) : undefined,
  };

  return policyStore().withTransaction((tx) => {
    const row = tx.findPolicy(householdId, profileId);
    if (row === undefined) {
      throw new DomainError(404, ProblemCode.NOT_FOUND);
    }
    rowToDto(row); // 损坏行拒绝写入路径
    if (options.expectedVersion !== undefined && row.version !== options.expectedVersion) {
      throw new DomainError(409, ProblemCode.POLICY_VERSION_CONFLICT, '策略已被其他会话修改,请重新加载');
    }
    if (options.validateResourceOwnership === true) {
      assertListsReferenceHouseholdMedia(tx, householdId, lists.allowedMediaIds ?? [], lists.blockedMediaIds ?? [], lists.allowedChannelIds ?? []);
    }
    const patch: Record<string, string | number> = { version: row.version + 1, updatedAt: new Date().toISOString() };
    for (const [key, value] of Object.entries(normalized)) {
      if (value !== undefined) {
        patch[key] = value;
      }
    }
    tx.updatePolicyRow(householdId, profileId, patch);
    const fresh = tx.findPolicy(householdId, profileId);
    if (fresh === undefined) {
      throw unavailable();
    }
    return rowToDto(fresh);
  });
}

/**
 * PUT /profiles/{profileId}/policy/lists(T051;US3 名单事务 HTTP 入口,T063 过渡期由
 * catalog 模块控制器调用):家长验证(缺失/空串 403 REQUIRED;错误 403 FAILED;锁定 423)
 * → 会话/设备重验(401)→ Profile 归属 Household+Account(404 同形,与是否 active 无关)
 * → 严格名单事务(expectedVersion 409 / 每 ID 归属与频道类型 400,整体成功或失败)。
 * 与既有等级入口 updatePolicy 共享同一策略 version(每次成功保存 +1)。
 */
export async function replacePolicyLists(
  profileId: string,
  context: SessionContext,
  input: ReplacePolicyListsInput,
): Promise<PolicyDtoBody> {
  if (input.ownerPassword === undefined || input.ownerPassword === '') {
    throw new DomainError(403, ProblemCode.PARENT_VERIFICATION_REQUIRED, '需要主账号密码完成家长验证');
  }
  await verifyParentPassword(context, input.ownerPassword);
  const sessionRow = policyStore().findDeviceSession(context.session.id);
  if (sessionRow === undefined || sessionRow.revokedAt !== null || !(Date.parse(sessionRow.expiresAt) > Date.now())) {
    throw new DomainError(401, ProblemCode.SESSION_INVALID, undefined);
  }
  const target = requireOwnedProfile(profileId, context);
  return writePolicyLists(
    target.householdId,
    target.id,
    {
      allowedMediaIds: input.allowedMediaIds,
      blockedMediaIds: input.blockedMediaIds,
      allowedChannelIds: input.allowedChannelIds,
    },
    { expectedVersion: input.expectedVersion, validateResourceOwnership: true },
  );
}

// ---------------------------------------------------------------------------
// 服务端授权入口(US2/T018,FR-005/006/007;不经 HTTP 暴露)
// ---------------------------------------------------------------------------

/**
 * 可信资源读取器:由服务端目录适配器提供(阶段 2 仅测试夹具;阶段 3 接真实目录)。
 * 必须以会话 Household 为查询键;资源不存在或不属该家庭 → null(与不存在统一不可区分)。
 */
export type TrustedResourceReader = (
  householdId: string,
  mediaId: string,
) => MediaPolicyFacts | null | Promise<MediaPolicyFacts | null>;

export type AuthorizationReason = PolicyDecisionReason | 'ACTIVE_PROFILE_REQUIRED';

/**
 * 对当前观看者授权一次媒体访问(内部契约,禁止注册为生产路由):
 * 1. 重新确认会话仍有效(撤销/过期竞态下不得放行);
 * 2. activeProfile 必须存在、归属会话家庭+账号且可用(否则拒绝,不回落成人策略);
 * 3. 资源事实仅经按会话 Household 查询的可信 reader 获取,客户端不提供任何事实;
 * 4. 每次授权从数据库读取最新策略(不缓存;修改后下一次授权即生效,FR-007);
 * 5. 委托纯判定核心 evaluatePolicy;损坏策略行归一为 POLICY_UNAVAILABLE 拒绝。
 */
export async function authorizeCurrentProfile(
  context: SessionContext,
  mediaId: string,
  readTrustedResource: TrustedResourceReader,
): Promise<{ allowed: boolean; reason: AuthorizationReason }> {
  const store = policyStore();
  const now = Date.now();

  // 1) 会话重验:行存在、未撤销、未过期
  const sessionRow = store.findDeviceSession(context.session.id);
  if (
    sessionRow === undefined ||
    sessionRow.revokedAt !== null ||
    !(Date.parse(sessionRow.expiresAt) > now)
  ) {
    return { allowed: false, reason: 'ACTIVE_PROFILE_REQUIRED' };
  }

  // 2) 当前观看者可用且归属一致(以会话行为准,不信任上下文快照中的 activeProfileId)
  const activeProfileId = sessionRow.activeProfileId;
  if (activeProfileId === null) {
    return { allowed: false, reason: 'ACTIVE_PROFILE_REQUIRED' };
  }
  const activeProfileRow = store.findProfile(activeProfileId);
  if (
    activeProfileRow === undefined ||
    activeProfileRow.householdId !== sessionRow.householdId ||
    activeProfileRow.accountId !== sessionRow.accountId ||
    activeProfileRow.status !== 'active'
  ) {
    return { allowed: false, reason: 'ACTIVE_PROFILE_REQUIRED' };
  }

  // 3) 可信资源事实(查询键 = 会话家庭;跨家庭/不存在 → 统一不可区分)
  const facts = await readTrustedResource(sessionRow.householdId, mediaId);
  if (facts === null || facts.householdId !== sessionRow.householdId) {
    return { allowed: false, reason: 'RESOURCE_UNAVAILABLE' };
  }

  // 4) 最新策略(损坏 → null → 判定核心按 POLICY_UNAVAILABLE 拒绝)
  let judgment: Parameters<typeof evaluatePolicy>[0] = null;
  const policyRow = store.findPolicy(sessionRow.householdId, activeProfileId);
  if (policyRow !== undefined) {
    try {
      judgment = rowToDto(policyRow);
    } catch {
      judgment = null; // 损坏行不进入判定,交由核心按 POLICY_UNAVAILABLE 拒绝
    }
  }

  // 5) 纯判定
  const decision: PolicyDecision = evaluatePolicy(
    judgment,
    activeProfileRow.type as 'adult' | 'child',
    facts,
  );
  return decision;
}
