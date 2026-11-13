import { isIPv4, isIPv6 } from 'node:net';
import { isAbsolute } from 'node:path';
import { z } from 'zod';

/**
 * 部署配置 —— 唯一来源是环境变量(FR-004:密钥/配置不进代码与镜像)。
 * 启动时 fail-fast:任何缺失/非法配置直接阻止服务启动。
 */

/* ------------------------------------------------------------------ */
/* MEDIA_ROOTS:NAS 来源 rootKey→只读挂载绝对路径映射(T010/research R4) */
/* ------------------------------------------------------------------ */

/** rootKey:1~64 字符,仅 [A-Za-z0-9_-] */
const MEDIA_ROOT_KEY_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

/** 只读媒体根映射(冻结;缺省为空 = 部署未授权任何 NAS 根)。 */
export type MediaRoots = Readonly<Record<string, string>>;

interface MediaRootsParse {
  roots: Record<string, string>;
  errors: string[];
}

/** 单遍解析并聚合全部条目级错误(调用方先 refine 汇总报错,再 transform 建表)。 */
function parseMediaRootsInput(raw: string): MediaRootsParse {
  const roots: Record<string, string> = {};
  const errors: string[] = [];
  const trimmed = raw.trim();
  if (trimmed === '') {
    return { roots, errors };
  }
  trimmed.split(',').forEach((pair, index) => {
    const where = `第 ${index + 1} 个条目`;
    const separator = pair.indexOf('=');
    if (separator === -1) {
      errors.push(`${where}缺少「=」(期望 rootKey=/绝对/路径)`);
      return;
    }
    const key = pair.slice(0, separator).trim();
    const value = pair.slice(separator + 1).trim();
    if (!MEDIA_ROOT_KEY_PATTERN.test(key)) {
      errors.push(`${where}的 rootKey 非法(须为 1~64 字符的 [A-Za-z0-9_-])`);
      return;
    }
    if (key in roots) {
      errors.push(`${where}的 rootKey「${key}」重复`);
      return;
    }
    if (value === '') {
      errors.push(`${where}的 rootKey「${key}」路径为空`);
      return;
    }
    if (value.includes('\0')) {
      errors.push(`${where}的 rootKey「${key}」路径包含空字节`);
      return;
    }
    if (!isAbsolute(value)) {
      errors.push(`${where}的 rootKey「${key}」路径不是绝对路径`);
      return;
    }
    if (value.split('/').some((segment) => segment === '..')) {
      errors.push(`${where}的 rootKey「${key}」路径包含「..」段`);
      return;
    }
    roots[key] = value;
  });
  return { roots, errors };
}

const mediaRootsSchema = z
  .string()
  .default('')
  .superRefine((raw, ctx) => {
    for (const message of parseMediaRootsInput(raw).errors) {
      ctx.addIssue({ code: 'custom', message });
    }
  })
  .transform((raw) => Object.freeze({ ...parseMediaRootsInput(raw).roots }));

/* ------------------------------------------------------------------------ */
/* LAN_ALLOWED_TARGETS:远程导入目标精确许可列表(T010/research R3)           */
/* 条目为 host、host:port 或 CIDR(IPv4/IPv6);拒绝通配符与「/0」允许全部,    */
/* 不提供「允许全部内网」开关。缺省为空 = 全部远程目标拒绝(默认拒绝)。      */
/* 受控例外:条目 public 放行全部公网单播目标;私网(RFC1918/ULA)与环回/链路  */
/* 本地/元数据仍须精确条目,类别拒绝(未指定/多播)恒不放宽。                */
/* ------------------------------------------------------------------------ */

/** 单条精确许可(冻结语义由数组层保证)。 */
export type LanTarget =
  | { readonly kind: 'host'; readonly host: string }
  | { readonly kind: 'hostPort'; readonly host: string; readonly port: number }
  | {
      readonly kind: 'cidr';
      readonly family: 4 | 6;
      readonly address: string;
      readonly prefixLength: number;
    }
  | { readonly kind: 'public' };

