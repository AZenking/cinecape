import 'reflect-metadata';
import http from 'node:http';
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import request from 'supertest';
import { afterEach, describe, expect, it } from 'vitest';
import type { INestApplication } from '@nestjs/common';
import { ProblemCode, SESSION_COOKIE } from '@hmp/shared';
import {
  cleanupRigs,
  cookiePairOf,
  expectProblemContentType,
  login,
  startFreshApp,
  type TestRig,
} from '../helpers';
import { Database } from '../../src/database/database';
import { selectMainAndUnlockSettings } from '../helpers-management';
import {
  seedPlaybackSession,
  seedPlaybackWorld,
  type PlaybackSessionFixture,
  type PlaybackWorld,
  type SeedPlaybackWorldOptions,
} from '../fixtures/playback';
import { getDb } from '@contexts/identity-access/infrastructure/db';
import { account, deviceSession, playbackFailureEvent, playbackSession, playbackSource } from '../../src/database/schema';

/**
 * T042(004-playback-resolver · US2b,只写测试不实现):播放会话记录与失败可见性契约 e2e。
 *
 * 权威依据(docs/specs/004-playback-resolver,均为唯一接口权威):
 * - tasks.md T042 条目(成功/失败/停止记录、不可见 media_id=null、无效会话仅安全日志、
 *   owner 当次密码/锁定/撤销/跨家庭、游标 limit 20/100、重复 stop 不重复结束事件);
 * - contracts/api.md 控制端点表末行(005 US8 收口:POST /settings/devices/
 *   {deviceId}/playback-records/query,继承 004 POST /devices/... 全部语义)
 *   {ownerPassword,cursor?,limit?} → 200 {items,nextCursor};owner+当次密码,重验家庭目标;
 *   limit 默认 20 最大 100,按时间/id 倒序游标;no-store;返回当前家庭该设备的 session 及
 *   failure 事件,无源位置/ticket;密码缺失/错误按现有家长验证规则拒绝(403);
 *   跨家庭目标统一 404 同形(openapi:404 NOT_FOUND「设备不存在/目标跨家庭,不泄漏归属」);
 * - data-model.md「## playback_failure_event」(仅有效设备会话可写;媒体不属于该家庭或
 *   不可见则 media_id=null,不存客户端原始目标 ID;不关联所选资源,不产生播放 session;
 *   索引 (household_id,device_id,occurred_at,id)) +「验证与恢复」(审计保留 30 天);
 * - spec.md FR-007/US2b(SC-004:异步准备失败只更新已建立会话,不写 failure_event;
 *   不可见媒体失败不记录媒体标识;无效会话仅留脱敏安全日志且不写设备记录);
 * - openapi.yaml schemas:PlaybackRecordPage/PlaybackRecordItem(kind 判别:session|failure)/
 *   PlaybackSessionRecord/PlaybackFailureRecord(字段形态与 additionalProperties:false 权威);
 * - 家长验证既有惯例(unit/parent-verification.spec.ts + parent-lockout.e2e-spec.ts):
 *   缺失/空串 → 403 PARENT_VERIFICATION_REQUIRED;错误 → 403 PARENT_VERIFICATION_FAILED;
 *   连错 5 次落窗口,窗口内正确密码也 423 PARENT_VERIFICATION_LOCKED;成功清零;
 *   计数按 (household, account) 持久化 —— 「当次密码」不发放任何长期家长态。
 *
 * 历史注记(TDD RED → 005 收口):T044 阶段本文件曾以旧 POST /api/devices/{id}/
 * playback-records/query RED 起步;005 US8 管理迁移后查询入口唯一收敛为
 * /api/settings/devices/{id}/playback-records/query(settings-devices.controller),
 * 旧 /devices 控制器已删除且 playback.module 不再注册 —— 本文件全部用例经
 * recordsQueryUrlSettings 驱动,grant 前置由 mgmtCookieOf(观看会话自身解锁)承担。
 *
 * 夹具(全部复用既有设施,本文件不改 fixtures/helpers/其他 spec):
 * - test/fixtures/playback/(seedPlaybackWorld/seedPlaybackSession);
 * - it「成功播放一次」需真实起播:IPTV(hls_proxy)候选探测无需 ffprobe(media-probe:
 *   hls_proxy 直接 ready),故注入本地 http 上游 + LAN_ALLOWED_TARGETS=127.0.0.1,并把
 *   playback_source.location 直改为上游清单地址(spec 内直改,权威 location 形态);
 * - 「异步准备失败」「重复 stop」等直接以 seedPlaybackSession 造对应状态会话(夹具语义);
 * - 分页 25 条混合记录 = 2 条 session(seedPlaybackSession)+ 23 条 playback_failure_event
 *   (DB 直插,注明 —— 失败事件的系统写入点 T043 未实现,分页用例只考察查询排序/游标,
 *   直插行满足 schema 复合 FK 与 CHECK);
 * - 失败事件稳定码口径:解析拒绝的公开稳定码 = 该次拒绝的 problem code
 *   (404 MEDIA_NOT_FOUND,api.md「失败事件只记录公开稳定码」),T043 按此落 stable_code。
 */

/* ------------------------------------------------------------------ */
/* 通用助手                                                            */
/* ------------------------------------------------------------------ */

/** 控制端点路径(api 全局前缀,与 main.ts/helpers.ts 一致) */
const RESOLVE_URL = '/api/playback/resolve';
const sessionUrl = (id: string): string => `/api/playback/sessions/${id}`;
/**
 * 记录查询唯一入口(005 US8 收口):api.md §6 末行 + §8「不保留旧 /devices 管理入口」——
 * 旧 POST /api/devices/{id}/playback-records/query(playback-records.controller)已删除,
 * playback.module 不再注册;权威实现 = POST /api/settings/devices/{id}/playback-records/query
 * (settings-devices.controller,Settings 边界:主档案选中+设置授予 → owner-only → 当次密码)。
 */
const recordsQueryUrlSettings = (deviceId: string): string => `/api/settings/devices/${deviceId}/playback-records/query`;

/** openapi PlaybackSessionRecord:additionalProperties:false 的精确键集(字典序) */
const SESSION_RECORD_KEYS = [
  'createdAt',
  'delivery',
  'deviceId',
  'endedAt',
  'failureCode',
  'id',
  'kind',
  'mediaId',
  'playbackSourceId',
  'positionSeconds',
  'profileId',
  'startedAt',
  'state',
] as const;

