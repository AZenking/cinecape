/**
 * T018(006 · US2):数据层封装行为单测(内存 QueryClient + 打桩 fetch)。
 *
 * 覆盖 contracts/data-access.md 全局行为契约的可观测面:
 * a. SWR:public 域命中陈旧缓存 → 立即渲染 + 后台重取 + 无缝更新;
 * b. 设置型硬请求:gcTime 0 + staleTime 0 且不设 placeholder → 卸载即弃缓存、
 *    重进必硬请求,并以 isPending 门控骨架(陈旧值无处可显);
 * c. 乐观变更:onMutate 快照+apply → onError 回滚+错误 toast → onSettled
 *    失效对账(查询重取);
 * d. confirmed 变更:成功前无乐观写入;pending 期重复触发经 isPending 门控
 *    (button-level dedup,FR-014"去重或禁用触发源")恰好一次 mutationFn;
 * e. 取消语义:卸载中止在途 signal;键变化中止旧请求且过期响应不回写新键;
 * f. 错误映射:真 FetchApiError(problem+json)经 formatApiError 链呈现;
 *    单独单测链四层(码表 → detail → title → 兜底)与 isUnauthorizedError;
 * g. 重试矩阵(端到端策略观测):500→1、429→1、404→0、网络错误→1。
 *
 * 注意:本文件静态导入 shared/query(keys/error/hooks)——实现通道尚未落盘时
 * 整文件 RED 属 TDD 预期;模块就绪后必须全绿。
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, renderHook, render, screen, waitFor } from '@testing-library/react';
import { QueryClient } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { FetchApiError, publicFetch } from '../../src/shared/fetch';
import { formatApiError, isUnauthorizedError } from '../../src/shared/query/error';
// T004 模块级 QueryClient 单例:useAppMutation 的乐观写/回滚/失效固定经单例操作,
// 变更类测试的查询观察端必须挂同一 client(生产中 providers 挂载的正是它)
import { queryClient as appQueryClient } from '../../src/shared/query/client';
import { useAppMutation, useAppQuery } from '../../src/shared/query/hooks';
import { queryKeys } from '../../src/shared/query/keys';
import {
  createQueryWrapper,
  createTestQueryClient,
  deferred,
  flushQueries,
  mockFetchSequence,
} from '../helpers/query-test-utils';
import type { MockFetchSequence } from '../helpers/query-test-utils';

afterEach(() => {
  // 恢复被 vi.spyOn 打桩的 global fetch,避免泄漏到后续用例
  vi.restoreAllMocks();
  // 清空共享单例的缓存/变更队列,隔离乐观变更类用例
  appQueryClient.clear();
});

/** queryFn 共用形参类型(冻结契约:库提供 { signal },必须可透传) */
type QueryFn<T> = (ctx: { signal: AbortSignal }) => Promise<T>;
/** mutationFn 共用形参类型(冻结契约:(vars, ctx) ⇒ Promise;5.105 暂无 mutation 专用 signal) */
type MutationFn<TVars, TData> = (vars: TVars, ctx: { signal?: AbortSignal }) => Promise<TData>;
/** onToast 共用形参类型 */
type ToastFn = (msg: string, kind: 'success' | 'error') => void;

// ────────────────────────── a. SWR:陈旧缓存即显 + 后台刷新 ──────────────────────────

describe('useAppQuery · SWR(public 域)', () => {
  it('命中陈旧缓存立即渲染,后台重取后无缝更新', async () => {
    const client = createTestQueryClient();
    const key = queryKeys.public.media('m1');
    const secondFetch = deferred<string>();
    let queryCalls = 0;
    const queryFn = vi.fn((_ctx: { signal: AbortSignal }): Promise<string> => {
      queryCalls += 1;
      return queryCalls === 1 ? Promise.resolve('v1') : secondFetch.promise;
    });
    const wrapper = createQueryWrapper(client);

    // 第一次挂载:冷取并写入缓存
    const first = renderHook(
      () => useAppQuery({ domain: 'public', queryKey: key, queryFn, staleTime: 0 }),
      { wrapper },
    );
    await waitFor(() => expect(first.result.current.data).toBe('v1'));
    expect(first.result.current.isSuccess).toBe(true);
    first.unmount();

    // 第二次挂载(同 client):陈旧数据立即渲染,同时在途后台重取
    const second = renderHook(
      () => useAppQuery({ domain: 'public', queryKey: key, queryFn, staleTime: 0 }),
      { wrapper },
    );
    expect(second.result.current.data).toBe('v1'); // 缓存即显(无 pending 空窗)
    await waitFor(() => expect(queryFn).toHaveBeenCalledTimes(2)); // 后台重取已发起
    expect(second.result.current.data).toBe('v1'); // 刷新期间保持旧值

    secondFetch.resolve('v2');
    await waitFor(() => expect(second.result.current.data).toBe('v2')); // 无缝更新
    expect(second.result.current.isPending).toBe(false);
  });
});

