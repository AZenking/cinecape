import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';
import { MemoryRouter } from 'react-router';
import { QueryClientProvider } from '@tanstack/react-query';
import type { PlaybackDto, StreamLineDto } from '@hmp/shared';
import { ActionCoordinator, usePlayAction } from '../../../src/app/action-coordinator';
import { selectNextLine } from '../../../src/app/action-coordinator-core';
import { SessionProvider, useSession } from '../../../src/app/session-provider';
import { SettingsAccessProvider } from '../../../src/features/settings/settings-access-provider';
import { AppToastRegion } from '../../../src/shared/ui';
import { createTestQueryClient } from '../../helpers/query-test-utils';
import type { AccountSession } from '../../../src/app/session-types';

/**
 * T020(016 US3;research.md R4 Failover 状态机 / data-model.md §3.1):
 * 播放面自动容灾换线编排(收口点 = action-coordinator 全局播放面,015 架构裁决):
 *
 * - 纯函数 selectNextLine:priority ASC 顺位、跳过已试/当前线路、仅启用线路、
 *   全线路试尽返回 null(上层落回缺省错误通道);
 * - 编排面(假 video.js 引擎 error 直触 onFatalError,vod-switch 同源):
 *   F1 播放中致命错误 → 自动以 {…target, lineId: 下一顺位} 发起新 resolve
 *   (第二次 resolve body 携带下一 lineId),Toast 单次提示,播放恢复;
 *   F2 全线路试尽 → 零第三笔 resolve,落回既有 unavailable 缺省屏,
 *   且 recover 窗口语义不变(「换源恢复」入口在场,容灾优先、全尽后不重复弹 recover 面板)。
 */

// ────────────────────────── 假 video.js 引擎(jsdom 无媒体实现;retry-recovery 同源) ──────────────────────────
const fakePlayerState = vi.hoisted(() => ({
  errorHandlers: [] as Array<() => void>,
}));
vi.mock('video.js', () => {
  class FakePlayer {
    on(event: string, handler: () => void): void {
      if (event === 'error') {
        fakePlayerState.errorHandlers.push(handler);
      }
    }
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

const LINES: readonly StreamLineDto[] = [
  { lineId: 'line-1', sourceId: 'src-telecom', sourceTitle: '电信主源', label: '线路 1 [1080P]', priority: 10, isDefault: true, isEnabled: true },
  { lineId: 'line-2', sourceId: 'src-unicom', sourceTitle: '联通备用', label: '线路 2 [4K]', priority: 20, isDefault: false, isEnabled: true },
  { lineId: 'line-3', sourceId: 'src-mobile', sourceTitle: '移动热备', label: '线路 3 [720P]', priority: 30, isDefault: false, isEnabled: true },
];

function line(overrides: Partial<StreamLineDto> = {}): StreamLineDto {
  return { ...LINES[0]!, ...overrides };
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
    id: 'sess-a',
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

/** resolve 请求体序列(按发生顺序;含 lineId 断言所需字段) */
function resolveBodies(): Array<Record<string, unknown>> {
  return recorded()
    .filter((call) => call.url.endsWith('/playback/resolve') && typeof call.init.body === 'string')
    .map((call) => JSON.parse(call.init.body as string) as Record<string, unknown>);
}

function when(method: string, pathPattern: RegExp, handler: RouteHandler): void {
  routes.unshift((reqMethod, path, reqBody) => {
    if (reqMethod !== method || !pathPattern.test(path)) {
      return null as unknown as Response;
    }
    return handler(reqBody, path);
  });
}

type RouteHandler = (body: unknown, path: string) => Response | Promise<Response>;

/** 多线路直播世界:resolve 按 body.lineId 返回对应线路投影;全链 ready→renew→playing */
function mockMultiLineFlow(): void {
  let resolveCalls = 0;
  when('GET', /\/auth\/session$/, () => jsonResponse(sessionFixture()));
  when('GET', /\/setup\/status$/, () => jsonResponse({ initialized: true }));
  when('POST', /\/playback\/resolve$/, (body) => {
    resolveCalls += 1;
    const request = (body ?? {}) as { lineId?: string };
    const id = resolveCalls === 1 ? 'sess-a' : `sess-line-${resolveCalls - 1}`;
    const selectedLineId = request.lineId ?? 'line-1';
    return jsonResponse(
      playbackDto({
        id,
        state: 'preparing',
        selectedLineId,
        lines: [...LINES],
      }),
      201,
    );
  });
  when('GET', /\/playback\/sessions\/[^/]+$/, (_body, path) => {
    const id = path.slice('/playback/sessions/'.length);
    return jsonResponse(playbackDto({ id, state: 'ready', selectedLineId: 'line-1', lines: [...LINES] }));
  });
  when('POST', /\/playback\/sessions\/[^/]+\/renew$/, (_body, path) => {
    const id = path.split('/')[3];
    return jsonResponse({
      playbackUrl: `/api/playback/stream/${id}/1/index.m3u8?ticket=t-${id}`,
      ticketExpiresAt: '2099-01-01T00:00:00.000Z',
      generation: 1,
    });
  });
  when('POST', /\/playback\/sessions\/[^/]+\/(stop|heartbeat|observations)$/, () => new Response(null, { status: 204 }));
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

function PlayProbe(): ReactNode {
  const { play, playback } = usePlayAction();
  const sessionStatus = useSession().status;
  return (
    <div>
      <span data-testid="session-status">{sessionStatus}</span>
      <span data-testid="playback-phase">{playback?.phase ?? '-'}</span>
      <span data-testid="playback-session">{playback?.sessionId ?? '-'}</span>
      <span data-testid="selected-line">{playback?.selectedLineId ?? '-'}</span>
      <span data-testid="line-count">{String(playback?.lines.length ?? 0)}</span>
      <button type="button" data-testid="play-a" onClick={() => play({ mediaId: 'media-1', title: '示例频道' })}>
        play-a
      </button>
    </div>
  );
}

function renderFailoverProbe(): void {
  const client = createTestQueryClient();
  render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={['/live']}>
        <SessionProvider>
          <SettingsAccessProvider>
            <ActionCoordinator>
              <PlayProbe />
              {/* Toast 渲染区:容灾提示经 useAppToast 入队,此处消费供断言 */}
              <AppToastRegion />
            </ActionCoordinator>
          </SettingsAccessProvider>
        </SessionProvider>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

/** 实际 playing 观测(真定时器;准备轮询 500ms 节拍) */
async function awaitPlaying(budgetMs = 8000): Promise<void> {
  const startedAt = Date.now();
  for (;;) {
    if (screen.getByTestId('playback-phase').textContent === 'playing') {
      return;
    }
    if (Date.now() - startedAt > budgetMs) {
      expect(screen.getByTestId('playback-phase').textContent).toBe('playing');
    }
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 50));
    });
  }
}

/** 会话恢复观测(游客态点击会先进登录意图而非播放链;retry-recovery 同款前置) */
async function awaitAuthenticated(budgetMs = 8000): Promise<void> {
  const startedAt = Date.now();
  for (;;) {
    if (screen.getByTestId('session-status').textContent === 'authenticated') {
      return;
    }
    if (Date.now() - startedAt > budgetMs) {
      expect(screen.getByTestId('session-status').textContent).toBe('authenticated');
    }
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 50));
    });
  }
}

