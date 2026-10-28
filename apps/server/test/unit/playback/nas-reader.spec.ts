import fs from 'node:fs';
import fsp from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { Readable } from 'node:stream';
import { afterEach, describe, expect, it } from 'vitest';
import {
  NasReaderService,
  nasContentType,
  parseByteRange,
  type NasReadFailure,
} from '../../../src/contexts/playback/infrastructure/nas-reader';

/**
 * NAS 只读安全文件读取器单测(T020,spec 004)—— 先实现前编写(RED → GREEN)。
 *
 * 权威依据:
 * - docs/specs/004-playback-resolver/tasks.md T020:只读安全文件描述符输入、root/路径/
 *   符号链接/size/mtime 校验及单 Range/HEAD/backpressure;源变化停止旧 session(本层只提供
 *   可检测错误,停止动作属 T028),数 GB 任意区间不整片读取,未发 header 返回 problem、
 *   已发送则关闭流;
 * - docs/specs/004-playback-resolver/research.md R3(NAS 输入安全):NAS 经验证的只读文件
 *   描述符输入,拒绝越界/符号链接且核对 size/mtime;Range 只允许单区间,206/416 标准语义,
 *   HEAD 无响应体;流式 backpressure,不整片常驻内存;
 * - docs/specs/004-playback-resolver/contracts/api.md「媒体端点」NAS direct 部分:
 *   GET/HEAD/单 Range(200/206、Accept-Ranges: bytes、Content-Length/Content-Range 一致;
 *   越界 416,多个 Range 400;HEAD 与 GET 同鉴权,HEAD 不发送字节);源故障未发 headers 时
 *   problem(503 PLAYBACK_RESOURCE_UNAVAILABLE,openapi.yaml 同端点 503 描述);
 * - docs/specs/004-playback-resolver/data-model.md「## 验证与恢复」:资源输入 size/mtime
 *   改变或 root 授权失效停止旧 session —— 本文件验证 statSource 与打开期复核两类检测 API;
 * - 源位置权威形态(refresh-publish.service.ts 资源落库 + T015 契约夹具同款):
 *   playback_source.location = `${rootKey}/${relativePath}`,rootKey 映射部署 MEDIA_ROOTS
 *   (env.schema.ts MediaRoots),根内路径段规则与 nas-scanner/source-target.validation
 *   的既有授权事实一致。
 *
 * 夹具:全部用 os.tmpdir 临时根 + 真实文件,afterEach 统一清理;不启动 Nest 应用
 * (本服务可独立构造,HTTP 接线属 T031)。
 */

/* ------------------------------------------------------------------ */
/* 夹具:临时 NAS 根 + 确定性内容                                       */
/* ------------------------------------------------------------------ */

const KEY = 'nas-reader-test-root';

/** 临时根目录登记(afterEach 统一清理)。 */
const tempDirs: string[] = [];

function registerTempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

/** 确定性内容(byte i = i & 0xff),与 T015 契约夹具同款,供字节级断言。 */
function patternBytes(size: number): Buffer {
  const bytes = Buffer.alloc(size);
  for (let index = 0; index < size; index += 1) {
    bytes[index] = index & 0xff;
  }
  return bytes;
}

/** 标准夹具根:media/fixture-movie.mp4 = 64KiB 确定性内容。 */
function makeStandardRig(): { root: string; location: string; bytes: Buffer; service: NasReaderService } {
  const root = registerTempDir('hmp-nas-reader-');
  fs.mkdirSync(path.join(root, 'media'), { recursive: true });
  const bytes = patternBytes(64 * 1024);
  fs.writeFileSync(path.join(root, 'media', 'fixture-movie.mp4'), bytes);
  return {
    root,
    location: `${KEY}/media/fixture-movie.mp4`,
    bytes,
    service: new NasReaderService({ mediaRoots: { [KEY]: root } }),
  };
}

/** 消费整条流为 Buffer。 */
async function collect(stream: Readable): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks);
}

function expectFailure(
  result: { ok: false } | { ok: true },
): asserts result is NasReadFailure {
  expect(result.ok).toBe(false);
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir !== undefined) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
});

/* ------------------------------------------------------------------ */
/* 1. root/路径校验:统一 404 MEDIA_NOT_FOUND 同形,不泄漏路径           */
/* ------------------------------------------------------------------ */

