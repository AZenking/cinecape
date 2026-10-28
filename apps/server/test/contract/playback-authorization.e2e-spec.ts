import 'reflect-metadata';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomBytes, randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import request from 'supertest';
import { afterEach, describe, expect, it } from 'vitest';
import type { ArgumentsHost, INestApplication } from '@nestjs/common';
import { ProblemCode, SESSION_COOKIE } from '@hmp/shared';
import { createDomainError } from '@platform/http-common/domain-error';
import { ProblemJsonFilter } from '@platform/http-common/problem-json.filter';
import { getDb } from '@platform/database/drizzle';
import { Database } from '@platform/database/database';
import {
  deviceSession,
  mediaItem,
  mediaSource,
  playbackSession,
  playbackSource,
  playbackTicket,
  profile,
} from '@platform/database/schema';
import {
  cleanupRigs,
  cookiePairOf,
  expectProblemContentType,
  login,
  startFreshApp,
  type TestRig,
} from '../helpers';
import { selectMainAndUnlockSettings } from '../helpers-management';
import {
  seedPlaybackSession,
  seedPlaybackWorld,
  type PlaybackSessionFixture,
  type PlaybackWorld,
  type SeedPlaybackWorldOptions,
} from '../fixtures/playback';

/**
 * T035(004-playback-resolver · US2,只写测试不实现):服务端授权与负向拒绝矩阵契约 e2e。
 *
 * 权威依据:
 * - docs/specs/004-playback-resolver/tasks.md T035 条目(无/过期/撤销会话、未选/停用/PIN
 *   档案、儿童等级/未评级/黑白名单、跨家庭/无源统一 404、复制票到其他设备/session/generation
 *   及异步提交授权变化);
 * - contracts/api.md「稳定错误」(401 SESSION_INVALID / PLAYBACK_TICKET_INVALID /
 *   PLAYBACK_TICKET_EXPIRED;403 ACTIVE_PROFILE_REQUIRED 或 PIN 既有错误;
 *   404 MEDIA_NOT_FOUND 不存在/跨家庭/不可见/无源同形;404 PLAYBACK_NOT_FOUND 非本设备
 *   会话)与「媒体端点」鉴权顺序(SessionGuard → ticket hash/TTL → 绑定
 *   session/device/profile → 最新策略与源事实 → generation/asset 归属);
 * - quickstart.md「SC-002/003:安全」节矩阵口径(逐项档案切换/策略收紧/注销后的下一次
 *   请求拒绝;禁用源停止继续交付)。
 *
 * 覆盖:7 类控制端点 + 媒体资产端点的身份/家庭/策略/重放/变化矩阵,每行一个 it,
 * 每用例独立 rig(startFreshApp 全量迁移库 + 临时 DATA_DIR)。
 *
 * 已知实现偏差(本文件按 api.md 口径断言,用例保持失败,归 T037/T038 裁决,不在本任务修复):
 * - D2 无启用源家庭 resolve:api.md「不存在/跨家庭/不可见/无源同形 404」vs 实现对
 *   「家庭级零可用资源」抛 503 PLAYBACK_RESOURCE_UNAVAILABLE;
 * - E1 复制票到其他设备:api.md 媒体端点「绑定 session/device/profile」→ 期望
 *   401 PLAYBACK_TICKET_INVALID;实现票层只绑 session/generation,设备维度迟到至
 *   authorizeControl 才拒(404 PLAYBACK_NOT_FOUND);
 * - E3 seek 换代后旧 generation 票:api.md seek 行「旧票立即失效」;实现不撤销旧票行,
 *   旧代票 + 旧代 URL 在 direct 交付路径仍返回 200 字节。
 *
 * 夹具(全部复用既有设施,本文件不改 fixtures/helpers/其他 spec):
 * - test/fixtures/playback/(seedPlaybackWorld:双档案 PIN/无 PIN、启用/停用源、可见/不可见
 *   媒体;seedPlaybackSession:指定状态会话 + 可选票据);
 * - playback-stream.e2e-spec.ts 的直接播放夹具模式(临时 MEDIA_ROOTS + 本地 mp4 +
 *   `${rootKey}/${relativePath}` 权威 location 形态)仅用于需要「取票路径真实可达交付」的
 *   矩阵行(C7 运行中流 / E3 换代旧票缺口证据);其余拒绝类行的拒绝点都在交付之前,
 *   plain 世界 + 夹具票构造入口 URL 即可;
 * - 策略变更复用既有 policy 控制器路径:PUT /profiles/{id}/policy(等级/allowUnrated)与
 *   PUT /profiles/{id}/policy/lists(三名单整体替换,version+1);DB 直改仅用于
 *   content_level/源开关/档案停用/票据过期/会话撤销等无 HTTP 语义的工厂事实,均在用例内注明。
 */

/* ------------------------------------------------------------------ */
/* 通用助手                                                            */
/* ------------------------------------------------------------------ */

function freshNow(): string {
  return new Date().toISOString();
}

function cookieOf(world: PlaybackWorld): string {
  return `${SESSION_COOKIE}=${world.sessionToken}`;
}

/** 稳定错误断言:status + RFC 9457 problem+json + 稳定码 */
function expectStableProblem(res: request.Response, status: number, code: ProblemCode): void {
  expect(res.status).toBe(status);
  expectProblemContentType(res);
  expect(res.body.code).toBe(code);
}

/** 同形断言:两响应的 problem 体逐字段一致(码与体结构一致,无法区分存在性) */
function expectSameProblemShape(a: request.Response, b: request.Response): void {
  expect(a.body).toEqual(b.body);
}

/**
 * US8 设置边界:策略/档案管理写需「主档案选中 + 设置解锁」——升格有 PIN 成人为主档案,
 * 以 world 会话完成选档与 PIN 解锁(005 §7:grant 先于当次密码/严格入参)。
 * 副作用注明:换档使 world 会话 activeProfile 切至主档案且 pcv 递增(旧上下文播放
 * 终态化),故调用方须在 seedPlaybackSession/resolve 之前调用并绑定主档案。
 */
async function unlockSettingsAsOwner(app: INestApplication, world: SeededWorld): Promise<void> {
  Database.db
    .prepare("UPDATE profile SET is_main = 1 WHERE id = ? AND type = 'adult' AND status = 'active' AND pin_hash IS NOT NULL")
    .run(world.profileWithPinId);
  await selectMainAndUnlockSettings(app, cookieOf(world), { mainPin: world.pin });
}

/** seedWorld 句柄:PlaybackWorld + 显式 username(登录类用例需要;多家庭须互异) */
type SeededWorld = PlaybackWorld & { readonly username: string };

/** 认证按 usernameNormalized 全局唯一:同 rig 多家庭必须互用不同 username */
async function seedWorld(rig: TestRig, options: SeedPlaybackWorldOptions = {}): Promise<SeededWorld> {
  const username = options.username ?? 'player';
  const world = await seedPlaybackWorld(rig, { ...options, username });
  return { ...world, username };
}

/** 同库第二家庭(跨家庭负向用) */
async function seedOtherHousehold(rig: TestRig, tag: string): Promise<SeededWorld> {
  return seedWorld(rig, { householdName: `${tag}-乙家庭`, username: `player-b-${tag}` });
}

/** 同账号新登录并选择无 PIN 默认档案,模拟「另一台设备」(返回 Cookie 对) */
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

/* ------------------------------------------------------------------ */
/* 控制端点请求助手(统一 Cookie 认证,与既有契约惯例一致)               */
/* ------------------------------------------------------------------ */

function postResolve(app: INestApplication, cookie: string, mediaId: string): request.Test {
  return request(app.getHttpServer()).post('/api/playback/resolve').set('Cookie', cookie).send({ mediaId });
}
function getSession(app: INestApplication, cookie: string, id: string): request.Test {
  return request(app.getHttpServer()).get(`/api/playback/sessions/${id}`).set('Cookie', cookie);
}
function postRenew(app: INestApplication, cookie: string, id: string, expectedGeneration: number): request.Test {
  return request(app.getHttpServer())
    .post(`/api/playback/sessions/${id}/renew`)
    .set('Cookie', cookie)
    .send({ expectedGeneration });
}
function postHeartbeat(app: INestApplication, cookie: string, id: string): request.Test {
  return request(app.getHttpServer())
    .post(`/api/playback/sessions/${id}/heartbeat`)
    .set('Cookie', cookie)
    .send({ positionSeconds: 1, paused: false });
}
function postStop(app: INestApplication, cookie: string, id: string): request.Test {
  return request(app.getHttpServer()).post(`/api/playback/sessions/${id}/stop`).set('Cookie', cookie).send({});
}
function putSelection(app: INestApplication, cookie: string, id: string): request.Test {
  return request(app.getHttpServer())
    .put(`/api/playback/sessions/${id}/selection`)
    .set('Cookie', cookie)
    .send({ expectedVersion: 1, positionSeconds: 1, subtitleTrackId: 'sub-1' });
}
function postSeek(app: INestApplication, cookie: string, id: string, positionSeconds: number): request.Test {
  return request(app.getHttpServer())
    .post(`/api/playback/sessions/${id}/seek`)
    .set('Cookie', cookie)
    .send({ expectedVersion: 1, positionSeconds });
}
function getStream(app: INestApplication, cookie: string, url: string): request.Test {
  return request(app.getHttpServer()).get(url).set('Cookie', cookie);
}
function postLogout(app: INestApplication, cookie: string): request.Test {
  return request(app.getHttpServer()).post('/api/auth/logout').set('Cookie', cookie).send({});
}

