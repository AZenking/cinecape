/**
 * 设置页统一页头：heading + 页面级操作。
 */
import type { ReactNode } from 'react';
import { useSettingsPageMeta } from '../settings-modules';

export interface SettingsPageHeaderProps {
  /** 显式描述; undefined 使用注册表，null 隐藏(用于加载/错误状态)。 */
  readonly description?: string | null;
  /** 页面级主操作(渲染于标题行右侧)。 */
  readonly actions?: ReactNode;
}

export function SettingsPageHeader({ description, actions }: SettingsPageHeaderProps): ReactNode {
  const { title, description: metaDescription } = useSettingsPageMeta();
  const resolvedDescription = description !== undefined ? description : (metaDescription ?? null);

  return (
    <header className="flex items-start justify-between gap-6">
      <div className="flex min-w-0 flex-col gap-2">
        <h1
          className="text-2xl font-semibold leading-9 text-foreground"
          data-testid="settings-current-module"
        >
          {title}
        </h1>
        {resolvedDescription ? <p className="text-sm leading-6 text-muted">{resolvedDescription}</p> : null}
      </div>
      {actions ? <div className="flex shrink-0 items-center gap-2">{actions}</div> : null}
    </header>
  );
}
