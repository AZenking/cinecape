import 'reflect-metadata';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { Response } from 'supertest';
import { afterEach, describe, expect, it } from 'vitest';
import { SESSION_COOKIE } from '@hmp/shared';
import { Database } from '../../src/database/database';
import { hashToken } from '../../src/modules/auth/token.service';
import { isPlaybackStableErrorCode } from '../../src/modules/playback/playback.types';
import {
  cleanupRigs,
  expectProblemContentType,
  request,
  startFreshApp,
  type TestRig,
} from '../helpers';
import {
  seedPlaybackSession,
  seedPlaybackWorld,
  type PlaybackSessionFixture,
  type PlaybackWorld,
} from '../fixtures/playback';

/**
 * 播放流媒体 HTTP 契约(T015,spec 004)—— 先于 T020/T021/T022/T031 的 TDD 失败测试。
 *
 * 权威依据:
 * - docs/specs/004-playback-resolver/contracts/api.md「媒体端点」:
 *   GET/HEAD /playback/stream/{sessionId}/{generation}/{assetId}?ticket=... 仅接受资产ID,
 *   不接受 URL 或路径参数;授权顺序 SessionGuard → ticket hash/TTL → 绑定
 *   session/device/profile → 最新策略与源事实 → generation/asset 归属;ticket 不能用于
 *   其他 session/generation;asset 枚举不存在统一 404。HLS MIME
 *   application/vnd.apple.mpegurl、key application/octet-stream、字幕 text/vtt 且只含文字;
 *   NAS direct 支持 GET/HEAD/单 Range(200/206、Accept-Ranges、Content-Length/Content-Range
 *   一致;越界 416;多个 Range 400;HEAD 与 GET 同鉴权,HEAD 不发送字节);源故障未发
 *   headers 时 problem,已发字节则关闭流且不能在字节流内注入 JSON,session 失败码可被
 *   轮询;所有响应 Cache-Control: no-store、Referrer-Policy: no-referrer;
 * - research.md R3(redirect 不返回给浏览器;Range 只允许单区间,206/416 标准语义);
 * - docs/specs/004-playback-resolver/tasks.md T015。
 *
 * RED 约定:流控制器与 HLS 代理服务尚不存在(T020/T021/T022/T031 未实现),
 * 当前全部媒体/renew 请求返回 404,本文件所有状态/码断言失败即为 T015 的 RED 证据。
 *
 * 夹具约定(不改 fixtures/helpers,spec 内自建数据行):
 * - NAS 直读世界:MEDIA_ROOTS 注入临时根(rootKey 复用夹具的 playback-fixture-nas),
 *   落一个真实 .mp4(65536 字节确定性模式),并按 refresh-publish 的权威形态把
 *   playback_source.location 改写为 `${rootKey}/${relativePath}`(mime_type 置空 →
 *   断言 MIME 按容器派生 video/mp4);
 * - HLS 世界:本地 http 上游(listen 127.0.0.1 随机端口)+ LAN_ALLOWED_TARGETS=127.0.0.1,
 *   追加 requires_proxy=1 的 playback_source 行,delivery='hls_proxy';
 * - 会话时刻用当前时钟(夹具固定时刻 2026-10-23 相对现实已过期,票据会立刻 TTL 失效);
 *   有效票 = 夹具票(默认 TTL),过期票 = UPDATE expires_at 到过去;
 * - 媒体资产 URL 的唯一合法来源是 renew 返回的 playbackUrl(R2:首次 ready 后经 renew
 *   取票),鉴权/形态类用例用夹具票直接构造入口 URL。
 */

/* ------------------------------------------------------------------ */
/* 夹具:确定性媒体内容与本地 http 上游                                  */
/* ------------------------------------------------------------------ */

/** 65536 字节确定性内容(byte i = i & 0xff),供整读/Range 字节级断言。 */
function movieContent(size = 65536): Buffer {
  const bytes = Buffer.alloc(size);
  for (let index = 0; index < size; index += 1) {
    bytes[index] = index & 0xff;
  }
  return bytes;
}

interface UpstreamServer {
  readonly port: number;
  close(): Promise<void>;
}

async function startUpstream(
  handler: (req: http.IncomingMessage, res: http.ServerResponse) => void,
): Promise<UpstreamServer> {
  const server = http.createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  return {
    port: typeof address === 'object' && address !== null ? address.port : 0,
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    },
  };
}

/** supertest 二进制响应解析(直读字节/Range/分片断言用);Response 为 superagent 流类型(非 http.IncomingMessage)。 */
function binaryParser(res: Response, callback: (error: Error | null, body?: Buffer) => void): void {
  const data: Buffer[] = [];
  res.on('data', (chunk) => data.push(chunk as Buffer));
  res.on('error', (error) => callback(error instanceof Error ? error : new Error('stream error')));
  res.on('end', () => callback(null, Buffer.concat(data)));
}

/** 临时 NAS 根目录登记(afterEach 统一清理)。 */
const tempDirs: string[] = [];