/* ------------------------------------------------------------------ */
/* 档案/策略控制器路径助手(复用既有 profile/policy 契约路由)             */
/* ------------------------------------------------------------------ */

function postSelectProfile(app: INestApplication, cookie: string, profileId: string, body: object = {}): request.Test {
  return request(app.getHttpServer()).post(`/api/profiles/${profileId}/select`).set('Cookie', cookie).send(body);
}
function postUnlockPin(app: INestApplication, cookie: string, profileId: string, pin: string): request.Test {
  return request(app.getHttpServer()).post(`/api/profiles/${profileId}/unlock`).set('Cookie', cookie).send({ pin });
}
function getPolicyDto(app: INestApplication, cookie: string, profileId: string): request.Test {
  return request(app.getHttpServer()).get(`/api/settings/profiles/${profileId}/policy`).set('Cookie', cookie);
}

/** PUT /profiles/{id}/policy(等级/allowUnrated;version+1) */
function putPolicyLevel(
  app: INestApplication,
  cookie: string,
  profileId: string,
  body: {
    ownerPassword: string;
    expectedVersion: number;
    policy: { maxContentLevel: number; allowUnrated: boolean };
  },
): request.Test {
  return request(app.getHttpServer()).put(`/api/settings/profiles/${profileId}/policy`).set('Cookie', cookie).send(body);
}

/** PUT /profiles/{id}/policy/lists(三名单整体替换;version+1)——矩阵「策略收紧」的 HTTP 路径 */
function putPolicyLists(
  app: INestApplication,
  cookie: string,
  profileId: string,
  body: {
    ownerPassword: string;
    expectedVersion: number;
    allowedMediaIds?: string[];
    blockedMediaIds?: string[];
    allowedChannelIds?: string[];
  },
): request.Test {
  return request(app.getHttpServer())
    .put(`/api/settings/profiles/${profileId}/policy/lists`)
    .set('Cookie', cookie)
    // 契约 UpdateLists:三名单必填数组(strictObject),整体替换
    .send({ allowedMediaIds: [], blockedMediaIds: [], allowedChannelIds: [], ...body });
}

/** 当前策略 version(PUT 前取 CAS 基准;调用方保证策略行已存在,如经创建/回填路径建立) */
async function currentPolicyVersion(app: INestApplication, cookie: string, profileId: string): Promise<number> {
  const res = await getPolicyDto(app, cookie, profileId);
  expect(res.status, 'GET policy 应 200(策略行已存在)').toBe(200);
  return res.body.version as number;
}

/** 经 HTTP 名单入口把媒体加入黑名单(家长验证 + version+1;返回新 version;名单落在 targetProfileId) */
async function blockMediaViaLists(
  app: INestApplication,
  cookie: string,
  world: SeededWorld,
  targetProfileId: string,
  mediaId: string,
): Promise<void> {
  const version = await currentPolicyVersion(app, cookie, targetProfileId);
  const res = await putPolicyLists(app, cookie, targetProfileId, {
    ownerPassword: world.password,
    expectedVersion: version,
    blockedMediaIds: [mediaId],
  });
  expect(res.status, 'PUT policy/lists 应 200').toBe(200);
  expect(res.body.version, '策略保存必须 version+1(FR-007)').toBe(version + 1);
}

/** 创建儿童档案并经新登录会话选择(儿童无 PIN 直接可选;返回儿童会话 Cookie 与档案 id) */
async function createChildProfile(
  app: INestApplication,
  world: SeededWorld,
): Promise<{ cookie: string; profileId: string }> {
  // 005 US8:建档案属管理写(设置边界)——先解锁设置,再经 /api/settings/profiles 创建
  await unlockSettingsAsOwner(app, world);
  const create = await request(app.getHttpServer())
    .post('/api/settings/profiles')
    .set('Cookie', cookieOf(world))
    .send({ name: '儿童档案', type: 'child', ownerPassword: world.password });
  expect(create.status, 'POST /settings/profiles 应 201').toBe(201);
  const childProfileId = (create.body as Record<string, unknown>)['id'] as string;
  const fresh = await login(app, world.username, world.password);
  expect(fresh.status).toBe(200);
  const childCookie = cookiePairOf(fresh);
  const select = await postSelectProfile(app, childCookie, childProfileId);
  expect(select.status, '儿童档案(无 PIN)应可直接选择').toBe(200);
  return { cookie: childCookie, profileId: childProfileId };
}

/* ------------------------------------------------------------------ */
/* DB 直改助手(无 HTTP 语义的工厂事实;各用例内注明)                     */
/* ------------------------------------------------------------------ */

/** DB 直改:媒体分级(18=超龄代表;null=未评级;schema 允许 NULL) */
function setContentLevel(mediaId: string, contentLevel: number | null): void {
  getDb().update(mediaItem).set({ contentLevel }).where(eq(mediaItem.id, mediaId)).run();
}

/** DB 直改:停用当前档案(绕过 PATCH 停用级联,专测授权链 status!=='active' 判定) */
function disableProfileRow(profileId: string): void {
  getDb().update(profile).set({ status: 'disabled' }).where(eq(profile.id, profileId)).run();
}

/** DB 直改:停用父源(media_source.enabled=0;源启停无 HTTP 端点,属扫描/运维语义) */
function disableMediaSourceRow(sourceId: string): void {
  getDb().update(mediaSource).set({ enabled: 0 }).where(eq(mediaSource.id, sourceId)).run();
}

/** DB 直改:撤销设备会话(revoked_at 置当前时刻;logout 的库内等价形态) */
function revokeDeviceSessionRow(deviceSessionId: string): void {
  getDb().update(deviceSession).set({ revokedAt: freshNow() }).where(eq(deviceSession.id, deviceSessionId)).run();
}

/** DB 直改:票据过期(issued/expires 一并回拨,满足 expires_at > issued_at 约束) */
function expireTicketRow(ticketId: string): void {
  getDb()
    .update(playbackTicket)
    .set({ issuedAt: '2020-01-01T00:00:00.000Z', expiresAt: '2020-01-01T00:01:00.000Z' })
    .where(eq(playbackTicket.id, ticketId))
    .run();
}

/** 某会话的票行数(签票拒/不签票断言用) */
function ticketCountOf(sessionId: string): number {
  return getDb().select().from(playbackTicket).where(eq(playbackTicket.sessionId, sessionId)).all().length;
}

function sessionRowOf(sessionId: string): typeof playbackSession.$inferSelect {
  const row = getDb().select().from(playbackSession).where(eq(playbackSession.id, sessionId)).get();
  if (row === undefined) {
    throw new Error(`夹具错误:playback_session ${sessionId} 不存在`);
  }
  return row;
}

/* ------------------------------------------------------------------ */
/* 媒体端点夹具(取票路径与直接播放世界,模式对齐 playback-stream e2e)     */
/* ------------------------------------------------------------------ */

const NAS_ROOT_KEY = 'playback-fixture-nas';
const MOVIE_REL_PATH = 'media/fixture-movie-1080p.mp4';
const tempDirs: string[] = [];

/**
 * 直接播放世界:临时 MEDIA_ROOTS 注入真实 mp4 + playback_source 权威 location 形态
 * (`${rootKey}/${relativePath}`,mime_type 置空)+ playing/direct 会话 —— 媒体资产请求
 * 可以真实交付 200 字节(C7「运行中」前置证据 / E3 换代旧票缺口的实际 200 证据)。
 */
async function setupDirectWorld(prefix: string): Promise<{
  rig: TestRig;
  world: SeededWorld;
  cookie: string;
  session: PlaybackSessionFixture;
}> {
  const nasRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'hmp-authz-nas-'));
  tempDirs.push(nasRoot);
  fs.mkdirSync(path.join(nasRoot, 'media'), { recursive: true });
  fs.writeFileSync(path.join(nasRoot, MOVIE_REL_PATH), Buffer.alloc(65536, 0x5a));
  const rig = await startFreshApp({ prefix, env: { MEDIA_ROOTS: `${NAS_ROOT_KEY}=${nasRoot}` } });
  const world = await seedWorld(rig, { nasEnabled: true });
  // US8:名单入口属设置边界 —— 先解锁(active 切至主档案),会话种子随之绑定主档案
  await unlockSettingsAsOwner(rig.app, world);
  getDb()
    .update(playbackSource)
    .set({ location: `${NAS_ROOT_KEY}/${MOVIE_REL_PATH}`, mimeType: null })
    .where(eq(playbackSource.id, world.nas.playbackSourceId))
    .run();
  const session = seedPlaybackSession(world, {
    state: 'playing',
    delivery: 'direct',
    playbackSourceId: world.nas.playbackSourceId,
    profileId: world.profileWithPinId,
    at: freshNow(),
  });
  alignSeededSessionPcv(world, session.sessionId);
  return { rig, world, cookie: cookieOf(world), session };
}

