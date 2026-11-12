import { useState } from 'react';
import type { ReactNode } from 'react';
import { Tooltip } from '@heroui/react';

/**
 * ChannelIdentityBadge —— 014 实施期呈现修订(维护者指令 2026-11-08,ui.md §1 修订记录):
 * 卡片右上角频道身份角标,取代原「底板大首字」主视觉(ChannelTile/NowHero;接入点应用)。
 *
 * 呈现规则(回退链,FR-007 的修订表达):
 * - posterRef 非空、img 加载中/失败 → 频道名 chip(截断 + HeroUI Tooltip 全名);
 *   img onLoad → Logo 圆角衬底盒淡入(名称退场,互斥观感);
 *   onError → 卸载 img、名称 chip 恢复 —— 身份任一相位不缺位(无裂图/无空白/无错误文案)。
 * - posterRef null → 频道名 chip。
 * - 频道名过长:hmp-truncate 截断 + Tooltip 展全名(HeroUI Tooltip,宪章技术约束 5
 *   「提示」组件走 HeroUI。文档依据:.heroui-docs/react components/(overlays)/tooltip.mdx
 *   与 demos/cn/tooltip/{basic,placement}.tsx,获取日期 2026-11-08,实装 3.2.6)。
 *
 * 结构与定位:
 * - 角标定位由宿主经 className 传入(ChannelTile:`absolute right-2 top-2`;
 *   NowHero:`absolute right-4 top-4 md:right-6 md:top-6`,与其左上状态签对称);
 *   状态签(左上)/进度线(底边)/播放收藏(右下)三区互不重叠。
 * - img `alt=""` + aria-hidden + loading="lazy" + decoding="async"(装饰图层,
 *   可读频道名由卡片信息区承担);名称 chip 可 hover(Tooltip 需要,不设 pointer-events-none)。
 * - ref 变化渲染期重置相位(旧图不残留;同 ref 重渲染零状态变化,不闪变);
 *   HTTP 缓存命中时 img 可能先于 onLoad 完成,ref 回调 complete 兜底(同 ChannelLogo 模式)。
 * - 不做内存缓存:HTTP 缓存交给 api.md §1 的 Cache-Control(max-age=300)。
 *
 * 与 ChannelLogo(小尺寸身份盒:GuideChannelList/personal-area,保留首字回退)的分工:
 * 本组件面向卡片底板的右上角身份角标,回退物是「频道名 chip」而非首字 —— 名称即身份,
 * 大首字主视觉按维护者指令取消。
 */

/** 角标相位:loading=名称 chip 可见 + img 隐形等待;loaded=Logo 淡入、名称退场;error=卸载 img 名称恢复 */
interface BadgePhase {
  /** 相位所属的不透明引用(ref 变化即整体重置,防旧图残留) */
  ref: string | null;
  phase: 'loading' | 'loaded' | 'error';
}

export interface ChannelIdentityBadgeProps {
  /** 直播/目录 DTO 原样回传的不透明引用;null = 恒名称 chip */
  readonly posterRef: string | null;
  /** 频道名:名称 chip 文本与 Tooltip 全名 */
  readonly channelTitle: string;
  /** 角标定位 class(宿主传入;组件内不再叠加 position 类,避免冲突) */
  readonly className?: string;
}

export function ChannelIdentityBadge({
  posterRef,
  channelTitle,
  className,
}: ChannelIdentityBadgeProps): ReactNode {
  const [phase, setPhase] = useState<BadgePhase>(() => ({ ref: posterRef, phase: 'loading' }));
  if (posterRef !== phase.ref) {
    // 渲染期派生重置(React 官方认可的 props→state 调整模式):ref 变化回到 loading,
    // 旧图立即退场;同 ref 重渲染不进入此分支 = 状态稳定不闪变
    setPhase({ ref: posterRef, phase: 'loading' });
  }
  const loaded = posterRef !== null && phase.phase === 'loaded';

  /** 名称 chip:截断 + Tooltip 全名(有 Logo 时仅在加载中/失败相位出现)。
   *  必须显式 Tooltip.Trigger:v3 无 Trigger 包装时不挂任何 hover 事件(实测探针结论)。 */
  const nameChip = (
    <Tooltip delay={0}>
      <Tooltip.Trigger>
        <span
          data-testid="identity-name"
          className="inline-flex max-w-[10rem] cursor-default items-center rounded-sm bg-background/75 px-1.5 py-0.5 text-xs leading-4 text-foreground backdrop-blur-sm"
        >
          <span className="hmp-truncate">{channelTitle}</span>
        </span>
      </Tooltip.Trigger>
      <Tooltip.Content placement="bottom">{channelTitle}</Tooltip.Content>
    </Tooltip>
  );

  /** Logo 衬底盒:圆角 + token 衬底,img object-contain(透明底 PNG 直接呈现,不做图片再处理) */
  const logoChip = (
    <span
      data-testid="identity-logo"
      className="inline-flex h-6 max-w-[8rem] items-center rounded-sm bg-background/75 px-1 backdrop-blur-sm"
    >
      <img
        src={`/api/public/media/logos/${encodeURIComponent(posterRef ?? '')}`}
        alt=""
        aria-hidden="true"
        loading="lazy"
        decoding="async"
        className="max-h-5 w-auto max-w-[7rem] object-contain"
        onLoad={() => {
          setPhase({ ref: posterRef, phase: 'loaded' });
        }}
        onError={() => {
          setPhase({ ref: posterRef, phase: 'error' });
        }}
        ref={(img) => {
          // 缓存即时完成兜底:HTTP 缓存命中时图片可能在本回调前已完成(load 事件丢失),
          // 已完整解码的图直接进入 loaded(同 ChannelLogo 模式)
          if (
            img !== null &&
            img.complete &&
            img.naturalWidth > 0 &&
            (phase.phase === 'loading' || phase.phase !== 'loaded')
          ) {
            setPhase({ ref: posterRef, phase: 'loaded' });
          }
        }}
      />
    </span>
  );

  return (
    <div className={className} data-testid="identity-badge">
      {loaded ? (
        logoChip
      ) : (
        <>
          {nameChip}
          {/* 隐形预载 img:覆盖角标区(opacity-0,pointer-events-none),仅驱动加载相位;
              加载完成切换到 logoChip(可读名信息始终由名称 chip/卡片信息区承担)。
              posterRef 恒非空至此(外层 loaded 分支已判)。 */}
          {posterRef !== null && phase.phase !== 'error' ? (
            <img
              src={`/api/public/media/logos/${encodeURIComponent(posterRef)}`}
              alt=""
              aria-hidden="true"
              loading="lazy"
              decoding="async"
              className="pointer-events-none absolute inset-0 h-full max-h-6 w-full object-contain opacity-0"
              onLoad={() => {
                setPhase({ ref: posterRef, phase: 'loaded' });
              }}
              onError={() => {
                setPhase({ ref: posterRef, phase: 'error' });
              }}
            />
          ) : null}
        </>
      )}
    </div>
  );
}
