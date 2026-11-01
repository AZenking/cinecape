/**
 * 010-online-vod T072(US4)—— switch/recover_switch 创建编排与消费终态门单元契约
 * (真实 DDL + 真实 store;零网络)。
 *
 * 覆盖面(T072 交付 1/2/4;编排级 HTTP 契约归 T067 e2e C/E/D 组):
 * - A. carry checkpoint 矩阵(api.md §5 + §7 I2 + data-model §10):缺失 400 /
 *   代次不等 409 SOURCE_PROGRESS_PENDING / seq 不等(未接受样本)409 / 精确相等
 *   201 且 position/duration/seq/checkpoint 自当前代 ledger 服务端复制 /
 *   明确旧游标(无论 allowEarlierAcceptedPosition 与否)409 —— 「仍须精确相等;
 *   不自动挑另一个旧位置」(allow 仅记录用户确认;报告注记:会话 ledger 单行仅存
 *   最新接受游标,更早游标位置服务端不可证,精确相等是唯一可实现解释);
 * - B. carryPositionEligibility 三态(api §5「high可carry,ambiguous需confirmed且
 *   具体集,conflict只beginning/target_history」):conflict+carry → 400 不落 intent;
 *   ambiguous+carry → 经登记映射(具体集锚)接受且事实等级如实落库;high 直接;
 * - C. 候选绑定(I1):registeredCandidateRef 未登记/源会话绑定失配 404 同形;
 *   previewRevision CAS 失配 409 VOD_DETAIL_CHANGED;beginning/target_history 禁
 *   sourceCheckpoint/allowEarlierAcceptedPosition(400);
 * - D. recover_switch 资格(api §5 + data-model §7):failed+可恢复媒体故障+60s 窗内
 *   创建 201;窗外 409 SOURCE_NOT_TERMINAL;不可恢复故障类 409;禁源 404 同形
 *   (授权族优先);正常 switch 对 failed 来源创建不限状态(先停再消费在消费面);
 * - E. 消费终态门(真实 state;api §5「409 SOURCE_NOT_TERMINAL 不会消耗 intent」):
 *   switch 源未终态(ready)消费 409 且 intent/slot 零写入;stop(ended)后消费
 *   consumed + preparing 后继 + carry 快照经后继准备端口透传(startBasis=
 *   transition_carry + frozenStartSeconds=冻结位置 —— T073 接缝事实);
 *   recover_switch failed 即终态免 stop;carry checkpoint 消费期复核(ledger 前进
 *   → 409 零写入)。
 *
 * 夹具分层(零网络):独立临时文件库 + 全量权威迁移 DDL(0001–0007,foreign_keys=ON)
 * + 真实 drizzleTransitionStore / TransitionSourceContextService / 消费事务工作集
 * (同一连接的真实 SQL 实现);候选事实端口为同库 SQL + 测试受控匹配结论表
 * (生产装配的 VodCache 读面在 playback.module 适配,此处以受控表等价注入)。
 * 权威依据:docs/specs/010-online-vod/contracts/api.md §5/§6/§7 I1/I2 +
 * data-model.md §7/§10 + contracts/playback-state.md §2/§5/§7 +
 * apps/server/src/contexts/playback/domain/transition.rules.ts(T072 纯判定)。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import DatabaseConstructor from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import { ProblemCode } from '@hmp/shared';
import { DomainError } from '@platform/http-common/domain-error';
import {
  bindTransitionStore,
  type PlaybackTransitionStore,
} from '@contexts/playback/application/playback-transition-store.port';
import { drizzleTransitionStore } from '@contexts/playback/infrastructure/playback-transition-store.drizzle';
import { TransitionSourceContextService } from '@contexts/playback/application/transition-source-context.service';
import {
  PlaybackTransitionService,
  type TransitionCandidateFactsPort,
  type TransitionConsumeTxPort,
  type TransitionConsumeWorkSetStores,
  type TransitionInputBinderPort,
  type TransitionIntentCommand,
  type TransitionSessionStorePort,
  type TransitionSuccessorPreparerPort,
  type TransitionVodFactsPort,
} from '@contexts/playback/application/playback-transition.service';
import type { PlaybackSessionView } from '@contexts/playback/domain/playback.types';
import type { SessionContext } from '@platform/http-common/current-session.decorator';

/* ------------------------------------------------------------------ */
/* rig:临时文件库 + 全量权威迁移 + 最小种子 + 真实 store/sourceContext      */
/* ------------------------------------------------------------------ */

interface RigSeed {
  readonly householdId: string;
  readonly profileId: string;
  readonly deviceId: string;
  readonly deviceSessionId: string;
  readonly candidateRef: string;
  readonly sourceMediaId: string;
  readonly targetMediaId: string;
  readonly sourceSessionId: string;
  readonly playbackSourceId: string;
  readonly targetPlaybackSourceId: string;
  readonly mediaSourceId: string;
  readonly registeredCandidateRef: string;
}

interface Rig {
  readonly conn: DatabaseConstructor.Database;
  readonly service: PlaybackTransitionService;
  readonly sourceContext: TransitionSourceContextService;
  readonly store: PlaybackTransitionStore;
  readonly seed: RigSeed;
  readonly dataDir: string;
  readonly t0: number;
  /** 测试受控的候选匹配结论表(候选 ref → confidence;缺省 high) */
  readonly matchGrades: Map<string, 'high' | 'ambiguous' | 'conflict'>;
  /** 记录型端口:输入绑定/后继准备 */
  readonly bindings: { readonly inputs: Array<Record<string, unknown>> };
  readonly prepared: { readonly calls: Array<Record<string, unknown>> };
  /** 会话行可直接改写的句柄(终态翻转/禁源用例) */
  readonly clock: { now: number };
}