/** renew 取真实 playbackUrl(媒体资产 URL 唯一合法来源;矩阵中媒体请求的取票路径) */
async function renewForPlaybackUrl(
  rig: TestRig,
  cookie: string,
  session: PlaybackSessionFixture,
): Promise<{ url: string; ticket: string; generation: number }> {
  const res = await postRenew(rig.app, cookie, session.sessionId, session.generation);
  expect(res.status, 'renew 应 200 TicketReply(ready/playing 会话)').toBe(200);
  const body = res.body as Record<string, unknown>;
  const url = String(body['playbackUrl']);
  expect(url.startsWith('/api/playback/stream/')).toBe(true);
  const parsed = new URL(url, 'https://entry.invalid');
  const ticket = parsed.searchParams.get('ticket');
  expect(ticket, 'playbackUrl 必须携带 ticket query').toBeTruthy();
  return { url, ticket: ticket ?? '', generation: Number(body['generation']) };
}

/** 直接构造流入口 URL(拒绝类矩阵行:拒绝点都在交付之前,夹具票即可) */
function streamUrl(session: PlaybackSessionFixture, ticket: string): string {
  return `/api/playback/stream/${session.sessionId}/${session.generation}/index?ticket=${encodeURIComponent(ticket)}`;
}

/** 便捷会话构造:ready/playing 直播(hls_proxy,IPTV 启用代表行;可选绑定档案/预置票) */

/** US8:unlockSettingsAsOwner 切主档案使 device_session.pcv+1 —— 直改种子会话 pcv 对齐当前上下文
 *  (fixture 不暴露 pcv 入参;此为取线路径迁移的最小夹具适配,不改共享 fixture) */
function alignSeededSessionPcv(world: PlaybackWorld, sessionId: string): void {
  Database.db
    .prepare(
      'UPDATE playback_session SET profile_context_version = (SELECT profile_context_version FROM device_session WHERE id = ?) WHERE id = ?',
    )
    .run(world.deviceSessionId, sessionId);
}

function seedReadySession(
  world: PlaybackWorld,
  state: 'ready' | 'playing',
  extra: { profileId?: string; ticket?: { generation?: number } } = {},
): PlaybackSessionFixture {
  return seedPlaybackSession(world, {
    state,
    mediaId: world.iptv.mediaId,
    playbackSourceId: world.iptv.playbackSourceId,
    delivery: 'hls_proxy',
    at: freshNow(),
    ...extra,
  });
}

afterEach(async () => {
  await cleanupRigs();
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir !== undefined) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
});

/* ------------------------------------------------------------------ */
/* A 会话维度                                                          */
/* ------------------------------------------------------------------ */

describe('T035 会话维度(无/过期/撤销/伪造 → 401 SESSION_INVALID)', () => {
  it('无会话访问全部控制端点与媒体资产端点 → 401 SESSION_INVALID(媒体端点即使携带有效票,SessionGuard 先于票校验)', async () => {
    const rig = await startFreshApp({ prefix: 'hmp-authz-a1-' });
    const world = await seedWorld(rig);
    const session = seedReadySession(world, 'playing', { ticket: {} });
    expect(session.ticket).not.toBeNull();

    const probes: request.Test[] = [
      postResolve(rig.app, '', world.iptv.mediaId),
      getSession(rig.app, '', session.sessionId),
      postRenew(rig.app, '', session.sessionId, 1),
      postHeartbeat(rig.app, '', session.sessionId),
      postStop(rig.app, '', session.sessionId),
      putSelection(rig.app, '', session.sessionId),
      postSeek(rig.app, '', session.sessionId, 10),
      // 媒体资产:有效票 + 真实 session/generation,但无设备会话 → 仍 401(token 不能单独授权)
      getStream(rig.app, '', streamUrl(session, session.ticket?.token ?? '')),
    ];
    for (const probe of probes) {
      const res = await probe;
      expectStableProblem(res, 401, ProblemCode.SESSION_INVALID);
    }
  });

  it('过期会话(恰好过期=已过期)→ GET/resolve 均 401 SESSION_INVALID', async () => {
    const rig = await startFreshApp({ prefix: 'hmp-authz-a2-' });
    // 夹具参数(非运行时直改):device_session.expires_at 落在过去
    const world = await seedWorld(rig, { sessionExpiresAt: '2026-10-24T00:00:00.000Z' });
    const session = seedReadySession(world, 'ready');
    expectStableProblem(await getSession(rig.app, cookieOf(world), session.sessionId), 401, ProblemCode.SESSION_INVALID);
    expectStableProblem(await postResolve(rig.app, cookieOf(world), world.iptv.mediaId), 401, ProblemCode.SESSION_INVALID);
  });

  it('撤销会话:logout 撤销与 DB 直撤均 → 401 SESSION_INVALID(授权链实时重验,不缓存正结果)', async () => {
    const rig = await startFreshApp({ prefix: 'hmp-authz-a3-' });
    const logoutWorld = await seedWorld(rig, { username: 'logout-player' });
    const dbRevokeWorld = await seedWorld(rig, { householdName: '直撤家庭', username: 'revoke-player' });

    // logout(HTTP 既有路径):204 幂等注销后,下一播放请求即拒
    expect((await postLogout(rig.app, cookieOf(logoutWorld))).status).toBe(204);
    expectStableProblem(
      await postResolve(rig.app, cookieOf(logoutWorld), logoutWorld.iptv.mediaId),
      401,
      ProblemCode.SESSION_INVALID,
    );

    // DB 直改注明:revoked_at 置位(logout 的库内等价形态;SessionGuard/授权链实时重读)
    revokeDeviceSessionRow(dbRevokeWorld.deviceSessionId);
    expectStableProblem(
      await postResolve(rig.app, cookieOf(dbRevokeWorld), dbRevokeWorld.iptv.mediaId),
      401,
      ProblemCode.SESSION_INVALID,
    );
    expectStableProblem(await getSession(rig.app, cookieOf(dbRevokeWorld), randomUUID()), 401, ProblemCode.SESSION_INVALID);
  });

  it('伪造 token(随机串冒充会话令牌)→ 控制与媒体端点均 401 SESSION_INVALID', async () => {
    const rig = await startFreshApp({ prefix: 'hmp-authz-a4-' });
    const world = await seedWorld(rig);
    const session = seedReadySession(world, 'playing', { ticket: {} });
    const forged = `${SESSION_COOKIE}=forged-token-not-in-db`;
    expectStableProblem(await postResolve(rig.app, forged, world.iptv.mediaId), 401, ProblemCode.SESSION_INVALID);
    expectStableProblem(await getSession(rig.app, forged, session.sessionId), 401, ProblemCode.SESSION_INVALID);
    expectStableProblem(
      await getStream(rig.app, forged, streamUrl(session, session.ticket?.token ?? '')),
      401,
      ProblemCode.SESSION_INVALID,
    );
  });
});

/* ------------------------------------------------------------------ */
/* B 档案维度                                                          */
/* ------------------------------------------------------------------ */

describe('T035 档案维度(未选/停用/PIN)', () => {
  it('登录未选档案 → resolve 403 ACTIVE_PROFILE_REQUIRED(不回落默认档案)', async () => {
    const rig = await startFreshApp({ prefix: 'hmp-authz-b1-' });
    const world = await seedWorld(rig);
    const fresh = await login(rig.app, world.username, world.password);
    expect(fresh.status).toBe(200);
    expectStableProblem(
      await postResolve(rig.app, cookiePairOf(fresh), world.iptv.mediaId),
      403,
      ProblemCode.ACTIVE_PROFILE_REQUIRED,
    );
  });

  it('激活档案被停用(DB 直改,绕过 PATCH 停用级联)→ 下一请求 GET/resolve 均 403 ACTIVE_PROFILE_REQUIRED', async () => {
    const rig = await startFreshApp({ prefix: 'hmp-authz-b2-' });
    const world = await seedWorld(rig);
    const session = seedReadySession(world, 'ready');
    // DB 直改注明:专测授权链对 profile.status 的实时判定(status!=='active' → 403)
    disableProfileRow(world.profileId);
    expectStableProblem(await getSession(rig.app, cookieOf(world), session.sessionId), 403, ProblemCode.ACTIVE_PROFILE_REQUIRED);
    expectStableProblem(await postResolve(rig.app, cookieOf(world), world.iptv.mediaId), 403, ProblemCode.ACTIVE_PROFILE_REQUIRED);
  });

  it('绑定 PIN 档案但当前激活另一档案 → GET/renew 均 403 PROFILE_PIN_REQUIRED(绑定档案受 PIN 保护复用 PIN 既有错误)', async () => {
    const rig = await startFreshApp({ prefix: 'hmp-authz-b3-' });
    const world = await seedWorld(rig);
    // 播放会话绑定有 PIN 档案;设备会话当前激活的是无 PIN 默认档案(夹具缺省态)
    const session = seedReadySession(world, 'ready', { profileId: world.profileWithPinId });
    expectStableProblem(await getSession(rig.app, cookieOf(world), session.sessionId), 403, ProblemCode.PROFILE_PIN_REQUIRED);
    expectStableProblem(await postRenew(rig.app, cookieOf(world), session.sessionId, 1), 403, ProblemCode.PROFILE_PIN_REQUIRED);
    // 拒绝路径不签票
    expect(ticketCountOf(session.sessionId)).toBe(0);
  });

  it('PIN 未解锁选档案 → 复用既有 PIN 语义:select 403 PROFILE_PIN_REQUIRED;连错锁定后 unlock 正确 PIN 423 PROFILE_PIN_LOCKED;锁定窗口内 select 仍 403', async () => {
    const rig = await startFreshApp({ prefix: 'hmp-authz-b4-' });
    const world = await seedWorld(rig);
    const fresh = await login(rig.app, world.username, world.password);
    expect(fresh.status).toBe(200);
    const cookie = cookiePairOf(fresh);

    // 未解锁直接选 PIN 档案 → 403 PROFILE_PIN_REQUIRED(既有语义)
    expectStableProblem(await postSelectProfile(rig.app, cookie, world.profileWithPinId), 403, ProblemCode.PROFILE_PIN_REQUIRED);

    // 既有 PIN 状态机:连错至锁定(第 N=上限次错误本身仍 403,其后窗口内一律 423)
    let wrongAttempts = 0;
    while (wrongAttempts < 10) {
      const res = await postUnlockPin(rig.app, cookie, world.profileWithPinId, '000000');
      if (res.status !== 403) {
        break;
      }
      wrongAttempts += 1;
    }
    expect(wrongAttempts, '连错应触发锁定(403 耗尽)').toBeGreaterThan(0);
    expectStableProblem(
      await postUnlockPin(rig.app, cookie, world.profileWithPinId, world.pin),
      423,
      ProblemCode.PROFILE_PIN_LOCKED,
    );
    // 锁定窗口内 select 依旧不放行(解锁授予不存在):播放侧 PIN 语义同源
    expectStableProblem(await postSelectProfile(rig.app, cookie, world.profileWithPinId), 403, ProblemCode.PROFILE_PIN_REQUIRED);
  });
});

