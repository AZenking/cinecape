import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cleanupRigs, startFreshApp, type TestRig } from '../../helpers';
import {
  seedPersonalWorld,
  seedPlaybackSessionRow,
  seedProgressState,
  seedHistoryRow,
  readProgressStateRow,
  readHistoryRowFor,
  type PersonalWorld,
} from './personal-world';
import { ProgressWriteService } from '@contexts/personal-data/application/progress-write.service';
import { ProgressClockService, progressSampleDigest, registerPersonalPlaybackFactsPort } from '@contexts/personal-data/application/progress-clock.service';
import { getDb } from '@contexts/identity-access/infrastructure/db';
import {
  mediaItem,
  playbackProgressState,
  playbackSession,
  profileProgressClock,
} from '../../../src/database/schema';
import { and, eq } from 'drizzle-orm';
import { DomainError } from '../../../src/common/domain-error';

/**
 * T089(005 US4 单元测试,先 FAIL 后 GREEN)—— 进度写入状态机:
 *
 * 权威:data-model.md §5(epoch)/§6(playback_progress_state)/§7(写入状态转换 1~5)、
 * contracts/api.md §5 progress、research.md R6、ADR-0012。
 * 矩阵:
 * - resolve 分配 epoch:递增、可跳号、不重置、不接受客户端指定;直播不分配;
 *   resolve 只建 progress_state 不写可见历史;
 * - first started 写入权:历史无行/candidate_epoch>writer_epoch 取得写入权并 upsert;
 *   同 owner 继续;旧 candidate applied=false/superseded;较新 session 仅 resolve
 *   未起播不能抢占;
 * - started 门:默认 false;首次有效 started 后 true;periodic/pause 不可伪造首次;
 * - 允许 position 降低(无 MAX);seq/digest 幂等与冲突;stale;generation 冲突不消耗序号;
 * - sampleSeq 会话生命周期单调(换轨/seek 场景由 generation 携带,seq 不重置);
 * - duration 未知 409 PROGRESS_NOT_READY;资源修订变化 409 PROGRESS_RESOURCE_CHANGED;
 *   终态拒绝;直播 accepted 但不建历史。
 */

/** 会话/状态构造快捷方式 */
interface SessionHandle {
  readonly sessionId: string;
  readonly generation: number;
  readonly version: number;
}

