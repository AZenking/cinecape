import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { Database } from '@platform/database/database';
import { setEnvOverride } from '@platform/config/env';
import { loadEnv } from '@platform/config/env.schema';
import { RefreshExecutorService, type RefreshJobView } from '@contexts/sources/application/refresh-executor.service';
import { RefreshPublishService } from '@contexts/sources/application/refresh-publish.service';
import { bindSourcesStore } from '@contexts/sources/application/sources-store.port';
import { drizzleSourcesStore } from '@contexts/sources/infrastructure/sources-store.drizzle';
import {
  buildLineLabel,
  channelKeyOf,
  deriveLinePriority,
  extractLineDifferenceLabel,
} from '@contexts/sources/infrastructure/m3u.parser';
import { buildStreamLines } from '@contexts/playback/application/playback-resolver.service';
import type { PlaybackLineRow } from '@contexts/playback/application/playback-store.port';
import {
  buildM3u,
  createControlledMediaServer,
  type ControlledMediaServer,
} from '../../fixtures/controlled-media-server';

/**
 * 016-multi-source-live-epg T016(US3 服务端全链路):多直播线路聚合单元测试。
 *
 * 权威依据:
 * - research.md R1:同名流(归一键相同)在同一 Household 下自动合并为「单 media_item +
 *   多 source_entry 线路」;不同名不合并;大小写/噪音后缀差异(1080P/4K/(备用))不阻断合并;
 * - data-model.md §1.3(逻辑频道 × 物理条目一对多)/§2.1(StreamLine:label/priority/
 *   isDefault/isEnabled);api.md §2.1(经父代理裁决:实现按现行 POST /playback/resolve
 *   入口增量扩展,lineId/selectedLineId/lines 走该入口);
 * - 线路属性派生(保守确定性公式):label 差异段(括注/清晰度词,回退来源名)、
 *   priority = 来源 priority + 清晰度罚分(越清晰罚分越小,未标注 0)、isDefault = 首条线路。
 *
 * 覆盖:
 * 1) 纯函数面:归一键(channelKeyOf,复用 live-tv normalizeChannelKey)、差异段提取、
 *    线路 priority 加权、线路 label 组装、resolve 侧线路投影排序/isDefault/isEnabled;
 * 2) 导入链路(受控 M3U + 真实 refresh 执行/发布事务,rig 照 refresh-executor.spec 模式):
 *    同源同名聚合为单 media_item 多 source_entry;跨源同名并入既有频道 media;
 *    不同名不合并;线路 priority 按「来源 priority + 清晰度」落 playback_source.priority;
 *    重导入幂等(media/source_entry/playback id 稳定,不产生重复行)。
 * 环境硬约束:小体量(每用例 ≤5 条目/2 来源),不做大体量实跑。
 */

bindSourcesStore(drizzleSourcesStore());

/* ------------------------------------------------------------------ */
/* rig(照 refresh-executor.spec 模式:独立临时库 + 指定迁移)             */
/* ------------------------------------------------------------------ */

interface DbRig {
  dataDir: string;
}

const rigs: DbRig[] = [];
const activeServers: ControlledMediaServer[] = [];

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

/** 0001~0003 基线 + 0010(media_source.priority;线路权重派生的读取面) */
function bootstrapRig(): void {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hmp-multi-stream-'));
  const dbFilename = `${randomUUID()}.hmp.db`;
  setEnvOverride(
    loadEnv({
      NODE_ENV: 'test',
      DATA_DIR: dataDir,
      DB_FILENAME: dbFilename,
      LAN_ALLOWED_TARGETS: '127.0.0.1',
    }),
  );
  Database.close();
  Database.db.exec('CREATE TABLE IF NOT EXISTS _migrations (name TEXT PRIMARY KEY NOT NULL, applied_at TEXT NOT NULL)');
  for (const name of ['0001_init', '0002_profile_policy', '0003_media_catalog', '0004_manual_epg_binding', '0005_playback', '0006_pc_experience', '0007_online_vod', '0008_profile_preferences', '0009_channel_logos', '0010_multi_source_priority', '0011_channel_visibility', '0012_programme_posters', '0013_source_governance']) {
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
    if (rig !== undefined) {
      Database.close();
      setEnvOverride(null);
      fs.rmSync(rig.dataDir, { recursive: true, force: true });
    }
  }
  while (activeServers.length > 0) {
    const server = activeServers.pop();
    void server?.close();
  }
}

