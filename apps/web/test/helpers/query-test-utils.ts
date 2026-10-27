/**
 * 数据层测试基座(T008;006 · US2/US3 数据层单测共用)。
 *
 * 面向 shared/query(query-keys/error/hooks/client)的测试提供:
 * - createTestQueryClient():内存 QueryClient(retry 关闭保证行为确定性);
 * - createQueryWrapper(client):renderHook/render 用的 QueryClientProvider 包装;
 * - deferred<T>():手动决议的 Promise 控制器(编排在途/迟到响应);
 * - mockFetchSequence(responses):基于 vi.spyOn(globalThis,'fetch') 的可编程
 *   fetch 队列(json/problem+json/status/delay/abortable/网络错误),并记录
 *   每次调用(url/init/signal)供断言;publicFetch/privateFetch 均经此打桩;
 * - flushQueries(client):泵送宏任务直到 QueryClient 无在途查询。
 *
 * 注意:重试矩阵单测必须观测真实 client 工厂的重试策略,不得经
 * createTestQueryClient 的 retry:false 兜底(见 query-layer.spec.tsx §g)。
 */

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createElement } from 'react';
import type { ReactNode } from 'react';
import { vi } from 'vitest';
import type { MockInstance } from 'vitest';

/** 内存 QueryClient:查询/变更均不重试,避免重试时序干扰行为断言 */
export function createTestQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false },
    },
  });
}

/** 以指定 client 构造 renderHook/render 的 wrapper(QueryClientProvider) */
export function createQueryWrapper(
  client: QueryClient,
): (props: { children: ReactNode }) => ReactNode {
  return function QueryWrapper({ children }: { children: ReactNode }) {
    // 文件为 .ts:经 createElement 组装 JSX,保持文件名与任务指派一致
    return createElement(QueryClientProvider, { client }, children);
  };
}

export interface Deferred<T> {
  /** 尚未决议的 Promise(交给 queryFn/mutationFn 即可在测试侧掌控时序) */
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason?: unknown) => void;
}

/** 手动决议的 Promise 控制器:用于"挂起 → 断言中间态 → 决议 → 断言终态" */
export function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** mockFetchSequence 的单条响应剧本 */
export interface QueuedFetchResponse {
  /** 2xx JSON 响应体(Content-Type: application/json) */
  json?: unknown;
  /** RFC 9457 problem+json 响应体(Content-Type: application/problem+json) */
  problem?: Record<string, unknown>;
  /** HTTP 状态码;缺省:有 problem → 400,否则 200 */
  status?: number;
  /** 响应挂起毫秒数(模拟网络延迟;0 = 立即返回) */
  delay?: number;
  /** true 时挂起期间监听 init.signal,被中止即以原生 AbortError 拒绝 */
  abortable?: boolean;
  /** true 时不产出 Response,以原生 TypeError 拒绝(模拟网络层失败) */
  networkError?: boolean;
}

/** 已记录的一次 fetch 调用(供 signal 透传断言) */
export interface RecordedFetchCall {
  url: string;
  init: RequestInit;
  signal: AbortSignal | undefined;
}

export interface MockFetchSequence {
  /** vi.spyOn 得到的 fetch mock(可直接 toHaveBeenCalledTimes 断言) */
  mock: MockInstance<typeof fetch>;
  /** 依发生顺序记录的调用(url/init/signal) */
  calls: RecordedFetchCall[];
  /** 恢复原始 fetch(测试 afterEach 中调用) */
  restore: () => void;
}

/** 按 spec 产出真实 Response(problem+json/json/裸状态),走 fetch.ts 原生解析路径 */
function buildResponse(spec: QueuedFetchResponse): Response {
  const status = spec.status ?? (spec.problem !== undefined ? 400 : 200);
  if (spec.problem !== undefined) {
    return new Response(JSON.stringify(spec.problem), {
      status,
      headers: { 'Content-Type': 'application/problem+json' },
    });
  }
  if (spec.json !== undefined) {
    return new Response(JSON.stringify(spec.json), {
      status,
      headers: { 'Content-Type': 'application/json' },
    });
  }
  return new Response(null, { status });
}

/** 等待 ms 毫秒;signal 先中止则立即以原生 DOMException('AbortError') 拒绝 */
async function waitOrAbort(
  ms: number,
  signal: AbortSignal | undefined | null,
): Promise<void> {
  if (ms <= 0) return;
  await new Promise<void>((resolve, reject) => {
    const finish = (): void => {
      clearTimeout(timer);
      resolve();
    };
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(new DOMException('This operation was aborted', 'AbortError'));
    };
    const timer = setTimeout(finish, ms);
    if (signal) {
      if (signal.aborted) {
        onAbort();
        return;
      }
      signal.addEventListener('abort', onAbort, { once: true });
    }
  });
}

/**
 * 以 vi.spyOn 打桩 global fetch,并按剧本顺序逐次出队响应。
 * 队列耗尽后的多余调用以显式错误拒绝(暴露实现层的意外请求)。
 */
export function mockFetchSequence(responses: QueuedFetchResponse[]): MockFetchSequence {
  // jsdom 环境下 global fetch 来自 Node 运行时;极端环境缺失时先补位再 spy
  if (typeof globalThis.fetch !== 'function') {
    Object.defineProperty(globalThis, 'fetch', {
      value: async (): Promise<Response> => new Response(null, { status: 501 }),
      configurable: true,
      writable: true,
    });
  }
  const calls: RecordedFetchCall[] = [];
  const queue = [...responses];
  const mock: MockInstance<typeof fetch> = vi.spyOn(globalThis, 'fetch');
  mock.mockImplementation(
    (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const url =
        typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      const signal = init?.signal;
      calls.push({ url, init: init ?? {}, signal: signal ?? undefined });
      const spec = queue.shift();
      if (spec === undefined) {
        return Promise.reject(
          new Error(`mockFetchSequence: fetch 剧本队列已空(第 ${calls.length} 次意外调用): ${url}`),
        );
      }
      const run = async (): Promise<Response> => {
        await waitOrAbort(spec.delay ?? 0, spec.abortable === true ? signal : undefined);
        if (spec.networkError === true) {
          throw new TypeError('fetch failed');
        }
        return buildResponse(spec);
      };
      return run();
    },
  );
  return {
    mock,
    calls,
    restore: () => {
      mock.mockRestore();
    },
  };
}

/**
 * 泵送宏任务直到 client 上再无在途查询(或有界超时)。
 * 覆盖"决议 deferred → 观察者状态落定"所需的微/宏任务排空,不依赖 fake timers。
 */
export async function flushQueries(client: QueryClient, timeoutMs = 1000): Promise<void> {
  const startedAt = Date.now();
  while (client.isFetching() > 0 && Date.now() - startedAt < timeoutMs) {
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 0);
    });
  }
  // 再泵一轮微/宏任务,放行最后一次状态通知(React 订阅回调)
  for (let i = 0; i < 3; i += 1) {
    await Promise.resolve();
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 0);
    });
  }
}
