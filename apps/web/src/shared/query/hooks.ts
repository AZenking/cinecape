/**
 * 数据层封装 hook(T022;006 contracts/data-access.md「queryFn 集成契约」+「mutation 契约」)。
 *
 * - 所有页面仅经本文件的 useAppQuery/useAppMutation 触达 react-query,
 *   不直接使用裸 useQuery/useMutation(分层不变式);
 * - `signal` 一律透传给调用方 queryFn(键变化/卸载自动取消,FR-015);
 *   错误保持 FetchApiError 原样上抛,文案经 shared/query/error.ts 映射链由 UI 呈现;
 * - 域行为差异(research D2/契约表):
 *   - `public`/`profile`:浏览型 SWR——staleTime 缺省 30s(可按调用覆盖,EPG 慢变传 60s),
 *     支持分页 placeholderData: keepPreviousData;
 *   - `settings`:强制最新——staleTime 0 + gcTime 0 且禁用 placeholderData,
 *     进入必硬请求,UI 以 isPending 门控骨架(缓存旧值无处可显);
 * - 乐观更新(research D3):`feedback: 'optimistic'` 按官方模式
 *   onMutate 取消在途 → 快照 → setQueryData;onError 回滚 + 提示;
 *   onSettled 无条件失效对账。`confirmed` 无乐观写,仅等待态 + 失效。
 *   单表面积简单变更优先调用方"UI variables + isPending"变体,不走本封装乐观路径。
 */
import { useRef } from 'react';
import {
  keepPreviousData,
  useMutation,
  useQuery,
  type UseMutationResult,
  type UseQueryResult,
} from '@tanstack/react-query';
import { queryClient } from './client';
import { formatApiError } from './error';
import { useAppToast } from '../ui';
import type { FetchApiError } from '../fetch';

/** 身份缓存域:public→publicFetch;profile/settings→privateFetch(由调用方 queryFn 决定) */
export type QueryDomain = 'public' | 'profile' | 'settings';

/** 浏览型域默认新鲜窗口(目录/直播;FR-012) */
export const APP_QUERY_STALE_TIME_MS = 30_000;
/** EPG 慢变数据的新鲜窗口(契约表;按调用传入 staleTime 覆盖默认) */
export const EPG_QUERY_STALE_TIME_MS = 60_000;

/** useAppQuery 的 queryFn 上下文:库提供的取消信号透传给 fetch 底座 */
export interface AppQueryFnContext {
  signal: AbortSignal;
}

/** useAppMutation 的 mutationFn 上下文 */
export interface AppMutationFnContext {
  /**
   * 取消信号:@tanstack/react-query@5.105 的 MutationFunctionContext 暂不提供
   * mutation 专用 signal,此处恒为 undefined;字段先行预留以稳定调用方签名,
   * 升级到带 signal 的版本后自动透传,无需改动调用方。
   */
  signal?: AbortSignal;
}

export interface AppQueryOptions<TData> {
  /** 身份缓存域:决定新鲜度/占位策略 */
  domain: QueryDomain;
  /** 键工厂产出的查询键(shared/query/keys.ts;禁止手写字符串键) */
  queryKey: readonly unknown[];
  /** 对 publicFetch/privateFetch 的薄包装;必须透传 signal */
  queryFn: (ctx: AppQueryFnContext) => Promise<TData>;
  /** 覆盖默认新鲜窗口;settings 域忽略(恒 0) */
  staleTime?: number;
  /** 分页占位(传 keepPreviousData);settings 域忽略并禁用 */
  placeholderData?: typeof keepPreviousData | undefined;
  /** 条件取数(如等待 session 就绪);缺省启用 */
  enabled?: boolean;
}

/**
 * 统一查询封装:按域应用默认值并透传 signal;错误类型固定为 FetchApiError。
 * 返回值即 useQuery 结果(isPending/isError/data 等),错误态文案由 UI 经 formatApiError 映射。
 */
