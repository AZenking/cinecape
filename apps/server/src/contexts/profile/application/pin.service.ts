import { eq } from 'drizzle-orm';
import { ProblemCode } from '@hmp/shared';
import { env } from '../../../config/env';
import type { Profile } from '../../../database/schema';
import { profile } from '../../../database/schema';
import { DomainError } from '../../../common/domain-error';
import { getDb } from '../../../modules/auth/db';
import { verifyPassword } from '../../../modules/auth/password.service';

/**
 * PIN 服务(T027/FR-015)。三部分:
 *
 * 1. 状态机纯函数(isPinLocked / registerPinFailure / PIN_STATE_CLEARED)——
 *    依据 data-model.md:「failed_pin_count < 上限 → 验证;失败 +1;达到上限 →
 *    pin_locked_until = now + PIN_LOCK_MINUTES;锁定窗口内一律拒绝;窗口过后允许
 *    重试,成功即清零」。因此第 N(=上限)次错误本身仍参与验证并返回 403,
 *    其后的窗口内尝试(即使 PIN 正确)一律 423 —— 锁定针对「达到上限后的再次尝试」;
 *    窗口过期后的下一次失败把计数重置为 1(窗口过期重置,不叠加旧计数)。
 *
 * 2. 内存解锁授予表 —— US2 关键设计:契约 POST /profiles/{id}/select 无请求体,
 *    无法在 select 时携带 PIN;改为 unlock 成功后签发短时「解锁授予」,
 *    select 校验「无 PIN 档案」或「存在有效授予」,授予在 select 成功后消费。
 *    权衡(ADR-0002 单实例部署前提):
 *    - 仅存进程内存:重启即失效 → 安全侧失败(需重新解锁),无持久化成本;
 *    - 多实例部署不共享 → 本项目不成立该部署形态(ADR-0002),届时需外置存储;
 *    - TTL 5 分钟;按 (sessionId, profileId) 绑定 —— 比按 profileId 更收紧:
 *      A 设备解锁不等于 B 设备解锁,PIN 是「当前会话对档案」的解锁凭证;
 *    - 一次性消费:切换走再切回需重新解锁,防止授予被长期挂起的会话复用。
 *
 * 3. unlockProfilePin —— 归属校验已由调用方(requireOwnedProfile)完成,此处只做
 *    PIN 状态机:未设 PIN 403 FORBIDDEN → 锁定中 423 → 验证失败 403(计数/锁定,
 *    detail 仅含剩余次数)→ 成功清零并签发授予。
 */

// ---------------------------------------------------------------------------
// 1. PIN 状态机(纯函数,unit: profile.rules.spec.ts)
// ---------------------------------------------------------------------------

export interface PinFailureState {
  failedPinCount: number;
  pinLockedUntil: string | null;
}

/** 成功验证后的干净状态(计数清零、窗口清空) */
export const PIN_STATE_CLEARED: PinFailureState = { failedPinCount: 0, pinLockedUntil: null };

/** 锁定窗口内 = pin_locked_until 严格晚于 now;恰好到期 = 已解除(无残留锁定) */
export function isPinLocked(pinLockedUntil: string | null, now: Date): boolean {
  if (pinLockedUntil === null) {
    return false;
  }
  return Date.parse(pinLockedUntil) > now.getTime();
}

/**
 * 一次失败验证后的状态转移:
 * - 上一轮锁定窗口已过期 → 计数从 0 重算(本次失败记 1),不设新窗口;
 * - 新计数达到上限 → 设置锁定窗口(now + lockMinutes 分钟);
 * - 未达上限 → 仅计数,窗口保持空。
 */
export function registerPinFailure(
  state: PinFailureState,
  now: Date,
  maxAttempts: number,
  lockMinutes: number,
): PinFailureState {
  const previousWindowExpired = state.pinLockedUntil !== null && !isPinLocked(state.pinLockedUntil, now);
  const baseCount = previousWindowExpired ? 0 : state.failedPinCount;
  const failedPinCount = baseCount + 1;
  if (failedPinCount >= maxAttempts) {
    return {
      failedPinCount,
      pinLockedUntil: new Date(now.getTime() + lockMinutes * 60_000).toISOString(),
    };
  }
  return { failedPinCount, pinLockedUntil: null };
}

