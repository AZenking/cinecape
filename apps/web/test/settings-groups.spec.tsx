import { cleanup, render, screen, within } from '@testing-library/react';
import { PERSONAL_PREFS_ENABLED, VOD_ENABLED } from '../src/shared/feature-flags';
import { MemoryRouter, Navigate, Route, Routes } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { QueryClientProvider } from '@tanstack/react-query';
import { NotFoundPage } from '../src/app/NotFoundPage';
import { SettingsLayout } from '../src/layouts/SettingsLayout';
import { SettingsAccountPage } from '../src/features/settings/settings-account-page';
import { SettingsModulePlaceholder } from '../src/features/settings/settings-module-placeholder';
import {
  SETTINGS_GROUPS,
  SETTINGS_MODULES,
  settingsModuleGroups,
  settingsModuleOf,
  settingsModulePath,
  type SettingsModuleGroup,
} from '../src/features/settings/settings-modules';
import { queryClient as appQueryClient } from '../src/shared/query/client';

/**
 * T030(012 US5 布局分组;013-role-differentiated-settings 演进;设置菜单拆分再演进):设置布局分组渲染。
 * 权威:docs/specs/013-role-differentiated-settings/contracts + ADR-0017:
 * - 注册表携带分组元数据:personal = playback/appearance/profile(普通成员唯一可见分组);
 *   设置菜单拆分后 household = iptv(IPTV 管理:直播源/EPG 来源/频道匹配)/
 *   sources(NAS/点播)/profiles(成员管理)/policy/devices/general(家庭设置);
 *   system = account(账号信息,组头「账号与安全」);
 * - 入口收敛演进:profile(我的档案) inNav=false 不进侧栏导航,
 *   /settings/profile 路由与面包屑保留,入口在顶栏身份菜单(头像 → 我的档案);
 * - FR-025 注记:「关于与帮助」分类不落位 —— 注册表与左侧菜单均不渲染;
 * - 组头仅呈现分组名(作用范围标注已按设计要求从侧栏移除);
 * - 路由不变:十条 /settings/{key} 与默认 account 保持(分组仅改菜单组织)。 */

/**
 * 组 → 成员键映射基线(013-role-differentiated-settings;设置菜单拆分后;settings-modules 注册表):
 * - 个人偏好组(personal):playback/appearance/profile —— 普通成员唯一可见分组;
 *   其中 profile 仅注册路由(inNav=false),不进侧栏导航视图;
 * - 家庭管理组(household):菜单拆分后组内顺序对齐直播/EPG 链路优先 ——
 *   iptv(IPTV 管理,/settings/iptv)→ sources(NAS/点播,原「来源管理」收窄为 NAS/在线点播)
 *   → profiles(成员管理)/policy → devices → general(家庭设置);
 *   原 epg 键移除:EPG 相关面并入 iptv 模块的「EPG 来源/频道匹配」标签(旧 /settings/epg 重定向);
 * - 账号与安全组(system):account(账号信息)。
 */
const PERSONAL_KEYS = ['playback', 'appearance', 'profile'] as const;
/**
 * 侧栏导航实际渲染的个人偏好键(profile 已收敛到顶栏身份菜单入口)。
 * v1 暂未接入播放/主题偏好:playback/appearance 隐藏 → 个人偏好分组整体不出现。
 */
const PERSONAL_NAV_KEYS = PERSONAL_PREFS_ENABLED ? (['playback', 'appearance'] as const) : ([] as const);
const HOUSEHOLD_KEYS = ['iptv', 'sources', 'profiles', 'policy', 'devices', 'general'] as const;
/** 侧栏可见的家庭管理键(v1 只做直播时 sources=NAS/点播 隐藏,inNav=false) */
const HOUSEHOLD_NAV_KEYS = VOD_ENABLED ? HOUSEHOLD_KEYS : (['iptv', 'profiles', 'policy', 'devices', 'general'] as const);
const SYSTEM_KEYS = ['account'] as const;
const GROUP_ORDER: readonly SettingsModuleGroup[] = ['personal', 'household', 'system'];
/** 导航视图中出现分组的键顺序(个人偏好为空时整组被过滤) */
const NAV_GROUP_ORDER = PERSONAL_PREFS_ENABLED ? GROUP_ORDER : (['household', 'system'] as const);

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

