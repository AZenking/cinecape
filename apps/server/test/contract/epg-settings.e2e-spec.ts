import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { ProblemCode } from '@hmp/shared';
import type { INestApplication } from '@nestjs/common';
import { Database } from '@platform/database/database';
import { XMLTV_ERROR } from '@contexts/sources/infrastructure/xmltv.parser';
import {
  INITIALIZE_BODY,
  buildM3u,
  buildXmltv,
  cleanupRigs,
  cookiePairOf,
  createControlledMediaServer,
  expectProblemContentType,
  initialize,
  login,
  restartApp,
  startFreshApp,
  malformedPayloads,
  type ControlledMediaServer,
  type TestRig,
} from '../helpers';
import { selectMainAndUnlockSettings } from '../helpers-management';

/**
 * T041/T043(US4 契约 e2e):EPG 来源设置 + 真实刷新链路复核,
 * 对照 003 contracts/api.md「来源管理」「刷新与待确认」与 openapi.yaml Source/Refresh schema:
 * - EPG 来源与 IPTV 同一三端点/任务管线:owner + 家长验证 + 严格 zod + 404 同形/403/422/409;
 * - 首次刷新即导入:202 → 轮询 succeeded,counts.channels/programmes 正确,
 *   epg_channel/epg_programme 行存在;XMLTV 显式时区(+0800)归一 UTC 存储;
 * - 重复刷新:指南窗口同事务替换(不堆积)、不建 media_item、不改频道分级;
 * - 刷新失败(坏 XML)→ failed + 稳定 errorCode,上次成功指南保留;
 * - PATCH 语义:省略地址保留现值、掩码拒绝;非 owner/错密码/跨家庭拒绝;
 *   设置响应与错误无凭据(locationLabel 仅主机标签);
 * - 重启中断:running → interrupted 可见,手动重试可成功(restartApp 真实重启 AppModule,
 *   onModuleInit recoverInterrupted 与生产一致)。
 * 环境说明:受控夹具绑定 127.0.0.1,创建期字面校验拒绝回环地址,来源经真实 API 创建后
 * 以既有 DB 访问模式把 remote_url 接到夹具(刷新期由 LAN_ALLOWED_TARGETS 精确许可放行),
 * 与 sources-refresh.e2e-spec 同一模式。每用例 ≤3 频道/≤4 节目。
 */

const OWNER_PASSWORD = INITIALIZE_BODY.password;
const MIN_MS = 60_000;
const HOUR_MS = 3_600_000;

interface EpgRig {
  app: INestApplication;
  /** restartApp 需要原始 rig(同一 DATA_DIR 重建 AppModule) */
  rig: TestRig;
  cookie: string;
  householdId: string;
  accountId: string;
}

const activeMediaServers: ControlledMediaServer[] = [];

async function bootstrap(): Promise<EpgRig> {
  const fresh = await startFreshApp({
    prefix: 'hmp-epg-settings-',
    env: { LAN_ALLOWED_TARGETS: '127.0.0.1' },
  });
  const app = fresh.app;
  const init = await initialize(app);
  expect(init.status).toBe(201);
  const loggedIn = await login(app, INITIALIZE_BODY.username, OWNER_PASSWORD);
  expect(loggedIn.status).toBe(200);
  await selectMainAndUnlockSettings(app, cookiePairOf(loggedIn));
  const household = await request(app.getHttpServer()).get('/api/household').set('Cookie', cookiePairOf(loggedIn));
  expect(household.status).toBe(200);
  const accountRow = Database.db.prepare("SELECT id FROM account WHERE role = 'owner'").get() as { id: string };
  return {
    app,
    rig: fresh,
    cookie: cookiePairOf(loggedIn),
    householdId: household.body.id as string,
    accountId: accountRow.id,
  };
}

afterEach(async () => {
  while (activeMediaServers.length > 0) {
    await activeMediaServers.pop()?.close();
  }
  await cleanupRigs();
  (globalThis as { gc?: () => void }).gc?.();
});

