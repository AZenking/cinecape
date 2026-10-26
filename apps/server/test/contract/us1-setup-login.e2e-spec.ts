import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { afterEach, describe, expect, it } from 'vitest';
import { ProblemCode, SESSION_COOKIE } from '@hmp/shared';
import {
  INITIALIZE_BODY,
  cleanupRigs,
  cookiePairOf,
  expectProblemContentType,
  initialize,
  login,
  sessionSetCookieOf,
  startFreshApp,
} from '../helpers';

/**
 * T016(US1 契约 e2e):首次启动 —— 初始化家庭并登录。
 * 对照 contracts/openapi.yaml:/setup/status、/setup/initialize、/auth/login、
 * /household、/profiles;错误一律 application/problem+json(RFC 9457)。
 *
 * 夹具(独立数据目录/权威迁移 DDL/Cookie 提取)已抽取至 test/helpers.ts 供 US1/US3 复用。
 */

function expectSessionDtoShape(body: Record<string, unknown>): void {
  expect(typeof body.sessionId).toBe('string');
  expect(body.account).toMatchObject({ username: 'admin', role: 'owner' });
  expect((body.account as Record<string, unknown>).id).toEqual(expect.any(String));
  expect(body.activeProfile).toBeNull();
  expect(body.sessionToken).toEqual(expect.any(String));
  expect((body.sessionToken as string).length).toBeGreaterThan(0);
  expect(typeof body.expiresAt).toBe('string');
  expect(Number.isNaN(Date.parse(body.expiresAt as string))).toBe(false);
  expect(Date.parse(body.expiresAt as string)).toBeGreaterThan(Date.now());

  const serialized = JSON.stringify(body);
  expect(serialized).not.toContain('passwordHash');
  expect(serialized).not.toContain('password_hash');
  expect(serialized).not.toContain('$argon2');
}

