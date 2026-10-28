import request from 'supertest';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SESSION_COOKIE } from '@hmp/shared';
import type { INestApplication } from '@nestjs/common';
import { cleanupRigs, expectProblemContentType, startFreshApp, type TestRig } from '../helpers';
import {
  seedPersonalWorld,
  seedPlaybackSessionRow,
  seedProgressState,
  type PersonalWorld,
} from '../unit/personal/personal-world';
import { registerPersonalPlaybackFactsPort } from '../../src/contexts/personal-data/application/progress-clock.service';
import { sharedRateLimitService } from '../../src/common/rate-limit/rate-limit.service';

/**
 * T141(005 · 限频证据归档;SC-006 限频部分 / contracts/api.md §1)。
 * 权威:tasks.md T141、rate-limit.policies.ts(数值权威:public 120 次/分钟/IP、
 * guide 30 次/分钟/IP、progress 60 次/分钟/DeviceSession)。
 *
 * 与既有 429 契约测试(public-guide.spec.ts §guide 限频、playback-progress.contract.spec.ts
 * §进度限频)同一构造方式:全新独立临时库 + 清空共享限频窗口后精确计数,真实打满窗口
 * 触发一次 429,断言 429 + Retry-After(秒,>0)+ problem+json + Cache-Control: no-store。
 * 本套件把三条策略各一次的「真实触发证据」集中归档,供 T141/T144 证据链引用:
 * - public:GET /api/public/media(控制器级 @RateLimit('public')),第 121 次 → 429;
 * - guide:GET /api/public/guide(@RateLimit('guide')),第 31 次 → 429;
 * - progress:POST /api/playback/sessions/{id}/progress(@RateLimit('progress')),
 *   同一 DeviceSession 第 61 次 → 429(启动样本 + duplicate 重放计数,与既有进度
 *   限频用例同口径)。
 * 注:本套件不重跑 SC-006 重型性能测量(guide-performance 已达标并随测试 attachment
 * sc006-metrics.json 归档),仅补限频证据;性能数字见 docs/specs/005-pc-browsing-flow/evidence-perf.md。
 */

function clearRateLimitWindows(): void {
  (sharedRateLimitService() as unknown as { windows: Map<string, number[]> }).windows.clear();
}

