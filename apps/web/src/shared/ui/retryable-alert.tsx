import { Alert, Button } from '@heroui/react';
import type { ReactNode } from 'react';

/**
 * 可重试错误提示(006 ui-components 契约:错误态 = Alert + 重试封装)——
 * HeroUI v3 `Alert` 复合结构(Root/Content/Title/Description;status 取值
 * default/accent/success/warning/danger,@heroui/styles alertVariants 实证)。
 * 外层 role="alert" + 标题/描述文字 + 显式重试按钮:错误不只靠颜色区分;
 * status="danger" 仅作视觉加强。交互一律 onPress(v3/React Aria 契约,
 * Button 类型层面已 Omit onClick)。错误文案由调用方传入、面向观看者,
 * 不含内部细节/源信息(后续错误文案统一经 shared/query/error.ts 供给,
 * 本组件不依赖 shared/query)。
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
