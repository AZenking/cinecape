/**
 * 010-online-vod T060(US3)—— next/manual_next 过渡编排服务行为契约(编排级单测)。
 *
 * T060 原文(tasks.md):next/manual_next、显式替换 pending、GET 恢复及 cancel 输家
 * 返回 successor;重验偏好/序列/双方上下文及目标权限;switch 分支在 US4 完成前明确
 * 拒绝。审查补充:next-plans 端点,next/manual_next 必须 nextPlanRef。
 *
 * 被测实现:@contexts/playback/application/playback-transition.service(纯类编排)。
 *
 * 夹具分层(真实 store/规则面,零网络/零 mock 存储层):
 * - 独立临时文件库 + 全量权威迁移 DDL(0001–0007)—— 真实 CHECK/FK/唯一索引;
 * - 真实 drizzleTransitionStore(BEGIN IMMEDIATE 多写)+ 真实平台 UnitOfWork
 *   (txStores 注册 playback/personalData 事务参与者 —— 消费事务/偏好重验走真实
 *   BEGIN IMMEDIATE 与真实 epoch/ledger 写面);
 * - 在线目录事实(vod_title/vod_line/vod_episode/vod_episode_sequence)真实 SQL 只读
 *   适配(与装配层 TransitionVodFactsReader 同谓词),导航判定经 online-vod 发布面
 *   nextEpisodeFor 纯函数(唯一权威导航语义);
 * - 仅跨进程边界(targetAuthorizer/inputBinder/successorPreparer/sessionStore)以
 *   记录型 stub 替身 —— 网络与 fire-and-forget 准备不在本服务职责内。
 *
 * 权威依据:docs/specs/010-online-vod/contracts/api.md §5/§7 I3(计划 9 键快照/
 * IntentRequest 严格 oneOf/同 key 重放 200 不续 TTL/异摘要 409/创建与消费双验快照:
 * 目标/序列/历史变化 409 NEXT_PLAN_CHANGED、超期 410 NEXT_PLAN_EXPIRED、无确定下一集
 * 404 VOD_NEXT_UNAVAILABLE、偏好消费重验)+ §6 问题码;data-model §7/§10;
 * internal-ports §2(TransitionConsumeWorkSet 步骤序:校验 slot → 创建 preparing
 * session → 分配 epoch/ledger → consumed/后继,任何失败整体回滚)+ §5(消费前置=
 * canConsumeIntent ∧ ¬isIntentExpired ∧ slot reserved);transition.rules(T054:
 * TTL/switch 拒绝);T052 e2e(online-vod-next-transition.e2e-spec.ts,本 spec 为其
 * 编排层等价面,零 HTTP/零上游)。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import DatabaseConstructor from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import { ProblemCode } from '@hmp/shared';
import { DomainError } from '@platform/http-common/domain-error';
import { createUnitOfWork, type TransactionBinding } from '@platform/database/unit-of-work';
import { bindTransitionStore, type PlaybackTransitionStore } from '@contexts/playback/application/playback-transition-store.port';
import { drizzleTransitionStore } from '@contexts/playback/infrastructure/playback-transition-store.drizzle';
import { createPlaybackTxParticipants } from '@contexts/playback/infrastructure/transaction-participants';
import { createPersonalDataTxParticipants } from '@contexts/personal-data/infrastructure/transaction-participants';
import { TransitionSourceContextService } from '@contexts/playback/application/transition-source-context.service';
import {
  PlaybackTransitionService,
  type TransitionConsumeTxPort,
  type TransitionConsumeWorkSetStores,
  type TransitionIntentCommand,
  type TransitionSessionStorePort,
  type TransitionVodFactsPort,
} from '@contexts/playback/application/playback-transition.service';
import type { SequenceNavigationStore } from '@contexts/online-vod';

/* ------------------------------------------------------------------ */
/* rig:临时文件库 + 全量权威迁移 + 最小在线剧集世界 + 真实 store/uow       */
/* ------------------------------------------------------------------ */

interface RigSeed {
  readonly householdId: string;
  readonly profileId: string;
  readonly deviceSessionId: string;
  readonly deviceId: string;
  readonly sourceMediaId: string;
  readonly targetMediaId: string;
  readonly lastMediaId: string;
  readonly sourceSessionId: string;
  readonly playbackSourceId: string;
  readonly mediaSourceId: string;
}

