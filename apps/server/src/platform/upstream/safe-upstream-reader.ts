import * as dns from 'node:dns';
import http from 'node:http';
import https from 'node:https';
import type { LookupFunction } from 'node:net';
import { PassThrough } from 'node:stream';
import type { Readable } from 'node:stream';
import { IMPORT_BUDGETS } from '@platform/config/import-budgets';
import {
  SAFE_UPSTREAM_PORT,
  type NestedBudgetLedger,
  type SafeUpstreamErrorCode,
  type SafeUpstreamOpenRequest,
  type SafeUpstreamPort,
  type SafeUpstreamReadResult,
  type SafeUpstreamStreamHandle,
  type UpstreamAllowedTarget,
  type UpstreamClock,
  type UpstreamDnsResolver,
  type UpstreamNestedBudgets,
  type UpstreamNestedLevel,
  type UpstreamTimeBudgets,
} from './safe-upstream.port';

/**
 * 010 T018 — platform 层可复用有界安全上游读取器(自
 * contexts/sources/infrastructure/safe-http-reader.ts 原样提取适配;SSRF 语义
 * 与 research R3 权威语义逐字保留,旧 sources 行为回归由旧路径薄委托保证):
 *
 * - 每跳(首跳与每个重定向跳)独立建立连接:先解析目标主机的全部 A/AAAA 记录,
 *   逐一规范化(IPv4-mapped IPv6 归一为 IPv4)并做拒绝类别校验;全部地址合法且
 *   部署许可列表(allowedTargets)命中才连接。连接固定使用本跳已验证的 IP
 *   (直接以该 IP 建连,并注入 custom lookup 只返回已验证 IP 作双保险),
 *   Host 头与 TLS 服务器名保留原主机名 —— 即「DNS 重绑定防护 = 连接用已验证 IP」。
 * - 拒绝类别:loopback、link-local(含云元数据 169.254.169.254)、unspecified、
 *   multicast/broadcast;混合解析(合法与非法地址混存)一律拒绝;
 *   URL 显式写 IPv4-mapped IPv6 的一律拒绝(规范化后必命中类别,防解析器分歧绕过)。
 *   RFC1918 私网由「部署精确许可列表 + 默认拒绝」覆盖。
 * - 回环/链路本地地址属类别拒绝,但部署许可列表可用 host/hostPort 条目对「精确
 *   单个地址+端口」放行(测试夹具与局域网 NAS 依赖此精确许可);未指定/多播地址
 *   没有单播连接语义,即使列入也不放行。许可主机名解析出纯回环/链路本地集合时
 *   放行(精确主机名许可),混合集合仍拒绝。
 * - 手动逐跳跟随重定向(≤ timeBudgets.maxRedirects,每跳重新解析并重走完整校验),
 *   不使用自动重定向;Location 绝对化后重走完整校验。http.request 不读取
 *   HTTP(S)_PROXY 等环境变量,即「不继承环境代理」由构造保证;请求头固定集合,
 *   不发送 Cookie/凭据。
 * - 预算:总时长 totalTimeoutMs、空闲 idleTimeoutMs、重定向跳数 maxRedirects;
 *   缺省 = IMPORT_BUDGETS 的传输预算(旧 sources 行为不变),VOD 场景经
 *   VOD_SAFE_UPSTREAM_BUDGETS 注入;空闲与中止经注入时钟/AbortSignal 贯穿;
 *   字节上限由调用方按场景注入 byteBudget,超限即中止连接。
 * - 失败一律抛 RemoteReadFailure 并携带稳定 code(字符串值与旧路径逐字一致);
 *   message 只含脱敏 host[:port],绝不包含 userinfo、路径、query 或完整 URL。
 */

/* ------------------------------------------------------------------ */
/* 时间预算缺省(旧 sources 行为 = IMPORT_BUDGETS 传输预算)              */
/* ------------------------------------------------------------------ */

/** 旧 sources/导入路径的缺省时间预算(与原 IMPORT_BUDGETS.NET_* 逐字一致) */
export const DEFAULT_IMPORT_UPSTREAM_TIME_BUDGETS: UpstreamTimeBudgets = {
  totalTimeoutMs: IMPORT_BUDGETS.NET_TOTAL_BUDGET_MS,
  idleTimeoutMs: IMPORT_BUDGETS.NET_IDLE_TIMEOUT_MS,
  maxRedirects: IMPORT_BUDGETS.NET_MAX_REDIRECTS,
};

/* ------------------------------------------------------------------ */
/* 稳定错误码与错误类型(导出名与旧路径逐字一致)                         */
/* ------------------------------------------------------------------ */

/** 目标命中拒绝类别,或未列入部署精确许可列表 */
export const TARGET_DENIED = 'SOURCE_TARGET_DENIED';
/** 重定向跳数超预算 */
export const REDIRECT_LIMIT = 'SOURCE_REDIRECT_LIMIT';
/** 总时长/读取字节超过预算 */
export const BUDGET_EXCEEDED = 'SOURCE_BUDGET_EXCEEDED';
/** 连接空闲超预算 */
export const IDLE_TIMEOUT = 'SOURCE_IDLE_TIMEOUT';
/** DNS 解析失败、结果为空或包含非法地址文本 */
export const DNS_INVALID = 'SOURCE_DNS_INVALID';
/** 外部 AbortSignal 中止 */
export const ABORTED = 'SOURCE_ABORTED';
/** 传输层失败(连接拒绝/重置等);错误 message 只保留 error.name,不回显细节 */
export const REMOTE_UNREACHABLE = 'SOURCE_REMOTE_UNREACHABLE';

/* (010 T090 knip 清理:原 RemoteReadErrorCode 别名类型已删除——零消费,统一径用 SafeUpstreamErrorCode) */

/** 远程读取失败:稳定 code 供上层映射 API 错误,message 已脱敏(无 userinfo/URL) */
export class RemoteReadFailure extends Error {
  readonly code: SafeUpstreamErrorCode;

