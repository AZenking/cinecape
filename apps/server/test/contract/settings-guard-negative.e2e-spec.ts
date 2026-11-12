import 'reflect-metadata';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { cleanupSettingsRigs } from '../helpers-settings';
import { startRoleRig, type RoleRig } from '../helpers-settings-013';

/**
 * T026 · 普通成员/儿童直调管理接口 403 负向矩阵(013 US5,真实控制器)。
 *
 * 权威:ADR-0017 决议 5(服务端 SettingsGuard 强校验 activeProfile.isMain === 1,
 * 非主管理员一律 403 FORBIDDEN 阻断;前端 AdminRouteGuard 仅是体验层纵深,
 * 安全底线以本矩阵为准):
 * - 普通成员(selected 非主档案)对全部 settings 管理写路径 403 FORBIDDEN
 *   (守卫先于入参校验:垃圾 body 同样 403,不泄露 schema 信息);
 * - 儿童档案同矩阵 403(抽样);
 * - 匿名游客 401(SessionGuard 先行);
 * - 主管理员同路径零 grant 直达 200(正向见 settings-no-ticket.e2e-spec.ts)。
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

describe('T026 · 非主管理员直调管理接口 403 负向矩阵(013 US5,真实控制器)', () => {
  it('普通成员对来源/目录/策略/家庭/档案/设备/账号全部管理写路径 403 FORBIDDEN', async () => {
    const rig = track(await startRoleRig('hmp-013-negmember-'));
    const server = rig.app.getHttpServer();

    const cases: Array<[string, 'post' | 'put' | 'patch' | 'delete', string, Record<string, unknown>]> = [
      ['POST /settings/sources', 'post', '/api/settings/sources', { name: '越权源' }],
      ['PATCH /settings/sources/:id', 'patch', `/api/settings/sources/${rig.mainProfileId}`, { name: 'x' }],
      ['POST /settings/sources/:id/refresh', 'post', `/api/settings/sources/${rig.mainProfileId}/refresh`, {}],
      ['POST /settings/catalog/candidates/query', 'post', '/api/settings/catalog/candidates/query', {}],
      ['PATCH /settings/catalog/media/:id', 'patch', `/api/settings/catalog/media/${rig.mainProfileId}`, {}],
      [
        'PUT /settings/profiles/:id/policy',
        'put',
        `/api/settings/profiles/${rig.memberProfileId}/policy`,
        { expectedVersion: 0, policy: { maxContentLevel: 18, allowUnrated: true } },
      ],
      [
        'PUT /settings/profiles/:id/policy/lists',
        'put',
        `/api/settings/profiles/${rig.memberProfileId}/policy/lists`,
        { expectedVersion: 0, allowedMediaIds: [], blockedMediaIds: [], allowedChannelIds: [] },
      ],
      ['PATCH /settings/household', 'patch', '/api/settings/household', { expectedVersion: 1 }],
      ['POST /settings/profiles', 'post', '/api/settings/profiles', { name: '越权档案', type: 'adult' }],
      ['PATCH /settings/profiles/:id', 'patch', `/api/settings/profiles/${rig.memberProfileId}`, { name: 'x' }],
      ['PUT /settings/main-profile', 'put', '/api/settings/main-profile', {}],
      ['POST /settings/devices/:id/revoke', 'post', `/api/settings/devices/${rig.mainProfileId}/revoke`, {}],
      [
        'PUT /settings/account/password',
        'put',
        '/api/settings/account/password',
        { currentPassword: 'wrong-password-1', newPassword: 'brand-new-password-9' },
      ],
    ];

    for (const [label, method, path, body] of cases) {
      const res = await request(server)[method](path).set('Cookie', rig.memberCookie).send(body);
      expect(res.status, `${label} 应 403: ${JSON.stringify(res.body)}`).toBe(403);
      expect(res.body.code, label).toBe('FORBIDDEN');
    }

    // 管理读端点同被拒(此前 mock 版未覆盖读半部)
    for (const path of [
      '/api/settings/sources',
      '/api/settings/profiles',
      '/api/settings/devices',
      `/api/settings/profiles/${rig.memberProfileId}/policy`,
    ]) {
      const res = await request(server).get(path).set('Cookie', rig.memberCookie);
      expect(res.status, `${path} 应 403`).toBe(403);
      expect(res.body.code).toBe('FORBIDDEN');
    }
  });

  it('儿童档案抽样:读/写均 403 FORBIDDEN(不因 type=child 有任何豁免)', async () => {
    const rig = track(await startRoleRig('hmp-013-negchild-'));
    const server = rig.app.getHttpServer();

    const read = await request(server).get('/api/settings/sources').set('Cookie', rig.childCookie);
    expect(read.status).toBe(403);
    expect(read.body.code).toBe('FORBIDDEN');

    const write = await request(server)
      .post('/api/settings/profiles')
      .set('Cookie', rig.childCookie)
      .send({ name: '越权档案', type: 'adult' });
    expect(write.status).toBe(403);
    expect(write.body.code).toBe('FORBIDDEN');
  });

  it('匿名游客(无 Cookie):读/写一律 401(SessionGuard 先行)', async () => {
    const rig = track(await startRoleRig('hmp-013-neganon-'));
    const server = rig.app.getHttpServer();

    const read = await request(server).get('/api/settings/sources');
    expect(read.status).toBe(401);

    const write = await request(server).post('/api/settings/sources').send({ name: 'x' });
    expect(write.status).toBe(401);
  });
});
