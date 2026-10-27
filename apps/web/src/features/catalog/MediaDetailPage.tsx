import { useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import { Link, useLocation, useParams } from 'react-router';
import type { PublicMediaDto } from '@hmp/shared';
import { isAbortError, isFetchApiError, publicFetch } from '../../shared/fetch';
import { LoadingSpinner, RetryableAlert } from '../../shared/ui';
import { PlayButton } from '../playback/use-play-action';
import { useSession } from '../../app/session-provider';
import { fetchHistoryItem, type HistoryItem } from '../history/history-api';
import { FavoriteStarButton } from '../favorites/favorite-star-button';

/**
 * 公共媒体详情页(T029,US1;T103 续播入口,US4;contracts/ui.md §1、data-model §9):
 * - 渲染 PublicMedia 白名单元数据与海报:posterRef 仅同源资源或 null,当前部署无
 *   同源海报端点(公共投影恒为 null)→ 渲染占位,绝不直接渲染任意外部 URL;
 * - 元数据对游客完全可见、不按儿童/成人策略隐藏(US1 场景2);
 * - 个人状态(US4):仅已选档经 GET /me/history/{mediaId} 读取本档案记录 —— 游客与
 *   未选档不发个人请求,进度不进入公共详情 HTML(公共响应/缓存不含个人数据);
 *   canResume=true 展示「继续观看」(startMode=resume)与「从头播放」
 *   (startMode=beginning),二者都经统一受控播放重新授权;无效/到尾/资源变化
 *   仅从头;频道媒体提供独立星标收藏/取消(不冒泡播放);
 * - 播放入口接入 US3 统一受控播放流程(PlayButton → usePlayAction):本页不自行
 *   发起播放、不伪造可播放承诺;不可用内容禁用并给理由;
 * - 不存在/不可用(服务端统一 404)→ 可回目录的失败态,不泄露存在性。
 */

const MEDIA_TYPE_LABELS: Record<string, string> = {
  channel: '频道',
  movie: '影片',
  series: '剧集',
  episode: '单集',
  video: '视频',
};

type DetailState =
  | { readonly kind: 'loading' }
  | { readonly kind: 'ready'; readonly media: PublicMediaDto }
  | { readonly kind: 'notFound' }
  | { readonly kind: 'error'; readonly message: string };

export function MediaDetailPage(): ReactNode {
  const { id } = useParams<{ id: string }>();
  const location = useLocation();
  const session = useSession();
  const [state, setState] = useState<DetailState>({ kind: 'loading' });
  const [reloadToken, setReloadToken] = useState(0);
  /** 本档案观看历史(US4;仅已选档读取;游客/未选档恒 null 不发请求) */
  const [history, setHistory] = useState<HistoryItem | null>(null);

  useEffect(() => {
    if (id === undefined || id === '') {
      setState({ kind: 'notFound' });
      return;
    }
    const controller = new AbortController();
    setState({ kind: 'loading' });
    publicFetch<PublicMediaDto>(`/public/media/${encodeURIComponent(id)}`, {
      signal: controller.signal,
    })
      .then((media) => {
        setState({ kind: 'ready', media });
      })
      .catch((err: unknown) => {
        if (isAbortError(err)) {
          return;
        }
        if (err instanceof Error && 'status' in err && (err as { status?: number }).status === 404) {
          // 服务端对不存在/跨家庭/不可用统一 404:同形呈现,不泄露存在性
          setState({ kind: 'notFound' });
          return;
        }
        setState({
          kind: 'error',
          message: err instanceof Error && err.message ? err.message : '加载失败,请稍后重试',
        });
      });
    return () => controller.abort();
  }, [id, reloadToken]);

  // 个人历史读取(US4 T103):身份键变化即重读/丢弃;游客/未选档零个人请求。
  // 失败静默(公共详情不因个人区失败受阻;进度本来就不进公共详情)。
  const personalCacheKey = session.personalCacheKey;
  const mediaId = state.kind === 'ready' ? state.media.id : null;
  useEffect(() => {
    if (personalCacheKey === null || mediaId === null) {
      setHistory(null);
      return;
    }
    const controller = new AbortController();
    fetchHistoryItem(mediaId, controller.signal)
      .then((item) => {
        if (!controller.signal.aborted) {
          setHistory(item);
        }
      })
      .catch((error: unknown) => {
        if (isAbortError(error)) {
          return;
        }
        if (isFetchApiError(error) && (error.status === 401 || error.status === 403)) {
          setHistory(null); // 失效回落:清个人展示,公共详情不受阻(FR-009)
          return;
        }
        setHistory(null);
      });
    return () => controller.abort();
  }, [personalCacheKey, mediaId]);

  if (state.kind === 'loading') {
    return <LoadingSpinner label="加载详情…" />;
  }

  if (state.kind === 'error') {
    return (
      <RetryableAlert
        title="详情加载失败"
        description={state.message}
        onRetry={() => {
          setReloadToken((token) => token + 1);
        }}
      />
    );
  }

  if (state.kind === 'notFound') {
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

  const { media } = state;

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
            {media.type !== 'channel' && history !== null && history.canResume && media.availability === 'available' ? (
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
                label={history !== null && history.canResume ? '从头播放' : '播放'}
                variant={history !== null && history.canResume ? 'secondary' : 'primary'}
                ariaLabel={`${history !== null && history.canResume ? '从头播放' : '播放'} ${media.title}`}
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
          {history !== null && history.canResume ? (
            <p className="text-xs text-muted" data-testid="detail-resume-hint">
              上次观看至 {Math.floor(history.positionSeconds / 60)} 分钟,可继续观看或从头播放。
            </p>
          ) : null}
        </div>
      </div>
    </section>
  );
}
