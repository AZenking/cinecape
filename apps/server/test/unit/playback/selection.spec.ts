import 'reflect-metadata';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { afterEach, describe, expect, it } from 'vitest';
import { ProblemCode } from '@hmp/shared';
import type { INestApplication } from '@nestjs/common';
import {
  PLAYBACK_FIXTURE_NOW,
  seedPlaybackSession,
  seedPlaybackWorld,
  type PlaybackWorld,
} from '../../fixtures/playback';
import { Database } from '../../../src/database/database';
import { setEnvOverride } from '../../../src/config/env';
import { loadEnv } from '../../../src/config/env.schema';
import { createPlaybackBudgets, type PlaybackBudgets } from '../../../src/config/playback-budgets';
import { getDb } from '@contexts/identity-access/infrastructure/db';
import { account, deviceSession, playbackSession, profilePolicy } from '../../../src/database/schema';
import { DomainError } from '../../../src/common/domain-error';
import type { SessionContext } from '../../../src/common/current-session.decorator';
import { PlaybackRepository } from '../../../src/contexts/playback/infrastructure/playback.repository';
import { PlaybackAuthorizationService } from '../../../src/contexts/playback/application/playback-authorization.service';
import { PlaybackTicketService } from '../../../src/contexts/playback/application/playback-ticket.service';
import type { PlaybackProbeFacts } from '../../../src/contexts/playback/application/playback-resolver.service';
import {
  computeSeekTimeline,
  PlaybackSelectionService,
  type PlaybackRebuildCoordinator,
  type PlaybackSubtitleCatalogPort,
  type PlaybackTrackFactsPort,
  type SelectionOutcome,
} from '../../../src/contexts/playback/application/playback-selection.service';

/**
 * 播放选择/定位服务单元测试(T029,spec 004;playback-selection.service.ts 的被测底层)。
 *
 * 权威依据(docs/specs/004-playback-resolver):
 * - tasks.md T029:selection/seek 版本 CAS 与单槽串行 generation 替换,保留 session/逻辑位置;
 *   ready/playing/paused→preparing,保留 desiredPaused、旧票失效,ready 后 renew 取票;
 *   纯字幕只增 version,返回 duration/timelineOffset/presentationStart,处理关键帧前区间,
 *   直播 seek 400、旧代 409,不瞬时双占额度;
 * - data-model.md「## playback_session」:seek/重建音轨同时递增 generation 与 version;
 *   纯字幕切换只递增 version;desired_paused 保留;preparing 拒绝第二次 seek/selection
 *   为 409 PLAYBACK_NOT_READY;「## playback_ticket」:换代后旧 generation 无论 TTL 不可用;
 * - contracts/api.md selection/seek 行为与「时间轴及请求预算」节:
 *   timelineOffsetSeconds/presentationStartSeconds 语义(本地时间+偏移=影片时间;
 *   presentationStart 指定需跳过的目标前区间);稳定错误 409 VERSION_CONFLICT/GENERATION_STALE/
 *   NOT_READY、400 SELECTION_INVALID/SEEK_UNSUPPORTED;
 * - research.md R8:关键帧前区间、滚动窗口与应用进度条(duration 保留完整影片时长)。
 *
 * 探测事实经 PlaybackTrackFactsPort 注入(测试用 fake);换代额度协同经
 * PlaybackRebuildCoordinator 注入(测试断言取消意图被发出);授权链用真实实例 + 夹具种子。
 */

/** 注入 120s 票据 TTL 的预算(与默认 300 区分,证明 TTL 取自预算;时间轴 K=4s 取 timeline 预算) */
function budgetsForTest(): PlaybackBudgets {
  return createPlaybackBudgets(loadEnv({ NODE_ENV: 'test', PLAYBACK_TICKET_TTL_SECONDS: '120' }));
}

/** 点播影片事实:双音轨 + 双字幕轨(服务器轨道 ID 结构 aud-N/sub-N,T023 probe 同形) */
const MOVIE_FACTS: PlaybackProbeFacts = {
  durationSeconds: 5400,
  audioTracks: [
    { id: 'aud-1', label: '普通话', language: 'zh', default: true },
    { id: 'aud-2', label: 'English', language: 'en', default: false },
  ],
  subtitleTracks: [
    { id: 'sub-1', label: '简体中文', language: 'zh-CN' },
    { id: 'sub-2', label: 'English', language: 'en' },
  ],
};

/** 直播事实(hls_proxy 候选免 probe 形态):duration=null、无轨道 */
const LIVE_FACTS: PlaybackProbeFacts = {
  durationSeconds: null,
  audioTracks: [],
  subtitleTracks: [],
};

