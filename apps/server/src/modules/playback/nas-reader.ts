import { createReadStream } from 'node:fs';
import type { BigIntStats } from 'node:fs';
import fsPromises from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import path from 'node:path';
import { Readable } from 'node:stream';
import { Injectable } from '@nestjs/common';
import type { MediaRoots } from '../../config/env.schema';
import { findNasTargetDenial } from '@contexts/sources/domain/source-target.validation';
import type { SupportedMediaExtension } from '@contexts/sources/infrastructure/nas-scanner';
import type { PlaybackErrorCode } from './playback.types';

/**
 * NAS 只读安全文件读取器(T020,spec 004)—— direct 交付的源端安全边界。
 *
 * 权威依据:
 * - tasks.md T020:只读安全文件描述符输入、root/路径/符号链接/size/mtime 校验及单 Range/
 *   HEAD/backpressure;源变化停止旧 session(本层只产出可检测结果,停止动作属 T028),
 *   数 GB 任意区间不整片读取,未发 header 返回 problem、已发送则关闭流;
 * - research.md R3(NAS 输入安全):经验证的只读文件描述符输入,拒绝越界/符号链接且核对
 *   size/mtime;Range 只允许单区间,206/416 标准语义,HEAD 无响应体;
 * - contracts/api.md「媒体端点」+ contracts/openapi.yaml 同端点错误表:
 *   GET/HEAD/单 Range(200/206、Accept-Ranges: bytes、Content-Length/Content-Range 一致;
 *   越界 416,多个 Range 400;HEAD 与 GET 同鉴权且不发送字节);源故障未发 headers 时
 *   problem → 503 PLAYBACK_RESOURCE_UNAVAILABLE;已发字节则由调用方关闭流(错误经流事件,
 *   不在字节流内注入 JSON);
 * - data-model.md「## 验证与恢复」:资源输入 size/mtime 改变或 root 授权失效停止旧 session
 *   —— statSource(location) 供 T028 周期检测,openRange 在打开期对已打开描述符复核
 *   (fstat 与 walk 期 lstat 比对 size + mtimeNs),不一致返回 sourceChanged 判别失败。
 *
 * 复用的既有 root 授权事实(不重造):
 * - env.schema.ts `MediaRoots`(MEDIA_ROOTS rootKey→只读挂载绝对路径,部署层唯一授权入口);
 * - sources/source-target.validation.ts `findNasTargetDenial`(rootKey 注册校验 + 根内相对
 *   路径形态规则:空字节/反斜杠/绝对路径·盘符/空段·点段·..段,与 nas-scanner 同口径);
 * - imports/nas-scanner.ts 的逐段 lstat + 符号链接拒绝 + realpath 边界(withinRoot 语义)
 *   步骤 1~4 作为本文件 resolveSource 的对齐实现(该逻辑未从 scanner 导出,故按同语义落此);
 * - imports/nas-scanner.ts `SUPPORTED_MEDIA_EXTENSIONS` 约束容器派生 MIME 的键域。
 *
 * 安全机制(全部只读,无任何写路径):
 * - location = `${rootKey}/${relativePath}`(refresh-publish.service.ts 落库权威形态);
 *   rootKey 未注册/路径形态非法/任一环节符号链接/越出授权根/目标非普通文件 → 统一
 *   404 MEDIA_NOT_FOUND 同形(detail 为静态脱敏文案,不含 rootKey/绝对路径/存在性差异);
 * - 打开一律 `fsPromises.open(path, 'r')` 只读 flag;打开后以 fstat 复核 size+mtimeNs,
 *   窗口内源被改写 → 503 + sourceChanged 标记(供上层停止旧 session);
 * - Range 以 `fs.createReadStream('', { fd, start, end })` 位置化读取交付,
 *   数 GB 文件任意区间仅实际读取请求字节(ReadStream.bytesRead ≡ 区间长度),不整片入内存;
 * - 流中途错误经流 'error' 事件交付并标注稳定码(PLAYBACK_RESOURCE_UNAVAILABLE),
 *   fd 形态打开使错误消息不含路径,防御性再剥离 err.path;
 * - 错误分流:openRange 返回判别结果 —— 打开前失败 { ok:false, status, code, detail }
 *   由控制器(T031)直接渲染 problem;打开成功后故障属流中途,经流事件交付。
 */

