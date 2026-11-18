import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';
import { MemoryRouter } from 'react-router';
import { QueryClientProvider } from '@tanstack/react-query';
import type { ChannelPageDto, PlaybackDto } from '@hmp/shared';
import { ActionCoordinator, usePlayAction } from '../../../src/app/action-coordinator';
import { coordinatorReducer, createInitialCoordinatorState } from '../../../src/app/action-coordinator-core';
import { SessionProvider, useSession } from '../../../src/app/session-provider';
import { SettingsAccessProvider } from '../../../src/features/settings/settings-access-provider';
import { AppToastRegion } from '../../../src/shared/ui';
import { createTestQueryClient } from '../../helpers/query-test-utils';
import type { AccountSession } from '../../../src/app/session-types';

/**
 * 直播节目单面板(In-place 切台)单测 —— 「切台不得拆播放面」回归钉:
 *
 * 现状(修复前):节目单行点击经 `play({mediaId,title})` → launchPlayback → playStart
 * (新 intentId,phase=authorizing),播放面因 `phase !== playing` 整体卸载,用户看到
 * 播放器关闭后重新打开(真机 100ms 采样:surface=false → 700ms 后 surface=true)。
 *
 * 目标行为(与 OSD 手动换线同款原地换装):
 * - 整段切台期间 phase 恒为 playing,`playback-preparing` 元素从不出现,播放面不卸载;
 * - 新会话就绪后原子换装(sessionId/标题),期间旧频道继续播放;
 * - 失败保留当前频道继续播放,仅一条提示「切换频道失败,已保持当前频道继续播放。」。
 *
 * 夹具沿用 playback-failover.spec.tsx 的线上形态:假 video.js 引擎、路由式 fetch mock、
 * SessionProvider/SettingsAccessProvider/ActionCoordinator 宿主、探针读 playback 面。
 */

// ────────────────────────── 假 video.js 引擎(jsdom 无媒体实现;failover 同源) ──────────────────────────
vi.mock('video.js', () => {
  class FakePlayer {
    on(): void {}
    addClass(): void {}
    controls(): void {}
    src(): void {}
    play(): undefined {
      return undefined;
    }
    dispose(): void {}
  }
  return { default: () => new FakePlayer() };
});

// ────────────────────────── 夹具 ──────────────────────────

/** 两个在播频道:media-1 当前播放,media-2 为切台目标 */
const CHANNELS: readonly { id: string; title: string }[] = [
  { id: 'media-1', title: 'CCTV-16 奥林匹克' },
  { id: 'media-2', title: 'CCTV-13 新闻' },
];

function channelPage(): ChannelPageDto {
  return {
    items: CHANNELS.map((channel) => ({
      media: {
        id: channel.id,
        type: 'channel',
        title: channel.title,
        description: null,
        posterRef: null,
        contentLevel: null,
        availability: 'available',
      },
      groupKey: 'g-cctv',
      groupLabel: '央视',
      current: {
        key: `prog-${channel.id}`,
        title: `节目 ${channel.title}`,
        description: null,
        posterRef: null,
        startsAt: '2026-11-01T11:30:00.000Z',
        endsAt: '2026-11-01T12:30:00.000Z',
      },
      next: null,
    })),
    page: 1,
    pageSize: 2,
    total: 2,
    now: '2026-11-01T12:00:00.000Z',
    timezone: 'Asia/Shanghai',
    catalogRevision: 1,
  };
}

function sessionFixture(): AccountSession {
  return {
    sessionId: 'web-session-1',
    account: { id: 'acc-1', username: 'admin', role: 'owner' },
    activeProfile: {
      id: 'profile-a',
      name: '妈妈',
      avatar: null,
      type: 'adult',
      isDefault: true,
      isMain: true,
      pinProtected: false,
      status: 'active',
      createdAt: '2026-10-26T00:00:00.000Z',
      version: 1,
    },
    expiresAt: '2026-11-26T00:00:00.000Z',
    householdId: 'hh-1',
    bootstrapRequired: false,
    profileContextVersion: 1,
  };
}

