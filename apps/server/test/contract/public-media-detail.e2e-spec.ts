import 'reflect-metadata';
import { createHash } from 'node:crypto';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { INestApplication } from '@nestjs/common';
import type { PublicMediaDto } from '@hmp/shared';
import { Database } from '../../src/database/database';
import { cleanupPublicCatalogRigs, seedInitializedHousehold, startPublicCatalogApp } from './public-catalog.helpers';

/**
 * T016(US1 契约 e2e):匿名 GET /api/public/media/{mediaId} 公共详情。
 * 对照 docs/specs/005-pc-browsing-flow/contracts/api.md §2 与 data-model.md §9:
 * - 详情可读:PublicMedia 白名单精确字段(id/type/title/description/posterRef/contentLevel/
 *   availability),元数据对游客完全可见(成人级不隐藏,US1 场景2);
 * - 无个人状态(历史/进度/收藏)、无播放 URL、无票据;
 * - 负向:不存在与本部署外(跨家庭猜测)媒体 ID 统一 404 同形(不泄露存在性);
 * - 不可用媒体不在公共详情(公共目录/详情只返回 available,同形 404);
 * - FR-003:成功与错误响应均不含源地址、路径、来源凭据、密码或 PIN 哈希、播放票据
 *   及可直接取得媒体流的地址;公共响应 no-store;失败可重试而非引导登录(FR-004)。
 */

/** FR-003 泄漏字样(种子故意埋入,反向断言零出现) */
const FORBIDDEN_LEAK_FRAGMENTS = [
  'password-123',
  'ticket',
  'topsecret',
  'secret-upstream',
  'foreign-secret',
  'http://',
  'm3u8',
  '/nas-media/',
  'upstream-tvg-secret',
  'canPlay',
  'policy',
  'location',
  'progress',
  'history',
  'favorite',
] as const;

function expectNoLeak(body: unknown): void {
  const serialized = JSON.stringify(body) ?? '';
  for (const fragment of FORBIDDEN_LEAK_FRAGMENTS) {
    expect(serialized, `公共详情响应不得包含泄漏字样:${fragment}`).not.toContain(fragment);
  }
}

const NOW_ISO = '2026-01-01T00:00:00.000Z';
const MISSING_MEDIA_ID = '00000000-0000-4000-8000-000000000000';
// 本部署外的媒体 ID(其他部署/家庭可能存在的形态;本部署存储中不存在)。
// 公共部署模型为单家庭(data-model §1):不存在与本部署外 ID 的公共读取结果
// 必须统一同形 404,实现以 household_id 谓词界定读取范围,任何范围外 ID 皆不可达。
const FOREIGN_MEDIA_ID = 'fx-foreign-deployment-media-id';

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

/** 种子:本家庭可用成人级影片 + 不可用影片;他家庭一条完整可用链(跨家庭猜测目标) */
function seedDetailMedia(householdId: string): void {
  const conn = Database.db;
  conn
    .prepare(
      "INSERT INTO media_source (id, household_id, kind, name, remote_url, root_key, relative_directory, private_access_approved, epg_source_id, enabled, version, last_success_at, last_job_id, created_at, updated_at) VALUES ('src-a', ?, 'iptv', '启用来源A', 'http://iptv-seed.example/list.m3u8', NULL, NULL, 1, NULL, 1, 1, NULL, NULL, ?, ?)",
    )
    .run(householdId, NOW_ISO, NOW_ISO);

  const insertMedia = conn.prepare(
    'INSERT INTO media_item (id, household_id, type, title, description, poster_ref, content_level, title_overridden, type_overridden, version, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, 0, 0, 1, ?, ?)',
  );
  const insertEntry = conn.prepare(
    "INSERT INTO source_entry (id, household_id, source_id, identity_kind, identity_digest, media_id, upstream_channel_id, present, last_seen_job_id, first_seen_at, last_seen_at, missing_since, file_size_text, file_mtime_ns) VALUES (?, ?, ?, 'url', ?, ?, ?, ?, NULL, ?, ?, ?, NULL, NULL)",
  );
  const insertPlayback = conn.prepare(
    "INSERT INTO playback_source (id, household_id, source_id, source_entry_id, media_item_id, protocol, location, mime_type, priority, requires_proxy, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 'http', ?, NULL, 100, 0, ?, ?)",
  );

  // 可用成人级影片:导入管线 poster_ref 恒为 NULL;description 投影可见
  insertMedia.run(
    'm-alpha18', householdId, 'movie', 'Alpha 动作18',
    '成人级剧情简介(游客可见,不按策略隐藏)',
    null, 18, NOW_ISO, NOW_ISO,
  );
  insertEntry.run('entry-alpha', householdId, 'src-a', sha256('src-a:m-alpha18'), 'm-alpha18', 'upstream-tvg-secret-id', 1, NOW_ISO, NOW_ISO, null);
  insertPlayback.run('pb-alpha', householdId, 'src-a', 'entry-alpha', 'm-alpha18', 'http://secret-upstream.example/stream.m3u8?token=topsecret', NOW_ISO, NOW_ISO);

  // 不可用(present=0):公共详情同形 404,不泄露存在性
  insertMedia.run('m-juliet', householdId, 'movie', 'Juliet 缺条目', null, null, 3, NOW_ISO, NOW_ISO);
  insertEntry.run('entry-juliet', householdId, 'src-a', sha256('src-a:m-juliet'), 'm-juliet', null, 0, NOW_ISO, NOW_ISO, NOW_ISO);
  insertPlayback.run('pb-juliet', householdId, 'src-a', 'entry-juliet', 'm-juliet', 'http://secret-upstream.example/stream.m3u8', NOW_ISO, NOW_ISO);

}

