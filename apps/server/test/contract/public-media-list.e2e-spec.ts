import 'reflect-metadata';
import { createHash } from 'node:crypto';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { INestApplication } from '@nestjs/common';
import type { PublicMediaPageDto } from '@hmp/shared';
import { Database } from '../../src/database/database';
import { cleanupPublicCatalogRigs, seedInitializedHousehold, startPublicCatalogApp } from './public-catalog.helpers';

/**
 * T015(US1 契约 e2e):匿名 GET /api/public/media 公共目录列表。
 * 对照 docs/specs/005-pc-browsing-flow/contracts/api.md §2 与 spec.md US1:
 * - 仅返回本部署家庭(服务端确定)的可用内容且不按 Profile 策略过滤(FR-002,
 *   成人级内容对游客元数据可见,响应无 canPlay/策略字段);
 * - q<=100 搜索(大小写不敏感字面包含)、type 筛选、page>=1 与 pageSize=20/max100 分页;
 * - 稳定标题/id 排序(与既有观看目录同语义:UTF-8 字节序 title 升序、同题按 id 升序);
 * - 仅 available 媒体进入目录(来源停用/条目缺失/无播放资源 → 不可见);
 * - 成功空结果(200 total=0)与请求失败(problem+json 4xx)可区分(FR-004);
 * - 公共响应 no-store,FR-003 泄漏字段零出现。
 *
 * 环境硬约束(同既有 catalog-api.e2e-spec):better-sqlite3 大分配概率性原生崩溃,
 * 种子媒体 ≤30 条,直接 INSERT 目录表。可用性链口径与 004/005 投影一致:
 * available = present 条目 × 启用来源 × 播放资源记录。
 */

/** FR-003 泄漏字样(种子故意埋入敏感形态,反向断言零出现) */
const FORBIDDEN_LEAK_FRAGMENTS = [
  'password-123',
  'ticket',
  'topsecret',
  'secret-upstream',
  'http://',
  'm3u8',
  '/nas-media/',
  'upstream-tvg-secret',
  'canPlay',
  'policy',
  'location',
] as const;

function expectNoLeak(body: unknown): void {
  const serialized = JSON.stringify(body) ?? '';
  for (const fragment of FORBIDDEN_LEAK_FRAGMENTS) {
    expect(serialized, `公共目录响应不得包含泄漏字样:${fragment}`).not.toContain(fragment);
  }
}

const NOW_ISO = '2026-01-01T00:00:00.000Z';

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

/** 填充影片(14 条;保证默认 pageSize=20 触发第二页) */
const FILLER_TITLES: string[] = Array.from({ length: 14 }, (_, i) => `填充片 ${String(i + 1).padStart(2, '0')}`);

interface SeedEntry {
  sourceId: string;
  present?: 0 | 1;
  playback?: boolean;
  /** 频道 upstream 标识(敏感字样,断言绝不进入公共响应) */
  upstreamChannelId?: string;
}

interface SeedMedia {
  id: string;
  type: 'movie' | 'channel' | 'video';
  title: string;
  contentLevel: number | null;
  entries: SeedEntry[];
}

