import request from 'supertest';
import { expect } from 'vitest';
import type { INestApplication } from '@nestjs/common';
import { cookiePairOf, INITIALIZE_BODY, initialize, login, startFreshApp } from './helpers';
import { MANAGEMENT_MAIN_PIN, MANAGEMENT_OWNER_PASSWORD } from './helpers-management';

/**
 * 013-role-differentiated-settings 共享角色夹具(T015/T026):
 *
 * - adminCookie:主档案已解锁已选档,但**零设置 grant**(全程不调用
 *   /api/settings/access)—— 用于证明 ADR-0017「免临时 Ticket 畅行」;
 * - memberCookie / childCookie:普通成人/儿童档案已选档的独立会话;
 * - 所有身份均经真实 API 编排(bootstrap/profiles/settings),无任何绕过守卫的捷径。
 */

export interface RoleRig {
  app: INestApplication;
  adminCookie: string;
  memberCookie: string;
  childCookie: string;
  mainProfileId: string;
  memberProfileId: string;
  childProfileId: string;
}

async function selectProfile(server: ReturnType<INestApplication['getHttpServer']>, cookie: string, profileId: string, pin?: string): Promise<void> {
  if (pin !== undefined) {
    const unlock = await request(server).post(`/api/profiles/${profileId}/unlock`).set('Cookie', cookie).send({ pin });
    expect(unlock.status, JSON.stringify(unlock.body)).toBe(200);
  }
  const select = await request(server).post(`/api/profiles/${profileId}/select`).set('Cookie', cookie).send({});
  expect(select.status, JSON.stringify(select.body)).toBe(200);
}

/** 全新环境:初始化 + 主档案(零 grant)+ 普通成员 + 儿童成员三会话 */
export async function startRoleRig(prefix: string): Promise<RoleRig> {
  const fresh = await startFreshApp({ prefix });
  expect((await initialize(fresh.app)).status).toBe(201);
  const server = fresh.app.getHttpServer();

  const adminLogin = await login(fresh.app, INITIALIZE_BODY.username, INITIALIZE_BODY.password);
  expect(adminLogin.status, JSON.stringify(adminLogin.body)).toBe(200);
  const adminCookie = cookiePairOf(adminLogin);

  // 主档案 bootstrap(带 PIN)并选档 —— 全程不调用 /settings/access(零设置 grant)
  const list = await request(server).get('/api/profiles').set('Cookie', adminCookie);
  expect(list.status).toBe(200);
  let main = (list.body as Array<{ id: string; isMain: boolean; pinProtected: boolean }>).find((p) => p.isMain);
  if (main === undefined) {
    const created = await request(server)
      .post('/api/auth/bootstrap-profile')
      .set('Cookie', adminCookie)
      .send({ name: '主档案', pin: MANAGEMENT_MAIN_PIN, ownerPassword: MANAGEMENT_OWNER_PASSWORD });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    main = created.body as { id: string; isMain: boolean; pinProtected: boolean };
  }
  await selectProfile(server, adminCookie, main!.id, main!.pinProtected ? MANAGEMENT_MAIN_PIN : undefined);

  // 普通成员/儿童成员档案(经管理路由创建,带 PIN:儿童在家的成人选档须家长验证,统一走解锁;
  // 013/ADR-0017 起创建档案免当次密码)
  const member = await request(server)
    .post('/api/settings/profiles')
    .set('Cookie', adminCookie)
    .send({ name: '成员', type: 'adult', pin: '246810' });
  expect(member.status, JSON.stringify(member.body)).toBe(201);
  const child = await request(server)
    .post('/api/settings/profiles')
    .set('Cookie', adminCookie)
    .send({ name: '小朋友', type: 'child', pin: '369258' });
  expect(child.status, JSON.stringify(child.body)).toBe(201);
  const memberProfileId = (member.body as { id: string }).id;
  const childProfileId = (child.body as { id: string }).id;

  // 独立会话选普通/儿童档案
  const memberLogin = await login(fresh.app, INITIALIZE_BODY.username, INITIALIZE_BODY.password);
  expect(memberLogin.status).toBe(200);
  const memberCookie = cookiePairOf(memberLogin);
  await selectProfile(server, memberCookie, memberProfileId, '246810');

  const childLogin = await login(fresh.app, INITIALIZE_BODY.username, INITIALIZE_BODY.password);
  expect(childLogin.status).toBe(200);
  const childCookie = cookiePairOf(childLogin);
  await selectProfile(server, childCookie, childProfileId, '369258');

  return {
    app: fresh.app,
    adminCookie,
    memberCookie,
    childCookie,
    mainProfileId: main!.id,
    memberProfileId,
    childProfileId,
  };
}
