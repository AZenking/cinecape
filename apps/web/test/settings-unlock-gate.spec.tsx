import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useState, type ReactNode } from 'react';
import { SettingsAccessProvider, useSettingsAccess } from '../src/features/settings/settings-access-provider';
import { SettingsUnlockGate } from '../src/features/settings/settings-unlock-gate';

/**
 * T078(005 US7 前端测试,先 FAIL):解锁门组件。
 * 权威:docs/specs/005-pc-browsing-flow/contracts/ui.md §7 + spec FR-031/FR-032/FR-041:
 * - 首次进入先 GET access;未解锁只显示 PIN 输入,不预取来源/设备/策略等管理主体;
 * - 403/过期立即隐藏管理主体、不自动提交草稿并显示「编辑未保存」;重新验证后重读现值;
 * - 有效期内返回/刷新经服务端核验继续;客户端定时器只作提示不作权限事实;
 * - PIN 仅表单内存,不写 localStorage。
 */

interface FetchCall {
  method: string;
  path: string;
  body: unknown;
}

let fetchCalls: FetchCall[] = [];
let fetchRouter: (call: FetchCall) => { status: number; body?: unknown } | undefined;

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

/** 错误响应按契约使用 problem+json(fetch 底座据此解析 detail/code) */
function problemResponse(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/problem+json' } });
}

function installFetchRouter(): void {
  fetchCalls = [];
  vi.stubGlobal(
    'fetch',
    vi.fn((input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const url = new URL(String(input), 'http://localhost:3000');
      const call: FetchCall = {
        method: (init?.method ?? 'GET').toUpperCase(),
        path: url.pathname,
        body: init?.body === undefined ? undefined : JSON.parse(String(init.body)),
      };
      fetchCalls.push(call);
      const reply = fetchRouter(call);
      if (reply === undefined) {
        return Promise.resolve(problemResponse({ title: 'Not Found', status: 404, code: 'NOT_FOUND' }, 404));
      }
      return Promise.resolve(
        reply.status >= 400 ? problemResponse(reply.body ?? {}, reply.status) : jsonResponse(reply.body ?? {}, reply.status),
      );
    }),
  );
}

const FUTURE = new Date(Date.now() + 15 * 60_000).toISOString();

function accessCalls(): FetchCall[] {
  return fetchCalls.filter((call) => call.path === '/api/settings/access');
}

function accountCalls(): FetchCall[] {
  return fetchCalls.filter((call) => call.path === '/api/settings/account');
}

/** 管理主体探针:挂载即请求 /api/settings/account(若被渲染);展示 reloadEpoch */
function ManagementProbe(): ReactNode {
  const access = useSettingsAccess();
  const [serverValue, setServerValue] = useState('未读取');
  void (async () => {
    try {
      const response = await fetch('http://localhost:3000/api/settings/account');
      const body = (await response.json()) as { username?: string };
      setServerValue(body.username ?? '读取失败');
    } catch {
      setServerValue('读取失败');
    }
  })();
  return (
    <div>
      <span data-testid="management">管理主体已渲染</span>
      <span data-testid="management-data">{serverValue}</span>
      <span data-testid="reload-epoch">{String(access.reloadEpoch)}</span>
      <button type="button" data-testid="simulate-lost" onClick={access.handleAccessLost}>
        simulate-lost
      </button>
    </div>
  );
}

