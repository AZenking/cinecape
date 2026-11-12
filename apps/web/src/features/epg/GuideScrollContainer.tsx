import { useEffect, useRef, useState } from 'react';
import { ScrollShadow } from '@heroui/react';
import type { ReactNode, RefObject } from 'react';
import { consumeGuideSessionSnapshot, GUIDE_WALL_SESSION_KEY } from './guide-session-state';

/**
 * EPG 局部二维滚动容器(T120;FR-042/043、ui.md §6/§8;015 ui-layout §3.2):
 * - 横向滚动只在墙内:容器 w-full + overflow-auto,内部内容宽度由墙面决定,
 *   整页不产生横向溢出(父链 min-w-0);
 * - 768 窄窗/600 高/200% 缩放:容器限高(max-h)内部滚动,导航由页面级控件收拢换行
 *   (flex-wrap),不需要专门手机界面;
 * - 键盘:容器 role="region" 且 tabIndex={0}(must-fix:012 ui.md §6.1 要求 region
 *   键盘可聚焦,与旧实现「容器可聚焦」注释矛盾,本版补齐 tabIndex),焦点在容器或
 *   节目按钮上时方向键滚动为原生 overflow 行为;翻页/换窗后的焦点定位由
 *   GuideWall 的窗口标题锚承担(FR-044);
 * - 首次定位(T023;FR-015;契约 v2):宿主传 autoPosition(key + anchorX + align),
 *   容器首次渲染按内容坐标锚点定位横向滚动:
 *     align='center':锚点置视口水平居中(015 ui-layout §3.2.1 页面初始化自动
 *       水平居中当前时刻线;anchorX 需含频道列偏移,由 GuidePage 计算);
 *       scrollLeft = Math.max(0, anchorX - el.clientWidth / 2);
 *     align='start':滚到锚点左缘,scrollLeft = anchorX;
 *   **同一窗口身份(key)重复渲染不重定位**——手动浏览期间自动刷新/详情开关面板
 *   一律不拉回(FR-016);切日/回到现在产生新窗口 key 才重新定位;
 * - 拖拽平移(产品要求):按住空白或节目块拖动即可 2D 平移(鼠标/触控笔),
 *   触屏保持原生惯性滚动;位移超过 4px 才进入拖拽态,避免误触节目块点击
 *   (进入拖拽后抑制紧随其后的 click 一次);仅鼠标左键;
 * - 会话快照优先(T025;url-state §1 规则3):首次定位时若有会话内快照
 *   (详情返回/SPA 回访),恢复快照滚动而非缺省定位;刷新(全新文档)无快照,
 *   回缺省定位可接受。
 */

/**
 * 窗口定位指令(契约 v2):
 * - key:窗口身份(如 `from|to`),同 key 不重定位(FR-016);
 * - anchorX:内容坐标锚点(px;含频道列偏移,由宿主换算);
 * - align:'center' 锚点置于滚动容器视口水平居中(015 ui-layout §3.2.1),
 *   'start' 滚到锚点左缘。
 */
export interface GuideAutoPosition {
  readonly key: string;
  readonly anchorX: number;
  readonly align: 'center' | 'start';
}

export interface GuideScrollContainerProps {
  readonly ariaLabel: string;
  /** 焦点定位锚 id(翻页/换窗后聚焦的窗口标题) */
  readonly describedById?: string;
  readonly children: ReactNode;
  /** 宿主持有的容器 ref(T025 快照写入/恢复;可选) */
  readonly containerRef?: RefObject<HTMLDivElement | null>;
  /** 首次/换窗定位指令(见上;缺省不干预滚动) */
  readonly autoPosition?: GuideAutoPosition;
  /**
   * 并入宿主卡片(无自带边框/圆角/阴影):节目单页把日期条与节目墙合并为一张卡片时,
   * 墙体不再需要自己的卡片壳,避免双边框。缺省 false = 独立卡片外观。
   */
  readonly flush?: boolean;
  /**
   * 铺满宿主高度(节目单页「适配最大高度」):高度 100% + maxHeight 100%,
   * 由墙内滚动承担内容溢出;缺省 min(70vh,640px) 供独立使用场景。
   */
  readonly fillHeight?: boolean;
}

