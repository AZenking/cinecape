import { Skeleton } from '@heroui/react';
import type { ReactNode } from 'react';

/**
 * 内容加载骨架(006 ui-components 契约:加载态统一 Skeleton/Spinner)——
 * 基于 HeroUI `Skeleton`(v3:单组件 + Root 别名,非复合结构,勿套 X.Y 写法,
 * 见 HEROUI-NOTES §3.8)渲染与目录卡片同构的占位网格,加载期维持布局稳定。
 * 容器 aria-hidden:骨架纯装饰,语义加载状态由 LoadingSpinner 的 role="status" 承担;
 * 动效走组件库默认 animationType(pulse),不另行手写动画(fixed dark 主题不动)。
 */
export function MediaGridSkeleton({ count = 8 }: { count?: number }): ReactNode {
  return (
    <div
      aria-hidden="true"
      className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4"
    >
      {Array.from({ length: count }, (_, index) => (
        <div key={index} className="flex flex-col gap-2">
          <Skeleton className="aspect-video w-full rounded-lg" />
          <Skeleton className="h-4 w-3/4 rounded" />
          <Skeleton className="h-3 w-1/2 rounded" />
        </div>
      ))}
    </div>
  );
}
