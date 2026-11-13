import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { Database } from '@platform/database/database';
import { setEnvOverride } from '@platform/config/env';
import { loadEnv } from '@platform/config/env.schema';
import { createPlaybackBudgets, type PlaybackBudgets } from '@platform/config/playback-budgets';
import { createManualClock, MANUAL_CLOCK_DEFAULT_START_MS, type ManualClock } from '../../fixtures/clock';
import type { SessionContext } from '@platform/http-common/current-session.decorator';
import { DomainError } from '@platform/http-common/domain-error';
import { PlaybackRetentionService } from '../../../src/contexts/playback/application/playback-retention.service';
import {
  PlaybackSelectionService,
  type PlaybackStartFactsPort,
  type PlaybackTrackFactsPort,
} from '../../../src/contexts/playback/application/playback-selection.service';
import {
  PlaybackLifecycleService,
  type PlaybackVodInputGuardPort,
  type LifecycleStoragePort,
} from '../../../src/contexts/playback/infrastructure/playback-lifecycle.service';
import { PlaybackRepository } from '../../../src/contexts/playback/infrastructure/playback.repository';
import { PlaybackAuthorizationService } from '../../../src/contexts/playback/application/playback-authorization.service';
import { bindPlaybackStore } from '../../../src/contexts/playback/application/playback-store.port';
import { drizzlePlaybackStore } from '../../../src/contexts/playback/infrastructure/playback-store.drizzle';
import {
  drizzleVodInputStore,
  type VodInputStore,
} from '../../../src/contexts/playback/infrastructure/playback-input-store.drizzle';

/**
 * T045 服务级 watchdog/换代单测(spec 010,US2 —— TDD 绿阶段验收;允许新建):
 *
 * 权威依据(先读后写):
 * - tasks.md T045:代次 CAS+同 input 新绑定+旧代撤销/持久 cleanup;「失败前无变化,
 *   失败后新代 failed 不倒退,seq 不归零」;readyAt 起 60s 未 playback_started_at 回收,
 *   heartbeat/renew 不续命;保留 hls_proxy 服务端 seek 拒绝并发布 seekCapability。
 * - data-model.md §9:未有 playback_started_at 的 ready 会话以服务器 readyAt 起 60s 固定
 *   期限回收(等待手势不延长、heartbeat/renew 不续命),独立 playback_started_at 由合格
 *   playing 观测设置后解除期限;暂停不重新开启该期限;pending slot/intent 不延长存活。
 * - data-model.md §6:seek/会重建输出选择 —— CAS 推进 generation + 新绑定同
 *   resolved_input_id + 旧代撤销/cleanup 标记同事务;失败前无变化;新代沿用输入。
 * - contracts/api.md §7 I4:seekCapability(none|client|server_rebuild)/playbackStarted
 *   事实面(hls_proxy VOD 第一期仅 client|none;直播 none);DTO 输出归 T046。
 *
 * 覆盖矩阵(服务级;持久原语行为已由 vod-input-binding.spec [T045-*] 钉死):
 * 1. 60s 回收全矩阵(未起播回收/playing 解除后保留/无 playing 回收/两 watcher CAS/
 *    heartbeat 不续命/暂停不重开)+ 节拍链( retention 定时链驱动)与端口缺位 no-op;
 * 2. seek 换代 CAS 流(store 换绑权威):同 input 新绑定 + 旧代撤销 + 失败前无变化 +
 *    失败后新代 failed 不倒退 + 个人 ledger seq 不归零 + NAS 无绑定回退既有路径;
 * 3. 旧 NAS/直播回收回归(回收判定为会话行通用语义,不要求绑定存在);
 * 4. lifecycle 心跳重验(T043 建议的 assertCurrent 接线):失配终止/无漂移放行/NAS 跳过;
 * 5. I4 事实面(sessionSeekFacts):capability 推导 + playbackStarted 跨 generation 保留。
 *
 * 夹具分层(与 retention.spec/vod-input-binding.spec 同构):独立临时文件库 +
 * 全量权威迁移 DDL(0001–0007)+ ManualClock(期限/租约时刻全部经 clock 推进);
 * 行种子直插(复合 FK/CHECK 全满足);T057 observation 写入缝以 playback_started_at
 * 直改表达(其控制器归 T057,本文件只消费该持久事实)。
 */

bindPlaybackStore(drizzlePlaybackStore());

/* ------------------------------------------------------------------ */
/* 夹具:临时库 + 种子世界 + 时钟                                          */
/* ------------------------------------------------------------------ */

/** 未起播回收固定期限(data-model §9;与 store 侧判定同值) */
const UNSTARTED_READY_RECLAIM_MS = 60_000;

/** watchdog 扫描节拍(retention 固定间隔;与本服务实现同值) */
const WATCHDOG_INTERVAL_MS = 15_000;

interface RigSeed {
  householdId: string;
  accountId: string;
  profileId: string;
  deviceId: string;
  deviceSessionId: string;
  sourceId: string;
  parentMediaId: string;
  episodeMediaId: string;
  titleId: string;
  lineId: string;
  episodeId: string;
  sourceEntryId: string;
  playbackSourceId: string;
}

interface WatchdogRig {
  dataDir: string;
  budgets: PlaybackBudgets;
  clock: ManualClock;
  t0: number;
  seed: RigSeed;
  repository: PlaybackRepository;
  vodInput: VodInputStore;
  selection: PlaybackSelectionService;
  lifecycle: PlaybackLifecycleService;
  context: SessionContext;
}

const openRigs: { dataDir: string }[] = [];

/** UTC ISO-8601(毫秒,Z) */
function iso(ms: number): string {
  return new Date(ms).toISOString();
}

