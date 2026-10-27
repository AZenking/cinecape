/**
 * 数据层全局 QueryClient 单例(T004;006 contracts/data-access.md「全局行为契约」)。
 *
 * - 模块级单例:全应用共享一份缓存,供键工厂(shared/query/keys.ts)与
 *   后续域清除(scopes.ts 的 purgePersonalData)操作同一实例;
 * - 默认配置(契约表逐项对应):
 *   - 浏览型 SWR:staleTime 30s、gcTime 5min、refetchOnMount/Focus/Reconnect 全开;
 *     (设置型「gcTime 0 + staleTime 0 + 无 placeholderData」由 useAppQuery 按域覆盖)
 *   - 重试:查询整体 ≤1 次——FetchApiError 5xx/429 重试 1 次、其余 4xx 不重试;
 *     非 FetchApiError(网络失败 TypeError 等)重试 1 次;AbortError 不计重试;
 *   - mutations retry: 0(变更一律由用户显式重发,不自动重试);
 *   - placeholderData 不设全局默认,由分页列表按调用传 keepPreviousData(hooks.ts)。
 * - 401 处理(FR-017):QueryCache.onError 全局捕获 FetchApiError(401)后调用
 *   注册的 handler(每 2s 一轮去重,防止并发查询重复触发登出引导);
 *   handler 本体(清空 profile+settings 域、引导重新登录)在 T030 接线,此处仅提供注册机制。
 * - devtools 不在本文件引入:独立包 @tanstack/react-query-devtools 且仅开发构建接入。
 */
import { isFetchApiError } from '../fetch';
import { QueryCache, QueryClient } from '@tanstack/react-query';

/** 未授权处理回调签名:由后续任务(SessionProvider 侧)注入真实实现 */
export type UnauthorizedHandler = () => void;

/** 默认 no-op:未注册 handler 时 401 仅被去重,不影响查询错误上抛 */
let unauthorizedHandler: UnauthorizedHandler = () => undefined;

/** 同一轮 401 风暴的去重窗口:窗口内重复 401 只触发一次 handler */
const UNAUTHORIZED_DEDUP_MS = 2_000;
let lastUnauthorizedAt = 0;

/** 注册 401 全局处理器(幂等覆盖式注册;测试可重复调用换新 handler) */
export function setUnauthorizedHandler(handler: UnauthorizedHandler): void {
  unauthorizedHandler = handler;
}

/**
 * 触发未授权处理:带每轮去重(2s 窗口内多次 401 只调用一次 handler)。
 * QueryCache.onError 内部使用;域清除流程(登出/切档)亦可显式调用对齐行为。
 */
export function notifyUnauthorized(): void {
  const now = Date.now();
  if (now - lastUnauthorizedAt < UNAUTHORIZED_DEDUP_MS) {
    return;
  }
  lastUnauthorizedAt = now;
  unauthorizedHandler();
}

/**
 * 查询重试策略(FR-014 幂等保险 + Q1):整体 ≤1 次。
 * - FetchApiError:5xx 与 429(限流)重试 1 次;其余 4xx 不重试(客户端错误重发同样失败);
 * - 非 FetchApiError:网络失败(TypeError 等)重试 1 次;
 * - AbortError:请求被取消,不视为失败,不重试(取消不计重试,research D4)。
 */
function queryRetry(failureCount: number, error: unknown): boolean {
  if (error instanceof DOMException && error.name === 'AbortError') {
    return false;
  }
  if (isFetchApiError(error)) {
    return failureCount < 1 && (error.status >= 500 || error.status === 429);
  }
  return failureCount < 1;
}

/** 全局 401 分流:仅 FetchApiError(401) 进入去重通知;其余错误由调用方错误态呈现 */
function handleQueryError(error: unknown): void {
  if (isFetchApiError(error) && error.status === 401) {
    notifyUnauthorized();
  }
}

/** 数据层唯一 QueryClient:providers.tsx 经 QueryClientProvider 注入 */
export const queryClient = new QueryClient({
  queryCache: new QueryCache({ onError: handleQueryError }),
  defaultOptions: {
    queries: {
      staleTime: 30_000,
      gcTime: 5 * 60 * 1000,
      refetchOnMount: true,
      // 契约「refetchOnFocus」对应的库内选项名(refetchOnWindowFocus)
      refetchOnWindowFocus: true,
      refetchOnReconnect: true,
      retry: queryRetry,
    },
    mutations: {
      retry: 0,
    },
  },
});
