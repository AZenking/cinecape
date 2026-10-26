import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { Database } from '../../../src/database/database';
import { setEnvOverride } from '../../../src/config/env';
import { loadEnv } from '../../../src/config/env.schema';
import { createPlaybackBudgets, type PlaybackBudgets } from '../../../src/config/playback-budgets';
import {
  PLAYBACK_SESSION_TRANSITIONS,
  type PlaybackDelivery,
  type PlaybackErrorCode,
  type PlaybackOk,
  type PlaybackResult,
  type PlaybackSessionView,
} from '../../../src/modules/playback/playback.types';
import { PlaybackRepository } from '../../../src/modules/playback/playback.repository';

/**
 * 播放仓储单元测试(T011;data-model.md「## playback_session」「## playback_ticket」
 * 「## playback_conversion」「## playback_failure_event」四节 + tasks.md T011):
 *
 * - 终态不复活:ended/failed/interrupted 上任何状态迁移(heartbeat/ready/playing/paused/
 *   seek/字幕/stop/fail)均被拒绝且行零变化;终态 session 不可签发票;
 * - 状态机合法迁移表:preparing→ready(带 source/delivery)、ready→playing(started_at 一次
 *   且不重置)、playing↔paused、ready/playing/paused→preparing(generation+version 各+1)、
 *   纯字幕仅 version+1、活动态→终态(ended_at 必设);非法迁移(preparing→playing 直跳、
 *   ended→preparing)拒绝;
 * - CAS:expectedVersion 过期 → PLAYBACK_VERSION_CONFLICT 不部分写入;
 *   expectedGeneration 过期 → 签票路径 PLAYBACK_GENERATION_STALE 且不写票行;
 * - 并发不超额:以 createPlaybackBudgets 注入小额度 N=2,全局(跨家庭)reserved～stopping
 *   计数,第 N+1 次 reserve 返回 PLAYBACK_CONVERSION_BUSY;一个任务确认退出后可再 reserve;
 * - spawn 失败补偿:reserve→compensateRelease 额度账本恢复、无孤儿 reserved 行;
 *   reserve→补偿→reserve 幂等一致(补偿删除行,UNIQUE(household,session,generation) 槽位释放);
 * - 输入不可变:仓储不暴露任何修改 device_session/device/profile/media 绑定的方法
 *   (API 面断言 + 全生命周期迁移后身份列逐值不变;选择"无此 API"方案——
 *   data-model 明示绑定后不可改变,仓储层不提供改绑入口,状态机方法亦不接受这些入参);
 * - 不跨异步持事务:全部仓储方法为同步函数(better-sqlite3 同步驱动,事务体内不存在 await),
 *   且混合 reserve/释放/状态迁移高频循环无死锁、账本一致(无锁泄漏/脏状态)。
 *
 * 夹具:纯 DB(不经 Nest app),临时 DATA_DIR + 全部权威迁移 DDL(0001~0005)。
 */

interface DbRig {
  dataDir: string;
  repo: PlaybackRepository;
  budgets: PlaybackBudgets;
}

const rigs: DbRig[] = [];

/** UTC ISO-8601(毫秒,Z 结尾)形态 —— 全部入库时间必须符合 */
const ISO_UTC_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

function migrationSql(name: string): string {
  const migrationPath = path.join(process.cwd(), 'src/database/migrations', name, 'up.sql');
  if (!fs.existsSync(migrationPath)) {
    throw new Error(`未找到迁移文件 ${migrationPath} —— 本测试须以 apps/server 为工作目录运行`);
  }
  return fs.readFileSync(migrationPath, 'utf8');
}

function bootstrapRig(extraEnv: Record<string, string> = {}): DbRig {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hmp-playback-repo-'));
  setEnvOverride(
    loadEnv({
      NODE_ENV: 'test',
      DATA_DIR: dataDir,
      DB_FILENAME: `${randomUUID()}.hmp.db`,
      ...extraEnv,
    }),
  );
  Database.close();
  Database.db.exec('CREATE TABLE IF NOT EXISTS _migrations (name TEXT PRIMARY KEY NOT NULL, applied_at TEXT NOT NULL)');
  for (const name of ['0001_init', '0002_profile_policy', '0003_media_catalog', '0004_manual_epg_binding', '0005_playback']) {
    Database.db.transaction(() => {
      Database.db.exec(migrationSql(name));
      Database.db.prepare('INSERT INTO _migrations (name, applied_at) VALUES (?, ?)').run(name, new Date().toISOString());
    })();
  }
  // 转换并发上限注入小值 2(data-model:全局额度,reserve 短事务内计数)
  const budgets = createPlaybackBudgets(loadEnv({ NODE_ENV: 'test', PLAYBACK_CONVERSION_CONCURRENCY: '2' }));
  const rig: DbRig = { dataDir, repo: new PlaybackRepository(Database.db, budgets), budgets };
  rigs.push(rig);
  return rig;
}

async function cleanupRigs(): Promise<void> {
  while (rigs.length > 0) {
    const rig = rigs.pop();
    if (rig === undefined) {
      break;
    }
    Database.close();
    fs.rmSync(rig.dataDir, { recursive: true, force: true });
  }
}

/** 结果断言:ok 展开值;err 时失败并携带 code/detail 便于定位 */
function expectOk<T>(result: PlaybackResult<T>): T {
  expect(result.ok, JSON.stringify(result)).toBe(true);
  return (result as PlaybackOk<T>).value;
}

/** 结果断言:稳定失败码必须精确匹配 */
function expectErr<T>(result: PlaybackResult<T>, code: PlaybackErrorCode): void {
  expect(result.ok, JSON.stringify(result)).toBe(false);
  if (!result.ok) {
    expect(result.code).toBe(code);
  }
}

