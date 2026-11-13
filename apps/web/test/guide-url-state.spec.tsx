import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, useLocation } from 'react-router';
import type { QueryClient } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { SessionProvider } from '../src/app/session-provider';
import { SettingsAccessProvider } from '../src/features/settings/settings-access-provider';
import { ActionCoordinator } from '../src/app/action-coordinator';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { GuideWindowDto } from '@hmp/shared';
import { GuidePage } from '../src/features/epg/GuidePage';
import { createQueryWrapper, createTestQueryClient } from './helpers/query-test-utils';

/**
 * T020(012 US3 测试先行)· /live/guide URL 状态契约(docs/specs/012-live-settings-experience/
 * contracts/url-state.md §1、FR-016/FR-018、ui.md §3.5):
 *
 * - §1 参数表逐项:date/from/to/channelPage/pageSize/view —— 用户显式变更
 *   (切日/翻页/页大小/视图)写 URL(读 URL 断言,不靠取数旁证);
 * - 非法值回落缺省不崩溃:伪造参数直挂 render 不抛错,date 非法日历日
 *   (2026-13-99)静默回落今天、channelPage=0/pageSize=99/view=banana 回落 1/20/wall;
 * - 刷新/直链恢复:URL 直挂 render,语义状态完整恢复(FR-018);
 * - 「回到现在」仅改 date/from/to,保留其余参数尤其筛选(§1 规则4、FR-016)——
 *   现状 goNow 连带清 channelPage,本文件锚定契约预期(先红,T023 修补转绿);
 * - 手动浏览(切日)期间自动刷新不拉回:窗口刷新后 URL 与 date 语义保持(FR-016)。
 *
 * 夹具沿用 test/epg/guide-page.spec.tsx 的路由式 fetch 桩与服务端家庭时区
 * America/New_York;URL 断言经路由探针(读 useLocation,非 mock 旁证)。
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
      // 协调器会话底座:游客恢复 401、部署已初始化(本文件全部用例为公共浏览态)
      if (url.pathname === '/api/auth/session') {
        return Promise.resolve(
          jsonResponse({ status: 401, code: 'SESSION_INVALID', title: 'SESSION_INVALID' }, 401),
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
const FROM_ISO = '2026-11-04T05:00:00.000Z'; // 该日真实日界起点(00:00 EST)
const TO_ISO = '2026-11-05T05:00:00.000Z'; // 真实日界终点(24:00 EST)
const ALLOWED_DATES = ['2026-11-04', '2026-11-05', '2026-11-06', '2026-11-07', '2026-11-08', '2026-11-09', '2026-11-10'];

function programme(key: string, title: string, startsAt: string, endsAt: string) {
  return { key, title, description: null, posterRef: null, startsAt, endsAt };
}

function channelOf(id: string, title: string, programmes: ReturnType<typeof programme>[]) {
  return {
    media: { id, type: 'channel' as const, title, description: null, posterRef: null, contentLevel: null, availability: 'available' as const },
    programmes,
  };
}

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

function guideBody(url: URL): { status: number; body: GuideWindowDto } {
  return {
    status: 200,
    body: url.searchParams.get('page') === '2' ? GUIDE_PAGE2 : GUIDE_PAGE1,
  };
}

/* ---------------- 渲染:URL 探针(读路由 location,断言 URL 本身) ---------------- */

function UrlProbe(): ReactNode {
  const location = useLocation();
  return <span data-testid="url-probe">{location.pathname + location.search}</span>;
}

let clientRef: QueryClient | null = null;

function renderGuidePage(initialEntry = '/live/guide'): void {
  const client = createTestQueryClient();
  clientRef = client;
  render(
    <MemoryRouter initialEntries={[initialEntry]}>
      <SessionProvider>
        <SettingsAccessProvider>
          <ActionCoordinator>
            <UrlProbe />
            <GuidePage />
          </ActionCoordinator>
        </SettingsAccessProvider>
      </SessionProvider>
    </MemoryRouter>,
    { wrapper: createQueryWrapper(client) },
  );
}

function urlProbe(): string {
  const probe = document.querySelector('[data-testid="url-probe"]');
  if (probe === null) {
    throw new Error('URL 探针未渲染');
  }
  return probe.textContent ?? '';
}

function guideCalls(): string[] {
  return fetchCalls.filter((call) => call.url.startsWith('/api/public/guide')).map((call) => call.url);
}

function guideQuery(url: string): URLSearchParams {
  return new URL(url, 'http://localhost:3000').searchParams;
}

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  installFetchRouter();
  fetchRouter = (url) => guideBody(url);
});

