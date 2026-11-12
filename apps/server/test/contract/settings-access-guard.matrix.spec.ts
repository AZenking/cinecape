import { afterEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { ProblemCode } from '@hmp/shared';
import { Database } from '@platform/database/database';
import {
  INITIALIZE_BODY,
  cleanupRigs,
  cookiePairOf,
  expectProblemContentType,
  initialize,
  login,
} from '../helpers';
import { ensureSettingsUnlocked } from '../helpers-management';
import { cleanupSettingsRigs, restartSettingsApp, startSettingsApp, type SettingsTestRig } from '../helpers-settings';

/**
 * T076(005 US7 契约测试,depends on T075):SettingsAccessGuard 失效矩阵。
 * 权威:docs/specs/005-pc-browsing-flow/contracts/api.md §6/§7、data-model §3、ADR-0011 决议 3。
 *
 * GET /settings/account 为「一般设置主体」代表(挂 SessionGuard + SettingsAccessGuard):
 * - 有效 Session 但 grant 过期/换档/目标停用/主档案变化/PIN 更新 → 403(SETTINGS_*);
 * - 注销/会话设备撤销(Session 失效)→ 先 401 SESSION_INVALID,不得强行 403;
 * - A→B→A 不复活;固定 15 分钟不滑动;应用启动撤销全部 grants;
 * - /settings/access 最小状态接口按 T075 单独处理:主体 403 时仍 200 unlocked=false。
 *
 * 主档案转移/PIN 更新等 US8 管理写路由尚未交付,矩阵以与其同事务语义的直接
 * DB 变更模拟(pin_version / main_profile_version 递增),验证 Guard 的逐请求
 * 版本重检 —— api.md §7「服务端逐请求版本检查作竞态兜底」的授权失效路径。
 */

const MAIN_PIN = '135790';
const CHILD_PIN = '246800';

interface Rig {
  rig: SettingsTestRig;
  cookie: string;
  mainProfileId: string;
  childProfileId: string;
  deviceId: string;
}

async function setupRig(): Promise<Rig> {
  const rig = await startSettingsApp({ prefix: 'hmp-t076-' });
  expect((await initialize(rig.app)).status).toBe(201);
  const loggedIn = await login(rig.app, INITIALIZE_BODY.username, INITIALIZE_BODY.password);
  expect(loggedIn.status).toBe(200);
  const cookie = cookiePairOf(loggedIn);
  const bootstrapped = await request(rig.app.getHttpServer())
    .post('/api/auth/bootstrap-profile')
    .set('Cookie', cookie)
    .send({ name: '妈妈', pin: MAIN_PIN, ownerPassword: INITIALIZE_BODY.password });
  expect(bootstrapped.status).toBe(201);
  const mainProfileId = (bootstrapped.body as { id: string }).id;
  // US8:子档案创建属管理写,前置 = 主档案选中 + 设置解锁
  await ensureSettingsUnlocked(rig.app, cookie, { mainPin: MAIN_PIN });
  const child = await request(rig.app.getHttpServer())
    .post('/api/settings/profiles')
    .set('Cookie', cookie)
    .send({ name: '儿童档案', type: 'child', pin: CHILD_PIN });
  expect(child.status).toBe(201);
  const childProfileId = (child.body as { id: string }).id;
  await selectProfile(rig.app, cookie, mainProfileId, MAIN_PIN);
  const devices = await request(rig.app.getHttpServer()).get('/api/settings/devices').set('Cookie', cookie);
  expect(devices.status).toBe(200);
  const deviceId = (devices.body as Array<{ id: string }>)[0]!.id;
  return { rig, cookie, mainProfileId, childProfileId, deviceId };
}

async function selectProfile(
  app: SettingsTestRig['app'],
  cookie: string,
  profileId: string,
  pin: string,
): Promise<void> {
  const unlock = await request(app.getHttpServer())
    .post(`/api/profiles/${profileId}/unlock`)
    .set('Cookie', cookie)
    .send({ pin });
  expect(unlock.status, JSON.stringify(unlock.body)).toBe(200);
  const select = await request(app.getHttpServer())
    .post(`/api/profiles/${profileId}/select`)
    .set('Cookie', cookie)
    .send({});
  expect(select.status).toBe(200);
}

async function unlockSettings(rig: Rig): Promise<string> {
  const res = await request(rig.rig.app.getHttpServer())
    .post('/api/settings/access')
    .set('Cookie', rig.cookie)
    .send({ pin: MAIN_PIN });
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return (res.body as { expiresAt: string }).expiresAt;
}

function getAccount(rig: Rig): request.Test {
  return request(rig.rig.app.getHttpServer()).get('/api/settings/account').set('Cookie', rig.cookie);
}

function getAccessStatus(rig: Rig): request.Test {
  return request(rig.rig.app.getHttpServer()).get('/api/settings/access').set('Cookie', rig.cookie);
}

function problemCodeOf(res: { body: unknown }): string {
  return (res.body as { code: string }).code;
}

/** 013:非主档案 → 403 FORBIDDEN(与 grant 状态无关);元数据接口照常 200 */
async function expectForbidden(rig: Rig): Promise<void> {
  const res = await getAccount(rig);
  expect(res.status, JSON.stringify(res.body)).toBe(403);
  expectProblemContentType(res);
  expect(problemCodeOf(res)).toBe(ProblemCode.FORBIDDEN);
  const status = await getAccessStatus(rig);
  expect(status.status).toBe(200);
  expect(status.body).toEqual({ unlocked: false, expiresAt: null });
}

describe('T076 · Settings 管理边界失效矩阵(013 SettingsGuard;grant 链仅余 /settings/access 元数据)', () => {
  afterEach(async () => {
    await cleanupRigs();
    await cleanupSettingsRigs();
  });

  it('基线:设置解锁后 GET /settings/account 200 只读 AccountSummary 白名单投影', async () => {
    const rig = await setupRig();
    const expiresAt = await unlockSettings(rig);
    expect(expiresAt).toEqual(expect.any(String));
    const res = await getAccount(rig);
    expect(res.status).toBe(200);
    expect(Object.keys(res.body as Record<string, unknown>).sort()).toEqual(['id', 'role', 'username']);
    expect(res.body).toMatchObject({ username: INITIALIZE_BODY.username, role: 'owner' });
    // 授权期间的最小状态接口同样 200,expiresAt 与解锁响应一致(不续期)
    expect((await getAccessStatus(rig)).body).toEqual({ unlocked: true, expiresAt });
  });

  it('grant 过期不再影响鉴权:主管理员仍 200(013 无 Ticket);签发行未被续写(固定 15 分钟不滑动)', async () => {
    const rig = await setupRig();
    await unlockSettings(rig);
    const before = Database.db
      .prepare('SELECT issued_at, expires_at FROM settings_access_grant')
      .get() as { issued_at: string; expires_at: string };
    // 多次主体读取不得滑动/续期签发行(签发链路仅为兼容保留)
    for (let i = 0; i < 3; i += 1) {
      expect((await getAccount(rig)).status).toBe(200);
      expect((await getAccessStatus(rig)).status).toBe(200);
    }
    const after = Database.db
      .prepare('SELECT issued_at, expires_at FROM settings_access_grant')
      .get() as { issued_at: string; expires_at: string };
    expect(after).toEqual(before);

    // 回拨到期(保持 expires_at > issued_at 的 CHECK):恰似时间自然走完 15 分钟
    Database.db
      .prepare('UPDATE settings_access_grant SET issued_at = ?, expires_at = ?')
      .run(new Date(Date.now() - 16 * 60_000).toISOString(), new Date(Date.now() - 60_000).toISOString());
    // 013:管理边界以 isMain 为准,过期 grant 不拒绝;仅遗留元数据接口报告 unlocked=false
    expect((await getAccount(rig)).status).toBe(200);
    expect((await getAccessStatus(rig)).body).toEqual({ unlocked: false, expiresAt: null });
  });

  it('实际换档:A→B(非主)→ 403 FORBIDDEN;B→A(主)→ 200 即时恢复(013 授权随档案身份切换)', async () => {
    const rig = await setupRig();
    await unlockSettings(rig);
    // A → B:换到儿童档案(非主)→ 立即失去管理边界访问
    await selectProfile(rig.rig.app, rig.cookie, rig.childProfileId, CHILD_PIN);
    await expectForbidden(rig);
    // B → A:选回主档案 → 立即恢复(零 PIN 二次验证,ADR-0017 免套娃)
    await selectProfile(rig.rig.app, rig.cookie, rig.mainProfileId, MAIN_PIN);
    expect((await getAccount(rig)).status).toBe(200);
  });

  it('逐请求查库兜底:会话当前档案被直改非主/停用 → 403 FORBIDDEN(库内现值为准,零缓存)', async () => {
    const rig = await setupRig();
    await unlockSettings(rig);

    // 主档案 is_main 直改 0(模拟并发主档案转移的库内终态)
    Database.db.prepare('UPDATE profile SET is_main = 0 WHERE is_main = 1').run();
    await expectForbidden(rig);

    // 恢复主档案后,直改会话行清空当前档案(未选档形态)→ 同样 403
    Database.db.prepare('UPDATE profile SET is_main = 1 WHERE id = ?').run(rig.mainProfileId);
    Database.db.prepare('UPDATE device_session SET active_profile_id = NULL').run();
    await expectForbidden(rig);
  });

  it('注销 → 先 401 SESSION_INVALID(不得强行 403)', async () => {
    const rig = await setupRig();
    await unlockSettings(rig);
    await request(rig.rig.app.getHttpServer()).post('/api/auth/logout').set('Cookie', rig.cookie).send({});
    const res = await getAccount(rig);
    expect(res.status).toBe(401);
    expect(problemCodeOf(res)).toBe(ProblemCode.SESSION_INVALID);
  });

  it('会话设备撤销 → 先 401 SESSION_INVALID', async () => {
    const rig = await setupRig();
    await unlockSettings(rig);
    const revoke = await request(rig.rig.app.getHttpServer())
      .post(`/api/settings/devices/${rig.deviceId}/revoke`)
      .set('Cookie', rig.cookie)
      .send({ ownerPassword: INITIALIZE_BODY.password });
    expect(revoke.status).toBe(204);
    const res = await getAccount(rig);
    expect(res.status).toBe(401);
    expect(problemCodeOf(res)).toBe(ProblemCode.SESSION_INVALID);
  });

  it('应用启动撤销全部 grants:主管理员畅行不受影响(013);仅遗留元数据回到未解锁', async () => {
    const rig = await setupRig();
    await unlockSettings(rig);
    // 普通浏览器刷新(不重启):经服务端核验继续
    expect((await getAccount(rig)).status).toBe(200);

    await restartSettingsApp(rig.rig);
    // 进程重启不继承旧授权:data-model §3「启动时撤销所有 grants」
    const status = await getAccessStatus(rig);
    expect(status.status).toBe(200);
    expect(status.body).toEqual({ unlocked: false, expiresAt: null });
    // 013:管理边界以 isMain 为准 —— 重启撤销 grant 不再阻断主管理员
    expect((await getAccount(rig)).status).toBe(200);
    // 重新签发仅影响元数据接口
    await unlockSettings(rig);
    expect((await getAccessStatus(rig)).body).toEqual({
      unlocked: true,
      expiresAt: expect.any(String),
    });
  });
});
