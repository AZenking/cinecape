import 'reflect-metadata';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { INestApplication } from '@nestjs/common';
import type { PublicContextDto } from '@hmp/shared';
import { INITIALIZE_BODY } from '../helpers';
import { cleanupPublicCatalogRigs, seedInitializedHousehold, startPublicCatalogApp } from './public-catalog.helpers';

/**
 * T014(US1 契约 e2e):匿名 GET /api/public/context 公共上下文白名单投影。
 * 对照 docs/specs/005-pc-browsing-flow/contracts/api.md §2 与 data-model.md §9:
 * - 白名单「initialized、displayName(已初始化)、timezone、language、now、catalogRevision;
 *   不返回账号、Profile、来源信息」;
 * - 未初始化返回 initialized=false 与其余默认展示值(不伪装成已初始化);
 * - 响应头遵守「公共响应 no-store」;公共浏览不返回 Set-Cookie;
 * - 携带失效 Cookie 仍可公开浏览(身份不决定公共投影,api.md §1);
 * - FR-003:响应零泄漏(源地址/路径/来源凭据/密码/PIN 哈希/播放票据)。
 */

/** PublicContext 白名单字段全集(逐字,data-model §9) */
const PUBLIC_CONTEXT_WHITELIST = [
  'initialized',
  'displayName',
  'language',
  'timezone',
  'now',
  'catalogRevision',
] as const;

/** FR-003 泄漏字样:来源地址/路径/来源凭据/密码/PIN/票据片段(响应序列化反向断言) */
const FORBIDDEN_LEAK_FRAGMENTS = [
  'password',
  'pin_',
  'pinHash',
  'ticket',
  'token',
  'http://',
  'https://',
  'm3u8',
  '/nas-media/',
  'source',
  'upstream',
  'username',
  'accountId',
  'profileId',
  'location',
] as const;

/** 公共上下文响应零泄漏断言(成功响应同用) */
function expectNoLeak(body: unknown): void {
  const serialized = JSON.stringify(body) ?? '';
  for (const fragment of FORBIDDEN_LEAK_FRAGMENTS) {
    expect(serialized, `公共上下文响应不得包含泄漏字样:${fragment}`).not.toContain(fragment);
  }
}

describe('GET /api/public/context(匿名公共上下文,T014)', () => {
  let app: INestApplication;

  beforeAll(async () => {
    const rig = await startPublicCatalogApp({ prefix: 'hmp-t014-pubctx-' });
    app = rig.app;
  });

  afterAll(async () => {
    await cleanupPublicCatalogRigs();
  });

  it('未初始化:initialized=false + 默认展示值(不伪装已初始化)', async () => {
    const res = await request(app.getHttpServer()).get('/api/public/context');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('application/json');

    const body = res.body as PublicContextDto;
    expect(body.initialized).toBe(false);
    expect(body.displayName).toBeNull();
    // 默认展示值与初始化向导默认(zh-CN / Asia/Shanghai)一致
    expect(body.language).toBe('zh-CN');
    expect(body.timezone).toBe('Asia/Shanghai');
    expect(body.catalogRevision).toBeGreaterThanOrEqual(1);
    // now 为合法服务端时刻(ISO 8601 date-time)
    expect(Number.isNaN(Date.parse(body.now))).toBe(false);
    expectNoLeak(body);
  });

  it('已初始化:白名单精确投影家庭展示字段,无账号/Profile/来源信息', async () => {
    expect(await seedInitializedHousehold()).toBe('hh-us1');

    const res = await request(app.getHttpServer()).get('/api/public/context');
    expect(res.status).toBe(200);
    const body = res.body as PublicContextDto;

    // 白名单字段逐字:键集合精确等于(多一字段即白名单破坏)
    expect(Object.keys(body).sort()).toEqual([...PUBLIC_CONTEXT_WHITELIST].sort());
    expect(body.initialized).toBe(true);
    expect(body.displayName).toBe(INITIALIZE_BODY.householdName);
    expect(body.language).toBe('zh-CN');
    expect(body.timezone).toBe('Asia/Shanghai');
    expect(body.catalogRevision).toBeGreaterThanOrEqual(1);
    expect(Number.isNaN(Date.parse(body.now))).toBe(false);

    // 不返回账号、Profile、来源信息:键面与值面均无
    const serialized = JSON.stringify(body);
    // 键面已精确断言;值面禁账号/Profile/来源语义字样(catalogRevision 属白名单字段,不在此列)
    for (const banned of ['householdId', 'account', 'profile', 'role', 'source']) {
      expect(serialized).not.toContain(banned);
    }
    expectNoLeak(body);
  });

  it('公共响应遵守 no-store 且不返回 Set-Cookie', async () => {
    const res = await request(app.getHttpServer()).get('/api/public/context');
    expect(res.status).toBe(200);
    expect(String(res.headers['cache-control'])).toBe('no-store');
    expect(res.headers['set-cookie']).toBeUndefined();
  });

  it('携带失效 Cookie 仍可公开浏览:同形 200 且不返回 Set-Cookie(身份不决定公共投影)', async () => {
    const forged = await request(app.getHttpServer())
      .get('/api/public/context')
      .set('Cookie', 'hmp_session=forged-invalid-token');
    expect(forged.status).toBe(200);
    const anonymous = await request(app.getHttpServer()).get('/api/public/context');
    // now 为各自请求的服务端时刻(逐字同形断言排除该瞬时字段,其余字段必须一致)
    const { now: _forgedNow, ...forgedRest } = forged.body as Record<string, unknown>;
    const { now: _anonNow, ...anonRest } = anonymous.body as Record<string, unknown>;
    expect(forgedRest).toEqual(anonRest);
    expect(forged.headers['set-cookie']).toBeUndefined();
    expect(String(forged.headers['cache-control'])).toBe('no-store');
  });

  it('多家庭配置损坏:503 稳定码(不伪装单家庭视图、不泄露家庭数据)', async () => {
    const conn = (await import('../../src/database/database')).Database.db;
    conn
      .prepare("INSERT INTO household (id, name, created_at) VALUES ('hh-corrupt-second', '多余之家', '2026-01-02T00:00:00.000Z')")
      .run();

    const res = await request(app.getHttpServer()).get('/api/public/context');
    expect(res.status).toBe(503);
    expect(res.headers['content-type']).toContain('application/problem+json');
    expect(String(res.headers['cache-control'])).toBe('no-store');
    expect(res.body.code).toBe('STORAGE_GENERATION_UNSUPPORTED');
    // 不泄露内部形态:错误体不含家庭名/ID
    const serialized = JSON.stringify(res.body);
    expect(serialized).not.toContain('多余之家');
    expect(serialized).not.toContain('hh-corrupt-second');
  });
});