/**
 * 本层失败码域:004 播放稳定码(PlaybackErrorCode,playback.types) + 两个既有共享码:
 * - MEDIA_NOT_FOUND:404 同形不可见(contracts「稳定错误」节;走 DOMAIN_PROBLEM_REGISTRY 渲染);
 * - VALIDATION_FAILED:既有通用 400 —— 契约未设 Range 专用稳定码(openapi 400/416 仅描述
 *   语义未命名码),400 非法 Range/416 越界暂以此承载,T031 接线时如契约增补专用码再收窄。
 */
export type NasReaderFailureCode = PlaybackErrorCode | 'MEDIA_NOT_FOUND' | 'VALIDATION_FAILED';

/** 404 统一同形 detail(不泄漏存在性/原因差异,contracts「稳定错误」节) */
const MEDIA_NOT_FOUND_DETAIL = '媒体不存在或当前不可见';

/* ------------------------------------------------------------------ */
/* 容器派生 MIME(键域对齐 nas-scanner 支持扩展名)                       */
/* ------------------------------------------------------------------ */

const NAS_MIME_BY_EXTENSION: Readonly<Record<SupportedMediaExtension, string>> = {
  mp4: 'video/mp4',
  m4v: 'video/mp4',
  mkv: 'video/x-matroska',
  mov: 'video/quicktime',
  avi: 'video/x-msvideo',
  webm: 'video/webm',
  ts: 'video/mp2t',
};

/** 由路径扩展名派生交付 MIME;未知扩展名/无扩展名 → null(交由上层按 playback_source.mime_type 兜底) */
export function nasContentType(filePath: string): string | null {
  const extension = path.extname(filePath).slice(1).toLowerCase();
  if (extension === '') {
    return null;
  }
  return (NAS_MIME_BY_EXTENSION as Readonly<Record<string, string | undefined>>)[extension] ?? null;
}

/* ------------------------------------------------------------------ */
/* Range 解析纯函数(单区间 bytes;a-b / a- / -suffix;206/416/400 语义)  */
/* ------------------------------------------------------------------ */

/** 解析结果:full=200;single=206(已按 size 截断);unsatisfiable=416;invalid=400 */
export type ParsedByteRange =
  | { readonly kind: 'full' }
  | { readonly kind: 'single'; readonly start: number; readonly endInclusive: number }
  | { readonly kind: 'unsatisfiable'; readonly size: number }
  | { readonly kind: 'invalid'; readonly reason: string };

/**
 * 解析单区间 Range 头(以已知 size 截断/判定可满足性)。
 * - 无头 → full(200 全量);
 * - `bytes=a-b`/`bytes=a-`/`bytes=-suffix` → single(start..endInclusive 闭区间);
 *   end 超界截到 size-1;suffix 超过 size 取整个文件;
 * - start ≥ size(含空文件)或 suffix=0 → unsatisfiable(416,携带 Content-Range 越界提示:星号
 *   占位形态 bytes <星号>/size,total=size);
 * - 多区间(逗号)/空值/非法语法/非 bytes 单位/不安全整数 → invalid(400);
 *   说明:RFC 7233 对不支持单位本应「忽略」,此处按契约安全口径收紧为 400
 *   (contracts:多个 Range 400;非法语法 → 400),浏览器/curl 仅发送 bytes=。
 */
