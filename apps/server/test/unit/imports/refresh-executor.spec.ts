import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { Database } from '@platform/database/database';
import { setEnvOverride } from '@platform/config/env';
import { loadEnv } from '@platform/config/env.schema';
import { IMPORT_BUDGETS } from '@platform/config/import-budgets';
import { DomainError } from '@platform/http-common/domain-error';
import {
  RefreshExecutorService,
  type RefreshJobView,
} from '@contexts/sources/application/refresh-executor.service';
import { RefreshPublishService } from '@contexts/sources/application/refresh-publish.service';
import {
  buildM3u,
  buildXmltv,
  createControlledMediaServer,
  createNasRootFixture,
  malformedPayloads,
  type ControlledMediaServer,
  type NasRootFixture,
} from '../../helpers';

/**
 * 刷新执行器单元测试(T026;research R5/data-model「状态流转」「发布事务」):
 * - 排队创建:404 同形/SOURCE_DISABLED/IDEMPOTENCY_CONFLICT/SOURCE_BUSY/IMPORT_QUEUE_FULL;
 * - IPTV happy path:queued→runQueuedOnce→succeeded,media/source_entry/playback_source 行数
 *   与 present、协议推断、重复刷新身份不变且 counts 合理;
 * - 解析失败→failed 且旧发布数据不动;发起会话失效→failed(SESSION_INVALID);
 * - 异常快照→awaiting_confirmation(reason+counts+TTL)、懒过期 expired;
 * - 重启恢复 queued/running→interrupted;确认/丢弃状态机(REFRESH_STATE_CONFLICT/REFRESH_STALE/
 *   digest 篡改拒绝);EPG 窗口发布初次/重复。
 * 环境硬约束:全部小体量(每用例 ≤3 条目/≤20 来源行),不做大体量实跑。
 */

interface DbRig {
  dataDir: string;
}

const rigs: DbRig[] = [];
const expiredFixtures: NasRootFixture[] = [];

function migrationsDir(): string {
  return path.join(process.cwd(), 'src/platform/database/migrations');
}

function migrationSql(name: string): string {
  const migrationPath = path.join(migrationsDir(), name, 'up.sql');
  if (!fs.existsSync(migrationPath)) {
    throw new Error(`未找到迁移文件 ${migrationPath} —— 本测试须以 apps/server 为工作目录运行`);
  }
  return fs.readFileSync(migrationPath, 'utf8');
}

function bootstrapRig(
  extraEnv: Record<string, string> = {},
  migrations: string[] = ['0001_init', '0002_profile_policy', '0003_media_catalog'],
): void {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hmp-refresh-exec-'));
  const dbFilename = `${randomUUID()}.hmp.db`;
  setEnvOverride(
    loadEnv({
      NODE_ENV: 'test',
      DATA_DIR: dataDir,
      DB_FILENAME: dbFilename,
      LAN_ALLOWED_TARGETS: '127.0.0.1',
      ...extraEnv,
    }),
  );
  Database.close();
  Database.db.exec(
    'CREATE TABLE IF NOT EXISTS _migrations (name TEXT PRIMARY KEY NOT NULL, applied_at TEXT NOT NULL)',
  );
  for (const name of migrations) {
    Database.db.transaction(() => {
      Database.db.exec(migrationSql(name));
      Database.db
        .prepare('INSERT INTO _migrations (name, applied_at) VALUES (?, ?)')
        .run(name, new Date().toISOString());
    })();
  }
  rigs.push({ dataDir });
}

function cleanupRigs(): void {
  while (rigs.length > 0) {
    const rig = rigs.pop();
    if (rig === undefined) {
      break;
    }
    Database.close();
    setEnvOverride(null);
    fs.rmSync(rig.dataDir, { recursive: true, force: true });
  }
  while (expiredFixtures.length > 0) {
    expiredFixtures.pop()?.cleanup();
  }
}

afterEach(cleanupRigs);

/* ------------------------------------------------------------------ */
/* 造数辅助(全部最小链路,照 catalog-diff.spec.ts 内联模式)             */
/* ------------------------------------------------------------------ */

interface HouseholdScope {
  householdId: string;
  accountId: string;
  sessionId: string;
}

function seedHousehold(): HouseholdScope {
  const db = Database.db;
  const ids: HouseholdScope = {
    householdId: randomUUID(),
    accountId: randomUUID(),
    sessionId: randomUUID(),
  };
  const now = new Date().toISOString();
  db.prepare('INSERT INTO household (id, name, default_language, timezone, created_at) VALUES (?, ?, ?, ?, ?)').run(
    ids.householdId,
    '刷新测试家庭',
    'zh-CN',
    'Asia/Shanghai',
    now,
  );
  db.prepare(
    'INSERT INTO account (id, household_id, username, username_normalized, password_hash, role, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
  ).run(ids.accountId, ids.householdId, `owner-${ids.householdId.slice(0, 8)}`, `owner-${ids.householdId.slice(0, 8)}`, '$argon2id$fixture-hash', 'owner', now);
  db.prepare('INSERT INTO device (id, household_id, name, type, last_seen_at, revoked_at, created_at) VALUES (?, ?, NULL, ?, NULL, NULL, ?)').run(
    randomUUID(),
    ids.householdId,
    'web',
    now,
  );
  const deviceId = db.prepare('SELECT id FROM device WHERE household_id = ?').get(ids.householdId) as { id: string };
  db.prepare(
    'INSERT INTO device_session (id, household_id, account_id, device_id, token_hash, active_profile_id, expires_at, revoked_at, last_active_at, created_at) VALUES (?, ?, ?, ?, ?, NULL, ?, NULL, ?, ?)',
  ).run(ids.sessionId, ids.householdId, ids.accountId, deviceId.id, `hash-${ids.sessionId}`, '2099-01-01T00:00:00Z', now, now);
  db.prepare('INSERT INTO catalog_state (household_id, revision) VALUES (?, 1)').run(ids.householdId);
  return ids;
}

