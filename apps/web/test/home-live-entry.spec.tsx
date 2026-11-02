import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, screen, waitFor } from '@testing-library/react';
import { useLocation } from 'react-router';
import type { ReactNode } from 'react';
import { ActionCoordinator } from '../src/app/action-coordinator';
import { SettingsAccessProvider } from '../src/features/settings/settings-access-provider';
import { HomePage } from '../src/features/home/HomePage';
import { LIVE_PROGRAMME_STATES, liveChannelMedia } from './helpers/live-data';
import { LIVE_SESSION_STATES, LiveSessionProbe, renderLiveWorld } from './helpers/live-world';
import { installNetworkCounter } from './helpers/network-assertions';

/**
 * 012 T010 · 首页直播播放入口统一链路钉面(FR-005、ui.md §1.1;SC-001 三入口之「首页」):
 *
 * 现状核对结论(home/personal-area 已用共享 PlayButton,本文件为防回退钉面,零源码改动):
 * - 首页个人区收藏频道卡的主按钮「观看直播 …」= 共享 PlayButton → usePlayAction
 *   统一链路:已选档点击 → 统一协调器 authorize(authorize 请求体为频道语义,
 *   { mediaId, startMode },mediaId=频道 id;无节目绑定字段,FR-008「频道此刻内容」);
 * - 游客首页无个人区(零 /me 请求、无播放入口)已由 home-personal-area.spec.tsx 场景 1
 *   钉住,此处不重复;公共区「直播」卡片为 /live 导航入口(非播放动作,§1.1 播放入口
 *   以经 usePlayAction 发起为准)。
 *
 * 场景载体:真实 HomePage + ActionCoordinator;收藏/历史经 T004 会话世界三态 mock;
 * authorize 桩返回 403(内部码仅存在于响应体)以轻量证明「进入统一授权链路」,
 * 不起播媒体流。
 */

const FAV_CHANNEL_ID = 'a0000000-0000-4000-8000-000000000201';
const FAV_CHANNEL_TITLE = '例牌收藏频道';

/** GET /me/favorites/channels 条目(服务端收藏 DTO 形状;favorites-api 白名单字段) */
function favoritePage() {
  return {
    items: [
      {
        media: liveChannelMedia({ id: FAV_CHANNEL_ID, title: FAV_CHANNEL_TITLE }),
        createdAt: '2026-11-01T00:00:00.000Z',
        current: LIVE_PROGRAMME_STATES.now,
        next: null,
      },
    ],
    nextCursor: null,
  };
}

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
      if (method === 'GET' && url.pathname === '/api/public/context') {
        return Promise.resolve(
          jsonResponse({ initialized: true, displayName: '例牌家庭' }),
        );
      }
      if (method === 'GET' && url.pathname === '/api/me/favorites/channels') {
        return Promise.resolve(jsonResponse(favoritePage()));
      }
      if (method === 'GET' && url.pathname === '/api/me/history') {
        return Promise.resolve(jsonResponse({ items: [], nextCursor: null }));
      }
      return Promise.resolve(jsonResponse({ status: 404, code: 'NOT_FOUND', title: 'NOT_FOUND' }, 404));
    }),
  );
}

function LocationProbe(): ReactNode {
  const location = useLocation();
  return (
    <span data-testid="loc">
      {location.pathname}
      {location.search}
    </span>
  );
}

function renderHomePage(session: (typeof LIVE_SESSION_STATES)[keyof typeof LIVE_SESSION_STATES]) {
  const counter = installNetworkCounter();
  const world = renderLiveWorld(
    <>
      <HomePage />
      <LiveSessionProbe />
      <LocationProbe />
    </>,
    {
      session,
      initialEntries: ['/'],
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

describe('T010 · 首页直播播放入口经统一链路(钉面;现状已用共享 PlayButton)', () => {
  it('已选档点收藏卡「观看直播」:进入统一授权链路(authorize 请求体=频道语义),拒绝文案稳定、不导航', async () => {
    const { counter, world } = renderHomePage(LIVE_SESSION_STATES.authedWithProfile);
    try {
      await waitFor(() => expect(screen.getByTestId('live-session').textContent).toBe('authenticated:profile-a'));

      // 个人区收藏卡主按钮 = 共享 PlayButton(label「观看直播」,aria 含频道名)
      const watch = await screen.findByRole('button', { name: `观看直播 ${FAV_CHANNEL_TITLE}` });
      expect(counter.counts.playback).toBe(0);
      fireEvent.click(watch);

      // 统一协调器 authorize:请求体仅 mediaId(频道)+ startMode(频道此刻内容,FR-008)
      await waitFor(() => expect(resolveBodies.length).toBe(1));
      expect(resolveBodies[0]).toEqual({ mediaId: FAV_CHANNEL_ID, startMode: 'beginning' });

      // 授权拒绝面在入口上下文展示(FR-007):稳定文案、无内部码、不离开首页
      const surface = await screen.findByTestId('playback-surface');
      expect(surface.textContent).toContain('当前档案暂不能播放该内容,请切换档案或稍后重试。');
      expect(surface.textContent).not.toMatch(/403|PROFILE_CONTENT_LEVEL_DENIED/i);
      expect(screen.getByTestId('loc').textContent).toBe('/');
      expect(counter.counts.personal).toBeGreaterThan(0); // 个人区数据读取(已选档允许)
    } finally {
      world.restore();
      counter.restore();
    }
  });
});