/** 主机名:点分字母/数字/连字符标签(每段 1~63,总长 ≤253,不得以连字符开头/结尾)。 */
const HOSTNAME_PATTERN =
  /^(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*$/;

type LanEntryResult = { ok: true; target: LanTarget } | { ok: false; error: string };
type LanPortResult = { ok: true; port: number } | { ok: false; error: string };

function parseLanPort(where: string, portText: string): LanPortResult {
  if (!/^[1-9]\d{0,4}$/.test(portText) || Number(portText) > 65535) {
    return { ok: false, error: `${where}的端口非法(须为 1~65535 的十进制数,无前导零)` };
  }
  return { ok: true, port: Number(portText) };
}

/** 精确目标:IPv4/IPv6 字面量或主机名;拒绝未指定地址(0.0.0.0/::)。返回 host 文本。 */
function parseLanHost(where: string, host: string): { ok: true; host: string } | { ok: false; error: string } {
  if (isIPv4(host) || isIPv6(host)) {
    if (host === '0.0.0.0' || host === '::') {
      return { ok: false, error: `${where}为未指定地址(${host}),不可作为许可目标` };
    }
    return { ok: true, host };
  }
  if (host.length === 0 || host.length > 253 || !HOSTNAME_PATTERN.test(host)) {
    return { ok: false, error: `${where}不是合法主机名或 IP(点分标签,字母/数字/连字符)` };
  }
  if (!/[A-Za-z]/.test(host)) {
    return { ok: false, error: `${where}是纯数字,既非合法 IP 也不是主机名` };
  }
  return { ok: true, host };
}

function parseLanTargetEntry(entry: string, index: number): LanEntryResult {
  const where = `第 ${index} 个条目`;
  if (entry === 'public') {
    // 受控放行条目:放行全部公网单播目标;私网/环回/元数据仍默认拒绝
    return { ok: true, target: { kind: 'public' } };
  }
  if (entry.includes('*')) {
    return { ok: false, error: `${where}含通配符「*」;仅允许精确 host、host:port 或 CIDR` };
  }
  if (entry.includes('/')) {
    const parts = entry.split('/');
    if (parts.length !== 2 || parts[0] === '' || !/^\d{1,3}$/.test(parts[1] ?? '')) {
      return { ok: false, error: `${where}不是合法 CIDR(期望 address/prefixLength)` };
    }
    const address = parts[0]!;
    const prefixLength = Number(parts[1]);
    const family = isIPv4(address) ? 4 : isIPv6(address) ? 6 : 0;
    if (family === 0) {
      return { ok: false, error: `${where}的 CIDR 地址不是合法 IPv4/IPv6` };
    }
    if (prefixLength === 0) {
      return { ok: false, error: `${where}为「/0」通配 CIDR(等价允许全部);research R3 明确不提供该开关` };
    }
    const maxPrefix = family === 4 ? 32 : 128;
    if (prefixLength > maxPrefix) {
      return { ok: false, error: `${where}的 CIDR 前缀长度超出 IPv${family} 上限 /${maxPrefix}` };
    }
    return { ok: true, target: { kind: 'cidr', family, address, prefixLength } };
  }
  if (entry.startsWith('[')) {
    const bracket = /^\[([^\]]*)\](?::(\d{1,5}))?$/.exec(entry);
    if (bracket === null || !isIPv6(bracket[1] ?? '')) {
      return { ok: false, error: `${where}不是合法 IPv6 字面量(期望 [IPv6] 或 [IPv6]:port)` };
    }
    const host = bracket[1]!;
    if (host === '::') {
      return { ok: false, error: `${where}为未指定地址([::]),不可作为许可目标` };
    }
    const portText = bracket[2];
    if (portText === undefined) {
      return { ok: true, target: { kind: 'host', host } };
    }
    const port = parseLanPort(where, portText);
    return port.ok ? { ok: true, target: { kind: 'hostPort', host, port: port.port } } : port;
  }
  if (entry.includes(':')) {
    // 裸 IPv6(可含「::」与 zone)优先按地址识别,避免与 host:port 的单冒号歧义。
    if (isIPv6(entry)) {
      if (entry === '::') {
        return { ok: false, error: `${where}为未指定地址(::),不可作为许可目标` };
      }
      return { ok: true, target: { kind: 'host', host: entry } };
    }
    const parts = entry.split(':');
    if (parts.length !== 2) {
      return { ok: false, error: `${where}无法识别:带端口的主机只允许一个「:」;IPv6 带端口请用 [IPv6]:port` };
    }
    const host = parseLanHost(where, parts[0] ?? '');
    if (!host.ok) {
      return host;
    }
    const port = parseLanPort(where, parts[1] ?? '');
    if (!port.ok) {
      return port;
    }
    return { ok: true, target: { kind: 'hostPort', host: host.host, port: port.port } };
  }
  const host = parseLanHost(where, entry);
  return host.ok ? { ok: true, target: { kind: 'host', host: host.host } } : host;
}

interface LanTargetsParse {
  targets: LanTarget[];
  errors: string[];
}

function parseLanTargetsInput(raw: string): LanTargetsParse {
  const targets: LanTarget[] = [];
  const errors: string[] = [];
  const trimmed = raw.trim();
  if (trimmed === '') {
    return { targets, errors };
  }
  const seen = new Set<string>();
  trimmed.split(',').forEach((entry, index) => {
    const item = entry.trim();
    const where = `第 ${index + 1} 个条目`;
    if (item === '') {
      errors.push(`${where}为空(检查是否有多余逗号)`);
      return;
    }
    if (seen.has(item)) {
      errors.push(`${where}「${item}」重复`);
      return;
    }
    seen.add(item);
    const result = parseLanTargetEntry(item, index + 1);
    if (!result.ok) {
      errors.push(result.error);
      return;
    }
    targets.push(result.target);
  });
  return { targets, errors };
}

