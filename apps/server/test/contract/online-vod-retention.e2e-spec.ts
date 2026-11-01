import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { afterEach, describe, expect, it } from 'vitest';
import type { INestApplication } from '@nestjs/common';
import { ProblemCode } from '@hmp/shared';
import { Database } from '@platform/database/database';
import { getDb } from '@platform/database/drizzle';
import { mediaItem, mediaSource, playbackFinishReceipt, playbackSession, vodSourceConfig } from '@platform/database/schema';
import { VodRetentionService, emptyVodRetentionSweepOutcome } from '@contexts/online-vod/application/vod-retention.service';
import {
  clearVodMaterializationTargets,
  registerVodMaterializationTarget,
} from '@contexts/online-vod/interface/materialization.controller';
import type { ResolvedMaterializationTarget } from '@contexts/online-vod/application/materialization.service';
import {
  cleanupRigs,
  cookiePairOf,
  expectProblemContentType,
  initialize,
  login,
  startFreshApp,
  type TestRig,
} from '../helpers';
import { selectMainAndUnlockSettings } from '../helpers-management';

/**
 * T084(010-online-vod · US5 · Phase 8)—— vod 保留清扫契约 e2e:物化 24h 保护后按
 * 引用图整组清理。
 *
 * 权威依据(逐组对照):
 * - docs/specs/010-online-vod/contracts/api.md §3 物化 24h 目标保护段(配额满 409 不挤占
 *   既有目标;目标 24h 受回收保护;清理后新 key 可物化);
 * - docs/specs/010-online-vod/data-model.md §4(10 源/5000 父/100000 子;未观看且无历史/
 *   名单/会话FK/意图/幂等保护/其他持久引用的组,materialized_at 至少 24h 后才可整组清理,
 *   ID 不复用;先过期幂等/意图,再按完整引用图清理;活动/保留终态记录不能破坏 FK;
 *   schema 不能靠删除历史释放配额)+ §9(保留/watchdog)+ §10(偏好 operation 24h 清理
 *   不删偏好;计划受引用保护;registered_candidate 24h 与 operation 联合回收);
 * - docs/specs/010-online-vod/tasks.md T084(T081 报告移交:vod_registered_candidate 的
 *   24h 清理归本任务)。
 *
 * 装配方式(沿用 T024 contract rig 惯例,不改共享 rig/helpers/fixtures/源码):
 * - startFreshApp(随机 DATA_DIR + 全量权威 DDL) + initialize/login/selectMainAndUnlockSettings
 *   身份 seed + Supertest 真实 HTTP;清扫经 app.get(VodRetentionService).runRetentionSweep()
 *   独立可测入口显式触发(生产节拍链由 VodRetentionBootstrapper 每日武装,24h 间隔不与
 *   用例窗口交叠);
 * - T031 登记桥接线(设计内合法形态):合成 ref 直种稳定/候选目标(生产装配零注册),
 *   物化仍受事务内 CAS/策略/配额全量重验;
 * - DB 直改仅用于无 HTTP 语义的工厂事实:24h 保护窗到期(vod_title.materialized_at)、
 *   幂等 operation/登记候选固定保留到期(committed_at/expires_at 成对置过去,CHECK 保持)、
 *   引用行种子(会话/receipt/意图/历史/名单 —— 复合 FK/CHECK 全满足),逐处注明。
 */

/* ------------------------------------------------------------------ */
/* 物化请求面(T024 同款;仅本文件所需目标)                               */
/* ------------------------------------------------------------------ */

const MATERIALIZE_PATH = '/api/vod/materializations';
const PREFERENCES_PATH = '/api/me/vod/preferences';

