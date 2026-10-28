import fs from 'node:fs';
import path from 'node:path';
import DatabaseConstructor from 'better-sqlite3';
import { env } from '../config/env';

/**
 * 0004 起就绪检查的「必需列」语义:表存在但关键列缺失(升级中断/降级残留)与缺表同等不可就绪。
 * 键为表名,值为该表必须存在的列(逐列 PRAGMA table_info 校验)。
 */
const REQUIRED_COLUMNS: Readonly<Record<string, readonly string[]>> = {
  // 0004_manual_epg_binding(ADR-0008):media_source.epg_generation 与绑定表全列
  media_source: ['epg_generation'],
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
  ],
  playback_ticket: ['token_hash', 'expires_at'],
  playback_conversion: ['mode', 'state', 'cleanup_state', 'bytes_on_disk'],
  playback_failure_event: ['stable_code', 'occurred_at'],
  // 0006_pc_experience(T006,数据代际 2):既有实体扩展列(对照 005 data-model §2)
  household: ['version', 'main_profile_version'],
  account: ['credential_version'],
  profile: ['is_main', 'pin_version', 'version'],
  media_item: ['content_revision'],
  source_entry: ['group_title'],
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

/** 数据代际 2 的就绪标记(T007):0006 up 设置、down 恢复 1 */
const REQUIRED_USER_VERSION = 2;

/**
 * SQLite 连接单例(WAL 模式,research D4)。
 * 全部领域查询经由此句柄;显式 household_id 边界由各查询自行携带(FR-006)。
 */
export class Database {
  private static instance: DatabaseConstructor.Database | null = null;
  private static openError: unknown = null;

  static get db(): DatabaseConstructor.Database {
    if (Database.instance === null) {
      const dir = path.resolve(env.DATA_DIR);
      fs.mkdirSync(dir, { recursive: true });
      const file = path.join(dir, env.DB_FILENAME);
      const conn = new DatabaseConstructor(file);
      conn.pragma('journal_mode = WAL');
      conn.pragma('foreign_keys = ON');
      conn.pragma('busy_timeout = 5000');
      Database.instance = conn;
    }
    return Database.instance;
  }

  /**
   * 就绪语义(T009):已应用迁移覆盖目录全量,且全部业务表与必需列存在
   * (阶段 1/2/3 含 0004 增补、0005 四表)才可接受请求;部分形态库(缺 0005 表/列)
   * 返回 false → healthz 503。不自动建表。
   * T006/T007(数据代际 2):新增 0006 五表/扩展列,并要求 user_version=2 匹配
   * (0006 up 设置、down 恢复 1;不匹配即旧代际/中断形态,一律未就绪)。
   */
  static isReady(): boolean {
    try {
      const conn = Database.db;
      // 数据代际门禁(T007):readiness 要求 user_version=2 匹配
      const userVersion = conn.pragma('user_version', { simple: true }) as number;
      if (userVersion !== REQUIRED_USER_VERSION) return false;
      const migrationsDir = path.join(__dirname, 'migrations');
      const expected = fs.readdirSync(migrationsDir, { withFileTypes: true })
        .filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort();
      const applied = conn.prepare('SELECT name FROM _migrations ORDER BY name').all() as { name: string }[];
      if (expected.length === 0 || JSON.stringify(applied.map((row) => row.name)) !== JSON.stringify(expected)) return false;
      for (const table of [
        // 阶段 1/2:身份、会话、策略与家长验证
        'household', 'account', 'profile', 'device', 'device_session',
        'profile_policy', 'parent_verification_state',
        // 阶段 3(003-media-catalog):媒体目录与来源
        'catalog_state', 'media_source', 'media_item', 'source_entry', 'playback_source',
        'epg_channel', 'epg_programme', 'source_refresh', 'refresh_stage_entry',
        // 阶段 3 增补(0004,ADR-0008):单频道手动 EPG 绑定
        'manual_epg_binding',
        // 阶段 4(004-playback-resolver,T009):受控播放会话/票/转换/失败事件
        'playback_session', 'playback_ticket', 'playback_conversion', 'playback_failure_event',
        // 数据代际 2(005-pc-browsing-flow,0006,T006):个人观看体验五表
        'settings_access_grant', 'profile_channel_favorite', 'profile_progress_clock',
        'playback_progress_state', 'profile_viewing_history',
      ]) {
        if (!conn.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table)) return false;
      }
      // 必需列校验(0004 起):逐列 PRAGMA,缺列同样返回未就绪
      for (const [table, columns] of Object.entries(REQUIRED_COLUMNS)) {
        const present = conn.pragma(`table_info(${table})`) as { name: string }[];
        for (const column of columns) {
          if (!present.some((row) => row.name === column)) return false;
        }
      }
      Database.openError = null;
      return true;
    } catch (err) {
      Database.openError = err;
      return false;
    }
  }

  static lastError(): unknown {
    return Database.openError;
  }

  static close(): void {
    Database.instance?.close();
    Database.instance = null;
  }
}
