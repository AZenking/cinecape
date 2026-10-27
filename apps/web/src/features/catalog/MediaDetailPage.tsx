import type { ReactNode } from 'react';
import { Link, useLocation, useParams } from 'react-router';
import type { PublicMediaDto } from '@hmp/shared';
import { useAppQuery } from '../../shared/query/hooks';
import { queryKeys } from '../../shared/query/keys';
import { formatApiError } from '../../shared/query/error';
import { isFetchApiError, publicFetch } from '../../shared/fetch';
import { LoadingSpinner, RetryableAlert } from '../../shared/ui';
import { PlayButton } from '../playback/use-play-action';
import { useSession } from '../../app/session-provider';
import { useHistoryItemQuery } from '../history/use-history';
import { FavoriteStarButton } from '../favorites/favorite-star-button';

/**
 * 公共媒体详情页(T029,US1;T103 续播入口,US4;T023 迁移:006 统一数据层;
 * contracts/ui.md §1、data-model §9):
 * - 渲染 PublicMedia 白名单元数据与海报:posterRef 仅同源资源或 null,当前部署无
 *   同源海报端点(公共投影恒为 null)→ 渲染占位,绝不直接渲染任意外部 URL;
 * - 元数据对游客完全可见、不按儿童/成人策略隐藏(US1 场景2);
 * - 公共详情取数经 useAppQuery(public 域;键取自 queryKeys.public.media 工厂;
 *   signal 透传/缓存/后台刷新由数据层承担):服务端对不存在/跨家庭/不可用统一
 *   404 → 以 FetchApiError.status 404 判定,同形呈现「内容不存在」,不泄露存在性;
 *   其余失败 → 可重试失败态,文案经 formatApiError 映射链(不暴露原始报文);
 * - 个人状态(US4):仅已选档经统一数据层 useHistoryItemQuery(profile 域;键 =
 *   queryKeys.profile(pid).progress(id),identity 未知 enabled 关闭,FR-016 不发
 *   任何 /me 请求)读取本档案记录——游客与未选档不发个人请求,进度不进入公共
 *   详情 HTML(公共响应/缓存不含个人数据);查询失败(data undefined)静默回落
 *   无进度展示,公共详情不受阻(FR-009);canResume=true 展示「继续观看」
 *   (startMode=resume)与「从头播放」(startMode=beginning),二者都经统一受控
 *   播放重新授权;无效/到尾/资源变化仅从头;频道媒体提供独立星标收藏/取消(不
 *   冒泡播放);
 * - 播放入口接入 US3 统一受控播放流程(PlayButton → usePlayAction):本页不自行
 *   发起播放、不伪造可播放承诺;不可用内容禁用并给理由。
 */

const MEDIA_TYPE_LABELS: Record<string, string> = {
  channel: '频道',
  movie: '影片',
  series: '剧集',
  episode: '单集',
  video: '视频',
};

/** 「内容不存在或已下架」视图:路由缺参与服务端 404 同形呈现,不泄露存在性 */
function NotFoundView(): ReactNode {
  return (
    <section className="flex flex-1 flex-col items-center justify-center gap-3 py-16 text-center">
      <h1 className="text-xl font-semibold text-foreground">内容不存在或已下架</h1>
      <p className="max-w-prose text-sm text-muted">该内容当前不可浏览,可返回点播目录查看其他内容。</p>
      <Link
        to="/vod"
        className="rounded px-1 text-sm font-medium text-accent underline-offset-4 hover:underline focus:outline-none focus-visible:ring-2 focus-visible:ring-focus"
      >
        返回点播
      </Link>
    </section>
  );
}

