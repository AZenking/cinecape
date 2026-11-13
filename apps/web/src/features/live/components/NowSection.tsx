import type { ReactNode } from 'react';
import type { ChannelPageDto } from '@hmp/shared';
import { Button } from '@heroui/react';
import { ChannelTile } from './ChannelTile';
import { MediaScroller } from './MediaScroller';
import { SectionFrame } from './SectionFrame';
import { formatZoneLabel } from '../live-format';
import type { LiveResource } from '../hooks/use-live-sections';

/**
 * 正在直播分区(T067;FR-021 顺序第二区、A-007 排序由服务端承担):
 * - Netflix 式横向瓦片行:section=now 首页(20 项)横向滚动浏览,
 *   「查看更多」于行头右侧进入聚焦视图(URL section=now,可分页,每区仍可继续查看);
 * - 每区独立加载/空/失败状态(失败仅重试本区,SectionFrame;骨架为瓦片行形态)。
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
  const zoneLabel = data !== null ? formatZoneLabel(data.timezone, data.now) : undefined;
  const items = data?.items ?? [];
  return (
    <SectionFrame
      title="正在直播"
      subtitle={zoneLabel !== undefined ? `时间按家庭时区 ${zoneLabel} 显示` : undefined}
      status={resource.status}
      hasStaleContent={data !== null}
      isEmpty={data !== null && items.length === 0}
      emptyText="暂无正在直播的节目"
      skeletonVariant="row"
      skeletonCount={5}
      onRetry={onRetry}
      headerAction={
        /* 015 T012:行尾「全部正在直播 ›」直达 /live/guide(Screen 3 EPG 节目单墙;
         * contracts/ui-layout.md §1.2 分流入口 + 手稿 Screen 1 Live 行尾入口,
         * 数据就绪即恒显,导航接线由宿主 LivePage 下发) */
        data !== null ? (
          <Button size="sm" variant="ghost" onPress={onViewMore}>
            全部正在直播 ›
          </Button>
        ) : null
      }
    >
      {items.length > 0 ? (
        <MediaScroller label="正在直播">
          {items.map((row) => (
            <li key={row.media.id} className="w-60 shrink-0 snap-start sm:w-64 lg:w-72">
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