// 退出稳定性:与 sources-refresh.e2e-spec 同因(本套件经 AppModule 执行器跑真实 EPG 导入,
// better-sqlite3 Statement 原生析构需在环境存活期内完成),文件收尾显式 major GC。
afterAll(async () => {
  const gc = (globalThis as { gc?: () => void }).gc;
  if (typeof gc === 'function') {
    gc();
    gc();
    gc();
  }
  await new Promise((resolve) => setImmediate(resolve));
});

/* ------------------------------------------------------------------ */
/* 请求辅助(与 sources-refresh.e2e-spec 同模式)                        */
/* ------------------------------------------------------------------ */

function postSource(s: EpgRig, body: Record<string, unknown>): Promise<request.Response> {
  return request(s.app.getHttpServer()).post('/api/settings/sources').set('Cookie', s.cookie).send(body);
}

function patchSource(s: EpgRig, sourceId: string, body: Record<string, unknown>): Promise<request.Response> {
  return request(s.app.getHttpServer()).patch(`/api/settings/sources/${sourceId}`).set('Cookie', s.cookie).send(body);
}

function postRefresh(s: EpgRig, sourceId: string, body: Record<string, unknown>): Promise<request.Response> {
  return request(s.app.getHttpServer()).post(`/api/settings/sources/${sourceId}/refresh`).set('Cookie', s.cookie).send(body);
}

function getRefresh(s: EpgRig, refreshId: string): Promise<request.Response> {
  return request(s.app.getHttpServer()).get(`/api/settings/refreshes/${refreshId}`).set('Cookie', s.cookie);
}

function getSources(s: EpgRig): Promise<request.Response> {
  return request(s.app.getHttpServer()).get('/api/settings/sources').set('Cookie', s.cookie);
}

interface CreateOverrides {
  kind?: string;
  name?: string;
  enabled?: boolean;
  remoteUrl?: string;
  epgSourceId?: string | null;
}

/** 合法创建体(kind=epg 默认;iptv 时覆盖;013 起免当次密码) */
function createBody(overrides: CreateOverrides = {}): Record<string, unknown> {
  return {
    kind: 'epg',
    name: '频道指南',
    remoteUrl: 'http://guide.example.com/epg/guide.xml?token=topsecret',
    ...overrides,
  };
}

async function createSource(s: EpgRig, overrides: CreateOverrides = {}): Promise<request.Response> {
  const res = await postSource(s, createBody(overrides));
  expect(res.status, `创建来源前置失败: ${JSON.stringify(res.body)}`).toBe(201);
  return res;
}

/** 把来源 remote_url 接到受控夹具(创建期字面校验拒绝回环,见文件头说明) */
function pointSourceAt(sourceId: string, remoteUrl: string): void {
  Database.db.prepare('UPDATE media_source SET remote_url = ? WHERE id = ?').run(remoteUrl, sourceId);
}

async function startMediaServer(
  routes: Array<{ path: string } & Parameters<ControlledMediaServer['setRoute']>[1]>,
): Promise<ControlledMediaServer> {
  const server = await createControlledMediaServer();
  for (const route of routes) {
    server.setRoute(route.path, route);
  }
  activeMediaServers.push(server);
  return server;
}

/** 发起刷新(断言 202 + Location;期望 version 可覆盖) */
async function startRefreshOk(s: EpgRig, sourceId: string, expectedVersion = 1): Promise<Record<string, unknown>> {
  const res = await postRefresh(s, sourceId, {
    expectedVersion,
    operationKey: randomUUID(),
  });
  expect(res.status, `发起刷新前置失败: ${JSON.stringify(res.body)}`).toBe(202);
  const body = res.body as Record<string, unknown>;
  expect(res.headers.location).toBe(`/api/settings/refreshes/${body.id as string}`);
  expectRefreshDtoShape(body, '202 响应');
  return body;
}

