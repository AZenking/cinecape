import 'reflect-metadata';
import http from 'node:http';
import fs from 'node:fs';
import dns from 'node:dns';
import os from 'node:os';
import path from 'node:path';
import { execFile as execFileCb, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
import type { Readable } from 'node:stream';
import type { ArgumentsHost, INestApplication } from '@nestjs/common';
import type { Response } from 'express';
import { eq } from 'drizzle-orm';
import { afterEach, beforeAll, afterAll, describe, expect, it, vi } from 'vitest';
import { ProblemCode } from '@hmp/shared';
import {
  PLAYBACK_FIXTURE_NOW,
  seedPlaybackSession,
  seedPlaybackWorld,
  type PlaybackWorld,
} from '../../fixtures/playback';
import { Database } from '@platform/database/database';
import { setEnvOverride } from '@platform/config/env';
import { loadEnv, type LanTarget, type MediaRoots } from '@platform/config/env.schema';
import { PLAYBACK_BUDGETS, createPlaybackBudgets, type PlaybackBudgets } from '@platform/config/playback-budgets';
import { getDb } from '@platform/database/drizzle';
import { account, deviceSession, profilePolicy } from '@platform/database/schema';
import { DomainError } from '@platform/http-common/domain-error';
import { ProblemJsonFilter } from '@platform/http-common/problem-json.filter';
import { redactQueryTicket, redactSourcePaths, summarizeFfmpegStderr } from '@platform/http-common/log-redaction.util';
import type { SessionContext } from '@platform/http-common/current-session.decorator';
import { PlaybackRepository } from '../../../src/contexts/playback/infrastructure/playback.repository';
import { bindPlaybackStore } from '../../../src/contexts/playback/application/playback-store.port';
import { drizzlePlaybackStore } from '../../../src/contexts/playback/infrastructure/playback-store.drizzle';
import { PlaybackAuthorizationService } from '../../../src/contexts/playback/application/playback-authorization.service';
import { HlsProxyService, validateUpstreamHop } from '../../../src/contexts/playback/infrastructure/hls-proxy.service';
import { PlaybackAssetsService } from '../../../src/contexts/playback/application/playback-assets.service';
import { NasReaderService } from '../../../src/contexts/playback/infrastructure/nas-reader';
import {
  MediaProbeService,
  resolveNasMediaLocation,
  type MediaProbeClock,
  type MediaProbeSpawn,
  type ProbeProcessHandle,
  type ProbeSpawnRequest,
} from '../../../src/contexts/playback/infrastructure/media-probe.service';
import { PlaybackSelectionService } from '../../../src/contexts/playback/application/playback-selection.service';
import type { PlaybackProbeFacts } from '../../../src/contexts/playback/application/playback-resolver.service';
import {
  PlaybackSubtitlesService,
  type SubtitleSourceLocator,
} from '../../../src/contexts/playback/infrastructure/playback-subtitles.service';

/**
 * 008-T013(ADR-0015 D1):测试 rig 绑定仓储 seam(惰性 Database.db 解析,
 * 每测试 close/重开单例仍正确;AppModule 路径由 PlaybackModule 幂等覆盖)。
 */
bindPlaybackStore(drizzlePlaybackStore());

/**
 * 输入安全聚合单测(T036,spec 004 US2)—— 跨服务组合攻击面 / 凭据泄漏 / header 后脱敏 / 伪造输入。
 *
 * 权威依据:
 * - docs/specs/004-playback-resolver/tasks.md T036:「先覆盖DNS重绑定/redirect、嵌套清单URI
 *   及凭据、NAS/字幕越界与符号链接、malformed probe、脚本、轨道伪造和header后错误脱敏;
 *   请求上游不能携带应用认证」;
 * - docs/specs/004-playback-resolver/research.md R3(每次 DNS/redirect 验证精确 LAN 许可;
 *   嵌套/循环/data-file 协议拒绝,不透传原文;NAS 只读验证输入;子进程参数数组 shell=false、
 *   禁网络协议)与 R6(旁车 ≤5MiB 无符号链接、文本仅作字幕显示禁 HTML 脚本、选轨只接受
 *   服务器返回 ID、日志不记录原路径/URL/query ticket/原始 stderr);
 * - docs/specs/004-playback-resolver/tasks.md T037/T038 为对应实现任务。
 *
 * 聚合口径(与既有单测的分工):hls-proxy.spec / nas-reader.spec / subtitles.spec 已覆盖
 * 各服务自身的安全细节;本文件不重复其用例细节,聚焦:
 *   1) DNS 重绑定「校验层 × 连接层钉扎」组合与可注入性;
 *   2) redirect 二跳凭据边界与 scheme 变化行为记录;
 *   3) 三层嵌套清单逐层重写后的上游凭据/主机零泄漏聚合;
 *   4) NAS/字幕越界与符号链接 × 授权收紧的组合(含 5MiB 边界参数化);
 *   5) malformed probe(非法 JSON/路径脱敏/argv 无 shell 注入面,真实 FFmpeg 层验证);
 *   6) 脚本注入(清单 scheme/清单行换行标签伪造/字幕 HTML 转义);
 *   7) 轨道伪造与 assetId 枚举(单测层直接断言);
 *   8) header 后错误通道样本 × T012 脱敏语义(redactSourcePaths/redactQueryTicket);
 *   9) 上游请求「无应用认证」恒等聚合(readPlaylist/readAsset/redirect 二跳参数化)。
 *
 * 缺口约定:实现与 T036 安全要求不一致的用例保持失败并在标题标注 [T037/T038 缺口],
 * 修复归属 US2 实现任务(T037 授权/票据完善、T038 控制器/生命周期失败关闭)。
 */

/* ------------------------------------------------------------------ */
/* 夹具:本地 http 上游(与 hls-proxy.spec 同款构造,自包含)               */
/* ------------------------------------------------------------------ */

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

function respondText(res: http.ServerResponse, status: number, body: string, contentType = 'application/vnd.apple.mpegurl'): void {
  res.writeHead(status, { 'content-type': contentType, connection: 'close' });
  res.end(body);
}

async function collect(stream: Readable): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks);
}

/* ------------------------------------------------------------------ */
/* 公共常量与断言工具                                                    */
/* ------------------------------------------------------------------ */

const LOCAL_TARGET: LanTarget = { kind: 'host', host: '127.0.0.1' };
const LOCAL_TARGETS: readonly LanTarget[] = [LOCAL_TARGET];

const HOUSEHOLD_ID = randomUUID();
const SESSION_ID = randomUUID();
const GENERATION = 3;
/** 入口层票据(票据服务签发的 opaque 词法;上游请求头恒不含它) */
const TICKET = 't036-opaque-ticket-9f2c';
/** 上游侧内嵌票据(攻击载荷:模拟上游清单 query 携带的第三方票据) */
const UPSTREAM_TICKET = 'UPSTREAM-LEAK-TKT-77';

const ASSET_URI = '[A-Za-z0-9._~-]+';

