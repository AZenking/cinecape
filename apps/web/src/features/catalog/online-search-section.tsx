import { useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { Link, useSearchParams } from 'react-router';
import { Button, Input, Label, TextField } from '@heroui/react';
import type { Vod } from '@hmp/shared';
import { useAppQuery } from '../../shared/query/hooks';
import { queryKeys } from '../../shared/query/keys';
import { isFetchApiError, publicFetch } from '../../shared/fetch';
import { formatApiError } from '../../shared/query/error';
import {
  LoadingSpinner,
  MediaGridSkeleton,
  NoMatchState,
  RetryableAlert,
} from '../../shared/ui';

type SearchPageDto = Vod.components['schemas']['SearchPage'];
type PublicVodCardDto = Vod.components['schemas']['PublicVodCard'];

/**
 * /vod?mode=online 在线搜索区(T033,US1;contracts/api.md §1/§2/§6、ui.md §1)。
 *
 * URL 是组件状态的唯一来源(mode/q/searchId/cursor 由父级 VodCatalogPage 切入):
 * - 「活跃搜索」= 提交 q 触发:取数输入恒为 `{q}`(与 searchId/cursor 互斥,
 *   api.md §2「两组参数互斥」);**成功页把 searchId 写入 URL 不得改变取数输入**——
 *   活跃期查询键只含 q(T032 A1 计数=1 断言),searchId 仅经本地 `ownSearchId`
 *   标记「本实例自产」,用于区分活跃期与「刷新/返回恢复期」;
 * - 「恢复/翻页」= URL 带 searchId 且非本实例自产:取数输入为
 *   `{searchId}`(缺 cursor 时服务端重放第一页)或 `{searchId,cursor}`;
 *   同键已生成页命中 30s 新鲜缓存,前进/后退不重复拉取(B2);
 * - 410 VOD_SEARCH_EXPIRED:role=alert + 「重新搜索」(保留 q,清 searchId/cursor,
 *   重搜请求只带 q,不复用旧 searchId/cursor——api.md §6);
 * - partial=true 非整页失败:成功来源卡片照常渲染 + 「部分来源暂不可用」+ reasons 原文;
 * - 全部经 publicFetch(omit 档),不触达任何 /me 个人端点(游客纯净,ui.md §1);
 * - posterRef 恒 null:渲染占位,绝不渲染 img/外部地址。
 *
 * 查询键(T034 已收编公共键工厂 keys.ts;双形状逐字保留):
 * `['public','vod','search', input]`,input = `{q}` 或 `{searchId,cursor?}`。
 */
type SearchInput = { q: string } | { searchId: string; cursor?: string };

/** 键取自公共键工厂(T034):活跃期 `{q}`,恢复/翻页期 `{searchId,cursor?}`,空闲 `{idle:true}` */
function searchQueryKey(input: SearchInput | null): readonly unknown[] {
  return queryKeys.public.vodSearch(input);
}

/** 取数输入 → fetch query(未定义键一律省略,保证互斥形状逐字可见) */
function searchInputToQuery(input: SearchInput): Record<string, string> {
  if ('q' in input) {
    return { q: input.q };
  }
  return input.cursor === undefined ? { searchId: input.searchId } : { searchId: input.searchId, cursor: input.cursor };
}

/** 判定 410 搜索过期(api.md §6:恢复动作=保留 q 重新搜索) */
function isSearchExpired(error: unknown): boolean {
  return isFetchApiError(error) && (error.code === 'VOD_SEARCH_EXPIRED' || error.status === 410);
}

export function OnlineSearchSection(): ReactNode {
  const [searchParams, setSearchParams] = useSearchParams();

  const q = searchParams.get('q') ?? '';
  const searchId = searchParams.get('searchId');
  const cursor = searchParams.get('cursor');

  // 本实例自产的 searchId:区分「活跃搜索期」与「恢复/翻页期」。
  // 活跃期写入 URL 的 searchId 不改变取数输入;刷新/返回后(新实例 ownSearchId=null)
  // 同一 URL 进入恢复期,按 searchId 重放(api.md §2)。
  const [ownSearchId, setOwnSearchId] = useState<string | null>(null);

  // 搜索输入草稿:受控于本地,提交时才写入 URL(与库内目录页同一惯例)
  const [draft, setDraft] = useState(q);
  const lastUrlQ = useRef(q);
  useEffect(() => {
    if (lastUrlQ.current !== q) {
      lastUrlQ.current = q;
      setDraft(q);
    }
  }, [q]);

  // 阶段判定:活跃期取数输入={q};恢复/翻页期={searchId,cursor?};两者互斥
  const isOwnSearch = searchId !== null && searchId === ownSearchId;
  const activeQ = q !== '' && (searchId === null || isOwnSearch) ? q : null;
  const replaySearchId = searchId !== null && !isOwnSearch ? searchId : null;
  const input: SearchInput | null =
    activeQ !== null
      ? { q: activeQ }
      : replaySearchId !== null
        ? cursor !== null
          ? { searchId: replaySearchId, cursor }
          : { searchId: replaySearchId }
        : null;

  const {
    data: page,
    isPending,
    isError,
    error,
    refetch,
  } = useAppQuery<SearchPageDto>({
    domain: 'public',
    queryKey: searchQueryKey(input),
    queryFn: ({ signal }) =>
      input === null
        ? Promise.reject(new Error('unreachable')) // enabled=false 时不会执行
        : publicFetch<SearchPageDto>('/public/vod/search', {
            query: searchInputToQuery(input),
            signal,
          }),
    enabled: input !== null,
  });

  // 活跃搜索成功:把服务端 searchId 写入 URL 并标记自产——查询键仍只含 q,
  // 写入本身不得触发二次拉取(T032 A1:计数=1)
  useEffect(() => {
    if (activeQ === null || page === undefined || ownSearchId === page.searchId) {
      return;
    }
    setOwnSearchId(page.searchId);
    const next = new URLSearchParams(searchParams);
    next.set('mode', 'online');
    next.set('q', activeQ);
    next.set('searchId', page.searchId);
    next.delete('cursor');
    setSearchParams(next);
  }, [activeQ, page, ownSearchId, searchParams, setSearchParams]);

  /** 提交新搜索(提交按钮与 410 过期后的「重新搜索」共用):只带 q,清 searchId/cursor */
  function submitSearch(): void {
    const trimmed = draft.trim();
    if (trimmed === '') {
      return;
    }
    setOwnSearchId(null);
    const next = new URLSearchParams();
    next.set('mode', 'online');
    next.set('q', trimmed);
    setSearchParams(next);
  }

  function goToPrevPage(): void {
    const next = new URLSearchParams(searchParams);
    next.delete('cursor'); // 缺 cursor 即第一页(服务端按 searchId 重放)
    setSearchParams(next);
  }

  function goToNextPage(): void {
    const nextCursor = page?.nextCursor ?? null;
    if (nextCursor === null) {
      return;
    }
    const next = new URLSearchParams(searchParams);
    next.set('cursor', nextCursor);
    setSearchParams(next);
  }

  const showResults = input !== null && !isPending && !isError && page !== undefined;

  return (
    <section className="flex flex-col gap-5" aria-label="在线搜索">
      <form
        className="flex items-end gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          submitSearch();
        }}
      >
        {/* RAC 受控值/变更在 TextField 根(onChange 收 string);Input 只承载外观 */}
        <TextField className="w-64" value={draft} onChange={setDraft}>
          <Label>搜索在线资源</Label>
          <Input placeholder="按标题搜索在线资源" autoComplete="off" />
        </TextField>
        <Button variant="secondary" size="sm" onPress={submitSearch}>
          搜索
        </Button>
      </form>

      {input === null ? (
        <p className="py-8 text-sm text-muted">输入关键字搜索已配置的在线资源。</p>
      ) : null}

      {isPending ? (
        <>
          <LoadingSpinner label="搜索中…" />
          <MediaGridSkeleton />
        </>
      ) : null}

      {isError ? (
        isSearchExpired(error) ? (
          // 410 VOD_SEARCH_EXPIRED:保留 q(输入框回显),重搜不复用旧 searchId/cursor
          <RetryableAlert
            title="搜索已过期"
            description={formatApiError(error)}
            retryLabel="重新搜索"
            onRetry={submitSearch}
          />
        ) : (
          <RetryableAlert
            title="搜索失败"
            description={formatApiError(error)}
            onRetry={() => {
              void refetch();
            }}
          />
        )
      ) : null}

      {showResults && page !== undefined ? (
        <>
          {/* partial 不是整页失败:正常来源卡片照常渲染,部分失败以文字呈现(api.md §1) */}
          {page.partial === true ? (
            <div className="rounded-lg border border-border bg-surface p-3">
              <p className="text-sm font-medium text-foreground">部分来源暂不可用</p>
              {page.reasons.length > 0 ? (
                <ul className="mt-1 list-disc pl-5 text-xs text-muted">
                  {page.reasons.map((reason) => (
                    <li key={reason}>{reason}</li>
                  ))}
                </ul>
              ) : null}
            </div>
          ) : null}

          {page.items.length === 0 ? (
            <NoMatchState />
          ) : (
            <ul
              className="grid gap-4"
              style={{
                gridTemplateColumns: 'repeat(auto-fill, minmax(var(--hmp-media-poster-grid-min), 1fr))',
              }}
            >
              {page.items.map((card: PublicVodCardDto) => (
                <li key={card.titleRef}>
                  <Link
                    to={`/vod/titles/${encodeURIComponent(card.titleRef)}`}
                    className="group flex flex-col gap-2 rounded-lg border border-border bg-surface p-3 transition-colors hover:border-accent focus:outline-none focus-visible:ring-2 focus-visible:ring-focus"
                    style={{
                      borderRadius: 'var(--hmp-media-card-radius)',
                      boxShadow: 'var(--hmp-media-card-shadow)',
                    }}
                  >
                    {/* posterRef 恒 null:渲染主题占位,绝不渲染 img/外部地址(DESIGN.md 媒体 token) */}
                    <div
                      className="flex items-center justify-center text-xs text-muted"
                      style={{
                        aspectRatio: 'var(--hmp-media-ratio-poster)',
                        backgroundColor: 'var(--hmp-media-poster-placeholder)',
                        borderRadius: 'var(--hmp-media-card-radius)',
                      }}
                    >
                      无海报
                    </div>
                    <span className="truncate text-sm font-medium text-foreground group-hover:underline">
                      {card.title}
                    </span>
                    {/* year/sourceLabel 各自独立文本节点(可访问名/测试均按精确文本定位) */}
                    <span className="text-xs text-muted">{card.year ?? '年份未知'}</span>
                    <span className="truncate text-xs text-muted">{card.sourceLabel}</span>
                  </Link>
                </li>
              ))}
            </ul>
          )}

          {/* 翻页:{searchId,cursor} 与 q 互斥;上一页=去 cursor(重放第一页) */}
          <nav aria-label="分页" className="flex items-center justify-center gap-3">
            <Button size="sm" variant="outline" isDisabled={cursor === null} onPress={goToPrevPage}>
              上一页
            </Button>
            <span aria-live="polite" className="text-sm text-muted">
              本页 {page.items.length} 条结果
            </span>
            <Button
              size="sm"
              variant="outline"
              isDisabled={page.nextCursor === null}
              onPress={goToNextPage}
            >
              下一页
            </Button>
          </nav>
        </>
      ) : null}
    </section>
  );
}
