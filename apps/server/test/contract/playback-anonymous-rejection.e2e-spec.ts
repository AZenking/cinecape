import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import request from 'supertest';
import { afterEach, describe, expect, it } from 'vitest';
import { ProblemCode, SESSION_COOKIE } from '@hmp/shared';
import {
  cleanupRigs,
  expectProblemContentType,
  startFreshApp,
  type TestRig,
} from '../helpers';
import {
  PLAYBACK_FIXTURE_NOW,
  seedPlaybackSession,
  seedPlaybackWorld,
  type PlaybackSessionFixture,
  type PlaybackWorld,
} from '../fixtures/playback';
import { getDb } from '@contexts/identity-access/infrastructure/db';
import { deviceSession } from '../../src/database/schema';

/**
 * T044(005 US3 契约负向测试,先 FAIL):匿名与失效会话直接播放全链拒绝。
 *
 * 权威:docs/specs/005-pc-browsing-flow/contracts/api.md §1/§5/§7、spec.md FR-011
 * 「所有播放入口 MUST 共享登录、选档、服务端授权与播放结果的同一业务流程;
 * 游客直接调用播放、票据或媒体交付均被拒绝」。
 *
 * 矩阵:
 * - 无 cookie / 失效(过期、撤销)cookie → POST /playback/resolve 401 SESSION_INVALID;
 * - 有效会话但未选档 → 403 ACTIVE_PROFILE_REQUIRED;
 * - 携带或猜测旧 ticket 调状态/控制/媒体(含字幕、转换共用同一网关入口)端点 →
 *   无/失效会话 401;有效会话 + 无效票 401 PLAYBACK_TICKET_INVALID;
 *   有效会话 + 随机 playback id → 404 PLAYBACK_NOT_FOUND(播放 404 同形);
 * - 限频 429 保留(004 既有语义不回退);
 * - 全部错误响应不含策略细节、源位置、路径或票据字段。
 */

const RESOLVE_URL = '/api/playback/resolve';
const sessionUrl = (id: string): string => `/api/playback/sessions/${id}`;
const streamUrl = (world: PlaybackWorld, session: PlaybackSessionFixture, assetId = 'index'): string =>
  `/api/playback/stream/${session.sessionId}/${session.generation}/${assetId}`;

function cookieOf(world: PlaybackWorld): string {
  return `${SESSION_COOKIE}=${world.sessionToken}`;
}

function cookieOfValue(token: string): string {
  return `${SESSION_COOKIE}=${token}`;
}

/** 错误响应不含内部细节:源位置(host/路径)、票据、策略明细 */
function expectNoInternalLeak(res: request.Response): void {
  const bodyText = JSON.stringify(res.body ?? {});
  expect(bodyText).not.toContain('iptv.playback-fixture.test');
  expect(bodyText).not.toContain('/nas-media');
  expect(bodyText).not.toContain('ticket=');
  expect(bodyText).not.toContain('tokenHash');
  expect(bodyText).not.toContain('location');
  expect(bodyText).not.toContain('policy');
  expectProblemContentType(res);
}

function expectStableProblem(res: request.Response, status: number, code: ProblemCode): void {
  expect(res.status).toBe(status);
  expectProblemContentType(res);
  expect(res.body.code).toBe(code);
}

/** 清空设备会话当前档案(构造「已登录未选档」) */
function clearActiveProfile(sessionId: string): void {
  getDb().update(deviceSession).set({ activeProfileId: null }).where(eq(deviceSession.id, sessionId)).run();
}

async function setupWorld(options?: { nasEnabled?: boolean }): Promise<{ rig: TestRig; world: PlaybackWorld }> {
  const rig = await startFreshApp({ prefix: 'hmp-t044-anon-' });
  const world = await seedPlaybackWorld(rig, { now: PLAYBACK_FIXTURE_NOW, nasEnabled: options?.nasEnabled ?? true });
  return { rig, world };
}