/** 静态 fake 事实端口:按 (sessionId,generation) 键控登记 */
class StaticFactsPort implements PlaybackTrackFactsPort {
  private readonly byKey = new Map<string, PlaybackProbeFacts>();

  seed(sessionId: string, generation: number, facts: PlaybackProbeFacts): void {
    this.byKey.set(`${sessionId}|${generation}`, facts);
  }

  factsFor(sessionId: string, generation: number): PlaybackProbeFacts | undefined {
    return this.byKey.get(`${sessionId}|${generation}`);
  }
}

/** fake 字幕词表端口:内嵌 sub-1/sub-2 + 旁车 sub-sidecar-1(证明组合点) */
class FakeSubtitleCatalog implements PlaybackSubtitleCatalogPort {
  async subtitleTrackIds(sessionId: string, generation: number): Promise<readonly string[]> {
    void sessionId;
    void generation;
    return ['sub-1', 'sub-2', 'sub-sidecar-1'];
  }
}

/** fake 换代协同器:记录取消意图(断言「换代即取消旧代转换,不瞬时双占」) */
class RecordingCoordinator implements PlaybackRebuildCoordinator {
  readonly calls: Array<{ sessionId: string; supersededGeneration: number }> = [];

  cancelSupersededGeneration(sessionId: string, supersededGeneration: number): void {
    this.calls.push({ sessionId, supersededGeneration });
  }
}

interface SelectionRig {
  dataDir: string;
  world: PlaybackWorld;
  repo: PlaybackRepository;
  authorization: PlaybackAuthorizationService;
  budgets: PlaybackBudgets;
  context: SessionContext;
  facts: StaticFactsPort;
  coordinator: RecordingCoordinator;
  service: PlaybackSelectionService;
}

/** 纯 DB rig(不经 Nest 容器;ticket.spec/resource-selection.spec 同款) */
const rigs: SelectionRig[] = [];

function migrationSql(name: string): string {
  const migrationPath = path.join(process.cwd(), 'src/database/migrations', name, 'up.sql');
  if (!fs.existsSync(migrationPath)) {
    throw new Error(`未找到迁移文件 ${migrationPath} —— 本测试须以 apps/server 为工作目录运行`);
  }
  return fs.readFileSync(migrationPath, 'utf8');
}

async function bootstrapSelectionRig(prefix: string): Promise<SelectionRig> {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  setEnvOverride(loadEnv({ NODE_ENV: 'test', DATA_DIR: dataDir, DB_FILENAME: `${randomUUID()}.hmp.db` }));
  Database.close();
  Database.db.exec('CREATE TABLE IF NOT EXISTS _migrations (name TEXT PRIMARY KEY NOT NULL, applied_at TEXT NOT NULL)');
  for (const name of [
    '0001_init',
    '0002_profile_policy',
    '0003_media_catalog',
    '0004_manual_epg_binding',
    '0005_playback',
    '0006_pc_experience',
  ]) {
    Database.db.transaction(() => {
      Database.db.exec(migrationSql(name));
      Database.db.prepare('INSERT INTO _migrations (name, applied_at) VALUES (?, ?)').run(name, new Date().toISOString());
    })();
  }
  const fakeRig = { app: {} as INestApplication, dataDir, dbFilename: `${randomUUID()}.hmp.db` };
  const world = await seedPlaybackWorld(fakeRig, { nasEnabled: true });
  getDb()
    .insert(profilePolicy)
    .values({
      householdId: world.householdId,
      profileId: world.profileId,
      maxContentLevel: 18,
      allowUnrated: 1,
      allowedMediaIds: '[]',
      blockedMediaIds: '[]',
      allowedChannelIds: '[]',
      version: 1,
      updatedAt: PLAYBACK_FIXTURE_NOW,
    })
    .run();
  const budgets = budgetsForTest();
  const repo = new PlaybackRepository(Database.db, budgets);
  const authorization = new PlaybackAuthorizationService(repo);
  const session = getDb().select().from(deviceSession).where(eq(deviceSession.id, world.deviceSessionId)).get();
  if (session === undefined) {
    throw new Error('夹具错误:device_session 不存在');
  }
  const acc = getDb().select().from(account).where(eq(account.id, world.accountId)).get();
  if (acc === undefined) {
    throw new Error('夹具错误:account 不存在');
  }
  const context: SessionContext = {
    session: {
      id: session.id,
      householdId: session.householdId,
      accountId: session.accountId,
      deviceId: session.deviceId,
      activeProfileId: session.activeProfileId,
      expiresAt: session.expiresAt,
    },
    account: {
      id: acc.id,
      householdId: acc.householdId,
      username: acc.username,
      role: acc.role as SessionContext['account']['role'],
    },
  };
  const facts = new StaticFactsPort();
  const coordinator = new RecordingCoordinator();
  const service = new PlaybackSelectionService({
    repository: repo,
    authorization,
    facts,
    subtitleCatalog: new FakeSubtitleCatalog(),
    rebuildCoordinator: coordinator,
    budgets,
  });
  const rig: SelectionRig = { dataDir, world, repo, authorization, budgets, context, facts, coordinator, service };
  rigs.push(rig);
  return rig;
}