describe('T141 · 限频真实触发证据(public/guide/progress 三策略)', () => {
  let rig: TestRig;
  let app: INestApplication;
  let world: PersonalWorld;
  let cookieA: string;

  beforeEach(async () => {
    rig = await startFreshApp({ prefix: 'hmp-t141-rate-evidence-' });
    app = rig.app;
    // 种子即唯一家庭(单家庭部署模型:initialize 另建第二家庭会触发 503 STORAGE_GENERATION_UNSUPPORTED)
    world = seedPersonalWorld(rig);
    cookieA = `${SESSION_COOKIE}=${world.sessionAToken}`;
    registerPersonalPlaybackFactsPort({ trustedDurationSeconds: () => 3600 });
    clearRateLimitWindows();
  });

  afterEach(() => {
    registerPersonalPlaybackFactsPort(null);
    return cleanupRigs();
  });

  afterAll(async () => {
    // 与 sources-refresh.e2e-spec 同因:better-sqlite3 包装对象需在环境存活期收尾
    const gc = (globalThis as { gc?: () => void }).gc;
    if (typeof gc === 'function') {
      gc();
    }
    await new Promise((resolve) => setImmediate(resolve));
  });

  it('public 120 次/分钟/IP:第 121 次 GET /api/public/media → 429 + Retry-After + no-store', async () => {
    let lastOk = 0;
    for (let index = 0; index < 120; index += 1) {
      const res = await request(app.getHttpServer() as Parameters<typeof request>[0]).get('/api/public/media?pageSize=1');
      if (res.status !== 200) {
        // 未达窗口前不允许任何 429(出现即为本用例失败证据)
        expect(res.status, `第 ${index + 1} 次请求不应被限频`).not.toBe(429);
      }
      lastOk = res.status;
    }
    expect(lastOk).toBe(200);
    const overflow = await request(app.getHttpServer() as Parameters<typeof request>[0]).get('/api/public/media?pageSize=1');
    expect(overflow.status).toBe(429);
    expectProblemContentType(overflow);
    expect((overflow.body as { code?: string }).code).toBe('PLAYBACK_RATE_LIMITED');
    expect(overflow.headers['cache-control']).toBe('no-store');
    const retryAfter = Number(overflow.headers['retry-after']);
    expect(Number.isFinite(retryAfter), `Retry-After 应为秒数,实际 ${overflow.headers['retry-after']}`).toBe(true);
    expect(retryAfter).toBeGreaterThan(0);
  });

  it('guide 30 次/分钟/IP:第 31 次 GET /api/public/guide → 429 + Retry-After + no-store', async () => {
    for (let index = 0; index < 30; index += 1) {
      const res = await request(app.getHttpServer() as Parameters<typeof request>[0]).get('/api/public/guide?pageSize=1');
      expect(res.status, `第 ${index + 1} 次请求不应被限频`).toBe(200);
    }
    const overflow = await request(app.getHttpServer() as Parameters<typeof request>[0]).get('/api/public/guide?pageSize=1');
    expect(overflow.status).toBe(429);
    expectProblemContentType(overflow);
    expect((overflow.body as { code?: string }).code).toBe('PLAYBACK_RATE_LIMITED');
    expect(overflow.headers['cache-control']).toBe('no-store');
    const retryAfter = Number(overflow.headers['retry-after']);
    expect(Number.isFinite(retryAfter)).toBe(true);
    expect(retryAfter).toBeGreaterThan(0);
  });

  it('progress 60 次/分钟/DeviceSession:同一会话第 61 次 progress → 429 + Retry-After(跨会话不受影响)', async () => {
    // playing 会话(种子行)+ started 样本确认(形态与 playback-progress.contract.spec 一致)
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
    const progressUrl = `/api/playback/sessions/${handle.sessionId}/progress`;
    const post = (): request.Test =>
      request(app.getHttpServer())
        .post(progressUrl)
        .set('Cookie', cookieA)
        .send({ sampleSeq: 1, expectedGeneration: handle.generation, positionSeconds: 0, reason: 'started' });

    // 启动样本接受(1 次)+ duplicate 重放(59 次)= 60 次/分钟额度用满
    const first = await post();
    expect(first.status).toBe(200);
    for (let index = 0; index < 59; index += 1) {
      const res = await post();
      expect(res.status, `第 ${index + 2} 次样本不应被限频`).toBe(200);
    }
    const overflow = await post();
    expect(overflow.status).toBe(429);
    expectProblemContentType(overflow);
    expect((overflow.body as { code?: string }).code).toBe('PLAYBACK_RATE_LIMITED');
    expect(overflow.headers['cache-control']).toBe('no-store');
    const retryAfter = Number(overflow.headers['retry-after']);
    expect(Number.isFinite(retryAfter)).toBe(true);
    expect(retryAfter).toBeGreaterThan(0);

    // DeviceSession 维度对照:另一设备会话(B 的会话 Cookie,独立 session.id 桶)
    // 不共享额度,仍可写(限频 key = SessionGuard 会话的 deviceSession id;播放会话
    // 挂 B 会话的激活档案 B,pcv 与种子同基线 1,避免身份变化引入的上下文版本噪声)
    const second = seedPlaybackSessionRow({
      householdId: world.householdId,
      deviceSessionId: world.deviceSessionBId,
      deviceId: world.deviceIdB,
      profileId: world.profileBId,
      mediaId: world.vod.mediaId,
      playbackSourceId: world.vod.playbackSourceId,
      state: 'playing',
    });
    seedProgressState({
      householdId: world.householdId,
      playbackSessionId: second.sessionId,
      profileId: world.profileBId,
      mediaId: world.vod.mediaId,
      candidateEpoch: 2,
      contentRevision: 1,
      lastGeneration: second.generation,
    });
    const otherSession = await request(app.getHttpServer())
      .post(`/api/playback/sessions/${second.sessionId}/progress`)
      .set('Cookie', `${SESSION_COOKIE}=${world.sessionBToken}`)
      .send({ sampleSeq: 1, expectedGeneration: second.generation, positionSeconds: 0, reason: 'started' });
    expect(otherSession.status, `另一 DeviceSession 不应被同维度限频连带:${JSON.stringify(otherSession.body)}`).toBe(200);
  });

  it('限频响应携带稳定拒绝原因且不泄漏内部维度(键集合快照)', async () => {
    clearRateLimitWindows();
    for (let index = 0; index < 31; index += 1) {
      await request(app.getHttpServer() as Parameters<typeof request>[0]).get('/api/public/guide?pageSize=1');
    }
    const overflow = await request(app.getHttpServer() as Parameters<typeof request>[0]).get('/api/public/guide?pageSize=1');
    expect(overflow.status).toBe(429);
    const keys = Object.keys(overflow.body as Record<string, unknown>).sort();
    expect(keys.every((key) => ['type', 'title', 'status', 'code', 'detail'].includes(key)), `限频响应键应属 problem+json 白名单:${keys.join(',')}`).toBe(true);
    for (const required of ['type', 'title', 'status', 'code'] as const) {
      expect(keys, `限频响应应含 ${required}`).toContain(required);
    }
    expect((overflow.body as { code?: string }).code).toBe('PLAYBACK_RATE_LIMITED');
    expect(JSON.stringify(overflow.body), '稳定拒绝原因不得泄漏内部维度(key/窗口细节)').not.toMatch(/window|bucket|127\.0\.0\.1|key=/i);
  });
});
