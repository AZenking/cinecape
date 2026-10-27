import request from 'supertest';
import { expect } from 'vitest';
import type { INestApplication } from '@nestjs/common';
import { cookiePairOf, INITIALIZE_BODY } from './helpers';

/**
 * US8 管理迁移共享夹具(T122/T125;既有契约测试同步更新的公共入口):
 * - 管理写已全部迁入 /api/settings/*,前置为「主档案已选 + 设置解锁」;
 * - 本文件只做取线路径编排,不引入任何绕过守卫的捷径。
 */

export const MANAGEMENT_MAIN_PIN = '135790';
export const MANAGEMENT_OWNER_PASSWORD = INITIALIZE_BODY.password;

export interface ProfileSummaryLike {
  id: string;
  isMain: boolean;
  pinProtected: boolean;
  status: string;
}

/**
 * 确保主档案存在(零档案时 bootstrap)、当前会话选为主档案并完成设置 PIN 解锁。
 * 返回主档案 ID;失败断言直接抛出(夹具错误立即暴露)。
 */
export async function selectMainAndUnlockSettings(
  app: INestApplication,
  cookie: string,
  options: { mainPin?: string; ownerPassword?: string } = {},
): Promise<string> {
  const server = app.getHttpServer();
  const pin = options.mainPin ?? MANAGEMENT_MAIN_PIN;
  const ownerPassword = options.ownerPassword ?? MANAGEMENT_OWNER_PASSWORD;
  const list = await request(server).get('/api/profiles').set('Cookie', cookie);
  expect(list.status, JSON.stringify(list.body)).toBe(200);
  let main = (list.body as ProfileSummaryLike[]).find((profile) => profile.isMain);
  if (main === undefined) {
    const created = await request(server)
      .post('/api/auth/bootstrap-profile')
      .set('Cookie', cookie)
      .send({ name: '主档案', pin, ownerPassword });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    main = created.body as ProfileSummaryLike;
  }
  if (main.pinProtected) {
    const unlock = await request(server)
      .post(`/api/profiles/${main.id}/unlock`)
      .set('Cookie', cookie)
      .send({ pin });
    expect(unlock.status, JSON.stringify(unlock.body)).toBe(200);
  }
  const select = await request(server).post(`/api/profiles/${main.id}/select`).set('Cookie', cookie).send({});
  expect(select.status, JSON.stringify(select.body)).toBe(200);
  const access = await request(server).post('/api/settings/access').set('Cookie', cookie).send({ pin });
  expect(access.status, JSON.stringify(access.body)).toBe(200);
  return main.id;
}

/** 经设置路由创建档案(管理写迁移后的统一入口;ownerPassword 必填语义由服务端表达) */
export async function createProfileViaSettings(
  app: INestApplication,
  cookie: string,
  body: Record<string, unknown>,
): Promise<request.Response> {
  return request(app.getHttpServer()).post('/api/settings/profiles').set('Cookie', cookie).send({
    ownerPassword: MANAGEMENT_OWNER_PASSWORD,
    ...body,
  });
}

/** 当前主档案概要(含 version,主档案转移 CAS 用) */
export async function mainProfileOf(app: INestApplication, cookie: string): Promise<ProfileSummaryLike & { version: number }> {
  const list = await request(app.getHttpServer()).get('/api/settings/profiles').set('Cookie', cookie);
  expect(list.status).toBe(200);
  const main = (list.body as Array<ProfileSummaryLike & { version: number }>).find((profile) => profile.isMain);
  expect(main, '设置档案列表应含主档案').toBeDefined();
  return main!;
}

/**
 * 幂等解锁:已解锁则跳过;否则确保主档案选中并完成设置 PIN 验证。
 * 适用于夹具在「登录后、管理写前」的任意时点调用(不改变既有选档语义时使用)。
 */
export async function ensureSettingsUnlocked(
  app: INestApplication,
  cookie: string,
  options: { mainPin?: string; ownerPassword?: string } = {},
): Promise<void> {
  const status = await request(app.getHttpServer()).get('/api/settings/access').set('Cookie', cookie);
  if (status.status === 200 && (status.body as { unlocked?: boolean }).unlocked === true) {
    return;
  }
  await selectMainAndUnlockSettings(app, cookie, options);
}

/**
 * 独立管理会话:新登录一个会话,选主档案并解锁设置,返回其 Cookie。
 * 用于「观看会话停在普通档案,管理写需主档案选中」的用例(005 设置边界)。
 */
export async function mgmtSessionCookie(
  app: INestApplication,
  credentials: { username: string; password: string },
  options: { mainPin?: string } = {},
): Promise<string> {
  const login = await request(app.getHttpServer())
    .post('/api/auth/login')
    .send({ username: credentials.username, password: credentials.password });
  expect(login.status, JSON.stringify(login.body)).toBe(200);
  const cookie = cookiePairOf(login);
  await selectMainAndUnlockSettings(app, cookie, { mainPin: options.mainPin });
  return cookie;
}
