import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import DatabaseConstructor from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import { DomainError } from '@platform/http-common/domain-error';
import { createUnitOfWork, type UnitOfWork } from '@platform/database/unit-of-work';
import * as schema from '@platform/database/schema';
import { createIdentityAccessTxReaders } from '@contexts/identity-access/infrastructure/transaction-participants';
import { createPlaybackTxParticipants } from '@contexts/playback/infrastructure/transaction-participants';
import { createPersonalDataTxParticipants } from '@contexts/personal-data/infrastructure/transaction-participants';
import { bindPersonalDataStore } from '@contexts/personal-data/application/personal-data-store.port';
import { drizzlePersonalDataStore } from '@contexts/personal-data/infrastructure/personal-data-store.drizzle';
import { ProgressWriteService } from '@contexts/personal-data/application/progress-write.service';
import { registerPersonalPlaybackFactsPort } from '@contexts/personal-data';
import {
  PlaybackFinishService,
  finishRequestDigest,
  type PlaybackFinishInput,
  type PlaybackFinishScope,
} from '@contexts/playback/application/playback-finish.service';
import { PhaseObservationService, type PhaseObservationInput } from '@contexts/playback/application/phase-observation.service';

/**
 * 010-online-vod T058 —— finish 编排服务行为钉面(真实 DDL + 真实 uow;零网络)。
 *
 * 被测面:src/contexts/playback/application/playback-finish.service.ts(ProgressFinishWorkSet
 * 同事务 receipt/终态原子提交;T054 finish.rules 判定接线 + T057 观测 flush + personal-data
 * final 协作)。
 *
 * 装配(与 phase-observation.spec 同构 rig):真实迁移 DDL(0001–0007,FK ON)、真实
 * createUnitOfWork(identityAccess/playback/personalData 三键真实参与者)、真实
 * ProgressWriteService(bindPersonalDataStore 绑定 rig 连接 —— applyFinalInTransaction 在
 * finish uow 事务内以 savepoint 嵌套,T101/T040 既有协作面)、真实 PhaseObservationService
 * (尾段观测经生产 ingest 落行)、T092 facts seam(registerPersonalPlaybackFactsPort 注入
 * EP01=360s,afterEach 复位)、FixtureFakeClock(三服务共用同一时钟域,零真实时钟依赖)。
 *
 * 用例 ↔ 契约映射(文件头映射;HTTP 面权威 = test/contract/online-vod-finish.e2e-spec.ts):
 *
 * | 用例            | 契约来源                                                        | e2e 镜像 |
 * | --------------- | --------------------------------------------------------------- | -------- |
 * | 幂等矩阵·首次   | api.md §4 finish 行 + §1 FinishReceipt 13 键;data-model §5        | B5       |
 * | 幂等矩阵·重放   | 「同payload重放返回原结果(replayed=true)…endedAt 不刷新」           | B2       |
 * | 幂等矩阵·同key异payload | 「same operationKey 异 payload 409」                     | B3       |
 * | 幂等矩阵·异key  | 「已有 receipt 且新 key 不同 409 FINISH_ALREADY_RECORDED 附恢复路径」| B4/E2   |
 * | finishResult·null/一致 | 「200 FinishReceipt|null;只当前原设备/原上下文」           | E1/E2    |
 * | 完成主链        | 尾窗 min(5,d×5%)/末段 min(2,d×5%) 双恰界;completed 只由有效 finish 写 | B1  |
 * | 硬错误回滚零残留 | 「硬非法…整次回滚,不产生 receipt」(playback-state §4)            | —(F2 schema 面) |
 * | not_started     | 「final 先校验:started 门先于尾段判定,不建历史」                  | B7       |
 * | stale_final     | 「stale final 可 ended 但不可 auto-next;ledger/历史不动」           | C2       |
 * | not_completed(stop 先赢)| data-model §5 receipt 行;「endedAt 取原终态时刻,不补写 final」| D1  |
 * | stop 先赢后重放 | 「重放仅返回既有结果」(receipt 不可变)                            | D1/D2    |
 * | superseded 独立完成 | 「个人历史归属和会话完成独立…绝不写他 owner 历史」             | C1       |
 * | 观测折叠·gap>3s | 「gap>3s…使资格 unknown,需新的连续末段」(A8 no_tail_observation)  | A8       |
 * | 观测折叠·缺末段 | final 链接断裂(推进 > 间隔×rate+0.5)→ 资格拒绝                   | B6       |
 * | 身份/归属闸     | 「finish 重放先校验身份/归属再读 receipt」;404 同形不泄露存在性      | F2/E3    |
 * | digest 规范化   | 「同payload重放」比较基准不含接收时刻(operationKey 为幂等键本身)     | —       |
 *
 * no_duration 软形态不设服务级用例:started 门依赖可信 duration(机器 409 拒无时长 started),
 * 服务级不可达(纯规则面由 vod-completion.spec 钉,「无证据≠接口失败」HTTP 形态归 T058 审查注)。
 */

/* ------------------------------------------------------------------ */
/* 夹具:真实 DDL + 真实事务参与者 + 共享 FixtureFakeClock(T038/T057 rig 同构) */
/* ------------------------------------------------------------------ */

type SqliteConnection = DatabaseConstructor.Database;

