import type { ReactNode } from 'react';
import type { ChannelPageDto, GroupPageDto } from '@hmp/shared';
import { Button } from '@heroui/react';
import { ChannelTile } from './ChannelTile';
import { MediaScroller } from './MediaScroller';
import { SectionFrame } from './SectionFrame';
import { formatZoneLabel } from '../live-format';
import type { LiveResource } from '../hooks/use-live-sections';

/**
 * 各来源主分组正在直播(T067/T070;FR-021 顺序第四区、FR-023「缺失归入其他」):
 * - Netflix 式分组行:一次 section=all 集合请求,前端按 ChannelRow.groupKey 分行展示
 *   (不按标题臆测类型),每分组一条横向滚动瓦片行;
 * - 每分组行头右侧「查看更多」进入该分组聚焦视图(URL section=group&group=…);
 * - 无节目可用频道按频道行照常出现(暂无节目占位),不把无节目等同无频道(FR-023)。
 */

/** 概览区每组预览频道数(横向行内可滚动浏览;完整列表经查看更多) */
export const GROUP_PREVIEW_COUNT = 10;

export interface GroupSectionsProps {
  readonly groupsResource: LiveResource<GroupPageDto>;
  readonly channelsResource: LiveResource<ChannelPageDto>;
  readonly focusedGroupKey: string | null;
  readonly onRetry: () => void;
  readonly onViewMore: (groupKey: string) => void;
  readonly onOpenProgramme: Parameters<typeof ChannelTile>[0]['onOpenProgramme'];
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
        skeletonVariant="row"
        skeletonCount={3}
        onRetry={onRetry}
        headerAction={
          rows.length > preview.length ? (
            <Button
              size="sm"
              variant="ghost"
              onPress={() => {
                onViewMore(groupKey);
              }}
            >
              查看更多 ›
            </Button>
          ) : null
        }
      >
        {preview.length > 0 ? (
          <MediaScroller label={`${label} · 正在直播`}>
            {preview.map((row) => (
              <li key={row.media.id} className="w-60 shrink-0 snap-start sm:w-64 lg:w-72">
                <ChannelTile
                  row={row}
                  timezone={channels?.timezone ?? 'UTC'}
                  nowIso={channels?.now ?? null}
                  onOpenProgramme={onOpenProgramme}
                  onRequireAuth={onRequireAuth}
                />
              </li>
            ))}
          </MediaScroller>
        ) : null}
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
