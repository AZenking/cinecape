import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import request from 'supertest';
import { afterEach, describe, expect, it } from 'vitest';
import type { INestApplication } from '@nestjs/common';
import { ProblemCode, SESSION_COOKIE } from '@hmp/shared';
import {
  cleanupRigs,
  cookiePairOf,
  expectProblemContentType,
  login,
  startFreshApp,
  type TestRig,
} from '../helpers';
import {
  PLAYBACK_FIXTURE_NOW,
  seedPlaybackSession,
  seedPlaybackWorld,
  type PlaybackWorld,
  type SeedPlaybackSessionOptions,
  type SeedPlaybackWorldOptions,
} from '../fixtures/playback';
import { getDb } from '../../src/modules/auth/db';
import { playbackSession, playbackTicket } from '../../src/database/schema';

/**
 * T014(004-playback-resolver · US1,只写测试不实现):播放控制端点契约 e2e。
 *
 * 权威依据(docs/specs/004-playback-resolver,均为唯一接口权威):
 * - contracts/api.md「公共数据类型」「控制端点」「稳定错误」「异步失败与兼容」「时间轴及请求预算」;
 * - data-model.md「## playback_session」「## playback_ticket」(状态机/generation/version 递增/可空性);
 * - tasks.md T014 条目(场景清单)。
 *
 * 覆盖:resolve/GET session/renew/heartbeat/stop/selection/seek 的请求字段、
 * 201/200/204、CAS(expectedVersion/expectedGeneration)、非法轨道/position/未知字段、
 * 终态、续期复用 session 而主动 resolve 建新 session、preparing 空字段/ready 取票、
 * seek 状态转换/暂停意图、renew 与 seek 交错、旧 operationEpoch 的服务端拒绝
 * (浏览器 epoch 响应丢弃逻辑归 T053~T055,不在本文件)、限频 429、授权顺序。
 *
 * RED 约定(TDD 先行):T017+ 服务层与 T031 控制器尚未实现,/api/playback/** 路由
 * 现阶段全部 404 —— 本文件预期大面积 RED;仅 startFreshApp/夹具/登录等既有
 * 设施参与安排,任何断言失败即为本任务 RED 证据。
 *
 * 夹具:共用 test/fixtures/playback/(seedPlaybackWorld/seedPlaybackSession),
 * 每 it 独立 rig(startFreshApp 全量迁移库 + os.tmpdir 临时 DATA_DIR),不触碰用户库;
 * 夹具缺变体时在本文件内以 Drizzle 本地补种(如 subtitle_track_id 预置)。
 *
 * 说明:轨道词表(已探测音轨/字幕的服务器轨道 ID)由 T023 probe/T029 selection
 * 建立权威;本文件以 'sub-1'/'aud-2' 等规范形 ID 表达契约语义,RED 阶段与路由缺失
 * 一同失败,GREEN 阶段由实现方按 probe 事实提供该词表。
 */

/** 控制端点路径(api 全局前缀,与 main.ts/helpers.ts 一致) */
const RESOLVE_URL = '/api/playback/resolve';
const sessionUrl = (id: string): string => `/api/playback/sessions/${id}`;

/** 设备会话 Cookie 对(明文令牌仅存在于夹具句柄) */
function cookieOf(world: PlaybackWorld): string {
  return `${SESSION_COOKIE}=${world.sessionToken}`;
}

/** 稳定错误断言:status + RFC 9457 problem+json + 稳定码 */
function expectStableProblem(res: request.Response, status: number, code: ProblemCode): void {
  expect(res.status).toBe(status);
  expectProblemContentType(res);
  expect(res.body.code).toBe(code);
}

/** 按 id 读会话行(DB 断言用;不存在即抛错) */
function sessionRowOf(id: string): typeof playbackSession.$inferSelect {
  const row = getDb().select().from(playbackSession).where(eq(playbackSession.id, id)).get();
  if (row === undefined) {
    throw new Error(`夹具错误:playback_session ${id} 不存在`);
  }
  return row;
}

/** 某会话的票行列表(DB 票数断言用) */
function ticketRowsOf(sessionId: string): (typeof playbackTicket.$inferSelect)[] {
  return getDb().select().from(playbackTicket).where(eq(playbackTicket.sessionId, sessionId)).all();
}

/** 某家庭的会话行数(「授权拒绝不建 session」断言用) */
function sessionCountOfHousehold(householdId: string): number {
  return getDb().select().from(playbackSession).where(eq(playbackSession.householdId, householdId)).all().length;
}

/* ------------------------------------------------------------------ */
/* 控制端点请求助手(统一 Cookie 认证,与既有契约惯例一致)              */
/* ------------------------------------------------------------------ */

function postResolve(app: INestApplication, cookie: string, body: object): request.Test {
  return request(app.getHttpServer()).post(RESOLVE_URL).set('Cookie', cookie).send(body);
}
function getSession(app: INestApplication, cookie: string, id: string): request.Test {
  return request(app.getHttpServer()).get(sessionUrl(id)).set('Cookie', cookie);
}
function postRenew(app: INestApplication, cookie: string, id: string, body: object): request.Test {
  return request(app.getHttpServer()).post(`${sessionUrl(id)}/renew`).set('Cookie', cookie).send(body);
}
function postHeartbeat(app: INestApplication, cookie: string, id: string, body: object): request.Test {
  return request(app.getHttpServer()).post(`${sessionUrl(id)}/heartbeat`).set('Cookie', cookie).send(body);
}
function postStop(app: INestApplication, cookie: string, id: string): request.Test {
  return request(app.getHttpServer()).post(`${sessionUrl(id)}/stop`).set('Cookie', cookie).send({});
}
function putSelection(app: INestApplication, cookie: string, id: string, body: object): request.Test {
  return request(app.getHttpServer()).put(`${sessionUrl(id)}/selection`).set('Cookie', cookie).send(body);
}
function postSeek(app: INestApplication, cookie: string, id: string, body: object): request.Test {
  return request(app.getHttpServer()).post(`${sessionUrl(id)}/seek`).set('Cookie', cookie).send(body);
}

/* ------------------------------------------------------------------ */
/* 夹具组合助手                                                        */
/* ------------------------------------------------------------------ */

/** seedPlaybackSession 追加入参(不含 state —— 由本文件各助手的位置参数固定) */
type SeedSessionExtra = Omit<SeedPlaybackSessionOptions, 'state'>;

