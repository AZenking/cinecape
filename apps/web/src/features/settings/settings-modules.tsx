/**
 * 设置子模块注册表 (013-role-differentiated-settings; T010 / US1)
 *
 * 导航/标题/组件绑定的单一事实源：
 * - 013 T010: 每个模块声明确切的 scope ('personal' | 'household_admin' | 'system_admin')
 * - 个人偏好组 (personal): playback(播放体验), appearance(界面外观), profile(我的档案)
 *   播放体验/界面外观的偏好字段暂无消费方,v1 由 feature-flags.PERSONAL_PREFS_ENABLED
 *   隐藏入口(inNav=false),路由重定向到「我的档案」;翻开关即恢复。
 * - 家庭管理组 (household_admin): iptv(IPTV 管理:直播源/EPG 来源/频道匹配),
 *   sources(NAS/点播), profiles(成员管理), devices, policy, general(家庭设置)
 * - 账号与安全组 (system_admin): account(账号信息)
 * - 导出 getVisibleSettingsGroups(isMainProfile) 供 SettingsLayout 动态渲染
 * - profile(我的档案) 仅注册路由与元数据,不进侧栏导航(inNav=false):
 *   入口收敛到顶栏身份菜单(头像 → 我的档案),档案信息查看走同一入口。
 */
import { useLocation } from 'react-router';
import type { ComponentType } from 'react';
import type { SettingsScope } from '@hmp/shared';

import { SettingsAccountPage } from './settings-account-page';
import { SettingsProfilesPage } from './settings-profiles-page';
import { SettingsPolicyPage } from './settings-policy-page';
import { SettingsNasVodSourcesPage } from './settings-sources-page';
import { SettingsIptvPage } from './settings-iptv-page';
import { SettingsDevicesPage } from './settings-devices-page';
import { SettingsGeneralPage } from './settings-general-page';
import { SettingsPlaybackPage } from './settings-playback-page';
import { SettingsAppearancePage } from './settings-appearance-page';
import { PERSONAL_PREFS_ENABLED, VOD_ENABLED } from '../../shared/feature-flags';
import { SettingsProfilePage } from './settings-profile-page';

export type { SettingsScope };

/** 左侧分组: 个人偏好 / 家庭管理 / 系统 */
export type SettingsModuleGroup = 'personal' | 'household' | 'system';

export type SettingsModuleKey =
  | 'playback'
  | 'appearance'
  | 'profile'
  | 'iptv'
  | 'sources'
  | 'profiles'
  | 'devices'
  | 'policy'
  | 'general'
  | 'account';

export interface SettingsModuleMeta {
  /** 唯一标识符 */
  readonly id: string;
  /** 地址段 (/settings/{key}) */
  readonly key: SettingsModuleKey;
  /** 路由路径 (/settings/{key}) */
  readonly path: string;
  /** 面包屑/标题模块名 */
  readonly title: string;
  /** 模块作用域 */
  readonly scope: SettingsScope;
  /** 左侧分组归属 */
  readonly group: SettingsModuleGroup;
  /** 作用范围标注 (如「仅当前 Profile」、「需要管理授权」) */
  readonly scopeLabel: string;
  /** 模块描述 */
  readonly description?: string;
  /** 页面组件 */
  readonly component: ComponentType;
  /** 是否进入侧栏导航 (缺省 true;false = 仅注册路由/面包屑,入口在别处,如顶栏身份菜单) */
  readonly inNav?: boolean;
}

/** 分组展示元数据 */
export interface SettingsModuleGroupMeta {
  readonly key: SettingsModuleGroup;
  readonly label: string;
  readonly scope: SettingsScope;
  readonly scopeLabel: string | null;
}

/** 组顺序 = 个人偏好 → 家庭管理 → 系统 */
export const SETTINGS_GROUPS: readonly SettingsModuleGroupMeta[] = [
  { key: 'personal', label: '个人偏好', scope: 'personal', scopeLabel: '仅当前 Profile' },
  { key: 'household', label: '家庭管理', scope: 'household_admin', scopeLabel: '需要管理授权' },
  { key: 'system', label: '账号与安全', scope: 'system_admin', scopeLabel: '仅当前账号' },
] as const;

