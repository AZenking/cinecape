/**
 * 名单保存 API(T052,US3)。
 *
 * lib/api.ts 与 packages/** 不在本任务可写范围,而契约
 * PUT /profiles/{profileId}/policy/lists 尚无既有客户端方法;此处按 api.ts 的
 * request 实现模式在组件层补齐同一传输语义(不改动 lib/**):
 * - 统一 /api 前缀;Cookie 为主通道(credentials:'include'),
 *   本地存有一次性 sessionToken 时附带 Bearer 兜底(与 api.ts 完全一致);
 * - 非 2xx 解析 RFC 9457 problem+json 抛 ApiError,错误处理与既有调用同构;
 * - ownerPassword 仅随 body 传输(writeOnly),不进 URL/query/日志/本地存储;
 *   每次保存都要求当次输入的密码(契约:逐次验证,无长期令牌)。
 */
import { API_BASE_URL, ApiError, BEARER_STORAGE_KEY } from '../../lib/api';
import type { ProblemDto } from '../../lib/api';
import type { PolicyDto, UpdateListsRequest } from '@hmp/shared';

function getStoredBearer(): string | null {
  if (typeof window === 'undefined') return null;
  try {
    return window.localStorage.getItem(BEARER_STORAGE_KEY);
  } catch {
    return null;
  }
}

/** 非 2xx 响应转 ApiError(与 api.ts 的 toApiError 同构) */
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

/**
 * PUT /profiles/{profileId}/policy/lists:三名单整体替换。
 * 服务端同事务校验家长验证、expectedVersion 乐观锁(不匹配 409 POLICY_VERSION_CONFLICT)、
 * 每 ID 同家庭归属与频道类型(非法 400 VALIDATION_FAILED),整体成功或失败;
 * 成功返回阶段 2 PolicyDto(version+1),失败原策略不变。
 */
export async function replacePolicyLists(
  profileId: string,
  body: UpdateListsRequest,
): Promise<PolicyDto> {
  const headers = new Headers();
  headers.set('Accept', 'application/json');
  headers.set('Content-Type', 'application/json');
  const bearer = getStoredBearer();
  if (bearer !== null) {
    headers.set('Authorization', `Bearer ${bearer}`);
  }

  const response = await fetch(
    `${API_BASE_URL}/profiles/${encodeURIComponent(profileId)}/policy/lists`,
    {
      method: 'PUT',
      headers,
      credentials: 'include',
      body: JSON.stringify(body),
    },
  );

  if (!response.ok) {
    throw await toApiError(response);
  }
  return (await response.json()) as PolicyDto;
}
