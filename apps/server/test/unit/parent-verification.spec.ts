import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { ProblemCode } from '@hmp/shared';
import { Database } from '../../src/database/database';
import { hashPassword } from '../../src/modules/auth/password.service';
import {
  PARENT_VERIFICATION_MAX_ATTEMPTS,
  isParentLocked,
  registerParentFailure,
  verifyParentPassword,
} from '../../src/modules/auth/parent-verification.service';
import type { SessionContext } from '../../src/common/current-session.decorator';
import { cleanupRigs, startFreshApp } from '../helpers';

/**
 * T007(阶段 2 单元/DB 夹具):家长验证服务 —— FR-011 锁定状态机与 FR-004 密码校验。
 * 真实 sqlite 夹具 + 真实 argon2 哈希;SessionContext 手工构造(不经 HTTP)。
 * 锁定窗口语义与 PIN 一致:第 N 次错误本身仍返回 403;窗口内(即使密码正确)423;
 * 窗口过期重置计数;成功清零;计数按 (household, account) 持久化,重启保留由表存储保证。
 */

const PASSWORD = 'parent-pass-9';

let accountFixture: { householdId: string; accountId: string } | null = null;
let context: SessionContext | null = null;
let foreign: { householdId: string; accountId: string } | null = null;

async function setup(): Promise<void> {
  await startFreshApp({ prefix: 'hmp-pv-' });
  const householdId = randomUUID();
  const accountId = randomUUID();
  const now = new Date().toISOString();
  const hash = await hashPassword(PASSWORD);
  Database.db
    .prepare('INSERT INTO household (id, name, default_language, timezone, created_at) VALUES (?, ?, ?, ?, ?)')
    .run(householdId, '验证家庭', 'zh-CN', 'Asia/Shanghai', now);
  Database.db
    .prepare(
      'INSERT INTO account (id, household_id, username, username_normalized, password_hash, role, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    )
    .run(accountId, householdId, 'parent', 'parent', hash, 'owner', now);
  accountFixture = { householdId, accountId };
  context = {
    session: {
      id: randomUUID(),
      householdId,
      accountId,
      deviceId: randomUUID(),
      activeProfileId: null,
      expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
    },
    account: { id: accountId, householdId, username: 'parent', role: 'owner' },
  };
}

function foreignAccountFixture(): { householdId: string; accountId: string } {
  const householdId = randomUUID();
  const accountId = randomUUID();
  const now = new Date().toISOString();
  Database.db
    .prepare('INSERT INTO household (id, name, default_language, timezone, created_at) VALUES (?, ?, ?, ?, ?)')
    .run(householdId, '别家', 'zh-CN', 'Asia/Shanghai', now);
  // 真实 argon2 哈希(不同密码):隔离性验证不依赖畸形哈希的行为差异
  const foreignHash = '$argon2id$v=19$m=65536,t=3,p=4$c29tZXNhbHQ$Zm9vYmFy'; // 合法形态,与 PASSWORD 不匹配
  Database.db
    .prepare(
      'INSERT INTO account (id, household_id, username, username_normalized, password_hash, role, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    )
    .run(accountId, householdId, 'other', 'other', foreignHash, 'owner', now);
  return { householdId, accountId };
}

function stateRow(target: { householdId: string; accountId: string }): { failed_attempts: number; locked_until: string | null } | undefined {
  return Database.db
    .prepare('SELECT failed_attempts, locked_until FROM parent_verification_state WHERE household_id = ? AND account_id = ?')
    .get(target.householdId, target.accountId) as { failed_attempts: number; locked_until: string | null } | undefined;
}

function ctxFor(target: { householdId: string; accountId: string }): SessionContext {
  return {
    session: {
      id: randomUUID(),
      householdId: target.householdId,
      accountId: target.accountId,
      deviceId: randomUUID(),
      activeProfileId: null,
      expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
    },
    account: { id: target.accountId, householdId: target.householdId, username: 'x', role: 'owner' },
  };
}

describe('家长验证服务(FR-004/FR-011,真实 sqlite + argon2)', () => {
  afterEach(cleanupRigs);
  afterEach(() => {
    accountFixture = null;
    context = null;
    foreign = null;
  });

  it('纯函数状态机:计数累加,第 5 次设窗口,窗口内判定锁定,恰好到期解除', async () => {
    await setup();
    let state = { failedAttempts: 0, lockedUntil: null as string | null };
    for (let i = 1; i < PARENT_VERIFICATION_MAX_ATTEMPTS; i += 1) {
      state = registerParentFailure(state, new Date());
      expect(state.failedAttempts).toBe(i);
      expect(state.lockedUntil).toBeNull();
    }
    state = registerParentFailure(state, new Date());
    expect(state.failedAttempts).toBe(PARENT_VERIFICATION_MAX_ATTEMPTS);
    expect(state.lockedUntil).not.toBeNull();
    expect(Date.parse(state.lockedUntil as string)).toBeGreaterThan(Date.now());
    expect(isParentLocked(state.lockedUntil, new Date())).toBe(true);
    // 恰好到期 = 已解除(严格大于才锁定)
    const exactly = new Date(Date.parse(state.lockedUntil as string));
    expect(isParentLocked(state.lockedUntil, exactly)).toBe(false);
    // 窗口过期后的下一次失败重新计数(不叠加旧计数)
    const afterWindow = registerParentFailure(state, new Date(Date.parse(state.lockedUntil as string) + 1));
    expect(afterWindow.failedAttempts).toBe(1);
    expect(afterWindow.lockedUntil).toBeNull();
  });

  it('正确密码通过且不产生状态行;错误密码 403 FAILED 并计数,detail 不含密码明文', async () => {
    await setup();
    const ctx = context as SessionContext;

    await expect(verifyParentPassword(ctx, PASSWORD)).resolves.toBeUndefined();
    expect(stateRow(accountFixture as { householdId: string; accountId: string })).toBeUndefined();

    const wrong = await verifyParentPassword(ctx, 'wrong-pass').catch((err) => err);
    expect(wrong).toMatchObject({ status: 403, code: ProblemCode.PARENT_VERIFICATION_FAILED });
    expect(String(wrong.detail)).toContain('4'); // 剩余 4 次
    expect(String(wrong.detail)).not.toContain('wrong-pass');
    expect(String(wrong.message)).not.toContain('wrong-pass');
    expect(stateRow(accountFixture as { householdId: string; accountId: string })?.failed_attempts).toBe(1);
  });

  it('连续 5 次错误:第 5 次仍 403 FAILED 且落锁定窗口;此后正确密码也 423 LOCKED', async () => {
    await setup();
    const ctx = context as SessionContext;
    for (let i = 0; i < PARENT_VERIFICATION_MAX_ATTEMPTS; i += 1) {
      const err = await verifyParentPassword(ctx, 'nope').catch((e) => e);
      expect(err.status).toBe(403);
      expect(err.code).toBe(ProblemCode.PARENT_VERIFICATION_FAILED);
    }
    const row = stateRow(accountFixture as { householdId: string; accountId: string });
    expect(row?.failed_attempts).toBe(5);
    expect(row?.locked_until).not.toBeNull();

    const locked = await verifyParentPassword(ctx, PASSWORD).catch((e) => e);
    expect(locked).toMatchObject({ status: 423, code: ProblemCode.PARENT_VERIFICATION_LOCKED });
    // 锁定窗口内不再校验密码 → 计数不变
    expect(stateRow(accountFixture as { householdId: string; accountId: string })?.failed_attempts).toBe(5);
  });

  it('窗口过期(直写过去时刻)→ 重新可验证;成功后计数清零;再失败从 1 起算', async () => {
    await setup();
    const ctx = context as SessionContext;
    const target = accountFixture as { householdId: string; accountId: string };

    await verifyParentPassword(ctx, 'nope').catch(() => undefined);
    await verifyParentPassword(ctx, 'nope').catch(() => undefined);
    expect(stateRow(target)?.failed_attempts).toBe(2);

    // 成功 → 清零(状态行删除)
    await expect(verifyParentPassword(ctx, PASSWORD)).resolves.toBeUndefined();
    expect(stateRow(target)).toBeUndefined();

    await verifyParentPassword(ctx, 'nope').catch(() => undefined);
    expect(stateRow(target)?.failed_attempts).toBe(1);

    // 触发锁定后把窗口直写为过去 → 正确密码立即恢复可用
    for (let i = 0; i < PARENT_VERIFICATION_MAX_ATTEMPTS - 1; i += 1) {
      await verifyParentPassword(ctx, 'nope').catch(() => undefined);
    }
    expect(stateRow(target)?.locked_until).not.toBeNull();
    Database.db
      .prepare('UPDATE parent_verification_state SET locked_until = ? WHERE household_id = ? AND account_id = ?')
      .run(new Date(Date.now() - 1000).toISOString(), target.householdId, target.accountId);
    await expect(verifyParentPassword(ctx, PASSWORD)).resolves.toBeUndefined();
    expect(stateRow(target)).toBeUndefined();
  });

  it('计数按 (household, account) 隔离:他家庭账号的锁定不影响本账号验证', async () => {
    await setup();
    const ctx = context as SessionContext;
    foreign = foreignAccountFixture();

    // 本账号触发锁定
    for (let i = 0; i < PARENT_VERIFICATION_MAX_ATTEMPTS; i += 1) {
      await verifyParentPassword(ctx, 'nope').catch(() => undefined);
    }
    expect(
      await verifyParentPassword(ctx, PASSWORD).then(
        () => 'ok',
        (e) => e.code,
      ),
    ).toBe(ProblemCode.PARENT_VERIFICATION_LOCKED);

    // 他家庭同用户名账号无状态行,验证行为独立(此处哈希不匹配 → 403 FAILED 而非 423)
    const other = await verifyParentPassword(ctxFor(foreign), 'any').then(
      () => 'ok',
      (e) => e.code,
    );
    expect(other).toBe(ProblemCode.PARENT_VERIFICATION_FAILED);
    expect(stateRow(foreign)?.failed_attempts).toBe(1);
  });
});