afterEach(cleanupRigs);

/* ------------------------------------------------------------------ */
/* 造数辅助(最小链路)                                                  */
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
    '多线路测试家庭',
    'zh-CN',
    'Asia/Shanghai',
    now,
  );
  const username = `owner-${ids.householdId.slice(0, 8)}`;
  db.prepare(
    'INSERT INTO account (id, household_id, username, username_normalized, password_hash, role, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
  ).run(ids.accountId, ids.householdId, username, username, '$argon2id$fixture-hash', 'owner', now);
  db.prepare('INSERT INTO device (id, household_id, name, type, last_seen_at, revoked_at, created_at) VALUES (?, ?, ?, ?, NULL, NULL, ?)').run(
    randomUUID(),
    ids.householdId,
    '多线路测试设备',
    'web',
    now,
  );
  const device = db.prepare('SELECT id FROM device WHERE household_id = ?').get(ids.householdId) as { id: string };
  db.prepare(
    'INSERT INTO device_session (id, household_id, account_id, device_id, token_hash, active_profile_id, expires_at, revoked_at, last_active_at, created_at) VALUES (?, ?, ?, ?, ?, NULL, ?, NULL, ?, ?)',
  ).run(ids.sessionId, ids.householdId, ids.accountId, device.id, `hash-${ids.sessionId}`, '2099-01-01T00:00:00Z', now, now);
  db.prepare('INSERT INTO catalog_state (household_id, revision) VALUES (?, 1)').run(ids.householdId);
  return ids;
}

function seedIptvSource(householdId: string, sourceId: string, name: string, remoteUrl: string, priority: number): string {
  const now = new Date().toISOString();
  Database.db
    .prepare(
      'INSERT INTO media_source (id, household_id, kind, name, remote_url, enabled, priority, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?)',
    )
    .run(sourceId, householdId, 'iptv', name, remoteUrl, priority, now, now);
  return sourceId;
}

function mediaRows(householdId: string): Array<Record<string, unknown>> {
  return Database.db.prepare('SELECT * FROM media_item WHERE household_id = ?').all(householdId) as Array<
    Record<string, unknown>
  >;
}

function entryRows(householdId: string): Array<Record<string, unknown>> {
  return Database.db.prepare('SELECT * FROM source_entry WHERE household_id = ?').all(householdId) as Array<
    Record<string, unknown>
  >;
}

function playbackIds(householdId: string): string[] {
  return (
    Database.db.prepare('SELECT id FROM playback_source WHERE household_id = ? ORDER BY id').all(householdId) as Array<{
      id: string;
    }>
  ).map((row) => row.id);
}

/** 条目 id → 播放资源 priority(线路权重断言面) */
function playbackPriorityByEntry(householdId: string): Map<string, number> {
  const rows = Database.db
    .prepare('SELECT source_entry_id, priority FROM playback_source WHERE household_id = ?')
    .all(householdId) as Array<{ source_entry_id: string; priority: number }>;
  return new Map(rows.map((row) => [row.source_entry_id, row.priority]));
}

/**
 * 起一个受控 M3U 服务并跑完一次真实导入(requestRefresh → runQueuedOnce → 终态)。
 * 服务器先起、来源后种(remote_url 指向受控地址,与生产 openRemoteSource 链路一致)。
 */
