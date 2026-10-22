/**
 * 类型化 API 客户端(T014)。
 *
 * - 契约单一事实源:`docs/specs/001-scaffold-identity-foundation/contracts/openapi.yaml`,
 *   经 openapi-typescript 生成为 `packages/shared/src/schema.d.ts`。
 * - 契约类型经工作区依赖 `@hmp/shared`(`workspace:*`)引入,仅作
 *   `import type`(构建期擦除,零运行时代价)。
 * - 传输通道(research D5):httpOnly Cookie 为主(`credentials: 'include'`);
 *   若本地存有一次性 sessionToken,则附带 `Authorization: Bearer` 作为备用通道。
 */
import type { components, paths } from '@hmp/shared';
import type { ProblemCode } from '@hmp/shared';

/** 所有 API 路径的统一前缀(开发期由 Vite 代理到 :3000,生产同源部署) */
export const API_BASE_URL = '/api';

/** Bearer 备用通道的本地存储键(Cookie 为主通道,此键仅兜底) */
export const BEARER_STORAGE_KEY = 'hmp_bearer';

type HttpMethod = 'get' | 'post' | 'patch';

/** RFC 9457 problem+json(契约 components.schemas.Problem) */
export type ProblemDto = components['schemas']['Problem'];

export interface ApiErrorInit {
  status: number;
  code?: ProblemCode | (string & {});
  title: string;
  detail?: string;
}

/** 非 2xx 响应抛出:字段与 RFC 9457 problem+json 一一对应 */
export class ApiError extends Error {
  readonly status: number;
  readonly code?: ProblemCode | (string & {});
  readonly title: string;
  readonly detail?: string;

  constructor(init: ApiErrorInit) {
    super(init.detail ?? init.title);
    this.name = 'ApiError';
    this.status = init.status;
    this.code = init.code;
    this.title = init.title;
    this.detail = init.detail;
  }
}

/* ---------------------------------- 类型辅助 ---------------------------------- */

/** 筛出声明了某 HTTP 方法的路径字面量(未声明处生成的类型为可选 never) */
type PathsWith<M extends HttpMethod> = {
  [P in keyof paths]: paths[P] extends { [K in M]: unknown } ? P : never;
}[keyof paths];

/** 取路径某方法对应的 operation 类型 */
export type OperationOf<P extends keyof paths, M extends HttpMethod> = paths[P] extends {
  [K in M]: infer TOperation;
}
  ? TOperation
  : never;

/** 提取 operation 的 2xx application/json 响应体;204 等无内容响应为 undefined */
export type ApiResponse<TOperation> = TOperation extends { responses: infer TResponses }
  ? {
      [TStatus in keyof TResponses & (200 | 201 | 202 | 204)]: TResponses[TStatus] extends {
        content: { 'application/json': infer TBody };
      }
        ? TBody
        : undefined;
    }[keyof TResponses & (200 | 201 | 202 | 204)]
  : never;

/** 提取 operation 的请求体类型;无请求体的操作为 undefined */
export type RequestBodyOf<P extends keyof paths, M extends HttpMethod> =
  OperationOf<P, M> extends { requestBody: { content: { 'application/json': infer TBody } } }
    ? TBody
    : undefined;

/* ---------------------------------- 本地令牌 ---------------------------------- */

function getStoredBearer(): string | null {
  if (typeof window === 'undefined') return null;
  try {
    return window.localStorage.getItem(BEARER_STORAGE_KEY);
  } catch {
    return null;
  }
}

/** 登录成功后写入一次性 sessionToken;注销/恢复失败时清除(传 null) */
export function storeBearer(token: string | null): void {
  if (typeof window === 'undefined') return;
  try {
    if (token === null) {
      window.localStorage.removeItem(BEARER_STORAGE_KEY);
    } else {
      window.localStorage.setItem(BEARER_STORAGE_KEY, token);
    }
  } catch {
    // localStorage 不可用(隐私模式等):静默降级为纯 Cookie 通道
  }
}

/* ---------------------------------- 请求实现 ---------------------------------- */

async function toApiError(response: Response): Promise<ApiError> {
  const contentType = response.headers.get('Content-Type') ?? '';
  if (contentType.includes('application/problem+json')) {
    try {
      const problem = (await response.json()) as ProblemDto;
      return new ApiError({
        status: response.status,
        code: typeof problem.code === 'string' ? problem.code : undefined,
        title: typeof problem.title === 'string' && problem.title ? problem.title : '请求失败',
        detail: typeof problem.detail === 'string' ? problem.detail : undefined,
      });
    } catch {
      // problem+json 解析失败:落回通用错误
    }
  }
  return new ApiError({
    status: response.status,
    title: response.statusText || `请求失败(${response.status})`,
  });
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers);
  headers.set('Accept', 'application/json');
  if (init.body !== undefined && !headers.has('Content-Type')) {
    headers.set('Content-Type', 'application/json');
  }
  const bearer = getStoredBearer();
  if (bearer) {
    headers.set('Authorization', `Bearer ${bearer}`);
  }

  const response = await fetch(`${API_BASE_URL}${path}`, {
    ...init,
    headers,
    credentials: 'include',
  });

  if (!response.ok) {
    throw await toApiError(response);
  }
  if (response.status === 204) {
    return undefined as T;
  }
  return (await response.json()) as T;
}

/* ---------------------------------- 客户端 ---------------------------------- */

/** 类型化 ApiClient:路径与响应/请求体类型均由契约生成类型约束 */
export class ApiClient {
  /** GET:仅允许契约中声明了 get 的路径 */
  async get<P extends PathsWith<'get'>>(
    path: P,
    init?: Omit<RequestInit, 'method' | 'body'>,
  ): Promise<ApiResponse<OperationOf<P, 'get'>>> {
    return request(path, { ...init, method: 'GET' });
  }

  /** POST:请求体按契约 InitializeRequest/LoginRequest 等约束 */
  async post<P extends PathsWith<'post'>>(
    path: P,
    body?: RequestBodyOf<P, 'post'>,
    init?: Omit<RequestInit, 'method' | 'body'>,
  ): Promise<ApiResponse<OperationOf<P, 'post'>>> {
    return request(path, {
      ...init,
      method: 'POST',
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  }

  /** PATCH:Profile 编辑等 */
  async patch<P extends PathsWith<'patch'>>(
    path: P,
    body?: RequestBodyOf<P, 'patch'>,
    init?: Omit<RequestInit, 'method' | 'body'>,
  ): Promise<ApiResponse<OperationOf<P, 'patch'>>> {
    return request(path, {
      ...init,
      method: 'PATCH',
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  }
}

/** 应用级单例 */
export const api = new ApiClient();
