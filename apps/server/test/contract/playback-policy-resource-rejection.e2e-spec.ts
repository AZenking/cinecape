import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
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
  seedPlaybackWorld,
  type PlaybackWorld,
} from '../fixtures/playback';
import { getDb } from '@platform/database/drizzle';
import { Database } from '@platform/database/database';
import { mediaItem } from '@platform/database/schema';
import { hashToken } from '@contexts/identity-access/infrastructure/token.service';
import { selectMainAndUnlockSettings } from '../helpers-management';

/**
 * T046(005 US3 契约负向测试,先 FAIL):策略/资源失效拒绝同形不泄露 +
 * 登录期间目标失效重判(US3 场景 5)。
 *
 * 权威:docs/specs/005-pc-browsing-flow/contracts/api.md §5/§7、spec.md FR-012
 * 「播放 MUST 依据当前有效设备会话、当前 Profile、最新内容策略和可用家庭资源动态校验;
 * 公开可见不产生播放授权,拒绝不泄露内部策略与源位置」、US3 场景 5
 * 「登录期间原目标被禁用或失去可用来源,完成选档后重新判断目标,不尝试使用
 * 登录前取得的过期事实继续播放」。
 *
 * 矩阵:
 * - 儿童 Profile 请求策略禁止内容 / 来源停用 / 资源不可用 / 跨家庭 / 不存在
 *   → 全部 404 MEDIA_NOT_FOUND 同形,错误体不含策略明细与源位置;
 * - 游客点击时可用、选档完成时已停用的目标:重新 resolve 按最新状态拒绝;
 * - body 夹带 profileId/householdId/startPosition 一律 400,不能扩大权限。
 */

const RESOLVE_URL = '/api/playback/resolve';

interface Rig {
  app: TestRig['app'];
  world: PlaybackWorld;
  cookie: string;
}

async function setupWorld(): Promise<Rig> {
  const rig = await startFreshApp({ prefix: 'hmp-t046-policy-' });
  const world = await seedPlaybackWorld(rig, { now: PLAYBACK_FIXTURE_NOW, nasEnabled: true });
  return { app: rig.app, world, cookie: `${SESSION_COOKIE}=${world.sessionToken}` };
}

async function resolveMedia(rig: Rig, body: Record<string, unknown>): Promise<request.Response> {
  return request(rig.app.getHttpServer()).post(RESOLVE_URL).set('Cookie', rig.cookie).send(body);
}

function expectNoInternalLeak(res: request.Response): void {
  const bodyText = JSON.stringify(res.body ?? {});
  expect(bodyText).not.toContain('iptv.playback-fixture.test');
  expect(bodyText).not.toContain('/nas-media');
  expect(bodyText).not.toContain('ticket=');
  expect(bodyText).not.toContain('location');
  expect(bodyText).not.toContain('policy');
  expect(bodyText).not.toContain('blockedMediaIds');
  expect(bodyText).not.toContain('maxContentLevel');
  expectProblemContentType(res);
}

/** 经设置路由创建档案(US8:管理写迁 /api/settings/profiles;先解锁设置边界) */
async function createProfileViaApi(rig: Rig, body: { name: string; type: 'adult' | 'child'; pin?: string }): Promise<string> {
  // 设置解锁:升格有 PIN 成人为主档案并以 world 会话完成选档 + PIN 验证
  Database.db
    .prepare("UPDATE profile SET is_main = 1 WHERE id = ? AND type = 'adult' AND status = 'active' AND pin_hash IS NOT NULL")
    .run(rig.world.profileWithPinId);
  await selectMainAndUnlockSettings(rig.app, rig.cookie, { mainPin: rig.world.pin });
  const res = await request(rig.app.getHttpServer())
    .post('/api/settings/profiles')
    .set('Cookie', rig.cookie)
    .send(body);
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return (res.body as { id: string }).id;
}

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

