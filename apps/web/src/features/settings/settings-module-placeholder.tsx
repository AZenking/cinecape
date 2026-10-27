/**
 * SettingsModulePlaceholder → US8 模块装载器(T131)。
 *
 * app/routes.tsx 仍按七条 /settings/{key} 路由渲染本组件(签名不变);本组件自
 * T131 起按注册表(SETTINGS_MODULES)的 component 绑定分发到真实模块页面,
 * 不再渲染任何占位文案 —— 七个子模块均有实际业务读取与操作(ui.md §7)。
 * routes.tsx 零改动;`/settings` 默认到 account、未知子路径回 404 均为既有路由语义。
 */
import type { ReactNode } from 'react';
import { useSettingsPageMeta } from './settings-modules';

export function SettingsModulePlaceholder(_props: { moduleName: string; scope: string }): ReactNode {
  const module = useSettingsPageMeta();
  const Component = module.component;
  return <Component />;
}
