import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { Database } from '@platform/database/database';
import { setEnvOverride } from '@platform/config/env';
import { loadEnv } from '@platform/config/env.schema';
import { bindLiveTvStore } from '@contexts/live-tv/application/live-tv-store.port';
import { drizzleLiveTvStore } from '@contexts/live-tv/infrastructure/live-tv-store.drizzle';
import {
  adjudicateCascade,
  buildAliasIndex,
  buildAssociationCandidates,
  loadChannelAssociationCore,
  loadLiveChannelWindows,
  type CascadeCandidateInput,
} from '@contexts/live-tv/application/live-projection.service';
import type { EpgChannelRow, ManualEpgBindingRow, MediaSourceRow, SourceEntryRow } from '@contexts/live-tv/application/live-tv-store.port';
import { normalizeChannelName } from '@contexts/live-tv/domain/channel-normalizer';

/** 关联对键(与 live-projection 私有 pairKeyOf 同构:source_id + \u0000 + xmltv_channel_id) */
function pairKeyOf(sourceId: string, xmltvChannelId: string): string {
  return `${sourceId}\u0000${xmltvChannelId}`;
}

/**
 * 五级级联 EPG 解析单元测试(T012;016 research R2 判定链 / data-model §2.3/§3.2 / FR-003):
 * - L1 manual 锁定优先(ADR-0008):绑定有效 → 唯一 manual 候选(终态,不叠加/不比较自动);
 *   绑定失效(source_disabled/channel_missing/channel_conflict)→ 候选为空、裁决 none,
 *   **绝不回退 L2~L4**(失效是配置事实,T015 投影路径停链钉子);
 * - L2 precise:IPTV 默认关联源 tvg-id 精确命中且有排期;conflicted=1 不算命中(既有语义);
 * - L3 cascade:L2 未命中或排期空 → 启用 EPG 源按 priority ASC(同 priority 按 id 升序)
 *   逐源 tvg-id 精确补位,epgSourceId=命中源;
 * - L4 alias:tvg 全未命中 → normalizeChannelName 频道名/EPG 显示名归一化键内存比对;
 * - L5 none:全落空 → null(频道仍返回,current/next=null);
 * - 防 N+1:候选集全部来自固定次数集合装载,裁决在内存完成(纯函数直测,无逐频道查询)。
 *
 * 结构:纯核心(buildAssociationCandidates/adjudicateCascade,内存夹具)+
 * 库内集成(loadChannelAssociationCore/loadLiveChannelWindows,权威迁移 rig,
 * 钉住 priority 列真实排序与投影 matchMode/epgSourceId 字段)。
 */

/* ------------------------------------------------------------------ */
/* 纯核心夹具                                                          */
/* ------------------------------------------------------------------ */

function epgSource(id: string, priority = 100, enabled = 1): MediaSourceRow {
  return { id, kind: 'epg', enabled, epgSourceId: null, priority };
}

function iptvSource(id: string, epgSourceId: string | null, enabled = 1): MediaSourceRow {
  return { id, kind: 'iptv', enabled, epgSourceId, priority: 100 };
}

function chan(sourceId: string, xmltvChannelId: string, conflicted = 0): EpgChannelRow {
  return { sourceId, xmltvChannelId, conflicted, displayName: `${xmltvChannelId} 显示名` };
}

function entry(sourceId: string, entryId: string, upstreamChannelId: string | null): SourceEntryRow {
  return { sourceId, entryId, mediaId: 'ch-1', upstreamChannelId, groupTitle: null };
}

function manualOf(epgSourceId: string, xmltvChannelId: string): ManualEpgBindingRow {
  return { mediaId: 'ch-1', epgSourceId, xmltvChannelId };
}

function inputOf(overrides: Partial<CascadeCandidateInput> = {}): CascadeCandidateInput {
  return {
    channelTitle: '频道甲',
    manual: undefined,
    entries: [],
    sourceById: new Map(),
    epgChannelByKey: new Map(),
    epgSourcesOrdered: [],
    aliasIndex: [],
    ...overrides,
  };
}

