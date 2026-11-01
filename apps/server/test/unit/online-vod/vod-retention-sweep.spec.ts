/**
 * 010-online-vod T084(US5 · Phase 8)—— vod 保留清扫服务级单测(真实 DDL + FakeClock,零网络)。
 *
 * 被测实现:
 * - @contexts/online-vod/application/vod-retention.service(VodRetentionSweep 编排 +
 *   VodRetentionStore 结构端口 + 引用矩阵语义);
 * - @contexts/online-vod/infrastructure/online-vod-store.drizzle(DrizzleVodRetentionStore
 *   真实清理 SQL);
 * - @contexts/playback/application/playback-retention.service 的 T084 节拍挂链
 *   (runVodRetentionSweep 独立入口 + watchdog 第三链,缺位 no-op)。
 *
 * 夹具分层(transition-store.spec/retention-sweep.spec 同款):独立临时文件库 + 全量
 * 权威迁移 DDL(0001–0007,foreign_keys=ON 真实约束)+ 真实 drizzleVodRetentionStore;
 * 行种子直插(复合 FK/CHECK 全满足);时间以 ManualClock 注入(now 缺省取时钟,不真实
 * 睡眠);24h 窗口远大于测试执行时长,确定性成立。零网络、零 mock(计划回收/T081 挂链
 * 两处为结构端口 fake,行为面断言见用例)。
 *
 * 权威依据:
 * - docs/specs/010-online-vod/data-model.md §4(10 源/5000 父/100000 子;未观看且无
 *   历史/名单/会话FK/意图/幂等保护/其他持久引用的组,materialized_at 至少 24h 后才可
 *   整组清理,ID 不复用;先过期幂等/意图,再按完整引用图清理;活动/保留终态不能破坏
 *   FK;schema 不能靠删除历史释放配额)+ §9(保留/watchdog)+ §10(偏好 operation 24h
 *   清理不删偏好;计划受引用保护;registered_candidate 24h);
 * - docs/specs/010-online-vod/contracts/api.md §3 物化 24h 目标保护段(满额 409 不挤占
 *   既有目标;目标 24h 受回收保护);
 * - tasks.md T084(T081 报告移交:vod_registered_candidate 24h 清理归本任务)。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import DatabaseConstructor from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import {
  VodRetentionService,
  emptyVodRetentionSweepOutcome,
  type VodGroupRef,
  type VodRetentionSweepOutcome,
} from '@contexts/online-vod/application/vod-retention.service';
import { drizzleVodRetentionStore } from '@contexts/online-vod/infrastructure/online-vod-store.drizzle';
import { PlaybackRetentionService } from '@contexts/playback/application/playback-retention.service';
import { createPlaybackBudgets } from '@platform/config/playback-budgets';
import { loadEnv } from '@platform/config/env.schema';
import { createManualClock, MANUAL_CLOCK_DEFAULT_START_MS, type ManualClock } from '../../fixtures/clock';

/* ------------------------------------------------------------------ */
/* rig:临时文件库 + 全量权威迁移 + 真实 store + FakeClock                 */
/* ------------------------------------------------------------------ */

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

function applyAuthoritativeMigrations(conn: DatabaseConstructor.Database): void {
  const migrationsDir = path.join(process.cwd(), 'src/platform/database/migrations');
  for (const name of MIGRATION_NAMES) {
    const upSqlPath = path.join(migrationsDir, name, 'up.sql');
    expect(fs.existsSync(upSqlPath), `未找到迁移 DDL ${upSqlPath}(须以 apps/server 为工作目录运行)`).toBe(true);
    conn.exec(fs.readFileSync(upSqlPath, 'utf8'));
  }
}

interface Rig {
  readonly conn: DatabaseConstructor.Database;
  readonly store: ReturnType<typeof drizzleVodRetentionStore>;
  readonly service: VodRetentionService;
  readonly clock: ManualClock;
  readonly seed: RigSeed;
  readonly dataDir: string;
  readonly t0: number;
}

interface RigSeed {
  readonly householdId: string;
  readonly profileId: string;
  readonly deviceSessionId: string;
  /** 溯源媒体+会话(intent.from_session / next_plan.from_session / candidate.source_session) */
  readonly provenanceMediaId: string;
  readonly provenanceSessionId: string;
}

const openRigs: Rig[] = [];

function openRig(): Rig {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hmp-t084-retention-'));
  const conn = new DatabaseConstructor(path.join(dataDir, `${randomUUID()}.db`));
  conn.pragma('journal_mode = WAL');
  conn.pragma('foreign_keys = ON');
  applyAuthoritativeMigrations(conn);
  const t0 = MANUAL_CLOCK_DEFAULT_START_MS;
  const seed = seedWorld(conn, t0);
  const store = drizzleVodRetentionStore(conn);
  const clock = createManualClock({ startMs: t0 });
  const service = new VodRetentionService({ store, clock: () => clock.now() });
  const rig: Rig = { conn, store, service, clock, seed, dataDir, t0 };
  openRigs.push(rig);
  return rig;
}

function closeRigs(): void {
  while (openRigs.length > 0) {
    const rig = openRigs.pop();
    if (rig === undefined) break;
    rig.conn.close();
    fs.rmSync(rig.dataDir, { recursive: true, force: true });
  }
}

/** 最小身份种子(FK 依赖序) */
function seedWorld(conn: DatabaseConstructor.Database, t0: number): RigSeed {
  const now = iso(t0);
  const householdId = `hh-t084-${randomUUID()}`;
  const accountId = `acc-t084-${randomUUID()}`;
  const profileId = `prof-t084-${randomUUID()}`;
  const deviceId = `dev-t084-${randomUUID()}`;
  const deviceSessionId = `dsess-t084-${randomUUID()}`;
  const provenanceMediaId = `media-prov-t084-${randomUUID()}`;
  const provenanceSessionId = `sess-prov-t084-${randomUUID()}`;
  conn.transaction(() => {
    conn.prepare('INSERT INTO household (id, name, created_at) VALUES (?, ?, ?)').run(householdId, 'T084 夹具家庭', now);
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
      .run(deviceSessionId, householdId, accountId, deviceId, `token-hash-${deviceSessionId}`, profileId, iso(t0 + 7 * 86_400_000), now, now);
    // 溯源媒体(standalone)+ ended 会话:意图/计划/登记候选的合法 FK 源
    conn
      .prepare(
        "INSERT INTO media_item (id, household_id, type, title, version, media_role, created_at, updated_at) VALUES (?, ?, 'movie', 'T084 溯源媒体', 1, 'standalone', ?, ?)",
      )
      .run(provenanceMediaId, householdId, now, now);
    conn
      .prepare(
        `INSERT INTO playback_session (
          id, household_id, device_session_id, device_id, profile_id, media_id,
          playback_source_id, state, delivery, generation, version,
          position_seconds, created_at, ended_at, last_heartbeat_at
        ) VALUES (?, ?, ?, ?, ?, ?, NULL, 'ended', NULL, 1, 1, 0, ?, ?, ?)`,
      )
      .run(provenanceSessionId, householdId, deviceSessionId, deviceId, profileId, provenanceMediaId, now, now, now);
  })();
  return { householdId, profileId, deviceSessionId, provenanceMediaId, provenanceSessionId };
}

