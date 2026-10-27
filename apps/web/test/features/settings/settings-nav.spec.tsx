import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { QueryClientProvider } from '@tanstack/react-query';
import { AppRoutes } from '../../../src/app/routes';
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
 * T123(005-US8 前端测试,先 FAIL):设置导航与解锁门(ui.md §7 + FR-028/FR-031/FR-041)。
 * - 未解锁只显示 PIN 输入且不预取来源/设备/策略等管理主体;
 * - 解锁后子模块菜单与地址一致(/settings 默认到 account);
 * - 七个模块均渲染真实模块(无占位文案)。
 */

interface FetchCall {
  method: string;
  path: string;
}

let fetchCalls: FetchCall[] = [];
let unlocked: boolean;

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

beforeEach(() => {
  fetchCalls = [];
  unlocked = false;
  setWideViewport();
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const url = new URL(String(input), 'http://localhost:3000');
      const call: FetchCall = { method: (init?.method ?? 'GET').toUpperCase(), path: url.pathname };
      fetchCalls.push(call);
      const json = (body: unknown, status = 200): Response =>
        new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
      if (call.path === '/api/settings/access') {
        if (call.method === 'POST') {
          unlocked = true;
          return json({ unlocked: true, expiresAt: new Date(Date.now() + 15 * 60_000).toISOString() });
        }
        if (call.method === 'DELETE') {
          unlocked = false;
          return new Response('', { status: 204 });
        }
        return json({ unlocked, expiresAt: unlocked ? new Date(Date.now() + 15 * 60_000).toISOString() : null });
      }
      if (!unlocked) {
        return new Response(
          JSON.stringify({ title: 'Settings Access Required', status: 403, code: 'SETTINGS_ACCESS_REQUIRED' }),
          { status: 403, headers: { 'Content-Type': 'application/problem+json' } },
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

async function unlock(): Promise<void> {
  const user = userEvent.setup();
  await user.type(screen.getByLabelText('设置 PIN(6 位数字)'), '135790');
  await user.click(screen.getByRole('button', { name: '验证并进入设置' }));
  await waitFor(() => expect(screen.getByRole('navigation', { name: '设置子菜单' })).toBeVisible(), { timeout: 4000 });
}

describe('T123 · 设置导航与解锁门', () => {
  it('未解锁(/settings 直达):只显示 PIN 输入,管理主体(来源/设备/策略/档案)零预取', async () => {
    render(
      <MemoryRouter initialEntries={['/settings/sources']}>
        <WithClient>
          <LocationProbe />
          <AppRoutes />
        </WithClient>
      </MemoryRouter>,
    );
    await waitFor(() => expect(screen.getByLabelText('设置 PIN(6 位数字)')).toBeVisible());
    await waitFor(() => {
      // access 最小状态可读(独立入口),但管理主体不预取
      expect(callsTo('/api/settings/access').length).toBeGreaterThanOrEqual(1);
      expect(callsTo('/api/settings/sources')).toEqual([]);
      expect(callsTo('/api/settings/devices')).toEqual([]);
      expect(callsTo('/api/settings/profiles')).toEqual([]);
      expect(callsTo('/api/settings/account')).toEqual([]);
    });
  });

  it('/settings 默认到 account;解锁后子模块 URL 与菜单一致;七个模块均为真实内容', async () => {
    render(
      <MemoryRouter initialEntries={['/settings']}>
        <WithClient>
          <LocationProbe />
          <AppRoutes />
        </WithClient>
      </MemoryRouter>,
    );
    // 未解锁时门只渲染 PIN 输入(index 重定向位于门内 Outlet,解锁后即触发)
    await waitFor(() => expect(screen.getByLabelText('设置 PIN(6 位数字)')).toBeVisible());
    await unlock();
    // index 重定向到 /settings/account
    await waitFor(() => expect(screen.getByTestId('location')).toHaveTextContent('/settings/account'));
    // account 为真实模块:账号摘要呈现(无占位文案)
    await waitFor(() => expect(screen.getByTestId('account-summary')).toBeVisible());
    expect(screen.queryByText(/模块内容由 US8 填充/)).toBeNull();

    const user = userEvent.setup();
    const nav = screen.getByRole('navigation', { name: '设置子菜单' });
    for (const [title, path] of [
      ['档案管理', '/settings/profiles'],
      ['通用设置', '/settings/general'],
    ] as const) {
      await user.click(withinNav(nav, title));
      await waitFor(() => expect(screen.getByTestId('location')).toHaveTextContent(path));
    }
    // general 渲染真实表单
    expect(screen.getByRole('button', { name: '保存修改' })).toBeInTheDocument();
    // profiles 渲染真实列表(主档案行)
    await user.click(withinNav(nav, '档案管理'));
    await waitFor(() => expect(screen.getByTestId('profile-list')).toBeVisible());
  });

  it('菜单包含全部七个子模块(单一注册表驱动)', async () => {
    render(
      <MemoryRouter initialEntries={['/settings']}>
        <WithClient>
          <LocationProbe />
          <AppRoutes />
        </WithClient>
      </MemoryRouter>,
    );
    await waitFor(() => expect(screen.getByLabelText('设置 PIN(6 位数字)')).toBeVisible());
    await unlock();
    await waitFor(() => expect(screen.getByTestId('location')).toHaveTextContent('/settings/account'), { timeout: 4000 });
    await waitFor(() => expect(screen.getByRole('navigation', { name: '设置子菜单' })).toBeVisible(), { timeout: 4000 });
    const nav = screen.getByRole('navigation', { name: '设置子菜单' });
    for (const title of ['账号与安全', '档案管理', '内容策略', '来源管理', 'EPG 管理', '设备管理', '通用设置']) {
      expect(within(nav).getByRole('link', { name: title })).toBeInTheDocument();
    }
  });
});

function withinNav(nav: HTMLElement, title: string): HTMLElement {
  const link = Array.from(nav.querySelectorAll('a')).find((anchor) => anchor.textContent === title);
  if (link === undefined) {
    throw new Error(`menu link not found: ${title}`);
  }
  return link;
}
