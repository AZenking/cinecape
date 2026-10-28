import 'reflect-metadata';
import request from 'supertest';
import { afterEach, describe, expect, it } from 'vitest';
import { ProblemCode } from '@hmp/shared';
import { Database } from '@platform/database/database';
import type { SessionContext } from '@platform/http-common/current-session.decorator';
import { bootstrapMainProfile } from '@contexts/identity-access/application/bootstrap.service';
import {
  INITIALIZE_BODY,
  cleanupRigs,
  cookiePairOf,
  expectProblemContentType,
  initialize,
  login,
  startFreshApp,
} from '../helpers';

/**
 * T031(005 US2 契约测试,先 FAIL):POST /api/auth/bootstrap-profile 零档案首建。
 * 权威:docs/specs/005-pc-browsing-flow/contracts/api.md §3 bootstrap 行、§7 授权次序、
 * spec FR-030(2026-10-26 澄清 A)、ADR-0011 决议 2/6:
 * Session+管理角色+当次密码;201 仅 ProfileSummary(isMain/pinProtected),不自动选档;
 * 已有档案 409 BOOTSTRAP_ALREADY_DONE 不改写现值;响应不含一般设置数据;
 * 错误密码沿用既有错误计数与锁定(parentVerificationState 持久表)。
 */

interface Rig {
  app: Awaited<ReturnType<typeof startFreshApp>>['app'];
  cookie: string;
}

async function freshLoggedInRig(): Promise<Rig> {
  const rig = await startFreshApp({ prefix: 'hmp-t031-' });
  const initialized = await initialize(rig.app);
  expect(initialized.status).toBe(201);
  const loggedIn = await login(rig.app, INITIALIZE_BODY.username, INITIALIZE_BODY.password);
  expect(loggedIn.status).toBe(200);
  return { app: rig.app, cookie: cookiePairOf(loggedIn) };
}

function bootstrapProfile(rig: Rig, body: Record<string, unknown>): request.Test {
  return request(rig.app.getHttpServer()).post('/api/auth/bootstrap-profile').set('Cookie', rig.cookie).send(body);
}

function profileRowByHousehold(): Record<string, unknown> | undefined {
  return Database.db.prepare('SELECT * FROM profile ORDER BY created_at LIMIT 1').get() as
    | Record<string, unknown>
    | undefined;
}

const VALID_BOOTSTRAP = { name: '妈妈', pin: '135790', ownerPassword: INITIALIZE_BODY.password } as const;

