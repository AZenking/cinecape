/**
 * T024(006 · US2):收藏乐观更新单测(先红后绿;contracts/data-access.md「乐观更新」行 + FR-013/Q1)。
 *
 * 渲染基座:真实 QueryClient(createTestQueryClient)+ 应用 Provider 栈
 * (SessionProvider/ActionCoordinator 提供身份与意图面,AppToastRegion 承接提示),
 * fetch 以 vi.stubGlobal 打桩并产出真 Response(与 shared/fetch 解析链一致)。
 *
 * 覆盖面:
 * - 立即性:点击星标后、服务端未决期间,queryKeys.profile(pid).favorites() 缓存
 *   已被乐观改写——列表探针立即少一项(optimistic.apply),星标文案立即翻面;
 * - 失败回滚:服务端拒绝 → 快照回滚(条目复原)+ formatApiError toast;
 * - 对账:onSettled 无条件失效 → 重取 GET /me/favorites/channels 以服务端真值回填;
 * - 去重:pending 期间重复点击仅一次请求(FR-014);
 * - 新增方向:收藏(乐观插入既有缓存列表)同样立即可见。
 */

import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router';
import type { ReactNode } from 'react';
import { AppToastRegion } from '../../src/shared/ui';
import { ActionCoordinator } from '../../src/app/action-coordinator';
import { SessionProvider, useSession } from '../../src/app/session-provider';
import { SettingsAccessProvider } from '../../src/features/settings/settings-access-provider';
import type { AccountSession } from '../../src/app/session-types';
import { queryKeys } from '../../src/shared/query/keys';
import { formatApiError } from '../../src/shared/query/error';
import { queryClient as appQueryClient } from '../../src/shared/query/client';
import {
  useFavoriteChannelsQuery,
} from '../../src/features/favorites/use-favorites';
import { FavoriteStarButton } from '../../src/features/favorites/favorite-star-button';
import { deferred } from '../helpers/query-test-utils';
import type { Deferred } from '../helpers/query-test-utils';

/** 身份夹具:与 home-personal-area.spec.tsx 同形(当前档案 profile-a) */
const PROFILE_ID = 'profile-a';