export const SETTINGS_MODULES: readonly SettingsModuleMeta[] = [
  // ── 个人设置分组 (scope: 'personal') ──
  {
    id: 'playback',
    key: 'playback',
    path: '/settings/playback',
    title: '播放体验',
    scope: 'personal',
    group: 'personal',
    scopeLabel: '仅当前 Profile',
    description: '默认音轨、字幕与自动连播',
    component: SettingsPlaybackPage,
    // 暂未生效:保存的偏好暂无消费方,先隐藏侧栏入口(路由保留并重定向)
    inNav: PERSONAL_PREFS_ENABLED,
  },
  {
    id: 'appearance',
    key: 'appearance',
    path: '/settings/appearance',
    title: '界面外观',
    scope: 'personal',
    group: 'personal',
    scopeLabel: '仅当前 Profile',
    description: '深浅色彩模式与海报视图密度',
    component: SettingsAppearancePage,
    // 暂未生效:主题固定暗色、海报密度无消费方,先隐藏侧栏入口(路由保留并重定向)
    inNav: PERSONAL_PREFS_ENABLED,
  },
  {
    id: 'profile',
    key: 'profile',
    path: '/settings/profile',
    title: '我的档案',
    scope: 'personal',
    group: 'personal',
    scopeLabel: '仅当前 Profile',
    description: '个人档案与基础信息',
    component: SettingsProfilePage,
    // 入口在顶栏身份菜单(头像 → 我的档案),不再占用侧栏导航位
    inNav: false,
  },

  // ── 家庭管理分组 (scope: 'household_admin';组内顺序:直播/EPG 链路 → NAS/点播 → 档案/策略 → 设备 → 通用) ──
  {
    id: 'iptv',
    key: 'iptv',
    path: '/settings/iptv',
    title: 'IPTV 管理',
    scope: 'household_admin',
    group: 'household',
    scopeLabel: '需要管理授权',
    description: '直播源、节目单与频道管理',
    component: SettingsIptvPage,
  },
  {
    id: 'sources',
    key: 'sources',
    path: '/settings/sources',
    title: 'NAS/点播',
    scope: 'household_admin',
    group: 'household',
    scopeLabel: '需要管理授权',
    description: 'NAS 与在线点播来源及导入任务',
    component: SettingsNasVodSourcesPage,
    // v1 只做直播:点播源管理入口隐藏(模块与路由保留,管理员仍可深链直达配置,
    // 翻 feature-flags.ts 开关即恢复侧栏入口)
    inNav: VOD_ENABLED,
  },
  {
    id: 'profiles',
    key: 'profiles',
    path: '/settings/profiles',
    title: '成员管理',
    scope: 'household_admin',
    group: 'household',
    scopeLabel: '需要管理授权',
    description: '成员档案、PIN 与主档案转移',
    component: SettingsProfilesPage,
  },
  {
    id: 'policy',
    key: 'policy',
    path: '/settings/policy',
    title: '内容策略',
    scope: 'household_admin',
    group: 'household',
    scopeLabel: '需要管理授权',
    description: '目标档案、等级、未评级与名单',
    component: SettingsPolicyPage,
  },
  {
    id: 'devices',
    key: 'devices',
    path: '/settings/devices',
    title: '设备管理',
    scope: 'household_admin',
    group: 'household',
    scopeLabel: '需要管理授权',
    description: '设备、撤销与设备播放记录',
    component: SettingsDevicesPage,
  },
  {
    id: 'general',
    key: 'general',
    path: '/settings/general',
    title: '家庭设置',
    scope: 'household_admin',
    group: 'household',
    scopeLabel: '需要管理授权',
    description: '家庭名、语言、时区',
    component: SettingsGeneralPage,
  },

  // ── 账号与安全分组 (scope: 'system_admin') ──
  {
    id: 'account',
    key: 'account',
    path: '/settings/account',
    title: '账号信息',
    scope: 'system_admin',
    group: 'system',
    scopeLabel: '仅当前账号',
    description: '登录账号信息与密码修改',
    component: SettingsAccountPage,
  },
] as const;

/** 默认模块解析 (未知子路径回落默认模块 account) */
const DEFAULT_MODULE: SettingsModuleMeta = SETTINGS_MODULES.find((module) => module.key === 'account')!;

export function settingsModulePath(key: SettingsModuleMeta['key']): string {
  return `/settings/${key}`;
}

/** 由 pathname 解析当前模块 (未知子路径回落默认模块 account) */
export function settingsModuleOf(pathname: string): SettingsModuleMeta {
  const segment = pathname.replace(/^\/settings\/?/, '').split('/')[0] ?? '';
  return SETTINGS_MODULES.find((module) => module.key === segment) ?? DEFAULT_MODULE;
}

/** 当前模块元数据 hook (页面标题/面包屑与子模块页面共用; 随路由变化) */
export function useSettingsPageMeta(): SettingsModuleMeta {
  const { pathname } = useLocation();
  return settingsModuleOf(pathname);
}

/** 分组视图成员: 组元数据 + 组内模块 */
export interface SettingsModuleGroupView extends SettingsModuleGroupMeta {
  readonly modules: readonly SettingsModuleMeta[];
}

export interface NavGroupVisibilityInput {
  readonly isMainProfile: boolean;
  readonly isChild?: boolean;
}

/**
 * 依据当前 Profile 角色计算可见设置分组 (013 US1 / T010):
 * - isMainProfile === false: 仅返回个人偏好分组 (包含 playback, appearance)
 * - isMainProfile === true: 返回个人、家庭管理、账号与安全全部分组
 * - inNav === false 的模块(如 profile 我的档案)不进侧栏导航,入口在顶栏身份菜单
 */
export function getVisibleSettingsGroups(
  input: boolean | NavGroupVisibilityInput,
): readonly SettingsModuleGroupView[] {
  const isMain = typeof input === 'boolean' ? input : Boolean(input?.isMainProfile);

  return SETTINGS_GROUPS.map((group) => {
    const modules = SETTINGS_MODULES.filter((module) => {
      // 仅注册路由/元数据、不进侧栏的模块(入口收敛到身份菜单等处)
      if (module.inNav === false) {
        return false;
      }
      if (module.group !== group.key) {
        return false;
      }
      // 普通成员 (isMain === false) 仅可见 personal scope 的模块
      if (!isMain && module.scope !== 'personal') {
        return false;
      }
      return true;
    });
    return {
      ...group,
      modules,
    };
  }).filter((group) => group.modules.length > 0);
}

/**
 * 左侧分组视图 (兼容旧调用方):
 * 默认按 isMainProfile = true 输出全量分组
 */
export function settingsModuleGroups(isMainProfile: boolean = true): readonly SettingsModuleGroupView[] {
  return getVisibleSettingsGroups(isMainProfile);
}