/* ------------------------------------------------------------------ */
/* 标题组物化(行种子直插;成员全集 = data-model §2/§4 清理面)             */
/* ------------------------------------------------------------------ */

interface MaterializedGroup {
  readonly titleId: string;
  readonly parentMediaId: string;
  readonly lineId: string;
  readonly childMediaIds: readonly string[];
  readonly episodeIds: readonly string[];
  readonly sourceEntryId: string;
  readonly playbackSourceId: string;
  readonly operationId: string;
  readonly candidateId: string | undefined;
}

interface MaterializeGroupOptions {
  /** vod_title.materialized_at(保护窗锚点) */
  readonly materializedAtMs: number;
  /** 幂等 operation/登记候选保护期终点(缺省 = materializedAt 起固定 24h;候选同事务同保护期) */
  readonly operationExpiresAtMs?: number;
  /** 是否同事务形态登记候选(I1) */
  readonly withCandidate?: boolean;
}

function materializeGroup(rig: Rig, options: MaterializeGroupOptions): MaterializedGroup {
  const { conn, seed, t0 } = rig;
  const hh = seed.householdId;
  const now = iso(t0);
  const materializedAt = iso(options.materializedAtMs);
  const operationExpiresAt = iso(options.operationExpiresAtMs ?? options.materializedAtMs + 24 * 3_600_000);
  const sourceId = `msrc-${randomUUID()}`;
  const titleId = `vt-${randomUUID()}`;
  const parentMediaId = `media-p-${randomUUID()}`;
  const lineId = `vl-${randomUUID()}`;
  const upstreamVodId = `up-${randomUUID()}`;
  const childMediaIds = [`media-c1-${randomUUID()}`, `media-c2-${randomUUID()}`];
  const episodeIds = [`ve-c1-${randomUUID()}`, `ve-c2-${randomUUID()}`];
  const sourceEntryId = `entry-${randomUUID()}`;
  const playbackSourceId = `psrc-${randomUUID()}`;
  const operationId = `vop-${randomUUID()}`;
  const candidateId = options.withCandidate === true ? `vrc-${randomUUID()}` : undefined;
  conn.transaction(() => {
    conn
      .prepare(
        "INSERT INTO media_source (id, household_id, kind, name, remote_url, enabled, version, locator_revision, created_at, updated_at) VALUES (?, ?, 'vod', 'T084 夹具片源', 'https://cms.fixture.invalid/api.php', 1, 1, 1, ?, ?)",
      )
      .run(sourceId, hh, now, now);
    // 父媒体(vod_title 角色)+ 稳定映射
    conn
      .prepare(
        "INSERT INTO media_item (id, household_id, type, title, version, media_role, created_at, updated_at) VALUES (?, ?, 'series', 'T084 夹具剧集', 1, 'vod_title', ?, ?)",
      )
      .run(parentMediaId, hh, now, now);
    conn
      .prepare(
        'INSERT INTO vod_title (id, household_id, source_id, upstream_vod_id, parent_media_id, current_detail_revision, materialized_at) VALUES (?, ?, ?, ?, ?, 1, ?)',
      )
      .run(titleId, hh, sourceId, upstreamVodId, parentMediaId, materializedAt);
    // 线路 + 两个子项(媒体/关系/子项/序列)
    conn
      .prepare(
        'INSERT INTO vod_line (id, household_id, title_id, line_key, display_name, sort_order) VALUES (?, ?, ?, ?, ?, 1)',
      )
      .run(lineId, hh, titleId, 'main', '正片线路');
    childMediaIds.forEach((mediaId, index) => {
      const episodeId = episodeIds[index] as string;
      conn
        .prepare(
          "INSERT INTO media_item (id, household_id, type, title, version, media_role, created_at, updated_at) VALUES (?, ?, 'episode', ?, 1, 'vod_episode', ?, ?)",
        )
        .run(mediaId, hh, `第0${index + 1}集`, now, now);
      conn
        .prepare(
          "INSERT INTO media_relation (household_id, parent_id, child_id, kind, sort_order) VALUES (?, ?, ?, 'vod_episode', ?)",
        )
        .run(hh, parentMediaId, mediaId, index + 1);
      conn
        .prepare(
          `INSERT INTO vod_episode (
            id, household_id, line_id, episode_key, label, media_id,
            content_version_state, evidence_kind, evidence_digest, schema_version,
            continuity_revision, continuity_signature
          ) VALUES (?, ?, ?, ?, ?, ?, 'unverified', NULL, NULL, NULL, 1, NULL)`,
        )
        .run(episodeId, hh, lineId, `0${index + 1}`, `第0${index + 1}集`, mediaId);
      conn
        .prepare(
          `INSERT INTO vod_episode_sequence (
            household_id, title_id, line_id, detail_revision, sequence_revision,
            episode_id, season_key, ordinal, sequence_status
          ) VALUES (?, ?, ?, 1, 1, ?, NULL, ?, 'ordered')`,
        )
        .run(hh, titleId, lineId, episodeId, index + 1);
    });
    // 私有详情快照(expires > fetched CHECK)
    conn
      .prepare(
        `INSERT INTO vod_detail_snapshot (
          household_id, title_id, revision, locator_revision, validated_private_payload, fetched_at, expires_at
        ) VALUES (?, ?, 1, 1, ?, ?, ?)`,
      )
      .run(
        hh,
        titleId,
        JSON.stringify({ kind: 'vod-detail-private', fixture: titleId }),
        materializedAt,
        iso(options.materializedAtMs + 3_600_000),
      );
    // 在线条目(entry 唯一资源)+ 在线判别播放资源(online:location 空/vod 引用非空/protocol=hls)
    conn
      .prepare(
        "INSERT INTO source_entry (id, household_id, source_id, identity_kind, identity_digest, media_id, present, first_seen_at, last_seen_at) VALUES (?, ?, ?, 'vod_episode', ?, ?, 1, ?, ?)",
      )
      .run(sourceEntryId, hh, sourceId, 'a'.repeat(64), childMediaIds[0], now, now);
    conn
      .prepare(
        `INSERT INTO playback_source (
          id, household_id, source_id, source_entry_id, media_item_id, protocol, location,
          priority, requires_proxy, locator_kind, vod_episode_id, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, 'hls', NULL, 100, 1, 'online', ?, ?, ?)`,
      )
      .run(playbackSourceId, hh, sourceId, sourceEntryId, childMediaIds[0], episodeIds[0], now, now);
    // 物化幂等 operation(成功行 committed 非空;固定保护期)
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
        operationId,
        hh,
        seed.deviceSessionId,
        seed.profileId,
        `opkey-${operationId}`,
        `digest-${operationId}`,
        parentMediaId,
        childMediaIds[0],
        JSON.stringify({ parentMediaId, mediaId: childMediaIds[0] }),
        materializedAt,
        operationExpiresAt,
      );
    if (candidateId !== undefined) {
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
          candidateId,
          hh,
          seed.deviceSessionId,
          seed.profileId,
          `reg-${candidateId}`,
          `cand-${candidateId}`,
          seed.provenanceSessionId,
          childMediaIds[0],
          operationId,
          materializedAt,
          operationExpiresAt,
        );
    }
  })();
  return {
    titleId,
    parentMediaId,
    lineId,
    childMediaIds,
    episodeIds,
    sourceEntryId,
    playbackSourceId,
    operationId,
    candidateId,
  };
}