function sourceMapOf(...rows: MediaSourceRow[]): Map<string, MediaSourceRow> {
  return new Map(rows.map((row) => [row.id, row] as const));
}

describe('buildAssociationCandidates(级联候选构建,纯函数)', () => {
  it('L1 manual 优先:绑定有效 → 唯一 manual 候选,不产出 precise/cascade/alias 候选', () => {
    const srcManual = epgSource('src-manual', 10);
    const srcAuto = epgSource('src-auto', 20);
    const candidates = buildAssociationCandidates(
      inputOf({
        manual: manualOf('src-manual', 'alt-1'),
        entries: [entry('src-iptv', 'e1', 'cctv-1')],
        sourceById: sourceMapOf(srcManual, srcAuto, iptvSource('src-iptv', 'src-auto')),
        epgChannelByKey: new Map([
          [pairKeyOf('src-manual', 'alt-1'), chan('src-manual', 'alt-1')],
          [pairKeyOf('src-auto', 'cctv-1'), chan('src-auto', 'cctv-1')],
        ]),
        epgSourcesOrdered: [srcManual, srcAuto],
      }),
    );
    expect(candidates).toEqual([{ sourceId: 'src-manual', xmltvChannelId: 'alt-1', matchMode: 'manual' }]);
  });

  it('L1 manual 终态:裁决忽略排期判定,绑定目标无排期也保持 manual(不回退自动源)', () => {
    const candidates = [{ sourceId: 'src-manual', xmltvChannelId: 'alt-1', matchMode: 'manual' as const }];
    // 全部关联对都无排期,manual 仍是裁决结果(无节目 ≠ 失效,ADR-0008 语义)
    expect(adjudicateCascade(candidates, () => false)).toEqual({
      pairKey: pairKeyOf('src-manual', 'alt-1'),
      matchMode: 'manual',
      epgSourceId: 'src-manual',
    });
  });

  it('L1 manual 失效(源禁用)→ 候选为空且裁决 none:次源 cascade/alias 可命中也绝不回退', () => {
    const srcDisabled = epgSource('src-manual', 10, 0); // 绑定目标源已禁用
    const srcOther = epgSource('src-other', 20);
    const candidates = buildAssociationCandidates(
      inputOf({
        manual: manualOf('src-manual', 'alt-1'),
        entries: [entry('src-iptv', 'e1', 'cctv-1')],
        sourceById: sourceMapOf(srcDisabled, srcOther, iptvSource('src-iptv', 'src-other')),
        epgChannelByKey: new Map([
          [pairKeyOf('src-manual', 'alt-1'), chan('src-manual', 'alt-1')],
          [pairKeyOf('src-other', 'cctv-1'), chan('src-other', 'cctv-1')],
        ]),
        epgSourcesOrdered: [srcOther],
        aliasIndex: [{ sourceId: 'src-other', byKey: new Map([['频道甲', 'cctv-1']]) }],
      }),
    );
    // 手动失效是配置事实:候选为空,L2~L4 全部不进入(T015 投影路径停链)
    expect(candidates).toEqual([]);
    expect(adjudicateCascade(candidates, () => true)).toEqual({ pairKey: null, matchMode: 'none', epgSourceId: null });
  });

  it('L1 manual 失效(目标频道缺失/conflicted=1)→ 同样空候选不回退(与绑定状态派生同因)', () => {
    const srcManual = epgSource('src-manual', 10);
    // channel_missing:目标行不存在
    const missing = buildAssociationCandidates(
      inputOf({
        manual: manualOf('src-manual', 'alt-404'),
        sourceById: sourceMapOf(srcManual),
        epgChannelByKey: new Map([[pairKeyOf('src-manual', 'alt-1'), chan('src-manual', 'alt-1')]]),
        epgSourcesOrdered: [srcManual],
      }),
    );
    expect(missing).toEqual([]);
    // channel_conflict:目标行 conflicted=1
    const conflicted = buildAssociationCandidates(
      inputOf({
        manual: manualOf('src-manual', 'alt-conflict'),
        sourceById: sourceMapOf(srcManual),
        epgChannelByKey: new Map([[pairKeyOf('src-manual', 'alt-conflict'), chan('src-manual', 'alt-conflict', 1)]]),
        epgSourcesOrdered: [srcManual],
      }),
    );
    expect(conflicted).toEqual([]);
  });

  it('L2 precise:IPTV 默认关联源 tvg-id 精确命中且有排期 → precise,epgSourceId=关联源', () => {
    const srcA = epgSource('src-a', 10);
    const candidates = buildAssociationCandidates(
      inputOf({
        entries: [entry('src-iptv', 'e1', 'cctv-1')],
        sourceById: sourceMapOf(srcA, iptvSource('src-iptv', 'src-a')),
        epgChannelByKey: new Map([[pairKeyOf('src-a', 'cctv-1'), chan('src-a', 'cctv-1')]]),
        epgSourcesOrdered: [srcA],
      }),
    );
    expect(candidates[0]).toEqual({ sourceId: 'src-a', xmltvChannelId: 'cctv-1', matchMode: 'precise' });
    expect(adjudicateCascade(candidates, (pairKey) => pairKey === pairKeyOf('src-a', 'cctv-1'))).toEqual({
      pairKey: pairKeyOf('src-a', 'cctv-1'),
      matchMode: 'precise',
      epgSourceId: 'src-a',
    });
  });

  it('L2 不命中形态:conflicted=1 / 无 upstream / 来源链禁用均不产出 precise 候选(既有语义逐字)', () => {
    const srcA = epgSource('src-a', 10);
    const base = { sourceById: sourceMapOf(srcA, iptvSource('src-iptv', 'src-a')), epgSourcesOrdered: [srcA] };
    expect(
      buildAssociationCandidates(
        inputOf({ ...base, epgChannelByKey: new Map([[pairKeyOf('src-a', 'cctv-1'), chan('src-a', 'cctv-1', 1)]]) }),
      ),
    ).toEqual([]); // 冲突频道不是精确命中
    expect(buildAssociationCandidates(inputOf({ ...base, entries: [entry('src-iptv', 'e1', null)] }))).toEqual([]);
    expect(
      buildAssociationCandidates(
        inputOf({
          ...base,
          sourceById: sourceMapOf(srcA, iptvSource('src-iptv', 'src-a', 0)),
          entries: [entry('src-iptv', 'e1', 'cctv-1')],
        }),
      ),
    ).toEqual([]); // IPTV 源禁用
  });

  it('L3 cascade:L2 命中但排期空 → priority ASC 次源补位,epgSourceId=次源(主缺次补核心场景)', () => {
    const srcA = epgSource('src-a', 10); // 主源(priority 数值小)
    const srcB = epgSource('src-b', 20); // 备源
    const candidates = buildAssociationCandidates(
      inputOf({
        entries: [entry('src-iptv', 'e1', 'cctv-1')],
        sourceById: sourceMapOf(srcA, srcB, iptvSource('src-iptv', 'src-a')),
        epgChannelByKey: new Map([
          [pairKeyOf('src-a', 'cctv-1'), chan('src-a', 'cctv-1')],
          [pairKeyOf('src-b', 'cctv-1'), chan('src-b', 'cctv-1')],
        ]),
        epgSourcesOrdered: [srcA, srcB],
      }),
    );
    // 候选顺序:precise → cascade(主) → cascade(备);主源排期空由裁决跳过
    expect(candidates).toEqual([
      { sourceId: 'src-a', xmltvChannelId: 'cctv-1', matchMode: 'precise' },
      { sourceId: 'src-b', xmltvChannelId: 'cctv-1', matchMode: 'cascade' },
    ]);
    expect(
      adjudicateCascade(candidates, (pairKey) => pairKey === pairKeyOf('src-b', 'cctv-1')),
    ).toEqual({ pairKey: pairKeyOf('src-b', 'cctv-1'), matchMode: 'cascade', epgSourceId: 'src-b' });
  });

  it('L3 cascade 去重:级联命中与 precise 同对时不再重复产出(候选首对即裁决优先)', () => {
    const srcA = epgSource('src-a', 10);
    const srcB = epgSource('src-b', 20);
    const candidates = buildAssociationCandidates(
      inputOf({
        entries: [entry('src-iptv', 'e1', 'cctv-1')],
        sourceById: sourceMapOf(srcA, srcB, iptvSource('src-iptv', 'src-a')),
        epgChannelByKey: new Map([[pairKeyOf('src-a', 'cctv-1'), chan('src-a', 'cctv-1')]]),
        epgSourcesOrdered: [srcA, srcB],
      }),
    );
    expect(candidates).toEqual([{ sourceId: 'src-a', xmltvChannelId: 'cctv-1', matchMode: 'precise' }]);
  });

  it('L4 alias:tvg 全未命中 → normalizeChannelName 归一化键命中(去后缀/括注),别名候选按源优先级序', () => {
    const srcA = epgSource('src-a', 10);
    const srcB = epgSource('src-b', 20);
    const channelTitle = 'CCTV-1 综合 [4K] [IPv6]';
    const aliasKey = normalizeChannelName(channelTitle);
    expect(aliasKey).toBe(normalizeChannelName('CCTV-1 综合')); // 噪音后缀清洗后同键
    const candidates = buildAssociationCandidates(
      inputOf({
        channelTitle,
        entries: [entry('src-iptv', 'e1', 'tvg-unknown')],
        sourceById: sourceMapOf(srcA, srcB, iptvSource('src-iptv', 'src-a')),
        epgChannelByKey: new Map([
          [pairKeyOf('src-a', 'epg-a-ch'), chan('src-a', 'epg-a-ch')],
          [pairKeyOf('src-b', 'epg-b-ch'), chan('src-b', 'epg-b-ch')],
        ]),
        epgSourcesOrdered: [srcA, srcB],
        aliasIndex: [
          { sourceId: 'src-a', byKey: new Map([[aliasKey, 'epg-a-ch']]) },
          { sourceId: 'src-b', byKey: new Map([[aliasKey, 'epg-b-ch']]) },
        ],
      }),
    );
    expect(candidates).toEqual([
      { sourceId: 'src-a', xmltvChannelId: 'epg-a-ch', matchMode: 'alias' },
      { sourceId: 'src-b', xmltvChannelId: 'epg-b-ch', matchMode: 'alias' },
    ]);
    expect(
      adjudicateCascade(candidates, (pairKey) => pairKey === pairKeyOf('src-b', 'epg-b-ch')),
    ).toEqual({ pairKey: pairKeyOf('src-b', 'epg-b-ch'), matchMode: 'alias', epgSourceId: 'src-b' });
  });

  it('L5 none:无 manual/无条目/无 EPG 行 → 空候选裁决 none;候选全无排期同为 none', () => {
    expect(adjudicateCascade([], () => true)).toEqual({ pairKey: null, matchMode: 'none', epgSourceId: null });
    const candidates = buildAssociationCandidates(inputOf({}));
    expect(candidates).toEqual([]);
    expect(adjudicateCascade([{ sourceId: 's', xmltvChannelId: 'c', matchMode: 'cascade' }], () => false)).toEqual({
      pairKey: null,
      matchMode: 'none',
      epgSourceId: null,
    });
  });
});