function escapeRe(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** /playback/stream/{sessionId}/{generation}/{assetId}?ticket={ticket} 精确形态 */
function entryUriRe(): RegExp {
  return new RegExp(`^/playback/stream/${escapeRe(SESSION_ID)}/${GENERATION}/${ASSET_URI}\\?ticket=${escapeRe(TICKET)}$`);
}

/** 抽取清单文本中全部 URI:非注释行 + 行内 URI="…" 属性 */
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

function newProxyService(budgets: PlaybackBudgets = PLAYBACK_BUDGETS): HlsProxyService {
  return new HlsProxyService({ budgets });
}

function withHlsBudgets(override: Partial<PlaybackBudgets['hlsUpstream']>): PlaybackBudgets {
  const base = createPlaybackBudgets(loadEnv({ NODE_ENV: 'test' }));
  return { ...base, hlsUpstream: { ...base.hlsUpstream, ...override } };
}

/**
 * 错误通道样本脱敏聚合断言:样本本身不含任何上游 URL/主机/票据/会话痕迹,
 * 且 T012 脱敏工具对其幂等(没有可脱敏对象 → 原样返回)。
 */
function expectRedactedStatic(sample: string, context: string): void {
  expect(sample, `${context}:不得含上游 URL`).not.toMatch(/https?:\/\//i);
  expect(sample, `${context}:不得含协议分隔符`).not.toContain('://');
  expect(sample, `${context}:不得含上游票据`).not.toContain(UPSTREAM_TICKET);
  expect(sample, `${context}:不得含入口票据`).not.toContain(TICKET);
  expect(sample.toLowerCase(), `${context}:不得含应用会话 cookie 名`).not.toContain('hmp_session');
  expect(redactQueryTicket(sample), `${context}:T012 ticket 闸应幂等(无票据可脱敏)`).toBe(sample);
  expect(redactSourcePaths(sample), `${context}:T012 路径闸应幂等(无路径可脱敏)`).toBe(sample);
}

/** 应用凭据的出站请求头恒等断言(参数化供 redirect 二跳/资产/清单共用) */
function expectNoAppCredentials(headers: Record<string, string | undefined>, context: string): void {
  expect(headers['cookie'], `${context}:Cookie 零出现`).toBeUndefined();
  expect(headers['authorization'], `${context}:Authorization 零出现`).toBeUndefined();
  const serialized = JSON.stringify(headers).toLowerCase();
  expect(serialized, `${context}:hmp_session 痕迹零出现`).not.toContain('hmp_session');
  expect(serialized, `${context}:票据痕迹零出现`).not.toContain('ticket');
  expect(serialized, `${context}:Bearer 痕迹零出现`).not.toContain('bearer');
}

/* ------------------------------------------------------------------ */
/* 1. DNS 重绑定组合:resolveDns 混合地址全量校验 + lookup 钉扎            */
/* ------------------------------------------------------------------ */

describe('T036 DNS 重绑定组合(resolveDns 混合地址全量校验,不因首 IP 许可放行)', () => {
  const cidr: readonly LanTarget[] = [{ kind: 'cidr', family: 4, address: '192.168.1.0', prefixLength: 24 }];
  const hop = (url: string, options: { allowedTargets?: readonly LanTarget[]; resolveDns?: (hostname: string) => Promise<readonly string[]> } = {}) =>
    validateUpstreamHop(url, options);

  it('混合地址参数化:任一解析 IP 未许可即整体拒绝(顺序无关/全私网/空解析),全许可对照组通过', async () => {
    const cases: readonly { readonly name: string; readonly addresses: readonly string[]; readonly expectOk: boolean }[] = [
      { name: '首个许可+第二个私网(经典重绑定序)', addresses: ['192.168.1.77', '10.9.9.9'], expectOk: false },
      { name: '首个私网+第二个许可(逆序同拒)', addresses: ['10.9.9.9', '192.168.1.77'], expectOk: false },
      { name: '私网夹在两个许可 IP 中间', addresses: ['192.168.1.10', '172.16.0.9', '192.168.1.11'], expectOk: false },
      { name: '全私网', addresses: ['10.9.9.9'], expectOk: false },
      { name: '解析为空(fail-closed)', addresses: [], expectOk: false },
      { name: '全许可(对照:校验层放行)', addresses: ['192.168.1.77', '192.168.1.78'], expectOk: true },
    ];
    for (const testCase of cases) {
      const result = await hop('http://cdn.rebind.example/live.m3u8', {
        allowedTargets: cidr,
        resolveDns: async () => testCase.addresses,
      });
      expect(result.ok, `${testCase.name}:期望 ${testCase.expectOk ? '通过' : '拒绝'}`).toBe(testCase.expectOk);
    }
  });

  it('DNS 解析异常 → 拒绝(校验层不对解析失败降级)', async () => {
    const result = await hop('http://cdn.rebind.example/live.m3u8', {
      allowedTargets: cidr,
      resolveDns: async () => {
        throw new Error('dns failure');
      },
    });
    expect(result.ok).toBe(false);
  });
});

describe('T036 DNS 钉扎行为(连接层 lookup:混合地址拒绝与首地址钉扎;实现细节经私有方法直调验证)', () => {
  /** 服务私有 pinnedLookup 的直调面(TypeScript 隐私仅为编译期;运行时可观测)。 */
  type PinnedLookupFn = (hostname: string, options: unknown, callback: (err: NodeJS.ErrnoException | null, address: string, family: number) => void) => void;
  const pinnedLookupOf = (proxy: HlsProxyService, targets: readonly LanTarget[], url: string): PinnedLookupFn => {
    const factory = (proxy as unknown as { pinnedLookup: (t: readonly LanTarget[], u: URL) => PinnedLookupFn }).pinnedLookup;
    return factory.call(proxy, targets, new URL(url));
  };
  const lookupOnce = (lookup: PinnedLookupFn, hostname: string): Promise<{ err: NodeJS.ErrnoException | null; address: string; family: number }> =>
    new Promise((resolve) => lookup(hostname, {}, (err, address, family) => resolve({ err, address, family })));

  afterEach(() => {
    vi.restoreAllMocks();
  });

  /** 按 case 提供解析结果(真实 dns.lookup 被 spy 短路;真实网络零依赖) */
  function mockResolvedAddresses(addresses: readonly { address: string; family: number }[]): void {
    vi.spyOn(dns, 'lookup').mockImplementation(((
      _hostname: string,
      _options: unknown,
      callback: (err: NodeJS.ErrnoException | null, results?: { address: string; family: number }[]) => void,
    ) => {
      queueMicrotask(() => callback(null, [...addresses]));
    }) as never);
  }

  it('解析结果混合(首个许可+私网)→ 钉扎层拒绝且回传零地址(不因首 IP 许可钉扎私网)', async () => {
    mockResolvedAddresses([{ address: '127.0.0.1', family: 4 }, { address: '10.1.2.3', family: 4 }]);
    const lookup = pinnedLookupOf(newProxyService(), LOCAL_TARGETS, 'http://rebind.internal/live.m3u8');
    const outcome = await lookupOnce(lookup, 'rebind.internal');
    expect(outcome.err, '混合地址应被拒绝').not.toBeNull();
    expect((outcome.err as { code?: string }).code).toBe('PLAYBACK_RESOURCE_UNAVAILABLE');
    expect(outcome.address, '拒绝时不得回传任何可连接地址').toBe('');
  });

  it('全部许可 → 钉扎解析首项(callback 地址=解析首项,与校验 IP 一致)', async () => {
    mockResolvedAddresses([{ address: '127.0.0.1', family: 4 }, { address: '127.0.0.2', family: 4 }]);
    const nameTargets: readonly LanTarget[] = [{ kind: 'host', host: 'pin-nas.internal' }];
    const lookup = pinnedLookupOf(newProxyService(), nameTargets, 'http://pin-nas.internal/live.m3u8');
    const outcome = await lookupOnce(lookup, 'pin-nas.internal');
    expect(outcome.err).toBeNull();
    expect(outcome.address).toBe('127.0.0.1');
    expect(outcome.family).toBe(4);
  });

  it('钉扎层拒绝矩阵参数化:全私网/空解析/DNS 异常 → 稳定码错误', async () => {
    const proxy = newProxyService();
    for (const addresses of [[{ address: '10.1.2.3', family: 4 }], []]) {
      mockResolvedAddresses(addresses);
      const lookup = pinnedLookupOf(proxy, LOCAL_TARGETS, 'http://rebind.internal/live.m3u8');
      const outcome = await lookupOnce(lookup, 'rebind.internal');
      expect(outcome.err, `addresses=${JSON.stringify(addresses)}`).not.toBeNull();
      expect((outcome.err as { code?: string }).code).toBe('PLAYBACK_RESOURCE_UNAVAILABLE');
      vi.restoreAllMocks();
    }
    // DNS 异常:lookup 原样传播错误(不吞错、不降级)
    vi.spyOn(dns, 'lookup').mockImplementation(((
      _hostname: string,
      _options: unknown,
      callback: (err: NodeJS.ErrnoException | null, address?: string, family?: number) => void,
    ) => {
      queueMicrotask(() => callback(Object.assign(new Error('EAI_AGAIN'), { code: 'EAI_AGAIN' }), '', 0));
    }) as never);
    const failing = pinnedLookupOf(proxy, LOCAL_TARGETS, 'http://rebind.internal/live.m3u8');
    const outcome = await lookupOnce(failing, 'rebind.internal');
    expect((outcome.err as { code?: string }).code).toBe('EAI_AGAIN');
  });
});

describe('T036 DNS 钉扎端到端(名字型许可目标 × 注入解析;连接 IP=钉扎 IP)', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  function mockResolvedAddresses(addresses: readonly { address: string; family: number }[]): void {
    vi.spyOn(dns, 'lookup').mockImplementation(((
      _hostname: string,
      _options: unknown,
      callback: (err: NodeJS.ErrnoException | null, results?: { address: string; family: number }[]) => void,
    ) => {
      queueMicrotask(() => callback(null, [...addresses]));
    }) as never);
  }

  it('名字型许可 + 双环回解析 → 连接钉扎解析首项成功(上游被实际命中,证明连接 IP=校验钉扎 IP)[T037/T038 缺口:连接层 lookup 回调为单地址形态,与 Node autoSelectFamily 的 all:true 回调契约(要求数组形态)不符 → 名字型上游连接必败 ERR_INVALID_IP_ADDRESS,「名字型钉扎」特性当前不可用(失败关闭方向,无泄漏面)]', async () => {
    // 夹具先行创建(dns spy 尚未安装:server.listen 的地址解析不得被 mock 污染)
    const upstream = await startUpstream((req, res) => {
      respondText(res, 200, '#EXTM3U\n#EXT-X-TARGETDURATION:4\n#EXTINF:4.0,\nseg.ts\n');
    });
    // 服务器只监听 127.0.0.1:若实现钉扎到解析第二项(127.0.0.2)则连接必然失败 ——
    // 成功本身即证明「实际连接 IP == 钉扎校验 IP(解析首项)」
    mockResolvedAddresses([{ address: '127.0.0.1', family: 4 }, { address: '127.0.0.2', family: 4 }]);
    try {
      const nameTargets: readonly LanTarget[] = [{ kind: 'host', host: 'pin-nas.internal' }];
      const result = await newProxyService().readPlaylist(`http://pin-nas.internal:${upstream.port}/live.m3u8`, {
        allowedTargets: nameTargets,
      });
      expect(result.ok, result.ok ? '' : `名字型许可目标应经钉扎连接成功:${result.code} ${result.reason}`).toBe(true);
      expect(upstream.seenRequests).toHaveLength(1);
      expect(upstream.seenRequests[0]?.url).toBe('/live.m3u8');
      expectNoAppCredentials(upstream.seenRequests[0]?.headers ?? {}, '钉扎连接首跳');
    } finally {
      await upstream.close();
    }
  });

  it('行为记录(名字型钉扎语义):名字型许可目标不做逐 IP 复核 —— 私网解析结果被原样钉扎,连接层稳定失败且上游零请求', async () => {
    // 记录实现的设计决策(「名字型许可以配置钉扎」):许可表按主机名放行时,连接跟随 DNS
    // 解析首项而不复核 IP;攻击面由「名字必须显式进入运维配置」收敛。此行为与 R3 的
    // 「每次 DNS 验证」在地址型许可上由 pinnedLookup 全量复核承担(前一 describe 已验)。
    // 注:上一用例暴露的 lookup 回调形态缺口修复前,名字型目标连接一律失败,本用例尚不能
    // 区分「私网地址不可达」与「回调形态缺陷」;修复后本用例即为私网钉扎的判别性证据。
    // 夹具先行创建(dns spy 尚未安装,listen 的地址解析不得被 mock 污染)。
    const upstream = await startUpstream(() => {
      throw new Error('上游不应被命中');
    });
    mockResolvedAddresses([{ address: '10.1.2.3', family: 4 }]);
    try {
      const nameTargets: readonly LanTarget[] = [{ kind: 'host', host: 'pin-nas.internal' }];
      const result = await newProxyService(withHlsBudgets({ firstByteTimeoutSeconds: 1 })).readPlaylist(
        `http://pin-nas.internal:${upstream.port}/live.m3u8`,
        { allowedTargets: nameTargets },
      );
      // 私网 IP 无监听 → 连接层稳定失败(静态文案),上游零请求
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expectRedactedStatic(result.reason, '名字钉扎私网连接失败 reason');
        expect(result.code).toBe('PLAYBACK_RESOURCE_UNAVAILABLE');
      }
      expect(upstream.seenRequests).toHaveLength(0);
    } finally {
      await upstream.close();
    }
  });

  it('服务层 fail-closed:主机名上游 + 仅 CIDR 许可(即便解析会落在许可网段)→ 服务入口拒绝且上游零请求(服务读取入口不注入 DNS 校验,主机名必须名字型显式许可)', async () => {
    const upstream = await startUpstream(() => {
      throw new Error('上游不应被命中');
    });
    try {
      const cidr: readonly LanTarget[] = [{ kind: 'cidr', family: 4, address: '127.0.0.0', prefixLength: 8 }];
      const result = await newProxyService().readPlaylist(`http://unlisted-nas.internal:${upstream.port}/live.m3u8`, {
        allowedTargets: cidr,
      });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expectRedactedStatic(result.reason, '主机名未许可拒绝 reason');
        expect(result.code).toBe('PLAYBACK_RESOURCE_UNAVAILABLE');
      }
      expect(upstream.seenRequests).toHaveLength(0);
    } finally {
      await upstream.close();
    }
  });
});

