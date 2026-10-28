import 'reflect-metadata';
import { createHash } from 'node:crypto';
import request from 'supertest';
import { afterEach, describe, expect, it } from 'vitest';
import type { INestApplication } from '@nestjs/common';
import { ProblemCode } from '@hmp/shared';
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
 * T040(US4 契约 e2e):GET /media/{mediaId}/programmes,
 * 对照 003 contracts/api.md「观看目录」programmes 端点语义与 openapi.yaml Programme/Programmes schema:
 * - 授权管线与详情一致(复用批量上下文 evaluatePolicy 顺序):非频道 400 VALIDATION_FAILED;
 *   频道被禁(策略)/断源(不可用)/跨家庭/不存在统一 404 同形,不泄漏存在性;
 * - 关联解析(research R6/data-model epg_channel 节):频道 present 条目所属 IPTV 来源(enabled)
 *   → epg_source_id(同家庭存在;来源禁用视为无关联)→ epg_channel 精确匹配 upstream tvg-id
 *   (BINARY 相等,不合并不猜测);多有效来源共享媒体按 source_id 升序取第一个
 *   「有效且精确匹配且 conflicted=0」的关联;
 * - current:startsAt≤now<endsAt(UTC 判定,起点含/终点不含);next:未来 startsAt 最早项;
 *   未关联/EPG 禁用/conflicted/tvg 无匹配/指南全部过期 → 200 {current:null,next:null,
 *   status:'unavailable'};响应 Programme{title,description,startsAt,endsAt},时间为显式 UTC ISO。
 *
 * 环境硬约束:测试小体量 —— 每用例 ≤3 频道/≤4 节目,直接 INSERT 目录/指南表
 * (照 catalog-api.e2e-spec 的 Database.db 直访惯例)。
 */

const OWNER_PASSWORD = INITIALIZE_BODY.password;
const HOUR_MS = 3_600_000;
const MISSING_MEDIA_ID = '00000000-0000-4000-8000-000000000000';

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

interface GuideRig {
  app: INestApplication;
  cookie: string;
  householdId: string;
  adultProfileId: string;
  childProfileId: string;
}

/* ------------------------------------------------------------------ */
/* 种子(直插,照 catalog-api.e2e-spec 模式)                             */
/* ------------------------------------------------------------------ */

const NOW_SEED = new Date(0).toISOString(); // 占位;真实时间在各用例内取 Date.now()

function insertHouseholdRow(id: string, name: string): void {
  Database.db
    .prepare('INSERT INTO household (id, name, default_language, timezone, created_at) VALUES (?, ?, ?, ?, ?)')
    .run(id, name, 'zh-CN', 'Asia/Shanghai', NOW_SEED);
}

function insertSource(
  id: string,
  householdId: string,
  kind: 'iptv' | 'epg',
  options: { enabled?: boolean; epgSourceId?: string | null },
): void {
  Database.db.prepare(
    "INSERT INTO media_source (id, household_id, kind, name, remote_url, root_key, relative_directory, private_access_approved, epg_source_id, enabled, version, last_success_at, last_job_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, NULL, NULL, 1, ?, ?, 1, NULL, NULL, ?, ?)",
  ).run(
    id,
    householdId,
    kind,
    `${kind}来源-${id}`,
    `http://${id}.seed.example/list`,
    options.epgSourceId ?? null,
    options.enabled === false ? 0 : 1,
    NOW_SEED,
    NOW_SEED,
  );
}

function insertChannelMedia(id: string, householdId: string, title: string): void {
  Database.db.prepare(
    'INSERT INTO media_item (id, household_id, type, title, description, poster_ref, content_level, title_overridden, type_overridden, version, created_at, updated_at) VALUES (?, ?, ?, ?, NULL, NULL, 0, 0, 0, 1, ?, ?)',
  ).run(id, householdId, 'channel', title, NOW_SEED, NOW_SEED);
}