async function cleanupSelectionRigs(): Promise<void> {
  while (rigs.length > 0) {
    const rig = rigs.pop();
    if (rig === undefined) {
      break;
    }
    Database.close();
    fs.rmSync(rig.dataDir, { recursive: true, force: true });
  }
}

/** 会话行原始列(测试断言用) */
function sessionRow(sessionId: string): Record<string, unknown> {
  const row = Database.db.prepare('SELECT * FROM playback_session WHERE id = ?').get(sessionId) as
    | Record<string, unknown>
    | undefined;
  expect(row, `会话行应存在:${sessionId}`).toBeDefined();
  return row as Record<string, unknown>;
}

/** 预期 DomainError:断言 status + 稳定码 */
async function expectDomainError(promise: Promise<unknown>, status: number, code: ProblemCode): Promise<void> {
  let thrown: unknown;
  try {
    await promise;
  } catch (error) {
    thrown = error;
  }
  expect(thrown, `预期 DomainError(${status} ${code})`).toBeInstanceOf(DomainError);
  const domain = thrown as DomainError;
  expect(domain.status, code).toBe(status);
  expect(domain.code, code).toBe(code);
}

/** 预期成功并收窄 SelectionOutcome */
async function expectOk(promise: Promise<SelectionOutcome>): Promise<SelectionOutcome> {
  const outcome = await promise;
  expect(outcome.session).toBeDefined();
  expect(outcome.dto).toBeDefined();
  return outcome;
}

afterEach(async () => {
  await cleanupSelectionRigs();
});

/* ------------------------------------------------------------------ */
/* 1. seek 换代主路径(单槽串行 generation 替换)                          */
/* ------------------------------------------------------------------ */

describe('T029 seek 换代主路径', () => {
  it('playing→seek:generation+1 version+1、preparing、position 落目标、DTO 携带时间轴元数据且无票字段', async () => {
    const t = await bootstrapSelectionRig('hmp-sel-seek-');
    const seeded = seedPlaybackSession(t.world, { state: 'playing', at: PLAYBACK_FIXTURE_NOW });
    t.facts.seed(seeded.sessionId, 1, MOVIE_FACTS);

    const outcome = await expectOk(t.service.seek(seeded.sessionId, { expectedVersion: 1, positionSeconds: 90 }, t.context));

    // 行:换代 + preparing + 逻辑位置写入
    expect(outcome.session.state).toBe('preparing');
    expect(outcome.session.generation).toBe(2);
    expect(outcome.session.version).toBe(2);
    expect(outcome.session.positionSeconds).toBe(90);
    const row = sessionRow(seeded.sessionId);
    expect(row['state']).toBe('preparing');
    expect(row['generation']).toBe(2);
    expect(row['version']).toBe(2);
    expect(row['position_seconds']).toBe(90);

    // DTO 契约形状(preparing 无票;duration 保留完整影片时长,R8)
    expect(outcome.dto.id).toBe(seeded.sessionId);
    expect(outcome.dto.state).toBe('preparing');
    expect(outcome.dto.generation).toBe(2);
    expect(outcome.dto.version).toBe(2);
    expect(outcome.dto.desiredPaused).toBe(false);
    expect(outcome.dto.positionSeconds).toBe(90);
    expect(outcome.dto.durationSeconds).toBe(5400);
    expect(outcome.dto.playbackUrl).toBeNull();
    expect(outcome.dto.ticketExpiresAt).toBeNull();
    // 时间轴:91 以内 4s 对齐(纯函数语义在专项组断言区间不变量)
    expect(outcome.dto.timelineOffsetSeconds).toBeLessThanOrEqual(90);
    expect(outcome.dto.presentationStartSeconds).toBe(90 - outcome.dto.timelineOffsetSeconds);
    expect(outcome.dto.presentationStartSeconds).toBeGreaterThanOrEqual(0);
    expect(outcome.dto.presentationStartSeconds).toBeLessThan(4);
  });

  it('paused→seek:desiredPaused=true 保留(准备完成后播放器依此继续暂停)', async () => {
    const t = await bootstrapSelectionRig('hmp-sel-pause-');
    const seeded = seedPlaybackSession(t.world, { state: 'paused', at: PLAYBACK_FIXTURE_NOW });
    t.facts.seed(seeded.sessionId, 1, MOVIE_FACTS);

    const outcome = await expectOk(t.service.seek(seeded.sessionId, { expectedVersion: 1, positionSeconds: 42 }, t.context));

    expect(outcome.session.state).toBe('preparing');
    expect(outcome.session.generation).toBe(2);
    expect(outcome.session.desiredPaused).toBe(true);
    expect(outcome.dto.desiredPaused).toBe(true);
    expect(sessionRow(seeded.sessionId)['desired_paused']).toBe(1);
  });
});