/* ------------------------------------------------------------------ */
/* 2. redirect 二跳凭据与 scheme                                         */
/* ------------------------------------------------------------------ */

describe('T036 redirect 二跳凭据与 scheme 处理', () => {
  it('302 二跳请求头聚合断言:Cookie/Authorization/hmp_session/ticket 零出现(与首跳同口径)', async () => {
    const upstream = await startUpstream((req, res) => {
      if (req.url === '/live/r1.m3u8') {
        res.writeHead(302, { location: '/live/r2.m3u8', connection: 'close' });
        res.end();
        return;
      }
      respondText(res, 200, '#EXTM3U\n#EXT-X-TARGETDURATION:4\n#EXTINF:4.0,\nseg.ts\n');
    });
    try {
      const result = await newProxyService().readPlaylist(`${upstream.origin}/live/r1.m3u8`, {
        allowedTargets: LOCAL_TARGETS,
      });
      expect(result.ok, result.ok ? '' : `redirect 链应成功:${result.code} ${result.reason}`).toBe(true);
      expect(upstream.seenRequests.map((seen) => seen.url)).toEqual(['/live/r1.m3u8', '/live/r2.m3u8']);
      upstream.seenRequests.forEach((seen, index) => {
        expectNoAppCredentials(seen.headers, `redirect 第 ${index + 1} 跳 ${seen.url}`);
      });
    } finally {
      await upstream.close();
    }
  });

  it('302 Location 为 https(协议升级)→ scheme 校验放行(http/https 每跳均许可),连接稳定失败而非 scheme 拒绝;上游仅收到首跳', async () => {
    // 行为记录:实现按 R3 仅许可 http(s),跳内不做 https→http 降级限制;
    // 升级目标(127.0.0.1:1 无 TLS 监听)在连接层稳定失败,不透传 Location。
    const upstream = await startUpstream((req, res) => {
      res.writeHead(302, { location: `https://127.0.0.1:1/elsewhere.m3u8`, connection: 'close' });
      res.end();
    });
    try {
      const result = await newProxyService().readPlaylist(`${upstream.origin}/live/upgrade.m3u8`, {
        allowedTargets: LOCAL_TARGETS,
      });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.code).toBe('PLAYBACK_RESOURCE_UNAVAILABLE');
        expectRedactedStatic(result.reason, 'https 升级跳连接失败 reason');
      }
      expect(upstream.seenRequests.map((seen) => seen.url)).toEqual(['/live/upgrade.m3u8']);
    } finally {
      await upstream.close();
    }
  });

  it('302 到未许可私网目标(携带票据形态 query)→ 拒绝且失败 reason 静态:无目标 IP/无票据/无 Location', async () => {
    const upstream = await startUpstream((req, res) => {
      res.writeHead(302, { location: `http://10.255.255.254/secret.m3u8?ticket=${UPSTREAM_TICKET}`, connection: 'close' });
      res.end();
    });
    try {
      const result = await newProxyService().readPlaylist(`${upstream.origin}/live/exfil.m3u8`, {
        allowedTargets: LOCAL_TARGETS,
      });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.code).toBe('PLAYBACK_RESOURCE_UNAVAILABLE');
        expectRedactedStatic(result.reason, 'redirect 私网目标拒绝 reason');
      }
      expect(upstream.seenRequests.map((seen) => seen.url)).toEqual(['/live/exfil.m3u8']);
    } finally {
      await upstream.close();
    }
  });
});

/* ------------------------------------------------------------------ */
/* 3. 嵌套清单 URI 及凭据(三层逐层重写聚合)                              */
/* ------------------------------------------------------------------ */

describe('T036 嵌套清单 URI 及凭据(master→media→media 三层逐层重写)', () => {
  const NEST_BASE = 'http://nest-upstream.example';
  const L0_URL = `${NEST_BASE}/live/master.m3u8`;
  const L1_URL = `${NEST_BASE}/live/hi/playlist.m3u8`;
  const L2_URL = `${NEST_BASE}/deep/playlist.m3u8`;

  const L0_TEXT = [
    '#EXTM3U',
    '#EXT-X-VERSION:6',
    `#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="aud",NAME="en",URI="audio/en.m3u8?ticket=${UPSTREAM_TICKET}"`,
    '#EXT-X-STREAM-INF:BANDWIDTH=2000000,RESOLUTION=1280x720',
    'hi/playlist.m3u8',
    '',
  ].join('\n');

  const L1_TEXT = [
    '#EXTM3U',
    '#EXT-X-VERSION:6',
    '#EXT-X-STREAM-INF:BANDWIDTH=2000000,RESOLUTION=1280x720',
    '../../deep/playlist.m3u8',
    '',
  ].join('\n');

  const L2_TEXT = [
    '#EXTM3U',
    '#EXT-X-TARGETDURATION:4',
    '#EXT-X-MAP:URI="init.mp4"',
    `#EXT-X-KEY:METHOD=AES-128,URI="../keys/key.bin?ticket=${UPSTREAM_TICKET}",IV=0x9c7db8778570d05c3177c349fd9236aa`,
    '#EXTINF:4.0,',
    `seg-0.ts?ticket=${UPSTREAM_TICKET}&sig=abc`,
    '',
  ].join('\n');

  async function rewrite(url: string, text: string, depth: number): Promise<{
    readonly playlist: string;
    readonly assets: readonly { assetId: string; upstreamUrl: string; kind: string }[];
  }> {
    const result = await new PlaybackAssetsService({ budgets: PLAYBACK_BUDGETS }).rewritePlaylist({
      householdId: HOUSEHOLD_ID,
      sessionId: SESSION_ID,
      generation: GENERATION,
      upstreamUrl: url,
      text,
      ticket: TICKET,
      depth,
    });
    expect(result.ok, `第 ${depth} 层重写应成功:${result.ok ? '' : result.code}`).toBe(true);
    if (!result.ok) {
      throw new Error(`期望重写成功,实际失败:${result.code}`);
    }
    return result.value;
  }

  it('三层链式重写:每层 URI 全部同源入口形态;合并输出零上游主机/路径/协议/上游票据', async () => {
    const l0 = await rewrite(L0_URL, L0_TEXT, 0);
    const l1Target = l0.assets.find((asset) => asset.upstreamUrl === L1_URL);
    expect(l1Target, 'L0 应登记 L1 子清单映射').toBeDefined();
    const l1 = await rewrite(L1_URL, L1_TEXT, 1);
    const l2Target = l1.assets.find((asset) => asset.upstreamUrl === L2_URL);
    expect(l2Target, 'L1 相对 ../../ 解析应登记 L2 映射').toBeDefined();
    const l2 = await rewrite(L2_URL, L2_TEXT, 2);

    const combined = [l0.playlist, l1.playlist, l2.playlist].join('\n');
    for (const uri of playlistUris(combined)) {
      expect(uri, `合并输出 URI 应为同源入口形态:${uri}`).toMatch(entryUriRe());
    }
    expect(combined).not.toContain('://');
    for (const marker of ['nest-upstream.example', '/live/', '/deep/', 'hi/playlist', 'audio/en', 'key.bin', 'init.mp4', 'seg-0.ts', UPSTREAM_TICKET]) {
      expect(combined, `合并输出不得含上游痕迹「${marker}」`).not.toContain(marker);
    }
    // 服务端映射保留上游 URL(含 query 票据)供代理取片 —— 仅服务端持有,不下发
    const allAssets = [...l0.assets, ...l1.assets, ...l2.assets];
    expect(allAssets.some((asset) => asset.upstreamUrl.includes(UPSTREAM_TICKET))).toBe(true);
  });

  it('上游 query 内嵌票据形态参数零泄漏:重写输出仅入口 ticket,上游票值全篇零出现(行形态参数化)', async () => {
    // 行形态覆盖:URI 行 query / EXT-X-MEDIA 行内 URI query / EXT-X-KEY URI query
    const upstream = await startUpstream((req, res) => {
      const text = [
        '#EXTM3U',
        '#EXT-X-TARGETDURATION:4',
        '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="a",NAME="en",URI="audio.m3u8?TICKET=UPSTREAM-LEAK-TKT-77"',
        '#EXT-X-KEY:METHOD=AES-128,URI="key.bin?ticket=UPSTREAM-LEAK-TKT-77"',
        '#EXTINF:4.0,',
        'seg-0.ts?ticket=UPSTREAM-LEAK-TKT-77&sig=abc',
        '',
      ].join('\n');
      respondText(res, 200, text);
    });
    try {
      const read = await newProxyService().readPlaylist(`${upstream.origin}/live/media.m3u8`, { allowedTargets: LOCAL_TARGETS });
      expect(read.ok).toBe(true);
      if (!read.ok) {
        throw new Error(`读取应成功:${read.code} ${read.reason}`);
      }
      const rewritten = await rewrite(`${upstream.origin}/live/media.m3u8`, read.value.text, 1);
      expect(rewritten.playlist).not.toContain(UPSTREAM_TICKET);
      expect(rewritten.playlist).not.toContain('sig=abc');
      for (const uri of playlistUris(rewritten.playlist)) {
        const parsed = new URL(uri, 'https://entry.invalid');
        expect([...parsed.searchParams.keys()]).toEqual(['ticket']);
        expect(parsed.searchParams.get('ticket')).toBe(TICKET);
      }
    } finally {
      await upstream.close();
    }
  });
});

/* ------------------------------------------------------------------ */
/* 4. 重写层缺口 [T037/T038]:METHOD=NONE key 行原文透传                   */
/* ------------------------------------------------------------------ */

