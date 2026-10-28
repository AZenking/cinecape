import 'reflect-metadata';
import { eq } from 'drizzle-orm';
import request from 'supertest';
import { afterEach, describe, expect, it } from 'vitest';
import { SESSION_COOKIE } from '@hmp/shared';
import { cleanupRigs, cookiePairOf, startFreshApp, type TestRig } from '../../helpers';
import {
  PLAYBACK_FIXTURE_NOW,
  seedPlaybackWorld,
  type PlaybackWorld,
} from '../../fixtures/playback';
import { getDb } from '@contexts/identity-access/infrastructure/db';
import { Database } from '../../../src/database/database';
import { selectMainAndUnlockSettings } from '../../helpers-management';
import { getConfig } from '../../../src/config/env';
import { createPlaybackBudgets } from '../../../src/config/playback-budgets';
import { hashToken } from '@contexts/identity-access/infrastructure/token.service';
import {
  deviceSession,
  playbackSession,
  playbackTicket,
  settingsAccessGrant,
} from '../../../src/database/schema';
import {
  clearDeviceSessionsProfile,
  switchDeviceSessionProfile,
} from '@contexts/profile/application/identity-transition';
import { PlaybackRepository } from '../../../src/modules/playback/playback.repository';
import { PlaybackAuthorizationService } from '../../../src/modules/playback/playback-authorization.service';
import {
  PlaybackResolverService,
  type PlaybackProbeOutcome,
} from '../../../src/modules/playback/playback-resolver.service';
import type { SessionContext } from '../../../src/common/current-session.decorator';

/**
 * T047(005 US3 单元测试,先 FAIL):身份变化事务终态化旧播放并撤票。
 *
 * 权威:docs/specs/005-pc-browsing-flow/data-model.md §2:
 * - device_session:「实际 activeProfile 改变、清空或失效回落时递增;A→B→A 至少递增两次。
 *   改变身份、撤销当前 settings grant、终态化该 DeviceSession 旧身份的活动 playback 及
 *   撤销对应票据在同一事务」;
 * - playback_session:「实际换档或失效回落事务将旧上下文活动播放标 ended/interrupted 并撤票,
 *   异步准备提交也复查该版本,避免 A→B→A 复活旧播放;不能仅依赖前端 stop」;
 * - profile:「PIN 更新…同事务清空所有当前选用该档案的设备会话 active_profile_id、递增
 *   profile_context_version、终态化相关活动播放并撤票,强制重新选档」。
 *
 * 矩阵(全部不依赖前端 stop):
 * 1. 换档(switchDeviceSessionProfile):同事务递增 pcv + 旧上下文活动播放 interrupted + 撤票
 *    + 撤销设置授予;A→B→A 至少两次;
 * 2. 清空/失效回落(clearDeviceSessionsProfile):同语义;
 * 3. 档案停用(API):pcv 递增 + 播放终态化 + 撤票(不只清 active_profile_id);
 * 4. PIN 变更(API):强制重新选档 —— 清身份 + pcv 递增 + 播放终态化 + 撤票 + pin_version 递增;
 * 5. 设备撤销(API):该设备全部会话的活动播放终态化 + 撤票;
 * 6. 异步准备提交复查:probe 窗口内 pcv 变化 → 提交被拒,不得复活旧上下文播放。
 */

interface Rig {
  rig: TestRig;
  world: PlaybackWorld;
  cookie: string;
}

async function setupWorld(options?: { nasEnabled?: boolean }): Promise<Rig> {
  const rig = await startFreshApp({ prefix: 'hmp-t047-identity-' });
  const world = await seedPlaybackWorld(rig, { now: PLAYBACK_FIXTURE_NOW, nasEnabled: options?.nasEnabled ?? true });
  return { rig, world, cookie: `${SESSION_COOKIE}=${world.sessionToken}` };
}

/**
 * US8 管理迁移夹具:把「有 PIN 成人档案」升格为主档案(库内直改,与 CHECK 一致),
 * 另建一个独立管理会话(登录→选主档案→设置 PIN 解锁);管理写经 /api/settings/*。
 */
async function setupManagementSession(rig: { app: TestRig['app'] }, world: PlaybackWorld): Promise<string> {
  Database.db
    .prepare("UPDATE profile SET is_main = 1 WHERE id = ? AND type = 'adult' AND status = 'active' AND pin_hash IS NOT NULL")
    .run(world.profileWithPinId);
  const login = await request(rig.app.getHttpServer())
    .post('/api/auth/login')
    .send({ username: 'player', password: world.password });
  expect(login.status).toBe(200);
  const cookie = cookiePairOf(login);
  await selectMainAndUnlockSettings(rig.app, cookie, { mainPin: world.pin, ownerPassword: world.password });
  return cookie;
}