/**
 * NAS 影片(点播 VOD)会话:media/playback_source 取 NAS 代表行,交付 direct。
 * seek/selection 的重建类用例需要点播媒体(直播 seek 另有 400 PLAYBACK_SEEK_UNSUPPORTED),
 * 这些 rig 以 nasEnabled:true 种子,避免「父源停用 → 源事实复核失败」干扰契约本体;
 * ended 用于终态查询/renew 终态拒绝用例(终态保留已确定源,started_at 由夹具落定)。
 */
function seedVodSession(
  world: PlaybackWorld,
  state: 'ready' | 'playing' | 'paused' | 'ended',
  extra: SeedSessionExtra = {},
): ReturnType<typeof seedPlaybackSession> {
  return seedPlaybackSession(world, {
    state,
    mediaId: world.nas.mediaId,
    playbackSourceId: world.nas.playbackSourceId,
    delivery: 'direct',
    ...extra,
  });
}

/** 直播(局域网 IPTV 频道,duration null)会话:hls_proxy 交付 */
function seedLiveSession(
  world: PlaybackWorld,
  state: 'ready' | 'playing' | 'paused' | 'ended',
  extra: SeedSessionExtra = {},
): ReturnType<typeof seedPlaybackSession> {
  return seedPlaybackSession(world, {
    state,
    mediaId: world.iptv.mediaId,
    playbackSourceId: world.iptv.playbackSourceId,
    delivery: 'hls_proxy',
    ...extra,
  });
}

/** seedWorld 句柄:PlaybackWorld + 显式 username(夹具本身不回传 username 字段) */
type SeededWorld = PlaybackWorld & { readonly username: string };

/**
 * 种子世界并显式记录 username(登录类用例需要;夹具默认 'player')。
 * 注意:auth 的 authenticate 按 usernameNormalized 全局唯一查找(不区分家庭),
 * 同一 rig 造多个家庭时必须互用不同 username,否则登录可能命中错家庭的账号。
 */
async function seedWorld(rig: TestRig, options: SeedPlaybackWorldOptions = {}): Promise<SeededWorld> {
  const username = options.username ?? 'player';
  const world = await seedPlaybackWorld(rig, { ...options, username });
  return { ...world, username };
}

/** 同库第二家庭(跨家庭负向用):不同家庭名/用户名的独立世界 */
async function seedOtherHousehold(rig: TestRig, tag: string): Promise<SeededWorld> {
  return seedWorld(rig, { householdName: `${tag}-乙家庭`, username: `player-b-${tag}` });
}

/** 新登录(同账号新设备会话,activeProfile 为空)→ 选择同一档案,模拟「另一台设备」 */
async function loginSecondDevice(app: INestApplication, world: SeededWorld): Promise<string> {
  const fresh = await login(app, world.username, world.password);
  expect(fresh.status).toBe(200);
  const freshCookie = cookiePairOf(fresh);
  const select = await request(app.getHttpServer())
    .post(`/api/profiles/${world.profileId}/select`)
    .set('Cookie', freshCookie)
    .send({});
  expect(select.status).toBe(200);
  return freshCookie;
}

/** 票据 TTL 剩余秒(对 4xx/畸形值抛断言错误) */
function ticketTtlRemainingSeconds(res: request.Response): number {
  const raw = res.body.ticketExpiresAt;
  expect(typeof raw).toBe('string');
  const remainingMs = Date.parse(raw as string) - Date.now();
  expect(Number.isFinite(remainingMs)).toBe(true);
  return remainingMs / 1000;
}

afterEach(cleanupRigs);

/* ------------------------------------------------------------------ */
/* resolve                                                             */
/* ------------------------------------------------------------------ */