/* ------------------------------------------------------------------ */
/* 2. CAS 与状态门(409 族)                                              */
/* ------------------------------------------------------------------ */

describe('T029 CAS 与状态门', () => {
  it('expectedVersion 过期 → 409 PLAYBACK_VERSION_CONFLICT 且行原样', async () => {
    const t = await bootstrapSelectionRig('hmp-sel-cas-');
    const seeded = seedPlaybackSession(t.world, { state: 'ready', version: 2, at: PLAYBACK_FIXTURE_NOW });
    t.facts.seed(seeded.sessionId, 1, MOVIE_FACTS);

    await expectDomainError(
      t.service.seek(seeded.sessionId, { expectedVersion: 1, positionSeconds: 10 }, t.context),
      409,
      ProblemCode.PLAYBACK_VERSION_CONFLICT,
    );
    const row = sessionRow(seeded.sessionId);
    expect(row['state']).toBe('ready');
    expect(row['generation']).toBe(1);
    expect(row['version']).toBe(2);
  });

  it('preparing 中第二次 seek/selection → 409 PLAYBACK_NOT_READY(单槽串行:换代窗口内不接收第二个换代)', async () => {
    const t = await bootstrapSelectionRig('hmp-sel-slot-');
    const seeded = seedPlaybackSession(t.world, { state: 'preparing', mediaId: t.world.nas.mediaId, at: PLAYBACK_FIXTURE_NOW });

    await expectDomainError(
      t.service.seek(seeded.sessionId, { expectedVersion: 1, positionSeconds: 5 }, t.context),
      409,
      ProblemCode.PLAYBACK_NOT_READY,
    );
    await expectDomainError(
      t.service.selectTracks(seeded.sessionId, { expectedVersion: 1, positionSeconds: 5, subtitleTrackId: 'sub-1' }, t.context),
      409,
      ProblemCode.PLAYBACK_NOT_READY,
    );
    const row = sessionRow(seeded.sessionId);
    expect(row['state']).toBe('preparing');
    expect(row['generation']).toBe(1);
    expect(row['version']).toBe(1);
  });

  it('seek 成功后携换代前 expectedVersion 再次 seek → 409 且 generation 保持 2(旧请求不可覆盖新代)', async () => {
    const t = await bootstrapSelectionRig('hmp-sel-sequel-');
    const seeded = seedPlaybackSession(t.world, { state: 'playing', at: PLAYBACK_FIXTURE_NOW });
    t.facts.seed(seeded.sessionId, 1, MOVIE_FACTS);
    await expectOk(t.service.seek(seeded.sessionId, { expectedVersion: 1, positionSeconds: 30 }, t.context));

    await expectDomainError(
      t.service.seek(seeded.sessionId, { expectedVersion: 1, positionSeconds: 60 }, t.context),
      409,
      ProblemCode.PLAYBACK_VERSION_CONFLICT,
    );
    const row = sessionRow(seeded.sessionId);
    expect(row['generation']).toBe(2);
    expect(row['version']).toBe(2);
    expect(row['position_seconds']).toBe(30);
  });

  it('终态 ended → 409 PLAYBACK_ENDED(不可复活)', async () => {
    const t = await bootstrapSelectionRig('hmp-sel-ended-');
    const seeded = seedPlaybackSession(t.world, { state: 'ended', at: PLAYBACK_FIXTURE_NOW });
    await expectDomainError(
      t.service.seek(seeded.sessionId, { expectedVersion: 1, positionSeconds: 5 }, t.context),
      409,
      ProblemCode.PLAYBACK_ENDED,
    );
  });

  it('授权链拒绝(当前档案切走)→ 403 ACTIVE_PROFILE_REQUIRED 且不换代', async () => {
    const t = await bootstrapSelectionRig('hmp-sel-authz-');
    const seeded = seedPlaybackSession(t.world, { state: 'ready', at: PLAYBACK_FIXTURE_NOW });
    t.facts.seed(seeded.sessionId, 1, MOVIE_FACTS);
    getDb().update(deviceSession).set({ activeProfileId: null }).where(eq(deviceSession.id, t.world.deviceSessionId)).run();

    await expectDomainError(
      t.service.seek(seeded.sessionId, { expectedVersion: 1, positionSeconds: 5 }, t.context),
      403,
      ProblemCode.ACTIVE_PROFILE_REQUIRED,
    );
    expect(sessionRow(seeded.sessionId)['state']).toBe('ready');
    expect(sessionRow(seeded.sessionId)['generation']).toBe(1);
  });
});

