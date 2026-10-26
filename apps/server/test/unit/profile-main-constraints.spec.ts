import 'reflect-metadata';
import { afterEach, describe, expect, it } from 'vitest';
import { Database } from '../../src/database/database';
import type { SessionContext } from '../../src/common/current-session.decorator';
import { bootstrapMainProfile, recoverMainProfilePin } from '../../src/modules/auth/bootstrap.service';
import {
  INITIALIZE_BODY,
  cleanupRigs,
  initialize,
  login,
  startFreshApp,
} from '../helpers';

/**
 * T033(005 US2 单元测试,先 FAIL):data-model §2 主档案约束与身份版本语义。
 * 权威:docs/specs/005-pc-browsing-flow/data-model.md §2(profile/device_session)、§3
 * (settings_access_grant)、§5(profile_progress_clock)、ADR-0011。
 *
 * 直接对迁移权威 DDL 生成的库断言约束行为;服务级行为经 bootstrap/pin-recovery 服务驱动。
 */

const NOW = new Date().toISOString();

function insertHousehold(id = 'hh-main'): void {
  Database.db
    .prepare('INSERT INTO household (id, name, default_language, timezone, created_at) VALUES (?, ?, ?, ?, ?)')
    .run(id, '约束家庭', 'zh-CN', 'Asia/Shanghai', NOW);
}