function playbackDto(overrides: Partial<PlaybackDto> = {}): PlaybackDto {
  return {
    id: 'sess-media-1',
    state: 'ready',
    version: 1,
    generation: 1,
    desiredPaused: false,
    delivery: 'hls_proxy',
    positionSeconds: 0,
    durationSeconds: null, // 直播契约:时长 null
    timelineOffsetSeconds: 0,
    presentationStartSeconds: 0,
    ticketExpiresAt: null,
    playbackUrl: null,
    tracks: { audio: [], subtitles: [] },
    ...overrides,
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

// ────────────────────────── fetch mock(路由式;后注册优先) ──────────────────────────

let fetchMock: Mock;
type MockRoute = (method: string, path: string, body: unknown) => Response | Promise<Response> | null;
let routes: MockRoute[];

interface RecordedCall {
  url: string;
  init: RequestInit;
}

function recorded(): RecordedCall[] {
  return (fetchMock.mock.calls as Array<[RequestInfo | URL, RequestInit | undefined]>).map(([input, init]) => ({
    url: String(input),
    init: init ?? {},
  }));
}

/** resolve 请求体序列(按发生顺序;切台断言读 mediaId) */
function resolveBodies(): Array<Record<string, unknown>> {
  return recorded()
    .filter((call) => call.url.endsWith('/playback/resolve') && typeof call.init.body === 'string')
    .map((call) => JSON.parse(call.init.body as string) as Record<string, unknown>);
}

type RouteHandler = (body: unknown, path: string) => Response | Promise<Response>;

function when(method: string, pathPattern: RegExp, handler: RouteHandler): void {
  routes.unshift((reqMethod, path, reqBody) => {
    if (reqMethod !== method || !pathPattern.test(path)) {
      return null as unknown as Response;
    }
    return handler(reqBody, path);
  });
}

/** 直播世界:频道页 + resolve→prepare→renew→playing 全链(按 mediaId 派生会话号) */
function mockZapFlow(): void {
  const sessionFor = (mediaId: string): string => (mediaId === 'media-2' ? 'sess-media-2' : 'sess-media-1');
  when('GET', /\/auth\/session$/, () => jsonResponse(sessionFixture()));
  when('GET', /\/setup\/status$/, () => jsonResponse({ initialized: true }));
  when('GET', /\/public\/live\/channels/, () => jsonResponse(channelPage()));
  when('POST', /\/playback\/resolve$/, (body) => {
    const request = (body ?? {}) as { mediaId?: string };
    return jsonResponse(playbackDto({ id: sessionFor(request.mediaId ?? 'media-1'), state: 'preparing' }), 201);
  });
  when('GET', /\/playback\/sessions\/[^/]+$/, (_body, path) => {
    const id = path.slice('/playback/sessions/'.length);
    return jsonResponse(playbackDto({ id, state: 'ready' }));
  });
  when('POST', /\/playback\/sessions\/[^/]+\/renew$/, (_body, path) => {
    const id = path.split('/')[3];
    return jsonResponse({
      playbackUrl: `/api/playback/stream/${id}/1/index.m3u8?ticket=t-${id}`,
      ticketExpiresAt: '2099-01-01T00:00:00.000Z',
      generation: 1,
    });
  });
  when('POST', /\/playback\/sessions\/[^/]+\/stop$/, () => new Response(null, { status: 204 }));
  when('POST', /\/playback\/sessions\/[^/]+\/heartbeat$/, () => jsonResponse({ generation: 1, ticketExpiresAt: null }));
  when('POST', /\/playback\/sessions\/[^/]+\/observations$/, () => new Response(null, { status: 204 }));
  when('POST', /\/playback\/sessions\/[^/]+\/progress$/, () =>
    jsonResponse({
      applied: true,
      reason: 'accepted',
      historyRevision: 1,
      sessionAccepted: true,
      acceptedSampleSeq: 1,
      acceptedPositionSeconds: 0,
      acceptedGeneration: 1,
      sessionStarted: true,
    }),
  );
}

// ────────────────────────── 渲染基座 ──────────────────────────

function ZapProbe(): ReactNode {
  const { play, playback } = usePlayAction();
  const sessionStatus = useSession().status;
  return (
    <div>
      <span data-testid="session-status">{sessionStatus}</span>
      <span data-testid="playback-phase">{playback?.phase ?? '-'}</span>
      <span data-testid="playback-session">{playback?.sessionId ?? '-'}</span>
      <span data-testid="playback-target-title">{playback?.target.title ?? '-'}</span>
      <button type="button" data-testid="play-first" onClick={() => play({ mediaId: 'media-1', title: 'CCTV-16 奥林匹克' })}>
        play-first
      </button>
    </div>
  );
}

function renderZapProbe(): void {
  const client = createTestQueryClient();
  render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={['/live']}>
        <SessionProvider>
          <SettingsAccessProvider>
            <ActionCoordinator>
              <ZapProbe />
              {/* Toast 渲染区:切台失败提示经 useAppToast 入队,此处消费供断言 */}
              <AppToastRegion />
            </ActionCoordinator>
          </SettingsAccessProvider>
        </SessionProvider>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

// ────────────────────────── 观测辅助 ──────────────────────────

function phases(): string | null {
  return screen.getByTestId('playback-phase').textContent;
}

function sessionId(): string | null {
  return screen.getByTestId('playback-session').textContent;
}

async function pump(ms = 50): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, ms));
  });
}