describe('T036 缺口暴露 [T037/T038]:METHOD=NONE key 行携带 URI 被原文透传(上游 URL 泄漏面)', () => {
  it('EXT-X-KEY / EXT-X-SESSION-KEY METHOD=NONE 携带上游 URI → 重写输出零上游痕迹(缺口的修复形态二选一:剔除 URI 属性或整行拒绝,本断言与修复方式无关)', async () => {
    // RFC 8216:METHOD=NONE 不得携带 URI;当前实现对 METHOD=NONE key 行整行原文透传,
    // 上游 URL(主机/路径/可能内嵌的凭据 query)不经重写直接进入下发给客户端的清单。
    const result = await new PlaybackAssetsService({ budgets: PLAYBACK_BUDGETS }).rewritePlaylist({
      householdId: HOUSEHOLD_ID,
      sessionId: SESSION_ID,
      generation: GENERATION,
      upstreamUrl: 'http://leak-upstream.example/live/media.m3u8',
      text: [
        '#EXTM3U',
        '#EXT-X-TARGETDURATION:4',
        '#EXT-X-KEY:METHOD=NONE,URI="http://leak-upstream.example/keys/key.bin"',
        '#EXT-X-SESSION-KEY:METHOD=NONE,URI="http://leak-upstream.example/session-key.bin"',
        '#EXTINF:4.0,',
        'seg.ts',
        '',
      ].join('\n'),
      ticket: TICKET,
      depth: 1,
    });
    // 安全断言(修复方式无关):要么整行拒绝(ok=false),要么输出不含任何上游 URL 痕迹。
    const leaked = result.ok
      ? result.value.playlist.includes('leak-upstream.example') || result.value.playlist.includes('://')
      : false;
    expect(leaked, '[T037/T038 缺口] METHOD=NONE key 行的上游 URL 经原文透传进入客户端输出').toBe(false);
  });
});

/* ------------------------------------------------------------------ */
/* 5. 脚本注入(清单 URI scheme / 清单行换行标签伪造)                      */
/* ------------------------------------------------------------------ */

