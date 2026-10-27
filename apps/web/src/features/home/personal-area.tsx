import { useEffect, useState, type ReactNode } from 'react';
import { Link } from 'react-router';
import { Button } from '@heroui/react';
import { isAbortError } from '../../shared/fetch';
import { LoadingSpinner, RetryableAlert } from '../../shared/ui';
import { useSession } from '../../app/session-provider';
import {
  deleteFavoriteChannel,
  fetchFavoriteChannels,
  type FavoriteChannelItem,
} from '../favorites/favorites-api';
import { fetchHistory, type HistoryItem } from '../history/history-api';
import { HistoryCard } from '../history/history-card';
import { PlayButton } from '../playback/use-play-action';
import { FavoriteStarButton } from '../favorites/favorite-star-button';

/**
 * 首页个人区(T105,005 US4、ui.md §4、FR-016/019/045):
 *
 * - 顺序固定:收藏频道 → 点播观看历史(公共区其后);仅已选档渲染,游客/未选档
 *   不发任何 /me 请求、不用空白个人区占首屏;
 * - 各分区独立 加载/空/失败/重试 状态,失败只重试本区,不阻塞公共区;
 * - 首屏各 20 项,「查看更多」在本区分页展开(键集游标),不新增身份不明的公共路由;
 * - 个人缓存键含 Household/Profile/contextVersion(经 useSession.personalCacheKey):
 *   切档/退出即递增身份键,旧在途请求 abort 丢弃 —— 迟到响应不回写新身份页面
 *   (FR-019 场景 4);公共浏览条件(搜索/筛选/分页)跨换档保留(FR-045);
 * - 失效收藏/历史媒体:显示不可用、可取消收藏、无可运行播放按钮,不当作正在直播
 *   节目(FR-020)。
 */

/** 首屏与「查看更多」每页条数(契约 limit 缺省 20) */
const PAGE_SIZE = 20;

type SectionState<T> =
  | { readonly kind: 'loading' }
  | { readonly kind: 'empty' }
  | { readonly kind: 'ready'; readonly items: readonly T[]; readonly nextCursor: string | null; readonly appending: boolean }
  | { readonly kind: 'error'; readonly message: string };

function errorMessageOf(error: unknown): string {
  return error instanceof Error && error.message ? error.message : '加载失败,请稍后重试';
}

