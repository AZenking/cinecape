import http from 'node:http';
import type { Readable } from 'node:stream';
import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { loadEnv, type LanTarget } from '@platform/config/env.schema';
import {
  PLAYBACK_BUDGETS,
  createPlaybackBudgets,
  type PlaybackBudgets,
} from '@platform/config/playback-budgets';
import type { PlaybackErrorCode } from '../../../src/contexts/playback/domain/playback.types';
import { HlsProxyService, validateUpstreamHop } from '../../../src/contexts/playback/infrastructure/hls-proxy.service';
import { PlaybackAssetsService } from '../../../src/contexts/playback/application/playback-assets.service';

/**
 * HLS 代理与清单重写单测(T015,spec 004)—— 先于 T020/T021/T022/T031 的 TDD 失败测试。
 *
 * 权威依据:
 * - docs/specs/004-playback-resolver/contracts/api.md「媒体端点」「时间轴及请求预算」
 *   (入口仅资产ID;HLS MIME application/vnd.apple.mpegurl;重写后只指向本入口,原清单禁止
 *   原样返回;拒绝 DRM 及未知 URI 标签;重定向不返回给浏览器;HLS 上游不得收到应用
 *   Cookie/Bearer,禁止透传其 Set-Cookie/Location);
 * - docs/specs/004-playback-resolver/research.md R3 全文(安全 HLS 和 NAS 输入):
 *   每次 DNS/redirect 验证精确 LAN 许可;嵌套<=4、单清单<=2MiB、每清单 URI<=10000、
 *   redirect<=3、连接/首字节<=15 秒、空闲 15 秒中止、分片单响应<=64MiB、key<=16 字节;
 *   拒绝 DRM/SAMPLE-AES、未知 URI 扩展、循环、data/file 等协议,不透传原文;
 * - docs/specs/004-playback-resolver/tasks.md T015;
 * - 预算数值唯一权威:apps/server/src/config/playback-budgets.ts 的 hlsUpstream 组(T010,
 *   已由 test/unit/playback/config.spec.ts 锁定),本文件只做「配置消费」断言。
 *
 * RED 约定(与 fixtures-playback.spec.ts 同款):hls-proxy.service.ts(T021)与
 * playback-assets.service.ts(T022)尚不存在,本文件 import 失败整文件加载失败,
 * 即为 T015 的 RED 证据;模块落地后本文件成为其行为规约。
 *
 * 期望导出面(T021/T022 实现契约提案,实现时不得收窄语义):
 * - hls-proxy.service.ts:
 *   · class HlsProxyService { constructor(deps: { budgets: PlaybackBudgets });
 *       readPlaylist(url, { allowedTargets }): Promise<
 *         | { ok: true; finalUrl: string; text: string; contentType: string | null }
 *         | { ok: false; code: PlaybackErrorCode; reason: string }>;
 *       readAsset(url, { allowedTargets, kind: 'segment' | 'key' | 'subtitle' }): Promise<
 *         | { ok: true; stream: Readable; contentType: string | null }
 *         | { ok: false; code: PlaybackErrorCode; reason: string }>; }
 *   · validateUpstreamHop(url, { allowedTargets?, resolveDns? }): Promise<
 *       { ok: true } | { ok: false; reason: string }> —— 单跳校验纯函数,
 *       redirect 每跳都必须重新调用;无 resolveDns 时按 URL 字面校验,提供时必须
 *       以解析结果(IP 列表)逐个验证(每次 DNS 验证,R3)。
 * - playback-assets.service.ts:
 *   · class PlaybackAssetsService { constructor(deps: { budgets: PlaybackBudgets });
 *       rewritePlaylist(input): Promise<RewriteResult> } —— 纯文本解析/重写/登记,
 *       不做任何网络请求(上游读取属 HlsProxyService)。
 *
 * 稳定失败码映射提案:清单形态类失败(畸形/DRM/未知 scheme/循环/嵌套/URI 超限/
 * 超预算大小)→ PLAYBACK_FORMAT_UNSUPPORTED;上游读取类失败(目标未许可/redirect
 * 超限/超时/尺寸超限)→ PLAYBACK_RESOURCE_UNAVAILABLE。
 */

/* ------------------------------------------------------------------ */
/* 夹具:本地 http 上游(127.0.0.1 随机端口,spec 文件内自建)             */
/* ------------------------------------------------------------------ */

/** 本地 http 上游句柄:记录每次请求的 URL 与请求头(供凭证不转发断言)。 */
interface UpstreamServer {
  readonly origin: string;
  readonly port: number;
  readonly seenRequests: readonly { url: string; headers: Record<string, string | undefined> }[];
  close(): Promise<void>;
}

async function startUpstream(
  handler: (req: http.IncomingMessage, res: http.ServerResponse) => void,
): Promise<UpstreamServer> {
  const seenRequests: { url: string; headers: Record<string, string | undefined> }[] = [];
  const server = http.createServer((req, res) => {
    // req.headers 为 http.IncomingHttpHeaders（值可含 string[]），夹具记录面收窄为 string|undefined
    seenRequests.push({
      url: req.url ?? '',
      headers: Object.fromEntries(
        Object.entries(req.headers).map(([k, v]) => [k, Array.isArray(v) ? v.join(', ') : v]),
      ),
    });
    handler(req, res);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const port = typeof address === 'object' && address !== null ? address.port : 0;
  return {
    origin: `http://127.0.0.1:${port}`,
    port,
    seenRequests,
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    },
  };
}

/** 文本响应小助手:显式 Connection: close,避免 keep-alive 拖住 close()。 */
function respondText(res: http.ServerResponse, status: number, body: string, contentType = 'application/vnd.apple.mpegurl'): void {
  res.writeHead(status, { 'content-type': contentType, connection: 'close' });
  res.end(body);
}

/** 收满一个可读流(分片/key 字节断言用)。 */
async function readAll(stream: Readable): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks);
}