function seedSource(
  householdId: string,
  kind: 'iptv' | 'nas' | 'epg',
  options: { remoteUrl?: string; rootKey?: string; enabled?: number } = {},
): string {
  const sourceId = randomUUID();
  const now = new Date().toISOString();
  const remoteUrl = kind === 'nas' ? null : (options.remoteUrl ?? 'http://lan.example/list.m3u');
  const rootKey = kind === 'nas' ? (options.rootKey ?? 'nas-x') : null;
  const relativeDirectory = kind === 'nas' ? '' : null;
  Database.db
    .prepare(
      "INSERT INTO media_source (id, household_id, kind, name, remote_url, root_key, relative_directory, private_access_approved, epg_source_id, enabled, version, last_success_at, last_job_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, 1, NULL, ?, 1, NULL, NULL, ?, ?)",
    )
    .run(
      sourceId,
      householdId,
      kind,
      `${kind} 来源`,
      remoteUrl,
      rootKey,
      relativeDirectory,
      options.enabled ?? 1,
      now,
      now,
    );
  return sourceId;
}

function makeExecutor(): RefreshExecutorService {
  return new RefreshExecutorService(new RefreshPublishService());
}

function jobRow(householdId: string, refreshId: string): Record<string, unknown> {
  const row = Database.db
    .prepare('SELECT * FROM source_refresh WHERE household_id = ? AND id = ?')
    .get(householdId, refreshId) as Record<string, unknown> | undefined;
  expect(row, '任务行应存在').toBeDefined();
  return row as Record<string, unknown>;
}

function mediaRows(householdId: string): Array<Record<string, unknown>> {
  return Database.db.prepare('SELECT * FROM media_item WHERE household_id = ? ORDER BY title').all(householdId) as Array<
    Record<string, unknown>
  >;
}

function entryRows(householdId: string, sourceId: string): Array<Record<string, unknown>> {
  return Database.db
    .prepare('SELECT * FROM source_entry WHERE household_id = ? AND source_id = ? ORDER BY identity_digest')
    .all(householdId, sourceId) as Array<Record<string, unknown>>;
}

function catalogRevision(householdId: string): number {
  const row = Database.db.prepare('SELECT revision FROM catalog_state WHERE household_id = ?').get(householdId) as {
    revision: number;
  };
  return row.revision;
}

/** 断言抛出 DomainError 且 code 匹配,返回错误供状态断言 */
function domainErrorOf(run: () => unknown, expectedStatus?: number): DomainError {
  let caught: unknown;
  try {
    run();
  } catch (error) {
    caught = error;
  }
  expect(caught, '期望抛出 DomainError').toBeInstanceOf(DomainError);
  const error = caught as DomainError;
  if (expectedStatus !== undefined) {
    expect(error.status).toBe(expectedStatus);
  }
  return error;
}

/** XMLTV 时间戳:UTC +0000 形态(节目窗口以真实当前时刻为基准) */
function xmltvStamp(ms: number): string {
  const d = new Date(ms);
  const pad = (value: number): string => String(value).padStart(2, '0');
  return (
    `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}` +
    `${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())} +0000`
  );
}

/* ------------------------------------------------------------------ */
/* 排队创建(requestRefresh 校验次序)                                    */
/* ------------------------------------------------------------------ */