function migrationSql(name: string): string {
  const migrationPath = path.join(process.cwd(), 'src/platform/database/migrations', name, 'up.sql');
  if (!fs.existsSync(migrationPath)) {
    throw new Error(`未找到迁移文件 ${migrationPath} —— 本测试须以 apps/server 为工作目录运行`);
  }
  return fs.readFileSync(migrationPath, 'utf8');
}

function seedVodWorld(conn: typeof Database.db, t0: number): RigSeed {
  const now = iso(t0);
  const householdId = `hh-t045w-${randomUUID()}`;
  const accountId = `acc-t045w-${randomUUID()}`;
  const profileId = `prof-t045w-${randomUUID()}`;
  const deviceId = `dev-t045w-${randomUUID()}`;
  const deviceSessionId = `dsess-t045w-${randomUUID()}`;
  const sourceId = `src-t045w-${randomUUID()}`;
  const parentMediaId = `media-parent-t045w-${randomUUID()}`;
  const episodeMediaId = `media-ep-t045w-${randomUUID()}`;
  const titleId = `vtitle-t045w-${randomUUID()}`;
  const lineId = `vline-t045w-${randomUUID()}`;
  const episodeId = `vep-t045w-${randomUUID()}`;
  const sourceEntryId = `entry-t045w-${randomUUID()}`;
  const playbackSourceId = `psrc-t045w-${randomUUID()}`;
  conn.transaction(() => {
    conn.prepare('INSERT INTO household (id, name, created_at) VALUES (?, ?, ?)').run(householdId, 'T045 watchdog 家庭', now);
    conn
      .prepare(
        'INSERT INTO account (id, household_id, username, username_normalized, password_hash, role, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
      )
      .run(accountId, householdId, 'admin', 'admin', 'hash', 'admin', now);
    conn
      .prepare(
        "INSERT INTO profile (id, household_id, account_id, name, type, is_default, status, created_at) VALUES (?, ?, ?, '主档案', 'adult', 1, 'active', ?)",
      )
      .run(profileId, householdId, accountId, now);
    conn.prepare("INSERT INTO device (id, household_id, type, created_at) VALUES (?, ?, 'web', ?)").run(deviceId, householdId, now);
    conn
      .prepare(
        'INSERT INTO device_session (id, household_id, account_id, device_id, token_hash, active_profile_id, expires_at, last_active_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
      )
      .run(
        deviceSessionId,
        householdId,
        accountId,
        deviceId,
        `token-hash-${deviceSessionId}`,
        profileId,
        // 授权实时重验以真实墙钟判过期(verifyTrustedSession):签发须为真实未来,
        // 与 ManualClock 虚拟域(会话 created_at/期限锚点)互不干扰
        iso(Date.now() + 7 * 24 * 3600_000),
        now,
        now,
      );
    conn
      .prepare(
        "INSERT INTO profile_policy (household_id, profile_id, max_content_level, allow_unrated, allowed_media_ids, blocked_media_ids, allowed_channel_ids, version, updated_at) VALUES (?, ?, 18, 1, '[]', '[]', '[]', 1, ?)",
      )
      .run(householdId, profileId, now);
    conn
      .prepare(
        "INSERT INTO media_source (id, household_id, kind, name, remote_url, enabled, version, locator_revision, created_at, updated_at) VALUES (?, ?, 'vod', 'T045 夹具来源', 'https://upstream.fixture/api.php', 1, 1, 1, ?, ?)",
      )
      .run(sourceId, householdId, now, now);
    conn.prepare("INSERT INTO vod_source_config (household_id, source_id, adapter) VALUES (?, ?, 'apple-cms-json')").run(householdId, sourceId);
    conn
      .prepare(
        "INSERT INTO media_item (id, household_id, type, title, version, media_role, created_at, updated_at) VALUES (?, ?, 'series', 'T045 剧集', 1, 'vod_title', ?, ?)",
      )
      .run(parentMediaId, householdId, now, now);
    conn
      .prepare(
        "INSERT INTO media_item (id, household_id, type, title, version, media_role, created_at, updated_at) VALUES (?, ?, 'episode', '第01集', 1, 'vod_episode', ?, ?)",
      )
      .run(episodeMediaId, householdId, now, now);
    conn
      .prepare(
        'INSERT INTO vod_title (id, household_id, source_id, upstream_vod_id, parent_media_id, current_detail_revision, materialized_at) VALUES (?, ?, ?, ?, ?, 1, ?)',
      )
      .run(titleId, householdId, sourceId, 'up-100', parentMediaId, now);
    conn
      .prepare('INSERT INTO vod_line (id, household_id, title_id, line_key, display_name, sort_order) VALUES (?, ?, ?, ?, ?, 1)')
      .run(lineId, householdId, titleId, 'main', '主线');
    conn
      .prepare(
        "INSERT INTO vod_episode (id, household_id, line_id, episode_key, label, media_id, content_version_state) VALUES (?, ?, ?, 'ep-01', '第01集', ?, 'unverified')",
      )
      .run(episodeId, householdId, lineId, episodeMediaId);
    conn
      .prepare(
        "INSERT INTO source_entry (id, household_id, source_id, identity_kind, identity_digest, media_id, present, first_seen_at, last_seen_at) VALUES (?, ?, ?, 'vod_episode', ?, ?, 1, ?, ?)",
      )
      .run(sourceEntryId, householdId, sourceId, 'a'.repeat(64), episodeMediaId, now, now);
    conn
      .prepare(
        "INSERT INTO playback_source (id, household_id, source_id, source_entry_id, media_item_id, protocol, location, priority, requires_proxy, locator_kind, vod_episode_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 'hls', NULL, 100, 0, 'online', ?, ?, ?)",
      )
      .run(playbackSourceId, householdId, sourceId, sourceEntryId, episodeMediaId, episodeId, now, now);
  })();
  return {
    householdId,
    accountId,
    profileId,
    deviceId,
    deviceSessionId,
    sourceId,
    parentMediaId,
    episodeMediaId,
    titleId,
    lineId,
    episodeId,
    sourceEntryId,
    playbackSourceId,
  };
}

