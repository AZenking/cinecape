import 'reflect-metadata';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { INITIALIZE_BODY, cookiePairOf, login } from '../helpers';
import { cleanupSettingsRigs } from '../helpers-settings';
import { startRoleRig, type RoleRig } from '../helpers-settings-013';

/**
 * T015: 常规管理接口免临时 Ticket(X-Settings-Grant-Token)契约测试(013 US2 / ADR-0017)。
 *
 * 打**真实** settings 控制器(SettingsGuard 接线后),不再自建 mock controller:
 * 1. 主管理员会话**零设置 grant**(夹具全程不调 /api/settings/access)、请求头完全不带
 *    X-Settings-Grant-Token,GET /api/settings/** 一律 200 放行;
 * 2. 即便携带伪造/过期的 X-Settings-Grant-Token,只要是主管理员均直接放行(无 Ticket 硬依赖);
 * 3. 普通成员/儿童档案同一路径一律 403 FORBIDDEN(携带 Ticket 头也不豁免);
 * 4. 未选档会话 403 FORBIDDEN;匿名游客 401(SessionGuard 先行)。
 */

const rig013s: RoleRig[] = [];

function track(rig: RoleRig): RoleRig {
  rig013s.push(rig);
  return rig;
}

afterEach(async () => {
  await cleanupSettingsRigs();
});

afterAll(() => {
  rig013s.length = 0;
});

describe('T015 · 常规管理接口免临时 Ticket(013 US2,真实控制器)', () => {
  it('主管理员零 grant、无 Ticket 头:GET /api/settings/** 一律 200', async () => {
    const rig = track(await startRoleRig('hmp-013-noticket-'));
    const server = rig.app.getHttpServer();

    const paths = [
      '/api/settings/sources',
      '/api/settings/profiles',
      '/api/settings/devices',
      '/api/settings/household',
      '/api/settings/account',
      `/api/settings/profiles/${rig.mainProfileId}/policy`,
    ];
    for (const path of paths) {
      const res = await request(server).get(path).set('Cookie', rig.adminCookie);
      expect(res.status, `${path} 应免 Ticket 放行: ${JSON.stringify(res.body)}`).toBe(200);
      expect(String(res.headers['cache-control'])).toBe('no-store');
    }
  });

  it('携带伪造的 X-Settings-Grant-Token 头:主管理员仍然 200(无 Ticket 硬依赖)', async () => {
    const rig = track(await startRoleRig('hmp-013-forgedhdr-'));
    const server = rig.app.getHttpServer();

    const res = await request(server)
      .get('/api/settings/sources')
      .set('Cookie', rig.adminCookie)
      .set('X-Settings-Grant-Token', 'forged-or-expired-ticket-value');
    expect(res.status, JSON.stringify(res.body)).toBe(200);
  });

  it('零 grant 主管理员直达管理读端点;普通成员/儿童一律 403 FORBIDDEN(Ticket 头不豁免)', async () => {
    const rig = track(await startRoleRig('hmp-013-rolecmp-'));
    const server = rig.app.getHttpServer();

    const admin = await request(server).get('/api/settings/sources').set('Cookie', rig.adminCookie);
    expect(admin.status).toBe(200);

    for (const [label, cookie] of [
      ['普通成员', rig.memberCookie],
      ['儿童档案', rig.childCookie],
    ] as const) {
      const res = await request(server)
        .get('/api/settings/sources')
        .set('Cookie', cookie)
        .set('X-Settings-Grant-Token', 'any-ticket-does-not-help');
      expect(res.status, `${label} 应 403`).toBe(403);
      expect(res.body.code).toBe('FORBIDDEN');
    }
  });

  it('已登录但未选档:403 FORBIDDEN;匿名游客:401', async () => {
    const rig = track(await startRoleRig('hmp-013-noprof-'));
    const server = rig.app.getHttpServer();

    const fresh = await login(rig.app, INITIALIZE_BODY.username, INITIALIZE_BODY.password);
    const noProfileCookie = cookiePairOf(fresh);
    const noProfile = await request(server).get('/api/settings/sources').set('Cookie', noProfileCookie);
    expect(noProfile.status).toBe(403);
    expect(noProfile.body.code).toBe('FORBIDDEN');

    const anonymous = await request(server).get('/api/settings/sources');
    expect(anonymous.status).toBe(401);
  });
});
