import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import type { ReactNode } from 'react';
import { ActionCoordinator } from '../src/app/action-coordinator';
import { SettingsAccessProvider } from '../src/features/settings/settings-access-provider';
import { LivePage } from '../src/features/live/LivePage';
import { liveChannelPage, liveChannelRows, liveGroupPage } from './helpers/live-data';
import type { ChannelRowDto } from '@hmp/shared';
import { LIVE_SESSION_STATES, LiveSessionProbe, renderLiveWorld } from './helpers/live-world';
import { installNetworkCounter } from './helpers/network-assertions';

/**
 * 012 T011 · 直播卡片收藏行为约束(FR-009/FR-011、ui.md §1.5、quickstart 场景 2):
 *
 * - 游客点收藏:仅显示登录引导(GuestActionNotice,提示内含显式登录入口),
 *   **零请求**——installNetworkCounter 断言 /playback/* 与 /me/* 计数为 0
 *   (FR-009「不产生部分写入」;SC-006 负向断言落点);
 * - 已选档点收藏:仅调收藏接口(PUT /me/favorites/channels/{mediaId},幂等),
 *   **不触发播放**——零 /playback/* 请求、无登录弹层、无播放面挂载;
 * - 成功为行内反馈:星标原地翻面(☆收藏 → ★已收藏,aria-pressed/可访问名同步),
 *   不依赖全页刷新或跳转(ui.md §1.5「收藏成功为行内反馈」);
 * - 收藏与播放分离:收藏路径不进入统一播放链路意图(无 authorizing/preparing 浮层)。
 *
 * 场景载体:真实 LivePage(经 renderLiveWorld 三态会话 + ActionCoordinator 统一链路),
 * 数据桩 = T004 live-data(例牌新闻台,current=now/next=upcoming)。
 * 断言工具 = T004 network-assertions(installNetworkCounter;先装路由 mock、
 * 再装计数器、最后 renderLiveWorld 叠加会话 mock,与 T007 消费面同序)。
 */

/* ---------------- fetch 路由桩:记录收藏写入,其余按端点应答 ---------------- */

interface RecordedWrite {
  readonly method: string;
  readonly pathname: string;
}

let favoriteWrites: RecordedWrite[] = [];

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
  favoriteWrites = [];
  vi.stubGlobal(
    'fetch',
    vi.fn((input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const url = new URL(String(input), 'http://localhost:3000');
      const method = (init?.method ?? 'GET').toUpperCase();
      if (method === 'PUT' && url.pathname.startsWith('/api/me/favorites/channels/')) {
        favoriteWrites.push({ method, pathname: url.pathname });
        return Promise.resolve(new Response(null, { status: 204 }));
      }
      if (method === 'GET' && url.pathname === '/api/setup/status') {
        return Promise.resolve(jsonResponse({ initialized: true }));
      }
      if (method === 'GET' && url.pathname === '/api/public/live/groups') {
        return Promise.resolve(jsonResponse(liveGroupPage()));
      }
      if (method === 'GET' && url.pathname === '/api/public/live/channels') {
        return Promise.resolve(jsonResponse(liveChannelPage()));
      }
      // 兜底:夹具世界内意外请求一律 404 problem(不出网、可断言)
      return Promise.resolve(problemResponse(404, 'NOT_FOUND'));
    }),
  );
}

/** renderLiveWorld 装配:LivePage + 会话探针,外包统一协调器(T007 消费面同形) */
function renderLivePage(session: (typeof LIVE_SESSION_STATES)[keyof typeof LIVE_SESSION_STATES]) {
  const counter = installNetworkCounter();
  const world = renderLiveWorld(
    <>
      <LivePage />
      <LiveSessionProbe />
    </>,
    {
      session,
      initialEntries: ['/live'],
      decorate: (ui: ReactNode): ReactNode => (
        <SettingsAccessProvider>
          <ActionCoordinator>{ui}</ActionCoordinator>
        </SettingsAccessProvider>
      ),
    },
  );
  return { counter, world };
}

/** 首张频道行(noUncheckedIndexedAccess 守卫;T007 liveChannelTarget 同款) */
function firstChannelRow(): ChannelRowDto {
  const row = liveChannelRows()[0];
  if (row === undefined) {
    throw new Error('live-data 夹具异常:频道行缺失');
  }
  return row;
}

const FIRST_TILE = firstChannelRow();

/** 等待直播分区渲染完成(首张瓦片 article 可见;NowHero 与瓦片同名播放钮并存,以瓦片作用域收窄) */
async function waitForTiles(): Promise<HTMLElement> {
  const title = FIRST_TILE.media.title;
  await waitFor(() => {
    expect(screen.getAllByRole('article', { name: `频道 ${title}` }).length).toBeGreaterThan(0);
  });
  return screen.getAllByRole('article', { name: `频道 ${title}` })[0] as HTMLElement;
}

