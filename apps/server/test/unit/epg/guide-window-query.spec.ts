import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ExperienceProgrammeDto, GuideWindowDto } from '@hmp/shared';
import { Database } from '../../../src/database/database';
import { loadEnv } from '../../../src/config/env.schema';
import { setEnvOverride } from '../../../src/config/env';
import { loadGuideWindow } from '@contexts/epg/application/guide-window.service';
import { pickGuideCurrent } from '@contexts/epg/domain/binding-core';
import { programmeKeyOf } from '@contexts/epg/domain/programme-key.mapper';
import { programmeKeyOf as liveProgrammeKeyOf } from '@contexts/live-tv/application/live-projection.service';

/**
 * EPG 窗口查询单元测试(T107;data-model.md §8、research R8 逐字):
 * - 交叠条件 `starts_at < to AND ends_at > from`(边界:恰好结束于 from / 恰好起于 to 不算交叠);
 * - 当前判定 start<=now<end;重叠当前取 startsAt 最近、同起点按不透明 key 升序(复用 US5
 *   live-time 核心,经 binding-core 的 pickGuideCurrent,不建第二套判定);
 * - 跨日节目按窗口交叠归属(同一节目出现在相交的多个日历日窗口);
 * - 「from/to 必须在该日真实边界且 to>from」:跨日 → 422 GUIDE_WINDOW_TOO_LARGE;
 *   日内任意子窗口(含该日完整 24 小时全天窗口)均允许;倒置窗口 → 400 VALIDATION_FAILED;
 *   昨天 → 409 GUIDE_DATE_EXPIRED;
 * - 「一次响应最多 2000 节目/2 MiB,超限 422 不静默截断」:2000 恰好通过、2050 拒绝;
 *   ≤2000 条但负载 >2 MiB 同样拒绝;
 * - 「每页最多 50 频道、默认 20」;「频道按名称及稳定标识排序」;「分页可遍历所有频道,
 *   包括无节目频道」(无 EPG/关联失效/manual 失效频道保留行,programmes=[])。
 *
 * 时区换算基准:2026-11-04 CST 日 = UTC [2026-11-03T16:00Z, 2026-11-04T16:00Z)。
 * 夹具:直插 SQL(照 epg-programmes.e2e-spec 惯例),每 describe 独立 household,
 * 固定 nowMs 不读系统时钟;只应用权威迁移,不启动 Nest(纯服务层测试)。
 */

const CST = 'Asia/Shanghai';
const NOW = Date.parse('2026-11-04T12:05:00.000Z'); // 20:05 CST,家庭今天 = 2026-11-04
/** A 组共用窗口:17:35~23:35 CST(恰 6 小时,全部落在 11-04 CST 日内) */
const WIN_FROM = Date.parse('2026-11-04T09:35:00.000Z');
const WIN_TO = Date.parse('2026-11-04T15:35:00.000Z');

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

let dataDir: string;

beforeAll(() => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hmp-guide-window-'));
  setEnvOverride(loadEnv({ NODE_ENV: 'test', DATA_DIR: dataDir, DB_FILENAME: 'guide-window.hmp.db' }));
  Database.close();
  Database.db.exec('CREATE TABLE IF NOT EXISTS _migrations (name TEXT PRIMARY KEY NOT NULL, applied_at TEXT NOT NULL)');
  const migrationsDir = path.join(process.cwd(), 'src/database/migrations');
  const names = fs
    .readdirSync(migrationsDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
  for (const name of names) {
    Database.db.exec(fs.readFileSync(path.join(migrationsDir, name, 'up.sql'), 'utf8'));
    Database.db.prepare('INSERT INTO _migrations (name, applied_at) VALUES (?, ?)').run(name, '2026-01-01T00:00:00.000Z');
  }
});

afterAll(async () => {
  Database.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
  const gc = (globalThis as { gc?: () => void }).gc;
  if (typeof gc === 'function') {
    gc();
  }
  await new Promise((resolve) => setImmediate(resolve));
});

/* ------------------------------------------------------------------ */
/* 直插夹具                                                             */
/* ------------------------------------------------------------------ */

function seedHousehold(id: string): void {
  Database.db
    .prepare('INSERT INTO household (id, name, default_language, timezone, created_at) VALUES (?, ?, ?, ?, ?)')
    .run(id, `夹具家庭-${id}`, 'zh-CN', CST, '2026-01-01T00:00:00.000Z');
}

function seedCatalogState(householdId: string, revision: number): void {
  Database.db.prepare('INSERT INTO catalog_state (household_id, revision) VALUES (?, ?)').run(householdId, revision);
}