async function awaitAuthenticated(budgetMs = 8000): Promise<void> {
  const startedAt = Date.now();
  for (;;) {
    if (screen.getByTestId('session-status').textContent === 'authenticated') {
      return;
    }
    if (Date.now() - startedAt > budgetMs) {
      expect(screen.getByTestId('session-status').textContent).toBe('authenticated');
    }
    await pump();
  }
}

async function awaitPlaying(budgetMs = 8000): Promise<void> {
  const startedAt = Date.now();
  for (;;) {
    if (phases() === 'playing') {
      return;
    }
    if (Date.now() - startedAt > budgetMs) {
      expect(phases()).toBe('playing');
    }
    await pump();
  }
}

/** 起播前置:会话 authenticated → 播放 media-1 → 等 playing */
async function playFirstAndWaitPlaying(): Promise<void> {
  await awaitAuthenticated();
  fireEvent.click(screen.getByTestId('play-first'));
  await awaitPlaying();
}

/** 打开播放器内节目单面板,等待两个频道行渲染 */
async function openGuidePanel(): Promise<void> {
  fireEvent.click(screen.getByRole('button', { name: '节目单' }));
  await screen.findByTestId('live-guide-panel');
  await screen.findByRole('button', { name: /^切换到 CCTV-13 新闻/ });
}

interface ZapSample {
  readonly phase: string | null;
  readonly session: string | null;
  readonly preparing: boolean;
  readonly surface: boolean;
}

/** 点击切台行后在会话换装前逐拍采样(20ms;上限 8s) */
async function sampleUntilSessionSwap(expectedSession: string, budgetMs = 8000): Promise<ZapSample[]> {
  const samples: ZapSample[] = [];
  const startedAt = Date.now();
  for (;;) {
    samples.push({
      phase: phases(),
      session: sessionId(),
      preparing: screen.queryByTestId('playback-preparing') !== null,
      surface: screen.queryByTestId('playback-surface') !== null,
    });
    if (phases() === 'playing' && sessionId() === expectedSession) {
      return samples;
    }
    if (Date.now() - startedAt > budgetMs) {
      return samples;
    }
    await pump(20);
  }
}