  constructor(code: SafeUpstreamErrorCode, message: string) {
    super(message);
    this.name = 'RemoteReadFailure';
    this.code = code;
  }
}

/** 注入式解析器:测试可注入以模拟多地址/翻转结果并计数(兼容别名) */
export type RemoteDnsResolver = UpstreamDnsResolver;
/* (010 T090 knip 清理:原 RemoteReadClock 别名类型已删除——零消费,统一径用 UpstreamClock) */
/** 成功打开的远程源:原始响应流(不解压/不改写)+ 透传元数据与溯源事实 */
export interface RemoteSourceStream {
  stream: Readable;
  contentType: string | null;
  contentEncoding: string | null;
  /** 重定向后的最终 URL(无重定向时 = 请求 URL) */
  finalUrl: string;
  /** 实际跟随的重定向跳数 */
  redirectsFollowed: number;
  close(): Promise<void>;
}

export interface OpenRemoteSourceOptions {
  /** 部署级精确许可列表(env.LAN_ALLOWED_TARGETS 解析产物);空列表 = 默认拒绝 */
  allowedTargets: readonly UpstreamAllowedTarget[];
  /** 缺省使用 node:dns promises */
  resolver?: UpstreamDnsResolver;
  /** 外部中止信号;中止即 ABORTED 并销毁连接 */
  signal?: AbortSignal;
  /** 测试注入时钟驱动空闲/总预算;缺省真实时间 */
  clock?: UpstreamClock;
  /** 读取侧字节上限(响应体累计);超限中止连接并 BUDGET_EXCEEDED。缺省不限 */
  maxBytes?: number;
  /** 时间/重定向预算;缺省 = IMPORT 传输预算(旧 sources 行为不变) */
  timeBudgets?: UpstreamTimeBudgets;
}

const systemResolver: UpstreamDnsResolver = {
  resolve4: (hostname: string) => dns.promises.resolve4(hostname),
  resolve6: (hostname: string) => dns.promises.resolve6(hostname),
};

/**
 * 单家族解析:ENODATA = 该地址家族无记录(合法情况,如 A-only 域名无 AAAA),
 * 返回空数组而非失败——research R3 的「解析全部 A/AAAA」语义是收集两类记录,
 * 空记录集不是 DNS 错误。resolve6 的 ENOTFOUND(部分解析器对无 AAAA 的返回码)
 * 同样按「无 AAAA 记录」处理;resolve4 的 ENOTFOUND 仍视为域名不存在向上抛出,
 * 由调用方统一转 DNS_INVALID。
 */
async function resolveFamilyRecords(
  resolver: UpstreamDnsResolver,
  family: 4 | 6,
  hostname: string,
): Promise<string[]> {
  try {
    return family === 4 ? await resolver.resolve4(hostname) : await resolver.resolve6(hostname);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException | null)?.code;
    if (code === 'ENODATA') {
      return [];
    }
    if (family === 6 && code === 'ENOTFOUND') {
      return [];
    }
    throw error;
  }
}

/* ------------------------------------------------------------------ */
/* IP 解析与规范化                                                     */
/* ------------------------------------------------------------------ */

interface IpAddress {
  family: 4 | 6;
  /** 大端字节:IPv4 长 4,IPv6 长 16 */
  bytes: Uint8Array;
  /** 规范化文本(IPv4 点分十进制;IPv6 小写压缩形式,不含 zone) */
  text: string;
}

const IPV4_TEXT = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;
const HEX_GROUP_TEXT = /^[0-9a-f]{1,4}$/;

function parseIpv4(text: string): IpAddress | null {
  const match = IPV4_TEXT.exec(text);
  if (match === null) {
    return null;
  }
  const bytes = new Uint8Array(4);
  for (let position = 1; position <= 4; position += 1) {
    const group = match[position];
    if (group === undefined) {
      return null;
    }
    // 拒绝前导零写法(025.1.1.1 类歧义解释)
    if (group.length > 1 && group.startsWith('0')) {
      return null;
    }
    const value = Number(group);
    if (value > 255) {
      return null;
    }
    bytes[position - 1] = value;
  }
  return { family: 4, bytes, text };
}

function parseHexGroup(text: string): number | null {
  if (!HEX_GROUP_TEXT.test(text)) {
    return null;
  }
  return parseInt(text, 16);
}

/** 规范化 IPv6 文本:最长全零段压缩为「::」 */
function formatIpv6(bytes: Uint8Array): string {
  const groups: string[] = [];
  for (let index = 0; index < 8; index += 1) {
    const value = ((bytes[index * 2] ?? 0) << 8) | (bytes[index * 2 + 1] ?? 0);
    groups.push(value.toString(16));
  }
  let bestStart = -1;
  let bestLength = 0;
  let currentStart = -1;
  let currentLength = 0;
  groups.forEach((group, position) => {
    if (group !== '0') {
      currentStart = -1;
      currentLength = 0;
      return;
    }
    if (currentStart === -1) {
      currentStart = position;
      currentLength = 1;
    } else {
      currentLength += 1;
    }
    if (currentLength > bestLength) {
      bestLength = currentLength;
      bestStart = currentStart;
    }
  });
  if (bestLength < 2) {
    return groups.join(':');
  }
  return `${groups.slice(0, bestStart).join(':')}::${groups.slice(bestStart + bestLength).join(':')}`;
}

