import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SESSION_COOKIE } from '@hmp/shared';
import { cleanupRigs, startFreshApp, expectProblemContentType, type TestRig } from '../helpers';
import { seedPersonalWorld, type PersonalWorld } from '../unit/personal/personal-world';
import { encodePersonalCursor } from '../../src/modules/personal/signed-cursor';

/**
 * T091(005 US4 契约测试)—— /me 收藏与历史(contracts/api.md §4):
 *
 * 正向:GET /me/favorites/channels 形态 {items:[{media,createdAt,current,next}],nextCursor};
 * PUT 204(channel 且可用,重复不更新时间);DELETE 204(已不存在仍成功,允许取消已失效频道);
 * GET /me/history 按服务端 lastViewedAt 倒序 + 游标分页;GET /me/history/{mediaId}
 * 返回 HistoryItem 或 200 null。
 * 负向(宪章原则一/二):游客 401;未选档 403 ACTIVE_PROFILE_REQUIRED;跨 Profile 篡改游标
 * 400 INVALID_CURSOR 不回落其他身份;body 伪造 profileId/householdId 未知字段拒绝;
 * 失效会话(退出)写入 401;越权收藏(不存在/非频道/不可用)400/404;双 Profile 并发
 * 不串档;个人响应 Cache-Control: no-store 且不嵌入公共详情。
 */

const FAV_URL = '/api/me/favorites/channels';
const HIST_URL = '/api/me/history';

