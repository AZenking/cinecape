import 'reflect-metadata';
import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { Database } from '@platform/database/database';
import { cleanupRigs, startFreshApp, type TestRig } from '../helpers';

/**
 * T006(004-playback-resolver · Phase 2 Foundational,TDD 先行失败测试):
 * 0005_playback 迁移升级/回滚/备份恢复契约。
 *
 * 权威依据(字段/约束唯一权威):
 * - docs/specs/004-playback-resolver/data-model.md「## playback_session」「## playback_ticket」
 *   「## playback_conversion」「## playback_failure_event」四节 + 「## 验证与恢复」节
 *   (0005 up 对原表数据零修改;down 删除本阶段表及索引;up/down/up 演练及备份恢复语义);
 * - docs/specs/004-playback-resolver/tasks.md T006 条目;
 * - 写法参照 test/contract/policy-migration.e2e-spec.ts 与 manual-epg-migration.e2e-spec.ts,
 *   夹具复用 test/helpers.ts 的 startFreshApp/cleanupRigs(migrations 选项 + 临时 DATA_DIR)。
 *
 * RED 约定:0005_playback 迁移目录由 T007/T008 落地;在其存在之前本文件全部用例必须失败
 * (未找到 src/platform/database/migrations/0005_playback/up.sql)。本测试不实现迁移本身。
 *
 * 全部用例只用 os.tmpdir 临时 DATA_DIR,不触碰用户库;afterEach cleanupRigs()。
 *
 * 结构断言口径(data-model.md 为唯一权威,故):
 * - 列集合/NOT NULL/默认值按四节逐列断言(PRAGMA table_info;唯一注明的默认值仅
 *   desired_paused=false、cleanup_state='pending'、bytes_on_disk=0);
 * - 查询索引(data-model 只规定列集,不规定名称)按 PRAGMA index_list/index_info 列集匹配;
 * - 复合外键目标唯一索引沿用本仓 0002/0003 一贯命名约定 <table>_household_id_id_key,
 *   按名称断言(playback_session_household_id_id_key、device_household_id_id_key);
 * - 复合外键按 PRAGMA foreign_key_list 断言 (household_id, <列>) → <表>(household_id, id)
 *   (data-model 首节硬约束:「所有新表显式 household_id;FK 通过 (household_id,id) 约束同家庭」)。
 */

const MIGRATION = '0005_playback';
/** 阶段 3 完整形态库:仅应用 0001~0004(不含 0005),再以 0005 up/down 做升级/回滚矩阵 */
const STAGE3_MIGRATIONS: string[] = [
  '0001_init',
  '0002_profile_policy',
  '0003_media_catalog',
  '0004_manual_epg_binding',
];

const PLAYBACK_TABLES = [
  'playback_session',
  'playback_ticket',
  'playback_conversion',
  'playback_failure_event',
] as const;

/* 固定时刻(UTC ISO-8601,字符串序即时间序),保证夹具与快照确定性 */
const T0 = '2026-10-23T08:00:00.000Z';
const T1 = '2026-10-23T08:05:00.000Z';
const T2 = '2026-10-23T08:10:00.000Z';
const FAR_FUTURE = '2027-01-01T00:00:00.000Z';

function sha256(input: string): string {
  return createHash('sha256').update(input).digest('hex');
}

/* ------------------------------------------------------------------ */
/* 迁移应用/回滚(与 migrate.ts 同语义:DDL 与版本记录同事务)           */
/* ------------------------------------------------------------------ */

function migrationSql(name: string, file: 'up.sql' | 'down.sql'): string {
  const p = path.join(process.cwd(), 'src/platform/database/migrations', name, file);
  if (!fs.existsSync(p)) {
    throw new Error(`未找到迁移文件 ${p} —— T007/T008 应创建 src/platform/database/migrations/${name}/${file}(T006 为先行的失败测试)`);
  }
  return fs.readFileSync(p, 'utf8');
}

function applyPlayback(): void {
  const conn = Database.db;
  conn.transaction(() => {
    conn.exec(migrationSql(MIGRATION, 'up.sql'));
    conn.prepare('INSERT INTO _migrations (name, applied_at) VALUES (?, ?)').run(MIGRATION, new Date().toISOString());
  })();
}

function rollbackPlayback(): void {
  const conn = Database.db;
  conn.transaction(() => {
    conn.exec(migrationSql(MIGRATION, 'down.sql'));
    conn.prepare('DELETE FROM _migrations WHERE name = ?').run(MIGRATION);
  })();
}

function appliedMigrations(): string[] {
  return (Database.db.prepare('SELECT name FROM _migrations ORDER BY name').all() as { name: string }[]).map(
    (row) => row.name,
  );
}

/* ------------------------------------------------------------------ */
/* 阶段 3 夹具:0001~0004 形态库上的最小代表行(直写 SQL,不经 HTTP)     */
/* ------------------------------------------------------------------ */

interface Stage3Fixture {
  householdAId: string;
  householdBId: string;
  accountId: string;
  accountBId: string;
  adultWithPinId: string;
  childId: string;
  adultBId: string;
  deviceId: string;
  deviceBId: string;
  sessionAId: string;
  sessionBId: string;
  iptvSourceId: string;
  epgSourceId: string;
  mediaId: string;
  mediaBId: string;
  entryId: string;
  xmltvChannelId: string;
  playbackSourceId: string;
}

/**
 * 直写身份/PIN/策略/目录/EPG 最小代表行(家庭甲为主,家庭乙仅作跨家庭负向引用目标):
 * household/account/profile(含 PIN 哈希)/device/device_session/profile_policy(自定义值)/
 * parent_verification_state/catalog_state/media_source(iptv+epg)/media_item/source_entry/
 * playback_source/epg_channel/epg_programme/manual_epg_binding。
 */
