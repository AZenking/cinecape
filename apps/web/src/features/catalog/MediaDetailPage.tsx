import { useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import { Link, useParams } from 'react-router';
import { Button } from '@heroui/react';
import type { PublicMediaDto } from '@hmp/shared';
import { isAbortError, publicFetch } from '../../shared/fetch';
import { LoadingSpinner, RetryableAlert } from '../../shared/ui';

/**
 * 公共媒体详情页(T029,US1;contracts/ui.md §1、data-model §9):
 * - 渲染 PublicMedia 白名单元数据与海报:posterRef 仅同源资源或 null,当前部署无
 *   同源海报端点(公共投影恒为 null)→ 渲染占位,绝不直接渲染任意外部 URL;
 * - 元数据对游客完全可见、不按儿童/成人策略隐藏(US1 场景2);无个人状态
 *   (历史/进度/收藏)与播放凭据(个人数据属 US4 从 /me 读取,不进本页);
 * - 播放入口为占位:US3 统一受控播放流程(usePlayAction)接入后启用,
 *   本页不自行发起播放、不伪造可播放承诺;
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
  const [state, setState] = useState<DetailState>({ kind: 'loading' });
  const [reloadToken, setReloadToken] = useState(0);

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

          {/* 播放入口占位:US3 统一受控播放流程接入后启用;本页不发起播放 */}
          <div className="flex items-center gap-3">
            <Button variant="primary" isDisabled>
              播放
            </Button>
            <span className="text-xs text-muted">播放将在登录选档后经统一受控流程提供。</span>
          </div>
        </div>
      </div>
    </section>
  );
}
