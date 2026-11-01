/**
 * 010-online-vod T056 —— 连播偏好 GET/PATCH 应用用例(纯函数模块 + UnitOfWork 结构镜像)。
 *
 * 契约来源(逐字对照,编排顺序即本文件事务内步骤顺序):
 * - contracts/api.md §1 Preferences(autoplayNext/switchCarryPosition/version)+ §3 偏好行:
 *   GET 未有行返回默认 true/true/version=0(传输初值,不偷偷写公共状态);PATCH
 *   {expectedVersion>=0,autoplayNext?,switchCarryPosition?,operationKey:UUID} 至少一偏好,
 *   200 Preferences;CAS 409;成功 key 24h 重放不再更新版本,先重验当前身份;
 * - data-model §5 profile_vod_preferences(每 Profile 唯一;CAS;开关消费过渡时重读;
 *   持久 version>=1 —— version=0 仅是未有行基线,服务端绝不写 0)+ §10 U1
 *   profile_vod_preference_operation(唯一(家庭,device_session,context_version,operation_key);
 *   先查成功 key 并校验原 Profile/context 及 digest,再做 expectedVersion 校验;成功重放
 *   返回原响应不恢复旧偏好不增版本;异 digest 409 IDEMPOTENCY_CONFLICT;失败不占成功 key;
 *   不同 key 并发按 CAS 仅一者成功;expires>=committed+24h;清理过期 operation 不删偏好;
 *   幂等记录不进公共缓存或日志);
 * - contracts/internal-ports.md §5 PreferenceWriteWorkSet:同事务「先成功重放 → 再 CAS →
 *   写偏好及不可变成功响应」,任何一步失败整体回滚(审查补充:偏好 CAS 与 operation 同事务);
 * - api.md §0「个人接口从当前验证 Session 推导,禁止 body/query 的 profileId/householdId」
 *   —— 身份键全部由控制器守卫链推导后传入,本文件不接触任何请求原始载荷。
 *
 * 事务编排(PATCH;全部写一个 commit,网络/缓存一律不在事务内):
 * - 工作集经 UNIT_OF_WORK.run 同步组装(txStores 键 identityAccess/profile/personalData;
 *   结构镜像类型承载,对齐 T029 materialization.service 先例,不深导 platform/database),
 *   任何参与者方法抛错即整体回滚(T008/T016 契约);
 * - ① 事务内身份重验(materialization assertSessionContextValid 同形:撤销/过期 401、
 *   档案漂移 403、跨家庭/不存在 404、停用 403)——「已授权不能替代事务内重验」,
 *   成功 key 重放同样先重验当前身份(api.md §3「先重验当前身份」);
 * - ② 先查成功重放(scope=家庭/DeviceSession/当前 contextVersion/operationKey):命中且
 *   原 Profile/digest 一致 → 原响应原样返回(replayed 语义:不恢复旧偏好、不更新版本、
 *   不续 24h TTL);异 digest → 409 IDEMPOTENCY_CONFLICT;已过 24h 重放窗(未及清理)→
 *   409 IDEMPOTENCY_CONFLICT(不可误当新操作:同 key 重放期已过且唯一键仍占用);
 * - ③ 再 CAS:expectedVersion 失配(version=0=未有行基线)→ 409 VERSION_CONFLICT,
 *   零写入整体回滚(失败不占成功 key);
 * - ④ 偏好写(updatePreferencesWithCas 内联)+ 不可变成功响应记录(recordCommittedOperation)
 *   同一 commit,持久 version>=1,expires=committed+24h;
 * - GET 读取零写入:同 uow 只读工作集,无行返回传输初值 true/true/version=0。
 */
import { createHash, randomUUID } from 'node:crypto';
import { ProblemCode } from '@hmp/shared';
import { DomainError, createDomainError } from '@platform/http-common/domain-error';
import type {
  PreferenceIdentityReader,
  PreferenceIdentitySnapshot,
  PreferenceProfileReader,
  PreferenceTx,
  PreferenceOperationTx,
  VodPreferencesSnapshot,
} from './preference-work-set.port';

/** 偏好幂等操作固定保留期(data-model §10 U1「expires>=committed+24h」;重放不延长) */
export const PREFERENCE_OPERATION_RETENTION_MS = 24 * 60 * 60 * 1000;

