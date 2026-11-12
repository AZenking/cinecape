/**
 * 设置分区：使用 HeroUI v3 Card compound API 表达 Figma 中的 surface/card。
 * 行内容仍由页面负责语义与交互，组件只统一卡片的标题、内容和 footer 节奏。
 */
import type { ReactNode } from 'react';
import { Card } from '@heroui/react';

export interface SettingsSectionProps {
  readonly title: string;
  readonly description?: string;
  readonly actions?: ReactNode;
  readonly children: ReactNode;
  readonly footer?: ReactNode;
}

export function SettingsSection({
  title,
  description,
  actions,
  children,
  footer,
}: SettingsSectionProps): ReactNode {
  return (
    <Card variant="default" className="w-full rounded-2xl p-0 shadow-none">
      <Card.Header className="flex flex-row items-start justify-between gap-4 px-4 pb-2 pt-4">
        <div className="flex min-w-0 flex-col gap-1">
          <Card.Title>{title}</Card.Title>
          {description ? <Card.Description>{description}</Card.Description> : null}
        </div>
        {actions ? <div className="flex shrink-0 items-center gap-2">{actions}</div> : null}
      </Card.Header>
      <Card.Content className="flex flex-col gap-5 px-4 pb-4 pt-2">{children}</Card.Content>
      {footer ? (
        <Card.Footer className="flex flex-col items-stretch gap-2 border-t border-separator/70 px-4 py-4 sm:flex-row sm:items-center sm:justify-between">
          {footer}
        </Card.Footer>
      ) : null}
    </Card>
  );
}