/* ------------------------------------------------------------------ */
/* 3. 直播与越界(400 族)                                                */
/* ------------------------------------------------------------------ */

describe('T029 直播与越界', () => {
  it('直播(delivery=hls_proxy)seek → 400 PLAYBACK_SEEK_UNSUPPORTED,状态/代次/版本不变', async () => {
    const t = await bootstrapSelectionRig('hmp-sel-live-');
    const seeded = seedPlaybackSession(t.world, { state: 'playing', delivery: 'hls_proxy', at: PLAYBACK_FIXTURE_NOW });
    t.facts.seed(seeded.sessionId, 1, LIVE_FACTS);

    await expectDomainError(
      t.service.seek(seeded.sessionId, { expectedVersion: 1, positionSeconds: 30 }, t.context),
      400,
      ProblemCode.PLAYBACK_SEEK_UNSUPPORTED,
    );
    const row = sessionRow(seeded.sessionId);
    expect(row['state']).toBe('playing');
    expect(row['generation']).toBe(1);
    expect(row['version']).toBe(1);
  });

  it('直播判定第二分支:非代理交付但探测时长为 null → 同样 400 SEEK_UNSUPPORTED(OR 语义)', async () => {
    const t = await bootstrapSelectionRig('hmp-sel-live2-');
    const seeded = seedPlaybackSession(t.world, { state: 'ready', delivery: 'direct', at: PLAYBACK_FIXTURE_NOW });
    t.facts.seed(seeded.sessionId, 1, LIVE_FACTS);

    await expectDomainError(
      t.service.seek(seeded.sessionId, { expectedVersion: 1, positionSeconds: 30 }, t.context),
      400,
      ProblemCode.PLAYBACK_SEEK_UNSUPPORTED,
    );
    expect(sessionRow(seeded.sessionId)['state']).toBe('ready');
  });

  it('position 负数 → 400(请求校验);超过 duration → 400 SEEK_UNSUPPORTED;均不换代', async () => {
    const t = await bootstrapSelectionRig('hmp-sel-bounds-');
    const seeded = seedPlaybackSession(t.world, { state: 'playing', at: PLAYBACK_FIXTURE_NOW });
    t.facts.seed(seeded.sessionId, 1, MOVIE_FACTS);

    const negative = t.service.seek(seeded.sessionId, { expectedVersion: 1, positionSeconds: -1 }, t.context);
    await expectDomainError(negative, 400, ProblemCode.VALIDATION_FAILED);

    const beyond = t.service.seek(seeded.sessionId, { expectedVersion: 1, positionSeconds: 5401 }, t.context);
    await expectDomainError(beyond, 400, ProblemCode.PLAYBACK_SEEK_UNSUPPORTED);

    const row = sessionRow(seeded.sessionId);
    expect(row['state']).toBe('playing');
    expect(row['generation']).toBe(1);
    expect(row['version']).toBe(1);
  });
});

/* ------------------------------------------------------------------ */
/* 4. selection(纯字幕 version 通道 / 音轨换代通道)                      */
/* ------------------------------------------------------------------ */

