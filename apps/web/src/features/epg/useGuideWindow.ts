import { useCallback, useEffect, useRef, useState } from 'react';
import type { GuideWindowDto } from '@hmp/shared';
import { FetchApiError, isAbortError, publicFetch } from '../../shared/fetch';

/**
 * EPG 公共数据层(T116;005 ui.md §6、contracts/api.md §2):
 * - 全部经 shared/fetch 的 publicFetch(credentials:'omit')——公共请求不携带
 *   (失效)cookie,服务端投影与身份无关;
 * - date 缺省 = 家庭今天;from/to 缺省 = 服务端「现在前 30 分钟起 6 小时」默认窗口
 *   (A-008;裁剪日界由服务端承担,前端不自行推断默认窗口);
 * - AbortController 代次废止:输入变化/卸载时中止在途请求,迟到响应不得回写
 *   (409 回今天的旧窗口响应同样被丢弃);
 * - 错误语义:409 GUIDE_DATE_EXPIRED → dateExpired(UI 回今天并提示);
 *   422 GUIDE_WINDOW_TOO_LARGE → windowTooLarge(UI 提示缩短窗口、保留频道页)。
 */

/** GET /public/guide 查询输入(URL 状态直传;缺省字段不发送) */
export interface GuideWindowQuery {
  readonly date?: string;
  readonly fromMs?: number;
  readonly toMs?: number;
  readonly page: number;
  readonly pageSize: number;
}

function toIso(ms: number): string {
  return new Date(ms).toISOString();
}

/** GET /public/guide:GuideWindow + 同步快照(credentials omit) */
export function fetchGuideWindow(query: GuideWindowQuery, signal?: AbortSignal): Promise<GuideWindowDto> {
  return publicFetch<GuideWindowDto>('/public/guide', {
    signal,
    query: {
      page: query.page,
      pageSize: query.pageSize,
      date: query.date,
      from: query.fromMs === undefined ? undefined : toIso(query.fromMs),
      to: query.toMs === undefined ? undefined : toIso(query.toMs),
    },
  });
}

export type GuideResourceStatus = 'loading' | 'ready' | 'error';

export interface GuideResource {
  /** 最近一次成功窗口(失败保留旧数据由界面区分;409/422 时旧数据仍可用) */
  readonly data: GuideWindowDto | null;
  readonly status: GuideResourceStatus;
  readonly isLoading: boolean;
  readonly error: unknown;
  /** 最近一次失败是否为 409 GUIDE_DATE_EXPIRED */
  readonly dateExpired: boolean;
  /** 最近一次失败是否为 422 GUIDE_WINDOW_TOO_LARGE */
  readonly windowTooLarge: boolean;
  /** 409 响应携带的新可选范围(problem.allowedDates;缺省无) */
  readonly expiredAllowedDates: readonly string[] | null;
  /** 手动重试 */
  readonly retry: () => void;
}

function stableKey(query: GuideWindowQuery): string {
  return `${query.date ?? ''}|${query.fromMs ?? ''}|${query.toMs ?? ''}|${query.page}|${query.pageSize}`;
}

/**
 * GuideWindow 资源 hook:输入键变化即重新拉取;失败保留旧数据并按稳定码标注
 * dateExpired/windowTooLarge(成功后清除)。
 */
export function useGuideWindow(query: GuideWindowQuery, refreshKey: number = 0): GuideResource {
  const [data, setData] = useState<GuideWindowDto | null>(null);
  const [status, setStatus] = useState<GuideResourceStatus>('loading');
  const [error, setError] = useState<unknown>(null);
  const [dateExpired, setDateExpired] = useState(false);
  const [windowTooLarge, setWindowTooLarge] = useState(false);
  const [expiredAllowedDates, setExpiredAllowedDates] = useState<readonly string[] | null>(null);
  const [nonce, setNonce] = useState(0);
  const key = stableKey(query);
  const keyRef = useRef(key);
  keyRef.current = key;
  // fetcher 输入以 ref 持有:内联对象不触发重拉,拉取仅由 key/refreshKey/nonce 驱动
  const queryRef = useRef(query);
  queryRef.current = query;

  useEffect(() => {
    const controller = new AbortController();
    let active = true;
    setStatus('loading');
    fetchGuideWindow(queryRef.current, controller.signal)
      .then((result) => {
        if (!active) return;
        setData(result);
        setError(null);
        setDateExpired(false);
        setWindowTooLarge(false);
        setExpiredAllowedDates(null);
        setStatus('ready');
      })
      .catch((cause: unknown) => {
        if (!active || isAbortError(cause)) return;
        setError(cause);
        if (cause instanceof FetchApiError) {
          setDateExpired(cause.code === 'GUIDE_DATE_EXPIRED');
          setWindowTooLarge(cause.code === 'GUIDE_WINDOW_TOO_LARGE');
          const allowed = cause.problem?.['allowedDates'];
          setExpiredAllowedDates(Array.isArray(allowed) ? (allowed as string[]) : null);
        } else {
          setDateExpired(false);
          setWindowTooLarge(false);
          setExpiredAllowedDates(null);
        }
        setStatus('error');
      });
    return () => {
      active = false;
      controller.abort();
    };
  }, [key, refreshKey, nonce]);

  const retry = useCallback((): void => {
    setNonce((value) => value + 1);
  }, []);

  return { data, status, isLoading: status === 'loading' && data === null, error, dateExpired, windowTooLarge, expiredAllowedDates, retry };
}