function problemResponse(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/problem+json' } });
}

/** 宽视口(≥900px):左侧子菜单直接渲染(setup.ts 垫片缺省不匹配任何查询) */
function setWideViewport(): void {
  vi.stubGlobal(
    'matchMedia',
    vi.fn().mockImplementation((query: string) => ({
      matches: query.includes('min-width'),
      media: query,
      onchange: null,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })),
  );
}

function installFetch(): void {
  vi.stubGlobal(
    'fetch',
    vi.fn((input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const url = new URL(String(input), 'http://localhost:3000');
      const path = url.pathname;
      const method = (init?.method ?? 'GET').toUpperCase();
      if (path === '/api/settings/access' && method === 'GET') {
        return Promise.resolve(
          jsonResponse({ unlocked: true, expiresAt: new Date(Date.now() + 15 * 60_000).toISOString() }),
        );
      }
      if (path === '/api/settings/account') {
        return Promise.resolve(jsonResponse({ id: 'acc-1', username: 'admin', role: 'owner' }));
      }
      if (path === '/api/settings/profiles') {
        return Promise.resolve(
          jsonResponse([
            {
              id: 'p-main',
              name: '主档案',
              avatar: null,
              type: 'adult',
              isDefault: true,
              isMain: true,
              pinProtected: true,
              status: 'active',
              createdAt: '2026-01-01T00:00:00.000Z',
              version: 1,
            },
          ]),
        );
      }
      if (path === '/api/settings/household') {
        return Promise.resolve(
          jsonResponse({ name: '家', language: 'zh-CN', timezone: 'Asia/Shanghai', version: 1, mainProfileVersion: 1 }),
        );
      }
      // 其余模块端点:面包屑/菜单断言不依赖主体数据,404 让模块页各自呈现失败态即可
      return Promise.resolve(problemResponse({ status: 404, code: 'NOT_FOUND', title: 'Not Found' }, 404));
    }),
  );
}

/**
 * 与 src/app/routes.tsx 的 /settings 子树同构的最小挂载(同样由 SETTINGS_MODULES
 * 派生)。不整体挂 AppRoutes:本规格验收面只关设置布局,整体挂载会把 live/epg 等
 * 并行开发中的页面拉进本测试的编译与挂载面,耦合无关验收。
 */
function renderSettingsRoutes(path: string): { unmount: () => void } {
  appQueryClient.clear();
  const view = render(
    <MemoryRouter initialEntries={[path]}>
      <QueryClientProvider client={appQueryClient}>
        <Routes>
          <Route path="/settings" element={<SettingsLayout />}>
            <Route index element={<Navigate to="/settings/account" replace />} />
            <Route path="account" element={<SettingsAccountPage />} />
            {SETTINGS_MODULES.filter((module) => module.key !== 'account').map((module) => (
              <Route
                key={module.key}
                path={module.key}
                element={
                  // 与 routes.tsx 对齐:个人偏好关闭时深链回落「我的档案」
                  (module.key === 'playback' || module.key === 'appearance') && !PERSONAL_PREFS_ENABLED ? (
                    <Navigate to="/settings/profile" replace />
                  ) : (
                    <SettingsModulePlaceholder moduleName={module.title} scope={module.scope ?? ''} />
                  )
                }
              />
            ))}
            <Route path="*" element={<NotFoundPage />} />
          </Route>
        </Routes>
      </QueryClientProvider>
    </MemoryRouter>,
  );
  return { unmount: view.unmount };
}