export function MediaDetailPage(): ReactNode {
  const { id } = useParams<{ id: string }>();
  const location = useLocation();
  const session = useSession();

  // 公共详情查询(public 域):路由 id 缺失时不发请求,直接按不存在呈现
  const hasMediaId = id !== undefined && id !== '';
  const {
    data: media,
    isPending,
    isError,
    error,
    refetch,
  } = useAppQuery<PublicMediaDto>({
    domain: 'public',
    queryKey: queryKeys.public.media(id ?? ''),
    queryFn: ({ signal }) =>
      publicFetch<PublicMediaDto>(`/public/media/${encodeURIComponent(id ?? '')}`, { signal }),
    enabled: hasMediaId,
  });

  // 个人历史(US4 T103;T023 迁移统一数据层):useHistoryItemQuery(profile 域,
  // 键 = queryKeys.profile(pid).progress(id));profileId/mediaId 任一未知即不启用
  // (游客/未选档/公共详情未就绪零个人请求,FR-016);失败(data undefined)静默
  // 回落为无进度展示,公共详情不受阻(与原直接 fetch 的 401/403/网络失败回落一致)。
  const profileId = session.session?.activeProfile?.id ?? null;
  const history = useHistoryItemQuery(profileId, media?.id ?? null).data;

  if (!hasMediaId) {
    return <NotFoundView />;
  }

  if (isPending) {
    return <LoadingSpinner label="加载详情…" />;
  }

  if (isError) {
    // 服务端对不存在/跨家庭/不可用统一 404:同形呈现,不泄露存在性
    if (isFetchApiError(error) && error.status === 404) {
      return <NotFoundView />;
    }
    return (
      <RetryableAlert
        title="详情加载失败"
        description={formatApiError(error)}
        onRetry={() => {
          void refetch();
        }}
      />
    );
  }

  if (media === undefined) {
    return null; // 不可达:成功态必有 data(类型收窄辅助)
  }

  return (
    <section className="flex flex-col gap-6">
      <nav aria-label="路径" className="text-sm text-muted">
        <Link
          to="/vod"
          className="rounded text-accent underline-offset-4 hover:underline focus:outline-none focus-visible:ring-2 focus-visible:ring-focus"
        >
          点播
        </Link>
        <span aria-hidden="true"> / </span>
        <span className="text-foreground">{media.title}</span>
      </nav>

      <div className="flex flex-col gap-5 sm:flex-row">
        {/* posterRef 仅同源资源或 null:为 null 渲染占位;导入的任意外部 URL 不直接渲染 */}
        <div className="flex aspect-video w-full max-w-md items-center justify-center rounded-lg border border-border bg-surface-secondary text-sm text-muted">
          {media.posterRef === null ? '暂无海报' : ''}
        </div>
        <div className="flex min-w-0 flex-col gap-3">
          <h1 className="text-2xl font-semibold text-foreground">{media.title}</h1>
          <dl className="flex flex-wrap gap-x-6 gap-y-1 text-sm text-muted">
            <div className="flex gap-1">
              <dt>类型</dt>
              <dd className="text-foreground">{MEDIA_TYPE_LABELS[media.type] ?? media.type}</dd>
            </div>
            <div className="flex gap-1">
              <dt>分级</dt>
              <dd className="text-foreground">{media.contentLevel !== null ? media.contentLevel : '未评级'}</dd>
            </div>
            <div className="flex gap-1">
              <dt>状态</dt>
              <dd className="text-foreground">{media.availability === 'available' ? '可浏览' : '不可用'}</dd>
            </div>
          </dl>
          {media.description !== null ? (
            <p className="max-w-prose text-sm leading-6 text-foreground">{media.description}</p>
          ) : null}

          {/* 播放入口(US3 统一受控播放 + US4 续播入口):
              - canResume=true:「继续观看」(resume)与「从头播放」(beginning),均经
                统一受控播放重新授权;无效/到尾/资源变化仅从头(不越界定位);
              - 不可用内容禁用并给理由;频道提供独立星标收藏/取消(不冒泡播放)。 */}
          <div className="flex flex-wrap items-center gap-3">
            {media.type === 'channel' ? (
              <FavoriteStarButton
                mediaId={media.id}
                title={media.title}
                favorited={(location.state as { favorited?: boolean } | null)?.favorited ?? false}
                unavailable={media.availability !== 'available'}
              />
            ) : null}
            {media.type !== 'channel' && history?.canResume === true && media.availability === 'available' ? (
              <PlayButton
                mediaId={media.id}
                title={media.title}
                startMode="resume"
                label="继续观看"
                ariaLabel={`继续观看 ${media.title}`}
              />
            ) : null}
            {media.type !== 'channel' && media.availability === 'available' ? (
              <PlayButton
                mediaId={media.id}
                title={media.title}
                startMode="beginning"
                label={history?.canResume === true ? '从头播放' : '播放'}
                variant={history?.canResume === true ? 'secondary' : 'primary'}
                ariaLabel={`${history?.canResume === true ? '从头播放' : '播放'} ${media.title}`}
              />
            ) : (
              <PlayButton
                mediaId={media.id}
                title={media.title}
                disabled={media.availability !== 'available'}
                disabledReason={media.availability !== 'available' ? '该内容当前不可用' : undefined}
                ariaLabel={`播放 ${media.title}`}
              />
            )}
          </div>
          {history?.canResume === true ? (
            <p className="text-xs text-muted" data-testid="detail-resume-hint">
              上次观看至 {Math.floor(history.positionSeconds / 60)} 分钟,可继续观看或从头播放。
            </p>
          ) : null}
        </div>
      </div>
    </section>
  );
}