/* ------------------------------------------------------------------ */
/* C 策略维度                                                          */
/* ------------------------------------------------------------------ */

describe('T035 策略维度(儿童等级/未评级/黑白名单/收紧)', () => {
  it('儿童档案超龄媒体 → 404 MEDIA_NOT_FOUND,与不存在媒体同形(不返回策略明细)', async () => {
    const rig = await startFreshApp({ prefix: 'hmp-authz-c1-' });
    const world = await seedWorld(rig);
    const child = await createChildProfile(rig.app, world);
    // DB 直改注明:IPTV 频道代表行标为 18 级(儿童默认上限 12,LEVEL_EXCEEDED 代表行)
    setContentLevel(world.iptv.mediaId, 18);
    const denied = await postResolve(rig.app, child.cookie, world.iptv.mediaId);
    expectStableProblem(denied, 404, ProblemCode.MEDIA_NOT_FOUND);
    // 同形:与「不存在媒体」码与体结构完全一致
    const missing = await postResolve(rig.app, child.cookie, randomUUID());
    expectStableProblem(missing, 404, ProblemCode.MEDIA_NOT_FOUND);
    expectSameProblemShape(denied, missing);
  });

  it('黑名单媒体(HTTP 名单入口 version+1)→ 404 MEDIA_NOT_FOUND', async () => {
    const rig = await startFreshApp({ prefix: 'hmp-authz-c2-' });
    const world = await seedWorld(rig);
    const cookie = cookieOf(world);
    // US8:名单入口属设置边界 —— 先解锁(active 切至主档案),resolve 回填主档案策略行
    await unlockSettingsAsOwner(rig.app, world);
    // 先成功 resolve 一次:授权链惰性回填默认策略行,随后名单入口可用
    expect((await postResolve(rig.app, cookie, world.iptv.mediaId)).status).toBe(201);
    await blockMediaViaLists(rig.app, cookie, world, world.profileWithPinId, world.iptv.mediaId);
    expectStableProblem(await postResolve(rig.app, cookie, world.iptv.mediaId), 404, ProblemCode.MEDIA_NOT_FOUND);
  });

  it('未评级媒体 + allowUnrated=false → 404 MEDIA_NOT_FOUND(默认成人 allowUnrated=true 时放行为基线)', async () => {
    const rig = await startFreshApp({ prefix: 'hmp-authz-c3-' });
    const world = await seedWorld(rig);
    const cookie = cookieOf(world);
    // US8:等级入口属设置边界 —— 先解锁(active 切至主档案),等级收紧落在主档案
    await unlockSettingsAsOwner(rig.app, world);
    // DB 直改注明:IPTV 频道代表行置 NULL = 未评级
    setContentLevel(world.iptv.mediaId, null);
    // 基线:成人默认策略(授权链回填 allowUnrated=true)对未评级放行
    expect((await postResolve(rig.app, cookie, world.iptv.mediaId)).status).toBe(201);
    // HTTP 等级入口收紧:allowUnrated=false(version+1)
    const version = await currentPolicyVersion(rig.app, cookie, world.profileWithPinId);
    const tightened = await putPolicyLevel(rig.app, cookie, world.profileWithPinId, {
      ownerPassword: world.password,
      expectedVersion: version,
      policy: { maxContentLevel: 18, allowUnrated: false },
    });
    expect(tightened.status).toBe(200);
    expect(tightened.body.version).toBe(version + 1);
    expectStableProblem(await postResolve(rig.app, cookie, world.iptv.mediaId), 404, ProblemCode.MEDIA_NOT_FOUND);
  });

  it('儿童档案名单外频道(IPTV,allowedChannelIds 空=全部不可访问)→ 404 MEDIA_NOT_FOUND', async () => {
    const rig = await startFreshApp({ prefix: 'hmp-authz-c4-' });
    const world = await seedWorld(rig);
    const child = await createChildProfile(rig.app, world);
    expectStableProblem(await postResolve(rig.app, child.cookie, world.iptv.mediaId), 404, ProblemCode.MEDIA_NOT_FOUND);
  });

  it('儿童档案白名单正例:频道加入 allowedChannelIds(version+1)后 → 201(黑白名单语义生效的对照面)', async () => {
    const rig = await startFreshApp({ prefix: 'hmp-authz-c5-' });
    const world = await seedWorld(rig);
    const child = await createChildProfile(rig.app, world);
    // 名单落在儿童档案(判定以当前观看者档案策略为准);家长验证用 owner 会话
    const version = await currentPolicyVersion(rig.app, cookieOf(world), child.profileId);
    const res = await putPolicyLists(rig.app, cookieOf(world), child.profileId, {
      ownerPassword: world.password,
      expectedVersion: version,
      allowedChannelIds: [world.iptv.mediaId],
    });
    expect(res.status).toBe(200);
    expect(res.body.version).toBe(version + 1);
    expect((await postResolve(rig.app, child.cookie, world.iptv.mediaId)).status).toBe(201);
  });

  it('策略收紧(version+1)后:已 active session 的下一次 GET/renew/媒体请求 → 404 MEDIA_NOT_FOUND 拒绝', async () => {
    const rig = await startFreshApp({ prefix: 'hmp-authz-c6-' });
    const world = await seedWorld(rig);
    // US8:名单入口属设置边界 —— 先解锁(active 切至主档案),会话种子绑定主档案,
    // 使收紧后拒绝点落在策略链(404 MEDIA_NOT_FOUND)而非旧上下文(PLAYBACK_NOT_FOUND)
    await unlockSettingsAsOwner(rig.app, world);
    const cookie = cookieOf(world);
    const session = seedReadySession(world, 'ready', { profileId: world.profileWithPinId });
    alignSeededSessionPcv(world, session.sessionId);
    // 收紧前:GET 200、renew 签票 200
    expect((await getSession(rig.app, cookie, session.sessionId)).status).toBe(200);
    const asset = await renewForPlaybackUrl(rig, cookie, session);
    // 收紧(黑名单,version+1)
    await blockMediaViaLists(rig.app, cookie, world, world.profileWithPinId, world.iptv.mediaId);
    // 收紧后:下一次控制请求一律 404(不缓存授权正结果)
    expectStableProblem(await getSession(rig.app, cookie, session.sessionId), 404, ProblemCode.MEDIA_NOT_FOUND);
    expectStableProblem(await postRenew(rig.app, cookie, session.sessionId, 1), 404, ProblemCode.MEDIA_NOT_FOUND);
    expectStableProblem(await getStream(rig.app, cookie, asset.url), 404, ProblemCode.MEDIA_NOT_FOUND);
    // renew 被拒不签票:票行数不变(仍为收紧前 1 条)
    expect(ticketCountOf(session.sessionId)).toBe(1);
  });

  it('运行中媒体流在策略收紧后的新请求 → 404 拒绝(已发送字节不追回,仅断言新请求拒)', async () => {
    const { rig, world, cookie, session } = await setupDirectWorld('hmp-authz-c7-');
    const asset = await renewForPlaybackUrl(rig, cookie, session);
    // 运行中证据:真实直读交付 200(video/mp4)
    const playing = await getStream(rig.app, cookie, asset.url);
    expect(playing.status).toBe(200);
    expect(String(playing.headers['content-type'])).toContain('video/mp4');
    // 收紧(黑名单)后:同一 URL 的新请求即拒
    await blockMediaViaLists(rig.app, cookie, world, world.profileWithPinId, world.nas.mediaId);
    expectStableProblem(await getStream(rig.app, cookie, asset.url), 404, ProblemCode.MEDIA_NOT_FOUND);
  });
});

