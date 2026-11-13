import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { afterEach, describe, expect, it } from 'vitest';
import { ProblemCode } from '@hmp/shared';
import type { INestApplication } from '@nestjs/common';
import { Database } from '@platform/database/database';
import { saveImportSnapshot } from '@contexts/sources/infrastructure/import-snapshot';
import {
  INITIALIZE_BODY,
  cleanupRigs,
  cookiePairOf,
  createNasRootFixture,
  expectProblemContentType,
  initialize,
  login,
  startFreshApp,
  type NasRootFixture,
} from '../helpers';
import { selectMainAndUnlockSettings } from '../helpers-management';

/**
 * T018(US1 契约 e2e):来源管理 —— GET /sources、POST /sources、PATCH /sources/{sourceId}、
 * GET /source-roots,对照 003 contracts/api.md「来源管理」「权限与验证顺序」「错误」节与
 * openapi.yaml Source/SourcePage/CreateSource/PatchSource/Root schema。
 * 判定次序(013-role-differentiated-settings/ADR-0017:来源增删改属常规运维,免当次
 * 主账号密码,ownerPassword 已移出契约 —— strictObject 携带即 400):
 * SessionGuard(401)→ owner(403)→ 严格格式(400)→ 目标归属与许可(404 同形 / 422)→
 * 版本(409)→ 事务(catalogRevision+1、旧 awaiting_confirmation 快照标 stale)。
 * 脱敏:locationLabel 仅远程 origin 主机标签(host[:port])或 rootKey,无 path/query/userinfo;
 * 任何响应不出现 remote_url 原文、绝对路径或 userinfo。
 * 说明:主机名目标的 DNS 级类别校验由刷新期 safe-http-reader 权威执行;创建/修改期仅做
 * 语法级字面校验(协议 + IP 字面类别),故用例不包含「localhost」等主机名回环样本。
 */

const OWNER_PASSWORD = INITIALIZE_BODY.password;

interface SourcesRig {
  app: INestApplication;
  cookie: string;
  sessionId: string;
  householdId: string;
  accountId: string;
  nas: NasRootFixture;
}

const activeRigs: NasRootFixture[] = [];

async function bootstrap(env: Record<string, string> = {}): Promise<SourcesRig> {
  const nas = createNasRootFixture({ rootKey: 'nas-main' });
  activeRigs.push(nas);
  const { app } = await startFreshApp({
    prefix: 'hmp-sources-',
    env: { MEDIA_ROOTS: `nas-main=${nas.rootPath}`, ...env },
  });
  const init = await initialize(app);
  expect(init.status).toBe(201);
  const loggedIn = await login(app, INITIALIZE_BODY.username, OWNER_PASSWORD);
  expect(loggedIn.status).toBe(200);
  const household = await request(app.getHttpServer()).get('/api/household').set('Cookie', cookiePairOf(loggedIn));
  expect(household.status).toBe(200);
  // US8 管理迁移:管理写前置 = 主档案已选 + 设置解锁(零档案时由夹具首建主档案)
  await selectMainAndUnlockSettings(app, cookiePairOf(loggedIn));
  const accountRow = Database.db.prepare("SELECT id FROM account WHERE role = 'owner'").get() as { id: string };
  return {
    app,
    cookie: cookiePairOf(loggedIn),
    sessionId: loggedIn.body.sessionId as string,
    householdId: household.body.id as string,
    accountId: accountRow.id,
    nas,
  };
}

afterEach(() => {
  activeRigs.splice(0).forEach((nas) => nas.cleanup());
});

/* ------------------------------------------------------------------ */
/* 请求辅助                                                            */
/* ------------------------------------------------------------------ */

function getSources(s: SourcesRig, query = ''): Promise<request.Response> {
  return request(s.app.getHttpServer())
    .get(`/api/settings/sources${query}`)
    .set('Cookie', s.cookie)
    .then((r) => r);
}

function postSource(s: SourcesRig, body: Record<string, unknown>): Promise<request.Response> {
  return request(s.app.getHttpServer()).post('/api/settings/sources').set('Cookie', s.cookie).send(body).then((r) => r);
}

function patchSource(s: SourcesRig, sourceId: string, body: Record<string, unknown>): Promise<request.Response> {
  return request(s.app.getHttpServer())
    .patch(`/api/settings/sources/${sourceId}`)
    .set('Cookie', s.cookie)
    .send(body)
    .then((r) => r);
}

function getSourceRoots(s: SourcesRig): Promise<request.Response> {
  return request(s.app.getHttpServer()).get('/api/settings/source-roots').set('Cookie', s.cookie).then((r) => r);
}

interface CreateOverrides {
  kind?: string;
  name?: string;
  remoteUrl?: string;
  enabled?: boolean;
  rootKey?: string;
  relativeDirectory?: string;
  privateAccessApproved?: boolean;
  epgSourceId?: string | null;
}

/** 合法创建体(默认 IPTV;013 起免当次密码);按需覆盖字段。kind=nas 时缺省剥离 remoteUrl(除非显式给出) */
function createBody(overrides: CreateOverrides = {}): Record<string, unknown> {
  const body: Record<string, unknown> = {
    kind: 'iptv',
    name: '直播源',
    remoteUrl: 'http://tv.example.com:8080/live/list.m3u',
    ...overrides,
  };
  if (body.kind === 'nas' && overrides.remoteUrl === undefined) {
    delete body.remoteUrl;
  }
  return body;
}

/** 仅用于期望成功的创建(内部断言 201,失败时输出响应体便于定位) */
async function createSource(s: SourcesRig, overrides: CreateOverrides = {}): Promise<request.Response> {
  const res = await postSource(s, createBody(overrides));
  expect(res.status, `创建前置失败: ${JSON.stringify(res.body)}`).toBe(201);
  return res;
}

/* ------------------------------------------------------------------ */
/* 查库辅助                                                            */
/* ------------------------------------------------------------------ */

interface SourceRow {
  id: string;
  household_id: string;
  kind: string;
  name: string;
  remote_url: string | null;
  root_key: string | null;
  relative_directory: string | null;
  private_access_approved: number;
  epg_source_id: string | null;
  enabled: number;
  version: number;
}

function sourceRowOf(sourceId: string): SourceRow {
  const row = Database.db.prepare('SELECT * FROM media_source WHERE id = ?').get(sourceId) as SourceRow | undefined;
  expect(row, `来源行应存在: ${sourceId}`).toBeDefined();
  return row as SourceRow;
}