async function importPlaylist(
  household: HouseholdScope,
  sourceName: string,
  sourcePriority: number,
  playlist: Array<{ name: string; url: string; tvgId?: string }>,
  operationKey: string,
  sourceId = randomUUID(),
): Promise<{ sourceId: string; job: RefreshJobView }> {
  const server = await createControlledMediaServer();
  activeServers.push(server);
  server.setRoute('/list.m3u', { kind: 'm3u', content: buildM3u(playlist) });
  seedIptvSource(household.householdId, sourceId, sourceName, `${server.baseUrl}/list.m3u`, sourcePriority);
  const executor = new RefreshExecutorService(new RefreshPublishService());
  const job = executor.requestRefresh({
    householdId: household.householdId,
    accountId: household.accountId,
    sessionId: household.sessionId,
    sourceId,
    expectedVersion: 1,
    operationKey,
    ownerPasswordVerified: true,
  });
  const final = await executor.runQueuedOnce();
  expect(final?.id).toBe(job.id);
  await server.close();
  return { sourceId, job: final as RefreshJobView };
}

/** 已存在来源的重复刷新(重导入幂等路径;服务器地址不变) */
async function reimportExistingSource(
  household: HouseholdScope,
  sourceId: string,
  playlist: Array<{ name: string; url: string; tvgId?: string }>,
  operationKey: string,
): Promise<RefreshJobView> {
  const server = await createControlledMediaServer();
  activeServers.push(server);
  server.setRoute('/list.m3u', { kind: 'm3u', content: buildM3u(playlist) });
  const row = Database.db.prepare('SELECT remote_url FROM media_source WHERE id = ?').get(sourceId) as {
    remote_url: string;
  };
  Database.db.prepare('UPDATE media_source SET remote_url = ? WHERE id = ?').run(`${server.baseUrl}/list.m3u`, sourceId);
  const executor = new RefreshExecutorService(new RefreshPublishService());
  const job = executor.requestRefresh({
    householdId: household.householdId,
    accountId: household.accountId,
    sessionId: household.sessionId,
    sourceId,
    expectedVersion: 1,
    operationKey,
    ownerPasswordVerified: true,
  });
  const final = await executor.runQueuedOnce();
  expect(final?.id).toBe(job.id);
  Database.db.prepare('UPDATE media_source SET remote_url = ? WHERE id = ?').run(row.remote_url, sourceId);
  await server.close();
  return final as RefreshJobView;
}

/* ------------------------------------------------------------------ */
/* 1. 纯函数面:归一键 / 差异段 / priority 加权 / label / 线路投影        */
/* ------------------------------------------------------------------ */

describe('channelKeyOf(复用 live-tv normalizeChannelKey 的归一键)', () => {
  it('大小写、分隔符与清晰度噪音后缀差异不阻断合并(同键)', () => {
    expect(channelKeyOf('CCTV-1 综合')).toBe(channelKeyOf('cctv-1综合1080p'));
    expect(channelKeyOf('CCTV-1 综合')).toBe(channelKeyOf('CCTV1综合 [4K]'));
  });

  it('频道身份差异保留键(+ 不剥离);不同名不合并', () => {
    expect(channelKeyOf('CCTV-5+ 体育')).not.toBe(channelKeyOf('CCTV-1 综合'));
    expect(channelKeyOf('CCTV5+体育')).toBe(channelKeyOf('CCTV-5+ 体育'));
  });

  it('幂等:normalize(normalize(x)) == normalize(x)', () => {
    const once = channelKeyOf('CCTV-1 综合 [1080P]');
    expect(channelKeyOf(once)).toBe(once);
  });
});

describe('extractLineDifferenceLabel(线路差异段,保守提取)', () => {
  it('括注段原样保留(大小写不折损):[1080P]/(备用)/【超清】', () => {
    expect(extractLineDifferenceLabel('CCTV-1 综合 [1080P]')).toBe('1080P');
    expect(extractLineDifferenceLabel('CCTV-1 综合 (备用)')).toBe('备用');
    expect(extractLineDifferenceLabel('CCTV-1 综合【超清】')).toBe('超清');
  });

  it('无括注时提取清晰度噪音词原文', () => {
    expect(extractLineDifferenceLabel('CCTV-1 综合 1080P')).toBe('1080P');
    expect(extractLineDifferenceLabel('CCTV-1 综合 4K')).toBe('4K');
  });

  it('纯净名称无差异段 → 空串(调用方回退来源名)', () => {
    expect(extractLineDifferenceLabel('CCTV-1 综合')).toBe('');
    expect(extractLineDifferenceLabel('CCTV-1')).toBe('');
  });
});

