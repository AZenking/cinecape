import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, screen, waitFor } from '@testing-library/react';
import { useLocation } from 'react-router';
import type { ReactNode } from 'react';
import type { GuideWindowDto } from '@hmp/shared';
import { ActionCoordinator } from '../src/app/action-coordinator';
import { SettingsAccessProvider } from '../src/features/settings/settings-access-provider';
import { GuidePage } from '../src/features/epg/GuidePage';
import { LIVE_NOW, LIVE_PROGRAMME_STATES, LIVE_TEST_TIMEZONE, liveChannelMedia } from './helpers/live-data';
import { LIVE_SESSION_STATES, LiveSessionProbe, renderLiveWorld } from './helpers/live-world';
import { installNetworkCounter } from './helpers/network-assertions';

/**
 * 012 T009 · EPG 频道观看按钮统一播放链路钉面(FR-017 后半、ui.md §1.1/§3.4):
 *
 * 现状核对结论(GuideWall/GuidePage 已接线,本文件为防回退钉面,零源码改动):
 * - 节目墙频道列「直播」按钮(aria:播放 … 当前直播)经共享 usePlayAction 发起:
 *   游客点击 → 统一登录弹层(至多一层),授权前零 /playback/ 与 /me/ 请求;
 * - 目标为**频道此刻内容**而非未来节目:已选档路径的 authorize 请求体仅含
 *   { mediaId, startMode }(mediaId=频道 id;无节目绑定字段,登录/等待期间目标
 *   结束由服务端按最新状态重判,FR-008/§1.4);
 * - 节目块点击 = 打开详情面板,不播放(§3.4):面板出现、零 /playback/ 请求;
 * - 无节目频道同样保留频道观看按钮(播放当前内容,FR-012)。
 *
 * 面板宿主为 GuidePage 当前挂载的详情面板(T022 起为共享面板);本钉面只断言
 * 「开面板不播放 + 统一链路」,不重复面板内部结构(T003/宿主测试已覆盖)。
 */

/* ---------------- GuideWindow 夹具(服务端家庭时区;窗口覆盖 LIVE_NOW) ---------------- */

const CH_NEWS_ID = 'a0000000-0000-4000-8000-000000000101';
const CH_FILM_ID = 'a0000000-0000-4000-8000-000000000102';
const CH_NEWS_TITLE = '例牌新闻台';
const CH_FILM_TITLE = '例牌电影频道';

function guideWindowFixture(): GuideWindowDto {
  return {
    date: '2026-11-01',
    timezone: LIVE_TEST_TIMEZONE,
    now: LIVE_NOW,
    allowedDates: ['2026-11-01', '2026-11-02', '2026-11-03'],
    from: '2026-11-01T11:00:00.000Z', // 19:00(家庭时区)
    to: '2026-11-01T13:00:00.000Z', // 21:00(家庭时区)
    page: 1,
    pageSize: 20,
    totalChannels: 2,
    catalogRevision: 1,
    channels: [
      {
        media: liveChannelMedia({ id: CH_NEWS_ID, title: CH_NEWS_TITLE }),
        programmes: [LIVE_PROGRAMME_STATES.now, LIVE_PROGRAMME_STATES.upcoming],
      },
      {
        media: liveChannelMedia({ id: CH_FILM_ID, title: CH_FILM_TITLE }),
        programmes: [], // 无节目单频道:保留身份与频道观看按钮(FR-012)
      },
    ],
  };
}

/* ---------------- fetch 路由桩 ---------------- */

let resolveBodies: unknown[] = [];

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': status >= 400 ? 'application/problem+json' : 'application/json' },
  });
}

function installFetchRouter(): void {
  resolveBodies = [];
  vi.stubGlobal(
    'fetch',
    vi.fn((input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const url = new URL(String(input), 'http://localhost:3000');
      const method = (init?.method ?? 'GET').toUpperCase();
      if (method === 'POST' && url.pathname === '/api/playback/resolve') {
        resolveBodies.push(JSON.parse(String(init?.body ?? '{}')));
        return Promise.resolve(jsonResponse({ status: 403, code: 'PROFILE_CONTENT_LEVEL_DENIED', title: 'Forbidden' }, 403));
      }
      if (method === 'GET' && url.pathname === '/api/setup/status') {
        return Promise.resolve(jsonResponse({ initialized: true }));
      }
      if (method === 'GET' && url.pathname === '/api/public/guide') {
        return Promise.resolve(jsonResponse(guideWindowFixture()));
      }
      return Promise.resolve(jsonResponse({ status: 404, code: 'NOT_FOUND', title: 'NOT_FOUND' }, 404));
    }),
  );
}

