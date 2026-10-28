import dns from 'node:dns';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import type { LookupFunction } from 'node:net';
import type { LookupAddress, LookupOptions } from 'node:dns';
import { Transform } from 'node:stream';
import type { Readable } from 'node:stream';
import { Injectable } from '@nestjs/common';
import type { LanTarget } from '@platform/config/env.schema';
import type { PlaybackBudgets } from '@platform/config/playback-budgets';
import type { PlaybackErrorCode } from '@contexts/playback/domain/playback.types';

/**
 * HLS 上游安全代理(T021,spec 004)—— 应用层受控 HTTP 读取与每跳精确许可校验。
 *
 * 权威依据:
 * - docs/specs/004-playback-resolver/tasks.md T021:每次 DNS/redirect 验证精确 LAN 许可,
 *   嵌套<=4/清单 2MiB/每清单 10000 URI/redirect<=3/首字节与空闲 15 秒/片 64MiB/key 16 字节;
 *   不向上游转发应用 Cookie/Bearer,不透传 Location/Set-Cookie,断开取消读取;
 * - research.md R3 全文:禁止 FFmpeg 直连远程;redirect 每跳重新校验(首跳许可不豁免后续跳);
 *   流式 backpressure/取消;上游状态/错误映射稳定码,不透传 server 细节;
 * - 预算数值唯一权威:config/playback-budgets.ts hlsUpstream 组(T010),本文件只消费注入的
 *   budgets 对象,自身不持有任何阈值常量;
 * - 验收规约:test/unit/playback/hls-proxy.spec.ts(本实现的行为规约,运行时结果形态以
 *   其断言为准 —— 读成功为 { ok:true, value:{finalUrl,text,contentType} } / 读失败为
 *   { ok:false, code, reason, value:{code,reason} }(value 为失败镜像,便于调用方统一
 *   .value 访问;其中 text/stream 恒为 undefined))。
 *
 * 安全机制:
 * - 每跳校验(含首跳):URL 解析仅接受 http/https;host 精确许可(host/hostPort)或 CIDR
 *   许可(net.BlockList);注入 resolveDns 时解析出的每个 IP 逐个校验(任一未许可即拒绝,
 *   防 DNS 重绑定),解析失败拒绝;redirect 每跳重新调用同一校验;
 * - DNS 钉扎:真实连接经自定义 lookup 解析全部地址并逐个复核许可后钉扎首个地址,
 *   防校验与连接窗口内的 DNS 重绑定;
 * - 凭证边界:向上游请求头恒为空(不携带 Cookie/Authorization/hmp_session);结果对象仅含
 *   finalUrl/text/contentType(或 stream/contentType),不透传上游 Location/Set-Cookie 及
 *   任何响应头;
 * - 预算执行:清单全量缓冲受 maxPlaylistBytes 约束(超限即毁连);资产流受 content-length
 *   预检 + 无长度时的计数 Transform 约束;首字节定时器覆盖连接+响应头,空闲定时器覆盖
 *   body 读取(playlist)或 socket 空闲(response.setTimeout,资产流);
 * - 断开取消:options.signal(AbortSignal)贯通到 http.request,客户端断开即取消上游读取;
 * - 稳定失败映射(规约提案):目标未许可/redirect 超限/超时/尺寸超限/上游状态异常 →
 *   PLAYBACK_RESOURCE_UNAVAILABLE;本层不做清单内容判别(畸形/DRM 属 T022 重写层)。
 *   流中途错误以 Error.code='PLAYBACK_RESOURCE_UNAVAILABLE' 交付(供 T031 映射失败码),
 *   绝不在字节流内注入 JSON。
 */

/** 读失败 reason 全部为静态脱敏文案:不含上游 URL/主机/路径/上游错误细节。 */

/** readPlaylist 成功值:仅此三键(spec 断言 Object.keys 精确相等) */
export interface HlsPlaylistContent {
  /** redirect 收敛后的最终上游 URL(仅服务端内部使用,禁止下发给浏览器) */
  readonly finalUrl: string;
  readonly text: string;
  readonly contentType: string | null;
}

/** readAsset 成功值:流式交付(不整片常驻内存) */
export interface HlsAssetContent {
  readonly stream: Readable;
  readonly contentType: string | null;
}

/** 读失败值镜像:ok=false 时 value.code/reason 与顶层一致,text/stream/finalUrl 恒 undefined */
export interface HlsProxyFailureValue {
  readonly code: PlaybackErrorCode;
  readonly reason: string;
  readonly finalUrl?: undefined;
  readonly text?: undefined;
  readonly stream?: undefined;
  readonly contentType?: undefined;
}