/* ------------------------------------------------------------------ */
/* UnitOfWork 结构镜像(不深导 platform/database;对齐 T029 先例)           */
/* ------------------------------------------------------------------ */

/** PreferenceWriteWorkSet 消费的绑定后 txStores(键名与组合根 8 键注册表一致,按需取用) */
export type PreferenceTxBoundStores = {
  readonly credential: { readonly transactionId: string; readonly behavior: 'immediate' };
  readonly identityAccess: PreferenceIdentityReader;
  readonly profile: PreferenceProfileReader;
  readonly personalData: PreferenceTx & PreferenceOperationTx;
};

/** 平台 UnitOfWork.run 的同步返回形态镜像(thenable 压 never;与平台逐字同构) */
export type PreferenceSyncResult<T> = [T] extends [PromiseLike<unknown>] ? never : T;

/**
 * 平台 UnitOfWork 的结构镜像(方法语法 → 参数双向协变;装配面/测试 rig 的
 * UnitOfWork<具体注册表> → 本镜像的编译期结构校验成立,无需断言桥接)。
 */
export interface PreferenceUnitOfWork {
  run<TWorkSet, TResult>(
    workSetFactory: (txStores: PreferenceTxBoundStores) => TWorkSet,
    callback: (workSet: TWorkSet) => TResult,
    options: { readonly behavior: 'immediate'; readonly busyBudgetMs?: number },
  ): PreferenceSyncResult<TResult>;
}

/* ------------------------------------------------------------------ */
/* 输入/依赖束                                                           */
/* ------------------------------------------------------------------ */

/** 调用方上下文(Session/Profile 守卫推导;幂等 scope=家庭/DeviceSession/当前 contextVersion) */
export interface VodPreferencesContext {
  readonly householdId: string;
  readonly deviceSessionId: string;
  readonly profileId: string;
}

/** GET 输入(个人查询键=服务端推导 household+profile;无幂等语义) */
export interface VodPreferencesReadInput {
  readonly householdId: string;
  readonly profileId: string;
}

/** PATCH 命令(至少一偏好字段由控制器严格 zod 保证;null=字段未提交不覆盖) */
export interface VodPreferencesPatchCommand {
  readonly expectedVersion: number;
  readonly autoplayNext: boolean | null;
  readonly switchCarryPosition: boolean | null;
  readonly operationKey: string;
}

/** 依赖注入端口函数束(测试以真实参与者 + FakeClock 装配,对齐 T029 先例) */
export interface VodPreferencesServiceDeps {
  readonly uow: PreferenceUnitOfWork;
  /** 时钟(UTC ISO-8601;测试注入 FakeClock,生产注入系统时钟) */
  readonly nowIso: () => string;
  /** ID 工厂(缺省 randomUUID;测试可注入确定性工厂) */
  readonly generateId?: () => string;
}

/** 生产依赖束(系统时钟;控制器/装配面消费) */
export function systemVodPreferencesDeps(uow: PreferenceUnitOfWork): VodPreferencesServiceDeps {
  return { uow, nowIso: () => new Date().toISOString() };
}

/* ------------------------------------------------------------------ */
/* GET:读取零写入                                                        */
/* ------------------------------------------------------------------ */

/**
 * GET /me/vod/preferences 应用用例(api.md §3:未有行返回默认 true/true/version=0,
 * 不偷偷写公共状态)。授权由控制器守卫链(Session→CurrentProfile)承担;本用例是
 * 纯读工作集(BEGIN IMMEDIATE 内仅 SELECT,COMMIT 无任何写入)。
 */
export function getVodPreferences(uow: PreferenceUnitOfWork, input: VodPreferencesReadInput): VodPreferencesSnapshot {
  return uow.run(
    (tx) => ({ preferences: tx.personalData }),
    (ws) => ws.preferences.findPreferences(input.householdId, input.profileId),
    { behavior: 'immediate' },
  );
}

/* ------------------------------------------------------------------ */
/* PATCH:请求摘要                                                        */
/* ------------------------------------------------------------------ */

/**
 * 命令摘要(同 key 异载荷判 409 的依据;不含 operationKey 本身 —— scope 已含 key,
 * 摘要必须表达「同一 key 下的语义是否相同」)。absent 字段以空位参与,不与 false 混淆。
 */
