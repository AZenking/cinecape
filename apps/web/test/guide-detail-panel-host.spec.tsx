import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import { SessionProvider } from '../src/app/session-provider';
import { SettingsAccessProvider } from '../src/features/settings/settings-access-provider';
import { ActionCoordinator } from '../src/app/action-coordinator';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { GuideWindowDto } from '@hmp/shared';
import { GuidePage } from '../src/features/epg/GuidePage';
import { createQueryWrapper, createTestQueryClient } from './helpers/query-test-utils';
import { installNetworkCounter, type NetworkCounter } from './helpers/network-assertions';
import { liveSessionFixture } from './helpers/live-world';
import type { LiveSessionState } from './helpers/live-world';

/**
 * T022/T025(012 US3 实现)· EPG 节目单详情面板宿主接线与滚动会话恢复单测:
 *
 * T022 —— GuidePage 宿主改挂共享 `shared-programme/ProgrammeDetailPanel`(FR-013、
 * ui.md §2/§3.4),宿主职责断言:
 * - status 推导:节目时段含 serverNow → now;未开始 → upcoming;已结束 → ended
 *   (none 由共享面板组件单测钉面,墙内无节目块不可点,宿主不重复覆盖);
 * - 015 T013(R6/ui-layout §3.2)修订:节目墙内与 NOW 相交的 current 块点击改为
 *   **直接起播**(live-routing-epg.spec.tsx 钉面),不再开面板;016 基准时间改造后
 *   「按频道列表」视图同样执行 015 §3.2.2 分流(current 条目 = 直接起播入口,
 *   与墙一致;upcoming/ended 条目仍开面板)——面板 now 态宿主推导在节目单页
 *   不再可达,由直播首页(NowSection 挂同一共享面板)继续覆盖;
 * - 面板主操作「播放当前频道」= 该频道当前直播语义(先撤面板,游客进统一登录面,
 *   登录前零媒体请求);
 * - 次操作收藏:游客 → 登录引导(零 /me 请求);已选档 → 仅 PUT favorites、不触发
 *   播放(ui.md §1.5;行内反馈/收藏态展示随 T011 收藏任务统一补,宿主最小接线);
 * - 次操作「查看节目单」:已在节目单页 → 关闭面板并聚焦窗口标题(键盘锚)。
 *
 * T025 —— 详情面板返回后恢复节目单滚动与焦点(内存快照,模块级 Map;不写
 * localStorage/sessionStorage;刷新回缺省可接受)。jsdom 无布局,scrollLeft/
 * scrollTop 以实例属性存取(与真实浏览器 clamp 语义无碍,足以断言恢复赋值)。
 */

/* ---------------- 请求桩:按 URL 路由;记录全部 fetch 调用 ---------------- */

interface FetchCall {
  readonly url: string;
  readonly method: string;
}

let fetchCalls: FetchCall[] = [];
let sessionState: LiveSessionState = 'guest';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': status >= 400 ? 'application/problem+json' : 'application/json' },
  });
}

function problemResponse(status: number, code: string): Response {
  return new Response(JSON.stringify({ status, code, title: code }), {
    status,
    headers: { 'Content-Type': 'application/problem+json' },
  });
}

function installFetchRouter(): void {
  fetchCalls = [];
  vi.stubGlobal(
    'fetch',
    vi.fn((input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const url = new URL(String(input), 'http://localhost:3000');
      const method = (init?.method ?? 'GET').toUpperCase();
      fetchCalls.push({ url: url.pathname + url.search, method });
      if (url.pathname === '/api/auth/session') {
        return Promise.resolve(
          sessionState === 'guest'
            ? problemResponse(401, 'SESSION_INVALID')
            : jsonResponse(liveSessionFixture(sessionState)),
        );
      }
      if (url.pathname === '/api/setup/status') {
        return Promise.resolve(jsonResponse({ initialized: true }));
      }
      if (url.pathname.startsWith('/api/public/guide')) {
        return Promise.resolve(jsonResponse(GUIDE_PAGE1));
      }
      if (method === 'PUT' && url.pathname.startsWith('/api/me/favorites/channels/')) {
        return Promise.resolve(new Response(null, { status: 204 }));
      }
      // 其余请求一律 404 problem:夹具世界内不允许意外出网
      return Promise.resolve(problemResponse(404, 'NOT_FOUND'));
    }),
  );
}