/** 本地 http 上游登记(afterEach 统一关闭,避免监听句柄跨用例泄漏)。 */
const upstreamServers: { close(): Promise<void> }[] = [];

function freshNow(): string {
  return new Date().toISOString();
}

/* ------------------------------------------------------------------ */
/* 夹具:spec 内数据行操作(不改 fixtures 文件)                         */
/* ------------------------------------------------------------------ */

const NAS_ROOT_KEY = 'playback-fixture-nas';
const MOVIE_REL_PATH = 'media/fixture-movie-1080p.mp4';

/** 改写 playback_source 的 location/mime_type(权威 location 形态 = rootKey/相对路径)。 */
function setSourceLocation(playbackSourceId: string, location: string, mimeType: string | null): void {
  Database.db.prepare('UPDATE playback_source SET location = ?, mime_type = ? WHERE id = ?').run(
    location,
    mimeType,
    playbackSourceId,
  );
}

/**
 * 建一条独立「源→条目→媒体→播放资源」链(与 refresh-publish 落库同构)。
 * playback_source 有 UNIQUE(household_id, source_entry_id) —— 每个上游目标必须
 * 挂各自的 source_entry,不能在夹具世界已有条目下追加第二行播放资源。
 */
function insertSourceChain(
  world: PlaybackWorld,
  options: {
    kind: 'nas' | 'iptv';
    location: string;
    protocol: 'file' | 'hls';
    identityKind: 'path' | 'url';
    mimeType: string | null;
    requiresProxy: 0 | 1;
    rootKey?: string;
  },
): { readonly playbackSourceId: string; readonly mediaId: string } {
  const now = freshNow();
  const sourceId = randomUUID();
  const entryId = randomUUID();
  const mediaId = randomUUID();
  const playbackSourceId = randomUUID();
  const db = Database.db;
  db.prepare(
    `INSERT INTO media_source
       (id, household_id, kind, name, remote_url, root_key, relative_directory, enabled, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`,
  ).run(
    sourceId,
    world.householdId,
    options.kind,
    `T015 流测试源 ${options.location}`,
    options.kind === 'iptv' ? options.location : null,
    options.rootKey ?? null,
    options.kind === 'nas' ? '' : null,
    now,
    now,
  );
  db.prepare(
    `INSERT INTO media_item
       (id, household_id, type, title, content_level, version, created_at, updated_at)
     VALUES (?, ?, 'channel', 'T015 流测试媒体', 0, 1, ?, ?)`,
  ).run(mediaId, world.householdId, now, now);
  db.prepare(
    `INSERT INTO source_entry
       (id, household_id, source_id, identity_kind, identity_digest, media_id, present, first_seen_at, last_seen_at)
     VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?)`,
  ).run(entryId, world.householdId, sourceId, options.identityKind, hashToken(options.location), mediaId, now, now);
  db.prepare(
    `INSERT INTO playback_source
       (id, household_id, source_id, source_entry_id, media_item_id, protocol, location,
        mime_type, priority, requires_proxy, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 80, ?, ?, ?)`,
  ).run(
    playbackSourceId,
    world.householdId,
    sourceId,
    entryId,
    mediaId,
    options.protocol,
    options.location,
    options.mimeType,
    options.requiresProxy,
    now,
    now,
  );
  return { playbackSourceId, mediaId };
}

/** 注入过期票:issued_at/expires_at 一并回拨到过去(约束 expires_at > issued_at)。 */
function setTicketExpiry(ticketId: string, issuedAt: string, expiresAt: string): void {
  Database.db.prepare('UPDATE playback_ticket SET issued_at = ?, expires_at = ? WHERE id = ?').run(
    issuedAt,
    expiresAt,
    ticketId,
  );
}

/* ------------------------------------------------------------------ */
/* 夹具:世界构造                                                       */
/* ------------------------------------------------------------------ */

interface DirectWorldHandle {
  readonly rig: TestRig;
  readonly world: PlaybackWorld;
  /** hmp_session=<token> Cookie 对 */
  readonly cookie: string;
  readonly session: PlaybackSessionFixture;
  readonly movieBytes: Buffer;
}

/** NAS direct 世界:临时 MEDIA_ROOTS + 真实 mp4 + playing/direct 会话(默认带有效票)。 */
async function setupDirectWorld(): Promise<DirectWorldHandle> {
  const nasRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'hmp-stream-nas-'));
  tempDirs.push(nasRoot);
  const movieBytes = movieContent();
  fs.mkdirSync(path.join(nasRoot, 'media'), { recursive: true });
  fs.writeFileSync(path.join(nasRoot, MOVIE_REL_PATH), movieBytes);

  const rig = await startFreshApp({ prefix: 'hmp-stream-', env: { MEDIA_ROOTS: `${NAS_ROOT_KEY}=${nasRoot}` } });
  const world = await seedPlaybackWorld(rig, { nasEnabled: true });
  setSourceLocation(world.nas.playbackSourceId, `${NAS_ROOT_KEY}/${MOVIE_REL_PATH}`, null);
  const session = seedPlaybackSession(world, {
    state: 'playing',
    delivery: 'direct',
    playbackSourceId: world.nas.playbackSourceId,
    at: freshNow(),
    ticket: {},
  });
  return { rig, world, cookie: `${SESSION_COOKIE}=${world.sessionToken}`, session, movieBytes };
}

