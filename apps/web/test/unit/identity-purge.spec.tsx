/**
 * T029(006 · US3):个人数据缓存隔离负向单测(安全底线)。
 *
 * 权威:docs/specs/006-heroui-react-query-refactor/contracts/data-access.md
 * 「身份切换」行(cancel→remove→mutationCache.clear→再更新身份状态)+ spec.md
 * US3 验收场景 1–4 + FR-016/017/020/021/022(宪法原则二/三)。负向断言:
 * a. purgePersonalData 清除 profile+settings 域条目,谓词外 public 条目原样保留
 *    (切档/登出后公共浏览零中断,US3 场景 3);
 * b. 清除时刻的在途个人查询被中止(signal aborted),迟到的旧响应不落缓存、
 *    观察端不可见(US3 场景 2);同 client 上在途公共查询不受影响;
 * c. mutationCache 一并清空(spy 契约 + 真实 pending 变更被清除两层面);
 * d. 401 全局分流(T031):FetchApiError(401) 经单例 QueryCache.onError →
 *    notifyUnauthorized → 注册 handler;同一轮(2s 窗口)并发 401 只触发一次,
 *    超窗后再触发;非 401 不触发;
 * e. SessionProvider 集成:切档/登出时域清除严格先于新身份状态可见
 *    (QueryCache removed 事件先于 personalCacheKey 变化的 commit 副作用);
 *    401 经查询层触发 handler → 域清除 + 收敛 anonymous,且无重取循环。
 */

import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { act, render, renderHook, screen, waitFor } from '@testing-library/react';
import { useEffect, useState, type ReactNode } from 'react';
import { FetchApiError } from '../../src/shared/fetch';
import {
  notifyUnauthorized,
  queryClient as appQueryClient,
  setUnauthorizedHandler,
} from '../../src/shared/query/client';
import { purgeAll, purgePersonalData } from '../../src/shared/query/scopes';
import { queryKeys } from '../../src/shared/query/keys';
import { useAppMutation, useAppQuery } from '../../src/shared/query/hooks';
import { SessionProvider, useSession } from '../../src/app/session-provider';
import type { AccountSession, ProfileSummary } from '../../src/app/session-types';
import { createQueryWrapper, createTestQueryClient, deferred } from '../helpers/query-test-utils';

// ────────────────────────── 夹具与会话观察探针 ──────────────────────────

function profileFixture(id: string): ProfileSummary {
  return {
    id,
    name: `档案-${id}`,
    avatar: null,
    type: 'adult',
    isDefault: false,
    isMain: id === 'main',
    pinProtected: false,
    status: 'active',
    createdAt: '2026-10-26T00:00:00.000Z',
    version: 1,
  };
}

function sessionFixture(overrides: Partial<AccountSession> = {}): AccountSession {
  return {
    sessionId: 'session-1',
    account: { id: 'acc-1', username: 'admin', role: 'owner' },
    activeProfile: profileFixture('profile-a'),
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

/** 泵若干宏任务:放行被取消查询的收尾通知与库内部忽略链 */
async function pumpTasks(): Promise<void> {
  for (let i = 0; i < 3; i += 1) {
    await Promise.resolve();
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 0);
    });
  }
}

/** 身份观察探针:personalCacheKey 每次变化(即新身份 commit)时向 events 打点 */
function IdentityProbe({ events }: { events: string[] }): ReactNode {
  const session = useSession();
  const personalCacheKey = session.personalCacheKey;
  useEffect(() => {
    events.push(`identity:${personalCacheKey ?? '-'}`);
  }, [personalCacheKey, events]);
  return (
    <div>
      <span data-testid="status">{session.status}</span>
      <span data-testid="cache-key">{personalCacheKey ?? '-'}</span>
      <button type="button" data-testid="refresh" onClick={() => void session.refresh()}>
        refresh
      </button>
      <button type="button" data-testid="logout" onClick={() => void session.logout()}>
        logout
      </button>
    </div>
  );
}

/** 401 触发探针:点击后挂载一个恒 401 的个人查询(经单例 QueryCache.onError 分流) */
function UnauthorizedProbe(): ReactNode {
  const session = useSession();
  const [fire, setFire] = useState(false);
  useAppQuery({
    domain: 'profile',
    queryKey: queryKeys.profile('profile-a').favorites(),
    queryFn: (): Promise<string> =>
      Promise.reject(new FetchApiError({ status: 401, title: '会话失效' })),
    enabled: fire,
    // staleTime 0:预置缓存也不阻挠触发——点击后必发请求,401 才能进入全局分流
    staleTime: 0,
  });
  return (
    <div>
      <span data-testid="status">{session.status}</span>
      <button type="button" data-testid="fire-401" onClick={() => setFire(true)}>
        fire-401
      </button>
    </div>
  );
}