export function digestVodPreferencesPatch(command: VodPreferencesPatchCommand): string {
  const flag = (value: boolean | null): string => (value === null ? '' : value ? '1' : '0');
  const canonical = `preferences\u0000${command.expectedVersion}\u0000${flag(command.autoplayNext)}\u0000${flag(
    command.switchCarryPosition,
  )}`;
  return createHash('sha256').update(canonical).digest('hex');
}

/* ------------------------------------------------------------------ */
/* PATCH:同事务编排(先成功重放 → 再 CAS → 写偏好及不可变成功响应)          */
/* ------------------------------------------------------------------ */

/** 服务内工作集视图(成员全部来自同一连接绑定的各所有者参与者) */
interface PreferenceWriteWorkSetView {
  readonly identity: PreferenceIdentityReader;
  readonly profileReader: PreferenceProfileReader;
  readonly preferences: PreferenceTx;
  readonly operation: PreferenceOperationTx;
}

/**
 * PATCH /me/vod/preferences 应用用例(api.md §3 / data-model §10 U1)。
 * 返回值即新 Preferences(持久 version>=1)或成功 key 重放的原响应(版本不变)。
 */
export function patchVodPreferences(
  deps: VodPreferencesServiceDeps,
  command: VodPreferencesPatchCommand,
  context: VodPreferencesContext,
): VodPreferencesSnapshot {
  const requestDigest = digestVodPreferencesPatch(command);
  return deps.uow.run(
    (tx) =>
      ({
        identity: tx.identityAccess,
        profileReader: tx.profile,
        preferences: tx.personalData,
        operation: tx.personalData,
      }) satisfies PreferenceWriteWorkSetView,
    (ws) => runPreferenceWriteWorkSet(deps, ws, command, context, requestDigest),
    { behavior: 'immediate' },
  );
}

function runPreferenceWriteWorkSet(
  deps: VodPreferencesServiceDeps,
  ws: PreferenceWriteWorkSetView,
  command: VodPreferencesPatchCommand,
  context: VodPreferencesContext,
  requestDigest: string,
): VodPreferencesSnapshot {
  const nowIso = deps.nowIso();
  const nowMs = Date.parse(nowIso);
  const newId = deps.generateId ?? randomUUID;

  // ── 步骤 1 preferences:revalidate-identity(事务内身份重验;owner=identityAccess)──
  // 撤销/过期 401;档案漂移 403;跨家庭/不存在 404 同形;停用 403(成功 key 重放同此先验)。
  // 幂等 scope 的 context_version 与 operation 行同源:取事务内重验后的当前会话现值
  // (组合根/控制器不传版本 —— 版本是服务端事实,客户端声明一律不接受)。
  const identity = assertIdentityCurrent(ws, context, nowMs);
  const contextVersion = identity.profileContextVersion;

  // ── 步骤 2 preferences:idempotent-replay(先查成功重放;owner=personalData)──
  // scope=(household, device_session, 当前 context_version, operation_key);context 变化后
  // 旧 key 落新 scope,不命中旧结果(旧上下文记忆不跨上下文重放)。
  const committed = ws.operation.findCommittedOperation(
    context.householdId,
    context.deviceSessionId,
    contextVersion,
    command.operationKey,
  );
  if (committed !== undefined) {
    assertCommittedOperationUsable(committed, context, requestDigest, nowMs);
    // 成功重放:原响应原样返回 —— 不恢复旧偏好、不更新偏好版本、不续 24h TTL。
    return replayCommittedSnapshot(committed);
  }

  // ── 步骤 3 preferences:cas-preferences(再 CAS;owner=personalData)──
  // version=0=未有行基线;失配 → 409 VERSION_CONFLICT,零写入整体回滚(失败不占成功 key)。
  const updated = ws.preferences.updatePreferencesWithCas({
    householdId: context.householdId,
    profileId: context.profileId,
    expectedVersion: command.expectedVersion,
    autoplayNext: command.autoplayNext,
    switchCarryPosition: command.switchCarryPosition,
  });
  if (updated === undefined) {
    throw createDomainError('VERSION_CONFLICT');
  }

  // ── 步骤 4 preferences:record-operation(不可变成功响应;owner=personalData)──
  // 与偏好 CAS 同一 commit(审查补充:偏好 CAS 与 operation 同事务);失败分支不落本表。
  ws.operation.recordCommittedOperation({
    id: newId(),
    householdId: context.householdId,
    deviceSessionId: context.deviceSessionId,
    profileId: context.profileId,
    profileContextVersion: contextVersion,
    operationKey: command.operationKey,
    requestDigest,
    resultJson: JSON.stringify(updated),
    committedAt: nowIso,
    // 固定 24h 保留(data-model §10 U1):从提交时刻起算,重放绝不延长。
    expiresAt: new Date(nowMs + PREFERENCE_OPERATION_RETENTION_MS).toISOString(),
  });
  // 步骤 5 preferences:commit = run 边界 COMMIT(平台职责;任何前序失败已整体回滚)。
  return updated;
}

