import { useState } from 'react';
import type { ReactNode } from 'react';

/**
 * ChannelLogo —— 014 频道 Logo 纯装饰层 + 组件内首字回退层(docs/specs/014-channel-logos/
 * contracts/ui.md §1,T017/T023;接入点 ChannelTile/NowHero/GuideChannelList/
 * personal-area 收藏列表,T018/T019/T026/T027/T028)。
 *
 * 契约状态机(回退链,FR-007/FR-008 的组件化表达):
 * - posterRef === null → 不渲染任何节点:宿主既有「渐变底板 + 频道首字」回退层原样露出
 *   (宿主 posterRef===null 分支零改动 —— ui.md §1 不变量 2、FR-008);
 * - posterRef 非空、img 加载中 → 组件内首字回退层可见(视觉与宿主 null 分支首字一致:
 *   字号/字重/颜色 token 由宿主经 fallbackClassName 逐字传入,组件承担居中/绝对定位),
 *   img 以 opacity-0 等待 —— 加载期间首字不缺位;
 * - img onLoad → img 淡入、首字层同步淡出(互斥观感:任一瞬间首字或 Logo 其一可见,
 *   Logo 覆盖层位于首字层之上 —— DOM 序即绘制序);
 *   prefers-reduced-motion 下由 a11y.css 全局基线(transition-duration 压至 0.01ms)
 *   退化为直接切换,组件不另设媒体查询(与 ChannelTile 悬停过渡同一套用法);
 * - img onError → 卸载 img,首字层恢复 opacity-100(无裂图图标/无错误文案/无占位框,
 *   回退态完整 —— §4-3);容器尺寸任何相位零变化(两层均 absolute inset-0,不参与布局流)。
 *
 * 不变量落地(ui.md §1):
 * 1. 首字层与 img 同居绝对定位装饰层内(inset-0),不参与布局流 → 任何路径零布局位移;
 * 2. posterRef === null 时宿主回退层原样保留,跨刷新稳定不闪变;
 * 3. Logo 呈现后首字 opacity-0 隐藏(互斥观感,spec Edge Cases);
 * 4. 装饰层 pointer-events-none,加载中与失败不阻塞卡片任何操作(§4-4);
 * 5. img `alt=""` + `aria-hidden="true"`(无可读 alt),可读名由宿主容器 aria-label
 *    承担(ChannelTile 现有模式);`loading="lazy"` + `decoding="async"` 异步装饰加载;
 * 6. 不做内存缓存:HTTP 缓存交给 api.md §1 的 Cache-Control;组件状态按 posterRef
 *    稳定 key 复用(渲染期对 ref 变化重置相位,旧图不残留;同 ref 重渲染零状态变化)。
 *
 * HeroUI 文档依据(宪章技术约束 8,获取日期 2026-11-07):查 .heroui-docs/react
 * AGENTS.md 索引(安装基线 @heroui/react 3.2.6),components/(media) 仅提供
 * Avatar/AvatarGroup(avatar.mdx):面向用户头像语义(固定尺寸档位 +
 * fallback-until-ready),不提供「绝对定位装饰层 + 错误即隐形」能力。
 * 偏离记录:HeroUI 未提供错误即隐形的装饰图能力,本组件按 ui.md §1 以原生 <img>
 * 自定义(约束 5 要求的记录面;非交互装饰节点,不触交互组件禁令)。
 *
 * src 说明:api.md §1 服务端路由为 `/public/media/logos/:logoRef`,挂 Nest 全局
 * `api` 前缀(main.ts setGlobalPrefix),浏览器同源 URL 为
 * `/api/public/media/logos/{ref}`;与 010 海报先例
 * (`/api/public/vod/posters/{ref}`,online-search-section.tsx PosterImage)同款,
 * ref 经 encodeURIComponent 原样取回(不透明引用,不含上游地址,FR-004)。
 */

/** Logo 装饰层相位:loading=首字可见 + img 等待;loaded=Logo 淡入覆盖首字;error=卸载 img 首字恢复 */
interface LogoPhase {
  /** 相位所属的不透明引用(ref 变化即整体重置,防旧图残留) */
  ref: string | null;
  phase: 'loading' | 'loaded' | 'error';
}

export interface ChannelLogoProps {
  /** 直播/目录 DTO 原样回传的不透明引用;null = 直接回退层(不渲染 img) */
  readonly posterRef: string | null;
  /** 频道名:仅用于回退层首字与宿主容器 aria-label 组合(契约形状;本组件不将其写入 img alt) */
  readonly channelTitle: string;
  /**
   * 首字回退层的字号/字重/颜色 class(宿主传入,与其 posterRef===null 分支首字
   * 逐字一致 —— ui.md §1 不变量 2 的组件化表达;居中/绝对定位/透明度过渡由本组件
   * 统一承担,宿主不重复传入 transition 属性类,避免与组件 opacity 过渡冲突)。
   */
  readonly fallbackClassName?: string;
}

export function ChannelLogo({ posterRef, channelTitle, fallbackClassName }: ChannelLogoProps): ReactNode {
  const [phase, setPhase] = useState<LogoPhase>(() => ({ ref: posterRef, phase: 'loading' }));
  if (posterRef !== phase.ref) {
    // 渲染期派生重置(React 官方认可的 props→state 调整模式):ref 变化回到 loading,
    // 旧图立即退场;同 ref 重渲染不进入此分支 = 状态稳定不闪变(ui.md §1 不变量 6)
    setPhase({ ref: posterRef, phase: 'loading' });
  }
  if (posterRef === null) {
    return null;
  }
  const loaded = phase.phase === 'loaded';
  return (
    <span aria-hidden="true" className="pointer-events-none absolute inset-0">
      {/* 首字回退层:加载中/失败可见,onLoad 后淡出(在 img 之下,DOM 序 = 绘制序)。
          与 img 同为 absolute inset-0:任何相位容器尺寸零变化(不变量 1)。 */}
      <span
        className={`absolute inset-0 flex select-none items-center justify-center transition-opacity duration-300 ${
          loaded ? 'opacity-0' : 'opacity-100'
        } ${fallbackClassName ?? ''}`}
      >
        {channelTitle.slice(0, 1)}
      </span>
      {phase.phase !== 'error' ? (
        <img
          src={`/api/public/media/logos/${encodeURIComponent(posterRef)}`}
          alt=""
          aria-hidden="true"
          loading="lazy"
          decoding="async"
          className={`h-full w-full object-contain transition-opacity duration-300 ${
            loaded ? 'opacity-100' : 'opacity-0'
          }`}
          onLoad={() => {
            setPhase({ ref: posterRef, phase: 'loaded' });
          }}
          onError={() => {
            setPhase({ ref: posterRef, phase: 'error' });
          }}
          ref={(img) => {
            // 缓存即时完成兜底:HTTP 缓存命中时图片可能在本回调前已完成(load 事件
            // 丢失或先于处理挂载),已完整解码的图直接进入 loaded,装饰层不滞留不可见
            if (img !== null && img.complete && img.naturalWidth > 0 && phase.phase === 'loading') {
              setPhase({ ref: posterRef, phase: 'loaded' });
            }
          }}
        />
      ) : null}
    </span>
  );
}
