import 'reflect-metadata';
import request from 'supertest';
import { afterEach, describe, expect, it } from 'vitest';
import { ProblemCode } from '@hmp/shared';
import { Database } from '../../src/database/database';
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
 * T032(005 US2 契约测试,先 FAIL):最小选档接口。
 * 权威:docs/specs/005-pc-browsing-flow/contracts/api.md §3(GET /profiles、
 * POST /profiles/{id}/unlock、POST /profiles/{id}/select)、§7、data-model §2
 * (profile_context_version 实际换档递增/A→B→A 至少两次/同档案重选不递增)。
 */

interface Rig {
  app: Awaited<ReturnType<typeof startFreshApp>>['app'];
  cookie: string;
  sessionId: string;
}

async function setupRig(): Promise<Rig> {
  const rig = await startFreshApp({ prefix: 'hmp-t032-' });
  const initialized = await initialize(rig.app);
  expect(initialized.status).toBe(201);
  const loggedIn = await login(rig.app, INITIALIZE_BODY.username, INITIALIZE_BODY.password);
  expect(loggedIn.status).toBe(200);
  return {
    app: rig.app,
    cookie: cookiePairOf(loggedIn),
    sessionId: (loggedIn.body as { sessionId: string }).sessionId,
  };
}

async function bootstrapMain(rig: Rig, name = '妈妈', pin = '111111'): Promise<string> {
  const res = await request(rig.app.getHttpServer())
    .post('/api/auth/bootstrap-profile')
    .set('Cookie', rig.cookie)
    .send({ name, pin, ownerPassword: INITIALIZE_BODY.password });
  expect(res.status).toBe(201);
  return (res.body as { id: string }).id;
}

/** 经既有管理接口(US8 才迁移)创建供选档用的普通档案 */
async function createProfileViaApi(
  rig: Rig,
  body: { name: string; type: 'adult' | 'child'; pin?: string },
): Promise<{ id: string }> {
  const res = await request(rig.app.getHttpServer())
    .post('/api/profiles')
    .set('Cookie', rig.cookie)
    .send({ ...body, ownerPassword: INITIALIZE_BODY.password });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body as { id: string };
}

function listProfiles(rig: Rig): request.Test {
  return request(rig.app.getHttpServer()).get('/api/profiles').set('Cookie', rig.cookie);
}

function unlockProfile(rig: Rig, profileId: string, body: Record<string, unknown>): request.Test {
  return request(rig.app.getHttpServer())
    .post(`/api/profiles/${profileId}/unlock`)
    .set('Cookie', rig.cookie)
    .send(body);
}

function selectProfile(rig: Rig, profileId: string, body: Record<string, unknown> = {}): request.Test {
  return request(rig.app.getHttpServer())
    .post(`/api/profiles/${profileId}/select`)
    .set('Cookie', rig.cookie)
    .send(body);
}

async function currentContextVersion(rig: Rig): Promise<number> {
  const res = await request(rig.app.getHttpServer()).get('/api/auth/session').set('Cookie', rig.cookie);
  expect(res.status).toBe(200);
  return (res.body as { profileContextVersion: number }).profileContextVersion;
}

function sessionRowOf(sessionId: string): { profile_context_version: number; active_profile_id: string | null } {
  return Database.db
    .prepare('SELECT profile_context_version, active_profile_id FROM device_session WHERE id = ?')
    .get(sessionId) as { profile_context_version: number; active_profile_id: string | null };
}

const SUMMARY_KEYS = ['id', 'name', 'avatar', 'type', 'isDefault', 'isMain', 'pinProtected', 'status', 'createdAt', 'version'] as const;