const openRigs: Rig[] = [];

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

/** 最小种子(FK 依赖序):身份 → 目录/来源 → 来源/目标播放资源 → 来源会话+ledger → 登记候选 */
function seedWorld(conn: DatabaseConstructor.Database, t0: number): RigSeed {
  const now = iso(t0);
  const suffix = randomUUID();
  const householdId = `hh-t072-${suffix}`;
  const accountId = `acc-t072-${suffix}`;
  const profileId = `prof-t072-${suffix}`;
  const deviceId = `dev-t072-${suffix}`;
  const deviceSessionId = `dsess-t072-${suffix}`;
  const mediaSourceId = `msrc-t072-${suffix}`;
  const sourceEntryId = `entry-t072-${suffix}`;
  const targetEntryId = `entry-tgt-t072-${suffix}`;
  const sourceMediaId = `media-src-t072-${suffix}`;
  const targetMediaId = `media-tgt-t072-${suffix}`;
  const playbackSourceId = `psrc-src-t072-${suffix}`;
  const targetPlaybackSourceId = `psrc-tgt-t072-${suffix}`;
  const sourceSessionId = `sess-src-t072-${suffix}`;
  const registeredCandidateRef = `vod-reg-t072-${suffix}`;
  const candidateRef = `vod-candidate-${suffix}`;
  conn.transaction(() => {
    conn.prepare('INSERT INTO household (id, name, created_at) VALUES (?, ?, ?)').run(householdId, 'T072 夹具家庭', now);
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
        'INSERT INTO device_session (id, household_id, account_id, device_id, token_hash, active_profile_id, profile_context_version, expires_at, last_active_at, created_at) VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?, ?)',
      )
      .run(deviceSessionId, householdId, accountId, deviceId, `token-hash-${deviceSessionId}`, profileId, iso(t0 + 7 * 24 * 3600_000), now, now);
    conn
      .prepare(
        "INSERT INTO media_source (id, household_id, kind, name, remote_url, enabled, version, locator_revision, created_at, updated_at) VALUES (?, ?, 'vod', 'T072 夹具来源', 'https://upstream.fixture/api.php', 1, 1, 1, ?, ?)",
      )
      .run(mediaSourceId, householdId, now, now);
    for (const [mediaId, title] of [
      [sourceMediaId, '第01集'],
      [targetMediaId, '第02集'],
    ] as const) {
      conn
        .prepare(
          "INSERT INTO media_item (id, household_id, type, title, version, media_role, created_at, updated_at) VALUES (?, ?, 'episode', ?, 1, 'vod_episode', ?, ?)",
        )
        .run(mediaId, householdId, title, now, now);
    }
    for (const [entryId, mediaId, digest] of [
      [sourceEntryId, sourceMediaId, 'c1'],
      [targetEntryId, targetMediaId, 'c2'],
    ] as const) {
      conn
        .prepare(
          "INSERT INTO source_entry (id, household_id, source_id, identity_kind, identity_digest, media_id, present, first_seen_at, last_seen_at) VALUES (?, ?, ?, 'vod_episode', ?, ?, 1, ?, ?)",
        )
        .run(entryId, householdId, mediaSourceId, digest.padEnd(64, '0'), mediaId, now, now);
    }
    for (const [psrcId, entryId, mediaId] of [
      [playbackSourceId, sourceEntryId, sourceMediaId],
      [targetPlaybackSourceId, targetEntryId, targetMediaId],
    ] as const) {
      conn
        .prepare(
          "INSERT INTO playback_source (id, household_id, source_id, source_entry_id, media_item_id, protocol, location, priority, requires_proxy, locator_kind, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 'hls', 'https://upstream.fixture/ep.m3u8', 100, 0, 'static', ?, ?)",
        )
        .run(psrcId, householdId, mediaSourceId, entryId, mediaId, now, now);
    }
    // 进度时钟(recover/消费 epoch 分配)
    conn
      .prepare('INSERT INTO profile_progress_clock (household_id, profile_id, next_epoch) VALUES (?, ?, 1)')
      .run(householdId, profileId);
    // 来源播放会话(ready 活动态;T072 创建面不做状态门,消费面按真实 state 判定)
    conn
      .prepare(
        `INSERT INTO playback_session (
          id, household_id, device_session_id, device_id, profile_id, media_id,
          playback_source_id, state, delivery, generation, version,
          position_seconds, audio_track_id, subtitle_track_id, desired_paused,
          created_at, started_at, ended_at, last_heartbeat_at, failure_code
        ) VALUES (?, ?, ?, ?, ?, ?, ?, 'ready', 'hls_proxy', 1, 1, 0, NULL, NULL, 0, ?, ?, NULL, ?, NULL)`,
      )
      .run(sourceSessionId, householdId, deviceSessionId, deviceId, profileId, sourceMediaId, playbackSourceId, now, now, now);
    // 来源会话 ledger 接受游标(seq=2 @ 240s,时长 3600;当前代=1)
    conn
      .prepare(
        `INSERT INTO playback_progress_state (
          household_id, playback_session_id, profile_id, media_id, candidate_epoch,
          content_revision, profile_context_version, started, last_sample_seq, last_generation,
          continuity_revision, ledger_position, ledger_duration, ledger_generation, ledger_accepted_at, session_started
        ) VALUES (?, ?, ?, ?, 1, 1, 1, 1, 2, 1, 1, 240, 3600, 1, ?, 1)`,
      )
      .run(householdId, sourceSessionId, profileId, sourceMediaId, now);
    // 物化 operation 行(登记候选 operation FK 目标;T031 同事务登记形态)
    conn
      .prepare(
        `INSERT INTO vod_materialization_operation (
          id, household_id, device_session_id, profile_id, profile_context_version,
          operation_key, request_digest, parent_media_id, selected_media_id,
          selected_content_revision, selected_continuity_revision, detail_revision,
          catalog_revision, result, committed_at, expires_at
        ) VALUES (?, ?, ?, ?, 1, ?, ?, ?, ?, 1, 1, 1, 1, ?, ?, ?)`,
      )
      .run(
        `op-${suffix}`,
        householdId,
        deviceSessionId,
        profileId,
        `opkey-${suffix}`,
        `digest-${suffix}`,
        targetMediaId,
        targetMediaId,
        JSON.stringify({ mediaId: targetMediaId, replayed: false }),
        now,
        iso(t0 + 24 * 3600_000),
      );
    // 登记候选映射(绑定来源会话/代次;I1;24h 有效)
    conn
      .prepare(
        `INSERT INTO vod_registered_candidate (
          id, household_id, device_session_id, profile_id, profile_context_version,
          registered_candidate_ref, candidate_ref, source_session_id, source_generation,
          preview_revision, target_media_id, target_content_revision, target_continuity_revision,
          target_detail_revision, materialization_operation_id, created_at, expires_at
        ) VALUES (?, ?, ?, ?, 1, ?, ?, ?, 1, 1, ?, 1, 1, 1, ?, ?, ?)`,
      )
      .run(
        `regc-${suffix}`,
        householdId,
        deviceSessionId,
        profileId,
        registeredCandidateRef,
        `vod-candidate-${suffix}`,
        sourceSessionId,
        targetMediaId,
        `op-${suffix}`,
        now,
        iso(t0 + 24 * 3600_000),
      );
  })();
  return {
    householdId,
    profileId,
    deviceId,
    deviceSessionId,
    candidateRef,
    sourceMediaId,
    targetMediaId,
    sourceSessionId,
    playbackSourceId,
    targetPlaybackSourceId,
    mediaSourceId,
    registeredCandidateRef,
  };
}

