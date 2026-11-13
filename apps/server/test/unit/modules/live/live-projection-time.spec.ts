import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { Database } from '@platform/database/database';
import { setEnvOverride } from '@platform/config/env';
import { loadEnv } from '@platform/config/env.schema';
import {
  pickCurrentNext,
  type LiveProgrammeInput,
} from '@contexts/live-tv/domain/live-time';
import { loadLiveChannelWindows } from '@contexts/live-tv/application/live-projection.service';
import { bindLiveTvStore } from '@contexts/live-tv/application/live-tv-store.port';
import { drizzleLiveTvStore } from '@contexts/live-tv/infrastructure/live-tv-store.drizzle';

/**
 * 直播投影时间边界单元测试(T057;005 data-model §8「当前 start<=now<end」、
 * contracts/api.md §2「重叠当前节目选 startsAt 最近、同起点按 key 升序」、
 * research R8「next 取 startsAt>now 的最早项」、spec Edge Cases):
 * - 固定 nowMs 夹具(不依赖系统时钟)覆盖:开始包含/结束不包含、next 最早未来项、
 *   跨午夜节目归属、节目间空档(current=null 不误取相邻)、重叠节目(单一当前,
 *   同起点按 key 升序,同频道不得同时出现两个当前)、无 EPG 频道(current/next=null 频道仍返回);
 * - EPG 同步失败与「成功但无节目」区分:两者对公开直播都表现为该频道 current/next=null,
 *   但频道本身(可用性由来源条目决定)仍返回;频道可用性不由 EPG 是否存在决定;
 * - 手动关联优先、手动失效不回退自动(语义与 epg.service 既有匹配核心一致;
 *   批量核心位于 contexts/live-tv,不含 ProfilePolicy)。
 */

/** 固定 now:2026-06-01T12:00:00.000Z(全部用例锚定,不取 Date.now) */
const NOW_MS = Date.UTC(2026, 5, 1, 12, 0, 0);

function iso(ms: number): string {
  return new Date(ms).toISOString();
}

function programme(
  key: string,
  startMs: number,
  endMs: number,
  overrides: Partial<LiveProgrammeInput> = {},
): LiveProgrammeInput {
  return {
    key,
    title: `节目 ${key}`,
    description: null,
    posterRef: null,
    startsAt: iso(startMs),
    endsAt: iso(endMs),
    ...overrides,
  };
}

interface DbRig {
  dataDir: string;
}

const rigs: DbRig[] = [];

function migrationsDir(): string {
  return path.join(process.cwd(), 'src/platform/database/migrations');
}

