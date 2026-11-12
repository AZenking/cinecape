import 'reflect-metadata';
import request from 'supertest';
import { afterEach, describe, expect, it } from 'vitest';
import { Database } from '@platform/database/database';
import {
  login,
  cleanupRigs, cookiePairOf, initialize, startFreshApp, INITIALIZE_BODY} from '../helpers';
import { ensureSettingsUnlocked } from '../helpers-management';

describe('阶段 1 收尾：就绪与主账号权限', () => {
  afterEach(cleanupRigs);

  it('FR-001: 无迁移版本记录时返回 503，不把可连接空库当就绪', async () => {
    const { app } = await startFreshApp();
    Database.db.exec('DROP TABLE IF EXISTS _migrations');
    const response = await request(app.getHttpServer()).get('/api/healthz');
    expect(response.status).toBe(503);
    expect(response.body.code).toBe('NOT_READY');
  });

  it('FR-001: 迁移与业务表齐备返回 200，缺表时返回 503', async () => {
    const { app } = await startFreshApp();
    expect((await request(app.getHttpServer()).get('/api/healthz')).status).toBe(200);
    Database.db.exec('DROP TABLE device_session');
    expect((await request(app.getHttpServer()).get('/api/healthz')).status).toBe(503);
  });

  it('FR-001: 未知或缺失的迁移版本返回 503', async () => {
    const { app } = await startFreshApp();
    Database.db.exec("CREATE TABLE IF NOT EXISTS _migrations (name TEXT PRIMARY KEY, applied_at TEXT NOT NULL); DELETE FROM _migrations; INSERT INTO _migrations VALUES ('unknown', '2026-10-23');");
    expect((await request(app.getHttpServer()).get('/api/healthz')).status).toBe(503);
  });

  it('FR-013/019: 非 owner 不能创建或编辑 Profile，伪造 role 无效', async () => {
    const { app } = await startFreshApp();
    const init = await initialize(app);
    expect(init.status).toBe(201);
    // 005 T036:初始化不再自动登录(无 Set-Cookie),显式登录取得会话 Cookie
    const loggedIn = await login(app, INITIALIZE_BODY.username, INITIALIZE_BODY.password);
    expect(loggedIn.status).toBe(200);
    const cookie = cookiePairOf(loggedIn);
    await ensureSettingsUnlocked(app, cookie);
    const created = await request(app.getHttpServer()).post('/api/settings/profiles').set('Cookie', cookie)
      .send({ name: 'owner-created', type: 'adult' });
    expect(created.status).toBe(201);
    Database.db.prepare("UPDATE account SET role = 'admin'").run();
    expect((await request(app.getHttpServer()).get('/api/profiles').set('Cookie', cookie)).status).toBe(200);
    // 005:settings 边界 = owner/admin;未知身份声明字段(role)→ 400 严格拒绝,不落库
    const createdForbidden = await request(app.getHttpServer()).post('/api/settings/profiles').set('Cookie', cookie)
      .send({ name: 'forbidden', type: 'adult', role: 'owner' });
    expect(createdForbidden.status).toBe(400);
    expect(createdForbidden.body.code).toBe('VALIDATION_FAILED');
    const adminVersion = (
      Database.db.prepare('SELECT version FROM profile WHERE id = ?').get(created.body.id) as { version: number }
    ).version;
    const editForbidden = await request(app.getHttpServer()).patch(`/api/settings/profiles/${String(created.body.id)}`).set('Cookie', cookie)
      .send({ name: 'forbidden', role: 'owner', expectedVersion: adminVersion });
    expect(editForbidden.status).toBe(400);
    expect(editForbidden.body.code).toBe('VALIDATION_FAILED');
    const rows = Database.db.prepare('SELECT name FROM profile').all();
    // 主档案(夹具)+ owner-created;伪造写入均未落库
    expect(rows.map((row) => (row as { name: string }).name).sort()).toEqual(['owner-created', '主档案']);
  });
});
