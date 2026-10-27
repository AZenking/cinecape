import type { ReactNode } from 'react';
import type { ChannelPageDto } from '@hmp/shared';
import { Button } from '@heroui/react';
import { ChannelTile } from './ChannelTile';
import { SectionFrame } from './SectionFrame';
import { formatZoneLabel } from '../live-format';
import type { LiveResource } from '../hooks/use-live-sections';

/**
 * 聚焦分区视图(T067;FR-045「详情返回或登录取消后恢复」):
 * - URL 携带 section(必配 group/page/q)时仅渲染该区,带上一页/下一页分页;
 * - 与概览行共用同一瓦片卡(ChannelTile),此处以自适应瓦片网格承载
 *   「查看更多」的全量分页浏览(Netflix「查看全部」网格页的对应形态);
 * - 「返回全部分区」清除 section 参数回到总览;排序/过滤全部由服务端承担。
 */

const SECTION_TITLES = {
  now: '正在直播',
  next: '即将播放',
  group: '分组频道',
  all: '全部频道',
} as const;

export interface FocusedSectionProps {
  readonly sectionTitle: string;
  readonly resource: LiveResource<ChannelPageDto>;
  readonly page: number;
  readonly onPageChange: (page: number) => void;
  readonly onExit: () => void;
  readonly onRetry: () => void;
  readonly onOpenProgramme: Parameters<typeof ChannelTile>[0]['onOpenProgramme'];
  readonly onRequireAuth: (actionLabel: string) => void;
}

export function FocusedSection({
  sectionTitle,
  resource,
  page,
  onPageChange,
  onExit,
  onRetry,
  onOpenProgramme,
  onRequireAuth,
}: FocusedSectionProps): ReactNode {
  const data = resource.data;
  const totalPages = data !== null && data.pageSize > 0 ? Math.max(1, Math.ceil(data.total / data.pageSize)) : 1;
  const zoneLabel = data !== null ? formatZoneLabel(data.timezone, data.now) : undefined;
  return (
    <SectionFrame
      title={sectionTitle}
      subtitle={
        zoneLabel !== undefined
          ? `时间按家庭时区 ${zoneLabel} 显示 · 第 ${data?.page ?? page} / ${totalPages} 页`
          : undefined
      }
      status={resource.status}
      hasStaleContent={data !== null}
      isEmpty={data !== null && data.items.length === 0}
      emptyText="暂无节目"
      skeletonCount={8}
      onRetry={onRetry}
      footer={
        <div className="mt-4 flex flex-wrap items-center gap-2">
          <Button size="sm" variant="ghost" onPress={onExit}>
            返回全部分区
          </Button>
          <Button
            size="sm"
            variant="outline"
            isDisabled={data === null || (data.page ?? page) <= 1}
            onPress={() => {
              onPageChange(Math.max(1, (data?.page ?? page) - 1));
            }}
          >
            上一页
          </Button>
          <Button
            size="sm"
            variant="outline"
            isDisabled={data === null || (data.page ?? page) >= totalPages}
            onPress={() => {
              onPageChange((data?.page ?? page) + 1);
            }}
          >
            下一页
          </Button>
          <span className="text-xs text-muted" aria-live="polite">
            {data !== null ? `共 ${data.total} 个频道` : ''}
          </span>
        </div>
      }
    >
      <div className="grid grid-cols-[repeat(auto-fill,minmax(280px,1fr))] gap-4">
        {(data?.items ?? []).map((row) => (
          <ChannelTile
            key={row.media.id}
            row={row}
            timezone={data?.timezone ?? 'UTC'}
            nowIso={data?.now ?? null}
            onOpenProgramme={onOpenProgramme}
            onRequireAuth={onRequireAuth}
          />
        ))}
      </div>
    </SectionFrame>
  );
}

/** 分区标题(供 LivePage 使用) */
export function sectionTitleOf(section: 'now' | 'next' | 'group' | 'all', groupLabel?: string): string {
  if (section === 'group' && groupLabel !== undefined) {
    return `${groupLabel} · 正在直播`;
  }
  return SECTION_TITLES[section];
}
