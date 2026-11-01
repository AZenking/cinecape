import 'reflect-metadata';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Database } from '@platform/database/database';
import { loadEnv } from '@platform/config/env.schema';
import { setEnvOverride } from '@platform/config/env';
import { runMigrationCommand } from '@platform/database/migrate';
import { cleanupRigs, startFreshApp, type TestRig } from '../helpers';

/**
 * T007(010-online-vod · Phase 2 Foundational,测试先行):0007_online_vod 迁移
 * 升级/回滚/约束契约。
 *
 * ⚠️ TDD 红阶段预期失败,待 T014 落地转绿:本文件只写测试,不实现迁移本体。
 * 红阶段失败形态随并行实现进度演进:迁移目录缺失时,除「migrate.ts 全链」describe 外
 * 的用例以「未找到迁移文件 …/0007_online_vod/up.sql」失败,全链用例以 user_version/
 * 表缺失失败;0007 落地后则以上述断言逐项暴露实现与 data-model 的偏差。
 * 两者均为合理的测试先行失败形态。
 *
 * 权威依据(字段/约束唯一权威):
 * - docs/specs/010-online-vod/data-model.md §1 通用约束、§2 来源与目录、§4 物化幂等、
 *   §5 会话 ledger/历史/偏好/观测/receipt、§6 固定输入、§7 单后继槽与意图、
 *   §8 迁移和恢复(0007_online_vod 路径锁定 + 静态 locator 回填 + 角色 standalone 回填 +
 *   非空在线业务 down 拒绝)、§10 I1–I5 新增持久边界(vod_registered_candidate /
 *   playback_next_plan / intent 冻结快照 / playback_started_at / cleanup_requested /
 *   profile_vod_preference_operation);
 * - docs/specs/010-online-vod/tasks.md T007 条目及审查补充;
 * - 写法参照 test/contract/playback-migration.e2e-spec.ts(隔离副本 + 手工 up/down + PRAGMA
 *   断言)与 test/unit/migration-0006.spec.ts(runMigrationCommand 目录发现全链 +
 *   临时 DATA_DIR 独立 rig)。绝不触碰真实用户库/开发库,全部 os.tmpdir 隔离副本。
 *
 * 范围说明:
 * - T007 原文提及的「配额并发」是物化服务层事务行为(净额检查/并发不突破),
 *   归 T024 物化契约测试验证;迁移文件只断言 schema 层结构与数据层约束;
 * - 列名一律取 data-model 字段名的仓内 snake_case 惯例(device_session_id /
 *   profile_context_version / operation_key 等,与 0005/0006 已落地列一致);
 *   可空性/默认值仅断言 data-model 明确冻结者(completed 默认 false、preferences 默认
 *   true 与持久 version>=1、frozen_start_seconds 与 playback_started_at nullable),
 *   不对未注明列过度断言;唯一键均带家庭(data-model §1「唯一键都带家庭」)。
 */

const MIGRATION = '0007_online_vod';
/** 阶段 2 完整形态库:仅应用 0001~0006(不含 0007),再以 0007 up/down 做升级/回滚矩阵 */
const BASE_MIGRATIONS: string[] = [
  '0001_init',
  '0002_profile_policy',
  '0003_media_catalog',
  '0004_manual_epg_binding',
  '0005_playback',
  '0006_pc_experience',
];
const ALL_MIGRATIONS: string[] = [...BASE_MIGRATIONS, MIGRATION];

/** 0007 全部新表(data-model §2/§4/§5/§6/§7/§10;down 后必须全部消失) */
const ONLINE_VOD_TABLES = [
  // §2 来源与目录
  'vod_source_config',
  'vod_title',
  'vod_line',
  'vod_episode',
  'vod_detail_snapshot',
  'vod_episode_sequence',
  'media_relation',
  // §4 物化幂等(+§10 登记候选)
  'vod_materialization_operation',
  'vod_registered_candidate',
  // §6 固定输入
  'playback_input_binding',
  // §5 观测/receipt
  'playback_phase_observation',
  'playback_finish_receipt',
  // §7 单后继槽与意图(+§10 下一集计划)
  'playback_transition_slot',
  'playback_transition_intent',
  'playback_next_plan',
  // §5/§10 偏好与偏好操作
  'profile_vod_preferences',
  'profile_vod_preference_operation',
] as const;

/* 固定时刻(UTC ISO-8601,字符串序即时间序),保证夹具与快照确定性 */
const T0 = '2026-10-30T08:00:00.000Z';
const T1 = '2026-10-30T08:05:00.000Z';
const FAR_FUTURE = '2027-01-01T00:00:00.000Z';
/** profile_vod_preference_operation:expires >= committed+24h 的边界样本 */
const PLUS_24H = '2026-10-31T08:05:00.000Z';
const PLUS_23H = '2026-10-31T07:05:00.000Z';
const PLUS_25H = '2026-10-31T09:05:00.000Z';

function sha256(input: string): string {
  return createHash('sha256').update(input).digest('hex');
}

/* ------------------------------------------------------------------ */
/* 迁移应用/回滚(与 migrate.ts 同语义:DDL 与版本记录同事务)           */
/* ------------------------------------------------------------------ */

function migrationSql(name: string, file: 'up.sql' | 'down.sql'): string {
  const p = path.join(process.cwd(), 'src/platform/database/migrations', name, file);
  if (!fs.existsSync(p)) {
    throw new Error(
      `未找到迁移文件 ${p} —— T014 应创建 src/platform/database/migrations/${name}/${file}(T007 为先行的失败测试)`,
    );
  }
  return fs.readFileSync(p, 'utf8');
}

function applyOnlineVod(): void {
  const conn = Database.db;
  conn.transaction(() => {
    conn.exec(migrationSql(MIGRATION, 'up.sql'));
    conn.prepare('INSERT INTO _migrations (name, applied_at) VALUES (?, ?)').run(MIGRATION, new Date().toISOString());
  })();
}

function rollbackOnlineVod(): void {
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
/* SQL 层观察 helpers(sqlite_master / PRAGMA,不经任何应用代码)        */
/* ------------------------------------------------------------------ */

function tableExists(name: string): boolean {
  return Database.db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name) !== undefined;
}

function masterSql(table: string): string {
  const row = Database.db.prepare('SELECT sql FROM sqlite_master WHERE type = ? AND name = ?').get('table', table) as
    | { sql: string }
    | undefined;
  return row?.sql ?? '';
}

interface ColumnInfo {
  name: string;
  type: string;
  notnull: number;
  dflt_value: unknown;
  pk: number;
}

function columnsOf(table: string): ColumnInfo[] {
  return Database.db.pragma(`table_info(${table})`) as ColumnInfo[];
}

function columnOf(table: string, name: string): ColumnInfo | undefined {
  return columnsOf(table).find((column) => column.name === name);
}

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

/** 按列集精确匹配唯一索引(名称无关:data-model 只规定列集,且唯一键都带家庭) */
function findUniqueIndex(table: string, cols: string[]): string | undefined {
  return indexNamesOf(table)
    .filter((idx) => idx.unique === 1)
    .map((idx) => idx.name)
    .find((name) => JSON.stringify(indexColumns(name)) === JSON.stringify(cols));
}

interface FkExpectation {
  toTable: string;
  from: string[];
  to: string[];
}

/** 复合家庭外键:全部 (household_id, <列>) → <表>(household_id, id),禁止跨家庭关联 */
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

function expectIntegrityOk(): void {
  expect(Database.db.pragma('integrity_check')).toEqual([{ integrity_check: 'ok' }]);
  expect(Database.db.pragma('foreign_key_check')).toEqual([]);
}

/* ------------------------------------------------------------------ */
/* 行工厂:直写 SQL(不经 HTTP/ORM),以 overrides 构造非法变体           */
/* ------------------------------------------------------------------ */

type Row = Record<string, unknown>;
type SqlValue = string | number | null;

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

/* ------------------------------------------------------------------ */
/* 阶段 2 夹具:0001~0006 形态库上的最小代表行(直写 SQL)               */
/* ------------------------------------------------------------------ */

interface Stage6Fixture {
  householdAId: string;
  householdBId: string;
  accountId: string;
  accountBId: string;
  adultAId: string;
  childAId: string;
  adultBId: string;
  deviceId: string;
  deviceSessionAId: string;
  iptvSourceId: string;
  epgSourceId: string;
  iptvSourceBId: string;
  mediaChannelAId: string;
  mediaChannelA2Id: string;
  mediaChannelBId: string;
  entryId: string;
  playbackSourceId: string;
  playbackSessionAId: string;
  historyRowId: string;
}

/**
 * 直写身份/PIN/策略/目录/EPG/绑定/播放/个人历史最小代表行(家庭甲为主,
 * 家庭乙仅作跨家庭负向引用目标;乙只建跨家庭负向所需的父行)。
 */
