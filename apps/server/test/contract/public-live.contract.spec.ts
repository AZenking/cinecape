import 'reflect-metadata';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import type { ChannelPageDto, GroupPageDto, ExperienceProgrammesDto } from '@hmp/shared';
import { AppModule } from '../../src/app.module';
import { LiveTvModule } from '@contexts/live-tv/live-tv.module';
import { Database } from '@platform/database/database';
import { setEnvOverride } from '@platform/config/env';
import { loadEnv } from '@platform/config/env.schema';
import { seedScaleFixture, scaleChannelMediaId, scheduleSlotUtcMs, SCALE_FIXTURE_FIXED_NOW_MS, SCALE_FIXTURE_TIMEZONE } from '../fixtures/scale-fixture';
import { cleanupRigs, expectProblemContentType } from '../helpers';

/**
 * 公共直播契约测试(T060;005 contracts/api.md §1/§2、宪章原则三):
 * - 匿名两种方式(无会话 / 失效 cookie)访问 GET /api/public/live/groups、
 *   GET /api/public/live/channels(section=now/next/group/all + groupKey?/q?/page/pageSize)
 *   与 GET /api/public/media/{mediaId}/programmes,均不要求登录、不因失效 cookie 拒绝;
 * - 三个 envelope 均含各自 now/timezone/catalogRevision 同步快照(不要求跨请求 now 相等);
 * - ChannelRow={media,groupKey,groupLabel,current,next};无 current/next 时频道仍在;
 * - Cache-Control: no-store;无 Set-Cookie;公共响应不含源地址/来源凭据/播放票据/个人数据;
 * - 负向:未知 query 字段(伪造 householdId/profileId/isAdmin)400;pageSize>50、非法
 *   section、page<1 400;programmes 非频道 400、无匹配 200 unavailable、未知/不可用 404。
 *
 * 模块组合:AppModule + LiveModule(测试内组合;LiveModule 的 app.module 注册行由
 * lead 统一接入,见报告)。T012 规模夹具(200 频道/67,200 排期)+ 固定时钟偏移
 * (HMP_CLOCK_OFFSET_MS 锚到 SCALE_FIXTURE_FIXED_NOW_MS,与 live 模块时钟缝一致)。
 */

const OFFSET_ENV_KEY = 'HMP_CLOCK_OFFSET_MS';

let app: INestApplication;
let dataDir: string;

async function bootComposedApp(): Promise<INestApplication> {
  const moduleRef = await Test.createTestingModule({ imports: [AppModule, LiveTvModule] }).compile();
  const composed = moduleRef.createNestApplication({ logger: ['warn', 'error'] });
  composed.setGlobalPrefix('api');
  await composed.init();
  return composed;
}

beforeAll(async () => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hmp-public-live-'));
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
    const upSql = fs.readFileSync(path.join(migrationsDir, name, 'up.sql'), 'utf8');
    Database.db.transaction(() => {
      Database.db.exec(upSql);
      Database.db.prepare('INSERT INTO _migrations (name, applied_at) VALUES (?, ?)').run(name, new Date().toISOString());
    })();
  }
  await seedScaleFixture(Database.db);
  // 固定时钟:锚到规模夹具固定 now(此后 1:1 流动;断言锚定夹具常量,容许秒级漂移)
  process.env[OFFSET_ENV_KEY] = String(SCALE_FIXTURE_FIXED_NOW_MS - Date.now());
  app = await bootComposedApp();
}, 120_000);

