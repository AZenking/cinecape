import fs from 'node:fs';
import path from 'node:path';
import DatabaseConstructor from 'better-sqlite3';
import { env } from '../config/env';

/**
 * T007(005-pc-browsing-flow · Phase 2):旧库只读预检与 readiness 门禁。
 *
 * data-model §1(逐字):「启动和迁移入口必须在任何写连接、WAL设置或迁移元数据创建之前
 * 以只读方式预检旧库,拒绝时不修改旧文件」「SQLite user_version=2 表示新代际,应用
 * readiness 要求匹配」。0006 仅对全新安装的空业务库应用;旧已初始化库拒绝,不能先删
 * 数据再尝试升级。
 *
 * 实现:以 better-sqlite3 `readonly: true`(底层 SQLITE_OPEN_READONLY,与 file: URI
 * readonly 模式同语义)打开,只做 PRAGMA/sqlite_master 读;不设置 journal_mode、不建
 * _migrations、不产生任何写入。打开失败/读取失败按损坏或未知处理,fail-closed。
 *
 * ⚠️ 副产物说明(实测):SQLite 对 WAL 模式库的只读检查可能生成空的 `-wal`(恒 0 字节,
 * 只读连接不写任何帧)与派生 `-shm`(wal-index,官方文档定义为 ephemeral,内容可随时
 * 重建)。数据库文件本身的字节不会被修改;SQLite 不经 URI(immutable=1)无法完全避免
 * 该副产物,而 better-sqlite3 不启用 URI 文件名。预检不清理副产物(避免与并发旧进程
 * 竞态删除)。
 *
 * 判定矩阵(只读观测:业务表存在性 / _migrations 记录 / user_version):
 * | 库形态                                                          | verdict                  | 迁移 up        | 服务启动                      |
 * |----------------------------------------------------------------|--------------------------|----------------|-------------------------------|
 * | 文件不存在,或无业务表且无 _migrations 且 user_version=0        | fresh-empty              | 允许           | 允许(readiness 503 直至迁移) |
 * | user_version=2 且 _migrations 与迁移目录全量一致                | generation2-ready        | 允许(空操作) | 允许                          |
 * | user_version=1 且 _migrations 恰为 0001~0005(0006 down 后状态)| generation2-rolled-back  | 允许(重新 up)| 拒绝(先迁移再启动)          |
 * | user_version=2 且 _migrations 恰缺可回滚尾段(0007 down 后 / 0008 down 后 / 两者均 down 后)| generation2-vod-rolled-back | 允许(重新 up 补齐) | 拒绝(先迁移再启动)   |
 * | 有业务表或 _migrations、未到代际 2、且非上行(含旧库 uv=0)      | reject …UNSUPPORTED      | 拒绝           | 拒绝                          |
 * | 文件非 SQLite / quick_check 报错                                | reject …CORRUPT          | 拒绝           | 拒绝                          |
 * | 只读打不开(热 WAL/锁/权限)/版本记录与 user_version 不一致     | reject …STATE_UNKNOWN    | 拒绝           | 拒绝                          |
 *
 * user_version=1 标记说明:旧应用从不设置 user_version(0001~0005 无该语句),真实旧库
 * 恒为 0;仅 0006 down.sql 将其恢复为 1(down 后与旧代际标记一致)。因此「uv=1 且恰有
 * 0001~0005 记录」可安全判别为代际 2 回滚后状态(空库 up/down/up 演练要求可再次 up),
 * 与旧已初始化库(uv=0)不混淆。
 */

/** 数据代际 2 的迁移名(up.sql 末尾设置 user_version=2) */
const GENERATION2_MIGRATION = '0006_pc_experience';

/** 在线点播迁移名(010 T014;与 0006 同属交付代际 2,up/down 均保持 user_version=2) */
const ONLINE_VOD_MIGRATION = '0007_online_vod';

/**
 * 交付代际 2 内可独立回滚的尾段迁移(up/down 均保持 user_version=2):
 * - 0007_online_vod(010)/ 0008_profile_preferences(013)/ 0009_channel_logos(014)
 *   / 0010_multi_source_priority(016);
 * - 预检判定「记录恰缺任意尾段子集」为部分回滚形态,允许重新 up 补齐;
 * - 非尾段记录缺失(如 0001~0006)一律视为中断/篡改拒绝。
 */
