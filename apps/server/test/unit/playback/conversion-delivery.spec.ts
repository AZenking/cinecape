import 'reflect-metadata';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { afterEach, describe, expect, it } from 'vitest';
import type { INestApplication } from '@nestjs/common';
import { createManualClock, type ManualClock } from '../../fixtures/clock';
import {
  PLAYBACK_FIXTURE_NOW,
  seedPlaybackWorld,
  type PlaybackWorld,
} from '../../fixtures/playback';
import { Database } from '../../../src/database/database';
import { setEnvOverride } from '../../../src/config/env';
import { loadEnv } from '../../../src/config/env.schema';
import { createPlaybackBudgets, type PlaybackBudgets } from '../../../src/config/playback-budgets';
import { getDb } from '../../../src/modules/auth/db';
import { account, deviceSession, playbackSource, profilePolicy } from '../../../src/database/schema';
import type { SessionContext } from '../../../src/common/current-session.decorator';
import { PlaybackRepository } from '../../../src/modules/playback/playback.repository';
import { PlaybackAuthorizationService } from '../../../src/modules/playback/playback-authorization.service';
import { PlaybackLifecycleService, type LifecycleStoragePort } from '../../../src/modules/playback/playback-lifecycle.service';
import { ConversionStorageService } from '../../../src/modules/playback/conversion-storage.service';
import { ConversionSupervisorService, type ConversionProcessHandle, type ConversionSpawnRequest } from '../../../src/modules/playback/conversion-supervisor.service';
import { PlaybackAssetsService } from '../../../src/modules/playback/playback-assets.service';
import { PlaybackSourceLocationReader, resolveNasMediaLocation } from '../../../src/modules/playback/media-probe.service';
import {
  PlaybackResolverService,
  conversionPlanForDelivery,
  isConversionDelivery,
  type PlaybackConversionLaunchPort,
  type PlaybackConversionLaunchRequest,
  type PlaybackProbeFacts,
  type PlaybackProbeOutcome,
  type PlaybackProbePort,
  type PlaybackSessionSourcePort,
} from '../../../src/modules/playback/playback-resolver.service';
import { PlaybackSelectionService, type PlaybackTrackFactsPort } from '../../../src/modules/playback/playback-selection.service';
import { PlaybackTaskDirectoryLedger, PlaybackConversionBridge } from '../../../src/modules/playback/playback.module';
import type { PlaybackErrorCode, PlaybackResult } from '../../../src/modules/playback/playback.types';

/**
 * 转码交付接线单测(T033 缺口1/缺口2 修复;spec 004 US1 SC-007 四路径 HTTP 交付):
 *
 * 权威依据(先读后写):
 * - T033 runtime 冒烟暴露的两个真实接线缺口:
 *   缺口1 —— PlaybackConversionBridge.launch 无调用方,resolver 的 prepare 对
 *   delivery=remux/audio_transcode/video_transcode 只写 source/delivery+ready,从不启动
 *   ffmpeg、不建 playback_conversion 行,流网关对转码会话 GET 入口 503;
 *   缺口2 —— selection.seek/selectTracks → beginRebuild → preparing 后无人触发 prepare,
 *   会话永远停留 preparing。
 * - 修复契约形态:plan 为转换/remux → prepare 完成后进入「启动转换」阶段(reserve 满→
 *   PLAYBACK_CONVERSION_BUSY→会话 failed+同码;经 ConversionSupervisorService.start 启动
 *   真实 ffmpeg 产出滚动 HLS 到 ConversionStorageService.openTask 目录;产物目录经
 *   PlaybackAssetsService 登记为本会话本代本地产物窗口;首产物事实 → markReady(delivery=
 *   plan 模式);首帧期限由 watchdog/supervisor 既有机制约束,超期 → 稳定超时码)。
 *   换代提交后(rebuildCoordinator 已取消旧代)触发 resolver.prepareRebuild:同源同代事实
 *   (probe 事实缓存代际迁移,不重跑 ffprobe),交付决策位置无关 —— direct/hls_proxy 直接
 *   markReady,转换族经同一「启动转换→首产物→ready」管线;seek 用 15 秒预算,超期映射
 *   PLAYBACK_SEEK_TIMEOUT。
 *
 * 分层(对齐 conversion.spec 的 ManualClock + 假进程夹具模式):
 * - 桥接管线组(真实 supervisor/storage/ledger/lifecycle/bridge + 假 ffmpeg 进程):
 *   「plan=transcode → reserve→spawn→首产物→ok」「BUSY→立即失败无 spawn」「超期→稳定码+
 *   会话 failed+额度释放」「seek 相位 BUSY 有界重试」;
 * - resolver 组(脚本化 probe 端口 + 录制式启动端口):「转码 plan → 启动端口调用 →
 *   ready」「BUSY→failed+BUSY 码」「超时码透传」「端口缺位 fail-closed(不假 ready)」;
 * - 换代组(selection+resolver 同装配):「seek 换代 → 自动重回 ready(fake 管线)」
 *   「direct 交付换代直接重回 ready」「音轨换代同管线/纯字幕不触发」;
 * - 全链组(真实装配镜像:源定位→bridge 启动→产物窗口登记;fake spawn/时钟):
 *   preparing(首产物前)→ 首产物 → ready + argv 产物路径 + 本地窗口;
 * - 资产纯函数组(registerLocalWindow/resolveLocalAsset/rewriteLocalManifest 词法防线)。
 */

/* ------------------------------------------------------------------ */
/* 通用工具(对齐 conversion.spec)                                        */
/* ------------------------------------------------------------------ */

function expectOk<T>(result: PlaybackResult<T>): T {
  if (!result.ok) {
    throw new Error(`预期 ok,实际 err:${result.code}`);
  }
  return result.value;
}

function expectErr<T>(result: PlaybackResult<T>, code: PlaybackErrorCode): void {
  expect(result.ok).toBe(false);
  if (!result.ok) {
    expect(result.code).toBe(code);
  }
}

async function flushMicrotasks(turns = 8): Promise<void> {
  for (let index = 0; index < turns; index += 1) {
    await Promise.resolve();
  }
}