describe('T089 · 进度写入状态机(data-model §5/§6/§7)', () => {
  let rig: TestRig;
  let world: PersonalWorld;
  let service: ProgressWriteService;
  let clockMs: number;

  beforeEach(async () => {
    rig = await startFreshApp({ prefix: 'hmp-t089-machine-' });
    world = seedPersonalWorld(rig);
    clockMs = Date.UTC(2026, 9, 23, 8, 0, 0);
    service = new ProgressWriteService({ now: () => clockMs });
    // 可信时长注入(单测缝:等价 resolver probe 事实缓存命中)
    registerPersonalPlaybackFactsPort({ trustedDurationSeconds: () => 3600 });
  });
  afterEach(() => {
    registerPersonalPlaybackFactsPort(null);
    return cleanupRigs();
  });

  /** 新建点播会话 + resolve 绑定形态 progress_state(epoch 由 clock 分配) */
  function newVodSession(options: { epoch?: number; profileId?: string; deviceSessionId?: string; deviceId?: string } = {}): SessionHandle {
    const handle = seedPlaybackSessionRow({
      householdId: world.householdId,
      deviceSessionId: options.deviceSessionId ?? world.deviceSessionAId,
      deviceId: options.deviceId ?? world.deviceIdA,
      profileId: options.profileId ?? world.profileAId,
      mediaId: world.vod.mediaId,
      playbackSourceId: world.vod.playbackSourceId,
      state: 'playing',
    });
    new ProgressClockService().bindVodResolveCandidate({
      householdId: world.householdId,
      profileId: options.profileId ?? world.profileAId,
      mediaId: world.vod.mediaId,
      playbackSessionId: handle.sessionId,
      profileContextVersion: 1,
    });
    if (options.epoch !== undefined) {
      // 模拟「跳号/服务端固定分配」:直改状态行 epoch(客户端没有任何 epoch 输入面)
      getDb()
        .update(playbackProgressState)
        .set({ candidateEpoch: options.epoch })
        .where(
          and(
            eq(playbackProgressState.householdId, world.householdId),
            eq(playbackProgressState.playbackSessionId, handle.sessionId),
          ),
        )
        .run();
    }
    return handle;
  }

  it('resolve 分配 epoch:递增、可跳号、不重置;直播不分配;客户端无 epoch 输入面', () => {
    const clock = new ProgressClockService();
    const bind = (sessionId: string): void =>
      clock.bindVodResolveCandidate({
        householdId: world.householdId,
        profileId: world.profileAId,
        mediaId: world.vod.mediaId,
        playbackSessionId: sessionId,
        profileContextVersion: 1,
      });
    const s1 = seedPlaybackSessionRow({
      householdId: world.householdId, deviceSessionId: world.deviceSessionAId, deviceId: world.deviceIdA,
      profileId: world.profileAId, mediaId: world.vod.mediaId, playbackSourceId: world.vod.playbackSourceId, state: 'preparing',
    });
    const s2 = seedPlaybackSessionRow({
      householdId: world.householdId, deviceSessionId: world.deviceSessionAId, deviceId: world.deviceIdA,
      profileId: world.profileAId, mediaId: world.vod.mediaId, playbackSourceId: world.vod.playbackSourceId, state: 'preparing',
    });
    bind(s1.sessionId);
    bind(s2.sessionId);
    const state1 = readProgressStateRow(world.householdId, s1.sessionId);
    const state2 = readProgressStateRow(world.householdId, s2.sessionId);
    expect(state1?.candidateEpoch).toBe(1);
    expect(state2?.candidateEpoch).toBe(2);
    const clockRow = getDb()
      .select()
      .from(profileProgressClock)
      .where(and(eq(profileProgressClock.householdId, world.householdId), eq(profileProgressClock.profileId, world.profileAId)))
      .get();
    expect(clockRow?.nextEpoch).toBe(3);

    // 可跳号:服务端把 next_epoch 拉高(等价某次分配后回滚的跳号),下一次分配不重置
    getDb()
      .update(profileProgressClock)
      .set({ nextEpoch: 10 })
      .where(and(eq(profileProgressClock.householdId, world.householdId), eq(profileProgressClock.profileId, world.profileAId)))
      .run();
    const s3 = seedPlaybackSessionRow({
      householdId: world.householdId, deviceSessionId: world.deviceSessionAId, deviceId: world.deviceIdA,
      profileId: world.profileAId, mediaId: world.vod.mediaId, playbackSourceId: world.vod.playbackSourceId, state: 'preparing',
    });
    bind(s3.sessionId);
    expect(readProgressStateRow(world.householdId, s3.sessionId)?.candidateEpoch).toBe(10);

    // 直播不分配:channel resolve 绑定不被调用(端口仅点播路径调用),无 clock 行/状态行的档案侧证明
    const clockB = getDb()
      .select()
      .from(profileProgressClock)
      .where(and(eq(profileProgressClock.householdId, world.householdId), eq(profileProgressClock.profileId, world.profileBId)))
      .get();
    expect(clockB).toBeUndefined();
  });

  it('resolve 只建 progress_state,不写可见历史', () => {
    const handle = newVodSession();
    expect(readProgressStateRow(world.householdId, handle.sessionId)).toBeDefined();
    expect(readHistoryRowFor(world.householdId, world.profileAId, world.vod.mediaId)).toBeUndefined();
    const state = readProgressStateRow(world.householdId, handle.sessionId);
    expect(state?.started).toBe(0);
    expect(state?.lastSampleSeq).toBe(0);
  });

  it('first started:历史无行 → 取得写入权并 upsert(revision=1,writer=本会话)', () => {
    const handle = newVodSession();
    const reply = service.applySample(
      { householdId: world.householdId, deviceSessionId: world.deviceSessionAId, sessionId: handle.sessionId },
      { sampleSeq: 1, expectedGeneration: handle.generation, positionSeconds: 120, reason: 'started' },
    );
    expect(reply).toEqual({ applied: true, reason: 'accepted', historyRevision: 1 });
    const history = readHistoryRowFor(world.householdId, world.profileAId, world.vod.mediaId);
    expect(history?.writerEpoch).toBe(1);
    expect(history?.writerPlaybackSessionId).toBe(handle.sessionId);
    expect(history?.positionSeconds).toBe(120);
    expect(history?.durationSeconds).toBe(3600);
    expect(readProgressStateRow(world.householdId, handle.sessionId)?.started).toBe(1);
  });

  it('first started:candidate_epoch > writer_epoch(旧 writer)→ 抢占 upsert;同 owner 继续', () => {
    // 旧 writer 的历史(epoch 1);新会话 epoch 3 → 抢占
    const oldSession = 'old-owner-session';
    seedHistoryRow({
      householdId: world.householdId, profileId: world.profileAId, mediaId: world.vod.mediaId,
      writerEpoch: 1, writerPlaybackSessionId: oldSession, lastSampleSeq: 5,
      contentRevision: 1, positionSeconds: 300, durationSeconds: 3600, revision: 4,
    });
    const handle = newVodSession({ epoch: 3 });
    const reply = service.applySample(
      { householdId: world.householdId, deviceSessionId: world.deviceSessionAId, sessionId: handle.sessionId },
      { sampleSeq: 1, expectedGeneration: handle.generation, positionSeconds: 20, reason: 'started' },
    );
    expect(reply.applied).toBe(true);
    expect(reply.historyRevision).toBe(5); // revision 实际更新递增
    const history = readHistoryRowFor(world.householdId, world.profileAId, world.vod.mediaId);
    expect(history?.writerEpoch).toBe(3);
    expect(history?.writerPlaybackSessionId).toBe(handle.sessionId);
    expect(history?.positionSeconds).toBe(20);

    // 同 owner 继续:后续样本继续更新(允许 position 降低)
    const reply2 = service.applySample(
      { householdId: world.householdId, deviceSessionId: world.deviceSessionAId, sessionId: handle.sessionId },
      { sampleSeq: 2, expectedGeneration: handle.generation, positionSeconds: 10, reason: 'periodic' },
    );
    expect(reply2).toEqual({ applied: true, reason: 'accepted', historyRevision: 6 });
    expect(readHistoryRowFor(world.householdId, world.profileAId, world.vod.mediaId)?.positionSeconds).toBe(10);
  });

  it('旧 candidate(较小 epoch)started → applied=false/superseded;不覆盖较新 owner', () => {
    // 较新 owner 已起播(epoch 5)
    seedHistoryRow({
      householdId: world.householdId, profileId: world.profileAId, mediaId: world.vod.mediaId,
      writerEpoch: 5, writerPlaybackSessionId: 'newer-session', lastSampleSeq: 2,
      contentRevision: 1, positionSeconds: 400, durationSeconds: 3600, revision: 7,
    });
    const staleSession = newVodSession({ epoch: 3 });
    const reply = service.applySample(
      { householdId: world.householdId, deviceSessionId: world.deviceSessionAId, sessionId: staleSession.sessionId },
      { sampleSeq: 1, expectedGeneration: staleSession.generation, positionSeconds: 50, reason: 'started' },
    );
    expect(reply).toEqual({ applied: false, reason: 'superseded', historyRevision: null });
    const history = readHistoryRowFor(world.householdId, world.profileAId, world.vod.mediaId);
    expect(history?.writerPlaybackSessionId).toBe('newer-session');
    expect(history?.positionSeconds).toBe(400);
    // superseded 会话仍可继续播放(后续样本同样 superseded,不报错)
    const reply2 = service.applySample(
      { householdId: world.householdId, deviceSessionId: world.deviceSessionAId, sessionId: staleSession.sessionId },
      { sampleSeq: 2, expectedGeneration: staleSession.generation, positionSeconds: 60, reason: 'periodic' },
    );
    expect(reply2.reason).toBe('superseded');
  });

  it('较新 session 仅 resolve 未起播不能抢占历史(写入权只在有效 started 转移)', () => {
    // 当前 owner(epoch 2)在写
    const owner = newVodSession({ epoch: 2 });
    service.applySample(
      { householdId: world.householdId, deviceSessionId: world.deviceSessionAId, sessionId: owner.sessionId },
      { sampleSeq: 1, expectedGeneration: owner.generation, positionSeconds: 100, reason: 'started' },
    );
    // 较新 session(epoch 9)仅 resolve(状态行存在、无 started 样本)
    const newer = newVodSession({ epoch: 9, deviceSessionId: world.deviceSessionBId, deviceId: world.deviceIdB, profileId: world.profileBId });
    expect(readProgressStateRow(world.householdId, newer.sessionId)?.started).toBe(0);
    // owner 继续写不被抢占
    const reply = service.applySample(
      { householdId: world.householdId, deviceSessionId: world.deviceSessionAId, sessionId: owner.sessionId },
      { sampleSeq: 2, expectedGeneration: owner.generation, positionSeconds: 110, reason: 'periodic' },
    );
    expect(reply.applied).toBe(true);
    expect(readHistoryRowFor(world.householdId, world.profileAId, world.vod.mediaId)?.writerPlaybackSessionId).toBe(owner.sessionId);
  });

  it('started 门:periodic/pause 不能伪造首次 started(409 PLAYBACK_NOT_READY);跨 generation seq 单调', () => {
    const handle = newVodSession();
    // 未 started 前 periodic 拒绝
    expect(() =>
      service.applySample(
        { householdId: world.householdId, deviceSessionId: world.deviceSessionAId, sessionId: handle.sessionId },
        { sampleSeq: 1, expectedGeneration: handle.generation, positionSeconds: 30, reason: 'periodic' },
      ),
    ).toThrowError(DomainError);
    // started(seq=1)→ 换轨/seek 升代(generation 2,version+1)→ seq 继续单调(不重置)
    service.applySample(
      { householdId: world.householdId, deviceSessionId: world.deviceSessionAId, sessionId: handle.sessionId },
      { sampleSeq: 1, expectedGeneration: handle.generation, positionSeconds: 30, reason: 'started' },
    );
    getDb().update(playbackSession)
      .set({ generation: 2, version: handle.version + 1 })
      .where(eq(playbackSession.id, handle.sessionId))
      .run();
    // 旧 generation 样本拒绝且不消耗序号
    expect(() =>
      service.applySample(
        { householdId: world.householdId, deviceSessionId: world.deviceSessionAId, sessionId: handle.sessionId },
        { sampleSeq: 2, expectedGeneration: handle.generation, positionSeconds: 40, reason: 'periodic' },
      ),
    ).toThrowError(DomainError);
    // 新 generation 新 seq 继续(上一条失败未消费 seq=2)
    const reply = service.applySample(
      { householdId: world.householdId, deviceSessionId: world.deviceSessionAId, sessionId: handle.sessionId },
      { sampleSeq: 2, expectedGeneration: 2, positionSeconds: 40, reason: 'periodic' },
    );
    expect(reply.applied).toBe(true);
    expect(readProgressStateRow(world.householdId, handle.sessionId)?.lastSampleSeq).toBe(2);
    expect(readProgressStateRow(world.householdId, handle.sessionId)?.lastGeneration).toBe(2);
  });

  it('seq 机器:同 seq 同 digest 幂等返回上次结果;异 digest 409 PROGRESS_SAMPLE_CONFLICT;seq<last stale_sample', () => {
    const handle = newVodSession();
    const context = { householdId: world.householdId, deviceSessionId: world.deviceSessionAId, sessionId: handle.sessionId };
    const first = service.applySample(context, { sampleSeq: 1, expectedGeneration: 1, positionSeconds: 100, reason: 'started' });
    expect(first).toEqual({ applied: true, reason: 'accepted', historyRevision: 1 });
    // 同 seq 同载荷重试(网络重试):返回上次结果,revision 不变
    const retry = service.applySample(context, { sampleSeq: 1, expectedGeneration: 1, positionSeconds: 100, reason: 'started' });
    expect(retry).toEqual({ applied: true, reason: 'accepted', historyRevision: 1 });
    expect(readHistoryRowFor(world.householdId, world.profileAId, world.vod.mediaId)?.revision).toBe(1);
    // 同 seq 异 digest → 409
    try {
      service.applySample(context, { sampleSeq: 1, expectedGeneration: 1, positionSeconds: 200, reason: 'started' });
      expect.unreachable();
    } catch (error) {
      expect((error as DomainError).status).toBe(409);
      expect((error as DomainError).code).toBe('PROGRESS_SAMPLE_CONFLICT');
    }
    // seq 前进后再收旧 seq → stale_sample,不覆盖
    service.applySample(context, { sampleSeq: 2, expectedGeneration: 1, positionSeconds: 150, reason: 'periodic' });
    const stale = service.applySample(context, { sampleSeq: 1, expectedGeneration: 1, positionSeconds: 100, reason: 'started' });
    expect(stale).toEqual({ applied: false, reason: 'stale_sample', historyRevision: null });
    expect(readHistoryRowFor(world.householdId, world.profileAId, world.vod.mediaId)?.positionSeconds).toBe(150);
  });

  it('generation 不同 → 409 PLAYBACK_GENERATION_STALE,不消耗新序号', () => {
    const handle = newVodSession();
    const context = { householdId: world.householdId, deviceSessionId: world.deviceSessionAId, sessionId: handle.sessionId };
    service.applySample(context, { sampleSeq: 1, expectedGeneration: 1, positionSeconds: 50, reason: 'started' });
    expect(() =>
      service.applySample(context, { sampleSeq: 2, expectedGeneration: 7, positionSeconds: 60, reason: 'periodic' }),
    ).toThrowError(DomainError);
    // 不消耗序号:正确 generation 的 seq=2 立即可接受
    const reply = service.applySample(context, { sampleSeq: 2, expectedGeneration: 1, positionSeconds: 60, reason: 'periodic' });
    expect(reply.applied).toBe(true);
  });

  it('允许 position 降低(后退 seek/从头播放),不使用 MAX(position)', () => {
    const handle = newVodSession();
    const context = { householdId: world.householdId, deviceSessionId: world.deviceSessionAId, sessionId: handle.sessionId };
    service.applySample(context, { sampleSeq: 1, expectedGeneration: 1, positionSeconds: 300, reason: 'started' });
    service.applySample(context, { sampleSeq: 2, expectedGeneration: 1, positionSeconds: 120, reason: 'pause' });
    expect(readHistoryRowFor(world.householdId, world.profileAId, world.vod.mediaId)?.positionSeconds).toBe(120);
    service.applySample(context, { sampleSeq: 3, expectedGeneration: 1, positionSeconds: 0, reason: 'periodic' });
    expect(readHistoryRowFor(world.householdId, world.profileAId, world.vod.mediaId)?.positionSeconds).toBe(0);
  });

  it('duration 未知 → 409 PROGRESS_NOT_READY(不由客户端提供);历史可信值兜底', () => {
    registerPersonalPlaybackFactsPort(null); // 无 probe 事实
    const handle = newVodSession();
    const context = { householdId: world.householdId, deviceSessionId: world.deviceSessionAId, sessionId: handle.sessionId };
    try {
      service.applySample(context, { sampleSeq: 1, expectedGeneration: 1, positionSeconds: 30, reason: 'started' });
      expect.unreachable();
    } catch (error) {
      expect((error as DomainError).code).toBe('PROGRESS_NOT_READY');
      expect((error as DomainError).status).toBe(409);
    }
    // 历史已有可信 duration(本会话为 owner)→ 兜底可用:started 可继续接受
    seedHistoryRow({
      householdId: world.householdId, profileId: world.profileAId, mediaId: world.vod.mediaId,
      writerEpoch: 1, writerPlaybackSessionId: handle.sessionId, contentRevision: 1,
      positionSeconds: 30, durationSeconds: 1800, revision: 2,
    });
    const reply = service.applySample(context, { sampleSeq: 1, expectedGeneration: 1, positionSeconds: 30, reason: 'started' });
    expect(reply).toEqual({ applied: true, reason: 'accepted', historyRevision: 3 });
    const reply2 = service.applySample(context, { sampleSeq: 2, expectedGeneration: 1, positionSeconds: 40, reason: 'periodic' });
    expect(reply2.applied).toBe(true);
  });

  it('资源修订变化 → 409 PROGRESS_RESOURCE_CHANGED;旧播放不改新资源历史', () => {
    const handle = newVodSession();
    getDb()
      .update(mediaItem)
      .set({ contentRevision: 2 })
      .where(eq(mediaItem.id, world.vod.mediaId))
      .run();
    try {
      service.applySample(
        { householdId: world.householdId, deviceSessionId: world.deviceSessionAId, sessionId: handle.sessionId },
        { sampleSeq: 1, expectedGeneration: 1, positionSeconds: 30, reason: 'started' },
      );
      expect.unreachable();
    } catch (error) {
      expect((error as DomainError).code).toBe('PROGRESS_RESOURCE_CHANGED');
    }
    expect(readHistoryRowFor(world.householdId, world.profileAId, world.vod.mediaId)).toBeUndefined();
  });

  it('会话终态后拒绝 progress(ended → PLAYBACK_ENDED;interrupted → PLAYBACK_NOT_READY)', () => {
    const ended = seedPlaybackSessionRow({
      householdId: world.householdId, deviceSessionId: world.deviceSessionAId, deviceId: world.deviceIdA,
      profileId: world.profileAId, mediaId: world.vod.mediaId, playbackSourceId: world.vod.playbackSourceId, state: 'ended',
    });
    seedProgressState({
      householdId: world.householdId, playbackSessionId: ended.sessionId, profileId: world.profileAId,
      mediaId: world.vod.mediaId, candidateEpoch: 1, started: true, lastSampleSeq: 1, lastGeneration: 1,
    });
    expect(() =>
      service.applySample(
        { householdId: world.householdId, deviceSessionId: world.deviceSessionAId, sessionId: ended.sessionId },
        { sampleSeq: 2, expectedGeneration: 1, positionSeconds: 30, reason: 'periodic' },
      ),
    ).toThrowError(DomainError);
  });

  it('直播会话:样本 accepted 但不建点播历史,historyRevision=null', () => {
    const channel = seedPlaybackSessionRow({
      householdId: world.householdId, deviceSessionId: world.deviceSessionAId, deviceId: world.deviceIdA,
      profileId: world.profileAId, mediaId: world.channel.mediaId, playbackSourceId: world.channel.playbackSourceId, state: 'playing',
    });
    const reply = service.applySample(
      { householdId: world.householdId, deviceSessionId: world.deviceSessionAId, sessionId: channel.sessionId },
      { sampleSeq: 1, expectedGeneration: 1, positionSeconds: 3600, reason: 'started' },
    );
    expect(reply).toEqual({ applied: true, reason: 'accepted', historyRevision: null });
    expect(readHistoryRowFor(world.householdId, world.profileAId, world.channel.mediaId)).toBeUndefined();
  });

  it('digest 规范化:同载荷必同摘要,异载荷必异摘要(幂等判定基准)', () => {
    expect(progressSampleDigest({ expectedGeneration: 1, positionSeconds: 120, reason: 'started' })).toBe(
      progressSampleDigest({ expectedGeneration: 1, positionSeconds: 120, reason: 'started' }),
    );
    expect(progressSampleDigest({ expectedGeneration: 1, positionSeconds: 120, reason: 'started' })).not.toBe(
      progressSampleDigest({ expectedGeneration: 1, positionSeconds: 121, reason: 'started' }),
    );
    expect(progressSampleDigest({ expectedGeneration: 1, positionSeconds: 120, reason: 'started' })).not.toBe(
      progressSampleDigest({ expectedGeneration: 1, positionSeconds: 120, reason: 'periodic' }),
    );
  });
});
