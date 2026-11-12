import { syncServerNowIso } from './time/server-clock';

/**
 * 统一 typed fetch 底座(T010;005 Phase 2 共享基础设施)。
 *
 * - 所有前端网络请求的唯一入口(后续故事任务不得另建第二个 fetch 封装);
 *   旧登录优先骨架的 `lib/api.ts` 已随 006/T027 删除(统一数据层落地,遗留封装退役)。
 * - 响应类型由调用方以泛型传入(基于 `@hmp/shared` 契约类型,仅 type import),例:
 *
 * ```ts
 * import type { components } from '@hmp/shared';
 * const ctx = await publicFetch<components['schemas']['PublicContext']>('/public/context');
 * ```
 *
 * - 凭据档位(005 contracts/api.md §1 四类边界):
 *   - `publicFetch` → credentials:'omit':公共浏览请求(/public/*、/setup/status 等)。
 *     服务端公共投影与身份无关,不携带 cookie;公共响应不返回 Set-Cookie。
 *   - `privateFetch` → credentials:'same-origin':个人/设置请求(Session/Profile/
 *     Settings 边界)以及登录等需要同源 Set-Cookie 的请求。
 * - 错误映射:非 2xx 解析 RFC 9457 `application/problem+json` 为结构化
 *   `FetchApiError`(含 status/type/title/detail/code 与完整 problem 扩展字段);
 *   UI 据此区分 401/403/404/409/423/429 及稳定错误码(词表见 `@hmp/shared` ProblemCode)。
 * - 取消:调用方经 `init.signal` 传入 AbortSignal,在途请求立即以原生
 *   `DOMException('AbortError')` 拒绝(用 `isAbortError` 判定,与业务失败区分)。
 * - 服务端基准时钟:2xx JSON 响应体携带 `now` 字段时统一校准
 *   shared/time/server-clock(NTP 式 offset,时间展示与 EPG 进度的单一基准)。
 */

/** 所有 API 路径的统一前缀(开发期由 Vite 代理到 :3000,生产同源部署) */
export const API_BASE_URL = '/api';

/**
 * 请求凭据档位。
 * - `public`:公共浏览(匿名、身份无关)→ credentials:'omit';
 * - `private`:个人/设置(同源 httpOnly 会话 Cookie)→ credentials:'same-origin'。
 */
export type FetchScope = 'public' | 'private';

const SCOPE_CREDENTIALS: Record<FetchScope, RequestCredentials> = {
  public: 'omit',
  private: 'same-origin',
};

/**
 * 响应体若携带服务端时刻字段 `now`(GuideWindow/live groups/now-playing 等直播与
 * EPG 投影统一约定),经 server-clock 校准基准时钟(NTP 式 offset;016 spec
 * 「进度条以服务器返回的基准时间戳计算漂移差值」)。这里只识别合法 ISO 字符串,
 * 缺 now 的普通响应零影响(见 shared/time/server-clock.ts)。
 */
function syncServerClockFromBody(body: unknown): void {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    return;
  }
  syncServerNowIso((body as { now?: unknown }).now);
}

/** RFC 9457 problem+json 结构(契约 Problem;未知扩展字段原样保留) */
export interface ProblemDetails {
  /** 问题类型 URI;缺失时按 RFC 9457 语义以 'about:blank' 呈现 */
  type?: string;
  /** 人类可读概述 */
  title?: string;
  /** HTTP 状态码(服务端回显) */
  status?: number;
  /** 人类可读详情(面向观看者的文案,不含内部细节) */
  detail?: string;
  /** 机器可读稳定错误码(服务端扩展字段;词表见 `@hmp/shared` ProblemCode) */
  code?: string;
  /** 其他 RFC 9457 扩展字段(如 GUIDE_DATE_EXPIRED 携带的 allowedDates)原样保留 */
  [extension: string]: unknown;
}

export interface FetchApiErrorInit {
  status: number;
  title: string;
  type?: string | null;
  detail?: string | null;
  code?: string | null;
  /** 解析成功的完整 problem+json;非 problem+json 响应为 null */
  problem?: ProblemDetails | null;
}

/**
 * 非 2xx 响应抛出。字段与 RFC 9457 problem+json 一一对应;
 * 响应体不是 problem+json 时仅携带 status/title(此时 problem 为 null)。
 */
export class FetchApiError extends Error {
  readonly status: number;
  readonly type: string;
  readonly title: string;
  readonly detail: string | null;
  readonly code: string | null;
  readonly problem: ProblemDetails | null;