afterAll(async () => {
  delete process.env[OFFSET_ENV_KEY];
  await app?.close();
  Database.close();
  if (dataDir !== undefined) {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
  // better-sqlite3 原生 Statement 收尾(与 sources-refresh 套件同惯例)
  const gc = (globalThis as { gc?: () => void }).gc;
  if (typeof gc === 'function') {
    gc();
  }
  await new Promise((resolve) => setImmediate(resolve));
});

afterEach(async () => {
  await cleanupRigs();
});

// supertest 的 App 类型经 export = 命名空间引用;此处直接以结构兼容的 http server 传参
const http = (): Parameters<typeof request>[0] => app.getHttpServer() as Parameters<typeof request>[0];

/** 夹具派生期望:可用频道 = 1..200 除 15;无 EPG = 197..200 */
const AVAILABLE = Array.from({ length: 200 }, (_, index) => index + 1).filter((no) => no !== 15);
const WITH_EPG = AVAILABLE.filter((no) => no < 197);
const WITHOUT_EPG = AVAILABLE.filter((no) => no >= 197);

function slotIso(day: number, slot: number, which: 'start' | 'end'): string {
  const { startMs, endMs } = scheduleSlotUtcMs(day, slot);
  return new Date(which === 'start' ? startMs : endMs).toISOString();
}

async function getChannels(query: Record<string, string | number>): Promise<request.Response> {
  return request(http()).get('/api/public/live/channels').query(query);
}

async function getAllChannels(): Promise<ChannelPageDto[]> {
  const pages: ChannelPageDto[] = [];
  for (let page = 1; page <= 10; page += 1) {
    const res = await getChannels({ section: 'all', page, pageSize: 50 });
    expect(res.status).toBe(200);
    const body = res.body as ChannelPageDto;
    pages.push(body);
    if (pages[pages.length - 1]?.items.length === 0 || (body.page ?? page) * 50 >= body.total) {
      break;
    }
  }
  return pages;
}

describe('公共直播契约(T060)', () => {
  it('匿名(无会话)GET /public/live/groups:200,仅分组显示名+不透明 key,附同步快照', async () => {
    const res = await request(http()).get('/api/public/live/groups');
    expect(res.status).toBe(200);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.headers['set-cookie']).toBeUndefined();
    const body = res.body as GroupPageDto;
    expect(body.timezone).toBe(SCALE_FIXTURE_TIMEZONE);
    expect(Number.isInteger(body.catalogRevision)).toBe(true);
    expect(body.catalogRevision).toBeGreaterThanOrEqual(1);
    expect(() => Date.parse(body.now)).not.toThrow();
    const labels = body.items.map((item) => item.label);
    expect(new Set(labels)).toEqual(
      // ALT_GROUPS 按 (频道号-5)%3 轮换:ch7→备用·纪录, ch8→备用·影视
      new Set(['央视', '卫视', '影视', '体育', '纪录', '少儿', '其他', '备用·影视', '备用·纪录']),
    );
    for (const item of body.items) {
      expect(item.key).toMatch(/^grp-[0-9a-f]{20}$/);
      expect(item.key).not.toContain('fx-src');
      expect(item.key).not.toContain('http');
    }
    // 稳定排序(显示名码元序)
    expect(labels).toEqual([...labels].sort());
  });

  it('携带失效 cookie 仍可公开浏览:与无会话同形 200(公开投影与身份无关)', async () => {
    const anonymous = await request(http()).get('/api/public/live/groups');
    const invalidCookie = await request(http())
      .get('/api/public/live/groups')
      .set('Cookie', 'hmp_session=invalid-or-revoked-token');
    expect(invalidCookie.status).toBe(200);
    expect(invalidCookie.body.items).toEqual(anonymous.body.items);
    expect(invalidCookie.body.timezone).toBe(anonymous.body.timezone);
    expect(invalidCookie.headers['cache-control']).toBe('no-store');
  });

  it('section=now:正在直播按当前节目结束时间排序;重叠频道取 startsAt 最近;无 EPG 频道不出现', async () => {
    const res = await getChannels({ section: 'now', page: 1, pageSize: 50 });
    expect(res.status).toBe(200);
    expect(res.headers['cache-control']).toBe('no-store');
    const body = res.body as ChannelPageDto;
    // 196 个有 EPG 的可用频道都有正在直播(15 号不可用;197~200 无 EPG)
    expect(body.total).toBe(WITH_EPG.length);
    expect(body.pageSize).toBe(50);
    const bodyText = JSON.stringify(body);
    expect(bodyText).not.toContain('fx-xmltv');
    expect(bodyText).not.toContain('http://iptv.scale-fixture.test');
    // 重叠取 startsAt 最近:ch001 当前为加播(20:02),非栅格档(20:00)
    for (const row of body.items) {
      expect(row.current).not.toBeNull();
      expect(row.current?.endsAt).toBe(slotIso(0, 40, 'end'));
    }
    // 同时间按频道名称/稳定标识:首页应含最小的频道号,且按 id 升序稳定
    const ids = body.items.map((row) => row.media.id);
    expect(ids).toEqual([...ids].sort());
    // 排序:除 ch001(加播 20:02~21:02,endsAt 最晚)外全部 endsAt=20:30 → ch001 在全区最后
    const lastPageNo = Math.ceil(WITH_EPG.length / 50);
    const lastPage = await getChannels({ section: 'now', page: lastPageNo, pageSize: 50 });
    const lastRow = (lastPage.body as ChannelPageDto).items.at(-1);
    expect(lastRow?.media.id).toBe(scaleChannelMediaId(1));
    // ch001 加播 20:02~21:02 CST = 12:02~13:02 UTC(重叠取 startsAt 最近)
    expect(lastRow?.current?.startsAt).toBe(new Date(Date.UTC(2026, 10, 4, 12, 2, 0)).toISOString());
    expect(lastRow?.current?.endsAt).toBe(new Date(Date.UTC(2026, 10, 4, 13, 2, 0)).toISOString());
  });

  it('section=next:即将播放按下一节目开始时间排序(全部 20:30 档,同时间按名称/标识)', async () => {
    const res = await getChannels({ section: 'next', page: 1, pageSize: 50 });
    expect(res.status).toBe(200);
    const body = res.body as ChannelPageDto;
    expect(body.total).toBe(WITH_EPG.length);
    for (const row of body.items) {
      expect(row.next?.startsAt).toBe(slotIso(0, 41, 'start'));
      expect(row.next?.endsAt).toBe(slotIso(0, 41, 'end'));
    }
    const ids = body.items.map((row) => row.media.id);
    expect(ids).toEqual([...ids].sort());
  });

  it('section=all:包含无 EPG 可用频道(current/next=null 频道仍在),分页可遍历全集', async () => {
    const pages = await getAllChannels();
    const allIds = pages.flatMap((page) => page.items.map((row) => row.media.id));
    expect(pages[0]?.total).toBe(AVAILABLE.length);
    expect(allIds).toHaveLength(AVAILABLE.length);
    for (const no of WITHOUT_EPG) {
      const row = pages.flatMap((page) => page.items).find((item) => item.media.id === scaleChannelMediaId(no));
      expect(row).toBeDefined();
      expect(row?.current).toBeNull();
      expect(row?.next).toBeNull();
      expect(row?.groupLabel).toBe('其他');
    }
    // 不可用频道(15 号)绝不出现
    expect(allIds).not.toContain(scaleChannelMediaId(15));
    // 集合排序稳定:名称+标识升序(夹具标题「夹具频道 NNN」与 id 同序)
    expect(allIds).toEqual([...allIds].sort());
  });

  it('section=group + groupKey:仅该主分组频道;未知 groupKey 200 空列表;缺 groupKey 不缩小范围', async () => {
    const groups = await request(http()).get('/api/public/live/groups');
    const yangshi = (groups.body as GroupPageDto).items.find((item) => item.label === '央视');
    expect(yangshi).toBeDefined();
    const filtered = await getChannels({ section: 'group', groupKey: yangshi?.key ?? '', page: 1, pageSize: 50 });
    expect(filtered.status).toBe(200);
    const body = filtered.body as ChannelPageDto;
    expect(body.items.every((row) => row.groupLabel === '央视')).toBe(true);
    // 与全量分组的交叉校验:group 区计数 == all 区该分组计数
    const pages = await getAllChannels();
    const expected = pages
      .flatMap((page) => page.items)
      .filter((row) => row.groupLabel === '央视')
      .map((row) => row.media.id)
      .sort();
    const collected: string[] = [];
    for (let page = 1; page <= 10; page += 1) {
      const res = await getChannels({ section: 'group', groupKey: yangshi?.key ?? '', page, pageSize: 50 });
      const pageBody = res.body as ChannelPageDto;
      collected.push(...pageBody.items.map((row) => row.media.id));
      if (pageBody.items.length < 50) {
        break;
      }
    }
    expect(collected.sort()).toEqual(expected);

    const unknown = await getChannels({ section: 'group', groupKey: 'grp-ffffffffffffffffffff' });
    expect(unknown.status).toBe(200);
    expect((unknown.body as ChannelPageDto).items).toEqual([]);
    expect((unknown.body as ChannelPageDto).total).toBe(0);

    const noKey = await getChannels({ section: 'group' });
    expect(noKey.status).toBe(200);
    expect((noKey.body as ChannelPageDto).total).toBe(AVAILABLE.length);
  });

  it('q 搜索与分页参数:q 匹配频道名;page 越界 200 空列表;默认 pageSize=20', async () => {
    const hit = await getChannels({ q: '夹具频道 001' });
    expect(hit.status).toBe(200);
    expect((hit.body as ChannelPageDto).items.map((row) => row.media.id)).toEqual([scaleChannelMediaId(1)]);
    const miss = await getChannels({ q: '不存在的频道名' });
    expect(miss.status).toBe(200);
    expect((miss.body as ChannelPageDto).total).toBe(0);
    const overPage = await getChannels({ section: 'all', page: 999 });
    expect(overPage.status).toBe(200);
    expect((overPage.body as ChannelPageDto).items).toEqual([]);
    const defaults = await getChannels({ section: 'all' });
    expect((defaults.body as ChannelPageDto).pageSize).toBe(20);
  });

  it('负向:未知 query 字段(伪造 householdId/profileId/isAdmin)一律 400,不扩大公开范围', async () => {
    for (const forged of [{ householdId: 'other' }, { profileId: 'p1' }, { isAdmin: 'true' }, { foo: 'bar' }] as Record<string, string>[]) {
      const res = await getChannels(forged);
      expect(res.status).toBe(400);
      expectProblemContentType(res);
      expect((res.body as { code?: string }).code).toBe('VALIDATION_FAILED');
    }
    const groupsForged = await request(http()).get('/api/public/live/groups').query({ householdId: 'other' });
    expect(groupsForged.status).toBe(400);
    const programmesForged = await request(http())
      .get(`/api/public/media/${scaleChannelMediaId(1)}/programmes`)
      .query({ isAdmin: 'true' });
    expect(programmesForged.status).toBe(400);
  });

  it('负向:pageSize>50 / 非法 section / page<1 / pageSize<1 一律 400', async () => {
    expect((await getChannels({ pageSize: 51 })).status).toBe(400);
    expect((await getChannels({ pageSize: 0 })).status).toBe(400);
    expect((await getChannels({ pageSize: 'abc' })).status).toBe(400);
    expect((await getChannels({ section: 'later' })).status).toBe(400);
    expect((await getChannels({ page: 0 })).status).toBe(400);
    expect((await getChannels({ page: -1 })).status).toBe(400);
  });

  it('GET /public/media/{mediaId}/programmes:available 含不透明 key;非频道 400;无匹配 200 unavailable;未知/不可用 404', async () => {
    const channel = await request(http()).get(`/api/public/media/${scaleChannelMediaId(1)}/programmes`);
    expect(channel.status).toBe(200);
    expect(channel.headers['cache-control']).toBe('no-store');
    const body = channel.body as ExperienceProgrammesDto;
    expect(body.status).toBe('available');
    expect(body.timezone).toBe(SCALE_FIXTURE_TIMEZONE);
    expect(Number.isInteger(body.catalogRevision)).toBe(true);
    expect(() => Date.parse(body.now)).not.toThrow();
    expect(body.current?.key).toMatch(/^pg-[0-9a-f]{24}$/);
    expect(body.current?.title.startsWith('加播特别报道')).toBe(true);
    expect(body.next?.startsAt).toBe(slotIso(0, 41, 'start'));
    // 不携带源身份:programme key 不含 xmltv/来源/路径信息
    const text = JSON.stringify(body);
    expect(text).not.toContain('fx-xmltv');
    expect(text).not.toContain('fx-src');
    expect(text).not.toContain('iptv.scale-fixture.test');

    const vod = await request(http()).get('/api/public/media/fx-vod-001/programmes');
    expect(vod.status).toBe(400);
    expectProblemContentType(vod);

    const noMatch = await request(http()).get(`/api/public/media/${scaleChannelMediaId(197)}/programmes`);
    expect(noMatch.status).toBe(200);
    expect(noMatch.body).toMatchObject({ status: 'unavailable', current: null, next: null });
    expect((noMatch.body as ExperienceProgrammesDto).timezone).toBe(SCALE_FIXTURE_TIMEZONE);

    expect((await request(http()).get('/api/public/media/00000000-0000-4000-8000-000000000000/programmes')).status).toBe(404);
    // 15 号频道存在但不可用:公开目录只暴露可用元数据 → 404 同形
    expect((await request(http()).get(`/api/public/media/${scaleChannelMediaId(15)}/programmes`)).status).toBe(404);
  });

  it('每个响应各自携带同步快照,不要求跨请求 now 相等;响应无个人数据与播放票据', async () => {
    const first = await request(http()).get('/api/public/live/groups');
    const second = await request(http()).get('/api/public/live/groups');
    const firstBody = first.body as GroupPageDto;
    const secondBody = second.body as GroupPageDto;
    for (const body of [firstBody, secondBody]) {
      expect(() => Date.parse(body.now)).not.toThrow();
      expect(body.timezone).toBe(SCALE_FIXTURE_TIMEZONE);
      expect(body.catalogRevision).toBeGreaterThanOrEqual(1);
    }
    const channels = await getChannels({ section: 'all' });
    const programmes = await request(http()).get(`/api/public/media/${scaleChannelMediaId(2)}/programmes`);
    // 三个 envelope 都带快照字段(api.md §2)
    for (const body of [channels.body, programmes.body]) {
      expect(body).toHaveProperty('now');
      expect(body).toHaveProperty('timezone');
      expect(body).toHaveProperty('catalogRevision');
    }
    // 宪章原则三:公共响应不含源地址/来源凭据/票据/Profile 个人数据
    const leakProbe = JSON.stringify([firstBody, channels.body, programmes.body]);
    for (const forbidden of [
      'http://iptv.scale-fixture.test',
      'http://epg.scale-fixture.test',
      'http://nas',
      'fx-src-',
      'token',
      'ticket',
      'password',
      'profileId',
      'householdId',
      'pin',
    ]) {
      expect(leakProbe.toLowerCase()).not.toContain(forbidden.toLowerCase());
    }
  });
});
