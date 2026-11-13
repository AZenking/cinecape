import fs from 'node:fs';
import path from 'node:path';
import type DatabaseConstructor from 'better-sqlite3';
import { env } from '../config/env';
import { Database } from './database';
import {
  MigrationGateError,
  evaluateMigrationGate,
  precheckDatabaseFile,
} from './precheck';

/**
 * 迁移执行器(T009):`tsx src/platform/database/migrate.ts <up|down|drill>`
 *
 * - up:按目录名字典序应用所有未应用的迁移;
 * - down:逆序回滚最近一个已应用迁移;
 * - drill:up → down → up,结束必须全部已应用(SC-006 回滚演练);
 * - 每次 up/down 前,用 `VACUUM INTO` 生成一致性备份 `<db>.bak-<Date.now()>`
 *   (WAL 下 VACUUM INTO 产出已检查点的完整快照);
 * - 每条迁移与版本记录同事务提交;任何一步失败输出错误并以非零码退出。
 * - T007:任何命令在打开写连接之前先以只读方式预检旧库(precheck.ts),
 *   旧已初始化库/损坏/未知状态拒绝且不修改旧文件(不备份、不建 _migrations)。
 */

type DbHandle = DatabaseConstructor.Database;

interface MigrationFile {
  name: string;
  upPath: string;
  downPath: string;
}

/**
 * drill 结束时必须全部存在的表(阶段 1/2/3 业务表 + 0004/0005 增补表 + 版本表;
 * 阶段 3 对照 003 data-model.md,0005 对照 004 data-model.md 四节,
 * 0006 对照 005 data-model.md §3~§7 五张新表)
 */
const EXPECTED_TABLES = [
  'household',
  'account',
  'profile',
  'device',
  'device_session',
  'profile_policy',
  'parent_verification_state',
  'catalog_state',
  'media_source',
  'media_item',
  'source_entry',
  'playback_source',
  'epg_channel',
  'epg_programme',
  'source_refresh',
  'refresh_stage_entry',
  'manual_epg_binding',
  // 0005_playback(T009):受控播放四表
  'playback_session',
  'playback_ticket',
  'playback_conversion',
  'playback_failure_event',
  // 0006_pc_experience(T006,数据代际 2):个人观看体验五表
  'settings_access_grant',
  'profile_channel_favorite',
  'profile_progress_clock',
  'playback_progress_state',
  'profile_viewing_history',
  // 0007_online_vod(T014,010):来源/目录/个人/播放新表
  'vod_source_config',
  'media_relation',
  'vod_title',
  'vod_line',
  'vod_episode',
  'vod_detail_snapshot',
  'vod_episode_sequence',
  'vod_materialization_operation',
  'vod_registered_candidate',
  'profile_vod_preferences',
  'profile_vod_preference_operation',
  'playback_phase_observation',
  'playback_finish_receipt',
  'playback_next_plan',
  'playback_input_binding',
  'playback_transition_intent',
  'playback_transition_slot',
  // 0008_profile_preferences(013):个人偏好表
  'profile_preferences',
  // 0009_channel_logos(014):频道 Logo 胜者注册表
  'channel_logo',
  // 0012_programme_posters(020):TMDB 节目海报缓存
  'programme_poster',
  // 0013_source_governance(021):归档注册表 + 原始导入快照 + 清理审计
  'source_archive',
  'source_import_snapshot',
  'governance_cleanup_run',
  '_migrations',
] as const;

/**
 * drill 结束时必须存在的关键列(0004 起就绪语义含「必需列」;T009 增补 0005 四表,
 * T006 增补 0006 扩展列与新表):
 * 键为表名,值为必须存在的列。对照 database.ts 的 REQUIRED_COLUMNS 与 0004/0005/0006 up.sql。
 */