function seedSource(id: string, householdId: string, kind: 'iptv' | 'epg', epgSourceId: string | null, enabled: 0 | 1 = 1): void {
  Database.db.prepare(
    "INSERT INTO media_source (id, household_id, kind, name, remote_url, root_key, relative_directory, private_access_approved, epg_source_id, enabled, version, last_success_at, last_job_id, created_at, updated_at) VALUES (?, ?, ?, ?, 'http://seed.example/list', NULL, NULL, 1, ?, ?, 1, NULL, NULL, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')",
  ).run(id, householdId, kind, `${kind}-${id}`, epgSourceId, enabled);
}

function seedChannel(input: {
  householdId: string;
  mediaId: string;
  title: string;
  upstream: string | null;
  present?: 0 | 1;
  withPlayback?: boolean;
}): void {
  Database.db.prepare(
    'INSERT INTO media_item (id, household_id, type, title, description, poster_ref, content_level, title_overridden, type_overridden, version, created_at, updated_at) VALUES (?, ?, ?, ?, NULL, NULL, NULL, 0, 0, 1, ?, ?)',
  ).run(input.mediaId, input.householdId, 'channel', input.title, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z');
  Database.db.prepare(
    "INSERT INTO source_entry (id, household_id, source_id, identity_kind, identity_digest, media_id, upstream_channel_id, present, last_seen_job_id, first_seen_at, last_seen_at, missing_since, file_size_text, file_mtime_ns) VALUES (?, ?, ?, 'tvg_id', ?, ?, ?, ?, NULL, ?, ?, NULL, NULL, NULL)",
  ).run(
    `ent-${input.mediaId}`,
    input.householdId,
    `${input.householdId}-iptv`,
    sha256(`tvg_id:${input.mediaId}`),
    input.mediaId,
    input.upstream,
    input.present ?? 1,
    '2026-01-01T00:00:00.000Z',
    '2026-01-01T00:00:00.000Z',
  );
  if (input.withPlayback ?? true) {
    Database.db.prepare(
      "INSERT INTO playback_source (id, household_id, source_id, source_entry_id, media_item_id, protocol, location, mime_type, priority, requires_proxy, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 'http', 'http://secret.example/stream', NULL, 100, 0, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')",
    ).run(`ps-${input.mediaId}`, input.householdId, `${input.householdId}-iptv`, `ent-${input.mediaId}`, input.mediaId);
  }
}

function seedEpgChannel(householdId: string, sourceId: string, xmltvId: string, conflicted: 0 | 1): void {
  Database.db.prepare(
    'INSERT INTO epg_channel (household_id, source_id, xmltv_channel_id, display_name, conflicted) VALUES (?, ?, ?, ?, ?)',
  ).run(householdId, sourceId, xmltvId, `显示名-${xmltvId}`, conflicted);
}

function seedProgramme(input: {
  householdId: string;
  sourceId: string;
  xmltvId: string;
  id: string;
  title: string;
  description?: string | null;
  startsAt: string;
  endsAt: string;
}): void {
  Database.db.prepare(
    'INSERT INTO epg_programme (id, household_id, source_id, xmltv_channel_id, title, description, starts_at, ends_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
  ).run(input.id, input.householdId, input.sourceId, input.xmltvId, input.title, input.description ?? null, input.startsAt, input.endsAt);
}

function iso(ms: number): string {
  return new Date(ms).toISOString();
}

function channelTitlesOf(response: GuideWindowDto): string[] {
  return response.channels.map((row) => row.media.title);
}

/* ------------------------------------------------------------------ */
/* A. 交叠/信封/隐私                                                     */
/* ------------------------------------------------------------------ */

describe('guide-window-query:交叠条件与窗口语义(T107)', () => {
  const hh = 'gwq-a';
  const src = `${hh}-epg`;

  beforeAll(() => {
    seedHousehold(hh);
    seedCatalogState(hh, 7);
    seedSource(src, hh, 'epg', null); // 先插 EPG 源(iptv.epg_source_id 自引用 FK 目标)
    seedSource(`${hh}-iptv`, hh, 'iptv', src);
    seedChannel({ householdId: hh, mediaId: `${hh}-ch-a`, title: '频道 A', upstream: 'xmltv-a' });
    seedEpgChannel(hh, src, 'xmltv-a', 0);
    // 恰好结束于 from → 不交叠(ends_at > from 为假)
    seedProgramme({ householdId: hh, sourceId: src, xmltvId: 'xmltv-a', id: 'p-ends-at-from', title: '恰好结束于窗口起点', startsAt: iso(WIN_FROM - 60 * 60_000), endsAt: iso(WIN_FROM) });
    // 起点早于 from、终点在窗内 → 交叠纳入,且响应保留完整 UTC 起止
    seedProgramme({ householdId: hh, sourceId: src, xmltvId: 'xmltv-a', id: 'p-overlap-before', title: '跨窗起点节目', startsAt: iso(WIN_FROM - 30 * 60_000), endsAt: iso(WIN_FROM + 30 * 60_000) });
    // 恰好起于 to → 不交叠(starts_at < to 为假)
    seedProgramme({ householdId: hh, sourceId: src, xmltvId: 'xmltv-a', id: 'p-starts-at-to', title: '恰好起于窗口终点', startsAt: iso(WIN_TO), endsAt: iso(WIN_TO + 30 * 60_000) });
    // 同起点并列两行(交叠纳入;当前判定见独立 describe)
    seedProgramme({ householdId: hh, sourceId: src, xmltvId: 'xmltv-a', id: 'p-same-1', title: '同起点甲', startsAt: iso(WIN_FROM + 60 * 60_000), endsAt: iso(WIN_FROM + 90 * 60_000) });
    seedProgramme({ householdId: hh, sourceId: src, xmltvId: 'xmltv-a', id: 'p-same-2', title: '同起点乙', startsAt: iso(WIN_FROM + 60 * 60_000), endsAt: iso(WIN_FROM + 120 * 60_000) });
  });

  it('交叠条件 starts_at < to AND ends_at > from:边界行排除、部分交叠行纳入且保留完整起止', () => {
    const response = loadGuideWindow(hh, { nowMs: NOW, timezone: CST, fromMs: WIN_FROM, toMs: WIN_TO, page: 1, pageSize: 20 });
    expect(response.channels).toHaveLength(1);
    const programmes = response.channels[0]?.programmes ?? [];
    const ids = programmes.map((p) => p.key);
    expect(ids).not.toContain(programmeKeyOf('p-ends-at-from'));
    expect(ids).not.toContain(programmeKeyOf('p-starts-at-to'));
    const overlap = programmes.find((p) => p.key === programmeKeyOf('p-overlap-before'));
    expect(overlap?.startsAt).toBe(iso(WIN_FROM - 30 * 60_000));
    expect(overlap?.endsAt).toBe(iso(WIN_FROM + 30 * 60_000));
    // 每频道节目按 (startsAt, key) 升序
    expect(ids).toEqual(
      [...programmes]
        .sort((l, r) => (l.startsAt !== r.startsAt ? (l.startsAt < r.startsAt ? -1 : 1) : l.key < r.key ? -1 : 1))
        .map((p) => p.key),
    );
  });

  it('响应信封:date/now/allowedDates/from/to/page/pageSize/totalChannels/catalogRevision/timezone', () => {
    const response = loadGuideWindow(hh, { nowMs: NOW, timezone: CST, date: '2026-11-04', fromMs: WIN_FROM, toMs: WIN_TO, page: 2, pageSize: 20 });
    expect(response.date).toBe('2026-11-04');
    expect(response.now).toBe(iso(NOW));
    expect(response.timezone).toBe(CST);
    expect(response.allowedDates).toEqual(['2026-11-04', '2026-11-05', '2026-11-06', '2026-11-07', '2026-11-08', '2026-11-09', '2026-11-10']);
    expect(response.from).toBe(iso(WIN_FROM));
    expect(response.to).toBe(iso(WIN_TO));
    expect(response.page).toBe(2);
    expect(response.pageSize).toBe(20);
    expect(response.totalChannels).toBe(1);
    expect(response.catalogRevision).toBe(7);
  });

  it('公共响应不含源 ID/XMLTV ID/上游标识/路径(programme key 不透明)', () => {
    const response = loadGuideWindow(hh, { nowMs: NOW, timezone: CST, fromMs: WIN_FROM, toMs: WIN_TO, page: 1, pageSize: 20 });
    const text = JSON.stringify(response);
    expect(text).not.toContain('xmltv-a');
    expect(text).not.toContain(src);
    expect(text).not.toContain('secret.example');
    expect(response.channels[0]?.media.id).toBe(`${hh}-ch-a`);
    for (const programme of response.channels[0]?.programmes ?? []) {
      expect(programme.key).toMatch(/^pg-[0-9a-f]{24}$/);
    }
  });
});

describe('guide-window-query:跨日节目按交叠归属(T107)', () => {
  const hh = 'gwq-x';
  const src = `${hh}-epg`;

  beforeAll(() => {
    seedHousehold(hh);
    seedSource(src, hh, 'epg', null); // 先插 EPG 源(iptv.epg_source_id 自引用 FK 目标)
    seedSource(`${hh}-iptv`, hh, 'iptv', src);
    seedChannel({ householdId: hh, mediaId: `${hh}-ch`, title: '跨日频道', upstream: 'x' });
    seedEpgChannel(hh, src, 'x', 0);
    // 跨日节目:23:00 CST 11-04(今天)→ 01:00 CST 11-05(明天)= 15:00Z → 17:00Z 11-04;
    // 过去日历日(昨天)不可查询,跨日归属在「今天/明天」两个允许日窗口间验证
    seedProgramme({ householdId: hh, sourceId: src, xmltvId: 'x', id: 'p-crossday', title: '跨午夜节目', startsAt: iso(Date.parse('2026-11-04T15:00:00.000Z')), endsAt: iso(Date.parse('2026-11-04T17:00:00.000Z')) });
  });

  it('同一跨日节目同时出现在相交的两个日历日窗口(11-03 与 11-04)', () => {
    // 今天(11-04)傍晚窗口:18:00~24:00 CST = [10:00Z, 16:00Z)(恰 6h,日内)
    const today = loadGuideWindow(hh, {
      nowMs: NOW,
      timezone: CST,
      date: '2026-11-04',
      fromMs: Date.parse('2026-11-04T10:00:00.000Z'),
      toMs: Date.parse('2026-11-04T16:00:00.000Z'),
      page: 1,
      pageSize: 20,
    });
    expect(today.date).toBe('2026-11-04');
    expect(today.from).toBe(iso(Date.parse('2026-11-04T10:00:00.000Z')));
    expect(today.channels[0]?.programmes.map((p) => p.key)).toContain(programmeKeyOf('p-crossday'));
    // 明天(11-05)凌晨窗口:00:00~06:00 CST = [16:00Z, 22:00Z)(恰 6h,日内)
    const tomorrow = loadGuideWindow(hh, {
      nowMs: NOW,
      timezone: CST,
      date: '2026-11-05',
      fromMs: Date.parse('2026-11-04T16:00:00.000Z'),
      toMs: Date.parse('2026-11-04T22:00:00.000Z'),
      page: 1,
      pageSize: 20,
    });
    expect(tomorrow.date).toBe('2026-11-05');
    expect(tomorrow.channels[0]?.programmes.map((p) => p.key)).toContain(programmeKeyOf('p-crossday'));
  });
});

describe('guide-window-query:当前判定 start<=now<end、重叠取最近起点、同起点 key 升序(T107/R8)', () => {
  const hh = 'gwq-cur';
  const src = `${hh}-epg`;
  /** 窗口:15:05~20:30 CST(5.5h,≤6h,今日内) */
  const CUR_FROM = NOW - 5 * 3_600_000;
  const CUR_TO = NOW + 30 * 60_000;

  beforeAll(() => {
    seedHousehold(hh);
    seedSource(src, hh, 'epg', null); // 先插 EPG 源(iptv.epg_source_id 自引用 FK 目标)
    seedSource(`${hh}-iptv`, hh, 'iptv', src);
    seedChannel({ householdId: hh, mediaId: `${hh}-ch`, title: '当前判定频道', upstream: 'cur' });
    seedEpgChannel(hh, src, 'cur', 0);
    seedProgramme({ householdId: hh, sourceId: src, xmltvId: 'cur', id: 'cur-early', title: '早档', startsAt: iso(NOW - 60 * 60_000), endsAt: iso(NOW + 60 * 60_000) });
    seedProgramme({ householdId: hh, sourceId: src, xmltvId: 'cur', id: 'cur-overlap', title: '重叠晚起点', startsAt: iso(NOW - 3 * 60_000), endsAt: iso(NOW + 57 * 60_000) });
    seedProgramme({ householdId: hh, sourceId: src, xmltvId: 'cur', id: 'cur-tie-b', title: '同起点乙', startsAt: iso(NOW - 60 * 60_000), endsAt: iso(NOW + 30 * 60_000) });
    seedProgramme({ householdId: hh, sourceId: src, xmltvId: 'cur', id: 'cur-ended', title: '恰好结束于 now', startsAt: iso(NOW - 30 * 60_000), endsAt: iso(NOW) });
    seedProgramme({ householdId: hh, sourceId: src, xmltvId: 'cur', id: 'cur-future', title: '未来节目', startsAt: iso(NOW + 5 * 60_000), endsAt: iso(NOW + 65 * 60_000) });
  });

  function rowsOf(): ExperienceProgrammeDto[] {
    const response = loadGuideWindow(hh, { nowMs: NOW, timezone: CST, fromMs: CUR_FROM, toMs: CUR_TO, page: 1, pageSize: 20 });
    return response.channels[0]?.programmes ?? [];
  }

  it('pickGuideCurrent(复用 live-time 核心):start<=now<end;终点含排除;重叠取最近起点', () => {
    const rows = rowsOf();
    expect(rows).toHaveLength(5); // 全部 5 行按交叠纳入窗口(含恰好结束于 now 与未来行)
    const current = pickGuideCurrent(rows, NOW);
    expect(current).not.toBeNull();
    // 重叠候选:cur-early、cur-overlap、cur-tie-b → startsAt 最近者 cur-overlap 胜出
    expect(current?.key).toBe(programmeKeyOf('cur-overlap'));
  });

  it('同起点并列取 key 升序(去掉更晚起点行后,早起点两行中 key 小者胜)', () => {
    const rows = rowsOf().filter((p) => p.key !== programmeKeyOf('cur-overlap'));
    const expected = [programmeKeyOf('cur-early'), programmeKeyOf('cur-tie-b')].sort()[0];
    const current = pickGuideCurrent(rows, NOW);
    expect(current?.key).toBe(expected);
  });

  it('无覆盖行 → current 为 null(空档不误取相邻节目)', () => {
    const gap = pickGuideCurrent(
      [
        { key: programmeKeyOf('before'), title: '前档', description: null, startsAt: iso(NOW - 60 * 60_000), endsAt: iso(NOW - 10 * 60_000) },
        { key: programmeKeyOf('after'), title: '后档', description: null, startsAt: iso(NOW + 10 * 60_000), endsAt: iso(NOW + 60 * 60_000) },
      ],
      NOW,
    );
    expect(gap).toBeNull();
  });
});

/* ------------------------------------------------------------------ */
/* B. 校验语义(409/400/422)                                             */
/* ------------------------------------------------------------------ */

describe('guide-window-query:date/from/to 校验(T107)', () => {
  const hh = 'gwq-a'; // 复用 A 组夹具

  function statusOf(action: () => unknown): { status: number; code?: string; allowedDates?: string[] } {
    try {
      action();
      throw new Error('期望抛出领域错误,实际成功返回');
    } catch (error) {
      expect(error).toBeInstanceOf(Error);
      const candidate = error as { status?: number; code?: string; getResponse?: () => unknown };
      if (typeof candidate.getResponse === 'function') {
        const body = candidate.getResponse() as { code?: string; allowedDates?: string[] };
        return { status: candidate.status ?? 0, code: body.code, allowedDates: body.allowedDates };
      }
      return { status: candidate.status ?? 0, code: candidate.code };
    }
  }

  it('昨天(家庭时区)→ 409 GUIDE_DATE_EXPIRED + allowedDates 新范围', () => {
    const outcome = statusOf(() => loadGuideWindow(hh, { nowMs: NOW, timezone: CST, date: '2026-11-03', page: 1, pageSize: 20 }));
    expect(outcome.status).toBe(409);
    expect(outcome.code).toBe('GUIDE_DATE_EXPIRED');
    expect(outcome.allowedDates?.[0]).toBe('2026-11-04');
    expect(outcome.allowedDates).toHaveLength(7);
  });

  it('尚未到允许未来范围(today+7)→ 400 VALIDATION_FAILED', () => {
    const outcome = statusOf(() => loadGuideWindow(hh, { nowMs: NOW, timezone: CST, date: '2026-11-11', page: 1, pageSize: 20 }));
    expect(outcome.status).toBe(400);
    expect(outcome.code).toBe('VALIDATION_FAILED');
  });

  it('from 早于该日真实日界(跨日窗口)→ 422 GUIDE_WINDOW_TOO_LARGE', () => {
    const outcome = statusOf(() =>
      loadGuideWindow(hh, {
        nowMs: NOW,
        timezone: CST,
        date: '2026-11-04',
        fromMs: Date.parse('2026-11-03T15:00:00.000Z'),
        toMs: Date.parse('2026-11-03T18:00:00.000Z'),
        page: 1,
        pageSize: 20,
      }),
    );
    expect(outcome.status).toBe(422);
    expect(outcome.code).toBe('GUIDE_WINDOW_TOO_LARGE');
  });

  it('to 晚于该日真实日界(跨日窗口)→ 422', () => {
    const outcome = statusOf(() =>
      loadGuideWindow(hh, {
        nowMs: NOW,
        timezone: CST,
        date: '2026-11-04',
        fromMs: Date.parse('2026-11-04T15:00:00.000Z'),
        toMs: Date.parse('2026-11-04T17:00:00.000Z'),
        page: 1,
        pageSize: 20,
      }),
    );
    expect(outcome.status).toBe(422);
    expect(outcome.code).toBe('GUIDE_WINDOW_TOO_LARGE');
  });

  it('日内 6.5 小时子窗口 → 200(全天视图下不再限 6 小时);全天窗口 → 200 且贴齐真实日界', () => {
    const over6h = loadGuideWindow(hh, {
      nowMs: NOW,
      timezone: CST,
      date: '2026-11-04',
      fromMs: Date.parse('2026-11-04T09:00:00.000Z'),
      toMs: Date.parse('2026-11-04T15:30:00.000Z'), // 6.5h,日内
      page: 1,
      pageSize: 20,
    });
    expect(over6h.from).toBe(iso(Date.parse('2026-11-04T09:00:00.000Z')));
    const fullDay = loadGuideWindow(hh, {
      nowMs: NOW,
      timezone: CST,
      date: '2026-11-04',
      fromMs: Date.parse('2026-11-03T16:00:00.000Z'), // 00:00 CST
      toMs: Date.parse('2026-11-04T16:00:00.000Z'), // 24:00 CST
      page: 1,
      pageSize: 20,
    });
    expect(fullDay.from).toBe(iso(Date.parse('2026-11-03T16:00:00.000Z')));
    expect(fullDay.to).toBe(iso(Date.parse('2026-11-04T16:00:00.000Z')));
  });

  it('缺省 from/to → 该日完整 24 小时全天窗口(真实日界)', () => {
    const response = loadGuideWindow(hh, { nowMs: NOW, timezone: CST, date: '2026-11-04', page: 1, pageSize: 20 });
    expect(response.from).toBe(iso(Date.parse('2026-11-03T16:00:00.000Z')));
    expect(response.to).toBe(iso(Date.parse('2026-11-04T16:00:00.000Z')));
  });

  it('to <= from(倒置)→ 400 VALIDATION_FAILED', () => {
    const outcome = statusOf(() =>
      loadGuideWindow(hh, {
        nowMs: NOW,
        timezone: CST,
        date: '2026-11-04',
        fromMs: Date.parse('2026-11-04T12:00:00.000Z'),
        toMs: Date.parse('2026-11-04T12:00:00.000Z'),
        page: 1,
        pageSize: 20,
      }),
    );
    expect(outcome.status).toBe(400);
    expect(outcome.code).toBe('VALIDATION_FAILED');
  });
});

/* ------------------------------------------------------------------ */
/* C. 排序/分页/无节目频道                                               */
/* ------------------------------------------------------------------ */

describe('guide-window-query:频道排序、分页与无节目频道(T107)', () => {
  const hh = 'gwq-p';
  const src = `${hh}-epg`;

  beforeAll(() => {
    seedHousehold(hh);
    seedSource(src, hh, 'epg', null); // 先插 EPG 源(iptv.epg_source_id 自引用 FK 目标)
    seedSource(`${hh}-iptv`, hh, 'iptv', src);
    // A:正常关联有节目;B:无 EPG;C:不可用(整体排除);D:目标 conflicted;E:manual 失效不回退
    seedChannel({ householdId: hh, mediaId: `${hh}-ch-a`, title: '频道 A', upstream: 'a' });
    seedChannel({ householdId: hh, mediaId: `${hh}-ch-b`, title: '频道 B', upstream: 'b' }); // 无 epg_channel 匹配
    seedChannel({ householdId: hh, mediaId: `${hh}-ch-c`, title: '频道 C', upstream: 'c', present: 0, withPlayback: false });
    seedChannel({ householdId: hh, mediaId: `${hh}-ch-d`, title: '频道 D', upstream: 'd-conflict' });
    seedChannel({ householdId: hh, mediaId: `${hh}-ch-e`, title: '频道 E', upstream: 'e' });
    seedEpgChannel(hh, src, 'a', 0);
    seedEpgChannel(hh, src, 'd-conflict', 1);
    seedProgramme({ householdId: hh, sourceId: src, xmltvId: 'a', id: 'pa-1', title: '频道 A 节目', startsAt: iso(WIN_FROM), endsAt: iso(WIN_FROM + 30 * 60_000) });
    // manual 失效:E 手动绑定到「已停用」EPG 来源(manual CHECK 要求非空目标对);
    // live 核心语义:目标源禁用 → 失效不回退自动(其上游本可自动精确关联)
    seedSource(`${hh}-epg-dead`, hh, 'epg', null, 0);
    seedEpgChannel(hh, `${hh}-epg-dead`, 'e-dead', 0);
    Database.db.prepare(
      "INSERT INTO manual_epg_binding (household_id, media_id, mode, epg_source_id, xmltv_channel_id, version, updated_at) VALUES (?, ?, 'manual', ?, 'e-dead', 1, '2026-01-01T00:00:00.000Z')",
    ).run(hh, `${hh}-ch-e`, `${hh}-epg-dead`);
  });

  it('默认 pageSize=20;pageSize>50 防御性钳制为 50(契约 400 由查询管道承担)', () => {
    const byDefault = loadGuideWindow(hh, { nowMs: NOW, timezone: CST, date: '2026-11-04', fromMs: WIN_FROM, toMs: WIN_TO, page: 1 });
    expect(byDefault.pageSize).toBe(20);
    const clamped = loadGuideWindow(hh, { nowMs: NOW, timezone: CST, date: '2026-11-04', fromMs: WIN_FROM, toMs: WIN_TO, page: 1, pageSize: 999 });
    expect(clamped.pageSize).toBe(50);
  });

  it('频道按名称+稳定标识排序;不可用频道不出现;无节目频道保留 programmes:[]', () => {
    const response = loadGuideWindow(hh, { nowMs: NOW, timezone: CST, date: '2026-11-04', fromMs: WIN_FROM, toMs: WIN_TO, page: 1, pageSize: 50 });
    expect(channelTitlesOf(response)).toEqual(['频道 A', '频道 B', '频道 D', '频道 E']);
    expect(response.totalChannels).toBe(4);
    const byId = new Map(response.channels.map((row) => [row.media.id, row] as const));
    expect(byId.get(`${hh}-ch-a`)?.programmes).toHaveLength(1);
    expect(byId.get(`${hh}-ch-b`)?.programmes).toHaveLength(0);
    expect(byId.get(`${hh}-ch-d`)?.programmes).toHaveLength(0); // conflicted 无节目
    expect(byId.get(`${hh}-ch-e`)?.programmes).toHaveLength(0); // manual 失效不回退自动
    for (const row of response.channels) {
      expect(row.media.availability).toBe('available');
      expect(row.media.type).toBe('channel');
    }
  });

  it('分页可遍历全部频道(含无节目频道),越界页为空列表且 total 不变', () => {
    const page1 = loadGuideWindow(hh, { nowMs: NOW, timezone: CST, date: '2026-11-04', fromMs: WIN_FROM, toMs: WIN_TO, page: 1, pageSize: 2 });
    expect(channelTitlesOf(page1)).toEqual(['频道 A', '频道 B']);
    expect(page1.totalChannels).toBe(4);
    const page2 = loadGuideWindow(hh, { nowMs: NOW, timezone: CST, date: '2026-11-04', fromMs: WIN_FROM, toMs: WIN_TO, page: 2, pageSize: 2 });
    expect(channelTitlesOf(page2)).toEqual(['频道 D', '频道 E']);
    const page3 = loadGuideWindow(hh, { nowMs: NOW, timezone: CST, date: '2026-11-04', fromMs: WIN_FROM, toMs: WIN_TO, page: 3, pageSize: 2 });
    expect(page3.channels).toEqual([]);
    expect(page3.totalChannels).toBe(4);
  });
});

/* ------------------------------------------------------------------ */
/* D. 2000 节目上限(恰好通过 / 超限 422)                                 */
/* ------------------------------------------------------------------ */

describe('guide-window-query:一次响应最多 2000 节目,超限 422 不静默截断(T107)', () => {
  const hh = 'gwq-c';
  const src = `${hh}-epg`;
  const DENSE = 50;
  /** 11-04 CST 日前 6 小时:00:00~06:00 CST = UTC [11-03T16:00Z, 11-03T22:00Z) */
  const WIN = { fromMs: Date.parse('2026-11-03T16:00:00.000Z'), toMs: Date.parse('2026-11-03T22:00:00.000Z') };

  function seedDenseChannel(index: number, programmesPerChannel: number, offsetMs: number): void {
    const no = String(index).padStart(2, '0');
    seedChannel({ householdId: hh, mediaId: `${hh}-s${no}`, title: `密档频道 S${no}`, upstream: `s${no}` });
    seedEpgChannel(hh, src, `s${no}`, 0);
    for (let i = 0; i < programmesPerChannel; i += 1) {
      const start = WIN.fromMs + offsetMs + i * 7 * 60_000;
      seedProgramme({
        householdId: hh,
        sourceId: src,
        xmltvId: `s${no}`,
        id: `pc-${no}-${String(i).padStart(2, '0')}`,
        title: `密档节目 S${no}-${i}`,
        startsAt: iso(start),
        endsAt: iso(start + 20 * 60_000),
      });
    }
  }

  beforeAll(() => {
    seedHousehold(hh);
    seedSource(src, hh, 'epg', null); // 先插 EPG 源(iptv.epg_source_id 自引用 FK 目标)
    seedSource(`${hh}-iptv`, hh, 'iptv', src);
    for (let index = 1; index <= DENSE; index += 1) {
      seedDenseChannel(index, 40, index * 60_000);
    }
  });

  it('恰好 2000 节目(50 频道 × 40)→ 200,完整返回不截断', () => {
    const response = loadGuideWindow(hh, { nowMs: NOW, timezone: CST, date: '2026-11-04', ...WIN, page: 1, pageSize: 50 });
    expect(response.channels).toHaveLength(50);
    const total = response.channels.reduce((sum, row) => sum + row.programmes.length, 0);
    expect(total).toBe(2000);
  });

  it('再加 50 行(50 频道 × 41 = 2050 > 2000)→ 抛 422 GUIDE_WINDOW_TOO_LARGE,不返回截断数据', () => {
    Database.db.transaction(() => {
      for (let index = 1; index <= DENSE; index += 1) {
        const no = String(index).padStart(2, '0');
        seedProgramme({
          householdId: hh,
          sourceId: src,
          xmltvId: `s${no}`,
          id: `pc-${no}-extra`,
          title: `密档加播 S${no}`,
          startsAt: iso(WIN.fromMs + index * 30_000),
          endsAt: iso(WIN.fromMs + index * 30_000 + 10 * 60_000),
        });
      }
    })();
    let caught: unknown = null;
    try {
      loadGuideWindow(hh, { nowMs: NOW, timezone: CST, date: '2026-11-04', ...WIN, page: 1, pageSize: 50 });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(Error);
    const problem = caught as { status?: number; code?: string; getResponse?: () => { code?: string } };
    expect(problem.status).toBe(422);
    expect(problem.code ?? problem.getResponse?.().code).toBe('GUIDE_WINDOW_TOO_LARGE');
  });
});

/* ------------------------------------------------------------------ */
/* E. 2 MiB 负载上限(≤2000 条但超字节 → 422)                             */
/* ------------------------------------------------------------------ */

describe('guide-window-query:负载 >2 MiB → 422(T107)', () => {
  const hh = 'gwq-s';
  const src = `${hh}-epg`;
  const WIN = { fromMs: Date.parse('2026-11-03T16:00:00.000Z'), toMs: Date.parse('2026-11-03T22:00:00.000Z') };
  // 4096 个 CJK 字符 ≈ 12 KiB UTF-8(字段 CHECK 上限恰为 4096 字符)
  const LONG_DESCRIPTION = '剧'.repeat(4096);

  beforeAll(() => {
    seedHousehold(hh);
    seedSource(src, hh, 'epg', null); // 先插 EPG 源(iptv.epg_source_id 自引用 FK 目标)
    seedSource(`${hh}-iptv`, hh, 'iptv', src);
    for (let channel = 1; channel <= 20; channel += 1) {
      const no = String(channel).padStart(2, '0');
      seedChannel({ householdId: hh, mediaId: `${hh}-t${no}`, title: `长介频道 T${no}`, upstream: `t${no}` });
      seedEpgChannel(hh, src, `t${no}`, 0);
      for (let i = 0; i < 9; i += 1) {
        const start = WIN.fromMs + channel * 60_000 + i * 10 * 60_000;
        seedProgramme({
          householdId: hh,
          sourceId: src,
          xmltvId: `t${no}`,
          id: `pt-${no}-${i}`,
          title: `长介节目 T${no}-${i}`,
          description: LONG_DESCRIPTION,
          startsAt: iso(start),
          endsAt: iso(start + 9 * 60_000),
        });
      }
    }
  });

  it('180 条(≤2000)但负载 >2 MiB → 422 GUIDE_WINDOW_TOO_LARGE', () => {
    let caught: unknown = null;
    try {
      loadGuideWindow(hh, { nowMs: NOW, timezone: CST, date: '2026-11-04', ...WIN, page: 1, pageSize: 50 });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(Error);
    const problem = caught as { status?: number; code?: string; getResponse?: () => { code?: string } };
    expect(problem.status).toBe(422);
    expect(problem.code ?? problem.getResponse?.().code).toBe('GUIDE_WINDOW_TOO_LARGE');
  });
});

describe('programme-key.mapper:不透明 key 归属(T107/T114)', () => {
  it('与 US5 live 实现同一映射(复用,不建第二套);不含来源/XMLTV/路径信息', () => {
    expect(programmeKeyOf('some-internal-id')).toBe(liveProgrammeKeyOf('some-internal-id'));
    expect(programmeKeyOf('xmltv-a')).toMatch(/^pg-[0-9a-f]{24}$/);
    expect(programmeKeyOf('xmltv-a')).not.toContain('xmltv');
  });
});