export function useAppQuery<TData>(options: AppQueryOptions<TData>): UseQueryResult<TData, FetchApiError> {
  const { domain, queryKey, queryFn, staleTime, placeholderData, enabled } = options;
  const isSettings = domain === 'settings';

  // settings 域外部注入防御(Q2/FR-012 硬保证):gcTime:0 只保证「经本 hook 生命
  // 周期」的进入是硬请求;若外部预取/水合向同键注入缓存(如未来 persist/prefetch),
  // 首次挂载仍可能渲染旧值。此处于观察前同步移除同键缓存,确保任何来源的进入
  // 都是 isPending 硬请求。
  // ⚠️ 必须每实例每键只执行一次(useRef 按值去重):键工厂每次调用返回新数组实例,
  // 若按引用比较或在每次渲染执行,会把带活跃 observer 的条目删掉 → observer 重建
  // pending 条目 → 重取 → 成功通知 → 再渲染 → 再删……无限重取循环(页面永远停在骨架)。
  // 键变更(按值比较触发)时重新防御;卸载重挂是新实例,重挂仍硬请求。
  const removedKeyRef = useRef<string | null>(null);
  if (isSettings) {
    const keyHash = JSON.stringify(queryKey);
    if (removedKeyRef.current !== keyHash) {
      removedKeyRef.current = keyHash;
      queryClient.removeQueries({ queryKey });
    }
  }

  return useQuery<TData, FetchApiError>({
    queryKey,
    // signal 透传:库在键变化/卸载时中止,AbortError 原样上抛(不包装、不计重试)
    queryFn: (ctx) => queryFn({ signal: ctx.signal }),
    enabled,
    // settings 强制最新:恒过期(覆盖全局 30s);浏览型用调用方覆盖值或缺省 30s
    staleTime: isSettings ? 0 : (staleTime ?? APP_QUERY_STALE_TIME_MS),
    // settings 卸载即弃(覆盖全局 gcTime 5min):条目一拆即清,不留旧值
    ...(isSettings ? { gcTime: 0 } : {}),
    // 分页占位仅浏览型支持;settings 禁用——挂载必取、以 isPending 门控骨架
    ...(!isSettings && placeholderData !== undefined ? { placeholderData } : {}),
  });
}

/** 乐观快照:onError 回滚依据;snapshotKey 提供时同步登记到模块注册表 */
export interface OptimisticSnapshot {
  /** 被乐观写入的查询键 */
  queryKey: readonly unknown[];
  /** 写入前的缓存值(缓存不存在时为 undefined) */
  previous: unknown;
  /** 调用方提供的注册键(可选) */
  snapshotKey?: string;
}

/** 乐观快照注册表:snapshotKey 提供时跨闭包可查,供并发同类变更/调试定位 */
const snapshotRegistry = new Map<string, OptimisticSnapshot>();

/** 提示回调:缺省经 AppToastRegion(HeroUI Toast,providers.tsx 挂载)呈现;调用方可注入覆盖 */
export type ToastFn = (message: string, kind: 'success' | 'error') => void;

export interface AppMutationOptions<TVars, TData> {
  /** 身份缓存域(声明式标记:供后续 401/切档联动按域归组;取数通道由调用方 mutationFn 决定) */
  domain: QueryDomain;
  /** 对 publicFetch/privateFetch 的薄包装;signal 字段当前版本恒 undefined(见 AppMutationFnContext) */
  mutationFn: (vars: TVars, ctx: AppMutationFnContext) => Promise<TData>;
  /** 反馈分档:'optimistic' 走乐观写;其他一律 'confirmed' 等待态 */
  feedback: 'optimistic' | 'confirmed';
  /** 乐观写配置:feedback 为 'optimistic' 时必填,其余档忽略 */
  optimistic?: {
    /** 被乐观写入的查询键(键工厂产出) */
    queryKey: readonly unknown[];
    /** 由旧值与本次变量计算新缓存值 */
    apply: (old: unknown, vars: TVars) => unknown;
    /** 快照注册键(可选):提供后快照同时登记到模块注册表 */
    snapshotKey?: string;
  };
  /** 成功/失败后统一失效的查询键集合(onSettled 对账;禁止整页刷新替代) */
  invalidate?: readonly (readonly unknown[])[];
  /** 成功提示文案;缺省不提示 */
  successToast?: string;
  /** 乐观失败回滚提示文案;缺省提示映射后的错误文案 */
  rollbackToast?: string;
  /** 提示通道;缺省经 useAppToast(HeroUI Toast)呈现,测试可注入捕获 */
  onToast?: ToastFn;
}

