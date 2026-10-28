import { and, eq } from 'drizzle-orm';
import { ProblemCode } from '@hmp/shared';
import { account, deviceSession, profile, profilePolicy, profileProgressClock } from '@platform/database/schema';
import { DomainError, createDomainError } from '@platform/http-common/domain-error';
import type { SessionContext } from '@platform/http-common/current-session.decorator';
import { defaultPolicyValues } from '@contexts/policy/domain/policy.rules';
import { getDb, type Db } from '@contexts/identity-access/infrastructure/db';
import { hashPassword } from '@contexts/identity-access/infrastructure/password.service';
import { verifyParentPassword } from '@contexts/identity-access/application/parent-verification.service';
import { clearDeviceSessionsProfile } from '@contexts/profile/application/identity-transition';
import { revokeUnlockGrantsForProfile } from '@contexts/profile/application/pin.service';
import { toProfileSummary, type ProfileSummaryBody } from '@contexts/identity-access/interface/account-session.dto';

/**
 * 首建与 PIN 恢复(T037,005 FR-030 + ADR-0011 决议 2/6 + research R2/R5):
 * - 两个「窄用途」入口:除首建主档案与重设主档案 PIN 外不开放任何一般设置数据,
 *   不签 settings grant、不返回管理主体、不自动选档;
 * - 授权次序(api.md §7):Session → 管理角色 → 严格必填(缺 ownerPassword=400)→
 *   密码验证(错误 403、锁定 423,沿用既有持久错误计数)→ 哈希在事务外 →
 *   BEGIN IMMEDIATE 短事务提交前重读 credential_version 与零档案/主档案快照;
 * - 首建在零档案短事务内创建唯一成人主 Profile(is_main=1 满足 CHECK),写 6 位
 *   PIN 哈希、pin_version、默认内容策略与 progress clock,不设置 active_profile_id;
 * - 已有档案 409 BOOTSTRAP_ALREADY_DONE 不改写现值;
 * - PIN 恢复仅重设当前家庭主档案 PIN:清锁定与失败计数、递增 pin_version、
 *   撤销目标档案选档/设置授予、清空当前选用该档案的 active_profile_id 并递增其
 *   contextVersion、终态化相关活动播放并撤票(强制重新选档)。
 */

/** 目标必须为管理角色(owner/admin);非管理 403 FORBIDDEN(不区分具体角色细节) */
export function requireManagementRole(context: SessionContext): void {
  if (context.account.role !== 'owner' && context.account.role !== 'admin') {
    throw new DomainError(403, ProblemCode.FORBIDDEN, '仅账号管理员可执行该操作');
  }
}

function credentialVersionOf(db: Db, householdId: string, accountId: string): number {
  const row = db
    .select({ credentialVersion: account.credentialVersion })
    .from(account)
    .where(and(eq(account.householdId, householdId), eq(account.id, accountId)))
    .get();
  if (row === undefined) {
    // 会话与账号行不一致(理论不可达,Guard 已校验)→ 按会话失效拒绝
    throw new DomainError(401, ProblemCode.SESSION_INVALID, undefined);
  }
  return row.credentialVersion;
}

function readCredentialVersion(context: SessionContext): number {
  return credentialVersionOf(getDb(), context.session.householdId, context.account.id);
}

function householdProfileCount(householdId: string): number {
  return getDb()
    .select({ id: profile.id })
    .from(profile)
    .where(eq(profile.householdId, householdId))
    .all().length;
}

function readMainProfileRow(
  db: Db,
  householdId: string,
): { id: string; pinVersion: number; version: number } | null {
  const row = db
    .select({ id: profile.id, pinVersion: profile.pinVersion, version: profile.version })
    .from(profile)
    .where(and(eq(profile.householdId, householdId), eq(profile.isMain, 1)))
    .get();
  return row ?? null;
}

/** 首建事务体(密码验证与 PIN 哈希已在事务外完成):提交前重读快照再写入 */
function insertMainProfileTx(
  tx: Db,
  input: {
    householdId: string;
    accountId: string;
    name: string;
    pinHash: string;
    expectedCredentialVersion: number;
  },
): ProfileSummaryBody {
  // 提交前重读零档案状态与 credential_version(异步哈希期间可能并发变化)
  if (householdProfileCountTx(tx, input.householdId) > 0) {
    throw createDomainError('BOOTSTRAP_ALREADY_DONE');
  }
  const credentialVersion = credentialVersionOf(tx, input.householdId, input.accountId);
  if (credentialVersion !== input.expectedCredentialVersion) {
    throw createDomainError('VERSION_CONFLICT');
  }
  const now = new Date().toISOString();
  const row = {
    id: crypto.randomUUID(),
    householdId: input.householdId,
    accountId: input.accountId,
    name: input.name,
    avatar: null,
    type: 'adult' as const,
    // 首个档案即为默认观看偏好(is_default 与 is_main 无权限等价关系,仅观看偏好)
    isDefault: 1,
    pinHash: input.pinHash,
    status: 'active' as const,
    failedPinCount: 0,
    pinLockedUntil: null,
    isMain: 1,
    pinVersion: 1,
    version: 1,
    createdAt: now,
  };
  tx.insert(profile).values(row).run();
  // 默认内容策略(成人 18/true,空名单)同事务
  const defaults = defaultPolicyValues('adult');
  tx
    .insert(profilePolicy)
    .values({
      householdId: input.householdId,
      profileId: row.id,
      maxContentLevel: defaults.maxContentLevel,
      allowUnrated: defaults.allowUnrated ? 1 : 0,
      allowedMediaIds: '[]',
      blockedMediaIds: '[]',
      allowedChannelIds: '[]',
      version: 1,
      updatedAt: now,
    })
    .run();
  // progress clock 同事务初始化(next_epoch=1;可跳号不可重置)
  tx
    .insert(profileProgressClock)
    .values({ householdId: input.householdId, profileId: row.id, nextEpoch: 1 })
    .run();
  // 不设置任何 device_session.active_profile_id —— 不自动选档
  return toProfileSummary(row);
}

