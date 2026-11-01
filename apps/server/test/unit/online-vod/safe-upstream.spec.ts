import type { Readable } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createControlledMediaServer,
  createManualClock,
  type ControlledMediaServer,
  type ControlledRouteSpec,
  type ManualClock,
} from '../../fixtures';
import { IMPORT_BUDGETS } from '@platform/config/import-budgets';
import type { LanTarget } from '@platform/config/env.schema';
import { VOD_BUDGETS } from '@contexts/online-vod/domain/vod-budgets';
import {
  ABORTED,
  BUDGET_EXCEEDED,
  DEFAULT_IMPORT_UPSTREAM_TIME_BUDGETS,
  DNS_INVALID,
  IDLE_TIMEOUT,
  REDIRECT_LIMIT,
  RemoteReadFailure,
  TARGET_DENIED,
  createNestedBudgetLedger,
  createSafeUpstreamService,
  openRemoteSource,
  readBounded,
  readNestedLevel,
  type RemoteDnsResolver,
} from '@platform/upstream/safe-upstream-reader';
import {
  SAFE_UPSTREAM_PORT,
  VOD_SAFE_UPSTREAM_BUDGETS,
  VOD_SAFE_UPSTREAM_NESTED_BUDGETS,
  type SafeUpstreamErrorCode,
  type SafeUpstreamPort,
  type UpstreamNestedBudgets,
} from '@platform/upstream/safe-upstream.port';
// 旧 sources 路径:适配后必须保持行为与导出兼容(回归对照面)
import {
  openRemoteSource as legacyOpenRemoteSource,
  RemoteReadFailure as LegacyRemoteReadFailure,
} from '@contexts/sources/infrastructure/safe-http-reader';

/**
 * 010 T018 — platform 层可复用有界安全读取(SafeUpstreamPort / safe-upstream-reader):
 *
 * - 协议白名单:仅 http/https,其他协议一律拒绝且零请求;
 * - DNS:解析为环回/链路本地/云元数据/未指定/多播等拒绝类别默认拒绝(允许列表为空
 *   = 默认拒绝;RFC1918 私网地址由部署精确许可列表默认拒绝);每跳重新解析全部
 *   A/AAAA(重解析防护:跳间 DNS 翻转/混入非法地址即拒绝);
 * - 每跳 redirect 都重走完整校验,默认拒内网延续到跳后;
 * - AbortSignal:已中止立即拒绝,中途中止销毁连接;
 * - 字节预算:超限中止连接(BUDGET_EXCEEDED);嵌套预算(manifest→variant→segment→key)
 *   各级上限与总量、总时限由 NestedBudgetLedger 记账;
 * - 超时:空闲/总时长预算可注入,缺省 = IMPORT 传输预算(旧 sources 行为不变);
 * - 场景形态:CMS JSON、probe 清单、key、片段、测速(有界诊断读);
 * - 预算镜像:platform 不得导入 online-vod(R4),VOD 缺省预算镜像 VOD_BUDGETS,
 *   由本文件对照锁定;
 * - 旧 sources 行为回归:直接 import 旧路径对照(薄委托后同函数、同语义)。
 *
 * mock 层:注入 DNS stub(recordingResolver/queueResolver)与 127.0.0.1 受控夹具
 * (精确 hostPort 许可),不发真实网络请求。
 */

const servers: ControlledMediaServer[] = [];

async function startServer(
  routes: ControlledRouteSpec[] = [],
  clock?: ManualClock,
): Promise<ControlledMediaServer> {
  const server = await createControlledMediaServer({ routes, clock });
  servers.push(server);
  return server;
}

/** 测试专用精确许可:夹具绑定 127.0.0.1 随机端口,逐测试以 hostPort 注入 */
function allowFixture(port: number): readonly LanTarget[] {
  return [{ kind: 'hostPort', host: '127.0.0.1', port }];
}

/** 收集整个流(读取器不解压、不改写) */
function collect(stream: Readable): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    stream.on('data', (chunk: Buffer) => chunks.push(chunk));
    stream.on('end', () => resolve(Buffer.concat(chunks)));
    stream.on('error', reject);
  });
}

/** 断言 promise 以 RemoteReadFailure(code) 拒绝,返回该错误供消息断言 */
async function expectFailure(run: Promise<unknown>, code: SafeUpstreamErrorCode | string): Promise<RemoteReadFailure> {
  try {
    await run;
  } catch (error) {
    expect(error).toBeInstanceOf(RemoteReadFailure);
    const failure = error as RemoteReadFailure;
    expect(failure.code).toBe(code);
    return failure;
  }
  throw new Error(`期望以 ${code} 拒绝,实际成功结束`);
}

/** 记录调用次数的 DNS stub:固定解析结果(回环夹具地址) */
function recordingResolver(result: string[] = ['127.0.0.1']): RemoteDnsResolver & {
  calls4: string[];
  calls6: string[];
} {
  const calls4: string[] = [];
  const calls6: string[] = [];
  return {
    calls4,
    calls6,
    resolve4: async (hostname: string) => {
      calls4.push(hostname);
      return result;
    },
    resolve6: async (hostname: string) => {
      calls6.push(hostname);
      return [];
    },
  };
}

/** 按调用序返回不同结果的 DNS stub(跳间 DNS 翻转/重解析防护场景);末位结果兜底 */
function queueResolver(results: readonly string[][]): RemoteDnsResolver & { calls4: string[] } {
  const calls4: string[] = [];
  let index = 0;
  return {
    calls4,
    resolve4: async (hostname: string) => {
      calls4.push(hostname);
      const value = results[Math.min(index, results.length - 1)] ?? [];
      index += 1;
      return [...value];
    },
    resolve6: async () => [],
  };
}

afterEach(async () => {
  for (const server of servers.splice(0)) {
    await server.close();
  }
});

/* ------------------------------------------------------------------ */
/* 协议白名单                                                          */
/* ------------------------------------------------------------------ */