function injectStage6(): Stage6Fixture {
  const ids: Stage6Fixture = {
    householdAId: randomUUID(),
    householdBId: randomUUID(),
    accountId: randomUUID(),
    accountBId: randomUUID(),
    adultAId: randomUUID(),
    childAId: randomUUID(),
    adultBId: randomUUID(),
    deviceId: randomUUID(),
    deviceSessionAId: randomUUID(),
    iptvSourceId: randomUUID(),
    epgSourceId: randomUUID(),
    iptvSourceBId: randomUUID(),
    mediaChannelAId: randomUUID(),
    mediaChannelA2Id: randomUUID(),
    mediaChannelBId: randomUUID(),
    entryId: randomUUID(),
    playbackSourceId: randomUUID(),
    playbackSessionAId: randomUUID(),
    historyRowId: randomUUID(),
  };
  const db = Database.db;
  const insertHousehold = db.prepare(
    'INSERT INTO household (id, name, created_at) VALUES (?, ?, ?)',
  );
  insertHousehold.run(ids.householdAId, '在线点播迁移家庭甲', T0);
  insertHousehold.run(ids.householdBId, '在线点播迁移家庭乙', T0);
  const insertAccount = db.prepare(
    'INSERT INTO account (id, household_id, username, username_normalized, password_hash, role, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
  );
  insertAccount.run(ids.accountId, ids.householdAId, 'voder', 'voder', '$argon2id$fixture-hash', 'owner', T0);
  insertAccount.run(ids.accountBId, ids.householdBId, 'neighbor', 'neighbor', '$argon2id$fixture-hash-b', 'owner', T0);
  const insertProfile = db.prepare(
    'INSERT INTO profile (id, household_id, account_id, name, type, pin_hash, status, is_main, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
  );
  insertProfile.run(ids.adultAId, ids.householdAId, ids.accountId, '甲主档案', 'adult', '$argon2id$pin-a', 'active', 1, T0);
  insertProfile.run(ids.childAId, ids.householdAId, ids.accountId, '甲儿童', 'child', null, 'active', 0, T0);
  insertProfile.run(ids.adultBId, ids.householdBId, ids.accountBId, '乙主档案', 'adult', '$argon2id$pin-b', 'active', 1, T0);
  db.prepare("INSERT INTO device (id, household_id, type, created_at) VALUES (?, ?, 'tv', ?)").run(
    ids.deviceId,
    ids.householdAId,
    T0,
  );
  db.prepare(
    'INSERT INTO device_session (id, household_id, account_id, device_id, token_hash, expires_at, last_active_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
  ).run(ids.deviceSessionAId, ids.householdAId, ids.accountId, ids.deviceId, 'tok-vod-mig', FAR_FUTURE, T0, T0);
  // 阶段 3 目录:EPG 来源 + IPTV 来源(挂默认 EPG);乙家庭一个不挂 EPG 的 IPTV 源
  const insertSource = db.prepare(
    "INSERT INTO media_source (id, household_id, kind, name, remote_url, epg_source_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
  );
  insertSource.run(ids.epgSourceId, ids.householdAId, 'epg', '迁移EPG源', 'http://lan.example/guide.xml', null, T0, T0);
  insertSource.run(ids.iptvSourceId, ids.householdAId, 'iptv', '迁移IPTV源', 'http://lan.example/list.m3u8', ids.epgSourceId, T0, T0);
  insertSource.run(ids.iptvSourceBId, ids.householdBId, 'iptv', '邻家IPTV源', 'http://lan.example/neighbor.m3u8', null, T0, T0);
  // 媒体条目(甲两条/乙一条,乙用于跨家庭负向)
  const insertMedia = db.prepare(
    "INSERT INTO media_item (id, household_id, type, title, version, created_at, updated_at) VALUES (?, ?, 'channel', ?, 3, ?, ?)",
  );
  insertMedia.run(ids.mediaChannelAId, ids.householdAId, '频道甲一', T0, T0);
  insertMedia.run(ids.mediaChannelA2Id, ids.householdAId, '频道甲二', T0, T0);
  insertMedia.run(ids.mediaChannelBId, ids.householdBId, '邻家频道', T0, T0);
  // 身份稳定条目 + 静态播放资源(旧数据回填 static 的载体)
  db.prepare(
    "INSERT INTO source_entry (id, household_id, source_id, identity_kind, identity_digest, media_id, upstream_channel_id, present, first_seen_at, last_seen_at) VALUES (?, ?, ?, 'tvg_id', ?, ?, 'cctv-1', 1, ?, ?)",
  ).run(ids.entryId, ids.householdAId, ids.iptvSourceId, sha256(`tvg_id:cctv-1`), ids.mediaChannelAId, T0, T0);
  db.prepare(
    "INSERT INTO playback_source (id, household_id, source_id, source_entry_id, media_item_id, protocol, location, mime_type, priority, requires_proxy, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 'http', 'http://lan.example/stream/cctv-1.m3u8', 'application/vnd.apple.mpegurl', 100, 0, ?, ?)",
  ).run(ids.playbackSourceId, ids.householdAId, ids.iptvSourceId, ids.entryId, ids.mediaChannelAId, T0, T0);
  db.prepare('INSERT INTO catalog_state (household_id, revision) VALUES (?, ?)').run(ids.householdAId, 5);
  // 0005 播放会话(preparing 形态)
  db.prepare(
    "INSERT INTO playback_session (id, household_id, device_session_id, device_id, profile_id, media_id, state, generation, version, position_seconds, created_at, last_heartbeat_at) VALUES (?, ?, ?, ?, ?, ?, 'preparing', 1, 1, 0, ?, ?)",
  ).run(ids.playbackSessionAId, ids.householdAId, ids.deviceSessionAId, ids.deviceId, ids.adultAId, ids.mediaChannelAId, T0, T0);
  // 0006 个人历史一行(旧静态历史 completed 回填 false 的载体)
  db.prepare(
    'INSERT INTO profile_viewing_history (household_id, profile_id, media_id, writer_epoch, writer_playback_session_id, last_sample_seq, content_revision, position_seconds, duration_seconds, last_viewed_at, revision) VALUES (?, ?, ?, 1, ?, 3, 1, 12.5, 100, ?, 1)',
  ).run(ids.householdAId, ids.adultAId, ids.mediaChannelAId, ids.playbackSessionAId, T1);
  return ids;
}

async function buildStage6Rig(): Promise<{ rig: TestRig; f: Stage6Fixture }> {
  const rig = await startFreshApp({ prefix: 'hmp-online-vod-mig-', migrations: BASE_MIGRATIONS });
  const f = injectStage6();
  return { rig, f };
}

/* ------------------------------------------------------------------ */
/* 快照:既有列逐值比对(显式列清单,允许 up 新增列)                    */
/* ------------------------------------------------------------------ */

/** 0007 up/down 不得改动其值的既有列(按表列出;新增/回填列不在清单内) */
const LEGACY_SNAPSHOT_COLUMNS: Readonly<Record<string, readonly string[]>> = {
  household: ['id', 'name', 'created_at'],
  account: ['id', 'household_id', 'username', 'role', 'created_at'],
  profile: ['id', 'household_id', 'name', 'type', 'status', 'created_at'],
  device: ['id', 'household_id', 'type', 'created_at'],
  device_session: ['id', 'household_id', 'account_id', 'device_id', 'expires_at', 'created_at'],
  media_source: [
    'id',
    'household_id',
    'kind',
    'name',
    'remote_url',
    'epg_source_id',
    'enabled',
    'version',
    'created_at',
    'updated_at',
  ],
  media_item: ['id', 'household_id', 'type', 'title', 'version', 'created_at', 'updated_at'],
  source_entry: [
    'id',
    'household_id',
    'source_id',
    'identity_kind',
    'identity_digest',
    'media_id',
    'present',
    'first_seen_at',
    'last_seen_at',
  ],
  playback_source: [
    'id',
    'household_id',
    'source_id',
    'source_entry_id',
    'media_item_id',
    'protocol',
    'location',
    'mime_type',
    'priority',
    'requires_proxy',
    'created_at',
    'updated_at',
  ],
  playback_session: [
    'id',
    'household_id',
    'device_session_id',
    'device_id',
    'profile_id',
    'media_id',
    'state',
    'generation',
    'version',
    'position_seconds',
    'created_at',
    'last_heartbeat_at',
  ],
  profile_viewing_history: [
    'household_id',
    'profile_id',
    'media_id',
    'writer_epoch',
    'writer_playback_session_id',
    'last_sample_seq',
    'content_revision',
    'position_seconds',
    'duration_seconds',
    'last_viewed_at',
    'revision',
  ],
};

function snapshotLegacyColumns(): string {
  const out: Record<string, unknown> = {};
  for (const [table, columns] of Object.entries(LEGACY_SNAPSHOT_COLUMNS)) {
    out[table] = Database.db.prepare(`SELECT ${columns.join(', ')} FROM ${table} ORDER BY rowid`).all();
  }
  return JSON.stringify(out);
}