function injectStage3(): Stage3Fixture {
  const ids: Stage3Fixture = {
    householdAId: randomUUID(),
    householdBId: randomUUID(),
    accountId: randomUUID(),
    accountBId: randomUUID(),
    adultWithPinId: randomUUID(),
    childId: randomUUID(),
    adultBId: randomUUID(),
    deviceId: randomUUID(),
    deviceBId: randomUUID(),
    sessionAId: randomUUID(),
    sessionBId: randomUUID(),
    iptvSourceId: randomUUID(),
    epgSourceId: randomUUID(),
    mediaId: randomUUID(),
    mediaBId: randomUUID(),
    entryId: randomUUID(),
    xmltvChannelId: 'cctv-1',
    playbackSourceId: randomUUID(),
  };
  const db = Database.db;
  const insertHousehold = db.prepare(
    'INSERT INTO household (id, name, default_language, timezone, created_at) VALUES (?, ?, ?, ?, ?)',
  );
  insertHousehold.run(ids.householdAId, '播放迁移家庭甲', 'zh-CN', 'Asia/Shanghai', T0);
  insertHousehold.run(ids.householdBId, '播放迁移家庭乙', 'zh-CN', 'Asia/Shanghai', T0);
  const insertAccount = db.prepare(
    'INSERT INTO account (id, household_id, username, username_normalized, password_hash, role, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
  );
  insertAccount.run(ids.accountId, ids.householdAId, 'player', 'player', '$argon2id$fixture-hash', 'owner', T0);
  insertAccount.run(ids.accountBId, ids.householdBId, 'neighbor', 'neighbor', '$argon2id$fixture-hash-b', 'owner', T0);
  const insertProfile = db.prepare(
    'INSERT INTO profile (id, household_id, account_id, name, avatar, type, is_default, pin_hash, status, failed_pin_count, pin_locked_until, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
  );
  insertProfile.run(ids.adultWithPinId, ids.householdAId, ids.accountId, '有码家长', null, 'adult', 1, '$argon2id$pin-migration', 'active', 0, null, T0);
  insertProfile.run(ids.childId, ids.householdAId, ids.accountId, '儿童', null, 'child', 0, null, 'active', 0, null, T0);
  insertProfile.run(ids.adultBId, ids.householdBId, ids.accountBId, '邻家成人', null, 'adult', 1, '$argon2id$pin-b', 'active', 0, null, T0);
  const insertDevice = db.prepare(
    'INSERT INTO device (id, household_id, name, type, last_seen_at, revoked_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
  );
  insertDevice.run(ids.deviceId, ids.householdAId, '客厅电视', 'tv', T0, null, T0);
  insertDevice.run(ids.deviceBId, ids.householdBId, '邻家设备', 'web', T0, null, T0);
  const insertSession = db.prepare(
    'INSERT INTO device_session (id, household_id, account_id, device_id, token_hash, active_profile_id, expires_at, revoked_at, last_active_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
  );
  insertSession.run(ids.sessionAId, ids.householdAId, ids.accountId, ids.deviceId, 'tok-session-a', ids.adultWithPinId, FAR_FUTURE, null, T0, T0);
  insertSession.run(ids.sessionBId, ids.householdBId, ids.accountBId, ids.deviceBId, 'tok-session-b', ids.adultBId, FAR_FUTURE, null, T0, T0);
  // 策略(自定义值,证明 0005 全程逐值不动;非默认回填值以便快照比对有意义)
  const insertPolicy = db.prepare(
    'INSERT INTO profile_policy (household_id, profile_id, max_content_level, allow_unrated, allowed_media_ids, blocked_media_ids, allowed_channel_ids, version, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
  );
  insertPolicy.run(ids.householdAId, ids.adultWithPinId, 18, 1, '["media-allowed"]', '[]', '[]', 3, T0);
  insertPolicy.run(ids.householdAId, ids.childId, 7, 0, '[]', '["media-blocked"]', '[]', 4, T0);
  insertPolicy.run(ids.householdBId, ids.adultBId, 16, 1, '[]', '[]', '[]', 2, T0);
  db.prepare(
    'INSERT INTO parent_verification_state (household_id, account_id, failed_attempts, locked_until) VALUES (?, ?, ?, ?)',
  ).run(ids.householdAId, ids.accountId, 2, null);
  const insertCatalogState = db.prepare('INSERT INTO catalog_state (household_id, revision) VALUES (?, ?)');
  insertCatalogState.run(ids.householdAId, 5);
  insertCatalogState.run(ids.householdBId, 1);
  // 阶段 3 目录:EPG 来源 + IPTV 来源(挂默认 EPG)
  const insertSource = db.prepare(
    "INSERT INTO media_source (id, household_id, kind, name, remote_url, root_key, relative_directory, private_access_approved, epg_source_id, enabled, version, last_success_at, last_job_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, NULL, NULL, 1, ?, 1, ?, ?, NULL, ?, ?)",
  );
  insertSource.run(ids.epgSourceId, ids.householdAId, 'epg', '指南EPG', 'http://lan.example/guide.xml', null, 2, T0, T0, T0);
  insertSource.run(ids.iptvSourceId, ids.householdAId, 'iptv', '受控IPTV', 'http://lan.example/list.m3u8', ids.epgSourceId, 1, T0, T0, T0);
  // 媒体条目(甲/乙各一,乙用于跨家庭负向)
  const insertMedia = db.prepare(
    "INSERT INTO media_item (id, household_id, type, title, description, poster_ref, content_level, title_overridden, type_overridden, version, created_at, updated_at) VALUES (?, ?, 'channel', ?, NULL, NULL, NULL, 1, 0, 3, ?, ?)",
  );
  insertMedia.run(ids.mediaId, ids.householdAId, '频道甲', T0, T0);
  insertMedia.run(ids.mediaBId, ids.householdBId, '邻家频道', T0, T0);
  // 身份稳定条目 + 播放资源(0005 playback_session.playback_source_id 的 FK 目标)
  db.prepare(
    "INSERT INTO source_entry (id, household_id, source_id, identity_kind, identity_digest, media_id, upstream_channel_id, present, last_seen_job_id, first_seen_at, last_seen_at, missing_since, file_size_text, file_mtime_ns) VALUES (?, ?, ?, 'tvg_id', ?, ?, 'cctv-1', 1, NULL, ?, ?, NULL, NULL, NULL)",
  ).run(ids.entryId, ids.householdAId, ids.iptvSourceId, sha256(`tvg_id:${ids.xmltvChannelId}`), ids.mediaId, T0, T0);
  db.prepare(
    "INSERT INTO playback_source (id, household_id, source_id, source_entry_id, media_item_id, protocol, location, mime_type, priority, requires_proxy, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 'http', 'http://lan.example/stream/cctv-1.m3u8', 'application/vnd.apple.mpegurl', 100, 0, ?, ?)",
  ).run(ids.playbackSourceId, ids.householdAId, ids.iptvSourceId, ids.entryId, ids.mediaId, T0, T0);
  // EPG 频道与节目
  db.prepare(
    "INSERT INTO epg_channel (household_id, source_id, xmltv_channel_id, display_name, conflicted) VALUES (?, ?, ?, 'CCTV-1 综合', 0)",
  ).run(ids.householdAId, ids.epgSourceId, ids.xmltvChannelId);
  db.prepare(
    "INSERT INTO epg_programme (id, household_id, source_id, xmltv_channel_id, title, description, starts_at, ends_at) VALUES (?, ?, ?, ?, '新闻节目', NULL, '2026-10-23T07:00:00Z', '2026-10-23T07:30:00Z')",
  ).run(randomUUID(), ids.householdAId, ids.epgSourceId, ids.xmltvChannelId);
  // 0004 增补:手动绑定行 + EPG 发布代数(证明 0005 不动 0004 数据)
  db.prepare(
    "INSERT INTO manual_epg_binding (household_id, media_id, mode, epg_source_id, xmltv_channel_id, version, updated_at) VALUES (?, ?, 'manual', ?, ?, 1, ?)",
  ).run(ids.householdAId, ids.mediaId, ids.epgSourceId, ids.xmltvChannelId, T0);
  db.prepare('UPDATE media_source SET epg_generation = 2 WHERE id = ?').run(ids.epgSourceId);
  return ids;
}

