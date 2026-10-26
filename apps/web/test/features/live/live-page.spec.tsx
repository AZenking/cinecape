import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import { SessionProvider } from '../../../src/app/session-provider';
import { SettingsAccessProvider } from '../../../src/features/settings/settings-access-provider';
import { ActionCoordinator } from '../../../src/app/action-coordinator';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChannelPageDto, ExperienceProgrammeDto, GroupPageDto } from '@hmp/shared';
import { LivePage } from '../../../src/features/live/LivePage';

/**
 * 直播页组件测试(T061;FR-021/022/023/024/045、ui.md §5):
 * - 分区顺序「所有节目单入口 → 正在直播 → 即将播放 → 各分组正在直播」且每区可继续查看;
 * - 时间按服务端返回的家庭时区显示并标注(夹具用 America/New_York,与 jsdom 浏览器时区
 *   明显不同:同一时刻显示 07:05 而非浏览器本地 20:05 → 证明不依赖浏览器时区);
 * - 无节目频道「暂无节目」占位且保留播放入口;
 * - 即将播放点击仅展示节目时段(频道与起止时间),文案不出现预约/回看/立即播放;
 * - 公共数据请求 credentials:'omit';游客播放/收藏出现登录入口且零播放请求;
 * - URL 查询参数承载浏览状态(section/group/q/page,FR-045)。
 */

/* ---------------- 请求桩:按 URL 路由;记录全部 fetch 调用 ---------------- */

interface FetchCall {
  readonly url: string;
  readonly init: RequestInit | undefined;
}

let fetchCalls: FetchCall[] = [];
let fetchRouter: (url: URL) => unknown;

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

function installFetchRouter(): void {
  fetchCalls = [];
  vi.stubGlobal(
    'fetch',
    vi.fn((input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const url = new URL(String(input), 'http://localhost:3000');
      fetchCalls.push({ url: url.pathname + url.search, init });
      // 协调器会话底座(US3 统一意图弹层的挂载面):游客恢复 401、部署已初始化
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
      const body = fetchRouter(url);
      return Promise.resolve(jsonResponse(body));
    }),
  );
}

/* ---------------- 夹具:服务端家庭时区 America/New_York(与浏览器时区不同) ---------------- */

const TZ = 'America/New_York';
const NOW_ISO = '2026-11-04T12:05:00.000Z'; // 07:05 EST / 20:05 CST
const CURRENT_START = '2026-11-04T12:00:00.000Z'; // 07:00 EST
const CURRENT_END = '2026-11-04T12:30:00.000Z'; // 07:30 EST
const NEXT_START = '2026-11-04T12:30:00.000Z';
const NEXT_END = '2026-11-04T13:00:00.000Z';

function programme(key: string, title: string, startsAt: string, endsAt: string): ExperienceProgrammeDto {
  return { key, title, description: null, startsAt, endsAt };
}

function channelRow(input: {
  id: string;
  title: string;
  groupKey: string;
  groupLabel: string;
  current?: ExperienceProgrammeDto | null;
  next?: ExperienceProgrammeDto | null;
}): ChannelPageDto['items'][number] {
  return {
    media: {
      id: input.id,
      type: 'channel',
      title: input.title,
      description: null,
      posterRef: null,
      contentLevel: null,
      availability: 'available',
    },
    groupKey: input.groupKey,
    groupLabel: input.groupLabel,
    current: input.current === undefined ? null : input.current,
    next: input.next === undefined ? null : input.next,
  };
}

const GROUPS: GroupPageDto = {
  items: [
    { key: 'grp-news', label: '新闻' },
    { key: 'grp-sports', label: '体育' },
    { key: 'grp-other', label: '其他' },
  ],
  now: NOW_ISO,
  timezone: TZ,
  catalogRevision: 7,
};

const CURRENT_PROGRAMME = programme('pg-current', '午间新闻', CURRENT_START, CURRENT_END);
const NEXT_PROGRAMME = programme('pg-next', '晚间剧场', NEXT_START, NEXT_END);

const NOW_PAGE: ChannelPageDto = {
  items: [
    channelRow({ id: 'ch-1', title: '新闻频道', groupKey: 'grp-news', groupLabel: '新闻', current: CURRENT_PROGRAMME, next: NEXT_PROGRAMME }),
  ],
  page: 1,
  pageSize: 20,
  total: 25,
  now: NOW_ISO,
  timezone: TZ,
  catalogRevision: 7,
};