/** 事务内身份/档案重验(materialization 同形;成功 key 重放同样先重验当前身份);返回当前身份快照 */
function assertIdentityCurrent(
  ws: PreferenceWriteWorkSetView,
  context: VodPreferencesContext,
  nowMs: number,
): PreferenceIdentitySnapshot {
  const identity = ws.identity.findDeviceContext(context.deviceSessionId);
  if (identity === undefined || identity.revokedAt !== null || Date.parse(identity.expiresAt) <= nowMs) {
    throw new DomainError(401, ProblemCode.SESSION_INVALID);
  }
  if (identity.profileId !== context.profileId) {
    throw new DomainError(403, ProblemCode.ACTIVE_PROFILE_REQUIRED);
  }
  const profile = ws.profileReader.findProfile(context.householdId, context.profileId);
  if (profile === undefined || profile.householdId !== context.householdId) {
    throw new DomainError(404, ProblemCode.NOT_FOUND);
  }
  if (profile.accountId !== identity.accountId) {
    throw new DomainError(404, ProblemCode.NOT_FOUND);
  }
  if (profile.status !== 'active') {
    throw new DomainError(403, ProblemCode.ACTIVE_PROFILE_REQUIRED);
  }
  return identity;
}

/** 已提交成功操作的可用性:原 Profile/context(scope 已含)/digest/24h 重放窗 */
function assertCommittedOperationUsable(
  committed: { readonly profileId: string; readonly requestDigest: string; readonly expiresAt: string },
  context: VodPreferencesContext,
  requestDigest: string,
  nowMs: number,
): void {
  if (committed.profileId !== context.profileId) {
    // scope 已含 device_session+context_version;仍显式校验原 Profile(U1「校验原 Profile/context」)
    throw new DomainError(403, ProblemCode.ACTIVE_PROFILE_REQUIRED);
  }
  if (committed.requestDigest !== requestDigest) {
    // 同 key 异摘要:恢复语义拒绝,不能把新语义写进旧 key(409 IDEMPOTENCY_CONFLICT)
    throw createDomainError('IDEMPOTENCY_CONFLICT');
  }
  if (Date.parse(committed.expiresAt) <= nowMs) {
    // 24h 重放窗已过(清理未及触达):重放不可用,亦不可误当新操作(唯一键仍占用;
    // 换新 operationKey 即全新操作)。清理过期 operation 不删偏好(data-model §10 U1)。
    throw createDomainError('IDEMPOTENCY_CONFLICT', 'operationKey 已过 24h 重放窗,请换新 operationKey 重试');
  }
}

/** 成功重放的原响应恢复(损坏=内部错误;不冒充当前偏好) */
function replayCommittedSnapshot(committed: { readonly resultJson: string }): VodPreferencesSnapshot {
  let stored: unknown;
  try {
    stored = JSON.parse(committed.resultJson);
  } catch {
    throw new DomainError(500, ProblemCode.INTERNAL, '幂等结果损坏,请重读偏好');
  }
  if (
    typeof stored !== 'object' ||
    stored === null ||
    typeof (stored as VodPreferencesSnapshot).autoplayNext !== 'boolean' ||
    typeof (stored as VodPreferencesSnapshot).switchCarryPosition !== 'boolean' ||
    typeof (stored as VodPreferencesSnapshot).version !== 'number'
  ) {
    throw new DomainError(500, ProblemCode.INTERNAL, '幂等结果损坏,请重读偏好');
  }
  return stored as VodPreferencesSnapshot;
}