/* ------------------------------------------------------------------ */
/* D 家庭与源维度                                                       */
/* ------------------------------------------------------------------ */

describe('T035 家庭/源维度(跨家庭 404 同形;无源/禁源)', () => {
  it('跨家庭 session id:GET/stop/renew/媒体 → 404 PLAYBACK_NOT_FOUND 同形(不泄漏存在性)', async () => {
    const rig = await startFreshApp({ prefix: 'hmp-authz-d1-' });
    const world = await seedWorld(rig, { username: 'owner-a' });
    const other = await seedOtherHousehold(rig, world.householdId.slice(0, 8));
    const session = seedReadySession(world, 'playing', { ticket: {} });
    const otherCookie = cookieOf(other);

    const denied = await getSession(rig.app, otherCookie, session.sessionId);
    expectStableProblem(denied, 404, ProblemCode.PLAYBACK_NOT_FOUND);
    expectStableProblem(await postStop(rig.app, otherCookie, session.sessionId), 404, ProblemCode.PLAYBACK_NOT_FOUND);
    expectStableProblem(await postRenew(rig.app, otherCookie, session.sessionId, 1), 404, ProblemCode.PLAYBACK_NOT_FOUND);
    // 媒体:乙家庭会话 + 甲家庭真实票/URL → 票绑定通过后仍拒于会话归属(404,非交付)
    const media = await getStream(rig.app, otherCookie, streamUrl(session, session.ticket?.token ?? ''));
    expectStableProblem(media, 404, ProblemCode.PLAYBACK_NOT_FOUND);
    // 同形:与随机不存在 id 完全一致
    expectSameProblemShape(denied, await getSession(rig.app, otherCookie, randomUUID()));
    // 停止未被越权执行:原会话状态原样
    expect(sessionRowOf(session.sessionId).state).toBe('playing');
  });

  it('无启用源家庭 resolve → 按 api.md「不存在/跨家庭/不可见/无源同形」期望 404 MEDIA_NOT_FOUND(实现对家庭级零资源抛 503 属 T037 裁决偏差,本用例有意失败)', async () => {
    const rig = await startFreshApp({ prefix: 'hmp-authz-d2-' });
    // iptvEnabled:false + NAS 缺省停用 → 家庭级零可用资源代表行
    const world = await seedWorld(rig, { iptvEnabled: false });
    // 不存在媒体 → 404(同形基线,实现一致)
    expectStableProblem(await postResolve(rig.app, cookieOf(world), randomUUID()), 404, ProblemCode.MEDIA_NOT_FOUND);
    // 存在但家庭内无任何启用源 → api.md 要求与上同形 404;实现为 503 PLAYBACK_RESOURCE_UNAVAILABLE → 失败即偏差记录
    const sourceless = await postResolve(rig.app, cookieOf(world), world.iptv.mediaId);
    expectStableProblem(sourceless, 404, ProblemCode.MEDIA_NOT_FOUND);
  });

  it('源禁用(DB 直改 enabled=0)后:新 resolve → 404;活动 session 的下一次媒体请求 → 404 拒绝', async () => {
    const rig = await startFreshApp({ prefix: 'hmp-authz-d3-' });
    const world = await seedWorld(rig);
    const cookie = cookieOf(world);
    // 活动 session 绑定 NAS 媒体(被禁源的代表行;direct 交付,拒绝发生在授权链而非上游)
    const session = seedPlaybackSession(world, {
      state: 'playing',
      mediaId: world.nas.mediaId,
      playbackSourceId: world.nas.playbackSourceId,
      delivery: 'direct',
      at: freshNow(),
      ticket: {},
    });
    expect(session.ticket).not.toBeNull();
    // DB 直改注明:停用 NAS 父源(家庭仍剩启用 IPTV → 媒体级无源 404 同形,而非家庭级 503)
    disableMediaSourceRow(world.nas.sourceId);
    expectStableProblem(await postResolve(rig.app, cookie, world.nas.mediaId), 404, ProblemCode.MEDIA_NOT_FOUND);
    expectStableProblem(
      await getStream(rig.app, cookie, streamUrl(session, session.ticket?.token ?? '')),
      404,
      ProblemCode.MEDIA_NOT_FOUND,
    );
  });
});

/* ------------------------------------------------------------------ */
/* E 票据维度                                                          */
/* ------------------------------------------------------------------ */

describe('T035 票据维度(复制/互换/换代/过期/篡改)', () => {
  it('复制票到其他设备(第二设备已登录,持复制票访问媒体)→ 按 api.md「绑定 session/device/profile」期望 401 PLAYBACK_TICKET_INVALID(实现票层无设备绑定、迟到 404 属 T037 裁决偏差,本用例有意失败)', async () => {
    const rig = await startFreshApp({ prefix: 'hmp-authz-e1-' });
    const world = await seedWorld(rig, { username: 'ticket-owner' });
    const session = seedReadySession(world, 'playing', { ticket: {} });
    const secondDeviceCookie = await loginSecondDevice(rig.app, world);
    // 第二设备(同家庭同账号另一会话)持复制票:按媒体端点鉴权顺序,票设备绑定失败 → 401
    const res = await getStream(rig.app, secondDeviceCookie, streamUrl(session, session.ticket?.token ?? ''));
    expectStableProblem(res, 401, ProblemCode.PLAYBACK_TICKET_INVALID);
  });

  it('票用于同家庭另一 session(媒体 URL 互换)→ 401 PLAYBACK_TICKET_INVALID', async () => {
    const rig = await startFreshApp({ prefix: 'hmp-authz-e2-' });
    const world = await seedWorld(rig);
    const sessionA = seedReadySession(world, 'playing', { ticket: {} });
    const sessionB = seedReadySession(world, 'playing', { ticket: {} });
    expect(sessionA.ticket).not.toBeNull();
    expect(sessionB.ticket).not.toBeNull();
    const res = await getStream(rig.app, cookieOf(world), streamUrl(sessionA, sessionB.ticket?.token ?? ''));
    expectStableProblem(res, 401, ProblemCode.PLAYBACK_TICKET_INVALID);
  });

  it('seek 换代后旧 generation 票 → 按 api.md seek 行「旧票立即失效」期望 401(实现不撤销旧票、旧代 URL direct 交付仍 200 属 T037/T038 裁决偏差,本用例有意失败)', async () => {
    const { rig, cookie, session } = await setupDirectWorld('hmp-authz-e3-');
    const asset = await renewForPlaybackUrl(rig, cookie, session);
    expect(asset.generation).toBe(1);
    // 换代前旧票可用(基线 200)
    expect((await getStream(rig.app, cookie, asset.url)).status).toBe(200);
    // seek 换代:generation 1 → 2,进入 preparing
    const seek = await postSeek(rig.app, cookie, session.sessionId, 60);
    expect(seek.status).toBe(200);
    // 旧代票 + 旧代 URL:契约「旧票立即失效」→ 401;实现仍交付 → 失败即缺口证据
    const stale = await getStream(rig.app, cookie, asset.url);
    expectStableProblem(stale, 401, ProblemCode.PLAYBACK_TICKET_INVALID);
  });

  it('过期票(DB 回拨 issued/expires)→ 401 PLAYBACK_TICKET_EXPIRED', async () => {
    const rig = await startFreshApp({ prefix: 'hmp-authz-e4-' });
    const world = await seedWorld(rig);
    const session = seedReadySession(world, 'playing', { ticket: {} });
    expect(session.ticket).not.toBeNull();
    expireTicketRow(session.ticket?.ticketId ?? '');
    expectStableProblem(
      await getStream(rig.app, cookieOf(world), streamUrl(session, session.ticket?.token ?? '')),
      401,
      ProblemCode.PLAYBACK_TICKET_EXPIRED,
    );
  });

  it('篡改票(单字符)→ 401 PLAYBACK_TICKET_INVALID(hash 查找不命中)', async () => {
    const rig = await startFreshApp({ prefix: 'hmp-authz-e5-' });
    const world = await seedWorld(rig);
    const session = seedReadySession(world, 'playing', { ticket: {} });
    const token = session.ticket?.token ?? '';
    const lastChar = token.charAt(token.length - 1);
    const tampered = `${token.slice(0, -1)}${lastChar === 'A' ? 'B' : 'A'}`;
    expect(tampered).not.toBe(token);
    expectStableProblem(
      await getStream(rig.app, cookieOf(world), streamUrl(session, tampered)),
      401,
      ProblemCode.PLAYBACK_TICKET_INVALID,
    );
  });
});

/* ------------------------------------------------------------------ */
/* F 异步提交授权变化                                                    */
/* ------------------------------------------------------------------ */

