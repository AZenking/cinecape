import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { Database } from '../../../src/database/database';
import { setEnvOverride } from '../../../src/config/env';
import { loadEnv } from '../../../src/config/env.schema';
import { DomainError } from '../../../src/common/domain-error';
import {
  RefreshExecutorService,
  type RefreshJobView,
} from '../../../src/modules/imports/refresh-executor.service';
import { RefreshPublishService } from '../../../src/modules/imports/refresh-publish.service';
import { createNasRootFixture, type NasRootFixture } from '../../helpers';

/**
 * NAS 同路径替换清理事务测试(T027;FR-022/SC-009/research R4):
 * - 同来源同相对路径文件 size 或 mtimeNs 变化 → 发布事务内:保留媒体身份、content_level=null、
 *   全部 Profile 的 allowedMediaIds 移除该媒体 id、blockedMediaIds 保留、每个受影响档案 version 只 +1;
 * - 同 size 同 mtime 未变化 → 原配置保留(分级/名单/策略 version 均不动);
 * - 损坏策略 JSON → 整个发布失败无部分成功(任务 failed=POLICY_UNAVAILABLE,发布数据零变化);
 * - 确认时 NAS staged 文件事实与磁盘不符 → REFRESH_STALE。
 * 环境硬约束:小体量(每用例 2 个文件),不构造大体量目录。
 */

interface DbRig {
  dataDir: string;
}

const rigs: DbRig[] = [];
const nasFixtures: NasRootFixture[] = [];

function migrationSql(name: string): string {
  const migrationPath = path.join(process.cwd(), 'src/database/migrations', name, 'up.sql');
  if (!fs.existsSync(migrationPath)) {
    throw new Error(`未找到迁移文件 ${migrationPath} —— 本测试须以 apps/server 为工作目录运行`);
  }
  return fs.readFileSync(migrationPath, 'utf8');
}

function bootstrapRig(extraEnv: Record<string, string>): void {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hmp-nas-repl-'));
  const dbFilename = `${randomUUID()}.hmp.db`;
  setEnvOverride(loadEnv({ NODE_ENV: 'test', DATA_DIR: dataDir, DB_FILENAME: dbFilename, ...extraEnv }));
  Database.close();
  Database.db.exec(
    'CREATE TABLE IF NOT EXISTS _migrations (name TEXT PRIMARY KEY NOT NULL, applied_at TEXT NOT NULL)',
  );
  for (const name of ['0001_init', '0002_profile_policy', '0003_media_catalog']) {
    Database.db.transaction(() => {
      Database.db.exec(migrationSql(name));
      Database.db
        .prepare('INSERT INTO _migrations (name, applied_at) VALUES (?, ?)')
        .run(name, new Date().toISOString());
    })();
  }
  rigs.push({ dataDir });
}

function cleanupAll(): void {
  while (rigs.length > 0) {
    const rig = rigs.pop();
    if (rig === undefined) {
      break;
    }
    Database.close();
    setEnvOverride(null);
    fs.rmSync(rig.dataDir, { recursive: true, force: true });
  }
  while (nasFixtures.length > 0) {
    nasFixtures.pop()?.cleanup();
  }
}

afterEach(cleanupAll);

/* ------------------------------------------------------------------ */
/* 场景构造:NAS 根 + 基线发布(2 文件)                                  */
/* ------------------------------------------------------------------ */

interface HouseholdScope {
  householdId: string;
  accountId: string;
  sessionId: string;
}

interface NasScene {
  fixture: NasRootFixture;
  household: HouseholdScope;
  sourceId: string;
  executor: RefreshExecutorService;
  mediaIdByTitle: Map<string, string>;
  /** 基线发布时磁盘事实(size/mtimeNs 十进制文本),按相对路径 */
  baselineFacts: Map<string, { sizeText: string; mtimeNsText: string }>;
}