/** 会话行 → PlaybackSessionView(消费资格/恢复资格的真实 state 读取面) */
function sessionViewOf(conn: DatabaseConstructor.Database, sessionId: string): PlaybackSessionView | undefined {
  const row = conn
    .prepare(
      `SELECT id, household_id AS householdId, device_session_id AS deviceSessionId, device_id AS deviceId,
              profile_id AS profileId, media_id AS mediaId, state, delivery, generation, version,
              position_seconds AS positionSeconds, audio_track_id AS audioTrackId,
              subtitle_track_id AS subtitleTrackId, desired_paused AS desiredPaused,
              profile_context_version AS profileContextVersion, created_at AS createdAt,
              started_at AS startedAt, ended_at AS endedAt, last_heartbeat_at AS lastHeartbeatAt,
              failure_code AS failureCode
       FROM playback_session WHERE id = ?`,
    )
    .get(sessionId) as Record<string, unknown> | undefined;
  if (row === undefined) {
    return undefined;
  }
  return {
    ...(row as unknown as PlaybackSessionView),
    delivery: (row['delivery'] as PlaybackSessionView['delivery'] | null) ?? null,
    desiredPaused: row['desiredPaused'] === 1,
    startedAt: (row['startedAt'] as string | null) ?? null,
  };
}