describe('requestRefresh:排队创建与互斥(contracts/api.md 刷新节)', () => {
  it('创建 queued 任务:version=1、source_version/baseline_revision 快照、initiator 只存 id', () => {
    bootstrapRig();
    const household = seedHousehold();
    const sourceId = seedSource(household.householdId, 'iptv');
    const executor = makeExecutor();

    const job = executor.requestRefresh({
      householdId: household.householdId,
      accountId: household.accountId,
      sessionId: household.sessionId,
      sourceId,
      expectedVersion: 1,
      operationKey: 'op-create-1',
      ownerPasswordVerified: true,
    });

    expect(job.status).toBe('queued');
    expect(job.version).toBe(1);
    expect(job.sourceVersion).toBe(1);
    expect(job.baselineRevision).toBe(1);
    expect(job.errorCode).toBeNull();
    const row = jobRow(household.householdId, job.id);
    expect(row.initiator_account_id).toBe(household.accountId);
    expect(row.initiator_session_id).toBe(household.sessionId);
    expect(row.summary_json).toBeNull();
    // catalog revision 未被请求本身推进(发布才 +1)
    expect(catalogRevision(household.householdId)).toBe(1);
  });

  it('未知来源与跨家庭来源统一 404 同形,不泄漏归属', () => {
    bootstrapRig();
    const household = seedHousehold();
    const other = seedHousehold();
    const otherSourceId = seedSource(other.householdId, 'iptv');
    const executor = makeExecutor();
    const base = {
      householdId: household.householdId,
      accountId: household.accountId,
      sessionId: household.sessionId,
      expectedVersion: 1,
      ownerPasswordVerified: true,
    } as const;
    expect(domainErrorOf(() => executor.requestRefresh({ ...base, sourceId: randomUUID(), operationKey: 'op-404-a' })).status).toBe(404);
    expect(domainErrorOf(() => executor.requestRefresh({ ...base, sourceId: otherSourceId, operationKey: 'op-404-b' })).status).toBe(404);
  });

  it('禁用来源 → 422 SOURCE_DISABLED', () => {
    bootstrapRig();
    const household = seedHousehold();
    const sourceId = seedSource(household.householdId, 'iptv', { enabled: 0 });
    const executor = makeExecutor();
    const error = domainErrorOf(() =>
      executor.requestRefresh({
        householdId: household.householdId,
        accountId: household.accountId,
        sessionId: household.sessionId,
        sourceId,
        expectedVersion: 1,
        operationKey: 'op-disabled',
        ownerPasswordVerified: true,
      }),
    );
    expect(error.status).toBe(422);
    expect(error.code).toBe('SOURCE_DISABLED');
  });

  it('operationKey 幂等:同语义返回原任务;语义不同(source/version)→ 409 IDEMPOTENCY_CONFLICT', () => {
    bootstrapRig();
    const household = seedHousehold();
    const sourceId = seedSource(household.householdId, 'iptv');
    const executor = makeExecutor();
    const base = {
      householdId: household.householdId,
      accountId: household.accountId,
      sessionId: household.sessionId,
      sourceId,
      ownerPasswordVerified: true,
    } as const;

    const first = executor.requestRefresh({ ...base, expectedVersion: 1, operationKey: 'op-idem' });
    const replay = executor.requestRefresh({ ...base, expectedVersion: 1, operationKey: 'op-idem' });
    expect(replay.id).toBe(first.id);
    expect(replay.version).toBe(first.version);

    const conflict = domainErrorOf(() =>
      executor.requestRefresh({ ...base, expectedVersion: 2, operationKey: 'op-idem' }),
    );
    expect(conflict.status).toBe(409);
    expect(conflict.code).toBe('IDEMPOTENCY_CONFLICT');
    // 同 key 异语义被拒后不产生新任务;原任务原样保留
    expect(jobRow(household.householdId, first.id).status).toBe('queued');
  });

  it('同来源已有 queued → 409 SOURCE_BUSY', () => {
    bootstrapRig();
    const household = seedHousehold();
    const sourceId = seedSource(household.householdId, 'iptv');
    const executor = makeExecutor();
    const base = {
      householdId: household.householdId,
      accountId: household.accountId,
      sessionId: household.sessionId,
      sourceId,
      expectedVersion: 1,
      ownerPasswordVerified: true,
    } as const;
    executor.requestRefresh({ ...base, operationKey: 'op-busy-1' });
    const error = domainErrorOf(() => executor.requestRefresh({ ...base, operationKey: 'op-busy-2' }));
    expect(error.status).toBe(409);
    expect(error.code).toBe('SOURCE_BUSY');
  });

  it(`全局 queued 达 ${20} 上限 → 429 IMPORT_QUEUE_FULL(20 个来源各 1 条小体量任务行)`, () => {
    bootstrapRig();
    const household = seedHousehold();
    const executor = makeExecutor();
    const base = {
      householdId: household.householdId,
      accountId: household.accountId,
      sessionId: household.sessionId,
      expectedVersion: 1,
      ownerPasswordVerified: true,
    } as const;
    for (let index = 0; index < IMPORT_BUDGETS.IMPORT_QUEUE_CAPACITY; index += 1) {
      const sourceId = seedSource(household.householdId, 'iptv');
      executor.requestRefresh({ ...base, sourceId, operationKey: `op-q-${index}` });
    }
    const overflowSourceId = seedSource(household.householdId, 'iptv');
    const error = domainErrorOf(() => executor.requestRefresh({ ...base, sourceId: overflowSourceId, operationKey: 'op-q-overflow' }));
    expect(error.status).toBe(429);
    expect(error.code).toBe('IMPORT_QUEUE_FULL');
  });

  it('expectedVersion 与来源当前版本不符 → 409 SOURCE_VERSION_CONFLICT', () => {
    bootstrapRig();
    const household = seedHousehold();
    const sourceId = seedSource(household.householdId, 'iptv');
    const executor = makeExecutor();
    const error = domainErrorOf(() =>
      executor.requestRefresh({
        householdId: household.householdId,
        accountId: household.accountId,
        sessionId: household.sessionId,
        sourceId,
        expectedVersion: 2,
        operationKey: 'op-version',
        ownerPasswordVerified: true,
      }),
    );
    expect(error.status).toBe(409);
    expect(error.code).toBe('SOURCE_VERSION_CONFLICT');
  });
});

/* ------------------------------------------------------------------ */
/* IPTV happy path / 重复刷新身份稳定                                   */
/* ------------------------------------------------------------------ */

