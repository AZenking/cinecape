import http from 'node:http';
import zlib from 'node:zlib';
import type { AddressInfo } from 'node:net';
import type { Clock } from './clock';

/**
 * 受控 M3U/XMLTV HTTP 夹具服务(T012;quickstart 先决条件/E 节失败模式):
 * - http.createServer 绑定 127.0.0.1 随机端口,可编程路由;
 * - 路由形态覆盖:合法 M3U/XMLTV、gzip 压缩体、302 重定向链(指定跳数与目标)、
 *   慢响应与挂起(可注入时钟或 abortPending 句柄)、非法格式、空响应体、
 *   超大响应(可配置字节/条目);凭据 URL 条目由 buildM3u 构造;
 * - 未注入 clock 时 slow 用真实 setTimeout;注入 ManualClock 后由 advance() 推进。
 */

/** 单个请求上下文;raw 路由完全接管响应 */
export interface MediaRequestContext {
  req: http.IncomingMessage;
  res: http.ServerResponse;
  url: URL;
  baseUrl: string;
}

/** 声明式路由:kind 决定响应形态 */
export type ControlledRoute =
  | { kind: 'm3u'; content: string; status?: number }
  | { kind: 'xmltv'; content: string; status?: number }
  | { kind: 'body'; body: string | Buffer; contentType?: string; status?: number }
  | { kind: 'gzip'; body: string | Buffer; contentType?: string; status?: number }
  | { kind: 'redirect'; location: string; status?: number }
  /** 共 hops 次 302 后落到 targetPath(内部 hop 路由由 setRoute 自动注册) */
  | { kind: 'redirectChain'; hops: number; targetPath: string; status?: number }
  /** 延迟 delayMs 后响应;注入 ManualClock 时需 advance 推进 */
  | { kind: 'slow'; delayMs: number; body?: string; status?: number; contentType?: string }
  /** 永不响应,直到 abortPending()/close() 销毁连接 */
  | { kind: 'hang' }
  /** 200(或指定状态)但响应体为 0 字节 */
  | { kind: 'empty'; status?: number }
  /** 超大 M3U:bytes 为最终字节数下限(条目超出时以条目为准),entries 为 EXTINF 条数 */
  | { kind: 'large'; bytes: number; entries?: number; contentType?: string; status?: number }
  /** 完全自定义响应 */
  | { kind: 'raw'; respond: (context: MediaRequestContext) => void | Promise<void> };

/** 带 path 的完整路由声明 */
export type ControlledRouteSpec = ControlledRoute & { path: string };

export interface ControlledMediaServerOptions {
  routes?: readonly ControlledRouteSpec[];
  /** 注入后 slow 路由的延时由该时钟驱动(manual clock 需 advance 推进) */
  clock?: Clock;
}

export interface ControlledMediaServer {
  baseUrl: string;
  port: number;
  /** 新增/覆盖路由(redirectChain 会同步注册内部 hop 路由,覆盖时先清理旧 hop) */
  setRoute(routePath: string, route: ControlledRoute): void;
  removeRoute(routePath: string): void;
  /** 该路径(仅 pathname,不含 query)被请求的次数,用于重定向跳数断言 */
  requestCount(routePath: string): number;
  /** 已接收但尚未响应(hang/未到期的 slow)的响应数 */
  pendingResponseCount(): number;
  /** 销毁全部挂起连接,模拟对端中断 */
  abortPending(): void;
  close(): Promise<void>;
}

function toBuffer(body: string | Buffer): Buffer {
  return typeof body === 'string' ? Buffer.from(body, 'utf8') : body;
}

