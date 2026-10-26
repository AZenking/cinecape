import 'reflect-metadata';
import request from 'supertest';
import { afterEach, describe, expect, it } from 'vitest';
import { ProblemCode } from '@hmp/shared';
import { Database } from '../../src/database/database';
import {
  INITIALIZE_BODY,
  cleanupRigs,
  expectProblemContentType,
  initialize,
  startFreshApp,
} from '../helpers';

/**
 * T030(005 US2 契约测试,先 FAIL):POST /api/setup/initialize 仅建 Household+Account。
 * 权威:docs/specs/005-pc-browsing-flow/contracts/api.md §3(初始化行)+ research R2
 * 「初始化与首档案分为两个事务流程」——201 无 Set-Cookie、无设备注册、不自动登录;
 * 并发只成功一次;存储未知 503 不伪装未初始化;重复初始化 409。
 */

function tableCount(table: string): number {
  const row = Database.db.prepare(`SELECT COUNT(*) AS c FROM ${table}`).get() as { c: number };
  return row.c;
}

describe('T030 · POST /api/setup/initialize 仅建家庭与账号(005 FR-006/007)', () => {
  afterEach(cleanupRigs);

  it('合法输入 201 {initialized:true}:无 Set-Cookie、无 sessionToken、不注册设备、不建会话', async () => {
    const { app } = await startFreshApp({ prefix: 'hmp-t030-' });

    const res = await initialize(app);

    expect(res.status).toBe(201);
    // 响应体精确等于 {initialized:true}:不携带任何会话字段(无 sessionToken/SessionDto 形)
    expect(res.body).toEqual({ initialized: true });
    // FR-007/research R2:初始化不自动登录 —— 不下发任何 Cookie
    expect(res.headers['set-cookie']).toBeUndefined();
    // 不注册设备、不签发设备会话(自动登录链路已真正移除,非前端清 Cookie 假象)
    expect(tableCount('device')).toBe(0);
    expect(tableCount('device_session')).toBe(0);
    // 仅建立 Household + Account 两个基础行
    expect(tableCount('household')).toBe(1);
    expect(tableCount('account')).toBe(1);
    expect(tableCount('profile')).toBe(0);
  });

  it('请求体未知字段(来源/节目单等)一律 400 VALIDATION_FAILED,不产生任何写入', async () => {
    const { app } = await startFreshApp({ prefix: 'hmp-t030-' });

    for (const intruder of [
      { ...INITIALIZE_BODY, sourceUrl: 'http://lan.example/list.m3u' },
      { ...INITIALIZE_BODY, epgUrl: 'http://lan.example/xmltv.xml' },
      { ...INITIALIZE_BODY, householdId: 'fake-household' },
      { ...INITIALIZE_BODY, isAdmin: true },
    ]) {
      const res = await request(app.getHttpServer()).post('/api/setup/initialize').send(intruder);
      expect(res.status, `未知字段应 400:${JSON.stringify(Object.keys(intruder))}`).toBe(400);
      expectProblemContentType(res);
      expect(res.body.code).toBe(ProblemCode.VALIDATION_FAILED);
    }
    expect(tableCount('household')).toBe(0);
    expect(tableCount('account')).toBe(0);
  });

  it('并发两次提交:仅一次 201,另一次 409;失败侧不遗留半配置状态', async () => {
    const { app } = await startFreshApp({ prefix: 'hmp-t030-' });

    const [first, second] = await Promise.all([initialize(app), initialize(app)]);

    const created = [first, second].filter((res) => res.status === 201);
    const conflicts = [first, second].filter((res) => res.status === 409);
    expect(created).toHaveLength(1);
    expect(conflicts).toHaveLength(1);
    expect(created[0]?.body).toEqual({ initialized: true });
    expect(conflicts[0]?.body.code).toBe(ProblemCode.INITIALIZATION_ALREADY_DONE);
    expectProblemContentType(conflicts[0] as typeof first);
    // 失败不遗留半配置:恰好一个家庭+一个账号,无设备/会话/档案残留
    expect(tableCount('household')).toBe(1);
    expect(tableCount('account')).toBe(1);
    expect(tableCount('device')).toBe(0);
    expect(tableCount('device_session')).toBe(0);
    expect(tableCount('profile')).toBe(0);
  });

  it('GET /setup/status:全新环境 {initialized:false};初始化后 {initialized:true}', async () => {
    const { app } = await startFreshApp({ prefix: 'hmp-t030-' });

    const before = await request(app.getHttpServer()).get('/api/setup/status');
    expect(before.status).toBe(200);
    expect(before.body).toEqual({ initialized: false });

    expect((await initialize(app)).status).toBe(201);

    const after = await request(app.getHttpServer()).get('/api/setup/status');
    expect(after.status).toBe(200);
    expect(after.body).toEqual({ initialized: true });
  });

  it('存储故障(状态未知)→ GET /setup/status 503 而非伪装 initialized=false;initialize 同样拒绝(不开放重复配置)', async () => {
    const { app } = await startFreshApp({ prefix: 'hmp-t030-' });

    // 模拟存储不可读:业务表缺失(查询抛错)→ 初始化状态未知
    Database.db.exec('DROP TABLE household');

    const status = await request(app.getHttpServer()).get('/api/setup/status');
    expect(status.status).toBe(503);
    expectProblemContentType(status);
    // 状态未知绝不返回 initialized=false 的 200 形态
    expect(status.body).not.toHaveProperty('initialized');

    const res = await initialize(app);
    expect(res.status).toBe(503);
    expectProblemContentType(res);
    expect(tableCount('account')).toBe(0);
  });

  it('已初始化后重复 initialize → 409,原家庭数据保持不变(原凭据仍可登录)', async () => {
    const { app } = await startFreshApp({ prefix: 'hmp-t030-' });
    await initialize(app);

    const res = await initialize(app);

    expect(res.status).toBe(409);
    expectProblemContentType(res);
    expect(res.body.code).toBe(ProblemCode.INITIALIZATION_ALREADY_DONE);
    expect(tableCount('household')).toBe(1);
    expect(tableCount('account')).toBe(1);
    expect(res.headers['set-cookie']).toBeUndefined();

    const login = await request(app.getHttpServer())
      .post('/api/auth/login')
      .send({ username: INITIALIZE_BODY.username, password: INITIALIZE_BODY.password });
    expect(login.status).toBe(200);
  });
});