function sessionFixture(): AccountSession {
  return {
    sessionId: 'session-1',
    account: { id: 'acc-1', username: 'admin', role: 'owner' },
    activeProfile: {
      id: PROFILE_ID,
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
  };
}

function mediaSummary(id: string, title: string): {
  id: string;
  type: 'channel';
  title: string;
  description: null;
  posterRef: null;
  contentLevel: number;
  availability: 'available';
} {
  return {
    id,
    type: 'channel',
    title,
    description: null,
    posterRef: null,
    contentLevel: 0,
    availability: 'available',
  };
}

function favoriteItem(id: string, title: string): {
  media: ReturnType<typeof mediaSummary>;
  createdAt: string;
  current: null;
  next: null;
} {
  return {
    media: mediaSummary(id, title),
    createdAt: '2026-10-26T01:00:00.000Z',
    current: null,
    next: null,
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

/** 收藏端点路由行为(各用例按需覆写;缺省 list 空 / put/remove 204) */
interface FavoritesRoutes {
  list: () => Response | Promise<Response>;
  put: () => Response | Promise<Response>;
  remove: () => Response | Promise<Response>;
}

let fetchMock: Mock;
let routes: FavoritesRoutes;

beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
  // 乐观写/回滚/失效固定经模块级单例(queryClient,T004 单例语义):
  // 观察端必须挂同一 client;每例先清空防止跨例泄漏
  appQueryClient.clear();
  routes = {
    list: () => jsonResponse({ items: [], nextCursor: null }),
    put: () => new Response(null, { status: 204 }),
    remove: () => new Response(null, { status: 204 }),
  };
  fetchMock.mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = String(init?.method ?? 'GET').toUpperCase();
    if (url.endsWith('/auth/session')) {
      return jsonResponse(sessionFixture());
    }
    if (url.includes('/me/favorites/channels')) {
      if (method === 'GET') return await routes.list();
      if (method === 'PUT') return await routes.put();
      if (method === 'DELETE') return await routes.remove();
    }
    return problemResponse(404, 'NOT_FOUND');
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  appQueryClient.clear();
});

/** 收藏端点调用统计(仅 /me/favorites/channels;会话恢复等其余请求不计) */
function favoriteCalls(method: string): number {
  return fetchMock.mock.calls.filter(
    (call) =>
      String(call[0]).includes('/me/favorites/channels') &&
      String(call[1]?.method ?? 'GET').toUpperCase() === method,
  ).length;
}

/** 列表探针:经真实 useFavoriteChannelsQuery 渲染共享缓存(代表首页收藏列表 UI) */
function FavoritesListProbe(): ReactNode {
  const session = useSession();
  const profileId = session.session?.activeProfile?.id ?? null;
  const query = useFavoriteChannelsQuery(profileId, { limit: 20 });
  if (query.isPending) {
    return <p data-testid="probe-pending">加载中</p>;
  }
  if (query.isError) {
    return (
      <p role="alert" data-testid="probe-error">
        {formatApiError(query.error)}
      </p>
    );
  }
  return (
    <ul data-testid="probe-list">
      {query.data.items.map((item) => (
        <li key={item.media.id} data-testid="probe-item">
          {item.media.title}
        </li>
      ))}
    </ul>
  );
}

/**
 * 渲染基座:真实 QueryClient + 预置收藏缓存 + 独立星标按钮 + 列表探针。
 * 与应用根 providers.tsx 同构(QueryClientProvider 最外层 + AppToastRegion)。
 */
function renderFavoritesHarness(
  media: { readonly mediaId: string; readonly title: string; readonly favorited: boolean },
  seedItems: readonly ReturnType<typeof favoriteItem>[],
): void {
  // 数据层乐观路径固定写模块级单例(T004):观察端挂同一实例,预置新鲜缓存
  // (30s 窗口内):挂载期不发生 GET,乐观/对账计数从零开始
  appQueryClient.setQueryData(queryKeys.profile(PROFILE_ID).favorites(), {
    items: [...seedItems],
    nextCursor: null,
  });
  render(
    <MemoryRouter>
      <QueryClientProvider client={appQueryClient}>
        <AppToastRegion />
        <SessionProvider>
          <SettingsAccessProvider>
            <ActionCoordinator>
              <FavoritesListProbe />
              <FavoriteStarButton
                mediaId={media.mediaId}
                title={media.title}
                favorited={media.favorited}
              />
            </ActionCoordinator>
          </SettingsAccessProvider>
        </SessionProvider>
      </QueryClientProvider>
    </MemoryRouter>,
  );
}

describe('T024 · 收藏乐观更新(favorites optimistic)', () => {
  it('立即性:服务端未决期间乐观移除已生效(列表少一项 + 星标翻面),不提前重取', async () => {
    const pendingDelete: Deferred<void> = deferred();
    routes.remove = () => pendingDelete.promise.then(() => new Response(null, { status: 204 }));
    renderFavoritesHarness(
      { mediaId: 'ch-1', title: '夹具频道 001', favorited: true },
      [favoriteItem('ch-1', '夹具频道 001'), favoriteItem('ch-2', '夹具频道 002')],
    );
    await waitFor(() => expect(screen.getByTestId('probe-list')).toBeInTheDocument());
    expect(screen.getByText('夹具频道 001')).toBeInTheDocument();
    // 种子缓存新鲜:挂载期零请求
    expect(favoriteCalls('GET')).toBe(0);

    fireEvent.click(screen.getByRole('button', { name: '取消收藏 夹具频道 001' }));

    // 服务端 DELETE 仍挂起:乐观结果已可见(缓存条目移除 + 星标翻面)
    await waitFor(() => expect(screen.queryByText('夹具频道 001')).not.toBeInTheDocument());
    expect(screen.getByText('夹具频道 002')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '收藏 夹具频道 001' })).toBeInTheDocument();
    expect(favoriteCalls('DELETE')).toBe(1);
    expect(favoriteCalls('GET')).toBe(0); // 未决期间不做服务端对账

    pendingDelete.resolve();
    // onSettled 无条件失效 → 恰好一次对账重取
    await waitFor(() => expect(favoriteCalls('GET')).toBe(1));
  });

  it('失败回滚:服务端拒绝 → 条目复原 + formatApiError toast(错误不只靠颜色)', async () => {
    routes.remove = () => problemResponse(500, 'INTERNAL');
    renderFavoritesHarness(
      { mediaId: 'ch-1', title: '夹具频道 001', favorited: true },
      [favoriteItem('ch-1', '夹具频道 001'), favoriteItem('ch-2', '夹具频道 002')],
    );
    await waitFor(() => expect(screen.getByText('夹具频道 001')).toBeInTheDocument());

    fireEvent.click(screen.getByRole('button', { name: '取消收藏 夹具频道 001' }));

    // 回滚:条目回到列表(快照恢复),格式化错误经 Toast 呈现
    await waitFor(() => expect(screen.getByText('夹具频道 001')).toBeInTheDocument());
    await waitFor(() =>
      expect(screen.getByText('服务暂时不可用，请稍后重试')).toBeInTheDocument(),
    );
    expect(favoriteCalls('DELETE')).toBe(1); // 变更不重试(retry: 0)
    // 对账仍会发生:以服务端真值回填(拒绝后真值不变)
    await waitFor(() => expect(favoriteCalls('GET')).toBe(1));
  });

  it('去重:pending 期间重复点击不叠加请求(FR-014)', async () => {
    const pendingDelete: Deferred<void> = deferred();
    routes.remove = () => pendingDelete.promise.then(() => new Response(null, { status: 204 }));
    renderFavoritesHarness(
      { mediaId: 'ch-1', title: '夹具频道 001', favorited: true },
      [favoriteItem('ch-1', '夹具频道 001'), favoriteItem('ch-2', '夹具频道 002')],
    );
    await waitFor(() => expect(screen.getByTestId('probe-list')).toBeInTheDocument());

    fireEvent.click(screen.getByRole('button', { name: '取消收藏 夹具频道 001' }));
    await waitFor(() => expect(screen.queryByText('夹具频道 001')).not.toBeInTheDocument());
    // 乐观移除后按钮仍在(独立控件):翻面态再次点击必须被 isPending 门控拦截
    fireEvent.click(screen.getByRole('button', { name: '收藏 夹具频道 001' }));

    expect(favoriteCalls('DELETE')).toBe(1);
    pendingDelete.resolve();
    await waitFor(() => expect(favoriteCalls('GET')).toBe(1));
  });

  it('对账:onSettled 失效后以服务端真值回填列表', async () => {
    let listCalls = 0;
    routes.list = () => {
      listCalls += 1;
      return jsonResponse({ items: [favoriteItem('ch-2', '夹具频道 002')], nextCursor: null });
    };
    renderFavoritesHarness(
      { mediaId: 'ch-1', title: '夹具频道 001', favorited: true },
      [favoriteItem('ch-1', '夹具频道 001'), favoriteItem('ch-2', '夹具频道 002')],
    );
    await waitFor(() => expect(screen.getByTestId('probe-list')).toBeInTheDocument());
    expect(listCalls).toBe(0); // 挂载期吃种子缓存,不发 GET

    fireEvent.click(screen.getByRole('button', { name: '取消收藏 夹具频道 001' }));

    // 服务端真值:仅剩 ch-2 → 对账后列表与之逐条一致
    await waitFor(() => expect(listCalls).toBeGreaterThan(0));
    await waitFor(() => {
      const probe = screen.getByTestId('probe-list');
      expect(probe.textContent).not.toContain('夹具频道 001');
      expect(probe.textContent).toContain('夹具频道 002');
    });
  });

  it('收藏新增:乐观插入既有缓存列表(星标立即翻面,服务端未决即可见)', async () => {
    const pendingPut: Deferred<void> = deferred();
    routes.put = () => pendingPut.promise.then(() => new Response(null, { status: 204 }));
    renderFavoritesHarness(
      { mediaId: 'ch-3', title: '夹具频道 003', favorited: false },
      [favoriteItem('ch-2', '夹具频道 002')],
    );
    await waitFor(() => expect(screen.getByTestId('probe-list')).toBeInTheDocument());
    expect(screen.queryByText('夹具频道 003')).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: '收藏 夹具频道 003' }));

    // PUT 挂起期间:乐观插入已可见 + 星标翻面
    await waitFor(() => expect(screen.getByText('夹具频道 003')).toBeInTheDocument());
    expect(screen.getByRole('button', { name: '取消收藏 夹具频道 003' })).toBeInTheDocument();
    expect(favoriteCalls('PUT')).toBe(1);
    expect(favoriteCalls('GET')).toBe(0);

    pendingPut.resolve();
    await waitFor(() => expect(favoriteCalls('GET')).toBe(1));
  });
});