/** openapi PlaybackFailureRecord:additionalProperties:false 的精确键集(字典序;无 deviceId —— 查询本身设备维度) */
const FAILURE_RECORD_KEYS = ['id', 'kind', 'mediaId', 'occurredAt', 'profileId', 'stableCode'] as const;

function freshNow(): string {
  return new Date().toISOString();
}

function cookieOf(world: PlaybackWorld): string {
  return `${SESSION_COOKIE}=${world.sessionToken}`;
}

/** 稳定错误断言:status + RFC 9457 problem+json + 稳定码 */
function expectStableProblem(res: request.Response, status: number, code: ProblemCode): void {
  expect(res.status).toBe(status);
  expectProblemContentType(res);
  expect(res.body.code).toBe(code);
}

/** 同形断言:两响应的 problem 体逐字段一致(码与体结构一致,无法区分存在性) */
function expectSameProblemShape(a: request.Response, b: request.Response): void {
  expect(a.body).toEqual(b.body);
}

/** seedWorld 句柄:PlaybackWorld + 显式 username(登录类用例需要;多家庭须互用不同 username) */
type SeededWorld = PlaybackWorld & { readonly username: string };

/** 认证按 usernameNormalized 全局唯一:同 rig 多家庭必须互用不同 username */
async function seedWorld(rig: TestRig, options: SeedPlaybackWorldOptions = {}): Promise<SeededWorld> {
  const username = options.username ?? 'player';
  const world = await seedPlaybackWorld(rig, { ...options, username });
  return { ...world, username };
}

/** 同库第二家庭(跨家庭负向用):不同家庭名/用户名的独立世界 */
async function seedOtherHousehold(rig: TestRig, tag: string): Promise<SeededWorld> {
  return seedWorld(rig, { householdName: `${tag}-乙家庭`, username: `player-b-${tag}` });
}

/** 同账号新登录(新设备会话)并选择同一档案,模拟「另一台设备」(返回 Cookie 对) */
async function loginSecondDevice(app: INestApplication, world: SeededWorld): Promise<string> {
  const fresh = await login(app, world.username, world.password);
  expect(fresh.status).toBe(200);
  const freshCookie = cookiePairOf(fresh);
  const select = await request(app.getHttpServer())
    .post(`/api/profiles/${world.profileId}/select`)
    .set('Cookie', freshCookie)
    .send({});
  expect(select.status).toBe(200);
  return freshCookie;
}

/* ------------------------------------------------------------------ */
/* 请求助手(统一 Cookie 认证,与既有契约惯例一致)                       */
/* ------------------------------------------------------------------ */

function postResolve(app: INestApplication, cookie: string, mediaId: string): request.Test {
  return request(app.getHttpServer()).post(RESOLVE_URL).set('Cookie', cookie).send({ mediaId });
}

function postStop(app: INestApplication, cookie: string, id: string): request.Test {
  return request(app.getHttpServer()).post(`${sessionUrl(id)}/stop`).set('Cookie', cookie).send({});
}

function postRenew(app: INestApplication, cookie: string, id: string, expectedGeneration: number): request.Test {
  return request(app.getHttpServer()).post(`${sessionUrl(id)}/renew`).set('Cookie', cookie).send({ expectedGeneration });
}

function postLogout(app: INestApplication, cookie: string): request.Test {
  return request(app.getHttpServer()).post('/api/auth/logout').set('Cookie', cookie).send({});
}

/** 记录查询端点(005 收口后唯一入口):POST /api/settings/devices/{deviceId}/playback-records/query */
function queryRecords(app: INestApplication, cookie: string, deviceId: string, body: object): request.Test {
  return request(app.getHttpServer()).post(recordsQueryUrlSettings(deviceId)).set('Cookie', cookie).send(body);
}

/* ------------------------------------------------------------------ */
/* DB 断言/直改助手(注明用途,夹具缺变体时 spec 内补种)                 */
/* ------------------------------------------------------------------ */


/** US8:设备记录查询属 Settings 边界 —— 升格有 PIN 成人为主档案并以本会话解锁设置,返回该会话 Cookie */
async function mgmtCookieOf(rig: TestRig, world: PlaybackWorld): Promise<string> {
  Database.db
    .prepare("UPDATE profile SET is_main = 1 WHERE id = ? AND type = 'adult' AND status = 'active' AND pin_hash IS NOT NULL")
    .run(world.profileWithPinId);
  // 以观看会话自身解锁(幂等):grant 与解锁后的主档案选中落在同一会话,后续
  // world-cookie 的查询/断言链路无需区分「观看会话/管理会话」两套 Cookie。
  await selectMainAndUnlockSettings(rig.app, cookieOf(world), { mainPin: world.pin });
  return cookieOf(world);
}

function sessionRowsOfHousehold(householdId: string): (typeof playbackSession.$inferSelect)[] {
  return getDb().select().from(playbackSession).where(eq(playbackSession.householdId, householdId)).all();
}

function failureEventRowsOfHousehold(householdId: string): (typeof playbackFailureEvent.$inferSelect)[] {
  return getDb().select().from(playbackFailureEvent).where(eq(playbackFailureEvent.householdId, householdId)).all();
}

function sessionRowOf(id: string): typeof playbackSession.$inferSelect {
  const row = getDb().select().from(playbackSession).where(eq(playbackSession.id, id)).get();
  if (row === undefined) {
    throw new Error(`夹具错误:playback_session ${id} 不存在`);
  }
  return row;
}

/** DB 直插失败事件(仅分页/边界用例:系统写入点 T043 未实现;复合 FK/CHECK 由 schema 保证) */
function insertFailureEvent(input: {
  id: string;
  householdId: string;
  deviceSessionId: string;
  deviceId: string;
  profileId: string | null;
  mediaId: string | null;
  occurredAt: string;
  stableCode: string;
}): void {
  getDb().insert(playbackFailureEvent).values(input).run();
}

/** DB 直撤设备会话(撤销语义的库内形态;SessionGuard 实时重读,与 logout 等价) */
function revokeDeviceSessionRow(deviceSessionId: string): void {
  getDb().update(deviceSession).set({ revokedAt: freshNow() }).where(eq(deviceSession.id, deviceSessionId)).run();
}

/* ------------------------------------------------------------------ */
/* 成功起播夹具:本地 HLS 上游(IPTV hls_proxy 候选探测无需 ffprobe)     */
/* ------------------------------------------------------------------ */