const EXPECTED_COLUMNS: Readonly<Record<string, readonly string[]>> = {
  // 0004_manual_epg_binding(ADR-0008);0010_multi_source_priority(016):多源优先级(016 data-model §1.1,默认 100)
  media_source: ['epg_generation', 'locator_revision', 'priority'],
  manual_epg_binding: [
    'household_id',
    'media_id',
    'mode',
    'epg_source_id',
    'xmltv_channel_id',
    'version',
    'updated_at',
  ],
  // 0005_playback(T009):四表关键列,对照 docs/specs/004-playback-resolver/data-model.md 四节
  playback_session: [
    'desired_paused',
    'generation',
    'version',
    'position_seconds',
    'state',
    'delivery',
    // 0006_pc_experience(T006):身份上下文版本
    'profile_context_version',
    // 0007_online_vod(T014):独立起播标记与持久 cleanup 标记/原因/执行状态(010 data-model §10)
    'playback_started_at',
    'cleanup_requested',
    'cleanup_reason',
    'cleanup_state',
  ],
  playback_ticket: ['token_hash', 'expires_at'],
  playback_conversion: ['mode', 'state', 'cleanup_state', 'bytes_on_disk'],
  playback_failure_event: ['stable_code', 'occurred_at'],
  // 0006_pc_experience(T006,数据代际 2):既有实体扩展列(对照 005 data-model §2)
  household: ['version', 'main_profile_version'],
  account: ['credential_version'],
  profile: ['is_main', 'pin_version', 'version'],
  media_item: ['content_revision', 'media_role', 'visible'],
  source_entry: ['group_title', 'logo_url'],
  // 0009_channel_logos(014):EPG 频道图标原始地址与胜者注册表(014 data-model §1/§2)
  epg_channel: ['icon_url'],
  // 0012_programme_posters(020):节目海报缓存键/引用列(020 data-model §2)
  epg_programme: ['poster_match_key', 'poster_ref'],
  // 0013_source_governance(021):归档时间/原始快照/清理审计
  source_import_snapshot: [
    'household_id',
    'source_id',
    'refresh_id',
    'kind',
    'content_encoding',
    'content',
    'byte_size',
    'sha256',
    'captured_at',
  ],
  governance_cleanup_run: [
    'household_id',
    'actor_account_id',
    'target',
    'dry_run',
    'deleted_count',
    'bytes_freed',
    'detail_json',
    'created_at',
  ],
  channel_logo: [
    'household_id',
    'media_id',
    'ref',
    'upstream_url',
    'source_kind',
    'source_id',
    'revision',
    'revoked_at',
    'created_at',
    'updated_at',
  ],
  // 0012_programme_posters(020):TMDB 标题级匹配缓存(020 data-model §1)
  programme_poster: [
    'household_id',
    'match_key',
    'ref',
    'state',
    'tmdb_id',
    'media_type',
    'title',
    'original_title',
    'poster_path',
    'release_date',
    'vote_average',
    'popularity',
    'match_score',
    'year_hint',
    'attempts',
    'last_attempt_at',
    'expires_at',
    'created_at',
    'updated_at',
  ],
  // 0006_pc_experience(T006):五张新表关键列(对照 005 data-model §3~§7)
  settings_access_grant: [
    'household_id',
    'device_session_id',
    'profile_id',
    'profile_context_version',
    'pin_version',
    'main_profile_version',
    'issued_at',
    'expires_at',
    'revoked_at',
  ],
  profile_channel_favorite: ['household_id', 'profile_id', 'media_id', 'created_at'],
  profile_progress_clock: ['household_id', 'profile_id', 'next_epoch'],
  playback_progress_state: [
    'household_id',
    'playback_session_id',
    'profile_id',
    'media_id',
    'candidate_epoch',
    'content_revision',
    'profile_context_version',
    'started',
    'last_sample_seq',
    'last_generation',
    // 0007_online_vod(T014):会话 ledger 扩展列(对照 010 data-model §5;010 收敛:
    // 规范命名 ledger_position/ledger_duration,别名旧列 *_seconds 已自 0007 删除)
    'continuity_revision',
    'ledger_position',
    'ledger_duration',
    'ledger_generation',
    'ledger_accepted_at',
    'session_started',
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
    // 0007_online_vod(T014):连续性/证据/完成扩展列(对照 010 data-model §5)
    'continuity_revision',
    'evidence_state',
    'evidence_digest',
    'completed',
  ],
  // 0007_online_vod(T014):17 张新表关键列(对照 010 data-model §2/§4/§5/§6/§7/§10)
  vod_source_config: ['household_id', 'source_id', 'adapter'],
  media_relation: ['household_id', 'parent_id', 'child_id', 'kind', 'sort_order'],
  vod_title: [
    'household_id',
    'source_id',
    'upstream_vod_id',
    'parent_media_id',
    'current_detail_revision',
    'materialized_at',
  ],
  vod_line: ['household_id', 'title_id', 'line_key', 'display_name', 'sort_order'],
  vod_episode: [
    'household_id',
    'line_id',
    'episode_key',
    'label',
    'media_id',
    'content_version_state',
    'evidence_kind',
    'evidence_digest',
    'schema_version',
    'continuity_revision',
    'continuity_signature',
  ],
  vod_detail_snapshot: [
    'household_id',
    'title_id',
    'revision',
    'locator_revision',
    'validated_private_payload',
    'fetched_at',
    'expires_at',
  ],
  vod_episode_sequence: [
    'household_id',
    'title_id',
    'line_id',
    'detail_revision',
    'sequence_revision',
    'episode_id',
    'season_key',
    'ordinal',
    'sequence_status',
  ],
  vod_materialization_operation: [
    'household_id',
    'device_session_id',
    'profile_id',
    'profile_context_version',
    'operation_key',
    'request_digest',
    'parent_media_id',
    'selected_media_id',
    'selected_content_revision',
    'selected_continuity_revision',
    'detail_revision',
    'catalog_revision',
    'result',
    'committed_at',
    'expires_at',
  ],
  vod_registered_candidate: [
    'household_id',
    'device_session_id',
    'profile_id',
    'profile_context_version',
    'registered_candidate_ref',
    // 010 收敛:唯一键列即规范命名 candidate_ref(别名旧列 source_candidate_ref 已自 0007 删除)
    'candidate_ref',
    'source_session_id',
    'source_generation',
    'preview_revision',
    'target_media_id',
    'target_content_revision',
    'target_continuity_revision',
    'target_detail_revision',
    'materialization_operation_id',
    'created_at',
    'expires_at',
  ],
  profile_vod_preferences: [
    'household_id',
    'profile_id',
    'autoplay_next',
    'switch_carry_position',
    'version',
  ],
  profile_preferences: [
    'household_id',
    'profile_id',
    'default_audio_language',
    'default_subtitle_language',
    'auto_play_next',
    'theme_mode',
    'poster_density',
    'updated_at',
  ],
  profile_vod_preference_operation: [
    'household_id',
    'device_session_id',
    'profile_id',
    'profile_context_version',
    'operation_key',
    'request_digest',
    'result_json',
    'committed_at',
    'expires_at',
  ],
  playback_phase_observation: [
    'household_id',
    'session_id',
    'generation',
    'event_seq',
    'digest',
    'event_type',
    'position_seconds',
    'playback_rate',
    'server_received_at',
    'tail_anchor_position_seconds',
    'tail_anchor_time',
    'delivered_seen',
  ],
  playback_finish_receipt: [
    'household_id',
    'session_id',
    'device_session_id',
    'profile_context_version',
    'generation',
    'operation_key',
    'request_digest',
    // 010 收敛:规范命名 final_seq(别名旧列 final_sample_seq 已自 0007 删除)
    'final_seq',
    'final_session_accepted',
    'history_applied',
    'history_revision',
    'session_completed',
    'auto_next_eligible',
    'reason',
    'position_seconds',
    'duration_seconds',
    'ended_at',
    'content_revision',
    'continuity_revision',
    'locator_revision',
  ],
  playback_next_plan: [
    'household_id',
    'device_session_id',
    'profile_id',
    'profile_context_version',
    'from_session_id',
    'from_generation',
    'action',
    'ref',
    'target_media_id',
    'sequence_revision',
    'detail_revision',
    'target_content_revision',
    'target_continuity_revision',
    'target_locator_revision',
    'history_revision',
    'history_choice_required',
    'created_at',
    'expires_at',
  ],
  playback_input_binding: [
    'household_id',
    'session_id',
    'generation',
    'playback_source_id',
    'source_id',
    'locator_revision',
    'detail_revision',
    'content_revision',
    'continuity_revision',
    'evidence_state',
    'evidence_digest',
    'resolved_input_id',
    'resolved_at',
    'expires_at',
    'start_basis',
    'frozen_start_seconds',
    // 010 T042(freeze-NULL 缺口修复,选项 b):持久冻结标记(与 up.sql/schema.ts/database.ts 四处一致)
    'frozen_at',
    'cleanup_state',
    'cleanup_requested',
    // 010 收敛:补齐 up.sql 既有列(与 database.ts REQUIRED_COLUMNS 同源)
    'cleanup_reason',
  ],
  playback_transition_slot: [
    'household_id',
    'from_session_id',
    'from_generation',
    'slot_revision',
    'status',
    'active_intent_id',
    'successor_session_id',
  ],
  playback_transition_intent: [
    'household_id',
    'from_session_id',
    'from_generation',
    'device_session_id',
    'profile_id',
    'profile_context_version',
    'action',
    'target_media_id',
    'target_content_revision',
    'target_continuity_revision',
    'target_locator_revision',
    'match_revision',
    'match_confidence',
    'confirmed_ambiguous',
    'position_mode',
    'carry_position_seconds',
    'carry_duration_seconds',
    'source_ledger_seq',
    'source_checkpoint_generation',
    'source_checkpoint_seq',
    'allow_earlier_accepted_position',
    'finish_receipt_id',
    'operation_key',
    'request_digest',
    'slot_revision',
    'created_at',
    'expires_at',
    'status',
    'successor_id',
    'next_plan_id',
    'plan_sequence_revision',
    'plan_detail_revision',
    'plan_history_revision',
    'plan_history_choice_required',
  ],
};