/** 起播前置:会话 authenticated → 点击 play → 等 playing */
async function playAndWaitPlaying(): Promise<void> {
  await awaitAuthenticated();
  fireEvent.click(screen.getByTestId('play-a'));
  await awaitPlaying();
}

/** 触发假引擎致命 error(直触 PlayerView onFatalError → onMediaFailure + onTerminated) */
async function fireMediaError(): Promise<void> {
  await act(async () => {
    for (const handler of fakePlayerState.errorHandlers.splice(0)) {
      handler();
    }
  });
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
  // 假引擎 error 处理器按测试清空:前一用例播放器实例的残留闭包不得在后续用例
  // 里继续触发其协调器实例的容灾链(跨用例 fetch 泄漏防护)
  fakePlayerState.errorHandlers.length = 0;
  vi.unstubAllGlobals();
});

// ────────────────────────── 纯函数:selectNextLine ──────────────────────────

describe('T020 · selectNextLine(容灾顺位纯函数)', () => {
  it('顺位:按 priority ASC 选当前线路的下一顺位;跳过已尝试线路', () => {
    expect(selectNextLine(LINES, 'line-1', new Set())).toMatchObject({ lineId: 'line-2' });
    expect(selectNextLine(LINES, 'line-2', new Set(['line-1']))).toMatchObject({ lineId: 'line-3' });
  });

  it('跳过当前(刚失败)线路与全部已尝试线路;全线路试尽返回 null', () => {
    expect(selectNextLine(LINES, 'line-2', new Set(['line-1', 'line-3']))).toBeNull();
    expect(selectNextLine(LINES, 'line-3', new Set(['line-1', 'line-2']))).toBeNull();
  });

  it('仅启用线路参与顺位;停用线路跳过', () => {
    const lines = [
      line({ lineId: 'line-1', priority: 10 }),
      line({ lineId: 'line-2', priority: 20, isEnabled: false }),
      line({ lineId: 'line-3', priority: 30 }),
    ];
    expect(selectNextLine(lines, 'line-1', new Set())).toMatchObject({ lineId: 'line-3' });
  });

  it('输入乱序时按 priority ASC 稳定排序;无多线路语义(lines 空/单线路)返回 null', () => {
    const shuffled = [LINES[2]!, LINES[0]!, LINES[1]!];
    expect(selectNextLine(shuffled, null, new Set())).toMatchObject({ lineId: 'line-1' });
    expect(selectNextLine([], 'line-1', new Set())).toBeNull();
    expect(selectNextLine([LINES[0]!], 'line-1', new Set())).toBeNull();
  });
});