/** 播放会话行直插(与 vod-input-binding.spec insertPlaybackSession 同形;generation/version=1) */
function insertPlaybackSession(
  conn: typeof Database.db,
  seed: RigSeed,
  input: {
    sessionId: string;
    atMs: number;
    state?: 'preparing' | 'ready' | 'playing' | 'paused' | 'failed' | 'interrupted' | 'ended';
    delivery?: string | null;
    startedAtMs?: number | null;
    playbackStartedAtMs?: number | null;
    lastHeartbeatAtMs?: number;
  },
): string {
  const state = input.state ?? 'ready';
  const delivery = input.delivery !== undefined ? input.delivery : state === 'preparing' ? null : 'direct';
  conn
    .prepare(
      `INSERT INTO playback_session (
        id, household_id, device_session_id, device_id, profile_id, media_id,
        playback_source_id, state, delivery, generation, version,
        position_seconds, audio_track_id, subtitle_track_id, desired_paused,
        profile_context_version, playback_started_at, cleanup_requested, cleanup_reason, cleanup_state,
        created_at, started_at, ended_at, last_heartbeat_at, failure_code
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 1, 0, NULL, NULL, 0, 1, ?, 0, NULL, 'pending', ?, ?, ?, ?, ?)`,
    )
    .run(
      input.sessionId,
      seed.householdId,
      seed.deviceSessionId,
      seed.deviceId,
      seed.profileId,
      seed.episodeMediaId,
      state === 'preparing' ? null : seed.playbackSourceId,
      state,
      delivery,
      input.playbackStartedAtMs === undefined || input.playbackStartedAtMs === null
        ? null
        : iso(input.playbackStartedAtMs),
      iso(input.atMs),
      input.startedAtMs ?? null,
      // 终态 CHECK:ended_at 必设(interrupted/failed)
      state === 'failed' || state === 'interrupted' || state === 'ended' ? iso(input.atMs) : null,
      iso(input.lastHeartbeatAtMs ?? input.atMs),
      state === 'failed' ? 'PLAYBACK_FORMAT_UNSUPPORTED' : null,
    );
  return input.sessionId;
}

/** 固定输入绑定行直插(与 store insertBinding 同形;frozen NULL 直到 probe) */
function insertBinding(
  conn: typeof Database.db,
  seed: RigSeed,
  input: { sessionId: string; generation: number; resolvedInputId: string; atMs: number },
): void {
  conn
    .prepare(
      `INSERT INTO playback_input_binding (
        id, household_id, session_id, generation, playback_source_id, source_id,
        locator_revision, detail_revision, content_revision, continuity_revision,
        evidence_state, evidence_digest, resolved_input_id, resolved_at, expires_at,
        start_basis, frozen_start_seconds, frozen_at, cleanup_state
      ) VALUES (?, ?, ?, ?, ?, ?, 1, 1, 1, NULL, 'unverified', ?, ?, ?, ?, 'beginning', NULL, NULL, 'pending')`,
    )
    .run(
      `bind-${input.sessionId}-g${input.generation}`,
      seed.householdId,
      input.sessionId,
      input.generation,
      seed.playbackSourceId,
      seed.sourceId,
      'b'.repeat(64),
      input.resolvedInputId,
      iso(input.atMs),
      iso(input.atMs + 24 * 3600_000),
    );
}

/** T057 observation 写入缝表达:合格 playing 观测设置独立起播标记(仅首次,NULL → 值) */
function setPlaybackStartedAt(sessionId: string, startedAtMs: number): void {
  Database.db
    .prepare('UPDATE playback_session SET playback_started_at = ? WHERE id = ? AND playback_started_at IS NULL')
    .run(iso(startedAtMs), sessionId);
}

function touchHeartbeat(sessionId: string, atMs: number): void {
  Database.db.prepare('UPDATE playback_session SET last_heartbeat_at = ? WHERE id = ?').run(iso(atMs), sessionId);
}

interface SessionRowRead {
  state: string;
  generation: number;
  version: number;
  position_seconds: number;
  playback_started_at: string | null;
  cleanup_requested: number;
  ended_at: string | null;
  last_heartbeat_at: string;
  failure_code: string | null;
}

function sessionRow(sessionId: string): SessionRowRead {
  return Database.db
    .prepare(
      `SELECT state, generation, version, position_seconds, playback_started_at,
              cleanup_requested, ended_at, last_heartbeat_at, failure_code
       FROM playback_session WHERE id = ?`,
    )
    .get(sessionId) as SessionRowRead;
}

interface BindingRowRead {
  generation: number;
  resolved_input_id: string;
  cleanup_requested: number;
  cleanup_state: string;
}

function bindingRows(sessionId: string): BindingRowRead[] {
  return Database.db
    .prepare(
      `SELECT generation, resolved_input_id, cleanup_requested, cleanup_state
       FROM playback_input_binding WHERE session_id = ? ORDER BY generation ASC`,
    )
    .all(sessionId) as BindingRowRead[];
}

/** 可信 probe 事实端口 fake(时长权威;durationSeconds=null 表达直播/事实缺失 → none) */
function fakeFactsPort(durationSeconds: number | null): PlaybackTrackFactsPort {
  return {
    factsFor: () =>
      durationSeconds === null
        ? undefined
        : {
            durationSeconds,
            audioTracks: [{ id: 'aud-1', label: '', language: null, default: true }],
            subtitleTracks: [{ id: 'sub-1', label: '', language: null }],
          },
  };
}

/** I4 起播标记只读投影 fake(与装配 SessionPlaybackStartFactsReader 同判:非空即已起播) */
function fakeStartFactsPort(householdId: string): PlaybackStartFactsPort {
  const statement = () =>
    Database.db.prepare('SELECT playback_started_at AS startedAt FROM playback_session WHERE household_id = ? AND id = ?');
  return {
    playbackStarted: (_h, sessionId) => {
      const row = statement().get(householdId, sessionId) as { startedAt: string | null } | undefined;
      return typeof row?.startedAt === 'string' && row.startedAt.length > 0;
    },
  };
}

