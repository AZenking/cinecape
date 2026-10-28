import zlib from 'node:zlib';
import type { Readable } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  buildM3u,
  buildXmltv,
  createControlledMediaServer,
  createManualClock,
  type ControlledMediaServer,
  type ControlledRouteSpec,
  type ManualClock,
} from '../../fixtures';
import { IMPORT_BUDGETS } from '@platform/config/import-budgets';
import type { LanTarget } from '@platform/config/env.schema';
import {
  ABORTED,
  BUDGET_EXCEEDED,
  DNS_INVALID,
  IDLE_TIMEOUT,
  REDIRECT_LIMIT,
  RemoteReadFailure,
  TARGET_DENIED,
  openRemoteSource,
  type RemoteDnsResolver,
} from '@contexts/sources/infrastructure/safe-http-reader';

/**
 * T014:SSRF 安全受控 HTTP 读取器(research R3 权威语义):
 * - 拒绝 loopback/link-local(含云元数据)/unspecified/multicast/IPv4-mapped IPv6;
 * - 允许列表为空默认拒绝;测试以 hostPort 条目精确注入夹具地址(测试专用精确许可,
 *   不禁用类别校验);
 * - DNS 解析多地址混入非法地址拒绝;每跳重新解析全部 A/AAAA 并连接固定已验证 IP;
 * - 手动重定向 ≤IMPORT_BUDGETS.NET_MAX_REDIRECTS 且每跳重新校验;
 *   不发请求体、失败不重试(拒绝发生在连接之前,以夹具 requestCount=0 证明);
 * - 预算:NET_IDLE_TIMEOUT_MS 空闲/NET_TOTAL_BUDGET_MS 总时长/调用方注入 maxBytes,
 *   注入时钟(M manual clock)驱动推进,外部 AbortSignal 可取消;
 * - 凭据 URL 的 userinfo 不转发、错误信息不回显。
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

/** 收集整个流(读取器不解压,这里也不做任何转码) */
function collect(stream: Readable): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    stream.on('data', (chunk: Buffer) => chunks.push(chunk));
    stream.on('end', () => resolve(Buffer.concat(chunks)));
    stream.on('error', reject);
  });
}