interface HlsWorldHandle {
  readonly rig: TestRig;
  readonly world: PlaybackWorld;
  readonly cookie: string;
  readonly upstream: UpstreamServer;
  readonly crawl: { readonly session: PlaybackSessionFixture; readonly renewed: RenewedAsset };
  readonly broken: { readonly session: PlaybackSessionFixture; readonly renewed: RenewedAsset };
  readonly error: { readonly session: PlaybackSessionFixture; readonly renewed: RenewedAsset };
}

/** HLS 世界:本地 http 上游 + 三个 hls_proxy 会话(爬取/断流/上游 5xx)。 */
async function setupHlsWorld(
  handler: (req: http.IncomingMessage, res: http.ServerResponse) => void,
): Promise<HlsWorldHandle> {
  const upstream = await startUpstream(handler);
  upstreamServers.push(upstream);
  const rig = await startFreshApp({ prefix: 'hmp-stream-', env: { LAN_ALLOWED_TARGETS: '127.0.0.1' } });
  const world = await seedPlaybackWorld(rig);
  const origin = `http://127.0.0.1:${upstream.port}`;
  const mime = 'application/vnd.apple.mpegurl';
  const build = async (upstreamPath: string): Promise<{ session: PlaybackSessionFixture; renewed: RenewedAsset }> => {
    const location = `${origin}${upstreamPath}`;
    const source = insertSourceChain(world, {
      kind: 'iptv',
      location,
      protocol: 'hls',
      identityKind: 'url',
      mimeType: mime,
      requiresProxy: 1,
    });
    const session = seedPlaybackSession(world, {
      state: 'playing',
      delivery: 'hls_proxy',
      playbackSourceId: source.playbackSourceId,
      mediaId: source.mediaId,
      at: freshNow(),
    });
    return { session, renewed: await renewForPlaybackUrl(rig, `${SESSION_COOKIE}=${world.sessionToken}`, session) };
  };
  const crawl = await build('/live/master.m3u8');
  const broken = await build('/live/broken.m3u8');
  const error = await build('/live/error.m3u8');
  return { rig, world, cookie: `${SESSION_COOKIE}=${world.sessionToken}`, upstream, crawl, broken, error };
}

/* ------------------------------------------------------------------ */
/* 夹具:renew 换票与入口 URL 构造                                      */
/* ------------------------------------------------------------------ */

interface RenewedAsset {
  /** renew 返回的 playbackUrl(同源路径 + ticket query;supertest 直接可用) */
  readonly url: string;
  readonly ticket: string;
  readonly assetId: string;
  readonly generation: number;
}

/** renew 取票换 URL(R2/api.md:媒体资产 URL 的唯一合法来源);RED 时此处 404 断言失败。 */
async function renewForPlaybackUrl(
  rig: TestRig,
  cookie: string,
  session: PlaybackSessionFixture,
): Promise<RenewedAsset> {
  const res = await request(rig.app.getHttpServer())
    .post(`/api/playback/sessions/${session.sessionId}/renew`)
    .set('Cookie', cookie)
    .send({ expectedGeneration: session.generation });
  expect(res.status, 'renew 应返回 200 TicketReply(T018/T031 未实现时此处 RED)').toBe(200);
  const body = res.body as { playbackUrl?: unknown; generation?: unknown };
  expect(typeof body.playbackUrl, 'TicketReply 应含 playbackUrl').toBe('string');
  const parsed = new URL(body.playbackUrl as string, 'https://entry.invalid');
  expect(
    parsed.pathname,
    `playbackUrl 应为 /api/playback/stream/{sessionId}/{generation}/{assetId},收到:${parsed.pathname}`,
  ).toMatch(new RegExp(`^/api/playback/stream/${session.sessionId}/${session.generation}/[^/?#]+$`));
  const assetId = parsed.pathname.split('/').pop() ?? '';
  expect(assetId, 'assetId 必须是不透明资产 ID(不得是 URL/路径形态)').toMatch(/^[A-Za-z0-9._~-]+$/);
  expect(decodeURIComponent(assetId)).not.toMatch(/[:/]/);
  const ticket = parsed.searchParams.get('ticket');
  expect(ticket, 'playbackUrl 必须携带 ticket query').toBeTruthy();
  return {
    url: `${parsed.pathname}${parsed.search}`,
    ticket: ticket ?? '',
    assetId,
    generation: typeof body.generation === 'number' ? body.generation : session.generation,
  };
}

/** 直接构造流入口 URL(鉴权/形态类用例);rawAssetSegment 传字面编码段,assetId 传原文。 */
function streamUrl(
  session: PlaybackSessionFixture,
  ticket: string | null,
  options: { assetId?: string; rawAssetSegment?: string } = {},
): string {
  const segment = options.rawAssetSegment ?? encodeURIComponent(options.assetId ?? 'unspecified-asset');
  const query = ticket === null ? '' : `?ticket=${encodeURIComponent(ticket)}`;
  return `/api/playback/stream/${session.sessionId}/${session.generation}/${segment}${query}`;
}