describe('T029 selection 轨道选择', () => {
  it('纯字幕切换:仅 version+1、状态/generation 不变、position 持久化、无换代协同调用', async () => {
    const t = await bootstrapSelectionRig('hmp-sel-sub-');
    const seeded = seedPlaybackSession(t.world, { state: 'ready', at: PLAYBACK_FIXTURE_NOW });
    t.facts.seed(seeded.sessionId, 1, MOVIE_FACTS);

    const outcome = await expectOk(
      t.service.selectTracks(
        seeded.sessionId,
        { expectedVersion: 1, positionSeconds: 25, subtitleTrackId: 'sub-1' },
        t.context,
      ),
    );

    expect(outcome.session.state).toBe('ready');
    expect(outcome.session.version).toBe(2);
    expect(outcome.session.generation).toBe(1);
    expect(outcome.session.subtitleTrackId).toBe('sub-1');
    expect(outcome.session.positionSeconds).toBe(25);
    // 纯字幕不重建清单:无新时间轴语义(客户端沿用既有映射),无换代取消
    expect(outcome.dto.generation).toBe(1);
    expect(outcome.dto.durationSeconds).toBe(5400);
    expect(outcome.dto.playbackUrl).toBeNull();
    expect(t.coordinator.calls).toHaveLength(0);
    const row = sessionRow(seeded.sessionId);
    expect(row['subtitle_track_id']).toBe('sub-1');
    expect(row['position_seconds']).toBe(25);
    expect(row['version']).toBe(2);
    expect(row['generation']).toBe(1);
  });

  it('subtitleTrackId:null 合法(关闭字幕):仅 version+1,状态不变', async () => {
    const t = await bootstrapSelectionRig('hmp-sel-subnull-');
    const seeded = seedPlaybackSession(t.world, { state: 'ready', at: PLAYBACK_FIXTURE_NOW });
    t.facts.seed(seeded.sessionId, 1, MOVIE_FACTS);
    getDb()
      .update(playbackSession)
      .set({ subtitleTrackId: 'sub-1' })
      .where(eq(playbackSession.id, seeded.sessionId))
      .run();

    const outcome = await expectOk(
      t.service.selectTracks(seeded.sessionId, { expectedVersion: 1, positionSeconds: 12, subtitleTrackId: null }, t.context),
    );

    expect(outcome.session.state).toBe('ready');
    expect(outcome.session.subtitleTrackId).toBeNull();
    expect(outcome.session.version).toBe(2);
    expect(outcome.session.generation).toBe(1);
    expect(sessionRow(seeded.sessionId)['subtitle_track_id']).toBeNull();
  });

  it('音轨切换(需重建输出):generation+1 version+1、preparing、desiredPaused 保留、换代协同被调用', async () => {
    const t = await bootstrapSelectionRig('hmp-sel-aud-');
    const seeded = seedPlaybackSession(t.world, { state: 'paused', at: PLAYBACK_FIXTURE_NOW });
    t.facts.seed(seeded.sessionId, 1, MOVIE_FACTS);

    const outcome = await expectOk(
      t.service.selectTracks(seeded.sessionId, { expectedVersion: 1, positionSeconds: 30, audioTrackId: 'aud-2' }, t.context),
    );

    expect(outcome.session.state).toBe('preparing');
    expect(outcome.session.generation).toBe(2);
    expect(outcome.session.version).toBe(2);
    expect(outcome.session.audioTrackId).toBe('aud-2');
    expect(outcome.session.desiredPaused).toBe(true);
    expect(outcome.dto.playbackUrl).toBeNull();
    expect(t.coordinator.calls).toEqual([{ sessionId: seeded.sessionId, supersededGeneration: 1 }]);
    const row = sessionRow(seeded.sessionId);
    expect(row['state']).toBe('preparing');
    expect(row['audio_track_id']).toBe('aud-2');
    expect(row['desired_paused']).toBe(1);
  });

  it('音轨+字幕同请求:单次换代同时落两轨(不拆两次 CAS)', async () => {
    const t = await bootstrapSelectionRig('hmp-sel-both-');
    const seeded = seedPlaybackSession(t.world, { state: 'ready', at: PLAYBACK_FIXTURE_NOW });
    t.facts.seed(seeded.sessionId, 1, MOVIE_FACTS);

    const outcome = await expectOk(
      t.service.selectTracks(
        seeded.sessionId,
        { expectedVersion: 1, positionSeconds: 33, audioTrackId: 'aud-2', subtitleTrackId: 'sub-2' },
        t.context,
      ),
    );

    expect(outcome.session.generation).toBe(2);
    expect(outcome.session.version).toBe(2);
    expect(outcome.session.audioTrackId).toBe('aud-2');
    expect(outcome.session.subtitleTrackId).toBe('sub-2');
    expect(t.coordinator.calls).toHaveLength(1);
  });

  it('非法轨道 ID(音轨/字幕未探测)→ 400 PLAYBACK_SELECTION_INVALID 且行原样', async () => {
    const t = await bootstrapSelectionRig('hmp-sel-invalid-');
    const seeded = seedPlaybackSession(t.world, { state: 'ready', at: PLAYBACK_FIXTURE_NOW });
    t.facts.seed(seeded.sessionId, 1, MOVIE_FACTS);

    await expectDomainError(
      t.service.selectTracks(seeded.sessionId, { expectedVersion: 1, positionSeconds: 10, audioTrackId: 'aud-404' }, t.context),
      400,
      ProblemCode.PLAYBACK_SELECTION_INVALID,
    );
    await expectDomainError(
      t.service.selectTracks(seeded.sessionId, { expectedVersion: 1, positionSeconds: 10, subtitleTrackId: 'sub-404' }, t.context),
      400,
      ProblemCode.PLAYBACK_SELECTION_INVALID,
    );
    const row = sessionRow(seeded.sessionId);
    expect(row['version']).toBe(1);
    expect(row['audio_track_id']).toBeNull();
    expect(row['subtitle_track_id']).toBeNull();
  });

  it('旁车字幕 ID(字幕目录端口)同样合法:纯字幕通道接受 non-probe 词表成员', async () => {
    const t = await bootstrapSelectionRig('hmp-sel-sidecar-');
    const seeded = seedPlaybackSession(t.world, { state: 'ready', at: PLAYBACK_FIXTURE_NOW });
    t.facts.seed(seeded.sessionId, 1, MOVIE_FACTS);

    const outcome = await expectOk(
      t.service.selectTracks(
        seeded.sessionId,
        { expectedVersion: 1, positionSeconds: 8, subtitleTrackId: 'sub-sidecar-1' },
        t.context,
      ),
    );
    expect(outcome.session.subtitleTrackId).toBe('sub-sidecar-1');
    expect(outcome.session.version).toBe(2);
    expect(outcome.session.generation).toBe(1);
  });

  it('无有效变更(音轨 ID 等于当前)→ 不换代不升版本(no-op 幂等视图)', async () => {
    const t = await bootstrapSelectionRig('hmp-sel-noop-');
    const seeded = seedPlaybackSession(t.world, { state: 'ready', at: PLAYBACK_FIXTURE_NOW });
    t.facts.seed(seeded.sessionId, 1, MOVIE_FACTS);
    getDb().update(playbackSession).set({ audioTrackId: 'aud-1' }).where(eq(playbackSession.id, seeded.sessionId)).run();

    const outcome = await expectOk(
      t.service.selectTracks(seeded.sessionId, { expectedVersion: 1, positionSeconds: 3, audioTrackId: 'aud-1' }, t.context),
    );
    expect(outcome.session.version).toBe(1);
    expect(outcome.session.generation).toBe(1);
    expect(outcome.session.state).toBe('ready');
    expect(t.coordinator.calls).toHaveLength(0);
  });
});