function seedHousehold(): HouseholdScope {
  const db = Database.db;
  const ids: HouseholdScope = { householdId: randomUUID(), accountId: randomUUID(), sessionId: randomUUID() };
  const now = new Date().toISOString();
  db.prepare('INSERT INTO household (id, name, default_language, timezone, created_at) VALUES (?, ?, ?, ?, ?)').run(
    ids.householdId,
    'NAS 替换测试家庭',
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

function seedNasSource(householdId: string, rootKey: string): string {
  const sourceId = randomUUID();
  const now = new Date().toISOString();
  Database.db
    .prepare(
      "INSERT INTO media_source (id, household_id, kind, name, remote_url, root_key, relative_directory, private_access_approved, epg_source_id, enabled, version, last_success_at, last_job_id, created_at, updated_at) VALUES (?, ?, 'nas', 'NAS 来源', NULL, ?, '', 1, NULL, 1, 1, NULL, NULL, ?, ?)",
    )
    .run(sourceId, householdId, rootKey, now, now);
  return sourceId;
}

function seedProfileWithPolicy(
  household: HouseholdScope,
  name: string,
  type: 'adult' | 'child',
  policy: { allowed: string[]; blocked: string[] },
): string {
  const now = new Date().toISOString();
  const profileId = randomUUID();
  Database.db
    .prepare(
      "INSERT INTO profile (id, household_id, account_id, name, avatar, type, is_default, pin_hash, status, failed_pin_count, pin_locked_until, created_at) VALUES (?, ?, ?, ?, NULL, ?, 0, NULL, 'active', 0, NULL, ?)",
    )
    .run(profileId, household.householdId, household.accountId, name, type, now);
  Database.db
    .prepare(
      "INSERT INTO profile_policy (household_id, profile_id, max_content_level, allow_unrated, allowed_media_ids, blocked_media_ids, allowed_channel_ids, version, updated_at) VALUES (?, ?, ?, ?, ?, ?, '[]', 1, ?)",
    )
    .run(
      household.householdId,
      profileId,
      type === 'adult' ? 18 : 12,
      type === 'adult' ? 1 : 0,
      JSON.stringify(policy.allowed),
      JSON.stringify(policy.blocked),
      now,
    );
  return profileId;
}

function policyRow(householdId: string, profileId: string): Record<string, unknown> {
  const row = Database.db
    .prepare('SELECT * FROM profile_policy WHERE household_id = ? AND profile_id = ?')
    .get(householdId, profileId) as Record<string, unknown> | undefined;
  expect(row, '策略行应存在').toBeDefined();
  return row as Record<string, unknown>;
}

function mediaRow(householdId: string, mediaId: string): Record<string, unknown> {
  const row = Database.db
    .prepare('SELECT * FROM media_item WHERE household_id = ? AND id = ?')
    .get(householdId, mediaId) as Record<string, unknown> | undefined;
  expect(row, 'media_item 行应存在').toBeDefined();
  return row as Record<string, unknown>;
}

function entryRowByPath(householdId: string, sourceId: string, relativePath: string): Record<string, unknown> {
  const digest = createHash('sha256').update(`path\u0000${relativePath}`, 'utf8').digest('hex');
  const row = Database.db
    .prepare("SELECT * FROM source_entry WHERE household_id = ? AND source_id = ? AND identity_kind = 'path' AND identity_digest = ?")
    .get(householdId, sourceId, digest) as Record<string, unknown> | undefined;
  expect(row, `source_entry(${relativePath}) 应存在`).toBeDefined();
  return row as Record<string, unknown>;
}

function diskFacts(fixture: NasRootFixture, relativePath: string): { sizeText: string; mtimeNsText: string } {
  const stat = fs.statSync(path.join(fixture.rootPath, relativePath), { bigint: true });
  return { sizeText: String(stat.size), mtimeNsText: String(stat.mtimeNs) };
}

function refreshAndRun(
  scene: NasScene,
  operationKey: string,
): RefreshJobView {
  const job = scene.executor.requestRefresh({
    householdId: scene.household.householdId,
    accountId: scene.household.accountId,
    sessionId: scene.household.sessionId,
    sourceId: scene.sourceId,
    expectedVersion: 1,
    operationKey,
    ownerPasswordVerified: true,
  });
  return job;
}

/** 建场景:2 个文件(a.mkv/b.mp4)→ 首次刷新发布基线 */
async function setupScene(): Promise<NasScene> {
  const fixture = createNasRootFixture({ rootKey: 'nas-repl' });
  nasFixtures.push(fixture);
  fixture.write('Movies/a.mkv', 'aaaa-content');
  fixture.write('Movies/b.mp4', 'bbbb-content');
  bootstrapRig({ MEDIA_ROOTS: `${fixture.rootKey}=${fixture.rootPath}` });
  const household = seedHousehold();
  const sourceId = seedNasSource(household.householdId, fixture.rootKey);
  const executor = new RefreshExecutorService(new RefreshPublishService());
  const scene: NasScene = {
    fixture,
    household,
    sourceId,
    executor,
    mediaIdByTitle: new Map(),
    baselineFacts: new Map(),
  };
  refreshAndRun(scene, 'op-nas-baseline');
  const baseline = (await executor.runQueuedOnce()) as RefreshJobView;
  expect(baseline.status).toBe('succeeded');
  const media = Database.db.prepare('SELECT id, title FROM media_item WHERE household_id = ? ORDER BY title').all(
    household.householdId,
  ) as Array<{ id: string; title: string }>;
  expect(media.map((row) => row.title).sort()).toEqual(['a', 'b']);
  for (const row of media) {
    scene.mediaIdByTitle.set(row.title, row.id);
  }
  scene.baselineFacts.set('Movies/a.mkv', diskFacts(fixture, 'Movies/a.mkv'));
  scene.baselineFacts.set('Movies/b.mp4', diskFacts(fixture, 'Movies/b.mp4'));
  return scene;
}

function domainErrorOf(run: () => unknown): DomainError {
  let caught: unknown;
  try {
    run();
  } catch (error) {
    caught = error;
  }
  expect(caught, '期望抛出 DomainError').toBeInstanceOf(DomainError);
  return caught as DomainError;
}

/* ------------------------------------------------------------------ */
/* T027 规则断言                                                        */
/* ------------------------------------------------------------------ */

describe('NAS 同路径替换清理(FR-022/SC-009)', () => {
  it('size/mtime 变化:身份保留、content_level=null、两 Profile allowed 移除/blocked 保留、每档案 version 只 +1', async () => {
    const scene = await setupScene();
    const { household, executor, mediaIdByTitle } = scene;
    const mediaA = mediaIdByTitle.get('a') as string;
    const mediaB = mediaIdByTitle.get('b') as string;
    // 人工分级 + 两档案名单(A 允许,B 禁止)
    Database.db.prepare('UPDATE media_item SET content_level = 6 WHERE id = ?').run(mediaA);
    Database.db.prepare('UPDATE media_item SET content_level = 12 WHERE id = ?').run(mediaB);
    const profileP = seedProfileWithPolicy(household, '家长', 'adult', { allowed: [mediaA], blocked: [mediaB] });
    const profileC = seedProfileWithPolicy(household, '儿童', 'child', { allowed: [mediaA], blocked: [mediaB] });

    // 两个文件都在同一发布内变化
    scene.fixture.mutateSizeOrMtime('Movies/a.mkv');
    scene.fixture.mutateSizeOrMtime('Movies/b.mp4');
    refreshAndRun(scene, 'op-nas-replace');
    const replaced = (await executor.runQueuedOnce()) as RefreshJobView;
    expect(replaced.status).toBe('succeeded');
    expect(replaced.counts).toEqual({ added: 0, updated: 2, missing: 0 });

    // 媒体身份保留、分级清空、版本推进
    const rowA = mediaRow(household.householdId, mediaA);
    const rowB = mediaRow(household.householdId, mediaB);
    expect(rowA.id).toBe(mediaA);
    expect(rowB.id).toBe(mediaB);
    expect(rowA.content_level).toBeNull();
    expect(rowB.content_level).toBeNull();
    expect(rowA.version).toBe(2);
    expect(rowB.version).toBe(2);

    // 名单清理:allowed 移除,blocked 保留;每个档案 version 只加一次(1→2)
    const policyP = policyRow(household.householdId, profileP);
    const policyC = policyRow(household.householdId, profileC);
    expect(JSON.parse(String(policyP.allowed_media_ids))).toEqual([]);
    expect(JSON.parse(String(policyP.blocked_media_ids))).toEqual([mediaB]);
    expect(policyP.version).toBe(2);
    expect(JSON.parse(String(policyC.allowed_media_ids))).toEqual([]);
    expect(JSON.parse(String(policyC.blocked_media_ids))).toEqual([mediaB]);
    expect(policyC.version).toBe(2);

    // source_entry 事实更新为新磁盘值,条目仍 present
    const factsA = diskFacts(scene.fixture, 'Movies/a.mkv');
    const entryA = entryRowByPath(household.householdId, scene.sourceId, 'Movies/a.mkv');
    expect(entryA.file_size_text).toBe(factsA.sizeText);
    expect(entryA.file_mtime_ns).toBe(factsA.mtimeNsText);
    expect(entryA.present).toBe(1);
    expect(entryA.media_id).toBe(mediaA);
    // 播放资源仍是同一路径(file 协议,rootKey+相对路径)
    const playbackA = Database.db.prepare('SELECT * FROM playback_source WHERE household_id = ? AND media_item_id = ?').get(
      household.householdId,
      mediaA,
    ) as Record<string, unknown>;
    expect(playbackA.protocol).toBe('file');
    expect(playbackA.location).toBe(`${scene.fixture.rootKey}/Movies/a.mkv`);
  });

  it('同 size 同 mtime 未变化:分级/名单/策略 version 全部保留', async () => {
    const scene = await setupScene();
    const { household, executor, mediaIdByTitle } = scene;
    const mediaA = mediaIdByTitle.get('a') as string;
    const mediaB = mediaIdByTitle.get('b') as string;
    Database.db.prepare('UPDATE media_item SET content_level = 6 WHERE id = ?').run(mediaA);
    const profileP = seedProfileWithPolicy(household, '家长', 'adult', { allowed: [mediaA], blocked: [mediaB] });

    // 文件未做任何变更,直接再刷新
    refreshAndRun(scene, 'op-nas-unchanged');
    const unchanged = (await executor.runQueuedOnce()) as RefreshJobView;
    expect(unchanged.status).toBe('succeeded');
    expect(unchanged.counts).toEqual({ added: 0, updated: 2, missing: 0 });

    const rowA = mediaRow(household.householdId, mediaA);
    expect(rowA.content_level).toBe(6);
    const policy = policyRow(household.householdId, profileP);
    expect(JSON.parse(String(policy.allowed_media_ids))).toEqual([mediaA]);
    expect(JSON.parse(String(policy.blocked_media_ids))).toEqual([mediaB]);
    expect(policy.version).toBe(1);
    // 条目事实与基线一致
    const entryA = entryRowByPath(household.householdId, scene.sourceId, 'Movies/a.mkv');
    expect(entryA.file_size_text).toBe(scene.baselineFacts.get('Movies/a.mkv')?.sizeText);
    expect(entryA.file_mtime_ns).toBe(scene.baselineFacts.get('Movies/a.mkv')?.mtimeNsText);
  });

  it('损坏策略 JSON:发布整体失败无部分成功(failed=POLICY_UNAVAILABLE,零变化)', async () => {
    const scene = await setupScene();
    const { household, executor, mediaIdByTitle } = scene;
    const mediaA = mediaIdByTitle.get('a') as string;
    const mediaB = mediaIdByTitle.get('b') as string;
    Database.db.prepare('UPDATE media_item SET content_level = 6 WHERE id = ?').run(mediaA);
    Database.db.prepare('UPDATE media_item SET content_level = 12 WHERE id = ?').run(mediaB);
    const profileP = seedProfileWithPolicy(household, '家长', 'adult', { allowed: [mediaA], blocked: [mediaB] });
    const profileC = seedProfileWithPolicy(household, '儿童', 'child', { allowed: [mediaA], blocked: [mediaB] });

    // 注入应用层「损坏」:JSON 数组合法(DB CHECK 放行)但元素非字符串(parseStoredList 拒绝)
    Database.db.prepare('UPDATE profile_policy SET allowed_media_ids = ? WHERE household_id = ? AND profile_id = ?').run(
      '[123]',
      household.householdId,
      profileP,
    );

    const revisionBefore = (
      Database.db.prepare('SELECT revision FROM catalog_state WHERE household_id = ?').get(household.householdId) as {
        revision: number;
      }
    ).revision;
    const successBefore = (
      Database.db.prepare('SELECT last_success_at FROM media_source WHERE id = ?').get(scene.sourceId) as {
        last_success_at: string | null;
      }
    ).last_success_at;

    scene.fixture.mutateSizeOrMtime('Movies/a.mkv');
    refreshAndRun(scene, 'op-nas-corrupt');
    const failed = (await executor.runQueuedOnce()) as RefreshJobView;
    expect(failed.status).toBe('failed');
    expect(failed.errorCode).toBe('POLICY_UNAVAILABLE');

    // 无部分成功:分级/名单/版本/事实/修订全部保持
    expect(mediaRow(household.householdId, mediaA).content_level).toBe(6);
    expect(mediaRow(household.householdId, mediaB).content_level).toBe(12);
    expect(policyRow(household.householdId, profileP).version).toBe(1);
    expect(JSON.parse(String(policyRow(household.householdId, profileP).blocked_media_ids))).toEqual([mediaB]);
    expect(policyRow(household.householdId, profileC).version).toBe(1);
    const entryA = entryRowByPath(household.householdId, scene.sourceId, 'Movies/a.mkv');
    expect(entryA.file_size_text).toBe(scene.baselineFacts.get('Movies/a.mkv')?.sizeText);
    expect(entryA.file_mtime_ns).toBe(scene.baselineFacts.get('Movies/a.mkv')?.mtimeNsText);
    expect(
      (Database.db.prepare('SELECT revision FROM catalog_state WHERE household_id = ?').get(household.householdId) as { revision: number })
        .revision,
    ).toBe(revisionBefore);
    expect(
      (Database.db.prepare('SELECT last_success_at FROM media_source WHERE id = ?').get(scene.sourceId) as { last_success_at: string | null })
        .last_success_at,
    ).toBe(successBefore);
    expect(mediaRow(household.householdId, mediaA).id).toBe(mediaA);
  });

  it('确认时 staged 文件事实与磁盘不符 → 409 REFRESH_STALE 并标 stale', async () => {
    const scene = await setupScene();
    const { household, executor } = scene;
    // 移除 b → 快照只剩 a(missing 1/2 ≥25%)→ awaiting_confirmation
    scene.fixture.remove('Movies/b.mp4');
    refreshAndRun(scene, 'op-nas-await');
    const awaiting = (await executor.runQueuedOnce()) as RefreshJobView;
    expect(awaiting.status).toBe('awaiting_confirmation');
    expect(awaiting.confirmationReason).toBe('deletion_ratio_exceeded');

    // 确认前文件事实变化 → REFRESH_STALE
    scene.fixture.mutateSizeOrMtime('Movies/a.mkv');
    const error = domainErrorOf(() =>
      executor.confirmRefresh({
        householdId: household.householdId,
        refreshId: awaiting.id,
        expectedVersion: awaiting.version,
      }),
    );
    expect(error.status).toBe(409);
    expect(error.code).toBe('REFRESH_STALE');
    const row = Database.db.prepare('SELECT status FROM source_refresh WHERE id = ?').get(awaiting.id) as { status: string };
    expect(row.status).toBe('stale');
  });
});