describe('T031 · POST /auth/bootstrap-profile 零档案首建(005 FR-030/029)', () => {
  afterEach(cleanupRigs);

  it('零档案会话首建 201 ProfileSummary(isMain=true、pinProtected=true、6 位 PIN 落库仅哈希);随后 GET /auth/session 的 activeProfile 仍为 null', async () => {
    const rig = await freshLoggedInRig();

    const res = await bootstrapProfile(rig, { ...VALID_BOOTSTRAP });

    expect(res.status).toBe(201);
    // 响应仅 ProfileSummary 白名单投影(api.md §3 ProfileSummary 精确字段)
    expect(res.body).toEqual({
      id: expect.any(String),
      name: '妈妈',
      avatar: null,
      type: 'adult',
      isDefault: true,
      isMain: true,
      pinProtected: true,
      status: 'active',
      createdAt: expect.any(String),
      version: 1,
    });
    // 6 位数字 PIN 仅落 argon2id 哈希
    const row = profileRowByHousehold();
    expect(row?.['is_main']).toBe(1);
    expect(row?.['pin_hash']).toMatch(/^\$argon2id\$/);
    expect(JSON.stringify(row)).not.toContain('135790');
    expect(row?.['pin_version']).toBe(1);

    // 不自动激活:bootstrap 后当前 Profile 仍为 null
    const session = await request(rig.app.getHttpServer()).get('/api/auth/session').set('Cookie', rig.cookie);
    expect(session.status).toBe(200);
    expect(session.body.activeProfile).toBeNull();
    // bootstrapRequired 仅表示零档案:已建档后翻转为 false(不混入账号初始化语义)
    expect(session.body.bootstrapRequired).toBe(false);
    expect(typeof session.body.householdId).toBe('string');
    expect(session.body.profileContextVersion).toBe(1);
  });

  it('已有档案再提交 → 409 BOOTSTRAP_ALREADY_DONE 且不改写现值(原 is_main、pin_version 不变,不新建档案)', async () => {
    const rig = await freshLoggedInRig();
    expect((await bootstrapProfile(rig, { ...VALID_BOOTSTRAP })).status).toBe(201);
    const before = profileRowByHousehold();

    const res = await bootstrapProfile(rig, { name: '再建一个', pin: '246810', ownerPassword: INITIALIZE_BODY.password });

    expect(res.status).toBe(409);
    expectProblemContentType(res);
    expect(res.body.code).toBe('BOOTSTRAP_ALREADY_DONE');
    const after = profileRowByHousehold();
    expect(after?.['id']).toBe(before?.['id']);
    expect(after?.['is_main']).toBe(before?.['is_main']);
    expect(after?.['pin_version']).toBe(before?.['pin_version']);
    expect(after?.['name']).toBe(before?.['name']);
    expect(Database.db.prepare('SELECT COUNT(*) AS c FROM profile').get()).toEqual({ c: 1 });
  });

  it('PIN 非 6 位数字 → 400 VALIDATION_FAILED', async () => {
    const rig = await freshLoggedInRig();

    for (const pin of ['12345', '1234567', '12345a', 'abcdef', '']) {
      const res = await bootstrapProfile(rig, { name: '妈妈', pin, ownerPassword: INITIALIZE_BODY.password });
      expect(res.status, `pin=${JSON.stringify(pin)} 应 400`).toBe(400);
      expect(res.body.code).toBe(ProblemCode.VALIDATION_FAILED);
    }
    expect(profileRowByHousehold()).toBeUndefined();
  });

  it('未登录 → 401 SESSION_INVALID(problem+json)', async () => {
    const { app } = await startFreshApp({ prefix: 'hmp-t031-' });

    const res = await request(app.getHttpServer()).post('/api/auth/bootstrap-profile').send({ ...VALID_BOOTSTRAP });

    expect(res.status).toBe(401);
    expectProblemContentType(res);
    expect(res.body.code).toBe(ProblemCode.SESSION_INVALID);
  });

  it('有效会话但非管理角色 → 403(本代际 DB CHECK 仅允许 owner/admin,无法经真实登录构造,服务级构造断言)', async () => {
    const rig = await freshLoggedInRig();
    // 从会话上下文派生伪造上下文:role 越出管理集合(运行时防御分支)
    const session = await request(rig.app.getHttpServer()).get('/api/auth/session').set('Cookie', rig.cookie);
    const context = {
      session: {
        id: session.body.sessionId as string,
        householdId: session.body.householdId as string,
        accountId: (session.body.account as { id: string }).id,
        deviceId: 'device-fabricated',
        activeProfileId: null,
        expiresAt: session.body.expiresAt as string,
      },
      account: {
        id: (session.body.account as { id: string }).id,
        householdId: session.body.householdId as string,
        username: 'admin',
        role: 'viewer' as unknown as 'owner' | 'admin',
      },
    } satisfies SessionContext;

    let caught: unknown = null;
    try {
      await bootstrapMainProfile(context, { name: '妈妈', pin: '135790', ownerPassword: INITIALIZE_BODY.password });
    } catch (error) {
      caught = error;
    }
    expect((caught as { status: number }).status).toBe(403);
    expect((caught as { code: string }).code).toBe(ProblemCode.FORBIDDEN);
    expect(profileRowByHousehold()).toBeUndefined();
  });

  it('缺少必填 ownerPassword → 400 VALIDATION_FAILED(先于密码验证);合法格式但密码错误 → 403', async () => {
    const rig = await freshLoggedInRig();

    const missing = await bootstrapProfile(rig, { name: '妈妈', pin: '135790' });
    expect(missing.status).toBe(400);
    expect(missing.body.code).toBe(ProblemCode.VALIDATION_FAILED);

    const wrong = await bootstrapProfile(rig, { name: '妈妈', pin: '135790', ownerPassword: 'totally-wrong-pass' });
    expect(wrong.status).toBe(403);
    expectProblemContentType(wrong);
    expect(wrong.body.code).toBe(ProblemCode.PARENT_VERIFICATION_FAILED);
    expect(profileRowByHousehold()).toBeUndefined();
  });

  it('bootstrap 响应不含策略、来源、设备等一般设置数据(仅 ProfileSummary 投影)', async () => {
    const rig = await freshLoggedInRig();

    const res = await bootstrapProfile(rig, { ...VALID_BOOTSTRAP });

    expect(res.status).toBe(201);
    const serialized = JSON.stringify(res.body);
    for (const forbidden of ['maxContentLevel', 'allowUnrated', 'policy', 'source', 'device', 'pinHash', 'pin_hash', 'failedPinCount', 'sessionToken', 'settings']) {
      expect(serialized, `响应不得包含 ${forbidden}`).not.toContain(forbidden);
    }
  });

  it('错误密码沿用既有错误计数与锁定:连续 5 次错误后,正确密码也 423,且跨新会话保留(持久化计数)', async () => {
    const rig = await freshLoggedInRig();

    for (let attempt = 0; attempt < 5; attempt += 1) {
      const res = await bootstrapProfile(rig, { name: '妈妈', pin: '135790', ownerPassword: `wrong-pass-${attempt}` });
      expect(res.status).toBe(403);
      expect(res.body.code).toBe(ProblemCode.PARENT_VERIFICATION_FAILED);
    }

    // 第 6 次(密码正确)→ 锁定 423,不消耗验证
    const locked = await bootstrapProfile(rig, { ...VALID_BOOTSTRAP });
    expect(locked.status).toBe(423);
    expectProblemContentType(locked);
    expect(locked.body.code).toBe(ProblemCode.PARENT_VERIFICATION_LOCKED);
    expect(profileRowByHousehold()).toBeUndefined();

    // 换新会话(重新登录)计数仍保留:锁定状态与登录会话无关(持久化在家庭+账号维度)
    const reLoggedIn = await login(rig.app, INITIALIZE_BODY.username, INITIALIZE_BODY.password);
    expect(reLoggedIn.status).toBe(200);
    const newRig: Rig = { app: rig.app, cookie: cookiePairOf(reLoggedIn) };
    const stillLocked = await bootstrapProfile(newRig, { ...VALID_BOOTSTRAP });
    expect(stillLocked.status).toBe(423);
    expect(stillLocked.body.code).toBe(ProblemCode.PARENT_VERIFICATION_LOCKED);
  });

  it('主档案 PIN 恢复(窄用途):owner+当次密码+newPin → 204;重设 PIN、清锁定、递增 pin_version;不返回管理主体', async () => {
    const rig = await freshLoggedInRig();
    expect((await bootstrapProfile(rig, { ...VALID_BOOTSTRAP })).status).toBe(201);
    const before = profileRowByHousehold();

    const recovery = await request(rig.app.getHttpServer())
      .post('/api/auth/main-profile/pin-recovery')
      .set('Cookie', rig.cookie)
      .send({ newPin: '246810', ownerPassword: INITIALIZE_BODY.password });

    expect(recovery.status).toBe(204);
    expect(recovery.text).toBe('');
    const after = profileRowByHousehold();
    expect(after?.['id']).toBe(before?.['id']);
    expect(after?.['pin_version']).toBe((before?.['pin_version'] as number) + 1);
    // 新 PIN 可验证语义:旧哈希被替换(不携带旧哈希值)
    expect(after?.['pin_hash']).not.toBe(before?.['pin_hash']);
  });
});
