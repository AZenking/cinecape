import 'reflect-metadata';
import { createHash } from 'node:crypto';
import request from 'supertest';
import { afterEach, describe, expect, it } from 'vitest';
import type { INestApplication } from '@nestjs/common';
import { ProblemCode, type CandidatePageDto, type MediaDto } from '@hmp/shared';
import { Database } from '@platform/database/database';
import {
  INITIALIZE_BODY,
  cleanupRigs,
  cookiePairOf,
  expectProblemContentType,
  initialize,
  login,
  startFreshApp,
} from '../helpers';
import { selectMainAndUnlockSettings } from '../helpers-management';

/**
 * T048(US3 契约 e2e):家长候选查询与人工修正。
 * 对照 contracts/api.md「家长候选与人工修正」节与 openapi.yaml
 * Candidate/CandidatePage/CandidateQuery/PatchMedia/Media schema:
 * - POST /catalog/candidates/query:owner 管线(013/ADR-0017 起免当次密码);
 *   绕过观看策略(儿童策略隐藏的媒体仍在候选)但仍限本 Household;含 unavailable 候选与 available 布尔;
 *   绝不返回文件路径/播放地址/凭据/upstream tvg-id;
 * - PATCH /catalog/media/{mediaId}:expectedVersion 必填;title(1~255)/type/contentLevel(null 恢复未评级、0~18)
 *   至少一项;channel 与非频道互转拒绝(400),非频道四类互转允许;不建立 Series/Episode 关系;
 *   成功 media.version+1 且 catalog_state.revision+1 同事务;title_overridden/type_overridden 按所改字段置 1
 *   (contentLevel 修改不动 overridden);跨家庭/不存在 404 同形;版本冲突 409 MEDIA_VERSION_CONFLICT。
 *
 * 环境硬约束:测试小体量(11 条媒体,≤30),直接 INSERT 目录表(照 catalog-api.e2e-spec 惯例)。
 */

const OWNER_PASSWORD = INITIALIZE_BODY.password;
const MISSING_MEDIA_ID = '00000000-0000-4000-8000-000000000000';
const NOW_ISO = '2026-01-01T00:00:00.000Z';

/** 响应体绝不允许出现的敏感字样(对序列化字符串做反向断言;与观看目录同一清单) */
const FORBIDDEN_LEAK_FRAGMENTS = ['stream_url', 'path', 'tvg', 'location', 'http', 'secret', 'm3u8', 'playback'];