/* ------------------------------------------------------------------ */
/* 结构断言:0007 新表关键列/唯一/FK/枚举(对照 data-model §2/§4~§7/§10) */
/* ------------------------------------------------------------------ */

interface ColumnSpec {
  name: string;
  /** 仅断言 data-model/冻结记录明确者:undefined = 不断言 */
  notnull?: 0 | 1;
  dflt?: string;
}

function c(name: string, extra: { notnull?: 0 | 1; dflt?: string } = {}): ColumnSpec {
  return { name, ...extra };
}

/** 关键列存在性 + 明确冻结的可空性/默认值(不逐表断言完整列集合:允许实现补审计列) */
const EXPECTED_COLUMNS: Readonly<Record<string, readonly ColumnSpec[]>> = {
  // §2 来源/目录扩展与六张目录表
  media_source: [c('locator_revision', { notnull: 1 })],
  media_item: [c('media_role', { notnull: 1 })],
  playback_source: [c('locator_kind', { notnull: 1 }), c('vod_episode_id', { notnull: 0 })],
  vod_source_config: [c('source_id'), c('adapter')],
  vod_title: [
    c('id'),
    c('source_id'),
    c('upstream_vod_id'),
    c('parent_media_id'),
    c('current_detail_revision'),
    c('materialized_at'),
  ],
  vod_line: [c('id'), c('title_id'), c('line_key'), c('display_name'), c('sort_order')],
  vod_episode: [
    c('id'),
    c('line_id'),
    c('episode_key'),
    c('label'),
    c('media_id'),
    c('content_version_state'),
    c('evidence_kind'),
    c('continuity_revision'),
  ],
  vod_detail_snapshot: [
    c('title_id'),
    c('revision'),
    c('locator_revision'),
    c('validated_private_payload'),
    c('fetched_at'),
    c('expires_at'),
  ],
  vod_episode_sequence: [
    c('title_id'),
    c('line_id'),
    c('detail_revision'),
    c('sequence_revision'),
    c('episode_id'),
    c('season_key'),
    c('ordinal'),
    c('sequence_status'),
  ],
  media_relation: [c('parent_id'), c('child_id'), c('kind'), c('sort_order')],
  // §4 物化幂等(+§10 登记候选)
  vod_materialization_operation: [
    c('id'),
    c('device_session_id'),
    c('profile_context_version'),
    c('profile_id'),
    c('operation_key'),
    c('request_digest'),
    c('committed_at'),
    c('expires_at'),
  ],
  vod_registered_candidate: [
    c('registered_candidate_ref'),
    c('candidate_ref'),
    c('device_session_id'),
    c('profile_id'),
    c('profile_context_version'),
    c('materialization_operation_id'),
    c('preview_revision'),
    c('created_at'),
    c('expires_at'),
  ],
  // §6 固定输入(frozen_start_seconds nullable 直到 probe)
  playback_input_binding: [
    c('session_id'),
    c('generation'),
    c('playback_source_id'),
    c('source_id'),
    c('locator_revision'),
    c('detail_revision'),
    c('content_revision'),
    c('continuity_revision'),
    c('resolved_input_id'),
    c('start_basis'),
    c('frozen_start_seconds', { notnull: 0 }),
    c('cleanup_state'),
    c('cleanup_requested'),
  ],
  // §5 观测/receipt
  playback_phase_observation: [
    c('session_id'),
    c('generation'),
    c('event_seq'),
    c('event_type'),
    c('digest'),
    c('server_received_at'),
  ],
  playback_finish_receipt: [
    c('session_id'),
    c('generation'),
    c('operation_key'),
    c('request_digest'),
    c('final_seq'),
    c('final_session_accepted'),
    c('history_applied'),
    c('history_revision'),
    c('session_completed'),
    c('auto_next_eligible'),
    c('reason'),
    c('ended_at'),
  ],
  // §7 单后继槽与意图(+§10 冻结快照/checkpoint)
  playback_transition_slot: [
    c('from_session_id'),
    c('from_generation'),
    c('slot_revision'),
    c('status'),
    c('active_intent_id'),
    c('successor_session_id'),
  ],
  playback_transition_intent: [
    c('id'),
    c('from_session_id'),
    c('from_generation'),
    c('device_session_id'),
    c('profile_id'),
    c('profile_context_version'),
    c('action'),
    c('target_media_id'),
    c('match_revision'),
    c('match_confidence'),
    c('confirmed_ambiguous'),
    c('finish_receipt_id'),
    c('operation_key'),
    c('request_digest'),
    c('slot_revision'),
    c('status'),
    c('successor_id'),
    c('next_plan_id'),
    c('source_checkpoint_generation'),
    c('source_checkpoint_seq'),
    c('allow_earlier_accepted_position'),
  ],
  // §10 下一集计划
  playback_next_plan: [
    c('id'),
    c('ref'),
    c('from_session_id'),
    c('from_generation'),
    c('action'),
    c('target_media_id'),
    c('sequence_revision'),
    c('detail_revision'),
    c('history_revision'),
    c('history_choice_required'),
    c('created_at'),
    c('expires_at'),
  ],
  // §5/§10 偏好与偏好操作
  profile_vod_preferences: [
    c('profile_id'),
    c('autoplay_next', { dflt: '1' }),
    c('switch_carry_position', { dflt: '1' }),
    c('version'),
  ],
  profile_vod_preference_operation: [
    c('id'),
    c('device_session_id'),
    c('profile_id'),
    c('profile_context_version'),
    c('operation_key'),
    c('request_digest'),
    c('result_json'),
    c('committed_at'),
    c('expires_at'),
  ],
};

/** 家庭复合外键矩阵:全部 (household_id, <列>) → <表>(household_id, id) */
const EXPECTED_FKS: Readonly<Record<string, readonly FkExpectation[]>> = {
  vod_source_config: [{ toTable: 'media_source', from: ['household_id', 'source_id'], to: ['household_id', 'id'] }],
  vod_title: [
    { toTable: 'media_source', from: ['household_id', 'source_id'], to: ['household_id', 'id'] },
    { toTable: 'media_item', from: ['household_id', 'parent_media_id'], to: ['household_id', 'id'] },
  ],
  vod_line: [{ toTable: 'vod_title', from: ['household_id', 'title_id'], to: ['household_id', 'id'] }],
  vod_episode: [
    { toTable: 'vod_line', from: ['household_id', 'line_id'], to: ['household_id', 'id'] },
    { toTable: 'media_item', from: ['household_id', 'media_id'], to: ['household_id', 'id'] },
  ],
  vod_detail_snapshot: [{ toTable: 'vod_title', from: ['household_id', 'title_id'], to: ['household_id', 'id'] }],
  vod_episode_sequence: [
    { toTable: 'vod_title', from: ['household_id', 'title_id'], to: ['household_id', 'id'] },
    { toTable: 'vod_line', from: ['household_id', 'line_id'], to: ['household_id', 'id'] },
    { toTable: 'vod_episode', from: ['household_id', 'episode_id'], to: ['household_id', 'id'] },
  ],
  media_relation: [
    { toTable: 'media_item', from: ['household_id', 'parent_id'], to: ['household_id', 'id'] },
    { toTable: 'media_item', from: ['household_id', 'child_id'], to: ['household_id', 'id'] },
  ],
  vod_materialization_operation: [
    { toTable: 'device_session', from: ['household_id', 'device_session_id'], to: ['household_id', 'id'] },
    { toTable: 'profile', from: ['household_id', 'profile_id'], to: ['household_id', 'id'] },
    { toTable: 'media_item', from: ['household_id', 'parent_media_id'], to: ['household_id', 'id'] },
  ],
  vod_registered_candidate: [
    { toTable: 'vod_materialization_operation', from: ['household_id', 'materialization_operation_id'], to: ['household_id', 'id'] },
    { toTable: 'device_session', from: ['household_id', 'device_session_id'], to: ['household_id', 'id'] },
    { toTable: 'profile', from: ['household_id', 'profile_id'], to: ['household_id', 'id'] },
  ],
  playback_input_binding: [
    { toTable: 'playback_session', from: ['household_id', 'session_id'], to: ['household_id', 'id'] },
    { toTable: 'playback_source', from: ['household_id', 'playback_source_id'], to: ['household_id', 'id'] },
    { toTable: 'media_source', from: ['household_id', 'source_id'], to: ['household_id', 'id'] },
  ],
  playback_phase_observation: [
    { toTable: 'playback_session', from: ['household_id', 'session_id'], to: ['household_id', 'id'] },
  ],
  playback_finish_receipt: [
    { toTable: 'playback_session', from: ['household_id', 'session_id'], to: ['household_id', 'id'] },
  ],
  playback_transition_slot: [
    { toTable: 'playback_session', from: ['household_id', 'from_session_id'], to: ['household_id', 'id'] },
  ],
  playback_transition_intent: [
    { toTable: 'playback_session', from: ['household_id', 'from_session_id'], to: ['household_id', 'id'] },
    { toTable: 'media_item', from: ['household_id', 'target_media_id'], to: ['household_id', 'id'] },
    { toTable: 'playback_next_plan', from: ['household_id', 'next_plan_id'], to: ['household_id', 'id'] },
  ],
  playback_next_plan: [
    { toTable: 'playback_session', from: ['household_id', 'from_session_id'], to: ['household_id', 'id'] },
    { toTable: 'media_item', from: ['household_id', 'target_media_id'], to: ['household_id', 'id'] },
  ],
  profile_vod_preferences: [{ toTable: 'profile', from: ['household_id', 'profile_id'], to: ['household_id', 'id'] }],
  profile_vod_preference_operation: [
    { toTable: 'device_session', from: ['household_id', 'device_session_id'], to: ['household_id', 'id'] },
    { toTable: 'profile', from: ['household_id', 'profile_id'], to: ['household_id', 'id'] },
  ],
};

