import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { act, cleanup, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';
import { useLocation } from 'react-router';
import type { ChannelPageDto, Vod } from '@hmp/shared';
import { ActionCoordinator, usePlayAction } from '../../../src/app/action-coordinator';
import { SettingsAccessProvider } from '../../../src/features/settings/settings-access-provider';
import { ChannelGridPage, SEARCH_DEBOUNCE_MS } from '../../../src/features/live/pages/ChannelGridPage';
import {
  buildChannelListPage,
  buildGroupPage,
  LIVE_REDESIGN_CHANNELS,
  LIVE_REDESIGN_CHANNELS_BY_GROUP,
} from '../../fixtures/live-redesign-fixtures';
import { LIVE_SESSION_STATES, renderLiveWorld } from '../../helpers/live-world';
import type { LiveSessionState } from '../../helpers/live-world';
import { installNetworkCounter } from '../../helpers/network-assertions';

/**
 * 015 T018 · US3 分类平铺网格页(ChannelGridPage)单测。
 *
 * 权威:docs/specs/015-live-flow-redesign/
 * - spec.md US3 验收 1~4(URL ?group= 自动高亮 Tab、Tab 切换网格/URL 同步、
 *   搜索过滤 + 一键清空、卡片直接播放)、SC-003;
 * - contracts/ui-layout.md §2(Screen 2 线框:标题 + 横向分类 Tabs + 右侧搜索/视图切换
 *   + 响应式多列网格)、contracts/routing-and-url-state.md §2.2(group/q/view 参数;
 *   非法 group 回退 all)、contracts/api-reuse.md §2.3(搜索 300ms 客户端防抖);
 * - quickstart.md 场景 3。
 *
 * 范式(live-watch-page.spec.tsx 同款):renderLiveWorld(MemoryRouter 直挂页面)+
 * decorate(SettingsAccessProvider + ActionCoordinator 真实协调器)+ 路由式 fetch 桩:
 * - ①~④ Tab 联动/URL 状态/搜索防抖:游客会话,断言请求形态(section/groupKey/q)与
 *   返回结果渲染(桩按 q 服务端式过滤);
 * - ⑤ 游客拦截(真实协调器基建):卡片中央 ▶ → 统一登录弹层,授权前零 /playback
 *   与 /me 请求(live-page.spec.tsx 同语义);
 * - ⑤b play 入参(真实管线):已选档点击中央 ▶ → resolve body 断言
 *   { mediaId: 频道 id, startMode: 'beginning' },播放面挂载;
 *   video.js 换为无副作用假引擎(jsdom 无媒体实现,断言面为协调器链路)。
 *
 * 数据:T005 015 规范频道集(3 组 × 3 频道;'all' 为前端伪分组,9 频道全量)。
 */

// ────────────────────────── 引擎边界 mock(jsdom;live-watch-page 同款) ──────────────────────────

vi.mock('video.js', () => {
  class FakePlayer {
    on(): void {}
    addClass(): void {}
    src(): void {}
    play(): undefined {
      return undefined;
    }
    dispose(): void {}
  }
  return { default: () => new FakePlayer() };
});

// ────────────────────────── fetch 路由桩(公共元数据 + resolve→playing 全链) ──────────────────────────

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': status >= 400 ? 'application/problem+json' : 'application/json' },
  });
}

type PlaybackDto = Vod.components['schemas']['PlaybackDto'];

/** 最小合法 PlaybackDto(直播契约:durationSeconds=null/seekCapability=none) */
function playbackDto(overrides: Partial<PlaybackDto> = {}): PlaybackDto {
  return {
    id: 'ps-1',
    state: 'ready',
    version: 1,
    generation: 1,
    desiredPaused: false,
    delivery: 'hls_proxy',
    positionSeconds: 0,
    durationSeconds: null,
    timelineOffsetSeconds: 0,
    presentationStartSeconds: 0,
    ticketExpiresAt: null,
    playbackUrl: null,
    tracks: { audio: [], subtitles: [] },
    startBasis: 'beginning',
    resumeDisposition: 'beginning',
    resumeReason: null,
    transitionSlot: { revision: 0, status: 'open', activeIntentId: null, successorSessionId: null },
    seekCapability: 'none',
    playbackStarted: false,
    ...overrides,
  };
}

