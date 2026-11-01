import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import DatabaseConstructor from 'better-sqlite3';
import { drizzle, type BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { and, eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as schema from '@platform/database/schema';
import type { ProfileViewingHistory } from '@platform/database/schema';
import { createUnitOfWork, type UnitOfWork } from '@platform/database/unit-of-work';
import { createPlaybackTxParticipants } from '@contexts/playback/infrastructure/transaction-participants';
import { createPersonalDataTxParticipants } from '@contexts/personal-data/infrastructure/transaction-participants';
import { hashToken } from '@contexts/identity-access/infrastructure/token.service';
import { drizzleVodInputStore, type VodInputStore } from '@contexts/playback/infrastructure/playback-input-store.drizzle';
import { bindPersonalDataStore } from '@contexts/personal-data/application/personal-data-store.port';
import { drizzlePersonalDataStore } from '@contexts/personal-data/infrastructure/personal-data-store.drizzle';
import {
  compareTargetHistoryRevision,
  readResumeFreezePosition,
  readTargetHistory,
  readTargetMediaFacts,
} from '@contexts/personal-data/application/history.service';
import { resolveStartPoint } from '@contexts/online-vod/application/continuity.service';
import {
  freezeOnce,
  nearEndHintOf,
  VodStartPositionService,
  type VodStartPointDecision,
  type VodStartPositionCommand,
  type VodTransitionCarrySnapshot,
} from '@contexts/playback/application/vod-start-position.service';

/**
 * 010-online-vod T041(US2 服务级单测,真实 DDL + 真实 store)——
 * 唯一 beginning/target_history/transition_carry 起点计算端口。
 *
 * T041 原文(tasks.md):「在 personal-data/application/history.service.ts、
 * playback/application/vod-start-position.service.ts 实现唯一 beginning/target_history/
 * transition_carry 起点计算端口(carry 输入留给 US4 接线),本次 probe 后只冻结一次;
 * "nearEnd 只是 UI 提示";线上 duration 不从历史或其他 Profile 兜底,静态规则不变。
 * 审查补充:next 目标历史带 expectedHistoryRevision,probe 前变化失败 NEXT_PLAN_CHANGED。」
 *
 * 权威依据(先读后写):
 * - docs/specs/010-online-vod/data-model.md §5「本次 probe 未知则不能用历史 duration
 *   作为在线兜底」;§6「start_basis 三值互斥」「frozen_start_seconds(nullable 直到
 *   probe)」「本次 probe 后统一冻结一次位置」「每 session/generation 最多一有效绑定」;
 * - docs/specs/010-online-vod/contracts/playback-state.md §3「probe 后一次计算
 *   frozen_start_seconds;target_history 在该时刻读取当前 Profile 目标历史」「history
 *   canAttemptResume 仅候选,本次 probe 后降级从头显示具体 resumeReason 并保留旧历史」;
 * - docs/specs/010-online-vod/contracts/api.md §7 I3「target_history 在 probe 后仍读取
 *   当前历史;若与计划 historyRevision 不同,准备失败 NEXT_PLAN_CHANGED…会话进入 failed,
 *   不复活源。冻结起点后历史更新不改起点」;
 * - docs/specs/010-online-vod/spec.md FR-019(接近结尾窗口 min(30s,时长×10%) 只提示)/
 *   FR-020(容差 max(30s,旧时长×2%);静态媒体原续播行为保持不变)/FR-021(起点恰有一个
 *   服务端依据;一次冻结;另一设备后来更新不能改已冻结起点);
 * - T039 continuity.service(唯一权威起点语义):resolveStartPoint 冻结一次/computeResume
 *   Eligibility 8 步裁决/duration_unknown 绝不兜底 —— 本文件以真实 T039 纯函数作裁决端口
 *   (结构兼容注入,零深导入依赖),被测服务只做端口化封装+历史读取;
 * - T042 playback-input-store.drizzle(真实 store):bindFixedInput 落 playback_input_binding
 *   (frozen NULL 起);冻结写面归 T016 InputBindingTx.freezeStartSeconds(transaction-
 *   participants,frozen_at 持久守卫「已冻结(无论值)」,NULL 起点亦属合法冻结);
 * - 行为基线(既有绿,不得回归):test/unit/personal/progress-stop-resume.spec.ts(T090
 *   静态 readResumeFreezePosition 语义)、test/contract/me-personal.contract.spec.ts 与
 *   resume-precision.contract.spec.ts(静态续播零变化)。
 *
 * 装配方式(与 T040/T038 服务级 rig 同构,零 HTTP/零网络):
 * - 独立临时文件库 + 全量权威迁移 DDL(0001~0007,foreign_keys=ON 真实约束)+
 *   真实 UNIT_OF_WORK(playback/personalData 两键真实事务参与者);
 * - 读取面经既有 personal-data 仓储端口(bindPersonalDataStore(drizzlePersonalDataStore(
 *   同一连接)))驱动 T041 readTargetHistory/readTargetMediaFacts 与静态
 *   readResumeFreezePosition;绑定行经真实 drizzleVodInputStore(T042)落库,冻结经真实
 *   uow.run 的 InputBindingTx —— 服务/裁决/持久三层共用同一真实库;
 * - 裁决端口注入真实 T039 resolveStartPoint(唯一权威;本文件不复制任何裁决逻辑)。
 *
 * 矩阵:三起点互斥(beginning 显式从头/ target_history 经 T039 资格/ carry 快照在场 →
 * transition_carry[T073];快照缺席直呼仍稳定拒绝)·
 * 冻结一次(重复冻结仅首冻结生效;他设备更新历史不改变已冻结起点;frozen 原样返回;
 * 无决策不冻结)· expectedHistoryRevision 变化信号(一致通过/他设备更新/计划时无历史/
 * 历史行删除/probe 前可调用/beginning 不受计划历史变化影响)· 线上 duration 不兜底
 * (probe 未知 → duration_unknown 降级从头,历史 duration 不冒充本次事实;T039
 * duration_changed/H1 门经真实裁决回归)· 静态回归(history 兜底旧义/reason null/
 * nearEnd 仅提示)· nearEndHintOf 窗口(min(30s,10%))。
 */

/* ------------------------------------------------------------------ */
/* rig:真实 DDL + 真实 UNIT_OF_WORK + 真实 store(与 T040 rig 同构)        */
/* ------------------------------------------------------------------ */

type SqliteConnection = DatabaseConstructor.Database;

/** 夹具固定时刻(历史 last_viewed_at 锚点) */
const CLOCK_START_MS = Date.parse('2026-11-02T09:00:00.000Z');

/** T042 store io.resolveUpstream 夹具事实(绑定行落库所需;本文件不断言网络面) */
const BIND_INPUT_FACTS = {
  entryUrl: 'https://upstream.fixture/hls/ep-01.m3u8',
  locatorRevision: 1,
  detailRevision: 1,
  contentRevision: 1,
  continuityRevision: 2,
  evidenceState: 'unverified' as const,
  evidenceDigest: 'digest-t041',
  leaseSeconds: 600,
};

interface WorldSeed {
  readonly householdId: string;
  readonly profileAId: string;
  readonly profileBId: string;
  readonly deviceSessionAId: string;
  /** 静态 NAS 点播(旧义守卫面) */
  readonly staticVod: { readonly mediaId: string };
  /** 在线物化剧集(unverified 证据形态;content_revision=1、vod_episode.continuity_revision=2) */
  readonly onlineEpisode: { readonly mediaId: string; readonly sourceId: string };
}

interface Rig {
  readonly conn: SqliteConnection;
  readonly dataDir: string;
  readonly db: BetterSQLite3Database<typeof schema>;
  readonly uow: UnitOfWork<{ playback: typeof createPlaybackTxParticipants; personalData: typeof createPersonalDataTxParticipants }>;
  readonly inputStore: VodInputStore;
  readonly world: WorldSeed;
}

const openRigs: { conn: SqliteConnection; dataDir: string }[] = [];

/** 全量权威迁移(与 T040/T038 rig 同源;FK ON 下逐语句零违反) */
function applyAuthoritativeMigrations(conn: SqliteConnection): void {
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

function iso(ms: number): string {
  return new Date(ms).toISOString();
}

/** 身份 + 静态点播 + 在线剧集种子(FK 依赖序;与 T040 rig 同形) */
function seedWorld(conn: SqliteConnection, t0: number): WorldSeed {
  const now = iso(t0);
  const householdId = `hh-${randomUUID()}`;
  const accountId = `acc-${randomUUID()}`;
  const profileAId = `prof-${randomUUID()}`;
  const profileBId = `prof-${randomUUID()}`;
  const deviceIdA = `dev-${randomUUID()}`;
  const deviceSessionAId = `dsess-${randomUUID()}`;
  const staticSourceId = `src-${randomUUID()}`;
  const staticEntryId = `entry-${randomUUID()}`;
  const staticMediaId = `media-${randomUUID()}`;
  const staticPlaybackSourceId = `psrc-${randomUUID()}`;
  const onlineSourceId = `src-${randomUUID()}`;
  const onlineEntryId = `entry-${randomUUID()}`;
  const onlineParentMediaId = `media-${randomUUID()}`;
  const onlineEpisodeMediaId = `media-${randomUUID()}`;
  const onlinePlaybackSourceId = `psrc-${randomUUID()}`;
  const titleId = `vtitle-${randomUUID()}`;
  const lineId = `vline-${randomUUID()}`;
  const episodeRowId = `vep-${randomUUID()}`;

  conn.transaction(() => {
    conn.prepare('INSERT INTO household (id, name, created_at) VALUES (?, ?, ?)').run(householdId, 'T041 夹具家庭', now);
    conn
      .prepare(
        'INSERT INTO account (id, household_id, username, username_normalized, password_hash, role, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
      )
      .run(accountId, householdId, 't041', 't041', 'hash', 'owner', now);
    for (const [profileId, name] of [
      [profileAId, '档案A'],
      [profileBId, '档案B'],
    ] as const) {
      conn
        .prepare(
          "INSERT INTO profile (id, household_id, account_id, name, type, is_default, status, created_at) VALUES (?, ?, ?, ?, 'adult', 0, 'active', ?)",
        )
        .run(profileId, householdId, accountId, name, now);
    }
    conn.prepare("INSERT INTO device (id, household_id, name, type, created_at) VALUES (?, ?, '设备A', 'web', ?)").run(deviceIdA, householdId, now);
    conn
      .prepare(
        'INSERT INTO device_session (id, household_id, account_id, device_id, token_hash, active_profile_id, expires_at, last_active_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
      )
      .run(deviceSessionAId, householdId, accountId, deviceIdA, `token-hash-${deviceSessionAId}`, profileAId, iso(t0 + 7 * 24 * 3600_000), now, now);

    // 静态 NAS 点播(kind=nas + path entry + file 资源;无 vod_episode → T041 online=false 判别)
    conn
      .prepare(
        "INSERT INTO media_source (id, household_id, kind, name, root_key, relative_directory, private_access_approved, enabled, version, created_at, updated_at) VALUES (?, ?, 'nas', '夹具NAS', 't041-nas', 'media', 1, 1, 1, ?, ?)",
      )
      .run(staticSourceId, householdId, now, now);
    conn
      .prepare(
        "INSERT INTO media_item (id, household_id, type, title, content_level, version, media_role, content_revision, created_at, updated_at) VALUES (?, ?, 'movie', '静态影片', 0, 1, 'standalone', 1, ?, ?)",
      )
      .run(staticMediaId, householdId, now, now);
    conn
      .prepare(
        "INSERT INTO source_entry (id, household_id, source_id, identity_kind, identity_digest, media_id, present, first_seen_at, last_seen_at) VALUES (?, ?, ?, 'path', ?, ?, 1, ?, ?)",
      )
      .run(staticEntryId, householdId, staticSourceId, hashToken(`${staticSourceId}:movie.mp4`), staticMediaId, now, now);
    conn
      .prepare(
        "INSERT INTO playback_source (id, household_id, source_id, source_entry_id, media_item_id, protocol, location, mime_type, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 'file', '/nas-media/movie.mp4', 'video/mp4', ?, ?)",
      )
      .run(staticPlaybackSourceId, householdId, staticSourceId, staticEntryId, staticMediaId, now, now);

    // 在线物化剧集(kind=vod + vod_title/line/episode + online hls 资源;T031/T040 rig 同形)
    conn
      .prepare(
        "INSERT INTO media_source (id, household_id, kind, name, remote_url, enabled, version, locator_revision, created_at, updated_at) VALUES (?, ?, 'vod', '夹具在线片源', 'https://upstream.t041.fixture/api.php', 1, 1, 1, ?, ?)",
      )
      .run(onlineSourceId, householdId, now, now);
    conn.prepare("INSERT INTO vod_source_config (household_id, source_id, adapter) VALUES (?, ?, 'apple-cms-json')").run(householdId, onlineSourceId);
    conn
      .prepare(
        "INSERT INTO media_item (id, household_id, type, title, content_level, version, media_role, content_revision, created_at, updated_at) VALUES (?, ?, 'series', 'T041 剧集', 0, 1, 'vod_title', 1, ?, ?)",
      )
      .run(onlineParentMediaId, householdId, now, now);
    conn
      .prepare(
        "INSERT INTO media_item (id, household_id, type, title, content_level, version, media_role, content_revision, created_at, updated_at) VALUES (?, ?, 'episode', '第01集', 0, 1, 'vod_episode', 1, ?, ?)",
      )
      .run(onlineEpisodeMediaId, householdId, now, now);
    conn
      .prepare(
        'INSERT INTO vod_title (id, household_id, source_id, upstream_vod_id, parent_media_id, current_detail_revision, materialized_at) VALUES (?, ?, ?, ?, ?, 1, ?)',
      )
      .run(titleId, householdId, onlineSourceId, 'up-t041', onlineParentMediaId, now);
    conn
      .prepare('INSERT INTO vod_line (id, household_id, title_id, line_key, display_name, sort_order) VALUES (?, ?, ?, ?, ?, 1)')
      .run(lineId, householdId, titleId, 'main', '主线');
    // unverified 无证据集形态:continuity_revision=2(基线升级形态)、digest NULL(与 T040 rig 同形)
    conn
      .prepare(
        "INSERT INTO vod_episode (id, household_id, line_id, episode_key, label, media_id, content_version_state, continuity_revision) VALUES (?, ?, ?, 'ep-01', '第01集', ?, 'unverified', 2)",
      )
      .run(episodeRowId, householdId, lineId, onlineEpisodeMediaId);
    conn
      .prepare(
        "INSERT INTO source_entry (id, household_id, source_id, identity_kind, identity_digest, media_id, present, first_seen_at, last_seen_at) VALUES (?, ?, ?, 'vod_episode', ?, ?, 1, ?, ?)",
      )
      .run(onlineEntryId, householdId, onlineSourceId, hashToken(`${onlineSourceId}:ep-01`), onlineEpisodeMediaId, now, now);
    conn
      .prepare(
        "INSERT INTO playback_source (id, household_id, source_id, source_entry_id, media_item_id, protocol, location, locator_kind, vod_episode_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 'hls', NULL, 'online', ?, ?, ?)",
      )
      .run(onlinePlaybackSourceId, householdId, onlineSourceId, onlineEntryId, onlineEpisodeMediaId, episodeRowId, now, now);
  })(); // better-sqlite3:transaction(fn) 返回包装函数,必须调用一次才执行

  return {
    householdId,
    profileAId,
    profileBId,
    deviceSessionAId,
    staticVod: { mediaId: staticMediaId },
    onlineEpisode: { mediaId: onlineEpisodeMediaId, sourceId: onlineSourceId },
  };
}

/** T016 两键 txStores(playback 绑定面 + personalData 历史面;真实参与者) */
const TX_STORES = {
  playback: createPlaybackTxParticipants,
  personalData: createPersonalDataTxParticipants,
};

function openRig(): Rig {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hmp-t041-vod-start-'));
  const conn = new DatabaseConstructor(path.join(dataDir, `${randomUUID()}.db`));
  conn.pragma('journal_mode = WAL');
  conn.pragma('foreign_keys = ON');
  applyAuthoritativeMigrations(conn);
  const world = seedWorld(conn, CLOCK_START_MS - 60_000);
  openRigs.push({ conn, dataDir });
  return {
    conn,
    dataDir,
    db: drizzle(conn, { schema }),
    uow: createUnitOfWork({ resolveDatabase: () => conn, txStores: TX_STORES }),
    inputStore: drizzleVodInputStore({ handle: conn, nowMs: () => Date.now() }),
    world,
  };
}

/* ------------------------------------------------------------------ */
/* 被测服务装配(真实 T041 读取面 + 真实 T039 裁决 + 真实静态旧义)          */
/* ------------------------------------------------------------------ */

/** 被测服务:三端口全部真实实现(零 fake 裁决/零 fake 读取) */
function buildService(): VodStartPositionService {
  return new VodStartPositionService({
    targetHistory: { readTargetHistory, readTargetMediaFacts },
    adjudicator: { resolveStartPoint }, // T039 唯一权威起点语义(结构兼容端口)
    staticResumeFreeze: { readResumeFreeze: (input) => readResumeFreezePosition(input) },
  });
}

/** 在线起点计算命令快捷形态 */
function onlineCommand(input: {
  readonly mediaId: string;
  readonly requestedMode?: VodStartPositionCommand['requestedMode'];
  readonly probeDurationSeconds?: number | null;
  readonly expectedHistoryRevision?: number;
  readonly frozen?: VodStartPositionCommand['frozen'];
  readonly carry?: VodStartPositionCommand['carry'];
}): VodStartPositionCommand {
  return {
    mediaId: input.mediaId,
    requestedMode: input.requestedMode ?? 'resume',
    probeDurationSeconds: input.probeDurationSeconds ?? null,
    ...(input.expectedHistoryRevision !== undefined ? { expectedHistoryRevision: input.expectedHistoryRevision } : {}),
    ...(input.frozen !== undefined ? { frozen: input.frozen } : {}),
    ...(input.carry !== undefined ? { carry: input.carry } : {}),
  };
}

/* ------------------------------------------------------------------ */
/* 种子与读取辅助                                                         */
/* ------------------------------------------------------------------ */

/** epoch 历史行种子(工厂事实;continuity/evidence/completed/revision 可指定) */
function seedHistoryRowFor(
  conn: SqliteConnection,
  world: WorldSeed,
  input: {
    readonly profileId?: string;
    readonly mediaId: string;
    readonly writerEpoch: number;
    readonly writerSessionId: string;
    readonly positionSeconds: number;
    readonly durationSeconds: number | null;
    readonly revision?: number;
    readonly completed?: boolean;
    readonly continuityRevision?: number | null;
    readonly contentRevision?: number;
  },
): void {
  const contentRevision =
    input.contentRevision ??
    (conn.prepare('SELECT content_revision AS r FROM media_item WHERE id = ?').get(input.mediaId) as { r: number }).r;
  conn
    .prepare(
      `INSERT INTO profile_viewing_history (
        household_id, profile_id, media_id, writer_epoch, writer_playback_session_id,
        last_sample_seq, content_revision, position_seconds, duration_seconds,
        last_viewed_at, revision, completed, continuity_revision, evidence_state, evidence_digest
      ) VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      world.householdId,
      input.profileId ?? world.profileAId,
      input.mediaId,
      input.writerEpoch,
      input.writerSessionId,
      contentRevision,
      input.positionSeconds,
      input.durationSeconds,
      iso(CLOCK_START_MS - 60_000),
      input.revision ?? 1,
      input.completed === true ? 1 : 0,
      input.continuityRevision === undefined ? 2 : input.continuityRevision, // T040 在线保存形态默认快照 2
      input.continuityRevision === undefined ? 'unverified' : null,
      input.continuityRevision === undefined ? 'digest-t041' : null,
    );
}

function historyRowOf(
  db: BetterSQLite3Database<typeof schema>,
  world: WorldSeed,
  profileId: string,
  mediaId: string,
): ProfileViewingHistory | undefined {
  return db
    .select()
    .from(schema.profileViewingHistory)
    .where(
      and(
        eq(schema.profileViewingHistory.householdId, world.householdId),
        eq(schema.profileViewingHistory.profileId, profileId),
        eq(schema.profileViewingHistory.mediaId, mediaId),
      ),
    )
    .get();
}

/** ready 态在线会话行(T042 bindFixedInput 的 requireSession 前提) */
function seedSessionRow(conn: SqliteConnection, world: WorldSeed, mediaId: string, playbackSourceId: string): string {
  const at = iso(CLOCK_START_MS - 30_000);
  const sessionId = `sess-${randomUUID()}`;
  conn
    .prepare(
      `INSERT INTO playback_session (
        id, household_id, device_session_id, device_id, profile_id, media_id, playback_source_id,
        state, delivery, generation, version, position_seconds, desired_paused,
        profile_context_version, created_at, started_at, last_heartbeat_at, failure_code
      ) VALUES (?, ?, ?, (SELECT device_id FROM device_session WHERE id = ?), ?, ?, ?, 'ready', 'hls_proxy', 1, 1, 0, 0, 1, ?, ?, ?, NULL)`,
    )
    .run(sessionId, world.householdId, world.deviceSessionAId, world.deviceSessionAId, world.profileAId, mediaId, playbackSourceId, at, at, at);
  return sessionId;
}

function playbackSourceIdOf(conn: SqliteConnection, world: WorldSeed, mediaId: string): string {
  const row = conn
    .prepare('SELECT id FROM playback_source WHERE household_id = ? AND media_item_id = ? LIMIT 1')
    .get(world.householdId, mediaId) as { id: string } | undefined;
  expect(row, `夹具错误:media ${mediaId} 应有播放资源`).toBeDefined();
  return row!.id;
}

/** 绑定行冻结面读取 */
function bindingRowOf(conn: SqliteConnection, world: WorldSeed, bindingId: string): { frozenStartSeconds: number | null; frozenAt: string | null; startBasis: string } {
  const row = conn
    .prepare(
      'SELECT frozen_start_seconds AS frozenStartSeconds, frozen_at AS frozenAt, start_basis AS startBasis FROM playback_input_binding WHERE household_id = ? AND id = ?',
    )
    .get(world.householdId, bindingId) as { frozenStartSeconds: number | null; frozenAt: string | null; startBasis: string } | undefined;
  expect(row, `夹具错误:绑定行 ${bindingId} 不存在`).toBeDefined();
  return row!;
}

/** 真实绑定(probe 前:frozen NULL;返回 bindingId) */
async function bindOnlineInput(rig: Rig): Promise<{ sessionId: string; bindingId: string }> {
  const mediaId = rig.world.onlineEpisode.mediaId;
  const sessionId = seedSessionRow(rig.conn, rig.world, mediaId, playbackSourceIdOf(rig.conn, rig.world, mediaId));
  const bound = await rig.inputStore.bindFixedInput(
    { householdId: rig.world.householdId, sessionId, generation: 1, sourceId: rig.world.onlineEpisode.sourceId, startBasis: 'target_history' },
    { resolveUpstream: async () => BIND_INPUT_FACTS },
  );
  return { sessionId, bindingId: bound.bindingId };
}

/** 计算决策的判别快捷断言:computed 形态收敛(三起点互斥的断言基元) */
function expectComputed(decision: VodStartPointDecision): asserts decision is Extract<VodStartPointDecision, { kind: 'computed' }> {
  expect(decision.kind, `应产出 computed 决策,实际 ${JSON.stringify(decision)}`).toBe('computed');
}

/* ------------------------------------------------------------------ */
/* 用例                                                                  */
/* ------------------------------------------------------------------ */

describe('T041 · 三起点互斥矩阵(beginning / target_history / transition_carry)', () => {
  let rig: Rig;
  let service: VodStartPositionService;

  beforeEach(() => {
    rig = openRig();
    bindPersonalDataStore(drizzlePersonalDataStore(rig.db));
    service = buildService();
  });

  it('同媒体三模式各恰一个 startBasis 依据:beginning=0 / resume=T039 历史位置 / carry=显式拒绝', async () => {
    const { world } = rig;
    const mediaId = world.onlineEpisode.mediaId;
    seedHistoryRowFor(rig.conn, world, {
      mediaId,
      writerEpoch: 1,
      writerSessionId: `w-${randomUUID()}`,
      positionSeconds: 120,
      durationSeconds: 360,
    });
    const context = { householdId: world.householdId, profileId: world.profileAId };
    const beginning = service.computeStartPosition(context, onlineCommand({ mediaId, requestedMode: 'beginning', probeDurationSeconds: 360 }));
    const resume = service.computeStartPosition(context, onlineCommand({ mediaId, requestedMode: 'resume', probeDurationSeconds: 360 }));
    const targetHistory = service.computeStartPosition(context, onlineCommand({ mediaId, requestedMode: 'target_history', probeDurationSeconds: 360 }));
    const carry = service.computeStartPosition(context, onlineCommand({ mediaId, requestedMode: 'transition_carry', probeDurationSeconds: 360 }));

    expectComputed(beginning);
    expect(beginning).toMatchObject({ startBasis: 'beginning', disposition: 'beginning', resumeReason: 'requested_beginning', startSeconds: 0, nearEnd: false });
    expectComputed(resume);
    expect(resume).toMatchObject({ startBasis: 'target_history', disposition: 'resume', resumeReason: 'accepted', startSeconds: 120 });
    // positionMode 面与 startMode 面同一起点裁决(target_history ≡ resume)
    expect(targetHistory).toEqual(resume);
    // carry:稳定错误形态(US4 接线占位),不产出任何 startBasis
    expect(carry).toEqual({ kind: 'carry-not-wired' });
    // 三起点互斥:computed 决策的 startBasis 恒 ∈ beginning|target_history(carry 恒不由本服务产出)
    for (const decision of [beginning, resume, targetHistory]) {
      expectComputed(decision);
      expect(['beginning', 'target_history']).toContain(decision.startBasis);
      expect(decision.startBasis).not.toBe('transition_carry');
    }
  });

  it('carry 快照在场 → computed transition_carry 且读取面零触达(不读历史不猜起点;T073 接线)', () => {
    const { world } = rig;
    const mediaId = world.onlineEpisode.mediaId;
    seedHistoryRowFor(rig.conn, world, {
      mediaId,
      writerEpoch: 1,
      writerSessionId: `w-${randomUUID()}`,
      positionSeconds: 120,
      durationSeconds: 360,
    });
    let historyReads = 0;
    const counted = new VodStartPositionService({
      targetHistory: {
        readTargetHistory: (input) => {
          historyReads += 1;
          return readTargetHistory(input);
        },
        readTargetMediaFacts,
      },
      adjudicator: { resolveStartPoint },
      staticResumeFreeze: { readResumeFreeze: (input) => readResumeFreezePosition(input) },
    });
    const carry = counted.computeStartPosition(
      { householdId: world.householdId, profileId: world.profileAId },
      onlineCommand({
        mediaId,
        requestedMode: 'transition_carry',
        probeDurationSeconds: 360,
        carry: {
          carryPositionSeconds: 88,
          carryDurationSeconds: 360,
          sourceCheckpoint: { expectedGeneration: 1, sampleSeq: 3 },
        },
      }),
    );
    // T073:快照在场即 carry 路径 —— 起点仅取冻结 checkpoint 位置(88),目标历史 120 不劫持
    expectComputed(carry);
    expect(carry).toMatchObject({ startBasis: 'transition_carry', disposition: 'resume', resumeReason: 'accepted', startSeconds: 88, historyRevision: 0 });
    expect(historyReads, 'carry 路径不得触达历史读取(不读目标历史,playback-state §2)').toBe(0);
  });

  it('resume 资格拒绝矩阵经真实 T039 裁决:no_history/content_changed/continuity_changed/completed/invalid_position/duration_changed 各降级从头并携带原因', () => {
    const { world } = rig;
    const context = { householdId: world.householdId, profileId: world.profileAId };
    const online = world.onlineEpisode.mediaId;
    const seed = (input: Partial<Parameters<typeof seedHistoryRowFor>[2]> & { readonly mediaId?: string }) =>
      seedHistoryRowFor(rig.conn, world, {
        mediaId: input.mediaId ?? online,
        writerEpoch: 1,
        writerSessionId: `w-${randomUUID()}`,
        positionSeconds: input.positionSeconds ?? 120,
        durationSeconds: input.durationSeconds ?? 360,
        ...(input.completed !== undefined ? { completed: input.completed } : {}),
        ...(input.continuityRevision !== undefined ? { continuityRevision: input.continuityRevision } : {}),
        ...(input.contentRevision !== undefined ? { contentRevision: input.contentRevision } : {}),
      });

    // no_history:无历史行
    const noHistory = service.computeStartPosition(context, onlineCommand({ mediaId: online, probeDurationSeconds: 360 }));
    expect(noHistory).toMatchObject({ kind: 'computed', startBasis: 'beginning', disposition: 'beginning', resumeReason: 'no_history', startSeconds: 0 });

    // content_changed:当前内容修订前进(工厂事实:media_item.content_revision 1→2)
    seed({});
    rig.conn.prepare('UPDATE media_item SET content_revision = 2 WHERE id = ?').run(online);
    expect(service.computeStartPosition(context, onlineCommand({ mediaId: online, probeDurationSeconds: 360 }))).toMatchObject({
      startBasis: 'beginning',
      resumeReason: 'content_changed',
    });
    rig.conn.prepare('UPDATE media_item SET content_revision = 1 WHERE id = ?').run(online);

    // continuity_changed:当前子项连续性修订前进(工厂事实:vod_episode.continuity_revision 2→3)
    rig.conn.prepare('UPDATE vod_episode SET continuity_revision = 3 WHERE media_id = ?').run(online);
    expect(service.computeStartPosition(context, onlineCommand({ mediaId: online, probeDurationSeconds: 360 }))).toMatchObject({
      startBasis: 'beginning',
      resumeReason: 'continuity_changed',
    });
    rig.conn.prepare('UPDATE vod_episode SET continuity_revision = 2 WHERE media_id = ?').run(online);

    // completed:仅有效 finish 写
    rig.conn.prepare('UPDATE profile_viewing_history SET completed = 1 WHERE media_id = ?').run(online);
    expect(service.computeStartPosition(context, onlineCommand({ mediaId: online, probeDurationSeconds: 360 }))).toMatchObject({
      startBasis: 'beginning',
      resumeReason: 'completed',
    });
    rig.conn.prepare('UPDATE profile_viewing_history SET completed = 0 WHERE media_id = ?').run(online);

    // invalid_position:p=保存时长(越界)
    rig.conn.prepare('UPDATE profile_viewing_history SET position_seconds = 360 WHERE media_id = ?').run(online);
    expect(service.computeStartPosition(context, onlineCommand({ mediaId: online, probeDurationSeconds: 360 }))).toMatchObject({
      startBasis: 'beginning',
      resumeReason: 'invalid_position',
    });
    rig.conn.prepare('UPDATE profile_viewing_history SET position_seconds = 120 WHERE media_id = ?').run(online);

    // duration_changed:本次时长拉长超容差(Δ=640 > max(30,7.2)),位置仍落本次时长域内
    expect(service.computeStartPosition(context, onlineCommand({ mediaId: online, probeDurationSeconds: 1000 }))).toMatchObject({
      startBasis: 'beginning',
      resumeReason: 'duration_changed',
    });

    // 跨 Profile 隔离(FR-018 只读同目标历史):档案B 无该媒体历史 → no_history
    expect(
      service.computeStartPosition({ householdId: world.householdId, profileId: world.profileBId }, onlineCommand({ mediaId: online, probeDurationSeconds: 360 })),
    ).toMatchObject({ startBasis: 'beginning', resumeReason: 'no_history' });
  });

  it('旧在线历史无 continuity 快照(NULL)不冒充在线证据 → 保守 continuity_changed 降级从头', () => {
    const { world } = rig;
    const online = world.onlineEpisode.mediaId;
    seedHistoryRowFor(rig.conn, world, {
      mediaId: online,
      writerEpoch: 1,
      writerSessionId: `w-${randomUUID()}`,
      positionSeconds: 120,
      durationSeconds: 360,
      continuityRevision: null, // 0007「旧记录不冒充在线 continuity 证据」
    });
    const decision = service.computeStartPosition(
      { householdId: world.householdId, profileId: world.profileAId },
      onlineCommand({ mediaId: online, probeDurationSeconds: 360 }),
    );
    expect(decision).toMatchObject({ kind: 'computed', startBasis: 'beginning', resumeReason: 'continuity_changed', startSeconds: 0 });
    // 旧历史保留(降级不删历史,playback-state §3)
    expect(historyRowOf(rig.db, world, rig.world.profileAId, online)?.positionSeconds).toBe(120);
  });
});

/* ------------------------------------------------------------------ */
/* T073 · transition_carry 接线(T072 intent 冻结快照消费)                  */
/* 三互斥入参判别一途:carry 快照在场 → carry 路径;否则 requestedMode 走既有。 */
/* ------------------------------------------------------------------ */

describe('T073 · transition_carry 接线(carry 快照入参判别一途;final 不覆盖钉面)', () => {
  let rig: Rig;
  let service: VodStartPositionService;
  let world: WorldSeed;
  let online: string;
  const contextOf = (): { householdId: string; profileId: string } => ({ householdId: world.householdId, profileId: world.profileAId });

  beforeEach(() => {
    rig = openRig();
    bindPersonalDataStore(drizzlePersonalDataStore(rig.db));
    service = buildService();
    world = rig.world;
    online = world.onlineEpisode.mediaId;
  });

  /**
   * T072 intent 冻结 carry 快照(消费事务复核后的形态):position/duration 为精确
   * checkpoint 读取后自来源 ledger 复制值,checkpoint=来源接受游标身份(e2e C1 同值形)。
   */
  function carrySnapshot(input: {
    readonly positionSeconds: number;
    readonly durationSeconds?: number | null;
    readonly checkpoint?: { readonly expectedGeneration: number; readonly sampleSeq: number } | null;
  }): VodTransitionCarrySnapshot {
    return {
      carryPositionSeconds: input.positionSeconds,
      carryDurationSeconds: input.durationSeconds === undefined ? 3600 : input.durationSeconds,
      sourceCheckpoint: input.checkpoint === undefined ? { expectedGeneration: 1, sampleSeq: 7 } : input.checkpoint,
    };
  }

  it('快照透传:startSeconds=carryPositionSeconds 原样透出(resume/accepted/historyRevision=0)', () => {
    const decision = service.computeStartPosition(
      contextOf(),
      onlineCommand({
        mediaId: online,
        requestedMode: 'transition_carry',
        probeDurationSeconds: 3600,
        carry: carrySnapshot({ positionSeconds: 240 }),
      }),
    );
    expectComputed(decision);
    // e2e C1 同形:frozen=240(精确接受游标);checkpoint 身份随快照在场(输入形态钉面,
    // 本服务不复核 —— 精确性由 T072 创建+消费双重复核)
    expect(decision).toMatchObject({
      startBasis: 'transition_carry',
      disposition: 'resume',
      resumeReason: 'accepted',
      startSeconds: 240,
      historyRevision: 0,
    });
  });

  it('三互斥一途:快照在场压过一切 —— 他设备历史在场/expectedHistoryRevision 漂移/requestedMode 面都不改 carry 路径', () => {
    // 他设备目标历史(revision 2/位置 355)+ 计划基准 revision 1:若走 target_history
    // 必产出 history-changed;carry 路径两者皆不触达
    seedHistoryRowFor(rig.conn, world, { mediaId: online, writerEpoch: 1, writerSessionId: `w-${randomUUID()}`, positionSeconds: 355, durationSeconds: 360, revision: 2 });
    let historyReads = 0;
    const counted = new VodStartPositionService({
      targetHistory: {
        readTargetHistory: (input) => {
          historyReads += 1;
          return readTargetHistory(input);
        },
        readTargetMediaFacts,
      },
      adjudicator: { resolveStartPoint },
      staticResumeFreeze: { readResumeFreeze: (input) => readResumeFreezePosition(input) },
    });
    const carry = counted.computeStartPosition(
      contextOf(),
      onlineCommand({
        mediaId: online,
        requestedMode: 'transition_carry',
        probeDurationSeconds: 3600,
        expectedHistoryRevision: 1,
        carry: carrySnapshot({ positionSeconds: 240 }),
      }),
    );
    expectComputed(carry);
    expect(carry.startSeconds, 'carry 只取冻结 checkpoint 位置,他设备历史(355)不劫持(e2e C1 钉面)').toBe(240);
    expect(carry.historyRevision, '不读目标历史:revision 恒 0').toBe(0);
    expect(historyReads, 'carry 判别先于一切读取与比对(零历史触达)').toBe(0);
    // 入参判别一途:快照在场时 requestedMode 面不参与路径选择(resume 请求同样 carry)
    const modeAgnostic = service.computeStartPosition(
      contextOf(),
      onlineCommand({ mediaId: online, requestedMode: 'resume', probeDurationSeconds: 3600, carry: carrySnapshot({ positionSeconds: 240 }) }),
    );
    expect(modeAgnostic).toMatchObject({ kind: 'computed', startBasis: 'transition_carry', startSeconds: 240 });
  });

  it('不做容差降级:源/目标时长巨差与 carryDurationSeconds 未知都不回退 beginning(降级族仅 resume 资格面);nearEnd 以本次 probe duration 计', () => {
    // 源 ledger 时长 360 vs 本次 probe 3600(Δ 超任何容差):carry 不比较时长,不回退
    const durationGap = service.computeStartPosition(
      contextOf(),
      onlineCommand({
        mediaId: online,
        requestedMode: 'transition_carry',
        probeDurationSeconds: 3600,
        carry: carrySnapshot({ positionSeconds: 240, durationSeconds: 360 }),
      }),
    );
    expectComputed(durationGap);
    expect(durationGap).toMatchObject({ startBasis: 'transition_carry', disposition: 'resume', resumeReason: 'accepted', startSeconds: 240 });
    // carryDurationSeconds 未知(null;绝不以此兜底本次时长,data-model §5)同形
    const unknownDuration = service.computeStartPosition(
      contextOf(),
      onlineCommand({
        mediaId: online,
        requestedMode: 'transition_carry',
        probeDurationSeconds: 3600,
        carry: carrySnapshot({ positionSeconds: 240, durationSeconds: null }),
      }),
    );
    expect(unknownDuration).toMatchObject({ kind: 'computed', startBasis: 'transition_carry', startSeconds: 240 });
    // nearEnd 仅提示(FR-019)且以本次 probe duration(目标时间轴)计:3600-3585=15 ≤
    // min(30,360);短源时长(300)不参与 —— 若误以 carryDurationSeconds 计则 3585>300 恒 false
    const nearEnd = service.computeStartPosition(
      contextOf(),
      onlineCommand({
        mediaId: online,
        requestedMode: 'transition_carry',
        probeDurationSeconds: 3600,
        carry: carrySnapshot({ positionSeconds: 3585, durationSeconds: 300 }),
      }),
    );
    expectComputed(nearEnd);
    expect(nearEnd.nearEnd, 'nearEnd 按 probe duration(目标时间轴)计,不按冻结源时长').toBe(true);
    expect(nearEnd.startSeconds).toBe(3585);
    // checkpoint 身份缺省 null(T072 定稿端口面仅透传位置):不参与任何裁决,同形透出
    const withoutCheckpoint = service.computeStartPosition(
      contextOf(),
      onlineCommand({
        mediaId: online,
        requestedMode: 'transition_carry',
        probeDurationSeconds: 3600,
        carry: carrySnapshot({ positionSeconds: 240, checkpoint: null }),
      }),
    );
    expect(withoutCheckpoint).toMatchObject({ kind: 'computed', startBasis: 'transition_carry', startSeconds: 240 });
  });

  it('final 不覆盖钉面(输入形态):快照值即冻结值 —— freezeOnce 落 240 后任何后续决策不二次覆盖(全链验证归 T058)', async () => {
    const { bindingId } = await bindOnlineInput(rig);
    const decision = service.computeStartPosition(
      contextOf(),
      onlineCommand({
        mediaId: online,
        requestedMode: 'transition_carry',
        probeDurationSeconds: 3600,
        carry: carrySnapshot({ positionSeconds: 240 }),
      }),
    );
    expectComputed(decision);
    rig.uow.run(
      (tx) => tx.playback,
      (inputBinding) => {
        freezeOnce({ householdId: world.householdId, bindingId, decision, inputBinding });
        return null;
      },
      { behavior: 'immediate' },
    );
    const first = bindingRowOf(rig.conn, world, bindingId);
    expect(first.frozenStartSeconds, 'carry 冻结值=快照位置(输入形态钉面:快照值即冻结值)').toBe(240);
    expect(first.frozenAt).not.toBeNull();
    // 后续任意决策(以 beginning 0 形态模拟 ready 复核面的二次冻结调用)不得覆盖已冻结值:
    // frozen_at 持久守卫「已冻结(无论值)」仅首冻结落值 —— 「final 不覆盖」全链由 T058
    // 验证,本处只钉 computeStartPosition 输入形态(决策值=快照值,绑定行回读透传已冻结值)
    rig.uow.run(
      (tx) => tx.playback,
      (inputBinding) => {
        freezeOnce({
          householdId: world.householdId,
          bindingId,
          decision: {
            kind: 'computed',
            startBasis: 'beginning',
            disposition: 'beginning',
            resumeReason: 'requested_beginning',
            startSeconds: 0,
            nearEnd: false,
            historyRevision: 0,
          },
          inputBinding,
        });
        return null;
      },
      { behavior: 'immediate' },
    );
    expect(bindingRowOf(rig.conn, world, bindingId)).toEqual(first);
  });
});

describe('T041 · 线上 duration 不从历史兜底(data-model §5;E1 读取侧同规)', () => {
  let rig: Rig;
  let service: VodStartPositionService;

  beforeEach(() => {
    rig = openRig();
    bindPersonalDataStore(drizzlePersonalDataStore(rig.db));
    service = buildService();
  });

  it('probe 未知(null)→ duration_unknown 降级从头:历史 duration 360 存在也不冒充本次事实', () => {
    const { world } = rig;
    const online = world.onlineEpisode.mediaId;
    seedHistoryRowFor(rig.conn, world, {
      mediaId: online,
      writerEpoch: 1,
      writerSessionId: `w-${randomUUID()}`,
      positionSeconds: 300,
      durationSeconds: 360,
    });
    const decision = service.computeStartPosition(
      { householdId: world.householdId, profileId: world.profileAId },
      onlineCommand({ mediaId: online, probeDurationSeconds: null }),
    );
    // 若以历史 duration 兜底 → 会错误接受 300;010 禁止(线上起点不从历史兜底)
    expect(decision).toMatchObject({ kind: 'computed', startBasis: 'beginning', disposition: 'beginning', resumeReason: 'duration_unknown', startSeconds: 0 });
  });

  it('probe 已知但历史无 duration(保存时未知)→ T039 duration_unknown(任一侧缺可信时长都无法建立时长兼容)', () => {
    const { world } = rig;
    const online = world.onlineEpisode.mediaId;
    seedHistoryRowFor(rig.conn, world, {
      mediaId: online,
      writerEpoch: 1,
      writerSessionId: `w-${randomUUID()}`,
      positionSeconds: 300,
      durationSeconds: null,
    });
    expect(
      service.computeStartPosition({ householdId: world.householdId, profileId: world.profileAId }, onlineCommand({ mediaId: online, probeDurationSeconds: 3600 })),
    ).toMatchObject({ kind: 'computed', startBasis: 'beginning', resumeReason: 'duration_unknown', startSeconds: 0 });
  });

  it('T039 漂移门回归:H1 门面 —— 本次缩水到位置容差域之外时位置锚定保存时长原样继承(≠ duration_changed)', () => {
    const { world } = rig;
    const online = world.onlineEpisode.mediaId;
    // p=350,保存=360,本次=90(Δ=270>容差 30,但 350 不落 90+30 域内 → 继承 350;T039 G2/H1 钉面)
    seedHistoryRowFor(rig.conn, world, {
      mediaId: online,
      writerEpoch: 1,
      writerSessionId: `w-${randomUUID()}`,
      positionSeconds: 350,
      durationSeconds: 360,
    });
    expect(
      service.computeStartPosition({ householdId: world.householdId, profileId: world.profileAId }, onlineCommand({ mediaId: online, probeDurationSeconds: 90 })),
    ).toMatchObject({ kind: 'computed', startBasis: 'target_history', disposition: 'resume', resumeReason: 'accepted', startSeconds: 350 });
  });

  it('线上其他 Profile 历史不兜底:档案A 无历史时读档案B 历史仍 no_history(FR-018 只读同目标历史)', () => {
    const { world } = rig;
    const online = world.onlineEpisode.mediaId;
    seedHistoryRowFor(rig.conn, world, {
      profileId: world.profileBId,
      mediaId: online,
      writerEpoch: 1,
      writerSessionId: `w-${randomUUID()}`,
      positionSeconds: 300,
      durationSeconds: 360,
    });
    expect(
      service.computeStartPosition({ householdId: world.householdId, profileId: world.profileAId }, onlineCommand({ mediaId: online, probeDurationSeconds: 360 })),
    ).toMatchObject({ kind: 'computed', startBasis: 'beginning', resumeReason: 'no_history', startSeconds: 0 });
  });
});

describe('T041 · expectedHistoryRevision 变化信号(api.md §7 I3 NEXT_PLAN_CHANGED 原语)', () => {
  let rig: Rig;
  let service: VodStartPositionService;
  let world: WorldSeed;
  let online: string;
  const contextOf = (): { householdId: string; profileId: string } => ({ householdId: world.householdId, profileId: world.profileAId });

  beforeEach(() => {
    rig = openRig();
    bindPersonalDataStore(drizzlePersonalDataStore(rig.db));
    service = buildService();
    world = rig.world;
    online = world.onlineEpisode.mediaId;
  });

  it('计划 revision 与当前一致 → 正常计算;省略 = 非计划路径不比对', () => {
    seedHistoryRowFor(rig.conn, world, { mediaId: online, writerEpoch: 1, writerSessionId: `w-${randomUUID()}`, positionSeconds: 120, durationSeconds: 360 });
    const matched = service.computeStartPosition(contextOf(), onlineCommand({ mediaId: online, probeDurationSeconds: 360, expectedHistoryRevision: 1 }));
    expect(matched).toMatchObject({ kind: 'computed', startBasis: 'target_history', startSeconds: 120, historyRevision: 1 });
    const withoutPlan = service.computeStartPosition(contextOf(), onlineCommand({ mediaId: online, probeDurationSeconds: 360 }));
    expect(withoutPlan).toMatchObject({ kind: 'computed', startBasis: 'target_history', startSeconds: 120 });
  });

  it('probe 前变化(probe 未知)同样失败:history-changed 携带当前 revision —— 比对不依赖 probe', () => {
    seedHistoryRowFor(rig.conn, world, { mediaId: online, writerEpoch: 1, writerSessionId: `w-${randomUUID()}`, positionSeconds: 120, durationSeconds: 360 });
    // 工厂事实:他设备更新历史(revision 1→2,位置 120→355;等价另一设备新 started)
    rig.conn
      .prepare('UPDATE profile_viewing_history SET revision = 2, position_seconds = 355 WHERE media_id = ? AND profile_id = ?')
      .run(online, world.profileAId);
    const beforeProbe = service.computeStartPosition(contextOf(), onlineCommand({ mediaId: online, probeDurationSeconds: null, expectedHistoryRevision: 1 }));
    expect(beforeProbe).toEqual({ kind: 'history-changed', currentHistoryRevision: 2 });
  });

  it('计划时无历史(expected=0):仍无历史 → 一致放行(no_history 计算);probe 时已产生历史 → history-changed(存在性翻转也是变更)', () => {
    const consistent = service.computeStartPosition(contextOf(), onlineCommand({ mediaId: online, probeDurationSeconds: null, expectedHistoryRevision: 0 }));
    expect(consistent).toMatchObject({ kind: 'computed', startBasis: 'beginning', resumeReason: 'no_history', startSeconds: 0 });
    seedHistoryRowFor(rig.conn, world, { mediaId: online, writerEpoch: 1, writerSessionId: `w-${randomUUID()}`, positionSeconds: 120, durationSeconds: 360 });
    const nowChanged = service.computeStartPosition(contextOf(), onlineCommand({ mediaId: online, probeDurationSeconds: null, expectedHistoryRevision: 0 }));
    expect(nowChanged).toEqual({ kind: 'history-changed', currentHistoryRevision: 1 });
  });

  it('历史行被删除(expected=2,当前 0)→ history-changed;比对原语直证(compareTargetHistoryRevision)', () => {
    seedHistoryRowFor(rig.conn, world, { mediaId: online, writerEpoch: 1, writerSessionId: `w-${randomUUID()}`, positionSeconds: 120, durationSeconds: 360, revision: 2 });
    rig.conn
      .prepare('DELETE FROM profile_viewing_history WHERE household_id = ? AND profile_id = ? AND media_id = ?')
      .run(world.householdId, world.profileAId, online);
    const decision = service.computeStartPosition(contextOf(), onlineCommand({ mediaId: online, probeDurationSeconds: null, expectedHistoryRevision: 2 }));
    expect(decision).toEqual({ kind: 'history-changed', currentHistoryRevision: 0 });
    // 原语直证:一致 → null;不一致 → 变更信号(0 口径)
    const snapshot = readTargetHistory({ householdId: world.householdId, profileId: world.profileAId, mediaId: online });
    expect(snapshot).toBeNull();
    expect(compareTargetHistoryRevision(snapshot, 2)).toEqual({ kind: 'history-changed', currentHistoryRevision: 0 });
    expect(compareTargetHistoryRevision(null, 0)).toBeNull();
    expect(compareTargetHistoryRevision(snapshot, undefined)).toBeNull();
  });

  it('beginning 不受计划历史变化影响(用户显式从头;比对仅 target_history 面专属)', () => {
    seedHistoryRowFor(rig.conn, world, { mediaId: online, writerEpoch: 1, writerSessionId: `w-${randomUUID()}`, positionSeconds: 120, durationSeconds: 360 });
    rig.conn.prepare('UPDATE profile_viewing_history SET revision = 2, position_seconds = 355 WHERE media_id = ?').run(online);
    const decision = service.computeStartPosition(
      contextOf(),
      onlineCommand({ mediaId: online, requestedMode: 'beginning', probeDurationSeconds: 360, expectedHistoryRevision: 1 }),
    );
    expect(decision).toMatchObject({ kind: 'computed', startBasis: 'beginning', startSeconds: 0, historyRevision: 2 });
  });

  it('carry 判别先于一切读取与比对(carry-not-wired 不受 expectedHistoryRevision 影响)', () => {
    const decision = service.computeStartPosition(
      contextOf(),
      onlineCommand({ mediaId: online, requestedMode: 'transition_carry', probeDurationSeconds: 360, expectedHistoryRevision: 1 }),
    );
    expect(decision).toEqual({ kind: 'carry-not-wired' });
  });
});

describe('T041 · 冻结一次(FR-021;真实 T042 store + 真实 InputBindingTx)', () => {
  let rig: Rig;
  let service: VodStartPositionService;
  let world: WorldSeed;

  beforeEach(() => {
    rig = openRig();
    bindPersonalDataStore(drizzlePersonalDataStore(rig.db));
    service = buildService();
    world = rig.world;
  });

  it('probe 后冻结一次:freezeOnce 落 frozen_start_seconds=350 + frozen_at 非空;重复冻结(他设备更新后)不再改变', async () => {
    const online = world.onlineEpisode.mediaId;
    const { bindingId } = await bindOnlineInput(rig);
    expect(bindingRowOf(rig.conn, world, bindingId)).toMatchObject({ frozenStartSeconds: null, frozenAt: null }); // probe 前 NULL
    seedHistoryRowFor(rig.conn, world, { mediaId: online, writerEpoch: 1, writerSessionId: `w-${randomUUID()}`, positionSeconds: 350, durationSeconds: 360 });

    const decision = service.computeStartPosition(
      { householdId: world.householdId, profileId: world.profileAId },
      onlineCommand({ mediaId: online, probeDurationSeconds: 360 }),
    );
    expectComputed(decision);
    expect(decision.startSeconds).toBe(350);

    rig.uow.run(
      (tx) => tx.playback,
      (inputBinding) => {
        freezeOnce({ householdId: world.householdId, bindingId, decision, inputBinding });
        return null;
      },
      { behavior: 'immediate' },
    );
    const first = bindingRowOf(rig.conn, world, bindingId);
    expect(first.frozenStartSeconds).toBe(350);
    expect(first.frozenAt).not.toBeNull();

    // 他设备更新历史(位置 355/revision 2)后再冻结 → 已冻结起点不变(frozen_at 持久守卫仅一次)
    rig.conn
      .prepare('UPDATE profile_viewing_history SET revision = 2, position_seconds = 355 WHERE media_id = ? AND profile_id = ?')
      .run(online, world.profileAId);
    const otherDeviceDecision = service.computeStartPosition(
      { householdId: world.householdId, profileId: world.profileAId },
      onlineCommand({ mediaId: online, probeDurationSeconds: 360 }),
    );
    expectComputed(otherDeviceDecision);
    expect(otherDeviceDecision.startSeconds).toBe(355); // 未冻结路径会算出新位置 355 —— 必须走 frozen 透传
    rig.uow.run(
      (tx) => tx.playback,
      (inputBinding) => {
        freezeOnce({ householdId: world.householdId, bindingId, decision: otherDeviceDecision, inputBinding });
        return null;
      },
      { behavior: 'immediate' },
    );
    expect(bindingRowOf(rig.conn, world, bindingId)).toEqual(first);
  });

  it('已冻结起点原样返回(frozen 透传):他设备后来更新历史/偏好变化都不改变已冻结起点,不再第二次历史覆盖', () => {
    const online = world.onlineEpisode.mediaId;
    seedHistoryRowFor(rig.conn, world, { mediaId: online, writerEpoch: 1, writerSessionId: `w-${randomUUID()}`, positionSeconds: 120, durationSeconds: 360 });
    const frozen = { startBasis: 'target_history' as const, disposition: 'resume' as const, resumeReason: 'accepted' as const, startSeconds: 120 };
    // 冻结后他设备更新历史(revision 2/位置 355/内容修订推进)
    rig.conn
      .prepare('UPDATE profile_viewing_history SET revision = 2, position_seconds = 355 WHERE media_id = ? AND profile_id = ?')
      .run(online, world.profileAId);
    rig.conn.prepare('UPDATE media_item SET content_revision = 2 WHERE id = ?').run(online);
    const decision = service.computeStartPosition(
      { householdId: world.householdId, profileId: world.profileAId },
      onlineCommand({ mediaId: online, probeDurationSeconds: 360, frozen }),
    );
    expect(decision).toMatchObject({ kind: 'computed', startBasis: 'target_history', disposition: 'resume', resumeReason: 'accepted', startSeconds: 120 });
    // frozen 的 beginning 决策同样原样(已冻结从头不被历史更新改写)
    const frozenBeginning = service.computeStartPosition(
      { householdId: world.householdId, profileId: world.profileAId },
      onlineCommand({
        mediaId: online,
        probeDurationSeconds: 360,
        frozen: { startBasis: 'beginning', disposition: 'beginning', resumeReason: 'duration_unknown', startSeconds: 0 },
      }),
    );
    expect(frozenBeginning).toMatchObject({ kind: 'computed', startBasis: 'beginning', resumeReason: 'duration_unknown', startSeconds: 0 });
  });

  it('beginning 决策冻结 0 也属合法冻结(值 0 仅落一次);无决策(history-changed / carry-not-wired)不触碰绑定', async () => {
    const beginning = await bindOnlineInput(rig);
    rig.uow.run(
      (tx) => tx.playback,
      (inputBinding) => {
        freezeOnce({
          householdId: world.householdId,
          bindingId: beginning.bindingId,
          decision: {
            kind: 'computed',
            startBasis: 'beginning',
            disposition: 'beginning',
            resumeReason: 'requested_beginning',
            startSeconds: 0,
            nearEnd: false,
            historyRevision: 0,
          },
          inputBinding,
        });
        return null;
      },
      { behavior: 'immediate' },
    );
    const frozen = bindingRowOf(rig.conn, world, beginning.bindingId);
    expect(frozen.frozenStartSeconds).toBe(0);
    expect(frozen.frozenAt).not.toBeNull();

    // history-changed 决策不冻结(调用方按 NEXT_PLAN_CHANGED 转 failed)
    const changed = await bindOnlineInput(rig);
    rig.uow.run(
      (tx) => tx.playback,
      (inputBinding) => {
        freezeOnce({ householdId: world.householdId, bindingId: changed.bindingId, decision: { kind: 'history-changed', currentHistoryRevision: 2 }, inputBinding });
        return null;
      },
      { behavior: 'immediate' },
    );
    expect(bindingRowOf(rig.conn, world, changed.bindingId)).toMatchObject({ frozenStartSeconds: null, frozenAt: null });

    // carry-not-wired 决策不冻结(US4 接线前显式拒绝)
    const carried = await bindOnlineInput(rig);
    rig.uow.run(
      (tx) => tx.playback,
      (inputBinding) => {
        freezeOnce({ householdId: world.householdId, bindingId: carried.bindingId, decision: { kind: 'carry-not-wired' }, inputBinding });
        return null;
      },
      { behavior: 'immediate' },
    );
    expect(bindingRowOf(rig.conn, world, carried.bindingId)).toMatchObject({ frozenStartSeconds: null, frozenAt: null });
    expect(bindingRowOf(rig.conn, world, changed.bindingId).frozenAt).toBeNull();
  });

  it('绑定行 start_basis 与决策一致落库(T042 bindFixedInput 三值面)', async () => {
    const { bindingId } = await bindOnlineInput(rig);
    expect(bindingRowOf(rig.conn, world, bindingId).startBasis).toBe('target_history');
  });
});

describe('T041 · 静态媒体回归(既有静态续播语义零变化;FR-020)+ nearEnd 仅提示', () => {
  let rig: Rig;
  let service: VodStartPositionService;
  let world: WorldSeed;
  let staticMedia: string;
  const contextOf = (): { householdId: string; profileId: string } => ({ householdId: world.householdId, profileId: world.profileAId });

  beforeEach(() => {
    rig = openRig();
    bindPersonalDataStore(drizzlePersonalDataStore(rig.db));
    service = buildService();
    world = rig.world;
    staticMedia = world.staticVod.mediaId;
  });

  it('静态 resume:历史位置在时长域内 → target_history/accepted(静态 duration 历史兜底旧义保留)', () => {
    seedHistoryRowFor(rig.conn, world, {
      mediaId: staticMedia,
      writerEpoch: 1,
      writerSessionId: `w-${randomUUID()}`,
      positionSeconds: 120,
      durationSeconds: 300,
      continuityRevision: null, // 静态历史无在线证据
    });
    // probe 已知 3600:min(300,3600)=300 为界 → 120 有效
    const withProbe = service.computeStartPosition(contextOf(), onlineCommand({ mediaId: staticMedia, probeDurationSeconds: 3600 }));
    expectComputed(withProbe);
    expect(withProbe).toMatchObject({ kind: 'computed', startBasis: 'target_history', disposition: 'resume', resumeReason: 'accepted', startSeconds: 120 });
    // probe 未知(null):静态旧义仍以历史 duration 兜底(静态规则不变;与线上禁止兜底相对)
    const withoutProbe = service.computeStartPosition(contextOf(), onlineCommand({ mediaId: staticMedia, probeDurationSeconds: null }));
    expectComputed(withoutProbe);
    expect(withoutProbe.startSeconds).toBe(120);
  });

  it('静态 content 修订失配 → 从头(旧历史保留);静态无历史 → beginning + resumeReason null(旧义无从头原因枚举)', () => {
    seedHistoryRowFor(rig.conn, world, {
      mediaId: staticMedia,
      writerEpoch: 1,
      writerSessionId: `w-${randomUUID()}`,
      positionSeconds: 120,
      durationSeconds: 300,
      continuityRevision: null,
    });
    rig.conn.prepare('UPDATE media_item SET content_revision = 2 WHERE id = ?').run(staticMedia);
    const mismatched = service.computeStartPosition(contextOf(), onlineCommand({ mediaId: staticMedia, probeDurationSeconds: 3600 }));
    expect(mismatched).toMatchObject({ kind: 'computed', startBasis: 'beginning', disposition: 'beginning', startSeconds: 0, resumeReason: null });
    expect(historyRowOf(rig.db, world, world.profileAId, staticMedia)?.positionSeconds).toBe(120);

    const staticOther = seedStaticMedia(rig.conn, world);
    const noHistory = service.computeStartPosition(contextOf(), onlineCommand({ mediaId: staticOther, probeDurationSeconds: 3600 }));
    expect(noHistory).toMatchObject({ kind: 'computed', startBasis: 'beginning', disposition: 'beginning', resumeReason: null, startSeconds: 0, nearEnd: false });
  });

  it('静态 nearEnd 仅提示:落接近结尾窗口 → nearEnd=true 但资格/起点不受影响;远端位置 → false', () => {
    seedHistoryRowFor(rig.conn, world, {
      mediaId: staticMedia,
      writerEpoch: 1,
      writerSessionId: `w-${randomUUID()}`,
      positionSeconds: 285, // 300-285=15 <= min(30, 30) 窗口
      durationSeconds: 300,
      continuityRevision: null,
    });
    const nearEnd = service.computeStartPosition(contextOf(), onlineCommand({ mediaId: staticMedia, probeDurationSeconds: 3600 }));
    expectComputed(nearEnd);
    expect(nearEnd.nearEnd).toBe(true);
    expect(nearEnd.startBasis).toBe('target_history'); // 资格不受 nearEnd 影响
    expect(nearEnd.startSeconds).toBe(285);
  });

  it('nearEndHintOf:窗口=min(30s,时长×10%);duration 未知/位置越界/位置 0 恒 false(纯提示函数)', () => {
    expect(nearEndHintOf(340, 360)).toBe(true); // 360-340=20 <= 30
    expect(nearEndHintOf(329, 360)).toBe(false); // 360-329=31 > 30
    expect(nearEndHintOf(185, 200)).toBe(true); // 短片窗口 min(30,20)=20;200-185=15 <= 20
    expect(nearEndHintOf(178, 200)).toBe(false); // 200-178=22 > 20
    expect(nearEndHintOf(120, null)).toBe(false);
    expect(nearEndHintOf(0, 360)).toBe(false);
    expect(nearEndHintOf(360, 360)).toBe(false);
    expect(nearEndHintOf(400, 360)).toBe(false);
    expect(nearEndHintOf(Number.NaN, 360)).toBe(false);
  });

  it('在线 nearEnd 仅提示:落窗口内仍 target_history 续播(FR-019 不能仅因最后 30 秒强制从头)', () => {
    const online = world.onlineEpisode.mediaId;
    seedHistoryRowFor(rig.conn, world, {
      mediaId: online,
      writerEpoch: 1,
      writerSessionId: `w-${randomUUID()}`,
      positionSeconds: 340, // 360-340=20 <= min(30,36)
      durationSeconds: 360,
    });
    const decision = service.computeStartPosition(contextOf(), onlineCommand({ mediaId: online, probeDurationSeconds: 360 }));
    expectComputed(decision);
    expect(decision).toMatchObject({ startBasis: 'target_history', disposition: 'resume', resumeReason: 'accepted', startSeconds: 340, nearEnd: true });
    expect(decision.historyRevision).toBe(1);
  });
});

/** 静态媒体追加夹具(无历史行形态;与 seedWorld 静态段同形) */
function seedStaticMedia(conn: SqliteConnection, world: WorldSeed): string {
  const now = iso(CLOCK_START_MS - 30_000);
  const sourceId = `src-${randomUUID()}`;
  const entryId = `entry-${randomUUID()}`;
  const mediaId = `media-${randomUUID()}`;
  const playbackSourceId = `psrc-${randomUUID()}`;
  conn.transaction(() => {
    conn
      .prepare(
        "INSERT INTO media_source (id, household_id, kind, name, root_key, relative_directory, private_access_approved, enabled, version, created_at, updated_at) VALUES (?, ?, 'nas', '夹具NAS追加', 't041-nas-2', 'media', 1, 1, 1, ?, ?)",
      )
      .run(sourceId, world.householdId, now, now);
    conn
      .prepare(
        "INSERT INTO media_item (id, household_id, type, title, content_level, version, media_role, content_revision, created_at, updated_at) VALUES (?, ?, 'movie', '静态影片追加', 0, 1, 'standalone', 1, ?, ?)",
      )
      .run(mediaId, world.householdId, now, now);
    conn
      .prepare(
        "INSERT INTO source_entry (id, household_id, source_id, identity_kind, identity_digest, media_id, present, first_seen_at, last_seen_at) VALUES (?, ?, ?, 'path', ?, ?, 1, ?, ?)",
      )
      .run(entryId, world.householdId, sourceId, hashToken(`${sourceId}:extra.mp4`), mediaId, now, now);
    conn
      .prepare(
        "INSERT INTO playback_source (id, household_id, source_id, source_entry_id, media_item_id, protocol, location, mime_type, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 'file', '/nas-media/extra.mp4', 'video/mp4', ?, ?)",
      )
      .run(playbackSourceId, world.householdId, sourceId, entryId, mediaId, now, now);
  })();
  return mediaId;
}

afterEach(() => {
  bindPersonalDataStore(drizzlePersonalDataStore()); // 恢复惰性 getDb 形态,避免跨文件 rig 泄漏
  for (let index = openRigs.length - 1; index >= 0; index -= 1) {
    const open = openRigs[index];
    if (open !== undefined) {
      open.conn.close();
      fs.rmSync(open.dataDir, { recursive: true, force: true });
    }
  }
  openRigs.length = 0;
});
