import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import zlib from 'node:zlib';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  buildLargeM3u,
  buildM3u,
  buildXmltv,
  createControlledMediaServer,
  createManualClock,
  createNasRootFixture,
  malformedPayloads,
  type Clock,
  type ControlledMediaServer,
  type ControlledRouteSpec,
  type NasRootFixture,
} from '../fixtures';

/**
 * T012 冒烟:夹具本体可用性(服务取回/gzip 往返/重定向跳数/NAS 读写与清理)。
 * 解析器、预算与安全语义由 T013-T017 的被测实现验证,这里只保证夹具可支撑那些用例。
 */

const servers: ControlledMediaServer[] = [];
const nasRoots: NasRootFixture[] = [];

async function startServer(routes: ControlledRouteSpec[], clock?: Clock): Promise<ControlledMediaServer> {
  const server = await createControlledMediaServer({ routes, clock });
  servers.push(server);
  return server;
}

/** 原始 GET:不做任何自动解压/重定向,用于 gzip 断言 */
function httpGet(url: string): Promise<{ status: number; headers: http.IncomingHttpHeaders; body: Buffer }> {
  return new Promise((resolve, reject) => {
    const req = http.get(url, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (chunk: Buffer) => chunks.push(chunk));
      res.on('end', () => {
        resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks) });
      });
    });
    req.on('error', reject);
  });
}

afterEach(async () => {
  for (const server of servers.splice(0)) {
    await server.close();
  }
  for (const nas of nasRoots.splice(0)) {
    nas.cleanup();
  }
});

