/**
 * 010-online-vod T081(US5)—— 保留/watchdog 系统性收口回归单测(真实 DDL,零网络)。
 *
 * 收口面(tasks.md T081 + data-model §9 逐条对照;实现 =
 * playback-retention.service.ts 节拍链 + playback-input-store.drizzle.ts 扫描原语 +
 * playback-transition-store.drizzle.ts 清理原语):
 * - 启动首拍三链:start() 零节拍等待覆盖「过渡清理扫描(内含失效 intent 翻转)→
 *   cleanup 持久标记补投空 stop → 未起播 ready 会话 60s 固定期限回收」(T062 首拍
 *   只挂前两链;I5「失败/重启扫描重试」);
 * - 节拍链覆盖顺序:每拍先授权面终止(补投 stop → ended,经生命周期端口结算资源)
 *   后期限兜底(reclaim → interrupted),cleanup 标记会话不被 reclaim 抢先;
 * - 双标记扫描覆盖:补投谓词(cleanup_requested=1 ∧ cleanup_state='pending' ∧ 活动态)
 *   与原因无关 —— transition_cleanup(T062/I5)与 finish_receipt(T058)标记同面收口;
 *   finish 同 commit 终态化的真实形态(ended+标记)不入补投、receipt 留 24h 保护窗;
 * - 24h 保护窗与引用图:窗内全存活;窗外按 FK 依赖序 slot→intent→未引用 receipt;
 *   受引用 receipt/nextPlan 与后继 session/绑定/ledger 行不在删除面(元数据 FK 保护);
 * - 受引用 nextPlan 保护:被 intent 引用按 intent 保留,ref 未解绑过期行保持 410
 *   可判别面,引用随 intent 删除解除后方按「ref 已解绑 ∧ 无引用 ∧ 过期」回收;
 * - 未起播期限语义:锚点 created_at(服务器 readyAt 持久锚,T038 钉面)、heartbeat
 *   刷新不续命、playback_started_at 解除、两 watcher CAS 恰一赢家输家零写入;
 * - 身份撤销即时拒绝:信任源管线(SessionGuard=全部播放路由入口含 heartbeat/renew)
 *   逐请求直读 revoked_at,撤销立即 401 SESSION_INVALID,无 TTL 缓存窗口。
 *
 * 夹具分层(与 retention.spec 同款全局单例库):独立临时 DATA_DIR + 全量权威迁移 DDL
 * (0001–0007,Database 单例 foreign_keys=ON 真实约束)+ 真实 drizzleTransitionStore /
 * drizzleVodInputStore / TransitionCleanupService / PlaybackRetentionService +
 * ManualClock。时间以 ManualClock 基准回溯/前推(60s 期限/24h 保护窗远大于执行时长,
 * 确定性成立);终止面以受控行为桩模拟生命周期发布端口的幂等 stop 语义(活动态落
 * ended、已终态零副作用)。零网络、零 mock HTTP。
 *
 * 权威依据:
 * - docs/specs/010-online-vod/data-model.md §7(已消费后继/引用保留)+ §9(保留与
 *   watchdog 细化全文)+ §10(cleanup_requested 持久标记/next_plan 引用保护);
 * - docs/specs/010-online-vod/contracts/api.md §7 I5(cleanup/失败重启扫描重试);
 * - apps/server/test/contract/online-vod-transition-revocation.e2e-spec.ts
 *   E2/F1/F2/G1/G2(HTTP 面行为契约;本 spec 为 retention 编排面的存储级镜像)。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type DatabaseConstructor from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import { ProblemCode } from '@hmp/shared';
import { Database } from '@platform/database/database';
import { DomainError } from '@platform/http-common/domain-error';
import { setEnvOverride } from '@platform/config/env';
import { loadEnv } from '@platform/config/env.schema';
import type { TransactionBinding, TransactionCredential } from '@platform/database/unit-of-work';
import { createPlaybackBudgets } from '@platform/config/playback-budgets';
import { createManualClock, MANUAL_CLOCK_DEFAULT_START_MS, type ManualClock } from '../../fixtures/clock';
import { validateSessionToken } from '@platform/http-common/session.guard';
import { hashToken } from '@contexts/identity-access';
import { PlaybackRetentionService } from '@contexts/playback/application/playback-retention.service';
import { bindPlaybackStore } from '@contexts/playback/application/playback-store.port';
import { drizzlePlaybackStore } from '@contexts/playback/infrastructure/playback-store.drizzle';
import {
  bindTransitionStore,
  type PlaybackTransitionStore,
} from '@contexts/playback/application/playback-transition-store.port';
import { drizzleTransitionStore } from '@contexts/playback/infrastructure/playback-transition-store.drizzle';
import {
  drizzleVodInputStore,
  markDeliveryCleanupRequested,
  type VodInputStore,
} from '@contexts/playback/infrastructure/playback-input-store.drizzle';
import { createPlaybackTxParticipants } from '@contexts/playback/infrastructure/transaction-participants';
import {
  TransitionCleanupService,
  type TransitionCleanupSweepOutcome,
  type TransitionCleanupTxPort,
  type TransitionEntitlementPort,
  type TransitionSessionTerminatorPort,
} from '@contexts/playback/application/transition-cleanup.service';

/* ------------------------------------------------------------------ */
/* rig:独立临时库(全局单例重开)+ 全量权威迁移 + 真实 store/服务            */
/* ------------------------------------------------------------------ */

interface RigSeed {
  readonly householdId: string;
  readonly accountId: string;
  readonly profileId: string;
  readonly deviceId: string;
  readonly deviceSessionId: string;
  readonly mediaSourceId: string;
  readonly sourceMediaId: string;
  readonly targetMediaId: string;
  readonly playbackSourceId: string;
}

interface Rig {
  readonly conn: DatabaseConstructor.Database;
  readonly store: PlaybackTransitionStore;
  readonly vodInput: VodInputStore;
  readonly cleanup: TransitionCleanupService;
  readonly retention: PlaybackRetentionService;
  readonly terminator: { readonly port: TransitionSessionTerminatorPort; readonly calls: string[] };
  readonly clock: ManualClock;
  readonly seed: RigSeed;
  readonly dataDir: string;
  readonly t0: number;
  seq: number;
}

const openRigs: Rig[] = [];

const MIGRATION_NAMES = [
  '0001_init',
  '0002_profile_policy',
  '0003_media_catalog',
  '0004_manual_epg_binding',
  '0005_playback',
  '0006_pc_experience',
  '0007_online_vod',
] as const;