function revisionOf(householdId: string): number | undefined {
  const row = Database.db.prepare('SELECT revision FROM catalog_state WHERE household_id = ?').get(householdId) as
    | { revision: number }
    | undefined;
  return row?.revision;
}

function sourceCountInHousehold(householdId: string): number {
  const row = Database.db.prepare('SELECT COUNT(*) AS n FROM media_source WHERE household_id = ?').get(householdId) as {
    n: number;
  };
  return row.n;
}

function parentFailureAttempts(): number | undefined {
  const row = Database.db.prepare('SELECT failed_attempts FROM parent_verification_state').get() as
    | { failed_attempts: number }
    | undefined;
  return row?.failed_attempts;
}

/** 直插异家庭来源(404 同形断言用);返回 iptv 与 epg 两个来源 id */
function insertForeignSources(): { iptvId: string; epgId: string } {
  const now = new Date().toISOString();
  const householdId = randomUUID();
  Database.db
    .prepare('INSERT INTO household (id, name, default_language, timezone, created_at) VALUES (?, ?, ?, ?, ?)')
    .run(householdId, '别家', 'zh-CN', 'Asia/Shanghai', now);
  const iptvId = randomUUID();
  Database.db.prepare(
    "INSERT INTO media_source (id, household_id, kind, name, remote_url, root_key, relative_directory, private_access_approved, epg_source_id, enabled, version, last_success_at, last_job_id, created_at, updated_at) VALUES (?, ?, 'iptv', '别家直播', 'http://foreign.example.tv/a.m3u', NULL, NULL, 0, NULL, 1, 1, NULL, NULL, ?, ?)",
  ).run(iptvId, householdId, now, now);
  const epgId = randomUUID();
  Database.db.prepare(
    "INSERT INTO media_source (id, household_id, kind, name, remote_url, root_key, relative_directory, private_access_approved, epg_source_id, enabled, version, last_success_at, last_job_id, created_at, updated_at) VALUES (?, ?, 'epg', '别家指南', 'https://foreign.example.tv/guide.xml', NULL, NULL, 0, NULL, 1, 1, NULL, NULL, ?, ?)",
  ).run(epgId, householdId, now, now);
  return { iptvId, epgId };
}

/** 直插一条 awaiting_confirmation 刷新任务(满足全部复合外键) */
function insertAwaitingRefresh(s: SourcesRig, sourceId: string): string {
  const id = randomUUID();
  Database.db.prepare(
    "INSERT INTO source_refresh (id, household_id, source_id, initiator_account_id, initiator_session_id, operation_key, status, version, source_version, baseline_revision, snapshot_digest, item_count, summary_json, error_code, created_at, started_at, finished_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, 'awaiting_confirmation', 1, 1, 1, NULL, NULL, NULL, NULL, ?, NULL, NULL, NULL)",
  ).run(id, s.householdId, sourceId, s.accountId, s.sessionId, randomUUID(), new Date().toISOString());
  return id;
}

interface RefreshRow {
  status: string;
  version: number;
}

function refreshRowOf(refreshId: string): RefreshRow {
  const row = Database.db.prepare('SELECT status, version FROM source_refresh WHERE id = ?').get(refreshId) as
    | RefreshRow
    | undefined;
  expect(row, `刷新任务行应存在: ${refreshId}`).toBeDefined();
  return row as RefreshRow;
}

/** SourceDto 全部契约键(openapi Source:additionalProperties=false) */
const SOURCE_DTO_KEYS = [
  'id',
  'kind',
  'name',
  'enabled',
  'version',
  'epgSourceId',
  'locationLabel',
  'lastSuccessAt',
  'lastJobId',
];

