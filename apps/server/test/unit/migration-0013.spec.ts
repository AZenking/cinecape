import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { Database } from '@platform/database/database';
import { loadEnv } from '@platform/config/env.schema';
import { setEnvOverride } from '@platform/config/env';
import { runMigrationCommand } from '@platform/database/migrate';

/**
 * 021 T001: 0013_source_governance 迁移证据。
 * up 后 source_archive、source_import_snapshot、governance_cleanup_run 与索引存在;
 * down 删除新增表且既有 media_source 行不丢失;up→down→up 循环正常。
 */

const rigs: string[] = [];

function newRig(): string {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hmp-0013-'));
  rigs.push(dataDir);
  setEnvOverride(loadEnv({ NODE_ENV: 'test', DATA_DIR: dataDir, DB_FILENAME: `${randomUUID()}.hmp.db` }));
  return dataDir;
}

function tableExists(table: string): boolean {
  return Database.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table) !== undefined;
}

function indexExists(index: string): boolean {
  return Database.db.prepare("SELECT 1 FROM sqlite_master WHERE type='index' AND name=?").get(index) !== undefined;
}

beforeEach(() => {
  Database.close();
});

afterAll(() => {
  Database.close();
  setEnvOverride(null);
  for (const dir of rigs) fs.rmSync(dir, { recursive: true, force: true });
});

describe('0013_source_governance 迁移与回滚', () => {
  it('全新库 up:归档列、快照表、审计表与索引存在', () => {
    newRig();
    runMigrationCommand('up');
    expect(tableExists('source_archive')).toBe(true);
    expect(tableExists('source_import_snapshot')).toBe(true);
    expect(tableExists('governance_cleanup_run')).toBe(true);
    expect(indexExists('idx_source_archive_household')).toBe(true);
    expect(indexExists('idx_source_import_snapshot_source')).toBe(true);
    expect(indexExists('idx_governance_cleanup_run_household')).toBe(true);
  });

  it('up → down → up:新增对象可逆,既有来源行保留', () => {
    newRig();
    runMigrationCommand('up');
    Database.db
      .prepare(
        `INSERT INTO household (id, name, timezone, created_at, version, main_profile_version)
         VALUES ('h1', '家庭', 'Asia/Shanghai', '2026-11-13T00:00:00.000Z', 1, 1)`,
      )
      .run();
    Database.db
      .prepare(
        `INSERT INTO media_source (id, household_id, kind, name, remote_url, enabled, created_at, updated_at)
         VALUES ('s1', 'h1', 'iptv', '源', 'http://example.com/a.m3u', 1, '2026-11-13T00:00:00.000Z', '2026-11-13T00:00:00.000Z')`,
      )
      .run();

    runMigrationCommand('down');
    expect(tableExists('source_archive')).toBe(false);
    expect(tableExists('source_import_snapshot')).toBe(false);
    expect(tableExists('governance_cleanup_run')).toBe(false);
    expect(Database.db.prepare('SELECT name FROM media_source WHERE id = ?').get('s1')).toEqual({ name: '源' });

    runMigrationCommand('up');
    expect(tableExists('source_archive')).toBe(true);
    expect(tableExists('source_import_snapshot')).toBe(true);
  });
});