/* ------------------------------------------------------------------ */
/* 引用行种子(七类 + 兜底;各自保组)                                      */
/* ------------------------------------------------------------------ */

/** 历史(长期保留,不随清扫消失) */
function addHistoryOnChild(rig: Rig, mediaId: string): void {
  rig.conn
    .prepare(
      `INSERT INTO profile_viewing_history (
        household_id, profile_id, media_id, writer_epoch, writer_playback_session_id,
        last_sample_seq, content_revision, position_seconds, duration_seconds,
        last_viewed_at, revision, completed
      ) VALUES (?, ?, ?, 1, ?, 3, 1, 60, 1200, ?, 1, 0)`,
    )
    .run(rig.seed.householdId, rig.seed.profileId, mediaId, rig.seed.provenanceSessionId, iso(rig.t0));
}

/** 名单(策略 allowed 列表含组媒体) */
function addPolicyListWithMedia(rig: Rig, mediaId: string): void {
  rig.conn
    .prepare(
      `INSERT INTO profile_policy (
        household_id, profile_id, max_content_level, allow_unrated,
        allowed_media_ids, blocked_media_ids, allowed_channel_ids, version, updated_at
      ) VALUES (?, ?, 18, 1, ?, '[]', '[]', 1, ?)`,
    )
    .run(rig.seed.householdId, rig.seed.profileId, JSON.stringify([mediaId]), iso(rig.t0));
}

/** 活动会话(playing;源为组的在线资源行) */
function addActiveSessionOnChild(rig: Rig, mediaId: string, playbackSourceId: string): string {
  const sessionId = `sess-play-${randomUUID()}`;
  rig.conn
    .prepare(
      `INSERT INTO playback_session (
        id, household_id, device_session_id, device_id, profile_id, media_id,
        playback_source_id, state, delivery, generation, version,
        position_seconds, created_at, started_at, last_heartbeat_at
      ) VALUES (?, ?, ?, (SELECT device_id FROM device_session WHERE id = ?), ?, ?, ?, 'playing', 'hls_proxy', 1, 1, 10, ?, ?, ?)`,
    )
    .run(
      sessionId,
      rig.seed.householdId,
      rig.seed.deviceSessionId,
      rig.seed.deviceSessionId,
      rig.seed.profileId,
      mediaId,
      playbackSourceId,
      iso(rig.t0),
      iso(rig.t0),
      iso(rig.t0),
    );
  return sessionId;
}

/** 保留终态会话 + finish receipt(§9 24h 保护窗内形态) */
function addEndedSessionWithReceiptOnChild(rig: Rig, mediaId: string): string {
  const sessionId = `sess-ended-${randomUUID()}`;
  const now = iso(rig.t0);
  rig.conn.transaction(() => {
    rig.conn
      .prepare(
        `INSERT INTO playback_session (
          id, household_id, device_session_id, device_id, profile_id, media_id,
          playback_source_id, state, delivery, generation, version,
          position_seconds, created_at, started_at, ended_at, last_heartbeat_at
        ) VALUES (?, ?, ?, (SELECT device_id FROM device_session WHERE id = ?), ?, ?, NULL, 'ended', NULL, 1, 1, 900, ?, ?, ?, ?)`,
      )
      .run(
        sessionId,
        rig.seed.householdId,
        rig.seed.deviceSessionId,
        rig.seed.deviceSessionId,
        rig.seed.profileId,
        mediaId,
        now,
        now,
        now,
        now,
      );
    rig.conn
      .prepare(
        `INSERT INTO playback_finish_receipt (
          household_id, session_id, device_session_id, profile_context_version, generation,
          operation_key, request_digest, final_seq, final_session_accepted, history_applied,
          history_revision, session_completed, auto_next_eligible, reason,
          position_seconds, duration_seconds, ended_at, content_revision, continuity_revision, locator_revision
        ) VALUES (?, ?, ?, 1, 1, ?, ?, 42, 1, 1, 1, 1, 0, 'completed', 900, 1200, ?, 1, 1, 1)`,
      )
      .run(rig.seed.householdId, sessionId, rig.seed.deviceSessionId, `fin-${sessionId}`, `dig-${sessionId}`, now);
  })();
  return sessionId;
}