const CLOCK_START_MS = Date.parse('2026-10-30T08:00:00.000Z');
const EP01_DURATION_SECONDS = 360;

/** FinishReceipt 契约 13 键(api.md §1 / openapi additionalProperties:false) */
const FINISH_RECEIPT_13_KEYS = [
  'sessionId',
  'generation',
  'ended',
  'finalSessionAccepted',
  'historyApplied',
  'historyRevision',
  'sessionCompleted',
  'autoNextEligible',
  'reason',
  'positionSeconds',
  'durationSeconds',
  'endedAt',
  'replayed',
] as const;

interface RigSeed {
  readonly householdId: string;
  readonly accountId: string;
  readonly profileId: string;
  readonly deviceId: string;
  readonly deviceSessionId: string;
  readonly secondDeviceSessionId: string;
  readonly playbackSourceId: string;
  readonly episodeMediaId: string;
}

interface Rig {
  readonly conn: SqliteConnection;
  readonly dataDir: string;
  readonly clock: { nowMs(): number; advanceMs(ms: number): void };
  readonly uow: UnitOfWork<{
    identityAccess: typeof createIdentityAccessTxReaders;
    playback: typeof createPlaybackTxParticipants;
    personalData: typeof createPersonalDataTxParticipants;
  }>;
  readonly progressWrite: ProgressWriteService;
  readonly observations: PhaseObservationService;
  readonly finish: PlaybackFinishService;
  readonly seed: RigSeed;
}

const openRigs: { conn: SqliteConnection; dataDir: string }[] = [];

/** 全量权威迁移(与 T057 rig 同源;FK ON 下逐语句零违反) */
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

