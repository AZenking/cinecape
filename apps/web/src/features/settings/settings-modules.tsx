/**
 * 设置子模块注册表(T086;T131,US8)—— 七个子模块的导航/标题/**实际页面**的
 * 单一事实源,路由注册(app/routes.tsx)与 SettingsLayout 子菜单共同消费,避免菜单
 * 与地址漂移。
 *
 * T131:占位替换为真实模块 —— `component` 绑定 US8 实页;app/routes.tsx 渲染的
 * SettingsModulePlaceholder 升格为「按当前地址分发到注册表 component」的装载器,
 * 路由表本身零改动(七条 /settings/{key} 路由不变,/settings 默认到 account)。
 * account 为默认模块;/settings 下未知子路径回 404(routes.tsx 既有语义)。
 */
import { useLocation } from 'react-router';
import type { ComponentType } from 'react';
import { SettingsAccountPage } from './settings-account-page';
import { SettingsProfilesPage } from './settings-profiles-page';
import { SettingsPolicyPage } from './settings-policy-page';
import { SettingsSourcesPage } from './settings-sources-page';
import { SettingsEpgPage } from './settings-epg-page';
import { SettingsDevicesPage } from './settings-devices-page';
import { SettingsGeneralPage } from './settings-general-page';

export interface SettingsModuleMeta {
  /** 地址段(/settings/{key});account 为默认模块 */
  key: 'account' | 'profiles' | 'policy' | 'sources' | 'epg' | 'devices' | 'general';
  /** 面包屑/标题模块名 */
  title: string;
  /** 模块范围说明(空态/文档用) */
  scope?: string;
  /** US8 实页组件(T131 绑定;由 settings-module-placeholder 装载器按 key 渲染) */
  component: ComponentType;
}

export const SETTINGS_MODULES: readonly SettingsModuleMeta[] = [
  { key: 'account', title: '账号与安全', scope: '账号信息与密码修改', component: SettingsAccountPage },
  { key: 'profiles', title: '档案管理', scope: '档案、PIN 与主档案转移', component: SettingsProfilesPage },
  { key: 'policy', title: '内容策略', scope: '目标档案、等级、未评级与名单', component: SettingsPolicyPage },
  { key: 'sources', title: '来源管理', scope: 'IPTV/NAS 来源及导入任务', component: SettingsSourcesPage },
  { key: 'epg', title: 'EPG 管理', scope: 'EPG 来源、关联、同步和手动匹配', component: SettingsEpgPage },
  { key: 'devices', title: '设备管理', scope: '设备、撤销与设备播放记录', component: SettingsDevicesPage },
  { key: 'general', title: '通用设置', scope: '家庭名、语言、时区', component: SettingsGeneralPage },
] as const;

export function settingsModulePath(key: SettingsModuleMeta['key']): string {
  return `/settings/${key}`;
}

/** 由 pathname 解析当前模块(未知子路径回落默认模块 account) */
export function settingsModuleOf(pathname: string): SettingsModuleMeta {
  const segment = pathname.replace(/^\/settings\/?/, '').split('/')[0] ?? '';
  return SETTINGS_MODULES.find((module) => module.key === segment) ?? SETTINGS_MODULES[0]!;
}

/** 当前模块元数据 hook(页面标题/面包屑与子模块页面共用;随路由变化) */
export function useSettingsPageMeta(): SettingsModuleMeta {
  const { pathname } = useLocation();
  return settingsModuleOf(pathname);
}
