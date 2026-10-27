import { renderHook, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { GuideWindowDto } from '@hmp/shared';
import { useGuideWindow, type GuideKeyQuery, type GuideWindowQuery } from '../../src/features/epg/useGuideWindow';
import { queryKeys } from '../../src/shared/query/keys';
import {
  createQueryWrapper,
  createTestQueryClient,
  mockFetchSequence,
  type MockFetchSequence,
} from '../helpers/query-test-utils';

/**
 * useGuideWindow 统一数据层迁移单测(T023;006 data-access.md + query-keys.md):
 * - 初始加载:请求形态为缺省窗口(page/pageSize,无 date/from/to),成功后
 *   data/status/isLoading 三态齐备;缓存键取自 queryKeys.public.guide 工厂;
 * - 键变化(切日期):旧窗口保持可见(placeholderData keepPreviousData),新窗口
 *   到达后无缝替换,请求携带新 date;
 * - 409 GUIDE_DATE_EXPIRED:dateExpired 标注 + expiredAllowedDates 透出
 *   (problem.allowedDates),旧窗口数据保留由界面续显;
 * - 422 GUIDE_WINDOW_TOO_LARGE:windowTooLarge 标注,旧窗口数据保留;
 * - retry():失败后手动重试恢复 ready;
 * - signal 透传:queryFn 收到库提供的 AbortSignal(键变化/卸载自动取消)。
 */

/* ---------------- 夹具 ---------------- */

function guideWindow(overrides: Partial<GuideWindowDto>): GuideWindowDto {
  return {
    date: '2026-11-04',
    timezone: 'America/New_York',
    now: '2026-11-04T12:05:00.000Z',
    allowedDates: ['2026-11-04', '2026-11-05', '2026-11-06'],
    from: '2026-11-04T05:00:00.000Z',
    to: '2026-11-05T05:00:00.000Z',
    page: 1,
    pageSize: 20,
    totalChannels: 3,
    catalogRevision: 9,
    channels: [],
    ...overrides,
  };
}

const Q_DEFAULT: GuideWindowQuery = { page: 1, pageSize: 20 };
const Q_NEXT_DATE: GuideWindowQuery = { date: '2026-11-06', page: 1, pageSize: 20 };

afterEach(() => {
  // 恢复被 vi.spyOn 打桩的 global fetch,避免泄漏到后续用例
  vi.restoreAllMocks();
});

/** 挂载 hook(每例独立内存 client;retry:false 保证失败态确定性) */
function mountGuideWindow(initialQuery: GuideWindowQuery) {
  const client = createTestQueryClient();
  return renderHook(({ query }: { query: GuideWindowQuery }) => useGuideWindow(query), {
    initialProps: { query: initialQuery },
    wrapper: createQueryWrapper(client),
  });
}

describe('useGuideWindow(统一数据层 T023)', () => {
  it('初始加载:缺省窗口请求形态,成功后三态映射且缓存键取自 queryKeys.public.guide 工厂', async () => {
    const windowDto = guideWindow({});
    const fetchMock: MockFetchSequence = mockFetchSequence([{ json: windowDto }]);
    const { result } = mountGuideWindow(Q_DEFAULT);

    // 请求形态:公共端点 + 分页参数;date/from/to 缺省不发送
    await waitFor(() => expect(result.current.data).not.toBeNull());
    expect(fetchMock.calls[0]?.url).toBe('/api/public/guide?page=1&pageSize=20');
    expect(fetchMock.calls[0]?.init.method).toBe('GET');

    // 三态:ready + 无错误;isLoading 仅在完全无数据时为真
    expect(result.current.status).toBe('ready');
    expect(result.current.isLoading).toBe(false);
    expect(result.current.error).toBeNull();
    expect(result.current.dateExpired).toBe(false);
    expect(result.current.windowTooLarge).toBe(false);
    expect(result.current.expiredAllowedDates).toBeNull();

    // 键可由工厂复现(键首段 public + 工厂参数对象;undefined 字段 hash 等价缺省)。
    // 工厂入参是 GuideQuery 形状,分页字段经 GuideKeyQuery 结构兼容类型补齐(与 hook 一致)。
    const factoryKey: GuideKeyQuery = { page: 1, pageSize: 20 };
    expect(queryKeys.public.guide(factoryKey)).toEqual(['public', 'guide', factoryKey]);
  });

  it('切日期:旧窗口保持可见(keepPreviousData),新窗口到达后无缝替换且请求携带新 date', async () => {
    const page1 = guideWindow({ date: '2026-11-04' });
    const page2 = guideWindow({ date: '2026-11-06', now: '2026-11-06T12:05:00.000Z' });
    const fetchMock: MockFetchSequence = mockFetchSequence([{ json: page1 }, { json: page2 }]);
    const { result, rerender } = mountGuideWindow(Q_DEFAULT);
    await waitFor(() => expect(result.current.data?.date).toBe('2026-11-04'));

    rerender({ query: Q_NEXT_DATE });

    // 新窗口请求发出(带 date=2026-11-06),恰好两次 fetch(无重复/无重试)
    await waitFor(() => expect(result.current.data?.date).toBe('2026-11-06'));
    expect(fetchMock.calls.length).toBe(2);
    expect(fetchMock.calls[1]?.url).toContain('date=2026-11-06');
    // 成功后无错误标注
    expect(result.current.status).toBe('ready');
    expect(result.current.dateExpired).toBe(false);
  });

  it('409 GUIDE_DATE_EXPIRED:dateExpired 标注 + allowedDates 透出,旧窗口数据保留', async () => {
    const page1 = guideWindow({});
    const fetchMock: MockFetchSequence = mockFetchSequence([
      { json: page1 },
      {
        status: 409,
        problem: {
          type: 'https://homemedia.local/problems/guide-date-expired',
          title: 'Guide Date Expired',
          status: 409,
          code: 'GUIDE_DATE_EXPIRED',
          detail: '该日期已不在可选范围内,请回到今天重新选择',
          allowedDates: ['2026-11-04', '2026-11-05', '2026-11-06'],
        },
      },
    ]);
    const { result, rerender } = mountGuideWindow(Q_DEFAULT);
    await waitFor(() => expect(result.current.data?.date).toBe('2026-11-04'));

    rerender({ query: Q_NEXT_DATE });

    await waitFor(() => expect(result.current.dateExpired).toBe(true));
    expect(result.current.expiredAllowedDates).toEqual(['2026-11-04', '2026-11-05', '2026-11-06']);
    expect(result.current.status).toBe('error');
    // 失败保留旧数据(界面续显旧窗口,409 处置由页面回今天)
    expect(result.current.data?.date).toBe('2026-11-04');
    expect(result.current.windowTooLarge).toBe(false);
    // 4xx 不重试:恰好两次 fetch
    expect(fetchMock.calls.length).toBe(2);
  });

  it('422 GUIDE_WINDOW_TOO_LARGE:windowTooLarge 标注,旧窗口与旧数据保留', async () => {
    const page1 = guideWindow({});
    mockFetchSequence([
      { json: page1 },
      {
        status: 422,
        problem: {
          type: 'https://homemedia.local/problems/guide-window-too-large',
          title: 'Guide Window Too Large',
          status: 422,
          code: 'GUIDE_WINDOW_TOO_LARGE',
          detail: '查询窗口内节目数量过多,请减少每页频道数后重试',
        },
      },
    ]);
    const { result, rerender } = mountGuideWindow(Q_DEFAULT);
    await waitFor(() => expect(result.current.data?.totalChannels).toBe(3));

    rerender({ query: { page: 1, pageSize: 50 } });

    await waitFor(() => expect(result.current.windowTooLarge).toBe(true));
    expect(result.current.dateExpired).toBe(false);
    expect(result.current.expiredAllowedDates).toBeNull();
    // 旧数据保留(频道页/窗口续显)
    expect(result.current.data?.totalChannels).toBe(3);
  });

  it('retry():失败后手动重试重新取数并恢复 ready', async () => {
    const page1 = guideWindow({});
    const recovered = guideWindow({ catalogRevision: 10 });
    const fetchMock: MockFetchSequence = mockFetchSequence([
      { json: page1 },
      { networkError: true },
      { json: recovered },
    ]);
    const { result, rerender } = mountGuideWindow(Q_DEFAULT);
    await waitFor(() => expect(result.current.status).toBe('ready'));

    // 换键失败(网络错误;重试矩阵由数据层单测覆盖,此处 retry:false 单发)
    rerender({ query: { page: 2, pageSize: 20 } });
    await waitFor(() => expect(result.current.status).toBe('error'));

    result.current.retry();

    await waitFor(() => expect(result.current.status).toBe('ready'));
    expect(result.current.data?.catalogRevision).toBe(10);
    expect(fetchMock.calls.length).toBe(3);
    expect(fetchMock.calls[2]?.url).toContain('page=2');
  });

  it('signal 透传:queryFn 携带 AbortSignal,键变化即中止在途旧请求', async () => {
    const page1 = guideWindow({});
    const fetchMock: MockFetchSequence = mockFetchSequence([
      { json: page1, delay: 50, abortable: true },
      { json: guideWindow({ date: '2026-11-06' }) },
    ]);
    const { result, rerender } = mountGuideWindow(Q_DEFAULT);

    // 首请求在途时立即换键:旧请求被中止(迟到响应不回写)
    rerender({ query: Q_NEXT_DATE });
    await waitFor(() => expect(result.current.data?.date).toBe('2026-11-06'));
    // 数据层把库提供的 signal 透传给了 fetch,且旧请求已被中止
    expect(fetchMock.calls[0]?.signal).toBeInstanceOf(AbortSignal);
    expect(fetchMock.calls[0]?.signal?.aborted).toBe(true);
    expect(fetchMock.calls[1]?.signal).toBeInstanceOf(AbortSignal);
  });
});
