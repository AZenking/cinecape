/**
 * 观看目录页(T037,User Story 2)。
 *
 * - GET /media 服务端分页(pageSize=20):标题搜索(q≤100,trim,防抖 300ms)、
 *   类型筛选(全部/channel/movie/series/episode/video)、页码控件;
 * - 列表卡片:海报占位(契约 poster 恒 null)+ 标题 + 类型徽标 + 分级标签;
 *   整卡为原生 Link,Tab 聚焦后 Enter 进入详情;
 * - 空态三分(spec US2 场景 4):请求失败(错误码文案 + 重试)/ 无可见内容
 *   (total=0;owner 另给「添加来源」引导)/ 加载中;
 * - 会话代次废弃:挂载时 createGenerationGuard(),每次请求前 begin(),
 *   回写 state 前 isCurrent(gen) 校验;当前档案变化(useEffect 监听
 *   session.activeProfile.id)立即 begin() 作废全部在途响应并回第 1 页重查
 *   (契约「UI 路由」:Profile 切换立即废弃原目录请求结果);
 * - 401 交现有会话处理(refresh → 路由守卫转登录);403 ACTIVE_PROFILE_REQUIRED
 *   显示「请先选择观看档案」并引导到档案选择页(/)。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router';
import {
  Alert,
  Button,
  Chip,
  Input,
  Label,
  ListBox,
  Select,
  Spinner,
  TextField,
} from '@heroui/react';
import { ApiError, api, createGenerationGuard } from '../lib/api';
import { useSession } from '../lib/session';
import { MediaPosterPlaceholder } from '../components/catalog/PosterPlaceholder';
import {
  CODE_ACTIVE_PROFILE_REQUIRED,
  MEDIA_TYPE_LABELS,
  contentLevelChipColor,
  contentLevelLabel,
  friendlyCatalogErrorMessage,
  type MediaType,
} from '../components/catalog/messages';
import type { MediaDto } from '@hmp/shared';

/** 列表分页大小(契约默认 20;本页固定) */
const PAGE_SIZE = 20;

/** 搜索防抖(ms) */
const SEARCH_DEBOUNCE_MS = 300;

/** 搜索词长度上限(契约 q 最多 100 字符) */
const QUERY_MAX_LENGTH = 100;

/** 类型筛选值:'all'=全部,其余为契约 Media.type */
type TypeFilter = 'all' | MediaType;

const TYPE_FILTER_OPTIONS: Array<{ value: TypeFilter; label: string }> = [
  { value: 'all', label: '全部' },
  { value: 'channel', label: MEDIA_TYPE_LABELS.channel },
  { value: 'movie', label: MEDIA_TYPE_LABELS.movie },
  { value: 'series', label: MEDIA_TYPE_LABELS.series },
  { value: 'episode', label: MEDIA_TYPE_LABELS.episode },
  { value: 'video', label: MEDIA_TYPE_LABELS.video },
];

function isTypeFilter(key: unknown): key is TypeFilter {
  return (
    key === 'all' ||
    key === 'channel' ||
    key === 'movie' ||
    key === 'series' ||
    key === 'episode' ||
    key === 'video'
  );
}

/** 目录查询语境:q/type/page + 发起时的观看档案(档案变化整体作废重查) */
interface CatalogQuery {
  /** 已应用(防抖后、trim、截断)的搜索词;空串=不搜索 */
  q: string;
  type: TypeFilter;
  page: number;
  profileId: string | null;
}

/** 页码控件条目:数字页码或省略号 */
type PageItem = number | 'gap';

/** 生成页码序列:≤7 页全展示,否则收拢为「1 … 邻页 … 末页」 */
function buildPageItems(current: number, totalPages: number): PageItem[] {
  if (totalPages <= 7) {
    return Array.from({ length: totalPages }, (_, index) => index + 1);
  }
  const wanted = new Set<number>(
    [1, totalPages, current - 1, current, current + 1].filter(
      (value) => value >= 1 && value <= totalPages,
    ),
  );
  const sorted = [...wanted].sort((a, b) => a - b);
  const items: PageItem[] = [];
  let previous = 0;
  for (const value of sorted) {
    if (value - previous > 1) {
      items.push('gap');
    }
    items.push(value);
    previous = value;
  }
  return items;
}