/* ------------------------------------------------------------------ */
/* 5. 旧票失效与 ready 后 renew 取票(经真实票据服务)                     */
/* ------------------------------------------------------------------ */

describe('T029 旧代票据失效(换代后旧 generation 不可签发)', () => {
  it('seek 换代后旧 expectedGeneration renew 被拒且不写票;新代 ready 后旧代 409 GENERATION_STALE、新代 renew(2) 成功且票行 generation=2', async () => {
    const t = await bootstrapSelectionRig('hmp-sel-ticket-');
    const seeded = seedPlaybackSession(t.world, { state: 'ready', at: PLAYBACK_FIXTURE_NOW });
    t.facts.seed(seeded.sessionId, 1, MOVIE_FACTS);
    const tickets = new PlaybackTicketService(t.repo, t.authorization, t.budgets);

    await expectOk(t.service.seek(seeded.sessionId, { expectedVersion: 1, positionSeconds: 120 }, t.context));

    // 准备窗口(新代 preparing):preparing 拒签票 —— 旧代既拿不到新票,旧票也因代次
    // 归属失效(仓储语义:preparing 先于 generation 比较返回 NOT_READY)
    await expectDomainError(
      tickets.issueOrRenew(seeded.sessionId, 1, t.context),
      409,
      ProblemCode.PLAYBACK_NOT_READY,
    );
    const duringPrepare = Database.db.prepare('SELECT count(*) AS n FROM playback_ticket WHERE session_id = ?').get(seeded.sessionId) as { n: number };
    expect(duringPrepare.n).toBe(0);

    // 新代准备完成(ready):交付态下旧代签发为纯 CAS 拒绝 —— GENERATION_STALE 且不写行
    const ready = t.repo.markReady(seeded.sessionId, {
      cas: { expectedVersion: 2, expectedGeneration: 2 },
      playbackSourceId: t.world.iptv.playbackSourceId,
      delivery: 'direct',
    });
    expect(ready.ok).toBe(true);
    await expectDomainError(
      tickets.issueOrRenew(seeded.sessionId, 1, t.context),
      409,
      ProblemCode.PLAYBACK_GENERATION_STALE,
    );
    // 新代 renew 取票成功:票行 generation=2(ready 后 renew 取票闭环)
    const reply = await tickets.issueOrRenew(seeded.sessionId, 2, t.context);
    expect(reply.generation).toBe(2);
    const rows = Database.db.prepare('SELECT generation FROM playback_ticket WHERE session_id = ?').all(seeded.sessionId) as Array<{ generation: number }>;
    expect(rows).toHaveLength(1);
    expect(rows[0]!.generation).toBe(2);
  });
});