/** 过渡意图(pending;目标 = 组子媒体) */
function addPendingIntentTargeting(rig: Rig, targetMediaId: string): string {
  const intentId = `intent-${randomUUID()}`;
  rig.conn
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
      rig.seed.householdId,
      rig.seed.provenanceSessionId,
      rig.seed.deviceSessionId,
      rig.seed.profileId,
      targetMediaId,
      `ik-${intentId}`,
      `idg-${intentId}`,
      iso(rig.t0),
      iso(rig.t0 + 60_000),
    );
  return intentId;
}

/** 下一集计划(§10;目标 = 组子媒体;ref 已绑定的活计划形态) */
function addNextPlanTargeting(rig: Rig, targetMediaId: string): string {
  const planId = `plan-${randomUUID()}`;
  rig.conn
    .prepare(
      `INSERT INTO playback_next_plan (
        id, ref, household_id, device_session_id, profile_id, profile_context_version,
        from_session_id, from_generation, action, target_media_id, sequence_revision,
        detail_revision, target_content_revision, target_continuity_revision,
        target_locator_revision, history_revision, history_choice_required, created_at, expires_at
      ) VALUES (?, ?, ?, ?, ?, 1, ?, 1, 'next', ?, 1, 1, 1, 1, 1, 0, 0, ?, ?)`,
    )
    .run(
      planId,
      `planref-${planId}`,
      rig.seed.householdId,
      rig.seed.deviceSessionId,
      rig.seed.profileId,
      rig.seed.provenanceSessionId,
      targetMediaId,
      iso(rig.t0),
      iso(rig.t0 + 60_000),
    );
  return planId;
}

/** 兜底引用(审计失败事件;media 非 session 面的持久 FK) */
function addFailureEventOnMedia(rig: Rig, mediaId: string): void {
  rig.conn
    .prepare(
      `INSERT INTO playback_failure_event (
        id, household_id, device_session_id, device_id, profile_id, media_id, occurred_at, stable_code
      ) VALUES (?, ?, ?, (SELECT device_id FROM device_session WHERE id = ?), ?, ?, ?, 'VOD_DETAIL_CHANGED')`,
    )
    .run(
      `pfe-${randomUUID()}`,
      rig.seed.householdId,
      rig.seed.deviceSessionId,
      rig.seed.deviceSessionId,
      rig.seed.profileId,
      mediaId,
      iso(rig.t0),
    );
}

/** 偏好行 + 过期偏好写入 operation(§10:清理 operation 不删偏好) */
function addPreferenceRowAndExpiredOperation(rig: Rig): void {
  rig.conn.transaction(() => {
    rig.conn
      .prepare(
        'INSERT INTO profile_vod_preferences (household_id, profile_id, autoplay_next, switch_carry_position, version) VALUES (?, ?, 0, 1, 3)',
      )
      .run(rig.seed.householdId, rig.seed.profileId);
    rig.conn
      .prepare(
        `INSERT INTO profile_vod_preference_operation (
          id, household_id, device_session_id, profile_id, profile_context_version,
          operation_key, request_digest, result_json, committed_at, expires_at
        ) VALUES (?, ?, ?, ?, 1, ?, ?, ?, ?, ?)`,
      )
      .run(
        `prefop-${randomUUID()}`,
        rig.seed.householdId,
        rig.seed.deviceSessionId,
        rig.seed.profileId,
        `prefkey-${randomUUID()}`,
        'prefdigest',
        JSON.stringify({ autoplayNext: false, switchCarryPosition: true, version: 3 }),
        // CHECK:expires >= committed + 24h(julianday 差 >= 1)
        '2000-01-01T00:00:00.000Z',
        '2000-01-02T00:00:00.000Z',
      );
  })();
}

/** 附加 operation + 同事务登记候选(R6 联合保组面;同唯一键/同保护期形态) */
function addRefreshOperationWithCandidate(
  rig: Rig,
  group: MaterializedGroup,
  committedAtMs: number,
): { readonly operationId: string; readonly candidateId: string } {
  const operationId = `vop-${randomUUID()}`;
  const candidateId = `vrc-${randomUUID()}`;
  const expiresAt = iso(committedAtMs + 24 * 3_600_000);
  rig.conn.transaction(() => {
    rig.conn
      .prepare(
        `INSERT INTO vod_materialization_operation (
          id, household_id, device_session_id, profile_id, profile_context_version,
          operation_key, request_digest, parent_media_id, selected_media_id,
          selected_content_revision, selected_continuity_revision, detail_revision,
          catalog_revision, result, committed_at, expires_at
        ) VALUES (?, ?, ?, ?, 1, ?, ?, ?, ?, 1, 1, 1, 1, '{}', ?, ?)`,
      )
      .run(
        operationId,
        rig.seed.householdId,
        rig.seed.deviceSessionId,
        rig.seed.profileId,
        `opkey-${operationId}`,
        `digest-${operationId}`,
        group.parentMediaId,
        group.childMediaIds[0],
        iso(committedAtMs),
        expiresAt,
      );
    rig.conn
      .prepare(
        `INSERT INTO vod_registered_candidate (
          id, household_id, device_session_id, profile_id, profile_context_version,
          registered_candidate_ref, candidate_ref, source_session_id, source_generation,
          preview_revision, target_media_id, target_content_revision, target_continuity_revision,
          target_detail_revision, materialization_operation_id, created_at, expires_at
        ) VALUES (?, ?, ?, ?, 1, ?, ?, ?, 1, 1, ?, 1, 1, 1, ?, ?, ?)`,
      )
      .run(
        candidateId,
        rig.seed.householdId,
        rig.seed.deviceSessionId,
        rig.seed.profileId,
        `reg-${candidateId}`,
        `cand-${candidateId}`,
        rig.seed.provenanceSessionId,
        group.childMediaIds[0],
        operationId,
        iso(committedAtMs),
        expiresAt,
      );
  })();
  return { operationId, candidateId };
}

/* ------------------------------------------------------------------ */
/* 断言助手                                                              */
/* ------------------------------------------------------------------ */

function scalarOf(rig: Rig, sql: string, ...params: readonly unknown[]): number {
  const row = rig.conn.prepare(sql).get(...params) as { n: number } | undefined;
  return row?.n ?? 0;
}

function operationExists(rig: Rig, operationId: string): boolean {
  return scalarOf(rig, 'SELECT COUNT(*) AS n FROM vod_materialization_operation WHERE id = ?', operationId) === 1;
}

function candidateExists(rig: Rig, candidateId: string): boolean {
  return scalarOf(rig, 'SELECT COUNT(*) AS n FROM vod_registered_candidate WHERE id = ?', candidateId) === 1;
}