export async function createControlledMediaServer(
  options: ControlledMediaServerOptions = {},
): Promise<ControlledMediaServer> {
  const clock = options.clock;
  const handlers = new Map<string, ControlledRoute>();
  const internalHopPaths = new Map<string, string[]>();
  const counts = new Map<string, number>();
  const pendingResponses = new Set<http.ServerResponse>();
  let closed = false;
  let baseUrl = '';

  function send(
    res: http.ServerResponse,
    status: number,
    contentType: string,
    body: Buffer,
    extraHeaders: Record<string, string> = {},
  ): void {
    if (res.headersSent || res.destroyed) {
      return;
    }
    res.statusCode = status;
    res.setHeader('content-type', contentType);
    res.setHeader('content-length', String(body.length));
    for (const [name, value] of Object.entries(extraHeaders)) {
      res.setHeader(name, value);
    }
    res.end(body);
  }

  function sendText(res: http.ServerResponse, status: number, contentType: string, content: string): void {
    send(res, status, contentType, Buffer.from(content, 'utf8'));
  }

  function sendRedirect(context: MediaRequestContext, status: number, location: string): void {
    // 相对路径统一解析为绝对 URL,便于断言与跨路由跳转
    send(context.res, status, 'text/plain', Buffer.from('redirecting'), {
      location: new URL(location, context.baseUrl).href,
    });
  }

  const delayFor = (ms: number): Promise<void> => {
    if (clock !== undefined) {
      return clock.delay(ms);
    }
    return new Promise<void>((resolve) => {
      setTimeout(resolve, ms);
    });
  };

  async function dispatch(route: ControlledRoute, context: MediaRequestContext): Promise<void> {
    const { res } = context;
    switch (route.kind) {
      case 'm3u':
        sendText(res, route.status ?? 200, 'audio/x-mpegurl', route.content);
        return;
      case 'xmltv':
        sendText(res, route.status ?? 200, 'application/xml', route.content);
        return;
      case 'body':
        send(res, route.status ?? 200, route.contentType ?? 'application/octet-stream', toBuffer(route.body));
        return;
      case 'gzip': {
        const gzipped = zlib.gzipSync(toBuffer(route.body));
        send(res, route.status ?? 200, route.contentType ?? 'application/xml', gzipped, {
          'content-encoding': 'gzip',
        });
        return;
      }
      case 'redirect':
        sendRedirect(context, route.status ?? 302, route.location);
        return;
      case 'redirectChain':
        // 正常由 setRoute 展开成 redirect 路由;直接 dispatch 时兜底跳目标
        sendRedirect(context, route.status ?? 302, route.targetPath);
        return;
      case 'slow': {
        // 挂起中的 slow 计入 pending,供 waitUntil 与 abortPending/close 协调
        pendingResponses.add(res);
        const removePending = (): void => {
          pendingResponses.delete(res);
        };
        res.once('close', removePending);
        await delayFor(route.delayMs);
        res.off('close', removePending);
        removePending();
        if (res.writableEnded || res.destroyed) {
          return;
        }
        sendText(res, route.status ?? 200, route.contentType ?? 'text/plain', route.body ?? 'controlled-slow-body');
        return;
      }
      case 'hang': {
        pendingResponses.add(res);
        res.once('close', () => {
          pendingResponses.delete(res);
        });
        return;
      }
      case 'empty': {
        if (res.headersSent || res.destroyed) {
          return;
        }
        res.statusCode = route.status ?? 200;
        res.setHeader('content-length', '0');
        res.end();
        return;
      }
      case 'large':
        send(
          res,
          route.status ?? 200,
          route.contentType ?? 'audio/x-mpegurl',
          buildLargeM3u({ bytes: route.bytes, entries: route.entries }),
        );
        return;
      case 'raw':
        await route.respond(context);
        return;
    }
  }

  function clearInternalHops(routePath: string): void {
    for (const hopPath of internalHopPaths.get(routePath) ?? []) {
      handlers.delete(hopPath);
    }
    internalHopPaths.delete(routePath);
  }

  function setRoute(routePath: string, route: ControlledRoute): void {
    clearInternalHops(routePath);
    if (route.kind === 'redirectChain') {
      if (!Number.isInteger(route.hops) || route.hops < 1) {
        throw new Error('redirectChain.hops 必须为 >= 1 的整数');
      }
      const base = routePath.length > 1 && routePath.endsWith('/') ? routePath.slice(0, -1) : routePath;
      const chainPaths: string[] = [base];
      for (let hop = 1; hop <= route.hops - 1; hop += 1) {
        chainPaths.push(`${base}/hop-${hop}`);
      }
      chainPaths.forEach((current, index) => {
        const nextPath = chainPaths[index + 1];
        handlers.set(current, {
          kind: 'redirect',
          location: nextPath ?? route.targetPath,
          status: route.status ?? 302,
        });
      });
      internalHopPaths.set(routePath, chainPaths.slice(1));
      return;
    }
    handlers.set(routePath, route);
  }

  function removeRoute(routePath: string): void {
    clearInternalHops(routePath);
    handlers.delete(routePath);
  }

  function abortPending(): void {
    for (const res of [...pendingResponses]) {
      res.socket?.destroy();
    }
    pendingResponses.clear();
  }

  async function close(): Promise<void> {
    if (closed) {
      return;
    }
    closed = true;
    abortPending();
    await new Promise<void>((resolve, reject) => {
      server.close((error) => {
        if (error !== undefined) {
          reject(error);
          return;
        }
        resolve();
      });
      // 销毁 keep-alive 与挂起连接,保证 close 不悬空
      server.closeAllConnections();
    });
  }

  const server = http.createServer((req, res) => {
    req.on('error', () => {});
    res.on('error', () => {});
    const url = new URL(req.url ?? '/', baseUrl);
    counts.set(url.pathname, (counts.get(url.pathname) ?? 0) + 1);
    const route = handlers.get(url.pathname);
    if (route === undefined) {
      res.statusCode = 404;
      res.end('controlled-media-server: no route');
      return;
    }
    void dispatch(route, { req, res, url, baseUrl }).catch((error: unknown) => {
      if (!res.headersSent) {
        res.statusCode = 500;
      }
      if (!res.writableEnded) {
        res.end(error instanceof Error ? error.message : 'controlled-media-server error');
      }
    });
  });

  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error): void => {
      reject(error);
    };
    server.once('error', onError);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', onError);
      resolve();
    });
  });
  const address: AddressInfo | string | null = server.address();
  if (address === null || typeof address === 'string') {
    throw new Error('受控夹具服务未按预期绑定 TCP 地址');
  }
  baseUrl = `http://127.0.0.1:${address.port}`;

  for (const spec of options.routes ?? []) {
    setRoute(spec.path, spec);
  }

  return {
    baseUrl,
    port: address.port,
    setRoute,
    removeRoute,
    requestCount: (routePath: string) => counts.get(routePath) ?? 0,
    pendingResponseCount: () => pendingResponses.size,
    abortPending,
    close,
  };
}