interface MaterializedDto {
  parentMediaId: string;
  mediaId: string;
  detailRevision: number;
  catalogRevision: number;
  replayed: boolean;
  candidateRef: string | null;
  registeredCandidateRef: string | null;
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface FixtureTarget {
  titleRef: string;
  episodeRef: string;
}

/** 占位候选引用(I1:服务端签发形态;本 rig 直种绑定) */
function forgedCandidateRef(): string {
  return `vod-candidate-fixture-${randomUUID()}`;
}

function stableRefBody(target: FixtureTarget, operationKey: string = randomUUID(), previewRevision = 1): Record<string, unknown> {
  return { titleRef: target.titleRef, episodeRef: target.episodeRef, previewRevision, operationKey };
}

function candidateBody(candidateRef: string, operationKey: string = randomUUID(), previewRevision = 1): Record<string, unknown> {
  return { candidateRef, previewRevision, operationKey };
}

function postMaterialize(app: INestApplication, cookie: string, body: Record<string, unknown>): request.Test {
  return request(app.getHttpServer()).post(MATERIALIZE_PATH).set('Cookie', cookie).send(body);
}

function expectProblem(res: request.Response, status: number, code: string): void {
  expect(res.status).toBe(status);
  expectProblemContentType(res);
  expect(res.body.code).toBe(code);
}

/* ------------------------------------------------------------------ */
/* rig:身份 seed + 夹具来源 + 登记桥直种                                 */
/* ------------------------------------------------------------------ */

interface SeededRig {
  readonly app: INestApplication;
  readonly cookie: string;
  readonly householdId: string;
  readonly retention: VodRetentionService;
  readonly sourceId: string;
}

async function seedSession(app: INestApplication): Promise<string> {
  expect((await initialize(app)).status).toBe(201);
  const loggedIn = await login(app, 'admin', 'password-123');
  expect(loggedIn.status).toBe(200);
  const cookie = cookiePairOf(loggedIn);
  await selectMainAndUnlockSettings(app, cookie);
  return cookie;
}

function householdIdOf(): string {
  const row = Database.db.prepare('SELECT id FROM household LIMIT 1').get() as { id: string } | undefined;
  expect(row, '夹具错误:household 行不存在(初始化未执行)').toBeDefined();
  return (row as { id: string }).id;
}

/** kind=vod 来源行(DB 直插工厂事实;物化 CAS 要求来源启用且 locator_revision=1) */
function seedFixtureVodSource(householdId: string): string {
  const sourceId = `vod-src-${randomUUID()}`;
  const now = new Date().toISOString();
  getDb().transaction((tx) => {
    tx.insert(mediaSource)
      .values({
        id: sourceId,
        householdId,
        kind: 'vod',
        name: '夹具在线片源(T084 rig)',
        remoteUrl: 'http://cms.fixture.invalid/api.php?ac=list',
        enabled: 1,
        createdAt: now,
        updatedAt: now,
      })
      .run();
    tx.insert(vodSourceConfig).values({ householdId, sourceId, adapter: 'apple-cms-json' }).run();
  });
  return sourceId;
}

function fixtureTarget(input: {
  readonly sourceId: string;
  readonly upstreamVodId: string;
  readonly episodeKey: string;
  readonly title: string;
  readonly totalEpisodes: number;
  readonly candidateRef?: string;
  readonly candidateSourceSessionId?: string;
}): ResolvedMaterializationTarget {
  const episodes = Array.from({ length: input.totalEpisodes }, (_unused, index) => ({
    episodeKey: input.totalEpisodes === 1 ? input.episodeKey : String(index + 1).padStart(2, '0'),
    label: input.totalEpisodes === 1 ? '正片' : `第${String(index + 1).padStart(2, '0')}集`,
    ordinal: index + 1,
    seasonKey: null,
    sequenceRevision: 1,
    sequenceStatus: 'ordered' as const,
    contentLevel: null,
    contentVersionState: 'unverified' as const,
    evidenceKind: null,
    evidenceDigest: null,
    schemaVersion: null,
    continuityRevision: null,
    continuitySignature: null,
  }));
  return {
    sourceId: input.sourceId,
    upstreamVodId: input.upstreamVodId,
    lineKey: 'main',
    episodeKey: input.episodeKey,
    previewRevision: 1,
    previewExpiresAt: new Date(Date.now() + 3600_000).toISOString(),
    candidate:
      input.candidateRef === undefined
        ? undefined
        : { sourceSessionId: input.candidateSourceSessionId ?? '', sourceGeneration: 1 },
    detail: {
      detailRevision: 1,
      locatorRevision: 1,
      title: input.title,
      description: null,
      parentContentLevel: null,
      payloadDigest: `fixture-digest-${input.upstreamVodId}`,
      validatedPrivatePayload: JSON.stringify({ kind: 'fixture-t084-target', upstreamVodId: input.upstreamVodId }),
      fetchedAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 3600_000).toISOString(),
      lines: [{ lineKey: 'main', displayName: 'fixture正片', sortOrder: 1, episodes }],
    },
  };
}

/** 登记桥直种(两集剧形态;titleRef/episodeRef 由用例合成 ref 提供) */
function registerStableTarget(sourceId: string, target: FixtureTarget, title: string): void {
  const upstreamVodId = target.titleRef;
  registerVodMaterializationTarget({
    ...fixtureTarget({ sourceId, upstreamVodId, episodeKey: '01', title, totalEpisodes: 2 }),
    titleRef: target.titleRef,
    episodeRef: target.episodeRef,
  });
}

/** 候选分支直种(candidateRef → 稳定键事实 + 服务端绑定溯源;sourceSessionId 外键 = 会话) */
function registerCandidateTarget(sourceId: string, candidateRef: string, sourceSessionId: string, upstreamVodId: string): void {
  registerVodMaterializationTarget({
    ...fixtureTarget({
      sourceId,
      upstreamVodId,
      episodeKey: '01',
      title: 'fixture·候选目标(T084)',
      totalEpisodes: 2,
      candidateRef,
      candidateSourceSessionId: sourceSessionId,
    }),
    titleRef: `vod-title-${upstreamVodId}`,
    episodeRef: `vod-episode-${upstreamVodId}-main-01`,
    candidateRef,
  });
}