async function buildStage3Rig(): Promise<{ rig: TestRig; f: Stage3Fixture }> {
  const rig = await startFreshApp({ prefix: 'hmp-playback-mig-', migrations: STAGE3_MIGRATIONS });
  const f = injectStage3();
  return { rig, f };
}

/* ------------------------------------------------------------------ */
/* 快照:0001~0004 业务数据逐值(JSON 全值比对)                        */
/* ------------------------------------------------------------------ */

const LEGACY_TABLES = [
  'household',
  'account',
  'profile',
  'device',
  'device_session',
  'profile_policy',
  'parent_verification_state',
] as const;

const CATALOG_TABLES = [
  'catalog_state',
  'media_source',
  'media_item',
  'source_entry',
  'playback_source',
  'epg_channel',
  'epg_programme',
  'manual_epg_binding',
] as const;

function snapshotTables(tables: readonly string[]): string {
  const out: Record<string, unknown> = {};
  for (const table of tables) {
    out[table] = Database.db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all();
  }
  return JSON.stringify(out);
}

function snapshotLegacy(): string {
  return snapshotTables(LEGACY_TABLES);
}

function snapshotCatalog(): string {
  return snapshotTables(CATALOG_TABLES);
}

function snapshotPlayback(): string {
  return snapshotTables(PLAYBACK_TABLES);
}

function tableExists(name: string): boolean {
  return Database.db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name) !== undefined;
}

function expectIntegrityOk(): void {
  expect(Database.db.pragma('integrity_check')).toEqual([{ integrity_check: 'ok' }]);
  expect(Database.db.pragma('foreign_key_check')).toEqual([]);
}

/* ------------------------------------------------------------------ */
/* 行工厂:0005 四表最小合法行(测试以 overrides 构造非法变体)          */
/* ------------------------------------------------------------------ */

type Row = Record<string, unknown>;
type SqlValue = string | number | bigint | null;

function insertRow(table: string, row: Row): void {
  const cols = Object.keys(row);
  const placeholders = cols.map(() => '?').join(', ');
  Database.db
    .prepare(`INSERT INTO ${table} (${cols.join(', ')}) VALUES (${placeholders})`)
    .run(...cols.map((c) => row[c] as SqlValue));
}

/** 约束拒绝断言:语句必须抛 SQLITE_CONSTRAINT*(foreignKey 时进一步核对消息) */
function expectConstraintReject(run: () => void, why: string, options: { foreignKey?: boolean } = {}): void {
  let err: unknown;
  try {
    run();
  } catch (e) {
    err = e;
  }
  expect(err, `应被约束拒绝:${why}`).toBeInstanceOf(Error);
  const code = (err as { code?: string }).code ?? '';
  expect(code.startsWith('SQLITE_CONSTRAINT'), `${why}:错误码应始于 SQLITE_CONSTRAINT,实际 ${code}`).toBe(true);
  if (options.foreignKey === true) {
    expect(String((err as Error).message), `${why}:应为外键约束失败`).toContain('FOREIGN KEY');
  }
}

function playbackRows(f: Stage3Fixture): {
  session: (overrides?: Row) => Row;
  ticket: (sessionId: string, overrides?: Row) => Row;
  conversion: (sessionId: string, overrides?: Row) => Row;
  failureEvent: (overrides?: Row) => Row;
} {
  return {
    // 预置 state=ready 形态(source/delivery 非空;终态字段空)
    session: (overrides: Row = {}): Row => ({
      id: randomUUID(),
      household_id: f.householdAId,
      device_session_id: f.sessionAId,
      device_id: f.deviceId,
      profile_id: f.adultWithPinId,
      media_id: f.mediaId,
      playback_source_id: f.playbackSourceId,
      state: 'ready',
      delivery: 'direct',
      generation: 1,
      version: 1,
      position_seconds: 0,
      audio_track_id: null,
      subtitle_track_id: null,
      desired_paused: 0,
      created_at: T1,
      started_at: null,
      ended_at: null,
      last_heartbeat_at: T1,
      failure_code: null,
      ...overrides,
    }),
    ticket: (sessionId: string, overrides: Row = {}): Row => ({
      id: randomUUID(),
      household_id: f.householdAId,
      session_id: sessionId,
      token_hash: sha256(`ticket:${randomUUID()}`),
      issued_at: T1,
      expires_at: T2,
      generation: 1,
      revoked_at: null,
      ...overrides,
    }),
    conversion: (sessionId: string, overrides: Row = {}): Row => ({
      id: randomUUID(),
      household_id: f.householdAId,
      session_id: sessionId,
      generation: 1,
      mode: 'remux',
      state: 'reserved',
      hardware_backend: null,
      output_video_codec: 'h264',
      output_audio_codec: 'aac',
      started_at: null,
      ended_at: null,
      failure_code: null,
      cleanup_state: 'pending',
      bytes_on_disk: 0,
      last_progress_at: null,
      ...overrides,
    }),
    failureEvent: (overrides: Row = {}): Row => ({
      id: randomUUID(),
      household_id: f.householdAId,
      device_session_id: f.sessionAId,
      device_id: f.deviceId,
      profile_id: f.adultWithPinId,
      media_id: f.mediaId,
      occurred_at: T1,
      stable_code: 'PLAYBACK_SOURCE_UNAVAILABLE',
      ...overrides,
    }),
  };
}

