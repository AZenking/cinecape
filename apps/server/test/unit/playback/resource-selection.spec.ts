import 'reflect-metadata';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ProblemCode } from '@hmp/shared';
import type { INestApplication } from '@nestjs/common';
import {
  PLAYBACK_FIXTURE_NOW,
  seedPlaybackWorld,
  type PlaybackSourceRef,
  type PlaybackWorld,
} from '../../fixtures/playback';
import { Database } from '../../../src/database/database';
import { setEnvOverride } from '../../../src/config/env';
import { loadEnv } from '../../../src/config/env.schema';
import { createPlaybackBudgets, type PlaybackBudgets } from '../../../src/config/playback-budgets';
import { getDb } from '@contexts/identity-access/infrastructure/db';
import {
  account,
  deviceSession,
  mediaSource,
  playbackSource,
  profilePolicy,
  sourceEntry,
} from '../../../src/database/schema';
import { DomainError } from '../../../src/common/domain-error';
import { hashToken } from '@contexts/identity-access/infrastructure/token.service';
import type { SessionContext } from '../../../src/common/current-session.decorator';
import { PlaybackRepository } from '../../../src/contexts/playback/infrastructure/playback.repository';
import {
  PlaybackAuthorizationService,
  comparePlaybackCandidates,
  type PlaybackResourceCandidate,
} from '../../../src/contexts/playback/application/playback-authorization.service';
import {
  PlaybackResolverService,
  type PlaybackProbeFacts,
  type PlaybackProbeOutcome,
  type PlaybackProbePort,
} from '../../../src/contexts/playback/application/playback-resolver.service';
import { PlaybackTicketService } from '../../../src/contexts/playback/application/playback-ticket.service';

/**
 * 资源选择与 preparing 会话单元测试(T019,spec 004;playback-resolver.service.ts 的被测底层)。
 *
 * 权威依据(docs/specs/004-playback-resolver):
 * - tasks.md T019:可用资源稳定选择及 preparing session(source/delivery 可空),按
 *   data-model「资源选择与模型权威性」排序(成本→source_id→playback_source_id,无 priority);
 *   源失效下次解析切换;授权拒绝不建 session;解析响应不等待完整 probe;GET 状态不泄漏
 *   源 ID/位置;probe 结束进 ready,首次交付进 playing,ready 前无票;异步失败只更新 session;
 * - data-model.md「## playback_session」:首次请求 generation=version=1、position=0、
 *   desired_paused=0;preparing 允许 source/delivery 为空,不在 probe 前猜测 delivery;
 *   同步鉴权拒绝不创建 session,异步 probe 失败记录在已有 session;
 * - contracts/api.md:resolve 201 仅表示接受,delivery 与 URL 为空;GET 不重签也不复现旧票,
 *   delivery 在探测完成前为 null,tracks 探测未完成为空,不返回所选源 ID/位置。
 *
 * 探测端口:ProbePort 由本服务定义并在构造注入,测试用 fake(脚本化/挂起 deferred);
 * 授权链用真实实例 + 夹具多源种子。
 */

/** 注入 120s 票据 TTL(与本任务无票据签发无冲突;预算对象整体注入,期限取 watchdog 30s) */
function budgetsForTest(): PlaybackBudgets {
  return createPlaybackBudgets(loadEnv({ NODE_ENV: 'test', PLAYBACK_TICKET_TTL_SECONDS: '120' }));
}

/** 脚本化 fake ProbePort:记录每次调用(候选+期限),按脚本返回结果 */
class ScriptedProbePort implements PlaybackProbePort {
  readonly calls: Array<{ candidates: readonly PlaybackResourceCandidate[]; deadlineMs: number }> = [];

  constructor(
    private readonly script: (
      candidates: readonly PlaybackResourceCandidate[],
      callIndex: number,
    ) => PlaybackProbeOutcome | Promise<PlaybackProbeOutcome>,
  ) {}