describe('runQueuedOnce:IPTV 发布(research R5 发布事务)', () => {
  const PLAYLIST = [
    { name: 'CCTV-1', url: 'http://stream.example/cctv1.m3u8', tvgId: 'cctv-1' },
    { name: 'CCTV-2', url: 'http://stream.example/cctv2', tvgId: 'cctv-2' },
    { name: 'CCTV-3', url: 'http://stream.example/cctv3?token=abc' },
  ];

  async function publishBaseline(): Promise<{
    household: HouseholdScope;
    sourceId: string;
    server: ControlledMediaServer;
    executor: RefreshExecutorService;
    first: RefreshJobView;
  }> {
    bootstrapRig();
    const household = seedHousehold();
    const server = await createControlledMediaServer();
    server.setRoute('/list.m3u', { kind: 'm3u', content: buildM3u(PLAYLIST) });
    const sourceId = seedSource(household.householdId, 'iptv', { remoteUrl: `${server.baseUrl}/list.m3u` });
    const executor = makeExecutor();
    const job = executor.requestRefresh({
      householdId: household.householdId,
      accountId: household.accountId,
      sessionId: household.sessionId,
      sourceId,
      expectedVersion: 1,
      operationKey: 'op-happy',
      ownerPasswordVerified: true,
    });
    const first = await executor.runQueuedOnce();
    expect(first?.id).toBe(job.id);
    return { household, sourceId, server, executor, first: first as RefreshJobView };
  }

  it('首次导入:succeeded,media/source_entry/playback_source 行数与 present、协议推断、revision+1', async () => {
    const scene = await publishBaseline();
    try {
      const { household, sourceId, first } = scene;
      expect(first.status).toBe('succeeded');
      expect(first.errorCode).toBeNull();
      expect(first.version).toBe(3); // queued1 → running2 → succeeded3
      expect(first.counts).toEqual({ added: 3, updated: 0, missing: 0 });

      const media = mediaRows(household.householdId);
      expect(media).toHaveLength(3);
      for (const row of media) {
        expect(row.type).toBe('channel');
        expect(row.content_level).toBeNull();
        expect(row.title_overridden).toBe(0);
      }
      const titles = media.map((row) => row.title).sort();
      expect(titles).toEqual(['CCTV-1', 'CCTV-2', 'CCTV-3']);

      const entries = entryRows(household.householdId, sourceId);
      expect(entries).toHaveLength(3);
      for (const entry of entries) {
        expect(entry.present).toBe(1);
        expect(entry.last_seen_job_id).toBe(first.id);
        expect(entry.first_seen_at).not.toBeNull();
        expect(entry.missing_since).toBeNull();
      }
      const kinds = entries.map((row) => row.identity_kind).sort();
      expect(kinds).toEqual(['tvg_id', 'tvg_id', 'url']);

      const playbacks = Database.db.prepare('SELECT * FROM playback_source WHERE household_id = ?').all(household.householdId) as Array<
        Record<string, unknown>
      >;
      expect(playbacks).toHaveLength(3);
      const hls = playbacks.filter((row) => row.protocol === 'hls');
      expect(hls).toHaveLength(1);
      expect(String(hls[0]?.location).endsWith('.m3u8')).toBe(true);
      for (const row of playbacks) {
        expect(row.priority).toBe(100);
        expect(row.requires_proxy).toBe(0);
        expect(String(row.location)).toContain('http://');
      }

      const source = Database.db.prepare('SELECT * FROM media_source WHERE id = ?').get(sourceId) as Record<string, unknown>;
      expect(source.last_success_at).not.toBeNull();
      expect(source.last_job_id).toBe(first.id);
      expect(catalogRevision(household.householdId)).toBe(2);
    } finally {
      await scene.server.close();
    }
  });

  it('重复刷新:身份不变(media/source_entry/playback id 稳定),counts added=0 updated=3 missing=0', async () => {
    const scene = await publishBaseline();
    try {
      const { household, sourceId, executor } = scene;
      const mediaBefore = mediaRows(household.householdId).map((row) => row.id);
      const entriesBefore = entryRows(household.householdId, sourceId).map((row) => row.id);
      const playbackBefore = (
        Database.db.prepare('SELECT id FROM playback_source WHERE household_id = ? ORDER BY id').all(household.householdId) as Array<{
          id: string;
        }>
      ).map((row) => row.id);

      const job = executor.requestRefresh({
        householdId: household.householdId,
        accountId: household.accountId,
        sessionId: household.sessionId,
        sourceId,
        expectedVersion: 1,
        operationKey: 'op-repeat',
        ownerPasswordVerified: true,
      });
      const second = (await executor.runQueuedOnce()) as RefreshJobView;
      expect(second.id).toBe(job.id);
      expect(second.status).toBe('succeeded');
      expect(second.counts).toEqual({ added: 0, updated: 3, missing: 0 });

      expect(mediaRows(household.householdId).map((row) => row.id)).toEqual(mediaBefore);
      expect(entryRows(household.householdId, sourceId).map((row) => row.id)).toEqual(entriesBefore);
      expect(
        (
          Database.db.prepare('SELECT id FROM playback_source WHERE household_id = ? ORDER BY id').all(household.householdId) as Array<{
            id: string;
          }>
        ).map((row) => row.id),
      ).toEqual(playbackBefore);
      expect(mediaRows(household.householdId)).toHaveLength(3);
    } finally {
      await scene.server.close();
    }
  });

  it('解析失败 → failed(稳定 code),旧发布数据与 revision 不动', async () => {
    const scene = await publishBaseline();
    try {
      const { household, sourceId, server, executor } = scene;
      server.setRoute('/list.m3u', { kind: 'body', body: malformedPayloads.malformedM3u(), contentType: 'audio/x-mpegurl' });
      const revisionBefore = catalogRevision(household.householdId);
      const successAtBefore = (
        Database.db.prepare('SELECT last_success_at FROM media_source WHERE id = ?').get(sourceId) as { last_success_at: string }
      ).last_success_at;

      const job = executor.requestRefresh({
        householdId: household.householdId,
        accountId: household.accountId,
        sessionId: household.sessionId,
        sourceId,
        expectedVersion: 1,
        operationKey: 'op-broken',
        ownerPasswordVerified: true,
      });
      const failed = (await executor.runQueuedOnce()) as RefreshJobView;
      expect(failed.id).toBe(job.id);
      expect(failed.status).toBe('failed');
      expect(failed.errorCode).toBe('M3U_ENTRY_MISSING_URL');
      expect(failed.finishedAt).not.toBeNull();

      expect(mediaRows(household.householdId)).toHaveLength(3);
      expect(catalogRevision(household.householdId)).toBe(revisionBefore);
      expect(
        (Database.db.prepare('SELECT last_success_at FROM media_source WHERE id = ?').get(sourceId) as { last_success_at: string })
          .last_success_at,
      ).toBe(successAtBefore);
      // 失败任务不保留暂存(终态不可确认)
      const staged = Database.db.prepare('SELECT COUNT(*) AS n FROM refresh_stage_entry WHERE household_id = ?').get(household.householdId) as {
        n: number;
      };
      expect(staged.n).toBe(0);
    } finally {
      await scene.server.close();
    }
  });

  it('自动发布前发起会话已撤销 → failed(SESSION_INVALID),不产生发布数据', async () => {
    bootstrapRig();
    const household = seedHousehold();
    const server = await createControlledMediaServer();
    try {
      server.setRoute('/list.m3u', { kind: 'm3u', content: buildM3u(PLAYLIST) });
      const sourceId = seedSource(household.householdId, 'iptv', { remoteUrl: `${server.baseUrl}/list.m3u` });
      const executor = makeExecutor();
      const job = executor.requestRefresh({
        householdId: household.householdId,
        accountId: household.accountId,
        sessionId: household.sessionId,
        sourceId,
        expectedVersion: 1,
        operationKey: 'op-revoked',
        ownerPasswordVerified: true,
      });
      Database.db.prepare('UPDATE device_session SET revoked_at = ? WHERE id = ?').run(
        new Date().toISOString(),
        household.sessionId,
      );
      const result = (await executor.runQueuedOnce()) as RefreshJobView;
      expect(result.id).toBe(job.id);
      expect(result.status).toBe('failed');
      expect(result.errorCode).toBe('SESSION_INVALID');
      expect(mediaRows(household.householdId)).toHaveLength(0);
    } finally {
      await server.close();
    }
  });
});

