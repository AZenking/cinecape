import { useAppQuery } from '../../../shared/query/hooks';
import { queryKeys } from '../../../shared/query/keys';
import type { ChannelPageDto, ChannelRowDto } from '@hmp/shared';
import { fetchLiveChannels, type LiveChannelQuery } from '../live-api';
import type { LiveResource } from './use-live-sections';

/**
 * 同类型直播推荐查询(T003;015 contracts/api-reuse.md「同类直播推荐 (Screen 4)」行、
 * data-model.md §2.3 LiveWatchViewModel.sameTypeLiveChannels):
 * - 零新增端点:复用既有公共列表 GET /api/public/live/channels,请求形态
 *   `section=group` + `groupKey=:targetGroup`,经 live-api.ts 的
 *   fetchLiveChannels(publicFetch,credentials:'omit')取数——不新造请求通道;
 * - 「排除当前频道」为前端过滤:精确比较 `row.media.id !== activeChannelId`,
 *   过滤保持服务端返回顺序(不重排、不截断);activeChannelId 换台仅影响本地过滤,
 *   不改变缓存键(同分组多个频道共享同一份服务端数据,不重发请求);
 * - 公共查询 30 秒缓存 + 静默后台更新:走 useAppQuery public 域缺省
 *   (staleTime 30s + refetchOnWindowFocus,见 shared/query/client.ts 契约表),
 *   窗口聚焦仅对过期条目后台重取,已呈现内容不被加载态吞掉;
 * - groupKey 缺省(当前频道无分组归属/尚在解析)不发请求:enabled=false,
 *   返回空数组 ready 态,retry 同样零请求(等价禁用分区守卫);
 * - 返回沿用 LiveResource 形状(hooks/use-live-sections),消费体验与分区资源一致:
 *   失败时 data 保留上次成功值(status='error' 且 data!==null = 后台刷新失败)。
 *   不用 keepPreviousData:换台跨分组时旧分组推荐不应残留在新分组语境下。
 */

/** 推荐位取数条数:服务端 live channels pageSize 上限 50(live.controller.ts max50),整组一次取齐供前端过滤 */
export const RELATED_LIVE_CHANNELS_PAGE_SIZE = 50;

export interface RelatedLiveChannelsOptions {
  /** 当前频道所属分组 groupKey;undefined = 无分组归属(不发请求,空数组 ready) */
  readonly groupKey: string | undefined;
  /** 当前播放频道 media id(精确排除其自身;null = 无需排除) */
  readonly activeChannelId: string | null;
}

/** groupKey 缺省态的空推荐结果(常量数组,避免每次渲染产生新引用) */
const EMPTY_CHANNELS: readonly ChannelRowDto[] = [];

/** 禁用态 retry:不发请求(与 useLiveSection 的 enabled 守卫语义一致) */
function noopRetry(): void {
  /* groupKey 缺省即无资源可重试 */
}

/**
 * 同类型(同分组)正在直播频道列表:服务端返回当前分组的直播频道行,
 * 前端排除 activeChannelId 后交由 Screen 4 底部同类频道条渲染。
 */
export function useRelatedLiveChannels(
  options: RelatedLiveChannelsOptions,
): LiveResource<readonly ChannelRowDto[]> {
  const { groupKey, activeChannelId } = options;
  const enabled = groupKey !== undefined;

  // 请求形态即缓存键(015 api-reuse.md Screen 4 行):section=group + groupKey,
  // 首页整组取齐;键经 queryKeys.public.liveChannels 工厂,禁止手写字符串键。
  const request: LiveChannelQuery = {
    section: 'group',
    groupKey,
    page: 1,
    pageSize: RELATED_LIVE_CHANNELS_PAGE_SIZE,
  };

  const query = useAppQuery<ChannelPageDto>({
    domain: 'public',
    queryKey: queryKeys.public.liveChannels(request),
    queryFn: ({ signal }) => fetchLiveChannels(request, signal),
    enabled,
  });

  if (!enabled || groupKey === undefined) {
    return {
      data: EMPTY_CHANNELS,
      status: 'ready',
      isLoading: false,
      error: null,
      retry: noopRetry,
    };
  }

  const { data, isPending, isError, error, refetch } = query;
  // 前端过滤排除当前频道(精确比较 media id);filter 保持服务端顺序。
  // activeChannelId 变更只影响本过滤,不进入缓存键,不触发重新取数。
  const channels =
    data === undefined
      ? null
      : data.items.filter((row) => row.media.id !== activeChannelId);

  return {
    data: channels,
    status: isPending ? 'loading' : isError ? 'error' : 'ready',
    isLoading: isPending,
    error,
    retry: (): void => {
      void refetch();
    },
  };
}