function insertMovieMedia(id: string, householdId: string, title: string): void {
  Database.db.prepare(
    'INSERT INTO media_item (id, household_id, type, title, description, poster_ref, content_level, title_overridden, type_overridden, version, created_at, updated_at) VALUES (?, ?, ?, ?, NULL, NULL, 3, 0, 0, 1, ?, ?)',
  ).run(id, householdId, 'movie', title, NOW_SEED, NOW_SEED);
}

function insertEntry(
  id: string,
  householdId: string,
  sourceId: string,
  mediaId: string,
  upstreamChannelId: string | null,
): void {
  Database.db.prepare(
    "INSERT INTO source_entry (id, household_id, source_id, identity_kind, identity_digest, media_id, upstream_channel_id, present, last_seen_job_id, first_seen_at, last_seen_at, missing_since, file_size_text, file_mtime_ns) VALUES (?, ?, ?, 'tvg_id', ?, ?, ?, 1, NULL, ?, ?, NULL, NULL, NULL)",
  ).run(id, householdId, sourceId, sha256(`tvg_id:${mediaId}:${sourceId}`), mediaId, upstreamChannelId, NOW_SEED, NOW_SEED);
}

function insertPlayback(id: string, householdId: string, sourceId: string, entryId: string, mediaId: string): void {
  Database.db.prepare(
    "INSERT INTO playback_source (id, household_id, source_id, source_entry_id, media_item_id, protocol, location, mime_type, priority, requires_proxy, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 'http', ?, NULL, 100, 0, ?, ?)",
  ).run(id, householdId, sourceId, entryId, mediaId, 'http://secret-upstream.example/stream.m3u8', NOW_SEED, NOW_SEED);
}

function insertEpgChannel(
  householdId: string,
  sourceId: string,
  xmltvChannelId: string,
  conflicted: 0 | 1,
): void {
  Database.db.prepare(
    'INSERT INTO epg_channel (household_id, source_id, xmltv_channel_id, display_name, conflicted) VALUES (?, ?, ?, ?, ?)',
  ).run(householdId, sourceId, xmltvChannelId, `频道-${xmltvChannelId}`, conflicted);
}

function insertProgramme(
  householdId: string,
  sourceId: string,
  xmltvChannelId: string,
  title: string,
  description: string | null,
  startMs: number,
  endMs: number,
): void {
  Database.db.prepare(
    'INSERT INTO epg_programme (id, household_id, source_id, xmltv_channel_id, title, description, starts_at, ends_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
  ).run(
    `pg-${xmltvChannelId}-${startMs}`,
    householdId,
    sourceId,
    xmltvChannelId,
    title,
    description,
    new Date(startMs).toISOString(),
    new Date(endMs).toISOString(),
  );
}

/** 频道 + 来源条目 + 播放资源(可用性链);返回条目 id */
function seedChannelWithEntry(
  mediaId: string,
  householdId: string,
  title: string,
  sourceId: string,
  upstreamChannelId: string | null,
): void {
  insertChannelMedia(mediaId, householdId, title);
  const entryId = `entry-${mediaId}-${sourceId}`;
  insertEntry(entryId, householdId, sourceId, mediaId, upstreamChannelId);
  insertPlayback(`pb-${entryId}`, householdId, sourceId, entryId, mediaId);
}

