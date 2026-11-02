import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { useLocation } from 'react-router';
import type { ReactNode } from 'react';
import { ActionCoordinator } from '../src/app/action-coordinator';
import { SettingsAccessProvider } from '../src/features/settings/settings-access-provider';
import { LivePage } from '../src/features/live/LivePage';
import { liveChannelPage, liveChannelRows, liveGroupPage } from './helpers/live-data';
import type { ChannelRowDto } from '@hmp/shared';
import { LIVE_SESSION_STATES, LiveSessionProbe, renderLiveWorld } from './helpers/live-world';
import { installNetworkCounter } from './helpers/network-assertions';

/**
 * 012 T013 · 服务端授权拒绝体验(FR-007、ui.md §1.3;quickstart 场景 1 步骤 5/场景 5):
 *
 * - 拒绝原因在入口上下文展示:authorize 被服务端拒绝(POST /playback/resolve 403)
 *   → unavailable 浮层(role=alert)展示稳定文案,**不导航离开原页面**(URL 保持 /live,
 *   页面标题与触发瓦片仍在);
 * - 不暴露内部错误码:浮层文案只含面向观看者的稳定提示,不含 HTTP 状态码、
 *   problem code、策略/票据等内部诊断字样;
 * - 可重试/返回:浮层提供「重试」(复用统一 play 链路,同一目标重新 authorize——
 *   新意图取代旧意图,不产生并行会话)与「关闭」(返回入口上下文,节目详情可再次打开);
 * - 游客路径(T007 已钉)此处不重复;本文件聚焦已选档的授权拒绝面。
 *
 * 场景载体:真实 LivePage + ActionCoordinator(统一链路唯一状态机),resolve 桩返回
 * 403 problem(内部 code 仅存在于响应体,断言其不出现在 UI 文案中)。
 */

/* ---------------- fetch 路由桩:resolve 恒 403(problem 体带内部码) ---------------- */

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': status >= 400 ? 'application/problem+json' : 'application/json' },
  });
}

let resolveCalls = 0;

function installFetchRouter(): void {
  resolveCalls = 0;
  vi.stubGlobal(
    'fetch',
    vi.fn((input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const url = new URL(String(input), 'http://localhost:3000');
      const method = (init?.method ?? 'GET').toUpperCase();
      if (method === 'POST' && url.pathname === '/api/playback/resolve') {
        resolveCalls += 1;
        // 内部拒绝语义:HTTP 状态码 + problem code 只存在于响应体,UI 不得透出
        return Promise.resolve(
          jsonResponse({ status: 403, code: 'PROFILE_CONTENT_LEVEL_DENIED', title: 'Forbidden' }, 403),
        );
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
      return Promise.resolve(jsonResponse({ status: 404, code: 'NOT_FOUND', title: 'NOT_FOUND' }, 404));
    }),
  );
}

/** 路由探针:断言拒绝面不导航离开入口页面(FR-007「不以首页替代返回位置」) */
function LocationProbe(): ReactNode {
  const location = useLocation();
  return (
    <span data-testid="loc">
      {location.pathname}
      {location.search}
    </span>
  );
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
const TITLE = FIRST_TILE.media.title;

function renderLivePageWithProbe() {
  const counter = installNetworkCounter();
  const world = renderLiveWorld(
    <>
      <LivePage />
      <LiveSessionProbe />
      <LocationProbe />
    </>,
    {
      session: LIVE_SESSION_STATES.authedWithProfile,
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

/** 等待页面就绪并点击首张瓦片的频道播放钮(经共享 PlayButton → usePlayAction) */
async function clickTilePlay(): Promise<HTMLElement> {
  await waitFor(() => expect(screen.getByTestId('live-session').textContent).toBe('authenticated:profile-a'));
  await waitFor(() => {
    expect(screen.getAllByRole('article', { name: `频道 ${TITLE}` }).length).toBeGreaterThan(0);
  });
  const tile = screen.getAllByRole('article', { name: `频道 ${TITLE}` })[0] as HTMLElement;
  fireEvent.click(within(tile).getByRole('button', { name: `播放 ${TITLE} 当前直播` }));
  return tile;
}

beforeEach(() => {
  installFetchRouter();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('T013 · 授权拒绝面:入口上下文、稳定文案、可重试可返回(FR-007/ui.md §1.3)', () => {
  it('resolve 403:浮层展示用户可理解原因,无内部码;页面不导航、入口瓦片保留;「关闭」返回入口上下文', async () => {
    const { counter, world } = renderLivePageWithProbe();
    try {
      const tile = await clickTilePlay();

      // 拒绝面出现在入口页面之上(非阻塞浮层),文案为稳定提示
      const surface = await screen.findByTestId('playback-surface');
      expect(within(surface).getByRole('alert').textContent).toBe(
        '当前档案暂不能播放该内容,请切换档案或稍后重试。',
      );
      expect(resolveCalls).toBe(1);

      // 不暴露内部错误码/诊断:无 HTTP 状态码、无 problem code、无策略细节字样
      const surfaceText = surface.textContent ?? '';
      expect(surfaceText).not.toMatch(/403/);
      expect(surfaceText).not.toMatch(/PROFILE_CONTENT_LEVEL_DENIED/i);
      expect(surfaceText).not.toMatch(/denied|policy|ticket|session-|problem/i);

      // 入口上下文保留:URL 不变(未导航/未以首页替代),页面与触发瓦片仍可见
      expect(screen.getByTestId('loc').textContent).toBe('/live');
      expect(screen.getByRole('heading', { name: '直播' })).toBeVisible();
      expect(tile).toBeVisible();

      // 「关闭」= 返回入口上下文:浮层收口,页面原样保留
      fireEvent.click(within(surface).getByRole('button', { name: '关闭' }));
      await waitFor(() => expect(screen.queryByTestId('playback-surface')).toBeNull());
      expect(screen.getByRole('heading', { name: '直播' })).toBeVisible();
      expect(screen.getByTestId('loc').textContent).toBe('/live');
      expect(counter.counts.personal).toBe(0);
    } finally {
      world.restore();
      counter.restore();
    }
  });

  it('拒绝面提供「重试」:复用统一链路对同一目标重新 authorize(恰好一次新 resolve),不并行第二会话', async () => {
    const { counter, world } = renderLivePageWithProbe();
    try {
      await clickTilePlay();
      const surface = await screen.findByTestId('playback-surface');
      expect(resolveCalls).toBe(1);

      // 重试入口:同一目标重新 authorize(play() 新意图取代旧意图,代次守卫废弃旧链)
      fireEvent.click(within(surface).getByRole('button', { name: '重试播放' }));
      await waitFor(() => expect(resolveCalls).toBe(2));
      const retried = await screen.findByTestId('playback-surface');
      expect(within(retried).getByRole('alert').textContent).toBe(
        '当前档案暂不能播放该内容,请切换档案或稍后重试。',
      );

      // 全程零个人数据读取(拒绝/重试均不需 /me),无并行播放面(单一 playback-surface)
      expect(counter.counts.personal).toBe(0);
      expect(screen.getAllByTestId('playback-surface').length).toBe(1);
    } finally {
      world.restore();
      counter.restore();
    }
  });
});