describe('T020 root/路径校验(全部稳定 404,不泄漏路径)', () => {
  it('「..」穿越逃出注册根 → 404 MEDIA_NOT_FOUND(即使逃逸目标真实存在)', async () => {
    const rig = makeStandardRig();
    // 逃逸目标真实放在根外,证明拒绝来自路径校验而非文件不存在
    const outside = registerTempDir('hmp-nas-reader-outside-');
    fs.writeFileSync(path.join(outside, 'secret.mp4'), patternBytes(16));
    const traversal = await rig.service.openRange(`${KEY}/../${path.basename(outside)}/secret.mp4`);
    expectFailure(traversal);
    expect(traversal.status).toBe(404);
    expect(traversal.code).toBe('MEDIA_NOT_FOUND');
    const stat = await rig.service.statSource(`${KEY}/../${path.basename(outside)}/secret.mp4`);
    expectFailure(stat);
    expect(stat.status).toBe(404);
  });

  it('绝对路径注入(POSIX 与盘符形态)→ 404', async () => {
    const rig = makeStandardRig();
    for (const location of ['/etc/hosts', 'C:/Windows/system.ini', `${KEY}/media/../media/fixture-movie.mp4`]) {
      const result = await rig.service.openRange(location);
      expectFailure(result);
      expect(result.status).toBe(404);
      expect(result.code).toBe('MEDIA_NOT_FOUND');
    }
  });

  it('URL 形态 location(http:// 与 file:///)→ 404', async () => {
    const rig = makeStandardRig();
    for (const location of [
      'http://127.0.0.1/media/fixture-movie.mp4',
      'file:///etc/hosts',
      'https://nas.local/media/fixture-movie.mp4',
    ]) {
      const result = await rig.service.openRange(location);
      expectFailure(result);
      expect(result.status).toBe(404);
      expect(result.code).toBe('MEDIA_NOT_FOUND');
    }
  });

  it('rootKey 未注册 → 404(即使同形文件存在于其他未注册根)', async () => {
    const otherRoot = registerTempDir('hmp-nas-reader-other-');
    fs.mkdirSync(path.join(otherRoot, 'media'), { recursive: true });
    fs.writeFileSync(path.join(otherRoot, 'media', 'fixture-movie.mp4'), patternBytes(64 * 1024));
    const rig = makeStandardRig();
    const result = await rig.service.openRange('unregistered-root/media/fixture-movie.mp4');
    expectFailure(result);
    expect(result.status).toBe(404);
    expect(result.code).toBe('MEDIA_NOT_FOUND');
  });

  it('空段/点段/结尾斜杠/反斜杠 → 404', async () => {
    const rig = makeStandardRig();
    for (const location of [
      `${KEY}//media/fixture-movie.mp4`,
      `${KEY}/media//fixture-movie.mp4`,
      `${KEY}/media/./fixture-movie.mp4`,
      `${KEY}/media/fixture-movie.mp4/`,
      `${KEY}/media\\fixture-movie.mp4`,
    ]) {
      const result = await rig.service.openRange(location);
      expectFailure(result);
      expect(result.status).toBe(404);
    }
  });

  it('所有 404 同形:文件不存在与被拒路径 detail 完全一致,且响应载荷不含根绝对路径/rootKey', async () => {
    const rig = makeStandardRig();
    const missing = await rig.service.openRange(`${KEY}/media/really-missing.mp4`);
    const traversal = await rig.service.openRange(`${KEY}/../escape.mp4`);
    const symlinked = await rig.service.openRange(`${KEY}/media/fixture-movie.mp4/x`);
    for (const result of [missing, traversal, symlinked]) {
      expectFailure(result);
      expect(result.status).toBe(404);
      expect(result.code).toBe('MEDIA_NOT_FOUND');
      expect(result.detail).toBe(missing.ok === false ? missing.detail : '');
    }
    expect(missing.ok).toBe(false);
    const serialized = JSON.stringify([missing, traversal, symlinked]);
    expect(serialized).not.toContain(rig.root);
    expect(serialized).not.toContain(KEY);
    expect(serialized).not.toContain('fixture-movie');
  });
});

/* ------------------------------------------------------------------ */
/* 2. 符号链接:任一环节为 symlink 即拒绝(指向根外/根内同拒)            */
/* ------------------------------------------------------------------ */

