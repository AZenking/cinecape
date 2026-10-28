import 'reflect-metadata';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { AppModule } from '../src/app.module';
import { SettingsModule } from '../src/contexts/settings/settings.module';
import { Database } from '../src/database/database';
import { loadEnv } from '../src/config/env.schema';
import { setEnvOverride } from '../src/config/env';

/**
 * US7 设置模块专用测试夹具(T073~T076;apps/server/test/helpers.ts 的同构变体)。
 *
 * 与既有 startFreshApp 唯一差异:boot 的 TestingModule 额外 imports SettingsModule。
 * 原因(硬边界):T086/T087 阶段 SettingsModule 尚未写入 app.module.ts(注册行由
 * lead 按报告原文接入),服务端契约/单元测试若经共享 helpers.ts 的 AppModule 单独
 * 启动,/api/settings/** 全部 404。本文件不改动共享 helpers.ts 与 app.module.ts,
 * 仅由 US7 自己的测试文件导入;lead 接入注册行后,本夹具与 startFreshApp 等价
 * (重复 import 同一模块对 Nest 无副作用)。
 */

export { request };

export interface SettingsTestRig {
  app: INestApplication;
  dataDir: string;
  dbFilename: string;
}

const rigs: SettingsTestRig[] = [];

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

async function bootApp(): Promise<INestApplication> {
  const moduleRef = await Test.createTestingModule({ imports: [AppModule, SettingsModule] }).compile();
  const app = moduleRef.createNestApplication({ logger: ['warn', 'error'] });
  app.setGlobalPrefix('api');
  await app.init();
  return app;
}

/** 全新环境启动(AppModule + SettingsModule),其余语义与 helpers.startFreshApp 一致 */
export async function startSettingsApp(options: { prefix?: string; env?: Record<string, string> } = {}): Promise<SettingsTestRig> {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), options.prefix ?? 'hmp-settings-test-'));
  const dbFilename = `${randomUUID()}.hmp.db`;
  setEnvOverride(loadEnv({ NODE_ENV: 'test', DATA_DIR: dataDir, DB_FILENAME: dbFilename, ...options.env }));
  Database.close();
  Database.db.exec('CREATE TABLE IF NOT EXISTS _migrations (name TEXT PRIMARY KEY NOT NULL, applied_at TEXT NOT NULL)');
  applyMigrations(allMigrationNames());
  const app = await bootApp();
  const rig: SettingsTestRig = { app, dataDir, dbFilename };
  rigs.push(rig);
  return rig;
}

/** 同一 DATA_DIR 重启(启动撤销 grants 语义验证);与 helpers.restartApp 同构 */
export async function restartSettingsApp(rig: SettingsTestRig): Promise<INestApplication> {
  await rig.app.close();
  setEnvOverride(loadEnv({ NODE_ENV: 'test', DATA_DIR: rig.dataDir, DB_FILENAME: rig.dbFilename }));
  Database.close();
  const app = await bootApp();
  rig.app = app;
  return app;
}

/** afterEach 调用:关闭并清理全部夹具 */
export async function cleanupSettingsRigs(): Promise<void> {
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