function renderGate(): void {
  render(
    <MemoryRouter initialEntries={['/settings/account']}>
      <SettingsAccessProvider>
        <SettingsUnlockGate onCancel={() => undefined}>
          <ManagementProbe />
        </SettingsUnlockGate>
      </SettingsAccessProvider>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  installFetchRouter();
  vi.stubGlobal('localStorage', {
    getItem: vi.fn(() => null),
    setItem: vi.fn(),
    removeItem: vi.fn(),
  });
  vi.stubGlobal('sessionStorage', {
    getItem: vi.fn(() => null),
    setItem: vi.fn(),
    removeItem: vi.fn(),
  });
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('T078 · 设置解锁门(ui.md §7)', () => {
  it('首次进入先 GET access;未解锁只显示 PIN 输入且不预取管理主体', async () => {
    fetchRouter = (call) => {
      if (call.method === 'GET' && call.path === '/api/settings/access') {
        return { status: 200, body: { unlocked: false, expiresAt: null } };
      }
      return undefined;
    };
    renderGate();
    await waitFor(() => expect(accessCalls()).toHaveLength(1));
    // 管理主体零请求、零渲染
    expect(accountCalls()).toHaveLength(0);
    expect(screen.queryByTestId('management')).toBeNull();
    // 只显示 PIN 输入
    expect(screen.getByLabelText('设置 PIN(6 位数字)')).toBeVisible();
  });

  it('POST 成功后进入布局:管理主体渲染并发起读取', async () => {
    const user = userEvent.setup();
    fetchRouter = (call) => {
      if (call.path === '/api/settings/access') {
        if (call.method === 'GET') return { status: 200, body: { unlocked: false, expiresAt: null } };
        if (call.method === 'POST') {
          const pin = (call.body as { pin?: string }).pin;
          if (pin === '135790') return { status: 200, body: { unlocked: true, expiresAt: FUTURE } };
          return { status: 403, body: { status: 403, code: 'FORBIDDEN', title: 'Forbidden', detail: 'PIN 验证失败,剩余尝试次数:4' } };
        }
      }
      if (call.path === '/api/settings/account') {
        return { status: 200, body: { id: 'acc-1', username: 'admin', role: 'owner' } };
      }
      return undefined;
    };
    renderGate();
    await waitFor(() => expect(screen.getByLabelText('设置 PIN(6 位数字)')).toBeVisible());
    expect(accountCalls()).toHaveLength(0);
    await user.type(screen.getByLabelText('设置 PIN(6 位数字)'), '135790');
    await user.click(screen.getByRole('button', { name: '验证并进入设置' }));
    await waitFor(() => expect(screen.getByTestId('management')).toBeVisible());
    expect(accountCalls().length).toBeGreaterThanOrEqual(1); // 解锁后才预取管理主体
    expect(screen.getByTestId('management-data')).toHaveTextContent('admin');
  });

  it('403 错误 PIN:以文字呈现服务端 detail,不进入布局', async () => {
    const user = userEvent.setup();
    fetchRouter = (call) => {
      if (call.path === '/api/settings/access' && call.method === 'GET') {
        return { status: 200, body: { unlocked: false, expiresAt: null } };
      }
      if (call.path === '/api/settings/access' && call.method === 'POST') {
        return {
          status: 403,
          body: { status: 403, code: 'FORBIDDEN', title: 'Forbidden', detail: 'PIN 验证失败,剩余尝试次数:4' },
        };
      }
      return undefined;
    };
    renderGate();
    await user.type(await screen.findByLabelText('设置 PIN(6 位数字)'), '000000');
    await user.click(screen.getByRole('button', { name: '验证并进入设置' }));
    const form = screen.getByLabelText('设置 PIN 验证');
    await waitFor(() => expect(within(form).getByText('PIN 验证失败,剩余尝试次数:4')).toBeVisible());
    expect(screen.queryByTestId('management')).toBeNull();
    // PIN 不落任何持久存储
    expect(localStorage.setItem).not.toHaveBeenCalled();
    expect(sessionStorage.setItem).not.toHaveBeenCalled();
  });

  it('423 共享锁定:显示锁定文案(服务端 detail),仍不进入布局', async () => {
    const user = userEvent.setup();
    fetchRouter = (call) => {
      if (call.path === '/api/settings/access' && call.method === 'GET') {
        return { status: 200, body: { unlocked: false, expiresAt: null } };
      }
      if (call.path === '/api/settings/access' && call.method === 'POST') {
        return {
          status: 423,
          body: { status: 423, code: 'PROFILE_PIN_LOCKED', title: 'Profile Pin Locked', detail: 'PIN 已锁定,请稍后重试' },
        };
      }
      return undefined;
    };
    renderGate();
    await user.type(await screen.findByLabelText('设置 PIN(6 位数字)'), '135790');
    await user.click(screen.getByRole('button', { name: '验证并进入设置' }));
    expect(await screen.findByText('PIN 已锁定,请稍后重试')).toBeVisible();
    expect(screen.queryByTestId('management')).toBeNull();
  });

  it('授权丢失:立即隐藏管理主体、显示「编辑未保存」;重新验证后重读现值(reloadEpoch 递增)', async () => {
    const user = userEvent.setup();
    fetchRouter = (call) => {
      if (call.path === '/api/settings/access') {
        if (call.method === 'GET') return { status: 200, body: { unlocked: true, expiresAt: FUTURE } };
        if (call.method === 'POST') return { status: 200, body: { unlocked: true, expiresAt: FUTURE } };
      }
      if (call.path === '/api/settings/account') {
        return { status: 403, body: { status: 403, code: 'SETTINGS_ACCESS_EXPIRED', title: 'Settings Access Expired' } };
      }
      return undefined;
    };
    renderGate();
    // 有效期内直接进入,管理主体渲染
    expect(await screen.findByTestId('management')).toBeVisible();
    const epochBefore = screen.getByTestId('reload-epoch').textContent;
    // 服务端 403(过期/撤销)→ 立即隐藏 + 编辑未保存提示
    await user.click(screen.getByTestId('simulate-lost'));
    await waitFor(() => expect(screen.queryByTestId('management')).toBeNull());
    expect(screen.getByRole('alert')).toHaveTextContent('编辑未保存');
    // 重新验证成功 → 回到布局;reloadEpoch 递增驱动模块重读现值
    await user.type(screen.getByLabelText('设置 PIN(6 位数字)'), '135790');
    await user.click(screen.getByRole('button', { name: '验证并进入设置' }));
    await waitFor(() => expect(screen.getByTestId('management')).toBeVisible());
    expect(screen.getByTestId('reload-epoch').textContent).not.toBe(epochBefore);
  });

  it('有效期内返回/刷新:经服务端核验继续,无需再输 PIN;客户端不重置到期时间(无轮询)', async () => {
    fetchRouter = (call) => {
      if (call.path === '/api/settings/access' && call.method === 'GET') {
        return { status: 200, body: { unlocked: true, expiresAt: FUTURE } };
      }
      if (call.path === '/api/settings/account') {
        return { status: 200, body: { id: 'acc-1', username: 'admin', role: 'owner' } };
      }
      return undefined;
    };
    renderGate();
    expect(await screen.findByTestId('management')).toBeVisible();
    expect(screen.queryByLabelText('设置 PIN(6 位数字)')).toBeNull();
    await waitFor(() => expect(accessCalls()).toHaveLength(1)); // 仅挂载核验一次,无轮询循环
  });

  it('客户端定时器只作提示:本地到期触发一次服务端重验,按服务器事实回到锁定', async () => {
    vi.useFakeTimers();
    installFetchRouter();
    const expiry = new Date(Date.now() + 1_000).toISOString();
    fetchRouter = (call) => {
      if (call.path === '/api/settings/access') {
        if (call.method === 'GET') {
          return { status: 200, body: { unlocked: true, expiresAt: expiry } };
        }
      }
      if (call.path === '/api/settings/account') {
        return { status: 200, body: { id: 'acc-1', username: 'admin', role: 'owner' } };
      }
      return undefined;
    };
    renderGate();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0); // 仅冲刷挂载核验的微任务,不推进定时器
    });
    expect(screen.getByTestId('management')).toBeVisible();
    expect(accessCalls()).toHaveLength(1);
    // 未到期:不触发额外核验
    await act(async () => {
      await vi.advanceTimersByTimeAsync(900);
    });
    expect(accessCalls()).toHaveLength(1);
    // 到期后:定时器只触发服务端重验(此处服务器仍有效 → 保持解锁;客户端无权自行判定)
    await act(async () => {
      await vi.advanceTimersByTimeAsync(200);
    });
    expect(accessCalls()).toHaveLength(2);
    expect(screen.getByTestId('management')).toBeVisible();
  });

  it('取消 PIN 输入:清凭据并回到原页面(onCancel),不自动重开', async () => {
    const user = userEvent.setup();
    let cancelCount = 0;
    fetchRouter = (call) => {
      if (call.path === '/api/settings/access' && call.method === 'GET') {
        return { status: 200, body: { unlocked: false, expiresAt: null } };
      }
      return undefined;
    };
    render(
      <MemoryRouter initialEntries={['/live']}>
        <SettingsAccessProvider>
          <SettingsUnlockGate onCancel={() => { cancelCount += 1; }}>
            <ManagementProbe />
          </SettingsUnlockGate>
        </SettingsAccessProvider>
      </MemoryRouter>,
    );
    const input = await screen.findByLabelText('设置 PIN(6 位数字)');
    await user.type(input, '135790');
    await user.click(screen.getByRole('button', { name: '取消' }));
    expect(cancelCount).toBe(1);
    // 旧回调不得重开:无任何自动 POST/GET 重放
    expect(accessCalls().filter((call) => call.method === 'POST')).toHaveLength(0);
  });
});