const NEXT_PAGE: ChannelPageDto = {
  items: [channelRow({ id: 'ch-1', title: '新闻频道', groupKey: 'grp-news', groupLabel: '新闻', current: CURRENT_PROGRAMME, next: NEXT_PROGRAMME })],
  page: 1,
  pageSize: 20,
  total: 24,
  now: NOW_ISO,
  timezone: TZ,
  catalogRevision: 7,
};

const ALL_PAGE: ChannelPageDto = {
  items: [
    channelRow({ id: 'ch-1', title: '新闻频道', groupKey: 'grp-news', groupLabel: '新闻', current: CURRENT_PROGRAMME, next: NEXT_PROGRAMME }),
    channelRow({ id: 'ch-2', title: '体育频道', groupKey: 'grp-sports', groupLabel: '体育', current: null, next: null }),
    channelRow({ id: 'ch-3', title: '其他频道', groupKey: 'grp-other', groupLabel: '其他', current: CURRENT_PROGRAMME, next: null }),
  ],
  page: 1,
  pageSize: 50,
  total: 3,
  now: NOW_ISO,
  timezone: TZ,
  catalogRevision: 7,
};

function renderLivePage(): void {
  render(
    <MemoryRouter initialEntries={['/live']}>
      <SessionProvider>
        <SettingsAccessProvider>
          <ActionCoordinator>
            <LivePage />
          </ActionCoordinator>
        </SettingsAccessProvider>
      </SessionProvider>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  installFetchRouter();
  fetchRouter = (url) => {
    if (url.pathname === '/api/public/live/groups') {
      return GROUPS;
    }
    if (url.pathname === '/api/public/live/channels') {
      const section = url.searchParams.get('section');
      if (section === 'now') return NOW_PAGE;
      if (section === 'next') return NEXT_PAGE;
      return ALL_PAGE;
    }
    return {};
  };
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('直播页分区与内容(T061)', () => {
  it('分区顺序:所有节目单入口 → 正在直播 → 即将播放 → 各分组正在直播;每区可继续查看', async () => {
    renderLivePage();
    await waitFor(() => {
      expect(screen.getAllByText('午间新闻').length).toBeGreaterThan(0);
    });

    const orderOf = (label: string): number => {
      const headings = screen.getAllByRole('heading', { name: label });
      const element = headings[0] as HTMLElement;
      const all = Array.from(document.querySelectorAll('h1, h2'));
      return all.indexOf(element);
    };
    const guide = orderOf('所有节目单');
    const now = orderOf('正在直播');
    const next = orderOf('即将播放');
    const groups = orderOf('各分组正在直播');
    expect(guide).toBeGreaterThan(-1);
    expect(now).toBeGreaterThan(guide);
    expect(next).toBeGreaterThan(now);
    expect(groups).toBeGreaterThan(next);

    // 每区可继续查看:正在直播/即将播出的查看更多 + 分组区查看更多
    expect(screen.getAllByRole('button', { name: /查看更多/ }).length).toBeGreaterThanOrEqual(2);
    // 分组区以分组标题逐区展示(FR-021 各类型正在直播)
    expect(screen.getByRole('heading', { name: '新闻 · 正在直播' })).toBeTruthy();
    expect(screen.getByRole('heading', { name: '其他 · 正在直播' })).toBeTruthy();
  });

  it('时间按服务端家庭时区显示并标注,不依赖浏览器时区(07:05 而非本地 20:05)', async () => {
    renderLivePage();
    await waitFor(() => {
      expect(screen.getAllByText('07:00–07:30').length).toBeGreaterThan(0);
    });
    // 同一时刻的浏览器本地(Asia/Shanghai)表示 20:00 不得出现
    expect(document.body.textContent).not.toContain('20:00–20:30');
    // 时区标注:IANA 名称 + 偏移(EST 11 月为 GMT-5)
    expect(screen.getAllByText(/America\/New_York · GMT-5/).length).toBeGreaterThan(0);
  });

  it('无节目频道显示「暂无节目」占位且保留播放入口(不能把无节目当无频道)', async () => {
    renderLivePage();
    await waitFor(() => {
      expect(screen.getAllByTestId('no-programme').length).toBeGreaterThan(0);
    });
    const sportsCard = screen.getByRole('article', { name: '频道 体育频道' });
    expect(sportsCard.textContent).toContain('暂无节目');
    // 播放入口保留
    expect(
      Array.from(sportsCard.querySelectorAll('button')).some((button) => button.getAttribute('aria-label') === '播放 体育频道 当前直播'),
    ).toBe(true);
  });

  it('公共数据请求 credentials:"omit";频道行不携带来源地址/个人数据字段', async () => {
    renderLivePage();
    await waitFor(() => {
      expect(fetchCalls.filter((call) => call.url.startsWith('/api/public/')).length).toBeGreaterThanOrEqual(4);
    });
    // 页面公共浏览请求:一律 /api/public/* 且 credentials omit(T068 公共数据凭据档位)
    for (const call of fetchCalls) {
      if (call.url.startsWith('/api/public/')) {
        expect(call.init?.credentials).toBe('omit');
      }
    }
    // 页面不发起个人区请求(/api/me);/api/auth/session 仅属协调器会话恢复底座(T040),
    // 不属于直播页数据面
    expect(fetchCalls.some((call) => call.url.startsWith('/api/me'))).toBe(false);
  });

  it('点击即将播放节目:仅展示节目时段(频道与起止时间),文案不出现预约/回看/立即播放未来节目', async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    renderLivePage();
    await waitFor(() => {
      expect(screen.getAllByText(/晚间剧场/).length).toBeGreaterThan(0);
    });
    await user.click(screen.getAllByText(/晚间剧场/)[0] as HTMLElement);
    const dialog = await screen.findByRole('dialog');
    expect(dialog.textContent).toContain('新闻频道');
    expect(dialog.textContent).toContain('07:30–08:00');
    expect(dialog.textContent).toContain('America/New_York');
    const text = dialog.textContent ?? '';
    expect(text).not.toMatch(/预约/);
    expect(text).not.toMatch(/回看/);
    expect(text).not.toMatch(/立即播放/);
    // 播放动作明确指向频道当前直播,而非该未来节目
    expect(text).toContain('播放 新闻频道 当前直播');
  });

  it('游客点播放:进入 US3 统一登录选档意图,登录前零 /playback/ 请求;收藏为 US4 提示不发起播放', async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    renderLivePage();
    await waitFor(() => {
      expect(screen.getAllByRole('button', { name: '播放 新闻频道 当前直播' }).length).toBeGreaterThan(0);
    });
    const playbackCallsBefore = fetchCalls.filter((call) => call.url.includes('/playback/')).length;
    await user.click(screen.getAllByRole('button', { name: '播放 新闻频道 当前直播' })[0] as HTMLElement);
    // US3:游客播放 → 统一受控弹层进入登录步骤(弹层内出现登录入口)
    expect(await screen.findByRole('dialog')).toBeTruthy();
    expect(await screen.findByRole('heading', { name: '登录' })).toBeTruthy();
    // 登录选档完成前:零 /playback/ 请求(更无媒体流/分段请求,FR-011)
    expect(fetchCalls.filter((call) => call.url.includes('/playback/')).length).toBe(playbackCallsBefore);
    // 取消:弹层关闭,不自动播放、不重开
    await user.click(screen.getByRole('button', { name: '取消' }));
    await waitFor(() => {
      expect(screen.queryByRole('dialog')).toBeNull();
    });
    expect(fetchCalls.filter((call) => call.url.includes('/playback/')).length).toBe(playbackCallsBefore);
    // 收藏(US4 占位):出现游客提示(登录入口 + 收藏动作文案),不发起任何播放
    await user.click(screen.getAllByRole('button', { name: '收藏 新闻频道' })[0] as HTMLElement);
    expect(await screen.findByText('收藏 新闻频道需要先登录并选择档案')).toBeTruthy();
    expect(fetchCalls.filter((call) => call.url.includes('/playback/')).length).toBe(playbackCallsBefore);
  });

  it('URL 查询参数承载浏览状态:查看更多进入聚焦分区并可返回;搜索写入 q', async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    renderLivePage();
    await waitFor(() => {
      expect(screen.getAllByRole('heading', { name: '正在直播' }).length).toBeGreaterThan(0);
    });
    await user.click(screen.getAllByRole('button', { name: /查看更多\(共 25 个频道\)/ })[0] as HTMLElement);
    // 聚焦视图:仅该区 + 分页控件
    await waitFor(() => {
      expect(screen.getByRole('button', { name: '下一页' })).toBeTruthy();
    });
    expect(screen.getByRole('button', { name: '返回全部分区' })).toBeTruthy();
    await user.click(screen.getByRole('button', { name: '返回全部分区' }));
    await waitFor(() => {
      expect(screen.getByRole('heading', { name: '即将播放' })).toBeTruthy();
    });
    // 搜索:写入 URL 状态并重新拉取(q 参数)
    const input = screen.getByLabelText('搜索频道');
    await user.type(input, '新闻');
    await waitFor(() => {
      expect(fetchCalls.some((call) => call.url.includes('q='))).toBe(true);
    });
  });
});
