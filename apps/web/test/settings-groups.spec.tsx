import { cleanup, render, screen, within } from '@testing-library/react';
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
 * T030(012 US5 测试先行,先 FAIL):设置布局分组渲染。
 * 权威:docs/specs/012-live-settings-experience/contracts/ui.md §5 + spec FR-024/FR-025
 * 注记 + 澄清 Q1 + data-model §4(SettingsModuleMeta.group/scopeLabel):
 * - 注册表携带分组元数据:household = profiles/policy/sources/epg/devices(+ general 的
 *   家庭区域,键仍 general);system = account;分组顺序 个人偏好→家庭管理→系统;
 * - FR-025 注记:「关于与帮助」分类本期不落位 —— 注册表与左侧菜单均不渲染;
 * - Q1/SC-007:个人偏好组「分组先行」,零支持项整组不渲染;
 * - 家庭管理组头标注「需要管理授权」;组头显示作用范围标注;
 * - 路由不变:七条 /settings/{key} 与默认 account 保持(分组仅改菜单组织)。
 */

/** 组 → 成员键映射基线(data-model §4;general 的家庭区域归 household 展示,键不变) */
const HOUSEHOLD_KEYS = ['profiles', 'policy', 'sources', 'epg', 'devices', 'general'] as const;
const SYSTEM_KEYS = ['account'] as const;
/** 组渲染顺序(ui.md §5.1:个人偏好 / 家庭管理 / 系统) */
const GROUP_ORDER: readonly SettingsModuleGroup[] = ['personal', 'household', 'system'];

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
                element={<SettingsModulePlaceholder moduleName={module.title} scope={module.scope ?? ''} />}
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
  it('注册表:七模块全部携带 group 与 scopeLabel;映射 household=profiles/policy/sources/epg/devices(+general 家庭区域)、system=account', () => {
    expect(SETTINGS_MODULES).toHaveLength(7);
    expect(new Set(SETTINGS_MODULES.map((module) => module.key))).toEqual(
      new Set<string>([...HOUSEHOLD_KEYS, ...SYSTEM_KEYS]),
    );
    for (const module of SETTINGS_MODULES) {
      expect(GROUP_ORDER).toContain(module.group); // 只允许三个既定分组
      expect(module.scopeLabel.length).toBeGreaterThan(0); // FR-024:作用范围标注必备
    }
    const keysOf = (group: SettingsModuleGroup): string[] =>
      SETTINGS_MODULES.filter((module) => module.group === group).map((module) => module.key);
    expect(keysOf('household')).toEqual([...HOUSEHOLD_KEYS]);
    expect(keysOf('system')).toEqual([...SYSTEM_KEYS]);
    expect(keysOf('personal')).toEqual([]); // Q1:本期零支持项,不注册虚假偏好模块
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

  it('Q1/SC-007:个人偏好组零支持项——注册表无 personal 模块,分组视图与左侧菜单整组不渲染', async () => {
    expect(SETTINGS_MODULES.some((module) => module.group === 'personal')).toBe(false);
    expect(settingsModuleGroups().some((group) => group.key === 'personal')).toBe(false);
    renderSettingsRoutes('/settings/account');
    const nav = await screen.findByRole('navigation', { name: '设置子菜单' });
    expect(within(nav).queryByText('个人偏好')).toBeNull();
  });

  it('分组视图:按 个人偏好→家庭管理→系统 顺序聚合;空组隐藏(本期输出 家庭管理→系统)', () => {
    expect(SETTINGS_GROUPS.map((group) => group.key)).toEqual(GROUP_ORDER); // 既定组顺序
    const view = settingsModuleGroups();
    expect(view.map((group) => group.key)).toEqual(['household', 'system']);
    expect(view.map((group) => group.label)).toEqual(['家庭管理', '系统']);
    expect(view[0]!.modules.map((module) => module.key)).toEqual([...HOUSEHOLD_KEYS]);
    expect(view[1]!.modules.map((module) => module.key)).toEqual([...SYSTEM_KEYS]);
  });

  it('布局:左侧按组渲染,家庭管理组头标注「需要管理授权」,组头显示作用范围标注;链接集合与注册表一致', async () => {
    renderSettingsRoutes('/settings/account');
    const nav = await screen.findByRole('navigation', { name: '设置子菜单' });
    const household = screen.getByTestId('settings-group-household');
    const system = screen.getByTestId('settings-group-system');
    // 组顺序:家庭管理在系统之前(个人偏好空组隐藏)
    expect(household.compareDocumentPosition(system) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    // 家庭管理组头 + 作用范围标注
    expect(within(household).getByText('家庭管理')).toBeVisible();
    expect(within(household).getByTestId('settings-group-household-scope')).toHaveTextContent('需要管理授权');
    // 系统组头可见(规格未要求系统组标注,不发明文案)
    expect(within(system).getByText('系统')).toBeVisible();
    // 分组不丢链接:七条链接、顺序与注册表一致(= 渲染顺序)
    const links = within(nav).getAllByRole('link');
    expect(links).toHaveLength(SETTINGS_MODULES.length);
    expect(links.map((link) => link.textContent)).toEqual(SETTINGS_MODULES.map((module) => module.title));
  });

  it('general 归属:家庭管理组内展示,标注「含家庭配置(需管理授权)」,键仍 general', async () => {
    const general = SETTINGS_MODULES.find((module) => module.key === 'general');
    expect(general?.group).toBe('household');
    expect(general?.scopeLabel).toBe('含家庭配置(需管理授权)');
    renderSettingsRoutes('/settings/general');
    const nav = await screen.findByRole('navigation', { name: '设置子菜单' });
    const household = within(nav).getByTestId('settings-group-household');
    expect(within(household).getByRole('link', { name: '通用设置' })).toBeVisible();
    // 组头统一的「需要管理授权」之外,general 另有自身范围标注(模块级 scopeLabel 落 UI)
    expect(within(household).getByText('含家庭配置(需管理授权)')).toBeVisible();
    expect(await screen.findByTestId('settings-current-module')).toHaveTextContent('通用设置');
  });

  it('路由不变:七条 /settings/{key} 全部可达且面包屑正确;/settings 默认打开 account;未知子路径元数据回落 account', async () => {
    for (const module of SETTINGS_MODULES) {
      const view = renderSettingsRoutes(settingsModulePath(module.key));
      expect(await screen.findByTestId('settings-current-module')).toHaveTextContent(module.title);
      view.unmount();
    }
    // 默认模块:/settings → account(路由与注册表默认均不变)
    renderSettingsRoutes('/settings');
    expect(await screen.findByTestId('account-summary')).toBeVisible();
    expect(screen.getByTestId('settings-current-module')).toHaveTextContent('账号与安全');
    // 注册表默认回落:未知子路径的元数据解析仍回落 account(不再依赖数组首位)
    expect(settingsModuleOf('/settings').key).toBe('account');
    expect(settingsModuleOf('/settings/unknown').key).toBe('account');
  });
});