  constructor(init: FetchApiErrorInit) {
    super(init.detail ?? init.title);
    this.name = 'FetchApiError';
    this.status = init.status;
    this.type = init.type ?? 'about:blank';
    this.title = init.title;
    this.detail = init.detail ?? null;
    this.code = init.code ?? null;
    this.problem = init.problem ?? null;
  }
}

/** 类型守卫:网络失败(TypeError)与请求被中止(AbortError)不会是 FetchApiError */
export function isFetchApiError(error: unknown): error is FetchApiError {
  return error instanceof FetchApiError;
}

/** 请求被中止(调用方 signal 触发);与业务失败区分,UI 静默处理 */
export function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'AbortError';
}

export interface FetchInit {
  /** HTTP 方法,默认 'GET' */
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  /** 追加到路径后的查询参数;值为 undefined 的键省略 */
  query?: Record<string, string | number | boolean | undefined>;
  /** JSON 请求体(自动序列化);undefined 不发送请求体 */
  body?: unknown;
  /** 取消信号:透传给 fetch,在途请求立即以 DOMException('AbortError') 拒绝 */
  signal?: AbortSignal;
  /** 额外请求头(与底座默认头合并;同名键以调用方为准) */
  headers?: HeadersInit;
}

/** 查询参数编码;undefined 一律省略,全部缺省时返回空串(不带 '?') */
function buildQuery(params: Record<string, string | number | boolean | undefined> | undefined): string {
  if (!params) return '';
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined) {
      search.set(key, String(value));
    }
  }
  const query = search.toString();
  return query ? `?${query}` : '';
}

function fallbackTitle(response: Response): string {
  return response.statusText || `请求失败(HTTP ${response.status})`;
}

/** 非 2xx → FetchApiError:problem+json 逐字段映射,其余落回仅 status/title */
async function toFetchApiError(response: Response): Promise<FetchApiError> {
  const contentType = response.headers.get('Content-Type') ?? '';
  if (contentType.includes('application/problem+json')) {
    let parsed: unknown = null;
    try {
      parsed = await response.json();
    } catch {
      // problem+json 解析失败:落回通用错误
    }
    if (parsed !== null && typeof parsed === 'object') {
      const problem = parsed as ProblemDetails;
      return new FetchApiError({
        status: response.status,
        type: typeof problem.type === 'string' ? problem.type : null,
        title: typeof problem.title === 'string' && problem.title ? problem.title : fallbackTitle(response),
        detail: typeof problem.detail === 'string' ? problem.detail : null,
        code: typeof problem.code === 'string' ? problem.code : null,
        problem,
      });
    }
  }
  return new FetchApiError({ status: response.status, title: fallbackTitle(response), problem: null });
}

/**
 * 底座实现:publicFetch/privateFetch 共用。
 * - 网络失败以原生 TypeError 上抛(不包装);
 * - 204 无内容返回 undefined(TResponse 传 void);
 * - 2xx JSON 响应体以调用方泛型 TResponse 断言(契约类型由调用方负责)。
 */
async function requestJson<TResponse>(scope: FetchScope, path: string, init: FetchInit = {}): Promise<TResponse> {
  const headers = new Headers(init.headers);
  headers.set('Accept', 'application/json');
  if (init.body !== undefined && !headers.has('Content-Type')) {
    headers.set('Content-Type', 'application/json');
  }

  const response = await fetch(`${API_BASE_URL}${path}${buildQuery(init.query)}`, {
    method: init.method ?? 'GET',
    headers,
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
    credentials: SCOPE_CREDENTIALS[scope],
    signal: init.signal,
  });

  if (!response.ok) {
    throw await toFetchApiError(response);
  }
  if (response.status === 204) {
    return undefined as TResponse;
  }
  const body = (await response.json()) as TResponse;
  // 服务端基准时钟校准:所有 2xx JSON 响应统一在此过一层(携带 now 即校准)
  syncServerClockFromBody(body);
  return body;
}

/**
 * 公共浏览请求(credentials:'omit'):/public/* 只读端点、/setup/status 等匿名地址。
 * 即使浏览器携带(失效)cookie 也不随请求发送,服务端投影与身份无关。
 */
export function publicFetch<TResponse>(path: string, init: FetchInit = {}): Promise<TResponse> {
  return requestJson<TResponse>('public', path, init);
}

/**
 * 个人/设置请求(credentials:'same-origin'):Session/Profile/Settings 边界端点,
 * 依赖同源 httpOnly 会话 Cookie;登录等需要接收 Set-Cookie 的请求同样走此档位。
 */
export function privateFetch<TResponse>(path: string, init: FetchInit = {}): Promise<TResponse> {
  return requestJson<TResponse>('private', path, init);
}
