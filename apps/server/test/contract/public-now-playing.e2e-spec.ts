import 'reflect-metadata';
import { createHash } from 'node:crypto';
import request from 'supertest';
import { afterEach, describe, expect, it } from 'vitest';
import type { INestApplication } from '@nestjs/common';
import type { CurrentNextProjectionDto, NowPlayingPageDto } from '@hmp/shared';
import { ProblemCode } from '@hmp/shared';
import { Database } from '@platform/database/database';
import { cleanupRigs, expectProblemContentType, startFreshApp } from '../helpers';
import { seedInitializedHousehold } from './public-catalog.helpers';

/**
 * T007(016 US1 契约 e2e):GET /api/public/live/channels/now-playing,
 * 对照 016 contracts/api.md §1.1 与 data-model.md §2.3(CurrentNextProjection):
 * - 免认证直达(零 cookie 200 OK,ADR-0010 公共浏览;失效 cookie 仍按匿名同形处理);
 * - 响应形状:{now, programmes} —— programmes 以 mediaId 为键的映射;命中频道含
 *   current{key,title,start,end,progress}+next{key,title,start,end}+matchMode+epgSourceId;
 *   无排期频道 {current:null,next:null,matchMode:'none'} 同样返回键(不缺键,便于前端
 *   按固定键集合渲染);
 * - mediaIds 过滤:映射键集合 = 请求∩可用频道(只返回命中的键,未命中/未知 id 不 404);
 * - now 基准毫秒时间戳生效(走查测试):传节目结束后的时刻 current/next 归 null,
 *   响应 now 回显基准时刻;非法 now 与未知 query 键一律 400 VALIDATION_FAILED;
 * - Cache-Control: no-store(全局安全头,公共响应约定)、无 Set-Cookie。
 *
 * 并行缝说明(016 T014/US2):loadLiveChannelWindows 将为 LiveChannelProjection 新增
 * 可选 matchMode/epgSourceId 字段;本测试对「命中排期」频道只断言 matchMode 取值在契约
 * 枚举内、epgSourceId 为命中的 EPG 源或 null(兜底形态),不钉死具体命中方式 ——
 * US2 落地前后两种服务状态下本文件均须为绿;「无排期频道 = none/null」则在两态下均精确成立。
 *
 * 环境硬约束:测试小体量(2 频道/2 节目),直插目录/指南行(照 epg-programmes.e2e-spec
 * 的 Database.db 直访惯例);家庭经 seedInitializedHousehold 直插(与 setup 契约解耦,
 * 公开端点不需要登录会话)。
 */

const HOUR_MS = 3_600_000;
const EPG_SOURCE_ID = 'epg-main';
const IPTV_SOURCE_ID = 'src-live';
const LIVE_MEDIA_ID = 'np-live';
const BARE_MEDIA_ID = 'np-bare';

/** matchMode 契约枚举(016 data-model §2.3,逐字) */
const MATCH_MODES = ['manual', 'precise', 'cascade', 'alias', 'none'] as const;

interface NowPlayingRig {
  app: INestApplication;
  baseMs: number;
}

/* ------------------------------------------------------------------ */
/* 种子(直插,照 epg-programmes.e2e-spec 模式)                          */
/* ------------------------------------------------------------------ */