describe('controlled-media-server(T012)', () => {
  it('M3U 路由返回 200 与原文', async () => {
    const m3u = buildM3u([
      { tvgId: 'cctv1', name: 'CCTV-1 综合', url: 'http://user:pass@192.168.8.10:9981/cctv1' },
      { name: '无 tvg-id 频道', url: 'http://192.168.8.10:9981/no-id' },
    ]);
    const server = await startServer([{ path: '/playlist.m3u', kind: 'm3u', content: m3u }]);

    const res = await fetch(`${server.baseUrl}/playlist.m3u`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('audio/x-mpegurl');
    expect(await res.text()).toBe(m3u);
    // 凭据 URL 条目按原样进入响应体,供 T013/T054 的身份与脱敏断言使用
    expect(m3u).toContain('http://user:pass@192.168.8.10:9981/cctv1');
  });

  it('gzip 路由原始响应为压缩体,解压后与原文一致', async () => {
    const xmltv = buildXmltv([{ id: 'cctv1', displayName: 'CCTV-1' }], [
      { channel: 'cctv1', start: '20260101000000 +0800', stop: '20260101010000 +0800', title: '新闻' },
    ]);
    const server = await startServer([{ path: '/epg.xml.gz', kind: 'gzip', body: xmltv }]);

    const raw = await httpGet(`${server.baseUrl}/epg.xml.gz`);
    expect(raw.status).toBe(200);
    expect(raw.headers['content-encoding']).toBe('gzip');
    expect(zlib.gunzipSync(raw.body).toString('utf8')).toBe(xmltv);
  });

  it('重定向链按指定跳数到达目标', async () => {
    const server = await startServer([
      { path: '/chain', kind: 'redirectChain', hops: 3, targetPath: '/final' },
      { path: '/final', kind: 'body', body: 'final-payload', contentType: 'text/plain' },
    ]);

    // 第一跳:302 + 绝对 Location
    const first = await fetch(`${server.baseUrl}/chain`, { redirect: 'manual' });
    expect(first.status).toBe(302);
    expect(first.headers.get('location')).toBe(`${server.baseUrl}/chain/hop-1`);

    // 默认跟随:3 次 302(chain → hop-1 → hop-2)后落到 /final
    const followed = await fetch(`${server.baseUrl}/chain`);
    expect(followed.status).toBe(200);
    expect(new URL(followed.url).pathname).toBe('/final');
    expect(await followed.text()).toBe('final-payload');

    // 手动请求只命中 /chain(1 次),跟随请求命中 /chain + 全部 hop + 目标
    expect(server.requestCount('/chain')).toBe(2);
    expect(server.requestCount('/chain/hop-1')).toBe(1);
    expect(server.requestCount('/chain/hop-2')).toBe(1);
    expect(server.requestCount('/final')).toBe(1);
  });

  it('慢响应延迟后返回,空响应体为 200 空 body,超大响应按配置生成', async () => {
    const server = await startServer([
      { path: '/slow', kind: 'slow', delayMs: 40 },
      { path: '/empty.xml', kind: 'empty' },
      { path: '/large.m3u', kind: 'large', bytes: 4096, entries: 8 },
    ]);

    const startedAt = Date.now();
    const slowRes = await fetch(`${server.baseUrl}/slow`);
    expect(slowRes.status).toBe(200);
    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(25);

    const emptyRes = await fetch(`${server.baseUrl}/empty.xml`);
    expect(emptyRes.status).toBe(200);
    expect((await emptyRes.arrayBuffer()).byteLength).toBe(0);

    const largeRes = await fetch(`${server.baseUrl}/large.m3u`);
    expect(largeRes.status).toBe(200);
    const largeText = await largeRes.text();
    expect(Buffer.byteLength(largeText, 'utf8')).toBeGreaterThanOrEqual(4096);
    expect(largeText.split('#EXTINF').length - 1).toBe(8);
    expect(buildLargeM3u({ bytes: 0, entries: 1 }).toString('utf8')).toContain('http://stream.large.example/0');
  });

  it('hang 路由挂起请求,可经 abortPending 清理', async () => {
    const server = await startServer([{ path: '/hang', kind: 'hang' }]);
    const outcome = fetch(`${server.baseUrl}/hang`).then(
      () => 'resolved' as const,
      () => 'rejected' as const,
    );
    await vi.waitUntil(() => server.pendingResponseCount() === 1);
    server.abortPending();
    await vi.waitUntil(() => server.pendingResponseCount() === 0);
    expect(await outcome).toBe('rejected');
  });

  it('注入时钟后 slow 延迟由 advance 推进,不真实等待', async () => {
    const clock = createManualClock();
    const server = await startServer([{ path: '/slow', kind: 'slow', delayMs: 120_000 }], clock);
    const statusPromise = fetch(`${server.baseUrl}/slow`).then(
      (res) => res.status,
      () => -1,
    );
    await vi.waitUntil(() => server.pendingResponseCount() === 1);
    const realStartedAt = Date.now();
    await clock.advance(120_000);
    expect(await statusPromise).toBe(200);
    expect(Date.now() - realStartedAt).toBeLessThan(2_000);
  });

  it('setRoute 可覆盖/移除路由', async () => {
    const server = await startServer([{ path: '/x', kind: 'body', body: 'v1' }]);
    server.setRoute('/x', { kind: 'body', body: 'v2' });
    expect(await (await fetch(`${server.baseUrl}/x`)).text()).toBe('v2');
    server.removeRoute('/x');
    expect((await fetch(`${server.baseUrl}/x`)).status).toBe(404);
  });
});

describe('nas-root-fixture(T012)', () => {
  it('建目录/写文件/sizeHint/mtime/符号链接越界样本/同名不同路径/删除/清理', () => {
    const nas = createNasRootFixture();
    nasRoots.push(nas);
    expect(fs.existsSync(nas.rootPath)).toBe(true);
    expect(fs.existsSync(nas.outsidePath)).toBe(true);
    expect(nas.rootKey).toMatch(/^nas-/);

    const rel = 'movies/2024/movie.mp4';
    const requestedMtimeNs = 1_700_000_000_123_456_789n;
    const abs = nas.write(rel, 'content', { sizeHint: 32, mtimeNs: requestedMtimeNs });
    expect(abs.startsWith(nas.rootPath + path.sep)).toBe(true);
    const stat = fs.statSync(abs, { bigint: true });
    expect(stat.size).toBe(32n);
    const mtimeDelta =
      stat.mtimeNs > requestedMtimeNs ? stat.mtimeNs - requestedMtimeNs : requestedMtimeNs - stat.mtimeNs;
    expect(mtimeDelta).toBeLessThan(5_000_000n); // utimesSync 尽力精度,5ms 容差

    const sizeBefore = stat.size;
    const mtimeBefore = stat.mtimeNs;
    nas.mutateSizeOrMtime(rel);
    const statAfter = fs.statSync(abs, { bigint: true });
    expect(statAfter.size).toBe(sizeBefore + 1n);
    expect(statAfter.mtimeNs > mtimeBefore).toBe(true);

    // 越界路径样本:根内符号链接指向根外文件
    const outsideFile = nas.writeOutside('escape-target.mp4', 'outside-bytes');
    const linkPath = nas.makeSymlink('links/escape.mp4', outsideFile);
    expect(fs.lstatSync(linkPath).isSymbolicLink()).toBe(true);
    expect(linkPath.startsWith(nas.rootPath + path.sep)).toBe(true);
    expect(outsideFile.startsWith(nas.rootPath + path.sep)).toBe(false);
    // macOS 下 /var 是 /private/var 的符号链接,两侧都经 realpath 归一后比较
    expect(fs.realpathSync(linkPath)).toBe(fs.realpathSync(outsideFile));

    // 同名不同路径样本
    nas.write('a/show.mp4', 'A');
    nas.write('b/show.mp4', 'B');
    expect(fs.readFileSync(path.join(nas.rootPath, 'a/show.mp4'), 'utf8')).toBe('A');
    expect(fs.readFileSync(path.join(nas.rootPath, 'b/show.mp4'), 'utf8')).toBe('B');

    nas.remove('a/show.mp4');
    expect(fs.existsSync(path.join(nas.rootPath, 'a/show.mp4'))).toBe(false);

    nas.cleanup();
    expect(fs.existsSync(nas.rootPath)).toBe(false);
    nas.cleanup(); // 幂等
  });
});

describe('clock(T012)', () => {
  it('now/delay/advance 按到期顺序唤醒,set 跳转绝对时间', async () => {
    const clock = createManualClock({ startMs: 1_000 });
    expect(clock.now()).toBe(1_000);

    const order: string[] = [];
    const a = clock.delay(100).then(() => order.push('a'));
    const b = clock.delay(50).then(() => order.push('b'));
    const c = clock.delay(100).then(() => order.push('c'));
    expect(clock.pendingCount()).toBe(3);

    await clock.advance(100);
    await Promise.all([a, b, c]);
    expect(order).toEqual(['b', 'a', 'c']);
    expect(clock.pendingCount()).toBe(0);

    clock.set(9_999);
    expect(clock.now()).toBe(9_999);
  });
});

describe('payload builders(T012)', () => {
  it('合法 M3U/XMLTV 与非法格式样本构造', () => {
    const xmltv = buildXmltv([{ id: 'cctv1' }], [
      { channel: 'cctv1', start: '20260101000000 +0800', stop: '20260101010000 +0800', title: '新闻' },
    ]);
    expect(xmltv).toContain('<channel id="cctv1">');
    expect(xmltv).toContain('</tv>');

    expect(malformedPayloads.brokenXml()).not.toContain('</tv>');
    expect(malformedPayloads.xmlWithDoctype()).toContain('<!DOCTYPE');
    expect(malformedPayloads.xmlWithUnknownEntity()).toContain('&not-declared;');
    expect(malformedPayloads.deeplyNestedXml(40).split('<layer>').length - 1).toBe(40);
    expect(malformedPayloads.malformedM3u()).toContain('无地址频道');
  });
});