/* ------------------------------------------------------------------ */
/* 异常快照:awaiting_confirmation + 过期                                */
/* ------------------------------------------------------------------ */

describe('异常快照与过期(research R5:待确认不自动发布)', () => {
  it('缺失 2/3(≥25%)→ awaiting_confirmation(deletion_ratio_exceeded)+TTL;懒过期 expired', async () => {
    bootstrapRig();
    const household = seedHousehold();
    const server = await createControlledMediaServer();
    try {
      server.setRoute('/list.m3u', {
        kind: 'm3u',
        content: buildM3u([
          { name: 'CCTV-1', url: 'http://stream.example/cctv1.m3u8', tvgId: 'cctv-1' },
          { name: 'CCTV-2', url: 'http://stream.example/cctv2', tvgId: 'cctv-2' },
          { name: 'CCTV-3', url: 'http://stream.example/cctv3' },
        ]),
      });
      const sourceId = seedSource(household.householdId, 'iptv', { remoteUrl: `${server.baseUrl}/list.m3u` });
      const executor = makeExecutor();
      executor.requestRefresh({
        householdId: household.householdId,
        accountId: household.accountId,
        sessionId: household.sessionId,
        sourceId,
        expectedVersion: 1,
        operationKey: 'op-base',
        ownerPasswordVerified: true,
      });
      expect((await executor.runQueuedOnce())?.status).toBe('succeeded');

      server.setRoute('/list.m3u', {
        kind: 'm3u',
        content: buildM3u([{ name: 'CCTV-1 改名', url: 'http://stream.example/cctv1.m3u8', tvgId: 'cctv-1' }]),
      });
      const createdBefore = Date.now();
      const job = executor.requestRefresh({
        householdId: household.householdId,
        accountId: household.accountId,
        sessionId: household.sessionId,
        sourceId,
        expectedVersion: 1,
        operationKey: 'op-await',
        ownerPasswordVerified: true,
      });
      const awaiting = (await executor.runQueuedOnce()) as RefreshJobView;
      expect(awaiting.id).toBe(job.id);
      expect(awaiting.status).toBe('awaiting_confirmation');
      expect(awaiting.confirmationReason).toBe('deletion_ratio_exceeded');
      expect(awaiting.counts).toEqual({ added: 0, updated: 1, missing: 2 });
      expect(awaiting.expiresAt).not.toBeNull();
      const ttlMs = Date.parse(awaiting.expiresAt as string) - createdBefore;
      expect(ttlMs).toBeGreaterThanOrEqual(IMPORT_BUDGETS.AWAITING_CONFIRMATION_TTL_MS - 1000);
      expect(ttlMs).toBeLessThanOrEqual(IMPORT_BUDGETS.AWAITING_CONFIRMATION_TTL_MS + 1000);
      // 待确认不发布:CCTV-2/3 仍 present,revision 不动
      const presentCount = Database.db.prepare(
        'SELECT COUNT(*) AS n FROM source_entry WHERE household_id = ? AND source_id = ? AND present = 1',
      ).get(household.householdId, sourceId) as { n: number };
      expect(presentCount.n).toBe(3);
      expect(catalogRevision(household.householdId)).toBe(2);

      // 未到期:懒过期不动作
      expect(executor.expireStaleConfirmations(Date.parse(awaiting.expiresAt as string) - 1000)).toBe(0);
      // 到期:标 expired
      expect(executor.expireStaleConfirmations(Date.parse(awaiting.expiresAt as string) + 1000)).toBe(1);
      expect(jobRow(household.householdId, job.id).status).toBe('expired');
      // 终态过期任务确认 → REFRESH_STATE_CONFLICT
      const error = domainErrorOf(() =>
        executor.confirmRefresh({ householdId: household.householdId, refreshId: job.id, expectedVersion: awaiting.version }),
      );
      expect(error.code).toBe('REFRESH_STATE_CONFLICT');
    } finally {
      await server.close();
    }
  });

  it('确认时已过期(懒检查)→ 409 REFRESH_STALE 并顺带标 expired', async () => {
    // 空快照经 NAS 构造(解析器按规格拒绝 0 条目的 M3U,无法产生合法空 IPTV 快照):
    // 基线 1 文件 → 移除后重扫为空 → empty_snapshot 待确认
    const fixture = createNasRootFixture();
    expiredFixtures.push(fixture);
    fixture.write('Movies/only.mkv', 'only-content');
    bootstrapRig({ MEDIA_ROOTS: `${fixture.rootKey}=${fixture.rootPath}` });
    const household = seedHousehold();
    const sourceId = seedSource(household.householdId, 'nas', { rootKey: fixture.rootKey });
    const executor = makeExecutor();
    executor.requestRefresh({
      householdId: household.householdId,
      accountId: household.accountId,
      sessionId: household.sessionId,
      sourceId,
      expectedVersion: 1,
      operationKey: 'op-base-2',
      ownerPasswordVerified: true,
    });
    expect((await executor.runQueuedOnce())?.status).toBe('succeeded');
    fixture.remove('Movies/only.mkv');
    const job = executor.requestRefresh({
      householdId: household.householdId,
      accountId: household.accountId,
      sessionId: household.sessionId,
      sourceId,
      expectedVersion: 1,
      operationKey: 'op-await-2',
      ownerPasswordVerified: true,
    });
    const awaiting = (await executor.runQueuedOnce()) as RefreshJobView;
    expect(awaiting.status).toBe('awaiting_confirmation');
    expect(awaiting.confirmationReason).toBe('empty_snapshot');
    Database.db.prepare('UPDATE source_refresh SET expires_at = ? WHERE id = ?').run(
      new Date(Date.now() - 1000).toISOString(),
      job.id,
    );
    const error = domainErrorOf(() =>
      executor.confirmRefresh({ householdId: household.householdId, refreshId: job.id, expectedVersion: awaiting.version }),
    );
    expect(error.status).toBe(409);
    expect(error.code).toBe('REFRESH_STALE');
    expect(jobRow(household.householdId, job.id).status).toBe('expired');
  });
});

