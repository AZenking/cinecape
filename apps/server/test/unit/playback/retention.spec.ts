import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { createManualClock, MANUAL_CLOCK_DEFAULT_START_MS, type ManualClock } from '../../fixtures/clock';
import { Database } from '../../../src/database/database';
import { setEnvOverride } from '../../../src/config/env';
import { loadEnv } from '../../../src/config/env.schema';
import { createPlaybackBudgets, type PlaybackBudgets } from '../../../src/config/playback-budgets';
import { PlaybackRetentionService } from '../../../src/contexts/playback/application/playback-retention.service';

/**
 * 播放保留清理单元测试(T045,spec 004,US2b —— TDD 先行 RED 证据):
 *
 * 权威依据(先读后写):
 * - tasks.md T045:每日清理 30 天审计、过期票 24 小时内清理,活跃 session/转换不删、
 *   FK 父级 RESTRICT 不误删媒体身份;runRetention(now?) 可测入口 + 定时调度
 *   (对齐 lifecycle 的时钟/定时器模式 start/stopTimers)。
 * - data-model.md「验证与恢复」:审计保留 30 天后清理,避免删除目录身份;
 *   budgets.lifecycle.recordRetentionDays=30(数值唯一权威 T010 config.spec)。
 * - budgets.ticket.expiredRetentionSeconds=24h:过期票保留时长,此后随每日清理删除
 *   —— 过期判定语义与仓储既有 deleteExpiredTickets 一致(expires_at 严格早于
 *   now-保留期;仓储 API 面被 repository.spec 钉死,本服务经 getDb() 直查补充
 *   「活跃 session 的票不删」保护,不改仓储)。
 * - 边界口径:审计保留「30 天」= 存活满 30 天即清理(occurred_at <= now-30d 删,
 *   恰好 30 天删/29 天留);过期票「24 小时保留」= 过期未满 24h 保留,过期且超出
 *   24h 删除,恰好 24h 保留(严格 lt,与仓储既有语义同源,不改判定基准)。
 *
 * 夹具分层(对齐 lifecycle.spec):真实临时库(权威迁移 0001~0005)+ ManualClock;
 * 行以 raw SQL 直插(引用 seedGraph 身份图,复合 FK/CHECK 全满足)。
 */

/* ------------------------------------------------------------------ */
/* 夹具:临时库 + 预算 + 身份图(与 lifecycle.spec 同构)                   */
/* ------------------------------------------------------------------ */

interface RetentionRig {
  dataDir: string;
  budgets: PlaybackBudgets;
  clock: ManualClock;
  t0: number;
  retention: PlaybackRetentionService;
  seed: SeedIds;
}

interface SeedIds {
  householdId: string;
  accountId: string;
  profileId: string;
  deviceId: string;
  deviceSessionId: string;
  mediaId: string;
  playbackSourceId: string;
}

const rigs: RetentionRig[] = [];

function migrationSql(name: string): string {
  const migrationPath = path.join(process.cwd(), 'src/database/migrations', name, 'up.sql');
  if (!fs.existsSync(migrationPath)) {
    throw new Error(`未找到迁移文件 ${migrationPath} —— 本测试须以 apps/server 为工作目录运行`);
  }
  return fs.readFileSync(migrationPath, 'utf8');
}

function bootstrapRig(): RetentionRig {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hmp-playback-retention-'));
  setEnvOverride(
    loadEnv({
      NODE_ENV: 'test',
      DATA_DIR: dataDir,
      DB_FILENAME: `${randomUUID()}.hmp.db`,
    }),
  );
  Database.close();
  Database.db.exec('CREATE TABLE IF NOT EXISTS _migrations (name TEXT PRIMARY KEY NOT NULL, applied_at TEXT NOT NULL)');
  for (const name of ['0001_init', '0002_profile_policy', '0003_media_catalog', '0004_manual_epg_binding', '0005_playback', '0006_pc_experience']) {
    Database.db.transaction(() => {
      Database.db.exec(migrationSql(name));
      Database.db.prepare('INSERT INTO _migrations (name, applied_at) VALUES (?, ?)').run(name, new Date().toISOString());
    })();
  }
  const budgets = createPlaybackBudgets(loadEnv({ NODE_ENV: 'test' }));
  const clock = createManualClock();
  const retention = new PlaybackRetentionService({ budgets, clock });
  const rig: RetentionRig = {
    dataDir,
    budgets,
    clock,
    t0: MANUAL_CLOCK_DEFAULT_START_MS,
    retention,
    seed: seedGraph(),
  };
  rigs.push(rig);
  return rig;
}