async function seededRig(prefix: string): Promise<SeededRig> {
  const rig: TestRig = await startFreshApp({ prefix });
  const cookie = await seedSession(rig.app);
  const householdId = householdIdOf();
  const sourceId = seedFixtureVodSource(householdId);
  return {
    app: rig.app,
    cookie,
    householdId,
    retention: rig.app.get(VodRetentionService),
    sourceId,
  };
}

afterEach(async () => {
  clearVodMaterializationTargets();
  await cleanupRigs();
});

/* ------------------------------------------------------------------ */
/* DB 直读/直改(断言口径:T021/T024 同款原生 SQL)                        */
/* ------------------------------------------------------------------ */

function countOf(table: string, householdId: string, extraWhere = ''): number {
  const row = Database.db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE household_id = ?${extraWhere}`).get(householdId) as
    | { n: number }
    | undefined;
  return row?.n ?? 0;
}

/** 物化副作用全集(data-model §2/§4 清理面;组清 = 全零) */
function expectWholeGroupGone(householdId: string, label: string): void {
  const checks: ReadonlyArray<[string, string, string]> = [
    ['media_item vod 角色', 'media_item', " AND media_role != 'standalone'"],
    ['media_relation', 'media_relation', ''],
    ['vod_title', 'vod_title', ''],
    ['vod_line', 'vod_line', ''],
    ['vod_episode', 'vod_episode', ''],
    ['vod_detail_snapshot', 'vod_detail_snapshot', ''],
    ['vod_episode_sequence', 'vod_episode_sequence', ''],
    ['source_entry(identity_kind=vod_episode)', 'source_entry', " AND identity_kind = 'vod_episode'"],
    ['playback_source(locator_kind=online)', 'playback_source', " AND locator_kind = 'online'"],
    ['vod_materialization_operation', 'vod_materialization_operation', ''],
    ['vod_registered_candidate', 'vod_registered_candidate', ''],
  ];
  for (const [name, tableName, extraWhere] of checks) {
    expect(countOf(tableName, householdId, extraWhere), `${label}:${name} 应整组消失`).toBe(0);
  }
}

/** DB 时钟推进:标题组 24h 保护窗到期(无 HTTP 语义的等价存储事实) */
function advanceTitlesPastProtection(householdId: string): void {
  Database.db.prepare("UPDATE vod_title SET materialized_at = '2000-01-01T00:00:00.000Z' WHERE household_id = ?").run(householdId);
}

/** DB 时钟推进:幂等 operation 固定保留到期(committed/expires 成对置过去,CHECK 保持) */
function expireMaterializationOperations(householdId: string): void {
  Database.db.prepare(
    "UPDATE vod_materialization_operation SET committed_at = '2000-01-01T00:00:00.000Z', expires_at = '2000-01-02T00:00:00.000Z' WHERE household_id = ?",
  ).run(householdId);
}

/** DB 时钟推进:登记候选固定保留到期(created/expires 成对置过去,CHECK 保持) */
function expireRegisteredCandidates(householdId: string): void {
  Database.db.prepare(
    "UPDATE vod_registered_candidate SET created_at = '2000-01-01T00:00:00.000Z', expires_at = '2000-01-02T00:00:00.000Z' WHERE household_id = ?",
  ).run(householdId);
}

/** 幂等 operation + 登记候选一并到期(联合回收面的等价存储事实) */
function expireMaterializationRows(householdId: string): void {
  expireMaterializationOperations(householdId);
  expireRegisteredCandidates(householdId);
}

/** DB 时钟推进:偏好写入 operation 到期(expires >= committed + 24h CHECK 保持) */
function expirePreferenceOperations(householdId: string): void {
  Database.db.prepare(
    "UPDATE profile_vod_preference_operation SET committed_at = '2000-01-01T00:00:00.000Z', expires_at = '2000-01-02T00:00:00.000Z' WHERE household_id = ?",
  ).run(householdId);
}

/** FK 全程完整(foreign_keys=ON;全库 foreign_key_check 空) */
function expectForeignKeyClean(label: string): void {
  const violations = Database.db.prepare('PRAGMA foreign_key_check').all();
  expect(violations, `${label}:FK 引用图必须完整`).toEqual([]);
}

function sweepOutcomeShapeOf(outcome: Record<string, number>): void {
  expect(Object.keys(outcome).sort()).toEqual(Object.keys(emptyVodRetentionSweepOutcome()).sort());
  for (const value of Object.values(outcome)) {
    expect(typeof value).toBe('number');
    expect(value).toBeGreaterThanOrEqual(0);
  }
}

/* ------------------------------------------------------------------ */
/* 引用行种子(工厂事实;复合 FK/CHECK 全满足)                            */
/* ------------------------------------------------------------------ */

interface IdentityFacts {
  readonly deviceSessionId: string;
  readonly deviceId: string;
  readonly profileId: string;
}

function identityFactsOf(): IdentityFacts {
  const row = Database.db
    .prepare(
      'SELECT id AS deviceSessionId, device_id AS deviceId, active_profile_id AS profileId FROM device_session LIMIT 1',
    )
    .get() as { deviceSessionId: string; deviceId: string; profileId: string } | undefined;
  expect(row, '夹具错误:device_session 行不存在(seedSession 未执行)').toBeDefined();
  return row as IdentityFacts;
}

/** 溯源会话(ended 终态;意图/计划/候选的合法 FK 源;standalone 媒体不属任何标题组) */
function seedProvenanceSession(householdId: string): string {
  const facts = identityFactsOf();
  const mediaId = `prov-media-${randomUUID()}`;
  const sessionId = `prov-sess-${randomUUID()}`;
  const now = new Date().toISOString();
  getDb().transaction((tx) => {
    tx.insert(mediaItem)
      .values({
        id: mediaId,
        householdId,
        type: 'movie',
        mediaRole: 'standalone',
        title: 'T084 溯源媒体',
        contentLevel: 0,
        version: 1,
        createdAt: now,
        updatedAt: now,
      })
      .run();
    tx.insert(playbackSession)
      .values({
        id: sessionId,
        householdId,
        deviceSessionId: facts.deviceSessionId,
        deviceId: facts.deviceId,
        profileId: facts.profileId,
        mediaId,
        state: 'ended',
        delivery: null,
        generation: 1,
        version: 1,
        positionSeconds: 0,
        createdAt: now,
        endedAt: now,
        lastHeartbeatAt: now,
      })
      .run();
  });
  return sessionId;
}

/** 活动会话(playing;media 指向标题组子媒体;source 为该组在线资源行) */
function seedActiveSessionOnMedia(householdId: string, mediaId: string, playbackSourceId: string): string {
  const facts = identityFactsOf();
  const sessionId = `play-sess-${randomUUID()}`;
  const now = new Date().toISOString();
  Database.db
    .prepare(
      `INSERT INTO playback_session (
        id, household_id, device_session_id, device_id, profile_id, media_id,
        playback_source_id, state, delivery, generation, version,
        position_seconds, created_at, started_at, last_heartbeat_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, 'playing', 'hls_proxy', 1, 1, 10, ?, ?, ?)`,
    )
    .run(sessionId, householdId, facts.deviceSessionId, facts.deviceId, facts.profileId, mediaId, playbackSourceId, now, now, now);
  return sessionId;
}

/** 保留终态会话 + finish receipt(§9 保护窗内形态) */
function seedEndedSessionWithReceiptOnMedia(householdId: string, mediaId: string): string {
  const facts = identityFactsOf();
  const sessionId = `ended-sess-${randomUUID()}`;
  const now = new Date().toISOString();
  getDb().transaction((tx) => {
    tx.insert(playbackSession)
      .values({
        id: sessionId,
        householdId,
        deviceSessionId: facts.deviceSessionId,
        deviceId: facts.deviceId,
        profileId: facts.profileId,
        mediaId,
        state: 'ended',
        delivery: null,
        generation: 1,
        version: 1,
        positionSeconds: 900,
        createdAt: now,
        startedAt: now,
        endedAt: now,
        lastHeartbeatAt: now,
      })
      .run();
    tx.insert(playbackFinishReceipt)
      .values({
        householdId,
        sessionId,
        deviceSessionId: facts.deviceSessionId,
        profileContextVersion: 1,
        generation: 1,
        operationKey: `fin-${sessionId}`,
        requestDigest: `dig-${sessionId}`,
        finalSeq: 42,
        finalSessionAccepted: 1,
        historyApplied: 1,
        historyRevision: 1,
        sessionCompleted: 1,
        autoNextEligible: 0,
        reason: 'completed',
        positionSeconds: 900,
        durationSeconds: 1200,
        endedAt: now,
        contentRevision: 1,
        continuityRevision: 1,
        locatorRevision: 1,
      })
      .run();
  });
  return sessionId;
}

/** 过渡意图(pending;目标 = 标题组子媒体;来源 = 溯源会话) */
function seedPendingIntentTargeting(householdId: string, provenanceSessionId: string, targetMediaId: string): string {
  const facts = identityFactsOf();
  const intentId = `intent-${randomUUID()}`;
  const now = new Date().toISOString();
  Database.db
    .prepare(
      `INSERT INTO playback_transition_intent (
        id, household_id, from_session_id, from_generation, device_session_id, profile_id,
        profile_context_version, action, target_media_id, target_content_revision,
        target_continuity_revision, target_locator_revision, match_revision, match_confidence,
        confirmed_ambiguous, position_mode, finish_receipt_id, operation_key, request_digest,
        slot_revision, created_at, expires_at, status, successor_id
      ) VALUES (?, ?, ?, 1, ?, ?, 1, 'switch', ?, 1, 1, 1, 1, 'high', 0, 'beginning', NULL, ?, ?, 1, ?, ?, 'pending', NULL)`,
    )
    .run(
      intentId,
      householdId,
      provenanceSessionId,
      facts.deviceSessionId,
      facts.profileId,
      targetMediaId,
      `ik-${intentId}`,
      `idg-${intentId}`,
      now,
      new Date(Date.now() + 60_000).toISOString(),
    );
  return intentId;
}

/** 历史(长期保留面;media 指向标题组子媒体) */
function seedHistoryOnMedia(householdId: string, profileId: string, mediaId: string): void {
  Database.db
    .prepare(
      `INSERT INTO profile_viewing_history (
        household_id, profile_id, media_id, writer_epoch, writer_playback_session_id,
        last_sample_seq, content_revision, position_seconds, duration_seconds,
        last_viewed_at, revision, completed
      ) VALUES (?, ?, ?, 1, 'writer-hist', 3, 1, 60, 1200, ?, 1, 0)`,
    )
    .run(householdId, profileId, mediaId, new Date().toISOString());
}

/** 名单(策略 allowed 列表含标题组子媒体;既有默认策略行就地更新) */
function seedPolicyListWithMedia(householdId: string, profileId: string, mediaId: string): void {
  const updated = Database.db.prepare(
    'UPDATE profile_policy SET allowed_media_ids = ?, updated_at = ? WHERE household_id = ? AND profile_id = ?',
  ).run(JSON.stringify([mediaId]), new Date().toISOString(), householdId, profileId).changes;
  if (updated === 0) {
    Database.db
      .prepare(
        `INSERT INTO profile_policy (
          household_id, profile_id, max_content_level, allow_unrated,
          allowed_media_ids, blocked_media_ids, allowed_channel_ids, version, updated_at
        ) VALUES (?, ?, 18, 1, ?, '[]', '[]', 1, ?)`,
      )
      .run(householdId, profileId, JSON.stringify([mediaId]), new Date().toISOString());
  }
}

/* ------------------------------------------------------------------ */
/* A:24h 保护窗与配额回升(api §3 物化 24h 目标保护段)                    */
/* ------------------------------------------------------------------ */

describe('T084 · A 物化 24h 保护窗与整组回收(api.md §3)', () => {
  it('A1 24h 内配额满 409 不挤占 → 窗满清扫整组消失 → 配额回升新 key 201;ID 不复用;重复清扫零变化;FK 完整', async () => {
    const previousQuota = process.env.VOD_MAX_PARENT_TITLES;
    process.env.VOD_MAX_PARENT_TITLES = '1';
    try {
      const rig = await seededRig('hmp-t084-a1-');
      const targetA: FixtureTarget = { titleRef: `vod-title-a1-${randomUUID()}`, episodeRef: '' };
      targetA.episodeRef = `${targetA.titleRef}-main-01`;
      const targetB: FixtureTarget = { titleRef: `vod-title-b1-${randomUUID()}`, episodeRef: '' };
      targetB.episodeRef = `${targetB.titleRef}-main-01`;
      registerStableTarget(rig.sourceId, targetA, 'fixture·A1 剧集甲');
      registerStableTarget(rig.sourceId, targetB, 'fixture·A1 剧集乙');

      const first = await postMaterialize(rig.app, rig.cookie, stableRefBody(targetA));
      expect(first.status).toBe(201);
      const firstBody = first.body as MaterializedDto;
      expect(countOf('vod_title', rig.householdId)).toBe(1);

      // 24h 内保护:配额满时新 key 异目标 409(不删除历史/不挤占既有目标)
      const denied = await postMaterialize(rig.app, rig.cookie, stableRefBody(targetB));
      expectProblem(denied, 409, ProblemCode.VOD_QUOTA_EXCEEDED);
      expect(countOf('vod_title', rig.householdId), '窗内目标不回收').toBe(1);

      // DB 时钟推进过 24h(标题窗 + 幂等 operation 固定保留到期)→ 清扫整组消失
      advanceTitlesPastProtection(rig.householdId);
      expireMaterializationRows(rig.householdId);
      const outcome = await rig.retention.runRetentionSweep();
      sweepOutcomeShapeOf(outcome);
      expect(outcome.groupsDeleted).toBe(1);
      expect(outcome.groupsRetainedProtected).toBe(0);
      expect(outcome.expiredMaterializationOperationsDeleted).toBe(1);
      expectWholeGroupGone(rig.householdId, '窗满清扫后');
      expectForeignKeyClean('整组删除后');

      // 配额回升:删除后净计数自然回落,新 key 物化原 409 目标即 201;ID 全新(不复用)
      const recovered = await postMaterialize(rig.app, rig.cookie, stableRefBody(targetB));
      expect(recovered.status).toBe(201);
      const recoveredBody = recovered.body as MaterializedDto;
      expect(recoveredBody.parentMediaId).toMatch(UUID_PATTERN);
      expect(recoveredBody.parentMediaId).not.toBe(firstBody.parentMediaId);
      expect(recoveredBody.parentMediaId).not.toBe(firstBody.mediaId);

      // 重复运行幂等(未再推进时钟/到期面):第二拍全零;FK 全程完整
      const second = await rig.retention.runRetentionSweep();
      expect(second.groupsDeleted).toBe(0);
      expect(second.groupsRetainedProtected).toBe(0);
      expectForeignKeyClean('重复清扫后');
    } finally {
      if (previousQuota === undefined) {
        delete process.env.VOD_MAX_PARENT_TITLES;
      } else {
        process.env.VOD_MAX_PARENT_TITLES = previousQuota;
      }
    }
  });
});

/* ------------------------------------------------------------------ */
/* B:引用矩阵各自保组(data-model §4;活动/保留终态不能破坏 FK)           */
/* ------------------------------------------------------------------ */

describe('T084 · B 引用各自保组(历史/名单/活动 session/终态 session+receipt/意图)', () => {
  async function retainedCase(
    rig: SeededRig,
    target: FixtureTarget,
    title: string,
    attach: (childMediaId: string, playbackSourceId: string) => void,
    referenceCount: () => number,
    label: string,
  ): Promise<void> {
    registerStableTarget(rig.sourceId, target, title);
    const first = await postMaterialize(rig.app, rig.cookie, stableRefBody(target));
    expect(first.status, `${label}:首次物化 201`).toBe(201);
    const childMediaId = (first.body as MaterializedDto).mediaId;
    const playbackSourceId = Database.db.prepare(
      'SELECT id FROM playback_source WHERE household_id = ? AND media_item_id = ? AND locator_kind = ?',
    ).get(rig.householdId, childMediaId, 'online') as { id: string } | undefined;
    expect(playbackSourceId, `${label}:在线资源行存在`).toBeDefined();

    attach(childMediaId, playbackSourceId?.id as string);

    // 隔离该引用类:幂等 operation/候选固定保留先到期 + 标题窗满,唯一保护 = 本引用
    expireMaterializationRows(rig.householdId);
    advanceTitlesPastProtection(rig.householdId);
    const outcome = await rig.retention.runRetentionSweep();
    expect(outcome.groupsDeleted, `${label}:组被引用保住`).toBe(0);
    expect(outcome.groupsRetainedProtected, `${label}:受保护计数`).toBeGreaterThanOrEqual(1);
    expect(countOf('vod_title', rig.householdId), `${label}:整组保留`).toBe(1);
    expect(referenceCount(), `${label}:引用行原样保留(不在删除面)`).toBeGreaterThanOrEqual(1);
    expectForeignKeyClean(`${label}:FK 完整`);
  }

  it('B1 活动 playing 会话引用保组(会话行不在删除面)', async () => {
    const rig = await seededRig('hmp-t084-b1-');
    const target: FixtureTarget = { titleRef: `vod-title-b1-${randomUUID()}`, episodeRef: '' };
    target.episodeRef = `${target.titleRef}-main-01`;
    let sessionId = '';
    await retainedCase(
      rig,
      target,
      'fixture·B1 活动会话保组',
      (childMediaId, playbackSourceId) => {
        sessionId = seedActiveSessionOnMedia(rig.householdId, childMediaId, playbackSourceId);
      },
      () =>
        (
          Database.db.prepare(
            "SELECT COUNT(*) AS n FROM playback_session WHERE id = ? AND state = 'playing'",
          ).get(sessionId) as { n: number }
        ).n,
      'B1',
    );
  });

  it('B2 保留终态会话 + finish receipt 引用保组(receipt 不被连带)', async () => {
    const rig = await seededRig('hmp-t084-b2-');
    const target: FixtureTarget = { titleRef: `vod-title-b2-${randomUUID()}`, episodeRef: '' };
    target.episodeRef = `${target.titleRef}-main-01`;
    let sessionId = '';
    await retainedCase(
      rig,
      target,
      'fixture·B2 终态会话保组',
      (childMediaId) => {
        sessionId = seedEndedSessionWithReceiptOnMedia(rig.householdId, childMediaId);
      },
      () =>
        (
          Database.db.prepare(
            'SELECT COUNT(*) AS n FROM playback_finish_receipt WHERE session_id = ?',
          ).get(sessionId) as { n: number }
        ).n,
      'B2',
    );
  });

  it('B3 意图引用保组(pending intent 目标为子媒体;目标行不在删除面)', async () => {
    const rig = await seededRig('hmp-t084-b3-');
    const target: FixtureTarget = { titleRef: `vod-title-b3-${randomUUID()}`, episodeRef: '' };
    target.episodeRef = `${target.titleRef}-main-01`;
    const provenanceSessionId = seedProvenanceSession(rig.householdId);
    let intentId = '';
    await retainedCase(
      rig,
      target,
      'fixture·B3 意图保组',
      (childMediaId) => {
        intentId = seedPendingIntentTargeting(rig.householdId, provenanceSessionId, childMediaId);
      },
      () =>
        (
          Database.db.prepare('SELECT COUNT(*) AS n FROM playback_transition_intent WHERE id = ? AND status = ?').get(intentId, 'pending') as {
            n: number;
          }
        ).n,
      'B3',
    );
  });

  it('B4 历史引用保组(观看历史行长期保留,不随清扫消失)', async () => {
    const rig = await seededRig('hmp-t084-b4-');
    const target: FixtureTarget = { titleRef: `vod-title-b4-${randomUUID()}`, episodeRef: '' };
    target.episodeRef = `${target.titleRef}-main-01`;
    const facts = identityFactsOf();
    let historyMediaId = '';
    await retainedCase(
      rig,
      target,
      'fixture·B4 历史保组',
      (childMediaId) => {
        historyMediaId = childMediaId;
        seedHistoryOnMedia(rig.householdId, facts.profileId, childMediaId);
      },
      () =>
        (
          Database.db.prepare('SELECT COUNT(*) AS n FROM profile_viewing_history WHERE media_id = ?').get(historyMediaId) as {
            n: number;
          }
        ).n,
      'B4',
    );
  });

  it('B5 名单引用保组(策略 allowed 列表含子媒体)', async () => {
    const rig = await seededRig('hmp-t084-b5-');
    const target: FixtureTarget = { titleRef: `vod-title-b5-${randomUUID()}`, episodeRef: '' };
    target.episodeRef = `${target.titleRef}-main-01`;
    const facts = identityFactsOf();
    let listedMediaId = '';
    await retainedCase(
      rig,
      target,
      'fixture·B5 名单保组',
      (childMediaId) => {
        listedMediaId = childMediaId;
        seedPolicyListWithMedia(rig.householdId, facts.profileId, childMediaId);
      },
      () =>
        (
          Database.db.prepare(
            'SELECT COUNT(*) AS n FROM profile_policy WHERE household_id = ? AND EXISTS (SELECT 1 FROM json_each(allowed_media_ids) je WHERE je.value = ?)',
          ).get(rig.householdId, listedMediaId) as { n: number }
        ).n,
      'B5',
    );
  });
});

/* ------------------------------------------------------------------ */
/* C:偏好 operation 过期清理不删偏好(data-model §10 U1)                 */
/* ------------------------------------------------------------------ */

describe('T084 · C 偏好 operation 过期清理(§10 清理 operation 不删偏好)', () => {
  it('C1 PATCH 偏好成功 → operation 到期清扫删除 operation,偏好行与版本原样;重复清扫零变化', async () => {
    const rig = await seededRig('hmp-t084-c1-');
    const patched = await request(rig.app.getHttpServer())
      .patch(PREFERENCES_PATH)
      .set('Cookie', rig.cookie)
      .send({ expectedVersion: 0, autoplayNext: false, operationKey: randomUUID() });
    expect(patched.status).toBe(200);
    expect((patched.body as { autoplayNext: boolean; version: number }).autoplayNext).toBe(false);
    expect((patched.body as { version: number }).version).toBe(1);
    expect(countOf('profile_vod_preference_operation', rig.householdId)).toBe(1);

    expirePreferenceOperations(rig.householdId);
    const outcome = await rig.retention.runRetentionSweep();
    expect(outcome.expiredPreferenceOperationsDeleted).toBe(1);
    expect(countOf('profile_vod_preference_operation', rig.householdId), '过期偏好 operation 已清理').toBe(0);
    // §10:清理过期 operation 不删偏好 —— 偏好行与版本原样
    const after = await request(rig.app.getHttpServer()).get(PREFERENCES_PATH).set('Cookie', rig.cookie);
    expect(after.status).toBe(200);
    expect((after.body as { autoplayNext: boolean; version: number })).toMatchObject({ autoplayNext: false, version: 1 });
    expect(countOf('profile_vod_preferences', rig.householdId), '偏好行不在删除面').toBe(1);

    const second = await rig.retention.runRetentionSweep();
    expect(second.expiredPreferenceOperationsDeleted).toBe(0);
    expectForeignKeyClean('偏好清理后');
  });
});

/* ------------------------------------------------------------------ */
/* D:登记候选与 operation 联合回收(api §7 I1 / §10 I1;T081 移交面)      */
/* ------------------------------------------------------------------ */

describe('T084 · D 登记候选 24h(与 operation 联合回收;未过期候选保组)', () => {
  it('D1 候选物化登记映射 → 候选与 operation 同拍到保留期联合回收,无引用组随之整组消失', async () => {
    const rig = await seededRig('hmp-t084-d1-');
    const provenanceSessionId = seedProvenanceSession(rig.householdId);
    const stableTarget: FixtureTarget = { titleRef: `vod-title-d1-${randomUUID()}`, episodeRef: '' };
    stableTarget.episodeRef = `${stableTarget.titleRef}-main-01`;
    registerStableTarget(rig.sourceId, stableTarget, 'fixture·D1 联合回收组');
    const first = await postMaterialize(rig.app, rig.cookie, stableRefBody(stableTarget));
    expect(first.status).toBe(201);

    // 候选分支:candidateRef + 新 key 同目标 → 201 且 registeredCandidateRef 非空
    // (候选绑定与稳定目标同 (source, upstream) 稳定键 —— 复用同组,不建第二份)
    const candidateRef = forgedCandidateRef();
    registerCandidateTarget(rig.sourceId, candidateRef, provenanceSessionId, stableTarget.titleRef);
    const viaCandidate = await postMaterialize(rig.app, rig.cookie, candidateBody(candidateRef));
    expect(viaCandidate.status).toBe(201);
    const candidateDto = viaCandidate.body as MaterializedDto;
    expect(candidateDto.registeredCandidateRef).toMatch(/^vod-reg-/);
    expect(candidateDto.parentMediaId).toBe((first.body as MaterializedDto).parentMediaId);
    expect(countOf('vod_registered_candidate', rig.householdId)).toBe(1);
    expect(countOf('vod_materialization_operation', rig.householdId)).toBe(2);

    // 联合回收:候选是 operation 的 FK 子行,过期时同拍消失(候选先行);组无引用 → 整组消失
    advanceTitlesPastProtection(rig.householdId);
    expireMaterializationRows(rig.householdId);
    const outcome = await rig.retention.runRetentionSweep();
    expect(outcome.expiredRegisteredCandidatesDeleted).toBe(1);
    expect(outcome.expiredMaterializationOperationsDeleted).toBe(2);
    expect(outcome.groupsDeleted).toBe(1);
    expectWholeGroupGone(rig.householdId, '联合回收后');
    expectForeignKeyClean('联合回收后');
  });

  it('D2 未过期候选保组:标题窗满但 operation/候选保护期未过 → 整组保留;到期后随联合回收消失', async () => {
    const rig = await seededRig('hmp-t084-d2-');
    const provenanceSessionId = seedProvenanceSession(rig.householdId);
    const stableTarget: FixtureTarget = { titleRef: `vod-title-d2-${randomUUID()}`, episodeRef: '' };
    stableTarget.episodeRef = `${stableTarget.titleRef}-main-01`;
    registerStableTarget(rig.sourceId, stableTarget, 'fixture·D2 候选保组');
    const first = await postMaterialize(rig.app, rig.cookie, stableRefBody(stableTarget));
    expect(first.status).toBe(201);

    // 候选绑定与稳定目标同 (source, upstream) 稳定键(复用同组)
    const candidateRef = forgedCandidateRef();
    registerCandidateTarget(rig.sourceId, candidateRef, provenanceSessionId, stableTarget.titleRef);
    const viaCandidate = await postMaterialize(rig.app, rig.cookie, candidateBody(candidateRef));
    expect(viaCandidate.status).toBe(201);

    // 仅标题窗满(operation/候选 24h 保护期未过 —— 幂等保护/登记候选引用各自保组)
    advanceTitlesPastProtection(rig.householdId);
    const inside = await rig.retention.runRetentionSweep();
    expect(inside.groupsDeleted).toBe(0);
    expect(inside.groupsRetainedProtected).toBe(1);
    expect(countOf('vod_title', rig.householdId), '未过期候选/operation 保组').toBe(1);
    expect(countOf('vod_registered_candidate', rig.householdId)).toBe(1);
    expectForeignKeyClean('候选保组');

    // 到期:候选与 operation 联合回收,组随之整组消失
    expireMaterializationRows(rig.householdId);
    const later = await rig.retention.runRetentionSweep();
    expect(later.expiredRegisteredCandidatesDeleted).toBe(1);
    expect(later.groupsDeleted).toBe(1);
    expectWholeGroupGone(rig.householdId, '候选到期后');
    expectForeignKeyClean('候选回收后');
  });
});
