import type { ReactNode } from 'react';
import type { ChannelPageDto, GroupPageDto } from '@hmp/shared';
import { Button } from '@heroui/react';
import { ChannelTile } from './ChannelTile';
import { MediaScroller } from './MediaScroller';
import { SectionFrame } from './SectionFrame';
import { formatZoneLabel } from '../live-format';
import type { LiveResource } from '../hooks/use-live-sections';

/**
 * 「展示各个分类」逐行平铺泳道(015 T009;FR-004、FR-005、FR-001 布局第四段;
 * spec.md US1 验收场景 2、research.md R1 泳道 3~N、ui-layout.md §1.1 线框):
 *
 * - 数据沿用 012 GroupSections 的既有取数模式(零 N+1):一次 section=all 集合
 *   请求(资源由宿主 LivePage 下发),前端按 ChannelRow.groupKey 分行展示
 *   (不按标题臆测类型);分组清单 = fetchLiveGroups(仅 {key,label}),分组顺序
 *   以服务端分组列表为准,无对应频道的分组照常出空态行(不把空组当无分组);
 * - 每行 = SectionFrame(四态:加载骨架/空/失败可重试/正常)+ MediaScroller 横滑
 *   (溢出限于行内,ui.md §8),频道卡复用 ChannelTile(slot='current',
 *   Hover ▶ 一键起播由 T004 双层交互承担);
 * - 行尾 [全部XX频道 ›](FR-004 MUST):经 onViewAll 回调导出,宿主 LivePage 接
 *   navigate(`/live/channels?group=${key}`)(该路由由 Wave 3 注册,注册前跳转
 *   暂 404 属预期中间态,routing-and-url-state.md §2.2);
 * - props 与 NowSection 同风格尽量薄:资源/回调由宿主下发,本组件不做取数;
 * - 失败聚合:分组或频道集合任一失败由外层框架呈现整块错误(内层行不再逐行
 *   重复报警),保持 012 外层框架四态先例;后台刷新失败(有旧数据)显示更新横条。
 */

/** 概览区每组预览频道数(横向行内滚动浏览;完整列表经行尾「全部XX频道」入口) */
export const CATEGORY_PREVIEW_COUNT = 10;

export interface CategorySwimlanesProps {
  readonly groupsResource: LiveResource<GroupPageDto>;
  readonly channelsResource: LiveResource<ChannelPageDto>;
  readonly onRetry: () => void;
  /** 行尾「全部XX频道」:宿主接 /live/channels?group=:key(015 Screen 2 分流) */
  readonly onViewAll: (groupKey: string) => void;
  readonly onOpenProgramme: Parameters<typeof ChannelTile>[0]['onOpenProgramme'];
  readonly onRequireAuth: (actionLabel: string) => void;
}

export function CategorySwimlanes({
  groupsResource,
  channelsResource,
  onRetry,
  onViewAll,
  onOpenProgramme,
  onRequireAuth,
}: CategorySwimlanesProps): ReactNode {
  const groups = groupsResource.data;
  const channels = channelsResource.data;
  const zoneLabel = channels !== null ? formatZoneLabel(channels.timezone, channels.now) : undefined;
  // 分行索引:同组频道的「其他」归属与后端 groupKey 一致(全部频道集合,含无节目频道)
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
    const preview = rows.slice(0, CATEGORY_PREVIEW_COUNT);
    return (
      <SectionFrame
        key={groupKey}
        title={`${label} · 正在直播`}
        subtitle={`${rows.length} 个可用频道`}
        status={channelsResource.status}
        hasStaleContent={channels !== null}
        isEmpty={preview.length === 0}
        emptyText="该分类暂无可用频道"
        skeletonVariant="row"
        skeletonCount={3}
        onRetry={onRetry}
        /* 行尾入口 FR-004 MUST:分类泳道末尾必有「查看全部」,无条件渲染
           (区别于 012「仅溢出行显示查看更多」;完整列表在分类网格页) */
        headerAction={
          <Button
            size="sm"
            variant="ghost"
            onPress={() => {
              onViewAll(groupKey);
            }}
          >
            {`全部${label}频道 ›`}
          </Button>
        }
      >
        {preview.length > 0 ? (
          <MediaScroller label={`${label} · 正在直播`}>
            {preview.map((row) => (
              <li key={row.media.id} className="w-60 shrink-0 snap-start sm:w-64 lg:w-72">
                <ChannelTile
                  row={row}
                  slot="current"
                  nowIso={channels?.now ?? null}
                  timezone={channels?.timezone}
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
      title="各分类正在直播"
      subtitle={zoneLabel !== undefined ? `时间按家庭时区 ${zoneLabel} 显示` : undefined}
      status={groupsResource.status === 'error' || channelsResource.status === 'error' ? 'error' : 'ready'}
      hasStaleContent={channels !== null || groups !== null}
      isEmpty={groups !== null && groups.items.length === 0}
      emptyText="暂无可用频道分类"
      skeletonCount={4}
      onRetry={onRetry}
    >
      <div className="flex flex-col gap-8">
        {groups !== null && groupsResource.status === 'ready'
          ? groups.items.map((group) => renderGroup(group.key, group.label, byKey.get(group.key)?.rows ?? []))
          : null}
      </div>
    </SectionFrame>
  );
}
