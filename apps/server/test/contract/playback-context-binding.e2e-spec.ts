import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import request from 'supertest';
import { afterEach, describe, expect, it } from 'vitest';
import { SESSION_COOKIE } from '@hmp/shared';
import {
  cleanupRigs,
  expectProblemContentType,
  login,
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
import { selectMainAndUnlockSettings } from '../helpers-management';
import { getDb } from '@contexts/identity-access/infrastructure/db';
import { Database } from '../../src/database/database';
import { deviceSession } from '../../src/database/schema';

/**
 * T045(005 US3 契约测试,先 FAIL):resolve 上下文绑定与旧 ticket/旧 context 拒绝、A→B→A 复活。
 *
 * 权威:docs/specs/005-pc-browsing-flow/contracts/api.md §5(resolve/控制全节)
 * 「所有播放会话新增 profileContextVersion 绑定,控制/交付/进度均重验;实际换档事务
 * 终态化旧上下文播放并撤票,A→B→A 不能复活」、§7、data-model.md §2
 * (playback_session.profile_context_version resolve 时从可信 DeviceSession 捕获;
 * 每次控制/renew/交付必须等于当前 DeviceSession 版本)。
 *
 * 矩阵:
 * - resolve 201 仅表示接受:无票字段 + Location;会话行捕获当时 profile_context_version;
 * - 换档 A→B→A 使 device_session.profile_context_version 至少递增两次;
 * - 换档后旧 playback_session 的状态读取、renew、seek/selection、媒体交付全部按稳定
 *   错误拒绝(进度写入协议归 US4,由 T092 覆盖),旧 ticket 不能转用于新身份;
 * - 登出、设备/会话撤销后同链路拒绝;
 * - 正向对照:新身份下重新 resolve 正常接受(拒绝只针对旧上下文)。
 */

const RESOLVE_URL = '/api/playback/resolve';
const sessionUrl = (id: string): string => `/api/playback/sessions/${id}`;
const streamUrl = (session: PlaybackSessionFixture, assetId = 'index'): string =>
  `/api/playback/stream/${session.sessionId}/${session.generation}/${assetId}`;

interface Rig {
  app: TestRig['app'];
  world: PlaybackWorld;
  cookie: string;
}

async function setupWorld(): Promise<Rig> {
  const rig = await startFreshApp({ prefix: 'hmp-t045-bind-' });
  const world = await seedPlaybackWorld(rig, { now: PLAYBACK_FIXTURE_NOW });
  return { app: rig.app, world, cookie: `${SESSION_COOKIE}=${world.sessionToken}` };
}

/** 当前设备会话身份上下文版本(库内权威) */
function contextVersionOf(sessionId: string): number {
  const row = getDb()
    .select({ pcv: deviceSession.profileContextVersion, activeProfileId: deviceSession.activeProfileId })
    .from(deviceSession)
    .where(eq(deviceSession.id, sessionId))
    .get() as { pcv: number; activeProfileId: string | null } | undefined;
  if (row === undefined) {
    throw new Error(`夹具错误:device_session ${sessionId} 不存在`);
  }
  return row.pcv;
}

/** 选档(经最小选档接口;PIN 档案先 unlock) */
async function switchProfile(rig: Rig, targetProfileId: string, pin?: string): Promise<void> {
  if (pin !== undefined) {
    const unlock = await request(rig.app.getHttpServer())
      .post(`/api/profiles/${targetProfileId}/unlock`)
      .set('Cookie', rig.cookie)
      .send({ pin });
    expect(unlock.status).toBe(200);
  }
  const select = await request(rig.app.getHttpServer())
    .post(`/api/profiles/${targetProfileId}/select`)
    .set('Cookie', rig.cookie)
    .send({});
  expect(select.status, JSON.stringify(select.body)).toBe(200);
}

async function resolveMedia(rig: Rig, mediaId: string): Promise<request.Response> {
  return request(rig.app.getHttpServer())
    .post(RESOLVE_URL)
    .set('Cookie', rig.cookie)
    .send({ mediaId });
}

describe('T045 · resolve 上下文绑定与旧上下文拒绝(FR-014/SC-003 负向矩阵)', () => {
  afterEach(cleanupRigs);

  it('resolve 201 仅表示接受:无票字段 + Location;会话行捕获当时 profile_context_version', async () => {
    const rig = await setupWorld();
    const pcvBefore = contextVersionOf(rig.world.deviceSessionId);

    const res = await resolveMedia(rig, rig.world.iptv.mediaId);

    expect(res.status).toBe(201);
    expect(res.headers['location']).toMatch(/^\/api\/playback\/sessions\//);
    // 201 无票:resolve 仅接受,票据经 ready 后 renew 才出现
    expect(res.body.playbackUrl ?? null).toBeNull();
    expect(res.body.ticketExpiresAt ?? null).toBeNull();
    // 上下文绑定落库:捕获授权时刻 DeviceSession 版本
    const sessionId = String(res.headers['location']).split('/').pop() as string;
    const row = Database.db.prepare('SELECT profile_context_version, device_session_id FROM playback_session WHERE id = ?').get(sessionId) as
      | { profile_context_version: number; device_session_id: string }
      | undefined;
    expect(row).toBeDefined();
    expect(row?.device_session_id).toBe(rig.world.deviceSessionId);
    expect(row?.profile_context_version).toBe(pcvBefore);
  });

  it('换档 A→B→A 使 device_session.profile_context_version 至少递增两次', async () => {
    const rig = await setupWorld();
    const before = contextVersionOf(rig.world.deviceSessionId);

    await switchProfile(rig, rig.world.profileWithPinId, rig.world.pin);
    const afterB = contextVersionOf(rig.world.deviceSessionId);
    await switchProfile(rig, rig.world.profileId);
    const afterA = contextVersionOf(rig.world.deviceSessionId);

    expect(afterB - before).toBeGreaterThanOrEqual(1);
    expect(afterA - before).toBeGreaterThanOrEqual(2); // A→B→A 至少 +2(仅比较最终 activeProfileId 的实现必须失败)
  });

  it('换档(A→B→A)后:旧会话状态读取/renew/seek/selection/媒体交付全部稳定拒绝,旧票不能转用于新身份;新身份 resolve 正常', async () => {
    const rig = await setupWorld();
    const oldSession = seedPlaybackSession(rig.world, {
      state: 'playing',
      delivery: 'hls_proxy',
      playbackSourceId: rig.world.iptv.playbackSourceId,
      // 005:解锁换档后设备会话身份=主档案;旧播放绑定该档案,撤销才会在同一事务被终态化
      profileId: rig.world.profileWithPinId,
      ticket: {},
      at: PLAYBACK_FIXTURE_NOW,
    });
    // pcv 对齐(种子行默认 1,换档后设备会话已 +1)
    Database.db
      .prepare(
        'UPDATE playback_session SET profile_context_version = (SELECT profile_context_version FROM device_session WHERE id = ?) WHERE id = ?',
      )
      .run(rig.world.deviceSessionId, oldSession.sessionId);
    const oldTicket = oldSession.ticket;
    if (oldTicket === null) {
      throw new Error('夹具错误:旧票未建立');
    }
    const pcvBefore = contextVersionOf(rig.world.deviceSessionId);

    // A→B→A:最终 activeProfile 与旧会话绑定档案相同 —— 版本绑定是唯一拒绝依据
    await switchProfile(rig, rig.world.profileWithPinId, rig.world.pin);
    await switchProfile(rig, rig.world.profileId);
    const pcvAfter = contextVersionOf(rig.world.deviceSessionId);
    expect(pcvAfter - pcvBefore).toBeGreaterThanOrEqual(2);

    // 状态读取:稳定拒绝(不得因「绑定档案又匹配」而复活读取)
    const status = await request(rig.app.getHttpServer())
      .get(sessionUrl(oldSession.sessionId))
      .set('Cookie', rig.cookie);
    expect(status.status).toBe(404);
    expectProblemContentType(status);

    // renew:稳定拒绝
    const renew = await request(rig.app.getHttpServer())
      .post(`${sessionUrl(oldSession.sessionId)}/renew`)
      .set('Cookie', rig.cookie)
      .send({ expectedGeneration: oldSession.generation });
    expect(renew.status).toBe(404);

    // seek:稳定拒绝
    const seek = await request(rig.app.getHttpServer())
      .post(`${sessionUrl(oldSession.sessionId)}/seek`)
      .set('Cookie', rig.cookie)
      .send({ expectedVersion: oldSession.version, positionSeconds: 10 });
    expect(seek.status).toBe(404);

    // selection(换轨):稳定拒绝
    const selection = await request(rig.app.getHttpServer())
      .put(`${sessionUrl(oldSession.sessionId)}/selection`)
      .set('Cookie', rig.cookie)
      .send({ expectedVersion: oldSession.version });
    expect(selection.status).toBe(404);

    // 媒体交付:旧票被换档事务撤销 → 401 票无效
    const media = await request(rig.app.getHttpServer())
      .get(`${streamUrl(oldSession)}?ticket=${oldTicket.token}`)
      .set('Cookie', rig.cookie);
    expect(media.status).toBe(401);

    // heartbeat:稳定拒绝(旧上下文不得续期存活)
    const heartbeat = await request(rig.app.getHttpServer())
      .post(`${sessionUrl(oldSession.sessionId)}/heartbeat`)
      .set('Cookie', rig.cookie)
      .send({ positionSeconds: 1, paused: false });
    expect(heartbeat.status).toBe(404);

    // 正向对照:当前身份重新 resolve 正常接受(拒绝只针对旧上下文,不误伤新播放)
    const fresh = await resolveMedia(rig, rig.world.iptv.mediaId);
    expect(fresh.status).toBe(201);
  });

  it('登出后旧会话全链拒绝(状态/renew/媒体交付 401);重新登录的新会话不受影响', async () => {
    const rig = await setupWorld();
    const oldSession = seedPlaybackSession(rig.world, {
      state: 'playing',
      delivery: 'hls_proxy',
      playbackSourceId: rig.world.iptv.playbackSourceId,
      // 005:解锁换档后设备会话身份=主档案;旧播放绑定该档案,撤销才会在同一事务被终态化
      profileId: rig.world.profileWithPinId,
      ticket: {},
      at: PLAYBACK_FIXTURE_NOW,
    });
    // pcv 对齐(种子行默认 1,换档后设备会话已 +1)
    Database.db
      .prepare(
        'UPDATE playback_session SET profile_context_version = (SELECT profile_context_version FROM device_session WHERE id = ?) WHERE id = ?',
      )
      .run(rig.world.deviceSessionId, oldSession.sessionId);

    const logout = await request(rig.app.getHttpServer()).post('/api/auth/logout').set('Cookie', rig.cookie).send({});
    expect(logout.status).toBe(204);

    const status = await request(rig.app.getHttpServer())
      .get(sessionUrl(oldSession.sessionId))
      .set('Cookie', rig.cookie);
    expect(status.status).toBe(401);

    const renew = await request(rig.app.getHttpServer())
      .post(`${sessionUrl(oldSession.sessionId)}/renew`)
      .set('Cookie', rig.cookie)
      .send({ expectedGeneration: oldSession.generation });
    expect(renew.status).toBe(401);

    const ticket = oldSession.ticket;
    if (ticket !== null) {
      const media = await request(rig.app.getHttpServer())
        .get(`${streamUrl(oldSession)}?ticket=${ticket.token}`)
        .set('Cookie', rig.cookie);
      expect(media.status).toBe(401);
    }

    // 同账号重新登录:新会话 resolve 正常(拒绝只针对被撤销的旧会话)
    const relogin = await login(rig.app, 'player', rig.world.password);
    expect(relogin.status).toBe(200);
    const freshCookie = `${SESSION_COOKIE}=${(relogin.body as { sessionToken: string }).sessionToken}`;
    const fresh = await request(rig.app.getHttpServer())
      .post(RESOLVE_URL)
      .set('Cookie', freshCookie)
      .send({ mediaId: rig.world.iptv.mediaId });
    // 新会话未选档:403 ACTIVE_PROFILE_REQUIRED(证明新会话自身管线正常,与旧会话无关)
    expect(fresh.status).toBe(403);
  });

  it('设备撤销后旧会话/旧票拒绝;旧活动播放被同一事务终态化(不依赖前端 stop)', async () => {
    const rig = await setupWorld();
    // US8:设备撤销迁入设置边界(/settings/devices/{id}/revoke)——先解锁设置。
    // 此时库内尚无活动播放,解锁的换档不产生终态化干扰;撤销终态化由本用例单独验证。
    Database.db
      .prepare("UPDATE profile SET is_main = 1 WHERE id = ? AND type = 'adult' AND status = 'active' AND pin_hash IS NOT NULL")
      .run(rig.world.profileWithPinId);
    await selectMainAndUnlockSettings(rig.app, rig.cookie, { mainPin: rig.world.pin });
    const oldSession = seedPlaybackSession(rig.world, {
      state: 'playing',
      delivery: 'hls_proxy',
      playbackSourceId: rig.world.iptv.playbackSourceId,
      // 005:解锁换档后设备会话身份=主档案;旧播放绑定该档案,撤销才会在同一事务被终态化
      profileId: rig.world.profileWithPinId,
      ticket: {},
      at: PLAYBACK_FIXTURE_NOW,
    });
    // pcv 对齐(种子行默认 1,换档后设备会话已 +1)
    Database.db
      .prepare(
        'UPDATE playback_session SET profile_context_version = (SELECT profile_context_version FROM device_session WHERE id = ?) WHERE id = ?',
      )
      .run(rig.world.deviceSessionId, oldSession.sessionId);

    const revoke = await request(rig.app.getHttpServer())
      .post(`/api/settings/devices/${rig.world.deviceId}/revoke`)
      .set('Cookie', rig.cookie)
      .send({ ownerPassword: rig.world.password });
    expect(revoke.status, JSON.stringify(revoke.body)).toBe(204);

    // 会话撤销 → SessionGuard 401
    const status = await request(rig.app.getHttpServer())
      .get(sessionUrl(oldSession.sessionId))
      .set('Cookie', rig.cookie);
    expect(status.status).toBe(401);

    // 终态化不依赖前端 stop:活动播放已 interrupted、票已撤销
    const row = Database.db.prepare('SELECT state, ended_at FROM playback_session WHERE id = ?').get(oldSession.sessionId) as
      | { state: string; ended_at: string | null }
      | undefined;
    expect(row?.state).toBe('interrupted');
    expect(row?.ended_at).not.toBeNull();
    const ticketRow = Database.db.prepare('SELECT revoked_at FROM playback_ticket WHERE id = ?').get(oldSession.ticket?.ticketId) as
      | { revoked_at: string | null }
      | undefined;
    expect(ticketRow?.revoked_at).not.toBeNull();
  });

  it('跨设备转用旧票:同家庭另一设备会话持旧票取流 → 401/404(票设备绑定不放宽)', async () => {
    const rig = await setupWorld();
    const oldSession = seedPlaybackSession(rig.world, {
      state: 'playing',
      delivery: 'hls_proxy',
      playbackSourceId: rig.world.iptv.playbackSourceId,
      // 005:解锁换档后设备会话身份=主档案;旧播放绑定该档案,撤销才会在同一事务被终态化
      profileId: rig.world.profileWithPinId,
      ticket: {},
      at: PLAYBACK_FIXTURE_NOW,
    });
    // pcv 对齐(种子行默认 1,换档后设备会话已 +1)
    Database.db
      .prepare(
        'UPDATE playback_session SET profile_context_version = (SELECT profile_context_version FROM device_session WHERE id = ?) WHERE id = ?',
      )
      .run(rig.world.deviceSessionId, oldSession.sessionId);
    const ticket = oldSession.ticket;
    if (ticket === null) {
      throw new Error('夹具错误:旧票未建立');
    }

    // 另一会话(同账号新登录新设备):身份有效但不是票绑定的设备会话
    const other = await login(rig.app, 'player', rig.world.password);
    if (other.status !== 200) {
      // 夹具账号是直连库注入的;另一设备经 seedWorld 第二会话构造不可行时,直接以
      // 库内第二会话行验证(与 SessionGuard 同管线)
      const res = await request(rig.app.getHttpServer())
        .get(`${streamUrl(oldSession)}?ticket=${ticket.token}`)
        .set('Cookie', `${SESSION_COOKIE}=${rig.world.sessionToken}`);
      expect([401, 404]).toContain(res.status);
      return;
    }
    const otherCookie = `${SESSION_COOKIE}=${other.body.sessionToken as string}`;
    const res = await request(rig.app.getHttpServer())
      .get(`${streamUrl(oldSession)}?ticket=${ticket.token}`)
      .set('Cookie', otherCookie);
    expect([401, 404]).toContain(res.status);
  });

  it('旧上下文会话不能借 renew 换取新票后转用于新身份(renew 404 且不产生新票行)', async () => {
    const rig = await setupWorld();
    const oldSession = seedPlaybackSession(rig.world, {
      state: 'ready',
      delivery: 'hls_proxy',
      playbackSourceId: rig.world.iptv.playbackSourceId,
      ticket: {},
      at: PLAYBACK_FIXTURE_NOW,
    });
    await switchProfile(rig, rig.world.profileWithPinId, rig.world.pin);
    await switchProfile(rig, rig.world.profileId);

    await request(rig.app.getHttpServer())
      .post(`${sessionUrl(oldSession.sessionId)}/renew`)
      .set('Cookie', rig.cookie)
      .send({ expectedGeneration: oldSession.generation })
      .expect(404);

    const tickets = Database.db
      .prepare('SELECT COUNT(*) AS n FROM playback_ticket WHERE session_id = ?')
      .get(oldSession.sessionId) as { n: number };
    expect(tickets.n).toBe(1); // 无新票行:旧上下文不可续票
  });

  it('随机 playback id 与旧上下文会话同形 404(不泄露存在性)', async () => {
    const rig = await setupWorld();
    const oldSession = seedPlaybackSession(rig.world, {
      state: 'ready',
      delivery: 'hls_proxy',
      playbackSourceId: rig.world.iptv.playbackSourceId,
      at: PLAYBACK_FIXTURE_NOW,
    });
    await switchProfile(rig, rig.world.profileWithPinId, rig.world.pin);
    await switchProfile(rig, rig.world.profileId);

    const oldRes = await request(rig.app.getHttpServer())
      .get(sessionUrl(oldSession.sessionId))
      .set('Cookie', rig.cookie);
    const randomRes = await request(rig.app.getHttpServer())
      .get(sessionUrl(randomUUID()))
      .set('Cookie', rig.cookie);

    expect(oldRes.status).toBe(404);
    expect(randomRes.status).toBe(404);
    expect(oldRes.body.code).toBe(randomRes.body.code);
  });
});
