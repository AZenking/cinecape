import { and, eq } from 'drizzle-orm';
import { ProblemCode } from '@hmp/shared';
import { deviceSession, profile } from '../../database/schema';
import { DomainError, createDomainError } from '../../common/domain-error';
import type { SessionContext } from '../../common/current-session.decorator';
import { env } from '../../config/env';
import { getDb, type Db } from '../auth/db';
import { verifyPassword } from '../auth/password.service';
import { verifyParentPassword } from '../auth/parent-verification.service';
import {
  buildAccountSession,
  toProfileSummary,
  type AccountSessionBody,
  type ProfileSummaryBody,
} from '../auth/account-session.dto';
import { switchDeviceSessionProfile } from './identity-transition';
import {
  PIN_STATE_CLEARED,
  consumeUnlockGrant,
  grantUnlock,
  hasUnlockGrant,
  isPinLocked,
  registerPinFailure,
} from './pin.service';
import { requireOwnedProfile } from './profile.service';

/**
 * 最小选档接口(T038,005 contracts/api.md §3 + data-model §2):
 * - GET /profiles:登录会话的选档摘要(ProfileSummary 白名单投影;禁用可见但不可选;
 *   不含策略/锁定计数/失败日志);
 * - POST /profiles/{id}/unlock:{pin} 签一次性选档授予;与设置验证共享原 profile
 *   持久失败计数(profile.failed_pin_count/pin_locked_until 列,跨刷新/新会话/重启
 *   保留),连续 5 次错误锁 5 分钟 → 423 PROFILE_PIN_LOCKED;哈希比对在事务外,
 *   提交前重验 pin_version/profile_context_version 快照;
 * - POST /profiles/{id}/select:受 PIN 保护须先 unlock;实际换档同事务递增
 *   device_session.profile_context_version、撤销设置授予、终态化旧上下文活动播放
 *   并撤票(identity-transition);选同一仍有效档案不递增版本、不恢复过期授予;
 *   身份只从服务端会话推导,携带身份声明字段的请求体在管道层即被 400 拒绝。
 */

/** GET /profiles:当前家庭全部档案的选档摘要(禁用状态可见) */
export function listSelectableProfiles(householdId: string): ProfileSummaryBody[] {
  return getDb()
    .select()
    .from(profile)
    .where(eq(profile.householdId, householdId)) // 显式 household 边界(FR-006)
    .all()
    .map(toProfileSummary);
}

function pinLockedError(): DomainError {
  // 不泄露解锁剩余时间:仅状态码 + 稳定 code
  return new DomainError(423, ProblemCode.PROFILE_PIN_LOCKED, 'PIN 已锁定,请稍后重试');
}

/** 设备会话当前身份上下文版本;会话行缺失(理论不可达)按未认证同形拒绝 */
function contextVersionOf(db: Db, sessionId: string): number {
  const row = db
    .select({ profileContextVersion: deviceSession.profileContextVersion })
    .from(deviceSession)
    .where(eq(deviceSession.id, sessionId))
    .get();
  if (row === undefined) {
    throw new DomainError(401, ProblemCode.SESSION_INVALID, undefined);
  }
  return row.profileContextVersion;
}

/**
 * POST /profiles/{profileId}/unlock(选档 PIN 验证):
 * 未设 PIN 403 → 锁定中 423(即使 PIN 正确)→ 哈希比对(事务外)→
 * BEGIN IMMEDIATE 短事务重验 pin_version/profile_context_version 快照后
 * 记失败(403,仅剩余次数)/清零并签发一次性选档授予(200)。
 */
