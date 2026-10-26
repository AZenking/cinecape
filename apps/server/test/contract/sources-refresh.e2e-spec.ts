import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { ProblemCode } from '@hmp/shared';
import type { INestApplication } from '@nestjs/common';
import { Database } from '../../src/database/database';
import {
  INITIALIZE_BODY,
  buildM3u,
  cleanupRigs,
  cookiePairOf,
  createControlledMediaServer,
  createNasRootFixture,
  expectProblemContentType,
  initialize,
  login,
  malformedPayloads,
  startFreshApp,
  type ControlledMediaServer,
  type NasRootFixture,
} from '../helpers';

/**
 * T019(US1 契约 e2e):刷新执行与待确认 —— POST /sources/{sourceId}/refresh、
 * GET /refreshes/{refreshId}、POST /refreshes/{refreshId}/confirm、POST /refreshes/{refreshId}/discard,
 * 对照 003 contracts/api.md「权限与验证顺序」「刷新与待确认」「错误」节与
 * openapi.yaml RefreshRequest/JobAction/Refresh schema。
 * - 判定次序与来源管理一致:SessionGuard(401)→ owner(403)→ 严格 zod(400)→
 *   家长验证(缺失/空串统一 403 REQUIRED;错误 403 FAILED)→ 会话重验(401)→
 *   目标归属(404 同形)/禁用(422)→ 幂等(409)/版本(409)/同来源互斥(409)/队列(429);
 * - 202 + Location 不等待导入;RefreshDto 契约形状(counts 六字段全量非负、null 字段在场,
 *   不携带 householdId/源内容/原始条目/地址/原始解析错误);
 * - 网络与解析失败 → 任务 failed(稳定 errorCode)且保留上次成功目录;
 * - 空快照/25% 缺失 → awaiting_confirmation → confirm/discard(ownerPassword+expectedVersion),
 *   终态重复操作 409 REFRESH_STATE_CONFLICT、过期/基线变化 409 REFRESH_STALE。
 * 环境说明:受控夹具绑定 127.0.0.1,创建期字面校验拒绝回环地址,故来源经真实 API 创建后
 * 以既有 DB 访问模式把 remote_url 接到夹具(刷新期由 LAN_ALLOWED_TARGETS='127.0.0.1' 精确许可放行);
 * NAS 夹具为临时只读根,media/source 断言走直接查库(与 sources-api.e2e-spec 同一模式)。
 */

const OWNER_PASSWORD = INITIALIZE_BODY.password;

interface RefreshRig {
  app: INestApplication;
  cookie: string;
  sessionId: string;
  householdId: string;
  accountId: string;
  nas: NasRootFixture;
}

const activeNasRoots: NasRootFixture[] = [];
const activeMediaServers: ControlledMediaServer[] = [];

