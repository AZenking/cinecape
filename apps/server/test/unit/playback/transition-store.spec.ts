/**
 * 010-online-vod T059(US3)—— 过渡持久仓储真实行为契约(next plan/slot/intent/receipt/清理面)。
 *
 * T059 原文(tasks.md):「slot/intent/receipt 持久查询、同上下文终态只读来源授权、
 * scope 幂等、60s 固定 TTL/24h 消费结果保护,初始 revision=0/open 只作响应默认;
 * 禁止复用活动控制授权重发旧源票。审查补充:持久 NextPlan 快照及 intent 引用保留,
 * 创建/消费校验序列/目标/历史 revision」。
 *
 * 被测实现:
 * - @contexts/playback/application/playback-transition-store.port(端口 + bind seam);
 * - @contexts/playback/infrastructure/playback-transition-store.drizzle(真实 store);
 * - @contexts/playback/application/transition-source-context.service(只读来源授权)。
 *
 * 夹具分层:独立临时文件库 + 全量权威迁移 DDL(0001–0007,foreign_keys=ON 真实约束,
 * 含 playback_transition_slot/intent/next_plan/finish_receipt 全部 CHECK/唯一索引)+
 * 真实 drizzleTransitionStore(经 bindTransitionStore 绑定,seam 可用性同测)。行种子
 * 直插(复合 FK/CHECK 全满足);时间以真实 now 为基准回溯/前推(ISO Z 串;60s/24h
 * 窗口远大于测试执行时长,确定性成立)。零网络、零 mock —— 全部为真实 SQLite 行为。
 *
 * 权威依据(实现侧不自创语义):
 * - docs/specs/010-online-vod/data-model.md §7(唯一(家庭,来源,代次);TTL 固定 60s
 *   重试不续期;pending 显式替换 expectedSlotRevision、旧意图 superseded、slot_revision+1;
 *   取消成功 open+revision;consumed 槽永久不能再建立第二后继;同设备上下文操作 key 唯一)
 *   + §9(finish receipt/已消费 intent/slot 至少 24h)+ §10(playback_next_plan 不可变
 *   60s/引用保留/每设备 20 上限只计未引用活计划;intent 冻结快照随 next_plan_id);
 * - docs/specs/010-online-vod/contracts/playback-state.md §5(终态也可读合法来源上下文;
 *   不重新发源票;A→B→A 的 contextVersion 不等即 404)+ §7(slot open→reserved→consumed;
 *   旧 intent 状态不可逆);
 * - docs/specs/010-online-vod/contracts/api.md §5/§7(同 key 重放 200 同结果不续 TTL/
 *   异摘要 409 IDEMPOTENCY_CONFLICT;slot 消费后任何新 key 409 附原后继引用;淘汰 ref
 *   与未知 ref 404 同形;pending 到期不晚于计划 expiresAt 与 createdAt+60s 较早者;
 *   过期计划 410 NEXT_PLAN_EXPIRED);
 * - apps/server/src/contexts/playback/domain/transition.rules.ts(T054:INTENT_TTL_SECONDS
 *   =60/intentExpiresAtMs/isIntentExpired;本持久层消费其判定);
 * - T052 e2e(online-vod-next-transition.e2e-spec.ts)A/B/D 组钉面(本 spec 为其持久层
 *   等价面;HTTP 编排归 T060/T061)。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import DatabaseConstructor from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import { ProblemCode } from '@hmp/shared';
import { DomainError } from '@platform/http-common/domain-error';
import { INTENT_TTL_SECONDS } from '@contexts/playback/domain/transition.rules';
import {
  bindTransitionStore,
  transitionStore,
  type NextPlanCreateValues,
  type PlaybackTransitionStore,
  type TransitionIntentCreateValues,
} from '@contexts/playback/application/playback-transition-store.port';
import { drizzleTransitionStore } from '@contexts/playback/infrastructure/playback-transition-store.drizzle';
import { TransitionSourceContextService } from '@contexts/playback/application/transition-source-context.service';
import type { FinishReceiptInsertValues } from '@contexts/playback/application/playback-work-set.port';

/* ------------------------------------------------------------------ */
/* rig:临时文件库 + 全量权威迁移 + 最小种子 + 真实 store                  */
/* ------------------------------------------------------------------ */

interface RigSeed {
  readonly householdId: string;
  readonly accountId: string;
  readonly profileId: string;
  readonly deviceId: string;
  readonly deviceSessionId: string;
  readonly sourceMediaId: string;
  readonly targetMediaId: string;
  readonly sourceSessionId: string;
  readonly playbackSourceId: string;
}