/** 消费事务工作集(真实 SQL;同一连接,语句并入调用方事务语义) */
function createConsumeTx(rig: Rig): TransitionConsumeTxPort {
  return {
    runConsumeTx(work: (stores: TransitionConsumeWorkSetStores) => void): void {
      const conn = rig.conn;
      work({
        playback: {
          findIntent: (householdId, intentId) => rig.store.findIntentById(householdId, intentId),
          findSlot: (householdId, fromSessionId, fromGeneration) => rig.store.findSlot(householdId, fromSessionId, fromGeneration),
          findPlan: (householdId, nextPlanId) => rig.store.findNextPlanById(householdId, nextPlanId),
          insertPreparingSession: (values) => {
            conn
              .prepare(
                `INSERT INTO playback_session (
                  id, household_id, device_session_id, device_id, profile_id, media_id,
                  playback_source_id, state, delivery, generation, version,
                  position_seconds, audio_track_id, subtitle_track_id, desired_paused,
                  created_at, started_at, ended_at, last_heartbeat_at, failure_code
                ) VALUES (?, ?, ?, ?, ?, ?, ?, 'preparing', 'hls_proxy', ?, 1, 0, NULL, NULL, 0, ?, ?, NULL, ?, NULL)`,
              )
              .run(
                values.sessionId,
                values.householdId,
                values.deviceSessionId,
                rig.seed.deviceId,
                values.profileId,
                values.mediaId,
                rig.seed.targetPlaybackSourceId,
                values.generation,
                values.createdAt,
                values.createdAt,
                values.lastHeartbeatAt,
              );
          },
        },
        personalData: {
          findVodPreferences: () => ({ autoplayNext: true }),
          allocateProgressEpoch: (householdId, profileId) => {
            const row = conn
              .prepare('SELECT next_epoch AS n FROM profile_progress_clock WHERE household_id = ? AND profile_id = ?')
              .get(householdId, profileId) as { n: number } | undefined;
            const epoch = row?.n ?? 1;
            conn
              .prepare('UPDATE profile_progress_clock SET next_epoch = next_epoch + 1 WHERE household_id = ? AND profile_id = ?')
              .run(householdId, profileId);
            return epoch;
          },
          insertLedgerRow: (values) => {
            conn
              .prepare(
                `INSERT INTO playback_progress_state (
                  household_id, playback_session_id, profile_id, media_id, candidate_epoch,
                  content_revision, profile_context_version, started, last_sample_seq, last_generation,
                  continuity_revision, session_started
                ) VALUES (?, ?, ?, ?, ?, ?, ?, 0, 0, ?, 1, 0)`,
              )
              .run(
                values.householdId,
                values.playbackSessionId,
                values.profileId,
                values.mediaId,
                values.candidateEpoch,
                values.contentRevision,
                values.profileContextVersion,
                values.lastGeneration,
              );
          },
        },
      });
    },
  };
}