/** lifecycle 心跳重验桥 fake(与装配 LifecycleVodInputGuard 同构:绑定回读 × store 判定) */
function buildVodInputGuard(vodInput: VodInputStore): PlaybackVodInputGuardPort {
  interface BindingRead {
    locator_revision: number;
    detail_revision: number | null;
    content_revision: number;
    continuity_revision: number | null;
  }
  const readBinding = (householdId: string, sessionId: string, generation: number): BindingRead | undefined =>
    Database.db
      .prepare(
        `SELECT locator_revision, detail_revision, content_revision, continuity_revision
         FROM playback_input_binding WHERE household_id = ? AND session_id = ? AND generation = ?`,
      )
      .get(householdId, sessionId, generation) as BindingRead | undefined;
  return {
    hasCurrentBinding: (householdId, sessionId, generation) => readBinding(householdId, sessionId, generation) !== undefined,
    assertCurrent: (householdId, sessionId, generation) => {
      const binding = readBinding(householdId, sessionId, generation);
      if (binding === undefined) {
        throw new Error('guard 契约:hasCurrentBinding 已先行判定');
      }
      vodInput.assertFixedInputCurrent({
        householdId,
        sessionId,
        generation,
        expected: {
          locatorRevision: binding.locator_revision,
          detailRevision: binding.detail_revision,
          contentRevision: binding.content_revision,
          continuityRevision: binding.continuity_revision,
        },
      });
    },
    failOnRevisionMismatch: (householdId, sessionId, generation, reason) => {
      vodInput.failSessionOnRevisionMismatch({ householdId, sessionId, generation, reason });
    },
  };
}

const lifecycleStorageFake: LifecycleStoragePort = {
  releaseSession: async () => undefined,
  releaseTask: async () => undefined,
  pendingCleanupTasks: () => [],
};

function openRig(): WatchdogRig {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hmp-vod-watchdog-'));
  openRigs.push({ dataDir });
  setEnvOverride(
    loadEnv({
      NODE_ENV: 'test',
      DATA_DIR: dataDir,
      DB_FILENAME: `${randomUUID()}.hmp.db`,
    }),
  );
  Database.close();
  Database.db.exec('CREATE TABLE IF NOT EXISTS _migrations (name TEXT PRIMARY KEY NOT NULL, applied_at TEXT NOT NULL)');
  for (const name of ['0001_init', '0002_profile_policy', '0003_media_catalog', '0004_manual_epg_binding', '0005_playback', '0006_pc_experience', '0007_online_vod', '0008_profile_preferences', '0009_channel_logos', '0010_multi_source_priority', '0011_channel_visibility', '0012_programme_posters', '0013_source_governance']) {
    Database.db.transaction(() => {
      Database.db.exec(migrationSql(name));
      Database.db.prepare('INSERT INTO _migrations (name, applied_at) VALUES (?, ?)').run(name, new Date().toISOString());
    })();
  }
  const budgets = createPlaybackBudgets(loadEnv({ NODE_ENV: 'test' }));
  const clock = createManualClock({ startMs: MANUAL_CLOCK_DEFAULT_START_MS });
  const t0 = clock.now();
  const seed = seedVodWorld(Database.db, t0);
  const repository = new PlaybackRepository(Database.db, budgets);
  const vodInput = drizzleVodInputStore({ handle: Database.db, nowMs: () => clock.now() });
  const selection = new PlaybackSelectionService({
    repository,
    authorization: new PlaybackAuthorizationService(repository),
    facts: fakeFactsPort(3600),
    vodInput,
    startFacts: fakeStartFactsPort(seed.householdId),
    budgets,
  });
  const lifecycle = new PlaybackLifecycleService({
    repository,
    authorization: new PlaybackAuthorizationService(repository),
    supervisor: { cancel: async () => undefined },
    storage: lifecycleStorageFake,
    budgets,
    clock,
    vodInputGuard: buildVodInputGuard(vodInput),
  });
  const deviceSessionRow = Database.db
    .prepare('SELECT id, household_id, account_id, device_id, active_profile_id, expires_at FROM device_session WHERE id = ?')
    .get(seed.deviceSessionId) as {
    id: string;
    household_id: string;
    account_id: string;
    device_id: string;
    active_profile_id: string;
    expires_at: string;
  };
  const accountRow = Database.db.prepare('SELECT id, household_id, username, role FROM account WHERE id = ?').get(seed.accountId) as {
    id: string;
    household_id: string;
    username: string;
    role: string;
  };
  const context: SessionContext = {
    session: {
      id: deviceSessionRow.id,
      householdId: deviceSessionRow.household_id,
      accountId: deviceSessionRow.account_id,
      deviceId: deviceSessionRow.device_id,
      activeProfileId: deviceSessionRow.active_profile_id,
      expiresAt: deviceSessionRow.expires_at,
    },
    account: {
      id: accountRow.id,
      householdId: accountRow.household_id,
      username: accountRow.username,
      role: accountRow.role as SessionContext['account']['role'],
    },
  };
  return { dataDir, budgets, clock, t0, seed, repository, vodInput, selection, lifecycle, context };
}

function cleanupRigs(): void {
  while (openRigs.length > 0) {
    const rig = openRigs.pop();
    if (rig !== undefined) {
      Database.close();
      fs.rmSync(rig.dataDir, { recursive: true, force: true });
    }
  }
}