/** 解析 IPv6(支持「::」压缩与末段内嵌 IPv4,如 ::ffff:192.168.0.1;剥离 zone) */
function parseIpv6(input: string): IpAddress | null {
  const percentIndex = input.indexOf('%');
  const text = (percentIndex === -1 ? input : input.slice(0, percentIndex)).toLowerCase();
  if (text === '') {
    return null;
  }
  let body = text;
  const lastColon = text.lastIndexOf(':');
  if (lastColon !== -1 && text.includes('.', lastColon + 1)) {
    // 末段内嵌 IPv4:转换为对应的两个 16 位组再统一处理
    const tail = parseIpv4(text.slice(lastColon + 1));
    if (tail === null) {
      return null;
    }
    const high = (((tail.bytes[0] ?? 0) << 8) | (tail.bytes[1] ?? 0)).toString(16);
    const low = (((tail.bytes[2] ?? 0) << 8) | (tail.bytes[3] ?? 0)).toString(16);
    body = `${text.slice(0, lastColon)}:${high}:${low}`;
  }
  const groups: number[] = [];
  const doubleColonIndex = body.indexOf('::');
  if (doubleColonIndex !== -1) {
    if (body.indexOf('::', doubleColonIndex + 2) !== -1) {
      return null; // 多个「::」非法
    }
    const headText = body.slice(0, doubleColonIndex);
    const tailText = body.slice(doubleColonIndex + 2);
    const head = headText === '' ? [] : headText.split(':');
    const tail = tailText === '' ? [] : tailText.split(':');
    if (head.length + tail.length >= 8) {
      return null; // 「::」至少要省略一组
    }
    for (const item of head) {
      const group = parseHexGroup(item);
      if (group === null) {
        return null;
      }
      groups.push(group);
    }
    for (let index = 0; index < 8 - head.length - tail.length; index += 1) {
      groups.push(0);
    }
    for (const item of tail) {
      const group = parseHexGroup(item);
      if (group === null) {
        return null;
      }
      groups.push(group);
    }
  } else {
    const parts = body.split(':');
    if (parts.length !== 8) {
      return null;
    }
    for (const item of parts) {
      const group = parseHexGroup(item);
      if (group === null) {
        return null;
      }
      groups.push(group);
    }
  }
  const bytes = new Uint8Array(16);
  for (let index = 0; index < 8; index += 1) {
    const value = groups[index] ?? 0;
    bytes[index * 2] = value >> 8;
    bytes[index * 2 + 1] = value & 0xff;
  }
  return { family: 6, bytes, text: formatIpv6(bytes) };
}

function parseIpAddress(text: string): IpAddress | null {
  return parseIpv4(text) ?? parseIpv6(text);
}

/** IPv4-mapped IPv6(::ffff:a.b.c.d)检测:前 10 字节为 0,第 11/12 字节为 ff */
function isIpv4Mapped(bytes: Uint8Array): boolean {
  if (bytes.length !== 16) {
    return false;
  }
  for (let index = 0; index < 10; index += 1) {
    if (bytes[index] !== 0) {
      return false;
    }
  }
  return bytes[10] === 0xff && bytes[11] === 0xff;
}

/** 规范化:IPv4-mapped IPv6 归一为等价 IPv4(research R3) */
function normalizeAddress(address: IpAddress): IpAddress {
  if (address.family === 6 && isIpv4Mapped(address.bytes)) {
    const b12 = address.bytes[12] ?? 0;
    const b13 = address.bytes[13] ?? 0;
    const b14 = address.bytes[14] ?? 0;
    const b15 = address.bytes[15] ?? 0;
    return {
      family: 4,
      bytes: Uint8Array.of(b12, b13, b14, b15),
      text: `${b12}.${b13}.${b14}.${b15}`,
    };
  }
  return address;
}

type DeniedCategory = 'loopback' | 'link-local' | 'metadata' | 'unspecified' | 'multicast';

const CATEGORY_LABELS: Record<DeniedCategory, string> = {
  loopback: '环回地址',
  'link-local': '链路本地地址',
  metadata: '云元数据地址',
  unspecified: '未指定地址',
  multicast: '多播/广播地址',
};

/** 私网单播判定(public 条目放行口径):IPv4 RFC1918(10/8、172.16/12、192.168/16)
 * 与 IPv6 ULA(fc00::/7)判私网;其余非类别拒绝地址视为公网。入参须已规范化。 */
function isPrivateUnicast(address: IpAddress): boolean {
  if (address.family === 4) {
    const b0 = address.bytes[0] ?? 0;
    const b1 = address.bytes[1] ?? 0;
    return b0 === 10 || (b0 === 172 && b1 >= 16 && b1 <= 31) || (b0 === 192 && b1 === 168);
  }
  const first = address.bytes[0] ?? 0;
  return first === 0xfc || first === 0xfd;
}

/** 拒绝类别判定(入参必须已规范化;IPv4-mapped 已归一为 IPv4) */
function deniedCategoryOf(address: IpAddress): DeniedCategory | null {
  if (address.family === 4) {
    const b0 = address.bytes[0] ?? 0;
    const b1 = address.bytes[1] ?? 0;
    const b2 = address.bytes[2] ?? 0;
    const b3 = address.bytes[3] ?? 0;
    if (b0 === 0 && b1 === 0 && b2 === 0 && b3 === 0) {
      return 'unspecified';
    }
    if (b0 === 127) {
      return 'loopback';
    }
    if (b0 === 169 && b1 === 254) {
      // 169.254.169.254 为云元数据端点,单独归类便于错误定位
      return b2 === 169 && b3 === 254 ? 'metadata' : 'link-local';
    }
    if ((b0 >= 224 && b0 <= 239) || b0 === 255) {
      // 224/4 多播与 255.255.255.255 受限广播同样没有单播连接语义
      return 'multicast';
    }
    return null;
  }
  const bytes = address.bytes;
  let leadingZero = true;
  for (let index = 0; index < 15; index += 1) {
    if (bytes[index] !== 0) {
      leadingZero = false;
      break;
    }
  }
  if (leadingZero && bytes[15] === 0) {
    return 'unspecified'; // ::
  }
  if (leadingZero && bytes[15] === 1) {
    return 'loopback'; // ::1
  }
  const first = bytes[0] ?? 0;
  if (first === 0xfe && ((bytes[1] ?? 0) & 0xc0) === 0x80) {
    return 'link-local'; // fe80::/10
  }
  if (first === 0xff) {
    return 'multicast'; // ff00::/8
  }
  return null;
}