describe('T035 异步提交授权变化(201 已接受不等于继续放行)', () => {
  it('resolve 接受(201)后立即撤销会话(logout)→ GET/renew → 401 SESSION_INVALID', async () => {
    const rig = await startFreshApp({ prefix: 'hmp-authz-f1-' });
    const world = await seedWorld(rig);
    const cookie = cookieOf(world);
    const resolved = await postResolve(rig.app, cookie, world.iptv.mediaId);
    expect(resolved.status).toBe(201);
    const sessionId = (resolved.body as Record<string, unknown>)['id'] as string;
    expect((await postLogout(rig.app, cookie)).status).toBe(204);
    expectStableProblem(await getSession(rig.app, cookie, sessionId), 401, ProblemCode.SESSION_INVALID);
    expectStableProblem(await postRenew(rig.app, cookie, sessionId, 1), 401, ProblemCode.SESSION_INVALID);
  });

  it('resolve 接受(201)后立即收紧策略(黑名单)→ GET/renew → 404 MEDIA_NOT_FOUND(不因请求已接受而放行)', async () => {
    const rig = await startFreshApp({ prefix: 'hmp-authz-f2-' });
    const world = await seedWorld(rig);
    const cookie = cookieOf(world);
    // US8:名单入口属设置边界 —— 先解锁(active 切至主档案),resolve 与收紧同落在主档案,
    // 避免收紧入口的解锁换档把旧上下文拒绝(PLAYBACK_NOT_FOUND)混入策略拒绝断言
    await unlockSettingsAsOwner(rig.app, world);
    const resolved = await postResolve(rig.app, cookie, world.iptv.mediaId);
    expect(resolved.status).toBe(201);
    const sessionId = (resolved.body as Record<string, unknown>)['id'] as string;
    await blockMediaViaLists(rig.app, cookie, world, world.profileWithPinId, world.iptv.mediaId);
    expectStableProblem(await getSession(rig.app, cookie, sessionId), 404, ProblemCode.MEDIA_NOT_FOUND);
    expectStableProblem(await postRenew(rig.app, cookie, sessionId, 1), 404, ProblemCode.MEDIA_NOT_FOUND);
    // 异步窗口内未签出任何票
    expect(ticketCountOf(sessionId)).toBe(0);
  });

  it('probe 进行中(preparing)档案切换 → 原会话 GET/renew 稳定拒绝(005 更新:换档同事务终态化旧上下文播放并撤票 → 404 同形)', async () => {
    const rig = await startFreshApp({ prefix: 'hmp-authz-f3-' });
    const world = await seedWorld(rig);
    const cookie = cookieOf(world);
    const resolved = await postResolve(rig.app, cookie, world.iptv.mediaId);
    expect(resolved.status).toBe(201);
    const sessionId = (resolved.body as Record<string, unknown>)['id'] as string;
    // 切换到有 PIN 档案(unlock → select 既有路径);原会话仍绑定无 PIN 默认档案。
    // 005 contracts/api.md §5:「实际换档事务终态化旧上下文播放并撤票,A→B→A 不能复活」;
    // 据此旧会话在换档事务内被标 interrupted,GET/renew 与「不存在」404 同形
    // (取代 004 时代的 403 ACTIVE_PROFILE_REQUIRED 读面;拒绝语义不变,同形更强)。
    expect((await postUnlockPin(rig.app, cookie, world.profileWithPinId, world.pin)).status).toBe(200);
    expect((await postSelectProfile(rig.app, cookie, world.profileWithPinId)).status).toBe(200);
    expectStableProblem(await getSession(rig.app, cookie, sessionId), 404, ProblemCode.PLAYBACK_NOT_FOUND);
    expectStableProblem(await postRenew(rig.app, cookie, sessionId, 1), 404, ProblemCode.PLAYBACK_NOT_FOUND);
    // 终态化与撤票发生在换档事务内(不依赖前端 stop)
    const row = sessionRowOf(sessionId);
    expect(row.state).toBe('interrupted');
    expect(row.endedAt).not.toBeNull();
  });
});

/* ------------------------------------------------------------------ */
/* G 幂等与同形                                                         */
/* ------------------------------------------------------------------ */

describe('T035 幂等与同形(存在性不可区分;归属不因幂等放开)', () => {
  it('同形 404:策略拒绝的存在媒体 vs 不存在媒体、跨家庭真实 session vs 随机 id —— 码与体结构逐字段一致', async () => {
    const rig = await startFreshApp({ prefix: 'hmp-authz-g1-' });
    const world = await seedWorld(rig, { username: 'shape-owner' });
    const other = await seedOtherHousehold(rig, world.householdId.slice(0, 8));
    const cookie = cookieOf(world);
    // US8:名单入口属设置边界 —— 先解锁(active 切至主档案),策略拒绝断言落在主档案
    await unlockSettingsAsOwner(rig.app, world);
    const session = seedReadySession(world, 'ready');

    expect((await postResolve(rig.app, cookie, world.iptv.mediaId)).status).toBe(201);
    await blockMediaViaLists(rig.app, cookie, world, world.profileWithPinId, world.iptv.mediaId);
    const blocked = await postResolve(rig.app, cookie, world.iptv.mediaId);
    const missingMedia = await postResolve(rig.app, cookie, randomUUID());
    expectStableProblem(blocked, 404, ProblemCode.MEDIA_NOT_FOUND);
    expectSameProblemShape(blocked, missingMedia);

    const crossSession = await getSession(rig.app, cookieOf(other), session.sessionId);
    const randomSession = await getSession(rig.app, cookieOf(other), randomUUID());
    expectStableProblem(crossSession, 404, ProblemCode.PLAYBACK_NOT_FOUND);
    expectSameProblemShape(crossSession, randomSession);
  });

  it('stop/GET 幂等不放开目标归属:跨设备 stop 404;原设备 stop 幂等 204;GET 终态可见;签票拒 409 PLAYBACK_ENDED', async () => {
    const rig = await startFreshApp({ prefix: 'hmp-authz-g2-' });
    const world = await seedWorld(rig, { username: 'idem-owner' });
    const cookie = cookieOf(world);
    const session = seedReadySession(world, 'ready');
    const secondDeviceCookie = await loginSecondDevice(rig.app, world);

    // 跨设备 stop → 404(幂等性不放开归属),原会话原样
    expectStableProblem(await postStop(rig.app, secondDeviceCookie, session.sessionId), 404, ProblemCode.PLAYBACK_NOT_FOUND);
    expect(sessionRowOf(session.sessionId).state).toBe('ready');
    expect(sessionRowOf(session.sessionId).endedAt).toBeNull();

    // 原设备 stop 幂等:两次均 204
    expect((await postStop(rig.app, cookie, session.sessionId)).status).toBe(204);
    expect((await postStop(rig.app, cookie, session.sessionId)).status).toBe(204);

    // GET 终态可见(原设备),但签票拒:终态不可签票/复活
    const terminalView = await getSession(rig.app, cookie, session.sessionId);
    expect(terminalView.status).toBe(200);
    expect((terminalView.body as Record<string, unknown>)['state']).toBe('ended');
    expectStableProblem(await postRenew(rig.app, cookie, session.sessionId, 1), 409, ProblemCode.PLAYBACK_ENDED);
    expect(ticketCountOf(session.sessionId)).toBe(0);
  });
});

/* ------------------------------------------------------------------ */
/* T040 安全矩阵:终态票拒绝 / 枚举防护 / 泄漏扫描                        */
/* ------------------------------------------------------------------ */

/**
 * T040(004-playback-resolver):枚举/泄漏扫描 + 终态票拒绝修复矩阵。
 *
 * 权威依据:
 * - docs/specs/004-playback-resolver/data-model.md「## playback_ticket」节末
 *   「终态票拒绝」:会话被生命周期回收(ended/failed/interrupted)后,回收前签出的
 *   未撤销未过期票不得继续取流(playback-ticket.service validateStreamTicket 终态门);
 * - data-model「## playback_session」:任一活动态→终态,终态不可复活;跨家庭/非本设备
 *   统一 404 同形口径(T037 裁决)不因终态/幂等放开;
 * - contracts/api.md「稳定错误」:401 PLAYBACK_TICKET_INVALID / PLAYBACK_TICKET_EXPIRED、
 *   404 PLAYBACK_NOT_FOUND 同形;问题体为 RFC 9457 problem+json(R6:不携带源路径/
 *   上游诊断/stderr)。
 *
 * 覆盖(全部为新增 it,不改既有 28 用例):
 * 1. 回收后旧票取流:ready/playing 会话 renew 取真实票 URL → 回收(stop 204 落 ended;
 *    DB 直标 interrupted 代表 lifecycle 45 秒失联产物——e2e 无注入时钟,直改已注明)
 *    → 同一旧票 URL GET → 401 PLAYBACK_TICKET_INVALID;
 * 2. 跨家庭枚举防护:GET/stop/媒体对「本家庭真实 id/跨家庭真实 id/随机 id」三类目标,
 *    负向两类的 404 响应体逐字段一致(timing 侧信道不在 HTTP 契约层证据范围,以体同形为准);
 * 3. nonce/票枚举:伪造 200 个随机 ticket 值 → 全 401 同形(无有效票命中,不产生票行);
 * 4. 泄漏扫描(HTTP 面聚合):对矩阵全部捕获响应的体/头断言——不含 NAS 绝对路径片段
 *    (种子目录名/文件名)、不含上游 http(s):// 主机(problem type 固定基址除外)、
 *    不含 ticket 明文(playbackUrl 为合法响应字段,扫描时排除)、不含 ffmpeg/stderr 字样;
 *    日志面:测试进程 stderr 断言不可行,改为 DomainError.message 与
 *    ProblemJsonFilter 渲染样本的单元级抽查。
 */