function insertAccount(id = 'acc-1', householdId = 'hh-main'): void {
  Database.db
    .prepare(
      'INSERT INTO account (id, household_id, username, username_normalized, password_hash, role, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    )
    .run(id, householdId, 'admin', 'admin', '$argon2id$v=19$m=65536,t=3,p=4$fake$fake', 'owner', NOW);
}

function insertProfile(overrides: {
  id: string;
  householdId?: string;
  accountId?: string;
  name?: string;
  type?: 'adult' | 'child';
  isDefault?: number;
  isMain?: number;
  pinHash?: string | null;
  status?: 'active' | 'disabled';
  pinVersion?: number;
}): void {
  Database.db
    .prepare(
      `INSERT INTO profile (id, household_id, account_id, name, avatar, type, is_default, pin_hash, status,
        failed_pin_count, pin_locked_until, is_main, pin_version, version, created_at)
       VALUES (?, ?, ?, ?, NULL, ?, ?, ?, ?, 0, NULL, ?, ?, 1, ?)`,
    )
    .run(
      overrides.id,
      overrides.householdId ?? 'hh-main',
      overrides.accountId ?? 'acc-1',
      overrides.name ?? '档案',
      overrides.type ?? 'adult',
      overrides.isDefault ?? 0,
      overrides.pinHash ?? null,
      overrides.status ?? 'active',
      overrides.isMain ?? 0,
      overrides.pinVersion ?? 1,
      NOW,
    );
}

/** 启动应用并构造「已登录、零档案」的服务端会话上下文 */
async function loggedInContext(prefix: string): Promise<SessionContext> {
  const { app } = await startFreshApp({ prefix });
  const initialized = await initialize(app);
  expect(initialized.status).toBe(201);
  const loggedIn = await login(app, INITIALIZE_BODY.username, INITIALIZE_BODY.password);
  expect(loggedIn.status).toBe(200);
  const sessionId = (loggedIn.body as { sessionId: string }).sessionId;
  const sessionRow = Database.db.prepare('SELECT * FROM device_session WHERE id = ?').get(sessionId) as {
    id: string;
    household_id: string;
    account_id: string;
    device_id: string;
    active_profile_id: string | null;
    expires_at: string;
  };
  const accountRow = Database.db.prepare('SELECT * FROM account WHERE id = ?').get(sessionRow.account_id) as {
    id: string;
    household_id: string;
    username: string;
    role: string;
  };
  return {
    session: {
      id: sessionRow.id,
      householdId: sessionRow.household_id,
      accountId: sessionRow.account_id,
      deviceId: sessionRow.device_id,
      activeProfileId: sessionRow.active_profile_id,
      expiresAt: sessionRow.expires_at,
    },
    account: {
      id: accountRow.id,
      householdId: accountRow.household_id,
      username: accountRow.username,
      role: accountRow.role as 'owner' | 'admin',
    },
  };
}

describe('T033 · profile 主档案数据库约束(data-model §2)', () => {
  afterEach(async () => {
    await cleanupRigs();
    Database.close();
  });

  /** 约束断言的隔离库:直接写库前先以权威迁移 DDL 建立独立临时库(不触碰真实 DATA_DIR) */
  async function freshDdlRig(): Promise<void> {
    await startFreshApp({ prefix: 'hmp-t033-ddl-' });
  }

  it('唯一索引 (household_id) WHERE is_main=1:同家庭第二个 is_main=1 插入被拒', async () => {
    await freshDdlRig();
    insertHousehold();
    insertAccount();
    insertProfile({ id: 'p-main-1', isMain: 1, pinHash: '$argon2id$hash-one' });

    expect(() => insertProfile({ id: 'p-main-2', isMain: 1, pinHash: '$argon2id$hash-two' })).toThrowError();
    // 非主档案不受影响
    expect(() => insertProfile({ id: 'p-plain', isMain: 0, pinHash: null })).not.toThrowError();
  });

  it('CHECK 主档案必须 adult+active+pin_hash 非空:儿童/停用/无 PIN 写 is_main=1 均被拒', async () => {
    await freshDdlRig();
    insertHousehold();
    insertAccount();

    expect(() => insertProfile({ id: 'p-child-main', type: 'child', isMain: 1, pinHash: '$argon2id$h' })).toThrowError();
    expect(() =>
      insertProfile({ id: 'p-disabled-main', status: 'disabled', isMain: 1, pinHash: '$argon2id$h' }),
    ).toThrowError();
    expect(() => insertProfile({ id: 'p-nopin-main', isMain: 1, pinHash: null })).toThrowError();
    // 合法主档案形态可插入
    expect(() => insertProfile({ id: 'p-ok-main', type: 'adult', status: 'active', isMain: 1, pinHash: '$argon2id$h' })).not.toThrowError();
  });

  it('pin_version >=1 default 1:初值为 1,可递增,<1 被拒', async () => {
    await freshDdlRig();
    insertHousehold();
    insertAccount();
    insertProfile({ id: 'p-v', pinHash: null });

    const row = Database.db.prepare('SELECT pin_version FROM profile WHERE id = ?').get('p-v') as {
      pin_version: number;
    };
    expect(row.pin_version).toBe(1);

    Database.db.prepare('UPDATE profile SET pin_version = pin_version + 1 WHERE id = ?').run('p-v');
    expect((Database.db.prepare('SELECT pin_version FROM profile WHERE id = ?').get('p-v') as { pin_version: number }).pin_version).toBe(2);

    expect(() => Database.db.prepare('UPDATE profile SET pin_version = 0 WHERE id = ?').run('p-v')).toThrowError();
  });
});

describe('T033 · 首次 bootstrap 创建主档案(data-model §2/§5)', () => {
  afterEach(async () => {
    await cleanupRigs();
    Database.close();
  });

  it('创建 main adult + 6 位 PIN 哈希 + 默认内容策略 + progress clock,但不设置 active_profile_id', async () => {
    const context = await loggedInContext('hmp-t033-bootstrap-');

    const summary = await bootstrapMainProfile(context, {
      name: '妈妈',
      pin: '246810',
      ownerPassword: INITIALIZE_BODY.password,
    });

    expect(summary.isMain).toBe(true);
    expect(summary.type).toBe('adult');
    expect(summary.pinProtected).toBe(true);
    expect(summary.version).toBe(1);

    const profileRow = Database.db
      .prepare('SELECT * FROM profile WHERE household_id = ?')
      .get(context.session.householdId) as Record<string, unknown>;
    expect(profileRow['is_main']).toBe(1);
    expect(profileRow['type']).toBe('adult');
    expect(profileRow['status']).toBe('active');
    expect(String(profileRow['pin_hash'])).toMatch(/^\$argon2id\$/);
    expect(profileRow['pin_version']).toBe(1);
    expect(JSON.stringify(profileRow)).not.toContain('246810');

    // 默认内容策略同事务创建(成人默认 18/true)
    const policyRow = Database.db
      .prepare('SELECT * FROM profile_policy WHERE profile_id = ?')
      .get(profileRow['id']) as Record<string, unknown>;
    expect(policyRow).toBeDefined();
    expect(policyRow['max_content_level']).toBe(18);
    expect(policyRow['allow_unrated']).toBe(1);

    // progress clock 同事务初始化(next_epoch=1)
    const clockRow = Database.db
      .prepare('SELECT * FROM profile_progress_clock WHERE profile_id = ?')
      .get(profileRow['id']) as Record<string, unknown>;
    expect(clockRow).toBeDefined();
    expect(clockRow['next_epoch']).toBe(1);

    // 不自动激活:设备会话 active_profile_id 保持 NULL
    const sessionRow = Database.db.prepare('SELECT active_profile_id FROM device_session WHERE id = ?').get(
      context.session.id,
    ) as { active_profile_id: string | null };
    expect(sessionRow.active_profile_id).toBeNull();
  });
});

describe('T033 · PIN 更新的事务级联(data-model §2 profile PIN 更新语义)', () => {
  afterEach(async () => {
    await cleanupRigs();
    Database.close();
  });

  it('清持久失败计数、撤销选档/设置授予、清空选用该档案的 active_profile_id 并递增其 contextVersion', async () => {
    const context = await loggedInContext('hmp-t033-pinreset-');
    const summary = await bootstrapMainProfile(context, {
      name: '妈妈',
      pin: '135790',
      ownerPassword: INITIALIZE_BODY.password,
    });
    const profileId = summary.id;
    const householdId = context.session.householdId;

    // 夹具:该档案处于 PIN 失败计数与锁定中
    Database.db
      .prepare('UPDATE profile SET failed_pin_count = 3, pin_locked_until = ? WHERE id = ?')
      .run(new Date(Date.now() + 60_000).toISOString(), profileId);
    // 夹具:当前会话正选用该档案 + 一行有效设置授予
    Database.db
      .prepare('UPDATE device_session SET active_profile_id = ? WHERE id = ?')
      .run(profileId, context.session.id);
    Database.db
      .prepare(
        `INSERT INTO settings_access_grant (household_id, device_session_id, profile_id, profile_context_version,
          pin_version, main_profile_version, issued_at, expires_at, revoked_at)
         VALUES (?, ?, ?, 1, 1, 1, ?, ?, NULL)`,
      )
      .run(householdId, context.session.id, profileId, NOW, new Date(Date.now() + 60_000).toISOString());

    await recoverMainProfilePin(context, { newPin: '987654', ownerPassword: INITIALIZE_BODY.password });

    const profileRow = Database.db.prepare('SELECT * FROM profile WHERE id = ?').get(profileId) as Record<string, unknown>;
    expect(profileRow['failed_pin_count']).toBe(0);
    expect(profileRow['pin_locked_until']).toBeNull();
    expect(profileRow['pin_version']).toBe(2);
    expect(String(profileRow['pin_hash'])).toMatch(/^\$argon2id\$/);

    const grantRow = Database.db
      .prepare('SELECT * FROM settings_access_grant WHERE device_session_id = ?')
      .get(context.session.id) as Record<string, unknown>;
    expect(grantRow).toBeDefined();
    expect(grantRow['revoked_at']).not.toBeNull();

    const sessionRow = Database.db.prepare('SELECT * FROM device_session WHERE id = ?').get(context.session.id) as {
      active_profile_id: string | null;
      profile_context_version: number;
    };
    expect(sessionRow.active_profile_id).toBeNull();
    // 清空选用该档案的身份 → contextVersion 递增(1 → 2)
    expect(sessionRow.profile_context_version).toBe(2);
  });
});
