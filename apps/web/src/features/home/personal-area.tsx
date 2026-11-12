import { useState, type ReactNode } from 'react';
import { Link } from 'react-router';
import { Button } from '@heroui/react';
import { LoadingSpinner, RetryableAlert } from '../../shared/ui';
import { useSession } from '../../app/session-provider';
import { formatApiError } from '../../shared/query/error';
import {
  fetchFavoriteChannels,
  type FavoriteChannelItem,
} from '../favorites/favorites-api';
import { useFavoriteChannelsQuery } from '../favorites/use-favorites';
import { fetchHistory, type HistoryItem } from '../history/history-api';
import { useHistoryPageQuery } from '../history/use-history';
import { HistoryCard } from '../history/history-card';
import { ChannelLogo } from '../live/components/channel-logo';
import { VOD_ENABLED } from '../../shared/feature-flags';
import { PlayButton } from '../playback/use-play-action';
import { FavoriteStarButton } from '../favorites/favorite-star-button';

/**
 * 首页个人区(T105/T024,005 US4、006 data-access.md、ui.md §4、FR-016/019/045):
 *
 * - 顺序固定:收藏频道 → 点播观看历史(公共区其后);仅已选档渲染,游客/未选档
 *   不发任何 /me 请求、不用空白个人区占首屏(查询 enabled 由身份门控);
 * - 数据接入(T024):收藏/历史列表统一经 useAppQuery(profile 域,SWR 30s,
 *   queryKeys.profile(pid).… 键内嵌当前 profileId)——切档即换键重取,旧键条目
 *   由身份清除(US3 域清除)兜底,迟到响应只回写旧键缓存、不回写新身份页面;
 * - 各分区独立 加载/空/失败/重试 三态(LoadingSpinner/RetryableAlert,shared/ui),
 *   失败只重试本区,不阻塞公共区;错误文案经 formatApiError 统一映射链;
 * - 「查看更多」为键集游标追加(服务端契约不变):基础页真值来自查询缓存,
 *   追加页挂在组件层,身份切换随分区重挂载(key=profileId)整体复位;
 * - 收藏取消为数据层乐观变更(favorite-star-button → useAppMutation optimistic):
 *   点击即从共享 favorites 缓存移除,失败回滚 + Toast,本组件不再持有删除状态机;
 * - 失效收藏/历史媒体:显示不可用、可取消收藏、无可运行播放按钮,不当作正在直播
 *   节目(FR-020);
 * - 收藏频道卡小 Logo(014 T027/T028,ui.md §2 接入点 4/5、spec US3-3):posterRef
 *   取自 FavoriteChannelItem.media.posterRef(/me/favorites/channels PublicMedia
 *   摘要投影,数据面零服务端改动);有 Logo → 标题行前渲染固定尺寸身份盒(size-6,
 *   ChannelLogo 装饰层绝对定位不参与行盒,与 ChannelTile 同回退链——加载中/失败
 *   由组件内首字回退层兜底);无 Logo → 不渲染身份盒,维持现状纯文字呈现(FR-008)。
 *   本组件收藏频道列表(aria-label="收藏频道列表")即全仓 grep 的收藏频道列表
 *   唯一渲染面(无独立 /favorites 路由页),ui.md §2 接入点 4/5 在此一并落地。
 */

/** 首屏与「查看更多」每页条数(契约 limit 缺省 20) */
const PAGE_SIZE = 20;

/** 键集分页页形(收藏页/历史页同构子集;服务端契约不变) */
interface CursorPage<TItem> {
  readonly items: readonly TItem[];
  readonly nextCursor: string | null;
}

/**
 * 游标追加页挂钩:基础页来自查询缓存(SWR 真值),追加页挂在组件层(仅增不改,
 * 身份切换经分区 key 重挂载复位)。返回合并视图与追加控制器(幂等:追加中再点忽略)。
 */