function householdProfileCountTx(tx: Db, householdId: string): number {
  return tx.select({ id: profile.id }).from(profile).where(eq(profile.householdId, householdId)).all().length;
}

/**
 * POST /auth/bootstrap-profile(零档案首建)。
 * 顺序:管理角色 → 零档案预检(409,避免白烧密码计数)→ 密码验证(403/423,
 * 沿用既有持久错误计数与锁定)→ PIN 哈希(事务外)→ BEGIN IMMEDIATE 短事务
 * (重读零档案 + credential_version)→ 创建唯一成人主 Profile(不自动激活)。
 */
export async function bootstrapMainProfile(
  context: SessionContext,
  input: { name: string; pin: string; ownerPassword: string },
): Promise<ProfileSummaryBody> {
  requireManagementRole(context);
  const householdId = context.session.householdId;
  if (householdProfileCount(householdId) > 0) {
    throw createDomainError('BOOTSTRAP_ALREADY_DONE');
  }
  // 当次 owner 密码逐次验证(错误计数/锁定持久化在 parent_verification_state)
  await verifyParentPassword(context, input.ownerPassword);

  const pinHash = await hashPassword(input.pin); // 事务外哈希
  const expectedCredentialVersion = readCredentialVersion(context);

  return getDb().transaction(
    (tx) =>
      insertMainProfileTx(tx, {
        householdId,
        accountId: context.account.id,
        name: input.name,
        pinHash,
        expectedCredentialVersion,
      }),
    { behavior: 'immediate' },
  );
}

/**
 * POST /auth/main-profile/pin-recovery(窄用途 PIN 恢复,ADR-0011 决议 6)。
 * 仅重设当前家庭主档案 PIN(目标由服务端确定,不接受 profileId);成功 204 无响应体:
 * 清 PIN 锁定与失败计数、递增 pin_version(旧解锁授予全部失效)、撤销该档案的
 * 选档/设置授予、清空所有选用该档案会话的 active_profile_id 并递增其 contextVersion、
 * 终态化相关活动播放并撤票;不签 settings grant、不返回管理主体。
 */
export async function recoverMainProfilePin(
  context: SessionContext,
  input: { newPin: string; ownerPassword: string },
): Promise<void> {
  requireManagementRole(context);
  const householdId = context.session.householdId;
  const main = readMainProfileRow(getDb(), householdId);
  if (main === null) {
    // 主档案不存在(未首建):目标不存在,同形 404
    throw new DomainError(404, ProblemCode.NOT_FOUND);
  }
  await verifyParentPassword(context, input.ownerPassword);

  const newPinHash = await hashPassword(input.newPin); // 事务外哈希
  const expectedPinVersion = main.pinVersion;
  const expectedCredentialVersion = readCredentialVersion(context);

  getDb().transaction(
    (tx) => {
      // 提交前重读主档案与 credential_version 快照(异步哈希期间可能并发变化)
      const fresh = readMainProfileRow(tx, householdId);
      if (fresh === null) {
        throw new DomainError(404, ProblemCode.NOT_FOUND);
      }
      if (fresh.pinVersion !== expectedPinVersion) {
        throw createDomainError('VERSION_CONFLICT');
      }
      if (readCredentialVersion(context) !== expectedCredentialVersion) {
        throw createDomainError('VERSION_CONFLICT');
      }
      // 重设 PIN:清失败计数与锁定、递增 pin_version 与 version(旧授予全部失效)
      tx.update(profile)
        .set({
          pinHash: newPinHash,
          failedPinCount: 0,
          pinLockedUntil: null,
          pinVersion: fresh.pinVersion + 1,
          version: fresh.version + 1,
        })
        .where(and(eq(profile.householdId, householdId), eq(profile.id, fresh.id)))
        .run();
      // 清空当前选用该档案的全部设备会话身份(强制重新选档,同事务递增各自 contextVersion)
      const sessions = tx
        .select({ id: deviceSession.id })
        .from(deviceSession)
        .where(and(eq(deviceSession.householdId, householdId), eq(deviceSession.activeProfileId, fresh.id)))
        .all();
      clearDeviceSessionsProfile(tx, {
        householdId,
        deviceSessionIds: sessions.map((row) => row.id),
        profileId: fresh.id,
      });
      // 撤销该档案的全部内存选档一次性授予(US7 发现的残留缺口:
      // 恢复后 5min TTL 窗口内旧授予不得再通过选档)
      revokeUnlockGrantsForProfile(fresh.id);
    },
    { behavior: 'immediate' },
  );
}
