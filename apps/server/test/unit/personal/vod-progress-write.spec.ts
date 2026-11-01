import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import DatabaseConstructor from 'better-sqlite3';
import { drizzle, type BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { and, eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  createUnitOfWork,
  type TxStoreFactory,
  type UnitOfWork,
} from '@platform/database/unit-of-work';
import * as schema from '@platform/database/schema';
import type { PlaybackProgressState, ProfileViewingHistory } from '@platform/database/schema';
import { createIdentityAccessTxReaders } from '@contexts/identity-access/infrastructure/transaction-participants';
import { createProfileTxReaders } from '@contexts/profile/infrastructure/transaction-participants';
import { createPolicyTxReaders } from '@contexts/policy/infrastructure/transaction-participants';
import { createSourcesTxParticipants } from '@contexts/sources/infrastructure/transaction-participants';
import { createMediaCatalogTxParticipants } from '@contexts/media-catalog/infrastructure/transaction-participants';
import { createOnlineVodTxParticipants } from '@contexts/online-vod/infrastructure/transaction-participants';
import { createPlaybackTxParticipants } from '@contexts/playback/infrastructure/transaction-participants';
import {
  createPersonalDataTxParticipants,
  type HistoryUpsertValuesMirror,
  type LedgerSampleApplyValuesMirror,
} from '@contexts/personal-data/infrastructure/transaction-participants';
import { bindPersonalDataStore } from '@contexts/personal-data/application/personal-data-store.port';
import { drizzlePersonalDataStore } from '@contexts/personal-data/infrastructure/personal-data-store.drizzle';
import { registerPersonalPlaybackFactsPort } from '@contexts/personal-data/application/progress-clock.service';
import { ProgressWriteService } from '@contexts/personal-data/application/progress-write.service';
import type { DomainError } from '@platform/http-common/domain-error';
import { hashToken } from '@contexts/identity-access/infrastructure/token.service';

/**
 * T040(010-online-vod · US2 服务级单测,真实 DDL + 真实 UNIT_OF_WORK)——
 * 会话 ledger 与 epoch 历史分离编排:
 *
 * 权威依据:
 * - docs/specs/010-online-vod/data-model.md §5(playback_progress_state:seq 跨
 *   generation 递增;新有效样本先更新 ledger,再按 epoch 决定历史;superseded 仍
 *   sessionAccepted=true;stale 不更新;与历史同事务;profile_viewing_history:
 *   completed 只由有效 finish 写或新实际 started 重置;from-head 可降低位置;
 *   「本次 probe 未知则不能用历史 duration 作为在线兜底」);
 * - docs/specs/010-online-vod/contracts/api.md §1 ProgressReply(applied 只指历史写入;
 *   superseded 可 sessionAccepted=true/applied=false;duplicate 返回原存储结果不再次写;
 *   stale sessionAccepted=false 并返回最后会话接受游标)+ §4 progress 行;
 * - docs/specs/010-online-vod/contracts/internal-ports.md §2 ProgressFinishWorkSet
 *   (progress:校验→seq/digest→sessionStarted/ledger→epoch 历史→结果簿记);
 * - 行为基线(既有绿,不得回归):test/unit/personal/progress-write-machine.spec.ts
 *   (T089 applied/seq/stale/duration 兜底旧义)、progress-stop-resume.spec.ts(T090)、
 *   test/contract/playback-progress.contract.spec.ts(T092 3 键响应)。
 *
 * 装配方式(与 T029/T038 服务级 rig 同构,零 HTTP/零网络):
 * - 独立临时文件库 + 全量权威迁移 DDL(0001~0007,foreign_keys=ON 真实约束)+
 *   真实 UNIT_OF_WORK(T016 报告 8 键 txStores 复刻:identityAccess/profile/policy/
 *   sources/catalog/vod/playback/personalData);
 * - 服务路径经既有事务端口(bindPersonalDataStore(drizzlePersonalDataStore(同一连接)))
 *   驱动 ProgressWriteService;首次建档/参与者语义经真实 uow.run 驱动 T016 参与者,
 *   两层共用同一真实库,逐字段对照语义一致性;
 * - probe 受信时长经 registerPersonalPlaybackFactsPort 注入(3600=已知;null=未知,
 *   与生产桥 LIVE_STREAM_FACTS duration=null 同形);时钟注入固定 FakeClock。
 *
 * 矩阵:ledger/epoch 分离(accepted 双写)· superseded(ledger 接受+历史不写)·
 * stale(零更新+最后接受游标)· duplicate(原样重放全量结果)/冲突 · seq 跨代单调 ·
 * from-head 降低位置不取 MAX · completed 重置 · 首次建档同事务(成功提交+失败回滚
 * 零半建档)· 在线 probe 未知拒绝历史兜底(E 组服务级)· 静态兜底/证据 NULL 旧义 ·
 * ledger continuity 随样本快照(T037/T043 规则接点)· T016 参与者语义一致性。
 */

/** 夹具固定时刻(accepted_at/last_viewed_at 断言锚点) */
const CLOCK_START_MS = Date.parse('2026-11-01T09:00:00.000Z');
/** probe 已知受信时长(与 T036/T092 rig 同形) */
const TRUSTED_DURATION_SECONDS = 3600;

function iso(ms: number): string {
  return new Date(ms).toISOString();
}

/* ------------------------------------------------------------------ */
/* rig:真实 DDL + 8 键 txStores 真实 UNIT_OF_WORK + 既有事务端口          */
/* ------------------------------------------------------------------ */

type SqliteConnection = DatabaseConstructor.Database;

interface WorldSeed {
  readonly householdId: string;
  readonly profileAId: string;
  readonly profileBId: string;
  readonly deviceSessionAId: string;
  readonly deviceSessionBId: string;
  readonly deviceIdA: string;
  readonly deviceIdB: string;
  /** 静态 NAS 点播(旧义守卫面) */
  readonly staticVod: { readonly mediaId: string; readonly playbackSourceId: string };
  /** 在线物化剧集(unverified 证据形态,与 T031 物化产物同形) */
  readonly onlineEpisode: { readonly mediaId: string; readonly playbackSourceId: string; readonly episodeRowId: string };
  /** 直播频道(遥测不建历史) */
  readonly channel: { readonly mediaId: string; readonly playbackSourceId: string };
}

interface Rig {
  readonly conn: SqliteConnection;
  readonly dataDir: string;
  readonly uow: UnitOfWork<Record<string, TxStoreFactory>>;
  readonly world: WorldSeed;
}

const openRigs: { conn: SqliteConnection; dataDir: string }[] = [];

/** 全量权威迁移(与 T029/T038 rig 同源;FK ON 下逐语句零违反) */
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

/** 身份 + 静态点播 + 在线剧集 + 频道种子(FK 依赖序;与 personal-world/T038 rig 同形) */
function seedWorld(conn: SqliteConnection, t0: number): WorldSeed {
  const now = iso(t0);
  const householdId = `hh-${randomUUID()}`;
  const accountId = `acc-${randomUUID()}`;
  const profileAId = `prof-${randomUUID()}`;
  const profileBId = `prof-${randomUUID()}`;
  const deviceIdA = `dev-${randomUUID()}`;
  const deviceIdB = `dev-${randomUUID()}`;
  const deviceSessionAId = `dsess-${randomUUID()}`;
  const deviceSessionBId = `dsess-${randomUUID()}`;
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
  const channelSourceId = `src-${randomUUID()}`;
  const channelEntryId = `entry-${randomUUID()}`;
  const channelMediaId = `media-${randomUUID()}`;
  const channelPlaybackSourceId = `psrc-${randomUUID()}`;

  conn.transaction(() => {
    conn.prepare('INSERT INTO household (id, name, created_at) VALUES (?, ?, ?)').run(householdId, 'T040 夹具家庭', now);
    conn
      .prepare(
        'INSERT INTO account (id, household_id, username, username_normalized, password_hash, role, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
      )
      .run(accountId, householdId, 't040', 't040', 'hash', 'owner', now);
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
    conn.prepare("INSERT INTO device (id, household_id, name, type, created_at) VALUES (?, ?, '设备B', 'web', ?)").run(deviceIdB, householdId, now);
    for (const [deviceSessionId, deviceId] of [
      [deviceSessionAId, deviceIdA],
      [deviceSessionBId, deviceIdB],
    ] as const) {
      conn
        .prepare(
          'INSERT INTO device_session (id, household_id, account_id, device_id, token_hash, active_profile_id, expires_at, last_active_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
        )
        .run(deviceSessionId, householdId, accountId, deviceId, hashToken(`token-${deviceSessionId}`), profileAId, iso(t0 + 7 * 24 * 3600_000), now, now);
    }

    // 静态 NAS 点播(kind=nas + path entry + file 资源;personal-world 同形)
    conn
      .prepare(
        "INSERT INTO media_source (id, household_id, kind, name, root_key, relative_directory, private_access_approved, enabled, version, created_at, updated_at) VALUES (?, ?, 'nas', '夹具NAS', 't040-nas', 'media', 1, 1, 1, ?, ?)",
      )
      .run(staticSourceId, householdId, now, now);
    conn
      .prepare(
        "INSERT INTO media_item (id, household_id, type, title, content_level, version, media_role, created_at, updated_at) VALUES (?, ?, 'movie', '静态影片', 0, 1, 'standalone', ?, ?)",
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

    // 在线物化剧集(kind=vod + vod_title/line/episode + online hls 资源;T031/T038 rig 同形)
    conn
      .prepare(
        "INSERT INTO media_source (id, household_id, kind, name, remote_url, enabled, version, locator_revision, created_at, updated_at) VALUES (?, ?, 'vod', '夹具在线片源', 'https://upstream.t040.fixture/api.php', 1, 1, 1, ?, ?)",
      )
      .run(onlineSourceId, householdId, now, now);
    conn.prepare("INSERT INTO vod_source_config (household_id, source_id, adapter) VALUES (?, ?, 'apple-cms-json')").run(householdId, onlineSourceId);
    conn
      .prepare(
        "INSERT INTO media_item (id, household_id, type, title, content_level, version, media_role, created_at, updated_at) VALUES (?, ?, 'series', 'T040 剧集', 0, 1, 'vod_title', ?, ?)",
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
      .run(titleId, householdId, onlineSourceId, 'up-t040', onlineParentMediaId, now);
    conn
      .prepare('INSERT INTO vod_line (id, household_id, title_id, line_key, display_name, sort_order) VALUES (?, ?, ?, ?, ?, 1)')
      .run(lineId, householdId, titleId, 'main', '主线');
    // unverified 无证据集形态(与基础 adapter 物化产物一致):continuity_revision=2(基线升级形态)、digest NULL
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

    // 直播频道(iptv + url entry + http 资源)
    conn
      .prepare(
        "INSERT INTO media_source (id, household_id, kind, name, remote_url, enabled, version, created_at, updated_at) VALUES (?, ?, 'iptv', '夹具IPTV', 'http://iptv.t040.fixture/list.m3u8', 1, 1, ?, ?)",
      )
      .run(channelSourceId, householdId, now, now);
    conn
      .prepare(
        "INSERT INTO media_item (id, household_id, type, title, content_level, version, created_at, updated_at) VALUES (?, ?, 'channel', '夹具频道', 0, 1, ?, ?)",
      )
      .run(channelMediaId, householdId, now, now);
    conn
      .prepare(
        "INSERT INTO source_entry (id, household_id, source_id, identity_kind, identity_digest, media_id, present, first_seen_at, last_seen_at) VALUES (?, ?, ?, 'url', ?, ?, 1, ?, ?)",
      )
      .run(channelEntryId, householdId, channelSourceId, hashToken(`${channelSourceId}:ch`), channelMediaId, now, now);
    conn
      .prepare(
        "INSERT INTO playback_source (id, household_id, source_id, source_entry_id, media_item_id, protocol, location, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 'http', 'http://iptv.t040.fixture/stream.m3u8', ?, ?)",
      )
      .run(channelPlaybackSourceId, householdId, channelSourceId, channelEntryId, channelMediaId, now, now);
  })(); // better-sqlite3:transaction(fn) 返回包装函数,必须调用一次才执行

  return {
    householdId,
    profileAId,
    profileBId,
    deviceSessionAId,
    deviceSessionBId,
    deviceIdA,
    deviceIdB,
    staticVod: { mediaId: staticMediaId, playbackSourceId: staticPlaybackSourceId },
    onlineEpisode: { mediaId: onlineEpisodeMediaId, playbackSourceId: onlinePlaybackSourceId, episodeRowId },
    channel: { mediaId: channelMediaId, playbackSourceId: channelPlaybackSourceId },
  };
}

/** T016 报告 8 键 txStores 复刻(键名即 app.module 组合根注册表;具体工厂类型保留) */
const TX_STORES = {
  identityAccess: createIdentityAccessTxReaders,
  profile: createProfileTxReaders,
  policy: createPolicyTxReaders,
  sources: createSourcesTxParticipants,
  catalog: createMediaCatalogTxParticipants,
  vod: createOnlineVodTxParticipants,
  playback: createPlaybackTxParticipants,
  personalData: createPersonalDataTxParticipants,
} satisfies Record<string, TxStoreFactory>;

function openRig(): Rig {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hmp-t040-vod-progress-'));
  const conn = new DatabaseConstructor(path.join(dataDir, `${randomUUID()}.db`));
  conn.pragma('journal_mode = WAL');
  conn.pragma('foreign_keys = ON');
  applyAuthoritativeMigrations(conn);
  const world = seedWorld(conn, CLOCK_START_MS - 60_000);
  openRigs.push({ conn, dataDir });
  return {
    conn,
    dataDir,
    uow: createUnitOfWork({ resolveDatabase: () => conn, txStores: TX_STORES }),
    world,
  };
}

/* ------------------------------------------------------------------ */
/* 会话/状态/历史种子与读取辅助                                           */
/* ------------------------------------------------------------------ */

interface SessionHandle {
  readonly sessionId: string;
  readonly generation: number;
}

/** 指定状态播放会话(在线 delivery=hls_proxy / 静态 direct;活动三态源/交付必非空) */
function seedSessionRow(
  conn: SqliteConnection,
  world: WorldSeed,
  input: {
    readonly mediaId: string;
    readonly playbackSourceId: string;
    readonly delivery: 'hls_proxy' | 'direct';
    readonly deviceSessionId?: string;
    readonly profileId?: string;
    readonly state?: 'preparing' | 'ready' | 'playing' | 'paused';
  },
): SessionHandle {
  const at = iso(CLOCK_START_MS - 30_000);
  const sessionId = `sess-${randomUUID()}`;
  const deviceSessionId = input.deviceSessionId ?? world.deviceSessionAId;
  conn
    .prepare(
      `INSERT INTO playback_session (
        id, household_id, device_session_id, device_id, profile_id, media_id, playback_source_id,
        state, delivery, generation, version, position_seconds, desired_paused,
        profile_context_version, created_at, started_at, last_heartbeat_at, failure_code
      ) VALUES (?, ?, ?, (SELECT device_id FROM device_session WHERE id = ?), ?, ?, ?, ?, ?, 1, 1, 0, 0, 1, ?, ?, ?, NULL)`,
    )
    .run(
      sessionId,
      world.householdId,
      deviceSessionId,
      deviceSessionId,
      input.profileId ?? world.profileAId,
      input.mediaId,
      input.playbackSourceId,
      input.state ?? 'playing',
      input.delivery,
      at,
      at,
      at,
    );
  return { sessionId, generation: 1 };
}

/** resolve 绑定形态 progress_state(candidate_epoch 显式;ledger 游标初值 NULL) */
function seedProgressStateRow(
  conn: SqliteConnection,
  world: WorldSeed,
  input: {
    readonly sessionId: string;
    readonly profileId?: string;
    readonly mediaId: string;
    readonly candidateEpoch: number;
  },
): void {
  const revision = (
    conn.prepare('SELECT content_revision AS r FROM media_item WHERE id = ?').get(input.mediaId) as { r: number }
  ).r;
  conn
    .prepare(
      `INSERT INTO playback_progress_state (
        household_id, playback_session_id, profile_id, media_id, candidate_epoch,
        content_revision, profile_context_version, started, last_sample_seq, last_sample_digest,
        last_generation, last_result, continuity_revision, ledger_position, ledger_duration,
        ledger_generation, ledger_accepted_at, session_started
      ) VALUES (?, ?, ?, ?, ?, ?, 1, 0, 0, NULL, 1, NULL, 1, NULL, NULL, NULL, NULL, 0)`,
    )
    .run(world.householdId, input.sessionId, input.profileId ?? world.profileAId, input.mediaId, input.candidateEpoch, revision);
}

/** epoch 历史行种子(工厂事实;completed 可指定) */
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
  },
): void {
  const revision = (
    conn.prepare('SELECT content_revision AS r FROM media_item WHERE id = ?').get(input.mediaId) as { r: number }
  ).r;
  conn
    .prepare(
      `INSERT INTO profile_viewing_history (
        household_id, profile_id, media_id, writer_epoch, writer_playback_session_id,
        last_sample_seq, content_revision, position_seconds, duration_seconds,
        last_viewed_at, revision, completed
      ) VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      world.householdId,
      input.profileId ?? world.profileAId,
      input.mediaId,
      input.writerEpoch,
      input.writerSessionId,
      revision,
      input.positionSeconds,
      input.durationSeconds,
      iso(CLOCK_START_MS - 60_000),
      input.revision ?? 1,
      input.completed === true ? 1 : 0,
    );
}

function progressStateRowOf(db: BetterSQLite3Database<typeof schema>, sessionId: string): PlaybackProgressState {
  const row = db
    .select()
    .from(schema.playbackProgressState)
    .where(eq(schema.playbackProgressState.playbackSessionId, sessionId))
    .get();
  expect(row, `夹具错误:playback_progress_state ${sessionId} 不存在`).toBeDefined();
  return row!;
}

function historyRowOf(db: BetterSQLite3Database<typeof schema>, world: WorldSeed, profileId: string, mediaId: string): ProfileViewingHistory {
  const row = db
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
  expect(row, '夹具错误:历史行不存在').toBeDefined();
  return row!;
}

/* ------------------------------------------------------------------ */
/* 用例                                                                  */
/* ------------------------------------------------------------------ */

describe('T040 · 会话 ledger 与 epoch 历史分离编排(真实 DDL + 真实 UNIT_OF_WORK)', () => {
  let rig: Rig;
  let conn: SqliteConnection;
  let db: BetterSQLite3Database<typeof schema>;
  let world: WorldSeed;
  let service: ProgressWriteService;
  let clockMs: number;

  beforeEach(() => {
    rig = openRig();
    conn = rig.conn;
    db = drizzle(conn, { schema });
    world = rig.world;
    clockMs = CLOCK_START_MS;
    service = new ProgressWriteService({ now: () => clockMs });
    // 既有事务端口绑定同一真实连接(服务路径与 uow 路径同库可对照)
    bindPersonalDataStore(drizzlePersonalDataStore(db));
    registerPersonalPlaybackFactsPort({ trustedDurationSeconds: () => TRUSTED_DURATION_SECONDS });
  });

  afterEach(() => {
    registerPersonalPlaybackFactsPort(null);
    for (let index = openRigs.length - 1; index >= 0; index -= 1) {
      const open = openRigs[index];
      if (open !== undefined) {
        open.conn.close();
        fs.rmSync(open.dataDir, { recursive: true, force: true });
      }
      openRigs.pop();
    }
  });

  /** 在线剧集 playing 会话(默认 epoch 显式) */
  function newOnlineSession(options: { epoch?: number; deviceSessionId?: string; profileId?: string } = {}): SessionHandle {
    const handle = seedSessionRow(conn, world, {
      mediaId: world.onlineEpisode.mediaId,
      playbackSourceId: world.onlineEpisode.playbackSourceId,
      delivery: 'hls_proxy',
      deviceSessionId: options.deviceSessionId,
      profileId: options.profileId,
    });
    seedProgressStateRow(conn, world, {
      sessionId: handle.sessionId,
      profileId: options.profileId,
      mediaId: world.onlineEpisode.mediaId,
      candidateEpoch: options.epoch ?? 1,
    });
    return handle;
  }

  /** 静态点播 playing 会话 */
  function newStaticSession(options: { epoch?: number } = {}): SessionHandle {
    const handle = seedSessionRow(conn, world, {
      mediaId: world.staticVod.mediaId,
      playbackSourceId: world.staticVod.playbackSourceId,
      delivery: 'direct',
    });
    seedProgressStateRow(conn, world, {
      sessionId: handle.sessionId,
      mediaId: world.staticVod.mediaId,
      candidateEpoch: options.epoch ?? 1,
    });
    return handle;
  }

  const scopeOf = (handle: SessionHandle, deviceSessionId: string = world.deviceSessionAId) => ({
    householdId: world.householdId,
    deviceSessionId,
    sessionId: handle.sessionId,
  });

  it('accepted 双写:新有效样本先更新 ledger 游标,再按 epoch 写历史(同事务;在线证据随行落库)', () => {
    const handle = newOnlineSession({ epoch: 1 });
    const outcome = service.applySampleDetailed(scopeOf(handle), {
      sampleSeq: 1,
      expectedGeneration: handle.generation,
      positionSeconds: 0,
      reason: 'started',
    });
    expect(outcome).toEqual({
      applied: true,
      reason: 'accepted',
      historyRevision: 1,
      sessionAccepted: true,
      acceptedSampleSeq: 1,
      acceptedPositionSeconds: 0,
      acceptedGeneration: 1,
      sessionStarted: true,
    });
    const state = progressStateRowOf(db, handle.sessionId);
    expect(state.started).toBe(1);
    expect(state.lastSampleSeq).toBe(1);
    expect(state.ledgerPosition).toBe(0);
    expect(state.ledgerDuration).toBe(TRUSTED_DURATION_SECONDS);
    expect(state.ledgerGeneration).toBe(1);
    expect(state.ledgerAcceptedAt).toBe(iso(clockMs));
    expect(state.sessionStarted).toBe(1);
    expect(state.continuityRevision).toBe(2); // vod_episode.continuity_revision(保存产生时快照)
    const history = historyRowOf(db, world, world.profileAId, world.onlineEpisode.mediaId);
    expect(history.writerEpoch).toBe(1);
    expect(history.writerPlaybackSessionId).toBe(handle.sessionId);
    expect(history.positionSeconds).toBe(0);
    expect(history.durationSeconds).toBe(TRUSTED_DURATION_SECONDS);
    expect(history.revision).toBe(1);
    expect(history.continuityRevision).toBe(2);
    expect(history.evidenceState).toBe('unverified');
    expect(history.evidenceDigest).not.toBeNull();
    expect(history.completed).toBe(0);
  });

  it('ledger/epoch 分离(superseded):旧 epoch 样本 ledger 接受(sessionAccepted=true)而历史不写,applied 旧义保留', () => {
    // 新 owner(epoch 2,设备B)先起播取得历史权
    const owner = newOnlineSession({ epoch: 2, deviceSessionId: world.deviceSessionBId, profileId: world.profileAId });
    const ownerOutcome = service.applySampleDetailed(
      scopeOf(owner, world.deviceSessionBId),
      { sampleSeq: 1, expectedGeneration: 1, positionSeconds: 500, reason: 'started' },
    );
    expect(ownerOutcome.applied).toBe(true);
    const ownerHistory = historyRowOf(db, world, world.profileAId, world.onlineEpisode.mediaId);
    // 旧 candidate(epoch 1,设备A)started → superseded:ledger 已接受、历史不动
    const staleCandidate = newOnlineSession({ epoch: 1 });
    const outcome = service.applySampleDetailed(scopeOf(staleCandidate), {
      sampleSeq: 1,
      expectedGeneration: 1,
      positionSeconds: 100,
      reason: 'started',
    });
    expect(outcome).toEqual({
      applied: false,
      reason: 'superseded',
      historyRevision: null,
      sessionAccepted: true,
      acceptedSampleSeq: 1,
      acceptedPositionSeconds: 100,
      acceptedGeneration: 1,
      sessionStarted: true,
    });
    const state = progressStateRowOf(db, staleCandidate.sessionId);
    expect(state.lastSampleSeq).toBe(1);
    expect(state.ledgerPosition).toBe(100);
    expect(state.ledgerGeneration).toBe(1);
    expect(state.sessionStarted).toBe(1);
    // 历史不被非 owner 样本覆盖(既有语义 + applied=false 旧义)
    const after = historyRowOf(db, world, world.profileAId, world.onlineEpisode.mediaId);
    expect(after.writerPlaybackSessionId).toBe(ownerHistory.writerPlaybackSessionId);
    expect(after.positionSeconds).toBe(500);
    expect(after.revision).toBe(ownerHistory.revision);
    // 3 键投影(既有响应形状):applied 旧义逐字保留
    const replay3Key = service.applySample(scopeOf(staleCandidate), {
      sampleSeq: 2,
      expectedGeneration: 1,
      positionSeconds: 120,
      reason: 'periodic',
    });
    expect(replay3Key).toEqual({ applied: false, reason: 'superseded', historyRevision: null });
    expect(historyRowOf(db, world, world.profileAId, world.onlineEpisode.mediaId).positionSeconds).toBe(500);
  });

  it('stale 零更新:ledger 游标与历史整行不变,返回最后会话接受游标(sessionAccepted=false)', () => {
    const handle = newOnlineSession({ epoch: 1 });
    service.applySampleDetailed(scopeOf(handle), { sampleSeq: 1, expectedGeneration: 1, positionSeconds: 0, reason: 'started' });
    service.applySampleDetailed(scopeOf(handle), { sampleSeq: 2, expectedGeneration: 1, positionSeconds: 30, reason: 'periodic' });
    const before = progressStateRowOf(db, handle.sessionId);
    const historyBefore = historyRowOf(db, world, world.profileAId, world.onlineEpisode.mediaId);
    const stale = service.applySampleDetailed(scopeOf(handle), {
      sampleSeq: 1,
      expectedGeneration: 1,
      positionSeconds: 5,
      reason: 'periodic',
    });
    expect(stale).toEqual({
      applied: false,
      reason: 'stale_sample',
      historyRevision: null,
      sessionAccepted: false,
      acceptedSampleSeq: 2,
      acceptedPositionSeconds: 30,
      acceptedGeneration: 1,
      sessionStarted: true,
    });
    // 零更新:状态行(含 ledger 游标)与历史行逐字节不变
    expect(progressStateRowOf(db, handle.sessionId)).toEqual(before);
    expect(historyRowOf(db, world, world.profileAId, world.onlineEpisode.mediaId)).toEqual(historyBefore);
    // 序号未消耗:seq=3 立即接受
    expect(service.applySample(scopeOf(handle), { sampleSeq: 3, expectedGeneration: 1, positionSeconds: 40, reason: 'periodic' })).toEqual({
      applied: true,
      reason: 'accepted',
      historyRevision: 3,
    });
    expect(progressStateRowOf(db, handle.sessionId).lastSampleSeq).toBe(3);
  });

  it('duplicate:同 seq 同载荷原样重放全量存储结果(含会话接受面),零写入;异载荷 409 不消耗序号', () => {
    const handle = newOnlineSession({ epoch: 1 });
    const first = service.applySampleDetailed(scopeOf(handle), {
      sampleSeq: 1,
      expectedGeneration: 1,
      positionSeconds: 100,
      reason: 'started',
    });
    expect(first.applied).toBe(true);
    const stateAfterFirst = progressStateRowOf(db, handle.sessionId);
    const historyAfterFirst = historyRowOf(db, world, world.profileAId, world.onlineEpisode.mediaId);
    const replay = service.applySampleDetailed(scopeOf(handle), {
      sampleSeq: 1,
      expectedGeneration: 1,
      positionSeconds: 100,
      reason: 'started',
    });
    expect(replay).toEqual(first); // 原存储结果(8 键)原样返回
    expect(progressStateRowOf(db, handle.sessionId)).toEqual(stateAfterFirst);
    expect(historyRowOf(db, world, world.profileAId, world.onlineEpisode.mediaId)).toEqual(historyAfterFirst);
    // 同 seq 异载荷 → 409 PROGRESS_SAMPLE_CONFLICT
    try {
      service.applySample(scopeOf(handle), { sampleSeq: 1, expectedGeneration: 1, positionSeconds: 200, reason: 'started' });
      expect.unreachable();
    } catch (error) {
      expect((error as DomainError).status).toBe(409);
      expect((error as DomainError).code).toBe('PROGRESS_SAMPLE_CONFLICT');
    }
    // 序号未消耗:seq=2 立即接受
    expect(service.applySample(scopeOf(handle), { sampleSeq: 2, expectedGeneration: 1, positionSeconds: 150, reason: 'periodic' })).toEqual({
      applied: true,
      reason: 'accepted',
      historyRevision: 2,
    });
  });

  it('seq 跨 generation 单调:换代后续接不归零,ledger 游标记录新代(ledger_generation=2)', () => {
    const handle = newOnlineSession({ epoch: 1 });
    service.applySampleDetailed(scopeOf(handle), { sampleSeq: 1, expectedGeneration: 1, positionSeconds: 0, reason: 'started' });
    conn
      .prepare('UPDATE playback_session SET generation = generation + 1, version = version + 1 WHERE id = ?')
      .run(handle.sessionId);
    const generation2 = 2;
    const outcome = service.applySampleDetailed(scopeOf(handle), {
      sampleSeq: 2,
      expectedGeneration: generation2,
      positionSeconds: 60,
      reason: 'periodic',
    });
    expect(outcome).toMatchObject({ applied: true, reason: 'accepted', acceptedSampleSeq: 2, acceptedGeneration: generation2 });
    const state = progressStateRowOf(db, handle.sessionId);
    expect(state.lastSampleSeq).toBe(2); // seq 不归零
    expect(state.lastGeneration).toBe(generation2);
    expect(state.ledgerGeneration).toBe(generation2); // 游标带新代
    expect(state.ledgerPosition).toBe(60);
    // 旧代样本 409 不消耗序号
    try {
      service.applySample(scopeOf(handle), { sampleSeq: 3, expectedGeneration: 1, positionSeconds: 70, reason: 'periodic' });
      expect.unreachable();
    } catch (error) {
      expect((error as DomainError).code).toBe('PLAYBACK_GENERATION_STALE');
    }
    expect(service.applySample(scopeOf(handle), { sampleSeq: 3, expectedGeneration: generation2, positionSeconds: 70, reason: 'periodic' })).toEqual({
      applied: true,
      reason: 'accepted',
      historyRevision: 3,
    });
    expect(progressStateRowOf(db, handle.sessionId).lastSampleSeq).toBe(3);
  });

  it('from-head 降低位置不取 MAX;新实际 started 重置 completed=0(completed 只由有效 finish 写)', () => {
    seedHistoryRowFor(conn, world, {
      mediaId: world.onlineEpisode.mediaId,
      writerEpoch: 1,
      writerSessionId: 'old-owner',
      positionSeconds: 300,
      durationSeconds: TRUSTED_DURATION_SECONDS,
      revision: 4,
      completed: true,
    });
    // 新 epoch(beginning 意图)started 位置 0:历史位置降低,completed 重置
    const handle = newOnlineSession({ epoch: 5 });
    const outcome = service.applySampleDetailed(scopeOf(handle), {
      sampleSeq: 1,
      expectedGeneration: 1,
      positionSeconds: 0,
      reason: 'started',
    });
    expect(outcome.applied).toBe(true);
    const history = historyRowOf(db, world, world.profileAId, world.onlineEpisode.mediaId);
    expect(history.positionSeconds).toBe(0); // 不取 MAX
    expect(history.completed).toBe(0); // 新实际 started 重置
    expect(history.revision).toBe(5);
    expect(history.writerEpoch).toBe(5);
  });

  it('在线 probe 未知:拒绝历史 duration 兜底(409 PROGRESS_NOT_READY),历史零改写(E 组服务级)', () => {
    registerPersonalPlaybackFactsPort(null); // probe 未知(生产桥 LIVE_STREAM_FACTS duration=null 同形)
    seedHistoryRowFor(conn, world, {
      mediaId: world.onlineEpisode.mediaId,
      writerEpoch: 1,
      writerSessionId: 'prior-session',
      positionSeconds: 300,
      durationSeconds: 600,
      revision: 1,
    });
    const handle = newOnlineSession({ epoch: 2 });
    try {
      service.applySample(scopeOf(handle), { sampleSeq: 1, expectedGeneration: 1, positionSeconds: 100, reason: 'started' });
      expect.unreachable();
    } catch (error) {
      expect((error as DomainError).status).toBe(409);
      expect((error as DomainError).code).toBe('PROGRESS_NOT_READY');
    }
    // 旧历史保留(未被在线未知时长样本改写);ledger 零更新
    const history = historyRowOf(db, world, world.profileAId, world.onlineEpisode.mediaId);
    expect(history.durationSeconds).toBe(600);
    expect(history.positionSeconds).toBe(300);
    const state = progressStateRowOf(db, handle.sessionId);
    expect(state.lastSampleSeq).toBe(0);
    expect(state.ledgerPosition).toBeNull();
    expect(state.sessionStarted).toBe(0);
  });

  it('静态媒体旧义保留:probe 未知回落历史可信 duration;历史证据列保持 NULL(不冒充在线证据)', () => {
    registerPersonalPlaybackFactsPort(null);
    const handle = newStaticSession({ epoch: 1 });
    // 历史 writer = 本会话(同 owner 继续,与 T089 duration 兜底用例同形)
    seedHistoryRowFor(conn, world, {
      mediaId: world.staticVod.mediaId,
      writerEpoch: 1,
      writerSessionId: handle.sessionId,
      positionSeconds: 100,
      durationSeconds: 1800,
      revision: 1,
    });
    const outcome = service.applySampleDetailed(scopeOf(handle), {
      sampleSeq: 1,
      expectedGeneration: 1,
      positionSeconds: 120,
      reason: 'started',
    });
    expect(outcome.applied).toBe(true);
    const history = historyRowOf(db, world, world.profileAId, world.staticVod.mediaId);
    expect(history.durationSeconds).toBe(1800); // 历史可信值兜底(旧义)
    expect(history.continuityRevision).toBeNull(); // 静态:证据列 NULL 旧义
    expect(history.evidenceState).toBeNull();
    expect(history.evidenceDigest).toBeNull();
    expect(history.completed).toBe(0);
    const state = progressStateRowOf(db, handle.sessionId);
    expect(state.continuityRevision).toBe(1); // 静态基线 1
    expect(state.ledgerDuration).toBe(1800);
  });

  it('ledger continuity 随样本记录当前子项修订(T037/T043 规则接点:保存产生时快照,不批量升级)', () => {
    const handle = newOnlineSession({ epoch: 1 });
    service.applySampleDetailed(scopeOf(handle), { sampleSeq: 1, expectedGeneration: 1, positionSeconds: 0, reason: 'started' });
    expect(progressStateRowOf(db, handle.sessionId).continuityRevision).toBe(2);
    expect(historyRowOf(db, world, world.profileAId, world.onlineEpisode.mediaId).continuityRevision).toBe(2);
    // 工厂事实:子项连续性修订推进(等价 T043 continuity 失配素材;内容稳定)
    conn.prepare('UPDATE vod_episode SET continuity_revision = 3 WHERE id = ?').run(world.onlineEpisode.episodeRowId);
    service.applySampleDetailed(scopeOf(handle), { sampleSeq: 2, expectedGeneration: 1, positionSeconds: 30, reason: 'periodic' });
    expect(progressStateRowOf(db, handle.sessionId).continuityRevision).toBe(3);
    expect(historyRowOf(db, world, world.profileAId, world.onlineEpisode.mediaId).continuityRevision).toBe(3);
    // 接点说明:T043 在校验段(修订检查之后、ledger 写入之前)比对绑定 continuity,
    // 失配即 409 拒绝 —— 本编排保证拒绝先于任何 ledger/历史写入。
  });

  it('直播频道:遥测 accepted 不建点播历史(3 键既有形态回归)', () => {
    const handle = seedSessionRow(conn, world, {
      mediaId: world.channel.mediaId,
      playbackSourceId: world.channel.playbackSourceId,
      delivery: 'direct',
    });
    const reply = service.applySample(scopeOf(handle), {
      sampleSeq: 1,
      expectedGeneration: 1,
      positionSeconds: 3600,
      reason: 'started',
    });
    expect(reply).toEqual({ applied: true, reason: 'accepted', historyRevision: null });
    expect(
      conn.prepare('SELECT COUNT(*) AS n FROM profile_viewing_history WHERE household_id = ?').get(world.householdId),
    ).toEqual({ n: 0 });
  });

  it('首次建档同事务(uow):session+epoch+完整 ledger 同 commit;失败整体回滚零半建档', () => {
    // 成功:同一 uow.run 内建会话 + 分配 epoch + 完整 ledger 首次建档
    const committed = rig.uow.run(
      (txStores) => ({
        session: txStores.playback as unknown as {
          insertPreparingSession(values: Record<string, unknown>): void;
        },
        clock: txStores.personalData as unknown as { allocateProgressEpoch(h: string, p: string): number },
        ledger: txStores.personalData as unknown as {
          insertLedgerRow(values: Record<string, unknown>): void;
          findLedgerRow(h: string, s: string): Record<string, unknown> | undefined;
        },
      }),
      (workSet) => {
        const sessionId = `sess-${randomUUID()}`;
        const at = iso(clockMs);
        workSet.session.insertPreparingSession({
          sessionId,
          householdId: world.householdId,
          deviceSessionId: world.deviceSessionAId,
          deviceId: world.deviceIdA,
          profileId: world.profileAId,
          mediaId: world.onlineEpisode.mediaId,
          generation: 1,
          version: 1,
          profileContextVersion: 1,
          createdAt: at,
          lastHeartbeatAt: at,
        });
        const allocated = workSet.clock.allocateProgressEpoch(world.householdId, world.profileAId);
        workSet.ledger.insertLedgerRow({
          householdId: world.householdId,
          playbackSessionId: sessionId,
          profileId: world.profileAId,
          mediaId: world.onlineEpisode.mediaId,
          candidateEpoch: allocated,
          contentRevision: 1,
          profileContextVersion: 1,
          lastGeneration: 1,
          continuityRevision: 2,
          lastResult: null,
        });
        return { sessionId, allocated };
      },
      { behavior: 'immediate' },
    );
    const ledgerRow = conn
      .prepare('SELECT * FROM playback_progress_state WHERE playback_session_id = ?')
      .get(committed.sessionId) as Record<string, unknown> | undefined;
    expect(ledgerRow).toBeDefined();
    expect(ledgerRow?.['candidate_epoch']).toBe(committed.allocated);
    expect(ledgerRow?.['last_sample_seq']).toBe(0);
    expect(ledgerRow?.['ledger_position']).toBeNull();
    expect(ledgerRow?.['ledger_duration']).toBeNull();
    expect(ledgerRow?.['ledger_generation']).toBeNull();
    expect(ledgerRow?.['session_started']).toBe(0);
    expect(ledgerRow?.['continuity_revision']).toBe(2);
    expect(
      conn.prepare('SELECT COUNT(*) AS n FROM playback_session WHERE id = ?').get(committed.sessionId),
    ).toEqual({ n: 1 });

    // 失败:ledger 建档后抛错 → 整体回滚,零半建档(会话行与 ledger 行都不存在)
    expect(() =>
      rig.uow.run(
        (txStores) => ({
          session: txStores.playback as unknown as { insertPreparingSession(values: Record<string, unknown>): void },
          clock: txStores.personalData as unknown as { allocateProgressEpoch(h: string, p: string): number },
          ledger: txStores.personalData as unknown as { insertLedgerRow(values: Record<string, unknown>): void },
        }),
        (workSet) => {
          const sessionId = `sess-${randomUUID()}`;
          const at = iso(clockMs);
          workSet.session.insertPreparingSession({
            sessionId,
            householdId: world.householdId,
            deviceSessionId: world.deviceSessionAId,
            deviceId: world.deviceIdA,
            profileId: world.profileAId,
            mediaId: world.onlineEpisode.mediaId,
            generation: 1,
            version: 1,
            profileContextVersion: 1,
            createdAt: at,
            lastHeartbeatAt: at,
          });
          const allocated = workSet.clock.allocateProgressEpoch(world.householdId, world.profileAId);
          workSet.ledger.insertLedgerRow({
            householdId: world.householdId,
            playbackSessionId: sessionId,
            profileId: world.profileAId,
            mediaId: world.onlineEpisode.mediaId,
            candidateEpoch: allocated,
            contentRevision: 1,
            profileContextVersion: 1,
            lastGeneration: 1,
            continuityRevision: 2,
            lastResult: null,
          });
          throw new Error('注入失败:首次建档必须整体回滚');
        },
        { behavior: 'immediate' },
      ),
    ).toThrowError('注入失败:首次建档必须整体回滚');
    // 回滚后:同 Profile 的 clock 行不回退(可跳号不可重置),但无半建档行
    const remaining = conn
      .prepare('SELECT COUNT(*) AS n FROM playback_progress_state WHERE household_id = ?')
      .get(world.householdId) as { n: number };
    expect(remaining.n).toBe(1); // 仅成功用例的 ledger 行
  });

  it('T016 参与者语义一致(uow):applyAcceptedSample→HistoryTx→recordSampleResult 与服务路径同形', () => {
    // 同形世界 B(档案B/设备B):经真实 uow.run 驱动 T016 参与者走编排顺序
    const handle = seedSessionRow(conn, world, {
      mediaId: world.onlineEpisode.mediaId,
      playbackSourceId: world.onlineEpisode.playbackSourceId,
      delivery: 'hls_proxy',
      deviceSessionId: world.deviceSessionBId,
      profileId: world.profileBId,
    });
    seedProgressStateRow(conn, world, {
      sessionId: handle.sessionId,
      profileId: world.profileBId,
      mediaId: world.onlineEpisode.mediaId,
      candidateEpoch: 9,
    });
    const digestOf = (seq: number, position: number, reason: string): string =>
      // 与 progressSampleDigest 同构的占位判定无需一致 —— 摘要仅作行内容对照
      `digest-${seq}-${position}-${reason}`;
    const sample: LedgerSampleApplyValuesMirror = {
      sampleSeq: 1,
      sampleDigest: digestOf(1, 0, 'started'),
      generation: 1,
      positionSeconds: 0,
      durationSeconds: TRUSTED_DURATION_SECONDS,
      continuityRevision: 2,
      acceptedAt: iso(clockMs),
      sessionStarted: true,
    };
    const historyValues: HistoryUpsertValuesMirror = {
      householdId: world.householdId,
      profileId: world.profileBId,
      mediaId: world.onlineEpisode.mediaId,
      candidateEpoch: 9,
      playbackSessionId: handle.sessionId,
      sampleSeq: 1,
      contentRevision: 1,
      positionSeconds: 0,
      trustedDuration: TRUSTED_DURATION_SECONDS,
      evidenceState: 'unverified',
      at: iso(clockMs),
      continuityRevision: 2,
      evidenceDigest: 'uow-evidence-digest',
    };
    const applied = rig.uow.run(
      (txStores) => ({
        ledger: txStores.personalData as unknown as {
          applyAcceptedSample(h: string, s: string, values: LedgerSampleApplyValuesMirror): void;
          recordSampleResult(h: string, s: string, json: string): void;
        },
        history: txStores.personalData as unknown as {
          upsertHistoryWithEpoch(values: HistoryUpsertValuesMirror): { applied: boolean; revision: number };
        },
      }),
      (workSet) => {
        // ①先 ledger → ②epoch 历史 → ③结果簿记(编排顺序与 service 路径一致)
        workSet.ledger.applyAcceptedSample(world.householdId, handle.sessionId, sample);
        const historyResult = workSet.history.upsertHistoryWithEpoch(historyValues);
        workSet.ledger.recordSampleResult(world.householdId, handle.sessionId, JSON.stringify({ applied: true, reason: 'accepted' }));
        return historyResult;
      },
      { behavior: 'immediate' },
    );
    expect(applied).toEqual({ applied: true, revision: 1 });
    // ledger 游标同形(service 路径字段逐项一致;last_result 由 recordSampleResult 语义接管)
    const state = progressStateRowOf(db, handle.sessionId);
    expect(state.lastSampleSeq).toBe(1);
    expect(state.ledgerPosition).toBe(0);
    expect(state.ledgerDuration).toBe(TRUSTED_DURATION_SECONDS);
    expect(state.ledgerGeneration).toBe(1);
    expect(state.ledgerAcceptedAt).toBe(iso(clockMs));
    expect(state.sessionStarted).toBe(1);
    expect(state.continuityRevision).toBe(2);
    // 历史同形(epoch 裁决内嵌;证据完整携带)
    const history = historyRowOf(db, world, world.profileBId, world.onlineEpisode.mediaId);
    expect(history.writerEpoch).toBe(9);
    expect(history.revision).toBe(1);
    expect(history.continuityRevision).toBe(2);
    expect(history.evidenceState).toBe('unverified');
    expect(history.evidenceDigest).toBe('uow-evidence-digest');
    expect(history.completed).toBe(0);
    // epoch 裁决面:旧 epoch(8 < 9)经参与者写入 → applied=false 带当前 revision
    const older: HistoryUpsertValuesMirror = { ...historyValues, candidateEpoch: 8, positionSeconds: 55 };
    const rejected = rig.uow.run(
      (txStores) => ({
        history: txStores.personalData as unknown as {
          upsertHistoryWithEpoch(values: HistoryUpsertValuesMirror): { applied: boolean; revision: number };
        },
      }),
      (workSet) => workSet.history.upsertHistoryWithEpoch(older),
      { behavior: 'immediate' },
    );
    expect(rejected).toEqual({ applied: false, revision: 1 });
    expect(historyRowOf(db, world, world.profileBId, world.onlineEpisode.mediaId).positionSeconds).toBe(0);
  });
});