describe('T018 来源管理(契约 e2e)', () => {
  afterEach(cleanupRigs);

  it('GET /sources:无会话 401;SourcePage 形状;SourceDto 键集合与脱敏 locationLabel(无 path/query/userinfo)', async () => {
    const s = await bootstrap();
    const anonymous = await request(s.app.getHttpServer()).get('/api/settings/sources');
    expect(anonymous.status).toBe(401);
    expectProblemContentType(anonymous);
    expect(anonymous.body.code).toBe(ProblemCode.SESSION_INVALID);

    const empty = await getSources(s);
    expect(empty.status).toBe(200);
    expect(empty.body).toEqual({ items: [], total: 0, page: 1, pageSize: 20 });

    const created = await createSource(s, {
      remoteUrl: 'http://viewer:topsecret@tv.example.com:8080/live/list.m3u?token=abc',
    });
    const page = await getSources(s);
    expect(page.status).toBe(200);
    expect(page.body.total).toBe(1);
    expect(page.body.items).toHaveLength(1);
    const dto = page.body.items[0];
    expect(Object.keys(dto).sort()).toEqual([...SOURCE_DTO_KEYS].sort());
    expect(dto).toMatchObject({
      id: created.body.id,
      kind: 'iptv',
      name: '直播源',
      enabled: true,
      version: 1,
      epgSourceId: null,
      locationLabel: 'tv.example.com:8080',
      lastSuccessAt: null,
      lastJobId: null,
    });
    const serialized = JSON.stringify(page.body);
    expect(serialized).not.toContain('viewer');
    expect(serialized).not.toContain('topsecret');
    expect(serialized).not.toContain('/live');
    expect(serialized).not.toContain('token=');
    expect(serialized).not.toContain('remoteUrl');
    expect(serialized).not.toContain('remote_url');
    expect(serialized).not.toContain('rootKey');
    expect(serialized).not.toContain('relativeDirectory');
    expect(serialized).not.toContain('privateAccessApproved');
    expect(serialized).not.toContain('householdId');
  });

  it('GET/POST/PATCH sources:admin 角色在 005 settings 边界内允许(Owner/admin + grant;api.md §1)', async () => {
    const s = await bootstrap();
    Database.db.prepare("UPDATE account SET role = 'admin'").run();

    const list = await getSources(s);
    expect(list.status, JSON.stringify(list.body)).toBe(200);

    const created = await postSource(s, createBody());
    expect(created.status).toBe(201);
    expect(created.body.version).toBe(1);

    const patched = await patchSource(s, (created.body as { id: string }).id, {
      expectedVersion: 1,
      name: 'X',
    });
    expect(patched.status).toBe(200);
  });

  it('GET /sources:分页默认 1/20;page/pageSize 切片;非法分页与未知查询键 400', async () => {
    const s = await bootstrap();
    for (let index = 0; index < 3; index += 1) {
      await createSource(s, { name: `源${index}`, remoteUrl: `http://host${index}.example.com/list.m3u` });
    }

    const page1 = await getSources(s, '?page=1&pageSize=2');
    expect(page1.status).toBe(200);
    expect(page1.body).toMatchObject({ total: 3, page: 1, pageSize: 2 });
    expect(page1.body.items).toHaveLength(2);

    const page2 = await getSources(s, '?page=2&pageSize=2');
    expect(page2.body.items).toHaveLength(1);

    const defaultPage = await getSources(s);
    expect(defaultPage.body).toMatchObject({ page: 1, pageSize: 20 });

    // 跨页不重不漏
    const ids = [...page1.body.items, ...page2.body.items].map((item: { id: string }) => item.id);
    expect(new Set(ids).size).toBe(3);

    const invalidCases: Array<[string, string]> = [
      ['page=0', '?page=0'],
      ['page 为负', '?page=-1'],
      ['page 非数字', '?page=abc'],
      ['page 非整数', '?page=1.5'],
      ['pageSize=0', '?pageSize=0'],
      ['pageSize=101', '?pageSize=101'],
      ['未知查询键', '?foo=1'],
    ];
    for (const [label, query] of invalidCases) {
      const res = await getSources(s, query);
      expect(res.status, label).toBe(400);
      expectProblemContentType(res);
      expect(res.body.code, label).toBe(ProblemCode.VALIDATION_FAILED);
    }
  });

  it('POST /sources:创建 IPTV 成功(201;version=1;默认 enabled/privateAccessApproved;catalogRevision 初始→+1;落库 remote_url)', async () => {
    const s = await bootstrap();
    // T062 已落地时 initialize 即有 revision=1;未落地时首次创建前无行 —— 两种基线都按「+1」断言
    const baseline = revisionOf(s.householdId);
    expect(baseline === undefined || baseline === 1).toBe(true);

    const res = await postSource(s, createBody({ privateAccessApproved: true }));
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      kind: 'iptv',
      name: '直播源',
      enabled: true,
      version: 1,
      epgSourceId: null,
      locationLabel: 'tv.example.com:8080',
      lastSuccessAt: null,
      lastJobId: null,
    });
    expect(res.body.id).toEqual(expect.any(String));

    // 事务语义:catalogRevision 基线 +1(全新家庭首次创建 → 2)
    expect(revisionOf(s.householdId)).toBe((baseline ?? 1) + 1);

    expect(sourceRowOf(res.body.id as string)).toMatchObject({
      kind: 'iptv',
      remote_url: 'http://tv.example.com:8080/live/list.m3u',
      root_key: null,
      relative_directory: null,
      private_access_approved: 1,
      epg_source_id: null,
      enabled: 1,
      version: 1,
      household_id: s.householdId,
    });

    // enabled=false / privateAccessApproved 缺省=false
    const disabled = await createSource(s, { name: '停用源', enabled: false });
    expect(disabled.body.enabled).toBe(false);
    expect(sourceRowOf(disabled.body.id as string).private_access_approved).toBe(0);
    expect(revisionOf(s.householdId)).toBe((baseline ?? 1) + 2);
  });

  it('POST /sources:创建 EPG/NAS 成功;NAS locationLabel=rootKey;空 relativeDirectory 合法;子目录合法', async () => {
    const s = await bootstrap();
    const epg = await createSource(s, { kind: 'epg', name: '指南', remoteUrl: 'https://epg.example.com/guide.xml' });
    expect(epg.body.kind).toBe('epg');
    expect(epg.body.locationLabel).toBe('epg.example.com');
    expect(sourceRowOf(epg.body.id as string).remote_url).toBe('https://epg.example.com/guide.xml');

    const nas = await createSource(s, {
      kind: 'nas',
      name: '影库',
      rootKey: 'nas-main',
      relativeDirectory: 'movies/films',
    });
    expect(nas.status).toBe(201);
    expect(nas.body.locationLabel).toBe('nas-main');
    expect(nas.body.version).toBe(1);
    expect(nas.body.epgSourceId).toBeNull();
    expect(sourceRowOf(nas.body.id as string)).toMatchObject({
      remote_url: null,
      root_key: 'nas-main',
      relative_directory: 'movies/films',
    });

    const nasRoot = await createSource(s, {
      kind: 'nas',
      name: '根目录',
      rootKey: 'nas-main',
      relativeDirectory: '',
    });
    expect(nasRoot.status).toBe(201);
    const serialized = JSON.stringify([epg.body, nas.body, nasRoot.body]);
    expect(serialized).not.toContain(s.nas.rootPath);
    expect(serialized).not.toContain('movies/films');
  });

  it('POST /sources:IPTV 关联同家庭 EPG 目标成功;允许关联暂时禁用的 EPG', async () => {
    const s = await bootstrap();
    const epg = await createSource(s, {
      kind: 'epg',
      name: '禁用指南',
      remoteUrl: 'https://epg.example.com/guide.xml',
      enabled: false,
    });
    const iptv = await createSource(s, { name: '带指南直播', epgSourceId: epg.body.id as string });
    expect(iptv.status).toBe(201);
    expect(iptv.body.epgSourceId).toBe(epg.body.id);
    expect(sourceRowOf(iptv.body.id as string).epg_source_id).toBe(epg.body.id);
    expect(revisionOf(s.householdId)).toBe(3);
  });

  it('POST /sources:名称/URL 形态与跨字段格式校验 400(未知字段/kind/名称边界/互斥字段/file: 非远程),不落库', async () => {
    const s = await bootstrap();
    const cases: Array<[string, Record<string, unknown>]> = [
      ['未知顶层字段', { ...createBody(), extra: 1 }],
      ['缺 kind', { name: 'X', remoteUrl: 'http://a.example.com/x' }],
      ['kind 非法', createBody({ kind: 'ftp' })],
      ['缺 name', { kind: 'iptv', remoteUrl: 'http://a.example.com/x' }],
      ['name 空串', createBody({ name: '' })],
      ['name 101 字符', createBody({ name: '名'.repeat(101) })],
      ['iptv 缺 remoteUrl', { kind: 'iptv', name: 'X' }],
      ['iptv 带 rootKey', createBody({ rootKey: 'nas-main' })],
      ['iptv 带 relativeDirectory', createBody({ relativeDirectory: 'x' })],
      ['epg 带 epgSourceId', createBody({ kind: 'epg', remoteUrl: 'https://e.example.com/g.xml', epgSourceId: randomUUID() })],
      ['nas 缺 rootKey', { kind: 'nas', name: 'X', relativeDirectory: '' }],
      ['nas rootKey 空串', { kind: 'nas', name: 'X', rootKey: '', relativeDirectory: '' }],
      ['nas 缺 relativeDirectory', { kind: 'nas', name: 'X', rootKey: 'nas-main' }],
      ['nas 带 remoteUrl', { kind: 'nas', name: 'X', rootKey: 'nas-main', relativeDirectory: '', remoteUrl: 'http://a.example.com/x' }],
      ['nas 带 epgSourceId(null)', { kind: 'nas', name: 'X', rootKey: 'nas-main', relativeDirectory: '', epgSourceId: null }],
      ['remoteUrl 非法 URL', createBody({ remoteUrl: 'not-a-url' })],
      ['remoteUrl 缺主机', createBody({ remoteUrl: 'http://' })],
      ['remoteUrl 非远程 scheme(file:)', createBody({ remoteUrl: 'file:///etc/hosts' })],
      ['remoteUrl 主机含掩码星号', createBody({ remoteUrl: 'http://***:8080/x' })],
      ['epgSourceId 非 uuid', createBody({ epgSourceId: 'abc' })],
      ['enabled 非布尔', { ...createBody(), enabled: 'yes' }],
    ];
    for (const [label, body] of cases) {
      const res = await postSource(s, body);
      expect(res.status, label).toBe(400);
      expectProblemContentType(res);
      expect(res.body.code, label).toBe(ProblemCode.VALIDATION_FAILED);
    }
    // 名称下边界(1 字符)与上边界(100 字符)合法
    expect((await createSource(s, { name: 'A' })).status).toBe(201);
    expect((await createSource(s, { name: '名'.repeat(100) })).status).toBe(201);
    // 格式失败不消耗家长验证次数
    expect(parentFailureAttempts()).toBeUndefined();
    expect(sourceCountInHousehold(s.householdId)).toBe(2);
  });

  it('POST /sources:013 免当次密码语义(缺密码照常创建 201;携带 ownerPassword 字段 strictObject 400,不落库)', async () => {
    const s = await bootstrap();
    // 缺失密码 → 常规运维免当次密码,照常创建
    const noPassword = await postSource(s, { ...createBody(), ownerPassword: undefined });
    expect(noPassword.status, JSON.stringify(noPassword.body)).toBe(201);

    // 携带 ownerPassword 字段 → 契约已移除该字段,strictObject 拒绝 400
    const withPassword = await postSource(s, { ...createBody(), ownerPassword: '' });
    expect(withPassword.status).toBe(400);
    expect(withPassword.body.code).toBe(ProblemCode.VALIDATION_FAILED);

    const withWrongPassword = await postSource(s, {
      ...createBody({ remoteUrl: 'http://tv.example.com:8080/other.m3u' }),
      ownerPassword: 'not-the-password',
    });
    expect(withWrongPassword.status).toBe(400);
    expect(withWrongPassword.body.code).toBe(ProblemCode.VALIDATION_FAILED);
    expect(String(withWrongPassword.body.detail ?? '')).not.toContain('not-the-password');

    // 全程无密码验证计数推进(常规端点不再触达 parent_verification_state)
    expect(parentFailureAttempts()).toBeUndefined();
    expect(sourceCountInHousehold(s.householdId)).toBe(1);
  });

  it('POST /sources:远程目标字面拒绝 422 SOURCE_TARGET_DENIED(回环/元数据/未指定/多播/广播/IPv4-mapped/非 http(s));detail 不回显 URL', async () => {
    const s = await bootstrap();
    const deniedUrls = [
      'http://127.0.0.1:8080/live.m3u',
      'http://127.9.9.9/x',
      'http://169.254.169.254/latest/meta-data',
      'http://169.254.10.1/x',
      'http://0.0.0.0/',
      'http://[::1]/x',
      'http://[::]/x',
      'http://224.0.0.1/x',
      'http://239.1.1.1/x',
      'http://255.255.255.255/x',
      'http://[::ffff:127.0.0.1]/x',
      'http://[::ffff:192.168.1.5]/x',
      'ftp://media.example.com/list.m3u',
    ];
    for (const url of deniedUrls) {
      const res = await postSource(s, createBody({ remoteUrl: url }));
      expect(res.status, url).toBe(422);
      expectProblemContentType(res);
      expect(res.body.code, url).toBe(ProblemCode.SOURCE_TARGET_DENIED);
      expect(String(res.body.detail ?? ''), url).not.toContain('://');
    }
    expect(sourceCountInHousehold(s.householdId)).toBe(0);
    // 全部失败不推进目录修订(无行即仍无行;T062 已落地时保持初始 1)
    expect(revisionOf(s.householdId) ?? 1).toBeLessThanOrEqual(1);
  });

  it('POST /sources:NAS 目标拒绝 422(rootKey 不在 MEDIA_ROOTS;relativeDirectory 非法形态)', async () => {
    const s = await bootstrap();
    const cases: Array<[string, Record<string, unknown>]> = [
      ['rootKey 未授权', { kind: 'nas', name: 'X', rootKey: 'nope', relativeDirectory: '' }],
      ['相对目录 ..', { kind: 'nas', name: 'X', rootKey: 'nas-main', relativeDirectory: '../escape' }],
      ['相对目录内嵌 ..', { kind: 'nas', name: 'X', rootKey: 'nas-main', relativeDirectory: 'a/../b' }],
      ['绝对路径', { kind: 'nas', name: 'X', rootKey: 'nas-main', relativeDirectory: '/etc' }],
      ['盘符', { kind: 'nas', name: 'X', rootKey: 'nas-main', relativeDirectory: 'C:\\data' }],
      ['反斜杠', { kind: 'nas', name: 'X', rootKey: 'nas-main', relativeDirectory: 'a\\b' }],
      ['空字节', { kind: 'nas', name: 'X', rootKey: 'nas-main', relativeDirectory: 'a\0b' }],
      ['空段(尾斜杠)', { kind: 'nas', name: 'X', rootKey: 'nas-main', relativeDirectory: 'a/' }],
      ['点段', { kind: 'nas', name: 'X', rootKey: 'nas-main', relativeDirectory: 'a/./b' }],
    ];
    for (const [label, overrides] of cases) {
      const res = await postSource(s, createBody(overrides));
      expect(res.status, label).toBe(422);
      expect(res.body.code, label).toBe(ProblemCode.SOURCE_TARGET_DENIED);
    }
    expect(sourceCountInHousehold(s.householdId)).toBe(0);
  });

  it('POST /sources:epgSourceId 目标校验(不存在 404;跨家庭 404 同形;同家庭非 EPG 类型 400)', async () => {
    const s = await bootstrap();
    const otherIptv = await createSource(s, { name: '另一直播' });
    const foreign = insertForeignSources();

    const missing = await postSource(s, createBody({ name: '坏目标', epgSourceId: randomUUID() }));
    expect(missing.status).toBe(404);
    expect(missing.body.code).toBe(ProblemCode.NOT_FOUND);

    const cross = await postSource(s, createBody({ name: '跨家庭', epgSourceId: foreign.epgId }));
    expect(cross.status).toBe(404);
    expect(cross.body).toEqual(missing.body); // 不泄漏归属

    const wrongKind = await postSource(s, createBody({ name: '错类型', epgSourceId: otherIptv.body.id }));
    expect(wrongKind.status).toBe(400);
    expect(wrongKind.body.code).toBe(ProblemCode.VALIDATION_FAILED);

    expect(sourceCountInHousehold(s.householdId)).toBe(1);
  });

  it('PATCH /sources/{id}:成功更新(改名/停用;省略字段保留;version+1;catalogRevision+1;locationLabel 不变)', async () => {
    const s = await bootstrap();
    const source = await createSource(s, { remoteUrl: 'https://tv.example.com/list.m3u' });
    const sourceId = source.body.id as string;
    const baseline = revisionOf(s.householdId) ?? 1;

    const res = await patchSource(s, sourceId, {
      expectedVersion: 1,
      name: '改名源',
      enabled: false,
    });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      id: sourceId,
      name: '改名源',
      enabled: false,
      version: 2,
      kind: 'iptv',
      locationLabel: 'tv.example.com',
      epgSourceId: null,
      lastSuccessAt: null,
      lastJobId: null,
    });
    expect(revisionOf(s.householdId)).toBe(baseline + 1);

    // 只改 name:enabled/remoteUrl 保留
    const keep = await patchSource(s, sourceId, {
      expectedVersion: 2,
      name: '再改名',
    });
    expect(keep.status).toBe(200);
    expect(keep.body).toMatchObject({ name: '再改名', enabled: false, version: 3, locationLabel: 'tv.example.com' });
    expect(revisionOf(s.householdId)).toBe(baseline + 2);
  });

  it('PATCH /sources/{id}:格式与不可变字段(kind/rootKey/relativeDirectory/未知字段/remoteUrl null·空串·掩码 → 400),不落库', async () => {
    const s = await bootstrap();
    const source = await createSource(s);
    const sourceId = source.body.id as string;
    const base = { expectedVersion: 1 };
    const cases: Array<[string, Record<string, unknown>]> = [
      ['缺 expectedVersion', { name: 'X' }],
      ['expectedVersion 0', { ...base, expectedVersion: 0 }],
      ['expectedVersion 非整数', { ...base, expectedVersion: 1.5 }],
      ['携带 kind', { ...base, kind: 'nas' }],
      ['携带 rootKey', { ...base, rootKey: 'nas-main' }],
      ['携带 relativeDirectory', { ...base, relativeDirectory: 'x' }],
      ['未知字段', { ...base, extra: 1 }],
      ['remoteUrl null', { ...base, remoteUrl: null }],
      ['remoteUrl 空串', { ...base, remoteUrl: '' }],
      ['remoteUrl 掩码', { ...base, remoteUrl: '***' }],
      ['remoteUrl 掩码变体', { ...base, remoteUrl: 'http://***:8080/x' }],
      ['name 空串', { ...base, name: '' }],
      ['name 101 字符', { ...base, name: '名'.repeat(101) }],
      ['enabled 非布尔', { ...base, enabled: 1 }],
    ];
    for (const [label, body] of cases) {
      const res = await patchSource(s, sourceId, body);
      expect(res.status, label).toBe(400);
      expectProblemContentType(res);
      expect(res.body.code, label).toBe(ProblemCode.VALIDATION_FAILED);
    }
    expect(sourceRowOf(sourceId)).toMatchObject({ version: 1, name: '直播源' });
    expect(parentFailureAttempts()).toBeUndefined();
  });

  it('PATCH /sources/{id}:版本冲突 409 SOURCE_VERSION_CONFLICT(过期 expectedVersion;来源不变)', async () => {
    const s = await bootstrap();
    const source = await createSource(s);
    const sourceId = source.body.id as string;
    await patchSource(s, sourceId, { expectedVersion: 1, name: 'v2' });

    const stale = await patchSource(s, sourceId, {
      expectedVersion: 1,
      name: '过期写入',
    });
    expect(stale.status, JSON.stringify(stale.body)).toBe(409);
    expectProblemContentType(stale);
    expect(stale.body.code).toBe(ProblemCode.SOURCE_VERSION_CONFLICT);
    expect(sourceRowOf(sourceId)).toMatchObject({ name: 'v2', version: 2 });
  });

  it('PATCH /sources/{id}:换远程地址须重新 privateAccessApproved(不继承;成功后 locationLabel 更新;新地址字面拒绝 422)', async () => {
    const s = await bootstrap();
    const source = await createSource(s, { remoteUrl: 'http://old.example.com:9000/a.m3u' });
    const sourceId = source.body.id as string;

    // 未同时批准 → 422(不继承旧目标许可)
    const denied = await patchSource(s, sourceId, {
      expectedVersion: 1,
      remoteUrl: 'http://new.example.com/b.m3u',
    });
    expect(denied.status).toBe(422);
    expect(denied.body.code).toBe(ProblemCode.SOURCE_TARGET_DENIED);
    expect(sourceRowOf(sourceId)).toMatchObject({ remote_url: 'http://old.example.com:9000/a.m3u', version: 1 });

    // 显式批准 → 成功
    const approved = await patchSource(s, sourceId, {
      expectedVersion: 1,
      remoteUrl: 'http://new.example.com/b.m3u',
      privateAccessApproved: true,
    });
    expect(approved.status).toBe(200);
    expect(approved.body).toMatchObject({ locationLabel: 'new.example.com', version: 2 });
    expect(sourceRowOf(sourceId)).toMatchObject({
      remote_url: 'http://new.example.com/b.m3u',
      private_access_approved: 1,
    });

    // 再次换地址:旧批准不能继承 → 422;显式 false 同样拒绝
    const inherit = await patchSource(s, sourceId, {
      expectedVersion: 2,
      remoteUrl: 'http://third.example.com/c.m3u',
    });
    expect(inherit.status).toBe(422);
    expect(inherit.body.code).toBe(ProblemCode.SOURCE_TARGET_DENIED);
    const explicitFalse = await patchSource(s, sourceId, {
      expectedVersion: 2,
      remoteUrl: 'http://third.example.com/c.m3u',
      privateAccessApproved: false,
    });
    expect(explicitFalse.status).toBe(422);
    expect(sourceRowOf(sourceId).version).toBe(2);

    // 新地址字面拒绝(即使批准)
    const loopback = await patchSource(s, sourceId, {
      expectedVersion: 2,
      remoteUrl: 'http://127.0.0.1/x',
      privateAccessApproved: true,
    });
    expect(loopback.status).toBe(422);
    expect(loopback.body.code).toBe(ProblemCode.SOURCE_TARGET_DENIED);

    // 地址不变的批准开关本身可改
    const toggle = await patchSource(s, sourceId, {
      expectedVersion: 2,
      privateAccessApproved: false,
    });
    expect(toggle.status).toBe(200);
    expect(sourceRowOf(sourceId)).toMatchObject({
      remote_url: 'http://new.example.com/b.m3u',
      private_access_approved: 0,
      version: 3,
    });
  });

  it('PATCH /sources/{id}:epgSourceId 更新(设置/解除 null;EPG/NAS 携带字段 400;自引用 400;非 EPG 目标 400;不存在/跨家庭 404 同形;NAS 禁改远程)', async () => {
    const s = await bootstrap();
    const iptv = await createSource(s, { name: '主直播' });
    const iptvId = iptv.body.id as string;
    const epg = await createSource(s, { kind: 'epg', name: '指南', remoteUrl: 'https://e.example.com/g.xml' });
    const epgId = epg.body.id as string;
    const nas = await createSource(s, { kind: 'nas', name: '影库', rootKey: 'nas-main', relativeDirectory: '' });
    const nasId = nas.body.id as string;
    const foreign = insertForeignSources();
    const base = {};

    const linked = await patchSource(s, iptvId, { ...base, expectedVersion: 1, epgSourceId: epgId });
    expect(linked.status).toBe(200);
    expect(linked.body).toMatchObject({ epgSourceId: epgId, version: 2 });

    const cleared = await patchSource(s, iptvId, { ...base, expectedVersion: 2, epgSourceId: null });
    expect(cleared.status).toBe(200);
    expect(cleared.body.epgSourceId).toBeNull();

    // 自引用与同家庭非 EPG 目标 → 400(均不写入)
    const self = await patchSource(s, iptvId, { ...base, expectedVersion: 3, epgSourceId: iptvId });
    expect(self.status).toBe(400);
    expect(self.body.code).toBe(ProblemCode.VALIDATION_FAILED);
    const wrongKindTarget = await patchSource(s, iptvId, { ...base, expectedVersion: 3, epgSourceId: nasId });
    expect(wrongKindTarget.status).toBe(400);
    expect(wrongKindTarget.body.code).toBe(ProblemCode.VALIDATION_FAILED);

    // 不存在/跨家庭 → 404 同形
    const missing = await patchSource(s, iptvId, { ...base, expectedVersion: 3, epgSourceId: randomUUID() });
    expect(missing.status).toBe(404);
    expect(missing.body.code).toBe(ProblemCode.NOT_FOUND);
    const cross = await patchSource(s, iptvId, { ...base, expectedVersion: 3, epgSourceId: foreign.epgId });
    expect(cross.status).toBe(404);
    expect(cross.body).toEqual(missing.body);

    // EPG/NAS 来源携带 epgSourceId 字段(含 null)→ 400
    const onEpg = await patchSource(s, epgId, { ...base, expectedVersion: 1, epgSourceId: null });
    expect(onEpg.status).toBe(400);
    const onNas = await patchSource(s, nasId, { ...base, expectedVersion: 1, epgSourceId: null });
    expect(onNas.status).toBe(400);

    // NAS 不可改远程地址
    const nasRemote = await patchSource(s, nasId, {
      ...base,
      expectedVersion: 1,
      remoteUrl: 'http://x.example.com/a.m3u',
    });
    expect(nasRemote.status).toBe(400);
    expect(sourceRowOf(nasId).remote_url).toBeNull();
    expect(sourceRowOf(iptvId)).toMatchObject({ epg_source_id: null, version: 3 });
  });

  it('PATCH /sources/{id}:该来源 awaiting_confirmation 任务标 stale 且任务 version+1;同事务 catalogRevision+1', async () => {
    const s = await bootstrap();
    const source = await createSource(s);
    const sourceId = source.body.id as string;
    const refreshId = insertAwaitingRefresh(s, sourceId);
    const baseline = revisionOf(s.householdId) ?? 1;

    const res = await patchSource(s, sourceId, { expectedVersion: 1, name: '触陈旧' });
    expect(res.status).toBe(200);
    expect(refreshRowOf(refreshId)).toMatchObject({ status: 'stale', version: 2 });
    expect(revisionOf(s.householdId)).toBe(baseline + 1);
  });

  it('PATCH /sources/{id}:目标 404 同形(不存在/跨家庭统一 404;013 起免当次密码,携带密码字段 400 不改写)', async () => {
    const s = await bootstrap();
    await createSource(s);
    const foreign = insertForeignSources();

    const missing = await patchSource(s, randomUUID(), {
      expectedVersion: 1,
      name: 'X',
    });
    expect(missing.status).toBe(404);
    expect(missing.body.code).toBe(ProblemCode.NOT_FOUND);

    const cross = await patchSource(s, foreign.iptvId, {
      expectedVersion: 1,
      name: 'X',
    });
    expect(cross.status).toBe(404);
    expect(cross.body).toEqual(missing.body);

    // 携带已移除的 ownerPassword 字段 → strictObject 400(不落库)
    const withPassword = await patchSource(s, foreign.iptvId, {
      ownerPassword: 'nope',
      expectedVersion: 1,
      name: 'X',
    });
    expect(withPassword.status).toBe(400);
    expect(withPassword.body.code).toBe(ProblemCode.VALIDATION_FAILED);

    // 跨家庭来源 + 不带密码 → 仍 404 同形(免密码不改变归属判定)
    const noPwd = await patchSource(s, foreign.iptvId, { expectedVersion: 1, name: 'X' });
    expect(noPwd.status).toBe(404);
    expect(noPwd.body.code).toBe(ProblemCode.NOT_FOUND);
  });

  it('GET /source-roots:无会话 401;RootDto(rootKey+label)不含绝对路径;admin 允许;未配置根为空数组', async () => {
    const s = await bootstrap();
    const anonymous = await request(s.app.getHttpServer()).get('/api/settings/source-roots');
    expect(anonymous.status).toBe(401);
    expect(anonymous.body.code).toBe(ProblemCode.SESSION_INVALID);

    const res = await getSourceRoots(s);
    expect(res.status).toBe(200);
    expect(res.body).toEqual([{ rootKey: 'nas-main', label: 'nas-main' }]);
    const serialized = JSON.stringify(res.body);
    expect(serialized).not.toContain(s.nas.rootPath);
    expect(serialized).not.toContain('/');

    Database.db.prepare("UPDATE account SET role = 'admin'").run();
    const adminAllowed = await getSourceRoots(s);
    // 005 settings 边界 = owner/admin:admin 允许读取(旧 owner-only 前提已被 005 取代)
    expect(adminAllowed.status).toBe(200);

    const noRoots = await bootstrap({ MEDIA_ROOTS: '' });
    const emptyRes = await getSourceRoots(noRoots);
    expect(emptyRes.status).toBe(200);
    expect(emptyRes.body).toEqual([]);
  });
});