/* ------------------------------------------------------------------ */
/* 结构断言:PRAGMA table_info / index_list / index_info /             */
/* foreign_key_list + sqlite_master.sql,对照 data-model.md 四节       */
/* ------------------------------------------------------------------ */

interface ColumnInfo {
  name: string;
  type: string;
  notnull: number;
  dflt_value: unknown;
  pk: number;
}

interface ColumnSpec {
  name: string;
  types: string[];
  notnull: 0 | 1;
  pk?: 1;
  /** data-model 注明的默认值(仅断言存在,不断言「无默认」) */
  dflt?: string;
}

function col(name: string, types: string[], notnull: 0 | 1, extra: { pk?: 1; dflt?: string } = {}): ColumnSpec {
  return { name, types, notnull, ...extra };
}

/** data-model.md 四节逐列:nullable 与否、类型(文本/整型;position_seconds 允许 REAL)、注明默认值 */
const EXPECTED_COLUMNS: Record<string, ColumnSpec[]> = {
  playback_session: [
    col('id', ['TEXT'], 1, { pk: 1 }),
    col('household_id', ['TEXT'], 1),
    col('device_session_id', ['TEXT'], 1),
    col('device_id', ['TEXT'], 1),
    col('profile_id', ['TEXT'], 1),
    col('media_id', ['TEXT'], 1),
    col('playback_source_id', ['TEXT'], 0),
    col('state', ['TEXT'], 1),
    col('delivery', ['TEXT'], 0),
    col('generation', ['INTEGER'], 1),
    col('version', ['INTEGER'], 1),
    col('position_seconds', ['INTEGER', 'REAL'], 1),
    col('audio_track_id', ['TEXT'], 0),
    col('subtitle_track_id', ['TEXT'], 0),
    col('desired_paused', ['INTEGER'], 1, { dflt: '0' }), // boolean 默认 false
    col('created_at', ['TEXT'], 1),
    col('started_at', ['TEXT'], 0),
    col('ended_at', ['TEXT'], 0),
    col('last_heartbeat_at', ['TEXT'], 1),
    col('failure_code', ['TEXT'], 0),
  ],
  playback_ticket: [
    col('id', ['TEXT'], 1, { pk: 1 }),
    col('household_id', ['TEXT'], 1),
    col('session_id', ['TEXT'], 1),
    col('token_hash', ['TEXT'], 1),
    col('issued_at', ['TEXT'], 1),
    col('expires_at', ['TEXT'], 1),
    col('generation', ['INTEGER'], 1),
    col('revoked_at', ['TEXT'], 0),
  ],
  playback_conversion: [
    col('id', ['TEXT'], 1, { pk: 1 }),
    col('household_id', ['TEXT'], 1),
    col('session_id', ['TEXT'], 1),
    col('generation', ['INTEGER'], 1),
    col('mode', ['TEXT'], 1),
    col('state', ['TEXT'], 1),
    col('hardware_backend', ['TEXT'], 0),
    col('output_video_codec', ['TEXT'], 1),
    col('output_audio_codec', ['TEXT'], 1),
    col('started_at', ['TEXT'], 0),
    col('ended_at', ['TEXT'], 0),
    col('failure_code', ['TEXT'], 0),
    col('cleanup_state', ['TEXT'], 1, { dflt: 'pending' }),
    col('bytes_on_disk', ['INTEGER'], 1, { dflt: '0' }),
    col('last_progress_at', ['TEXT'], 0),
  ],
  playback_failure_event: [
    col('id', ['TEXT'], 1, { pk: 1 }),
    col('household_id', ['TEXT'], 1),
    col('device_session_id', ['TEXT'], 1),
    col('device_id', ['TEXT'], 1),
    col('profile_id', ['TEXT'], 0),
    col('media_id', ['TEXT'], 0),
    col('occurred_at', ['TEXT'], 1),
    col('stable_code', ['TEXT'], 1),
  ],
};

interface FkExpectation {
  toTable: string;
  from: string[];
  to: string[];
}

/** 复合家庭外键:全部 (household_id, <列>) → <表>(household_id, id),禁止跨家庭关联 */
const EXPECTED_FKS: Record<string, FkExpectation[]> = {
  playback_session: [
    { toTable: 'device_session', from: ['household_id', 'device_session_id'], to: ['household_id', 'id'] },
    { toTable: 'device', from: ['household_id', 'device_id'], to: ['household_id', 'id'] },
    { toTable: 'profile', from: ['household_id', 'profile_id'], to: ['household_id', 'id'] },
    { toTable: 'media_item', from: ['household_id', 'media_id'], to: ['household_id', 'id'] },
    { toTable: 'playback_source', from: ['household_id', 'playback_source_id'], to: ['household_id', 'id'] },
  ],
  playback_ticket: [
    { toTable: 'playback_session', from: ['household_id', 'session_id'], to: ['household_id', 'id'] },
  ],
  playback_conversion: [
    { toTable: 'playback_session', from: ['household_id', 'session_id'], to: ['household_id', 'id'] },
  ],
  playback_failure_event: [
    { toTable: 'device_session', from: ['household_id', 'device_session_id'], to: ['household_id', 'id'] },
    { toTable: 'device', from: ['household_id', 'device_id'], to: ['household_id', 'id'] },
    { toTable: 'profile', from: ['household_id', 'profile_id'], to: ['household_id', 'id'] },
    { toTable: 'media_item', from: ['household_id', 'media_id'], to: ['household_id', 'id'] },
  ],
};

function normalizeDflt(v: unknown): string | null {
  if (v === null || v === undefined) {
    return null;
  }
  const s = String(v);
  const quoted = /^'(.*)'$/.exec(s);
  return quoted === null ? s : (quoted[1] ?? null);
}

function indexNamesOf(table: string): Array<{ name: string; unique: number }> {
  return Database.db.pragma(`index_list(${table})`) as Array<{ name: string; unique: number }>;
}

function indexColumns(indexName: string): string[] {
  return (Database.db.pragma(`index_info(${indexName})`) as Array<{ name: string }>).map((row) => row.name);
}

/** 按列集精确匹配索引(名称无关:data-model 只规定列集) */
function findIndex(table: string, cols: string[], unique: number): string | undefined {
  return indexNamesOf(table)
    .filter((idx) => idx.unique === unique)
    .map((idx) => idx.name)
    .find((name) => JSON.stringify(indexColumns(name)) === JSON.stringify(cols));
}