describe('safe-upstream(T018):协议白名单', () => {
  it.each([
    ['ftp', 'ftp://127.0.0.1:21/manifest.m3u8'],
    ['file', 'file:///etc/hosts'],
    ['data', 'data:text/plain,hello'],
    ['javascript', 'javascript:alert(1)'],
  ])('拒绝 %s: 协议外的目标一律 TARGET_DENIED 且零请求', async (_scheme, targetUrl) => {
    const server = await startServer([{ path: '/manifest.m3u8', kind: 'body', body: 'x' }]);
    const failure = await expectFailure(
      openRemoteSource(targetUrl, { allowedTargets: allowFixture(server.port) }),
      TARGET_DENIED,
    );
    expect(server.requestCount('/manifest.m3u8')).toBe(0);
    expect(failure.message).not.toContain('/manifest.m3u8');
  });

  it('合法 URL 解析失败(非 URL 文本)拒绝且不回显原文', async () => {
    await expectFailure(openRemoteSource('not-a-url', { allowedTargets: allowFixture(1) }), TARGET_DENIED);
  });

  it('http 夹具地址在精确许可内可打开(白名单正向形态;https 走同一校验通路)', async () => {
    const server = await startServer([{ path: '/a.m3u8', kind: 'body', body: '#EXTM3U\n', contentType: 'application/vnd.apple.mpegurl' }]);
    const read = await readBounded(`${server.baseUrl}/a.m3u8`, { allowedTargets: allowFixture(server.port) });
    expect(read.bytes.toString('utf8')).toBe('#EXTM3U\n');
    expect(read.contentType).toBe('application/vnd.apple.mpegurl');
  });
});

/* ------------------------------------------------------------------ */
/* DNS 类别默认拒绝与重解析防护                                         */
/* ------------------------------------------------------------------ */

describe('safe-upstream(T018):DNS 解析类别默认拒绝', () => {
  it('允许列表为空(缺省)= 默认拒绝,且不发出请求', async () => {
    const server = await startServer([{ path: '/m.m3u8', kind: 'body', body: 'x' }]);
    const failure = await expectFailure(
      openRemoteSource(`${server.baseUrl}/m.m3u8`, { allowedTargets: [] }),
      TARGET_DENIED,
    );
    expect(server.requestCount('/m.m3u8')).toBe(0);
    expect(failure.message).not.toContain('/m.m3u8');
  });

  it.each([
    ['IPv4 环回(字面量)', 'http://127.0.0.1:1/m.m3u8'],
    ['IPv6 环回(字面量)', 'http://[::1]:1/m.m3u8'],
    ['IPv4 链路本地', 'http://169.254.10.1/m.m3u8'],
    ['IPv6 链路本地', 'http://[fe80::1]/m.m3u8'],
    ['云元数据', 'http://169.254.169.254/latest/meta-data/'],
    ['IPv4 多播(保留段)', 'http://224.0.0.1/m.m3u8'],
    ['IPv6 多播', 'http://[ff02::1]/m.m3u8'],
    ['IPv4 未指定', 'http://0.0.0.0:1/m.m3u8'],
    ['IPv6 未指定', 'http://[::]/m.m3u8'],
    ['IPv4-mapped IPv6 写法', 'http://[::ffff:127.0.0.1]:1/m.m3u8'],
  ])('拒绝类别地址(%s):许可非空但不匹配,拒绝发生在连接前', async (_label, targetUrl) => {
    const server = await startServer([{ path: '/m.m3u8', kind: 'body', body: 'x' }]);
    await expectFailure(
      openRemoteSource(targetUrl, { allowedTargets: allowFixture(server.port) }),
      TARGET_DENIED,
    );
    expect(server.requestCount('/m.m3u8')).toBe(0);
  });

  it('DNS 解析为 RFC1918 私网地址:未列入部署精确许可即拒绝(默认拒内网),零请求', async () => {
    const server = await startServer([{ path: '/m.m3u8', kind: 'body', body: 'x' }]);
    const resolver = recordingResolver(['10.120.0.8']);
    await expectFailure(
      openRemoteSource(`http://nas.vod.test:${server.port}/m.m3u8`, {
        allowedTargets: allowFixture(server.port),
        resolver,
      }),
      TARGET_DENIED,
    );
    expect(resolver.calls4).toEqual(['nas.vod.test']);
    expect(server.requestCount('/m.m3u8')).toBe(0);
  });

  it('DNS 解析为环回集合:无精确主机名许可即拒绝', async () => {
    const server = await startServer([{ path: '/m.m3u8', kind: 'body', body: 'x' }]);
    const resolver = recordingResolver(['127.0.0.1']);
    await expectFailure(
      openRemoteSource(`http://rebind.vod.test:${server.port}/m.m3u8`, {
        allowedTargets: allowFixture(server.port),
        resolver,
      }),
      TARGET_DENIED,
    );
    expect(server.requestCount('/m.m3u8')).toBe(0);
  });

  it('DNS 混合解析(合法+非法混存)一律拒绝,解析发生但绝不连接', async () => {
    const server = await startServer([{ path: '/m.m3u8', kind: 'body', body: 'x' }]);
    const resolver = recordingResolver(['203.0.113.10', '127.0.0.1']);
    await expectFailure(
      openRemoteSource(`http://mixed.vod.test:${server.port}/m.m3u8`, {
        allowedTargets: [{ kind: 'hostPort', host: 'mixed.vod.test', port: server.port }],
        resolver,
      }),
      TARGET_DENIED,
    );
    expect(resolver.calls4).toEqual(['mixed.vod.test']);
    expect(server.requestCount('/m.m3u8')).toBe(0);
  });

  it('解析失败/解析结果为空按 DNS_INVALID 拒绝', async () => {
    const server = await startServer([{ path: '/m.m3u8', kind: 'body', body: 'x' }]);
    const failing: RemoteDnsResolver = {
      resolve4: () => Promise.reject(new Error('resolver down')),
      resolve6: async () => [],
    };
    await expectFailure(
      openRemoteSource(`http://down.vod.test:${server.port}/m.m3u8`, {
        allowedTargets: [{ kind: 'hostPort', host: 'down.vod.test', port: server.port }],
        resolver: failing,
      }),
      DNS_INVALID,
    );
    const empty: RemoteDnsResolver = { resolve4: async () => [], resolve6: async () => [] };
    await expectFailure(
      openRemoteSource(`http://down.vod.test:${server.port}/m.m3u8`, {
        allowedTargets: [{ kind: 'hostPort', host: 'down.vod.test', port: server.port }],
        resolver: empty,
      }),
      DNS_INVALID,
    );
    expect(server.requestCount('/m.m3u8')).toBe(0);
  });

  it('重解析防护:两次独立读取各自重新解析,DNS 翻转为拒绝类别后第二次拒绝', async () => {
    const server = await startServer([{ path: '/m.m3u8', kind: 'body', body: 'x' }]);
    // 翻转为「未指定地址」:该类别无单播连接语义,即使主机名获精确许可也不放行
    const resolver = queueResolver([['127.0.0.1'], ['0.0.0.0']]);
    const targets: readonly LanTarget[] = [{ kind: 'host', host: 'flip.vod.test' }];
    const first = await readBounded(`http://flip.vod.test:${server.port}/m.m3u8`, {
      allowedTargets: targets,
      resolver,
    });
    expect(first.bytes.toString('utf8')).toBe('x');
    await expectFailure(
      readBounded(`http://flip.vod.test:${server.port}/m.m3u8`, { allowedTargets: targets, resolver }),
      TARGET_DENIED,
    );
    // 不缓存解析结果:每次读取都重走解析与校验
    expect(resolver.calls4).toEqual(['flip.vod.test', 'flip.vod.test']);
  });
});