/* ------------------------------------------------------------------ */
/* 021-source-governance:归档/恢复/快照/治理清理                        */
/* ------------------------------------------------------------------ */

function archiveSource(s: SourcesRig, sourceId: string, expectedVersion: number): Promise<request.Response> {
  return request(s.app.getHttpServer())
    .post(`/api/settings/sources/${sourceId}/archive`)
    .set('Cookie', s.cookie)
    .send({ expectedVersion })
    .then((r) => r);
}

function restoreSource(s: SourcesRig, sourceId: string, expectedVersion: number): Promise<request.Response> {
  return request(s.app.getHttpServer())
    .post(`/api/settings/sources/${sourceId}/restore`)
    .set('Cookie', s.cookie)
    .send({ expectedVersion })
    .then((r) => r);
}

function purgeSource(s: SourcesRig, sourceId: string, expectedVersion: number): Promise<request.Response> {
  return request(s.app.getHttpServer())
    .post(`/api/settings/governance/archived-sources/${sourceId}/purge`)
    .set('Cookie', s.cookie)
    .send({ expectedVersion })
    .then((r) => r);
}

function cleanup(s: SourcesRig, body: Record<string, unknown>): Promise<request.Response> {
  return request(s.app.getHttpServer())
    .post('/api/settings/governance/cleanup')
    .set('Cookie', s.cookie)
    .send(body)
    .then((r) => r);
}