/* ---------------- 夹具:服务端家庭时区 America/New_York,固定 serverNow ---------------- */

const TZ = 'America/New_York';
const NOW_ISO = '2026-11-04T12:05:00.000Z'; // 07:05 EST
const FROM_ISO = '2026-11-04T05:00:00.000Z';
const TO_ISO = '2026-11-05T05:00:00.000Z';
const ALLOWED_DATES = ['2026-11-04', '2026-11-05', '2026-11-06', '2026-11-07', '2026-11-08', '2026-11-09', '2026-11-10'];

function programme(key: string, title: string, startsAt: string, endsAt: string) {
  return { key, title, description: `简介:${title}`, posterRef: null, startsAt, endsAt };
}

function channelOf(id: string, title: string, programmes: ReturnType<typeof programme>[]) {
  return {
    media: { id, type: 'channel' as const, title, description: null, posterRef: null, contentLevel: null, availability: 'available' as const },
    programmes,
  };
}

/** 频道甲三态齐备:now(午间专题 12:00–13:00 覆盖 12:05)/upcoming(15:00)/ended(11:00) */
const GUIDE_PAGE1: GuideWindowDto = {
  date: '2026-11-04',
  timezone: TZ,
  now: NOW_ISO,
  allowedDates: ALLOWED_DATES,
  from: FROM_ISO,
  to: TO_ISO,
  page: 1,
  pageSize: 20,
  totalChannels: 2,
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

let network: NetworkCounter | null = null;

function renderGuidePage(initialEntry = '/live/guide'): void {
  // 先装路由 mock,再包 Network 计数器(两层包装叠加,应答与计数同时生效)
  installFetchRouter();
  network = installNetworkCounter();
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
    { wrapper: createQueryWrapper(createTestQueryClient()) },
  );
}

/** 节目墙内按「频道,标题」定位节目块按钮(aria-label 含频道、标题、时段) */
function wallProgrammeButton(channelTitle: string, programmeTitle: string): HTMLElement {
  const buttons = Array.from(document.querySelectorAll<HTMLButtonElement>('[role="region"][aria-label="节目墙"] button'));
  const found = buttons.find((button) => {
    const label = button.getAttribute('aria-label') ?? '';
    return label.startsWith(`${channelTitle},`) && label.includes(programmeTitle);
  });
  if (found === undefined) {
    throw new Error(`未找到节目块:${channelTitle} / ${programmeTitle}`);
  }
  return found;
}

/**
 * 按频道列表视图定位节目条目按钮(aria-label 前缀「频道 {频道名},」;
 * 015 §3.2.2 + 016 基准时间改造后:列表 current 条目 = 直接起播入口(与墙一致),
 * upcoming/ended 条目仍开面板)。
 */
function listProgrammeButton(channelTitle: string, programmeTitle: string): HTMLElement {
  const buttons = Array.from(document.querySelectorAll<HTMLButtonElement>('[role="region"][aria-label="节目墙"] button'));
  const found = buttons.find((button) => {
    const label = button.getAttribute('aria-label') ?? '';
    return label.startsWith(`频道 ${channelTitle},`) && label.includes(programmeTitle);
  });
  if (found === undefined) {
    throw new Error(`未找到列表节目条目:${channelTitle} / ${programmeTitle}`);
  }
  return found;
}

function wallContainer(): HTMLElement {
  const el = document.querySelector<HTMLElement>('[role="region"][aria-label="节目墙"]');
  if (el === null) {
    throw new Error('未找到节目墙滚动容器');
  }
  return el;
}

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  sessionState = 'guest';
});

