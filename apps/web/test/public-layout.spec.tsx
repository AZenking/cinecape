import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router';
import { PublicLayout } from '../src/layouts/PublicLayout';
import { AppProviders } from '../src/app/providers';
import { PUBLIC_NAV_ITEMS } from '../src/shared/ui/global-nav';

/**
 * T020(US1 前端单测):PublicLayout 公共导航壳。
 * 对照 docs/specs/005-pc-browsing-flow/contracts/ui.md §1/§2 与 spec.md US1:
 * - 品牌入口(映岬 Cinecape)返回首页;左侧 首页/点播/直播 为真实路由链接(FR-005);
 * - 游客右侧显示登录入口(T042 IdentityMenu:会话恢复 401→anonymous 后呈现,
 *   内部经 useAuthAction 走 T043 统一登录意图弹层);
 * - 公共 Layout 不被 RequireSession 包裹:渲染即出内容,无登录重定向、无会话依赖;
 * - 公共数据请求 credentials omit:布局自身零网络请求(公共请求凭据档位由
 *   shared/fetch 底座保证,foundation-smoke 已测 publicFetch credentials:'omit');
 * - 游客视图不渲染空白个人区占位(个人区属 US4,不占首屏)。
 */

/** app 级 Provider(T040/T043):IdentityMenu 依赖 useSession/useAuthAction。
 * 会话恢复打桩 401(=游客),与真实 app 中 AppProviders>AppRoutes 的挂载一致。 */
function stubGuestSession(): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () =>
      new Response(JSON.stringify({ type: 'about:blank', title: 'SESSION_INVALID' }), {
        status: 401,
        headers: { 'Content-Type': 'application/problem+json' },
      }),
    ),
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
});

function renderLayoutAt(path: string): void {
  stubGuestSession();
  render(
    <MemoryRouter initialEntries={[path]}>
      <AppProviders>
        <Routes>
          <Route element={<PublicLayout />}>
            <Route
              path="*"
              element={
                <main>
                  <h1>页面内容</h1>
                </main>
              }
            />
          </Route>
        </Routes>
      </AppProviders>
    </MemoryRouter>,
  );
}

describe('PublicLayout 导航壳(T020)', () => {
  it('品牌入口返回首页,导航项为真实路由链接(v1 只做直播:不含点播)', () => {
    renderLayoutAt('/');

    const brand = screen.getByRole('link', { name: '映岬 Cinecape' });
    expect(brand).toHaveAttribute('href', '/');

    const nav = screen.getByRole('navigation', { name: '公共导航' });
    // 期望项直接取自单一事实源(已按 feature-flags 过滤),不写死三项:
    // 恢复点播只需翻开关,测试自动跟随。
    expect(within(nav).getAllByRole('link').map((link) => link.textContent)).toEqual(
      PUBLIC_NAV_ITEMS.map((item) => item.label),
    );
    for (const item of PUBLIC_NAV_ITEMS) {
      expect(within(nav).getByRole('link', { name: item.label })).toHaveAttribute('href', item.to);
    }
    // v1 门禁:点播入口不可见
    expect(within(nav).queryByRole('link', { name: '点播' })).toBeNull();
  });

  it('游客右侧显示登录入口(IdentityMenu,经统一登录意图弹层)', async () => {
    renderLayoutAt('/');

    const login = await screen.findByRole('button', { name: '登录' });
    expect(login).toBeInTheDocument();
  });

  it('不被 RequireSession 包裹:渲染即出内容,地址不变、无登录跳转', () => {
    renderLayoutAt('/media/m-1');

    // Outlet 内容立即可见(无重定向/无加载门槛)
    expect(screen.getByRole('heading', { name: '页面内容' })).toBeInTheDocument();
  });

  it('布局自身零内容网络请求(仅 app 级会话恢复;公共凭据档位由 shared/fetch 底座承担)', async () => {
    const fetchSpy = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
      new Response(JSON.stringify({ type: 'about:blank', title: 'SESSION_INVALID' }), {
        status: 401,
        headers: { 'Content-Type': 'application/problem+json' },
      }),
    );
    vi.stubGlobal('fetch', fetchSpy);
    render(
      <MemoryRouter initialEntries={['/']}>
        <AppProviders>
          <Routes>
            <Route element={<PublicLayout />}>
              <Route
                path="*"
                element={
                  <main>
                    <h1>页面内容</h1>
                  </main>
                }
              />
            </Route>
          </Routes>
        </AppProviders>
      </MemoryRouter>,
    );
    // 等会话恢复(401→anonymous)与登录入口出现:此后断言除 app 级身份/初始化探测
    // (/auth/session、/setup/status,均属 T040/T043 意图协调)外零布局内容请求
    await screen.findByRole('button', { name: '登录' });
    const calls = fetchSpy.mock.calls.map((call) => String(call[0]));
    const nonSessionCalls = calls.filter(
      (p) =>
        !p.includes('/auth/session') &&
        !p.includes('/setup/status') &&
        !p.includes('/settings/access'),
    );
    expect(nonSessionCalls).toEqual([]);
  });

  it('游客视图不渲染空白个人区占位(无收藏/历史/个人区占首屏)', () => {
    renderLayoutAt('/');

    expect(screen.queryByText('收藏')).not.toBeInTheDocument();
    expect(screen.queryByText('观看历史')).not.toBeInTheDocument();
    expect(screen.queryByTestId('personal-area')).not.toBeInTheDocument();
  });
});