/* ------------------------------------------------------------------ */
/* 许可列表索引与匹配                                                  */
/* ------------------------------------------------------------------ */

interface AddressEntry {
  family: 4 | 6;
  bytes: Uint8Array;
  /** null = host 条目(任意端口);数值 = hostPort 条目(精确端口) */
  port: number | null;
}

interface CidrEntry {
  family: 4 | 6;
  bytes: Uint8Array;
  prefixLength: number;
}

interface HostnameEntry {
  hostname: string;
  port: number | null;
}

interface AllowedIndex {
  addresses: AddressEntry[];
  cidrs: CidrEntry[];
  hostnames: HostnameEntry[];
  /** public 条目在列:公网单播目标免精确许可(私网/环回/类别拒绝不放宽) */
  allowPublic: boolean;
}

function buildAllowedIndex(targets: readonly UpstreamAllowedTarget[]): AllowedIndex {
  const index: AllowedIndex = { addresses: [], cidrs: [], hostnames: [], allowPublic: false };
  for (const target of targets) {
    if (target.kind === 'public') {
      index.allowPublic = true;
      continue;
    }
    if (target.kind === 'cidr') {
      const parsed = parseIpAddress(target.address);
      // 形态已由 env 层校验;此处防御性忽略无法解析/族不匹配的条目
      if (parsed === null || parsed.family !== target.family) {
        continue;
      }
      index.cidrs.push({ family: target.family, bytes: parsed.bytes, prefixLength: target.prefixLength });
      continue;
    }
    const port = target.kind === 'hostPort' ? target.port : null;
    const parsed = parseIpAddress(target.host);
    if (parsed !== null) {
      // 条目地址同样做 IPv4-mapped 归一,与请求侧比较口径一致
      const normalized = normalizeAddress(parsed);
      index.addresses.push({ family: normalized.family, bytes: normalized.bytes, port });
    } else {
      index.hostnames.push({ hostname: target.host.toLowerCase(), port });
    }
  }
  return index;
}

function bytesEqual(left: Uint8Array, right: Uint8Array): boolean {
  if (left.length !== right.length) {
    return false;
  }
  for (let index = 0; index < left.length; index += 1) {
    if (left[index] !== right[index]) {
      return false;
    }
  }
  return true;
}

function cidrContains(entry: CidrEntry, bytes: Uint8Array): boolean {
  if (entry.prefixLength < 0 || entry.prefixLength > bytes.length * 8) {
    return false;
  }
  const wholeBytes = Math.floor(entry.prefixLength / 8);
  for (let index = 0; index < wholeBytes; index += 1) {
    if ((entry.bytes[index] ?? 0) !== (bytes[index] ?? 0)) {
      return false;
    }
  }
  const remainder = entry.prefixLength % 8;
  if (remainder === 0) {
    return true;
  }
  const mask = (0xff << (8 - remainder)) & 0xff;
  return ((entry.bytes[wholeBytes] ?? 0) & mask) === ((bytes[wholeBytes] ?? 0) & mask);
}

/** 地址级许可:host/hostPort 精确地址(可含端口约束)或 CIDR 覆盖 */
function matchAddress(index: AllowedIndex, address: IpAddress, port: number): boolean {
  for (const entry of index.addresses) {
    if (entry.family !== address.family) {
      continue;
    }
    if (entry.port !== null && entry.port !== port) {
      continue;
    }
    if (bytesEqual(entry.bytes, address.bytes)) {
      return true;
    }
  }
  for (const entry of index.cidrs) {
    if (entry.family !== address.family) {
      continue;
    }
    if (cidrContains(entry, address.bytes)) {
      return true;
    }
  }
  return false;
}

/** 主机名级许可:精确文本匹配(host 条目任意端口,hostPort 条目须端口一致) */
function matchHostname(index: AllowedIndex, hostname: string, port: number): boolean {
  const lowered = hostname.toLowerCase();
  return index.hostnames.some(
    (entry) => entry.hostname === lowered && (entry.port === null || entry.port === port),
  );
}

/* ------------------------------------------------------------------ */
/* 单跳校验与请求                                                      */
/* ------------------------------------------------------------------ */

interface HopPlan {
  protocol: 'http' | 'https';
  /** 本跳已验证 IP(规范化文本):连接固定使用该地址 */
  connectIp: string;
  family: 4 | 6;
  port: number;
  /** 保留原主机名的 Host 头(IPv6 加方括号;默认端口省略) */
  hostHeader: string;
  /** https 时的 TLS SNI/证书验证名(原主机名) */
  tlsServerName: string | null;
  path: string;
  /** 脱敏描述(host[:port]),供错误消息使用,不含路径/凭据 */
  describe: string;
}

/** 脱敏目标文本:仅 hostname[:port],绝不含 userinfo/路径/query */
function describeTarget(target: URL): string {
  const portSuffix = target.port === '' ? '' : `:${target.port}`;
  return `${target.hostname}${portSuffix}`;
}

function stripBrackets(hostname: string): string {
  return hostname.startsWith('[') && hostname.endsWith(']') ? hostname.slice(1, -1) : hostname;
}

function buildPlan(
  target: URL,
  headerHost: string,
  tlsServerName: string | null,
  address: IpAddress,
  port: number,
): HopPlan {
  const fallbackPort = target.protocol === 'https:' ? 443 : 80;
  return {
    protocol: target.protocol === 'https:' ? 'https' : 'http',
    connectIp: address.text,
    family: address.family,
    port,
    hostHeader: `${headerHost}${port === fallbackPort ? '' : `:${port}`}`,
    tlsServerName,
    path: `${target.pathname}${target.search}`,
    describe: describeTarget(target),
  };
}

/**
 * 单跳完整校验(research R3:每次请求与重定向均重新解析并校验全部 A/AAAA):
 * 校验通过后给出「连接计划」;任何不满足即抛 RemoteReadFailure(TARGET_DENIED/DNS_INVALID)。
 * 该函数只做解析与判定,绝不建立连接 —— 拒绝发生时不会有任何请求发出。
 */