afterEach(() => {
  cleanup();
  network?.restore();
  network = null;
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('T022 · EPG 详情面板宿主(共享面板挂载与语义接线)', () => {
  it('列表视图 current 条目点击=直接起播分流(015 §3.2.2 与墙一致):游客不开面板、进统一登录面,零 playback/me 请求', async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    renderGuidePage('/live/guide?view=list');
    // 列表视图下 current 节目名出现多处(列头「正在直播」+ 特色行),用 All 变体等待
    await waitFor(() => expect(screen.getAllByText(/午间专题/).length).toBeGreaterThan(0));
    expect(screen.queryByRole('dialog')).toBeNull();

    // 015 §3.2.2:current 条目与墙的 NOW 相交块同一分流 → 直接起播(游客登录门禁)
    await user.click(listProgrammeButton('频道甲', '午间专题'));

    // 不开节目详情面板;统一登录引导出现;登录前零媒体/个人请求
    await waitFor(() => expect(screen.queryByRole('dialog', { name: /节目详情:频道甲/ })).toBeNull());
    expect(await screen.findByRole('heading', { name: '登录' })).toBeVisible();
    expect(network?.counts.playback).toBe(0);
    expect(network?.counts.personal).toBe(0);
  });

  it('upcoming 节目:面板显示「即将开始」与开播时间,无播放主操作(ui.md §1.6)', async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    renderGuidePage();
    await waitFor(() => expect(screen.getByText(/午间专题/)).toBeTruthy());

    await user.click(wallProgrammeButton('频道甲', '晚间剧场'));

    const dialog = await screen.findByRole('dialog', { name: /节目详情:频道甲/ });
    expect(within(dialog).getByText('即将开始')).toBeVisible();
    expect(within(dialog).getByText('10:00')).toBeVisible(); // 15:00Z → EST 开播时间
    expect(within(dialog).queryByRole('button', { name: '播放' })).toBeNull();
    // 查看节目单按钮已按产品要求移除(仅保留收藏频道)
    expect(within(dialog).queryByRole('button', { name: '查看节目单' })).toBeNull();
    expect(within(dialog).getByRole('button', { name: '收藏频道' })).toBeVisible();
    expect(network?.counts.playback).toBe(0);
  });

  it('ended 节目:面板显示「已结束」,无播放主操作(ui.md §1.6)', async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    renderGuidePage();
    await waitFor(() => expect(screen.getByText(/午间专题/)).toBeTruthy());

    await user.click(wallProgrammeButton('频道甲', '早间新闻'));

    const dialog = await screen.findByRole('dialog', { name: /节目详情:频道甲/ });
    expect(within(dialog).getByText('已结束')).toBeVisible();
    expect(within(dialog).queryByRole('button', { name: '播放' })).toBeNull();
    expect(network?.counts.playback).toBe(0);
  });

  it('列表视图 current 条目(已选档):点击直接经统一播放入口发起 resolve(015 §3.2.2;面板不再参与)', async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    sessionState = 'authed-with-profile';
    renderGuidePage('/live/guide?view=list');
    await waitFor(() => expect(screen.getAllByText(/午间专题/).length).toBeGreaterThan(0));

    // 已选档:current 条目点击 → usePlayAction 统一入口 → POST /playback/resolve
    // (夹具世界内 resolve 无桩会 404,此处只断言「请求确实发起」即分流正确;
    // 播放器完整链路由 playback 系列规格覆盖)
    await user.click(listProgrammeButton('频道甲', '午间专题'));
    await waitFor(() => {
      expect(fetchCalls.some((call) => call.method === 'POST' && call.url.startsWith('/api/playback/resolve'))).toBe(true);
    });
    // 直接起播路径不开节目详情面板
    expect(screen.queryByRole('dialog', { name: /节目详情:频道甲/ })).toBeNull();
  });

  it('面板次操作收藏(游客):登录引导、零 /me 请求、不触发播放(ui.md §1.5;015 T013 起经 upcoming 墙块开面板)', async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    renderGuidePage();
    await waitFor(() => expect(screen.getByText(/午间专题/)).toBeTruthy());

    // 015 T013:墙内 current 块(午间专题)点击改为直接起播;面板宿主语义断言
    // 改经 upcoming 块(晚间剧场)开面板,收藏行为断言不变
    await user.click(wallProgrammeButton('频道甲', '晚间剧场'));
    await screen.findByRole('dialog', { name: /节目详情:频道甲/ });
    await user.click(screen.getByRole('button', { name: '收藏频道' }));

    expect(await screen.findByRole('heading', { name: '登录' })).toBeVisible();
    expect(network?.counts.personal).toBe(0);
    expect(network?.counts.playback).toBe(0);
  });

  it('面板次操作收藏(已选档):仅 PUT favorites,不触发播放、面板保持(ui.md §1.5;015 T013 起经 upcoming 墙块开面板)', async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    sessionState = 'authed-with-profile';
    renderGuidePage();
    await waitFor(() => expect(screen.getByText(/午间专题/)).toBeTruthy());

    await user.click(wallProgrammeButton('频道甲', '晚间剧场'));
    await screen.findByRole('dialog', { name: /节目详情:频道甲/ });
    await user.click(screen.getByRole('button', { name: '收藏频道' }));

    await waitFor(() => {
      const put = fetchCalls.find((call) => call.method === 'PUT' && call.url.startsWith('/api/me/favorites/channels/'));
      expect(put).toBeDefined();
      expect(put?.url).toContain('ch-a'); // 频道语义:收藏该频道(mediaId 由宿主闭包持有)
    });
    expect(network?.counts.playback).toBe(0);
    expect(screen.getByRole('dialog', { name: /节目详情:频道甲/ })).toBeVisible();
  });

  it('面板无「查看节目单」次操作(产品要求移除);关闭走右上角 X', async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    renderGuidePage();
    await waitFor(() => expect(screen.getByText(/午间专题/)).toBeTruthy());

    await user.click(wallProgrammeButton('频道甲', '晚间剧场'));
    const dialog = await screen.findByRole('dialog', { name: /节目详情:频道甲/ });
    expect(within(dialog).queryByRole('button', { name: '查看节目单' })).toBeNull();

    await user.click(within(dialog).getByRole('button', { name: '关闭' }));
    await waitFor(() => expect(screen.queryByRole('dialog', { name: /节目详情:频道甲/ })).toBeNull());
  });
});