function bootstrapRig(): void {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hmp-live-time-'));
  rigs.push({ dataDir });
  setEnvOverride(
    loadEnv({
      NODE_ENV: 'test',
      DATA_DIR: dataDir,
      DB_FILENAME: `${randomUUID()}.hmp.db`,
    }),
  );
  Database.close();
  Database.db.exec(
    'CREATE TABLE IF NOT EXISTS _migrations (name TEXT PRIMARY KEY NOT NULL, applied_at TEXT NOT NULL)',
  );
  const names = fs
    .readdirSync(migrationsDir(), { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
  for (const name of names) {
    const upSql = fs.readFileSync(path.join(migrationsDir(), name, 'up.sql'), 'utf8');
    Database.db.transaction(() => {
      Database.db.exec(upSql);
      Database.db.prepare('INSERT INTO _migrations (name, applied_at) VALUES (?, ?)').run(name, iso(Date.now()));
    })();
  }
  // 008-repository-extraction:rig 绑定 live-tv 仓储 seam(惰性 getDb,单例重开安全;
  // 与 setup.vitest.ts 的 policy 工作进程级绑定互补,本 spec 不经 Nest 装配)
  bindLiveTvStore(drizzleLiveTvStore());
}

afterEach(() => {
  while (rigs.length > 0) {
    const rig = rigs.pop();
    if (rig !== undefined) {
      Database.close();
      fs.rmSync(rig.dataDir, { recursive: true, force: true });
    }
  }
});

/* ------------------------------------------------------------------ */
/* 纯时间核心(pickCurrentNext,不触库)                                  */
/* ------------------------------------------------------------------ */

describe('pickCurrentNext(时间判定核心)', () => {
  it('当前节目满足开始包含、结束不包含(start<=now<end)', () => {
    // now 恰等于开始 → 包含;now 恰等于结束 → 不包含(进入下一档或空档)
    const rows = [programme('a', NOW_MS, NOW_MS + 1_800_000)];
    expect(pickCurrentNext(rows, NOW_MS).current?.key).toBe('a');
    expect(pickCurrentNext(rows, NOW_MS - 1).current).toBeNull();
    expect(pickCurrentNext(rows, NOW_MS + 1_800_000).current).toBeNull();
    expect(pickCurrentNext(rows, NOW_MS + 1_800_000 - 1).current?.key).toBe('a');
  });

  it('下一节目为 startsAt>now 的最早项;正在播出的不是 next', () => {
    const rows = [
      programme('past', NOW_MS - 3_600_000, NOW_MS - 1_800_000),
      programme('airing', NOW_MS - 600_000, NOW_MS + 600_000),
      programme('next1', NOW_MS + 1_800_000, NOW_MS + 3_600_000),
      programme('next2', NOW_MS + 1_800_000 + 1, NOW_MS + 3_600_000 + 1),
    ];
    const picked = pickCurrentNext(rows, NOW_MS);
    expect(picked.current?.key).toBe('airing');
    expect(picked.next?.key).toBe('next1');
  });

  it('空档:current 与 next 均为 null,不误取相邻节目', () => {
    const rows = [
      programme('before', NOW_MS - 3_600_000, NOW_MS - 1_800_000),
      programme('after', NOW_MS + 3_600_000, NOW_MS + 5_400_000),
    ];
    const picked = pickCurrentNext(rows, NOW_MS);
    expect(picked.current).toBeNull();
    expect(picked.next?.key).toBe('after');
    // 连 next 都没有(全部已结束)
    expect(pickCurrentNext([rows[0] as LiveProgrammeInput], NOW_MS).next).toBeNull();
  });

  it('重叠节目:当前取 startsAt 最近者,同一起点按 key 升序,恒只返回一个 current', () => {
    const rows = [
      programme('grid-2000', NOW_MS - 300_000, NOW_MS + 1_500_000), // 20:00 栅格
      programme('extra-2002', NOW_MS - 180_000, NOW_MS + 3_420_000), // 20:02 加播(最近)
      programme('extra-1990', NOW_MS - 600_000, NOW_MS + 1_800_000), // 更早起点的重叠
    ];
    const picked = pickCurrentNext(rows, NOW_MS);
    expect(picked.current?.key).toBe('extra-2002');
    // 同一起点:按 key 升序取第一
    const tied = [
      programme('b', NOW_MS - 60_000, NOW_MS + 600_000),
      programme('a', NOW_MS - 60_000, NOW_MS + 600_000),
    ];
    expect(pickCurrentNext(tied, NOW_MS).current?.key).toBe('a');
    // 恒为单值:结构上不存在「两个当前」
    expect(Object.keys(picked).filter((field) => field === 'current')).toHaveLength(1);
  });

  it('next 同起点并列时按 key 升序取第一', () => {
    const rows = [
      programme('z-next', NOW_MS + 1_800_000, NOW_MS + 3_600_000),
      programme('a-next', NOW_MS + 1_800_000, NOW_MS + 3_600_000),
    ];
    expect(pickCurrentNext(rows, NOW_MS).next?.key).toBe('a-next');
  });

  it('跨午夜节目按 UTC 区间归属:now 落在区间内即为当前,不按日历日截断', () => {
    // 23:45 → 次日 00:15(UTC);now = 次日 00:00 仍属同一条目
    const startMs = Date.UTC(2026, 5, 1, 23, 45, 0);
    const endMs = Date.UTC(2026, 5, 2, 0, 15, 0);
    const rows = [programme('cross-midnight', startMs, endMs)];
    expect(pickCurrentNext(rows, Date.UTC(2026, 5, 1, 23, 44, 59)).current).toBeNull();
    expect(pickCurrentNext(rows, startMs).current?.key).toBe('cross-midnight');
    expect(pickCurrentNext(rows, Date.UTC(2026, 5, 2, 0, 0, 0)).current?.key).toBe('cross-midnight');
    expect(pickCurrentNext(rows, endMs).current).toBeNull();
  });
});

/* ------------------------------------------------------------------ */
/* 批量投影(库内夹具:关联 + 窗口 + 可用性分离)                          */
/* ------------------------------------------------------------------ */

interface ChannelSeed {
  mediaId: string;
  title: string;
  entrySourceId: string;
  entryId: string;
  tvgId: string | undefined;
  present: number;
}

interface RigHandles {
  iptvSourceId: string;
  epgSourceId: string;
  seedChannel: (input: { mediaId?: string; title?: string; tvgId?: string; present?: number }) => ChannelSeed;
  seedProgramme: (input: {
    xmltvChannelId: string;
    key: string;
    startMs: number;
    endMs: number;
    sourceId?: string;
  }) => void;
  seedManualBinding: (input: { mediaId: string; epgSourceId: string | null; xmltvChannelId: string | null }) => void;
  /** 仅注册 EPG 频道标识(无媒体/条目:供手动绑定目标等非频道场景) */
  seedEpgChannelOnly: (tvgId: string) => void;
  setIptvEnabled: (enabled: number) => void;
  setEpgEnabled: (enabled: number) => void;
}

const HOUSEHOLD_ID = 'hh-live-time';

function seedRig(): RigHandles {
  bootstrapRig();
  const db = Database.db;
  const now = iso(NOW_MS - 86_400_000);
  db.prepare(
    "INSERT INTO household (id, name, default_language, timezone, created_at) VALUES (?, '直播夹具', 'zh-CN', 'Asia/Shanghai', ?)",
  ).run(HOUSEHOLD_ID, now);
  db.prepare('INSERT INTO catalog_state (household_id, revision) VALUES (?, 1)').run(HOUSEHOLD_ID);
  db.prepare(
    "INSERT INTO media_source (id, household_id, kind, name, remote_url, root_key, relative_directory, private_access_approved, epg_source_id, enabled, version, last_success_at, last_job_id, created_at, updated_at) VALUES (?, ?, 'epg', 'EPG 源', 'http://epg.fixture/xmltv.xml', NULL, NULL, 1, NULL, 1, 1, NULL, NULL, ?, ?)",
  ).run('src-epg', HOUSEHOLD_ID, now, now);
  db.prepare(
    "INSERT INTO media_source (id, household_id, kind, name, remote_url, root_key, relative_directory, private_access_approved, epg_source_id, enabled, version, last_success_at, last_job_id, created_at, updated_at) VALUES (?, ?, 'iptv', 'IPTV 源', 'http://iptv.fixture/list.m3u', NULL, NULL, 1, 'src-epg', 1, 1, NULL, NULL, ?, ?)",
  ).run('src-iptv', HOUSEHOLD_ID, now, now);
  db.prepare(
    "INSERT INTO account (id, household_id, username, username_normalized, password_hash, role, created_at) VALUES ('acc', ?, 'u', 'u', 'x', 'owner', ?)",
  ).run(HOUSEHOLD_ID, now);
  db.prepare(
    "INSERT INTO media_item (id, household_id, type, title, description, poster_ref, content_level, title_overridden, type_overridden, version, created_at, updated_at) VALUES ('vod-1', ?, 'movie', '点播样例', NULL, NULL, NULL, 0, 0, 1, ?, ?)",
  ).run(HOUSEHOLD_ID, now, now);

  let channelSeq = 0;
  const insertChannel = db.prepare(
    "INSERT INTO media_item (id, household_id, type, title, description, poster_ref, content_level, title_overridden, type_overridden, version, created_at, updated_at) VALUES (?, ?, 'channel', ?, NULL, NULL, NULL, 0, 0, 1, ?, ?)",
  );
  const insertEntry = db.prepare(
    "INSERT INTO source_entry (id, household_id, source_id, identity_kind, identity_digest, media_id, upstream_channel_id, present, last_seen_job_id, first_seen_at, last_seen_at, missing_since, file_size_text, file_mtime_ns, group_title) VALUES (?, ?, 'src-iptv', 'tvg_id', ?, ?, ?, ?, NULL, ?, ?, NULL, NULL, NULL, NULL)",
  );
  const insertPlayback = db.prepare(
    "INSERT INTO playback_source (id, household_id, source_id, source_entry_id, media_item_id, protocol, location, mime_type, priority, requires_proxy, created_at, updated_at) VALUES (?, ?, 'src-iptv', ?, ?, 'http', 'http://stream.fixture/live', NULL, 100, 0, ?, ?)",
  );
  const insertEpgChannel = db.prepare(
    'INSERT INTO epg_channel (household_id, source_id, xmltv_channel_id, display_name, conflicted) VALUES (?, ?, ?, ?, 0)',
  );
  const insertProgrammeRow = db.prepare(
    'INSERT INTO epg_programme (id, household_id, source_id, xmltv_channel_id, title, description, starts_at, ends_at) VALUES (?, ?, ?, ?, ?, NULL, ?, ?)',
  );
  const insertManual = db.prepare(
    "INSERT INTO manual_epg_binding (household_id, media_id, mode, epg_source_id, xmltv_channel_id, version, updated_at) VALUES (?, ?, 'manual', ?, ?, 1, ?)",
  );

  return {
    iptvSourceId: 'src-iptv',
    epgSourceId: 'src-epg',
    seedChannel({ mediaId, title, tvgId, present = 1 }) {
      channelSeq += 1;
      const id = mediaId ?? `ch-${String(channelSeq).padStart(3, '0')}`;
      const name = title ?? `频道 ${channelSeq}`;
      const digest = Array.from({ length: 64 }, () => '0123456789abcdef'[Math.floor(Math.random() * 16)]).join('');
      insertChannel.run(id, HOUSEHOLD_ID, name, now, now);
      insertEntry.run(`ent-${id}`, HOUSEHOLD_ID, digest, id, tvgId, present, now, now);
      if (present === 1) {
        insertPlayback.run(`ps-${id}`, HOUSEHOLD_ID, `ent-${id}`, id, now, now);
      }
      insertEpgChannel.run(HOUSEHOLD_ID, 'src-epg', tvgId, name);
      return { mediaId: id, title: name, entrySourceId: 'src-iptv', entryId: `ent-${id}`, tvgId, present };
    },
    seedProgramme({ xmltvChannelId, key, startMs, endMs, sourceId = 'src-epg' }) {
      insertProgrammeRow.run(key, HOUSEHOLD_ID, sourceId, xmltvChannelId, `节目 ${key}`, iso(startMs), iso(endMs));
    },
    seedManualBinding({ mediaId, epgSourceId, xmltvChannelId }) {
      insertManual.run(HOUSEHOLD_ID, mediaId, epgSourceId, xmltvChannelId, now);
    },
    seedEpgChannelOnly(tvgId) {
      insertEpgChannel.run(HOUSEHOLD_ID, 'src-epg', tvgId, tvgId);
    },
    setIptvEnabled(enabled) {
      db.prepare('UPDATE media_source SET enabled = ? WHERE id = ?').run(enabled, 'src-iptv');
    },
    setEpgEnabled(enabled) {
      db.prepare('UPDATE media_source SET enabled = ? WHERE id = ?').run(enabled, 'src-epg');
    },
  };
}

describe('loadLiveChannelWindows(批量投影时间边界)', () => {
  it('当前/下一节目按固定 now 判定;无 EPG 频道 current/next=null 但频道仍返回;可用性与 EPG 存在分离', () => {
    const rig = seedRig();
    const withEpg = rig.seedChannel({ mediaId: 'ch-epg', title: '有节目频道', tvgId: 'tvg-epg' });
    rig.seedProgramme({ xmltvChannelId: 'tvg-epg', key: 'p-0', startMs: NOW_MS - 600_000, endMs: NOW_MS + 600_000 });
    rig.seedProgramme({ xmltvChannelId: 'tvg-epg', key: 'p-1', startMs: NOW_MS + 600_000, endMs: NOW_MS + 1_200_000 });
    rig.seedProgramme({ xmltvChannelId: 'tvg-epg', key: 'p-2', startMs: NOW_MS + 900_000, endMs: NOW_MS + 1_500_000 });
    const withoutEpg = rig.seedChannel({ mediaId: 'ch-bare', title: '无节目频道', tvgId: 'tvg-bare' });
    // 无 EPG 频道:注册了 xmltv 标识但 EPG 发布无任何节目行(成功同步但无节目)

    const windows = loadLiveChannelWindows(HOUSEHOLD_ID, NOW_MS);
    const byId = new Map(windows.map((row) => [row.mediaId, row]));

    const epgRow = byId.get('ch-epg');
    expect(epgRow).toBeDefined();
    expect(epgRow?.current?.title).toBe('节目 p-0');
    expect(epgRow?.next?.title).toBe('节目 p-1'); // 最早未来项,非 p-2
    const bareRow = byId.get('ch-bare');
    expect(bareRow).toBeDefined();
    expect(bareRow?.current).toBeNull();
    expect(bareRow?.next).toBeNull();
    // 可用性与节目有无分离:两个频道都返回(不可用性不由 EPG 决定)
    expect(windows.map((row) => row.mediaId).sort()).toEqual(['ch-bare', 'ch-epg']);
    expect(withEpg.mediaId).toBe('ch-epg');
    expect(withoutEpg.mediaId).toBe('ch-bare');
  });

  it('节目间空档:current=null 不误取相邻节目;next 仍为最早未来项', () => {
    const rig = seedRig();
    const channel = rig.seedChannel({ mediaId: 'ch-gap', tvgId: 'tvg-gap' });
    rig.seedProgramme({ xmltvChannelId: 'tvg-gap', key: 'g-0', startMs: NOW_MS - 3_600_000, endMs: NOW_MS - 600_000 });
    rig.seedProgramme({ xmltvChannelId: 'tvg-gap', key: 'g-1', startMs: NOW_MS + 600_000, endMs: NOW_MS + 1_200_000 });

    const row = loadLiveChannelWindows(HOUSEHOLD_ID, NOW_MS).find((item) => item.mediaId === channel.mediaId);
    expect(row?.current).toBeNull();
    expect(row?.next?.title).toBe('节目 g-1');
  });

  it('重叠节目:同一频道只出现一个当前(startsAt 最近;同起点 key 升序)', () => {
    const rig = seedRig();
    const channel = rig.seedChannel({ mediaId: 'ch-overlap', tvgId: 'tvg-overlap' });
    rig.seedProgramme({ xmltvChannelId: 'tvg-overlap', key: 'grid-2000', startMs: NOW_MS - 300_000, endMs: NOW_MS + 1_500_000 });
    rig.seedProgramme({ xmltvChannelId: 'tvg-overlap', key: 'extra-2002', startMs: NOW_MS - 180_000, endMs: NOW_MS + 3_420_000 });
    rig.seedProgramme({ xmltvChannelId: 'tvg-overlap', key: 'extra-old', startMs: NOW_MS - 600_000, endMs: NOW_MS + 1_800_000 });
    rig.seedProgramme({ xmltvChannelId: 'tvg-overlap', key: 'future-1', startMs: NOW_MS + 600_000, endMs: NOW_MS + 1_200_000 });
    rig.seedProgramme({ xmltvChannelId: 'tvg-overlap', key: 'future-2', startMs: NOW_MS + 900_000, endMs: NOW_MS + 1_500_000 });

    const row = loadLiveChannelWindows(HOUSEHOLD_ID, NOW_MS).find((item) => item.mediaId === channel.mediaId);
    expect(row?.current?.title).toBe('节目 extra-2002');
    expect(row?.next?.title).toBe('节目 future-1'); // 下一节目按最早未来起点,非 future-2
  });

  it('手动关联优先于自动;手动失效(目标缺失/来源禁用)不回退自动,current/next=null 但频道仍在', () => {
    const rig = seedRig();
    // 自动关联可用(tvg-auto 在 EPG 有节目)
    const autoChannel = rig.seedChannel({ mediaId: 'ch-auto', title: '自动关联频道', tvgId: 'tvg-auto' });
    rig.seedProgramme({ xmltvChannelId: 'tvg-auto', key: 'a-0', startMs: NOW_MS - 600_000, endMs: NOW_MS + 600_000 });
    // 手动指向无效目标(频道缺失)→ invalid,不回退自动(该频道自身 tvg 也有节目也不采用)
    const brokenManual = rig.seedChannel({ mediaId: 'ch-manual-broken', title: '手动失效频道', tvgId: 'tvg-manual-broken' });
    rig.seedProgramme({ xmltvChannelId: 'tvg-manual-broken', key: 'm-0', startMs: NOW_MS - 600_000, endMs: NOW_MS + 600_000 });
    rig.seedManualBinding({ mediaId: 'ch-manual-broken', epgSourceId: 'src-epg', xmltvChannelId: 'tvg-missing' });
    // 手动有效:即使自动标识完全不同也以手动为准
    const manualChannel = rig.seedChannel({ mediaId: 'ch-manual-ok', title: '手动有效频道', tvgId: 'tvg-manual-self' });
    rig.seedEpgChannelOnly('tvg-manual-target');
    rig.seedProgramme({ xmltvChannelId: 'tvg-manual-target', key: 't-0', startMs: NOW_MS - 600_000, endMs: NOW_MS + 600_000 });
    rig.seedManualBinding({ mediaId: 'ch-manual-ok', epgSourceId: 'src-epg', xmltvChannelId: 'tvg-manual-target' });

    const rows = loadLiveChannelWindows(HOUSEHOLD_ID, NOW_MS);
    const byId = new Map(rows.map((row) => [row.mediaId, row]));
    expect(byId.get(autoChannel.mediaId)?.current?.title).toBe('节目 a-0');
    expect(byId.get(brokenManual.mediaId)?.current).toBeNull();
    expect(byId.get(brokenManual.mediaId)?.next).toBeNull();
    expect(byId.get(manualChannel.mediaId)?.current?.title).toBe('节目 t-0');
  });

  it('EPG 来源被禁用(同步失败/断开)后关联失效:current/next=null,频道可用性不变仍返回', () => {
    const rig = seedRig();
    const channel = rig.seedChannel({ mediaId: 'ch-epg-off', tvgId: 'tvg-epg-off' });
    rig.seedProgramme({ xmltvChannelId: 'tvg-epg-off', key: 'e-0', startMs: NOW_MS - 600_000, endMs: NOW_MS + 600_000 });
    rig.setEpgEnabled(0);

    const row = loadLiveChannelWindows(HOUSEHOLD_ID, NOW_MS).find((item) => item.mediaId === channel.mediaId);
    expect(row).toBeDefined();
    expect(row?.current).toBeNull();
    expect(row?.next).toBeNull();
  });

  it('来源条目 present=0(不可用)的频道不进入投影;可用性与节目窗口无关', () => {
    const rig = seedRig();
    rig.seedChannel({ mediaId: 'ch-gone', title: '失效频道', tvgId: 'tvg-gone', present: 0 });
    rig.seedProgramme({ xmltvChannelId: 'tvg-gone', key: 'gone-0', startMs: NOW_MS - 600_000, endMs: NOW_MS + 600_000 });
    const kept = rig.seedChannel({ mediaId: 'ch-kept', tvgId: 'tvg-kept' });
    rig.seedProgramme({ xmltvChannelId: 'tvg-kept', key: 'k-0', startMs: NOW_MS - 600_000, endMs: NOW_MS + 600_000 });

    const rows = loadLiveChannelWindows(HOUSEHOLD_ID, NOW_MS);
    expect(rows.map((row) => row.mediaId)).toEqual([kept.mediaId]);
  });
});
