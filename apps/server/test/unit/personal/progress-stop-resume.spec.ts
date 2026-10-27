import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cleanupRigs, startFreshApp, type TestRig } from '../../helpers';
import {
  seedPersonalWorld,
  seedPlaybackSessionRow,
  seedHistoryRow,
  readHistoryRowFor,
  type PersonalWorld,
} from './personal-world';
import { ProgressClockService, registerPersonalPlaybackFactsPort } from '../../../src/modules/personal/progress-clock.service';
import { ProgressWriteService } from '../../../src/modules/personal/progress-write.service';
import { canResumeOf, getHistoryItem, readResumeFreezePosition } from '../../../src/modules/personal/history.service';
import {
  PlaybackLifecycleService,
  type LifecycleStoragePort,
  type LifecycleSupervisorPort,
  type PlaybackRevalidatePort,
} from '../../../src/modules/playback/playback-lifecycle.service';
import { PlaybackRepository } from '../../../src/modules/playback/playback.repository';
import { createPlaybackBudgets } from '../../../src/config/playback-budgets';
import { getConfig } from '../../../src/config/env';
import { switchDeviceSessionProfile } from '../../../src/modules/profile/identity-transition';
import { getDb } from '../../../src/modules/auth/db';
import { Database } from '../../../src/database/database';
import {
  mediaItem,
  playbackProgressState,
  playbackSession,
  deviceSession,
} from '../../../src/database/schema';
import { and, eq } from 'drizzle-orm';
import { DomainError } from '../../../src/common/domain-error';
import { createManualClock } from '../../fixtures/clock';

/**
 * T090(005 US4 单元测试,先 FAIL 后 GREEN)—— 停止终态与续播读取:
 *
 * 权威:api.md §5「stop 与最终保存」、data-model.md §7 写入状态转换 6/7 + 续播读取、
 * research.md R7、ADR-0012。
 * 矩阵:
 * - normal stop:final 与终态同事务(失败整体回滚不部分保存);stale final 停止成功但不覆盖;
 * - 已终态重复 stop 幂等,不接受新 final 更新,不能复活;无 started 的准备取消不建立历史;
 * - 未确认 started 即停止:final 拒绝(客户端改发空 stop),不伪造 final;
 * - logout/换档:先 final flush(≤1 秒预算)再身份变化;身份变化后旧写入拒绝;不串档;
 * - flush 不覆盖 superseded 历史(非 owner 换档不改变较新 owner 的续播位置);
 * - 续播读取:content_revision 不匹配/无效位置/到结尾/无可信 duration → canResume=false;
 *   缺少或无效位置 resume 从零,不删除旧历史。
 */