describe('T020 符号链接拒绝(防绕过)', () => {
  it('文件为 symlink 指向根外 → 404(openRange/statSource/headInfo 三入口同拒)', async () => {
    const rig = makeStandardRig();
    const outside = registerTempDir('hmp-nas-reader-outside-');
    fs.writeFileSync(path.join(outside, 'outer.mp4'), patternBytes(32));
    fs.symlinkSync(path.join(outside, 'outer.mp4'), path.join(rig.root, 'media', 'link-out.mp4'));
    const open = await rig.service.openRange(`${KEY}/media/link-out.mp4`);
    const stat = await rig.service.statSource(`${KEY}/media/link-out.mp4`);
    const head = await rig.service.headInfo(`${KEY}/media/link-out.mp4`);
    for (const result of [open, stat, head]) {
      expectFailure(result);
      expect(result.status).toBe(404);
      expect(result.code).toBe('MEDIA_NOT_FOUND');
    }
  });

  it('文件为 symlink 指向根内另一真实文件 → 也拒绝(根内符号链接同样不跟随)', async () => {
    const rig = makeStandardRig();
    fs.symlinkSync(
      path.join(rig.root, 'media', 'fixture-movie.mp4'),
      path.join(rig.root, 'media', 'link-inside.mp4'),
    );
    const result = await rig.service.openRange(`${KEY}/media/link-inside.mp4`);
    expectFailure(result);
    expect(result.status).toBe(404);
  });

  it('中间目录环节为 symlink → 404', async () => {
    const rig = makeStandardRig();
    const outside = registerTempDir('hmp-nas-reader-outside-');
    fs.mkdirSync(path.join(outside, 'sub'));
    fs.writeFileSync(path.join(outside, 'sub', 'x.mp4'), patternBytes(8));
    fs.symlinkSync(path.join(outside, 'sub'), path.join(rig.root, 'media-link'));
    const result = await rig.service.openRange(`${KEY}/media-link/x.mp4`);
    expectFailure(result);
    expect(result.status).toBe(404);
  });
});

/* ------------------------------------------------------------------ */
/* 3. size/mtime:statSource 与打开期复核(源变化可检测,供 T028 停旧 session) */
/* ------------------------------------------------------------------ */

describe('T020 size/mtime 校验与源变化检测', () => {
  it('statSource 返回 size/mtimeMs/mtimeNs,与 fs.statSync 一致,并带容器派生 contentType', async () => {
    const rig = makeStandardRig();
    const result = await rig.service.statSource(rig.location);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const raw = fs.statSync(path.join(rig.root, 'media', 'fixture-movie.mp4'), { bigint: true });
    expect(result.value.size).toBe(Number(raw.size));
    expect(result.value.size).toBe(64 * 1024);
    expect(Math.abs(result.value.mtimeMs - Number(raw.mtimeMs))).toBeLessThan(1);
    expect(result.value.mtimeNs).toBe(raw.mtimeNs.toString());
    expect(result.value.contentType).toBe('video/mp4');
  });

  it('stat 与 open 之间源被改写(size 变化)→ 503 PLAYBACK_RESOURCE_UNAVAILABLE + sourceChanged 标记', async () => {
    const rig = makeStandardRig();
    let openCalls = 0;
    const service = new NasReaderService({
      mediaRoots: { [KEY]: rig.root },
      openFile: async (filePath: string, flags: string): Promise<FileHandle> => {
        openCalls += 1;
        // 模拟 stat→open 窗口内源被替换(另一写者/同步任务改写)
        fs.writeFileSync(path.join(rig.root, 'media', 'fixture-movie.mp4'), patternBytes(1024));
        return fsp.open(filePath, flags);
      },
    });
    const result = await service.openRange(rig.location);
    expect(openCalls).toBe(1);
    expectFailure(result);
    expect(result.status).toBe(503);
    expect(result.code).toBe('PLAYBACK_RESOURCE_UNAVAILABLE');
    expect(result.sourceChanged).toBe(true);
    expect(JSON.stringify(result)).not.toContain(rig.root);
  });

  it('size 不变但 mtime 变化 → 同样检出 sourceChanged(复核比对含 mtimeNs)', async () => {
    const rig = makeStandardRig();
    const service = new NasReaderService({
      mediaRoots: { [KEY]: rig.root },
      openFile: async (opened: string, flags: string): Promise<FileHandle> => {
        // 等长改写 + 显式推进 mtime(size 复核无法发现,mtimeNs 必须发现)
        fs.writeFileSync(opened, patternBytes(64 * 1024));
        const future = new Date(Date.now() + 60_000);
        fs.utimesSync(opened, future, future);
        return fsp.open(opened, flags);
      },
    });
    const result = await service.openRange(rig.location);
    expectFailure(result);
    expect(result.status).toBe(503);
    expect(result.sourceChanged).toBe(true);
  });

  it('源在 walk 后、open 前被删除(非变化类 IO 故障)→ 503 problem 可渲染载荷', async () => {
    const rig = makeStandardRig();
    const service = new NasReaderService({
      mediaRoots: { [KEY]: rig.root },
      openFile: async (opened: string, flags: string): Promise<FileHandle> => {
        fs.rmSync(opened, { force: true });
        return fsp.open(opened, flags);
      },
    });
    const result = await service.openRange(rig.location);
    expectFailure(result);
    expect(result.status).toBe(503);
    expect(result.code).toBe('PLAYBACK_RESOURCE_UNAVAILABLE');
    expect(typeof result.detail).toBe('string');
    expect(result.detail).not.toContain(rig.root);
  });
});

