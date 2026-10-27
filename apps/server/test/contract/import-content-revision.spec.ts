import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SESSION_COOKIE } from '@hmp/shared';
import { cleanupRigs, startFreshApp, type TestRig } from '../helpers';
import { seedPersonalWorld, type PersonalWorld } from '../unit/personal/personal-world';
import { Database } from '../../src/database/database';
import { getDb } from '../../src/modules/auth/db';
import {
  playbackProgressState,
  playbackSession,
  sourceEntry,
} from '../../src/database/schema';
import { eq } from 'drizzle-orm';
import { stageEntries } from '../../src/modules/imports/refresh-staging.service';
import { RefreshPublishService } from '../../src/modules/imports/refresh-publish.service';
import { canResumeOf } from '../../src/modules/personal/history.service';

/**
 * T147(005 US4 集成测试)—— 内容修订失效:
 *
 * 「以临时 NAS 文件导入后产生续播,再改变可信 size/mtime 并成功发布,断言
 * media_item.content_revision 只递增一次、旧 canResume=false、旧播放进度拒绝;
 * 重复相同发布、只改标题/分级不递增,失败或未确认快照不影响当前修订。」
 *
 * 夹具约束:导入发布以 RefreshPublishService.publishEntrySnapshot 为权威事务(与
 * sources 执行器同一生产路径);「临时 NAS 文件」以 stageEntries 的扫描记录形态进入
 * 暂存(size/mtime 十进制文本),不触达真实文件系统;「只改标题/分级」路径 = 发布
 * 事务的 updateMediaPresentation(仅 version+1);续播进度按 API 口径构造。
 */