describe('US1 首次启动:初始化家庭并登录(契约 e2e)', () => {
  afterEach(cleanupRigs);

  it('场景1 前置:GET /setup/status 在全新环境返回 { initialized:false }', async () => {
    const { app } = await startFreshApp({ prefix: 'hmp-us1-' });

    const res = await request(app.getHttpServer()).get('/api/setup/status');

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ initialized: false });
  });

  it('场景1(005 T036 替代):POST /setup/initialize 201 {initialized:true} —— 仅建家庭+owner 主账号,无 Set-Cookie 不自动登录', async () => {
    const { app } = await startFreshApp({ prefix: 'hmp-us1-' });

    const res = await initialize(app);

    // 005 contracts/api.md §3:201 仅 {initialized:true},无会话/设备/Cookie(research R2)
    expect(res.status).toBe(201);
    expect(res.body).toEqual({ initialized: true });
    expect(res.headers['set-cookie']).toBeUndefined();
    expect(JSON.stringify(res.body)).not.toContain('sessionToken');

    // 显式登录(FR-007:配置成功后进入显式登录步骤)→ 200 SessionDto 形 + HttpOnly Cookie
    const loginRes = await login(app, INITIALIZE_BODY.username, INITIALIZE_BODY.password);
    expect(loginRes.status).toBe(200);
    expectSessionDtoShape(loginRes.body);

    // 场景5/FR-007:Cookie 下发 hmp_session 且 HttpOnly
    const cookie = sessionSetCookieOf(loginRes);
    expect(cookie.startsWith(`${SESSION_COOKIE}=`)).toBe(true);
    expect(cookie).toContain('HttpOnly');
    expect(cookie).toContain('SameSite=Lax');
    expect(/max-age=2592000/i.test(cookie)).toBe(true); // SESSION_TTL_DAYS=30 → 30*86400
  });

  it('场景2/FR-003:重复初始化 409 INITIALIZATION_ALREADY_DONE,原家庭数据保持不变(可继续用原凭据登录)', async () => {
    const { app } = await startFreshApp({ prefix: 'hmp-us1-' });
    await initialize(app);

    // 已初始化后 status 翻转为 true
    const status = await request(app.getHttpServer()).get('/api/setup/status');
    expect(status.body).toEqual({ initialized: true });

    const res = await initialize(app);

    expect(res.status).toBe(409);
    expectProblemContentType(res);
    expect(res.body.code).toBe(ProblemCode.INITIALIZATION_ALREADY_DONE);
    expect(res.body.status).toBe(409);

    // 原有数据不变:原凭据仍可成功登录
    const loginRes = await login(app, 'admin', 'password-123');
    expect(loginRes.status).toBe(200);
  });

  it('场景3/FR-008:正确凭据登录 200,建立会话并下发 HttpOnly 会话 Cookie,响应为 SessionDto 形', async () => {
    const { app } = await startFreshApp({ prefix: 'hmp-us1-' });
    await initialize(app);

    const res = await login(app, 'admin', 'password-123');

    expect(res.status).toBe(200);
    expectSessionDtoShape(res.body);

    const cookie = sessionSetCookieOf(res);
    expect(cookie.startsWith(`${SESSION_COOKIE}=`)).toBe(true);
    expect(cookie).toContain('HttpOnly');

    // 契约双通道:sessionToken 亦可作 Bearer 凭证访问受保护能力
    const bearer = await request(app.getHttpServer())
      .get('/api/household')
      .set('Authorization', `Bearer ${res.body.sessionToken as string}`);
    expect(bearer.status).toBe(200);
  });

  it('场景4/FR-008:错误密码 401 INVALID_CREDENTIALS(problem+json),不下发会话', async () => {
    const { app } = await startFreshApp({ prefix: 'hmp-us1-' });
    await initialize(app);

    const res = await login(app, 'admin', 'totally-wrong-pass');

    expect(res.status).toBe(401);
    expectProblemContentType(res);
    expect(res.body.code).toBe(ProblemCode.INVALID_CREDENTIALS);
    expect(res.body.status).toBe(401);
    expect(res.headers['set-cookie']).toBeUndefined();
  });

  it('场景4/FR-008:不存在的账号与错误密码返回完全一致的 401(统一,不可区分账号存在性)', async () => {
    const { app } = await startFreshApp({ prefix: 'hmp-us1-' });
    await initialize(app);

    const wrongPassword = await login(app, 'admin', 'totally-wrong-pass');
    const unknownUser = await login(app, 'ghost-user-404', 'whatever-pass');

    expect(unknownUser.status).toBe(401);
    expectProblemContentType(unknownUser);
    expect(unknownUser.body.code).toBe(ProblemCode.INVALID_CREDENTIALS);
    // 统一失败提示:两种失败 problem 体完全一致,不泄露账号是否存在
    expect(unknownUser.body).toEqual(wrongPassword.body);
    // 均不创建会话
    expect(unknownUser.headers['set-cookie']).toBeUndefined();
    expect(wrongPassword.headers['set-cookie']).toBeUndefined();
  });

  it('场景3/T020:GET /household 带会话返回家庭信息;伪造 householdId 查询参数被忽略(FR-018)', async () => {
    const { app } = await startFreshApp({ prefix: 'hmp-us1-' });
    await initialize(app);
    // 005 T036:初始化无 Set-Cookie,显式登录取得会话 Cookie
    const init = await login(app, INITIALIZE_BODY.username, INITIALIZE_BODY.password);
    expect(init.status).toBe(200);

    const res = await request(app.getHttpServer())
      .get(`/api/household?householdId=${randomUUID()}`)
      .set('Cookie', cookiePairOf(init));

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      name: INITIALIZE_BODY.householdName,
      defaultLanguage: 'zh-CN',
      timezone: 'Asia/Shanghai',
    });
    expect(res.body.id).toEqual(expect.any(String));
    expect(typeof res.body.createdAt).toBe('string');
  });

  it('FR-019:无会话 GET /household 一律 401 SESSION_INVALID(problem+json)', async () => {
    const { app } = await startFreshApp({ prefix: 'hmp-us1-' });
    await initialize(app);

    const res = await request(app.getHttpServer()).get('/api/household');

    expect(res.status).toBe(401);
    expectProblemContentType(res);
    expect(res.body.code).toBe(ProblemCode.SESSION_INVALID);
  });

  it('场景3/US1 前置:GET /profiles 带会话返回空数组(US1 阶段尚无 Profile)', async () => {
    const { app } = await startFreshApp({ prefix: 'hmp-us1-' });
    await initialize(app);
    // 005 T036:初始化无 Set-Cookie,显式登录取得会话 Cookie
    const init = await login(app, INITIALIZE_BODY.username, INITIALIZE_BODY.password);
    expect(init.status).toBe(200);

    const res = await request(app.getHttpServer())
      .get('/api/profiles')
      .set('Cookie', cookiePairOf(init));

    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
  });
});
