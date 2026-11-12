import type { ReactNode } from 'react';
import { Link } from 'react-router';
import type { PublicContextDto } from '@hmp/shared';
import { useAppQuery } from '../../shared/query/hooks';
import { queryKeys } from '../../shared/query/keys';
import { formatApiError } from '../../shared/query/error';
import { publicFetch } from '../../shared/fetch';
import { LoadingSpinner, MediaGridSkeleton, RetryableAlert } from '../../shared/ui';
import { HomePersonalArea } from './personal-area';
import { VOD_ENABLED } from '../../shared/feature-flags';

/**
 * 首页(T027 公共区 + T105 个人区组装,US1/US4;T023 迁移:006 统一数据层;
 * contracts/ui.md §4、FR-015/016):
 *
 * - 游客可见公共入口:直播摘要入口(→ /live)、所有节目单入口(→ /live/guide)、
 *   基础点播入口(→ /vod);轻量登录提示,不用空白个人区占首屏(FR-015);
 * - 已选档:个人区(收藏频道 → 点播观看历史,ui.md §4 顺序)在前,公共区在后;
 *   个人区各分区独立状态,失败只重试本区,公共区不受阻(FR-016/FR-019);
 * - 公共区状态(本页上下文)取数经 useAppQuery(public 域;键取自
 *   queryKeys.public.context 工厂;signal 透传/缓存/后台刷新由数据层承担):
 *   跨换档保留缓存,个人区按身份键独立重载,公共区不因换档重新请求(FR-045);
 * - 公共区请求 credentials omit(publicFetch)与个人请求 Session(privateFetch,
 *   见 personal-area/history/favorites)分离(FR-003/§1 四类边界);
 * - 三态(FR-004):加载骨架 / 失败可重试(文案经 formatApiError 映射链)/ 成功内容;
 * - 直播摘要数据端点(GET /public/live/*)属 US5:入口渲染为静态占位卡并明确注明,
 *   不造假数据;空/加载/失败按 FR-004 三态展示。
 */

export function HomePage(): ReactNode {
  // 公共上下文:public 域浏览型查询(命中缓存立即渲染,过期后台刷新)
  const {
    data: context,
    isPending,
    isError,
    error,
    refetch,
  } = useAppQuery<PublicContextDto>({
    domain: 'public',
    queryKey: queryKeys.public.context(),
    queryFn: ({ signal }) => publicFetch<PublicContextDto>('/public/context', { signal }),
  });

  return (
    <section className="mx-auto flex w-full max-w-6xl flex-col gap-6">
      <header className="flex flex-col gap-1">
        <h1 className="text-xl font-semibold text-foreground">首页</h1>
        {context?.initialized ? (
          <p className="text-sm text-muted">
            欢迎来到「{context.displayName}」,无需登录即可浏览本家庭全部可用内容。
          </p>
        ) : (
          <p className="text-sm text-muted">无需登录即可浏览公开内容。</p>
        )}
      </header>

      {isPending ? (
        <>
          <LoadingSpinner />
          <MediaGridSkeleton count={4} />
        </>
      ) : null}

      {isError ? (
        <RetryableAlert
          title="首页加载失败"
          description={formatApiError(error)}
          onRetry={() => {
            void refetch();
          }}
        />
      ) : null}

      {!isPending && !isError && context !== undefined ? (
        <>
          {/* 个人区(T105):仅已选档渲染(收藏频道 → 点播观看历史);游客零个人请求 */}
          <HomePersonalArea />

          {/* 游客轻量登录提示:不渲染空白个人区占位 */}
          <p className="rounded-lg border border-border bg-surface px-4 py-3 text-sm text-muted">
            登录并选择观看档案后,可使用收藏、观看历史与受控播放等个人功能。
          </p>

          <div className={`grid gap-4 ${VOD_ENABLED ? 'sm:grid-cols-3' : 'sm:grid-cols-2'}`}>
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
            {/* v1 只做直播:点播入口卡隐藏(卡片实现保留,翻开关即恢复) */}
            {VOD_ENABLED ? (
              <Link
                to="/vod"
                className="flex flex-col gap-2 rounded-lg border border-border bg-surface p-4 transition-colors hover:border-accent focus:outline-none focus-visible:ring-2 focus-visible:ring-focus"
              >
                <span className="text-base font-medium text-foreground">点播</span>
                <span className="text-sm text-muted">浏览基础点播目录,支持搜索、类型筛选与翻页。</span>
              </Link>
            ) : null}
          </div>
        </>
      ) : null}
    </section>
  );
}
