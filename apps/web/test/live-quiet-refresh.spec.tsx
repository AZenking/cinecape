import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';
import { LivePage } from '../src/features/live/LivePage';
import { ActionCoordinator } from '../src/app/action-coordinator';
import { SettingsAccessProvider } from '../src/features/settings/settings-access-provider';
import { useLocation } from 'react-router';
import { liveChannelPage, liveGroupPage } from './helpers/live-data';
import { LIVE_SESSION_STATES, renderLiveWorld } from './helpers/live-world';

/**
 * 012 T015(US2,测试先行)· 30 秒安静刷新零打断(FR-014、SC-003 自动化面):
 *
 * 刷新驱动采用真实路径——useLiveRefresh 的 visibilitychange「回前台立即刷新」
 * (契约行为之一):向 document 派发 visibilitychange 事件即 refreshKey 递增,
 * 各分区资源经 useLiveSection 强制 refetch(T004 夹具逐次 catalogRevision 递增,
 * 保证每次刷新都是真实的数据更替重渲染,而非引用相同的空更新)。逐次刷新后断言:
 * - 焦点元素不变(聚焦搜索框持续持有焦点);
 * - 已打开的详情面板不关闭、焦点不跳出面板(ui.md §2.4);
 * - 筛选不重置(概览视图 URL q 保持,输入值不变;015 T010 起聚焦视图被新规格
 *   取代,分页/section 场景随视图退役)。
 *
 * 分区 hook 归属说明(T019):本文件只断言行为,不改动 use-live-refresh.ts;
 * 30s 定时器本体不在 jsdom 等待(fake timer 会拖慢/漂移),以等价的事件路径驱动。
 *
 * 运行环境:jsdom;会话档位 guest(公共浏览)。
 */

// ---------------------------------------------------------------------------
// 夹具:直播世界 fetch mock(同 T014;channels 每次调用 revision 递增 → 真实重渲染)
// ---------------------------------------------------------------------------

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

function problemResponse(status: number, code: string): Response {
  return new Response(JSON.stringify({ status, code, title: code }), {
    status,
    headers: { 'Content-Type': 'application/problem+json' },
  });
}

export interface LiveRefreshFetchMock {
  /** /public/live/channels 请求次数(refetch 发生即递增) */
  channelsCalls(): number;
  /** 模拟一次「回前台立即刷新」:派发 visibilitychange(refreshKey +1 的真实契约路径) */
  bumpRefresh(): void;
}

function installLiveRefreshFetchMock(channelOverrides?: Record<string, unknown>): LiveRefreshFetchMock {
  let channels = 0;
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const method = (init?.method ?? 'GET').toUpperCase();
    const pathname = new URL(url, 'http://redroad.invalid').pathname;
    if (method === 'GET' && pathname.endsWith('/setup/status')) {
      return jsonResponse({ initialized: true });
    }
    if (method === 'GET' && pathname.endsWith('/public/live/groups')) {
      return jsonResponse(liveGroupPage());
    }
    if (method === 'GET' && pathname.endsWith('/public/live/channels')) {
      channels += 1;
      return jsonResponse(
        liveChannelPage({
          overrides: { catalogRevision: 1 + channels, ...(channelOverrides ?? {}) },
        }),
      );
    }
    return problemResponse(404, 'NOT_FOUND');
  });
  vi.stubGlobal('fetch', fetchMock);
  return {
    channelsCalls: () => channels,
    bumpRefresh: () => {
      act(() => {
        document.dispatchEvent(new Event('visibilitychange'));
      });
    },
  };
}

/** URL 状态探针:渲染当前 MemoryRouter 地址(section/page/q 断言依据) */
function LocationProbe(): ReactNode {
  const location = useLocation();
  return (
    <span data-testid="live-location">
      {location.pathname}
      {location.search}
    </span>
  );
}