interface Rig {
  readonly conn: DatabaseConstructor.Database;
  readonly store: PlaybackTransitionStore;
  readonly sourceContext: TransitionSourceContextService;
  service: PlaybackTransitionService;
  readonly seed: RigSeed;
  readonly dataDir: string;
  /** 注入时钟(ms;用例按需推进做 TTL 边界) */
  nowMs: number;
  /** targetAuthorizer/inputBinder/successorPreparer 触达记录 */
  readonly calls: { authorize: string[]; bind: number[]; prepare: string[] };
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

/** 最小在线剧集世界(EP01→EP02→EP03 同线明确 N+1;EP03 末集=无确定下一集锚点) */
function seedWorld(conn: DatabaseConstructor.Database, t0: number): RigSeed {
  const now = iso(t0);
  const householdId = `hh-t060-${randomUUID()}`;
  const accountId = `acc-t060-${randomUUID()}`;
  const profileId = `prof-t060-${randomUUID()}`;
  const deviceId = `dev-t060-${randomUUID()}`;
  const deviceSessionId = `dsess-t060-${randomUUID()}`;
  const mediaSourceId = `msrc-t060-${randomUUID()}`;
  const sourceEntryId = `entry-t060-${randomUUID()}`;
  const sourceMediaId = `media-ep1-${randomUUID()}`;
  const targetMediaId = `media-ep2-${randomUUID()}`;
  const lastMediaId = `media-ep3-${randomUUID()}`;
  const titleId = `title-t060-${randomUUID()}`;
  const lineId = `line-t060-${randomUUID()}`;
  const episode1Id = `ep1-t060-${randomUUID()}`;
  const episode2Id = `ep2-t060-${randomUUID()}`;
  const episode3Id = `ep3-t060-${randomUUID()}`;
  const playbackSourceId = `psrc-t060-${randomUUID()}`;
  const sourceSessionId = `sess-src-t060-${randomUUID()}`;
  conn.transaction(() => {
    conn.prepare('INSERT INTO household (id, name, created_at) VALUES (?, ?, ?)').run(householdId, 'T060 夹具家庭', now);
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
      .run(deviceSessionId, householdId, accountId, deviceId, `token-${deviceSessionId}`, profileId, iso(t0 + 7 * 24 * 3600_000), now, now);
    conn
      .prepare(
        "INSERT INTO media_source (id, household_id, kind, name, remote_url, enabled, version, locator_revision, created_at, updated_at) VALUES (?, ?, 'vod', 'T060 夹具来源', 'https://upstream.fixture/api.php', 1, 1, 1, ?, ?)",
      )
      .run(mediaSourceId, householdId, now, now);
    for (const [mediaId, title] of [
      [sourceMediaId, '第01集'],
      [targetMediaId, '第02集'],
      [lastMediaId, '第03集'],
    ] as const) {
      conn
        .prepare(
          "INSERT INTO media_item (id, household_id, type, title, version, media_role, created_at, updated_at) VALUES (?, ?, 'episode', ?, 1, 'vod_episode', ?, ?)",
        )
        .run(mediaId, householdId, title, now, now);
    }
    conn
      .prepare(
        "INSERT INTO source_entry (id, household_id, source_id, identity_kind, identity_digest, media_id, present, first_seen_at, last_seen_at) VALUES (?, ?, ?, 'vod_episode', ?, ?, 1, ?, ?)",
      )
      .run(sourceEntryId, householdId, mediaSourceId, 'c'.repeat(64), sourceMediaId, now, now);
    conn
      .prepare(
        "INSERT INTO playback_source (id, household_id, source_id, source_entry_id, media_item_id, protocol, location, priority, requires_proxy, locator_kind, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 'hls', 'https://upstream.fixture/ep01.m3u8', 100, 0, 'static', ?, ?)",
      )
      .run(playbackSourceId, householdId, mediaSourceId, sourceEntryId, sourceMediaId, now, now);
    // 在线剧集稳定映射/线路/分集/导航序列(当前指针 detail=1、sequence=1、EP1→EP2→EP3)
    conn
      .prepare(
        "INSERT INTO vod_title (id, household_id, source_id, upstream_vod_id, parent_media_id, current_detail_revision, materialized_at) VALUES (?, ?, ?, 'up-1', ?, 1, ?)",
      )
      .run(titleId, householdId, mediaSourceId, sourceMediaId, now);
    conn
      .prepare(
        "INSERT INTO vod_line (id, household_id, title_id, line_key, display_name, sort_order) VALUES (?, ?, ?, 'main', '主线', 1)",
      )
      .run(lineId, householdId, titleId);
    const episodes = [
      [episode1Id, 'ep-1', '第01集', sourceMediaId, 1],
      [episode2Id, 'ep-2', '第02集', targetMediaId, 2],
      [episode3Id, 'ep-3', '第03集', lastMediaId, 3],
    ] as const;
    for (const [episodeId, episodeKey, label, mediaId, ordinal] of episodes) {
      conn
        .prepare(
          "INSERT INTO vod_episode (id, household_id, line_id, episode_key, label, media_id, content_version_state) VALUES (?, ?, ?, ?, ?, ?, 'unverified')",
        )
        .run(episodeId, householdId, lineId, episodeKey, label, mediaId);
      conn
        .prepare(
          "INSERT INTO vod_episode_sequence (household_id, title_id, line_id, detail_revision, sequence_revision, episode_id, ordinal, sequence_status) VALUES (?, ?, ?, 1, 1, ?, ?, 'ordered')",
        )
        .run(householdId, titleId, lineId, episodeId, ordinal);
    }
    // 来源播放会话(ended:next 资格/消费前置的合法终态来源)
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
    profileId,
    deviceSessionId,
    deviceId,
    sourceMediaId,
    targetMediaId,
    lastMediaId,
    sourceSessionId,
    playbackSourceId,
    mediaSourceId,
  };
}

/** rig 本地目录只读适配(与装配层 TransitionVodFactsReader 同谓词;真实 SQL) */
function buildVodFacts(conn: DatabaseConstructor.Database): TransitionVodFactsPort {
  const SEQUENCE_SELECT = `
    SELECT
      s.household_id AS householdId, s.title_id AS titleId, s.line_id AS lineId,
      l.line_key AS lineKey, s.detail_revision AS detailRevision, s.sequence_revision AS sequenceRevision,
      s.episode_id AS episodeId, e.episode_key AS episodeKey, e.media_id AS mediaId,
      s.season_key AS seasonKey, s.ordinal, s.sequence_status AS sequenceStatus
    FROM vod_episode_sequence s
    JOIN vod_line l ON l.household_id = s.household_id AND l.id = s.line_id
    JOIN vod_episode e ON e.household_id = s.household_id AND e.id = s.episode_id
  `;
  const navigation = {
    findTitle: (householdId: string, titleId: string) =>
      conn
        .prepare(
          'SELECT id, household_id AS householdId, source_id AS sourceId, current_detail_revision AS currentDetailRevision FROM vod_title WHERE household_id = ? AND id = ?',
        )
        .get(householdId, titleId),
    listLinesByTitle: (householdId: string, titleId: string) =>
      conn
        .prepare(
          'SELECT id, household_id AS householdId, title_id AS titleId, line_key AS lineKey, display_name AS displayName, sort_order AS sortOrder FROM vod_line WHERE household_id = ? AND title_id = ? ORDER BY sort_order, id',
        )
        .all(householdId, titleId),
    findLine: (householdId: string, lineId: string) =>
      conn
        .prepare(
          'SELECT id, household_id AS householdId, title_id AS titleId, line_key AS lineKey, display_name AS displayName, sort_order AS sortOrder FROM vod_line WHERE household_id = ? AND id = ?',
        )
        .get(householdId, lineId),
    // 最新已发布快照(MAX detail_revision 下的 MAX sequence_revision;指针先行窗口内
    // 计划创建仍可导航 —— 与装配层 TransitionVodFactsReader 同口径,A4 钉面)
    listCurrentEpisodeSequences: (householdId: string, titleId: string) =>
      conn
        .prepare(
          `${SEQUENCE_SELECT}
           WHERE s.household_id = ? AND s.title_id = ?
             AND s.detail_revision = (SELECT MAX(x.detail_revision) FROM vod_episode_sequence x WHERE x.household_id = s.household_id AND x.title_id = s.title_id)
             AND s.sequence_revision = (SELECT MAX(y.sequence_revision) FROM vod_episode_sequence y WHERE y.household_id = s.household_id AND y.title_id = s.title_id AND y.detail_revision = s.detail_revision)
           ORDER BY s.line_id, s.ordinal, s.episode_id`,
        )
        .all(householdId, titleId),
    listCurrentEpisodeSequencesByLine: (householdId: string, lineId: string) =>
      conn
        .prepare(
          `${SEQUENCE_SELECT}
           WHERE s.household_id = ? AND s.line_id = ?
             AND s.detail_revision = (SELECT MAX(x.detail_revision) FROM vod_episode_sequence x WHERE x.household_id = s.household_id AND x.line_id = s.line_id)
             AND s.sequence_revision = (SELECT MAX(y.sequence_revision) FROM vod_episode_sequence y WHERE y.household_id = s.household_id AND y.line_id = s.line_id AND y.detail_revision = s.detail_revision)
           ORDER BY s.ordinal, s.episode_id`,
        )
        .all(householdId, lineId),
  } as unknown as SequenceNavigationStore;
  return {
    navigation,
    findEpisodeRefByMedia: (householdId, mediaId) =>
      conn
        .prepare('SELECT line_id AS lineId, episode_key AS episodeKey FROM vod_episode WHERE household_id = ? AND media_id = ?')
        .get(householdId, mediaId) as { readonly lineId: string; readonly episodeKey: string } | undefined,
    findTitleIdOfLine: (householdId, lineId) =>
      (conn.prepare('SELECT title_id AS titleId FROM vod_line WHERE household_id = ? AND id = ?').get(householdId, lineId) as
        | { titleId: string }
        | undefined)?.titleId,
    currentSequenceRevision: (householdId, titleId) =>
      ((conn
        .prepare('SELECT MAX(sequence_revision) AS rev FROM vod_episode_sequence WHERE household_id = ? AND title_id = ?')
        .get(householdId, titleId) as { rev: number | null } | undefined)?.rev ?? 0),
    titlePointerFacts: (householdId, titleId) =>
      conn
        .prepare(
          `SELECT vt.current_detail_revision AS detailRevision,
                  COALESCE(ds.locator_revision, ms.locator_revision, 1) AS locatorRevision
           FROM vod_title vt
           LEFT JOIN vod_detail_snapshot ds ON ds.household_id = vt.household_id AND ds.title_id = vt.id AND ds.revision = vt.current_detail_revision
           LEFT JOIN media_source ms ON ms.household_id = vt.household_id AND ms.id = vt.source_id
           WHERE vt.household_id = ? AND vt.id = ?`,
        )
        .get(householdId, titleId) as { readonly detailRevision: number; readonly locatorRevision: number } | undefined,
    findTargetEpisodeRow: (householdId, mediaId) =>
      conn
        .prepare(
          `SELECT ve.label AS label, mi.content_revision AS contentRevision, ve.continuity_revision AS continuityRevision
           FROM vod_episode ve JOIN media_item mi ON mi.household_id = ve.household_id AND mi.id = ve.media_id
           WHERE ve.household_id = ? AND ve.media_id = ?`,
        )
        .get(householdId, mediaId) as
        | { readonly label: string; readonly contentRevision: number | null; readonly continuityRevision: number | null }
        | undefined,
  };
}

/** 真实平台 UnitOfWork 的消费事务桥(txStores 只注册消费面两参与者) */
function buildConsumeTx(conn: DatabaseConstructor.Database): TransitionConsumeTxPort {
  const uow = createUnitOfWork({
    resolveDatabase: () => conn,
    txStores: {
      playback: (binding: TransactionBinding) => createPlaybackTxParticipants(binding),
      personalData: (binding: TransactionBinding) => createPersonalDataTxParticipants(binding),
    },
  });
  return {
    runConsumeTx(work: (stores: TransitionConsumeWorkSetStores) => void): void {
      uow.run(
        (txStores) => ({ playback: txStores.playback, personalData: txStores.personalData }),
        (bound) => {
          work({
            playback: {
              findIntent: (h, id) => bound.playback.findIntent(h, id),
              findSlot: (h, s, g) => bound.playback.findSlot(h, s, g),
              findPlan: (h, id) => bound.playback.findPlan(h, id),
              insertPreparingSession: (values) => bound.playback.insertPreparingSession(values),
            },
            personalData: {
              findVodPreferences: (h, p) => ({ autoplayNext: bound.personalData.findVodPreferences(h, p).autoplayNext }),
              allocateProgressEpoch: (h, p) => bound.personalData.allocateProgressEpoch(h, p),
              insertLedgerRow: (values) => bound.personalData.insertLedgerRow(values),
            },
          });
        },
        { behavior: 'immediate' },
      );
    },
  };
}

function openRig(): Rig {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hmp-t060-transition-'));
  const conn = new DatabaseConstructor(path.join(dataDir, `${randomUUID()}.db`));
  conn.pragma('journal_mode = WAL');
  conn.pragma('foreign_keys = ON');
  applyAuthoritativeMigrations(conn);
  const t0 = Date.now();
  const seed = seedWorld(conn, t0);
  const store = drizzleTransitionStore(conn);
  bindTransitionStore(store);
  const calls = { authorize: [] as string[], bind: [] as number[], prepare: [] as string[] };
  const rig: Rig = {
    conn,
    store,
    sourceContext: new TransitionSourceContextService(store),
    seed,
    dataDir,
    nowMs: t0 + 1000,
    calls,
    service: null as unknown as PlaybackTransitionService,
  };
  rig.service = new PlaybackTransitionService({
    store,
    sourceContext: rig.sourceContext,
    identity: {
      findTrustedSession: (deviceSessionId) => {
        const row = conn
          .prepare('SELECT active_profile_id AS activeProfileId, profile_context_version AS profileContextVersion FROM device_session WHERE id = ?')
          .get(deviceSessionId) as { activeProfileId: string | null; profileContextVersion: number } | undefined;
        return row === undefined ? undefined : { activeProfileId: row.activeProfileId, profileContextVersion: row.profileContextVersion };
      },
    },
    vodFacts: buildVodFacts(conn),
    personalFacts: {
      findTargetHistory: (householdId, profileId, mediaId) => {
        const row = conn
          .prepare(
            'SELECT media_id AS mediaId, position_seconds AS positionSeconds, duration_seconds AS durationSeconds, completed, revision FROM profile_viewing_history WHERE household_id = ? AND profile_id = ? AND media_id = ?',
          )
          .get(householdId, profileId, mediaId) as
          | { mediaId: string; positionSeconds: number; durationSeconds: number | null; completed: number; revision: number }
          | undefined;
        if (row === undefined) {
          return null;
        }
        return {
          mediaId: row.mediaId,
          positionSeconds: row.positionSeconds,
          durationSeconds: row.durationSeconds,
          completed: row.completed === 1,
          contentRevision: 1,
          continuityRevision: 1,
          revision: row.revision,
          writerEpoch: 1,
        };
      },
    },
    targetAuthorizer: {
      authorizeResolve: async (_context, mediaId) => {
        calls.authorize.push(mediaId);
        return {
          snapshot: { deviceId: seed.deviceId, profileContextVersion: 1 },
          candidates: [{ playbackSourceId: seed.playbackSourceId, sourceId: seed.mediaSourceId }],
        };
      },
    },
    consumeTx: buildConsumeTx(conn),
    inputBinder: {
      bindFixedInput: async (input) => {
        calls.bind.push(calls.bind.length + 1);
        conn
          .prepare(
            `INSERT INTO playback_input_binding (
               id, household_id, session_id, generation, playback_source_id, source_id,
               locator_revision, content_revision, resolved_input_id, resolved_at, expires_at, start_basis
             ) VALUES (?, ?, ?, ?, ?, ?, 1, 1, ?, ?, ?, ?)`,
          )
          .run(`bind-${randomUUID()}`, input.householdId, input.sessionId, input.generation, input.playbackSourceId, input.sourceId, `rin-${randomUUID()}`, iso(rig.nowMs), iso(rig.nowMs + 3600_000), input.startBasis);
        return { bindingId: `bind-${randomUUID()}` };
      },
    },
    successorPreparer: {
      prepareTransitionSuccessor: (input) => {
        calls.prepare.push(input.sessionId);
      },
    },
    sessionStore: {
      getSession: (householdId, sessionId) => {
        const row = conn
          .prepare(
            `SELECT id, state, version, generation, desired_paused AS desiredPaused, delivery, position_seconds AS positionSeconds
             FROM playback_session WHERE household_id = ? AND id = ?`,
          )
          .get(householdId, sessionId) as
          | { id: string; state: string; version: number; generation: number; desiredPaused: number; delivery: string | null; positionSeconds: number }
          | undefined;
        if (row === undefined) {
          return { ok: false };
        }
        return { ok: true, value: { ...row, desiredPaused: row.desiredPaused === 1 } as never };
      },
      failSession: (sessionId, input) => {
        conn
          .prepare(
            "UPDATE playback_session SET state = 'failed', failure_code = ?, ended_at = ? WHERE id = ? AND state NOT IN ('ended','failed','interrupted')",
          )
          .run(input.failureCode, iso(rig.nowMs), sessionId);
      },
    } satisfies TransitionSessionStorePort,
    clock: () => rig.nowMs,
  });
  openRigs.push(rig);
  return rig;
}

afterEach(async () => {
  while (openRigs.length > 0) {
    const rig = openRigs.pop();
    rig?.conn.close();
    if (rig !== undefined) {
      fs.rmSync(rig.dataDir, { recursive: true, force: true });
    }
  }
});

/* ------------------------------------------------------------------ */
/* 请求构造助手                                                          */
/* ------------------------------------------------------------------ */

/** SessionContext 形态(测试构造;身份字段一律取服务端行事实) */
interface SpecSessionContext {
  session: {
    id: string;
    householdId: string;
    accountId: string;
    deviceId: string;
    activeProfileId: string;
    expiresAt: string;
  };
  account: { id: string; householdId: string; username: string; role: 'admin' };
}

function sessionContextOf(rig: Rig, deviceSessionId?: string): SpecSessionContext {
  const row = rig.conn
    .prepare(
      'SELECT id, household_id AS householdId, account_id AS accountId, device_id AS deviceId, active_profile_id AS activeProfileId FROM device_session WHERE id = ?',
    )
    .get(deviceSessionId ?? rig.seed.deviceSessionId) as
    | { id: string; householdId: string; accountId: string; deviceId: string; activeProfileId: string | null }
    | undefined;
  expect(row, '夹具错误:device_session 行不存在').toBeDefined();
  const activeProfileId = row!.activeProfileId;
  expect(activeProfileId, '夹具错误:device_session 未选档案').not.toBeNull();
  return {
    session: {
      id: row!.id,
      householdId: row!.householdId,
      accountId: row!.accountId,
      deviceId: row!.deviceId,
      activeProfileId: activeProfileId as string,
      expiresAt: new Date(rig.nowMs + 3600_000).toISOString(),
    },
    account: { id: row!.accountId, householdId: row!.householdId, username: 'admin', role: 'admin' },
  };
}

async function createPlanViaService(rig: Rig, options: { action?: 'next' | 'manual_next'; fromSessionId?: string } = {}) {
  const fromSessionId = options.fromSessionId ?? rig.seed.sourceSessionId;
  const row = rig.conn.prepare('SELECT generation AS g FROM playback_session WHERE id = ?').get(fromSessionId) as { g: number };
  return rig.service.createNextPlan(sessionContextOf(rig), {
    fromSessionId,
    expectedGeneration: row.g,
    action: options.action ?? 'manual_next',
  });
}

function intentCommandOf(rig: Rig, planRef: string, overrides: Partial<TransitionIntentCommand> = {}): TransitionIntentCommand {
  return {
    fromSessionId: rig.seed.sourceSessionId,
    expectedGeneration: 1,
    action: 'manual_next',
    nextPlanRef: planRef,
    positionMode: 'beginning',
    expectedSlotRevision: 0,
    operationKey: randomUUID(),
    ...overrides,
  };
}

interface Chain {
  readonly planRef: string;
  readonly intentId: string;
  readonly slotRevision: number;
}

/** 全链:计划 → pending intent(manual_next/beginning;expectedSlotRevision 取当前槽事实) */
async function createPendingChain(rig: Rig, fromSessionId?: string): Promise<Chain> {
  const sourceSessionId = fromSessionId ?? rig.seed.sourceSessionId;
  const fromGeneration = rig.conn.prepare('SELECT generation AS g FROM playback_session WHERE id = ?').get(sourceSessionId) as { g: number };
  const plan = await createPlanViaService(rig, { fromSessionId: sourceSessionId });
  const slot = rig.store.findSlot(rig.seed.householdId, sourceSessionId, fromGeneration.g);
  const expectedSlotRevision = slot === undefined ? 0 : slot.slotRevision;
  const created = await rig.service.createIntent(
    sessionContextOf(rig),
    intentCommandOf(rig, plan.nextPlanRef, { expectedSlotRevision, fromSessionId: sourceSessionId, expectedGeneration: fromGeneration.g }),
  );
  expect(created.httpStatus).toBe(201);
  return { planRef: plan.nextPlanRef, intentId: created.reply.id, slotRevision: created.reply.slotRevision };
}

async function expectDomainErrorAsync(fn: () => Promise<unknown>, status: number, code: string): Promise<void> {
  try {
    await fn();
    expect.unreachable(`应抛 ${status} ${code}`);
  } catch (error) {
    expect(error).toBeInstanceOf(DomainError);
    const domain = error as DomainError;
    expect(domain.status).toBe(status);
    expect(domain.code).toBe(code);
  }
}

/* ------------------------------------------------------------------ */
/* A 计划创建编排(校验矩阵)                                              */
/* ------------------------------------------------------------------ */

describe('T060 · createNextPlan 编排(计划创建校验矩阵)', () => {
  it('P1 [T060] manual_next 计划:9 键快照+N+1 目标 EP02+TTL 60s;无 slot/intent/session/epoch/历史写', async () => {
    const rig = openRig();
    const beforeSessions = rig.conn.prepare('SELECT COUNT(*) AS n FROM playback_session').get() as { n: number };
    const reply = await createPlanViaService(rig);
    expect(Object.keys(reply).sort()).toEqual(
      ['detailRevision', 'expiresAt', 'history', 'historyChoiceRequired', 'historyRevision', 'label', 'nextPlanRef', 'sequenceRevision', 'targetMediaId'],
    );
    expect(reply.targetMediaId).toBe(rig.seed.targetMediaId);
    expect(reply.label.length).toBeGreaterThan(0);
    expect(reply.sequenceRevision).toBeGreaterThanOrEqual(1);
    expect(reply.detailRevision).toBeGreaterThanOrEqual(1);
    expect(reply.historyRevision).toBe(0);
    expect(reply.historyChoiceRequired).toBe(false);
    expect(reply.history).toBeNull();
    expect(reply.nextPlanRef).not.toMatch(/^https?:\/\//);
    expect(new Date(reply.expiresAt).getTime()).toBe(rig.nowMs + 60_000);
    // 有界计划:零播放/epoch/历史/slot/intent 写
    expect((rig.conn.prepare('SELECT COUNT(*) AS n FROM playback_session').get() as { n: number }).n).toBe(beforeSessions.n);
    expect((rig.conn.prepare('SELECT COUNT(*) AS n FROM playback_transition_slot').get() as { n: number }).n).toBe(0);
    expect((rig.conn.prepare('SELECT COUNT(*) AS n FROM playback_transition_intent').get() as { n: number }).n).toBe(0);
    expect((rig.conn.prepare('SELECT COUNT(*) AS n FROM profile_viewing_history').get() as { n: number }).n).toBe(0);
    expect(rig.calls.authorize, '目标策略经授权端口').toEqual([rig.seed.targetMediaId]);
  });

  it('P2 [T060] 末集 EP03(无确定下一集)→ 404 VOD_NEXT_UNAVAILABLE,不落计划', async () => {
    const rig = openRig();
    // 指向 EP03 的 ended 来源会话(末集 N+1 耗尽锚点)
    const lastSessionId = `sess-last-${randomUUID()}`;
    rig.conn
      .prepare(
        `INSERT INTO playback_session (
           id, household_id, device_session_id, device_id, profile_id, media_id,
           playback_source_id, state, delivery, generation, version,
           position_seconds, audio_track_id, subtitle_track_id, desired_paused,
           created_at, started_at, ended_at, last_heartbeat_at, failure_code
         ) SELECT ?, household_id, device_session_id, device_id, profile_id, ?,
                playback_source_id, 'ended', 'hls_proxy', 1, 1, 0, NULL, NULL, 0,
                created_at, started_at, created_at, created_at, NULL
         FROM playback_session WHERE id = ?`,
      )
      .run(lastSessionId, rig.seed.lastMediaId, rig.seed.sourceSessionId);
    const beforePlans = (rig.conn.prepare('SELECT COUNT(*) AS n FROM playback_next_plan').get() as { n: number }).n;
    await expectDomainErrorAsync(
      () => rig.service.createNextPlan(sessionContextOf(rig), { fromSessionId: lastSessionId, expectedGeneration: 1, action: 'manual_next' }),
      404,
      'VOD_NEXT_UNAVAILABLE',
    );
    expect(beforePlans).toBe((rig.conn.prepare('SELECT COUNT(*) AS n FROM playback_next_plan').get() as { n: number }).n);
  });

  it('P3 [T060] next 无 finish receipt → 409 SOURCE_NOT_TERMINAL;manual_next 免查', async () => {
    const rig = openRig();
    await expectDomainErrorAsync(
      () => rig.service.createNextPlan(sessionContextOf(rig), { fromSessionId: rig.seed.sourceSessionId, expectedGeneration: 1, action: 'next' }),
      409,
      'SOURCE_NOT_TERMINAL',
    );
    // manual_next 不要求资格
    const reply = await createPlanViaService(rig, { action: 'manual_next' });
    expect(reply.targetMediaId).toBe(rig.seed.targetMediaId);
  });

  it('P4 [T060] 来源不存在/代次失配 → 404 MEDIA_NOT_FOUND(与目标拒绝同形)', async () => {
    const rig = openRig();
    await expectDomainErrorAsync(
      () => rig.service.createNextPlan(sessionContextOf(rig), { fromSessionId: `sess-missing-${randomUUID()}`, expectedGeneration: 1, action: 'manual_next' }),
      404,
      'MEDIA_NOT_FOUND',
    );
    await expectDomainErrorAsync(
      () => rig.service.createNextPlan(sessionContextOf(rig), { fromSessionId: rig.seed.sourceSessionId, expectedGeneration: 2, action: 'manual_next' }),
      404,
      'MEDIA_NOT_FOUND',
    );
  });
});

/* ------------------------------------------------------------------ */
/* B 意图创建编排(资格/重验/幂等/槽 CAS/switch 拒绝)                      */
/* ------------------------------------------------------------------ */

describe('T060 · createIntent 编排(资格/重验/幂等/槽 CAS/switch 拒绝)', () => {
  it('I1 [T060] 创建 201 → 同 key 重放 200 同形不续 TTL;同 key 异摘要 409 IDEMPOTENCY_CONFLICT', async () => {
    const rig = openRig();
    const plan = await createPlanViaService(rig);
    const command = intentCommandOf(rig, plan.nextPlanRef);
    const first = await rig.service.createIntent(sessionContextOf(rig), command);
    expect(first.httpStatus).toBe(201);
    expect(first.reply.status).toBe('pending');
    expect(first.reply.slotRevision).toBe(1);
    expect(first.reply.positionMode).toBe('beginning');
    expect(first.reply.successorSessionId).toBeNull();
    const replay = await rig.service.createIntent(sessionContextOf(rig), command);
    expect(replay.httpStatus).toBe(200);
    expect(replay.reply).toEqual(first.reply);
    expect(replay.reply.expiresAt).toBe(first.reply.expiresAt);
    await expectDomainErrorAsync(
      () => rig.service.createIntent(sessionContextOf(rig), { ...command, positionMode: 'target_history' }),
      409,
      ProblemCode.IDEMPOTENCY_CONFLICT,
    );
  });

  it('I2 [T060] 显式替换:新 key+expectedSlotRevision → 201 新 intent,旧 superseded、slot revision+1;陈旧 CAS 409 槽不动', async () => {
    const rig = openRig();
    const chain = await createPendingChain(rig);
    // 陈旧/超前 CAS → 409,零新 intent
    await expectDomainErrorAsync(
      () => rig.service.createIntent(sessionContextOf(rig), intentCommandOf(rig, chain.planRef, { expectedSlotRevision: 0 })),
      409,
      'TRANSITION_SLOT_CONFLICT',
    );
    await expectDomainErrorAsync(
      () => rig.service.createIntent(sessionContextOf(rig), intentCommandOf(rig, chain.planRef, { expectedSlotRevision: 99 })),
      409,
      'TRANSITION_SLOT_CONFLICT',
    );
    expect((rig.conn.prepare('SELECT COUNT(*) AS n FROM playback_transition_intent').get() as { n: number }).n).toBe(1);
    // 显式替换 → 新 intent/revision 2/旧 superseded
    const replaced = await rig.service.createIntent(
      sessionContextOf(rig),
      intentCommandOf(rig, chain.planRef, { positionMode: 'target_history', expectedSlotRevision: 1 }),
    );
    expect(replaced.httpStatus).toBe(201);
    expect(replaced.reply.id).not.toBe(chain.intentId);
    expect(replaced.reply.slotRevision).toBe(2);
    expect(rig.store.findIntentById(rig.seed.householdId, chain.intentId)?.status).toBe('superseded');
    const slot = rig.store.findSlot(rig.seed.householdId, rig.seed.sourceSessionId, 1);
    expect(slot?.slotRevision).toBe(2);
    expect(slot?.activeIntentId).toBe(replaced.reply.id);
  });

  it('I3 [T060] 快照对比 NEXT_PLAN_CHANGED 各维:详情/序列/目标内容/连续性/定位/历史任一失真即 409(零残留)', async () => {
    const rig = openRig();
    const dims: { name: string; bump: () => void }[] = [
      {
        name: 'detail',
        bump: () => rig.conn.prepare("UPDATE vod_title SET current_detail_revision = current_detail_revision + 1 WHERE household_id = ?").run(rig.seed.householdId),
      },
      {
        name: 'sequence',
        bump: () =>
          rig.conn
            .prepare('UPDATE vod_episode_sequence SET sequence_revision = sequence_revision + 1 WHERE household_id = ?')
            .run(rig.seed.householdId),
      },
      {
        name: 'targetContent',
        bump: () => rig.conn.prepare('UPDATE media_item SET content_revision = content_revision + 1 WHERE id = ?').run(rig.seed.targetMediaId),
      },
      {
        name: 'targetContinuity',
        bump: () =>
          rig.conn
            .prepare('UPDATE vod_episode SET continuity_revision = COALESCE(continuity_revision, 1) + 1 WHERE media_id = ?')
            .run(rig.seed.targetMediaId),
      },
      {
        name: 'locator',
        bump: () => rig.conn.prepare('UPDATE media_source SET locator_revision = locator_revision + 1 WHERE household_id = ?').run(rig.seed.householdId),
      },
      {
        name: 'history',
        bump: () => {
          // 计划后目标历史出现(等价「他设备已看 EP02 未完」;历史行 FK 依赖 ended 会话)
          const writerSessionId = `sess-hist-${randomUUID()}`;
          rig.conn
            .prepare(
              `INSERT INTO playback_session (
                 id, household_id, device_session_id, device_id, profile_id, media_id,
                 playback_source_id, state, delivery, generation, version,
                 position_seconds, audio_track_id, subtitle_track_id, desired_paused,
                 created_at, started_at, ended_at, last_heartbeat_at, failure_code
               ) SELECT ?, household_id, device_session_id, device_id, profile_id, media_id,
                        playback_source_id, 'ended', 'hls_proxy', 1, 1, 0, NULL, NULL, 0,
                        created_at, started_at, created_at, created_at, NULL
                 FROM playback_session WHERE id = ?`,
            )
            .run(writerSessionId, rig.seed.sourceSessionId);
          rig.conn
            .prepare(
              `INSERT INTO profile_viewing_history (
                 household_id, profile_id, media_id, writer_epoch, writer_playback_session_id, last_sample_seq,
                 content_revision, position_seconds, duration_seconds, last_viewed_at, revision, completed
               ) VALUES (?, ?, ?, 1, ?, 1, 1, 120, 360, ?, 1, 0)`,
            )
            .run(rig.seed.householdId, rig.seed.profileId, rig.seed.targetMediaId, writerSessionId, iso(rig.nowMs));
        },
      },
    ];
    for (const dim of dims) {
      const freshRig = rig;
      const plan = await createPlanViaService(freshRig);
      dim.bump();
      const before = {
        slots: (freshRig.conn.prepare('SELECT COUNT(*) AS n FROM playback_transition_slot').get() as { n: number }).n,
        intents: (freshRig.conn.prepare('SELECT COUNT(*) AS n FROM playback_transition_intent').get() as { n: number }).n,
      };
      await expectDomainErrorAsync(
        () => freshRig.service.createIntent(sessionContextOf(freshRig), intentCommandOf(freshRig, plan.nextPlanRef)),
        409,
        'NEXT_PLAN_CHANGED',
      );
      expect(
        (freshRig.conn.prepare('SELECT COUNT(*) AS n FROM playback_transition_slot').get() as { n: number }).n,
        `${dim.name} 失真拒绝不占槽`,
      ).toBe(before.slots);
      expect(
        (freshRig.conn.prepare('SELECT COUNT(*) AS n FROM playback_transition_intent').get() as { n: number }).n,
        `${dim.name} 失真拒绝不落 intent`,
      ).toBe(before.intents);
    }
  });

  it('I4 [T060] 偏好重验:next 在 autoplayNext=false 拒 409,manual_next 免偏好;计划创建不写偏好', async () => {
    const rig = openRig();
    rig.conn
      .prepare(
        "INSERT INTO profile_vod_preferences (household_id, profile_id, autoplay_next, switch_carry_position, version) VALUES (?, ?, 0, 1, 1)",
      )
      .run(rig.seed.householdId, rig.seed.profileId);
    // 种子 receipt 使 next 资格成立(偏好独立判定)
    seedAutoNextReceipt(rig);
    const plan = await createPlanViaService(rig, { action: 'next' });
    await expectDomainErrorAsync(
      () => rig.service.createIntent(sessionContextOf(rig), intentCommandOf(rig, plan.nextPlanRef, { action: 'next' })),
      409,
      'NEXT_PLAN_CHANGED',
    );
    // manual_next 免偏好
    const manualPlan = await createPlanViaService(rig, { action: 'manual_next' });
    const created = await rig.service.createIntent(sessionContextOf(rig), intentCommandOf(rig, manualPlan.nextPlanRef));
    expect(created.httpStatus).toBe(201);
  });

  it('I5 [T060] switch 分支一期明确拒绝 400 VALIDATION_FAILED(US4/T072 前不留静默)', async () => {
    const rig = openRig();
    await expectDomainErrorAsync(
      () =>
        rig.service.createIntent(sessionContextOf(rig), {
          fromSessionId: rig.seed.sourceSessionId,
          expectedGeneration: 1,
          action: 'switch',
          expectedSlotRevision: 0,
          operationKey: randomUUID(),
        }),
      400,
      ProblemCode.VALIDATION_FAILED,
    );
  });

  it('I6 [T060] 过期计划 → 410 NEXT_PLAN_EXPIRED 零残留;未知/淘汰 ref → 404 NOT_FOUND 同形', async () => {
    const rig = openRig();
    const plan = await createPlanViaService(rig);
    // TTL 边界:计划行成对置过去(保持 CHECK expires_at > created_at)
    rig.conn
      .prepare(
        "UPDATE playback_next_plan SET created_at = '2000-01-01T00:00:00.000Z', expires_at = '2000-01-01T00:01:00.000Z' WHERE household_id = ?",
      )
      .run(rig.seed.householdId);
    const before = (rig.conn.prepare('SELECT COUNT(*) AS n FROM playback_transition_intent').get() as { n: number }).n;
    await expectDomainErrorAsync(
      () => rig.service.createIntent(sessionContextOf(rig), intentCommandOf(rig, plan.nextPlanRef)),
      410,
      'NEXT_PLAN_EXPIRED',
    );
    expect((rig.conn.prepare('SELECT COUNT(*) AS n FROM playback_transition_intent').get() as { n: number }).n).toBe(before);
    await expectDomainErrorAsync(
      () => rig.service.createIntent(sessionContextOf(rig), intentCommandOf(rig, `missing-ref-${randomUUID()}`)),
      404,
      ProblemCode.NOT_FOUND,
    );
  });
});

/* ------------------------------------------------------------------ */
/* C GET/cancel 编排                                                     */
/* ------------------------------------------------------------------ */

describe('T060 · getIntent/cancelIntent 编排(归属/恢复/取消输赢)', () => {
  it('G1 [T060] GET pending 200 同形;过期(clock)→ 410 TRANSITION_EXPIRED;跨设备/旧 context 404 同形', async () => {
    const rig = openRig();
    const chain = await createPendingChain(rig);
    const got = rig.service.getIntent(sessionContextOf(rig), chain.intentId);
    expect(got.id).toBe(chain.intentId);
    expect(got.status).toBe('pending');
    // TTL 边界:恰 60s 仍有效,其后 410
    rig.nowMs += 60_000;
    expect(rig.service.getIntent(sessionContextOf(rig), chain.intentId).status).toBe('pending');
    rig.nowMs += 1;
    await expectDomainErrorAsync(() => Promise.resolve(rig.service.getIntent(sessionContextOf(rig), chain.intentId)), 410, 'TRANSITION_EXPIRED');
    // 跨设备/旧 context 同形 404
    const otherDevice = `dsess-other-${randomUUID()}`;
    rig.conn
      .prepare(
        'INSERT INTO device_session (id, household_id, account_id, device_id, token_hash, active_profile_id, expires_at, last_active_at, created_at) SELECT ?, household_id, account_id, device_id, ?, active_profile_id, expires_at, last_active_at, created_at FROM device_session WHERE id = ?',
      )
      .run(otherDevice, `token-${otherDevice}`, rig.seed.deviceSessionId);
    await expectDomainErrorAsync(() => Promise.resolve(rig.service.getIntent(sessionContextOf(rig, otherDevice), chain.intentId)), 404, ProblemCode.PLAYBACK_NOT_FOUND);
  });

  it('G2 [T060] cancel 矩阵:cancelled(回执 pre-revision,槽 open+1)/already_cancelled(当前 rev)/superseded/expired(clock)/already_consumed+successor', async () => {
    const rig = openRig();
    // cancelled:回执 slotRevision=1(释放前),槽 open rev2
    const chain = await createPendingChain(rig);
    const cancelled = rig.service.cancelIntent(sessionContextOf(rig), chain.intentId);
    expect(cancelled).toEqual({ outcome: 'cancelled', successorSessionId: null, slotRevision: 1 });
    expect(rig.store.findSlot(rig.seed.householdId, rig.seed.sourceSessionId, 1)?.status).toBe('open');
    const repeat = rig.service.cancelIntent(sessionContextOf(rig), chain.intentId);
    expect(repeat).toEqual({ outcome: 'already_cancelled', successorSessionId: null, slotRevision: 2 });
    // superseded:替换后取消旧 intent(槽归新 intent,rev 不再变)
    const chain2 = await createPendingChain(rig);
    await rig.service.createIntent(
      sessionContextOf(rig),
      intentCommandOf(rig, chain2.planRef, { positionMode: 'target_history', expectedSlotRevision: chain2.slotRevision }),
    );
    const slotAfterReplace = rig.store.findSlot(rig.seed.householdId, rig.seed.sourceSessionId, 1);
    expect(rig.service.cancelIntent(sessionContextOf(rig), chain2.intentId)).toEqual({
      outcome: 'superseded',
      successorSessionId: null,
      slotRevision: slotAfterReplace?.slotRevision ?? 0,
    });
    // expired(clock)
    const chain3 = await createPendingChain(rig);
    rig.nowMs += 61_000;
    const expired = rig.service.cancelIntent(sessionContextOf(rig), chain3.intentId);
    expect(expired.outcome).toBe('expired');
    expect(rig.store.findIntentById(rig.seed.householdId, chain3.intentId)?.status).toBe('expired');
    expect(rig.store.findSlot(rig.seed.householdId, rig.seed.sourceSessionId, 1)?.status).toBe('open');
  });

  it('G3 [T060] 取消输给消费 → already_consumed+successorSessionId;后继不受影响', async () => {
    const rig = openRig();
    const chain = await createPendingChain(rig);
    const consumed = await rig.service.resolveTransition(sessionContextOf(rig), {
      mediaId: rig.seed.targetMediaId,
      transitionIntentId: chain.intentId,
    });
    expect(consumed.kind).toBe('consumed');
    const cancel = rig.service.cancelIntent(sessionContextOf(rig), chain.intentId);
    expect(cancel).toEqual({ outcome: 'already_consumed', successorSessionId: consumed.sessionId, slotRevision: 1 });
    expect(rig.store.findIntentById(rig.seed.householdId, chain.intentId)?.status).toBe('consumed');
  });
});

/* ------------------------------------------------------------------ */
/* D resolve 消费编排(§2 TransitionConsumeWorkSet;T061 接线面)           */
/* ------------------------------------------------------------------ */

describe('T060 · resolveTransition 编排(消费事务/重放/前置/重验)', () => {
  it('C1 [T060] beginning 消费:session+epoch/ledger+intent consumed+slot successor 原子;槽 revision 不 bump;绑定/准备各一次', async () => {
    const rig = openRig();
    const chain = await createPendingChain(rig);
    const outcome = await rig.service.resolveTransition(sessionContextOf(rig), {
      mediaId: rig.seed.targetMediaId,
      transitionIntentId: chain.intentId,
    });
    expect(outcome.kind).toBe('consumed');
    const dto = outcome.dto as Record<string, unknown>;
    expect(dto['state']).toBe('preparing');
    expect(dto['startBasis']).toBe('beginning');
    expect(dto['playbackUrl']).toBeNull();
    // 原子结果
    const intent = rig.store.findIntentById(rig.seed.householdId, chain.intentId);
    expect(intent?.status).toBe('consumed');
    expect(intent?.successorId).toBe(outcome.sessionId);
    const slot = rig.store.findSlot(rig.seed.householdId, rig.seed.sourceSessionId, 1);
    expect(slot?.status).toBe('consumed');
    expect(slot?.successorSessionId).toBe(outcome.sessionId);
    expect(slot?.slotRevision, '消费不 bump 槽 revision(仅替换/取消 bump)').toBe(1);
    // epoch/ledger 分档(后继建档)
    const ledger = rig.conn
      .prepare(
        'SELECT candidate_epoch AS epoch, started, last_sample_seq AS lastSampleSeq FROM playback_progress_state WHERE playback_session_id = ?',
      )
      .get(outcome.sessionId) as { epoch: number; started: number; lastSampleSeq: number } | undefined;
    expect(ledger?.epoch).toBeGreaterThanOrEqual(1);
    expect(ledger?.started).toBe(0);
    expect(ledger?.lastSampleSeq).toBe(0);
    // 绑定/准备各一次(beginning 映射)
    expect(rig.calls.bind).toEqual([1]);
    expect(rig.calls.prepare).toEqual([outcome.sessionId]);
    // 来源会话保持 ended
    expect(
      (rig.conn.prepare('SELECT state FROM playback_session WHERE id = ?').get(rig.seed.sourceSessionId) as { state: string }).state,
    ).toBe('ended');
  });

  it('C2 [T060] 先停止再消费:来源未终态 409 SOURCE_NOT_TERMINAL(intent 保持 pending/槽 reserved);终态后消费 201', async () => {
    const rig = openRig();
    const chain = await createPendingChain(rig);
    // 夹具:来源转活动态(rig 种子默认 ended;等价「resolve 后未停止」形态)
    rig.conn.prepare("UPDATE playback_session SET state = 'ready', ended_at = NULL WHERE id = ?").run(rig.seed.sourceSessionId);
    await expectDomainErrorAsync(
      () => rig.service.resolveTransition(sessionContextOf(rig), { mediaId: rig.seed.targetMediaId, transitionIntentId: chain.intentId }),
      409,
      'SOURCE_NOT_TERMINAL',
    );
    expect(rig.store.findIntentById(rig.seed.householdId, chain.intentId)?.status).toBe('pending');
    expect(rig.store.findSlot(rig.seed.householdId, rig.seed.sourceSessionId, 1)?.status).toBe('reserved');
    // 来源转终态(等价 stop;真实 UPDATE,终态 ended_at 必填)
    rig.conn.prepare("UPDATE playback_session SET state = 'ended', ended_at = ? WHERE id = ?").run(iso(rig.nowMs), rig.seed.sourceSessionId);
    const outcome = await rig.service.resolveTransition(sessionContextOf(rig), {
      mediaId: rig.seed.targetMediaId,
      transitionIntentId: chain.intentId,
    });
    expect(outcome.kind).toBe('consumed');
  });

  it('C3 [T060] 消费重验:详情/历史失真 409 NEXT_PLAN_CHANGED 不消耗;next 偏好关闭 409;manual_next 免偏好', async () => {
    const rig = openRig();
    // 详情失真
    const chainA = await createPendingChain(rig);
    rig.conn.prepare('UPDATE vod_title SET current_detail_revision = current_detail_revision + 1').run();
    await expectDomainErrorAsync(
      () => rig.service.resolveTransition(sessionContextOf(rig), { mediaId: rig.seed.targetMediaId, transitionIntentId: chainA.intentId }),
      409,
      'NEXT_PLAN_CHANGED',
    );
    expect(rig.store.findIntentById(rig.seed.householdId, chainA.intentId)?.status).toBe('pending');
    expect(rig.store.findSlot(rig.seed.householdId, rig.seed.sourceSessionId, 1)?.status).toBe('reserved');
    // 历史失真(计划后目标历史出现;plan.historyRevision=0 vs 当前 1)
    rig.conn.prepare('UPDATE vod_title SET current_detail_revision = 1').run();
    const chainB = await createPendingChain(rig);
    seedTargetHistory(rig);
    await expectDomainErrorAsync(
      () => rig.service.resolveTransition(sessionContextOf(rig), { mediaId: rig.seed.targetMediaId, transitionIntentId: chainB.intentId }),
      409,
      'NEXT_PLAN_CHANGED',
    );
    expect(rig.store.findIntentById(rig.seed.householdId, chainB.intentId)?.status).toBe('pending');
  });

  it('C4 [T060] 重放同 intent → 200 同后继(不新建会话);cancelled 意图消费 409;过期意图消费 410', async () => {
    const rig = openRig();
    // 三个独立来源代次(同代 consumed 槽永久不能再建第二后继,场景间互不占槽)
    const sourceB = seedEndedSourceSession(rig, rig.seed.sourceMediaId, 2);
    const sourceC = seedEndedSourceSession(rig, rig.seed.sourceMediaId, 3);
    const chain = await createPendingChain(rig);
    const chain2 = await createPendingChain(rig, sourceB);
    const chain3 = await createPendingChain(rig, sourceC);
    // (1) 消费 → 原样重放 200 同后继,零新会话
    const first = await rig.service.resolveTransition(sessionContextOf(rig), {
      mediaId: rig.seed.targetMediaId,
      transitionIntentId: chain.intentId,
    });
    expect(first.kind).toBe('consumed');
    const sessionsBefore = (rig.conn.prepare('SELECT COUNT(*) AS n FROM playback_session WHERE media_id = ?').get(rig.seed.targetMediaId) as { n: number }).n;
    const replay = await rig.service.resolveTransition(sessionContextOf(rig), {
      mediaId: rig.seed.targetMediaId,
      transitionIntentId: chain.intentId,
    });
    expect(replay.kind).toBe('replayed');
    expect(replay.sessionId).toBe(first.sessionId);
    expect(
      (rig.conn.prepare('SELECT COUNT(*) AS n FROM playback_session WHERE media_id = ?').get(rig.seed.targetMediaId) as { n: number }).n,
      '重放不新建第二会话',
    ).toBe(sessionsBefore);
    // (2) cancelled 意图不可消费(终态不可逆)
    rig.service.cancelIntent(sessionContextOf(rig), chain2.intentId);
    await expectDomainErrorAsync(
      () => rig.service.resolveTransition(sessionContextOf(rig), { mediaId: rig.seed.targetMediaId, transitionIntentId: chain2.intentId }),
      409,
      'TRANSITION_SLOT_CONFLICT',
    );
    // (3) 过期意图不可消费(TTL 边界;410 不误作可重新消费)
    rig.nowMs += 61_000;
    await expectDomainErrorAsync(
      () => rig.service.resolveTransition(sessionContextOf(rig), { mediaId: rig.seed.targetMediaId, transitionIntentId: chain3.intentId }),
      410,
      'TRANSITION_EXPIRED',
    );
  });

  it('C5 [T060] next 消费经偏好重验(autoplayNext=false 409 / true 201);manual_next 免偏好(E 组编排面)', async () => {
    const rig = openRig();
    seedAutoNextReceipt(rig);
    const plan = await createPlanViaService(rig, { action: 'next' });
    const created = await rig.service.createIntent(sessionContextOf(rig), intentCommandOf(rig, plan.nextPlanRef, { action: 'next' }));
    expect(created.httpStatus).toBe(201);
    // 偏好关闭(next 消费拒绝,manual_next 不受影响;无行 INSERT,CAS 由 PATCH 面承担)
    rig.conn
      .prepare(
        'INSERT INTO profile_vod_preferences (household_id, profile_id, autoplay_next, switch_carry_position, version) VALUES (?, ?, 0, 1, 1)',
      )
      .run(rig.seed.householdId, rig.seed.profileId);
    await expectDomainErrorAsync(
      () => rig.service.resolveTransition(sessionContextOf(rig), { mediaId: rig.seed.targetMediaId, transitionIntentId: created.reply.id }),
      409,
      'NEXT_PLAN_CHANGED',
    );
    // 偏好回开 → 消费成功(同一 intent,槽仍 reserved)
    rig.conn.prepare('UPDATE profile_vod_preferences SET autoplay_next = 1 WHERE household_id = ? AND profile_id = ?').run(rig.seed.householdId, rig.seed.profileId);
    const outcome = await rig.service.resolveTransition(sessionContextOf(rig), {
      mediaId: rig.seed.targetMediaId,
      transitionIntentId: created.reply.id,
    });
    expect(outcome.kind).toBe('consumed');
    // manual_next 免偏好:偏好关闭仍可消费(新来源代次;consumed 槽不可再建意图)
    const sourceManual = seedEndedSourceSession(rig, rig.seed.sourceMediaId, 9);
    const manualChain = await createPendingChain(rig, sourceManual);
    rig.conn.prepare('UPDATE profile_vod_preferences SET autoplay_next = 0 WHERE household_id = ? AND profile_id = ?').run(rig.seed.householdId, rig.seed.profileId);
    const manualOutcome = await rig.service.resolveTransition(sessionContextOf(rig), {
      mediaId: rig.seed.targetMediaId,
      transitionIntentId: manualChain.intentId,
    });
    expect(manualOutcome.kind).toBe('consumed');
  });
});

/* ------------------------------------------------------------------ */
/* 种子助手                                                              */
/* ------------------------------------------------------------------ */

/** 种子:指向指定媒体的 ended 来源会话(多来源代次场景;generation 递增) */
function seedEndedSourceSession(rig: Rig, mediaId: string, generation: number): string {
  const sessionId = `sess-gen-${randomUUID()}`;
  rig.conn
    .prepare(
      `INSERT INTO playback_session (
         id, household_id, device_session_id, device_id, profile_id, media_id,
         playback_source_id, state, delivery, generation, version,
         position_seconds, audio_track_id, subtitle_track_id, desired_paused,
         created_at, started_at, ended_at, last_heartbeat_at, failure_code
       ) SELECT ?, household_id, device_session_id, device_id, profile_id, ?,
              playback_source_id, 'ended', 'hls_proxy', ?, 1, 0, NULL, NULL, 0,
              created_at, started_at, created_at, created_at, NULL
       FROM playback_session WHERE id = ?`,
    )
    .run(sessionId, mediaId, generation, rig.seed.sourceSessionId);
  return sessionId;
}

/** 种子:autoNextEligible finish receipt(等价「finish 已提交且合格」形态) */
function seedAutoNextReceipt(rig: Rig): void {
  rig.conn
    .prepare(
      `INSERT INTO playback_finish_receipt (
         household_id, session_id, device_session_id, profile_context_version, generation,
         operation_key, request_digest, final_seq, final_session_accepted,
         history_applied, history_revision, session_completed, auto_next_eligible,
         reason, position_seconds, duration_seconds, ended_at,
         content_revision, continuity_revision, locator_revision
       ) VALUES (?, ?, ?, 1, 1, ?, ?, 2, 1, 0, NULL, 1, 1, 'completed', 355, 360, ?, 1, 1, 1)`,
    )
    .run(rig.seed.householdId, rig.seed.sourceSessionId, rig.seed.deviceSessionId, `ok-${randomUUID()}`, `digest-${randomUUID()}`, iso(rig.nowMs));
}

/** 种子:目标未完成历史行(等价「他设备已看 EP02 未完」) */
function seedTargetHistory(rig: Rig): void {
  const writerSessionId = `sess-hist-${randomUUID()}`;
  rig.conn
    .prepare(
      `INSERT INTO playback_session (
         id, household_id, device_session_id, device_id, profile_id, media_id,
         playback_source_id, state, delivery, generation, version,
         position_seconds, audio_track_id, subtitle_track_id, desired_paused,
         created_at, started_at, ended_at, last_heartbeat_at, failure_code
       ) SELECT ?, household_id, device_session_id, device_id, profile_id, media_id,
                playback_source_id, 'ended', 'hls_proxy', 2, 1, 0, NULL, NULL, 0,
                created_at, started_at, created_at, created_at, NULL
         FROM playback_session WHERE id = ?`,
    )
    .run(writerSessionId, rig.seed.sourceSessionId);
  rig.conn
    .prepare(
      `INSERT INTO profile_viewing_history (
         household_id, profile_id, media_id, writer_epoch, writer_playback_session_id, last_sample_seq,
         content_revision, position_seconds, duration_seconds, last_viewed_at, revision, completed
       ) VALUES (?, ?, ?, 1, ?, 1, 1, 120, 360, ?, 1, 0)`,
    )
    .run(rig.seed.householdId, rig.seed.profileId, rig.seed.targetMediaId, writerSessionId, iso(rig.nowMs));
}