/** 从重写清单文本中抽取全部同源资产 URL(绝对路径形态,含 ticket query)。 */
function extractAssetUrls(manifestText: string): string[] {
  return [...manifestText.matchAll(/\/api\/playback\/stream\/[^\s"'<>]+/g)].map((match) => match[0] ?? '');
}

/** 安全媒体 401 断言:状态 + problem+json + 稳定码。 */
function expectUnauthorized(res: { status: number; headers: Record<string, unknown>; body: { code?: unknown } }, code: string): void {
  expect(res.status).toBe(401);
  expectProblemContentType(res);
  expect(res.body.code).toBe(code);
  expect(res.headers['cache-control']).toBe('no-store');
}

afterEach(async () => {
  await cleanupRigs();
  while (upstreamServers.length > 0) {
    const upstream = upstreamServers.pop();
    if (upstream !== undefined) {
      await upstream.close();
    }
  }
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir !== undefined) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
});

describe('T015 入口形态:仅接受资产 ID,URL/路径参数形态同形 404 拒绝', () => {
  it('assetId 含路径穿越段(../ 编码形态)→ 404 MEDIA_NOT_FOUND(problem+json)', async () => {
    const { rig, world, session } = await setupDirectWorld();
    expect(session.ticket).not.toBeNull();
    const res = await request(rig.app.getHttpServer())
      .get(streamUrl(session, session.ticket?.token ?? null, { rawAssetSegment: '..%2F..%2Fsecret.m3u8' }))
      .set('Cookie', `${SESSION_COOKIE}=${world.sessionToken}`);
    expect(res.status).toBe(404);
    expectProblemContentType(res);
    expect(res.body.code).toBe('MEDIA_NOT_FOUND');
  });

  it('assetId 为绝对 URL 形态(编码 http://…)→ 404 MEDIA_NOT_FOUND 同形(不接受 URL 参数)', async () => {
    const { rig, world, session } = await setupDirectWorld();
    const res = await request(rig.app.getHttpServer())
      .get(streamUrl(session, session.ticket?.token ?? null, {
        rawAssetSegment: 'http%3A%2F%2Fevil.example%2Flist.m3u8',
      }))
      .set('Cookie', `${SESSION_COOKIE}=${world.sessionToken}`);
    expect(res.status).toBe(404);
    expectProblemContentType(res);
    expect(res.body.code).toBe('MEDIA_NOT_FOUND');
  });

  it('随机不存在 assetId 与上述两形态同状态同码(404 MEDIA_NOT_FOUND,不泄漏存在性)', async () => {
    const { rig, world, session } = await setupDirectWorld();
    for (const options of [
      { assetId: randomUUID() },
      { rawAssetSegment: '..%2F..%2Fsecret.m3u8' },
      { rawAssetSegment: 'http%3A%2F%2Fevil.example%2Flist.m3u8' },
    ]) {
      const res = await request(rig.app.getHttpServer())
        .get(streamUrl(session, session.ticket?.token ?? null, options))
        .set('Cookie', `${SESSION_COOKIE}=${world.sessionToken}`);
      expect(res.status, `形态 ${JSON.stringify(options)} 应同形 404`).toBe(404);
      expectProblemContentType(res);
      expect(res.body.code, 'asset 不存在/非法统一 MEDIA_NOT_FOUND').toBe('MEDIA_NOT_FOUND');
    }
  });
});

describe('T015 鉴权与票据校验顺序(SessionGuard → ticket → 绑定 → generation/asset)', () => {
  it('无设备会话(无 Cookie,即使携带票)→ 401 SESSION_INVALID', async () => {
    const { rig, session } = await setupDirectWorld();
    const res = await request(rig.app.getHttpServer()).get(streamUrl(session, session.ticket?.token ?? null));
    expectUnauthorized(res, 'SESSION_INVALID');
  });

  it('有会话无 ticket → 401 PLAYBACK_TICKET_INVALID', async () => {
    const { rig, world, session } = await setupDirectWorld();
    const res = await request(rig.app.getHttpServer())
      .get(streamUrl(session, null))
      .set('Cookie', `${SESSION_COOKIE}=${world.sessionToken}`);
    expectUnauthorized(res, 'PLAYBACK_TICKET_INVALID');
  });

  it('无效 ticket(随机串)→ 401 PLAYBACK_TICKET_INVALID', async () => {
    const { rig, world, session } = await setupDirectWorld();
    const res = await request(rig.app.getHttpServer())
      .get(streamUrl(session, 'totally-bogus-ticket-value'))
      .set('Cookie', `${SESSION_COOKIE}=${world.sessionToken}`);
    expectUnauthorized(res, 'PLAYBACK_TICKET_INVALID');
  });

  it('过期 ticket(expires_at 注入到过去)→ 401 PLAYBACK_TICKET_EXPIRED', async () => {
    const { rig, world, session } = await setupDirectWorld();
    expect(session.ticket).not.toBeNull();
    setTicketExpiry(session.ticket?.ticketId ?? '', '2020-01-01T00:00:00.000Z', '2020-01-01T00:01:00.000Z');
    const res = await request(rig.app.getHttpServer())
      .get(streamUrl(session, session.ticket?.token ?? null))
      .set('Cookie', `${SESSION_COOKIE}=${world.sessionToken}`);
    expectUnauthorized(res, 'PLAYBACK_TICKET_EXPIRED');
  });

  it('票跨 session 复用(sessionB 的票访问 sessionA 的入口)→ 401 PLAYBACK_TICKET_INVALID', async () => {
    const { rig, world, session: sessionA } = await setupDirectWorld();
    const sessionB = seedPlaybackSession(world, {
      state: 'playing',
      delivery: 'direct',
      playbackSourceId: world.nas.playbackSourceId,
      at: freshNow(),
      ticket: {},
    });
    expect(sessionB.ticket).not.toBeNull();
    const res = await request(rig.app.getHttpServer())
      .get(streamUrl(sessionA, sessionB.ticket?.token ?? null))
      .set('Cookie', `${SESSION_COOKIE}=${world.sessionToken}`);
    expectUnauthorized(res, 'PLAYBACK_TICKET_INVALID');
  });

  it('旧 generation 票(会话已换代而票停留在旧代)→ 401 PLAYBACK_TICKET_INVALID', async () => {
    const { rig, world } = await setupDirectWorld();
    const staleSession = seedPlaybackSession(world, {
      state: 'playing',
      delivery: 'direct',
      playbackSourceId: world.nas.playbackSourceId,
      generation: 2,
      version: 3,
      at: freshNow(),
      ticket: { generation: 1 },
    });
    const res = await request(rig.app.getHttpServer())
      .get(streamUrl(staleSession, staleSession.ticket?.token ?? null))
      .set('Cookie', `${SESSION_COOKIE}=${world.sessionToken}`);
    expectUnauthorized(res, 'PLAYBACK_TICKET_INVALID');
  });
});

describe('T015 NAS direct 直读交付(GET/HEAD/单 Range)', () => {
  it('GET 200:Content-Type 按容器 video/mp4、Accept-Ranges: bytes、Content-Length 正确、no-store/no-referrer、字节与源文件一致', async () => {
    const handle = await setupDirectWorld();
    const asset = await renewForPlaybackUrl(handle.rig, handle.cookie, handle.session);
    const res = await request(handle.rig.app.getHttpServer())
      .get(asset.url)
      .set('Cookie', handle.cookie)
      .buffer(true)
      .parse(binaryParser);
    expect(res.status).toBe(200);
    expect(String(res.headers['content-type'])).toContain('video/mp4');
    expect(res.headers['accept-ranges']).toBe('bytes');
    expect(res.headers['content-length']).toBe(String(handle.movieBytes.length));
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.headers['referrer-policy']).toBe('no-referrer');
    expect(res.body as Buffer).toEqual(handle.movieBytes);
  });

  it('单 Range 请求(bytes=100-199)→ 206 + Content-Range 一致 + Content-Length 100 + 字节正确', async () => {
    const handle = await setupDirectWorld();
    const asset = await renewForPlaybackUrl(handle.rig, handle.cookie, handle.session);
    const res = await request(handle.rig.app.getHttpServer())
      .get(asset.url)
      .set('Cookie', handle.cookie)
      .set('Range', 'bytes=100-199')
      .buffer(true)
      .parse(binaryParser);
    expect(res.status).toBe(206);
    expect(res.headers['accept-ranges']).toBe('bytes');
    expect(res.headers['content-range']).toBe(`bytes 100-199/${handle.movieBytes.length}`);
    expect(res.headers['content-length']).toBe('100');
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.body as Buffer).toEqual(handle.movieBytes.subarray(100, 200));
  });

  it('Range 越界(start ≥ size)→ 416(problem+json 语义的稳定拒绝)', async () => {
    const handle = await setupDirectWorld();
    const asset = await renewForPlaybackUrl(handle.rig, handle.cookie, handle.session);
    const res = await request(handle.rig.app.getHttpServer())
      .get(asset.url)
      .set('Cookie', handle.cookie)
      .set('Range', `bytes=${handle.movieBytes.length + 500}-`)
      .buffer(true)
      .parse(binaryParser);
    expect(res.status).toBe(416);
    expectProblemContentType(res);
  });

  it('多 Range(bytes=0-1,5-9)→ 400(R3:只允许单区间)', async () => {
    const handle = await setupDirectWorld();
    const asset = await renewForPlaybackUrl(handle.rig, handle.cookie, handle.session);
    const res = await request(handle.rig.app.getHttpServer())
      .get(asset.url)
      .set('Cookie', handle.cookie)
      .set('Range', 'bytes=0-1,5-9')
      .buffer(true)
      .parse(binaryParser);
    expect(res.status).toBe(400);
    expectProblemContentType(res);
  });

  it('HEAD 与 GET 同鉴权:HEAD 200、头与 GET 一致(Accept-Ranges/Content-Length)、不发送响应体', async () => {
    const handle = await setupDirectWorld();
    const asset = await renewForPlaybackUrl(handle.rig, handle.cookie, handle.session);
    const res = await request(handle.rig.app.getHttpServer()).head(asset.url).set('Cookie', handle.cookie);
    expect(res.status).toBe(200);
    expect(String(res.headers['content-type'])).toContain('video/mp4');
    expect(res.headers['accept-ranges']).toBe('bytes');
    expect(res.headers['content-length']).toBe(String(handle.movieBytes.length));
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.text === undefined || res.text === '').toBe(true);
  });

  it('未授权时 HEAD 与 GET 均 401(无设备会话)', async () => {
    const handle = await setupDirectWorld();
    const asset = await renewForPlaybackUrl(handle.rig, handle.cookie, handle.session);
    const get = await request(handle.rig.app.getHttpServer()).get(asset.url);
    expectUnauthorized(get, 'SESSION_INVALID');
    const head = await request(handle.rig.app.getHttpServer()).head(asset.url);
    // HEAD 响应体被 HTTP 栈双侧抑制(RFC 7231;Node 服务器 _hasBody=false、客户端 llhttp 拒解析),
    // body.code 物理不可达 → 对 HEAD 仅断言状态行与头(问题类型经 Content-Type 头表达),body 断言由上一行 GET 覆盖
    expect(head.status).toBe(401);
    expectProblemContentType(head);
    expect(head.headers['cache-control']).toBe('no-store');
  });

  it('源文件缺失(未发响应头)→ problem+json 稳定错误,响应体不含源路径细节', async () => {
    const handle = await setupDirectWorld();
    const missingSource = insertSourceChain(handle.world, {
      kind: 'nas',
      location: `${NAS_ROOT_KEY}/media/missing-movie.mp4`,
      protocol: 'file',
      identityKind: 'path',
      mimeType: null,
      requiresProxy: 0,
      rootKey: NAS_ROOT_KEY,
    });
    const session = seedPlaybackSession(handle.world, {
      state: 'playing',
      delivery: 'direct',
      playbackSourceId: missingSource.playbackSourceId,
      mediaId: missingSource.mediaId,
      at: freshNow(),
    });
    const asset = await renewForPlaybackUrl(handle.rig, handle.cookie, session);
    const res = await request(handle.rig.app.getHttpServer()).get(asset.url).set('Cookie', handle.cookie);
    expect(res.status).toBeGreaterThanOrEqual(400);
    expectProblemContentType(res);
    expect(typeof res.body.code).toBe('string');
    expect(isPlaybackStableErrorCode(String(res.body.code))).toBe(true);
    expect(JSON.stringify(res.body)).not.toContain('missing-movie');
    expect(JSON.stringify(res.body)).not.toContain(NAS_ROOT_KEY);
  });
});