export function parseByteRange(header: string | null | undefined, size: number): ParsedByteRange {
  if (header === null || header === undefined) {
    return { kind: 'full' };
  }
  const trimmed = header.trim();
  const unitSeparator = trimmed.indexOf('=');
  if (unitSeparator === -1) {
    return { kind: 'invalid', reason: 'Range 头缺少「=」' };
  }
  // 严格语法:「=」两侧不允许内部空白(仅首尾 OWS 由外层 trim 消化),
  // 防解析器分歧绕过(与 source-target.validation 的严格路径语法同口径)
  const unit = trimmed.slice(0, unitSeparator);
  const value = trimmed.slice(unitSeparator + 1);
  if (unit !== 'bytes') {
    return { kind: 'invalid', reason: 'Range 仅支持 bytes 单位' };
  }
  if (value === '') {
    return { kind: 'invalid', reason: 'Range 值为空' };
  }
  if (value.includes(',')) {
    return { kind: 'invalid', reason: 'Range 仅允许单区间,不允许多区间' };
  }

  const closedForm = /^(\d+)-(\d+)$/.exec(value);
  if (closedForm !== null) {
    const start = Number(closedForm[1]);
    const end = Number(closedForm[2]);
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end)) {
      return { kind: 'invalid', reason: 'Range 数值超出安全整数范围' };
    }
    if (start > end) {
      return { kind: 'invalid', reason: 'Range 起始位置大于结束位置' };
    }
    if (start >= size) {
      return { kind: 'unsatisfiable', size };
    }
    return { kind: 'single', start, endInclusive: Math.min(end, size - 1) };
  }

  const openEndedForm = /^(\d+)-$/.exec(value);
  if (openEndedForm !== null) {
    const start = Number(openEndedForm[1]);
    if (!Number.isSafeInteger(start)) {
      return { kind: 'invalid', reason: 'Range 数值超出安全整数范围' };
    }
    if (start >= size) {
      return { kind: 'unsatisfiable', size };
    }
    return { kind: 'single', start, endInclusive: size - 1 };
  }

  const suffixForm = /^-(\d+)$/.exec(value);
  if (suffixForm !== null) {
    const suffixLength = Number(suffixForm[1]);
    if (!Number.isSafeInteger(suffixLength)) {
      return { kind: 'invalid', reason: 'Range 数值超出安全整数范围' };
    }
    if (suffixLength === 0 || size === 0) {
      return { kind: 'unsatisfiable', size };
    }
    return { kind: 'single', start: Math.max(0, size - suffixLength), endInclusive: size - 1 };
  }

  return { kind: 'invalid', reason: 'Range 语法非法(仅支持 bytes=a-b / a- / -suffix)' };
}

/* ------------------------------------------------------------------ */
/* 判别结果类型                                                         */
/* ------------------------------------------------------------------ */

/** 打开前失败载荷:控制器(T031)可直接按 status/code/detail 渲染 problem+json */
export interface NasReadFailure {
  readonly ok: false;
  /** HTTP 语义状态:400 Range 非法;404 同形不可见;416 越界;503 源故障 */
  readonly status: 400 | 404 | 416 | 503;
  readonly code: NasReaderFailureCode;
  /** 静态脱敏文案:绝不含 rootKey/绝对路径/存在性差异 */
  readonly detail: string;
  /** 416 时携带合法范围提示(Content-Range 越界占位形态,bytes <星号>/size) */
  readonly contentRange?: string;
  /** true = 源 size/mtime 在打开窗口内变化,上层(T028)应停止旧 session 并重新解析 */
  readonly sourceChanged?: boolean;
}

/** openRange 成功载荷(流式,调用方负责消费/断开;错误经流事件) */
export interface NasRangePayload {
  readonly ok: true;
  readonly status: 200 | 206;
  /** 位置化读取流(autoClose;销毁即关闭底层只读描述符) */
  readonly stream: Readable;
  /** 源文件全量字节数(Content-Range total) */
  readonly size: number;
  readonly mtimeMs: number;
  /** 纳秒精度 mtime(字符串承载 BigInt,供上层精确比对) */
  readonly mtimeNs: string;
  /** 容器派生 MIME;未知扩展名为 null */
  readonly contentType: string | null;
  /** 本次将发送的字节数(Content-Length) */
  readonly contentLength: number;
  /** 206 时为 `bytes start-end/size`,200 时为 null */
  readonly contentRange: string | null;
  readonly acceptRanges: 'bytes';
}

