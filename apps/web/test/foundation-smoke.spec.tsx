import { afterEach, describe, expect, it, vi, type Mock } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import { BrowserRouter } from 'react-router';
import { App } from '../src/app/App';
import { isAbortError, isFetchApiError, privateFetch, publicFetch } from '../src/shared/fetch';
import type { FetchApiError } from '../src/shared/fetch';
import { PUBLIC_NAV_ITEMS } from '../src/shared/ui/global-nav';

/**
 * T013(005-pc-browsing-flow · Phase 2):web foundation 冒烟门禁。
 *
 * 只验证 Phase 1~2 已有能力(T010 公共骨架 + typed fetch 底座),不承担 005 业务验收:
 * 1. 游客公共壳:App 渲染 PublicLayout,品牌 映岬 Cinecape 与 首页/点播/直播 导航可见,
 *   `/`、`/vod`、`/live` 直达占位页,无登录强制跳转(地址保持原样);
 * 2. typed fetch 行为(fetch.ts 真实 API):
 *    - publicFetch → credentials:'omit',privateFetch → credentials:'same-origin';
 *    - 非 2xx problem+json → FetchApiError(status/title/code 映射);
 *    - AbortController 取消 → 以 AbortError 拒绝(isAbortError 判定,非 FetchApiError)。
 *
 * fetch 以 vi.stubGlobal 打桩(真 Response 对象);不发起任何真实网络请求。
 */

/** 打桩 global fetch,返回真 Response;断言端读取调用参数 */
function stubFetch(handler: (path: string, init: RequestInit) => Promise<Response>): Mock {
  const fetchMock = vi.fn(handler);
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function problemResponse(problem: Record<string, unknown>, status: number): Response {
  return new Response(JSON.stringify(problem), {
    status,
    headers: { 'Content-Type': 'application/problem+json' },
  });
}

/** 以真实浏览器地址(可指定路径)渲染 App 公共壳 */
function renderAppAt(pathname: string): void {
  window.history.replaceState({}, '', pathname);
  render(
    <BrowserRouter>
      <App />
    </BrowserRouter>,
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
  window.history.replaceState({}, '', '/');
});

describe('T013 foundation 冒烟 · 游客公共壳(T010 骨架)', () => {
  // T042 接线后:布局右侧为 IdentityMenu,restoring 期间显示轻量恢复态,
  // 会话恢复(此处打桩 401=无会话)解析后游客呈现「登录」入口(ui.md §2)。
  // v1 只做直播:/vod 不渲染点播页,而是重定向到 /live(feature-flags.ts)。
  it.each([
    { path: '/', heading: '首页' },
    { path: '/live', heading: '直播' },
  ])('游客打开 $path:公共壳渲染且不跳转登录', async ({ path, heading }) => {
    stubFetch(async () => problemResponse({ type: 'about:blank', title: 'SESSION_INVALID' }, 401));
    renderAppAt(path);

    // 品牌 + 导航(跟随 feature-flags,不写死项)
    expect(screen.getByRole('link', { name: '映岬 Cinecape' })).toBeVisible();
    const nav = screen.getByRole('navigation', { name: '公共导航' });
    expect(nav).toBeVisible();
    expect(within(nav).getAllByRole('link').map((link) => link.textContent)).toEqual(
      PUBLIC_NAV_ITEMS.map((item) => item.label),
    );

    // 目标页面渲染;登录入口由 IdentityMenu 在会话恢复(401→anonymous)后呈现
    expect(await screen.findByRole('heading', { name: heading })).toBeVisible();
    expect(await screen.findByRole('button', { name: '登录' })).toBeVisible();

    // 未跳转登录:地址保持原样,且全程不存在任何登录路由重定向
    expect(window.location.pathname).toBe(path);
    expect(window.location.pathname.startsWith('/login')).toBe(false);
    expect(screen.queryByText('404')).not.toBeInTheDocument();
  });

  // v1 门禁显式断言:/vod 与 /media/:id 重定向到直播页(点播页面实现保留,仅入口关闭)
  it('游客打开 /vod:重定向到 /live,不渲染点播页', async () => {
    stubFetch(async () => problemResponse({ type: 'about:blank', title: 'SESSION_INVALID' }, 401));
    renderAppAt('/vod');

    expect(await screen.findByRole('heading', { name: '直播' })).toBeVisible();
    expect(window.location.pathname).toBe('/live');
    expect(screen.queryByRole('heading', { name: '点播' })).toBeNull();
  });
});

describe('T013 foundation 冒烟 · typed fetch 底座(shared/fetch)', () => {
  it('publicFetch 以 credentials:"omit" 发起(公共浏览不携带 cookie)', async () => {
    const fetchMock = stubFetch(async () => jsonResponse({ ok: true }));

    const body = await publicFetch<{ ok: boolean }>('/public/context');

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('/api/public/context');
    expect(init.method).toBe('GET');
    expect(init.credentials).toBe('omit');
    expect(body).toEqual({ ok: true });
  });

  it('privateFetch 以 credentials:"same-origin" 发起(同源会话 Cookie 档位)', async () => {
    const fetchMock = stubFetch(async () => new Response(null, { status: 204 }));

    const body = await privateFetch<void>('/auth/session', { method: 'POST', body: { a: 1 } });

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('/api/auth/session');
    expect(init.credentials).toBe('same-origin');
    expect(init.method).toBe('POST');
    expect(new Headers(init.headers).get('Content-Type')).toBe('application/json');
    expect(init.body).toBe(JSON.stringify({ a: 1 }));
    expect(body).toBeUndefined(); // 204 → undefined
  });

  it('非 2xx problem+json 映射 FetchApiError(status/title/code 逐字段)', async () => {
    stubFetch(async () =>
      problemResponse(
        {
          type: 'https://redroad.example/problems/session-invalid',
          title: '会话无效',
          status: 401,
          detail: '请重新登录',
          code: 'SESSION_INVALID',
        },
        401,
      ),
    );

    let caught: unknown = null;
    try {
      await publicFetch('/auth/session');
    } catch (err) {
      caught = err;
    }
    expect(isFetchApiError(caught)).toBe(true);
    const error = caught as FetchApiError;
    expect(error.status).toBe(401);
    expect(error.title).toBe('会话无效');
    expect(error.code).toBe('SESSION_INVALID');
    expect(error.detail).toBe('请重新登录');
    expect(error.message).toBe('请重新登录'); // message = detail ?? title
    expect(error.problem?.code).toBe('SESSION_INVALID');
  });

  it('AbortController 取消:在途请求以 AbortError 拒绝(非 FetchApiError)', async () => {
    stubFetch(async (_path, init) => {
      const signal = init.signal as AbortSignal;
      return new Promise<Response>((_resolve, reject) => {
        const abort = (): void => reject(new DOMException('This operation was aborted', 'AbortError'));
        if (signal.aborted) {
          abort();
          return;
        }
        signal.addEventListener('abort', abort, { once: true });
      });
    });

    const controller = new AbortController();
    const pending = publicFetch('/public/context', { signal: controller.signal });
    controller.abort();

    let caught: unknown = null;
    try {
      await pending;
    } catch (err) {
      caught = err;
    }
    expect(isAbortError(caught)).toBe(true);
    expect((caught as DOMException).name).toBe('AbortError');
    expect(isFetchApiError(caught)).toBe(false);
  });
});