beforeEach(() => {
  fetchMock = vi.fn();
  routes = [];
  vi.stubGlobal('fetch', fetchMock);
  fetchMock.mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
    const method = (init?.method ?? 'GET').toUpperCase();
    const url = String(input);
    for (const route of routes) {
      const matched = await route(method, url, init?.body === undefined ? undefined : JSON.parse(String(init.body)));
      if (matched !== null && matched !== undefined) {
        return matched;
      }
    }
    return jsonResponse({ status: 404, code: 'NOT_FOUND', title: 'NOT_FOUND' }, 404);
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

// ────────────────────────── 切台(节目单面板) ──────────────────────────

describe('直播节目单 · 原地切台(播放面不卸载)', () => {
  it('整段切台 phase 恒为 playing、preparing 元素不出现、播放面不卸载;会话换到新频道', async () => {
    mockZapFlow();
    renderZapProbe();
    await playFirstAndWaitPlaying();
    expect(sessionId()).toBe('sess-media-1');
    expect(screen.getByTestId('playback-target-title').textContent).toBe('CCTV-16 奥林匹克');

    await openGuidePanel();
    const targetRow = screen.getByRole('button', { name: /^切换到 CCTV-13 新闻/ });
    expect(targetRow.getAttribute('aria-current')).toBeNull();

    fireEvent.click(targetRow);

    // 点击同一拍:相位不得离开 playing(修复前 = authorizing,播放面随卸载)
    expect(phases()).toBe('playing');
    expect(screen.queryByTestId('playback-preparing')).toBeNull();

    const samples = await sampleUntilSessionSwap('sess-media-2');
    const leftPlaying = samples.filter((sample) => sample.phase !== 'playing').map((sample) => sample.phase);
    expect(leftPlaying).toEqual([]);
    expect(samples.filter((sample) => sample.preparing)).toEqual([]);
    expect(samples.filter((sample) => !sample.surface)).toEqual([]);

    // 换装完成:新会话 + 新标题,相位仍在 playing
    expect(phases()).toBe('playing');
    expect(sessionId()).toBe('sess-media-2');
    expect(screen.getByTestId('playback-target-title').textContent).toBe('CCTV-13 新闻');
    expect(screen.queryByTestId('playback-preparing')).toBeNull();
    expect(screen.queryByTestId('playback-surface')).not.toBeNull();

    // resolve 面:第二笔 = 新频道 mediaId(极简目标面;不带旧频道 lineId)
    const resolves = resolveBodies();
    expect(resolves).toHaveLength(2);
    expect(resolves[1]?.mediaId).toBe('media-2');
    expect(resolves[1]?.lineId).toBeUndefined();
  });

  it('切台失败:保持当前频道继续播放,仅一条「切换频道失败」提示,不落 unavailable', async () => {
    mockZapFlow();
    // 后注册优先:目标频道 resolve 失败
    when('POST', /\/playback\/resolve$/, (body) => {
      const request = (body ?? {}) as { mediaId?: string };
      if (request.mediaId === 'media-2') {
        return jsonResponse({ status: 503, code: 'UNAVAILABLE', title: 'UNAVAILABLE' }, 503);
      }
      return jsonResponse(playbackDto({ id: 'sess-media-1', state: 'preparing' }), 201);
    });
    renderZapProbe();
    await playFirstAndWaitPlaying();

    await openGuidePanel();
    fireEvent.click(screen.getByRole('button', { name: /^切换到 CCTV-13 新闻/ }));

    // 失败提示(单条)
    await screen.findByText('切换频道失败,已保持当前频道继续播放。', undefined, { timeout: 3000 });
    expect(screen.getAllByText('切换频道失败,已保持当前频道继续播放。')).toHaveLength(1);
    // 当前频道原样续播:相位/会话/标题均不变
    expect(phases()).toBe('playing');
    expect(sessionId()).toBe('sess-media-1');
    expect(screen.getByTestId('playback-target-title').textContent).toBe('CCTV-16 奥林匹克');
    expect(screen.queryByTestId('playback-preparing')).toBeNull();
  });
});

// ────────────────────────── 纯 reducer:playRetarget ──────────────────────────

describe('playRetarget(原地换装的目标面改写)', () => {
  it('只替换 target:相位/会话面/线路面保持;旧意图整体忽略', () => {
    let state = createInitialCoordinatorState();
    state = coordinatorReducer(state, {
      type: 'playStart',
      intentId: 1,
      target: { mediaId: 'media-1', title: 'CCTV-16 奥林匹克', startMode: 'beginning', posterRef: 'p-1' },
    });
    state = coordinatorReducer(state, {
      type: 'playPatch',
      intentId: 1,
      patch: {
        phase: 'playing',
        sessionId: 'sess-media-1',
        playbackUrl: '/api/playback/stream/sess-media-1/1/index.m3u8',
        selectedLineId: 'line-1',
      },
    });

    const retargeted = coordinatorReducer(state, {
      type: 'playRetarget',
      intentId: 1,
      target: { mediaId: 'media-2', title: 'CCTV-13 新闻', startMode: 'beginning', posterRef: null },
    });
    expect(retargeted.playback?.target).toMatchObject({ mediaId: 'media-2', title: 'CCTV-13 新闻' });
    expect(retargeted.playback?.phase).toBe('playing');
    expect(retargeted.playback?.sessionId).toBe('sess-media-1');
    expect(retargeted.playback?.playbackUrl).toBe('/api/playback/stream/sess-media-1/1/index.m3u8');

    // 意图守卫:非当前意图的 retarget 不得改写(结构与 playPatch 一致)
    expect(
      coordinatorReducer(retargeted, {
        type: 'playRetarget',
        intentId: 99,
        target: { mediaId: 'media-3', title: '其它', startMode: 'beginning' },
      }),
    ).toBe(retargeted);
    // 无播放意图时为零操作
    expect(
      coordinatorReducer(createInitialCoordinatorState(), {
        type: 'playRetarget',
        intentId: 1,
        target: { mediaId: 'media-1', title: 'A', startMode: 'beginning' },
      }).playback,
    ).toBeNull();
  });
});