afterEach(() => {
  cleanup();
  clientRef = null;
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('T020 · /live/guide URL 状态契约(url-state §1、FR-016/FR-018)', () => {
  it('显式变更逐项写 URL:切日/翻页/页大小/视图(read URL 断言)', async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    renderGuidePage();
    await waitFor(() => expect(screen.getByText(/午间专题/)).toBeTruthy());
    expect(urlProbe()).toBe('/live/guide'); // 缺省:参数不出现

    // date:切到 11 月 6 日
    await user.click(screen.getByRole('button', { name: /11月6日/ }));
    await waitFor(() => expect(urlProbe()).toContain('date=2026-11-06'));
    expect(urlProbe()).not.toContain('from='); // 切日回到该日默认窗口语义
    expect(urlProbe()).not.toContain('to=');

    // channelPage:翻到第 2 页(date 保留;分页控件已收拢进「显示与筛选」抽屉)
    await user.click(screen.getByRole('button', { name: '显示与筛选' }));
    await user.click(screen.getByRole('button', { name: /下一页/ }));
    // 翻页后抽屉自动关闭(墙重新可聚焦,FR-044 焦点锚落位),后续筛选需再开
    await user.click(screen.getByRole('button', { name: '显示与筛选' }));
    await waitFor(() => expect(urlProbe()).toContain('channelPage=2'));
    expect(urlProbe()).toContain('date=2026-11-06');

    // pageSize:改为 50(既有语义:页大小变更同时清 channelPage)
    await user.click(screen.getByLabelText('每页频道数'));
    await user.click(await screen.findByRole('option', { name: '50' }));
    await waitFor(() => expect(urlProbe()).toContain('pageSize=50'));
    expect(urlProbe()).not.toContain('channelPage');

    // view:切换列表视图
    await user.click(screen.getByLabelText('视图模式'));
    await user.click(await screen.findByRole('option', { name: '按频道列表' }));
    await waitFor(() => expect(urlProbe()).toContain('view=list'));
    expect(urlProbe()).toContain('date=2026-11-06');
    expect(urlProbe()).toContain('pageSize=50');
  });

  it('非法值回落缺省不崩溃:date=banana(格式非法)回落今天', async () => {
    renderGuidePage('/live/guide?date=banana');
    await waitFor(() => expect(screen.getByText(/午间专题/)).toBeTruthy());
    const [first] = guideCalls();
    expect(guideQuery(first ?? '').get('date')).toBeNull(); // 回落缺省:请求不带 date
    expect(urlProbe()).toBe('/live/guide?date=banana'); // 直链原样保留(语义回落,不重写地址)
    expect(screen.getByRole('button', { name: /11月4日/ })).toHaveAttribute('aria-pressed', 'true');
  });

  it('非法值回落缺省不崩溃:date=2026-13-99(日历非法)回落今天,请求不带 date', async () => {
    renderGuidePage('/live/guide?date=2026-13-99');
    await waitFor(() => expect(screen.getByText(/午间专题/)).toBeTruthy());
    const [first] = guideCalls();
    expect(guideQuery(first ?? '').get('date')).toBeNull(); // 非法日历日静默回落缺省(§1 规则2)
    expect(screen.getByRole('button', { name: /11月4日/ })).toHaveAttribute('aria-pressed', 'true');
  });

  it('非法值回落缺省不崩溃:channelPage=0/pageSize=99/from=garbage 回落 1/20/无窗口', async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    renderGuidePage('/live/guide?channelPage=0&pageSize=99&view=banana&from=garbage&to=also-bad');
    await waitFor(() => expect(screen.getByText(/午间专题/)).toBeTruthy());
    const [first] = guideCalls();
    const query = guideQuery(first ?? '');
    expect(query.get('page')).toBe('1');
    expect(query.get('pageSize')).toBe('20');
    expect(query.get('from')).toBeNull();
    expect(query.get('to')).toBeNull();
    // 视图回落墙;伪造参数不崩溃(§1:非法/未知值静默回落缺省)
    expect(screen.getByRole('region', { name: '节目墙' })).toBeInTheDocument();
    // 分页控件收拢在抽屉内:打开后断言第 1 页禁用上一页(夹具 25 频道 > 20 → 分页在)
    await user.click(screen.getByRole('button', { name: '显示与筛选' }));
    expect(screen.getByRole('button', { name: '上一页' })).toBeDisabled();
  });

  it('刷新/直链恢复:date/channelPage/pageSize/view 全量按 URL 恢复(FR-018)', async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    renderGuidePage('/live/guide?date=2026-11-06&channelPage=2&pageSize=50&view=list');
    await waitFor(() => expect(screen.getByText(/深夜电影/)).toBeTruthy());
    const [first] = guideCalls();
    const query = guideQuery(first ?? '');
    expect(query.get('date')).toBe('2026-11-06');
    expect(query.get('page')).toBe('2');
    expect(query.get('pageSize')).toBe('50');
    // 语义状态逐项恢复:日期 Tab 选中、第 2 页内容、列表视图
    // (滚动容器 region 恒挂载,墙/列表以墙独有窗口标题区分)
    expect(screen.getByRole('button', { name: /11月6日/ })).toHaveAttribute('aria-pressed', 'true');
    // 分页自动隐藏语义:夹具 25 频道 ≤ pageSize=50 → 单页,不存在分页控件
    // (打开抽屉验证「抽屉体内也无分页」,排除「抽屉未开导致查不到」的假阳性)
    await user.click(screen.getByRole('button', { name: '显示与筛选' }));
    expect(screen.queryByRole('button', { name: '上一页' })).toBeNull();
    expect(document.querySelector('#guide-window-title')).toBeNull();
    expect(screen.getByText(/深夜电影/)).toBeInTheDocument(); // 第 2 页频道丙内容可见
  });

  it('刷新/直链恢复:from/to 日内子窗口按 URL 原样恢复(既有冻结语义)', async () => {
    renderGuidePage('/live/guide?from=2026-11-04T11:00:00.000Z&to=2026-11-04T14:00:00.000Z');
    await waitFor(() => expect(screen.getByText(/午间专题/)).toBeTruthy());
    const [first] = guideCalls();
    const query = guideQuery(first ?? '');
    expect(query.get('from')).toBe('2026-11-04T11:00:00.000Z');
    expect(query.get('to')).toBe('2026-11-04T14:00:00.000Z');
    expect(query.get('date')).toBeNull();
  });

  it('「回到现在」仅改 date/from/to,保留 channelPage/pageSize/view(FR-016、url-state §1 规则4;T023 修补前红)', async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    renderGuidePage('/live/guide?date=2026-11-06&channelPage=2&pageSize=50&view=list');
    await waitFor(() => expect(screen.getByText(/深夜电影/)).toBeTruthy());

    await user.click(screen.getByRole('button', { name: '回到现在' }));

    // date/from/to 恢复今天+当前窗口缺省;其余参数(尤其筛选/视图/分页)原样保留
    await waitFor(() => {
      const probe = urlProbe();
      expect(probe).not.toContain('date=');
      expect(probe).not.toContain('from=');
      expect(probe).not.toContain('to=');
      expect(probe).toContain('channelPage=2');
      expect(probe).toContain('pageSize=50');
      expect(probe).toContain('view=list');
    });
    // 重新请求按恢复后的语义:date 无、page=2、pageSize=50
    await waitFor(() => {
      const last = guideCalls()[guideCalls().length - 1] ?? '';
      const query = guideQuery(last);
      expect(query.get('date')).toBeNull();
      expect(query.get('page')).toBe('2');
      expect(query.get('pageSize')).toBe('50');
    });
  });

  it('手动浏览(切日)期间自动刷新不拉回:URL 与 date 语义保持(FR-016)', async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    renderGuidePage();
    await waitFor(() => expect(screen.getByText(/午间专题/)).toBeTruthy());

    // 手动浏览:切到 11 月 6 日
    await user.click(screen.getByRole('button', { name: /11月6日/ }));
    await waitFor(() => expect(guideCalls().some((url) => url.includes('date=2026-11-06'))).toBe(true));
    const callsBeforeRefresh = guideCalls().length;

    // 自动刷新发生:越过 staleTime(60s)后窗口聚焦 + 数据层重取(任一触发皆算)
    await act(async () => {
      vi.advanceTimersByTime(61_000);
      window.dispatchEvent(new Event('focus'));
      await Promise.resolve();
    });
    const client = clientRef;
    await act(async () => {
      if (client === null) {
        throw new Error('QueryClient 未就绪');
      }
      await client.refetchQueries({ type: 'active' });
    });

    // 不拉回:URL 不变、date 仍在;刷新后的请求依旧带 date(没有回落缺省窗口)
    expect(urlProbe()).toContain('date=2026-11-06');
    await waitFor(() => {
      const calls = guideCalls();
      expect(calls.length).toBeGreaterThan(callsBeforeRefresh); // 刷新确实发生了
      const last = guideQuery(calls[calls.length - 1] ?? '');
      expect(last.get('date')).toBe('2026-11-06');
    });
    // 浏览位置(切日后的窗口)保持:11月6日 Tab 仍选中
    expect(screen.getByRole('button', { name: /11月6日/ })).toHaveAttribute('aria-pressed', 'true');
  });
});