/** UTC ISO-8601 毫秒 Z(与持久层时间文本同形态;字典序=时间序) */
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

/** 直插播放会话行(状态/CHECK/FK 全满足;可携起播标记与心跳时刻覆盖) */
function insertSessionRow(
  conn: DatabaseConstructor.Database,
  input: {
    readonly householdId: string;
    readonly deviceSessionId: string;
    readonly deviceId: string;
    readonly profileId: string;
    readonly mediaId: string;
    readonly playbackSourceId: string | null;
    readonly sessionId: string;
    readonly state: 'preparing' | 'ready' | 'playing' | 'paused' | 'ended';
    readonly at: string;
    readonly playbackStartedAtMs?: number;
    readonly lastHeartbeatAtMs?: number;
  },
): string {
  const ended = input.state === 'ended' ? input.at : null;
  // CHECK playback_session_source_delivery_check:无 playback_source 的会话 delivery 必为 NULL
  const delivery = input.playbackSourceId === null ? null : 'hls_proxy';
  conn
    .prepare(
      `INSERT INTO playback_session (
        id, household_id, device_session_id, device_id, profile_id, media_id,
        playback_source_id, state, delivery, generation, version,
        position_seconds, audio_track_id, subtitle_track_id, desired_paused,
        created_at, started_at, playback_started_at, ended_at, last_heartbeat_at, failure_code
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 1, 0, NULL, NULL, 0, ?, NULL, ?, ?, ?, NULL)`,
    )
    .run(
      input.sessionId,
      input.householdId,
      input.deviceSessionId,
      input.deviceId,
      input.profileId,
      input.mediaId,
      input.playbackSourceId,
      input.state,
      delivery,
      input.at,
      input.playbackStartedAtMs === undefined ? null : iso(input.playbackStartedAtMs),
      ended,
      iso(input.lastHeartbeatAtMs ?? Date.parse(input.at)),
    );
  return input.sessionId;
}

/** 最小种子(FK 依赖序):身份 → 目录/来源 → 首个 ended 根会话(T062 rig 同构) */
function seedWorld(conn: DatabaseConstructor.Database, t0: number): RigSeed {
  const now = iso(t0);
  const householdId = `hh-t081-${randomUUID()}`;
  const accountId = `acc-t081-${randomUUID()}`;
  const profileId = `prof-t081-${randomUUID()}`;
  const deviceId = `dev-t081-${randomUUID()}`;
  const deviceSessionId = `dsess-t081-${randomUUID()}`;
  const mediaSourceId = `msrc-t081-${randomUUID()}`;
  const sourceEntryId = `entry-t081-${randomUUID()}`;
  const targetEntryId = `entry-tgt-t081-${randomUUID()}`;
  const sourceMediaId = `media-src-t081-${randomUUID()}`;
  const targetMediaId = `media-tgt-t081-${randomUUID()}`;
  const playbackSourceId = `psrc-t081-${randomUUID()}`;
  const targetPlaybackSourceId = `psrc-tgt-t081-${randomUUID()}`;
  conn.transaction(() => {
    conn.prepare('INSERT INTO household (id, name, created_at) VALUES (?, ?, ?)').run(householdId, 'T081 夹具家庭', now);
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
      .run(deviceSessionId, householdId, accountId, deviceId, `token-hash-${deviceSessionId}`, profileId, iso(t0 + 7 * 24 * 3600_000), now, now);
    conn
      .prepare(
        "INSERT INTO media_source (id, household_id, kind, name, remote_url, enabled, version, locator_revision, created_at, updated_at) VALUES (?, ?, 'vod', 'T081 夹具来源', 'https://upstream.fixture/api.php', 1, 1, 1, ?, ?)",
      )
      .run(mediaSourceId, householdId, now, now);
    conn
      .prepare(
        "INSERT INTO media_item (id, household_id, type, title, version, media_role, created_at, updated_at) VALUES (?, ?, 'episode', '第01集', 1, 'vod_episode', ?, ?)",
      )
      .run(sourceMediaId, householdId, now, now);
    conn
      .prepare(
        "INSERT INTO media_item (id, household_id, type, title, version, media_role, created_at, updated_at) VALUES (?, ?, 'episode', '第02集', 1, 'vod_episode', ?, ?)",
      )
      .run(targetMediaId, householdId, now, now);
    conn
      .prepare(
        "INSERT INTO source_entry (id, household_id, source_id, identity_kind, identity_digest, media_id, present, first_seen_at, last_seen_at) VALUES (?, ?, ?, 'vod_episode', ?, ?, 1, ?, ?)",
      )
      .run(sourceEntryId, householdId, mediaSourceId, 'c'.repeat(64), sourceMediaId, now, now);
    conn
      .prepare(
        "INSERT INTO source_entry (id, household_id, source_id, identity_kind, identity_digest, media_id, present, first_seen_at, last_seen_at) VALUES (?, ?, ?, 'vod_episode', ?, ?, 1, ?, ?)",
      )
      .run(targetEntryId, householdId, mediaSourceId, 'd'.repeat(64), targetMediaId, now, now);
    conn
      .prepare(
        "INSERT INTO playback_source (id, household_id, source_id, source_entry_id, media_item_id, protocol, location, priority, requires_proxy, locator_kind, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 'hls', 'https://upstream.fixture/ep01.m3u8', 100, 0, 'static', ?, ?)",
      )
      .run(playbackSourceId, householdId, mediaSourceId, sourceEntryId, sourceMediaId, now, now);
    conn
      .prepare(
        "INSERT INTO playback_source (id, household_id, source_id, source_entry_id, media_item_id, protocol, location, priority, requires_proxy, locator_kind, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 'hls', 'https://upstream.fixture/ep02.m3u8', 100, 0, 'static', ?, ?)",
      )
      .run(targetPlaybackSourceId, householdId, mediaSourceId, targetEntryId, targetMediaId, now, now);
    insertSessionRow(conn, {
      householdId,
      deviceSessionId,
      deviceId,
      profileId,
      mediaId: sourceMediaId,
      playbackSourceId,
      sessionId: `sess-src-root-${randomUUID()}`,
      state: 'ended',
      at: now,
    });
  })();
  return { householdId, accountId, profileId, deviceId, deviceSessionId, mediaSourceId, sourceMediaId, targetMediaId, playbackSourceId };
}