const ROLLBACKABLE_TAIL_MIGRATIONS: readonly string[] = Object.freeze([
  ONLINE_VOD_MIGRATION,
  '0008_profile_preferences',
  '0009_channel_logos',
  '0010_multi_source_priority',
  '0011_channel_visibility',
]);

/** 代际 1 完整记录(0006 down 后的 _migrations 形态;与迁移目录 0001~0005 一致) */
const GENERATION1_MIGRATIONS = Object.freeze([
  '0001_init',
  '0002_profile_policy',
  '0003_media_catalog',
  '0004_manual_epg_binding',
  '0005_playback',
]);

/** 业务表清单(判定「旧已初始化库」的最小特征集:0001 起的身份表 + 0006 新表代表) */
const BUSINESS_TABLES = Object.freeze([
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
  'playback_session',
  'playback_ticket',
  'playback_conversion',
  'playback_failure_event',
  'settings_access_grant',
  'profile_channel_favorite',
  'profile_progress_clock',
  'playback_progress_state',
  'profile_viewing_history',
]);

/** 稳定拒绝码:可判读、可断言(日志/响应仅含码与原因,不含敏感路径细节) */
export type StorageRejectCode =
  | 'STORAGE_GENERATION_UNSUPPORTED'
  | 'STORAGE_CORRUPT'
  | 'STORAGE_STATE_UNKNOWN';

export type PrecheckVerdictKind =
  | 'fresh-empty'
  | 'generation2-ready'
  | 'generation2-rolled-back'
  | 'generation2-vod-rolled-back'
  | 'reject';

export interface PrecheckVerdict {
  kind: PrecheckVerdictKind;
  /** 仅 reject 时存在;稳定错误码 */
  code?: StorageRejectCode;
  /** 可判读原因(面向日志与 CLI 输出) */
  reason: string;
}

export interface GateDecision {
  allowed: boolean;
  kind: PrecheckVerdictKind;
  code?: StorageRejectCode;
  reason: string;
}

/** 迁移/启动门禁拒绝错误(测试与 CLI 按码断言) */
export class MigrationGateError extends Error {
  readonly code: StorageRejectCode;

  constructor(code: StorageRejectCode, reason: string) {
    super(reason);
    this.name = 'MigrationGateError';
    this.code = code;
  }
}

/** 与 database.ts / migrate.ts 同规则解析数据库文件路径(env.DATA_DIR / env.DB_FILENAME);不创建目录 */
function resolveDbFileForPrecheck(): string {
  return path.join(path.resolve(env.DATA_DIR), env.DB_FILENAME);
}

function reject(code: StorageRejectCode, reason: string): PrecheckVerdict {
  return { kind: 'reject', code, reason };
}

function sameStringSet(left: readonly string[], right: readonly string[]): boolean {
  return JSON.stringify([...left].sort()) === JSON.stringify([...right].sort());
}