describe('GET /api/public/media/{mediaId}(匿名公共详情,T016)', () => {
  let app: INestApplication;

  beforeAll(async () => {
    const rig = await startPublicCatalogApp({ prefix: 'hmp-t016-detail-' });
    app = rig.app;
    const householdId = await seedInitializedHousehold();
    seedDetailMedia(householdId);
  });

  afterAll(async () => {
    await cleanupPublicCatalogRigs();
  });

  it('可用媒体详情:白名单精确投影,元数据对游客完全可见(成人级不隐藏)', async () => {
    const res = await request(app.getHttpServer()).get('/api/public/media/m-alpha18');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('application/json');
    expect(String(res.headers['cache-control'])).toBe('no-store');

    const body = res.body as PublicMediaDto;
    expect(Object.keys(body).sort()).toEqual(['availability', 'contentLevel', 'description', 'id', 'posterRef', 'title', 'type']);
    expect(body).toEqual({
      id: 'm-alpha18',
      type: 'movie',
      title: 'Alpha 动作18',
      description: '成人级剧情简介(游客可见,不按策略隐藏)',
      posterRef: null,
      contentLevel: 18,
      availability: 'available',
    });
  });

  it('无个人状态、无播放 URL/票据(历史/进度/收藏/canPlay 零出现)', async () => {
    const res = await request(app.getHttpServer()).get('/api/public/media/m-alpha18');
    expect(res.status).toBe(200);
    expectNoLeak(res.body);
  });

  it('公共响应不返回 Set-Cookie;携带失效 Cookie 仍可读详情', async () => {
    const anonymous = await request(app.getHttpServer()).get('/api/public/media/m-alpha18');
    expect(anonymous.headers['set-cookie']).toBeUndefined();

    const forged = await request(app.getHttpServer())
      .get('/api/public/media/m-alpha18')
      .set('Cookie', 'hmp_session=forged-invalid-token');
    expect(forged.status).toBe(200);
    expect(forged.body).toEqual(anonymous.body);
    expect(forged.headers['set-cookie']).toBeUndefined();
  });

  it('不存在媒体 → 404 problem+json;不引导登录、无策略与源信息(FR-004)', async () => {
    const res = await request(app.getHttpServer()).get(`/api/public/media/${MISSING_MEDIA_ID}`);
    expect(res.status).toBe(404);
    expect(res.headers['content-type']).toContain('application/problem+json');
    expect(String(res.headers['cache-control'])).toBe('no-store');
    expect(res.body.code).toBe('NOT_FOUND');

    const serialized = JSON.stringify(res.body);
    expect(serialized).not.toContain('登录');
    expectNoLeak(res.body);
  });

  it('跨家庭媒体 ID 与不存在统一同形 404(不泄露存在性与归属)', async () => {
    const missing = await request(app.getHttpServer()).get(`/api/public/media/${MISSING_MEDIA_ID}`);
    const foreign = await request(app.getHttpServer()).get(`/api/public/media/${FOREIGN_MEDIA_ID}`);
    expect(foreign.status).toBe(404);
    expect(foreign.headers['content-type']).toContain('application/problem+json');
    // 同形:code 与响应体逐字一致(统一 404,不泄露跨家庭目标存在)
    expect(foreign.body).toEqual(missing.body);
    expectNoLeak(foreign.body);
  });

  it('不可用媒体不在公共详情:present=0 → 与不存在同形 404', async () => {
    const missing = await request(app.getHttpServer()).get(`/api/public/media/${MISSING_MEDIA_ID}`);
    const unavailable = await request(app.getHttpServer()).get('/api/public/media/m-juliet');
    expect(unavailable.status).toBe(404);
    expect(unavailable.body).toEqual(missing.body);
  });
});
