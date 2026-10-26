import { Skeleton } from '@heroui/react';
import type { ReactNode } from 'react';

/**
 * 内容加载骨架(T022 共享异步状态 UI,ui.md §8)——
 * 与目录卡片同构的占位网格,加载期维持布局稳定;aria-hidden(纯装饰,
 * 语义状态由 LoadingSpinner 的 role="status" 承担)。
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
