import type { ReactNode } from 'react';
import type { ChannelPageDto } from '@hmp/shared';
import { Button } from '@heroui/react';
import { ProgrammeCard } from './ProgrammeCard';
import { SectionFrame } from './SectionFrame';
import type { LiveResource } from '../hooks/use-live-sections';

/**
 * 即将播放分区(T067;FR-021 顺序第三区):
 * - section=next 首页(20 项,不施加 2 小时窗口限制,ui.md §5)+「查看更多」;
 * - 点击即将播放节目仅展示节目时段详情(频道与起止时间,FR-024,详见 ProgrammeSlotDialog)。
 */

export interface NextSectionProps {
  readonly resource: LiveResource<ChannelPageDto>;
  readonly onRetry: () => void;
  readonly onViewMore: () => void;
  readonly onOpenProgramme: Parameters<typeof ProgrammeCard>[0]['onOpenProgramme'];
  readonly onRequireAuth: (actionLabel: string) => void;
}

export function NextSection({ resource, onRetry, onViewMore, onOpenProgramme, onRequireAuth }: NextSectionProps): ReactNode {
  const data = resource.data;
  return (
    <SectionFrame
      title="即将播放"
      status={resource.status}
      hasStaleContent={data !== null}
      isEmpty={data !== null && data.items.length === 0}
      emptyText="暂无即将播放的节目"
      onRetry={onRetry}
      footer={
        data !== null && data.total > data.items.length ? (
          <div className="mt-3">
            <Button size="sm" variant="outline" onPress={onViewMore}>
              {`查看更多(共 ${data.total} 个频道)`}
            </Button>
          </div>
        ) : null
      }
    >
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3 2xl:grid-cols-4">
        {(data?.items ?? []).map((row) => (
          <ProgrammeCard key={row.media.id} row={row} timezone={data?.timezone ?? 'UTC'} onOpenProgramme={onOpenProgramme} onRequireAuth={onRequireAuth} />
        ))}
      </div>
    </SectionFrame>
  );
}