describe('POST /api/playback/resolve(主动解析建 preparing session)', () => {
  it('有效会话+已激活档案+可见媒体 → 201 preparing PlaybackDto 全字段契约 + Location 头 + no-store,不泄漏源位置', async () => {
    const rig = await startFreshApp({ prefix: 'hmp-pb-resolve-' });
    const world = await seedWorld(rig, { nasEnabled: true });
    const cookie = cookieOf(world);

    const res = await postResolve(rig.app, cookie, { mediaId: world.iptv.mediaId });

    // 201 仅表示接受(preparing),不等完整 probe
    expect(res.status).toBe(201);
    expectProblemContentType(res);
    const body = res.body as Record<string, unknown>;
    expect(typeof body['id']).toBe('string');
    expect(body['state']).toBe('preparing');
    // data-model:首次接受请求 generation=version=1、position=0
    expect(body['version']).toBe(1);
    expect(body['generation']).toBe(1);
    expect(body['positionSeconds']).toBe(0);
    // preparing:delivery 未定、无票字段、tracks 空(probe 未完成)
    expect(body['delivery']).toBeNull();
    expect(body['playbackUrl']).toBeNull();
    expect(body['ticketExpiresAt']).toBeNull();
    expect(body['desiredPaused']).toBe(false);
    expect(body['durationSeconds']).toBeNull();
    expect(body['tracks']).toEqual({ audio: [], subtitles: [] });
    // Location 指向新建 session 资源(同源路径,含该 id)
    const location = String(res.headers.location);
    expect(location.startsWith('/api/playback/sessions/')).toBe(true);
    expect(location.endsWith(String(body['id']))).toBe(true);
    // api.md 开篇:所有响应 Cache-Control:no-store
    expect(String(res.headers['cache-control'])).toContain('no-store');
    // 契约:解析响应不泄漏源 ID/位置(私有 location 不对下发)
    const serialized = JSON.stringify(body);
    expect(serialized).not.toContain('/nas-media/');
    expect(serialized).not.toContain('iptv.playback-fixture.test');
    expect(serialized).not.toContain(world.iptv.playbackSourceId);
  });

  it('请求体含未知字段 → 400 VALIDATION_FAILED(未知字段拒绝)', async () => {
    const rig = await startFreshApp({ prefix: 'hmp-pb-resolve-' });
    const world = await seedWorld(rig);
    const res = await postResolve(rig.app, cookieOf(world), {
      mediaId: world.iptv.mediaId,
      foge: '未知字段',
    });
    expectStableProblem(res, 400, ProblemCode.VALIDATION_FAILED);
  });

  it('mediaId 缺失/类型非法 → 400 VALIDATION_FAILED', async () => {
    const rig = await startFreshApp({ prefix: 'hmp-pb-resolve-' });
    const world = await seedWorld(rig);
    const cookie = cookieOf(world);
    for (const body of [{}, { mediaId: 123 }, { mediaId: '' }, { mediaId: null }]) {
      const res = await postResolve(rig.app, cookie, body as object);
      expectStableProblem(res, 400, ProblemCode.VALIDATION_FAILED);
    }
  });

  it('不可见/跨家庭/不存在/无启用源媒体 → 统一 404 MEDIA_NOT_FOUND,且授权拒绝不建 session', async () => {
    const rig = await startFreshApp({ prefix: 'hmp-pb-resolve-' });
    // 默认世界:NAS 停用 → nas.mediaId 为「可见但无可启用播放源」的无源代表
    const world = await seedWorld(rig);
    const other = await seedOtherHousehold(rig, world.householdId.slice(0, 8));
    const cookie = cookieOf(world);

    // 不存在 / 不可见(孤立 media_item)/ 跨家庭(乙家庭媒体)/ 无启用源(NAS 停用)同形 404
    for (const mediaId of [randomUUID(), world.invisibleMediaId, other.nas.mediaId, world.nas.mediaId]) {
      const res = await postResolve(rig.app, cookie, { mediaId });
      expectStableProblem(res, 404, ProblemCode.MEDIA_NOT_FOUND);
    }
    // api.md:无法授权不建 session —— 本家庭无任何 session 行落库
    expect(sessionCountOfHousehold(world.householdId)).toBe(0);
  });

  it('有效会话但未选择档案 → 403 ACTIVE_PROFILE_REQUIRED(不回落默认档案)', async () => {
    const rig = await startFreshApp({ prefix: 'hmp-pb-resolve-' });
    const world = await seedWorld(rig);
    // 同账号重新登录:新设备会话 activeProfile 为空
    const fresh = await login(rig.app, world.username, world.password);
    expect(fresh.status).toBe(200);
    const res = await postResolve(rig.app, cookiePairOf(fresh), { mediaId: world.iptv.mediaId });
    expectStableProblem(res, 403, ProblemCode.ACTIVE_PROFILE_REQUIRED);
    expect(sessionCountOfHousehold(world.householdId)).toBe(0);
  });

  it('无效/伪令牌/过期会话 → 401 SESSION_INVALID(token 不能单独授权)', async () => {
    const rig = await startFreshApp({ prefix: 'hmp-pb-resolve-' });
    const world = await seedWorld(rig);
    const expired = await seedWorld(rig, {
      householdName: '过期会话家庭',
      username: 'expired-player',
      sessionExpiresAt: '2026-10-23T07:00:00.000Z', // 早于夹具/当前时刻 → 已过期
    });

    // 无会话
    const anon = await postResolve(rig.app, '', { mediaId: world.iptv.mediaId });
    expectStableProblem(anon, 401, ProblemCode.SESSION_INVALID);
    // 伪令牌
    const forged = await postResolve(rig.app, `${SESSION_COOKIE}=not-a-real-token`, {
      mediaId: world.iptv.mediaId,
    });
    expectStableProblem(forged, 401, ProblemCode.SESSION_INVALID);
    // 过期会话
    const stale = await postResolve(rig.app, cookieOf(expired), { mediaId: world.iptv.mediaId });
    expectStableProblem(stale, 401, ProblemCode.SESSION_INVALID);
    // 授权拒绝不建 session
    expect(sessionCountOfHousehold(expired.householdId)).toBe(0);
  });

  it('重复 resolve 同媒体 → 各建新 session(两个不同 id,均为 preparing/generation=1)', async () => {
    const rig = await startFreshApp({ prefix: 'hmp-pb-resolve-' });
    const world = await seedWorld(rig);
    const cookie = cookieOf(world);

    const first = await postResolve(rig.app, cookie, { mediaId: world.iptv.mediaId });
    const second = await postResolve(rig.app, cookie, { mediaId: world.iptv.mediaId });
    expect(first.status).toBe(201);
    expect(second.status).toBe(201);
    const firstId = String((first.body as Record<string, unknown>)['id']);
    const secondId = String((second.body as Record<string, unknown>)['id']);
    expect(firstId).not.toBe(secondId);
    expect((second.body as Record<string, unknown>)['state']).toBe('preparing');
    expect((second.body as Record<string, unknown>)['generation']).toBe(1);
    // 主动重复请求各建新 session:两行独立落库,均第一代
    expect(sessionCountOfHousehold(world.householdId)).toBe(2);
    expect(sessionRowOf(firstId).generation).toBe(1);
    expect(sessionRowOf(secondId).generation).toBe(1);
  });
});

/* ------------------------------------------------------------------ */
/* GET session                                                         */
/* ------------------------------------------------------------------ */

describe('GET /api/playback/sessions/{id}(原设备+原档案轮询)', () => {
  it('preparing 轮询 → 200 PlaybackDto:无票字段、delivery/tracks 空、不泄漏源', async () => {
    const rig = await startFreshApp({ prefix: 'hmp-pb-get-' });
    const world = await seedWorld(rig);
    const seeded = seedPlaybackSession(world, { state: 'preparing', mediaId: world.iptv.mediaId });

    const res = await getSession(rig.app, cookieOf(world), seeded.sessionId);
    expect(res.status).toBe(200);
    expectProblemContentType(res);
    const body = res.body as Record<string, unknown>;
    expect(body['id']).toBe(seeded.sessionId);
    expect(body['state']).toBe('preparing');
    expect(body['generation']).toBe(1);
    expect(body['version']).toBe(1);
    // GET 不重签也不复现旧票:票字段恒空(nullable 且除 renew 响应外为空)
    expect(body['playbackUrl']).toBeNull();
    expect(body['ticketExpiresAt']).toBeNull();
    expect(body['delivery']).toBeNull();
    expect(body['tracks']).toEqual({ audio: [], subtitles: [] });
    // 不泄漏源 ID/位置
    const serialized = JSON.stringify(body);
    expect(serialized).not.toContain('/nas-media/');
    expect(serialized).not.toContain('iptv.playback-fixture.test');
  });

  it('跨设备/跨家庭/不存在 id → 统一 404 PLAYBACK_NOT_FOUND(不泄漏资源存在性)', async () => {
    const rig = await startFreshApp({ prefix: 'hmp-pb-get-' });
    const world = await seedWorld(rig);
    const seeded = seedPlaybackSession(world, { state: 'ready', mediaId: world.iptv.mediaId });
    const other = await seedOtherHousehold(rig, world.householdId.slice(0, 8));
    // 第二台设备:同账号新登录并选择同一档案(隔离「设备」维度)
    const secondDeviceCookie = await loginSecondDevice(rig.app, world);

    // 跨设备(同家庭同档案,不同 device_session)→ 404
    const crossDevice = await getSession(rig.app, secondDeviceCookie, seeded.sessionId);
    expectStableProblem(crossDevice, 404, ProblemCode.PLAYBACK_NOT_FOUND);
    // 跨家庭(乙家庭的设备/档案)→ 同形 404
    const crossHousehold = await getSession(rig.app, cookieOf(other), seeded.sessionId);
    expectStableProblem(crossHousehold, 404, ProblemCode.PLAYBACK_NOT_FOUND);
    // 不存在 id → 同形 404
    const missing = await getSession(rig.app, cookieOf(world), randomUUID());
    expectStableProblem(missing, 404, ProblemCode.PLAYBACK_NOT_FOUND);
  });

  it('终态查询 → 200 终态(ended_at 落库后 GET 可查,但不签票:票字段恒空)', async () => {
    const rig = await startFreshApp({ prefix: 'hmp-pb-get-' });
    const world = await seedWorld(rig, { nasEnabled: true });
    const seeded = seedVodSession(world, 'ended');

    const res = await getSession(rig.app, cookieOf(world), seeded.sessionId);
    expect(res.status).toBe(200);
    const body = res.body as Record<string, unknown>;
    expect(body['id']).toBe(seeded.sessionId);
    expect(body['state']).toBe('ended');
    expect(body['playbackUrl']).toBeNull();
    expect(body['ticketExpiresAt']).toBeNull();
    // data-model:终态 ended_at 必填,不可复活
    expect(sessionRowOf(seeded.sessionId).endedAt).not.toBeNull();
  });
});

