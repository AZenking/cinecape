import { EmptyState } from '@heroui/react';
import type { ReactNode } from 'react';

/**
 * 成功空结果两态(T022 共享异步状态 UI,FR-004/ui.md §8)——
 * 「暂无内容」= 目录确无可用内容(未筛选);「无匹配结果」= 有搜索/筛选但零命中。
 * 两文案严格区分,不把故障显示成空目录(错误走 RetryableAlert)。
 */
export function EmptyCatalogState(): ReactNode {
  return (
    <EmptyState className="py-12 text-center">
      <p className="text-base font-medium text-foreground">暂无内容</p>
      <p className="mt-1 text-sm text-muted">目录还没有可浏览的内容。</p>
    </EmptyState>
  );
}

export function NoMatchState(): ReactNode {
  return (
    <EmptyState className="py-12 text-center">
      <p className="text-base font-medium text-foreground">无匹配结果</p>
      <p className="mt-1 text-sm text-muted">没有符合当前搜索或筛选的内容,试试调整条件。</p>
    </EmptyState>
  );
}