/* ---------- 泄漏扫描采集面(模块级,随本 describe 生命周期) ---------- */

/** 单条捕获响应:体/头文本化(playbackUrl 合法字段已在扫描文本中排除) */
interface CapturedMatrixResponse {
  readonly label: string;
  readonly status: number;
  readonly bodyScanText: string;
  readonly headersText: string;
}

const capturedMatrixResponses: CapturedMatrixResponse[] = [];
/** 出现过的票明文(聚合扫描:任何响应体/头不得复现) */
const matrixTicketTokens: string[] = [];
/** 种子源位置指纹(NAS 临时根绝对路径/目录名/相对路径/文件名) */
const matrixPathProbes: string[] = [];

function recordMatrixResponse(label: string, res: request.Response): void {
  const raw: unknown = Buffer.isBuffer(res.body) ? `<binary ${String(res.body.length)} bytes>` : res.body;
  let scanText = JSON.stringify(raw) ?? String(raw);
  // playbackUrl 本身含 ticket 是合法响应字段(renew TicketReply):排除该字段后扫描票明文
  if (raw !== null && typeof raw === 'object' && !Array.isArray(raw) && 'playbackUrl' in raw) {
    const rest: Record<string, unknown> = { ...(raw as Record<string, unknown>) };
    delete rest.playbackUrl;
    scanText = JSON.stringify(rest) ?? '';
  }
  capturedMatrixResponses.push({
    label,
    status: res.status,
    bodyScanText: scanText,
    headersText: JSON.stringify(res.headers) ?? '',
  });
}

function recordMatrixTicket(token: string): void {
  if (token !== '') {
    matrixTicketTokens.push(token);
  }
}

/** 聚合泄漏断言:文本不含位置指纹、非 problem-type 固定基址的绝对 URL、票明文、ffmpeg/stderr 字样 */
function expectMatrixLeakFree(text: string, where: string): void {
  for (const probe of matrixPathProbes) {
    expect(text, `${where} 泄漏位置指纹:${probe}`).not.toContain(probe);
  }
  // 上游 http(s) 主机:响应中唯一合法绝对 URL 是 problem type 固定基址 homemedia.local
  expect(text, `${where} 泄漏上游 http(s) 主机`).not.toMatch(/https?:\/\/(?!homemedia\.local)/);
  for (const token of matrixTicketTokens) {
    expect(text, `${where} 泄漏票明文`).not.toContain(token);
  }
  expect(text, `${where} 出现 ffmpeg/stderr 关键词`).not.toMatch(/ffmpeg|stderr/i);
}

/* ---------- T040 专用助手(不改既有助手) ---------- */

/** ProblemJsonFilter 渲染样本的响应 sink(记录 status/header/json 体) */
interface FilterSink {
  headersSent: boolean;
  statusCode: number;
  headers: Record<string, unknown>;
  body: unknown;
  status(code: number): FilterSink;
  setHeader(name: string, value: unknown): void;
  json(payload: unknown): FilterSink;
}

function filterResponseSink(headersSent = false): FilterSink {
  return {
    headersSent,
    statusCode: 0,
    headers: {},
    body: undefined,
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    setHeader(name: string, value: unknown) {
      this.headers[String(name)] = value;
    },
    json(payload: unknown) {
      this.body = payload;
      return this;
    },
  };
}

function fakeFilterHost(sink: FilterSink): ArgumentsHost {
  return {
    switchToHttp: () => ({ getResponse: () => sink, getRequest: () => ({}) }),
  } as unknown as ArgumentsHost;
}

/** DB 直改:会话标 interrupted(lifecycle「45 秒失联回收」的库内终态等价;e2e 无注入时钟) */
function markSessionInterrupted(sessionId: string): void {
  getDb()
    .update(playbackSession)
    .set({ state: 'interrupted', endedAt: freshNow() })
    .where(eq(playbackSession.id, sessionId))
    .run();
}

/**
 * T040 直接播放世界(setupDirectWorld 同款模式 + 返回临时 NAS 根供泄漏扫描指纹登记;
 * 可选预置夹具票)。临时目录仍挂 tempDirs 由既有 afterEach 清理。
 */
async function setupMatrixDirectWorld(
  prefix: string,
  options: { ticket?: { generation?: number } } = {},
): Promise<{
  rig: TestRig;
  world: SeededWorld;
  cookie: string;
  session: PlaybackSessionFixture;
}> {
  const nasRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'hmp-authz-t040-'));
  tempDirs.push(nasRoot);
  fs.mkdirSync(path.join(nasRoot, 'media'), { recursive: true });
  fs.writeFileSync(path.join(nasRoot, MOVIE_REL_PATH), Buffer.alloc(65536, 0x5a));
  const rig = await startFreshApp({ prefix, env: { MEDIA_ROOTS: `${NAS_ROOT_KEY}=${nasRoot}` } });
  const world = await seedWorld(rig, { nasEnabled: true });
  getDb()
    .update(playbackSource)
    .set({ location: `${NAS_ROOT_KEY}/${MOVIE_REL_PATH}`, mimeType: null })
    .where(eq(playbackSource.id, world.nas.playbackSourceId))
    .run();
  const session = seedPlaybackSession(world, {
    state: 'playing',
    delivery: 'direct',
    playbackSourceId: world.nas.playbackSourceId,
    at: freshNow(),
    ...options,
  });
  // 泄漏扫描指纹:种子源绝对路径的根/目录名/相对路径/文件名
  matrixPathProbes.push(nasRoot, path.basename(nasRoot), MOVIE_REL_PATH, path.basename(MOVIE_REL_PATH));
  if (session.ticket !== null) {
    recordMatrixTicket(session.ticket.token);
  }
  return { rig, world, cookie: cookieOf(world), session };
}

/** renew 取真实票并登记采集(renew 响应体 playbackUrl 合法含票,票明文扫描时排除该字段) */
async function matrixRenew(
  rig: TestRig,
  cookie: string,
  session: PlaybackSessionFixture,
  label: string,
): Promise<{ url: string; ticket: string; generation: number }> {
  const res = await postRenew(rig.app, cookie, session.sessionId, session.generation);
  expect(res.status, 'renew 应 200 TicketReply(ready/playing 会话)').toBe(200);
  recordMatrixResponse(label, res);
  const body = res.body as Record<string, unknown>;
  const url = String(body['playbackUrl']);
  expect(url.startsWith('/api/playback/stream/')).toBe(true);
  const parsed = new URL(url, 'https://entry.invalid');
  const ticket = parsed.searchParams.get('ticket');
  expect(ticket, 'playbackUrl 必须携带 ticket query').toBeTruthy();
  recordMatrixTicket(ticket ?? '');
  return { url, ticket: ticket ?? '', generation: Number(body['generation']) };
}