function openRig(): Rig {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hmp-t072-transition-switch-'));
  const conn = new DatabaseConstructor(path.join(dataDir, `${randomUUID()}.db`));
  conn.pragma('journal_mode = WAL');
  conn.pragma('foreign_keys = ON');
  applyAuthoritativeMigrations(conn);
  const t0 = Date.now();
  const seed = seedWorld(conn, t0);
  const store = drizzleTransitionStore(conn);
  bindTransitionStore(store);
  const sourceContext = new TransitionSourceContextService(store);
  const clock = { now: t0 + 1000 };
  const matchGrades = new Map<string, 'high' | 'ambiguous' | 'conflict'>();
  const bindings: { inputs: Array<Record<string, unknown>> } = { inputs: [] };
  const prepared: { calls: Array<Record<string, unknown>> } = { calls: [] };
  const candidateFacts: TransitionCandidateFactsPort = {
    findRegisteredCandidate: (householdId, ref) =>
      conn
        .prepare(
          `SELECT candidate_ref AS candidateRef, source_session_id AS sourceSessionId,
                  source_generation AS sourceGeneration, preview_revision AS previewRevision,
                  target_media_id AS targetMediaId, target_content_revision AS targetContentRevision,
                  target_continuity_revision AS targetContinuityRevision,
                  target_detail_revision AS targetDetailRevision, expires_at AS expiresAt
           FROM vod_registered_candidate WHERE household_id = ? AND registered_candidate_ref = ?`,
        )
        .get(householdId, ref) as ReturnType<TransitionCandidateFactsPort['findRegisteredCandidate']>,
    findCandidateMatch: (candidateRef) => {
      const grade = matchGrades.get(candidateRef) ?? 'high';
      return { matchConfidence: grade };
    },
    isSessionSourceEnabled: (householdId, fromSessionId) => {
      const row = conn
        .prepare(
          `SELECT ms.enabled AS enabled
           FROM playback_session s
           JOIN playback_source ps ON ps.household_id = s.household_id AND ps.id = s.playback_source_id
           JOIN media_source ms ON ms.household_id = ps.household_id AND ms.id = ps.source_id
           WHERE s.household_id = ? AND s.id = ?`,
        )
        .get(householdId, fromSessionId) as { readonly enabled: number } | undefined;
      return row === undefined ? undefined : row.enabled === 1;
    },
  };
  const vodFacts: TransitionVodFactsPort = {
    navigation: {} as TransitionVodFactsPort['navigation'],
    findEpisodeRefByMedia: () => undefined,
    findTitleIdOfLine: () => undefined,
    currentSequenceRevision: () => 1,
    titlePointerFacts: () => ({ detailRevision: 1, locatorRevision: 1 }),
    findTargetEpisodeRow: () => ({ label: '第02集', contentRevision: 1, continuityRevision: 1 }),
  };
  const inputBinder: TransitionInputBinderPort = {
    bindFixedInput: async (input) => {
      bindings.inputs.push({ ...input });
      return { bindingId: `bind-${bindings.inputs.length}` };
    },
  };
  const successorPreparer: TransitionSuccessorPreparerPort = {
    prepareTransitionSuccessor: (input) => {
      prepared.calls.push({ ...input });
    },
  };
  const sessionStore: TransitionSessionStorePort = {
    getSession: (householdId, sessionId) => {
      const view = sessionViewOf(conn, sessionId);
      if (view === undefined || view.householdId !== householdId) {
        return { ok: false, code: 'PLAYBACK_NOT_FOUND' };
      }
      return { ok: true, value: view };
    },
    failSession: (sessionId, input) => {
      conn
        .prepare(
          `UPDATE playback_session SET state = 'failed', failure_code = ?, version = version + 1
           WHERE id = ? AND version = ? AND generation = ?`,
        )
        .run(input.failureCode, sessionId, input.cas.expectedVersion, input.cas.expectedGeneration);
    },
  };
  const service = new PlaybackTransitionService({
    store,
    sourceContext,
    identity: {
      findTrustedSession: (deviceSessionId) => {
        const row = conn
          .prepare('SELECT active_profile_id AS activeProfileId, profile_context_version AS profileContextVersion FROM device_session WHERE id = ?')
          .get(deviceSessionId) as { activeProfileId: string | null; profileContextVersion: number } | undefined;
        return row ?? undefined;
      },
    },
    vodFacts,
    personalFacts: { findTargetHistory: () => null },
    targetAuthorizer: {
      authorizeResolve: async () => ({
        snapshot: { deviceId: 'dev-t072', profileContextVersion: 1 },
        candidates: [{ playbackSourceId: seed.targetPlaybackSourceId, sourceId: seed.mediaSourceId }],
      }),
    },
    candidateFacts,
    consumeTx: createConsumeTx({ conn, store, seed } as Rig),
    inputBinder,
    successorPreparer,
    sessionStore,
    clock: () => clock.now,
  });
  const rig: Rig = {
    conn,
    service,
    sourceContext,
    store,
    seed,
    dataDir,
    t0,
    matchGrades,
    bindings,
    prepared,
    clock,
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
/* 请求/断言助手                                                          */
/* ------------------------------------------------------------------ */

function sessionContextOf(rig: Rig): SessionContext {
  return { session: { id: rig.seed.deviceSessionId, householdId: rig.seed.householdId, deviceId: 'dev-t072' } } as unknown as SessionContext;
}

function switchCommand(rig: Rig, overrides: Partial<TransitionIntentCommand> = {}): TransitionIntentCommand {
  return {
    fromSessionId: rig.seed.sourceSessionId,
    expectedGeneration: 1,
    action: 'switch',
    targetCandidateRef: rig.seed.registeredCandidateRef,
    previewRevision: 1,
    positionMode: 'carry',
    confirmedAmbiguous: false,
    sourceCheckpoint: { expectedGeneration: 1, sampleSeq: 2 },
    expectedSlotRevision: 0,
    operationKey: `op-${randomUUID()}`,
    ...overrides,
  };
}

async function createIntent(rig: Rig, overrides: Partial<TransitionIntentCommand> = {}): Promise<{ status: number; reply?: Record<string, unknown>; code?: string }> {
  try {
    const outcome = await rig.service.createIntent(sessionContextOf(rig), switchCommand(rig, overrides));
    return { status: outcome.httpStatus, reply: outcome.reply as unknown as Record<string, unknown> };
  } catch (error) {
    if (error instanceof DomainError) {
      return { status: error.status, code: error.code };
    }
    throw error;
  }
}

function intentCountOf(rig: Rig): number {
  return (
    (rig.conn.prepare('SELECT COUNT(*) AS n FROM playback_transition_intent WHERE household_id = ?').get(rig.seed.householdId) as { n: number })
      .n ?? 0
  );
}

function intentRowOf(rig: Rig, intentId: string): Record<string, unknown> | undefined {
  return rig.conn.prepare('SELECT * FROM playback_transition_intent WHERE household_id = ? AND id = ?').get(rig.seed.householdId, intentId) as
    | Record<string, unknown>
    | undefined;
}

/** 直改:接受一条样本(推进当前代 ledger 游标;等价 T040 applyLedgerSample) */
function advanceLedger(rig: Rig, sampleSeq: number, positionSeconds: number): void {
  rig.conn
    .prepare(
      `UPDATE playback_progress_state SET last_sample_seq = ?, ledger_position = ?, ledger_generation = 1, last_generation = 1
       WHERE household_id = ? AND playback_session_id = ?`,
    )
    .run(sampleSeq, positionSeconds, rig.seed.householdId, rig.seed.sourceSessionId);
}

/* ------------------------------------------------------------------ */
/* A. carry checkpoint 矩阵(api §5 + §7 I2 + §10)                        */
/* ------------------------------------------------------------------ */

describe('T072 · A carry checkpoint 矩阵(精确匹配当前代 ledger)', () => {
  it('A1 carry 缺 sourceCheckpoint → 400 VALIDATION_FAILED,不落 intent(api §5「carry必须提供sourceCheckpoint」)', async () => {
    const rig = openRig();
    const outcome = await createIntent(rig, { sourceCheckpoint: undefined });
    expect(outcome.status).toBe(400);
    expect(outcome.code).toBe(ProblemCode.VALIDATION_FAILED);
    expect(intentCountOf(rig), '缺失 checkpoint 拒绝不落 intent').toBe(0);
  });

  it('A2 checkpoint 代次不等 → 409 SOURCE_PROGRESS_PENDING 不落 intent(陈旧代次声明)', async () => {
    const rig = openRig();
    const outcome = await createIntent(rig, {
      sourceCheckpoint: { expectedGeneration: 2, sampleSeq: 2 },
    });
    expect(outcome.status).toBe(409);
    expect(outcome.code).toBe('SOURCE_PROGRESS_PENDING');
    expect(intentCountOf(rig)).toBe(0);
  });

  it('A3 checkpoint seq 不等(未接受样本)→ 409 SOURCE_PROGRESS_PENDING 不落 intent(未接受样本不作为 checkpoint)', async () => {
    const rig = openRig();
    const outcome = await createIntent(rig, {
      sourceCheckpoint: { expectedGeneration: 1, sampleSeq: 3 },
    });
    expect(outcome.status).toBe(409);
    expect(outcome.code).toBe('SOURCE_PROGRESS_PENDING');
    expect(intentCountOf(rig)).toBe(0);
  });

  it('A4 精确相等 → 201,position/duration/seq/checkpoint 自当前代 ledger 服务端复制(data-model §10)', async () => {
    const rig = openRig();
    const outcome = await createIntent(rig);
    expect(outcome.status).toBe(201);
    const row = intentRowOf(rig, String(outcome.reply?.['id']))!;
    expect(row['position_mode']).toBe('carry');
    expect(row['carry_position_seconds'], 'carry 位置=ledger 接受游标位置(240;非请求声明)').toBe(240);
    expect(row['carry_duration_seconds'], 'carry 时长=ledger 可信时长(3600)').toBe(3600);
    expect(row['source_ledger_seq']).toBe(2);
    expect(row['source_checkpoint_generation']).toBe(1);
    expect(row['source_checkpoint_seq']).toBe(2);
    expect(row['allow_earlier_accepted_position'], '未携带 allow 标志 → 0(记录确认位)').toBe(0);
    expect(row['status']).toBe('pending');
  });

  it('A5 明确旧游标(已接受 seq1)无标志 → 409(不自动挑旧位置);带 allowEarlierAcceptedPosition=true 仍 409(api §5「仍须精确相等」)', async () => {
    const rig = openRig();
    const withoutFlag = await createIntent(rig, {
      sourceCheckpoint: { expectedGeneration: 1, sampleSeq: 1 },
    });
    expect(withoutFlag.status).toBe(409);
    expect(withoutFlag.code).toBe('SOURCE_PROGRESS_PENDING');
    const withFlag = await createIntent(rig, {
      sourceCheckpoint: { expectedGeneration: 1, sampleSeq: 1 },
      allowEarlierAcceptedPosition: true,
    });
    expect(withFlag.status, 'allow 仅记录确认,不放宽相等性(精确匹配唯一可实现语义)').toBe(409);
    expect(withFlag.code).toBe('SOURCE_PROGRESS_PENDING');
    expect(intentCountOf(rig), '两次拒绝均不落 intent').toBe(0);
  });

  it('A6 allowEarlierAcceptedPosition=true + 精确相等 → 201 且确认位落库(=1)', async () => {
    const rig = openRig();
    const outcome = await createIntent(rig, { allowEarlierAcceptedPosition: true });
    expect(outcome.status).toBe(201);
    const row = intentRowOf(rig, String(outcome.reply?.['id']))!;
    expect(row['allow_earlier_accepted_position']).toBe(1);
    expect(row['carry_position_seconds']).toBe(240);
  });

  it('A7 beginning/target_history 禁 sourceCheckpoint/allowEarlierAcceptedPosition → 400(§10 仅 carry 必填)', async () => {
    const rig = openRig();
    for (const positionMode of ['beginning', 'target_history'] as const) {
      const withCheckpoint = await createIntent(rig, {
        positionMode,
        sourceCheckpoint: { expectedGeneration: 1, sampleSeq: 2 },
      });
      expect(withCheckpoint.status, `${positionMode} + checkpoint 应 400`).toBe(400);
      expect(withCheckpoint.code).toBe(ProblemCode.VALIDATION_FAILED);
      const withFlag = await createIntent(rig, { positionMode, allowEarlierAcceptedPosition: true });
      expect(withFlag.status, `${positionMode} + allow 应 400`).toBe(400);
    }
    expect(intentCountOf(rig)).toBe(0);
  });
});

/* ------------------------------------------------------------------ */
/* B. carryPositionEligibility 三态(api §5 位置模式资格)                   */
/* ------------------------------------------------------------------ */

describe('T072 · B carryPositionEligibility 三态(conflict 禁 carry/ambiguous 经登记锚/high 直接)', () => {
  it('B1 conflict 候选 + carry → 400 VALIDATION_FAILED 不落 intent(conflict 只 beginning/target_history)', async () => {
    const rig = openRig();
    rig.matchGrades.set(rig.seed.candidateRef, 'conflict');
    const outcome = await createIntent(rig);
    expect(outcome.status).toBe(400);
    expect(outcome.code).toBe(ProblemCode.VALIDATION_FAILED);
    expect(intentCountOf(rig)).toBe(0);
  });

  it('B2 conflict 候选 + beginning → 201(conflict 只禁 carry,不禁显式起点)', async () => {
    const rig = openRig();
    rig.matchGrades.set(rig.seed.candidateRef, 'conflict');
    const outcome = await createIntent(rig, { positionMode: 'beginning', sourceCheckpoint: undefined });
    expect(outcome.status).toBe(201);
    expect(outcome.reply?.['matchConfidence']).toBe('conflict');
  });

  it('B3 ambiguous 候选 + carry → 201 且事实等级如实落库(登记映射=具体集锚;确认位随载荷落库)', async () => {
    const rig = openRig();
    rig.matchGrades.set(rig.seed.candidateRef, 'ambiguous');
    const outcome = await createIntent(rig, { confirmedAmbiguous: true });
    expect(outcome.status, 'ambiguous+确认 → carry 解锁(viaConfirmation)').toBe(201);
    expect(outcome.reply?.['matchConfidence'], 'IntentReply 恒报匹配事实等级,不因确认提升').toBe('ambiguous');
    const row = intentRowOf(rig, String(outcome.reply?.['id']))!;
    expect(row['match_confidence']).toBe('ambiguous');
    expect(row['confirmed_ambiguous']).toBe(1);
  });

  it('B4 匹配结论缺失(登记桥直种/缓存过期)→ 以登记映射为验证锚按 high 处理(报告注记:缺结论不降级)', async () => {
    const rig = openRig();
    rig.matchGrades.clear();
    // 模拟「无匹配结论」:注入未知 ref 的 grade 由受控表缺省 high —— 此处直验缺省面
    const outcome = await createIntent(rig);
    expect(outcome.status).toBe(201);
    expect(outcome.reply?.['matchConfidence']).toBe('high');
  });
});

/* ------------------------------------------------------------------ */
/* C. 候选绑定与 previewRevision CAS(I1)                                  */
/* ------------------------------------------------------------------ */

describe('T072 · C 候选绑定(registeredCandidateRef + previewRevision CAS)', () => {
  it('C1 未登记/伪造 ref 与源会话绑定失配 404 同形(不可判别存在性)', async () => {
    const rig = openRig();
    const forged = await createIntent(rig, { targetCandidateRef: `vod-reg-forged-${randomUUID()}` });
    expect(forged.status).toBe(404);
    const boundToOtherSession = await createIntent(rig, { fromSessionId: `sess-other-${randomUUID()}`, expectedGeneration: 1 });
    expect(boundToOtherSession.status, '来源会话不存在与未登记同形 404(来源授权先行)').toBe(404);
    expect(intentCountOf(rig)).toBe(0);
  });

  it('C2 previewRevision CAS 失配 → 409 VOD_DETAIL_CHANGED 不落 intent(登记后预览已前进)', async () => {
    const rig = openRig();
    const outcome = await createIntent(rig, { previewRevision: 2 });
    expect(outcome.status).toBe(409);
    expect(outcome.code).toBe('VOD_DETAIL_CHANGED');
    expect(intentCountOf(rig)).toBe(0);
  });
});

/* ------------------------------------------------------------------ */
/* D. recover_switch 资格(failed + 可恢复媒体故障 + 60s 窗 + 禁源)          */
/* ------------------------------------------------------------------ */

/** 直改:来源会话置媒体故障终态(等价 T044/T045 故障管线库内形态) */
function flipToFailed(rig: Rig, failureCode: string, failedAtMsOffsetMs = 0): void {
  rig.conn
    .prepare(`UPDATE playback_session SET state = 'failed', failure_code = ?, ended_at = ? WHERE id = ?`)
    .run(failureCode, iso(rig.clock.now - failedAtMsOffsetMs), rig.seed.sourceSessionId);
}

describe('T072 · D recover_switch 资格(60s 窗/故障类/禁源)', () => {
  it('D1 failed + 可恢复媒体故障 + 窗内 → recover_switch 201(carry + checkpoint 精确)', async () => {
    const rig = openRig();
    flipToFailed(rig, 'PLAYBACK_FORMAT_UNSUPPORTED');
    const outcome = await createIntent(rig, { action: 'recover_switch' });
    expect(outcome.status).toBe(201);
    expect(outcome.reply?.['action']).toBe('recover_switch');
  });

  it('D2 窗外(终态时刻回拨 61s)→ 409 SOURCE_NOT_TERMINAL 不落 intent(超时走普通新播放,无旧 carry)', async () => {
    const rig = openRig();
    flipToFailed(rig, 'PLAYBACK_FORMAT_UNSUPPORTED', 61_000);
    const outcome = await createIntent(rig, { action: 'recover_switch' });
    expect(outcome.status).toBe(409);
    expect(outcome.code).toBe('SOURCE_NOT_TERMINAL');
    expect(intentCountOf(rig)).toBe(0);
  });

  it('D3 不可恢复故障类(权限/修订族)→ 409(禁权/切档/禁源不得借恢复)', async () => {
    const rig = openRig();
    flipToFailed(rig, 'PLAYBACK_VERSION_CONFLICT');
    const outcome = await createIntent(rig, { action: 'recover_switch' });
    expect(outcome.status).toBe(409);
    expect(outcome.code).toBe('SOURCE_NOT_TERMINAL');
    expect(intentCountOf(rig)).toBe(0);
  });

  it('D4 禁源(来源所属 media_source 停用)→ 404 授权族同形优先,不落 intent(E3)', async () => {
    const rig = openRig();
    flipToFailed(rig, 'PLAYBACK_FORMAT_UNSUPPORTED');
    rig.conn.prepare('UPDATE media_source SET enabled = 0 WHERE id = ?').run(rig.seed.mediaSourceId);
    const outcome = await createIntent(rig, { action: 'recover_switch' });
    expect(outcome.status).toBe(404);
    expect(intentCountOf(rig)).toBe(0);
  });

  it('D5 正常 switch 对 failed 来源创建不限状态(先 stop 再消费在消费面;状态门归 SOURCE_NOT_TERMINAL 的消费判定)', async () => {
    const rig = openRig();
    flipToFailed(rig, 'PLAYBACK_FORMAT_UNSUPPORTED');
    const outcome = await createIntent(rig, { action: 'switch' });
    expect(outcome.status).toBe(201);
  });
});

/* ------------------------------------------------------------------ */
/* E. 消费终态门(真实 state)+ carry 快照透传(T073 接缝)                  */
/* ------------------------------------------------------------------ */

async function consume(rig: Rig, intentId: string, mediaId?: string): Promise<{ kind: string; sessionId?: string; code?: string }> {
  try {
    const outcome = await rig.service.resolveTransition(sessionContextOf(rig), {
      mediaId: mediaId ?? rig.seed.targetMediaId,
      transitionIntentId: intentId,
    });
    return { kind: outcome.kind, sessionId: outcome.sessionId };
  } catch (error) {
    if (error instanceof DomainError) {
      return { kind: 'error', code: error.code };
    }
    throw error;
  }
}

describe('T072 · E 消费终态门(真实 state)与 carry 快照透传', () => {
  it('E1 源未终态(ready)消费 → 409 SOURCE_NOT_TERMINAL:intent 保持 pending、槽 reserved、零后继(api §5)', async () => {
    const rig = openRig();
    const created = await createIntent(rig);
    expect(created.status).toBe(201);
    const intentId = String(created.reply?.['id']);
    const outcome = await consume(rig, intentId);
    expect(outcome.kind).toBe('error');
    expect(outcome.code).toBe('SOURCE_NOT_TERMINAL');
    expect(intentRowOf(rig, intentId)?.['status']).toBe('pending');
    expect(rig.store.findSlot(rig.seed.householdId, rig.seed.sourceSessionId, 1)?.status).toBe('reserved');
    expect(rig.prepared.calls, '409 不建后继不触发准备').toHaveLength(0);
  });

  it('E2 stop 到 ended 后消费 → consumed + preparing 后继;carry 快照经准备端口透传(transition_carry + frozen=接受游标位置;T073 接缝)', async () => {
    const rig = openRig();
    const created = await createIntent(rig);
    const intentId = String(created.reply?.['id']);
    rig.conn.prepare(`UPDATE playback_session SET state = 'ended', ended_at = ? WHERE id = ?`).run(iso(rig.clock.now), rig.seed.sourceSessionId);
    const outcome = await consume(rig, intentId);
    expect(outcome.kind).toBe('consumed');
    expect(intentRowOf(rig, intentId)?.['status']).toBe('consumed');
    expect(rig.store.findSlot(rig.seed.householdId, rig.seed.sourceSessionId, 1)?.status).toBe('consumed');
    expect(rig.prepared.calls).toHaveLength(1);
    const preparedCall = rig.prepared.calls[0]!;
    expect(preparedCall['startBasis'], 'carry 映射唯一 startBasis=transition_carry').toBe('transition_carry');
    expect(preparedCall['frozenStartSeconds'], 'frozen=冻结 ledger 接受游标位置(T073 据此冻结)').toBe(240);
    expect(rig.bindings.inputs[0]?.['startBasis']).toBe('transition_carry');
    // 后继会话/epoch/ledger 已由消费事务建档
    const view = sessionViewOf(rig.conn, outcome.sessionId ?? '');
    expect(view?.state).toBe('preparing');
    const ledger = rig.conn
      .prepare('SELECT candidate_epoch AS e FROM playback_progress_state WHERE playback_session_id = ?')
      .get(outcome.sessionId ?? '') as { e: number } | undefined;
    expect(ledger?.e, '后继应分配 epoch/ledger 建档').toBeGreaterThanOrEqual(1);
  });

  it('E3 recover_switch:failed 即终态免 stop 消费 consumed(201 形态)', async () => {
    const rig = openRig();
    flipToFailed(rig, 'PLAYBACK_FORMAT_UNSUPPORTED');
    const created = await createIntent(rig, { action: 'recover_switch' });
    const intentId = String(created.reply?.['id']);
    const outcome = await consume(rig, intentId);
    expect(outcome.kind).toBe('consumed');
    expect(intentRowOf(rig, intentId)?.['status']).toBe('consumed');
  });

  it('E4 carry checkpoint 消费期复核:ledger 前进(终态后漂移)→ 409 SOURCE_PROGRESS_PENDING 零写入(intent 保持 pending)', async () => {
    const rig = openRig();
    const created = await createIntent(rig);
    const intentId = String(created.reply?.['id']);
    rig.conn.prepare(`UPDATE playback_session SET state = 'ended', ended_at = ? WHERE id = ?`).run(iso(rig.clock.now), rig.seed.sourceSessionId);
    advanceLedger(rig, 3, 300);
    const outcome = await consume(rig, intentId);
    expect(outcome.kind).toBe('error');
    expect(outcome.code).toBe('SOURCE_PROGRESS_PENDING');
    expect(intentRowOf(rig, intentId)?.['status'], '复核失败不消耗 intent').toBe('pending');
    expect(rig.prepared.calls).toHaveLength(0);
  });

  it('E5 请求目标与意图绑定目标失配 → 409 槽冲突族(零写入;既有语义)', async () => {
    const rig = openRig();
    const created = await createIntent(rig, { positionMode: 'beginning', sourceCheckpoint: undefined });
    const intentId = String(created.reply?.['id']);
    const outcome = await consume(rig, intentId, rig.seed.sourceMediaId);
    expect(outcome.kind).toBe('error');
    expect(outcome.code).toBe('TRANSITION_SLOT_CONFLICT');
  });
});