/** 直插固定输入绑定行(撤交付标记/引用图保护的持久目标) */
function insertBindingRow(
  conn: DatabaseConstructor.Database,
  input: { readonly householdId: string; readonly sessionId: string; readonly playbackSourceId: string; readonly sourceId: string; readonly atMs: number },
): string {
  const bindingId = `bind-${randomUUID()}`;
  conn
    .prepare(
      `INSERT INTO playback_input_binding (
        id, household_id, session_id, generation, playback_source_id, source_id,
        locator_revision, detail_revision, content_revision, continuity_revision,
        evidence_state, evidence_digest, resolved_input_id, resolved_at, expires_at,
        start_basis, frozen_start_seconds, cleanup_state
      ) VALUES (?, ?, ?, 1, ?, ?, 1, 1, 1, 1, 'unverified', 'unverified', ?, ?, ?, 'beginning', NULL, 'pending')`,
    )
    .run(bindingId, input.householdId, input.sessionId, input.playbackSourceId, input.sourceId, `rin-${bindingId}`, iso(input.atMs), iso(input.atMs + 600_000));
  return bindingId;
}

/** 直插会话 ledger 行(§9「不能连带删去受引用保护的 session 行/ledger」的存活断言目标) */
function insertProgressState(
  conn: DatabaseConstructor.Database,
  input: { readonly householdId: string; readonly sessionId: string; readonly profileId: string; readonly mediaId: string },
): void {
  conn
    .prepare(
      `INSERT INTO playback_progress_state (
        household_id, playback_session_id, profile_id, media_id,
        candidate_epoch, content_revision, profile_context_version, last_generation
      ) VALUES (?, ?, ?, ?, 1, 1, 1, 1)`,
    )
    .run(input.householdId, input.sessionId, input.profileId, input.mediaId);
}

/** 持久清理标记(T058/T062 同款写面形态;reason 显式以覆盖双标记两分支) */
function markSessionCleanupRequested(
  conn: DatabaseConstructor.Database,
  input: { readonly householdId: string; readonly sessionId: string; readonly reason: string },
): void {
  conn
    .prepare(
      `UPDATE playback_session SET cleanup_requested = 1, cleanup_reason = ?, cleanup_state = 'pending'
       WHERE household_id = ? AND id = ?`,
    )
    .run(input.reason, input.householdId, input.sessionId);
}

/** 受控终止桩(生命周期发布端口幂等 stop 语义:活动态落 ended,已终态零副作用) */
function controlledTerminator(conn: DatabaseConstructor.Database): {
  readonly port: TransitionSessionTerminatorPort;
  readonly calls: string[];
} {
  const calls: string[] = [];
  return {
    calls,
    port: {
      async stopSession(sessionId) {
        calls.push(sessionId);
        const row = conn.prepare('SELECT state FROM playback_session WHERE id = ?').get(sessionId) as
          | { state: string }
          | undefined;
        if (row === undefined) {
          return undefined;
        }
        if (row.state === 'ended' || row.state === 'failed' || row.state === 'interrupted') {
          return { state: row.state };
        }
        conn.prepare(`UPDATE playback_session SET state = 'ended', ended_at = ? WHERE id = ?`).run(iso(Date.now()), sessionId);
        return { state: 'ended' };
      },
    },
  };
}

/** cleanup 事务桥(真实参与者 + 真 BEGIN IMMEDIATE;T062 rig 同款) */
function realCleanupTx(conn: DatabaseConstructor.Database): TransitionCleanupTxPort {
  const binding: TransactionBinding = {
    credential: { transactionId: randomUUID(), behavior: 'immediate' } as TransactionCredential,
    exec: (sql: string, params?: readonly unknown[]) => {
      conn.prepare(sql).run(...(params ?? []));
    },
    get: <Row>(sql: string, params?: readonly unknown[]) => conn.prepare(sql).get(...(params ?? [])) as Row | undefined,
    all: <Row>(sql: string, params?: readonly unknown[]) => conn.prepare(sql).all(...(params ?? [])) as Row[],
  };
  const participants = createPlaybackTxParticipants(binding);
  return {
    runCleanupTx(work) {
      conn.transaction(() => {
        work({
          intent: {
            findIntent: (householdId, intentId) => participants.findIntent(householdId, intentId),
            markCancelled: (householdId, intentId) => participants.markIntentCancelled(householdId, intentId),
          },
          slot: {
            findSlot: (householdId, fromSessionId, fromGeneration) =>
              participants.findSlot(householdId, fromSessionId, fromGeneration),
            release: (householdId, fromSessionId, fromGeneration, expectedSlotRevision) =>
              participants.releaseSlot(householdId, fromSessionId, fromGeneration, expectedSlotRevision),
          },
          session: {
            findSession: (householdId, sessionId) => {
              const row = participants.findSession(householdId, sessionId);
              return row === undefined
                ? undefined
                : { state: row.state, generation: row.generation, cleanupRequested: row.cleanupRequested };
            },
          },
        });
      })();
    },
  };
}

function openRig(): Rig {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hmp-t081-retention-sweep-'));
  setEnvOverride(
    loadEnv({
      NODE_ENV: 'test',
      DATA_DIR: dataDir,
      DB_FILENAME: `${randomUUID()}.hmp.db`,
    }),
  );
  Database.close();
  const conn = Database.db;
  conn.exec('CREATE TABLE IF NOT EXISTS _migrations (name TEXT PRIMARY KEY NOT NULL, applied_at TEXT NOT NULL)');
  for (const name of MIGRATION_NAMES) {
    conn.transaction(() => {
      conn.exec(migrationSql(name));
      conn.prepare('INSERT INTO _migrations (name, applied_at) VALUES (?, ?)').run(name, new Date().toISOString());
    })();
  }
  const clock = createManualClock();
  const t0 = MANUAL_CLOCK_DEFAULT_START_MS;
  const seed = seedWorld(conn, t0);
  const store = drizzleTransitionStore(conn);
  bindTransitionStore(store);
  // playback store seam 惰性解析 Database.db(rig 已重开到本测试临时库)
  bindPlaybackStore(drizzlePlaybackStore());
  const vodInput = drizzleVodInputStore({ handle: conn, nowMs: () => clock.now() });
  const terminator = controlledTerminator(conn);
  const cleanup = new TransitionCleanupService({
    store,
    identity: {
      findTrustedSession: (deviceSessionId) =>
        deviceSessionId === seed.deviceSessionId
          ? { activeProfileId: seed.profileId, profileContextVersion: 1 }
          : undefined,
    },
    cleanupTx: realCleanupTx(conn),
    // 扫描面绝不消费授权端口(I5「不要求源或目标当前内容策略放行」);误调用即失败
    entitlement: {
      authorizeResolve: () => {
        throw new Error('T081 夹具错误:清理扫描面不得调用授权端口(I5)');
      },
    } as unknown as TransitionEntitlementPort,
    deliveryRevoke: {
      revokeDelivery: (input) => markDeliveryCleanupRequested(conn, input),
    },
    sessionTerminator: terminator.port,
    clock: () => clock.now(),
  });
  const retention = new PlaybackRetentionService({
    budgets: createPlaybackBudgets(loadEnv({ NODE_ENV: 'test' })),
    clock,
    vodInput,
    transitionCleanup: cleanup,
  });
  const rig: Rig = { conn, store, vodInput, cleanup, retention, terminator, clock, seed, dataDir, t0, seq: 0 };
  openRigs.push(rig);
  return rig;
}

