import type { ReactNode } from 'react';
import type { ChannelPageDto, GroupPageDto } from '@hmp/shared';
import { Button } from '@heroui/react';
import { ProgrammeCard } from './ProgrammeCard';
import { SectionFrame } from './SectionFrame';
import { formatZoneLabel } from '../live-format';
import type { LiveResource } from '../hooks/use-live-sections';

/**
 * 各来源主分组正在直播(T067/T070;FR-021 顺序第四区、FR-023「缺失归入其他」):
 * - 一次 section=all 集合请求,前端按 ChannelRow.groupKey 分区展示(不按标题臆测类型);
 * - 每分组预览若干频道 +「查看更多」进入该分组聚焦视图(URL section=group&group=…);
 * - 无节目可用频道按频道行照常出现(暂无节目占位),不把无节目等同无频道(FR-023)。
 */

/** 概览区每组预览频道数(完整列表经查看更多) */
export const GROUP_PREVIEW_COUNT = 4;

export interface GroupSectionsProps {
  readonly groupsResource: LiveResource<GroupPageDto>;
  readonly channelsResource: LiveResource<ChannelPageDto>;
  readonly focusedGroupKey: string | null;
  readonly onRetry: () => void;
  readonly onViewMore: (groupKey: string) => void;
  readonly onOpenProgramme: Parameters<typeof ProgrammeCard>[0]['onOpenProgramme'];
  readonly onRequireAuth: (actionLabel: string) => void;
}

export function GroupSections({
  groupsResource,
  channelsResource,
  focusedGroupKey,
  onRetry,
  onViewMore,
  onOpenProgramme,
  onRequireAuth,
}: GroupSectionsProps): ReactNode {
  const groups = groupsResource.data;
  const channels = channelsResource.data;
  const zoneLabel = channels !== null ? formatZoneLabel(channels.timezone, channels.now) : undefined;
  // 分区计数:同组频道的「其他」归属与后端 groupKey 一致(全部频道集合,含无节目频道)
  const items = channels?.items ?? [];
  const byKey = new Map<string, { label: string; rows: typeof items }>();
  for (const row of items) {
    const entry = byKey.get(row.groupKey);
    if (entry === undefined) {
      byKey.set(row.groupKey, { label: row.groupLabel, rows: [row] });
    } else {
      entry.rows.push(row);
    }
  }

  const renderGroup = (groupKey: string, label: string, rows: readonly (typeof items)[number][]): ReactNode => {
    const preview = rows.slice(0, GROUP_PREVIEW_COUNT);
    return (
      <SectionFrame
        key={groupKey}
        title={`${label} · 正在直播`}
        subtitle={`${rows.length} 个可用频道`}
        status={channelsResource.status}
        hasStaleContent={channels !== null}
        isEmpty={preview.length === 0}
        emptyText="该分组暂无可用频道"
        skeletonCount={2}
        onRetry={onRetry}
        footer={
          rows.length > preview.length ? (
            <div className="mt-3">
              <Button size="sm" variant="outline" onPress={() => onViewMore(groupKey)}>
                查看更多
              </Button>
            </div>
          ) : null
        }
      >
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3 2xl:grid-cols-4">
          {preview.map((row) => (
            <ProgrammeCard
              key={row.media.id}
              row={row}
              timezone={channels?.timezone ?? 'UTC'}
              onOpenProgramme={onOpenProgramme}
              onRequireAuth={onRequireAuth}
            />
          ))}
        </div>
      </SectionFrame>
    );
  };

  return (
    <SectionFrame
      title="各分组正在直播"
      subtitle={zoneLabel !== undefined ? `时间按家庭时区 ${zoneLabel} 显示` : undefined}
      status={groupsResource.status === 'error' || channelsResource.status === 'error' ? 'error' : 'ready'}
      hasStaleContent={channels !== null || groups !== null}
      isEmpty={groups !== null && groups.items.length === 0}
      emptyText="暂无可用频道分组"
      skeletonCount={4}
      onRetry={onRetry}
    >
      <div className="flex flex-col gap-8">
        {groups !== null && groupsResource.status === 'ready'
          ? groups.items
              .filter((group) => focusedGroupKey === null || group.key === focusedGroupKey)
              .map((group) => renderGroup(group.key, group.label, byKey.get(group.key)?.rows ?? []))
          : null}
      </div>
    </SectionFrame>
  );
}
