import 'reflect-metadata';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { AppModule } from '../../src/app.module';
import { MediaCatalogModule } from '@contexts/media-catalog/media-catalog.module';
import { Database } from '../../src/database/database';
import { loadEnv } from '../../src/config/env.schema';
import { setEnvOverride } from '../../src/config/env';
import { cleanupRigs, type TestRig } from '../helpers';

/**
 * US1 公共目录契约夹具(T014~T018)——
 * 与 helpers.startFreshApp 同构(独立临时 DATA_DIR + 权威迁移 DDL + /api 前缀),
 * 唯一差异:并发注册 PublicCatalogModule。T023 期间 app.module.ts 的正式注册行由
 * lead 统一接入(任务边界禁止本任务改该文件);lead 接线后 Nest 按类去重,
 * 本显式 import 无副作用,届时可简化回 startFreshApp。
 */

/** 本夹具自持有的 rig(helpers.rigs 未导出;清理函数统一收口) */
const publicRigs: TestRig[] = [];

function migrationsDir(): string {
  return path.join(process.cwd(), 'src/database/migrations');
}

function allMigrationNames(): string[] {
  return fs
    .readdirSync(migrationsDir(), { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
}

function applyMigrations(names: string[]): void {
  const conn = Database.db;
  for (const name of names) {
    const upSqlPath = path.join(migrationsDir(), name, 'up.sql');
    if (!fs.existsSync(upSqlPath)) {
      throw new Error(`未找到迁移 DDL ${upSqlPath} —— 本测试须以 apps/server 为工作目录运行`);
    }
    conn.exec(fs.readFileSync(upSqlPath, 'utf8'));
  }
  const insert = conn.prepare('INSERT INTO _migrations (name, applied_at) VALUES (?, ?)');
  for (const name of names) {
    insert.run(name, new Date().toISOString());
  }
}

/** 全新环境启动(含 PublicCatalogModule):独立临时数据目录 + 应用全部权威迁移 */
export async function startPublicCatalogApp(options: { prefix?: string } = {}): Promise<TestRig> {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), options.prefix ?? 'hmp-public-'));
  const dbFilename = `${randomUUID()}.hmp.db`;
  setEnvOverride(loadEnv({ NODE_ENV: 'test', DATA_DIR: dataDir, DB_FILENAME: dbFilename }));
  Database.close();
  Database.db.exec(
    'CREATE TABLE IF NOT EXISTS _migrations (name TEXT PRIMARY KEY NOT NULL, applied_at TEXT NOT NULL)',
  );
  applyMigrations(allMigrationNames());
  const moduleRef = await Test.createTestingModule({ imports: [AppModule, MediaCatalogModule] }).compile();
  const app: INestApplication = moduleRef.createNestApplication({ logger: ['warn', 'error'] });
  // 与 src/main.ts 相同的全局前缀,保证契约路径 /api/** 与生产一致
  app.setGlobalPrefix('api');
  await app.init();
  const rig: TestRig = { app, dataDir, dbFilename };
  publicRigs.push(rig);
  return rig;
}

/** afterAll 调用:先清理本夹具 rig,再沿用全局清理(幂等) */
export async function cleanupPublicCatalogRigs(): Promise<void> {
  while (publicRigs.length > 0) {
    const rig = publicRigs.pop();
    if (rig === undefined) {
      break;
    }
    await rig.app.close();
    Database.close();
    fs.rmSync(rig.dataDir, { recursive: true, force: true });
  }
  await cleanupRigs();
}

/**
 * 直插已初始化部署(household + owner account),返回 householdId——
 * US1 契约测试只需要「已初始化且有内容」的部署形态,不测 setup 契约本身(US2 T030
 * 独占);US2 并行改造 SetupController 期间走 HTTP 初始化会受其接线进度影响,
 * 直插种子使 US1 契约断言与并行故事解耦。字段语义与 InitializeRequest 缺省一致
 * (幸福之家/zh-CN/Asia/Shanghai + owner 账号,密码仅存哈希)。
 */
export async function seedInitializedHousehold(): Promise<string> {
  const { hashPassword } = await import('@contexts/identity-access/infrastructure/password.service');
  const passwordHash = await hashPassword('password-123');
  const now = '2026-01-01T00:00:00.000Z';
  Database.db
    .prepare(
      "INSERT INTO household (id, name, default_language, timezone, created_at) VALUES ('hh-us1', '幸福之家', 'zh-CN', 'Asia/Shanghai', ?)",
    )
    .run(now);
  Database.db
    .prepare(
      'INSERT INTO account (id, household_id, username, username_normalized, password_hash, role, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    )
    .run('acc-us1-owner', 'hh-us1', 'admin', 'admin', passwordHash, 'owner', now);
  return 'hh-us1';
}
