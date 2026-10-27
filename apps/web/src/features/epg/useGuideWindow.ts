import { useEffect, useRef } from 'react';
import type { GuideWindowDto } from '@hmp/shared';
import { isFetchApiError, publicFetch } from '../../shared/fetch';
import { EPG_QUERY_STALE_TIME_MS, keepPreviousData, useAppQuery } from '../../shared/query/hooks';
import { queryKeys, type GuideQuery } from '../../shared/query/keys';

/**
 * EPG 公共数据层(T023 迁移至统一数据层;005 contracts/api.md §2、006 data-access.md):
 * - 取数统一经 useAppQuery(public 域):键取自 queryKeys.public.guide 工厂(禁止
 *   手写键),staleTime = EPG_QUERY_STALE_TIME_MS(EPG 慢变 60s 新鲜窗口);
 * - 请求底座仍为 shared/fetch 的 publicFetch(credentials:'omit')——公共请求不携带
 *   (失效)cookie,服务端投影与身份无关;signal 由数据层透传(键变化/卸载自动
 *   中止,迟到响应不回写,409 回今天的旧窗口响应同样被丢弃);
 * - date 缺省 = 家庭今天;from/to 缺省 = 服务端「该日完整 24 小时」默认窗口
 *   (A-008 全天展示;真实日界由服务端承担,前端不自行推断默认窗口);
 * - placeholderData = keepPreviousData:切日期/频道页/页大小时旧窗口保持可见,
 *   新窗口到达后无缝替换(与原手写状态机的翻页不断流 UX 一致);
 * - 失败保留旧数据:库对新键失败会把 data 置空(placeholderData 仅在 pending 态
 *   生效),此处以 ref 记最近一次成功窗口失败时续显(与原「失败保留旧数据由界面
 *   区分;409/422 时旧数据仍可用」语义一致);
 * - 错误语义:409 GUIDE_DATE_EXPIRED → dateExpired(UI 回今天并提示);
 *   422 GUIDE_WINDOW_TOO_LARGE → windowTooLarge(UI 提示减少每页频道数、保留频道页)。
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

/**
 * guide 键参数:键工厂 GuideQuery 形状 + 本页窗口分页(page/pageSize)与日内子
 * 窗口(from/to 毫秒)字段。键末位参数对象可序列化、同参同键、异参异键
 * (query-keys.md 契约规则 3;undefined 字段经库内 hash 等价于缺省,键稳定)。
 * shared/** 不在本任务文件清单内,GuideQuery 工厂形状扩展先以结构兼容类型补齐,
 * 后续扩键工厂时收敛回 keys.ts。
 */
export type GuideKeyQuery = GuideQuery & {
  readonly fromMs?: number;
  readonly toMs?: number;
  readonly page: number;
  readonly pageSize: number;
};

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

/**
 * GuideWindow 资源 hook:输入键变化即按需取数(SWR 60s);失败保留旧数据并按
 * 稳定码标注 dateExpired/windowTooLarge(成功后清除)。三态由 useAppQuery 结果
 * 派生,不再自维护 loading/error 状态机。
 */
export function useGuideWindow(query: GuideWindowQuery): GuideResource {
  const keyQuery: GuideKeyQuery = {
    date: query.date,
    fromMs: query.fromMs,
    toMs: query.toMs,
    page: query.page,
    pageSize: query.pageSize,
  };
  const result = useAppQuery<GuideWindowDto>({
    domain: 'public',
    queryKey: queryKeys.public.guide(keyQuery),
    queryFn: ({ signal }) => fetchGuideWindow(query, signal),
    staleTime: EPG_QUERY_STALE_TIME_MS,
    placeholderData: keepPreviousData,
  });

  // 失败保留旧数据:新键失败时 result.data 为 undefined(placeholderData 仅在
  // pending 态生效),回退展示最近一次成功窗口;成功/占位期把窗口记入 ref。
  const lastDataRef = useRef<GuideWindowDto | null>(null);
  useEffect(() => {
    if (result.data !== undefined) {
      lastDataRef.current = result.data;
    }
  }, [result.data]);
  const data = result.data ?? lastDataRef.current;

  const isError = result.isError && isFetchApiError(result.error);
  const expiredAllowedDates =
    isError && Array.isArray(result.error.problem?.['allowedDates'])
      ? (result.error.problem?.['allowedDates'] as readonly string[])
      : null;

  const status: GuideResourceStatus = result.isError
    ? 'error'
    : result.isPending && data === null
      ? 'loading'
      : 'ready';

  return {
    data,
    status,
    isLoading: status === 'loading' && data === null,
    error: result.error,
    dateExpired: isError && result.error.code === 'GUIDE_DATE_EXPIRED',
    windowTooLarge: isError && result.error.code === 'GUIDE_WINDOW_TOO_LARGE',
    expiredAllowedDates,
    retry: () => {
      void result.refetch();
    },
  };
}