describe('T032 · 最小选档接口(005 FR-008)', () => {
  afterEach(cleanupRigs);

  it('GET /profiles 仅返回选档摘要白名单字段;禁用档案可见;不含策略/锁定计数/失败日志', async () => {
    const rig = await setupRig();
    const mainId = await bootstrapMain(rig);
    const child = await createProfileViaApi(rig, { name: '弟弟', type: 'child', pin: '333333' });
    const disabled = await createProfileViaApi(rig, { name: '停用者', type: 'adult' });
    const patch = await request(rig.app.getHttpServer())
      .patch(`/api/profiles/${disabled.id}`)
      .set('Cookie', rig.cookie)
      .send({ status: 'disabled', ownerPassword: INITIALIZE_BODY.password });
    expect(patch.status).toBe(200);

    const res = await listProfiles(rig);

    expect(res.status).toBe(200);
    const items = res.body as Array<Record<string, unknown>>;
    expect(items).toHaveLength(3);
    for (const item of items) {
      expect(Object.keys(item).sort()).toEqual([...SUMMARY_KEYS].sort());
    }
    const byId = new Map(items.map((item) => [item.id, item]));
    expect(byId.get(mainId)).toMatchObject({ name: '妈妈', isMain: true, pinProtected: true, type: 'adult', status: 'active' });
    // 禁用档案可见但携带 disabled 状态
    expect(byId.get(disabled.id)).toMatchObject({ name: '停用者', status: 'disabled' });
    expect(byId.get(child.id)).toMatchObject({ name: '弟弟', pinProtected: true, status: 'active' });
    // 不返回策略/锁定计数/失败日志等设置主体
    const serialized = JSON.stringify(items);
    for (const forbidden of ['maxContentLevel', 'allowUnrated', 'allowedMediaIds', 'failedPinCount', 'pinLockedUntil', 'pinHash', 'pin_hash', 'policy']) {
      expect(serialized, `选档摘要不得包含 ${forbidden}`).not.toContain(forbidden);
    }
  });

  it('正确 PIN unlock 200(一次性选档授予)→ select 200 SessionDto;受 PIN 保护档案未 unlock 直接 select 被拒', async () => {
    const rig = await setupRig();
    const mainId = await bootstrapMain(rig);

    // 未 unlock 直接 select → 拒绝(PROFILE_PIN_REQUIRED)
    const direct = await selectProfile(rig, mainId);
    expect(direct.status).toBe(403);
    expectProblemContentType(direct);
    expect(direct.body.code).toBe(ProblemCode.PROFILE_PIN_REQUIRED);
    expect(sessionRowOf(rig.sessionId).active_profile_id).toBeNull();

    const unlock = await unlockProfile(rig, mainId, { pin: '111111' });
    expect(unlock.status).toBe(200);
    expect(unlock.body).toEqual({ unlocked: true });

    const select = await selectProfile(rig, mainId);
    expect(select.status).toBe(200);
    expect(select.body).toEqual({
      sessionId: rig.sessionId,
      account: { id: expect.any(String), username: INITIALIZE_BODY.username, role: 'owner' },
      activeProfile: {
        id: mainId,
        name: '妈妈',
        avatar: null,
        type: 'adult',
        isDefault: true,
        isMain: true,
        pinProtected: true,
        status: 'active',
        createdAt: expect.any(String),
        version: 1,
      },
      expiresAt: expect.any(String),
      householdId: expect.any(String),
      bootstrapRequired: false,
      profileContextVersion: expect.any(Number),
    });
    // 契约:sessionToken 仅登录响应出现一次
    expect(select.body).not.toHaveProperty('sessionToken');
    // 换档真实生效
    expect(sessionRowOf(rig.sessionId).active_profile_id).toBe(mainId);
  });

  it('连续 5 次错误 PIN 后 423 PROFILE_PIN_LOCKED:锁定跨刷新、跨新会话保留;篡改请求体 400;换新会话不清零计数', async () => {
    const rig = await setupRig();
    await bootstrapMain(rig);
    const child = await createProfileViaApi(rig, { name: '弟弟', type: 'child', pin: '333333' });

    // 篡改请求体(伪造身份声明字段)→ 400,不能借此解锁
    const tampered = await unlockProfile(rig, child.id, { pin: '000000', householdId: 'fake', isAdmin: true });
    expect(tampered.status).toBe(400);
    expect(tampered.body.code).toBe(ProblemCode.VALIDATION_FAILED);

    // 连续 5 次错误:每次 403(detail 仅剩余次数)
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const wrong = await unlockProfile(rig, child.id, { pin: '000000' });
      expect(wrong.status).toBe(403);
      expect(wrong.body.code).toBe(ProblemCode.FORBIDDEN);
    }
    // 第 6 次(即使 PIN 正确)→ 423 PROFILE_PIN_LOCKED
    const locked = await unlockProfile(rig, child.id, { pin: '333333' });
    expect(locked.status).toBe(423);
    expectProblemContentType(locked);
    expect(locked.body.code).toBe(ProblemCode.PROFILE_PIN_LOCKED);

    // 跨刷新(同一会话再次请求)仍 423
    const again = await unlockProfile(rig, child.id, { pin: '333333' });
    expect(again.status).toBe(423);

    // 跨新会话(重新登录)仍 423:计数持久化,换会话不清零
    const reLogin = await login(rig.app, INITIALIZE_BODY.username, INITIALIZE_BODY.password);
    expect(reLogin.status).toBe(200);
    const newRig: Rig = { app: rig.app, cookie: cookiePairOf(reLogin), sessionId: (reLogin.body as { sessionId: string }).sessionId };
    const crossSession = await unlockProfile(newRig, child.id, { pin: '333333' });
    expect(crossSession.status).toBe(423);
    expect(crossSession.body.code).toBe(ProblemCode.PROFILE_PIN_LOCKED);
    // 423 而非 401:新会话本身有效(否则 SessionGuard 先 401),被拒的是持久化的 PIN 锁定
  });

  it('select 换档矩阵:实际换档递增 profileContextVersion,同一有效档案重选不递增;A→B→A 至少递增两次', async () => {
    const rig = await setupRig();
    const mainId = await bootstrapMain(rig, '妈妈', '111111');
    const b = await createProfileViaApi(rig, { name: '爸爸', type: 'adult' });

    const v0 = await currentContextVersion(rig);
    expect(v0).toBe(1);

    // 空档 → 妈妈(实际换档):1 → 2
    expect((await unlockProfile(rig, mainId, { pin: '111111' })).status).toBe(200);
    const toMain = await selectProfile(rig, mainId);
    expect(toMain.status).toBe(200);
    expect((toMain.body as { profileContextVersion: number }).profileContextVersion).toBe(2);
    expect(sessionRowOf(rig.sessionId).profile_context_version).toBe(2);

    // 妈妈 → 爸爸(实际换档):2 → 3
    const toB = await selectProfile(rig, b.id);
    expect(toB.status).toBe(200);
    expect((toB.body as { profileContextVersion: number }).profileContextVersion).toBe(3);

    // 同一有效档案重选:200 但不递增
    const reSelectB = await selectProfile(rig, b.id);
    expect(reSelectB.status).toBe(200);
    expect((reSelectB.body as { profileContextVersion: number }).profileContextVersion).toBe(3);
    expect(sessionRowOf(rig.sessionId).profile_context_version).toBe(3);

    // 爸爸 → 妈妈(A→B→A):3 → 4(仅比较最终 activeProfileId 的实现必须在此失败)
    expect((await unlockProfile(rig, mainId, { pin: '111111' })).status).toBe(200);
    const backToMain = await selectProfile(rig, mainId);
    expect(backToMain.status).toBe(200);
    expect((backToMain.body as { profileContextVersion: number }).profileContextVersion).toBe(4);
    expect(sessionRowOf(rig.sessionId).profile_context_version).toBe(4);
  });

  it('伪造身份声明:body 携带 householdId/profileId/isAdmin 等未知字段一律 400;目标不存在统一 404;禁用档案可见但 select 拒绝', async () => {
    const rig = await setupRig();
    const mainId = await bootstrapMain(rig);
    const disabled = await createProfileViaApi(rig, { name: '停用者', type: 'adult' });
    await request(rig.app.getHttpServer())
      .patch(`/api/profiles/${disabled.id}`)
      .set('Cookie', rig.cookie)
      .send({ status: 'disabled', ownerPassword: INITIALIZE_BODY.password });

    // 伪造声明字段 → 400(不能借此扩大权限或切换身份)
    for (const forged of [
      { householdId: 'fake-household' },
      { profileId: mainId, householdId: 'fake-household' },
      { isAdmin: true },
    ]) {
      const res = await selectProfile(rig, mainId, forged);
      expect(res.status, `伪造字段应 400:${JSON.stringify(forged)}`).toBe(400);
      expect(res.body.code).toBe(ProblemCode.VALIDATION_FAILED);
    }

    // 目标不存在 → 404(跨家庭同形 404,不泄露存在性;单家庭部署下「跨家庭」与「不存在」同形)
    const missing = await selectProfile(rig, '00000000-0000-4000-8000-000000000000');
    expect(missing.status).toBe(404);
    expectProblemContentType(missing);
    expect(missing.body.code).toBe(ProblemCode.NOT_FOUND);

    // 禁用档案可见(GET)但 select 拒绝
    const list = await listProfiles(rig);
    expect((list.body as Array<{ id: string; status: string }>).some((p) => p.id === disabled.id && p.status === 'disabled')).toBe(true);
    const rejected = await selectProfile(rig, disabled.id);
    expect(rejected.status).toBe(403);
    expect(rejected.body.code).toBe(ProblemCode.PROFILE_NOT_SELECTABLE);
    expect(sessionRowOf(rig.sessionId).active_profile_id).toBeNull();
  });
});
