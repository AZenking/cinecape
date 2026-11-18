/** @jsxImportSource react */
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';

/**
 * 010 T080 收口钉面(US5):身份守卫边界 —— 身份变化取消三链(连播/换源)、
 * 普通路由变化不清理全局会话、游客零个人键。
 *
 * 对照契约:
 * - docs/specs/010-online-vod/tasks.md T080 原文:当前服务端 Profile/contextVersion
 *   个人键与每 await 守卫;身份变化取消倒计时/测速/未消费意图;公共浏览保持可用,
 *   普通路由变化不清理全局会话;
 * - contracts/ui.md §2(路由变化不卸载、不发 stop;操作上下文每 await 核对)、
 *   §5(切档清个人缓存/倒计时/测速/意图;公共搜索继续可用)、§3/§4(连播/换源链)。
 *
 * 与既有绿面的分工(不重复钉):
 * - 域清除顺序与 401 分流:test/unit/identity-purge.spec.tsx(T029/T030/T031);
 * - 连播切档组件级行为:vod-autoplay.spec.tsx B2/B3;
 * - 换源切档/关闭迟到响应:vod-switch.spec.tsx E1/E2/E3;
 * - 游客浏览零个人请求:online-vod-catalog.spec.tsx F1(公共浏览面)。
 * 本文件在 hook 级钉「身份变化三链取消」(定时器/在途请求/链式推进),在协调器级钉
 * 「普通路由变化零 stop 且个人缓存/会话原样」与「游客播放入口零 /playback/ 零 /me/」
 * (009 SC-101 只钉播放面挂载存活,不钉零 stop 与缓存保留)。
 *
 * mock 层惯例(vod-autoplay/vod-switch 同款):vi.stubGlobal('fetch') 路由式 mock
 * (后注册优先),DTO 以 @hmp/shared `Vod` 生成类型手写最小合法对象,零真实网络;
 * 引擎边界替换 video.js 为无副作用假引擎(jsdom 无媒体实现)。
 */
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
import { act, fireEvent, render, renderHook, screen, waitFor } from '@testing-library/react';
import { QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { Link, MemoryRouter, Route, Routes } from 'react-router';
import type { Vod } from '@hmp/shared';
import { useVodAutoplay } from '../src/features/playback/use-vod-autoplay';
import { useVodTransition } from '../src/features/playback/use-vod-transition';
import { ActionCoordinator, usePlayAction } from '../src/app/action-coordinator';
import { SessionProvider, useSession } from '../src/app/session-provider';
import { SettingsAccessProvider } from '../src/features/settings/settings-access-provider';
import { queryClient } from '../src/shared/query/client';
import { queryKeys } from '../src/shared/query/keys';
import type { AccountSession } from '../src/app/session-types';

type FinishReceiptDto = Vod.components['schemas']['FinishReceipt'];
type NextPlanReplyDto = Vod.components['schemas']['NextPlanReply'];
type PreferencesDto = Vod.components['schemas']['Preferences'];
type SwitchCandidateDto = Vod.components['schemas']['SwitchCandidate'];

// ────────────────────────── 夹具(最小合法对象;010 契约形状) ──────────────────────────

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function problemResponse(status: number, code: string): Response {
  return new Response(JSON.stringify({ status, code, title: code }), {
    status,
    headers: { 'Content-Type': 'application/problem+json' },
  });
}

function sessionFixture(overrides: Partial<AccountSession> = {}): AccountSession {
  return {
    sessionId: 'session-1',
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
    ...overrides,
  };
}

/** FinishReceipt 13 键夹具(autoNextEligible=true 连播资格形态) */
function finishReceipt(overrides: Partial<FinishReceiptDto> = {}): FinishReceiptDto {
  return {
    sessionId: 'sess-a',
    generation: 1,
    ended: true,
    finalSessionAccepted: true,
    historyApplied: true,
    historyRevision: 5,
    sessionCompleted: true,
    autoNextEligible: true,
    reason: 'completed',
    positionSeconds: 3600,
    durationSeconds: 3600,
    endedAt: '2026-10-30T12:00:00.000Z',
    replayed: false,
    ...overrides,
  };
}

function preferences(overrides: Partial<PreferencesDto> = {}): PreferencesDto {
  return { autoplayNext: true, switchCarryPosition: true, version: 0, ...overrides };
}

function nextPlan(overrides: Partial<NextPlanReplyDto> = {}): NextPlanReplyDto {
  return {
    nextPlanRef: 'plan-1',
    targetMediaId: 'media-2',
    label: '第2集',
    sequenceRevision: 7,
    detailRevision: 3,
    historyRevision: 0,
    historyChoiceRequired: false,
    history: null,
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    ...overrides,
  };
}

function switchCandidate(overrides: Partial<SwitchCandidateDto> = {}): SwitchCandidateDto {
  return {
    candidateRef: 'cand-1',
    title: '例牌剧集',
    label: '第1集',
    year: '2024',
    season: null,
    versionLabel: null,
    sourceLabel: '源甲',
    lineLabel: '线路一',
    matchConfidence: 'high',
    matchReasons: [],
    previewRevision: 3,
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    ...overrides,
  };
}

/** 010 PlaybackDto 夹具(协调器 prepare→playing 链最小形态) */
function playbackDto(overrides: Partial<Vod.components['schemas']['PlaybackDto']> = {}): Vod.components['schemas']['PlaybackDto'] {
  return {
    id: 'session-a',
    state: 'ready',
    version: 1,
    generation: 1,
    desiredPaused: false,
    delivery: 'hls_proxy',
    positionSeconds: 0,
    durationSeconds: 3600,
    timelineOffsetSeconds: 0,
    presentationStartSeconds: 0,
    ticketExpiresAt: null,
    playbackUrl: null,
    tracks: { audio: [], subtitles: [] },
    startBasis: 'beginning',
    resumeDisposition: 'beginning',
    resumeReason: null,
    transitionSlot: { revision: 0, status: 'open', activeIntentId: null, successorSessionId: null },
    seekCapability: 'client',
    playbackStarted: false,
    ...overrides,
  };
}

// ────────────────────────── fetch mock 布线(vod-autoplay 同款路由式) ──────────────────────────

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

function bodiesEndingWith(suffix: string): Array<Record<string, unknown>> {
  return recorded()
    .filter((call) => call.url.endsWith(suffix) && typeof call.init.body === 'string')
    .map((call) => JSON.parse(call.init.body as string) as Record<string, unknown>);
}

const nextPlanRequests = (): Array<Record<string, unknown>> => bodiesEndingWith('/next-plans');
const intentRequests = (): Array<Record<string, unknown>> => bodiesEndingWith('/transition-intents');
const switchProbeRequests = (): Array<Record<string, unknown>> => bodiesEndingWith('/switch-probes');
const stopCalls = (): RecordedCall[] => recorded().filter((call) => /\/playback\/sessions\/[^/]+\/stop$/.test(call.url));

type RouteHandler = (body: unknown, path: string) => Response | Promise<Response>;

/** 后注册优先:用例级覆盖压过世界级缺省 */
function when(method: string, pathPattern: RegExp, handler: RouteHandler): void {
  routes.unshift((reqMethod, path, reqBody) => {
    if (reqMethod !== method || !pathPattern.test(path)) {
      return null as unknown as Response;
    }
    return handler(reqBody, path);
  });
}

/** 手动决议的响应闸门(在途/迟到响应编排;忽略 abort 模拟「服务端已受理」竞态) */
interface ResponseGate {
  readonly promise: Promise<Response>;
  release: (response: Response) => void;
}

function gatedResponse(): ResponseGate {
  let release!: (response: Response) => void;
  const promise = new Promise<Response>((resolve) => {
    release = resolve;
  });
  return { promise, release };
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
    return problemResponse(404, 'NOT_FOUND');
  });
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  queryClient.clear();
});