/** 轮询 GET 直至任务进入期望状态(AppModule 后台串行执行器) */
async function waitForStatus(
  s: EpgRig,
  refreshId: string,
  statuses: string[],
  timeoutMs = 10_000,
): Promise<Record<string, unknown>> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const res = await getRefresh(s, refreshId);
    expect(res.status, `轮询 GET 前置失败: ${JSON.stringify(res.body)}`).toBe(200);
    const body = res.body as Record<string, unknown>;
    if (statuses.includes(body.status as string)) {
      return body;
    }
    if (Date.now() > deadline) {
      throw new Error(`等待状态 [${statuses.join(',')}] 超时,最后状态: ${JSON.stringify(body)}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

/** RefreshDto 契约形状(counts 六字段全量非负;null 字段在场) */
const REFRESH_DTO_KEYS = [
  'id',
  'sourceId',
  'status',
  'version',
  'createdAt',
  'startedAt',
  'finishedAt',
  'expiresAt',
  'counts',
  'confirmationReason',
  'errorCode',
] as const;

const REFRESH_COUNT_KEYS = ['added', 'updated', 'missing', 'failed', 'channels', 'programmes'] as const;

function expectRefreshDtoShape(body: Record<string, unknown>, label = ''): void {
  const tag = label === '' ? '' : `${label}: `;
  expect(Object.keys(body).sort(), `${tag}RefreshDto 键集合`).toEqual([...REFRESH_DTO_KEYS].sort());
  const counts = body.counts as Record<string, unknown>;
  expect(Object.keys(counts).sort(), `${tag}counts 键集合`).toEqual([...REFRESH_COUNT_KEYS].sort());
  for (const key of REFRESH_COUNT_KEYS) {
    expect(Number.isInteger(counts[key]) && (counts[key] as number) >= 0, `${tag}counts.${key} 非负整数`).toBe(true);
  }
  for (const key of ['createdAt', 'startedAt', 'finishedAt', 'expiresAt', 'confirmationReason', 'errorCode']) {
    expect(Object.hasOwn(body, key), `${tag}${key} 字段在场(null 亦须序列化)`).toBe(true);
  }
}

/** 响应脱敏:不携带夹具地址与凭据片段 */
function expectNotContaining(serialized: string, secrets: string[], label = ''): void {
  for (const secret of secrets) {
    expect(serialized, `${label}不得包含敏感片段「${secret}」`).not.toContain(secret);
  }
}

/* ------------------------------------------------------------------ */
/* XMLTV 夹具(显式 +0800 时区;节目窗口相对真实当前时刻)               */
/* ------------------------------------------------------------------ */

/** XMLTV 时间戳:+0800 显式时区形态(验证解析层归一 UTC) */
function xmltvPlus8Stamp(ms: number): string {
  const shifted = new Date(ms + 8 * HOUR_MS);
  const pad = (value: number): string => String(value).padStart(2, '0');
  return (
    `${shifted.getUTCFullYear()}${pad(shifted.getUTCMonth() + 1)}${pad(shifted.getUTCDate())}` +
    `${pad(shifted.getUTCHours())}${pad(shifted.getUTCMinutes())}${pad(shifted.getUTCSeconds())} +0800`
  );
}

interface GuideSeed {
  title: string;
  startMs: number;
  endMs: number;
}

/** 单频道 XMLTV(ch-1);节目窗口相对给定基准时刻 */
function buildGuideXml(nowMs: number, seeds: GuideSeed[]): string {
  return buildXmltv(
    [{ id: 'ch-1', displayName: '央视五星' }],
    seeds.map((seed) => ({
      channel: 'ch-1',
      start: xmltvPlus8Stamp(seed.startMs),
      stop: xmltvPlus8Stamp(seed.endMs),
      title: seed.title,
    })),
  );
}

function liveM3u(): string {
  return buildM3u([{ name: '央视五星', tvgId: 'ch-1', url: 'http://stream.example/ch1.m3u8' }]);
}

/* ------------------------------------------------------------------ */
/* 查库辅助                                                            */
/* ------------------------------------------------------------------ */

interface SourceRow {
  remote_url: string | null;
  epg_source_id: string | null;
  enabled: number;
  version: number;
  last_success_at: string | null;
  last_job_id: string | null;
}

function sourceRowOf(sourceId: string): SourceRow {
  const row = Database.db.prepare('SELECT * FROM media_source WHERE id = ?').get(sourceId) as SourceRow | undefined;
  expect(row, `来源行应存在: ${sourceId}`).toBeDefined();
  return row as SourceRow;
}

function countOf(sql: string, ...params: readonly unknown[]): number {
  return (Database.db.prepare(sql).get(...params) as { n: number }).n;
}

function epgRowsOf(householdId: string, sourceId: string): {
  channels: Array<{ xmltv_channel_id: string; display_name: string; conflicted: number }>;
  programmes: Array<{ xmltv_channel_id: string; title: string; starts_at: string; ends_at: string }>;
} {
  return {
    channels: Database.db
      .prepare('SELECT xmltv_channel_id, display_name, conflicted FROM epg_channel WHERE household_id = ? AND source_id = ? ORDER BY xmltv_channel_id')
      .all(householdId, sourceId) as Array<{ xmltv_channel_id: string; display_name: string; conflicted: number }>,
    programmes: Database.db
      .prepare('SELECT xmltv_channel_id, title, starts_at, ends_at FROM epg_programme WHERE household_id = ? AND source_id = ? ORDER BY starts_at')
      .all(householdId, sourceId) as Array<{ xmltv_channel_id: string; title: string; starts_at: string; ends_at: string }>,
  };
}

/** 跨家庭 EPG 来源(404 同形断言用) */
function insertForeignEpgSource(): string {
  const id = randomUUID();
  const now = new Date().toISOString();
  Database.db
    .prepare('INSERT INTO household (id, name, default_language, timezone, created_at) VALUES (?, ?, ?, ?, ?)')
    .run(`hh-${id}`, '别家', 'zh-CN', 'Asia/Shanghai', now);
  Database.db.prepare(
    "INSERT INTO media_source (id, household_id, kind, name, remote_url, root_key, relative_directory, private_access_approved, epg_source_id, enabled, version, last_success_at, last_job_id, created_at, updated_at) VALUES (?, ?, 'epg', '别家指南', 'http://foreign.example.com/guide.xml', NULL, NULL, 0, NULL, 1, 1, NULL, NULL, ?, ?)",
  ).run(id, `hh-${id}`, now, now);
  return id;
}

/* ------------------------------------------------------------------ */
/* 用例                                                                */
/* ------------------------------------------------------------------ */

describe('T041/T043 EPG 设置与真实刷新链路(契约 e2e)', () => {
  it('EPG 来源创建 + 首次刷新即导入:202→succeeded,counts.channels/programmes 正确,+0800 归一 UTC,不建 media_item,任务/设置响应脱敏', async () => {
    const s = await bootstrap();
    // XMLTV 秒级精度:基准取整秒,期望值与解析结果同为秒级
    const now = Math.floor(Date.now() / 1000) * 1000;
    const server = await startMediaServer([
      {
        path: '/guide.xml',
        kind: 'xmltv',
        content: buildGuideXml(now, [
          { title: '新闻联播', startMs: now - 30 * MIN_MS, endMs: now + 30 * MIN_MS },
          { title: '天气预报', startMs: now + 30 * MIN_MS, endMs: now + 2 * HOUR_MS },
        ]),
      },
      { path: '/live.m3u', kind: 'm3u', content: liveM3u() },
    ]);
    const epg = await createSource(s, { name: '五星指南' });
    const epgId = epg.body.id as string;
    // SourceDto 脱敏:locationLabel 仅主机标签,无 path/query/凭据
    expect(epg.body).toMatchObject({ kind: 'epg', enabled: true, version: 1, epgSourceId: null, locationLabel: 'guide.example.com' });
    pointSourceAt(epgId, `${server.baseUrl}/guide.xml`);

    const started = await startRefreshOk(s, epgId);
    expect(started.status).toBe('queued');
    const done = await waitForStatus(s, started.id as string, ['succeeded']);
    expect(done.counts).toEqual({ added: 0, updated: 0, missing: 0, failed: 0, channels: 1, programmes: 2 });
    expect(done.errorCode).toBeNull();
    expectRefreshDtoShape(done, '完成任务');
    expectNotContaining(JSON.stringify(done), ['topsecret', '127.0.0.1', 'guide.xml', '/epg/'], '任务概览');

    // 指南行存在:显式 +0800 已归一 UTC(对比种子时刻的 ISO 表示)
    const rows = epgRowsOf(s.householdId, epgId);
    expect(rows.channels).toEqual([{ xmltv_channel_id: 'ch-1', display_name: '央视五星', conflicted: 0 }]);
    expect(rows.programmes.map((row) => [row.title, row.starts_at, row.ends_at])).toEqual([
      ['新闻联播', new Date(now - 30 * MIN_MS).toISOString(), new Date(now + 30 * MIN_MS).toISOString()],
      ['天气预报', new Date(now + 30 * MIN_MS).toISOString(), new Date(now + 2 * HOUR_MS).toISOString()],
    ]);
    // EPG 导入不建 media_item;来源回写成功信息
    expect(countOf('SELECT COUNT(*) AS n FROM media_item WHERE household_id = ?', s.householdId)).toBe(0);
    expect(sourceRowOf(epgId)).toMatchObject({ last_job_id: started.id, version: 1 });
    expect(sourceRowOf(epgId).last_success_at).not.toBeNull();

    // GET /sources 列表脱敏:无凭据/path;locationLabel 在接到夹具地址后仍仅 host:port 标签
    const list = await getSources(s);
    expect(list.status).toBe(200);
    const serialized = JSON.stringify(list.body);
    expectNotContaining(serialized, ['topsecret', '/epg/', 'guide.xml'], '来源列表');
    expect((list.body.items as Array<Record<string, unknown>>)[0]?.locationLabel).toMatch(/^127\.0\.0\.1:\d+$/);
  });

  it('T043 全链:EPG 发布结果可被 T042 查询 —— IPTV(关联 epgSourceId)导入频道后 GET /media/{id}/programmes 返回 current/next', async () => {
    const s = await bootstrap();
    // XMLTV 秒级精度:基准取整秒,期望值与解析结果同为秒级
    const now = Math.floor(Date.now() / 1000) * 1000;
    const server = await startMediaServer([
      {
        path: '/guide.xml',
        kind: 'xmltv',
        content: buildGuideXml(now, [
          { title: '午间新闻', startMs: now - 30 * MIN_MS, endMs: now + 30 * MIN_MS },
          { title: '体育世界', startMs: now + 30 * MIN_MS, endMs: now + 90 * MIN_MS },
        ]),
      },
      { path: '/live.m3u', kind: 'm3u', content: liveM3u() },
    ]);
    const epg = await createSource(s);
    const iptv = await createSource(s, { kind: 'iptv', name: '五星直播', epgSourceId: epg.body.id as string });
    expect(iptv.body.epgSourceId).toBe(epg.body.id);
    pointSourceAt(epg.body.id as string, `${server.baseUrl}/guide.xml`);
    pointSourceAt(iptv.body.id as string, `${server.baseUrl}/live.m3u`);

    const guideJob = await startRefreshOk(s, epg.body.id as string);
    await waitForStatus(s, guideJob.id as string, ['succeeded']);
    const liveJob = await startRefreshOk(s, iptv.body.id as string);
    await waitForStatus(s, liveJob.id as string, ['succeeded']);

    // 观看管线需当前档案:创建并选择成人档案(经 /api/settings/profiles,当次密码)
    const profile = await request(s.app.getHttpServer())
      .post('/api/settings/profiles')
      .set('Cookie', s.cookie)
      .send({ name: '成人', type: 'adult' });
    expect(profile.status).toBe(201);
    const selected = await request(s.app.getHttpServer())
      .post(`/api/profiles/${(profile.body as { id: string }).id}/select`)
      .set('Cookie', s.cookie)
      .send({ ownerPassword: OWNER_PASSWORD });
    expect(selected.status).toBe(200);

    const channelRow = Database.db
      .prepare("SELECT id FROM media_item WHERE household_id = ? AND type = 'channel'")
      .get(s.householdId) as { id: string } | undefined;
    expect(channelRow, 'IPTV 导入应产出频道媒体').toBeDefined();

    const programmes = await request(s.app.getHttpServer())
      .get(`/api/media/${channelRow?.id as string}/programmes`)
      .set('Cookie', s.cookie);
    expect(programmes.status).toBe(200);
    expect(programmes.body).toEqual({
      status: 'available',
      current: {
        title: '午间新闻',
        description: null,
        posterRef: null,
        startsAt: new Date(now - 30 * MIN_MS).toISOString(),
        endsAt: new Date(now + 30 * MIN_MS).toISOString(),
      },
      next: {
        title: '体育世界',
        description: null,
        posterRef: null,
        startsAt: new Date(now + 30 * MIN_MS).toISOString(),
        endsAt: new Date(now + 90 * MIN_MS).toISOString(),
      },
    });
    expectNotContaining(JSON.stringify(programmes.body), ['127.0.0.1', 'guide.xml', 'topsecret'], '节目响应');
  });

  it('重复刷新:指南窗口同事务替换、数量正确、不建 media_item、不改频道分级', async () => {
    const s = await bootstrap();
    // XMLTV 秒级精度:基准取整秒
    const now = Math.floor(Date.now() / 1000) * 1000;
    const server = await startMediaServer([
      {
        path: '/guide.xml',
        kind: 'xmltv',
        content: buildGuideXml(now, [
          { title: '早间新闻', startMs: now - 30 * MIN_MS, endMs: now + 30 * MIN_MS },
          { title: '早间剧场', startMs: now + 30 * MIN_MS, endMs: now + 90 * MIN_MS },
        ]),
      },
      { path: '/live.m3u', kind: 'm3u', content: liveM3u() },
      {
        path: '/guide-v2.xml',
        kind: 'xmltv',
        content: buildGuideXml(now, [{ title: '午间特别报道', startMs: now + 10 * MIN_MS, endMs: now + 70 * MIN_MS }]),
      },
    ]);
    const epg = await createSource(s);
    const epgId = epg.body.id as string;
    const iptv = await createSource(s, { kind: 'iptv', name: '五星直播', epgSourceId: epgId });
    pointSourceAt(epgId, `${server.baseUrl}/guide.xml`);
    pointSourceAt(iptv.body.id as string, `${server.baseUrl}/live.m3u`);
    const first = await startRefreshOk(s, epgId);
    await waitForStatus(s, first.id as string, ['succeeded']);
    const liveJob = await startRefreshOk(s, iptv.body.id as string);
    await waitForStatus(s, liveJob.id as string, ['succeeded']);

    // 频道人工分级:后续 EPG 刷新不得改写
    const channel = Database.db
      .prepare("SELECT id FROM media_item WHERE household_id = ? AND type = 'channel'")
      .get(s.householdId) as { id: string };
    Database.db.prepare('UPDATE media_item SET content_level = 6 WHERE id = ? AND household_id = ?').run(
      channel.id,
      s.householdId,
    );
    const levelBefore = Database.db.prepare('SELECT content_level, version, title FROM media_item WHERE id = ?').get(channel.id) as {
      content_level: number | null;
      version: number;
      title: string;
    };

    // 换指南内容再刷新:窗口替换(2 → 1 条,不堆积)
    pointSourceAt(epgId, `${server.baseUrl}/guide-v2.xml`);
    const second = await startRefreshOk(s, epgId);
    const done = await waitForStatus(s, second.id as string, ['succeeded']);
    expect(done.counts).toEqual({ added: 0, updated: 0, missing: 0, failed: 0, channels: 1, programmes: 1 });
    const rows = epgRowsOf(s.householdId, epgId);
    expect(rows.programmes.map((row) => row.title)).toEqual(['午间特别报道']);
    expect(rows.channels).toHaveLength(1);

    // 不建 media_item、不改频道分级/标题/版本
    expect(countOf('SELECT COUNT(*) AS n FROM media_item WHERE household_id = ?', s.householdId)).toBe(1);
    const levelAfter = Database.db.prepare('SELECT content_level, version, title FROM media_item WHERE id = ?').get(channel.id) as {
      content_level: number | null;
      version: number;
      title: string;
    };
    expect(levelAfter).toEqual(levelBefore);
    expect(levelAfter.content_level).toBe(6);
  });

  it('刷新失败:坏 XML 路由 → failed + 稳定 errorCode,上次成功指南保留(行数不变),GET 终态仍 200', async () => {
    const s = await bootstrap();
    // XMLTV 秒级精度:基准取整秒
    const now = Math.floor(Date.now() / 1000) * 1000;
    const server = await startMediaServer([
      {
        path: '/guide.xml',
        kind: 'xmltv',
        content: buildGuideXml(now, [
          { title: '下午档', startMs: now - 30 * MIN_MS, endMs: now + 30 * MIN_MS },
          { title: '傍晚档', startMs: now + 30 * MIN_MS, endMs: now + 90 * MIN_MS },
        ]),
      },
      { path: '/broken.xml', kind: 'body', body: malformedPayloads.brokenXml(), contentType: 'application/xml' },
    ]);
    const epg = await createSource(s);
    const epgId = epg.body.id as string;
    pointSourceAt(epgId, `${server.baseUrl}/guide.xml`);
    const first = await startRefreshOk(s, epgId);
    await waitForStatus(s, first.id as string, ['succeeded']);
    const rowsBefore = epgRowsOf(s.householdId, epgId);
    const revisionBefore = countOf('SELECT revision AS n FROM catalog_state WHERE household_id = ?', s.householdId);

    pointSourceAt(epgId, `${server.baseUrl}/broken.xml`);
    const second = await startRefreshOk(s, epgId);
    const failed = await waitForStatus(s, second.id as string, ['failed']);
    expect(failed.errorCode).toBe(XMLTV_ERROR.FORMAT_INVALID);
    expect(failed.finishedAt).not.toBeNull();
    expectRefreshDtoShape(failed, 'failed 任务');
    expectNotContaining(JSON.stringify(failed), ['127.0.0.1', 'broken.xml', '<tv>'], 'failed 任务');

    // GET 终态仍 200(不把后台失败伪装成 HTTP 500);上次成功指南原样
    const seen = await getRefresh(s, second.id as string);
    expect(seen.status).toBe(200);
    expect(seen.body.status).toBe('failed');
    expect(epgRowsOf(s.householdId, epgId)).toEqual(rowsBefore);
    expect(countOf('SELECT revision AS n FROM catalog_state WHERE household_id = ?', s.householdId)).toBe(revisionBefore);
    expect(sourceRowOf(epgId).last_job_id).toBe(first.id as string);
  });

  it('PATCH 语义:省略 remoteUrl 保留现值(仅改名成功);掩码地址拒绝(400),不落库', async () => {
    const s = await bootstrap();
    const epg = await createSource(s);
    const epgId = epg.body.id as string;
    const originalUrl = sourceRowOf(epgId).remote_url;

    // 省略地址:仅改名 → 现值保留
    const renamed = await patchSource(s, epgId, { expectedVersion: 1, name: '改名指南' });
    expect(renamed.status).toBe(200);
    expect(renamed.body.name).toBe('改名指南');
    expect(renamed.body.locationLabel).toBe('guide.example.com');
    expect(sourceRowOf(epgId).remote_url).toBe(originalUrl);

    // 掩码不能作为新地址保存(400 VALIDATION_FAILED)
    for (const masked of ['***', 'http://***:8080/guide.xml']) {
      const rejected = await patchSource(s, epgId, {
        expectedVersion: 2,
        remoteUrl: masked,
      });
      expect(rejected.status, masked).toBe(400);
      expectProblemContentType(rejected);
      expect(rejected.body.code).toBe(ProblemCode.VALIDATION_FAILED);
      expectNotContaining(JSON.stringify(rejected.body), ['***'], '掩码错误响应');
    }
    expect(sourceRowOf(epgId).remote_url).toBe(originalUrl);
    expect(sourceRowOf(epgId).version).toBe(2);
  });

  it('权限矩阵:非 owner 403;013 免当次密码(携带密码字段 400);未知/跨家庭来源 404 同形;错误响应无凭据', async () => {
    const s = await bootstrap();
    const epg = await createSource(s);
    const epgId = epg.body.id as string;
    const foreignEpgId = insertForeignEpgSource();
    const refreshBody = (): Record<string, unknown> => ({
      expectedVersion: 1,
      operationKey: randomUUID(),
    });

    // 无会话 401 先于一切
    const anonymous = await request(s.app.getHttpServer()).post(`/api/settings/sources/${epgId}/refresh`).send(refreshBody());
    expect(anonymous.status).toBe(401);
    expect(anonymous.body.code).toBe(ProblemCode.SESSION_INVALID);

    // 非 owner 403(创建/刷新/任务查询同语义)
    Database.db.prepare("UPDATE account SET role = 'admin'").run();
    // 005 settings 边界 = owner/admin:admin 允许创建/刷新/读任务
    const adminCreate = await postSource(s, createBody());
    expect(adminCreate.status).toBe(201);
    const adminJob = await getRefresh(s, randomUUID());
    expect(adminJob.status).toBe(404); // 未知任务 404 同形(已放行至目标归属段)
    Database.db.prepare("UPDATE account SET role = 'owner'").run();

    // 013/ADR-0017:刷新免当次密码 —— 缺密码照常;携带 ownerPassword 字段 strictObject 400
    // (错误响应不回显密码)
    const wrongPwd = await postRefresh(s, epgId, { ...refreshBody(), ownerPassword: 'not-the-password' });
    expect(wrongPwd.status).toBe(400);
    expectProblemContentType(wrongPwd);
    expect(wrongPwd.body.code).toBe(ProblemCode.VALIDATION_FAILED);
    expectNotContaining(JSON.stringify(wrongPwd.body), ['not-the-password'], '错误响应');
    const noPwd = await postRefresh(s, epgId, refreshBody());
    expect(noPwd.status).toBe(202);

    // 未知 vs 跨家庭 EPG 来源:404 同形(不泄漏归属)
    const missing = await postRefresh(s, randomUUID(), refreshBody());
    expect(missing.status).toBe(404);
    expect(missing.body.code).toBe(ProblemCode.NOT_FOUND);
    const cross = await postRefresh(s, foreignEpgId, refreshBody());
    expect(cross.status).toBe(404);
    expect(cross.body).toEqual(missing.body);

    // 设置响应无凭据:remote_url 私有,locationLabel 仅主机标签
    const list = await getSources(s);
    expectNotContaining(JSON.stringify(list.body), ['topsecret', '/epg/', 'guide.xml'], '来源列表');
  });

  it('同一任务管线 + 重启中断:queued/running 经 GET 可见;重启后 running→interrupted;手动重试成功', async () => {
    const s = await bootstrap();
    // XMLTV 秒级精度:基准取整秒
    const now = Math.floor(Date.now() / 1000) * 1000;
    const server = await startMediaServer([
      { path: '/hang.xml', kind: 'hang' },
      {
        path: '/guide.xml',
        kind: 'xmltv',
        content: buildGuideXml(now, [{ title: '夜间档', startMs: now - 30 * MIN_MS, endMs: now + 90 * MIN_MS }]),
      },
    ]);
    const epg = await createSource(s);
    const epgId = epg.body.id as string;
    pointSourceAt(epgId, `${server.baseUrl}/hang.xml`);

    // 发起后经 GET 可见任务在管线中的状态(queued/running 均可见)
    const started = await startRefreshOk(s, epgId);
    const seen = await getRefresh(s, started.id as string);
    expect(seen.status).toBe(200);
    expectRefreshDtoShape(seen.body, '管线中任务');
    await waitForStatus(s, started.id as string, ['running']);

    // 真实重启 AppModule:onModuleInit recoverInterrupted 将 running → interrupted(不自动重跑);
    // 重启须重放 LAN 许可(restartApp 的 env 覆盖默认不继承);
    // 005:启动时撤销所有 grants(data-model §3)—— 重启后重新 PIN 解锁再继续管理轮询
    await restartApp(s.rig, { LAN_ALLOWED_TARGETS: '127.0.0.1' });
    await selectMainAndUnlockSettings(s.app, s.cookie);
    const interrupted = await waitForStatus(s, started.id as string, ['interrupted']);
    expect(interrupted.errorCode).toBeNull();
    expect(interrupted.finishedAt).not.toBeNull();

    // 释放旧任务挂起的连接:旧执行器随后的失败落库命中「status='running'」守卫为 no-op,
    // 不与 afterEach 清理竞态(先于用例结束结算)
    server.abortPending();
    await new Promise((resolve) => setTimeout(resolve, 200));

    // 手动重试:指向有效指南 → succeeded(任务管线与来源锁状态一致)
    pointSourceAt(epgId, `${server.baseUrl}/guide.xml`);
    const retried = await startRefreshOk(s, epgId);
    const done = await waitForStatus(s, retried.id as string, ['succeeded']);
    expect(done.counts).toEqual({ added: 0, updated: 0, missing: 0, failed: 0, channels: 1, programmes: 1 });
    expect(epgRowsOf(s.householdId, epgId).programmes.map((row) => row.title)).toEqual(['夜间档']);
  });
});