describe('T025 · 详情返回恢复节目单滚动与焦点(内存快照,不入 URL/storage)', () => {
  it('面板关闭后恢复打开前滚动与节目块焦点;localStorage/sessionStorage 零写入', async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    renderGuidePage();
    await waitFor(() => expect(screen.getByText(/午间专题/)).toBeTruthy());

    // 造「原浏览位置」:容器滚动锚(jsx 容器在面板打开期间仍挂载)
    // 015 T013:墙内 current 块点击改为直接起播,触发块改用 ended 墙块(早间新闻)
    const container = wallContainer();
    container.scrollLeft = 120;
    container.scrollTop = 40;
    const trigger = wallProgrammeButton('频道甲', '早间新闻');

    await user.click(trigger);
    const dialog = await screen.findByRole('dialog', { name: /节目详情:频道甲/ });
    await waitFor(() => expect(dialog.contains(document.activeElement)).toBe(true));

    // 模拟面板打开期间的浏览位置/焦点丢失(快照恢复的动机:恢复不靠偶然)
    container.scrollLeft = 0;
    container.scrollTop = 0;
    (document.activeElement as HTMLElement | null)?.blur();

    await user.click(screen.getByRole('button', { name: '关闭' }));
    await waitFor(() => expect(screen.queryByRole('dialog', { name: /节目详情:频道甲/ })).toBeNull());

    // 滚动恢复(内存快照;URL 不承载滚动——url-state §1.3/§5)
    expect(container.scrollLeft).toBe(120);
    expect(container.scrollTop).toBe(40);
    // 焦点恢复到触发节目块(React Aria 语义 + 快照锚双保险)
    const block = wallProgrammeButton('频道甲', '早间新闻');
    expect(block.getAttribute('data-programme-key')).toBe('pg-a1');
    await waitFor(() => expect(document.activeElement).toBe(block));
    // Q2/§5:不新增任何浏览器存储键
    expect(window.localStorage.length).toBe(0);
    expect(window.sessionStorage.length).toBe(0);
  });

  it('刷新(全新文档)回缺省定位可接受:无快照时按当前时刻定位(FR-015/T023)', async () => {
    // 新模块状态(无会话快照)= 刷新语义;首屏定位把当前时刻带到视口左侧附近
    renderGuidePage();
    await waitFor(() => expect(screen.getByText(/午间专题/)).toBeTruthy());
    // 全天窗口 2880px;now=07:05 EST → 距窗首 425 分钟 ≈ 850px,margin 48 → scrollLeft ≈ 802
    const container = wallContainer();
    await waitFor(() => expect(container.scrollLeft).toBeGreaterThan(0));
  });
});