// ────────────────────────── b. 设置型硬请求(gcTime 0 + staleTime 0) ──────────────────────────

describe('useAppQuery · 设置域硬请求(gcTime 0 + staleTime 0,无 placeholder)', () => {
  it('卸载即弃缓存:重新进入必硬请求且以 isPending 门控(陈旧值无处可显)', async () => {
    const client = createTestQueryClient();
    const key = queryKeys.settings.account();
    const firstFetch = deferred<string>();
    const secondFetch = deferred<string>();
    let queryCalls = 0;
    const queryFn = vi.fn((_ctx: { signal: AbortSignal }): Promise<string> => {
      queryCalls += 1;
      return queryCalls === 1 ? firstFetch.promise : secondFetch.promise;
    });
    const wrapper = createQueryWrapper(client);

    // 第一次进入:冷取
    const first = renderHook(() => useAppQuery({ domain: 'settings', queryKey: key, queryFn }), {
      wrapper,
    });
    expect(first.result.current.isPending).toBe(true); // 挂载即骨架门控
    firstFetch.resolve('第一轮值');
    await waitFor(() => expect(first.result.current.data).toBe('第一轮值'));
    first.unmount();

    // 卸载即弃(gcTime 0):条目不得残留
    await flushQueries(client);
    expect(client.getQueryData(key)).toBeUndefined();

    // 重新进入:必硬请求,且第一轮旧值无处可显(从 isPending 骨架开始)
    const second = renderHook(() => useAppQuery({ domain: 'settings', queryKey: key, queryFn }), {
      wrapper,
    });
    expect(second.result.current.isPending).toBe(true);
    expect(second.result.current.data).toBeUndefined();
    await waitFor(() => expect(queryFn).toHaveBeenCalledTimes(2)); // 进入必发新请求

    secondFetch.resolve('第二轮值');
    await waitFor(() => expect(second.result.current.data).toBe('第二轮值'));
    expect(second.result.current.isPending).toBe(false);
  });
});

// ────────────────────────── c. 乐观变更:回滚 + toast + 失效对账 ──────────────────────────

const FAVORITES_KEY: readonly unknown[] = queryKeys.profile('p1').favorites();

interface MutationProbeProps {
  queryFn: QueryFn<string>;
  mutationFn: MutationFn<string, void>;
  onToast: ToastFn;
}

/** 乐观收藏探针:查询渲染缓存值,按钮触发 optimistic 变更 */
function OptimisticProbe({ queryFn, mutationFn, onToast }: MutationProbeProps): ReactNode {
  const query = useAppQuery({ domain: 'profile', queryKey: FAVORITES_KEY, queryFn });
  const { mutate } = useAppMutation<string, void>({
    domain: 'profile',
    mutationFn,
    feedback: 'optimistic',
    optimistic: {
      queryKey: FAVORITES_KEY,
      apply: (_old: unknown, vars: string) => vars,
    },
    // invalidate 为"扁平键列表"(hooks.ts: readonly (readonly unknown[])[];每项即一个查询键)
    invalidate: [FAVORITES_KEY],
    rollbackToast: '收藏失败，已回滚',
    onToast,
  });
  return (
    <div>
      <div>数据:{query.data === undefined ? '空' : String(query.data)}</div>
      <button onClick={() => { mutate('新值'); }}>收藏</button>
    </div>
  );
}