  async probeFirstAvailable(
    candidates: readonly PlaybackResourceCandidate[],
    deadlineMs: number,
  ): Promise<PlaybackProbeOutcome> {
    this.calls.push({ candidates, deadlineMs });
    return this.script(candidates, this.calls.length - 1);
  }
}

/** 挂起 deferred 的 fake ProbePort:resolve/reject 由测试显式触发(不等待 probe 用) */
class DeferredProbePort implements PlaybackProbePort {
  readonly calls: Array<{ candidates: readonly PlaybackResourceCandidate[]; deadlineMs: number }> = [];
  private deferred: {
    resolve: (outcome: PlaybackProbeOutcome) => void;
    reject: (error: unknown) => void;
  } | null = null;

  async probeFirstAvailable(
    candidates: readonly PlaybackResourceCandidate[],
    deadlineMs: number,
  ): Promise<PlaybackProbeOutcome> {
    this.calls.push({ candidates, deadlineMs });
    return new Promise<PlaybackProbeOutcome>((resolve, reject) => {
      this.deferred = { resolve, reject };
    });
  }

  settle(outcome: PlaybackProbeOutcome): void {
    if (this.deferred === null) {
      throw new Error('fake probe 尚未被调用');
    }
    this.deferred.resolve(outcome);
    this.deferred = null;
  }
}

interface ResolverRig {
  dataDir: string;
  world: PlaybackWorld;
  repo: PlaybackRepository;
  authorization: PlaybackAuthorizationService;
  budgets: PlaybackBudgets;
  context: SessionContext;
}

/** 纯 DB rig(不经 Nest 容器;repository.spec.ts 同款):临时 DATA_DIR + 权威迁移 DDL 0001~0005 */
const rigs: ResolverRig[] = [];

function migrationSql(name: string): string {
  const migrationPath = path.join(process.cwd(), 'src/database/migrations', name, 'up.sql');
  if (!fs.existsSync(migrationPath)) {
    throw new Error(`未找到迁移文件 ${migrationPath} —— 本测试须以 apps/server 为工作目录运行`);
  }
  return fs.readFileSync(migrationPath, 'utf8');
}

async function bootstrapResolverRig(prefix: string, options: { nasEnabled?: boolean } = {}): Promise<ResolverRig> {
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
  // 夹具仅需 rig 句柄约束调用时序(数据访问走 Database 单例 getDb());不经 Nest app
  const fakeRig = { app: {} as INestApplication, dataDir, dbFilename: `${randomUUID()}.hmp.db` };
  const world = await seedPlaybackWorld(fakeRig, { nasEnabled: options.nasEnabled === true });
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
  const resolverRig: ResolverRig = { dataDir, world, repo, authorization, budgets, context };
  rigs.push(resolverRig);
  return resolverRig;
}

/** afterEach 调用:关闭并清理全部 rig */
async function cleanupResolverRigs(): Promise<void> {
  while (rigs.length > 0) {
    const rig = rigs.pop();
    if (rig === undefined) {
      break;
    }
    Database.close();
    fs.rmSync(rig.dataDir, { recursive: true, force: true });
  }
}

function buildResolver(
  t: ResolverRig,
  probePort: PlaybackProbePort,
): PlaybackResolverService {
  return new PlaybackResolverService(t.repo, t.authorization, probePort, t.budgets);
}