describe('buildAliasIndex(别名索引,纯函数)', () => {
  it('仅收录启用 EPG 源的非冲突频道;归一化键为空串不收录;同源同键取 xmltvChannelId 升序首个', () => {
    const srcA = epgSource('src-a', 10);
    const srcOff = epgSource('src-off', 20, 0);
    const index = buildAliasIndex(
      [
        { sourceId: 'src-a', xmltvChannelId: 'b-ch', conflicted: 0, displayName: '央视新闻' },
        { sourceId: 'src-a', xmltvChannelId: 'a-ch', conflicted: 0, displayName: '央视新闻' },
        { sourceId: 'src-a', xmltvChannelId: 'x-ch', conflicted: 1, displayName: '冲突台' },
        { sourceId: 'src-off', xmltvChannelId: 'off-ch', conflicted: 0, displayName: '停用台' },
        { sourceId: 'src-a', xmltvChannelId: 'noise-ch', conflicted: 0, displayName: '[4K]' }, // 归一化后空串
      ],
      sourceMapOf(srcA, srcOff),
      [srcA],
    );
    expect(index).toEqual([{ sourceId: 'src-a', byKey: new Map([['央视新闻', 'a-ch']]) }]);
  });
});

/* ------------------------------------------------------------------ */
/* 库内集成(rig:权威迁移全量 + live-tv 仓储 seam)                       */
/* ------------------------------------------------------------------ */