async function validateHop(
  target: URL,
  index: AllowedIndex,
  resolver: UpstreamDnsResolver,
): Promise<HopPlan> {
  const where = describeTarget(target);
  if (target.protocol !== 'http:' && target.protocol !== 'https:') {
    throw new RemoteReadFailure(TARGET_DENIED, `目标协议不被允许(仅 http/https): ${where}`);
  }
  const fallbackPort = target.protocol === 'https:' ? 443 : 80;
  const port = target.port === '' ? fallbackPort : Number(target.port);
  // WHATWG URL 对 IPv6 主机保留方括号;zone 以 %25 转义出现,还原后仅用于校验
  const rawHost = stripBrackets(target.hostname).replaceAll('%25', '%');
  const literal = parseIpAddress(rawHost);

  if (literal !== null) {
    // URL 显式 IPv4-mapped IPv6 写法一律拒绝:规范化后必命中拒绝类别,
    // 防止「同一地址的映射写法」借解析器分歧绕过类别引擎。
    if (literal.family === 6 && isIpv4Mapped(literal.bytes)) {
      throw new RemoteReadFailure(TARGET_DENIED, `目标为 IPv4-mapped IPv6 写法,规范化后命中拒绝类别: ${where}`);
    }
    const address = normalizeAddress(literal);
    const category = deniedCategoryOf(address);
    if (category !== null) {
      // 未指定/多播地址没有单播连接语义:即使精确列入许可也不放行
      if (category === 'unspecified' || category === 'multicast') {
        throw new RemoteReadFailure(TARGET_DENIED, `目标命中拒绝类别(${CATEGORY_LABELS[category]}): ${where}`);
      }
      // 回环/链路本地/云元数据:仅当许可列表精确匹配「该地址+端口」才放行
      if (!matchAddress(index, address, port)) {
        throw new RemoteReadFailure(
          TARGET_DENIED,
          `目标命中拒绝类别(${CATEGORY_LABELS[category]})且未获精确许可: ${where}`,
        );
      }
    } else if (
      !matchAddress(index, address, port) &&
      // public 条目仅放行公网单播;私网(RFC1918/ULA)仍须部署精确许可
      !(index.allowPublic && !isPrivateUnicast(address))
    ) {
      throw new RemoteReadFailure(TARGET_DENIED, `目标地址未列入部署许可列表: ${where}`);
    }
    return buildPlan(
      target,
      address.family === 6 ? `[${address.text}]` : address.text,
      target.protocol === 'https:' ? rawHost : null,
      address,
      port,
    );
  }

  // 主机名目标:解析全部 A/AAAA,逐一规范化与类别校验
  let resolvedTexts: string[];
  try {
    const [ipv4Texts, ipv6Texts] = await Promise.all([
      resolveFamilyRecords(resolver, 4, rawHost),
      resolveFamilyRecords(resolver, 6, rawHost),
    ]);
    resolvedTexts = [...ipv4Texts, ...ipv6Texts];
  } catch {
    throw new RemoteReadFailure(DNS_INVALID, `DNS 解析失败: ${rawHost}`);
  }
  const parsed: IpAddress[] = [];
  for (const text of resolvedTexts) {
    const address = parseIpAddress(text);
    if (address === null) {
      throw new RemoteReadFailure(DNS_INVALID, `DNS 解析结果包含非法地址文本: ${rawHost}`);
    }
    parsed.push(address);
  }
  if (parsed.length === 0) {
    throw new RemoteReadFailure(DNS_INVALID, `DNS 解析结果为空: ${rawHost}`);
  }
  const addresses = parsed.map(normalizeAddress);
  const categories = addresses.map(deniedCategoryOf);
  const illegalCategories = categories.filter((category): category is DeniedCategory => category !== null);
  const hostnameMatched = matchHostname(index, rawHost, port);
  if (illegalCategories.length > 0) {
    // 混合非法解析(合法+非法混存)一律拒绝;纯回环/链路本地/元数据集合仅当
    // 主机名获得精确许可时放行(测试与局域网精确主机名许可场景)
    const uniformSensitive =
      illegalCategories.length === categories.length &&
      illegalCategories.every((category) => category !== 'unspecified' && category !== 'multicast');
    if (!uniformSensitive || !hostnameMatched) {
      const labels = [...new Set(illegalCategories)].map((category) => CATEGORY_LABELS[category]).join('、');
      throw new RemoteReadFailure(TARGET_DENIED, `DNS 解析命中拒绝类别(${labels}): ${rawHost}`);
    }
  } else if (!hostnameMatched) {
    // public 条目:全部解析地址均为公网单播时免精确许可;任一解析命中私网仍须
    // 精确许可(与「混合非法解析一律拒绝」同一收紧口径,防 DNS 混合解析借道内网)
    const allPublic = index.allowPublic && addresses.every((address) => !isPrivateUnicast(address));
    if (!allPublic) {
      // 主机名未列入许可:退而要求全部解析地址落入部署 CIDR/地址精确许可
      const allCovered = addresses.every((address) => matchAddress(index, address, port));
      if (!allCovered) {
        throw new RemoteReadFailure(TARGET_DENIED, `目标主机未列入部署许可列表: ${rawHost}`);
      }
    }
  }
  // 连接地址确定:优先已验证 IPv4,否则首个地址;本跳所有连接尝试固定该 IP
  const chosen = addresses.find((address) => address.family === 4) ?? addresses[0];
  if (chosen === undefined) {
    throw new RemoteReadFailure(DNS_INVALID, `DNS 解析结果为空: ${rawHost}`);
  }
  return buildPlan(target, rawHost, target.protocol === 'https:' ? rawHost : null, chosen, port);
}