const MIGRATIONS_DIR = path.join(__dirname, 'migrations');

function log(message: string): void {
  console.log(`[migrate] ${message}`);
}

function discoverMigrations(): MigrationFile[] {
  const entries = fs
    .readdirSync(MIGRATIONS_DIR, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();

  const migrations = entries.map((name) => {
    const dir = path.join(MIGRATIONS_DIR, name);
    const upPath = path.join(dir, 'up.sql');
    const downPath = path.join(dir, 'down.sql');
    if (!fs.existsSync(upPath) || !fs.existsSync(downPath)) {
      throw new Error(`迁移 ${name} 缺少 up.sql / down.sql 配对文件`);
    }
    return { name, upPath, downPath };
  });

  if (migrations.length === 0) {
    throw new Error(`未在 ${MIGRATIONS_DIR} 发现任何迁移目录`);
  }
  return migrations;
}

/** 与 database.ts 同规则解析数据库文件路径(env.DATA_DIR / env.DB_FILENAME) */
function resolveDbFile(): string {
  const dir = path.resolve(env.DATA_DIR);
  fs.mkdirSync(dir, { recursive: true });
  return path.join(dir, env.DB_FILENAME);
}

/** VACUUM INTO 目标必须不存在;时间戳撞名时追加序号 */
function createBackup(db: DbHandle, dbFile: string): string {
  const stamp = Date.now();
  let target = `${dbFile}.bak-${stamp}`;
  let attempt = 1;
  while (fs.existsSync(target)) {
    target = `${dbFile}.bak-${stamp}-${attempt}`;
    attempt += 1;
  }
  const escaped = target.replaceAll("'", "''");
  db.exec(`VACUUM INTO '${escaped}'`);
  return target;
}

function ensureMigrationsTable(db: DbHandle): void {
  db.exec('CREATE TABLE IF NOT EXISTS _migrations (name TEXT PRIMARY KEY NOT NULL, applied_at TEXT NOT NULL)');
}

function getApplied(db: DbHandle): Set<string> {
  const rows = db.prepare('SELECT name FROM _migrations').all() as { name: string }[];
  return new Set(rows.map((row) => row.name));
}

function applyUp(db: DbHandle, migration: MigrationFile): void {
  const insertApplied = db.prepare('INSERT INTO _migrations (name, applied_at) VALUES (?, ?)');
  // 0007 起 up.sql 已改写为 FK 开启下亦逐语句零违反的 12-step 等价序列(暂存/清空/父行就位
  // 后回填),不再依赖本 pragma;此处事务外 OFF→提交后 ON 保留为双保险(该 pragma 在事务内
  // 不可切换),提交后对全库 foreign_key_check 复核仍是权威兜底,违反即失败
  db.pragma('foreign_keys = OFF');
  try {
    const run = db.transaction(() => {
      db.exec(fs.readFileSync(migration.upPath, 'utf8'));
      insertApplied.run(migration.name, new Date().toISOString());
    });
    run();
  } finally {
    db.pragma('foreign_keys = ON');
  }
  const violations = db.pragma('foreign_key_check') as unknown[];
  if (violations.length > 0) {
    throw new Error(
      `迁移 ${migration.name} 提交后 foreign_key_check 发现 ${violations.length} 条外键违反,拒绝接受`,
    );
  }
  log(`已应用 ${migration.name}`);
}

function applyDown(db: DbHandle, migration: MigrationFile): void {
  const deleteApplied = db.prepare('DELETE FROM _migrations WHERE name = ?');
  // 同 applyUp:0007 down.sql 已是 FK 开启下零违反的等价序列,事务外 OFF→ON 仅为双保险;
  // 提交后全量 foreign_key_check 复核(0007 重建/删列同要求)
  db.pragma('foreign_keys = OFF');
  try {
    const run = db.transaction(() => {
      db.exec(fs.readFileSync(migration.downPath, 'utf8'));
      deleteApplied.run(migration.name);
    });
    run();
  } finally {
    db.pragma('foreign_keys = ON');
  }
  const violations = db.pragma('foreign_key_check') as unknown[];
  if (violations.length > 0) {
    throw new Error(
      `迁移 ${migration.name} 回滚提交后 foreign_key_check 发现 ${violations.length} 条外键违反,拒绝接受`,
    );
  }
  log(`已回滚 ${migration.name}`);
}

/**
 * 0007_online_vod 非空在线 down 保护(T014,010 data-model §8 逐字):
 * 「down遇到在线业务非空拒绝破坏性删除……临时空库可down」。任何在线点播业务数据
 * (17 张新表任一非空,或既有表的在线足迹:vod 来源 / 非 standalone 媒体 / vod_episode
 * 条目 / online 定位器)存在时,回滚属破坏性删除,在应用 down.sql 之前拒绝(不做任何
 * 修改,不删表不删列);正式回滚采用升级前一致备份 + 匹配镜像。独立副本演练(空库)放行。
 */
const ONLINE_VOD_DOWN_GUARD_TABLES = [
  'vod_source_config',
  'media_relation',
  'vod_title',
  'vod_line',
  'vod_episode',
  'vod_detail_snapshot',
  'vod_episode_sequence',
  'vod_materialization_operation',
  'vod_registered_candidate',
  'profile_vod_preferences',
  'profile_vod_preference_operation',
  'playback_phase_observation',
  'playback_finish_receipt',
  'playback_next_plan',
  'playback_input_binding',
  'playback_transition_intent',
  'playback_transition_slot',
] as const;

function assertDownAllowed(db: DbHandle, migration: MigrationFile): void {
  const nonEmpty: string[] = [];
  const countRows = (sql: string): number => (db.prepare(sql).get() as { n: number }).n;

  // 0008(013):个人偏好非空时拒绝破坏性回滚
  if (migration.name === '0008_profile_preferences') {
    const n = countRows('SELECT COUNT(*) AS n FROM profile_preferences');
    if (n > 0) {
      throw new Error(
        `[down] 个人偏好数据非空,拒绝破坏性回滚 0008_profile_preferences(profile_preferences=${n});` +
          '正式回滚请使用升级前一致备份+匹配镜像,临时空库方可 down 演练',
      );
    }
    return;
  }
  if (migration.name !== '0007_online_vod') return;
  for (const table of ONLINE_VOD_DOWN_GUARD_TABLES) {
    const n = countRows(`SELECT COUNT(*) AS n FROM ${table}`);
    if (n > 0) nonEmpty.push(`${table}=${n}`);
  }
  const onlineSources = countRows("SELECT COUNT(*) AS n FROM media_source WHERE kind = 'vod'");
  if (onlineSources > 0) nonEmpty.push(`media_source(kind=vod)=${onlineSources}`);
  const vodMedia = countRows("SELECT COUNT(*) AS n FROM media_item WHERE media_role <> 'standalone'");
  if (vodMedia > 0) nonEmpty.push(`media_item(media_role<>standalone)=${vodMedia}`);
  const vodEntries = countRows(
    "SELECT COUNT(*) AS n FROM source_entry WHERE identity_kind = 'vod_episode'",
  );
  if (vodEntries > 0) nonEmpty.push(`source_entry(identity_kind=vod_episode)=${vodEntries}`);
  const onlineLocators = countRows(
    "SELECT COUNT(*) AS n FROM playback_source WHERE locator_kind = 'online'",
  );
  if (onlineLocators > 0) nonEmpty.push(`playback_source(locator_kind=online)=${onlineLocators}`);
  if (nonEmpty.length > 0) {
    throw new Error(
      `[down] 在线点播业务数据非空,拒绝破坏性回滚 0007_online_vod(${nonEmpty.join(', ')});` +
        '正式回滚请使用升级前一致备份+匹配镜像(010 data-model §8),临时空库方可 down 演练',
    );
  }
}

function cmdUp(db: DbHandle, dbFile: string): void {
  const backup = createBackup(db, dbFile);
  ensureMigrationsTable(db);
  const applied = getApplied(db);
  const pending = discoverMigrations().filter((migration) => !applied.has(migration.name));
  if (pending.length === 0) {
    log(`无待应用迁移(备份: ${path.basename(backup)})`);
    return;
  }
  for (const migration of pending) {
    applyUp(db, migration);
  }
  log(`完成:共 ${pending.length} 条(备份: ${path.basename(backup)})`);
}

function cmdDown(db: DbHandle, dbFile: string): void {
  const backup = createBackup(db, dbFile);
  ensureMigrationsTable(db);
  const applied = getApplied(db);
  const last = [...discoverMigrations()].reverse().find((migration) => applied.has(migration.name));
  if (last === undefined) {
    log(`无已应用迁移,无需回滚(备份: ${path.basename(backup)})`);
    return;
  }
  assertDownAllowed(db, last);
  applyDown(db, last);
  log(`完成(备份: ${path.basename(backup)})`);
}

function currentTables(db: DbHandle): string[] {
  const rows = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")
    .all() as { name: string }[];
  return rows.map((row) => row.name);
}

function cmdDrill(db: DbHandle, dbFile: string): void {
  log('drill 阶段 1/3:up');
  cmdUp(db, dbFile);
  log('drill 阶段 2/3:down');
  cmdDown(db, dbFile);
  log('drill 阶段 3/3:up');
  cmdUp(db, dbFile);

  // 终态校验:全部迁移已应用 + 全部表存在
  const all = discoverMigrations();
  const applied = getApplied(db);
  const missingMigrations = all.filter((migration) => !applied.has(migration.name)).map((migration) => migration.name);
  if (missingMigrations.length > 0) {
    throw new Error(`drill 失败:迁移未全部已应用: ${missingMigrations.join(', ')}`);
  }
  const tables = new Set(currentTables(db));
  const missingTables = EXPECTED_TABLES.filter((table) => !tables.has(table));
  if (missingTables.length > 0) {
    throw new Error(`drill 失败:表缺失: ${missingTables.join(', ')}`);
  }
  for (const [table, columns] of Object.entries(EXPECTED_COLUMNS)) {
    const present = db.pragma(`table_info(${table})`) as { name: string }[];
    const missingColumns = columns.filter((column) => !present.some((row) => row.name === column));
    if (missingColumns.length > 0) {
      throw new Error(`drill 失败:${table} 缺列: ${missingColumns.join(', ')}`);
    }
  }
  log(`drill 通过:已应用 [${all.map((migration) => migration.name).join(', ')}],表 [${EXPECTED_TABLES.join(', ')}] 全部存在`);
}

/**
 * T007:命令入口门禁 —— 在任何写连接、WAL 设置或迁移元数据创建之前先只读预检;
 * 拒绝时抛 MigrationGateError(不备份、不建 _migrations、不触碰旧文件)。
 */
function gateCommand(command: 'up' | 'down' | 'drill', dbFile: string): void {
  const verdict = precheckDatabaseFile(dbFile);
  const decision = evaluateMigrationGate(verdict, command);
  if (!decision.allowed) {
    throw new MigrationGateError(
      decision.code ?? 'STORAGE_STATE_UNKNOWN',
      `[${command}] ${decision.reason}`,
    );
  }
  log(`预检通过(${verdict.kind}):${verdict.reason}`);
}

/**
 * 迁移命令执行(供 CLI 与测试调用):先只读预检,再打开写连接执行。
 * 失败抛错(MigrationGateError = 门禁拒绝;其余为 SQL/IO 错误),由调用方决定退出码。
 */
export function runMigrationCommand(command: 'up' | 'down' | 'drill'): void {
  const dbFile = resolveDbFile();
  gateCommand(command, dbFile);
  const db = Database.db;
  log(`命令=${command} 数据库=${dbFile}`);
  try {
    switch (command) {
      case 'up':
        cmdUp(db, dbFile);
        break;
      case 'down':
        cmdDown(db, dbFile);
        break;
      case 'drill':
        cmdDrill(db, dbFile);
        break;
    }
  } finally {
    Database.close();
  }
}

function main(): void {
  const command = process.argv[2];
  if (command !== 'up' && command !== 'down' && command !== 'drill') {
    console.error('用法: tsx src/platform/database/migrate.ts <up|down|drill>');
    process.exitCode = 1;
    return;
  }
  try {
    runMigrationCommand(command);
  } catch (err) {
    console.error(`[migrate] ${command} 失败:`, err);
    process.exitCode = 1;
  }
}

// CLI 入口:仅直接执行本文件时运行(tsx src/platform/database/migrate.ts <cmd>);
// 测试进程 import 本模块时不触发(不得以 vitest 的 argv 误跑迁移)。
if (typeof require !== 'undefined' && typeof require.main !== 'undefined' && require.main === module) {
  main();
}