/* ------------------------------------------------------------------ */
/* 4. Range 解析纯函数:单区间三形态 + 416/400 语义                      */
/* ------------------------------------------------------------------ */

describe('T020 parseByteRange 纯函数', () => {
  const SIZE = 64 * 1024;

  it('无 Range 头(null/undefined)→ full(200 语义)', () => {
    expect(parseByteRange(null, SIZE)).toEqual({ kind: 'full' });
    expect(parseByteRange(undefined, SIZE)).toEqual({ kind: 'full' });
  });

  it('bytes=a-b / a- / -suffix 三形态 → 正确 offset/length', () => {
    expect(parseByteRange('bytes=0-0', SIZE)).toEqual({ kind: 'single', start: 0, endInclusive: 0 });
    expect(parseByteRange('bytes=100-199', SIZE)).toEqual({ kind: 'single', start: 100, endInclusive: 199 });
    expect(parseByteRange('bytes=100-', SIZE)).toEqual({ kind: 'single', start: 100, endInclusive: SIZE - 1 });
    expect(parseByteRange('bytes=-100', SIZE)).toEqual({
      kind: 'single',
      start: SIZE - 100,
      endInclusive: SIZE - 1,
    });
    // suffix 超过文件长度 → 整个文件
    expect(parseByteRange('bytes=-70000', SIZE)).toEqual({
      kind: 'single',
      start: 0,
      endInclusive: SIZE - 1,
    });
    // end 超界 → 截到 size-1(仍是 206,不是 200)
    expect(parseByteRange('bytes=0-999999', SIZE)).toEqual({
      kind: 'single',
      start: 0,
      endInclusive: SIZE - 1,
    });
  });

  it('越界(start ≥ size)→ unsatisfiable(416 语义,携带合法范围提示所需 size)', () => {
    expect(parseByteRange(`bytes=${SIZE}-`, SIZE)).toEqual({ kind: 'unsatisfiable', size: SIZE });
    expect(parseByteRange(`bytes=${SIZE + 500}-`, SIZE)).toEqual({ kind: 'unsatisfiable', size: SIZE });
    expect(parseByteRange(`bytes=${SIZE}-${SIZE + 10}`, SIZE)).toEqual({ kind: 'unsatisfiable', size: SIZE });
    expect(parseByteRange('bytes=-0', SIZE)).toEqual({ kind: 'unsatisfiable', size: SIZE });
    expect(parseByteRange('bytes=0-', 0)).toEqual({ kind: 'unsatisfiable', size: 0 });
  });

  it('多区间(含逗号)/空 Range/非法语法/非 bytes 单位/不安全整数 → invalid(400 语义)', () => {
    for (const header of [
      'bytes=0-1,5-9',
      'bytes=0-1,',
      '',
      'bytes=',
      'bytes=abc',
      'bytes=5-2',
      'bytes=1e3-2000',
      'bytes=+1-5',
      'bytes= 0-5',
      'items=0-5',
      'bytes=-',
    ]) {
      const parsed = parseByteRange(header, SIZE);
      expect(parsed.kind, `header=${header}`).toBe('invalid');
    }
    expect(parseByteRange('bytes=9223372036854775807-', SIZE).kind).toBe('invalid');
  });
});