/**
 * 组体全集(标题组除幂等 operation/登记候选外的成员:media_item 父/子、media_relation、
 * vod_title/line/episode、详情快照、导航序列、source_entry、playback_source online;
 * 幂等/候选行保护期独立于组保护窗,按各自用例断言)。
 */
function expectGroupBody(rig: Rig, group: MaterializedGroup, present: boolean, label: string): void {
  const hh = rig.seed.householdId;
  // present 组:多成员行(2 子媒体/2 子项)按行数断言;absent 组:统一 0
  const expectRow = (name: string, sql: string, params: readonly unknown[], want: number): void => {
    expect(scalarOf(rig, sql, ...params), `${label}:${name} 应为 ${want}`).toBe(want);
  };
  const checks: ReadonlyArray<[string, string, readonly unknown[]]> = [
    ['media_item 父', 'SELECT COUNT(*) AS n FROM media_item WHERE household_id = ? AND id = ?', [hh, group.parentMediaId]],
    [
      'media_item 子(vod_episode 角色)',
      `SELECT COUNT(*) AS n FROM media_item WHERE household_id = ? AND id IN (${group.childMediaIds.map(() => '?').join(',')})`,
      [hh, ...group.childMediaIds],
    ],
    ['vod_title', 'SELECT COUNT(*) AS n FROM vod_title WHERE household_id = ? AND id = ?', [hh, group.titleId]],
    ['vod_line', 'SELECT COUNT(*) AS n FROM vod_line WHERE household_id = ? AND id = ?', [hh, group.lineId]],
    [
      'vod_episode',
      `SELECT COUNT(*) AS n FROM vod_episode WHERE household_id = ? AND id IN (${group.episodeIds.map(() => '?').join(',')})`,
      [hh, ...group.episodeIds],
    ],
    ['vod_detail_snapshot', 'SELECT COUNT(*) AS n FROM vod_detail_snapshot WHERE household_id = ? AND title_id = ?', [hh, group.titleId]],
    ['vod_episode_sequence', 'SELECT COUNT(*) AS n FROM vod_episode_sequence WHERE household_id = ? AND title_id = ?', [hh, group.titleId]],
    ['media_relation', 'SELECT COUNT(*) AS n FROM media_relation WHERE household_id = ? AND parent_id = ?', [hh, group.parentMediaId]],
    ['source_entry', 'SELECT COUNT(*) AS n FROM source_entry WHERE household_id = ? AND id = ?', [hh, group.sourceEntryId]],
    ['playback_source(online)', 'SELECT COUNT(*) AS n FROM playback_source WHERE household_id = ? AND id = ?', [hh, group.playbackSourceId]],
  ];
  const rowsByIndex: ReadonlyArray<number> = [
    1,
    group.childMediaIds.length,
    1,
    1,
    group.episodeIds.length,
    1,
    2,
    group.childMediaIds.length,
    1,
    1,
  ];
  checks.forEach(([name, sql, params], index) => {
    expectRow(name, sql, params, present ? (rowsByIndex[index] as number) : 0);
  });
}

/** FK 全程完整(foreign_keys=ON;PRAGMA foreign_key_check 全库空) */
function expectForeignKeyClean(rig: Rig, label: string): void {
  const violations = rig.conn.prepare('PRAGMA foreign_key_check').all();
  expect(violations, `${label}:FK 引用图必须完整(无悬垂子行)`).toEqual([]);
}

/** 净配额口径(T070 QuotaStore 同式 COUNT):删除后自然回落 */
function quotaCountsOf(rig: Rig): { readonly parents: number; readonly episodes: number } {
  const hh = rig.seed.householdId;
  return {
    parents: scalarOf(rig, 'SELECT COUNT(*) AS n FROM vod_title WHERE household_id = ?', hh),
    episodes: scalarOf(rig, 'SELECT COUNT(*) AS n FROM vod_episode WHERE household_id = ?', hh),
  };
}

function expectAllZero(outcome: VodRetentionSweepOutcome): void {
  expect(outcome).toEqual(emptyVodRetentionSweepOutcome());
}

function groupRefOf(rig: Rig, group: MaterializedGroup): VodGroupRef {
  return { householdId: rig.seed.householdId, titleId: group.titleId, materializedAt: iso(rig.t0) };
}

/** 让渡微任务/快任务队列:启动首拍(void 链)整体排空 */
async function drain(): Promise<void> {
  for (let i = 0; i < 25; i += 1) {
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });
  }
}

/** 时钟推进到标题组窗满点(默认恰 24h) */
function advanceToProtectionBoundary(rig: Rig, materializedAtMs: number, offsetMs = 24 * 3_600_000): void {
  rig.clock.set(materializedAtMs + offsetMs);
}

/* ------------------------------------------------------------------ */
/* 用例                                                                  */
/* ------------------------------------------------------------------ */