/* ------------------------------------------------------------------ */
/* 每跳 redirect 重新校验                                               */
/* ------------------------------------------------------------------ */

describe('safe-upstream(T018):每跳 redirect 重新校验', () => {
  it('预算内重定向链逐跳放行:redirectsFollowed/finalUrl 如实上报', async () => {
    const server = await startServer([
      { path: '/chain', kind: 'redirectChain', hops: 3, targetPath: '/final' },
      { path: '/final', kind: 'body', body: 'final-payload', contentType: 'text/plain' },
    ]);
    const source = await openRemoteSource(`${server.baseUrl}/chain`, {
      allowedTargets: allowFixture(server.port),
      timeBudgets: { totalTimeoutMs: 30_000, idleTimeoutMs: 15_000, maxRedirects: 3 },
    });
    expect(source.redirectsFollowed).toBe(3);
    expect(source.finalUrl).toBe(`${server.baseUrl}/final`);
    expect((await collect(source.stream)).toString('utf8')).toBe('final-payload');
    await source.close();
    expect(server.requestCount('/chain')).toBe(1);
    expect(server.requestCount('/final')).toBe(1);
  });

  it('重定向到未许可目标(含内网):每跳重新校验,目标侧零请求', async () => {
    const denied = await startServer([{ path: '/secret', kind: 'body', body: 'nope' }]);
    const allowed = await startServer([]);
    allowed.setRoute('/jump', {
      kind: 'raw',
      respond: ({ res }) => {
        res.writeHead(302, { location: `${denied.baseUrl}/secret` });
        res.end();
      },
    });
    const failure = await expectFailure(
      openRemoteSource(`${allowed.baseUrl}/jump`, { allowedTargets: allowFixture(allowed.port) }),
      TARGET_DENIED,
    );
    expect(allowed.requestCount('/jump')).toBe(1);
    expect(denied.requestCount('/secret')).toBe(0);
    expect(failure.message).not.toContain('/secret');
  });

  it('重定向跳数超预算(注入 maxRedirects=1):REDIRECT_LIMIT,最终目标零请求', async () => {
    const server = await startServer([
      { path: '/chain', kind: 'redirectChain', hops: 2, targetPath: '/final' },
      { path: '/final', kind: 'body', body: 'nope' },
    ]);
    await expectFailure(
      openRemoteSource(`${server.baseUrl}/chain`, {
        allowedTargets: allowFixture(server.port),
        timeBudgets: { totalTimeoutMs: 30_000, idleTimeoutMs: 15_000, maxRedirects: 1 },
      }),
      REDIRECT_LIMIT,
    );
    expect(server.requestCount('/final')).toBe(0);
  });

  it('重解析防护:重定向跳保留原主机名并重新解析全部 A/AAAA,跳间翻转为混合解析即拒绝', async () => {
    const hostName = 'cdn.vod.test';
    const server = await startServer([{ path: '/final', kind: 'body', body: 'x' }]);
    server.setRoute('/chain', {
      kind: 'raw',
      respond: ({ res }) => {
        res.writeHead(302, { location: `http://${hostName}:${server.port}/final` });
        res.end();
      },
    });
    const resolver = queueResolver([['127.0.0.1'], ['127.0.0.1', '203.0.113.10']]);
    await expectFailure(
      openRemoteSource(`http://${hostName}:${server.port}/chain`, {
        allowedTargets: [{ kind: 'host', host: hostName }],
        resolver,
      }),
      TARGET_DENIED,
    );
    // 首跳与重定向跳各自重新解析(每族=跳数),第二跳「合法+非法混存」被拒后 /final 零请求
    expect(resolver.calls4).toEqual([hostName, hostName]);
    expect(server.requestCount('/final')).toBe(0);
  });
});

/* ------------------------------------------------------------------ */
/* AbortSignal                                                          */
/* ------------------------------------------------------------------ */