/** 频道列表页桩:按 groupKey 取组('all'/null=全量)+ 按 q 服务端式标题过滤 */
function channelPageOf(groupKey: string | null, q: string): ChannelPageDto {
  const base = buildChannelListPage(groupKey !== null ? { groupKey } : {});
  const items =
    q === '' ? base.items : base.items.filter((row) => row.media.title.includes(q));
  return { ...base, items, total: items.length, pageSize: Math.max(items.length, 1) };
}

let resolveBodies: Array<Record<string, unknown>> = [];
let fetchMock: Mock;

function installGridFetchRouter(): void {
  resolveBodies = [];
  let resolveCount = 0;
  fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = new URL(String(input), 'http://localhost:3000');
    const method = (init?.method ?? 'GET').toUpperCase();
    const path = url.pathname;
    if (method === 'GET' && path === '/api/setup/status') {
      return jsonResponse({ initialized: true });
    }
    if (method === 'GET' && path === '/api/public/live/groups') {
      return jsonResponse(buildGroupPage());
    }
    if (method === 'GET' && path === '/api/public/live/channels') {
      const groupKey = url.searchParams.get('groupKey');
      const q = url.searchParams.get('q') ?? '';
      return jsonResponse(channelPageOf(groupKey, q));
    }
    if (method === 'POST' && path === '/api/playback/resolve') {
      resolveBodies.push(JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>);
      resolveCount += 1;
      const id = `ps-${resolveCount}`;
      return jsonResponse(playbackDto({ id, state: 'preparing' }), 201);
    }
    const sessionMatch = /^\/api\/playback\/sessions\/([^/]+)$/.exec(path);
    if (sessionMatch !== null && sessionMatch[1] !== undefined && method === 'GET') {
      return jsonResponse(playbackDto({ id: sessionMatch[1], state: 'ready' }));
    }
    const renewMatch = /^\/api\/playback\/sessions\/([^/]+)\/renew$/.exec(path);
    if (renewMatch !== null && renewMatch[1] !== undefined) {
      return jsonResponse({
        playbackUrl: `/api/playback/stream/${renewMatch[1]}/1/index.m3u8?ticket=t-${renewMatch[1]}`,
        ticketExpiresAt: '2099-01-01T00:00:00.000Z',
        generation: 1,
      });
    }
    if (/^\/api\/playback\/sessions\/[^/]+\/(stop|heartbeat|observations)$/.test(path)) {
      return new Response(null, { status: 204 });
    }
    if (/^\/api\/playback\/sessions\/[^/]+\/progress$/.test(path)) {
      return jsonResponse({
        applied: true,
        reason: 'accepted',
        historyRevision: 1,
        sessionAccepted: true,
        acceptedSampleSeq: 1,
        acceptedPositionSeconds: 0,
        acceptedGeneration: 1,
        sessionStarted: true,
      });
    }
    return jsonResponse({ status: 404, code: 'NOT_FOUND', title: 'NOT_FOUND' }, 404);
  });
  vi.stubGlobal('fetch', fetchMock);
}

// ────────────────────────── 频道请求调用记录(请求形态断言) ──────────────────────────

/** 已捕获的 /public/live/channels 请求(解析后的 URL,searchParams 可直接断言) */
function channelCalls(): URL[] {
  return fetchMock.mock.calls
    .map((call) => new URL(String(call[0]), 'http://localhost:3000'))
    .filter((url) => url.pathname === '/api/public/live/channels');
}

// ────────────────────────── 频道选取与挂载基座 ──────────────────────────

/** 电影组频道选取(015 fixtures:电影组 [星光影城, 经典电影台, 动作影院]) */
function movieChannel(index: number) {
  const row = LIVE_REDESIGN_CHANNELS_BY_GROUP['movie']?.[index];
  if (row === undefined) {
    throw new Error(`015 fixtures 异常:电影组第 ${index} 个频道缺失`);
  }
  return row;
}

/** 初始入场频道(星光影城) */
const STAR = movieChannel(0);

/** 内存路由探针:断言 URL 同步(?group/?q/?view) */
function LocationProbe(): ReactNode {
  const location = useLocation();
  return <span data-testid="grid-location">{location.pathname}{location.search}</span>;
}

/** 播放意图探针:直读 usePlayAction().playback(唯一播放管线),断言目标与相位 */
function PlaybackIntentProbe(): ReactNode {
  const { playback } = usePlayAction();
  return (
    <span data-testid="grid-playback-intent">
      {playback === null ? '-' : `${playback.target.mediaId}@${playback.phase}`}
    </span>
  );
}

