import { Spinner } from '@heroui/react';
import type { ReactNode } from 'react';

/**
 * 加载中提示(006 ui-components 契约:加载态统一 Skeleton/Spinner)——
 * 基于 HeroUI `Spinner`(v3:单组件 + Root 别名,props 仅 color/size,
 * 见 HEROUI-NOTES §1⑥/§3.8)。外层 role="status" + 可读文字:
 * 加载状态可被读屏感知,不仅靠图形;Spinner 本体 aria-hidden(装饰)。
 * 供 home/catalog/settings 等公共区复用,不另建加载组件。
 */
export function LoadingSpinner({ label = '加载中…' }: { label?: string }): ReactNode {
  return (
    <div
      role="status"
      className="flex items-center justify-center gap-2 py-10 text-sm text-muted"
    >
      <Spinner size="sm" color="accent" aria-hidden="true" />
      <span>{label}</span>
    </div>
  );
}