afterEach(() => {
  while (openRigs.length > 0) {
    const rig = openRigs.pop();
    if (rig !== undefined) {
      Database.close();
      fs.rmSync(rig.dataDir, { recursive: true, force: true });
    }
  }
});

/* ------------------------------------------------------------------ */
/* 行读取/链式工厂                                                        */
/* ------------------------------------------------------------------ */

function scalarOf(rig: Rig, sql: string, ...params: unknown[]): number {
  const row = rig.conn.prepare(sql).get(...params) as { n: number } | undefined;
  return row?.n ?? 0;
}

function sessionRowOf(
  rig: Rig,
  sessionId: string,
): { state: string; cleanupRequested: number; cleanupState: string; cleanupReason: string | null } {
  const row = rig.conn
    .prepare(
      'SELECT state, cleanup_requested AS cleanupRequested, cleanup_state AS cleanupState, cleanup_reason AS cleanupReason FROM playback_session WHERE id = ?',
    )
    .get(sessionId) as { state: string; cleanupRequested: number; cleanupState: string; cleanupReason: string | null } | undefined;
  expect(row, `夹具错误:playback_session ${sessionId} 不存在`).toBeDefined();
  return row!;
}

function intentRowOf(rig: Rig, intentId: string): { status: string; successorId: string | null } {
  const row = rig.conn
    .prepare('SELECT status, successor_id AS successorId FROM playback_transition_intent WHERE id = ?')
    .get(intentId) as { status: string; successorId: string | null } | undefined;
  expect(row, `夹具错误:intent ${intentId} 不存在`).toBeDefined();
  return row!;
}

function slotRowOf(rig: Rig, fromSessionId: string): { status: string; slotRevision: number } {
  const row = rig.conn
    .prepare('SELECT status, slot_revision AS slotRevision FROM playback_transition_slot WHERE from_session_id = ?')
    .get(fromSessionId) as { status: string; slotRevision: number } | undefined;
  expect(row, `夹具错误:slot ${fromSessionId} 不存在`).toBeDefined();
  return row!;
}

/** 独立会话(未起播期限/双标记用;默认 created=atMs、心跳=atMs) */
function createSession(
  rig: Rig,
  overrides: {
    readonly atMs?: number;
    readonly startedAtMs?: number;
    readonly heartbeatAtMs?: number;
    readonly state?: 'ready' | 'preparing' | 'ended';
  } = {},
): string {
  rig.seq += 1;
  const atMs = overrides.atMs ?? rig.t0;
  return insertSessionRow(rig.conn, {
    householdId: rig.seed.householdId,
    deviceSessionId: rig.seed.deviceSessionId,
    deviceId: rig.seed.deviceId,
    profileId: rig.seed.profileId,
    mediaId: rig.seed.sourceMediaId,
    playbackSourceId: rig.seed.playbackSourceId,
    sessionId: `sess-r${rig.seq}-${randomUUID()}`,
    state: overrides.state ?? 'ready',
    at: iso(atMs),
    playbackStartedAtMs: overrides.startedAtMs,
    lastHeartbeatAtMs: overrides.heartbeatAtMs ?? atMs,
  });
}

/** 独立 ended 来源会话(槽唯一(家庭,来源,代次),多链互不争用) */
function createSourceSession(rig: Rig, atMs: number): string {
  rig.seq += 1;
  return insertSessionRow(rig.conn, {
    householdId: rig.seed.householdId,
    deviceSessionId: rig.seed.deviceSessionId,
    deviceId: rig.seed.deviceId,
    profileId: rig.seed.profileId,
    mediaId: rig.seed.sourceMediaId,
    playbackSourceId: null,
    sessionId: `sess-src-${rig.seq}-${randomUUID()}`,
    state: 'ended',
    at: iso(atMs),
  });
}

/** finish receipt 种子(store 真实幂等写面;等价 T058 已提交形态) */
function insertReceipt(rig: Rig, input: { readonly sessionId: string; readonly endedAtMs: number }): void {
  const created = rig.store.insertFinishReceiptIfAbsent({
    householdId: rig.seed.householdId,
    sessionId: input.sessionId,
    deviceSessionId: rig.seed.deviceSessionId,
    profileContextVersion: 1,
    generation: 1,
    operationKey: `op-rcpt-${randomUUID()}`,
    requestDigest: `digest-rcpt-${randomUUID()}`,
    finalSeq: 2,
    finalSessionAccepted: true,
    historyApplied: false,
    historyRevision: null,
    sessionCompleted: true,
    autoNextEligible: true,
    reason: 'completed',
    positionSeconds: 1,
    durationSeconds: 100,
    endedAt: iso(input.endedAtMs),
    contentRevision: 1,
    continuityRevision: 1,
    locatorRevision: 1,
  });
  expect(created.created, '夹具错误:receipt 种子应新建').toBe(true);
}

