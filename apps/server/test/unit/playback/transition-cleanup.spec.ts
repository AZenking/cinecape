/**
 * 010-online-vod T062(US3)—— 过渡最小清理服务真实行为契约(允许新增 spec)。
 *
 * T062 审查补充原文(tasks.md):「新增 transition-cleanup.service.ts 及 controller
 * 最小 cleanup 端点/工作集,先撤交付再 commit 后 stop,重启可重试」+「receipt/已消费
 * intent/slot 至少 24h 且不短于会话保留、引用图清理及启动恢复;资产可按原短 TTL 清理,
 * 但不能连带删去受这些引用保护的 session 行/ledger」。
 *
 * 本 spec 为 T052 G 组(api.md §7 I5)的服务级镜像 + T059 清理面原语的真实存储行为:
 * - G1 镜像:consumed 后禁源 → 失权判定 404 同形(不返回完整结果)→ cleanup 持久标记
 *   (session+当前代绑定 cleanup_requested/cleanup_state=pending 同 commit)+ 提交后
 *   幂等空 stop(stopped)+ 重试同入口幂等 + 标记阻断 renew(PlaybackTicketService
 *   真实实例,标记门先于授权链);
 * - G2 镜像:pending 禁源 cleanup → cancelled + 槽 open/revision+1(不要求策略放行:
 *   entitlement 端点零调用)→ 重试 already_cancelled(槽不再变化);
 * - 失权判定:目标禁源 404 MEDIA_NOT_FOUND / 跨设备·随机 id 404 同形(不可判别存在性,
 *   entitlement 零调用);
 * - 扫描面(24h 保护窗/引用图/启动恢复):过期 pending 翻转+槽释放;24h 窗内已消费
 *   intent/slot/receipt 存活、窗外按依赖序删除(槽→intent→receipt);引用图保护 ——
 *   session/ledger/binding 行不被连带删除、被存活 intent 引用的 receipt/计划不删、
 *   ref 未解绑的过期计划保持 410 可判别面不回收;cleanup_requested 仍 pending 的活动
 *   会话补投幂等空 stop(重启重试面);重复扫描第二轮全零。
 *
 * 夹具分层:独立临时文件库 + 全量权威迁移 DDL(0001–0007,foreign_keys=ON 真实约束)+
 * 真实 drizzleTransitionStore(bindTransitionStore 绑定)+ 真实 DrizzlePlaybackTxParticipants
 * (createPlaybackTxParticipants,真事务 BEGIN IMMEDIATE)+ 真实 markDeliveryCleanupRequested
 * + 真实 PlaybackRepository/PlaybackTicketService(renew 标记门)。时间以真实 now 为基准
 * 回溯/前推(ISO Z;60s TTL/24h 保护窗远大于测试执行时长,确定性成立)。零网络、零 mock
 * HTTP —— 全部为真实 SQLite/真实服务行为(终止面以受控行为桩模拟生命周期发布端口的
 * 幂等 stop 语义:活动态落终态、已终态零副作用)。
 *
 * 权威依据:
 * - docs/specs/010-online-vod/contracts/api.md §5 GET 行(完整 IntentReply 要求当前源/
 *   目标权限;失权时不返回完整结果,使用 cleanup 最小清理接口)+ §7 I5(cleanup 权威);
 * - docs/specs/010-online-vod/contracts/internal-ports.md §5(TransitionCleanupWorkSet:
 *   IntentTx/SlotTx/PlaybackSessionTx/InputBindingTx;只标记取消/撤交付/cleanup;
 *   session 终止由既有生命周期发布端口执行;新资产/renew 检查持久清理标记);
 * - docs/specs/010-online-vod/data-model.md §7(consumed 槽永久)+ §9(至少 24h 且不短于
 *   会话保留;先删 intent 再按依赖清理 slot/receipt;不连带删 session/ledger)+
 *   §10(cleanup_requested 持久标记;标记先阻止新票/资产;策略失权不阻止最小清理)。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import DatabaseConstructor from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import { ProblemCode } from '@hmp/shared';
import { DomainError } from '@platform/http-common/domain-error';
import { loadEnv } from '@platform/config/env.schema';
import { createPlaybackBudgets } from '@platform/config/playback-budgets';
import type { SessionContext } from '@platform/http-common/current-session.decorator';
import type { TransactionBinding, TransactionCredential } from '@platform/database/unit-of-work';
import {
  bindTransitionStore,
  type PlaybackTransitionStore,
} from '@contexts/playback/application/playback-transition-store.port';
import { drizzleTransitionStore } from '@contexts/playback/infrastructure/playback-transition-store.drizzle';
import { bindPlaybackStore } from '@contexts/playback/application/playback-store.port';
import { markDeliveryCleanupRequested } from '@contexts/playback/infrastructure/playback-input-store.drizzle';
import { createPlaybackTxParticipants } from '@contexts/playback/infrastructure/transaction-participants';
import { PlaybackRepository } from '@contexts/playback/infrastructure/playback.repository';
import { PlaybackTicketService } from '@contexts/playback/application/playback-ticket.service';
import { isPlaybackTerminalSessionState } from '@contexts/playback/domain/playback.types';
import type { PlaybackAuthorizationService } from '@contexts/playback/application/playback-authorization.service';
import {
  TransitionCleanupService,
  type TransitionCleanupTxPort,
  type TransitionEntitlementPort,
  type TransitionSessionTerminatorPort,
} from '@contexts/playback/application/transition-cleanup.service';

/* ------------------------------------------------------------------ */
/* rig:临时文件库 + 全量权威迁移 + 最小种子 + 真实 store/参与者/服务        */
/* ------------------------------------------------------------------ */

