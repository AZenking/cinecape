import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { createManualClock, MANUAL_CLOCK_DEFAULT_START_MS, type ManualClock } from '../../fixtures/clock';
import { Database } from '@platform/database/database';
import { setEnvOverride } from '@platform/config/env';
import { loadEnv } from '@platform/config/env.schema';
import { createPlaybackBudgets, type PlaybackBudgets } from '@platform/config/playback-budgets';
import { PlaybackRepository } from '../../../src/contexts/playback/infrastructure/playback.repository';
import { ConversionStorageService } from '../../../src/contexts/playback/infrastructure/conversion-storage.service';
import type { PlaybackErrorCode, PlaybackOk, PlaybackResult } from '../../../src/contexts/playback/domain/playback.types';
import { PlaybackLifecycleService } from '../../../src/contexts/playback/infrastructure/playback-lifecycle.service';

/**
 * 播放生命周期单元测试(T028,spec 004,US1)—— 心跳/失联/权限复核/终止/启动恢复/退出清理:
 *
 * 权威依据(先读后写):
 * - tasks.md T028:15 秒心跳、45 秒失联、每 15 秒后台权限复核、stop/cancel/失败/失权终止
 *   及退出后 60 秒清理;启动先标 interrupted/扫私有根再接转换,不按旧 PID 杀进程;
 *   关闭 hook 处理子进程并保留目录可用。
 * - research.md R5:前端每 15 秒 heartbeat(暂停也发,paused 心跳≠失联);45 秒无心跳判失联;
 *   stop/cancel/失败/权限失效立即终止任务,SIGTERM 后 5 秒 SIGKILL(监督者职责);终止后
 *   60 秒内清理目录,失败每 60 秒重试并保持 cleanup_state=pending、磁盘占用仍计预算;
 *   启动时将活动 session/job 标 interrupted 并扫本实例私有根,不使用旧 PID 杀无关进程;
 *   清理完成才接受新转换;后台每 15 秒复核活动任务的授权。
 * - data-model.md「## playback_session」:任一活动态→ended/failed/interrupted,终态不可复活;
 *   ended_at 在 ended/failed/interrupted 必填,失败码仅 failed 非空。「## playback_conversion」:
 *   任务 PID 仅进程内持有,不作为重启后杀进程依据;重启先标 interrupted;cleanup_state
 *   仅 pending/complete,删除失败仍为 pending。
 * - budgets.lifecycle:heartbeatIntervalSeconds 15 / heartbeatLostSeconds 45 /
 *   authRecheckSeconds 15 / cleanupDelaySeconds 60 / cleanupRetrySeconds 60(数值权威为
 *   T010 config.spec,本文件断言全部读预算常量,不写魔数)。
 *
 * 夹具分层(对齐 conversion.spec):
 * - 注入时钟 test/fixtures/clock ManualClock(结构与各服务 StorageClock/SupervisorClock 一致);
 * - 真实临时库(全部权威迁移 DDL 0001~0005)+ 真实 PlaybackRepository(T011 API 面不动);
 * - 真实 ConversionStorageService(注入 ManualClock + 可编程 removeDirectory)—— 清理重试
 *   pending 语义断言走 storage 真实现(R5:失败保持 pending 计预算,每 60 秒重试);
 * - fake supervisor(仅记录 cancel 调用)/ fake authorization revalidate(可编程拒绝)。
 *
 * 终态选择依据(失联/失权 → interrupted,停止 → ended,失败 → failed):
 * - 失联:R5「45秒无心跳判失联」属系统回收;repository.markInterrupted 注释明确
 *   「活动态→interrupted(失联/重启恢复)」;非用户优雅结束(ended)、非媒体失败(failed)。
 * - 权限失效:R5「权限失效立即终止任务」「心跳和媒体请求均可触发权限失效回收」——同为
 *   系统回收;且稳定码词表(PLAYBACK_*)无授权失败码,failSession 需稳定码,不适用。
 * - data-model:interrupted 终态 ended_at 必填、failure_code 保持空。
 */

/* ------------------------------------------------------------------ */
/* 夹具:临时库 + 预算 + 身份图(与 repository.spec 同构)                  */
/* ------------------------------------------------------------------ */

interface DbRig {
  dataDir: string;
  repo: PlaybackRepository;
  budgets: PlaybackBudgets;
}

const rigs: DbRig[] = [];

function migrationSql(name: string): string {
  const migrationPath = path.join(process.cwd(), 'src/platform/database/migrations', name, 'up.sql');
  if (!fs.existsSync(migrationPath)) {
    throw new Error(`未找到迁移文件 ${migrationPath} —— 本测试须以 apps/server 为工作目录运行`);
  }
  return fs.readFileSync(migrationPath, 'utf8');
}