/** 迁移目录权威清单(与 database.ts isReady 同源;目录缺失视为未知形态) */
function discoverMigrationNames(): string[] | null {
  try {
    const migrationsDir = path.join(__dirname, 'migrations');
    return fs
      .readdirSync(migrationsDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();
  } catch {
    return null;
  }
}

/**
 * 只读预检:任何写连接、WAL 设置或迁移元数据创建之前调用。
 * 绝不写入目标文件(readonly 连接 + 只读 PRAGMA/查询);打开失败不重试、不降级为读写。
 */
export function precheckDatabaseFile(dbFile: string): PrecheckVerdict {
  // 文件不存在:全新安装(首个写连接由迁移/应用正常路径创建)
  if (!fs.existsSync(dbFile)) {
    return { kind: 'fresh-empty', reason: '数据库文件不存在,视为全新空库' };
  }

  let conn: DatabaseConstructor.Database;
  try {
    conn = new DatabaseConstructor(dbFile, { readonly: true, fileMustExist: true });
  } catch (err) {
    if (isCorruptError(err)) {
      return reject(
        'STORAGE_CORRUPT',
        `目标文件损坏或不是有效的 SQLite 数据库(${(err as { code?: string }).code || 'SQLITE_NOTADB'})`,
      );
    }
    const message = err instanceof Error ? err.message : String(err);
    // 热 WAL(旧进程未退)/ 锁冲突 / 权限不足等:无法安全观测,拒绝且不触碰
    return reject('STORAGE_STATE_UNKNOWN', `无法以只读方式打开数据库进行预检:${message}`);
  }

  try {
    // 损坏检测:quick_check 只读扫描(报错数上限 1,足够判定)
    const quickCheck = conn.pragma('quick_check(1)', { simple: true });
    if (quickCheck !== 'ok') {
      return reject('STORAGE_CORRUPT', `数据库完整性检查未通过:quick_check=${String(quickCheck)}`);
    }

    const userVersion = conn.pragma('user_version', { simple: true }) as number;
    const tables = (
      conn
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")
        .all() as { name: string }[]
    ).map((row) => row.name);
    const hasMigrationsTable = tables.includes('_migrations');
    let applied: string[] = [];
    if (hasMigrationsTable) {
      applied = (conn.prepare('SELECT name FROM _migrations').all() as { name: string }[]).map(
        (row) => row.name,
      );
    }
    const businessPresent = tables.some((table) => BUSINESS_TABLES.includes(table));
    const allMigrations = discoverMigrationNames();
    if (allMigrations === null || allMigrations.length === 0) {
      return reject(
        'STORAGE_STATE_UNKNOWN',
        '无法读取迁移目录,代际状态不可判定(应用安装不完整)',
      );
    }

    // 形态一:全新空库(无业务表且无 _migrations;user_version 必须为 0,异常值视为未知)
    if (!businessPresent && !hasMigrationsTable) {
      if (userVersion === 0) {
        return { kind: 'fresh-empty', reason: '全新空库(无业务表、无迁移记录)' };
      }
      return reject(
        'STORAGE_STATE_UNKNOWN',
        `库为空但 user_version=${userVersion} 非 0,不是本应用创建的形态,拒绝处理`,
      );
    }

    // 形态二:已含代际 2 迁移记录 —— user_version 必须为 2 且记录与迁移目录全量一致;
    // 子形态:恰缺 0007(0007 down 后的「已回滚在线点播」形态,与目录-1 一致)允许重新 up
    if (applied.includes(GENERATION2_MIGRATION)) {
      if (userVersion === 2 && sameStringSet(applied, allMigrations)) {
        return {
          kind: 'generation2-ready',
          reason: '数据代际 2 就绪(user_version=2,迁移记录与目录一致)',
        };
      }
      // 子形态(泛化):交付代际 2 内的可独立回滚尾段(0007/0008,均不改 user_version)
      // 缺任意尾段子集均为「部分已回滚」,允许重新 up 补齐;其余记录/目录分叉视为篡改。
      const missingTails = allMigrations.filter(
        (name) => !applied.includes(name) && ROLLBACKABLE_TAIL_MIGRATIONS.includes(name),
      );
      const missingUnknown = allMigrations.filter(
        (name) => !applied.includes(name) && !ROLLBACKABLE_TAIL_MIGRATIONS.includes(name),
      );
      if (userVersion === 2 && missingUnknown.length === 0 && missingTails.length > 0) {
        return {
          kind: 'generation2-vod-rolled-back',
          reason: `数据代际 2 尾段部分已回滚(user_version=2,记录恰缺 ${missingTails.join(', ')});可重新应用补齐`,
        };
      }
      return reject(
        'STORAGE_STATE_UNKNOWN',
        `代际 2 迁移记录存在但状态不一致(user_version=${userVersion},记录 ${applied.length} 条/目录 ${allMigrations.length} 条),疑似中断或被篡改`,
      );
    }

    // 形态三:代际 2 回滚后状态(uv=1 且恰为 0001~0005;仅 0006 down 会写入该标记)
    if (userVersion === 1 && sameStringSet(applied, GENERATION1_MIGRATIONS)) {
      return {
        kind: 'generation2-rolled-back',
        reason: '数据代际 2 已回滚(user_version=1,记录恰为 0001~0005);可重新应用 0006',
      };
    }

    // 形态四:user_version=2 但缺少 0006 迁移记录 —— user_version 由 0006 up 与其版本记录
    // 同事务写入,二者不可能分叉;出现即中断/篡改,不可判定为任何已知形态。
    if (userVersion === 2) {
      return reject(
        'STORAGE_STATE_UNKNOWN',
        `user_version=2 但迁移记录不含 ${GENERATION2_MIGRATION}(${applied.length} 条),与写入协议矛盾,疑似中断或被篡改`,
      );
    }

    // 形态五:旧已初始化库(有业务表或迁移记录,但未到代际 2)—— 交付例外,拒绝升级
    return reject(
      'STORAGE_GENERATION_UNSUPPORTED',
      `检测到已初始化数据库(user_version=${userVersion},业务表/迁移记录存在);当前构建仅支持全新安装的数据代际 2,拒绝迁移或启动以避免破坏旧数据`,
    );
  } catch (err) {
    if (isCorruptError(err)) {
      return reject(
        'STORAGE_CORRUPT',
        `数据库完整性检查未通过(${(err as { code?: string }).code || 'SQLITE_CORRUPT'}):文件损坏或不是有效的 SQLite 数据库`,
      );
    }
    const message = err instanceof Error ? err.message : String(err);
    return reject('STORAGE_STATE_UNKNOWN', `预检读取失败,存储状态不可判定:${message}`);
  } finally {
    conn.close();
  }
}

/** SQLITE_NOTADB / SQLITE_CORRUPT(含 "file is not a database"/"disk image is malformed")判定 */
function isCorruptError(err: unknown): boolean {
  const code = (err as { code?: string }).code ?? '';
  const message = err instanceof Error ? err.message : String(err);
  return (
    code === 'SQLITE_NOTADB' ||
    code === 'SQLITE_CORRUPT' ||
    /not a database/i.test(message) ||
    /disk image is malformed/i.test(message)
  );
}

/**
 * 迁移入口门禁(T007):up / down / drill 在打开写连接之前调用。
 * - up/drill:允许 空库 / 代际 2 就绪(空操作)/ 代际 2 回滚后(重新 up)/
 *   在线点播部分回滚后(重新 up 0007);
 * - down:允许代际 2 就绪与「0007 已回滚」形态(继续逐级 down 0006);
 *   其余形态无可回滚对象,或根本不允许触碰。
 */
export function evaluateMigrationGate(
  verdict: PrecheckVerdict,
  command: 'up' | 'down' | 'drill',
): GateDecision {
  const base: GateDecision = { allowed: false, kind: verdict.kind, code: verdict.code, reason: verdict.reason };
  if (command === 'down') {
    if (verdict.kind === 'generation2-ready') return { ...base, allowed: true };
    if (verdict.kind === 'generation2-vod-rolled-back') {
      // 0007 已回滚的形态:继续 down 逐级回滚 0006(其 down 恢复 user_version=1),
      // 与既有「代际 2 就绪可 down」同一语义链
      return { ...base, allowed: true };
    }
    if (verdict.kind === 'fresh-empty') {
      return { ...base, reason: '全新空库无已应用迁移,down 无可回滚对象' };
    }
    if (verdict.kind === 'generation2-rolled-back') {
      return { ...base, reason: '数据代际 2 已回滚(user_version=1),再次 down 无对象且不允许回退旧代际迁移' };
    }
    return base;
  }
  // up / drill
  if (
    verdict.kind === 'fresh-empty' ||
    verdict.kind === 'generation2-ready' ||
    verdict.kind === 'generation2-rolled-back' ||
    verdict.kind === 'generation2-vod-rolled-back'
  ) {
    return { ...base, allowed: true };
  }
  return base;
}

/** 服务启动门禁(T007):readiness 要求 user_version=2 匹配;空库允许启动(healthz 503 直至迁移) */
export function evaluateServerGate(verdict: PrecheckVerdict): GateDecision {
  const base: GateDecision = { allowed: false, kind: verdict.kind, code: verdict.code, reason: verdict.reason };
  if (verdict.kind === 'fresh-empty') {
    return { ...base, allowed: true, reason: `${verdict.reason};就绪门禁将保持 503 直至执行迁移` };
  }
  if (verdict.kind === 'generation2-ready') return { ...base, allowed: true };
  if (verdict.kind === 'generation2-rolled-back' || verdict.kind === 'generation2-vod-rolled-back') {
    return { ...base, reason: `${verdict.reason};须先执行迁移恢复代际 2 全量再启动` };
  }
  return base;
}

/** 启动路径入口(main.ts):按 env 解析库文件并评估服务启动门禁 */
export function precheckForStartup(): GateDecision {
  return evaluateServerGate(precheckDatabaseFile(resolveDbFileForPrecheck()));
}
