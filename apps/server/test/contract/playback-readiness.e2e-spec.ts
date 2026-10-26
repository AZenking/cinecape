import 'reflect-metadata';
import { afterEach, describe, expect, it } from 'vitest';
import { Database } from '../../src/database/database';
import {
  INITIALIZE_BODY,
  login,
  cleanupRigs,
  cookiePairOf,
  expectProblemContentType,
  initialize,
  request,
  startFreshApp,} from '../helpers';

/**
 * T009(004-playback-resolver · Phase 2 Foundational):0005 必需表/列就绪门禁契约。
 *
 * 权威依据(docs/specs/004-playback-resolver/tasks.md T009、data-model.md 四节):
 * - 就绪语义(T009):已应用迁移覆盖目录全量,且 playback_session/playback_ticket/
 *   playback_conversion/playback_failure_event 四表及其必需列存在;任一缺失 →
 *   Database.isReady() === false,GET /api/healthz 返回 RFC 9457 503(NOT_READY)。
 * - 缺表/缺列(升级中断/降级残留)与缺迁移记录同等不可就绪;
 * - 原 0001~0004 目录/名单/EPG 表的存在性与可读性不受就绪门禁影响
 *   (health 模块现有行为:仅 healthz 以 503 拒绝,不阻断业务路由装配);
 * - 只读请求不得触发任何自动建表:缺失的 0005 表在请求后仍不存在;
 * - 全部用例只用 os.tmpdir 临时 DATA_DIR,afterEach cleanupRigs()。
 *
 * 写法参照 playback-migration.e2e-spec.ts / policy-migration.e2e-spec.ts,
 * 夹具复用 test/helpers.ts 的 startFreshApp(migrations 选项 + 临时 DATA_DIR)。
 */

/** 阶段 3 完整形态库:仅应用 0001~0004(缺 0005 的部分形态,用于就绪门禁负向与原表安全访问) */
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

/** 0001~0004 既有业务表代表清单(身份/策略/目录/EPG/0004 绑定) */
const LEGACY_TABLES = [
  'household',
  'profile',
  'device_session',
  'catalog_state',
  'media_source',
  'media_item',
  'playback_source',
  'epg_channel',
  'epg_programme',
  'manual_epg_binding',
] as const;

function tableExists(name: string): boolean {
  return Database.db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name) !== undefined;
}

function columnExists(table: string, column: string): boolean {
  return (Database.db.pragma(`table_info(${table})`) as { name: string }[]).some((row) => row.name === column);
}

/**
 * 以「建新表 → 复制 → 换名」模拟 playback_session.desired_paused 缺列:
 * 0005 DDL 的 CHECK 约束(playback_session_desired_paused_check)引用该列,SQLite 运行时
 * 拒绝直接 `ALTER TABLE playback_session DROP COLUMN desired_paused`
 * (error in table playback_session after drop column: no such column),与「运行时不支持
 * DROP COLUMN」同型,故按任务预案以重建表方式模拟升级中断/降级残留。
 * 仅测试内使用(不落 helpers.ts),不是自动补表——重建后缺列,只会更未就绪。
 */
function dropDesiredPausedByRebuild(): void {
  const db = Database.db;
  db.pragma('foreign_keys = OFF'); // 换名期间子表(ticket/conversion)复合FK目标短暂缺失,测试库无播放数据
  try {
    db.transaction(() => {
      db.exec(`
        CREATE TABLE playback_session_missing_column (
            id                TEXT PRIMARY KEY NOT NULL,
            household_id      TEXT NOT NULL,
            device_session_id TEXT NOT NULL,
            device_id         TEXT NOT NULL,
            profile_id        TEXT NOT NULL,
            media_id          TEXT NOT NULL,
            playback_source_id TEXT,
            state             TEXT NOT NULL,
            delivery          TEXT,
            generation        INTEGER NOT NULL,
            version           INTEGER NOT NULL,
            position_seconds  REAL NOT NULL,
            audio_track_id    TEXT,
            subtitle_track_id TEXT,
            created_at        TEXT NOT NULL,
            started_at        TEXT,
            ended_at          TEXT,
            last_heartbeat_at TEXT NOT NULL,
            failure_code      TEXT
        );
        INSERT INTO playback_session_missing_column (
            id, household_id, device_session_id, device_id, profile_id, media_id,
            playback_source_id, state, delivery, generation, version, position_seconds,
            audio_track_id, subtitle_track_id, created_at, started_at, ended_at,
            last_heartbeat_at, failure_code
        )
        SELECT id, household_id, device_session_id, device_id, profile_id, media_id,
               playback_source_id, state, delivery, generation, version, position_seconds,
               audio_track_id, subtitle_track_id, created_at, started_at, ended_at,
               last_heartbeat_at, failure_code
        FROM playback_session;
        DROP TABLE playback_session;
        ALTER TABLE playback_session_missing_column RENAME TO playback_session;
        CREATE UNIQUE INDEX playback_session_household_id_id_key ON playback_session (household_id, id);
      `);
    })();
  } finally {
    db.pragma('foreign_keys = ON');
  }
}

