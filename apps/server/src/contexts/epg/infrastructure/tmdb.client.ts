/**
 * 020 TMDB 客户端（EPG 上下文基础设施适配器）。
 *
 * 最小调用路径：只调用 GET /search/multi，一次返回 movie/tv/person 与 poster_path；
 * 不调用详情/图片/季集接口。缓存、去重、匹配与节流在 application/domain 层。
 *
 * 安全/稳定性：
 * - Key 只从环境读取；错误与日志不包含 Key/完整 URL/query；
 * - Node fetch + AbortSignal.timeout(8s)，不继承环境代理；
 * - 401 熔断 60 分钟；连续 429/5xx 熔断 5 分钟；429/5xx/超时最多重试 2 次；
 * - NODE_ENV=test 且未注入 fetchImpl 时禁用真实网络，避免测试误发请求。
 */

import type { LanTarget } from '@platform/config/env.schema';
import { getConfig } from '@platform/config/env';
import type { TmdbPosterCandidate } from '@contexts/epg/domain/programme-poster-match';

export type TmdbErrorKind = 'auth' | 'rate_limit' | 'circuit_open' | 'timeout' | 'http' | 'json' | 'network' | 'disabled';

export class TmdbError extends Error {
  constructor(
    readonly kind: TmdbErrorKind,
    message: string,
    readonly retryAfterMs: number | null = null,
  ) {
    super(message);
    this.name = 'TmdbError';
  }
}

export interface TmdbSearchInput {
  readonly query: string;
  readonly language: string;
  readonly region: string;
}

export interface TmdbClient {
  /** 至少配置了 v3 Key/v4 Token 且允许网络时返回 true。 */
  isEnabled(): boolean;
  /** 检索并按最小结构过滤/映射；调用方负责匹配与缓存。 */
  searchMulti(input: TmdbSearchInput): Promise<readonly TmdbPosterCandidate[]>;
}

export interface TmdbClientDeps {
  /** 测试注入；注入后即使 NODE_ENV=test 也允许（不会访问真实网络）。 */
  readonly fetchImpl?: typeof fetch;
  readonly nowMs?: () => number;
  readonly sleep?: (ms: number) => Promise<void>;
}

const REQUEST_TIMEOUT_MS = 8_000;
const MAX_RETRIES = 2;
const AUTH_CIRCUIT_MS = 60 * 60_000;
const FAILURE_CIRCUIT_MS = 5 * 60_000;
const FAILURE_THRESHOLD = 3;

function sleepDefault(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function parseRetryAfter(value: string | null, nowMs: number): number | null {
  if (value === null || value.trim() === '') {
    return null;
  }
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) {
    return Math.min(seconds * 1000, 5 * 60_000);
  }
  const date = Date.parse(value);
  if (Number.isFinite(date)) {
    return Math.min(Math.max(0, date - nowMs), 5 * 60_000);
  }
  return null;
}

function numberOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function stringOrNull(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value : null;
}

function toCandidate(raw: unknown): TmdbPosterCandidate | null {
  if (typeof raw !== 'object' || raw === null) {
    return null;
  }
  const row = raw as Record<string, unknown>;
  const id = numberOrNull(row['id']);
  const mediaType = typeof row['media_type'] === 'string' ? row['media_type'] : '';
  if (id === null || (mediaType !== 'movie' && mediaType !== 'tv')) {
    return null;
  }
  const isMovie = mediaType === 'movie';
  const title = isMovie ? stringOrNull(row['title']) : stringOrNull(row['name']);
  if (title === null) {
    return null;
  }
  return {
    id,
    mediaType,
    title,
    originalTitle: isMovie ? stringOrNull(row['original_title']) : stringOrNull(row['original_name']),
    posterPath: stringOrNull(row['poster_path']),
    releaseDate: isMovie ? stringOrNull(row['release_date']) : stringOrNull(row['first_air_date']),
    voteAverage: numberOrNull(row['vote_average']),
    popularity: numberOrNull(row['popularity']),
    adult: row['adult'] === true,
  };
}

/**
 * 创建 TMDB 客户端。实例持有进程内熔断状态；建议在 EpgModule 中单例装配。
 */