describe('010 T084 · 24h 保护窗与整组清理(data-model §4)', () => {
  afterEach(closeRigs);

  it('W1 无引用组:恰好 24h 整组消失(成员表全清),配额自然回升,历史/偏好面零触碰;FK 全程完整', async () => {
    const rig = openRig();
    const group = materializeGroup(rig, { materializedAtMs: rig.t0, withCandidate: true });
    const before = quotaCountsOf(rig);
    expect(before.parents).toBe(1);
    expect(before.episodes).toBe(2);

    // 窗内(24h-1ms):组零变化;过期优先面的幂等/候选保护期(24h)未过,同样零回收
    advanceToProtectionBoundary(rig, rig.t0, 24 * 3_600_000 - 1);
    const insideWindow = await rig.service.runRetentionSweep();
    expect(insideWindow.groupsDeleted).toBe(0);
    expect(insideWindow.groupsRetainedProtected).toBe(0);
    expect(insideWindow.expiredMaterializationOperationsDeleted).toBe(0);
    expect(insideWindow.expiredRegisteredCandidatesDeleted).toBe(0);
    expectGroupBody(rig, group, true, '窗内');
    expect(operationExists(rig, group.operationId)).toBe(true);
    expect(candidateExists(rig, group.candidateId as string)).toBe(true);

    // 恰好 24h:「至少 24h 后才可整组清理」即窗满可清
    advanceToProtectionBoundary(rig, rig.t0);
    const outcome = await rig.service.runRetentionSweep();
    expect(outcome.groupsDeleted).toBe(1);
    expect(outcome.groupsRetainedProtected).toBe(0);
    // 联合回收:候选与 operation 同保护期同拍消失(候选 FK 子行先行)
    expect(outcome.expiredRegisteredCandidatesDeleted).toBe(1);
    expect(outcome.expiredMaterializationOperationsDeleted).toBe(1);
    expect(outcome.expiredPreferenceOperationsDeleted).toBe(0);
    expectGroupBody(rig, group, false, '窗满清扫后');
    expect(operationExists(rig, group.operationId)).toBe(false);
    expect(candidateExists(rig, group.candidateId as string)).toBe(false);
    // 配额回升不是显式动作:净计数(COUNT)自然回落
    const after = quotaCountsOf(rig);
    expect(after.parents).toBe(0);
    expect(after.episodes).toBe(0);
    expectForeignKeyClean(rig, '整组删除后');
  });

  it('W2 重复运行幂等:第二拍全零;ID 不复用(无 sequence 重置,新组全新身份照常落库)', async () => {
    const rig = openRig();
    const group = materializeGroup(rig, { materializedAtMs: rig.t0 });
    advanceToProtectionBoundary(rig, rig.t0);
    const first = await rig.service.runRetentionSweep();
    expect(first.groupsDeleted).toBe(1);
    const second = await rig.service.runRetentionSweep();
    expectAllZero(second);
    expectGroupBody(rig, group, false, '第二拍');
    // ID 不复用:删除后重新物化(新身份)不受任何 sequence/重置影响
    const regroup = materializeGroup(rig, { materializedAtMs: rig.t0 + 1000 });
    expect(regroup.titleId).not.toBe(group.titleId);
    expect(regroup.parentMediaId).not.toBe(group.parentMediaId);
    expectGroupBody(rig, regroup, true, '删除后新组');
    expectForeignKeyClean(rig, '重建后');
  });

  it('W3 删除面不含历史:会话/历史/偏好行零触碰(§4 不能靠删除历史释放配额)', async () => {
    const rig = openRig();
    materializeGroup(rig, { materializedAtMs: rig.t0 });
    const otherMediaId = `media-other-${randomUUID()}`;
    rig.conn
      .prepare(
        "INSERT INTO media_item (id, household_id, type, title, version, media_role, created_at, updated_at) VALUES (?, ?, 'movie', '其他媒体', 1, 'standalone', ?, ?)",
      )
      .run(otherMediaId, rig.seed.householdId, iso(rig.t0), iso(rig.t0));
    addHistoryOnChild(rig, otherMediaId);
    addPreferenceRowAndExpiredOperation(rig);
    advanceToProtectionBoundary(rig, rig.t0);
    await rig.service.runRetentionSweep();
    // 播放面/个人面零删除:溯源会话与历史行原样保留
    expect(
      scalarOf(
        rig,
        'SELECT COUNT(*) AS n FROM playback_session WHERE household_id = ? AND id = ?',
        rig.seed.householdId,
        rig.seed.provenanceSessionId,
      ),
      '溯源会话行不在删除面',
    ).toBe(1);
    expect(
      scalarOf(rig, 'SELECT COUNT(*) AS n FROM profile_viewing_history WHERE household_id = ? AND media_id = ?', rig.seed.householdId, otherMediaId),
      '历史行不在删除面',
    ).toBe(1);
    expect(
      scalarOf(rig, 'SELECT COUNT(*) AS n FROM profile_vod_preferences WHERE household_id = ?', rig.seed.householdId),
      '偏好行不在删除面',
    ).toBe(1);
    expectForeignKeyClean(rig, '清扫后');
  });
});