/** 路由探针:断言播放入口不导航(播放≠详情/登录页) */
function LocationProbe(): ReactNode {
  const location = useLocation();
  return (
    <span data-testid="loc">
      {location.pathname}
      {location.search}
    </span>
  );
}

function renderGuidePage(session: (typeof LIVE_SESSION_STATES)[keyof typeof LIVE_SESSION_STATES]) {
  const counter = installNetworkCounter();
  const world = renderLiveWorld(
    <>
      <GuidePage />
      <LiveSessionProbe />
      <LocationProbe />
    </>,
    {
      session,
      initialEntries: ['/live/guide'],
      decorate: (ui: ReactNode): ReactNode => (
        <SettingsAccessProvider>
          <ActionCoordinator>{ui}</ActionCoordinator>
        </SettingsAccessProvider>
      ),
    },
  );
  return { counter, world };
}

beforeEach(() => {
  installFetchRouter();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('T009 · EPG 频道观看按钮经统一播放链路(钉面;现状已接线)', () => {
  it('游客点频道「直播」按钮:进入统一登录弹层(非详情面板),零 /playback/ 与 /me/ 请求,页面保持在 /live/guide', async () => {
    const { counter, world } = renderGuidePage(LIVE_SESSION_STATES.guest);
    try {
      await waitFor(() => expect(screen.getByTestId('live-session').textContent).toBe('anonymous:none'));
      const watch = await screen.findByRole('button', { name: `播放 ${CH_NEWS_TITLE} 当前直播` });
      expect(counter.counts.playback).toBe(0);
      expect(counter.counts.personal).toBe(0);
      // 无节目单频道同样保留频道观看按钮(播放该频道当前内容,FR-012)
      // (须在登录弹层打开前断言:RAC Modal 打开时底层内容 aria-hidden,查询不可见)
      expect(screen.getByRole('button', { name: `播放 ${CH_FILM_TITLE} 当前直播` })).toBeVisible();

      // 频道观看按钮 → 统一链路:登录弹层(至多一层),不打开详情面板
      fireEvent.click(watch);
      await waitFor(() => expect(screen.getByRole('dialog', { name: '登录' })).toBeVisible());
      expect(screen.queryByRole('dialog', { name: /节目详情/ })).toBeNull();
      expect(counter.counts.playback).toBe(0);
      expect(counter.counts.personal).toBe(0);
      expect(screen.getByTestId('loc').textContent).toBe('/live/guide');
    } finally {
      world.restore();
      counter.restore();
    }
  });

  it('已选档点频道观看按钮:authorize 请求体为频道语义(mediaId=频道 id、无节目绑定字段)', async () => {
    const { counter, world } = renderGuidePage(LIVE_SESSION_STATES.authedWithProfile);
    try {
      await waitFor(() => expect(screen.getByTestId('live-session').textContent).toBe('authenticated:profile-a'));
      fireEvent.click(await screen.findByRole('button', { name: `播放 ${CH_NEWS_TITLE} 当前直播` }));

      // 目标 = 频道此刻内容(非未来节目):仅 mediaId + startMode,服务端届时重判(FR-008)
      await waitFor(() => expect(resolveBodies.length).toBe(1));
      expect(resolveBodies[0]).toEqual({ mediaId: CH_NEWS_ID, startMode: 'beginning' });
      expect(counter.counts.personal).toBe(0);
    } finally {
      world.restore();
      counter.restore();
    }
  });

  it('节目块点击 = 开面板不播放(§3.4):详情面板出现、零 /playback/ 请求、无登录弹层', async () => {
    const { counter, world } = renderGuidePage(LIVE_SESSION_STATES.guest);
    try {
      await waitFor(() => expect(screen.getByTestId('live-session').textContent).toBe('anonymous:none'));
      const block = await screen.findByRole('button', { name: /例牌新闻台,例牌正播节目/ });

      fireEvent.click(block);
      const panel = await screen.findByRole('dialog', { name: /节目详情/ });
      expect(panel).toBeVisible();
      expect(screen.queryByRole('dialog', { name: '登录' })).toBeNull();
      expect(counter.counts.playback).toBe(0);
      expect(counter.counts.personal).toBe(0);
      expect(screen.getByTestId('loc').textContent).toBe('/live/guide');
    } finally {
      world.restore();
      counter.restore();
    }
  });
});