function sessionRowOf(sessionId: string): typeof playbackSession.$inferSelect {
  const row = getDb().select().from(playbackSession).where(eq(playbackSession.id, sessionId)).get();
  if (row === undefined) {
    throw new Error(`夹具错误:playback_session ${sessionId} 不存在`);
  }
  return row;
}

function deviceSessionRowOf(sessionId: string): typeof deviceSession.$inferSelect {
  const row = getDb().select().from(deviceSession).where(eq(deviceSession.id, sessionId)).get();
  if (row === undefined) {
    throw new Error(`夹具错误:device_session ${sessionId} 不存在`);
  }
  return row;
}

/** 直插一行设置授予(撤销断言用;US7 建模,此处仅作挂钩核对面) */
function seedSettingsGrant(world: PlaybackWorld): void {
  const now = new Date().toISOString();
  getDb()
    .insert(settingsAccessGrant)
    .values({
      householdId: world.householdId,
      deviceSessionId: world.deviceSessionId,
      profileId: world.profileId,
      profileContextVersion: 1,
      pinVersion: 1,
      mainProfileVersion: 1,
      issuedAt: now,
      expiresAt: new Date(Date.parse(now) + 15 * 60_000).toISOString(),
      revokedAt: null,
    })
    .run();
}

describe('T047 · 身份变化事务终态化旧播放并撤票(FR-014)', () => {
  afterEach(cleanupRigs);

  it('换档(switchDeviceSessionProfile):同一事务递增 pcv、旧上下文播放 interrupted、撤票、撤销设置授予;A→B→A 至少两次', async () => {
    const { world } = await setupWorld();

    // 旧上下文活动播放 + 有效票 + 有效设置授予
    const sessionId = seedActiveSession(world);
    const ticketId = seedTicket(world, sessionId);
    seedSettingsGrant(world);
    const pcvBefore = deviceSessionRowOf(world.deviceSessionId).profileContextVersion;

    // A→B(同一事务挂钩)
    getDb().transaction((tx) => {
      switchDeviceSessionProfile(tx, {
        householdId: world.householdId,
        sessionId: world.deviceSessionId,
        fromProfileId: world.profileId,
        toProfileId: world.profileWithPinId,
      });
    });

    const afterB = deviceSessionRowOf(world.deviceSessionId);
    expect(afterB.activeProfileId).toBe(world.profileWithPinId);
    expect(afterB.profileContextVersion).toBe(pcvBefore + 1);
    let playback = sessionRowOf(sessionId);
    expect(playback.state).toBe('interrupted');
    expect(playback.endedAt).not.toBeNull();
    const ticket = getDb().select().from(playbackTicket).where(eq(playbackTicket.id, ticketId)).get();
    expect(ticket?.revokedAt).not.toBeNull();
    const grant = getDb()
      .select()
      .from(settingsAccessGrant)
      .where(
        eq(settingsAccessGrant.deviceSessionId, world.deviceSessionId),
      )
      .all();
    expect(grant.some((row) => row.revokedAt !== null)).toBe(true);

    // B→A:再次实际换档再递增(A→B→A 至少两次 —— 仅比较最终 activeProfileId 的实现必须失败)
    getDb().transaction((tx) => {
      switchDeviceSessionProfile(tx, {
        householdId: world.householdId,
        sessionId: world.deviceSessionId,
        fromProfileId: world.profileWithPinId,
        toProfileId: world.profileId,
      });
    });
    const afterA = deviceSessionRowOf(world.deviceSessionId);
    expect(afterA.activeProfileId).toBe(world.profileId);
    expect(afterA.profileContextVersion).toBe(pcvBefore + 2);
    // 旧播放保持终态,不因回到 A 复活
    playback = sessionRowOf(sessionId);
    expect(playback.state).toBe('interrupted');
  });

  it('清空/失效回落(clearDeviceSessionsProfile):同事务递增 pcv、终态化播放、撤票、撤授予', async () => {
    const { world } = await setupWorld();
    const sessionId = seedActiveSession(world);
    const ticketId = seedTicket(world, sessionId);
    const pcvBefore = deviceSessionRowOf(world.deviceSessionId).profileContextVersion;

    getDb().transaction((tx) => {
      clearDeviceSessionsProfile(tx, {
        householdId: world.householdId,
        deviceSessionIds: [world.deviceSessionId],
        profileId: world.profileId,
      });
    });

    const after = deviceSessionRowOf(world.deviceSessionId);
    expect(after.activeProfileId).toBeNull();
    expect(after.profileContextVersion).toBe(pcvBefore + 1);
    expect(sessionRowOf(sessionId).state).toBe('interrupted');
    const ticket = getDb().select().from(playbackTicket).where(eq(playbackTicket.id, ticketId)).get();
    expect(ticket?.revokedAt).not.toBeNull();
  });

  it('档案停用(API PATCH status=disabled):使用该档案的会话身份清空 + pcv 递增 + 播放 interrupted + 撤票(不只清 active_profile_id)', async () => {
    const { rig, world } = await setupWorld();
    const managementCookie = await setupManagementSession(rig, world);
    // 会话当前使用 A(world.profileId),旧上下文(A)活动播放即为本用例的核对面
    const sessionId = seedActiveSession(world);
    const ticketId = seedTicket(world, sessionId);
    const pcvBefore = deviceSessionRowOf(world.deviceSessionId).profileContextVersion;

    // 停用 A(US8:管理写迁 /api/settings/profiles,expectedVersion CAS + 当次密码)
    const disable = await request(rig.app.getHttpServer())
      .patch(`/api/settings/profiles/${world.profileId}`)
      .set('Cookie', managementCookie)
      .send({ status: 'disabled', clearPin: false, expectedVersion: 1, ownerPassword: world.password });
    expect(disable.status, JSON.stringify(disable.body)).toBe(200);

    const after = deviceSessionRowOf(world.deviceSessionId);
    expect(after.activeProfileId).toBeNull();
    expect(after.profileContextVersion).toBe(pcvBefore + 1);
    // 旧上下文(A)活动播放被终态化:不依赖前端 stop
    expect(sessionRowOf(sessionId).state).toBe('interrupted');
    const ticket = getDb().select().from(playbackTicket).where(eq(playbackTicket.id, ticketId)).get();
    expect(ticket?.revokedAt).not.toBeNull();
  });

  it('PIN 变更(API PATCH pin):强制重新选档 —— 清身份 + pcv 递增 + 播放终态化 + 撤票 + pin_version 递增', async () => {
    const { rig, world } = await setupWorld();
    const managementCookie = await setupManagementSession(rig, world);
    const sessionId = seedActiveSession(world);
    const ticketId = seedTicket(world, sessionId);
    const pcvBefore = deviceSessionRowOf(world.deviceSessionId).profileContextVersion;
    const pinVersionBefore = (
      Database.db.prepare('SELECT pin_version FROM profile WHERE id = ?').get(world.profileId) as { pin_version: number }
    ).pin_version;

    const res = await request(rig.app.getHttpServer())
      .patch(`/api/settings/profiles/${world.profileId}`)
      .set('Cookie', managementCookie)
      .send({ pin: '654321', clearPin: false, expectedVersion: 1, ownerPassword: world.password });
    expect(res.status, JSON.stringify(res.body)).toBe(200);

    const after = deviceSessionRowOf(world.deviceSessionId);
    expect(after.activeProfileId).toBeNull();
    expect(after.profileContextVersion).toBe(pcvBefore + 1);
    expect(sessionRowOf(sessionId).state).toBe('interrupted');
    const ticket = getDb().select().from(playbackTicket).where(eq(playbackTicket.id, ticketId)).get();
    expect(ticket?.revokedAt).not.toBeNull();
    const pinVersionAfter = (
      Database.db.prepare('SELECT pin_version FROM profile WHERE id = ?').get(world.profileId) as { pin_version: number }
    ).pin_version;
    expect(pinVersionAfter).toBe(pinVersionBefore + 1);
  });

  it('设备撤销(API):该设备全部会话的活动播放终态化并撤票(不依赖前端 stop)', async () => {
    const { rig, world } = await setupWorld();
    const managementCookie = await setupManagementSession(rig, world);
    const sessionId = seedActiveSession(world);
    const ticketId = seedTicket(world, sessionId);

    const revoke = await request(rig.app.getHttpServer())
      .post(`/api/settings/devices/${world.deviceId}/revoke`)
      .set('Cookie', managementCookie)
      .send({ ownerPassword: world.password });
    expect(revoke.status).toBe(204);

    expect(sessionRowOf(sessionId).state).toBe('interrupted');
    const ticket = getDb().select().from(playbackTicket).where(eq(playbackTicket.id, ticketId)).get();
    expect(ticket?.revokedAt).not.toBeNull();
  });

  it('异步准备提交复查:probe 窗口内 pcv 变化 → ready 提交被拒,旧上下文不复活', async () => {
    const { world } = await setupWorld();

    // 受控 probe:resolve 返回后挂起,直到测试放行(模拟异步准备窗口)
    let releaseProbe: ((outcome: PlaybackProbeOutcome) => void) | null = null;
    const probePort = {
      probeFirstAvailable: () =>
        new Promise<PlaybackProbeOutcome>((resolve) => {
          releaseProbe = resolve;
        }),
    };
    const repository = new PlaybackRepository(Database.db, createPlaybackBudgets(getConfig()));
    const authorization = new PlaybackAuthorizationService(repository);
    const resolver = new PlaybackResolverService(repository, authorization, probePort, createPlaybackBudgets(getConfig()));

    const context = trustedContextOf(world);
    const outcome = await resolver.resolve(context, world.iptv.mediaId);
    expect(outcome.session.state).toBe('preparing');

    // probe 窗口内 DeviceSession 身份版本推进(直接递增:模拟换档竞态中
    // 终态化扫描未覆盖本行的窗口;真实换档路径由上两条用例覆盖终态化)
    getDb()
      .update(deviceSession)
      .set({ profileContextVersion: deviceSessionRowOf(world.deviceSessionId).profileContextVersion + 1 })
      .where(eq(deviceSession.id, world.deviceSessionId))
      .run();

    // probe 成功返回:ready 提交必须被版本复查拒绝(不得把旧上下文播放推向 ready)
    const release = releaseProbe as ((outcome: PlaybackProbeOutcome) => void) | null;
    release?.({
      playbackSourceId: world.iptv.playbackSourceId,
      delivery: 'hls_proxy',
      facts: { durationSeconds: null, audioTracks: [], subtitleTracks: [] },
    });
    // 等待 fire-and-forget 的 prepare 链收敛
    await new Promise((resolve) => setTimeout(resolve, 50));

    const row = sessionRowOf(outcome.session.id);
    expect(row.state).not.toBe('ready');
    expect(row.state).not.toBe('playing');
  });
});