/** 基础种子:两档案 + EPG 来源(启用/禁用)+ IPTV 来源矩阵 + 频道/电影 + epg_channel 行 */
function seedGuideCatalog(householdId: string): void {
  insertSource('epg-main', householdId, 'epg', { enabled: true });
  insertSource('epg-off', householdId, 'epg', { enabled: false });
  insertSource('src-live', householdId, 'iptv', { enabled: true, epgSourceId: 'epg-main' });
  insertSource('src-bare', householdId, 'iptv', { enabled: true, epgSourceId: null });
  insertSource('src-offepg', householdId, 'iptv', { enabled: true, epgSourceId: 'epg-off' });
  insertSource('src-dead', householdId, 'iptv', { enabled: false, epgSourceId: 'epg-main' });

  // 主频道:current/next/边界用例共用(epg-main/ch-1)
  seedChannelWithEntry('m-live', householdId, '直播频道', 'src-live', 'ch-1');
  // 未关联:IPTV 来源无 epg_source_id
  seedChannelWithEntry('m-bare', householdId, '未关联频道', 'src-bare', 'ch-1');
  // EPG 来源禁用(关联保留、指南数据仍在 → 观看时无节目)
  seedChannelWithEntry('m-offepg', householdId, '停用指南频道', 'src-offepg', 'ch-1');
  // 标识冲突:epg_channel conflicted=1
  seedChannelWithEntry('m-conf', householdId, '冲突频道', 'src-live', 'ch-conf');
  // tvg 无匹配:upstream id 无 epg_channel 行
  seedChannelWithEntry('m-nomatch', householdId, '无匹配频道', 'src-live', 'ch-nope');
  // 断源:来源禁用 → 不可用 → 404(与详情同形)
  seedChannelWithEntry('m-dead', householdId, '断源频道', 'src-dead', 'ch-1');
  // 非频道:400
  insertMovieMedia('m-movie', householdId, '电影一部');
  const movieEntryId = 'entry-m-movie';
  insertEntry(movieEntryId, householdId, 'src-live', 'm-movie', null);
  insertPlayback(`pb-${movieEntryId}`, householdId, 'src-live', movieEntryId, 'm-movie');

  // 指南频道行:启用 EPG 上的精确/冲突频道;禁用 EPG 上同名频道(数据存在但仍降级)
  insertEpgChannel(householdId, 'epg-main', 'ch-1', 0);
  insertEpgChannel(householdId, 'epg-main', 'ch-conf', 1);
  insertEpgChannel(householdId, 'epg-off', 'ch-1', 0);

  // 跨家庭:他家频道 + 完整可用链(断言统一 404 不泄漏存在性)
  insertHouseholdRow('hh-foreign', '邻居家');
  insertSource('src-foreign', 'hh-foreign', 'iptv', { enabled: true });
  insertChannelMedia('m-foreign', 'hh-foreign', 'Foreign 别家台');
  const foreignEntryId = 'entry-foreign';
  insertEntry(foreignEntryId, 'hh-foreign', 'src-foreign', 'm-foreign', 'ch-1');
  insertPlayback('pb-foreign', 'hh-foreign', 'src-foreign', foreignEntryId, 'm-foreign');
}

async function selectProfile(rig: GuideRig, profileId: string, withPassword: boolean): Promise<request.Response> {
  return request(rig.app.getHttpServer())
    .post(`/api/profiles/${profileId}/select`)
    .set('Cookie', rig.cookie)
    .send(withPassword ? { ownerPassword: OWNER_PASSWORD } : {});
}

async function setupProgrammes(): Promise<GuideRig> {
  const { app } = await startFreshApp({ prefix: 'hmp-epg-programmes-' });
  expect((await initialize(app)).status).toBe(201);
  const loggedIn = await login(app, INITIALIZE_BODY.username, OWNER_PASSWORD);
  expect(loggedIn.status).toBe(200);
  const cookie = cookiePairOf(loggedIn);
  const household = await request(app.getHttpServer()).get('/api/household').set('Cookie', cookie);
  const householdId = (household.body as { id: string }).id;

  await selectMainAndUnlockSettings(app, cookie);
  const adult = await request(app.getHttpServer())
    .post('/api/settings/profiles')
    .set('Cookie', cookie)
    .send({ name: '成人', type: 'adult', ownerPassword: OWNER_PASSWORD });
  const child = await request(app.getHttpServer())
    .post('/api/settings/profiles')
    .set('Cookie', cookie)
    .send({ name: '儿童', type: 'child', ownerPassword: OWNER_PASSWORD });
  expect(adult.status).toBe(201);
  expect(child.status).toBe(201);
  const adultProfileId = (adult.body as { id: string }).id;
  const childProfileId = (child.body as { id: string }).id;

  // 儿童策略:m-live 频道在白名单内但同时被黑名单禁止(黑名单优先 → 不可见 404)
  Database.db
    .prepare('UPDATE profile_policy SET allowed_channel_ids = ?, blocked_media_ids = ? WHERE profile_id = ?')
    .run(JSON.stringify(['m-live']), JSON.stringify(['m-live']), childProfileId);

  seedGuideCatalog(householdId);
  return { app, cookie, householdId, adultProfileId, childProfileId };
}