export type NasOpenRangeResult = NasRangePayload | NasReadFailure;

/** 源当前事实(statSource):供 T028 周期检测 size/mtime 变化 */
export interface NasSourceStat {
  readonly size: number;
  readonly mtimeMs: number;
  readonly mtimeNs: string;
  readonly contentType: string | null;
}

export type NasStatResult = { readonly ok: true; readonly value: NasSourceStat } | NasReadFailure;

/** HEAD 元数据(headInfo):与 GET 同鉴权同校验,不产生响应体流 */
export interface NasHeadInfo {
  readonly size: number;
  readonly mtimeMs: number;
  readonly mtimeNs: string;
  readonly contentType: string | null;
  readonly acceptRanges: 'bytes';
}

export type NasHeadResult = { readonly ok: true; readonly value: NasHeadInfo } | NasReadFailure;

/** openRange 数值区间入参:start/end 均为闭区间字节偏移(HTTP byte-range 语义) */
export interface NasRangeRequest {
  readonly start?: number;
  readonly end?: number;
}

/* ------------------------------------------------------------------ */
/* 依赖与默认实现                                                       */
/* ------------------------------------------------------------------ */

export interface NasReaderDeps {
  /** 部署 MEDIA_ROOTS(env.schema.ts mediaRootsSchema 解析产物;唯一 root 授权入口) */
  readonly mediaRoots: MediaRoots;
  /**
   * 测试钩子:拦截文件打开(断言只读 flag/注入打开窗口期故障)。
   * 缺省 fsPromises.open;实现必须以 'r' 只读 flag 调用。
   */
  readonly openFile?: (filePath: string, flags: string) => Promise<FileHandle>;
  /**
   * 测试钩子:替换 Range 流工厂(注入流中途故障)。工厂接手描述符生命周期
   * (随流 end/error/destroy 关闭);缺省 fs.createReadStream(autoClose: true)。
   */
  readonly streamFactory?: (
    handle: FileHandle,
    range: { readonly start: number; readonly endInclusive: number },
  ) => Readable;
}

const defaultOpenFile = (filePath: string, flags: string): Promise<FileHandle> => fsPromises.open(filePath, flags);

const defaultRangeStream = (
  handle: FileHandle,
  range: { readonly start: number; readonly endInclusive: number },
): Readable => {
  // 空文件全量读(endInclusive < start):直接交付空流并释放描述符
  if (range.endInclusive < range.start) {
    void handle.close().catch(() => undefined);
    return Readable.from([]);
  }
  // path 传空串:fd 已提供时 Node 忽略 path(不发起路径打开,错误消息天然不含路径);
  // PathLike 类型不接受 null,空串等价且类型安全
  return createReadStream('', {
    fd: handle,
    start: range.start,
    end: range.endInclusive,
    autoClose: true,
  });
};

/** 流中途错误标注:稳定码 + 脱敏(错误消息不含路径;防御性剥离 err.path) */
function attachStableStreamError(stream: Readable): void {
  stream.on('error', (error: NodeJS.ErrnoException) => {
    const annotated = error as NodeJS.ErrnoException & {
      stableCode?: NasReaderFailureCode;
      sourceChanged?: boolean;
    };
    if (annotated.stableCode === undefined) {
      annotated.stableCode = 'PLAYBACK_RESOURCE_UNAVAILABLE';
    }
    if (annotated.sourceChanged === undefined) {
      annotated.sourceChanged = false;
    }
    if (annotated.path !== undefined) {
      delete annotated.path;
    }
  });
}

/* ------------------------------------------------------------------ */
/* 服务                                                                 */
/* ------------------------------------------------------------------ */

interface NasResolvedSource {
  readonly ok: true;
  readonly absPath: string;
  readonly relativePath: string;
  /** walk 期最终 lstat(bigint 口径,供打开期 fstat 精确比对) */
  readonly sizeBytes: bigint;
  readonly mtimeNsBig: bigint;
}

