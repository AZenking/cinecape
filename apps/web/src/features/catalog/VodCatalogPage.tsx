import { useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { Link, useSearchParams } from 'react-router';
import { Button, Input, Label, TextField } from '@heroui/react';
import type { PublicMediaPageDto } from '@hmp/shared';
import { isAbortError, publicFetch } from '../../shared/fetch';
import {
  EmptyCatalogState,
  LoadingSpinner,
  MediaGridSkeleton,
  NoMatchState,
  RetryableAlert,
} from '../../shared/ui';

/**
 * 基础点播目录页(T028,US1;contracts/ui.md §1/§2、spec.md US1 场景4/5):
 * - q/type/page 全部写入 URL 查询参数(FR-045):组件状态唯一来源是 URL,
 *   详情返回或登录取消后按原 URL 恢复原搜索、筛选与页码,不重置回第一页;
 * - 搜索/筛选变更翻回第一页(page 键省略即第一页);翻页保留 q/type;
 * - 三态区分(FR-004):加载中(role=status)/成功空结果(暂无内容 vs 无匹配)/
 *   失败可重试(role=alert + 重试按钮,错误不只靠颜色);
 * - 数据一律 publicFetch(credentials:'omit'),公共投影与身份无关;
 * - 沿用基础目录交互:不新增推荐算法、专题、剧集编排或独立视觉方案(FR-046)。
 */

/** 类型筛选选项(value='' = 不筛选) */
const TYPE_FILTERS = [
  { value: '', label: '全部' },
  { value: 'movie', label: '影片' },
  { value: 'series', label: '剧集' },
  { value: 'episode', label: '单集' },
  { value: 'video', label: '视频' },
  { value: 'channel', label: '频道' },
] as const;

const MEDIA_TYPE_LABELS: Record<string, string> = {
  channel: '频道',
  movie: '影片',
  series: '剧集',
  episode: '单集',
  video: '视频',
};

type LoadStatus = 'loading' | 'ready' | 'error';

/** 从 URL 读取的目录条件(第一页省略 page 键;空 q/type 省略键) */
interface CatalogParams {
  q: string;
  type: string;
  page: number;
}

function parseParams(searchParams: URLSearchParams): CatalogParams {
  const rawPage = Number.parseInt(searchParams.get('page') ?? '1', 10);
  return {
    q: searchParams.get('q') ?? '',
    type: searchParams.get('type') ?? '',
    page: Number.isFinite(rawPage) && rawPage >= 1 ? rawPage : 1,
  };
}

export function VodCatalogPage(): ReactNode {
  const [searchParams, setSearchParams] = useSearchParams();
  const params = parseParams(searchParams);

  const [status, setStatus] = useState<LoadStatus>('loading');
  const [pageData, setPageData] = useState<PublicMediaPageDto | null>(null);
  const [errorText, setErrorText] = useState<string | null>(null);
  const [reloadToken, setReloadToken] = useState(0);

  // 搜索输入草稿:受控于本地,提交时才写入 URL(避免每键一次请求)
  const [draft, setDraft] = useState(params.q);
  const lastUrlQ = useRef(params.q);
  useEffect(() => {
    if (lastUrlQ.current !== params.q) {
      lastUrlQ.current = params.q;
      setDraft(params.q);
    }
  }, [params.q]);

  // 数据加载:唯一事实源是 URL 条件;条件变化即重新请求(Abort 掉旧请求)
  useEffect(() => {
    const controller = new AbortController();
    setStatus('loading');
    setErrorText(null);
    publicFetch<PublicMediaPageDto>('/public/media', {
      query: {
        q: params.q || undefined,
        type: params.type || undefined,
        page: params.page,
      },
      signal: controller.signal,
    })
      .then((data) => {
        setPageData(data);
        setStatus('ready');
      })
      .catch((err: unknown) => {
        if (isAbortError(err)) {
          return;
        }
        setPageData(null);
        setErrorText(err instanceof Error && err.message ? err.message : '加载失败,请稍后重试');
        setStatus('error');
      });
    return () => controller.abort();
  }, [params.q, params.type, params.page, reloadToken]);

  /** 写 URL:保持其余键;显式给值;page<=1 省略键 */
  function updateParams(next: Partial<CatalogParams>): void {
    const merged = new URLSearchParams(searchParams);
    if (next.q !== undefined) {
      if (next.q) {
        merged.set('q', next.q);
      } else {
        merged.delete('q');
      }
      merged.delete('page'); // 新搜索/新筛选从第一页开始
    }
    if (next.type !== undefined) {
      if (next.type) {
        merged.set('type', next.type);
      } else {
        merged.delete('type');
      }
      merged.delete('page');
    }
    if (next.page !== undefined) {
      if (next.page > 1) {
        merged.set('page', String(next.page));
      } else {
        merged.delete('page');
      }
    }
    setSearchParams(merged);
  }

  // 搜索提交:Enter(form onSubmit)与按钮(onPress)共用同一处理;
  // RAC Button 不依赖原生 type=submit 行为,显式 onPress 保证点击路径可用
  function submitSearch(): void {
    updateParams({ q: draft.trim(), page: 1 });
  }

  const total = pageData?.total ?? 0;
  const pageSize = pageData?.pageSize ?? 20;
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const hasFilters = params.q !== '' || params.type !== '';

  return (
    <section className="flex flex-col gap-5">
      <header className="flex flex-col gap-3">
        <h1 className="text-xl font-semibold text-foreground">点播</h1>
        <div className="flex flex-wrap items-end gap-3">
          <form
            className="flex items-end gap-2"
            onSubmit={(event) => {
              event.preventDefault();
              submitSearch();
            }}
          >
            {/* RAC 受控值/变更在 TextField 根(onChange 收 string);Input 只承载外观 */}
            <TextField className="w-64" value={draft} onChange={setDraft}>
              <Label>搜索点播</Label>
              <Input placeholder="按标题搜索" autoComplete="off" />
            </TextField>
            <Button variant="secondary" size="sm" onPress={submitSearch}>
              搜索
            </Button>
          </form>
          <div role="group" aria-label="类型筛选" className="flex flex-wrap items-center gap-1">
            {TYPE_FILTERS.map((filter) => {
              const active = params.type === filter.value;
              return (
                <Button
                  key={filter.value}
                  size="sm"
                  variant={active ? 'primary' : 'ghost'}
                  aria-pressed={active}
                  onPress={() => {
                    updateParams({ type: filter.value, page: 1 });
                  }}
                >
                  {filter.label}
                </Button>
              );
            })}
          </div>
        </div>
      </header>

      {status === 'loading' ? (
        <>
          <LoadingSpinner />
          <MediaGridSkeleton />
        </>
      ) : null}

      {status === 'error' ? (
        <RetryableAlert
          title="目录加载失败"
          description={errorText ?? undefined}
          onRetry={() => {
            setReloadToken((token) => token + 1);
          }}
        />
      ) : null}

      {status === 'ready' && pageData !== null && total === 0 ? (
        hasFilters ? (
          <NoMatchState />
        ) : (
          <EmptyCatalogState />
        )
      ) : null}

      {status === 'ready' && pageData !== null && total > 0 ? (
        <>
          <ul className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4">
            {pageData.items.map((media) => (
              <li key={media.id}>
                <Link
                  to={`/media/${media.id}`}
                  className="group flex flex-col gap-2 rounded-lg border border-border bg-surface p-3 transition-colors hover:border-accent focus:outline-none focus-visible:ring-2 focus-visible:ring-focus"
                >
                  {/* posterRef 仅同源资源或 null:当前为 null 时渲染占位,不渲染任何外部地址 */}
                  <div className="flex aspect-video w-full items-center justify-center rounded bg-surface-secondary text-xs text-muted">
                    {media.posterRef === null ? '无海报' : ''}
                  </div>
                  <span className="truncate text-sm font-medium text-foreground group-hover:underline">
                    {media.title}
                  </span>
                  <span className="text-xs text-muted">
                    {MEDIA_TYPE_LABELS[media.type] ?? media.type}
                    {media.contentLevel !== null ? ` · ${media.contentLevel}` : ''}
                  </span>
                </Link>
              </li>
            ))}
          </ul>
          <nav aria-label="分页" className="flex items-center justify-center gap-3">
            <Button
              size="sm"
              variant="outline"
              isDisabled={params.page <= 1}
              onPress={() => {
                updateParams({ page: params.page - 1 });
              }}
            >
              上一页
            </Button>
            <span aria-live="polite" className="text-sm text-muted">
              第 {params.page} / {totalPages} 页 · 共 {total} 项
            </span>
            <Button
              size="sm"
              variant="outline"
              isDisabled={params.page >= totalPages}
              onPress={() => {
                updateParams({ page: params.page + 1 });
              }}
            >
              下一页
            </Button>
          </nav>
        </>
      ) : null}
    </section>
  );
}