describe('010 T084 · 引用矩阵逐项(七类引用各自保组;§4 兜底)', () => {
  afterEach(closeRigs);

  it('R1 历史引用保组:profile_viewing_history 指向子媒体 → 整组保留,历史行原样', async () => {
    const rig = openRig();
    const group = materializeGroup(rig, { materializedAtMs: rig.t0 });
    addHistoryOnChild(rig, group.childMediaIds[0] as string);
    advanceToProtectionBoundary(rig, rig.t0);
    const outcome = await rig.service.runRetentionSweep();
    expect(outcome.groupsDeleted).toBe(0);
    expect(outcome.groupsRetainedProtected).toBe(1);
    const matrix = rig.store.describeVodGroupReferences(groupRefOf(rig, group), iso(rig.clock.now()));
    expect(matrix.history).toBe(true);
    expectGroupBody(rig, group, true, '历史保组');
    expect(
      scalarOf(rig, 'SELECT COUNT(*) AS n FROM profile_viewing_history WHERE media_id = ?', group.childMediaIds[0]),
      '历史行保留',
    ).toBe(1);
    expectForeignKeyClean(rig, '历史保组');
  });

  it('R2 名单引用保组:profile_policy allowed 列表含子媒体 → 整组保留', async () => {
    const rig = openRig();
    const group = materializeGroup(rig, { materializedAtMs: rig.t0 });
    addPolicyListWithMedia(rig, group.childMediaIds[1] as string);
    advanceToProtectionBoundary(rig, rig.t0);
    const outcome = await rig.service.runRetentionSweep();
    expect(outcome.groupsRetainedProtected).toBe(1);
    const matrix = rig.store.describeVodGroupReferences(groupRefOf(rig, group), iso(rig.clock.now()));
    expect(matrix.policyList).toBe(true);
    expectGroupBody(rig, group, true, '名单保组');
  });

  it('R3 会话FK引用保组:活动 playing 会话(在线资源)指向子媒体 → 整组保留,会话行原样', async () => {
    const rig = openRig();
    const group = materializeGroup(rig, { materializedAtMs: rig.t0 });
    const sessionId = addActiveSessionOnChild(rig, group.childMediaIds[0] as string, group.playbackSourceId);
    advanceToProtectionBoundary(rig, rig.t0);
    const outcome = await rig.service.runRetentionSweep();
    expect(outcome.groupsRetainedProtected).toBe(1);
    const matrix = rig.store.describeVodGroupReferences(groupRefOf(rig, group), iso(rig.clock.now()));
    expect(matrix.session).toBe(true);
    expectGroupBody(rig, group, true, '活动会话保组');
    expect(
      scalarOf(rig, "SELECT COUNT(*) AS n FROM playback_session WHERE id = ? AND state = 'playing'", sessionId),
      '活动会话行保留',
    ).toBe(1);
  });

  it('R4 意图引用保组:pending intent 目标为子媒体 → 整组保留(保留终态同权)', async () => {
    const rig = openRig();
    const group = materializeGroup(rig, { materializedAtMs: rig.t0 });
    addPendingIntentTargeting(rig, group.childMediaIds[0] as string);
    advanceToProtectionBoundary(rig, rig.t0);
    const outcome = await rig.service.runRetentionSweep();
    expect(outcome.groupsRetainedProtected).toBe(1);
    const matrix = rig.store.describeVodGroupReferences(groupRefOf(rig, group), iso(rig.clock.now()));
    expect(matrix.intent).toBe(true);
    expectGroupBody(rig, group, true, '意图保组');
  });

  it('R5 finish receipt/保留终态会话传递保组:ended 会话 + receipt 指向子媒体 → 整组保留,receipt 不被连带', async () => {
    const rig = openRig();
    const group = materializeGroup(rig, { materializedAtMs: rig.t0 });
    const sessionId = addEndedSessionWithReceiptOnChild(rig, group.childMediaIds[0] as string);
    advanceToProtectionBoundary(rig, rig.t0);
    const outcome = await rig.service.runRetentionSweep();
    expect(outcome.groupsRetainedProtected).toBe(1);
    expectGroupBody(rig, group, true, '终态会话+receipt 保组');
    expect(scalarOf(rig, 'SELECT COUNT(*) AS n FROM playback_finish_receipt WHERE session_id = ?', sessionId), 'receipt 保留').toBe(1);
  });

  it('R6 幂等/登记候选联合保组与联合回收:未过期刷新 operation+候选保组;到期后候选先行、组随清', async () => {
    const rig = openRig();
    // 组:标题 24h 前物化(窗满),但另一设备 1h 前以新 key 重物化同目标 →
    // 刷新 operation(23h 前提交,47h 后到期)+ 同事务登记候选均未过期 → 整组保留
    const group = materializeGroup(rig, { materializedAtMs: rig.t0, operationExpiresAtMs: rig.t0 + 12 * 3_600_000 });
    const refreshed = addRefreshOperationWithCandidate(rig, group, rig.t0 + 23 * 3_600_000);
    advanceToProtectionBoundary(rig, rig.t0);
    const outcome = await rig.service.runRetentionSweep();
    // 首个 operation(12h 保护期已过)回收;刷新 operation/候选未过期 → 整组保留
    expect(outcome.expiredMaterializationOperationsDeleted).toBe(1);
    expect(outcome.expiredRegisteredCandidatesDeleted).toBe(0);
    expect(outcome.groupsRetainedProtected).toBe(1);
    const matrix = rig.store.describeVodGroupReferences(groupRefOf(rig, group), iso(rig.clock.now()));
    expect(matrix.materializationOperation).toBe(true);
    expect(matrix.registeredCandidate).toBe(true);
    expectGroupBody(rig, group, true, '幂等/候选保组');
    expect(operationExists(rig, refreshed.operationId)).toBe(true);
    expect(candidateExists(rig, refreshed.candidateId)).toBe(true);
    // 再推进 24h:刷新 operation/候选到期,组无引用 → 整组消失(联合回收候选先行)
    advanceToProtectionBoundary(rig, rig.t0, 48 * 3_600_000);
    const later = await rig.service.runRetentionSweep();
    expect(later.expiredRegisteredCandidatesDeleted).toBe(1);
    expect(later.expiredMaterializationOperationsDeleted).toBe(1);
    expect(later.groupsDeleted).toBe(1);
    expectGroupBody(rig, group, false, '联合回收后');
    expect(operationExists(rig, refreshed.operationId)).toBe(false);
    expect(candidateExists(rig, refreshed.candidateId)).toBe(false);
    expectForeignKeyClean(rig, '联合回收');
  });

  it('R7 计划引用保组:next_plan 目标为子媒体(ref 未解绑)→ 整组保留(计划受引用保护,§10)', async () => {
    const rig = openRig();
    const group = materializeGroup(rig, { materializedAtMs: rig.t0 });
    addNextPlanTargeting(rig, group.childMediaIds[0] as string);
    advanceToProtectionBoundary(rig, rig.t0);
    const outcome = await rig.service.runRetentionSweep();
    expect(outcome.groupsRetainedProtected).toBe(1);
    const matrix = rig.store.describeVodGroupReferences(groupRefOf(rig, group), iso(rig.clock.now()));
    expect(matrix.nextPlan).toBe(true);
    expectGroupBody(rig, group, true, '计划保组');
  });

  it('R8 §4 兜底引用保组:审计失败事件指向子媒体(无会话行)→ 整组保留(其他持久引用)', async () => {
    const rig = openRig();
    const group = materializeGroup(rig, { materializedAtMs: rig.t0 });
    addFailureEventOnMedia(rig, group.childMediaIds[0] as string);
    advanceToProtectionBoundary(rig, rig.t0);
    const outcome = await rig.service.runRetentionSweep();
    expect(outcome.groupsRetainedProtected).toBe(1);
    const matrix = rig.store.describeVodGroupReferences(groupRefOf(rig, group), iso(rig.clock.now()));
    expect(matrix.otherPersistent).toBe(true);
    expect(matrix.session).toBe(false);
    expectGroupBody(rig, group, true, '兜底引用保组');
  });

  it('R9 多组混排:引用组保留与干净组删除同拍互不影响(逐组短事务)', async () => {
    const rig = openRig();
    const protectedGroup = materializeGroup(rig, { materializedAtMs: rig.t0 });
    const cleanGroup = materializeGroup(rig, { materializedAtMs: rig.t0 });
    addHistoryOnChild(rig, protectedGroup.childMediaIds[0] as string);
    advanceToProtectionBoundary(rig, rig.t0);
    const outcome = await rig.service.runRetentionSweep();
    expect(outcome.groupsDeleted).toBe(1);
    expect(outcome.groupsRetainedProtected).toBe(1);
    expectGroupBody(rig, protectedGroup, true, '受引用组');
    expectGroupBody(rig, cleanGroup, false, '干净组');
    expectForeignKeyClean(rig, '混排清扫');
  });
});