/** 计划 + pending intent + reserved slot 全链(store 真实创建面;可携来源 receipt 引用) */
function createPendingChain(
  rig: Rig,
  overrides: { readonly createdAtMs?: number; readonly receiptOnSource?: boolean } = {},
): { readonly intentId: string; readonly fromSessionId: string; readonly planId: string } {
  rig.seq += 1;
  const createdAtMs = overrides.createdAtMs ?? rig.t0;
  const fromSessionId = createSourceSession(rig, createdAtMs);
  let finishReceiptId: string | null = null;
  if (overrides.receiptOnSource === true) {
    insertReceipt(rig, { sessionId: fromSessionId, endedAtMs: createdAtMs });
    finishReceiptId = fromSessionId;
  }
  const plan = rig.store.createNextPlan({
    id: `plan-${rig.seq}-${randomUUID()}`,
    ref: `plan-ref-${rig.seq}-${randomUUID()}`,
    householdId: rig.seed.householdId,
    deviceSessionId: rig.seed.deviceSessionId,
    profileId: rig.seed.profileId,
    profileContextVersion: 1,
    fromSessionId,
    fromGeneration: 1,
    action: 'manual_next',
    targetMediaId: rig.seed.targetMediaId,
    sequenceRevision: 1,
    detailRevision: 1,
    targetContentRevision: 1,
    targetContinuityRevision: 1,
    targetLocatorRevision: 1,
    historyRevision: 0,
    historyChoiceRequired: false,
    createdAt: iso(createdAtMs),
  });
  const intentId = `intent-${rig.seq}-${randomUUID()}`;
  const outcome = rig.store.createTransitionIntent(
    {
      id: intentId,
      householdId: rig.seed.householdId,
      fromSessionId,
      fromGeneration: 1,
      deviceSessionId: rig.seed.deviceSessionId,
      profileId: rig.seed.profileId,
      profileContextVersion: 1,
      action: 'manual_next',
      targetMediaId: rig.seed.targetMediaId,
      targetContentRevision: 1,
      targetContinuityRevision: 1,
      targetLocatorRevision: 1,
      matchRevision: 1,
      matchConfidence: 'high',
      confirmedAmbiguous: false,
      position: { mode: 'beginning' },
      finishReceiptId,
      operationKey: `op-${rig.seq}-${randomUUID()}`,
      requestDigest: `digest-${rig.seq}`,
      createdAt: iso(createdAtMs),
      plan: {
        nextPlanId: plan.id,
        sequenceRevision: plan.sequenceRevision,
        detailRevision: plan.detailRevision,
        historyRevision: plan.historyRevision,
        historyChoiceRequired: plan.historyChoiceRequired === 1,
        expiresAt: plan.expiresAt,
      },
    },
    0,
  );
  expect(outcome.kind, '夹具错误:pending 链创建应 created').toBe('created');
  return { intentId, fromSessionId, planId: plan.id };
}

/** 消费链:preparing 后继 + 绑定行 + consumed intent/slot(store 真实消费面) */
function createConsumedChain(
  rig: Rig,
  overrides: { readonly createdAtMs?: number; readonly receiptOnSource?: boolean } = {},
): { readonly intentId: string; readonly successorId: string; readonly fromSessionId: string; readonly planId: string } {
  rig.seq += 1;
  const successorId = `sess-succ-${rig.seq}-${randomUUID()}`;
  insertSessionRow(rig.conn, {
    householdId: rig.seed.householdId,
    deviceSessionId: rig.seed.deviceSessionId,
    deviceId: rig.seed.deviceId,
    profileId: rig.seed.profileId,
    mediaId: rig.seed.targetMediaId,
    playbackSourceId: null,
    sessionId: successorId,
    state: 'preparing',
    at: iso(overrides.createdAtMs ?? rig.t0),
  });
  insertBindingRow(rig.conn, {
    householdId: rig.seed.householdId,
    sessionId: successorId,
    playbackSourceId: rig.seed.playbackSourceId,
    sourceId: rig.seed.mediaSourceId,
    atMs: overrides.createdAtMs ?? rig.t0,
  });
  const chain = createPendingChain(rig, overrides);
  // 消费时刻与链同代:createdAt+1s 消费(TTL 60s 判定以消费时刻为基准)
  const outcome = rig.store.consumeTransition(
    rig.seed.householdId,
    chain.intentId,
    successorId,
    iso((overrides.createdAtMs ?? rig.t0) + 1000),
  );
  expect(outcome.kind, '夹具错误:消费应 consumed').toBe('consumed');
  return { intentId: chain.intentId, successorId, fromSessionId: chain.fromSessionId, planId: chain.planId };
}

/** 独立计划行(引用保护矩阵用;无 intent/slot) */
function createPlanRow(rig: Rig, overrides: { readonly createdAtMs?: number } = {}): string {
  rig.seq += 1;
  const fromSessionId = createSourceSession(rig, overrides.createdAtMs ?? rig.t0);
  const plan = rig.store.createNextPlan({
    id: `plan-solo-${rig.seq}-${randomUUID()}`,
    ref: `plan-solo-ref-${rig.seq}-${randomUUID()}`,
    householdId: rig.seed.householdId,
    deviceSessionId: rig.seed.deviceSessionId,
    profileId: rig.seed.profileId,
    profileContextVersion: 1,
    fromSessionId,
    fromGeneration: 1,
    action: 'next',
    targetMediaId: rig.seed.targetMediaId,
    sequenceRevision: 1,
    detailRevision: 1,
    targetContentRevision: 1,
    targetContinuityRevision: 1,
    targetLocatorRevision: 1,
    historyRevision: 0,
    historyChoiceRequired: false,
    createdAt: iso(overrides.createdAtMs ?? rig.t0),
  });
  return plan.id;
}

function planExists(rig: Rig, planId: string): boolean {
  return scalarOf(rig, 'SELECT COUNT(*) AS n FROM playback_next_plan WHERE id = ?', planId) === 1;
}

function receiptExists(rig: Rig, sessionId: string): boolean {
  return scalarOf(rig, 'SELECT COUNT(*) AS n FROM playback_finish_receipt WHERE session_id = ?', sessionId) === 1;
}

/** 让渡微任务/快任务队列:启动首拍(void 链)整体排空 */
async function drain(): Promise<void> {
  for (let i = 0; i < 25; i += 1) {
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });
  }
}

function expectAllZero(outcome: TransitionCleanupSweepOutcome): void {
  expect(outcome).toEqual({
    expiredPendingFlipped: 0,
    consumedSlotsDeleted: 0,
    consumedIntentsDeleted: 0,
    finishReceiptsDeleted: 0,
    nextPlansRecycled: 0,
    cleanupStopsRedelivered: 0,
  });
}

/** retention 节拍扫描(装配形态必有结果;端口缺位 undefined 形态在本 rig 不存在) */
async function sweepOf(rig: Rig, nowMs: number): Promise<TransitionCleanupSweepOutcome> {
  const outcome = await rig.retention.runTransitionCleanupSweep(nowMs);
  expect(outcome, '装配形态下扫描必有结果').toBeDefined();
  return outcome as TransitionCleanupSweepOutcome;
}

