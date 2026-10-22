import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import DatabaseConstructor from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { ProblemCode } from '@hmp/shared';
import { DomainError } from '../../src/common/domain-error';
import {
  PIN_STATE_CLEARED,
  UNLOCK_GRANT_TTL_MS,
  consumeUnlockGrant,
  grantUnlock,
  hasUnlockGrant,
  isPinLocked,
  registerPinFailure,
  unlockGrantKey,
} from '../../src/modules/profile/pin.service';
import {
  assertNotLastActiveProfile,
  swapDefault,
} from '../../src/modules/profile/profile.service';

/**
 * T024(US2 单元):profile 规则 ——
 * - FR-013 默认唯一互换(swapDefault 纯函数)与「至少一个可用 Profile」守卫(assertNotLastActiveProfile);
 * - FR-015 PIN 计数/锁定窗口状态机(isPinLocked / registerPinFailure / PIN_STATE_CLEARED,含窗口过期重置);
 * - one_default_profile 部分唯一索引行为与 profile 复合外键(内存 SQLite 重放权威 DDL 0001_init 直接验证);
 * - 解锁授予表(US2 关键设计:select 契约无请求体,unlock 成功后签发短时内存授予供 select 校验;
 *   ADR-0002 单实例部署前提,TTL 5 分钟,按 (sessionId, profileId) 隔离,select 成功即消费)。
 */

function migrationUpSql(): string {
  return fs.readFileSync(path.join(process.cwd(), 'src/database/migrations/0001_init/up.sql'), 'utf8');
}

describe('swapDefault —— FR-013 默认唯一互换(纯函数)', () => {
  it('目标设为唯一默认,其余(含原默认)全部取消', () => {
    const profiles = [
      { id: 'a', isDefault: 1 },
      { id: 'b', isDefault: 0 },
      { id: 'c', isDefault: 0 },
    ];

    expect(swapDefault(profiles, 'b')).toEqual([
      { id: 'a', isDefault: false },
      { id: 'b', isDefault: true },
      { id: 'c', isDefault: false },
    ]);
  });

  it('对当前默认重复互换保持幂等(任意时刻仍恰好一个默认)', () => {
    const profiles = [
      { id: 'a', isDefault: 1 },
      { id: 'b', isDefault: 0 },
    ];

    expect(swapDefault(swapDefault(profiles, 'a'), 'a')).toEqual([
      { id: 'a', isDefault: true },
      { id: 'b', isDefault: false },
    ]);
  });

  it('目标不在集合中时全部清为非默认(服务层「清空其他默认」语义)', () => {
    const profiles = [
      { id: 'a', isDefault: 1 },
      { id: 'b', isDefault: 0 },
    ];

    const desired = swapDefault(profiles, 'not-in-set');
    expect(desired.every((row) => row.isDefault === false)).toBe(true);
  });

  it('纯函数无副作用:不修改输入数组与元素', () => {
    const profiles = [{ id: 'a', isDefault: 1 }];
    const snapshot = structuredClone(profiles);

    swapDefault(profiles, 'a');

    expect(profiles).toEqual(snapshot);
  });

  it('空集合返回空数组', () => {
    expect(swapDefault([], 'a')).toEqual([]);
  });
});