/** 超大 M3U 构造:条目写完后用填充字节补足到 bytes(bytes 为最终长度下限) */
export interface LargeM3uOptions {
  bytes: number;
  entries?: number;
}

export function buildLargeM3u(options: LargeM3uOptions): Buffer {
  if (!Number.isInteger(options.bytes) || options.bytes < 0) {
    throw new Error('bytes 必须为非负整数');
  }
  const lines: string[] = ['#EXTM3U'];
  for (let index = 0; index < (options.entries ?? 0); index += 1) {
    lines.push(`#EXTINF:-1 tvg-id="large-${index}",Large Channel ${index}`);
    lines.push(`http://stream.large.example/${index}`);
  }
  let body = Buffer.from(`${lines.join('\n')}\n`, 'utf8');
  if (body.length < options.bytes) {
    const padded = Buffer.alloc(options.bytes, 0x70); // 'p'
    body.copy(padded, 0);
    body = padded;
  }
  return body;
}

export interface M3uEntryInput {
  name: string;
  url: string;
  tvgId?: string;
  tvgName?: string;
  groupTitle?: string;
  /** 014 T012/T013:EXTINF tvg-logo 属性原文(按需透传,缺省不输出该属性) */
  tvgLogo?: string;
  duration?: number;
}

/** 构造合法 Extended M3U 文本;url 可为含凭据的地址(http://user:pass@host/...) */
export function buildM3u(entries: readonly M3uEntryInput[]): string {
  const lines: string[] = ['#EXTM3U'];
  for (const entry of entries) {
    const attrs: string[] = [];
    if (entry.tvgId !== undefined) {
      attrs.push(`tvg-id="${entry.tvgId}"`);
    }
    if (entry.tvgName !== undefined) {
      attrs.push(`tvg-name="${entry.tvgName}"`);
    }
    if (entry.groupTitle !== undefined) {
      attrs.push(`group-title="${entry.groupTitle}"`);
    }
    if (entry.tvgLogo !== undefined) {
      attrs.push(`tvg-logo="${entry.tvgLogo}"`);
    }
    const duration = entry.duration ?? -1;
    lines.push(`#EXTINF:${duration}${attrs.length > 0 ? ` ${attrs.join(' ')}` : ''},${entry.name}`);
    lines.push(entry.url);
  }
  return `${lines.join('\n')}\n`;
}

