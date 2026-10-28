import { and, eq } from 'drizzle-orm';
import { ProblemCode } from '@hmp/shared';
import { account, deviceSession, household, profile } from '@platform/database/schema';
import { DomainError, createDomainError } from '@platform/http-common/domain-error';
import type { SessionContext } from '@platform/http-common/current-session.decorator';
import { env } from '@platform/config/env';
import { getDb, type Db } from '@contexts/identity-access/infrastructure/db';
import { verifyPassword } from '@contexts/identity-access/infrastructure/password.service';
import { requireManagementRole } from '@contexts/identity-access/application/bootstrap.service';
import { PIN_STATE_CLEARED, isPinLocked, registerPinFailure } from '@contexts/profile/application/pin.service';
import {
  issueSettingsGrantTx,
  type IssuedSettingsGrant,
  type SettingsAccessBody,
} from '@contexts/settings/application/settings-access-grant.service';

/**
 * 设置 PIN 验证服务(T082,005 data-model §3 + contracts/api.md §6/§7 + ADR-0011 决议 4)。
 *
 * POST /settings/access 的服务体(独立入口,绝不要求已有 grant):
 *   Session(上游 SessionGuard)→ 管理角色 → 当前主 Profile → 严格入参(管道)→
 *   PIN 状态机(持久失败计数,与选档共享)→ 哈希在事务外 → BEGIN IMMEDIATE
 *   提交前重验四版本快照 → 成功:清零计数 + 签发(或复用)授予。
 *
 * - 竞态:验证开始捕获 pin_version / profile_context_version / main_profile_version /
 *   credential_version,异步 argon2 完成后事务内重读比对,任一变化拒绝提交(409
 *   VERSION_CONFLICT),不签发基于旧身份的授予;
 * - 持久失败计数:沿用 profile.failed_pin_count/pin_locked_until(与选档 unlock 同一
 *   行同一状态机,profile.rules/pin.service),连续 5 次锁 5 分钟,跨刷新/新会话/
 *   重启保留;成功清零;锁定内即使正确 PIN 一律 423 PROFILE_PIN_LOCKED;
 * - PIN 只在当次请求 body,不进入地址/日志/公共响应;错误 detail 仅含剩余次数。
 */

function pinLockedError(): DomainError {
  // 不泄露解锁剩余时间:仅状态码 + 稳定 code(与选档口径一致)
  return new DomainError(423, ProblemCode.PROFILE_PIN_LOCKED, 'PIN 已锁定,请稍后重试');
}

/** 主档案行(含 PIN 状态机列与哈希;仅服务端内部使用,绝不进入响应) */
interface MainProfileRow {
  id: string;
  accountId: string;
  pinHash: string;
  pinVersion: number;
  failedPinCount: number;
  pinLockedUntil: string | null;
}

function readMainProfileRow(db: Db, householdId: string): MainProfileRow | null {
  const row = db
    .select({
      id: profile.id,
      accountId: profile.accountId,
      pinHash: profile.pinHash,
      pinVersion: profile.pinVersion,
      failedPinCount: profile.failedPinCount,
      pinLockedUntil: profile.pinLockedUntil,
    })
    .from(profile)
    .where(and(eq(profile.householdId, householdId), eq(profile.isMain, 1)))
    .get();
  // 主档案 CHECK 保证 is_main=1 ⇒ pin_hash 非空;形态异常按未首建同形拒绝(fail-closed)
  return row !== undefined && row.pinHash !== null ? { ...row, pinHash: row.pinHash } : null;
}

/** 四版本快照:验证开始捕获,提交前重验 */
interface VerificationSnapshot {
  pinVersion: number;
  profileContextVersion: number;
  mainProfileVersion: number;
  credentialVersion: number;
}

type VerifyOutcome =
  | { kind: 'locked' }
  | { kind: 'versionConflict' }
  | { kind: 'failed'; remaining: number }
  | { kind: 'ok'; grant: IssuedSettingsGrant };

/**
 * POST /settings/access 用例:验证当前会话(须已选当前主 Profile)的管理 PIN,
 * 成功即在同事务签发/复用 15 分钟固定设置授予。
 * 响应仅 SettingsAccess 元数据 {unlocked, expiresAt};不返回管理主体、无 bearer。
 */
