import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { Database } from '@platform/database/database';
import { setEnvOverride } from '@platform/config/env';
import { loadEnv } from '@platform/config/env.schema';
import {
  RefreshExecutorService,
  type RefreshJobView,
} from '@contexts/sources/application/refresh-executor.service';
import { RefreshPublishService } from '@contexts/sources/application/refresh-publish.service';
import { bindSourcesStore } from '@contexts/sources/application/sources-store.port';
import { drizzleSourcesStore } from '@contexts/sources/infrastructure/sources-store.drizzle';
import {
  buildM3u,
  createControlledMediaServer,
  createNasRootFixture,
  type ControlledMediaServer,
  type NasRootFixture,
} from '../../helpers';

/**
 * IPTV 发布 M1 合并单元测试(014 T013;data-model §4 M1 / contracts/internal-ports.md §2/§4):
 * 全链路(受控 M3U → 真实 refresh 链路:解析→暂存→发布事务)断言:
 * - M1 缺行新签:有 logo 条目发布后 channel_logo 出现 active(iptv) 行(source_kind/source_id/
 *   upstream_url/revision=1/revoked_at=NULL),media_item.poster_ref = 新引用(32 hex),
 *   source_entry.logo_url 落私有证据列;无 logo 条目三处全空(NAS 恒无 logo 同理);
 * - M1 换 url:同行覆盖,新 ref + revision+1,poster_ref 同步换新,revoked_at 保持 NULL;
 * - M1 同 url 重发布:无操作不换 ref(ref/revision 稳定,data-model §6 浏览器缓存稳定性);
 * - FR-010:含坏 logo(tvg-logo 超长/非法 scheme)条目整批导入成功,解析层归一化为 null,
 *   该条目无 logo 行/无 poster/无证据列值,绝不阻塞导入;
 * - 墓碑 GC:发布事务顺带集合 DELETE revoked_at ≤ now−7d 行,窗口内墓碑与 active 行不动
 *   (CHANNEL_LOGO_TOMBSTONE_WINDOW_MS,data-model §4)。
 * 暂存透传断言以端到端产物承载:source_entry.logo_url 只能经 staging payload 透传
 * (parse→stageEntries 展开→发布事务回读)写入,持久化即透传成立的证据。
 */

/**
 * 008-T009(ADR-0015 D1):测试 rig 绑定仓储 seam(惰性 Database.db 解析,
 * bootstrapRig 每测试 close/重开单例仍正确)。
 */
bindSourcesStore(drizzleSourcesStore());

interface DbRig {
  dataDir: string;
}

const rigs: DbRig[] = [];
const nasFixtures: NasRootFixture[] = [];

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

/** 全迁移 rig(0001~0009):Logo 数据链路依赖 0009 的 logo_url/icon_url/channel_logo */
const ALL_MIGRATIONS = fs
  .readdirSync(path.join(process.cwd(), 'src/platform/database/migrations'))
  .filter((name) => /^\d{4}_/.test(name))
  .sort();