/* ------------------------------------------------------------------ */
/* 5. openRange:200/206/416/400 判别结果                                */
/* ------------------------------------------------------------------ */

describe('T020 openRange 判别语义', () => {
  it('无 Range → 200 全量:Content-Length=size、contentRange=null、字节与源一致、Accept-Ranges: bytes', async () => {
    const rig = makeStandardRig();
    const result = await rig.service.openRange(rig.location);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.status).toBe(200);
    expect(result.size).toBe(rig.bytes.length);
    expect(result.contentLength).toBe(rig.bytes.length);
    expect(result.contentRange).toBeNull();
    expect(result.acceptRanges).toBe('bytes');
    expect(result.contentType).toBe('video/mp4');
    expect(result.mtimeMs).toBe(fs.statSync(path.join(rig.root, 'media', 'fixture-movie.mp4')).mtimeMs);
    expect(await collect(result.stream)).toEqual(rig.bytes);
  });

  it('中间单区间 {start:100,end:199} → 206 + Content-Range 一致 + 100 字节正确', async () => {
    const rig = makeStandardRig();
    const result = await rig.service.openRange(rig.location, { start: 100, end: 199 });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.status).toBe(206);
    expect(result.contentLength).toBe(100);
    expect(result.contentRange).toBe(`bytes 100-199/${rig.bytes.length}`);
    expect(await collect(result.stream)).toEqual(rig.bytes.subarray(100, 200));
  });

  it('开区间 {start:100} 与尾区间 {start:size-100,end:size-1} → 206 字节正确(end 为闭区间)', async () => {
    const rig = makeStandardRig();
    const openEnded = await rig.service.openRange(rig.location, { start: 100 });
    expect(openEnded.ok).toBe(true);
    if (!openEnded.ok) return;
    expect(openEnded.status).toBe(206);
    expect(openEnded.contentRange).toBe(`bytes 100-${rig.bytes.length - 1}/${rig.bytes.length}`);
    expect(await collect(openEnded.stream)).toEqual(rig.bytes.subarray(100));

    const tail = await rig.service.openRange(rig.location, { start: rig.bytes.length - 100, end: rig.bytes.length - 1 });
    expect(tail.ok).toBe(true);
    if (!tail.ok) return;
    expect(await collect(tail.stream)).toEqual(rig.bytes.subarray(rig.bytes.length - 100));
  });

  it('end 超界截断 + 单字节边界区间 → 206 正确', async () => {
    const rig = makeStandardRig();
    const clamped = await rig.service.openRange(rig.location, { start: 0, end: 999_999 });
    expect(clamped.ok).toBe(true);
    if (!clamped.ok) return;
    expect(clamped.status).toBe(206);
    expect(clamped.contentRange).toBe(`bytes 0-${rig.bytes.length - 1}/${rig.bytes.length}`);
    expect(await collect(clamped.stream)).toEqual(rig.bytes);

    const last = await rig.service.openRange(rig.location, { start: rig.bytes.length - 1, end: rig.bytes.length - 1 });
    expect(last.ok).toBe(true);
    if (!last.ok) return;
    expect(last.contentLength).toBe(1);
    expect(await collect(last.stream)).toEqual(rig.bytes.subarray(rig.bytes.length - 1));
  });

  it('越界(start ≥ size)→ 416 语义结果(含 status 与合法范围提示 contentRange)', async () => {
    const rig = makeStandardRig();
    for (const range of [{ start: rig.bytes.length }, { start: rig.bytes.length + 500 }, { start: rig.bytes.length, end: rig.bytes.length + 10 }]) {
      const result = await rig.service.openRange(rig.location, range);
      expectFailure(result);
      expect(result.status).toBe(416);
      expect(result.contentRange).toBe(`bytes */${rig.bytes.length}`);
      expect(JSON.stringify(result)).not.toContain(rig.root);
    }
  });

  it('非法数值区间(start>end、负数、非整数)→ 400 语义', async () => {
    const rig = makeStandardRig();
    for (const range of [{ start: 200, end: 100 }, { start: -1 }, { start: 1.5 }, { end: -5 }]) {
      const result = await rig.service.openRange(rig.location, range);
      expectFailure(result);
      expect(result.status).toBe(400);
    }
  });

  it('不存在的源 → 打开前判别失败(可渲染 problem),不产生流', async () => {
    const rig = makeStandardRig();
    const result = await rig.service.openRange(`${KEY}/media/missing-movie.mp4`);
    expectFailure(result);
    expect(typeof result.status).toBe('number');
    expect('stream' in result).toBe(false);
  });
});