function seedGraph(): SeedIds {
  const db = Database.db;
  const now = new Date().toISOString();
  const householdId = randomUUID();
  const accountId = randomUUID();
  const profileId = randomUUID();
  const deviceId = randomUUID();
  const deviceSessionId = randomUUID();
  const mediaId = randomUUID();
  const mediaSourceId = randomUUID();
  const sourceEntryId = randomUUID();
  const playbackSourceId = randomUUID();
  db.transaction(() => {
    db.prepare('INSERT INTO household (id, name, created_at) VALUES (?, ?, ?)').run(householdId, '保留清理测试家庭', now);
    db.prepare(
      'INSERT INTO account (id, household_id, username, username_normalized, password_hash, role, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    ).run(accountId, householdId, 'admin', 'admin', 'hash', 'owner', now);
    db.prepare(
      'INSERT INTO profile (id, household_id, account_id, name, type, is_default, status, failed_pin_count, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
    ).run(profileId, householdId, accountId, '主档案', 'adult', 0, 'active', 0, now);
    db.prepare('INSERT INTO device (id, household_id, type, created_at) VALUES (?, ?, ?, ?)').run(deviceId, householdId, 'tv', now);
    db.prepare(
      'INSERT INTO device_session (id, household_id, account_id, device_id, token_hash, expires_at, last_active_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    ).run(deviceSessionId, householdId, accountId, deviceId, `hash-${deviceSessionId}`, '2030-01-01T00:00:00.000Z', now, now);
    db.prepare(
      'INSERT INTO media_item (id, household_id, type, title, version, title_overridden, type_overridden, created_at, updated_at) VALUES (?, ?, ?, ?, 1, 0, 0, ?, ?)',
    ).run(mediaId, householdId, 'movie', '测试影片', now, now);
    db.prepare(
      'INSERT INTO media_source (id, household_id, kind, name, remote_url, root_key, relative_directory, private_access_approved, enabled, version, created_at, updated_at) VALUES (?, ?, ?, ?, NULL, ?, ?, 1, 1, 1, ?, ?)',
    ).run(mediaSourceId, householdId, 'nas', 'NAS 库', 'root', 'media', now, now);
    db.prepare(
      'INSERT INTO source_entry (id, household_id, source_id, identity_kind, identity_digest, media_id, present, first_seen_at, last_seen_at) VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?)',
    ).run(sourceEntryId, householdId, mediaSourceId, 'path', 'b'.repeat(64), mediaId, now, now);
    db.prepare(
      'INSERT INTO playback_source (id, household_id, source_id, source_entry_id, media_item_id, protocol, location, priority, requires_proxy, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, 100, 0, ?, ?)',
    ).run(playbackSourceId, householdId, mediaSourceId, sourceEntryId, mediaId, 'file', '/private/retention/seed', now, now);
  })();
  return { householdId, accountId, profileId, deviceId, deviceSessionId, mediaId, playbackSourceId };
}

/* ------------------------------------------------------------------ */
/* 夹具:行直插与计数                                                     */
/* ------------------------------------------------------------------ */

/** UTC ISO-8601(毫秒,Z) */
function iso(ms: number): string {
  return new Date(ms).toISOString();
}

/** 直插 failure_event(复合 FK/CHECK 由 schema 保证;stable_code 仅 CHECK 非空) */
function insertFailureEvent(input: {
  seed: SeedIds;
  occurredAt: string;
  mediaId?: string | null;
  profileId?: string | null;
  stableCode?: string;
  id?: string;
}): string {
  const id = input.id ?? randomUUID();
  Database.db
    .prepare(
      'INSERT INTO playback_failure_event (id, household_id, device_session_id, device_id, profile_id, media_id, occurred_at, stable_code) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    )
    .run(
      id,
      input.seed.householdId,
      input.seed.deviceSessionId,
      input.seed.deviceId,
      input.profileId === undefined ? input.seed.profileId : input.profileId,
      input.mediaId === undefined ? input.seed.mediaId : input.mediaId,
      input.occurredAt,
      input.stableCode ?? 'MEDIA_NOT_FOUND',
    );
  return id;
}

/** 直插指定状态 session(state=playing/ended;CHECK:活动态源/交付/started_at 非空,终态 ended_at 必填) */
function insertSession(input: { seed: SeedIds; state: 'playing' | 'ended'; at: string; id?: string }): string {
  const id = input.id ?? randomUUID();
  const source = input.state === 'playing' ? input.seed.playbackSourceId : input.seed.playbackSourceId;
  const startedAt = input.at;
  const endedAt = input.state === 'ended' ? input.at : null;
  Database.db
    .prepare(
      'INSERT INTO playback_session (id, household_id, device_session_id, device_id, profile_id, media_id, playback_source_id, state, delivery, generation, version, position_seconds, audio_track_id, subtitle_track_id, desired_paused, created_at, started_at, ended_at, last_heartbeat_at, failure_code) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 1, 0, NULL, NULL, 0, ?, ?, ?, ?, NULL)',
    )
    .run(id, input.seed.householdId, input.seed.deviceSessionId, input.seed.deviceId, input.seed.profileId, input.seed.mediaId, source, input.state, 'direct', input.at, startedAt, endedAt, input.at);
  return id;
}

/** 直插过期/有效票(token_hash 全局唯一以随机串保证) */
function insertTicket(input: { seed: SeedIds; sessionId: string; issuedAt: string; expiresAt: string; id?: string }): string {
  const id = input.id ?? randomUUID();
  Database.db
    .prepare(
      'INSERT INTO playback_ticket (id, household_id, session_id, token_hash, issued_at, expires_at, generation, revoked_at) VALUES (?, ?, ?, ?, ?, ?, 1, NULL)',
    )
    .run(id, input.seed.householdId, input.sessionId, `ticket-hash-${id}`, input.issuedAt, input.expiresAt);
  return id;
}

function countOf(table: 'playback_failure_event' | 'playback_ticket' | 'playback_session' | 'playback_conversion' | 'media_item'): number {
  const row = Database.db.prepare(`SELECT count(*) AS n FROM ${table}`).get() as { n: number };
  return row.n;
}

/** 排空微任务(ManualClock 唤醒后的定时链续体为异步) */
async function settleEvents(turns = 32): Promise<void> {
  for (let i = 0; i < turns; i += 1) {
    await Promise.resolve();
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
}

/** 每日节拍(每日清理;服务内常量,测试同值推进) */
const DAILY_INTERVAL_MS = 24 * 60 * 60 * 1000;

afterEach(async () => {
  while (rigs.length > 0) {
    const rig = rigs.pop();
    if (rig === undefined) {
      break;
    }
    rig.retention.stopTimers();
    Database.close();
    fs.rmSync(rig.dataDir, { recursive: true, force: true });
  }
  await settleEvents(4);
});

/* ------------------------------------------------------------------ */
/* T045 保留边界(TDD 先行:实现前本文件整体 RED)                          */
/* ------------------------------------------------------------------ */

describe('T045 审计(failure_event)30 天保留', () => {
  it('恰好 30 天删除、29 天保留、31 天删除(occurred_at <= now-30d 判定)', () => {
    const rig = bootstrapRig();
    const at31 = iso(rig.t0 - 31 * DAILY_INTERVAL_MS);
    const atExactly30 = iso(rig.t0 - 30 * DAILY_INTERVAL_MS);
    const at29 = iso(rig.t0 - 29 * DAILY_INTERVAL_MS);
    insertFailureEvent({ seed: rig.seed, occurredAt: at31 });
    insertFailureEvent({ seed: rig.seed, occurredAt: atExactly30 });
    const kept29 = insertFailureEvent({ seed: rig.seed, occurredAt: at29 });

    const outcome = rig.retention.runRetention(iso(rig.t0));

    expect(outcome.failureEventsDeleted).toBe(2);
    expect(outcome.expiredTicketsDeleted).toBe(0);
    expect(countOf('playback_failure_event')).toBe(1);
    const remaining = Database.db.prepare('SELECT id FROM playback_failure_event').all() as { id: string }[];
    expect(remaining.map((row) => row.id)).toEqual([kept29]);
  });

  it('空库安全:零行清理零删除不抛错', () => {
    const rig = bootstrapRig();
    const outcome = rig.retention.runRetention(iso(rig.t0));
    expect(outcome.failureEventsDeleted).toBe(0);
    expect(outcome.expiredTicketsDeleted).toBe(0);
  });
});

describe('T045 过期票 24 小时保留(budgets.ticket.expiredRetentionSeconds)', () => {
  it('过期未满 24h 保留、过期且超出 24h 删除、恰好 24h 保留(严格 lt,与仓储 deleteExpiredTickets 同判定)', () => {
    const rig = bootstrapRig();
    const endedSession = insertSession({ seed: rig.seed, state: 'ended', at: iso(rig.t0 - 2 * DAILY_INTERVAL_MS) });
    const beyond = insertTicket({
      seed: rig.seed,
      sessionId: endedSession,
      issuedAt: iso(rig.t0 - 2 * DAILY_INTERVAL_MS),
      expiresAt: iso(rig.t0 - 24 * 60 * 60 * 1000 - 60_000),
    });
    const exactlyAt = insertTicket({
      seed: rig.seed,
      sessionId: endedSession,
      issuedAt: iso(rig.t0 - 2 * DAILY_INTERVAL_MS),
      expiresAt: iso(rig.t0 - 24 * 60 * 60 * 1000),
    });
    const within = insertTicket({
      seed: rig.seed,
      sessionId: endedSession,
      issuedAt: iso(rig.t0 - 2 * DAILY_INTERVAL_MS),
      expiresAt: iso(rig.t0 - 24 * 60 * 60 * 1000 + 60_000),
    });

    const outcome = rig.retention.runRetention(iso(rig.t0));

    expect(outcome.expiredTicketsDeleted).toBe(1);
    const remaining = Database.db.prepare('SELECT id FROM playback_ticket').all() as { id: string }[];
    expect(remaining.map((row) => row.id).sort()).toEqual([exactlyAt, within].sort());
    expect(remaining.map((row) => row.id)).not.toContain(beyond);
  });

  it('活跃 session 的过期票不删;终态 session 的过期票删除;活跃 session/转换本体不受清理影响', () => {
    const rig = bootstrapRig();
    const playingSession = insertSession({ seed: rig.seed, state: 'playing', at: iso(rig.t0 - 3 * DAILY_INTERVAL_MS) });
    const endedSession = insertSession({ seed: rig.seed, state: 'ended', at: iso(rig.t0 - 3 * DAILY_INTERVAL_MS) });
    const activeSessionTicket = insertTicket({
      seed: rig.seed,
      sessionId: playingSession,
      issuedAt: iso(rig.t0 - 3 * DAILY_INTERVAL_MS),
      expiresAt: iso(rig.t0 - 25 * 60 * 60 * 1000),
    });
    const endedSessionTicket = insertTicket({
      seed: rig.seed,
      sessionId: endedSession,
      issuedAt: iso(rig.t0 - 3 * DAILY_INTERVAL_MS),
      expiresAt: iso(rig.t0 - 25 * 60 * 60 * 1000),
    });

    const outcome = rig.retention.runRetention(iso(rig.t0));

    expect(outcome.expiredTicketsDeleted).toBe(1);
    expect(countOf('playback_ticket')).toBe(1);
    const remaining = Database.db.prepare('SELECT id FROM playback_ticket').all() as { id: string }[];
    expect(remaining).toEqual([{ id: activeSessionTicket }]);
    expect(endedSessionTicket !== activeSessionTicket).toBe(true);
    // 活跃 session 本体不删(保留清理不触 playback_session/playback_conversion)
    expect(countOf('playback_session')).toBe(2);
    expect(countOf('playback_conversion')).toBe(0);
  });
});

describe('T045 failure_event 与 session 独立清理 / 父级身份不受影响 / 幂等', () => {
  it('陈旧 ended session 保留而同期 failure_event 删除(session 不在审计保留范围内,反向亦不误删)', () => {
    const rig = bootstrapRig();
    const staleAt = iso(rig.t0 - 40 * DAILY_INTERVAL_MS);
    const staleSession = insertSession({ seed: rig.seed, state: 'ended', at: staleAt });
    insertFailureEvent({ seed: rig.seed, occurredAt: staleAt });

    const outcome = rig.retention.runRetention(iso(rig.t0));

    expect(outcome.failureEventsDeleted).toBe(1);
    expect(outcome.expiredTicketsDeleted).toBe(0);
    expect(countOf('playback_failure_event')).toBe(0);
    // 40 天前的终态 session 保留:保留清理只针对审计与过期票,不触碰 session 行
    expect(countOf('playback_session')).toBe(1);
    const session = Database.db.prepare('SELECT id FROM playback_session').get() as { id: string };
    expect(session.id).toBe(staleSession);
  });

  it('FK RESTRICT 不误删媒体身份:删除引用媒体的陈旧 failure_event 后 media/source_entry/playback_source 父级原样保留', () => {
    const rig = bootstrapRig();
    insertFailureEvent({ seed: rig.seed, occurredAt: iso(rig.t0 - 35 * DAILY_INTERVAL_MS) });

    const outcome = rig.retention.runRetention(iso(rig.t0));

    expect(outcome.failureEventsDeleted).toBe(1);
    // 父级存在即不动:媒体身份行(media_item/source_entry/playback_source)全部保留
    expect(countOf('media_item')).toBe(1);
    expect(
      (Database.db.prepare('SELECT count(*) AS n FROM source_entry WHERE media_id = ?').get(rig.seed.mediaId) as { n: number }).n,
    ).toBe(1);
    expect(
      (Database.db.prepare('SELECT count(*) AS n FROM playback_source WHERE id = ?').get(rig.seed.playbackSourceId) as { n: number }).n,
    ).toBe(1);
  });

  it('幂等:连续两次 runRetention 第二次零删除、行集不变', () => {
    const rig = bootstrapRig();
    insertFailureEvent({ seed: rig.seed, occurredAt: iso(rig.t0 - 31 * DAILY_INTERVAL_MS) });
    const endedSession = insertSession({ seed: rig.seed, state: 'ended', at: iso(rig.t0 - DAILY_INTERVAL_MS) });
    insertTicket({
      seed: rig.seed,
      sessionId: endedSession,
      issuedAt: iso(rig.t0 - 31 * 60 * 60 * 1000),
      expiresAt: iso(rig.t0 - 30 * 60 * 60 * 1000),
    });

    const first = rig.retention.runRetention(iso(rig.t0));
    expect(first.failureEventsDeleted).toBe(1);
    expect(first.expiredTicketsDeleted).toBe(1);

    const second = rig.retention.runRetention(iso(rig.t0));
    expect(second.failureEventsDeleted).toBe(0);
    expect(second.expiredTicketsDeleted).toBe(0);
    expect(countOf('playback_failure_event')).toBe(0);
    expect(countOf('playback_ticket')).toBe(0);
  });
});

describe('T045 定时调度(start/stopTimers,lifecycle 同款时钟模式)', () => {
  it('start() 后按每日节拍自动清理;stopTimers() 后不再执行', async () => {
    const rig = bootstrapRig();
    const endedSession = insertSession({ seed: rig.seed, state: 'ended', at: iso(rig.t0 - DAILY_INTERVAL_MS) });
    insertFailureEvent({ seed: rig.seed, occurredAt: iso(rig.t0 - 31 * DAILY_INTERVAL_MS) });
    insertTicket({
      seed: rig.seed,
      sessionId: endedSession,
      issuedAt: iso(rig.t0 - 31 * 60 * 60 * 1000),
      expiresAt: iso(rig.t0 - 30 * 60 * 60 * 1000),
    });

    rig.retention.start();
    await rig.clock.advance(DAILY_INTERVAL_MS);
    await settleEvents();
    expect(countOf('playback_failure_event')).toBe(0);
    expect(countOf('playback_ticket')).toBe(0);

    // stopTimers 后:新过期行不再被清理
    rig.retention.stopTimers();
    insertFailureEvent({ seed: rig.seed, occurredAt: iso(rig.t0 - 32 * DAILY_INTERVAL_MS) });
    await rig.clock.advance(DAILY_INTERVAL_MS);
    await settleEvents();
    expect(countOf('playback_failure_event')).toBe(1);
  });

  it('单拍清理异常不中断定时链:下一拍继续清理', async () => {
    const rig = bootstrapRig();
    const endedSession = insertSession({ seed: rig.seed, state: 'ended', at: iso(rig.t0 - DAILY_INTERVAL_MS) });
    insertTicket({
      seed: rig.seed,
      sessionId: endedSession,
      issuedAt: iso(rig.t0 - 31 * 60 * 60 * 1000),
      expiresAt: iso(rig.t0 - 30 * 60 * 60 * 1000),
    });
    rig.retention.start();
    await rig.clock.advance(DAILY_INTERVAL_MS);
    await settleEvents();
    expect(countOf('playback_ticket')).toBe(0);

    // 第二拍再插陈旧审计行,推进后被同一定时链清理(链未因任何单拍异常/空拍中断)
    insertFailureEvent({ seed: rig.seed, occurredAt: iso(rig.t0 - 40 * DAILY_INTERVAL_MS) });
    await rig.clock.advance(DAILY_INTERVAL_MS);
    await settleEvents();
    expect(countOf('playback_failure_event')).toBe(0);
  });
});