interface Rig {
  readonly conn: DatabaseConstructor.Database;
  readonly store: PlaybackTransitionStore;
  readonly sourceContext: TransitionSourceContextService;
  readonly seed: RigSeed;
  readonly dataDir: string;
  readonly t0: number;
  /** 每 rig 独立序号:计划 createdAt 逐个 +1s(过期序=创建序,淘汰断言可定位) */
  planSeq: number;
  intentSeq: number;
  sessionSeq: number;
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

/** 最小种子(FK 依赖序):身份 → 目录/来源(在线判别)→ 来源播放会话(ended) */
function seedWorld(conn: DatabaseConstructor.Database, t0: number): RigSeed {
  const now = iso(t0);
  const householdId = `hh-t059-${randomUUID()}`;
  const accountId = `acc-t059-${randomUUID()}`;
  const profileId = `prof-t059-${randomUUID()}`;
  const deviceId = `dev-t059-${randomUUID()}`;
  const deviceSessionId = `dsess-t059-${randomUUID()}`;
  const mediaSourceId = `msrc-t059-${randomUUID()}`;
  const sourceEntryId = `entry-t059-${randomUUID()}`;
  const sourceMediaId = `media-src-t059-${randomUUID()}`;
  const targetMediaId = `media-tgt-t059-${randomUUID()}`;
  const playbackSourceId = `psrc-t059-${randomUUID()}`;
  const sourceSessionId = `sess-src-t059-${randomUUID()}`;
  conn.transaction(() => {
    conn.prepare('INSERT INTO household (id, name, created_at) VALUES (?, ?, ?)').run(householdId, 'T059 夹具家庭', now);
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
    // vod 来源 + 条目 + 在线判别播放资源(input binding FK 目标)
    conn
      .prepare(
        "INSERT INTO media_source (id, household_id, kind, name, remote_url, enabled, version, locator_revision, created_at, updated_at) VALUES (?, ?, 'vod', 'T059 夹具来源', 'https://upstream.fixture/api.php', 1, 1, 1, ?, ?)",
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
      .run(sourceEntryId, householdId, mediaSourceId, 'b'.repeat(64), sourceMediaId, now, now);
    conn
      .prepare(
        "INSERT INTO playback_source (id, household_id, source_id, source_entry_id, media_item_id, protocol, location, priority, requires_proxy, locator_kind, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 'hls', 'https://upstream.fixture/ep01.m3u8', 100, 0, 'static', ?, ?)",
      )
      .run(playbackSourceId, householdId, mediaSourceId, sourceEntryId, sourceMediaId, now, now);
    // 来源播放会话(ended:终态也可读合法上下文;TTL/资格判定输入)
    conn
      .prepare(
        `INSERT INTO playback_session (
          id, household_id, device_session_id, device_id, profile_id, media_id,
          playback_source_id, state, delivery, generation, version,
          position_seconds, audio_track_id, subtitle_track_id, desired_paused,
          created_at, started_at, ended_at, last_heartbeat_at, failure_code
        ) VALUES (?, ?, ?, ?, ?, ?, ?, 'ended', 'hls_proxy', 1, 1, 0, NULL, NULL, 0, ?, ?, ?, ?, NULL)`,
      )
      .run(sourceSessionId, householdId, deviceSessionId, deviceId, profileId, sourceMediaId, playbackSourceId, now, now, now, now);
  })();
  return {
    householdId,
    accountId,
    profileId,
    deviceId,
    deviceSessionId,
    sourceMediaId,
    targetMediaId,
    sourceSessionId,
    playbackSourceId,
  };
}

function openRig(): Rig {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hmp-t059-transition-'));
  const conn = new DatabaseConstructor(path.join(dataDir, `${randomUUID()}.db`));
  conn.pragma('journal_mode = WAL');
  conn.pragma('foreign_keys = ON');
  applyAuthoritativeMigrations(conn);
  const t0 = Date.now();
  const seed = seedWorld(conn, t0);
  const store = drizzleTransitionStore(conn);
  bindTransitionStore(store);
  const rig: Rig = {
    conn,
    store,
    sourceContext: new TransitionSourceContextService(store),
    seed,
    dataDir,
    t0,
    planSeq: 0,
    intentSeq: 0,
    sessionSeq: 0,
  };
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
/* 行读取/值集助手                                                        */
/* ------------------------------------------------------------------ */

function scalarOf(rig: Rig, sql: string, ...params: unknown[]): number {
  const row = rig.conn.prepare(sql).get(...params) as { n: number } | undefined;
  return row?.n ?? 0;
}

function rawPlanByRef(rig: Rig, ref: string): { id: string; ref: string | null } | undefined {
  return rig.conn.prepare('SELECT id, ref FROM playback_next_plan WHERE ref = ?').get(ref) as
    | { id: string; ref: string | null }
    | undefined;
}

/**
 * 计划创建值集:createdAt 逐个 +1s 回退自 t0-20s(首计划最早过期;淘汰序=创建序;
 * 60s TTL 使全部种子在测试执行窗口内未过期)。
 */
function nextPlanValues(
  rig: Rig,
  overrides: Partial<NextPlanCreateValues> = {},
): NextPlanCreateValues {
  rig.planSeq += 1;
  const createdAtMs = rig.t0 - 20_000 + (rig.planSeq - 1) * 1000;
  return {
    id: `plan-${rig.planSeq}-${randomUUID()}`,
    ref: `plan-ref-${rig.planSeq}-${randomUUID()}`,
    householdId: rig.seed.householdId,
    deviceSessionId: rig.seed.deviceSessionId,
    profileId: rig.seed.profileId,
    profileContextVersion: 1,
    fromSessionId: rig.seed.sourceSessionId,
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
    ...overrides,
  };
}

function intentValues(
  rig: Rig,
  overrides: Partial<TransitionIntentCreateValues> = {},
): TransitionIntentCreateValues {
  rig.intentSeq += 1;
  const createdAtMs = overrides.createdAt !== undefined ? Date.parse(overrides.createdAt) : rig.t0 + (rig.intentSeq - 1) * 1000;
  return {
    id: `intent-${rig.intentSeq}-${randomUUID()}`,
    householdId: rig.seed.householdId,
    fromSessionId: rig.seed.sourceSessionId,
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
    operationKey: `op-key-${rig.intentSeq}-${randomUUID()}`,
    requestDigest: `digest-${rig.intentSeq}`,
    createdAt: iso(createdAtMs),
    plan: null,
    ...overrides,
  };
}

/** 直插播放会话(preparing/ended;后继/第二来源/回执 FK 素材) */
function insertPlaybackSessionRow(
  rig: Rig,
  input: { readonly sessionId?: string; readonly mediaId?: string; readonly atMs?: number; readonly state?: 'preparing' | 'ended' },
): string {
  rig.sessionSeq += 1;
  const sessionId = input.sessionId ?? `sess-x-${rig.sessionSeq}-${randomUUID()}`;
  const at = iso(input.atMs ?? rig.t0);
  const state = input.state ?? 'preparing';
  const ended = state === 'ended' ? at : null;
  rig.conn
    .prepare(
      `INSERT INTO playback_session (
        id, household_id, device_session_id, device_id, profile_id, media_id,
        playback_source_id, state, delivery, generation, version,
        position_seconds, audio_track_id, subtitle_track_id, desired_paused,
        created_at, started_at, ended_at, last_heartbeat_at, failure_code
      ) VALUES (?, ?, ?, ?, ?, ?, NULL, ?, 'hls_proxy', 1, 1, 0, NULL, NULL, 0, ?, NULL, ?, ?, NULL)`,
    )
    .run(
      sessionId,
      rig.seed.householdId,
      rig.seed.deviceSessionId,
      rig.seed.deviceId,
      rig.seed.profileId,
      input.mediaId ?? rig.seed.targetMediaId,
      state,
      at,
      ended,
      at,
    );
  return sessionId;
}

/** 直插已消费 intent(24h 保留面素材;全 CHECK/FK 满足;可选携带 reserved 槽) */
function seedConsumedIntent(
  rig: Rig,
  input: { readonly expiresAtMs: number; readonly withSlot?: boolean },
): string {
  const id = `intent-consumed-${randomUUID()}`;
  const createdAtMs = input.expiresAtMs - 60_000;
  rig.conn
    .prepare(
      `INSERT INTO playback_transition_intent (
        id, household_id, from_session_id, from_generation, device_session_id, profile_id,
        profile_context_version, action, target_media_id, target_content_revision,
        target_continuity_revision, target_locator_revision, match_revision, match_confidence,
        confirmed_ambiguous, position_mode, carry_position_seconds, carry_duration_seconds,
        source_ledger_seq, source_checkpoint_generation, source_checkpoint_seq,
        allow_earlier_accepted_position, finish_receipt_id, operation_key, request_digest,
        slot_revision, created_at, expires_at, status, successor_id, next_plan_id,
        plan_sequence_revision, plan_detail_revision, plan_history_revision, plan_history_choice_required
      ) VALUES (?, ?, ?, 1, ?, ?, 1, 'manual_next', ?, 1, 1, 1, 1, 'high', 0, 'beginning',
        NULL, NULL, NULL, NULL, NULL, NULL, NULL, ?, ?, 1, ?, ?, 'consumed', NULL, NULL, NULL, NULL, NULL, NULL)`,
    )
    .run(
      id,
      rig.seed.householdId,
      rig.seed.sourceSessionId,
      rig.seed.deviceSessionId,
      rig.seed.profileId,
      rig.seed.targetMediaId,
      `op-consumed-${randomUUID()}`,
      `digest-consumed-${randomUUID()}`,
      iso(createdAtMs),
      iso(input.expiresAtMs),
    );
  if (input.withSlot === true) {
    rig.conn
      .prepare(
        `INSERT INTO playback_transition_slot (household_id, from_session_id, from_generation, slot_revision, status, active_intent_id)
         VALUES (?, ?, 1, 1, 'reserved', ?)`,
      )
      .run(rig.seed.householdId, rig.seed.sourceSessionId, id);
  }
  return id;
}

/** 直插 finish receipt(24h 保留面/next 资格素材) */
function seedFinishReceipt(rig: Rig, input: { readonly sessionId: string; readonly endedAtMs: number }): void {
  rig.conn
    .prepare(
      `INSERT INTO playback_finish_receipt (
        household_id, session_id, device_session_id, profile_context_version, generation,
        operation_key, request_digest, final_seq, final_session_accepted, history_applied,
        history_revision, session_completed, auto_next_eligible, reason, position_seconds,
        duration_seconds, ended_at, content_revision, continuity_revision, locator_revision
      ) VALUES (?, ?, ?, 1, 1, ?, ?, 2, 1, 0, NULL, 1, 1, 'completed', 355, 360, ?, 1, 1, 1)`,
    )
    .run(
      rig.seed.householdId,
      input.sessionId,
      rig.seed.deviceSessionId,
      `op-finish-${randomUUID()}`,
      `digest-finish-${randomUUID()}`,
      iso(input.endedAtMs),
    );
}

/** 来源会话的 ledger 游标与输入绑定(只读来源授权事实素材) */
function seedSourceLedgerAndBinding(rig: Rig): void {
  rig.conn
    .prepare(
      `INSERT INTO playback_progress_state (
        household_id, playback_session_id, profile_id, media_id, candidate_epoch,
        content_revision, profile_context_version, started, last_sample_seq, last_generation, last_result
      ) VALUES (?, ?, ?, ?, 1, 1, 1, 1, 7, 1, NULL)`,
    )
    .run(rig.seed.householdId, rig.seed.sourceSessionId, rig.seed.profileId, rig.seed.sourceMediaId);
  const mediaSourceId = (
    rig.conn.prepare('SELECT id FROM media_source WHERE household_id = ? LIMIT 1').get(rig.seed.householdId) as { id: string }
  ).id;
  rig.conn
    .prepare(
      `INSERT INTO playback_input_binding (
        id, household_id, session_id, generation, playback_source_id, source_id,
        locator_revision, content_revision, resolved_input_id, resolved_at, expires_at,
        start_basis, frozen_start_seconds, cleanup_state
      ) VALUES (?, ?, ?, 1, ?, ?, 1, 1, 'resolved-input-private-id', ?, ?, 'beginning', NULL, 'pending')`,
    )
    .run(
      `binding-${randomUUID()}`,
      rig.seed.householdId,
      rig.seed.sourceSessionId,
      rig.seed.playbackSourceId,
      mediaSourceId,
      iso(rig.t0),
      iso(rig.t0 + 600_000),
    );
}

function expectDomainError(fn: () => unknown, status: number, code: string): DomainError {
  let caught: unknown;
  try {
    fn();
  } catch (error) {
    caught = error;
  }
  expect(caught, `应抛 DomainError(${status} ${code})`).toBeInstanceOf(DomainError);
  const error = caught as DomainError;
  expect(error.status).toBe(status);
  expect(error.code).toBe(code);
  return error;
}

/** 计划冻结快照值集(plan 绑定 intent 用) */
function planSnapshotOf(plan: { readonly id: string; readonly sequenceRevision: number; readonly detailRevision: number; readonly historyRevision: number; readonly historyChoiceRequired: number; readonly expiresAt: string }) {
  return {
    nextPlanId: plan.id,
    sequenceRevision: plan.sequenceRevision,
    detailRevision: plan.detailRevision,
    historyRevision: plan.historyRevision,
    historyChoiceRequired: plan.historyChoiceRequired === 1,
    expiresAt: plan.expiresAt,
  };
}

/* ------------------------------------------------------------------ */
/* A 下一集计划:不可变快照 / TTL 恰 60s / ref 寻址                        */
/* ------------------------------------------------------------------ */

describe('T059 · A 下一集计划持久快照(data-model §10:不可变 60s/ref 寻址)', () => {
  it('A1 [T059-A] 创建落库:expiresAt=createdAt+恰 60s;findByRef 返回精确快照;活计划清单带引用标记', () => {
    const rig = openRig();
    const values = nextPlanValues(rig);
    const row = rig.store.createNextPlan(values);
    expect(row.id).toBe(values.id);
    expect(Date.parse(row.expiresAt) - Date.parse(row.createdAt)).toBe(INTENT_TTL_SECONDS * 1000);
    const byRef = rig.store.findNextPlanByRef(rig.seed.householdId, values.ref);
    expect(byRef, 'ref 寻址应命中计划行').toBeDefined();
    expect(byRef!.targetMediaId).toBe(values.targetMediaId);
    expect(byRef!.sequenceRevision).toBe(values.sequenceRevision);
    expect(byRef!.detailRevision).toBe(values.detailRevision);
    expect(byRef!.historyRevision).toBe(0);
    expect(byRef!.historyChoiceRequired).toBe(0);
    expect(byRef!.fromSessionId).toBe(rig.seed.sourceSessionId);
    expect(byRef!.fromGeneration).toBe(1);
    // ref 清单投影:未引用活计划带 referencedByActiveIntent=false
    const active = rig.store.listActiveNextPlanRows(rig.seed.householdId, rig.seed.deviceSessionId, iso(rig.t0 + 10_000));
    expect(active).toHaveLength(1);
    expect(active[0]!.referencedByActiveIntent).toBe(false);
    // 未知 ref 同形:一律 undefined(上层 404 同形)
    expect(rig.store.findNextPlanByRef(rig.seed.householdId, `missing-${randomUUID()}`)).toBeUndefined();
  });

  it('A2 [T059-A] 快照不可变:ref 解绑不改计划修订/时刻;解绑后 ref 不可寻址而行按 id 保留(清理面回收)', () => {
    const rig = openRig();
    const values = nextPlanValues(rig);
    const plan = rig.store.createNextPlan(values);
    const before = rig.store.findNextPlanByRef(rig.seed.householdId, values.ref)!;
    rig.conn.prepare('UPDATE playback_next_plan SET ref = NULL WHERE household_id = ? AND id = ?').run(rig.seed.householdId, plan.id);
    expect(rig.store.findNextPlanByRef(rig.seed.householdId, values.ref), '解绑后 ref 与未知 ref 同形不可见').toBeUndefined();
    const raw = rig.conn
      .prepare(
        `SELECT sequence_revision AS sequenceRevision, detail_revision AS detailRevision,
                history_revision AS historyRevision, created_at AS createdAt, expires_at AS expiresAt
         FROM playback_next_plan WHERE household_id = ? AND id = ?`,
      )
      .get(rig.seed.householdId, plan.id) as {
      sequenceRevision: number;
      detailRevision: number;
      historyRevision: number;
      createdAt: string;
      expiresAt: string;
    };
    expect(raw.sequenceRevision).toBe(before.sequenceRevision);
    expect(raw.detailRevision).toBe(before.detailRevision);
    expect(raw.historyRevision).toBe(before.historyRevision);
    expect(raw.createdAt).toBe(before.createdAt);
    expect(raw.expiresAt).toBe(before.expiresAt);
    // 计划行仍可按 id 读(消费复核面不受 ref 解绑影响)
    expect(rig.store.findNextPlanById(rig.seed.householdId, plan.id)?.id).toBe(plan.id);
  });
});

/* ------------------------------------------------------------------ */
/* B 每设备 20 活计划上限:最早过期淘汰 + 引用保护(A6 持久等价面)          */
/* ------------------------------------------------------------------ */

describe('T059 · B 每设备 20 活计划上限(data-model §10 引用保留)', () => {
  it('B1 [T059-B] 第 21 个活计划触发淘汰:最早过期未引用计划解绑 ref;受 pending intent 引用计划与新建计划保留;解绑不删行', () => {
    const rig = openRig();
    // 20 个活计划(创建序=过期序:plans[0] 最早)+ 1 个引用 plans[4] 的 pending intent
    const plans: string[] = [];
    for (let index = 0; index < 20; index += 1) {
      plans.push(rig.store.createNextPlan(nextPlanValues(rig)).id);
    }
    const referencedPlanId = plans[4]!;
    const referencedRef = rig.store.findNextPlanById(rig.seed.householdId, referencedPlanId)!.ref;
    rig.store.createTransitionIntent(intentValues(rig, { plan: planSnapshotOf(rig.store.findNextPlanById(rig.seed.householdId, referencedPlanId)!) }), 0);
    expect(
      scalarOf(rig, 'SELECT COUNT(*) AS n FROM playback_next_plan WHERE household_id = ?', rig.seed.householdId),
      '夹具基线:20 个活计划',
    ).toBe(20);
    // 第 21 个(本次新建,受保护):触发上限淘汰
    const created = rig.store.createNextPlan(nextPlanValues(rig), { keepCount: 20 });
    expect(
      scalarOf(rig, 'SELECT COUNT(*) AS n FROM playback_next_plan WHERE household_id = ?', rig.seed.householdId),
      '解绑式淘汰不删行:20 未引用 + 1 受引用 = 21 行(FK 引用完整性)',
    ).toBe(21);
    expect(
      scalarOf(
        rig,
        `SELECT COUNT(*) AS n FROM playback_next_plan p WHERE p.household_id = ? AND p.id NOT IN
         (SELECT next_plan_id FROM playback_transition_intent WHERE household_id = p.household_id AND next_plan_id IS NOT NULL)`,
        rig.seed.householdId,
      ),
      '上限语义对未引用计划生效(恰 20)',
    ).toBe(20);
    expect(rig.store.findNextPlanByRef(rig.seed.householdId, rig.store.findNextPlanById(rig.seed.householdId, plans[0]!)!.ref!), '最早过期未引用计划应被淘汰(解绑 ref)').toBeUndefined();
    expect(rawPlanByRef(rig, rig.store.findNextPlanById(rig.seed.householdId, plans[0]!)!.ref!), '淘汰=解绑 ref,行保留(T062 清理面回收)').toBeUndefined();
    expect(rig.store.findNextPlanByRef(rig.seed.householdId, referencedRef!), '受引用计划不得被配额淘汰').toBeDefined();
    expect(rig.store.findNextPlanByRef(rig.seed.householdId, created.ref!), '本次新建计划保留').toBeDefined();
  });

  it('B2 [T059-B] 引用保护优先:最早过期计划恰被引用时,淘汰顺延到下一个未引用计划', () => {
    const rig = openRig();
    const plans: string[] = [];
    for (let index = 0; index < 20; index += 1) {
      plans.push(rig.store.createNextPlan(nextPlanValues(rig)).id);
    }
    rig.store.createTransitionIntent(intentValues(rig, { plan: planSnapshotOf(rig.store.findNextPlanById(rig.seed.householdId, plans[0]!)!) }), 0);
    rig.store.createNextPlan(nextPlanValues(rig), { keepCount: 20 });
    const firstRef = rig.store.findNextPlanById(rig.seed.householdId, plans[0]!)!.ref!;
    const secondRef = rig.store.findNextPlanById(rig.seed.householdId, plans[1]!)!.ref!;
    expect(rig.store.findNextPlanByRef(rig.seed.householdId, firstRef), '最早过期但受引用:保留').toBeDefined();
    expect(rig.store.findNextPlanByRef(rig.seed.householdId, secondRef), '淘汰顺延至次早未引用计划').toBeUndefined();
  });

  it('B3 [T059-B] 未超上限不淘汰;引用标记随意图状态推进(pending 保护,cancelled 不再保护)', () => {
    const rig = openRig();
    const plan = rig.store.createNextPlan(nextPlanValues(rig), { keepCount: 20 });
    expect(scalarOf(rig, 'SELECT COUNT(*) AS n FROM playback_next_plan WHERE household_id = ?', rig.seed.householdId)).toBe(1);
    const outcome = rig.store.createTransitionIntent(intentValues(rig, { plan: planSnapshotOf(plan) }), 0);
    expect(outcome.kind).toBe('created');
    let active = rig.store.listActiveNextPlanRows(rig.seed.householdId, rig.seed.deviceSessionId, iso(rig.t0 + 10_000));
    expect(active).toHaveLength(1);
    expect(active[0]!.referencedByActiveIntent).toBe(true);
    const intentId = (outcome as Extract<typeof outcome, { kind: 'created' }>).intent.id;
    const cancelOutcome = rig.store.cancelTransitionIntent(rig.seed.householdId, intentId, iso(rig.t0 + 5_000));
    expect(cancelOutcome.kind).toBe('cancelled');
    active = rig.store.listActiveNextPlanRows(rig.seed.householdId, rig.seed.deviceSessionId, iso(rig.t0 + 10_000));
    expect(active).toHaveLength(1);
    expect(active[0]!.referencedByActiveIntent, 'cancelled 引用不再受保护(仅 pending/consumed)').toBe(false);
  });
});

/* ------------------------------------------------------------------ */
/* C 槽初始 revision / CAS 输赢 / consumed 永久                          */
/* ------------------------------------------------------------------ */

describe('T059 · C 单后继槽与 CAS(data-model §7;playback-state §7)', () => {
  it('C1 [T059-C] 首键创建:expected=0(响应默认)→ 槽 reserved/revision=1 持久行;intent 冻结计划快照;TTL 恰 60s', () => {
    const rig = openRig();
    const plan = rig.store.createNextPlan(nextPlanValues(rig, { createdAt: iso(rig.t0) }));
    const outcome = rig.store.createTransitionIntent(
      intentValues(rig, { createdAt: iso(rig.t0), plan: planSnapshotOf(plan) }),
      0,
    );
    expect(outcome.kind).toBe('created');
    const created = outcome as Extract<typeof outcome, { kind: 'created' }>;
    expect(created.slot.status).toBe('reserved');
    expect(created.slot.slotRevision, '持久行 revision>=1(0/open 只作响应默认)').toBe(1);
    expect(created.slot.activeIntentId).toBe(created.intent.id);
    expect(created.intent.status).toBe('pending');
    expect(created.intent.slotRevision).toBe(1);
    expect(created.intent.nextPlanId).toBe(plan.id);
    expect(created.intent.planSequenceRevision).toBe(plan.sequenceRevision);
    expect(created.intent.planDetailRevision).toBe(plan.detailRevision);
    expect(created.intent.planHistoryRevision).toBe(plan.historyRevision);
    expect(created.intent.planHistoryChoiceRequired).toBe(0);
    expect(created.intent.expiresAt, 'TTL 恰 60s(计划同期时无夹取)').toBe(iso(rig.t0 + 60_000));
    // 响应默认形态:无槽行时 findSlot=undefined(0/open 由响应层合成)
    expect(rig.store.findSlot(rig.seed.householdId, `no-such-session-${randomUUID()}`, 1)).toBeUndefined();
  });

  it('C2 [T059-C] ensureOpenSlot 幂等:首建 open/rev1;重复 ensure 不 bump、不改状态', () => {
    const rig = openRig();
    const first = rig.store.ensureOpenSlot(rig.seed.householdId, rig.seed.sourceSessionId, 1);
    expect(first.status).toBe('open');
    expect(first.slotRevision).toBe(1);
    const second = rig.store.ensureOpenSlot(rig.seed.householdId, rig.seed.sourceSessionId, 1);
    expect(second).toEqual(first);
  });

  it('C3 [T059-C] CAS 输家:陈旧(0)/超前(99) expected → slot_conflict,零写入(intent 不落、槽不动)', () => {
    const rig = openRig();
    rig.store.createNextPlan(nextPlanValues(rig));
    const win = rig.store.createTransitionIntent(intentValues(rig), 0);
    expect(win.kind).toBe('created');
    const intentCountBefore = scalarOf(rig, 'SELECT COUNT(*) AS n FROM playback_transition_intent WHERE household_id = ?', rig.seed.householdId);
    for (const stale of [0, 99]) {
      const lose = rig.store.createTransitionIntent(intentValues(rig), stale);
      expect(lose.kind, `expected=${stale} 应为槽 CAS 输家`).toBe('slot_conflict');
      const conflict = lose as Extract<typeof lose, { kind: 'slot_conflict' }>;
      expect(conflict.slot?.slotRevision).toBe(1);
      expect(conflict.slot?.status).toBe('reserved');
    }
    expect(
      scalarOf(rig, 'SELECT COUNT(*) AS n FROM playback_transition_intent WHERE household_id = ?', rig.seed.householdId),
      '冲突路径不落 intent',
    ).toBe(intentCountBefore);
    expect(rig.store.findSlot(rig.seed.householdId, rig.seed.sourceSessionId, 1)?.slotRevision).toBe(1);
  });

  it('C4 [T059-C] 显式替换(B5 等价):expected=1 命中 reserved → 旧 intent superseded、新 intent rev2、槽 active 翻转', () => {
    const rig = openRig();
    rig.store.createNextPlan(nextPlanValues(rig));
    const first = rig.store.createTransitionIntent(intentValues(rig), 0) as Extract<
      ReturnType<PlaybackTransitionStore['createTransitionIntent']>,
      { kind: 'created' }
    >;
    const second = rig.store.createTransitionIntent(intentValues(rig, { position: { mode: 'target_history' } }), 1);
    expect(second.kind).toBe('created');
    const replaced = second as Extract<typeof second, { kind: 'created' }>;
    expect(replaced.intent.id).not.toBe(first.intent.id);
    expect(replaced.slot.slotRevision).toBe(2);
    expect(replaced.slot.activeIntentId).toBe(replaced.intent.id);
    expect(rig.store.findIntentById(rig.seed.householdId, first.intent.id)?.status).toBe('superseded');
    // 旧 intent 终态不可逆:原语对 superseded 不命中
    expect(rig.store.markIntentSuperseded(rig.seed.householdId, first.intent.id)).toBe(0);
  });

  it('C5 [T059-C] consumed 永久:消费不 bump revision;consumed 槽任何新 key CAS 信号携带原后继;二次消费/复活原语全部拒绝', () => {
    const rig = openRig();
    rig.store.createNextPlan(nextPlanValues(rig));
    const created = rig.store.createTransitionIntent(intentValues(rig), 0) as Extract<
      ReturnType<PlaybackTransitionStore['createTransitionIntent']>,
      { kind: 'created' }
    >;
    const successorId = insertPlaybackSessionRow(rig, { sessionId: `sess-succ-${randomUUID()}` });
    const consumed = rig.store.consumeTransition(rig.seed.householdId, created.intent.id, successorId, iso(rig.t0 + 1000));
    expect(consumed.kind).toBe('consumed');
    const done = consumed as Extract<typeof consumed, { kind: 'consumed' }>;
    expect(done.slot.status).toBe('consumed');
    expect(done.slot.successorSessionId).toBe(successorId);
    expect(done.slot.slotRevision, '消费不 bump 槽 revision(仅替换/取消 bump)').toBe(1);
    expect(done.intent.status).toBe('consumed');
    expect(done.intent.successorId).toBe(successorId);
    // consumed 槽永久:任何新 key CAS 输家并携带原后继引用(api §5 附原后继)
    const again = rig.store.createTransitionIntent(intentValues(rig), 1);
    expect(again.kind).toBe('slot_conflict');
    expect((again as Extract<typeof again, { kind: 'slot_conflict' }>).slot?.successorSessionId).toBe(successorId);
    expect(
      scalarOf(rig, 'SELECT COUNT(*) AS n FROM playback_transition_intent WHERE household_id = ?', rig.seed.householdId),
      'consumed 槽不得再建第二 intent',
    ).toBe(1);
    // 二次消费/取消/consumed 原语:全部拒绝或幂等,不产生第二后继
    const secondConsume = rig.store.consumeTransition(rig.seed.householdId, created.intent.id, insertPlaybackSessionRow(rig, {}), iso(rig.t0 + 2000));
    expect(secondConsume.kind).toBe('conflict');
    expect((secondConsume as Extract<typeof secondConsume, { kind: 'conflict' }>).reason).toBe('intent_not_pending');
    expect(rig.store.markIntentConsumed(rig.seed.householdId, created.intent.id, insertPlaybackSessionRow(rig, {}))).toBe(0);
    expect(rig.store.consumeSlot(rig.seed.householdId, rig.seed.sourceSessionId, 1, 1, created.intent.id, insertPlaybackSessionRow(rig, {}))).toBeUndefined();
  });

  it('C6 [T059-C] 槽原语 CAS:consumeSlot/releaseSlot 期望失配输家 undefined 且零写入', () => {
    const rig = openRig();
    rig.store.createNextPlan(nextPlanValues(rig));
    const created = rig.store.createTransitionIntent(intentValues(rig), 0) as Extract<
      ReturnType<PlaybackTransitionStore['createTransitionIntent']>,
      { kind: 'created' }
    >;
    expect(rig.store.releaseSlot(rig.seed.householdId, rig.seed.sourceSessionId, 1, 99), 'release 陈旧 expected 输家').toBeUndefined();
    expect(
      rig.store.consumeSlot(rig.seed.householdId, rig.seed.sourceSessionId, 1, 1, `wrong-intent-${randomUUID()}`, insertPlaybackSessionRow(rig, {})),
      'consume intent 不符输家',
    ).toBeUndefined();
    const released = rig.store.releaseSlot(rig.seed.householdId, rig.seed.sourceSessionId, 1, 1);
    expect(released?.status).toBe('open');
    expect(released?.slotRevision).toBe(2);
    expect(rig.store.findIntentById(rig.seed.householdId, created.intent.id)?.status).toBe('pending');
  });
});

/* ------------------------------------------------------------------ */
/* D intent 五态迁移 / scope 幂等 / TTL 固定                              */
/* ------------------------------------------------------------------ */

describe('T059 · D intent 五态与 scope 幂等(data-model §7;api §5)', () => {
  it('D1 [T059-D] pending → cancelled:槽 open+revision+1;重复取消 already_cancelled 幂等不再变化', () => {
    const rig = openRig();
    rig.store.createNextPlan(nextPlanValues(rig));
    const created = rig.store.createTransitionIntent(intentValues(rig), 0) as Extract<
      ReturnType<PlaybackTransitionStore['createTransitionIntent']>,
      { kind: 'created' }
    >;
    const cancel = rig.store.cancelTransitionIntent(rig.seed.householdId, created.intent.id, iso(rig.t0 + 5000));
    expect(cancel).toEqual({ kind: 'cancelled', slotRevision: 2 });
    const repeat = rig.store.cancelTransitionIntent(rig.seed.householdId, created.intent.id, iso(rig.t0 + 6000));
    expect(repeat).toEqual({ kind: 'already_cancelled', slotRevision: 2 });
    expect(rig.store.findSlot(rig.seed.householdId, rig.seed.sourceSessionId, 1)?.slotRevision).toBe(2);
    expect(rig.store.findSlot(rig.seed.householdId, rig.seed.sourceSessionId, 1)?.activeIntentId).toBeNull();
    // 取消后原语不可逆
    expect(rig.store.markIntentCancelled(rig.seed.householdId, created.intent.id)).toBe(0);
  });

  it('D2 [T059-D] pending 过 TTL → cancel 判 expired:意图标 expired、槽释放 open;已标 expired 重复取消幂等', () => {
    const rig = openRig();
    rig.store.createNextPlan(nextPlanValues(rig));
    const created = rig.store.createTransitionIntent(
      intentValues(rig, { createdAt: iso(rig.t0 - 61_000) }),
      0,
    ) as Extract<ReturnType<PlaybackTransitionStore['createTransitionIntent']>, { kind: 'created' }>;
    const cancel = rig.store.cancelTransitionIntent(rig.seed.householdId, created.intent.id, iso(rig.t0));
    expect(cancel.kind).toBe('expired');
    expect((cancel as Extract<typeof cancel, { kind: 'expired' }>).slotRevision).toBe(2);
    expect(rig.store.findIntentById(rig.seed.householdId, created.intent.id)?.status).toBe('expired');
    expect(rig.store.findSlot(rig.seed.householdId, rig.seed.sourceSessionId, 1)?.status).toBe('open');
    const repeat = rig.store.cancelTransitionIntent(rig.seed.householdId, created.intent.id, iso(rig.t0 + 1000));
    expect(repeat).toEqual({ kind: 'expired', slotRevision: 2 });
  });

  it('D3 [T059-D] 取消 superseded 输家:outcome superseded、槽归替换者不变;取消 consumed → already_consumed 携原后继(D5 等价)', () => {
    const rig = openRig();
    rig.store.createNextPlan(nextPlanValues(rig));
    const first = rig.store.createTransitionIntent(intentValues(rig), 0) as Extract<
      ReturnType<PlaybackTransitionStore['createTransitionIntent']>,
      { kind: 'created' }
    >;
    rig.store.createTransitionIntent(intentValues(rig), 1);
    const loser = rig.store.cancelTransitionIntent(rig.seed.householdId, first.intent.id, iso(rig.t0 + 5000));
    expect(loser).toEqual({ kind: 'superseded', slotRevision: 2 });
    expect(rig.store.findSlot(rig.seed.householdId, rig.seed.sourceSessionId, 1)?.status).toBe('reserved');
    // consumed 后取消输家:返回原后继引用,槽 revision 不变(消费不 bump)
    const successorId = insertPlaybackSessionRow(rig, { sessionId: `sess-succ-${randomUUID()}` });
    const second = rig.store.createTransitionIntent(intentValues(rig, { createdAt: iso(rig.t0 + 10_000) }), 2) as Extract<
      ReturnType<PlaybackTransitionStore['createTransitionIntent']>,
      { kind: 'created' }
    >;
    rig.store.consumeTransition(rig.seed.householdId, second.intent.id, successorId, iso(rig.t0 + 11_000));
    const afterConsume = rig.store.cancelTransitionIntent(rig.seed.householdId, second.intent.id, iso(rig.t0 + 12_000));
    expect(afterConsume).toEqual({ kind: 'already_consumed', successorSessionId: successorId, slotRevision: 3 });
  });

  it('D4 [T059-D] scope 幂等:同 key 同摘要 replayed 不续 TTL;异摘要 idempotency_conflict;异 contextVersion 同 key 独立成行', () => {
    const rig = openRig();
    rig.store.createNextPlan(nextPlanValues(rig));
    const values = intentValues(rig, { createdAt: iso(rig.t0) });
    const first = rig.store.createTransitionIntent(values, 0) as Extract<
      ReturnType<PlaybackTransitionStore['createTransitionIntent']>,
      { kind: 'created' }
    >;
    // 同 key 同摘要:replayed 返回原行,expiresAt 逐字不变(重试不续期)
    const replay = rig.store.createTransitionIntent({ ...values, id: `intent-replay-${randomUUID()}` }, 0);
    expect(replay.kind).toBe('replayed');
    expect((replay as Extract<typeof replay, { kind: 'replayed' }>).intent.id).toBe(first.intent.id);
    expect((replay as Extract<typeof replay, { kind: 'replayed' }>).intent.expiresAt).toBe(first.intent.expiresAt);
    expect(scalarOf(rig, 'SELECT COUNT(*) AS n FROM playback_transition_intent WHERE household_id = ?', rig.seed.householdId)).toBe(1);
    // 同 key 异摘要:冲突判定输入(既有行原样携带;槽不动)
    const conflict = rig.store.createTransitionIntent({ ...values, requestDigest: 'digest-different' }, 0);
    expect(conflict.kind).toBe('idempotency_conflict');
    expect((conflict as Extract<typeof conflict, { kind: 'idempotency_conflict' }>).existing.id).toBe(first.intent.id);
    expect(rig.store.findSlot(rig.seed.householdId, rig.seed.sourceSessionId, 1)?.slotRevision).toBe(1);
    // scope=家庭/DeviceSession/contextVersion/operationKey:旧 context(A→B→A)同 key 是新 scope;
    // 槽 CAS 按当前 revision 显式替换 → 独立成行
    const oldContext = rig.store.createTransitionIntent({ ...values, id: `intent-oldctx-${randomUUID()}`, profileContextVersion: 2 }, 1);
    expect(oldContext.kind, 'contextVersion 参与 scope:不等即独立行').toBe('created');
    expect(
      scalarOf(rig, 'SELECT COUNT(*) AS n FROM playback_transition_intent WHERE household_id = ?', rig.seed.householdId),
    ).toBe(2);
  });

  it('D5 [T059-D] TTL 夹取:计划早于 60s 时 intent expiresAt=计划 expiresAt(api §7 较早者);过期计划建 intent → 410 NEXT_PLAN_EXPIRED', () => {
    const rig = openRig();
    const earlyPlan = rig.store.createNextPlan(nextPlanValues(rig, { createdAt: iso(rig.t0 - 30_000) }));
    const clamped = rig.store.createTransitionIntent(
      intentValues(rig, { createdAt: iso(rig.t0), plan: planSnapshotOf(earlyPlan) }),
      0,
    );
    expect(clamped.kind).toBe('created');
    expect((clamped as Extract<typeof clamped, { kind: 'created' }>).intent.expiresAt).toBe(earlyPlan.expiresAt);
    // 过期计划:夹出非正窗口 → 410(过期不再允许新建意图;A3 持久等价面)
    const expiredPlan = rig.store.createNextPlan(nextPlanValues(rig, { createdAt: iso(rig.t0 - 120_000) }));
    expectDomainError(
      () =>
        rig.store.createTransitionIntent(
          intentValues(rig, { createdAt: iso(rig.t0), plan: planSnapshotOf(expiredPlan) }),
          0,
        ),
      410,
      ProblemCode.NEXT_PLAN_EXPIRED,
    );
    expect(
      scalarOf(rig, 'SELECT COUNT(*) AS n FROM playback_transition_intent WHERE household_id = ?', rig.seed.householdId),
      '过期计划拒绝不落 intent',
    ).toBe(1);
  });

  it('D6 [T059-D] watchdog 批量过期:pending 过 TTL → expired + 槽释放;未过期/已消费不动', () => {
    const rig = openRig();
    rig.store.createNextPlan(nextPlanValues(rig));
    // 过期 pending(占槽 1)+ 未过期 pending(占第二来源会话的槽 2)+ 已消费素材
    const staleIntent = rig.store.createTransitionIntent(
      intentValues(rig, { createdAt: iso(rig.t0 - 61_000) }),
      0,
    ) as Extract<ReturnType<PlaybackTransitionStore['createTransitionIntent']>, { kind: 'created' }>;
    const secondSession = insertPlaybackSessionRow(rig, { sessionId: `sess-src2-${randomUUID()}`, mediaId: rig.seed.sourceMediaId });
    const freshIntent = rig.store.createTransitionIntent(
      intentValues(rig, { createdAt: iso(rig.t0 + 61_000), fromSessionId: secondSession }),
      0,
    ) as Extract<ReturnType<PlaybackTransitionStore['createTransitionIntent']>, { kind: 'created' }>;
    seedConsumedIntent(rig, { expiresAtMs: rig.t0 - 120_000 });
    const flipped = rig.store.markExpiredPendingIntents(iso(rig.t0 + 60_000));
    expect(flipped, '仅过期 pending 被翻转').toBe(1);
    expect(rig.store.findIntentById(rig.seed.householdId, staleIntent.intent.id)?.status).toBe('expired');
    const slot1 = rig.store.findSlot(rig.seed.householdId, rig.seed.sourceSessionId, 1);
    expect(slot1?.status).toBe('open');
    expect(slot1?.slotRevision, '过期释放 open+revision+1').toBe(2);
    expect(rig.store.findIntentById(rig.seed.householdId, freshIntent.intent.id)?.status).toBe('pending');
    expect(rig.store.findSlot(rig.seed.householdId, secondSession, 1)?.status).toBe('reserved');
    expect(
      scalarOf(rig, "SELECT COUNT(*) AS n FROM playback_transition_intent WHERE status = 'expired' AND expires_at <= ?", iso(rig.t0 + 60_000)),
      '已消费行不被 watchdog 翻转',
    ).toBe(1);
  });
});

/* ------------------------------------------------------------------ */
/* E 24h 消费结果保护(data-model §9;T062 清理面输入)                      */
/* ------------------------------------------------------------------ */

describe('T059 · E 24h 保留与清理面(data-model §9)', () => {
  it('E1 [T059-E] 消费结果保留窗:consumed intent/slot 超 24h 才列入清理;窗内保留;receipt 按 ended_at 同窗', () => {
    const rig = openRig();
    const cutoff = iso(rig.t0);
    const expiredIntentId = seedConsumedIntent(rig, { expiresAtMs: rig.t0 - 25 * 3600_000, withSlot: true });
    const protectedIntentId = seedConsumedIntent(rig, { expiresAtMs: rig.t0 - 23 * 3600_000 });
    const readyIntents = rig.store.listConsumedIntentsReadyForCleanup(cutoff);
    expect(readyIntents.map((row) => row.id)).toContain(expiredIntentId);
    expect(readyIntents.map((row) => row.id), '24h 窗内不列入').not.toContain(protectedIntentId);
    const readySlots = rig.store.listConsumedSlotsReadyForCleanup(cutoff);
    expect(readySlots.map((row) => row.activeIntentId)).toContain(expiredIntentId);
    expect(readySlots.map((row) => row.activeIntentId), '窗内 consumed 槽不列入').not.toContain(protectedIntentId);
    // finish receipt:ended_at 超 24h 列入,窗内保留
    const oldReceiptSession = insertPlaybackSessionRow(rig, { state: 'ended', atMs: rig.t0 - 26 * 3600_000 });
    seedFinishReceipt(rig, { sessionId: oldReceiptSession, endedAtMs: rig.t0 - 25 * 3600_000 });
    seedFinishReceipt(rig, { sessionId: rig.seed.sourceSessionId, endedAtMs: rig.t0 - 3600_000 });
    const readyReceipts = rig.store.listFinishReceiptsReadyForCleanup(cutoff).map((row) => row.sessionId);
    expect(readyReceipts).toContain(oldReceiptSession);
    expect(readyReceipts, '24h 窗内 receipt 保留').not.toContain(rig.seed.sourceSessionId);
  });

  it('E2 [T059-E] receipt 幂等:session 唯一,重复写返回原行 created=false(终态不得由新 finish 升级)', () => {
    const rig = openRig();
    const values: FinishReceiptInsertValues = {
      householdId: rig.seed.householdId,
      sessionId: rig.seed.sourceSessionId,
      deviceSessionId: rig.seed.deviceSessionId,
      profileContextVersion: 1,
      generation: 1,
      operationKey: `op-finish-${randomUUID()}`,
      requestDigest: `digest-finish-${randomUUID()}`,
      finalSeq: 2,
      finalSessionAccepted: true,
      historyApplied: false,
      historyRevision: null,
      sessionCompleted: true,
      autoNextEligible: true,
      reason: 'completed',
      positionSeconds: 355,
      durationSeconds: 360,
      endedAt: iso(rig.t0),
      contentRevision: 1,
      continuityRevision: 1,
      locatorRevision: 1,
    };
    const first = rig.store.insertFinishReceiptIfAbsent(values);
    expect(first.created).toBe(true);
    expect(first.receipt.autoNextEligible).toBe(1);
    const second = rig.store.insertFinishReceiptIfAbsent({ ...values, finalSeq: 9, autoNextEligible: false });
    expect(second.created).toBe(false);
    expect(second.receipt.finalSeq, '既有回执不被升级').toBe(first.receipt.finalSeq);
    expect(second.receipt.autoNextEligible).toBe(1);
    expect(rig.store.findFinishReceiptBySession(rig.seed.householdId, rig.seed.sourceSessionId)?.sessionId).toBe(rig.seed.sourceSessionId);
  });
});

/* ------------------------------------------------------------------ */
/* F 同上下文终态只读来源授权(transition-source-context.service)          */
/* ------------------------------------------------------------------ */

describe('T059 · F 只读来源上下文授权(playback-state §5:绝不重新发源票)', () => {
  it('F1 [T059-F] 同上下文(设备/Profile/context 全等)→ 只读事实(会话/绑定/receipt/ledger);产物键集不含任何票据/交付材料', () => {
    const rig = openRig();
    seedSourceLedgerAndBinding(rig);
    seedFinishReceipt(rig, { sessionId: rig.seed.sourceSessionId, endedAtMs: rig.t0 });
    const context = rig.sourceContext.authorizeReadonlySourceContext({
      householdId: rig.seed.householdId,
      deviceSessionId: rig.seed.deviceSessionId,
      profileId: rig.seed.profileId,
      profileContextVersion: 1,
      fromSessionId: rig.seed.sourceSessionId,
    });
    // 终态也可读:ended 来源返回完整只读事实
    expect(context.fromSessionId).toBe(rig.seed.sourceSessionId);
    expect(context.state).toBe('ended');
    expect(context.generation).toBe(1);
    expect(context.mediaId).toBe(rig.seed.sourceMediaId);
    expect(context.endedAt).not.toBeNull();
    expect(context.finishReceipt?.autoNextEligible).toBe(1);
    expect(context.inputBinding?.playbackSourceId).toBe(rig.seed.playbackSourceId);
    expect(context.ledgerCheckpoint?.lastSampleSeq).toBe(7);
    // 票面拒绝:输出键集只含事实投影,无 ticket/token/url/delivery 授权材料
    expect(Object.keys(context).sort()).toEqual(
      ['endedAt', 'finishReceipt', 'fromSessionId', 'generation', 'inputBinding', 'ledgerCheckpoint', 'mediaId', 'state'].sort(),
    );
    expect(JSON.stringify(context), '只读事实不得携带票据/入口地址材料').not.toMatch(/token|ticket|playbackUrl|entryUrl/i);
  });

  it('F2 [T059-F] 跨设备/跨 Profile/context 不等(A→B→A)/未知会话 → 一律 404 同形(不可判别存在性)', () => {
    const rig = openRig();
    const base = {
      householdId: rig.seed.householdId,
      deviceSessionId: rig.seed.deviceSessionId,
      profileId: rig.seed.profileId,
      profileContextVersion: 1,
      fromSessionId: rig.seed.sourceSessionId,
    };
    const rejections: DomainError[] = [
      expectDomainError(
        () => rig.sourceContext.authorizeReadonlySourceContext({ ...base, deviceSessionId: `dsess-other-${randomUUID()}` }),
        404,
        ProblemCode.PLAYBACK_NOT_FOUND,
      ),
      expectDomainError(
        () => rig.sourceContext.authorizeReadonlySourceContext({ ...base, profileId: `prof-other-${randomUUID()}` }),
        404,
        ProblemCode.PLAYBACK_NOT_FOUND,
      ),
      expectDomainError(
        () => rig.sourceContext.authorizeReadonlySourceContext({ ...base, profileContextVersion: 2 }),
        404,
        ProblemCode.PLAYBACK_NOT_FOUND,
      ),
      expectDomainError(
        () => rig.sourceContext.authorizeReadonlySourceContext({ ...base, fromSessionId: `sess-missing-${randomUUID()}` }),
        404,
        ProblemCode.PLAYBACK_NOT_FOUND,
      ),
    ];
    for (const rejection of rejections) {
      expect(rejection.status).toBe(404);
      expect(rejection.code, '身份失配与不存在同形(不借错误判别存在性)').toBe(rejections[0]!.code);
    }
    // seam 可用性:绑定后 transitionStore() 即同一 store 实例
    expect(transitionStore()).toBe(rig.store);
  });
});