describe('deriveLinePriority(来源 priority + 清晰度加权,确定性公式)', () => {
  it('越清晰罚分越小:8K(0) < 4K(2) < 1080P(4) < 720P(8) < 标清(16)', () => {
    expect(deriveLinePriority(10, 'CCTV-1 综合 8K')).toBe(10);
    expect(deriveLinePriority(10, 'CCTV-1 综合 4K')).toBe(12);
    expect(deriveLinePriority(10, 'CCTV-1 综合 1080P')).toBe(14);
    expect(deriveLinePriority(10, 'CCTV-1 综合 720P')).toBe(18);
    expect(deriveLinePriority(10, 'CCTV-1 综合 标清')).toBe(26);
  });

  it('未标注清晰度 → 罚分 0(与来源 priority 同序,既有导入行为零变化)', () => {
    expect(deriveLinePriority(100, 'CCTV-1')).toBe(100);
    expect(deriveLinePriority(10, 'CCTV-1 综合 (备用)')).toBe(10);
  });

  it('来源 priority 缺省兜底 100;词边界防误伤(4k 后邻为字母 → 词内片段不算清晰度)', () => {
    expect(deriveLinePriority(undefined as unknown as number, 'CCTV-1')).toBe(100);
    expect(deriveLinePriority(10, 'CCTV 4KNEWS 频道')).toBe(10);
  });
});

describe('buildLineLabel(线路 N [差异段|来源名])', () => {
  it('差异段优先;缺失回退来源名;两者皆缺省略方括号', () => {
    expect(buildLineLabel(1, '1080P', '电信主源')).toBe('线路 1 [1080P]');
    expect(buildLineLabel(2, '', '移动备用')).toBe('线路 2 [移动备用]');
    expect(buildLineLabel(3, '', '')).toBe('线路 3');
  });
});

describe('buildStreamLines(resolve 侧线路投影:排序/isDefault/isEnabled/label)', () => {
  const rows: PlaybackLineRow[] = [
    {
      playbackSourceId: 'pb-b',
      lineId: 'line-b',
      sourceId: 'src-b',
      sourceTitle: '联通备用',
      linePriority: 20,
    },
    {
      playbackSourceId: 'pb-a',
      lineId: 'line-a',
      sourceId: 'src-a',
      sourceTitle: '电信高清',
      linePriority: 10,
    },
  ];

  it('按 priority ASC 排序;首条 isDefault=true 其余 false;isEnabled 恒 true', () => {
    const lines = buildStreamLines(rows);
    expect(lines.map((line) => line.lineId)).toEqual(['line-a', 'line-b']);
    expect(lines[0]?.priority).toBe(10);
    expect(lines[1]?.priority).toBe(20);
    expect(lines.filter((line) => line.isDefault)).toHaveLength(1);
    expect(lines[0]?.isDefault).toBe(true);
    expect(lines[1]?.isDefault).toBe(false);
    for (const line of lines) {
      expect(line.isEnabled).toBe(true);
    }
  });

  it('同 priority 以 lineId 二进制升序决胜(确定性);label 回退来源名', () => {
    const tied: PlaybackLineRow[] = [
      { playbackSourceId: 'pb-2', lineId: 'line-z', sourceId: 'src', sourceTitle: '甲源', linePriority: 10 },
      { playbackSourceId: 'pb-1', lineId: 'line-a', sourceId: 'src', sourceTitle: '乙源', linePriority: 10 },
    ];
    const lines = buildStreamLines(tied);
    expect(lines.map((line) => line.lineId)).toEqual(['line-a', 'line-z']);
    expect(lines[0]?.label).toBe('线路 1 [乙源]');
    expect(lines[1]?.label).toBe('线路 2 [甲源]');
  });

  it('投影只含公开字段(lineId/sourceId/sourceTitle/label/priority/isDefault/isEnabled),无源地址', () => {
    const lines = buildStreamLines(rows);
    for (const line of lines) {
      expect(Object.keys(line).sort()).toEqual([
        'isDefault',
        'isEnabled',
        'label',
        'lineId',
        'priority',
        'sourceId',
        'sourceTitle',
      ]);
    }
  });
});