/* ------------------------------------------------------------------ */
/* 6. 不瞬时双占额度(换代即取消旧代转换)                                 */
/* ------------------------------------------------------------------ */

describe('T029 单槽串行的额度协同(不瞬时双占)', () => {
  it('换代(seek/音轨)发出「取消被替代代次」意图且先于返回;纯字幕不发出', async () => {
    const t = await bootstrapSelectionRig('hmp-sel-quota-');
    const seeked = seedPlaybackSession(t.world, { state: 'playing', at: PLAYBACK_FIXTURE_NOW });
    t.facts.seed(seeked.sessionId, 1, MOVIE_FACTS);
    await expectOk(t.service.seek(seeked.sessionId, { expectedVersion: 1, positionSeconds: 70 }, t.context));
    expect(t.coordinator.calls).toEqual([{ sessionId: seeked.sessionId, supersededGeneration: 1 }]);

    // 纯字幕切换:无重建,不取消任何任务
    const subtitled = seedPlaybackSession(t.world, { state: 'ready', at: PLAYBACK_FIXTURE_NOW });
    t.facts.seed(subtitled.sessionId, 1, MOVIE_FACTS);
    await expectOk(
      t.service.selectTracks(subtitled.sessionId, { expectedVersion: 1, positionSeconds: 2, subtitleTrackId: 'sub-1' }, t.context),
    );
    expect(t.coordinator.calls).toHaveLength(1);
  });
});

/* ------------------------------------------------------------------ */
/* 7. 时间轴纯函数(R8 关键帧前区间,确定性)                              */
/* ------------------------------------------------------------------ */

describe('T029 computeSeekTimeline(关键帧前区间纯函数)', () => {
  const K = 4; // budgets.timeline.targetSegmentSeconds

  it('HLS 族交付:对齐目标位置之前的关键帧;offset=对齐点,presentationStart=目标-对齐点 ∈ [0,K)', () => {
    for (const position of [1, 3.9, 4, 4.1, 88, 90, 91, 5399]) {
      const meta = computeSeekTimeline({ positionSeconds: position, durationSeconds: 5400, delivery: 'remux', keyframeIntervalSeconds: K });
      const aligned = meta.timelineOffsetSeconds;
      expect(aligned, `position=${position} 对齐点应落在 4s 栅格`).toBe(Math.floor(position / K) * K);
      expect(aligned).toBeLessThanOrEqual(position);
      expect(position).toBeLessThan(aligned + K);
      expect(meta.presentationStartSeconds).toBe(position - aligned);
      expect(meta.presentationStartSeconds).toBeGreaterThanOrEqual(0);
      expect(meta.presentationStartSeconds).toBeLessThan(K);
      expect(meta.durationSeconds).toBe(5400);
    }
  });

  it('direct 交付:字节流即影片时间,offset=目标位置、presentationStart=0(无前置区间)', () => {
    const meta = computeSeekTimeline({ positionSeconds: 90, durationSeconds: 5400, delivery: 'direct', keyframeIntervalSeconds: K });
    expect(meta.timelineOffsetSeconds).toBe(90);
    expect(meta.presentationStartSeconds).toBe(0);
    expect(meta.durationSeconds).toBe(5400);
  });

  it('position=0 与直播形态(duration null):duration 原样透传;hls 族对齐规则唯一(无特例)', () => {
    const zero = computeSeekTimeline({ positionSeconds: 0, durationSeconds: 5400, delivery: 'remux', keyframeIntervalSeconds: K });
    expect(zero.timelineOffsetSeconds).toBe(0);
    expect(zero.presentationStartSeconds).toBe(0);
    // 直播形态实际不可达(seek 已被 400 拒绝);纯函数对 hls 族保持同一对齐规则,无 null 特例
    const live = computeSeekTimeline({ positionSeconds: 30, durationSeconds: null, delivery: 'hls_proxy', keyframeIntervalSeconds: K });
    expect(live.durationSeconds).toBeNull();
    expect(live.timelineOffsetSeconds).toBe(28);
    expect(live.presentationStartSeconds).toBe(2);
  });
});