/** 判别读取结果(对齐 hls-proxy.spec 运行时形态;失败携带 value 镜像) */
export type HlsProxyRead<T extends HlsPlaylistContent | HlsAssetContent> =
  | { readonly ok: true; readonly value: T }
  | {
      readonly ok: false;
      readonly code: PlaybackErrorCode;
      readonly reason: string;
      readonly value: HlsProxyFailureValue;
    };

/** readAsset 资产类别:segment/map 类二进制按 segment 预算;key 按 16 字节预算;subtitle 按分片预算 */
export type HlsAssetKind = 'segment' | 'key' | 'subtitle';

export interface HlsProxyReadOptions {
  /** 精确 LAN 许可(与 LAN_ALLOWED_TARGETS 同一 LanTarget 词表);缺省为全拒 */
  readonly allowedTargets?: readonly LanTarget[];
  /** 客户端断开取消:abort 即销毁上游请求/响应 */
  readonly signal?: AbortSignal;
}

export interface HlsAssetReadOptions extends HlsProxyReadOptions {
  readonly kind: HlsAssetKind;
}

export interface UpstreamHopOptions {
  readonly allowedTargets?: readonly LanTarget[];
  /** 注入时按解析结果逐 IP 验证(每次 DNS 验证,R3);未注入时按 URL 字面校验 */
  readonly resolveDns?: (hostname: string) => Promise<readonly string[]>;
}

export type UpstreamHopResult = { readonly ok: true } | { readonly ok: false; readonly reason: string };

/* ------------------------------------------------------------------ */
/* 每跳许可校验(纯函数,无网络副作用;resolveDns 由调用方注入)            */
/* ------------------------------------------------------------------ */

const DENY_REASON = '上游地址未获精确 LAN 许可';
const SCHEME_DENY_REASON = '上游协议不受支持';

/** 主机词相等(域名/IPv4/IPv6 字面统一小写比较) */
function hostEquals(left: string, right: string): boolean {
  return left.toLowerCase() === right.toLowerCase();
}

/** URL 生效端口(缺省按 scheme 补全,hostPort 精确比较用) */
function effectivePort(target: URL): number {
  if (target.port !== '') {
    return Number(target.port);
  }
  return target.protocol === 'https:' ? 443 : 80;
}

/** CIDR 包含判定(net.BlockList;非法子网/家族不符一律不匹配,不抛出) */
function cidrContains(
  cidr: Extract<LanTarget, { kind: 'cidr' }>,
  address: string,
): boolean {
  const family = net.isIP(address);
  if (family === 0 || cidr.family !== family) {
    return false;
  }
  try {
    const blockList = new net.BlockList();
    blockList.addSubnet(cidr.address, cidr.prefixLength, family === 6 ? 'ipv6' : 'ipv4');
    return blockList.check(address, family === 6 ? 'ipv6' : 'ipv4');
  } catch {
    return false;
  }
}

/** IP 地址(含端口语义)对许可表的精确匹配 */
function addressAllowed(address: string, port: number, targets: readonly LanTarget[]): boolean {
  if (net.isIP(address) === 0) {
    return false;
  }
  for (const target of targets) {
    if (target.kind === 'host' && hostEquals(target.host, address)) {
      return true;
    }
    if (target.kind === 'hostPort' && hostEquals(target.host, address) && target.port === port) {
      return true;
    }
    if (target.kind === 'cidr' && cidrContains(target, address)) {
      return true;
    }
  }
  return false;
}

/** 主机名(非 IP 字面)对许可表的字面精确匹配;CIDR 不作用于主机名 */
function hostnameAllowed(hostname: string, port: number, targets: readonly LanTarget[]): boolean {
  if (hostname === '') {
    return false;
  }
  for (const target of targets) {
    if (target.kind === 'host' && hostEquals(target.host, hostname)) {
      return true;
    }
    if (target.kind === 'hostPort' && hostEquals(target.host, hostname) && target.port === port) {
      return true;
    }
  }
  return false;
}

/**
 * 单跳校验纯函数:redirect 每跳都必须重新调用(首跳许可不豁免后续跳,R3)。
 * - 仅 http/https(ftp/data/file/javascript 等一律拒绝,即使地址在许可网段内);
 * - host 字面为 IP → 直接对许可表精确匹配(host/hostPort/CIDR);
 * - host 字面为主机名 + 注入 resolveDns → 每次解析结果的每个 IP 逐个验证(任一未许可
 *   或解析失败/为空即拒绝,防 DNS 重绑定);
 * - 主机名无 resolveDns → 仅当许可表精确许可该主机名时通过。
 */
