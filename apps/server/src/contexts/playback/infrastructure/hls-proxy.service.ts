import dns from 'node:dns';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import type { LookupFunction } from 'node:net';
import type { LookupAddress, LookupOptions } from 'node:dns';
import { PassThrough, Transform } from 'node:stream';
import type { Readable } from 'node:stream';
import type DatabaseConstructor from 'better-sqlite3';
import { Injectable } from '@nestjs/common';
import type { LanTarget } from '@platform/config/env.schema';
import type { PlaybackBudgets } from '@platform/config/playback-budgets';
import type { PlaybackErrorCode } from '@contexts/playback/domain/playback.types';
import {
  createNestedBudgetLedger,
  openRemoteSource,
  readNestedLevel,
  RemoteReadFailure,
} from '@platform/upstream/safe-upstream-reader';
import type {
  NestedBudgetLedger,
  UpstreamClock,
  UpstreamDnsResolver,
  UpstreamNestedBudgets,
  UpstreamNestedLevel,
  UpstreamTimeBudgets,
} from '@platform/upstream/safe-upstream.port';
import type {
  VodInputRevisionExpectation,
  VodInputStore,
  VodReclaimableSessionRow,
  VodResolvedInputFacts,
} from '@contexts/playback/infrastructure/playback-input-store.drizzle';
import type { StartBasis } from '@contexts/playback/application/playback-work-set.port';

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
 *
 * 010 T044 增量(文件尾「VOD 固定输入交付面」):
 * - VodFixedInputDeliveryGateway:T042 store 交付面装饰器(装配单实例,resolver 桥共用)
 *   —— io seam 捕获 entryUrl 入内存租约(resolvedInputId 持有)、inputForDelivery 统一
 *   消费点、assertVodGenerationDeliverable/assertVodProbeCommitGeneration(仅 VOD 绑定
 *   域生效)、租约 renew/revoke 原语(T045 renew/watchdog 面接缝)、VOD 上游 URL 登记;
 * - VodHlsUpstreamReader:SafeUpstream 嵌套读取链(T018 NestedBudgetLedger/readNestedLevel;
 *   master/variant/segment/key 各级+总量+总时限;相对 URI 按清单基解析;redirect 每跳校验);
 * - HlsProxyService 可选 vodDelivery 路由:已登记 VOD 上游 URL 的读取分流 SafeUpstream 链,
 *   未注入/未登记 URL 沿用既有 LAN 许可链(直播/旧路径行为零变化);
 * - deriveHlsProxySeekCapability:seekCapability 事实来源(none|client),T046 DTO 输出
 *   接线点;服务端 seek 拒绝(400 PLAYBACK_SEEK_UNSUPPORTED)保持既有语义。
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

  /** VOD 固定输入交付路由(T044;注入后已登记 VOD 上游 URL 的读取走 SafeUpstream 嵌套链) */
  private readonly vodDelivery: HlsProxyVodDeliveryRoute | undefined;

  constructor(
    deps: {
      budgets: PlaybackBudgets;
      /** T044:VOD 固定输入交付路由;缺省未注入 = 既有 LAN 许可读取链(直播/旧路径零变化) */
      vodDelivery?: HlsProxyVodDeliveryRoute;
    },
  ) {
    this.budgets = deps.budgets;
    this.vodDelivery = deps.vodDelivery;
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
    // T044:已登记 VOD 固定输入交付域的上游 URL → SafeUpstream 嵌套读取链(T018 语义;
    // 每跳许可/重定向/DNS 重绑防护/字节与总时限预算);其余 URL 沿用既有 LAN 许可链
    // (直播/旧路径行为零变化)
    const vodLevel = this.vodDelivery?.vodLevelOf(url) ?? null;
    if (this.vodDelivery !== undefined && vodLevel !== null) {
      const ledger = this.vodDelivery.reader.createLedger();
      try {
        const read = await this.vodDelivery.reader.readText({
          url,
          level: vodLevel,
          ledger,
          allowedTargets: options.allowedTargets,
          signal: options.signal,
        });
        if (!read.ok) {
          return readFailure<HlsPlaylistContent>('PLAYBACK_RESOURCE_UNAVAILABLE', read.reason);
        }
        return {
          ok: true,
          value: { finalUrl: read.finalUrl, text: read.text, contentType: read.contentType },
        };
      } finally {
        ledger.dispose();
      }
    }
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
    // T044:VOD 固定输入交付域 → SafeUpstream 受控流(segment/key 按嵌套级别预算;
    // ledger 生命周期随流收口)。非 VOD URL 沿用既有链(行为零变化)。
    const vodLevel = this.vodDelivery?.vodLevelOf(url) ?? null;
    if (this.vodDelivery !== undefined && vodLevel !== null) {
      const ledger = this.vodDelivery.reader.createLedger();
      const opened = await this.vodDelivery.reader.openStream({
        url,
        level: vodLevel,
        ledger,
        allowedTargets: options.allowedTargets,
        signal: options.signal,
      });
      if (!opened.ok) {
        ledger.dispose();
        return readFailure<HlsAssetContent>('PLAYBACK_RESOURCE_UNAVAILABLE', opened.reason);
      }
      return {
        ok: true,
        value: { stream: opened.stream, contentType: opened.contentType },
      };
    }
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

/* ------------------------------------------------------------------ */
/* 010 T044 —— VOD 固定输入交付面(resolvedInputId 租约 + SafeUpstream)    */
/* ------------------------------------------------------------------ */

/**
 * 固定输入交付事实(T044;internal-ports §3「probe、HLS代理、ffmpeg输入/seek 均用该
 * ID,不各自重读最新 location」)。entryUrl 为私有入口地址:只在本值对象与内存租约
 * 之间流转,绝不进入 DTO/日志/任何持久行(T042 store 同口径)。
 */
export interface VodDeliveryInput {
  /** 私有不透明输入 ID(T042 绑定行持有;交付统一消费点) */
  readonly resolvedInputId: string;
  /** 私有入口地址(⚠️ 仅经受控交付面/SafeUpstream 消费) */
  readonly entryUrl: string;
}

/** 按 playbackSourceId 反查的固定输入交付事实(probe/入口注册/在线转换裁决用) */
export interface VodDeliveryInputBySource extends VodDeliveryInput {
  readonly householdId: string;
  readonly sessionId: string;
  readonly generation: number;
}

/** 输入租约状态(T045 renew 面消费;T044 只暴露事实,过期强制策略不在此收口) */
export type VodInputLeaseState = 'active' | 'expired' | 'revoked' | 'unknown';

/** 内存租约记录(playback registry 会话引用/租约的 T044 交付侧镜像;不落库不打日志) */
interface VodInputLeaseRecord {
  readonly resolvedInputId: string;
  readonly entryUrl: string;
  readonly leaseSeconds: number;
  leaseExpiresAtMs: number;
  revoked: boolean;
}

/** 嵌套读取级别登记(上游 URL → 级别;代理按其路由 SafeUpstream 预算) */
export type VodUpstreamLevel = UpstreamNestedLevel;

/**
 * T044 固定输入交付网关 —— T042 store 的交付面装饰器(装配单实例:resolver 桥与
 * probe/资产/代理共用同一 store,不产生第二绑定权威):
 *
 * - entryUrl 捕获:装饰 resolveVodInput/bindFixedInput 的 io.resolveUpstream seam,
 *   解析事实经此经过时以 resolvedInputId 为键记入内存租约表(setIfAbsent:并发首个
 *   落定者持有;输赢双方共享同一 resolvedInputId,不产生第二入口);
 * - 统一消费点:findDeliveryInput(h,s,g) = store.inputForDelivery(绑定行 →
 *   resolvedInputId)⊕ 内存租约 entryUrl —— 不重读最新 location(§3);
 * - 代次/交付资格:assertVodGenerationDeliverable / assertVodProbeCommitGeneration
 *   仅在存在 VOD 绑定行时委派 T042 face(旧代 409 / 终态 / cleanup);NAS/IPTV/直播
 *   会话无绑定行 → no-op(旧交付行为零变化);
 * - 租约:renewInputLease/revokeInputLease 与 resolvedInputId 生命周期挂接
 *   (T045 renew/watchdog 面接线点;T044 不实现节拍调度,仅留缝);
 * - VOD 上游 URL 登记:rewritePlaylist/registerEntry 将本代上游地址按嵌套级别登记,
 *   HlsProxyService 据此把 VOD 读取分流到 SafeUpstream 嵌套链;换代/会话释放即清扫。
 */
export class VodFixedInputDeliveryGateway implements VodInputStore {
  private readonly store: VodInputStore;
  private readonly handleSource: () => DatabaseConstructor.Database;
  private readonly nowMs: () => number;

  /** resolvedInputId → 租约(entryUrl 私有持有;T042 registry 的交付侧消费面) */
  private readonly leases = new Map<string, VodInputLeaseRecord>();

  /** VOD 上游 URL → (代次键, 嵌套级别);代理分流与 SafeUpstream 预算路由依据 */
  private readonly upstreamLevels = new Map<string, { readonly key: string; readonly level: VodUpstreamLevel }>();

  constructor(
    store: VodInputStore,
    handleSource: () => DatabaseConstructor.Database,
    nowMs: () => number = Date.now,
  ) {
    this.store = store;
    this.handleSource = handleSource;
    this.nowMs = nowMs;
  }

  /* ---------- T042 store 委派(resolve/bind 装饰 entryUrl 捕获) ---------- */

  async resolveVodInput(
    command: { householdId: string; sessionId: string; generation: number; sourceId: string },
    io: { resolveUpstream: () => Promise<VodResolvedInputFacts> },
  ): Promise<{ resolvedInputId: string }> {
    let captured: VodResolvedInputFacts | null = null;
    const result = await this.store.resolveVodInput(command, {
      resolveUpstream: async () => {
        const facts = await io.resolveUpstream();
        captured = facts;
        return facts;
      },
    });
    // 首个落定者持有(并发 resolve 输赢双方共享同一 resolvedInputId;setIfAbsent
    // 不覆盖已登记入口,避免输家事实污染赢家入口)
    if (captured !== null) {
      this.recordLease(result.resolvedInputId, captured);
    }
    return result;
  }

  async bindFixedInput(
    command: {
      householdId: string;
      sessionId: string;
      generation: number;
      sourceId: string;
      startBasis: StartBasis;
    },
    io: { resolveUpstream: () => Promise<VodResolvedInputFacts> },
  ): Promise<{ bindingId: string }> {
    let captured: VodResolvedInputFacts | null = null;
    const result = await this.store.bindFixedInput(command, {
      resolveUpstream: async () => {
        const facts = await io.resolveUpstream();
        captured = facts;
        return facts;
      },
    });
    if (captured !== null) {
      // 防御:bind 幂等重入(绑定已存在,io 未触达)时 captured 恒 null;新绑定分支
      // 回读绑定行 resolved_input_id 登记入口(resolveVodInput 已登记则 setIfAbsent 保先)
      const row = this.findBindingRow(command.householdId, command.sessionId, command.generation);
      if (row !== undefined) {
        this.recordLease(row.resolvedInputId, captured);
      }
    }
    return result;
  }

  async inputForDelivery(householdId: string, sessionId: string, generation: number): Promise<{ resolvedInputId: string }> {
    return this.store.inputForDelivery(householdId, sessionId, generation);
  }

  async replaceUnacceptedProbeInput(command: {
    householdId: string;
    sessionId: string;
    generation: number;
    nextInputId: string;
  }): Promise<void> {
    await this.store.replaceUnacceptedProbeInput(command);
  }

  assertFixedInputCurrent(command: {
    householdId: string;
    sessionId: string;
    generation: number;
    expected: VodInputRevisionExpectation;
  }): void {
    this.store.assertFixedInputCurrent(command);
  }

  failSessionOnRevisionMismatch(command: { householdId: string; sessionId: string; generation: number; reason: string }): void {
    this.store.failSessionOnRevisionMismatch(command);
  }

  async advanceGenerationWithRebind(command: {
    householdId: string;
    sessionId: string;
    expectedGeneration: number;
    nextGeneration: number;
  }): Promise<void> {
    await this.store.advanceGenerationWithRebind(command);
  }

  /* ---------- 交付资格断言(仅 VOD 绑定域生效;其余域 no-op 零变化) ---------- */

  assertGenerationDeliverable(householdId: string, sessionId: string, generation: number): void {
    this.store.assertGenerationDeliverable(householdId, sessionId, generation);
  }

  assertProbeCommitGeneration(householdId: string, sessionId: string, generation: number): void {
    this.store.assertProbeCommitGeneration(householdId, sessionId, generation);
  }

  /** VOD 交付资格断言(无绑定行 = 非 VOD 域,直接放行;有绑定行 = T042 全量资格面) */
  assertVodGenerationDeliverable(householdId: string, sessionId: string, generation: number): void {
    if (!this.isFixedInputDelivery(householdId, sessionId, generation)) {
      return;
    }
    this.assertGenerationDeliverable(householdId, sessionId, generation);
  }

  /** probe 结果提交代次断言(§7「probe 后结果只可提交当前代」;同上仅 VOD 域生效) */
  assertVodProbeCommitGeneration(householdId: string, sessionId: string, generation: number): void {
    if (!this.isFixedInputDelivery(householdId, sessionId, generation)) {
      return;
    }
    this.assertProbeCommitGeneration(householdId, sessionId, generation);
  }

  /* ---------- T045/T062/T081 watchdog 扫描面委派(计划内红保持) ---------- */

  async listReclaimableUnstartedReadySessions(input: { nowMs: number }): Promise<VodReclaimableSessionRow[]> {
    return this.store.listReclaimableUnstartedReadySessions(input);
  }

  async reclaimExpiredUnstartedReadySession(input: {
    householdId: string;
    sessionId: string;
    nowMs: number;
  }): Promise<{ reclaimed: boolean }> {
    return this.store.reclaimExpiredUnstartedReadySession(input);
  }

  /* ---------- 统一消费点(绑定行 ⊕ 内存租约;不重读最新 location) ---------- */

  /**
   * 交付输入查询:无绑定行 / 入口未登记 / 已撤销 → null(NAS/IPTV/直播会话恒 null,
   * 调用方回落既有交付路径);命中返回 resolvedInputId + 私有 entryUrl。
   */
  findDeliveryInput(householdId: string, sessionId: string, generation: number): VodDeliveryInput | null {
    const row = this.findBindingRow(householdId, sessionId, generation);
    if (row === undefined) {
      return null;
    }
    const lease = this.leases.get(row.resolvedInputId);
    if (lease === undefined || lease.revoked) {
      return null;
    }
    return { resolvedInputId: row.resolvedInputId, entryUrl: lease.entryUrl };
  }

  /** 按 playbackSourceId 反查活动固定输入(prepare probe / 网关入口注册 / 转换裁决) */
  findDeliveryInputByPlaybackSourceId(playbackSourceId: string): VodDeliveryInputBySource | null {
    if (playbackSourceId === '') {
      return null;
    }
    const row = this.handleSource()
      .prepare(
        `SELECT b.household_id AS householdId, b.session_id AS sessionId, b.generation AS generation,
                b.resolved_input_id AS resolvedInputId
         FROM playback_input_binding b
         JOIN playback_session s ON s.household_id = b.household_id AND s.id = b.session_id
         WHERE b.playback_source_id = ? AND b.cleanup_requested = 0 AND b.generation = s.generation
         ORDER BY (s.state = 'preparing') DESC, b.resolved_at DESC
         LIMIT 1`,
      )
      .get(playbackSourceId) as
      | { readonly householdId: string; readonly sessionId: string; readonly generation: number; readonly resolvedInputId: string }
      | undefined;
    if (row === undefined) {
      return null;
    }
    const lease = this.leases.get(row.resolvedInputId);
    if (lease === undefined || lease.revoked) {
      return null;
    }
    return {
      householdId: row.householdId,
      sessionId: row.sessionId,
      generation: row.generation,
      resolvedInputId: row.resolvedInputId,
      entryUrl: lease.entryUrl,
    };
  }

  /** 是否 VOD 固定输入交付域(绑定行存在;NAS/IPTV/直播恒 false → 旧路径零变化) */
  isFixedInputDelivery(householdId: string, sessionId: string, generation: number): boolean {
    return this.findDeliveryInput(householdId, sessionId, generation) !== null;
  }

  /* ---------- 租约(T045 renew/watchdog 面接线缝;T044 不做节拍调度) ---------- */

  /**
   * 输入租约续期(T045 renew 面接线点):以记录内 leaseSeconds 延展 expiresAt。
   * 未知 resolvedInputId / 已撤销返回 false;renew 面若涉及 lifecycle 归 T045,此处只提供原语。
   */
  renewInputLease(resolvedInputId: string, options: { readonly atMs?: number } = {}): boolean {
    const lease = this.leases.get(resolvedInputId);
    if (lease === undefined || lease.revoked) {
      return false;
    }
    lease.leaseExpiresAtMs = (options.atMs ?? this.nowMs()) + lease.leaseSeconds * 1000;
    return true;
  }

  /** 输入租约撤销(T045 换代/清理面接线点):撤销后 findDeliveryInput 恒 null */
  revokeInputLease(resolvedInputId: string): boolean {
    const lease = this.leases.get(resolvedInputId);
    if (lease === undefined || lease.revoked) {
      return false;
    }
    lease.revoked = true;
    return true;
  }

  /** 租约状态观测(T045 过期策略决策输入;T044 不强制过期拒交付) */
  leaseStateOf(resolvedInputId: string, options: { readonly atMs?: number } = {}): VodInputLeaseState {
    const lease = this.leases.get(resolvedInputId);
    if (lease === undefined) {
      return 'unknown';
    }
    if (lease.revoked) {
      return 'revoked';
    }
    return (options.atMs ?? this.nowMs()) >= lease.leaseExpiresAtMs ? 'expired' : 'active';
  }

  /* ---------- VOD 上游 URL 登记(HlsProxyService SafeUpstream 分流依据) ---------- */

  /** 批量登记本代上游 URL 及嵌套级别(rewritePlaylist/registerEntry 调用;幂等覆盖) */
  registerVodUpstreamUrls(
    householdId: string,
    sessionId: string,
    generation: number,
    entries: readonly { readonly url: string; readonly level: VodUpstreamLevel }[],
  ): void {
    const key = generationKey(householdId, sessionId, generation);
    for (const entry of entries) {
      if (entry.url === '') {
        continue;
      }
      this.upstreamLevels.set(entry.url, { key, level: entry.level });
    }
  }

  /** 上游 URL 的嵌套级别(未登记 / 非 VOD 域 → null = 既有读取链) */
  vodLevelOf(upstreamUrl: string): VodUpstreamLevel | null {
    return this.upstreamLevels.get(upstreamUrl)?.level ?? null;
  }

  /** 换代清扫(TTL 不超 session;同 resolvedInputId 跨代复用,租约表不随代清除) */
  forgetGeneration(householdId: string, sessionId: string, generation: number): void {
    const key = generationKey(householdId, sessionId, generation);
    for (const [url, registration] of [...this.upstreamLevels.entries()]) {
      if (registration.key === key) {
        this.upstreamLevels.delete(url);
      }
    }
  }

  /** 会话清扫(生命周期终态/清理面接线) */
  forgetSession(householdId: string, sessionId: string): void {
    const prefix = `${householdId}\u0000${sessionId}\u0000`;
    for (const [url, registration] of [...this.upstreamLevels.entries()]) {
      if (registration.key.startsWith(prefix)) {
        this.upstreamLevels.delete(url);
      }
    }
  }

  /* ---------- 内部工具 ---------- */

  private recordLease(resolvedInputId: string, facts: VodResolvedInputFacts): void {
    if (this.leases.has(resolvedInputId)) {
      return;
    }
    this.leases.set(resolvedInputId, {
      resolvedInputId,
      entryUrl: facts.entryUrl,
      leaseSeconds: facts.leaseSeconds,
      leaseExpiresAtMs: this.nowMs() + facts.leaseSeconds * 1000,
      revoked: false,
    });
  }

  private findBindingRow(
    householdId: string,
    sessionId: string,
    generation: number,
  ): { readonly resolvedInputId: string } | undefined {
    return this.handleSource()
      .prepare('SELECT resolved_input_id AS resolvedInputId FROM playback_input_binding WHERE household_id = ? AND session_id = ? AND generation = ?')
      .get(householdId, sessionId, generation) as { readonly resolvedInputId: string } | undefined;
  }
}

/** 代次键(与资产注册表/网关清扫同族分隔符) */
function generationKey(householdId: string, sessionId: string, generation: number): string {
  return `${householdId}\u0000${sessionId}\u0000${String(generation)}`;
}

/* ------------------------------------------------------------------ */
/* SafeUpstream 嵌套读取链(T018 NestedBudgetLedger/readNestedLevel)      */
/* ------------------------------------------------------------------ */

/** 由播放预算派生 VOD 嵌套预算(各级/总量/总时限;数值权威 playback-budgets hlsUpstream) */
export function vodNestedBudgetsFromPlaybackBudgets(budgets: PlaybackBudgets): UpstreamNestedBudgets {
  const hls = budgets.hlsUpstream;
  return {
    perLevelMaxBytes: {
      manifest: hls.maxPlaylistBytes,
      variant: hls.maxPlaylistBytes,
      segment: hls.maxSegmentBytes,
      key: hls.maxKeyBytes,
    },
    // 链总量:清单嵌套上限 × 单清单上限 + 单分片 + key(同一链不重复计满片预算即可覆盖
    // master→variant→segment→key 全级;超总量即台账中止)
    totalMaxBytes: hls.maxSegmentBytes + hls.maxPlaylistBytes * hls.maxPlaylistNestingDepth,
    totalTimeoutMs: (hls.firstByteTimeoutSeconds + hls.idleTimeoutSeconds) * 1000,
  };
}

/** 上游失败 → 稳定脱敏文案(静态词表;不含 URL/主机/上游错误细节) */
function upstreamFailureReason(error: unknown): string {
  if (error instanceof RemoteReadFailure) {
    switch (error.code) {
      case 'SOURCE_TARGET_DENIED':
        return '上游地址未获精确许可';
      case 'SOURCE_REDIRECT_LIMIT':
        return '重定向跳数超预算';
      case 'SOURCE_BUDGET_EXCEEDED':
        return '上游读取超出预算';
      case 'SOURCE_IDLE_TIMEOUT':
        return '上游数据空闲超时';
      case 'SOURCE_DNS_INVALID':
        return '上游 DNS 解析失败';
      case 'SOURCE_ABORTED':
        return '上游读取已中止';
      case 'SOURCE_REMOTE_UNREACHABLE':
        return '上游连接失败';
      default:
        return '上游读取失败';
    }
  }
  return '上游读取失败';
}

/** probe 失败分类用:稳定码原样暴露(不脱敏码本身;文案仍脱敏) */
function upstreamFailureCode(error: unknown): string | null {
  return error instanceof RemoteReadFailure ? error.code : null;
}

/** 简易中止信号组合(嵌套台账 signal ⊕ 外部 signal;读取结束后解除监听) */
function combineAbortSignalsLocal(signals: readonly (AbortSignal | undefined)[]): { signal: AbortSignal; dispose(): void } {
  const active = signals.filter((signal): signal is AbortSignal => signal !== undefined);
  const controller = new AbortController();
  if (active.some((signal) => signal.aborted)) {
    controller.abort();
    return { signal: controller.signal, dispose: () => undefined };
  }
  const listeners = active.map((signal) => {
    const forward = (): void => {
      controller.abort();
    };
    signal.addEventListener('abort', forward, { once: true });
    return { signal, forward };
  });
  return {
    signal: controller.signal,
    dispose: (): void => {
      for (const { signal, forward } of listeners) {
        signal.removeEventListener('abort', forward);
      }
    },
  };
}

/** 资产流包装:台账记账 + 源错误稳定码化 + 上游连接随流收口 */
function wrapUpstreamAssetStream(
  opened: { readonly stream: Readable; close(): Promise<void> },
  ledger: NestedBudgetLedger,
  byteBudget: number,
): Readable {
  const limited = new PassThrough();
  const closeUpstream = (): void => {
    void opened.close().catch(() => undefined);
    opened.stream.destroy();
    ledger.dispose();
  };
  limited.on('close', closeUpstream);
  let chargedBytes = 0;
  opened.stream.on('data', (chunk: Buffer) => {
    chargedBytes += chunk.length;
    if (chargedBytes > byteBudget || !ledger.charge(chunk.length)) {
      limited.destroy(codedError('上游读取超出嵌套预算'));
      return;
    }
    if (!limited.write(chunk)) {
      opened.stream.pause();
    }
  });
  limited.on('drain', () => {
    opened.stream.resume();
  });
  opened.stream.on('end', () => {
    limited.end();
  });
  opened.stream.on('error', () => {
    // 稳定码化后向消费方传播(不透传上游错误细节;T012 脱敏边界)
    limited.destroy(codedError('上游读取中断'));
  });
  return limited;
}

export interface VodHlsUpstreamReaderDeps {
  /** 嵌套预算(各级/总量/总时限;缺省 vodNestedBudgetsFromPlaybackBudgets 派生) */
  readonly nestedBudgets: UpstreamNestedBudgets;
  /** 单次读取时间/重定向预算(每跳独立连接并重新校验) */
  readonly timeBudgets: UpstreamTimeBudgets;
  /** 读取链缺省精确许可(调用期读取;缺省空列表 = 默认拒绝) */
  readonly allowedTargets?: () => readonly LanTarget[];
  /** 注入 DNS 解析(测试 stub);缺省系统解析 */
  readonly resolver?: UpstreamDnsResolver;
  /** 注入时钟(测试);缺省真实时间 */
  readonly clock?: UpstreamClock;
}

/**
 * T044 VOD SafeUpstream 嵌套读取器 —— 清单/片段/key 的已验证输入通路:
 * - 全部读取经 T018 SafeUpstream 语义(协议白名单/拒绝类别/部署精确许可/每跳 DNS
 *   重解析与重绑防护/每跳重定向重校验/字节与总时限预算),不直接透传任意上游地址;
 * - 嵌套预算经 NestedBudgetLedger/readNestedLevel:master(manifest)→variant→
 *   segment→key 各级单响应上限 + 链累计总量 + 链总时限,超限即中止拒绝;
 * - 失败只回静态脱敏文案(不含 URL/主机/上游错误细节)。
 */
export class VodHlsUpstreamReader {
  private readonly deps: VodHlsUpstreamReaderDeps;

  constructor(deps: VodHlsUpstreamReaderDeps) {
    this.deps = deps;
  }

  /** 嵌套预算台账(probe 链跨级共用;交付单资产可各自建账;totalTimeoutMs 可按剩余期限收紧) */
  createLedger(options: { readonly signal?: AbortSignal; readonly totalTimeoutMs?: number } = {}): NestedBudgetLedger {
    const budgets =
      options.totalTimeoutMs !== undefined && options.totalTimeoutMs < this.deps.nestedBudgets.totalTimeoutMs
        ? { ...this.deps.nestedBudgets, totalTimeoutMs: options.totalTimeoutMs }
        : this.deps.nestedBudgets;
    return createNestedBudgetLedger(budgets, { signal: options.signal, clock: this.deps.clock });
  }

  /** 有界全量读取清单文本(readNestedLevel:级别/台账余量双重预算 + 中止贯穿) */
  async readText(input: {
    readonly url: string;
    readonly level: VodUpstreamLevel;
    readonly ledger: NestedBudgetLedger;
    readonly allowedTargets?: readonly LanTarget[];
    readonly signal?: AbortSignal;
  }): Promise<
    | {
        readonly ok: true;
        readonly text: string;
        readonly finalUrl: string;
        readonly contentType: string | null;
      }
    | { readonly ok: false; readonly reason: string; readonly failureCode: string | null }
  > {
    try {
      const read = await readNestedLevel(input.ledger, input.level, input.url, {
        allowedTargets: input.allowedTargets ?? this.defaultAllowedTargets(),
        maxBytes: Math.min(input.ledger.levelBudget(input.level), input.ledger.remainingBytes),
        timeBudgets: this.deps.timeBudgets,
        signal: input.signal,
        resolver: this.deps.resolver,
        clock: this.deps.clock,
      });
      return {
        ok: true,
        text: read.bytes.toString('utf8'),
        finalUrl: read.finalUrl,
        contentType: read.contentType,
      };
    } catch (error) {
      return { ok: false, reason: upstreamFailureReason(error), failureCode: upstreamFailureCode(error) };
    }
  }

  /** 打开受控资产流(SafeUpstream open + 台账记账 + 稳定码错误;消费方断开即取消上游) */
  async openStream(input: {
    readonly url: string;
    readonly level: VodUpstreamLevel;
    readonly ledger: NestedBudgetLedger;
    readonly allowedTargets?: readonly LanTarget[];
    readonly signal?: AbortSignal;
  }): Promise<
    | { readonly ok: true; readonly stream: Readable; readonly contentType: string | null }
    | { readonly ok: false; readonly reason: string; readonly failureCode: string | null }
  > {
    const byteBudget = Math.min(input.ledger.levelBudget(input.level), input.ledger.remainingBytes);
    const combined = combineAbortSignalsLocal([input.ledger.signal, input.signal]);
    try {
      const opened = await openRemoteSource(input.url, {
        allowedTargets: input.allowedTargets ?? this.defaultAllowedTargets(),
        maxBytes: byteBudget,
        timeBudgets: this.deps.timeBudgets,
        signal: combined.signal,
        resolver: this.deps.resolver,
        clock: this.deps.clock,
      });
      // 流生命周期收口台账(消费方 destroy/正常 end 即 dispose;限额/中止由台账 signal 贯穿)
      const stream = wrapUpstreamAssetStream({ stream: opened.stream, close: opened.close }, input.ledger, byteBudget);
      return { ok: true, stream, contentType: opened.contentType };
    } catch (error) {
      combined.dispose();
      input.ledger.dispose();
      return { ok: false, reason: upstreamFailureReason(error), failureCode: upstreamFailureCode(error) };
    }
  }

  private defaultAllowedTargets(): readonly LanTarget[] {
    return this.deps.allowedTargets?.() ?? [];
  }
}

/* ------------------------------------------------------------------ */
/* 交付路由面与 seekCapability 事实(api.md §7 I4)                        */
/* ------------------------------------------------------------------ */

/** HlsProxyService 的 VOD 固定输入交付路由(模块装配注入;缺省未注入 = 既有链) */
export interface HlsProxyVodDeliveryRoute {
  /** 上游 URL 的嵌套级别(未登记/非 VOD 域 → null) */
  vodLevelOf(upstreamUrl: string): VodUpstreamLevel | null;
  /** SafeUpstream 嵌套读取链 */
  readonly reader: VodHlsUpstreamReader;
}

/** hls_proxy VOD 定位能力事实(I4:第一期仅 client|none;直播恒 none) */
export type HlsProxySeekCapability = 'none' | 'client';

/**
 * seekCapability 事实来源(T046 DTO 输出接线点):可信 probe/交付事实的已知时长。
 * - client:已知 duration(可信 probe endList 判定出确定时长)——仅声明服务端许可,
 *   前端还须检查实际 seekable 范围(I4 原文);
 * - none:时长未知(endList 缺失/直播)。
 * 服务端 seek 拒绝(400 PLAYBACK_SEEK_UNSUPPORTED)保持既有语义,hls_proxy 不因
 * client 能力开放服务端重建(I4:hls_proxy VOD 第一期仅 client|none)。
 */
export function deriveHlsProxySeekCapability(input: {
  readonly durationSeconds: number | null | undefined;
}): HlsProxySeekCapability {
  const duration = input.durationSeconds;
  return typeof duration === 'number' && Number.isFinite(duration) && duration > 0 ? 'client' : 'none';
}
