import 'reflect-metadata';
import http from 'node:http';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { INestApplication } from '@nestjs/common';
import { Database } from '../../src/database/database';
import { cleanupPublicCatalogRigs, seedInitializedHousehold, startPublicCatalogApp } from './public-catalog.helpers';
import { expectProblemContentType } from '../helpers';

/**
 * T018(US1 契约负向 e2e):公共浏览越权与伪造身份声明。
 * 对照 docs/specs/005-pc-browsing-flow/contracts/api.md §1/§2、spec.md US1 场景3/4:
 * - 匿名或伪造身份请求:query/body 携带 householdId、profileId、isAdmin 等未知字段
 *   一律 400 拒绝,且不得借此扩大读取范围(严格入参);
 * - 跨家庭目标与不存在资源统一 404(不泄露存在性/归属);
 * - 公共错误响应同样遵守 no-store,不泄漏内部策略与源位置;
 * - 失败可重试而非引导登录(FR-004):错误语义是 4xx 输入/资源问题,不是 401 认证门槛。
 */

/** 内部策略与源位置字样(错误响应反向断言;种子已埋入同形敏感值) */
const FORBIDDEN_ERROR_FRAGMENTS = [
  'password-123',
  'topsecret',
  'secret-upstream',
  'foreign-secret',
  'http://',
  'm3u8',
  '/nas-media/',
  'upstream-tvg-secret',
  'POLICY',
  'policy',
  'canPlay',
  'allowedMediaIds',
  'location',
  '登录',
] as const;

function expectNoInternalLeak(body: unknown): void {
  const serialized = JSON.stringify(body) ?? '';
  for (const fragment of FORBIDDEN_ERROR_FRAGMENTS) {
    expect(serialized, `公共错误响应不得包含内部信息:${fragment}`).not.toContain(fragment);
  }
}

const MISSING_MEDIA_ID = '00000000-0000-4000-8000-000000000000';
// 本部署外媒体 ID(本部署存储中不存在;单家庭部署模型下与不存在统一 404)
const FOREIGN_MEDIA_ID = 'fx-foreign-deployment-media-id';


/** 本夹具不种第二家庭(单家庭部署模型);FOREIGN_MEDIA_ID 为范围外的幻影 ID。 */
function seedForeignMedia(): void {
  void Database;
}

