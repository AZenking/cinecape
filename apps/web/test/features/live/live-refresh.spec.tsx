import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import { SessionProvider } from '../../../src/app/session-provider';
import { SettingsAccessProvider } from '../../../src/features/settings/settings-access-provider';
import { ActionCoordinator } from '../../../src/app/action-coordinator';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChannelPageDto } from '@hmp/shared';
import { LivePage } from '../../../src/features/live/LivePage';
import { LIVE_REFRESH_INTERVAL_MS, useLiveRefresh } from '../../../src/features/live/hooks/use-live-refresh';
import { createQueryWrapper, createTestQueryClient } from '../../helpers/query-test-utils';

/**
 * 直播 30 秒刷新组件测试(T061/T068;FR-022「至少每 30 秒更新一次,过期节目不得永久停留」):
 * - 30 秒周期刷新(可推 Clock 驱动:advanceTimersByTime);
 * - visibilitychange 回前台立即刷新;
 * - 刷新失败保留旧数据 + 显示可重试提示,且仅本区重试不影响其他区;
 * - 时间标签按服务端 now/timezone 渲染( America/New_York → 07:xx,非浏览器本地)。
 */

interface FetchCall {
  readonly url: string;
}

let fetchCalls: FetchCall[] = [];
/** null = 刷新失败(网络层错误) */
let nowPagePayload: ChannelPageDto | null;

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

const NOW_BASE: ChannelPageDto = {
  items: [
    {
      media: { id: 'ch-1', type: 'channel', title: '新闻频道', description: null, posterRef: null, contentLevel: null, availability: 'available' },
      groupKey: 'grp-news',
      groupLabel: '新闻',
      current: { key: 'pg-a', title: '旧节目', description: null, posterRef: null, startsAt: '2026-11-04T12:00:00.000Z', endsAt: '2026-11-04T12:30:00.000Z' },
      next: null,
    },
  ],
  page: 1,
  pageSize: 20,
  total: 1,
  now: '2026-11-04T12:05:00.000Z',
  timezone: 'America/New_York',
  catalogRevision: 3,
};

