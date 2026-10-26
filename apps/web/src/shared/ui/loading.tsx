import { Spinner } from '@heroui/react';
import type { ReactNode } from 'react';

/**
 * 加载中提示(T022 共享异步状态 UI,ui.md §8)——
 * role="status" + 可读文字:加载状态可被读屏感知,不仅靠图形;
 * 供 home/catalog 等公共区复用,不另建加载组件。
 */
export function LoadingSpinner({ label = '加载中…' }: { label?: string }): ReactNode {
  return (
    <div
      role="status"
      className="flex items-center justify-center gap-2 py-10 text-sm text-muted"
    >
      <Spinner size="sm" aria-hidden="true" />
      <span>{label}</span>
    </div>
  );
}