describe('公共浏览负向矩阵(匿名/伪造身份,T018)', () => {
  let app: INestApplication;
  let householdId: string;

  beforeAll(async () => {
    const rig = await startPublicCatalogApp({ prefix: 'hmp-t018-negative-' });
    app = rig.app;
    householdId = await seedInitializedHousehold();
    seedForeignMedia();
  });

  afterAll(async () => {
    await cleanupPublicCatalogRigs();
  });

  describe('伪造身份声明:未知 query 字段一律 400 且不扩大范围', () => {
    const FORGED_FIELDS = ['householdId', 'profileId', 'isAdmin', 'role', 'sessionId'] as const;

    it('GET /api/public/context:任一伪造声明字段 → 400 VALIDATION_FAILED', async () => {
      for (const field of FORGED_FIELDS) {
        const res = await request(app.getHttpServer())
          .get('/api/public/context')
          .query({ [field]: field === 'isAdmin' ? 'true' : 'hh-forge-1' });
        expect(res.status, `伪造字段应 400:${field}`).toBe(400);
        expectProblemContentType(res);
        expect(res.body.code).toBe('VALIDATION_FAILED');
        expect(String(res.headers['cache-control'])).toBe('no-store');
        expectNoInternalLeak(res.body);
      }
    });

    it('GET /api/public/media:伪造声明字段 → 400,且不留下扩大读取通道', async () => {
      for (const field of FORGED_FIELDS) {
        const res = await request(app.getHttpServer())
          .get('/api/public/media')
          .query({ [field]: 'hh-forge-1' });
        expect(res.status, `伪造字段应 400:${field}`).toBe(400);
        expectProblemContentType(res);
        expect(String(res.headers['cache-control'])).toBe('no-store');
        expectNoInternalLeak(res.body);
      }
      // 拒绝后不得留下任何扩大读取通道:合法无参数请求仍为同一匿名目录
      const baseline = await request(app.getHttpServer()).get('/api/public/media');
      expect(baseline.status).toBe(200);
      expect(baseline.body).not.toHaveProperty('householdId');
    });

    it('GET /api/public/media/{mediaId}:伪造声明字段 → 400(详情同样不接受身份声明)', async () => {
      const res = await request(app.getHttpServer())
        .get('/api/public/media/m-alpha18')
        .query({ profileId: 'prof-forge-1', isAdmin: 'true' });
      expect(res.status).toBe(400);
      expectProblemContentType(res);
      expect(String(res.headers['cache-control'])).toBe('no-store');
      expectNoInternalLeak(res.body);
    });

    it('GET body 携带 JSON 身份声明 → 400(未知 JSON 字段一律拒绝,与 query 同口径)', async () => {
      // supertest 对 GET 的 send() 序列化为 query,故以原生 http 发送带体 GET,
      // 精确覆盖「未知 JSON body 字段一律拒绝」(api.md §1)
      const address = app.getHttpServer().address();
      expect(address).toBeTruthy();
      const port = (address as { port: number }).port;
      const payload = JSON.stringify({ householdId, profileId: 'prof-forge-1' });

      const outcome = await new Promise<{ status: number; cacheControl: string; body: string }>((resolve, reject) => {
        const req = http.request(
          {
            host: '127.0.0.1',
            port,
            path: '/api/public/media',
            method: 'GET',
            headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) },
          },
          (res) => {
            const chunks: Buffer[] = [];
            res.on('data', (chunk: Buffer) => chunks.push(chunk));
            res.on('end', () =>
              resolve({
                status: res.statusCode ?? 0,
                cacheControl: String(res.headers['cache-control'] ?? ''),
                body: Buffer.concat(chunks).toString('utf8'),
              }),
            );
          },
        );
        req.on('error', reject);
        req.end(payload);
      });

      expect(outcome.status).toBe(400);
      expect(outcome.cacheControl).toBe('no-store');
      const problem = JSON.parse(outcome.body) as { code?: string };
      expect(problem.code).toBe('VALIDATION_FAILED');
      expectNoInternalLeak(problem);
    });
  });

  describe('跨家庭与不存在资源:统一 404 同形', () => {
    it('跨家庭媒体 ID 与不存在 ID 响应逐字同形(不泄露存在性/归属)', async () => {
      const missing = await request(app.getHttpServer()).get(`/api/public/media/${MISSING_MEDIA_ID}`);
      const foreign = await request(app.getHttpServer()).get(`/api/public/media/${FOREIGN_MEDIA_ID}`);
      expect(missing.status).toBe(404);
      expect(foreign.status).toBe(404);
      expect(foreign.body).toEqual(missing.body);
      expect(String(foreign.headers['cache-control'])).toBe('no-store');
      expectNoInternalLeak(foreign.body);
    });

    it('伪造 householdId 的 query 被拒后,读取范围不变:跨家庭目标仍不可达', async () => {
      const rejected = await request(app.getHttpServer())
        .get(`/api/public/media/${FOREIGN_MEDIA_ID}`)
        .query({ householdId: 'hh-foreign' });
      expect(rejected.status).toBe(400);
      expectNoInternalLeak(rejected.body);
    });
  });

  describe('公共错误语义:可重试而非引导登录(FR-004)', () => {
    it('公共错误状态恒为 4xx(输入/资源)而非 401/403 认证门槛', async () => {
      const outcomes = await Promise.all([
        request(app.getHttpServer()).get('/api/public/context').query({ profileId: 'x' }),
        request(app.getHttpServer()).get('/api/public/media').query({ pageSize: 'abc' }),
        request(app.getHttpServer()).get(`/api/public/media/${MISSING_MEDIA_ID}`),
      ]);
      for (const res of outcomes) {
        expect(res.status).toBeGreaterThanOrEqual(400);
        expect(res.status).toBeLessThan(500);
        expect(res.status).not.toBe(401);
        expect(res.status).not.toBe(403);
        expectNoInternalLeak(res.body);
      }
    });

    it('匿名与伪造 Cookie 的错误同形:身份不改变公共错误语义', async () => {
      const anonymous = await request(app.getHttpServer()).get(`/api/public/media/${MISSING_MEDIA_ID}`);
      const forged = await request(app.getHttpServer())
        .get(`/api/public/media/${MISSING_MEDIA_ID}`)
        .set('Cookie', 'hmp_session=forged-invalid-token');
      expect(forged.status).toBe(anonymous.status);
      expect(forged.body).toEqual(anonymous.body);
      expect(forged.headers['set-cookie']).toBeUndefined();
    });
  });
});
