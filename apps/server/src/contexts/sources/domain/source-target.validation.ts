import { isIPv6 } from 'node:net';

/**
 * 来源目标语法级校验(T020;创建/修改时判定,语义对齐 imports/safe-http-reader 与 nas-scanner):
 * - 远程目标:协议仅 http/https;host 为 IP 字面量时拒绝 loopback / link-local(含云元数据
 *   169.254.169.254)/ unspecified / multicast·broadcast 类别;IPv4-mapped IPv6 写法一律拒绝
 *   (规范化后必命中拒绝类别,防解析器分歧绕过)。本模块为纯语法/字面判断,不做任何 DNS 或网络 IO ——
 *   主机名目标的 DNS 解析级类别校验由刷新期读取器(safe-http-reader)权威执行,此处放行不构成许可;
 * - NAS 目标:rootKey 必须出现在部署 MEDIA_ROOTS;relativeDirectory 必须为规范根内相对路径
 *   (空串 = 根本本身;禁空字节/反斜杠/绝对路径/盘符/空段·点段·..段),形态规则与 nas-scanner 一致;
 * - 请求期(400 层)与许可层(422)分离:isParsableRemoteUrl 只判「是否为带合法主机的绝对 URL」
 *   (交 zod,400 VALIDATION_FAILED);findRemoteTargetDenial/findNasTargetDenial 判「目标是否许可」
 *   (交服务层,422 SOURCE_TARGET_DENIED);
 * - 全部为纯函数;失败 reason 为稳定中文短语,绝不回显 URL/路径原文(凭据脱敏)。
 */

/** 请求期 URL 形态检查:可解析为绝对 URL,且主机非空并为合法主机名语法或 IP 字面量 */
export function isParsableRemoteUrl(text: string): boolean {
  let target: URL;
  try {
    target = new URL(text);
  } catch {
    return false;
  }
  const host = stripBrackets(target.hostname).replaceAll('%25', '%');
  if (host === '') {
    return false;
  }
  return isIpLiteral(host) !== null || isHostnameSyntax(host);
}

/** 许可层拒绝类别(与 safe-http-reader 的类别集一致,另含 IPv4-mapped 写法) */
type DeniedCategory = 'loopback' | 'link-local' | 'metadata' | 'unspecified' | 'multicast' | 'ipv4-mapped';

const CATEGORY_LABELS: Record<DeniedCategory, string> = {
  loopback: '环回地址',
  'link-local': '链路本地地址',
  metadata: '云元数据地址',
  unspecified: '未指定地址',
  multicast: '多播/广播地址',
  'ipv4-mapped': 'IPv4-mapped IPv6 写法',
};

/** 主机名语法:点分标签(字母/数字/连字符;每段 1~63,总长 ≤253,不以连字符开头/结尾) */
const HOSTNAME_SYNTAX_PATTERN =
  /^(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*$/;

function isHostnameSyntax(host: string): boolean {
  return host.length <= 253 && HOSTNAME_SYNTAX_PATTERN.test(host) && /[A-Za-z]/.test(host);
}

function stripBrackets(hostname: string): string {
  return hostname.startsWith('[') && hostname.endsWith(']') ? hostname.slice(1, -1) : hostname;
}

/* ------------------------------------------------------------------ */
/* IP 字面量解析与类别判定                                              */
/* ------------------------------------------------------------------ */

type IpLiteral = { family: 4 } | { family: 6 };

function isIpLiteral(host: string): IpLiteral | null {
  if (parseIpv4Octets(host) !== null) return { family: 4 };
  if (isIPv6(host)) return { family: 6 };
  return null;
}

/** 严格 IPv4 解析(前导零写法视为非字面量 → 交由主机名路径,与读取器口径一致) */
function parseIpv4Octets(text: string): [number, number, number, number] | null {
  const parts = text.split('.');
  if (parts.length !== 4) {
    return null;
  }
  const octets: number[] = [];
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) {
      return null;
    }
    if (part.length > 1 && part.startsWith('0')) {
      return null;
    }
    const value = Number(part);
    if (value > 255) {
      return null;
    }
    octets.push(value);
  }
  return [octets[0] ?? 0, octets[1] ?? 0, octets[2] ?? 0, octets[3] ?? 0];
}

function hexGroup(text: string): number | null {
  return /^[0-9a-f]{1,4}$/.test(text) ? parseInt(text, 16) : null;
}

