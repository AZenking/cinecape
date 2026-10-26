import 'reflect-metadata';
import { createHash } from 'node:crypto';
import request from 'supertest';
import { afterEach, describe, expect, it } from 'vitest';
import type { INestApplication } from '@nestjs/common';
import { ProblemCode, type MediaPageDto } from '@hmp/shared';
import { Database } from '../../src/database/database';
import {
  INITIALIZE_BODY,
  cleanupRigs,
  cookiePairOf,
  expectProblemContentType,
  initialize,
  login,
  startFreshApp,
} from '../helpers';

/**
 * T032(US2 契约 e2e):观看目录 GET /media 与 GET /media/{mediaId}。
 * 对照 contracts/api.md「观看目录」节与 openapi.yaml Media/MediaPage schema:
 * - 判定链:SessionGuard → 会话/设备/档案有效与归属 → 最新策略 → 同家庭真实资源 → evaluatePolicy → DTO;
 * - 成人/儿童 × 名单交集 × 未评级 × 儿童频道门槛矩阵;total 与 items 均在权限过滤后产生;
 * - 不可用/不可见/跨家庭/不存在统一同形 404;无档案 403 ACTIVE_PROFILE_REQUIRED;
 *   策略缺失/损坏 503 POLICY_UNAVAILABLE(不作空列表);
 * - 客户端授权事实(householdId/profileId/role/facts)与非法参数一律 400;无会话 401;
 * - 响应绝无播放地址/物理路径/来源凭据/upstream tvg-id/PlaybackSource;poster=null。
 *
 * 环境硬约束:better-sqlite3 大分配概率性原生崩溃 —— 种子数据 17 条媒体(≤30),
 * 直接 INSERT 目录表,照既有契约测试的 Database.db 直访惯例。
 */

const OWNER_PASSWORD = INITIALIZE_BODY.password;
const MISSING_MEDIA_ID = '00000000-0000-4000-8000-000000000000';
const NOW_ISO = '2026-01-01T00:00:00.000Z';

/** 响应体绝不允许出现的敏感字样(对序列化字符串做反向断言) */
const FORBIDDEN_LEAK_FRAGMENTS = ['url', 'path', 'tvg', 'location', 'http', 'secret', 'm3u8', 'playback'];