function notFoundFailure(): NasReadFailure {
  return { ok: false, status: 404, code: 'MEDIA_NOT_FOUND', detail: MEDIA_NOT_FOUND_DETAIL };
}

function rangeInvalidFailure(detail: string): NasReadFailure {
  return { ok: false, status: 400, code: 'VALIDATION_FAILED', detail };
}

function rangeUnsatisfiableFailure(size: number): NasReadFailure {
  return {
    ok: false,
    status: 416,
    code: 'VALIDATION_FAILED',
    detail: 'Range 起始位置超出媒体长度',
    contentRange: `bytes */${size}`,
  };
}

function sourceFailure(sourceChanged: boolean): NasReadFailure {
  return {
    ok: false,
    status: 503,
    code: 'PLAYBACK_RESOURCE_UNAVAILABLE',
    detail: sourceChanged ? '媒体源已变化,旧播放会话已不可靠' : '媒体源读取失败',
    ...(sourceChanged ? { sourceChanged: true } : {}),
  };
}

async function safeClose(handle: FileHandle): Promise<void> {
  try {
    await handle.close();
  } catch {
    // 描述符已随流关闭等场景:清理性关闭失败不掩盖原错误
  }
}

/** realpath 结果是否仍在授权根内(等于根或以根+分隔符为前缀;与 nas-scanner withinRoot 同语义) */
function withinRoot(candidate: string, rootRealPath: string): boolean {
  return candidate === rootRealPath || candidate.startsWith(rootRealPath + path.sep);
}

/** lstat 失败(不存在/权限/竞态)一律返回 null → 由调用方统一 404 同形拒绝 */
async function lstatSafe(candidate: string): Promise<BigIntStats | null> {
  try {
    return await fsPromises.lstat(candidate, { bigint: true });
  } catch {
    return null;
  }
}

/**
 * 纳秒 mtime → 毫秒(与 fs.statSync().mtimeMs 同式:秒×1000 + 纳秒/1e6 的双精度运算)。
 * 不取道 Number(nsBig)/1e6:ns 值(≈1.8e18)超出 MAX_SAFE_INTEGER,整型转 double 的
 * 舍入会与 statSync 的毫秒值在末位 ULP 漂移(nas-reader.spec 以 statSync 比对)。
 */
function mtimeMsOf(mtimeNsBig: bigint): number {
  const seconds = mtimeNsBig / 1_000_000_000n;
  const nanos = mtimeNsBig % 1_000_000_000n;
  return Number(seconds) * 1000 + Number(nanos) / 1_000_000;
}

/**
 * NAS 只读安全文件读取器服务。
 * 无任何写路径(只读 flag 打开;API 面仅 openRange/statSource/headInfo);
 * 不持有根以外状态,可按请求频次安全复用。
 */
@Injectable()
export class NasReaderService {
  constructor(private readonly deps: NasReaderDeps) {}

  /**
   * 打开 `rootKey/relativePath` 的(单区间)只读流。
   * 打开前失败返回判别错误(可渲染 problem);成功后流中途错误经流 'error' 事件
   * 交付(已标注稳定码,不含路径)—— 调用方此时不得再向已发送头部的响应写 JSON。
   */
  async openRange(location: string, range?: NasRangeRequest): Promise<NasOpenRangeResult> {
    const resolved = await resolveSource(location, this.deps.mediaRoots);
    if (!resolved.ok) {
      return resolved;
    }
    const size = Number(resolved.sizeBytes);
    const numeric = resolveNumericRange(range, size);
    if (!numeric.ok) {
      return numeric.failure;
    }

    let handle: FileHandle;
    try {
      handle = await (this.deps.openFile ?? defaultOpenFile)(resolved.absPath, 'r');
    } catch {
      // walk 期存在、打开期消失/不可读 → 源故障(未发 headers,可渲染 problem)
      return sourceFailure(false);
    }

    // 打开期复核:fstat 必须与 walk 期 lstat 一致(size + mtimeNs),
    // 窗口内源被改写 → sourceChanged(供上层停止旧 session,data-model「验证与恢复」)
    try {
      const openStat = await handle.stat({ bigint: true });
      if (openStat.size !== resolved.sizeBytes || openStat.mtimeNs !== resolved.mtimeNsBig) {
        await safeClose(handle);
        return sourceFailure(true);
      }
    } catch {
      await safeClose(handle);
      return sourceFailure(false);
    }

    const stream = (this.deps.streamFactory ?? defaultRangeStream)(handle, {
      start: numeric.start,
      endInclusive: numeric.endInclusive,
    });
    attachStableStreamError(stream);

    const partial = numeric.partial;
    return {
      ok: true,
      status: partial ? 206 : 200,
      stream,
      size,
      mtimeMs: mtimeMsOf(resolved.mtimeNsBig),
      mtimeNs: resolved.mtimeNsBig.toString(),
      contentType: nasContentType(resolved.relativePath),
      contentLength: numeric.endInclusive - numeric.start + 1,
      contentRange: partial ? `bytes ${numeric.start}-${numeric.endInclusive}/${size}` : null,
      acceptRanges: 'bytes',
    };
  }

