import { useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import { Alert, Button } from '@heroui/react';
import type { Vod } from '@hmp/shared';
import { useAppQuery } from '../../shared/query/hooks';
import { queryKeys } from '../../shared/query/keys';
import { formatApiError } from '../../shared/query/error';
import { isFetchApiError, publicFetch } from '../../shared/fetch';
import { LoadingSpinner, RetryableAlert } from '../../shared/ui';
import { PlayButton } from '../playback/use-play-action';
import { aggregateLines } from './aggregate-lines';

type StableEpisodesDto = Vod.components['schemas']['StableEpisodes'];
type StableEpisodeItemDto = Vod.components['schemas']['StableEpisodeItem'];

/**
 * 稳定父详情的分集区(010 T033,US1;/media/:id detailKind=vod_title;
 * contracts/api.md §1 StableEpisodes、§2 分集分页;ui.md §1「父影片分集分页,
 * 子项单独播放」)。
 *
 * - 取数:GET /public/media/:id/episodes,{cursor} 游标分页(缺省=第一页);
 *   修订绑定 cursor,详情变化 409 VOD_DETAIL_CHANGED → 重读并明确重选
 *   (回到第一页重建,不复用旧位置);
 * - **跨页按 lineRef 聚合**(消费端规则,api.md §2,与预览详情同一规则):
 *   线路可跨页重复,累积分页合并为一个线路组,组内集按 mediaId 去重,
 *   不能把每页线路当新线;组内按 sequenceOrdinal 升序消费(缺序 null 殿后,
 *   保持到达顺序);
 * - stale=true(旧完整快照)时明确提示,不冒充最新;
 * - 子项单独播放:candidate 集经统一 PlayButton(US3 受控播放)发起;
 *   unavailable 集禁用并给理由(错误不只靠颜色)。
 *
 * 查询键(T034 已收编公共键工厂 keys.ts):
 * `['public','media','episodes', parentMediaId, {cursor}]`。
 */

/** 单个已取分页(记其游标,便于重取同游标时就地替换) */
interface EpisodePage {
  /** 请求游标;null = 第一页 */
  token: string | null;
  data: StableEpisodesDto;
}

export function ParentEpisodesSection({
  parentMediaId,
  parentTitle,
}: {
  parentMediaId: string;
  parentTitle: string;
}): ReactNode {
  // null = 第一页;非 null = 上一页返回的 nextCursor
  const [cursor, setCursor] = useState<string | null>(null);
  const [pages, setPages] = useState<EpisodePage[]>([]);

  const episodesKey = queryKeys.public.vodEpisodes(parentMediaId, { cursor });
  const {
    data: pageData,
    isPending,
    isError,
    error,
    refetch,
  } = useAppQuery<StableEpisodesDto>({
    domain: 'public',
    queryKey: episodesKey,
    queryFn: ({ signal }) =>
      publicFetch<StableEpisodesDto>(`/public/media/${encodeURIComponent(parentMediaId)}/episodes`, {
        query: cursor === null ? undefined : { cursor },
        signal,
      }),
  });

  // 成功页入列:同游标重取就地替换,新游标追加(跨页聚合的数据面)
  useEffect(() => {
    if (pageData === undefined) {
      return;
    }
    setPages((previous) => {
      const existingIndex = previous.findIndex((entry) => entry.token === cursor);
      if (existingIndex >= 0) {
        const next = [...previous];
        next[existingIndex] = { token: cursor, data: pageData };
        return next;
      }
      return [...previous, { token: cursor, data: pageData }];
    });
  }, [pageData, cursor]);

  /** 409 VOD_DETAIL_CHANGED 的重读:回到第一页重建(修订绑定 cursor,不复用旧位置) */
  function restartFromFirstPage(): void {
    setPages([]);
    setCursor(null);
    void refetch();
  }

  // 跨页按 lineRef 聚合 + 组内按 sequenceOrdinal 升序(null 殿后,保持到达顺序)
  const lines = useMemo(() => {
    const aggregated = aggregateLines(
      pages.flatMap((entry) => entry.data.lines),
      (episode: StableEpisodeItemDto) => episode.mediaId,
    );
    return aggregated.map((line) => ({
      ...line,
      episodes: [...line.episodes].sort((a, b) => {
        if (a.sequenceOrdinal === null && b.sequenceOrdinal === null) return 0;
        if (a.sequenceOrdinal === null) return 1;
        if (b.sequenceOrdinal === null) return -1;
        return a.sequenceOrdinal - b.sequenceOrdinal;
      }),
    }));
  }, [pages]);

  const lastPage = pages.length > 0 ? pages[pages.length - 1] : undefined;
  const nextCursor = lastPage?.data.nextCursor ?? null;
  const isStale = pages.some((entry) => entry.data.stale);
  const detailChanged = isError && isFetchApiError(error) && error.code === 'VOD_DETAIL_CHANGED';

  if (isError && !detailChanged) {
    return (
      <RetryableAlert
        title="分集加载失败"
        description={formatApiError(error)}
        onRetry={() => {
          void refetch();
        }}
      />
    );
  }

  return (
    <section aria-label="分集" className="flex flex-col gap-4">
      <h2 className="text-lg font-semibold text-foreground">分集</h2>

      {isStale ? (
        <p className="rounded-lg border border-border bg-surface p-3 text-sm text-muted">
          来源暂不可用，当前展示的是此前取得的完整快照。
        </p>
      ) : null}

      {detailChanged ? (
        <div role="alert">
          <Alert status="danger" className="w-full">
            <Alert.Content>
              <Alert.Title>内容已更新，需要重新加载分集</Alert.Title>
              <Alert.Description>将从第一页重新读取最新分集，已加载的旧分页会被丢弃。</Alert.Description>
            </Alert.Content>
          </Alert>
        </div>
      ) : null}

      {detailChanged ? (
        <div>
          <Button size="sm" variant="outline" onPress={restartFromFirstPage}>
            重新加载
          </Button>
        </div>
      ) : null}

      {!detailChanged ? (
        <>
          {lines.map((line) => (
            <div key={line.lineRef} className="flex flex-col gap-2">
              <h3 className="text-sm font-medium text-foreground">{line.name}</h3>
              <ul className="flex flex-col gap-2">
                {line.episodes.map((episode) => (
                  <li key={episode.mediaId} className="flex flex-wrap items-center gap-2">
                    <span className="text-sm text-foreground">{episode.label}</span>
                    {episode.sequenceOrdinal !== null ? (
                      <span className="text-xs text-muted">序号 {episode.sequenceOrdinal}</span>
                    ) : null}
                    <PlayButton
                      mediaId={episode.mediaId}
                      title={parentTitle}
                      size="sm"
                      variant="secondary"
                      label="播放"
                      ariaLabel={`播放 ${parentTitle} ${episode.label}`}
                      disabled={episode.availability !== 'candidate'}
                      disabledReason={episode.availability !== 'candidate' ? '暂不可播放' : undefined}
                    />
                  </li>
                ))}
              </ul>
            </div>
          ))}

          {isPending && lines.length === 0 ? <LoadingSpinner label="加载分集…" /> : null}
          {isPending && lines.length > 0 ? <LoadingSpinner label="加载更多分集…" /> : null}

          {!isPending && nextCursor !== null ? (
            <div>
              <Button
                size="sm"
                variant="outline"
                onPress={() => {
                  setCursor(nextCursor);
                }}
              >
                加载更多
              </Button>
            </div>
          ) : null}
        </>
      ) : null}
    </section>
  );
}