function useCursorAppend<TItem>(
  fetchPage: (cursor: string) => Promise<CursorPage<TItem>>,
  basePage: CursorPage<TItem> | undefined,
): {
  readonly items: readonly TItem[];
  readonly nextCursor: string | null;
  readonly appending: boolean;
  readonly loadMore: () => void;
} {
  const [appendedPages, setAppendedPages] = useState<readonly CursorPage<TItem>[]>([]);
  const [appending, setAppending] = useState(false);

  const lastAppended = appendedPages[appendedPages.length - 1];
  const nextCursor = lastAppended?.nextCursor ?? basePage?.nextCursor ?? null;
  const items: readonly TItem[] = [
    ...(basePage?.items ?? []),
    ...appendedPages.flatMap((page) => page.items),
  ];

  const loadMore = (): void => {
    if (appending || nextCursor === null) {
      return;
    }
    const cursor = nextCursor;
    setAppending(true);
    // 追加失败维持原状并解除挂起(列表照常可用,可再次点击重试)
    fetchPage(cursor)
      .then((page) => {
        setAppendedPages((previous) => [...previous, page]);
      })
      .catch(() => undefined)
      .finally(() => {
        setAppending(false);
      });
  };

  return { items, nextCursor, appending, loadMore };
}

/** 收藏频道分区(三态来自 useAppQuery;星标乐观更新由数据层收口) */
function FavoritesSection({ profileId }: { readonly profileId: string }): ReactNode {
  const favoritesQuery = useFavoriteChannelsQuery(profileId, { limit: PAGE_SIZE });
  const { items, nextCursor, appending, loadMore } = useCursorAppend<FavoriteChannelItem>(
    (cursor) => fetchFavoriteChannels({ cursor, limit: PAGE_SIZE }),
    favoritesQuery.data,
  );

  return (
    <section aria-label="收藏频道" data-testid="home-favorites" className="flex flex-col gap-3">
      <div className="flex items-baseline justify-between">
        <h2 className="text-lg font-semibold text-foreground">收藏频道</h2>
        <Link to="/live" className="text-sm text-accent underline-offset-4 hover:underline">
          去直播页发现更多
        </Link>
      </div>
      {favoritesQuery.isPending ? <LoadingSpinner label="加载收藏频道…" /> : null}
      {favoritesQuery.isError ? (
        <RetryableAlert
          title="收藏频道加载失败"
          description={formatApiError(favoritesQuery.error)}
          onRetry={() => void favoritesQuery.refetch()}
        />
      ) : null}
      {favoritesQuery.isSuccess && items.length === 0 ? (
        <p className="rounded-lg border border-border bg-surface px-4 py-3 text-sm text-muted">
          还没有收藏频道,去直播页挑选喜欢的频道并点击星标收藏。
        </p>
      ) : null}
      {favoritesQuery.isSuccess && items.length > 0 ? (
        <>
          <ul className="grid list-none gap-3 sm:grid-cols-2 lg:grid-cols-4" aria-label="收藏频道列表">
            {items.map((item) => {
              const unavailable = item.media.availability !== 'available';
              return (
                <li key={item.media.id}>
                  <article
                    data-testid="favorite-card"
                    aria-label={`收藏频道:${item.media.title}`}
                    className="flex h-full flex-col gap-2 rounded-lg border border-border bg-surface p-3"
                  >
                    <div className="flex items-start justify-between gap-2">
                      <h3 className="min-w-0 text-sm font-medium text-foreground">
                        <Link
                          to={`/media/${encodeURIComponent(item.media.id)}`}
                          state={{ favorited: true }}
                          className="flex min-w-0 items-center gap-2 rounded focus:outline-none focus-visible:ring-2 focus-visible:ring-focus"
                        >
                          {/* 收藏频道小 Logo(014 T027/T028):固定尺寸身份盒 + 绝对定位
                              装饰层,不参与行盒(有则显示小图);aria-hidden 装饰节点,
                              可读名仍由标题文字承担 */}
                          {item.media.posterRef !== null ? (
                            <span
                              aria-hidden="true"
                              className="relative inline-flex size-6 shrink-0 overflow-hidden rounded-sm"
                            >
                              <ChannelLogo
                                key={item.media.posterRef}
                                posterRef={item.media.posterRef}
                                channelTitle={item.media.title}
                                fallbackClassName="text-xs font-black leading-none text-foreground/10"
                              />
                            </span>
                          ) : null}
                          <span className="min-w-0 truncate">
                            {item.media.title}
                            {unavailable ? <span className="ms-2 text-xs font-normal text-muted">(不可用)</span> : null}
                          </span>
                        </Link>
                      </h3>
                      {/* 取消收藏:optimistic.apply 立即移除共享缓存条目,失败回滚 + Toast */}
                      <FavoriteStarButton
                        mediaId={item.media.id}
                        title={item.media.title}
                        favorited={true}
                        unavailable={unavailable}
                        size="sm"
                      />
                    </div>
                    <p className="text-xs text-muted">
                      {item.current !== null
                        ? `正在播:${item.current.title}(${item.current.startsAt.slice(11, 16)}-${item.current.endsAt.slice(11, 16)})`
                        : '暂无节目'}
                    </p>
                    {item.next !== null ? (
                      <p className="text-xs text-muted">
                        下一档:{item.next.title}({item.next.startsAt.slice(11, 16)} 开始)
                      </p>
                    ) : null}
                    {unavailable ? (
                      <p className="text-xs text-muted">该频道当前不可用,无法播放,可取消收藏。</p>
                    ) : (
                      <PlayButton
                        mediaId={item.media.id}
                        title={item.media.title}
                        label="观看直播"
                        size="sm"
                        variant="secondary"
                        ariaLabel={`观看直播 ${item.media.title}`}
                      />
                    )}
                  </article>
                </li>
              );
            })}
          </ul>
          {nextCursor !== null ? (
            <Button variant="ghost" size="sm" onPress={loadMore} isDisabled={appending} className="self-start">
              {appending ? '加载中…' : '查看更多收藏'}
            </Button>
          ) : null}
        </>
      ) : null}
    </section>
  );
}

