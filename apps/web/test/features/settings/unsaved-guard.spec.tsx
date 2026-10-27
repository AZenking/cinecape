import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes, Link } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useState, type ReactNode } from 'react';
import { useLocation } from 'react-router';
import { UnsavedGuardProvider, useUnsavedGuard } from '../../../src/features/settings/shared/unsaved-guard';

function LocationProbe(): ReactNode {
  const { pathname } = useLocation();
  return <span data-testid="location">{pathname}</span>;
}

/**
 * T123(005-US8 前端测试,先 FAIL):未保存编辑拦截(FR-041)。
 * - 离开/切换子模块时明确提示且不自动保存(拦截期间零写入请求);
 * - 「继续编辑」停留;「放弃编辑并离开」显式放行;
 * - 非脏状态不拦截。
 */

interface FetchCall {
  method: string;
  path: string;
}

let fetchCalls: FetchCall[] = [];

beforeEach(() => {
  fetchCalls = [];
  vi.stubGlobal(
    'fetch',
    vi.fn((_input: RequestInfo | URL, init?: RequestInit) => {
      fetchCalls.push({ method: (init?.method ?? 'GET').toUpperCase(), path: new URL(String(_input), 'http://localhost').pathname });
      return Promise.resolve(new Response('{}', { status: 200 }));
    }),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function writeCalls(): FetchCall[] {
  return fetchCalls.filter((call) => call.method !== 'GET');
}

function DirtyHarness({ dirtyInitially }: { dirtyInitially: boolean }): ReactNode {
  const [dirty, setDirty] = useState(dirtyInitially);
  const { pathname: pathnameProbe } = useLocation();
  const guard = useUnsavedGuard(dirty);
  return (
    <div>
      <span data-testid="harness-location">{pathnameProbe}</span>
      <button type="button" onClick={() => setDirty(true)}>
        make-dirty
      </button>
      <Link to="/settings/profiles" data-testid="go-profiles">
        档案管理
      </Link>
      {guard.dialog}
    </div>
  );
}

function renderAt(path: string, dirtyInitially: boolean): void {
  render(
    <MemoryRouter initialEntries={[path]}>
      <UnsavedGuardProvider>
        <LocationProbe />
        <Routes>
          <Route path="/settings/general" element={<DirtyHarness dirtyInitially={dirtyInitially} />} />
          <Route path="/settings/profiles" element={<p>档案管理页面</p>} />
        </Routes>
      </UnsavedGuardProvider>
    </MemoryRouter>,
  );
}

describe('T123 · useUnsavedGuard(FR-041 未保存拦截)', () => {
  it('脏状态点击离开:全屏遮罩 + 明确提示、不自动保存(零写请求);「放弃编辑并离开」才放行', async () => {
    const user = userEvent.setup();
    renderAt('/settings/general', false);
    await user.click(screen.getByText('make-dirty'));
    await new Promise((resolve) => setTimeout(resolve, 60)); // 等待编辑态登记到布局级 Provider(真实交互间隔)
    await user.click(screen.getByTestId('go-profiles'));
    // 拦截:遮罩 + 弹层出现(目标页被覆盖),无任何自动保存请求
    await waitFor(() => expect(screen.getByRole('alert')).toBeVisible());
    expect(screen.getByRole('alert')).toHaveTextContent(/不会自动保存/);
    expect(screen.getByTestId('unsaved-overlay')).toBeInTheDocument();
    expect(writeCalls()).toEqual([]);
    // 显式放弃并离开:解除拦截,停留在目标位置
    await user.click(screen.getByTestId('unsaved-discard'));
    await waitFor(() => expect(screen.getByTestId('location')).toHaveTextContent('/settings/profiles'));
    expect(screen.getByText('档案管理页面')).toBeInTheDocument();
    expect(screen.queryByTestId('unsaved-overlay')).toBeNull();
    expect(writeCalls()).toEqual([]); // 全程未自动提交
  });

  it('「继续编辑」停留当前模块,不导航', async () => {
    const user = userEvent.setup();
    renderAt('/settings/general', true);
    await new Promise((resolve) => setTimeout(resolve, 60)); // 等待初始脏态登记生效
    await user.click(screen.getByTestId('go-profiles'));
    await waitFor(() => expect(screen.getByTestId('unsaved-continue')).toBeVisible());
    await user.click(screen.getByTestId('unsaved-continue'));
    await waitFor(() => expect(screen.queryByTestId('unsaved-discard')).toBeNull());
    expect(screen.getByTestId('location')).toHaveTextContent('/settings/general');
    expect(screen.getByText('make-dirty')).toBeInTheDocument();
  });

  it('非脏状态直接放行,不弹提示', async () => {
    const user = userEvent.setup();
    renderAt('/settings/general', false);
    await user.click(screen.getByTestId('go-profiles'));
    await waitFor(() => expect(screen.getByTestId('location')).toHaveTextContent('/settings/profiles'));
    expect(screen.queryByTestId('unsaved-overlay')).toBeNull();
  });
});