export async function unlockSelectionPin(
  context: SessionContext,
  profileId: string,
  pin: string,
): Promise<{ unlocked: true }> {
  const row = requireOwnedProfile(profileId, context); // 不存在/跨家庭统一 404
  if (row.pinHash === null) {
    throw new DomainError(403, ProblemCode.FORBIDDEN, '该 Profile 未设置 PIN,无需解锁');
  }
  const now = new Date();
  if (isPinLocked(row.pinLockedUntil, now)) {
    throw pinLockedError();
  }
  const expectedPinVersion = row.pinVersion;
  const expectedContextVersion = contextVersionOf(getDb(), context.session.id);

  // argon2 比对在事务外(短事务;坏哈希按失败处理,不抛底层异常)
  const pinMatches = await verifyPassword(row.pinHash, pin).catch(() => false);

  // 事务返回结果、提交后再抛领域错误:失败计数/锁定的写入必须随事务提交,
  // 不能因 throw 回滚而丢失(与 parent-verification.service 同模式)
  const outcome = getDb().transaction(
    (tx): { kind: 'locked' } | { kind: 'versionConflict' } | { kind: 'failed'; remaining: number } | { kind: 'ok' } => {
      // 提交前重读快照:PIN 或身份上下文在验证期间变化 → 拒绝(不签基于旧身份的授予)
      const fresh = tx
        .select()
        .from(profile)
        .where(
          and(
            eq(profile.id, row.id),
            eq(profile.householdId, context.session.householdId),
            eq(profile.accountId, context.session.accountId),
          ),
        )
        .get();
      if (fresh === undefined) {
        throw new DomainError(404, ProblemCode.NOT_FOUND);
      }
      if (fresh.pinVersion !== expectedPinVersion || contextVersionOf(tx, context.session.id) !== expectedContextVersion) {
        return { kind: 'versionConflict' };
      }
      if (isPinLocked(fresh.pinLockedUntil, now)) {
        return { kind: 'locked' };
      }
      if (!pinMatches) {
        const next = registerPinFailure(
          { failedPinCount: fresh.failedPinCount, pinLockedUntil: fresh.pinLockedUntil },
          now,
          env.PIN_MAX_ATTEMPTS,
          env.PIN_LOCK_MINUTES,
        );
        tx.update(profile).set(next).where(eq(profile.id, fresh.id)).run();
        // detail 仅含剩余次数,不回显 PIN(与既有 profile-protection 契约一致)
        return { kind: 'failed', remaining: Math.max(0, env.PIN_MAX_ATTEMPTS - next.failedPinCount) };
      }
      // 成功:清持久失败计数与锁定窗口(选档授予在事务提交后签发)
      tx.update(profile).set(PIN_STATE_CLEARED).where(eq(profile.id, fresh.id)).run();
      return { kind: 'ok' };
    },
    { behavior: 'immediate' },
  );

  if (outcome.kind === 'locked') {
    throw pinLockedError();
  }
  if (outcome.kind === 'versionConflict') {
    // PIN/身份上下文在验证期间变化:拒绝,不签发基于旧身份的授予
    throw createDomainError('VERSION_CONFLICT');
  }
  if (outcome.kind === 'failed') {
    throw new DomainError(403, ProblemCode.FORBIDDEN, `PIN 验证失败,剩余尝试次数:${outcome.remaining}`);
  }
  grantUnlock(context.session.id, row.id);
  return { unlocked: true };
}

/**
 * POST /profiles/{profileId}/select(选择当前观看者):
 * 404(归属)→ 403 PROFILE_NOT_SELECTABLE(已停用)→ 403 PROFILE_PIN_REQUIRED
 * (受 PIN 保护未解锁)→ 403 PARENT_VERIFICATION_*(无 PIN 成人 + 家庭含儿童,
 * 现有成人切换验证规则继续有效,FR-008)→ 实际换档事务(递增 contextVersion、
 * 撤销设置授予、终态化旧上下文活动播放并撤票)→ 200 AccountSession(SessionDto)。
 */
export async function selectActiveProfile(
  context: SessionContext,
  profileId: string,
  ownerPassword?: string,
): Promise<AccountSessionBody> {
  const row = requireOwnedProfile(profileId, context);
  if (row.status === 'disabled') {
    throw new DomainError(403, ProblemCode.PROFILE_NOT_SELECTABLE, '该 Profile 已停用,无法选择');
  }
  const pinProtected = row.pinHash !== null;
  if (pinProtected && !hasUnlockGrant(context.session.id, row.id)) {
    throw new DomainError(403, ProblemCode.PROFILE_PIN_REQUIRED, '该 Profile 受 PIN 保护,请先解锁');
  }
  if (!pinProtected && row.type === 'adult' && householdHasChildProfile(row.householdId)) {
    if (ownerPassword === undefined || ownerPassword === '') {
      throw new DomainError(
        403,
        ProblemCode.PARENT_VERIFICATION_REQUIRED,
        '家庭存在儿童档案,选择未设 PIN 的成人需家长验证',
      );
    }
    await verifyParentPassword(context, ownerPassword);
  }

  getDb().transaction(
    (tx) => {
      // 实际换档判定以事务内重读的服务端会话为准(上下文快照可能过期)
      const sessionRow = tx
        .select({ activeProfileId: deviceSession.activeProfileId })
        .from(deviceSession)
        .where(and(eq(deviceSession.householdId, row.householdId), eq(deviceSession.id, context.session.id)))
        .get();
      if (sessionRow === undefined) {
        throw new DomainError(401, ProblemCode.SESSION_INVALID, undefined);
      }
      const from = sessionRow.activeProfileId;
      if (from === row.id) {
        // 选同一仍有效档案:不递增版本、不恢复/不新建任何设置授予(仅消费一次性选档授予)
        consumeUnlockGrant(context.session.id, row.id);
        return;
      }
      // 实际换档:同事务递增 profile_context_version、撤销设置授予、终态化旧上下文活动播放并撤票
      switchDeviceSessionProfile(tx, {
        householdId: row.householdId,
        sessionId: context.session.id,
        fromProfileId: from,
        toProfileId: row.id,
      });
      consumeUnlockGrant(context.session.id, row.id);
    },
    { behavior: 'immediate' },
  );

  return buildAccountSession({
    sessionId: context.session.id,
    account: context.account,
    expiresAt: context.session.expiresAt,
  });
}

/** 家庭是否存在任一儿童档案(含停用;无 PIN 成人切换保护,FR-008 既有规则) */
export function householdHasChildProfile(householdId: string): boolean {
  const row = getDb()
    .select({ id: profile.id })
    .from(profile)
    .where(and(eq(profile.householdId, householdId), eq(profile.type, 'child')))
    .limit(1)
    .get();
  return row !== undefined;
}