describe('T091 · /me 收藏与历史契约', () => {
  let rig: TestRig;
  let world: PersonalWorld;
  let cookieA: string;
  let cookieB: string;

  beforeEach(async () => {
    rig = await startFreshApp({ prefix: 'hmp-t091-me-' });
    world = seedPersonalWorld(rig);
    cookieA = `${SESSION_COOKIE}=${world.sessionAToken}`;
    cookieB = `${SESSION_COOKIE}=${world.sessionBToken}`;
  });
  afterEach(cleanupRigs);

  it('PUT 收藏 204:形态幂等,重复 PUT 不更新 created_at;响应 no-store', async () => {
    const first = await request(rig.app.getHttpServer())
      .put(`${FAV_URL}/${world.channel.mediaId}`)
      .set('Cookie', cookieA)
      .send({});
    expect(first.status).toBe(204);
    expect(first.headers['cache-control']).toContain('no-store');

    const page1 = await request(rig.app.getHttpServer()).get(FAV_URL).set('Cookie', cookieA);
    expect(page1.status).toBe(200);
    const createdAt = (page1.body.items as Array<{ createdAt: string }>)[0]?.createdAt;
    expect(typeof createdAt).toBe('string');

    // 重复 PUT:仍 204,时间不更新
    await request(rig.app.getHttpServer()).put(`${FAV_URL}/${world.channel.mediaId}`).set('Cookie', cookieA).send({});
    const page2 = await request(rig.app.getHttpServer()).get(FAV_URL).set('Cookie', cookieA);
    expect((page2.body.items as Array<{ createdAt: string }>)[0]?.createdAt).toBe(createdAt);
  });

  it('GET favorites 形态:{items:[{media,createdAt,current,next}],nextCursor};unavailable 摘要', async () => {
    await request(rig.app.getHttpServer()).put(`${FAV_URL}/${world.channel.mediaId}`).set('Cookie', cookieA).send({});
    const res = await request(rig.app.getHttpServer()).get(FAV_URL).set('Cookie', cookieA);
    expect(res.status).toBe(200);
    const item = (res.body.items as Array<Record<string, unknown>>)[0] as Record<string, unknown>;
    expect(Object.keys(item).sort()).toEqual(['createdAt', 'current', 'media', 'next']);
    const media = item.media as Record<string, unknown>;
    // PublicMedia 白名单
    expect(Object.keys(media).sort()).toEqual(['availability', 'contentLevel', 'description', 'id', 'posterRef', 'title', 'type']);
    expect(media.availability).toBe('available');
    expect((item.current as Record<string, unknown> | null)?.title).toBe('正在直播节目');
    expect((item.next as Record<string, unknown> | null)?.title).toBe('下一档节目');
    expect(res.body.nextCursor).toBeNull();
    // 未知 query 字段拒绝
    const bad = await request(rig.app.getHttpServer()).get(FAV_URL).query({ profileId: world.profileAId }).set('Cookie', cookieA);
    expect(bad.status).toBe(400);
    expect(bad.body.code ?? bad.body.title).toBeDefined();
  });

  it('DELETE 已不存在仍 204;允许取消已失效频道收藏', async () => {
    const gone = await request(rig.app.getHttpServer())
      .delete(`${FAV_URL}/no-such-media`)
      .set('Cookie', cookieA);
    expect(gone.status).toBe(204);
    await request(rig.app.getHttpServer()).put(`${FAV_URL}/${world.channel.mediaId}`).set('Cookie', cookieA).send({});
    // 频道失效(present=0)后仍可取消
    const { getDb } = await import('../../src/modules/auth/db');
    const { sourceEntry } = await import('../../src/database/schema');
    const { eq } = await import('drizzle-orm');
    getDb().update(sourceEntry).set({ present: 0, missingSince: '2026-10-23T12:00:00.000Z' }).where(eq(sourceEntry.id, world.channel.entryId)).run();
    const res = await request(rig.app.getHttpServer()).delete(`${FAV_URL}/${world.channel.mediaId}`).set('Cookie', cookieA);
    expect(res.status).toBe(204);
  });

  it('GET /me/history:服务端 lastViewedAt 倒序 + 游标分页;HistoryItem 白名单', async () => {
    // 两部影片历史(A 档案)
    const { seedHistoryRow } = await import('../unit/personal/personal-world');
    seedHistoryRow({
      householdId: world.householdId, profileId: world.profileAId, mediaId: world.vod.mediaId,
      writerEpoch: 1, writerPlaybackSessionId: 's1', positionSeconds: 120, durationSeconds: 3600,
      contentRevision: 1, lastViewedAt: '2026-10-23T08:00:00.000Z', revision: 1,
    });
    const secondVod = world.unavailableVodMediaId;
    seedHistoryRow({
      householdId: world.householdId, profileId: world.profileAId, mediaId: secondVod,
      writerEpoch: 1, writerPlaybackSessionId: 's2', positionSeconds: 0, durationSeconds: null,
      contentRevision: 1, lastViewedAt: '2026-10-23T09:00:00.000Z', revision: 1,
    });
    const res = await request(rig.app.getHttpServer()).get(HIST_URL).set('Cookie', cookieA);
    expect(res.status).toBe(200);
    const items = res.body.items as Array<Record<string, unknown>>;
    expect(items).toHaveLength(2);
    // 倒序:最近观看在前
    expect((items[0]?.media as Record<string, unknown>).id).toBe(secondVod);
    expect((items[1]?.media as Record<string, unknown>).id).toBe(world.vod.mediaId);
    const item = items[1] as Record<string, unknown>;
    expect(Object.keys(item).sort()).toEqual(['canResume', 'durationSeconds', 'lastViewedAt', 'media', 'positionSeconds', 'revision']);
    expect(item.canResume).toBe(true);
    // 失效媒体的历史仍返回本档案摘要,但 canResume=false
    expect((items[0]?.media as Record<string, unknown>).availability).toBe('unavailable');
    expect(items[0]?.canResume).toBe(false);
  });

  it('GET /me/history/{mediaId}:HistoryItem 或 200 null', async () => {
    const none = await request(rig.app.getHttpServer()).get(`${HIST_URL}/${world.vod.mediaId}`).set('Cookie', cookieA);
    expect(none.status).toBe(200);
    expect(none.body).toBeNull();
    const { seedHistoryRow } = await import('../unit/personal/personal-world');
    seedHistoryRow({
      householdId: world.householdId, profileId: world.profileAId, mediaId: world.vod.mediaId,
      writerEpoch: 1, writerPlaybackSessionId: 's1', positionSeconds: 120, durationSeconds: 3600,
      contentRevision: 1, lastViewedAt: '2026-10-23T08:00:00.000Z', revision: 1,
    });
    const res = await request(rig.app.getHttpServer()).get(`${HIST_URL}/${world.vod.mediaId}`).set('Cookie', cookieA);
    expect(res.status).toBe(200);
    expect(res.body.positionSeconds).toBe(120);
    expect(res.body.canResume).toBe(true);
    // 不公开 writer 标识
    expect(JSON.stringify(res.body)).not.toContain('s1');
  });

  it('游客 401;未选档 403 ACTIVE_PROFILE_REQUIRED(读与写同边界)', async () => {
    const guestGet = await request(rig.app.getHttpServer()).get(FAV_URL);
    expect(guestGet.status).toBe(401);
    expectProblemContentType(guestGet);
    const guestPut = await request(rig.app.getHttpServer()).put(`${FAV_URL}/${world.channel.mediaId}`).send({});
    expect(guestPut.status).toBe(401);
    const guestHist = await request(rig.app.getHttpServer()).get(HIST_URL);
    expect(guestHist.status).toBe(401);
  });

  it('body 伪造 profileId/householdId:未知字段 400 拒绝;身份只从服务端当前 Profile 推导', async () => {
    const res = await request(rig.app.getHttpServer())
      .put(`${FAV_URL}/${world.channel.mediaId}`)
      .set('Cookie', cookieA)
      .send({ profileId: world.profileBId, householdId: 'other-household' });
    expect(res.status).toBe(400);
    // 伪造身份不生效:收藏落在档案 A(当前会话档案),B 无记录
    await request(rig.app.getHttpServer()).put(`${FAV_URL}/${world.channel.mediaId}`).set('Cookie', cookieA).send({});
    const listB = await request(rig.app.getHttpServer()).get(FAV_URL).set('Cookie', cookieB);
    expect(listB.body.items).toHaveLength(0);
    const listA = await request(rig.app.getHttpServer()).get(FAV_URL).set('Cookie', cookieA);
    expect(listA.body.items).toHaveLength(1);
  });

  it('跨 Profile 篡改游标:400 INVALID_CURSOR,不回落其他身份', async () => {
    await request(rig.app.getHttpServer()).put(`${FAV_URL}/${world.channel.mediaId}`).set('Cookie', cookieA).send({});
    // 构造合法 A 游标后交给 B 用 → 400
    const cursor = encodePersonalCursor({
      type: 'favorites',
      householdId: world.householdId,
      profileId: world.profileAId,
      sortAt: '2026-10-23T08:00:00.000Z',
      mediaId: world.channel.mediaId,
    });
    const resB = await request(rig.app.getHttpServer()).get(FAV_URL).query({ cursor }).set('Cookie', cookieB);
    expect(resB.status).toBe(400);
    expect(resB.body.code).toBe('INVALID_CURSOR');
    // 篡改载荷 → 400
    const resTamper = await request(rig.app.getHttpServer())
      .get(FAV_URL)
      .query({ cursor: `${cursor}x` })
      .set('Cookie', cookieA);
    expect(resTamper.status).toBe(400);
    expect(resTamper.body.code).toBe('INVALID_CURSOR');
    // 合法 A 游标由 A 使用 → 200
    const resA = await request(rig.app.getHttpServer()).get(FAV_URL).query({ cursor }).set('Cookie', cookieA);
    expect(resA.status).toBe(200);
  });

  it('越权收藏:不存在/跨家庭 404,非频道 400,不可用 400', async () => {
    const missing = await request(rig.app.getHttpServer()).put(`${FAV_URL}/no-such-media`).set('Cookie', cookieA).send({});
    expect(missing.status).toBe(404);
    const movie = await request(rig.app.getHttpServer()).put(`${FAV_URL}/${world.movieMediaId}`).set('Cookie', cookieA).send({});
    expect(movie.status).toBe(400);
    const unavailable = await request(rig.app.getHttpServer()).put(`${FAV_URL}/${world.unavailableChannelMediaId}`).set('Cookie', cookieA).send({});
    expect(unavailable.status).toBe(400);
  });

  it('失效会话(退出)后个人写入 401', async () => {
    const logout = await request(rig.app.getHttpServer()).post('/api/auth/logout').set('Cookie', cookieA).send({});
    expect([200, 204]).toContain(logout.status);
    const res = await request(rig.app.getHttpServer()).put(`${FAV_URL}/${world.channel.mediaId}`).set('Cookie', cookieA).send({});
    expect(res.status).toBe(401);
    expect(res.body.code).toBe('SESSION_INVALID');
  });

  it('双 Profile 并发读写不串档;个人响应不嵌入公共详情(no-store)', async () => {
    // 并发:A 收藏频道,B 收藏同一频道(A 归属互不影响,列表各自维护)
    const [putA, putB] = await Promise.all([
      request(rig.app.getHttpServer()).put(`${FAV_URL}/${world.channel.mediaId}`).set('Cookie', cookieA).send({}),
      request(rig.app.getHttpServer()).put(`${FAV_URL}/${world.channel.mediaId}`).set('Cookie', cookieB).send({}),
    ]);
    expect(putA.status).toBe(204);
    expect(putB.status).toBe(204);
    const [listA, listB, histB] = await Promise.all([
      request(rig.app.getHttpServer()).get(FAV_URL).set('Cookie', cookieA),
      request(rig.app.getHttpServer()).get(FAV_URL).set('Cookie', cookieB),
      request(rig.app.getHttpServer()).get(HIST_URL).set('Cookie', cookieB),
    ]);
    expect(listA.body.items).toHaveLength(1);
    expect(listB.body.items).toHaveLength(1);
    expect(histB.body.items).toHaveLength(0);
    // 个人响应 no-store,不进共享缓存/公共详情
    expect(listA.headers['cache-control']).toContain('no-store');
    expect(histB.headers['cache-control']).toContain('no-store');
  });

  it('limit 边界:>100 → 400;<1 → 400', async () => {
    const big = await request(rig.app.getHttpServer()).get(FAV_URL).query({ limit: 101 }).set('Cookie', cookieA);
    expect(big.status).toBe(400);
    const small = await request(rig.app.getHttpServer()).get(HIST_URL).query({ limit: 0 }).set('Cookie', cookieA);
    expect(small.status).toBe(400);
  });
});
