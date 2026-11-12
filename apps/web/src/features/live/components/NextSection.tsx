import type { ReactNode } from 'react';
import type { ChannelPageDto } from '@hmp/shared';
import { Button } from '@heroui/react';
import { ChannelTile } from './ChannelTile';
import { MediaScroller } from './MediaScroller';
import { SectionFrame } from './SectionFrame';
import type { LiveResource } from '../hooks/use-live-sections';

/**
 * 即将播放分区(T067;FR-021 顺序第三区):
 * - Netflix 式横向瓦片行:section=next 首页(20 项,不施加 2 小时窗口限制,ui.md §5),
 *   「查看更多」于行头右侧进入聚焦视图;
 * - 卡片承载 upcoming 档位:信息区展示下一档节目名(点击仅展示节目时段详情,
 *   频道与起止时间,FR-024,详见共享 shared-programme/ProgrammeDetailPanel 面板宿主)。
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
      status={resource.status}
      hasStaleContent={data !== null}
      isEmpty={data !== null && items.length === 0}
      emptyText="暂无即将播放的节目"
      skeletonVariant="row"
      skeletonCount={5}
      onRetry={onRetry}
      headerAction={
        data !== null && data.total > items.length ? (
          <Button size="sm" variant="ghost" onPress={onViewMore}>
            {`查看更多(共 ${data.total} 个频道) ›`}
          </Button>
        ) : null
      }
    >
      {items.length > 0 ? (
        <MediaScroller label="即将播放">
          {items.map((row) => (
            <li key={row.media.id} className="w-60 shrink-0 snap-start sm:w-64 lg:w-72">
              <ChannelTile
                row={row}
                slot="upcoming"
                nowIso={data?.now ?? null}
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