/**
 * 出站默认 User-Agent:上游 WAF/防爬普遍直接 403 无 UA 请求(010 实测
 * caiji.dyttzyapi.com:同一目标带任意 UA 200、缺 UA 403),而本读取器只发
 * 固定最小头集且从不透传调用方头。取诚实的产品标识,不伪装浏览器。
 */
export const DEFAULT_UPSTREAM_USER_AGENT = 'redRoad-media-server/1.0';

/** 建立单跳请求:连接固定已验证 IP,Host 头保留原主机名,每跳独立连接 */
function sendHop(plan: HopPlan): { req: http.ClientRequest; response: Promise<http.IncomingMessage> } {
  const headers: http.OutgoingHttpHeaders = {
    host: plan.hostHeader,
    accept: '*/*',
    'user-agent': DEFAULT_UPSTREAM_USER_AGENT,
    // 不做压缩协商;对端仍可能返回编码体,读取器按原样透传(解压不是读取器职责)
    'accept-encoding': 'identity',
    connection: 'close',
  };
  const lookup: LookupFunction = (_hostname, _options, callback) => {
    // custom lookup 语义:无论查找什么名字,只返回本跳已验证的 IP(research R3)
    callback(null, plan.connectIp, plan.family);
  };
  const base: http.RequestOptions = {
    agent: false, // 每跳独立连接,不复用 keep-alive
    host: plan.connectIp,
    port: plan.port,
    path: plan.path,
    method: 'GET',
    headers,
    lookup,
    setHost: false, // 已显式提供 host 头
  };
  const req =
    plan.protocol === 'https'
      ? https.request({ ...base, servername: plan.tlsServerName ?? undefined })
      : http.request(base);
  const response = new Promise<http.IncomingMessage>((resolve, reject) => {
    req.on('response', resolve);
    req.on('error', reject);
  });
  req.end();
  return { req, response };
}

function headerText(value: string | string[] | undefined): string | null {
  if (value === undefined) {
    return null;
  }
  if (Array.isArray(value)) {
    return value[0] ?? null;
  }
  return value;
}

/* ------------------------------------------------------------------ */
/* 主流程:逐跳校验 + 预算/中止贯穿                                     */
/* ------------------------------------------------------------------ */