describe('assertNotLastActiveProfile —— FR-013 至少保留一个可用 Profile', () => {
  it('家庭内没有其他可用 Profile 时拒绝(409 LAST_ACTIVE_PROFILE)', () => {
    let caught: unknown;
    try {
      assertNotLastActiveProfile(0);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(DomainError);
    const domain = caught as DomainError;
    expect(domain.status).toBe(409);
    expect(domain.code).toBe(ProblemCode.LAST_ACTIVE_PROFILE);
  });

  it('存在其他可用 Profile 时放行(1 个或多个)', () => {
    expect(() => assertNotLastActiveProfile(1)).not.toThrow();
    expect(() => assertNotLastActiveProfile(3)).not.toThrow();
  });
});

describe('PIN 状态机 —— FR-015 计数与锁定窗口(纯函数)', () => {
  const MAX = 5;
  const LOCK_MINUTES = 5;

  it('isPinLocked:无锁定记录 → 未锁定', () => {
    expect(isPinLocked(null, new Date())).toBe(false);
  });

  it('isPinLocked:窗口截止在未来 → 锁定中', () => {
    const now = new Date('2026-01-01T00:00:00.000Z');
    expect(isPinLocked('2026-01-01T00:04:59.999Z', now)).toBe(true);
  });

  it('isPinLocked:窗口已过期解除;边界「恰好到期 = 已解除」(无放行/无残留锁定)', () => {
    const now = new Date('2026-01-01T00:05:00.000Z');
    expect(isPinLocked('2026-01-01T00:04:59.999Z', now)).toBe(false);
    expect(isPinLocked('2026-01-01T00:05:00.000Z', now)).toBe(false);
    expect(isPinLocked('2026-01-01T00:05:00.001Z', now)).toBe(true);
  });

  it('registerPinFailure:未达上限仅计数 +1,不设锁定窗口', () => {
    const now = new Date('2026-01-01T00:00:00.000Z');

    expect(registerPinFailure({ failedPinCount: 0, pinLockedUntil: null }, now, MAX, LOCK_MINUTES))
      .toEqual({ failedPinCount: 1, pinLockedUntil: null });
    expect(registerPinFailure({ failedPinCount: 3, pinLockedUntil: null }, now, MAX, LOCK_MINUTES))
      .toEqual({ failedPinCount: 4, pinLockedUntil: null });
  });

  it('registerPinFailure:失败达到上限(pin_failed_count 4→5)→ 设置锁定窗口 now + PIN_LOCK_MINUTES', () => {
    const now = new Date('2026-01-01T00:00:00.000Z');

    const next = registerPinFailure({ failedPinCount: 4, pinLockedUntil: null }, now, MAX, LOCK_MINUTES);

    expect(next.failedPinCount).toBe(5);
    expect(next.pinLockedUntil).not.toBeNull();
    expect(Date.parse(next.pinLockedUntil as string)).toBe(now.getTime() + LOCK_MINUTES * 60_000);
  });

  it('registerPinFailure:窗口过期后的失败重置计数(从 1 重新计,不叠加旧计数、不立即再锁)', () => {
    const now = new Date('2026-01-01T00:10:00.000Z');
    const expiredWindow = new Date(now.getTime() - 1_000).toISOString();

    const next = registerPinFailure(
      { failedPinCount: 5, pinLockedUntil: expiredWindow },
      now,
      MAX,
      LOCK_MINUTES,
    );

    expect(next).toEqual({ failedPinCount: 1, pinLockedUntil: null });
  });

  it('registerPinFailure:maxAttempts 可配置(=1 时首次失败即锁定)', () => {
    const now = new Date('2026-01-01T00:00:00.000Z');

    const next = registerPinFailure({ failedPinCount: 0, pinLockedUntil: null }, now, 1, LOCK_MINUTES);

    expect(next.failedPinCount).toBe(1);
    expect(next.pinLockedUntil).not.toBeNull();
  });

  it('PIN_STATE_CLEARED:成功验证后计数清零、锁定窗口清空', () => {
    expect(PIN_STATE_CLEARED).toEqual({ failedPinCount: 0, pinLockedUntil: null });
  });
});

describe('解锁授予表 —— select 无请求体的解锁凭证(单实例内存设计,ADR-0002)', () => {
  it('签发后 TTL 内有效;select 消费后一次性失效', () => {
    const t = 1_000_000;

    grantUnlock('s-grant', 'p-grant', t);
    expect(hasUnlockGrant('s-grant', 'p-grant', t + 1)).toBe(true);

    consumeUnlockGrant('s-grant', 'p-grant');
    expect(hasUnlockGrant('s-grant', 'p-grant', t + 2)).toBe(false);
  });

  it('TTL 过期自动失效(边界:恰好 TTL = 已失效),惰性清理后不复活', () => {
    const t = 2_000_000;

    grantUnlock('s-ttl', 'p-ttl', t);

    expect(hasUnlockGrant('s-ttl', 'p-ttl', t + UNLOCK_GRANT_TTL_MS - 1)).toBe(true);
    expect(hasUnlockGrant('s-ttl', 'p-ttl', t + UNLOCK_GRANT_TTL_MS)).toBe(false);
    // 惰性删除后不复活
    expect(hasUnlockGrant('s-ttl', 'p-ttl', t + UNLOCK_GRANT_TTL_MS + 1)).toBe(false);
  });

  it('按 (sessionId, profileId) 隔离:不能跨会话或跨档案复用', () => {
    const t = 3_000_000;

    grantUnlock('s-iso', 'p-iso', t);

    expect(hasUnlockGrant('s-other', 'p-iso', t + 1)).toBe(false);
    expect(hasUnlockGrant('s-iso', 'p-other', t + 1)).toBe(false);
    expect(hasUnlockGrant('s-iso', 'p-iso', t + 1)).toBe(true);
  });

  it('unlockGrantKey:同一对 (session, profile) 键稳定,不同对键不同', () => {
    expect(unlockGrantKey('s1', 'p1')).toBe(unlockGrantKey('s1', 'p1'));
    expect(unlockGrantKey('s1', 'p1')).not.toBe(unlockGrantKey('s1', 'p2'));
    expect(unlockGrantKey('s1', 'p1')).not.toBe(unlockGrantKey('s2', 'p1'));
  });
});

describe('one_default_profile 部分唯一索引与复合外键 —— data-model 约束(内存 SQLite 重放权威 DDL)', () => {
  interface IndexFixture {
    db: DatabaseConstructor.Database;
    householdId: string;
    accountId: string;
    otherHouseholdId: string;
    otherAccountId: string;
  }

  function fixture(): IndexFixture {
    const db = new DatabaseConstructor(':memory:');
    db.pragma('foreign_keys = ON');
    db.exec(migrationUpSql());
    const householdId = randomUUID();
    const accountId = randomUUID();
    const otherHouseholdId = randomUUID();
    const otherAccountId = randomUUID();
    const now = new Date().toISOString();
    const insertHousehold = db.prepare(
      'INSERT INTO household (id, name, default_language, timezone, created_at) VALUES (?, ?, ?, ?, ?)',
    );
    const insertAccount = db.prepare(
      'INSERT INTO account (id, household_id, username, username_normalized, password_hash, role, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    );
    insertHousehold.run(householdId, '家庭一', 'zh-CN', 'Asia/Shanghai', now);
    insertAccount.run(accountId, householdId, 'admin', 'admin', 'hash-a', 'owner', now);
    insertHousehold.run(otherHouseholdId, '家庭二', 'zh-CN', 'Asia/Shanghai', now);
    insertAccount.run(otherAccountId, otherHouseholdId, 'other', 'other', 'hash-b', 'owner', now);
    return { db, householdId, accountId, otherHouseholdId, otherAccountId };
  }

  function insertProfileRow(
    db: DatabaseConstructor.Database,
    householdId: string,
    accountId: string,
    isDefault: number,
    status: string,
  ): void {
    db.prepare(
      'INSERT INTO profile (id, household_id, account_id, name, avatar, type, is_default, pin_hash, status, failed_pin_count, pin_locked_until, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    ).run(randomUUID(), householdId, accountId, 'P', null, 'adult', isDefault, null, status, 0, null, new Date().toISOString());
  }

  it('同家庭第二个 active 默认 → 违反 one_default_profile 部分唯一索引', () => {
    const f = fixture();
    insertProfileRow(f.db, f.householdId, f.accountId, 1, 'active');

    expect(() => insertProfileRow(f.db, f.householdId, f.accountId, 1, 'active')).toThrow(
      /UNIQUE constraint failed/,
    );
    f.db.close();
  });

  it('disabled 档案可保留 is_default=1(部分索引仅约束 active 行)', () => {
    const f = fixture();
    insertProfileRow(f.db, f.householdId, f.accountId, 1, 'active');

    expect(() => insertProfileRow(f.db, f.householdId, f.accountId, 1, 'disabled')).not.toThrow();
    f.db.close();
  });

  it('不同家庭互不影响(部分唯一索引按 household_id 隔离)', () => {
    const f = fixture();
    insertProfileRow(f.db, f.householdId, f.accountId, 1, 'active');

    expect(() =>
      insertProfileRow(f.db, f.otherHouseholdId, f.otherAccountId, 1, 'active'),
    ).not.toThrow();
    f.db.close();
  });

  it('复合外键:profile(household_id, account_id) 跨家庭错配被拒绝(归属一致性锚点)', () => {
    const f = fixture();

    expect(() =>
      f.db
        .prepare(
          'INSERT INTO profile (id, household_id, account_id, name, avatar, type, is_default, pin_hash, status, failed_pin_count, pin_locked_until, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
        )
        .run(randomUUID(), f.householdId, f.otherAccountId, 'X', null, 'adult', 0, null, 'active', 0, null, new Date().toISOString()),
    ).toThrow(/FOREIGN KEY constraint failed/);
    f.db.close();
  });
});
