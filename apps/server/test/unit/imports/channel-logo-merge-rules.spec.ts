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
import { findChannelLogoByRef } from '@contexts/media-catalog/infrastructure/channel-logo.repository';
import { createLogoProxyService } from '@contexts/media-catalog/application/logo.service';
import { buildM3u, createControlledMediaServer, type ControlledMediaServer } from '../../helpers';

/**
 * 胜者合并规则逐条单元测试(014 T030;data-model §4 M2/M3/M4 / research R5 /
 * contracts/internal-ports.md §2/§4)。全链路(受控 M3U/XMLTV → 真实 refresh 链路):
 *
 * - M3(EPG 发布,受限):绑定频道 icon_url 非空且(无行 | active(epg) | 墓碑)→
 *   写/复 active(epg);同 url active(epg) → 无操作不换 ref;epg 绝不覆盖 active(iptv)
 *   (参与者强制,本测试钉住「返回既有 ref、注册表行不动」);未绑定频道不合并;
 * - M4(EPG 发布,受限):绑定频道 icon_url 为空,或绑定随本次窗口替换失效(移除/冲突),
 *   且当前 active(epg) → 撤销转墓碑 + poster_ref=NULL;active(iptv) 胜者「否则不动」;
 * - M2(IPTV 发布):新快照移除 logo 且当前 active(iptv) → 撤销转墓碑 + poster_ref=NULL,
 *   旧引用随墓碑可解析 'revoked'(410 语义的数据面);同事务按 M3 尝试 epg 填补
 *   (绑定 + icon → active(epg);无绑定/无 icon 留墓碑);当前 active(epg) 不动;
 * - 墓碑 GC:EPG 发布事务同样顺带集合 DELETE revoked_at ≤ now−7d 行(IPTV 侧 T013 已测)。
 *
 * 关联判定复用 live-projection 的 upstream 精确匹配核心(loadChannelAssociationCore,
 * 禁止第三份逻辑)——发布事务内经同一 SQLite 连接读取,事务中写入对核心可见。
 */

/* 测试 rig:发布链内 M2/M3 合并经 live-tv 关联核心与 policy 可用性集合查询,
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
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hmp-logo-merge-'));
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
    'Logo合并测试家庭',
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
    .run(
      sourceId,
      householdId,
      kind,
      `${kind} 来源`,
      options.remoteUrl ?? 'http://lan.example/list.m3u',
      options.epgSourceId ?? null,
      now,
      now,
    );
  return sourceId;
}

function makeExecutor(): RefreshExecutorService {
  return new RefreshExecutorService(new RefreshPublishService());
}

/** XMLTV 时间戳(UTC +0000;节目窗口落在发布窗口 [now−24h, now+7d] 内) */
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
  /** icon 元素原文(含 <icon .../> 整体);缺省 = 无 icon 元素 */
  icon?: string;
  /** 额外重复声明一次(完全一致 → conflicted=1) */
  duplicated?: boolean;
}