/**
 * 统一变更封装(变更不自动重试,由 client.ts mutations.retry: 0 保证):
 * - optimistic:onMutate 先 cancelQueries 防在途取数回写 → 快照 → setQueryData;
 *   onError 回滚快照 + 错误提示;onSettled 无条件失效对账(官方模式);
 * - confirmed:无乐观写,onError 直接错误提示;onSettled 同样失效对账;
 * - pending 去重:调用方以结果中的 isPending 门控触发源(FR-014)。
 */
export function useAppMutation<TVars, TData>(
  options: AppMutationOptions<TVars, TData>,
): UseMutationResult<TData, FetchApiError, TVars, OptimisticSnapshot | undefined> {
  // 缺省提示通道:HeroUI Toast(providers.tsx 已挂载 AppToastRegion);测试经 onToast 注入捕获
  const appToast = useAppToast();
  const toast: ToastFn =
    options.onToast ??
    ((message, kind) => {
      if (kind === 'error') {
        appToast.error(message);
      } else {
        appToast.success(message);
      }
    });

  return useMutation<TData, FetchApiError, TVars, OptimisticSnapshot | undefined>({
    // 5.105 的 MutationFunctionContext 暂无 signal,传空上下文(signal 缺省 undefined)
    mutationFn: (vars) => options.mutationFn(vars, {}),
    onMutate: async (vars) => {
      const optimistic = options.feedback === 'optimistic' ? options.optimistic : undefined;
      if (optimistic === undefined) {
        return undefined;
      }
      // 先取消该键在途查询,防止旧响应回写覆盖乐观值(官方模式第一步)
      await queryClient.cancelQueries({ queryKey: optimistic.queryKey });
      const previous = queryClient.getQueryData(optimistic.queryKey);
      queryClient.setQueryData<unknown>(optimistic.queryKey, (old: unknown) => optimistic.apply(old, vars));
      const snapshot: OptimisticSnapshot = {
        queryKey: optimistic.queryKey,
        previous,
        ...(optimistic.snapshotKey !== undefined ? { snapshotKey: optimistic.snapshotKey } : {}),
      };
      if (optimistic.snapshotKey !== undefined) {
        snapshotRegistry.set(optimistic.snapshotKey, snapshot);
      }
      return snapshot;
    },
    onError: (error, _vars, snapshot) => {
      if (snapshot !== undefined) {
        // 乐观失败回滚(research D3:toast 持快照上下文):
        // 写入前有缓存 → 恢复快照;原本无缓存 → 移除条目
        // (setQueryData(key, undefined) 在库实现中为 no-op,会泄漏乐观值)
        if (snapshot.previous === undefined) {
          queryClient.removeQueries({ queryKey: snapshot.queryKey });
        } else {
          queryClient.setQueryData<unknown>(snapshot.queryKey, snapshot.previous);
        }
        if (snapshot.snapshotKey !== undefined) {
          snapshotRegistry.delete(snapshot.snapshotKey);
        }
        toast(options.rollbackToast ?? formatApiError(error), 'error');
        return;
      }
      toast(formatApiError(error), 'error');
    },
    onSuccess: (_data, _vars, snapshot) => {
      // 成功即出清快照注册(乐观值已被 onSettled 失效对账取代)
      if (snapshot?.snapshotKey !== undefined) {
        snapshotRegistry.delete(snapshot.snapshotKey);
      }
      if (options.successToast !== undefined) {
        toast(options.successToast, 'success');
      }
    },
    onSettled: async () => {
      // 无条件对账:无论成败都失效声明的查询集,以服务端真值回填
      await Promise.all(
        (options.invalidate ?? []).map((queryKey) => queryClient.invalidateQueries({ queryKey })),
      );
    },
  });
}

/** 导出 keepPreviousData 引用,页面迁移时统一从此处取用(与库语义一致) */
export { keepPreviousData };