const MASTER_PLAYLIST_TEXT = ['#EXTM3U', '#EXT-X-VERSION:6', '#EXT-X-STREAM-INF:BANDWIDTH=800000', 'hi.m3u8', ''].join(
  '\n',
);
const MEDIA_PLAYLIST_TEXT = [
  '#EXTM3U',
  '#EXT-X-VERSION:6',
  '#EXT-X-TARGETDURATION:4',
  '#EXTINF:4.0,',
  'seg-0.ts',
  '',
].join('\n');
const SEGMENT_BYTES = Buffer.alloc(1024, 0xab);

const upstreamServers: { close(): Promise<void> }[] = [];

/** 本地 http 上游(127.0.0.1 随机端口),afterEach 统一关闭避免监听句柄泄漏 */
async function startHlsUpstream(): Promise<string> {
  const server = http.createServer((req, res) => {
    const url = req.url ?? '';
    const text = (body: string, contentType: string): void => {
      res.writeHead(200, {
        'content-type': contentType,
        'content-length': String(Buffer.byteLength(body)),
        connection: 'close',
      });
      res.end(body);
    };
    if (url === '/live/master.m3u8') return text(MASTER_PLAYLIST_TEXT, 'application/vnd.apple.mpegurl');
    if (url === '/live/hi.m3u8') return text(MEDIA_PLAYLIST_TEXT, 'application/vnd.apple.mpegurl');
    if (url === '/live/seg-0.ts') {
      res.writeHead(200, {
        'content-type': 'video/mp2t',
        'content-length': String(SEGMENT_BYTES.length),
        connection: 'close',
      });
      res.end(SEGMENT_BYTES);
      return;
    }
    res.writeHead(404, { connection: 'close' });
    res.end('not found');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const port = typeof address === 'object' && address !== null ? address.port : 0;
  upstreamServers.push({
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    },
  });
  return `http://127.0.0.1:${port}`;
}

/** 改写夹具 IPTV 播放资源的 location(可达上游;media-probe 对 hls_proxy 候选不取上游) */
function setIptvSourceLocation(world: PlaybackWorld, location: string): void {
  getDb()
    .update(playbackSource)
    .set({ location })
    .where(eq(playbackSource.id, world.iptv.playbackSourceId))
    .run();
}

/** 轮询 GET session 直至 ready(hls_proxy prepare 为 fire-and-forget);终态/超时立即报错 */
async function waitForReady(app: INestApplication, cookie: string, sessionId: string, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const res = await request(app.getHttpServer()).get(sessionUrl(sessionId)).set('Cookie', cookie);
    expect(res.status).toBe(200);
    const state = String((res.body as Record<string, unknown>)['state']);
    if (state === 'ready') {
      return;
    }
    if (state === 'failed' || state === 'ended' || state === 'interrupted') {
      throw new Error(`夹具错误:会话在就绪前进入终态 ${state}(上游/探测未按 hls_proxy 直达 ready 语义工作)`);
    }
    if (Date.now() > deadline) {
      throw new Error(`夹具错误:会话 ${timeoutMs}ms 内未就绪(最后 state=${state})`);
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

/** 记录页信封断言:恰 {items,nextCursor} 两键,items 为数组 */
function expectPageEnvelope(body: Record<string, unknown>): void {
  expect(Object.keys(body).sort()).toEqual(['items', 'nextCursor']);
  expect(Array.isArray(body['items'])).toBe(true);
}

/** 失败事件统一时间戳序列(倒序分页确定性;i 分钟前;ISO UTC 文本比较=时间比较) */
function minutesAgoIso(minutes: number): string {
  return new Date(Date.now() - minutes * 60_000).toISOString();
}

afterEach(async () => {
  await cleanupRigs();
  while (upstreamServers.length > 0) {
    const upstream = upstreamServers.pop();
    if (upstream === undefined) {
      break;
    }
    await upstream.close();
  }
});

/* ------------------------------------------------------------------ */
/* 记录生成(T043 写入路径)                                             */
/* ------------------------------------------------------------------ */

describe('记录生成(session 记录 / failure 事件分离,T043)', () => {
  it('成功播放一次(resolve→ready→renew→首次 GET 媒体→stop)→ 记录恰一条 session:字段齐全、startedAt/endedAt 非空、无 failureCode、无源位置/票', async () => {
    const upstreamOrigin = await startHlsUpstream();
    const rig = await startFreshApp({ prefix: 'hmp-pb-rec-ok-', env: { LAN_ALLOWED_TARGETS: '127.0.0.1' } });
    const world = await seedWorld(rig);
    setIptvSourceLocation(world, `${upstreamOrigin}/live/master.m3u8`);
    const cookie = cookieOf(world);

    // 1) resolve → 201 preparing(US1 既有路径)
    const resolve = await postResolve(rig.app, cookie, world.iptv.mediaId);
    expect(resolve.status).toBe(201);
    const sessionId = String((resolve.body as Record<string, unknown>)['id']);

    // 2) ready(hls_proxy 候选直达,不依赖 ffprobe)
    await waitForReady(rig.app, cookie, sessionId);

    // 3) renew 取会话化播放地址(媒体资产 URL 唯一合法来源)
    const renew = await postRenew(rig.app, cookie, sessionId, 1);
    expect(renew.status).toBe(200);
    const playbackUrl = String((renew.body as Record<string, unknown>)['playbackUrl']);
    expect(playbackUrl.startsWith('/api/playback/stream/')).toBe(true);

    // 4) 首次 GET 媒体 → 200 且首次交付 playing(started_at 一次)
    const firstDelivery = await request(rig.app.getHttpServer()).get(playbackUrl).set('Cookie', cookie);
    expect(firstDelivery.status).toBe(200);
    expect(sessionRowOf(sessionId).state).toBe('playing');
    expect(sessionRowOf(sessionId).startedAt).not.toBeNull();

    // 5) stop → 204,ended_at 落库
    expect((await postStop(rig.app, cookie, sessionId)).status).toBe(204);
    expect(sessionRowOf(sessionId).state).toBe('ended');
    expect(sessionRowOf(sessionId).endedAt).not.toBeNull();

    // 6) 家长记录查询(US8 settings 端点:独立管理会话;成功体为普通 JSON)
    const page = await request(rig.app.getHttpServer())
      .post(recordsQueryUrlSettings(world.deviceId))
      .set('Cookie', await mgmtCookieOf(rig, world))
      .send({ ownerPassword: world.password });
    expect(page.status).toBe(200);
    expect(String(page.headers['content-type'])).toContain('application/json');
    const body = page.body as Record<string, unknown>;
    expectPageEnvelope(body);
    expect(body['nextCursor']).toBeNull();
    const items = body['items'] as Record<string, unknown>[];
    expect(items).toHaveLength(1);
    const item = items[0];
    if (item === undefined) {
      throw new Error('不可达:items 已断言长度 1');
    }
    expect(Object.keys(item).sort()).toEqual([...SESSION_RECORD_KEYS]);
    expect(item['kind']).toBe('session');
    expect(item['id']).toBe(sessionId);
    expect(item['deviceId']).toBe(world.deviceId);
    expect(item['profileId']).toBe(world.profileId);
    expect(item['mediaId']).toBe(world.iptv.mediaId);
    // 所选资源只以不透明 playbackSourceId 呈现(标识而非位置)
    expect(item['playbackSourceId']).toBe(world.iptv.playbackSourceId);
    expect(item['state']).toBe('ended');
    expect(item['delivery']).toBe('hls_proxy');
    expect(typeof item['positionSeconds']).toBe('number');
    expect(item['positionSeconds'] as number).toBeGreaterThanOrEqual(0);
    // startedAt 非空(首次交付)、endedAt 非空(stop 触发)、无失败码
    expect(typeof item['createdAt']).toBe('string');
    expect(typeof item['startedAt']).toBe('string');
    expect(typeof item['endedAt']).toBe('string');
    expect(Number.isFinite(Date.parse(String(item['startedAt'])))).toBe(true);
    expect(Number.isFinite(Date.parse(String(item['endedAt'])))).toBe(true);
    expect(item['failureCode']).toBeNull();
    // no-store + 无源位置/ticket/路径(api.md 记录查询行为列)
    expect(String(page.headers['cache-control'])).toContain('no-store');
    const serialized = JSON.stringify(body);
    expect(serialized.toLowerCase()).not.toContain('ticket');
    expect(serialized.toLowerCase()).not.toContain('playbackurl');
    expect(serialized.toLowerCase()).not.toContain('token');
    expect(serialized).not.toContain(upstreamOrigin);
    expect(serialized).not.toContain('/nas-media/');
    expect(serialized).not.toContain('iptv.playback-fixture.test');
    expect(serialized).not.toContain('location');
  });

  it('有效会话解析被拒(策略黑名单/可见但无启用源)→ 独立 failure 记录(stableCode=公开稳定码、mediaId 按可见性保留),不建播放会话', async () => {
    const rig = await startFreshApp({ prefix: 'hmp-pb-rec-fail-' });
    const world = await seedWorld(rig); // 默认 NAS 停用 → nas.mediaId 为「可见但无启用播放源」代表
    const cookie = cookieOf(world);

    // 儿童档案 + 黑名单:可见媒体的策略拒绝(同形 404,不泄漏策略明细)
    // 005 设置边界:播放世界无主档案标记 —— 把「有 PIN 成人」升格为主档案,并以独立管理会话执行管理写
    Database.db
      .prepare("UPDATE profile SET is_main = 1 WHERE id = ? AND type = 'adult' AND status = 'active' AND pin_hash IS NOT NULL")
      .run(world.profileWithPinId);
    const mgmtLogin = await request(rig.app.getHttpServer())
      .post('/api/auth/login')
      .send({ username: world.username, password: world.password });
    expect(mgmtLogin.status).toBe(200);
    const mgmtCookie = cookiePairOf(mgmtLogin);
    await selectMainAndUnlockSettings(rig.app, mgmtCookie, { mainPin: world.pin });
    const created = await request(rig.app.getHttpServer())
      .post('/api/settings/profiles')
      .set('Cookie', mgmtCookie)
      .send({ name: '记录儿童', type: 'child', ownerPassword: world.password });
    expect(created.status).toBe(201);
    const childProfileId = String((created.body as Record<string, unknown>)['id']);
    expect(
      (
        await request(rig.app.getHttpServer())
          .put(`/api/settings/profiles/${childProfileId}/policy/lists`)
          .set('Cookie', mgmtCookie)
          .send({
            ownerPassword: world.password,
            expectedVersion: 1,
            // 三名单整体替换(既有契约:三个数组必填)
            allowedMediaIds: [],
            blockedMediaIds: [world.iptv.mediaId],
            allowedChannelIds: [],
          })
      ).status,
    ).toBe(200);

    // 观看会话切到儿童(名单黑名单生效),两次被拒解析:策略拒绝 + 无启用源 → 同形 404
    const childSelected = await request(rig.app.getHttpServer())
      .post(`/api/profiles/${childProfileId}/select`)
      .set('Cookie', cookie)
      .send({});
    expect(childSelected.status, JSON.stringify(childSelected.body)).toBe(200);
    const blocked = await postResolve(rig.app, cookie, world.iptv.mediaId);
    expectStableProblem(blocked, 404, ProblemCode.MEDIA_NOT_FOUND);
    const sourceless = await postResolve(rig.app, cookie, world.nas.mediaId);
    expectStableProblem(sourceless, 404, ProblemCode.MEDIA_NOT_FOUND);

    // 不建播放会话:session 行为 0,failure_event 恰 2 行(DB 侧独立于查询接口断言)
    expect(sessionRowsOfHousehold(world.householdId)).toHaveLength(0);
    expect(failureEventRowsOfHousehold(world.householdId)).toHaveLength(2);

    // 家长查询:两条独立 failure 记录,稳定码=该次拒绝的公开稳定码,媒体可见故 mediaId 保留
    const page = await queryRecords(rig.app, await mgmtCookieOf(rig, world), world.deviceId, { ownerPassword: world.password });
    expect(page.status).toBe(200);
    const body = page.body as Record<string, unknown>;
    expectPageEnvelope(body);
    const items = body['items'] as Record<string, unknown>[];
    expect(items).toHaveLength(2);
    for (const item of items) {
      expect(Object.keys(item).sort()).toEqual([...FAILURE_RECORD_KEYS]);
      expect(item['kind']).toBe('failure');
      expect(item['stableCode']).toBe('MEDIA_NOT_FOUND');
      expect(item['profileId']).toBe(childProfileId);
      expect(Number.isFinite(Date.parse(String(item['occurredAt'])))).toBe(true);
      expect(typeof item['id']).toBe('string');
    }
    const mediaIds = items.map((item) => item['mediaId']).sort();
    expect(mediaIds).toEqual([world.iptv.mediaId, world.nas.mediaId].sort());
  });

  it('不可见媒体解析失败 → failure 记录 mediaId=null,不存客户端原始目标 ID', async () => {
    const rig = await startFreshApp({ prefix: 'hmp-pb-rec-invisible-' });
    const world = await seedWorld(rig);
    const cookie = cookieOf(world);

    const denied = await postResolve(rig.app, cookie, world.invisibleMediaId);
    expectStableProblem(denied, 404, ProblemCode.MEDIA_NOT_FOUND);

    // DB 侧:media_id 为 NULL(不存客户端原始 ID)
    const rows = failureEventRowsOfHousehold(world.householdId);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.mediaId).toBeNull();
    expect(rows[0]?.profileId).toBe(world.profileId);

    // 查询侧:failure 记录 mediaId=null,且响应体不出现客户端原始目标 ID
    const page = await queryRecords(rig.app, await mgmtCookieOf(rig, world), world.deviceId, { ownerPassword: world.password });
    expect(page.status).toBe(200);
    const items = (page.body as Record<string, unknown>)['items'] as Record<string, unknown>[];
    expect(items).toHaveLength(1);
    const item = items[0];
    if (item === undefined) {
      throw new Error('不可达:items 已断言长度 1');
    }
    expect(Object.keys(item).sort()).toEqual([...FAILURE_RECORD_KEYS]);
    expect(item['kind']).toBe('failure');
    expect(item['mediaId']).toBeNull();
    expect(item['stableCode']).toBe('MEDIA_NOT_FOUND');
    expect(JSON.stringify(page.body)).not.toContain(world.invisibleMediaId);
  });

  it('无效会话(伪造/过期)resolve → 401 且零记录行(session 与 failure 均无;仅脱敏安全日志,不写设备记录)', async () => {
    const rig = await startFreshApp({ prefix: 'hmp-pb-rec-invalid-' });
    const world = await seedWorld(rig);
    // 独立家庭:过期设备会话(夹具参数 expires_at 落在过去)
    const expired = await seedWorld(rig, {
      householdName: '过期会话家庭',
      username: 'expired-player',
      sessionExpiresAt: '2026-10-23T07:00:00.000Z',
    });

    expectStableProblem(
      await postResolve(rig.app, `${SESSION_COOKIE}=forged-token-not-in-db`, world.iptv.mediaId),
      401,
      ProblemCode.SESSION_INVALID,
    );
    expectStableProblem(
      await postResolve(rig.app, cookieOf(expired), expired.iptv.mediaId),
      401,
      ProblemCode.SESSION_INVALID,
    );

    // 服务端不崩(401 正常),且两个家庭均零记录行:无效会话不写设备记录
    expect(sessionRowsOfHousehold(world.householdId)).toHaveLength(0);
    expect(failureEventRowsOfHousehold(world.householdId)).toHaveLength(0);
    expect(sessionRowsOfHousehold(expired.householdId)).toHaveLength(0);
    expect(failureEventRowsOfHousehold(expired.householdId)).toHaveLength(0);
    const page = await queryRecords(rig.app, await mgmtCookieOf(rig, world), world.deviceId, { ownerPassword: world.password });
    expect(page.status).toBe(200);
    expectPageEnvelope(page.body as Record<string, unknown>);
    expect((page.body as Record<string, unknown>)['items']).toEqual([]);
    expect((page.body as Record<string, unknown>)['nextCursor']).toBeNull();
  });

  it('异步准备失败(resolve 201 后 failed,夹具造 failed session)→ 不产生 failure_event(异步失败只更新 session),记录显示 session.failureCode', async () => {
    const rig = await startFreshApp({ prefix: 'hmp-pb-rec-async-' });
    const world = await seedWorld(rig);
    // 夹具造「准备失败」形态:未解析源(playbackSourceId/delivery/startedAt 空)+终态+稳定失败码
    const seeded = seedPlaybackSession(world, {
      state: 'failed',
      playbackSourceId: null,
      failureCode: 'PLAYBACK_FORMAT_UNSUPPORTED',
      mediaId: world.iptv.mediaId,
      at: freshNow(),
    });

    // data-model/api.md:异步 probe/转换失败记录在已有 session,不写 failure_event(T019 语义)
    expect(failureEventRowsOfHousehold(world.householdId)).toHaveLength(0);
    expect(sessionRowsOfHousehold(world.householdId)).toHaveLength(1);

    const page = await queryRecords(rig.app, await mgmtCookieOf(rig, world), world.deviceId, { ownerPassword: world.password });
    expect(page.status).toBe(200);
    const items = (page.body as Record<string, unknown>)['items'] as Record<string, unknown>[];
    expect(items).toHaveLength(1);
    const item = items[0];
    if (item === undefined) {
      throw new Error('不可达:items 已断言长度 1');
    }
    expect(Object.keys(item).sort()).toEqual([...SESSION_RECORD_KEYS]);
    expect(item['kind']).toBe('session');
    expect(item['id']).toBe(seeded.sessionId);
    expect(item['state']).toBe('failed');
    expect(item['failureCode']).toBe('PLAYBACK_FORMAT_UNSUPPORTED');
    expect(item['playbackSourceId']).toBeNull();
    expect(item['delivery']).toBeNull();
    expect(item['startedAt']).toBeNull();
    expect(typeof item['endedAt']).toBe('string');
  });

  it('重复 stop → 幂等:ended_at 不变,记录仅一条,无第二个结束事件', async () => {
    const rig = await startFreshApp({ prefix: 'hmp-pb-rec-restop-' });
    const world = await seedWorld(rig);
    const seeded: PlaybackSessionFixture = seedPlaybackSession(world, {
      state: 'playing',
      mediaId: world.iptv.mediaId,
      playbackSourceId: world.iptv.playbackSourceId,
      delivery: 'hls_proxy',
      at: freshNow(),
    });
    const cookie = cookieOf(world);

    expect((await postStop(rig.app, cookie, seeded.sessionId)).status).toBe(204);
    const endedAtAfterFirst = sessionRowOf(seeded.sessionId).endedAt;
    expect(endedAtAfterFirst).not.toBeNull();
    expect((await postStop(rig.app, cookie, seeded.sessionId)).status).toBe(204);
    // 重复 stop 不改写结束时间:仅一个结束事件
    expect(sessionRowOf(seeded.sessionId).endedAt).toBe(endedAtAfterFirst);

    const page = await queryRecords(rig.app, await mgmtCookieOf(rig, world), world.deviceId, { ownerPassword: world.password });
    expect(page.status).toBe(200);
    const items = (page.body as Record<string, unknown>)['items'] as Record<string, unknown>[];
    expect(items).toHaveLength(1);
    const item = items[0];
    if (item === undefined) {
      throw new Error('不可达:items 已断言长度 1');
    }
    expect(item['kind']).toBe('session');
    expect(item['id']).toBe(seeded.sessionId);
    expect(item['state']).toBe('ended');
    expect(item['endedAt']).toBe(endedAtAfterFirst);
    expect(failureEventRowsOfHousehold(world.householdId)).toHaveLength(0);
  });
});

/* ------------------------------------------------------------------ */
/* 查询接口(T044:owner 当次密码/锁定/撤销/边界/分页/脱敏)              */
/* ------------------------------------------------------------------ */

describe('POST /api/settings/devices/{deviceId}/playback-records/query(T044 定形 → T130 settings 收口)', () => {
  it('owner 当次密码正确 → 200 {items,nextCursor};缺失/空串 → 403 REQUIRED;错误 → 403 FAILED;成功验证清零后仍可查', async () => {
    const rig = await startFreshApp({ prefix: 'hmp-pb-rec-auth-' });
    const world = await seedWorld(rig);
    const cookie = cookieOf(world);
    seedPlaybackSession(world, { state: 'ended', at: freshNow() });

    // 正确当次密码 → 200 信封(当次密码不发放任何长期家长态)
    const ok = await queryRecords(rig.app, await mgmtCookieOf(rig, world), world.deviceId, { ownerPassword: world.password });
    expect(ok.status).toBe(200);
    expectPageEnvelope(ok.body as Record<string, unknown>);
    expect(String(ok.headers['cache-control'])).toContain('no-store');

    // 缺失/空串密码:按现有家长验证规则拒绝(403 PARENT_VERIFICATION_REQUIRED)
    expectStableProblem(
      await queryRecords(rig.app, cookie, world.deviceId, {}),
      403,
      ProblemCode.PARENT_VERIFICATION_REQUIRED,
    );
    expectStableProblem(
      await queryRecords(rig.app, cookie, world.deviceId, { ownerPassword: '' }),
      403,
      ProblemCode.PARENT_VERIFICATION_REQUIRED,
    );

    // 错误密码:403 PARENT_VERIFICATION_FAILED(计数落库);成功验证清零,随后仍可查
    expectStableProblem(
      await queryRecords(rig.app, cookie, world.deviceId, { ownerPassword: 'wrong-password' }),
      403,
      ProblemCode.PARENT_VERIFICATION_FAILED,
    );
    const again = await queryRecords(rig.app, await mgmtCookieOf(rig, world), world.deviceId, { ownerPassword: world.password });
    expect(again.status).toBe(200);
    expect(((again.body as Record<string, unknown>)['items'] as unknown[]).length).toBeGreaterThan(0);
  });

  it('连错 5 次 → 第 5 次仍 403 并落锁定窗口;锁定窗口内正确密码仍拒 → 423 LOCKED(既有家长验证语义)', async () => {
    const rig = await startFreshApp({ prefix: 'hmp-pb-rec-lock-' });
    const world = await seedWorld(rig);
    const cookie = cookieOf(world);
    // 005 §7:grant 先于当次密码 —— 记录查询属设置主体,先解锁设置再验证密码错误计数
    await mgmtCookieOf(rig, world);

    for (let attempt = 0; attempt < 5; attempt += 1) {
      expectStableProblem(
        await queryRecords(rig.app, cookie, world.deviceId, { ownerPassword: `wrong-${attempt}` }),
        403,
        ProblemCode.PARENT_VERIFICATION_FAILED,
      );
    }
    // 锁定窗口内正确密码也拒(不校验密码)
    const locked = await queryRecords(rig.app, await mgmtCookieOf(rig, world), world.deviceId, { ownerPassword: world.password });
    expect(locked.status).toBe(423);
    expectProblemContentType(locked);
    expect((locked.body as { code?: string }).code).toBe(ProblemCode.PARENT_VERIFICATION_LOCKED);
  });

  it('owner 会话撤销(logout / DB 直撤)→ 401 SESSION_INVALID(密码校验之前先拒绝)', async () => {
    const rig = await startFreshApp({ prefix: 'hmp-pb-rec-revoke-' });
    const logoutWorld = await seedWorld(rig, { username: 'logout-owner' });
    const dbRevokeWorld = await seedWorld(rig, { householdName: '直撤家庭', username: 'revoke-owner' });

    // logout(HTTP 既有路径):204 后下一请求即拒
    expect((await postLogout(rig.app, cookieOf(logoutWorld))).status).toBe(204);
    expectStableProblem(
      await queryRecords(rig.app, cookieOf(logoutWorld), logoutWorld.deviceId, {
        ownerPassword: logoutWorld.password,
      }),
      401,
      ProblemCode.SESSION_INVALID,
    );

    // DB 直撤(注明:revoked_at 置位,logout 的库内等价形态)
    revokeDeviceSessionRow(dbRevokeWorld.deviceSessionId);
    expectStableProblem(
      await queryRecords(rig.app, cookieOf(dbRevokeWorld), dbRevokeWorld.deviceId, {
        ownerPassword: dbRevokeWorld.password,
      }),
      401,
      ProblemCode.SESSION_INVALID,
    );
  });

  it('跨家庭 deviceId → 与不存在设备同形 404(密码正确仍拒,不泄漏存在性);非 owner 账号 → 403 FORBIDDEN', async () => {
    const rig = await startFreshApp({ prefix: 'hmp-pb-rec-scope-' });
    const world = await seedWorld(rig);
    const other = await seedOtherHousehold(rig, world.householdId.slice(0, 8));
    // 005 §7:grant 先于当次密码/归属重验 —— 记录查询属设置主体,先解锁设置
    const cookie = await mgmtCookieOf(rig, world);

    // 跨家庭目标:owner + 正确密码仍统一 404,与不存在设备同形(openapi:不泄漏归属)
    const crossHousehold = await queryRecords(rig.app, cookie, other.deviceId, {
      ownerPassword: world.password,
    });
    expect(crossHousehold.status).toBe(404);
    expectProblemContentType(crossHousehold);
    const missing = await queryRecords(rig.app, cookie, randomUUID(), { ownerPassword: world.password });
    expect(missing.status).toBe(404);
    expectSameProblemShape(crossHousehold, missing);

    // 非 owner 角色(DB 直改注明):会话有效+密码正确仍 403 FORBIDDEN(家长查询仅 owner)
    getDb()
      .update(account)
      .set({ role: 'admin' })
      .where(eq(account.id, world.accountId))
      .run();
    expectStableProblem(
      await queryRecords(rig.app, cookie, world.deviceId, { ownerPassword: world.password }),
      403,
      ProblemCode.FORBIDDEN,
    );
  });

  it('limit 请求校验:0/101/负数/小数/非数字 → 400 VALIDATION_FAILED;未知字段拒绝', async () => {
    const rig = await startFreshApp({ prefix: 'hmp-pb-rec-limit-' });
    const world = await seedWorld(rig);
    // 005 §7:严格入参在 grant 之后 —— 先解锁设置,未知字段/越界 limit 才落到 400 管道
    const cookie = await mgmtCookieOf(rig, world);

    for (const limit of [0, 101, -1, 1.5, '20']) {
      expectStableProblem(
        await queryRecords(rig.app, cookie, world.deviceId, { ownerPassword: world.password, limit }),
        400,
        ProblemCode.VALIDATION_FAILED,
      );
    }
    expectStableProblem(
      await queryRecords(rig.app, cookie, world.deviceId, { ownerPassword: world.password, foge: '未知字段' }),
      400,
      ProblemCode.VALIDATION_FAILED,
    );
  });

  it('分页与倒序:25 条混合记录(2 session + 23 failure 直插,注明)→ 默认 limit=20 翻页到底、limit=100 单页、limit=7 走完全局 (时间,id) 倒序、同刻 id 决胜、无重复、到底 nextCursor=null', async () => {
    const rig = await startFreshApp({ prefix: 'hmp-pb-rec-page-' });
    const world = await seedWorld(rig);
    const cookie = cookieOf(world);

    // 25 条混合记录:21 条单时刻 failure + 1 对同刻 failure(DB 直插,共 23 条;系统写入点
    // T043 未实现,分页用例只考察查询排序/游标)+ 2 条 session(created_at 交错时间轴)。
    interface Entry {
      readonly id: string;
      readonly time: string;
      readonly kind: 'session' | 'failure';
    }
    const entries: Entry[] = [];
    const addFailure = (time: string, id: string): void => {
      insertFailureEvent({
        id,
        householdId: world.householdId,
        deviceSessionId: world.deviceSessionId,
        deviceId: world.deviceId,
        profileId: world.profileId,
        mediaId: world.iptv.mediaId,
        occurredAt: time,
        stableCode: 'MEDIA_NOT_FOUND',
      });
      entries.push({ id, time, kind: 'failure' });
    };

    // 单时刻 failure:t(0)=now … t(20)=20 分钟前,共 21 条
    for (let slot = 0; slot <= 20; slot += 1) {
      addFailure(minutesAgoIso(slot), randomUUID());
    }
    // 同刻 failure 对:t(30) 两条,id 字典序大者应排前((time,id) 倒序决胜)
    const tieIds = [randomUUID(), randomUUID()].sort((a, b) => (a < b ? 1 : -1));
    const firstTieId = tieIds[0];
    const secondTieId = tieIds[1];
    if (firstTieId === undefined || secondTieId === undefined) {
      throw new Error('不可达:tieIds 恒两元素');
    }
    const tieTime = minutesAgoIso(30);
    addFailure(tieTime, firstTieId);
    addFailure(tieTime, secondTieId);

    // 两条 session:created_at 交错进时间轴(2.5/18.5 分钟前,不与任何 failure 同刻)
    const sessionAt = (minutes: number): PlaybackSessionFixture =>
      seedPlaybackSession(world, {
        state: 'ended',
        mediaId: world.iptv.mediaId,
        playbackSourceId: world.iptv.playbackSourceId,
        delivery: 'hls_proxy',
        at: minutesAgoIso(minutes),
      });
    for (const seeded of [sessionAt(2.5), sessionAt(18.5)]) {
      const row = sessionRowOf(seeded.sessionId);
      entries.push({ id: row.id, time: row.createdAt, kind: 'session' });
    }
    expect(entries).toHaveLength(25);

    // 期望全序:(time,id) 倒序;同刻对按 id 字典序倒序相邻
    const expectedIds = [...entries]
      .sort((a, b) => (a.time !== b.time ? (a.time < b.time ? 1 : -1) : a.id < b.id ? 1 : -1))
      .map((entry) => entry.id);

    // 默认 limit=20:首页 20 条 + nextCursor 非空;cursor 翻页 5 条到底(null)
    const firstPage = await queryRecords(rig.app, await mgmtCookieOf(rig, world), world.deviceId, { ownerPassword: world.password });
    expect(firstPage.status).toBe(200);
    const firstBody = firstPage.body as Record<string, unknown>;
    expectPageEnvelope(firstBody);
    const firstItems = firstBody['items'] as Record<string, unknown>[];
    expect(firstItems).toHaveLength(20);
    const firstCursor = firstBody['nextCursor'];
    expect(typeof firstCursor).toBe('string');
    const secondPage = await queryRecords(rig.app, cookie, world.deviceId, {
      ownerPassword: world.password,
      cursor: firstCursor,
    });
    expect(secondPage.status).toBe(200);
    const secondBody = secondPage.body as Record<string, unknown>;
    const secondItems = secondBody['items'] as Record<string, unknown>[];
    expect(secondItems).toHaveLength(5);
    expect(secondBody['nextCursor']).toBeNull();
    expect([...firstItems, ...secondItems].map((item) => item['id'])).toEqual(expectedIds);

    // limit=100(上限内):25 条单页,nextCursor=null
    const fullPage = await queryRecords(rig.app, cookie, world.deviceId, {
      ownerPassword: world.password,
      limit: 100,
    });
    expect(fullPage.status).toBe(200);
    const fullBody = fullPage.body as Record<string, unknown>;
    const fullItems = fullBody['items'] as Record<string, unknown>[];
    expect(fullItems).toHaveLength(25);
    expect(fullBody['nextCursor']).toBeNull();

    // limit=7 走完:4 页(7/7/7/4),全局 (时间,id) 倒序,无重复,到底 nextCursor=null
    const walked: Record<string, unknown>[] = [];
    let cursor: string | null = null;
    for (let pageNumber = 0; pageNumber < 10; pageNumber += 1) {
      const res = await queryRecords(rig.app, cookie, world.deviceId, {
        ownerPassword: world.password,
        limit: 7,
        ...(cursor !== null ? { cursor } : {}),
      });
      expect(res.status).toBe(200);
      const pageBody = res.body as Record<string, unknown>;
      expectPageEnvelope(pageBody);
      const pageItems = pageBody['items'] as Record<string, unknown>[];
      expect(pageItems.length).toBeLessThanOrEqual(7);
      walked.push(...pageItems);
      const nextCursor = pageBody['nextCursor'];
      if (typeof nextCursor !== 'string') {
        expect(nextCursor).toBeNull();
        break;
      }
      cursor = nextCursor;
    }
    expect(walked).toHaveLength(25);
    expect(walked.map((item) => item['id'])).toEqual(expectedIds);
    expect(new Set(walked.map((item) => item['id'])).size).toBe(25);
    // 混合种类并存:session 记录按 created_at 与 failure 按 occurred_at 参与同一全序
    const kinds = new Set(walked.map((item) => item['kind']));
    expect(kinds.has('session')).toBe(true);
    expect(kinds.has('failure')).toBe(true);
    // 同刻对相邻且 id 字典序倒序(大者在前)
    const tieIndexOfSecond = walked.findIndex((item) => item['id'] === secondTieId);
    expect(tieIndexOfSecond).toBeGreaterThan(0);
    expect(walked[tieIndexOfSecond - 1]?.['id']).toBe(firstTieId);
  });

  it('响应头 no-store/no-referrer;响应体无源位置/路径/ticket/playbackUrl(session+failure 混合页)', async () => {
    const rig = await startFreshApp({ prefix: 'hmp-pb-rec-headers-' });
    const world = await seedWorld(rig, { nasEnabled: true });
    // NAS 源会话(location=/nas-media/… 不对下发)+ 一条 failure 直插:两类记录同页脱敏
    seedPlaybackSession(world, {
      state: 'failed',
      mediaId: world.nas.mediaId,
      playbackSourceId: world.nas.playbackSourceId,
      delivery: 'direct',
      failureCode: 'PLAYBACK_RESOURCE_UNAVAILABLE',
      at: freshNow(),
    });
    insertFailureEvent({
      id: randomUUID(),
      householdId: world.householdId,
      deviceSessionId: world.deviceSessionId,
      deviceId: world.deviceId,
      profileId: world.profileId,
      mediaId: world.nas.mediaId,
      occurredAt: freshNow(),
      stableCode: 'MEDIA_NOT_FOUND',
    });

    const page = await queryRecords(rig.app, await mgmtCookieOf(rig, world), world.deviceId, { ownerPassword: world.password });
    expect(page.status).toBe(200);
    expect(String(page.headers['cache-control'])).toContain('no-store');
    expect(String(page.headers['referrer-policy'])).toBe('no-referrer');
    const serialized = JSON.stringify(page.body).toLowerCase();
    expect(serialized).not.toContain('/nas-media/');
    expect(serialized).not.toContain('iptv.playback-fixture.test');
    expect(serialized).not.toContain('ticket');
    expect(serialized).not.toContain('playbackurl');
    expect(serialized).not.toContain('token');
    expect(serialized).not.toContain('location');
    expect(serialized).not.toContain('http://');
  });

  it('记录仅含本家庭该设备:同家庭另一设备记录不混入;跨家庭记录不可见(精确 id 集合断言)', async () => {
    const rig = await startFreshApp({ prefix: 'hmp-pb-rec-scope2-' });
    const world = await seedWorld(rig);
    const cookie = cookieOf(world);
    const other = await seedOtherHousehold(rig, world.householdId.slice(0, 8));

    // 本设备:一条 session 记录 + 一条 failure 直插
    const ownSession = seedPlaybackSession(world, {
      state: 'ended',
      mediaId: world.iptv.mediaId,
      playbackSourceId: world.iptv.playbackSourceId,
      delivery: 'hls_proxy',
      at: freshNow(),
    });
    const ownFailureId = randomUUID();
    insertFailureEvent({
      id: ownFailureId,
      householdId: world.householdId,
      deviceSessionId: world.deviceSessionId,
      deviceId: world.deviceId,
      profileId: world.profileId,
      mediaId: world.iptv.mediaId,
      occurredAt: freshNow(),
      stableCode: 'MEDIA_NOT_FOUND',
    });

    // 同家庭另一台设备(新登录+选择档案后真实 resolve 建会话)
    const secondDeviceCookie = await loginSecondDevice(rig.app, world);
    const secondResolve = await postResolve(rig.app, secondDeviceCookie, world.iptv.mediaId);
    expect(secondResolve.status).toBe(201);
    const secondSessionId = String((secondResolve.body as Record<string, unknown>)['id']);

    // 跨家庭:乙家庭的 session 记录
    seedPlaybackSession(other, { state: 'ended', at: freshNow() });

    // 查询本设备:精确 id 集合=本设备 2 条;另一设备/跨家庭记录均不混入
    const page = await queryRecords(rig.app, await mgmtCookieOf(rig, world), world.deviceId, { ownerPassword: world.password });
    expect(page.status).toBe(200);
    const items = (page.body as Record<string, unknown>)['items'] as Record<string, unknown>[];
    expect(items.map((item) => item['id']).sort()).toEqual([ownSession.sessionId, ownFailureId].sort());
    expect(JSON.stringify(page.body)).not.toContain(secondSessionId);

    // 跨家庭目标设备 → 同形 404(乙家庭记录不可经查询获得)
    const cross = await queryRecords(rig.app, cookie, other.deviceId, { ownerPassword: world.password });
    expect(cross.status).toBe(404);
    const randomTarget = await queryRecords(rig.app, cookie, randomUUID(), { ownerPassword: world.password });
    expect(randomTarget.status).toBe(404);
    expectSameProblemShape(cross, randomTarget);
  });
});