describe('T036 脚本注入:清单 URI 非执行 scheme 与标签换行伪造', () => {
  const rewrite = (text: string) =>
    new PlaybackAssetsService({ budgets: PLAYBACK_BUDGETS }).rewritePlaylist({
      householdId: HOUSEHOLD_ID,
      sessionId: SESSION_ID,
      generation: GENERATION,
      upstreamUrl: 'http://inject-upstream.example/live/media.m3u8',
      text,
      ticket: TICKET,
      depth: 1,
    });

  it('URI 含 javascript:/data:text/html/vbscript: → 稳定拒绝,失败 reason 不回显注入串(行形态参数化)', async () => {
    const cases: readonly { readonly name: string; readonly line: string }[] = [
      { name: 'URI 行 javascript:', line: 'javascript:alert(1)' },
      { name: 'URI 行 data:text/html', line: 'data:text/html,<script>alert(1)</script>' },
      { name: 'URI 行 vbscript:', line: 'vbscript:msgbox(1)' },
      { name: 'EXT-X-MEDIA 行内 javascript:', line: '#EXT-X-PLACEHOLDER' },
    ];
    for (const testCase of cases.slice(0, 3)) {
      const text = ['#EXTM3U', '#EXT-X-TARGETDURATION:4', '#EXTINF:4.0,', testCase.line, ''].join('\n');
      const result = await rewrite(text);
      expect(result.ok, `${testCase.name}:应稳定拒绝`).toBe(false);
      if (!result.ok) {
        expect(result.code).toBe('PLAYBACK_FORMAT_UNSUPPORTED');
        expect(result.reason, `${testCase.name}:reason 不回显注入串`).not.toContain(testCase.line.split(':')[0]);
      }
    }
    // EXT-X-MEDIA 行内 URI 形态(标签属性注入)
    const mediaTag = await rewrite(
      ['#EXTM3U', '#EXT-X-TARGETDURATION:4', '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="a",NAME="x",URI="javascript:alert(1)"', '#EXTINF:4.0,', 'seg.ts', ''].join('\n'),
    );
    expect(mediaTag.ok, 'EXT-X-MEDIA 行内 javascript: 应拒绝').toBe(false);
  });

  it('URI 内嵌 #EXTM3U 换行/标签伪造(编码 %0A 与字面 fragment 形态)→ 解析器不执行注入标签:输出仅一个 EXTM3U、零伪造 KEY/STREAM-INF、零注入主机', async () => {
    // 攻击形态:URI 内以编码换行 + 伪造标签文本注入;若实现原样透传或解码换行,
    // 客户端解析器会把注入文本当真实 HLS 标签执行(伪造 AES-128 key 指向攻击者主机)。
    const text = [
      '#EXTM3U',
      '#EXT-X-TARGETDURATION:4',
      '#EXTINF:4.0,',
      'seg-0.ts%0A%23EXTM3U%0A%23EXT-X-KEY:METHOD=AES-128,URI=%22http://evil-inject.example/k%22%0A%23EXT-X-STREAM-INF:BANDWIDTH=1',
      '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="a",NAME="x",URI="audio.ts%0A#EXTM3U%0A%23EXT-X-STREAM-INF:BANDWIDTH=999"',
      '#EXTINF:4.0,',
      'seg-1.ts#EXTM3U',
      '',
    ].join('\n');
    const result = await rewrite(text);
    expect(result.ok, '注入形态清单应按普通 URI 重写成功(或稳定拒绝,不得透传注入)').toBe(true);
    if (!result.ok) {
      throw new Error('期望重写成功');
    }
    const playlist = result.value.playlist;
    expect(playlist.match(/#EXTM3U/g), '全篇仅允许首行一个 EXTM3U').toHaveLength(1);
    expect(playlist).not.toContain('EXT-X-KEY');
    expect(playlist).not.toContain('evil-inject.example');
    expect(playlist.match(/#EXT-X-STREAM-INF/g) ?? []).toHaveLength(0);
    // 注入文本不得以解码/未解码形态存活于输出
    expect(playlist).not.toContain('%23EXTM3U');
    expect(playlist).not.toContain('%0A');
  });
});

/* ------------------------------------------------------------------ */
/* 6. malformed probe(受限 ffprobe;shell 注入面)                        */
/* ------------------------------------------------------------------ */

/** 事件形态假 probe 进程(与 media-probe ProbeProcessHandle 结构面一致) */
class FakeProbeProcess implements ProbeProcessHandle {
  readonly pid = 42424;
  private readonly stdoutListeners: Array<(chunk: string | Uint8Array) => void> = [];
  private readonly stderrListeners: Array<(chunk: string) => void> = [];
  private readonly exitListeners: Array<(code: number | null, signal: string | null) => void> = [];
  kill(): boolean {
    return true;
  }
  on(event: 'stdout', listener: (chunk: string | Uint8Array) => void): ProbeProcessHandle;
  on(event: 'stderr', listener: (chunk: string) => void): ProbeProcessHandle;
  on(event: 'exit', listener: (code: number | null, signal: string | null) => void): ProbeProcessHandle;
  on(event: string, listener: (...args: never[]) => void): ProbeProcessHandle {
    if (event === 'stdout') {
      this.stdoutListeners.push(listener as unknown as (chunk: string | Uint8Array) => void);
    } else if (event === 'stderr') {
      this.stderrListeners.push(listener as unknown as (chunk: string) => void);
    } else if (event === 'exit') {
      this.exitListeners.push(listener as unknown as (code: number | null, signal: string | null) => void);
    }
    return this;
  }
  emitStdout(chunk: string): void {
    for (const listener of [...this.stdoutListeners]) {
      listener(chunk);
    }
  }
  emitExit(code: number): void {
    for (const listener of [...this.exitListeners]) {
      listener(code, null);
    }
  }
}

/** 脚本化假 spawn:记录 argv,按脚本输出 stdout 并退出 */
function scriptedSpawn(stdout: string, exitCode: number, seen: ProbeSpawnRequest[]): MediaProbeSpawn {
  return (request) => {
    seen.push(request);
    const proc = new FakeProbeProcess();
    queueMicrotask(() => {
      proc.emitStdout(stdout);
      proc.emitExit(exitCode);
    });
    return proc;
  };
}

describe('T036 malformed probe(受限 ffprobe:非法 JSON/路径脱敏/argv 注入面)', () => {
  const SECRET_INPUT = '/Volumes/nas/private/secret-input.mp4';

  function probeService(spawn: MediaProbeSpawn): MediaProbeService {
    // 真实时钟(2s 上限):假进程在微任务期退出,超时定时器只是不干扰用例的兜底
    const clock: MediaProbeClock = {
      now: () => Date.now(),
      delay: (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, Math.min(ms, 2000))),
    };
    return new MediaProbeService({ budgets: PLAYBACK_BUDGETS, clock, spawn });
  }

  it('ffprobe stdout 非法 JSON → 稳定失败 PLAYBACK_FORMAT_UNSUPPORTED 不崩溃;失败消息不含输入路径(载荷参数化)', async () => {
    const payloads: readonly { readonly name: string; readonly stdout: string }[] = [
      { name: '纯垃圾文本', stdout: 'not json at all' },
      { name: 'JSON 截断 + 路径字符串', stdout: `{"streams":[${SECRET_INPUT}` },
      { name: '二进制 NUL 形态', stdout: `\u0000\u0001${SECRET_INPUT}\u0002` },
      { name: 'JSON 数组形态(缺 format)', stdout: '[]' },
    ];
    for (const payload of payloads) {
      const seen: ProbeSpawnRequest[] = [];
      const result = await probeService(scriptedSpawn(payload.stdout, 0, seen)).probeFirstAvailable(
        [{ candidateId: 'cand', inputPath: SECRET_INPUT }],
        { atMs: Date.now() + 10_000 },
      );
      expect(result.ok, `${payload.name}:应稳定失败`).toBe(false);
      if (!result.ok) {
        expect(result.code, payload.name).toBe('PLAYBACK_FORMAT_UNSUPPORTED');
        expect(result.detail, `${payload.name}:失败消息不得含输入路径`).not.toContain(SECRET_INPUT);
      }
      expect(seen).toHaveLength(1);
    }
  });

  it('stdout 含输入路径字符串(ffprobe 常态回显 format.filename)→ 事实对象零路径(脱敏)', async () => {
    const stdout = JSON.stringify({
      format: { filename: SECRET_INPUT, format_name: 'mov,mp4,m4a,3gp,3g2,mj2', duration: '2.000' },
      streams: [
        { codec_type: 'video', codec_name: 'h264', pix_fmt: 'yuv420p', width: 640, height: 360, bits_per_raw_sample: '8' },
        { codec_type: 'audio', codec_name: 'aac', tags: { language: 'zh' } },
      ],
    });
    const result = await probeService(scriptedSpawn(stdout, 0, [])).probeFirstAvailable(
      [{ candidateId: 'cand', inputPath: SECRET_INPUT }],
      { atMs: Date.now() + 10_000 },
    );
    expect(result.ok).toBe(true);
    if (!result.ok) {
      throw new Error(`合法 ffprobe JSON 应解析成功:${result.code}`);
    }
    const serialized = JSON.stringify(result.value);
    expect(serialized, '事实对象不得携带输入路径').not.toContain(SECRET_INPUT);
    expect(result.value.container).toBe('mp4');
    expect(result.value.video?.codec).toBe('h264');
    // 行为记录:轨道 label 为容器内文本元数据(tags.title),非日志面,原样保留 ——
    // 与 R6「日志不记录原路径」的边界一致(此处无 title 字段,故零路径)。
  });

  it('probe argv 断言:纯字符串数组、输入路径仅作末参数、协议白名单无网络面、元字符文件名原样传递(无拼接命令面)', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hmp-t036-probe-argv-'));
    try {
      // 文件名含 shell 元字符(; $( ) 反引号 空格):若经 shell 拼接即命令注入
      const weirdName = 'a; $(touch x) ; `ls` ; b.mp4';
      const weirdPath = path.join(root, weirdName);
      fs.writeFileSync(weirdPath, 'x');
      const seen: ProbeSpawnRequest[] = [];
      const result = await probeService(scriptedSpawn(
        JSON.stringify({ format: { filename: weirdPath, format_name: 'mp4', duration: '1' }, streams: [] }),
        0,
        seen,
      )).probeFirstAvailable([{ candidateId: 'cand', inputPath: weirdPath }], { atMs: Date.now() + 10_000 });
      expect(result.ok).toBe(true);
      expect(seen).toHaveLength(1);
      const argv = seen[0]?.argv ?? [];
      expect(argv.every((token) => typeof token === 'string'), 'argv 应为纯字符串数组').toBe(true);
      expect(argv[argv.length - 1]).toBe(weirdPath);
      expect(argv.filter((token) => token.includes(weirdPath)), '路径仅出现一次且为整体单元素(无拼接)').toHaveLength(1);
      const whitelistIndex = argv.indexOf('-protocol_whitelist');
      expect(whitelistIndex).toBeGreaterThan(0);
      expect(argv[whitelistIndex + 1]).toBe('file,crypto');
      expect(argv.join('\u0000'), 'argv 不得引入网络协议面').not.toContain('http');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('probe 输入收敛:NAS 越界/符号链接/形态非法 location 经 resolveNasMediaLocation 全量拒绝(参数化),合法对照通过', async () => {
    const KEY = 't036-probe-root';
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hmp-t036-probe-root-'));
    try {
      fs.mkdirSync(path.join(root, 'media', 'sub'), { recursive: true });
      fs.writeFileSync(path.join(root, 'media', 'x.mp4'), Buffer.from('media'));
      const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'hmp-t036-probe-out-'));
      fs.writeFileSync(path.join(outside, 'secret.mp4'), Buffer.from('secret'));
      fs.symlinkSync(path.join(outside, 'secret.mp4'), path.join(root, 'media', 'link.mp4'));
      fs.symlinkSync(outside, path.join(root, 'media-link-dir'));
      const mediaRoots: MediaRoots = { [KEY]: root };
      const denied: readonly string[] = [
        `${KEY}/../${path.basename(outside)}/secret.mp4`,
        `${KEY}/media/link.mp4`,
        `${KEY}/media-link-dir/secret.mp4`,
        `${KEY}/media/sub/../x.mp4`,
        `${KEY}//media/x.mp4`,
        'unregistered-root/media/x.mp4',
        'http://127.0.0.1/media/x.mp4',
      ];
      for (const location of denied) {
        const resolved = await resolveNasMediaLocation(location, mediaRoots);
        expect(resolved.ok, `probe 输入应拒绝:${location}`).toBe(false);
      }
      const allowed = await resolveNasMediaLocation(`${KEY}/media/x.mp4`, mediaRoots);
      expect(allowed.ok).toBe(true);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

/* ------------------------------------------------------------------ */
/* 6b. 真实 FFmpeg 层:元字符文件名的真实 probe(无 shell 执行)             */
/* ------------------------------------------------------------------ */

function resolveRealBinary(envVar: string, candidates: readonly string[]): string | null {
  const fromEnv = process.env[envVar];
  const ordered = [...(fromEnv ? [fromEnv] : []), ...candidates];
  for (const candidate of ordered) {
    if (fs.existsSync(candidate)) {
      return candidate;
    }
    try {
      const found = execFileSync('which', [candidate], { encoding: 'utf8' }).trim();
      if (found.length > 0 && fs.existsSync(found)) {
        return found;
      }
    } catch {
      // 不在 PATH,继续下一候选
    }
  }
  return null;
}

const REAL_FFMPEG_BIN = resolveRealBinary('HMP_TEST_FFMPEG', ['/opt/homebrew/bin/ffmpeg', '/usr/local/bin/ffmpeg', '/usr/bin/ffmpeg', 'ffmpeg']);
const REAL_FFPROBE_BIN = resolveRealBinary('HMP_TEST_FFPROBE', ['/opt/homebrew/bin/ffprobe', '/usr/local/bin/ffprobe', '/usr/bin/ffprobe', 'ffprobe']);

describe.skipIf(REAL_FFMPEG_BIN === null || REAL_FFPROBE_BIN === null)('T036 真实FFmpeg层:shell 元字符文件名 probe(无 shell 执行证据)', () => {
  const execFileAsync = promisify(execFileCb);
  const INJ1 = 'hmp-t036-pwn1';
  const INJ2 = 'hmp-t036-pwn2';
  const CANARY = 'hmp-t036-canary';
  const homePath = (name: string): string => path.join(os.homedir(), name);
  // 注入文本即文件名(POSIX 文件名禁「/」,故注入体先 cd $HOME 再 touch/rm —— 仅当发生
  // shell 执行时才会创建/删除这些标记;argv 数组路径下它们只是普通字符)
  const VALID_INJECT_NAME = `movie'; cd $HOME; touch ${INJ1}; x'.mp4`;
  const GARBAGE_INJECT_NAME = `broken"; cd $HOME; rm -rf ${CANARY}; touch ${INJ2}; ".bin`;
  let caseDir = '';

  beforeAll(async () => {
    // 防御性清理历史标记(可观察注入只能由本用例制造)
    for (const marker of [INJ1, INJ2, CANARY]) {
      fs.rmSync(homePath(marker), { force: true });
    }
    fs.writeFileSync(homePath(CANARY), 'canary');
    caseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hmp-t036-real-inject-'));
    const sourcePath = path.join(caseDir, 'src.mp4');
    await execFileAsync(
      REAL_FFMPEG_BIN as string,
      ['-y', '-f', 'lavfi', '-i', 'testsrc=duration=0.5:size=160x120:rate=10', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', sourcePath],
    );
    if (!fs.existsSync(sourcePath)) {
      throw new Error('ffmpeg 未产出源文件(环境层失败,非被测行为)');
    }
    fs.copyFileSync(sourcePath, path.join(caseDir, VALID_INJECT_NAME));
    fs.writeFileSync(path.join(caseDir, GARBAGE_INJECT_NAME), Buffer.from('definitely not media'));
    process.env.HMP_FFPROBE_BIN = REAL_FFPROBE_BIN as string;
  }, 20_000);

  afterAll(() => {
    delete process.env.HMP_FFPROBE_BIN;
    for (const marker of [INJ1, INJ2, CANARY]) {
      fs.rmSync(homePath(marker), { force: true });
    }
    if (caseDir !== '') {
      fs.rmSync(caseDir, { recursive: true, force: true });
    }
  });

  it('合法媒体(注入形态文件名)probe 成功 + 垃圾文件(含 rm -rf 形态名)稳定失败;全程零 shell 执行', async () => {
    // 有界真实时钟:真实 ffprobe 亚秒退出;cap 2s 防止悬挂定时器拖住 worker 收尾
    const clock: MediaProbeClock = {
      now: () => Date.now(),
      delay: (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, Math.min(ms, 2000))),
    };
    const service = new MediaProbeService({ budgets: PLAYBACK_BUDGETS, clock });
    const deadline = { atMs: Date.now() + PLAYBACK_BUDGETS.probe.timeoutSeconds * 1000 };

    const valid = await service.probeFirstAvailable(
      [{ candidateId: 'injected-name', inputPath: path.join(caseDir, VALID_INJECT_NAME) }],
      deadline,
    );
    expect(valid.ok, valid.ok ? '' : `合法媒体应 probe 成功:${valid.code}`).toBe(true);
    if (valid.ok) {
      expect(valid.value.container).toBe('mp4');
      expect(valid.value.video?.codec).toBe('h264');
    }

    const garbage = await service.probeFirstAvailable(
      [{ candidateId: 'injected-name', inputPath: path.join(caseDir, GARBAGE_INJECT_NAME) }],
      deadline,
    );
    expect(garbage.ok, '垃圾输入应稳定失败').toBe(false);
    if (!garbage.ok) {
      expect(garbage.code).toBe('PLAYBACK_FORMAT_UNSUPPORTED');
    }

    // 注入证据:任何 shell 执行都会留下/销毁 $HOME 标记
    expect(fs.existsSync(homePath(INJ1)), 'touch 注入标记不得出现(无 shell 执行)').toBe(false);
    expect(fs.existsSync(homePath(INJ2)), '第二 touch 注入标记不得出现(无 shell 执行)').toBe(false);
    expect(fs.existsSync(homePath(CANARY)), 'rm -rf 形态注入不得销毁哨兵文件').toBe(true);
  }, 20_000);
});

/* ------------------------------------------------------------------ */
/* 7. 轨道伪造与资产枚举                                                  */
/* ------------------------------------------------------------------ */

describe('T036 轨道伪造(selection 只接受服务器返回 ID;fail-closed)', () => {
  const FACTS: PlaybackProbeFacts = {
    durationSeconds: 5400,
    audioTracks: [
      { id: 'aud-1', label: '普通话', language: 'zh', default: true },
      { id: 'aud-2', label: 'English', language: 'en', default: false },
    ],
    subtitleTracks: [{ id: 'sub-1', label: '简体中文', language: 'zh-CN' }],
  };

  type SelectionDeps = ConstructorParameters<typeof PlaybackSelectionService>[0];
  /** 单测层直接实例化:伪造判定为纯校验面,不依赖仓储(私有守卫方法直调) */
  function forgedSelectionService(catalogIds: readonly string[] = ['sub-sidecar-1']): PlaybackSelectionService {
    return new PlaybackSelectionService({
      facts: { factsFor: () => FACTS },
      subtitleCatalog: { subtitleTrackIds: () => catalogIds },
    } as unknown as SelectionDeps);
  }

  it('音轨伪造参数化:未探测 ID/伪造词法/大小写变体/注入形态 → 400 PLAYBACK_SELECTION_INVALID;合法对照通过', async () => {
    const service = forgedSelectionService();
    const assertAudio = (service as unknown as {
      assertAudioTrackKnown: (facts: PlaybackProbeFacts, audioTrackId: string) => void;
    }).assertAudioTrackKnown.bind(service);

    const forged: readonly string[] = [
      'aud-999',
      'aud-0',
      'aud-',
      'AUD-1',
      'vid-1',
      'aud-1 ',
      "aud-1'; DROP TABLE playback_session;--",
      'aud-1\u0000extra',
      'aud-18446744073709551616',
    ];
    for (const audioTrackId of forged) {
      let thrown: unknown;
      try {
        assertAudio(FACTS, audioTrackId);
      } catch (error) {
        thrown = error;
      }
      expect(thrown, `伪造音轨应拒绝:${JSON.stringify(audioTrackId)}`).toBeInstanceOf(DomainError);
      const domain = thrown as DomainError;
      expect(domain.status, audioTrackId).toBe(400);
      expect(domain.code, audioTrackId).toBe(ProblemCode.PLAYBACK_SELECTION_INVALID);
    }
    expect(() => assertAudio(FACTS, 'aud-1'), '合法轨道对照:守卫非全拒').not.toThrow();
  });

  it('字幕轨伪造(内嵌 ∪ 旁车词表之外)→ 400;事实缺失 fail-closed → 400 SELECTION_INVALID', async () => {
    const service = forgedSelectionService(['sub-sidecar-1']);
    const assertSubtitle = (service as unknown as {
      assertSubtitleTrackKnown: (sessionId: string, generation: number, facts: PlaybackProbeFacts, subtitleTrackId: string) => Promise<void>;
    }).assertSubtitleTrackKnown.bind(service);

    for (const subtitleTrackId of ['sub-999', 'sub-sidecar-999', 'sub-1 OR 1=1', 'sub-sidecar-1\u0000']) {
      let thrown: unknown;
      try {
        await assertSubtitle(SESSION_ID, GENERATION, FACTS, subtitleTrackId);
      } catch (error) {
        thrown = error;
      }
      expect(thrown, `伪造字幕轨应拒绝:${subtitleTrackId}`).toBeInstanceOf(DomainError);
      expect((thrown as DomainError).status).toBe(400);
      expect((thrown as DomainError).code).toBe(ProblemCode.PLAYBACK_SELECTION_INVALID);
    }
    await expect(assertSubtitle(SESSION_ID, GENERATION, FACTS, 'sub-sidecar-1'), '合法旁车对照通过').resolves.toBeUndefined();

    const failClosed = new PlaybackSelectionService({ facts: { factsFor: () => undefined } } as unknown as SelectionDeps);
    const requireFacts = (failClosed as unknown as {
      requireFactsForSelection: (sessionId: string, session: { generation: number }) => PlaybackProbeFacts;
    }).requireFactsForSelection.bind(failClosed);
    let thrown: unknown;
    try {
      requireFacts(SESSION_ID, { generation: 1 });
    } catch (error) {
      thrown = error;
    }
    expect(thrown, '事实缺失应 fail-closed 拒绝').toBeInstanceOf(DomainError);
    expect((thrown as DomainError).code).toBe(ProblemCode.PLAYBACK_SELECTION_INVALID);
  });

  it('assetId 枚举:五元组(household,session,generation,assetId)之外全部 miss —— 404 同形的统一原料(undefined)', async () => {
    const service = new PlaybackAssetsService({ budgets: PLAYBACK_BUDGETS });
    // 登记前:任何枚举(含入口名 'index')均 miss
    expect(service.resolve(HOUSEHOLD_ID, SESSION_ID, GENERATION, 'index')).toBeUndefined();

    const rewritten = await service.rewritePlaylist({
      householdId: HOUSEHOLD_ID,
      sessionId: SESSION_ID,
      generation: GENERATION,
      upstreamUrl: 'http://enum-upstream.example/live/media.m3u8',
      text: '#EXTM3U\n#EXT-X-TARGETDURATION:4\n#EXTINF:4.0,\nseg.ts\n',
      ticket: TICKET,
      depth: 1,
    });
    expect(rewritten.ok).toBe(true);
    const assetId = rewritten.ok ? rewritten.value.assets[0]?.assetId ?? '' : '';
    expect(assetId).not.toBe('');

    const forgedIds: readonly string[] = [
      'index',
      'a'.repeat(22),
      `${assetId.slice(0, 21)}!`,
      `${assetId}/`,
      `../${assetId}`,
      '',
      `${assetId}?ticket=x`,
      "'; DROP TABLE playback_asset--",
    ];
    for (const forged of forgedIds) {
      expect(service.resolve(HOUSEHOLD_ID, SESSION_ID, GENERATION, forged), `伪造 assetId 应 miss:${forged}`).toBeUndefined();
    }
    // 五元组隔离:同 assetId 跨代/跨会话/跨家庭全部 miss
    expect(service.resolve(HOUSEHOLD_ID, SESSION_ID, GENERATION + 1, assetId)).toBeUndefined();
    expect(service.resolve(HOUSEHOLD_ID, randomUUID(), GENERATION, assetId)).toBeUndefined();
    expect(service.resolve(randomUUID(), SESSION_ID, GENERATION, assetId)).toBeUndefined();
    // 合法命中对照
    expect(service.resolve(HOUSEHOLD_ID, SESSION_ID, GENERATION, assetId)?.upstreamUrl).toContain('enum-upstream.example');
  });
});

/* ------------------------------------------------------------------ */
/* 8. NAS/字幕越界组合(旁车 ../ 越界 + 符号链接 × 授权收紧 + 5MiB 边界)   */
/* ------------------------------------------------------------------ */

const NAS_KEY = 't036-input-root';

const tempDirs: string[] = [];

function registerTempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir !== undefined) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
});

describe('T036 NAS/字幕越界组合(旁车路径穿越与符号链接读取面)', () => {
  it('旁车字幕定位路径含 ../ 或符号链接环节 → 404 同形拒绝,零内容字节(读取面参数化)', async () => {
    const root = registerTempDir('hmp-t036-nas-trav-');
    fs.mkdirSync(path.join(root, 'media'), { recursive: true });
    fs.writeFileSync(path.join(root, 'media', 'movie.srt'), '1\n00:00:01,000 --> 00:00:02,000\nok\n');
    const outside = registerTempDir('hmp-t036-nas-out-');
    fs.writeFileSync(path.join(outside, 'secret.srt'), 'SECRET-SIDECAR');
    fs.symlinkSync(path.join(outside, 'secret.srt'), path.join(root, 'media', 'link.srt'));
    const service = new NasReaderService({ mediaRoots: { [NAS_KEY]: root } });

    const denied: readonly string[] = [
      `${NAS_KEY}/../${path.basename(outside)}/secret.srt`,
      `${NAS_KEY}/media/../${path.basename(outside)}/secret.srt`,
      `${NAS_KEY}/media/link.srt`,
    ];
    for (const location of denied) {
      const opened = await service.openRange(location);
      expect(opened.ok, `字幕读取面应拒绝:${location}`).toBe(false);
      if (!opened.ok) {
        expect(opened.status, location).toBe(404);
        expect(opened.code, location).toBe('MEDIA_NOT_FOUND');
        expect('stream' in opened, '拒绝时零内容流').toBe(false);
        expect(opened.detail, '拒绝 detail 不得含根路径').not.toContain(root);
      }
      const stat = await service.statSource(location);
      expect(stat.ok, `字幕 stat 面应拒绝:${location}`).toBe(false);
    }
  });
});

/* ------------------------------------------------------------------ */
/* 8b. 字幕服务组合 rig(符号链接 × 授权收紧 / 5MiB 边界 / 脚本转义)        */
/* ------------------------------------------------------------------ */

/** 注入 120s 票据 TTL 的预算(与 subtitles.spec 同款) */
function budgetsForTest(): PlaybackBudgets {
  return createPlaybackBudgets(loadEnv({ NODE_ENV: 'test', PLAYBACK_TICKET_TTL_SECONDS: '120' }));
}

const SAMPLE_SRT = ['1', '00:00:01,000 --> 00:00:03,500', 'Hello world', ''].join('\n');

const VOD_FACTS: PlaybackProbeFacts = {
  durationSeconds: 5400,
  audioTracks: [{ id: 'aud-1', label: '普通话', language: 'zh', default: true }],
  subtitleTracks: [{ id: 'sub-1', label: '简体中文', language: 'zh-CN' }],
};

class StaticFactsPort {
  private readonly byKey = new Map<string, PlaybackProbeFacts>();
  seed(sessionId: string, generation: number, facts: PlaybackProbeFacts): void {
    this.byKey.set(`${sessionId}|${generation}`, facts);
  }
  factsFor(sessionId: string, generation: number): PlaybackProbeFacts | undefined {
    return this.byKey.get(`${sessionId}|${generation}`);
  }
}

class FixedLocator implements SubtitleSourceLocator {
  constructor(private readonly location: string | null) {}
  async locate(sessionId: string): Promise<{ readonly location: string } | null> {
    void sessionId;
    return this.location === null ? null : { location: this.location };
  }
}

interface InputSecurityRig {
  dataDir: string;
  rootDir: string;
  mediaDir: string;
  world: PlaybackWorld;
  budgets: PlaybackBudgets;
  context: SessionContext;
  facts: StaticFactsPort;
  service: PlaybackSubtitlesService;
  sessionId: string;
}

const rigs: InputSecurityRig[] = [];

function migrationSql(name: string): string {
  const migrationPath = path.join(process.cwd(), 'src/platform/database/migrations', name, 'up.sql');
  if (!fs.existsSync(migrationPath)) {
    throw new Error(`未找到迁移文件 ${migrationPath} —— 本测试须以 apps/server 为工作目录运行`);
  }
  return fs.readFileSync(migrationPath, 'utf8');
}

async function bootstrapRig(prefix: string, options: { readonly files?: Readonly<Record<string, string | Buffer>> } = {}): Promise<InputSecurityRig> {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const rootDir = path.join(dataDir, 'root');
  const mediaDir = path.join(rootDir, 'media');
  fs.mkdirSync(mediaDir, { recursive: true });
  fs.writeFileSync(path.join(mediaDir, 'movie.mp4'), Buffer.from('fake-media-bytes'));
  for (const [name, content] of Object.entries(options.files ?? {})) {
    if (name.startsWith('link:')) {
      const target = typeof content === 'string' ? content : name;
      fs.symlinkSync(path.resolve(mediaDir, target), path.join(mediaDir, name.slice('link:'.length)));
      continue;
    }
    fs.writeFileSync(path.join(mediaDir, name), content);
  }

  setEnvOverride(loadEnv({ NODE_ENV: 'test', DATA_DIR: dataDir, DB_FILENAME: `${randomUUID()}.hmp.db` }));
  Database.close();
  Database.db.exec('CREATE TABLE IF NOT EXISTS _migrations (name TEXT PRIMARY KEY NOT NULL, applied_at TEXT NOT NULL)');
  // 010 收敛:rig 迁移清单补到 0007(playback 查询面已含 0007 列,如 playback_session.playback_started_at)
  for (const name of ['0001_init', '0002_profile_policy', '0003_media_catalog', '0004_manual_epg_binding', '0005_playback', '0006_pc_experience', '0007_online_vod']) {
    Database.db.transaction(() => {
      Database.db.exec(migrationSql(name));
      Database.db.prepare('INSERT INTO _migrations (name, applied_at) VALUES (?, ?)').run(name, new Date().toISOString());
    })();
  }
  const fakeRig = { app: {} as INestApplication, dataDir, dbFilename: `${randomUUID()}.hmp.db` };
  const world = await seedPlaybackWorld(fakeRig, { nasEnabled: true });
  getDb()
    .insert(profilePolicy)
    .values({
      householdId: world.householdId,
      profileId: world.profileId,
      maxContentLevel: 18,
      allowUnrated: 1,
      allowedMediaIds: '[]',
      blockedMediaIds: '[]',
      allowedChannelIds: '[]',
      version: 1,
      updatedAt: PLAYBACK_FIXTURE_NOW,
    })
    .run();
  const budgets = budgetsForTest();
  const repo = new PlaybackRepository(Database.db, budgets);
  const authorization = new PlaybackAuthorizationService(repo);
  const session = getDb().select().from(deviceSession).where(eq(deviceSession.id, world.deviceSessionId)).get();
  if (session === undefined) {
    throw new Error('夹具错误:device_session 不存在');
  }
  const acc = getDb().select().from(account).where(eq(account.id, world.accountId)).get();
  if (acc === undefined) {
    throw new Error('夹具错误:account 不存在');
  }
  const context: SessionContext = {
    session: {
      id: session.id,
      householdId: session.householdId,
      accountId: session.accountId,
      deviceId: session.deviceId,
      activeProfileId: session.activeProfileId,
      expiresAt: session.expiresAt,
    },
    account: {
      id: acc.id,
      householdId: acc.householdId,
      username: acc.username,
      role: acc.role as SessionContext['account']['role'],
    },
  };

  const facts = new StaticFactsPort();
  const mediaRoots: MediaRoots = { subroot: rootDir };
  const service = new PlaybackSubtitlesService({
    authorization,
    facts,
    locator: new FixedLocator('subroot/media/movie.mp4'),
    nasReader: new NasReaderService({ mediaRoots }),
    mediaRoots,
    budgets,
  });

  const seeded = seedPlaybackSession(world, { state: 'ready', at: PLAYBACK_FIXTURE_NOW });
  facts.seed(seeded.sessionId, 1, VOD_FACTS);

  const rig: InputSecurityRig = {
    dataDir,
    rootDir,
    mediaDir,
    world,
    budgets,
    context,
    facts,
    service,
    sessionId: seeded.sessionId,
  };
  rigs.push(rig);
  return rig;
}

async function cleanupRigs(): Promise<void> {
  while (rigs.length > 0) {
    const rig = rigs.pop();
    if (rig === undefined) {
      break;
    }
    Database.close();
    fs.rmSync(rig.dataDir, { recursive: true, force: true });
  }
}

describe('T036 符号链接字幕 × 授权收紧(组合:伪造 trackId 与策略收紧双层拒绝)', () => {
  afterEach(async () => {
    await cleanupRigs();
  });

  it('符号链接旁车不入列 → 伪造其 trackId 请求 → 404 同形零内容;授权收紧(黑名单)后合法旁车 revalidate 拒 → 404 零内容', async () => {
    // (a) 符号链接旁车:列表层剔除后,伪造 sub-sidecar-1 直接内容请求仍 404(重扫描同拒)
    const symlinkRig = await bootstrapRig('hmp-t036-link-authz-', {
      files: { 'target.srt': SAMPLE_SRT, 'link:movie.srt': 'target.srt' },
    });
    const listed = await symlinkRig.service.listSubtitleTracks(symlinkRig.sessionId, VOD_FACTS);
    expect(listed.filter((track) => track.origin === 'sidecar')).toHaveLength(0);
    let thrown: unknown;
    try {
      await symlinkRig.service.loadSubtitleContent(symlinkRig.sessionId, 1, 'sub-sidecar-1', symlinkRig.context);
    } catch (error) {
      thrown = error;
    }
    expect(thrown, '伪造符号链接旁车 ID 应拒绝').toBeInstanceOf(DomainError);
    expect((thrown as DomainError).status).toBe(404);
    expect((thrown as DomainError).code).toBe(ProblemCode.MEDIA_NOT_FOUND);

    // (b) 合法旁车基线可读 → 策略收紧(黑名单)后 revalidate 拒:404 且内容零返回
    const legitRig = await bootstrapRig('hmp-t036-tight-authz-', { files: { 'movie.srt': SAMPLE_SRT } });
    const baseline = await legitRig.service.loadSubtitleContent(legitRig.sessionId, 1, 'sub-sidecar-1', legitRig.context);
    expect(baseline.vtt).toContain('Hello world');

    const { writePolicyLists } = await import('@contexts/policy/application/policy.service');
    writePolicyLists(legitRig.world.householdId, legitRig.world.profileId, { blockedMediaIds: [legitRig.world.iptv.mediaId] });

    thrown = undefined;
    try {
      await legitRig.service.loadSubtitleContent(legitRig.sessionId, 1, 'sub-sidecar-1', legitRig.context);
    } catch (error) {
      thrown = error;
    }
    expect(thrown, '授权收紧后应 revalidate 拒绝').toBeInstanceOf(DomainError);
    const domain = thrown as DomainError;
    expect(domain.status).toBe(404);
    expect(domain.code).toBe(ProblemCode.MEDIA_NOT_FOUND);
    // 错误载荷零内容泄漏:无字幕文本、无授权根路径
    expect(JSON.stringify({ detail: domain.detail, message: domain.message })).not.toContain('Hello world');
    expect(JSON.stringify({ detail: domain.detail, message: domain.message })).not.toContain(legitRig.rootDir);
  });

  it('5MiB 边界参数化:恰好 maxSidecarBytes → 入列且可加载;+1 字节 → 不入列(R6 旁车预算)', async () => {
    const maxBytes = budgetsForTest().subtitles.maxSidecarBytes;
    const exactRig = await bootstrapRig('hmp-t036-5mib-exact-', {
      files: { 'movie.vtt': Buffer.alloc(maxBytes, 0x61) },
    });
    const exactList = await exactRig.service.listSubtitleTracks(exactRig.sessionId, VOD_FACTS);
    const exactSidecars = exactList.filter((track) => track.origin === 'sidecar');
    expect(exactSidecars.map((track) => track.sidecarFilename)).toEqual(['movie.vtt']);
    const exactContent = await exactRig.service.loadSubtitleContent(exactRig.sessionId, 1, 'sub-sidecar-1', exactRig.context);
    expect(exactContent.contentType).toBe('text/vtt');
    expect(exactContent.vtt.length).toBe(maxBytes);

    const overRig = await bootstrapRig('hmp-t036-5mib-over-', {
      files: { 'movie.vtt': Buffer.alloc(maxBytes + 1, 0x61) },
    });
    const overList = await overRig.service.listSubtitleTracks(overRig.sessionId, VOD_FACTS);
    expect(overList.filter((track) => track.origin === 'sidecar')).toHaveLength(0);
  });

  it('字幕文本脚本注入(service 层):<script>/事件属性/标签形态 → 输出逐行转义,零可执行标记(载荷参数化)', async () => {
    const rig = await bootstrapRig('hmp-t036-subs-xss-', {
      files: {
        'movie.srt': [
          '1',
          '00:00:01,000 --> 00:00:02,000',
          '<script>alert(1)</script>',
          '',
          '2',
          '00:00:03,000 --> 00:00:04,000',
          '<img src=x onerror="alert(1)">',
          '',
          '3',
          '00:00:05,000 --> 00:00:06,000',
          '<a href="javascript:alert(1)">x</a> & <b>y</b>',
          '',
        ].join('\n'),
      },
    });
    const content = await rig.service.loadSubtitleContent(rig.sessionId, 1, 'sub-sidecar-1', rig.context);
    expect(content.contentType).toBe('text/vtt');
    // 输出零未转义标签形态(无任何裸 "<";文本节点中的事件属性随标签一同被转义失效)
    expect(content.vtt, '输出不得含裸 < 标签').not.toContain('<');
    expect(content.vtt).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(content.vtt).toContain('&lt;img src=x onerror=');
    expect(content.vtt).toContain('&amp;');
  });
});

/* ------------------------------------------------------------------ */
/* 9. header 后错误脱敏(错误通道样本 × T012 语义)                        */
/* ------------------------------------------------------------------ */

describe('T036 header 后错误脱敏(hls-proxy 失败通道样本聚合 × T012 工具幂等)', () => {
  it('无上游场景失败 reason 样本:非法 URL/未许可/validateUpstreamHop scheme 拒绝 —— 全部静态脱敏文案', async () => {
    const proxy = newProxyService();
    const samples: { readonly label: string; readonly reason: string }[] = [];
    const read = async (label: string, url: string, targets: readonly LanTarget[] = LOCAL_TARGETS): Promise<void> => {
      const result = await proxy.readPlaylist(url, { allowedTargets: targets });
      expect(result.ok, `${label}:应失败`).toBe(false);
      if (!result.ok) {
        samples.push({ label, reason: result.reason });
      }
    };
    await read('非法 URL', '::not-a-url::');
    await read('未许可 IP(含票据形态 query)', `http://10.9.9.9/live.m3u8?ticket=${UPSTREAM_TICKET}`);
    for (const sample of samples) {
      expectRedactedStatic(sample.reason, `${sample.label} reason`);
    }
    const hopScheme = await validateUpstreamHop('javascript:alert(1)', { allowedTargets: LOCAL_TARGETS });
    expect(hopScheme.ok).toBe(false);
    if (!hopScheme.ok) {
      expectRedactedStatic(hopScheme.reason, 'validateUpstreamHop scheme 拒绝 reason');
    }
  });

  it('有上游场景失败 reason 样本:redirect 超限/上游 5xx/清单超尺寸/首字节前断连 —— 全部静态脱敏文案', async () => {
    const proxy = newProxyService();
    const samples: string[] = [];
    const readExpectFail = async (label: string, url: string, targets: readonly LanTarget[] = LOCAL_TARGETS): Promise<void> => {
      const result = await proxy.readPlaylist(url, { allowedTargets: targets });
      expect(result.ok, `${label}:应失败`).toBe(false);
      if (!result.ok) {
        samples.push(result.reason);
      }
    };

    // redirect 超预算链(4 跳 > maxRedirects 3)
    const chain = await startUpstream((req, res) => {
      const hops: Record<string, string> = { '/x1': '/x2', '/x2': '/x3', '/x3': '/x4', '/x4': '/x5' };
      const target = hops[req.url ?? ''];
      if (target !== undefined) {
        res.writeHead(302, { location: target, connection: 'close' });
        res.end();
        return;
      }
      respondText(res, 200, '#EXTM3U\nEND\n');
    });
    try {
      await readExpectFail('redirect 超限', `${chain.origin}/x1`);
    } finally {
      await chain.close();
    }

    // 上游 5xx
    const erroring = await startUpstream((req, res) => {
      respondText(res, 503, 'upstream broken', 'text/plain');
    });
    try {
      await readExpectFail('上游 5xx', `${erroring.origin}/broken.m3u8`);
    } finally {
      await erroring.close();
    }

    // 清单超尺寸(2MiB+1)
    const oversized = `#EXTM3U\n${'x'.repeat(2 * 1024 * 1024 + 1)}`;
    const big = await startUpstream((req, res) => {
      res.writeHead(200, { 'content-type': 'application/vnd.apple.mpegurl', connection: 'close' });
      res.end(oversized);
    });
    try {
      await readExpectFail('清单超尺寸', `${big.origin}/big.m3u8`);
    } finally {
      await big.close();
    }

    // 首字节前断连(服务端直接销毁连接)
    const abortive = await startUpstream((req, res) => {
      res.destroy();
    });
    try {
      await readExpectFail('首字节前断连', `${abortive.origin}/abort.m3u8`);
    } finally {
      await abortive.close();
    }

    expect(samples.length).toBeGreaterThanOrEqual(4);
    for (const reason of samples) {
      expectRedactedStatic(reason, 'hls-proxy 失败通道 reason');
    }
  });

  it('流中途错误(readAsset 空闲超时通道):error 消息样本不含上游 URL/票据,T012 工具前后零标记', async () => {
    const origin = await startUpstream((req, res) => {
      // 有意把上游 URL 与票据写进响应头外的任何位置都不影响 —— 通道断言的是错误事件消息
      res.writeHead(200, { 'content-type': 'video/mp2t', connection: 'close' });
      res.write(Buffer.alloc(2048, 0x41));
      // 不 end:触发服务端注入的空闲超时
    });
    try {
      const result = await newProxyService(withHlsBudgets({ idleTimeoutSeconds: 1 })).readAsset(`${origin.origin}/live/stall.ts?ticket=${UPSTREAM_TICKET}`, {
        allowedTargets: LOCAL_TARGETS,
        kind: 'segment',
      });
      expect(result.ok, '头部阶段应成功交付(等价 headers 已发)').toBe(true);
      if (!result.ok) {
        throw new Error(`期望读资产成功:${result.code} ${result.reason}`);
      }
      const errorEvents: Error[] = [];
      const sawEnd = await new Promise<boolean>((resolve) => {
        let ended = false;
        result.value.stream.on('error', (error: Error) => {
          errorEvents.push(error);
          resolve(ended);
        });
        result.value.stream.on('end', () => {
          ended = true;
        });
      });
      expect(errorEvents.length, '流中途应收到空闲超时错误').toBeGreaterThan(0);
      expect(sawEnd, '错误后不应正常 end').toBe(false);
      const message = String(errorEvents[0]?.message ?? '');
      expect((errorEvents[0] as NodeJS.ErrnoException).code).toBe('PLAYBACK_RESOURCE_UNAVAILABLE');
      expectRedactedStatic(message, '流中途错误通道 message');
      // 请求 URL 的票据/路径不得经任何错误字段回传
      expect(JSON.stringify({ message, code: (errorEvents[0] as NodeJS.ErrnoException).code })).not.toContain(origin.origin);
    } finally {
      await origin.close();
    }
  });

  it('supervisor 通道语义 × problem+json 渲染:摘要/渲染 detail 均不含本测真实上游 URL、临时根与票据;headersSent 后零注入', () => {
    const upstreamOrigin = 'http://127.0.0.1:54321';
    const tempRoot = os.tmpdir();
    const stderr = [
      `ffmpeg version 8.1.1 Input #0 from '${tempRoot}/secret-source.mp4':`,
      '  Duration: 00:42:05.11, bitrate: 8123 kb/s',
      `  Stream #0:0 Video: hevc (Main 10), yuv420p10le(tv), 3840x2160, 24 fps`,
      `Failed to open segment ${upstreamOrigin}/live/seg-0.ts?ticket=${UPSTREAM_TICKET}`,
      'Conversion failed!',
    ].join('\n');

    // supervisor 失败事件的技术摘要面(T012 契约):只含稳定码 + 白名单关键字
    const summary = summarizeFfmpegStderr(stderr, 'PLAYBACK_FORMAT_UNSUPPORTED');
    expect(summary).toContain('PLAYBACK_FORMAT_UNSUPPORTED');
    expect(summary).toContain('hevc');
    for (const secret of [tempRoot, 'secret-source', upstreamOrigin, UPSTREAM_TICKET, 'http://', 'Conversion failed']) {
      expect(summary, `摘要不得含「${secret}」`).not.toContain(secret);
    }
    expect(summary).not.toContain('\n');

    // problem+json 渲染面:以实现真实失败 reason 为 detail 的 DomainError,渲染后零泄漏
    interface RecordingResponse {
      res: Response;
      headers: Map<string, string>;
      statuses: number[];
      bodies: unknown[];
    }
    const render = (exception: unknown, overrides: Partial<Record<string, unknown>> = {}): RecordingResponse => {
      const headers = new Map<string, string>();
      const statuses: number[] = [];
      const bodies: unknown[] = [];
      const res = {
        status(code: number) {
          statuses.push(code);
          return res;
        },
        setHeader(name: string, value: string) {
          headers.set(name, value);
          return res;
        },
        json(body: unknown) {
          bodies.push(body);
          return res;
        },
        ...overrides,
      } as unknown as Response;
      const host = {
        switchToHttp: () => ({
          getRequest: () => undefined,
          getResponse: () => res,
          getNext: () => undefined,
        }),
      } as unknown as ArgumentsHost;
      expect(() => new ProblemJsonFilter().catch(exception, host)).not.toThrow();
      return { res, headers, statuses, bodies };
    };

    const failureReason = '上游连接失败或首字节超时';
    const rendered = render(new DomainError(503, ProblemCode.PLAYBACK_RESOURCE_UNAVAILABLE, failureReason));
    expect(rendered.statuses).toEqual([503]);
    const body = rendered.bodies[0] as Record<string, unknown>;
    expect(body.code).toBe('PLAYBACK_RESOURCE_UNAVAILABLE');
    expect(String(body.detail)).not.toMatch(/https?:\/\/|\//);
    expect(String(body.detail)).not.toContain(UPSTREAM_TICKET);

    // 流后边界(headersSent)聚合:错误不再写任何响应面
    const afterHeaders = render(new DomainError(503, ProblemCode.PLAYBACK_RESOURCE_UNAVAILABLE, failureReason), { headersSent: true });
    expect(afterHeaders.statuses).toHaveLength(0);
    expect(afterHeaders.headers.size).toBe(0);
    expect(afterHeaders.bodies).toHaveLength(0);
  });
});

/* ------------------------------------------------------------------ */
/* 10. 上游请求无应用认证(聚合恒等断言)                                  */
/* ------------------------------------------------------------------ */

describe('T036 上游请求无应用认证(readPlaylist/readAsset/redirect 二跳全量聚合)', () => {
  it('hls-proxy 构造的全部出站请求头恒无 Cookie/Authorization/hmp_session/ticket(请求形态参数化)', async () => {
    const segment = Buffer.alloc(2048, 0x41);
    const key = Buffer.from('0123456789abcdef', 'utf8');
    const upstream = await startUpstream((req, res) => {
      if (req.url === '/live/media.m3u8') {
        respondText(res, 200, '#EXTM3U\n#EXT-X-TARGETDURATION:4\n#EXTINF:4.0,\nseg.ts\n');
        return;
      }
      if (req.url === '/live/seg.ts') {
        res.writeHead(200, { 'content-type': 'video/mp2t', 'content-length': String(segment.length), connection: 'close' });
        res.end(segment);
        return;
      }
      if (req.url === '/live/key.bin') {
        res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': String(key.length), connection: 'close' });
        res.end(key);
        return;
      }
      if (req.url === '/live/r1.m3u8') {
        res.writeHead(302, { location: '/live/r2.m3u8', connection: 'close' });
        res.end();
        return;
      }
      respondText(res, 200, '#EXTM3U\nAFTER-REDIRECT\n');
    });
    const proxy = newProxyService();
    try {
      const playlist = await proxy.readPlaylist(`${upstream.origin}/live/media.m3u8`, { allowedTargets: LOCAL_TARGETS });
      expect(playlist.ok).toBe(true);
      const asset = await proxy.readAsset(`${upstream.origin}/live/seg.ts`, { allowedTargets: LOCAL_TARGETS, kind: 'segment' });
      expect(asset.ok).toBe(true);
      if (asset.ok) {
        await collect(asset.value.stream);
      }
      const keyRead = await proxy.readAsset(`${upstream.origin}/live/key.bin`, { allowedTargets: LOCAL_TARGETS, kind: 'key' });
      expect(keyRead.ok).toBe(true);
      if (keyRead.ok) {
        await collect(keyRead.value.stream);
      }
      const redirected = await proxy.readPlaylist(`${upstream.origin}/live/r1.m3u8`, { allowedTargets: LOCAL_TARGETS });
      expect(redirected.ok).toBe(true);
      expect(redirected.ok ? redirected.value.text : '').toContain('AFTER-REDIRECT');

      // 覆盖 5 个出站请求(含 redirect 二跳):逐请求凭据恒等断言
      expect(upstream.seenRequests).toHaveLength(5);
      upstream.seenRequests.forEach((seen, index) => {
        expectNoAppCredentials(seen.headers, `出站请求 #${index + 1} (${seen.url})`);
      });
    } finally {
      await upstream.close();
    }
  });
});
