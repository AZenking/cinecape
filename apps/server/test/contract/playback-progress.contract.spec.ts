import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SESSION_COOKIE } from '@hmp/shared';
import { cleanupRigs, startFreshApp, type TestRig } from '../helpers';
import {
  seedPersonalWorld,
  seedPlaybackSessionRow,
  seedProgressState,
  readHistoryRowFor,
  type PersonalWorld,
} from '../unit/personal/personal-world';
import { registerPersonalPlaybackFactsPort } from '../../src/contexts/personal-data/application/progress-clock.service';
import { getDb } from '../../src/modules/auth/db';
import { mediaItem, playbackProgressState, playbackSession } from '../../src/database/schema';
import { eq } from 'drizzle-orm';

/**
 * T092(005 US4 契约测试)—— 播放 progress/stop 协议(contracts/api.md §5):
 *
 * - resolve 请求面:拒绝 body 携带 profileId/householdId/startPosition;频道
 *   startMode=resume → 400 PLAYBACK_SEEK_UNSUPPORTED;startMode 枚举外 400;
 * - progress:验证会话/当前 Profile/资源修订(409 PROGRESS_RESOURCE_CHANGED)/
 *   duration 未知(409 PROGRESS_NOT_READY)/generation 不匹配(409)/会话终态后拒绝/
 *   换档后 profileContextVersion 不匹配拒绝;
 * - stop:空 body 结束准备(取消 preparing 204);finalProgress 原子提交;
 *   无效 final 409/400 且不部分保存(会话保持活动,可再空 stop);
 * - 限频:进度每 DeviceSession 60 次/分钟,超限 429 + Retry-After;
 * - 请求体 <=16KiB 且未知字段拒绝。
 */

const RESOLVE_URL = '/api/playback/resolve';