/** 断言 promise 以 RemoteReadFailure(code) 拒绝,返回该错误供消息断言 */
async function expectFailure(run: Promise<unknown>, code: string): Promise<RemoteReadFailure> {
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

/** 记录调用次数的测试 resolver:解析到夹具地址(回环),可切换翻转行为 */
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

afterEach(async () => {
  for (const server of servers.splice(0)) {
    await server.close();
  }
});

describe('safe-http-reader(T014/T021):拒绝类', () => {
  it('允许列表为空时任何目标拒绝(默认拒绝),且不发出请求', async () => {
    const server = await startServer([{ path: '/playlist.m3u', kind: 'm3u', content: '#EXTM3U\n' }]);
    const failure = await expectFailure(
      openRemoteSource(`${server.baseUrl}/playlist.m3u`, { allowedTargets: [] }),
      TARGET_DENIED,
    );
    // 拒绝发生在连接之前:不发请求体、不重试
    expect(server.requestCount('/playlist.m3u')).toBe(0);
    expect(failure.message).not.toContain('/playlist.m3u');
  });

  it.each([
    ['IPv4 loopback(127.0.0.1)', 'http://127.0.0.1:1/playlist.m3u'],
    ['IPv6 loopback(::1)', 'http://[::1]:1/playlist.m3u'],
    ['IPv4 link-local(169.254.x)', 'http://169.254.10.1/playlist.m3u'],
    ['IPv6 link-local(fe80::)', 'http://[fe80::1]/playlist.m3u'],
    ['IPv4 unspecified(0.0.0.0)', 'http://0.0.0.0:1/playlist.m3u'],
    ['IPv6 unspecified(::)', 'http://[::]/playlist.m3u'],
    ['IPv4 multicast(224.0.0.1)', 'http://224.0.0.1/playlist.m3u'],
    ['IPv6 multicast(ff02::1)', 'http://[ff02::1]/playlist.m3u'],
    ['云元数据(169.254.169.254)', 'http://169.254.169.254/latest/meta-data/'],
  ])('拒绝%s:允许列表非空但不匹配,拒绝来自类别校验', async (_label, targetUrl) => {
    // 用夹具端口条目充当「非空但不匹配」的许可列表,证明拒绝由类别引擎给出
    const server = await startServer([{ path: '/playlist.m3u', kind: 'm3u', content: '#EXTM3U\n' }]);
    await expectFailure(
      openRemoteSource(targetUrl, { allowedTargets: allowFixture(server.port) }),
      TARGET_DENIED,
    );
    expect(server.requestCount('/playlist.m3u')).toBe(0);
  });

  it('拒绝非 http/https 协议', async () => {
    await expectFailure(openRemoteSource('ftp://127.0.0.1:21/x', { allowedTargets: [] }), TARGET_DENIED);
  });

  it('拒绝 IPv4-mapped IPv6:规范化后命中拒绝类别,同一目标的明文写法在列表内也不放行映射写法', async () => {
    const server = await startServer([{ path: '/playlist.m3u', kind: 'm3u', content: '#EXTM3U\n' }]);
    const failure = await expectFailure(
      openRemoteSource(`http://[::ffff:127.0.0.1]:${server.port}/playlist.m3u`, {
        allowedTargets: allowFixture(server.port),
      }),
      TARGET_DENIED,
    );
    expect(server.requestCount('/playlist.m3u')).toBe(0);
    // message 不回显完整 URL(不含路径)
    expect(failure.message).not.toContain('/playlist.m3u');
  });

  it('拒绝 DNS 多地址混入非法地址(混合非法解析),且不建立连接', async () => {
    const server = await startServer([{ path: '/playlist.m3u', kind: 'm3u', content: '#EXTM3U\n' }]);
    const resolver = recordingResolver(['203.0.113.10', '127.0.0.1']);
    await expectFailure(
      openRemoteSource(`http://playlist.lan.test:${server.port}/playlist.m3u`, {
        allowedTargets: [{ kind: 'hostPort', host: 'playlist.lan.test', port: server.port }],
        resolver,
      }),
      TARGET_DENIED,
    );
    // 解析发生了,但校验失败后绝不连接
    expect(resolver.calls4).toEqual(['playlist.lan.test']);
    expect(resolver.calls6).toEqual(['playlist.lan.test']);
    expect(server.requestCount('/playlist.m3u')).toBe(0);
  });

  it('主机名未列入许可列表时拒绝且不连接', async () => {
    const server = await startServer([{ path: '/playlist.m3u', kind: 'm3u', content: '#EXTM3U\n' }]);
    const resolver = recordingResolver();
    await expectFailure(
      openRemoteSource(`http://unlisted.lan.test:${server.port}/playlist.m3u`, {
        allowedTargets: allowFixture(server.port),
        resolver,
      }),
      TARGET_DENIED,
    );
    expect(server.requestCount('/playlist.m3u')).toBe(0);
  });

  it('解析失败或解析结果为空按 DNS_INVALID 拒绝', async () => {
    const server = await startServer([{ path: '/playlist.m3u', kind: 'm3u', content: '#EXTM3U\n' }]);
    const failing: RemoteDnsResolver = {
      resolve4: () => Promise.reject(new Error('resolver down')),
      resolve6: async () => [],
    };
    await expectFailure(
      openRemoteSource(`http://nas.lan.test:${server.port}/playlist.m3u`, {
        allowedTargets: [{ kind: 'hostPort', host: 'nas.lan.test', port: server.port }],
        resolver: failing,
      }),
      DNS_INVALID,
    );
    const empty: RemoteDnsResolver = {
      resolve4: async () => [],
      resolve6: async () => [],
    };
    await expectFailure(
      openRemoteSource(`http://nas.lan.test:${server.port}/playlist.m3u`, {
        allowedTargets: [{ kind: 'hostPort', host: 'nas.lan.test', port: server.port }],
        resolver: empty,
      }),
      DNS_INVALID,
    );
    expect(server.requestCount('/playlist.m3u')).toBe(0);
  });
});

describe('safe-http-reader(T014/T021):放行与透传', () => {
  it('happy path:精确许可的夹具地址可取回 m3u 内容;凭据不转发(Authorization/Cookie 头不存在)', async () => {
    const m3u = buildM3u([
      { tvgId: 'cctv1', name: 'CCTV-1 综合', url: 'http://user:pass@192.168.8.10:9981/cctv1' },
    ]);
    let seenAuthorization: string | undefined = 'not-called';
    let seenCookie: string | undefined = 'not-called';
    const server = await startServer([]);
    server.setRoute('/playlist.m3u', {
      kind: 'raw',
      respond: ({ req, res }) => {
        seenAuthorization = req.headers.authorization;
        seenCookie = req.headers.cookie;
        res.writeHead(200, { 'content-type': 'audio/x-mpegurl' });
        res.end(m3u);
      },
    });

    // URL 携带 userinfo:请求按 hostname/port 发出,userinfo 既不参与许可匹配也不进入请求
    const source = await openRemoteSource(`http://user:pass@127.0.0.1:${server.port}/playlist.m3u`, {
      allowedTargets: allowFixture(server.port),
    });
    const body = await collect(source.stream);
    expect(body.toString('utf8')).toBe(m3u);
    expect(source.contentType).toBe('audio/x-mpegurl');
    expect(source.contentEncoding).toBeNull();
    expect(seenAuthorization).toBeUndefined();
    expect(seenCookie).toBeUndefined();
    await source.close();
    expect(server.requestCount('/playlist.m3u')).toBe(1);
  });

  it('gzip 路由:返回原始压缩流(content-encoding 透传,字节一致,不做解压)', async () => {
    const xmltv = buildXmltv([{ id: 'cctv1', displayName: 'CCTV-1' }]);
    const server = await startServer([{ path: '/epg.xml.gz', kind: 'gzip', body: xmltv }]);
    const source = await openRemoteSource(`${server.baseUrl}/epg.xml.gz`, {
      allowedTargets: allowFixture(server.port),
    });
    const body = await collect(source.stream);
    expect(source.contentEncoding).toBe('gzip');
    expect(source.contentType).toBe('application/xml');
    // 与夹具 gzipSync 输出逐字节一致:解压不是读取器职责
    expect(body.equals(zlib.gzipSync(Buffer.from(xmltv, 'utf8')))).toBe(true);
    expect(body.subarray(0, 2).toString('hex')).toBe('1f8b');
    await source.close();
  });

  it('凭据 URL 的失败信息与元数据不回显 userinfo(user:pass 不出现在 message)', async () => {
    const server = await startServer([]);
    const failure = await expectFailure(
      openRemoteSource(`http://user:pass@127.0.0.1:${server.port}/playlist.m3u`, { allowedTargets: [] }),
      TARGET_DENIED,
    );
    expect(failure.message).not.toContain('user:pass');
    expect(failure.message).not.toContain('/playlist.m3u');
    // 可含脱敏 host(不含 userinfo/路径)
    expect(failure.message).toContain('127.0.0.1');
    expect(server.requestCount('/playlist.m3u')).toBe(0);
  });
});

describe('safe-http-reader(T014/T021):重定向与解析', () => {
  it('redirectChain hops=3(预算内)且每跳目标都在允许列表:成功到达最终内容', async () => {
    const server = await startServer([
      { path: '/chain', kind: 'redirectChain', hops: 3, targetPath: '/final' },
      { path: '/final', kind: 'body', body: 'final-payload', contentType: 'text/plain' },
    ]);
    const source = await openRemoteSource(`${server.baseUrl}/chain`, {
      allowedTargets: allowFixture(server.port),
    });
    const body = await collect(source.stream);
    expect(body.toString('utf8')).toBe('final-payload');
    expect(source.contentType).toBe('text/plain');
    await source.close();
    // 每跳恰好一次请求(独立连接,无重试)
    expect(server.requestCount('/chain')).toBe(1);
    expect(server.requestCount('/chain/hop-1')).toBe(1);
    expect(server.requestCount('/chain/hop-2')).toBe(1);
    expect(server.requestCount('/final')).toBe(1);
    expect(server.requestCount('/chain')).toBeLessThanOrEqual(1 + IMPORT_BUDGETS.NET_MAX_REDIRECTS);
  });

  it('重定向跳数超过 NET_MAX_REDIRECTS(4>3):REDIRECT_LIMIT,最终目标从未被请求', async () => {
    const server = await startServer([
      { path: '/chain', kind: 'redirectChain', hops: IMPORT_BUDGETS.NET_MAX_REDIRECTS + 1, targetPath: '/final' },
      { path: '/final', kind: 'body', body: 'final-payload', contentType: 'text/plain' },
    ]);
    await expectFailure(
      openRemoteSource(`${server.baseUrl}/chain`, { allowedTargets: allowFixture(server.port) }),
      REDIRECT_LIMIT,
    );
    expect(server.requestCount('/chain')).toBe(1);
    expect(server.requestCount(`/chain/hop-${IMPORT_BUDGETS.NET_MAX_REDIRECTS}`)).toBe(1);
    expect(server.requestCount('/final')).toBe(0);
  });

  it('重定向到未允许目标:每跳重新校验,目标侧零请求', async () => {
    const deniedServer = await startServer([{ path: '/secret', kind: 'body', body: 'nope', contentType: 'text/plain' }]);
    const allowedServer = await startServer([]);
    allowedServer.setRoute('/jump', {
      kind: 'raw',
      respond: ({ res }) => {
        res.writeHead(302, { location: `${deniedServer.baseUrl}/secret` });
        res.end();
      },
    });
    const failure = await expectFailure(
      openRemoteSource(`${allowedServer.baseUrl}/jump`, {
        allowedTargets: allowFixture(allowedServer.port),
      }),
      TARGET_DENIED,
    );
    expect(allowedServer.requestCount('/jump')).toBe(1);
    expect(deniedServer.requestCount('/secret')).toBe(0);
    expect(failure.message).not.toContain('/secret');
  });

  it('每跳重新解析全部 A/AAAA 并连接固定已验证 IP(注入 resolver,调用次数=跳数)', async () => {
    const hostName = 'playlist.lan.test';
    const server = await startServer([{ path: '/final-name', kind: 'm3u', content: '#EXTM3U\n' }]);
    // Location 保留原主机名的绝对 URL,迫使第二跳重新走完整校验与解析
    server.setRoute('/chain-name', {
      kind: 'raw',
      respond: ({ res }) => {
        res.writeHead(302, { location: `http://${hostName}:${server.port}/final-name` });
        res.end();
      },
    });
    const resolver = recordingResolver();
    const source = await openRemoteSource(`http://${hostName}:${server.port}/chain-name`, {
      allowedTargets: [{ kind: 'hostPort', host: hostName, port: server.port }],
      resolver,
    });
    const body = await collect(source.stream);
    expect(body.toString('utf8')).toBe('#EXTM3U\n');
    await source.close();
    // 两跳(首跳+重定向跳)各自重新解析 A 与 AAAA:每族调用次数=跳数,
    // 而连接固定使用该跳已验证 IP —— 夹具只绑定 127.0.0.1,内容可达即为证明。
    expect(resolver.calls4).toEqual([hostName, hostName]);
    expect(resolver.calls6).toEqual([hostName, hostName]);
    expect(server.requestCount('/chain-name')).toBe(1);
    expect(server.requestCount('/final-name')).toBe(1);
  });
});

describe('safe-http-reader(T014/T021):预算与取消', () => {
  it('空闲超过 NET_IDLE_TIMEOUT_MS 失败(IDLE_TIMEOUT),由注入 ManualClock.advance 驱动,无真实等待', async () => {
    const clock = createManualClock();
    const server = await startServer(
      [{ path: '/slow', kind: 'slow', delayMs: 4 * IMPORT_BUDGETS.NET_IDLE_TIMEOUT_MS }],
      clock,
    );
    const pending = openRemoteSource(`${server.baseUrl}/slow`, {
      allowedTargets: allowFixture(server.port),
      clock,
    });
    await vi.waitUntil(() => server.pendingResponseCount() === 1);
    const realStart = Date.now();
    await clock.advance(IMPORT_BUDGETS.NET_IDLE_TIMEOUT_MS + 1);
    const failure = await expectFailure(pending, IDLE_TIMEOUT);
    expect(Date.now() - realStart).toBeLessThan(2_000);
    expect(failure.message).not.toContain('/slow');
  });

  it('持续有数据的慢流不触发空闲超时,总时长超过 NET_TOTAL_BUDGET_MS 失败(BUDGET_EXCEEDED)', async () => {
    const clock = createManualClock();
    const server = await startServer([]);
    server.setRoute('/trickle', {
      kind: 'raw',
      respond: async ({ res }) => {
        res.writeHead(200, { 'content-type': 'text/plain' });
        // 每 10 秒(虚拟)写一小块:始终短于空闲窗口,只让总预算到期
        while (!res.destroyed) {
          res.write('tick');
          await clock.delay(10_000);
        }
      },
    });
    const source = await openRemoteSource(`${server.baseUrl}/trickle`, {
      allowedTargets: allowFixture(server.port),
      clock,
    });
    // 流已返回,总预算失败经流的 error 通道传播(RemoteReadFailure);
    // 断言处理器必须在推进循环前挂上,避免拒绝在无人处理的检查点触发 unhandledRejection
    const expectation = expectFailure(collect(source.stream), BUDGET_EXCEEDED);
    await vi.waitUntil(() => server.requestCount('/trickle') === 1);
    // 分步推进:每步让真实 socket I/O 落地,读取器在每次数据块上重置空闲窗口
    // (数据事件走真实事件循环,略滞后于虚拟时钟,须让出真实时间)
    for (let step = 0; step < 12; step += 1) {
      await clock.advance(10_000);
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    await expectation;
  });

  it('hang 路由:外部 AbortSignal 取消(ABORTED);已中止的 signal 立即拒绝且不发请求', async () => {
    const server = await startServer([{ path: '/hang', kind: 'hang' }]);
    const controller = new AbortController();
    const pending = openRemoteSource(`${server.baseUrl}/hang`, {
      allowedTargets: allowFixture(server.port),
      signal: controller.signal,
    });
    await vi.waitUntil(() => server.pendingResponseCount() === 1);
    controller.abort();
    await expectFailure(pending, ABORTED);

    const preset = new AbortController();
    preset.abort();
    await expectFailure(
      openRemoteSource(`${server.baseUrl}/hang`, {
        allowedTargets: allowFixture(server.port),
        signal: preset.signal,
      }),
      ABORTED,
    );
    // 两次挂起尝试均未产生已响应请求;取消销毁连接后,服务端挂起清零(等 close 事件落地)
    await vi.waitUntil(() => server.pendingResponseCount() === 0);
    expect(server.pendingResponseCount()).toBe(0);
  });

  it('large 路由超过注入字节上限(总预算内):失败且中止连接', async () => {
    const server = await startServer([
      { path: '/large.m3u', kind: 'large', bytes: 256 * 1024 },
    ]);
    const source = await openRemoteSource(`${server.baseUrl}/large.m3u`, {
      allowedTargets: allowFixture(server.port),
      maxBytes: 64 * 1024,
    });
    // 超限发生在响应体阶段:失败经流的 error 通道传播,连接被读取器中止
    await expectFailure(collect(source.stream), BUDGET_EXCEEDED);
    expect(server.requestCount('/large.m3u')).toBe(1);
    // 连接已中止:读取器在数据通道上中止后,服务端无残留挂起响应
    expect(server.pendingResponseCount()).toBe(0);
  });
});

describe('safe-http-reader:DNS 记录家族语义(ENODATA=该家族无记录,非错误)', () => {
  it('A-only 域名(resolve6 ENODATA)不失败,正常取回内容', async () => {
    const server = await startServer([{ path: '/playlist.m3u', kind: 'm3u', content: '#EXTM3U\n' }]);
    const enodata = new Error('no AAAA records');
    (enodata as NodeJS.ErrnoException).code = 'ENODATA';
    const resolver: RemoteDnsResolver = {
      resolve4: async () => ['127.0.0.1'],
      resolve6: async () => {
        throw enodata;
      },
    };
    const source = await openRemoteSource(`http://a-only.lan.test:${server.port}/playlist.m3u`, {
      allowedTargets: [{ kind: 'hostPort', host: 'a-only.lan.test', port: server.port }],
      resolver,
    });
    const body = await collect(source.stream);
    expect(body.toString('utf8')).toContain('#EXTM3U');
    await source.close();
    expect(server.requestCount('/playlist.m3u')).toBe(1);
  });

  it('AAAA-only 域名(resolve4 ENODATA)不失败,正常取回内容', async () => {
    const server = await startServer([{ path: '/playlist.m3u', kind: 'm3u', content: '#EXTM3U\n' }]);
    const enodata = new Error('no A records');
    (enodata as NodeJS.ErrnoException).code = 'ENODATA';
    const resolver: RemoteDnsResolver = {
      resolve4: async () => {
        throw enodata;
      },
      resolve6: async () => ['127.0.0.1'],
    };
    const source = await openRemoteSource(`http://aaaa-only.lan.test:${server.port}/playlist.m3u`, {
      allowedTargets: [{ kind: 'hostPort', host: 'aaaa-only.lan.test', port: server.port }],
      resolver,
    });
    const body = await collect(source.stream);
    expect(body.toString('utf8')).toContain('#EXTM3U');
    await source.close();
    expect(server.requestCount('/playlist.m3u')).toBe(1);
  });

  it('resolve4 ENOTFOUND(域名不存在)仍按 DNS_INVALID 拒绝且不连接', async () => {
    const server = await startServer([{ path: '/playlist.m3u', kind: 'm3u', content: '#EXTM3U\n' }]);
    const notfound = new Error('domain not found');
    (notfound as NodeJS.ErrnoException).code = 'ENOTFOUND';
    const resolver: RemoteDnsResolver = {
      resolve4: async () => {
        throw notfound;
      },
      resolve6: async () => [],
    };
    await expectFailure(
      openRemoteSource(`http://missing.lan.test:${server.port}/playlist.m3u`, {
        allowedTargets: [{ kind: 'hostPort', host: 'missing.lan.test', port: server.port }],
        resolver,
      }),
      DNS_INVALID,
    );
    expect(server.requestCount('/playlist.m3u')).toBe(0);
  });
});