/** 唯一约束按列集(唯一键都带家庭;名称无关:data-model 只规定列集) */
const EXPECTED_UNIQUES: Readonly<Record<string, readonly string[][]>> = {
  vod_source_config: [['household_id', 'source_id']], // 一源一行
  vod_title: [
    ['household_id', 'source_id', 'upstream_vod_id'],
    ['household_id', 'parent_media_id'], // parent_media_id 唯一
  ],
  vod_line: [['household_id', 'title_id', 'line_key']],
  vod_episode: [
    ['household_id', 'line_id', 'episode_key'],
    ['household_id', 'media_id'],
  ],
  vod_detail_snapshot: [['household_id', 'title_id', 'revision']], // (title_id,revision) 唯一
  vod_materialization_operation: [['household_id', 'device_session_id', 'profile_context_version', 'operation_key']],
  vod_registered_candidate: [['household_id', 'materialization_operation_id', 'candidate_ref']],
  playback_finish_receipt: [
    ['household_id', 'session_id'], // session_id 唯一 receipt
    ['household_id', 'device_session_id', 'profile_context_version', 'operation_key'], // 另一唯一幂等索引
  ],
  playback_transition_slot: [['household_id', 'from_session_id', 'from_generation']],
  playback_transition_intent: [['household_id', 'device_session_id', 'profile_context_version', 'operation_key']],
  profile_vod_preferences: [['household_id', 'profile_id']], // 每 Profile 唯一
  profile_vod_preference_operation: [['household_id', 'device_session_id', 'profile_context_version', 'operation_key']],
  media_relation: [['household_id', 'child_id']], // child 唯一父
};

/** 枚举/判别互斥:CREATE TABLE sql 必须包含的值面(kinds/status/action/basis 判别) */
const EXPECTED_ENUM_LITERALS: Readonly<Record<string, readonly string[]>> = {
  media_source: ["'vod'"],
  media_item: ["'standalone'", "'vod_title'", "'vod_episode'"],
  playback_source: ["'static'", "'online'", "'hls'"],
  vod_source_config: ["'apple-cms-json'"],
  vod_episode: ["'verified'", "'unverified'"],
  vod_episode_sequence: ["'ordered'", "'ambiguous'", "'special'"],
  media_relation: ["'vod_episode'"],
  playback_input_binding: ["'beginning'", "'target_history'", "'transition_carry'"],
  playback_transition_slot: ["'open'", "'reserved'", "'consumed'"],
  playback_transition_intent: [
    "'next'",
    "'manual_next'",
    "'switch'",
    "'recover_switch'",
    "'pending'",
    "'cancelled'",
    "'superseded'",
    "'expired'",
    "'consumed'",
  ],
};

/** 全部结构断言(升级后与 down→up 再升级后复用) */
function assertOnlineVodStructure(): void {
  const db = Database.db;
  for (const table of ONLINE_VOD_TABLES) {
    expect(tableExists(table), `表 ${table} 应存在`).toBe(true);
    expect(masterSql(table), `${table} 应为 CREATE TABLE 且含 CHECK 约束`).toContain('CHECK');
  }
  // 关键列:存在 + 冻结的可空性/默认值
  for (const [table, expected] of Object.entries(EXPECTED_COLUMNS)) {
    const info = db.pragma(`table_info(${table})`) as ColumnInfo[];
    for (const exp of expected) {
      const actual = info.find((column) => column.name === exp.name);
      expect(actual, `${table}.${exp.name} 应存在`).toBeDefined();
      if (exp.notnull !== undefined) {
        expect(actual?.notnull, `${table}.${exp.name} NOT NULL=${exp.notnull}`).toBe(exp.notnull);
      }
      if (exp.dflt !== undefined) {
        expect(normalizeDflt(actual?.dflt_value), `${table}.${exp.name} 默认值`).toBe(exp.dflt);
      }
    }
  }
  // 既有实体扩展列
  expect(columnOf('profile_viewing_history', 'completed')?.notnull, 'history.completed NOT NULL').toBe(1);
  expect(normalizeDflt(columnOf('profile_viewing_history', 'completed')?.dflt_value), 'history.completed 默认 false').toBe('0');
  expect(columnOf('profile_viewing_history', 'continuity_revision'), 'history.continuity_revision 应存在').toBeDefined();
  expect(columnOf('profile_viewing_history', 'evidence_state'), 'history.evidence_state 应存在').toBeDefined();
  expect(columnOf('profile_viewing_history', 'evidence_digest'), 'history.evidence_digest 应存在').toBeDefined();
  expect(columnOf('playback_progress_state', 'continuity_revision'), 'progress_state.continuity_revision 应存在').toBeDefined();
  expect(columnOf('playback_progress_state', 'ledger_position'), 'progress_state.ledger_position 应存在').toBeDefined();
  expect(columnOf('playback_progress_state', 'ledger_duration'), 'progress_state.ledger_duration 应存在').toBeDefined();
  expect(columnOf('playback_progress_state', 'ledger_generation'), 'progress_state.ledger_generation 应存在').toBeDefined();
  expect(columnOf('playback_progress_state', 'ledger_accepted_at'), 'progress_state.ledger_accepted_at 应存在').toBeDefined();
  expect(columnOf('playback_progress_state', 'session_started'), 'progress_state.session_started 应存在').toBeDefined();
  expect(columnOf('playback_progress_state', 'last_result'), 'progress_state.last_result 应存在').toBeDefined();
  expect(columnOf('playback_session', 'playback_started_at')?.notnull, 'session.playback_started_at 可空').toBe(0);
  expect(columnOf('playback_session', 'cleanup_requested'), 'session.cleanup_requested 应存在').toBeDefined();
  expect(columnOf('playback_session', 'cleanup_reason'), 'session.cleanup_reason 应存在').toBeDefined();
  // 唯一约束按列集
  for (const [table, uniques] of Object.entries(EXPECTED_UNIQUES)) {
    for (const cols of uniques) {
      expect(
        findUniqueIndex(table, cols),
        `${table} 应有唯一索引 (${cols.join(', ')})`,
      ).toBeDefined();
    }
  }
  // 家庭复合外键
  for (const [table, fks] of Object.entries(EXPECTED_FKS)) {
    for (const fk of fks) {
      expectCompositeFk(table, fk);
    }
  }
  // 枚举/判别值面
  for (const [table, literals] of Object.entries(EXPECTED_ENUM_LITERALS)) {
    const sql = masterSql(table);
    for (const literal of literals) {
      expect(sql, `${table} CHECK 应含枚举值 ${literal}`).toContain(literal);
    }
  }
}

/* ------------------------------------------------------------------ */
/* 测试                                                               */
/* ------------------------------------------------------------------ */