/** 构造 XMLTV 文本(支持 icon 元素注入;fixture 服务器 buildXmltv 不支持 icon) */
function buildXmltvWithIcons(channels: readonly XmltvChannelSpec[], programmeChannels: readonly string[] = []): string {
  const hourMs = 3_600_000;
  const base = Date.now() + hourMs;
  const lines: string[] = ['<?xml version="1.0" encoding="UTF-8"?>', '<tv>'];
  for (const channel of channels) {
    const icon = channel.icon === undefined ? '' : channel.icon;
    const name = channel.displayName ?? channel.id;
    lines.push(`  <channel id="${channel.id}"><display-name>${name}</display-name>${icon}</channel>`);
    if (channel.duplicated === true) {
      lines.push(`  <channel id="${channel.id}"><display-name>${name}</display-name>${icon}</channel>`);
    }
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

/** 场景:家庭 + 受控服务器 + (绑定到 epg 源的)iptv 源 + epg 源;可先发 IPTV 后发 EPG */
interface MergeScene {
  household: HouseholdScope;
  server: ControlledMediaServer;
  executor: RefreshExecutorService;
  epgSourceId: string;
  iptvSourceId: string;
}

/** 建立「iptv 源(带 epg_source_id)+ epg 源」双源场景;是否立即发布由调用方控制 */
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

/** 发布一版 IPTV 快照(条目经 M3U 路由) */
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

/** 发布一版 EPG 窗口(XMLTV 路由) */
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

/** 按标题取频道媒体行 */
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

/** 直接植入墓碑行(upstream_url NULL 满足墓碑 CHECK) */
function seedTombstone(householdId: string, mediaId: string, sourceId: string, revokedAtIso: string): void {
  Database.db
    .prepare(
      "INSERT INTO channel_logo (household_id, media_id, ref, upstream_url, source_kind, source_id, revision, revoked_at, created_at, updated_at) VALUES (?, ?, ?, NULL, 'epg', ?, 1, ?, ?, ?)",
    )
    .run(householdId, mediaId, randomUUID().replaceAll('-', ''), sourceId, revokedAtIso, revokedAtIso, revokedAtIso);
}

/** 旧引用解析面(internal-ports §3):'revoked' 即墓碑窗口内的 410 数据形态 */
function resolveRef(householdId: string, ref: string): 'revoked' | undefined | { upstreamUrl: unknown } {
  const service = createLogoProxyService({
    resolveByRef: findChannelLogoByRef,
    // 本测试只走解析面,不触达上游读取(两方法按端口形状给桩)
    safeUpstream: {
      read: () => {
        throw new Error('测试不触达上游读取');
      },
      open: () => {
        throw new Error('测试不触达上游读取');
      },
    },
    allowedTargets: [],
  });
  return service.resolveForHousehold(householdId, ref) as 'revoked' | undefined | { upstreamUrl: unknown };
}

/* ------------------------------------------------------------------ */
/* M3:EPG 发布受限合并                                                  */
/* ------------------------------------------------------------------ */

describe('EPG 发布 M3 合并(014 T030;data-model §4 M3)', () => {
  it('绑定频道 + icon 非空 + 无行 → 写 active(epg):source_kind/source_id/upstream_url/revision=1,poster_ref=新引用', async () => {
    const scene = await openMergeScene();
    try {
      await publishIptv(scene, [{ name: '频道A', url: 'http://stream.example/a', tvgId: 'ch-a' }], 'op-m3-iptv-1');
      await publishEpg(scene, [{ id: 'ch-a', displayName: '频道A', icon: '<icon src="http://epg.example/a.png"/>' }], 'op-m3-epg-1');

      const mediaA = mediaByTitle(scene.household.householdId, '频道A');
      const row = logoRowOf(scene.household.householdId, String(mediaA.id));
      expect(row).toMatchObject({
        source_kind: 'epg',
        source_id: scene.epgSourceId,
        upstream_url: 'http://epg.example/a.png',
        revision: 1,
        revoked_at: null,
      });
      expect(String(row?.ref)).toMatch(/^[0-9a-f]{32}$/);
      expect(mediaByTitle(scene.household.householdId, '频道A').poster_ref).toBe(row?.ref);
    } finally {
      await scene.server.close();
    }
  });

  it('同 url 重发布 → 无操作不换 ref(ref/revision/updated_at 稳定)', async () => {
    const scene = await openMergeScene();
    try {
      await publishIptv(scene, [{ name: '频道A', url: 'http://stream.example/a', tvgId: 'ch-a' }], 'op-m3-iptv-1');
      await publishEpg(scene, [{ id: 'ch-a', icon: '<icon src="http://epg.example/a.png"/>' }], 'op-m3-epg-1');
      const mediaA = mediaByTitle(scene.household.householdId, '频道A');
      const first = logoRowOf(scene.household.householdId, String(mediaA.id));

      await publishEpg(scene, [{ id: 'ch-a', icon: '<icon src="http://epg.example/a.png"/>' }], 'op-m3-epg-2');
      const second = logoRowOf(scene.household.householdId, String(mediaA.id));
      expect(second).toMatchObject({ ref: first?.ref, revision: 1, updated_at: first?.updated_at });
      expect(mediaByTitle(scene.household.householdId, '频道A').poster_ref).toBe(first?.ref);
    } finally {
      await scene.server.close();
    }
  });

  it('url 变化 → 同行覆盖:新 ref、revision+1、poster_ref 跟随、revoked_at 保持 NULL', async () => {
    const scene = await openMergeScene();
    try {
      await publishIptv(scene, [{ name: '频道A', url: 'http://stream.example/a', tvgId: 'ch-a' }], 'op-m3-iptv-1');
      await publishEpg(scene, [{ id: 'ch-a', icon: '<icon src="http://epg.example/a.png"/>' }], 'op-m3-epg-1');
      const mediaA = mediaByTitle(scene.household.householdId, '频道A');
      const firstRef = String(logoRowOf(scene.household.householdId, String(mediaA.id))?.ref);

      await publishEpg(scene, [{ id: 'ch-a', icon: '<icon src="http://epg.example/a-v2.png"/>' }], 'op-m3-epg-2');
      const second = logoRowOf(scene.household.householdId, String(mediaA.id));
      expect(second).toMatchObject({
        upstream_url: 'http://epg.example/a-v2.png',
        revision: 2,
        revoked_at: null,
        source_kind: 'epg',
      });
      expect(String(second?.ref)).not.toBe(firstRef);
      expect(mediaByTitle(scene.household.householdId, '频道A').poster_ref).toBe(second?.ref);
    } finally {
      await scene.server.close();
    }
  });

  it('墓碑复 active:同行写新胜者(清 revoked_at、新 ref、revision+1)', async () => {
    const scene = await openMergeScene();
    try {
      await publishIptv(scene, [{ name: '频道A', url: 'http://stream.example/a', tvgId: 'ch-a' }], 'op-m3-iptv-1');
      const mediaA = mediaByTitle(scene.household.householdId, '频道A');
      const nowMs = Date.now();
      seedTombstone(scene.household.householdId, String(mediaA.id), scene.epgSourceId, new Date(nowMs - 3_600_000).toISOString());
      const tombstone = logoRowOf(scene.household.householdId, String(mediaA.id));
      expect(tombstone).toMatchObject({ revoked_at: expect.any(String), upstream_url: null });

      await publishEpg(scene, [{ id: 'ch-a', icon: '<icon src="http://epg.example/revive.png"/>' }], 'op-m3-epg-2');
      const revived = logoRowOf(scene.household.householdId, String(mediaA.id));
      expect(revived).toMatchObject({
        upstream_url: 'http://epg.example/revive.png',
        source_kind: 'epg',
        revision: 2,
        revoked_at: null,
      });
      expect(String(revived?.ref)).not.toBe(tombstone?.ref);
      expect(mediaByTitle(scene.household.householdId, '频道A').poster_ref).toBe(revived?.ref);
    } finally {
      await scene.server.close();
    }
  });

  it('epg 绝不覆盖 active(iptv):胜者行保持 iptv 原值,poster_ref 钉住既有 iptv 引用', async () => {
    const scene = await openMergeScene();
    try {
      await publishEpg(scene, [{ id: 'ch-a', icon: '<icon src="http://epg.example/epg.png"/>' }], 'op-m3-epg-0');
      await publishIptv(
        scene,
        [{ name: '频道A', url: 'http://stream.example/a', tvgId: 'ch-a', tvgLogo: 'http://cdn.example/iptv.png' }],
        'op-m3-iptv-1',
      );
      const mediaA = mediaByTitle(scene.household.householdId, '频道A');
      const iptvRow = logoRowOf(scene.household.householdId, String(mediaA.id));
      expect(iptvRow).toMatchObject({ source_kind: 'iptv', upstream_url: 'http://cdn.example/iptv.png', revision: 1 });
      const iptvRef = String(iptvRow?.ref);

      // epg 发布(不同地址):返回既有 ref、注册表行原样、poster 不闪变
      await publishEpg(scene, [{ id: 'ch-a', icon: '<icon src="http://epg.example/epg.png"/>' }], 'op-m3-epg-1');
      const after = logoRowOf(scene.household.householdId, String(mediaA.id));
      expect(after).toMatchObject({
        source_kind: 'iptv',
        upstream_url: 'http://cdn.example/iptv.png',
        revision: 1,
        ref: iptvRef,
        updated_at: iptvRow?.updated_at,
      });
      expect(mediaByTitle(scene.household.householdId, '频道A').poster_ref).toBe(iptvRef);
    } finally {
      await scene.server.close();
    }
  });

  it('未绑定频道不合并:epg 频道有 icon 但无任何绑定频道 → 零注册表写入', async () => {
    const scene = await openMergeScene();
    try {
      // 无 IPTV 源/无条目:ch-lonely 无绑定频道
      await publishEpg(scene, [{ id: 'ch-lonely', icon: '<icon src="http://epg.example/lonely.png"/>' }], 'op-m3-lonely');
      const total = Database.db.prepare('SELECT COUNT(*) AS n FROM channel_logo').get() as { n: number };
      expect(total.n).toBe(0);
    } finally {
      await scene.server.close();
    }
  });
});

/* ------------------------------------------------------------------ */
/* M4:EPG 发布撤销                                                      */
/* ------------------------------------------------------------------ */

describe('EPG 发布 M4 撤销(014 T030;data-model §4 M4)', () => {
  it('绑定仍在但 icon_url 变空 → active(epg) 转墓碑 + poster_ref=NULL,旧引用解析为 revoked(410 数据形态)', async () => {
    const scene = await openMergeScene();
    try {
      await publishIptv(scene, [{ name: '频道A', url: 'http://stream.example/a', tvgId: 'ch-a' }], 'op-m4-iptv-1');
      await publishEpg(scene, [{ id: 'ch-a', icon: '<icon src="http://epg.example/a.png"/>' }], 'op-m4-epg-1');
      const mediaA = mediaByTitle(scene.household.householdId, '频道A');
      const oldRef = String(logoRowOf(scene.household.householdId, String(mediaA.id))?.ref);

      // 窗口 v2:同频道但无 icon(元素缺失)
      await publishEpg(scene, [{ id: 'ch-a', displayName: '频道A' }], 'op-m4-epg-2');

      const tombstoned = logoRowOf(scene.household.householdId, String(mediaA.id));
      expect(tombstoned).toMatchObject({ ref: oldRef, upstream_url: null, revoked_at: expect.any(String) });
      expect(mediaByTitle(scene.household.householdId, '频道A').poster_ref).toBeNull();
      expect(resolveRef(scene.household.householdId, oldRef)).toBe('revoked');
    } finally {
      await scene.server.close();
    }
  });

  it('active(iptv) 胜者 + epg icon 变空 → 不动(受限:绝不撤 iptv 胜者)', async () => {
    const scene = await openMergeScene();
    try {
      await publishIptv(
        scene,
        [{ name: '频道A', url: 'http://stream.example/a', tvgId: 'ch-a', tvgLogo: 'http://cdn.example/a.png' }],
        'op-m4-iptv-1',
      );
      const mediaA = mediaByTitle(scene.household.householdId, '频道A');
      const iptvRow = logoRowOf(scene.household.householdId, String(mediaA.id));
      const iptvRef = String(iptvRow?.ref);

      await publishEpg(scene, [{ id: 'ch-a' }], 'op-m4-epg-1');
      expect(logoRowOf(scene.household.householdId, String(mediaA.id))).toMatchObject({
        source_kind: 'iptv',
        upstream_url: 'http://cdn.example/a.png',
        ref: iptvRef,
        revoked_at: null,
      });
      expect(mediaByTitle(scene.household.householdId, '频道A').poster_ref).toBe(iptvRef);
    } finally {
      await scene.server.close();
    }
  });

  it('绑定随本次窗口替换失效(频道移除)→ active(epg) 撤销转墓碑', async () => {
    const scene = await openMergeScene();
    try {
      await publishIptv(scene, [{ name: '频道A', url: 'http://stream.example/a', tvgId: 'ch-a' }], 'op-m4-iptv-1');
      await publishEpg(scene, [{ id: 'ch-a', icon: '<icon src="http://epg.example/a.png"/>' }], 'op-m4-epg-1');
      const mediaA = mediaByTitle(scene.household.householdId, '频道A');
      const oldRef = String(logoRowOf(scene.household.householdId, String(mediaA.id))?.ref);

      // 窗口 v2:ch-a 从窗口移除 → 绑定失效
      await publishEpg(scene, [{ id: 'ch-other', displayName: '其他频道', icon: '<icon src="http://epg.example/other.png"/>' }], 'op-m4-epg-2');

      const tombstoned = logoRowOf(scene.household.householdId, String(mediaA.id));
      expect(tombstoned).toMatchObject({ ref: oldRef, upstream_url: null, revoked_at: expect.any(String) });
      expect(mediaByTitle(scene.household.householdId, '频道A').poster_ref).toBeNull();
      expect(resolveRef(scene.household.householdId, oldRef)).toBe('revoked');
    } finally {
      await scene.server.close();
    }
  });

  it('绑定随本次窗口替换失效(频道转 conflicted)→ active(epg) 撤销转墓碑', async () => {
    const scene = await openMergeScene();
    try {
      await publishIptv(scene, [{ name: '频道A', url: 'http://stream.example/a', tvgId: 'ch-a' }], 'op-m4-iptv-1');
      await publishEpg(scene, [{ id: 'ch-a', icon: '<icon src="http://epg.example/a.png"/>' }], 'op-m4-epg-1');
      const mediaA = mediaByTitle(scene.household.householdId, '频道A');
      const oldRef = String(logoRowOf(scene.household.householdId, String(mediaA.id))?.ref);

      // 窗口 v2:ch-a 完全一致重复声明 → conflicted=1 → 绑定失效(不回退)
      await publishEpg(scene, [{ id: 'ch-a', duplicated: true, icon: '<icon src="http://epg.example/a.png"/>' }], 'op-m4-epg-2');

      const tombstoned = logoRowOf(scene.household.householdId, String(mediaA.id));
      expect(tombstoned).toMatchObject({ ref: oldRef, upstream_url: null, revoked_at: expect.any(String) });
      expect(mediaByTitle(scene.household.householdId, '频道A').poster_ref).toBeNull();
    } finally {
      await scene.server.close();
    }
  });
});

/* ------------------------------------------------------------------ */
/* M2:IPTV 发布撤销 + epg 填补                                          */
/* ------------------------------------------------------------------ */

describe('IPTV 发布 M2 撤销与 epg 填补(014 T030;data-model §4 M2)', () => {
  it('新快照移除 logo 且当前 active(iptv) → 转墓碑 + poster_ref=NULL;无绑定/icon 留墓碑,旧引用 revoked', async () => {
    const scene = await openMergeScene();
    try {
      await publishIptv(
        scene,
        [{ name: '频道A', url: 'http://stream.example/a', tvgId: 'ch-a', tvgLogo: 'http://cdn.example/a.png' }],
        'op-m2-iptv-1',
      );
      const mediaA = mediaByTitle(scene.household.householdId, '频道A');
      const oldRef = String(logoRowOf(scene.household.householdId, String(mediaA.id))?.ref);

      // 窗口 v2:同频道但 tvg-logo 移除(epg 源尚未发布 icon → 无 epg 证据可填补)
      await publishIptv(scene, [{ name: '频道A', url: 'http://stream.example/a', tvgId: 'ch-a' }], 'op-m2-iptv-2');

      const tombstoned = logoRowOf(scene.household.householdId, String(mediaA.id));
      expect(tombstoned).toMatchObject({ ref: oldRef, source_kind: 'iptv', upstream_url: null, revoked_at: expect.any(String) });
      expect(mediaByTitle(scene.household.householdId, '频道A').poster_ref).toBeNull();
      expect(resolveRef(scene.household.householdId, oldRef)).toBe('revoked');
    } finally {
      await scene.server.close();
    }
  });

  it('M2 同事务按 M3 填补:绑定频道有 epg icon → 撤销后立即写 active(epg),poster_ref=epg 新引用', async () => {
    const scene = await openMergeScene();
    try {
      // epg 先行:绑定频道已有 icon 证据(epg 无胜者,只有 icon_url 证据列)
      await publishIptv(scene, [{ name: '频道A', url: 'http://stream.example/a', tvgId: 'ch-a' }], 'op-m2-iptv-1');
      await publishEpg(scene, [{ id: 'ch-a', icon: '<icon src="http://epg.example/a.png"/>' }], 'op-m2-epg-1');
      await publishIptv(
        scene,
        [{ name: '频道A', url: 'http://stream.example/a', tvgId: 'ch-a', tvgLogo: 'http://cdn.example/a.png' }],
        'op-m2-iptv-2',
      );
      const mediaA = mediaByTitle(scene.household.householdId, '频道A');
      expect(logoRowOf(scene.household.householdId, String(mediaA.id))).toMatchObject({
        source_kind: 'iptv',
        upstream_url: 'http://cdn.example/a.png',
      });

      // IPTV 窗口 v3:logo 移除 → 撤销 iptv 胜者并同事务以 epg icon 填补
      await publishIptv(scene, [{ name: '频道A', url: 'http://stream.example/a', tvgId: 'ch-a' }], 'op-m2-iptv-3');

      const filled = logoRowOf(scene.household.householdId, String(mediaA.id));
      expect(filled).toMatchObject({
        source_kind: 'epg',
        source_id: scene.epgSourceId,
        upstream_url: 'http://epg.example/a.png',
        revoked_at: null,
      });
      expect(mediaByTitle(scene.household.householdId, '频道A').poster_ref).toBe(filled?.ref);
    } finally {
      await scene.server.close();
    }
  });

  it('新快照移除 logo 但当前 active(epg) → 不动(受限:只撤自己来源的胜者)', async () => {
    const scene = await openMergeScene();
    try {
      await publishIptv(scene, [{ name: '频道A', url: 'http://stream.example/a', tvgId: 'ch-a' }], 'op-m2-iptv-1');
      await publishEpg(scene, [{ id: 'ch-a', icon: '<icon src="http://epg.example/a.png"/>' }], 'op-m2-epg-1');
      const mediaA = mediaByTitle(scene.household.householdId, '频道A');
      const epgRow = logoRowOf(scene.household.householdId, String(mediaA.id));
      expect(epgRow).toMatchObject({ source_kind: 'epg', revoked_at: null });
      const epgRef = String(epgRow?.ref);

      // IPTV 窗口 v2:无 logo;当前胜者是 active(epg) → M2 不触发
      await publishIptv(scene, [{ name: '频道A', url: 'http://stream.example/a', tvgId: 'ch-a' }], 'op-m2-iptv-2');

      expect(logoRowOf(scene.household.householdId, String(mediaA.id))).toMatchObject({
        source_kind: 'epg',
        upstream_url: 'http://epg.example/a.png',
        ref: epgRef,
        revoked_at: null,
      });
      expect(mediaByTitle(scene.household.householdId, '频道A').poster_ref).toBe(epgRef);
    } finally {
      await scene.server.close();
    }
  });
});

/* ------------------------------------------------------------------ */
/* 墓碑 GC:EPG 发布事务同款集合 DELETE                                    */
/* ------------------------------------------------------------------ */

describe('EPG 发布事务墓碑 GC(014 T030;data-model §4)', () => {
  it('EPG 发布顺带集合 DELETE revoked_at ≤ now−7d 行;窗口内墓碑与 active 行不动', async () => {
    const scene = await openMergeScene();
    try {
      await publishIptv(scene, [{ name: '频道A', url: 'http://stream.example/a', tvgId: 'ch-a' }], 'op-gc-iptv-1');
      const mediaA = mediaByTitle(scene.household.householdId, '频道A');
      const nowMs = Date.now();
      seedTombstone(scene.household.householdId, String(mediaA.id), scene.epgSourceId, new Date(nowMs - 8 * 24 * 3_600_000).toISOString());
      // 窗口内墓碑载体:另一频道(无绑定,不参与合并)
      Database.db
        .prepare('INSERT INTO media_item (id, household_id, type, title, description, poster_ref, content_level, title_overridden, type_overridden, version, created_at, updated_at) VALUES (?, ?, ?, ?, NULL, NULL, NULL, 0, 0, 1, ?, ?)')
        .run(randomUUID(), scene.household.householdId, 'channel', '窗口墓碑载体', nowIso(), nowIso());
      const keeperId = (Database.db
        .prepare("SELECT id FROM media_item WHERE household_id = ? AND title = '窗口墓碑载体'")
        .get(scene.household.householdId) as { id: string }).id;
      seedTombstone(scene.household.householdId, keeperId, scene.epgSourceId, new Date(nowMs - 6 * 24 * 3_600_000).toISOString());

      await publishEpg(scene, [{ id: 'ch-a' }], 'op-gc-epg-1');

      const expired = logoRowOf(scene.household.householdId, String(mediaA.id));
      expect(expired, '超窗口墓碑应被集合 DELETE').toBeUndefined();
      expect(logoRowOf(scene.household.householdId, keeperId), '窗口内墓碑应保留').toBeDefined();
    } finally {
      await scene.server.close();
    }
  });
});

/** ISO 时间 helper(造数用) */
function nowIso(): string {
  return new Date().toISOString();
}