async function bootstrap(): Promise<RefreshRig> {
  const nas = createNasRootFixture({ rootKey: 'nas-main' });
  activeNasRoots.push(nas);
  const fresh = await startFreshApp({
    prefix: 'hmp-sources-refresh-',
    env: { MEDIA_ROOTS: `nas-main=${nas.rootPath}`, LAN_ALLOWED_TARGETS: '127.0.0.1' },
  });
  const app = fresh.app;
  const init = await initialize(app);
  expect(init.status).toBe(201);
  const loggedIn = await login(app, INITIALIZE_BODY.username, OWNER_PASSWORD);
  expect(loggedIn.status).toBe(200);
  const household = await request(app.getHttpServer()).get('/api/household').set('Cookie', cookiePairOf(loggedIn));
  expect(household.status).toBe(200);
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

afterEach(async () => {
  while (activeMediaServers.length > 0) {
    await activeMediaServers.pop()?.close();
  }
  activeNasRoots.splice(0).forEach((nas) => nas.cleanup());
  await cleanupRigs();
  // 配置 --expose-gc 时在每个用例清理后即收尾原生包装对象(未配置时 no-op,见文件尾 afterAll 注释)
  (globalThis as { gc?: () => void }).gc?.();
});

/**
 * 退出稳定性:本套件是首个经 AppModule 执行器跑真实导入任务的契约套件,会在 fork 内
 * 产生大量 better-sqlite3 Statement 包装对象(轮询 GET + 队列扫描/发布事务)。这些对象
 * 晋升老年代后若直到 vitest worker 收尾(dispose 期 GC)才被收尾,其原生析构会在环境
 * 销毁后运行,better-sqlite3 `Statement::~Statement` → `AddEnvironmentCleanupHook`
 * 触发 `(env) != nullptr` 断言崩溃(随机复现,详见给上级的上报)。
 * 此处在文件收尾显式 `globalThis.gc?.()`(配置 `--expose-gc` 时为完整 major GC,
 * 把包装对象在环境存活期间收尾;未配置时为 no-op,不改变默认行为)。
 * 根治属测试基建层(helpers/vitest config 注入 --expose-gc 或调整 pool),不在本任务
 * 文件范围内,已上报。验证本套件请用:NODE_OPTIONS=--expose-gc pnpm --filter @hmp/server exec vitest run ...
 */
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
/* 请求辅助                                                            */
/* ------------------------------------------------------------------ */

function postSource(s: RefreshRig, body: Record<string, unknown>): Promise<request.Response> {
  return request(s.app.getHttpServer()).post('/api/sources').set('Cookie', s.cookie).send(body).then((r) => r);
}

function patchSource(s: RefreshRig, sourceId: string, body: Record<string, unknown>): Promise<request.Response> {
  return request(s.app.getHttpServer())
    .patch(`/api/sources/${sourceId}`)
    .set('Cookie', s.cookie)
    .send(body)
    .then((r) => r);
}

function postRefresh(s: RefreshRig, sourceId: string, body: Record<string, unknown>): Promise<request.Response> {
  return request(s.app.getHttpServer())
    .post(`/api/sources/${sourceId}/refresh`)
    .set('Cookie', s.cookie)
    .send(body)
    .then((r) => r);
}

function getRefresh(s: RefreshRig, refreshId: string): Promise<request.Response> {
  return request(s.app.getHttpServer()).get(`/api/refreshes/${refreshId}`).set('Cookie', s.cookie).then((r) => r);
}

function postConfirm(s: RefreshRig, refreshId: string, body: Record<string, unknown>): Promise<request.Response> {
  return request(s.app.getHttpServer())
    .post(`/api/refreshes/${refreshId}/confirm`)
    .set('Cookie', s.cookie)
    .send(body)
    .then((r) => r);
}

function postDiscard(s: RefreshRig, refreshId: string, body: Record<string, unknown>): Promise<request.Response> {
  return request(s.app.getHttpServer())
    .post(`/api/refreshes/${refreshId}/discard`)
    .set('Cookie', s.cookie)
    .send(body)
    .then((r) => r);
}

interface CreateOverrides {
  kind?: string;
  name?: string;
  enabled?: boolean;
  rootKey?: string;
  relativeDirectory?: string;
}

/** 带 ownerPassword 的合法创建体(默认 IPTV);NAS 时剥离 remoteUrl */
function createBody(overrides: CreateOverrides = {}): Record<string, unknown> {
  const body: Record<string, unknown> = {
    ownerPassword: OWNER_PASSWORD,
    kind: 'iptv',
    name: '直播源',
    remoteUrl: 'http://tv.example.com:8080/live/list.m3u',
    ...overrides,
  };
  if (body.kind === 'nas' && overrides.rootKey === undefined) {
    body.rootKey = 'nas-main';
  }
  if (body.kind === 'nas' && overrides.relativeDirectory === undefined) {
    body.relativeDirectory = '';
  }
  if (body.kind === 'nas') {
    delete body.remoteUrl;
  }
  return body;
}

/** 仅用于期望成功的创建(内部断言 201,失败时输出响应体便于定位) */
async function createSource(s: RefreshRig, overrides: CreateOverrides = {}): Promise<request.Response> {
  const res = await postSource(s, createBody(overrides));
  expect(res.status, `创建前置失败: ${JSON.stringify(res.body)}`).toBe(201);
  return res;
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

/** 把来源 remote_url 接到受控夹具(创建期字面校验拒绝回环,见文件头说明) */
function pointSourceAt(s: RefreshRig, sourceId: string, remoteUrl: string): void {
  Database.db.prepare('UPDATE media_source SET remote_url = ? WHERE id = ?').run(remoteUrl, sourceId);
}

interface StartedRefresh {
  id: string;
  body: Record<string, unknown>;
}

/** 期望成功的发起刷新(断言 202 + Location + 契约形状) */
async function startRefreshOk(
  s: RefreshRig,
  sourceId: string,
  overrides: Record<string, unknown> = {},
): Promise<StartedRefresh> {
  const res = await postRefresh(s, sourceId, {
    ownerPassword: OWNER_PASSWORD,
    expectedVersion: 1,
    operationKey: randomUUID(),
    ...overrides,
  });
  expect(res.status, `发起刷新前置失败: ${JSON.stringify(res.body)}`).toBe(202);
  const body = res.body as Record<string, unknown>;
  const id = body.id as string;
  expect(res.headers.location, 'Location 应指向任务状态地址').toBe(`/api/refreshes/${id}`);
  expectRefreshDtoShape(body, '202 响应');
  return { id, body };
}

/** 轮询 GET 直至任务进入期望状态(执行器为后台串行循环) */
async function waitForStatus(
  s: RefreshRig,
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

/* ------------------------------------------------------------------ */
/* RefreshDto 契约形状                                                 */
/* ------------------------------------------------------------------ */

/** openapi components/schemas/Refresh:additionalProperties=false 全部键 */
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

const REFRESH_STATUSES = [
  'queued',
  'running',
  'awaiting_confirmation',
  'succeeded',
  'failed',
  'interrupted',
  'discarded',
  'expired',
  'stale',
] as const;

function expectRefreshDtoShape(body: Record<string, unknown>, label = ''): void {
  const tag = label === '' ? '' : `${label}: `;
  expect(Object.keys(body).sort(), `${tag}RefreshDto 键集合`).toEqual([...REFRESH_DTO_KEYS].sort());
  expect(REFRESH_STATUSES, `${tag}status 属于 9 态枚举`).toContain(body.status);
  expect(
    Number.isInteger(body.version) && (body.version as number) >= 1,
    `${tag}version 为正整数`,
  ).toBe(true);
  const counts = body.counts as Record<string, unknown>;
  expect(Object.keys(counts).sort(), `${tag}counts 键集合`).toEqual([...REFRESH_COUNT_KEYS].sort());
  for (const key of REFRESH_COUNT_KEYS) {
    expect(Number.isInteger(counts[key]) && (counts[key] as number) >= 0, `${tag}counts.${key} 非负整数`).toBe(true);
  }
  // null 字段也要出现:key 存在性而非仅值非 undefined(JSON 序列化丢 undefined)
  for (const key of ['createdAt', 'startedAt', 'finishedAt', 'expiresAt', 'confirmationReason', 'errorCode']) {
    expect(Object.hasOwn(body, key), `${tag}${key} 字段在场(null 亦须序列化)`).toBe(true);
  }
  expect(typeof body.id, `${tag}id 为 uuid 字符串`).toBe('string');
  expect(typeof body.sourceId, `${tag}sourceId 为 uuid 字符串`).toBe('string');
}

/** 错误/任务响应脱敏:不携带夹具地址与凭据片段 */
function expectNotContaining(serialized: string, secrets: string[], label = ''): void {
  for (const secret of secrets) {
    expect(serialized, `${label}不得包含敏感片段「${secret}」`).not.toContain(secret);
  }
}

/* ------------------------------------------------------------------ */
/* 查库辅助(与 sources-api.e2e-spec 同一直接访问模式)                  */
/* ------------------------------------------------------------------ */

interface SourceRow {
  id: string;
  household_id: string;
  last_job_id: string | null;
  last_success_at: string | null;
  version: number;
}

function sourceRowOf(sourceId: string): SourceRow {
  const row = Database.db.prepare('SELECT * FROM media_source WHERE id = ?').get(sourceId) as
    | SourceRow
    | undefined;
  expect(row, `来源行应存在: ${sourceId}`).toBeDefined();
  return row as SourceRow;
}

function refreshRowOf(refreshId: string): { status: string; version: number } {
  const row = Database.db.prepare('SELECT status, version FROM source_refresh WHERE id = ?').get(refreshId) as
    | { status: string; version: number }
    | undefined;
  expect(row, `刷新任务行应存在: ${refreshId}`).toBeDefined();
  return row as { status: string; version: number };
}

function countRefreshRows(sourceId: string): number {
  const row = Database.db.prepare('SELECT COUNT(*) AS n FROM source_refresh WHERE source_id = ?').get(sourceId) as {
    n: number;
  };
  return row.n;
}

function catalogRevisionOf(householdId: string): number {
  const row = Database.db.prepare('SELECT revision FROM catalog_state WHERE household_id = ?').get(householdId) as {
    revision: number;
  };
  return row.revision;
}

function mediaRowsOf(householdId: string): Array<{ id: string; type: string; title: string }> {
  return Database.db.prepare('SELECT id, type, title FROM media_item WHERE household_id = ? ORDER BY title').all(
    householdId,
  ) as Array<{ id: string; type: string; title: string }>;
}

function presentEntryCount(householdId: string, sourceId: string): number {
  const row = Database.db
    .prepare('SELECT COUNT(*) AS n FROM source_entry WHERE household_id = ? AND source_id = ? AND present = 1')
    .get(householdId, sourceId) as { n: number };
  return row.n;
}

function playbackSourceCount(householdId: string): number {
  const row = Database.db.prepare('SELECT COUNT(*) AS n FROM playback_source WHERE household_id = ?').get(
    householdId,
  ) as { n: number };
  return row.n;
}

/** 直插异家庭来源链(404 同形断言用);含完整身份链满足复合外键 */
function insertForeignHousehold(): { householdId: string; iptvSourceId: string; sessionId: string } {
  const db = Database.db;
  const now = new Date().toISOString();
  const householdId = randomUUID();
  const accountId = randomUUID();
  const deviceId = randomUUID();
  const sessionId = randomUUID();
  const sourceId = randomUUID();
  db.prepare('INSERT INTO household (id, name, default_language, timezone, created_at) VALUES (?, ?, ?, ?, ?)').run(
    householdId,
    '别家',
    'zh-CN',
    'Asia/Shanghai',
    now,
  );
  db.prepare(
    'INSERT INTO account (id, household_id, username, username_normalized, password_hash, role, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
  ).run(accountId, householdId, 'foreign-owner', 'foreign-owner', '$argon2id$fixture-hash', 'owner', now);
  db.prepare(
    'INSERT INTO device (id, household_id, name, type, last_seen_at, revoked_at, created_at) VALUES (?, ?, NULL, ?, NULL, NULL, ?)',
  ).run(deviceId, householdId, 'web', now);
  db.prepare(
    'INSERT INTO device_session (id, household_id, account_id, device_id, token_hash, active_profile_id, expires_at, revoked_at, last_active_at, created_at) VALUES (?, ?, ?, ?, ?, NULL, ?, NULL, ?, ?)',
  ).run(sessionId, householdId, accountId, deviceId, `hash-${sessionId}`, '2099-01-01T00:00:00Z', now, now);
  db.prepare(
    "INSERT INTO media_source (id, household_id, kind, name, remote_url, root_key, relative_directory, private_access_approved, epg_source_id, enabled, version, last_success_at, last_job_id, created_at, updated_at) VALUES (?, ?, 'iptv', '别家直播', 'http://foreign.example.tv/a.m3u', NULL, NULL, 0, NULL, 1, 1, NULL, NULL, ?, ?)",
  ).run(sourceId, householdId, now, now);
  return { householdId, iptvSourceId: sourceId, sessionId };
}

/** 直插异家庭 queued 刷新任务(跨家庭 refreshId 404 同形断言用) */
function insertForeignRefresh(
  foreign: { householdId: string; iptvSourceId: string; sessionId: string },
): string {
  const id = randomUUID();
  const accountId = Database.db
    .prepare('SELECT id FROM account WHERE household_id = ?')
    .get(foreign.householdId) as { id: string };
  Database.db.prepare(
    "INSERT INTO source_refresh (id, household_id, source_id, initiator_account_id, initiator_session_id, operation_key, status, version, source_version, baseline_revision, snapshot_digest, item_count, summary_json, error_code, created_at, started_at, finished_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, 'queued', 1, 1, 1, NULL, NULL, NULL, NULL, ?, NULL, NULL, NULL)",
  ).run(id, foreign.householdId, foreign.iptvSourceId, accountId.id, foreign.sessionId, randomUUID(), new Date().toISOString());
  return id;
}

/* ------------------------------------------------------------------ */
/* 夹具内容                                                            */
/* ------------------------------------------------------------------ */

/** 两条目 M3U(其一携带凭据 query,供脱敏断言) */
function twoChannelM3u(): string {
  return buildM3u([
    { name: 'CCTV-1 综合', tvgId: 'cctv-1', url: 'http://stream.example/cctv1.m3u8?token=topsecret' },
    { name: 'CCTV-2 财经', tvgId: 'cctv-2', url: 'http://stream.example/cctv2.m3u8' },
  ]);
}

/* ------------------------------------------------------------------ */
/* 用例                                                                */
/* ------------------------------------------------------------------ */

describe('T019 刷新执行与待确认(契约 e2e)', () => {
  it('POST /sources/{id}/refresh:202+Location=/api/refreshes/{id} 不等待导入;执行器忙时新任务保持 queued 可查;RefreshDto 契约形状且不携带家庭/地址信息', async () => {
    const s = await bootstrap();
    const server = await startMediaServer([
      { path: '/hang.m3u', kind: 'hang' },
      { path: '/live.m3u', kind: 'm3u', content: twoChannelM3u() },
    ]);
    const hang = await createSource(s, { name: '挂起源' });
    const queuedSource = await createSource(s, { name: '排队源' });
    pointSourceAt(s, hang.body.id as string, `${server.baseUrl}/hang.m3u`);
    pointSourceAt(s, queuedSource.body.id as string, `${server.baseUrl}/live.m3u`);

    // 占住全局串行执行器:第一个任务停在 running
    const hanging = await startRefreshOk(s, hang.body.id as string);
    expect(hanging.body.status).toBe('queued');
    await waitForStatus(s, hanging.id, ['running']);

    // 第二来源发起:202 同步返回 queued,不等待导入
    const started = await startRefreshOk(s, queuedSource.body.id as string);
    expect(started.body.status).toBe('queued');
    expect(started.body.startedAt).toBeNull();
    expect(started.body.finishedAt).toBeNull();
    expect(started.body.confirmationReason).toBeNull();
    expect(started.body.errorCode).toBeNull();

    // Location 地址可查:同一任务,仍处 queued(执行器忙,确定性)
    const seen = await getRefresh(s, started.id);
    expect(seen.status).toBe(200);
    expectRefreshDtoShape(seen.body, 'GET 任务');
    expect(seen.body.id).toBe(started.id);
    expect(seen.body.status).toBe('queued');
    expect(seen.body.version).toBe(1);
    expect(seen.body.counts).toEqual({ added: 0, updated: 0, missing: 0, failed: 0, channels: 0, programmes: 0 });
    expectNotContaining(JSON.stringify(seen.body), [s.householdId, '127.0.0.1', 'live.m3u'], '任务概览');

    // 释放挂起源:A 传输中断失败(稳定 errorCode),排队的 B 随后被执行成功
    server.abortPending();
    const failed = await waitForStatus(s, hanging.id, ['failed']);
    expect(failed.errorCode).toBe('SOURCE_REMOTE_UNREACHABLE');
    const done = await waitForStatus(s, started.id, ['succeeded']);
    expect(done.counts).toMatchObject({ added: 2 });
    expectRefreshDtoShape(done, '完成任务');
  });

  it('同 operationKey 同语义重试返回同一任务 id 且仍重新验证密码(错/缺/空密码 403);异语义 409 IDEMPOTENCY_CONFLICT;请求体形态 400 先于家长验证', async () => {
    const s = await bootstrap();
    const source = await createSource(s, { kind: 'nas', name: '空影库', relativeDirectory: '' });
    const sourceId = source.body.id as string;
    const operationKey = randomUUID();

    const first = await startRefreshOk(s, sourceId, { operationKey });
    await waitForStatus(s, first.id, ['succeeded']); // 空根首次扫描 → 自动发布成功

    // 同 key 同语义 → 同一任务 id(终态不可变,不新建任务)
    const retry = await startRefreshOk(s, sourceId, { operationKey });
    expect(retry.id).toBe(first.id);
    expect(retry.body.status).toBe('succeeded');
    expect(countRefreshRows(sourceId)).toBe(1);

    // 幂等重放仍验证身份:错密码 403 FAILED(不返回任务)
    const wrongPwd = await postRefresh(s, sourceId, {
      ownerPassword: 'not-the-password',
      expectedVersion: 1,
      operationKey,
    });
    expect(wrongPwd.status).toBe(403);
    expectProblemContentType(wrongPwd);
    expect(wrongPwd.body.code).toBe(ProblemCode.PARENT_VERIFICATION_FAILED);
    expectNotContaining(JSON.stringify(wrongPwd.body), ['not-the-password'], '错误响应');

    // 缺失/空串密码 → 统一 403 REQUIRED(而非 400)
    for (const ownerPassword of [undefined, '']) {
      const res = await postRefresh(s, sourceId, { ownerPassword, expectedVersion: 1, operationKey });
      expect(res.status, ownerPassword === '' ? '空串密码' : '缺失密码').toBe(403);
      expect(res.body.code).toBe(ProblemCode.PARENT_VERIFICATION_REQUIRED);
    }
    expect(countRefreshRows(sourceId)).toBe(1);

    // 同 key 异语义(来源版本不同)→ 409 IDEMPOTENCY_CONFLICT
    const conflict = await postRefresh(s, sourceId, {
      ownerPassword: OWNER_PASSWORD,
      expectedVersion: 2,
      operationKey,
    });
    expect(conflict.status).toBe(409);
    expectProblemContentType(conflict);
    expect(conflict.body.code).toBe(ProblemCode.IDEMPOTENCY_CONFLICT);
    expect(countRefreshRows(sourceId)).toBe(1);

    // 请求体严格形态(未知字段拒绝;先于家长验证 → 400,不消耗密码失败次数)
    const badBodies: Array<[string, Record<string, unknown>]> = [
      ['operationKey 非 uuid', { ownerPassword: OWNER_PASSWORD, expectedVersion: 1, operationKey: 'not-a-uuid' }],
      ['缺 operationKey', { ownerPassword: OWNER_PASSWORD, expectedVersion: 1 }],
      ['缺 expectedVersion', { ownerPassword: OWNER_PASSWORD, operationKey: randomUUID() }],
      ['expectedVersion 0', { ownerPassword: OWNER_PASSWORD, expectedVersion: 0, operationKey: randomUUID() }],
      ['expectedVersion 小数', { ownerPassword: OWNER_PASSWORD, expectedVersion: 1.5, operationKey: randomUUID() }],
      ['未知字段', { ownerPassword: OWNER_PASSWORD, expectedVersion: 1, operationKey: randomUUID(), extra: 1 }],
    ];
    for (const [label, body] of badBodies) {
      const res = await postRefresh(s, sourceId, body);
      expect(res.status, label).toBe(400);
      expectProblemContentType(res);
      expect(res.body.code, label).toBe(ProblemCode.VALIDATION_FAILED);
    }
    expect(countRefreshRows(sourceId)).toBe(1);
  });

  it('同来源已有 running / awaiting_confirmation 任务时再次刷新 409 SOURCE_BUSY;进入终态后来源锁释放可再次刷新', async () => {
    const s = await bootstrap();
    const server = await startMediaServer([
      { path: '/hang.m3u', kind: 'hang' },
      { path: '/live.m3u', kind: 'm3u', content: twoChannelM3u() },
    ]);
    const iptv = await createSource(s);
    const iptvId = iptv.body.id as string;
    pointSourceAt(s, iptvId, `${server.baseUrl}/hang.m3u`);

    // running 占用来源锁
    const runningJob = await startRefreshOk(s, iptvId);
    await waitForStatus(s, runningJob.id, ['running']);
    const busyRunning = await postRefresh(s, iptvId, {
      ownerPassword: OWNER_PASSWORD,
      expectedVersion: 1,
      operationKey: randomUUID(),
    });
    expect(busyRunning.status).toBe(409);
    expectProblemContentType(busyRunning);
    expect(busyRunning.body.code).toBe(ProblemCode.SOURCE_BUSY);
    expectNotContaining(JSON.stringify(busyRunning.body), ['127.0.0.1', 'hang.m3u'], 'SOURCE_BUSY');

    // 失败(终态)释放锁 → 可再次刷新并成功
    server.abortPending();
    await waitForStatus(s, runningJob.id, ['failed']);
    pointSourceAt(s, iptvId, `${server.baseUrl}/live.m3u`);
    const retried = await startRefreshOk(s, iptvId);
    await waitForStatus(s, retried.id, ['succeeded']);

    // awaiting_confirmation 亦占用来源锁
    const nas = await createSource(s, { kind: 'nas', name: '影库', relativeDirectory: '' });
    const nasId = nas.body.id as string;
    s.nas.write('a.mp4', 'aaa');
    s.nas.write('b.mp4', 'bbb');
    const published = await startRefreshOk(s, nasId);
    await waitForStatus(s, published.id, ['succeeded']);
    s.nas.remove('a.mp4');
    s.nas.remove('b.mp4');
    const awaitingJob = await startRefreshOk(s, nasId);
    await waitForStatus(s, awaitingJob.id, ['awaiting_confirmation']);
    const busyAwaiting = await postRefresh(s, nasId, {
      ownerPassword: OWNER_PASSWORD,
      expectedVersion: 1,
      operationKey: randomUUID(),
    });
    expect(busyAwaiting.status).toBe(409);
    expect(busyAwaiting.body.code).toBe(ProblemCode.SOURCE_BUSY);
  });

  it('未知/跨家庭来源与任务统一 404 同形;禁用来源 422 SOURCE_DISABLED;无会话 401;非 owner 403', async () => {
    const s = await bootstrap();
    const foreign = insertForeignHousehold();
    const foreignRefreshId = insertForeignRefresh(foreign);

    // 无会话:SessionGuard 先于一切(四个端点同语义;逐个创建后立即 await ——
    // supertest 7 会在空闲时关闭自启服务器,批量预建 Test 对象会命中已关闭地址)
    const anonymousCases: Array<() => Promise<request.Response>> = [
      () => request(s.app.getHttpServer()).post(`/api/sources/${randomUUID()}/refresh`).send(validRefreshBody()),
      () => request(s.app.getHttpServer()).get(`/api/refreshes/${randomUUID()}`),
      () => request(s.app.getHttpServer()).post(`/api/refreshes/${randomUUID()}/confirm`).send(validJobBody()),
      () => request(s.app.getHttpServer()).post(`/api/refreshes/${randomUUID()}/discard`).send(validJobBody()),
    ];
    for (const send of anonymousCases) {
      const res = await send();
      expect(res.status).toBe(401);
      expect(res.body.code).toBe(ProblemCode.SESSION_INVALID);
    }

    // 未知来源 vs 跨家庭来源:404 同形(响应体逐字段一致,不泄漏归属)
    const missing = await postRefresh(s, randomUUID(), validRefreshBody());
    expect(missing.status).toBe(404);
    expectProblemContentType(missing);
    expect(missing.body.code).toBe(ProblemCode.NOT_FOUND);
    const cross = await postRefresh(s, foreign.iptvSourceId, validRefreshBody());
    expect(cross.status).toBe(404);
    expect(cross.body).toEqual(missing.body);

    // 禁用来源 → 422 SOURCE_DISABLED(家长验证通过后判定)
    const disabled = await createSource(s, { name: '停用源', enabled: false });
    const disabledRefresh = await postRefresh(s, disabled.body.id as string, validRefreshBody());
    expect(disabledRefresh.status).toBe(422);
    expect(disabledRefresh.body.code).toBe(ProblemCode.SOURCE_DISABLED);

    // 非 owner 403(先于目标归属与格式校验;四个端点同语义)
    Database.db.prepare("UPDATE account SET role = 'admin'").run();
    const forbiddenCases: Array<() => Promise<request.Response>> = [
      () => postRefresh(s, disabled.body.id as string, validRefreshBody()),
      () => getRefresh(s, randomUUID()),
      () => postConfirm(s, randomUUID(), validJobBody()),
      () => postDiscard(s, randomUUID(), validJobBody()),
    ];
    for (const send of forbiddenCases) {
      const res = await send();
      expect(res.status).toBe(403);
      expect(res.body.code).toBe(ProblemCode.FORBIDDEN);
    }
    Database.db.prepare("UPDATE account SET role = 'owner'").run();

    // 任务端点:未知 refreshId vs 跨家庭 refreshId → 404 同形;confirm/discard 同样拒绝
    const missingJob = await getRefresh(s, randomUUID());
    expect(missingJob.status).toBe(404);
    expect(missingJob.body.code).toBe(ProblemCode.NOT_FOUND);
    const crossJob = await getRefresh(s, foreignRefreshId);
    expect(crossJob.status).toBe(404);
    expect(crossJob.body).toEqual(missingJob.body);

    const missingConfirm = await postConfirm(s, randomUUID(), validJobBody());
    expect(missingConfirm.status).toBe(404);
    expect(missingConfirm.body.code).toBe(ProblemCode.NOT_FOUND);
    const crossConfirm = await postConfirm(s, foreignRefreshId, validJobBody());
    expect(crossConfirm.status).toBe(404);
    expect(crossConfirm.body).toEqual(missingConfirm.body);

    const missingDiscard = await postDiscard(s, randomUUID(), validJobBody());
    expect(missingDiscard.status).toBe(404);
    const crossDiscard = await postDiscard(s, foreignRefreshId, validJobBody());
    expect(crossDiscard.status).toBe(404);
    expect(crossDiscard.body).toEqual(missingDiscard.body);
  });

  it('expectedVersion 落后于来源版本 409 SOURCE_VERSION_CONFLICT 且不创建任务', async () => {
    const s = await bootstrap();
    const source = await createSource(s, { kind: 'nas', name: '影库', relativeDirectory: '' });
    const sourceId = source.body.id as string;
    const patched = await patchSource(s, sourceId, {
      ownerPassword: OWNER_PASSWORD,
      expectedVersion: 1,
      name: '改名影库',
    });
    expect(patched.status).toBe(200);

    const stale = await postRefresh(s, sourceId, {
      ownerPassword: OWNER_PASSWORD,
      expectedVersion: 1, // 来源已到 v2
      operationKey: randomUUID(),
    });
    expect(stale.status).toBe(409);
    expectProblemContentType(stale);
    expect(stale.body.code).toBe(ProblemCode.SOURCE_VERSION_CONFLICT);
    expect(countRefreshRows(sourceId)).toBe(0);
  });

  it('IPTV happy path:202 → 轮询至 succeeded;counts.added=2 且 channels/programmes=0;media/source_entry/playback_source 已发布;重复刷新身份稳定', async () => {
    const s = await bootstrap();
    const server = await startMediaServer([{ path: '/live.m3u', kind: 'm3u', content: twoChannelM3u() }]);
    const source = await createSource(s);
    const sourceId = source.body.id as string;
    pointSourceAt(s, sourceId, `${server.baseUrl}/live.m3u`);

    const started = await startRefreshOk(s, sourceId);
    expect(started.body.counts).toEqual({ added: 0, updated: 0, missing: 0, failed: 0, channels: 0, programmes: 0 });
    const done = await waitForStatus(s, started.id, ['succeeded']);
    expect(done.counts).toEqual({ added: 2, updated: 0, missing: 0, failed: 0, channels: 0, programmes: 0 });
    expect(done.startedAt).not.toBeNull();
    expect(done.finishedAt).not.toBeNull();
    expect(done.confirmationReason).toBeNull();
    expect(done.errorCode).toBeNull();
    expectNotContaining(JSON.stringify(done), ['127.0.0.1', 'live.m3u', 'topsecret', 'stream.example'], '任务概览');

    // 发布落库:2 频道媒体 + 2 present 条目 + 2 播放资源;来源回写成功信息
    const media = mediaRowsOf(s.householdId);
    expect(media.map((row) => row.type)).toEqual(['channel', 'channel']);
    expect(media.map((row) => row.title)).toEqual(['CCTV-1 综合', 'CCTV-2 财经']);
    expect(presentEntryCount(s.householdId, sourceId)).toBe(2);
    expect(playbackSourceCount(s.householdId)).toBe(2);
    expect(sourceRowOf(sourceId)).toMatchObject({ last_job_id: started.id, version: 1 });
    expect(sourceRowOf(sourceId).last_success_at).not.toBeNull();

    // 重复刷新:身份稳定 → updated=2、added=0,media id 不变,不产生重复行
    const mediaIdsBefore = media.map((row) => row.id).sort();
    const second = await startRefreshOk(s, sourceId);
    const secondDone = await waitForStatus(s, second.id, ['succeeded']);
    expect(secondDone.counts).toMatchObject({ added: 0, updated: 2, missing: 0 });
    expect(mediaRowsOf(s.householdId).map((row) => row.id).sort()).toEqual(mediaIdsBefore);
    expect(presentEntryCount(s.householdId, sourceId)).toBe(2);
  });

  it('刷新失败保留上次成功目录:坏路由 → failed + 稳定 errorCode;GET 终态仍 200;media/source_entry 与 catalog revision 原样', async () => {
    const s = await bootstrap();
    const server = await startMediaServer([
      { path: '/live.m3u', kind: 'm3u', content: twoChannelM3u() },
      { path: '/broken.m3u', kind: 'body', body: malformedPayloads.malformedM3u(), contentType: 'audio/x-mpegurl' },
    ]);
    const source = await createSource(s);
    const sourceId = source.body.id as string;
    pointSourceAt(s, sourceId, `${server.baseUrl}/live.m3u`);
    const first = await startRefreshOk(s, sourceId);
    await waitForStatus(s, first.id, ['succeeded']);
    const revisionBefore = catalogRevisionOf(s.householdId);

    pointSourceAt(s, sourceId, `${server.baseUrl}/broken.m3u`);
    const second = await startRefreshOk(s, sourceId);
    const failed = await waitForStatus(s, second.id, ['failed']);
    expect(failed.errorCode).toBe('M3U_ENTRY_MISSING_URL');
    expect(failed.finishedAt).not.toBeNull();
    expectRefreshDtoShape(failed, 'failed 任务');
    expectNotContaining(JSON.stringify(failed), ['127.0.0.1', 'broken.m3u', 'no-url'], 'failed 任务');

    // GET 终态仍 200(不把后台失败伪装成 HTTP 500)
    const seen = await getRefresh(s, second.id);
    expect(seen.status).toBe(200);
    expect(seen.body.status).toBe('failed');

    // 目录保留:上次成功内容原样,修订未推进
    expect(mediaRowsOf(s.householdId)).toHaveLength(2);
    expect(presentEntryCount(s.householdId, sourceId)).toBe(2);
    expect(playbackSourceCount(s.householdId)).toBe(2);
    expect(catalogRevisionOf(s.householdId)).toBe(revisionBefore);
    expect(sourceRowOf(sourceId).last_job_id).toBe(first.id);
  });

  it('空快照 → awaiting_confirmation(empty_snapshot)→ confirm 200 终态 succeeded;终态重复 confirm 409 REFRESH_STATE_CONFLICT', async () => {
    const s = await bootstrap();
    const source = await createSource(s, { kind: 'nas', name: '影库', relativeDirectory: '' });
    const sourceId = source.body.id as string;
    s.nas.write('a.mp4', 'aaa');
    s.nas.write('b.mp4', 'bbb');
    const first = await startRefreshOk(s, sourceId);
    await waitForStatus(s, first.id, ['succeeded']);

    s.nas.remove('a.mp4');
    s.nas.remove('b.mp4');
    const awaitingJob = await startRefreshOk(s, sourceId);
    const awaiting = await waitForStatus(s, awaitingJob.id, ['awaiting_confirmation']);
    expect(awaiting.confirmationReason).toBe('empty_snapshot');
    expect(awaiting.expiresAt).not.toBeNull();
    expect(awaiting.counts).toMatchObject({ added: 0, updated: 0, missing: 2 });
    expectRefreshDtoShape(awaiting, '待确认任务');

    // confirm:ownerPassword + expectedVersion=任务当前 version → 终态 succeeded
    const confirmed = await postConfirm(s, awaitingJob.id, {
      ownerPassword: OWNER_PASSWORD,
      expectedVersion: awaiting.version,
    });
    expect(confirmed.status).toBe(200);
    expect(confirmed.body.status).toBe('succeeded');
    expect(confirmed.body.version).toBe((awaiting.version as number) + 1);
    expectRefreshDtoShape(confirmed.body, '确认结果');

    // 终态重复确认 → 409 REFRESH_STATE_CONFLICT(终态 immutable)
    const repeat = await postConfirm(s, awaitingJob.id, {
      ownerPassword: OWNER_PASSWORD,
      expectedVersion: awaiting.version,
    });
    expect(repeat.status).toBe(409);
    expectProblemContentType(repeat);
    expect(repeat.body.code).toBe(ProblemCode.REFRESH_STATE_CONFLICT);
    expect(refreshRowOf(awaitingJob.id).status).toBe('succeeded');

    // 确认发布后目录为空:条目全部缺位
    expect(presentEntryCount(s.householdId, sourceId)).toBe(0);
  });

  it('过期任务:confirm 409 REFRESH_STALE 且状态 expired;GET 懒执行过期使 expired 可见;对已过期任务操作 409', async () => {
    const s = await bootstrap();
    const source = await createSource(s, { kind: 'nas', name: '影库', relativeDirectory: '' });
    const sourceId = source.body.id as string;
    s.nas.write('a.mp4', 'aaa');
    s.nas.write('b.mp4', 'bbb');
    const first = await startRefreshOk(s, sourceId);
    await waitForStatus(s, first.id, ['succeeded']);

    // 第一轮:过期后先 confirm → 409 REFRESH_STALE,任务被标 expired
    s.nas.remove('a.mp4');
    s.nas.remove('b.mp4');
    const awaitingJob = await startRefreshOk(s, sourceId);
    const awaiting = await waitForStatus(s, awaitingJob.id, ['awaiting_confirmation']);
    Database.db.prepare('UPDATE source_refresh SET expires_at = ? WHERE id = ?').run(
      new Date(Date.now() - 1000).toISOString(),
      awaitingJob.id,
    );
    const confirm = await postConfirm(s, awaitingJob.id, {
      ownerPassword: OWNER_PASSWORD,
      expectedVersion: awaiting.version,
    });
    expect(confirm.status).toBe(409);
    expectProblemContentType(confirm);
    expect(confirm.body.code).toBe(ProblemCode.REFRESH_STALE);
    expect(refreshRowOf(awaitingJob.id)).toMatchObject({ status: 'expired' });
    const expiredSeen = await getRefresh(s, awaitingJob.id);
    expect(expiredSeen.body.status).toBe('expired');

    // 第二轮:GET 懒执行 expireStaleConfirmations → 过期任务以 expired 终态可见;再操作 → 终态拒绝
    const secondAwaiting = await startRefreshOk(s, sourceId);
    const awaiting2 = await waitForStatus(s, secondAwaiting.id, ['awaiting_confirmation']);
    Database.db.prepare('UPDATE source_refresh SET expires_at = ? WHERE id = ?').run(
      new Date(Date.now() - 1000).toISOString(),
      secondAwaiting.id,
    );
    const lazySeen = await getRefresh(s, secondAwaiting.id);
    expect(lazySeen.status).toBe(200);
    expect(lazySeen.body.status).toBe('expired');
    expectRefreshDtoShape(lazySeen.body, '懒过期任务');
    const confirmAfterLazy = await postConfirm(s, secondAwaiting.id, {
      ownerPassword: OWNER_PASSWORD,
      expectedVersion: awaiting2.version,
    });
    expect(confirmAfterLazy.status).toBe(409);
    expect(confirmAfterLazy.body.code).toBe(ProblemCode.REFRESH_STATE_CONFLICT);
    const discardAfterLazy = await postDiscard(s, secondAwaiting.id, {
      ownerPassword: OWNER_PASSWORD,
      expectedVersion: awaiting2.version,
    });
    expect(discardAfterLazy.status).toBe(409);
    expect(discardAfterLazy.body.code).toBe(ProblemCode.REFRESH_STATE_CONFLICT);
  });

  it('25% 缺失 → awaiting_confirmation(deletion_ratio_exceeded)→ discard 200 discarded;终态重复 discard 409;来源锁释放可再次刷新', async () => {
    const s = await bootstrap();
    const source = await createSource(s, { kind: 'nas', name: '影库', relativeDirectory: '' });
    const sourceId = source.body.id as string;
    for (const name of ['a.mp4', 'b.mp4', 'c.mp4', 'd.mp4']) {
      s.nas.write(name, `content-${name}`);
    }
    const first = await startRefreshOk(s, sourceId);
    await waitForStatus(s, first.id, ['succeeded']);

    // 4 删 1:missing/present = 1/4 = 25%(恰好触发阈值)
    s.nas.remove('d.mp4');
    const awaitingJob = await startRefreshOk(s, sourceId);
    const awaiting = await waitForStatus(s, awaitingJob.id, ['awaiting_confirmation']);
    expect(awaiting.confirmationReason).toBe('deletion_ratio_exceeded');
    expect(awaiting.counts).toMatchObject({ added: 0, updated: 3, missing: 1 });
    expectRefreshDtoShape(awaiting, '待确认任务');

    // discard:200 discarded,目录保留上次成功内容
    const discarded = await postDiscard(s, awaitingJob.id, {
      ownerPassword: OWNER_PASSWORD,
      expectedVersion: awaiting.version,
    });
    expect(discarded.status).toBe(200);
    expect(discarded.body.status).toBe('discarded');
    expectRefreshDtoShape(discarded.body, '丢弃结果');
    expect(mediaRowsOf(s.householdId)).toHaveLength(4);
    expect(presentEntryCount(s.householdId, sourceId)).toBe(4);

    // 终态重复丢弃 → 409 REFRESH_STATE_CONFLICT
    const repeat = await postDiscard(s, awaitingJob.id, {
      ownerPassword: OWNER_PASSWORD,
      expectedVersion: awaiting.version,
    });
    expect(repeat.status).toBe(409);
    expect(repeat.body.code).toBe(ProblemCode.REFRESH_STATE_CONFLICT);

    // 来源锁已释放:可再次发起刷新(缺失比例不变,再次进入待确认 —— 202 语义成立)
    const again = await startRefreshOk(s, sourceId);
    await waitForStatus(s, again.id, ['awaiting_confirmation']);
  });

  it('来源配置变更后旧待确认失效:PATCH 使任务标 stale → confirm 409 REFRESH_STATE_CONFLICT;目录基线变化 → confirm 409 REFRESH_STALE 并标 stale', async () => {
    const s = await bootstrap();
    const source = await createSource(s, { kind: 'nas', name: '影库', relativeDirectory: '' });
    const sourceId = source.body.id as string;
    s.nas.write('a.mp4', 'aaa');
    s.nas.write('b.mp4', 'bbb');
    const first = await startRefreshOk(s, sourceId);
    await waitForStatus(s, first.id, ['succeeded']);

    // 待确认期间 PATCH 来源:任务随即被标 stale(version+1),confirm 以终态语义拒绝
    s.nas.remove('a.mp4');
    s.nas.remove('b.mp4');
    const staleJob = await startRefreshOk(s, sourceId);
    const staleAwaiting = await waitForStatus(s, staleJob.id, ['awaiting_confirmation']);
    const patched = await patchSource(s, sourceId, {
      ownerPassword: OWNER_PASSWORD,
      expectedVersion: 1,
      name: '改名影库',
    });
    expect(patched.status).toBe(200);
    expect(refreshRowOf(staleJob.id)).toMatchObject({ status: 'stale', version: (staleAwaiting.version as number) + 1 });
    const confirmStale = await postConfirm(s, staleJob.id, {
      ownerPassword: OWNER_PASSWORD,
      expectedVersion: staleAwaiting.version,
    });
    expect(confirmStale.status).toBe(409);
    expectProblemContentType(confirmStale);
    expect(confirmStale.body.code).toBe(ProblemCode.REFRESH_STATE_CONFLICT);

    // 目录基线变化(未标 stale 的待确认任务):直接推进 catalog revision 模拟其他写入路径,
    // confirm → 409 REFRESH_STALE 且任务被标 stale(不发布)
    const baselineJob = await startRefreshOk(s, sourceId, { expectedVersion: 2 });
    const baselineAwaiting = await waitForStatus(s, baselineJob.id, ['awaiting_confirmation']);
    Database.db.prepare('UPDATE catalog_state SET revision = revision + 1 WHERE household_id = ?').run(s.householdId);
    const confirmBaseline = await postConfirm(s, baselineJob.id, {
      ownerPassword: OWNER_PASSWORD,
      expectedVersion: baselineAwaiting.version,
    });
    expect(confirmBaseline.status).toBe(409);
    expect(confirmBaseline.body.code).toBe(ProblemCode.REFRESH_STALE);
    expect(refreshRowOf(baselineJob.id).status).toBe('stale');
    expect(presentEntryCount(s.householdId, sourceId)).toBe(2); // 未被空快照覆盖
  });
});

/* ------------------------------------------------------------------ */
/* 合法请求体(401/403/404 等先于语义判定的用例复用)                   */
/* ------------------------------------------------------------------ */

function validRefreshBody(): Record<string, unknown> {
  return { ownerPassword: OWNER_PASSWORD, expectedVersion: 1, operationKey: randomUUID() };
}

function validJobBody(): Record<string, unknown> {
  return { ownerPassword: OWNER_PASSWORD, expectedVersion: 1 };
}