/* ------------------------------------------------------------------ */
/* renew                                                               */
/* ------------------------------------------------------------------ */

describe('POST /api/playback/sessions/{id}/renew(复用 session 仅换票)', () => {
  it('preparing → 409 PLAYBACK_NOT_READY 且不产生票行(准备未完成禁止签票)', async () => {
    const rig = await startFreshApp({ prefix: 'hmp-pb-renew-' });
    const world = await seedWorld(rig);
    const seeded = seedPlaybackSession(world, { state: 'preparing', mediaId: world.iptv.mediaId });

    const res = await postRenew(rig.app, cookieOf(world), seeded.sessionId, { expectedGeneration: 1 });
    expectStableProblem(res, 409, ProblemCode.PLAYBACK_NOT_READY);
    expect(ticketRowsOf(seeded.sessionId)).toHaveLength(0);
  });

  it('ready + expectedGeneration 匹配 → 200 TicketReply:同源 playbackUrl 含 ticket 查询参数、TTL≈默认300s、generation=1', async () => {
    const rig = await startFreshApp({ prefix: 'hmp-pb-renew-' });
    const world = await seedWorld(rig, { nasEnabled: true });
    const seeded = seedVodSession(world, 'ready');

    const res = await postRenew(rig.app, cookieOf(world), seeded.sessionId, { expectedGeneration: 1 });
    expect(res.status).toBe(200);
    expectProblemContentType(res);
    const body = res.body as Record<string, unknown>;
    expect(body['generation']).toBe(1);
    // 同源路径(URL 仅服务端同源路径,无源地址)+ opaque ticket 查询参数
    const url = String(body['playbackUrl']);
    expect(url.startsWith('/')).toBe(true);
    expect(url).not.toContain('://');
    expect(url).toContain('ticket=');
    expect(url).not.toContain('/nas-media/');
    expect(url).not.toContain(seeded.playbackSourceId ?? '§');
    // 默认 TTL 300s(PLAYBACK_TICKET_TTL_SECONDS),签发即返回 → 剩余 270~300s
    const remaining = ticketTtlRemainingSeconds(res);
    expect(remaining).toBeGreaterThan(270);
    expect(remaining).toBeLessThanOrEqual(300);
    // 票落库:该会话恰一条票行,generation=1(存在性断言与值断言分离;toBe 为 Object.is,
    // 原合并写法 `a !== undefined && a.generation` 求值为 number 1 不可能 Object.is true,系笔误)
    const tickets = ticketRowsOf(seeded.sessionId);
    expect(tickets).toHaveLength(1);
    expect(tickets[0] !== undefined).toBe(true);
    expect(tickets[0]?.generation).toBe(1);
  });

  it('PLAYBACK_TICKET_TTL_SECONDS=60 注入 → 票 TTL≈60s(env 预算生效)', async () => {
    const rig = await startFreshApp({
      prefix: 'hmp-pb-renew-ttl-',
      env: { PLAYBACK_TICKET_TTL_SECONDS: '60' },
    });
    const world = await seedWorld(rig, { nasEnabled: true });
    const seeded = seedVodSession(world, 'ready');

    const res = await postRenew(rig.app, cookieOf(world), seeded.sessionId, { expectedGeneration: 1 });
    expect(res.status).toBe(200);
    const remaining = ticketTtlRemainingSeconds(res);
    // 与默认 300s 可区分:剩余落在 30~60s 区间即证 TTL 注入生效
    expect(remaining).toBeGreaterThan(30);
    expect(remaining).toBeLessThanOrEqual(60);
  });

  it('expectedGeneration 过期(seek 后以旧代申请)→ 409 PLAYBACK_GENERATION_STALE 且不产生新票行', async () => {
    const rig = await startFreshApp({ prefix: 'hmp-pb-renew-' });
    const world = await seedWorld(rig, { nasEnabled: true });
    // seek 后形态:generation=2,当前票为第二代;客户端仍持旧 expectedGeneration=1
    const seeded = seedVodSession(world, 'ready', { generation: 2, version: 2, ticket: { generation: 2 } });

    const res = await postRenew(rig.app, cookieOf(world), seeded.sessionId, { expectedGeneration: 1 });
    expectStableProblem(res, 409, ProblemCode.PLAYBACK_GENERATION_STALE);
    // CAS 失败不写票:票数不变(仍为既有 1 条)
    expect(ticketRowsOf(seeded.sessionId)).toHaveLength(1);
    expect(sessionRowOf(seeded.sessionId).generation).toBe(2);
  });

  it('终态 renew → 409 PLAYBACK_ENDED(终态不可签票/不可复活)', async () => {
    const rig = await startFreshApp({ prefix: 'hmp-pb-renew-' });
    const world = await seedWorld(rig, { nasEnabled: true });
    const seeded = seedVodSession(world, 'ended');

    const res = await postRenew(rig.app, cookieOf(world), seeded.sessionId, { expectedGeneration: 1 });
    expectStableProblem(res, 409, ProblemCode.PLAYBACK_ENDED);
    expect(ticketRowsOf(seeded.sessionId)).toHaveLength(0);
  });

  it('续期复用 session:renew 前后 id/generation/version/selection 不变(对照主动 resolve 建新 session)', async () => {
    const rig = await startFreshApp({ prefix: 'hmp-pb-renew-' });
    const world = await seedWorld(rig, { nasEnabled: true });
    const seeded = seedVodSession(world, 'ready');
    const before = sessionRowOf(seeded.sessionId);

    const res = await postRenew(rig.app, cookieOf(world), seeded.sessionId, { expectedGeneration: 1 });
    expect(res.status).toBe(200);

    // renew 不改变 selection/version,不换代,不建新 session
    const after = sessionRowOf(seeded.sessionId);
    expect(after.id).toBe(before.id);
    expect(after.generation).toBe(before.generation);
    expect(after.version).toBe(before.version);
    expect(after.state).toBe(before.state);
    expect(after.positionSeconds).toBe(before.positionSeconds);
    expect(after.audioTrackId).toBe(before.audioTrackId);
    expect(after.subtitleTrackId).toBe(before.subtitleTrackId);
    expect(sessionCountOfHousehold(world.householdId)).toBe(1);
    expect((res.body as Record<string, unknown>)['generation']).toBe(before.generation);
  });
});

