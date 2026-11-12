import 'reflect-metadata';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { expect } from 'vitest';
import type { INestApplication } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import { SESSION_COOKIE } from '@hmp/shared';
import { AppModule } from '../src/app.module';
import { Database } from '@platform/database/database';
import { loadEnv } from '@platform/config/env.schema';
import { setEnvOverride } from '@platform/config/env';

/**
 * 契约 e2e 公共夹具(自 us1-setup-login.e2e-spec.ts 抽取,US1/US3 共用):
 * - 每个用例独立数据目录:env.DATA_DIR 指向 os.tmpdir 下随机子目录,
 *   通过 env.ts 的 setEnvOverride 注入 + Database.close() 重置单例实现;
 * - 表结构来自与生产 migration:up 完全一致的权威 DDL(0001_init/up.sql);
 * - 路径按 apps/server 包根解析(vitest 运行时 cwd 即包根;
 *   tsconfig module=commonjs 下不可用 import.meta,故基于 process.cwd())。
 */

export { request };

export interface TestRig {
  app: INestApplication;
  dataDir: string;
  dbFilename: string;
}

const rigs: TestRig[] = [];

export interface StartAppOptions {
  /** os.tmpdir 下临时目录前缀 */
  prefix?: string;
  /** 追加/覆盖的环境变量(经 zod envSchema 解析,可注入非默认形态,如小数天 TTL) */
  env?: Record<string, string>;
  /**
   * 仅应用指定迁移(默认:按目录序应用全部)。
   * 升级路径用例以 ['0001_init'] 构造阶段 1 形态库,再手工应用 0002 验证回填。
   */
  migrations?: string[];
}

function migrationsDir(): string {
  return path.join(process.cwd(), 'src/platform/database/migrations');
}

/** 迁移目录下按字典序排列的全部迁移名(与 database.ts isReady 的期望清单同源) */
function allMigrationNames(): string[] {
  return fs
    .readdirSync(migrationsDir(), { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
}

/** 应用给定迁移的 up.sql 并记录 _migrations(与生产 migrate.ts 同语义,测试夹具内联实现) */
function applyMigrations(names: string[]): void {
  const conn = Database.db;
  for (const name of names) {
    const upSqlPath = path.join(migrationsDir(), name, 'up.sql');
    if (!fs.existsSync(upSqlPath)) {
      throw new Error(
        `未找到迁移 DDL ${upSqlPath} —— 本测试须以 apps/server 为工作目录运行(pnpm --filter @hmp/server test)`,
      );
    }
    conn.exec(fs.readFileSync(upSqlPath, 'utf8'));
  }
  const insert = conn.prepare('INSERT INTO _migrations (name, applied_at) VALUES (?, ?)');
  for (const name of names) {
    insert.run(name, new Date().toISOString());
  }
}

function applyEnv(dataDir: string, dbFilename: string, extra?: Record<string, string>): void {
  setEnvOverride(loadEnv({ NODE_ENV: 'test', DATA_DIR: dataDir, DB_FILENAME: dbFilename, ...extra }));
}

async function bootApp(): Promise<INestApplication> {
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
  const app = moduleRef.createNestApplication<NestExpressApplication>({
    bodyParser: false,
    logger: ['warn', 'error'],
  });
  app.useBodyParser('json', { limit: '10mb' });
  app.useBodyParser('urlencoded', { extended: true, limit: '10mb' });
  // 与 src/main.ts 相同的全局前缀,保证契约路径 /api/** 与生产一致
  app.setGlobalPrefix('api');
  await app.init();
  return app;
}

/** 全新环境启动:独立临时数据目录 + 应用权威迁移 DDL(默认全部) */
export async function startFreshApp(options: StartAppOptions = {}): Promise<TestRig> {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), options.prefix ?? 'hmp-test-'));
  const dbFilename = `${randomUUID()}.hmp.db`;
  applyEnv(dataDir, dbFilename, options.env);
  Database.close();
  Database.db.exec('CREATE TABLE IF NOT EXISTS _migrations (name TEXT PRIMARY KEY NOT NULL, applied_at TEXT NOT NULL)');
  applyMigrations(options.migrations ?? allMigrationNames());
  const app = await bootApp();
  const rig: TestRig = { app, dataDir, dbFilename };
  rigs.push(rig);
  return rig;
}

/**
 * 场景5/FR-005 重启:同一 DATA_DIR/DB_FILENAME 关闭后重建 AppModule。
 * 不重放迁移 DDL —— 真实重启时库已就绪(0001_init 无 IF NOT EXISTS,重放会失败)。
 */
export async function restartApp(rig: TestRig, env?: Record<string, string>): Promise<INestApplication> {
  await rig.app.close();
  applyEnv(rig.dataDir, rig.dbFilename, env);
  Database.close();
  const app = await bootApp();
  rig.app = app;
  return app;
}

/** afterEach 调用:关闭并清理全部夹具 */
export async function cleanupRigs(): Promise<void> {
  while (rigs.length > 0) {
    const rig = rigs.pop();
    if (rig === undefined) {
      break;
    }
    await rig.app.close();
    Database.close();
    fs.rmSync(rig.dataDir, { recursive: true, force: true });
  }
}

/** 初始化请求体(us1/us3 共用同一 owner 账号) */
export const INITIALIZE_BODY = {
  householdName: '幸福之家',
  username: 'admin',
  password: 'password-123',
} as const;

export function initialize(app: INestApplication): request.Test {
  return request(app.getHttpServer()).post('/api/setup/initialize').send(INITIALIZE_BODY);
}

export interface LoginOptions {
  deviceType?: string;
  deviceName?: string;
}

export function login(
  app: INestApplication,
  username: string,
  password: string,
  options: LoginOptions = {},
): request.Test {
  return request(app.getHttpServer()).post('/api/auth/login').send({ username, password, ...options });
}

/** 取响应中完整 Set-Cookie 值(含属性),用于属性断言 */
export function sessionSetCookieOf(res: { headers: Record<string, unknown> }): string {
  const header = res.headers['set-cookie'] as string | string[] | undefined;
  const cookies = Array.isArray(header) ? header : [header ?? ''];
  const cookie = cookies.find((value) => value.startsWith(`${SESSION_COOKIE}=`));
  if (cookie === undefined) {
    throw new Error(`响应缺少 ${SESSION_COOKIE} Cookie`);
  }
  return cookie;
}

/** 取 name=value 的 Cookie 对,用于回传请求 */
export function cookiePairOf(res: { headers: Record<string, unknown> }): string {
  const full = sessionSetCookieOf(res);
  const separator = full.indexOf(';');
  return separator === -1 ? full.trim() : full.slice(0, separator).trim();
}

export function expectProblemContentType(res: { headers: Record<string, unknown> }): void {
  expect(String(res.headers['content-type'])).toContain('application/problem+json');
}

export * from './fixtures/index';