describe('useAppMutation · optimistic', () => {
  it('mutationFn 拒绝 → UI 回滚旧值 + onToast(error) + onSettled 失效重取', async () => {
    // 乐观写/回滚/失效固定经模块级单例:观察端必须挂同一 client(T004 单例语义)
    const client = appQueryClient;
    const firstFetch = deferred<string>();
    const refetch = deferred<string>();
    let queryCalls = 0;
    const queryFn = vi.fn((_ctx: { signal: AbortSignal }): Promise<string> => {
      queryCalls += 1;
      return queryCalls === 1 ? firstFetch.promise : refetch.promise;
    });
    const failedMutation = deferred<void>();
    const mutationFn = vi.fn((_vars: string, _ctx: { signal?: AbortSignal }) => failedMutation.promise);
    const onToast = vi.fn((_msg: string, _kind: 'success' | 'error') => {});

    render(
      <OptimisticProbe queryFn={queryFn} mutationFn={mutationFn} onToast={onToast} />,
      { wrapper: createQueryWrapper(client) },
    );

    firstFetch.resolve('旧值');
    await screen.findByText('数据:旧值'); // 首次查询落定
    expect(queryFn).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole('button', { name: '收藏' }));

    // 乐观窗口:apply 已写缓存,变更尚未决议
    await waitFor(() => expect(screen.getByText('数据:新值')));

    failedMutation.reject(new Error('服务器拒绝'));

    // 回滚:UI 回到旧值,错误 toast 携带回滚文案
    await waitFor(() => expect(screen.getByText('数据:旧值')));
    expect(onToast).toHaveBeenCalledWith('收藏失败，已回滚', 'error');

    // onSettled 失效对账 → 查询自动重取(第 2 次 queryFn)
    await waitFor(() => expect(queryFn).toHaveBeenCalledTimes(2));
    refetch.resolve('服务器值');
    await screen.findByText('数据:服务器值');
  });
});

// ────────────────────────── d. confirmed 变更:无乐观写入 + pending 去重 ──────────────────────────

const SOURCES_KEY: readonly unknown[] = queryKeys.settings.sources();

function ConfirmedProbe({ queryFn, mutationFn, onToast }: MutationProbeProps): ReactNode {
  const query = useAppQuery({ domain: 'settings', queryKey: SOURCES_KEY, queryFn });
  // FR-014 去重契约:封装约定"重复触发以结果 isPending 门控触发源"(button-level dedup)
  const { mutate, isPending } = useAppMutation<string, void>({
    domain: 'settings',
    mutationFn,
    feedback: 'confirmed',
    // invalidate 为"扁平键列表"(hooks.ts: readonly (readonly unknown[])[];每项即一个查询键)
    invalidate: [SOURCES_KEY],
    successToast: '已保存',
    onToast,
  });
  return (
    <div>
      <div>数据:{query.data === undefined ? '空' : String(query.data)}</div>
      <div>变更中:{isPending ? '是' : '否'}</div>
      <button onClick={() => { if (!isPending) { mutate('a'); } }}>保存</button>
    </div>
  );
}

describe('useAppMutation · confirmed', () => {
  it('成功前无乐观写入;pending 期重复触发经 isPending 门控去重为一次 mutationFn;成功后 toast+失效', async () => {
    // 乐观写/回滚/失效固定经模块级单例:观察端必须挂同一 client(T004 单例语义)
    const client = appQueryClient;
    const firstFetch = deferred<string>();
    const refetch = deferred<string>();
    let queryCalls = 0;
    const queryFn = vi.fn((_ctx: { signal: AbortSignal }): Promise<string> => {
      queryCalls += 1;
      return queryCalls === 1 ? firstFetch.promise : refetch.promise;
    });
    const pendingMutation = deferred<void>();
    const mutationFn = vi.fn((_vars: string, _ctx: { signal?: AbortSignal }) => pendingMutation.promise);
    const onToast = vi.fn((_msg: string, _kind: 'success' | 'error') => {});

    render(
      <ConfirmedProbe queryFn={queryFn} mutationFn={mutationFn} onToast={onToast} />,
      { wrapper: createQueryWrapper(client) },
    );

    firstFetch.resolve('旧值');
    await screen.findByText('数据:旧值');

    // 第一次触发:进入 pending
    fireEvent.click(screen.getByRole('button', { name: '保存' }));
    await waitFor(() => expect(mutationFn).toHaveBeenCalledTimes(1));
    await screen.findByText('变更中:是');

    // pending 未落定期间重复触发(第二次快速点击):isPending 门控拦下
    fireEvent.click(screen.getByRole('button', { name: '保存' }));
    await flushQueries(client);
    expect(mutationFn).toHaveBeenCalledTimes(1); // 恰好一次 mutationFn

    // confirmed:等待期内不得有乐观写入,也不得提前失效查询/弹成功提示
    expect(screen.getByText('数据:旧值')).toBeInTheDocument();
    expect(queryFn).toHaveBeenCalledTimes(1);
    expect(onToast).not.toHaveBeenCalled();

    pendingMutation.resolve(undefined);

    // 成功:成功 toast + 失效声明的键 → 重取 → 新值
    await waitFor(() => expect(onToast).toHaveBeenCalledWith('已保存', 'success'));
    await waitFor(() => expect(queryFn).toHaveBeenCalledTimes(2));
    refetch.resolve('新值');
    await screen.findByText('数据:新值');
  });
});