/* ------------------------------------------------------------------ */
/* 重启恢复                                                             */
/* ------------------------------------------------------------------ */

describe('recoverInterrupted:重启恢复(research R5)', () => {
  it('queued/running → interrupted(version+1),不自动重跑', async () => {
    bootstrapRig();
    const household = seedHousehold();
    const server = await createControlledMediaServer();
    try {
      server.setRoute('/list.m3u', { kind: 'm3u', content: buildM3u([{ name: 'CCTV-1', url: 'http://s/1', tvgId: 'a' }]) });
      const sourceId = seedSource(household.householdId, 'iptv', { remoteUrl: `${server.baseUrl}/list.m3u` });
      const executor = makeExecutor();
      const queued = executor.requestRefresh({
        householdId: household.householdId,
        accountId: household.accountId,
        sessionId: household.sessionId,
        sourceId,
        expectedVersion: 1,
        operationKey: 'op-recover-q',
        ownerPasswordVerified: true,
      });
      // 手工构造一个 running 任务(第二个来源,模拟中断现场)
      const sourceId2 = seedSource(household.householdId, 'iptv', { remoteUrl: `${server.baseUrl}/list.m3u` });
      const running = executor.requestRefresh({
        householdId: household.householdId,
        accountId: household.accountId,
        sessionId: household.sessionId,
        sourceId: sourceId2,
        expectedVersion: 1,
        operationKey: 'op-recover-r',
        ownerPasswordVerified: true,
      });
      Database.db.prepare("UPDATE source_refresh SET status='running', version=version+1 WHERE id = ?").run(running.id);

      expect(executor.recoverInterrupted()).toBe(2);
      expect(jobRow(household.householdId, queued.id).status).toBe('interrupted');
      expect(jobRow(household.householdId, queued.id).version).toBe(2);
      expect(jobRow(household.householdId, running.id).status).toBe('interrupted');
      // interrupted 不被执行器拾取
      expect(await executor.runQueuedOnce()).toBeNull();
    } finally {
      await server.close();
    }
  });
});

/* ------------------------------------------------------------------ */
/* 确认/丢弃状态机                                                      */
/* ------------------------------------------------------------------ */

