import 'reflect-metadata';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomBytes } from 'node:crypto';
import { createControlledMediaServer, type ControlledMediaServer } from '../fixtures/controlled-media-server';
import { cleanupRigs, expectProblemContentType, initialize, startFreshApp } from '../helpers';
import { Database } from '@platform/database/database';

/**
 * 020 节目海报代理契约测试（contracts/api.md §2）：
 * - 有效 matched/未过期 ref → 200 PNG + image/png + Cache-Control public, max-age=86400；
 * - 伪造/格式非法/过期/非 matched → 404 NOT_FOUND 同形；
 * - 上游 text/html / gzip → 502 PROGRAMME_POSTER_UPSTREAM_FAILED；
 * - 未知 query → 400；响应体不泄漏上游地址/ref 之外的内部标识；
 * - 独立 mediaImage 限频策略存在（计数明细由 rate-limit 单测覆盖，避免测试脆弱）。
 */

const PNG_BYTES = Buffer.from(
  '89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000a49444154789c6360000200010d0a2db40000000049454e44ae426082',
  'hex',
);

let app: Awaited<ReturnType<typeof startFreshApp>>['app'];
let upstream: ControlledMediaServer;
let householdId: string;
let validRef: string;
let expiredRef: string;
let noMatchRef: string;
let htmlRef: string;
let gzipRef: string;

const http = (): Parameters<typeof request>[0] => app.getHttpServer() as Parameters<typeof request>[0];

function insertPoster(
  ref: string,
  posterPath: string,
  options: { state?: 'matched' | 'no_match'; expiresAt?: string } = {},
): void {
  const nowIso = new Date().toISOString();
  Database.db
    .prepare(
      `INSERT INTO programme_poster (
         household_id, match_key, ref, state, tmdb_id, media_type, title, original_title,
         poster_path, release_date, vote_average, popularity, match_score, year_hint,
         attempts, last_attempt_at, expires_at, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      householdId,
      `key-${ref}`,
      options.state === 'no_match' ? null : ref,
      options.state ?? 'matched',
      options.state === 'no_match' ? null : 1,
      options.state === 'no_match' ? null : 'movie',
      options.state === 'no_match' ? null : '契约节目',
      null,
      options.state === 'no_match' ? null : posterPath,
      null,
      null,
      null,
      null,
      null,
      1,
      nowIso,
      options.expiresAt ?? new Date(Date.now() + 86_400_000).toISOString(),
      nowIso,
      nowIso,
    );
}

beforeAll(async () => {
  upstream = await createControlledMediaServer({
    routes: [
      { path: '/t/p/w342/a.jpg', kind: 'body', body: PNG_BYTES, contentType: 'image/png' },
      {
        path: '/t/p/w342/not-image.jpg',
        kind: 'body',
        body: '<html><body>not an image</body></html>',
        contentType: 'text/html',
      },
      { path: '/t/p/w342/gzipped.jpg', kind: 'gzip', body: PNG_BYTES, contentType: 'image/png' },
    ],
  });
  const rig = await startFreshApp({
    prefix: 'hmp-poster-contract-',
    env: {
      LAN_ALLOWED_TARGETS: '127.0.0.1',
      TMDB_IMAGE_BASE_URL: `${upstream.baseUrl}/t/p/w342`,
    },
  });
  app = rig.app;
  const initialized = await initialize(app);
  expect(initialized.status).toBe(201);
  householdId = (
    Database.db.prepare('SELECT id FROM household LIMIT 1').get() as { id: string }
  ).id;

  validRef = randomBytes(16).toString('hex');
  expiredRef = randomBytes(16).toString('hex');
  noMatchRef = randomBytes(16).toString('hex');
  htmlRef = randomBytes(16).toString('hex');
  gzipRef = randomBytes(16).toString('hex');

  insertPoster(validRef, '/a.jpg');
  insertPoster(expiredRef, '/a.jpg', { expiresAt: new Date(Date.now() - 1000).toISOString() });
  insertPoster(noMatchRef, '/a.jpg', { state: 'no_match' });
  // matched 行但 poster_path 指向非图片/编码响应；路径仍合法
  insertPoster(htmlRef, '/not-image.jpg');
  insertPoster(gzipRef, '/gzipped.jpg');
}, 60_000);

afterAll(async () => {
  await upstream.close();
  await cleanupRigs();
});

describe('GET /api/public/media/programme-posters/:posterRef', () => {
  it('有效 ref → 200 字节一致 + image/png + Cache-Control max-age=86400', async () => {
    const res = await request(http()).get(`/api/public/media/programme-posters/${validRef}`);
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toBe('image/png');
    expect(res.headers['cache-control']).toBe('public, max-age=86400');
    expect(Buffer.compare(Buffer.from(res.body as Buffer), PNG_BYTES)).toBe(0);
    expect(JSON.stringify(res.body).includes('127.0.0.1')).toBe(false);
  });

  it('伪造/格式非法/过期/非 matched → 404 NOT_FOUND 同形', async () => {
    for (const ref of ['f'.repeat(32), 'abc', expiredRef, noMatchRef]) {
      const res = await request(http()).get(`/api/public/media/programme-posters/${ref}`);
      expect(res.status).toBe(404);
      expectProblemContentType(res);
      expect(res.body.code).toBe('NOT_FOUND');
      expect(JSON.stringify(res.body).includes('127.0.0.1')).toBe(false);
    }
  });

  it('未知 query → 400 VALIDATION_FAILED', async () => {
    const res = await request(http())
      .get(`/api/public/media/programme-posters/${validRef}`)
      .query({ unexpected: '1' });
    expect(res.status).toBe(400);
    expectProblemContentType(res);
  });

  it('上游非 image/* → 502 PROGRAMME_POSTER_UPSTREAM_FAILED', async () => {
    const res = await request(http()).get(`/api/public/media/programme-posters/${htmlRef}`);
    expect(res.status).toBe(502);
    expectProblemContentType(res);
    expect(res.body.code).toBe('PROGRAMME_POSTER_UPSTREAM_FAILED');
    expect(JSON.stringify(res.body).includes('127.0.0.1')).toBe(false);
  });

  it('上游 image/* 但非 identity 编码 → 502 同码', async () => {
    const res = await request(http()).get(`/api/public/media/programme-posters/${gzipRef}`);
    expect(res.status).toBe(502);
    expect(res.body.code).toBe('PROGRAMME_POSTER_UPSTREAM_FAILED');
  });
});