/* ------------------------------------------------------------------ */
/* 1. 启动首拍三链(T081 收口主缺口:未起播回收入首拍 + 节拍顺序)             */
/* ------------------------------------------------------------------ */

describe('010 T081 · 启动首拍三链(start();data-model §9 + api §7 I5 失败/重启扫描重试)', () => {
  it('F1-a start() 零节拍等待覆盖三链:失效 intent 翻转+槽释放、cleanup 持久标记补投空 stop、未起播 ready 回收;第二拍全零', async () => {
    const rig = openRig();
    // 链①:失效 intent(created t0-120s,TTL 60s → 首拍时刻已过期)+ reserved 槽
    const expired = createPendingChain(rig, { createdAtMs: rig.t0 - 120_000 });
    // 链②:cleanup 持久标记的活动后继(consumed 链 + T062 撤交付标记;重启前补投丢失形态)
    const consumed = createConsumedChain(rig);
    markDeliveryCleanupRequested(rig.conn, {
      householdId: rig.seed.householdId,
      sessionId: consumed.successorId,
      generation: 1,
      reason: 'transition_cleanup',
    });
    // 链③:未起播 ready 会话(created t0-61s,期限已过;重启停机窗口内到期形态)
    const unstarted = createSession(rig, { atMs: rig.t0 - 61_000 });

    rig.retention.start();
    await drain();

    // 三链同一首拍全部收口(无需等待首个 15s 节拍)
    expect(intentRowOf(rig, expired.intentId).status, '失效 intent 首拍翻转为 expired').toBe('expired');
    expect(slotRowOf(rig, expired.fromSessionId), 'reserved 槽同拍释放 open+revision+1').toMatchObject({
      status: 'open',
      slotRevision: 2,
    });
    expect(rig.terminator.calls, 'cleanup 标记会话首拍补投幂等空 stop').toContain(consumed.successorId);
    expect(sessionRowOf(rig, consumed.successorId).state, '补投 stop 落授权面终态 ended').toBe('ended');
    expect(sessionRowOf(rig, unstarted).state, '未起播 ready 会话首拍回收 interrupted').toBe('interrupted');

    // 第二拍全零(幂等;契约 F2/G1「第二拍全零」的 retention 编排面镜像)
    const callsAfterFirstBeat = rig.terminator.calls.length;
    expectAllZero(await sweepOf(rig, rig.clock.now()));
    expect(await rig.retention.runUnstartedReadyReclaim(rig.clock.now()), '未起播回收第二拍零清单零回收').toEqual({
      scanned: 0,
      reclaimed: 0,
    });
    expect(rig.terminator.calls.length, '补投不重复').toBe(callsAfterFirstBeat);

    // 周期节拍链接续一拍仍全零(收口后不回弹)
    await rig.clock.advance(15_000);
    await drain();
    expect(rig.terminator.calls.length, '周期节拍不重复补投').toBe(callsAfterFirstBeat);
    rig.retention.stopTimers();
  });

  it('F1-b 节拍顺序:cleanup 标记会话经补投 stop 落 ended(授权面终止先于期限兜底),不被 reclaim 抢先 interrupted', async () => {
    const rig = openRig();
    // 既带 cleanup 持久标记、又已过未起播 60s 期限的 ready 会话:两链均有资格
    const marked = createSession(rig, { atMs: rig.t0 - 61_000 });
    markDeliveryCleanupRequested(rig.conn, {
      householdId: rig.seed.householdId,
      sessionId: marked,
      generation: 1,
      reason: 'transition_cleanup',
    });

    rig.retention.start();
    await drain();

    expect(rig.terminator.calls, '扫描先于回收:标记会话由补投 stop 收口').toContain(marked);
    expect(sessionRowOf(rig, marked).state, '终态为 ended(资源结算面)而非 interrupted(期限兜底)').toBe('ended');
    rig.retention.stopTimers();
  });
});

/* ------------------------------------------------------------------ */
/* 2. 双标记扫描覆盖(T058 finish_receipt × T062 transition_cleanup)         */
/* ------------------------------------------------------------------ */

describe('010 T081 · 双标记扫描覆盖(补投谓词与原因无关;T058 × T062)', () => {
  it('D1 两种原因标记的活动会话同拍补投;finish 真实终态形态(ended+标记)不入补投且 receipt 留 24h 保护窗', async () => {
    const rig = openRig();
    // M1:T062 transition_cleanup 标记的活动会话
    const m1 = createSession(rig);
    markDeliveryCleanupRequested(rig.conn, {
      householdId: rig.seed.householdId,
      sessionId: m1,
      generation: 1,
      reason: 'transition_cleanup',
    });
    // M2:finish_receipt 标记的活动会话(防御性形态:标记已落、终止未落定的崩溃窗口)
    const m2 = createSession(rig);
    markSessionCleanupRequested(rig.conn, { householdId: rig.seed.householdId, sessionId: m2, reason: 'finish_receipt' });
    // M3:finish 同 commit 终态化的真实形态 —— ended + finish_receipt 标记 + receipt
    const m3 = createSession(rig, { state: 'ended' });
    markSessionCleanupRequested(rig.conn, { householdId: rig.seed.householdId, sessionId: m3, reason: 'finish_receipt' });
    insertReceipt(rig, { sessionId: m3, endedAtMs: rig.t0 });

    const outcome = await sweepOf(rig, rig.clock.now());

    expect(outcome.cleanupStopsRedelivered, '两原因标记的活动会话同拍补投(谓词与原因无关)').toBe(2);
    expect(rig.terminator.calls, '补投恰覆盖 M1/M2').toEqual(expect.arrayContaining([m1, m2]));
    expect(rig.terminator.calls, '终态会话不入补投(终态守卫,无需 stop)').not.toContain(m3);
    expect(outcome.finishReceiptsDeleted, 'finish receipt 处 24h 保护窗内不删(§9 至少 24h)').toBe(0);
    expect(receiptExists(rig, m3), 'T058 回执行存活(已消费结果重放面)').toBe(true);
    expect(sessionRowOf(rig, m3).cleanupState, '终态标记保持 pending(终态自然出清,无需补投)').toBe('pending');
  });
});

/* ------------------------------------------------------------------ */
/* 3. 24h 保护窗与引用图(data-model §9;元数据 FK 保护)                      */
/* ------------------------------------------------------------------ */