describe('confirmRefresh/discardRefresh:待确认状态机(contracts/api.md)', () => {
  /** 基线 3 条 → 快照 1 条(missing 2/3)→ awaiting */
  async function awaitingScene(): Promise<{
    household: HouseholdScope;
    sourceId: string;
    server: ControlledMediaServer;
    executor: RefreshExecutorService;
    job: RefreshJobView;
  }> {
    bootstrapRig();
    const household = seedHousehold();
    const server = await createControlledMediaServer();
    server.setRoute('/list.m3u', {
      kind: 'm3u',
      content: buildM3u([
        { name: 'CCTV-1', url: 'http://stream.example/cctv1.m3u8', tvgId: 'cctv-1' },
        { name: 'CCTV-2', url: 'http://stream.example/cctv2', tvgId: 'cctv-2' },
        { name: 'CCTV-3', url: 'http://stream.example/cctv3' },
      ]),
    });
    const sourceId = seedSource(household.householdId, 'iptv', { remoteUrl: `${server.baseUrl}/list.m3u` });
    const executor = makeExecutor();
    executor.requestRefresh({
      householdId: household.householdId,
      accountId: household.accountId,
      sessionId: household.sessionId,
      sourceId,
      expectedVersion: 1,
      operationKey: 'op-c-base',
      ownerPasswordVerified: true,
    });
    expect((await executor.runQueuedOnce())?.status).toBe('succeeded');
    server.setRoute('/list.m3u', {
      kind: 'm3u',
      content: buildM3u([{ name: 'CCTV-1 保留', url: 'http://stream.example/cctv1.m3u8', tvgId: 'cctv-1' }]),
    });
    const created = executor.requestRefresh({
      householdId: household.householdId,
      accountId: household.accountId,
      sessionId: household.sessionId,
      sourceId,
      expectedVersion: 1,
      operationKey: 'op-c-await',
      ownerPasswordVerified: true,
    });
    const job = (await executor.runQueuedOnce()) as RefreshJobView;
    expect(job.id).toBe(created.id);
    expect(job.status).toBe('awaiting_confirmation');
    return { household, sourceId, server, executor, job };
  }

  it('确认成功:单事务发布,missing 条目标 present=0,revision+1,终态确认再拒 409', async () => {
    const scene = await awaitingScene();
    try {
      const { household, sourceId, executor, job } = scene;
      const confirmed = executor.confirmRefresh({
        householdId: household.householdId,
        refreshId: job.id,
        expectedVersion: job.version,
      });
      expect(confirmed.status).toBe('succeeded');
      expect(confirmed.version).toBe(job.version + 1);
      expect(confirmed.counts).toEqual({ added: 0, updated: 1, missing: 2 });

      const entries = entryRows(household.householdId, sourceId);
      expect(entries.filter((row) => row.present === 1)).toHaveLength(1);
      const missing = entries.filter((row) => row.present === 0);
      expect(missing).toHaveLength(2);
      for (const row of missing) {
        expect(row.missing_since).not.toBeNull();
      }
      expect(catalogRevision(household.householdId)).toBe(3);
      expect(mediaRows(household.householdId)).toHaveLength(3); // 不删除 media_item

      const again = domainErrorOf(() =>
        executor.confirmRefresh({ householdId: household.householdId, refreshId: job.id, expectedVersion: confirmed.version }),
      );
      expect(again.status).toBe(409);
      expect(again.code).toBe('REFRESH_STATE_CONFLICT');
    } finally {
      await scene.server.close();
    }
  });

  it('expectedVersion 不匹配 → 409 REFRESH_STATE_CONFLICT,任务保持待确认', async () => {
    const scene = await awaitingScene();
    try {
      const { household, executor, job } = scene;
      const error = domainErrorOf(() =>
        executor.confirmRefresh({ householdId: household.householdId, refreshId: job.id, expectedVersion: job.version + 5 }),
      );
      expect(error.status).toBe(409);
      expect(error.code).toBe('REFRESH_STATE_CONFLICT');
      expect(jobRow(household.householdId, job.id).status).toBe('awaiting_confirmation');
    } finally {
      await scene.server.close();
    }
  });

  it('暂存 digest 被篡改 → 409 REFRESH_STALE 并标 stale,不发布', async () => {
    const scene = await awaitingScene();
    try {
      const { household, executor, job } = scene;
      Database.db.prepare('UPDATE refresh_stage_entry SET payload_json = ? WHERE household_id = ? AND refresh_id = ?').run(
        JSON.stringify({
          tvgId: 'cctv-1',
          title: '被篡改',
          url: 'http://stream.example/cctv1.m3u8',
          identityKind: 'tvg_id',
          identityDigest: 'aa'.repeat(32),
          entryKey: `tvg_id:${'aa'.repeat(32)}`,
        }),
        household.householdId,
        job.id,
      );
      const error = domainErrorOf(() =>
        executor.confirmRefresh({ householdId: household.householdId, refreshId: job.id, expectedVersion: job.version }),
      );
      expect(error.status).toBe(409);
      expect(error.code).toBe('REFRESH_STALE');
      expect(jobRow(household.householdId, job.id).status).toBe('stale');
      expect(catalogRevision(household.householdId)).toBe(2);
    } finally {
      await scene.server.close();
    }
  });

  it('来源版本/目录 revision 已变化 → 409 REFRESH_STALE 并标 stale', async () => {
    const scene = await awaitingScene();
    try {
      const { household, sourceId, executor, job } = scene;
      Database.db.prepare('UPDATE media_source SET version = version + 1 WHERE id = ?').run(sourceId);
      const error = domainErrorOf(() =>
        executor.confirmRefresh({ householdId: household.householdId, refreshId: job.id, expectedVersion: job.version }),
      );
      expect(error.code).toBe('REFRESH_STALE');
      expect(jobRow(household.householdId, job.id).status).toBe('stale');

      // 另建一版待确认任务,篡改 catalog revision → REFRESH_STALE
      const created = executor.requestRefresh({
        householdId: household.householdId,
        accountId: household.accountId,
        sessionId: household.sessionId,
        sourceId,
        expectedVersion: 2,
        operationKey: 'op-c-await-2',
        ownerPasswordVerified: true,
      });
      expect(created.baselineRevision).toBe(2);
      const job2 = (await executor.runQueuedOnce()) as RefreshJobView;
      expect(job2.status).toBe('awaiting_confirmation');
      Database.db.prepare('UPDATE catalog_state SET revision = revision + 1 WHERE household_id = ?').run(household.householdId);
      const error2 = domainErrorOf(() =>
        executor.confirmRefresh({ householdId: household.householdId, refreshId: job2.id, expectedVersion: job2.version }),
      );
      expect(error2.code).toBe('REFRESH_STALE');
      expect(jobRow(household.householdId, job2.id).status).toBe('stale');
    } finally {
      await scene.server.close();
    }
  });

  it('丢弃:仅 awaiting 可丢弃 → discarded + 清暂存 + 释放来源锁', async () => {
    const scene = await awaitingScene();
    try {
      const { household, sourceId, executor, job } = scene;
      const wrong = domainErrorOf(() =>
        executor.discardRefresh({ householdId: household.householdId, refreshId: job.id, expectedVersion: job.version + 1 }),
      );
      expect(wrong.code).toBe('REFRESH_STATE_CONFLICT');

      const discarded = executor.discardRefresh({
        householdId: household.householdId,
        refreshId: job.id,
        expectedVersion: job.version,
      });
      expect(discarded.status).toBe('discarded');
      expect(discarded.version).toBe(job.version + 1);
      const staged = Database.db.prepare('SELECT COUNT(*) AS n FROM refresh_stage_entry WHERE household_id = ?').get(household.householdId) as {
        n: number;
      };
      expect(staged.n).toBe(0);
      // 来源锁已释放:新任务可创建
      const next = executor.requestRefresh({
        householdId: household.householdId,
        accountId: household.accountId,
        sessionId: household.sessionId,
        sourceId,
        expectedVersion: 1,
        operationKey: 'op-after-discard',
        ownerPasswordVerified: true,
      });
      expect(next.status).toBe('queued');
      // 丢弃后的终态重复操作拒绝
      const again = domainErrorOf(() =>
        executor.discardRefresh({ householdId: household.householdId, refreshId: job.id, expectedVersion: discarded.version }),
      );
      expect(again.code).toBe('REFRESH_STATE_CONFLICT');
    } finally {
      await scene.server.close();
    }
  });
});