/* ------------------------------------------------------------------ */
/* 夹具:清单文本与重写结果断言工具                                     */
/* ------------------------------------------------------------------ */

const MIB = 1024 * 1024;

/** 精确 LAN 许可(仅本地夹具地址;与 LAN_ALLOWED_TARGETS='127.0.0.1' 同口径)。 */
const LOCAL_TARGET: LanTarget = { kind: 'host', host: '127.0.0.1' };
const LOCAL_TARGETS: readonly LanTarget[] = [LOCAL_TARGET];

const HOUSEHOLD_ID = randomUUID();
const SESSION_ID = randomUUID();
const GENERATION = 3;
const TICKET = 'opaque-ticket-abcdef123456';

/** 重写后的同源资产入口 URI(契约唯一合法形态;assetId/ticket 均为 opaque 词法)。 */
const ASSET_URI = '[A-Za-z0-9._~-]+';

function escapeRe(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** /playback/stream/{sessionId}/{generation}/{assetId}?ticket={ticket} 精确形态。 */
function entryUriRe(): RegExp {
  return new RegExp(`^/playback/stream/${escapeRe(SESSION_ID)}/${GENERATION}/${ASSET_URI}\\?ticket=${escapeRe(TICKET)}$`);
}

/** 抽取清单文本中全部 URI:非注释行 + 行内 URI="…" 属性。 */
function playlistUris(text: string): string[] {
  const uris: string[] = [];
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (trimmed === '') {
      continue;
    }
    if (trimmed.startsWith('#')) {
      for (const match of trimmed.matchAll(/URI="([^"]+)"/g)) {
        uris.push(match[1] ?? '');
      }
      continue;
    }
    uris.push(trimmed);
  }
  return uris;
}

/** 失败结果断言:ok=false 且稳定码符合映射提案,返回 reason 供进一步断言。 */
function expectRewriteFailed(
  result: Awaited<ReturnType<PlaybackAssetsService['rewritePlaylist']>>,
  code: PlaybackErrorCode,
): { readonly reason: string } {
  expect(result.ok).toBe(false);
  if (result.ok) {
    throw new Error('期望重写失败,实际成功');
  }
  expect(result.code, `失败码应为稳定码 ${code}`).toBe(code);
  expect(typeof result.reason).toBe('string');
  expect(result.reason.length).toBeGreaterThan(0);
  return { reason: result.reason };
}

/** 成功结果断言:展开 ok=true 分支并校验资产登记表基本完整性。 */
function expectRewriteOk(result: Awaited<ReturnType<PlaybackAssetsService['rewritePlaylist']>>): {
  readonly playlist: string;
  readonly assets: readonly { assetId: string; upstreamUrl: string; kind: string }[];
} {
  expect(result.ok).toBe(true);
  if (!result.ok) {
    throw new Error(`期望重写成功,实际失败:${result.code} ${result.reason}`);
  }
  const assetIds = new Set(result.value.assets.map((asset) => asset.assetId));
  expect(assetIds.size).toBe(result.value.assets.length);
  return result.value;
}

/** 共同断言:重写输出不含任何原始上游 URL/主机名/协议(禁透传原始清单)。 */
function expectNoUpstreamLeak(output: string, ...markers: string[]): void {
  expect(output).not.toContain('://');
  for (const marker of markers) {
    expect(output, `输出不得包含上游痕迹「${marker}」`).not.toContain(marker);
  }
}

function newAssetsService(budgets: PlaybackBudgets = PLAYBACK_BUDGETS): PlaybackAssetsService {
  return new PlaybackAssetsService({ budgets });
}

function newProxyService(budgets: PlaybackBudgets = PLAYBACK_BUDGETS): HlsProxyService {
  return new HlsProxyService({ budgets });
}

/** 覆盖部分 hlsUpstream 预算(其余保持权威数值;证明服务消费注入的预算对象)。 */
function withHlsBudgets(override: Partial<PlaybackBudgets['hlsUpstream']>): PlaybackBudgets {
  const base = createPlaybackBudgets(loadEnv({ NODE_ENV: 'test' }));
  return { ...base, hlsUpstream: { ...base.hlsUpstream, ...override } };
}

/* ------------------------------------------------------------------ */
/* 夹具:上游清单样本                                                   */
/* ------------------------------------------------------------------ */

const MASTER_UPSTREAM_URL = 'http://upstream-a.example/live/master.m3u8';

/** 多变体 + 音频/字幕 rendition 组(URI 覆盖相对/绝对路径/绝对 https 三种形态)。 */
const MASTER_PLAYLIST = [
  '#EXTM3U',
  '#EXT-X-VERSION:6',
  '#EXT-X-INDEPENDENT-SEGMENTS',
  '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="aud",NAME="English",DEFAULT=YES,LANGUAGE="en",URI="audio/en.m3u8"',
  '#EXT-X-MEDIA:TYPE=SUBTITLES,GROUP-ID="sub",NAME="English",DEFAULT=NO,LANGUAGE="en",URI="subs/en.m3u8"',
  '#EXT-X-STREAM-INF:BANDWIDTH=2000000,RESOLUTION=1280x720,CODECS="avc1.64001f,mp4a.40.2",AUDIO="aud",SUBTITLES="sub"',
  'hi/playlist.m3u8',
  '#EXT-X-STREAM-INF:BANDWIDTH=800000,RESOLUTION=640x360,CODECS="avc1.64001e,mp4a.40.2",AUDIO="aud",SUBTITLES="sub"',
  '/low/playlist.m3u8',
  '#EXT-X-STREAM-INF:BANDWIDTH=4500000,RESOLUTION=1920x1080,CODECS="avc1.640028,mp4a.40.2",AUDIO="aud",SUBTITLES="sub"',
  'https://cdn.upstream.example/hls/1080p/playlist.m3u8',
  '',
].join('\n');