/** 夹具注入:第二家庭 + 其媒体(真实启用来源),专测跨家庭同形 */
function injectForeignMedia(): { mediaId: string } {
  const ids = {
    householdId: randomUUID(),
    accountId: randomUUID(),
    mediaId: randomUUID(),
    sourceId: randomUUID(),
    entryId: randomUUID(),
    playbackSourceId: randomUUID(),
  };
  const now = new Date().toISOString();
  const conn = Database.db;
  conn
    .prepare(
      'INSERT INTO household (id, name, default_language, timezone, created_at) VALUES (?, ?, ?, ?, ?)',
    )
    .run(ids.householdId, '第二家庭', 'zh-CN', 'Asia/Shanghai', now);
  conn
    .prepare(
      'INSERT INTO account (id, household_id, username, username_normalized, password_hash, role, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    )
    .run(ids.accountId, ids.householdId, 'stranger', 'stranger', '$argon2id$not-a-real-hash', 'owner', now);
  conn
    .prepare(
      "INSERT INTO media_item (id, household_id, type, title, content_level, version, created_at, updated_at) VALUES (?, ?, 'channel', '别家频道', 0, 1, ?, ?)",
    )
    .run(ids.mediaId, ids.householdId, now, now);
  conn
    .prepare(
      "INSERT INTO media_source (id, household_id, kind, name, remote_url, enabled, created_at, updated_at) VALUES (?, ?, 'iptv', '别家来源', 'http://foreign.example/list.m3u8', 1, ?, ?)",
    )
    .run(ids.sourceId, ids.householdId, now, now);
  conn
    .prepare(
      "INSERT INTO source_entry (id, household_id, source_id, identity_kind, identity_digest, media_id, present, first_seen_at, last_seen_at) VALUES (?, ?, ?, 'url', ?, ?, 1, ?, ?)",
    )
    .run(ids.entryId, ids.householdId, ids.sourceId, hashToken(`foreign:${ids.mediaId}`), ids.mediaId, now, now);
  conn
    .prepare(
      "INSERT INTO playback_source (id, household_id, source_id, source_entry_id, media_item_id, protocol, location, mime_type, priority, requires_proxy, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 'http', 'http://foreign.example/stream.m3u8', 'application/vnd.apple.mpegurl', 100, 1, ?, ?)",
    )
    .run(ids.playbackSourceId, ids.householdId, ids.sourceId, ids.entryId, ids.mediaId, now, now);
  return { mediaId: ids.mediaId };
}

describe('T046 · 策略/资源失效拒绝与登录期间重判(FR-012/US3 场景5)', () => {
  afterEach(cleanupRigs);

  it('儿童 Profile 请求策略禁止内容 → 404 同形,不泄露策略明细;切回成人后同一内容可解析', async () => {
    const rig = await setupWorld();
    const childId = await createProfileViaApi(rig, { name: '弟弟', type: 'child' });
    await switchProfile(rig, childId);

    // 该频道内容分级抬升到儿童策略之上(直接改库 = 最新策略事实)
    getDb().update(mediaItem).set({ contentLevel: 18 }).where(eq(mediaItem.id, rig.world.iptv.mediaId)).run();

    const denied = await resolveMedia(rig, { mediaId: rig.world.iptv.mediaId });
    expect(denied.status).toBe(404);
    expect(denied.body.code).toBe(ProblemCode.MEDIA_NOT_FOUND);
    expectNoInternalLeak(denied);
    // 授权拒绝不建会话
    const count = Database.db
      .prepare('SELECT COUNT(*) AS n FROM playback_session WHERE household_id = ?')
      .get(rig.world.householdId) as { n: number };
    expect(count.n).toBe(0);

    // 同形对照:不存在媒体同样 404 MEDIA_NOT_FOUND(对客户端不可区分,不互相掩盖)
    const missing = await resolveMedia(rig, { mediaId: randomUUID() });
    expect(missing.status).toBe(404);
    expect(missing.body.code).toBe(denied.body.code);

    // 切回成人档案(PIN 成人,无儿童家长验证门槛):策略恢复 → 同一内容可解析
    // (策略动态生效,不缓存旧判定;无 PIN 成人在含儿童家庭需家长验证,非本用例面)
    await switchProfile(rig, rig.world.profileWithPinId, rig.world.pin);
    const allowed = await resolveMedia(rig, { mediaId: rig.world.iptv.mediaId });
    expect(allowed.status).toBe(201);
  });

  it('来源停用后 resolve → 404 同形(可用家庭资源动态校验)', async () => {
    const rig = await setupWorld();
    const before = await resolveMedia(rig, { mediaId: rig.world.iptv.mediaId });
    expect(before.status).toBe(201);

    // 停用 IPTV 父源(与公开目录可用性同一开关)
    const { mediaSource } = await import('@platform/database/schema');
    getDb()
      .update(mediaSource)
      .set({ enabled: 0 })
      .where(and(eq(mediaSource.householdId, rig.world.householdId), eq(mediaSource.id, rig.world.iptv.sourceId)))
      .run();

    const denied = await resolveMedia(rig, { mediaId: rig.world.iptv.mediaId });
    expect(denied.status).toBe(404);
    expect(denied.body.code).toBe(ProblemCode.MEDIA_NOT_FOUND);
    expectNoInternalLeak(denied);
  });

  it('资源不可用(无条目/无播放资源)与不存在、跨家庭统一 404 同形', async () => {
    const rig = await setupWorld();
    const foreign = injectForeignMedia();

    const invisible = await resolveMedia(rig, { mediaId: rig.world.invisibleMediaId });
    const missing = await resolveMedia(rig, { mediaId: randomUUID() });
    const crossHousehold = await resolveMedia(rig, { mediaId: foreign.mediaId });

    for (const res of [invisible, missing, crossHousehold]) {
      expect(res.status).toBe(404);
      expect(res.body.code).toBe(ProblemCode.MEDIA_NOT_FOUND);
      expectNoInternalLeak(res);
    }
    expect(invisible.body.code).toBe(crossHousehold.body.code);
  });

  it('US3 场景5:点击时可用、选档完成时已停用的目标 —— 完成选档后 resolve 按最新状态重新判定被拒', async () => {
    const rig = await setupWorld();

    // 「游客点击时可用」:resolve 接受(此处以会话 A 时代表达点击事实)
    const accepted = await resolveMedia(rig, { mediaId: rig.world.nas.mediaId });
    expect(accepted.status).toBe(201);

    // 登录期间目标失效:NAS 来源停用
    const { mediaSource } = await import('@platform/database/schema');
    getDb()
      .update(mediaSource)
      .set({ enabled: 0 })
      .where(and(eq(mediaSource.householdId, rig.world.householdId), eq(mediaSource.id, rig.world.nas.sourceId)))
      .run();

    // 完成选档(实际换档 A→B→A,pcv 至少 +2):重判不得复用登录前事实
    await switchProfile(rig, rig.world.profileWithPinId, rig.world.pin);
    await switchProfile(rig, rig.world.profileId);

    const rejected = await resolveMedia(rig, { mediaId: rig.world.nas.mediaId });
    expect(rejected.status).toBe(404);
    expect(rejected.body.code).toBe(ProblemCode.MEDIA_NOT_FOUND);
    expectNoInternalLeak(rejected);

    // 其它可用内容不受影响:IPTV 频道仍可解析
    const other = await resolveMedia(rig, { mediaId: rig.world.iptv.mediaId });
    expect(other.status).toBe(201);
  });

  it('body 夹带 profileId/householdId/startPosition 一律 400,不能扩大权限(跨家庭档案声明无效)', async () => {
    const rig = await setupWorld();
    const childId = await createProfileViaApi(rig, { name: '弟弟', type: 'child' });

    const forged = await resolveMedia(rig, {
      mediaId: rig.world.iptv.mediaId,
      profileId: childId,
      householdId: rig.world.householdId,
      startPosition: 42,
    });
    expect(forged.status).toBe(400);
    expect(forged.body.code).toBe(ProblemCode.VALIDATION_FAILED);
    expectNoInternalLeak(forged);
  });

  it('拒绝路径不创建播放会话(策略/资源拒绝均无 session 行)', async () => {
    const rig = await setupWorld();
    await resolveMedia(rig, { mediaId: rig.world.invisibleMediaId });
    await resolveMedia(rig, { mediaId: randomUUID() });

    const count = Database.db
      .prepare('SELECT COUNT(*) AS n FROM playback_session WHERE household_id = ?')
      .get(rig.world.householdId) as { n: number };
    expect(count.n).toBe(0);
  });
});