// ────────────────────────── 编排面(假引擎 + 协调器) ──────────────────────────

describe('T020 · 播放面自动容灾换线(全局播放面收口;015 架构裁决)', () => {
  it('F1 播放中致命错误 → 自动换下一顺位线路:第二次 resolve 携带下一 lineId,Toast 单次提示,播放恢复', async () => {
    mockMultiLineFlow();
    renderFailoverProbe();
    await playAndWaitPlaying();
    expect(screen.getByTestId('selected-line').textContent).toBe('line-1');
    expect(resolveBodies()).toHaveLength(1);
    expect(resolveBodies()[0]?.lineId).toBeUndefined();

    await fireMediaError();

    // 第二笔 resolve = 容灾换线:body 携带下一顺位 lineId(新 session 契约语义)
    await awaitPlaying();
    const resolves = resolveBodies();
    expect(resolves).toHaveLength(2);
    expect(resolves[1]?.mediaId).toBe('media-1');
    expect(resolves[1]?.lineId).toBe('line-2');
    expect(screen.getByTestId('selected-line').textContent).toBe('line-2');
    expect(screen.getByTestId('playback-session').textContent).toBe('sess-line-1');
    // Toast 单次提示(同一目标线路只提示一次)
    expect(await screen.findByText(/已自动切换至「线路 2 \[4K\]」/)).toBeInTheDocument();
    expect(screen.getAllByText(/已自动切换至/)).toHaveLength(1);
    // 容灾接管:不落缺省错误屏(无「重新播放」缺省面文案)
    expect(screen.queryByText('播放流中断,请重新发起播放。')).toBeNull();
  });

  it('F2 全线路试尽 → 零新增容灾 resolve,落回 unavailable 缺省屏;recover 窗口语义不变', async () => {
    mockMultiLineFlow();
    renderFailoverProbe();
    await playAndWaitPlaying();

    // 错误 1:line-1 失败 → 容灾换 line-2;错误 2:line-2 失败 → line-3(顺位递进)
    await fireMediaError();
    await awaitPlaying();
    expect(resolveBodies()[1]?.lineId).toBe('line-2');
    await fireMediaError();
    await awaitPlaying();
    expect(resolveBodies()[2]?.lineId).toBe('line-3');
    expect(resolveBodies()).toHaveLength(3);

    // 错误 3:line-3 亦失败,全线路试尽 → 不再发起容灾 resolve(防死循环)
    await fireMediaError();
    await screen.findByText('播放流中断,请重新发起播放。', undefined, { timeout: 3000 });
    expect(resolveBodies()).toHaveLength(3); // 全尽:零第四笔 resolve
    expect(screen.getByTestId('playback-phase').textContent).toBe('unavailable');
    // 缺省错误屏 + recover 窗口语义不变(mediaFailure 通道 armRecoverWindow)
    expect(screen.getByRole('button', { name: '换源恢复' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '关闭' })).toBeInTheDocument();
  });

  it('F3 单线路频道(lines<2):致命错误不触发容灾 resolve,维持既有 recover 通道', async () => {
    mockMultiLineFlow();
    when('POST', /\/playback\/resolve$/, (body) => {
      const request = (body ?? {}) as { lineId?: string };
      return jsonResponse(
        playbackDto({ id: 'sess-a', state: 'preparing', selectedLineId: request.lineId ?? 'line-1', lines: [LINES[0]!] }),
        201,
      );
    });
    renderFailoverProbe();
    await playAndWaitPlaying();

    await fireMediaError();
    await screen.findByText('播放流中断,请重新发起播放。', undefined, { timeout: 3000 });
    expect(resolveBodies()).toHaveLength(1); // 无换线面:零新增 resolve
    expect(screen.getByTestId('playback-phase').textContent).toBe('unavailable');
  });
});