describe('safe-upstream(T018):AbortSignal', () => {
  it('已中止的 signal 立即拒绝(ABORTED)且不发请求', async () => {
    const server = await startServer([{ path: '/hang', kind: 'hang' }]);
    const controller = new AbortController();
    controller.abort();
    await expectFailure(
      openRemoteSource(`${server.baseUrl}/hang`, { allowedTargets: allowFixture(server.port), signal: controller.signal }),
      ABORTED,
    );
    expect(server.requestCount('/hang')).toBe(0);
  });

  it('中途外部中止:ABORTED 并销毁连接(挂起响应清零)', async () => {
    const server = await startServer([{ path: '/hang', kind: 'hang' }]);
    const controller = new AbortController();
    const pending = openRemoteSource(`${server.baseUrl}/hang`, {
      allowedTargets: allowFixture(server.port),
      signal: controller.signal,
    });
    await vi.waitUntil(() => server.pendingResponseCount() === 1);
    controller.abort();
    await expectFailure(pending, ABORTED);
    await vi.waitUntil(() => server.pendingResponseCount() === 0);
    expect(server.pendingResponseCount()).toBe(0);
  });

  it('流式阶段中止:失败经流 error 通道传播', async () => {
    const clock = createManualClock();
    const server = await startServer([], clock);
    server.setRoute('/trickle', {
      kind: 'raw',
      respond: async ({ res }) => {
        res.writeHead(200, { 'content-type': 'text/plain' });
        while (!res.destroyed) {
          res.write('tick');
          await clock.delay(10_000);
        }
      },
    });
    const controller = new AbortController();
    const source = await openRemoteSource(`${server.baseUrl}/trickle`, {
      allowedTargets: allowFixture(server.port),
      clock,
      signal: controller.signal,
    });
    const expectation = expectFailure(collect(source.stream), ABORTED);
    await vi.waitUntil(() => server.requestCount('/trickle') === 1);
    await clock.advance(10_000);
    await new Promise((resolve) => setTimeout(resolve, 5));
    controller.abort();
    await expectation;
  });
});

/* ------------------------------------------------------------------ */
/* 字节预算与超时                                                       */
/* ------------------------------------------------------------------ */

describe('safe-upstream(T018):字节预算', () => {
  it('响应体超过字节上限:读侧 BUDGET_EXCEEDED 并中止连接', async () => {
    const server = await startServer([{ path: '/large.m3u8', kind: 'large', bytes: 256 * 1024 }]);
    const source = await openRemoteSource(`${server.baseUrl}/large.m3u8`, {
      allowedTargets: allowFixture(server.port),
      maxBytes: 64 * 1024,
    });
    await expectFailure(collect(source.stream), BUDGET_EXCEEDED);
    expect(server.requestCount('/large.m3u8')).toBe(1);
    expect(server.pendingResponseCount()).toBe(0);
  });

  it('预算内读取完整返回;readBounded 超限拒绝(截断不以部分体冒充成功)', async () => {
    const body = Buffer.alloc(1024, 0x61);
    const server = await startServer([{ path: '/seg.ts', kind: 'body', body, contentType: 'video/mp2t' }]);
    const within = await readBounded(`${server.baseUrl}/seg.ts`, {
      allowedTargets: allowFixture(server.port),
      maxBytes: 1024,
    });
    expect(within.bytes.equals(body)).toBe(true);
    await expectFailure(
      readBounded(`${server.baseUrl}/seg.ts`, { allowedTargets: allowFixture(server.port), maxBytes: 1023 }),
      BUDGET_EXCEEDED,
    );
  });
});

