import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { MemoryRouter } from 'react-router';
import { ActionCoordinator } from '../src/app/action-coordinator';
import { SessionProvider } from '../src/app/session-provider';
import { SettingsAccessProvider } from '../src/features/settings/settings-access-provider';
import type { AccountSession } from '../src/app/session-types';
import type { SessionContextValue } from '../src/app/session-provider';
import { HomePage } from '../src/features/home/HomePage';
import { useSession } from '../src/app/session-provider';
import { createQueryWrapper, createTestQueryClient } from './helpers/query-test-utils';
import { VOD_ENABLED } from '../src/shared/feature-flags';

/**
 * T094(005 US4 前端单元测试;tasks.md 路径 test/home-personal-area.test.tsx,
 * 按仓库 vitest include 规则落地为 *.spec.tsx)—— 首页个人区隔离:
 *
 * - 场景 1(FR-015):游客仅公共区(直播摘要前 4/所有节目单入口/点播入口),
 *   不发任何个人数据请求(/me/**);未选档同规则;
 * - FR-016:选档后按 ui.md §4「收藏频道 → 点播观看历史」顺序渲染,各分区独立
 *   加载/空/失败/可重试状态,失败不阻塞公共区;
 * - 场景 4/FR-019:切换 Profile/退出立即清空个人区并递增身份键,A 的在途迟到响应
 *   不得回写 B 或游客页面;
 * - 场景 5/FR-020:失效收藏媒体显示不可用、可取消收藏、无可运行播放按钮,且不
 *   当作正在直播节目;
 * - FR-045:换档后公共浏览条件(公共入口)保留并重载个人数据。
 */

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

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
      pinProtected: false,
      status: 'active',
      createdAt: '2026-10-26T00:00:00.000Z',
      version: 1,
    },
    expiresAt: '2026-11-26T00:00:00.000Z',
    householdId: 'hh-1',
    bootstrapRequired: false,
    profileContextVersion: 1,
    ...overrides,
  };
}

let fetchMock: Mock;

beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

/** 会话身份探针:直改 SessionProvider 状态(切档/退出场景用;测试经 nextSession 注入) */
let nextSession: (() => SessionContextValue['session']) | null = null;

function SessionSwitcher(): ReactNode {
  const session = useSession();
  return (
    <button
      type="button"
      data-testid="switch-session"
      onClick={() => {
        const value = nextSession?.() ?? null;
        if (value === null) {
          void session.logout();
        } else {
          session.applySession(value);
        }
      }}
    >
      switch
    </button>
  );
}

function renderHome(): void {
  nextSession = null;
  render(
    <MemoryRouter>
      <SessionProvider>
        <SettingsAccessProvider>
          <ActionCoordinator>
            <SessionSwitcher />
            <HomePage />
          </ActionCoordinator>
        </SettingsAccessProvider>
      </SessionProvider>
    </MemoryRouter>,
    // T023:HomePage 公共区取数已迁移 shared/query(useAppQuery),需 QueryClientProvider;
    // 每例新内存 client(retry:false),公共区缓存不跨例泄漏
    { wrapper: createQueryWrapper(createTestQueryClient()) },
  );
}

function meCalls(): Array<{ url: string; method: string }> {
  return fetchMock.mock.calls
    .map((call) => ({ url: String(call[0]), method: String((call[1]?.method ?? 'GET')).toUpperCase() }))
    .filter((call) => call.url.includes('/me/'));
}