// ────────────────────────── e. 取消语义:卸载/键变化中止 + 过期不回写 ──────────────────────────

describe('useAppQuery · 取消语义(FR-015)', () => {
  it('卸载中止在途 queryFn 的 signal', async () => {
    const client = createTestQueryClient();
    const hanging = deferred<string>();
    let captured: AbortSignal | undefined;
    const queryFn = vi.fn((ctx: { signal: AbortSignal }): Promise<string> => {
      captured = ctx.signal;
      return hanging.promise;
    });

    const { unmount } = renderHook(
      () => useAppQuery({ domain: 'public', queryKey: queryKeys.public.live(), queryFn }),
      { wrapper: createQueryWrapper(client) },
    );
    await waitFor(() => expect(queryFn).toHaveBeenCalledTimes(1)); // 请求在途

    unmount();
    await flushQueries(client);

    expect(captured?.aborted).toBe(true);
  });

  it('键变化中止旧请求,且迟到的旧响应不回写新键数据', async () => {
    const client = createTestQueryClient();
    const oldFetch = deferred<string>();
    const newFetch = deferred<string>();
    const signals: AbortSignal[] = [];
    const queryFn = vi.fn((ctx: { signal: AbortSignal }): Promise<string> => {
      signals.push(ctx.signal);
      return signals.length === 1 ? oldFetch.promise : newFetch.promise;
    });

    const { result, rerender } = renderHook(
      ({ id }) =>
        useAppQuery({ domain: 'public', queryKey: queryKeys.public.media(id), queryFn }),
      { initialProps: { id: 'a' }, wrapper: createQueryWrapper(client) },
    );
    await waitFor(() => expect(signals.length).toBe(1)); // 旧键在途

    rerender({ id: 'b' });
    await waitFor(() => expect(signals.length).toBe(2)); // 新键发起新请求
    expect(signals[0]?.aborted).toBe(true); // 旧请求被中止

    oldFetch.resolve('迟到的旧响应'); // 过期响应迟到
    newFetch.resolve('新响应');
    await waitFor(() => expect(result.current.data).toBe('新响应'));
    await flushQueries(client);
    // 旧响应不得覆盖新键数据
    expect(result.current.data).toBe('新响应');
    expect(result.current.error).toBeNull();
  });
});

// ────────────────────────── f. 错误映射(problem+json → 文案链) ──────────────────────────

describe('formatApiError · 文案链(码表 → detail → title → 兜底)', () => {
  it('detail 优先于 title;无 detail 回退 title;皆无回退通用兜底', () => {
    // code 不在码表内 → 落到 detail
    expect(
      formatApiError(
        new FetchApiError({
          status: 429,
          title: '限流标题',
          detail: '请求过于频繁，请稍后再试',
          code: '__UNMAPPED_CODE__',
        }),
      ),
    ).toBe('请求过于频繁，请稍后再试');
    // 无 detail → title
    expect(formatApiError(new FetchApiError({ status: 404, title: '资源不存在' }))).toBe(
      '资源不存在',
    );
    // code/detail/title 皆无 → 通用兜底
    expect(formatApiError(new FetchApiError({ status: 500, title: '' }))).toBe(
      '请求失败，请稍后重试',
    );
    // 非 FetchApiError(含 undefined)→ 通用兜底
    expect(formatApiError(new Error('普通错误'))).toBe('请求失败，请稍后重试');
    expect(formatApiError(undefined)).toBe('请求失败，请稍后重试');
  });

  it('若模块导出 PROBLEM_MESSAGES,则命中码的文案优先于 detail', async () => {
    const errorModule = (await import('../../src/shared/query/error')) as Record<string, unknown>;
    const messages = errorModule['PROBLEM_MESSAGES'];
    if (messages === null || typeof messages !== 'object') {
      // 码表未导出时不可观测:链的前两级(detail/title/兜底)已由上一用例钉死
      return;
    }
    const entries = Object.entries(messages as Record<string, string>);
    expect(entries.length).toBeGreaterThan(0);
    const [code, mapped] = entries[0] as [string, string];
    // 命中码表:即使带 detail 也以码表文案呈现
    expect(
      formatApiError(
        new FetchApiError({ status: 400, title: '标题', detail: '详情', code }),
      ),
    ).toBe(mapped);
  });
});