/* ------------------------------------------------------------------ */
/* heartbeat                                                           */
/* ------------------------------------------------------------------ */

describe('POST /api/playback/sessions/{id}/heartbeat(15s 遥测)', () => {
  it('playing 心跳 → 204,positionSeconds 与 last_heartbeat_at 落库', async () => {
    const rig = await startFreshApp({ prefix: 'hmp-pb-hb-' });
    const world = await seedWorld(rig, { nasEnabled: true });
    const seeded = seedVodSession(world, 'playing');

    const res = await postHeartbeat(rig.app, cookieOf(world), seeded.sessionId, {
      positionSeconds: 42,
      paused: false,
    });
    expect(res.status).toBe(204);
    expect(res.text).toBe('');
    const row = sessionRowOf(seeded.sessionId);
    expect(row.positionSeconds).toBe(42);
    expect(row.lastHeartbeatAt > PLAYBACK_FIXTURE_NOW).toBe(true);
  });

  it('positionSeconds 负数 → 400(position>=0)', async () => {
    const rig = await startFreshApp({ prefix: 'hmp-pb-hb-' });
    const world = await seedWorld(rig, { nasEnabled: true });
    const seeded = seedVodSession(world, 'playing');

    const res = await postHeartbeat(rig.app, cookieOf(world), seeded.sessionId, {
      positionSeconds: -1,
      paused: false,
    });
    expectStableProblem(res, 400, ProblemCode.VALIDATION_FAILED);
  });

  it('对终态心跳 → 409 PLAYBACK_ENDED,不复活(状态/ended_at 不变)', async () => {
    const rig = await startFreshApp({ prefix: 'hmp-pb-hb-' });
    const world = await seedWorld(rig, { nasEnabled: true });
    const seeded = seedVodSession(world, 'ended');

    const res = await postHeartbeat(rig.app, cookieOf(world), seeded.sessionId, {
      positionSeconds: 10,
      paused: false,
    });
    expectStableProblem(res, 409, ProblemCode.PLAYBACK_ENDED);
    const row = sessionRowOf(seeded.sessionId);
    expect(row.state).toBe('ended');
    expect(row.endedAt).not.toBeNull();
  });

  it('心跳不递增 version/generation(避免播放进度打断 CAS,DB 断言)', async () => {
    const rig = await startFreshApp({ prefix: 'hmp-pb-hb-' });
    const world = await seedWorld(rig, { nasEnabled: true });
    const seeded = seedVodSession(world, 'playing');

    const res = await postHeartbeat(rig.app, cookieOf(world), seeded.sessionId, {
      positionSeconds: 99,
      paused: false,
    });
    expect(res.status).toBe(204);
    const row = sessionRowOf(seeded.sessionId);
    expect(row.version).toBe(1);
    expect(row.generation).toBe(1);
  });

  it('heartbeat paused=true 更新 desired_paused 意图', async () => {
    const rig = await startFreshApp({ prefix: 'hmp-pb-hb-' });
    const world = await seedWorld(rig, { nasEnabled: true });
    const seeded = seedVodSession(world, 'playing');

    const res = await postHeartbeat(rig.app, cookieOf(world), seeded.sessionId, {
      positionSeconds: 5,
      paused: true,
    });
    expect(res.status).toBe(204);
    expect(sessionRowOf(seeded.sessionId).desiredPaused).toBe(1);
    // 仍为 playing(暂停意图 ≠ 状态迁移;无重建输出的暂停不进 preparing)
    expect(sessionRowOf(seeded.sessionId).state).toBe('playing');
  });
});

/* ------------------------------------------------------------------ */
/* stop                                                                */
/* ------------------------------------------------------------------ */

describe('POST /api/playback/sessions/{id}/stop(幂等终止)', () => {
  it('连续两次 stop 均 204(幂等),首次即落终态', async () => {
    const rig = await startFreshApp({ prefix: 'hmp-pb-stop-' });
    const world = await seedWorld(rig, { nasEnabled: true });
    const seeded = seedVodSession(world, 'playing');

    const first = await postStop(rig.app, cookieOf(world), seeded.sessionId);
    expect(first.status).toBe(204);
    const second = await postStop(rig.app, cookieOf(world), seeded.sessionId);
    expect(second.status).toBe(204);
    const row = sessionRowOf(seeded.sessionId);
    expect(row.state).toBe('ended');
    expect(row.endedAt).not.toBeNull();
  });

  it('stop 后 GET → 200 终态 ended,不签票(票字段恒空)', async () => {
    const rig = await startFreshApp({ prefix: 'hmp-pb-stop-' });
    const world = await seedWorld(rig, { nasEnabled: true });
    const seeded = seedVodSession(world, 'ready');

    const stopped = await postStop(rig.app, cookieOf(world), seeded.sessionId);
    expect(stopped.status).toBe(204);
    const res = await getSession(rig.app, cookieOf(world), seeded.sessionId);
    expect(res.status).toBe(200);
    const body = res.body as Record<string, unknown>;
    expect(body['state']).toBe('ended');
    expect(body['playbackUrl']).toBeNull();
    expect(body['ticketExpiresAt']).toBeNull();
  });

  it('跨设备 stop → 404 PLAYBACK_NOT_FOUND 且不改动原会话', async () => {
    const rig = await startFreshApp({ prefix: 'hmp-pb-stop-' });
    const world = await seedWorld(rig, { nasEnabled: true });
    const seeded = seedVodSession(world, 'playing');
    const secondDeviceCookie = await loginSecondDevice(rig.app, world);

    const res = await postStop(rig.app, secondDeviceCookie, seeded.sessionId);
    expectStableProblem(res, 404, ProblemCode.PLAYBACK_NOT_FOUND);
    // 非本设备会话不可终止:状态原样保留
    expect(sessionRowOf(seeded.sessionId).state).toBe('playing');
    expect(sessionRowOf(seeded.sessionId).endedAt).toBeNull();
  });

  it('取消 preparing 也 204(stop 即取消准备,落终态)', async () => {
    const rig = await startFreshApp({ prefix: 'hmp-pb-stop-' });
    const world = await seedWorld(rig);
    const seeded = seedPlaybackSession(world, { state: 'preparing', mediaId: world.iptv.mediaId });

    const res = await postStop(rig.app, cookieOf(world), seeded.sessionId);
    expect(res.status).toBe(204);
    const row = sessionRowOf(seeded.sessionId);
    expect(row.state).toBe('ended');
    expect(row.endedAt).not.toBeNull();
  });
});