function bootstrapRig(): { dataDir: string; repo: PlaybackRepository; budgets: PlaybackBudgets } {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hmp-playback-lifecycle-'));
  setEnvOverride(
    loadEnv({
      NODE_ENV: 'test',
      DATA_DIR: dataDir,
      DB_FILENAME: `${randomUUID()}.hmp.db`,
    }),
  );
  Database.close();
  Database.db.exec('CREATE TABLE IF NOT EXISTS _migrations (name TEXT PRIMARY KEY NOT NULL, applied_at TEXT NOT NULL)');
  // 010 收敛:rig 迁移清单补到 0007(playback 查询面已含 0007 列,如 playback_session.playback_started_at)
  for (const name of ['0001_init', '0002_profile_policy', '0003_media_catalog', '0004_manual_epg_binding', '0005_playback', '0006_pc_experience', '0007_online_vod']) {
    Database.db.transaction(() => {
      Database.db.exec(migrationSql(name));
      Database.db.prepare('INSERT INTO _migrations (name, applied_at) VALUES (?, ?)').run(name, new Date().toISOString());
    })();
  }
  // 转换并发注入 8:本文件不测额度(由 repository.spec 权威覆盖),只为多转换夹具留余量
  const budgets = createPlaybackBudgets(loadEnv({ NODE_ENV: 'test', PLAYBACK_CONVERSION_CONCURRENCY: '8' }));
  const rig: DbRig = { dataDir, repo: new PlaybackRepository(Database.db, budgets), budgets };
  rigs.push(rig);
  return rig;
}

interface SeedIds {
  householdId: string;
  accountId: string;
  profileId: string;
  deviceId: string;
  deviceSessionId: string;
  mediaId: string;
  playbackSourceId: string;
}

