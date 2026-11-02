/**
 * 设置子模块注册表(T086;T131,US8)—— 七个子模块的导航/标题/**实际页面**的
 * 单一事实源,路由注册(app/routes.tsx)与 SettingsLayout 子菜单共同消费,避免菜单
 * 与地址漂移。
 *
 * T131:占位替换为真实模块 —— `component` 绑定 US8 实页;app/routes.tsx 渲染的
 * SettingsModulePlaceholder 升格为「按当前地址分发到注册表 component」的装载器,
 * 路由表本身零改动(七条 /settings/{key} 路由不变,/settings 默认到 account)。
 * account 为默认模块;/settings 下未知子路径回 404(routes.tsx 既有语义)。
 *
 * 012 T032(US5,FR-024 + data-model §4):SettingsModuleMeta 增加 `group` 与
 * `scopeLabel`(作用范围标注)。**数组顺序 = 左侧分组渲染顺序**(个人偏好组本期
 * 零项 → 家庭管理 → 系统,ui.md §5.1),SettingsLayout 经 settingsModuleGroups()
 * 按组渲染。映射基线(data-model §4):
 * - household = profiles/policy/sources/epg/devices + general —— general 页内容是
 *   家庭配置(家庭名/语言/时区),归「家庭管理」组展示;**键仍 general、地址
 *   /settings/general 不变**,scopeLabel 标注「含家庭配置(需管理授权)」;
 * - system = account;
 * - personal 本期零支持项:澄清 Q1「分组先行」——不注册虚假偏好模块,空组整组
 *   不渲染(SC-007);
 * - 「关于与帮助」本期显式不落位(FR-025 注记/分析 U1):不注册该模块、不留占位页。
 * 解锁门(settings-unlock-gate)判定逻辑不动(归 011 替代关系)。
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

/** 左侧分组(012 FR-024):个人偏好 / 家庭管理 / 系统 */
export type SettingsModuleGroup = 'personal' | 'household' | 'system';

export interface SettingsModuleMeta {
  /** 地址段(/settings/{key});account 为默认模块 */
  key: 'account' | 'profiles' | 'policy' | 'sources' | 'epg' | 'devices' | 'general';
  /** 面包屑/标题模块名 */
  title: string;
  /** 模块范围说明(空态/文档用) */
  scope?: string;
  /** 左侧分组归属(012 FR-024/data-model §4;数组顺序即组间渲染顺序) */
  group: SettingsModuleGroup;
  /** 作用范围标注(012 FR-024;如「需要管理授权」;组头统一标注之外的成员另行呈现) */
  scopeLabel: string;
  /** US8 实页组件(T131 绑定;由 settings-module-placeholder 装载器按 key 渲染) */
  component: ComponentType;
}

/**
 * 分组展示元数据(012 ui.md §5.1):label 为组头文案;scopeLabel 为组头作用范围
 * 标注(家庭管理组必须标注「需要管理授权」;系统组规格未要求标注,不发明文案;
 * 个人偏好组本期零项整组隐藏,标注为其未来落位预留)。
 */
export interface SettingsModuleGroupMeta {
  key: SettingsModuleGroup;
  label: string;
  scopeLabel: string | null;
}

/** 组顺序 = 个人偏好 → 家庭管理 → 系统(ui.md §5.1) */
export const SETTINGS_GROUPS: readonly SettingsModuleGroupMeta[] = [
  { key: 'personal', label: '个人偏好', scopeLabel: '仅当前 Profile' },
  { key: 'household', label: '家庭管理', scopeLabel: '需要管理授权' },
  { key: 'system', label: '系统', scopeLabel: null },
] as const;

export const SETTINGS_MODULES: readonly SettingsModuleMeta[] = [
  { key: 'profiles', title: '档案管理', scope: '档案、PIN 与主档案转移', group: 'household', scopeLabel: '需要管理授权', component: SettingsProfilesPage },
  { key: 'policy', title: '内容策略', scope: '目标档案、等级、未评级与名单', group: 'household', scopeLabel: '需要管理授权', component: SettingsPolicyPage },
  { key: 'sources', title: '来源管理', scope: 'IPTV/NAS 来源及导入任务', group: 'household', scopeLabel: '需要管理授权', component: SettingsSourcesPage },
  { key: 'epg', title: 'EPG 管理', scope: 'EPG 来源、关联、同步和手动匹配', group: 'household', scopeLabel: '需要管理授权', component: SettingsEpgPage },
  { key: 'devices', title: '设备管理', scope: '设备、撤销与设备播放记录', group: 'household', scopeLabel: '需要管理授权', component: SettingsDevicesPage },
  // general 的家庭区域归 household 组展示:键仍 general、地址不变,范围标注说明其含家庭配置
  { key: 'general', title: '通用设置', scope: '家庭名、语言、时区', group: 'household', scopeLabel: '含家庭配置(需管理授权)', component: SettingsGeneralPage },
  { key: 'account', title: '账号与安全', scope: '账号信息与密码修改', group: 'system', scopeLabel: '仅当前账号', component: SettingsAccountPage },
] as const;

/** 默认模块解析(显式按 key,不再依赖数组首位 —— 数组顺序已让位于分组渲染顺序) */
const DEFAULT_MODULE: SettingsModuleMeta = SETTINGS_MODULES.find((module) => module.key === 'account')!;

export function settingsModulePath(key: SettingsModuleMeta['key']): string {
  return `/settings/${key}`;
}

/** 由 pathname 解析当前模块(未知子路径回落默认模块 account) */
export function settingsModuleOf(pathname: string): SettingsModuleMeta {
  const segment = pathname.replace(/^\/settings\/?/, '').split('/')[0] ?? '';
  return SETTINGS_MODULES.find((module) => module.key === segment) ?? DEFAULT_MODULE;
}

/** 当前模块元数据 hook(页面标题/面包屑与子模块页面共用;随路由变化) */
export function useSettingsPageMeta(): SettingsModuleMeta {
  const { pathname } = useLocation();
  return settingsModuleOf(pathname);
}

/** 分组视图成员:组元数据 + 组内模块(保持注册表顺序) */
export interface SettingsModuleGroupView extends SettingsModuleGroupMeta {
  modules: readonly SettingsModuleMeta[];
}

/**
 * 左侧分组视图(012 ui.md §5.1):按 SETTINGS_GROUPS 顺序聚合注册表成员;
 * 零成员组整组不出现(本期 personal,Q1/SC-007)——调用方无需各自判空。
 */
export function settingsModuleGroups(): readonly SettingsModuleGroupView[] {
  return SETTINGS_GROUPS.map((group) => ({
    ...group,
    modules: SETTINGS_MODULES.filter((module) => module.group === group.key),
  })).filter((group) => group.modules.length > 0);
}