describe('T090 · 停止终态与续播读取(api §5 stop / data-model §7)', () => {
  let rig: TestRig;
  let world: PersonalWorld;
  let service: ProgressWriteService;
  let lifecycle: PlaybackLifecycleService;

  beforeEach(async () => {
    rig = await startFreshApp({ prefix: 'hmp-t090-stop-' });
    world = seedPersonalWorld(rig);
    const clockMs = Date.UTC(2026, 9, 23, 8, 0, 0);
    service = new ProgressWriteService({ now: () => clockMs });
    registerPersonalPlaybackFactsPort({ trustedDurationSeconds: () => 3600 });
    const storageFake: LifecycleStoragePort = {
      releaseSession: async () => undefined,
      releaseTask: async () => undefined,
      pendingCleanupTasks: () => [],
    };
    const supervisorFake: LifecycleSupervisorPort = { cancel: async () => undefined };
    const authorizationFake: PlaybackRevalidatePort = { revalidate: async () => undefined };
    lifecycle = new PlaybackLifecycleService({
      repository: new PlaybackRepository(Database.db, createPlaybackBudgets(getConfig())),
      authorization: authorizationFake,
      supervisor: supervisorFake,
      budgets: createPlaybackBudgets(getConfig()),
      clock: createManualClock({ startMs: clockMs }),
      storage: storageFake,
      progressFinal: service,
    });
  });

  afterEach(() => {
    registerPersonalPlaybackFactsPort(null);
    return cleanupRigs();
  });

  /** 点播会话 + resolve 绑定形态 progress_state(epoch 按 clock 顺序分配) */
  function newVodSession(state: 'preparing' | 'playing' | 'paused'): string {
    const handle = seedPlaybackSessionRow({
      householdId: world.householdId,
      deviceSessionId: world.deviceSessionAId,
      deviceId: world.deviceIdA,
      profileId: world.profileAId,
      mediaId: world.vod.mediaId,
      playbackSourceId: world.vod.playbackSourceId,
      state,
    });
    new ProgressClockService().bindVodResolveCandidate({
      householdId: world.householdId,
      profileId: world.profileAId,
      mediaId: world.vod.mediaId,
      playbackSessionId: handle.sessionId,
      profileContextVersion: 1,
    });
    return handle.sessionId;
  }

  function forceEpoch(sessionId: string, epoch: number): void {
    getDb()
      .update(playbackProgressState)
      .set({ candidateEpoch: epoch })
      .where(
        and(
          eq(playbackProgressState.householdId, world.householdId),
          eq(playbackProgressState.playbackSessionId, sessionId),
        ),
      )
      .run();
  }

  it('normal stop:同一事务先验证保存 finalProgress 再终态化(原子)', async () => {
    const sessionId = newVodSession('playing');
    service.applySample(
      { householdId: world.householdId, deviceSessionId: world.deviceSessionAId, sessionId },
      { sampleSeq: 1, expectedGeneration: 1, positionSeconds: 100, reason: 'started' },
    );
    const result = await lifecycle.stopSessionWithFinal(sessionId, {
      sampleSeq: 2, expectedGeneration: 1, positionSeconds: 130,
    });
    expect(result.ok).toBe(true);
    expect(getDb().select().from(playbackSession).where(eq(playbackSession.id, sessionId)).get()?.state).toBe('ended');
    const history = readHistoryRowFor(world.householdId, world.profileAId, world.vod.mediaId);
    expect(history?.positionSeconds).toBe(130);
    expect(history?.lastSampleSeq).toBe(2);
    expect(history?.revision).toBe(2);
  });

  it('final 与终态同事务:无效 final(generation 冲突)→ 整体回滚,会话仍活动、历史不变', async () => {
    const sessionId = newVodSession('playing');
    service.applySample(
      { householdId: world.householdId, deviceSessionId: world.deviceSessionAId, sessionId },
      { sampleSeq: 1, expectedGeneration: 1, positionSeconds: 100, reason: 'started' },
    );
    await expect(
      lifecycle.stopSessionWithFinal(sessionId, { sampleSeq: 2, expectedGeneration: 9, positionSeconds: 130 }),
    ).rejects.toThrowError(DomainError);
    expect(getDb().select().from(playbackSession).where(eq(playbackSession.id, sessionId)).get()?.state).toBe('playing');
    expect(readHistoryRowFor(world.householdId, world.profileAId, world.vod.mediaId)?.positionSeconds).toBe(100);
  });

  it('final 位置越界 → 400 且不部分保存;客户端可改发空 stop(成功且不改历史)', async () => {
    const sessionId = newVodSession('playing');
    service.applySample(
      { householdId: world.householdId, deviceSessionId: world.deviceSessionAId, sessionId },
      { sampleSeq: 1, expectedGeneration: 1, positionSeconds: 100, reason: 'started' },
    );
    try {
      await lifecycle.stopSessionWithFinal(sessionId, { sampleSeq: 2, expectedGeneration: 1, positionSeconds: 9999 });
      expect.unreachable('越界 final 必须拒绝');
    } catch (error) {
      expect((error as DomainError).status).toBe(400);
    }
    expect(getDb().select().from(playbackSession).where(eq(playbackSession.id, sessionId)).get()?.state).toBe('playing');
    const result = await lifecycle.stopSession(sessionId);
    expect(result.ok).toBe(true);
    expect(readHistoryRowFor(world.householdId, world.profileAId, world.vod.mediaId)?.positionSeconds).toBe(100);
  });

  it('stale final(seq<last)停止成功但不覆盖历史', async () => {
    const sessionId = newVodSession('playing');
    const context = { householdId: world.householdId, deviceSessionId: world.deviceSessionAId, sessionId };
    service.applySample(context, { sampleSeq: 1, expectedGeneration: 1, positionSeconds: 100, reason: 'started' });
    service.applySample(context, { sampleSeq: 2, expectedGeneration: 1, positionSeconds: 150, reason: 'periodic' });
    const result = await lifecycle.stopSessionWithFinal(sessionId, {
      sampleSeq: 1, expectedGeneration: 1, positionSeconds: 90,
    });
    expect(result.ok).toBe(true);
    expect(getDb().select().from(playbackSession).where(eq(playbackSession.id, sessionId)).get()?.state).toBe('ended');
    expect(readHistoryRowFor(world.householdId, world.profileAId, world.vod.mediaId)?.positionSeconds).toBe(150);
  });

  it('已终态重复 stop 幂等:不接受新 final 更新,不能复活', async () => {
    const sessionId = newVodSession('playing');
    service.applySample(
      { householdId: world.householdId, deviceSessionId: world.deviceSessionAId, sessionId },
      { sampleSeq: 1, expectedGeneration: 1, positionSeconds: 100, reason: 'started' },
    );
    await lifecycle.stopSession(sessionId);
    const before = readHistoryRowFor(world.householdId, world.profileAId, world.vod.mediaId);
    const result = await lifecycle.stopSessionWithFinal(sessionId, {
      sampleSeq: 5, expectedGeneration: 1, positionSeconds: 999,
    });
    expect(result.ok).toBe(true);
    expect(getDb().select().from(playbackSession).where(eq(playbackSession.id, sessionId)).get()?.state).toBe('ended');
    expect(readHistoryRowFor(world.householdId, world.profileAId, world.vod.mediaId)).toEqual(before);
  });

  it('无 started 的准备取消:空 stop 不建立历史;final 不可伪造(409 后改发空 stop 成功)', async () => {
    const sessionId = newVodSession('preparing');
    expect(readHistoryRowFor(world.householdId, world.profileAId, world.vod.mediaId)).toBeUndefined();
    try {
      await lifecycle.stopSessionWithFinal(sessionId, { sampleSeq: 1, expectedGeneration: 1, positionSeconds: 50 });
      expect.unreachable('未确认 started 的 final 必须拒绝');
    } catch (error) {
      expect((error as DomainError).status).toBe(409);
    }
    expect(getDb().select().from(playbackSession).where(eq(playbackSession.id, sessionId)).get()?.state).toBe('preparing');
    const result = await lifecycle.stopSession(sessionId);
    expect(result.ok).toBe(true);
    expect(readHistoryRowFor(world.householdId, world.profileAId, world.vod.mediaId)).toBeUndefined();
  });

  it('logout/换档:先 final flush 再身份变化;身份变化后旧上下文终态化、旧写入拒绝、不串档', () => {
    const sessionId = newVodSession('playing');
    service.applySample(
      { householdId: world.householdId, deviceSessionId: world.deviceSessionAId, sessionId },
      { sampleSeq: 1, expectedGeneration: 1, positionSeconds: 100, reason: 'started' },
    );
    // heartbeat 维护的服务端位置推进到 300(客户端未及上报 final 即换档)
    getDb().update(playbackSession).set({ positionSeconds: 300 }).where(eq(playbackSession.id, sessionId)).run();

    getDb().transaction((tx) => {
      switchDeviceSessionProfile(tx, {
        householdId: world.householdId,
        sessionId: world.deviceSessionAId,
        fromProfileId: world.profileAId,
        toProfileId: world.profileBId,
      });
    });
    // flush:历史位置已推进到 300(最后确认值 100 → flush 300;远小于 1 秒预算)
    const history = readHistoryRowFor(world.householdId, world.profileAId, world.vod.mediaId);
    expect(history?.positionSeconds).toBe(300);
    expect(history?.revision).toBe(2);
    // 旧上下文播放被身份变化事务终态化(interrupted),context version 递增
    expect(getDb().select().from(playbackSession).where(eq(playbackSession.id, sessionId)).get()?.state).toBe('interrupted');
    expect(getDb().select().from(deviceSession).where(eq(deviceSession.id, world.deviceSessionAId)).get()?.profileContextVersion).toBe(2);
    // 身份变化之后旧进度写入拒绝(状态机层:终态拒绝;端点层由上下文版本重验 404)
    expect(() =>
      service.applySample(
        { householdId: world.householdId, deviceSessionId: world.deviceSessionAId, sessionId },
        { sampleSeq: 2, expectedGeneration: 1, positionSeconds: 320, reason: 'periodic' },
      ),
    ).toThrowError(DomainError);
    // B 档案读取同媒体:无个人记录(null),不串档
    expect(getHistoryItem({ householdId: world.householdId, profileId: world.profileBId, mediaId: world.vod.mediaId })).toBeNull();
  });

  it('flush 不覆盖 superseded 历史:非 owner 会话换档不改变较新 owner 的续播位置', () => {
    // 较新 owner(epoch 5)持有历史;本会话 epoch 3(旧 candidate,started 后仅 superseded)
    seedHistoryRow({
      householdId: world.householdId, profileId: world.profileAId, mediaId: world.vod.mediaId,
      writerEpoch: 5, writerPlaybackSessionId: 'newer-owner-session', contentRevision: 1,
      positionSeconds: 400, durationSeconds: 3600, revision: 3,
    });
    const sessionId = newVodSession('playing');
    forceEpoch(sessionId, 3);
    service.applySample(
      { householdId: world.householdId, deviceSessionId: world.deviceSessionAId, sessionId },
      { sampleSeq: 1, expectedGeneration: 1, positionSeconds: 100, reason: 'started' },
    );
    getDb().update(playbackSession).set({ positionSeconds: 320 }).where(eq(playbackSession.id, sessionId)).run();
    getDb().transaction((tx) => {
      switchDeviceSessionProfile(tx, {
        householdId: world.householdId,
        sessionId: world.deviceSessionAId,
        fromProfileId: world.profileAId,
        toProfileId: world.profileBId,
      });
    });
    // flush 只作用 owner:较新 owner 的 400 不被 320 覆盖
    expect(readHistoryRowFor(world.householdId, world.profileAId, world.vod.mediaId)?.positionSeconds).toBe(400);
  });

  it('canResume:available + 同修订 + 可信 duration + 0<position<duration 才 true', () => {
    expect(canResumeOf({ available: true, currentRevision: 1, historyRevision: 1, positionSeconds: 120, durationSeconds: 3600 })).toBe(true);
    expect(canResumeOf({ available: true, currentRevision: 2, historyRevision: 1, positionSeconds: 120, durationSeconds: 3600 })).toBe(false);
    expect(canResumeOf({ available: true, currentRevision: 1, historyRevision: 1, positionSeconds: 120, durationSeconds: null })).toBe(false);
    expect(canResumeOf({ available: true, currentRevision: 1, historyRevision: 1, positionSeconds: 3600, durationSeconds: 3600 })).toBe(false);
    expect(canResumeOf({ available: true, currentRevision: 1, historyRevision: 1, positionSeconds: Number.NaN, durationSeconds: 3600 })).toBe(false);
    expect(canResumeOf({ available: true, currentRevision: 1, historyRevision: 1, positionSeconds: 0, durationSeconds: 3600 })).toBe(false);
    expect(canResumeOf({ available: false, currentRevision: 1, historyRevision: 1, positionSeconds: 120, durationSeconds: 3600 })).toBe(false);
  });

  it('续播冻结读取:同修订可信位置返回位置;无效/到尾/修订变化/无时长返回 0;不删除旧历史', () => {
    const input = { householdId: world.householdId, profileId: world.profileAId, mediaId: world.vod.mediaId };
    seedHistoryRow({
      householdId: world.householdId, profileId: world.profileAId, mediaId: world.vod.mediaId,
      writerEpoch: 1, writerPlaybackSessionId: 's1', contentRevision: 1,
      positionSeconds: 120, durationSeconds: 3600, revision: 1,
    });
    expect(readResumeFreezePosition({ ...input, probeDurationSeconds: 3600 })).toBe(120);
    // 到结尾 → 0
    seedHistoryRow({
      householdId: world.householdId, profileId: world.profileAId, mediaId: world.vod.mediaId,
      writerEpoch: 1, writerPlaybackSessionId: 's1', contentRevision: 1,
      positionSeconds: 3600, durationSeconds: 3600, revision: 2,
    });
    expect(readResumeFreezePosition({ ...input, probeDurationSeconds: 3600 })).toBe(0);
    // 无可信 duration(历史 null + probe null)→ 0;probe 提供后以更小者为界恢复续播
    seedHistoryRow({
      householdId: world.householdId, profileId: world.profileAId, mediaId: world.vod.mediaId,
      writerEpoch: 1, writerPlaybackSessionId: 's1', contentRevision: 1,
      positionSeconds: 120, durationSeconds: null, revision: 3,
    });
    expect(readResumeFreezePosition({ ...input, probeDurationSeconds: null })).toBe(0);
    expect(readResumeFreezePosition({ ...input, probeDurationSeconds: 3000 })).toBe(120);
    // 资源修订变化 → 0(旧历史保留,从零开始不删除)
    seedHistoryRow({
      householdId: world.householdId, profileId: world.profileAId, mediaId: world.vod.mediaId,
      writerEpoch: 1, writerPlaybackSessionId: 's1', contentRevision: 1,
      positionSeconds: 120, durationSeconds: 3600, revision: 4,
    });
    getDb().update(mediaItem).set({ contentRevision: 2 }).where(eq(mediaItem.id, world.vod.mediaId)).run();
    expect(readResumeFreezePosition({ ...input, probeDurationSeconds: 3600 })).toBe(0);
    expect(readHistoryRowFor(world.householdId, world.profileAId, world.vod.mediaId)).toBeDefined();
    // 无历史(另一 Profile)→ 0 从头
    expect(readResumeFreezePosition({ householdId: world.householdId, profileId: world.profileBId, mediaId: world.vod.mediaId, probeDurationSeconds: 3600 })).toBe(0);
  });

  it('单条历史读取:HistoryItem 含 canResume,不公开 writer epoch/会话标识;无记录返回 null', () => {
    const input = { householdId: world.householdId, profileId: world.profileAId, mediaId: world.vod.mediaId };
    expect(getHistoryItem(input)).toBeNull();
    seedHistoryRow({
      householdId: world.householdId, profileId: world.profileAId, mediaId: world.vod.mediaId,
      writerEpoch: 1, writerPlaybackSessionId: 'opaque-session', contentRevision: 1,
      positionSeconds: 120, durationSeconds: 3600, revision: 1,
    });
    const item = getHistoryItem(input);
    expect(item?.canResume).toBe(true);
    expect(item?.positionSeconds).toBe(120);
    const serialized = JSON.stringify(item);
    expect(serialized).not.toContain('opaque-session');
    expect(serialized).not.toContain('writerEpoch');
  });
});