/* ------------------------------------------------------------------ */
/* 6. 流式与背压:任意区间不整片读取;HEAD 无体                           */
/* ------------------------------------------------------------------ */

describe('T020 流式读取与背压', () => {
  it('64KiB 文件中间 1KiB 区间:交付字节=区间长度,底层 bytesRead=区间长度(不整片读取)', async () => {
    const rig = makeStandardRig();
    const result = await rig.service.openRange(rig.location, { start: 32768, end: 33791 });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const received = await collect(result.stream);
    expect(received.length).toBe(1024);
    expect(received).toEqual(rig.bytes.subarray(32768, 33792));
    // fs.ReadStream.bytesRead = 底层 read() 实际字节数;位置化读取只消耗区间长度,
    // 远小于整文件(若整片读入则 ≥ 65536)。zero-copy 断言口径:read 字节 ≡ 区间长度。
    const raw = result.stream as fs.ReadStream;
    expect(raw.bytesRead).toBe(1024);
    expect(raw.bytesRead).toBeLessThan(rig.bytes.length / 2);
  });

  it('HEAD 语义:headInfo 返回 size/mime/Accept-Ranges 元数据,不产生任何响应体流', async () => {
    const rig = makeStandardRig();
    const result = await rig.service.headInfo(rig.location);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect('stream' in result.value).toBe(false);
    expect(result.value.size).toBe(64 * 1024);
    expect(result.value.contentType).toBe('video/mp4');
    expect(result.value.acceptRanges).toBe('bytes');
  });
});

/* ------------------------------------------------------------------ */
/* 7. 未发 header 错误 vs 已发送后流中途错误                             */
/* ------------------------------------------------------------------ */

describe('T020 打开前 problem 与流中途错误分流', () => {
  it('打开前错误:返回判别失败载荷(status/code/detail 可直接渲染 problem),不含路径', async () => {
    const rig = makeStandardRig();
    const missing = await rig.service.openRange(`${KEY}/media/missing.mp4`);
    expectFailure(missing);
    expect(missing.status).toBe(404);
    expect(missing.code).toBe('MEDIA_NOT_FOUND');
    expect(typeof missing.detail).toBe('string');
    // 打开前失败绝不返回流 —— 控制器(T031)可安全渲染 problem+json
    expect('stream' in missing).toBe(false);
  });

  it('流中途错误:openRange 先成功(头部已可发送),IO 错误经流 error 事件携带稳定码且不含路径', async () => {
    // 256KiB > 默认 64KiB 高水位,保证多次底层 read;首块后从底层关闭 fd → 后续 read EBADF
    const root = registerTempDir('hmp-nas-reader-midstream-');
    fs.mkdirSync(path.join(root, 'media'), { recursive: true });
    const big = patternBytes(256 * 1024);
    fs.writeFileSync(path.join(root, 'media', 'big-movie.mp4'), big);
    const service = new NasReaderService({ mediaRoots: { [KEY]: root } });

    const result = await service.openRange(`${KEY}/media/big-movie.mp4`);
    // 关键断言:错误发生前结果已 ok —— 服务层已把「头部阶段」交付给调用方
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const raw = result.stream as fs.ReadStream;
    const events: string[] = [];
    let errorMessage = '';
    let errorCode = '';
    let stableCode = '';
    let sawEnd = false;
    raw.on('error', (error: NodeJS.ErrnoException & { stableCode?: string }) => {
      events.push('error');
      errorMessage = String(error.message);
      errorCode = String(error.code ?? '');
      stableCode = String(error.stableCode ?? '');
    });
    raw.on('end', () => {
      sawEnd = true;
      events.push('end');
    });
    raw.on('data', () => {
      // 首块已交付(等价于响应头/部分字节已发出)后制造真实 IO 故障。
      // fd 为 ReadStream 运行时属性(类型未声明),经窄化读取。
      const fd = (raw as unknown as { fd: number | null }).fd;
      if (fd !== null && events.length === 0) {
        try {
          fs.closeSync(fd);
          events.push('fd-closed');
        } catch {
          events.push('fd-close-failed');
        }
      }
    });
    await new Promise<void>((resolve) => raw.on('close', resolve));

    expect(events).toContain('fd-closed');
    expect(events).toContain('error');
    expect(sawEnd).toBe(false);
    expect(errorCode).toBe('EBADF');
    // 流中途错误带稳定码(供 T028 写会话失败码),且消息不含绝对路径
    expect(stableCode).toBe('PLAYBACK_RESOURCE_UNAVAILABLE');
    expect(errorMessage).not.toContain(root);
  });
});