/* ------------------------------------------------------------------ */
/* selection                                                           */
/* ------------------------------------------------------------------ */

describe('PUT /api/playback/sessions/{id}/selection(授权后原子换轨)', () => {
  it('纯字幕切换(expectedVersion 匹配)→ 200 现状态、version+1、generation 不变、无 playbackUrl(不重启)', async () => {
    const rig = await startFreshApp({ prefix: 'hmp-pb-sel-' });
    const world = await seedWorld(rig, { nasEnabled: true });
    const seeded = seedVodSession(world, 'ready');

    const res = await putSelection(rig.app, cookieOf(world), seeded.sessionId, {
      expectedVersion: 1,
      positionSeconds: 25,
      subtitleTrackId: 'sub-1',
    });
    expect(res.status).toBe(200);
    const body = res.body as Record<string, unknown>;
    expect(body['state']).toBe('ready');
    expect(body['version']).toBe(2);
    expect(body['generation']).toBe(1);
    // 纯字幕切换不重启视频:无票字段
    expect(body['playbackUrl']).toBeNull();
    expect(body['ticketExpiresAt']).toBeNull();
    const row = sessionRowOf(seeded.sessionId);
    expect(row.version).toBe(2);
    expect(row.generation).toBe(1);
    expect(row.subtitleTrackId).toBe('sub-1');
    expect(row.positionSeconds).toBe(25);
    // 不新增 session,不产生票
    expect(sessionCountOfHousehold(world.householdId)).toBe(1);
    expect(ticketRowsOf(seeded.sessionId)).toHaveLength(0);
  });

  it('音轨切换(重建输出)→ 200 进入 preparing、generation+1 version+1、票字段空、desiredPaused 保留', async () => {
    const rig = await startFreshApp({ prefix: 'hmp-pb-sel-' });
    const world = await seedWorld(rig, { nasEnabled: true });
    // paused 态:desired_paused=1,换轨后须保留(seek/换轨后播放器依此继续暂停)
    const seeded = seedVodSession(world, 'paused', { ticket: { generation: 1 } });

    const res = await putSelection(rig.app, cookieOf(world), seeded.sessionId, {
      expectedVersion: 1,
      positionSeconds: 30,
      audioTrackId: 'aud-2',
    });
    expect(res.status).toBe(200);
    const body = res.body as Record<string, unknown>;
    expect(body['state']).toBe('preparing');
    expect(body['generation']).toBe(2);
    expect(body['version']).toBe(2);
    expect(body['desiredPaused']).toBe(true);
    // 重建输出:preparing 无票(旧票以旧代自然失效)
    expect(body['playbackUrl']).toBeNull();
    expect(body['ticketExpiresAt']).toBeNull();
    const row = sessionRowOf(seeded.sessionId);
    // 行为修正(T033 缺口2):换代提交后 resolver.prepareRebuild 自动重回 ready ——
    // 本用例为 direct 交付(位置无关),markReady 在响应返回前即已完成(fire-and-forget
    // 微任务链先于 HTTP 往返落库),响应体快照仍为 preparing。旧断言 `preparing` 钉住
    // 的是「换代后永远停留 preparing」的接线缺口现状,按行为修正优先原则更新为 `ready`
    // (generation/version/desiredPaused 断言不变,换代语义不受影响)。
    expect(row.state).toBe('ready');
    expect(row.generation).toBe(2);
    expect(row.version).toBe(2);
    expect(row.desiredPaused).toBe(1);
    // 不新增 session
    expect(sessionCountOfHousehold(world.householdId)).toBe(1);
  });

  it('expectedVersion 过期 → 409 PLAYBACK_VERSION_CONFLICT 且不改行', async () => {
    const rig = await startFreshApp({ prefix: 'hmp-pb-sel-' });
    const world = await seedWorld(rig, { nasEnabled: true });
    const seeded = seedVodSession(world, 'ready', { version: 2 });

    const res = await putSelection(rig.app, cookieOf(world), seeded.sessionId, {
      expectedVersion: 1,
      positionSeconds: 10,
      subtitleTrackId: 'sub-1',
    });
    expectStableProblem(res, 409, ProblemCode.PLAYBACK_VERSION_CONFLICT);
    const row = sessionRowOf(seeded.sessionId);
    expect(row.version).toBe(2);
    expect(row.subtitleTrackId).toBeNull();
  });

  it('引用未探测轨道 → 400 PLAYBACK_SELECTION_INVALID(选择只能引用已探测轨道)', async () => {
    const rig = await startFreshApp({ prefix: 'hmp-pb-sel-' });
    const world = await seedWorld(rig, { nasEnabled: true });
    const seeded = seedVodSession(world, 'ready');

    const res = await putSelection(rig.app, cookieOf(world), seeded.sessionId, {
      expectedVersion: 1,
      positionSeconds: 10,
      subtitleTrackId: 'sub-404',
    });
    expectStableProblem(res, 400, ProblemCode.PLAYBACK_SELECTION_INVALID);
    // 拒绝后状态/选择原样
    expect(sessionRowOf(seeded.sessionId).version).toBe(1);
    expect(sessionRowOf(seeded.sessionId).subtitleTrackId).toBeNull();
  });

  it('subtitleTrackId:null 合法(关闭字幕),仅 version+1(本地补种已选字幕)', async () => {
    const rig = await startFreshApp({ prefix: 'hmp-pb-sel-' });
    const world = await seedWorld(rig, { nasEnabled: true });
    const seeded = seedVodSession(world, 'ready');
    // 夹具缺「已选字幕」变体:本地补种 subtitle_track_id(等价先做一次合法字幕切换)
    getDb()
      .update(playbackSession)
      .set({ subtitleTrackId: 'sub-1' })
      .where(and(eq(playbackSession.id, seeded.sessionId), eq(playbackSession.householdId, world.householdId)))
      .run();

    const res = await putSelection(rig.app, cookieOf(world), seeded.sessionId, {
      expectedVersion: 1,
      positionSeconds: 12,
      subtitleTrackId: null,
    });
    expect(res.status).toBe(200);
    const row = sessionRowOf(seeded.sessionId);
    expect(row.subtitleTrackId).toBeNull();
    expect(row.version).toBe(2);
    expect(row.generation).toBe(1);
    expect(row.state).toBe('ready');
  });
});

