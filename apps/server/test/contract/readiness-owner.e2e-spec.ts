import 'reflect-metadata';
import request from 'supertest';
import { afterEach, describe, expect, it } from 'vitest';
import { Database } from '../../src/database/database';
import { cleanupRigs, cookiePairOf, initialize, startFreshApp, INITIALIZE_BODY } from '../helpers';

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
    const cookie = cookiePairOf(init);
    const created = await request(app.getHttpServer()).post('/api/profiles').set('Cookie', cookie)
      .send({ name: 'owner-created', type: 'adult', ownerPassword: INITIALIZE_BODY.password });
    expect(created.status).toBe(201);
    Database.db.prepare("UPDATE account SET role = 'admin'").run();
    expect((await request(app.getHttpServer()).get('/api/profiles').set('Cookie', cookie)).status).toBe(200);
    for (const action of ['create', 'edit']) {
      const response = action === 'create'
        ? await request(app.getHttpServer()).post('/api/profiles').set('Cookie', cookie)
          .send({ name: 'forbidden', type: 'adult', role: 'owner', ownerPassword: INITIALIZE_BODY.password })
        : await request(app.getHttpServer()).patch(`/api/profiles/${String(created.body.id)}`).set('Cookie', cookie)
          .send({ name: 'forbidden', role: 'owner', ownerPassword: INITIALIZE_BODY.password });
      expect(response.status).toBe(403);
      expect(response.body.code).toBe('FORBIDDEN');
    }
    const rows = Database.db.prepare('SELECT name FROM profile').all();
    expect(rows).toEqual([{ name: 'owner-created' }]);
  });
});
