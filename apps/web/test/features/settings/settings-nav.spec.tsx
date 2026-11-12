import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { QueryClientProvider } from '@tanstack/react-query';
import { AppRoutes } from '../../../src/app/routes';
import { getVisibleSettingsGroups } from '../../../src/features/settings/settings-modules';
import { VOD_ENABLED } from '../../../src/shared/feature-flags';
import * as sessionModule from '../../../src/app/session-provider';
import type { SessionContextValue } from '../../../src/app/session-provider';
import { queryClient as appQueryClient } from '../../../src/shared/query/client';
import type { ReactNode as RN } from 'react';
import { useLocation } from 'react-router';

function LocationProbe(): RN {
  const { pathname } = useLocation();
  return <span data-testid="location">{pathname}</span>;
}

/**
 * T025:设置页迁移 useAppQuery/useAppMutation 后,AppRoutes 内页面需要
 * QueryClientProvider(与真实应用 AppProviders 同构:应用单例最外层注入)。
 */
function WithClient({ children }: { children: RN }): RN {
  appQueryClient.clear();
  return <QueryClientProvider client={appQueryClient}>{children}</QueryClientProvider>;
}

/**
 * T123(013-role-differentiated-settings 演进,原 005-US8 解锁门测试):
 * - 全屏 PIN 解锁门已随 ADR-0017 废除:主管理员会话直达全部设置模块,零 access 请求;
 * - /settings 默认到 account;子模块菜单与地址一致;
 * - 侧栏菜单由单一注册表驱动:个人偏好(2)+ 家庭管理(6)+ 账号与安全(1)共 9 项
 *   (profile 我的档案 inNav=false,入口收敛到顶栏身份菜单);
 * - 设置菜单拆分:家庭管理组内原「来源管理/EPG 管理」两项重组为
 *   「IPTV 管理」(/settings/iptv)+「NAS/点播」(/settings/sources),总数仍 9 项。
 */

interface FetchCall {
  method: string;
  path: string;
}

let fetchCalls: FetchCall[] = [];

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

const MAIN_SESSION = {
  sessionId: 'sess-nav-1',
  account: { id: 'a-1', username: 'admin', role: 'owner' },
  activeProfile: {
    id: 'p-main',
    name: '主档案',
    avatar: null,
    type: 'adult',
    isMain: true,
    isDefault: true,
    pinProtected: true,
    status: 'active',
    createdAt: '2026-01-01T00:00:00.000Z',
    version: 1,
  },
  expiresAt: '2026-12-31T23:59:59Z',
  householdId: 'hh-1',
  bootstrapRequired: false,
  profileContextVersion: 1,
};

/** 主管理员会话桩(AdminRouteGuard/SettingsLayout 均经 useOptionalSession 消费) */
function mockSessionValue(): SessionContextValue {
  return {
    status: 'authenticated',
    session: {
      sessionId: 'sess-nav-1',
      account: { id: 'a-1', username: 'admin', role: 'owner' },
      activeProfile: {
        id: 'p-main',
        name: '主档案',
        avatar: null,
        type: 'adult',
        isMain: true,
        isDefault: true,
        pinProtected: true,
        status: 'active',
        createdAt: '2026-01-01T00:00:00.000Z',
        version: 1,
      },
      expiresAt: '2026-12-31T23:59:59Z',
      householdId: 'hh-1',
      bootstrapRequired: false,
      profileContextVersion: 1,
    },
    needsReselection: false,
    personalCacheKey: 'hh-1:p-main:1',
    refresh: vi.fn(),
    applySession: vi.fn(),
    logout: vi.fn(),
  };
}

beforeEach(() => {
  fetchCalls = [];
  setWideViewport();
  // AppRoutes 不含 SessionProvider(真实应用由 AppProviders 注入):测试桩直接注入主管理员会话,
  // 否则 AdminRouteGuard 会把「无会话上下文」按未认证处理而重定向首页
  vi.spyOn(sessionModule, 'useOptionalSession').mockReturnValue(mockSessionValue());
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const url = new URL(String(input), 'http://localhost:3000');
      const call: FetchCall = { method: (init?.method ?? 'GET').toUpperCase(), path: url.pathname };
      fetchCalls.push(call);
      const json = (body: unknown, status = 200): Response =>
        new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
      if (call.path === '/api/auth/session') {
        return json(MAIN_SESSION);
      }
      // 013:无 /api/settings/access 门禁交互 —— 该路径不应被任何设置页请求
      if (call.path === '/api/profile/preferences') {
        return new Response(
          JSON.stringify({ title: 'Not Found', status: 404, code: 'NOT_FOUND' }),
          { status: 404, headers: { 'Content-Type': 'application/problem+json' } },
        );
      }
      switch (call.path) {
        case '/api/settings/account':
          return json({ id: 'a-1', username: 'admin', role: 'owner' });
        case '/api/settings/profiles':
          return json([
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
          ]);
        case '/api/settings/household':
          return json({ name: '家', language: 'zh-CN', timezone: 'Asia/Shanghai', version: 1, mainProfileVersion: 1 });
        case '/api/settings/devices':
          return json([]);
        case '/api/settings/sources':
          return json({ items: [], page: 1, pageSize: 20, total: 0 });
        default:
          return json({});
      }
    }),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function callsTo(pathPrefix: string): Array<{ method: string; path: string }> {
  return fetchCalls.filter((call) => call.path.startsWith(pathPrefix));
}