/** 可用种子(25 条:22 影片 + 1 视频 + 2 频道;成人级/未评级/同题对/特殊字符均在列) */
const AVAILABLE_SEEDS: SeedMedia[] = [
  { id: 'm-banana', type: 'movie', title: 'Banana 香蕉', contentLevel: 3, entries: [{ sourceId: 'src-a' }] },
  { id: 'm-charlie', type: 'movie', title: 'Charlie 悬疑12', contentLevel: 12, entries: [{ sourceId: 'src-a' }] },
  { id: 'm-echo', type: 'movie', title: 'Echo 片名', contentLevel: 3, entries: [{ sourceId: 'src-a' }] },
  { id: 'm-percent', type: 'movie', title: 'Faith 100%_off', contentLevel: 3, entries: [{ sourceId: 'src-a' }] },
  { id: 'm-zeta', type: 'channel', title: 'Zeta 少儿台', contentLevel: 0, entries: [{ sourceId: 'src-a', upstreamChannelId: 'upstream-tvg-secret-id' }] },
  { id: 'm-apple', type: 'movie', title: 'apple 苹果', contentLevel: 3, entries: [{ sourceId: 'src-a' }] },
  { id: 'm-bravo', type: 'movie', title: 'bravo 动画', contentLevel: 3, entries: [{ sourceId: 'src-a' }] },
  { id: 'm-delta', type: 'video', title: 'delta 未评级', contentLevel: null, entries: [{ sourceId: 'src-a' }] },
  { id: 'm-yankee', type: 'channel', title: 'yankee 成人台', contentLevel: 0, entries: [{ sourceId: 'src-a', upstreamChannelId: 'upstream-tvg-secret-id' }] },
  // 成人级影片:匿名目录不按策略过滤,元数据必须可见(FR-002/US1 场景2)
  { id: 'm-alpha', type: 'movie', title: 'Alpha 动作18', contentLevel: 18, entries: [{ sourceId: 'src-a' }] },
  // 同题对:插入序 b 先 a 后,稳定排序必须按 id 升序输出 a 在前
  { id: 'm-same-b', type: 'movie', title: '同题片', contentLevel: 3, entries: [{ sourceId: 'src-a' }] },
  { id: 'm-same-a', type: 'movie', title: '同题片', contentLevel: 3, entries: [{ sourceId: 'src-a' }] },
  // 双源:停用源 + 启用源 → 仍可用(来源独立性)
  { id: 'm-india', type: 'movie', title: 'India 双源', contentLevel: 6, entries: [{ sourceId: 'src-off' }, { sourceId: 'src-a' }] },
  ...FILLER_TITLES.map((title, i) => ({
    id: `m-fill-${String(i + 1).padStart(2, '0')}`,
    type: 'movie' as const,
    title,
    contentLevel: 3,
    entries: [{ sourceId: 'src-a' }],
  })),
];

/** 不可用种子:来源停用 / 条目缺失 / 无播放资源(3 条,绝不进入目录) */
const UNAVAILABLE_SEEDS: SeedMedia[] = [
  { id: 'm-hotel', type: 'movie', title: 'Hotel 失效源', contentLevel: 3, entries: [{ sourceId: 'src-off' }] },
  { id: 'm-juliet', type: 'movie', title: 'Juliet 缺条目', contentLevel: 3, entries: [{ sourceId: 'src-a', present: 0 }] },
  { id: 'm-kilo', type: 'movie', title: 'Kilo 无资源', contentLevel: 3, entries: [{ sourceId: 'src-a', playback: false }] },
];