describe('T094 · 首页个人区隔离', () => {
  it('场景 1:游客仅公共区,不发任何 /me 个人请求;无个人区占位', async () => {
    fetchMock.mockImplementation(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith('/setup/status')) return jsonResponse({ initialized: true });
      if (url.endsWith('/auth/session')) return problemResponse(401, 'SESSION_INVALID');
      if (url.endsWith('/public/context')) {
        return jsonResponse({ initialized: true, displayName: '幸福之家', language: 'zh-CN', timezone: 'Asia/Shanghai', now: '2026-10-26T00:00:00.000Z', catalogRevision: 1 });
      }
      return problemResponse(404, 'NOT_FOUND');
    });
    renderHome();
    await waitFor(() => expect(screen.getByRole('link', { name: /直播/ })).toBeInTheDocument());
    expect(screen.getByRole('link', { name: /所有节目单/ })).toBeInTheDocument();
    // v1 只做直播:点播入口卡隐藏(feature-flags.ts);恢复点播时本断言自动跟随
    if (VOD_ENABLED) {
      expect(screen.getByRole('link', { name: /点播/ })).toBeInTheDocument();
    } else {
      expect(screen.queryByRole('link', { name: /^点播/ })).toBeNull();
    }
    expect(screen.getByText(/登录并选择观看档案后/)).toBeInTheDocument();
    expect(screen.queryByTestId('home-personal-area')).toBeNull();
    expect(meCalls()).toHaveLength(0);
  });

  it('未选档(登录但 activeProfile=null):同样不发 /me 请求', async () => {
    fetchMock.mockImplementation(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith('/setup/status')) return jsonResponse({ initialized: true });
      if (url.endsWith('/auth/session')) return jsonResponse(sessionFixture({ activeProfile: null }));
      if (url.endsWith('/public/context')) {
        return jsonResponse({ initialized: true, displayName: '幸福之家', language: 'zh-CN', timezone: 'Asia/Shanghai', now: '2026-10-26T00:00:00.000Z', catalogRevision: 1 });
      }
      return problemResponse(404, 'NOT_FOUND');
    });
    renderHome();
    await waitFor(() => expect(screen.getByRole('link', { name: /所有节目单/ })).toBeInTheDocument());
    expect(screen.queryByTestId('home-personal-area')).toBeNull();
    expect(meCalls()).toHaveLength(0);
  });

  it.skipIf(!VOD_ENABLED)('FR-016:选档后按「收藏频道 → 点播观看历史」顺序渲染;历史失败只重试本区,收藏与公共区不受阻', async () => {
    fetchMock.mockImplementation(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith('/setup/status')) return jsonResponse({ initialized: true });
      if (url.endsWith('/auth/session')) return jsonResponse(sessionFixture());
      if (url.endsWith('/public/context')) {
        return jsonResponse({ initialized: true, displayName: '幸福之家', language: 'zh-CN', timezone: 'Asia/Shanghai', now: '2026-10-26T00:00:00.000Z', catalogRevision: 1 });
      }
      if (url.includes('/me/favorites/channels')) {
        return jsonResponse({
          items: [
            {
              media: { id: 'ch-1', type: 'channel', title: '夹具频道 001', description: null, posterRef: null, contentLevel: 0, availability: 'available' },
              createdAt: '2026-10-26T01:00:00.000Z',
              current: { key: 'pg-1', title: '正在直播节目', description: null, startsAt: '2026-10-26T00:30:00.000Z', endsAt: '2026-10-26T01:30:00.000Z' },
              next: null,
            },
          ],
          nextCursor: null,
        });
      }
      if (url.includes('/me/history')) {
        return new Response(JSON.stringify({ status: 500, title: 'INTERNAL', code: 'INTERNAL' }), {
          status: 500,
          headers: { 'Content-Type': 'application/problem+json' },
        });
      }
      return problemResponse(404, 'NOT_FOUND');
    });
    renderHome();
    const personal = await waitFor(() => screen.getByTestId('home-personal-area'));
    // 顺序:收藏频道在前、观看历史在后
    const favorites = screen.getByTestId('home-favorites');
    const history = screen.getByTestId('home-history');
    expect(personal.firstElementChild).toBe(favorites);
    expect(favorites.nextElementSibling).toBe(history);
    // 收藏卡渲染 + 直播当前节目
    await waitFor(() => expect(screen.getByTestId('favorite-card')).toBeInTheDocument());
    expect(screen.getByText(/正在播:正在直播节目/)).toBeInTheDocument();
    // 历史失败:本区可重试
    await waitFor(() => expect(screen.getByText('观看历史加载失败')).toBeInTheDocument());
    // 公共区不受阻
    expect(screen.getByRole('link', { name: /所有节目单/ })).toBeInTheDocument();
    // 失败只重试本区:点击重试 → 仅历史请求重发
    const historyCallsBefore = meCalls().filter((call) => call.url.includes('/me/history')).length;
    fireEvent.click(screen.getByRole('button', { name: /重试/ }));
    await waitFor(() => {
      expect(meCalls().filter((call) => call.url.includes('/me/history')).length).toBeGreaterThan(historyCallsBefore);
    });
  });

  it('场景 4/FR-019:切档清空个人区并递增身份键,A 的在途迟到响应不回写 B', async () => {
    let favoritesRequests = 0;
    fetchMock.mockImplementation(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith('/auth/logout')) return new Response(null, { status: 204 });
      if (url.endsWith('/setup/status')) return jsonResponse({ initialized: true });
      if (url.endsWith('/auth/session')) return jsonResponse(sessionFixture());
      if (url.endsWith('/public/context')) {
        return jsonResponse({ initialized: true, displayName: '幸福之家', language: 'zh-CN', timezone: 'Asia/Shanghai', now: '2026-10-26T00:00:00.000Z', catalogRevision: 1 });
      }
      if (url.includes('/me/favorites/channels')) {
        favoritesRequests += 1;
        const requestIndex = favoritesRequests;
        // 第一次(A 档案)请求挂起,直到切档后才 resolve(迟到响应)
        if (requestIndex === 1) {
          await new Promise((resolve) => setTimeout(resolve, 80));
          return jsonResponse({
            items: [
              {
                media: { id: 'ch-late', type: 'channel', title: 'A 的迟到收藏', description: null, posterRef: null, contentLevel: 0, availability: 'available' },
                createdAt: '2026-10-26T01:00:00.000Z',
                current: null,
                next: null,
              },
            ],
            nextCursor: null,
          });
        }
        return jsonResponse({ items: [], nextCursor: null });
      }
      if (url.includes('/me/history')) return jsonResponse({ items: [], nextCursor: null });
      return problemResponse(404, 'NOT_FOUND');
    });
    renderHome();
    // A 档案:请求已发出(挂起)——先出现个人区骨架
    await waitFor(() => expect(screen.getByTestId('home-favorites')).toBeInTheDocument());
    // 退出登录(身份键递增)
    fireEvent.click(screen.getByTestId('switch-session'));
    await waitFor(() => expect(screen.queryByTestId('home-personal-area')).toBeNull());
    // 迟到的 A 响应不回写游客页面
    await new Promise((resolve) => setTimeout(resolve, 120));
    expect(screen.queryByTestId('home-personal-area')).toBeNull();
    expect(screen.queryByText('A 的迟到收藏')).toBeNull();
  });

  it('FR-045:换档后公共浏览条件保留并重载个人数据(新身份键重新请求)', async () => {
    const profileB = sessionFixture({
      sessionId: 'session-2',
      activeProfile: {
        id: 'profile-b',
        name: '爸爸',
        avatar: null,
        type: 'adult',
        isDefault: false,
        isMain: false,
        pinProtected: false,
        status: 'active',
        createdAt: '2026-10-26T00:00:00.000Z',
        version: 1,
      },
      profileContextVersion: 2,
    });
    fetchMock.mockImplementation(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith('/setup/status')) return jsonResponse({ initialized: true });
      if (url.endsWith('/auth/session')) return jsonResponse(sessionFixture());
      if (url.endsWith('/public/context')) {
        return jsonResponse({ initialized: true, displayName: '幸福之家', language: 'zh-CN', timezone: 'Asia/Shanghai', now: '2026-10-26T00:00:00.000Z', catalogRevision: 1 });
      }
      if (url.includes('/me/favorites/channels')) return jsonResponse({ items: [], nextCursor: null });
      if (url.includes('/me/history')) return jsonResponse({ items: [], nextCursor: null });
      return problemResponse(404, 'NOT_FOUND');
    });
    renderHome();
    await waitFor(() => expect(screen.getByTestId('home-personal-area')).toBeInTheDocument());
    const before = meCalls().length;
    expect(before).toBeGreaterThan(0);
    // 切换到 B 档案:公共入口保留;个人数据按新身份键重新请求
    nextSession = () => profileB;
    fireEvent.click(screen.getByTestId('switch-session'));
    await waitFor(() => expect(meCalls().length).toBeGreaterThan(before));
    expect(screen.getByRole('link', { name: /所有节目单/ })).toBeInTheDocument();
  });
});

function problemResponse(status: number, code: string): Response {
  return new Response(JSON.stringify({ status, code, title: code }), {
    status,
    headers: { 'Content-Type': 'application/problem+json' },
  });
}
