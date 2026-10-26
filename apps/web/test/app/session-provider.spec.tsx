import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { act, render, screen, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { SessionProvider, useSession } from '../../src/app/session-provider';
import type { AccountSession } from '../../src/app/session-types';

/**
 * T034(005 US2 前端单元测试,先 FAIL):SessionProvider 行为。
 * 权威:docs/specs/005-pc-browsing-flow/contracts/ui.md §2 + spec FR-009/FR-019:
 * - restoring 为轻量状态,不遮挡公共区(children 始终渲染);
 * - 刷新恢复账号+当前 Profile;个人缓存键包含 household/Profile/contextVersion;
 * - Profile 失效清空个人展示并提示重新选档,公共区不中断;
 * - 登出/换档递增前端 generation,迟到响应不得回填旧身份。
 */

function sessionFixture(overrides: Partial<AccountSession> = {}): AccountSession {
  return {
    sessionId: 'session-1',
    account: { id: 'acc-1', username: 'admin', role: 'owner' },
    activeProfile: {
      id: 'profile-a',
      name: '妈妈',
      avatar: null,
      type: 'adult',
      isDefault: true,
      isMain: true,
      pinProtected: true,
      status: 'active',
      createdAt: '2026-10-26T00:00:00.000Z',
      version: 1,
    },
    expiresAt: '2026-11-26T00:00:00.000Z',
    householdId: 'hh-1',
    bootstrapRequired: false,
    profileContextVersion: 2,
    ...overrides,
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function problemResponse(status: number, code: string): Response {
  return new Response(JSON.stringify({ status, code, title: code }), {
    status,
    headers: { 'Content-Type': 'application/problem+json' },
  });
}

/** 观察用探针:把 Provider 内部状态渲染为可断言文本 */
function Probe(): ReactNode {
  const session = useSession();
  return (
    <div>
      <span data-testid="status">{session.status}</span>
      <span data-testid="username">{session.session?.account.username ?? '-'}</span>
      <span data-testid="profile">{session.session?.activeProfile?.name ?? '-'}</span>
      <span data-testid="bootstrap-required">{String(session.session?.bootstrapRequired ?? '-')}</span>
      <span data-testid="cache-key">{session.personalCacheKey ?? '-'}</span>
      <span data-testid="needs-reselection">{String(session.needsReselection)}</span>
      <span data-testid="public-area">公共区始终渲染</span>
      <button type="button" data-testid="refresh" onClick={() => void session.refresh()}>
        refresh
      </button>
      <button type="button" data-testid="logout" onClick={() => void session.logout()}>
        logout
      </button>
    </div>
  );
}

function renderProvider(): void {
  render(
    <SessionProvider>
      <Probe />
    </SessionProvider>,
  );
}

let fetchMock: Mock;

beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('T034 · SessionProvider(T040)', () => {
  it('恢复中为轻量状态:公共区(children)立即可见、不被遮挡;恢复完成前 status=restoring', async () => {
    // /auth/session 挂起不返回
    fetchMock.mockImplementation(() => new Promise<Response>(() => {}));
    renderProvider();

    expect(screen.getByTestId('public-area')).toBeVisible();
    expect(screen.getByTestId('status').textContent).toBe('restoring');
  });

  it('刷新恢复:GET /auth/session 200 → authenticated,账号+当前 Profile+bootstrapRequired 缓存;个人缓存键含 household/Profile/contextVersion', async () => {
    fetchMock.mockResolvedValue(jsonResponse(sessionFixture()));
    renderProvider();

    await waitFor(() => expect(screen.getByTestId('status').textContent).toBe('authenticated'));
    expect(screen.getByTestId('username').textContent).toBe('admin');
    expect(screen.getByTestId('profile').textContent).toBe('妈妈');
    expect(screen.getByTestId('bootstrap-required').textContent).toBe('false');
    // 缓存键:household:profile:contextVersion(数据模型 §10 个人缓存键口径)
    expect(screen.getByTestId('cache-key').textContent).toBe('hh-1:profile-a:2');
  });

  it('无会话(401)→ anonymous,无个人展示;公共区不中断', async () => {
    fetchMock.mockResolvedValue(problemResponse(401, 'SESSION_INVALID'));
    renderProvider();

    await waitFor(() => expect(screen.getByTestId('status').textContent).toBe('anonymous'));
    expect(screen.getByTestId('profile').textContent).toBe('-');
    expect(screen.getByTestId('public-area')).toBeVisible();
    expect(screen.getByTestId('needs-reselection').textContent).toBe('false');
  });

  it('Profile 失效(FR-009):activeProfile 由非空变空 → 清个人展示 + needsReselection=true,公共区不中断', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(sessionFixture()));
    renderProvider();
    await waitFor(() => expect(screen.getByTestId('profile').textContent).toBe('妈妈'));

    // 服务端失效回落:当前 Profile 停用后会话回落为无档案
    fetchMock.mockResolvedValueOnce(
      jsonResponse(sessionFixture({ activeProfile: null, profileContextVersion: 3 })),
    );
    await act(async () => {
      screen.getByTestId('refresh').click();
    });

    await waitFor(() => expect(screen.getByTestId('profile').textContent).toBe('-'));
    expect(screen.getByTestId('needs-reselection').textContent).toBe('true');
    expect(screen.getByTestId('status').textContent).toBe('authenticated'); // 会话仍有效
    expect(screen.getByTestId('public-area')).toBeVisible();
    // 缓存键随 contextVersion 变化(旧个人缓存不可复用)
    expect(screen.getByTestId('cache-key').textContent).toBe('hh-1:-:3');
  });

  it('登出递增 generation:登出前在途的迟到 /auth/session 响应不得回填旧身份', async () => {
    // 第一次恢复成功
    fetchMock.mockResolvedValueOnce(jsonResponse(sessionFixture()));
    renderProvider();
    await waitFor(() => expect(screen.getByTestId('status').textContent).toBe('authenticated'));

    // 手动触发一次 refresh:挂起(将在登出后迟到返回 200 旧会话)
    let releaseLate!: (response: Response) => void;
    fetchMock.mockImplementationOnce(
      () => new Promise<Response>((resolve) => { releaseLate = resolve; }),
    );
    await act(async () => {
      screen.getByTestId('refresh').click();
    });

    // 登出:204 幂等 + 状态清空
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 204 }));
    await act(async () => {
      screen.getByTestId('logout').click();
    });
    await waitFor(() => expect(screen.getByTestId('status').textContent).toBe('anonymous'));

    // 迟到响应到达:不得回填旧身份(generation 已递增)
    await act(async () => {
      releaseLate(jsonResponse(sessionFixture()));
    });
    await waitFor(() => expect(screen.getByTestId('status').textContent).toBe('anonymous'));
    expect(screen.getByTestId('profile').textContent).toBe('-');
  });

  it('logout 幂等:登出接口网络失败也清空本地展示(不阻断退出)', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(sessionFixture()));
    renderProvider();
    await waitFor(() => expect(screen.getByTestId('status').textContent).toBe('authenticated'));

    fetchMock.mockRejectedValueOnce(new TypeError('network down'));
    await act(async () => {
      screen.getByTestId('logout').click();
    });

    await waitFor(() => expect(screen.getByTestId('status').textContent).toBe('anonymous'));
    expect(screen.getByTestId('username').textContent).toBe('-');
  });
});