/** 收藏频道分区(独立状态;星标取消收藏乐观更新) */
function FavoritesSection({ cacheKey }: { readonly cacheKey: string }): ReactNode {
  const [state, setState] = useState<SectionState<FavoriteChannelItem>>({ kind: 'loading' });
  const [reloadToken, setReloadToken] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    const capturedKey = cacheKey;
    setState({ kind: 'loading' });
    fetchFavoriteChannels({ limit: PAGE_SIZE, signal: controller.signal })
      .then((page) => {
        if (controller.signal.aborted || capturedKey !== cacheKey) {
          return; // 迟到响应:身份已变化,不回写
        }
        setState(
          page.items.length === 0
            ? { kind: 'empty' }
            : { kind: 'ready', items: page.items, nextCursor: page.nextCursor, appending: false },
        );
      })
      .catch((error: unknown) => {
        if (isAbortError(error)) {
          return;
        }
        if (capturedKey !== cacheKey) {
          return;
        }
        setState({ kind: 'error', message: errorMessageOf(error) });
      });
    return () => controller.abort();
  }, [cacheKey, reloadToken]);

  const loadMore = (): void => {
    if (state.kind !== 'ready' || state.nextCursor === null || state.appending) {
      return;
    }
    const cursor = state.nextCursor;
    setState({ ...state, appending: true });
    fetchFavoriteChannels({ cursor, limit: PAGE_SIZE })
      .then((page) => {
        setState((previous) =>
          previous.kind === 'ready'
            ? { ...previous, items: [...previous.items, ...page.items], nextCursor: page.nextCursor, appending: false }
            : previous,
        );
      })
      .catch(() => {
        setState((previous) => (previous.kind === 'ready' ? { ...previous, appending: false } : previous));
      });
  };

  const unfavorite = (mediaId: string): void => {
    // 乐观移除由星标组件回调收口:分区直接按契约幂等删除并从列表移除
    void deleteFavoriteChannel(mediaId)
      .then(() => {
        setState((previous) => {
          if (previous.kind !== 'ready') {
            return previous;
          }
          const items = previous.items.filter((item) => item.media.id !== mediaId);
          return items.length === 0 ? { kind: 'empty' } : { ...previous, items };
        });
      })
      .catch(() => {
        // 失败保留原状(星标组件已提示可重试)
      });
  };

  return (
    <section aria-label="收藏频道" data-testid="home-favorites" className="flex flex-col gap-3">
      <div className="flex items-baseline justify-between">
        <h2 className="text-lg font-semibold text-foreground">收藏频道</h2>
        <Link to="/live" className="text-sm text-accent underline-offset-4 hover:underline">
          去直播页发现更多
        </Link>
      </div>
      {state.kind === 'loading' ? <LoadingSpinner label="加载收藏频道…" /> : null}
      {state.kind === 'empty' ? (
        <p className="rounded-lg border border-border bg-surface px-4 py-3 text-sm text-muted">
          还没有收藏频道,去直播页挑选喜欢的频道并点击星标收藏。
        </p>
      ) : null}
      {state.kind === 'error' ? (
        <RetryableAlert
          title="收藏频道加载失败"
          description={state.message}
          onRetry={() => setReloadToken((token) => token + 1)}
        />
      ) : null}
      {state.kind === 'ready' ? (
        <>
          <ul className="grid list-none gap-3 sm:grid-cols-2 lg:grid-cols-4" aria-label="收藏频道列表">
            {state.items.map((item) => {
              const unavailable = item.media.availability !== 'available';
              return (
                <li key={item.media.id}>
                  <article
                    data-testid="favorite-card"
                    aria-label={`收藏频道:${item.media.title}`}
                    className="flex h-full flex-col gap-2 rounded-lg border border-border bg-surface p-3"
                  >
                    <div className="flex items-start justify-between gap-2">
                      <h3 className="min-w-0 truncate text-sm font-medium text-foreground">
                        <Link
                          to={`/media/${encodeURIComponent(item.media.id)}`}
                          state={{ favorited: true }}
                          className="rounded focus:outline-none focus-visible:ring-2 focus-visible:ring-focus"
                        >
                          {item.media.title}
                          {unavailable ? <span className="ms-2 text-xs font-normal text-muted">(不可用)</span> : null}
                        </Link>
                      </h3>
                      <FavoriteStarButton
                        mediaId={item.media.id}
                        title={item.media.title}
                        favorited={true}
                        unavailable={unavailable}
                        onChanged={(mediaId) => unfavorite(mediaId)}
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
          {state.nextCursor !== null ? (
            <Button variant="ghost" size="sm" onPress={loadMore} isDisabled={state.appending} className="self-start">
              {state.appending ? '加载中…' : '查看更多收藏'}
            </Button>
          ) : null}
        </>
      ) : null}
    </section>
  );
}

/** 点播观看历史分区(独立状态;历史卡进入详情,不自动播放) */
function HistorySection({ cacheKey }: { readonly cacheKey: string }): ReactNode {
  const [state, setState] = useState<SectionState<HistoryItem>>({ kind: 'loading' });
  const [reloadToken, setReloadToken] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    const capturedKey = cacheKey;
    setState({ kind: 'loading' });
    fetchHistory({ limit: PAGE_SIZE, signal: controller.signal })
      .then((page) => {
        if (controller.signal.aborted || capturedKey !== cacheKey) {
          return;
        }
        setState(
          page.items.length === 0
            ? { kind: 'empty' }
            : { kind: 'ready', items: page.items, nextCursor: page.nextCursor, appending: false },
        );
      })
      .catch((error: unknown) => {
        if (isAbortError(error)) {
          return;
        }
        if (capturedKey !== cacheKey) {
          return;
        }
        setState({ kind: 'error', message: errorMessageOf(error) });
      });
    return () => controller.abort();
  }, [cacheKey, reloadToken]);

  const loadMore = (): void => {
    if (state.kind !== 'ready' || state.nextCursor === null || state.appending) {
      return;
    }
    const cursor = state.nextCursor;
    setState({ ...state, appending: true });
    fetchHistory({ cursor, limit: PAGE_SIZE })
      .then((page) => {
        setState((previous) =>
          previous.kind === 'ready'
            ? { ...previous, items: [...previous.items, ...page.items], nextCursor: page.nextCursor, appending: false }
            : previous,
        );
      })
      .catch(() => {
        setState((previous) => (previous.kind === 'ready' ? { ...previous, appending: false } : previous));
      });
  };

  return (
    <section aria-label="点播观看历史" data-testid="home-history" className="flex flex-col gap-3">
      <div className="flex items-baseline justify-between">
        <h2 className="text-lg font-semibold text-foreground">点播观看历史</h2>
        <Link to="/vod" className="text-sm text-accent underline-offset-4 hover:underline">
          浏览点播目录
        </Link>
      </div>
      {state.kind === 'loading' ? <LoadingSpinner label="加载观看历史…" /> : null}
      {state.kind === 'empty' ? (
        <p className="rounded-lg border border-border bg-surface px-4 py-3 text-sm text-muted">
          还没有点播观看记录;真正开始播放后,这里会显示最近观看的内容供你继续观看。
        </p>
      ) : null}
      {state.kind === 'error' ? (
        <RetryableAlert
          title="观看历史加载失败"
          description={state.message}
          onRetry={() => setReloadToken((token) => token + 1)}
        />
      ) : null}
      {state.kind === 'ready' ? (
        <>
          <ul className="grid list-none gap-3 sm:grid-cols-2 lg:grid-cols-4" aria-label="观看历史列表">
            {state.items.map((item) => (
              <li key={item.media.id}>
                <HistoryCard item={item} />
              </li>
            ))}
          </ul>
          {state.nextCursor !== null ? (
            <Button variant="ghost" size="sm" onPress={loadMore} isDisabled={state.appending} className="self-start">
              {state.appending ? '加载中…' : '查看更多历史'}
            </Button>
          ) : null}
        </>
      ) : null}
    </section>
  );
}

/** 个人区装配:仅已选档渲染;缓存键 = household:profile:contextVersion(FR-019) */
export function HomePersonalArea(): ReactNode {
  const session = useSession();
  const cacheKey = session.personalCacheKey;
  if (session.status !== 'authenticated' || session.session === null || session.session.activeProfile === null || cacheKey === null) {
    return null; // 游客/未选档:不发个人请求,不占首屏
  }
  return (
    <div data-testid="home-personal-area" className="flex flex-col gap-8">
      <FavoritesSection cacheKey={cacheKey} />
      <HistorySection cacheKey={cacheKey} />
    </div>
  );
}