beforeEach(() => {
  installFetch();
  setWideViewport();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('T030 · 设置分组渲染(ui.md §5 / FR-024 / FR-025 注记 / Q1)', () => {
  it('注册表:十模块全部携带 group 与 scopeLabel;personal=playback/appearance/profile、household=iptv/sources/profiles/policy/devices/general、system=account', () => {
    expect(SETTINGS_MODULES).toHaveLength(10);
    expect(new Set(SETTINGS_MODULES.map((module) => module.key))).toEqual(
      new Set<string>([...PERSONAL_KEYS, ...HOUSEHOLD_KEYS, ...SYSTEM_KEYS]),
    );
    for (const module of SETTINGS_MODULES) {
      expect(GROUP_ORDER).toContain(module.group); // 只允许三个既定分组
      expect(module.scopeLabel.length).toBeGreaterThan(0); // FR-024:作用范围标注必备
    }
    const keysOf = (group: SettingsModuleGroup): string[] =>
      SETTINGS_MODULES.filter((module) => module.group === group).map((module) => module.key);
    expect(keysOf('personal')).toEqual([...PERSONAL_KEYS]); // 013 US1:个人偏好三模块
    expect(keysOf('household')).toEqual([...HOUSEHOLD_KEYS]);
    expect(keysOf('system')).toEqual([...SYSTEM_KEYS]);
    // general 键不变:家庭区域归 household 组展示,地址仍是 /settings/general
    expect(settingsModulePath('general')).toBe('/settings/general');
  });

  it('FR-025 注记:「关于与帮助」本期不落位——注册表与左侧菜单均不渲染', async () => {
    // key 联合类型本就不含 about:经 string 侧比较,防止未来把 'about' 加进联合时静默漏防
    expect(SETTINGS_MODULES.some((module) => (module.key as string) === 'about')).toBe(false);
    expect(SETTINGS_MODULES.some((module) => module.title.includes('关于') || module.title.includes('帮助'))).toBe(false);
    renderSettingsRoutes('/settings/account');
    const nav = await screen.findByRole('navigation', { name: '设置子菜单' });
    expect(within(nav).queryByText('关于与帮助')).toBeNull();
    expect(screen.queryByText(/关于与帮助/)).toBeNull();
  });

  it('013 US1:个人偏好组就位——注册表含 3 个 personal 模块;导航视图随开关展示 playback/appearance(profile 入口收敛到身份菜单)', async () => {
    expect(SETTINGS_MODULES.filter((module) => module.group === 'personal').map((module) => module.key)).toEqual([
      ...PERSONAL_KEYS,
    ]);
    const personal = settingsModuleGroups().find((group) => group.key === 'personal');
    if (PERSONAL_PREFS_ENABLED) {
      expect(personal, '全量视图(主管理员)含个人偏好组').toBeDefined();
      expect(personal!.modules.map((module) => module.key)).toEqual([...PERSONAL_NAV_KEYS]);
    } else {
      // v1 暂未接入播放/主题偏好:两个入口都隐藏,空分组被过滤
      expect(personal, '个人偏好隐藏后不出现空分组').toBeUndefined();
    }
    renderSettingsRoutes('/settings/account');
    const nav = await screen.findByRole('navigation', { name: '设置子菜单' });
    if (PERSONAL_PREFS_ENABLED) {
      expect(within(nav).getByText('个人偏好')).toBeVisible();
      for (const title of ['播放体验', '界面外观']) {
        expect(within(nav).getByRole('option', { name: title })).toBeVisible();
      }
    } else {
      expect(within(nav).queryByText('个人偏好')).toBeNull();
      for (const title of ['播放体验', '界面外观']) {
        expect(within(nav).queryByRole('option', { name: title })).toBeNull();
      }
    }
    // 我的档案不进侧栏导航(入口 = 顶栏身份菜单),但路由/面包屑仍可达
    expect(within(nav).queryByRole('option', { name: '我的档案' })).toBeNull();
  });

  it('分组视图:按 个人偏好→家庭管理→账号与安全 顺序聚合(个人偏好隐藏时只剩后两组)', () => {
    expect(SETTINGS_GROUPS.map((group) => group.key)).toEqual(GROUP_ORDER); // 既定组顺序
    const view = settingsModuleGroups();
    expect(view.map((group) => group.key)).toEqual([...NAV_GROUP_ORDER]);
    const labels = PERSONAL_PREFS_ENABLED ? ['个人偏好', '家庭管理', '账号与安全'] : ['家庭管理', '账号与安全'];
    expect(view.map((group) => group.label)).toEqual(labels);
    if (PERSONAL_PREFS_ENABLED) {
      expect(view[0]!.modules.map((module) => module.key)).toEqual([...PERSONAL_NAV_KEYS]);
      expect(view[1]!.modules.map((module) => module.key)).toEqual([...HOUSEHOLD_NAV_KEYS]);
      expect(view[2]!.modules.map((module) => module.key)).toEqual([...SYSTEM_KEYS]);
    } else {
      expect(view[0]!.modules.map((module) => module.key)).toEqual([...HOUSEHOLD_NAV_KEYS]);
      expect(view[1]!.modules.map((module) => module.key)).toEqual([...SYSTEM_KEYS]);
    }
  });

  it('布局:左侧按组渲染,组头为加粗标题并标注作用范围,组顺序随开关;链接集合与注册表一致', async () => {
    renderSettingsRoutes('/settings/account');
    const nav = await screen.findByRole('navigation', { name: '设置子菜单' });
    const household = screen.getByTestId('settings-group-household');
    const system = screen.getByTestId('settings-group-system');
    if (PERSONAL_PREFS_ENABLED) {
      const personal = screen.getByTestId('settings-group-personal');
      // 组顺序:个人偏好 → 家庭管理 → 账号与安全
      expect(personal.compareDocumentPosition(household) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
      expect(within(personal).getByText('个人偏好')).toBeVisible();
      expect(within(personal).queryByText('仅当前 Profile')).toBeNull();
    } else {
      // 个人偏好隐藏后不渲染空分组
      expect(screen.queryByTestId('settings-group-personal')).toBeNull();
      expect(within(nav).queryByText('个人偏好')).toBeNull();
    }
    expect(household.compareDocumentPosition(system) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    // 组头仅呈现分组名(作用范围标注已按设计要求从侧栏移除)
    expect(within(household).getByText('家庭管理')).toBeVisible();
    expect(within(household).queryByText('需要管理授权')).toBeNull();
    // 账号与安全组头可见(无「仅当前账号」范围标注)
    expect(within(system).getByText('账号与安全')).toBeVisible();
    expect(within(system).queryByText('仅当前账号')).toBeNull();
    // 分组不丢选项:导航选项(inNav=false 的 profile/隐藏模块除外)、顺序与注册表一致(= 渲染顺序);
    // ListBox 选项 = 图标 + 模块标题(范围标注统一在组头,不再渲染模块级 Description)
    const navModules = SETTINGS_MODULES.filter((module) => module.inNav !== false);
    const options = within(nav).getAllByRole('option');
    expect(options).toHaveLength(navModules.length);
    expect(options.map((option) => option.textContent)).toEqual(
      navModules.map((module) => expect.stringContaining(module.title)),
    );
  });

  it('general 归属:家庭管理组内展示为「家庭设置」,范围标注与组头一致(无模块级 hint),键仍 general', async () => {
    const general = SETTINGS_MODULES.find((module) => module.key === 'general');
    expect(general?.group).toBe('household');
    expect(general?.scopeLabel).toBe('需要管理授权');
    renderSettingsRoutes('/settings/general');
    const nav = await screen.findByRole('navigation', { name: '设置子菜单' });
    const household = within(nav).getByTestId('settings-group-household');
    expect(within(household).getByRole('option', { name: '家庭设置' })).toBeVisible();
    // 模块级 scopeLabel 与组头一致后不再渲染条目级范围标注
    expect(within(household).queryByText('含家庭配置(需管理授权)')).toBeNull();
    expect(await screen.findByTestId('settings-current-module')).toHaveTextContent('家庭设置');
  });

  it('路由:十条 /settings/{key} 均注册且面包屑正确;个人偏好隐藏时深链回落「我的档案」;/settings 默认打开 account;未知子路径元数据回落 account', async () => {
    const HIDDEN_PERSONAL_KEYS = ['playback', 'appearance'];
    for (const module of SETTINGS_MODULES) {
      const view = renderSettingsRoutes(settingsModulePath(module.key));
      const expectedTitle =
        !PERSONAL_PREFS_ENABLED && HIDDEN_PERSONAL_KEYS.includes(module.key) ? '我的档案' : module.title;
      expect(await screen.findByTestId('settings-current-module')).toHaveTextContent(expectedTitle);
      view.unmount();
    }
    // 默认模块:/settings → account(路由与注册表默认均不变)
    renderSettingsRoutes('/settings');
    expect(await screen.findByTestId('account-summary')).toBeVisible();
    expect(screen.getByTestId('settings-current-module')).toHaveTextContent('账号信息');
    // 注册表默认回落:未知子路径的元数据解析仍回落 account(不再依赖数组首位)
    expect(settingsModuleOf('/settings').key).toBe('account');
    expect(settingsModuleOf('/settings/unknown').key).toBe('account');
  });
});