describe('T015 HLS 代理交付(本地 http 上游:清单重写/MIME/源故障注入)', () => {
  /** 上游内容:master(变体+字幕组)/hi 媒体清单(MAP+KEY+分段)/字幕清单/VTT/分片与初始化字节。 */
  const SEGMENT_BYTES = Buffer.alloc(2048, 0x42);
  const INIT_BYTES = Buffer.alloc(720, 0x21);
  const KEY_BYTES = Buffer.from('0123456789abcdef', 'utf8');
  const VTT_TEXT = 'WEBVTT\n\n00:00:00.000 --> 00:00:06.000\nHello 字幕文本 plain words\n';
  const MASTER_TEXT = [
    '#EXTM3U',
    '#EXT-X-VERSION:6',
    '#EXT-X-MEDIA:TYPE=SUBTITLES,GROUP-ID="sub",NAME="English",DEFAULT=YES,LANGUAGE="en",URI="subs/playlist.m3u8"',
    '#EXT-X-STREAM-INF:BANDWIDTH=800000,RESOLUTION=640x360,SUBTITLES="sub"',
    'hi.m3u8',
    '',
  ].join('\n');
  const HI_TEXT = [
    '#EXTM3U',
    '#EXT-X-VERSION:6',
    '#EXT-X-TARGETDURATION:4',
    '#EXT-X-MAP:URI="init.mp4"',
    '#EXT-X-KEY:METHOD=AES-128,URI="key.bin",IV=0x9c7db8778570d05c3177c349fd9236aa',
    '#EXTINF:4.0,',
    'seg-0.ts',
    '#EXTINF:4.0,',
    'seg-1.ts',
    '',
  ].join('\n');
  const SUBS_TEXT = ['#EXTM3U', '#EXT-X-TARGETDURATION:6', '#EXTINF:6.0,', '000.vtt', ''].join('\n');

  function hlsHandler(req: http.IncomingMessage, res: http.ServerResponse): void {
    const url = req.url ?? '';
    const text = (body: string, contentType: string): void => {
      res.writeHead(200, { 'content-type': contentType, 'content-length': String(Buffer.byteLength(body)), connection: 'close' });
      res.end(body);
    };
    if (url === '/live/master.m3u8') return text(MASTER_TEXT, 'application/vnd.apple.mpegurl');
    if (url === '/live/hi.m3u8') return text(HI_TEXT, 'application/vnd.apple.mpegurl');
    if (url === '/live/subs/playlist.m3u8') return text(SUBS_TEXT, 'application/vnd.apple.mpegurl');
    if (url === '/live/subs/000.vtt') return text(VTT_TEXT, 'text/vtt');
    if (url === '/live/init.mp4') {
      res.writeHead(200, { 'content-type': 'video/mp4', 'content-length': String(INIT_BYTES.length), connection: 'close' });
      res.end(INIT_BYTES);
      return;
    }
    if (url === '/live/key.bin') {
      res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': String(KEY_BYTES.length), connection: 'close' });
      res.end(KEY_BYTES);
      return;
    }
    if (url === '/live/seg-0.ts' || url === '/live/seg-1.ts') {
      res.writeHead(200, { 'content-type': 'video/mp2t', 'content-length': String(SEGMENT_BYTES.length), connection: 'close' });
      res.end(SEGMENT_BYTES);
      return;
    }
    res.writeHead(404, { connection: 'close' });
    res.end('not found');
  }

  it('入口清单 GET 200:application/vnd.apple.mpegurl + no-store/no-referrer;重写输出不含上游主机/协议(禁透传原始清单)', async () => {
    const handle = await setupHlsWorld(hlsHandler);
    const res = await request(handle.rig.app.getHttpServer())
      .get(handle.crawl.renewed.url)
      .set('Cookie', handle.cookie);
    expect(res.status).toBe(200);
    expect(String(res.headers['content-type'])).toContain('application/vnd.apple.mpegurl');
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.headers['referrer-policy']).toBe('no-referrer');
    const body = res.text ?? '';
    expect(body).toContain('#EXTM3U');
    expect(body).toContain('BANDWIDTH=800000');
    expect(body).not.toContain('127.0.0.1');
    expect(body).not.toContain('://');
    expect(body).not.toContain('/live/');
    // 每个重写 URI 都是同源入口路径且携带 ticket
    const urls = extractAssetUrls(body);
    expect(urls.length).toBe(2);
    for (const url of urls) {
      expect(url.startsWith(`/api/playback/stream/${handle.crawl.session.sessionId}/`)).toBe(true);
      expect(url).toContain('ticket=');
    }
  });

  it('清单子资源可取且 MIME 正确:分片字节一致、key application/octet-stream(16 字节)、初始化片字节一致', async () => {
    const handle = await setupHlsWorld(hlsHandler);
    const entry = await request(handle.rig.app.getHttpServer())
      .get(handle.crawl.renewed.url)
      .set('Cookie', handle.cookie);
    expect(entry.status).toBe(200);
    const variantUrls = extractAssetUrls(entry.text ?? '');
    expect(variantUrls.length).toBe(2);

    let mediaUrls: string[] = [];
    for (const url of variantUrls) {
      const res = await request(handle.rig.app.getHttpServer()).get(url).set('Cookie', handle.cookie);
      expect(res.status).toBe(200);
      if ((res.text ?? '').includes('#EXT-X-MAP')) {
        // 变体媒体清单(MAP/KEY/分片)
        mediaUrls = extractAssetUrls(res.text ?? '');
      } else {
        // 字幕子清单:继续下钻到 VTT 在独立用例覆盖,这里仅断言可达
        expect((res.text ?? '').includes('#EXT-X-TARGETDURATION')).toBe(true);
      }
    }
    expect(mediaUrls.length).toBe(4);

    const fetched: { contentType: string; body: Buffer }[] = [];
    for (const url of mediaUrls) {
      const res = await request(handle.rig.app.getHttpServer())
        .get(url)
        .set('Cookie', handle.cookie)
        .buffer(true)
        .parse(binaryParser);
      expect(res.status, `子资源应可取:${url}`).toBe(200);
      fetched.push({ contentType: String(res.headers['content-type']), body: res.body as Buffer });
    }
    const key = fetched.find((item) => item.body.length === KEY_BYTES.length);
    expect(key, '应有 16 字节 key 资产').toBeDefined();
    expect(key?.contentType).toContain('application/octet-stream');
    expect(key?.body).toEqual(KEY_BYTES);
    expect(fetched.some((item) => item.body.equals(SEGMENT_BYTES))).toBe(true);
    expect(fetched.some((item) => item.body.equals(INIT_BYTES))).toBe(true);
  });

  it('字幕资产:Content-Type text/vtt、内容仅文字(WEBVTT 开头,无 <script> 执行面)', async () => {
    const handle = await setupHlsWorld(hlsHandler);
    const entry = await request(handle.rig.app.getHttpServer())
      .get(handle.crawl.renewed.url)
      .set('Cookie', handle.cookie);
    expect(entry.status).toBe(200);
    const subsUrl = extractAssetUrls(entry.text ?? '')[0];
    expect(subsUrl).toBeTruthy();
    const subs = await request(handle.rig.app.getHttpServer()).get(subsUrl ?? '').set('Cookie', handle.cookie);
    expect(subs.status).toBe(200);
    const vttUrl = extractAssetUrls(subs.text ?? '')[0];
    expect(vttUrl, '字幕子清单应含 VTT 资产').toBeTruthy();
    const vtt = await request(handle.rig.app.getHttpServer()).get(vttUrl ?? '').set('Cookie', handle.cookie);
    expect(vtt.status).toBe(200);
    expect(String(vtt.headers['content-type'])).toContain('text/vtt');
    expect((vtt.text ?? '').startsWith('WEBVTT')).toBe(true);
    expect((vtt.text ?? '').toLowerCase()).not.toContain('<script');
  });

  it('上游 5xx(未发送响应字节)→ problem+json 稳定错误,响应体不含上游地址/路径', async () => {
    const handle = await setupHlsWorld((req, res) => {
      if (req.url === '/live/error.m3u8') {
        res.writeHead(500, { 'content-type': 'text/plain', connection: 'close' });
        res.end('upstream exploded at /live/error.m3u8');
        return;
      }
      res.writeHead(404, { connection: 'close' });
      res.end();
    });
    const res = await request(handle.rig.app.getHttpServer())
      .get(handle.error.renewed.url)
      .set('Cookie', handle.cookie);
    expect(res.status).toBeGreaterThanOrEqual(400);
    expectProblemContentType(res);
    expect(typeof res.body.code).toBe('string');
    expect(isPlaybackStableErrorCode(String(res.body.code))).toBe(true);
    const serialized = JSON.stringify(res.body);
    expect(serialized).not.toContain('127.0.0.1');
    expect(serialized).not.toContain('/live/error.m3u8');
    expect(serialized).not.toContain('upstream exploded');
  });

  it('上游中途断流(已发字节)→ 连接关闭、字节流无 JSON 注入(无 { 字节)、session failure_code 落库可轮询', async () => {
    const handle = await setupHlsWorld((req, res) => {
      if (req.url === '/live/broken.m3u8') {
        const body = '#EXTM3U\n#EXT-X-TARGETDURATION:4\n#EXTINF:4.0,\nbroken-seg.ts\n';
        res.writeHead(200, { 'content-type': 'application/vnd.apple.mpegurl', connection: 'close' });
        res.end(body);
        return;
      }
      if (req.url === '/live/broken-seg.ts') {
        res.writeHead(200, { 'content-type': 'video/mp2t', 'content-length': '2048', connection: 'close' });
        res.write(Buffer.alloc(1024, 0x41));
        // 已发部分字节后粗暴断开(模拟源故障)
        setImmediate(() => res.destroy());
        return;
      }
      res.writeHead(404, { connection: 'close' });
      res.end();
    });
    const entry = await request(handle.rig.app.getHttpServer())
      .get(handle.broken.renewed.url)
      .set('Cookie', handle.cookie);
    expect(entry.status).toBe(200);
    const segmentUrl = extractAssetUrls(entry.text ?? '')[0];
    expect(segmentUrl).toBeTruthy();

    // 原始 socket 读流:响应头已发(200),随后连接被关闭
    const server = handle.rig.app.getHttpServer();
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    const port = typeof address === 'object' && address !== null ? address.port : 0;
    const streamed = await new Promise<{ status: number; body: Buffer; aborted: boolean }>((resolve, reject) => {
      const req = http.request(
        { host: '127.0.0.1', port, path: segmentUrl ?? '/', method: 'GET', headers: { cookie: handle.cookie } },
        (res) => {
          const chunks: Buffer[] = [];
          res.on('data', (chunk) => chunks.push(chunk as Buffer));
          const finish = (aborted: boolean): void =>
            resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks), aborted });
          res.on('end', () => finish(false));
          res.on('aborted', () => finish(true));
        },
      );
      req.on('error', reject);
      req.end();
    });
    expect(streamed.status).toBe(200);
    expect(streamed.body.length, '应已发出部分字节').toBeGreaterThan(0);
    // 字节流中没有任何 JSON 注入(分片内容为 0x41,不应出现 '{' = 0x7b)
    expect(streamed.body.includes(0x7b)).toBe(false);
    expect(streamed.body.toString('utf8')).not.toContain('"type"');

    // session failure_code 落库,可经 GET 会话轮询到稳定码
    let failureCode: string | null = null;
    for (let attempt = 0; attempt < 40 && failureCode === null; attempt += 1) {
      const res = await request(handle.rig.app.getHttpServer())
        .get(`/api/playback/sessions/${handle.broken.session.sessionId}`)
        .set('Cookie', handle.cookie);
      if (res.status === 200 && typeof res.body?.failureCode === 'string') {
        failureCode = res.body.failureCode;
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    expect(failureCode, '会话应记录稳定失败码').not.toBeNull();
    expect(isPlaybackStableErrorCode(failureCode ?? '')).toBe(true);
  });
});
