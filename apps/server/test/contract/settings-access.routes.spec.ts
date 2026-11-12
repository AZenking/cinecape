import { afterEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { ProblemCode } from '@hmp/shared';
import {
  INITIALIZE_BODY,
  cleanupRigs,
  cookiePairOf,
  expectProblemContentType,
  initialize,
  login,
  type TestRig,
} from '../helpers';
import { cleanupSettingsRigs, startSettingsApp } from '../helpers-settings';
import { ensureSettingsUnlocked } from '../helpers-management';

/**
 * T075(005 US7 契约测试,先 FAIL):/settings/access 三端点分层语义。
 * 权威:docs/specs/005-pc-browsing-flow/contracts/api.md §6(独立入口)/§7。
 *
 * - GET 仅 Session:任何有效会话(含未选档/普通 Profile)200 最小 SettingsAccess,
 *   无有效授予 unlocked=false、expiresAt=null,不读管理主体;
 * - POST 要求 Session+管理角色+当前主 Profile+正确 PIN,但不得要求已有 grant;
 *   未选档/普通档案 403、PIN 锁定 423、未知 body 400;
 * - DELETE 仅 Session、204 幂等;
 * - 游客/无效会话三种操作全部 401。
 */

const MAIN_PIN = '135790';
const OTHER_PIN = '246800';

interface Rig {
  app: TestRig['app'];
  ownerCookie: string;
  mainProfileId: string;
}

async function setupRig(): Promise<Rig> {
  const rig = await startSettingsApp({ prefix: 'hmp-t075-' });
  expect((await initialize(rig.app)).status).toBe(201);
  const loggedIn = await login(rig.app, INITIALIZE_BODY.username, INITIALIZE_BODY.password);
  expect(loggedIn.status).toBe(200);
  const cookie = cookiePairOf(loggedIn);
  const bootstrapped = await request(rig.app.getHttpServer())
    .post('/api/auth/bootstrap-profile')
    .set('Cookie', cookie)
    .send({ name: '妈妈', pin: MAIN_PIN, ownerPassword: INITIALIZE_BODY.password });
  expect(bootstrapped.status).toBe(201);
  return { app: rig.app, ownerCookie: cookie, mainProfileId: (bootstrapped.body as { id: string }).id };
}

async function selectProfile(rig: Rig, profileId: string, pin: string): Promise<void> {
  const unlock = await request(rig.app.getHttpServer())
    .post(`/api/profiles/${profileId}/unlock`)
    .set('Cookie', rig.ownerCookie)
    .send({ pin });
  expect(unlock.status, JSON.stringify(unlock.body)).toBe(200);
  const select = await request(rig.app.getHttpServer())
    .post(`/api/profiles/${profileId}/select`)
    .set('Cookie', rig.ownerCookie)
    .send({});
  expect(select.status).toBe(200);
}

async function createOrdinaryProfile(rig: Rig, body: { name: string; type: 'adult' | 'child'; pin: string }): Promise<string> {
  await ensureSettingsUnlocked(rig.app, rig.ownerCookie);
  const res = await request(rig.app.getHttpServer())
    .post('/api/settings/profiles')
    .set('Cookie', rig.ownerCookie)
    .send(body);
  expect(res.status).toBe(201);
  return (res.body as { id: string }).id;
}

function getAccess(rig: Rig, cookie: string | null): request.Test {
  const builder = request(rig.app.getHttpServer()).get('/api/settings/access');
  return cookie === null ? builder : builder.set('Cookie', cookie);
}

function postAccess(rig: Rig, cookie: string | null, body: Record<string, unknown>): request.Test {
  const builder = request(rig.app.getHttpServer()).post('/api/settings/access');
  return (cookie === null ? builder : builder.set('Cookie', cookie)).send(body);
}

function deleteAccess(rig: Rig, cookie: string | null): request.Test {
  const builder = request(rig.app.getHttpServer()).delete('/api/settings/access');
  return cookie === null ? builder : builder.set('Cookie', cookie);
}

describe('T075 · /settings/access 分层契约(contracts/api.md §6/§7)', () => {
  afterEach(async () => {
    await cleanupRigs();
    await cleanupSettingsRigs();
  });

  it('游客/无效会话:GET/POST/DELETE 全部 401 SESSION_INVALID(problem+json)', async () => {
    const rig = await setupRig();
    for (const act of [
      () => getAccess(rig, null),
      () => postAccess(rig, null, { pin: MAIN_PIN }),
      () => deleteAccess(rig, null),
    ]) {
      const res = await act();
      expect(res.status).toBe(401);
      expectProblemContentType(res);
      expect((res.body as { code: string }).code).toBe(ProblemCode.SESSION_INVALID);
    }
    // 已失效会话(注销后)同样 401,不是 403
    const loggedIn = await login(rig.app, INITIALIZE_BODY.username, INITIALIZE_BODY.password);
    const stale = cookiePairOf(loggedIn);
    await request(rig.app.getHttpServer()).post('/api/auth/logout').set('Cookie', stale).send({});
    expect((await getAccess(rig, stale)).status).toBe(401);
    expect((await postAccess(rig, stale, { pin: MAIN_PIN })).status).toBe(401);
    expect((await deleteAccess(rig, stale)).status).toBe(401);
  });

  it('未选档有效会话:GET 200 最小状态(unlocked=false);POST 403 不读管理主体;DELETE 204 幂等', async () => {
    const rig = await setupRig();
    const status = await getAccess(rig, rig.ownerCookie);
    expect(status.status).toBe(200);
    expect(status.body).toEqual({ unlocked: false, expiresAt: null }); // 最小 SettingsAccess

    // POST 不得要求已有 grant,但要求当前主 Profile:未选档 403(密码正确的 PIN 也不放行)
    const post = await postAccess(rig, rig.ownerCookie, { pin: MAIN_PIN });
    expect(post.status).toBe(403);

    // DELETE 仅 Session:无授予也 204(幂等)
    expect((await deleteAccess(rig, rig.ownerCookie)).status).toBe(204);
    expect((await deleteAccess(rig, rig.ownerCookie)).status).toBe(204);
    expect((await getAccess(rig, rig.ownerCookie)).body).toEqual({ unlocked: false, expiresAt: null });
  });

  it('普通(非主)档案:GET 仍 200 最小状态;POST 正确 PIN 也 403;未知 body 400 优先于业务判定', async () => {
    const rig = await setupRig();
    const ordinaryId = await createOrdinaryProfile(rig, { name: '爸爸', type: 'adult', pin: OTHER_PIN });
    await selectProfile(rig, ordinaryId, OTHER_PIN);

    expect((await getAccess(rig, rig.ownerCookie)).body).toEqual({ unlocked: false, expiresAt: null });
    const post = await postAccess(rig, rig.ownerCookie, { pin: OTHER_PIN });
    expect(post.status).toBe(403); // 档案满足但非主档案:403,不是 401
    expect((await getAccess(rig, rig.ownerCookie)).body).toEqual({ unlocked: false, expiresAt: null });

    // 严格入参:未知字段 400(§1);非 6 位数字 400
    expect((await postAccess(rig, rig.ownerCookie, { pin: OTHER_PIN, profileId: ordinaryId })).status).toBe(400);
    expect((await postAccess(rig, rig.ownerCookie, { pin: '12345' })).status).toBe(400);
  });

  it('主 Profile:POST 正确 PIN 签发(不得要求已有 grant);重验证返回原到期时间;GET/DELETE 语义', async () => {
    const rig = await setupRig();
    await selectProfile(rig, rig.mainProfileId, MAIN_PIN);

    // 错误 PIN:403(剩余次数),不签发
    const wrong = await postAccess(rig, rig.ownerCookie, { pin: '000000' });
    expect(wrong.status).toBe(403);

    // 正确 PIN:200 SettingsAccess(服务器时间),此前无任何 grant
    const ok = await postAccess(rig, rig.ownerCookie, { pin: MAIN_PIN });
    expect(ok.status).toBe(200);
    expect((ok.body as { unlocked: boolean; expiresAt: string | null }).unlocked).toBe(true);
    const firstExpiresAt = (ok.body as { expiresAt: string }).expiresAt;
    expect(firstExpiresAt).toEqual(expect.any(String));

    // 有效期内再次验证:成功重验返回原到期时间,不续期(data-model §3)
    const again = await postAccess(rig, rig.ownerCookie, { pin: MAIN_PIN });
    expect(again.status).toBe(200);
    expect((again.body as { expiresAt: string }).expiresAt).toBe(firstExpiresAt);

    // GET 不读管理主体、不续期:同一 expiresAt
    const status = await getAccess(rig, rig.ownerCookie);
    expect(status.status).toBe(200);
    expect(status.body).toEqual({ unlocked: true, expiresAt: firstExpiresAt });

    // DELETE:撤销当前授予 → 最小状态回到未解锁;幂等 204
    expect((await deleteAccess(rig, rig.ownerCookie)).status).toBe(204);
    expect((await getAccess(rig, rig.ownerCookie)).body).toEqual({ unlocked: false, expiresAt: null });
    expect((await deleteAccess(rig, rig.ownerCookie)).status).toBe(204);

    // 撤销后再验证成功可重新签发(新到期时间 ≥ 原值)
    const reissued = await postAccess(rig, rig.ownerCookie, { pin: MAIN_PIN });
    expect(reissued.status).toBe(200);
    expect(Date.parse((reissued.body as { expiresAt: string }).expiresAt)).toBeGreaterThanOrEqual(
      Date.parse(firstExpiresAt),
    );
  });

  it('连续 5 次错误 PIN → 423 PROFILE_PIN_LOCKED(锁定内正确 PIN 同样拒绝)', async () => {
    const rig = await setupRig();
    await selectProfile(rig, rig.mainProfileId, MAIN_PIN);
    for (let i = 0; i < 5; i += 1) {
      expect((await postAccess(rig, rig.ownerCookie, { pin: '000000' })).status).toBe(403);
    }
    const locked = await postAccess(rig, rig.ownerCookie, { pin: MAIN_PIN });
    expect(locked.status).toBe(423);
    expectProblemContentType(locked);
    expect((locked.body as { code: string }).code).toBe(ProblemCode.PROFILE_PIN_LOCKED);
    expect((await getAccess(rig, rig.ownerCookie)).body).toEqual({ unlocked: false, expiresAt: null });
  });
});