/** 个人 ledger 行直插(0006;seq 游标断言用 —— 「seq 不归零」) */
function seedLedger(rig: WatchdogRig, sessionId: string, lastSampleSeq: number, lastGeneration: number): void {
  Database.db
    .prepare(
      `INSERT INTO playback_progress_state (
        household_id, playback_session_id, profile_id, media_id, candidate_epoch,
        content_revision, profile_context_version, started, last_sample_seq,
        last_sample_digest, last_generation, last_result
      ) VALUES (?, ?, ?, ?, 3, 1, 1, 1, ?, 'digest-seeded', ?, NULL)`,
    )
    .run(rig.seed.householdId, sessionId, rig.seed.profileId, rig.seed.episodeMediaId, lastSampleSeq, lastGeneration);
}

interface LedgerRowRead {
  last_sample_seq: number;
  last_generation: number;
}

function ledgerRow(sessionId: string): LedgerRowRead {
  return Database.db
    .prepare('SELECT last_sample_seq, last_generation FROM playback_progress_state WHERE playback_session_id = ?')
    .get(sessionId) as LedgerRowRead;
}

/* ------------------------------------------------------------------ */
/* 1. 60s 回收全矩阵 + 节拍链                                            */
/* ------------------------------------------------------------------ */

describe('T045 未起播 ready 会话 60s 固定期限回收(服务级矩阵)', () => {
  afterEach(cleanupRigs);

  it('未起播回收:期限未满不入清单,恰满 60s 回收为 interrupted 终态且不可复活;二次清理由输家收口', async () => {
    const rig = openRig();
    const retention = new PlaybackRetentionService({ budgets: rig.budgets, clock: rig.clock, vodInput: rig.vodInput });
    const sessionId = insertPlaybackSession(Database.db, rig.seed, { sessionId: 'sess-w1', atMs: rig.t0 });

    await rig.clock.advance(UNSTARTED_READY_RECLAIM_MS - 1_000);
    expect((await rig.vodInput.listReclaimableUnstartedReadySessions({ nowMs: rig.clock.now() })).map((r) => r.sessionId)).not.toContain(sessionId);
    expect(await retention.runUnstartedReadyReclaim(rig.clock.now()), '期限未满零回收').toEqual({ scanned: 0, reclaimed: 0 });

    await rig.clock.advance(1_000);
    const outcome = await retention.runUnstartedReadyReclaim(rig.clock.now());
    expect(outcome, '恰满 60s 由调度面回收').toEqual({ scanned: 1, reclaimed: 1 });
    const row = sessionRow(sessionId);
    expect(row.state).toBe('interrupted');
    expect(row.ended_at).not.toBeNull();
    // 终态不可复活:后到 playing 标记与二次扫描均不改变终态事实
    setPlaybackStartedAt(sessionId, rig.clock.now());
    expect(sessionRow(sessionId).state).toBe('interrupted');
    expect(await retention.runUnstartedReadyReclaim(rig.clock.now()), '终态不入清单,重复回收幂等').toEqual({ scanned: 0, reclaimed: 0 });
  });

  it('heartbeat 不续命:期限窗口内推进心跳不把会话移出回收清单(data-model §9)', async () => {
    const rig = openRig();
    const retention = new PlaybackRetentionService({ budgets: rig.budgets, clock: rig.clock, vodInput: rig.vodInput });
    const sessionId = insertPlaybackSession(Database.db, rig.seed, { sessionId: 'sess-w2', atMs: rig.t0 });
    await rig.clock.advance(30_000);
    touchHeartbeat(sessionId, rig.clock.now());
    await rig.clock.advance(UNSTARTED_READY_RECLAIM_MS - 30_000);
    const listed = (await rig.vodInput.listReclaimableUnstartedReadySessions({ nowMs: rig.clock.now() })).map((r) => r.sessionId);
    expect(listed, 'heartbeat 不得为未起播会话续命').toContain(sessionId);
    expect((await retention.runUnstartedReadyReclaim(rig.clock.now())).reclaimed).toBe(1);
    expect(sessionRow(sessionId).state).toBe('interrupted');
  });

  it('playing 解除后保留 vs 无 playing 对照仍回收:同一批会话分化,已起播行不被触达', async () => {
    const rig = openRig();
    const retention = new PlaybackRetentionService({ budgets: rig.budgets, clock: rig.clock, vodInput: rig.vodInput });
    const withPlaying = insertPlaybackSession(Database.db, rig.seed, { sessionId: 'sess-w3-playing', atMs: rig.t0 });
    const withoutPlaying = insertPlaybackSession(Database.db, rig.seed, { sessionId: 'sess-w3-idle', atMs: rig.t0 });
    setPlaybackStartedAt(withPlaying, rig.t0 + 5_000);

    await rig.clock.advance(UNSTARTED_READY_RECLAIM_MS + 1_000);
    const listed = (await rig.vodInput.listReclaimableUnstartedReadySessions({ nowMs: rig.clock.now() })).map((r) => r.sessionId);
    expect(listed, '合格 playing 已解除期限').not.toContain(withPlaying);
    expect(listed, '无 playing 仍按固定期限回收').toContain(withoutPlaying);
    expect((await retention.runUnstartedReadyReclaim(rig.clock.now())).reclaimed).toBe(1);
    expect(sessionRow(withPlaying).state, '已起播会话不得被未起播期限触达').toBe('ready');
    expect(sessionRow(withoutPlaying).state).toBe('interrupted');
  });

  it('暂停不重新开启 60s 期限(api §7 I4):已起播 paused 会话超期不入清单', async () => {
    const rig = openRig();
    const retention = new PlaybackRetentionService({ budgets: rig.budgets, clock: rig.clock, vodInput: rig.vodInput });
    const sessionId = insertPlaybackSession(Database.db, rig.seed, {
      sessionId: 'sess-w4',
      atMs: rig.t0,
      state: 'paused',
      playbackStartedAtMs: rig.t0 + 5_000,
    });
    await rig.clock.advance(2 * UNSTARTED_READY_RECLAIM_MS);
    const outcome = await retention.runUnstartedReadyReclaim(rig.clock.now());
    expect(outcome, '暂停不重开未起播期限,也不得回收已起播会话').toEqual({ scanned: 0, reclaimed: 0 });
    expect(sessionRow(sessionId).state).toBe('paused');
  });

  it('两 watcher CAS:调度面回收与并发原语回收恰一赢家,输家零写入不复活终态', async () => {
    const rig = openRig();
    const retention = new PlaybackRetentionService({ budgets: rig.budgets, clock: rig.clock, vodInput: rig.vodInput });
    const sessionId = insertPlaybackSession(Database.db, rig.seed, {
      sessionId: 'sess-w5',
      atMs: rig.t0 - UNSTARTED_READY_RECLAIM_MS - 1_000,
    });
    // watcher A(持久原语)与 watcher B(调度面)基于同一过期观察先后回收
    const watcherA = await rig.vodInput.reclaimExpiredUnstartedReadySession({
      householdId: rig.seed.householdId,
      sessionId,
      nowMs: rig.clock.now(),
    });
    const watcherB = await retention.runUnstartedReadyReclaim(rig.clock.now());
    const directLoser = await rig.vodInput.reclaimExpiredUnstartedReadySession({
      householdId: rig.seed.householdId,
      sessionId,
      nowMs: rig.clock.now(),
    });
    expect(watcherA.reclaimed, '原语回收恰一赢家').toBe(true);
    expect(watcherB, '调度面观察到终态后零清单零回收').toEqual({ scanned: 0, reclaimed: 0 });
    expect(directLoser.reclaimed, '输家 reclaimed=false 而非覆盖').toBe(false);
    const winnerEndedAt = sessionRow(sessionId).ended_at;
    await rig.clock.advance(5_000);
    await rig.vodInput.reclaimExpiredUnstartedReadySession({ householdId: rig.seed.householdId, sessionId, nowMs: rig.clock.now() });
    expect(sessionRow(sessionId).ended_at, '输家不得改写终态事实(ended_at 以先到者为准)').toBe(winnerEndedAt);
    expect(sessionRow(sessionId).state).toBe('interrupted');
  });

  it('节拍链:start() 后由 watchdog 固定节拍驱动回收;stopTimers 停转', async () => {
    const rig = openRig();
    const retention = new PlaybackRetentionService({ budgets: rig.budgets, clock: rig.clock, vodInput: rig.vodInput });
    const sessionId = insertPlaybackSession(Database.db, rig.seed, { sessionId: 'sess-w6', atMs: rig.t0 });
    retention.start();
    // setImmediate 让渡:每拍唤醒后的回收续链(多级微任务)排空、循环重新登记下一拍 delay
    // 后再推进下一拍(ManualClock 单次 advance 只处理「已登记」到期定时器,与真实定时器
    // 的逐拍推进语义一致;链式续拍必须逐拍推进)
    const drain = (): Promise<void> => new Promise<void>((resolve) => {
      setImmediate(resolve);
    });
    for (let tick = 0; tick < 4; tick += 1) {
      await rig.clock.advance(WATCHDOG_INTERVAL_MS);
      await drain();
    }
    await rig.clock.advance(1_000);
    await drain();
    expect(sessionRow(sessionId).state, '4 拍(60s)由节拍链回收为终态').toBe('interrupted');
    retention.stopTimers();
    const late = insertPlaybackSession(Database.db, rig.seed, { sessionId: 'sess-w6-late', atMs: rig.clock.now() });
    for (let tick = 0; tick < 10; tick += 1) {
      await rig.clock.advance(WATCHDOG_INTERVAL_MS);
      await drain();
    }
    expect(sessionRow(late).state, '停转后不再扫描').toBe('ready');
  });

  it('端口缺位 no-op:未装配 vodInput 的既有形态零行为变化', async () => {
    const rig = openRig();
    const retention = new PlaybackRetentionService({ budgets: rig.budgets, clock: rig.clock });
    const sessionId = insertPlaybackSession(Database.db, rig.seed, {
      sessionId: 'sess-w7',
      atMs: rig.t0 - UNSTARTED_READY_RECLAIM_MS - 1_000,
    });
    expect(await retention.runUnstartedReadyReclaim(rig.clock.now())).toEqual({ scanned: 0, reclaimed: 0 });
    expect(sessionRow(sessionId).state, '缺位形态不回收(既有行为零变化)').toBe('ready');
  });
});