/* ------------------------------------------------------------------ */
/* 2. 导入链路:同源聚合 / 跨源并入 / 不同名不合并 / 幂等                */
/* ------------------------------------------------------------------ */

const SAME_CHANNEL_PLAYLIST = [
  { name: 'CCTV-1 综合 1080P', url: 'http://stream.example/cctv1-fhd.m3u8', tvgId: 'cctv1-fhd' },
  { name: 'CCTV-1 综合 4K', url: 'http://stream.example/cctv1-4k.m3u8', tvgId: 'cctv1-4k' },
  { name: 'CCTV-1 综合 (备用)', url: 'http://stream.example/cctv1-backup.m3u8' },
  { name: 'CCTV-5+ 体育', url: 'http://stream.example/cctv5plus.m3u8', tvgId: 'cctv5plus' },
];

describe('导入聚合(真实 refresh 执行/发布事务)', () => {
  it('同源同名流聚合为单 media_item + 多 source_entry 线路;不同名不合并', async () => {
    bootstrapRig();
    const household = seedHousehold();

    const { job } = await importPlaylist(household, '聚合测试源', 10, SAME_CHANNEL_PLAYLIST, 'op-aggregate');
    expect(job.status).toBe('succeeded');
    expect(job.errorCode).toBeNull();

    const media = mediaRows(household.householdId);
    // 4 条物理流 → 2 个逻辑频道(CCTV-1 综合 ×3 合并;CCTV-5+ 体育 独立)
    expect(media).toHaveLength(2);
    for (const row of media) {
      expect(row.type).toBe('channel');
    }
    const cctv5Media = media.find((row) => row.title === 'CCTV-5+ 体育') as Record<string, unknown> | undefined;
    expect(cctv5Media).toBeDefined();
    const cctv1MediaList = media.filter((row) => row.title !== 'CCTV-5+ 体育');
    expect(cctv1MediaList).toHaveLength(1);
    const cctv1MediaId = String(cctv1MediaList[0]?.id);
    // 合并频道的展示标题取自首条物理流(确定性:entryKey 升序),必为三条变体之一
    expect(['CCTV-1 综合 1080P', 'CCTV-1 综合 4K', 'CCTV-1 综合 (备用)']).toContain(String(cctv1MediaList[0]?.title));

    // 4 条 source_entry;三条 CCTV-1 线路(2×tvg_id + 1×url 身份)挂同一 media,CCTV-5+ 独立
    const entries = entryRows(household.householdId);
    expect(entries).toHaveLength(4);
    const linesOfCctv1 = entries.filter((row) => row.media_id === cctv1MediaId);
    expect(linesOfCctv1).toHaveLength(3);
    expect(linesOfCctv1.map((row) => row.identity_kind).sort()).toEqual(['tvg_id', 'tvg_id', 'url']);
    const cctv5Entries = entries.filter((row) => row.upstream_channel_id === 'cctv5plus');
    expect(cctv5Entries).toHaveLength(1);
    expect(cctv5Entries[0]?.media_id).toBe(cctv5Media?.id);
  });

  it('线路 priority 按「来源 priority + 清晰度」落 playback_source.priority(10 源:4K=12、1080P=14、无标注=10)', async () => {
    bootstrapRig();
    const household = seedHousehold();
    await importPlaylist(household, '权重测试源', 10, SAME_CHANNEL_PLAYLIST, 'op-priority');

    const priorities = playbackPriorityByEntry(household.householdId);
    expect(priorities.size).toBe(4);
    const entries = entryRows(household.householdId);
    // tvg_id 身份:4K(cctv1-4k)→ 12;1080P(cctv1-fhd)→ 14;CCTV-5+(无标注)→ 10
    const tvgEntries = entries.filter((row) => row.identity_kind === 'tvg_id');
    expect(tvgEntries).toHaveLength(3);
    const priorityByUpstream = new Map(
      tvgEntries.map((row) => [row.upstream_channel_id as string, priorities.get(String(row.id))]),
    );
    expect(priorityByUpstream.get('cctv1-4k')).toBe(12);
    expect(priorityByUpstream.get('cctv1-fhd')).toBe(14);
    expect(priorityByUpstream.get('cctv5plus')).toBe(10);
    // url 身份(备用,无清晰度标注)→ 10
    const urlEntry = entries.find((row) => row.identity_kind === 'url') as Record<string, unknown>;
    expect(priorities.get(String(urlEntry.id))).toBe(10);
  });

  it('跨源同名并入既有频道 media(第二来源发布不新建同名 media_item)', async () => {
    bootstrapRig();
    const household = seedHousehold();
    const { sourceId: sourceA } = await importPlaylist(household, '电信主源', 10, SAME_CHANNEL_PLAYLIST, 'op-cross-a');
    expect(sourceA).toBeDefined();
    expect(mediaRows(household.householdId)).toHaveLength(2);

    const { sourceId: sourceB, job } = await importPlaylist(
      household,
      '联通备用源',
      50,
      [{ name: 'CCTV-1 综合 (联通备用)', url: 'http://stream.example/cctv1-unicom.m3u8' }],
      'op-cross-b',
    );
    expect(job.status).toBe('succeeded');
    expect(job.counts.added).toBe(1);

    // 目录仍是 2 个逻辑频道;来源 B 的条目挂到既有 CCTV-1 media(4 条线路同一频道)
    const mediaAfterB = mediaRows(household.householdId);
    expect(mediaAfterB).toHaveLength(2);
    const cctv1MediaId = String(mediaAfterB.find((row) => row.title !== 'CCTV-5+ 体育')?.id);
    const entriesAfterB = entryRows(household.householdId);
    expect(entriesAfterB).toHaveLength(5);
    expect(entriesAfterB.filter((row) => row.media_id === cctv1MediaId)).toHaveLength(4);
    // 联通线路 priority = 来源 B priority(50)+ 0(无清晰度标注)
    const priorities = playbackPriorityByEntry(household.householdId);
    const unicomEntry = entriesAfterB.find((row) => row.source_id === sourceB) as Record<string, unknown>;
    expect(unicomEntry).toBeDefined();
    expect(priorities.get(String(unicomEntry.id))).toBe(50);
  });

  it('重导入幂等:media/source_entry/playback id 稳定,不产生重复行(counts added=0)', async () => {
    bootstrapRig();
    const household = seedHousehold();
    const { sourceId } = await importPlaylist(household, '幂等测试源', 10, SAME_CHANNEL_PLAYLIST, 'op-idem-1');
    const mediaBefore = mediaRows(household.householdId).map((row) => row.id).sort();
    const entriesBefore = entryRows(household.householdId).map((row) => row.id).sort();
    const playbackBefore = playbackIds(household.householdId);

    const job = await reimportExistingSource(household, sourceId, SAME_CHANNEL_PLAYLIST, 'op-idem-2');
    expect(job.status).toBe('succeeded');
    expect(job.counts).toEqual({ added: 0, updated: 4, missing: 0 });
    expect(mediaRows(household.householdId)).toHaveLength(2);
    expect(mediaRows(household.householdId).map((row) => row.id).sort()).toEqual(mediaBefore);
    expect(entryRows(household.householdId).map((row) => row.id).sort()).toEqual(entriesBefore);
    expect(playbackIds(household.householdId)).toEqual(playbackBefore);
  });
});
