import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import { SessionProvider } from '../../src/app/session-provider';
import { SettingsAccessProvider } from '../../src/features/settings/settings-access-provider';
import { ActionCoordinator } from '../../src/app/action-coordinator';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { GuideWindowDto } from '@hmp/shared';
import { GuidePage } from '../../src/features/epg/GuidePage';
import { createQueryWrapper, createTestQueryClient } from '../helpers/query-test-utils';

/**
 * EPG 节目单页组件测试(T109;FR-025/026/027、A-008、ui.md §6):
 * - 7 日期 Tab 仅「今天+6」并标注家庭时区(夹具 America/New_York,与 jsdom 时区明显不同:
 *   同一时刻显示 00:00–24:00 全天窗口而非浏览器本地,证明不依赖浏览器时区);
 * - 默认今天、展示该日完整 24 小时(A-008 全天视图;默认请求不带 date/from/to,
 *   由服务端按其冻结 now 返回该日真实日界;渲染窗口取响应 from/to,终点显示 24:00);
 * - 当前时间标识与「回到现在」(仅清 date/from/to 保留其余参数——012 url-state §1 规则4,
 *   按恢复后的语义重新请求);
 * - 空档与无节目频道显示「暂无节目」、频道不隐藏(FR-026);
 * - 频道页默认 20、可改最多 50;
 * - 409 GUIDE_DATE_EXPIRED:回今天并提示日期已更新、丢弃旧窗口响应(不渲染旧 date 数据);
 * - 422 GUIDE_WINDOW_TOO_LARGE:提示减少每页频道数并保留旧数据与频道页。
 *
 * T023:页面取数已迁移 shared/query(useAppQuery),render 以内存 QueryClient
 * 包裹(retry:false 保证行为确定性;每例 renderGuidePage 新建 client,缓存不跨例泄漏)。
 */

/* ---------------- 请求桩:按 URL 路由;记录全部 fetch 调用 ---------------- */

interface FetchCall {
  readonly url: string;
  readonly init: RequestInit | undefined;
}

let fetchCalls: FetchCall[] = [];
let fetchRouter: (url: URL) => { status: number; body: unknown } | unknown;

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': status >= 400 ? 'application/problem+json' : 'application/json' },
  });
}

function installFetchRouter(): void {
  fetchCalls = [];
  vi.stubGlobal(
    'fetch',
    vi.fn((input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const url = new URL(String(input), 'http://localhost:3000');
      fetchCalls.push({ url: url.pathname + url.search, init });
      // 协调器会话底座:游客恢复 401、部署已初始化
      if (url.pathname === '/api/auth/session') {
        return Promise.resolve(
          new Response(JSON.stringify({ status: 401, code: 'SESSION_INVALID', title: 'SESSION_INVALID' }), {
            status: 401,
            headers: { 'Content-Type': 'application/problem+json' },
          }),
        );
      }
      if (url.pathname === '/api/setup/status') {
        return Promise.resolve(jsonResponse({ initialized: true }));
      }
      const outcome = fetchRouter(url);
      if (outcome !== undefined && typeof outcome === 'object' && 'status' in (outcome as Record<string, unknown>)) {
        const { status, body } = outcome as { status: number; body: unknown };
        return Promise.resolve(jsonResponse(body, status));
      }
      return Promise.resolve(jsonResponse(outcome));
    }),
  );
}

/* ---------------- 夹具:服务端家庭时区 America/New_York ---------------- */

const TZ = 'America/New_York';
const NOW_ISO = '2026-11-04T12:05:00.000Z'; // 07:05 EST
const FROM_ISO = '2026-11-04T05:00:00.000Z'; // 00:00 EST(该日真实日界起点)
const TO_ISO = '2026-11-05T05:00:00.000Z'; // 24:00 EST(真实日界终点,终点标签显示 24:00)
const ALLOWED_DATES = ['2026-11-04', '2026-11-05', '2026-11-06', '2026-11-07', '2026-11-08', '2026-11-09', '2026-11-10'];

function programme(key: string, title: string, startsAt: string, endsAt: string, description: string | null = null) {
  return { key, title, description, startsAt, endsAt };
}

function channelOf(id: string, title: string, programmes: ReturnType<typeof programme>[]) {
  return {
    media: { id, type: 'channel' as const, title, description: null, posterRef: null, contentLevel: null, availability: 'available' as const },
    programmes,
  };
}

/** 第 1 页:频道甲(有节目,含当前节目)+ 频道乙(无节目) */
const GUIDE_PAGE1: GuideWindowDto = {
  date: '2026-11-04',
  timezone: TZ,
  now: NOW_ISO,
  allowedDates: ALLOWED_DATES,
  from: FROM_ISO,
  to: TO_ISO,
  page: 1,
  pageSize: 20,
  totalChannels: 25,
  catalogRevision: 9,
  channels: [
    channelOf('ch-a', '频道甲', [
      programme('pg-a1', '早间新闻', '2026-11-04T11:00:00.000Z', '2026-11-04T12:00:00.000Z'),
      programme('pg-a2', '午间专题', '2026-11-04T12:00:00.000Z', '2026-11-04T13:00:00.000Z'),
      programme('pg-a3', '晚间剧场', '2026-11-04T15:00:00.000Z', '2026-11-04T16:00:00.000Z'),
    ]),
    channelOf('ch-b', '频道乙', []),
  ],
};

