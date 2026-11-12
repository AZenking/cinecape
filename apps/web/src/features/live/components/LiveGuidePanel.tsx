/**
 * 播放器内「正在直播」节目单面板(切台器)。
 *
 * 产品语义:直播控制栏上的 icon 在**播放器内部**呼出全频道当前节目列表 ——
 * 每行 = 频道 + 当前节目 + 时段 + **实时播出进度**,点击行即切到该频道
 * (快速切台,不需要退出播放器再去频道页找)。
 *
 * 数据与时间:
 * - 复用公共分区接口 `GET /public/live/channels?section=now`(与直播首页同一
 *   事实源,含 current/next 与响应快照 now/timezone);
 * - 进度以服务端基准钟 useServerNow 每 15s tick 推进(禁止裸 Date.now(),
 *   未校准回落响应快照 now),与 EPG 墙/直播首页同一时钟纪律;
 * - 打开面板时才取数(enabled=open),关闭不占请求;staleTime 走公共缓存。
 *
 * 交互/无障碍:
 * - 面板为播放器内的非模态覆盖层(role="dialog" + aria-label),不拦截视频播放;
 * - 行是原生 button:aria-label 含频道、节目、时段与进度百分比(不只靠颜色);
 * - 键盘:Tab 进入、Enter 切换,Esc 关闭(宿主监听);当前频道行标记「当前」。
 */
import { useCallback, useMemo, type ReactNode } from 'react';
import { Button, Skeleton } from '@heroui/react';
import { X } from 'lucide-react';
import type { ChannelPageDto, ChannelRowDto } from '@hmp/shared';
import { useAppQuery } from '../../../shared/query/hooks';
import { queryKeys } from '../../../shared/query/keys';
import { fetchLiveChannels } from '../live-api';
import { formatRangeInZone, formatTimeInZone } from '../live-format';
import { ChannelLogo } from './channel-logo';
import { useServerNow } from '../../../shared/time/use-server-now';

/** 面板一次拉取的频道数(切台器首屏足够;超出由后续分页/滚动扩展) */
const GUIDE_PAGE_SIZE = 30;

export interface LiveGuidePanelProps {
  readonly open: boolean;
  readonly onClose: () => void;
  /** 当前正在播放的频道 mediaId(行内标记「当前」,不重复切换) */
  readonly currentChannelId?: string | null;
  /** 点击某频道当前节目:切到该频道(宿主统一经 usePlayAction) */
  readonly onZap: (mediaId: string, title: string) => void;
}

interface LiveGuideRowProps {
  readonly row: ChannelRowDto;
  readonly nowMs: number;
  readonly timezone: string;
  readonly isCurrent: boolean;
  readonly onZap: (mediaId: string, title: string) => void;
}

function LiveGuideRow({ row, nowMs, timezone, isCurrent, onZap }: LiveGuideRowProps): ReactNode {
  const programme = row.current;
  const channelTitle = row.media.title;
  const startMs = programme !== null ? Date.parse(programme.startsAt) : NaN;
  const endMs = programme !== null ? Date.parse(programme.endsAt) : NaN;
  const hasWindow = Number.isFinite(startMs) && Number.isFinite(endMs) && endMs > startMs;
  const progress = hasWindow ? Math.min(100, Math.max(0, ((nowMs - startMs) / (endMs - startMs)) * 100)) : 0;
  const rangeLabel = programme !== null ? formatRangeInZone(programme.startsAt, programme.endsAt, timezone) : '';

  return (
    <button
      type="button"
      aria-label={
        programme !== null
          ? `切换到 ${channelTitle},当前节目 ${programme.title},${rangeLabel},已播出 ${Math.round(progress)}%${isCurrent ? ',当前频道' : ''}`
          : `切换到 ${channelTitle}${isCurrent ? ',当前频道' : ''}`
      }
      aria-current={isCurrent ? 'true' : undefined}
      onClick={() => {
        if (!isCurrent) {
          onZap(row.media.id, channelTitle);
        }
      }}
      className={`flex w-full flex-col gap-1 rounded-md border px-2 py-1.5 text-start transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-focus ${
        isCurrent
          ? 'border-accent/60 bg-accent/10'
          : 'border-transparent hover:border-border hover:bg-surface-secondary/60'
      }`}
    >
      <span className="flex items-center gap-2">
        <span aria-hidden="true" className="relative inline-flex size-6 shrink-0 items-center justify-center overflow-hidden rounded-sm">
          {row.media.posterRef !== null ? (
            <ChannelLogo
              key={row.media.posterRef}
              posterRef={row.media.posterRef}
              channelTitle={channelTitle}
              fallbackClassName="text-[10px] font-black leading-none text-foreground/30"
            />
          ) : (
            <span className="text-[10px] font-bold text-muted">{channelTitle.slice(0, 1).toUpperCase()}</span>
          )}
        </span>
        <span className="hmp-truncate min-w-0 flex-1 text-xs font-medium text-foreground" title={channelTitle}>
          {channelTitle}
        </span>
        {isCurrent ? (
          <span className="shrink-0 rounded-xs bg-accent/20 px-1 text-[10px] font-semibold text-accent">当前</span>
        ) : null}
        {programme !== null ? (
          <span className="hmp-tabular-nums shrink-0 text-[10px] text-muted">{formatTimeInZone(programme.startsAt, timezone)}</span>
        ) : null}
      </span>
      <span className="hmp-truncate min-w-0 text-[11px] text-muted" title={programme?.title ?? '暂无节目'}>
        {programme?.title ?? '暂无节目'}
      </span>
      {hasWindow ? (
        <span aria-hidden="true" className="mt-0.5 h-0.5 w-full overflow-hidden rounded-full bg-surface-tertiary">
          <span className="block h-full rounded-full bg-accent" style={{ width: `${progress}%` }} />
        </span>
      ) : null}
    </button>
  );
}