export async function validateUpstreamHop(url: string, options: UpstreamHopOptions = {}): Promise<UpstreamHopResult> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { ok: false, reason: '上游 URL 非法' };
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return { ok: false, reason: SCHEME_DENY_REASON };
  }
  const hostname = parsed.hostname;
  if (hostname === '') {
    return { ok: false, reason: DENY_REASON };
  }
  const targets = options.allowedTargets ?? [];
  const port = effectivePort(parsed);
  if (net.isIP(hostname) === 0 && options.resolveDns !== undefined) {
    let addresses: readonly string[];
    try {
      addresses = await options.resolveDns(hostname);
    } catch {
      return { ok: false, reason: 'DNS 解析失败' };
    }
    if (addresses.length === 0) {
      return { ok: false, reason: DENY_REASON };
    }
    for (const address of addresses) {
      if (!addressAllowed(address, port, targets)) {
        return { ok: false, reason: DENY_REASON };
      }
    }
    return { ok: true };
  }
  if (net.isIP(hostname) > 0) {
    return addressAllowed(hostname, port, targets) ? { ok: true } : { ok: false, reason: DENY_REASON };
  }
  return hostnameAllowed(hostname, port, targets) ? { ok: true } : { ok: false, reason: DENY_REASON };
}

/* ------------------------------------------------------------------ */
/* HlsProxyService:受控读取(redirect 内部跟随/预算执行/断开取消)         */
/* ------------------------------------------------------------------ */

const REDIRECT_STATUSES: ReadonlySet<number> = new Set([301, 302, 303, 307, 308]);

/** 读取失败构造:失败镜像 value 与顶层 code/reason 同源(规约运行时形态) */
function readFailure<T extends HlsPlaylistContent | HlsAssetContent>(
  code: PlaybackErrorCode,
  reason: string,
): HlsProxyRead<T>;
function readFailure<T extends HlsPlaylistContent | HlsAssetContent>(
  code: PlaybackErrorCode,
  reason: string,
): HlsProxyRead<T> {
  return {
    ok: false,
    code,
    reason,
    value: { code, reason },
  };
}

/** 流中途/定时器错误的稳定码标注(供 T031 落 failure_code;错误消息不含上游细节) */
function codedError(message: string): Error {
  const error: NodeJS.ErrnoException = new Error(message);
  error.code = 'PLAYBACK_RESOURCE_UNAVAILABLE';
  return error;
}

/** 单值化响应头(拒绝数组形态;缺失为 null) */
function headerValue(headers: http.IncomingHttpHeaders, name: string): string | null {
  const value = headers[name];
  if (typeof value === 'string' && value !== '') {
    return value;
  }
  return null;
}