/* ------------------------------------------------------------------ */
/* 夹具助手                                                              */
/* ------------------------------------------------------------------ */

/** 直插旧上下文活动播放(playing;hls_proxy 交付) */
function seedActiveSession(world: PlaybackWorld): string {
  const id = `fx-${Math.random().toString(36).slice(2, 10)}`;
  getDb()
    .insert(playbackSession)
    .values({
      id,
      householdId: world.householdId,
      deviceSessionId: world.deviceSessionId,
      deviceId: world.deviceId,
      profileId: world.profileId,
      mediaId: world.iptv.mediaId,
      playbackSourceId: world.iptv.playbackSourceId,
      state: 'playing',
      delivery: 'hls_proxy',
      generation: 1,
      version: 1,
      positionSeconds: 0,
      audioTrackId: null,
      subtitleTrackId: null,
      desiredPaused: 0,
      profileContextVersion: 1,
      createdAt: PLAYBACK_FIXTURE_NOW,
      startedAt: PLAYBACK_FIXTURE_NOW,
      endedAt: null,
      lastHeartbeatAt: PLAYBACK_FIXTURE_NOW,
      failureCode: null,
    })
    .run();
  return id;
}

/** 直插有效票(撤销断言用) */
function seedTicket(world: PlaybackWorld, sessionId: string): string {
  const id = `fx-ticket-${Math.random().toString(36).slice(2, 10)}`;
  getDb()
    .insert(playbackTicket)
    .values({
      id,
      householdId: world.householdId,
      sessionId,
      tokenHash: hashToken(`fx-ticket-token-${id}`),
      issuedAt: PLAYBACK_FIXTURE_NOW,
      expiresAt: '2027-01-01T00:00:00.000Z',
      generation: 1,
      revokedAt: null,
    })
    .run();
  return id;
}

/** 夹具世界的可信会话上下文(resolver 直调;与 SessionGuard 同字段口径) */
function trustedContextOf(world: PlaybackWorld): SessionContext {
  const session = deviceSessionRowOf(world.deviceSessionId);
  return {
    session: {
      id: session.id,
      householdId: session.householdId,
      accountId: session.accountId,
      deviceId: session.deviceId,
      activeProfileId: session.activeProfileId,
      expiresAt: session.expiresAt,
    },
    account: {
      id: world.accountId,
      householdId: world.householdId,
      username: 'player',
      role: 'owner',
    },
  };
}