/** 假定时器下泵送微任务+定时器(偏好门/计划链的异步收口) */
async function pump(ms = 50): Promise<void> {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

// ────────────────────────── A · 身份变化取消三链:连播链(hook 级) ──────────────────────────

const noopVideoRef = { current: null };

describe('010 T080 · 身份变化取消连播链(倒计时/在途请求,零 intent)', () => {
  it('A1 倒计时进行中会话身份变化:定时器收口,到期零 intent、零计划重取,状态面重置', async () => {
    vi.useFakeTimers();
    when('GET', /\/me\/vod\/preferences$/, () => jsonResponse(preferences()));
    when('POST', /\/playback\/next-plans$/, () => jsonResponse(nextPlan()));
    const { result, rerender } = renderHook(
      (props: { readonly sessionId: string }) =>
        useVodAutoplay({ sessionId: props.sessionId, generation: 1, videoRef: noopVideoRef }),
      { initialProps: { sessionId: 'sess-a' } },
    );
    act(() => {
      result.current.onReceipt(finishReceipt());
    });
    await pump();
    expect(result.current.state.phase).toBe('countdown');
    // 会话身份变化(切档语义;T080:身份变化取消倒计时)
    rerender({ sessionId: 'sess-b' });
    expect(result.current.state.phase).toBe('idle');
    await pump(10_000);
    expect(intentRequests(), '身份变化后不得再建意图(旧计划不随新身份)').toHaveLength(0);
    expect(nextPlanRequests(), '身份变化后不得按旧计划重取/续发').toHaveLength(1);
    expect(result.current.state.phase).toBe('idle');
  });

  it('A2 偏好门在途时会话身份变化:在途请求被中止,迟到偏好不续发计划链', async () => {
    vi.useFakeTimers();
    const gate = gatedResponse();
    when('GET', /\/me\/vod\/preferences$/, () => gate.promise);
    const { result, rerender } = renderHook(
      (props: { readonly sessionId: string }) =>
        useVodAutoplay({ sessionId: props.sessionId, generation: 1, videoRef: noopVideoRef }),
      { initialProps: { sessionId: 'sess-a' } },
    );
    act(() => {
      result.current.onReceipt(finishReceipt());
    });
    await pump();
    expect(recorded().some((call) => call.url.endsWith('/me/vod/preferences'))).toBe(true);
    // 身份变化:effect 清理收口在途请求(signal 即刻中止)
    rerender({ sessionId: 'sess-b' });
    const preferenceCall = recorded().find((call) => call.url.endsWith('/me/vod/preferences'));
    expect(preferenceCall?.init.signal?.aborted).toBe(true);
    // 迟到偏好到达:身份守卫丢弃,不取计划、不建意图
    await act(async () => {
      gate.release(jsonResponse(preferences()));
      await vi.advanceTimersByTimeAsync(100);
    });
    await pump(6_000);
    expect(nextPlanRequests(), '迟到偏好不得续发计划链').toHaveLength(0);
    expect(intentRequests()).toHaveLength(0);
    expect(result.current.state.phase).toBe('idle');
  });
});

// ────────────────────────── B · 身份变化取消换源链:迟到候选不回写不链发(hook 级) ──────────────────────────

describe('010 T080 · 身份变化取消换源链(候选/测速,零链发)', () => {
  it('B1 候选在途时会话身份变化:迟到候选不回写、不链发测速,状态面整体重置', async () => {
    const gate = gatedResponse();
    when('GET', /\/vod\/switch-candidates(?:\?.*)?$/, () => gate.promise);
    const { result, rerender } = renderHook(
      (props: { readonly sessionId: string }) =>
        useVodTransition({
          sessionId: props.sessionId,
          generation: 1,
          videoRef: noopVideoRef,
          pauseAndFlush: () => Promise.reject(new Error('切档后不得触发暂停确认')),
          stopOnce: () => Promise.resolve(),
        }),
      { initialProps: { sessionId: 'sess-a' } },
    );
    act(() => {
      result.current.openDrawer();
    });
    await waitFor(() => expect(recorded().some((call) => call.url.includes('/vod/switch-candidates'))).toBe(true));
    // 身份变化:整体重置 + 在途候选中止(signal 已发)
    rerender({ sessionId: 'sess-b' });
    const candidatesCall = recorded().find((call) => call.url.includes('/vod/switch-candidates'));
    expect(candidatesCall?.init.signal?.aborted).toBe(true);
    // 迟到候选到达:身份守卫丢弃,不回写、不链发测速(E1 hook 级同源钉面)
    await act(async () => {
      gate.release(jsonResponse({ items: [switchCandidate()], nextCursor: null, partial: false, reasons: [] }));
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(result.current.state.candidates).toBeNull();
    expect(result.current.state.candidatesLoading).toBe(false);
    expect(result.current.state.drawerOpen).toBe(false);
    expect(switchProbeRequests(), '迟到候选不得链发测速').toHaveLength(0);
  });
});

// ────────────────────────── C · 普通路由变化不清理全局会话(协调器级) ──────────────────────────

function PlayProbe(): ReactNode {
  const { play, playback } = usePlayAction();
  const sessionStatus = useSession().status;
  return (
    <div>
      <span data-testid="session-status">{sessionStatus}</span>
      <span data-testid="phase">{playback?.phase ?? '-'}</span>
      <button type="button" data-testid="start-play" onClick={() => play({ mediaId: 'media-1', title: '例牌影片' })}>
        start
      </button>
    </div>
  );
}

function renderCoordinatorApp(initialPath: string): void {
  // QueryClientProvider:playing 相位 PlayerView 的 019 直播节目元数据查询依赖同一全局 client
  render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={[initialPath]}>
        <SessionProvider>
          <SettingsAccessProvider>
            <ActionCoordinator>
              <nav>
                <Link to="/" data-testid="nav-home">home</Link>
                <Link to="/vod" data-testid="nav-vod">vod</Link>
                <Link to="/live" data-testid="nav-live">live</Link>
              </nav>
              <Routes>
                <Route path="/" element={<p data-testid="page-home">home-page</p>} />
                <Route path="/vod" element={<p data-testid="page-vod">vod-page</p>} />
                <Route path="/live" element={<p data-testid="page-live">live-page</p>} />
              </Routes>
              <PlayProbe />
            </ActionCoordinator>
          </SettingsAccessProvider>
        </SessionProvider>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

/** 已选档会话 + 播放全链(009 playback-modal mockReadyWorld 同形) */
function installPlaybackWorld(): void {
  when('GET', /\/auth\/session$/, () => jsonResponse(sessionFixture()));
  when('GET', /\/setup\/status$/, () => jsonResponse({ initialized: true }));
  when('POST', /\/playback\/resolve$/, () => jsonResponse(playbackDto({ state: 'preparing' }), 201));
  when('GET', /\/playback\/sessions\/session-a$/, () => jsonResponse(playbackDto({ state: 'ready' })));
  when('POST', /\/playback\/sessions\/session-a\/renew$/, () =>
    jsonResponse({
      playbackUrl: '/api/playback/stream/session-a/1/index?ticket=t',
      ticketExpiresAt: '2099-01-01T00:00:00.000Z',
      generation: 1,
    }),
  );
  when('POST', /\/playback\/sessions\/session-a\/(stop|heartbeat)$/, () => new Response(null, { status: 204 }));
}

describe('010 T080 · 普通路由变化不清理全局会话(009 全局非阻塞播放面)', () => {
  it('C1 playing 态两次路由导航:播放面存活、零 /stop、个人缓存与会话原样', async () => {
    installPlaybackWorld();
    renderCoordinatorApp('/');
    await waitFor(() => expect(screen.getByTestId('session-status').textContent).toBe('authenticated'));
    // 预置个人缓存条目:路由导航不得触发任何域清除(T080:普通路由变化不清理)
    queryClient.setQueryData(queryKeys.profile('profile-a').favorites(), '个人数据');
    fireEvent.click(screen.getByTestId('start-play'));
    await waitFor(() => expect(screen.getByTestId('phase').textContent).toBe('playing'), { timeout: 3_000 });
    expect(document.querySelector('[data-testid="playback-surface"]')).not.toBeNull();

    // 两次普通路由导航(20 次导航语义的最小代表;009 SC-101 不钉 stop/缓存)
    fireEvent.click(screen.getByTestId('nav-vod'));
    await waitFor(() => expect(screen.getByTestId('page-vod')).not.toBeNull());
    fireEvent.click(screen.getByTestId('nav-live'));
    await waitFor(() => expect(screen.getByTestId('page-live')).not.toBeNull());

    expect(document.querySelector('[data-testid="playback-surface"]'), '路由切换不掉播放面').not.toBeNull();
    expect(stopCalls(), '普通路由变化不得发 stop/清理全局会话').toHaveLength(0);
    expect(queryClient.getQueryData(queryKeys.profile('profile-a').favorites())).toBe('个人数据');
    expect(screen.getByTestId('session-status').textContent).toBe('authenticated');
  });
});

// ────────────────────────── D · 游客零个人键(播放入口;浏览面归 online-vod-catalog F1) ──────────────────────────

describe('010 T080 · 游客零个人键(播放入口不携带个人请求)', () => {
  it('D1 游客点播放:进入登录意图,零 /playback/ 与零 /me/ 请求(FR-011)', async () => {
    when('GET', /\/auth\/session$/, () => problemResponse(401, 'UNAUTHENTICATED'));
    when('GET', /\/setup\/status$/, () => jsonResponse({ initialized: true }));
    renderCoordinatorApp('/vod');
    await waitFor(() => expect(screen.getByTestId('session-status').textContent).toBe('anonymous'));
    fireEvent.click(screen.getByTestId('start-play'));
    // 登录意图弹出(选档完成前零 /playback/ 请求;Modal 标题 + 提交按钮同名,按标题角色取)
    await waitFor(() => expect(screen.getByRole('heading', { name: '登录' })).toBeInTheDocument());
    expect(recorded().filter((call) => call.url.includes('/playback/')), '游客零播放域请求').toHaveLength(0);
    expect(recorded().filter((call) => call.url.includes('/me/')), '游客零个人域请求').toHaveLength(0);
  });
});
