import type { ReactNode } from 'react';
import type { ChannelPageDto } from '@hmp/shared';
import { Button } from '@heroui/react';
import { ProgrammeCard } from './ProgrammeCard';
import { SectionFrame } from './SectionFrame';
import { formatZoneLabel } from '../live-format';
import type { LiveResource } from '../hooks/use-live-sections';

/**
 * 正在直播分区(T067;FR-021 顺序第二区、A-007 排序由服务端承担):
 * - 展示 section=now 首页(20 项)+「查看更多」进入聚焦视图(URL section=now,可分页);
 * - 每区独立加载/空/失败状态(失败仅重试本区,SectionFrame)。
 */

export interface NowSectionProps {
  readonly resource: LiveResource<ChannelPageDto>;
  readonly onRetry: () => void;
  readonly onViewMore: () => void;
  readonly onOpenProgramme: Parameters<typeof ProgrammeCard>[0]['onOpenProgramme'];
  readonly onRequireAuth: (actionLabel: string) => void;
}

export function NowSection({ resource, onRetry, onViewMore, onOpenProgramme, onRequireAuth }: NowSectionProps): ReactNode {
  const data = resource.data;
  const zoneLabel = data !== null ? formatZoneLabel(data.timezone, data.now) : undefined;
  return (
    <SectionFrame
      title="正在直播"
      subtitle={zoneLabel !== undefined ? `时间按家庭时区 ${zoneLabel} 显示` : undefined}
      status={resource.status}
      hasStaleContent={data !== null}
      isEmpty={data !== null && data.items.length === 0}
      emptyText="暂无正在直播的节目"
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