/** 真实事件循环节拍(全链用例:源定位/产物登记含真实 fs I/O,微任务排空不足以推进) */
async function settleIOTicks(turns = 8): Promise<void> {
  for (let index = 0; index < turns; index += 1) {
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
}

function nth<T>(items: readonly T[], index: number): T {
  const item = items[index];
  if (item === undefined) {
    throw new Error(`第 ${index} 项不存在(共 ${items.length})`);
  }
  return item;
}

function migrationSql(name: string): string {
  const migrationPath = path.join(process.cwd(), 'src/database/migrations', name, 'up.sql');
  if (!fs.existsSync(migrationPath)) {
    throw new Error(`未找到迁移文件 ${migrationPath} —— 本测试须以 apps/server 为工作目录运行`);
  }
  return fs.readFileSync(migrationPath, 'utf8');
}

function applyAuthoritativeMigrations(): void {
  Database.db.exec('CREATE TABLE IF NOT EXISTS _migrations (name TEXT PRIMARY KEY NOT NULL, applied_at TEXT NOT NULL)');
  for (const name of ['0001_init', '0002_profile_policy', '0003_media_catalog', '0004_manual_epg_binding', '0005_playback', '0006_pc_experience']) {
    Database.db.transaction(() => {
      Database.db.exec(migrationSql(name));
      Database.db.prepare('INSERT INTO _migrations (name, applied_at) VALUES (?, ?)').run(name, new Date().toISOString());
    })();
  }
}

/* ------------------------------------------------------------------ */
/* 假 ffmpeg 进程夹具(stderr 桥接进 ledger,镜像生产 supervisorSpawnAdapter) */
/* ------------------------------------------------------------------ */

interface FakeConversionProcess {
  readonly handle: ConversionProcessHandle;
  readonly signals: string[];
  emitStderr(chunk: string): void;
  emitExit(code: number | null, signal: string | null): void;
}

function createFakeConversionProcess(pid: number): FakeConversionProcess {
  const signals: string[] = [];
  const listeners = new Map<string, Array<(...args: unknown[]) => void>>();
  let exited = false;
  const emit = (event: string, ...args: unknown[]): void => {
    for (const listener of listeners.get(event) ?? []) {
      listener(...args);
    }
  };
  const handle: ConversionProcessHandle = {
    pid,
    on(event, listener) {
      const list = listeners.get(event) ?? [];
      list.push(listener as (...args: unknown[]) => void);
      listeners.set(event, list);
      return handle;
    },
    kill(signal) {
      if (exited) {
        return false;
      }
      signals.push(signal);
      return true;
    },
  };
  return {
    handle,
    signals,
    emitStderr: (chunk) => emit('stderr', chunk),
    emitExit: (code, signal) => {
      exited = true;
      emit('exit', code, signal);
    },
  };
}

/** 假 spawn + stderr→ledger 转发(与生产 supervisorSpawnAdapter 相同的桥接面) */
function ledgerForwardingSpawn(
  ledger: PlaybackTaskDirectoryLedger,
  requests: ConversionSpawnRequest[],
  processes: FakeConversionProcess[],
): (request: ConversionSpawnRequest) => ConversionProcessHandle {
  return (request) => {
    requests.push(request);
    const fake = createFakeConversionProcess(4000 + processes.length);
    processes.push(fake);
    fake.handle.on('stderr', (chunk: string) => ledger.emitStderr(request.conversionId, chunk));
    return fake.handle;
  };
}

/** 与 playback.module 生命周期工厂同构的 storage 端口组合 */
function lifecycleStoragePort(
  storage: ConversionStorageService,
  assets: PlaybackAssetsService,
  ledger: PlaybackTaskDirectoryLedger,
): LifecycleStoragePort {
  return {
    releaseSession: async (householdId, sessionId) => {
      await storage.releaseSession(householdId, sessionId);
      assets.releaseSession(householdId, sessionId);
      ledger.releaseSession(householdId, sessionId);
    },
    releaseTask: (task) => storage.releaseTask(task),
    pendingCleanupTasks: () => storage.pendingCleanupTasks(),
  };
}

function sessionRowOf(sessionId: string): { state: string; delivery: string | null; failureCode: string | null; generation: number; version: number } {
  const row = Database.db
    .prepare('SELECT state, delivery, failure_code, generation, version FROM playback_session WHERE id = ?')
    .get(sessionId) as { state: string; delivery: string | null; failure_code: string | null; generation: number; version: number } | undefined;
  if (row === undefined) {
    throw new Error(`会话行应存在:${sessionId}`);
  }
  return { state: row.state, delivery: row.delivery, failureCode: row.failure_code, generation: row.generation, version: row.version };
}

/* ------------------------------------------------------------------ */
/* 桥接管线 rig(真实服务组合,装配与 playback.module 工厂同构)              */
/* ------------------------------------------------------------------ */

interface PipelineRig {
  readonly dataDir: string;
  readonly repo: PlaybackRepository;
  readonly budgets: PlaybackBudgets;
  readonly clock: ManualClock;
  readonly ledger: PlaybackTaskDirectoryLedger;
  readonly assets: PlaybackAssetsService;
  readonly storage: ConversionStorageService;
  readonly bridge: PlaybackConversionBridge;
  readonly requests: ConversionSpawnRequest[];
  readonly processes: FakeConversionProcess[];
  readonly householdId: string;
  readonly sessionId: string;
  readonly deviceId: string;
  readonly profileId: string;
  readonly mediaId: string;
  readonly deviceSessionId: string;
}

const pipelineRigs: PipelineRig[] = [];

function bootstrapPipelineRig(): PipelineRig {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hmp-t033-conversion-delivery-'));
  setEnvOverride(loadEnv({ NODE_ENV: 'test', DATA_DIR: dataDir, DB_FILENAME: `${randomUUID()}.hmp.db` }));
  Database.close();
  applyAuthoritativeMigrations();
  const budgets = createPlaybackBudgets(loadEnv({ NODE_ENV: 'test', PLAYBACK_CONVERSION_CONCURRENCY: '1' }));
  const repo = new PlaybackRepository(Database.db, budgets);
  const clock = createManualClock();
  const ledger = new PlaybackTaskDirectoryLedger();
  const assets = new PlaybackAssetsService({ budgets, entryPathPrefix: '/api/playback/stream' });
  const storage = new ConversionStorageService({
    budgets,
    rootDir: dataDir,
    clock,
    freeDiskBytes: () => Number.POSITIVE_INFINITY,
    // 目录删除注入 no-op:launch 失败路径的 releaseTask 保持在微任务域(不依赖真实 fs 宏任务),
    // 记账簿记语义(条目关闭/移除)与生产一致
    removeDirectory: async () => undefined,
  });
  const now = new Date().toISOString();
  const householdId = randomUUID();
  const accountId = randomUUID();
  const profileId = randomUUID();
  const deviceId = randomUUID();
  const deviceSessionId = randomUUID();
  const mediaId = randomUUID();
  Database.db.transaction(() => {
    Database.db.prepare('INSERT INTO household (id, name, created_at) VALUES (?, ?, ?)').run(householdId, 'T033 管线家庭', now);
    Database.db.prepare(
      'INSERT INTO account (id, household_id, username, username_normalized, password_hash, role, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    ).run(accountId, householdId, 't033', 't033', 'hash', 'owner', now);
    Database.db.prepare(
      'INSERT INTO profile (id, household_id, account_id, name, type, is_default, status, failed_pin_count, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
    ).run(profileId, householdId, accountId, 'T033 档案', 'adult', 0, 'active', 0, now);
    Database.db.prepare('INSERT INTO device (id, household_id, type, created_at) VALUES (?, ?, ?, ?)').run(deviceId, householdId, 'tv', now);
    Database.db.prepare(
      'INSERT INTO device_session (id, household_id, account_id, device_id, token_hash, expires_at, last_active_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    ).run(deviceSessionId, householdId, accountId, deviceId, `hash-${deviceSessionId}`, '2030-01-01T00:00:00.000Z', now, now);
    Database.db.prepare(
      'INSERT INTO media_item (id, household_id, type, title, version, title_overridden, type_overridden, created_at, updated_at) VALUES (?, ?, ?, ?, 1, 0, 0, ?, ?)',
    ).run(mediaId, householdId, 'movie', 'T033 测试影片', now, now);
  })();
  const sessionId = expectOk(
    repo.createSession({
      householdId,
      deviceSessionId,
      deviceId,
      profileId,
      mediaId,
    }),
  ).id;
  const requests: ConversionSpawnRequest[] = [];
  const processes: FakeConversionProcess[] = [];
  const supervisor = new ConversionSupervisorService({
    repository: repo,
    budgets,
    clock,
    spawn: ledgerForwardingSpawn(ledger, requests, processes),
    hardwareBackend: async () => null,
    resolveOutputDirectory: (request) => ledger.taskDirectoryOf(request),
  });
  const lifecycle = new PlaybackLifecycleService({
    repository: repo,
    authorization: { revalidate: async () => undefined },
    supervisor,
    budgets,
    privateRootDir: path.join(dataDir, 'playback'),
    storage: lifecycleStoragePort(storage, assets, ledger),
    clock,
  });
  const bridge = new PlaybackConversionBridge({
    supervisor,
    storage,
    lifecycle,
    ledger,
    assets,
    budgets,
    clock,
  });
  const rig: PipelineRig = {
    dataDir,
    repo,
    budgets,
    clock,
    ledger,
    assets,
    storage,
    bridge,
    requests,
    processes,
    householdId,
    sessionId,
    deviceId,
    profileId,
    mediaId,
    deviceSessionId,
  };
  pipelineRigs.push(rig);
  return rig;
}

function conversionRowOf(conversionId: string): { state: string; failureCode: string | null } {
  const row = Database.db
    .prepare('SELECT state, failure_code FROM playback_conversion WHERE id = ?')
    .get(conversionId) as { state: string; failure_code: string | null } | undefined;
  if (row === undefined) {
    throw new Error(`转换行应存在:${conversionId}`);
  }
  return { state: row.state, failureCode: row.failure_code };
}

/** 额度占用用伴生会话(复用 rig 真实身份行,满足 playback_session 外键) */
function createExtraSession(rig: PipelineRig): string {
  return expectOk(
    rig.repo.createSession({
      householdId: rig.householdId,
      deviceId: rig.deviceId,
      profileId: rig.profileId,
      mediaId: rig.mediaId,
      deviceSessionId: rig.deviceSessionId,
    }),
  ).id;
}

const VIDEO_TRANSCODE_PLAN = {
  delivery: 'video_transcode' as const,
  mode: 'video_transcode' as const,
  outputVideoCodec: 'h264',
  outputAudioCodec: 'aac',
  reason: '单测:视频转码计划',
};

/* ------------------------------------------------------------------ */
/* 桥接管线组:launchAndWaitFirstOutput(缺口1 启动阶段)                   */
/* ------------------------------------------------------------------ */

describe('T033 缺口1:桥接管线(reserve→spawn→首产物→ok/BUSY/超时)', () => {
  it('plan=video_transcode → reserve 建行 → spawn 调用(argv 带 -i 与任务目录 window.m3u8)→ 首产物事实 → ok', async () => {
    const rig = bootstrapPipelineRig();
    const pending = rig.bridge.launchAndWaitFirstOutput({
      householdId: rig.householdId,
      sessionId: rig.sessionId,
      generation: 1,
      plan: VIDEO_TRANSCODE_PLAN,
      phase: 'prepare',
      deadlineAtMs: rig.clock.now() + rig.budgets.watchdog.prepareTimeoutSeconds * 1000,
      inputPath: '/abs/media/source.mp4',
    });
    await flushMicrotasks();

    // reserve:playback_conversion 行已建(额度占用 1);spawn:恰好一次且形态正确
    expect(rig.repo.countActiveConversions()).toBe(1);
    expect(rig.requests).toHaveLength(1);
    const request = nth(rig.requests, 0);
    for (const arg of request.argv) {
      expect(typeof arg).toBe('string');
    }
    const argvString = request.argv.join('\u0000');
    expect(argvString).toContain('\u0000-i\u0000');
    expect(argvString).toContain('/abs/media/source.mp4');
    const expectedPlaylist = path.join(rig.dataDir, 'playback', rig.householdId, rig.sessionId, '1', 'window.m3u8');
    expect(argvString).toContain(expectedPlaylist);

    // 首产物事实(stderr time= 桥接)→ 启动观察收口 ok;期限通道已被首输出解除
    nth(rig.processes, 0).emitStderr('frame=1 fps=24 time=00:00:00.04 bitrate=8000.0kbits/s');
    await flushMicrotasks();
    const started = expectOk(await pending);
    expect(conversionRowOf(started.conversionId).state).toBe('running');
    await rig.clock.advance(1_000);
    expect(nth(rig.processes, 0).signals).toEqual([]);
  });

  it('额度满(他会话占用全局并发)→ prepare 相位立即 PLAYBACK_CONVERSION_BUSY,不排队不 spawn,本会话无任务行', async () => {
    const rig = bootstrapPipelineRig();
    // 另一会话占满并发=1 的全局额度
    const otherSessionId = createExtraSession(rig);
    expectOk(
      rig.repo.reserveConversion({
        householdId: rig.householdId,
        sessionId: otherSessionId,
        generation: 1,
        mode: 'remux',
        outputVideoCodec: 'copy',
        outputAudioCodec: 'copy',
      }),
    );

    const result = await rig.bridge.launchAndWaitFirstOutput({
      householdId: rig.householdId,
      sessionId: rig.sessionId,
      generation: 1,
      plan: VIDEO_TRANSCODE_PLAN,
      phase: 'prepare',
      deadlineAtMs: rig.clock.now() + rig.budgets.watchdog.prepareTimeoutSeconds * 1000,
      inputPath: '/abs/media/source.mp4',
    });

    expectErr(result, 'PLAYBACK_CONVERSION_BUSY');
    expect(rig.requests).toHaveLength(0);
    const own = Database.db
      .prepare('SELECT count(*) AS n FROM playback_conversion WHERE session_id = ?')
      .get(rig.sessionId) as { n: number };
    expect(own.n).toBe(0);
    expect(rig.repo.countActiveConversions()).toBe(1);
  });

  it('首帧 30 秒期限无输出 → 看门狗裁决 PLAYBACK_PREPARE_TIMEOUT → err+会话 failed 同码,额度确认退出后释放', async () => {
    const rig = bootstrapPipelineRig();
    const pending = rig.bridge.launchAndWaitFirstOutput({
      householdId: rig.householdId,
      sessionId: rig.sessionId,
      generation: 1,
      plan: VIDEO_TRANSCODE_PLAN,
      phase: 'prepare',
      deadlineAtMs: rig.clock.now() + rig.budgets.watchdog.prepareTimeoutSeconds * 1000,
      inputPath: '/abs/media/source.mp4',
    });
    await flushMicrotasks();

    // 不产出任何输出:推进到首帧期限 → 看门狗裁决 → 失败通道收口;会话经 lifecycle 落稳定码
    await rig.clock.advance(rig.budgets.watchdog.prepareTimeoutSeconds * 1000);
    expectErr(await pending, 'PLAYBACK_PREPARE_TIMEOUT');
    expect(sessionRowOf(rig.sessionId)).toMatchObject({ state: 'failed', failureCode: 'PLAYBACK_PREPARE_TIMEOUT' });

    // SIGTERM 5 秒宽限 → SIGKILL:监督者内部期限、看门狗 onTerminate 的 cancel 与
    // lifecycle 会话级回收(cancelSessionConversions)各发一轮终止(重复 cancel 重新
    // 武装宽限,仅最后一个宽限 token 落 SIGKILL —— 装配既有语义),确认退出后额度释放
    await rig.clock.advance(rig.budgets.watchdog.sigtermGraceSeconds * 1000);
    expect(nth(rig.processes, 0).signals).toEqual(['SIGTERM', 'SIGTERM', 'SIGTERM', 'SIGKILL']);
    nth(rig.processes, 0).emitExit(null, 'SIGKILL');
    await flushMicrotasks();
    expect(rig.repo.countActiveConversions()).toBe(0);
  });

  it('seek 相位遇旧代占额 → 有界重试(共用原 15 秒期限)→ 旧代确认退出后 reserve 成功 → 首产物 → ok', async () => {
    const rig = bootstrapPipelineRig();
    // 模拟旧代转换行仍处活动(取消已发出、退出确认未落库的窗口)
    const staleSessionId = createExtraSession(rig);
    const stale = expectOk(
      rig.repo.reserveConversion({
        householdId: rig.householdId,
        sessionId: staleSessionId,
        generation: 1,
        mode: 'remux',
        outputVideoCodec: 'copy',
        outputAudioCodec: 'copy',
      }),
    );

    const pending = rig.bridge.launchAndWaitFirstOutput({
      householdId: rig.householdId,
      sessionId: rig.sessionId,
      generation: 2,
      plan: VIDEO_TRANSCODE_PLAN,
      phase: 'seek',
      deadlineAtMs: rig.clock.now() + rig.budgets.watchdog.seekTimeoutSeconds * 1000,
      inputPath: '/abs/media/source.mp4',
    });
    // 宽排空:supervisor 启动观察为自定义 thenable(await 链消耗多个微任务轮),需足够
    // 轮次让首轮 BUSY 的有界重试 delay 完成登记(否则 ManualClock 无可推进定时器)
    await flushMicrotasks(32);
    expect(rig.requests).toHaveLength(0);

    // 旧代仍活动:重试一次仍 BUSY(无 spawn)
    await rig.clock.advance(200);
    await settleIOTicks(4);
    expect(rig.requests).toHaveLength(0);
    // 旧代确认退出(额度释放;未启动行按补偿释放路径回收,预留→终态无 stopping 直达迁移)
    expectOk(rig.repo.compensateRelease(rig.householdId, stale.id));
    await rig.clock.advance(200);
    await settleIOTicks(8);
    expect(rig.requests).toHaveLength(1);

    nth(rig.processes, 0).emitStderr('frame=1 time=00:00:00.04');
    await settleIOTicks(8);
    const started = expectOk(await pending);
    expect(started.conversionId.length).toBeGreaterThan(0);
    // seek 期限内的成功不触发超时裁决(无输出判罚期限 15 秒,推进 14 秒仍安全)
    await rig.clock.advance(rig.budgets.watchdog.seekTimeoutSeconds * 1000 - 1_000);
    expect(nth(rig.processes, 0).signals).toEqual([]);
  });
});

/* ------------------------------------------------------------------ */
/* resolver 组:脚本化 probe + 录制式启动端口(缺口1 领域侧)               */
/* ------------------------------------------------------------------ */

const MOVIE_FACTS: PlaybackProbeFacts = {
  durationSeconds: 5400,
  audioTracks: [
    { id: 'aud-1', label: '', language: 'zh', default: true },
    { id: 'aud-2', label: '', language: 'en', default: false },
  ],
  subtitleTracks: [{ id: 'sub-1', label: '', language: 'zh' }],
};

class ScriptedProbePort implements PlaybackProbePort {
  constructor(private readonly script: () => PlaybackProbeOutcome) {}

  async probeFirstAvailable(): Promise<PlaybackProbeOutcome> {
    return this.script();
  }
}

class RecordingLaunchPort implements PlaybackConversionLaunchPort {
  readonly requests: PlaybackConversionLaunchRequest[] = [];

  constructor(private readonly reply: (request: PlaybackConversionLaunchRequest, index: number) => PlaybackResult<{ readonly conversionId: string }>) {}

  async startAndWaitFirstOutput(request: PlaybackConversionLaunchRequest): Promise<PlaybackResult<{ readonly conversionId: string }>> {
    this.requests.push(request);
    return this.reply(request, this.requests.length - 1);
  }
}

interface ResolverRig {
  readonly dataDir: string;
  readonly world: PlaybackWorld;
  readonly repo: PlaybackRepository;
  readonly budgets: PlaybackBudgets;
  readonly context: SessionContext;
}

const resolverRigs: ResolverRig[] = [];

async function bootstrapResolverRig(): Promise<ResolverRig> {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hmp-t033-resolver-'));
  setEnvOverride(loadEnv({ NODE_ENV: 'test', DATA_DIR: dataDir, DB_FILENAME: `${randomUUID()}.hmp.db` }));
  Database.close();
  applyAuthoritativeMigrations();
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
  const budgets = createPlaybackBudgets(loadEnv({ NODE_ENV: 'test' }));
  const repo = new PlaybackRepository(Database.db, budgets);
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
  const rig: ResolverRig = { dataDir, world, repo, budgets, context };
  resolverRigs.push(rig);
  return rig;
}

describe('T033 缺口1:resolver 转码准备(plan=transcode → 启动端口 → ready/failed)', () => {
  it('probe=video_transcode → 启动端口按 prepare 相位调用(plan 形态/30s 期限)→ ok → markReady(delivery=plan 模式)+ 同代事实', async () => {
    const rig = await bootstrapResolverRig();
    const launch = new RecordingLaunchPort(() => ({ ok: true, value: { conversionId: 'conv-1' } }));
    const world = rig.world;
    const resolver = new PlaybackResolverService(rig.repo, new PlaybackAuthorizationService(rig.repo), new ScriptedProbePort(() => ({
      playbackSourceId: world.nas.playbackSourceId,
      delivery: 'video_transcode',
      facts: MOVIE_FACTS,
    })), rig.budgets, { conversionLaunch: launch });

    const outcome = await resolver.resolve(rig.context, world.nas.mediaId);
    expect(outcome.dto.state).toBe('preparing');
    expect(outcome.dto.delivery).toBeNull();
    await flushMicrotasks();

    expect(launch.requests).toHaveLength(1);
    const request = nth(launch.requests, 0);
    expect(request).toMatchObject({
      householdId: world.householdId,
      sessionId: outcome.session.id,
      generation: 1,
      delivery: 'video_transcode',
      playbackSourceId: world.nas.playbackSourceId,
      phase: 'prepare',
      deadlineMs: rig.budgets.watchdog.prepareTimeoutSeconds * 1000,
    });
    expect(request.plan).toEqual(conversionPlanForDelivery('video_transcode', true));

    const reloaded = expectOk(rig.repo.getSession(world.householdId, outcome.session.id));
    expect(reloaded.state).toBe('ready');
    expect(reloaded.delivery).toBe('video_transcode');
    expect(resolver.factsFor(outcome.session.id, 1)).toEqual(MOVIE_FACTS);
  });

  it('启动端口 BUSY → preparing→failed + PLAYBACK_CONVERSION_BUSY(ready 前无票语义保持)', async () => {
    const rig = await bootstrapResolverRig();
    const world = rig.world;
    const launch = new RecordingLaunchPort(() => ({ ok: false, code: 'PLAYBACK_CONVERSION_BUSY' }));
    const resolver = new PlaybackResolverService(rig.repo, new PlaybackAuthorizationService(rig.repo), new ScriptedProbePort(() => ({
      playbackSourceId: world.nas.playbackSourceId,
      delivery: 'audio_transcode',
      facts: MOVIE_FACTS,
    })), rig.budgets, { conversionLaunch: launch });

    const outcome = await resolver.resolve(rig.context, world.nas.mediaId);
    await flushMicrotasks();

    expect(launch.requests).toHaveLength(1);
    expect(sessionRowOf(outcome.session.id)).toMatchObject({ state: 'failed', failureCode: 'PLAYBACK_CONVERSION_BUSY' });
    // 失败会话的 DTO 携带稳定码,绝不呈现 ready
    const dto = resolver.toDto(expectOk(rig.repo.getSession(world.householdId, outcome.session.id)));
    expect(dto.state).toBe('failed');
    expect(dto.failureCode).toBe('PLAYBACK_CONVERSION_BUSY');
  });

  it('启动端口超时码(PREPARE_TIMEOUT)稳定透传落会话', async () => {
    const rig = await bootstrapResolverRig();
    const world = rig.world;
    const launch = new RecordingLaunchPort(() => ({ ok: false, code: 'PLAYBACK_PREPARE_TIMEOUT' }));
    const resolver = new PlaybackResolverService(rig.repo, new PlaybackAuthorizationService(rig.repo), new ScriptedProbePort(() => ({
      playbackSourceId: world.nas.playbackSourceId,
      delivery: 'remux',
      facts: MOVIE_FACTS,
    })), rig.budgets, { conversionLaunch: launch });

    const outcome = await resolver.resolve(rig.context, world.nas.mediaId);
    await flushMicrotasks();
    expect(sessionRowOf(outcome.session.id)).toMatchObject({ state: 'failed', failureCode: 'PLAYBACK_PREPARE_TIMEOUT' });
  });

  it('启动端口缺位(旧装配形态)→ fail-closed RESOURCE_UNAVAILABLE,绝不「假 ready 后网关 503」', async () => {
    const rig = await bootstrapResolverRig();
    const world = rig.world;
    // 四参构造(无 ports):旧装配/纯单测形态 —— 行为修正点:T033 前该形态直接
    // markReady(delivery=转码)而从不建转换任务,流网关随后稳定 503
    const resolver = new PlaybackResolverService(rig.repo, new PlaybackAuthorizationService(rig.repo), new ScriptedProbePort(() => ({
      playbackSourceId: world.nas.playbackSourceId,
      delivery: 'video_transcode',
      facts: MOVIE_FACTS,
    })), rig.budgets);

    const outcome = await resolver.resolve(rig.context, world.nas.mediaId);
    await flushMicrotasks();
    const row = sessionRowOf(outcome.session.id);
    expect(row.state).toBe('failed');
    expect(row.failureCode).toBe('PLAYBACK_RESOURCE_UNAVAILABLE');
    expect(row.delivery).toBeNull();
  });
});

/* ------------------------------------------------------------------ */
/* 换代组:seek/selectTracks → prepareRebuild(缺口2)                      */
/* ------------------------------------------------------------------ */

class StaticFactsPort implements PlaybackTrackFactsPort {
  private readonly byKey = new Map<string, PlaybackProbeFacts>();

  seed(sessionId: string, generation: number, facts: PlaybackProbeFacts): void {
    this.byKey.set(`${sessionId}|${generation}`, facts);
  }

  factsFor(sessionId: string, generation: number): PlaybackProbeFacts | undefined {
    return this.byKey.get(`${sessionId}|${generation}`);
  }
}

interface RebuildRig {
  readonly world: PlaybackWorld;
  readonly repo: PlaybackRepository;
  readonly budgets: PlaybackBudgets;
  readonly context: SessionContext;
  readonly facts: StaticFactsPort;
  readonly launch: RecordingLaunchPort;
  readonly selection: PlaybackSelectionService;
  readonly resolver: PlaybackResolverService;
}

async function bootstrapRebuildRig(delivery: 'video_transcode' | 'audio_transcode' | 'direct'): Promise<RebuildRig> {
  const base = await bootstrapResolverRig();
  const facts = new StaticFactsPort();
  const launch = new RecordingLaunchPort(() => ({ ok: true, value: { conversionId: `conv-${randomUUID()}` } }));
  const sessionSource: PlaybackSessionSourcePort = {
    async locateSessionSource(sessionId: string) {
      void sessionId;
      return { playbackSourceId: base.world.nas.playbackSourceId, location: 'nasroot/movie.mp4' };
    },
  };
  const authorization = new PlaybackAuthorizationService(base.repo);
  const resolver = new PlaybackResolverService(base.repo, authorization, new ScriptedProbePort(() => ({
    playbackSourceId: base.world.nas.playbackSourceId,
    delivery,
    facts: MOVIE_FACTS,
  })), base.budgets, {
    conversionLaunch: launch,
    sessionSource,
  });
  const selection = new PlaybackSelectionService({
    repository: base.repo,
    authorization,
    facts,
    rebuildCoordinator: {
      cancelSupersededGeneration: () => undefined,
    },
    reprepare: resolver,
    budgets: base.budgets,
  });
  return { ...base, facts, launch, selection, resolver };
}

describe('T033 缺口2:seek/换轨 → 自动重回 ready(fake 管线)', () => {
  it('转码会话 seek 换代 → prepareRebuild 经「启动转换→ready」管线(seek 15s 预算,phase=seek)→ 新代 ready', async () => {
    const rig = await bootstrapRebuildRig('video_transcode');
    // 首代准备:resolve → 转码管线 fake ok → ready(generation=1)
    const outcome = await rig.resolver.resolve(rig.context, rig.world.nas.mediaId);
    await flushMicrotasks();
    expect(outcome.session.generation).toBe(1);
    expect(sessionRowOf(outcome.session.id).state).toBe('ready');
    rig.facts.seed(outcome.session.id, 1, MOVIE_FACTS);
    expect(rig.launch.requests).toHaveLength(1);

    // seek:换代提交 → reprepare(resolver.prepareRebuild)自动触发(fire-and-forget,响应先行)
    const sought = await rig.selection.seek(outcome.session.id, { expectedVersion: outcome.session.version, positionSeconds: 600 }, rig.context);
    expect(sought.session.generation).toBe(2);
    expect(sought.session.state).toBe('preparing');
    await flushMicrotasks();

    // 新代转换启动:seek 相位、15 秒预算、同源
    expect(rig.launch.requests).toHaveLength(2);
    const rebuild = nth(rig.launch.requests, 1);
    expect(rebuild).toMatchObject({
      sessionId: outcome.session.id,
      generation: 2,
      delivery: 'video_transcode',
      phase: 'seek',
      deadlineMs: rig.budgets.watchdog.seekTimeoutSeconds * 1000,
      playbackSourceId: rig.world.nas.playbackSourceId,
    });
    // 事实代际迁移:缓存由 gen1 迁入 gen2(toDto 的时长/轨道不因换代回落空)
    expect(rig.resolver.factsFor(outcome.session.id, 2)).toEqual(MOVIE_FACTS);
    expect(sessionRowOf(outcome.session.id)).toMatchObject({ state: 'ready', generation: 2, delivery: 'video_transcode' });
  });

  it('direct 会话 seek 换代 → 不经启动端口,直接 markReady(delivery 不变)重回 ready', async () => {
    const rig = await bootstrapRebuildRig('direct');
    const outcome = await rig.resolver.resolve(rig.context, rig.world.nas.mediaId);
    await flushMicrotasks();
    expect(rig.launch.requests).toHaveLength(0); // direct 不建转换任务
    expect(sessionRowOf(outcome.session.id)).toMatchObject({ state: 'ready', delivery: 'direct' });
    rig.facts.seed(outcome.session.id, 1, MOVIE_FACTS);

    const sought = await rig.selection.seek(outcome.session.id, { expectedVersion: outcome.session.version, positionSeconds: 30 }, rig.context);
    expect(sought.session.generation).toBe(2);
    await flushMicrotasks();
    expect(rig.launch.requests).toHaveLength(0);
    expect(sessionRowOf(outcome.session.id)).toMatchObject({ state: 'ready', generation: 2, delivery: 'direct' });
  });

  it('音轨换代(selectTracks)走同一重回准备管线;纯字幕切换不触发', async () => {
    const rig = await bootstrapRebuildRig('audio_transcode');
    const outcome = await rig.resolver.resolve(rig.context, rig.world.nas.mediaId);
    await flushMicrotasks();
    rig.facts.seed(outcome.session.id, 1, MOVIE_FACTS);
    expect(rig.launch.requests).toHaveLength(1);

    // 纯字幕切换:version 通道,不换代、不触发重回准备
    await rig.selection.selectTracks(
      outcome.session.id,
      { expectedVersion: outcome.session.version, subtitleTrackId: 'sub-1' },
      rig.context,
    );
    await flushMicrotasks();
    expect(rig.launch.requests).toHaveLength(1);

    // 音轨变化:换代通道 → prepareRebuild(phase=seek)
    const switched = await rig.selection.selectTracks(
      outcome.session.id,
      { expectedVersion: outcome.session.version + 1, audioTrackId: 'aud-2' },
      rig.context,
    );
    expect(switched.session.generation).toBe(2);
    await flushMicrotasks();
    expect(rig.launch.requests).toHaveLength(2);
    expect(nth(rig.launch.requests, 1)).toMatchObject({ generation: 2, phase: 'seek', delivery: 'audio_transcode' });
    expect(sessionRowOf(outcome.session.id)).toMatchObject({ state: 'ready', generation: 2, delivery: 'audio_transcode' });
  });
});

/* ------------------------------------------------------------------ */
/* 全链组:resolve→prepare→launch→ready(真实装配镜像;fake spawn/时钟)     */
/* ------------------------------------------------------------------ */

describe('T033 全链:源定位→真实 bridge 启动→首产物→ready→产物窗口登记', () => {
  it('resolve(probe=video_transcode)→ 源 absPath 解析 → bridge 启动 → 首产物前 preparing → 首产物 → ready + 本地产物窗口', async () => {
    const base = await bootstrapResolverRig();
    // NAS location 改写为授权根内相对形态 + 真实根/文件(resolveNasMediaLocation 校验面)
    const nasRoot = path.join(base.dataDir, 'nasroot');
    fs.mkdirSync(nasRoot, { recursive: true });
    fs.writeFileSync(path.join(nasRoot, 'movie.mp4'), 'path-valid-fixture');
    getDb()
      .update(playbackSource)
      .set({ location: 'nasroot/movie.mp4' })
      .where(eq(playbackSource.id, base.world.nas.playbackSourceId))
      .run();

    const budgets = base.budgets;
    const repo = base.repo;
    const clock = createManualClock();
    const ledger = new PlaybackTaskDirectoryLedger();
    const assets = new PlaybackAssetsService({ budgets, entryPathPrefix: '/api/playback/stream' });
    const storage = new ConversionStorageService({ budgets, rootDir: base.dataDir, clock, freeDiskBytes: () => Number.POSITIVE_INFINITY, removeDirectory: async () => undefined });
    const requests: ConversionSpawnRequest[] = [];
    const processes: FakeConversionProcess[] = [];
    const supervisor = new ConversionSupervisorService({
      repository: repo,
      budgets,
      clock,
      spawn: ledgerForwardingSpawn(ledger, requests, processes),
      hardwareBackend: async () => null,
      resolveOutputDirectory: (request) => ledger.taskDirectoryOf(request),
    });
    const lifecycle = new PlaybackLifecycleService({
      repository: repo,
      authorization: { revalidate: async () => undefined },
      supervisor,
      budgets,
      storage: lifecycleStoragePort(storage, assets, ledger),
      clock,
    });
    const bridge = new PlaybackConversionBridge({ supervisor, storage, lifecycle, ledger, assets, budgets, clock });
    const locator = new PlaybackSourceLocationReader(Database.db);
    const mediaRoots: Record<string, string> = { nasroot: nasRoot };
    // ResolverConversionLaunchPort 的装配镜像(模块私有类;源定位→bridge→产物窗口登记)
    const launchPort: PlaybackConversionLaunchPort = {
      async startAndWaitFirstOutput(request) {
        const located = await locator.locate(request.playbackSourceId);
        if (located === null) {
          return { ok: false, code: 'PLAYBACK_RESOURCE_UNAVAILABLE' };
        }
        const resolved = await resolveNasMediaLocation(located.location, mediaRoots);
        if (!resolved.ok) {
          return { ok: false, code: 'PLAYBACK_RESOURCE_UNAVAILABLE' };
        }
        const started = await bridge.launchAndWaitFirstOutput({
          householdId: request.householdId,
          sessionId: request.sessionId,
          generation: request.generation,
          plan: {
            delivery: request.delivery,
            mode: request.plan.mode,
            outputVideoCodec: request.plan.outputVideoCodec,
            outputAudioCodec: request.plan.outputAudioCodec,
            reason: request.plan.reason,
          },
          phase: request.phase,
          deadlineAtMs: clock.now() + request.deadlineMs,
          inputPath: resolved.absPath,
        });
        if (!started.ok) {
          return started;
        }
        const directory = ledger.taskDirectoryOf({
          householdId: request.householdId,
          sessionId: request.sessionId,
          generation: request.generation,
        });
        if (directory !== undefined) {
          assets.registerLocalWindow(request.householdId, request.sessionId, request.generation, directory);
        }
        return started;
      },
    };
    const resolver = new PlaybackResolverService(
      repo,
      new PlaybackAuthorizationService(repo),
      new ScriptedProbePort(() => ({
        playbackSourceId: base.world.nas.playbackSourceId,
        delivery: 'video_transcode',
        facts: MOVIE_FACTS,
      })),
      budgets,
      { conversionLaunch: launchPort },
    );

    const outcome = await resolver.resolve(base.context, base.world.nas.mediaId);
    await settleIOTicks(16);
    // argv 携带授权根内 absPath 与任务目录产物清单;首产物前保持 preparing(ready 前无票)
    expect(requests).toHaveLength(1);
    const argvString = nth(requests, 0).argv.join('\u0000');
    expect(argvString).toContain(path.join(nasRoot, 'movie.mp4'));
    expect(sessionRowOf(outcome.session.id)).toMatchObject({ state: 'preparing', delivery: null });

    // 首产物事实(stderr time= 桥接)→ 管线收口 → markReady + 产物目录登记
    nth(processes, 0).emitStderr('frame=1 time=00:00:00.04');
    await settleIOTicks(16);
    expect(sessionRowOf(outcome.session.id)).toMatchObject({ state: 'ready', delivery: 'video_transcode' });
    const directory = assets.localWindowOf(base.world.householdId, outcome.session.id, 1);
    expect(directory).toBeDefined();
    expect(directory).toContain(path.join('playback', base.world.householdId, outcome.session.id, '1'));
    // 产物清单同源重写:相对分片名 → 带票同源 URI(网关 fs 直读交付的文本面)
    const manifest = ['#EXTM3U', '#EXTINF:4.000000,', 'seg00000.ts'].join('\n');
    expect(assets.rewriteLocalManifest(base.world.householdId, outcome.session.id, 1, manifest, 'tk').split('\n')[2]).toBe(
      `/api/playback/stream/${outcome.session.id}/1/seg00000.ts?ticket=tk`,
    );
  });
});

/* ------------------------------------------------------------------ */
/* 资产纯函数组:本地产物窗口(缺口1 第 2 步的词法防线)                     */
/* ------------------------------------------------------------------ */

describe('T033 资产:registerLocalWindow / resolveLocalAsset / rewriteLocalManifest', () => {
  it('登记 → 五元组定位目录内文件;词法白名单外的 assetId 一律拒绝(穿越/分隔符/扩展名)', () => {
    const budgets = createPlaybackBudgets(loadEnv({ NODE_ENV: 'test' }));
    const assets = new PlaybackAssetsService({ budgets, entryPathPrefix: '/api/playback/stream' });
    assets.registerLocalWindow('h1', 's1', 3, '/private/task-dir');
    expect(assets.localWindowOf('h1', 's1', 3)).toBe('/private/task-dir');

    expect(assets.resolveLocalAsset('h1', 's1', 3, 'seg00001.ts')).toEqual({
      path: path.join('/private/task-dir', 'seg00001.ts'),
      kind: 'segment',
    });
    // 入口资产名 'index'(票据 playbackUrl 同构)映射为产物清单 window.m3u8
    expect(assets.resolveLocalAsset('h1', 's1', 3, 'index')).toEqual({
      path: path.join('/private/task-dir', 'window.m3u8'),
      kind: 'manifest',
    });
    expect(assets.resolveLocalAsset('h1', 's1', 3, 'window.m3u8')?.kind).toBe('manifest');
    expect(assets.resolveLocalAsset('h1', 's1', 3, 'track.vtt')?.kind).toBe('subtitle');

    // 穿越与词法防线:'..' / 路径分隔符 / 非白名单扩展名 / 未登记键域一律 undefined
    expect(assets.resolveLocalAsset('h1', 's1', 3, '..')).toBeUndefined();
    expect(assets.resolveLocalAsset('h1', 's1', 3, 'sub/seg.ts')).toBeUndefined();
    expect(assets.resolveLocalAsset('h1', 's1', 3, 'evil.sh')).toBeUndefined();
    expect(assets.resolveLocalAsset('h1', 's1', 4, 'seg00001.ts')).toBeUndefined();
    expect(assets.localWindowOf('h1', 's1', 4)).toBeUndefined();

    // 生命周期:releaseGeneration / releaseSession 丢弃本地产物窗口(TTL 不超 session)
    assets.releaseGeneration('h1', 's1', 3);
    expect(assets.localWindowOf('h1', 's1', 3)).toBeUndefined();
    assets.registerLocalWindow('h1', 's1', 1, '/private/other');
    assets.releaseSession('h1', 's1');
    expect(assets.localWindowOf('h1', 's1', 1)).toBeUndefined();
  });

  it('rewriteLocalManifest:相对分片名 → 带票同源 URI;标签行原样;非白名单行剔除', () => {
    const budgets = createPlaybackBudgets(loadEnv({ NODE_ENV: 'test' }));
    const assets = new PlaybackAssetsService({ budgets, entryPathPrefix: '/api/playback/stream' });
    const manifest = [
      '#EXTM3U',
      '#EXT-X-VERSION:3',
      '#EXT-X-TARGETDURATION:4',
      '#EXT-X-MEDIA-SEQUENCE:0',
      '#EXTINF:4.000000,',
      'seg00000.ts',
      '#EXTINF:4.000000,',
      'seg00001.ts',
    ].join('\n');
    const rewritten = assets.rewriteLocalManifest('h1', 's1', 7, manifest, 'ticket-token');
    expect(rewritten.split('\n')).toEqual([
      '#EXTM3U',
      '#EXT-X-VERSION:3',
      '#EXT-X-TARGETDURATION:4',
      '#EXT-X-MEDIA-SEQUENCE:0',
      '#EXTINF:4.000000,',
      '/api/playback/stream/s1/7/seg00000.ts?ticket=ticket-token',
      '#EXTINF:4.000000,',
      '/api/playback/stream/s1/7/seg00001.ts?ticket=ticket-token',
    ]);
    // 非白名单词法行(绝对路径/URL 形态)防御性剔除,不透传
    const hostile = ['#EXTM3U', '/etc/passwd', 'http://evil.example/a.ts'].join('\n');
    expect(assets.rewriteLocalManifest('h1', 's1', 7, hostile, 't')).toBe('#EXTM3U');
  });

  it('isConversionDelivery/conversionPlanForDelivery:计划面与 T024 输出值语义一致(静音合法视频 none)', () => {
    expect(isConversionDelivery('direct')).toBe(false);
    expect(isConversionDelivery('hls_proxy')).toBe(false);
    expect(isConversionDelivery('remux')).toBe(true);
    expect(conversionPlanForDelivery('remux', true)).toEqual({
      mode: 'remux',
      outputVideoCodec: 'copy',
      outputAudioCodec: 'copy',
      reason: '编码全兼容且容器不兼容,转封装保留原始音视频编码',
    });
    expect(conversionPlanForDelivery('remux', false).outputAudioCodec).toBe('none');
    expect(conversionPlanForDelivery('audio_transcode', true)).toMatchObject({ mode: 'audio_transcode', outputVideoCodec: 'copy', outputAudioCodec: 'aac' });
    expect(conversionPlanForDelivery('video_transcode', false)).toMatchObject({ mode: 'video_transcode', outputVideoCodec: 'h264', outputAudioCodec: 'none' });
  });
});

/* ------------------------------------------------------------------ */
/* rig 清理                                                               */
/* ------------------------------------------------------------------ */

afterEach(async () => {
  while (pipelineRigs.length > 0) {
    const rig = pipelineRigs.pop();
    if (rig === undefined) {
      break;
    }
    Database.close();
    fs.rmSync(rig.dataDir, { recursive: true, force: true });
  }
  while (resolverRigs.length > 0) {
    const rig = resolverRigs.pop();
    if (rig === undefined) {
      break;
    }
    Database.close();
    fs.rmSync(rig.dataDir, { recursive: true, force: true });
  }
});