export function LiveGuidePanel({ open, onClose, currentChannelId = null, onZap }: LiveGuidePanelProps): ReactNode {
  // 关闭态不挂载查询体:面板未打开时零请求,且宿主(PlayerView)不因本组件
  // 依赖 QueryClient 而改变挂载前提(单测可在无 Provider 下直挂播放器)
  if (!open) {
    return null;
  }
  return <LiveGuidePanelBody onClose={onClose} currentChannelId={currentChannelId} onZap={onZap} />;
}

interface LiveGuidePanelBodyProps {
  readonly onClose: () => void;
  readonly currentChannelId: string | null;
  readonly onZap: (mediaId: string, title: string) => void;
}

function LiveGuidePanelBody({ onClose, currentChannelId, onZap }: LiveGuidePanelBodyProps): ReactNode {
  const { nowMs: tickingNowMs } = useServerNow();
  const resource = useAppQuery<ChannelPageDto>({
    domain: 'public',
    queryKey: queryKeys.public.liveChannels({ section: 'now', page: 1, pageSize: GUIDE_PAGE_SIZE }),
    queryFn: ({ signal }) => fetchLiveChannels({ section: 'now', page: 1, pageSize: GUIDE_PAGE_SIZE }, signal),
  });

  const page = resource.data;
  const nowMs = tickingNowMs ?? (page !== undefined ? Date.parse(page.now) : null);
  const timezone = page?.timezone ?? 'UTC';

  const handleZap = useCallback(
    (mediaId: string, title: string): void => {
      onZap(mediaId, title);
      onClose();
    },
    [onZap, onClose],
  );

  const rows = useMemo(() => page?.items ?? [], [page]);

  return (
    <div
      role="dialog"
      aria-label="正在直播节目单"
      data-testid="live-guide-panel"
      className="absolute end-2 top-2 bottom-2 z-30 flex w-72 max-w-[85%] flex-col overflow-hidden rounded-lg border border-border/70 bg-surface/95 shadow-xl backdrop-blur-md"
    >
      <div className="flex shrink-0 items-center justify-between gap-2 border-b border-border/60 px-3 py-2">
        <span className="text-sm font-semibold text-foreground">正在直播</span>
        <Button size="sm" variant="ghost" isIconOnly aria-label="关闭节目单" onPress={onClose}>
          <X aria-hidden="true" className="size-4" />
        </Button>
      </div>
      <div className="flex min-h-0 flex-1 flex-col gap-1 overflow-y-auto p-2">
        {resource.isPending && page === undefined ? (
          <div className="flex flex-col gap-1" aria-hidden="true">
            {Array.from({ length: 6 }, (_, index) => (
              <Skeleton key={index} className="h-12 w-full rounded-md" />
            ))}
          </div>
        ) : page === undefined || nowMs === null ? (
          <p className="px-1 py-2 text-xs text-muted">节目单加载失败,可稍后重试。</p>
        ) : rows.length === 0 ? (
          <p className="px-1 py-2 text-xs text-muted">当前没有正在直播的频道。</p>
        ) : (
          rows.map((row) => (
            <LiveGuideRow
              key={row.media.id}
              row={row}
              nowMs={nowMs}
              timezone={timezone}
              isCurrent={currentChannelId !== null && row.media.id === currentChannelId}
              onZap={handleZap}
            />
          ))
        )}
      </div>
    </div>
  );
}