/** 按前缀列匹配索引(档案隔离索引:前导 (household_id, profile_id)) */
function findIndexPrefix(table: string, prefix: string[]): string | undefined {
  return indexNamesOf(table)
    .map((idx) => idx.name)
    .find((name) => {
      const cols = indexColumns(name);
      return cols.length >= prefix.length && prefix.every((c, i) => cols[i] === c);
    });
}

function expectCompositeFk(table: string, exp: FkExpectation): void {
  const rows = Database.db.pragma(`foreign_key_list(${table})`) as Array<{
    id: number;
    seq: number;
    table: string;
    from: string;
    to: string | null;
  }>;
  const groups = new Map<number, { toTable: string; pairs: Array<{ seq: number; from: string; to: string | null }> }>();
  for (const row of rows) {
    const group = groups.get(row.id) ?? { toTable: row.table, pairs: [] };
    group.pairs.push({ seq: row.seq, from: row.from, to: row.to });
    groups.set(row.id, group);
  }
  const matched = [...groups.values()].some(
    (group) =>
      group.toTable === exp.toTable &&
      JSON.stringify(group.pairs.sort((a, b) => a.seq - b.seq).map((p) => p.from)) === JSON.stringify(exp.from) &&
      JSON.stringify(group.pairs.sort((a, b) => a.seq - b.seq).map((p) => p.to)) === JSON.stringify(exp.to),
  );
  expect(
    matched,
    `${table} 应有复合外键 (${exp.from.join(', ')}) → ${exp.toTable}(${exp.to.join(', ')})`,
  ).toBe(true);
}

function masterSql(table: string): string {
  const row = Database.db.prepare('SELECT sql FROM sqlite_master WHERE type = ? AND name = ?').get('table', table) as
    | { sql: string }
    | undefined;
  return row?.sql ?? '';
}

/** 四表全部结构断言(升级后与 down→up 再升级后复用) */
function assertPlaybackStructure(): void {
  const db = Database.db;
  for (const table of PLAYBACK_TABLES) {
    expect(tableExists(table), `表 ${table} 应存在`).toBe(true);
    const sql = masterSql(table);
    expect(sql).toContain('CREATE TABLE');
    expect(sql, `${table} 应含 CHECK 约束`).toContain('CHECK');
  }
  expect(masterSql('playback_session')).toContain("'preparing'");
  expect(masterSql('playback_ticket')).toContain('token_hash');
  expect(masterSql('playback_conversion')).toContain("'pending'");
  expect(masterSql('playback_failure_event')).toContain('stable_code');

  // 逐列:列集合精确(不多不少)+ NOT NULL/类型/主键/注明默认值
  for (const [table, expected] of Object.entries(EXPECTED_COLUMNS)) {
    const info = db.pragma(`table_info(${table})`) as ColumnInfo[];
    expect(info.map((c) => c.name).sort(), `${table} 列集合应与 data-model 完全一致`).toEqual(
      expected.map((c) => c.name).sort(),
    );
    for (const exp of expected) {
      const actual = info.find((c) => c.name === exp.name);
      expect(actual, `${table}.${exp.name} 应存在`).toBeDefined();
      expect(exp.types, `${table}.${exp.name} 类型应属 ${exp.types.join('/')}`).toContain(
        actual?.type.toUpperCase(),
      );
      expect(actual?.notnull, `${table}.${exp.name} NOT NULL=${exp.notnull}`).toBe(exp.notnull);
      expect(actual?.pk, `${table}.${exp.name} 主键标记`).toBe(exp.pk ?? 0);
      if (exp.dflt !== undefined) {
        expect(normalizeDflt(actual?.dflt_value), `${table}.${exp.name} 默认值`).toBe(exp.dflt);
      }
    }
  }

  // 索引:查询索引按列集(data-model 不命名查询索引);FK 目标唯一索引按仓内命名约定断名
  expect(
    findIndex('playback_session', ['household_id', 'device_id', 'created_at', 'id'], 0),
    'playback_session 设备维度索引 (household_id,device_id,created_at,id)',
  ).toBeDefined();
  expect(
    findIndexPrefix('playback_session', ['household_id', 'profile_id']),
    'playback_session 档案隔离索引(前导 household_id,profile_id)',
  ).toBeDefined();
  expect(
    findIndex('playback_session', ['household_id', 'id'], 1),
    'playback_session(household_id,id) 唯一(复合 FK 目标)',
  ).toBeDefined();
  expect(indexColumns('playback_session_household_id_id_key')).toEqual(['household_id', 'id']);
  expect(findIndex('playback_ticket', ['token_hash'], 1), 'playback_ticket.token_hash UNIQUE').toBeDefined();
  expect(
    findIndex('playback_conversion', ['household_id', 'session_id', 'generation'], 1),
    'playback_conversion UNIQUE(household_id,session_id,generation)',
  ).toBeDefined();
  expect(
    findIndex('playback_failure_event', ['household_id', 'device_id', 'occurred_at', 'id'], 0),
    'playback_failure_event 索引 (household_id,device_id,occurred_at,id)',
  ).toBeDefined();
  expect(indexColumns('device_household_id_id_key')).toEqual(['household_id', 'id']);

  // 复合家庭外键
  for (const [table, fks] of Object.entries(EXPECTED_FKS)) {
    for (const fk of fks) {
      expectCompositeFk(table, fk);
    }
  }
}

/* ------------------------------------------------------------------ */
/* 测试                                                               */
/* ------------------------------------------------------------------ */

