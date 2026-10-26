import { useCallback, useEffect, useRef, useState } from 'react';
import { isAbortError } from '../../../shared/fetch';

/**
 * 直播分区资源(T067/T068;FR-004「区分加载中、成功空结果、请求失败」、FR-022):
 * - 每个分区独立挂载本资源:失败仅重试本区(retry 只递增本区代次),
 *   不拖垮其他分区;全局刷新(useLiveRefresh 的 refreshKey)驱动全部资源重新拉取;
 * - 刷新失败保留旧数据:成功过的 data 不因后续失败清空,错误单独暴露(可重试 Alert);
 * - 代次废止:refreshKey/retry/卸载变更时中止在途请求,迟到响应不得回写
 *   (AbortController + 每代次令牌比对)。
 */

export type LiveResourceStatus = 'loading' | 'ready' | 'error';

export interface LiveResource<T> {
  /** 最近一次成功的数据(失败时保留上次成功值) */
  readonly data: T | null;
  readonly status: LiveResourceStatus;
  /** 是否正在进行首次加载(旧数据存在时为后台刷新,不吞内容) */
  readonly isLoading: boolean;
  readonly error: unknown;
  /** 本区重试(只影响本区) */
  readonly retry: () => void;
}

export function useLiveSection<T>(
  fetcher: (signal: AbortSignal) => Promise<T>,
  refreshKey: number,
  enabled: boolean = true,
  /** 查询输入键(URL 状态等);键变化即重新拉取(详情返回/搜索恢复语义) */
  depsKey: string = '',
): LiveResource<T> {
  const [data, setData] = useState<T | null>(null);
  const [status, setStatus] = useState<LiveResourceStatus>('loading');
  const [error, setError] = useState<unknown>(null);
  const [nonce, setNonce] = useState(0);
  // fetcher 以 ref 持有:调用方内联箭头函数不触发重拉,数据获取只由 refreshKey/nonce 驱动
  const fetcherRef = useRef(fetcher);
  fetcherRef.current = fetcher;

  useEffect(() => {
    if (!enabled) {
      return;
    }
    const controller = new AbortController();
    let active = true;
    setStatus('loading');
    fetcherRef
      .current(controller.signal)
      .then((result) => {
        if (!active) return;
        setData(result);
        setError(null);
        setStatus('ready');
      })
      .catch((cause: unknown) => {
        if (!active || isAbortError(cause)) return;
        // 保留旧数据:错误不清空 data,由界面区分「后台刷新失败」与「首次加载失败」
        setError(cause);
        setStatus('error');
      });
    return () => {
      active = false;
      controller.abort();
    };
  }, [refreshKey, nonce, enabled, depsKey]);

  const retry = useCallback((): void => {
    setNonce((value) => value + 1);
  }, []);

  return { data, status, isLoading: status === 'loading' && data === null, error, retry };
}
