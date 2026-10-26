import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SettingsLayout } from '../src/layouts/SettingsLayout';
import { SettingsAccountPage } from '../src/features/settings/settings-account-page';
import { SettingsModulePlaceholder } from '../src/features/settings/settings-module-placeholder';
import { SETTINGS_MODULES } from '../src/features/settings/settings-modules';

/**
 * T078(005 US7 前端测试,先 FAIL):设置布局。
 * 权威:docs/specs/005-pc-browsing-flow/contracts/ui.md §1/§7 + FR-028:
 * - 宽窗口左菜单(约 220px)/右主体(min-width:0);窄窗口收拢为菜单按钮;
 * - 面包屑/标题显示当前模块;七个子模块导航全部注册;
 * - 账号与安全空架经 GET /api/settings/account 读取只读 AccountSummary;
 *   404(US8 端点未交付)显示读取失败态并注明,不造假数据;
 * - 占位模块显式标注「模块内容由 US8 填充」。
 */

interface FetchCall {
  method: string;
  path: string;
}

let fetchCalls: FetchCall[] = [];
let accountReply: { status: number; body: unknown };

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

function installFetch(): void {
  fetchCalls = [];
  vi.stubGlobal(
    'fetch',
    vi.fn((input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const url = new URL(String(input), 'http://localhost:3000');
      const call: FetchCall = { method: (init?.method ?? 'GET').toUpperCase(), path: url.pathname };
      fetchCalls.push(call);
      if (call.path === '/api/settings/access') {
        return Promise.resolve(jsonResponse({ unlocked: true, expiresAt: new Date(Date.now() + 15 * 60_000).toISOString() }));
      }
      if (call.path === '/api/settings/account') {
        return Promise.resolve(jsonResponse(accountReply.body, accountReply.status));
      }
      return Promise.resolve(jsonResponse({ title: 'Not Found', status: 404, code: 'NOT_FOUND' }, 404));
    }),
  );
}

function setWideViewport(wide: boolean): void {
  vi.stubGlobal(
    'matchMedia',
    vi.fn().mockImplementation((query: string) => ({
      matches: wide ? query.includes('min-width') : false,
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

function accountReplyOk(): { status: number; body: unknown } {
  return { status: 200, body: { id: 'acc-1', username: 'admin', role: 'owner' } };
}

/** 与 routes.tsx /settings 子树同构的最小路由(避免拉入全部公共页面) */
function renderSettingsAt(path: string): void {
  render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/settings" element={<SettingsLayout />}>
          <Route path="account" element={<SettingsAccountPage />} />
          <Route
            path="profiles"
            element={<SettingsModulePlaceholder moduleName="档案管理" scope="档案、PIN 与主档案转移" />}
          />
          <Route
            path="policy"
            element={<SettingsModulePlaceholder moduleName="内容策略" scope="目标档案、等级、未评级与名单" />}
          />
        </Route>
      </Routes>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  installFetch();
  accountReply = accountReplyOk();
  setWideViewport(true);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('T078 · 设置布局(ui.md §1/§7)', () => {
  it('宽窗口:左侧子菜单(约 220px)七模块全注册;右侧主体 min-width:0', async () => {
    setWideViewport(true);
    renderSettingsAt('/settings/account');
    const nav = await screen.findByRole('navigation', { name: '设置子菜单' });
    const links = within(nav).getAllByRole('link');
    expect(links).toHaveLength(SETTINGS_MODULES.length);
    expect(links.map((link) => link.textContent)).toEqual(SETTINGS_MODULES.map((module) => module.title));
    // 左菜单约 220px;右主体 min-width:0(防长内容撑破布局)
    expect(nav.parentElement?.className).toContain('w-[220px]');
    const main = screen.getByRole('main');
    expect(main.className).toContain('min-w-0');
  });

  it('窄窗口:收拢为菜单按钮(默认收起),展开后可达全部子模块;面包屑仍在', async () => {
    setWideViewport(false);
    const user = userEvent.setup();
    renderSettingsAt('/settings/account');
    // 收拢态:无侧栏,菜单按钮可展开
    expect(screen.queryByRole('navigation', { name: '设置子菜单' })).toBeNull();
    const toggle = screen.getByRole('button', { name: '菜单' });
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    expect(screen.getByTestId('settings-current-module')).toHaveTextContent('账号与安全');
    await user.click(toggle);
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    const nav = screen.getByRole('navigation', { name: '设置子菜单' });
    expect(within(nav).getAllByRole('link')).toHaveLength(SETTINGS_MODULES.length);
  });

  it('面包屑/标题显示当前模块(直达子模块)', async () => {
    renderSettingsAt('/settings/policy');
    expect(await screen.findByTestId('settings-current-module')).toHaveTextContent('内容策略');
  });

  it('账号与安全空架:GET /api/settings/account 只读 AccountSummary', async () => {
    renderSettingsAt('/settings/account');
    const summary = await screen.findByTestId('account-summary');
    expect(summary).toHaveTextContent('admin');
    expect(summary).toHaveTextContent('所有者');
    expect(fetchCalls.some((call) => call.path === '/api/settings/account')).toBe(true);
  });

  it('账号与安全:端点 404(US8 未交付)显示「模块内容由 US8 填充」读取失败态,不造假数据', async () => {
    accountReply = { status: 404, body: { status: 404, code: 'NOT_FOUND', title: 'Not Found' } };
    renderSettingsAt('/settings/account');
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('模块内容由 US8 填充');
    expect(screen.queryByTestId('account-summary')).toBeNull();
  });

  it('占位子模块:显式标注「模块内容由 US8 填充」,不发起管理请求', async () => {
    renderSettingsAt('/settings/profiles');
    expect(await screen.findByText(/模块内容由 US8 填充/)).toBeVisible();
    expect(fetchCalls.some((call) => call.path === '/api/settings/account')).toBe(false);
  });
});
