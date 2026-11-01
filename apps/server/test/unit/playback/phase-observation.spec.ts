import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import DatabaseConstructor from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import { DomainError } from '@platform/http-common/domain-error';
import { createUnitOfWork, type UnitOfWork } from '@platform/database/unit-of-work';
import { createIdentityAccessTxReaders } from '@contexts/identity-access/infrastructure/transaction-participants';
import { createPlaybackTxParticipants } from '@contexts/playback/infrastructure/transaction-participants';
import { createPersonalDataTxParticipants } from '@contexts/personal-data/infrastructure/transaction-participants';
import {
  PhaseObservationService,
  PlaybackObservationRateLimitedError,
  OBSERVATION_RATE_LIMIT_PER_SESSION_PER_MINUTE,
  phaseObservationDigest,
  type PhaseObservationInput,
  type PhaseObservationScope,
} from '@contexts/playback/application/phase-observation.service';
import { evaluateTailEligibility } from '@contexts/playback/domain/finish.rules';

/**
 * 010-online-vod T057 —— 相位观测服务行为钉面(真实 DDL + 真实 uow/service;零网络)。
 *
 * 被测面:src/contexts/playback/application/phase-observation.service.ts(ingest 持久化
 * 包装 + 持久 digest 幂等权威 + 2Hz 会话限流 + playing↔playback_started_at 同事务)。
 *
 * 用例 ↔ 契约映射(文件头映射,与 test/contract/online-vod-finish.e2e-spec.ts A 组逐例
 * 对齐 —— e2e 为 HTTP 面权威,本文件为服务级镜像:真实迁移 DDL(0001–0007,FK ON)、
 * 真实 createUnitOfWork(identityAccess/playback/personalData 三键真实参与者)、真实
 * PhaseObservationService(注入 FixtureFakeClock,零真实时钟依赖、零网络)):
 *
 * | 用例       | 契约来源                                                  | e2e 镜像 |
 * | ---------- | -------------------------------------------------------- | -------- |
 * | A1 服务镜像 | api.md §4/§7 I4 + data-model §5:playing 接受、started_at 同事务、不写 ledger/history | A1 |
 * | A2 服务镜像 | 同 seq 同载荷重放返回原结果、不重复落行                     | A2 |
 * | A3 服务镜像 | 同 seq 异载荷 409 PROGRESS_SAMPLE_CONFLICT、不写新行        | A3 |
 * | A4 服务镜像 | 陈旧 seq → accepted=false、游标不回退                      | A4 |
 * | A5 服务镜像 | seek/pause 重置尾锚、playing 再连续重新锚定(tail_anchor 成对) | A5 |
 * | A6 服务镜像 | rate 0.5–2 恰界合法(400 schema 面归 e2e;服务级为纵深防御)  | A6 |
 * | A7 服务镜像 | 推进 > 间隔×rate+0.5 → accepted=false/游标不动/不落行       | A7 |
 * | A8 服务镜像 | gap>3.2s 落行重锚 + finish 资格保守 unknown(与 finish.rules E5 互检) | A8 |
 * | 限流/TTL   | api.md §0「120/min/session」+ data-model §5「最高2Hz/会话…固定TTL会话生命周期」 | — |
 * | 同事务     | data-model §10「playing观测与session标记同短事务、CAS重验」(回滚同体 + 先赢不改写) | — |
 * | 校验族     | 身份(撤销/过期)/归属/旧上下文/phase(终态/preparing/交付)/代次 | — |
 *
 * 权威依据:docs/specs/010-online-vod/data-model.md §5/§9/§10、contracts/api.md §0/§4/§7 I4、
 * tasks.md T057 原文;T054 finish.rules(锚语义共享纯函数面,T057 接线点注)。
 *
 * 不写 ledger/history 断言口径:playback_progress_state 游标/门(rig 以真实参与者建档)
 * 逐字段不变 + profile_viewing_history 恒零行(A1;观测不当授权证明)。
 */

/* ------------------------------------------------------------------ */
/* 夹具:真实 DDL + 真实事务参与者 + FixtureFakeClock(T038 rig 同构)       */
/* ------------------------------------------------------------------ */

type SqliteConnection = DatabaseConstructor.Database;

const CLOCK_START_MS = Date.parse('2026-10-30T08:00:00.000Z');

interface RigSeed {
  householdId: string;
  accountId: string;
  profileId: string;
  deviceId: string;
  deviceSessionId: string;
  secondDeviceSessionId: string;
  playbackSourceId: string;
  episodeMediaId: string;
}