/** 媒体清单:MAP(fMP4 初始化段)+ AES-128 key + byte-range + 四种 URI 形态。 */
const MEDIA_UPSTREAM_URL = 'http://upstream-a.example/live/hi/playlist.m3u8';
const MEDIA_PLAYLIST = [
  '#EXTM3U',
  '#EXT-X-VERSION:6',
  '#EXT-X-TARGETDURATION:4',
  '#EXT-X-MEDIA-SEQUENCE:0',
  '#EXT-X-MAP:URI="init.mp4",BYTERANGE="720@0"',
  '#EXT-X-KEY:METHOD=AES-128,URI="../../keys/key.bin",IV=0x9c7db8778570d05c3177c349fd9236aa',
  '#EXTINF:4.000,',
  'seg-0.ts?token=abc&t=1',
  '#EXTINF:4.000,',
  '#EXT-X-BYTERANGE:1000@2000',
  'byte-seg.ts',
  '#EXTINF:4.000,',
  '/hls/abs/seg-2.ts',
  '#EXTINF:4.000,',
  'https://cdn.upstream.example/hls/seg-3.ts',
  '',
].join('\n');

describe('T015 多变体清单解析与同源资产重写(playback-assets.rewritePlaylist)', () => {
  it('多变体 master:variant/音频 rendition/字幕 rendition 全部 URI 重写为同源入口,流属性保留,资产 ID 为映射而非透传', async () => {
    const result = await newAssetsService().rewritePlaylist({
      householdId: HOUSEHOLD_ID,
      sessionId: SESSION_ID,
      generation: GENERATION,
      upstreamUrl: MASTER_UPSTREAM_URL,
      text: MASTER_PLAYLIST,
      ticket: TICKET,
      depth: 0,
    });
    const { playlist, assets } = expectRewriteOk(result);

    // 每个 URI(含 EXT-X-MEDIA 行内 URI 属性)都重写为同源入口形态
    const uris = playlistUris(playlist);
    expect(uris.length).toBe(5);
    for (const uri of uris) {
      expect(uri, `重写后 URI 应为同源入口形态:${uri}`).toMatch(entryUriRe());
    }

    // 资产映射覆盖全部 5 个上游目标;assetId 是不透明映射值,绝不等于原 URL
    const byUrl = new Map(assets.map((asset) => [asset.upstreamUrl, asset]));
    expect(byUrl.size).toBe(5);
    expect(byUrl.get('http://upstream-a.example/live/hi/playlist.m3u8')?.kind).toBe('playlist');
    expect(byUrl.get('http://upstream-a.example/low/playlist.m3u8')?.kind).toBe('playlist');
    expect(byUrl.get('https://cdn.upstream.example/hls/1080p/playlist.m3u8')?.kind).toBe('playlist');
    expect(byUrl.get('http://upstream-a.example/live/audio/en.m3u8')?.kind).toBe('playlist');
    expect(byUrl.get('http://upstream-a.example/live/subs/en.m3u8')?.kind).toBe('playlist');
    for (const asset of assets) {
      expect(asset.assetId).not.toContain('/');
      expect(asset.assetId).not.toContain(':');
      expect(asset.assetId.toLowerCase()).not.toContain('upstream');
    }

    // 流选择语义不丢:STREAM-INF 属性(带宽/分辨率/编解码/组引用)原样保留
    expect(playlist).toContain('BANDWIDTH=2000000');
    expect(playlist).toContain('RESOLUTION=1280x720');
    expect(playlist).toContain('BANDWIDTH=4500000');
    expect(playlist).toContain('RESOLUTION=1920x1080');
    expect(playlist).toContain('CODECS="avc1.64001f,mp4a.40.2"');
    expect(playlist).toContain('AUDIO="aud"');
    expect(playlist).toContain('SUBTITLES="sub"');
    expect(playlist).toContain('#EXT-X-INDEPENDENT-SEGMENTS');
    expectNoUpstreamLeak(playlist, 'upstream-a.example', 'cdn.upstream.example', '/low/', '1080p');
  });

  it('媒体清单:EXT-X-MAP(含 BYTERANGE 属性)/EXT-X-KEY(AES-128 + IV)/EXT-X-BYTERANGE 语义全部保留且 URI 重写', async () => {
    const result = await newAssetsService().rewritePlaylist({
      householdId: HOUSEHOLD_ID,
      sessionId: SESSION_ID,
      generation: GENERATION,
      upstreamUrl: MEDIA_UPSTREAM_URL,
      text: MEDIA_PLAYLIST,
      ticket: TICKET,
      depth: 1,
    });
    const { playlist, assets } = expectRewriteOk(result);

    // 初始化段:URI 重写,BYTERANGE 属性原样保留(fMP4 头部区间语义不丢)
    expect(playlist).toMatch(/#EXT-X-MAP:URI="\/playback\/stream\/[^"]+",BYTERANGE="720@0"/);
    // AES-128 identity key:METHOD 与 IV 保留,仅 URI 重写
    expect(playlist).toMatch(
      /#EXT-X-KEY:METHOD=AES-128,URI="\/playback\/stream\/[^"]+",IV=0x9c7db8778570d05c3177c349fd9236aa/,
    );
    // byte-range 分片:区间标签与 EXTINF 原样保留在重写后的 URI 之前
    expect(playlist).toContain('#EXT-X-BYTERANGE:1000@2000');
    expect(playlist).toContain('#EXTINF:4.000,');
    expect(playlist).toContain('#EXT-X-TARGETDURATION:4');

    const uris = playlistUris(playlist);
    expect(uris.length).toBe(6);
    for (const uri of uris) {
      expect(uri).toMatch(entryUriRe());
    }
    const byKind = new Map(assets.map((asset) => [asset.upstreamUrl, asset.kind]));
    expect(byKind.get('http://upstream-a.example/live/hi/init.mp4')).toBe('map');
    expect(byKind.get('http://upstream-a.example/keys/key.bin')).toBe('key');
    expect(byKind.get('http://upstream-a.example/live/hi/seg-0.ts?token=abc&t=1')).toBe('segment');
    expect(byKind.get('http://upstream-a.example/live/hi/byte-seg.ts')).toBe('segment');
    expectNoUpstreamLeak(playlist, 'upstream-a.example', 'cdn.upstream.example', 'seg-0.ts', 'init.mp4', 'key.bin');
  });

  it('URI 形态:相对/绝对路径/绝对 http(s)/查询串全部按上游清单 URL 解析为正确上游资产 URL;输出仅入口路径 + 入口层附加的 ticket', async () => {
    const result = await newAssetsService().rewritePlaylist({
      householdId: HOUSEHOLD_ID,
      sessionId: SESSION_ID,
      generation: GENERATION,
      upstreamUrl: MEDIA_UPSTREAM_URL,
      text: MEDIA_PLAYLIST,
      ticket: TICKET,
      depth: 1,
    });
    const { playlist, assets } = expectRewriteOk(result);

    // 相对 URI → 相对上游清单所在目录;绝对路径 URI → 上游主机根;绝对 http(s) URI 原样;
    // 查询串保留在上游资产 URL 上(代理取上游时带上),输出 URI 只保留入口层 ticket
    const byUrl = new Map(assets.map((asset) => [asset.upstreamUrl, asset]));
    expect(byUrl.has('http://upstream-a.example/live/hi/seg-0.ts?token=abc&t=1')).toBe(true);
    expect(byUrl.has('http://upstream-a.example/live/hi/byte-seg.ts')).toBe(true);
    expect(byUrl.has('http://upstream-a.example/hls/abs/seg-2.ts')).toBe(true);
    expect(byUrl.has('https://cdn.upstream.example/hls/seg-3.ts')).toBe(true);
    expect(playlist).not.toContain('token=abc');
    expect(playlist).not.toContain('&t=1');
    for (const uri of playlistUris(playlist)) {
      const parsed = new URL(uri, 'https://entry.invalid');
      expect(parsed.pathname.startsWith(`/playback/stream/${SESSION_ID}/${GENERATION}/`)).toBe(true);
      expect([...parsed.searchParams.keys()]).toEqual(['ticket']);
      expect(parsed.searchParams.get('ticket')).toBe(TICKET);
    }
  });
});

describe('T015 拒绝矩阵:畸形/预算/嵌套/循环/DRM/未知 scheme(稳定失败,不透传)', () => {
  it('畸形清单:非文本二进制内容与缺 #EXTM3U 头的文本 → 稳定失败', async () => {
    const binary = await newAssetsService().rewritePlaylist({
      householdId: HOUSEHOLD_ID,
      sessionId: SESSION_ID,
      generation: GENERATION,
      upstreamUrl: MEDIA_UPSTREAM_URL,
      text: '\u0000\u0001\u0002PNG\r\n\u001a\n\u00ff\u00d8\u00ff',
      ticket: TICKET,
      depth: 0,
    });
    expectRewriteFailed(binary, 'PLAYBACK_FORMAT_UNSUPPORTED');

    const noHeader = await newAssetsService().rewritePlaylist({
      householdId: HOUSEHOLD_ID,
      sessionId: SESSION_ID,
      generation: GENERATION,
      upstreamUrl: MEDIA_UPSTREAM_URL,
      text: '#EXT-X-VERSION:3\n#EXTINF:4.0,\nseg.ts\n',
      ticket: TICKET,
      depth: 0,
    });
    expectRewriteFailed(noHeader, 'PLAYBACK_FORMAT_UNSUPPORTED');
  });

  it('超预算大小:清单文本超过 maxPlaylistBytes(2MiB)→ 稳定失败(截断不交付)', async () => {
    const oversized = `#EXTM3U\n# 上游侧超大体量的注释填充(非 URI,隔离大小预算与 URI 数预算)\n${'# padding-aaaa'.repeat(180000)}\n`;
    expect(Buffer.byteLength(oversized)).toBeGreaterThan(PLAYBACK_BUDGETS.hlsUpstream.maxPlaylistBytes);
    const result = await newAssetsService().rewritePlaylist({
      householdId: HOUSEHOLD_ID,
      sessionId: SESSION_ID,
      generation: GENERATION,
      upstreamUrl: MEDIA_UPSTREAM_URL,
      text: oversized,
      ticket: TICKET,
      depth: 0,
    });
    expectRewriteFailed(result, 'PLAYBACK_FORMAT_UNSUPPORTED');
  });

  it('URI 数预算:每清单 URI 超 10000 → 稳定失败;恰好 10000 → 通过(边界)', async () => {
    const build = (count: number): string =>
      [`#EXTM3U`, '#EXT-X-TARGETDURATION:4', ...Array.from({ length: count }, (_v, i) => `#EXTINF:4.0,\nseg-${i}.ts`), ''].join('\n');
    const over = await newAssetsService().rewritePlaylist({
      householdId: HOUSEHOLD_ID,
      sessionId: SESSION_ID,
      generation: GENERATION,
      upstreamUrl: MEDIA_UPSTREAM_URL,
      text: build(PLAYBACK_BUDGETS.hlsUpstream.maxUrisPerPlaylist + 1),
      ticket: TICKET,
      depth: 0,
    });
    expectRewriteFailed(over, 'PLAYBACK_FORMAT_UNSUPPORTED');

    const atLimit = await newAssetsService().rewritePlaylist({
      householdId: HOUSEHOLD_ID,
      sessionId: SESSION_ID,
      generation: GENERATION,
      upstreamUrl: MEDIA_UPSTREAM_URL,
      text: build(PLAYBACK_BUDGETS.hlsUpstream.maxUrisPerPlaylist),
      ticket: TICKET,
      depth: 0,
    });
    expectRewriteOk(atLimit);
  });

  it('嵌套预算:清单深度达到 maxPlaylistNestingDepth(4)→ 稳定失败;depth=3 仍可重写', async () => {
    const depthLimit = await newAssetsService().rewritePlaylist({
      householdId: HOUSEHOLD_ID,
      sessionId: SESSION_ID,
      generation: GENERATION,
      upstreamUrl: MASTER_UPSTREAM_URL,
      text: MASTER_PLAYLIST,
      ticket: TICKET,
      depth: PLAYBACK_BUDGETS.hlsUpstream.maxPlaylistNestingDepth,
    });
    expectRewriteFailed(depthLimit, 'PLAYBACK_FORMAT_UNSUPPORTED');

    const deepestAllowed = await newAssetsService().rewritePlaylist({
      householdId: HOUSEHOLD_ID,
      sessionId: SESSION_ID,
      generation: GENERATION,
      upstreamUrl: MEDIA_UPSTREAM_URL,
      text: MEDIA_PLAYLIST,
      ticket: TICKET,
      depth: PLAYBACK_BUDGETS.hlsUpstream.maxPlaylistNestingDepth - 1,
    });
    expectRewriteOk(deepestAllowed);
  });

  it('循环引用 A→B→A:已重写清单链上再次出现同一上游清单 → 稳定失败(入口 A 与 B 自身均通过)', async () => {
    const urlA = 'http://upstream-a.example/loop/a.m3u8';
    const urlB = 'http://upstream-a.example/loop/b.m3u8';
    const text = '#EXTM3U\n#EXT-X-TARGETDURATION:4\n#EXTINF:4.0,\nseg.ts\n';

    const entryA = await newAssetsService().rewritePlaylist({
      householdId: HOUSEHOLD_ID,
      sessionId: SESSION_ID,
      generation: GENERATION,
      upstreamUrl: urlA,
      text,
      ticket: TICKET,
      depth: 0,
    });
    expectRewriteOk(entryA);

    const viaB = await newAssetsService().rewritePlaylist({
      householdId: HOUSEHOLD_ID,
      sessionId: SESSION_ID,
      generation: GENERATION,
      upstreamUrl: urlB,
      text,
      ticket: TICKET,
      depth: 1,
      ancestorUpstreamUrls: [urlA],
    });
    expectRewriteOk(viaB);

    const backToA = await newAssetsService().rewritePlaylist({
      householdId: HOUSEHOLD_ID,
      sessionId: SESSION_ID,
      generation: GENERATION,
      upstreamUrl: urlA,
      text,
      ticket: TICKET,
      depth: 2,
      ancestorUpstreamUrls: [urlA, urlB],
    });
    expectRewriteFailed(backToA, 'PLAYBACK_FORMAT_UNSUPPORTED');
  });

  it('DRM 拒绝:SAMPLE-AES 会话/媒体 key、FairPlay(skd:/METHOD=FAIRPLAY)痕迹、EXT-X-FAXS 专有标签 → 稳定失败', async () => {
    const rewrite = (text: string, depth = 1) =>
      newAssetsService().rewritePlaylist({
        householdId: HOUSEHOLD_ID,
        sessionId: SESSION_ID,
        generation: GENERATION,
        upstreamUrl: MEDIA_UPSTREAM_URL,
        text,
        ticket: TICKET,
        depth,
      });

    const sampleAes = await rewrite(
      [
        '#EXTM3U',
        '#EXT-X-TARGETDURATION:4',
        '#EXT-X-KEY:METHOD=SAMPLE-AES,URI="keys/fairplay.key",IV=0x10c6f0c4',
        '#EXTINF:4.0,',
        'seg.ts',
        '',
      ].join('\n'),
    );
    expectRewriteFailed(sampleAes, 'PLAYBACK_FORMAT_UNSUPPORTED');

    const sessionKey = await rewrite(
      [
        '#EXTM3U',
        '#EXT-X-STREAM-INF:BANDWIDTH=800000,RESOLUTION=640x360',
        'hi.m3u8',
        '#EXT-X-SESSION-KEY:METHOD=SAMPLE-AES,URI="skd://key65369b0d"',
        '',
      ].join('\n'),
      0,
    );
    expectRewriteFailed(sessionKey, 'PLAYBACK_FORMAT_UNSUPPORTED');

    const fairPlayMethod = await rewrite(
      [
        '#EXTM3U',
        '#EXT-X-TARGETDURATION:4',
        '#EXT-X-KEY:METHOD=FAIRPLAY,URI="skd://key65369b0d",IV=0x10c6f0c4',
        '#EXTINF:4.0,',
        'seg.ts',
        '',
      ].join('\n'),
    );
    expectRewriteFailed(fairPlayMethod, 'PLAYBACK_FORMAT_UNSUPPORTED');

    const faxs = await rewrite(
      [
        '#EXTM3U',
        '#EXT-X-TARGETDURATION:4',
        '#EXT-X-FAXS:1',
        '#EXTINF:4.0,',
        'seg.ts',
        '',
      ].join('\n'),
    );
    expectRewriteFailed(faxs, 'PLAYBACK_FORMAT_UNSUPPORTED');
  });

  it('未知/私有 scheme URI(ftp://、data:、file://)→ 稳定失败且不登记资产', async () => {
    const rewrite = (uri: string) =>
      newAssetsService().rewritePlaylist({
        householdId: HOUSEHOLD_ID,
        sessionId: SESSION_ID,
        generation: GENERATION,
        upstreamUrl: MEDIA_UPSTREAM_URL,
        text: `#EXTM3U\n#EXT-X-TARGETDURATION:4\n#EXTINF:4.0,\n${uri}\n`,
        ticket: TICKET,
        depth: 1,
      });

    for (const uri of ['ftp://upstream-a.example/seg.ts', 'data:text/plain,hello', 'file:///hls/seg.ts']) {
      const result = await rewrite(uri);
      const failure = expectRewriteFailed(result, 'PLAYBACK_FORMAT_UNSUPPORTED');
      expect(failure.reason).not.toContain(uri);
    }
  });
});

describe('T015 禁止透传原始清单:重写输出不含任何原始上游 URL/主机名', () => {
  it('master 与媒体清单重写输出全文断言:无协议、无上游主机名、无上游路径', async () => {
    const master = await newAssetsService().rewritePlaylist({
      householdId: HOUSEHOLD_ID,
      sessionId: SESSION_ID,
      generation: GENERATION,
      upstreamUrl: MASTER_UPSTREAM_URL,
      text: MASTER_PLAYLIST,
      ticket: TICKET,
      depth: 0,
    });
    expectRewriteOk(master);

    const media = await newAssetsService().rewritePlaylist({
      householdId: HOUSEHOLD_ID,
      sessionId: SESSION_ID,
      generation: GENERATION,
      upstreamUrl: MEDIA_UPSTREAM_URL,
      text: MEDIA_PLAYLIST,
      ticket: TICKET,
      depth: 1,
    });
    const { playlist } = expectRewriteOk(media);

    expectNoUpstreamLeak(
      master.value.playlist,
      'upstream-a.example',
      'cdn.upstream.example',
      'http',
      'live/master',
      'hi/playlist',
    );
    expectNoUpstreamLeak(
      playlist,
      'upstream-a.example',
      'cdn.upstream.example',
      'http',
      'seg-0.ts',
      'byte-seg.ts',
      'key.bin',
      'init.mp4',
    );
    // 重写输出中每一行 URI 都是且仅是同源入口;服务端资产登记表才持有原 URL
    for (const uri of playlistUris(playlist)) {
      expect(uri).toMatch(entryUriRe());
    }
    expect(master.value.assets.every((asset) => asset.upstreamUrl.startsWith('http'))).toBe(true);
  });
});

describe('T015 上游请求构造与响应头边界(本地 http 上游,HlsProxyService)', () => {
  it('向上游发起的请求不含应用 Cookie/Bearer(hmp_session 痕迹零出现)', async () => {
    const upstream = await startUpstream((req, res) => {
      respondText(res, 200, '#EXTM3U\n#EXT-X-TARGETDURATION:4\n#EXTINF:4.0,\nseg.ts\n');
    });
    try {
      const result = await newProxyService().readPlaylist(`${upstream.origin}/live/capture.m3u8`, {
        allowedTargets: LOCAL_TARGETS,
      });
      expect(result.ok).toBe(true);
      if (!result.ok) {
        throw new Error(`读取应成功:${result.code} ${result.reason}`);
      }
      expect(upstream.seenRequests.length).toBe(1);
      expect(upstream.seenRequests[0]?.url).toBe('/live/capture.m3u8');
      const headers = upstream.seenRequests[0]?.headers ?? {};
      expect(headers['cookie']).toBeUndefined();
      expect(headers['authorization']).toBeUndefined();
      expect(JSON.stringify(headers).toLowerCase()).not.toContain('hmp_session');
    } finally {
      await upstream.close();
    }
  });

  it('redirect 在内部跟随且结果不携带 Location/Set-Cookie;上游 Set-Cookie 不透传', async () => {
    const upstream = await startUpstream((req, res) => {
      if (req.url === '/live/r1.m3u8') {
        res.writeHead(302, {
          location: '/live/r2.m3u8',
          'set-cookie': 'upstream_sess=leak-me; Path=/',
          connection: 'close',
        });
        res.end();
        return;
      }
      respondText(res, 200, '#EXTM3U\nFINAL\n');
    });
    try {
      const result = await newProxyService().readPlaylist(`${upstream.origin}/live/r1.m3u8`, {
        allowedTargets: LOCAL_TARGETS,
      });
      expect(result.ok).toBe(true);
      if (!result.ok) {
        throw new Error(`读取应成功:${result.code} ${result.reason}`);
      }
      expect(result.value.text).toContain('FINAL');
      expect(upstream.seenRequests.map((seen) => seen.url)).toEqual(['/live/r1.m3u8', '/live/r2.m3u8']);
      // 结果对象结构上不存在任何响应头透传面(Location/Set-Cookie 不出现在任何字段)
      const serialized = JSON.stringify(result.value).toLowerCase();
      expect(serialized).not.toContain('set-cookie');
      expect(serialized).not.toContain('upstream_sess');
      expect(serialized).not.toContain('location');
      expect(Object.keys(result.value).sort()).toEqual(['contentType', 'finalUrl', 'text']);
    } finally {
      await upstream.close();
    }
  });

  it('redirect 每跳重新校验 LAN 许可:首跳许可不豁免次跳,未许可私网目标在连接前拒绝', async () => {
    const upstream = await startUpstream((req, res) => {
      if (req.url === '/live/hop.m3u8') {
        res.writeHead(302, { location: 'http://10.255.255.255/secret.m3u8', connection: 'close' });
        res.end();
        return;
      }
      respondText(res, 200, '#EXTM3U\nSHOULD-NOT-REACH\n');
    });
    try {
      const result = await newProxyService().readPlaylist(`${upstream.origin}/live/hop.m3u8`, {
        allowedTargets: LOCAL_TARGETS,
      });
      expect(result.ok).toBe(false);
      if (result.ok) {
        throw new Error('重定向到未许可私网目标应失败');
      }
      expect(result.value.code).toBe('PLAYBACK_RESOURCE_UNAVAILABLE');
      // 仅首跳被请求;10.255.255.255 一跳在本地夹具上不可观测,但本服务器不得收到第二次请求
      expect(upstream.seenRequests.map((seen) => seen.url)).toEqual(['/live/hop.m3u8']);
    } finally {
      await upstream.close();
    }
  });

  it('redirect 预算:跟随 3 跳(maxRedirects)成功,第 4 跳拒绝', async () => {
    const upstream = await startUpstream((req, res) => {
      const chains: Record<string, string> = {
        '/d1': '/d2',
        '/d2': '/d3',
        '/d3': '/d4',
        '/e1': '/e2',
        '/e2': '/e3',
        '/e3': '/e4',
        '/e4': '/e5',
      };
      const target = chains[req.url ?? ''];
      if (target !== undefined) {
        res.writeHead(302, { location: target, connection: 'close' });
        res.end();
        return;
      }
      respondText(res, 200, '#EXTM3U\nEND-OF-CHAIN\n');
    });
    try {
      const within = await newProxyService().readPlaylist(`${upstream.origin}/d1`, {
        allowedTargets: LOCAL_TARGETS,
      });
      expect(within.ok).toBe(true);
      if (!within.ok) {
        throw new Error(`3 跳 redirect 应成功:${within.code} ${within.reason}`);
      }
      expect(within.value.text).toContain('END-OF-CHAIN');

      const exceeded = await newProxyService().readPlaylist(`${upstream.origin}/e1`, {
        allowedTargets: LOCAL_TARGETS,
      });
      expect(exceeded.ok).toBe(false);
      if (exceeded.ok) {
        throw new Error('4 跳 redirect 应失败');
      }
      expect(exceeded.value.code).toBe('PLAYBACK_RESOURCE_UNAVAILABLE');
    } finally {
      await upstream.close();
    }
  });
});

describe('T015 预算消费:超时/尺寸上限来自 budgets.hlsUpstream(注入预算的行为断言)', () => {
  it('清单尺寸上限:超过 maxPlaylistBytes(2MiB)的上游响应 → 稳定失败(默认预算)', async () => {
    const oversized = `#EXTM3U\n${'x'.repeat(2 * MIB + 1)}`;
    const upstream = await startUpstream((req, res) => {
      res.writeHead(200, {
        'content-type': 'application/vnd.apple.mpegurl',
        'content-length': String(Buffer.byteLength(oversized)),
        connection: 'close',
      });
      res.end(oversized);
    });
    try {
      const result = await newProxyService().readPlaylist(`${upstream.origin}/big.m3u8`, {
        allowedTargets: LOCAL_TARGETS,
      });
      expect(result.ok).toBe(false);
      if (result.ok) {
        throw new Error('超预算清单应失败');
      }
      expect(result.value.code).toBe('PLAYBACK_RESOURCE_UNAVAILABLE');
      expect(result.value.text).toBeUndefined();
    } finally {
      await upstream.close();
    }
  });

  it('首字节超时:注入 firstByteTimeoutSeconds=1 时,1.5s 才响应的上游 → 失败;默认预算同一上游成功', async () => {
    const upstream = await startUpstream((req, res) => {
      setTimeout(() => {
        if (res.destroyed || res.writableEnded) {
          return;
        }
        respondText(res, 200, '#EXTM3U\nSLOW\n');
      }, 1500);
    });
    try {
      const tight = await newProxyService(withHlsBudgets({ firstByteTimeoutSeconds: 1 })).readPlaylist(
        `${upstream.origin}/slow.m3u8`,
        { allowedTargets: LOCAL_TARGETS },
      );
      expect(tight.ok).toBe(false);
      if (tight.ok) {
        throw new Error('注入 1s 首字节预算后,1.5s 响应应失败');
      }
      expect(tight.value.code).toBe('PLAYBACK_RESOURCE_UNAVAILABLE');

      const defaulted = await newProxyService().readPlaylist(`${upstream.origin}/slow.m3u8`, {
        allowedTargets: LOCAL_TARGETS,
      });
      expect(defaulted.ok).toBe(true);
      if (!defaulted.ok) {
        throw new Error(`默认 15s 预算下应成功:${defaulted.code} ${defaulted.reason}`);
      }
      expect(defaulted.value.text).toContain('SLOW');
    } finally {
      await upstream.close();
    }
  });

  it('分片与 key 尺寸预算:注入 maxSegmentBytes=1KiB 后 2KiB 分片失败(默认预算成功);key 超 maxKeyBytes=16 字节失败、16 字节成功', async () => {
    const segmentBytes = Buffer.alloc(2048, 0x41);
    const key16 = Buffer.from('0123456789abcdef', 'utf8');
    const upstream = await startUpstream((req, res) => {
      if (req.url === '/live/seg.ts') {
        res.writeHead(200, { 'content-type': 'video/mp2t', 'content-length': String(segmentBytes.length), connection: 'close' });
        res.end(segmentBytes);
        return;
      }
      const key = req.url === '/live/k16' ? key16 : Buffer.from('0123456789abcdefgh', 'utf8');
      res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': String(key.length), connection: 'close' });
      res.end(key);
    });
    try {
      const tightBudgets = withHlsBudgets({ maxSegmentBytes: 1024 });
      const over = await newProxyService(tightBudgets).readAsset(`${upstream.origin}/live/seg.ts`, {
        allowedTargets: LOCAL_TARGETS,
        kind: 'segment',
      });
      expect(over.ok).toBe(false);
      if (over.ok) {
        throw new Error('注入 1KiB 分片预算后,2KiB 响应应失败');
      }
      expect(over.value.code).toBe('PLAYBACK_RESOURCE_UNAVAILABLE');

      const under = await newProxyService().readAsset(`${upstream.origin}/live/seg.ts`, {
        allowedTargets: LOCAL_TARGETS,
        kind: 'segment',
      });
      expect(under.ok).toBe(true);
      if (!under.ok) {
        throw new Error(`默认 64MiB 分片预算下应成功:${under.code} ${under.reason}`);
      }
      expect(await readAll(under.value.stream)).toEqual(segmentBytes);

      const longKey = await newProxyService().readAsset(`${upstream.origin}/live/k17`, {
        allowedTargets: LOCAL_TARGETS,
        kind: 'key',
      });
      expect(longKey.ok).toBe(false);
      if (longKey.ok) {
        throw new Error('17 字节 key 应失败(上限 16 字节)');
      }
      expect(longKey.value.code).toBe('PLAYBACK_RESOURCE_UNAVAILABLE');

      const exactKey = await newProxyService().readAsset(`${upstream.origin}/live/k16`, {
        allowedTargets: LOCAL_TARGETS,
        kind: 'key',
      });
      expect(exactKey.ok).toBe(true);
      if (!exactKey.ok) {
        throw new Error(`16 字节 key 应成功:${exactKey.code} ${exactKey.reason}`);
      }
      expect(await readAll(exactKey.value.stream)).toEqual(key16);
    } finally {
      await upstream.close();
    }
  });
});

describe('T015 每跳 LAN 许可校验(validateUpstreamHop:私网/localhost/精确 CIDR/DNS)', () => {
  const hop = (url: string, options: { allowedTargets?: readonly LanTarget[]; resolveDns?: (hostname: string) => Promise<readonly string[]> } = {}) =>
    validateUpstreamHop(url, options);

  it('默认拒绝:无许可时私网/环回/localhost/公网全部拒绝', async () => {
    for (const url of [
      'http://127.0.0.1:8000/live.m3u8',
      'http://10.1.2.3/live.m3u8',
      'http://172.16.0.9/live.m3u8',
      'http://192.168.1.5/live.m3u8',
      'http://169.254.1.1/live.m3u8',
      'http://[::1]:9000/live.m3u8',
      'http://localhost:9000/live.m3u8',
      'https://public.example/live.m3u8',
    ]) {
      const result = await hop(url);
      expect(result.ok, `无许可时应默认拒绝:${url}`).toBe(false);
    }
  });

  it('精确 host 许可:仅许可地址与端口通过;同网段相邻环回地址/其他端口与未许可主机名拒绝', async () => {
    const allowed: readonly LanTarget[] = [
      { kind: 'host', host: '127.0.0.1' },
      { kind: 'hostPort', host: '127.0.0.1', port: 8000 },
    ];
    expect((await hop('http://127.0.0.1:9001/live.m3u8', { allowedTargets: allowed })).ok).toBe(true);
    expect((await hop('http://127.0.0.1:8000/live.m3u8', { allowedTargets: allowed })).ok).toBe(true);
    expect((await hop('http://127.0.0.2:8000/live.m3u8', { allowedTargets: allowed })).ok).toBe(false);
    expect((await hop('http://10.0.0.7/live.m3u8', { allowedTargets: allowed })).ok).toBe(false);
    expect((await hop('http://iptv.upstream.example/live.m3u8', { allowedTargets: allowed })).ok).toBe(false);
  });

  it('精确 CIDR 许可:192.168.1.0/24 覆盖 .1.10、不覆盖 .2.10;/0 通配语义不存在', async () => {
    const cidr: readonly LanTarget[] = [{ kind: 'cidr', family: 4, address: '192.168.1.0', prefixLength: 24 }];
    expect((await hop('http://192.168.1.10/live.m3u8', { allowedTargets: cidr })).ok).toBe(true);
    expect((await hop('http://192.168.2.10/live.m3u8', { allowedTargets: cidr })).ok).toBe(false);
  });

  it('DNS 注入:主机名按每次解析结果逐 IP 验证;解析到许可网段通过,解析到私网拒绝,解析失败拒绝', async () => {
    const cidr: readonly LanTarget[] = [{ kind: 'cidr', family: 4, address: '192.168.1.0', prefixLength: 24 }];
    const allowed = await hop('http://cdn.lan.example/live.m3u8', {
      allowedTargets: cidr,
      resolveDns: async () => ['192.168.1.77'],
    });
    expect(allowed.ok).toBe(true);

    const privateResult = await hop('http://cdn.lan.example/live.m3u8', {
      allowedTargets: cidr,
      resolveDns: async () => ['10.9.9.9'],
    });
    expect(privateResult.ok).toBe(false);

    const failing = await hop('http://cdn.lan.example/live.m3u8', {
      allowedTargets: cidr,
      resolveDns: async () => {
        throw new Error('dns failure');
      },
    });
    expect(failing.ok).toBe(false);

    // localhost 解析到环回:仅在环回被精确许可时通过
    const loopback: readonly LanTarget[] = [{ kind: 'host', host: '127.0.0.1' }];
    expect(
      (
        await hop('http://localhost:9000/live.m3u8', {
          allowedTargets: loopback,
          resolveDns: async () => ['127.0.0.1'],
        })
      ).ok,
    ).toBe(true);
    expect((await hop('http://localhost:9000/live.m3u8', { resolveDns: async () => ['127.0.0.1'] })).ok).toBe(false);
  });

  it('非 http(s) 与未知/私有 scheme(ftp/data/file)一律拒绝,即使地址在许可网段内;http(s) URL 的普通查询串不受 scheme 检查影响', async () => {
    const cidr: readonly LanTarget[] = [{ kind: 'cidr', family: 4, address: '192.168.1.0', prefixLength: 24 }];
    for (const url of [
      'ftp://192.168.1.10/seg.ts',
      'data:text/plain,hello',
      'file:///nas-media/movie.mp4',
      'javascript://192.168.1.10/x',
    ]) {
      const result = await hop(url, { allowedTargets: cidr });
      expect(result.ok, `scheme 应拒绝:${url}`).toBe(false);
    }
    expect(
      (await hop('http://192.168.1.10/seg.ts?next=data:text/plain,x', { allowedTargets: cidr })).ok,
      'http URL 的查询串含 data: 文本不构成 scheme 违规',
    ).toBe(true);
  });
});