function contentLengthOf(response: http.IncomingMessage): number | null {
  const raw = headerValue(response.headers, 'content-length');
  if (raw === null) {
    return null;
  }
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

/** 打开结果:内部形态(成功/失败判别,失败 reason 静态) */
type OpenOutcome =
  | {
      readonly ok: true;
      readonly request: http.ClientRequest;
      readonly response: http.IncomingMessage;
      readonly finalUrl: string;
    }
  | { readonly ok: false; readonly code: PlaybackErrorCode; readonly reason: string };

@Injectable()
export class HlsProxyService {
  private readonly budgets: PlaybackBudgets;

  constructor(deps: { budgets: PlaybackBudgets }) {
    this.budgets = deps.budgets;
  }

  /** 单跳校验实例入口(与独立纯函数同实现;供 T031 在网关层复用) */
  validateUpstreamHop(url: string, options: UpstreamHopOptions = {}): Promise<UpstreamHopResult> {
    return validateUpstreamHop(url, options);
  }

  /**
   * 读取上游清单文本:GET → 每跳许可校验 → redirect 内部跟随(≤maxRedirects,每跳重新
   * 校验)→ 首字节预算内收头 → 空闲预算内缓冲至多 maxPlaylistBytes → 返回
   * { finalUrl, text, contentType }(仅此三键,不含任何上游响应头)。
   */
  async readPlaylist(url: string, options: HlsProxyReadOptions = {}): Promise<HlsProxyRead<HlsPlaylistContent>> {
    const opened = await this.openWithRedirects(url, options.allowedTargets ?? [], options.signal);
    if (!opened.ok) {
      return readFailure<HlsPlaylistContent>(opened.code, opened.reason);
    }
    const { request, response, finalUrl } = opened;
    const hls = this.budgets.hlsUpstream;
    const maxBytes = hls.maxPlaylistBytes;
    const idleMs = hls.idleTimeoutSeconds * 1000;
    return await new Promise<HlsProxyRead<HlsPlaylistContent>>((resolve) => {
      const chunks: Buffer[] = [];
      let totalBytes = 0;
      let settled = false;
      const settleFailure = (reason: string): void => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(idleTimer);
        response.destroy();
        request.destroy();
        resolve(readFailure<HlsPlaylistContent>('PLAYBACK_RESOURCE_UNAVAILABLE', reason));
      };
      const idleTimer = setTimeout(() => settleFailure('上游数据空闲超时'), idleMs);
      response.on('data', (chunk: Buffer) => {
        idleTimer.refresh();
        if (settled) {
          return;
        }
        totalBytes += chunk.length;
        if (totalBytes > maxBytes) {
          settleFailure('清单超出大小预算');
          return;
        }
        chunks.push(chunk);
      });
      response.on('end', () => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(idleTimer);
        resolve({
          ok: true,
          value: {
            finalUrl,
            text: Buffer.concat(chunks).toString('utf8'),
            contentType: headerValue(response.headers, 'content-type'),
          },
        });
      });
      response.on('error', () => settleFailure('上游读取中断'));
    });
  }

  /**
   * 打开上游资产流:同 readPlaylist 的每跳/redirect/首字节预算;尺寸预算先以
   * content-length 预检(超限未交付即失败),无长度声明时以计数 Transform 硬顶;
   * 返回流附带空闲超时(socket 空闲即毁连)。消费方断开(destroy/signal)即取消上游。
   */
  async readAsset(url: string, options: HlsAssetReadOptions): Promise<HlsProxyRead<HlsAssetContent>> {
    const hls = this.budgets.hlsUpstream;
    const maxBytes = options.kind === 'key' ? hls.maxKeyBytes : hls.maxSegmentBytes;
    const opened = await this.openWithRedirects(url, options.allowedTargets ?? [], options.signal);
    if (!opened.ok) {
      return readFailure<HlsAssetContent>(opened.code, opened.reason);
    }
    const { request, response } = opened;
    const declared = contentLengthOf(response);
    if (declared !== null && declared > maxBytes) {
      response.destroy();
      request.destroy();
      return readFailure<HlsAssetContent>('PLAYBACK_RESOURCE_UNAVAILABLE', '资产超出尺寸预算');
    }
    response.setTimeout(hls.idleTimeoutSeconds * 1000, () => {
      response.destroy(codedError('上游数据空闲超时'));
      request.destroy();
    });

    let stream: Readable = response;
    if (declared === null) {
      // 无长度声明:边流边计数,超预算即毁连并以稳定码错误终止流(不注入 JSON)
      let seenBytes = 0;
      const limited = new Transform({
        transform: (chunk: Buffer, _encoding, callback) => {
          seenBytes += chunk.length;
          if (seenBytes > maxBytes) {
            request.destroy();
            callback(codedError('资产超出尺寸预算'));
            return;
          }
          callback(null, chunk);
        },
      });
      response.on('error', (error: Error) => {
        limited.destroy(error);
      });
      response.pipe(limited);
      stream = limited;
    }
    return {
      ok: true,
      value: { stream, contentType: headerValue(response.headers, 'content-type') },
    };
  }

  /**
   * 打开最终响应:首跳与每个 redirect 目标都经 validateUpstreamHop(注入 resolveDns 时
   * 逐 IP 验证);redirect 计数超预算/目标非法/上游状态非 2xx → 判别失败。
   */
  private async openWithRedirects(
    url: string,
    allowedTargets: readonly LanTarget[],
    signal: AbortSignal | undefined,
  ): Promise<OpenOutcome> {
    let first: URL;
    try {
      first = new URL(url);
    } catch {
      return { ok: false, code: 'PLAYBACK_RESOURCE_UNAVAILABLE', reason: '上游 URL 非法' };
    }
    return await this.followHops(first, allowedTargets, signal, 0);
  }

  private async followHops(
    current: URL,
    allowedTargets: readonly LanTarget[],
    signal: AbortSignal | undefined,
    redirects: number,
  ): Promise<OpenOutcome> {
    const hop = await validateUpstreamHop(current.toString(), { allowedTargets });
    if (!hop.ok) {
      return { ok: false, code: 'PLAYBACK_RESOURCE_UNAVAILABLE', reason: hop.reason };
    }
    let opened: { request: http.ClientRequest; response: http.IncomingMessage };
    try {
      opened = await this.openOnce(current, allowedTargets, signal);
    } catch {
      // 连接失败/首字节超时/abort:静态文案,不透传上游错误细节
      return { ok: false, code: 'PLAYBACK_RESOURCE_UNAVAILABLE', reason: '上游连接失败或首字节超时' };
    }
    const { request, response } = opened;
    const status = response.statusCode ?? 0;
    const location = response.headers.location;
    if (REDIRECT_STATUSES.has(status) && typeof location === 'string' && location !== '') {
      // redirect 不透传给浏览器:内部跟随并对下一跳重新校验(含 DNS 钉扎复验)
      response.destroy();
      request.destroy();
      if (redirects + 1 > this.budgets.hlsUpstream.maxRedirects) {
        return { ok: false, code: 'PLAYBACK_RESOURCE_UNAVAILABLE', reason: '重定向跳数超预算' };
      }
      let next: URL;
      try {
        next = new URL(location, current);
      } catch {
        return { ok: false, code: 'PLAYBACK_RESOURCE_UNAVAILABLE', reason: '重定向目标 URL 非法' };
      }
      return await this.followHops(next, allowedTargets, signal, redirects + 1);
    }
    if (status < 200 || status > 299) {
      response.destroy();
      request.destroy();
      return { ok: false, code: 'PLAYBACK_RESOURCE_UNAVAILABLE', reason: '上游响应状态不可用' };
    }
    return { ok: true, request, response, finalUrl: current.toString() };
  }

  /**
   * 发起单跳 GET:请求头恒空(不携带应用 Cookie/Authorization/hmp_session,凭本地
   * 127.0.0.1 夹具可断言零出现);首字节定时器覆盖连接+响应头,超时毁连;
   * lookup 经解析结果逐 IP 复核许可并钉扎首个地址(防校验与连接窗口内 DNS 重绑定)。
   */
  private openOnce(
    target: URL,
    allowedTargets: readonly LanTarget[],
    signal: AbortSignal | undefined,
  ): Promise<{ request: http.ClientRequest; response: http.IncomingMessage }> {
    return new Promise((resolve, reject) => {
      const transport: typeof http = target.protocol === 'https:' ? (https as unknown as typeof http) : http;
      const request = transport.request(target, {
        method: 'GET',
        headers: {},
        agent: false,
        lookup: this.pinnedLookup(allowedTargets, target),
        signal,
      }, (response) => {
        clearTimeout(firstByteTimer);
        resolve({ request, response });
      });
      // 首字节定时器(网络回调不早于本轮事件循环,初始化时序安全;定时器值恒定故用 const)
      const firstByteTimer = setTimeout(() => {
        request.destroy(codedError('上游首字节超时'));
      }, this.budgets.hlsUpstream.firstByteTimeoutSeconds * 1000);
      request.on('error', (error) => {
        clearTimeout(firstByteTimer);
        reject(error);
      });
      request.end();
    });
  }

  /**
   * 构造钉扎 lookup:解析全部地址后逐个复核许可(主机名仅被许可表以名字精确许可时
   * 才豁免 IP 复核 —— 名字型许可以配置钉扎);返回首个地址供连接使用。
   * 回调形态按 options.all 分支(Node ≥20 autoSelectFamily 以 {all:true} 调用自定义
   * lookup 并要求数组形态回调):all → (err, addresses[])/成功 (null,[首地址]);
   * 否则 → 单地址形态 (err, '', 0)/成功 (null, 首地址, family)。钉扎语义两形态一致:
   * 仅校验通过的首个地址可回传,拒绝/异常路径一律回传错误、零可连接地址。
   */
  private pinnedLookup(allowedTargets: readonly LanTarget[], target: URL): LookupFunction {
    const port = effectivePort(target);
    const nameApproved =
      net.isIP(target.hostname) === 0 && hostnameAllowed(target.hostname, port, allowedTargets);
    return (hostname: string, options: LookupOptions, callback) => {
      const all = options.all === true;
      const fail = (error: NodeJS.ErrnoException): void => {
        if (all) {
          callback(error, []);
        } else {
          callback(error, '', 0);
        }
      };
      dns.lookup(hostname, { ...options, all: true }, (error: NodeJS.ErrnoException | null, addresses?: LookupAddress[]) => {
        if (error !== null) {
          fail(error);
          return;
        }
        if (addresses === undefined || addresses.length === 0) {
          fail(codedError('上游主机解析结果为空'));
          return;
        }
        if (!nameApproved) {
          for (const entry of addresses) {
            if (!addressAllowed(entry.address, port, allowedTargets)) {
              fail(codedError('上游解析地址未获 LAN 许可'));
              return;
            }
          }
        }
        const first = addresses[0] as LookupAddress;
        if (all) {
          callback(null, [first]);
        } else {
          callback(null, first.address, first.family);
        }
      });
    };
  }
}
