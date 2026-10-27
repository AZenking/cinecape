import type { ReactNode } from 'react';

/**
 * EPG 局部二维滚动容器(T120;FR-042/043、ui.md §6/§8):
 * - 横向滚动只在墙内:容器 w-full + overflow-auto,内部内容宽度由墙面决定,
 *   整页不产生横向溢出(父链 min-w-0);
 * - 768 窄窗/600 高/200% 缩放:容器限高(max-h)内部滚动,导航由页面级控件收拢换行
 *   (flex-wrap),不需要专门手机界面;
 * - 键盘:容器可聚焦,焦点在容器或节目按钮上时方向键滚动为原生 overflow 行为;
 *   翻页/换窗后的焦点定位由 GuideWall 的窗口标题锚承担(FR-044)。
 */

export interface GuideScrollContainerProps {
  readonly ariaLabel: string;
  /** 焦点定位锚 id(翻页/换窗后聚焦的窗口标题) */
  readonly describedById?: string;
  readonly children: ReactNode;
}

export function GuideScrollContainer({ ariaLabel, describedById, children }: GuideScrollContainerProps): ReactNode {
  return (
    <div
      role="region"
      aria-label={ariaLabel}
      aria-describedby={describedById}
      // 局部二维滚动:max-h 限高(600 高窗口/200% 缩放收拢为内部滚动),overflow 双轴墙内消化
      className="w-full max-w-full overflow-auto rounded border border-border bg-surface focus:outline-none focus-visible:ring-2 focus-visible:ring-focus"
      style={{ maxHeight: 'min(70vh, 640px)' }}
    >
      {children}
    </div>
  );
}