function renderLivePageWorld(initialEntry: string): ReturnType<typeof renderLiveWorld> {
  return renderLiveWorld(
    <>
      <LivePage />
      <LocationProbe />
    </>,
    {
      session: LIVE_SESSION_STATES.guest,
      initialEntries: [initialEntry],
      decorate: (ui: ReactNode) => (
        <SettingsAccessProvider>
          <ActionCoordinator>{ui}</ActionCoordinator>
        </SettingsAccessProvider>
      ),
    },
  );
}

// ---------------------------------------------------------------------------
// 1 · 焦点与筛选保持(概览视图 + q 筛选;015 T010 起聚焦视图被新规格取代,
//     行尾入口改导航 /live/guide、/live/channels,分页/section 场景随视图退役)
// ---------------------------------------------------------------------------

describe('T015 · 安静刷新:焦点不变、筛选不重置(FR-014)', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('概览视图连续刷新 ×2:焦点不被打断,URL(q)保持(FR-014)', async () => {
    const mock = installLiveRefreshFetchMock();
    renderLivePageWorld('/live?q=例牌');

    // 概览视图就绪(正在直播分区渲染)
    const nowRegion = await screen.findByRole('region', { name: '正在直播' });

    // 搜索框已从直播首页移除:改以「正在直播」行尾入口作为焦点锚验证安静刷新
    // (FR-014 的实质是后台刷新不抢焦点、不重置浏览态,与具体控件无关)
    const anchor = within(nowRegion).getAllByRole('button', {
      name: /查看更多|全部正在直播/,
    })[0] as HTMLElement;
    anchor.focus();
    expect(anchor).toHaveFocus();

    const urlBefore = screen.getByTestId('live-location').textContent;

    // 刷新 ×2:每次都等待一次真实的 channels 重取发生
    for (let round = 1; round <= 2; round += 1) {
      const before = mock.channelsCalls();
      mock.bumpRefresh();
      await waitFor(() => expect(mock.channelsCalls()).toBeGreaterThan(before));

      // 焦点元素不变(FR-014:刷新不打断焦点)
      expect(anchor).toHaveFocus();
      // 筛选不重置:URL q 保持(搜索控件已移除,深链参数仍透传给取数)
      expect(screen.getByTestId('live-location').textContent).toBe(urlBefore);
      expect(screen.getByTestId('live-location').textContent).toContain('q=');
    }
  });
});

// ---------------------------------------------------------------------------
// 2 · 打开的详情面板不被刷新关闭(ui.md §2.4;T016 共享面板宿主)
// ---------------------------------------------------------------------------

describe('T015 · 安静刷新:打开的面板不关闭、焦点不跳出', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('详情面板打开期间连续刷新 ×2:面板保持打开、焦点持续在面板内、内容句柄不变', async () => {
    const mock = installLiveRefreshFetchMock();
    renderLivePageWorld('/live');
    const user = userEvent.setup();

    // 从即将播放区打开节目详情面板(共享面板宿主)。015 T004 后 current 档节目名
    // = 导航 /live/watch(research.md R5、ui-layout.md §1.2 第 3 条),面板入口
    // 改由 upcoming 档节目名承载(行为不随本规格变化:开面板 + 刷新零打断)
    const upcomingButton = (await screen.findAllByRole('button', { name: /例牌预告节目/ }))[0]!;
    await user.click(upcomingButton);
    const dialog = await screen.findByRole('dialog');
    await waitFor(() => expect(dialog.contains(document.activeElement)).toBe(true));
    expect(within(dialog).getByText('即将开始')).toBeVisible();

    for (let round = 1; round <= 2; round += 1) {
      const before = mock.channelsCalls();
      mock.bumpRefresh();
      await waitFor(() => expect(mock.channelsCalls()).toBeGreaterThan(before));

      // 面板未被关闭(FR-014:刷新 MUST NOT 关闭详情面板)
      expect(screen.queryByRole('dialog')).toBeVisible();
      // 焦点未跳出面板(ui.md §2.4)
      expect(screen.getByRole('dialog').contains(document.activeElement)).toBe(true);
      // 面板内容句柄保持(同一节目上下文)
      expect(within(screen.getByRole('dialog')).getByText(/例牌预告节目/)).toBeVisible();
    }
  });
});
