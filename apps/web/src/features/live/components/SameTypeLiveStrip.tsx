import type { ReactNode } from 'react';
import { Button } from '@heroui/react';
import { Play } from 'lucide-react';
import type { ChannelRowDto } from '@hmp/shared';
import { useRelatedLiveChannels } from '../hooks/use-related-live-channels';
import { ChannelLogo } from './channel-logo';
import { MediaScroller } from './MediaScroller';

/**
 * 同类型直播推荐横条(T015「sam type live」;015 contracts/ui-layout.md §4.2 第 3 条、
 * api-reuse.md「同类直播推荐 (Screen 4)」行、data-model.md §2.3 sameTypeLiveChannels):
 *
 * - 数据:内部用 useRelatedLiveChannels({groupKey, activeChannelId})(T003 交付)——
 *   props 保持薄面(groupKey + activeChannelId + 回调),取数/缓存/排除策略全部归 Hook:
 *   section=group&groupKey 复用既有公共端点(30s 缓存,activeChannelId 换台仅本地过滤
 *   不重发请求);groupKey undefined(频道无分组归属/元数据未就绪)零请求空 ready 态;
 * - 卡片刻意**不复用 ChannelTile**(避免与 US1 对 ChannelTile 的并行改动耦合):
 *   HeroUI Button 轻量瓦片 = 频道名 + posterRef Logo(复用 channel-logo.tsx,接口适配;
 *   posterRef null 回退首字,与 ChannelLogo 装饰层同观感)+ 当前节目标题 + 播放语义
 *   (lucide Play 图标 + aria「切换到 <频道名>」)。点击经 onSwitch(mediaId, title)
 *   交宿主编排就地换台(T017 Hook),本组件不做任何路由/播放状态机副作用;
 * - 横向滚动复用 MediaScroller(溢出限于行内,整页无横向滚动,ui.md §8);
 * - 加载/空/失败态优雅降级:数据未就绪(loading/error/空/无分组)整条隐藏
 *   (data-model 边角「同类型直播为空 → 自动隐藏,不产生空白死角」),不渲染骨架占位,
 *   不阻塞页面其余区域;失败重试由 Hook 的 retry 能力承接(下轮公共刷新兜底)。
 */

export interface SameTypeLiveStripProps {
  /** 当前频道所属分组 groupKey(页面由频道元数据派生;undefined = 不取数、整条隐藏) */
  readonly groupKey: string | undefined;
  /** 当前播放频道 media id(Hook 内精确排除其自身;null = 无需排除) */
  readonly activeChannelId: string | null;
  /** 切台回调(mediaId + 频道名;title 供宿主 play 意图使用,拿不到时宿主自行兜底) */
  readonly onSwitch: (mediaId: string, title: string | null) => void;
}

/** 频道标识底板渐变(语义 token;与 ChannelTile 同一视觉语言,常量角度不引入散列逻辑) */
const PLATE_GRADIENT =
  'linear-gradient(135deg, var(--surface-secondary) 0%, var(--surface-tertiary) 55%, var(--surface) 100%)';

/** 单张同类频道卡(轻量瓦片;整卡为「切换到 <频道名>」按钮,播放语义) */
function SameTypeCard({ row, onSwitch }: { readonly row: ChannelRowDto; readonly onSwitch: SameTypeLiveStripProps['onSwitch'] }): ReactNode {
  const channelTitle = row.media.title;
  const posterRef = row.media.posterRef;
  return (
    <Button
      variant="ghost"
      aria-label={`切换到 ${channelTitle}`}
      onPress={() => {
        onSwitch(row.media.id, channelTitle);
      }}
      className="h-auto w-full flex-col items-stretch gap-0 overflow-hidden rounded-xl border border-border bg-surface p-0 text-start transition duration-200 hover:-translate-y-0.5 hover:border-accent/40 focus-visible:border-accent/40"
    >
      {/* 16:9 频道标识底板(ChannelLogo 为 absolute inset-0 装饰层,宿主容器须 relative;
          posterRef null 时组件不渲染任何节点,由本处首字回退补位 —— 名称不缺位) */}
      <span
        aria-hidden="true"
        className="relative block aspect-video w-full overflow-hidden rounded-t-xl"
        style={{ background: PLATE_GRADIENT }}
      >
        {posterRef !== null ? (
          <ChannelLogo
            posterRef={posterRef}
            channelTitle={channelTitle}
            fallbackClassName="text-3xl font-semibold text-muted"
          />
        ) : (
          <span className="absolute inset-0 flex select-none items-center justify-center text-3xl font-semibold text-muted">
            {channelTitle.slice(0, 1)}
          </span>
        )}
        {/* 状态标注(红点 + 文字,状态不只靠颜色;与 ChannelTile 状态签同语言) */}
        <span className="absolute left-2 top-2 inline-flex items-center gap-1 rounded-sm bg-background/75 px-1.5 py-0.5 text-xs text-foreground backdrop-blur-sm">
          <span aria-hidden="true" className="size-1.5 rounded-full bg-accent" />
          正在直播
        </span>
        {/* 播放语义图标(装饰节点;可读名由按钮 aria-label 承担) */}
        <Play aria-hidden="true" className="absolute bottom-2 right-2 size-5 fill-current text-accent" />
      </span>
      {/* 信息区:频道名 + 当前节目标题(信息只读展示,点击即换台) */}
      <span className="flex min-w-0 flex-col gap-1 p-3">
        <span className="hmp-truncate min-w-0 text-sm font-semibold text-foreground">{channelTitle}</span>
        <span className="hmp-truncate min-w-0 text-xs text-muted">
          {row.current !== null ? `正在播:${row.current.title}` : '正在播:暂无节目单'}
        </span>
      </span>
    </Button>
  );
}

export function SameTypeLiveStrip({ groupKey, activeChannelId, onSwitch }: SameTypeLiveStripProps): ReactNode {
  const resource = useRelatedLiveChannels({ groupKey, activeChannelId });
  const channels = resource.data;
  // 加载/失败/空/无分组:整条优雅隐藏(不产生空白死角;见组件头注)
  if (channels === null || channels.length === 0) {
    return null;
  }
  return (
    <section aria-label="同类型直播" data-testid="same-type-live-strip" className="flex min-w-0 flex-col gap-3">
      <h2 className="text-lg font-semibold text-foreground">同类型直播</h2>
      <MediaScroller label="同类型直播">
        {channels.map((row) => (
          <li key={row.media.id} className="w-56 shrink-0 snap-start sm:w-60">
            <SameTypeCard row={row} onSwitch={onSwitch} />
          </li>
        ))}
      </MediaScroller>
    </section>
  );
}