/** 在既有启用源上为媒体追加一条播放资源(多候选;与 authorization.spec 同款种子) */
function attachExtraResource(
  world: PlaybackWorld,
  mediaId: string,
  via: PlaybackSourceRef,
  opts: { protocol: string; requiresProxy: 0 | 1 },
): PlaybackSourceRef {
  const entryId = randomUUID();
  const playbackSourceId = randomUUID();
  const now = PLAYBACK_FIXTURE_NOW;
  getDb()
    .insert(sourceEntry)
    .values({
      id: entryId,
      householdId: world.householdId,
      sourceId: via.sourceId,
      identityKind: 'url',
      identityDigest: hashToken(`extra-entry:${entryId}`),
      mediaId,
      present: 1,
      firstSeenAt: now,
      lastSeenAt: now,
    })
    .run();
  getDb()
    .insert(playbackSource)
    .values({
      id: playbackSourceId,
      householdId: world.householdId,
      sourceId: via.sourceId,
      sourceEntryId: entryId,
      mediaItemId: mediaId,
      protocol: opts.protocol,
      location: `https://playback-fixture.test/extra/${playbackSourceId}`,
      mimeType: 'video/mp4',
      priority: 100,
      requiresProxy: opts.requiresProxy,
      createdAt: now,
      updatedAt: now,
    })
    .run();
  return { sourceId: via.sourceId, entryId, mediaId, playbackSourceId };
}

/** 会话行(原始列;含 playback_source_id —— 仅测试内断言用,绝不进 DTO) */
function sessionRow(sessionId: string): Record<string, unknown> {
  const row = Database.db.prepare('SELECT * FROM playback_session WHERE id = ?').get(sessionId) as
    | Record<string, unknown>
    | undefined;
  expect(row, `会话行应存在:${sessionId}`).toBeDefined();
  return row as Record<string, unknown>;
}

function sessionCount(): number {
  return (Database.db.prepare('SELECT count(*) AS n FROM playback_session').get() as { n: number }).n;
}

