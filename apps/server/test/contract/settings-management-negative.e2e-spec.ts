import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import type { INestApplication } from '@nestjs/common';
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
import {
  MANAGEMENT_MAIN_PIN,
  MANAGEMENT_OWNER_PASSWORD,
  createProfileViaSettings,
  selectMainAndUnlockSettings,
} from '../helpers-management';

/**
 * T122(005-US8 契约 e2e,先 FAIL)—— settings 授权次序与负向矩阵(负向半部)。
 * 权威:contracts/api.md §6/§7(次序:存储就绪→Session→角色/当前主 Profile→grant→
 * 严格入参→当次密码→重读身份/grant/目标归属/版本→事务;no-store)、tasks.md T122。
 *
 * 覆盖:游客/无 grant/普通 Profile/伪造 grant/过期 grant、缺错密码与锁定计数、
 * 跨家庭目标 404、旧版本 409、未知字段 400、错误响应 no-store 与响应面
 * (不含 PIN/源 URL/票据)。
 */

interface Rig {
  app: INestApplication;
  cookie: string;
}

async function rig(prefix: string): Promise<Rig> {
  const fresh = await startFreshApp({ prefix });
  expect((await initialize(fresh.app)).status).toBe(201);
  const loggedIn = await login(fresh.app, INITIALIZE_BODY.username, INITIALIZE_BODY.password);
  expect(loggedIn.status).toBe(200);
  return { app: fresh.app, cookie: cookiePairOf(loggedIn) };
}