  /**
   * 读取源当前事实(size/mtime,容器派生 MIME):供上层周期比对以停止旧 session。
   * 校验面与 openRange 完全一致(root/路径/符号链接/边界),但不打开文件、不产生流。
   */
  async statSource(location: string): Promise<NasStatResult> {
    const resolved = await resolveSource(location, this.deps.mediaRoots);
    if (!resolved.ok) {
      return resolved;
    }
    return {
      ok: true,
      value: {
        size: Number(resolved.sizeBytes),
        mtimeMs: mtimeMsOf(resolved.mtimeNsBig),
        mtimeNs: resolved.mtimeNsBig.toString(),
        contentType: nasContentType(resolved.relativePath),
      },
    };
  }

  /**
   * HEAD 元数据(与 GET 同校验面):Accept-Ranges/size/MIME,不产生任何响应体流。
   * Range 元信息(206/416 语义)由控制器以 parseByteRange(header, head.value.size) 判定。
   */
  async headInfo(location: string): Promise<NasHeadResult> {
    const resolved = await resolveSource(location, this.deps.mediaRoots);
    if (!resolved.ok) {
      return resolved;
    }
    return {
      ok: true,
      value: {
        size: Number(resolved.sizeBytes),
        mtimeMs: mtimeMsOf(resolved.mtimeNsBig),
        mtimeNs: resolved.mtimeNsBig.toString(),
        contentType: nasContentType(resolved.relativePath),
        acceptRanges: 'bytes',
      },
    };
  }
}

/* ------------------------------------------------------------------ */
/* 位置解析与安全 walk(模块级:复用既有 root 授权事实,不进原型 API 面)     */
/* ------------------------------------------------------------------ */

/**
 * 位置解析与安全 walk(校验顺序 = 授权事实层级):
 * 1. location 必须为 `rootKey/relativePath`(refresh-publish 落库权威形态);
 * 2. findNasTargetDenial:rootKey 已注册 + 相对路径形态合法(空字节/反斜杠/绝对路径/
 *    盘符/空段·点段·..段 → 全部拒绝;与 nas-scanner/source-target.validation 同口径);
 * 3. realpath(授权根)为边界基准 → 逐段 lstat:任一环节符号链接即拒绝;中间段必须
 *    是目录,末段必须是普通文件(排除目录/FIFO/设备);
 * 4. 逐段 realpath 不得越出授权根(withinRoot;防「根内链接→根外目标」绕过);
 * 任一失败统一返回 404 MEDIA_NOT_FOUND 同形,不泄漏存在性/原因/rootKey/绝对路径。
 */