function failureEventCount(): number {
  return (Database.db.prepare('SELECT count(*) AS n FROM playback_failure_event').get() as { n: number }).n;
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

const MOVIE_FACTS: PlaybackProbeFacts = {
  durationSeconds: 5400,
  audioTracks: [{ id: 'a1', label: '普通话', language: 'zh', default: true }],
  subtitleTracks: [{ id: 's1', label: '简体中文', language: 'zh-CN' }],
};

afterEach(async () => {
  await cleanupResolverRigs();
});

/* ------------------------------------------------------------------ */
/* 1. 候选排序(经授权真实链):成本 → source_id 二进制 → playback_source_id */
/* ------------------------------------------------------------------ */

describe('T019 候选选择(data-model 排序,不做 probe 前猜测)', () => {
  it('多源成本排序:授权管线候选原序传入 probe(NAS direct 与 IPTV hls_proxy 同成本按 source_id 二进制),session 保持 source/delivery 为空直到 probe 完成', async () => {
    const t = await bootstrapResolverRig('hmp-resel-multi-', { nasEnabled: true });
    const extra = attachExtraResource(t.world, t.world.nas.mediaId, t.world.iptv, {
      protocol: 'http',
      requiresProxy: 1,
    });
    // 挂起 probe:resolve 返回时刻的 preparing 形态确定可断言(不被 microtask 竞速)
    const probe = new DeferredProbePort();
    const service = buildResolver(t, probe);
    const { session, dto } = await service.resolve(t.context, t.world.nas.mediaId);

    // probe 收到的候选 = 授权排序(原序,不被 resolver 重排)
    expect(probe.calls).toHaveLength(1);
    const expectedSource: PlaybackResourceCandidate[] = [
      { playbackSourceId: t.world.nas.playbackSourceId, sourceId: t.world.nas.sourceId, delivery: 'direct' },
      { playbackSourceId: extra.playbackSourceId, sourceId: extra.sourceId, delivery: 'hls_proxy' },
    ];
    const expected = [...expectedSource].sort(comparePlaybackCandidates);
    expect(probe.calls[0]!.candidates).toEqual(expected);
    // 稳定 ID 决胜:同成本首位 = source_id 二进制最小者(两次解析一致,稳定性)
    expect(probe.calls[0]!.candidates[0]!.sourceId).toBe(
      [t.world.nas.sourceId, extra.sourceId].sort()[0],
    );
    const secondResolve = await service.resolve(t.context, t.world.nas.mediaId);
    expect(secondResolve.session.id).not.toBe(session.id);
    expect(secondResolve.dto.state).toBe('preparing');
    expect(probe.calls).toHaveLength(2);
    expect(probe.calls[1]!.candidates).toEqual(probe.calls[0]!.candidates);

    // resolve 返回时仍是 preparing:不猜测 delivery/session 源
    expect(session.state).toBe('preparing');
    expect(dto.state).toBe('preparing');
    expect(dto.delivery).toBeNull();
    const row = sessionRow(session.id);
    expect(row['playback_source_id']).toBeNull();
    expect(row['delivery']).toBeNull();
  });

  it('preparing 建档字段:generation=version=1、position=0、desired_paused=0、created_at=last_heartbeat_at=now(UTC)', async () => {
    const t = await bootstrapResolverRig('hmp-resel-prep-');
    // 挂起 probe:建档列值在 preparing 形态下断言
    const probe = new DeferredProbePort();
    const service = buildResolver(t, probe);
    const { session } = await service.resolve(t.context, t.world.iptv.mediaId, { at: PLAYBACK_FIXTURE_NOW });
    const row = sessionRow(session.id);
    expect(row['state']).toBe('preparing');
    expect(row['generation']).toBe(1);
    expect(row['version']).toBe(1);
    expect(row['position_seconds']).toBe(0);
    expect(row['desired_paused']).toBe(0);
    expect(row['playback_source_id']).toBeNull();
    expect(row['delivery']).toBeNull();
    expect(row['created_at']).toBe(PLAYBACK_FIXTURE_NOW);
    expect(row['last_heartbeat_at']).toBe(PLAYBACK_FIXTURE_NOW);
    // 绑定授权快照身份(服务端事实,非请求声明)
    expect(row['household_id']).toBe(t.world.householdId);
    expect(row['device_session_id']).toBe(t.world.deviceSessionId);
    expect(row['device_id']).toBe(t.world.deviceId);
    expect(row['profile_id']).toBe(t.world.profileId);
    expect(row['media_id']).toBe(t.world.iptv.mediaId);
  });
});

/* ------------------------------------------------------------------ */
/* 2. probe 集成:总期限共享 / 失败候选切换 / 异步流                    */
/* ------------------------------------------------------------------ */

describe('T019 probe 集成(总期限共享;失败候选切换;resolve 不等待)', () => {
  it('总期限共享:单次 probeFirstAvailable 携带全部候选与 30s 期限(budgets.watchdog.prepareTimeoutSeconds×1000),候选逐个尝试不重置期限', async () => {
    const t = await bootstrapResolverRig('hmp-resel-deadline-', { nasEnabled: true });
    attachExtraResource(t.world, t.world.nas.mediaId, t.world.iptv, { protocol: 'http', requiresProxy: 1 });
    const probe = new ScriptedProbePort(() => ({ error: 'resource_unavailable' }));
    const service = buildResolver(t, probe);
    const { session } = await service.resolve(t.context, t.world.nas.mediaId);
    expect(probe.calls).toHaveLength(1);
    expect(probe.calls[0]!.deadlineMs).toBe(t.budgets.watchdog.prepareTimeoutSeconds * 1000);
    expect(probe.calls[0]!.deadlineMs).toBe(30_000);
    expect(probe.calls[0]!.candidates.length).toBe(2);
    // 全部候选失败 → failed(单次调用即共享同一期限,无逐候选重置)
    await vi.waitFor(() => {
      expect(sessionRow(session.id)['state']).toBe('failed');
    });
  });

  it('失败候选切换:fake probe 第一候选失败→第二候选成功 → ready 落第二候选(source/delivery/facts 全部落库)', async () => {
    const t = await bootstrapResolverRig('hmp-resel-switch-', { nasEnabled: true });
    attachExtraResource(t.world, t.world.nas.mediaId, t.world.iptv, {
      protocol: 'http',
      requiresProxy: 1,
    });
    // 授权排序后第二候选
    const grant = await t.authorization.authorizeResolve(t.context, t.world.nas.mediaId);
    const sorted = [...grant.candidates].sort(comparePlaybackCandidates);
    expect(sorted.length).toBe(2);
    const first = sorted[0]!;
    const second = sorted[1]!;
    // fake 端口忠实模拟「端口内部逐候选尝试」:第一候选探测失败(format_unsupported),
    // 端口自行切换到第二候选并成功 —— 端口返回的整体结果即第二候选成功
    const attempted: string[] = [];
    const probe = new ScriptedProbePort((candidates) => {
      attempted.push(candidates[0]!.playbackSourceId);
      return {
        playbackSourceId: second.playbackSourceId,
        delivery: second.delivery,
        facts: MOVIE_FACTS,
      };
    });
    const service = buildResolver(t, probe);
    const { session } = await service.resolve(t.context, t.world.nas.mediaId);
    await vi.waitFor(() => {
      expect(sessionRow(session.id)['state']).toBe('ready');
    });
    const row = sessionRow(session.id);
    expect(row['state']).toBe('ready');
    expect(row['playback_source_id']).toBe(second.playbackSourceId);
    expect(row['delivery']).toBe(second.delivery);
    expect(row['playback_source_id']).not.toBe(first.playbackSourceId);
    expect(attempted).toEqual([first.playbackSourceId]);
  });

  it('resolve 不等待 probe:fake probe 挂起时 resolve 已返回 preparing(GET 可轮询)', async () => {
    const t = await bootstrapResolverRig('hmp-resel-nowait-');
    const probe = new DeferredProbePort();
    const service = buildResolver(t, probe);
    const { session, dto } = await service.resolve(t.context, t.world.iptv.mediaId);
    // resolve 已返回(未被挂起 probe 阻塞):preparing、delivery 空、tracks 空
    expect(session.state).toBe('preparing');
    expect(dto.delivery).toBeNull();
    expect(dto.durationSeconds).toBeNull();
    expect(dto.tracks.audio).toEqual([]);
    expect(dto.tracks.subtitles).toEqual([]);
    // probe 完成后 → ready + facts 落视图
    probe.settle({
      playbackSourceId: t.world.iptv.playbackSourceId,
      delivery: 'hls_proxy',
      facts: MOVIE_FACTS,
    });
    await vi.waitFor(() => {
      expect(sessionRow(session.id)['state']).toBe('ready');
    });
    const fresh = t.repo.getSession(t.world.householdId, session.id);
    expect(fresh.ok).toBe(true);
    if (fresh.ok) {
      const readyDto = service.toDto(fresh.value);
      expect(readyDto.state).toBe('ready');
      expect(readyDto.delivery).toBe('hls_proxy');
      expect(readyDto.durationSeconds).toBe(5400);
      expect(readyDto.tracks.audio).toEqual(MOVIE_FACTS.audioTracks);
      expect(readyDto.tracks.subtitles).toEqual(MOVIE_FACTS.subtitleTracks);
    }
  });
});

/* ------------------------------------------------------------------ */
/* 3. 异步失败:只更新 session,不建 failure_event(T043 审计语义)        */
/* ------------------------------------------------------------------ */

describe('T019 异步失败(只更新 session)', () => {
  it('失败分类映射:format_unsupported→PLAYBACK_FORMAT_UNSUPPORTED、resource_unavailable→PLAYBACK_RESOURCE_UNAVAILABLE、timeout→PLAYBACK_PREPARE_TIMEOUT;playback_failure_event 恒 0 行', async () => {
    const t = await bootstrapResolverRig('hmp-resel-afail-');
    for (const [kind, code] of [
      ['format_unsupported', 'PLAYBACK_FORMAT_UNSUPPORTED'],
      ['resource_unavailable', 'PLAYBACK_RESOURCE_UNAVAILABLE'],
      ['timeout', 'PLAYBACK_PREPARE_TIMEOUT'],
    ] as const) {
      const probe = new ScriptedProbePort(() => ({ error: kind }));
      const service = buildResolver(t, probe);
      const { session } = await service.resolve(t.context, t.world.iptv.mediaId);
      await vi.waitFor(() => {
        expect(sessionRow(session.id)['state']).toBe('failed');
      });
      const row = sessionRow(session.id);
      expect(row['failure_code']).toBe(code);
      expect(row['ended_at']).not.toBeNull();
      // 准备失败仍可为空:禁止补造源/delivery
      expect(row['playback_source_id']).toBeNull();
      expect(row['delivery']).toBeNull();
    }
    // 异步失败只更新 session:failure_event 不建行(仅同步拒绝属 T043 审计语义)
    expect(failureEventCount()).toBe(0);
  });
});

/* ------------------------------------------------------------------ */
/* 4. 授权拒绝不建 session                                             */
/* ------------------------------------------------------------------ */

describe('T019 授权拒绝不建 session(服务顺序保证)', () => {
  it('不可见媒体(无条目/无资源) → 404 MEDIA_NOT_FOUND,playback_session 0 行,probe 未被调用', async () => {
    const t = await bootstrapResolverRig('hmp-resel-deny-');
    const probe = new ScriptedProbePort(() => {
      throw new Error('授权拒绝路径不得调用 probe');
    });
    const service = buildResolver(t, probe);
    await expectDomainError(
      service.resolve(t.context, t.world.invisibleMediaId),
      404,
      ProblemCode.MEDIA_NOT_FOUND,
    );
    expect(sessionCount()).toBe(0);
    expect(probe.calls).toHaveLength(0);
  });

  it('媒体无启用源(NAS 停用、IPTV 他源启用) → 404 MEDIA_NOT_FOUND 同形,不建 session', async () => {
    const t = await bootstrapResolverRig('hmp-resel-nosrc-');
    const probe = new ScriptedProbePort(() => {
      throw new Error('授权拒绝路径不得调用 probe');
    });
    const service = buildResolver(t, probe);
    await expectDomainError(service.resolve(t.context, t.world.nas.mediaId), 404, ProblemCode.MEDIA_NOT_FOUND);
    expect(sessionCount()).toBe(0);
  });
});

/* ------------------------------------------------------------------ */
/* 5. 源失效:下次解析切换(ready 会话不自动迁移,新 resolve 选新源)      */
/* ------------------------------------------------------------------ */

describe('T019 源失效下次解析切换', () => {
  it('A+B 启用 → resolve S1;禁用 A 后新 resolve S2 → 候选仅 B、ready 落 B;S1 行保持不变(ready 后源失效由生命周期 T028 结束)', async () => {
    const t = await bootstrapResolverRig('hmp-resel-invalid-', { nasEnabled: true });
    // nas.mediaId 同时挂 NAS(direct)与 IPTV 附加(hls_proxy)两源
    attachExtraResource(t.world, t.world.nas.mediaId, t.world.iptv, { protocol: 'http', requiresProxy: 1 });
    const grant = await t.authorization.authorizeResolve(t.context, t.world.nas.mediaId);
    const sorted = [...grant.candidates].sort(comparePlaybackCandidates);
    expect(sorted.length).toBe(2);
    const first = sorted[0]!;
    const second = sorted[1]!;

    // fake 端口:第一候选尝试失败后端口自行落到次选并成功(两次解析都返回次选成功)
    const probe = new ScriptedProbePort(
      () => ({
        playbackSourceId: second.playbackSourceId,
        delivery: second.delivery,
        facts: MOVIE_FACTS,
      }),
    );
    const service = buildResolver(t, probe);
    const s1 = await service.resolve(t.context, t.world.nas.mediaId);
    await vi.waitFor(() => {
      expect(sessionRow(s1.session.id)['state']).toBe('ready');
    });
    expect(sessionRow(s1.session.id)['playback_source_id']).toBe(second.playbackSourceId);
    const probeCallsAfterS1 = probe.calls.length;

    // 源失效:首选候选父源停用(授权层面候选消失)
    getDb().update(mediaSource).set({ enabled: 0 }).where(eq(mediaSource.id, first.sourceId)).run();
    const s2 = await service.resolve(t.context, t.world.nas.mediaId);
    expect(s2.session.id).not.toBe(s1.session.id);
    // 新解析候选只剩次选(授权管线实时事实)
    expect(probe.calls[probeCallsAfterS1]!.candidates.map((c) => c.playbackSourceId)).toEqual([
      second.playbackSourceId,
    ]);
    await vi.waitFor(() => {
      expect(sessionRow(s2.session.id)['state']).toBe('ready');
    });
    expect(sessionRow(s2.session.id)['playback_source_id']).toBe(second.playbackSourceId);
    // 旧会话不被自动改写(不沿用旧 probe 之外的迁移)
    expect(sessionRow(s1.session.id)['playback_source_id']).toBe(second.playbackSourceId);
  });
});

/* ------------------------------------------------------------------ */
/* 6. GET 状态视图:无源泄漏;票据字段空                                 */
/* ------------------------------------------------------------------ */

describe('T019 GET 状态视图 toDto(不泄漏源;ticket 字段空)', () => {
  it('preparing:delivery/ticket/duration/tracks 空;结构断言无 playbackSourceId/location 键', async () => {
    const t = await bootstrapResolverRig('hmp-resel-dto-prep-');
    const probe = new DeferredProbePort();
    const service = buildResolver(t, probe);
    const { session, dto } = await service.resolve(t.context, t.world.iptv.mediaId);
    expect(Object.keys(dto).sort()).toEqual([
      'delivery',
      'desiredPaused',
      'durationSeconds',
      'generation',
      'id',
      'playbackUrl',
      'positionSeconds',
      'presentationStartSeconds',
      'state',
      'ticketExpiresAt',
      'timelineOffsetSeconds',
      'tracks',
      'version',
    ]);
    expect(dto.id).toBe(session.id);
    expect(dto.state).toBe('preparing');
    expect(dto.delivery).toBeNull();
    expect(dto.ticketExpiresAt).toBeNull();
    expect(dto.playbackUrl).toBeNull();
    expect(dto.durationSeconds).toBeNull();
    expect(dto.positionSeconds).toBe(0);
    expect(dto.generation).toBe(1);
    expect(dto.version).toBe(1);
    expect(dto.desiredPaused).toBe(false);
    expect(dto.failureCode).toBeUndefined();
    // 序列化不含源 ID/位置(夹具私有 location 不出现)
    const serialized = JSON.stringify(dto);
    expect(serialized).not.toContain('playbackSourceId');
    expect(serialized).not.toContain(t.world.iptv.playbackSourceId);
    expect(serialized).not.toContain('/nas-media/');
    expect(serialized).not.toContain('iptv.playback-fixture.test');
  });

  it('ready:delivery/duration/tracks 就位;ticket 字段仍空(GET 不重签也不复现旧票)', async () => {
    const t = await bootstrapResolverRig('hmp-resel-dto-ready-');
    const probe = new ScriptedProbePort(() => ({
      playbackSourceId: t.world.iptv.playbackSourceId,
      delivery: 'hls_proxy',
      facts: MOVIE_FACTS,
    }));
    const service = buildResolver(t, probe);
    const { session } = await service.resolve(t.context, t.world.iptv.mediaId);
    await vi.waitFor(() => {
      expect(sessionRow(session.id)['state']).toBe('ready');
    });
    const loaded = t.repo.getSession(t.world.householdId, session.id);
    expect(loaded.ok).toBe(true);
    if (loaded.ok) {
      const dto = service.toDto(loaded.value, { includeTicketFields: false });
      expect(dto.delivery).toBe('hls_proxy');
      expect(dto.durationSeconds).toBe(5400);
      expect(dto.tracks.audio).toEqual([{ id: 'a1', label: '普通话', language: 'zh', default: true }]);
      expect(dto.tracks.subtitles).toEqual([{ id: 's1', label: '简体中文', language: 'zh-CN' }]);
      expect(dto.ticketExpiresAt).toBeNull();
      expect(dto.playbackUrl).toBeNull();
      expect(Object.keys(dto)).not.toContain('playbackSourceId');
      expect(JSON.stringify(dto)).not.toContain(t.world.iptv.playbackSourceId);
    }
  });

  it('failed:failureCode 呈现稳定码;源位置仍不出现', async () => {
    const t = await bootstrapResolverRig('hmp-resel-dto-fail-');
    const probe = new ScriptedProbePort(() => ({ error: 'format_unsupported' }));
    const service = buildResolver(t, probe);
    const { session } = await service.resolve(t.context, t.world.iptv.mediaId);
    await vi.waitFor(() => {
      expect(sessionRow(session.id)['state']).toBe('failed');
    });
    const loaded = t.repo.getSession(t.world.householdId, session.id);
    expect(loaded.ok).toBe(true);
    if (loaded.ok) {
      const dto = service.toDto(loaded.value);
      expect(dto.state).toBe('failed');
      expect(dto.failureCode).toBe('PLAYBACK_FORMAT_UNSUPPORTED');
      expect(dto.delivery).toBeNull();
      expect(JSON.stringify(dto)).not.toContain('playbackSourceId');
    }
  });
});

/* ------------------------------------------------------------------ */
/* 7. 交付衔接:markPlaying 委托;ready 前无票(ticket 服务衔接)          */
/* ------------------------------------------------------------------ */

describe('T019 交付衔接(probe 结束→ready;首次交付→playing;ready 前无票)', () => {
  it('markPlaying 委托仓储:ready→playing 且 started_at 一次设置;重复幂等语义由仓储 CAS 保证', async () => {
    const t = await bootstrapResolverRig('hmp-resel-playing-');
    const probe = new ScriptedProbePort(() => ({
      playbackSourceId: t.world.iptv.playbackSourceId,
      delivery: 'hls_proxy',
      facts: MOVIE_FACTS,
    }));
    const service = buildResolver(t, probe);
    const { session } = await service.resolve(t.context, t.world.iptv.mediaId);
    await vi.waitFor(() => {
      expect(sessionRow(session.id)['state']).toBe('ready');
    });
    const played = service.markPlaying(session.id, {
      cas: { expectedVersion: 1, expectedGeneration: 1 },
      at: PLAYBACK_FIXTURE_NOW,
    });
    expect(played.ok).toBe(true);
    if (played.ok) {
      expect(played.value.state).toBe('playing');
      expect(played.value.startedAt).toBe(PLAYBACK_FIXTURE_NOW);
    }
    const row = sessionRow(session.id);
    expect(row['state']).toBe('playing');
    expect(row['started_at']).toBe(PLAYBACK_FIXTURE_NOW);
  });

  it('ready 前无票:preparing 会话上签发被拒 409 PLAYBACK_NOT_READY(ticket 服务约束,注释衔接)', async () => {
    const t = await bootstrapResolverRig('hmp-resel-not-ready-');
    const probe = new DeferredProbePort();
    const service = buildResolver(t, probe);
    const { session } = await service.resolve(t.context, t.world.iptv.mediaId);
    const ticketService = new PlaybackTicketService(t.repo, t.authorization, budgetsForTest());
    await expectDomainError(
      ticketService.issueOrRenew(session.id, 1, t.context),
      409,
      ProblemCode.PLAYBACK_NOT_READY,
    );
    expect(
      (Database.db.prepare('SELECT count(*) AS n FROM playback_ticket WHERE session_id = ?').get(session.id) as {
        n: number;
      }).n,
    ).toBe(0);
  });
});