/* ------------------------------------------------------------------ */
/* EPG 窗口发布(T026 内含:原子替换/去重/冲突标记,不建 MediaItem)        */
/* ------------------------------------------------------------------ */

describe('runQueuedOnce:EPG 窗口发布', () => {
  it('初次发布 counts.channels/programmes;重复发布同内容窗口替换且计数稳定;不创建 media_item', async () => {
    bootstrapRig();
    const household = seedHousehold();
    const server = await createControlledMediaServer();
    try {
      const hourMs = 3_600_000;
      const base = Date.now() + hourMs;
      const xml = buildXmltv(
        [
          { id: 'cctv-1', displayName: '央视一套' },
          { id: 'cctv-2' },
        ],
        [
          { channel: 'cctv-1', start: xmltvStamp(base), stop: xmltvStamp(base + hourMs), title: '新闻' },
          { channel: 'cctv-1', start: xmltvStamp(base + hourMs), stop: xmltvStamp(base + 2 * hourMs), title: '剧场' },
        ],
      );
      server.setRoute('/guide.xml', { kind: 'xmltv', content: xml });
      const sourceId = seedSource(household.householdId, 'epg', { remoteUrl: `${server.baseUrl}/guide.xml` });
      const executor = makeExecutor();
      const firstJob = executor.requestRefresh({
        householdId: household.householdId,
        accountId: household.accountId,
        sessionId: household.sessionId,
        sourceId,
        expectedVersion: 1,
        operationKey: 'op-epg-1',
        ownerPasswordVerified: true,
      });
      const first = (await executor.runQueuedOnce()) as RefreshJobView;
      expect(first.id).toBe(firstJob.id);
      expect(first.status).toBe('succeeded');
      expect(first.counts).toEqual({ channels: 2, programmes: 2 });
      expect(mediaRows(household.householdId)).toHaveLength(0);
      const channels = Database.db.prepare('SELECT * FROM epg_channel WHERE household_id = ? ORDER BY xmltv_channel_id').all(household.householdId) as Array<
        Record<string, unknown>
      >;
      expect(channels).toHaveLength(2);
      expect(channels[0]?.display_name).toBe('央视一套');
      const programmes = Database.db.prepare('SELECT * FROM epg_programme WHERE household_id = ?').all(household.householdId) as Array<
        Record<string, unknown>
      >;
      expect(programmes).toHaveLength(2);
      expect(catalogRevision(household.householdId)).toBe(2);

      // 重复发布同内容:窗口替换,programmes 仍 2 条(无重复堆积)
      const second = executor.requestRefresh({
        householdId: household.householdId,
        accountId: household.accountId,
        sessionId: household.sessionId,
        sourceId,
        expectedVersion: 1,
        operationKey: 'op-epg-2',
        ownerPasswordVerified: true,
      });
      const secondResult = (await executor.runQueuedOnce()) as RefreshJobView;
      expect(secondResult.id).toBe(second.id);
      expect(secondResult.status).toBe('succeeded');
      expect(secondResult.counts).toEqual({ channels: 2, programmes: 2 });
      expect(
        (Database.db.prepare('SELECT COUNT(*) AS n FROM epg_programme WHERE household_id = ?').get(household.householdId) as { n: number }).n,
      ).toBe(2);
    } finally {
      await server.close();
    }
  });
});

/* ------------------------------------------------------------------ */
/* 部分迁移库守卫(readiness 语义:缺表降级,AppModule 启动不得崩溃)      */
/* ------------------------------------------------------------------ */

describe('部分迁移库(未应用 0003)上自动路径静默跳过', () => {
  it('仅应用 0001/0002 时 recoverInterrupted/expireStaleConfirmations/runQueuedOnce 不抛错且零操作', async () => {
    bootstrapRig({}, ['0001_init', '0002_profile_policy']);
    const executor = new RefreshExecutorService(new RefreshPublishService());

    expect(() => executor.onModuleInit()).not.toThrow();
    executor.onModuleDestroy();

    expect(executor.recoverInterrupted()).toBe(0);
    expect(executor.expireStaleConfirmations()).toBe(0);
    await expect(executor.runQueuedOnce()).resolves.toBeNull();

    const table = Database.db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'source_refresh'")
      .get() as { name: string } | undefined;
    expect(table).toBeUndefined();
  });
});
