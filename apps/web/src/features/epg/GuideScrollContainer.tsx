import { useEffect, useRef } from 'react';
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
}

export function GuideScrollContainer({ ariaLabel, describedById, children, containerRef, autoPosition }: GuideScrollContainerProps): ReactNode {
  const containerSelfRef = useRef<HTMLDivElement | null>(null);
  /** 已应用定位的窗口身份(同 key 不重定位 = 自动刷新不拉回) */
  const appliedKeyRef = useRef<string | null>(null);

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

  return (
    <div
      ref={setContainer}
      role="region"
      // must-fix(012 ui.md §6.1):region 须键盘可聚焦,补 tabIndex(原实现遗漏)
      tabIndex={0}
      aria-label={ariaLabel}
      aria-describedby={describedById}
      // 局部二维滚动:max-h 限高(600 高窗口/200% 缩放收拢为内部滚动),overflow 双轴墙内消化
      className="w-full max-w-full overflow-auto rounded-xl border border-border/70 bg-surface shadow-xs focus:outline-none focus-visible:ring-2 focus-visible:ring-focus"
      style={{ maxHeight: 'min(70vh, 640px)' }}
    >
      {children}
    </div>
  );
}