describe('T092 · 播放 progress/stop 协议契约', () => {
  let rig: TestRig;
  let world: PersonalWorld;
  let cookieA: string;

  function progressUrl(sessionId: string): string {
    return `/api/playback/sessions/${sessionId}/progress`;
  }
  function stopUrl(sessionId: string): string {
    return `/api/playback/sessions/${sessionId}/stop`;
  }

  beforeEach(async () => {
    rig = await startFreshApp({ prefix: 'hmp-t092-progress-' });
    world = seedPersonalWorld(rig);
    cookieA = `${SESSION_COOKIE}=${world.sessionAToken}`;
    registerPersonalPlaybackFactsPort({ trustedDurationSeconds: () => 3600 });
  });
  afterEach(() => {
    registerPersonalPlaybackFactsPort(null);
    return cleanupRigs();
  });

  /** 点播 playing 会话 + resolve 绑定形态状态行(epoch 由 clock 分配) */
  function seedPlayingVodSession(): { sessionId: string; generation: number } {
    const handle = seedPlaybackSessionRow({
      householdId: world.householdId,
      deviceSessionId: world.deviceSessionAId,
      deviceId: world.deviceIdA,
      profileId: world.profileAId,
      mediaId: world.vod.mediaId,
      playbackSourceId: world.vod.playbackSourceId,
      state: 'playing',
    });
    seedProgressState({
      householdId: world.householdId,
      playbackSessionId: handle.sessionId,
      profileId: world.profileAId,
      mediaId: world.vod.mediaId,
      candidateEpoch: 1,
      contentRevision: 1,
      lastGeneration: handle.generation,
    });
    return { sessionId: handle.sessionId, generation: handle.generation };
  }

  it('resolve 请求面:profileId/householdId/startPosition/未知字段一律 400;startMode 枚举外 400', async () => {
    for (const body of [
      { mediaId: world.vod.mediaId, profileId: world.profileAId },
      { mediaId: world.vod.mediaId, householdId: world.householdId },
      { mediaId: world.vod.mediaId, startPosition: 120 },
      { mediaId: world.vod.mediaId, startMode: 'middle' },
    ]) {
      const res = await request(rig.app.getHttpServer()).post(RESOLVE_URL).set('Cookie', cookieA).send(body);
      expect(res.status, JSON.stringify(body)).toBe(400);
      expect(res.body.code ?? res.body.title).toBeDefined();
    }
  });

  it('频道 startMode=resume → 400 PLAYBACK_SEEK_UNSUPPORTED(直播不支持续播定位)', async () => {
    const res = await request(rig.app.getHttpServer())
      .post(RESOLVE_URL)
      .set('Cookie', cookieA)
      .send({ mediaId: world.channel.mediaId, startMode: 'resume' });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('PLAYBACK_SEEK_UNSUPPORTED');
    // 对照:点播 resume 合法接受(201,无票)
    const vod = await request(rig.app.getHttpServer())
      .post(RESOLVE_URL)
      .set('Cookie', cookieA)
      .send({ mediaId: world.vod.mediaId, startMode: 'resume' });
    expect(vod.status).toBe(201);
  });

  it('resolve 接受点播时只建 progress_state(可跳号递增),不写可见历史', async () => {
    const res = await request(rig.app.getHttpServer())
      .post(RESOLVE_URL)
      .set('Cookie', cookieA)
      .send({ mediaId: world.vod.mediaId });
    expect(res.status).toBe(201);
    const sessionId = String(res.headers['location']).split('/').pop() as string;
    const state = getDb()
      .select()
      .from(playbackProgressState)
      .where(eq(playbackProgressState.playbackSessionId, sessionId))
      .get() as Record<string, unknown> | undefined;
    expect(state).toBeDefined();
    expect(state?.started).toBe(0);
    expect(state?.candidateEpoch).toBeGreaterThan(0);
    expect(state?.contentRevision).toBe(1);
    expect(readHistoryRowFor(world.householdId, world.profileAId, world.vod.mediaId)).toBeUndefined();
  });

  it('progress 200 形态 {applied,reason,historyRevision};started 确认前 periodic 拒绝', async () => {
    const { sessionId, generation } = seedPlayingVodSession();
    // 未 started 的 periodic → 409
    const early = await request(rig.app.getHttpServer())
      .post(progressUrl(sessionId))
      .set('Cookie', cookieA)
      .send({ sampleSeq: 1, expectedGeneration: generation, positionSeconds: 10, reason: 'periodic' });
    expect(early.status).toBe(409);
    // started → 200 accepted
    const started = await request(rig.app.getHttpServer())
      .post(progressUrl(sessionId))
      .set('Cookie', cookieA)
      .send({ sampleSeq: 1, expectedGeneration: generation, positionSeconds: 0, reason: 'started' });
    expect(started.status).toBe(200);
    expect(Object.keys(started.body).sort()).toEqual(['applied', 'historyRevision', 'reason']);
    expect(started.body).toEqual({ applied: true, reason: 'accepted', historyRevision: 1 });
    // periodic → 200
    const periodic = await request(rig.app.getHttpServer())
      .post(progressUrl(sessionId))
      .set('Cookie', cookieA)
      .send({ sampleSeq: 2, expectedGeneration: generation, positionSeconds: 30, reason: 'periodic' });
    expect(periodic.body).toEqual({ applied: true, reason: 'accepted', historyRevision: 2 });
  });

  it('progress 未知字段拒绝(400);体 >16KiB 400', async () => {
    const { sessionId, generation } = seedPlayingVodSession();
    const unknown = await request(rig.app.getHttpServer())
      .post(progressUrl(sessionId))
      .set('Cookie', cookieA)
      .send({ sampleSeq: 1, expectedGeneration: generation, positionSeconds: 0, reason: 'started', profileId: world.profileAId });
    expect(unknown.status).toBe(400);
    const big = await request(rig.app.getHttpServer())
      .post(progressUrl(sessionId))
      .set('Cookie', cookieA)
      .set('Content-Type', 'application/json')
      .send(`{"sampleSeq":1,"expectedGeneration":${generation},"positionSeconds":0,"reason":"started","pad":"${'x'.repeat(20_000)}"}`);
    expect(big.status).toBe(400);
  });

  it('duration 未知 → 409 PROGRESS_NOT_READY;资源修订变化 → 409 PROGRESS_RESOURCE_CHANGED', async () => {
    registerPersonalPlaybackFactsPort(null); // 无 probe 事实、无历史时长
    const { sessionId, generation } = seedPlayingVodSession();
    const notReady = await request(rig.app.getHttpServer())
      .post(progressUrl(sessionId))
      .set('Cookie', cookieA)
      .send({ sampleSeq: 1, expectedGeneration: generation, positionSeconds: 0, reason: 'started' });
    expect(notReady.status).toBe(409);
    expect(notReady.body.code).toBe('PROGRESS_NOT_READY');

    // 资源修订变化(恢复时长注入后)
    registerPersonalPlaybackFactsPort({ trustedDurationSeconds: () => 3600 });
    getDb().update(mediaItem).set({ contentRevision: 2 }).where(eq(mediaItem.id, world.vod.mediaId)).run();
    const changed = await request(rig.app.getHttpServer())
      .post(progressUrl(sessionId))
      .set('Cookie', cookieA)
      .send({ sampleSeq: 1, expectedGeneration: generation, positionSeconds: 0, reason: 'started' });
    expect(changed.status).toBe(409);
    expect(changed.body.code).toBe('PROGRESS_RESOURCE_CHANGED');
  });

  it('generation 不匹配 → 409 PLAYBACK_GENERATION_STALE 不消耗序号;终态会话拒绝', async () => {
    const { sessionId, generation } = seedPlayingVodSession();
    await request(rig.app.getHttpServer())
      .post(progressUrl(sessionId))
      .set('Cookie', cookieA)
      .send({ sampleSeq: 1, expectedGeneration: generation, positionSeconds: 0, reason: 'started' });
    const stale = await request(rig.app.getHttpServer())
      .post(progressUrl(sessionId))
      .set('Cookie', cookieA)
      .send({ sampleSeq: 2, expectedGeneration: generation + 5, positionSeconds: 30, reason: 'periodic' });
    expect(stale.status).toBe(409);
    expect(stale.body.code).toBe('PLAYBACK_GENERATION_STALE');
    // 序号未消耗:同 seq=2 正确 generation 立即接受
    const ok = await request(rig.app.getHttpServer())
      .post(progressUrl(sessionId))
      .set('Cookie', cookieA)
      .send({ sampleSeq: 2, expectedGeneration: generation, positionSeconds: 30, reason: 'periodic' });
    expect(ok.status).toBe(200);
    // 终态后拒绝
    await request(rig.app.getHttpServer()).post(stopUrl(sessionId)).set('Cookie', cookieA).send({});
    const afterStop = await request(rig.app.getHttpServer())
      .post(progressUrl(sessionId))
      .set('Cookie', cookieA)
      .send({ sampleSeq: 3, expectedGeneration: generation, positionSeconds: 40, reason: 'periodic' });
    expect(afterStop.status).toBe(409);
  });

  it('换档后 profileContextVersion 不匹配 → 拒绝(404 同形);换档不复活旧上下文', async () => {
    const { sessionId, generation } = seedPlayingVodSession();
    await request(rig.app.getHttpServer())
      .post(progressUrl(sessionId))
      .set('Cookie', cookieA)
      .send({ sampleSeq: 1, expectedGeneration: generation, positionSeconds: 0, reason: 'started' });
    // 换档 A→B(经既有选档接口,同事务终态化旧上下文播放并递增版本)
    const switchRes = await request(rig.app.getHttpServer())
      .post(`/api/profiles/${world.profileBId}/select`)
      .set('Cookie', cookieA)
      .send({});
    expect(switchRes.status).toBe(200);
    const old = await request(rig.app.getHttpServer())
      .post(progressUrl(sessionId))
      .set('Cookie', cookieA)
      .send({ sampleSeq: 2, expectedGeneration: generation, positionSeconds: 30, reason: 'periodic' });
    expect(old.status).toBe(404);
    expect(old.body.code).toBe('PLAYBACK_NOT_FOUND');
  });

  it('stop 空 body:取消 preparing 204(无 started 不建历史);终态重复 stop 204', async () => {
    const preparing = seedPlaybackSessionRow({
      householdId: world.householdId,
      deviceSessionId: world.deviceSessionAId,
      deviceId: world.deviceIdA,
      profileId: world.profileAId,
      mediaId: world.vod.mediaId,
      playbackSourceId: world.vod.playbackSourceId,
      state: 'preparing',
    });
    const cancel = await request(rig.app.getHttpServer()).post(stopUrl(preparing.sessionId)).set('Cookie', cookieA).send({});
    expect(cancel.status).toBe(204);
    expect(readHistoryRowFor(world.householdId, world.profileAId, world.vod.mediaId)).toBeUndefined();
    // 终态重复 stop:仍 204(幂等清理)
    const again = await request(rig.app.getHttpServer()).post(stopUrl(preparing.sessionId)).set('Cookie', cookieA).send({});
    expect(again.status).toBe(204);
  });

  it('stop finalProgress:原子提交(final 与终态同事务);无效 final 409/400 不部分保存,可再空 stop', async () => {
    const { sessionId, generation } = seedPlayingVodSession();
    await request(rig.app.getHttpServer())
      .post(progressUrl(sessionId))
      .set('Cookie', cookieA)
      .send({ sampleSeq: 1, expectedGeneration: generation, positionSeconds: 0, reason: 'started' });
    // 无效 final:generation 冲突 → 409,会话保持活动
    const invalid = await request(rig.app.getHttpServer())
      .post(stopUrl(sessionId))
      .set('Cookie', cookieA)
      .send({ finalProgress: { sampleSeq: 2, expectedGeneration: 99, positionSeconds: 120 } });
    expect(invalid.status).toBe(409);
    expect(getDb().select().from(playbackSession).where(eq(playbackSession.id, sessionId)).get()?.state).toBe('playing');
    // 无效 final:位置越界 → 400
    const outOfRange = await request(rig.app.getHttpServer())
      .post(stopUrl(sessionId))
      .set('Cookie', cookieA)
      .send({ finalProgress: { sampleSeq: 2, expectedGeneration: generation, positionSeconds: 9999 } });
    expect(outOfRange.status).toBe(400);
    expect(getDb().select().from(playbackSession).where(eq(playbackSession.id, sessionId)).get()?.state).toBe('playing');
    // 有效 final:final 保存 + 终态同事务
    const stop = await request(rig.app.getHttpServer())
      .post(stopUrl(sessionId))
      .set('Cookie', cookieA)
      .send({ finalProgress: { sampleSeq: 2, expectedGeneration: generation, positionSeconds: 120 } });
    expect(stop.status).toBe(204);
    expect(getDb().select().from(playbackSession).where(eq(playbackSession.id, sessionId)).get()?.state).toBe('ended');
    expect(readHistoryRowFor(world.householdId, world.profileAId, world.vod.mediaId)?.positionSeconds).toBe(120);
    // 已终态重复 stop 携新 final:仍 204,不重写历史
    const repeat = await request(rig.app.getHttpServer())
      .post(stopUrl(sessionId))
      .set('Cookie', cookieA)
      .send({ finalProgress: { sampleSeq: 9, expectedGeneration: generation, positionSeconds: 555 } });
    expect(repeat.status).toBe(204);
    expect(readHistoryRowFor(world.householdId, world.profileAId, world.vod.mediaId)?.positionSeconds).toBe(120);
  });

  it('限频:进度每 DeviceSession 60 次/分钟,超限 429 + Retry-After', async () => {
    const { sessionId, generation } = seedPlayingVodSession();
    await request(rig.app.getHttpServer())
      .post(progressUrl(sessionId))
      .set('Cookie', cookieA)
      .send({ sampleSeq: 1, expectedGeneration: generation, positionSeconds: 0, reason: 'started' });
    // 已消耗 1 次;再打 60 次(同 seq 同 payload → duplicate 200)后第 61 次 → 429
    let saw429 = false;
    let retryAfter: string | undefined;
    for (let index = 0; index < 61; index += 1) {
      const res = await request(rig.app.getHttpServer())
        .post(progressUrl(sessionId))
        .set('Cookie', cookieA)
        .send({ sampleSeq: 1, expectedGeneration: generation, positionSeconds: 0, reason: 'started' });
      if (res.status === 429) {
        saw429 = true;
        retryAfter = res.headers['retry-after'];
        break;
      }
      expect(res.status).toBe(200);
    }
    expect(saw429).toBe(true);
    expect(retryAfter).toBeDefined();
    expect(Number(retryAfter)).toBeGreaterThan(0);
  });
});
