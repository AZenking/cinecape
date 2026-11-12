import 'reflect-metadata';
import { afterEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { INITIALIZE_BODY, cleanupRigs, cookiePairOf, initialize, login, startFreshApp } from '../helpers';
import { MANAGEMENT_OWNER_PASSWORD } from '../helpers-management';

/**
 * 013 · GET/PUT /api/profile/preferences 契约(settings-contracts.md §2.1)。
 *
 * - GET 未有行返回传输默认值(zh/zh/true/system/comfortable),零写入;
 * - PUT 合并语义:部分字段提交合法,未提交字段保留现值/默认(个人偏好两个页面
 *   各自提交子集互不覆盖 —— 播放页 3 字段、外观页 2 字段);
 * - 零门禁:任何已选档 Profile(含普通成员/儿童)对**自己的**偏好直达读写,
 *   无 PIN/密码/临时 Ticket(ADR-0017 US1);
 * - 身份边界:严格 schema(未知字段 400 / 空 body 400),SessionGuard 匿名 401;
 * - 数据归属:成员写自己的偏好不影响主档案现值。
 */

const DEFAULTS = {
  defaultAudioLanguage: 'zh',
  defaultSubtitleLanguage: 'zh',
  autoPlayNext: true,
  themeMode: 'system',
  posterDensity: 'comfortable',
};

interface Rig {
  app: Awaited<ReturnType<typeof startFreshApp>>['app'];
  adminCookie: string;
  memberCookie: string;
}

async function setupRig(): Promise<Rig> {
  const fresh = await startFreshApp({ prefix: 'hmp-013-prefs-' });
  expect((await initialize(fresh.app)).status).toBe(201);
  const server = fresh.app.getHttpServer();
  const adminLogin = await login(fresh.app, INITIALIZE_BODY.username, INITIALIZE_BODY.password);
  expect(adminLogin.status).toBe(200);
  const adminCookie = cookiePairOf(adminLogin);
  const bootstrapped = await request(server)
    .post('/api/auth/bootstrap-profile')
    .set('Cookie', adminCookie)
    .send({ name: '妈妈', pin: '111111', ownerPassword: MANAGEMENT_OWNER_PASSWORD });
  expect(bootstrapped.status).toBe(201);
  const mainId = (bootstrapped.body as { id: string }).id;
  expect((await request(server).post(`/api/profiles/${mainId}/unlock`).set('Cookie', adminCookie).send({ pin: '111111' })).status).toBe(200);
  expect((await request(server).post(`/api/profiles/${mainId}/select`).set('Cookie', adminCookie).send({})).status).toBe(200);
  const member = await request(server)
    .post('/api/settings/profiles')
    .set('Cookie', adminCookie)
    .send({ name: '成员', type: 'adult', pin: '246810' });
  expect(member.status).toBe(201);
  const memberLogin = await login(fresh.app, INITIALIZE_BODY.username, INITIALIZE_BODY.password);
  const memberCookie = cookiePairOf(memberLogin);
  expect((await request(server).post(`/api/profiles/${(member.body as { id: string }).id}/unlock`).set('Cookie', memberCookie).send({ pin: '246810' })).status).toBe(200);
  expect((await request(server).post(`/api/profiles/${(member.body as { id: string }).id}/select`).set('Cookie', memberCookie).send({})).status).toBe(200);
  return { app: fresh.app, adminCookie, memberCookie };
}

describe('013 · /api/profile/preferences(GET/PUT 合并语义,零门禁)', () => {
  afterEach(cleanupRigs);

  it('GET 未有行返回传输默认值,零写入', async () => {
    const { app, adminCookie } = await setupRig();
    const res = await request(app.getHttpServer()).get('/api/profile/preferences').set('Cookie', adminCookie);
    expect(res.status).toBe(200);
    expect(res.body).toEqual(DEFAULTS);
    expect(String(res.headers['cache-control'])).toBe('no-store');
    // 零写入断言:再次 GET 仍为默认(不偷偷落库)
    const again = await request(app.getHttpServer()).get('/api/profile/preferences').set('Cookie', adminCookie);
    expect(again.body).toEqual(DEFAULTS);
  });

  it('PUT 子集合并:播放页 3 字段后外观页 2 字段,互不覆盖', async () => {
    const { app, adminCookie } = await setupRig();
    const server = app.getHttpServer();
    // 播放偏好页提交子集
    const playback = await request(server)
      .put('/api/profile/preferences')
      .set('Cookie', adminCookie)
      .send({ defaultAudioLanguage: 'ja', defaultSubtitleLanguage: 'none', autoPlayNext: false });
    expect(playback.status).toBe(200);
    expect(playback.body).toEqual({
      defaultAudioLanguage: 'ja',
      defaultSubtitleLanguage: 'none',
      autoPlayNext: false,
      themeMode: 'system',
      posterDensity: 'comfortable',
    });
    // 外观偏好页提交另一子集(不带播放字段)
    const appearance = await request(server)
      .put('/api/profile/preferences')
      .set('Cookie', adminCookie)
      .send({ themeMode: 'dark', posterDensity: 'compact' });
    expect(appearance.status).toBe(200);
    expect(appearance.body).toEqual({
      defaultAudioLanguage: 'ja',
      defaultSubtitleLanguage: 'none',
      autoPlayNext: false,
      themeMode: 'dark',
      posterDensity: 'compact',
    });
  });

  it('零门禁:普通成员对**自己的**偏好直达读写,与主档案互不可见影响', async () => {
    const { app, adminCookie, memberCookie } = await setupRig();
    const server = app.getHttpServer();
    const memberPut = await request(server)
      .put('/api/profile/preferences')
      .set('Cookie', memberCookie)
      .send({ defaultAudioLanguage: 'en', autoPlayNext: false });
    expect(memberPut.status).toBe(200);
    expect(memberPut.body.defaultAudioLanguage).toBe('en');
    // 主档案现值不受成员写入影响
    const adminGet = await request(server).get('/api/profile/preferences').set('Cookie', adminCookie);
    expect(adminGet.body).toEqual(DEFAULTS);
  });

  it('严格入参:未知字段 400;空 body 400;themeMode 非法枚举 400', async () => {
    const { app, adminCookie } = await setupRig();
    const server = app.getHttpServer();
    const unknown = await request(server)
      .put('/api/profile/preferences')
      .set('Cookie', adminCookie)
      .send({ hackerField: true });
    expect(unknown.status).toBe(400);
    const empty = await request(server).put('/api/profile/preferences').set('Cookie', adminCookie).send({});
    expect(empty.status).toBe(400);
    const badEnum = await request(server)
      .put('/api/profile/preferences')
      .set('Cookie', adminCookie)
      .send({ themeMode: 'purple' });
    expect(badEnum.status).toBe(400);
  });

  it('匿名游客:GET/PUT 一律 401', async () => {
    const { app } = await setupRig();
    const server = app.getHttpServer();
    expect((await request(server).get('/api/profile/preferences')).status).toBe(401);
    expect((await request(server).put('/api/profile/preferences').send({ autoPlayNext: false })).status).toBe(401);
  });
});
