import { useAppMutation, useAppQuery } from '../../shared/query/hooks';
import { queryKeys } from '../../shared/query/keys';
import {
  deleteFavoriteChannel,
  fetchFavoriteChannels,
  putFavoriteChannel,
  type FavoriteChannelItem,
  type FavoriteChannelPage,
} from './favorites-api';

/**
 * 收藏数据访问 hooks(T024;006 contracts/data-access.md + query-keys.md):
 *
 * - 列表:useAppQuery(profile 域,浏览型 SWR 30s,键 = queryKeys.profile(pid).favorites(),
 *   键内嵌当前 profileId,身份未知时不启用——FR-016/021);
 * - 收藏/取消:useAppMutation(feedback 'optimistic')——乐观改写共享 favorites 键缓存
 *   (列表页与详情页星标同源),失败自动回滚 + formatApiError 提示,onSettled
 *   无条件失效以服务端真值对账;变更不重试(client mutations retry: 0);
 * - 传输:一律经 favorites-api(privateFetch,same-origin Cookie,signal 透传);
 * - 身份只由服务端从当前 Profile 推导,客户端不传任何 profileId/householdId。
 */

/** 乐观改写的目标提示(用于凭空补插最小收藏条目;服务端真值由对账回填) */
export interface FavoriteToggleHint {
  readonly title: string;
  /** 不可用频道可取消收藏、不可重新收藏(FR-020);乐观补插按此标注可用性 */
  readonly unavailable: boolean;
}

/**
 * 收藏/取消收藏的乐观缓存改写(pure;供 optimistic.apply 与单测复用):
 * - 取消收藏:按 mediaId 移除条目(幂等:不存在亦为原样);
 * - 收藏:既有缓存列表头部补插最小条目(type 恒 'channel':/me/favorites/channels
 *   仅收录频道;createdAt 为乐观占位,onSettled 对账后以服务端真值回填);
 * - 无缓存(previous 为 undefined/null)不凭空造列表——返回 undefined,
 *   回滚语义由 shared/query/hooks.ts 快照(移除条目)兜底。
 */
export function applyFavoriteToggle(
  previous: unknown,
  mediaId: string,
  next: boolean,
  hint: FavoriteToggleHint,
): FavoriteChannelPage | undefined {
  if (previous === undefined || previous === null) {
    return undefined;
  }
  const page = previous as FavoriteChannelPage;
  if (!next) {
    return {
      nextCursor: page.nextCursor,
      items: page.items.filter((item) => item.media.id !== mediaId),
    };
  }
  if (page.items.some((item) => item.media.id === mediaId)) {
    return page; // 已在列表:幂等,不改写
  }
  const optimisticItem: FavoriteChannelItem = {
    media: {
      id: mediaId,
      type: 'channel',
      title: hint.title,
      description: null,
      posterRef: null,
      contentLevel: null,
      availability: hint.unavailable ? 'unavailable' : 'available',
    },
    createdAt: new Date().toISOString(),
    current: null,
    next: null,
  };
  return { nextCursor: page.nextCursor, items: [optimisticItem, ...page.items] };
}

/**
 * 收藏频道列表查询(profile 域,SWR 30s):
 * - 键携带当前 profileId(身份未知传入 null → enabled 关闭,不发 /me 请求);
 * - signal 透传至 privateFetch(键变化/卸载自动取消,FR-015)。
 */
export function useFavoriteChannelsQuery(
  profileId: string | null,
  options: { readonly limit: number },
): ReturnType<typeof useAppQuery<FavoriteChannelPage>> {
  return useAppQuery<FavoriteChannelPage>({
    domain: 'profile',
    queryKey: queryKeys.profile(profileId ?? '').favorites(),
    queryFn: ({ signal }) => fetchFavoriteChannels({ limit: options.limit, signal }),
    enabled: Boolean(profileId),
  });
}

/**
 * 已收藏频道 id 集合(频道列表标记用):已选档时取一次收藏列表(与其他收藏视图
 * 共享同一 query key,变更后自动对账);未选档/游客为空集合、零请求。
 */
export function useFavoriteChannelIds(profileId: string | null): ReadonlySet<string> {
  const query = useAppQuery<FavoriteChannelPage>({
    domain: 'profile',
    queryKey: queryKeys.profile(profileId ?? '').favorites(),
    queryFn: ({ signal }) => fetchFavoriteChannels({ limit: 50, signal }),
    enabled: profileId !== null,
  });
  return new Set((query.data?.items ?? []).map((item) => item.media.id));
}

/**
 * 单个媒体的收藏态(详情面板用):仅在 `enabled` 为真(面板打开)且已选档时取数,
 * 避免浏览页平白增加 /me 请求;与收藏列表共享同一 query key,变更后自动对账。
 */
export function useFavoriteState(
  profileId: string | null,
  mediaId: string | null,
  enabled: boolean,
): boolean {
  const query = useAppQuery<FavoriteChannelPage>({
    domain: 'profile',
    queryKey: queryKeys.profile(profileId ?? '').favorites(),
    queryFn: ({ signal }) => fetchFavoriteChannels({ limit: 50, signal }),
    enabled: enabled && profileId !== null && mediaId !== null,
  });
  if (mediaId === null) {
    return false;
  }
  return (query.data?.items ?? []).some((item) => item.media.id === mediaId);
}

/**
 * 收藏/取消收藏变更(optimistic 档,Q1):
 * - onMutate:取消在途列表查询 → 快照 → optimistic.apply 改写 favorites 键;
 * - onError:自动回滚快照 + formatApiError toast(网络失败落通用兜底文案);
 * - onSettled:无条件失效 favorites 键,以服务端真值对账(重复触发安全:
 *   PUT/DELETE 幂等 + isPending 门控去重由调用方承担);
 * - 身份未知(profileId 为 null)时无乐观写与失效目标,退化为 confirmed 行为
 *   (调用方在未选档时不触达本变更,见 favorite-star-button 的意图协调门控)。
 */
export function useFavoriteToggleMutation(
  profileId: string | null,
  media: { readonly id: string } & FavoriteToggleHint,
): ReturnType<typeof useAppMutation<boolean, void>> {
  const favoritesKey = profileId !== null ? queryKeys.profile(profileId).favorites() : null;
  return useAppMutation<boolean, void>({
    domain: 'profile',
    feedback: 'optimistic',
    mutationFn: (next) =>
      next ? putFavoriteChannel(media.id) : deleteFavoriteChannel(media.id),
    ...(favoritesKey !== null
      ? {
          optimistic: {
            queryKey: favoritesKey,
            apply: (old: unknown, next: boolean) => applyFavoriteToggle(old, media.id, next, media),
          },
          invalidate: [favoritesKey],
        }
      : {}),
  });
}
