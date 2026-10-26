import { useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import { Link } from 'react-router';
import type { PublicContextDto } from '@hmp/shared';
import { isAbortError, publicFetch } from '../../shared/fetch';
import { LoadingSpinner, MediaGridSkeleton, RetryableAlert } from '../../shared/ui';
import { PlayButton } from '../playback/use-play-action';

/**
 * 首页公共区(T027,US1;contracts/ui.md §4、FR-046):
 * - 游客可见公共入口:直播摘要入口(→ /live)、所有节目单入口(→ /live/guide)、
 *   基础点播入口(→ /vod);菜单不指向空白占位页;
 * - 直播摘要数据端点(GET /public/live/*)属 US5,尚未实现:入口渲染为静态占位卡
 *   并明确注明「直播摘要由直播服务提供」,不造假数据;
 * - 游客仅公共区与轻量登录提示,不用空白个人区占首屏(个人区属 US4);
 * - 收藏/历史播放入口为占位(T054):入口组件家族与全站同一(PlayButton/usePlayAction),
 *   数据与播放语义由 US4 填充,占位不造假数据、不伪装可播放承诺;
 * - 空/加载/失败按 FR-004 三态展示(公共上下文读取失败可重试,不伪装空内容)。
 */

type HomeState =
  | { readonly kind: 'loading' }
  | { readonly kind: 'ready'; readonly context: PublicContextDto }
  | { readonly kind: 'error'; readonly message: string };

export function HomePage(): ReactNode {
  const [state, setState] = useState<HomeState>({ kind: 'loading' });
  const [reloadToken, setReloadToken] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    setState({ kind: 'loading' });
    publicFetch<PublicContextDto>('/public/context', { signal: controller.signal })
      .then((context) => {
        setState({ kind: 'ready', context });
      })
      .catch((err: unknown) => {
        if (isAbortError(err)) {
          return;
        }
        setState({
          kind: 'error',
          message: err instanceof Error && err.message ? err.message : '加载失败,请稍后重试',
        });
      });
    return () => controller.abort();
  }, [reloadToken]);

  return (
    <section className="flex flex-col gap-6">
      <header className="flex flex-col gap-1">
        <h1 className="text-xl font-semibold text-foreground">首页</h1>
        {state.kind === 'ready' && state.context.initialized ? (
          <p className="text-sm text-muted">
            欢迎来到「{state.context.displayName}」,无需登录即可浏览本家庭全部可用内容。
          </p>
        ) : (
          <p className="text-sm text-muted">无需登录即可浏览公开内容。</p>
        )}
      </header>

      {state.kind === 'loading' ? (
        <>
          <LoadingSpinner />
          <MediaGridSkeleton count={4} />
        </>
      ) : null}

      {state.kind === 'error' ? (
        <RetryableAlert
          title="首页加载失败"
          description={state.message}
          onRetry={() => {
            setReloadToken((token) => token + 1);
          }}
        />
      ) : null}

      {state.kind === 'ready' ? (
        <>
          {/* 轻量登录提示:不渲染空白个人区占位(个人区属 US4) */}
          <p className="rounded-lg border border-border bg-surface px-4 py-3 text-sm text-muted">
            登录并选择观看档案后,可使用收藏、观看历史与受控播放等个人功能。
          </p>

          {/* 收藏/历史播放入口占位(T054):入口与全站同一 PlayButton 家族,数据由 US4 填充 */}
          <div className="grid gap-4 sm:grid-cols-2">
            <section
              aria-label="收藏频道入口占位"
              className="flex flex-col gap-2 rounded-lg border border-border bg-surface p-4"
            >
              <span className="text-base font-medium text-foreground">收藏频道</span>
              <span className="text-sm text-muted">登录并选择档案后,在此直接播放收藏的频道。</span>
              <PlayButton
                mediaId=""
                title="收藏频道"
                label="播放收藏"
                disabled
                disabledReason="收藏数据将由个人区(US4)提供"
                ariaLabel="播放收藏频道(占位,由 US4 提供)"
              />
            </section>
            <section
              aria-label="观看历史入口占位"
              className="flex flex-col gap-2 rounded-lg border border-border bg-surface p-4"
            >
              <span className="text-base font-medium text-foreground">观看历史</span>
              <span className="text-sm text-muted">登录并选择档案后,在此继续观看上次未看完的影片。</span>
              <PlayButton
                mediaId=""
                title="观看历史"
                label="继续观看"
                disabled
                disabledReason="观看历史将由个人区(US4)提供"
                ariaLabel="继续观看历史影片(占位,由 US4 提供)"
              />
            </section>
          </div>

          <div className="grid gap-4 sm:grid-cols-3">
            {/* 直播摘要入口:摘要数据端点属 US5,先渲染静态占位入口(不造假数据) */}
            <Link
              to="/live"
              className="flex flex-col gap-2 rounded-lg border border-border bg-surface p-4 transition-colors hover:border-accent focus:outline-none focus-visible:ring-2 focus-visible:ring-focus"
            >
              <span className="text-base font-medium text-foreground">直播</span>
              <span className="text-sm text-muted">进入直播首页,查看正在直播与即将播放的频道。</span>
              <span className="text-xs text-muted">首页直播摘要将由直播服务提供。</span>
            </Link>
            <Link
              to="/live/guide"
              className="flex flex-col gap-2 rounded-lg border border-border bg-surface p-4 transition-colors hover:border-accent focus:outline-none focus-visible:ring-2 focus-visible:ring-focus"
            >
              <span className="text-base font-medium text-foreground">所有节目单</span>
              <span className="text-sm text-muted">打开节目单墙,按日浏览全部频道节目安排。</span>
            </Link>
            <Link
              to="/vod"
              className="flex flex-col gap-2 rounded-lg border border-border bg-surface p-4 transition-colors hover:border-accent focus:outline-none focus-visible:ring-2 focus-visible:ring-focus"
            >
              <span className="text-base font-medium text-foreground">点播</span>
              <span className="text-sm text-muted">浏览基础点播目录,支持搜索、类型筛选与翻页。</span>
            </Link>
          </div>
        </>
      ) : null}
    </section>
  );
}