beforeEach(() => {
  installFetchRouter();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('T011 · 游客点收藏:登录引导 + 零请求(ui.md §1.5)', () => {
  it('游客点击星标:出现 GuestActionNotice 登录引导,全程零 /playback/ 与 /me/ 请求;点「登录」进统一弹层仍零请求', async () => {
    const { counter, world } = renderLivePage(LIVE_SESSION_STATES.guest);
    try {
      await waitFor(() => expect(screen.getByTestId('live-session').textContent).toBe('anonymous:none'));
      const tile = await waitForTiles();
      expect(counter.counts.playback).toBe(0);
      expect(counter.counts.personal).toBe(0);

      // 游客点收藏:仅出现登录引导(提示文案含动作语境),不发起任何请求
      fireEvent.click(within(tile).getByRole('button', { name: `收藏 ${FIRST_TILE.media.title}` }));
      expect(await screen.findByText(`收藏 ${FIRST_TILE.media.title}需要先登录并选择档案`)).toBeVisible();
      await new Promise((resolve) => setTimeout(resolve, 50)); // 放行微任务,证明「零请求」不是时序侥幸
      expect(counter.counts.playback).toBe(0);
      expect(counter.counts.personal).toBe(0);
      expect(screen.queryByRole('dialog')).toBeNull(); // 不进入统一登录弹层(仅引导)
      expect(screen.queryByTestId('playback-surface')).toBeNull();
      expect(screen.queryByTestId('playback-preparing')).toBeNull();

      // 引导内的显式「登录」入口:进入统一登录意图(公共 /setup/status,不计入个人/播放前缀)
      fireEvent.click(screen.getByRole('button', { name: '登录' }));
      await waitFor(() => expect(screen.getByRole('dialog')).toBeVisible());
      expect(counter.counts.playback).toBe(0);
      expect(counter.counts.personal).toBe(0);
      expect(favoriteWrites).toEqual([]); // 游客路径零部分写入
    } finally {
      world.restore();
      counter.restore();
    }
  });
});

describe('T011 · 已选档点收藏:仅调 favorites、不触发播放、成功行内反馈', () => {
  it('已选档点击星标:PUT /me/favorites/channels/{mediaId} 幂等写入;零 /playback/ 请求、无播放面;星标行内翻面为已收藏', async () => {
    const { counter, world } = renderLivePage(LIVE_SESSION_STATES.authedWithProfile);
    try {
      await waitFor(() => expect(screen.getByTestId('live-session').textContent).toBe('authenticated:profile-a'));
      const tile = await waitForTiles();

      // 已选档点收藏:进入收藏变更(不弹登录引导、不进统一播放意图)
      fireEvent.click(within(tile).getByRole('button', { name: `收藏 ${FIRST_TILE.media.title}` }));

      // 行内反馈:星标原地翻面(可访问名 ☆收藏 → ★已收藏;aria-pressed 同步)
      const starred = await within(tile).findByRole('button', { name: `取消收藏 ${FIRST_TILE.media.title}` });
      await waitFor(() => expect(starred.getAttribute('aria-pressed')).toBe('true'));
      expect(within(tile).getByText('已收藏')).toBeVisible();

      // 仅收藏写入:恰好一次幂等 PUT,路径指向该频道 mediaId
      await waitFor(() => expect(favoriteWrites.length).toBe(1));
      expect(favoriteWrites[0]?.method).toBe('PUT');
      expect(favoriteWrites[0]?.pathname).toBe(`/api/me/favorites/channels/${encodeURIComponent(FIRST_TILE.media.id)}`);

      // 不触发播放:零 /playback/ 请求、无统一登录弹层、无播放面(收藏与播放分离,§1.5)
      expect(counter.counts.playback).toBe(0);
      expect(screen.queryByRole('dialog')).toBeNull();
      expect(screen.queryByTestId('playback-surface')).toBeNull();
      expect(screen.queryByTestId('playback-preparing')).toBeNull();

      // 行内反馈稳定:对账收敛后仍为已收藏(不闪回未收藏态)
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(within(tile).getByRole('button', { name: `取消收藏 ${FIRST_TILE.media.title}` })).toBeVisible();
      expect(counter.counts.personal).toBe(1);
    } finally {
      world.restore();
      counter.restore();
    }
  });

  it('已选档点收藏失败(网络拒绝):星标回滚为未收藏,行内错误提示,依旧零播放请求', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn((input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
        const url = new URL(String(input), 'http://localhost:3000');
        const method = (init?.method ?? 'GET').toUpperCase();
        if (method === 'PUT' && url.pathname.startsWith('/api/me/favorites/channels/')) {
          return Promise.resolve(problemResponse(503, 'SERVICE_UNAVAILABLE'));
        }
        if (method === 'GET' && url.pathname === '/api/setup/status') {
          return Promise.resolve(jsonResponse({ initialized: true }));
        }
        if (method === 'GET' && url.pathname === '/api/public/live/groups') {
          return Promise.resolve(jsonResponse(liveGroupPage()));
        }
        if (method === 'GET' && url.pathname === '/api/public/live/channels') {
          return Promise.resolve(jsonResponse(liveChannelPage()));
        }
        return Promise.resolve(problemResponse(404, 'NOT_FOUND'));
      }),
    );
    const { counter, world } = renderLivePage(LIVE_SESSION_STATES.authedWithProfile);
    try {
      await waitFor(() => expect(screen.getByTestId('live-session').textContent).toBe('authenticated:profile-a'));
      const tile = await waitForTiles();

      fireEvent.click(within(tile).getByRole('button', { name: `收藏 ${FIRST_TILE.media.title}` }));

      // 失败回滚:乐观翻面收敛回未收藏(服务端真值;错误文案经数据层 Toast 通道)
      await waitFor(() => {
        expect(within(tile).getByRole('button', { name: `收藏 ${FIRST_TILE.media.title}` })).toBeVisible();
      });
      expect(within(tile).queryByText('已收藏')).toBeNull();

      // 失败同样不得触发播放(收藏与播放分离)
      expect(counter.counts.playback).toBe(0);
      expect(screen.queryByTestId('playback-surface')).toBeNull();
      expect(screen.queryByTestId('playback-preparing')).toBeNull();
    } finally {
      world.restore();
      counter.restore();
    }
  });
});