interface Rig {
  conn: SqliteConnection;
  dataDir: string;
  clock: { nowMs(): number; advanceMs(ms: number): void };
  uow: UnitOfWork<{
    identityAccess: typeof createIdentityAccessTxReaders;
    playback: typeof createPlaybackTxParticipants;
    personalData: typeof createPersonalDataTxParticipants;
  }>;
  service: PhaseObservationService;
  seed: RigSeed;
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

/** UTC ISO-8601(毫秒,Z) */
function iso(ms: number): string {
  return new Date(ms).toISOString();
}

/** VOD 在线链路种子(FK 依赖序):身份(双设备会话)→ vod 源 → 目录(父/集)→ 在线 playback_source */
function seedVodWorld(conn: SqliteConnection, t0: number): RigSeed {
  const now = iso(t0);
  const householdId = `hh-t057-${randomUUID()}`;
  const accountId = `acc-t057-${randomUUID()}`;
  const profileId = `prof-t057-${randomUUID()}`;
  const deviceId = `dev-t057-${randomUUID()}`;
  const deviceSessionId = `dsess-t057-${randomUUID()}`;
  const secondDeviceSessionId = `dsess-t057-b-${randomUUID()}`;
  const sourceId = `src-t057-${randomUUID()}`;
  const parentMediaId = `media-parent-t057-${randomUUID()}`;
  const episodeMediaId = `media-ep-t057-${randomUUID()}`;
  const titleId = `vtitle-t057-${randomUUID()}`;
  const lineId = `vline-t057-${randomUUID()}`;
  const episodeId = `vep-t057-${randomUUID()}`;
  const sourceEntryId = `entry-t057-${randomUUID()}`;
  const playbackSourceId = `psrc-t057-${randomUUID()}`;
  conn.transaction(() => {
    conn.prepare('INSERT INTO household (id, name, created_at) VALUES (?, ?, ?)').run(householdId, 'T057 夹具家庭', now);
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
    // 双设备会话(设备B 供归属/跨设备负向):active_profile_id 非空 = 可用身份上下文
    for (const sessionId of [deviceSessionId, secondDeviceSessionId]) {
      conn
        .prepare(
          'INSERT INTO device_session (id, household_id, account_id, device_id, token_hash, active_profile_id, expires_at, last_active_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
        )
        .run(
          sessionId,
          householdId,
          accountId,
          deviceId,
          `token-hash-${sessionId}`,
          profileId,
          iso(t0 + 7 * 24 * 3600_000),
          now,
          now,
        );
    }
    conn
      .prepare(
        "INSERT INTO media_source (id, household_id, kind, name, remote_url, enabled, version, locator_revision, created_at, updated_at) VALUES (?, ?, 'vod', 'T057 夹具来源', 'https://upstream.fixture/api.php', 1, 1, 1, ?, ?)",
      )
      .run(sourceId, householdId, now, now);
    conn.prepare("INSERT INTO vod_source_config (household_id, source_id, adapter) VALUES (?, ?, 'apple-cms-json')").run(householdId, sourceId);
    conn
      .prepare(
        "INSERT INTO media_item (id, household_id, type, title, version, media_role, created_at, updated_at) VALUES (?, ?, 'series', 'T057 剧集', 1, 'vod_title', ?, ?)",
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
    secondDeviceSessionId,
    playbackSourceId,
    episodeMediaId,
  };
}

/** 事务参与者注册表(与组合根 app.module 同键;rig 全真实参与者) */
const TX_STORES = {
  identityAccess: createIdentityAccessTxReaders,
  playback: createPlaybackTxParticipants,
  personalData: createPersonalDataTxParticipants,
};

function openRig(): Rig {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hmp-t057-phase-obs-'));
  const conn = new DatabaseConstructor(path.join(dataDir, `${randomUUID()}.db`));
  conn.pragma('journal_mode = WAL');
  conn.pragma('foreign_keys = ON');
  applyAuthoritativeMigrations(conn);
  const clock = createStepClock(CLOCK_START_MS);
  const seed = seedVodWorld(conn, CLOCK_START_MS);
  openRigs.push({ conn, dataDir });
  const uow = createUnitOfWork({ resolveDatabase: () => conn, txStores: TX_STORES });
  return {
    conn,
    dataDir,
    clock,
    uow,
    service: new PhaseObservationService(uow as never, { now: () => clock.nowMs() }),
    seed,
  };
}

/** 测试步进时钟(最小面:真实 ms 数值推进;同步,无定时器依赖) */
function createStepClock(startMs: number): { nowMs(): number; advanceMs(ms: number): void } {
  let currentMs = startMs;
  return {
    nowMs: () => currentMs,
    advanceMs: (ms: number) => {
      currentMs += Math.max(0, ms);
    },
  };
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
/* 会话/行 helpers                                                       */
/* ------------------------------------------------------------------ */

/** 建档(真实参与者):preparing session + epoch + ledger 首档(同事务,T043 同款),再置 ready */
function createReadySession(
  rig: Rig,
  input: {
    state?: 'preparing' | 'ready' | 'playing' | 'paused' | 'ended';
    delivery?: string | null;
    playbackStartedAtMs?: number | null;
    generation?: number;
  } = {},
): { sessionId: string } {
  const sessionId = `sess-t057-${randomUUID()}`;
  const state = input.state ?? 'ready';
  const delivery = input.delivery === undefined ? (state === 'preparing' ? null : 'hls_proxy') : input.delivery;
  const generation = input.generation ?? 1;
  rig.uow.run(
    (tx) => ({ playback: tx.playback, personalData: tx.personalData }),
    (workSet) => {
      workSet.playback.insertPreparingSession({
        sessionId,
        householdId: rig.seed.householdId,
        deviceSessionId: rig.seed.deviceSessionId,
        deviceId: rig.seed.deviceId,
        profileId: rig.seed.profileId,
        mediaId: rig.seed.episodeMediaId,
        generation,
        version: generation,
        profileContextVersion: 1,
        createdAt: iso(rig.clock.nowMs()),
        lastHeartbeatAt: iso(rig.clock.nowMs()),
      });
      const epoch = workSet.personalData.allocateProgressEpoch(rig.seed.householdId, rig.seed.profileId);
      workSet.personalData.insertLedgerRow({
        householdId: rig.seed.householdId,
        playbackSessionId: sessionId,
        profileId: rig.seed.profileId,
        mediaId: rig.seed.episodeMediaId,
        candidateEpoch: epoch,
        contentRevision: 1,
        profileContextVersion: 1,
        lastGeneration: generation,
        continuityRevision: 1,
        lastResult: null,
      });
    },
    { behavior: 'immediate' },
  );
  rig.conn
    .prepare(
      `UPDATE playback_session SET state = ?, delivery = ?, playback_source_id = ?, playback_started_at = ?,
         ended_at = CASE WHEN ? IN ('ended', 'failed', 'interrupted') THEN ? ELSE ended_at END
       WHERE household_id = ? AND id = ?`,
    )
    .run(
      state,
      delivery,
      state === 'preparing' ? null : rig.seed.playbackSourceId,
      input.playbackStartedAtMs == null ? null : iso(input.playbackStartedAtMs),
      state,
      iso(rig.clock.nowMs()),
      rig.seed.householdId,
      sessionId,
    );
  return { sessionId };
}

function scopeOf(rig: Rig, sessionId: string): PhaseObservationScope {
  return {
    householdId: rig.seed.householdId,
    deviceSessionId: rig.seed.deviceSessionId,
    sessionId,
  };
}

function inputOf(overrides: Partial<PhaseObservationInput> & { eventSeq: number }): PhaseObservationInput {
  return {
    expectedGeneration: 1,
    event: 'playing',
    positionSeconds: 0,
    playbackRate: 1,
    ...overrides,
  };
}

interface ObsRow {
  readonly eventSeq: number;
  readonly eventType: string;
  readonly digest: string;
  readonly serverReceivedAt: string;
  readonly tailAnchorPositionSeconds: number | null;
  readonly tailAnchorTime: string | null;
  readonly deliveredSeen: number;
}

function observationRowsOf(rig: Rig, sessionId: string): ObsRow[] {
  return rig.conn
    .prepare(
      `SELECT event_seq AS eventSeq, event_type AS eventType, digest, server_received_at AS serverReceivedAt,
              tail_anchor_position_seconds AS tailAnchorPositionSeconds, tail_anchor_time AS tailAnchorTime,
              delivered_seen AS deliveredSeen
       FROM playback_phase_observation WHERE household_id = ? AND session_id = ? ORDER BY event_seq`,
    )
    .all(rig.seed.householdId, sessionId) as ObsRow[];
}

function observationCountOf(rig: Rig, sessionId: string): number {
  return (
    rig.conn
      .prepare('SELECT COUNT(*) AS n FROM playback_phase_observation WHERE household_id = ? AND session_id = ?')
      .get(rig.seed.householdId, sessionId) as { n: number }
  ).n;
}

interface SessionRowRead {
  readonly state: string;
  readonly generation: number;
  readonly delivery: string | null;
  readonly playbackStartedAt: string | null;
}

function sessionRowOf(rig: Rig, sessionId: string): SessionRowRead {
  return rig.conn
    .prepare(
      `SELECT state, generation, delivery, playback_started_at AS playbackStartedAt
       FROM playback_session WHERE household_id = ? AND id = ?`,
    )
    .get(rig.seed.householdId, sessionId) as SessionRowRead;
}

interface LedgerRowRead {
  readonly started: number;
  readonly sessionStarted: number;
  readonly lastSampleSeq: number;
  readonly lastResult: string | null;
}

function ledgerRowOf(rig: Rig, sessionId: string): LedgerRowRead {
  return rig.conn
    .prepare(
      `SELECT started, session_started AS sessionStarted, last_sample_seq AS lastSampleSeq, last_result AS lastResult
       FROM playback_progress_state WHERE household_id = ? AND playback_session_id = ?`,
    )
    .get(rig.seed.householdId, sessionId) as LedgerRowRead;
}

function historyRowCount(rig: Rig): number {
  return (
    rig.conn
      .prepare('SELECT COUNT(*) AS n FROM profile_viewing_history WHERE household_id = ?')
      .get(rig.seed.householdId) as { n: number }
  ).n;
}

/** DomainError 稳定码断言(status + code) */
function expectDomainError(action: () => unknown, status: number, code: string): void {
  let caught: unknown;
  try {
    action();
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(DomainError);
  const domainError = caught as DomainError;
  expect(domainError.status).toBe(status);
  expect(domainError.code).toBe(code);
}

/* ------------------------------------------------------------------ */
/* A 组服务级镜像                                                        */
/* ------------------------------------------------------------------ */

describe('T057 · A 组服务级镜像(真实 DDL + 真实 uow/service;零网络)', () => {
  it('A1 镜像:playing 观测接受,playback_started_at 同事务设置;不写 ledger/history/epoch', () => {
    const rig = openRig();
    const { sessionId } = createReadySession(rig);
    const reply = rig.service.ingest(scopeOf(rig, sessionId), inputOf({ eventSeq: 1, positionSeconds: 0 }));
    // 回复三键面(api.md §4 + §7 I4 playbackStarted 追加)
    expect(reply).toEqual({ accepted: true, lastEventSeq: 1, playbackStarted: true });
    // 存储面:观测行落库,锚成对非空,delivered_seen=1(交付事实经事务内校验)
    expect(observationCountOf(rig, sessionId)).toBe(1);
    const rows = observationRowsOf(rig, sessionId);
    expect(rows[0]).toMatchObject({ eventSeq: 1, eventType: 'playing', deliveredSeen: 1 });
    expect(rows[0]!.tailAnchorPositionSeconds).toBe(0);
    expect(rows[0]!.tailAnchorTime).toBe(iso(CLOCK_START_MS));
    // I4 同事务:started 标记已随观测行提交(session 级跨 generation 保留)
    expect(sessionRowOf(rig, sessionId).playbackStartedAt).toBe(iso(CLOCK_START_MS));
    // 观测不当授权证明:ledger 门/游标零变化、历史零行、epoch 不分配新消费
    expect(ledgerRowOf(rig, sessionId)).toEqual({ started: 0, sessionStarted: 0, lastSampleSeq: 0, lastResult: null });
    expect(historyRowCount(rig)).toBe(0);
  });

  it('A2 镜像:同 seq 同载荷重放返回原结果(accepted=true/游标不变),不重复落行', () => {
    const rig = openRig();
    const { sessionId } = createReadySession(rig);
    const payload = inputOf({ eventSeq: 1, positionSeconds: 12.5 });
    expect(rig.service.ingest(scopeOf(rig, sessionId), payload).accepted).toBe(true);
    rig.clock.advanceMs(10);
    const replay = rig.service.ingest(scopeOf(rig, sessionId), payload);
    expect(replay).toEqual({ accepted: true, lastEventSeq: 1, playbackStarted: true });
    expect(observationCountOf(rig, sessionId)).toBe(1);
  });

  it('A3 镜像:同 seq 异载荷 → 409 PROGRESS_SAMPLE_CONFLICT,不写新行、锚不改', () => {
    const rig = openRig();
    const { sessionId } = createReadySession(rig);
    expect(rig.service.ingest(scopeOf(rig, sessionId), inputOf({ eventSeq: 1, positionSeconds: 10 })).accepted).toBe(true);
    const before = observationRowsOf(rig, sessionId);
    expectDomainError(
      () => rig.service.ingest(scopeOf(rig, sessionId), inputOf({ eventSeq: 1, positionSeconds: 99 })),
      409,
      'PROGRESS_SAMPLE_CONFLICT',
    );
    expect(observationCountOf(rig, sessionId)).toBe(1);
    expect(observationRowsOf(rig, sessionId)).toEqual(before);
  });

  it('A4 镜像:陈旧 seq(低于最新游标)→ accepted=false,lastEventSeq 保持最新,零写入', () => {
    const rig = openRig();
    const { sessionId } = createReadySession(rig);
    expect(rig.service.ingest(scopeOf(rig, sessionId), inputOf({ eventSeq: 1, positionSeconds: 10 })).accepted).toBe(true);
    rig.clock.advanceMs(100);
    expect(rig.service.ingest(scopeOf(rig, sessionId), inputOf({ eventSeq: 2, positionSeconds: 10.4 })).accepted).toBe(true);
    rig.clock.advanceMs(100);
    // 同载荷的旧 seq 在新游标下即陈旧(幂等重放窗仅限最新 seq,契约 A4 钉面)
    const stale = rig.service.ingest(scopeOf(rig, sessionId), inputOf({ eventSeq: 1, positionSeconds: 10 }));
    expect(stale).toEqual({ accepted: false, lastEventSeq: 2, playbackStarted: true });
    expect(observationCountOf(rig, sessionId)).toBe(2);
  });

  it('A5 镜像:seek/pause 重置尾锚(行锚成对空),playing 再连续重新锚定(tail_anchor 成对语义)', () => {
    const rig = openRig();
    const { sessionId } = createReadySession(rig);
    const events: Array<{ eventSeq: number; event: PhaseObservationInput['event']; positionSeconds: number }> = [
      { eventSeq: 1, event: 'playing', positionSeconds: 10 },
      { eventSeq: 2, event: 'playing', positionSeconds: 10.4 },
      { eventSeq: 3, event: 'seeking', positionSeconds: 300 },
      { eventSeq: 4, event: 'pause', positionSeconds: 300 },
      { eventSeq: 5, event: 'playing', positionSeconds: 300.4 },
      { eventSeq: 6, event: 'playing', positionSeconds: 300.8 },
    ];
    for (const item of events) {
      const reply = rig.service.ingest(scopeOf(rig, sessionId), inputOf(item));
      expect(reply).toMatchObject({ accepted: true, lastEventSeq: item.eventSeq });
      rig.clock.advanceMs(100);
    }
    const rows = observationRowsOf(rig, sessionId);
    expect(rows.map((row) => row.eventType)).toEqual([
      'playing',
      'playing',
      'seeking',
      'pause',
      'playing',
      'playing',
    ]);
    // 连续 playing 已锚定(同 streak 各行锚=streak 头,成对一致)
    expect(rows[0]!.tailAnchorPositionSeconds).toBe(10);
    expect(rows[1]!.tailAnchorPositionSeconds).toBe(10);
    expect(rows[0]!.tailAnchorTime).toBe(rows[1]!.tailAnchorTime);
    // seek/pause 行:锚成对空(尾锚已重置,需新的连续末段)
    for (const index of [2, 3]) {
      expect([rows[index]!.tailAnchorPositionSeconds, rows[index]!.tailAnchorTime]).toEqual([null, null]);
    }
    // 重锚:新 streak 头即锚(两行一致)
    expect(rows[4]!.tailAnchorPositionSeconds).toBe(300.4);
    expect(rows[5]!.tailAnchorPositionSeconds).toBe(300.4);
    expect(rows[4]!.tailAnchorTime).toBe(rows[5]!.tailAnchorTime);
  });

  it('A6 镜像:rate 0.5/2 恰界接受;越界(服务级纵深防御)accepted=false 且零写入(400 schema 面归 controller zod/e2e)', () => {
    const rig = openRig();
    const { sessionId } = createReadySession(rig);
    expect(rig.service.ingest(scopeOf(rig, sessionId), inputOf({ eventSeq: 1, positionSeconds: 5, playbackRate: 0.5 })).accepted).toBe(true);
    rig.clock.advanceMs(100);
    expect(rig.service.ingest(scopeOf(rig, sessionId), inputOf({ eventSeq: 2, positionSeconds: 5.5, playbackRate: 2 })).accepted).toBe(true);
    // 越界:e2e A6 由 schema 400 拒(VALIDATION_FAILED);服务层纯函数 rejected 防御归一
    rig.clock.advanceMs(100);
    expect(rig.service.ingest(scopeOf(rig, sessionId), inputOf({ eventSeq: 3, positionSeconds: 5.6, playbackRate: 0.49 }))).toMatchObject({
      accepted: false,
      lastEventSeq: 2,
    });
    expect(rig.service.ingest(scopeOf(rig, sessionId), inputOf({ eventSeq: 3, positionSeconds: 5.6, playbackRate: 2.01 }))).toMatchObject({
      accepted: false,
      lastEventSeq: 2,
    });
    expect(observationCountOf(rig, sessionId)).toBe(2);
  });

  it('A7 镜像:可行间隔内推进超界 → accepted=false/游标不动/不落行/started_at 不被拒样本改写', () => {
    const rig = openRig();
    const { sessionId } = createReadySession(rig);
    expect(rig.service.ingest(scopeOf(rig, sessionId), inputOf({ eventSeq: 1, positionSeconds: 100 })).accepted).toBe(true);
    expect(sessionRowOf(rig, sessionId).playbackStartedAt).toBe(iso(CLOCK_START_MS));
    rig.clock.advanceMs(30);
    // 毫秒级间隔内推进 40s ≫ 30ms×1+0.5s → 不可行推进被拒(契约 A7:拒绝观测不落数据行)
    expect(rig.service.ingest(scopeOf(rig, sessionId), inputOf({ eventSeq: 2, positionSeconds: 140 }))).toEqual({
      accepted: false,
      lastEventSeq: 1,
      playbackStarted: true,
    });
    expect(observationCountOf(rig, sessionId)).toBe(1);
    expect(sessionRowOf(rig, sessionId).playbackStartedAt).toBe(iso(CLOCK_START_MS));
  });

  it('A8 镜像:gap>3s 落行重锚(需新的连续末段),尾段资格保守 unknown(与 finish.rules E5 互检)', () => {
    const rig = openRig();
    const { sessionId } = createReadySession(rig);
    expect(rig.service.ingest(scopeOf(rig, sessionId), inputOf({ eventSeq: 1, positionSeconds: 358 })).accepted).toBe(true);
    rig.clock.advanceMs(3200);
    // 推进 0.4 ≤ 3.2×1+0.5(隔离推进规则,仅触发 gap 连续性):gap>3s → anchor_reset 落行重锚
    expect(rig.service.ingest(scopeOf(rig, sessionId), inputOf({ eventSeq: 2, positionSeconds: 358.4 }))).toMatchObject({
      accepted: true,
      lastEventSeq: 2,
    });
    const rows = observationRowsOf(rig, sessionId);
    expect(observationCountOf(rig, sessionId)).toBe(2);
    expect(rows[1]!.tailAnchorPositionSeconds).toBe(358.4);
    expect(rows[1]!.tailAnchorTime).toBe(iso(CLOCK_START_MS + 3200));
    // E5 互检:按序 flush 的持久样本经 finish.rules 折叠,gap 断链 → 末段仅 1 条(0 < 2s 窗)
    // → 资格保守 unknown(与 e2e A8 finish 的 no_tail_observation 形态同源)
    const tail = evaluateTailEligibility({
      sessionGeneration: 1,
      durationSeconds: 360,
      finalPositionSeconds: 358.4,
      finishedAtMs: CLOCK_START_MS + 3200,
      samples: rows.map((row) => ({
        generation: 1,
        eventSeq: row.eventSeq,
        event: 'playing' as const,
        positionSeconds: row.eventSeq === 1 ? 358 : 358.4,
        rate: 1,
        serverReceivedAtMs: Date.parse(row.serverReceivedAt),
      })),
    });
    expect(tail).toMatchObject({ sessionCompleted: false, autoNextEligible: false, reason: 'no_tail_observation' });
  });
});

/* ------------------------------------------------------------------ */
/* 事务内校验族(身份/归属/phase/代次)+ playing↔started_at 同事务            */
/* ------------------------------------------------------------------ */

describe('T057 · 事务内校验族与 playing 同事务(data-model §10;api.md §0/§7 I4)', () => {
  it('代次不匹配 → 409 PLAYBACK_GENERATION_STALE,零写入', () => {
    const rig = openRig();
    const { sessionId } = createReadySession(rig);
    expectDomainError(
      () => rig.service.ingest(scopeOf(rig, sessionId), inputOf({ eventSeq: 1, expectedGeneration: 2 })),
      409,
      'PLAYBACK_GENERATION_STALE',
    );
    expect(observationCountOf(rig, sessionId)).toBe(0);
    expect(sessionRowOf(rig, sessionId).playbackStartedAt).toBeNull();
  });

  it('身份重验:撤销/过期/无当前观看者 → 401 SESSION_INVALID(事务内,已授权不能替代重验)', () => {
    const rig = openRig();
    const { sessionId } = createReadySession(rig);
    rig.conn
      .prepare('UPDATE device_session SET revoked_at = ? WHERE id = ?')
      .run(iso(CLOCK_START_MS - 1000), rig.seed.deviceSessionId);
    expectDomainError(() => rig.service.ingest(scopeOf(rig, sessionId), inputOf({ eventSeq: 1 })), 401, 'SESSION_INVALID');
    // 恢复撤销后改过期:恰过期 = 已过期(边界语义与 session.guard 对齐)
    rig.conn
      .prepare('UPDATE device_session SET revoked_at = NULL, expires_at = ? WHERE id = ?')
      .run(iso(CLOCK_START_MS), rig.seed.deviceSessionId);
    expectDomainError(() => rig.service.ingest(scopeOf(rig, sessionId), inputOf({ eventSeq: 1 })), 401, 'SESSION_INVALID');
    expect(observationCountOf(rig, sessionId)).toBe(0);
  });

  it('归属防御:非本设备会话/旧上下文(contextVersion 不等)→ 404 同形,不泄露存在性', () => {
    const rig = openRig();
    const { sessionId } = createReadySession(rig);
    // 设备B 的有效身份 × 设备A 的会话:归属不符 404
    expectDomainError(
      () =>
        rig.service.ingest(
          { ...scopeOf(rig, sessionId), deviceSessionId: rig.seed.secondDeviceSessionId },
          inputOf({ eventSeq: 1 }),
        ),
      404,
      'PLAYBACK_NOT_FOUND',
    );
    // 旧上下文:A→B 递增后,会话绑定 contextVersion(1) ≠ 当前(2) → 404 同形
    rig.conn
      .prepare('UPDATE device_session SET profile_context_version = 2 WHERE id = ?')
      .run(rig.seed.deviceSessionId);
    expectDomainError(() => rig.service.ingest(scopeOf(rig, sessionId), inputOf({ eventSeq: 1 })), 404, 'PLAYBACK_NOT_FOUND');
    expect(observationCountOf(rig, sessionId)).toBe(0);
  });

  it('phase 校验:终态 → 409 PLAYBACK_ENDED;preparing → 409 PLAYBACK_NOT_READY(交付判定接缝:活动态+交付空由 schema CHECK 排除,服务层保持防御)', () => {
    const rig = openRig();
    const ended = createReadySession(rig, { state: 'ended', delivery: null });
    expectDomainError(() => rig.service.ingest(scopeOf(rig, ended.sessionId), inputOf({ eventSeq: 1 })), 409, 'PLAYBACK_ENDED');
    const preparing = createReadySession(rig, { state: 'preparing' });
    expectDomainError(
      () => rig.service.ingest(scopeOf(rig, preparing.sessionId), inputOf({ eventSeq: 1 })),
      409,
      'PLAYBACK_NOT_READY',
    );
    expect(observationCountOf(rig, ended.sessionId)).toBe(0);
    expect(observationCountOf(rig, preparing.sessionId)).toBe(0);
  });

  it('paused 活动态可观测(I4 ready/playing/paused);ratechange 透传不改锚', () => {
    const rig = openRig();
    const { sessionId } = createReadySession(rig, { state: 'paused' });
    expect(rig.service.ingest(scopeOf(rig, sessionId), inputOf({ eventSeq: 1, positionSeconds: 10 })).accepted).toBe(true);
    rig.clock.advanceMs(100);
    // ratechange 透传:accepted、锚保持 streak 头(10)不变、游标前移
    expect(rig.service.ingest(scopeOf(rig, sessionId), inputOf({ eventSeq: 2, event: 'ratechange', positionSeconds: 10, playbackRate: 1.5 }))).toMatchObject({
      accepted: true,
      lastEventSeq: 2,
    });
    const rows = observationRowsOf(rig, sessionId);
    expect(rows[1]!.eventType).toBe('ratechange');
    expect(rows[1]!.tailAnchorPositionSeconds).toBe(10);
    // ratechange 后的 playing 推进界按相邻两 playing 样本(接收差 × 本样本 rate + 0.5)
    rig.clock.advanceMs(1000);
    expect(rig.service.ingest(scopeOf(rig, sessionId), inputOf({ eventSeq: 3, positionSeconds: 12, playbackRate: 1.5 }))).toMatchObject({
      accepted: true,
      lastEventSeq: 3,
    });
    expect(observationCountOf(rig, sessionId)).toBe(3);
  });

  it('同事务回滚体:落行失败(start position CHECK)→ started_at 不被部分写入(data-model §10 同短事务)', () => {
    const rig = openRig();
    const { sessionId } = createReadySession(rig);
    // 服务层不预校验位置(schema 面 400 拒负值);DB CHECK 为最后防线:
    // insert 抛错即整体回滚 —— 观测行与 started_at 同生共死,不部分提交
    expect(() => rig.service.ingest(scopeOf(rig, sessionId), inputOf({ eventSeq: 1, positionSeconds: -1 }))).toThrow();
    expect(observationCountOf(rig, sessionId)).toBe(0);
    expect(sessionRowOf(rig, sessionId).playbackStartedAt).toBeNull();
  });

  it('started_at 单向 CAS(先赢不改写):已有标记的 playing 观测接受但标记保持原值', () => {
    const rig = openRig();
    const preset = CLOCK_START_MS - 60_000;
    const { sessionId } = createReadySession(rig, { playbackStartedAtMs: preset });
    expect(rig.service.ingest(scopeOf(rig, sessionId), inputOf({ eventSeq: 1, positionSeconds: 0 }))).toMatchObject({
      accepted: true,
      playbackStarted: true,
    });
    expect(sessionRowOf(rig, sessionId).playbackStartedAt).toBe(iso(preset));
    expect(observationCountOf(rig, sessionId)).toBe(1);
  });

  it('digest 规范化:载荷不含接收时刻(serverReceivedAt 不参与重放比对;T054 接线点)', () => {
    expect(
      phaseObservationDigest({ generation: 1, event: 'playing', positionSeconds: 12.5, playbackRate: 1 }),
    ).toBe(phaseObservationDigest({ generation: 1, event: 'playing', positionSeconds: 12.5, playbackRate: 1 }));
    expect(
      phaseObservationDigest({ generation: 1, event: 'playing', positionSeconds: 12.5, playbackRate: 1 }),
    ).not.toBe(phaseObservationDigest({ generation: 1, event: 'playing', positionSeconds: 12.6, playbackRate: 1 }));
    expect(
      phaseObservationDigest({ generation: 1, event: 'playing', positionSeconds: 12.5, playbackRate: 1 }),
    ).not.toBe(phaseObservationDigest({ generation: 1, event: 'pause', positionSeconds: 12.5, playbackRate: 1 }));
  });
});

/* ------------------------------------------------------------------ */
/* 2Hz 会话限流与固定 TTL(api.md §0「120/min/session」;data-model §5「固定TTL会话生命周期」) */
/* ------------------------------------------------------------------ */

describe('T057 · 2Hz 会话限流与 TTL(api.md §0「phase观测独立120/min/session」=「最高2Hz/会话」)', () => {
  it('滑动 60s 窗上限 120:第 121 次 429(附 Retry-After ≥1),超频零落行;时钟出窗后恢复(TTL)', async () => {
    const rig = openRig();
    const { sessionId } = createReadySession(rig);
    const scope = scopeOf(rig, sessionId);
    for (let index = 1; index <= OBSERVATION_RATE_LIMIT_PER_SESSION_PER_MINUTE; index += 1) {
      // 同刻连发:间隔 0 → 推进界 0×1+0.5s,步进 0.4 可行
      expect(rig.service.ingest(scope, inputOf({ eventSeq: index, positionSeconds: (index - 1) * 0.4 })).accepted).toBe(true);
    }
    expect(observationCountOf(rig, sessionId)).toBe(OBSERVATION_RATE_LIMIT_PER_SESSION_PER_MINUTE);
    let caught: unknown;
    try {
      rig.service.ingest(scope, inputOf({ eventSeq: 121, positionSeconds: 48 }));
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(PlaybackObservationRateLimitedError);
    const limited = caught as PlaybackObservationRateLimitedError;
    expect(limited.status).toBe(429);
    expect(limited.code).toBe('PLAYBACK_RATE_LIMITED');
    expect(limited.retryAfterSeconds).toBeGreaterThanOrEqual(1);
    expect(limited.retryAfterSeconds).toBeLessThanOrEqual(60);
    expect(observationCountOf(rig, sessionId)).toBe(OBSERVATION_RATE_LIMIT_PER_SESSION_PER_MINUTE);
    // TTL:窗口(60s)整体滑出后桶腾空,观测恢复接受(固定 TTL 会话生命周期)
    rig.clock.advanceMs(60_001);
    expect(rig.service.ingest(scope, inputOf({ eventSeq: 121, positionSeconds: 48 })).accepted).toBe(true);
    expect(observationCountOf(rig, sessionId)).toBe(OBSERVATION_RATE_LIMIT_PER_SESSION_PER_MINUTE + 1);
  }, 20_000);

  it('桶按会话隔离:会话A 打满不影响会话B;业务拒绝(重放)同样计数(防绕过)', () => {
    const rig = openRig();
    const sessionA = createReadySession(rig).sessionId;
    const sessionB = createReadySession(rig).sessionId;
    // A:119 接受 + 1 重放(重放零写入但通过限流检查 → 计数,与既有限频器同口径)
    for (let index = 1; index <= 119; index += 1) {
      rig.service.ingest(scopeOf(rig, sessionA), inputOf({ eventSeq: index, positionSeconds: (index - 1) * 0.4 }));
    }
    rig.service.ingest(scopeOf(rig, sessionA), inputOf({ eventSeq: 119, positionSeconds: (119 - 1) * 0.4 }));
    expect(observationCountOf(rig, sessionA)).toBe(119);
    // 第 121 次尝试(新 seq)→ 429
    expectDomainError(
      () => rig.service.ingest(scopeOf(rig, sessionA), inputOf({ eventSeq: 120, positionSeconds: 47.6 })),
      429,
      'PLAYBACK_RATE_LIMITED',
    );
    // B 会话独立桶:不受 A 打满影响
    expect(rig.service.ingest(scopeOf(rig, sessionB), inputOf({ eventSeq: 1, positionSeconds: 0 })).accepted).toBe(true);
    expect(observationCountOf(rig, sessionB)).toBe(1);
  }, 20_000);
});
