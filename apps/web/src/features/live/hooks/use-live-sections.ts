import { useEffect, useRef } from 'react';
import { useAppQuery, type AppQueryOptions } from '../../../shared/query/hooks';
import type { FetchApiError } from '../../../shared/fetch';

/**
 * 直播分区资源(T023 迁移:006 统一数据层适配层;FR-004「区分加载中、成功空结果、
 * 请求失败」、FR-022)——原手写 useEffect + AbortController 状态机已迁入
 * shared/query(useAppQuery:signal 透传/取消/缓存/后台刷新/错误原样上抛),本 hook:
 * - 保留 LiveResource 形状(data/status/retry):NowSection/NextSection/GroupSections/
 *   FocusedSection 等分区组件零改动,SectionFrame 继续按 status + hasStaleContent 呈现;
 * - 每个分区独立一条查询(键经 queryKeys.public.live 工厂前缀派生,见 LivePage):
 *   失败仅重试本区(retry=refetch 只作用于本区),不拖垮其他分区;
 * - 刷新失败保留旧数据:react-query 失败不清空 data,界面以 isError + data!==null
 *   区分「后台刷新失败(更新失败,显示的是上次内容)」与「首次加载失败」;
 * - 30 秒周期与回前台立即刷新仍由 useLiveRefresh 的 refreshKey 驱动(FR-022 契约不变):
 *   refreshKey 递增即对本区强制 refetch(refetch 不受 staleTime 门控,等价旧「代次」语义;
 *   首次挂载 refreshKey=0 跳过,挂载取数由 react-query 自身承担);
 * - enabled=false(概览/聚焦互斥)时 retry/refresh 一律不发请求,等价旧 enabled 守卫,
 *   避免 refetch 对禁用查询的强制取数副作用。
 */

export type LiveResourceStatus = 'loading' | 'ready' | 'error';

export interface LiveResource<T> {
  /** 最近一次成功的数据(失败时保留上次成功值;占位翻页时为上一键的占位数据) */
  readonly data: T | null;
  readonly status: LiveResourceStatus;
  /** 是否正在进行首次加载(旧数据存在时为后台刷新,不吞内容) */
  readonly isLoading: boolean;
  readonly error: FetchApiError | null;
  /** 本区重试(只影响本区;禁用分区不触发请求) */
  readonly retry: () => void;
}

export function useLiveSection<T>(
  options: AppQueryOptions<T>,
  refreshKey: number,
  enabled: boolean = true,
): LiveResource<T> {
  const query = useAppQuery<T>({ ...options, enabled });
  const { data, isPending, isError, error, refetch } = query;

  // 周期/回前台刷新:refreshKey 递增(useLiveRefresh 的 30s 定时或 visibilitychange)
  // 时强制重取本区;以 ref 记录已消费的代次,避免 enabled 翻转等无关重渲染误触发。
  const seenRefreshRef = useRef(refreshKey);
  useEffect(() => {
    if (refreshKey === seenRefreshRef.current) {
      return;
    }
    seenRefreshRef.current = refreshKey;
    if (enabled) {
      void refetch();
    }
  }, [refreshKey, enabled, refetch]);

  return {
    data: data ?? null,
    status: isPending ? 'loading' : isError ? 'error' : 'ready',
    isLoading: isPending,
    error,
    retry: (): void => {
      if (enabled) {
        void refetch();
      }
    },
  };
}