let fetchMock: Mock;

beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  // 复位单例的 handler/缓存/变更队列,隔离跨用例状态(含 notifyUnauthorized 去重外的副作用)
  setUnauthorizedHandler(() => undefined);
  appQueryClient.clear();
});

// ────────────────────────── a. 域清除:个人域清空、公共域保留 ──────────────────────────

describe('purgePersonalData · 域清除与公共域保留(FR-016/020,US3 场景 3)', () => {
  it("清除全部 profile+settings 条目(跨档案/多键),谓词外 'public' 条目逐字保留", () => {
    const client = createTestQueryClient();
    const publicKey = queryKeys.public.context();
    const favA = queryKeys.profile('profile-a').favorites();
    const favB = queryKeys.profile('profile-b').favorites();
    const historyA = queryKeys.profile('profile-a').history({ page: 1, pageSize: 20 });
    const progressA = queryKeys.profile('profile-a').progress('m1');
    const account = queryKeys.settings.account();
    const sources = queryKeys.settings.sources();
    client.setQueryData(publicKey, '公共上下文');
    client.setQueryData(favA, 'A 的收藏');
    client.setQueryData(favB, 'B 的收藏');
    client.setQueryData(historyA, 'A 的历史');
    client.setQueryData(progressA, 'A 的进度');
    client.setQueryData(account, '账号设置');
    client.setQueryData(sources, '来源设置');

    // 前置:个人条目确实已入缓存(否则清除断言无意义)
    expect(client.getQueryData(favA)).toBe('A 的收藏');
    expect(client.getQueryData(account)).toBe('账号设置');

    purgePersonalData(client);

    // 个人域(profile+settings)全部不可命中
    expect(client.getQueryData(favA)).toBeUndefined();
    expect(client.getQueryData(favB)).toBeUndefined();
    expect(client.getQueryData(historyA)).toBeUndefined();
    expect(client.getQueryData(progressA)).toBeUndefined();
    expect(client.getQueryData(account)).toBeUndefined();
    expect(client.getQueryData(sources)).toBeUndefined();
    // 公共域保留:身份切换后公共浏览零中断(US3 验收场景 3)
    expect(client.getQueryData(publicKey)).toBe('公共上下文');
  });

  it('purgeAll 整库清空(含 public;登出可选,切档禁用)', () => {
    const client = createTestQueryClient();
    const publicKey = queryKeys.public.context();
    const favA = queryKeys.profile('profile-a').favorites();
    client.setQueryData(publicKey, '公共上下文');
    client.setQueryData(favA, 'A 的收藏');

    purgeAll(client);

    expect(client.getQueryData(publicKey)).toBeUndefined();
    expect(client.getQueryData(favA)).toBeUndefined();
  });
});

// ────────────────────────── b. 在途个人查询:中止 + 迟到响应丢弃 ──────────────────────────

describe('purgePersonalData · 在途请求处置(FR-020,US3 场景 2)', () => {
  it('清除时刻在途的个人查询被中止;迟到的旧响应不落缓存、观察端不可见;在途公共查询不受影响', async () => {
    const client = createTestQueryClient();
    const favKey = queryKeys.profile('profile-a').favorites();
    const guideKey = queryKeys.public.guide({ date: '2026-10-28' });

    const latePersonal = deferred<string>();
    const latePublic = deferred<string>();
    const personalSignals: AbortSignal[] = [];
    const publicSignals: AbortSignal[] = [];

    const personalQueryFn = vi.fn((ctx: { signal: AbortSignal }): Promise<string> => {
      personalSignals.push(ctx.signal);
      return latePersonal.promise;
    });
    const publicQueryFn = vi.fn((ctx: { signal: AbortSignal }): Promise<string> => {
      publicSignals.push(ctx.signal);
      return latePublic.promise;
    });

    const personal = renderHook(
      () => useAppQuery({ domain: 'profile', queryKey: favKey, queryFn: personalQueryFn }),
      { wrapper: createQueryWrapper(client) },
    );
    const pub = renderHook(
      () => useAppQuery({ domain: 'public', queryKey: guideKey, queryFn: publicQueryFn }),
      { wrapper: createQueryWrapper(client) },
    );
    await waitFor(() => expect(personalQueryFn).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(publicQueryFn).toHaveBeenCalledTimes(1));
    expect(personalSignals[0]?.aborted).toBe(false);

    purgePersonalData(client);

    // 个人在途请求被中止(cancel 先于 remove:防迟到响应回写)
    expect(personalSignals[0]?.aborted).toBe(true);
    // 公共在途请求不受清除影响(公共浏览不中断)
    expect(publicSignals[0]?.aborted).toBe(false);

    // 卸载旧身份页面(切档/登出语义),旧响应迟到
    personal.unmount();
    pub.unmount();
    await pumpTasks();
    latePersonal.resolve('迟到的 A 档收藏');
    await pumpTasks();

    // 迟到的旧响应不得写回缓存(含 removeQueries 重建的任何条目)
    expect(client.getQueryData(favKey)).toBeUndefined();
    // 个人域观察端已卸载,不再有个人条目生成
    expect(client.getQueryCache().findAll({ predicate: (q) => q.queryKey[0] !== 'public' })).toHaveLength(0);
  });
});