describe('0007_online_vod 迁移升级/回滚/约束(T007 · TDD 红阶段预期失败,待 T014 落地转绿)', () => {
  beforeEach(() => {
    Database.close();
  });
  afterEach(cleanupRigs);

  describe('升级路径:0001~0006 库应用 0007(旧数据回填,data-model §8)', () => {
    it('旧静态 locator 回填 static、旧媒体角色回填 standalone、旧历史 completed 回填 0;既有列逐值不变', async () => {
      await buildStage6Rig();
      const legacyBefore = snapshotLegacyColumns();
      for (const table of ONLINE_VOD_TABLES) {
        expect(tableExists(table), `升级前不应存在 ${table}`).toBe(false);
      }

      applyOnlineVod();

      expect(appliedMigrations()).toEqual(ALL_MIGRATIONS);
      for (const table of ONLINE_VOD_TABLES) {
        expect(tableExists(table), `升级后应存在 ${table}`).toBe(true);
      }
      // 回填:旧 IPTV/EPG 源获得 locator_revision(>=1);旧媒体全部 standalone;旧资源全部 static
      for (const row of Database.db.prepare('SELECT locator_revision FROM media_source').all() as {
        locator_revision: number;
      }[]) {
        expect(row.locator_revision, '旧来源 locator_revision 回填且 >= 1').toBeGreaterThanOrEqual(1);
      }
      for (const row of Database.db.prepare('SELECT media_role FROM media_item').all() as { media_role: string }[]) {
        expect(row.media_role, '旧媒体角色回填 standalone').toBe('standalone');
      }
      for (const row of Database.db
        .prepare('SELECT locator_kind, vod_episode_id, location FROM playback_source')
        .all() as { locator_kind: string; vod_episode_id: string | null; location: string }[]) {
        expect(row.locator_kind, '旧资源 locator_kind 回填 static').toBe('static');
        expect(row.vod_episode_id, 'static 资源不得携带 vod 引用').toBeNull();
        expect(row.location, 'static 资源 location 非空').not.toBeNull();
      }
      // 旧静态历史 completed 默认 false;旧记录不冒充在线 continuity 证据(evidence 为空)
      const historyRow = Database.db.prepare('SELECT completed FROM profile_viewing_history').get() as
        | { completed: number }
        | undefined;
      expect(historyRow, '升级前注入的历史行应保留').toBeDefined();
      expect(historyRow?.completed).toBe(0);
      // 旧会话:playback_started_at 为空(未起播);cleanup_requested 空/0
      const sessionRow = Database.db
        .prepare('SELECT playback_started_at, cleanup_requested FROM playback_session')
        .get() as { playback_started_at: string | null; cleanup_requested: number | null };
      expect(sessionRow.playback_started_at).toBeNull();
      expect(sessionRow.cleanup_requested === null || sessionRow.cleanup_requested === 0).toBe(true);
      // up 对既有列零修改
      expect(snapshotLegacyColumns()).toBe(legacyBefore);
      expectIntegrityOk();
    });

    it('回填列形态:locator_revision/media_role/locator_kind NOT NULL;completed 默认 0', async () => {
      await buildStage6Rig();
      applyOnlineVod();

      expect(columnOf('media_source', 'locator_revision')?.notnull).toBe(1);
      expect(columnOf('media_item', 'media_role')?.notnull).toBe(1);
      expect(columnOf('playback_source', 'locator_kind')?.notnull).toBe(1);
      expect(columnOf('playback_source', 'vod_episode_id')?.notnull).toBe(0);
      expect(normalizeDflt(columnOf('profile_viewing_history', 'completed')?.dflt_value)).toBe('0');
      expectIntegrityOk();
    });
  });

  describe('结构与约束(sqlite_master + PRAGMA,对照 data-model §2/§4~§7/§10)', () => {
    it('17 张新表存在,关键列落位(含审查补充 preference_operation/next_plan/registered_candidate)', async () => {
      await buildStage6Rig();
      applyOnlineVod();

      assertOnlineVodStructure();
      expectIntegrityOk();
    });

    it('家庭复合外键逐项存在:跨家庭引用在结构上不可表达', async () => {
      await buildStage6Rig();
      applyOnlineVod();

      for (const [table, fks] of Object.entries(EXPECTED_FKS)) {
        for (const fk of fks) {
          expectCompositeFk(table, fk);
        }
      }
      expectIntegrityOk();
    });

    it('唯一约束按列集存在:目录身份/线路/集/快照/receipt session 唯一/幂等四元组等', async () => {
      await buildStage6Rig();
      applyOnlineVod();

      for (const [table, uniques] of Object.entries(EXPECTED_UNIQUES)) {
        for (const cols of uniques) {
          expect(findUniqueIndex(table, cols), `${table} 唯一 (${cols.join(', ')})`).toBeDefined();
        }
      }
      expectIntegrityOk();
    });

    it('枚举与判别互斥 CHECK 落位(media_role/sequence_status/slot/intent status+action/start_basis/locator_kind)', async () => {
      await buildStage6Rig();
      applyOnlineVod();

      for (const [table, literals] of Object.entries(EXPECTED_ENUM_LITERALS)) {
        const sql = masterSql(table);
        for (const literal of literals) {
          expect(sql, `${table} CHECK 应含枚举值 ${literal}`).toContain(literal);
        }
      }
      expectIntegrityOk();
    });
  });

  describe('数据层约束负向(隔离副本直写 SQL)', () => {
    it('media_source kind=vod:接受合法 vod 源;无 remote_url/挂 EPG/locator_revision=0 被拒', async () => {
      const { f } = await buildStage6Rig();
      applyOnlineVod();

      // 合法:vod 必须 remote_url 非空、EPG 绑定为空
      const vodSourceId = randomUUID();
      insertRow('media_source', {
        id: vodSourceId,
        household_id: f.householdAId,
        kind: 'vod',
        name: '点播源甲',
        remote_url: 'http://lan.example/vod/cms.json',
        created_at: T0,
        updated_at: T0,
      });
      const locatorRevision = (
        Database.db.prepare('SELECT locator_revision FROM media_source WHERE id = ?').get(vodSourceId) as {
          locator_revision: number;
        }
      ).locator_revision;
      expect(locatorRevision, '新建 vod 源 locator_revision 初值 >= 1').toBeGreaterThanOrEqual(1);

      expectConstraintReject(
        () =>
          insertRow('media_source', {
            id: randomUUID(),
            household_id: f.householdAId,
            kind: 'vod',
            name: '无地址点播源',
            remote_url: null,
            created_at: T0,
            updated_at: T0,
          }),
        'vod 源缺 remote_url',
      );
      expectConstraintReject(
        () =>
          insertRow('media_source', {
            id: randomUUID(),
            household_id: f.householdAId,
            kind: 'vod',
            name: '挂EPG点播源',
            remote_url: 'http://lan.example/vod/cms.json',
            epg_source_id: f.epgSourceId,
            created_at: T0,
            updated_at: T0,
          }),
        'vod 源挂 EPG 绑定',
        { foreignKey: false },
      );
      expectConstraintReject(
        () =>
          insertRow('media_source', {
            id: randomUUID(),
            household_id: f.householdAId,
            kind: 'vod',
            name: '零代点播源',
            remote_url: 'http://lan.example/vod/cms.json',
            locator_revision: 0,
            created_at: T0,
            updated_at: T0,
          }),
        'locator_revision >= 1',
      );
      expectIntegrityOk();
    });

    it('playback_source 判别互斥:static 行改为 online 或非法值被拒(旧行 location 非空/vod 引用空)', async () => {
      const { f } = await buildStage6Rig();
      applyOnlineVod();

      const update = Database.db.prepare('UPDATE playback_source SET locator_kind = ? WHERE id = ?');
      expectConstraintReject(
        () => update.run('online', f.playbackSourceId),
        'static 旧行(location 非空/vod 引用空)不得改判 online',
      );
      expectConstraintReject(() => update.run('bogus', f.playbackSourceId), 'locator_kind 非法值');
      // 原值未被破坏
      const row = Database.db
        .prepare('SELECT locator_kind FROM playback_source WHERE id = ?')
        .get(f.playbackSourceId) as { locator_kind: string };
      expect(row.locator_kind).toBe('static');
      expectIntegrityOk();
    });

    it('media_item.media_role:非法角色被拒,合法三值可写', async () => {
      const { f } = await buildStage6Rig();
      applyOnlineVod();

      const update = Database.db.prepare('UPDATE media_item SET media_role = ? WHERE id = ?');
      expectConstraintReject(() => update.run('movie', f.mediaChannelAId), 'media_role 非枚举值(movie 是 type 不是 role)');
      expectConstraintReject(() => update.run('vod', f.mediaChannelAId), 'media_role 非枚举值');
      for (const role of ['standalone', 'vod_title', 'vod_episode']) {
        update.run(role, f.mediaChannelAId);
      }
      update.run('standalone', f.mediaChannelAId);
      expectIntegrityOk();
    });

    it('vod_source_config:一源一行;adapter 固定 apple-cms-json;跨家庭 source 被拒', async () => {
      const { f } = await buildStage6Rig();
      applyOnlineVod();
      // 两家庭各建一个合法 vod 源作为 FK 目标
      const vodSourceA = randomUUID();
      const vodSourceB = randomUUID();
      const insertSource = Database.db.prepare(
        "INSERT INTO media_source (id, household_id, kind, name, remote_url, created_at, updated_at) VALUES (?, ?, 'vod', ?, 'http://lan.example/vod/cms.json', ?, ?)",
      );
      insertSource.run(vodSourceA, f.householdAId, '点播源甲', T0, T0);
      insertSource.run(vodSourceB, f.householdBId, '邻家点播源', T0, T0);

      insertRow('vod_source_config', {
        household_id: f.householdAId,
        source_id: vodSourceA,
        adapter: 'apple-cms-json',
      });
      expectConstraintReject(
        () =>
          insertRow('vod_source_config', {
            household_id: f.householdAId,
            source_id: vodSourceA,
            adapter: 'apple-cms-json',
          }),
        '一源一行:重复配置',
      );
      expectConstraintReject(
        () =>
          insertRow('vod_source_config', {
            household_id: f.householdAId,
            source_id: randomUUID(),
            adapter: 'apple-cms-json',
          }),
        '无对应来源的悬空配置',
        { foreignKey: true },
      );
      expectConstraintReject(
        () =>
          insertRow('vod_source_config', {
            household_id: f.householdAId,
            source_id: vodSourceB,
            adapter: 'apple-cms-json',
          }),
        'source_id 指向乙家庭来源',
        { foreignKey: true },
      );
      expectConstraintReject(
        () =>
          insertRow('vod_source_config', {
            household_id: f.householdAId,
            source_id: randomUUID(),
            adapter: 'xmltv-json',
          }),
        'adapter 仅 apple-cms-json',
      );
      expectIntegrityOk();
    });

    it('vod_title:(source_id,upstream_vod_id) 唯一;parent_media_id 唯一;跨家庭 source/parent 被拒', async () => {
      const { f } = await buildStage6Rig();
      applyOnlineVod();
      const vodSourceA = randomUUID();
      const insertSource = Database.db.prepare(
        "INSERT INTO media_source (id, household_id, kind, name, remote_url, created_at, updated_at) VALUES (?, ?, 'vod', ?, 'http://lan.example/vod/cms.json', ?, ?)",
      );
      insertSource.run(vodSourceA, f.householdAId, '点播源甲', T0, T0);
      // 父媒体:movie + vod_title 角色
      const parentMediaId = randomUUID();
      insertRow('media_item', {
        id: parentMediaId,
        household_id: f.householdAId,
        type: 'movie',
        title: '点播影片甲',
        version: 1,
        media_role: 'vod_title',
        created_at: T0,
        updated_at: T0,
      });
      const titleRow = (overrides: Row): Row => ({
        id: randomUUID(),
        household_id: f.householdAId,
        source_id: vodSourceA,
        upstream_vod_id: 'up-vod-1',
        parent_media_id: parentMediaId,
        current_detail_revision: 1,
        materialized_at: T1,
        ...overrides,
      });

      insertRow('vod_title', titleRow({}));
      expectConstraintReject(
        () => insertRow('vod_title', titleRow({ parent_media_id: f.mediaChannelAId })),
        '(source_id,upstream_vod_id) 唯一',
      );
      expectConstraintReject(
        () => insertRow('vod_title', titleRow({ upstream_vod_id: 'up-vod-2' })),
        'parent_media_id 唯一(一部父媒体至多一个标题)',
      );
      expectConstraintReject(
        // 客观修正:SQLite 在单条 INSERT 上先检 UNIQUE 后检 FK(实测),而 titleRow 默认
        // parent_media_id 已被首行占用,(hhA,parent) 唯一索引必先触发,FK 断言永不可达;
        // 改用夹具中未被占用的同家庭频道 mediaChannelA2Id 作父,使本行唯一违例仅有
        // 「source_id 指向乙家庭来源」的外键违反,断言意图(跨家庭 source 被拒)保持不变。
        () => insertRow('vod_title', titleRow({ source_id: f.iptvSourceBId, parent_media_id: f.mediaChannelA2Id })),
        'source_id 指向乙家庭来源',
        { foreignKey: true },
      );
      expectConstraintReject(
        () => insertRow('vod_title', titleRow({ parent_media_id: f.mediaChannelBId, upstream_vod_id: 'up-vod-3' })),
        'parent_media_id 指向乙家庭媒体',
        { foreignKey: true },
      );
      expectIntegrityOk();
    });

    it('vod_line:(title_id,line_key) 唯一;跨家庭 title 被拒', async () => {
      const { f } = await buildStage6Rig();
      applyOnlineVod();
      const vodSourceA = randomUUID();
      Database.db.prepare(
        "INSERT INTO media_source (id, household_id, kind, name, remote_url, created_at, updated_at) VALUES (?, ?, 'vod', ?, 'http://lan.example/vod/cms.json', ?, ?)",
      ).run(vodSourceA, f.householdAId, '点播源甲', T0, T0);
      const parentMediaId = randomUUID();
      insertRow('media_item', {
        id: parentMediaId,
        household_id: f.householdAId,
        type: 'series',
        title: '点播剧集甲',
        version: 1,
        media_role: 'vod_title',
        created_at: T0,
        updated_at: T0,
      });
      const titleId = randomUUID();
      insertRow('vod_title', {
        id: titleId,
        household_id: f.householdAId,
        source_id: vodSourceA,
        upstream_vod_id: 'up-series-1',
        parent_media_id: parentMediaId,
        current_detail_revision: 1,
        materialized_at: T1,
      });
      const lineRow = (overrides: Row): Row => ({
        id: randomUUID(),
        household_id: f.householdAId,
        title_id: titleId,
        line_key: 'line-hd',
        display_name: '高清线路',
        sort_order: 1,
        ...overrides,
      });

      insertRow('vod_line', lineRow({}));
      insertRow('vod_line', lineRow({ line_key: 'line-sd', sort_order: 2 }));
      expectConstraintReject(() => insertRow('vod_line', lineRow({})), '(title_id,line_key) 唯一');
      expectConstraintReject(
        () => insertRow('vod_line', lineRow({ title_id: randomUUID() })),
        'title_id 悬空引用',
        { foreignKey: true },
      );
      expectIntegrityOk();
    });

    it('vod_episode:(line_id,episode_key) 与 media_id 唯一;跨家庭 media 被拒;状态枚举互斥', async () => {
      const { f } = await buildStage6Rig();
      applyOnlineVod();
      const vodSourceA = randomUUID();
      Database.db.prepare(
        "INSERT INTO media_source (id, household_id, kind, name, remote_url, created_at, updated_at) VALUES (?, ?, 'vod', ?, 'http://lan.example/vod/cms.json', ?, ?)",
      ).run(vodSourceA, f.householdAId, '点播源甲', T0, T0);
      const parentMediaId = randomUUID();
      insertRow('media_item', {
        id: parentMediaId,
        household_id: f.householdAId,
        type: 'series',
        title: '点播剧集甲',
        version: 1,
        media_role: 'vod_title',
        created_at: T0,
        updated_at: T0,
      });
      const titleId = randomUUID();
      insertRow('vod_title', {
        id: titleId,
        household_id: f.householdAId,
        source_id: vodSourceA,
        upstream_vod_id: 'up-series-1',
        parent_media_id: parentMediaId,
        current_detail_revision: 1,
        materialized_at: T1,
      });
      const lineId = randomUUID();
      insertRow('vod_line', {
        id: lineId,
        household_id: f.householdAId,
        title_id: titleId,
        line_key: 'line-hd',
        display_name: '高清线路',
        sort_order: 1,
      });
      const episodeMediaA = randomUUID();
      insertRow('media_item', {
        id: episodeMediaA,
        household_id: f.householdAId,
        type: 'episode',
        title: '第1集',
        version: 1,
        media_role: 'vod_episode',
        created_at: T0,
        updated_at: T0,
      });
      const episodeRow = (overrides: Row): Row => ({
        id: randomUUID(),
        household_id: f.householdAId,
        line_id: lineId,
        episode_key: '1',
        label: '第1集',
        media_id: episodeMediaA,
        content_version_state: 'unverified',
        ...overrides,
      });

      insertRow('vod_episode', episodeRow({}));
      expectConstraintReject(
        () => insertRow('vod_episode', episodeRow({ media_id: randomUUID() })),
        '(line_id,episode_key) 唯一',
      );
      expectConstraintReject(
        () => insertRow('vod_episode', episodeRow({ episode_key: '2' })),
        'media_id 唯一(一集一媒体)',
      );
      expectConstraintReject(
        () => insertRow('vod_episode', episodeRow({ episode_key: '3', media_id: f.mediaChannelBId })),
        'media_id 指向乙家庭媒体',
        { foreignKey: true },
      );
      expectConstraintReject(
        () => insertRow('vod_episode', episodeRow({ media_id: randomUUID(), content_version_state: 'corrupt' })),
        'content_version_state 枚举互斥',
      );
      expectIntegrityOk();
    });

    it('vod_episode_sequence:sequence_status 枚举 ordered/ambiguous/special 互斥', async () => {
      const { f } = await buildStage6Rig();
      applyOnlineVod();
      const vodSourceA = randomUUID();
      Database.db.prepare(
        "INSERT INTO media_source (id, household_id, kind, name, remote_url, created_at, updated_at) VALUES (?, ?, 'vod', ?, 'http://lan.example/vod/cms.json', ?, ?)",
      ).run(vodSourceA, f.householdAId, '点播源甲', T0, T0);
      const parentMediaId = randomUUID();
      insertRow('media_item', {
        id: parentMediaId,
        household_id: f.householdAId,
        type: 'series',
        title: '点播剧集甲',
        version: 1,
        media_role: 'vod_title',
        created_at: T0,
        updated_at: T0,
      });
      const titleId = randomUUID();
      insertRow('vod_title', {
        id: titleId,
        household_id: f.householdAId,
        source_id: vodSourceA,
        upstream_vod_id: 'up-series-1',
        parent_media_id: parentMediaId,
        current_detail_revision: 1,
        materialized_at: T1,
      });
      const lineId = randomUUID();
      insertRow('vod_line', {
        id: lineId,
        household_id: f.householdAId,
        title_id: titleId,
        line_key: 'line-hd',
        display_name: '高清线路',
        sort_order: 1,
      });
      const episodeMediaA = randomUUID();
      insertRow('media_item', {
        id: episodeMediaA,
        household_id: f.householdAId,
        type: 'episode',
        title: '第1集',
        version: 1,
        media_role: 'vod_episode',
        created_at: T0,
        updated_at: T0,
      });
      const episodeId = randomUUID();
      insertRow('vod_episode', {
        id: episodeId,
        household_id: f.householdAId,
        line_id: lineId,
        episode_key: '1',
        label: '第1集',
        media_id: episodeMediaA,
        content_version_state: 'unverified',
      });
      const sequenceRow = (overrides: Row): Row => ({
        household_id: f.householdAId,
        title_id: titleId,
        line_id: lineId,
        detail_revision: 1,
        sequence_revision: 1,
        episode_id: episodeId,
        season_key: 'S1',
        ordinal: 1,
        sequence_status: 'ordered',
        ...overrides,
      });

      for (const status of ['ordered', 'ambiguous', 'special']) {
        insertRow('vod_episode_sequence', sequenceRow({ sequence_revision: status === 'ordered' ? 1 : 2, sequence_status: status }));
      }
      expectConstraintReject(
        () => insertRow('vod_episode_sequence', sequenceRow({ sequence_revision: 3, sequence_status: 'guessed' })),
        'sequence_status 枚举互斥',
      );
      expectIntegrityOk();
    });

    it('media_relation:child 唯一父;自环被拒;跨家庭 parent/child 被拒;kind 固定 vod_episode', async () => {
      const { f } = await buildStage6Rig();
      applyOnlineVod();
      const parentMediaId = randomUUID();
      const parentMedia2Id = randomUUID();
      const episodeMediaA = randomUUID();
      const episodeMediaA2 = randomUUID();
      const insertEpisodeMedia = Database.db.prepare(
        "INSERT INTO media_item (id, household_id, type, title, version, media_role, created_at, updated_at) VALUES (?, ?, 'episode', ?, ?, 'vod_episode', ?, ?)",
      );
      insertRow('media_item', {
        id: parentMediaId,
        household_id: f.householdAId,
        type: 'series',
        title: '父剧集一',
        version: 1,
        media_role: 'vod_title',
        created_at: T0,
        updated_at: T0,
      });
      insertRow('media_item', {
        id: parentMedia2Id,
        household_id: f.householdAId,
        type: 'series',
        title: '父剧集二',
        version: 1,
        media_role: 'vod_title',
        created_at: T0,
        updated_at: T0,
      });
      // 客观修正:下方预编译 SQL 有 6 个占位符(id/household_id/title/version/created_at/
      // updated_at),原调用仅绑 4 参(漏 household_id 与 version),必然 RangeError。
      insertEpisodeMedia.run(episodeMediaA, f.householdAId, '子集一', 1, T0, T0);
      insertEpisodeMedia.run(episodeMediaA2, f.householdAId, '子集二', 1, T0, T0);

      insertRow('media_relation', {
        household_id: f.householdAId,
        parent_id: parentMediaId,
        child_id: episodeMediaA,
        kind: 'vod_episode',
        sort_order: 1,
      });
      expectConstraintReject(
        () =>
          insertRow('media_relation', {
            household_id: f.householdAId,
            parent_id: parentMedia2Id,
            child_id: episodeMediaA,
            kind: 'vod_episode',
            sort_order: 1,
          }),
        'child 唯一父(第二父被拒)',
      );
      expectConstraintReject(
        () =>
          insertRow('media_relation', {
            household_id: f.householdAId,
            parent_id: episodeMediaA2,
            child_id: episodeMediaA2,
            kind: 'vod_episode',
            sort_order: 1,
          }),
        '禁止自环',
      );
      expectConstraintReject(
        () =>
          insertRow('media_relation', {
            household_id: f.householdAId,
            parent_id: f.mediaChannelBId,
            child_id: episodeMediaA2,
            kind: 'vod_episode',
            sort_order: 1,
          }),
        'parent 指向乙家庭媒体',
        { foreignKey: true },
      );
      expectConstraintReject(
        () =>
          insertRow('media_relation', {
            household_id: f.householdAId,
            parent_id: parentMediaId,
            child_id: f.mediaChannelBId,
            kind: 'vod_episode',
            sort_order: 2,
          }),
        'child 指向乙家庭媒体',
        { foreignKey: true },
      );
      expectConstraintReject(
        () =>
          insertRow('media_relation', {
            household_id: f.householdAId,
            parent_id: parentMediaId,
            child_id: episodeMediaA2,
            kind: 'manual_link',
            sort_order: 1,
          }),
        'kind 固定 vod_episode',
      );
      expectIntegrityOk();
    });

    it('profile_vod_preferences:每 Profile 唯一;默认 true/true;持久 version>=1;跨家庭 Profile 被拒', async () => {
      const { f } = await buildStage6Rig();
      applyOnlineVod();

      insertRow('profile_vod_preferences', {
        household_id: f.householdAId,
        profile_id: f.adultAId,
        autoplay_next: 1,
        switch_carry_position: 1,
        version: 1,
      });
      expectConstraintReject(
        () =>
          insertRow('profile_vod_preferences', {
            household_id: f.householdAId,
            profile_id: f.adultAId,
            autoplay_next: 0,
            switch_carry_position: 0,
            version: 2,
          }),
        '每 Profile 唯一',
      );
      expectConstraintReject(
        () =>
          insertRow('profile_vod_preferences', {
            household_id: f.householdAId,
            profile_id: f.childAId,
            autoplay_next: 1,
            switch_carry_position: 1,
            version: 0,
          }),
        '持久 version>=1(未有行=0 只是传输初值)',
      );
      expectConstraintReject(
        () =>
          insertRow('profile_vod_preferences', {
            household_id: f.householdAId,
            profile_id: f.adultBId,
            autoplay_next: 1,
            switch_carry_position: 1,
            version: 1,
          }),
        'profile_id 指向乙家庭档案',
        { foreignKey: true },
      );
      // 默认 true/true:省略两个开关列仍落 true
      const defaultsRow = {
        household_id: f.householdAId,
        profile_id: f.childAId,
        version: 1,
      };
      insertRow('profile_vod_preferences', defaultsRow);
      const defaults = Database.db
        .prepare('SELECT autoplay_next, switch_carry_position FROM profile_vod_preferences WHERE profile_id = ?')
        .get(f.childAId) as { autoplay_next: number; switch_carry_position: number };
      expect(defaults.autoplay_next).toBe(1);
      expect(defaults.switch_carry_position).toBe(1);
      expectIntegrityOk();
    });

    it('profile_vod_preference_operation:幂等四元组唯一;跨家庭被拒;expires>=committed+24h', async () => {
      const { f } = await buildStage6Rig();
      applyOnlineVod();
      const operationRow = (overrides: Row): Row => ({
        id: randomUUID(),
        household_id: f.householdAId,
        device_session_id: f.deviceSessionAId,
        profile_id: f.adultAId,
        profile_context_version: 1,
        operation_key: randomUUID(),
        request_digest: sha256('pref-body-1'),
        result_json: '{"autoplayNext":true,"switchCarryPosition":true,"version":1}',
        committed_at: T1,
        expires_at: PLUS_25H,
        ...overrides,
      });

      const firstPreferenceOperation = operationRow({});
      insertRow('profile_vod_preference_operation', firstPreferenceOperation);
      expectConstraintReject(
        // 客观修正:operationRow 工厂每次调用都会生成全新 operation_key,重放行与本行
        // 四元组必不相同,唯一断言永不可达;修正为复用首行的幂等四元组、仅换 id(主键),
        // 使断言真正命中「唯一(家庭,device_session,context_version,operation_key)」。
        () =>
          insertRow('profile_vod_preference_operation', {
            ...firstPreferenceOperation,
            id: randomUUID(),
          }),
        '唯一(家庭,device_session,context_version,operation_key)',
      );
      expectConstraintReject(
        () => insertRow('profile_vod_preference_operation', operationRow({ profile_id: f.adultBId })),
        'profile_id 指向乙家庭档案',
        { foreignKey: true },
      );
      expectConstraintReject(
        () =>
          insertRow('profile_vod_preference_operation', operationRow({ expires_at: PLUS_23H })),
        'expires >= committed+24h(23h 拒绝)',
      );
      // 边界:恰 24h 合法
      insertRow('profile_vod_preference_operation', operationRow({ operation_key: randomUUID(), expires_at: PLUS_24H }));
      expectIntegrityOk();
    });
  });

  describe('回滚与再升级(空新表 down;审查补充对象回滚后消失)', () => {
    it('down 删除全部 0007 表与回填列且 kind=vod 恢复拒绝;0001~0006 数据逐值保留;再 up 结构恢复', async () => {
      await buildStage6Rig();
      applyOnlineVod();
      const legacyBefore = snapshotLegacyColumns();

      rollbackOnlineVod();

      // 0007 全部对象随 down 消失(含审查补充的 preference_operation/next_plan/registered_candidate)
      for (const table of ONLINE_VOD_TABLES) {
        expect(tableExists(table), `${table} 应回滚删除`).toBe(false);
      }
      expect(columnOf('media_source', 'locator_revision'), 'media_source.locator_revision 应回滚删除').toBeUndefined();
      expect(columnOf('media_item', 'media_role'), 'media_item.media_role 应回滚删除').toBeUndefined();
      expect(columnOf('playback_source', 'locator_kind'), 'playback_source.locator_kind 应回滚删除').toBeUndefined();
      expect(columnOf('playback_source', 'vod_episode_id'), 'playback_source.vod_episode_id 应回滚删除').toBeUndefined();
      expect(columnOf('profile_viewing_history', 'completed'), 'history.completed 应回滚删除').toBeUndefined();
      expect(columnOf('playback_session', 'playback_started_at'), 'session.playback_started_at 应回滚删除').toBeUndefined();
      expect(columnOf('playback_session', 'cleanup_requested'), 'session.cleanup_requested 应回滚删除').toBeUndefined();
      expect(appliedMigrations()).toEqual(BASE_MIGRATIONS);
      // 0001~0006 业务数据逐值保留
      expect(snapshotLegacyColumns()).toBe(legacyBefore);
      // down 恢复旧代际约束:kind=vod 不再是合法来源
      expectConstraintReject(
        () =>
          insertRow('media_source', {
            id: randomUUID(),
            household_id: randomUUID(),
            kind: 'vod',
            name: '回滚后点播源',
            remote_url: 'http://lan.example/vod/cms.json',
            created_at: T0,
            updated_at: T0,
          }),
        'down 后 kind=vod 恢复为非法值(旧 CHECK 重建)',
      );
      expectIntegrityOk();

      // 再 up:结构恢复、新表为空、旧数据仍不变
      applyOnlineVod();

      assertOnlineVodStructure();
      for (const table of ONLINE_VOD_TABLES) {
        expect((Database.db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n).toBe(0);
      }
      expect(snapshotLegacyColumns()).toBe(legacyBefore);
      expect(appliedMigrations()).toEqual(ALL_MIGRATIONS);
      expectIntegrityOk();
    });
  });

  describe('migrate.ts 目录发现全链(空库 up→down→up 与非空在线业务 down 拒绝)', () => {
    /** 独立 rig(不复用 test/helpers.ts):照 migration-0006.spec.ts 模式驱动 runMigrationCommand */
    interface ChainRig {
      dataDir: string;
      dbFilename: string;
      dbFile: string;
    }

    const chainRigs: ChainRig[] = [];

    function newChainRig(prefix: string): ChainRig {
      const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
      const dbFilename = `${randomUUID()}.hmp.db`;
      const rig: ChainRig = { dataDir, dbFilename, dbFile: path.join(dataDir, dbFilename) };
      chainRigs.push(rig);
      return rig;
    }

    function applyChainEnv(rig: ChainRig): void {
      setEnvOverride(loadEnv({ NODE_ENV: 'test', DATA_DIR: rig.dataDir, DB_FILENAME: rig.dbFilename }));
    }

    function userVersion(): number {
      return Database.db.pragma('user_version', { simple: true }) as number;
    }

    function tableNames(): string[] {
      return (
        Database.db
          .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")
          .all() as { name: string }[]
      ).map((row) => row.name);
    }

    /** 最小在线业务行:profile_vod_preferences(0007 新表,字段集完全冻结,插入零歧义) */
    function seedMinimalOnlineBusiness(): { householdId: string; profileId: string } {
      const householdId = randomUUID();
      const accountId = randomUUID();
      const profileId = randomUUID();
      Database.db.prepare('INSERT INTO household (id, name, created_at) VALUES (?, ?, ?)').run(householdId, 'down守卫家庭', T0);
      Database.db.prepare(
        'INSERT INTO account (id, household_id, username, username_normalized, password_hash, role, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
      ).run(accountId, householdId, 'guard', 'guard', '$argon2id$fixture-hash', 'owner', T0);
      Database.db.prepare(
        "INSERT INTO profile (id, household_id, account_id, name, type, pin_hash, status, is_main, created_at) VALUES (?, ?, ?, '守卫主档案', 'adult', 'pin', 'active', 1, ?)",
      ).run(profileId, householdId, accountId, T0);
      insertRow('profile_vod_preferences', {
        household_id: householdId,
        profile_id: profileId,
        autoplay_next: 1,
        switch_carry_position: 1,
        version: 1,
      });
      return { householdId, profileId };
    }

    afterAll(() => {
      while (chainRigs.length > 0) {
        const rig = chainRigs.pop();
        if (rig === undefined) break;
        fs.rmSync(rig.dataDir, { recursive: true, force: true });
      }
      Database.close();
      setEnvOverride(null);
    });

    it('空库 up→down→up:代际标记保持 2(0007 同属交付代际 2);0007 对象随 down 消失、随 up 恢复', () => {
      const rig = newChainRig('hmp-vod-chain-');
      applyChainEnv(rig);
      runMigrationCommand('up');
      // 冻结约定(0007 up.sql 末节):0007 属同一交付代际,up 后 user_version 仍为 2,
      // 就绪判别依赖「user_version=2 + _migrations 与迁移目录全量一致」而非代际递增。
      expect(userVersion(), '0007 up 后 user_version 保持 2').toBe(2);
      expect(appliedMigrations()).toEqual(ALL_MIGRATIONS);
      for (const table of ONLINE_VOD_TABLES) {
        expect(tableNames()).toContain(table);
      }

      runMigrationCommand('down');
      // down 后:记录恰为 0001~0006(0007 可再次 up),user_version 同为 2(交付代际不变)
      expect(userVersion()).toBe(2);
      expect(appliedMigrations()).toEqual(BASE_MIGRATIONS);
      for (const table of ONLINE_VOD_TABLES) {
        expect(tableNames(), `${table} 随 down 消失`).not.toContain(table);
      }
      expect(tableNames()).toEqual(expect.arrayContaining(['household', 'playback_session']));

      runMigrationCommand('up');
      expect(userVersion()).toBe(2);
      expect(appliedMigrations()).toEqual(ALL_MIGRATIONS);
      expect(tableNames()).toContain('vod_title');
      expect(tableNames()).toContain('profile_vod_preferences');
    });

    it('drill 一次通过且终态记录与目录一致(迁移已在 migrate.ts 注册)', () => {
      const rig = newChainRig('hmp-vod-drill-');
      applyChainEnv(rig);
      runMigrationCommand('drill');
      expect(userVersion()).toBe(2);
      expect(appliedMigrations()).toEqual(ALL_MIGRATIONS);
    });

    it('非空在线业务 down 拒绝:报错且表/行/迁移记录原样(破坏性删除保护)', () => {
      const rig = newChainRig('hmp-vod-down-guard-');
      applyChainEnv(rig);
      runMigrationCommand('up');
      const seeded = seedMinimalOnlineBusiness();

      // 空新表可 down(上一用例),非空在线业务必须拒绝破坏性删除
      expect(() => runMigrationCommand('down')).toThrowError();

      // 拒绝后原样:代际标记/迁移记录/表/行均未被破坏
      expect(userVersion()).toBe(2);
      expect(appliedMigrations()).toContain(MIGRATION);
      for (const table of ONLINE_VOD_TABLES) {
        expect(tableNames(), `${table} 应仍在`).toContain(table);
      }
      const prefRow = Database.db
        .prepare('SELECT autoplay_next, version FROM profile_vod_preferences WHERE household_id = ?')
        .get(seeded.householdId) as { autoplay_next: number; version: number } | undefined;
      expect(prefRow, '在线业务行应原样保留').toBeDefined();
      expect(prefRow?.autoplay_next).toBe(1);
      expect(prefRow?.version).toBe(1);
      expectIntegrityOk();
    });
  });
});