const lanTargetsSchema = z
  .string()
  .default('')
  .superRefine((raw, ctx) => {
    for (const message of parseLanTargetsInput(raw).errors) {
      ctx.addIssue({ code: 'custom', message });
    }
  })
  .transform((raw) => Object.freeze(parseLanTargetsInput(raw).targets));

export const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(3000),
  /** SQLite 数据目录(容器内为 /data 卷) */
  DATA_DIR: z.string().default('./data'),
  DB_FILENAME: z.string().default('hmp.db'),
  /**
   * 会话滑动过期天数(每次认证使用刷新,research D5)。
   * 放宽为正数(允许小数天,T032 契约测试注入秒级极小 TTL 驱动过期场景;
   * 生产配置仍可继续使用整数天)。
   */
  SESSION_TTL_DAYS: z.coerce.number().positive().default(30),
  /** 会话绝对上限天数 —— 超过即强制重新登录 */
  SESSION_ABSOLUTE_DAYS: z.coerce.number().int().positive().default(90),
  /** PIN 连续失败上限 */
  PIN_MAX_ATTEMPTS: z.coerce.number().int().positive().default(5),
  /** PIN 锁定分钟数 */
  PIN_LOCK_MINUTES: z.coerce.number().int().positive().default(5),
  /** 局域网 HTTP 部署时为 false;公网/HTTPS 必须为 true */
  COOKIE_SECURE: z
    .enum(['true', 'false'])
    .default('false')
    .transform((v) => v === 'true'),
  LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
  /**
   * NAS 只读根映射,形如「rootKey1=/abs/path1,rootKey2=/abs/path2」(T010/research R4):
   * rootKey 1~64 字符 [A-Za-z0-9_-],值必须为绝对路径;
   * 重复 key、空值、相对路径、含「..」段、空字节均拒绝。缺省为空 = 未授权任何 NAS 根。
   */
  MEDIA_ROOTS: mediaRootsSchema,
  /**
   * 远程导入目标部署级精确许可,逗号分隔,条目为 host、host:port 或 CIDR
   * (IPv4/IPv6,T010/research R3):拒绝通配符与「/0」允许全部(0.0.0.0/0、::/0 非法),
   * 不提供「允许全部内网」开关。缺省为空 = 所有远程导入目标拒绝(默认拒绝)。
   */
  LAN_ALLOWED_TARGETS: lanTargetsSchema,
  /**
   * 转码全局并发额度(004/T010,research R4):所有 remux/transcode 共用原子额度,
   * 超额不排队直接忙(PLAYBACK_CONVERSION_BUSY)。范围 1~8,默认 1。
   */
  PLAYBACK_CONVERSION_CONCURRENCY: z.coerce.number().int().min(1).max(8).default(1),
  /**
   * 软件转码每任务线程上限(004/T010,research R4):落实为 x264 threads 参数,
   * 非硬 CPU/内存隔离,部署侧以 cgroup 限额。范围 1~8,默认 2。
   */
  PLAYBACK_SOFTWARE_THREADS: z.coerce.number().int().min(1).max(8).default(2),
  /**
   * 播放票据 TTL 秒数(004/T010,research R2/api.md):opaque ticket 默认 5 分钟,
   * 续期固定提前 60 秒且只换票。范围 60~900,默认 300。
   */
  PLAYBACK_TICKET_TTL_SECONDS: z.coerce.number().int().min(60).max(900).default(300),
  /**
   * 同源精确匹配 origin(005 api.md §1,T009):写操作与带密码查询携带 Origin 头时,
   * 必须与本值逐字相等(比较形态为 URL.origin 归一化结果,如 http://home.local:3000)。
   * 空串 = 未配置;fail-closed:凡携带 Origin 的请求一律 403 拒绝(无许可来源即无匹配)。
   * 校验:非空时必须为 origin 形态 URL —— 协议限 http/https,host 必填,
   * 不得携带路径/query/fragment/userinfo。
   */
  PUBLIC_ORIGIN: z
    .string()
    .trim()
    .default('')
    .superRefine((raw, ctx) => {
      if (raw === '') {
        return;
      }
      let url: URL;
      try {
        url = new URL(raw);
      } catch {
        ctx.addIssue({ code: 'custom', message: '必须为合法 URL(如 http://home.local:3000)' });
        return;
      }
      if (url.protocol !== 'http:' && url.protocol !== 'https:') {
        ctx.addIssue({ code: 'custom', message: '协议只允许 http 或 https' });
        return;
      }
      if (url.hostname === '') {
        ctx.addIssue({ code: 'custom', message: '缺少主机名' });
        return;
      }
      if (url.pathname !== '/' || url.search !== '' || url.hash !== '' || url.username !== '' || url.password !== '') {
        ctx.addIssue({ code: 'custom', message: '只允许 origin 形态,不得携带路径、查询、fragment 或用户信息' });
      }
    })
    .transform((raw) => (raw === '' ? '' : new URL(raw).origin)),
  /**
   * 限频代理信任(005 api.md §1「代理信任显式配置」,T009):true 时限频客户端 IP 取
   * X-Forwarded-For 首项(部署侧必须保证仅可信代理可设置该头);false(默认)只取
   * TCP 连接地址并忽略转发头,转发头不可伪造。
   */
  TRUST_PROXY: z
    .enum(['true', 'false'])
    .default('false')
    .transform((v) => v === 'true'),
  /* ---------------------------------------------------------------- */
  /* 020 TMDB 节目海报(可选;空 Key/Token = 关闭网络查询)                */
  /* ---------------------------------------------------------------- */
  /** v3 API Key;与 TMDB_READ_ACCESS_TOKEN 至少一个非空才启用网络查询 */
  TMDB_API_KEY: z.string().trim().default(''),
  /** v4 Read Access Token;优先于 v3 API Key */
  TMDB_READ_ACCESS_TOKEN: z.string().trim().default(''),
  /** 检索语言(BCP-47 简化形态,如 zh-CN/zh-TW/en-US) */
  TMDB_LANGUAGE: z
    .string()
    .trim()
    .default('zh-CN')
    .refine((raw) => /^[a-z]{2,3}(?:-[A-Za-z0-9]{2,8})?$/.test(raw), '必须为合法语言标签(如 zh-CN)'),
  /** 检索地区(ISO 3166-1 alpha-2) */
  TMDB_REGION: z
    .string()
    .trim()
    .default('CN')
    .transform((raw) => raw.toUpperCase())
    .refine((raw) => /^[A-Z]{2}$/.test(raw), '必须为两位地区码(如 CN)'),
  /** API 基址(允许本地代理;禁止 userinfo/query/fragment;生产建议 https) */
  TMDB_API_BASE_URL: z
    .string()
    .trim()
    .default('https://api.themoviedb.org/3')
    .refine((raw) => {
      try {
        const url = new URL(raw);
        return (
          (url.protocol === 'http:' || url.protocol === 'https:') &&
          url.hostname !== '' &&
          url.username === '' &&
          url.password === '' &&
          url.search === '' &&
          url.hash === ''
        );
      } catch {
        return false;
      }
    }, '必须为合法 http(s) URL,且不含 userinfo/query/fragment'),
  /** 图片基址(只存 poster_path,代理时拼接;生产建议 https) */
  TMDB_IMAGE_BASE_URL: z
    .string()
    .trim()
    .default('https://image.tmdb.org/t/p/w342')
    .refine((raw) => {
      try {
        const url = new URL(raw);
        return (
          (url.protocol === 'http:' || url.protocol === 'https:') &&
          url.hostname !== '' &&
          url.username === '' &&
          url.password === '' &&
          url.search === '' &&
          url.hash === ''
        );
      } catch {
        return false;
      }
    }, '必须为合法 http(s) URL,且不含 userinfo/query/fragment'),
  /** 单次刷新/回填最多网络检索数;0 = 只读缓存 */
  TMDB_MAX_LOOKUPS_PER_RUN: z.coerce.number().int().min(0).max(1000).default(300),
  /** 两次网络检索最小间隔(ms);0~5000 */
  TMDB_LOOKUP_INTERVAL_MS: z.coerce.number().int().min(0).max(5000).default(150),
  /** 单次补全总时长预算(ms);1000~600000 */
  TMDB_RUN_BUDGET_MS: z.coerce.number().int().min(1000).max(600000).default(90000),
  /** matched 缓存 TTL(天);TMDB 条款要求 ≤6 个月,硬上限 180 */
  TMDB_MATCHED_TTL_DAYS: z.coerce.number().int().min(1).max(180).default(180),
  /** no_match 负缓存 TTL(天) */
  TMDB_NEGATIVE_TTL_DAYS: z.coerce.number().int().min(1).max(365).default(30),
  /** failed 短 TTL(分钟) */
  TMDB_FAILURE_TTL_MINUTES: z.coerce.number().int().min(1).max(1440).default(60),
});

export type Env = z.infer<typeof envSchema>;

export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  const parsed = envSchema.safeParse(source);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `${i.path.join('.')}: ${i.message}`)
      .join('; ');
    throw new Error(`环境配置校验失败(fail-fast): ${issues}`);
  }
  return parsed.data;
}