export async function verifyAndIssueSettingsAccess(
  context: SessionContext,
  pin: string,
): Promise<SettingsAccessBody> {
  // 1. 管理角色(owner/admin);不足 403(api.md §7:角色/当前主 Profile 先于 grant)
  requireManagementRole(context);
  const householdId = context.session.householdId;
  const db = getDb();

  // 2. 当前主 Profile 必须存在(未首建:目标不存在,404 同形)
  const main = readMainProfileRow(db, householdId);
  if (main === null) {
    throw new DomainError(404, ProblemCode.NOT_FOUND);
  }

  // 3. 当前档案必须是主 Profile(未选档 403 ACTIVE_PROFILE_REQUIRED;普通档案 403)
  const sessionRow = db
    .select({ activeProfileId: deviceSession.activeProfileId })
    .from(deviceSession)
    .where(and(eq(deviceSession.householdId, householdId), eq(deviceSession.id, context.session.id)))
    .get();
  if (sessionRow === undefined) {
    throw new DomainError(401, ProblemCode.SESSION_INVALID, undefined);
  }
  if (sessionRow.activeProfileId === null) {
    throw new DomainError(403, ProblemCode.ACTIVE_PROFILE_REQUIRED, undefined);
  }
  if (sessionRow.activeProfileId !== main.id) {
    throw new DomainError(403, ProblemCode.FORBIDDEN, '设置验证仅限当前主档案');
  }

  // 4. 锁定检查(持久失败计数,与选档共享;锁定内即使正确 PIN 也 423)
  const now = new Date();
  if (isPinLocked(main.pinLockedUntil, now)) {
    throw pinLockedError();
  }

  // 5. 快照捕获(验证开始时)
  const sessionFull = db
    .select({ profileContextVersion: deviceSession.profileContextVersion })
    .from(deviceSession)
    .where(and(eq(deviceSession.householdId, householdId), eq(deviceSession.id, context.session.id)))
    .get();
  const householdRow = db
    .select({ mainProfileVersion: household.mainProfileVersion })
    .from(household)
    .where(eq(household.id, householdId))
    .get();
  const accountRow = db
    .select({ credentialVersion: account.credentialVersion })
    .from(account)
    .where(and(eq(account.householdId, householdId), eq(account.id, context.account.id)))
    .get();
  if (sessionFull === undefined || householdRow === undefined || accountRow === undefined) {
    throw new DomainError(401, ProblemCode.SESSION_INVALID, undefined);
  }
  const snapshot: VerificationSnapshot = {
    pinVersion: main.pinVersion,
    profileContextVersion: sessionFull.profileContextVersion,
    mainProfileVersion: householdRow.mainProfileVersion,
    credentialVersion: accountRow.credentialVersion,
  };

  // 6. 哈希比对在事务外(短事务原则);坏哈希按失败处理,不抛底层异常
  const pinMatches = await verifyPassword(main.pinHash, pin).catch(() => false);

  // 7. BEGIN IMMEDIATE:提交前重验快照 → 失败计数写入与授予签发原子提交
  const outcome = db.transaction(
    (tx): VerifyOutcome => {
      const freshMain = readMainProfileRow(tx, householdId);
      if (freshMain === null) {
        throw new DomainError(404, ProblemCode.NOT_FOUND);
      }
      const freshSession = tx
        .select({ activeProfileId: deviceSession.activeProfileId, profileContextVersion: deviceSession.profileContextVersion })
        .from(deviceSession)
        .where(and(eq(deviceSession.householdId, householdId), eq(deviceSession.id, context.session.id)))
        .get();
      const freshHousehold = tx
        .select({ mainProfileVersion: household.mainProfileVersion })
        .from(household)
        .where(eq(household.id, householdId))
        .get();
      const freshAccount = tx
        .select({ credentialVersion: account.credentialVersion })
        .from(account)
        .where(and(eq(account.householdId, householdId), eq(account.id, context.account.id)))
        .get();
      if (freshSession === undefined || freshHousehold === undefined || freshAccount === undefined) {
        throw new DomainError(401, ProblemCode.SESSION_INVALID, undefined);
      }
      // 任一版本变化拒绝提交:不签发基于旧身份的授予(data-model §3)
      if (
        freshMain.pinVersion !== snapshot.pinVersion ||
        freshSession.profileContextVersion !== snapshot.profileContextVersion ||
        freshHousehold.mainProfileVersion !== snapshot.mainProfileVersion ||
        freshAccount.credentialVersion !== snapshot.credentialVersion
      ) {
        return { kind: 'versionConflict' };
      }
      // 锁定重验(异步窗口内可能已被并发请求置锁)
      if (isPinLocked(freshMain.pinLockedUntil, now)) {
        return { kind: 'locked' };
      }
      if (!pinMatches) {
        const next = registerPinFailure(
          { failedPinCount: freshMain.failedPinCount, pinLockedUntil: freshMain.pinLockedUntil },
          now,
          env.PIN_MAX_ATTEMPTS,
          env.PIN_LOCK_MINUTES,
        );
        tx
          .update(profile)
          .set(next)
          .where(and(eq(profile.householdId, householdId), eq(profile.id, freshMain.id)))
          .run();
        return {
          kind: 'failed',
          remaining: Math.max(0, env.PIN_MAX_ATTEMPTS - next.failedPinCount),
        };
      }
      // 成功:清持久失败计数(与选档共享,成功清零)+ 同事务签发/复用授予
      tx
        .update(profile)
        .set(PIN_STATE_CLEARED)
        .where(and(eq(profile.householdId, householdId), eq(profile.id, freshMain.id)))
        .run();
      const grant = issueSettingsGrantTx(tx, {
        householdId,
        deviceSessionId: context.session.id,
        snapshot: {
          profileId: freshMain.id,
          profileContextVersion: freshSession.profileContextVersion,
          pinVersion: freshMain.pinVersion,
          mainProfileVersion: freshHousehold.mainProfileVersion,
        },
      });
      return { kind: 'ok', grant };
    },
    { behavior: 'immediate' },
  );

  // 8. 事务返回结果、提交后再抛领域错误:失败计数/锁定的写入必须随事务提交
  if (outcome.kind === 'locked') {
    throw pinLockedError();
  }
  if (outcome.kind === 'versionConflict') {
    throw createDomainError('VERSION_CONFLICT');
  }
  if (outcome.kind === 'failed') {
    throw new DomainError(
      403,
      ProblemCode.FORBIDDEN,
      `PIN 验证失败,剩余尝试次数:${outcome.remaining}`,
    );
  }
  return { unlocked: true, expiresAt: outcome.grant.expiresAt };
}