export function GuideScrollContainer({
  ariaLabel,
  describedById,
  children,
  containerRef,
  autoPosition,
  flush = false,
  fillHeight = false,
}: GuideScrollContainerProps): ReactNode {
  const containerSelfRef = useRef<HTMLDivElement | null>(null);
  /** 已应用定位的窗口身份(同 key 不重定位 = 自动刷新不拉回) */
  const appliedKeyRef = useRef<string | null>(null);
  /** 拖拽平移会话(阈值生效后才 dragging=true,并捕获指针) */
  const dragRef = useRef<{
    pointerId: number;
    startX: number;
    startY: number;
    scrollLeft: number;
    scrollTop: number;
    dragging: boolean;
  } | null>(null);
  /** 拖拽结束时抑制一次 click(否则松手会误触发节目块/播放按钮) */
  const suppressClickRef = useRef(false);
  const [grabbing, setGrabbing] = useState(false);

  const setContainer = (el: HTMLDivElement | null): void => {
    containerSelfRef.current = el;
    if (containerRef !== undefined) {
      containerRef.current = el;
    }
  };

  useEffect(() => {
    if (autoPosition === undefined) {
      return;
    }
    const el = containerSelfRef.current;
    if (el === null) {
      return;
    }
    if (appliedKeyRef.current === autoPosition.key) {
      // 同一窗口重复渲染(数据刷新/面板开关):不重定位(FR-016 手动浏览不拉回)
      return;
    }
    const isFirst = appliedKeyRef.current === null;
    appliedKeyRef.current = autoPosition.key;
    if (isFirst) {
      // T025:会话内快照优先(详情返回/SPA 回访恢复浏览位置);刷新无快照走缺省
      const snapshot = consumeGuideSessionSnapshot(GUIDE_WALL_SESSION_KEY);
      if (snapshot !== null) {
        el.scrollLeft = snapshot.scrollLeft;
        el.scrollTop = snapshot.scrollTop;
        return;
      }
    }
    // 契约 v2:center = 锚点置视口水平居中(不越左界),start = 锚点左缘
    el.scrollLeft =
      autoPosition.align === 'center'
        ? Math.max(0, autoPosition.anchorX - el.clientWidth / 2)
        : autoPosition.anchorX;
  }, [autoPosition]);

  /** 拖拽阈值(px):小于该位移视为点击,不进入拖拽 */
  const DRAG_THRESHOLD_PX = 4;

  const handlePointerDown = (event: React.PointerEvent<HTMLDivElement>): void => {
    if (event.pointerType === 'touch' || event.button !== 0) {
      return; // 触屏用原生惯性滚动;仅响应左键
    }
    const el = containerSelfRef.current;
    if (el === null) {
      return;
    }
    dragRef.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      scrollLeft: el.scrollLeft,
      scrollTop: el.scrollTop,
      dragging: false,
    };
  };

  const handlePointerMove = (event: React.PointerEvent<HTMLDivElement>): void => {
    const drag = dragRef.current;
    if (drag === null || drag.pointerId !== event.pointerId) {
      return;
    }
    const el = containerSelfRef.current;
    if (el === null) {
      return;
    }
    const dx = event.clientX - drag.startX;
    const dy = event.clientY - drag.startY;
    if (!drag.dragging) {
      if (Math.abs(dx) <= DRAG_THRESHOLD_PX && Math.abs(dy) <= DRAG_THRESHOLD_PX) {
        return; // 仍在点击容差内
      }
      drag.dragging = true;
      setGrabbing(true);
      try {
        el.setPointerCapture(event.pointerId);
      } catch {
        // 环境不支持指针捕获(jsdom):拖拽仍可用
      }
    }
    // 2D 平移:内容跟随指针反向滚动
    el.scrollLeft = drag.scrollLeft - dx;
    el.scrollTop = drag.scrollTop - dy;
    suppressClickRef.current = true;
    event.preventDefault();
  };

  const endDrag = (event: React.PointerEvent<HTMLDivElement>): void => {
    const drag = dragRef.current;
    if (drag === null) {
      return;
    }
    if (drag.dragging) {
      try {
        containerSelfRef.current?.releasePointerCapture(event.pointerId);
      } catch {
        // 忽略:指针已释放
      }
    }
    dragRef.current = null;
    setGrabbing(false);
  };

  return (
    <ScrollShadow
      ref={setContainer}
      // 内部滚动条由 HeroUI ScrollShadow 接管:hideScrollBar 隐藏原生条,
      // 边缘渐隐阴影表达可滚动方向;双轴仍由 overflow-auto 承担(横向为主)
      hideScrollBar
      orientation="horizontal"
      // 40 → 32:左侧渐隐会覆盖粘性频道列边缘,收小一点更克制
      size={32}
      offset={8}
      role="region"
      // must-fix(012 ui.md §6.1):region 须键盘可聚焦,补 tabIndex(原实现遗漏)
      tabIndex={0}
      aria-label={ariaLabel}
      aria-describedby={describedById}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={endDrag}
      onPointerCancel={endDrag}
      onClickCapture={(event) => {
        if (suppressClickRef.current) {
          suppressClickRef.current = false;
          event.preventDefault();
          event.stopPropagation();
        }
      }}
      // 局部二维滚动:max-h 限高(600 高窗口/200% 缩放收拢为内部滚动),overflow 双轴墙内消化;
      // 拖拽态显示 grabbing 光标;touch-action 保留原生触摸平移
      className={`w-full max-w-full overflow-auto focus:outline-none focus-visible:ring-2 focus-visible:ring-focus ${
        fillHeight ? 'h-full min-h-0' : ''
      } ${flush ? 'border-0 bg-transparent' : 'rounded-xl border border-border/70 bg-surface shadow-xs'}`}
      style={{
        maxHeight: fillHeight ? '100%' : 'min(70vh, 640px)',
        cursor: grabbing ? 'grabbing' : 'grab',
        touchAction: 'pan-x pan-y',
        userSelect: grabbing ? 'none' : undefined,
      }}
    >
      {children}
    </ScrollShadow>
  );
}
