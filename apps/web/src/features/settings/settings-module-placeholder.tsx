/**
 * 设置子模块占位(T086;US7 阶段七模块中六个的显式占位)。
 *
 * ui.md §7/FR-028:七子模块全部注册导航;US7 仅交付账号与安全空架,其余六模块
 * 内容由 US8 填充 —— 占位必须显式标注,不以空白页宣称整合完成;不发起任何管理
 * 请求、不虚构业务数据。
 */
import type { ReactNode } from 'react';

export function SettingsModulePlaceholder({
  moduleName,
  scope,
}: {
  moduleName: string;
  scope: string;
}): ReactNode {
  return (
    <section aria-label={`设置 · ${moduleName}`} className="flex flex-1 flex-col gap-3 py-10">
      <h2 className="text-lg font-semibold text-foreground">{moduleName}</h2>
      <p className="max-w-prose text-sm text-muted">
        模块内容由 US8 填充(规划范围:{scope});本阶段仅提供导航与布局占位,不提供任何可误用的管理操作。
      </p>
    </section>
  );
}