describe('0005_playback 迁移升级/回滚/备份恢复(阶段 4 契约 e2e · TDD 先行失败)', () => {
  afterEach(cleanupRigs);

  it('升级路径:仅应用 0001~0004 的库应用 0005 后,旧身份/PIN/策略/目录/EPG 逐值不变;四张新表存在', async () => {
    await buildStage3Rig();
    const legacyBefore = snapshotLegacy();
    const catalogBefore = snapshotCatalog();
    for (const table of PLAYBACK_TABLES) {
      expect(tableExists(table), `升级前不应存在 ${table}`).toBe(false);
    }

    applyPlayback();

    expect(appliedMigrations()).toEqual([...STAGE3_MIGRATIONS, MIGRATION]);
    for (const table of PLAYBACK_TABLES) {
      expect(tableExists(table), `升级后应存在 ${table}`).toBe(true);
    }
    // 0005 up 对原表数据零修改(data-model「验证与恢复」):逐值快照不变
    expect(snapshotLegacy()).toBe(legacyBefore);
    expect(snapshotCatalog()).toBe(catalogBefore);
    expectIntegrityOk();
  });

  it('逐字段对照 data-model:四表全部列/NOT NULL/默认值/CHECK/UNIQUE/索引/复合FK 逐项存在', async () => {
    await buildStage3Rig();
    applyPlayback();

    assertPlaybackStructure();

    expectIntegrityOk();
  });

  it('复合家庭FK:跨 household 的 device_session/profile/media 引用被拒(SQLITE_CONSTRAINT)', async () => {
    const { f } = await buildStage3Rig();
    applyPlayback();
    const rows = playbackRows(f);
    // 阳性对照:同家庭引用合法(preparing 允许 source/delivery 为空)
    insertRow('playback_session', rows.session({ state: 'preparing', playback_source_id: null, delivery: null }));
    const cross = (overrides: Row): Row => ({
      ...rows.session({ state: 'preparing', playback_source_id: null, delivery: null }),
      ...overrides,
    });

    expectConstraintReject(
      () => insertRow('playback_session', cross({ device_session_id: f.sessionBId })),
      'device_session_id 指向乙家庭会话',
      { foreignKey: true },
    );
    expectConstraintReject(() => insertRow('playback_session', cross({ profile_id: f.adultBId })), 'profile_id 指向乙家庭档案', {
      foreignKey: true,
    });
    expectConstraintReject(() => insertRow('playback_session', cross({ media_id: f.mediaBId })), 'media_id 指向乙家庭媒体', {
      foreignKey: true,
    });
    expectConstraintReject(() => insertRow('playback_session', cross({ device_id: f.deviceBId })), 'device_id 指向乙家庭设备', {
      foreignKey: true,
    });
    // playback_failure_event 同样仅接受同家庭设备会话(「仅有效设备会话可写」)
    expectConstraintReject(
      () =>
        insertRow(
          'playback_failure_event',
          rows.failureEvent({ device_session_id: f.sessionBId, device_id: f.deviceBId }),
        ),
      'failure_event.device_session_id 指向乙家庭会话',
      { foreignKey: true },
    );

    expectIntegrityOk();
  });

  it('CHECK 矩阵:state/delivery/mode/cleanup_state/conversion state 枚举、generation/version/position/bytes 非负与终态可空性按 data-model 拒绝非法值', async () => {
    const { f } = await buildStage3Rig();
    applyPlayback();
    const rows = playbackRows(f);

    /* ---- playback_session ---- */
    // 合法状态集:preparing 允许 source/delivery 为空;活动态必填;终态带 ended_at
    for (const state of ['preparing', 'ready', 'playing', 'paused', 'ended', 'failed', 'interrupted']) {
      insertRow(
        'playback_session',
        rows.session({
          state,
          started_at: state === 'preparing' ? null : T1,
          ended_at: ['ended', 'failed', 'interrupted'].includes(state) ? T1 : null,
          failure_code: state === 'failed' ? 'PLAYBACK_PROBE_FAILED' : null,
        }),
      );
    }
    // delivery 合法五值(ready 形态逐一接受)
    for (const delivery of ['direct', 'hls_proxy', 'remux', 'audio_transcode', 'video_transcode']) {
      insertRow('playback_session', rows.session({ delivery }));
    }
    // preparing 携带候选 source/delivery 亦合法(准备阶段可按排序尝试候选)
    insertRow('playback_session', rows.session({ state: 'preparing' }));

    expectConstraintReject(() => insertRow('playback_session', rows.session({ state: 'running' })), 'state 非枚举值');
    expectConstraintReject(() => insertRow('playback_session', rows.session({ delivery: 'copy' })), 'delivery 非枚举值');
    expectConstraintReject(
      () => insertRow('playback_session', rows.session({ playback_source_id: null })),
      'ready 缺 playback_source_id(ready/playing/paused 必须非空)',
    );
    expectConstraintReject(
      () => insertRow('playback_session', rows.session({ delivery: null })),
      'ready 缺 delivery(ready/playing/paused 必须非空)',
    );
    expectConstraintReject(() => insertRow('playback_session', rows.session({ generation: 0 })), 'generation>=1');
    expectConstraintReject(() => insertRow('playback_session', rows.session({ version: 0 })), 'version>=1');
    expectConstraintReject(() => insertRow('playback_session', rows.session({ position_seconds: -1 })), 'position_seconds>=0');
    expectConstraintReject(() => insertRow('playback_session', rows.session({ desired_paused: 2 })), 'desired_paused 为布尔');
    expectConstraintReject(
      () => insertRow('playback_session', rows.session({ state: 'ended', ended_at: null })),
      '终态 ended 缺 ended_at(必填)',
    );
    expectConstraintReject(
      () => insertRow('playback_session', rows.session({ ended_at: T1 })),
      '活动态 ready 带 ended_at(活动态为空)',
    );
    expectConstraintReject(
      () => insertRow('playback_session', rows.session({ failure_code: 'SOME_CODE' })),
      '非 failed 状态带 failure_code(失败码仅 failed 非空)',
    );
    expectConstraintReject(
      () => insertRow('playback_session', rows.session({ state: 'failed', ended_at: T1, failure_code: null })),
      'failed 缺 failure_code(失败码仅 failed 非空)',
    );
    // desired_paused 默认 false
    const defaultPaused = rows.session();
    delete defaultPaused.desired_paused;
    insertRow('playback_session', defaultPaused);
    expect(
      (Database.db.prepare('SELECT desired_paused FROM playback_session WHERE id = ?').get(defaultPaused.id) as {
        desired_paused: number;
      }).desired_paused,
    ).toBe(0);

    /* ---- playback_ticket ---- */
    const ticketSession = rows.session({ state: 'ready' });
    insertRow('playback_session', ticketSession);
    const ticketSessionId = ticketSession.id as string;
    const firstHash = sha256('ticket-first');
    insertRow('playback_ticket', rows.ticket(ticketSessionId, { token_hash: firstHash }));
    expectConstraintReject(
      () => insertRow('playback_ticket', rows.ticket(ticketSessionId, { generation: 0 })),
      'ticket generation>=1',
    );
    expectConstraintReject(
      () => insertRow('playback_ticket', rows.ticket(ticketSessionId, { expires_at: T1 })),
      'expires_at>issued_at(相等拒绝)',
    );
    expectConstraintReject(
      () => insertRow('playback_ticket', rows.ticket(ticketSessionId, { expires_at: '2026-10-23T08:04:59.999Z' })),
      'expires_at>issued_at(更早拒绝)',
    );
    expectConstraintReject(
      () => insertRow('playback_ticket', rows.ticket(ticketSessionId, { token_hash: firstHash })),
      'token_hash UNIQUE',
    );
    const noIssued = rows.ticket(ticketSessionId);
    delete noIssued.issued_at;
    expectConstraintReject(() => insertRow('playback_ticket', noIssued), 'issued_at NOT NULL');
    const noRevoked = rows.ticket(ticketSessionId);
    delete noRevoked.revoked_at;
    insertRow('playback_ticket', noRevoked); // revoked_at 可空:缺省 NULL 合法

    /* ---- playback_conversion ---- */
    const convSession = rows.session({ state: 'preparing', playback_source_id: null, delivery: null });
    insertRow('playback_session', convSession);
    const convSessionId = convSession.id as string;
    let gen = 1;
    for (const mode of ['remux', 'audio_transcode', 'video_transcode']) {
      insertRow('playback_conversion', rows.conversion(convSessionId, { mode, generation: gen++ }));
    }
    for (const state of ['reserved', 'probing', 'starting', 'running', 'stopping']) {
      insertRow('playback_conversion', rows.conversion(convSessionId, { state, generation: gen++ }));
    }
    insertRow('playback_conversion', rows.conversion(convSessionId, { state: 'ended', started_at: T1, ended_at: T2, generation: gen++ }));
    insertRow(
      'playback_conversion',
      rows.conversion(convSessionId, { state: 'failed', started_at: T1, ended_at: T2, failure_code: 'CONVERSION_SPA_FAILED', generation: gen++ }),
    );
    insertRow('playback_conversion', rows.conversion(convSessionId, { state: 'interrupted', started_at: T1, ended_at: T2, generation: gen++ }));
    insertRow(
      'playback_conversion',
      rows.conversion(convSessionId, { state: 'running', started_at: T1, cleanup_state: 'complete', bytes_on_disk: 4096, last_progress_at: T1, generation: gen++ }),
    );
    insertRow('playback_conversion', rows.conversion(convSessionId, { state: 'running', started_at: T1, hardware_backend: 'vaapi', generation: gen++ }));

    expectConstraintReject(() => insertRow('playback_conversion', rows.conversion(convSessionId, { mode: 'direct', generation: gen++ })), 'mode 非枚举(direct 不是转换模式)');
    expectConstraintReject(() => insertRow('playback_conversion', rows.conversion(convSessionId, { state: 'queued', generation: gen++ })), 'conversion state 非枚举值');
    expectConstraintReject(
      () => insertRow('playback_conversion', rows.conversion(convSessionId, { state: 'running', cleanup_state: 'cleanup_pending', generation: gen++ })),
      'cleanup_state 无第三枚举 cleanup_pending',
    );
    expectConstraintReject(
      () => insertRow('playback_conversion', rows.conversion(convSessionId, { state: 'running', bytes_on_disk: -1, generation: gen++ })),
      'bytes_on_disk>=0',
    );
    expectConstraintReject(() => insertRow('playback_conversion', rows.conversion(convSessionId, { generation: 0 })), 'conversion generation>=1');
    expectConstraintReject(
      () => insertRow('playback_conversion', rows.conversion(convSessionId, { state: 'running', started_at: T1, failure_code: 'X', generation: gen++ })),
      '非 failed 带 failure_code(其余为空)',
    );
    expectConstraintReject(
      () => insertRow('playback_conversion', rows.conversion(convSessionId, { state: 'failed', ended_at: T2, failure_code: null, generation: gen++ })),
      'failed 缺 failure_code(仅 failed 必填)',
    );
    expectConstraintReject(
      () => insertRow('playback_conversion', rows.conversion(convSessionId, { state: 'ended', started_at: T1, ended_at: null, generation: gen++ })),
      'conversion 终态缺 ended_at(必填)',
    );
    expectConstraintReject(
      () => insertRow('playback_conversion', rows.conversion(convSessionId, { generation: 1 })),
      'UNIQUE(household_id,session_id,generation) 冲突',
    );
    const noAudioCodec = rows.conversion(convSessionId, { generation: gen++ });
    delete noAudioCodec.output_audio_codec;
    expectConstraintReject(() => insertRow('playback_conversion', noAudioCodec), 'output_audio_codec NOT NULL');
    // 静音合法视频:output_audio_codec='none'
    insertRow('playback_conversion', rows.conversion(convSessionId, { state: 'running', started_at: T1, output_audio_codec: 'none', generation: gen++ }));
    // 默认值:cleanup_state=pending、bytes_on_disk=0
    const defaultConv = rows.conversion(convSessionId, { generation: gen++ });
    delete defaultConv.cleanup_state;
    delete defaultConv.bytes_on_disk;
    insertRow('playback_conversion', defaultConv);
    const defaultConvRow = Database.db.prepare('SELECT cleanup_state, bytes_on_disk FROM playback_conversion WHERE id = ?').get(defaultConv.id) as {
      cleanup_state: string;
      bytes_on_disk: number;
    };
    expect(defaultConvRow.cleanup_state).toBe('pending');
    expect(defaultConvRow.bytes_on_disk).toBe(0);

    /* ---- playback_failure_event ---- */
    insertRow('playback_failure_event', rows.failureEvent());
    insertRow('playback_failure_event', rows.failureEvent({ profile_id: null, media_id: null })); // 可空列缺省合法
    const noOccurred = rows.failureEvent();
    delete noOccurred.occurred_at;
    expectConstraintReject(() => insertRow('playback_failure_event', noOccurred), 'occurred_at NOT NULL');
    const noStableCode = rows.failureEvent();
    delete noStableCode.stable_code;
    expectConstraintReject(() => insertRow('playback_failure_event', noStableCode), 'stable_code NOT NULL');

    expectIntegrityOk();
  });

  it('回滚/再升级:down 后 0001~0004 业务数据逐值保留、四表及索引删除;再 up 结构恢复且旧数据仍不变(drill 等价)', async () => {
    const { f } = await buildStage3Rig();
    applyPlayback();
    const rows = playbackRows(f);
    const ended = rows.session({ state: 'preparing', playback_source_id: null, delivery: null });
    insertRow('playback_session', ended);
    insertRow('playback_ticket', rows.ticket(ended.id as string));
    insertRow('playback_conversion', rows.conversion(ended.id as string));
    insertRow('playback_failure_event', rows.failureEvent({ profile_id: null, media_id: null }));
    const legacyBefore = snapshotLegacy();
    const catalogBefore = snapshotCatalog();

    rollbackPlayback();

    // 四表随 down 删除,索引不残留
    for (const table of PLAYBACK_TABLES) {
      expect(tableExists(table), `${table} 应回滚删除`).toBe(false);
    }
    expect(
      Database.db
        .prepare(
          "SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name IN ('playback_session','playback_ticket','playback_conversion','playback_failure_event')",
        )
        .all(),
    ).toEqual([]);
    expect(indexColumns('device_household_id_id_key')).toEqual([]); // 0005 新增的复合FK目标索引随 down 删除
    expect(appliedMigrations()).toEqual(STAGE3_MIGRATIONS);
    // 0001~0004 业务数据逐值保留(身份/PIN/策略/目录/EPG)
    expect(snapshotLegacy()).toBe(legacyBefore);
    expect(snapshotCatalog()).toBe(catalogBefore);
    expectIntegrityOk();

    // 再 up:结构恢复、四表为空(0005 不恢复播放数据,与 drill 终态等价),旧数据仍不变
    applyPlayback();

    assertPlaybackStructure();
    for (const table of PLAYBACK_TABLES) {
      expect((Database.db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n).toBe(0);
    }
    expect(snapshotLegacy()).toBe(legacyBefore);
    expect(snapshotCatalog()).toBe(catalogBefore);
    expect(appliedMigrations()).toEqual([...STAGE3_MIGRATIONS, MIGRATION]);
    expectIntegrityOk();
    expect(f.householdAId).toBeDefined();
  });

  it('备份恢复:停服备份→活动库新增播放→备份覆盖恢复→播放记录回到备份点;旧 ticket 无活动载体不可签发', async () => {
    const { rig, f } = await buildStage3Rig();
    applyPlayback();
    const rows = playbackRows(f);
    const dbFile = path.join(rig.dataDir, rig.dbFilename);
    const backupFile = path.join(rig.dataDir, 'backup.hmp.db');

    // 备份点:一个已中断(非活动)会话 + 其未撤销未过期票 —— 票行在库但无可用载体
    const interrupted = rows.session({
      state: 'interrupted',
      started_at: T1,
      ended_at: T1,
      failure_code: null, // interrupted 非 failed,失败码为空
    });
    insertRow('playback_session', interrupted);
    const oldHash = sha256('old-ticket-plaintext-url');
    insertRow('playback_ticket', rows.ticket(interrupted.id as string, { token_hash: oldHash }));
    const legacyBefore = snapshotLegacy();
    const catalogBefore = snapshotCatalog();
    const playbackBefore = snapshotPlayback();

    // 模拟停服备份:关库(干净关闭收敛 WAL)后复制 db 文件
    Database.close();
    for (const suffix of ['-wal', '-shm']) {
      fs.rmSync(dbFile + suffix, { force: true });
    }
    fs.copyFileSync(dbFile, backupFile);

    // 备份后活动库继续写入:新的活动会话 + 新票
    const liveSession = rows.session({ state: 'playing', started_at: T1, position_seconds: 90 });
    insertRow('playback_session', liveSession);
    const newHash = sha256('new-ticket-plaintext-url');
    insertRow('playback_ticket', rows.ticket(liveSession.id as string, { token_hash: newHash }));
    expect((Database.db.prepare('SELECT COUNT(*) AS n FROM playback_session').get() as { n: number }).n).toBe(2);
    expect((Database.db.prepare('SELECT COUNT(*) AS n FROM playback_ticket').get() as { n: number }).n).toBe(2);

    // 用备份覆盖恢复(模拟回滚到备份点)
    Database.close();
    for (const suffix of ['-wal', '-shm']) {
      fs.rmSync(dbFile + suffix, { force: true });
    }
    fs.copyFileSync(backupFile, dbFile);
    const restored = Database.db;

    // 播放记录回到备份点:备份后写入的会话/票消失,四表内容与备份点逐值一致
    expect(snapshotPlayback()).toBe(playbackBefore);
    expect(restored.prepare('SELECT 1 FROM playback_session WHERE id = ?').get(liveSession.id)).toBeUndefined();
    expect(restored.prepare('SELECT 1 FROM playback_ticket WHERE token_hash = ?').get(newHash)).toBeUndefined();
    expect(appliedMigrations()).toEqual([...STAGE3_MIGRATIONS, MIGRATION]);
    expect(snapshotLegacy()).toBe(legacyBefore);
    expect(snapshotCatalog()).toBe(catalogBefore);

    // 旧 ticket 不可复活(以库内容为准,不要求应用逻辑):
    // 1) 恢复后库中票行仍在,但其指向的会话为非活动态(票无可用载体)
    const ticketRow = restored.prepare('SELECT session_id, revoked_at, expires_at FROM playback_ticket WHERE token_hash = ?').get(oldHash) as
      | { session_id: string; revoked_at: string | null; expires_at: string }
      | undefined;
    expect(ticketRow).toBeDefined();
    expect(ticketRow?.revoked_at).toBeNull(); // 未撤销:不可复活性不依赖撤销标记
    const carrier = restored
      .prepare(
        'SELECT s.id, s.state FROM playback_session s JOIN playback_ticket t ON s.household_id = t.household_id AND s.id = t.session_id WHERE t.token_hash = ?',
      )
      .get(oldHash) as { id: string; state: string } | undefined;
    expect(carrier).toBeDefined();
    expect(carrier?.id).toBe(interrupted.id);
    expect(['ready', 'playing', 'paused']).not.toContain(carrier?.state); // 非活动载体
    expect(carrier?.state).toBe('interrupted');
    // 2) 全库无任何活动态会话:旧票 hash 即便复现也无 ready/playing/paused 会话可签发
    expect(
      (restored.prepare("SELECT COUNT(*) AS n FROM playback_session WHERE state IN ('ready','playing','paused')").get() as { n: number }).n,
    ).toBe(0);
    const issuable = restored
      .prepare(
        "SELECT t.token_hash FROM playback_ticket t JOIN playback_session s ON s.household_id = t.household_id AND s.id = t.session_id WHERE t.token_hash = ? AND t.revoked_at IS NULL AND t.expires_at > ? AND s.state IN ('ready','playing','paused')",
      )
      .all(oldHash, FAR_FUTURE);
    expect(issuable).toEqual([]); // 旧票 hash 查询无可签发的活动会话

    expectIntegrityOk();
  });
});