describe('isUnauthorizedError', () => {
  it('401 判真;403/普通错误/AbortError/undefined 判假', () => {
    expect(isUnauthorizedError(new FetchApiError({ status: 401, title: '会话无效' }))).toBe(true);
    expect(isUnauthorizedError(new FetchApiError({ status: 403, title: '禁止访问' }))).toBe(false);
    expect(isUnauthorizedError(new Error('普通错误'))).toBe(false);
    expect(isUnauthorizedError(new DOMException('This operation was aborted', 'AbortError'))).toBe(
      false,
    );
    expect(isUnauthorizedError(undefined)).toBe(false);
  });
});

describe('查询错误态 · 真实 FetchApiError 渲染(formatApiError 链)', () => {
  it('problem+json 查询失败 → 错误态呈现链式文案(无 code → detail)', async () => {
    const client = createTestQueryClient();
    // 打桩 fetch:problem+json 429(无 code → 链落到 detail,断言确定)
    const fetchStub: MockFetchSequence = mockFetchSequence([
      {
        status: 429,
        problem: {
          type: 'about:blank',
          title: 'TOO_MANY_REQUESTS',
          detail: '请求过于频繁，请稍后再试',
        },
      },
    ]);
    // queryFn = publicFetch 薄包装(signal 透传,经真实 fetch.ts 解析出 FetchApiError)
    const queryFn = vi.fn(
      (ctx: { signal: AbortSignal }): Promise<unknown> =>
        publicFetch('/public/context', { signal: ctx.signal }),
    );

    function ErrorProbe(): ReactNode {
      const query = useAppQuery({
        domain: 'public',
        queryKey: queryKeys.public.context(),
        queryFn,
      });
      if (query.isError) {
        return (
          <div role="alert">{formatApiError(query.error)}</div>
        );
      }
      return <div>加载中</div>;
    }

    render(<ErrorProbe />, { wrapper: createQueryWrapper(client) });

    await screen.findByRole('alert');
    expect(screen.getByRole('alert')).toHaveTextContent('请求过于频繁，请稍后再试');
    // queryFn 经公共档位发起,signal 透传到底座
    expect(queryFn).toHaveBeenCalledTimes(1);
    expect(fetchStub.calls[0]?.signal).toBeInstanceOf(AbortSignal);
    fetchStub.restore();
  });
});

// ────────────────────────── g. 重试矩阵(观测真实 client 工厂策略) ──────────────────────────

describe('client 重试矩阵(FR-014:查询整体 ≤1 次)', () => {
  it('500→1 次、429→1 次、404→0 次、网络 TypeError→1 次', async () => {
    const clientModule = (await import('../../src/shared/query/client')) as Record<string, unknown>;
    // 优先:显式导出的 queryRetry(failureCount, error)
    let retry: unknown = clientModule['queryRetry'];
    // 回退:模块级 QueryClient 单例 defaultOptions 中注册的重试策略函数
    if (typeof retry !== 'function' && clientModule['queryClient'] instanceof QueryClient) {
      const configured = clientModule['queryClient'].getDefaultOptions().queries?.retry;
      if (typeof configured === 'function') {
        retry = configured;
      }
    }
    expect(
      typeof retry,
      'client.ts 必须暴露可观测的重试策略:导出 queryRetry,或在 QueryClient defaultOptions.queries.retry 注册函数',
    ).toBe('function');
    const retryFn = retry as (failureCount: number, error: unknown) => unknown;

    const httpError = (status: number): FetchApiError =>
      new FetchApiError({ status, title: `HTTP ${status}` });
    // Number() 兼容 boolean 写法(true≈继续重试 / false≈停止)
    expect(Number(retryFn(0, httpError(500)))).toBe(1);
    expect(Number(retryFn(0, httpError(429)))).toBe(1);
    expect(Number(retryFn(0, httpError(404)))).toBe(0);
    expect(Number(retryFn(0, new TypeError('fetch failed')))).toBe(1);
  });
});