function bootstrapRig(extraEnv: Record<string, string> = {}): void {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hmp-publish-logo-'));
  setEnvOverride(
    loadEnv({
      NODE_ENV: 'test',
      DATA_DIR: dataDir,
      DB_FILENAME: `${randomUUID()}.hmp.db`,
      LAN_ALLOWED_TARGETS: '127.0.0.1',
      ...extraEnv,
    }),
  );
  Database.close();
  Database.db.exec('CREATE TABLE IF NOT EXISTS _migrations (name TEXT PRIMARY KEY NOT NULL, applied_at TEXT NOT NULL)');
  for (const name of ALL_MIGRATIONS) {
    Database.db.transaction(() => {
      Database.db.exec(migrationSql(name));
      Database.db.prepare('INSERT INTO _migrations (name, applied_at) VALUES (?, ?)').run(name, new Date().toISOString());
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
  while (nasFixtures.length > 0) {
    nasFixtures.pop()?.cleanup();
  }
}

afterEach(cleanupRigs);

/* ------------------------------------------------------------------ */
/* 造数辅助(照 refresh-executor.spec.ts 内联最小链路模式)               */
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
    'Logo发布测试家庭',
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

function seedSource(householdId: string, kind: 'iptv' | 'nas', options: { remoteUrl?: string; rootKey?: string } = {}): string {
  const sourceId = randomUUID();
  const now = new Date().toISOString();
  Database.db
    .prepare(
      "INSERT INTO media_source (id, household_id, kind, name, remote_url, root_key, relative_directory, private_access_approved, epg_source_id, enabled, version, last_success_at, last_job_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, 1, NULL, 1, 1, NULL, NULL, ?, ?)",
    )
    .run(
      sourceId,
      householdId,
      kind,
      `${kind} 来源`,
      kind === 'nas' ? null : (options.remoteUrl ?? 'http://lan.example/list.m3u'),
      kind === 'nas' ? (options.rootKey ?? 'nas-x') : null,
      kind === 'nas' ? '' : null,
      now,
      now,
    );
  return sourceId;
}

function makeExecutor(): RefreshExecutorService {
  return new RefreshExecutorService(new RefreshPublishService());
}

interface PublishScene {
  household: HouseholdScope;
  sourceId: string;
  server: ControlledMediaServer;
  executor: RefreshExecutorService;
}

async function openIptvScene(
  playlistEntries: Parameters<typeof buildM3u>[0],
  operationKey: string,
): Promise<PublishScene> {
  bootstrapRig();
  const household = seedHousehold();
  const server = await createControlledMediaServer();
  server.setRoute('/list.m3u', { kind: 'm3u', content: buildM3u(playlistEntries) });
  const sourceId = seedSource(household.householdId, 'iptv', { remoteUrl: `${server.baseUrl}/list.m3u` });
  const executor = makeExecutor();
  executor.requestRefresh({
    householdId: household.householdId,
    accountId: household.accountId,
    sessionId: household.sessionId,
    sourceId,
    expectedVersion: 1,
    operationKey,
    ownerPasswordVerified: true,
  });
  const job = await executor.runQueuedOnce();
  expect(job?.status, '场景前置:首次发布应成功').toBe('succeeded');
  return { household, sourceId, server, executor };
}

/** 再次刷新并发布(给定播放列表内容) */
async function republish(scene: PublishScene, playlistEntries: Parameters<typeof buildM3u>[0], operationKey: string): Promise<RefreshJobView> {
  scene.server.setRoute('/list.m3u', { kind: 'm3u', content: buildM3u(playlistEntries) });
  const created = scene.executor.requestRefresh({
    householdId: scene.household.householdId,
    accountId: scene.household.accountId,
    sessionId: scene.household.sessionId,
    sourceId: scene.sourceId,
    expectedVersion: 1,
    operationKey,
    ownerPasswordVerified: true,
  });
  const job = (await scene.executor.runQueuedOnce()) as RefreshJobView;
  expect(job.id).toBe(created.id);
  return job;
}

/** 按标题取频道媒体行(media_item 由发布事务按解析标题创建) */
function mediaByTitle(householdId: string, title: string): Record<string, unknown> {
  const row = Database.db
    .prepare('SELECT * FROM media_item WHERE household_id = ? AND title = ?')
    .get(householdId, title) as Record<string, unknown> | undefined;
  expect(row, `媒体行应存在:${title}`).toBeDefined();
  return row as Record<string, unknown>;
}

/** 按媒体 id 取 channel_logo 行(无行 undefined) */
function logoRowOf(householdId: string, mediaId: string): Record<string, unknown> | undefined {
  return Database.db
    .prepare('SELECT * FROM channel_logo WHERE household_id = ? AND media_id = ?')
    .get(householdId, mediaId) as Record<string, unknown> | undefined;
}

/** 按 upstream_channel_id(tvg-id)取本来源条目行 */
function entryByTvgId(householdId: string, sourceId: string, tvgId: string): Record<string, unknown> {
  const row = Database.db
    .prepare('SELECT * FROM source_entry WHERE household_id = ? AND source_id = ? AND upstream_channel_id = ?')
    .get(householdId, sourceId, tvgId) as Record<string, unknown> | undefined;
  expect(row, `source_entry 行应存在:tvg-id=${tvgId}`).toBeDefined();
  return row as Record<string, unknown>;
}

/** 直接植入墓碑行(测试事实准备;upstream_url NULL 满足墓碑 CHECK) */
function seedTombstone(householdId: string, mediaId: string, sourceId: string, revokedAtIso: string): void {
  Database.db
    .prepare(
      "INSERT INTO channel_logo (household_id, media_id, ref, upstream_url, source_kind, source_id, revision, revoked_at, created_at, updated_at) VALUES (?, ?, ?, NULL, 'iptv', ?, 1, ?, ?, ?)",
    )
    .run(householdId, mediaId, randomUUID().replaceAll('-', ''), sourceId, revokedAtIso, revokedAtIso, revokedAtIso);
}

/* ------------------------------------------------------------------ */
/* M1 合并矩阵                                                          */
/* ------------------------------------------------------------------ */

describe('IPTV 发布 M1 合并(014 T013;data-model §4 M1;contracts/internal-ports §2/§4)', () => {
  it('有 logo 条目发布后:channel_logo 出现 active(iptv) 行,poster_ref=新引用,logo_url 落证据列;无 logo 条目三处全空', async () => {
    const scene = await openIptvScene(
      [
        { name: '频道A', url: 'http://stream.example/a', tvgId: 'logo-a', tvgLogo: 'http://cdn.example/a.png' },
        { name: '频道B', url: 'http://stream.example/b', tvgId: 'logo-b' },
      ],
      'op-m1-first',
    );
    try {
      const { household, sourceId } = scene;
      const mediaA = mediaByTitle(household.householdId, '频道A');
      const mediaB = mediaByTitle(household.householdId, '频道B');

      const logoA = logoRowOf(household.householdId, String(mediaA.id));
      expect(logoA, '频道A 应出现 channel_logo 行').toBeDefined();
      expect(logoA).toMatchObject({
        source_kind: 'iptv',
        source_id: sourceId,
        upstream_url: 'http://cdn.example/a.png',
        revision: 1,
        revoked_at: null,
      });
      expect(String(logoA?.ref)).toMatch(/^[0-9a-f]{32}$/);

      // media_item.poster_ref = 新引用;source_entry.logo_url = 私有证据(经 staging 载荷透传)
      expect(mediaA.poster_ref).toBe(logoA?.ref);
      const entryA = entryByTvgId(household.householdId, sourceId, 'logo-a');
      expect(entryA.logo_url).toBe('http://cdn.example/a.png');

      // 无 logo 条目:无注册表行、无 poster、无证据值
      expect(logoRowOf(household.householdId, String(mediaB.id))).toBeUndefined();
      expect(mediaB.poster_ref).toBeNull();
      expect(entryByTvgId(household.householdId, sourceId, 'logo-b').logo_url).toBeNull();
      // 每频道至多一行:全家庭只有频道A 一行
      const total = Database.db.prepare('SELECT COUNT(*) AS n FROM channel_logo WHERE household_id = ?').get(household.householdId) as { n: number };
      expect(total.n).toBe(1);
    } finally {
      await scene.server.close();
    }
  });

  it('url 变化:同行覆盖换 ref 且 revision+1,poster_ref 同步新引用,revoked_at 保持 NULL', async () => {
    const scene = await openIptvScene(
      [{ name: '频道A', url: 'http://stream.example/a', tvgId: 'logo-a', tvgLogo: 'http://cdn.example/a.png' }],
      'op-m1-change-1',
    );
    try {
      const { household } = scene;
      const firstRef = String(mediaByTitle(household.householdId, '频道A').poster_ref);

      const job = await republish(
        scene,
        [{ name: '频道A', url: 'http://stream.example/a', tvgId: 'logo-a', tvgLogo: 'http://cdn.example/a-v2.png' }],
        'op-m1-change-2',
      );
      expect(job.status).toBe('succeeded');

      const mediaA = mediaByTitle(household.householdId, '频道A');
      const logoA = logoRowOf(household.householdId, String(mediaA.id));
      expect(logoA).toMatchObject({
        upstream_url: 'http://cdn.example/a-v2.png',
        revision: 2,
        revoked_at: null,
        source_kind: 'iptv',
      });
      expect(String(logoA?.ref)).not.toBe(firstRef);
      expect(mediaA.poster_ref).toBe(logoA?.ref);
      expect(mediaByTitle(household.householdId, '频道A').poster_ref).toBe(String(logoA?.ref));
    } finally {
      await scene.server.close();
    }
  });

  it('同 url 重发布:无操作不换 ref(ref/revision 稳定,poster_ref 不闪变)', async () => {
    const scene = await openIptvScene(
      [{ name: '频道A', url: 'http://stream.example/a', tvgId: 'logo-a', tvgLogo: 'http://cdn.example/a.png' }],
      'op-m1-same-1',
    );
    try {
      const { household } = scene;
      const firstRef = String(mediaByTitle(household.householdId, '频道A').poster_ref);
      const firstRow = logoRowOf(household.householdId, String(mediaByTitle(household.householdId, '频道A').id));

      const job = await republish(
        scene,
        [{ name: '频道A', url: 'http://stream.example/a', tvgId: 'logo-a', tvgLogo: 'http://cdn.example/a.png' }],
        'op-m1-same-2',
      );
      expect(job.status).toBe('succeeded');

      const logoA = logoRowOf(household.householdId, String(mediaByTitle(household.householdId, '频道A').id));
      expect(logoA).toMatchObject({ ref: firstRef, revision: 1, updated_at: firstRow?.updated_at });
      expect(mediaByTitle(household.householdId, '频道A').poster_ref).toBe(firstRef);
    } finally {
      await scene.server.close();
    }
  });

  it('FR-010:导入含坏 logo(超长/非法 scheme)条目整批成功,坏条目无 logo 三处全空', async () => {
    const overLogo = `https://${'a'.repeat(2048 - 'https://'.length + 1)}`;
    const scene = await openIptvScene(
      [
        { name: '频道A', url: 'http://stream.example/a', tvgId: 'logo-a', tvgLogo: 'http://cdn.example/a.png' },
        { name: '频道C', url: 'http://stream.example/c', tvgId: 'logo-c', tvgLogo: overLogo },
        { name: '频道D', url: 'http://stream.example/d', tvgId: 'logo-d', tvgLogo: 'ftp://cdn.example/d.png' },
      ],
      'op-fr010',
    );
    try {
      const { household, sourceId } = scene;
      const mediaA = mediaByTitle(household.householdId, '频道A');
      const mediaC = mediaByTitle(household.householdId, '频道C');
      const mediaD = mediaByTitle(household.householdId, '频道D');

      // 好条目照常写胜者;坏条目(解析层归 null)整批成功且无 logo
      expect(logoRowOf(household.householdId, String(mediaA.id))).toMatchObject({
        upstream_url: 'http://cdn.example/a.png',
        source_kind: 'iptv',
        revision: 1,
        revoked_at: null,
      });
      for (const media of [mediaC, mediaD]) {
        expect(logoRowOf(household.householdId, String(media.id))).toBeUndefined();
        expect(media.poster_ref).toBeNull();
      }
      expect(entryByTvgId(household.householdId, sourceId, 'logo-c').logo_url).toBeNull();
      expect(entryByTvgId(household.householdId, sourceId, 'logo-d').logo_url).toBeNull();
    } finally {
      await scene.server.close();
    }
  });

  it('发布事务顺带墓碑 GC:revoked_at ≤ now−7d 行删除,窗口内墓碑与 active 行不动', async () => {
    const scene = await openIptvScene(
      [
        { name: '频道A', url: 'http://stream.example/a', tvgId: 'logo-a', tvgLogo: 'http://cdn.example/a.png' },
        { name: '频道B', url: 'http://stream.example/b', tvgId: 'logo-b' },
        { name: '频道E', url: 'http://stream.example/e', tvgId: 'logo-e' },
      ],
      'op-gc-1',
    );
    try {
      const { household, sourceId } = scene;
      const mediaA = mediaByTitle(household.householdId, '频道A');
      const mediaB = mediaByTitle(household.householdId, '频道B');
      const mediaE = mediaByTitle(household.householdId, '频道E');
      const activeRefBefore = String(logoRowOf(household.householdId, String(mediaA.id))?.ref);

      // 植入墓碑:B 超窗口(now−8d,应删);E 窗口内(now−6d,应留)
      const nowMs = Date.now();
      seedTombstone(household.householdId, String(mediaB.id), sourceId, new Date(nowMs - 8 * 24 * 3_600_000).toISOString());
      seedTombstone(household.householdId, String(mediaE.id), sourceId, new Date(nowMs - 6 * 24 * 3_600_000).toISOString());

      const job = await republish(
        scene,
        [
          { name: '频道A', url: 'http://stream.example/a', tvgId: 'logo-a', tvgLogo: 'http://cdn.example/a.png' },
          { name: '频道B', url: 'http://stream.example/b', tvgId: 'logo-b' },
          { name: '频道E', url: 'http://stream.example/e', tvgId: 'logo-e' },
        ],
        'op-gc-2',
      );
      expect(job.status).toBe('succeeded');

      // 超窗口墓碑被集合 DELETE;窗口内墓碑保留;active(iptv) 行不受影响
      expect(logoRowOf(household.householdId, String(mediaB.id))).toBeUndefined();
      expect(logoRowOf(household.householdId, String(mediaE.id))).toMatchObject({ revoked_at: expect.any(String) });
      expect(logoRowOf(household.householdId, String(mediaA.id))).toMatchObject({ ref: activeRefBefore, revision: 1, revoked_at: null });
    } finally {
      await scene.server.close();
    }
  });

  it('NAS 发布恒无 logo:全部条目发布成功且 channel_logo 零行、poster_ref 全 NULL', async () => {
    const fixture = createNasRootFixture();
    nasFixtures.push(fixture);
    fixture.write('Movies/clip.mkv', 'clip-content');
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
      operationKey: 'op-nas-logo',
      ownerPasswordVerified: true,
    });
    const job = (await executor.runQueuedOnce()) as RefreshJobView;
    expect(job.status).toBe('succeeded');

    const total = Database.db.prepare('SELECT COUNT(*) AS n FROM channel_logo WHERE household_id = ?').get(household.householdId) as { n: number };
    expect(total.n).toBe(0);
    const posters = Database.db.prepare('SELECT poster_ref FROM media_item WHERE household_id = ?').all(household.householdId) as Array<{
      poster_ref: string | null;
    }>;
    expect(posters.length).toBeGreaterThan(0);
    expect(posters.every((row) => row.poster_ref === null)).toBe(true);
  });
});