// ────────────────────────── c. mutationCache 清空 ──────────────────────────

describe('purgePersonalData · mutationCache 清空(契约第三步)', () => {
  it('调用 mutationCache.clear()(spy 契约)', () => {
    const client = createTestQueryClient();
    const clearSpy = vi.spyOn(client.getMutationCache(), 'clear');

    purgePersonalData(client);

    expect(clearSpy).toHaveBeenCalledTimes(1);
  });

  it('pending 变更被真实清除(经单例 useAppMutation 观察状态层面)', async () => {
    const pending = deferred<void>();
    const { result } = renderHook(
      () =>
        useAppMutation<string, void>({
          domain: 'profile',
          mutationFn: () => pending.promise,
          feedback: 'confirmed',
          onToast: vi.fn(),
        }),
      { wrapper: createQueryWrapper(appQueryClient) },
    );

    act(() => {
      result.current.mutate('x');
    });
    await waitFor(() => expect(appQueryClient.getMutationCache().getAll()).toHaveLength(1));

    purgePersonalData(appQueryClient);

    // 身份切换后,迟到的 onSettled/乐观残留无法再写回任何查询缓存
    expect(appQueryClient.getMutationCache().getAll()).toHaveLength(0);
  });
});

// ────────────────────────── d. 401 全局分流与每轮去重(T031/FR-017) ──────────────────────────

describe('setUnauthorizedHandler · 401 经 QueryCache.onError 的每轮去重', () => {
  it('同一轮(2s 窗口)两次 401 只触发一次 handler;超窗后再触发;非 401 不触发', async () => {
    // 受控时钟:取远小于真实时间的固定 now——本用例是文件内首个 401,
    // 模块初始 lastUnauthorizedAt=0 → 首个 401 必触发;真实时间(≫该值)不受污染
    vi.useFakeTimers({ now: 1_000_000 });
    const handler = vi.fn();
    setUnauthorizedHandler(handler);

    const failWith = (status: number): (() => Promise<never>) => {
      const err = new FetchApiError({ status, title: `HTTP ${status}` });
      return () => Promise.reject(err);
    };
    const surfacing401 = async (key: string): Promise<void> => {
      await appQueryClient.fetchQuery({ queryKey: ['probe-401', key], queryFn: failWith(401) }).catch(
        () => undefined,
      );
    };

    // 两次快速 401(同一轮风暴)+ 窗口内显式触发:handler 恰好一次(每轮去重)
    await surfacing401('a');
    await surfacing401('b');
    notifyUnauthorized();
    expect(handler).toHaveBeenCalledTimes(1);

    // 超过去重窗口(>2s):新一轮 401 再次触发
    vi.advanceTimersByTime(2_001);
    await surfacing401('c');
    expect(handler).toHaveBeenCalledTimes(2);

    // 非 401 错误不进入分流
    vi.advanceTimersByTime(2_001);
    await appQueryClient
      .fetchQuery({ queryKey: ['probe-401', 'd'], queryFn: failWith(404) })
      .catch(() => undefined);
    expect(handler).toHaveBeenCalledTimes(2);

    vi.useRealTimers();
  });
});

// ────────────────────────── e. SessionProvider 集成:顺序契约 + 401 接线 ──────────────────────────

