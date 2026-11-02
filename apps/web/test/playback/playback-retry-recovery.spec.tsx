/** @jsxImportSource react */
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';

/**
 * 引擎边界 mock(jsdom 无媒体实现):vi.hoisted 状态承载 error 处理器 —— 媒体致命
 * 故障经假引擎 error 事件直触 onFatalError(recover 窗口准时源;vod-switch F 组同源)。
 */
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
import { act, fireEvent, render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';
import { MemoryRouter } from 'react-router';
import { QueryClientProvider } from '@tanstack/react-query';
import type { Vod } from '@hmp/shared';
import { ActionCoordinator, usePlayAction } from '../../src/app/action-coordinator';
import { SessionProvider, useSession } from '../../src/app/session-provider';
import { SettingsAccessProvider } from '../../src/features/settings/settings-access-provider';
import { createTestQueryClient } from '../helpers/query-test-utils';
import type { AccountSession } from '../../src/app/session-types';

/**
 * 012 T029 · 播放失败重试幂等(FR-020 末项、SC-005;协调器级现状钉面):
 *
 * 与既有绿面的分工(不重复钉):
 * - recover_switch 意图面(intent action/fromSessionId):vod-switch F1(hook/协调器);
 * - 60s 过期「重新播放」resolve 语义(带 startMode/零 intent):vod-switch F2;
 * - 故障后零自动重试循环:vod-switch F3;
 * - intent 同 key 重放幂等(恰一次推进):vod-switch D3(hook 级)。
 *
 * 本文件在**协调器/意图不变式**层钉 FR-020 末项「重试复用同一意图/会话语义,
 * 不产生并行第二会话」:
 * - R1 故障→恢复窗口空闲:协调器不自动发起新 resolve(零并行第二会话);恢复
 *   入口的候选流复用**同一**源会话(switch-candidates 携 fromSessionId=故障会话);
 * - R2 恢复链严格串行:过渡意图(同会话)消费**之后**才出现唯一一笔带
 *   transitionIntentId 的后继 resolve —— 后继会话经意图消费产生,零旁路第二会话;
 * - R3 过期出口「重新播放」连点:顺序替换而非并行 —— 先建的新链被废弃收口
 *   (幂等空 stop),播放面唯一、活动会话唯一。
 */

type PlaybackDto = Vod.components['schemas']['PlaybackDto'];
type SwitchCandidateDto = Vod.components['schemas']['SwitchCandidate'];
type ProbeResultDto = Vod.components['schemas']['ProbeResult'];
type IntentReplyDto = Vod.components['schemas']['IntentReply'];
type MaterializedDto = Vod.components['schemas']['Materialized'];

// ────────────────────────── 夹具(010 契约形状;vod-switch 同源) ──────────────────────────

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

function switchCandidate(overrides: Partial<SwitchCandidateDto> = {}): SwitchCandidateDto {
  return {
    candidateRef: 'cand-1',
    title: '同名剧集',
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

function probeResult(overrides: Partial<ProbeResultDto> = {}): ProbeResultDto {
  return {
    candidateRef: 'cand-1',
    status: 'reachable',
    latencyMs: 128,
    checkedAt: new Date().toISOString(),
    ...overrides,
  };
}

function materialized(overrides: Partial<MaterializedDto> = {}): MaterializedDto {
  return {
    parentMediaId: 'parent-target-1',
    mediaId: 'media-target-1',
    detailRevision: 3,
    catalogRevision: 5,
    replayed: false,
    candidateRef: 'cand-1',
    registeredCandidateRef: 'rc-1',
    ...overrides,
  };
}

function intentReply(overrides: Partial<IntentReplyDto> = {}): IntentReplyDto {
  return {
    id: 'intent-1',
    fromSessionId: 'sess-a',
    fromGeneration: 1,
    action: 'recover_switch',
    targetMediaId: 'media-target-1',
    positionMode: 'beginning',
    matchConfidence: 'high',
    slotRevision: 1,
    status: 'pending',
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    successorSessionId: null,
    ...overrides,
  };
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

function bodiesEndingWith(suffix: string): Array<Record<string, unknown>> {
  return recorded()
    .filter((call) => call.url.endsWith(suffix) && typeof call.init.body === 'string')
    .map((call) => JSON.parse(call.init.body as string) as Record<string, unknown>);
}

const resolveBodies = (): Array<Record<string, unknown>> => bodiesEndingWith('/playback/resolve');
const intentRequests = (): Array<Record<string, unknown>> => bodiesEndingWith('/playback/transition-intents');
const stopCallsFor = (sessionId: string): RecordedCall[] =>
  recorded().filter((call) => call.url.endsWith(`/playback/sessions/${sessionId}/stop`));
const candidateCalls = (): RecordedCall[] =>
  recorded().filter((call) => call.url.includes('/vod/switch-candidates'));

function candidateQuery(): URLSearchParams {
  const call = candidateCalls()[0];
  expect(call, '恢复候选流请求应已发生').toBeDefined();
  const url = new URL(call?.url ?? 'http://redroad.invalid', 'http://redroad.invalid');
  return url.searchParams;
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
  // 基座世界:已选档会话 + sess-a 播放全链(初始 resolve=普通起播;其后=后继消费)
  let resolveCalls = 0;
  when('GET', /\/auth\/session$/, () => jsonResponse(sessionFixture()));
  when('GET', /\/setup\/status$/, () => jsonResponse({ initialized: true }));
  when('POST', /\/playback\/resolve$/, () => {
    resolveCalls += 1;
    const id = resolveCalls === 1 ? 'sess-a' : `sess-next-${resolveCalls - 1}`;
    return jsonResponse(playbackDto({ id, state: 'preparing' }), 201);
  });
  when('GET', /\/playback\/sessions\/sess-a$/, () => jsonResponse(playbackDto({ state: 'ready' })));
  when('GET', /\/playback\/sessions\/sess-next-\d+$/, (_body, path) => {
    const id = path.slice(path.lastIndexOf('/') + 1);
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
  when('POST', /\/playback\/sessions\/[^/]+\/(stop|heartbeat|observations)$/, () => new Response(null, { status: 204 }));
  when('POST', /\/playback\/sessions\/[^/]+\/progress$/, (body) => {
    const sample = (body ?? {}) as { sampleSeq?: unknown };
    return jsonResponse({
      applied: true,
      reason: 'accepted',
      historyRevision: 4,
      sessionAccepted: true,
      acceptedSampleSeq: typeof sample.sampleSeq === 'number' ? sample.sampleSeq : 1,
      acceptedPositionSeconds: 5,
      acceptedGeneration: 1,
      sessionStarted: true,
    });
  });
  // 换源/恢复候选链(vod-switch 契约裁决:正则兼容查询参数)
  when('GET', /\/vod\/switch-candidates(?:\?.*)?$/, () =>
    jsonResponse({ items: [switchCandidate()], nextCursor: null, partial: false, reasons: [] }),
  );
  when('POST', /\/vod\/switch-probes$/, (body) => {
    const request = (body ?? {}) as { candidateRefs?: unknown };
    const refs = Array.isArray(request.candidateRefs) ? (request.candidateRefs as string[]) : [];
    return jsonResponse({ items: refs.map((ref) => probeResult({ candidateRef: ref })) });
  });
  when('POST', /\/vod\/materializations$/, () => jsonResponse(materialized(), 201));
  when('GET', /\/me\/vod\/titles\/parent-target-1\/progress$/, () =>
    jsonResponse({ latest: null, resumeCandidate: null, nextEpisodeAction: null }),
  );
  when('POST', /\/playback\/transition-intents$/, () => jsonResponse(intentReply(), 201));
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

// ────────────────────────── 渲染基座与助手 ──────────────────────────

function PlayProbe(): ReactNode {
  const { play, playback } = usePlayAction();
  const sessionStatus = useSession().status;
  return (
    <div>
      <span data-testid="session-status">{sessionStatus}</span>
      <span data-testid="phase">{playback?.phase ?? '-'}</span>
      <span data-testid="playback-session">{playback?.sessionId ?? '-'}</span>
      <button type="button" data-testid="play-a" onClick={() => play({ mediaId: 'media-1', title: '例牌单集' })}>
        play-a
      </button>
    </div>
  );
}

function renderCoordinatorProbe(): void {
  const client = createTestQueryClient();
  render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={['/vod']}>
        <SessionProvider>
          <SettingsAccessProvider>
            <ActionCoordinator>
              <PlayProbe />
            </ActionCoordinator>
          </SettingsAccessProvider>
        </SessionProvider>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

/** 假定时器下的 UI 就绪等待(反复泵送 50ms;vod-switch 同款) */
async function pumpTimers(ms: number): Promise<void> {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

async function awaitUi(read: () => void, budgetMs = 3_000): Promise<void> {
  let waited = 0;
  for (;;) {
    try {
      read();
      return;
    } catch {
      // 未就绪:泵送假定时器后重试
    }
    if (waited >= budgetMs) {
      read();
    }
    await pumpTimers(50);
    waited += 50;
  }
}

/** 实际 playing 观测 + 媒体致命故障(假引擎 error 直触 onFatalError) */
async function playAndFail(): Promise<void> {
  await awaitUi(() => expect(screen.getByTestId('session-status').textContent).toBe('authenticated'));
  fireEvent.click(screen.getByTestId('play-a'));
  await awaitUi(() => expect(screen.getByTestId('phase').textContent).toBe('playing'));
  await pumpTimers(50);
  for (const handler of fakePlayerState.errorHandlers.splice(0)) {
    handler();
  }
  await awaitUi(() => expect(screen.getByTestId('phase').textContent).toBe('unavailable'));
}

function selectCandidateRow(): void {
  const row = screen.getByTestId('vod-switch-candidate');
  fireEvent.click(row);
}

// ────────────────────────── 用例 ──────────────────────────

describe('T029 · 失败重试幂等:恢复窗口不产生并行第二会话(FR-020 末项)', () => {
  it('R1 故障→窗口空闲:零自动 resolve;恢复候选流复用同一源会话(fromSessionId)', async () => {
    vi.useFakeTimers();
    renderCoordinatorProbe();
    await playAndFail();
    const resolvesAtFailure = resolveBodies().length;

    // 窗口空闲(推 10s 假时钟):无自动重试/新会话(与 vod-switch F3 同源,本例钉
    // resolve 计数不变式 —— FR-020 末项「不产生并行第二会话」的空闲面)
    await pumpTimers(10_000);
    expect(resolveBodies()).toHaveLength(resolvesAtFailure);
    expect(intentRequests()).toHaveLength(0);

    // 显式恢复入口:候选流复用同一源会话(非新建会话的旁路重试)
    fireEvent.click(screen.getByRole('button', { name: /换源恢复|恢复播放/ }));
    await awaitUi(() => expect(screen.getByTestId('vod-switch-candidates')).toBeInTheDocument());
    expect(candidateQuery().get('fromSessionId')).toBe('sess-a');
    expect(resolveBodies()).toHaveLength(resolvesAtFailure); // 拉取候选零新会话
  });

  it('R2 恢复链严格串行:意图(同会话)消费后才出现唯一一笔带 transitionIntentId 的后继 resolve', async () => {
    vi.useFakeTimers();
    renderCoordinatorProbe();
    await playAndFail();
    const resolvesAtFailure = resolveBodies().length;
    expect(resolvesAtFailure).toBe(1); // 初始普通起播恰一次

    fireEvent.click(screen.getByRole('button', { name: /换源恢复|恢复播放/ }));
    await awaitUi(() => expect(screen.getByTestId('vod-switch-candidates')).toBeInTheDocument());
    await awaitUi(() => expect(screen.getAllByTestId('vod-switch-candidate').length).toBeGreaterThan(0));
    selectCandidateRow();
    // 非接受 checkpoint → 显式确认面(RecoverSwitchPanel 暂停确认以未接受收口)
    await awaitUi(() => expect(screen.getByRole('button', { name: '从头播放' })).toBeInTheDocument());
    expect(intentRequests()).toHaveLength(0); // 确认前零意图
    expect(resolveBodies()).toHaveLength(resolvesAtFailure); // 确认前零后继会话

    fireEvent.click(screen.getByRole('button', { name: '从头播放' }));
    await awaitUi(() => expect(intentRequests()).toHaveLength(1));
    expect(intentRequests()[0]?.action).toBe('recover_switch');
    expect(intentRequests()[0]?.fromSessionId).toBe('sess-a'); // 同一会话语义
    // 串行收口:意图消费后才出现唯一一笔过渡 resolve(带 transitionIntentId)
    await awaitUi(() => expect(resolveBodies()).toHaveLength(resolvesAtFailure + 1));
    const successor = resolveBodies()[resolvesAtFailure];
    expect(typeof successor?.transitionIntentId).toBe('string');
    expect(successor?.transitionIntentId).toBe(intentReply().id);
    // 全程普通 resolve(无 intent)恰一笔:后继会话只经意图消费产生,零旁路第二会话
    const plainResolves = resolveBodies().filter((body) => !('transitionIntentId' in body));
    expect(plainResolves).toHaveLength(1);
  });

  it('R3 过期出口「重新播放」后再发起:顺序替换而非并行(先建链废弃收口,活动会话唯一)', async () => {
    vi.useFakeTimers();
    renderCoordinatorProbe();
    await playAndFail();
    const resolvesAtFailure = resolveBodies().length;

    // 越过 60s 恢复窗口:recover 收口 →「重新播放」承载新普通播放(vod-switch F2 同源)
    await pumpTimers(61_000);
    await awaitUi(() => expect(screen.getByRole('button', { name: '重新播放' })).toBeInTheDocument());

    // 第一笔:过期出口新普通播放(新意图 → sess-next-1)
    fireEvent.click(screen.getByRole('button', { name: '重新播放' }));
    await awaitUi(() => expect(resolveBodies()).toHaveLength(resolvesAtFailure + 1));
    expect(intentRequests()).toHaveLength(0); // 过期出口零过渡意图
    // 第二笔:新播放再发起(探针同路 play)—— 顺序替换(新意图号),非并行双链
    fireEvent.click(screen.getByTestId('play-a'));

    // 恰两笔新普通 resolve(每意图一笔;不多不少 —— 无旁路链的第三笔)
    await awaitUi(() => expect(resolveBodies()).toHaveLength(resolvesAtFailure + 2));
    // 先建新链被废弃收口(幂等空 stop):不残留并行活动会话
    await awaitUi(() => expect(stopCallsFor('sess-next-1').length).toBeGreaterThanOrEqual(1));
    // 唯一播放面 + 唯一活动会话(最新意图的会话)
    await awaitUi(() => expect(screen.getByTestId('phase').textContent).toBe('playing'));
    expect(document.querySelectorAll('[data-testid="playback-surface"]')).toHaveLength(1);
    expect(stopCallsFor('sess-next-2')).toHaveLength(0);
    expect(screen.getByTestId('playback-session').textContent).toBe('sess-next-2');
  });
});