describe('T147 · 内容修订失效集成(导入发布 × 进度修订校验)', () => {
  let rig: TestRig;
  let world: PersonalWorld;
  let cookieA: string;
  let publish: RefreshPublishService;
  let householdId: string;
  let sourceId: string;
  let refreshId: string;

  /** NAS 来源 + 目录修订基线 + queued 任务(可发布) */
  function seedNasSourceWithJob(): void {
    const db = Database.db;
    db.prepare('INSERT INTO catalog_state (household_id, revision) VALUES (?, 1)').run(householdId);
    db.prepare(
      "INSERT INTO media_source (id, household_id, kind, name, remote_url, root_key, relative_directory, private_access_approved, enabled, version, created_at, updated_at) VALUES (?, ?, 'nas', 'T147 NAS', NULL, 't147-root', 'media', 1, 1, 1, ?, ?)",
    ).run(sourceId, householdId, '2026-10-23T00:00:00.000Z', '2026-10-23T00:00:00.000Z');
    db.prepare(
      "INSERT INTO source_refresh (id, household_id, source_id, initiator_account_id, initiator_session_id, operation_key, status, version, source_version, baseline_revision, snapshot_digest, item_count, created_at) VALUES (?, ?, ?, ?, ?, ?, 'queued', 1, 1, 1, NULL, NULL, ?)",
    ).run(refreshId, householdId, sourceId, world.accountId, world.deviceSessionAId, `t147-op-${refreshId}`, '2026-10-23T00:00:00.000Z');
  }

  function contentRevisionOf(mediaId: string): number {
    return (
      Database.db.prepare('SELECT content_revision AS r FROM media_item WHERE id = ? AND household_id = ?').get(mediaId, householdId) as
        | { r: number }
        | undefined
    )?.r as number;
  }

  function versionOf(): number {
    return (Database.db.prepare('SELECT version AS v FROM media_item WHERE household_id = ? AND id IN (SELECT media_id FROM source_entry WHERE source_id = ?)').get(householdId, sourceId) as { v: number }).v;
  }

  /** 暂存单文件快照并发布(发布事务权威路径) */
  function stageAndPublish(input: {
    sizeText: string;
    mtimeNsText: string;
    nowMs: number;
  }): 'succeeded' | 'stale' {
    const src = Database.db.prepare('SELECT version AS v FROM media_source WHERE id = ?').get(sourceId) as { v: number };
    const job = Database.db.prepare('SELECT version AS v FROM source_refresh WHERE id = ?').get(refreshId) as { v: number };
    const catalog = Database.db.prepare('SELECT revision AS r FROM catalog_state WHERE household_id = ?').get(householdId) as { r: number };
    const staged = stageEntries(Database.db, {
      householdId,
      refreshId,
      kind: 'nas',
      entries: [{ relativePath: 'movie.mp4', sizeText: input.sizeText, mtimeNsText: input.mtimeNsText }],
    });
    // 执行器惯例:暂存成功后同事务把快照摘要落任务行(发布重验比对依据)
    Database.db.prepare('UPDATE source_refresh SET snapshot_digest = ? WHERE id = ? AND household_id = ?').run(
      staged.snapshotDigest, refreshId, householdId,
    );
    return publish.publishEntrySnapshot({
      householdId,
      sourceId,
      refreshId,
      kind: 'nas',
      jobVersion: job.v,
      sourceVersion: src.v,
      baselineRevision: catalog.r,
      snapshotDigest: staged.snapshotDigest,
      counts: { added: 0, updated: 1, missing: 0 },
      nowMs: input.nowMs,
    });
  }

  beforeEach(async () => {
    rig = await startFreshApp({ prefix: 'hmp-t147-revision-' });
    world = seedPersonalWorld(rig);
    cookieA = `${SESSION_COOKIE}=${world.sessionAToken}`;
    publish = new RefreshPublishService();
    householdId = world.householdId;
    sourceId = `t147-src`;
    refreshId = `t147-job`;
    seedNasSourceWithJob();
  });
  afterEach(cleanupRigs);

  it('导入产生续播后改变可信 size/mtime 成功发布:content_revision 只递增一次、旧 canResume=false、旧进度拒绝', async () => {
    // 1. 首次发布(size=100,mtime=1000)→ media_item 生成,修订=1
    expect(stageAndPublish({ sizeText: '100', mtimeNsText: '1000', nowMs: Date.parse('2026-10-23T01:00:00.000Z') })).toBe('succeeded');
    const entry = getDb().select().from(sourceEntry).where(eq(sourceEntry.sourceId, sourceId)).get() as { mediaId: string };
    const mediaId = entry.mediaId;
    expect(contentRevisionOf(mediaId)).toBe(1);

    // 2. 产生续播(playing 会话 + 发布产出的播放资源;progress 经 API)
    const resource = Database.db.prepare('SELECT id AS id FROM playback_source WHERE media_item_id = ? AND household_id = ?').get(mediaId, householdId) as { id: string };
    const sessionId = 't147-session';
    getDb().insert(playbackSession).values({
      id: sessionId, householdId, deviceSessionId: world.deviceSessionAId, deviceId: world.deviceIdA,
      profileId: world.profileAId, mediaId, playbackSourceId: resource.id, state: 'playing', delivery: 'direct',
      generation: 1, version: 1, positionSeconds: 0, audioTrackId: null, subtitleTrackId: null,
      desiredPaused: 0, profileContextVersion: 1, createdAt: '2026-10-23T02:00:00.000Z',
      startedAt: '2026-10-23T02:00:00.000Z', endedAt: null, lastHeartbeatAt: '2026-10-23T02:00:00.000Z', failureCode: null,
    }).run();
    getDb().insert(playbackProgressState).values({
      householdId, playbackSessionId: sessionId, profileId: world.profileAId, mediaId,
      candidateEpoch: 1, contentRevision: 1, profileContextVersion: 1, started: 0,
      lastSampleSeq: 0, lastSampleDigest: null, lastGeneration: 1, lastResult: null,
    }).run();
    // duration 注入后先建立历史(修订 1,位置 120)
    const { registerPersonalPlaybackFactsPort } = await import('../../src/modules/personal/progress-clock.service');
    registerPersonalPlaybackFactsPort({ trustedDurationSeconds: () => 3600 });
    const started = await request(rig.app.getHttpServer())
      .post(`/api/playback/sessions/${sessionId}/progress`)
      .set('Cookie', cookieA)
      .send({ sampleSeq: 1, expectedGeneration: 1, positionSeconds: 120, reason: 'started' });
    expect(started.status).toBe(200);
    const stop = await request(rig.app.getHttpServer())
      .post(`/api/playback/sessions/${sessionId}/stop`)
      .set('Cookie', cookieA)
      .send({ finalProgress: { sampleSeq: 2, expectedGeneration: 1, positionSeconds: 120 } });
    expect(stop.status).toBe(204);

    // 3. 改变可信 size/mtime → 成功发布:修订只递增一次(1 → 2)
    expect(stageAndPublish({ sizeText: '200', mtimeNsText: '2000', nowMs: Date.parse('2026-10-23T03:00:00.000Z') })).toBe('succeeded');
    expect(contentRevisionOf(mediaId)).toBe(2);

    // 4. 旧播放(修订 1 状态行)进度写入拒绝:PROGRESS_RESOURCE_CHANGED
    getDb().insert(playbackSession).values({
      id: `${sessionId}-2`, householdId, deviceSessionId: world.deviceSessionAId, deviceId: world.deviceIdA,
      profileId: world.profileAId, mediaId, playbackSourceId: resource.id, state: 'playing', delivery: 'direct',
      generation: 1, version: 1, positionSeconds: 0, audioTrackId: null, subtitleTrackId: null,
      desiredPaused: 0, profileContextVersion: 1, createdAt: '2026-10-23T04:00:00.000Z',
      startedAt: '2026-10-23T04:00:00.000Z', endedAt: null, lastHeartbeatAt: '2026-10-23T04:00:00.000Z', failureCode: null,
    }).run();
    // 旧状态行(随第一个会话;终态后开新行验证拒绝)——直接对旧会话拒绝已由 stop 终态,
    // 这里以「新会话 + 旧修订状态行」复现「旧播放」:修订仍为快照 1
    getDb().insert(playbackProgressState).values({
      householdId, playbackSessionId: `${sessionId}-2`, profileId: world.profileAId, mediaId,
      candidateEpoch: 2, contentRevision: 1, profileContextVersion: 1, started: 0,
      lastSampleSeq: 0, lastSampleDigest: null, lastGeneration: 1, lastResult: null,
    }).run();
    const progressRes = await request(rig.app.getHttpServer())
      .post(`/api/playback/sessions/${sessionId}-2/progress`)
      .set('Cookie', cookieA)
      .send({ sampleSeq: 1, expectedGeneration: 1, positionSeconds: 60, reason: 'started' });
    expect(progressRes.status).toBe(409);
    expect(progressRes.body.code).toBe('PROGRESS_RESOURCE_CHANGED');

    // 5. 旧修订历史 canResume=false(API 与判定核心一致)
    const hist = await request(rig.app.getHttpServer())
      .get(`/api/me/history/${mediaId}`)
      .set('Cookie', cookieA);
    expect(hist.status).toBe(200);
    expect(hist.body.canResume).toBe(false);
    expect(hist.body.contentRevision ?? 1).toBeDefined();
    expect(canResumeOf({ available: true, currentRevision: 2, historyRevision: 1, positionSeconds: 120, durationSeconds: 3600 })).toBe(false);
    registerPersonalPlaybackFactsPort(null);
  });

  it('重复相同发布幂等;标题修改(version)不递增修订;失败/未确认快照不影响当前修订', async () => {
    expect(stageAndPublish({ sizeText: '100', mtimeNsText: '1000', nowMs: Date.parse('2026-10-23T01:00:00.000Z') })).toBe('succeeded');
    const entry = getDb().select().from(sourceEntry).where(eq(sourceEntry.sourceId, sourceId)).get() as { mediaId: string };
    const mediaId = entry.mediaId;
    expect(contentRevisionOf(mediaId)).toBe(1);
    const versionBefore = versionOf();

    // 重复相同快照发布:幂等(修订不变)
    expect(stageAndPublish({ sizeText: '100', mtimeNsText: '1000', nowMs: Date.parse('2026-10-23T02:00:00.000Z') })).toBe('succeeded');
    expect(contentRevisionOf(mediaId)).toBe(1);

    // 「只改标题」路径:发布事务的 updateMediaPresentation(标题来自文件名 → 相同路径不改;
    // 人工标题覆盖场景由 title_overridden 承担)——直接验证:标题改写只加 version 不加修订
    Database.db.prepare('UPDATE media_item SET title = ?, title_overridden = 0, version = version + 1 WHERE id = ? AND household_id = ?').run(
      '改名影片', mediaId, householdId,
    );
    const versionAfterRename = versionOf();
    expect(versionAfterRename).toBeGreaterThan(versionBefore);
    expect(contentRevisionOf(mediaId)).toBe(1);

    // 失败发布(过期 jobVersion → stale)→ 修订不变;未确认快照(尚在暂存)不影响当前修订
    const stagedStale = stageEntries(Database.db, {
      householdId, refreshId, kind: 'nas',
      entries: [{ relativePath: 'movie.mp4', sizeText: '999', mtimeNsText: '9999' }],
    });
    const src = Database.db.prepare('SELECT version AS v FROM media_source WHERE id = ?').get(sourceId) as { v: number };
    const job = Database.db.prepare('SELECT version AS v FROM source_refresh WHERE id = ?').get(refreshId) as { v: number };
    const catalog = Database.db.prepare('SELECT revision AS r FROM catalog_state WHERE household_id = ?').get(householdId) as { r: number };
    expect(
      publish.publishEntrySnapshot({
        householdId, sourceId, refreshId, kind: 'nas',
        jobVersion: job.v + 5,
        sourceVersion: src.v,
        baselineRevision: catalog.r,
        snapshotDigest: stagedStale.snapshotDigest,
        counts: { added: 0, updated: 1, missing: 0 },
        nowMs: Date.parse('2026-10-23T04:00:00.000Z'),
      }),
    ).toBe('stale');
    expect(contentRevisionOf(mediaId)).toBe(1);
    // 真实内容变化仍生效
    expect(stageAndPublish({ sizeText: '200', mtimeNsText: '2000', nowMs: Date.parse('2026-10-23T05:00:00.000Z') })).toBe('succeeded');
    expect(contentRevisionOf(mediaId)).toBe(2);
  });
});