interface RigSeed {
  readonly householdId: string;
  readonly profileId: string;
  readonly deviceId: string;
  readonly deviceSessionId: string;
  readonly otherDeviceSessionId: string;
  readonly mediaSourceId: string;
  readonly sourceMediaId: string;
  readonly targetMediaId: string;
  readonly playbackSourceId: string;
}

interface ControlledTerminator {
  readonly port: TransitionSessionTerminatorPort;
  readonly calls: string[];
}

interface Rig {
  readonly conn: DatabaseConstructor.Database;
  readonly store: PlaybackTransitionStore;
  readonly service: TransitionCleanupService;
  readonly entitlement: TransitionEntitlementPort & { readonly calls: string[] };
  readonly terminator: ControlledTerminator;
  readonly seed: RigSeed;
  readonly dataDir: string;
  readonly t0: number;
  seq: number;
}

const openRigs: Rig[] = [];

/** UTC ISO-8601 毫秒 Z */
function iso(ms: number): string {
  return new Date(ms).toISOString();
}

function applyAuthoritativeMigrations(conn: DatabaseConstructor.Database): void {
  const migrationsDir = path.join(process.cwd(), 'src/platform/database/migrations');
  const names = fs
    .readdirSync(migrationsDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
  for (const name of names) {
    const upSqlPath = path.join(migrationsDir, name, 'up.sql');
    expect(fs.existsSync(upSqlPath), `未找到迁移 DDL ${upSqlPath}(须以 apps/server 为工作目录运行)`).toBe(true);
    conn.exec(fs.readFileSync(upSqlPath, 'utf8'));
  }
}

/** 直插播放会话行(活动/终态;FK 全满足) */
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
    readonly state: 'preparing' | 'ready' | 'playing' | 'ended';
    readonly at: string;
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
        created_at, started_at, ended_at, last_heartbeat_at, failure_code
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 1, 0, NULL, NULL, 0, ?, NULL, ?, ?, NULL)`,
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
      ended,
      input.at,
    );
  return input.sessionId;
}

/** 最小种子(FK 依赖序):身份 → 目录/来源(在线判别)→ 首个 ended 来源会话 */
function seedWorld(conn: DatabaseConstructor.Database, t0: number): RigSeed {
  const now = iso(t0);
  const householdId = `hh-t062-${randomUUID()}`;
  const accountId = `acc-t062-${randomUUID()}`;
  const profileId = `prof-t062-${randomUUID()}`;
  const deviceId = `dev-t062-${randomUUID()}`;
  const deviceSessionId = `dsess-t062-${randomUUID()}`;
  const otherDeviceSessionId = `dsess-other-t062-${randomUUID()}`;
  const mediaSourceId = `msrc-t062-${randomUUID()}`;
  const sourceEntryId = `entry-t062-${randomUUID()}`;
  const targetEntryId = `entry-tgt-t062-${randomUUID()}`;
  const sourceMediaId = `media-src-t062-${randomUUID()}`;
  const targetMediaId = `media-tgt-t062-${randomUUID()}`;
  const playbackSourceId = `psrc-t062-${randomUUID()}`;
  const targetPlaybackSourceId = `psrc-tgt-t062-${randomUUID()}`;
  conn.transaction(() => {
    conn.prepare('INSERT INTO household (id, name, created_at) VALUES (?, ?, ?)').run(householdId, 'T062 夹具家庭', now);
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
    for (const dsId of [deviceSessionId, otherDeviceSessionId]) {
      conn
        .prepare(
          'INSERT INTO device_session (id, household_id, account_id, device_id, token_hash, active_profile_id, expires_at, last_active_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
        )
        .run(dsId, householdId, accountId, deviceId, `token-hash-${dsId}`, profileId, iso(t0 + 7 * 24 * 3600_000), now, now);
    }
    conn
      .prepare(
        "INSERT INTO media_source (id, household_id, kind, name, remote_url, enabled, version, locator_revision, created_at, updated_at) VALUES (?, ?, 'vod', 'T062 夹具来源', 'https://upstream.fixture/api.php', 1, 1, 1, ?, ?)",
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
  return {
    householdId,
    profileId,
    deviceId,
    deviceSessionId,
    otherDeviceSessionId,
    mediaSourceId,
    sourceMediaId,
    targetMediaId,
    playbackSourceId,
  };
}

/** 直插固定输入绑定行(撤交付标记的持久目标;0007 CHECK/FK 全满足) */
function insertBindingRow(
  conn: DatabaseConstructor.Database,
  input: {
    readonly householdId: string;
    readonly sessionId: string;
    readonly playbackSourceId: string;
    readonly sourceId: string;
    readonly atMs: number;
  },
): string {
  const bindingId = `bind-${randomUUID()}`;
  const resolvedAt = iso(input.atMs);
  conn
    .prepare(
      `INSERT INTO playback_input_binding (
        id, household_id, session_id, generation, playback_source_id, source_id,
        locator_revision, detail_revision, content_revision, continuity_revision,
        evidence_state, evidence_digest, resolved_input_id, resolved_at, expires_at,
        start_basis, frozen_start_seconds, cleanup_state
      ) VALUES (?, ?, ?, 1, ?, ?, 1, 1, 1, 1, 'unverified', 'unverified', ?, ?, ?, 'beginning', NULL, 'pending')`,
    )
    .run(bindingId, input.householdId, input.sessionId, input.playbackSourceId, input.sourceId, `rin-${bindingId}`, resolvedAt, iso(input.atMs + 600_000));
  return bindingId;
}

/** 失权判定夹具:与授权权威同形(来源 enabled 判定;拒绝 404 MEDIA_NOT_FOUND 同形) */
function fixtureEntitlement(conn: DatabaseConstructor.Database, householdId: string): TransitionEntitlementPort & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    authorizeResolve(_context, mediaId) {
      calls.push(mediaId);
      const row = conn
        .prepare(
          `SELECT ms.enabled AS enabled
           FROM media_item mi
           LEFT JOIN playback_source ps ON ps.household_id = mi.household_id AND ps.media_item_id = mi.id
           LEFT JOIN media_source ms ON ms.household_id = ps.household_id AND ms.id = ps.source_id
           WHERE mi.household_id = ? AND mi.id = ?`,
        )
        .get(householdId, mediaId) as { enabled: number | null } | undefined;
      if (row === undefined || row.enabled !== 1) {
        throw new DomainError(404, ProblemCode.MEDIA_NOT_FOUND, '播放媒体不存在');
      }
      return Promise.resolve({ ok: true });
    },
  };
}

/** 受控终止桩(生命周期发布端口幂等 stop 语义:活动态落 ended,已终态零副作用) */
function controlledTerminator(conn: DatabaseConstructor.Database): ControlledTerminator {
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
        if (!isPlaybackTerminalSessionState(row.state)) {
          conn
            .prepare(
              `UPDATE playback_session SET state = 'ended', ended_at = ?
               WHERE id = ? AND state NOT IN ('ended', 'failed', 'interrupted')`,
            )
            .run(iso(Date.now()), sessionId);
        }
        const after = conn.prepare('SELECT state FROM playback_session WHERE id = ?').get(sessionId) as { state: string };
        return { state: after.state };
      },
    },
  };
}

/** 真实 cleanup 事务端口:真实参与者 + BEGIN IMMEDIATE(与应用装配桥同构) */
function realCleanupTx(conn: DatabaseConstructor.Database): TransitionCleanupTxPort {
  const binding: TransactionBinding = {
    credential: { transactionId: randomUUID(), behavior: 'immediate' } as TransactionCredential,
    exec: (sql, params) => {
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
            findSlot: (householdId, fromSessionId, fromGeneration) => participants.findSlot(householdId, fromSessionId, fromGeneration),
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
      }).immediate();
    },
  };
}

function openRig(): Rig {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hmp-t062-transition-cleanup-'));
  const conn = new DatabaseConstructor(path.join(dataDir, `${randomUUID()}.db`));
  conn.pragma('journal_mode = WAL');
  conn.pragma('foreign_keys = ON');
  applyAuthoritativeMigrations(conn);
  const t0 = Date.now();
  const seed = seedWorld(conn, t0);
  const store = drizzleTransitionStore(conn);
  bindTransitionStore(store);
  const entitlement = fixtureEntitlement(conn, seed.householdId);
  const terminator = controlledTerminator(conn);
  const service = new TransitionCleanupService({
    store,
    identity: {
      findTrustedSession: (deviceSessionId) =>
        deviceSessionId === seed.deviceSessionId
          ? { activeProfileId: seed.profileId, profileContextVersion: 1 }
          : undefined,
    },
    cleanupTx: realCleanupTx(conn),
    entitlement,
    deliveryRevoke: {
      revokeDelivery: (input) => markDeliveryCleanupRequested(conn, input),
    },
    sessionTerminator: terminator.port,
  });
  const rig: Rig = { conn, store, service, entitlement, terminator, seed, dataDir, t0, seq: 0 };
  openRigs.push(rig);
  return rig;
}

afterEach(() => {
  while (openRigs.length > 0) {
    const rig = openRigs.pop();
    rig?.conn.close();
    if (rig !== undefined) {
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

function slotRowOf(rig: Rig, fromSessionId: string): { status: string; slotRevision: number; activeIntentId: string | null } {
  const row = rig.conn
    .prepare(
      'SELECT status, slot_revision AS slotRevision, active_intent_id AS activeIntentId FROM playback_transition_slot WHERE from_session_id = ?',
    )
    .get(fromSessionId) as { status: string; slotRevision: number; activeIntentId: string | null } | undefined;
  expect(row, `夹具错误:slot ${fromSessionId} 不存在`).toBeDefined();
  return row!;
}

/** 独立 ended 来源会话(每链一个:槽唯一(家庭,来源,代次),多链互不争用) */
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

/** 计划 + pending intent + reserved slot 全链(store 真实创建面;等价 T059+T060 产物) */
function createPendingChain(rig: Rig, overrides: { readonly createdAtMs?: number } = {}): {
  readonly intentId: string;
  readonly fromSessionId: string;
  readonly planId: string;
} {
  rig.seq += 1;
  const createdAtMs = overrides.createdAtMs ?? rig.t0;
  const fromSessionId = createSourceSession(rig, createdAtMs);
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
      finishReceiptId: null,
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

/** 消费链:preparing 后继 + 绑定行 + consumed intent/slot(store 真实消费面) */
function createConsumedChain(rig: Rig, overrides: { readonly createdAtMs?: number } = {}): {
  readonly intentId: string;
  readonly successorId: string;
  readonly fromSessionId: string;
} {
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
    atMs: rig.t0,
  });
  const chain = createPendingChain(rig, overrides);
  // 消费时刻与链同代:回溯链在其 createdAt+1s 消费(TTL 60s 判定以消费时刻为基准)
  const outcome = rig.store.consumeTransition(
    rig.seed.householdId,
    chain.intentId,
    successorId,
    iso((overrides.createdAtMs ?? rig.t0) + 1000),
  );
  expect(outcome.kind, '夹具错误:消费应 consumed').toBe('consumed');
  return { intentId: chain.intentId, successorId, fromSessionId: chain.fromSessionId };
}

/** 禁源(media_source.enabled=0;与契约 G 组 DB 直改同口径) */
function disableSource(rig: Rig): void {
  rig.conn.prepare('UPDATE media_source SET enabled = 0 WHERE id = ?').run(rig.seed.mediaSourceId);
}

function contextOf(rig: Rig, deviceSessionId: string = rig.seed.deviceSessionId): SessionContext {
  return {
    session: {
      id: deviceSessionId,
      householdId: rig.seed.householdId,
    },
  } as unknown as SessionContext;
}

function expectNotFoundSameShape(error: unknown): void {
  expect(error).toBeInstanceOf(DomainError);
  expect((error as DomainError).status).toBe(404);
  expect((error as DomainError).code).toBe(ProblemCode.PLAYBACK_NOT_FOUND);
}

/* ------------------------------------------------------------------ */
/* G2 镜像:pending 禁源 cleanup(cancelled/槽释放/重试 already_cancelled)  */
/* ------------------------------------------------------------------ */

describe('T062 · cleanup 服务级(G2 镜像:pending 分支;api.md §7 I5)', () => {
  it('G2-a pending 禁源:cleanup → cancelled + 槽 open/revision+1;策略失权不阻止(entitlement 零调用)', async () => {
    const rig = openRig();
    const chain = createPendingChain(rig);
    disableSource(rig);
    const reply = await rig.service.cleanupIntent(contextOf(rig), chain.intentId);
    expect(Object.keys(reply).sort(), 'I5 最小回执:仅 outcome 键').toEqual(['outcome']);
    expect(reply.outcome).toBe('cancelled');
    expect(intentRowOf(rig, chain.intentId).status).toBe('cancelled');
    const slot = slotRowOf(rig, chain.fromSessionId);
    expect(slot.status).toBe('open');
    expect(slot.slotRevision).toBe(2);
    expect(slot.activeIntentId).toBeNull();
    expect(rig.entitlement.calls, '最小清理不要求源/目标策略放行(I5)').toEqual([]);
    expect(rig.terminator.calls, 'pending 分支无后继,不投递 stop').toEqual([]);
  });

  it('G2-b 重试幂等:重复 cleanup → already_cancelled(槽不再变化)', async () => {
    const rig = openRig();
    const chain = createPendingChain(rig);
    await rig.service.cleanupIntent(contextOf(rig), chain.intentId);
    const reply = await rig.service.cleanupIntent(contextOf(rig), chain.intentId);
    expect(reply).toEqual({ outcome: 'already_cancelled' });
    const slot = slotRowOf(rig, chain.fromSessionId);
    expect(slot.status).toBe('open');
    expect(slot.slotRevision).toBe(2);
  });

  it('G2-c 归属同形 404:跨设备/随机 id 同形 PLAYBACK_NOT_FOUND(不可判别存在性,零副作用)', async () => {
    const rig = openRig();
    const chain = createPendingChain(rig);
    const crossDevice = await rig.service
      .cleanupIntent(contextOf(rig, rig.seed.otherDeviceSessionId), chain.intentId)
      .catch((e: unknown) => e);
    const randomId = await rig.service.cleanupIntent(contextOf(rig), randomUUID()).catch((e: unknown) => e);
    expectNotFoundSameShape(crossDevice);
    expectNotFoundSameShape(randomId);
    expect(intentRowOf(rig, chain.intentId).status, '拒绝路径零副作用').toBe('pending');
    expect(rig.entitlement.calls, '归属判定先于失权判定,零授权调用').toEqual([]);
  });
});

/* ------------------------------------------------------------------ */
/* G1 镜像:consumed 禁源 cleanup(失权 GET/cleanup 标记/阻断 renew/重试)   */
/* ------------------------------------------------------------------ */

describe('T062 · cleanup 服务级(G1 镜像:consumed 分支;api.md §7 I5+§5 GET 行)', () => {
  it('G1-a consumed 禁源:失权判定 404 MEDIA_NOT_FOUND;cleanup 持久标记(session+绑定同 commit)+幂等空 stop → stopped', async () => {
    const rig = openRig();
    const consumed = createConsumedChain(rig);
    disableSource(rig);
    // 失权判定:不返回完整结果(不借 GET 发票)—— 当前源/目标授权失权即 404 MEDIA_NOT_FOUND
    const revoked = await rig.service
      .assertFullReplyEntitlement(contextOf(rig), consumed.intentId)
      .catch((e: unknown) => e);
    expect(revoked).toBeInstanceOf(DomainError);
    expect((revoked as DomainError).status).toBe(404);
    expect((revoked as DomainError).code).toBe(ProblemCode.MEDIA_NOT_FOUND);
    // 最小清理:consumed → 唯一后继持久 cleanup_requested(先撤交付,同 commit)
    const reply = await rig.service.cleanupIntent(contextOf(rig), consumed.intentId);
    expect(Object.keys(reply).sort()).toEqual(['outcome']);
    expect(reply.outcome).toBe('stopped');
    expect(JSON.stringify(reply), 'cleanup 回执不泄漏目标 mediaId(I5)').not.toContain(rig.seed.targetMediaId);
    const successor = sessionRowOf(rig, consumed.successorId);
    expect(successor.cleanupRequested).toBe(1);
    expect(successor.cleanupState).toBe('pending');
    expect(successor.cleanupReason).toBe('transition_cleanup');
    const binding = rig.conn
      .prepare('SELECT cleanup_requested AS r, cleanup_state AS s FROM playback_input_binding WHERE session_id = ?')
      .get(consumed.successorId) as { r: number; s: string };
    expect(binding.r, '撤交付:当前代绑定同 commit 标记').toBe(1);
    expect(binding.s).toBe('pending');
    expect(intentRowOf(rig, consumed.intentId).status, '不重消费、不重建:intent 保持 consumed').toBe('consumed');
    expect(rig.terminator.calls, '提交后投递幂等空 stop(既有生命周期发布端口)').toEqual([consumed.successorId]);
  });

  it('G1-b 重试幂等:响应丢失重试同入口 → 仍最小回执(stopped/cleanup_pending),标记零漂移', async () => {
    const rig = openRig();
    const consumed = createConsumedChain(rig);
    const first = await rig.service.cleanupIntent(contextOf(rig), consumed.intentId);
    expect(first.outcome).toBe('stopped');
    const second = await rig.service.cleanupIntent(contextOf(rig), consumed.intentId);
    expect(Object.keys(second)).toEqual(['outcome']);
    expect(['cleanup_pending', 'stopped']).toContain(second.outcome);
    expect(sessionRowOf(rig, consumed.successorId).cleanupRequested).toBe(1);
    expect(rig.terminator.calls, '重试同入口幂等(stop 可重复投递,终态零副作用)').toEqual([
      consumed.successorId,
      consumed.successorId,
    ]);
  });

  it('G1-c 标记阻断 renew:cleanup_requested=1 会话签发/续期 409 PLAYBACK_NOT_READY(标记门先于授权链,不写票行)', async () => {
    const rig = openRig();
    const consumed = createConsumedChain(rig);
    await rig.service.cleanupIntent(contextOf(rig), consumed.intentId);
    const budgets = createPlaybackBudgets(loadEnv({ NODE_ENV: 'test', DATA_DIR: rig.dataDir }));
    const repository = new PlaybackRepository(rig.conn, budgets);
    // 票据标记门经 playbackStore() 全局 seam 读会话行:绑定本 rig 的最小投影
    // (标记门只读 household_id/cleanup_requested 两列;原生句柄非 drizzle 实例,故结构绑定)
    bindPlaybackStore({
      findPlaybackSessionRowById: (sessionId: string) =>
        rig.conn
          .prepare('SELECT household_id AS householdId, cleanup_requested AS cleanupRequested FROM playback_session WHERE id = ?')
          .get(sessionId),
    } as unknown as Parameters<typeof bindPlaybackStore>[0]);
    let authorizationTouched = false;
    const service = new PlaybackTicketService(
      repository,
      {
        // 标记门必须先于授权链:授权被触达即失败(真装配中授权链亦会拒绝失权媒体,
        // 但持久标记是 I5 权威驱动面 —— 授权事实恢复后标记仍阻断)
        authorizeControl: async () => {
          authorizationTouched = true;
          throw new Error('标记门应先于授权链拒绝');
        },
        revalidate: async () => {
          throw new Error('标记门应先于授权链拒绝');
        },
      } as unknown as PlaybackAuthorizationService,
      budgets,
    );
    const renewal = await service
      .issueOrRenew(consumed.successorId, 1, contextOf(rig), { at: iso(rig.t0) })
      .catch((e: unknown) => e);
    expect(renewal).toBeInstanceOf(DomainError);
    expect((renewal as DomainError).status).toBe(409);
    expect((renewal as DomainError).code).toBe(ProblemCode.PLAYBACK_NOT_READY);
    expect(authorizationTouched, '标记门先阻止新票(data-model §10)').toBe(false);
    expect(scalarOf(rig, 'SELECT COUNT(*) AS n FROM playback_ticket WHERE session_id = ?', consumed.successorId), '拒绝路径不写票行').toBe(0);
  });

  it('G1-d 失权判定归属先行:跨设备/随机 id 404 同形 PLAYBACK_NOT_FOUND(零授权调用,不可判别存在性)', async () => {
    const rig = openRig();
    const consumed = createConsumedChain(rig);
    disableSource(rig);
    const crossDevice = await rig.service
      .assertFullReplyEntitlement(contextOf(rig, rig.seed.otherDeviceSessionId), consumed.intentId)
      .catch((e: unknown) => e);
    const randomId = await rig.service.assertFullReplyEntitlement(contextOf(rig), randomUUID()).catch((e: unknown) => e);
    expectNotFoundSameShape(crossDevice);
    expectNotFoundSameShape(randomId);
    expect(rig.entitlement.calls, '归属 404 先行,失权判定不触达授权').toEqual([]);
  });

  it('G1-e 未失权(源可用):失权判定放行(源+目标双授权),GET 完整结果语义保持', async () => {
    const rig = openRig();
    const consumed = createConsumedChain(rig);
    await expect(rig.service.assertFullReplyEntitlement(contextOf(rig), consumed.intentId)).resolves.toBeUndefined();
    expect(rig.entitlement.calls, '当前源/目标权限双判定(§5 GET 行)').toEqual([
      rig.seed.targetMediaId,
      rig.seed.sourceMediaId,
    ]);
  });
});

/* ------------------------------------------------------------------ */
/* 扫描面:过期翻转/24h 保护窗/引用图保护/重启重试/幂等                      */
/* ------------------------------------------------------------------ */

describe('T062 · 过渡清理扫描面(24h 保护窗/引用图/启动恢复;data-model §9)', () => {
  it('S1 过期 pending 翻转:expired + reserved 槽同拍释放;TTL 内 pending 不动', async () => {
    const rig = openRig();
    const stale = createPendingChain(rig, { createdAtMs: rig.t0 - 120_000 });
    const fresh = createPendingChain(rig);
    const outcome = await rig.service.runCleanupSweep(rig.t0 + 1000);
    expect(outcome.expiredPendingFlipped).toBe(1);
    expect(intentRowOf(rig, stale.intentId).status).toBe('expired');
    const staleSlot = slotRowOf(rig, stale.fromSessionId);
    expect(staleSlot.status).toBe('open');
    expect(staleSlot.slotRevision).toBe(2);
    expect(intentRowOf(rig, fresh.intentId).status, 'TTL 内 pending 不动').toBe('pending');
  });

  it('S2 24h 保护窗:窗内存活/窗外按依赖序删除(slot→intent→receipt);session/绑定不被连带删;第二拍全零', async () => {
    const rig = openRig();
    // 窗外(25h 前)已消费链 + 来源 receipt(引用其来源会话)
    const staleChain = createPendingChain(rig, { createdAtMs: rig.t0 - 25 * 3600_000 });
    insertReceipt(rig, { sessionId: staleChain.fromSessionId, endedAtMs: rig.t0 - 25 * 3600_000 });
    rig.conn
      .prepare('UPDATE playback_transition_intent SET finish_receipt_id = ? WHERE id = ?')
      .run(staleChain.fromSessionId, staleChain.intentId);
    const staleSuccessor = `sess-stale-succ-${randomUUID()}`;
    insertSessionRow(rig.conn, {
      householdId: rig.seed.householdId,
      deviceSessionId: rig.seed.deviceSessionId,
      deviceId: rig.seed.deviceId,
      profileId: rig.seed.profileId,
      mediaId: rig.seed.targetMediaId,
      playbackSourceId: null,
      sessionId: staleSuccessor,
      state: 'ended',
      at: iso(rig.t0 - 25 * 3600_000),
    });
    expect(rig.store.consumeTransition(rig.seed.householdId, staleChain.intentId, staleSuccessor, iso(rig.t0 - 25 * 3600_000 + 1000)).kind).toBe('consumed');
    // 窗内(23h 前)已消费链:必须存活(含后继会话/绑定/ledger 面)
    const freshConsumed = createConsumedChain(rig, { createdAtMs: rig.t0 - 23 * 3600_000 });
    const first = await rig.service.runCleanupSweep(rig.t0 + 1000);
    expect(first.consumedIntentsDeleted).toBe(1);
    expect(first.consumedSlotsDeleted).toBe(1);
    expect(first.finishReceiptsDeleted).toBe(1);
    expect(scalarOf(rig, 'SELECT COUNT(*) AS n FROM playback_transition_intent WHERE id = ?', staleChain.intentId)).toBe(0);
    expect(scalarOf(rig, 'SELECT COUNT(*) AS n FROM playback_transition_slot WHERE from_session_id = ?', staleChain.fromSessionId)).toBe(0);
    expect(scalarOf(rig, 'SELECT COUNT(*) AS n FROM playback_finish_receipt')).toBe(0);
    // 窗内链完整存活(引用图不受窗外清理影响;后继会话/绑定行不被连带删)
    expect(intentRowOf(rig, freshConsumed.intentId).status).toBe('consumed');
    expect(sessionRowOf(rig, freshConsumed.successorId).state).toBe('preparing');
    expect(scalarOf(rig, 'SELECT COUNT(*) AS n FROM playback_input_binding WHERE session_id = ?', freshConsumed.successorId)).toBe(1);
    // 重启重试语义:第二拍全零(全原语守卫状态谓词,幂等)
    const second = await rig.service.runCleanupSweep(rig.t0 + 2000);
    expect(second).toEqual({
      expiredPendingFlipped: 0,
      consumedSlotsDeleted: 0,
      consumedIntentsDeleted: 0,
      finishReceiptsDeleted: 0,
      nextPlansRecycled: 0,
      cleanupStopsRedelivered: 0,
    });
  });

  it('S3 引用图保护:被存活 intent 引用的 receipt/计划不删;ref 未解绑过期计划保持可判别面;解绑后方可回收', async () => {
    const rig = openRig();
    // 来源 receipt(25h 前)被存活 consumed intent(23h)以 finish_receipt_id 引用
    const freshConsumed = createConsumedChain(rig, { createdAtMs: rig.t0 - 23 * 3600_000 });
    insertReceipt(rig, { sessionId: freshConsumed.fromSessionId, endedAtMs: rig.t0 - 25 * 3600_000 });
    rig.conn
      .prepare('UPDATE playback_transition_intent SET finish_receipt_id = ? WHERE id = ?')
      .run(freshConsumed.fromSessionId, freshConsumed.intentId);
    // 计划(23h 前创建,expires_at=+60s 早已过期):ref 未解绑 + 被存活 intent 引用
    const outcome = await rig.service.runCleanupSweep(rig.t0 + 1000);
    expect(outcome.finishReceiptsDeleted, '被引用 receipt 受引用图保护').toBe(0);
    expect(outcome.nextPlansRecycled, 'ref 未解绑的过期计划不回收(过期计划 410 可判别面)').toBe(0);
    expect(scalarOf(rig, 'SELECT COUNT(*) AS n FROM playback_finish_receipt')).toBe(1);
    expect(intentRowOf(rig, freshConsumed.intentId).status).toBe('consumed');
    expect(scalarOf(rig, 'SELECT COUNT(*) AS n FROM playback_session'), 'session 行不在删除面(引用图保护)').toBeGreaterThanOrEqual(3);
    expect(scalarOf(rig, 'SELECT COUNT(*) AS n FROM playback_input_binding'), '绑定行不在删除面').toBe(1);
    // 解绑引用(intent 先行清理:next_plan_id/finish_receipt_id 置空)+ ref 解绑 → 同形过期行回收
    rig.conn.prepare('UPDATE playback_next_plan SET ref = NULL WHERE household_id = ?').run(rig.seed.householdId);
    rig.conn
      .prepare('UPDATE playback_transition_intent SET next_plan_id = NULL, finish_receipt_id = NULL WHERE id = ?')
      .run(freshConsumed.intentId);
    const second = await rig.service.runCleanupSweep(rig.t0 + 3000);
    expect(second.nextPlansRecycled, 'ref 已解绑且无 intent 引用的过期计划回收').toBe(1);
    expect(second.finishReceiptsDeleted, 'intent 引用解除后 receipt 按依赖序可清理').toBe(1);
  });

  it('S4 重启重试:cleanup_requested 仍 pending 的活动会话补投幂等空 stop;终态出清后第二轮全零', async () => {
    const rig = openRig();
    // 模拟「端点已标记、提交后 stop 因重启丢失」的库内事实(标记先于终止的持久残面)
    const orphanId = `sess-orphan-${randomUUID()}`;
    insertSessionRow(rig.conn, {
      householdId: rig.seed.householdId,
      deviceSessionId: rig.seed.deviceSessionId,
      deviceId: rig.seed.deviceId,
      profileId: rig.seed.profileId,
      mediaId: rig.seed.targetMediaId,
      playbackSourceId: null,
      sessionId: orphanId,
      state: 'preparing',
      at: iso(rig.t0),
    });
    markDeliveryCleanupRequested(rig.conn, {
      householdId: rig.seed.householdId,
      sessionId: orphanId,
      generation: 1,
      reason: 'transition_cleanup',
    });
    const first = await rig.service.runCleanupSweep(rig.t0 + 1000);
    expect(first.cleanupStopsRedelivered).toBe(1);
    expect(rig.terminator.calls).toEqual([orphanId]);
    expect(sessionRowOf(rig, orphanId).state).toBe('ended');
    const second = await rig.service.runCleanupSweep(rig.t0 + 2000);
    expect(second.cleanupStopsRedelivered, '终态出清后不再补投').toBe(0);
    expect(rig.terminator.calls).toEqual([orphanId]);
  });
});