describe('010 T084 · 过期优先与偏好面(§4 先过期幂等/意图;§10 偏好 operation)', () => {
  afterEach(closeRigs);

  it('E1 过期优先序:候选/operation/偏好 operation 先回收,计划回收在组清扫之前(T059 面复用)', async () => {
    const rig = openRig();
    const group = materializeGroup(rig, { materializedAtMs: rig.t0, withCandidate: true });
    addPreferenceRowAndExpiredOperation(rig);
    // 过期未引用计划(ref NULL 无 intent 引用;T059 面同谓词,此处以结构端口复用)
    const expiredPlanId = `plan-exp-${randomUUID()}`;
    rig.conn
      .prepare(
        `INSERT INTO playback_next_plan (
          id, ref, household_id, device_session_id, profile_id, profile_context_version,
          from_session_id, from_generation, action, target_media_id, sequence_revision,
          detail_revision, target_content_revision, target_continuity_revision,
          target_locator_revision, history_revision, history_choice_required, created_at, expires_at
        ) VALUES (?, NULL, ?, ?, ?, 1, ?, 1, 'next', ?, 1, 1, 1, 1, 1, 0, 0, ?, ?)`,
      )
      .run(
        expiredPlanId,
        rig.seed.householdId,
        rig.seed.deviceSessionId,
        rig.seed.profileId,
        rig.seed.provenanceSessionId,
        rig.seed.provenanceMediaId,
        iso(rig.t0),
        iso(rig.t0 + 60_000),
      );
    const callOrder: string[] = [];
    const service = new VodRetentionService({
      store: rig.store,
      clock: () => rig.clock.now(),
      nextPlanRecycle: {
        deleteExpiredUnreferencedNextPlans(nowIso: string): number {
          callOrder.push(`nextPlanRecycle@${nowIso}`);
          // 序断言(过期优先):调用时候选/operation 已回收,组清扫尚未执行
          expect(operationExists(rig, group.operationId), '计划回收前过期 operation 应已回收').toBe(false);
          expect(candidateExists(rig, group.candidateId as string), '计划回收前过期候选应已联合回收').toBe(false);
          expect(scalarOf(rig, 'SELECT COUNT(*) AS n FROM vod_title WHERE id = ?', group.titleId), '计划回收时组清扫尚未执行(组仍在)').toBe(1);
          return rig.conn
            .prepare(
              `DELETE FROM playback_next_plan
               WHERE expires_at <= ? AND ref IS NULL
                 AND NOT EXISTS (
                   SELECT 1 FROM playback_transition_intent i
                   WHERE i.household_id = playback_next_plan.household_id AND i.next_plan_id = playback_next_plan.id
                 )`,
            )
            .run(nowIso).changes;
        },
      },
    });
    advanceToProtectionBoundary(rig, rig.t0);
    const outcome = await service.runRetentionSweep();
    expect(callOrder).toHaveLength(1);
    expect(outcome.expiredRegisteredCandidatesDeleted).toBe(1);
    expect(outcome.expiredMaterializationOperationsDeleted).toBe(1);
    expect(outcome.expiredPreferenceOperationsDeleted).toBe(1);
    expect(outcome.expiredUnreferencedNextPlansRecycled).toBe(1);
    expect(outcome.groupsDeleted).toBe(1);
    expectGroupBody(rig, group, false, '过期优先全拍');
    // §10:偏好 operation 已清,偏好行原样
    expect(scalarOf(rig, 'SELECT COUNT(*) AS n FROM profile_vod_preference_operation WHERE household_id = ?', rig.seed.householdId)).toBe(0);
    expect(
      scalarOf(rig, 'SELECT COUNT(*) AS n FROM profile_vod_preferences WHERE household_id = ? AND version = 3', rig.seed.householdId),
      '清理过期 operation 不删偏好',
    ).toBe(1);
    expect(scalarOf(rig, 'SELECT COUNT(*) AS n FROM playback_next_plan WHERE id = ?', expiredPlanId), '过期未引用计划已回收').toBe(0);
    expectForeignKeyClean(rig, '过期优先全拍');
  });

  it('E2 nextPlanRecycle 缺位 no-op:计划回收交由节拍链 T062 面,本拍计数为 0 且不误删', async () => {
    const rig = openRig();
    const group = materializeGroup(rig, { materializedAtMs: rig.t0 });
    advanceToProtectionBoundary(rig, rig.t0);
    const outcome = await rig.service.runRetentionSweep();
    expect(outcome.expiredUnreferencedNextPlansRecycled).toBe(0);
    expect(outcome.groupsDeleted).toBe(1);
    expectGroupBody(rig, group, false, '缺位计划回收');
  });
});

describe('010 T084 · T081 retention 节拍挂链(playback-retention 第三链;缺位 no-op)', () => {
  afterEach(closeRigs);

  it('B1 start() 启动首拍即携带 vod 清扫链;节拍推进续扫;端口缺位 runVodRetentionSweep 为 undefined', async () => {
    const rig = openRig();
    materializeGroup(rig, { materializedAtMs: rig.t0 });
    // 窗满(时钟已在保护边界后):启动首拍即收口,不等首个 15s 节拍
    advanceToProtectionBoundary(rig, rig.t0);
    const sweepCalls: number[] = [];
    const retention = new PlaybackRetentionService({
      budgets: createPlaybackBudgets(loadEnv({ NODE_ENV: 'test' })),
      clock: rig.clock,
      vodRetention: {
        runRetentionSweep: async (nowMs?: number) => {
          sweepCalls.push(nowMs ?? rig.clock.now());
          return await rig.service.runRetentionSweep(nowMs ?? rig.clock.now());
        },
      },
    });
    retention.start();
    await drain();
    expect(sweepCalls.length, '启动首拍(不等首个 15s 节拍)即携带 vod 清扫').toBe(1);
    expect(scalarOf(rig, 'SELECT COUNT(*) AS n FROM vod_title WHERE household_id = ?', rig.seed.householdId), '启动首拍即整组收口').toBe(0);
    // 节拍推进:15s watchdog 每拍续扫(幂等;第二拍零变化)
    await rig.clock.advance(15_000);
    await drain();
    expect(sweepCalls.length, '15s 节拍续扫').toBe(2);
    retention.stopTimers();
    // 缺位形态:返回 undefined(no-op),既有装配零变化
    const bare = new PlaybackRetentionService({ budgets: createPlaybackBudgets(loadEnv({ NODE_ENV: 'test' })), clock: rig.clock });
    await expect(bare.runVodRetentionSweep()).resolves.toBeUndefined();
  });
});