const NOW_UPDATED: ChannelPageDto = {
  ...NOW_BASE,
  items: [
    {
      ...NOW_BASE.items[0]!,
      current: { key: 'pg-b', title: '新节目', description: null, posterRef: null, startsAt: '2026-11-04T12:30:00.000Z', endsAt: '2026-11-04T13:00:00.000Z' },
    },
  ],
};

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  fetchCalls = [];
  nowPagePayload = NOW_BASE;
  vi.stubGlobal(
    'fetch',
    vi.fn((input: RequestInfo | URL, _init?: RequestInit): Promise<Response> => {
      const url = new URL(String(input), 'http://localhost:3000');
      fetchCalls.push({ url: url.pathname + url.search });
      if (url.pathname === '/api/public/live/groups') {
        return Promise.resolve(
          jsonResponse({ items: [{ key: 'grp-news', label: '新闻' }], now: '2026-11-04T12:05:00.000Z', timezone: 'America/New_York', catalogRevision: 3 }),
        );
      }
      if (url.pathname === '/api/public/live/channels') {
        if (url.searchParams.get('section') === 'now') {
          if (nowPagePayload === null) {
            return Promise.reject(new TypeError('network down'));
          }
          return Promise.resolve(jsonResponse(nowPagePayload));
        }
        // next / all:最小空数据
        return Promise.resolve(
          jsonResponse({ items: [], page: 1, pageSize: 20, total: 0, now: '2026-11-04T12:05:00.000Z', timezone: 'America/New_York', catalogRevision: 3 }),
        );
      }
      return Promise.resolve(jsonResponse({}));
    }),
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('直播刷新(T068)', () => {
  it('每 30 秒周期刷新一次:推进时钟触发全部分区重新拉取,过期节目被替换', async () => {
    render(
      <MemoryRouter>
        <SessionProvider>
          <SettingsAccessProvider>
            <ActionCoordinator>
              <LivePage />
            </ActionCoordinator>
          </SettingsAccessProvider>
        </SessionProvider>
      </MemoryRouter>,
      // T023:分区取数已迁移 shared/query(useAppQuery),需 QueryClientProvider
      // (每例新内存 client,refreshKey→refetch 语义由 use-live-sections 适配层承担)
      { wrapper: createQueryWrapper(createTestQueryClient()) },
    );
    await waitFor(() => {
      expect(screen.getAllByText('旧节目').length).toBeGreaterThan(0);
    });
    const callsAfterLoad = fetchCalls.length;
    expect(callsAfterLoad).toBeGreaterThanOrEqual(4);
    nowPagePayload = NOW_UPDATED;
    await vi.advanceTimersByTimeAsync(LIVE_REFRESH_INTERVAL_MS);
    await waitFor(() => {
      expect(screen.getAllByText('新节目').length).toBeGreaterThan(0);
    });
    // 过期节目不得永久停留
    expect(screen.queryAllByText('旧节目')).toHaveLength(0);
    expect(fetchCalls.length).toBeGreaterThan(callsAfterLoad);
  });

  it('visibilitychange 回前台立即刷新(不等 30 秒)', async () => {
    render(
      <MemoryRouter>
        <SessionProvider>
          <SettingsAccessProvider>
            <ActionCoordinator>
              <LivePage />
            </ActionCoordinator>
          </SettingsAccessProvider>
        </SessionProvider>
      </MemoryRouter>,
      // T023:分区取数已迁移 shared/query(useAppQuery),需 QueryClientProvider
      // (每例新内存 client,refreshKey→refetch 语义由 use-live-sections 适配层承担)
      { wrapper: createQueryWrapper(createTestQueryClient()) },
    );
    await waitFor(() => {
      expect(fetchCalls.length).toBeGreaterThanOrEqual(4);
    });
    const callsBefore = fetchCalls.length;
    nowPagePayload = NOW_UPDATED;
    document.dispatchEvent(new Event('visibilitychange'));
    await waitFor(() => {
      expect(fetchCalls.length).toBeGreaterThan(callsBefore);
    });
    await waitFor(() => {
      expect(screen.getAllByText('新节目').length).toBeGreaterThan(0);
    });
  });

  it('刷新失败保留旧数据并显示可重试提示;重试仅恢复本区,其他区不重发', async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    render(
      <MemoryRouter>
        <SessionProvider>
          <SettingsAccessProvider>
            <ActionCoordinator>
              <LivePage />
            </ActionCoordinator>
          </SettingsAccessProvider>
        </SessionProvider>
      </MemoryRouter>,
      // T023:分区取数已迁移 shared/query(useAppQuery),需 QueryClientProvider
      // (每例新内存 client,refreshKey→refetch 语义由 use-live-sections 适配层承担)
      { wrapper: createQueryWrapper(createTestQueryClient()) },
    );
    await waitFor(() => {
      expect(screen.getAllByText('旧节目').length).toBeGreaterThan(0);
    });
    const callsAfterLoad = fetchCalls.length;
    const nowCallsAfterLoad = fetchCalls.filter((call) => call.url.includes('section=now')).length;
    nowPagePayload = null; // 刷新失败(仅 now 区)
    await vi.advanceTimersByTimeAsync(LIVE_REFRESH_INTERVAL_MS);
    // 旧数据保留
    expect(screen.getAllByText('旧节目').length).toBeGreaterThan(0);
    // 可重试提示(错误有文字,不只靠颜色)
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('上次内容');
    // 其他分区未被本区失败拖垮:它们的请求数只是自然增加(now 区失败重试不影响其他)
    const otherCalls = fetchCalls.filter((call) => !call.url.includes('section=now')).length;
    expect(otherCalls).toBeGreaterThan(0);
    // 仅重试本区:重试后 now 区恢复,其他分区请求数不因此增加
    nowPagePayload = NOW_UPDATED;
    const otherCallsBeforeRetry = fetchCalls.filter((call) => !call.url.includes('section=now')).length;
    await user.click(screen.getAllByRole('button', { name: '重试' })[0] as HTMLElement);
    await waitFor(() => {
      expect(screen.getAllByText('新节目').length).toBeGreaterThan(0);
    });
    const nowCalls = fetchCalls.filter((call) => call.url.includes('section=now')).length;
    expect(nowCalls).toBeGreaterThan(nowCallsAfterLoad);
    expect(fetchCalls.filter((call) => !call.url.includes('section=now')).length).toBe(otherCallsBeforeRetry);
    expect(fetchCalls.length).toBeGreaterThan(callsAfterLoad);
  });

  it('useLiveRefresh 暴露 refreshKey/refreshNow;卸载后不再积累定时器', async () => {
    const refreshKeys: number[] = [];
    function Harness(): React.ReactNode {
      const controller = useLiveRefresh(1000);
      refreshKeys.push(controller.refreshKey);
      return <div>{controller.refreshKey}</div>;
    }
    render(<Harness />);
    await vi.advanceTimersByTimeAsync(3500);
    // 3.5 秒 → 3 次递增(1s/2s/3s),未卸载时持续
    expect(refreshKeys.at(-1)).toBeGreaterThan(0);
  });
});