/* ------------------------------------------------------------------ */
/* 请求辅助                                                            */
/* ------------------------------------------------------------------ */

function getProgrammes(rig: GuideRig, mediaId: string): request.Test {
  return request(rig.app.getHttpServer()).get(`/api/media/${mediaId}/programmes`).set('Cookie', rig.cookie);
}

interface ProgrammeSeed {
  title: string;
  description: string | null;
  startMs: number;
  endMs: number;
}

function putProgrammes(rig: GuideRig, xmltvChannelId: string, sourceId: string, seeds: ProgrammeSeed[]): void {
  for (const seed of seeds) {
    insertProgramme(rig.householdId, sourceId, xmltvChannelId, seed.title, seed.description, seed.startMs, seed.endMs);
  }
}

const UNAVAILABLE_BODY = { status: 'unavailable', current: null, next: null };

describe('T040 频道节目指南契约(GET /media/{mediaId}/programmes)', () => {
  afterEach(cleanupRigs);

  it('current/next 正常:Programmes/Programme 契约形状;时间为显式 UTC ISO;next 可跨日', async () => {
    const rig = await setupProgrammes();
    expect((await selectProfile(rig, rig.adultProfileId, true)).status).toBe(200);
    const now = Date.now();
    const currentStart = now - HOUR_MS;
    const currentEnd = now + 30 * 60_000;
    // next 跨自然日(>24h 后结束),仍属指南窗口内数据
    const nextStart = currentEnd;
    const nextEnd = now + 26 * HOUR_MS;
    putProgrammes(rig, 'ch-1', 'epg-main', [
      { title: '晚间新闻', description: '时事综述', startMs: currentStart, endMs: currentEnd },
      { title: '午夜档案', description: null, startMs: nextStart, endMs: nextEnd },
    ]);

    const res = await getProgrammes(rig, 'm-live');
    expect(res.status).toBe(200);
    expect(Object.keys(res.body).sort()).toEqual(['current', 'next', 'status']);
    expect(res.body.status).toBe('available');
    expect(res.body.current).toEqual({
      title: '晚间新闻',
      description: '时事综述',
      startsAt: new Date(currentStart).toISOString(),
      endsAt: new Date(currentEnd).toISOString(),
    });
    expect(res.body.next).toEqual({
      title: '午夜档案',
      description: null,
      startsAt: new Date(nextStart).toISOString(),
      endsAt: new Date(nextEnd).toISOString(),
    });
    // 显式 UTC 时区:ISO 8601 Z 后缀(FR-007/FR-020,存储 UTC、契约输出带时区标识)
    for (const programme of [res.body.current, res.body.next]) {
      for (const key of ['startsAt', 'endsAt'] as const) {
        expect(programme[key].endsWith('Z')).toBe(true);
        expect(Number.isNaN(Date.parse(programme[key]))).toBe(false);
      }
    }
    expect(Object.keys(res.body.current).sort()).toEqual(['description', 'endsAt', 'startsAt', 'title']);
  });

  it('窗口边界:startsAt=now 即当前(起点含);endsAt=now 已结束(终点不含);仅剩过期节目 → unavailable', async () => {
    const rig = await setupProgrammes();
    expect((await selectProfile(rig, rig.adultProfileId, true)).status).toBe(200);
    const now = Date.now();
    putProgrammes(rig, 'ch-1', 'epg-main', [
      { title: '将结束节目', description: null, startMs: now - HOUR_MS, endMs: now },
      { title: '刚开播节目', description: null, startMs: now, endMs: now + HOUR_MS },
      { title: '接档节目', description: null, startMs: now + HOUR_MS, endMs: now + 2 * HOUR_MS },
    ]);
    // 关联有效、精确匹配,但指南仅剩过去节目 → R6「过期 EPG」降级 unavailable
    seedChannelWithEntry('m-past', rig.householdId, '过期指南频道', 'src-live', 'ch-past');
    insertEpgChannel(rig.householdId, 'epg-main', 'ch-past', 0);
    putProgrammes(rig, 'ch-past', 'epg-main', [
      { title: '昨日节目', description: null, startMs: now - 3 * HOUR_MS, endMs: now - 2 * HOUR_MS },
    ]);

    const boundary = await getProgrammes(rig, 'm-live');
    expect(boundary.status).toBe(200);
    expect(boundary.body.status).toBe('available');
    expect(boundary.body.current).toMatchObject({ title: '刚开播节目' });
    expect(boundary.body.next).toMatchObject({ title: '接档节目' });

    const expired = await getProgrammes(rig, 'm-past');
    expect(expired.status).toBe(200);
    expect(expired.body).toEqual(UNAVAILABLE_BODY);
  });

  it('降级矩阵:未关联/EPG 来源禁用/标识冲突/tvg 无匹配 → 200 {status:unavailable,current:null,next:null}', async () => {
    const rig = await setupProgrammes();
    expect((await selectProfile(rig, rig.adultProfileId, true)).status).toBe(200);
    const now = Date.now();
    // 禁用 EPG 与冲突频道都有指南数据:降级源于关联语义而非数据缺失
    putProgrammes(rig, 'ch-1', 'epg-off', [
      { title: '禁用源节目', description: null, startMs: now - HOUR_MS, endMs: now + HOUR_MS },
    ]);
    putProgrammes(rig, 'ch-conf', 'epg-main', [
      { title: '冲突源节目', description: null, startMs: now - HOUR_MS, endMs: now + HOUR_MS },
    ]);

    for (const mediaId of ['m-bare', 'm-offepg', 'm-conf', 'm-nomatch']) {
      const res = await getProgrammes(rig, mediaId);
      expect(res.status, mediaId).toBe(200);
      expect(res.body, mediaId).toEqual(UNAVAILABLE_BODY);
    }
  });

  it('授权与定位:非频道 400;断源/跨家庭/不存在/策略被禁统一 404 同形;无档案 403;无会话 401', async () => {
    const rig = await setupProgrammes();
    expect((await selectProfile(rig, rig.adultProfileId, true)).status).toBe(200);

    // 非频道:授权通过后要求 type=channel → 400 VALIDATION_FAILED(problem+json)
    const movie = await getProgrammes(rig, 'm-movie');
    expect(movie.status).toBe(400);
    expectProblemContentType(movie);
    expect(movie.body.code).toBe(ProblemCode.VALIDATION_FAILED);

    // 断源(不可用)/跨家庭/不存在 → 统一 404 同形,不泄漏存在性/归属
    const missing = await getProgrammes(rig, MISSING_MEDIA_ID);
    expect(missing.status).toBe(404);
    expectProblemContentType(missing);
    expect(missing.body.code).toBe(ProblemCode.NOT_FOUND);
    for (const mediaId of ['m-dead', 'm-foreign']) {
      const res = await getProgrammes(rig, mediaId);
      expect(res.status, mediaId).toBe(404);
      expect(res.body, mediaId).toStrictEqual(missing.body);
    }

    // 策略被禁频道(儿童黑名单优先):与详情一致 404 同形
    expect((await selectProfile(rig, rig.childProfileId, false)).status).toBe(200);
    const blocked = await getProgrammes(rig, 'm-live');
    expect(blocked.status).toBe(404);
    expect(blocked.body).toStrictEqual(missing.body);
    expect((await selectProfile(rig, rig.adultProfileId, true)).status).toBe(200);

    // 新会话未选择档案 → 403 ACTIVE_PROFILE_REQUIRED
    const freshLogin = await login(rig.app, INITIALIZE_BODY.username, OWNER_PASSWORD);
    expect(freshLogin.status).toBe(200);
    const noProfile = await request(rig.app.getHttpServer())
      .get('/api/media/m-live/programmes')
      .set('Cookie', cookiePairOf(freshLogin));
    expect(noProfile.status).toBe(403);
    expect(noProfile.body.code).toBe(ProblemCode.ACTIVE_PROFILE_REQUIRED);

    // 无会话 → 401 SESSION_INVALID
    const anonymous = await request(rig.app.getHttpServer()).get('/api/media/m-live/programmes');
    expect(anonymous.status).toBe(401);
    expect(anonymous.body.code).toBe(ProblemCode.SESSION_INVALID);
  });

  it('多 IPTV 来源共享媒体:source_id 升序首个有效精确不冲突者胜出;未关联与冲突来源跳过', async () => {
    const rig = await setupProgrammes();
    expect((await selectProfile(rig, rig.adultProfileId, true)).status).toBe(200);
    const now = Date.now();

    // 同一 EPG 来源被多个 IPTV 来源复用;src-multi-0 未关联、src-multi-1 冲突、src-multi-2 有效
    insertSource('src-multi-0', rig.householdId, 'iptv', { enabled: true, epgSourceId: null });
    insertSource('src-multi-1', rig.householdId, 'iptv', { enabled: true, epgSourceId: 'epg-main' });
    insertSource('src-multi-2', rig.householdId, 'iptv', { enabled: true, epgSourceId: 'epg-main' });
    insertChannelMedia('m-multi', rig.householdId, '多源共享频道');
    for (const [sourceId, upstream] of [
      ['src-multi-0', 'ch-a'],
      ['src-multi-1', 'ch-a'],
      ['src-multi-2', 'ch-b'],
    ] as const) {
      const entryId = `entry-m-multi-${sourceId}`;
      insertEntry(entryId, rig.householdId, sourceId, 'm-multi', upstream);
      insertPlayback(`pb-${entryId}`, rig.householdId, sourceId, entryId, 'm-multi');
    }
    insertEpgChannel(rig.householdId, 'epg-main', 'ch-a', 1);
    insertEpgChannel(rig.householdId, 'epg-main', 'ch-b', 0);
    putProgrammes(rig, 'ch-a', 'epg-main', [
      { title: 'A 台节目', description: null, startMs: now - HOUR_MS, endMs: now + HOUR_MS },
    ]);
    putProgrammes(rig, 'ch-b', 'epg-main', [
      { title: 'B 台节目', description: null, startMs: now - HOUR_MS, endMs: now + HOUR_MS },
    ]);

    // 首个来源未关联跳过,次个 conflicted 跳过 → source_id 升序取到 src-multi-2 的 ch-b
    const viaSecond = await getProgrammes(rig, 'm-multi');
    expect(viaSecond.status).toBe(200);
    expect(viaSecond.body.status).toBe('available');
    expect(viaSecond.body.current).toMatchObject({ title: 'B 台节目' });

    // 冲突解除翻转:src-multi-1 的 ch-a 变为首个有效精确不冲突者 → 胜出
    Database.db
      .prepare("UPDATE epg_channel SET conflicted = 0 WHERE household_id = ? AND source_id = 'epg-main' AND xmltv_channel_id = 'ch-a'")
      .run(rig.householdId);
    Database.db
      .prepare("UPDATE epg_channel SET conflicted = 1 WHERE household_id = ? AND source_id = 'epg-main' AND xmltv_channel_id = 'ch-b'")
      .run(rig.householdId);
    const viaFirst = await getProgrammes(rig, 'm-multi');
    expect(viaFirst.status).toBe(200);
    expect(viaFirst.body.status).toBe('available');
    expect(viaFirst.body.current).toMatchObject({ title: 'A 台节目' });
  });
});