describe('T009 就绪门禁:0005 必需表/列缺失 → isReady false 与 healthz 503,只读不自动补表', () => {
  afterEach(cleanupRigs);

  it('完整迁移库就绪:应用全部迁移后 isReady()===true 且 GET /api/healthz 200', async () => {
    const { app } = await startFreshApp({ prefix: 'hmp-ready-' });

    // 常规路径(默认应用目录全量迁移)下,0005 四表齐备 → 就绪
    for (const table of PLAYBACK_TABLES) {
      expect(tableExists(table), `完整迁移库应有 ${table}`).toBe(true);
    }
    expect(Database.isReady()).toBe(true);

    const res = await request(app.getHttpServer()).get('/api/healthz');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: 'ok', database: 'ok' });
  });

  it('缺 0005 表:DROP playback_ticket 后 isReady()===false、healthz 503(Problem JSON);owner 只读请求按既有语义响应且不自动建表', async () => {
    const { app } = await startFreshApp({ prefix: 'hmp-ready-' });
    // 先建立 owner 会话,保证缺表后的请求全部为只读
    const init = await initialize(app);
    expect(init.status).toBe(201);
    // 005 T036:初始化不再自动登录(无 Set-Cookie),显式登录取得会话 Cookie
    const loggedIn = await login(app, INITIALIZE_BODY.username, INITIALIZE_BODY.password);
    expect(loggedIn.status).toBe(200);
    const cookie = cookiePairOf(loggedIn);

    Database.db.exec('DROP TABLE playback_ticket');
    expect(Database.isReady()).toBe(false);

    // health 模块现有行为:未就绪 → RFC 9457 503 Problem JSON(NOT_READY)
    const res = await request(app.getHttpServer()).get('/api/healthz');
    expect(res.status).toBe(503);
    expectProblemContentType(res);
    expect(res.body).toMatchObject({ status: 503, code: 'NOT_READY' });

    // 只读请求按既有语义响应:0001~0004 业务表读取不受缺 0005 表影响(owner 名单列表 200)
    const profiles = await request(app.getHttpServer()).get('/api/profiles').set('Cookie', cookie);
    expect(profiles.status).toBe(200);

    // 关键:不触发任何自动建表 —— playback_ticket 仍不存在,就绪门禁仍拒绝
    expect(tableExists('playback_ticket')).toBe(false);
    expect(Database.isReady()).toBe(false);
    expect((await request(app.getHttpServer()).get('/api/healthz')).status).toBe(503);
  });

  it('缺 0005 表时播放控制请求 → 503 NOT_READY(PlaybackReadinessGate fail-closed,不裸抛 SqliteError、不自动建表)', async () => {
    const { app } = await startFreshApp({ prefix: 'hmp-ready-' });
    const init = await initialize(app);
    expect(init.status).toBe(201);
    // 005 T036:初始化不再自动登录(无 Set-Cookie),显式登录取得会话 Cookie
    const loggedIn = await login(app, INITIALIZE_BODY.username, INITIALIZE_BODY.password);
    expect(loggedIn.status).toBe(200);
    const cookie = cookiePairOf(loggedIn);

    Database.db.exec('DROP TABLE playback_ticket');
    Database.db.exec('DROP TABLE playback_session');
    expect(Database.isReady()).toBe(false);

    // resolve 在就绪门被拒:稳定 503 Problem(而非未处理 SqliteError),且跨家庭/不存在 id 同形(门先于任何查询)
    const resolve = await request(app.getHttpServer())
      .post('/api/playback/resolve')
      .set('Cookie', cookie)
      .send({ mediaId: 'd2a0b1c2-0000-4000-8000-000000000001' });
    expect(resolve.status).toBe(503);
    expectProblemContentType(resolve);
    expect(resolve.body).toMatchObject({ status: 503, code: 'NOT_READY' });

    // 不自动建表:playback_session 仍不存在,healthz 仍 503
    expect(tableExists('playback_session')).toBe(false);
    expect(Database.isReady()).toBe(false);
    expect((await request(app.getHttpServer()).get('/api/healthz')).status).toBe(503);
  });

  it('缺 0005 必需列:重建 playback_session 去除 desired_paused 后 isReady()===false、healthz 503(Problem JSON)', async () => {
    const { app } = await startFreshApp({ prefix: 'hmp-ready-' });
    expect(columnExists('playback_session', 'desired_paused')).toBe(true);

    dropDesiredPausedByRebuild();

    // 表在列不在(升级中断/降级残留)与缺表同等不可就绪;其余三表仍在,缺列是唯一缺失原因
    expect(tableExists('playback_session')).toBe(true);
    expect(columnExists('playback_session', 'desired_paused')).toBe(false);
    for (const table of PLAYBACK_TABLES.filter((name) => name !== 'playback_session')) {
      expect(tableExists(table), `${table} 应仍在`).toBe(true);
    }
    expect(Database.isReady()).toBe(false);

    const res = await request(app.getHttpServer()).get('/api/healthz');
    expect(res.status).toBe(503);
    expectProblemContentType(res);
    expect(res.body).toMatchObject({ status: 503, code: 'NOT_READY' });
  });

  it('缺 0005 的部分形态库:原 0001~0004 业务表仍可安全访问,就绪门禁不误伤既有表(health 模块仍 503)', async () => {
    // migrations 选项构造只应用 0001~0004 的库(缺 0005 记录/表/列)
    const { app } = await startFreshApp({ prefix: 'hmp-ready-', migrations: STAGE3_MIGRATIONS });

    for (const table of PLAYBACK_TABLES) {
      expect(tableExists(table), `部分形态库不应有 ${table}`).toBe(false);
    }
    // 既有业务表存在性不受就绪门禁影响:0001~0004 全部在且可安全读取
    for (const table of LEGACY_TABLES) {
      expect(tableExists(table), `既有业务表 ${table} 应存在`).toBe(true);
      expect(
        () => Database.db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get(),
        `既有业务表 ${table} 应可安全读取`,
      ).not.toThrow();
    }

    // 就绪门禁:部分形态库未就绪;health 模块现有行为 → 503 Problem JSON
    expect(Database.isReady()).toBe(false);
    const res = await request(app.getHttpServer()).get('/api/healthz');
    expect(res.status).toBe(503);
    expectProblemContentType(res);
    expect(res.body).toMatchObject({ status: 503, code: 'NOT_READY' });
  });
});