export interface XmltvChannelInput {
  id: string;
  displayName?: string;
}

export interface XmltvProgrammeInput {
  channel: string;
  /** XMLTV 时间格式,如 20260101000000 +0800(必须带时区) */
  start: string;
  stop: string;
  title: string;
}

function escapeXml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');
}

/** 构造合法 XMLTV 文本 */
export function buildXmltv(channels: readonly XmltvChannelInput[], programmes: readonly XmltvProgrammeInput[] = []): string {
  const lines: string[] = ['<?xml version="1.0" encoding="UTF-8"?>', '<tv>'];
  for (const channel of channels) {
    lines.push(`  <channel id="${escapeXml(channel.id)}">`);
    lines.push(`    <display-name>${escapeXml(channel.displayName ?? channel.id)}</display-name>`);
    lines.push('  </channel>');
  }
  for (const programme of programmes) {
    lines.push(
      `  <programme channel="${escapeXml(programme.channel)}" start="${escapeXml(programme.start)}" stop="${escapeXml(programme.stop)}">`,
    );
    lines.push(`    <title>${escapeXml(programme.title)}</title>`);
    lines.push('  </programme>');
  }
  lines.push('</tv>');
  return `${lines.join('\n')}\n`;
}

/** 非法格式样本(E 节:DOCTYPE/未知实体/嵌套过深/坏 XML/畸形 M3U,均应被 strict 解析拒绝) */
export const malformedPayloads = {
  /** 坏 XML:未闭合标签(缺 </tv>) */
  brokenXml(): string {
    return '<?xml version="1.0" encoding="UTF-8"?>\n<tv>\n  <channel id="cctv1">\n    <display-name>CCTV-1</display-name>\n  </channel>\n';
  },
  /** DOCTYPE + 实体声明:strict 解析必须拒绝 */
  xmlWithDoctype(): string {
    return [
      '<?xml version="1.0" encoding="UTF-8"?>',
      '<!DOCTYPE tv [',
      '  <!ENTITY xxe "boom">',
      ']>',
      '<tv>',
      '  <channel id="cctv1"><display-name>&xxe;</display-name></channel>',
      '</tv>',
    ].join('\n');
  },
  /** 未声明的未知实体 */
  xmlWithUnknownEntity(): string {
    return [
      '<?xml version="1.0" encoding="UTF-8"?>',
      '<tv>',
      '  <channel id="cctv1"><display-name>&not-declared;</display-name></channel>',
      '</tv>',
    ].join('\n');
  },
  /** 嵌套过深:depth 层 <layer>(预算 32 层,默认 40) */
  deeplyNestedXml(depth = 40): string {
    return `<?xml version="1.0" encoding="UTF-8"?>\n<tv>${'<layer>'.repeat(depth)}<title>deep</title>${'</layer>'.repeat(depth)}</tv>\n`;
  },
  /** 畸形 M3U:EXTINF 条目缺播放地址 */
  malformedM3u(): string {
    return '#EXTM3U\n#EXTINF:-1 tvg-id="cctv1",CCTV-1\nhttp://stream.example/cctv1\n#EXTINF:-1 tvg-id="no-url",无地址频道\n';
  },
} as const;
