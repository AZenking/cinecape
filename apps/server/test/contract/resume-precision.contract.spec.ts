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
import { registerPersonalPlaybackFactsPort } from '../../src/modules/personal/progress-clock.service';

/**
 * T093(005 US4 契约测试,SC-004 指标用例,双 Profile 双设备夹具):
 *
 * - 同 Profile 设备 A 观看至 120 秒并正常停止,设备 B 继续观看的位置误差 ≤5 秒
 *   (续播位置=服务端保存值 120;误差断言经 API 历史/进度样本),从头播放为 0;
 * - 模拟异常断开(仅 10 秒周期样本已落库),恢复位置相对断开前最后观看位置丢失 ≤15 秒;
 * - 相同 started/periodic 重试不新增历史行;
 * - 另一 Profile 读取同媒体返回 null 且响应不泄漏 writer_epoch/session 标识(串档 0)。
 *
 * 断言深度说明(夹具 NAS 源指向不可达路径,真实媒体交付不存在):进度协议场景经
 * API 层断言 —— resolve/progress/stop 端点构造全部样本;「续播位置」以服务端保存的
 * 历史位置与 resume resolve 的接受为准,真实位置误差(解码后画面时间)归 T141/T144。
 */

describe('T093 · SC-004 续播精度与隔离(双 Profile 双设备)', () => {
  let rig: TestRig;
  let world: PersonalWorld;
  let cookieA: string;
  let cookieB: string;

  function progressUrl(sessionId: string): string {
    return `/api/playback/sessions/${sessionId}/progress`;
  }
  function stopUrl(sessionId: string): string {
    return `/api/playback/sessions/${sessionId}/stop`;
  }

  /** 在指定设备会话上构造 playing 点播会话(epoch 顺序分配,设备间同 Profile) */
  function seedPlayingSession(deviceSessionId: string, deviceId: string, profileId: string, epoch: number) {
    const handle = seedPlaybackSessionRow({
      householdId: world.householdId,
      deviceSessionId,
      deviceId,
      profileId,
      mediaId: world.vod.mediaId,
      playbackSourceId: world.vod.playbackSourceId,
      state: 'playing',
    });
    seedProgressState({
      householdId: world.householdId,
      playbackSessionId: handle.sessionId,
      profileId,
      mediaId: world.vod.mediaId,
      candidateEpoch: epoch,
      contentRevision: 1,
      lastGeneration: handle.generation,
    });
    return handle;
  }

  beforeEach(async () => {
    rig = await startFreshApp({ prefix: 'hmp-t093-precision-' });
    world = seedPersonalWorld(rig);
    cookieA = `${SESSION_COOKIE}=${world.sessionAToken}`;
    cookieB = `${SESSION_COOKIE}=${world.sessionBToken}`;
    // 可信时长注入(等价 probe 事实;真实媒体交付不存在的夹具约束)
    registerPersonalPlaybackFactsPort({ trustedDurationSeconds: () => 3600 });
  });
  afterEach(() => {
    registerPersonalPlaybackFactsPort(null);
    return cleanupRigs();
  });

  it('设备 A 观看至 120 秒正常停止 → 设备 B 继续观看位置误差 ≤5 秒;从头播放为 0', async () => {
    // 设备 A(设备会话 A,档案 A):started → periodic → final 停止
    const sessionA = seedPlayingSession(world.deviceSessionAId, world.deviceIdA, world.profileAId, 1);
    const started = await request(rig.app.getHttpServer())
      .post(progressUrl(sessionA.sessionId))
      .set('Cookie', cookieA)
      .send({ sampleSeq: 1, expectedGeneration: sessionA.generation, positionSeconds: 0, reason: 'started' });
    expect(started.status).toBe(200);
    const periodic = await request(rig.app.getHttpServer())
      .post(progressUrl(sessionA.sessionId))
      .set('Cookie', cookieA)
      .send({ sampleSeq: 2, expectedGeneration: sessionA.generation, positionSeconds: 120, reason: 'periodic' });
    expect(periodic.status).toBe(200);
    const stop = await request(rig.app.getHttpServer())
      .post(stopUrl(sessionA.sessionId))
      .set('Cookie', cookieA)
      .send({ finalProgress: { sampleSeq: 3, expectedGeneration: sessionA.generation, positionSeconds: 120 } });
    expect(stop.status).toBe(204);

    // 设备 B(同档案另一设备会话)读取续播位置:误差 ≤5 秒(保存值 120,B 起播即 120)
    const { getDb } = await import('../../src/modules/auth/db');
    const { deviceSession } = await import('../../src/database/schema');
    // 为同档案添加第二台设备会话(双设备夹具;独立令牌,Progress 端点按会话归属校验)
    const { generateToken, hashToken } = await import('../../src/modules/auth/token.service');
    const tokenA2 = generateToken();
    getDb().insert(deviceSession).values({
      id: 'device-session-a2', householdId: world.householdId, accountId: world.accountId,
      deviceId: world.deviceIdB, tokenHash: hashToken(tokenA2), activeProfileId: world.profileAId,
      expiresAt: '2027-01-01T00:00:00.000Z', lastActiveAt: '2026-10-23T08:00:00.000Z', createdAt: '2026-10-23T08:00:00.000Z',
    }).run();
    const cookieA2 = `${SESSION_COOKIE}=${tokenA2}`;
    const sessionA2 = seedPlayingSession('device-session-a2', world.deviceIdB, world.profileAId, 2);
    // B 设备以 resume 意图 resolve:201 接受(续播位置由服务端冻结,不回零不越界)
    const resumeResolve = await request(rig.app.getHttpServer())
      .post('/api/playback/resolve')
      .set('Cookie', cookieA)
      .send({ mediaId: world.vod.mediaId, startMode: 'resume' });
    expect(resumeResolve.status).toBe(201);
    // 历史保存位置 120:B 的续播样本从 120 继续(误差 0 ≤ 5 秒)
    const saved = readHistoryRowFor(world.householdId, world.profileAId, world.vod.mediaId);
    expect(saved?.positionSeconds).toBe(120);
    const resumeStarted = await request(rig.app.getHttpServer())
      .post(progressUrl(sessionA2.sessionId))
      .set('Cookie', cookieA2)
      .send({ sampleSeq: 1, expectedGeneration: sessionA2.generation, positionSeconds: 120, reason: 'started' });
    expect(resumeStarted.status).toBe(200);
    expect(resumeStarted.body.applied).toBe(true);
    // 从头播放为 0:beginning 意图 + started 位置 0 允许写低(不删除历史、不越界)
    const beginningResolve = await request(rig.app.getHttpServer())
      .post('/api/playback/resolve')
      .set('Cookie', cookieA)
      .send({ mediaId: world.vod.mediaId, startMode: 'beginning' });
    expect(beginningResolve.status).toBe(201);
    const sessionA3 = seedPlayingSession('device-session-a2', world.deviceIdB, world.profileAId, 4);
    const zeroStart = await request(rig.app.getHttpServer())
      .post(progressUrl(sessionA3.sessionId))
      .set('Cookie', cookieA2)
      .send({ sampleSeq: 1, expectedGeneration: sessionA3.generation, positionSeconds: 0, reason: 'started' });
    expect(zeroStart.status).toBe(200);
    expect(readHistoryRowFor(world.householdId, world.profileAId, world.vod.mediaId)?.positionSeconds).toBe(0);
  });

  it('模拟异常断开:仅 10 秒周期样本已落库,恢复位置丢失 ≤15 秒', async () => {
    // 观看至 300,每 10 秒一拍:…,290,300;客户端在 305 断开(300 之后未上报)
    const sessionA = seedPlayingSession(world.deviceSessionAId, world.deviceIdA, world.profileAId, 1);
    const server = rig.app.getHttpServer();
    await request(server)
      .post(progressUrl(sessionA.sessionId))
      .set('Cookie', cookieA)
      .send({ sampleSeq: 1, expectedGeneration: sessionA.generation, positionSeconds: 0, reason: 'started' });
    for (let position = 280; position <= 300; position += 10) {
      const res = await request(server)
        .post(progressUrl(sessionA.sessionId))
        .set('Cookie', cookieA)
        .send({ sampleSeq: position / 10 + 1, expectedGeneration: sessionA.generation, positionSeconds: position, reason: 'periodic' });
      expect(res.status).toBe(200);
    }
    // 无 final(异常断开):已落库最后位置 300;恢复(新会话)从 300 继续 → 丢失 305-300 = 5 ≤ 15 秒
    const saved = readHistoryRowFor(world.householdId, world.profileAId, world.vod.mediaId);
    expect(saved?.positionSeconds).toBe(300);
    const lossSeconds = 305 - (saved?.positionSeconds ?? 0);
    expect(lossSeconds).toBeLessThanOrEqual(15);
    expect(lossSeconds).toBeGreaterThanOrEqual(0);
  });

  it('相同 started/periodic 重试不新增历史行(单条历史,revision 不变)', async () => {
    const sessionA = seedPlayingSession(world.deviceSessionAId, world.deviceIdA, world.profileAId, 1);
    const server = rig.app.getHttpServer();
    for (let retry = 0; retry < 3; retry += 1) {
      const res = await request(server)
        .post(progressUrl(sessionA.sessionId))
        .set('Cookie', cookieA)
        .send({ sampleSeq: 1, expectedGeneration: sessionA.generation, positionSeconds: 60, reason: 'started' });
      expect(res.status).toBe(200);
      expect(res.body.reason).toBe('accepted');
    }
    const saved = readHistoryRowFor(world.householdId, world.profileAId, world.vod.mediaId);
    expect(saved?.revision).toBe(1);
    expect(saved?.lastSampleSeq).toBe(1);
  });

  it('另一 Profile 读取同媒体返回 null,响应不泄漏 writer_epoch/会话标识(串档 0)', async () => {
    const sessionA = seedPlayingSession(world.deviceSessionAId, world.deviceIdA, world.profileAId, 1);
    await request(rig.app.getHttpServer())
      .post(progressUrl(sessionA.sessionId))
      .set('Cookie', cookieA)
      .send({ sampleSeq: 1, expectedGeneration: sessionA.generation, positionSeconds: 90, reason: 'started' });

    // B 档案(设备 B 会话):历史为 null
    const other = await request(rig.app.getHttpServer())
      .get(`/api/me/history/${world.vod.mediaId}`)
      .set('Cookie', cookieB);
    expect(other.status).toBe(200);
    expect(other.body).toBeNull();
    // 响应体不泄漏 writer 标识
    const bodyText = JSON.stringify(other.body) + JSON.stringify(other.headers);
    expect(bodyText).not.toContain(sessionA.sessionId);
    expect(bodyText).not.toContain('writer');

    // A 档案自己的读取也不泄漏 writer_epoch/会话标识
    const own = await request(rig.app.getHttpServer())
      .get(`/api/me/history/${world.vod.mediaId}`)
      .set('Cookie', cookieA);
    expect(own.status).toBe(200);
    const ownText = JSON.stringify(own.body);
    expect(ownText).not.toContain(sessionA.sessionId);
    expect(ownText).not.toContain('writerEpoch');
    expect(ownText).not.toContain('writerPlaybackSessionId');
  });
});