export function createTmdbClient(deps: TmdbClientDeps = {}): TmdbClient {
  const now = deps.nowMs ?? (() => Date.now());
  const sleep = deps.sleep ?? sleepDefault;
  const injectedFetch = deps.fetchImpl;
  let circuitOpenUntil = 0;
  let consecutiveFailures = 0;

  function effectiveFetch(): typeof fetch | null {
    if (injectedFetch !== undefined) {
      return injectedFetch;
    }
    if (getConfig().NODE_ENV === 'test') {
      return null;
    }
    return globalThis.fetch;
  }

  function isEnabled(): boolean {
    const config = getConfig();
    const hasCredential = config.TMDB_API_KEY !== '' || config.TMDB_READ_ACCESS_TOKEN !== '';
    return hasCredential && effectiveFetch() !== null && config.TMDB_MAX_LOOKUPS_PER_RUN > 0;
  }

  function openCircuit(ms: number): void {
    circuitOpenUntil = Math.max(circuitOpenUntil, now() + ms);
  }

  function noteFailure(): void {
    consecutiveFailures += 1;
    if (consecutiveFailures >= FAILURE_THRESHOLD) {
      openCircuit(FAILURE_CIRCUIT_MS);
    }
  }

  function noteSuccess(): void {
    consecutiveFailures = 0;
    circuitOpenUntil = 0;
  }

  function buildUrl(config: ReturnType<typeof getConfig>, input: TmdbSearchInput): URL {
    const base = config.TMDB_API_BASE_URL.replace(/\/+$/, '');
    const url = new URL(`${base}/search/multi`);
    url.searchParams.set('query', input.query);
    url.searchParams.set('language', input.language);
    url.searchParams.set('region', input.region);
    url.searchParams.set('include_adult', 'false');
    url.searchParams.set('page', '1');
    if (config.TMDB_API_KEY !== '' && config.TMDB_READ_ACCESS_TOKEN === '') {
      url.searchParams.set('api_key', config.TMDB_API_KEY);
    }
    return url;
  }

  function headersFor(config: ReturnType<typeof getConfig>): Record<string, string> {
    const headers: Record<string, string> = {
      accept: 'application/json',
      'user-agent': 'Cinecape/0.1 (self-hosted TMDB poster matcher)',
    };
    if (config.TMDB_READ_ACCESS_TOKEN !== '') {
      headers.authorization = `Bearer ${config.TMDB_READ_ACCESS_TOKEN}`;
    }
    return headers;
  }

  async function requestOnce(url: URL, headers: Record<string, string>): Promise<readonly TmdbPosterCandidate[]> {
    const fetcher = effectiveFetch();
    if (fetcher === null) {
      throw new TmdbError('disabled', 'TMDB 客户端未启用');
    }
    let response: Response;
    try {
      response = await fetcher(url.toString(), {
        method: 'GET',
        headers,
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        redirect: 'error',
      });
    } catch (error) {
      const name = error instanceof Error ? error.name : 'unknown';
      if (name === 'TimeoutError' || name === 'AbortError') {
        throw new TmdbError('timeout', 'TMDB 请求超时');
      }
      throw new TmdbError('network', `TMDB 网络请求失败(${name})`);
    }

    if (response.status === 401 || response.status === 403) {
      openCircuit(AUTH_CIRCUIT_MS);
      throw new TmdbError('auth', 'TMDB 认证失败');
    }
    if (response.status === 429) {
      noteFailure();
      throw new TmdbError(
        'rate_limit',
        'TMDB 限频',
        parseRetryAfter(response.headers.get('retry-after'), now()),
      );
    }
    if (response.status < 200 || response.status >= 300) {
      noteFailure();
      throw new TmdbError('http', `TMDB 上游状态异常(${response.status})`);
    }

    let payload: unknown;
    try {
      payload = await response.json();
    } catch {
      throw new TmdbError('json', 'TMDB 响应不是合法 JSON');
    }
    if (typeof payload !== 'object' || payload === null) {
      throw new TmdbError('json', 'TMDB 响应结构非法');
    }
    const results = (payload as { results?: unknown }).results;
    if (!Array.isArray(results)) {
      throw new TmdbError('json', 'TMDB 响应缺少 results');
    }
    const candidates: TmdbPosterCandidate[] = [];
    for (const item of results) {
      const candidate = toCandidate(item);
      if (candidate !== null) {
        candidates.push(candidate);
      }
    }
    noteSuccess();
    return candidates;
  }

  async function searchMulti(input: TmdbSearchInput): Promise<readonly TmdbPosterCandidate[]> {
    const config = getConfig();
    if (!isEnabled()) {
      throw new TmdbError('disabled', 'TMDB 客户端未启用');
    }
    if (circuitOpenUntil > now()) {
      throw new TmdbError('circuit_open', 'TMDB 熔断中', circuitOpenUntil - now());
    }

    const url = buildUrl(config, input);
    const headers = headersFor(config);
    let lastError: unknown = null;
    for (let attempt = 0; attempt <= MAX_RETRIES; attempt += 1) {
      try {
        return await requestOnce(url, headers);
      } catch (error) {
        lastError = error;
        if (!(error instanceof TmdbError)) {
          throw error;
        }
        const retryable =
          error.kind === 'rate_limit' || error.kind === 'timeout' || error.kind === 'network' || error.kind === 'http';
        if (!retryable || attempt === MAX_RETRIES) {
          throw error;
        }
        const backoff = error.retryAfterMs ?? Math.min(1000 * 2 ** attempt, 4000);
        await sleep(backoff);
      }
    }
    throw lastError instanceof Error ? lastError : new TmdbError('network', 'TMDB 请求失败');
  }

  return { isEnabled, searchMulti };
}

/**
 * 图片代理允许目标:只允许配置的图片基址 host(精确 host,任意端口)。
 * 不使用 LAN_ALLOWED_TARGETS 的 public 全放行,避免把代理变成通用外网图片代理。
 */
export function tmdbImageAllowedTargets(imageBaseUrl: string): readonly LanTarget[] {
  const url = new URL(imageBaseUrl);
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error('TMDB_IMAGE_BASE_URL 协议非法');
  }
  return Object.freeze([{ kind: 'host', host: url.hostname }]);
}