/** 点播观看历史分区(三态来自 useAppQuery;历史卡进入详情,不自动播放) */
function HistorySection({ profileId }: { readonly profileId: string }): ReactNode {
  const historyQuery = useHistoryPageQuery(profileId, { limit: PAGE_SIZE });
  const { items, nextCursor, appending, loadMore } = useCursorAppend<HistoryItem>(
    (cursor) => fetchHistory({ cursor, limit: PAGE_SIZE }),
    historyQuery.data,
  );

  return (
    <section aria-label="点播观看历史" data-testid="home-history" className="flex flex-col gap-3">
      <div className="flex items-baseline justify-between">
        <h2 className="text-lg font-semibold text-foreground">点播观看历史</h2>
        <Link to="/vod" className="text-sm text-accent underline-offset-4 hover:underline">
          浏览点播目录
        </Link>
      </div>
      {historyQuery.isPending ? <LoadingSpinner label="加载观看历史…" /> : null}
      {historyQuery.isError ? (
        <RetryableAlert
          title="观看历史加载失败"
          description={formatApiError(historyQuery.error)}
          onRetry={() => void historyQuery.refetch()}
        />
      ) : null}
      {historyQuery.isSuccess && items.length === 0 ? (
        <p className="rounded-lg border border-border bg-surface px-4 py-3 text-sm text-muted">
          还没有点播观看记录;真正开始播放后,这里会显示最近观看的内容供你继续观看。
        </p>
      ) : null}
      {historyQuery.isSuccess && items.length > 0 ? (
        <>
          <ul className="grid list-none gap-3 sm:grid-cols-2 lg:grid-cols-4" aria-label="观看历史列表">
            {items.map((item) => (
              <li key={item.media.id}>
                <HistoryCard item={item} />
              </li>
            ))}
          </ul>
          {nextCursor !== null ? (
            <Button variant="ghost" size="sm" onPress={loadMore} isDisabled={appending} className="self-start">
              {appending ? '加载中…' : '查看更多历史'}
            </Button>
          ) : null}
        </>
      ) : null}
    </section>
  );
}

/**
 * 个人区装配:仅已选档渲染(游客/未选档不发个人请求,FR-016);
 * 分区以 profileId 为 key——切档/重选即整体重挂载,查询随新键重取,
 * 游标追加页同步复位(FR-019 场景 4:旧身份在途响应只回写旧键缓存,
 * 不回写新身份页面;域级清除由 US3 按键首段执行)。
 */
export function HomePersonalArea(): ReactNode {
  const session = useSession();
  const activeProfile = session.status === 'authenticated' ? (session.session?.activeProfile ?? null) : null;
  if (session.status !== 'authenticated' || activeProfile === null) {
    return null; // 游客/未选档:不发个人请求,不占首屏
  }
  return (
    <div data-testid="home-personal-area" className="flex flex-col gap-8">
      <FavoritesSection key={activeProfile.id} profileId={activeProfile.id} />
      {/* v1 只做直播:点播观看历史分区隐藏(实现保留于同文件 HistorySection,
          翻 feature-flags.ts 开关即恢复;此时也不发历史请求) */}
      {VOD_ENABLED ? (
        <HistorySection key={`history-${activeProfile.id}`} profileId={activeProfile.id} />
      ) : null}
    </div>
  );
}
