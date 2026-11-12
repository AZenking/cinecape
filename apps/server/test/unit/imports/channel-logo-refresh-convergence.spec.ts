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
import { bindLiveTvStore } from '@contexts/live-tv/application/live-tv-store.port';
import { drizzleLiveTvStore } from '@contexts/live-tv/infrastructure/live-tv-store.drizzle';
import { bindPolicyStore } from '@contexts/policy/application/policy-store.port';
import { drizzlePolicyStore } from '@contexts/policy/infrastructure/policy-store.drizzle';
import { buildM3u, createControlledMediaServer, type ControlledMediaServer } from '../../helpers';

/**
 * 刷新收敛与导入对等性(014 T031;SC-004/SC-005,quickstart §4 独立测试口径):
 *
 * - SC-004 刷新收敛:同一频道连续多版源(新增 → 变更 → 移除 logo/IPTV;icon 同路径
 *   EPG)逐版刷新,每版刷新后 Logo 状态立即生效且与该版源一致 —— IPTV:无 → 有 → 换址
 *   → 无(注册表 active(iptv) → 换 ref revision+1 → 墓碑/poster NULL);EPG:icon_url
 *   证据列随窗口替换逐版更新,绑定频道的胜者/poster 随 M3/M4 收敛;
 * - SC-005 导入对等性:含坏 logo/icon 地址的源 vs 等价不含的对照源,导入成功率与计数
 *   完全一致(FR-010:坏 Logo 数据绝不阻塞导入、无可感知劣化)—— IPTV(坏 tvg-logo:
 *   超长/非法 scheme/空值)与 EPG(坏 icon:超长/非法 scheme/空值)双侧对照。
 *
 * 全链路(受控 M3U/XMLTV → 真实 refresh 链路:解析→暂存→发布事务),发布事务内
 * 受限合并复用 live-projection 关联核心(与 T030 同一装配)。
 */

/* 发布事务内 M2/M3/M4 合并经 live-tv 关联核心与 policy 可用性集合查询,
 * 三个仓储 seam 都须绑定(生产由各模块 useFactory 装配)。 */
bindSourcesStore(drizzleSourcesStore());
bindLiveTvStore(drizzleLiveTvStore());
bindPolicyStore(drizzlePolicyStore());

interface DbRig {
  dataDir: string;
}

const rigs: DbRig[] = [];

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