function seedGraph(): SeedIds {
  const db = Database.db;
  const now = new Date().toISOString();
  const householdId = randomUUID();
  const accountId = randomUUID();
  const profileId = randomUUID();
  const deviceId = randomUUID();
  const deviceSessionId = randomUUID();
  const mediaId = randomUUID();
  const mediaSourceId = randomUUID();
  const sourceEntryId = randomUUID();
  const playbackSourceId = randomUUID();
  db.transaction(() => {
    db.prepare('INSERT INTO household (id, name, created_at) VALUES (?, ?, ?)').run(householdId, '生命周期测试家庭', now);
    db.prepare(
      'INSERT INTO account (id, household_id, username, username_normalized, password_hash, role, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    ).run(accountId, householdId, 'admin', 'admin', 'hash', 'owner', now);
    db.prepare(
      'INSERT INTO profile (id, household_id, account_id, name, type, is_default, status, failed_pin_count, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
    ).run(profileId, householdId, accountId, '主档案', 'adult', 0, 'active', 0, now);
    db.prepare('INSERT INTO device (id, household_id, type, created_at) VALUES (?, ?, ?, ?)').run(deviceId, householdId, 'tv', now);
    db.prepare(
      'INSERT INTO device_session (id, household_id, account_id, device_id, token_hash, expires_at, last_active_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    ).run(deviceSessionId, householdId, accountId, deviceId, `hash-${deviceSessionId}`, '2030-01-01T00:00:00.000Z', now, now);
    db.prepare(
      'INSERT INTO media_item (id, household_id, type, title, version, title_overridden, type_overridden, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
    ).run(mediaId, householdId, 'movie', '测试影片', 1, 0, 0, now, now);
    db.prepare(
      'INSERT INTO media_source (id, household_id, kind, name, remote_url, root_key, relative_directory, private_access_approved, enabled, version, created_at, updated_at) VALUES (?, ?, ?, ?, NULL, ?, ?, 1, 1, 1, ?, ?)',
    ).run(mediaSourceId, householdId, 'nas', 'NAS 库', 'root', 'media', now, now);
    db.prepare(
      'INSERT INTO source_entry (id, household_id, source_id, identity_kind, identity_digest, media_id, present, first_seen_at, last_seen_at) VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?)',
    ).run(sourceEntryId, householdId, mediaSourceId, 'path', 'b'.repeat(64), mediaId, now, now);
    db.prepare(
      'INSERT INTO playback_source (id, household_id, source_id, source_entry_id, media_item_id, protocol, location, priority, requires_proxy, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, 100, 0, ?, ?)',
    ).run(playbackSourceId, householdId, mediaSourceId, sourceEntryId, mediaId, 'file', '/private/lifecycle/seed', now, now);
  })();
  return { householdId, accountId, profileId, deviceId, deviceSessionId, mediaId, playbackSourceId };
}

/* ------------------------------------------------------------------ */
/* 夹具:fake 协作者(结构对齐生命周期服务端口)                            */
/* ------------------------------------------------------------------ */

/** fake 授权重验:记录调用三元组与虚拟时刻;可编程按「第 N 次调用」拒绝 */
class FakeRevalidator {
  readonly calls: Array<{ deviceSessionId: string; profileId: string; mediaId: string; atMs: number }> = [];
  readonly rejectOnCall = new Set<number>();

  constructor(private readonly clock: ManualClock) {}

  async revalidate(deviceSessionId: string, profileId: string, mediaId: string): Promise<{ snapshot: string }> {
    this.calls.push({ deviceSessionId, profileId, mediaId, atMs: this.clock.now() });
    if (this.rejectOnCall.has(this.calls.length)) {
      // 模拟权限失效(会话撤销/策略收紧/档案切换):授权管线抛稳定 DomainError
      throw new Error('SESSION_INVALID(fake 授权拒绝)');
    }
    return { snapshot: 'ok' };
  }
}

/** fake 监督者:仅记录 cancel 调用(SIGTERM→5s→SIGKILL/确认退出释放额度为监督者内部职责) */
class FakeSupervisor {
  readonly cancels: string[] = [];
  async cancel(conversionId: string): Promise<void> {
    this.cancels.push(conversionId);
  }
}

/** 可编程目录删除:记录调用序列;failAttempts 按目录注入前 N 次失败(EBUSY 语义) */
class RecordingRemover {
  readonly calls: string[] = [];
  private readonly failAttempts = new Map<string, number>();

  failNextAttempts(directory: string, times: number): void {
    this.failAttempts.set(directory, (this.failAttempts.get(directory) ?? 0) + times);
  }

  async remove(directory: string): Promise<void> {
    this.calls.push(directory);
    const remaining = this.failAttempts.get(directory) ?? 0;
    if (remaining > 0) {
      this.failAttempts.set(directory, remaining - 1);
      throw new Error('EBUSY(注入的清理失败)');
    }
    await fsp.rm(directory, { recursive: true, force: true });
  }
}

/* ------------------------------------------------------------------ */
/* 夹具:行读取与结果断言                                                */
/* ------------------------------------------------------------------ */

interface SessionRow {
  id: string;
  household_id: string;
  device_session_id: string;
  device_id: string;
  profile_id: string;
  media_id: string;
  state: string;
  delivery: string | null;
  generation: number;
  version: number;
  position_seconds: number;
  desired_paused: number;
  created_at: string;
  started_at: string | null;
  ended_at: string | null;
  last_heartbeat_at: string;
  failure_code: string | null;
}

function sessionRow(sessionId: string): SessionRow {
  const row = Database.db.prepare('SELECT * FROM playback_session WHERE id = ?').get(sessionId) as SessionRow | undefined;
  expect(row, `session ${sessionId} 应存在`).toBeDefined();
  return row as SessionRow;
}

function conversionRow(conversionId: string): { id: string; session_id: string; state: string; generation: number } {
  const row = Database.db.prepare('SELECT id, session_id, state, generation FROM playback_conversion WHERE id = ?').get(conversionId) as
    | { id: string; session_id: string; state: string; generation: number }
    | undefined;
  expect(row, `conversion ${conversionId} 应存在`).toBeDefined();
  return row as { id: string; session_id: string; state: string; generation: number };
}

function expectOk<T>(result: PlaybackResult<T>): T {
  expect(result.ok, JSON.stringify(result)).toBe(true);
  return (result as PlaybackOk<T>).value;
}

function expectErr<T>(result: PlaybackResult<T>, code: PlaybackErrorCode): void {
  expect(result.ok, JSON.stringify(result)).toBe(false);
  if (!result.ok) {
    expect(result.code).toBe(code);
  }
}

/** UTC ISO-8601(毫秒,Z)——注入时钟时刻 → 入库时间形态 */
function iso(ms: number): string {
  return new Date(ms).toISOString();
}

/** 排空微任务与真实 fs 宏任务(ManualClock 唤醒后的扫描/清理链为异步续体) */
async function settleEvents(turns = 32): Promise<void> {
  for (let i = 0; i < turns; i += 1) {
    await Promise.resolve();
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
}

/**
 * 按 15 秒节拍推进直至谓词成立(节拍内至少触发一轮各定时链扫描):
 * 定时链为「醒来→扫描→续排下一拍」的锚定形态,单次 advance 触发的拍点取决于链的
 * 续排锚点;断言一律绑定阈值语义(距最近心跳/拒绝时刻的elapsed),不绑定格点精度。
 */
async function advanceUntil(rig: LifecycleRig, predicate: () => boolean, maxSteps = 24): Promise<void> {
  const intervalMs = rig.budgets.lifecycle.heartbeatIntervalSeconds * 1000;
  for (let step = 0; step < maxSteps; step += 1) {
    await rig.clock.advance(intervalMs);
    await settleEvents();
    if (predicate()) {
      return;
    }
  }
  throw new Error(`条件未在 ${maxSteps} 个节拍内达成(当前虚拟时刻 ${rig.clock.now()})`);
}

/* ------------------------------------------------------------------ */
/* 夹具:生命周期服务装配                                                */
/* ------------------------------------------------------------------ */

interface LifecycleRig {
  t0: number;
  repo: PlaybackRepository;
  budgets: PlaybackBudgets;
  clock: ManualClock;
  storageRoot: string;
  privateRootDir: string;
  storage: ConversionStorageService;
  supervisor: FakeSupervisor;
  auth: FakeRevalidator;
  remover: RecordingRemover;
  seed: SeedIds;
  lifecycle: PlaybackLifecycleService;
}

function buildLifecycleRig(): LifecycleRig {
  const { dataDir, repo, budgets } = bootstrapRig();
  const clock = createManualClock();
  const t0 = MANUAL_CLOCK_DEFAULT_START_MS;
  const storageRoot = path.join(dataDir, 'storage');
  fs.mkdirSync(storageRoot, { recursive: true });
  const privateRootDir = path.join(storageRoot, 'playback');
  const remover = new RecordingRemover();
  const storage = new ConversionStorageService({
    budgets,
    rootDir: storageRoot,
    clock,
    freeDiskBytes: () => Number.MAX_SAFE_INTEGER,
    removeDirectory: (directory) => remover.remove(directory),
  });
  const supervisor = new FakeSupervisor();
  const auth = new FakeRevalidator(clock);
  const lifecycle = new PlaybackLifecycleService({
    repository: repo,
    authorization: auth,
    storage,
    supervisor,
    budgets,
    clock,
    privateRootDir,
  });
  return { t0, repo, budgets, clock, storageRoot, privateRootDir, storage, supervisor, auth, remover, seed: seedGraph(), lifecycle };
}

/** 建 preparing 会话(建档时刻=注入时钟当前值,last_heartbeat_at=同刻) */
function createSessionAt(rig: LifecycleRig, overrides: { at?: string; mediaId?: string } = {}): string {
  const at = overrides.at ?? iso(rig.clock.now());
  const created = rig.repo.createSession({
    householdId: rig.seed.householdId,
    deviceSessionId: rig.seed.deviceSessionId,
    deviceId: rig.seed.deviceId,
    profileId: rig.seed.profileId,
    mediaId: overrides.mediaId ?? rig.seed.mediaId,
    at,
  });
  return expectOk(created).id;
}

/** 预留一条转换记录(活动态 reserved;额度占用供取消/启动恢复断言) */
function reserveConversionAt(rig: LifecycleRig, sessionId: string, generation = 1): string {
  const reserved = rig.repo.reserveConversion({
    householdId: rig.seed.householdId,
    sessionId,
    generation,
    mode: 'remux',
    outputVideoCodec: 'copy',
    outputAudioCodec: 'copy',
    at: iso(rig.clock.now()),
  });
  return expectOk(reserved).id;
}

/** 打开任务私有窗口并写入字节(清理/预算断言的实体目录) */
async function openWindowWithBytes(
  rig: LifecycleRig,
  sessionId: string,
  bytes: number,
  generation = 1,
): Promise<{ directory: string; taskKey: string }> {
  const opened = await rig.storage.openTask({ householdId: rig.seed.householdId, sessionId, generation });
  const writer = expectOk(opened);
  if (bytes > 0) {
    expectOk(await writer.append(bytes));
  }
  return { directory: writer.directory, taskKey: writer.taskKey };
}

afterEach(async () => {
  while (rigs.length > 0) {
    const rig = rigs.pop();
    if (rig === undefined) {
      break;
    }
    Database.close();
    fs.rmSync(rig.dataDir, { recursive: true, force: true });
  }
  await settleEvents(4);
});

/* ------------------------------------------------------------------ */
/* 心跳链                                                              */
/* ------------------------------------------------------------------ */

describe('T028 心跳链', () => {
  it('heartbeat 更新 last_heartbeat_at 与位置/暂停意图,且不递增 version/generation', () => {
    const rig = buildLifecycleRig();
    const sessionId = createSessionAt(rig, { at: iso(rig.t0) });
    const before = sessionRow(sessionId);

    const result = rig.lifecycle.heartbeat(sessionId, {
      positionSeconds: 42.5,
      paused: true,
      at: iso(rig.t0 + 15_000),
    });

    const view = expectOk(result);
    expect(view.lastHeartbeatAt).toBe(iso(rig.t0 + 15_000));
    expect(view.positionSeconds).toBe(42.5);
    expect(view.desiredPaused).toBe(true);
    expect(view.version).toBe(before.version);
    expect(view.generation).toBe(before.generation);
    const row = sessionRow(sessionId);
    expect(row.last_heartbeat_at).toBe(iso(rig.t0 + 15_000));
    expect(row.desired_paused).toBe(1);
  });

  it('paused 心跳同样刷新 last_heartbeat_at:失联判定从最近一次(暂停)心跳起算', async () => {
    const rig = buildLifecycleRig();
    const sessionId = createSessionAt(rig, { at: iso(rig.t0) });
    rig.lifecycle.start();
    const lost = rig.budgets.lifecycle.heartbeatLostSeconds * 1000;

    // 播放 40 秒后暂停(暂停心跳照发,R5:paused 心跳≠失联)
    await rig.clock.advance(40_000);
    await settleEvents();
    expectOk(rig.lifecycle.heartbeat(sessionId, { paused: true, at: iso(rig.clock.now()) }));
    const pausedAtMs = rig.clock.now();
    expect(sessionRow(sessionId).state).toBe('preparing');

    // 距建档已 84 秒(> 45 秒):若暂停心跳未刷新 last_heartbeat_at,此刻早已被判失联;
    // 仍为 preparing 即证明失联计时从最近一次(暂停)心跳起算
    await rig.clock.advance(44_000);
    await settleEvents();
    expect(sessionRow(sessionId).state).toBe('preparing');

    // 距暂停心跳超过 45 秒后的首个扫描节拍:失联判定成立 → 系统回收
    await advanceUntil(rig, () => sessionRow(sessionId).state !== 'preparing');
    const row = sessionRow(sessionId);
    expect(row.state).toBe('interrupted');
    expect(row.ended_at).not.toBeNull();
    expect(Date.parse(row.ended_at as string) - pausedAtMs).toBeGreaterThanOrEqual(lost);
    expect(row.failure_code).toBeNull();
  });

  it('未知会话返回 PLAYBACK_NOT_FOUND;终态会话返回稳定码且不复活', async () => {
    const rig = buildLifecycleRig();
    expectErr(rig.lifecycle.heartbeat('no-such-session', { at: iso(rig.t0) }), 'PLAYBACK_NOT_FOUND');

    const sessionId = createSessionAt(rig, { at: iso(rig.t0) });
    expectOk(await rig.lifecycle.stopSession(sessionId, { at: iso(rig.t0 + 1_000) }));
    // ended 终态守卫的稳定码映射:ended → PLAYBACK_ENDED(playback.types terminalGuardCode)
    expectErr(rig.lifecycle.heartbeat(sessionId, { at: iso(rig.t0 + 2_000) }), 'PLAYBACK_ENDED');
    expect(sessionRow(sessionId).last_heartbeat_at).toBe(iso(rig.t0));
  });

  it('45 秒无心跳 → 失联回收:session→interrupted(失败码空)、取消转换、60 秒后清理目录', async () => {
    const rig = buildLifecycleRig();
    const sessionId = createSessionAt(rig, { at: iso(rig.t0) });
    const conversionId = reserveConversionAt(rig, sessionId);
    const { directory } = await openWindowWithBytes(rig, sessionId, 4096);
    rig.lifecycle.start();
    const lost = rig.budgets.lifecycle.heartbeatLostSeconds * 1000;

    await advanceUntil(rig, () => sessionRow(sessionId).state !== 'preparing');

    // 失联属系统回收 → interrupted(data-model:任一活动态→ended/failed/interrupted;
    // repository.markInterrupted:「失联/重启恢复」)。ended_at 必填、failure_code 保持空。
    const row = sessionRow(sessionId);
    expect(row.state).toBe('interrupted');
    expect(Date.parse(row.ended_at as string) - Date.parse(row.last_heartbeat_at)).toBeGreaterThanOrEqual(lost);
    expect(row.failure_code).toBeNull();
    // 活动转换被取消(真实监督者据其确认退出并释放额度)
    expect(rig.supervisor.cancels).toEqual([conversionId]);
    // 终止后 60 秒清理目录并释放预算(R5:终止后 60 秒内清理)
    expect(fs.existsSync(directory)).toBe(true);
    await advanceUntil(rig, () => !fs.existsSync(directory), 8);
    expect(rig.storage.totalBytesOnDisk()).toBe(0);
  });

  it('未 start() 时定时链不运转:时间推进不产生扫描/回收/复核', async () => {
    const rig = buildLifecycleRig();
    const sessionId = createSessionAt(rig, { at: iso(rig.t0) });
    reserveConversionAt(rig, sessionId);

    await rig.clock.advance(rig.budgets.lifecycle.heartbeatLostSeconds * 1000 + 60_000);
    await settleEvents();

    expect(sessionRow(sessionId).state).toBe('preparing');
    expect(rig.supervisor.cancels).toEqual([]);
    expect(rig.auth.calls).toEqual([]);
  });
});

/* ------------------------------------------------------------------ */
/* 后台权限复核                                                        */
/* ------------------------------------------------------------------ */

describe('T028 后台权限复核', () => {
  it('每 15 秒对全部活动会话执行 authorization.revalidate(建档身份三元组)', async () => {
    const rig = buildLifecycleRig();
    const sessionA = createSessionAt(rig, { at: iso(rig.t0) });
    const sessionB = createSessionAt(rig, { at: iso(rig.t0 + 1_000) });
    rig.lifecycle.start();
    const recheck = rig.budgets.lifecycle.authRecheckSeconds * 1000;

    await rig.clock.advance(recheck);
    await settleEvents();
    expect(rig.auth.calls).toHaveLength(2);
    expect(rig.auth.calls[0]).toMatchObject({
      deviceSessionId: rig.seed.deviceSessionId,
      profileId: rig.seed.profileId,
      mediaId: rig.seed.mediaId,
      atMs: rig.t0 + recheck,
    });

    await rig.clock.advance(recheck);
    await settleEvents();
    expect(rig.auth.calls).toHaveLength(4);
    expect(sessionRow(sessionA).state).toBe('preparing');
    expect(sessionRow(sessionB).state).toBe('preparing');
  });

  it('复核通过 → 无动作;拒绝 → 立即终止该会话(interrupted + 取消转换 + 清理),同拍其他会话不受影响', async () => {
    const rig = buildLifecycleRig();
    const sessionA = createSessionAt(rig, { at: iso(rig.t0) });
    const sessionB = createSessionAt(rig, { at: iso(rig.t0 + 1_000) });
    const conversionB = reserveConversionAt(rig, sessionB);
    const { directory } = await openWindowWithBytes(rig, sessionB, 2048);
    // 首轮复核第 2 次调用(sessionB,稳定 (created_at,id) 序)拒绝:策略收紧/档案切换/会话撤销同形
    rig.auth.rejectOnCall.add(2);
    rig.lifecycle.start();

    await rig.clock.advance(rig.budgets.lifecycle.authRecheckSeconds * 1000);
    await settleEvents();

    // 两个活动会话都被复核
    expect(rig.auth.calls).toHaveLength(2);
    // 被拒会话:权限失效回收 → interrupted(依据见文件头「终态选择依据」)
    const rowB = sessionRow(sessionB);
    expect(rowB.state).toBe('interrupted');
    expect(rowB.failure_code).toBeNull();
    expect(rig.supervisor.cancels).toEqual([conversionB]);
    // 通过会话:无动作
    expect(sessionRow(sessionA).state).toBe('preparing');
    // 清理链在 cleanupDelaySeconds 后删除该会话私有目录
    await rig.clock.advance(rig.budgets.lifecycle.cleanupDelaySeconds * 1000);
    await settleEvents();
    expect(fs.existsSync(directory)).toBe(false);
    expect(rig.storage.totalBytesOnDisk()).toBe(0);
  });

  it('终态会话退出复核轮转(不再产生 revalidate 调用)', async () => {
    const rig = buildLifecycleRig();
    const sessionId = createSessionAt(rig, { at: iso(rig.t0) });
    rig.lifecycle.start();

    await rig.clock.advance(rig.budgets.lifecycle.authRecheckSeconds * 1000);
    await settleEvents();
    expect(rig.auth.calls).toHaveLength(1);

    expectOk(await rig.lifecycle.stopSession(sessionId, { at: iso(rig.clock.now()) }));
    await rig.clock.advance(rig.budgets.lifecycle.authRecheckSeconds * 1000);
    await settleEvents();
    expect(rig.auth.calls).toHaveLength(1);
  });
});

/* ------------------------------------------------------------------ */
/* stop/cancel/失败/失权                                               */
/* ------------------------------------------------------------------ */

describe('T028 stop/cancel/失败/失权终止', () => {
  it('stopSession → ended(ended_at 必填、failure_code 空)+ 取消转换 + 60 秒清理', async () => {
    const rig = buildLifecycleRig();
    const sessionId = createSessionAt(rig, { at: iso(rig.t0) });
    const conversionId = reserveConversionAt(rig, sessionId);
    const { directory } = await openWindowWithBytes(rig, sessionId, 1024);

    const stoppedAt = rig.t0 + 5_000;
    const view = expectOk(await rig.lifecycle.stopSession(sessionId, { at: iso(stoppedAt) }));
    expect(view.state).toBe('ended');
    const row = sessionRow(sessionId);
    expect(row.state).toBe('ended');
    expect(row.ended_at).toBe(iso(stoppedAt));
    expect(row.failure_code).toBeNull();
    expect(rig.supervisor.cancels).toEqual([conversionId]);

    await rig.clock.advance(rig.budgets.lifecycle.cleanupDelaySeconds * 1000);
    await settleEvents();
    expect(fs.existsSync(directory)).toBe(false);
    expect(rig.storage.totalBytesOnDisk()).toBe(0);
  });

  it('stopSession 幂等:重复 stop 无副作用(不重写终态、不重复取消、清理只排一次)', async () => {
    const rig = buildLifecycleRig();
    const sessionId = createSessionAt(rig, { at: iso(rig.t0) });
    reserveConversionAt(rig, sessionId);
    const { directory } = await openWindowWithBytes(rig, sessionId, 512);

    const first = expectOk(await rig.lifecycle.stopSession(sessionId, { at: iso(rig.t0 + 1_000) }));
    const second = expectOk(await rig.lifecycle.stopSession(sessionId, { at: iso(rig.t0 + 2_000) }));
    expect(second.state).toBe('ended');
    expect(second.endedAt).toBe(first.endedAt);
    expect(rig.supervisor.cancels).toHaveLength(1);

    await rig.clock.advance(rig.budgets.lifecycle.cleanupDelaySeconds * 1000);
    await settleEvents();
    expect(fs.existsSync(directory)).toBe(false);
    // 双重 stop 只触发一次目录删除(重复清理已被会话级去重折叠)
    expect(rig.remover.calls.filter((call) => call === directory)).toHaveLength(1);
  });

  it('stopSession 未知会话 → PLAYBACK_NOT_FOUND', async () => {
    const rig = buildLifecycleRig();
    expectErr(await rig.lifecycle.stopSession('no-such-session', { at: iso(rig.t0) }), 'PLAYBACK_NOT_FOUND');
  });

  it('markFailure → failed + 稳定 failure_code + 取消转换 + 清理;非稳定码按编程性违反抛错', async () => {
    const rig = buildLifecycleRig();
    const sessionId = createSessionAt(rig, { at: iso(rig.t0) });
    const conversionId = reserveConversionAt(rig, sessionId);
    const { directory } = await openWindowWithBytes(rig, sessionId, 256);

    const failedAt = rig.t0 + 3_000;
    const view = expectOk(await rig.lifecycle.markFailure(sessionId, 'PLAYBACK_RESOURCE_UNAVAILABLE', { at: iso(failedAt) }));
    expect(view.state).toBe('failed');
    const row = sessionRow(sessionId);
    expect(row.state).toBe('failed');
    expect(row.failure_code).toBe('PLAYBACK_RESOURCE_UNAVAILABLE');
    expect(row.ended_at).toBe(iso(failedAt));
    expect(rig.supervisor.cancels).toEqual([conversionId]);

    await expect(rig.lifecycle.markFailure(sessionId, 'NOT_A_STABLE_CODE' as PlaybackErrorCode)).rejects.toThrow(/稳定失败码/);

    await rig.clock.advance(rig.budgets.lifecycle.cleanupDelaySeconds * 1000);
    await settleEvents();
    expect(fs.existsSync(directory)).toBe(false);
  });

  it('markFailure 对终态会话为 no-op(状态不再改写,失败码保持原值)', async () => {
    const rig = buildLifecycleRig();
    const sessionId = createSessionAt(rig, { at: iso(rig.t0) });
    expectOk(await rig.lifecycle.markFailure(sessionId, 'PLAYBACK_FORMAT_UNSUPPORTED', { at: iso(rig.t0 + 1_000) }));

    const again = await rig.lifecycle.markFailure(sessionId, 'PLAYBACK_RESOURCE_UNAVAILABLE', { at: iso(rig.t0 + 2_000) });
    expect(again.ok).toBe(true);
    const row = sessionRow(sessionId);
    expect(row.state).toBe('failed');
    expect(row.failure_code).toBe('PLAYBACK_FORMAT_UNSUPPORTED');
    expect(row.ended_at).toBe(iso(rig.t0 + 1_000));
    expect(rig.supervisor.cancels).toEqual([]);
  });
});

/* ------------------------------------------------------------------ */
/* 退出后 60 秒清理(storage pending 语义)                               */
/* ------------------------------------------------------------------ */

describe('T028 退出后清理', () => {
  it('清理恰在 cleanupDelaySeconds 到期:提前 1ms 仍保留,到期即删除并释放预算', async () => {
    const rig = buildLifecycleRig();
    const sessionId = createSessionAt(rig, { at: iso(rig.t0) });
    const { directory } = await openWindowWithBytes(rig, sessionId, 4096);
    expectOk(await rig.lifecycle.stopSession(sessionId, { at: iso(rig.t0 + 1_000) }));
    const delay = rig.budgets.lifecycle.cleanupDelaySeconds * 1000;

    await rig.clock.advance(delay - 1);
    await settleEvents();
    expect(fs.existsSync(directory)).toBe(true);
    expect(rig.storage.totalBytesOnDisk()).toBe(4096);
    expect(rig.remover.calls).toEqual([]);

    await rig.clock.advance(1);
    await settleEvents();
    expect(fs.existsSync(directory)).toBe(false);
    expect(rig.storage.totalBytesOnDisk()).toBe(0);
  });

  it('清理失败 → 保持 pending 计预算,每 cleanupRetrySeconds 重试(调用序列断言),成功后预算释放', async () => {
    const rig = buildLifecycleRig();
    const sessionId = createSessionAt(rig, { at: iso(rig.t0) });
    const { directory, taskKey } = await openWindowWithBytes(rig, sessionId, 8192);
    expectOk(await rig.lifecycle.stopSession(sessionId, { at: iso(rig.t0 + 1_000) }));
    rig.remover.failNextAttempts(directory, 2);
    const retry = rig.budgets.lifecycle.cleanupRetrySeconds * 1000;

    // T+60s:首次清理删除失败 → storage 保持 cleanup_state=pending,预算仍计(R5/data-model)
    await rig.clock.advance(rig.budgets.lifecycle.cleanupDelaySeconds * 1000);
    await settleEvents();
    expect(rig.remover.calls).toEqual([directory]);
    expect(fs.existsSync(directory)).toBe(true);
    expect(rig.storage.pendingCleanupTasks()).toEqual([taskKey]);
    expect(rig.storage.totalBytesOnDisk()).toBe(8192);

    // T+120s:第一次重试仍失败 → 继续 pending 计预算
    await rig.clock.advance(retry);
    await settleEvents();
    expect(rig.remover.calls).toEqual([directory, directory]);
    expect(fs.existsSync(directory)).toBe(true);
    expect(rig.storage.pendingCleanupTasks()).toEqual([taskKey]);
    expect(rig.storage.totalBytesOnDisk()).toBe(8192);

    // T+180s:第二次重试成功 → pending 清除、预算释放、目录删除
    await rig.clock.advance(retry);
    await settleEvents();
    expect(rig.remover.calls).toEqual([directory, directory, directory]);
    expect(fs.existsSync(directory)).toBe(false);
    expect(rig.storage.pendingCleanupTasks()).toEqual([]);
    expect(rig.storage.totalBytesOnDisk()).toBe(0);
  });
});

/* ------------------------------------------------------------------ */
/* 启动恢复                                                            */
/* ------------------------------------------------------------------ */

describe('T028 启动恢复 recoverOnBoot', () => {
  it('活动 session/转换全部标 interrupted,已终态行不动,额度全部释放', async () => {
    const rig = buildLifecycleRig();
    const preparing = createSessionAt(rig, { at: iso(rig.t0) });
    const ready = createSessionAt(rig, { at: iso(rig.t0 + 1_000) });
    expectOk(rig.repo.markReady(ready, {
      cas: { expectedVersion: 1 },
      playbackSourceId: rig.seed.playbackSourceId,
      delivery: 'remux',
      at: iso(rig.t0 + 2_000),
    }));
    const activeConversion = reserveConversionAt(rig, preparing);
    const reservedConversion = reserveConversionAt(rig, ready);
    // 一条已自然结束的历史转换(上一次运行内完成):重启恢复不得改写
    const endedConversion = reserveConversionAt(rig, ready, 2);
    expectOk(rig.repo.markConversion(endedConversion, { conversionId: endedConversion, householdId: rig.seed.householdId, state: 'starting', at: iso(rig.t0 + 3_000) }));
    expectOk(rig.repo.markConversion(endedConversion, { conversionId: endedConversion, householdId: rig.seed.householdId, state: 'running', at: iso(rig.t0 + 4_000) }));
    expectOk(rig.repo.markConversion(endedConversion, { conversionId: endedConversion, householdId: rig.seed.householdId, state: 'stopping', at: iso(rig.t0 + 5_000) }));
    expectOk(rig.repo.markConversion(endedConversion, { conversionId: endedConversion, householdId: rig.seed.householdId, state: 'ended', at: iso(rig.t0 + 6_000) }));

    expect(rig.repo.countActiveConversions()).toBe(2);
    await rig.lifecycle.recoverOnBoot({ at: iso(rig.t0 + 10_000) });

    // 活动会话 → interrupted(ended_at 必填,failure_code 空)
    for (const sessionId of [preparing, ready]) {
      const row = sessionRow(sessionId);
      expect(row.state).toBe('interrupted');
      expect(row.ended_at).toBe(iso(rig.t0 + 10_000));
      expect(row.failure_code).toBeNull();
    }
    // 活动转换 → interrupted(重启即上一进程必已退出:确认退出语义走 releaseOnExit)
    expect(conversionRow(activeConversion).state).toBe('interrupted');
    expect(conversionRow(reservedConversion).state).toBe('interrupted');
    expect(conversionRow(endedConversion).state).toBe('ended');
    // 额度自 state 离开 reserved～stopping 起全部释放
    expect(rig.repo.countActiveConversions()).toBe(0);
  });

  it('不按旧 PID 杀进程:恢复全程无 supervisor.cancel/无任何进程管理(任务回收走 releaseOnExit)', async () => {
    const rig = buildLifecycleRig();
    const sessionId = createSessionAt(rig, { at: iso(rig.t0) });
    const conversionId = reserveConversionAt(rig, sessionId);

    await rig.lifecycle.recoverOnBoot({ at: iso(rig.t0 + 1_000) });

    // data-model:任务 PID 仅进程内持有,不作为重启后杀进程依据 —— 恢复只做 DB 标记与
    // 私有根扫描,绝不尝试对旧运行实例的任何进程句柄执行信号(行为断言:cancel 零调用)。
    expect(rig.supervisor.cancels).toEqual([]);
    expect(conversionRow(conversionId).state).toBe('interrupted');
    expect(sessionRow(sessionId).state).toBe('interrupted');
  });

  it('扫私有根孤儿目录:任务形状目录删除,非任务形状目录保留;删除失败进入 pending 计预算', async () => {
    const rig = buildLifecycleRig();
    const orphanA = path.join(rig.privateRootDir, rig.seed.householdId, randomUUID(), '1');
    const orphanB = path.join(rig.privateRootDir, rig.seed.householdId, randomUUID(), '3');
    const stray = path.join(rig.privateRootDir, rig.seed.householdId, randomUUID(), 'not-a-generation');
    fs.mkdirSync(orphanA, { recursive: true });
    fs.mkdirSync(orphanB, { recursive: true });
    fs.mkdirSync(stray, { recursive: true });
    fs.writeFileSync(path.join(orphanA, 'seg00001.ts'), 'x');
    rig.remover.failNextAttempts(orphanB, 1);

    await rig.lifecycle.recoverOnBoot({ at: iso(rig.t0) });

    // 孤儿目录已清(R5:启动扫本实例私有根);删除失败者进入 storage pending 重试链
    expect(fs.existsSync(orphanA)).toBe(false);
    expect(fs.existsSync(orphanB)).toBe(true);
    expect(rig.storage.pendingCleanupTasks()).toHaveLength(1);
    // 非任务目录形状(generation 段非正整数)不按任务清理
    expect(fs.existsSync(stray)).toBe(true);
    expect(rig.lifecycle.readyToAcceptConversions()).toBe(true);
  });

  it('readyToAcceptConversions 门:恢复完成前 false,完成后 true;start() 不改变门状态', async () => {
    const rig = buildLifecycleRig();
    expect(rig.lifecycle.readyToAcceptConversions()).toBe(false);
    rig.lifecycle.start();
    expect(rig.lifecycle.readyToAcceptConversions()).toBe(false);

    await rig.lifecycle.recoverOnBoot({ at: iso(rig.t0) });
    expect(rig.lifecycle.readyToAcceptConversions()).toBe(true);

    // 幂等:重复恢复无副作用(终态行不会被再次改写/报错)
    await rig.lifecycle.recoverOnBoot({ at: iso(rig.t0 + 1_000) });
    expect(rig.lifecycle.readyToAcceptConversions()).toBe(true);
  });
});

/* ------------------------------------------------------------------ */
/* 关闭 hook                                                           */
/* ------------------------------------------------------------------ */

describe('T028 关闭 hook onApplicationShutdown', () => {
  it('取消全部活动转换;定时链停转;目录保留可用(不删目录、不释放预算)', async () => {
    const rig = buildLifecycleRig();
    const sessionA = createSessionAt(rig, { at: iso(rig.t0) });
    const sessionB = createSessionAt(rig, { at: iso(rig.t0 + 1_000) });
    const conversionA = reserveConversionAt(rig, sessionA);
    const conversionB = reserveConversionAt(rig, sessionB);
    const { directory } = await openWindowWithBytes(rig, sessionA, 4096);
    rig.lifecycle.start();
    await rig.clock.advance(rig.budgets.lifecycle.authRecheckSeconds * 1000);
    await settleEvents();
    expect(rig.auth.calls).toHaveLength(2);

    await rig.lifecycle.onApplicationShutdown();
    // 全部活动转换被取消(枚举序按 conversion id,与建档顺序无关;集合语义断言)
    expect([...rig.supervisor.cancels].sort()).toEqual([conversionA, conversionB].sort());

    // 定时链停转:继续推进时间无复核、无失联回收
    await rig.clock.advance(rig.budgets.lifecycle.heartbeatLostSeconds * 1000 + rig.budgets.lifecycle.cleanupDelaySeconds * 1000);
    await settleEvents();
    expect(rig.auth.calls).toHaveLength(2);
    expect(sessionRow(sessionA).state).toBe('preparing');
    expect(sessionRow(sessionB).state).toBe('preparing');

    // 保留目录可用:不删目录、不安排/执行清理、不动预算(遗留回收交下次启动私有根扫描)
    expect(fs.existsSync(directory)).toBe(true);
    expect(rig.storage.totalBytesOnDisk()).toBe(4096);
    expect(rig.storage.pendingCleanupTasks()).toEqual([]);
    expect(rig.remover.calls).toEqual([]);
  });
});