describe('safe-upstream(T018):超时(注入时钟,无真实等待)', () => {
  it('空闲超过注入 idleTimeoutMs:IDLE_TIMEOUT', async () => {
    const clock = createManualClock();
    const server = await startServer([{ path: '/slow', kind: 'slow', delayMs: 800 }], clock);
    const pending = openRemoteSource(`${server.baseUrl}/slow`, {
      allowedTargets: allowFixture(server.port),
      clock,
      timeBudgets: { totalTimeoutMs: 120_000, idleTimeoutMs: 200, maxRedirects: 3 },
    });
    await vi.waitUntil(() => server.pendingResponseCount() === 1);
    const realStart = Date.now();
    await clock.advance(201);
    const failure = await expectFailure(pending, IDLE_TIMEOUT);
    expect(Date.now() - realStart).toBeLessThan(2_000);
    expect(failure.message).not.toContain('/slow');
  });

  it('持续有数据不触发空闲,总时长超过注入 totalTimeoutMs:流 error 通道 BUDGET_EXCEEDED', async () => {
    const clock = createManualClock();
    const server = await startServer([], clock);
    server.setRoute('/trickle', {
      kind: 'raw',
      respond: async ({ res }) => {
        res.writeHead(200, { 'content-type': 'text/plain' });
        while (!res.destroyed) {
          res.write('tick');
          await clock.delay(10_000);
        }
      },
    });
    const source = await openRemoteSource(`${server.baseUrl}/trickle`, {
      allowedTargets: allowFixture(server.port),
      clock,
      timeBudgets: { totalTimeoutMs: 50_000, idleTimeoutMs: 15_000, maxRedirects: 3 },
    });
    const expectation = expectFailure(collect(source.stream), BUDGET_EXCEEDED);
    await vi.waitUntil(() => server.requestCount('/trickle') === 1);
    for (let step = 0; step < 6; step += 1) {
      await clock.advance(10_000);
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    await expectation;
  });
});

/* ------------------------------------------------------------------ */
/* 嵌套预算(manifest→variant→segment→key)                              */
/* ------------------------------------------------------------------ */

describe('safe-upstream(T018):嵌套预算(各级与总量)', () => {
  const NESTED: UpstreamNestedBudgets = {
    perLevelMaxBytes: { manifest: 64, variant: 64, segment: 1024, key: 16 },
    totalMaxBytes: 512,
    totalTimeoutMs: 60_000,
  };

  it('各级预算独立生效:单级超限即 BUDGET_EXCEEDED,总预算内成功链记账累计', async () => {
    const server = await startServer([
      { path: '/manifest.m3u8', kind: 'body', body: Buffer.alloc(50, 0x6d) },
      { path: '/variant.m3u8', kind: 'body', body: Buffer.alloc(60, 0x76) },
      { path: '/seg-0.ts', kind: 'body', body: Buffer.alloc(200, 0x73) },
      { path: '/enc.key', kind: 'body', body: Buffer.alloc(16, 0x6b) },
    ]);
    const ledger = createNestedBudgetLedger(NESTED);
    const targets = allowFixture(server.port);
    const manifest = await readNestedLevel(ledger, 'manifest', `${server.baseUrl}/manifest.m3u8`, { allowedTargets: targets });
    expect(manifest.bytes.length).toBe(50);
    const variant = await readNestedLevel(ledger, 'variant', `${server.baseUrl}/variant.m3u8`, { allowedTargets: targets });
    expect(variant.bytes.length).toBe(60);
    const segment = await readNestedLevel(ledger, 'segment', `${server.baseUrl}/seg-0.ts`, { allowedTargets: targets });
    expect(segment.bytes.length).toBe(200);
    const key = await readNestedLevel(ledger, 'key', `${server.baseUrl}/enc.key`, { allowedTargets: targets });
    expect(key.bytes.length).toBe(16);
    expect(ledger.spentBytes).toBe(50 + 60 + 200 + 16);
    expect(ledger.remainingBytes).toBe(512 - (50 + 60 + 200 + 16));

    // 单级上限:variant 级 >64 字节的响应被拒
    server.setRoute('/variant-big.m3u8', { kind: 'body', body: Buffer.alloc(65, 0x76) });
    await expectFailure(
      readNestedLevel(ledger, 'variant', `${server.baseUrl}/variant-big.m3u8`, { allowedTargets: targets }),
      BUDGET_EXCEEDED,
    );
    await ledger.dispose();
  });

  it('总量预算:下一级读取按「总量-已记账」剩余额度截断,失败不计账不冒充成功', async () => {
    const server = await startServer([
      { path: '/manifest.m3u8', kind: 'body', body: Buffer.alloc(50, 0x6d) },
      { path: '/seg-1.ts', kind: 'body', body: Buffer.alloc(500, 0x73) },
    ]);
    const ledger = createNestedBudgetLedger(NESTED);
    const targets = allowFixture(server.port);
    await readNestedLevel(ledger, 'manifest', `${server.baseUrl}/manifest.m3u8`, { allowedTargets: targets });
    expect(ledger.remainingBytes).toBe(462);
    // segment 级上限 1024 内,但剩余总量只剩 462:按剩余额度拒绝
    await expectFailure(
      readNestedLevel(ledger, 'segment', `${server.baseUrl}/seg-1.ts`, { allowedTargets: targets }),
      BUDGET_EXCEEDED,
    );
    expect(ledger.spentBytes).toBe(50); // 失败读取不计账
    await ledger.dispose();
  });

  it('charge 超总量返回 false 并中止 ledger.signal;中止后读取以 ABORTED 拒绝', async () => {
    const ledger = createNestedBudgetLedger(NESTED);
    expect(ledger.charge(256)).toBe(true);
    expect(ledger.charge(255)).toBe(true);
    expect(ledger.signal.aborted).toBe(false);
    expect(ledger.charge(2)).toBe(false); // 256+255+2 > 512
    expect(ledger.signal.aborted).toBe(true);
    await expectFailure(
      readNestedLevel(ledger, 'key', 'http://127.0.0.1:1/enc.key', { allowedTargets: [{ kind: 'host', host: '127.0.0.1' }] }),
      ABORTED,
    );
    await ledger.dispose();
  });

  it('嵌套总时限:注入时钟推进到期后 ledger.signal 中止,读取 ABORTED;dispose 清计时', async () => {
    const clock = createManualClock();
    const ledger = createNestedBudgetLedger({ ...NESTED, totalTimeoutMs: 100 }, { clock });
    await clock.advance(101);
    expect(ledger.signal.aborted).toBe(true);
    await ledger.dispose();

    const ledger2 = createNestedBudgetLedger({ ...NESTED, totalTimeoutMs: 100 }, { clock });
    await clock.advance(50);
    expect(ledger2.signal.aborted).toBe(false);
    await ledger2.dispose();
    await clock.advance(1_000);
    // dispose 后计时取消:不再中止
    expect(ledger2.signal.aborted).toBe(false);
  });
});

/* ------------------------------------------------------------------ */
/* 场景形态:CMS / probe / key / 片段 / 测速                             */
/* ------------------------------------------------------------------ */

describe('safe-upstream(T018):场景形态', () => {
  it('CMS 搜索:JSON 全量有界读取(contentType/finalUrl 元数据透传)', async () => {
    const payload = JSON.stringify({ code: 1, list: [{ vod_id: 1, vod_name: '剧集' }] });
    const server = await startServer([
      { path: '/api.php/provide/vod', kind: 'body', body: payload, contentType: 'application/json' },
    ]);
    const service = createSafeUpstreamService({
      allowedTargets: allowFixture(server.port),
      timeBudgets: {
        totalTimeoutMs: VOD_SAFE_UPSTREAM_BUDGETS.totalTimeoutMs,
        idleTimeoutMs: VOD_SAFE_UPSTREAM_BUDGETS.idleTimeoutMs,
        maxRedirects: VOD_SAFE_UPSTREAM_BUDGETS.maxRedirects,
      },
    });
    const url = `${server.baseUrl}/api.php/provide/vod`;
    const read = await service.read({ url, byteBudget: VOD_SAFE_UPSTREAM_BUDGETS.maxBytes });
    expect(JSON.parse(read.bytes.toString('utf8'))).toEqual({ code: 1, list: [{ vod_id: 1, vod_name: '剧集' }] });
    expect(read.contentType).toBe('application/json');
    expect(read.finalUrl).toBe(url);
    expect(read.redirectsFollowed).toBe(0);
  });

  it('CMS 详情跨一跳重定向:redirectsFollowed 与 finalUrl 供详情读取溯源', async () => {
    const server = await startServer([
      { path: '/detail', kind: 'redirect', location: '/detail-final' },
      { path: '/detail-final', kind: 'body', body: '{"vod_id":9}', contentType: 'application/json' },
    ]);
    const read = await readBounded(`${server.baseUrl}/detail`, {
      allowedTargets: allowFixture(server.port),
      maxBytes: VOD_SAFE_UPSTREAM_BUDGETS.maxBytes,
    });
    expect(read.redirectsFollowed).toBe(1);
    expect(read.finalUrl).toBe(`${server.baseUrl}/detail-final`);
    expect(JSON.parse(read.bytes.toString('utf8'))).toEqual({ vod_id: 9 });
  });

  it('probe:小体积清单全量读取(CT 透传)', async () => {
    const manifest = '#EXTM3U\n#EXT-X-VERSION:3\n#EXTINF:4,\nseg-0.ts\n';
    const server = await startServer([
      { path: '/index.m3u8', kind: 'body', body: manifest, contentType: 'application/vnd.apple.mpegurl' },
    ]);
    const read = await readBounded(`${server.baseUrl}/index.m3u8`, {
      allowedTargets: allowFixture(server.port),
      maxBytes: 64 * 1024,
    });
    expect(read.bytes.toString('utf8')).toBe(manifest);
    expect(read.contentType).toBe('application/vnd.apple.mpegurl');
  });

  it('key:AES-128 identity key 按级别预算读取(恰好 16 字节;超小预算拒绝)', async () => {
    const key = Buffer.from([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15]);
    const server = await startServer([{ path: '/enc.key', kind: 'body', body: key, contentType: 'application/octet-stream' }]);
    const read = await readBounded(`${server.baseUrl}/enc.key`, {
      allowedTargets: allowFixture(server.port),
      maxBytes: 16,
    });
    expect(read.bytes.equals(key)).toBe(true);
    await expectFailure(
      readBounded(`${server.baseUrl}/enc.key`, { allowedTargets: allowFixture(server.port), maxBytes: 8 }),
      BUDGET_EXCEEDED,
    );
  });

  it('片段:流式受控读取,close() 语义干净(单请求,无重试)', async () => {
    const segment = Buffer.alloc(64 * 1024, 0x74);
    const server = await startServer([{ path: '/seg-0.ts', kind: 'body', body: segment, contentType: 'video/mp2t' }]);
    const source = await openRemoteSource(`${server.baseUrl}/seg-0.ts`, {
      allowedTargets: allowFixture(server.port),
      maxBytes: 128 * 1024,
    });
    expect((await collect(source.stream)).equals(segment)).toBe(true);
    expect(source.contentType).toBe('video/mp2t');
    await source.close();
    expect(server.requestCount('/seg-0.ts')).toBe(1);
  });

  it('测速:有界诊断读——只取头部样本即关闭,不取全量、不超预算', async () => {
    const server = await startServer([{ path: '/speed', kind: 'large', bytes: 256 * 1024 }]);
    const source = await openRemoteSource(`${server.baseUrl}/speed`, {
      allowedTargets: allowFixture(server.port),
      maxBytes: VOD_SAFE_UPSTREAM_BUDGETS.maxBytes,
    });
    let sampled = 0;
    await new Promise<void>((resolve, reject) => {
      source.stream.on('data', (chunk: Buffer) => {
        sampled += chunk.length;
        if (sampled >= 16 * 1024) {
          source.stream.destroy();
          resolve();
        }
      });
      source.stream.on('error', reject);
    });
    expect(sampled).toBeGreaterThanOrEqual(16 * 1024);
    expect(sampled).toBeLessThanOrEqual(VOD_SAFE_UPSTREAM_BUDGETS.maxBytes);
    await source.close();
    expect(server.requestCount('/speed')).toBe(1);
    expect(server.pendingResponseCount()).toBe(0);
  });

  it('端口缺省形态:未给许可列表的服务默认拒绝(装配兜底,而非 TypeError)', async () => {
    const server = await startServer([{ path: '/m.m3u8', kind: 'body', body: 'x' }]);
    const service: SafeUpstreamPort = createSafeUpstreamService();
    expect(typeof SAFE_UPSTREAM_PORT).toBe('symbol');
    await expectFailure(service.open({ url: `${server.baseUrl}/m.m3u8` }), TARGET_DENIED);
    expect(server.requestCount('/m.m3u8')).toBe(0);
  });
});

/* ------------------------------------------------------------------ */
/* T083 增量:经 HTTP 面的端到端形态(SSRF/预算的跨面组合)                 */
/* ------------------------------------------------------------------ */

/**
 * 010 T083 增量(只补「经 HTTP 面」形态,不重复上方已钉的 SafeUpstream 内部):
 * 既有 52 例钉了协议/DNS/每跳/内网/Abort/字节/嵌套/场景形态的内部语义;本段补
 * 「真实 socket 上逐跳组合」的端到端形态 —— 同主机跨端口 pivot、Location 携带
 * userinfo/跨协议 scheme、非 2xx 终态透传(分类权归场景层)、嵌套预算 × 重定向链
 * 组合记账、零字节响应 —— 全部在受控夹具上完成,零真实网络。
 */
describe('safe-upstream(T083 增量):经 HTTP 面的端到端形态', () => {
  it('同主机跨端口重定向 pivot:许可仅精确到 hostPort,跳向未许可端口即 TARGET_DENIED 且目标端口零请求', async () => {
    // 两台受控服务:仅 P1 在许可内;P1 的路由 302 跳向 P2(同主机不同端口)——
    // 跨端口 pivot 是 SSRF 常见通路,许可必须逐跳精确到端口
    const pivotTarget = await startServer([{ path: '/secret.m3u8', kind: 'body', body: '#EXTM3U\n' }]);
    const pivotEntry = await startServer([]);
    pivotEntry.setRoute('/jump', {
      kind: 'raw',
      respond: ({ res }) => {
        res.writeHead(302, { location: `${pivotTarget.baseUrl}/secret.m3u8` });
        res.end();
      },
    });
    const failure = await expectFailure(
      openRemoteSource(`${pivotEntry.baseUrl}/jump`, { allowedTargets: allowFixture(pivotEntry.port) }),
      TARGET_DENIED,
    );
    expect(pivotEntry.requestCount('/jump')).toBe(1);
    expect(pivotTarget.requestCount('/secret.m3u8')).toBe(0);
    expect(failure.message).not.toContain('/secret.m3u8');
  });

  it('Location 携带 userinfo:逐跳按 host 校验,凭据不转发到下游跳(请求零 Authorization)', async () => {
    const server = await startServer([]);
    let seenAuthorization: string | undefined = 'not-called';
    let seenUrlUserinfo = false;
    server.setRoute('/final', {
      kind: 'raw',
      respond: ({ req, res, url }) => {
        seenAuthorization = req.headers.authorization;
        seenUrlUserinfo = url.username !== '' || url.password !== '';
        res.writeHead(200, { 'content-type': 'text/plain' });
        res.end('hop-ok');
      },
    });
    const entry = await startServer([]);
    entry.setRoute('/chain', {
      kind: 'raw',
      respond: ({ res }) => {
        // Location 内嵌 userinfo:主机/端口仍为许可目标,凭据不是放行依据
        res.writeHead(302, { location: `http://user:pass@127.0.0.1:${server.port}/final` });
        res.end();
      },
    });
    const source = await openRemoteSource(`${entry.baseUrl}/chain`, {
      // 首跳与重定向跳各需精确许可(entry 与 final 是两台受控服务的端口)
      allowedTargets: [...allowFixture(entry.port), ...allowFixture(server.port)],
    });
    expect((await collect(source.stream)).toString('utf8')).toBe('hop-ok');
    await source.close();
    expect(seenAuthorization, 'userinfo 凭据不得转为 Authorization 转发').toBeUndefined();
    expect(seenUrlUserinfo, '下游跳请求 URL 不得携带 userinfo').toBe(false);
  });

  it('Location 跨协议 scheme(ftp):逐跳重走协议白名单,TARGET_DENIED 且目标零请求', async () => {
    const entry = await startServer([]);
    entry.setRoute('/to-ftp', {
      kind: 'raw',
      respond: ({ res }) => {
        res.writeHead(302, { location: 'ftp://127.0.0.1:21/manifest.m3u8' });
        res.end();
      },
    });
    const failure = await expectFailure(
      openRemoteSource(`${entry.baseUrl}/to-ftp`, { allowedTargets: allowFixture(entry.port) }),
      TARGET_DENIED,
    );
    expect(entry.requestCount('/to-ftp')).toBe(1);
    expect(failure.message).not.toContain('manifest.m3u8');
  });

  it('非 2xx 终态响应(404/500)按受控流原样透传:读取器不解释状态码,分类权归场景层(probe/CMS 判 incompatible/unavailable 的证据面)', async () => {
    const server = await startServer([
      { path: '/missing.m3u8', kind: 'body', body: 'no route payload', contentType: 'application/vnd.apple.mpegurl', status: 404 },
      { path: '/boom.m3u8', kind: 'body', body: 'upstream exploded', contentType: 'text/plain', status: 500 },
    ]);
    const notFound = await readBounded(`${server.baseUrl}/missing.m3u8`, {
      allowedTargets: allowFixture(server.port),
      maxBytes: 1024,
    });
    // 404 + mpegurl 自认 + 体非 #EXTM3U:正是装配面判 incompatible 的输入形态
    expect(notFound.bytes.toString('utf8')).toBe('no route payload');
    expect(notFound.contentType).toBe('application/vnd.apple.mpegurl');
    const serverError = await readBounded(`${server.baseUrl}/boom.m3u8`, {
      allowedTargets: allowFixture(server.port),
      maxBytes: 1024,
    });
    expect(serverError.bytes.toString('utf8')).toBe('upstream exploded');
    expect(serverError.contentType).toBe('text/plain');
  });

  it('零字节响应(0 字节 manifest):读取成功且 bytes 为空,不虚构内容不报错(空体分类归场景层)', async () => {
    const server = await startServer([{ path: '/empty.m3u8', kind: 'empty' }]);
    const read = await readBounded(`${server.baseUrl}/empty.m3u8`, {
      allowedTargets: allowFixture(server.port),
      maxBytes: 1024,
    });
    expect(read.bytes.length).toBe(0);
    expect(read.bytes.toString('utf8')).toBe('');
  });

  it('嵌套预算 × 重定向链组合:manifest 级读取经 2 跳重定向到达,跨跳记账只计最终体且各级上限独立生效', async () => {
    const NESTED: UpstreamNestedBudgets = {
      perLevelMaxBytes: { manifest: 64, variant: 64, segment: 1024, key: 16 },
      totalMaxBytes: 512,
      totalTimeoutMs: 60_000,
    };
    const server = await startServer([
      { path: '/hop-2', kind: 'redirect', location: '/final-manifest' },
      { path: '/hop-1', kind: 'redirect', location: '/hop-2' },
      { path: '/final-manifest', kind: 'body', body: Buffer.alloc(50, 0x6d), contentType: 'application/vnd.apple.mpegurl' },
      { path: '/big-final', kind: 'body', body: Buffer.alloc(80, 0x6d), contentType: 'application/vnd.apple.mpegurl' },
    ]);
    const ledger = createNestedBudgetLedger(NESTED);
    const targets = allowFixture(server.port);
    const read = await readNestedLevel(ledger, 'manifest', `${server.baseUrl}/hop-1`, { allowedTargets: targets });
    // 重定向跳体(空)不计账,只计最终 manifest 体;redirectsFollowed 如实上报
    expect(read.bytes.length).toBe(50);
    expect(read.redirectsFollowed).toBe(2);
    expect(read.finalUrl).toBe(`${server.baseUrl}/final-manifest`);
    expect(ledger.spentBytes).toBe(50);
    // 跳后最终体超 manifest 级上限:仍按级别预算拒绝(重定向不放宽级别账)
    await expectFailure(
      readNestedLevel(ledger, 'manifest', `${server.baseUrl}/big-final`, { allowedTargets: targets }),
      BUDGET_EXCEEDED,
    );
    expect(ledger.spentBytes, '失败读取不计账').toBe(50);
    await ledger.dispose();
  });
});

/* ------------------------------------------------------------------ */
/* 预算缺省镜像(R4:platform 不导入 online-vod,镜像由本文件锁定)        */
/* ------------------------------------------------------------------ */

describe('safe-upstream(T018):VOD 预算缺省镜像 VOD_BUDGETS', () => {
  it('VOD_SAFE_UPSTREAM_BUDGETS 数值逐一对照 VOD_BUDGETS 契约值', () => {
    expect(VOD_SAFE_UPSTREAM_BUDGETS.totalTimeoutMs).toBe(VOD_BUDGETS.preview.totalTimeoutMs);
    expect(VOD_SAFE_UPSTREAM_BUDGETS.totalTimeoutMs).toBe(VOD_BUDGETS.search.totalTimeoutMs);
    expect(VOD_SAFE_UPSTREAM_BUDGETS.maxBytes).toBe(VOD_BUDGETS.preview.maxBytes);
    expect(VOD_SAFE_UPSTREAM_BUDGETS.maxBytes).toBe(VOD_BUDGETS.detail.maxBytes);
  });

  it('VOD 嵌套预算缺省:各级/总量/总时限均锚定预览契约值', () => {
    expect(VOD_SAFE_UPSTREAM_NESTED_BUDGETS.perLevelMaxBytes.manifest).toBe(VOD_BUDGETS.preview.maxBytes);
    expect(VOD_SAFE_UPSTREAM_NESTED_BUDGETS.perLevelMaxBytes.variant).toBe(VOD_BUDGETS.preview.maxBytes);
    expect(VOD_SAFE_UPSTREAM_NESTED_BUDGETS.perLevelMaxBytes.segment).toBe(VOD_BUDGETS.preview.maxBytes);
    expect(VOD_SAFE_UPSTREAM_NESTED_BUDGETS.perLevelMaxBytes.key).toBe(VOD_BUDGETS.detail.maxBytes);
    expect(VOD_SAFE_UPSTREAM_NESTED_BUDGETS.totalMaxBytes).toBe(VOD_BUDGETS.preview.maxBytes);
    expect(VOD_SAFE_UPSTREAM_NESTED_BUDGETS.totalTimeoutMs).toBe(VOD_BUDGETS.preview.totalTimeoutMs);
  });

  it('IMPORT 传输预算缺省 = IMPORT_BUDGETS(旧 sources 行为不变的缺省面)', () => {
    expect(DEFAULT_IMPORT_UPSTREAM_TIME_BUDGETS.totalTimeoutMs).toBe(IMPORT_BUDGETS.NET_TOTAL_BUDGET_MS);
    expect(DEFAULT_IMPORT_UPSTREAM_TIME_BUDGETS.idleTimeoutMs).toBe(IMPORT_BUDGETS.NET_IDLE_TIMEOUT_MS);
    expect(DEFAULT_IMPORT_UPSTREAM_TIME_BUDGETS.maxRedirects).toBe(IMPORT_BUDGETS.NET_MAX_REDIRECTS);
  });
});

/* ------------------------------------------------------------------ */
/* 旧 sources 路径回归(适配后行为不变)                                  */
/* ------------------------------------------------------------------ */

describe('safe-upstream(T018):旧 sources 行为回归', () => {
  it('旧路径为薄委托:同一函数/同一错误类(无复制漂移),IMPORT 缺省预算一致', () => {
    expect(legacyOpenRemoteSource).toBe(openRemoteSource);
    expect(LegacyRemoteReadFailure).toBe(RemoteReadFailure);
    expect(DEFAULT_IMPORT_UPSTREAM_TIME_BUDGETS.totalTimeoutMs).toBe(IMPORT_BUDGETS.NET_TOTAL_BUDGET_MS);
  });

  it('旧语义保留:空许可默认拒绝、message 脱敏、零请求', async () => {
    const server = await startServer([{ path: '/playlist.m3u', kind: 'm3u', content: '#EXTM3U\n' }]);
    const failure = await expectFailure(
      legacyOpenRemoteSource(`${server.baseUrl}/playlist.m3u`, { allowedTargets: [] }),
      'SOURCE_TARGET_DENIED',
    );
    expect(server.requestCount('/playlist.m3u')).toBe(0);
    expect(failure.message).not.toContain('/playlist.m3u');
    expect(failure.message).toContain('127.0.0.1');
  });

  it('旧语义保留:精确许可读取 m3u,内容/CT 透传且凭据不转发', async () => {
    const m3u = '#EXTM3U\n#EXTINF:-1,CCTV-1\nhttp://user:pass@192.168.8.10:9981/cctv1\n';
    let seenAuthorization: string | undefined = 'not-called';
    const server = await startServer([]);
    server.setRoute('/playlist.m3u', {
      kind: 'raw',
      respond: ({ req, res }) => {
        seenAuthorization = req.headers.authorization;
        res.writeHead(200, { 'content-type': 'audio/x-mpegurl' });
        res.end(m3u);
      },
    });
    const source = await legacyOpenRemoteSource(`http://127.0.0.1:${server.port}/playlist.m3u`, {
      allowedTargets: allowFixture(server.port),
    });
    expect((await collect(source.stream)).toString('utf8')).toBe(m3u);
    expect(source.contentType).toBe('audio/x-mpegurl');
    await source.close();
    expect(seenAuthorization).toBeUndefined();
    expect(server.requestCount('/playlist.m3u')).toBe(1);
  });

  it('旧语义保留:每跳重新解析并连接已验证 IP,重定向跳保留原主机名', async () => {
    const hostName = 'legacy.lan.test';
    const server = await startServer([{ path: '/final', kind: 'm3u', content: '#EXTM3U\n' }]);
    // Location 显式保留原主机名(redirectChain 夹具会绝对化为 127.0.0.1,不适用本场景)
    server.setRoute('/chain', {
      kind: 'raw',
      respond: ({ res }) => {
        res.writeHead(302, { location: `http://${hostName}:${server.port}/final` });
        res.end();
      },
    });
    const resolver = recordingResolver();
    const source = await legacyOpenRemoteSource(`http://${hostName}:${server.port}/chain`, {
      allowedTargets: [{ kind: 'hostPort', host: hostName, port: server.port }],
      resolver,
    });
    expect((await collect(source.stream)).toString('utf8')).toContain('#EXTM3U');
    await source.close();
    // 两跳(首跳+重定向跳)各自重新解析 A/AAAA
    expect(resolver.calls4).toEqual([hostName, hostName]);
    expect(server.requestCount('/final')).toBe(1);
  });

  it('旧语义保留:maxBytes 超限 BUDGET_EXCEEDED 并中止连接', async () => {
    const server = await startServer([{ path: '/large.m3u', kind: 'large', bytes: 256 * 1024 }]);
    const source = await legacyOpenRemoteSource(`${server.baseUrl}/large.m3u`, {
      allowedTargets: allowFixture(server.port),
      maxBytes: 64 * 1024,
    });
    await expectFailure(collect(source.stream), 'SOURCE_BUDGET_EXCEEDED');
    expect(server.pendingResponseCount()).toBe(0);
  });
});