/* ------------------------------------------------------------------ */
/* seek                                                                */
/* ------------------------------------------------------------------ */

describe('POST /api/playback/sessions/{id}/seek(NAS 定位换代)', () => {
  it('playing→seek → 200 preparing、新 generation+version,旧票立即拒(旧代 renew 409)', async () => {
    const rig = await startFreshApp({ prefix: 'hmp-pb-seek-' });
    const world = await seedWorld(rig, { nasEnabled: true });
    const seeded = seedVodSession(world, 'playing', { ticket: { generation: 1 } });

    const res = await postSeek(rig.app, cookieOf(world), seeded.sessionId, {
      expectedVersion: 1,
      positionSeconds: 90,
    });
    expect(res.status).toBe(200);
    const body = res.body as Record<string, unknown>;
    expect(body['state']).toBe('preparing');
    expect(body['generation']).toBe(2);
    expect(body['version']).toBe(2);
    // preparing 无票
    expect(body['playbackUrl']).toBeNull();
    expect(body['ticketExpiresAt']).toBeNull();
    const row = sessionRowOf(seeded.sessionId);
    expect(row.generation).toBe(2);
    expect(row.version).toBe(2);
    expect(row.positionSeconds).toBe(90);
    // 旧票立即拒:以 seek 前的 expectedGeneration renew → 409
    // (旧 ticket 直接访问媒体流路径的端到端拒绝属 T015/T031 媒体端点验证)
    const stale = await postRenew(rig.app, cookieOf(world), seeded.sessionId, {
      expectedGeneration: 1,
    });
    expectStableProblem(stale, 409, ProblemCode.PLAYBACK_GENERATION_STALE);
  });

  it('position 越界(负数/超过时长)→ 400', async () => {
    const rig = await startFreshApp({ prefix: 'hmp-pb-seek-' });
    const world = await seedWorld(rig, { nasEnabled: true });
    const seeded = seedVodSession(world, 'playing');
    const cookie = cookieOf(world);

    // 负数:position>=0 属请求校验
    const negative = await postSeek(rig.app, cookie, seeded.sessionId, {
      expectedVersion: 1,
      positionSeconds: -1,
    });
    expectStableProblem(negative, 400, ProblemCode.VALIDATION_FAILED);
    // 超过影片时长:不能越 duration(探测时长权威由 T023/T029 建立;此处以远超任何
    // 可信时长的目标值表达契约,拒绝语义由实现方按「越 duration」判定)
    const beyond = await postSeek(rig.app, cookie, seeded.sessionId, {
      expectedVersion: 1,
      positionSeconds: 31_536_000_000, // 1000 年
    });
    expect(beyond.status).toBe(400);
    expectProblemContentType(beyond);
    // 拒绝后未换代(仍 playing/generation=1)
    const row = sessionRowOf(seeded.sessionId);
    expect(row.state).toBe('playing');
    expect(row.generation).toBe(1);
  });

  it('直播(duration null)seek → 400 PLAYBACK_SEEK_UNSUPPORTED,状态/代次不变', async () => {
    const rig = await startFreshApp({ prefix: 'hmp-pb-seek-' });
    const world = await seedWorld(rig);
    const seeded = seedLiveSession(world, 'playing');

    const res = await postSeek(rig.app, cookieOf(world), seeded.sessionId, {
      expectedVersion: 1,
      positionSeconds: 30,
    });
    expectStableProblem(res, 400, ProblemCode.PLAYBACK_SEEK_UNSUPPORTED);
    const row = sessionRowOf(seeded.sessionId);
    expect(row.state).toBe('playing');
    expect(row.generation).toBe(1);
    expect(row.version).toBe(1);
  });

  it('preparing 期间第二次 seek/selection → 409 PLAYBACK_NOT_READY(不迁 preparing 自身)', async () => {
    const rig = await startFreshApp({ prefix: 'hmp-pb-seek-' });
    const world = await seedWorld(rig, { nasEnabled: true });
    const seeded = seedPlaybackSession(world, {
      state: 'preparing',
      mediaId: world.nas.mediaId,
    });
    const cookie = cookieOf(world);

    const seekAgain = await postSeek(rig.app, cookie, seeded.sessionId, {
      expectedVersion: 1,
      positionSeconds: 5,
    });
    expectStableProblem(seekAgain, 409, ProblemCode.PLAYBACK_NOT_READY);
    const selectDuring = await putSelection(rig.app, cookie, seeded.sessionId, {
      expectedVersion: 1,
      positionSeconds: 5,
      subtitleTrackId: 'sub-1',
    });
    expectStableProblem(selectDuring, 409, ProblemCode.PLAYBACK_NOT_READY);
    // 两次都被拒:行原样(preparing/generation=1/version=1)
    const row = sessionRowOf(seeded.sessionId);
    expect(row.state).toBe('preparing');
    expect(row.generation).toBe(1);
    expect(row.version).toBe(1);
  });

  it('renew 与 seek 交错:seek 提交后携旧 expectedGeneration 的 renew → 409 GENERATION_STALE 且无票行', async () => {
    const rig = await startFreshApp({ prefix: 'hmp-pb-seek-' });
    const world = await seedWorld(rig, { nasEnabled: true });
    const seeded = seedVodSession(world, 'ready');
    const cookie = cookieOf(world);

    // seek 先提交(换代 1→2,进 preparing)
    const seek = await postSeek(rig.app, cookie, seeded.sessionId, {
      expectedVersion: 1,
      positionSeconds: 120,
    });
    expect(seek.status).toBe(200);
    // 与 seek 并发往返的 renew(仍持旧代 expectedGeneration=1)→ CAS 拒绝
    const stale = await postRenew(rig.app, cookie, seeded.sessionId, { expectedGeneration: 1 });
    expectStableProblem(stale, 409, ProblemCode.PLAYBACK_GENERATION_STALE);
    // 短事务外无票落库:签发未发生
    expect(ticketRowsOf(seeded.sessionId)).toHaveLength(0);
    expect(sessionRowOf(seeded.sessionId).generation).toBe(2);
  });

  it('旧 operationEpoch(服务端侧):seek 完成后再用 seek 前的 generation renew → 拒,旧票行原样', async () => {
    const rig = await startFreshApp({ prefix: 'hmp-pb-seek-' });
    const world = await seedWorld(rig, { nasEnabled: true });
    // 「seek 完成」形态:换代后重回 ready(generation=2),旧一代票仍在库
    const seeded = seedVodSession(world, 'ready', { generation: 2, version: 2, ticket: { generation: 1 } });
    const ticketsBefore = ticketRowsOf(seeded.sessionId);
    if (ticketsBefore.length !== 1 || ticketsBefore[0] === undefined) {
      throw new Error('夹具错误:旧代票未落库');
    }
    const oldTicket = ticketsBefore[0];

    const res = await postRenew(rig.app, cookieOf(world), seeded.sessionId, { expectedGeneration: 1 });
    expectStableProblem(res, 409, ProblemCode.PLAYBACK_GENERATION_STALE);
    // 旧代票不复活、不续期、不删除:行原样(浏览器 epoch 响应丢弃逻辑归 T053~T055,
    // 此处仅验证服务端按 generation 拒绝)
    const tickets = ticketRowsOf(seeded.sessionId);
    expect(tickets).toHaveLength(1);
    const after = tickets[0];
    if (after === undefined) {
      throw new Error('夹具错误:旧代票丢失');
    }
    expect(after.id).toBe(oldTicket.id);
    expect(after.expiresAt).toBe(oldTicket.expiresAt);
    expect(after.revokedAt).toBeNull();
  });
});