/* ------------------------------------------------------------------ */
/* 2. seek 换代 CAS 流(store 换绑权威)                                  */
/* ------------------------------------------------------------------ */

describe('T045 seek 换代 CAS 流(同 input 新绑定 + 旧代撤销 + 失败语义)', () => {
  afterEach(cleanupRigs);

  it('vod 会话 seek:store 换代 CAS 权威 —— generation/version 各 +1,新绑定同 resolved_input_id,旧代撤销,位置落目标', async () => {
    const rig = openRig();
    const sessionId = insertPlaybackSession(Database.db, rig.seed, { sessionId: 'sess-s1', atMs: rig.t0, delivery: 'direct' });
    insertBinding(Database.db, rig.seed, { sessionId, generation: 1, resolvedInputId: 'resolved-input-s1', atMs: rig.t0 });
    seedLedger(rig, sessionId, 7, 1);

    const outcome = await rig.selection.seek(sessionId, { expectedVersion: 1, positionSeconds: 100 }, rig.context);
    const row = sessionRow(sessionId);
    expect(row.generation, '代次 CAS 推进恰 +1').toBe(2);
    expect(row.version).toBe(2);
    expect(row.state, '同 input 换代无重回准备窗口:会话保持活动态').toBe('ready');
    expect(row.position_seconds, '位置面以 heartbeat 通道落目标').toBe(100);
    const bindings = bindingRows(sessionId);
    expect(bindings).toHaveLength(2);
    expect(bindings[0], '旧代撤销与新绑定同事务').toMatchObject({ generation: 1, resolved_input_id: 'resolved-input-s1', cleanup_requested: 1, cleanup_state: 'pending' });
    expect(bindings[1], '新代沿用输入,不暗换最新地址').toMatchObject({ generation: 2, resolved_input_id: 'resolved-input-s1', cleanup_requested: 0 });
    expect(outcome.session.generation).toBe(2);
    expect(outcome.dto.generation).toBe(2);
    expect(ledgerRow(sessionId), '换代不触碰个人 ledger(seq 不归零)').toEqual({ last_sample_seq: 7, last_generation: 1 });
    // I4 事实面:session 级起播事实跨 generation 保留
    setPlaybackStartedAt(sessionId, rig.clock.now());
    const second = await rig.selection.seek(sessionId, { expectedVersion: 2, positionSeconds: 200 }, rig.context);
    expect(second.session.generation).toBe(3);
    await expect(rig.selection.sessionSeekFacts(rig.seed.householdId, sessionId)).resolves.toMatchObject({
      seekCapability: 'server_rebuild',
      playbackStarted: true,
    });
  });

  it('失败前无变化:陈旧 expectedVersion 拒绝后会话行与绑定面零持久变化', async () => {
    const rig = openRig();
    const sessionId = insertPlaybackSession(Database.db, rig.seed, { sessionId: 'sess-s2', atMs: rig.t0, delivery: 'direct' });
    insertBinding(Database.db, rig.seed, { sessionId, generation: 1, resolvedInputId: 'resolved-input-s2', atMs: rig.t0 });
    const beforeSession = sessionRow(sessionId);
    const beforeBindings = JSON.stringify(bindingRows(sessionId));

    let thrown: unknown;
    try {
      await rig.selection.seek(sessionId, { expectedVersion: 99, positionSeconds: 10 }, rig.context);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(DomainError);
    expect((thrown as DomainError).status).toBe(409);
    const afterSession = sessionRow(sessionId);
    expect(afterSession, 'CAS 失败零写入(generation/version/state/position)').toEqual(beforeSession);
    expect(JSON.stringify(bindingRows(sessionId)), '绑定面零写入(旧代不被撤销)').toBe(beforeBindings);
  });

  it('失败后新代 failed 不倒退:终态会话 seek 被预检守卫拒绝,failed 事实不被改写', async () => {
    const rig = openRig();
    const sessionId = insertPlaybackSession(Database.db, rig.seed, {
      sessionId: 'sess-s3',
      atMs: rig.t0,
      state: 'failed',
      delivery: 'direct',
    });
    insertBinding(Database.db, rig.seed, { sessionId, generation: 1, resolvedInputId: 'resolved-input-s3', atMs: rig.t0 });
    const beforeSession = sessionRow(sessionId);
    const beforeBindings = JSON.stringify(bindingRows(sessionId));

    let thrown: unknown;
    try {
      await rig.selection.seek(sessionId, { expectedVersion: 1, positionSeconds: 10 }, rig.context);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(DomainError);
    expect((thrown as DomainError).status, '终态守卫:failed → PLAYBACK_NOT_READY').toBe(409);
    expect(sessionRow(sessionId), 'failed 会话零改写(不倒退)').toEqual(beforeSession);
    expect(JSON.stringify(bindingRows(sessionId))).toBe(beforeBindings);
  });

  it('NAS 无绑定会话回退既有 beginRebuild 路径(零变化):preparing + generation/version 各 +1', async () => {
    const rig = openRig();
    const sessionId = insertPlaybackSession(Database.db, rig.seed, { sessionId: 'sess-s4', atMs: rig.t0, delivery: 'direct' });

    const outcome = await rig.selection.seek(sessionId, { expectedVersion: 1, positionSeconds: 90 }, rig.context);
    const row = sessionRow(sessionId);
    expect(row.state, '既有路径:preparing 窗口').toBe('preparing');
    expect(row.generation).toBe(2);
    expect(row.version).toBe(2);
    expect(row.position_seconds).toBe(90);
    expect(bindingRows(sessionId), '无绑定 = NAS 语义,零绑定写面').toHaveLength(0);
    expect(outcome.dto.state).toBe('preparing');
  });
});

/* ------------------------------------------------------------------ */
/* 3. 旧 NAS/直播回收回归                                                */
/* ------------------------------------------------------------------ */

describe('T045 回收判定回归(会话行通用语义;不要求绑定存在)', () => {
  afterEach(cleanupRigs);

  it('NAS(direct)与在线代理(hls_proxy)未起播 ready 会话同被固定期限回收;playing 会话保留', async () => {
    const rig = openRig();
    const retention = new PlaybackRetentionService({ budgets: rig.budgets, clock: rig.clock, vodInput: rig.vodInput });
    const nas = insertPlaybackSession(Database.db, rig.seed, {
      sessionId: 'sess-r1-nas',
      atMs: rig.t0 - UNSTARTED_READY_RECLAIM_MS - 1_000,
      delivery: 'direct',
    });
    const proxy = insertPlaybackSession(Database.db, rig.seed, {
      sessionId: 'sess-r1-proxy',
      atMs: rig.t0 - UNSTARTED_READY_RECLAIM_MS - 1_000,
      delivery: 'hls_proxy',
    });
    const playing = insertPlaybackSession(Database.db, rig.seed, {
      sessionId: 'sess-r1-playing',
      atMs: rig.t0 - UNSTARTED_READY_RECLAIM_MS - 1_000,
      delivery: 'direct',
      playbackStartedAtMs: rig.t0 - 500,
    });
    const outcome = await retention.runUnstartedReadyReclaim(rig.clock.now());
    expect(outcome.scanned).toBe(2);
    expect(outcome.reclaimed).toBe(2);
    expect(sessionRow(nas).state, 'NAS 未起播回收回归(005 interrupted 约定)').toBe('interrupted');
    expect(sessionRow(proxy).state).toBe('interrupted');
    expect(sessionRow(playing).state, '已起播超 60s 保留(沿用失联/回收既有规则)').toBe('ready');
  });
});

/* ------------------------------------------------------------------ */
/* 4. lifecycle 心跳重验(T043 建议 assertCurrent 接线)                   */
/* ------------------------------------------------------------------ */

describe('T045 vod 心跳重验(修订失配终止;NAS 零变化)', () => {
  afterEach(cleanupRigs);

  it('绑定修订漂移:心跳前重验失配 → 撤交付 + failed 同提交,心跳被拒不再续命', async () => {
    const rig = openRig();
    const sessionId = insertPlaybackSession(Database.db, rig.seed, { sessionId: 'sess-h1', atMs: rig.t0, delivery: 'direct' });
    insertBinding(Database.db, rig.seed, { sessionId, generation: 1, resolvedInputId: 'resolved-input-h1', atMs: rig.t0 });
    // 工厂事实(DB 直改注明):content 修订推进
    Database.db.prepare('UPDATE media_item SET content_revision = 2 WHERE id = ?').run(rig.seed.episodeMediaId);

    const result = rig.lifecycle.heartbeat(sessionId, { positionSeconds: 30 });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe('PLAYBACK_RESOURCE_UNAVAILABLE');
    }
    const row = sessionRow(sessionId);
    expect(row.state, 'data-model §3:失配准备转 failed,需新 resolve').toBe('failed');
    expect(row.failure_code).toBe('MEDIA_VERSION_CONFLICT');
    expect(bindingRows(sessionId)[0]).toMatchObject({ generation: 1, cleanup_requested: 1, cleanup_state: 'pending' });
  });

  it('无漂移放行:心跳照常写 last_heartbeat_at/position(不递增 version/generation,不构成续命)', async () => {
    const rig = openRig();
    const sessionId = insertPlaybackSession(Database.db, rig.seed, { sessionId: 'sess-h2', atMs: rig.t0, delivery: 'direct' });
    insertBinding(Database.db, rig.seed, { sessionId, generation: 1, resolvedInputId: 'resolved-input-h2', atMs: rig.t0 });

    const result = rig.lifecycle.heartbeat(sessionId, { positionSeconds: 42, at: iso(rig.t0 + 15_000) });
    expect(result.ok).toBe(true);
    const row = sessionRow(sessionId);
    expect(row.state).toBe('ready');
    expect(row.version).toBe(1);
    expect(row.generation).toBe(1);
    expect(row.position_seconds).toBe(42);
    expect(Date.parse(row.last_heartbeat_at)).toBe(rig.t0 + 15_000);
    // 未起播期限锚点为 created_at:心跳推进后恰满 60s 仍进回收清单(heartbeat 不续命)
    await rig.clock.advance(UNSTARTED_READY_RECLAIM_MS);
    expect(
      (await rig.vodInput.listReclaimableUnstartedReadySessions({ nowMs: rig.clock.now() })).map((r) => r.sessionId),
      '心跳后固定期限照常生效',
    ).toContain(sessionId);
  });

  it('NAS 无绑定会话跳过重验:目录漂移不影响心跳(既有行为零变化)', async () => {
    const rig = openRig();
    const sessionId = insertPlaybackSession(Database.db, rig.seed, { sessionId: 'sess-h3', atMs: rig.t0, delivery: 'direct' });
    Database.db.prepare('UPDATE media_item SET content_revision = 2 WHERE id = ?').run(rig.seed.episodeMediaId);

    const result = rig.lifecycle.heartbeat(sessionId, { positionSeconds: 5, at: iso(rig.t0 + 1_000) });
    expect(result.ok, '无绑定 = 非 vod 会话:守卫门跳过').toBe(true);
    expect(sessionRow(sessionId).state).toBe('ready');
  });
});

/* ------------------------------------------------------------------ */
/* 5. I4 事实面(seekCapability / playbackStarted)                       */
/* ------------------------------------------------------------------ */

describe('T045 I4 事实面(sessionSeekFacts;DTO 输出归 T046)', () => {
  afterEach(cleanupRigs);

  it('hls_proxy VOD ready:client + 未起播 false;playing 观测后 true', async () => {
    const rig = openRig();
    const sessionId = insertPlaybackSession(Database.db, rig.seed, {
      sessionId: 'sess-i1',
      atMs: rig.t0,
      delivery: 'hls_proxy',
    });
    expect(await rig.selection.sessionSeekFacts(rig.seed.householdId, sessionId)).toEqual({
      seekCapability: 'client',
      playbackStarted: false,
    });
    setPlaybackStartedAt(sessionId, rig.t0 + 5_000);
    expect(await rig.selection.sessionSeekFacts(rig.seed.householdId, sessionId)).toEqual({
      seekCapability: 'client',
      playbackStarted: true,
    });
  });

  it('direct 受支持交付 → server_rebuild;事实缺失/直播(duration null)→ none', async () => {
    const rig = openRig();
    const direct = insertPlaybackSession(Database.db, rig.seed, { sessionId: 'sess-i2', atMs: rig.t0, delivery: 'direct' });
    expect((await rig.selection.sessionSeekFacts(rig.seed.householdId, direct)).seekCapability).toBe('server_rebuild');
    const live = insertPlaybackSession(Database.db, rig.seed, { sessionId: 'sess-i3', atMs: rig.t0, delivery: 'hls_proxy' });
    const liveFacts = new PlaybackSelectionService({
      repository: rig.repository,
      authorization: new PlaybackAuthorizationService(rig.repository),
      facts: fakeFactsPort(null),
      budgets: rig.budgets,
    });
    expect((await liveFacts.sessionSeekFacts(rig.seed.householdId, live)).seekCapability, '直播为 none').toBe('none');
  });
});