describe('010 T081 · 24h 保护窗与引用图(§9 至少 24h;依赖序 slot→intent→receipt)', () => {
  it('P1 窗内除到期翻转外零删除;窗外按依赖序删除;受存活 intent 行引用的 receipt 不删;后继 session/绑定/ledger 不被连带删;第二拍全零', async () => {
    const rig = openRig();
    // C1:consumed 链 + 来源 receipt(intent.finish_receipt_id 引用)+ 后继 ledger 行
    const c1 = createConsumedChain(rig, { receiptOnSource: true });
    insertProgressState(rig.conn, {
      householdId: rig.seed.householdId,
      sessionId: c1.successorId,
      profileId: rig.seed.profileId,
      mediaId: rig.seed.targetMediaId,
    });
    // P_ref:pending 链 + 其来源 receipt(引用保护钉面;TTL 60s 后由扫描翻转,行不删)
    const pRef = createPendingChain(rig, { receiptOnSource: true });
    // P_fresh:较新 pending 链(创建于首拍前 30s,TTL 60s → 首拍时刻仍在 TTL 内)
    const pFresh = createPendingChain(rig, { createdAtMs: rig.t0 + 3_600_000 - 30_000 });

    // 窗内(+1h;24h 保护窗未满):仅 TTL 到期的 P_ref 翻转,删除面全零
    const inWindow = await sweepOf(rig, rig.t0 + 3_600_000);
    expect(inWindow.expiredPendingFlipped, 'TTL 到期的 P_ref 翻转(60s 固定,不续期)').toBe(1);
    expect(inWindow.consumedSlotsDeleted, '已消费槽窗内存活').toBe(0);
    expect(inWindow.consumedIntentsDeleted, '已消费 intent 窗内存活(重放面)').toBe(0);
    expect(inWindow.finishReceiptsDeleted, 'receipt 窗内存活').toBe(0);
    expect(inWindow.cleanupStopsRedelivered, '无标记会话零补投').toBe(0);
    expect(intentRowOf(rig, c1.intentId).status).toBe('consumed');
    expect(slotRowOf(rig, c1.fromSessionId).status).toBe('consumed');
    expect(intentRowOf(rig, pFresh.intentId).status, 'TTL 内 pending 不翻转').toBe('pending');

    // 窗外(+25h):依赖序删除 + 引用图保护
    const pastWindow = await sweepOf(rig, rig.t0 + 25 * 3_600_000);
    expect(pastWindow.expiredPendingFlipped, 'P_fresh 到期翻转(P_ref 首拍已翻,不重复)').toBe(1);
    expect(pastWindow.consumedSlotsDeleted, '已消费槽先删(FK 子行)').toBe(1);
    expect(pastWindow.consumedIntentsDeleted, '已消费 intent 随后删(不再可消费/重放)').toBe(1);
    expect(
      pastWindow.finishReceiptsDeleted,
      '仅无引用 receipt 删(C1 来源 receipt 随引用解除释放;P_ref 的被存活 intent 行引用保护)',
    ).toBe(1);
    expect(pastWindow.nextPlansRecycled, 'ref 未解绑计划保持 410 可判别面不回收').toBe(0);

    expect(intentRowOf(rig, pRef.intentId).status, 'P_ref 已翻转且行仍存在(410 不复活语义;引用保护载体)').toBe('expired');
    expect(slotRowOf(rig, pRef.fromSessionId).status, '过期链槽同拍释放').toBe('open');
    expect(intentRowOf(rig, pFresh.intentId).status, 'P_fresh 窗外翻转').toBe('expired');
    expect(receiptExists(rig, pRef.fromSessionId), '被存活 intent 行引用的 receipt 不删(引用图保护)').toBe(true);
    // 元数据 FK 保护:后继 session/绑定/ledger 行不在删除面
    expect(scalarOf(rig, 'SELECT COUNT(*) AS n FROM playback_session WHERE id = ?', c1.successorId), '后继 session 行存活').toBe(1);
    expect(
      scalarOf(rig, 'SELECT COUNT(*) AS n FROM playback_input_binding WHERE session_id = ?', c1.successorId),
      '后继绑定行存活',
    ).toBe(1);
    expect(
      scalarOf(rig, 'SELECT COUNT(*) AS n FROM playback_progress_state WHERE playback_session_id = ?', c1.successorId),
      'ledger 行存活(§9 不能连带删)',
    ).toBe(1);

    // 第二拍全零(幂等)
    expectAllZero(await sweepOf(rig, rig.t0 + 25 * 3_600_000 + 1_000));
  });
});

/* ------------------------------------------------------------------ */
/* 4. 受引用 nextPlan 保护与回收(data-model §10)                           */
/* ------------------------------------------------------------------ */

describe('010 T081 · 受引用 nextPlan 保护(§10 按 intent 保留;引用解除后按 ref 解绑回收)', () => {
  it('N1 被引用计划随 intent 保留;ref 未解绑过期行保持 410 面;引用随 intent 删除解除后解绑行方回收', async () => {
    const rig = openRig();
    // planA:被 consumed intent 引用(C2 窗内),ref 预先解绑(模拟配额淘汰遗留)
    const c2 = createConsumedChain(rig);
    rig.conn.prepare('UPDATE playback_next_plan SET ref = NULL WHERE id = ?').run(c2.planId);
    // planB:过期 + ref 未解绑 + 无引用(410 可判别面)
    const planB = createPlanRow(rig);
    // planC:过期 + ref 已解绑 + 无引用(可回收形态)
    const planC = createPlanRow(rig);
    rig.conn.prepare('UPDATE playback_next_plan SET ref = NULL WHERE id = ?').run(planC);

    // 第一拍(+2h):C2 的 consumed intent 仍在 24h 窗内 → planA 受引用保留
    const beat1 = await sweepOf(rig, rig.t0 + 2 * 3_600_000);
    expect(beat1.nextPlansRecycled, '仅无引用解绑行回收(planC)').toBe(1);
    expect(planExists(rig, c2.planId), '被 consumed intent 引用的计划随 intent 保留(§10)').toBe(true);
    expect(planExists(rig, planB), 'ref 未解绑的过期计划保持 410 可判别面').toBe(true);
    expect(planExists(rig, planC), '无引用解绑行回收').toBe(false);

    // 第二拍(+25h):C2 intent 已过窗删除 → 引用解除,planA(ref 已解绑)按回收面出清
    const beat2 = await sweepOf(rig, rig.t0 + 25 * 3_600_000);
    expect(beat2.consumedIntentsDeleted, 'C2 intent 窗满删除').toBe(1);
    expect(beat2.nextPlansRecycled, '引用解除后 planA 回收').toBe(1);
    expect(planExists(rig, c2.planId), '引用随 intent 删除解除,解绑过期行出清').toBe(false);
    expect(planExists(rig, planB), 'ref 未解绑行依旧保持 410 面').toBe(true);
  });
});