describe('T040 安全矩阵(回收后旧票拒绝/枚举防护/泄漏扫描)', () => {
  it('回收后旧票取流 · stop 落 ended:renew 取票基线 200 → stop 204 → 同一旧票 URL → 401 PLAYBACK_TICKET_INVALID(终态票拒绝);终态不放开归属:跨设备 GET 同 id 仍 404 同形', async () => {
    const { rig, world, cookie, session } = await setupMatrixDirectWorld('hmp-authz-t40a-', { ticket: {} });
    const asset = await matrixRenew(rig, cookie, session, 't40a renew(回收前)');

    // 回收前基线:真实直读交付 200(video/mp4)
    const baseline = await getStream(rig.app, cookie, asset.url);
    recordMatrixResponse('t40a 回收前基线 200', baseline);
    expect(baseline.status).toBe(200);
    expect(String(baseline.headers['content-type'])).toContain('video/mp4');

    // stop 204(→ ended 终态;stop 是优雅回收的 HTTP 权威路径)
    expect((await postStop(rig.app, cookie, session.sessionId)).status).toBe(204);
    expect(sessionRowOf(session.sessionId).state).toBe('ended');

    // 终态可见(原设备 GET 200,票字段恒空)——G2 已断言 renew 409,此处为归属对照面
    const terminalGet = await getSession(rig.app, cookie, session.sessionId);
    recordMatrixResponse('t40a 终态 GET 200', terminalGet);
    expect(terminalGet.status).toBe(200);
    expect((terminalGet.body as Record<string, unknown>)['state']).toBe('ended');

    // 旧票 URL GET:终态票拒绝(data-model「终态票拒绝」)→ 401 PLAYBACK_TICKET_INVALID
    const stale = await getStream(rig.app, cookie, asset.url);
    recordMatrixResponse('t40a 终态旧票 401', stale);
    expectStableProblem(stale, 401, ProblemCode.PLAYBACK_TICKET_INVALID);

    // 终态不放开控制面归属(G2 增补):同账号新登录的第二台设备 GET 同 id 仍 404,与随机 id 同形
    const secondDevice = await loginSecondDevice(rig.app, world);
    const crossGet = await getSession(rig.app, secondDevice, session.sessionId);
    recordMatrixResponse('t40a 终态跨设备 GET 404', crossGet);
    const randomGet = await getSession(rig.app, secondDevice, randomUUID());
    recordMatrixResponse('t40a 终态随机 id GET 404', randomGet);
    expectStableProblem(crossGet, 404, ProblemCode.PLAYBACK_NOT_FOUND);
    expectSameProblemShape(crossGet, randomGet);
  });

  it('回收后旧票取流 · lifecycle 失联回收(e2e 无注入时钟,DB 直标 interrupted 代表 45 秒失联产物,直改已注明):基线 200 → 直标 → 旧票 URL → 401 PLAYBACK_TICKET_INVALID', async () => {
    const { rig, cookie, session } = await setupMatrixDirectWorld('hmp-authz-t40b-');
    const asset = await matrixRenew(rig, cookie, session, 't40b renew(回收前)');

    const baseline = await getStream(rig.app, cookie, asset.url);
    recordMatrixResponse('t40b 回收前基线 200', baseline);
    expect(baseline.status).toBe(200);

    // DB 直改注明:lifecycle.spec 已验证 45 秒失联 → interrupted(该路径需注入时钟,
    // e2e 不可行);此处以库内等价终态代表回收产物(state+ended_at 同改,满足 CHECK;
    // interrupted 属系统回收,failure_code 保持空)
    markSessionInterrupted(session.sessionId);
    const row = sessionRowOf(session.sessionId);
    expect(row.state).toBe('interrupted');
    expect(row.failureCode).toBeNull();
    expect(row.endedAt).not.toBeNull();

    const stale = await getStream(rig.app, cookie, asset.url);
    recordMatrixResponse('t40b interrupted 旧票 401', stale);
    expectStableProblem(stale, 401, ProblemCode.PLAYBACK_TICKET_INVALID);
  });

  it('跨家庭枚举防护:GET/stop/媒体对「本家庭真实 id/跨家庭真实 id/随机 id」——负向两类 404 体逐字段一致,本家庭合法放行(timing 侧信道不在本层证据范围,以响应体同形为准)', async () => {
    const { rig, cookie, session } = await setupMatrixDirectWorld('hmp-authz-t40c-', { ticket: {} });
    const other = await seedWorld(rig, { householdName: 't40c-乙家庭', username: 'player-b-t40c' });
    const otherCookie = cookieOf(other);
    const url = streamUrl(session, session.ticket?.token ?? '');
    const randomId = randomUUID();

    // GET:本家庭 200;跨家庭真实 id 与随机 id 404 同形(逐字段一致)
    const ownGet = await getSession(rig.app, cookie, session.sessionId);
    recordMatrixResponse('t40c GET 本家庭 200', ownGet);
    expect(ownGet.status).toBe(200);
    const crossGet = await getSession(rig.app, otherCookie, session.sessionId);
    recordMatrixResponse('t40c GET 跨家庭 404', crossGet);
    const randomGet = await getSession(rig.app, otherCookie, randomId);
    recordMatrixResponse('t40c GET 随机 404', randomGet);
    expectStableProblem(crossGet, 404, ProblemCode.PLAYBACK_NOT_FOUND);
    expectSameProblemShape(crossGet, randomGet);

    // stop:跨家庭/随机 404 同形,越权 stop 不生效(归属不因幂等/终态放开)
    const crossStop = await postStop(rig.app, otherCookie, session.sessionId);
    recordMatrixResponse('t40c stop 跨家庭 404', crossStop);
    const randomStop = await postStop(rig.app, otherCookie, randomId);
    recordMatrixResponse('t40c stop 随机 404', randomStop);
    expectStableProblem(crossStop, 404, ProblemCode.PLAYBACK_NOT_FOUND);
    expectSameProblemShape(crossStop, randomStop);
    expect(sessionRowOf(session.sessionId).state, '越权 stop 未生效').toBe('playing');

    // 媒体:本家庭 200 交付;跨家庭设备持同票 → 404(与 GET 404 同体);随机 id + 同票
    // → 401(票-session 绑定先行:该差异点要求先持有该 session 的 256bit 有效票,
    // 不构成归属可辨识面;控制面 404 同形已覆盖枚举防护)
    const ownMedia = await getStream(rig.app, cookie, url);
    recordMatrixResponse('t40c 媒体 本家庭 200', ownMedia);
    expect(ownMedia.status).toBe(200);
    const crossMedia = await getStream(rig.app, otherCookie, url);
    recordMatrixResponse('t40c 媒体 跨家庭 404', crossMedia);
    expectStableProblem(crossMedia, 404, ProblemCode.PLAYBACK_NOT_FOUND);
    expectSameProblemShape(crossMedia, crossGet);
    const randomMedia = await getStream(
      rig.app,
      cookie,
      streamUrl({ ...session, sessionId: randomId }, session.ticket?.token ?? ''),
    );
    recordMatrixResponse('t40c 媒体 随机 401', randomMedia);
    expectStableProblem(randomMedia, 401, ProblemCode.PLAYBACK_TICKET_INVALID);
  });

  it('nonce/票枚举:伪造 200 个随机 ticket 值对媒体端点 → 全 401 同形(无有效票命中,响应体逐字段一致,不产生票行)', async () => {
    const rig = await startFreshApp({ prefix: 'hmp-authz-t40d-' });
    const world = await seedWorld(rig);
    const session = seedReadySession(world, 'playing', { ticket: {} });
    recordMatrixTicket(session.ticket?.token ?? '');

    let first: request.Response | undefined;
    for (let i = 0; i < 200; i += 1) {
      const forged = randomBytes(32).toString('base64url');
      expect(forged, '伪造值不得与真实票重合').not.toBe(session.ticket?.token);
      const res = await getStream(rig.app, cookieOf(world), streamUrl(session, forged));
      recordMatrixResponse(`t40d 伪造票 401 #${i}`, res);
      expectStableProblem(res, 401, ProblemCode.PLAYBACK_TICKET_INVALID);
      if (first === undefined) {
        first = res;
      } else {
        expectSameProblemShape(res, first);
      }
    }
    expect(first).toBeDefined();
    expect(ticketCountOf(session.sessionId), '枚举探测不产生票行').toBe(1);
  });

  it('T040 泄漏扫描(HTTP 面聚合):矩阵全部捕获响应的体/头不含 NAS 绝对路径片段、上游 http(s) 主机、票明文(排除 playbackUrl 合法字段)、ffmpeg/stderr 字样', async () => {
    expect(capturedMatrixResponses.length, '矩阵采集面不得为空(前置用例必须先跑)').toBeGreaterThanOrEqual(20);
    for (const entry of capturedMatrixResponses) {
      expectMatrixLeakFree(`${entry.bodyScanText}\n${entry.headersText}`, `${entry.label}(status ${entry.status})`);
    }
  });

  it('T040 泄漏扫描(日志面抽查):矩阵稳定码的 DomainError.message 与 ProblemJsonFilter 渲染样本不含票明文/位置指纹/上游主机/ffmpeg·stderr;流后边界不写体不抛错', async () => {
    // 测试进程 stderr 断言不可行(日志面),以 DomainError message(日志原文)与
    // filter 渲染样本(problem+json 响应面)为安全日志路径的单元级抽查
    const filter = new ProblemJsonFilter();
    const codes = [
      'PLAYBACK_TICKET_INVALID',
      'PLAYBACK_TICKET_EXPIRED',
      'PLAYBACK_NOT_FOUND',
      'MEDIA_NOT_FOUND',
      'PLAYBACK_ENDED',
    ] as const;
    for (const code of codes) {
      const err = createDomainError(code);
      // DomainError.message(将进日志的原文)= 注册表静态脱敏文案
      expect(err.message, code).toBe(err.detail);
      expectMatrixLeakFree(err.message, `DomainError message ${code}`);
      // filter 渲染样本:status/code 正确,体+头聚合无泄漏
      const sink = filterResponseSink();
      expect(() => filter.catch(err, fakeFilterHost(sink)), code).not.toThrow();
      expect(sink.statusCode, code).toBe(err.status);
      expect((sink.body as { code?: string } | undefined)?.code, code).toBe(code);
      expectMatrixLeakFree(`${JSON.stringify(sink.body)}\n${JSON.stringify(sink.headers)}`, `filter 渲染 ${code}`);
    }
    // 流后边界(headersSent):安全日志路径不写状态/头/体(不向字节流注入 JSON),
    // 原文诊断只收敛为 safeSummary 稳定码摘要
    const afterStream = filterResponseSink(true);
    expect(() =>
      filter.catch(createDomainError('PLAYBACK_TICKET_INVALID'), fakeFilterHost(afterStream)),
    ).not.toThrow();
    expect(afterStream.statusCode, '流后边界不得改写状态').toBe(0);
    expect(afterStream.body, '流后边界不得注入 JSON 体').toBeUndefined();
    expect(Object.keys(afterStream.headers), '流后边界不得追加响应头').toEqual([]);
  });
});