describe('SessionProvider 集成 · 域清除同步先于身份状态更新(契约固定顺序)', () => {
  it('切档:purge 的缓存移除事件先于新 personalCacheKey 对观察端可见', async () => {
    const events: string[] = [];
    const unsubscribe = appQueryClient.getQueryCache().subscribe((event) => {
      if (event.type === 'removed') {
        events.push('purge:removed');
      }
    });

    try {
      fetchMock.mockResolvedValueOnce(jsonResponse(sessionFixture())); // 档案 A
      render(
        <SessionProvider>
          <IdentityProbe events={events} />
        </SessionProvider>,
      );
      await waitFor(() => expect(screen.getByTestId('cache-key').textContent).toBe('hh-1:profile-a:2'));

      // 档案 A 已产生个人数据;公共缓存与身份无关
      appQueryClient.setQueryData(queryKeys.profile('profile-a').favorites(), 'A 的收藏');
      appQueryClient.setQueryData(queryKeys.public.context(), '公共上下文');

      // 切档到档案 B(contextVersion 同步推进)
      fetchMock.mockResolvedValueOnce(
        jsonResponse(
          sessionFixture({ activeProfile: profileFixture('profile-b'), profileContextVersion: 3 }),
        ),
      );
      await act(async () => {
        screen.getByTestId('refresh').click();
      });
      await waitFor(() => expect(screen.getByTestId('cache-key').textContent).toBe('hh-1:profile-b:3'));

      // 顺序契约:removeQueries(域清除)严格发生在新身份 commit 可见之前
      const removedAt = events.indexOf('purge:removed');
      const identityAt = events.indexOf('identity:hh-1:profile-b:3');
      expect(removedAt).toBeGreaterThanOrEqual(0);
      expect(identityAt).toBeGreaterThan(removedAt);
      // 旧档案数据不可命中;公共域保留(US3 场景 1/3)
      expect(appQueryClient.getQueryData(queryKeys.profile('profile-a').favorites())).toBeUndefined();
      expect(appQueryClient.getQueryData(queryKeys.public.context())).toBe('公共上下文');
    } finally {
      unsubscribe();
    }
  });

  it('登出:域清除(含网络失败路径)先于身份状态收敛 anonymous', async () => {
    const events: string[] = [];
    const unsubscribe = appQueryClient.getQueryCache().subscribe((event) => {
      if (event.type === 'removed') {
        events.push('purge:removed');
      }
    });

    try {
      fetchMock.mockResolvedValueOnce(jsonResponse(sessionFixture()));
      render(
        <SessionProvider>
          <IdentityProbe events={events} />
        </SessionProvider>,
      );
      await waitFor(() => expect(screen.getByTestId('status').textContent).toBe('authenticated'));

      appQueryClient.setQueryData(queryKeys.profile('profile-a').favorites(), 'A 的收藏');
      appQueryClient.setQueryData(queryKeys.public.context(), '公共上下文');

      // 登出接口网络失败:本地清理照常(幂等登出),域清除同样执行
      fetchMock.mockRejectedValueOnce(new TypeError('network down'));
      await act(async () => {
        screen.getByTestId('logout').click();
      });
      await waitFor(() => expect(screen.getByTestId('status').textContent).toBe('anonymous'));

      const removedAt = events.indexOf('purge:removed');
      // 首个 'identity:-' 是挂载初始态(未认证),取最后一个——即登出后 anonymous 收敛的 commit 打点
      const identityAt = events.lastIndexOf('identity:-');
      expect(removedAt).toBeGreaterThanOrEqual(0);
      expect(identityAt).toBeGreaterThan(removedAt);
      expect(appQueryClient.getQueryData(queryKeys.profile('profile-a').favorites())).toBeUndefined();
      expect(appQueryClient.getQueryData(queryKeys.public.context())).toBe('公共上下文');
    } finally {
      unsubscribe();
    }
  });
});

describe('SessionProvider 集成 · 401 接线(T031):域清除 + 收敛 anonymous,无循环', () => {
  it('挂载后注册 handler:个人查询 401 → 个人域被清、公共域保留、会话收敛 anonymous、/auth/session 不被循环重发', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(sessionFixture()));
    // 探针经 useAppQuery 挂载:必须置于单例 QueryClientProvider 之内(handler 清除的正是单例)
    render(<SessionProvider><UnauthorizedProbe /></SessionProvider>, {
      wrapper: createQueryWrapper(appQueryClient),
    });
    await waitFor(() => expect(screen.getByTestId('status').textContent).toBe('authenticated'));

    // 预置两类缓存,验证 handler 的清除范围
    appQueryClient.setQueryData(queryKeys.profile('profile-a').favorites(), 'A 的收藏');
    appQueryClient.setQueryData(queryKeys.public.context(), '公共上下文');

    await act(async () => {
      screen.getByTestId('fire-401').click();
    });
    await waitFor(() => expect(screen.getByTestId('status').textContent).toBe('anonymous'));
    await pumpTasks();

    // handler(域清除 + 收敛 anonymous)已生效
    expect(appQueryClient.getQueryData(queryKeys.profile('profile-a').favorites())).toBeUndefined();
    expect(appQueryClient.getQueryData(queryKeys.public.context())).toBe('公共上下文');

    // 无循环:清除后观察端重建的一次 401 被去重吸收,恢复端点不被再次请求
    await pumpTasks();
    expect(fetchMock.mock.calls.filter(([url]) => String(url).includes('/auth/session'))).toHaveLength(1);
    expect(screen.getByTestId('status').textContent).toBe('anonymous');
  });
});
