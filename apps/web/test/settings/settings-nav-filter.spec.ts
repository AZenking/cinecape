import { describe, expect, it } from 'vitest';
import {
  getVisibleSettingsGroups,
  SETTINGS_MODULES,
  type SettingsModuleGroupView,
} from '../../src/features/settings/settings-modules';
import { VOD_ENABLED } from '../../src/shared/feature-flags';

/**
 * 入口收敛演进: profile(我的档案) 仍注册于 SETTINGS_MODULES(路由/面包屑),
 * 但 inNav=false 不进侧栏导航 —— 入口在顶栏身份菜单(头像 → 我的档案)。
 * 设置菜单拆分演进: 家庭管理组内原「sources(来源管理) + epg(EPG 管理)」重组为
 * 「iptv(IPTV 管理) + sources(NAS/点播)」,组内顺序 iptv → sources → profiles →
 * policy → devices → general,模块总数仍 10(侧栏导航仍 9 项)。
 */
describe('T008 · 设置导航可见性过滤 (getVisibleSettingsGroups)', () => {
  it('普通成员 (isMainProfile === false) 仅返回个人偏好分组，且包含 playback, appearance 模块(profile 不入导航)', () => {
    const groups: readonly SettingsModuleGroupView[] = getVisibleSettingsGroups(false);

    // 仅返回 1 个分组 (个人偏好)
    expect(groups).toHaveLength(1);

    const personalGroup = groups[0]!;
    expect(personalGroup.key).toBe('personal');
    expect(personalGroup.scope).toBe('personal');
    expect(personalGroup.label).toBe('个人偏好');

    // 模块列表断言: 包含 playback, appearance;profile(inNav=false) 不再进导航
    const moduleKeys = personalGroup.modules.map((m) => m.key);
    expect(moduleKeys).toEqual(['playback', 'appearance']);

    // 确保所有模块的 scope 均为 personal
    for (const mod of personalGroup.modules) {
      expect(mod.scope).toBe('personal');
      expect(mod.path).toMatch(/^\/settings\//);
      expect(mod.title.length).toBeGreaterThan(0);
    }

    // 负向断言：绝不泄漏任何家庭管理或系统管理模块
    const forbiddenKeys = ['iptv', 'sources', 'profiles', 'devices', 'policy', 'general', 'account'];
    for (const forbidden of forbiddenKeys) {
      expect(moduleKeys).not.toContain(forbidden);
    }
  });

  it('主管理员 (isMainProfile === true) 返回个人、家庭管理、账号与安全全部分组', () => {
    const groups: readonly SettingsModuleGroupView[] = getVisibleSettingsGroups(true);

    // 返回全部分组 (个人偏好、家庭管理、账号与安全)
    expect(groups).toHaveLength(3);

    const groupKeys = groups.map((g) => g.key);
    expect(groupKeys).toEqual(['personal', 'household', 'system']);

    const groupScopes = groups.map((g) => g.scope);
    expect(groupScopes).toEqual(['personal', 'household_admin', 'system_admin']);

    // 个人偏好分组检查(profile 仅注册路由,inNav=false 不进导航视图)
    const personalGroup = groups.find((g) => g.key === 'personal')!;
    expect(personalGroup.modules.map((m) => m.key)).toEqual(['playback', 'appearance']);

    // 家庭管理分组检查(菜单拆分:iptv 在首,sources 收窄为 NAS/点播;原 epg 键移除)
    const householdGroup = groups.find((g) => g.key === 'household')!;
    expect(householdGroup.label).toBe('家庭管理');
    const householdModuleKeys = householdGroup.modules.map((m) => m.key);
    // v1 只做直播:sources(NAS/点播)模块 inNav=false,不进侧栏(feature-flags.ts)
    expect(householdModuleKeys).toEqual(
      VOD_ENABLED
        ? ['iptv', 'sources', 'profiles', 'policy', 'devices', 'general']
        : ['iptv', 'profiles', 'policy', 'devices', 'general'],
    );
    for (const mod of householdGroup.modules) {
      expect(mod.scope).toBe('household_admin');
    }

    // 账号与安全分组检查
    const systemGroup = groups.find((g) => g.key === 'system')!;
    expect(systemGroup.label).toBe('账号与安全');
    expect(systemGroup.modules.map((m) => m.key)).toEqual(['account']);
    for (const mod of systemGroup.modules) {
      expect(mod.scope).toBe('system_admin');
    }
  });

  it('支持传入对象参数 { isMainProfile: boolean }', () => {
    const memberGroups = getVisibleSettingsGroups({ isMainProfile: false });
    expect(memberGroups).toHaveLength(1);
    expect(memberGroups[0]!.key).toBe('personal');
    expect(memberGroups[0]!.modules.map((m) => m.key)).toEqual(['playback', 'appearance']);

    const adminGroups = getVisibleSettingsGroups({ isMainProfile: true });
    expect(adminGroups).toHaveLength(3);
    expect(adminGroups.map((g) => g.key)).toEqual(['personal', 'household', 'system']);
  });

  it('模块全量注册表契约一致性校验', () => {
    expect(SETTINGS_MODULES.length).toBe(10);
    for (const mod of SETTINGS_MODULES) {
      expect(['personal', 'household_admin', 'system_admin']).toContain(mod.scope);
      expect(mod.path).toBe(`/settings/${mod.key}`);
      expect(mod.id).toBe(mod.key);
      expect(mod.component).toBeDefined();
    }
  });

  it('profile(我的档案) 仍注册于注册表(inNav=false):路由/面包屑可解析,但不出现在任何导航视图', () => {
    const profile = SETTINGS_MODULES.find((mod) => mod.key === 'profile');
    expect(profile).toBeDefined();
    expect(profile!.inNav).toBe(false);
    expect(profile!.path).toBe('/settings/profile');
    // 全角色导航视图中均无 profile,路由仍可达由 routes.tsx 注册
    for (const group of getVisibleSettingsGroups(true)) {
      expect(group.modules.map((m) => m.key)).not.toContain('profile');
    }
    for (const group of getVisibleSettingsGroups(false)) {
      expect(group.modules.map((m) => m.key)).not.toContain('profile');
    }
  });
});