describe('021 · 来源归档/恢复/永久清理', () => {
  it('归档后列表隐藏、恢复保持停用、再次归档后永久清理删除来源', async () => {
    const s = await bootstrap();
    const created = await createSource(s, { name: '待归档源' });
    const sourceId = created.body.id as string;
    expect(created.body.version).toBe(1);

    const archived = await archiveSource(s, sourceId, 1);
    expect(archived.status).toBe(204);
    const afterArchive = await getSources(s);
    expect(afterArchive.status).toBe(200);
    expect(afterArchive.body.items.map((item: { id: string }) => item.id)).not.toContain(sourceId);
    const row = Database.db
      .prepare(
        `SELECT sa.archived_at AS archivedAt, ms.enabled, ms.version
           FROM media_source ms
           JOIN source_archive sa ON sa.household_id = ms.household_id AND sa.source_id = ms.id
          WHERE ms.id = ?`,
      )
      .get(sourceId) as { archivedAt: string; enabled: number; version: number };
    expect(row.archivedAt).not.toBeNull();
    expect(row.enabled).toBe(0);
    expect(row.version).toBe(2);

    const restored = await restoreSource(s, sourceId, 2);
    expect(restored.status).toBe(204);
    const afterRestore = await getSources(s);
    expect(afterRestore.body.items.map((item: { id: string }) => item.id)).toContain(sourceId);
    expect(
      (afterRestore.body.items as Array<{ id: string; enabled: boolean }>).find((item) => item.id === sourceId)?.enabled,
    ).toBe(false);

    // 恢复后版本=3;再次归档 → 版本=4;永久清理(归档态)
    expect((await archiveSource(s, sourceId, 3)).status).toBe(204);
    // 终态刷新行 + media_source.last_job_id 复合外键:清理必须先解引用再删任务
    Database.db
      .prepare(
        `INSERT INTO source_refresh
          (id, household_id, source_id, initiator_account_id, initiator_session_id, operation_key, status, version, source_version, baseline_revision, created_at)
         VALUES ('r-old', ?, ?, ?, ?, 'op-old', 'succeeded', 2, 1, 1, '2026-01-01T00:00:00.000Z')`,
      )
      .run(s.householdId, sourceId, s.accountId, s.sessionId);
    Database.db.prepare('UPDATE media_source SET last_job_id = ? WHERE id = ?').run('r-old', sourceId);

    // 真实库回归:历史播放会话以 NO ACTION 引用 playback_source,直接删线路会
    // `FOREIGN KEY constraint failed`;清理必须先解绑会话(保留观看记录)。
    const sealedAt = '2026-11-13T08:00:00.000Z';
    const owner = Database.db
      .prepare('SELECT p.id AS profileId, d.id AS deviceId, ds.id AS deviceSessionId FROM profile p, device d, device_session ds WHERE p.household_id = ? LIMIT 1')
      .get(s.householdId) as { profileId: string; deviceId: string; deviceSessionId: string };
    const mediaId = randomUUID();
    Database.db
      .prepare(
        `INSERT INTO media_item (id, household_id, type, title, version, created_at, updated_at)
         VALUES (?, ?, 'channel', '清理频道', 1, ?, ?)`,
      )
      .run(mediaId, s.householdId, sealedAt, sealedAt);
    Database.db
      .prepare(
        `INSERT INTO source_entry
          (id, household_id, source_id, identity_kind, identity_digest, first_seen_at, last_seen_at)
         VALUES ('se-purge', ?, ?, 'url', ?, ?, ?)`,
      )
      .run(s.householdId, sourceId, 'a'.repeat(64), sealedAt, sealedAt);
    Database.db
      .prepare(
        `INSERT INTO playback_source
          (id, household_id, source_id, source_entry_id, media_item_id, protocol, location, created_at, updated_at)
         VALUES ('ps-purge', ?, ?, 'se-purge', ?, 'hls', 'http://upstream.example.com/live.m3u8', ?, ?)`,
      )
      .run(s.householdId, sourceId, mediaId, sealedAt, sealedAt);
    Database.db
      .prepare(
        `INSERT INTO playback_session
          (id, household_id, device_session_id, device_id, profile_id, media_id, playback_source_id,
           state, generation, version, position_seconds, created_at, ended_at, last_heartbeat_at)
         VALUES ('sess-purge', ?, ?, ?, ?, ?, 'ps-purge', 'ended', 1, 1, 0, ?, ?, ?)`,
      )
      .run(s.householdId, owner.deviceSessionId, owner.deviceId, owner.profileId, mediaId, sealedAt, sealedAt, sealedAt);

    const purged = await purgeSource(s, sourceId, 4);
    expect(purged.status, JSON.stringify(purged.body)).toBe(200);
    expect(purged.body).toEqual({ deleted: 1, bytesFreed: 0 });
    expect(Database.db.prepare('SELECT 1 FROM media_source WHERE id = ?').get(sourceId)).toBeUndefined();
    // 历史会话保留但已解绑线路(解绑后不再指向被清理的播放资源)
    expect(
      (Database.db.prepare('SELECT playback_source_id AS source FROM playback_session WHERE id = ?').get('sess-purge') as {
        source: string | null;
      }).source,
    ).toBeNull();
  });

  it('陈旧版本/活跃任务/跨家庭边界', async () => {
    const s = await bootstrap();
    const created = await createSource(s);
    const sourceId = created.body.id as string;

    const stale = await archiveSource(s, sourceId, 99);
    expect(stale.status).toBe(409);
    expect(stale.body.code).toBe(ProblemCode.SOURCE_VERSION_CONFLICT);

    Database.db
      .prepare(
        `INSERT INTO source_refresh
          (id, household_id, source_id, initiator_account_id, initiator_session_id, operation_key, status, version, source_version, baseline_revision, created_at)
         VALUES ('r1', ?, ?, ?, ?, 'op-1', 'queued', 1, 1, 1, '2026-11-13T00:00:00.000Z')`,
      )
      .run(s.householdId, sourceId, s.accountId, s.sessionId);
    const busy = await archiveSource(s, sourceId, 1);
    expect(busy.status).toBe(409);
    expect(busy.body.code).toBe('SOURCE_BUSY');
    Database.db.prepare('DELETE FROM source_refresh WHERE id = ?').run('r1');

    const miss = await archiveSource(s, randomUUID(), 1);
    expect(miss.status).toBe(404);
  });
});