/** VOD 在线链路种子(FK 依赖序;双设备会话供归属/跨设备负向) */
function seedVodWorld(conn: SqliteConnection, t0: number): RigSeed {
  const now = iso(t0);
  const householdId = `hh-t058-${randomUUID()}`;
  const accountId = `acc-t058-${randomUUID()}`;
  const profileId = `prof-t058-${randomUUID()}`;
  const deviceId = `dev-t058-${randomUUID()}`;
  const deviceSessionId = `dsess-t058-${randomUUID()}`;
  const secondDeviceSessionId = `dsess-t058-b-${randomUUID()}`;
  const sourceId = `src-t058-${randomUUID()}`;
  const parentMediaId = `media-parent-t058-${randomUUID()}`;
  const episodeMediaId = `media-ep-t058-${randomUUID()}`;
  const titleId = `vtitle-t058-${randomUUID()}`;
  const lineId = `vline-t058-${randomUUID()}`;
  const episodeId = `vep-t058-${randomUUID()}`;
  const sourceEntryId = `entry-t058-${randomUUID()}`;
  const playbackSourceId = `psrc-t058-${randomUUID()}`;
  conn.transaction(() => {
    conn.prepare('INSERT INTO household (id, name, created_at) VALUES (?, ?, ?)').run(householdId, 'T058 夹具家庭', now);
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
    for (const sessionId of [deviceSessionId, secondDeviceSessionId]) {
      conn
        .prepare(
          'INSERT INTO device_session (id, household_id, account_id, device_id, token_hash, active_profile_id, expires_at, last_active_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
        )
        .run(sessionId, householdId, accountId, deviceId, `token-hash-${sessionId}`, profileId, iso(t0 + 7 * 24 * 3600_000), now, now);
    }
    conn
      .prepare(
        "INSERT INTO media_source (id, household_id, kind, name, remote_url, enabled, version, locator_revision, created_at, updated_at) VALUES (?, ?, 'vod', 'T058 夹具来源', 'https://upstream.fixture/api.php', 1, 1, 1, ?, ?)",
      )
      .run(sourceId, householdId, now, now);
    conn.prepare("INSERT INTO vod_source_config (household_id, source_id, adapter) VALUES (?, ?, 'apple-cms-json')").run(householdId, sourceId);
    conn
      .prepare(
        "INSERT INTO media_item (id, household_id, type, title, version, media_role, created_at, updated_at) VALUES (?, ?, 'series', 'T058 剧集', 1, 'vod_title', ?, ?)",
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

/** 测试步进时钟(真实 ms 数值推进;三服务共用同一时钟域) */
function createStepClock(startMs: number): { nowMs(): number; advanceMs(ms: number): void } {
  let currentMs = startMs;
  return {
    nowMs: () => currentMs,
    advanceMs: (ms: number) => {
      currentMs += Math.max(0, ms);
    },
  };
}

/**
 * 开 rig(T092 seam 注入 EP01=360s 代表「probe 已知时长」形态;afterEach 复位 null):
 * personal-data 仓储 seam 绑定 rig 连接 —— finish uow 事务内 applyFinalInTransaction
 * 经该 seam 以 savepoint 嵌套(与生产 getDb() 同连接语义一致)。
 */
function openRig(): Rig {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hmp-t058-finish-'));
  const conn = new DatabaseConstructor(path.join(dataDir, `${randomUUID()}.db`));
  conn.pragma('journal_mode = WAL');
  conn.pragma('foreign_keys = ON');
  applyAuthoritativeMigrations(conn);
  const seed = seedVodWorld(conn, CLOCK_START_MS);
  openRigs.push({ conn, dataDir });
  bindPersonalDataStore(drizzlePersonalDataStore(drizzle(conn, { schema })));
  registerPersonalPlaybackFactsPort({ trustedDurationSeconds: () => EP01_DURATION_SECONDS });
  const clock = createStepClock(CLOCK_START_MS);
  const uow = createUnitOfWork({ resolveDatabase: () => conn, txStores: TX_STORES });
  const sharedClock = { now: () => clock.nowMs() };
  const progressWrite = new ProgressWriteService(sharedClock);
  return {
    conn,
    dataDir,
    clock,
    uow: uow as Rig['uow'],
    progressWrite,
    observations: new PhaseObservationService(uow as never, sharedClock),
    finish: new PlaybackFinishService({
      uow: uow as never,
      progressFinal: progressWrite,
      clock: sharedClock,
    }),
    seed,
  };
}

afterEach(() => {
  registerPersonalPlaybackFactsPort(null);
  while (openRigs.length > 0) {
    const rig = openRigs.pop();
    rig?.conn.close();
    if (rig !== undefined) {
      fs.rmSync(rig.dataDir, { recursive: true, force: true });
    }
  }
});

/* ------------------------------------------------------------------ */
/* 会话/样本/观测/行 helpers                                              */
/* ------------------------------------------------------------------ */

/** 建档(真实参与者):preparing session + epoch + ledger 首档(同事务,T043 同款),再置 ready */
function createReadySession(
  rig: Rig,
  input: { state?: 'preparing' | 'ready' | 'playing' | 'paused' | 'ended' | 'failed' | 'interrupted' } = {},
): { sessionId: string; generation: number } {
  const sessionId = `sess-t058-${randomUUID()}`;
  const state = input.state ?? 'ready';
  const generation = 1;
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
      `UPDATE playback_session SET state = ?, delivery = ?, playback_source_id = ?
       WHERE household_id = ? AND id = ?`,
    )
    .run(state, state === 'preparing' ? null : 'hls_proxy', state === 'preparing' ? null : rig.seed.playbackSourceId, rig.seed.householdId, sessionId);
  return { sessionId, generation };
}

function scopeOf(rig: Rig, sessionId: string, deviceSessionId: string = rig.seed.deviceSessionId): PlaybackFinishScope {
  return {
    householdId: rig.seed.householdId,
    deviceSessionId,
    sessionId,
  };
}

/** started 样本(真实 personal-data 机器;位置缺省 0) */
function acceptStartedSample(rig: Rig, sessionId: string, positionSeconds = 0): void {
  const outcome = rig.progressWrite.applySampleDetailed(
    { householdId: rig.seed.householdId, deviceSessionId: rig.seed.deviceSessionId, sessionId },
    { sampleSeq: 1, expectedGeneration: 1, positionSeconds, reason: 'started' },
  );
  expect(outcome).toMatchObject({ applied: true, reason: 'accepted', sessionAccepted: true, sessionStarted: true });
}

/** periodic 样本(真实 personal-data 机器) */
function acceptPeriodicSample(rig: Rig, sessionId: string, sampleSeq: number, positionSeconds: number): void {
  const outcome = rig.progressWrite.applySampleDetailed(
    { householdId: rig.seed.householdId, deviceSessionId: rig.seed.deviceSessionId, sessionId },
    { sampleSeq, expectedGeneration: 1, positionSeconds, reason: 'periodic' },
  );
  expect(outcome).toMatchObject({ applied: true, reason: 'accepted' });
}

/** 单条 playing 观测(生产 ingest;每步真实推进时钟) */
function ingestPlaying(rig: Rig, sessionId: string, eventSeq: number, positionSeconds: number, advanceMs = 25): void {
  rig.clock.advanceMs(advanceMs);
  const input: PhaseObservationInput = {
    eventSeq,
    expectedGeneration: 1,
    event: 'playing',
    positionSeconds,
    playbackRate: 1,
  };
  const reply = rig.observations.ingest(scopeOf(rig, sessionId), input);
  expect(reply).toMatchObject({ accepted: true, lastEventSeq: eventSeq });
}

/** finish 请求体(cause 仅 natural_end;final = 本次样本,seq 续接 ledger) */
function finishInputOf(sampleSeq: number, positionSeconds: number, operationKey: string = randomUUID()): PlaybackFinishInput {
  return {
    operationKey,
    finalProgress: { sampleSeq, expectedGeneration: 1, positionSeconds },
    cause: 'natural_end',
  };
}

interface SessionRowRead {
  readonly state: string;
  readonly endedAt: string | null;
  readonly cleanupRequested: number;
}

function sessionRowOf(rig: Rig, sessionId: string): SessionRowRead {
  return rig.conn
    .prepare(
      `SELECT state, ended_at AS endedAt, cleanup_requested AS cleanupRequested
       FROM playback_session WHERE household_id = ? AND id = ?`,
    )
    .get(rig.seed.householdId, sessionId) as SessionRowRead;
}

interface LedgerRowRead {
  readonly started: number;
  readonly sessionStarted: number;
  readonly lastSampleSeq: number;
  readonly ledgerPosition: number | null;
  readonly ledgerDuration: number | null;
}

function ledgerRowOf(rig: Rig, sessionId: string): LedgerRowRead {
  return rig.conn
    .prepare(
      `SELECT started, session_started AS sessionStarted, last_sample_seq AS lastSampleSeq,
              ledger_position AS ledgerPosition, ledger_duration AS ledgerDuration
       FROM playback_progress_state WHERE household_id = ? AND playback_session_id = ?`,
    )
    .get(rig.seed.householdId, sessionId) as LedgerRowRead;
}

interface HistoryRowRead {
  readonly writerPlaybackSessionId: string;
  readonly positionSeconds: number;
  readonly revision: number;
  readonly completed: number;
}

function historyRowOf(rig: Rig): HistoryRowRead | undefined {
  return rig.conn
    .prepare(
      `SELECT writer_playback_session_id AS writerPlaybackSessionId, position_seconds AS positionSeconds,
              revision, completed
       FROM profile_viewing_history WHERE household_id = ? AND media_id = ?`,
    )
    .get(rig.seed.householdId, rig.seed.episodeMediaId) as HistoryRowRead | undefined;
}

function historyRowCount(rig: Rig): number {
  return (
    rig.conn
      .prepare('SELECT COUNT(*) AS n FROM profile_viewing_history WHERE household_id = ?')
      .get(rig.seed.householdId) as { n: number }
  ).n;
}

interface ReceiptRowRead {
  readonly operationKey: string;
  readonly finalSessionAccepted: number;
  readonly historyApplied: number;
  readonly historyRevision: number | null;
  readonly sessionCompleted: number;
  readonly autoNextEligible: number;
  readonly reason: string;
  readonly positionSeconds: number | null;
  readonly endedAt: string;
}

function receiptRowOf(rig: Rig, sessionId: string): ReceiptRowRead | undefined {
  return rig.conn
    .prepare(
      `SELECT operation_key AS operationKey, final_session_accepted AS finalSessionAccepted,
              history_applied AS historyApplied, history_revision AS historyRevision,
              session_completed AS sessionCompleted, auto_next_eligible AS autoNextEligible,
              reason, position_seconds AS positionSeconds, ended_at AS endedAt
       FROM playback_finish_receipt WHERE household_id = ? AND session_id = ?`,
    )
    .get(rig.seed.householdId, sessionId) as ReceiptRowRead | undefined;
}

function receiptCount(rig: Rig): number {
  return (
    rig.conn
      .prepare('SELECT COUNT(*) AS n FROM playback_finish_receipt WHERE household_id = ?')
      .get(rig.seed.householdId) as { n: number }
  ).n;
}

/** DomainError 稳定码断言(status + code + detail 包含片段) */
function expectDomainError(action: () => unknown, status: number, code: string, detailContains?: string): DomainError {
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
  if (detailContains !== undefined) {
    expect(String(domainError.detail ?? '')).toContain(detailContains);
  }
  return domainError;
}

/**
 * 中段收尾素材(started(0) → final(300/360);无尾段观测,距尾过大形态):
 * receipt 如实登记 —— 「无证据不等于接口失败」,final 先接受、资格拒绝。
 */
function recordMidwayReceipt(rig: Rig, sessionId: string): { receipt: ReturnType<PlaybackFinishService['finish']>; operationKey: string } {
  const input = finishInputOf(2, 300);
  const receipt = rig.finish.finish(scopeOf(rig, sessionId), input);
  expect(receipt.reason).toBe('no_tail_observation');
  return { receipt, operationKey: input.operationKey };
}

/* ------------------------------------------------------------------ */
/* 幂等矩阵(receipt session_id 唯一;重放/冲突/已登记)                     */
/* ------------------------------------------------------------------ */

describe('T058 · finish 幂等矩阵(session_id 唯一;终态不得由新 finish 升级)', () => {
  it('首次 midway finish:13 键形态、final 先接受(historyApplied=true)、资格拒绝、终态+输入待清理原子落库', () => {
    const rig = openRig();
    const { sessionId } = createReadySession(rig);
    acceptStartedSample(rig, sessionId);
    const { receipt } = recordMidwayReceipt(rig, sessionId);
    // 13 键全量(openapi additionalProperties:false)
    expect(Object.keys(receipt).sort()).toEqual([...FINISH_RECEIPT_13_KEYS].sort());
    expect(receipt.sessionId).toBe(sessionId);
    expect(receipt.generation).toBe(1);
    expect(receipt.ended).toBe(true);
    expect(receipt.finalSessionAccepted).toBe(true);
    expect(receipt.historyApplied).toBe(true);
    expect(receipt.historyRevision).toBeGreaterThanOrEqual(1);
    expect(receipt.sessionCompleted).toBe(false);
    expect(receipt.autoNextEligible).toBe(false);
    expect(receipt.reason).toBe('no_tail_observation');
    expect(receipt.positionSeconds).toBe(300);
    expect(receipt.durationSeconds).toBe(EP01_DURATION_SECONDS);
    expect(Number.isNaN(Date.parse(receipt.endedAt))).toBe(false);
    expect(receipt.replayed).toBe(false);
    // 存储面:final 先落历史(completed 不置位)+ receipt 落库 + 会话终态与清理标记同 commit
    const history = historyRowOf(rig);
    expect(history).toBeDefined();
    expect(history!.positionSeconds).toBe(300);
    expect(history!.completed).toBe(0);
    const row = receiptRowOf(rig, sessionId);
    expect(row).toMatchObject({ reason: 'no_tail_observation', finalSessionAccepted: 1, historyApplied: 1, sessionCompleted: 0, autoNextEligible: 0 });
    expect(sessionRowOf(rig, sessionId)).toMatchObject({ state: 'ended', cleanupRequested: 1 });
    expect(sessionRowOf(rig, sessionId).endedAt).toBe(receipt.endedAt);
  });

  it('同 key 同 payload 重放:返回原结果仅 replayed=true,receipt 行不变(endedAt 不刷新)', () => {
    const rig = openRig();
    const { sessionId } = createReadySession(rig);
    acceptStartedSample(rig, sessionId);
    const input = finishInputOf(2, 300);
    const first = rig.finish.finish(scopeOf(rig, sessionId), input);
    const before = receiptRowOf(rig, sessionId);
    expect(before).toBeDefined();
    rig.clock.advanceMs(5_000);
    const replay = rig.finish.finish(scopeOf(rig, sessionId), input);
    expect(replay).toEqual({ ...first, replayed: true });
    expect(receiptRowOf(rig, sessionId)).toEqual(before);
  });

  it('同 key 异 payload → 409 IDEMPOTENCY_CONFLICT;receipt 不被改写(重试不能刷新末段证据或另存 final)', () => {
    const rig = openRig();
    const { sessionId } = createReadySession(rig);
    acceptStartedSample(rig, sessionId);
    const { operationKey } = recordMidwayReceipt(rig, sessionId);
    const before = receiptRowOf(rig, sessionId);
    expectDomainError(
      () => rig.finish.finish(scopeOf(rig, sessionId), finishInputOf(2, 299, operationKey)),
      409,
      'IDEMPOTENCY_CONFLICT',
    );
    expect(receiptRowOf(rig, sessionId)).toEqual(before);
  });

  it('异 key(已有 receipt)→ 409 FINISH_ALREADY_RECORDED 附 finish-result 恢复路径;原回执经 finishResult 一致恢复', () => {
    const rig = openRig();
    const { sessionId } = createReadySession(rig);
    acceptStartedSample(rig, sessionId);
    const { receipt } = recordMidwayReceipt(rig, sessionId);
    const before = receiptRowOf(rig, sessionId);
    expectDomainError(
      () => rig.finish.finish(scopeOf(rig, sessionId), finishInputOf(3, 359.5)),
      409,
      'FINISH_ALREADY_RECORDED',
      'finish-result',
    );
    expect(receiptRowOf(rig, sessionId)).toEqual(before);
    // 丢响应恢复:GET 语义与 finish 响应逐字段一致(replayed=false),重复 GET 幂等
    expect(rig.finish.finishResult(scopeOf(rig, sessionId))).toEqual(receipt);
    expect(rig.finish.finishResult(scopeOf(rig, sessionId))).toEqual(receipt);
  });

  it('无 receipt 的 finishResult → null(FinishReceipt|null 形态)', () => {
    const rig = openRig();
    const { sessionId } = createReadySession(rig);
    expect(rig.finish.finishResult(scopeOf(rig, sessionId))).toBeNull();
  });
});

/* ------------------------------------------------------------------ */
/* 完成主链与软形态(final 先校验再判尾段;独立四值)                        */
/* ------------------------------------------------------------------ */

describe('T058 · finish 判定链(evaluateFinish 接线;尾窗/末段与独立四值)', () => {
  it('自然结束 completed:连续尾段 + final 落尾窗 → 四独立值全真、历史 completed=1(writer/位置/revision)、receipt/终态同提交', () => {
    const rig = openRig();
    const { sessionId } = createReadySession(rig);
    acceptStartedSample(rig, sessionId);
    // 连续尾段观测(355.5→359.5,0.4 步进):末段覆盖 ≥ min(2,360×5%)=2s,final 距尾 0.5 ≤ 5
    let eventSeq = 1;
    for (let position = 355.5; position <= 359.5 + 1e-9; position += 0.4) {
      ingestPlaying(rig, sessionId, eventSeq, Number(position.toFixed(3)));
      eventSeq += 1;
    }
    rig.clock.advanceMs(25);
    const receipt = rig.finish.finish(scopeOf(rig, sessionId), finishInputOf(2, 359.5));
    expect(receipt).toMatchObject({
      finalSessionAccepted: true,
      historyApplied: true,
      sessionCompleted: true,
      autoNextEligible: true,
      reason: 'completed',
      positionSeconds: 359.5,
      durationSeconds: EP01_DURATION_SECONDS,
      ended: true,
      replayed: false,
    });
    expect(receipt.historyRevision).toBeGreaterThanOrEqual(1);
    // 存储面:completed 只由有效 finish 写(writer=本会话、位置=final、revision 递增);
    // 观测 flush 不改写观测行(finish 零观测写入)
    const history = historyRowOf(rig);
    expect(history).toMatchObject({
      writerPlaybackSessionId: sessionId,
      positionSeconds: 359.5,
      completed: 1,
    });
    expect(receiptRowOf(rig, sessionId)).toMatchObject({ reason: 'completed', sessionCompleted: 1, autoNextEligible: 1 });
    expect(sessionRowOf(rig, sessionId).state).toBe('ended');
  });

  it('硬错误回滚零残留:final 位置超可信时长 → 400 VALIDATION_FAILED,receipt/历史/终态/ledger 零写入', () => {
    const rig = openRig();
    const { sessionId } = createReadySession(rig);
    acceptStartedSample(rig, sessionId);
    // started 已建历史行(acquire 旧义);回滚断言 = finish 前快照零变化
    const historyBefore = historyRowOf(rig);
    const receiptBefore = receiptCount(rig);
    expectDomainError(
      () => rig.finish.finish(scopeOf(rig, sessionId), finishInputOf(2, 400)),
      400,
      'VALIDATION_FAILED',
    );
    expect(receiptCount(rig)).toBe(receiptBefore);
    expect(historyRowOf(rig)).toEqual(historyBefore);
    expect(sessionRowOf(rig, sessionId)).toMatchObject({ state: 'ready', cleanupRequested: 0 });
    expect(ledgerRowOf(rig, sessionId)).toMatchObject({ lastSampleSeq: 1, ledgerPosition: 0 });
  });

  it('not_started:无样本 final → started 门先于尾段判定,不建历史,ended=true 资格全否', () => {
    const rig = openRig();
    const { sessionId } = createReadySession(rig);
    const receipt = rig.finish.finish(scopeOf(rig, sessionId), finishInputOf(1, 0));
    expect(receipt).toMatchObject({
      reason: 'not_started',
      ended: true,
      finalSessionAccepted: false,
      historyApplied: false,
      historyRevision: null,
      sessionCompleted: false,
      autoNextEligible: false,
      replayed: false,
    });
    expect(historyRowCount(rig)).toBe(0);
    expect(ledgerRowOf(rig, sessionId)).toMatchObject({ started: 0, lastSampleSeq: 0 });
    expect(receiptRowOf(rig, sessionId)).toMatchObject({ reason: 'not_started', positionSeconds: null });
  });

  it('stale_final:final seq 低于 ledger 游标 → 可 ended 但不可 auto-next,ledger/历史零更新', () => {
    const rig = openRig();
    const { sessionId } = createReadySession(rig);
    acceptStartedSample(rig, sessionId);
    acceptPeriodicSample(rig, sessionId, 2, 300);
    const receipt = rig.finish.finish(scopeOf(rig, sessionId), finishInputOf(1, 120));
    expect(receipt).toMatchObject({
      reason: 'stale_final',
      ended: true,
      finalSessionAccepted: false,
      historyApplied: false,
      historyRevision: null,
      sessionCompleted: false,
      autoNextEligible: false,
    });
    // 不写新 final:ledger 游标与历史位置保持 periodic(300)原值
    expect(ledgerRowOf(rig, sessionId)).toMatchObject({ lastSampleSeq: 2, ledgerPosition: 300 });
    expect(historyRowOf(rig)).toMatchObject({ positionSeconds: 300, completed: 0 });
    expect(receiptRowOf(rig, sessionId)).toMatchObject({ reason: 'stale_final', positionSeconds: null });
  });
});

/* ------------------------------------------------------------------ */
/* stop 竞争双向(stop 先赢只登记;重放仅返回既有结果)                      */
/* ------------------------------------------------------------------ */

describe('T058 · stop 竞争双向(stop 204 语义不变;finish 不补写 final 不升级)', () => {
  it('stop 先赢:后到 finish 只登记 not_completed(endedAt=原终态时刻),ledger/历史不动;同 key 重放返回原 receipt', () => {
    const rig = openRig();
    const { sessionId } = createReadySession(rig);
    acceptStartedSample(rig, sessionId);
    acceptPeriodicSample(rig, sessionId, 2, 300);
    // stop 先赢(lifecycle 终态;204 面由 e2e D 组钉,此处以同终态事实构造竞争后置)
    rig.clock.advanceMs(1_000);
    const stoppedAt = iso(rig.clock.nowMs());
    rig.conn
      .prepare("UPDATE playback_session SET state = 'ended', ended_at = ? WHERE household_id = ? AND id = ?")
      .run(stoppedAt, rig.seed.householdId, sessionId);
    const receipt = rig.finish.finish(scopeOf(rig, sessionId), finishInputOf(3, 359.5));
    expect(receipt).toMatchObject({
      reason: 'not_completed',
      ended: true,
      finalSessionAccepted: false,
      historyApplied: false,
      historyRevision: null,
      sessionCompleted: false,
      autoNextEligible: false,
      replayed: false,
    });
    // endedAt 取原终态时刻(stop 的 ended_at),不是本次 finish 时刻
    expect(receipt.endedAt).toBe(stoppedAt);
    expect(sessionRowOf(rig, sessionId).endedAt).toBe(stoppedAt);
    // 不补写 final:ledger 游标(2/300)与历史位置(300)保持原值;receipt 唯一行
    expect(ledgerRowOf(rig, sessionId)).toMatchObject({ lastSampleSeq: 2, ledgerPosition: 300 });
    expect(historyRowOf(rig)).toMatchObject({ positionSeconds: 300, completed: 0 });
    expect(receiptRowOf(rig, sessionId)).toMatchObject({ reason: 'not_completed', positionSeconds: null });
    expect(receiptCount(rig)).toBe(1);
    // 同 key 重放:仅返回既有 not_completed 结果(重放仅返回既有结果,零写入)
    rig.clock.advanceMs(2_000);
    const replay = rig.finish.finish(scopeOf(rig, sessionId), finishInputOf(3, 359.5, receiptKeyOf(rig, sessionId)));
    expect(replay).toEqual({ ...receipt, replayed: true });
    expect(receiptCount(rig)).toBe(1);
  });

  it('finish 先赢:receipt 已登记后终态事实不可被新 finish 升级(异 key 恒 409,同 key 恒原结果)', () => {
    const rig = openRig();
    const { sessionId } = createReadySession(rig);
    acceptStartedSample(rig, sessionId);
    const { receipt } = recordMidwayReceipt(rig, sessionId);
    expect(sessionRowOf(rig, sessionId).state).toBe('ended');
    // 后到 stop(lifecycle 仅清理,204 面归 e2e D2)不产生第二份 receipt:异 key 恒冲突
    expectDomainError(
      () => rig.finish.finish(scopeOf(rig, sessionId), finishInputOf(3, 359.5)),
      409,
      'FINISH_ALREADY_RECORDED',
    );
    expect(receiptCount(rig)).toBe(1);
    expect(rig.finish.finishResult(scopeOf(rig, sessionId))).toEqual(receipt);
  });
});

/** 既有 receipt 的 operationKey 回读(重放构造用) */
function receiptKeyOf(rig: Rig, sessionId: string): string {
  const row = receiptRowOf(rig, sessionId);
  expect(row).toBeDefined();
  return row!.operationKey;
}

/* ------------------------------------------------------------------ */
/* superseded 独立完成(个人历史归属和会话完成独立)                        */
/* ------------------------------------------------------------------ */

describe('T058 · superseded 独立完成(data-model §5;playback-state §4)', () => {
  it('superseded 会话 finish:sessionCompleted=true/historyApplied=false,绝不写他 owner 历史', () => {
    const rig = openRig();
    // 双会话:设备A 先 resolve(epoch 旧),设备B 后 resolve(epoch 新)—— C1 同序
    const sessionA = createReadySession(rig);
    const sessionB = createReadySession(rig);
    // 设备B 先 started 取得历史权(epoch 新 owner)
    const ownerStart = rig.progressWrite.applySampleDetailed(
      { householdId: rig.seed.householdId, deviceSessionId: rig.seed.deviceSessionId, sessionId: sessionB.sessionId },
      { sampleSeq: 1, expectedGeneration: 1, positionSeconds: 300, reason: 'started' },
    );
    expect(ownerStart).toMatchObject({ applied: true, reason: 'accepted' });
    const ownerHistory = historyRowOf(rig);
    expect(ownerHistory).toMatchObject({ writerPlaybackSessionId: sessionB.sessionId, positionSeconds: 300 });
    // 设备A 旧 epoch started → superseded(ledger 接受、历史不写)
    const supersededStart = rig.progressWrite.applySampleDetailed(
      { householdId: rig.seed.householdId, deviceSessionId: rig.seed.deviceSessionId, sessionId: sessionA.sessionId },
      { sampleSeq: 1, expectedGeneration: 1, positionSeconds: 100, reason: 'started' },
    );
    expect(supersededStart).toMatchObject({ applied: false, reason: 'superseded', sessionAccepted: true });
    // 设备A 连续尾段观测 + 自然结束 final
    let eventSeq = 1;
    for (let position = 355.5; position <= 359.5 + 1e-9; position += 0.4) {
      ingestPlaying(rig, sessionA.sessionId, eventSeq, Number(position.toFixed(3)));
      eventSeq += 1;
    }
    rig.clock.advanceMs(25);
    const receipt = rig.finish.finish(scopeOf(rig, sessionA.sessionId), finishInputOf(2, 359.5));
    // superseded final 可 sessionAccepted/completed 而 historyApplied=false
    expect(receipt).toMatchObject({
      finalSessionAccepted: true,
      historyApplied: false,
      historyRevision: null,
      sessionCompleted: true,
      autoNextEligible: true,
      reason: 'completed',
      ended: true,
    });
    // 绝不把其完成写到另设备 owner 历史:writer/位置/revision 不变,completed 仍 0
    const after = historyRowOf(rig);
    expect(after).toMatchObject({
      writerPlaybackSessionId: sessionB.sessionId,
      positionSeconds: 300,
      revision: ownerHistory!.revision,
      completed: 0,
    });
    expect(historyRowCount(rig)).toBe(1);
    // 本会话 receipt 独立登记完成形态(completed 是会话观测结果)
    expect(receiptRowOf(rig, sessionA.sessionId)).toMatchObject({ sessionCompleted: 1, autoNextEligible: 1, historyApplied: 0, historyRevision: null });
  });
});

/* ------------------------------------------------------------------ */
/* 观测折叠(T057 flush × finish.rules;no_tail_observation 保守形态)        */
/* ------------------------------------------------------------------ */

describe('T058 · 观测折叠(按 event_seq 升序 flush;gap/断链保守 unknown)', () => {
  it('尾段 gap>3.2s → 重锚后末段不足 → no_tail_observation(final 先接受、历史照落、资格拒绝)', () => {
    const rig = openRig();
    const { sessionId } = createReadySession(rig);
    acceptStartedSample(rig, sessionId);
    ingestPlaying(rig, sessionId, 1, 358, 25);
    rig.clock.advanceMs(3_200); // gap>3s:单次真实间隔构造(T057 重锚;推进 0.4 可行隔离推进规则)
    ingestPlaying(rig, sessionId, 2, 358.4, 0);
    rig.clock.advanceMs(10);
    const receipt = rig.finish.finish(scopeOf(rig, sessionId), finishInputOf(2, 358.4));
    expect(receipt).toMatchObject({
      reason: 'no_tail_observation',
      finalSessionAccepted: true,
      historyApplied: true,
      sessionCompleted: false,
      autoNextEligible: false,
      positionSeconds: 358.4,
    });
    expect(receiptRowOf(rig, sessionId)).toMatchObject({ reason: 'no_tail_observation', sessionCompleted: 0 });
    expect(historyRowOf(rig)).toMatchObject({ positionSeconds: 358.4, completed: 0 });
  });

  it('final 链接断裂(观测止于 350,final 358 推进超界)→ no_tail_observation(缺末段形态,B6 镜像)', () => {
    const rig = openRig();
    const { sessionId } = createReadySession(rig);
    acceptStartedSample(rig, sessionId);
    let eventSeq = 1;
    for (let position = 348; position <= 350 + 1e-9; position += 0.4) {
      ingestPlaying(rig, sessionId, eventSeq, Number(position.toFixed(3)));
      eventSeq += 1;
    }
    rig.clock.advanceMs(25);
    const receipt = rig.finish.finish(scopeOf(rig, sessionId), finishInputOf(2, 358));
    expect(receipt).toMatchObject({
      reason: 'no_tail_observation',
      finalSessionAccepted: true,
      historyApplied: true,
      sessionCompleted: false,
      autoNextEligible: false,
      positionSeconds: 358,
    });
  });
});

/* ------------------------------------------------------------------ */
/* 事务内身份/归属闸(已授权不能替代重验;404 同形不泄露存在性)              */
/* ------------------------------------------------------------------ */

describe('T058 · 事务内身份/归属闸(finish 与 finishResult 同闸)', () => {
  it('身份重验:撤销 → 401 SESSION_INVALID;跨设备/旧上下文 → 404 同形(finish 与 finish-result 双面)', () => {
    const rig = openRig();
    const { sessionId } = createReadySession(rig);
    acceptStartedSample(rig, sessionId);
    const { receipt } = recordMidwayReceipt(rig, sessionId);
    const before = receiptRowOf(rig, sessionId);
    // 撤销身份(事务内重验;401 先于一切域级语义)
    rig.conn
      .prepare('UPDATE device_session SET revoked_at = ? WHERE id = ?')
      .run(iso(CLOCK_START_MS - 1000), rig.seed.deviceSessionId);
    expectDomainError(() => rig.finish.finish(scopeOf(rig, sessionId), finishInputOf(3, 359.5)), 401, 'SESSION_INVALID');
    expectDomainError(() => rig.finish.finishResult(scopeOf(rig, sessionId)), 401, 'SESSION_INVALID');
    rig.conn.prepare('UPDATE device_session SET revoked_at = NULL WHERE id = ?').run(rig.seed.deviceSessionId);
    // 跨设备(设备B 有效身份 × 设备A 会话)→ 404 同形
    expectDomainError(
      () => rig.finish.finish(scopeOf(rig, sessionId, rig.seed.secondDeviceSessionId), finishInputOf(3, 359.5)),
      404,
      'PLAYBACK_NOT_FOUND',
    );
    expectDomainError(
      () => rig.finish.finishResult(scopeOf(rig, sessionId, rig.seed.secondDeviceSessionId)),
      404,
      'PLAYBACK_NOT_FOUND',
    );
    // 旧上下文(A→B→A:contextVersion 递增后旧绑定不等)→ 404 同形,不泄露存在性
    rig.conn.prepare('UPDATE device_session SET profile_context_version = 2 WHERE id = ?').run(rig.seed.deviceSessionId);
    expectDomainError(() => rig.finish.finish(scopeOf(rig, sessionId), finishInputOf(3, 359.5)), 404, 'PLAYBACK_NOT_FOUND');
    expectDomainError(() => rig.finish.finishResult(scopeOf(rig, sessionId)), 404, 'PLAYBACK_NOT_FOUND');
    // 归属未被越权改动:receipt 原样
    expect(receiptRowOf(rig, sessionId)).toEqual(before);
    expect(receipt).toBeDefined();
  });
});

/* ------------------------------------------------------------------ */
/* digest 规范化(同 payload 重放基准;接收时刻不入摘要)                    */
/* ------------------------------------------------------------------ */

describe('T058 · finishRequestDigest 规范化(payload 不含接收时刻;键序固定)', () => {
  it('同 payload 恒等;position/seq/cause 任一差异即异摘要(operationKey 不入摘要,由幂等键承载)', () => {
    const base = { sampleSeq: 2, expectedGeneration: 1, positionSeconds: 359.5, cause: 'natural_end' };
    expect(finishRequestDigest(base)).toBe(finishRequestDigest({ ...base }));
    expect(finishRequestDigest(base)).not.toBe(finishRequestDigest({ ...base, positionSeconds: 359.6 }));
    expect(finishRequestDigest(base)).not.toBe(finishRequestDigest({ ...base, sampleSeq: 3 }));
    expect(finishRequestDigest(base)).not.toBe(finishRequestDigest({ ...base, cause: 'stopped_elsewhere' as never }));
    expect(finishRequestDigest(base)).toMatch(/^[0-9a-f]{64}$/);
  });
});
