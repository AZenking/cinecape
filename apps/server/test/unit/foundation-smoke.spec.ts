import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { ProblemCode } from '@hmp/shared';
import { Database } from '@platform/database/database';
import { loadEnv } from '@platform/config/env.schema';
import { setEnvOverride } from '@platform/config/env';
import { runMigrationCommand } from '@platform/database/migrate';
import {
  MigrationGateError,
  precheckDatabaseFile,
  precheckForStartup,
} from '@platform/database/precheck';
import {
  cleanupRigs,
  expectProblemContentType,
  startFreshApp,
} from '../helpers';

/**
 * T013(005-pc-browsing-flow · Phase 2):server foundation 冒烟门禁。
 *
 * 只验证 Phase 1~2 已有能力,不承担 005 业务/全量验收(T144):
 * 1. 全新独立临时库:应用目录全量迁移(0001~0006)后 generation2 就绪
 *    (Database.isReady()===true 且 user_version=2);
 * 2. 旧已初始化库(0001~0005)只读拒绝:预检判 STORAGE_GENERATION_UNSUPPORTED
 *    且主库文件 sha256 不变(不得自动升级/清空);
 * 3. 守卫拒绝未认证管理读取:startFreshApp 后无 Cookie 请求既有管理路由
 *    (GET /api/settings/sources、GET /api/settings/devices,均挂 SessionGuard)→ 401 SESSION_INVALID。
 *
 * 夹具照 migration-0006.spec.ts(独立 DATA_DIR + Database.close() 单例重置)与
 * test/helpers.ts(startFreshApp)既有模式;不新增夹具机制。
 */

/** 与生产 migrate.ts 同目录权威迁移清单(当前全量 = 旧代际 + 0006) */
const ALL_MIGRATIONS = [
  '0001_init',
  '0002_profile_policy',
  '0003_media_catalog',
  '0004_manual_epg_binding',
  '0005_playback',
  '0006_pc_experience',
] as const;

const LEGACY_MIGRATIONS = ALL_MIGRATIONS.filter((name) => name !== '0006_pc_experience');

const T0 = '2026-10-26T00:00:00.000Z';

interface LegacyRig {
  dataDir: string;
  dbFilename: string;
  dbFile: string;
}

const legacyRigs: LegacyRig[] = [];

function sha256(file: string): string {
  return createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

/** 旧已初始化库(0001~0005 + 一行业务数据,无 user_version —— 旧应用从不设置) */
function buildLegacyRig(): LegacyRig {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hmp-foundation-legacy-'));
  const dbFilename = `${randomUUID()}.hmp.db`;
  const dbFile = path.join(dataDir, dbFilename);
  legacyRigs.push({ dataDir, dbFilename, dbFile });
  setEnvOverride(loadEnv({ NODE_ENV: 'test', DATA_DIR: dataDir, DB_FILENAME: dbFilename }));
  const db = Database.db;
  db.exec(
    'CREATE TABLE IF NOT EXISTS _migrations (name TEXT PRIMARY KEY NOT NULL, applied_at TEXT NOT NULL)',
  );
  for (const name of LEGACY_MIGRATIONS) {
    const upSql = fs.readFileSync(
      path.join(process.cwd(), 'src/platform/database/migrations', name, 'up.sql'),
      'utf8',
    );
    db.exec(upSql);
    db.prepare('INSERT INTO _migrations (name, applied_at) VALUES (?, ?)').run(name, T0);
  }
  // 一行真实业务数据:拒绝路径必须原样保留(主文件字节不变)
  db.prepare('INSERT INTO household (id, name, created_at) VALUES (?, ?, ?)').run(
    'hh-legacy',
    '旧库家庭',
    T0,
  );
  return { dataDir, dbFilename, dbFile };
}

afterEach(async () => {
  await cleanupRigs(); // 关闭 startFreshApp 夹具并清理临时目录
  Database.close(); // 旧库夹具(无 app)的单例重置
});

afterAll(() => {
  while (legacyRigs.length > 0) {
    const rig = legacyRigs.pop();
    if (rig === undefined) break;
    fs.rmSync(rig.dataDir, { recursive: true, force: true });
  }
  Database.close();
  setEnvOverride(null);
});

describe('T013 foundation 冒烟 · 服务端(仅 Phase 1~2 基础骨架)', () => {
  it('全新独立临时库:全量迁移后 generation2 就绪(isReady=true 且 user_version=2)', () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hmp-foundation-fresh-'));
    const dbFilename = `${randomUUID()}.hmp.db`;
    setEnvOverride(loadEnv({ NODE_ENV: 'test', DATA_DIR: dataDir, DB_FILENAME: dbFilename }));
    try {
      // 迁移前:全新空库放行启动,但业务未就绪(readiness 503 语义)
      expect(precheckForStartup().allowed).toBe(true);
      expect(Database.isReady()).toBe(false);

      runMigrationCommand('up');

      expect(Database.db.pragma('user_version', { simple: true })).toBe(2);
      expect(Database.isReady()).toBe(true);
      const applied = (
        Database.db.prepare('SELECT name FROM _migrations ORDER BY name').all() as { name: string }[]
      ).map((row) => row.name);
      expect(applied).toEqual([...ALL_MIGRATIONS]);
      expect(precheckForStartup().allowed).toBe(true);
    } finally {
      Database.close();
      fs.rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it('旧已初始化库(0001~0005):预检拒绝 STORAGE_GENERATION_UNSUPPORTED 且主文件 sha256 不变', () => {
    const rig = buildLegacyRig();
    Database.close();

    const hashBefore = sha256(rig.dbFile);

    // 只读预检判定(precheck.ts:先于任何写连接/迁移元数据创建)
    const verdict = precheckDatabaseFile(rig.dbFile);
    expect(verdict.kind).toBe('reject');
    expect(verdict.code).toBe('STORAGE_GENERATION_UNSUPPORTED');

    // 迁移入口同样拒绝,错误码一致
    expect(() => runMigrationCommand('up')).toThrowError(MigrationGateError);
    let gateError: unknown = null;
    try {
      runMigrationCommand('up');
    } catch (err) {
      gateError = err;
    }
    expect((gateError as MigrationGateError).code).toBe('STORAGE_GENERATION_UNSUPPORTED');

    // 主文件字节不变:未自动升级、未清空、未写备份
    expect(sha256(rig.dbFile)).toBe(hashBefore);
  });

  it('守卫拒绝未认证管理读取:GET /api/settings/sources 与 /api/devices 无 Cookie → 401 SESSION_INVALID', async () => {
    const rig = await startFreshApp({ prefix: 'hmp-foundation-guard-' });

    for (const adminPath of ['/api/settings/sources', '/api/settings/devices']) {
      const res = await request(rig.app.getHttpServer()).get(adminPath);
      expect(res.status, `${adminPath} 未认证应 401`).toBe(401);
      expectProblemContentType(res);
      expect(res.body.code).toBe(ProblemCode.SESSION_INVALID);
    }
  });

  it('守卫拒绝伪造会话 Cookie 的管理读取:无效令牌 → 401 SESSION_INVALID', async () => {
    const rig = await startFreshApp({ prefix: 'hmp-foundation-guard-forged-' });

    const res = await request(rig.app.getHttpServer())
      .get('/api/settings/devices')
      .set('Cookie', 'hmp_session=forged-invalid-token');
    expect(res.status).toBe(401);
    expectProblemContentType(res);
    expect(res.body.code).toBe(ProblemCode.SESSION_INVALID);
  });
});
