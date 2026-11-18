import type { ReactNode } from 'react';
import type { ChannelPageDto } from '@hmp/shared';
import { Button } from '@heroui/react';
import { ArrowRight } from 'lucide-react';
import { ChannelTile, LIVE_TILE_WIDTH_CLASS } from './ChannelTile';
import { MediaScroller } from './MediaScroller';
import { SectionFrame } from './SectionFrame';
import type { LiveResource } from '../hooks/use-live-sections';

/**
 * 正在直播分区(T067;FR-021 顺序第二区、A-007 排序由服务端承担):
 * - 2026-11-18 呈现调整:标题行 = 绿色直播点 + 「正在直播」+ 频道总数,行尾
 *   「查看全部 →」直达 EPG 节目单墙;
 * - 横向瓦片行保留左右滑动入口(MediaScroller):1519 宽一屏约 6 张,
 *   超出部分用行内左右箭头翻页,整页不横向溢出;卡片自带当前节目进度条;
 * - 每区独立加载/空/失败状态(SectionFrame)。
 */

export interface NowSectionProps {
  readonly resource: LiveResource<ChannelPageDto>;
  readonly onRetry: () => void;
  readonly onViewMore: () => void;
  readonly onOpenProgramme: Parameters<typeof ChannelTile>[0]['onOpenProgramme'];
  readonly onRequireAuth: (actionLabel: string) => void;
}

export function NowSection({ resource, onRetry, onViewMore, onOpenProgramme, onRequireAuth }: NowSectionProps): ReactNode {
  const data = resource.data;
  const items = data?.items ?? [];
  return (
    <SectionFrame
      title="正在直播"
      titleAdornment={<span aria-hidden="true" className="size-2 shrink-0 rounded-full bg-success" />}
      subtitle={data !== null ? `${String(data.total)} 个频道` : undefined}
      subtitleInline
      status={resource.status}
      hasStaleContent={data !== null}
      isEmpty={data !== null && items.length === 0}
      emptyText="暂无正在直播的节目"
      skeletonVariant="row"
      skeletonCount={6}
      onRetry={onRetry}
      headerAction={
        data !== null ? (
          <Button
            size="sm"
            variant="ghost"
            className="h-auto gap-1 px-1 py-0.5 text-xs font-normal text-muted"
            onPress={onViewMore}
          >
            查看全部
            <ArrowRight aria-hidden="true" className="size-3.5" />
          </Button>
        ) : null
      }
    >
      {items.length > 0 ? (
        <MediaScroller label="正在直播">
          {items.map((row) => (
            <li key={row.media.id} className={LIVE_TILE_WIDTH_CLASS}>
              <ChannelTile
                row={row}
                slot="current"
                nowIso={data?.now ?? null}
                timezone={data?.timezone}
                onOpenProgramme={onOpenProgramme}
                onRequireAuth={onRequireAuth}
              />
            </li>
          ))}
        </MediaScroller>
      ) : null}
    </SectionFrame>
  );
}