export function MediaCatalog() {
  const { session, refresh: refreshSession } = useSession();
  const navigate = useNavigate();

  /** 当前观看档案(会话语境;null=未选择,接口将 403 ACTIVE_PROFILE_REQUIRED) */
  const activeProfileId = session?.activeProfile?.id ?? null;
  /** 是否 owner(空目录时给「添加来源」引导) */
  const isOwner = session?.account?.role === 'owner';

  /** 会话代次守卫:Profile 切换等语境变化后废弃旧在途响应(T029/T037) */
  const guard = useMemo(createGenerationGuard, []);

  /* ------------------------------ 查询语境与结果 ------------------------------ */
  const [searchDraft, setSearchDraft] = useState('');
  const [query, setQuery] = useState<CatalogQuery>(() => ({
    q: '',
    type: 'all',
    page: 1,
    // 初始语境即挂载时的档案,避免首查即被档案 effect 作废
    profileId: session?.activeProfile?.id ?? null,
  }));
  const [retryToken, setRetryToken] = useState(0);

  const [items, setItems] = useState<MediaDto[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [errorCode, setErrorCode] = useState<string | null>(null);
  const [errorText, setErrorText] = useState<string | null>(null);

  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const pageItems = useMemo(() => buildPageItems(query.page, totalPages), [query.page, totalPages]);

  /* --------------------------- 目录加载(代次守卫) --------------------------- */

  useEffect(() => {
    const gen = guard.begin();
    let discarded = false;
    const load = async (): Promise<void> => {
      setLoading(true);
      setErrorText(null);
      setErrorCode(null);
      try {
        const result = await api.listMedia({
          q: query.q === '' ? undefined : query.q,
          type: query.type === 'all' ? undefined : query.type,
          page: query.page,
          pageSize: PAGE_SIZE,
        });
        if (discarded || !guard.isCurrent(gen)) {
          return; // 旧代次响应:一律丢弃,不回写 state
        }
        // 请求页超出总页数(如筛选后条目变少):回退最后一页重查一次
        if (result.total > 0 && result.items.length === 0 && query.page > 1) {
          setQuery((prev) => ({ ...prev, page: Math.ceil(result.total / PAGE_SIZE) }));
          return;
        }
        setItems(result.items);
        setTotal(result.total);
      } catch (error) {
        if (discarded || !guard.isCurrent(gen)) {
          return;
        }
        if (error instanceof ApiError && error.status === 401) {
          // 401 交给现有会话处理:refresh → SessionProvider 置匿名 → 路由守卫转登录
          void refreshSession();
        }
        setErrorCode(
          error instanceof ApiError && typeof error.code === 'string' ? error.code : null,
        );
        setErrorText(friendlyCatalogErrorMessage(error, '目录加载失败，请检查网络后重试。'));
      } finally {
        if (!discarded && guard.isCurrent(gen)) {
          setLoading(false);
        }
      }
    };
    void load();
    return () => {
      discarded = true;
    };
  }, [guard, query, refreshSession, retryToken]);

  /* ------------------- 搜索防抖:300ms 后应用并回第 1 页 ------------------- */

  useEffect(() => {
    const timer = window.setTimeout(() => {
      const next = searchDraft.trim().slice(0, QUERY_MAX_LENGTH);
      setQuery((prev) => (prev.q === next ? prev : { ...prev, q: next, page: 1 }));
    }, SEARCH_DEBOUNCE_MS);
    return () => {
      window.clearTimeout(timer);
    };
  }, [searchDraft]);

  /* ------------------ 档案切换:作废在途响应并回第 1 页重查 ------------------ */

  const profileContextRef = useRef<string | null>(activeProfileId);
  useEffect(() => {
    const previous = profileContextRef.current;
    profileContextRef.current = activeProfileId;
    if (previous === activeProfileId) {
      // 首次挂载或档案未变化:不开新代次,避免作废首查
      return;
    }
    // 档案变化:立即作废全部在途响应,清空旧档案数据并回第 1 页重查
    guard.begin();
    setItems([]);
    setTotal(0);
    setLoading(true);
    setQuery((prev) => ({ ...prev, profileId: activeProfileId, page: 1 }));
  }, [activeProfileId, guard]);

  /* ------------------------------ 交互回调 ------------------------------ */

  const changeTypeFilter = useCallback((next: TypeFilter): void => {
    setQuery((prev) => (prev.type === next ? prev : { ...prev, type: next, page: 1 }));
  }, []);

  const changePage = useCallback((next: number): void => {
    setQuery((prev) => (prev.page === next ? prev : { ...prev, page: next }));
  }, []);

  const retry = useCallback((): void => {
    setRetryToken((token) => token + 1);
  }, []);

  const goPickProfile = useCallback((): void => {
    void navigate('/');
  }, []);

  /* ------------------------------- 渲染 ------------------------------- */

  const hasActiveFilter = query.q !== '' || query.type !== 'all';
  const isProfileRequired = errorCode === CODE_ACTIVE_PROFILE_REQUIRED;

  return (
    <section className="space-y-6">
      <div>
        <h1 className="text-xl font-semibold">观看目录</h1>
        <p className="mt-1 text-sm text-muted">
          仅显示当前观看档案允许的内容;搜索与翻页不会绕过观看策略。
        </p>
      </div>

      {/* 搜索与类型筛选(原生输入 + React Aria Select,均可键盘操作) */}
      <div className="flex flex-col gap-3 sm:flex-row sm:items-end">
        <TextField
          value={searchDraft}
          onChange={setSearchDraft}
          fullWidth
          className="max-w-sm"
          aria-label="按标题搜索"
        >
          <Label>搜索</Label>
          <Input
            type="search"
            placeholder="按标题搜索(最多 100 字符)"
            maxLength={QUERY_MAX_LENGTH}
          />
        </TextField>
        <Select
          className="max-w-40"
          value={query.type}
          onChange={(key) => {
            if (isTypeFilter(key)) {
              changeTypeFilter(key);
            }
          }}
          aria-label="类型筛选"
        >
          <Label>类型</Label>
          <Select.Trigger>
            <Select.Value />
            <Select.Indicator />
          </Select.Trigger>
          <Select.Popover>
            <ListBox>
              {TYPE_FILTER_OPTIONS.map((option) => (
                <ListBox.Item key={option.value} id={option.value} textValue={option.label}>
                  {option.label}
                  <ListBox.ItemIndicator />
                </ListBox.Item>
              ))}
            </ListBox>
          </Select.Popover>
        </Select>
      </div>

      {/* 列表主体:加载 / 失败 / 空 / 数据 四态 */}
      {loading && items.length === 0 ? (
        <div className="flex flex-col items-center gap-3 py-12">
          <Spinner size="lg" />
          <p className="text-sm text-muted">正在加载目录…</p>
        </div>
      ) : errorText !== null ? (
        <div className="space-y-4">
          <Alert status={isProfileRequired ? 'warning' : 'danger'}>
            <Alert.Indicator />
            <Alert.Content>
              <Alert.Title>{isProfileRequired ? '请先选择观看档案' : '目录加载失败'}</Alert.Title>
              <Alert.Description>{errorText}</Alert.Description>
            </Alert.Content>
          </Alert>
          {isProfileRequired ? (
            <Button variant="outline" onPress={goPickProfile}>
              去选择档案
            </Button>
          ) : (
            <Button variant="outline" onPress={retry}>
              重试
            </Button>
          )}
        </div>
      ) : items.length === 0 ? (
        <div className="space-y-3 py-8 text-center">
          <p className="text-sm text-muted">
            {hasActiveFilter ? '没有匹配的内容，试试调整搜索或筛选。' : '暂无可见内容。'}
          </p>
          {isOwner && (
            <p className="text-sm text-muted">
              还没有可用内容？{' '}
              <Link
                to="/sources"
                className="rounded text-accent underline-offset-4 hover:underline focus:outline-none focus-visible:ring-2 focus-visible:ring-focus"
              >
                前往添加来源
              </Link>
            </p>
          )}
        </div>
      ) : (
        <>
          <ul className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {items.map((media) => (
              <li key={media.id}>
                <Link
                  to={`/media/${media.id}`}
                  className="flex h-full gap-4 rounded-xl border border-border p-4 transition-colors hover:border-accent focus:outline-none focus-visible:ring-2 focus-visible:ring-focus"
                  aria-label={`查看「${media.title}」详情`}
                >
                  <MediaPosterPlaceholder title={media.title} className="h-24 w-16 text-2xl" />
                  <div className="flex min-w-0 flex-1 flex-col gap-2">
                    <p className="truncate font-medium text-foreground">{media.title}</p>
                    <p className="flex flex-wrap items-center gap-2">
                      <Chip
                        size="sm"
                        variant="soft"
                        color="default"
                        aria-label={`类型 ${MEDIA_TYPE_LABELS[media.type]}`}
                      >
                        {MEDIA_TYPE_LABELS[media.type]}
                      </Chip>
                      <Chip
                        size="sm"
                        variant="soft"
                        color={contentLevelChipColor(media.contentLevel)}
                        aria-label={`分级 ${contentLevelLabel(media.contentLevel)}`}
                      >
                        {contentLevelLabel(media.contentLevel)}
                      </Chip>
                    </p>
                  </div>
                </Link>
              </li>
            ))}
          </ul>

          {/* 页码控件(服务端分页;加载中禁用翻页) */}
          <nav
            aria-label="分页"
            className="flex flex-wrap items-center justify-between gap-3"
          >
            <p className="flex items-center gap-2 text-sm text-muted">
              第 {query.page} / {totalPages} 页 · 共 {total} 个内容
              {loading && <Spinner size="sm" aria-label="加载中" />}
            </p>
            <div className="flex flex-wrap items-center gap-2">
              <Button
                size="sm"
                variant="outline"
                isDisabled={query.page <= 1 || loading}
                onPress={() => changePage(query.page - 1)}
              >
                上一页
              </Button>
              {pageItems.map((item, index) =>
                item === 'gap' ? (
                  <span key={`gap-${index}`} aria-hidden="true" className="px-1 text-muted">
                    …
                  </span>
                ) : (
                  <Button
                    key={item}
                    size="sm"
                    variant={item === query.page ? 'primary' : 'outline'}
                    aria-current={item === query.page ? 'page' : undefined}
                    isDisabled={loading}
                    onPress={() => changePage(item)}
                  >
                    {item}
                  </Button>
                ),
              )}
              <Button
                size="sm"
                variant="outline"
                isDisabled={query.page >= totalPages || loading}
                onPress={() => changePage(query.page + 1)}
              >
                下一页
              </Button>
            </div>
          </nav>
        </>
      )}
    </section>
  );
}