/** 种子身份图:家庭/账号/档案/设备/设备会话/媒体/NAS 源链(满足 0005 全部复合外键) */
interface SeedIds {
  householdId: string;
  accountId: string;
  profileId: string;
  deviceId: string;
  deviceSessionId: string;
  mediaId: string;
  playbackSourceId: string;
  altHouseholdId: string;
  altMediaId: string;
  altDeviceSessionId: string;
  altDeviceId: string;
  altProfileId: string;
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
  const altHouseholdId = randomUUID();
  const altMediaId = randomUUID();
  const altAccountId = randomUUID();
  const altDeviceId = randomUUID();
  const altDeviceSessionId = randomUUID();
  const altProfileId = randomUUID();
  db.transaction(() => {
    db.prepare('INSERT INTO household (id, name, created_at) VALUES (?, ?, ?)').run(householdId, '播放测试家庭', now);
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
      'INSERT INTO media_item (id, household_id, type, title, version, title_overridden, type_overridden, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
    ).run(mediaId, householdId, 'movie', '测试影片', 1, 0, 0, now, now);
    db.prepare(
      'INSERT INTO media_source (id, household_id, kind, name, remote_url, root_key, relative_directory, private_access_approved, enabled, version, created_at, updated_at) VALUES (?, ?, ?, ?, NULL, ?, ?, 1, 1, 1, ?, ?)',
    ).run(mediaSourceId, householdId, 'nas', 'NAS 库', 'root', 'media', now, now);
    db.prepare(
      'INSERT INTO source_entry (id, household_id, source_id, identity_kind, identity_digest, media_id, present, first_seen_at, last_seen_at) VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?)',
    ).run(sourceEntryId, householdId, mediaSourceId, 'path', 'a'.repeat(64), mediaId, now, now);
    db.prepare(
      'INSERT INTO playback_source (id, household_id, source_id, source_entry_id, media_item_id, protocol, location, priority, requires_proxy, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, 100, 0, ?, ?)',
    ).run(playbackSourceId, householdId, mediaSourceId, sourceEntryId, mediaId, 'file', '/private/seed/location', now, now);
    // 第二家庭:验证转换额度为全局(跨家庭)而非按家庭(独立身份图满足复合外键)
    db.prepare('INSERT INTO household (id, name, created_at) VALUES (?, ?, ?)').run(altHouseholdId, '第二家庭', now);
    db.prepare(
      'INSERT INTO account (id, household_id, username, username_normalized, password_hash, role, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    ).run(altAccountId, altHouseholdId, 'admin2', 'admin2', 'hash', 'owner', now);
    db.prepare(
      'INSERT INTO profile (id, household_id, account_id, name, type, is_default, status, failed_pin_count, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
    ).run(altProfileId, altHouseholdId, altAccountId, '第二档案', 'adult', 0, 'active', 0, now);
    db.prepare('INSERT INTO device (id, household_id, type, created_at) VALUES (?, ?, ?, ?)').run(altDeviceId, altHouseholdId, 'tv', now);
    db.prepare(
      'INSERT INTO device_session (id, household_id, account_id, device_id, token_hash, expires_at, last_active_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    ).run(altDeviceSessionId, altHouseholdId, altAccountId, altDeviceId, `hash-${altDeviceSessionId}`, '2030-01-01T00:00:00.000Z', now, now);
    db.prepare(
      'INSERT INTO media_item (id, household_id, type, title, version, title_overridden, type_overridden, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
    ).run(altMediaId, altHouseholdId, 'movie', '第二家庭影片', 1, 0, 0, now, now);
  })();
  return {
    householdId,
    accountId,
    profileId,
    deviceId,
    deviceSessionId,
    mediaId,
    playbackSourceId,
    altHouseholdId,
    altMediaId,
    altDeviceSessionId,
    altDeviceId,
    altProfileId,
  };
}

/** 直接读行(CHECK 之外最终以行值断言为准) */
interface SessionRow {
  id: string;
  household_id: string;
  device_session_id: string;
  device_id: string;
  profile_id: string;
  media_id: string;
  playback_source_id: string | null;
  state: string;
  delivery: string | null;
  generation: number;
  version: number;
  position_seconds: number;
  audio_track_id: string | null;
  subtitle_track_id: string | null;
  desired_paused: number;
  created_at: string;
  started_at: string | null;
  ended_at: string | null;
  last_heartbeat_at: string;
  failure_code: string | null;
}

function sessionRow(sessionId: string): SessionRow {
  const row = Database.db.prepare('SELECT * FROM playback_session WHERE id = ?').get(sessionId) as SessionRow | undefined;
  expect(row, `session ${sessionId} 应存在`).toBeDefined();
  return row as SessionRow;
}

function ticketRows(householdId: string, sessionId: string): unknown[] {
  return Database.db
    .prepare('SELECT * FROM playback_ticket WHERE household_id = ? AND session_id = ? ORDER BY issued_at, id')
    .all(householdId, sessionId);
}

function conversionRows(where = ''): Array<{ id: string; state: string; session_id: string; generation: number }> {
  return Database.db.prepare(`SELECT id, state, session_id, generation FROM playback_conversion ${where} ORDER BY id`).all() as Array<{
    id: string;
    state: string;
    session_id: string;
    generation: number;
  }>;
}

/** 建立 preparing session(新会话 generation=version=1) */
function newSession(rig: DbRig, ids: SeedIds, mediaId = ids.mediaId): PlaybackSessionView {
  return expectOk(
    rig.repo.createSession({
      householdId: ids.householdId,
      deviceSessionId: ids.deviceSessionId,
      deviceId: ids.deviceId,
      profileId: ids.profileId,
      mediaId,
    }),
  );
}

/** 建立 ready session(preparing→ready,签发 CAS 基准 v1/g1) */
function newReadySession(rig: DbRig, ids: SeedIds, delivery: PlaybackDelivery = 'remux'): PlaybackSessionView {
  const session = newSession(rig, ids);
  return expectOk(
    rig.repo.markReady(session.id, {
      cas: { expectedVersion: 1, expectedGeneration: 1 },
      playbackSourceId: ids.playbackSourceId,
      delivery,
    }),
  );
}

describe('T011 播放仓储:终态不复活', () => {
  let rig: DbRig;
  let ids: SeedIds;

  afterEach(async () => {
    await cleanupRigs();
  });

  it('三种终态上执行全部状态迁移方法均被拒绝且行零变化', () => {
    rig = bootstrapRig();
    ids = seedGraph();
    for (const terminal of ['ended', 'failed', 'interrupted'] as const) {
      const session = newSession(rig, ids);
      const before = sessionRow(session.id);
      const cas = { expectedVersion: before.version, expectedGeneration: before.generation };
      // 驱动至目标终态(集中终态守卫前先合法到达)
      if (terminal === 'ended') {
        expectOk(rig.repo.endSession(session.id, { cas }));
      } else if (terminal === 'failed') {
        expectOk(rig.repo.failSession(session.id, { cas, failureCode: 'PLAYBACK_FORMAT_UNSUPPORTED' }));
      } else {
        expectOk(rig.repo.markInterrupted(session.id, { cas }));
      }
      const terminalRow = sessionRow(session.id);
      expect(terminalRow.state).toBe(terminal);
      expect(terminalRow.ended_at, '终态必须设置 ended_at').not.toBeNull();

      // 终态后的每一次迁移尝试:全部拒绝(返回 err 且携带稳定码),行保持终态原值
      const attempts: Array<[string, PlaybackResult<PlaybackSessionView>]> = [
        ['heartbeat', rig.repo.heartbeat(session.id, { cas: { expectedVersion: terminalRow.version } })],
        ['markReady', rig.repo.markReady(session.id, { cas: { expectedVersion: terminalRow.version }, playbackSourceId: ids.playbackSourceId, delivery: 'remux' })],
        ['markPlaying', rig.repo.markPlaying(session.id, { cas: { expectedVersion: terminalRow.version } })],
        ['markPaused', rig.repo.markPaused(session.id, { cas: { expectedVersion: terminalRow.version } })],
        ['beginRebuild(seek)', rig.repo.beginRebuild(session.id, { cas: { expectedVersion: terminalRow.version }, positionSeconds: 30 })],
        ['applySubtitleSwitch', rig.repo.applySubtitleSwitch(session.id, { cas: { expectedVersion: terminalRow.version }, subtitleTrackId: 'sub-1' })],
        ['endSession(重复 stop)', rig.repo.endSession(session.id, { cas: { expectedVersion: terminalRow.version } })],
        ['failSession', rig.repo.failSession(session.id, { cas: { expectedVersion: terminalRow.version }, failureCode: 'PLAYBACK_RESOURCE_UNAVAILABLE' })],
        ['markInterrupted', rig.repo.markInterrupted(session.id, { cas: { expectedVersion: terminalRow.version } })],
      ];
      for (const [label, result] of attempts) {
        expect(result.ok, `${terminal} 上 ${label} 应被拒绝`).toBe(false);
      }
      const after = sessionRow(session.id);
      expect(after).toEqual(terminalRow); // 行零变化:不复活、不改写、不补时间戳
    }
  });

  it('终态与 preparing 的 session 不可签发票;ended 拒绝码为 PLAYBACK_ENDED', () => {
    rig = bootstrapRig();
    ids = seedGraph();
    const preparing = newSession(rig, ids);
    expectErr(
      rig.repo.issueTicket(preparing.id, {
        expectedGeneration: 1,
        tokenHash: `tok-${randomUUID()}`,
        ttlSeconds: rig.budgets.ticket.ttlSeconds,
      }),
      'PLAYBACK_NOT_READY',
    );
    expect(ticketRows(ids.householdId, preparing.id)).toHaveLength(0);

    const ended = newReadySession(rig, ids);
    expectOk(rig.repo.endSession(ended.id, { cas: { expectedVersion: ended.version } }));
    expectErr(
      rig.repo.issueTicket(ended.id, {
        expectedGeneration: 1,
        tokenHash: `tok-${randomUUID()}`,
        ttlSeconds: rig.budgets.ticket.ttlSeconds,
      }),
      'PLAYBACK_ENDED',
    );
    expect(ticketRows(ids.householdId, ended.id)).toHaveLength(0);

    const failed = newReadySession(rig, ids);
    expectOk(rig.repo.failSession(failed.id, { cas: { expectedVersion: failed.version }, failureCode: 'PLAYBACK_FORMAT_UNSUPPORTED' }));
    expectErr(
      rig.repo.issueTicket(failed.id, {
        expectedGeneration: 1,
        tokenHash: `tok-${randomUUID()}`,
        ttlSeconds: rig.budgets.ticket.ttlSeconds,
      }),
      'PLAYBACK_NOT_READY',
    );

    const interrupted = newReadySession(rig, ids);
    expectOk(rig.repo.markInterrupted(interrupted.id, { cas: { expectedVersion: interrupted.version } }));
    expectErr(
      rig.repo.issueTicket(interrupted.id, {
        expectedGeneration: 1,
        tokenHash: `tok-${randomUUID()}`,
        ttlSeconds: rig.budgets.ticket.ttlSeconds,
      }),
      'PLAYBACK_NOT_READY',
    );
    expect(ticketRows(ids.householdId, interrupted.id)).toHaveLength(0);
  });
});

describe('T011 播放仓储:状态机合法迁移表', () => {
  let rig: DbRig;
  let ids: SeedIds;

  afterEach(async () => {
    await cleanupRigs();
  });

  it('迁移表覆盖 data-model 全部合法边且终态为空', () => {
    expect(PLAYBACK_SESSION_TRANSITIONS.preparing).toEqual(['ready', 'failed', 'ended', 'interrupted']);
    expect([...PLAYBACK_SESSION_TRANSITIONS.ready].sort()).toEqual(['ended', 'failed', 'interrupted', 'paused', 'playing', 'preparing'].sort());
    expect([...PLAYBACK_SESSION_TRANSITIONS.playing].sort()).toEqual(['ended', 'failed', 'interrupted', 'paused', 'preparing'].sort());
    expect([...PLAYBACK_SESSION_TRANSITIONS.paused].sort()).toEqual(['ended', 'failed', 'interrupted', 'playing', 'preparing'].sort());
    expect(PLAYBACK_SESSION_TRANSITIONS.ended).toEqual([]);
    expect(PLAYBACK_SESSION_TRANSITIONS.failed).toEqual([]);
    expect(PLAYBACK_SESSION_TRANSITIONS.interrupted).toEqual([]);
  });

  it('preparing→ready:确定 source/delivery,不递增 version/generation,started_at 仍为空', () => {
    rig = bootstrapRig();
    ids = seedGraph();
    const session = newSession(rig, ids);
    expect(session.state).toBe('preparing');
    expect(session.generation).toBe(1);
    expect(session.version).toBe(1);
    expect(session.positionSeconds).toBe(0);
    expect(session.desiredPaused).toBe(false);
    expect(session.createdAt).toMatch(ISO_UTC_RE);
    expect(session.lastHeartbeatAt).toMatch(ISO_UTC_RE);
    expect(session.startedAt).toBeNull();
    expect(session.endedAt).toBeNull();

    const ready = expectOk(
      rig.repo.markReady(session.id, {
        cas: { expectedVersion: 1, expectedGeneration: 1 },
        playbackSourceId: ids.playbackSourceId,
        delivery: 'hls_proxy',
      }),
    );
    expect(ready.state).toBe('ready');
    expect(ready.delivery).toBe('hls_proxy');
    expect(ready.generation).toBe(1);
    expect(ready.version).toBe(1);
    expect(ready.startedAt).toBeNull();
    const row = sessionRow(session.id);
    expect(row.playback_source_id).toBe(ids.playbackSourceId);
  });

  it('ready→playing 设置 started_at 一次;playing↔paused 与 paused→playing 均不重置 started_at,且这些迁移不递增 version', () => {
    rig = bootstrapRig();
    ids = seedGraph();
    const ready = newReadySession(rig, ids);
    const playing = expectOk(rig.repo.markPlaying(ready.id, { cas: { expectedVersion: ready.version } }));
    expect(playing.state).toBe('playing');
    expect(playing.startedAt).toMatch(ISO_UTC_RE);
    const startedAt = playing.startedAt as string;

    const paused = expectOk(rig.repo.markPaused(playing.id, { cas: { expectedVersion: playing.version } }));
    expect(paused.state).toBe('paused');
    expect(paused.startedAt).toBe(startedAt);
    expect(paused.version).toBe(ready.version);

    const resumed = expectOk(rig.repo.markPlaying(paused.id, { cas: { expectedVersion: paused.version } }));
    expect(resumed.state).toBe('playing');
    expect(resumed.startedAt, 'started_at 一次设定后永不重置').toBe(startedAt);
    expect(resumed.version).toBe(ready.version);
    expect(resumed.generation).toBe(ready.generation);

    // ready→paused 亦为合法边(data-model:ready→playing/paused)
    const ready2 = newReadySession(rig, ids);
    const paused2 = expectOk(rig.repo.markPaused(ready2.id, { cas: { expectedVersion: ready2.version } }));
    expect(paused2.state).toBe('paused');
  });

  it('heartbeat 更新 last_heartbeat_at/position/desired_paused 且绝不递增 version/generation', () => {
    rig = bootstrapRig();
    ids = seedGraph();
    const ready = newReadySession(rig, ids);
    const playing = expectOk(rig.repo.markPlaying(ready.id, { cas: { expectedVersion: ready.version } }));
    const v = playing.version;
    const g = playing.generation;
    const hb = expectOk(
      rig.repo.heartbeat(playing.id, { cas: { expectedVersion: v }, positionSeconds: 12.5, desiredPaused: true }),
    );
    expect(hb.version).toBe(v);
    expect(hb.generation).toBe(g);
    expect(hb.positionSeconds).toBe(12.5);
    expect(hb.desiredPaused).toBe(true);
    expect(hb.lastHeartbeatAt >= playing.lastHeartbeatAt).toBe(true);
    const row = sessionRow(playing.id);
    expect(row.version).toBe(v);
    expect(row.last_heartbeat_at).toMatch(ISO_UTC_RE);
  });

  it('ready/playing/paused→preparing(seek/重建):generation+1 且 version+1,保留 desired_paused 与已设 source', () => {
    rig = bootstrapRig();
    ids = seedGraph();
    for (const from of ['ready', 'playing', 'paused'] as const) {
      const ready = newReadySession(rig, ids);
      if (from !== 'ready') {
        expectOk(rig.repo.markPlaying(ready.id, { cas: { expectedVersion: 1 } }));
        if (from === 'paused') {
          // markPaused 落下暂停意图(desired_paused=1),seek/重建必须保留
          expectOk(rig.repo.markPaused(ready.id, { cas: { expectedVersion: 1 } }));
        }
      }
      const before = sessionRow(ready.id);
      const rebuilt = expectOk(
        rig.repo.beginRebuild(ready.id, { cas: { expectedVersion: before.version, expectedGeneration: before.generation }, positionSeconds: 42 }),
      );
      expect(rebuilt.state).toBe('preparing');
      expect(rebuilt.generation).toBe(before.generation + 1);
      expect(rebuilt.version).toBe(before.version + 1);
      expect(rebuilt.positionSeconds).toBe(42);
      expect(rebuilt.desiredPaused).toBe(from === 'paused'); // 暂停意图跨重建保留(data-model:desired_paused)
      const row = sessionRow(ready.id);
      expect(row.playback_source_id, '同 session 跨 generation 源不变').toBe(ids.playbackSourceId);
      expect(row.started_at ?? null).toBe(before.started_at);
    }
  });

  it('纯字幕切换:仅 version+1,generation/状态/started_at 全不变', () => {
    rig = bootstrapRig();
    ids = seedGraph();
    const ready = newReadySession(rig, ids);
    const switched = expectOk(
      rig.repo.applySubtitleSwitch(ready.id, { cas: { expectedVersion: ready.version }, subtitleTrackId: 'sub-2' }),
    );
    expect(switched.state).toBe('ready');
    expect(switched.version).toBe(ready.version + 1);
    expect(switched.generation).toBe(ready.generation);
    expect(switched.subtitleTrackId).toBe('sub-2');
    const row = sessionRow(ready.id);
    expect(row.version).toBe(ready.version + 1);
    expect(row.generation).toBe(ready.generation);
  });

  it('活动态→ended/failed/interrupted:ended_at 必设;failed 的 failure_code 落库且为稳定码', () => {
    rig = bootstrapRig();
    ids = seedGraph();
    const ended = newSession(rig, ids);
    expectOk(rig.repo.endSession(ended.id, { cas: { expectedVersion: 1 } }));
    const endedRow = sessionRow(ended.id);
    expect(endedRow.state).toBe('ended');
    expect(endedRow.ended_at).toMatch(ISO_UTC_RE);
    expect(endedRow.failure_code).toBeNull();

    const failed = newReadySession(rig, ids);
    expectOk(rig.repo.failSession(failed.id, { cas: { expectedVersion: 1 }, failureCode: 'PLAYBACK_PREPARE_TIMEOUT' }));
    const failedRow = sessionRow(failed.id);
    expect(failedRow.state).toBe('failed');
    expect(failedRow.ended_at).toMatch(ISO_UTC_RE);
    expect(failedRow.failure_code).toBe('PLAYBACK_PREPARE_TIMEOUT');

    const interrupted = newReadySession(rig, ids);
    expectOk(rig.repo.markInterrupted(interrupted.id, { cas: { expectedVersion: 1 } }));
    const interruptedRow = sessionRow(interrupted.id);
    expect(interruptedRow.state).toBe('interrupted');
    expect(interruptedRow.ended_at).toMatch(ISO_UTC_RE);
    expect(interruptedRow.failure_code).toBeNull();
  });

  it('非法迁移拒绝:preparing→playing/paused 直跳、ready→ready、playing→ready、未知状态边', () => {
    rig = bootstrapRig();
    ids = seedGraph();
    const preparing = newSession(rig, ids);
    expectErr(rig.repo.markPlaying(preparing.id, { cas: { expectedVersion: 1 } }), 'PLAYBACK_NOT_READY');
    expectErr(rig.repo.markPaused(preparing.id, { cas: { expectedVersion: 1 } }), 'PLAYBACK_NOT_READY');
    expectErr(
      rig.repo.applySubtitleSwitch(preparing.id, { cas: { expectedVersion: 1 }, subtitleTrackId: 'sub' }),
      'PLAYBACK_NOT_READY',
    );
    const row = sessionRow(preparing.id);
    expect(row.state).toBe('preparing');
    expect(row.version).toBe(1);
    expect(row.generation).toBe(1);

    const ready = newReadySession(rig, ids);
    expectErr(rig.repo.markReady(ready.id, { cas: { expectedVersion: 1 }, playbackSourceId: ids.playbackSourceId, delivery: 'remux' }), 'PLAYBACK_NOT_READY');
    const playing = expectOk(rig.repo.markPlaying(ready.id, { cas: { expectedVersion: 1 } }));
    expectErr(rig.repo.markReady(playing.id, { cas: { expectedVersion: 1 }, playbackSourceId: ids.playbackSourceId, delivery: 'remux' }), 'PLAYBACK_NOT_READY');
    expect(sessionRow(playing.id).state).toBe('playing');
  });

  it('listActiveByDevice 仅返回活动态;getSession 未命中返回 PLAYBACK_NOT_FOUND', () => {
    rig = bootstrapRig();
    ids = seedGraph();
    const active = newSession(rig, ids);
    const done = newReadySession(rig, ids);
    expectOk(rig.repo.endSession(done.id, { cas: { expectedVersion: 1 } }));
    const list = rig.repo.listActiveByDevice(ids.householdId, ids.deviceId);
    expect(list.map((s) => s.id)).toEqual([active.id]);
    expectErr(rig.repo.getSession(ids.householdId, 'no-such-session'), 'PLAYBACK_NOT_FOUND');
  });
});

describe('T011 播放仓储:CAS 条件更新', () => {
  let rig: DbRig;
  let ids: SeedIds;

  afterEach(async () => {
    await cleanupRigs();
  });

  it('expectedVersion 过期:迁移拒绝为 PLAYBACK_VERSION_CONFLICT 且不部分写入', () => {
    rig = bootstrapRig();
    ids = seedGraph();
    const session = newSession(rig, ids);
    // 第一次迁移成功推进 version?markReady 不递增 version —— 用 beginRebuild 递增制造过期基准
    expectOk(rig.repo.markReady(session.id, { cas: { expectedVersion: 1, expectedGeneration: 1 }, playbackSourceId: ids.playbackSourceId, delivery: 'remux' }));
    const before = sessionRow(session.id);
    expectOk(rig.repo.beginRebuild(session.id, { cas: { expectedVersion: before.version, expectedGeneration: before.generation }, positionSeconds: 5 }));
    const staleRow = sessionRow(session.id);
    // 用旧 version(generation 亦过期)再迁移:必须整体拒绝,version/generation/state/position 无任何部分写入
    expectErr(
      rig.repo.markReady(session.id, {
        cas: { expectedVersion: before.version, expectedGeneration: before.generation },
        playbackSourceId: ids.playbackSourceId,
        delivery: 'direct',
      }),
      'PLAYBACK_VERSION_CONFLICT',
    );
    const after = sessionRow(session.id);
    expect(after).toEqual(staleRow);
    expect(after.position_seconds).toBe(5);
    expect(after.delivery).toBe('remux'); // 未被第二次 markReady 部分覆盖
  });

  it('expectedGeneration 过期:签票路径返回 PLAYBACK_GENERATION_STALE 且不写票行(短事务内比较)', () => {
    rig = bootstrapRig();
    ids = seedGraph();
    const session = newSession(rig, ids);
    expectOk(rig.repo.markReady(session.id, { cas: { expectedVersion: 1, expectedGeneration: 1 }, playbackSourceId: ids.playbackSourceId, delivery: 'remux' }));
    // seek 升 generation:1→2
    expectOk(rig.repo.beginRebuild(session.id, { cas: { expectedVersion: 1, expectedGeneration: 1 }, positionSeconds: 7 }));
    expectOk(rig.repo.markReady(session.id, { cas: { expectedVersion: 2, expectedGeneration: 2 }, playbackSourceId: ids.playbackSourceId, delivery: 'remux' }));
    // 用旧 generation 1 签票:拒绝且票表无行(即使 session 处于可签发的 ready 态)
    expectErr(
      rig.repo.issueTicket(session.id, {
        expectedGeneration: 1,
        tokenHash: `tok-${randomUUID()}`,
        ttlSeconds: rig.budgets.ticket.ttlSeconds,
      }),
      'PLAYBACK_GENERATION_STALE',
    );
    expect(ticketRows(ids.householdId, session.id)).toHaveLength(0);
    // 当前 generation 签票成功
    const ticket = expectOk(
      rig.repo.issueTicket(session.id, {
        expectedGeneration: 2,
        tokenHash: `tok-${randomUUID()}`,
        ttlSeconds: rig.budgets.ticket.ttlSeconds,
      }),
    );
    expect(ticket.generation).toBe(2);
    expect(ticket.expiresAt > ticket.issuedAt).toBe(true);
    expect(ticketRows(ids.householdId, session.id)).toHaveLength(1);
  });

  it('两个持有同一过期 version 的迁移只有一个能成功(串行 CAS 交错)', () => {
    rig = bootstrapRig();
    ids = seedGraph();
    const ready = newReadySession(rig, ids);
    const first = rig.repo.beginRebuild(ready.id, { cas: { expectedVersion: 1, expectedGeneration: 1 }, positionSeconds: 1 });
    const second = rig.repo.beginRebuild(ready.id, { cas: { expectedVersion: 1, expectedGeneration: 1 }, positionSeconds: 2 });
    expect(first.ok).toBe(true);
    expectErr(second, 'PLAYBACK_VERSION_CONFLICT');
    const row = sessionRow(ready.id);
    expect(row.generation).toBe(2);
    expect(row.version).toBe(2);
    expect(row.position_seconds).toBe(1); // 后到者未部分覆盖
  });
});

describe('T011 播放仓储:转换并发不超额(全局额度 N=2)', () => {
  let rig: DbRig;
  let ids: SeedIds;

  afterEach(async () => {
    await cleanupRigs();
  });

  function reserve(rig2: DbRig, seed: SeedIds, mediaId = seed.mediaId) {
    const session = newSession(rig2, seed, mediaId);
    return { session, result: rig2.repo.reserveConversion({
      householdId: seed.householdId,
      sessionId: session.id,
      generation: 1,
      mode: 'remux',
      outputVideoCodec: 'h264',
      outputAudioCodec: 'aac',
    }) };
  }

  it('连续 reserve 至 N=2 成功,第 3 次返回 PLAYBACK_CONVERSION_BUSY(跨家庭全局计数)', () => {
    rig = bootstrapRig();
    ids = seedGraph();
    const a = reserve(rig, ids);
    expectOk(a.result);
    // 第二家庭占用同一全局额度(独立设备会话/档案/媒体,满足复合外键)
    const bSeed = {
      ...ids,
      householdId: ids.altHouseholdId,
      deviceSessionId: ids.altDeviceSessionId,
      deviceId: ids.altDeviceId,
      profileId: ids.altProfileId,
      mediaId: ids.altMediaId,
    };
    const bSession = newSession(rig, bSeed);
    expectOk(
      rig.repo.reserveConversion({
        householdId: bSeed.householdId,
        sessionId: bSession.id,
        generation: 1,
        mode: 'video_transcode',
        outputVideoCodec: 'h264',
        outputAudioCodec: 'aac',
      }),
    );
    expect(a.session.id).not.toBe(bSession.id);
    expect(rig.repo.countActiveConversions()).toBe(2);
    // 第 3 个(新会话):满额,不排队直接忙
    const c = reserve(rig, ids);
    expectErr(c.result, 'PLAYBACK_CONVERSION_BUSY');
    expect(rig.repo.countActiveConversions()).toBe(2);
    expect(conversionRows().filter((r) => r.state === 'reserved')).toHaveLength(2);
  });

  it('一个任务确认退出(releaseOnExit→ended)后额度释放,可再次 reserve;direct 交付不建行不占额', () => {
    rig = bootstrapRig();
    ids = seedGraph();
    const a = reserve(rig, ids);
    const conv = expectOk(a.result);
    expectOk(
      rig.repo.markConversion(conv.id, { householdId: ids.householdId, conversionId: conv.id, state: 'starting' }),
    );
    // direct 交付:不建 conversion 行(不占额)
    const direct = newReadySession(rig, ids, 'direct');
    expect(direct.delivery).toBe('direct');
    expect(conversionRows()).toHaveLength(1);
    expect(rig.repo.countActiveConversions()).toBe(1);
    // 确认退出:starting→running→stopping 后 releaseOnExit(ended),额度立即恢复(终态不计入 reserved～stopping)
    for (const s of ['running', 'stopping'] as const) {
      expectOk(rig.repo.markConversion(conv.id, { householdId: ids.householdId, conversionId: conv.id, state: s }));
    }
    expectOk(rig.repo.releaseOnExit(conv.id, { finalState: 'ended' }));
    expect(rig.repo.countActiveConversions()).toBe(0);
    const again = reserve(rig, ids);
    expectOk(again.result);
  });

  it('markConversion 状态机:reserved→starting 设 started_at,stopping→ended 设 ended_at,非法转换拒绝', () => {
    rig = bootstrapRig();
    ids = seedGraph();
    const { result } = reserve(rig, ids);
    const conv = expectOk(result);
    expect(conv.state).toBe('reserved');
    expectErr(
      rig.repo.markConversion(conv.id, { householdId: ids.householdId, conversionId: conv.id, state: 'running' }),
      'PLAYBACK_NOT_READY',
    );
    const starting = expectOk(
      rig.repo.markConversion(conv.id, { householdId: ids.householdId, conversionId: conv.id, state: 'starting' }),
    );
    expect(starting.state).toBe('starting');
    expect(starting.startedAt).toMatch(ISO_UTC_RE);
    expectOk(rig.repo.markConversion(conv.id, { householdId: ids.householdId, conversionId: conv.id, state: 'running' }));
    expectOk(rig.repo.markConversion(conv.id, { householdId: ids.householdId, conversionId: conv.id, state: 'stopping' }));
    const ended = expectOk(rig.repo.releaseOnExit(conv.id, { finalState: 'ended' }));
    expect(ended.state).toBe('ended');
    expect(ended.endedAt).toMatch(ISO_UTC_RE);
    expect(rig.repo.countActiveConversions()).toBe(0);
  });
});

describe('T011 播放仓储:spawn 失败补偿', () => {
  let rig: DbRig;
  let ids: SeedIds;

  afterEach(async () => {
    await cleanupRigs();
  });

  function reserveOne(rig2: DbRig, seed: SeedIds) {
    const session = newSession(rig2, seed);
    return {
      session,
      result: rig2.repo.reserveConversion({
        householdId: seed.householdId,
        sessionId: session.id,
        generation: 1,
        mode: 'remux',
        outputVideoCodec: 'h264',
        outputAudioCodec: 'aac',
      }),
    };
  }

  it('reserve→compensateRelease:额度账本恢复、无孤儿 reserved 行', () => {
    rig = bootstrapRig();
    ids = seedGraph();
    expect(rig.repo.countActiveConversions()).toBe(0);
    const { result } = reserveOne(rig, ids);
    const conv = expectOk(result);
    expect(rig.repo.countActiveConversions()).toBe(1);
    const compensated = expectOk(rig.repo.compensateRelease(ids.householdId, conv.id));
    expect(compensated.deleted).toBe(true);
    expect(rig.repo.countActiveConversions()).toBe(0);
    expect(conversionRows()).toHaveLength(0); // 无孤儿 reserved 行
  });

  it('reserve→补偿→reserve 幂等一致;重复补偿为无副作用 no-op', () => {
    rig = bootstrapRig();
    ids = seedGraph();
    const first = reserveOne(rig, ids);
    const conv1 = expectOk(first.result);
    expectOk(rig.repo.compensateRelease(ids.householdId, conv1.id));
    // 同 (household,session,generation) 再次 reserve 成功(补偿删除行,UNIQUE 槽位已释放)
    const second = rig.repo.reserveConversion({
      householdId: ids.householdId,
      sessionId: first.session.id,
      generation: 1,
      mode: 'remux',
      outputVideoCodec: 'h264',
      outputAudioCodec: 'aac',
    });
    const conv2 = expectOk(second);
    expect(conv2.id).not.toBe(conv1.id);
    expect(rig.repo.countActiveConversions()).toBe(1);
    // 重复补偿:行已不在,no-op 成功,账本不变
    expectOk(rig.repo.compensateRelease(ids.householdId, conv1.id));
    expect(rig.repo.countActiveConversions()).toBe(1);
    expect(conversionRows()).toHaveLength(1);
    // 已实际启动的任务不可被补偿误删(仅 reserved~starting 且未成功启动可补偿)
    expectOk(rig.repo.markConversion(conv2.id, { householdId: ids.householdId, conversionId: conv2.id, state: 'starting' }));
    const late = expectOk(rig.repo.compensateRelease(ids.householdId, conv2.id));
    expect(late.deleted).toBe(false);
    expect(conversionRows()).toHaveLength(1);
  });
});

describe('T011 播放仓储:输入不可变', () => {
  let rig: DbRig;
  let ids: SeedIds;

  afterEach(async () => {
    await cleanupRigs();
  });

  it('仓储不暴露修改 device_session/device/profile/media 绑定的任何 API(选择"无此 API"方案)', () => {
    rig = bootstrapRig();
    ids = seedGraph();
    // 预期 API 面:除 createSession 外,一切会话方法都不接受/不触碰身份绑定四列;
    // 此断言同时锁死"未来也不得悄悄加入改绑方法"——新增方法必须显式更新本清单并说明。
    const api = Object.getOwnPropertyNames(PlaybackRepository.prototype)
      .filter((name) => name !== 'constructor')
      .sort();
    expect(api).toEqual(
      [
        'applySubtitleSwitch',
        'beginRebuild',
        'compensateRelease',
        'countActiveConversions',
        'createSession',
        'deleteExpiredTickets',
        'endSession',
        'failSession',
        'getSession',
        'heartbeat',
        'issueTicket',
        'listActiveByDevice',
        'markConversion',
        'markInterrupted',
        'markPaused',
        'markPlaying',
        'markReady',
        'recordFailureEvent',
        'releaseOnExit',
        'reserveConversion',
        'revokeTicket',
      ].sort(),
    );
  });

  it('全生命周期迁移后 device_session/device/profile/media 身份列逐值不变', () => {
    rig = bootstrapRig();
    ids = seedGraph();
    const session = newSession(rig, ids);
    const identity = () => {
      const row = sessionRow(session.id);
      return [row.device_session_id, row.device_id, row.profile_id, row.media_id] as const;
    };
    const original = identity();
    expectOk(rig.repo.markReady(session.id, { cas: { expectedVersion: 1, expectedGeneration: 1 }, playbackSourceId: ids.playbackSourceId, delivery: 'remux' }));
    expect(identity()).toEqual(original);
    expectOk(rig.repo.markPlaying(session.id, { cas: { expectedVersion: 1 } }));
    expect(identity()).toEqual(original);
    expectOk(rig.repo.heartbeat(session.id, { cas: { expectedVersion: 1 }, positionSeconds: 9 }));
    expect(identity()).toEqual(original);
    expectOk(rig.repo.beginRebuild(session.id, { cas: { expectedVersion: 1, expectedGeneration: 1 }, positionSeconds: 10 }));
    expect(identity()).toEqual(original);
    // 重建后回到 ready(generation 已升至 2),再做纯字幕切换(version 升至 3)
    expectOk(rig.repo.markReady(session.id, { cas: { expectedVersion: 2, expectedGeneration: 2 }, playbackSourceId: ids.playbackSourceId, delivery: 'remux' }));
    expect(identity()).toEqual(original);
    expectOk(rig.repo.applySubtitleSwitch(session.id, { cas: { expectedVersion: 2 }, subtitleTrackId: 'sub-9' }));
    expect(identity()).toEqual(original);
    expectOk(rig.repo.endSession(session.id, { cas: { expectedVersion: 3 } }));
    expect(identity()).toEqual(original);
  });
});

describe('T011 播放仓储:不跨异步持事务', () => {
  let rig: DbRig;
  let ids: SeedIds;

  afterEach(async () => {
    await cleanupRigs();
  });

  it('全部仓储方法为同步函数:无 AsyncFunction、调用结果非 Promise(短事务结构证明)', () => {
    rig = bootstrapRig();
    ids = seedGraph();
    const proto = PlaybackRepository.prototype as unknown as Record<string, unknown>;
    for (const name of Object.getOwnPropertyNames(PlaybackRepository.prototype)) {
      if (name === 'constructor') continue;
      const fn = proto[name] as (...args: unknown[]) => unknown;
      expect(fn.constructor.name, `${name} 必须为同步函数(事务体内不得 await)`).not.toBe('AsyncFunction');
    }
    // 抽样运行时验证:reserve / heartbeat 返回值非 thenable
    const session = newSession(rig, ids);
    expect(rig.repo.heartbeat(session.id, { cas: { expectedVersion: 1 } })).not.toBeInstanceOf(Promise);
    expect(
      rig.repo.reserveConversion({
        householdId: ids.householdId,
        sessionId: session.id,
        generation: 1,
        mode: 'remux',
        outputVideoCodec: 'h264',
        outputAudioCodec: 'aac',
      }),
    ).not.toBeInstanceOf(Promise);
  });

  it('高频交替 reserve/补偿/状态迁移循环:无死锁、无脏状态、账本最终一致', () => {
    rig = bootstrapRig();
    ids = seedGraph();
    const session = newSession(rig, ids);
    expectOk(rig.repo.markReady(session.id, { cas: { expectedVersion: 1, expectedGeneration: 1 }, playbackSourceId: ids.playbackSourceId, delivery: 'remux' }));
    let version = 1;
    let generation = 1;
    for (let i = 0; i < 60; i += 1) {
      // seek(升 v+g,回 ready) 与 纯字幕(升 v) 交替,每次都以上一步的新值作 CAS 基准(短事务串行语义)
      if (i % 2 === 0) {
        expectOk(rig.repo.beginRebuild(session.id, { cas: { expectedVersion: version, expectedGeneration: generation }, positionSeconds: i }));
        generation += 1;
        version += 1;
        expectOk(
          rig.repo.markReady(session.id, {
            cas: { expectedVersion: version, expectedGeneration: generation },
            playbackSourceId: ids.playbackSourceId,
            delivery: 'remux',
          }),
        );
      } else {
        expectOk(rig.repo.applySubtitleSwitch(session.id, { cas: { expectedVersion: version }, subtitleTrackId: `sub-${i}` }));
        version += 1;
      }
      // 同一循环内反复 reserve/补偿:额度账本最终归零,无孤儿行
      const reserved = expectOk(
        rig.repo.reserveConversion({
          householdId: ids.householdId,
          sessionId: session.id,
          generation,
          mode: 'remux',
          outputVideoCodec: 'h264',
          outputAudioCodec: 'aac',
        }),
      );
      expect(rig.repo.countActiveConversions()).toBe(1);
      expectOk(rig.repo.compensateRelease(ids.householdId, reserved.id));
      expect(rig.repo.countActiveConversions()).toBe(0);
    }
    const row = sessionRow(session.id);
    expect(row.version).toBe(version);
    expect(row.generation).toBe(generation);
    expect(conversionRows()).toHaveLength(0);
  });
});

describe('T011 播放仓储:failure_event 与票据清理支撑', () => {
  let rig: DbRig;
  let ids: SeedIds;

  afterEach(async () => {
    await cleanupRigs();
  });

  it('recordFailureEvent 仅接受稳定码,落库 occurred_at 为 UTC ISO;非法码被拒绝', () => {
    rig = bootstrapRig();
    ids = seedGraph();
    const event = expectOk(
      rig.repo.recordFailureEvent({
        householdId: ids.householdId,
        deviceSessionId: ids.deviceSessionId,
        deviceId: ids.deviceId,
        profileId: ids.profileId,
        mediaId: ids.mediaId,
        stableCode: 'PLAYBACK_FORMAT_UNSUPPORTED',
      }),
    );
    expect(event.occurredAt).toMatch(ISO_UTC_RE);
    const row = Database.db.prepare('SELECT * FROM playback_failure_event WHERE id = ?').get(event.id) as {
      stable_code: string;
      media_id: string | null;
    };
    expect(row.stable_code).toBe('PLAYBACK_FORMAT_UNSUPPORTED');
    // media_id 可空(媒体不可见时不存客户端原始目标 ID)
    expectOk(
      rig.repo.recordFailureEvent({
        householdId: ids.householdId,
        deviceSessionId: ids.deviceSessionId,
        deviceId: ids.deviceId,
        stableCode: 'PLAYBACK_RESOURCE_UNAVAILABLE',
      }),
    );
    expect(() =>
      rig.repo.recordFailureEvent({
        householdId: ids.householdId,
        deviceSessionId: ids.deviceSessionId,
        deviceId: ids.deviceId,
        // @ts-expect-error 故意传入非稳定码,验证仓储拒绝
        stableCode: 'TOTALLY_NOT_STABLE',
      }),
    ).toThrowError(/稳定失败码/);
  });

  it('revokeTicket 撤销后 revoked_at 落库;deleteExpiredTickets 只清超保留期的过期票', () => {
    rig = bootstrapRig();
    ids = seedGraph();
    const ready = newReadySession(rig, ids);
    const token = `tok-${randomUUID()}`;
    expectOk(rig.repo.issueTicket(ready.id, { expectedGeneration: 1, tokenHash: token, ttlSeconds: rig.budgets.ticket.ttlSeconds }));
    const rows = ticketRows(ids.householdId, ready.id) as Array<{ id: string; revoked_at: string | null; token_hash: string }>;
    expect(rows).toHaveLength(1);
    const ticket = rows[0];
    if (ticket === undefined) {
      throw new Error('票行应存在');
    }
    expectOk(rig.repo.revokeTicket(ids.householdId, ticket.id));
    expect((Database.db.prepare('SELECT revoked_at FROM playback_ticket WHERE id = ?').get(ticket.id) as { revoked_at: string | null }).revoked_at).toMatch(ISO_UTC_RE);

    // 清理:新票 + 已超保留期(24h)的旧票,只清旧票
    const oldToken = `tok-old-${randomUUID()}`;
    const oldIssued = '2020-01-01T00:00:00.000Z';
    Database.db
      .prepare(
        'INSERT INTO playback_ticket (id, household_id, session_id, token_hash, issued_at, expires_at, generation) VALUES (?, ?, ?, ?, ?, ?, ?)',
      )
      .run(randomUUID(), ids.householdId, ready.id, oldToken, oldIssued, '2020-01-01T00:05:00.000Z', 1);
    const removed = rig.repo.deleteExpiredTickets({ now: new Date().toISOString(), retentionSeconds: rig.budgets.ticket.expiredRetentionSeconds });
    expect(removed).toBe(1);
    expect(Database.db.prepare('SELECT id FROM playback_ticket WHERE token_hash = ?').get(oldToken)).toBeUndefined();
    expect(ticketRows(ids.householdId, ready.id)).toHaveLength(1); // 新票未过期,保留
  });
});