/* ------------------------------------------------------------------ */
/* 5. 未起播期限语义(data-model §9:锚点/不续命/解除/CAS)                    */
/* ------------------------------------------------------------------ */

describe('010 T081 · 未起播 60s 固定期限(§9;heartbeat/renew 不续命;playback_started_at 解除)', () => {
  it('U1 heartbeat 刷新不延长 created_at 锚点期限;started 解除;期限未满不回收;两 watcher CAS 恰一赢家', async () => {
    const rig = openRig();
    // heartbeat 刚刷新(若续命则不可回收)但 created_at 锚点已过期 → 仍回收
    const withFreshHeartbeat = createSession(rig, { atMs: rig.t0 - 61_000, heartbeatAtMs: rig.t0 - 1_000 });
    // 已起播(playback_started_at 由合格 playing 观测设置)→ 期限解除,不入清单
    const started = createSession(rig, { atMs: rig.t0 - 70_000, startedAtMs: rig.t0 - 65_000 });
    // 期限未满(created 30s)→ 不回收
    const fresh = createSession(rig, { atMs: rig.t0 - 30_000 });
    // 两 watcher CAS 竞争目标
    const casTarget = createSession(rig, { atMs: rig.t0 - 61_000 });

    // watcher A(持久原语)先赢
    const watcherA = await rig.vodInput.reclaimExpiredUnstartedReadySession({
      householdId: rig.seed.householdId,
      sessionId: casTarget,
      nowMs: rig.t0,
    });
    expect(watcherA.reclaimed, '原语回收恰一赢家').toBe(true);
    // watcher B(调度面)同一观察:清单仅剩期限满且未起播者,CAS 输家/已起播/期限未满均不入
    const outcome = await rig.retention.runUnstartedReadyReclaim(rig.t0);
    expect(outcome).toEqual({ scanned: 1, reclaimed: 1 });

    expect(sessionRowOf(rig, withFreshHeartbeat).state, 'heartbeat 不续命:期限满仍回收').toBe('interrupted');
    expect(sessionRowOf(rig, started).state, 'playback_started_at 解除未起播期限').toBe('ready');
    expect(sessionRowOf(rig, fresh).state, '期限未满不回收').toBe('ready');
    expect(sessionRowOf(rig, casTarget).state, 'CAS 赢家终态').toBe('interrupted');
    // 输家零写入:ended_at 以先到者为准,不被改写
    const endedAtOf = (): string =>
      (rig.conn.prepare('SELECT ended_at FROM playback_session WHERE id = ?').get(casTarget) as { ended_at: string }).ended_at;
    const winnerEndedAt = endedAtOf();
    const loser = await rig.vodInput.reclaimExpiredUnstartedReadySession({
      householdId: rig.seed.householdId,
      sessionId: casTarget,
      nowMs: rig.t0,
    });
    expect(loser.reclaimed, '输家 reclaimed=false 而非覆盖').toBe(false);
    expect(endedAtOf(), '终态事实不被改写(ended_at 先到者为准)').toBe(winnerEndedAt);
  });
});

/* ------------------------------------------------------------------ */
/* 6. 身份撤销即时拒绝(不等 TTL;信任源逐请求直读 revoked_at)                */
/* ------------------------------------------------------------------ */

describe('010 T081 · 末次检查身份撤销立即拒绝(SessionGuard 信任源管线;全部播放路由入口含 heartbeat/renew)', () => {
  it('I1 会话/设备撤销后同令牌立即 401 SESSION_INVALID;撤销前放行(逐请求直读,无 TTL 缓存窗口)', () => {
    const rig = openRig();
    const expiresSoon = iso(Date.now() + 7 * 24 * 3600_000);
    const nowIso = iso(Date.now());
    const insertTrustedSession = (id: string, token: string): void => {
      rig.conn
        .prepare(
          'INSERT INTO device_session (id, household_id, account_id, device_id, token_hash, active_profile_id, expires_at, last_active_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
        )
        .run(id, rig.seed.householdId, rig.seed.accountId, rig.seed.deviceId, hashToken(token), rig.seed.profileId, expiresSoon, nowIso, nowIso);
    };

    // 会话撤销面
    const revokedSessionId = `dsess-revoked-${randomUUID()}`;
    const sessionToken = `tok-t081-${randomUUID()}`;
    insertTrustedSession(revokedSessionId, sessionToken);
    expect(validateSessionToken(sessionToken, { hashToken }).session.id, '撤销前令牌放行(返回可信上下文)').toBe(revokedSessionId);
    rig.conn.prepare('UPDATE device_session SET revoked_at = ? WHERE id = ?').run(nowIso, revokedSessionId);
    expectSessionInvalid(() => validateSessionToken(sessionToken, { hashToken }));

    // 设备撤销面(撤销传播到设备行;另一令牌随之立即失效)
    const deviceToken = `tok-t081-dev-${randomUUID()}`;
    const deviceRevokedSessionId = `dsess-devrev-${randomUUID()}`;
    insertTrustedSession(deviceRevokedSessionId, deviceToken);
    expect(validateSessionToken(deviceToken, { hashToken }).session.id).toBe(deviceRevokedSessionId);
    rig.conn.prepare('UPDATE device SET revoked_at = ? WHERE id = ?').run(nowIso, rig.seed.deviceId);
    expectSessionInvalid(() => validateSessionToken(deviceToken, { hashToken }));
  });
});

/** 断言信任源管线抛 401 SESSION_INVALID(统一无差别,不泄露失败原因) */
function expectSessionInvalid(fn: () => unknown): void {
  let raised: unknown;
  try {
    fn();
  } catch (error) {
    raised = error;
  }
  expect(raised, '撤销后必须立即拒绝').toBeInstanceOf(DomainError);
  expect((raised as DomainError).status).toBe(401);
  expect((raised as DomainError).code).toBe(ProblemCode.SESSION_INVALID);
}