export async function openRemoteSource(
  url: string,
  options: OpenRemoteSourceOptions,
): Promise<RemoteSourceStream> {
  const budgets: UpstreamTimeBudgets = {
    ...DEFAULT_IMPORT_UPSTREAM_TIME_BUDGETS,
    ...(options.timeBudgets ?? {}),
  };
  let firstTarget: URL;
  try {
    firstTarget = new URL(url);
  } catch {
    // 解析失败时不回显原文(可能含凭据)
    throw new RemoteReadFailure(TARGET_DENIED, '远程地址不是合法 URL');
  }
  if (options.allowedTargets.length === 0) {
    throw new RemoteReadFailure(TARGET_DENIED, `部署许可列表为空,所有远程目标默认拒绝: ${describeTarget(firstTarget)}`);
  }

  const index = buildAllowedIndex(options.allowedTargets);
  const resolver = options.resolver ?? systemResolver;
  const injectedClock = options.clock ?? null;

  /* --- 失败通道:事件回调(空闲/预算/中止/传输错误)统一经此结算 --- */
  let settled = false;
  let current: { req: http.ClientRequest; res: http.IncomingMessage | null } | null = null;
  let exposedStream: PassThrough | null = null;
  let rejectFailure!: (failure: RemoteReadFailure) => void;
  const failurePromise = new Promise<never>((_, reject) => {
    rejectFailure = reject;
  });
  // 竞态下未率先胜出的拒绝由该空处理兜底,真实消费在 race 与流 error 通道
  failurePromise.catch(() => undefined);

  const realTimers = new Set<NodeJS.Timeout>();

  const sleep = (ms: number): { promise: Promise<void>; cancel: () => void } => {
    if (injectedClock !== null) {
      // 注入时钟(如 ManualClock)无取消语义:过期触发由 settled 守卫忽略
      return { promise: injectedClock.delay(ms), cancel: () => undefined };
    }
    let timer: NodeJS.Timeout | undefined;
    const promise = new Promise<void>((resolve) => {
      timer = setTimeout(resolve, ms);
      if (timer !== undefined) {
        realTimers.add(timer);
      }
    });
    return {
      promise,
      cancel: () => {
        if (timer !== undefined) {
          clearTimeout(timer);
          realTimers.delete(timer);
        }
      },
    };
  };

  const cleanupAfterSettle = (): void => {
    if (options.signal !== undefined) {
      options.signal.removeEventListener('abort', onAbortSignal);
    }
    for (const timer of realTimers) {
      clearTimeout(timer);
    }
    realTimers.clear();
    deadline.cancel();
  };

  const destroyCurrent = (): void => {
    const active = current;
    current = null;
    if (active === null) {
      return;
    }
    active.res?.destroy();
    active.req.destroy();
  };

  const fail = (code: SafeUpstreamErrorCode, message: string): void => {
    if (settled) {
      destroyCurrent();
      return;
    }
    settled = true;
    const failure = new RemoteReadFailure(code, message);
    cleanupAfterSettle();
    destroyCurrent();
    if (exposedStream !== null) {
      // 流已交付:预算/中止失败经流 error 通道传播给消费方
      const stream = exposedStream;
      exposedStream = null;
      stream.destroy(failure);
    }
    rejectFailure(failure);
  };

  const onAbortSignal = (): void => {
    fail(ABORTED, '远程读取已被外部中止');
  };

  /* --- 空闲预算:任何活动(建连/响应头/数据块)都会重置窗口;代际计数防过期触发 --- */
  let idleGeneration = 0;
  const armIdleTimer = (): void => {
    idleGeneration += 1;
    const generation = idleGeneration;
    void sleep(budgets.idleTimeoutMs).promise.then(() => {
      if (!settled && generation === idleGeneration) {
        fail(IDLE_TIMEOUT, `连接空闲超过预算 ${budgets.idleTimeoutMs}ms`);
      }
    });
  };

  /* --- 总时长预算:覆盖全部跳(含解析与重定向) --- */
  const deadline = sleep(budgets.totalTimeoutMs);
  void deadline.promise.then(() => {
    if (!settled) {
      fail(BUDGET_EXCEEDED, `远程读取总时长超过预算 ${budgets.totalTimeoutMs}ms`);
    }
  });

  if (options.signal !== undefined) {
    if (options.signal.aborted) {
      throw new RemoteReadFailure(ABORTED, '远程读取已被外部中止');
    }
    options.signal.addEventListener('abort', onAbortSignal, { once: true });
  }

  /* --- 溯源事实:最终 URL 与实际重定向跳数 --- */
  let finalUrl = firstTarget.toString();
  let redirectsFollowed = 0;

  const runAll = async (): Promise<RemoteSourceStream> => {
    let target = firstTarget;
    for (;;) {
      const plan = await Promise.race([validateHop(target, index, resolver), failurePromise]);
      const hop = sendHop(plan);
      current = { req: hop.req, res: null };
      armIdleTimer();
      let res: http.IncomingMessage;
      try {
        res = await Promise.race([hop.response, failurePromise]);
      } catch (error) {
        current = null;
        if (error instanceof RemoteReadFailure) {
          throw error;
        }
        throw new RemoteReadFailure(
          REMOTE_UNREACHABLE,
          `远程连接失败(${error instanceof Error ? error.name : 'unknown'}): ${plan.describe}`,
        );
      }
      current = { req: hop.req, res };
      armIdleTimer(); // 响应头到达 = 活动,重置空闲窗口

      const status = res.statusCode ?? 0;
      const locationValue = res.headers.location;
      if (status >= 300 && status < 400 && typeof locationValue === 'string' && locationValue !== '') {
        res.resume(); // 3xx 体直接丢弃
        destroyCurrent(); // 每跳独立连接:关闭当前跳,下一跳重新建连、重新解析、重新校验
        if (redirectsFollowed >= budgets.maxRedirects) {
          throw new RemoteReadFailure(
            REDIRECT_LIMIT,
            `重定向超过预算 ${budgets.maxRedirects} 跳: ${plan.describe}`,
          );
        }
        let next: URL;
        try {
          next = new URL(locationValue, target); // Location 绝对化后重走完整校验
        } catch {
          throw new RemoteReadFailure(TARGET_DENIED, `重定向 Location 非法: ${plan.describe}`);
        }
        redirectsFollowed += 1;
        target = next;
        finalUrl = target.toString();
        continue;
      }

      // 非重定向最终响应:以受控流返回;空闲/字节/中止预算继续贯穿流式阶段
      const stream = new PassThrough();
      stream.on('error', () => undefined); // 无消费方时防止 error 事件抛出;真实错误仍可达消费方
      let received = 0;
      res.on('data', (chunk: Buffer) => {
        armIdleTimer();
        received += chunk.length;
        const maxBytes = options.maxBytes;
        if (maxBytes !== undefined && received > maxBytes) {
          fail(BUDGET_EXCEEDED, `响应体超过字节上限 ${maxBytes} 字节: ${plan.describe}`);
          return;
        }
        if (!stream.write(chunk)) {
          res.pause();
        }
      });
      stream.on('drain', () => {
        res.resume();
      });
      res.on('end', () => {
        stream.end();
      });
      res.on('error', (error: Error) => {
        stream.destroy();
        fail(REMOTE_UNREACHABLE, `连接在对端中断(${error.name}): ${plan.describe}`);
      });
      exposedStream = stream;
      return {
        stream,
        contentType: headerText(res.headers['content-type']),
        contentEncoding: headerText(res.headers['content-encoding']),
        finalUrl,
        redirectsFollowed,
        close: async () => {
          // 消费方结束:清预算计时器与中止监听,销毁连接
          if (!settled) {
            settled = true;
            cleanupAfterSettle();
          }
          stream.destroy();
          destroyCurrent();
        },
      };
    }
  };

  try {
    const result = await Promise.race([runAll(), failurePromise]);
    // 成功开流:预算计时保持运行(流式阶段仍受空闲/字节/中止约束),close() 时清理
    return result;
  } catch (error) {
    const failure =
      error instanceof RemoteReadFailure
        ? error
        : new RemoteReadFailure(
            REMOTE_UNREACHABLE,
            `远程读取失败(${error instanceof Error ? error.name : 'unknown'})`,
          );
    if (!settled) {
      settled = true;
      cleanupAfterSettle();
      destroyCurrent();
      rejectFailure(failure);
    }
    throw failure;
  }
}

/* ------------------------------------------------------------------ */
/* 有界全量读取(CMS JSON/清单/key 等小体积场景)                        */
/* ------------------------------------------------------------------ */

/** 有界全量读取:打开受控流并收集为 Buffer;超字节预算时以 BUDGET_EXCEEDED 拒绝 */
export async function readBounded(
  url: string,
  options: OpenRemoteSourceOptions,
): Promise<SafeUpstreamReadResult> {
  const source = await openRemoteSource(url, options);
  try {
    const bytes = await collect(source.stream);
    return {
      bytes,
      contentType: source.contentType,
      contentEncoding: source.contentEncoding,
      finalUrl: source.finalUrl,
      redirectsFollowed: source.redirectsFollowed,
    };
  } finally {
    await source.close();
  }
}

function collect(stream: Readable): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    stream.on('data', (chunk: Buffer) => chunks.push(chunk));
    stream.on('end', () => resolve(Buffer.concat(chunks)));
    stream.on('error', reject);
  });
}

/* ------------------------------------------------------------------ */
/* 组合中止信号(嵌套台账 signal ⊕ 外部 signal)                         */
/* ------------------------------------------------------------------ */

interface CombinedSignal {
  signal: AbortSignal;
  /** 解除对外部信号的监听(读取结束后调用,防监听器累积) */
  dispose(): void;
}

