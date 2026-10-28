import { ProblemCode } from '@hmp/shared';
import { DomainError } from '@platform/http-common/domain-error';
import type { SessionContext } from '@platform/http-common/current-session.decorator';
import { identityAccessStore } from '@contexts/identity-access/application/identity-access-store.port';
import { verifyPassword } from '@contexts/identity-access/infrastructure/password.service';

/**
 * 家长验证服务(阶段 2,FR-004/FR-011/ADR-0006):
 * - 主账号管理写操作前重新验证该账号密码 —— owner 会话可能正被儿童共用,
 *   会话角色本身不足以证明操作者是家长;
 * - 失败计数按 (household_id, account_id) 持久化:跨会话/浏览器共享,重启保留;
 * - 连续 5 次错误锁定 5 分钟:第 5 次错误本身仍返回 403 FAILED(并落锁定窗口),
 *   其后窗口内一律 423 LOCKED(不校验密码,即使正确);窗口过期重新计数;成功清零;
 * - 不发放任何长期"家长模式"令牌;验证结果仅在当次请求内有效;
 * - 异步 argon2 验证返回后在事务内重读状态再累加/清零,不依赖过时内存快照
 *   (并发下正确请求不得绕过新锁定,失败计数不得被覆盖丢失)。
 *
 * 服务为纯函数模块(对齐 token.service/pin.service 惯例),无需 Nest 注入。
 *
 * 008-repository-extraction(T011,ADR-0015 D1):账号/验证状态读写逐字迁往
 * infrastructure/identity-access-store.drizzle.ts(findAccountByIdAndHousehold /
 * findParentVerificationState / delete / upsert);锁定状态机(纯函数)与
 * 401/403/423 判定留本层。
 */

export const PARENT_VERIFICATION_MAX_ATTEMPTS = 5;
export const PARENT_VERIFICATION_LOCK_MINUTES = 5;

// ---------------------------------------------------------------------------
// 锁定状态机(纯函数,unit: parent-verification.spec.ts)
// ---------------------------------------------------------------------------

export interface ParentFailureState {
  failedAttempts: number;
  lockedUntil: string | null;
}

/** 锁定窗口内 = locked_until 严格晚于 now;恰好到期 = 已解除 */
export function isParentLocked(lockedUntil: string | null, now: Date): boolean {
  if (lockedUntil === null) {
    return false;
  }
  return Date.parse(lockedUntil) > now.getTime();
}

/**
 * 一次失败验证后的状态转移(上限/窗口为固定常量,FR-011):
 * - 上一轮窗口已过期 → 计数从 0 重算(本次记 1),不叠加旧计数;
 * - 新计数达到上限 → 设置锁定窗口(now + 5 分钟);
 * - 未达上限 → 仅计数,窗口保持空。
 */
export function registerParentFailure(state: ParentFailureState, now: Date): ParentFailureState {
  const previousWindowExpired = state.lockedUntil !== null && !isParentLocked(state.lockedUntil, now);
  const baseCount = previousWindowExpired ? 0 : state.failedAttempts;
  const failedAttempts = baseCount + 1;
  if (failedAttempts >= PARENT_VERIFICATION_MAX_ATTEMPTS) {
    return {
      failedAttempts,
      lockedUntil: new Date(now.getTime() + PARENT_VERIFICATION_LOCK_MINUTES * 60_000).toISOString(),
    };
  }
  return { failedAttempts, lockedUntil: null };
}

// ---------------------------------------------------------------------------
// 验证用例
// ---------------------------------------------------------------------------

function lockedError(): DomainError {
  // 不泄露剩余时间:仅状态码 + 稳定 code(与 PIN 锁定惯例一致)
  return new DomainError(423, ProblemCode.PARENT_VERIFICATION_LOCKED, '家长验证已锁定,请稍后重试');
}

/**
 * 验证当前会话账号的主账号密码(FR-004)。
 * 顺序:锁定检查(423)→ argon2 异步校验 → 事务内重读状态(并发安全)→
 *       成功清零 / 失败累加(第 5 次落锁定窗口)。
 * 密码缺失/空串由调用方先行映射 403 PARENT_VERIFICATION_REQUIRED,本函数只处理非空密码。
 * 任何路径都不修改业务数据(仅验证状态表);密码明文不进异常/日志(敏感键脱敏兜底)。
 */
export async function verifyParentPassword(context: SessionContext, password: string): Promise<void> {
  const store = identityAccessStore();
  const accountRow = store.findAccountByIdAndHousehold(context.account.id, context.session.householdId);
  if (accountRow === undefined) {
    // 会话上下文与账号行不一致(理论不可达,守卫已校验)→ 按会话失效拒绝,不泄露细节
    throw new DomainError(401, ProblemCode.SESSION_INVALID, undefined);
  }

  const initial = store.findParentVerificationState(context.session.householdId, context.session.accountId);
  if (isParentLocked(initial?.lockedUntil ?? null, new Date())) {
    throw lockedError();
  }

  // 损坏的存量哈希(格式非法)按验证失败处理(fail-closed):不得抛出底层异常,也不得放行
  const matches = await verifyPassword(accountRow.passwordHash, password).catch(() => false);
  const now = new Date();

  const outcome = store.withTransaction((tx) => {
    // 异步哈希验证期间状态可能被并发请求改变:事务内重读,不依赖过时快照
    const fresh = tx.findParentVerificationState(context.session.householdId, context.session.accountId);
    if (isParentLocked(fresh?.lockedUntil ?? null, now)) {
      return { kind: 'locked' as const };
    }
    if (matches) {
      if (fresh !== undefined) {
        tx.deleteParentVerificationState(context.session.householdId, context.session.accountId);
      }
      return { kind: 'ok' as const };
    }
    const next = registerParentFailure(
      { failedAttempts: fresh?.failedAttempts ?? 0, lockedUntil: fresh?.lockedUntil ?? null },
      now,
    );
    tx.upsertParentVerificationState({
      householdId: context.session.householdId,
      accountId: context.session.accountId,
      failedAttempts: next.failedAttempts,
      lockedUntil: next.lockedUntil,
    });
    return {
      kind: 'failed' as const,
      remaining: Math.max(0, PARENT_VERIFICATION_MAX_ATTEMPTS - next.failedAttempts),
    };
  });

  if (outcome.kind === 'locked') {
    throw lockedError();
  }
  if (outcome.kind === 'failed') {
    // detail 仅含剩余次数,不回显密码
    throw new DomainError(403, ProblemCode.PARENT_VERIFICATION_FAILED, `家长验证失败,剩余尝试次数:${outcome.remaining}`);
  }
}