describe('021 · 原始导入快照查看/下载', () => {
  it('列表/预览/下载返回解密原文,且不泄漏上游地址', async () => {
    const s = await bootstrap();
    const created = await createSource(s, { name: '快照源' });
    const sourceId = created.body.id as string;
    const capturedAt = '2026-11-13T08:00:00.000Z';
    const snapshotId = saveImportSnapshot({
      householdId: s.householdId,
      sourceId,
      refreshId: 'refresh-1',
      kind: 'iptv',
      raw: Buffer.from('#EXTM3U\n#EXTINF:-1,CCTV-1\nhttp://upstream.example.com/a.m3u8\n', 'utf8'),
      capturedAtIso: capturedAt,
    });

    const list = await request(s.app.getHttpServer())
      .get(`/api/settings/sources/${sourceId}/snapshots`)
      .set('Cookie', s.cookie);
    expect(list.status).toBe(200);
    expect(list.body.items).toHaveLength(1);
    expect(list.body.items[0].id).toBe(snapshotId);
    expect(JSON.stringify(list.body)).not.toContain('upstream.example.com');

    const preview = await request(s.app.getHttpServer())
      .get(`/api/settings/sources/${sourceId}/snapshots/${snapshotId}/preview`)
      .set('Cookie', s.cookie);
    expect(preview.status).toBe(200);
    expect(preview.body.previewText).toContain('#EXTM3U');
    expect(preview.body.truncated).toBe(false);

    const download = await request(s.app.getHttpServer())
      .get(`/api/settings/sources/${sourceId}/snapshots/${snapshotId}/download`)
      .set('Cookie', s.cookie);
    expect(download.status).toBe(200);
    expect(download.headers['content-type']).toContain('text/plain');
    expect(download.text).toContain('http://upstream.example.com/a.m3u8');

    const missing = await request(s.app.getHttpServer())
      .get(`/api/settings/sources/${sourceId}/snapshots/${randomUUID()}/preview`)
      .set('Cookie', s.cookie);
    expect(missing.status).toBe(404);
  });
});

