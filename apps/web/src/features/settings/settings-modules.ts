/**
 * 设置子模块注册表(T086;ui.md §1 /settings/* 路由表)——
 * 七个子模块的导航/标题/占位范围的单一事实源,路由注册(app/routes.tsx)与
 * SettingsLayout 子菜单共同消费,避免菜单与地址漂移。
 */
import { useLocation } from 'react-router';

export interface SettingsModuleMeta {
  /** 地址段(/settings/{key});account 为默认模块 */
  key: 'account' | 'profiles' | 'policy' | 'sources' | 'epg' | 'devices' | 'general';
  /** 面包屑/标题模块名 */
  title: string;
  /** US8 占位范围说明(仅占位模块使用) */
  scope?: string;
}

export const SETTINGS_MODULES: readonly SettingsModuleMeta[] = [
  { key: 'account', title: '账号与安全' },
  { key: 'profiles', title: '档案管理', scope: '档案、PIN 与主档案转移' },
  { key: 'policy', title: '内容策略', scope: '目标档案、等级、未评级与名单' },
  { key: 'sources', title: '来源管理', scope: 'IPTV/NAS 来源及导入任务' },
  { key: 'epg', title: 'EPG 管理', scope: 'EPG 来源、关联、同步和手动匹配' },
  { key: 'devices', title: '设备管理', scope: '设备、撤销与设备播放记录' },
  { key: 'general', title: '通用设置', scope: '家庭名、语言、时区' },
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