/* ------------------------------------------------------------------ */
/* 8. 只读保证与 API 面                                                 */
/* ------------------------------------------------------------------ */

describe('T020 只读保证', () => {
  it('打开仅使用只读 flag「r」;statSource/headInfo 完全不打开文件', async () => {
    const rig = makeStandardRig();
    const openedWith: { filePath: string; flags: string }[] = [];
    const service = new NasReaderService({
      mediaRoots: { [KEY]: rig.root },
      openFile: async (filePath: string, flags: string): Promise<FileHandle> => {
        openedWith.push({ filePath, flags });
        return fsp.open(filePath, flags);
      },
    });
    await service.headInfo(rig.location);
    await service.statSource(rig.location);
    expect(openedWith).toHaveLength(0);
    const open = await service.openRange(rig.location, { start: 0, end: 9 });
    expect(open.ok).toBe(true);
    expect(openedWith).toHaveLength(1);
    expect(openedWith[0]?.flags).toBe('r');
    await collect((open as { ok: true; stream: Readable }).stream);
  });

  it('API 面断言:服务原型只暴露 openRange/statSource/headInfo,不存在任何写路径方法', () => {
    const methods = Object.getOwnPropertyNames(NasReaderService.prototype)
      .filter((name) => name !== 'constructor')
      .sort();
    expect(methods).toEqual(['headInfo', 'openRange', 'statSource']);
  });
});

/* ------------------------------------------------------------------ */
/* 9. 容器派生 contentType                                              */
/* ------------------------------------------------------------------ */

describe('T020 nasContentType 容器派生(与 nas-scanner 支持扩展名对齐)', () => {
  it('mp4/m4v/mkv/mov/avi/webm/ts → 标准 MIME;大小写不敏感;未知/无扩展名 → null', () => {
    expect(nasContentType('media/a.mp4')).toBe('video/mp4');
    expect(nasContentType('media/a.MP4')).toBe('video/mp4');
    expect(nasContentType('media/a.m4v')).toBe('video/mp4');
    expect(nasContentType('media/a.mkv')).toBe('video/x-matroska');
    expect(nasContentType('media/a.mov')).toBe('video/quicktime');
    expect(nasContentType('media/a.avi')).toBe('video/x-msvideo');
    expect(nasContentType('media/a.webm')).toBe('video/webm');
    expect(nasContentType('media/a.ts')).toBe('video/mp2t');
    expect(nasContentType('media/a.xyz')).toBeNull();
    expect(nasContentType('media/noextension')).toBeNull();
  });

  it('openRange/headInfo 携带派生 contentType(mkv → video/x-matroska)', async () => {
    const root = registerTempDir('hmp-nas-reader-mime-');
    fs.writeFileSync(path.join(root, 'sample.mkv'), patternBytes(64));
    const service = new NasReaderService({ mediaRoots: { [KEY]: root } });
    const head = await service.headInfo(`${KEY}/sample.mkv`);
    expect(head.ok).toBe(true);
    if (head.ok) {
      expect(head.value.contentType).toBe('video/x-matroska');
    }
    const open = await service.openRange(`${KEY}/sample.mkv`);
    expect(open.ok).toBe(true);
    if (open.ok) {
      expect(open.contentType).toBe('video/x-matroska');
      await collect(open.stream);
    }
  });
});