/** IPv6 文本 → 8 个 16 位组(支持「::」压缩、内嵌 IPv4 末段;剥离 zone);非法返回 null */
function parseIpv6Groups(input: string): number[] | null {
  let text = input.toLowerCase();
  const zoneIndex = text.indexOf('%');
  if (zoneIndex !== -1) {
    text = text.slice(0, zoneIndex);
  }
  if (text === '') {
    return null;
  }
  const lastColon = text.lastIndexOf(':');
  if (lastColon !== -1 && text.includes('.', lastColon + 1)) {
    // 内嵌 IPv4 末段 → 两个 16 位组后统一处理
    const tail = parseIpv4Octets(text.slice(lastColon + 1));
    if (tail === null) {
      return null;
    }
    const high = (((tail[0] << 8) | tail[1]) >>> 0).toString(16);
    const low = (((tail[2] << 8) | tail[3]) >>> 0).toString(16);
    text = `${text.slice(0, lastColon)}:${high}:${low}`;
  }
  const doubleColon = text.indexOf('::');
  const groups: number[] = [];
  if (doubleColon !== -1) {
    if (text.indexOf('::', doubleColon + 2) !== -1) {
      return null; // 多个「::」非法
    }
    const headText = text.slice(0, doubleColon);
    const tailText = text.slice(doubleColon + 2);
    const head = headText === '' ? [] : headText.split(':');
    const tail = tailText === '' ? [] : tailText.split(':');
    if (head.length + tail.length >= 8) {
      return null; // 「::」至少要省略一组
    }
    for (const item of head) {
      const group = hexGroup(item);
      if (group === null) {
        return null;
      }
      groups.push(group);
    }
    for (let index = 0; index < 8 - head.length - tail.length; index += 1) {
      groups.push(0);
    }
    for (const item of tail) {
      const group = hexGroup(item);
      if (group === null) {
        return null;
      }
      groups.push(group);
    }
    return groups;
  }
  const parts = text.split(':');
  if (parts.length !== 8) {
    return null;
  }
  for (const item of parts) {
    const group = hexGroup(item);
    if (group === null) {
      return null;
    }
    groups.push(group);
  }
  return groups;
}

function deniedCategoryOfIpv4(text: string): DeniedCategory | null {
  const octets = parseIpv4Octets(text);
  if (octets === null) {
    return null;
  }
  const [b0 = 0, b1 = 0, b2 = 0, b3 = 0] = octets;
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
    return 'multicast';
  }
  return null;
}

function deniedCategoryOfIpv6(text: string): DeniedCategory | null {
  const groups = parseIpv6Groups(text);
  if (groups === null) {
    return null;
  }
  const first = groups[0] ?? 0;
  const zeros = (count: number): boolean => groups.slice(0, count).every((group) => group === 0);
  if (zeros(5) && groups[5] === 0xffff) {
    // ::ffff:a.b.c.d 映射写法一律拒绝(规范化后必命中类别,防解析器分歧绕过)
    return 'ipv4-mapped';
  }
  if (zeros(8)) {
    return 'unspecified'; // ::
  }
  if (zeros(7) && groups[7] === 1) {
    return 'loopback'; // ::1
  }
  if ((first & 0xffc0) === 0xfe80) {
    return 'link-local'; // fe80::/10
  }
  if ((first & 0xff00) === 0xff00) {
    return 'multicast'; // ff00::/8
  }
  return null;
}

/* ------------------------------------------------------------------ */
/* 许可判定(422 层)                                                    */
/* ------------------------------------------------------------------ */

/**
 * 远程目标许可判定:非许可返回拒绝原因(稳定短语,不回显原文),许可返回 null。
 * 仅做协议与 IP 字面类别判断;主机名的 DNS 级校验由刷新期读取器权威执行。
 */
export function findRemoteTargetDenial(urlText: string): string | null {
  let target: URL;
  try {
    target = new URL(urlText);
  } catch {
    return '远程地址不是合法 URL';
  }
  if (target.protocol !== 'http:' && target.protocol !== 'https:') {
    return '远程目标仅允许 http/https 协议';
  }
  const host = stripBrackets(target.hostname).replaceAll('%25', '%');
  if (host === '') {
    return '远程地址缺少主机';
  }
  const category = deniedCategoryOfIpv4(host) ?? deniedCategoryOfIpv6(host);
  if (category !== null) {
    return `远程目标命中拒绝类别(${CATEGORY_LABELS[category]}),不被许可`;
  }
  if (!isHostnameSyntax(host) && isIpLiteral(host) === null) {
    return '远程主机名语法非法';
  }
  return null;
}

/**
 * NAS 目标许可判定:rootKey 必须在部署 MEDIA_ROOTS;relativeDirectory 形态规则
 * 与 nas-scanner 一致(空串 = 根本本身)。非许可返回拒绝原因,许可返回 null。
 */
export function findNasTargetDenial(
  rootKey: string,
  relativeDirectory: string,
  mediaRoots: Readonly<Record<string, string>>,
): string | null {
  if (!(rootKey in mediaRoots)) {
    return 'NAS rootKey 未在部署 MEDIA_ROOTS 授权';
  }
  if (relativeDirectory.includes('\0')) {
    return 'NAS 相对目录含空字节';
  }
  if (relativeDirectory.includes('\\')) {
    return 'NAS 相对目录含反斜杠(仅接受「/」)';
  }
  if (relativeDirectory.startsWith('/') || /^[A-Za-z]:/.test(relativeDirectory)) {
    return 'NAS 相对目录必须是根内相对路径,不能是绝对路径';
  }
  if (relativeDirectory === '') {
    return null; // 空串 = 根本本身(nas-scanner 同规则)
  }
  if (relativeDirectory.split('/').some((segment) => segment === '' || segment === '.' || segment === '..')) {
    return 'NAS 相对目录含非法路径段(空段/点段/..)';
  }
  return null;
}