function bootstrapRig(): void {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hmp-logo-converge-'));
  setEnvOverride(
    loadEnv({
      NODE_ENV: 'test',
      DATA_DIR: dataDir,
      DB_FILENAME: `${randomUUID()}.hmp.db`,
      LAN_ALLOWED_TARGETS: '127.0.0.1',
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
}

afterEach(cleanupRigs);

/* ------------------------------------------------------------------ */
/* 造数辅助                                                             */
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
    'Logo收敛测试家庭',
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
  kind: 'iptv' | 'epg',
  options: { remoteUrl?: string; epgSourceId?: string | null } = {},
): string {
  const sourceId = randomUUID();
  const now = new Date().toISOString();
  Database.db
    .prepare(
      "INSERT INTO media_source (id, household_id, kind, name, remote_url, root_key, relative_directory, private_access_approved, epg_source_id, enabled, version, last_success_at, last_job_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, NULL, NULL, 1, ?, 1, 1, NULL, NULL, ?, ?)",
    )
    .run(sourceId, householdId, kind, `${kind} 来源`, options.remoteUrl ?? '', options.epgSourceId ?? null, now, now);
  return sourceId;
}

function makeExecutor(): RefreshExecutorService {
  return new RefreshExecutorService(new RefreshPublishService());
}

/** XMLTV 时间戳(UTC +0000;节目窗口落在发布窗口内) */
function xmltvStamp(ms: number): string {
  const d = new Date(ms);
  const pad = (value: number): string => String(value).padStart(2, '0');
  return (
    `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}` +
    `${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())} +0000`
  );
}

interface XmltvChannelSpec {
  id: string;
  displayName?: string;
  icon?: string;
}

function buildXmltvWithIcons(channels: readonly XmltvChannelSpec[], programmeChannels: readonly string[] = []): string {
  const hourMs = 3_600_000;
  const base = Date.now() + hourMs;
  const lines: string[] = ['<?xml version="1.0" encoding="UTF-8"?>', '<tv>'];
  for (const channel of channels) {
    const icon = channel.icon === undefined ? '' : channel.icon;
    const name = channel.displayName ?? channel.id;
    lines.push(`  <channel id="${channel.id}"><display-name>${name}</display-name>${icon}</channel>`);
  }
  for (const [index, channelId] of programmeChannels.entries()) {
    const start = base + index * hourMs;
    lines.push(
      `  <programme channel="${channelId}" start="${xmltvStamp(start)}" stop="${xmltvStamp(start + hourMs)}"><title>节目 ${index + 1}</title></programme>`,
    );
  }
  lines.push('</tv>');
  return `${lines.join('\n')}\n`;
}

interface IptvEntrySpec {
  name: string;
  url: string;
  tvgId: string;
  tvgLogo?: string;
}

interface MergeScene {
  household: HouseholdScope;
  server: ControlledMediaServer;
  executor: RefreshExecutorService;
  epgSourceId: string;
  iptvSourceId: string;
}

async function openMergeScene(): Promise<MergeScene> {
  bootstrapRig();
  const household = seedHousehold();
  const server = await createControlledMediaServer();
  const executor = makeExecutor();
  const epgSourceId = seedSource(household.householdId, 'epg', { remoteUrl: `${server.baseUrl}/guide.xml` });
  const iptvSourceId = seedSource(household.householdId, 'iptv', {
    remoteUrl: `${server.baseUrl}/list.m3u`,
    epgSourceId,
  });
  return { household, server, executor, epgSourceId, iptvSourceId };
}

async function publishIptv(scene: MergeScene, entries: readonly IptvEntrySpec[], operationKey: string): Promise<RefreshJobView> {
  scene.server.setRoute('/list.m3u', {
    kind: 'm3u',
    content: buildM3u(
      entries.map((entry) => ({
        name: entry.name,
        url: entry.url,
        tvgId: entry.tvgId,
        ...(entry.tvgLogo === undefined ? {} : { tvgLogo: entry.tvgLogo }),
      })),
    ),
  });
  const created = scene.executor.requestRefresh({
    householdId: scene.household.householdId,
    accountId: scene.household.accountId,
    sessionId: scene.household.sessionId,
    sourceId: scene.iptvSourceId,
    expectedVersion: 1,
    operationKey,
    ownerPasswordVerified: true,
  });
  const job = (await scene.executor.runQueuedOnce()) as RefreshJobView;
  expect(job.id).toBe(created.id);
  expect(job.status, `IPTV 发布应成功(${operationKey})`).toBe('succeeded');
  return job;
}

async function publishEpg(scene: MergeScene, channels: readonly XmltvChannelSpec[], operationKey: string): Promise<RefreshJobView> {
  scene.server.setRoute('/guide.xml', {
    kind: 'xmltv',
    content: buildXmltvWithIcons(channels, channels.map((channel) => channel.id)),
  });
  const created = scene.executor.requestRefresh({
    householdId: scene.household.householdId,
    accountId: scene.household.accountId,
    sessionId: scene.household.sessionId,
    sourceId: scene.epgSourceId,
    expectedVersion: 1,
    operationKey,
    ownerPasswordVerified: true,
  });
  const job = (await scene.executor.runQueuedOnce()) as RefreshJobView;
  expect(job.id).toBe(created.id);
  expect(job.status, `EPG 发布应成功(${operationKey})`).toBe('succeeded');
  return job;
}

function mediaByTitle(householdId: string, title: string): Record<string, unknown> {
  const row = Database.db
    .prepare('SELECT * FROM media_item WHERE household_id = ? AND title = ?')
    .get(householdId, title) as Record<string, unknown> | undefined;
  expect(row, `媒体行应存在:${title}`).toBeDefined();
  return row as Record<string, unknown>;
}

function logoRowOf(householdId: string, mediaId: string): Record<string, unknown> | undefined {
  return Database.db
    .prepare('SELECT * FROM channel_logo WHERE household_id = ? AND media_id = ?')
    .get(householdId, mediaId) as Record<string, unknown> | undefined;
}

function epgChannelRowOf(householdId: string, sourceId: string, xmltvChannelId: string): Record<string, unknown> {
  const row = Database.db
    .prepare('SELECT * FROM epg_channel WHERE household_id = ? AND source_id = ? AND xmltv_channel_id = ?')
    .get(householdId, sourceId, xmltvChannelId) as Record<string, unknown> | undefined;
  expect(row, `epg_channel 行应存在:${xmltvChannelId}`).toBeDefined();
  return row as Record<string, unknown>;
}

/* ------------------------------------------------------------------ */
/* SC-004 刷新收敛:IPTV 侧                                              */
/* ------------------------------------------------------------------ */

describe('SC-004 刷新收敛:IPTV logo 新增/变更/移除均在刷新后生效(014 T031)', () => {
  it('同一频道连续四版源(无→有→换址→无),每版刷新后 Logo 状态与该版源一致', async () => {
    const scene = await openMergeScene();
    try {
      const entry = (tvgLogo?: string): IptvEntrySpec => ({
        name: '频道A',
        url: 'http://stream.example/a',
        tvgId: 'ch-a',
        ...(tvgLogo === undefined ? {} : { tvgLogo }),
      });
      const householdId = scene.household.householdId;

      // v1:无 logo → 无注册表行、无 poster
      await publishIptv(scene, [entry()], 'op-sc4-1');
      const mediaA = mediaByTitle(householdId, '频道A');
      const mediaId = String(mediaA.id);
      expect(logoRowOf(householdId, mediaId)).toBeUndefined();
      expect(mediaByTitle(householdId, '频道A').poster_ref).toBeNull();

      // v2:新增 logo → active(iptv) + poster
      await publishIptv(scene, [entry('http://cdn.example/a.png')], 'op-sc4-2');
      const added = logoRowOf(householdId, mediaId);
      expect(added).toMatchObject({
        source_kind: 'iptv',
        upstream_url: 'http://cdn.example/a.png',
        revision: 1,
        revoked_at: null,
      });
      expect(mediaByTitle(householdId, '频道A').poster_ref).toBe(added?.ref);
      const addedRef = String(added?.ref);

      // v3:变更 logo 地址 → 换 ref、revision+1、poster 跟随
      await publishIptv(scene, [entry('http://cdn.example/a-v2.png')], 'op-sc4-3');
      const changed = logoRowOf(householdId, mediaId);
      expect(changed).toMatchObject({
        upstream_url: 'http://cdn.example/a-v2.png',
        revision: 2,
        revoked_at: null,
      });
      expect(String(changed?.ref)).not.toBe(addedRef);
      expect(mediaByTitle(householdId, '频道A').poster_ref).toBe(changed?.ref);
      const changedRef = String(changed?.ref);

      // v4:移除 logo → 墓碑(旧 ref 不复用)、poster NULL
      await publishIptv(scene, [entry()], 'op-sc4-4');
      const removed = logoRowOf(householdId, mediaId);
      expect(removed).toMatchObject({ ref: changedRef, upstream_url: null, revoked_at: expect.any(String) });
      expect(mediaByTitle(householdId, '频道A').poster_ref).toBeNull();
    } finally {
      await scene.server.close();
    }
  });
});

/* ------------------------------------------------------------------ */
/* SC-004 刷新收敛:EPG 侧 icon 变化路径                                 */
/* ------------------------------------------------------------------ */

describe('SC-004 刷新收敛:EPG icon 新增/变更/移除均在刷新后生效(014 T031)', () => {
  it('同一频道连续四版窗口(无→有→换址→无 icon),icon_url 证据与胜者/poster 逐版收敛', async () => {
    const scene = await openMergeScene();
    try {
      await publishIptv(scene, [{ name: '频道A', url: 'http://stream.example/a', tvgId: 'ch-a' }], 'op-sc4e-iptv');
      const householdId = scene.household.householdId;
      const mediaId = String(mediaByTitle(householdId, '频道A').id);
      const channel = (icon?: string): XmltvChannelSpec[] => [
        { id: 'ch-a', displayName: '频道A', ...(icon === undefined ? {} : { icon }) },
      ];

      // v1:无 icon → 证据列 NULL、无胜者
      await publishEpg(scene, channel(), 'op-sc4e-1');
      expect(epgChannelRowOf(householdId, scene.epgSourceId, 'ch-a').icon_url).toBeNull();
      expect(logoRowOf(householdId, mediaId)).toBeUndefined();

      // v2:新增 icon → 证据列落值 + active(epg) + poster
      await publishEpg(scene, channel('<icon src="http://epg.example/a.png"/>'), 'op-sc4e-2');
      expect(epgChannelRowOf(householdId, scene.epgSourceId, 'ch-a').icon_url).toBe('http://epg.example/a.png');
      const added = logoRowOf(householdId, mediaId);
      expect(added).toMatchObject({
        source_kind: 'epg',
        upstream_url: 'http://epg.example/a.png',
        revision: 1,
        revoked_at: null,
      });
      expect(mediaByTitle(householdId, '频道A').poster_ref).toBe(added?.ref);
      const addedRef = String(added?.ref);

      // v3:变更 icon 地址 → 证据列更新 + 同行覆盖(新 ref、revision+1)
      await publishEpg(scene, channel('<icon src="http://epg.example/a-v2.png"/>'), 'op-sc4e-3');
      expect(epgChannelRowOf(householdId, scene.epgSourceId, 'ch-a').icon_url).toBe('http://epg.example/a-v2.png');
      const changed = logoRowOf(householdId, mediaId);
      expect(changed).toMatchObject({
        upstream_url: 'http://epg.example/a-v2.png',
        revision: 2,
        revoked_at: null,
      });
      expect(String(changed?.ref)).not.toBe(addedRef);
      expect(mediaByTitle(householdId, '频道A').poster_ref).toBe(changed?.ref);
      const changedRef = String(changed?.ref);

      // v4:移除 icon → 证据列清 NULL + active(epg) 撤销转墓碑 + poster NULL
      await publishEpg(scene, channel(), 'op-sc4e-4');
      expect(epgChannelRowOf(householdId, scene.epgSourceId, 'ch-a').icon_url).toBeNull();
      const removed = logoRowOf(householdId, mediaId);
      expect(removed).toMatchObject({ ref: changedRef, upstream_url: null, revoked_at: expect.any(String) });
      expect(mediaByTitle(householdId, '频道A').poster_ref).toBeNull();
    } finally {
      await scene.server.close();
    }
  });
});

/* ------------------------------------------------------------------ */
/* SC-005 导入对等性                                                    */
/* ------------------------------------------------------------------ */

/** 独立对照场景(同一家庭内两个 IPTV 源,条目 URL 不同互不干扰) */
async function runIptvParityScene(
  entries: readonly IptvEntrySpec[],
  operationKey: string,
): Promise<{ job: RefreshJobView; mediaCount: number }> {
  const scene = await openMergeScene();
  try {
    const sourceId = seedSource(scene.household.householdId, 'iptv', { remoteUrl: `${scene.server.baseUrl}/parity.m3u` });
    scene.server.setRoute('/parity.m3u', {
      kind: 'm3u',
      content: buildM3u(
        entries.map((entry) => ({
          name: entry.name,
          url: entry.url,
          tvgId: entry.tvgId,
          ...(entry.tvgLogo === undefined ? {} : { tvgLogo: entry.tvgLogo }),
        })),
      ),
    });
    const created = scene.executor.requestRefresh({
      householdId: scene.household.householdId,
      accountId: scene.household.accountId,
      sessionId: scene.household.sessionId,
      sourceId,
      expectedVersion: 1,
      operationKey,
      ownerPasswordVerified: true,
    });
    const job = (await scene.executor.runQueuedOnce()) as RefreshJobView;
    expect(job.id).toBe(created.id);
    const mediaCount = (
      Database.db.prepare('SELECT COUNT(*) AS n FROM media_item WHERE household_id = ?').get(scene.household.householdId) as { n: number }
    ).n;
    return { job, mediaCount };
  } finally {
    await scene.server.close();
  }
}

describe('SC-005 导入对等性:含坏 logo 源 vs 不含对照(014 T031;FR-010)', () => {
  it('IPTV:坏 tvg-logo(超长/非法 scheme/空值)源与对照源导入成功率与计数完全一致', async () => {
    const overLogo = `https://${'a'.repeat(2048 - 'https://'.length + 1)}`;
    const entriesWithBadLogos: IptvEntrySpec[] = [
      { name: '频道一', url: 'http://stream.example/1', tvgId: 'p-1', tvgLogo: 'http://cdn.example/1.png' },
      { name: '频道二', url: 'http://stream.example/2', tvgId: 'p-2', tvgLogo: overLogo },
      { name: '频道三', url: 'http://stream.example/3', tvgId: 'p-3', tvgLogo: 'ftp://cdn.example/3.png' },
      { name: '频道四', url: 'http://stream.example/4', tvgId: 'p-4', tvgLogo: '' },
      { name: '频道五', url: 'http://stream.example/5', tvgId: 'p-5' },
    ];
    const entriesControl: IptvEntrySpec[] = entriesWithBadLogos.map((entry) => ({
      name: entry.name,
      url: entry.url,
      tvgId: entry.tvgId,
    }));

    const withBad = await runIptvParityScene(entriesWithBadLogos, 'op-sc5-bad');
    const control = await runIptvParityScene(entriesControl, 'op-sc5-ctrl');

    // 成功率一致:双源均 succeeded,added 计数与媒体行数完全一致(无可感知劣化)
    expect(withBad.job.status).toBe('succeeded');
    expect(control.job.status).toBe('succeeded');
    expect(withBad.job.counts.added).toBe(entriesWithBadLogos.length);
    expect(control.job.counts.added).toBe(entriesWithBadLogos.length);
    expect(withBad.mediaCount).toBe(control.mediaCount);
    expect(withBad.job.errorCode).toBeNull();
  });

  it('IPTV 对照细化:坏 logo 条目其余导入产物与对照逐项一致,仅 Logo 三处为空', async () => {
    const scene = await openMergeScene();
    try {
      await publishIptv(
        scene,
        [
          { name: '频道一', url: 'http://stream.example/1', tvgId: 'p-1', tvgLogo: 'ftp://bad.example/1.png' },
          { name: '频道二', url: 'http://stream.example/2', tvgId: 'p-2', tvgLogo: `https://${'a'.repeat(2048)}` },
        ],
        'op-sc5-detail',
      );
      const householdId = scene.household.householdId;
      // 条目/媒体/播放资源照常成立(对等性:与无 logo 条目无差异)
      const entries = Database.db
        .prepare('SELECT present, logo_url FROM source_entry WHERE household_id = ? ORDER BY upstream_channel_id')
        .all(householdId) as Array<{ present: number; logo_url: string | null }>;
      expect(entries).toHaveLength(2);
      expect(entries.every((row) => row.present === 1 && row.logo_url === null)).toBe(true);
      const posters = Database.db
        .prepare('SELECT poster_ref FROM media_item WHERE household_id = ?')
        .all(householdId) as Array<{ poster_ref: string | null }>;
      expect(posters.every((row) => row.poster_ref === null)).toBe(true);
      expect((Database.db.prepare('SELECT COUNT(*) AS n FROM channel_logo').get() as { n: number }).n).toBe(0);
    } finally {
      await scene.server.close();
    }
  });

  it('EPG:坏 icon(超长/非法 scheme/空值)窗口与对照窗口导入成功率与计数完全一致', async () => {
    const overIcon = `https://${'a'.repeat(2048 - 'https://'.length + 1)}`;
    // 双侧窗口:ch-1 同为好 icon;ch-2~ch-5 一侧为坏 icon、一侧无 icon;节目数恒等
    const channelsWithBadIcons: XmltvChannelSpec[] = [
      { id: 'ch-1', icon: '<icon src="http://epg.example/1.png"/>' },
      { id: 'ch-2', icon: `<icon src="${overIcon}"/>` },
      { id: 'ch-3', icon: '<icon src="ftp://epg.example/3.png"/>' },
      { id: 'ch-4', icon: '<icon src=""/>' },
      { id: 'ch-5' },
    ];
    const channelsControl: XmltvChannelSpec[] = channelsWithBadIcons.map((channel) => ({
      id: channel.id,
      ...(channel.id === 'ch-1' ? { icon: channel.icon } : {}),
    }));

    const runEpg = async (channels: readonly XmltvChannelSpec[], operationKey: string): Promise<RefreshJobView> => {
      const scene = await openMergeScene();
      try {
        await publishIptv(
          scene,
          [1, 2, 3, 4, 5].map((n) => ({ name: `频道${n}`, url: `http://stream.example/${n}`, tvgId: `ch-${n}` })),
          `${operationKey}-iptv`,
        );
        return await publishEpg(scene, channels, operationKey);
      } finally {
        await scene.server.close();
      }
    };

    const withBad = await runEpg(channelsWithBadIcons, 'op-sc5-epg-bad');
    const control = await runEpg(channelsControl, 'op-sc5-epg-ctrl');

    // 成功率一致:双窗口均 succeeded,channels/programmes 计数完全一致(无可感知劣化)
    expect(withBad.status).toBe('succeeded');
    expect(control.status).toBe('succeeded');
    expect(withBad.counts.channels).toBe(control.counts.channels);
    expect(withBad.counts.programmes).toBe(control.counts.programmes);
    expect(withBad.counts.channels).toBe(5);
    expect(withBad.errorCode).toBeNull();
  });
});