async function resolveSource(location: string, mediaRoots: MediaRoots): Promise<NasResolvedSource | NasReadFailure> {
  const slashIndex = location.indexOf('/');
  if (slashIndex <= 0) {
    return notFoundFailure();
  }
  const rootKey = location.slice(0, slashIndex);
  const relativePath = location.slice(slashIndex + 1);
  if (findNasTargetDenial(rootKey, relativePath, mediaRoots) !== null) {
    return notFoundFailure();
  }
  const rootPath = mediaRoots[rootKey];
  if (rootPath === undefined || rootPath === '') {
    return notFoundFailure();
  }

  let rootRealPath: string;
  try {
    rootRealPath = await fsPromises.realpath(rootPath);
  } catch {
    return notFoundFailure();
  }
  const rootStat = await lstatSafe(rootRealPath);
  if (rootStat === null || !rootStat.isDirectory() || rootStat.isSymbolicLink()) {
    return notFoundFailure();
  }

  // 相对路径为空 = 根本身(目录),不可能是媒体文件 → 同形 404
  const segments = relativePath === '' ? [] : relativePath.split('/');
  if (segments.length === 0) {
    return notFoundFailure();
  }

  let current = rootRealPath;
  let lastStat: BigIntStats | null = null;
  for (let index = 0; index < segments.length; index += 1) {
    const segment = segments[index];
    if (segment === undefined) {
      return notFoundFailure();
    }
    const candidate = path.join(current, segment);
    const stat = await lstatSafe(candidate);
    if (stat === null || stat.isSymbolicLink()) {
      return notFoundFailure();
    }
    const isLast = index === segments.length - 1;
    if (isLast ? !stat.isFile() : !stat.isDirectory()) {
      return notFoundFailure();
    }
    let candidateRealPath: string;
    try {
      candidateRealPath = await fsPromises.realpath(candidate);
    } catch {
      return notFoundFailure();
    }
    if (!withinRoot(candidateRealPath, rootRealPath)) {
      return notFoundFailure();
    }
    current = candidateRealPath;
    lastStat = stat;
  }
  if (lastStat === null) {
    return notFoundFailure();
  }
  return {
    ok: true,
    absPath: current,
    relativePath,
    sizeBytes: lastStat.size,
    mtimeNsBig: lastStat.mtimeNs,
  };
}

/* ------------------------------------------------------------------ */
/* openRange 数值区间判定(闭区间;400/416 语义)                          */
/* ------------------------------------------------------------------ */

type NumericRangeOk =
  | { readonly ok: true; readonly start: number; readonly endInclusive: number; readonly partial: boolean }
  | { readonly ok: false; readonly failure: NasReadFailure };

/** 数值入参 → 区间;start ≥ size → 416;非安全非负整数或 start>end → 400;end 超界截断 */
function resolveNumericRange(range: NasRangeRequest | undefined, size: number): NumericRangeOk {
  const hasStart = range?.start !== undefined;
  const hasEnd = range?.end !== undefined;
  // 无任何区间入参 = 全量 GET(200);空文件亦合法(contentLength 0,空流)
  if (!hasStart && !hasEnd) {
    return { ok: true, start: 0, endInclusive: size - 1, partial: false };
  }
  const start = hasStart ? (range?.start as number) : 0;
  // 416 先于 start>end 判定:`bytes=<size>-` 等价于「自 start 至 EOF」,越界即 unsatisfiable,
  // 不能因「end 缺省为 size-1 < start」被误判为 400
  if (!Number.isSafeInteger(start) || start < 0) {
    return { ok: false, failure: rangeInvalidFailure('Range 偏移必须为非负安全整数') };
  }
  if (start >= size) {
    return { ok: false, failure: rangeUnsatisfiableFailure(size) };
  }
  const requestedEnd = hasEnd ? (range?.end as number) : size - 1;
  if (!Number.isSafeInteger(requestedEnd) || requestedEnd < 0) {
    return { ok: false, failure: rangeInvalidFailure('Range 偏移必须为非负安全整数') };
  }
  if (start > requestedEnd) {
    return { ok: false, failure: rangeInvalidFailure('Range 起始位置大于结束位置') };
  }
  return {
    ok: true,
    start,
    endInclusive: Math.min(requestedEnd, size - 1),
    partial: hasStart || hasEnd,
  };
}