interface CatalogFixture {
  app: INestApplication;
  cookie: string;
  householdId: string;
  adultProfileId: string;
  childProfileId: string;
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

interface SeedEntry {
  sourceId: string;
  present?: 0 | 1;
  playback?: boolean;
  upstreamChannelId?: string;
}

/** 目录种子:来源 + 媒体 + 条目 + 播放资源(可用性链可按条目控制) */
function seedCatalogMedia(householdId: string): void {
  const conn = Database.db;
  const insertSource = conn.prepare(
    "INSERT INTO media_source (id, household_id, kind, name, remote_url, root_key, relative_directory, private_access_approved, epg_source_id, enabled, version, last_success_at, last_job_id, created_at, updated_at) VALUES (?, ?, 'iptv', ?, 'http://iptv-seed.example/list.m3u8', NULL, NULL, 1, NULL, ?, 1, NULL, NULL, ?, ?)",
  );
  insertSource.run('src-a', householdId, '启用来源A', 1, NOW_ISO, NOW_ISO);
  insertSource.run('src-off', householdId, '停用来源', 0, NOW_ISO, NOW_ISO);

  const insertMedia = conn.prepare(
    'INSERT INTO media_item (id, household_id, type, title, description, poster_ref, content_level, title_overridden, type_overridden, version, created_at, updated_at) VALUES (?, ?, ?, ?, ?, NULL, ?, 0, 0, 1, ?, ?)',
  );
  const insertEntry = conn.prepare(
    "INSERT INTO source_entry (id, household_id, source_id, identity_kind, identity_digest, media_id, upstream_channel_id, present, last_seen_job_id, first_seen_at, last_seen_at, missing_since, file_size_text, file_mtime_ns) VALUES (?, ?, ?, 'url', ?, ?, ?, ?, NULL, ?, ?, NULL, NULL, NULL)",
  );
  const insertPlayback = conn.prepare(
    "INSERT INTO playback_source (id, household_id, source_id, source_entry_id, media_item_id, protocol, location, mime_type, priority, requires_proxy, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 'http', ?, NULL, 100, 0, ?, ?)",
  );

  const seed = (
    id: string,
    type: string,
    title: string,
    contentLevel: number | null,
    entries: SeedEntry[],
    description: string | null = null,
  ): void => {
    insertMedia.run(id, householdId, type, title, description, contentLevel, NOW_ISO, NOW_ISO);
    for (const entry of entries) {
      const entryId = `entry-${id}-${entry.sourceId}`;
      insertEntry.run(
        entryId,
        householdId,
        entry.sourceId,
        sha256(`${entry.sourceId}:${id}`),
        id,
        entry.upstreamChannelId ?? null,
        entry.present ?? 1,
        NOW_ISO,
        NOW_ISO,
      );
      if (entry.playback ?? true) {
        // location/upstreamChannelId 携带明显敏感字样,用于断言绝不进入响应
        insertPlayback.run(
          `pb-${id}-${entry.sourceId}`,
          householdId,
          entry.sourceId,
          entryId,
          id,
          'http://secret-upstream.example/stream.m3u8?token=topsecret',
          NOW_ISO,
          NOW_ISO,
        );
      }
    }
  };

  const onA: SeedEntry[] = [{ sourceId: 'src-a' }];
  seed('m-alpha', 'movie', 'Alpha 惊悚18', 18, onA, '成人惊悚描述');
  seed('m-bravo', 'movie', 'bravo 动画', 3, onA);
  seed('m-charlie', 'movie', 'Charlie 悬疑12', 12, onA);
  seed('m-delta', 'video', 'delta 未评级', null, onA);
  seed('m-echo', 'movie', 'Echo 名单交集', 3, onA);
  // 频道种子给 contentLevel=0(全年龄):evaluatePolicy 表序中「未评级」在频道白名单之后,
  // 儿童 allowUnrated=false 会拒绝未评级频道 —— 用已评级频道使白名单语义可观察。
  seed('m-zeta', 'channel', 'Zeta 少儿台', 0, [{ sourceId: 'src-a', upstreamChannelId: 'upstream-tvg-secret-id' }]);
  seed('m-yankee', 'channel', 'yankee 成人台', 0, [{ sourceId: 'src-a', upstreamChannelId: 'upstream-tvg-secret-id' }]);
  seed('m-percent', 'movie', 'Faith 100%_off', 3, onA);
  seed('m-lima', 'movie', 'Lima 100X 特', 3, onA);
  seed('m-golf', 'movie', 'Golf 下划线_片', 3, onA);
  seed('m-mike', 'movie', 'Mike 反斜杠\\片', 3, onA);
  seed('m-zebra', 'movie', 'Zebra 斑马', 3, onA);
  seed('m-apple', 'movie', 'apple 苹果', 3, onA);
  // 不可用:来源禁用
  seed('m-hotel', 'movie', 'Hotel 失效源', 3, [{ sourceId: 'src-off' }]);
  // 双源:一个停用 + 一个启用 → 仍可用(来源独立性)
  seed('m-india', 'movie', 'India 双源', 6, [{ sourceId: 'src-off' }, { sourceId: 'src-a' }]);
  // 不可用:条目缺失(present=0)
  seed('m-juliet', 'movie', 'Juliet 缺条目', 3, [{ sourceId: 'src-a', present: 0 }]);
  // 不可用:无播放资源记录
  seed('m-kilo', 'movie', 'Kilo 无资源', 3, [{ sourceId: 'src-a', playback: false }]);
}

/** 跨家庭夹具:他家庭内一条完整可用链,用于断言统一 404 不泄露存在性 */
function seedForeignHousehold(): void {
  const conn = Database.db;
  const now = NOW_ISO;
  conn
    .prepare("INSERT INTO household (id, name, default_language, timezone, created_at) VALUES ('hh-foreign', '邻居家', 'zh-CN', 'Asia/Shanghai', ?)")
    .run(now);
  conn
    .prepare("INSERT INTO media_source (id, household_id, kind, name, remote_url, root_key, relative_directory, private_access_approved, epg_source_id, enabled, version, last_success_at, last_job_id, created_at, updated_at) VALUES ('src-foreign', 'hh-foreign', 'iptv', '他家来源', 'http://foreign-seed.example/list.m3u8', NULL, NULL, 1, NULL, 1, 1, NULL, NULL, ?, ?)")
    .run(now, now);
  conn
    .prepare("INSERT INTO media_item (id, household_id, type, title, description, poster_ref, content_level, title_overridden, type_overridden, version, created_at, updated_at) VALUES ('m-foreign', 'hh-foreign', 'movie', 'Foreign 别家片', NULL, NULL, 3, 0, 0, 1, ?, ?)")
    .run(now, now);
  conn
    .prepare("INSERT INTO source_entry (id, household_id, source_id, identity_kind, identity_digest, media_id, upstream_channel_id, present, last_seen_job_id, first_seen_at, last_seen_at, missing_since, file_size_text, file_mtime_ns) VALUES ('entry-foreign', 'hh-foreign', 'src-foreign', 'url', ?, 'm-foreign', NULL, 1, NULL, ?, ?, NULL, NULL, NULL)")
    .run(sha256('src-foreign:m-foreign'), now, now);
  conn
    .prepare("INSERT INTO playback_source (id, household_id, source_id, source_entry_id, media_item_id, protocol, location, mime_type, priority, requires_proxy, created_at, updated_at) VALUES ('pb-foreign', 'hh-foreign', 'src-foreign', 'entry-foreign', 'm-foreign', 'http', 'http://secret-foreign.example/stream.m3u8', NULL, 100, 0, ?, ?)")
    .run(now, now);
}

async function selectCurrentProfile(
  f: CatalogFixture,
  profileId: string,
  ownerPassword?: string,
): Promise<request.Response> {
  return request(f.app.getHttpServer())
    .post(`/api/profiles/${profileId}/select`)
    .set('Cookie', f.cookie)
    .send(ownerPassword === undefined ? {} : { ownerPassword });
}

async function setupCatalog(): Promise<CatalogFixture> {
  const { app } = await startFreshApp({ prefix: 'hmp-catalog-' });
  expect((await initialize(app)).status).toBe(201);
  const loggedIn = await login(app, INITIALIZE_BODY.username, INITIALIZE_BODY.password);
  expect(loggedIn.status).toBe(200);
  const cookie = cookiePairOf(loggedIn);
  const household = await request(app.getHttpServer()).get('/api/household').set('Cookie', cookie);
  const householdId = (household.body as { id: string }).id;

  const adult = await request(app.getHttpServer())
    .post('/api/profiles')
    .set('Cookie', cookie)
    .send({ name: '成人', type: 'adult', ownerPassword: OWNER_PASSWORD });
  const child = await request(app.getHttpServer())
    .post('/api/profiles')
    .set('Cookie', cookie)
    .send({ name: '儿童', type: 'child', ownerPassword: OWNER_PASSWORD });
  expect(adult.status).toBe(201);
  expect(child.status).toBe(201);
  const adultProfileId = (adult.body as { id: string }).id;
  const childProfileId = (child.body as { id: string }).id;

  // 儿童策略:等级 6 + 未评级拒绝(经 API 保存);三名单直写(照 policy-api.e2e-spec 惯例):
  // allowed∩blocked 同 id 交集 → 黑名单必须优先;频道白名单仅 m-zeta。
  const saved = await request(app.getHttpServer())
    .put(`/api/profiles/${childProfileId}/policy`)
    .set('Cookie', cookie)
    .send({ ownerPassword: OWNER_PASSWORD, expectedVersion: 1, policy: { maxContentLevel: 6, allowUnrated: false } });
  expect(saved.status).toBe(200);
  Database.db
    .prepare('UPDATE profile_policy SET allowed_media_ids = ?, blocked_media_ids = ?, allowed_channel_ids = ? WHERE profile_id = ?')
    .run(
      JSON.stringify(['m-echo']),
      JSON.stringify(['m-echo']),
      JSON.stringify(['m-zeta']),
      childProfileId,
    );

  seedForeignHousehold();
  seedCatalogMedia(householdId);
  return { app, cookie, householdId, adultProfileId, childProfileId };
}

function listMedia(f: CatalogFixture, query = ''): request.Test {
  return request(f.app.getHttpServer()).get(`/api/media${query}`).set('Cookie', f.cookie);
}

function mediaDetail(f: CatalogFixture, mediaId: string): request.Test {
  return request(f.app.getHttpServer()).get(`/api/media/${mediaId}`).set('Cookie', f.cookie);
}

/** 成人可见 = 全部家庭可用媒体(成人对等级/未评级/频道白名单均无门槛) */
const ADULT_VISIBLE_TITLES = [
  'Alpha 惊悚18',
  'Charlie 悬疑12',
  'Echo 名单交集',
  'Faith 100%_off',
  'Golf 下划线_片',
  'India 双源',
  'Lima 100X 特',
  'Mike 反斜杠\\片', // JS 源码字面:单反斜杠
  'Zebra 斑马',
  'Zeta 少儿台',
  'apple 苹果',
  'bravo 动画',
  'delta 未评级',
  'yankee 成人台',
];

/** 儿童可见 = 等级≤6 且已评级、非黑名单、频道须在白名单(m-zeta) */
const CHILD_VISIBLE_TITLES = [
  'Faith 100%_off',
  'Golf 下划线_片',
  'India 双源',
  'Lima 100X 特',
  'Mike 反斜杠\\片',
  'Zebra 斑马',
  'Zeta 少儿台',
  'apple 苹果',
  'bravo 动画',
];

describe('T032 观看目录契约(GET /media 与 GET /media/{mediaId})', () => {
  afterEach(cleanupRigs);

  it('成人档案:可用全集、MediaDto/MediaPage 形状、poster=null、title BINARY 排序、分页 total 恒定、无敏感字段泄漏', async () => {
    const f = await setupCatalog();
    expect((await selectCurrentProfile(f, f.adultProfileId, OWNER_PASSWORD)).status).toBe(200);

    const res = await listMedia(f);
    expect(res.status).toBe(200);
    const page: MediaPageDto = res.body;
    expect(page.total).toBe(ADULT_VISIBLE_TITLES.length);
    expect(page.page).toBe(1);
    expect(page.pageSize).toBe(20);
    expect(page.items.map((item) => item.title)).toStrictEqual(ADULT_VISIBLE_TITLES);
    for (const item of page.items) {
      expect(Object.keys(item).sort()).toStrictEqual([
        'contentLevel',
        'description',
        'id',
        'poster',
        'title',
        'type',
        'version',
      ]);
      expect(item.poster).toBeNull();
    }
    const alpha = page.items.find((item) => item.id === 'm-alpha');
    expect(alpha).toMatchObject({ type: 'movie', contentLevel: 18, description: '成人惊悚描述', version: 1 });

    // 响应序列化不含播放地址/路径/凭据/upstream tvg-id/PlaybackSource 字样
    const serialized = JSON.stringify(page).toLowerCase();
    for (const fragment of FORBIDDEN_LEAK_FRAGMENTS) {
      expect(serialized).not.toContain(fragment);
    }

    // 分页:total 恒为过滤后总数,越界页空列表(BINARY 排序下第 2 页切在 India 起)
    const page2 = await listMedia(f, '?page=2&pageSize=5');
    expect(page2.status).toBe(200);
    expect(page2.body.total).toBe(ADULT_VISIBLE_TITLES.length);
    expect(page2.body.items.map((item: { title: string }) => item.title)).toStrictEqual([
      'India 双源',
      'Lima 100X 特',
      'Mike 反斜杠\\片',
      'Zebra 斑马',
      'Zeta 少儿台',
    ]);
    const beyond = await listMedia(f, '?page=99&pageSize=5');
    expect(beyond.status).toBe(200);
    expect(beyond.body.items).toStrictEqual([]);
    expect(beyond.body.total).toBe(ADULT_VISIBLE_TITLES.length);

    // 详情:同一 allowed 判定,形状与列表项一致
    const detail = await mediaDetail(f, 'm-alpha');
    expect(detail.status).toBe(200);
    expect(Object.keys(detail.body).sort()).toStrictEqual([
      'contentLevel',
      'description',
      'id',
      'poster',
      'title',
      'type',
      'version',
    ]);
    expect(detail.body).toMatchObject({
      id: 'm-alpha',
      type: 'movie',
      title: 'Alpha 惊悚18',
      description: '成人惊悚描述',
      contentLevel: 18,
      poster: null,
      version: 1,
    });
    const detailSerialized = JSON.stringify(detail.body).toLowerCase();
    for (const fragment of FORBIDDEN_LEAK_FRAGMENTS) {
      expect(detailSerialized).not.toContain(fragment);
    }

    // 成人频道无白名单门槛:type 筛选只影响结果不参与授权
    const channels = await listMedia(f, '?type=channel');
    expect(channels.status).toBe(200);
    expect(channels.body.total).toBe(2);
    expect(channels.body.items.map((item: { title: string }) => item.title)).toStrictEqual(['Zeta 少儿台', 'yankee 成人台']);
  });

  it('儿童档案:超限/未评级/黑名单优先/白名单外频道不可见;计数不泄漏被禁;被禁/不存在/跨家庭 404 同形', async () => {
    const f = await setupCatalog();
    expect((await selectCurrentProfile(f, f.childProfileId)).status).toBe(200);

    const res = await listMedia(f);
    expect(res.status).toBe(200);
    expect(res.body.total).toBe(CHILD_VISIBLE_TITLES.length);
    expect(res.body.items.map((item: { title: string }) => item.title)).toStrictEqual(CHILD_VISIBLE_TITLES);

    // 计数泄漏:被禁内容不出现在 items 或 total(total=9,而非家庭可用总数 14)
    const serialized = JSON.stringify(res.body);
    for (const banned of ['Alpha', 'Charlie', 'Echo', 'delta 未评级', 'yankee', 'Hotel', 'Juliet', 'Kilo']) {
      expect(serialized).not.toContain(banned);
    }

    // 直接访问:被禁(m-echo) / 超限(m-charlie) / 未评级(m-delta) / 不存在 / 跨家庭 → 统一同形 404
    const blocked = await mediaDetail(f, 'm-echo');
    const overLevel = await mediaDetail(f, 'm-charlie');
    const unrated = await mediaDetail(f, 'm-delta');
    const missing = await mediaDetail(f, MISSING_MEDIA_ID);
    const foreign = await mediaDetail(f, 'm-foreign');
    for (const problem of [blocked, overLevel, unrated, missing, foreign]) {
      expect(problem.status).toBe(404);
      expectProblemContentType(problem);
      expect(problem.body.code).toBe(ProblemCode.NOT_FOUND);
      expect(problem.body.status).toBe(404);
    }
    expect(blocked.body).toStrictEqual(missing.body);
    expect(blocked.body).toStrictEqual(foreign.body);
    expect(blocked.body).toStrictEqual(overLevel.body);
    expect(blocked.body).toStrictEqual(unrated.body);

    // 允许内容详情正常(儿童可见频道在白名单内)
    const allowed = await mediaDetail(f, 'm-zeta');
    expect(allowed.status).toBe(200);
    expect(allowed.body).toMatchObject({ id: 'm-zeta', type: 'channel', poster: null });
  });

  it('搜索与筛选:q 大小写不敏感字面包含(SQL 通配符 %/_/\\ 按字面)、trim、type 枚举;参数只影响筛选不参与授权', async () => {
    const f = await setupCatalog();
    expect((await selectCurrentProfile(f, f.childProfileId)).status).toBe(200);

    const titlesOf = (res: request.Response): string[] =>
      (res.body.items as Array<{ title: string }>).map((item) => item.title);

    // '%' 按字面:仅命中含 "100%" 的标题;若把 % 当 LIKE 通配,'Lima 100X 特' 也会命中
    const percent = await listMedia(f).query({ q: '100%' });
    expect(percent.status).toBe(200);
    expect(percent.body.total).toBe(1);
    expect(titlesOf(percent)).toStrictEqual(['Faith 100%_off']);

    // '_' 按字面:仅两条含下划线标题;若当单字符通配会命中几乎全部
    const underscore = await listMedia(f).query({ q: '_' });
    expect(underscore.body.total).toBe(2);
    expect(titlesOf(underscore)).toStrictEqual(['Faith 100%_off', 'Golf 下划线_片']);

    // '\' 按字面
    const backslash = await listMedia(f).query({ q: '\\' });
    expect(backslash.body.total).toBe(1);
    expect(titlesOf(backslash)).toStrictEqual(['Mike 反斜杠\\片']);

    // 大小写不敏感 + trim
    const cased = await listMedia(f).query({ q: '  BRAVO  ' });
    expect(cased.body.total).toBe(1);
    expect(titlesOf(cased)).toStrictEqual(['bravo 动画']);

    // 搜索不参与授权:儿童搜被禁/超限/未评级标题 → 200 空列表(而非命中)
    const forbiddenQuery = await listMedia(f).query({ q: 'Alpha' });
    expect(forbiddenQuery.status).toBe(200);
    expect(forbiddenQuery.body.total).toBe(0);
    expect(forbiddenQuery.body.items).toStrictEqual([]);

    // type 枚举筛选:儿童可见频道仅白名单内的 m-zeta
    const channels = await listMedia(f).query({ type: 'channel' });
    expect(channels.status).toBe(200);
    expect(channels.body.total).toBe(1);
    expect(titlesOf(channels)).toStrictEqual(['Zeta 少儿台']);
    const movies = await listMedia(f).query({ type: 'movie' });
    expect(movies.body.total).toBe(8);

    // 组合 q + type + 无记录 200 空列表
    const combined = await listMedia(f).query({ q: '斑马', type: 'movie' });
    expect(combined.body.total).toBe(1);
    expect(titlesOf(combined)).toStrictEqual(['Zebra 斑马']);
    const none = await listMedia(f).query({ q: '绝不存在的标题xyz' });
    expect(none.status).toBe(200);
    expect(none.body).toStrictEqual({ items: [], total: 0, page: 1, pageSize: 20 });
  });

  it('可用性:来源禁用/条目缺失/无播放资源均不可见;同媒体另一启用来源即恢复可见;不可用详情同形 404', async () => {
    const f = await setupCatalog();
    expect((await selectCurrentProfile(f, f.adultProfileId, OWNER_PASSWORD)).status).toBe(200);

    const res = await listMedia(f);
    const serialized = JSON.stringify(res.body);
    for (const unavailable of ['Hotel 失效源', 'Juliet 缺条目', 'Kilo 无资源']) {
      expect(serialized).not.toContain(unavailable);
    }

    // 详情:三种不可用原因统一与不存在同形 404(不泄漏不可用原因)
    const disabled = await mediaDetail(f, 'm-hotel');
    const absent = await mediaDetail(f, 'm-juliet');
    const noPlayback = await mediaDetail(f, 'm-kilo');
    const missing = await mediaDetail(f, MISSING_MEDIA_ID);
    for (const problem of [disabled, absent, noPlayback]) {
      expect(problem.status).toBe(404);
      expect(problem.body.code).toBe(ProblemCode.NOT_FOUND);
      expect(problem.body).toStrictEqual(missing.body);
    }

    // 来源独立性:m-india 在停用来源上有条目,但启用来源 src-a 有效 → 仍可见/可看详情
    const dual = await mediaDetail(f, 'm-india');
    expect(dual.status).toBe(200);
    expect(dual.body).toMatchObject({ id: 'm-india', title: 'India 双源', contentLevel: 6 });
  });

  it('错误语义:无会话 401;无 activeProfile 403 ACTIVE_PROFILE_REQUIRED;伪造授权字段与非法参数 400', async () => {
    const f = await setupCatalog();

    // 无会话:列表与详情一律 401 SESSION_INVALID(problem+json)
    const anonList = await request(f.app.getHttpServer()).get('/api/media');
    expect(anonList.status).toBe(401);
    expectProblemContentType(anonList);
    expect(anonList.body.code).toBe(ProblemCode.SESSION_INVALID);
    const anonDetail = await request(f.app.getHttpServer()).get(`/api/media/${MISSING_MEDIA_ID}`);
    expect(anonDetail.status).toBe(401);
    expect(anonDetail.body.code).toBe(ProblemCode.SESSION_INVALID);

    // 新登录会话未选择档案:403 ACTIVE_PROFILE_REQUIRED(不回落默认/成人策略)
    const freshLogin = await login(f.app, INITIALIZE_BODY.username, INITIALIZE_BODY.password);
    expect(freshLogin.status).toBe(200);
    const freshCookie = cookiePairOf(freshLogin);
    const noProfileList = await request(f.app.getHttpServer()).get('/api/media').set('Cookie', freshCookie);
    expect(noProfileList.status).toBe(403);
    expectProblemContentType(noProfileList);
    expect(noProfileList.body.code).toBe(ProblemCode.ACTIVE_PROFILE_REQUIRED);
    const noProfileDetail = await request(f.app.getHttpServer())
      .get('/api/media/m-bravo')
      .set('Cookie', freshCookie);
    expect(noProfileDetail.status).toBe(403);
    expect(noProfileDetail.body.code).toBe(ProblemCode.ACTIVE_PROFILE_REQUIRED);

    // 伪造客户端授权事实(householdId/profileId/role/facts)→ 400,不进入授权
    const forged = await listMedia(f, '?householdId=other-household&profileId=x&role=owner&facts=1');
    expect(forged.status).toBe(400);
    expectProblemContentType(forged);
    expect(forged.body.code).toBe(ProblemCode.VALIDATION_FAILED);

    // 参数校验:pageSize 上限 100/下限 1、page ≥1、q ≤100、type 枚举、数值形态
    for (const badQuery of [
      { pageSize: 101 },
      { pageSize: 0 },
      { page: 0 },
      { page: 'abc' },
      { q: 'x'.repeat(101) },
      { type: 'banana' },
      { page: 1, pageSize: 2.5 },
    ]) {
      const bad = await listMedia(f).query(badQuery);
      expect(bad.status).toBe(400);
      expect(bad.body.code).toBe(ProblemCode.VALIDATION_FAILED);
    }
  });

  it('策略缺失/损坏 → 503 POLICY_UNAVAILABLE,列表与详情一致,绝不伪装空列表', async () => {
    const f = await setupCatalog();
    expect((await selectCurrentProfile(f, f.childProfileId)).status).toBe(200);
    const conn = Database.db;

    // 名单 JSON 损坏(CHECK 约束对合法写入生效,测试经 ignore_check_constraints 注入损坏行)
    conn.exec('PRAGMA ignore_check_constraints = 1');
    conn.prepare("UPDATE profile_policy SET allowed_media_ids = '{broken-json' WHERE profile_id = ?").run(f.childProfileId);
    conn.exec('PRAGMA ignore_check_constraints = 0');

    const corruptList = await listMedia(f);
    expect(corruptList.status).toBe(503);
    expectProblemContentType(corruptList);
    expect(corruptList.body.code).toBe(ProblemCode.POLICY_UNAVAILABLE);
    const corruptDetail = await mediaDetail(f, 'm-bravo');
    expect(corruptDetail.status).toBe(503);
    expect(corruptDetail.body.code).toBe(ProblemCode.POLICY_UNAVAILABLE);

    // 策略行缺失:同样 503,不回落默认策略
    conn.prepare('DELETE FROM profile_policy WHERE profile_id = ?').run(f.childProfileId);
    const missingList = await listMedia(f);
    expect(missingList.status).toBe(503);
    expect(missingList.body.code).toBe(ProblemCode.POLICY_UNAVAILABLE);
    const missingDetail = await mediaDetail(f, 'm-bravo');
    expect(missingDetail.status).toBe(503);
    expect(missingDetail.body.code).toBe(ProblemCode.POLICY_UNAVAILABLE);
  });
});
