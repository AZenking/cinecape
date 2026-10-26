import { Alert, Button } from '@heroui/react';
import type { ReactNode } from 'react';

/**
 * 可重试错误提示(T022 共享异步状态 UI,FR-004/ui.md §8)——
 * role="alert" + 标题/描述文字 + 显式重试按钮:错误不只靠颜色区分;
 * status="danger" 仅作视觉加强。错误文案面向观看者,不含内部细节/源信息。
 */
export function RetryableAlert({
  title,
  description,
  onRetry,
  retryLabel = '重试',
}: {
  title: string;
  description?: string;
  onRetry: () => void;
  retryLabel?: string;
}): ReactNode {
  return (
    <div role="alert" className="py-2">
      <Alert status="danger" className="w-full">
        <Alert.Content className="flex flex-wrap items-center justify-between gap-3">
          <div className="min-w-0">
            <Alert.Title>{title}</Alert.Title>
            {description ? <Alert.Description>{description}</Alert.Description> : null}
          </div>
          <Button size="sm" variant="outline" onPress={onRetry}>
            {retryLabel}
          </Button>
        </Alert.Content>
      </Alert>
    </div>
  );
}