describe('021 · 数据治理概览与清理', () => {
  it('dry-run 不写库;真实清理删除过期节目并写审计', async () => {
    const s = await bootstrap();
    const epg = await createSource(s, {
      kind: 'epg',
      name: '过期节目源',
      remoteUrl: 'http://epg.example.com/guide.xml',
    });
    const sourceId = epg.body.id as string;
    Database.db
      .prepare('INSERT INTO epg_channel (household_id, source_id, xmltv_channel_id, display_name) VALUES (?, ?, ?, ?)')
      .run(s.householdId, sourceId, 'c1', '频道一');
    Database.db
      .prepare(
        `INSERT INTO epg_programme (id, household_id, source_id, xmltv_channel_id, title, starts_at, ends_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run('p-old', s.householdId, sourceId, 'c1', '老节目', '2020-01-01T00:00:00.000Z', '2020-01-01T01:00:00.000Z');

    const overview = await request(s.app.getHttpServer())
      .get('/api/settings/governance/overview')
      .set('Cookie', s.cookie);
    expect(overview.status).toBe(200);
    expect(overview.body.counts.expiredProgrammes).toBe(1);

    const dry = await cleanup(s, { target: 'expired-programmes', retentionDays: 30, dryRun: true });
    expect(dry.status).toBe(200);
    expect(dry.body).toMatchObject({ target: 'expired-programmes', dryRun: true, deleted: 1 });
    expect(Database.db.prepare('SELECT 1 FROM epg_programme WHERE id = ?').get('p-old')).toBeDefined();

    const real = await cleanup(s, { target: 'expired-programmes', retentionDays: 30, dryRun: false });
    expect(real.status).toBe(200);
    expect(real.body.deleted).toBe(1);
    expect(Database.db.prepare('SELECT 1 FROM epg_programme WHERE id = ?').get('p-old')).toBeUndefined();
    expect(
      (Database.db.prepare('SELECT COUNT(*) AS n FROM governance_cleanup_run').get() as { n: number }).n,
    ).toBe(1);

    const bad = await cleanup(s, { target: 'nope', retentionDays: 30, dryRun: true });
    expect(bad.status).toBe(400);
  });
});