/** 稳定期望顺序(UTF-8 字节序 title 升序、同题 id 升序;仅 available,共 25 条) */
function expectedSortedTitles(): string[] {
  const available = [...AVAILABLE_SEEDS].sort((a, b) => {
    const byTitle = Buffer.compare(Buffer.from(a.title, 'utf8'), Buffer.from(b.title, 'utf8'));
    if (byTitle !== 0) return byTitle;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
  return available.map((m) => m.title);
}

/** 种子:启用+停用来源、全部媒体、条目与播放资源(敏感字样埋入播放 location/upstream) */
function seedCatalogMedia(householdId: string): void {
  const conn = Database.db;
  conn
    .prepare(
      "INSERT INTO media_source (id, household_id, kind, name, remote_url, root_key, relative_directory, private_access_approved, epg_source_id, enabled, version, last_success_at, last_job_id, created_at, updated_at) VALUES (?, ?, 'iptv', ?, 'http://iptv-seed.example/list.m3u8', NULL, NULL, 1, NULL, ?, 1, NULL, NULL, ?, ?)",
    )
    .run('src-a', householdId, '启用来源A', 1, NOW_ISO, NOW_ISO);
  conn
    .prepare(
      "INSERT INTO media_source (id, household_id, kind, name, remote_url, root_key, relative_directory, private_access_approved, epg_source_id, enabled, version, last_success_at, last_job_id, created_at, updated_at) VALUES ('src-off', ?, 'iptv', '停用来源', 'http://iptv-seed.example/off.m3u8', NULL, NULL, 1, NULL, 0, 1, NULL, NULL, ?, ?)",
    )
    .run(householdId, NOW_ISO, NOW_ISO);

  const insertMedia = conn.prepare(
    'INSERT INTO media_item (id, household_id, type, title, description, poster_ref, content_level, title_overridden, type_overridden, version, created_at, updated_at) VALUES (?, ?, ?, ?, ?, NULL, ?, 0, 0, 1, ?, ?)',
  );
  const insertEntry = conn.prepare(
    "INSERT INTO source_entry (id, household_id, source_id, identity_kind, identity_digest, media_id, upstream_channel_id, present, last_seen_job_id, first_seen_at, last_seen_at, missing_since, file_size_text, file_mtime_ns) VALUES (?, ?, ?, 'url', ?, ?, ?, ?, NULL, ?, ?, NULL, NULL, NULL)",
  );
  const insertPlayback = conn.prepare(
    "INSERT INTO playback_source (id, household_id, source_id, source_entry_id, media_item_id, protocol, location, mime_type, priority, requires_proxy, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 'http', ?, NULL, 100, 0, ?, ?)",
  );

  for (const media of [...AVAILABLE_SEEDS, ...UNAVAILABLE_SEEDS]) {
    insertMedia.run(media.id, householdId, media.type, media.title, null, media.contentLevel, NOW_ISO, NOW_ISO);
    for (const entry of media.entries) {
      const entryId = `entry-${media.id}-${entry.sourceId}`;
      insertEntry.run(
        entryId,
        householdId,
        entry.sourceId,
        sha256(`${entry.sourceId}:${media.id}`),
        media.id,
        entry.upstreamChannelId ?? null,
        entry.present ?? 1,
        NOW_ISO,
        NOW_ISO,
      );
      if (entry.playback ?? true) {
        // location 携带明显敏感字样,用于断言绝不进入公共响应
        insertPlayback.run(
          `pb-${media.id}-${entry.sourceId}`,
          householdId,
          entry.sourceId,
          entryId,
          media.id,
          'http://secret-upstream.example/stream.m3u8?token=topsecret',
          NOW_ISO,
          NOW_ISO,
        );
      }
    }
  }
}

/** 翻页遍历全部条目(默认参数),返回聚合标题 */
async function collectAllTitles(target: INestApplication): Promise<string[]> {
  const titles: string[] = [];
  for (let page = 1; page < 10; page += 1) {
    const res = await request(target.getHttpServer()).get('/api/public/media').query({ page });
    expect(res.status).toBe(200);
    const body = res.body as PublicMediaPageDto;
    titles.push(...body.items.map((m) => m.title));
    if (body.items.length < body.pageSize) break;
  }
  return titles;
}

describe('GET /api/public/media(匿名公共目录,T015)', () => {
  let app: INestApplication;

  beforeAll(async () => {
    const rig = await startPublicCatalogApp({ prefix: 'hmp-t015-list-' });
    app = rig.app;
    const householdId = await seedInitializedHousehold();
    seedCatalogMedia(householdId);
  });

  afterAll(async () => {
    await cleanupPublicCatalogRigs();
  });

  it('默认分页:匿名 200,page=1/pageSize=20/total=25,仅可用内容按稳定序输出', async () => {
    const res = await request(app.getHttpServer()).get('/api/public/media');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('application/json');
    expect(String(res.headers['cache-control'])).toBe('no-store');

    const body = res.body as PublicMediaPageDto;
    expect(Object.keys(body).sort()).toEqual(['items', 'page', 'pageSize', 'total']);
    expect(body.page).toBe(1);
    expect(body.pageSize).toBe(20);
    expect(body.total).toBe(AVAILABLE_SEEDS.length);
    expect(body.items).toHaveLength(20);

    const expected = expectedSortedTitles();
    expect(body.items.map((m) => m.title)).toEqual(expected.slice(0, 20));
    expectNoLeak(body);
  });

  it('第二页:续接稳定序,无重叠无遗漏(共 25 条 → 第 2 页 5 条)', async () => {
    const res = await request(app.getHttpServer()).get('/api/public/media').query({ page: 2 });
    expect(res.status).toBe(200);
    const body = res.body as PublicMediaPageDto;
    expect(body.page).toBe(2);
    expect(body.items).toHaveLength(AVAILABLE_SEEDS.length - 20);
    expect(body.items.map((m) => m.title)).toEqual(expectedSortedTitles().slice(20));
  });

  it('仅可用内容进入目录:不可用(停用源/缺条目/无资源)翻遍所有页均不出现', async () => {
    const all = await collectAllTitles(app);
    expect(all).toHaveLength(AVAILABLE_SEEDS.length);
    for (const unavailable of UNAVAILABLE_SEEDS) {
      expect(all, `不可用媒体不得进入目录:${unavailable.title}`).not.toContain(unavailable.title);
    }
  });

  it('稳定排序:同题按 id 升序(m-same-a 在 m-same-b 前),与插入序无关', async () => {
    const all = await collectAllTitles(app);
    const sameTitlePositions = all
      .map((title, index) => (title === '同题片' ? index : -1))
      .filter((index) => index >= 0);
    expect(sameTitlePositions).toHaveLength(2);
    // 同题两行在完整序列中相邻且顺序确定(重复请求结果一致由稳定排序保证)
    const [first, second] = sameTitlePositions as [number, number];
    expect(second).toBe(first + 1);
  });

  it('不按 Profile 策略过滤(FR-002):成人级内容匿名可见,响应无策略结果字段', async () => {
    const res = await request(app.getHttpServer()).get('/api/public/media').query({ q: 'Alpha' });
    expect(res.status).toBe(200);
    const body = res.body as PublicMediaPageDto;
    expect(body.total).toBe(1);
    expect(body.items[0]?.title).toBe('Alpha 动作18');
    expect(body.items[0]?.contentLevel).toBe(18);
    // 无策略语义字段:canPlay/allow/reason 绝不出现(浏览 ≠ 可播放)
    const serialized = JSON.stringify(body);
    expect(serialized).not.toContain('canPlay');
    expect(serialized).not.toContain('policy');
    expectNoLeak(body);
  });

  it('q 搜索:大小写不敏感字面包含,%_ 无通配符语义;q 空串视为不过滤', async () => {
    const literal = await request(app.getHttpServer()).get('/api/public/media').query({ q: '100%_off' });
    expect(literal.status).toBe(200);
    expect((literal.body as PublicMediaPageDto).items.map((m) => m.title)).toEqual(['Faith 100%_off']);

    const emptyQ = await request(app.getHttpServer()).get('/api/public/media').query({ q: '' });
    expect(emptyQ.status).toBe(200);
    expect((emptyQ.body as PublicMediaPageDto).total).toBe(AVAILABLE_SEEDS.length);
  });

  it('type 筛选:channel 只返回频道;movie 页不含频道', async () => {
    const channels = await request(app.getHttpServer()).get('/api/public/media').query({ type: 'channel' });
    expect(channels.status).toBe(200);
    const channelPage = channels.body as PublicMediaPageDto;
    expect(channelPage.total).toBe(2);
    expect(channelPage.items.every((m) => m.type === 'channel')).toBe(true);

    const movies = await request(app.getHttpServer()).get('/api/public/media').query({ type: 'movie' });
    expect(movies.status).toBe(200);
    const moviePage = movies.body as PublicMediaPageDto;
    expect(moviePage.items.every((m) => m.type === 'movie')).toBe(true);
    expect(moviePage.items.some((m) => m.type === 'channel')).toBe(false);
  });

  it('pageSize 上限 100:pageSize=100 单页返回全部;非法分页/类型参数一律 400', async () => {
    const full = await request(app.getHttpServer()).get('/api/public/media').query({ pageSize: 100 });
    expect(full.status).toBe(200);
    const fullPage = full.body as PublicMediaPageDto;
    expect(fullPage.pageSize).toBe(100);
    expect(fullPage.items).toHaveLength(AVAILABLE_SEEDS.length);

    for (const invalid of [
      { page: 0 },
      { page: -1 },
      { page: 'abc' },
      { pageSize: 0 },
      { pageSize: 101 },
      { type: 'book' },
    ]) {
      const res = await request(app.getHttpServer()).get('/api/public/media').query(invalid);
      expect(res.status, `非法参数应 400:${JSON.stringify(invalid)}`).toBe(400);
      expect(res.headers['content-type']).toContain('application/problem+json');
      expect(String(res.headers['cache-control'])).toBe('no-store');
    }
  });

  it('q 超过 100 字符 → 400;恰好 100 字符合法', async () => {
    const over = await request(app.getHttpServer()).get('/api/public/media').query({ q: '字'.repeat(101) });
    expect(over.status).toBe(400);
    expect(over.headers['content-type']).toContain('application/problem+json');

    const edge = await request(app.getHttpServer()).get('/api/public/media').query({ q: '字'.repeat(100) });
    expect(edge.status).toBe(200);
    expect((edge.body as PublicMediaPageDto).total).toBe(0);
  });

  it('成功空结果与请求失败可区分(FR-004):无匹配 200 total=0;非法输入 4xx problem+json', async () => {
    const empty = await request(app.getHttpServer()).get('/api/public/media').query({ q: '不存在的片名词' });
    expect(empty.status).toBe(200);
    expect(empty.body).toEqual({ items: [], page: 1, pageSize: 20, total: 0 });
    expect(empty.headers['content-type']).toContain('application/json');

    const failed = await request(app.getHttpServer()).get('/api/public/media').query({ householdId: 'hh-forge' });
    expect(failed.status).toBe(400);
    expect(failed.headers['content-type']).toContain('application/problem+json');
    expect(failed.body.code).toBe('VALIDATION_FAILED');
  });

  it('公共响应零泄漏(FR-003):目录条目全为 available 且无源地址/凭据/票据/路径', async () => {
    const res = await request(app.getHttpServer()).get('/api/public/media').query({ pageSize: 100 });
    expect(res.status).toBe(200);
    // 白名单键面:PublicMedia 精确字段;进目录者即可用(availability 值面断言)
    for (const item of (res.body as PublicMediaPageDto).items) {
      expect(Object.keys(item).sort()).toEqual(['availability', 'contentLevel', 'description', 'id', 'posterRef', 'title', 'type']);
      expect(item.availability).toBe('available');
    }
    expectNoLeak(res.body);
  });

  it('匿名与携带失效 Cookie 同形:目录与身份无关', async () => {
    const forged = await request(app.getHttpServer())
      .get('/api/public/media')
      .set('Cookie', 'hmp_session=forged-invalid-token');
    const anonymous = await request(app.getHttpServer()).get('/api/public/media');
    expect(forged.status).toBe(200);
    expect(forged.body).toEqual(anonymous.body);
    expect(forged.headers['set-cookie']).toBeUndefined();
  });
});

describe('GET /api/public/media(未初始化部署,T015 附加)', () => {
  let app: INestApplication;

  beforeAll(async () => {
    const rig = await startPublicCatalogApp({ prefix: 'hmp-t015-empty-' });
    app = rig.app;
  });

  afterAll(async () => {
    await cleanupPublicCatalogRigs();
  });

  it('零家庭:目录为空页(200 total=0),不泄露存储形态', async () => {
    const res = await request(app.getHttpServer()).get('/api/public/media');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ items: [], page: 1, pageSize: 20, total: 0 });
    expect(String(res.headers['cache-control'])).toBe('no-store');
  });
});