interface GridHarnessOptions {
  readonly session: LiveSessionState;
  readonly initialEntry: string;
}

/** 挂载 ChannelGridPage(MemoryRouter 直挂;真实 ActionCoordinator 拦截基建) */
function renderGridPage(options: GridHarnessOptions) {
  return renderLiveWorld(
    <>
      <ChannelGridPage />
      <LocationProbe />
      <PlaybackIntentProbe />
    </>,
    {
      session: options.session,
      initialEntries: [options.initialEntry],
      decorate: (ui: ReactNode): ReactNode => (
        <SettingsAccessProvider>
          <ActionCoordinator>{ui}</ActionCoordinator>
        </SettingsAccessProvider>
      ),
    },
  );
}

beforeEach(() => {
  installGridFetchRouter();
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

// ────────────────────────── ① URL ?group= 自动高亮 Tab(US3 验收 1) ──────────────────────────

describe('T018 · URL ?group= 与分类 Tabs 联动(routing-and-url-state §2.2)', () => {
  it('携带 ?group=movie:电影 Tab 自动激活(aria-selected),网格仅渲染电影组频道,请求 section=group&groupKey=movie', async () => {
    const world = renderGridPage({
      session: LIVE_SESSION_STATES.guest,
      initialEntry: '/live/channels?group=movie',
    });
    try {
      // 无需手动二次点击:电影 Tab 自动高亮,其余 Tab 未选中
      await waitFor(() => {
        expect(screen.getByRole('tab', { name: '电影' })).toHaveAttribute('aria-selected', 'true');
      });
      expect(screen.getByRole('tab', { name: '全部' })).toHaveAttribute('aria-selected', 'false');
      expect(screen.getByRole('tab', { name: '音乐' })).toHaveAttribute('aria-selected', 'false');

      // 网格仅渲染该组频道(频道名集合断言;fixtures 电影组 = 星光影城/经典电影台/动作影院)
      for (const row of LIVE_REDESIGN_CHANNELS_BY_GROUP['movie'] ?? []) {
        await waitFor(() => {
          expect(screen.getByRole('article', { name: `频道 ${row.media.title}` })).toBeTruthy();
        });
      }
      expect(screen.queryByRole('article', { name: '频道 流行音乐台' })).toBeNull();
      expect(screen.queryByRole('article', { name: '频道 体育赛事台' })).toBeNull();

      // 请求形态:section=group + groupKey=movie(api-reuse §1 分类频道列表)
      const groupCalls = channelCalls().filter((url) => url.searchParams.get('section') === 'group');
      expect(groupCalls.length).toBeGreaterThanOrEqual(1);
      expect(groupCalls[0]?.searchParams.get('groupKey')).toBe('movie');
    } finally {
      world.restore();
    }
  });

  it('无参数:默认激活「全部」Tab(前端伪分组),请求 section=all&page=1&pageSize=50 且不带 groupKey/q', async () => {
    const world = renderGridPage({
      session: LIVE_SESSION_STATES.guest,
      initialEntry: '/live/channels',
    });
    try {
      await waitFor(() => {
        expect(screen.getByRole('tab', { name: '全部' })).toHaveAttribute('aria-selected', 'true');
      });
      // 全部 9 频道渲染
      for (const row of LIVE_REDESIGN_CHANNELS) {
        await waitFor(() => {
          expect(screen.getByRole('article', { name: `频道 ${row.media.title}` })).toBeTruthy();
        });
      }
      const allCalls = channelCalls().filter((url) => url.searchParams.get('section') === 'all');
      expect(allCalls.length).toBeGreaterThanOrEqual(1);
      const first = allCalls[0];
      expect(first?.searchParams.get('page')).toBe('1');
      expect(first?.searchParams.get('pageSize')).toBe('50');
      expect(first?.searchParams.get('groupKey')).toBeNull();
      expect(first?.searchParams.get('q')).toBeNull();
    } finally {
      world.restore();
    }
  });

  it('非法 ?group=nonexistent:回退「全部」并按 section=all 取数(routing-and-url-state §2.2 回退规则)', async () => {
    const world = renderGridPage({
      session: LIVE_SESSION_STATES.guest,
      initialEntry: '/live/channels?group=nonexistent',
    });
    try {
      await waitFor(() => {
        expect(screen.getByRole('tab', { name: '全部' })).toHaveAttribute('aria-selected', 'true');
      });
      await waitFor(() => {
        expect(channelCalls().some((url) => url.searchParams.get('section') === 'all')).toBe(true);
      });
    } finally {
      world.restore();
    }
  });
});

// ────────────────────────── ② Tab 切换:网格与 URL 同步(US3 验收 2) ──────────────────────────

describe('T018 · Tab 切换与 URL 同步(US3 验收 2;不刷新整页)', () => {
  it('点击「体育」Tab:URL 同步 ?group=sports,Tab 高亮迁移,网格平滑更新为体育组频道', async () => {
    const user = userEvent.setup();
    const world = renderGridPage({
      session: LIVE_SESSION_STATES.guest,
      initialEntry: '/live/channels',
    });
    try {
      await waitFor(() => {
        expect(screen.getByRole('article', { name: '频道 星光影城' })).toBeTruthy();
      });
      await user.click(screen.getByRole('tab', { name: '体育' }));
      // URL 参数同步(内存路由;无整页刷新)
      await waitFor(() => {
        expect(screen.getByTestId('grid-location').textContent).toBe('/live/channels?group=sports');
      });
      await waitFor(() => {
        expect(screen.getByRole('tab', { name: '体育' })).toHaveAttribute('aria-selected', 'true');
      });
      // 网格更新为体育组;全量电影频道不再出现
      await waitFor(() => {
        expect(screen.getByRole('article', { name: '频道 体育赛事台' })).toBeTruthy();
      });
      expect(screen.getByRole('article', { name: '频道 篮球频道' })).toBeTruthy();
      expect(screen.queryByRole('article', { name: '频道 星光影城' })).toBeNull();
      // 新分类取数形态
      const sportsCalls = channelCalls().filter((url) => url.searchParams.get('groupKey') === 'sports');
      expect(sportsCalls.length).toBeGreaterThanOrEqual(1);
    } finally {
      world.restore();
    }
  });
});

// ────────────────────────── ③ 搜索:300ms 防抖 + 过滤 + 一键清空(api-reuse §2.3) ──────────────────────────

describe('T018 · 搜索防抖与过滤(api-reuse §2.3;US3 验收 3)', () => {
  it('输入关键字:300ms 防抖后仅一次携带最终 q 的请求(无逐键中间请求),返回过滤结果渲染;清空恢复', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    const world = renderGridPage({
      session: LIVE_SESSION_STATES.guest,
      initialEntry: '/live/channels?group=movie',
    });
    try {
      await waitFor(() => {
        expect(screen.getByRole('article', { name: '频道 星光影城' })).toBeTruthy();
      });
      const qCalls = () => channelCalls().filter((url) => url.searchParams.get('q') !== null);
      const input = screen.getByLabelText('搜索频道');
      await user.type(input, '经典');
      // 防抖窗口内(未满 300ms)不发起任何 q 请求
      expect(qCalls().length).toBe(0);
      await act(async () => {
        vi.advanceTimersByTime(SEARCH_DEBOUNCE_MS);
      });
      // 恰好一次最终关键字请求;携带当前分类(section=group&groupKey=movie);
      // 无逐键中间请求(「经」从未成为独立查询 → 防抖成立)
      const calls = qCalls();
      expect(calls.length).toBe(1);
      expect(calls[0]?.searchParams.get('q')).toBe('经典');
      expect(calls[0]?.searchParams.get('section')).toBe('group');
      expect(calls[0]?.searchParams.get('groupKey')).toBe('movie');
      // 桩按 q 过滤:仅经典电影台渲染
      await waitFor(() => {
        expect(screen.getByRole('article', { name: '频道 经典电影台' })).toBeTruthy();
      });
      expect(screen.queryByRole('article', { name: '频道 星光影城' })).toBeNull();

      // 一键清空(SearchField 清除按钮):q 从 URL 移除,网格恢复该组全量
      await user.click(screen.getByRole('button', { name: '清空搜索' }));
      await waitFor(() => {
        expect(screen.getByTestId('grid-location').textContent).toBe('/live/channels?group=movie');
      });
      await waitFor(() => {
        expect(screen.getByRole('article', { name: '频道 星光影城' })).toBeTruthy();
      });
    } finally {
      world.restore();
    }
  });
});

// ────────────────────────── ④ 视图切换:view=grid|list(routing §2.2 view 参数) ──────────────────────────

describe('T018 · 视图切换(?view;grid 缺省)', () => {
  it('切换列表视图:URL 写 ?view=list 并以紧凑列表渲染(非 16:9 瓦片);切回网格后 URL 恢复缺省(不带 view)', async () => {
    const user = userEvent.setup();
    const world = renderGridPage({
      session: LIVE_SESSION_STATES.guest,
      initialEntry: '/live/channels',
    });
    try {
      await waitFor(() => {
        expect(screen.getByRole('article', { name: '频道 星光影城' })).toBeTruthy();
      });
      await user.click(screen.getByRole('radio', { name: '列表视图' }));
      await waitFor(() => {
        expect(screen.getByTestId('grid-location').textContent).toBe('/live/channels?view=list');
      });
      // 紧凑列表:频道名可读文本存在,瓦片 article 不再渲染
      expect(screen.getByText('星光影城')).toBeTruthy();
      expect(screen.queryByRole('article', { name: '频道 星光影城' })).toBeNull();
      await user.click(screen.getByRole('radio', { name: '网格视图' }));
      await waitFor(() => {
        expect(screen.getByTestId('grid-location').textContent).toBe('/live/channels');
      });
      await waitFor(() => {
        expect(screen.getByRole('article', { name: '频道 星光影城' })).toBeTruthy();
      });
    } finally {
      world.restore();
    }
  });
});

// ────────────────────────── ⑤ 卡片播放:游客拦截(真实协调器)+ play 入参(真实管线) ──────────────────────────

describe('T018 · 卡片中央 ▶ 播放(US3 验收 4;ActionCoordinator 唯一管线)', () => {
  it('游客:统一协调器拦截进入登录弹层,登录选档前零 /playback 与 /me 请求;取消不播放', async () => {
    const user = userEvent.setup();
    const counter = installNetworkCounter();
    const world = renderGridPage({
      session: LIVE_SESSION_STATES.guest,
      initialEntry: '/live/channels?group=movie',
    });
    try {
      await waitFor(() => {
        expect(screen.getByRole('article', { name: '频道 星光影城' })).toBeTruthy();
      });
      const playbackBefore = counter.counts.playback;
      const personalBefore = counter.counts.personal;
      // 中央 ▶(ChannelTile hover 快捷起播;aria-label=播放 <频道名>)
      await user.click(screen.getByRole('button', { name: `播放 ${STAR.media.title}` }));
      // 拦截行为归 ActionCoordinator:统一登录弹层(本页面不自写登录判断)
      expect(await screen.findByRole('dialog')).toBeTruthy();
      expect(await screen.findByRole('heading', { name: '登录' })).toBeTruthy();
      expect(counter.counts.playback).toBe(playbackBefore);
      expect(counter.counts.personal).toBe(personalBefore);
      // 取消:弹层收口、意图废弃;仍零播放请求
      await user.click(screen.getByRole('button', { name: '取消' }));
      await waitFor(() => {
        expect(screen.queryByRole('dialog')).toBeNull();
      });
      expect(counter.counts.playback).toBe(playbackBefore);
    } finally {
      world.restore();
      counter.restore();
    }
  });

  it('已选档:点击中央 ▶ 以正确入参发起播放(resolve body = {mediaId, startMode: beginning}),播放面挂载', async () => {
    const user = userEvent.setup();
    const world = renderGridPage({
      session: LIVE_SESSION_STATES.authedWithProfile,
      initialEntry: '/live/channels?group=movie',
    });
    try {
      await waitFor(() => {
        expect(screen.getByRole('article', { name: '频道 星光影城' })).toBeTruthy();
      });
      await user.click(screen.getByRole('button', { name: `播放 ${STAR.media.title}` }));
      // 全链 authorize→prepare→playing(play 入参经真实管线落 resolve body)
      await waitFor(
        () => {
          expect(screen.getByTestId('grid-playback-intent').textContent).toBe(
            `${STAR.media.id}@playing`,
          );
        },
        { timeout: 3_000 },
      );
      expect(resolveBodies).toEqual([{ mediaId: STAR.media.id, startMode: 'beginning' }]);
      expect(document.querySelector('[data-testid="playback-surface"]')).not.toBeNull();
    } finally {
      world.restore();
    }
  });
});
