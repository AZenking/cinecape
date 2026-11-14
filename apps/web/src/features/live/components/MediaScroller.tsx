import { useCallback, useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { Button, ScrollShadow } from '@heroui/react';

/**
 * Netflix 式横向滚动行(T067 布局演进;ui.md §8「整页无横向溢出」):
 * - 溢出被限制在行容器内部,页面永不横向滚动;卡片列固定宽度,按视口自然截断;
 * - 左右圆形箭头:悬停行或键盘聚焦时浮现,整页步进滚动(0.8 视口宽),
 *   到达边缘时隐藏;内容不溢出时不渲染箭头/渐隐(jsdom scrollWidth=0 自然退化);
 * - 滚动容器 = HeroUI `ScrollShadow`(horizontal + hideScrollBar,与节目单同款),
 *   隐藏原生滚动条、以边缘渐隐提示可滚动;snap proximity 吸附;prefers-reduced-motion
 *   时改为瞬时滚动
 *   (全局 CSS 基线只影响 scroll-behavior,JS scrollBy 的显式 behavior 需自行判断);
 * - 列表语义:容器为 ul,子项由调用方提供 li(固定宽度 + snap-start)。
 */

export interface MediaScrollerProps {
  /** 行名(用于箭头 aria-label 区分各行) */
  readonly label: string;
  readonly children: ReactNode;
}

export function MediaScroller({ label, children }: MediaScrollerProps): ReactNode {
  const scrollerRef = useRef<HTMLDivElement | null>(null);
  const [canLeft, setCanLeft] = useState(false);
  const [canRight, setCanRight] = useState(false);

  const update = useCallback((): void => {
    const element = scrollerRef.current;
    if (element === null) {
      return;
    }
    const maxScroll = element.scrollWidth - element.clientWidth;
    const nextLeft = element.scrollLeft > 1;
    const nextRight = maxScroll > 1 && element.scrollLeft < maxScroll - 1;
    setCanLeft((prev) => (prev === nextLeft ? prev : nextLeft));
    setCanRight((prev) => (prev === nextRight ? prev : nextRight));
  }, []);

  /* 挂载:判定初始溢出并监听滚动/尺寸变化(jsdom 无滚动尺寸,自动退化为无箭头) */
  useEffect(() => {
    update();
    const element = scrollerRef.current;
    if (element === null) {
      return;
    }
    element.addEventListener('scroll', update, { passive: true });
    window.addEventListener('resize', update);
    let observer: ResizeObserver | null = null;
    if (typeof ResizeObserver !== 'undefined') {
      observer = new ResizeObserver(update);
      observer.observe(element);
    }
    return () => {
      element.removeEventListener('scroll', update);
      window.removeEventListener('resize', update);
      observer?.disconnect();
    };
  }, [update]);

  /* 数据刷新/分区增减导致内容变化后重新判定溢出(子节点数量变化即重算) */
  useEffect(() => {
    update();
  });

  const scrollByPage = useCallback((direction: -1 | 1): void => {
    const element = scrollerRef.current;
    if (element === null) {
      return;
    }
    let behavior: ScrollBehavior = 'smooth';
    try {
      if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
        behavior = 'auto';
      }
    } catch {
      // matchMedia 不可用时保留平滑滚动(纯体验降级,不影响功能)
    }
    element.scrollBy({ left: direction * element.clientWidth * 0.8, behavior });
  }, []);

  const arrowClass =
    'absolute top-1/2 z-10 -translate-y-1/2 rounded-full bg-overlay/85 text-overlay-foreground opacity-0 shadow-lg transition duration-150 group-focus-within/scroller:opacity-100 group-hover/scroller:opacity-100';

  return (
    <div className="group/scroller relative min-w-0">
      {canLeft ? (
        <>
          <span
            aria-hidden="true"
            className="pointer-events-none absolute inset-y-0 left-0 z-[5] w-10 bg-gradient-to-r from-background to-transparent"
          />
          <Button
            isIconOnly
            size="sm"
            variant="ghost"
            aria-label={`向左滚动 ${label}`}
            className={`${arrowClass} left-0`}
            onPress={() => {
              scrollByPage(-1);
            }}
          >
            ‹
          </Button>
        </>
      ) : null}
      {canRight ? (
        <>
          <span
            aria-hidden="true"
            className="pointer-events-none absolute inset-y-0 right-0 z-[5] w-10 bg-gradient-to-l from-background to-transparent"
          />
          <Button
            isIconOnly
            size="sm"
            variant="ghost"
            aria-label={`向右滚动 ${label}`}
            className={`${arrowClass} right-0`}
            onPress={() => {
              scrollByPage(1);
            }}
          >
            ›
          </Button>
        </>
      ) : null}
      {/* 滚动容器交给 HeroUI ScrollShadow:orientation=horizontal + hideScrollBar
          (与节目单页同款),边缘渐隐由组件按滚动位置生成;原生滚动条不再出现。
          snap 吸附放在滚动容器上,列表只负责 flex 布局(w-max 让内容自然溢出)。 */}
      <ScrollShadow
        ref={scrollerRef}
        orientation="horizontal"
        hideScrollBar
        className="snap-x snap-proximity pb-2"
      >
        <ul className="flex w-max gap-4">{children}</ul>
      </ScrollShadow>
    </div>
  );
}
