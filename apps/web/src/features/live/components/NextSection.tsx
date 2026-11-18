import type { ReactNode } from 'react';
import type { ChannelPageDto } from '@hmp/shared';
import { Button } from '@heroui/react';
import { ArrowRight } from 'lucide-react';
import { ChannelTile, LIVE_TILE_WIDTH_CLASS } from './ChannelTile';
import { MediaScroller } from './MediaScroller';
import { SectionFrame } from './SectionFrame';
import type { LiveResource } from '../hooks/use-live-sections';

/**
 * 即将播放分区(T067;FR-021 顺序第三区):
 * - 2026-11-18 呈现调整:标题行 = 「即将播放」+ 副标「精彩稍后继续」,行尾
 *   「完整节目单 →」直达 EPG 节目单墙;
 * - 横向瓦片行保留左右滑动入口(MediaScroller),1519 宽一屏约 6 张;卡片承载
 *   下一档节目(点击进节目详情,不拉起播放器,FR-024),右上角显示开播时刻。
 */

export interface NextSectionProps {
  readonly resource: LiveResource<ChannelPageDto>;
  readonly onRetry: () => void;
  readonly onViewMore: () => void;
  readonly onOpenProgramme: Parameters<typeof ChannelTile>[0]['onOpenProgramme'];
  readonly onRequireAuth: (actionLabel: string) => void;
}

export function NextSection({ resource, onRetry, onViewMore, onOpenProgramme, onRequireAuth }: NextSectionProps): ReactNode {
  const data = resource.data;
  const items = data?.items ?? [];
  return (
    <SectionFrame
      title="即将播放"
      subtitle="精彩稍后继续"
      subtitleInline
      status={resource.status}
      hasStaleContent={data !== null}
      isEmpty={data !== null && items.length === 0}
      emptyText="暂无即将播放的节目"
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
            完整节目单
            <ArrowRight aria-hidden="true" className="size-3.5" />
          </Button>
        ) : null
      }
    >
      {items.length > 0 ? (
        <MediaScroller label="即将播放">
          {items.map((row) => (
            <li key={row.media.id} className={LIVE_TILE_WIDTH_CLASS}>
              <ChannelTile
                row={row}
                slot="upcoming"
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