describe('T044 · 匿名与失效会话播放全链拒绝(FR-011)', () => {
  afterEach(cleanupRigs);

  it('无 cookie 直接 POST /playback/resolve → 401 SESSION_INVALID,不建会话', async () => {
    const { rig, world } = await setupWorld();

    const res = await request(rig.app.getHttpServer()).post(RESOLVE_URL).send({ mediaId: world.iptv.mediaId });

    expectStableProblem(res, 401, ProblemCode.SESSION_INVALID);
    expectNoInternalLeak(res);
  });

  it('失效 cookie(撤销/过期)resolve → 401 SESSION_INVALID', async () => {
    const { rig, world } = await setupWorld();

    const revoked = await request(rig.app.getHttpServer())
      .post(RESOLVE_URL)
      .set('Cookie', cookieOf(world))
      .send({ mediaId: world.iptv.mediaId });
    expect(revoked.status).toBe(201); // 夹具自身有效(基线)

    const expiredAt = '2026-10-23T09:00:00.000Z'; // 晚于 PLAYBACK_FIXTURE_NOW,早于真实 now
    getDb()
      .update(deviceSession)
      .set({ expiresAt: expiredAt })
      .where(eq(deviceSession.id, world.deviceSessionId))
      .run();

    const res = await request(rig.app.getHttpServer())
      .post(RESOLVE_URL)
      .set('Cookie', cookieOf(world))
      .send({ mediaId: world.iptv.mediaId });

    expectStableProblem(res, 401, ProblemCode.SESSION_INVALID);
    expectNoInternalLeak(res);

    // 伪造 token(格式合法但无会话)同形 401
    const forged = await request(rig.app.getHttpServer())
      .post(RESOLVE_URL)
      .set('Cookie', cookieOfValue('forged-token-value'))
      .send({ mediaId: world.iptv.mediaId });
    expectStableProblem(forged, 401, ProblemCode.SESSION_INVALID);
  });

  it('有效会话但未选档 resolve → 403 ACTIVE_PROFILE_REQUIRED(授权拒绝不建会话)', async () => {
    const { rig, world } = await setupWorld();
    clearActiveProfile(world.deviceSessionId);

    const res = await request(rig.app.getHttpServer())
      .post(RESOLVE_URL)
      .set('Cookie', cookieOf(world))
      .send({ mediaId: world.iptv.mediaId });

    expectStableProblem(res, 403, ProblemCode.ACTIVE_PROFILE_REQUIRED);
    expectNoInternalLeak(res);
  });

  it('无/失效会话携带旧 ticket 调控制端点(状态/renew/heartbeat/stop/selection/seek)→ 401', async () => {
    const { rig, world } = await setupWorld();
    const seeded = seedPlaybackSession(world, { state: 'ready', at: PLAYBACK_FIXTURE_NOW });

    const noCookie = await request(rig.app.getHttpServer()).get(sessionUrl(seeded.sessionId));
    expectStableProblem(noCookie, 401, ProblemCode.SESSION_INVALID);

    const renew = await request(rig.app.getHttpServer())
      .post(`${sessionUrl(seeded.sessionId)}/renew`)
      .send({ expectedGeneration: 1 });
    expectStableProblem(renew, 401, ProblemCode.SESSION_INVALID);

    const heartbeat = await request(rig.app.getHttpServer())
      .post(`${sessionUrl(seeded.sessionId)}/heartbeat`)
      .send({ positionSeconds: 1, paused: false });
    expectStableProblem(heartbeat, 401, ProblemCode.SESSION_INVALID);

    const stop = await request(rig.app.getHttpServer()).post(`${sessionUrl(seeded.sessionId)}/stop`).send({});
    expectStableProblem(stop, 401, ProblemCode.SESSION_INVALID);

    const selection = await request(rig.app.getHttpServer())
      .put(`${sessionUrl(seeded.sessionId)}/selection`)
      .send({ expectedVersion: 1 });
    expectStableProblem(selection, 401, ProblemCode.SESSION_INVALID);

    const seek = await request(rig.app.getHttpServer())
      .post(`${sessionUrl(seeded.sessionId)}/seek`)
      .send({ expectedVersion: 1, positionSeconds: 5 });
    expectStableProblem(seek, 401, ProblemCode.SESSION_INVALID);
  });

  it('无/失效会话携带旧 ticket 请求媒体/字幕/转换交付端点 → 401;错误不含源位置与票据字段', async () => {
    const { rig, world } = await setupWorld();
    const seeded = seedPlaybackSession(world, {
      state: 'ready',
      delivery: 'hls_proxy',
      playbackSourceId: world.iptv.playbackSourceId,
      ticket: {},
      at: PLAYBACK_FIXTURE_NOW,
    });
    const ticket = seeded.ticket;
    if (ticket === null) {
      throw new Error('夹具错误:票未建立');
    }

    // 媒体入口(清单/直读共用的 stream 网关;字幕/转换分片同为该网关资产形态)
    const noCookie = await request(rig.app.getHttpServer()).get(
      `${streamUrl(world, seeded)}?ticket=${ticket.token}`,
    );
    expectStableProblem(noCookie, 401, ProblemCode.SESSION_INVALID);
    expectNoInternalLeak(noCookie);

    // 会话撤销后:同票同入口仍拒绝(SessionGate 先于票校验)
    getDb()
      .update(deviceSession)
      .set({ revokedAt: new Date().toISOString() })
      .where(eq(deviceSession.id, world.deviceSessionId))
      .run();
    const revoked = await request(rig.app.getHttpServer())
      .get(`${streamUrl(world, seeded)}?ticket=${ticket.token}`)
      .set('Cookie', cookieOf(world));
    expectStableProblem(revoked, 401, ProblemCode.SESSION_INVALID);

    // 字幕资产形态同网关:无会话同样 401(不泄露字幕词表)
    const subtitle = await request(rig.app.getHttpServer()).get(
      `${streamUrl(world, seeded, 'sub-1')}?ticket=${ticket.token}`,
    );
    expectStableProblem(subtitle, 401, ProblemCode.SESSION_INVALID);
  });

  it('有效会话 + 猜测/伪造 ticket → 401 PLAYBACK_TICKET_INVALID;有效会话 + 随机播放 id → 404 播放同形', async () => {
    const { rig, world } = await setupWorld();
    const seeded = seedPlaybackSession(world, { state: 'ready', ticket: {}, at: PLAYBACK_FIXTURE_NOW });
    const cookie = cookieOf(world);

    const guessed = await request(rig.app.getHttpServer())
      .get(`${streamUrl(world, seeded)}?ticket=${'g'.repeat(43)}`)
      .set('Cookie', cookie);
    expectStableProblem(guessed, 401, ProblemCode.PLAYBACK_TICKET_INVALID);
    expectNoInternalLeak(guessed);

    const randomId = randomUUID();
    const notFound = await request(rig.app.getHttpServer()).get(sessionUrl(randomId)).set('Cookie', cookie);
    expectStableProblem(notFound, 404, ProblemCode.PLAYBACK_NOT_FOUND);
    expectNoInternalLeak(notFound);
  });

  it('限频 429 保留:resolve×30 后第 31 个控制请求 → 429 + Retry-After(004 语义不回退)', async () => {
    const { rig, world } = await setupWorld();
    const cookie = cookieOf(world);

    for (let i = 0; i < 30; i += 1) {
      const res = await request(rig.app.getHttpServer())
        .post(RESOLVE_URL)
        .set('Cookie', cookie)
        .send({ mediaId: world.iptv.mediaId });
      expect(res.status).toBe(201);
    }
    const overflow = await request(rig.app.getHttpServer())
      .post(RESOLVE_URL)
      .set('Cookie', cookie)
      .send({ mediaId: world.iptv.mediaId });
    expectStableProblem(overflow, 429, ProblemCode.PLAYBACK_RATE_LIMITED);
    const retryAfter = Number(overflow.headers['retry-after']);
    expect(Number.isFinite(retryAfter)).toBe(true);
    expect(retryAfter).toBeGreaterThan(0);
  });

  it('resolve 未知字段(profileId/householdId/startPosition)一律 400,不能扩大权限', async () => {
    const { rig, world } = await setupWorld();
    const cookie = cookieOf(world);

    const forged = await request(rig.app.getHttpServer())
      .post(RESOLVE_URL)
      .set('Cookie', cookie)
      .send({ mediaId: world.iptv.mediaId, profileId: world.profileId, householdId: world.householdId, startPosition: 120 });
    expectStableProblem(forged, 400, ProblemCode.VALIDATION_FAILED);
    expectNoInternalLeak(forged);
  });

  it('游客不能借匿名请求读到播放状态或票据元数据(401 同形,无 playbackUrl)', async () => {
    const { rig, world } = await setupWorld();
    const seeded = seedPlaybackSession(world, { state: 'playing', ticket: {}, at: PLAYBACK_FIXTURE_NOW });

    const res = await request(rig.app.getHttpServer()).get(sessionUrl(seeded.sessionId));
    expectStableProblem(res, 401, ProblemCode.SESSION_INVALID);
    const bodyText = JSON.stringify(res.body ?? {});
    expect(bodyText).not.toContain('playbackUrl');
    expect(bodyText).not.toContain('ticketExpiresAt');
  });
});