/* ------------------------------------------------------------------ */
/* 限频                                                                */
/* ------------------------------------------------------------------ */

describe('解析控制限频(每设备每分钟;超限 429 + Retry-After)', () => {
  it('同设备 1 分钟内 resolve×30 后第 31 个控制请求(seek)→ 429 PLAYBACK_RATE_LIMITED + Retry-After', async () => {
    const rig = await startFreshApp({ prefix: 'hmp-pb-rate-' });
    const world = await seedWorld(rig, { nasEnabled: true });
    const cookie = cookieOf(world);
    // 媒体流路径不套此限频(受并发/backpressure 预算)—— 属 T031 媒体端点验证,不在本文件
    const seeded = seedVodSession(world, 'ready');

    // resolve/seek/selection 合并计数:前 30 个 resolve 均接受
    for (let i = 0; i < 30; i += 1) {
      const res = await postResolve(rig.app, cookie, { mediaId: world.iptv.mediaId });
      expect(res.status).toBe(201);
    }
    // 第 31 个控制请求(即使类型不同)→ 429,携带 Retry-After
    const overflow = await postSeek(rig.app, cookie, seeded.sessionId, {
      expectedVersion: 1,
      positionSeconds: 10,
    });
    expectStableProblem(overflow, 429, ProblemCode.PLAYBACK_RATE_LIMITED);
    const retryAfter = Number(overflow.headers['retry-after']);
    expect(Number.isFinite(retryAfter)).toBe(true);
    expect(retryAfter).toBeGreaterThan(0);
  });

  it('renew 1 分钟内第 11 次 → 429 PLAYBACK_RATE_LIMITED + Retry-After(renew 每分钟 10 次)', async () => {
    const rig = await startFreshApp({ prefix: 'hmp-pb-rate-' });
    const world = await seedWorld(rig, { nasEnabled: true });
    const cookie = cookieOf(world);
    const seeded = seedVodSession(world, 'ready');

    // 前 10 次正常续期(仅换票)
    for (let i = 0; i < 10; i += 1) {
      const res = await postRenew(rig.app, cookie, seeded.sessionId, { expectedGeneration: 1 });
      expect(res.status).toBe(200);
    }
    const overflow = await postRenew(rig.app, cookie, seeded.sessionId, { expectedGeneration: 1 });
    expectStableProblem(overflow, 429, ProblemCode.PLAYBACK_RATE_LIMITED);
    const retryAfter = Number(overflow.headers['retry-after']);
    expect(Number.isFinite(retryAfter)).toBe(true);
    expect(retryAfter).toBeGreaterThan(0);
  });
});

/* ------------------------------------------------------------------ */
/* 授权顺序                                                            */
/* ------------------------------------------------------------------ */

describe('授权顺序(先会话后资源,不泄漏存在性)', () => {
  it('所有控制端点无会话 → 401 SESSION_INVALID;真实 id 与随机 id 同形(不泄漏资源存在性)', async () => {
    const rig = await startFreshApp({ prefix: 'hmp-pb-authz-' });
    const world = await seedWorld(rig, { nasEnabled: true });
    const seeded = seedVodSession(world, 'ready');
    const app = rig.app;
    const randomId = randomUUID();

    // 无会话:真实 id 一律 401(而非 404/403)
    const cases: request.Test[] = [
      postResolve(app, '', { mediaId: world.iptv.mediaId }),
      getSession(app, '', seeded.sessionId),
      postRenew(app, '', seeded.sessionId, { expectedGeneration: 1 }),
      postHeartbeat(app, '', seeded.sessionId, { positionSeconds: 1, paused: false }),
      postStop(app, '', seeded.sessionId),
      putSelection(app, '', seeded.sessionId, { expectedVersion: 1, positionSeconds: 1, subtitleTrackId: 'sub-1' }),
      postSeek(app, '', seeded.sessionId, { expectedVersion: 1, positionSeconds: 1 }),
    ];
    for (const probe of cases) {
      const res = await probe;
      expectStableProblem(res, 401, ProblemCode.SESSION_INVALID);
    }
    // 不泄漏资源存在性:不存在的 id 与真实 id 同形 401(示例:GET 与 stop)
    for (const probe of [getSession(app, '', randomId), postStop(app, '', randomId)]) {
      const res = await probe;
      expectStableProblem(res, 401, ProblemCode.SESSION_INVALID);
    }
  });
});