interface CandidatesFixture {
  app: INestApplication;
  cookie: string;
  householdId: string;
  childProfileId: string;
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

interface SeedEntry {
  sourceId: string;
  present?: 0 | 1;
  playback?: boolean;
}

/** 目录种子:两来源 + 10 条家庭媒体(3 条不可用)+ 邻居家 1 条(跨家庭断言) */
function seedCandidates(householdId: string): void {
  const conn = Database.db;
  // 目录修订基线:与 0003 迁移「存量家庭回填 revision=1」同语义(T062 落地后该行已存在,OR IGNORE 幂等)
  conn.prepare('INSERT OR IGNORE INTO catalog_state (household_id, revision) VALUES (?, 1)').run(householdId);

  const insertSource = conn.prepare(
    "INSERT INTO media_source (id, household_id, kind, name, remote_url, root_key, relative_directory, private_access_approved, epg_source_id, enabled, version, last_success_at, last_job_id, created_at, updated_at) VALUES (?, ?, 'iptv', ?, 'http://iptv-seed.example/list.m3u8', NULL, NULL, 1, NULL, ?, 1, NULL, NULL, ?, ?)",
  );
  insertSource.run('src-a', householdId, '启用来源A', 1, NOW_ISO, NOW_ISO);
  insertSource.run('src-off', householdId, '停用来源', 0, NOW_ISO, NOW_ISO);

  const insertMedia = conn.prepare(
    'INSERT INTO media_item (id, household_id, type, title, description, poster_ref, content_level, title_overridden, type_overridden, version, created_at, updated_at) VALUES (?, ?, ?, ?, ?, NULL, ?, 0, 0, 1, ?, ?)',
  );
  const insertEntry = conn.prepare(
    "INSERT INTO source_entry (id, household_id, source_id, identity_kind, identity_digest, media_id, upstream_channel_id, present, last_seen_job_id, first_seen_at, last_seen_at, missing_since, file_size_text, file_mtime_ns) VALUES (?, ?, ?, 'url', ?, ?, 'upstream-tvg-secret-id', ?, NULL, ?, ?, NULL, NULL, NULL)",
  );
  const insertPlayback = conn.prepare(
    "INSERT INTO playback_source (id, household_id, source_id, source_entry_id, media_item_id, protocol, location, mime_type, priority, requires_proxy, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 'http', ?, NULL, 100, 0, ?, ?)",
  );

  const seed = (id: string, type: string, title: string, contentLevel: number | null, entries: SeedEntry[]): void => {
    insertMedia.run(id, householdId, type, title, null, contentLevel, NOW_ISO, NOW_ISO);
    for (const entry of entries) {
      const entryId = `entry-${id}-${entry.sourceId}`;
      insertEntry.run(entryId, householdId, entry.sourceId, sha256(`${entry.sourceId}:${id}`), id, entry.present ?? 1, NOW_ISO, NOW_ISO);
      if (entry.playback ?? true) {
        // location/upstream_channel_id 携带明显敏感字样,用于断言绝不进入响应
        insertPlayback.run(`pb-${id}-${entry.sourceId}`, householdId, entry.sourceId, entryId, id, 'http://secret-upstream.example/stream.m3u8?token=topsecret', NOW_ISO, NOW_ISO);
      }
    }
  };

  const onA: SeedEntry[] = [{ sourceId: 'src-a' }];
  seed('m-alpha', 'movie', 'Alpha 惊悚18', 18, onA); // 儿童超限隐藏
  seed('m-bravo', 'movie', 'bravo 动画', 3, onA); // 人工修正目标
  seed('m-echo', 'movie', 'Echo 黑名单', 3, onA); // 儿童黑名单隐藏
  seed('m-delta', 'video', 'delta 未评级', null, onA); // 儿童未评级拒绝隐藏
  seed('m-zeta', 'channel', 'Zeta 少儿台', 0, onA); // 儿童白名单内
  seed('m-yankee', 'channel', 'yankee 成人台', 0, onA); // 儿童白名单外隐藏
  seed('m-hotel', 'movie', 'Hotel 失效源', 3, [{ sourceId: 'src-off' }]); // 不可用:来源禁用
  seed('m-india', 'movie', 'India 双源', 6, [{ sourceId: 'src-off' }, { sourceId: 'src-a' }]); // 双源仍可用
  seed('m-juliet', 'movie', 'Juliet 缺条目', 3, [{ sourceId: 'src-a', present: 0 }]); // 不可用:条目缺失
  seed('m-kilo', 'movie', 'Kilo 无资源', 3, [{ sourceId: 'src-a', playback: false }]); // 不可用:无播放资源
}

/** 跨家庭夹具:他家庭完整可用链,断言候选不可见、PATCH 404 同形 */
function seedForeignHousehold(): void {
  const conn = Database.db;
  conn
    .prepare("INSERT INTO household (id, name, default_language, timezone, created_at) VALUES ('hh-foreign', '邻居家', 'zh-CN', 'Asia/Shanghai', ?)")
    .run(NOW_ISO);
  conn
    .prepare("INSERT INTO media_source (id, household_id, kind, name, remote_url, root_key, relative_directory, private_access_approved, epg_source_id, enabled, version, last_success_at, last_job_id, created_at, updated_at) VALUES ('src-foreign', 'hh-foreign', 'iptv', '他家来源', 'http://foreign-seed.example/list.m3u8', NULL, NULL, 1, NULL, 1, 1, NULL, NULL, ?, ?)")
    .run(NOW_ISO, NOW_ISO);
  conn
    .prepare("INSERT INTO media_item (id, household_id, type, title, description, poster_ref, content_level, title_overridden, type_overridden, version, created_at, updated_at) VALUES ('m-foreign', 'hh-foreign', 'movie', 'Foreign 别家片', NULL, NULL, 3, 0, 0, 1, ?, ?)")
    .run(NOW_ISO, NOW_ISO);
  conn
    .prepare("INSERT INTO source_entry (id, household_id, source_id, identity_kind, identity_digest, media_id, upstream_channel_id, present, last_seen_job_id, first_seen_at, last_seen_at, missing_since, file_size_text, file_mtime_ns) VALUES ('entry-foreign', 'hh-foreign', 'src-foreign', 'url', ?, 'm-foreign', NULL, 1, NULL, ?, ?, NULL, NULL, NULL)")
    .run(sha256('src-foreign:m-foreign'), NOW_ISO, NOW_ISO);
  conn
    .prepare("INSERT INTO playback_source (id, household_id, source_id, source_entry_id, media_item_id, protocol, location, mime_type, priority, requires_proxy, created_at, updated_at) VALUES ('pb-foreign', 'hh-foreign', 'src-foreign', 'entry-foreign', 'm-foreign', 'http', 'http://secret-foreign.example/stream.m3u8', NULL, 100, 0, ?, ?)")
    .run(NOW_ISO, NOW_ISO);
}

async function setupCandidates(): Promise<CandidatesFixture> {
  const { app } = await startFreshApp({ prefix: 'hmp-candidates-' });
  expect((await initialize(app)).status).toBe(201);
  const loggedIn = await login(app, INITIALIZE_BODY.username, OWNER_PASSWORD);
  expect(loggedIn.status).toBe(200);
  const cookie = cookiePairOf(loggedIn);
  const household = await request(app.getHttpServer()).get('/api/household').set('Cookie', cookie);
  const householdId = (household.body as { id: string }).id;

  // US8 管理迁移:档案创建/策略保存前置 = 主档案选中 + 设置解锁
  await selectMainAndUnlockSettings(app, cookie);
  const child = await request(app.getHttpServer())
    .post('/api/settings/profiles')
    .set('Cookie', cookie)
    .send({ name: '儿童', type: 'child' });
  expect(child.status).toBe(201);
  const childProfileId = (child.body as { id: string }).id;

  // 儿童策略(经既有等级入口保存):等级 6 + 未评级拒绝;名单照夹具惯例直写
  const saved = await request(app.getHttpServer())
    .put(`/api/settings/profiles/${childProfileId}/policy`)
    .set('Cookie', cookie)
    .send({ expectedVersion: 1, policy: { maxContentLevel: 6, allowUnrated: false } });
  expect(saved.status).toBe(200);
  Database.db
    .prepare('UPDATE profile_policy SET blocked_media_ids = ?, allowed_channel_ids = ? WHERE profile_id = ?')
    .run(JSON.stringify(['m-echo']), JSON.stringify(['m-zeta']), childProfileId);

  seedForeignHousehold();
  seedCandidates(householdId);
  return { app, cookie, householdId, childProfileId };
}

function queryCandidates(f: CandidatesFixture, body: Record<string, unknown>): request.Test {
  return request(f.app.getHttpServer()).post('/api/settings/catalog/candidates/query').set('Cookie', f.cookie).send(body);
}

function patchMedia(f: CandidatesFixture, mediaId: string, body: Record<string, unknown>): request.Test {
  return request(f.app.getHttpServer()).patch(`/api/settings/catalog/media/${mediaId}`).set('Cookie', f.cookie).send(body);
}

function revisionOf(householdId: string): number | undefined {
  const row = Database.db.prepare('SELECT revision FROM catalog_state WHERE household_id = ?').get(householdId) as
    | { revision: number }
    | undefined;
  return row?.revision;
}

interface MediaRow {
  type: string;
  title: string;
  content_level: number | null;
  title_overridden: number;
  type_overridden: number;
  version: number;
}

function mediaRowOf(mediaId: string): MediaRow {
  return Database.db.prepare('SELECT type, title, content_level, title_overridden, type_overridden, version FROM media_item WHERE id = ?').get(mediaId) as MediaRow;
}

/** 家庭媒体全集的 title BINARY 序(与目录惯例一致:大写在前) */
const ALL_TITLES_BINARY = [
  'Alpha 惊悚18',
  'Echo 黑名单',
  'Hotel 失效源',
  'India 双源',
  'Juliet 缺条目',
  'Kilo 无资源',
  'Zeta 少儿台',
  'bravo 动画',
  'delta 未评级',
  'yankee 成人台',
];

const UNAVAILABLE_IDS = new Set(['m-hotel', 'm-juliet', 'm-kilo']);


/** 混合可见性期望序:可见标题显示优先,其余按标题 UTF-8 字节序(与目录服务端排序一致) */
function titlesVisibleFirst(visibleTitles: string[]): string[] {
  const rest = ALL_TITLES_BINARY.filter((title) => !visibleTitles.includes(title));
  const byBinary = (a: string, b: string): number =>
    Buffer.compare(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'));
  return [...visibleTitles].sort(byBinary).concat([...rest].sort(byBinary));
}

describe('T048 家长候选与人工修正契约(POST /catalog/candidates/query 与 PATCH /catalog/media/{mediaId})', () => {
  afterEach(cleanupRigs);

  it('owner 候选查询:绕过观看策略(儿童策略隐藏媒体仍在候选)、含 unavailable 与 available 布尔、Candidate 形状、无敏感字段', async () => {
    const f = await setupCandidates();
    // 会话当前观看者切到儿童档案:同一会话观看目录只剩 2 条,候选仍须看到全部(绕过证据)
    const selectChild = await request(f.app.getHttpServer())
      .post(`/api/profiles/${f.childProfileId}/select`)
      .set('Cookie', f.cookie)
      .send({});
    expect(selectChild.status).toBe(200);
    const watched = await request(f.app.getHttpServer()).get('/api/media').set('Cookie', f.cookie);
    expect(watched.status).toBe(200);
    // 儿童可见仅 3 条:India 双源(等级6)、Zeta 少儿台(白名单)、bravo 动画(等级3)
    expect(watched.body.total).toBe(3);
    expect((watched.body.items as Array<{ title: string }>).map((item) => item.title)).toStrictEqual([
      'India 双源',
      'Zeta 少儿台',
      'bravo 动画',
    ]);

    // 005 设置边界:候选查询属 Settings 主体,须切回主档案(重新选档 + 设置解锁)
    await selectMainAndUnlockSettings(f.app, f.cookie);
    const res = await queryCandidates(f, {});
    expect(res.status).toBe(200);
    const page: CandidatePageDto = res.body;
    expect(page.page).toBe(1);
    expect(page.pageSize).toBe(20);
    expect(page.total).toBe(10);
    expect(page.items.map((item) => item.title)).toStrictEqual(ALL_TITLES_BINARY);

    for (const item of page.items) {
      expect(Object.keys(item).sort()).toStrictEqual([
        'available',
        'contentLevel',
        'description',
        'id',
        'lineCount',
        'logoUrl',
        'poster',
        'title',
        'type',
        'version',
        'visible',
      ]);
      expect(item.poster).toBeNull();
      expect(item.available).toBe(!UNAVAILABLE_IDS.has(item.id));
      expect(item.version).toBe(1);
    }
    const itemById = new Map(page.items.map((item) => [item.id, item]));
    expect(itemById.get('m-india')?.lineCount).toBe(2);
    expect(itemById.get('m-kilo')?.lineCount).toBe(0);
    expect(itemById.get('m-alpha')?.lineCount).toBe(1);
    // 儿童策略隐藏的候选全部可见(超限/黑名单/未评级/白名单外频道)
    for (const hiddenTitle of ['Alpha 惊悚18', 'Echo 黑名单', 'delta 未评级', 'yankee 成人台']) {
      expect(page.items.map((item) => item.title)).toContain(hiddenTitle);
    }

    // 序列化绝无播放地址/路径/凭据/upstream tvg-id 字样,也不回显密码
    const serialized = JSON.stringify(page).toLowerCase();
    for (const fragment of FORBIDDEN_LEAK_FRAGMENTS) {
      expect(serialized).not.toContain(fragment);
    }
    expect(serialized).not.toContain(OWNER_PASSWORD.toLowerCase());
  });

  it('候选查询 q/type/分页:大小写不敏感字面包含、type 枚举、total 恒为过滤后、越界页空', async () => {
    const f = await setupCandidates();

    const cased = await queryCandidates(f, { q: '  ALPHA  ' });
    expect(cased.status).toBe(200);
    expect(cased.body.total).toBe(1);
    expect(cased.body.items.map((item: { title: string }) => item.title)).toStrictEqual(['Alpha 惊悚18']);

    const channels = await queryCandidates(f, { type: 'channel' });
    expect(channels.status).toBe(200);
    expect(channels.body.total).toBe(2);
    expect(channels.body.items.map((item: { title: string }) => item.title)).toStrictEqual(['Zeta 少儿台', 'yankee 成人台']);

    const movies = await queryCandidates(f, { type: 'movie' });
    expect(movies.body.total).toBe(7);

    const combined = await queryCandidates(f, { q: '台', type: 'channel' });
    expect(combined.body.total).toBe(2);

    const none = await queryCandidates(f, { q: '绝不存在的标题xyz' });
    expect(none.status).toBe(200);
    expect(none.body).toStrictEqual({
      items: [],
      total: 0,
      counts: { all: 0, visible: 0, hidden: 0 },
      page: 1,
      pageSize: 20,
    });

    const page2 = await queryCandidates(f, { page: 2, pageSize: 4 });
    expect(page2.body.total).toBe(10);
    expect(page2.body.page).toBe(2);
    expect(page2.body.items.map((item: { title: string }) => item.title)).toStrictEqual(ALL_TITLES_BINARY.slice(4, 8));

    const beyond = await queryCandidates(f, { page: 99, pageSize: 4 });
    expect(beyond.body.items).toStrictEqual([]);
    expect(beyond.body.total).toBe(10);
  });

  it('跨家庭媒体不可见:候选列表不含他家庭媒体;PATCH 跨家庭与不存在统一 404 同形', async () => {
    const f = await setupCandidates();

    const res = await queryCandidates(f, {});
    expect(res.status).toBe(200);
    const serialized = JSON.stringify(res.body);
    expect(serialized).not.toContain('m-foreign');
    expect(serialized).not.toContain('Foreign 别家片');

    const foreign = await patchMedia(f, 'm-foreign', { expectedVersion: 1, title: '越权改' });
    const missing = await patchMedia(f, MISSING_MEDIA_ID, { expectedVersion: 1, title: '不存在' });
    for (const problem of [foreign, missing]) {
      expect(problem.status).toBe(404);
      expectProblemContentType(problem);
      expect(problem.body.code).toBe(ProblemCode.NOT_FOUND);
      expect(problem.body.status).toBe(404);
    }
    expect(foreign.body).toStrictEqual(missing.body);
  });

  it('鉴权:admin 允许(005 settings 边界);013 免当次密码(缺密码照常 200;携带 ownerPassword 字段 strictObject 400)', async () => {
    const f = await setupCandidates();

    // 缺失密码:两端点照常成功(013/ADR-0017:候选查询/人工修正属常规运维)
    const noPwdQuery = await queryCandidates(f, {});
    expect(noPwdQuery.status).toBe(200);
    const emptyPwdPatch = await patchMedia(f, 'm-bravo', { expectedVersion: 1, title: 'x' });
    expect(emptyPwdPatch.status).toBe(200);

    // 携带 ownerPassword 字段(契约已移除):strictObject 400,detail 不回显密码;密码经 body 提交,不出现在请求 URL
    const wrongQuery = await queryCandidates(f, { ownerPassword: 'not-the-password' });
    expect(wrongQuery.status).toBe(400);
    expect(wrongQuery.body.code).toBe(ProblemCode.VALIDATION_FAILED);
    expect(String(wrongQuery.body.detail ?? '')).not.toContain('not-the-password');
    const requestUrl = (wrongQuery.request as { url?: string } | undefined)?.url ?? '';
    expect(requestUrl).not.toContain('not-the-password');
    const wrongPatch = await patchMedia(f, 'm-bravo', { ownerPassword: 'not-the-password', expectedVersion: 1, title: 'x' });
    expect(wrongPatch.status).toBe(400);
    expect(wrongPatch.body.code).toBe(ProblemCode.VALIDATION_FAILED);

    // 非 owner:403 FORBIDDEN,且先于格式校验(非法 body 同样 403)
    Database.db.prepare("UPDATE account SET role = 'admin'").run();
    // 005 settings 边界 = owner/admin:admin 允许(非法 type 400)
    const adminBadType = await queryCandidates(f, { type: 'banana' });
    expect(adminBadType.status).toBe(400);
    expect(adminBadType.body.code).toBe(ProblemCode.VALIDATION_FAILED);
    const adminNoPassword = await queryCandidates(f, { type: 'movie' });
    expect(adminNoPassword.status).toBe(200);
    const adminPatchNoFields = await patchMedia(f, 'm-bravo', { expectedVersion: 1 });
    // admin 放行后到达严格校验:无修正字段 → 400
    expect(adminPatchNoFields.status).toBe(400);
    expect(adminPatchNoFields.body.code).toBe(ProblemCode.VALIDATION_FAILED);
  });

  it('候选查询与 PATCH 参数校验 400:q>100、type 枚举、page/pageSize 边界、未知字段严格拒绝', async () => {
    const f = await setupCandidates();
    for (const badBody of [
      { q: 'x'.repeat(101) },
      { type: 'banana' },
      { page: 0 },
      { pageSize: 101 },
      { pageSize: 1.5 },
      { foo: 1 },
    ]) {
      const bad = await queryCandidates(f, badBody);
      expect(bad.status, JSON.stringify(badBody)).toBe(400);
      expectProblemContentType(bad);
      expect(bad.body.code, JSON.stringify(badBody)).toBe(ProblemCode.VALIDATION_FAILED);
    }
    for (const badPatch of [
      { expectedVersion: 1 },
      { expectedVersion: 1, title: '' },
      { expectedVersion: 1, title: 'x'.repeat(256) },
      { expectedVersion: 1, type: 'banana' },
      { expectedVersion: 1, contentLevel: 19 },
      { expectedVersion: 1, contentLevel: -1 },
      { expectedVersion: 0, title: 'x' },
      { title: '缺 expectedVersion' },
      { expectedVersion: 1, unknown: 1 },
    ]) {
      const bad = await patchMedia(f, 'm-bravo', badPatch);
      expect(bad.status, JSON.stringify(badPatch)).toBe(400);
      expect(bad.body.code, JSON.stringify(badPatch)).toBe(ProblemCode.VALIDATION_FAILED);
    }
  });

  it('PATCH 成功各分支:title/type 非频道互转/contentLevel(null 与数值)/组合;version+1、revision+1、overridden 按字段置位', async () => {
    const f = await setupCandidates();
    const baselineRevision = revisionOf(f.householdId) ?? 1;

    // title 分支:title_overridden=1、type_overridden 不动;响应为完整 MediaDto
    const titled = await patchMedia(f, 'm-bravo', { expectedVersion: 1, title: 'bravo 人工标题' });
    expect(titled.status).toBe(200);
    const titledDto: MediaDto = titled.body;
    expect(Object.keys(titledDto).sort()).toStrictEqual([
      'contentLevel',
      'description',
      'id',
      'poster',
      'posterRef',
      'title',
      'type',
      'version',
      'visible',
    ]);
    expect(titledDto).toStrictEqual({
      id: 'm-bravo',
      type: 'movie',
      title: 'bravo 人工标题',
      description: null,
      contentLevel: 3,
      poster: null,
      version: 2,
      visible: true,
      posterRef: null,
    });
    expect(mediaRowOf('m-bravo')).toMatchObject({ title: 'bravo 人工标题', title_overridden: 1, type_overridden: 0, version: 2 });
    expect(revisionOf(f.householdId)).toBe(baselineRevision + 1);

    // type 分支:movie→video 允许(非频道四类互转);type_overridden=1,已有 title_overridden 保留
    const typed = await patchMedia(f, 'm-bravo', { expectedVersion: 2, type: 'video' });
    expect(typed.status).toBe(200);
    expect(typed.body).toMatchObject({ type: 'video', version: 3 });
    expect(mediaRowOf('m-bravo')).toMatchObject({ type: 'video', title_overridden: 1, type_overridden: 1, version: 3 });

    // contentLevel=null 分支:恢复未评级;overridden 标志均不动
    const unrated = await patchMedia(f, 'm-bravo', { expectedVersion: 3, contentLevel: null });
    expect(unrated.status).toBe(200);
    expect(unrated.body).toMatchObject({ contentLevel: null, version: 4 });
    expect(mediaRowOf('m-bravo')).toMatchObject({ content_level: null, title_overridden: 1, type_overridden: 1, version: 4 });

    // 数值 contentLevel 分支:另一媒体 flags 保持 0/0
    const leveled = await patchMedia(f, 'm-alpha', { expectedVersion: 1, contentLevel: 12 });
    expect(leveled.status).toBe(200);
    expect(leveled.body).toMatchObject({ contentLevel: 12, version: 2 });
    expect(mediaRowOf('m-alpha')).toMatchObject({ content_level: 12, title_overridden: 0, type_overridden: 0, version: 2 });

    // 组合分支:title+type+contentLevel 同事务一次生效
    const combined = await patchMedia(f, 'm-alpha', {
      expectedVersion: 2,
      title: 'Alpha 人工',
      type: 'series',
      contentLevel: 0,
    });
    expect(combined.status).toBe(200);
    expect(combined.body).toMatchObject({ title: 'Alpha 人工', type: 'series', contentLevel: 0, version: 3 });
    expect(mediaRowOf('m-alpha')).toMatchObject({ title: 'Alpha 人工', type: 'series', content_level: 0, title_overridden: 1, type_overridden: 1, version: 3 });
    expect(revisionOf(f.householdId)).toBe(baselineRevision + 5);
  });

  it('PATCH 频道互转拒绝:channel→非频道与非频道→channel 均 400,原值与修订不变', async () => {
    const f = await setupCandidates();
    const baselineRevision = revisionOf(f.householdId) ?? 1;

    const channelToMovie = await patchMedia(f, 'm-zeta', { expectedVersion: 1, type: 'movie' });
    expect(channelToMovie.status).toBe(400);
    expect(channelToMovie.body.code).toBe(ProblemCode.VALIDATION_FAILED);

    const movieToChannel = await patchMedia(f, 'm-bravo', { expectedVersion: 1, type: 'channel' });
    expect(movieToChannel.status).toBe(400);
    expect(movieToChannel.body.code).toBe(ProblemCode.VALIDATION_FAILED);

    expect(mediaRowOf('m-zeta')).toMatchObject({ type: 'channel', version: 1 });
    expect(mediaRowOf('m-bravo')).toMatchObject({ type: 'movie', version: 1 });
    expect(revisionOf(f.householdId)).toBe(baselineRevision);
  });

  it('PATCH 版本冲突 409 MEDIA_VERSION_CONFLICT:旧 expectedVersion 拒绝且原值/修订不变', async () => {
    const f = await setupCandidates();
    const baselineRevision = revisionOf(f.householdId) ?? 1;

    const conflict = await patchMedia(f, 'm-bravo', { expectedVersion: 99, title: '迟到请求' });
    expect(conflict.status).toBe(409);
    expectProblemContentType(conflict);
    expect(conflict.body.code).toBe(ProblemCode.MEDIA_VERSION_CONFLICT);
    expect(mediaRowOf('m-bravo')).toMatchObject({ title: 'bravo 动画', version: 1 });
    expect(revisionOf(f.householdId)).toBe(baselineRevision);
  });

  it('人工标题落库标记 title_overridden=1(普通刷新不覆盖的持久依据);description 等未改字段保持', async () => {
    const f = await setupCandidates();
    const renamed = await patchMedia(f, 'm-bravo', { expectedVersion: 1, title: '家长命名' });
    expect(renamed.status).toBe(200);
    const row = Database.db
      .prepare('SELECT title, title_overridden, type_overridden, version FROM media_item WHERE id = ?')
      .get('m-bravo') as { title: string; title_overridden: number; type_overridden: number; version: number };
    expect(row).toStrictEqual({ title: '家长命名', title_overridden: 1, type_overridden: 0, version: 2 });
  });

  it('017 US3 (T022): 候选查询正确返回 lineCount 与 manualEpgBinding 绑定详情', async () => {
    const f = await setupCandidates();
    // 插入 EPG 来源与 EPG 频道
    Database.db
      .prepare(
        "INSERT INTO media_source (id, household_id, kind, name, remote_url, root_key, relative_directory, private_access_approved, epg_source_id, enabled, version, last_success_at, last_job_id, created_at, updated_at) VALUES ('src-epg', ?, 'epg', '测试EPG', 'http://epg.example/xmltv.xml', NULL, NULL, 1, NULL, 1, 1, ?, NULL, ?, ?)",
      )
      .run(f.householdId, NOW_ISO, NOW_ISO, NOW_ISO);
    Database.db
      .prepare(
        "INSERT INTO epg_channel (household_id, source_id, xmltv_channel_id, display_name, conflicted) VALUES (?, 'src-epg', 'CCTV1', 'CCTV-1 综合', 0)",
      )
      .run(f.householdId);
    // 绑定 m-zeta 到 CCTV1
    Database.db
      .prepare(
        "INSERT INTO manual_epg_binding (household_id, media_id, mode, epg_source_id, xmltv_channel_id, version, updated_at) VALUES (?, 'm-zeta', 'manual', 'src-epg', 'CCTV1', 1, ?)",
      )
      .run(f.householdId, NOW_ISO);

    const res = await queryCandidates(f, { type: 'channel' });
    expect(res.status).toBe(200);
    const zeta = res.body.items.find((item: { id: string }) => item.id === 'm-zeta');
    expect(zeta).toBeDefined();
    expect(zeta.lineCount).toBe(1);
    expect(zeta.epgBinding).toStrictEqual({
      mediaId: 'm-zeta',
      mode: 'manual',
      version: 1,
      epgSourceId: 'src-epg',
      xmltvChannelId: 'CCTV1',
      status: 'valid',
      invalidReason: null,
      displayName: 'CCTV-1 综合',
    });

    const yankee = res.body.items.find((item: { id: string }) => item.id === 'm-yankee');
    expect(yankee).toBeDefined();
    expect(yankee.lineCount).toBe(1);
    expect(yankee.epgBinding).toBeUndefined();
  });

  it('018 全量可见性过滤:visibility 切片 + counts(可见性过滤前三档计数)+ 稳定排序分页 + 默认请求兼容', async () => {
    const f = await setupCandidates();
    // 混合可见性基线:仅 Alpha/Zeta 可见(其余 8 条隐藏;家庭全集 10 条)
    Database.db
      .prepare("UPDATE media_item SET visible = CASE WHEN id IN ('m-alpha', 'm-zeta') THEN 1 ELSE 0 END")
      .run();

    // 默认请求兼容:不带 visibility = all(旧客户端语义不变);响应携带 counts
    const legacy = await queryCandidates(f, {});
    expect(legacy.status).toBe(200);
    expect(legacy.body.total).toBe(10);
    expect(legacy.body.counts).toStrictEqual({ all: 10, visible: 2, hidden: 8 });
    // 稳定排序:显示优先 → 标题 UTF-8 字节序 → id(all 切片全集序)
    expect(legacy.body.items.map((item: { title: string }) => item.title)).toStrictEqual(
      titlesVisibleFirst(['Alpha 惊悚18', 'Zeta 少儿台']),
    );

    // visibility=visible:total = 过滤后(2);counts 恒为过滤前三档
    const visibleOnly = await queryCandidates(f, { visibility: 'visible' });
    expect(visibleOnly.status).toBe(200);
    expect(visibleOnly.body.total).toBe(2);
    expect(visibleOnly.body.counts).toStrictEqual({ all: 10, visible: 2, hidden: 8 });
    expect(visibleOnly.body.items.map((item: { title: string }) => item.title)).toStrictEqual([
      'Alpha 惊悚18',
      'Zeta 少儿台',
    ]);

    // visibility=hidden:>1 页分页(8 条 / pageSize 3 → 3 页),页间序稳定
    const hiddenCounts = await queryCandidates(f, { visibility: 'hidden', pageSize: 3 });
    expect(hiddenCounts.status).toBe(200);
    expect(hiddenCounts.body.total).toBe(8);
    expect(hiddenCounts.body.counts).toStrictEqual({ all: 10, visible: 2, hidden: 8 });
    expect(hiddenCounts.body.items.map((item: { title: string }) => item.title)).toStrictEqual([
      'Echo 黑名单',
      'Hotel 失效源',
      'India 双源',
    ]);
    const hiddenPage2 = await queryCandidates(f, { visibility: 'hidden', pageSize: 3, page: 2 });
    expect(hiddenPage2.body.items.map((item: { title: string }) => item.title)).toStrictEqual([
      'Juliet 缺条目',
      'Kilo 无资源',
      'bravo 动画',
    ]);
    const hiddenPage3 = await queryCandidates(f, { visibility: 'hidden', pageSize: 3, page: 3 });
    expect(hiddenPage3.body.items.map((item: { title: string }) => item.title)).toStrictEqual([
      'delta 未评级',
      'yankee 成人台',
    ]);

    // 组合关键词 + 类型过滤:counts 在基础过滤后、可见性过滤前统计
    const combined = await queryCandidates(f, { q: '台', type: 'channel', visibility: 'hidden' });
    expect(combined.status).toBe(200);
    expect(combined.body.counts).toStrictEqual({ all: 2, visible: 1, hidden: 1 });
    expect(combined.body.total).toBe(1);
    expect(combined.body.items.map((item: { title: string }) => item.title)).toStrictEqual(['yankee 成人台']);

    // 家庭隔离:任何切片/计数都不含他家庭媒体
    const serialized = JSON.stringify(combined.body);
    expect(serialized).not.toContain('m-foreign');

    // 非法 visibility 枚举 → 400(严格校验)
    const badVisibility = await queryCandidates(f, { visibility: 'everyone' });
    expect(badVisibility.status).toBe(400);
    expect(badVisibility.body.code).toBe(ProblemCode.VALIDATION_FAILED);
  });

  it('018 绑定显示名:manual 绑定批量带出 EPG 频道名;目标频道行缺失 displayName=null(前端回退「名称不可用」)', async () => {
    const f = await setupCandidates();
    Database.db
      .prepare(
        "INSERT INTO media_source (id, household_id, kind, name, remote_url, root_key, relative_directory, private_access_approved, epg_source_id, enabled, version, last_success_at, last_job_id, created_at, updated_at) VALUES ('src-epg-x', ?, 'epg', '测试EPG', 'http://epg.example/xmltv.xml', NULL, NULL, 1, NULL, 1, 1, ?, NULL, ?, ?)",
      )
      .run(f.householdId, NOW_ISO, NOW_ISO, NOW_ISO);
    // 目标频道存在:zeta 绑定 CCTV1(displayName 批量带出,零逐行请求)
    Database.db
      .prepare(
        "INSERT INTO epg_channel (household_id, source_id, xmltv_channel_id, display_name, conflicted) VALUES (?, 'src-epg-x', 'CCTV1', 'CCTV-1 综合', 0)",
      )
      .run(f.householdId);
    // 目标频道缺失:yankee 绑定 GONE-ID(epg_channel 无行 → displayName null)
    Database.db
      .prepare(
        "INSERT INTO manual_epg_binding (household_id, media_id, mode, epg_source_id, xmltv_channel_id, version, updated_at) VALUES (?, 'm-zeta', 'manual', 'src-epg-x', 'CCTV1', 1, ?), (?, 'm-yankee', 'manual', 'src-epg-x', 'GONE-ID', 1, ?)",
      )
      .run(f.householdId, NOW_ISO, f.householdId, NOW_ISO);

    const res = await queryCandidates(f, { type: 'channel' });
    expect(res.status).toBe(200);
    const zeta = res.body.items.find((item: { id: string }) => item.id === 'm-zeta');
    expect(zeta.epgBinding.displayName).toBe('CCTV-1 综合');
    const yankee = res.body.items.find((item: { id: string }) => item.id === 'm-yankee');
    expect(yankee.epgBinding.displayName).toBeNull();
    // auto/无绑定不携带 displayName 字段(契约可选字段)
    const bravo = res.body.items.find((item: { id: string }) => item.id === 'm-bravo');
    expect(bravo).toBeUndefined(); // 非频道项不在 type=channel 切片
  });
});