describe('T122 · settings 授权次序与负向矩阵(api.md §7)', () => {
  afterEach(cleanupRigs);

  it('游客(无会话)直接请求管理路由:401 SESSION_INVALID(先于一切 403)', async () => {
    const { app } = await rig('hmp-t122n-guest-');
    for (const path of ['/api/settings/account', '/api/settings/household', '/api/settings/profiles', '/api/settings/sources', '/api/settings/devices']) {
      const res = await request(app.getHttpServer()).get(path);
      expect(res.status, path).toBe(401);
      expect(res.body.code, path).toBe('SESSION_INVALID');
      expectProblemContentType(res);
    }
    // 写路由同样 401
    const post = await request(app.getHttpServer())
      .put('/api/settings/account/password')
      .send({ ownerPassword: 'x-password-1', newPassword: 'y-password-2' });
    expect(post.status).toBe(401);
  });

  it('已登录但未解锁(grant 缺失):403 SETTINGS_ACCESS_REQUIRED', async () => {
    const { app, cookie } = await rig('hmp-t122n-locked-');
    const res = await request(app.getHttpServer()).get('/api/settings/account').set('Cookie', cookie);
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('SETTINGS_ACCESS_REQUIRED');
    const write = await request(app.getHttpServer())
      .patch('/api/settings/household')
      .set('Cookie', cookie)
      .send({ expectedVersion: 1, ownerPassword: MANAGEMENT_OWNER_PASSWORD, name: 'X' });
    expect(write.status).toBe(403);
    expect(write.body.code).toBe('SETTINGS_ACCESS_REQUIRED');
  });

  it('普通 Profile 选中(非主档案):403 SETTINGS_ACCESS_REQUIRED,不当次放行', async () => {
    const { app, cookie } = await rig('hmp-t122n-ordinary-');
    await selectMainAndUnlockSettings(app, cookie); // 先解锁才能创建档案
    const created = await createProfileViaSettings(app, cookie, { name: '儿童', type: 'child', pin: '246800' });
    expect(created.status).toBe(201);
    // 切到儿童档案(grant 因此失效)
    const unlock = await request(app.getHttpServer())
      .post(`/api/profiles/${created.body.id}/unlock`)
      .set('Cookie', cookie)
      .send({ pin: '246800' });
    expect(unlock.status).toBe(200);
    const select = await request(app.getHttpServer())
      .post(`/api/profiles/${created.body.id}/select`)
      .set('Cookie', cookie)
      .send({});
    expect(select.status).toBe(200);
    const res = await request(app.getHttpServer()).get('/api/settings/account').set('Cookie', cookie);
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('SETTINGS_ACCESS_REQUIRED');
    // /settings/access 最小状态仍可读(独立入口,仅 Session):unlocked=false
    const status = await request(app.getHttpServer()).get('/api/settings/access').set('Cookie', cookie);
    expect(status.status).toBe(200);
    expect(status.body).toEqual({ unlocked: false, expiresAt: null });
  });

  it('伪造 grant(版本失配/指向他档):403 SETTINGS_ACCESS_REQUIRED;过期 grant:403 SETTINGS_ACCESS_EXPIRED', async () => {
    const { app, cookie } = await rig('hmp-t122n-forged-');
    // 正常解锁一次取得基准 grant 行
    const mainId = await selectMainAndUnlockSettings(app, cookie);
    const ok = await request(app.getHttpServer()).get('/api/settings/account').set('Cookie', cookie);
    expect(ok.status).toBe(200);

    // 伪造:pin_version 快照改错(库内直改,模拟不可信持久状态)
    Database.db.prepare('UPDATE settings_access_grant SET pin_version = pin_version + 1').run();
    const forged = await request(app.getHttpServer()).get('/api/settings/account').set('Cookie', cookie);
    expect(forged.status).toBe(403);
    expect(forged.body.code).toBe('SETTINGS_ACCESS_REQUIRED');

    // 恢复合法快照后改成过期:403 SETTINGS_ACCESS_EXPIRED(签发/到期整体平移到过去,满足 CHECK)
    Database.db.prepare('UPDATE settings_access_grant SET pin_version = ?').run(1);
    Database.db
      .prepare(
        "UPDATE settings_access_grant SET issued_at = '2000-01-01T00:00:00.000Z', expires_at = '2000-01-01T15:00:00.000Z'",
      )
      .run();
    const expired = await request(app.getHttpServer()).get('/api/settings/account').set('Cookie', cookie);
    expect(expired.status).toBe(403);
    expect(expired.body.code).toBe('SETTINGS_ACCESS_EXPIRED');
    void mainId;
  });

  it('缺/错 ownerPassword:403 REQUIRED/FAILED 并沿用既有密码错误计数锁定(第 5 次落窗,423)', async () => {
    const { app, cookie } = await rig('hmp-t122n-lockout-');
    await selectMainAndUnlockSettings(app, cookie);
    // 缺密码:household 契约 ownerPassword 必填 → 400 VALIDATION_FAILED(严格入参先于当次密码);
    // ownerPassword 为可选 schema 的 POST /settings/profiles 缺密码 → 403 REQUIRED(不消耗计数)
    const missing = await request(app.getHttpServer())
      .patch('/api/settings/household')
      .set('Cookie', cookie)
      .send({ expectedVersion: 1, name: 'X' });
    expect(missing.status).toBe(400);
    expect(missing.body.code).toBe('VALIDATION_FAILED');
    const missingOnCreate = await request(app.getHttpServer())
      .post('/api/settings/profiles')
      .set('Cookie', cookie)
      .send({ name: '无密码', type: 'adult' });
    expect(missingOnCreate.status).toBe(403);
    expect(missingOnCreate.body.code).toBe('PARENT_VERIFICATION_REQUIRED');
    // 4 次错误:403 FAILED;第 5 次:403 且落窗;其后即使密码正确 423 LOCKED
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const wrong = await request(app.getHttpServer())
        .patch('/api/settings/household')
        .set('Cookie', cookie)
        .send({ expectedVersion: 1, ownerPassword: `wrong-password-${attempt}`, name: 'X' });
      expect(wrong.status, `第 ${attempt + 1} 次错误`).toBe(403);
      expect(wrong.body.code).toBe('PARENT_VERIFICATION_FAILED');
    }
    expect(
      Database.db.prepare('SELECT locked_until FROM parent_verification_state').get() as { locked_until: string | null },
    ).toMatchObject({ locked_until: expect.any(String) });
    const correctButLocked = await request(app.getHttpServer())
      .patch('/api/settings/household')
      .set('Cookie', cookie)
      .send({ expectedVersion: 1, ownerPassword: MANAGEMENT_OWNER_PASSWORD, name: '正确但锁定' });
    expect(correctButLocked.status).toBe(423);
    expect(correctButLocked.body.code).toBe('PARENT_VERIFICATION_LOCKED');
    // 无部分写入
    const household = await request(app.getHttpServer()).get('/api/settings/household').set('Cookie', cookie);
    expect(household.body.name).toBe(INITIALIZE_BODY.householdName);
  });

  it('跨家庭目标统一 404 同形(profiles/policy/devices/refreshes)', async () => {
    const { app, cookie } = await rig('hmp-t122n-foreign-');
    await selectMainAndUnlockSettings(app, cookie);
    // 他家庭夹具:household + account(复合 FK 所需)+ profile
    const foreignHouseholdId = randomUUID();
    const foreignAccountId = randomUUID();
    const foreignProfileId = randomUUID();
    const now = new Date().toISOString();
    Database.db
      .prepare('INSERT INTO household (id, name, created_at) VALUES (?, ?, ?)')
      .run(foreignHouseholdId, '邻居家庭', now);
    Database.db
      .prepare(
        "INSERT INTO account (id, household_id, username, username_normalized, password_hash, role, created_at) VALUES (?, ?, 'other', 'other', 'x', 'owner', ?)",
      )
      .run(foreignAccountId, foreignHouseholdId, now);
    Database.db
      .prepare(
        "INSERT INTO profile (id, household_id, account_id, name, avatar, type, is_default, pin_hash, status, is_main, version, created_at) VALUES (?, ?, ?, '别家档案', NULL, 'adult', 0, NULL, 'active', 0, 1, ?)",
      )
      .run(foreignProfileId, foreignHouseholdId, foreignAccountId, now);
    const patch = await request(app.getHttpServer())
      .patch(`/api/settings/profiles/${foreignProfileId}`)
      .set('Cookie', cookie)
      .send({ expectedVersion: 1, ownerPassword: MANAGEMENT_OWNER_PASSWORD, name: '越权改' });
    expect(patch.status).toBe(404);
    const policy = await request(app.getHttpServer())
      .get(`/api/settings/profiles/${foreignProfileId}/policy`)
      .set('Cookie', cookie);
    expect(policy.status).toBe(404);
    const revoke = await request(app.getHttpServer())
      .post(`/api/settings/devices/${randomUUID()}/revoke`)
      .set('Cookie', cookie)
      .send({ ownerPassword: MANAGEMENT_OWNER_PASSWORD });
    expect(revoke.status).toBe(404);
    const refresh = await request(app.getHttpServer())
      .get(`/api/settings/refreshes/${randomUUID()}`)
      .set('Cookie', cookie);
    expect(refresh.status).toBe(404);
  });

  it('未知 JSON/query 字段一律 400(身份声明 householdId/profileId 不能扩大权限)', async () => {
    const { app, cookie } = await rig('hmp-t122n-unknown-');
    await selectMainAndUnlockSettings(app, cookie);
    const jsonCases: Array<{ path: string; method: 'patch' | 'post' | 'put'; body: Record<string, unknown> }> = [
      {
        path: '/api/settings/household',
        method: 'patch',
        body: { expectedVersion: 1, ownerPassword: MANAGEMENT_OWNER_PASSWORD, isAdmin: true },
      },
      {
        path: '/api/settings/profiles',
        method: 'post',
        body: { name: 'X', type: 'adult', ownerPassword: MANAGEMENT_OWNER_PASSWORD, householdId: randomUUID() },
      },
      {
        path: `/api/settings/main-profile`,
        method: 'put',
        body: {
          profileId: randomUUID(),
          expectedVersion: 1,
          expectedCurrentProfileVersion: 1,
          expectedProfileVersion: 1,
          ownerPassword: MANAGEMENT_OWNER_PASSWORD,
          profileContextVersion: 1,
        },
      },
    ];
    for (const entry of jsonCases) {
      const res = await request(app.getHttpServer())[entry.method](entry.path)
        .set('Cookie', cookie)
        .send(entry.body);
      expect(res.status, `${entry.method.toUpperCase()} ${entry.path}`).toBe(400);
      expect(res.body.code, entry.path).toBe('VALIDATION_FAILED');
    }
    // 未知 query 键( devices 列表)同样 400
    const unknownQuery = await request(app.getHttpServer())
      .get('/api/settings/devices')
      .query({ householdId: randomUUID() })
      .set('Cookie', cookie);
    expect(unknownQuery.status).toBe(400);
  });

  it('错误与成功响应统一 no-store,响应不含 PIN/源 URL/票据字段', async () => {
    const { app, cookie } = await rig('hmp-t122n-surface-');
    await selectMainAndUnlockSettings(app, cookie);
    // 错误响应 no-store
    const denied = await request(app.getHttpServer()).post('/api/settings/sources').set('Cookie', cookie).send({
      ownerPassword: MANAGEMENT_OWNER_PASSWORD,
      kind: 'iptv',
      name: '坏源',
      remoteUrl: 'not-a-url',
      privateAccessApproved: true,
    });
    expect(denied.status).toBe(400);
    expect(String(denied.headers['cache-control'])).toBe('no-store');
    // 成功响应面:profiles 列表无 pinHash/failedPinCount;household 无凭据;sources 无 remoteUrl
    const profiles = await request(app.getHttpServer()).get('/api/settings/profiles').set('Cookie', cookie);
    const profileText = JSON.stringify(profiles.body);
    for (const forbidden of ['pinHash', 'pin_hash', 'failedPinCount', 'pinLockedUntil', 'password']) {
      expect(profileText).not.toContain(forbidden);
    }
    const sources = await request(app.getHttpServer()).get('/api/settings/sources').set('Cookie', cookie);
    const sourceText = JSON.stringify(sources.body);
    for (const forbidden of ['remoteUrl', 'remote_url', 'rootKey', 'relativeDirectory', 'token', 'ticket']) {
      expect(sourceText).not.toContain(forbidden);
    }
    // PIN/密码不出现在任何 settings 响应
    const account = await request(app.getHttpServer()).get('/api/settings/account').set('Cookie', cookie);
    expect(JSON.stringify(account.body)).not.toContain('password');
    expect(JSON.stringify(account.body)).not.toContain('pin');
  });

  it('旧管理入口已删除:POST /api/profiles、GET /api/sources、catalog 管理路由、GET /api/devices 全部 404(无兼容别名)', async () => {
    const { app, cookie } = await rig('hmp-t122n-removed-');
    await selectMainAndUnlockSettings(app, cookie);
    const removed: Array<[string, 'get' | 'post' | 'patch' | 'put', unknown]> = [
      ['/api/profiles', 'post', { name: 'X', type: 'adult', ownerPassword: MANAGEMENT_OWNER_PASSWORD }],
      ['/api/sources', 'get', undefined],
      ['/api/source-roots', 'get', undefined],
      ['/api/catalog/candidates/query', 'post', { ownerPassword: MANAGEMENT_OWNER_PASSWORD, page: 1 }],
      ['/api/devices', 'get', undefined],
      [`/api/profiles/${randomUUID()}/policy`, 'get', undefined],
    ];
    for (const [path, method, body] of removed) {
      const req = request(app.getHttpServer())[method](path).set('Cookie', cookie);
      const res = body === undefined ? await req : await req.send(body as string | object);
      expect(res.status, `${method.toUpperCase()} ${path}`).toBe(404);
    }
    const patchOld = await request(app.getHttpServer())
      .patch(`/api/profiles/${randomUUID()}`)
      .set('Cookie', cookie)
      .send({ expectedVersion: 1, ownerPassword: MANAGEMENT_OWNER_PASSWORD });
    expect(patchOld.status).toBe(404);
    // 选档契约 GET /api/profiles 保留(unlock/select 同样保留)
    const selection = await request(app.getHttpServer()).get('/api/profiles').set('Cookie', cookie);
    expect(selection.status).toBe(200);
    const main = (selection.body as Array<{ id: string; isMain: boolean }>).find((p) => p.isMain)!;
    const unlock = await request(app.getHttpServer())
      .post(`/api/profiles/${main.id}/unlock`)
      .set('Cookie', cookie)
      .send({ pin: MANAGEMENT_MAIN_PIN });
    expect(unlock.status).toBe(200);
    const unlockSelect = await request(app.getHttpServer())
      .post(`/api/profiles/${main.id}/select`)
      .set('Cookie', cookie)
      .send({});
    expect(unlockSelect.status).toBe(200);
  });
});