const NOW_SEED = new Date(0).toISOString(); // 占位;真实窗口在各用例内取 Date.now()

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function insertSource(
  id: string,
  householdId: string,
  kind: 'iptv' | 'epg',
  options: { enabled?: boolean; epgSourceId?: string | null } = {},
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

function insertEpgChannel(householdId: string, sourceId: string, xmltvChannelId: string): void {
  Database.db.prepare(
    'INSERT INTO epg_channel (household_id, source_id, xmltv_channel_id, display_name, conflicted) VALUES (?, ?, ?, ?, 0)',
  ).run(householdId, sourceId, xmltvChannelId, `频道-${xmltvChannelId}`);
}

function insertProgramme(
  householdId: string,
  sourceId: string,
  xmltvChannelId: string,
  title: string,
  startMs: number,
  endMs: number,
): void {
  Database.db.prepare(
    'INSERT INTO epg_programme (id, household_id, source_id, xmltv_channel_id, title, description, starts_at, ends_at) VALUES (?, ?, ?, ?, ?, NULL, ?, ?)',
  ).run(`pg-${xmltvChannelId}-${startMs}`, householdId, sourceId, xmltvChannelId, title, new Date(startMs).toISOString(), new Date(endMs).toISOString());
}

/** 频道 + 来源条目 + 播放资源(可用性链:present 条目 × 启用来源 × 播放资源) */
function seedChannelWithEntry(
  mediaId: string,
  householdId: string,
  title: string,
  sourceId: string,
  upstreamChannelId: string | null,
): void {
  insertChannelMedia(mediaId, householdId, title);
  const entryId = `entry-${mediaId}`;
  insertEntry(entryId, householdId, sourceId, mediaId, upstreamChannelId);
  insertPlayback(`pb-${entryId}`, householdId, sourceId, entryId, mediaId);
}

/**
 * 基础夹具:一个有 EPG 排期频道 + 一个无排期频道(均可用可播放)。
 * 排期窗口相对 baseMs:晚间新闻 [base-1h, base+30min)、午夜档案 [base+30min, base+2h),
 * 供 default/走查/边界三类时刻断言共用。
 */
async function setupNowPlaying(): Promise<NowPlayingRig> {
  const { app } = await startFreshApp({ prefix: 'hmp-now-playing-' });
  const householdId = await seedInitializedHousehold();
  const baseMs = Date.now();

  insertSource(EPG_SOURCE_ID, householdId, 'epg', { enabled: true });
  insertSource(IPTV_SOURCE_ID, householdId, 'iptv', { enabled: true, epgSourceId: EPG_SOURCE_ID });

  seedChannelWithEntry(LIVE_MEDIA_ID, householdId, '直播频道', IPTV_SOURCE_ID, 'ch-1');
  insertEpgChannel(householdId, EPG_SOURCE_ID, 'ch-1');
  insertProgramme(householdId, EPG_SOURCE_ID, 'ch-1', '晚间新闻', baseMs - HOUR_MS, baseMs + 30 * 60_000);
  insertProgramme(householdId, EPG_SOURCE_ID, 'ch-1', '午夜档案', baseMs + 30 * 60_000, baseMs + 2 * HOUR_MS);

  // 无排期频道:可用(可播放)但无 epg_channel/programme 行 → null 投影 + matchMode none
  seedChannelWithEntry(BARE_MEDIA_ID, householdId, '无排期频道', IPTV_SOURCE_ID, 'ch-bare');
  return { app, baseMs };
}

/* ------------------------------------------------------------------ */
/* 请求辅助                                                            */
/* ------------------------------------------------------------------ */

function getNowPlaying(app: INestApplication, query: Record<string, string> = {}): request.Test {
  return request(app.getHttpServer()).get('/api/public/live/channels/now-playing').query(query);
}

describe('T007 批量当前节目投影契约(GET /public/live/channels/now-playing)', () => {
  afterEach(cleanupRigs);

  it('免认证直达:零 cookie 200 OK(ADR-0010);失效 cookie 同形;no-store;无 Set-Cookie', async () => {
    const { app, baseMs } = await setupNowPlaying();
    const now = String(baseMs);
    const anonymous = await getNowPlaying(app, { now });
    expect(anonymous.status).toBe(200);
    expect(anonymous.headers['cache-control']).toBe('no-store');
    expect(anonymous.headers['set-cookie']).toBeUndefined();
    expect(Object.keys(anonymous.body).sort()).toEqual(['now', 'programmes']);
    expect(Object.keys((anonymous.body as NowPlayingPageDto).programmes).sort()).toEqual([
      BARE_MEDIA_ID,
      LIVE_MEDIA_ID,
    ]);

    // 携带失效 cookie 仍按匿名处理:同形 200(公开投影与身份无关)
    const invalidCookie = await getNowPlaying(app, { now }).set('Cookie', 'hmp_session=forged-invalid-token');
    expect(invalidCookie.status).toBe(200);
    expect(invalidCookie.headers['set-cookie']).toBeUndefined();
    expect(invalidCookie.headers['cache-control']).toBe('no-store');
    expect((invalidCookie.body as NowPlayingPageDto).programmes).toEqual(
      (anonymous.body as NowPlayingPageDto).programmes,
    );
  });

  it('响应形状:programmes 按 mediaId 键控;命中频道 current{key,title,start,end,progress}+next+matchMode;无排期频道 null 投影', async () => {
    const { app, baseMs } = await setupNowPlaying();
    const res = await getNowPlaying(app, { now: String(baseMs) });
    expect(res.status).toBe(200);
    const body = res.body as NowPlayingPageDto;
    expect(body.now).toBe(new Date(baseMs).toISOString());
    expect(Object.keys(body.programmes).sort()).toEqual([BARE_MEDIA_ID, LIVE_MEDIA_ID]);

    // 命中排期频道:current 契约字段逐字(progress = 1h/1.5h = 0.67;两位小数)
    const live = body.programmes[LIVE_MEDIA_ID] as CurrentNextProjectionDto;
    expect(Object.keys(live).sort()).toEqual(['current', 'epgSourceId', 'matchMode', 'next']);
    expect(live.current).toEqual({
      key: expect.stringMatching(/^pg-[0-9a-f]{24}$/),
      title: '晚间新闻',
      start: new Date(baseMs - HOUR_MS).toISOString(),
      end: new Date(baseMs + 30 * 60_000).toISOString(),
      progress: 0.67,
    });
    // next 无 progress 键(契约字段面逐字)
    expect(live.next).toEqual({
      key: expect.stringMatching(/^pg-[0-9a-f]{24}$/),
      title: '午夜档案',
      start: new Date(baseMs + 30 * 60_000).toISOString(),
      end: new Date(baseMs + 2 * HOUR_MS).toISOString(),
    });
    expect(Object.keys(live.next ?? {}).sort()).toEqual(['end', 'key', 'start', 'title']);
    // 并行缝:US2 落地前兜底 none/null,落地后为真实命中形态;契约层断言枚举内/命中源或 null
    expect(MATCH_MODES).toContain(live.matchMode);
    expect([EPG_SOURCE_ID, null]).toContain(live.epgSourceId);

    // 无排期频道:null 投影同样返回键(不缺键,便于前端按固定键集合渲染)
    expect(body.programmes[BARE_MEDIA_ID]).toEqual({
      current: null,
      next: null,
      epgSourceId: null,
      matchMode: 'none',
    });
  });

  it('mediaIds 过滤:映射键集合=请求∩可用频道(只返回命中的键);去重/空段忽略;未知 id 不 404', async () => {
    const { app, baseMs } = await setupNowPlaying();
    const now = String(baseMs);

    const onlyLive = await getNowPlaying(app, { mediaIds: LIVE_MEDIA_ID, now });
    expect(onlyLive.status).toBe(200);
    expect(Object.keys((onlyLive.body as NowPlayingPageDto).programmes)).toEqual([LIVE_MEDIA_ID]);

    const both = await getNowPlaying(app, { mediaIds: `${BARE_MEDIA_ID},${LIVE_MEDIA_ID}`, now });
    expect(both.status).toBe(200);
    expect(Object.keys((both.body as NowPlayingPageDto).programmes).sort()).toEqual([
      BARE_MEDIA_ID,
      LIVE_MEDIA_ID,
    ]);

    // 去重 + 空段忽略:重复 id 与尾随逗号不产生额外键
    const dedup = await getNowPlaying(app, { mediaIds: `${LIVE_MEDIA_ID}, ${LIVE_MEDIA_ID} ,`, now });
    expect(dedup.status).toBe(200);
    expect(Object.keys((dedup.body as NowPlayingPageDto).programmes)).toEqual([LIVE_MEDIA_ID]);

    // §1.1 交集语义:未知/未命中 id 不 404,也不出现在映射中
    const unknown = await getNowPlaying(app, { mediaIds: `unknown-channel-id,${BARE_MEDIA_ID}`, now });
    expect(unknown.status).toBe(200);
    expect(Object.keys((unknown.body as NowPlayingPageDto).programmes)).toEqual([BARE_MEDIA_ID]);
    expect((unknown.body as NowPlayingPageDto).now).toBe(new Date(baseMs).toISOString());
  });

  it('now 基准时间戳走查:节目结束后 current/next 归 null;档界时刻 current=下一档 progress=0;now 回显基准', async () => {
    const { app, baseMs } = await setupNowPlaying();

    // 走查:传两档节目全部结束后的时刻 → 命中频道同样 {current:null,next:null}
    const afterEndMs = baseMs + 2 * HOUR_MS;
    const afterEnd = await getNowPlaying(app, { now: String(afterEndMs) });
    expect(afterEnd.status).toBe(200);
    const afterEndBody = afterEnd.body as NowPlayingPageDto;
    expect(afterEndBody.now).toBe(new Date(afterEndMs).toISOString());
    const afterEndLive = afterEndBody.programmes[LIVE_MEDIA_ID] as CurrentNextProjectionDto;
    expect(afterEndLive.current).toBeNull();
    expect(afterEndLive.next).toBeNull();
    expect(MATCH_MODES).toContain(afterEndLive.matchMode);
    expect([EPG_SOURCE_ID, null]).toContain(afterEndLive.epgSourceId);

    // 档界走查:startsAt=now 即当前(起点含) → current=午夜档案 且 progress=0;next=null
    const boundaryMs = baseMs + 30 * 60_000;
    const boundary = await getNowPlaying(app, { now: String(boundaryMs) });
    expect(boundary.status).toBe(200);
    const boundaryLive = (boundary.body as NowPlayingPageDto).programmes[LIVE_MEDIA_ID] as CurrentNextProjectionDto;
    expect(boundaryLive.current).toMatchObject({
      title: '午夜档案',
      start: new Date(boundaryMs).toISOString(),
      end: new Date(baseMs + 2 * HOUR_MS).toISOString(),
      progress: 0,
    });
    expect(boundaryLive.next).toBeNull();
    // 无排期频道不随走查时刻变化:恒 null 投影
    expect((boundary.body as NowPlayingPageDto).programmes[BARE_MEDIA_ID]).toEqual({
      current: null,
      next: null,
      epgSourceId: null,
      matchMode: 'none',
    });
  });

  it('负向:非法 now(非数字/非整数/负数/超界)与未知 query 键(伪造身份字段)一律 400 VALIDATION_FAILED', async () => {
    const { app, baseMs } = await setupNowPlaying();
    for (const now of ['abc', '1.5', '-1', '8640000000000001']) {
      const res = await getNowPlaying(app, { now });
      expect(res.status, `now=${now}`).toBe(400);
      expectProblemContentType(res);
      expect(res.body.code, `now=${now}`).toBe(ProblemCode.VALIDATION_FAILED);
      expect(String(res.headers['cache-control']), `now=${now}`).toBe('no-store');
    }

    // 未知键一律 400(伪造 householdId/profileId 不可能扩大公开范围)
    for (const forged of [{ householdId: 'other' }, { profileId: 'p1' }, { foo: 'bar' }] as Record<string, string>[]) {
      const res = await getNowPlaying(app, { now: String(baseMs), ...forged });
      expect(res.status, Object.keys(forged).join()).toBe(400);
      expectProblemContentType(res);
      expect(res.body.code, Object.keys(forged).join()).toBe(ProblemCode.VALIDATION_FAILED);
    }
  });
});