const NOW_MS = Date.UTC(2026, 5, 1, 12, 0, 0);
const HOUR = 3_600_000;

interface DbRig {
  dataDir: string;
}

const rigs: DbRig[] = [];

function bootstrapRig(): void {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hmp-cascade-'));
  rigs.push({ dataDir });
  setEnvOverride(loadEnv({ NODE_ENV: 'test', DATA_DIR: dataDir, DB_FILENAME: `${randomUUID()}.hmp.db` }));
  Database.close();
  Database.db.exec('CREATE TABLE IF NOT EXISTS _migrations (name TEXT PRIMARY KEY NOT NULL, applied_at TEXT NOT NULL)');
  const migrationsDir = path.join(process.cwd(), 'src/platform/database/migrations');
  const names = fs
    .readdirSync(migrationsDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
  for (const name of names) {
    Database.db.transaction(() => {
      Database.db.exec(fs.readFileSync(path.join(migrationsDir, name, 'up.sql'), 'utf8'));
      Database.db.prepare('INSERT INTO _migrations (name, applied_at) VALUES (?, ?)').run(name, new Date().toISOString());
    })();
  }
  bindLiveTvStore(drizzleLiveTvStore());
}

afterEach(() => {
  while (rigs.length > 0) {
    const rig = rigs.pop();
    if (rig === undefined) {
      break;
    }
    Database.close();
    setEnvOverride(null);
    fs.rmSync(rig.dataDir, { recursive: true, force: true });
  }
});

const HOUSEHOLD_ID = 'hh-cascade';

/** 级联场景 rig:epg-a(prio 10)/epg-b(prio 20)/iptv(默认关联 epg-a) */
function seedCascadeRig(): void {
  bootstrapRig();
  const db = Database.db;
  const now = new Date(NOW_MS - 86_400_000).toISOString();
  db.prepare(
    "INSERT INTO household (id, name, default_language, timezone, created_at) VALUES (?, '级联夹具', 'zh-CN', 'Asia/Shanghai', ?)",
  ).run(HOUSEHOLD_ID, now);
  db.prepare('INSERT INTO catalog_state (household_id, revision) VALUES (?, 1)').run(HOUSEHOLD_ID);
  const insertSource = db.prepare(
    "INSERT INTO media_source (id, household_id, kind, name, remote_url, root_key, relative_directory, private_access_approved, epg_source_id, enabled, version, last_success_at, last_job_id, priority, created_at, updated_at) VALUES (?, ?, ?, ?, 'http://fixture.example/guide', NULL, NULL, 1, ?, 1, 1, ?, NULL, ?, ?, ?)",
  );
  insertSource.run('epg-a', HOUSEHOLD_ID, 'epg', '主指南', null, now, 10, now, now);
  insertSource.run('epg-b', HOUSEHOLD_ID, 'epg', '备指南', null, now, 20, now, now);
  insertSource.run('src-iptv', HOUSEHOLD_ID, 'iptv', '受控IPTV', 'epg-a', now, 100, now, now);

  const insertChannel = db.prepare(
    "INSERT INTO media_item (id, household_id, type, title, description, poster_ref, content_level, title_overridden, type_overridden, version, created_at, updated_at) VALUES (?, ?, 'channel', ?, NULL, NULL, 0, 0, 0, 1, ?, ?)",
  );
  const insertEntry = db.prepare(
    "INSERT INTO source_entry (id, household_id, source_id, identity_kind, identity_digest, media_id, upstream_channel_id, present, last_seen_job_id, first_seen_at, last_seen_at, missing_since, file_size_text, file_mtime_ns, group_title) VALUES (?, ?, 'src-iptv', 'tvg_id', ?, ?, ?, 1, NULL, ?, ?, NULL, NULL, NULL, NULL)",
  );
  const insertPlayback = db.prepare(
    "INSERT INTO playback_source (id, household_id, source_id, source_entry_id, media_item_id, protocol, location, mime_type, priority, requires_proxy, created_at, updated_at) VALUES (?, ?, 'src-iptv', ?, ?, 'http', 'http://stream.fixture/live', NULL, 100, 0, ?, ?)",
  );
  const insertEpgChannel = db.prepare(
    'INSERT INTO epg_channel (household_id, source_id, xmltv_channel_id, display_name, conflicted) VALUES (?, ?, ?, ?, ?)',
  );
  const insertProgramme = db.prepare(
    'INSERT INTO epg_programme (id, household_id, source_id, xmltv_channel_id, title, description, starts_at, ends_at) VALUES (?, ?, ?, ?, ?, NULL, ?, ?)',
  );
  const insertManual = db.prepare(
    "INSERT INTO manual_epg_binding (household_id, media_id, mode, epg_source_id, xmltv_channel_id, version, updated_at) VALUES (?, ?, 'manual', ?, ?, 1, ?)",
  );

  (seedCascadeRig as unknown as { helpers: unknown }).helpers = {
    /** 频道 + present 条目 + 播放资源(可用性链);tvgId 允许 null(纯无关联场景) */
    channel(mediaId: string, title: string, tvgId: string | null): void {
      insertChannel.run(mediaId, HOUSEHOLD_ID, title, now, now);
      const digest = createHash('sha256').update(`tvg_id:src-iptv:${mediaId}`).digest('hex');
      insertEntry.run(`ent-${mediaId}`, HOUSEHOLD_ID, digest, mediaId, tvgId, now, now);
      insertPlayback.run(`ps-${mediaId}`, HOUSEHOLD_ID, `ent-${mediaId}`, mediaId, now, now);
    },
    epgChannel(sourceId: string, tvgId: string, displayName: string, conflicted = 0): void {
      insertEpgChannel.run(HOUSEHOLD_ID, sourceId, tvgId, displayName, conflicted);
    },
    programme(sourceId: string, tvgId: string, key: string, startMs: number, endMs: number): void {
      insertProgramme.run(key, HOUSEHOLD_ID, sourceId, tvgId, `节目 ${key}`, new Date(startMs).toISOString(), new Date(endMs).toISOString());
    },
    manual(mediaId: string, epgSourceId: string, xmltvChannelId: string): void {
      insertManual.run(HOUSEHOLD_ID, mediaId, epgSourceId, xmltvChannelId, now);
    },
    setSourceEnabled(sourceId: string, enabled: number): void {
      db.prepare('UPDATE media_source SET enabled = ? WHERE id = ?').run(enabled, sourceId);
    },
  };
}

function cascadeHelpers(): {
  channel: (mediaId: string, title: string, tvgId: string | null) => void;
  epgChannel: (sourceId: string, tvgId: string, displayName: string, conflicted?: number) => void;
  programme: (sourceId: string, tvgId: string, key: string, startMs: number, endMs: number) => void;
  manual: (mediaId: string, epgSourceId: string, xmltvChannelId: string) => void;
  setSourceEnabled: (sourceId: string, enabled: number) => void;
} {
  return (seedCascadeRig as unknown as { helpers: ReturnType<typeof cascadeHelpers> }).helpers;
}

function projectionOf(mediaId: string): ReturnType<typeof loadLiveChannelWindows>[number] {
  const rows = loadLiveChannelWindows(HOUSEHOLD_ID, NOW_MS);
  const row = rows.find((item) => item.mediaId === mediaId);
  expect(row, `频道 ${mediaId} 应在投影中(可用性与 EPG 命中分离)`).toBeDefined();
  return row as ReturnType<typeof loadLiveChannelWindows>[number];
}

describe('loadLiveChannelWindows 五级级联集成(库内 rig)', () => {
  it('L2 单源精确:matchMode=precise,epgSourceId=关联源(单源场景与现状一致,零回归)', () => {
    seedCascadeRig();
    const h = cascadeHelpers();
    h.channel('ch-precise', '精确台', 'tvg-1');
    h.epgChannel('epg-a', 'tvg-1', '精确台');
    h.programme('epg-a', 'tvg-1', 'p-now', NOW_MS - 600_000, NOW_MS + 600_000);
    h.programme('epg-a', 'tvg-1', 'p-next', NOW_MS + 600_000, NOW_MS + 2 * HOUR);

    const row = projectionOf('ch-precise');
    expect(row.current?.title).toBe('节目 p-now');
    expect(row.next?.title).toBe('节目 p-next');
    expect(row.matchMode).toBe('precise');
    expect(row.epgSourceId).toBe('epg-a');
    // 关联核心向后兼容面:associationByMedia 仍是精确关联对(guide/publish 消费方语义不变)
    const core = loadChannelAssociationCore(HOUSEHOLD_ID);
    expect(core.associationByMedia.get('ch-precise')).toBe(pairKeyOf('epg-a', 'tvg-1'));
    expect(core.candidatesByMedia.get('ch-precise')).toEqual([
      { sourceId: 'epg-a', xmltvChannelId: 'tvg-1', matchMode: 'precise' },
    ]);
  });

  it('L3 主源缺失 → 备源补位:matchMode=cascade,epgSourceId=备源,current 非空(US2 验收 1)', () => {
    seedCascadeRig();
    const h = cascadeHelpers();
    h.channel('ch-cascade', '补位台', 'tvg-2'); // 主源 epg-a 无 tvg-2 频道行
    h.epgChannel('epg-b', 'tvg-2', '补位台');
    h.programme('epg-b', 'tvg-2', 'b-now', NOW_MS - 600_000, NOW_MS + 600_000);
    h.programme('epg-b', 'tvg-2', 'b-next', NOW_MS + 600_000, NOW_MS + 2 * HOUR);

    const row = projectionOf('ch-cascade');
    expect(row.current?.title).toBe('节目 b-now');
    expect(row.matchMode).toBe('cascade');
    expect(row.epgSourceId).toBe('epg-b');
    // 关联面兼容:associationByMedia 仍为 null(精确关联视角主源无行;级联属投影增强)
    const core = loadChannelAssociationCore(HOUSEHOLD_ID);
    expect(core.associationByMedia.get('ch-cascade')).toBeNull();
    expect(core.candidatesByMedia.get('ch-cascade')).toEqual([
      { sourceId: 'epg-b', xmltvChannelId: 'tvg-2', matchMode: 'cascade' },
    ]);
  });

  it('L3 同 priority 源按 id 升序稳定遍历:前者有排期 → 命中前者', () => {
    seedCascadeRig();
    const h = cascadeHelpers();
    // tie-1(id 升序在前)与 tie-2 同 priority 50,均含 tvg-3 频道行且均有排期
    const insertSource = Database.db.prepare(
      "INSERT INTO media_source (id, household_id, kind, name, remote_url, root_key, relative_directory, private_access_approved, epg_source_id, enabled, version, last_success_at, last_job_id, priority, created_at, updated_at) VALUES (?, ?, 'epg', ?, 'http://fixture.example/guide', NULL, NULL, 1, NULL, 1, 1, ?, NULL, 50, ?, ?)",
    );
    const now = new Date(NOW_MS - 86_400_000).toISOString();
    insertSource.run('epg-tie1', HOUSEHOLD_ID, '平级指南甲', now, now, now);
    insertSource.run('epg-tie2', HOUSEHOLD_ID, '平级指南乙', now, now, now);
    h.channel('ch-tie', '平级台', 'tvg-3');
    h.epgChannel('epg-tie1', 'tvg-3', '平级台');
    h.epgChannel('epg-tie2', 'tvg-3', '平级台');
    h.programme('epg-tie1', 'tvg-3', 'tie1-now', NOW_MS - 600_000, NOW_MS + 600_000);
    h.programme('epg-tie2', 'tvg-3', 'tie2-now', NOW_MS - 300_000, NOW_MS + 900_000);

    const row = projectionOf('ch-tie');
    expect(row.matchMode).toBe('cascade');
    expect(row.epgSourceId).toBe('epg-tie1'); // id 升序:tie-1 稳定胜出
    expect(row.current?.title).toBe('节目 tie1-now');
  });

  it('L4 alias:tvg 全未命中 → 频道名归一化命中 EPG 显示名,matchMode=alias(US2 验收 2)', () => {
    seedCascadeRig();
    const h = cascadeHelpers();
    h.channel('ch-alias', '别名频道 [4K] [IPv6]', 'tvg-alias'); // tvg 别名无行
    h.epgChannel('epg-a', 'other-ch', '无关台');
    h.epgChannel('epg-b', 'alias-ch', '别名频道'); // 显示名归一化同键
    h.programme('epg-b', 'alias-ch', 'alias-now', NOW_MS - 600_000, NOW_MS + 600_000);

    const row = projectionOf('ch-alias');
    expect(row.matchMode).toBe('alias');
    expect(row.epgSourceId).toBe('epg-b');
    expect(row.current?.title).toBe('节目 alias-now');
  });

  it('L1 manual 锁定:有效绑定优先于 precise/cascade(次源同有排期也不比较);失效后停链 none 不回退(T015)', () => {
    seedCascadeRig();
    const h = cascadeHelpers();
    h.channel('ch-lock', '锁定台', 'tvg-lock');
    h.epgChannel('epg-a', 'tvg-lock', '锁定台');
    h.epgChannel('epg-b', 'tvg-lock', '锁定台');
    h.programme('epg-a', 'tvg-lock', 'a-lock', NOW_MS - 600_000, NOW_MS + 600_000);
    h.programme('epg-b', 'tvg-lock', 'b-lock', NOW_MS - 600_000, NOW_MS + 600_000);
    h.manual('ch-lock', 'epg-a', 'tvg-lock');

    // 有效绑定:只用 manual 目标(epg-a),即使 epg-b(级联)也有排期
    const locked = projectionOf('ch-lock');
    expect(locked.matchMode).toBe('manual');
    expect(locked.epgSourceId).toBe('epg-a');
    expect(locked.current?.title).toBe('节目 a-lock');

    // 绑定失效(目标源禁用):停链 none,current=null,绝不落入 epg-b 级联(ADR-0008)
    h.setSourceEnabled('epg-a', 0);
    const invalidated = projectionOf('ch-lock');
    expect(invalidated.matchMode).toBe('none');
    expect(invalidated.current).toBeNull();
    expect(invalidated.next).toBeNull();
  });

  it('L5 全落空:matchMode=none,current/next=null,频道仍返回(可播降级)', () => {
    seedCascadeRig();
    const h = cascadeHelpers();
    h.channel('ch-none', '无指南台', 'tvg-none');

    const row = projectionOf('ch-none');
    expect(row.matchMode).toBe('none');
    expect(row.epgSourceId).toBeNull();
    expect(row.current).toBeNull();
    expect(row.next).toBeNull();
    expect(loadLiveChannelWindows(HOUSEHOLD_ID, NOW_MS).some((item) => item.mediaId === 'ch-none')).toBe(true);
  });
});