// ---------------------------------------------------------------------------
// 2. 内存解锁授予表(纯模块,unit: profile.rules.spec.ts)
// ---------------------------------------------------------------------------

/** 授予有效期:5 分钟(单实例内存设计,ADR-0002) */
export const UNLOCK_GRANT_TTL_MS = 5 * 60 * 1000;

/** key = (sessionId, profileId);UUID 不含 ':',拼接键无歧义 */
const unlockGrants = new Map<string, number>();

export function unlockGrantKey(sessionId: string, profileId: string): string {
  return `${sessionId}:${profileId}`;
}

/** unlock 成功后签发授予(TTL 内有效) */
export function grantUnlock(sessionId: string, profileId: string, now: number = Date.now()): void {
  unlockGrants.set(unlockGrantKey(sessionId, profileId), now + UNLOCK_GRANT_TTL_MS);
}

/** select 前置校验:是否存在未过期授予;过期键惰性清理 */
export function hasUnlockGrant(sessionId: string, profileId: string, now: number = Date.now()): boolean {
  const key = unlockGrantKey(sessionId, profileId);
  const expiresAt = unlockGrants.get(key);
  if (expiresAt === undefined) {
    return false;
  }
  if (expiresAt <= now) {
    unlockGrants.delete(key);
    return false;
  }
  return true;
}

/** select 成功后消费授予(一次性) */
export function consumeUnlockGrant(sessionId: string, profileId: string): void {
  unlockGrants.delete(unlockGrantKey(sessionId, profileId));
}

/** PIN 变更/清除时作废该档案的全部未消费授予(跨会话,防御旧授予绕过新 PIN) */
export function revokeUnlockGrantsForProfile(profileId: string): void {
  const suffix = `:${profileId}`;
  for (const key of unlockGrants.keys()) {
    if (key.endsWith(suffix)) {
      unlockGrants.delete(key);
    }
  }
}

// ---------------------------------------------------------------------------
// 3. unlock 用例(T027)
// ---------------------------------------------------------------------------

function pinLockedError(): DomainError {
  // 不泄露解锁剩余时间:仅状态码 + 稳定 code
  return new DomainError(423, ProblemCode.PROFILE_PIN_LOCKED, 'PIN 已锁定,请稍后重试');
}

/**
 * POST /profiles/{profileId}/unlock 的 PIN 状态机(归属校验已在调用方完成)。
 * 顺序:未设 PIN 403 → 锁定中 423(即使 PIN 正确)→ 验证失败 403 → 成功清零 + 签发授予。
 */
export async function unlockProfilePin(
  row: Profile,
  pin: string,
  sessionId: string,
): Promise<{ unlocked: true }> {
  if (row.pinHash === null) {
    throw new DomainError(403, ProblemCode.FORBIDDEN, '该 Profile 未设置 PIN,无需解锁');
  }

  const now = new Date();
  if (isPinLocked(row.pinLockedUntil, now)) {
    throw pinLockedError();
  }

  const pinMatches = await verifyPassword(row.pinHash, pin);
  if (!pinMatches) {
    const next = registerPinFailure(
      { failedPinCount: row.failedPinCount, pinLockedUntil: row.pinLockedUntil },
      now,
      env.PIN_MAX_ATTEMPTS,
      env.PIN_LOCK_MINUTES,
    );
    getDb().update(profile).set(next).where(eq(profile.id, row.id)).run();
    const remaining = Math.max(0, env.PIN_MAX_ATTEMPTS - next.failedPinCount);
    // detail 仅含剩余次数,不回显 PIN、不泄露其他信息(验收场景 5)
    throw new DomainError(403, ProblemCode.FORBIDDEN, `PIN 验证失败,剩余尝试次数:${remaining}`);
  }

  getDb().update(profile).set(PIN_STATE_CLEARED).where(eq(profile.id, row.id)).run();
  grantUnlock(sessionId, row.id);
  return { unlocked: true };
}
