import fs from 'node:fs';
import path from 'node:path';
import DatabaseConstructor from 'better-sqlite3';
import { env } from '../config/env';

/**
 * 0004 起就绪检查的「必需列」语义:表存在但关键列缺失(升级中断/降级残留)与缺表同等不可就绪。
 * 键为表名,值为该表必须存在的列(逐列 PRAGMA table_info 校验)。
 */
const REQUIRED_COLUMNS: Readonly<Record<string, readonly string[]>> = {
  // 0004_manual_epg_binding(ADR-0008):绑定表全列(media_source 的必需列见下方 media_item 邻段)
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
  media_item: [
    'content_revision',
    // 0007_online_vod(T014):standalone/vod_title/vod_episode 角色(010 data-model §2)
    'media_role',
  ],
  media_source: [
    'epg_generation',
    // 0007_online_vod(T014):来源定位器修订(启停防 ABA)
    'locator_revision',
  ],
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
    // 010 收敛:补齐数据模型 §10 计划对外引用 ref(与 migrate.ts EXPECTED_COLUMNS 同源)
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
    // 010 T042(freeze-NULL 缺口修复,选项 b):持久冻结标记(与 up.sql/schema.ts/migrate.ts 四处一致)
    'frozen_at',
    'cleanup_state',
    'cleanup_requested',
    // 010 收敛:补齐 up.sql 既有列(与 migrate.ts EXPECTED_COLUMNS 同源)
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
        // 010 在线点播(0007,T014):来源/目录/物化/个人/播放扩展 17 表
        'vod_source_config', 'media_relation', 'vod_title', 'vod_line', 'vod_episode',
        'vod_detail_snapshot', 'vod_episode_sequence', 'vod_materialization_operation',
        'vod_registered_candidate', 'profile_vod_preferences', 'profile_vod_preference_operation',
        'playback_phase_observation', 'playback_finish_receipt', 'playback_next_plan',
        'playback_input_binding', 'playback_transition_intent', 'playback_transition_slot',
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