function combineAbortSignals(signals: readonly (AbortSignal | undefined)[]): CombinedSignal {
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

/* ------------------------------------------------------------------ */
/* 嵌套预算台账(manifest→variant→segment→key)                          */
/* ------------------------------------------------------------------ */

export interface NestedBudgetLedgerOptions {
  /** 外部中止信号(会话取消等);中止即台账中止 */
  signal?: AbortSignal;
  /** 注入时钟驱动链总时限;缺省真实时间(unref 不驻留事件循环) */
  clock?: UpstreamClock;
}

/** 嵌套预算台账工厂:跨级累计字节 + 总量/总时限中止;失败读取不计账 */
export function createNestedBudgetLedger(
  budgets: UpstreamNestedBudgets,
  options: NestedBudgetLedgerOptions = {},
): NestedBudgetLedger {
  let spentBytes = 0;
  const controller = new AbortController();
  let disposed = false;

  const abortLedger = (): void => {
    if (!controller.signal.aborted) {
      controller.abort();
    }
  };

  // 外部信号中止 → 台账中止
  const external = options.signal ?? null;
  const forwardExternal = external === null ? null : (): void => abortLedger();
  if (external !== null && forwardExternal !== null) {
    if (external.aborted) {
      abortLedger();
    } else {
      external.addEventListener('abort', forwardExternal, { once: true });
    }
  }

  // 链总时限:到期中止台账;dispose 取消(注入时钟无取消语义,由 disposed 守卫忽略)
  let totalTimer: NodeJS.Timeout | null = null;
  if (!controller.signal.aborted) {
    if (options.clock !== undefined) {
      void options.clock.delay(budgets.totalTimeoutMs).then(() => {
        if (!disposed) {
          abortLedger();
        }
      });
    } else {
      totalTimer = setTimeout(abortLedger, budgets.totalTimeoutMs);
      totalTimer.unref?.();
    }
  }

  return {
    get spentBytes(): number {
      return spentBytes;
    },
    get remainingBytes(): number {
      return Math.max(0, budgets.totalMaxBytes - spentBytes);
    },
    levelBudget(level: UpstreamNestedLevel): number {
      return budgets.perLevelMaxBytes[level];
    },
    charge(bytes: number): boolean {
      if (controller.signal.aborted) {
        return false;
      }
      spentBytes += Math.max(0, bytes);
      if (spentBytes > budgets.totalMaxBytes) {
        abortLedger();
        return false;
      }
      return true;
    },
    get signal(): AbortSignal {
      return controller.signal;
    },
    dispose(): void {
      disposed = true;
      if (totalTimer !== null) {
        clearTimeout(totalTimer);
        totalTimer = null;
      }
      if (external !== null && forwardExternal !== null) {
        external.removeEventListener('abort', forwardExternal);
      }
    },
  };
}

/**
 * 单级嵌套读取:字节预算取 min(级别上限, 台账剩余, 调用方 byteBudget),
 * 中止信号取 外部 signal ⊕ 台账 signal;成功后按实收字节记账,
 * 台账总量耗尽(false)或链已中止即 BUDGET_EXCEEDED/ABORTED 拒绝。
 */
export async function readNestedLevel(
  ledger: NestedBudgetLedger,
  level: UpstreamNestedLevel,
  url: string,
  options: OpenRemoteSourceOptions,
): Promise<SafeUpstreamReadResult> {
  const levelBudget = ledger.levelBudget(level);
  const callerBudget = options.maxBytes;
  const effectiveBudget = Math.min(
    levelBudget,
    ledger.remainingBytes,
    ...(callerBudget !== undefined ? [callerBudget] : []),
  );
  const combined = combineAbortSignals([options.signal, ledger.signal]);
  try {
    const read = await readBounded(url, { ...options, maxBytes: effectiveBudget, signal: combined.signal });
    if (!ledger.charge(read.bytes.length)) {
      throw new RemoteReadFailure(BUDGET_EXCEEDED, `嵌套读取累计字节超过总量预算 ${read.bytes.length} 字节`);
    }
    return read;
  } finally {
    combined.dispose();
  }
}

/* ------------------------------------------------------------------ */
/* SafeUpstreamPort 实现(装配面)                                       */
/* ------------------------------------------------------------------ */

export interface SafeUpstreamServiceOptions {
  /** 缺省许可列表(未传 = 空列表 = 默认拒绝;请求侧可覆盖) */
  allowedTargets?: readonly UpstreamAllowedTarget[];
  /** 缺省时间/重定向预算(缺省 = IMPORT 传输预算) */
  timeBudgets?: UpstreamTimeBudgets;
  /** 缺省单次字节预算 */
  byteBudget?: number;
}

/** 创建 SafeUpstreamPort 实现:缺省值在装配处注入,请求侧字段逐一覆盖缺省 */
export function createSafeUpstreamService(defaults: SafeUpstreamServiceOptions = {}): SafeUpstreamPort {
  const toRequest = (request: SafeUpstreamOpenRequest): OpenRemoteSourceOptions => ({
    allowedTargets: request.allowedTargets ?? defaults.allowedTargets ?? [],
    timeBudgets: {
      ...(defaults.timeBudgets ?? DEFAULT_IMPORT_UPSTREAM_TIME_BUDGETS),
      ...(request.timeBudgets ?? {}),
    },
    maxBytes: request.byteBudget ?? defaults.byteBudget,
    signal: request.signal,
    resolver: request.resolver,
    clock: request.clock,
  });
  return {
    open: (request: SafeUpstreamOpenRequest): Promise<SafeUpstreamStreamHandle> =>
      openRemoteSource(request.url, toRequest(request)),
    read: (request: SafeUpstreamOpenRequest): Promise<SafeUpstreamReadResult> =>
      readBounded(request.url, toRequest(request)),
  };
}

/** 装配令牌再导出(单一来源在 safe-upstream.port.ts) */
export { SAFE_UPSTREAM_PORT };