const GUIDE_PAGE2: GuideWindowDto = {
  ...GUIDE_PAGE1,
  page: 2,
  channels: [channelOf('ch-c', '频道丙', [programme('pg-c1', '深夜电影', '2026-11-04T13:00:00.000Z', '2026-11-04T14:30:00.000Z')])],
};

function guideRequestBody(overrides: Partial<GuideWindowDto>): { status: number; body: GuideWindowDto } {
  return { status: 200, body: { ...GUIDE_PAGE1, ...overrides } };
}

function renderGuidePage(initialEntry = '/live/guide'): void {
  render(
    <MemoryRouter initialEntries={[initialEntry]}>
      <SessionProvider>
        <SettingsAccessProvider>
          <ActionCoordinator>
            <GuidePage />
          </ActionCoordinator>
        </SettingsAccessProvider>
      </SessionProvider>
    </MemoryRouter>,
    // T023:useAppQuery 需要 QueryClientProvider;每例新 client(retry:false)保证确定性
    { wrapper: createQueryWrapper(createTestQueryClient()) },
  );
}

function guideCalls(): string[] {
  return fetchCalls.filter((call) => call.url.startsWith('/api/public/guide')).map((call) => call.url);
}

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  installFetchRouter();
  fetchRouter = () => guideRequestBody({});
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('EPG 节目单页(T109)', () => {
  it('7 日期 Tab 仅今天+6,今天标注,并标注家庭时区(America/New_York)', async () => {
    renderGuidePage();
    await waitFor(() => expect(screen.getByRole('button', { name: /11月4日/ })).toBeInTheDocument());
    for (const [index, date] of ALLOWED_DATES.entries()) {
      const [, month, day] = date.split('-');
      expect(screen.getByRole('button', { name: new RegExp(`${Number(month)}月${Number(day)}日`) })).toBeInTheDocument();
      expect(index).toBeLessThan(7);
    }
    expect(screen.getAllByRole('button', { name: /11月4日/ })[0]).toHaveAttribute('aria-pressed', 'true');
    // 家庭时区标注(IANA 名称 + 偏移,取自服务端响应,而非浏览器时区;头部与窗口标题均标注)
    expect(screen.getAllByText(/America\/New_York/).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/GMT-5/).length).toBeGreaterThan(0);
  });

  it('默认今天、展示该日完整 24 小时:缺省请求不带 date/from/to,窗口标题为 00:00–24:00', async () => {
    renderGuidePage();
    await waitFor(() => expect(screen.getByText(/午间专题/).valueOf()).toBeTruthy());
    const [first] = guideCalls();
    expect(first).toBe('/api/public/guide?page=1&pageSize=20');
    // 窗口标题取自响应 from/to(00:00–24:00,EST 全天;非浏览器本地时间)
    const title = screen.getByText(/全天节目单/);
    expect(title.textContent).toContain('00:00–24:00');
    expect(title.textContent).toContain('2026-11-04');
  });

  it('当前时间标识可见;切日写入 URL;回到现在仅清 date/from/to、保留频道页(012 url-state §1 规则4)并按恢复语义请求', async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    renderGuidePage();
    await waitFor(() => expect(screen.getByText(/午间专题/).valueOf()).toBeTruthy());
    // 当前时间标识(服务端 now,家庭时区)
    expect(screen.getByRole('status', { name: /当前时间 07:05/ })).toBeInTheDocument();

    // 切到 11 月 6 日:date 写 URL,from/to 清空(该日回到默认窗口语义)
    await user.click(screen.getByRole('button', { name: /11月6日/ }));
    await waitFor(() => expect(guideCalls().some((url) => url.includes('date=2026-11-06'))).toBe(true));

    // 翻到频道第 2 页:channelPage 写 URL(分页控件收拢进「显示与筛选」抽屉;
    // 翻页后抽屉自动关闭——FR-044 焦点锚需墙重新可聚焦)
    await user.click(screen.getByRole('button', { name: '显示与筛选' }));
    await user.click(screen.getByRole('button', { name: /下一页/ }));
    await waitFor(() => expect(guideCalls().some((url) => url.includes('page=2')).valueOf()).toBe(true));

    // T023:数据层为 SWR——未过期的同键回访命中缓存即显(staleTime 60s)。
    // 先推进 61s 使缺省键缓存过期,再断言「回到现在」按恢复语义重新请求。
    await act(async () => {
      vi.advanceTimersByTime(61_000);
    });

    // 回到现在:仅恢复今天+当前窗口(date/from/to 清除);频道分页保留(012 FR-016
    // 「不清筛选」、url-state §1 规则4「保留其余参数」)→ 按缺省日期 + page=2 重新请求
    await user.click(screen.getByRole('button', { name: '回到现在' }));
    await waitFor(() => {
      const calls = guideCalls();
      expect(calls.length).toBeGreaterThan(2);
      // 相邻日期预取(无级切换)会追加带 date 的后台请求,因此不再断言"最后一次"，
      // 而是断言「按恢复语义的请求确实发生过」：page=2 且不带 date/from/to
      expect(calls).toContain('/api/public/guide?page=2&pageSize=20');
    });
  });

  it('空档与无节目频道显示「暂无节目」,频道不隐藏(FR-026)', async () => {
    renderGuidePage();
    // 频道名改为 Tooltip 承载(列内只显示台标),按整格按钮的可访问名断言
    await waitFor(() => expect(screen.getByRole('button', { name: '播放 频道乙 当前直播' })).toBeInTheDocument());
    // 无节目频道保留行并显示「暂无节目」;列表视图同样不隐藏
    const emptyMarkers = screen.getAllByText('暂无节目');
    expect(emptyMarkers.length).toBeGreaterThan(0);
  });

  it('频道页默认 20、可改最多 50(写入请求与 URL)', async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    renderGuidePage();
    await waitFor(() => expect(screen.getByText(/午间专题/).valueOf()).toBeTruthy());
    expect(guideCalls()[0]).toContain('pageSize=20');
    // T016:Select 收拢进「显示与筛选」抽屉后按用户可见交互断言(开抽屉 → 开弹层 → 点选项)
    await user.click(screen.getByRole('button', { name: '显示与筛选' }));
    await user.click(screen.getByLabelText('每页频道数'));
    await user.click(await screen.findByRole('option', { name: '50' }));
    await waitFor(() => expect(guideCalls().some((url) => url.includes('pageSize=50'))).toBe(true));
  });

  it('409 GUIDE_DATE_EXPIRED:回今天、提示日期已更新,并丢弃旧窗口响应(改请求今天)', async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    fetchRouter = (url) => {
      if (url.searchParams.get('date') === '2026-11-10') {
        return {
          status: 409,
          body: {
            type: 'https://homemedia.local/problems/guide-date-expired',
            title: 'Guide Date Expired',
            status: 409,
            code: 'GUIDE_DATE_EXPIRED',
            detail: '该日期已不在可选范围内,请回到今天重新选择',
            allowedDates: ALLOWED_DATES,
          },
        };
      }
      return guideRequestBody({});
    };
    renderGuidePage();
    await waitFor(() => expect(screen.getByText(/午间专题/).valueOf()).toBeTruthy());

    await user.click(screen.getByRole('button', { name: /11月10日/ }));
    // 服务端 409 → UI 自动回今天(新请求不带过期 date 或带今天),提示日期已更新
    await waitFor(() => {
      expect(screen.getByText(/日期已更新/)).toBeInTheDocument();
    });
    await waitFor(() => {
      const calls = guideCalls();
      const last = calls[calls.length - 1] ?? '';
      expect(last.includes('date=2026-11-10')).toBe(false);
    });
    // 旧窗口响应被丢弃:不渲染任何基于 11-10 的内容(服务端该请求本就 409,无数据可渲染)
    expect(screen.queryByText(/11月10日.*的节目/)).not.toBeInTheDocument();
    // 今天内容照常渲染(回到今天后的响应)
    await waitFor(() => expect(screen.getByText(/午间专题/).valueOf()).toBeTruthy());
  });

  it('422 GUIDE_WINDOW_TOO_LARGE:提示减少每页频道数,旧数据保留、不崩溃', async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    fetchRouter = (url) => {
      // 全天窗口 × 50 频道超出单次节目上限 → 422(模拟)
      if (url.searchParams.get('pageSize') === '50') {
        return {
          status: 422,
          body: {
            type: 'https://homemedia.local/problems/guide-window-too-large',
            title: 'Guide Window Too Large',
            status: 422,
            code: 'GUIDE_WINDOW_TOO_LARGE',
            detail: '查询窗口内节目数量过多,请减少每页频道数后重试',
          },
        };
      }
      // URL channelPage=2 → API page=2
      return url.searchParams.get('page') === '2' ? guideRequestBody(GUIDE_PAGE2) : guideRequestBody({});
    };
    renderGuidePage('/live/guide?channelPage=2');
    await waitFor(() => expect(screen.getByText(/深夜电影/).valueOf()).toBeTruthy());

    // 调大每页频道数 → 全天窗口节目超限 → 服务端 422(T016:经抽屉内 Select 弹层交互)
    await user.click(screen.getByRole('button', { name: '显示与筛选' }));
    await user.click(screen.getByLabelText('每页频道数'));
    await user.click(await screen.findByRole('option', { name: '50' }));
    await waitFor(() => expect(screen.getByText(/每页频道数.*调小|减少每页频道数/)).toBeInTheDocument());
    // 旧数据保留(失败不清空当前频道页数据)
    expect(screen.getByText(/深夜电影/)).toBeInTheDocument();
    // 422 请求确实发生过(pageSize=50)
    expect(guideCalls().some((url) => url.includes('pageSize=50'))).toBe(true);
  });
});