/**
 * 侧栏可见模块标题:直接取自注册表的导航视图(已按 feature-flags 过滤),
 * v1 只做直播时不含「NAS/点播」——恢复点播只需翻开关,本清单自动跟随。
 */
const ALL_MODULE_TITLES = getVisibleSettingsGroups(true).flatMap((group) =>
  group.modules.map((module) => module.title),
);

describe('T123 · 设置导航(013:无门禁,单一注册表驱动)', () => {
  it('/settings 默认到 account;主管理员直达真实模块,全程零 PIN 弹层、零 access 请求', async () => {
    render(
      <MemoryRouter initialEntries={['/settings']}>
        <WithClient>
          <LocationProbe />
          <AppRoutes />
        </WithClient>
      </MemoryRouter>,
    );
    // index 重定向到 /settings/account,account 为真实模块
    await waitFor(() => expect(screen.getByTestId('location')).toHaveTextContent('/settings/account'));
    await waitFor(() => expect(screen.getByTestId('account-summary')).toBeVisible());
    expect(screen.queryByText(/模块内容由 US8 填充/)).toBeNull();
    // 无 PIN 门禁交互
    expect(screen.queryByLabelText('设置 PIN(6 位数字)')).toBeNull();
    expect(callsTo('/api/settings/access')).toEqual([]);

    const user = userEvent.setup();
    const nav = screen.getByRole('navigation', { name: '设置子菜单' });
    // v1 只做直播:NAS/点播 入口隐藏,该路径的点击校验仅在点播开放时执行
    const navTargets = VOD_ENABLED
      ? ([
          ['NAS/点播', '/settings/sources'],
          ['家庭设置', '/settings/general'],
        ] as const)
      : ([['家庭设置', '/settings/general']] as const);
    for (const [title, path] of navTargets) {
      await user.click(withinNav(nav, title));
      await waitFor(() => expect(screen.getByTestId('location')).toHaveTextContent(path));
    }
    // general 渲染真实表单
    expect(screen.getByRole('button', { name: '保存修改' })).toBeInTheDocument();
    // NAS/点播渲染真实列表(菜单拆分:sources 键仅显示 NAS/在线点播过滤;空列表属预期,容器仍在)
    // v1 只做直播:该入口隐藏,改由下方「深链直达」用例覆盖配置页仍可用
    if (VOD_ENABLED) {
      await user.click(withinNav(nav, 'NAS/点播'));
      await waitFor(() => expect(screen.getByTestId('source-list')).toBeVisible());
    }
  });

  it('管理员深链 /settings/sources(NAS/点播)直达渲染,管理主体照常预取(零门禁)', async () => {
    render(
      <MemoryRouter initialEntries={['/settings/sources']}>
        <WithClient>
          <LocationProbe />
          <AppRoutes />
        </WithClient>
      </MemoryRouter>,
    );
    await waitFor(() => expect(screen.getByTestId('source-list')).toBeVisible(), { timeout: 4000 });
    expect(callsTo('/api/settings/sources').length).toBeGreaterThanOrEqual(1);
    expect(callsTo('/api/settings/access')).toEqual([]);
    expect(screen.queryByLabelText('设置 PIN(6 位数字)')).toBeNull();
  });

  it(`菜单包含全部 ${ALL_MODULE_TITLES.length} 个导航模块(单一注册表驱动;我的档案入口在身份菜单)`, async () => {
    render(
      <MemoryRouter initialEntries={['/settings']}>
        <WithClient>
          <LocationProbe />
          <AppRoutes />
        </WithClient>
      </MemoryRouter>,
    );
    await waitFor(() => expect(screen.getByRole('navigation', { name: '设置子菜单' })).toBeVisible(), {
      timeout: 4000,
    });
    const nav = screen.getByRole('navigation', { name: '设置子菜单' });
    for (const title of ALL_MODULE_TITLES) {
      expect(within(nav).getByRole('option', { name: title })).toBeInTheDocument();
    }
    // 我的档案不进侧栏:入口收敛到顶栏身份菜单(头像 → 我的档案)
    expect(within(nav).queryByRole('option', { name: '我的档案' })).toBeNull();
  });
});

function withinNav(nav: HTMLElement, title: string): HTMLElement {
  // 左菜单为 HeroUI ListBox:按选项定位(选项文本 = 标题 + 可选范围标注,故用前缀匹配)
  const option = within(nav)
    .getAllByRole('option')
    .find((item) => item.textContent?.startsWith(title));
  if (option === undefined) {
    throw new Error(`menu option not found: ${title}`);
  }
  return option;
}
