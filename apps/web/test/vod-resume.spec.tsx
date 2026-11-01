import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';

/**
 * 引擎边界 mock(009 playback-modal 同款):jsdom 无媒体实现,video.js 对不可加载
 * src 会异步抛 error → onFatalError → playing→unavailable。本规格断言进度/续播
 * 行为而非引擎行为 —— 模块边界替换 video.js 为无副作用假引擎(video-player.tsx
 * 的「无媒体环境兜底」语义同源),媒体事件由测试直接派发到 <video> 元素。
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
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';
import { MemoryRouter, Route, Routes } from 'react-router';
import { ActionCoordinator, usePlayAction } from '../src/app/action-coordinator';
import { SessionProvider, useSession } from '../src/app/session-provider';
import { SettingsAccessProvider } from '../src/features/settings/settings-access-provider';
import { PlayerView } from '../src/features/playback/player-view';
import { MediaDetailPage } from '../src/features/catalog/MediaDetailPage';
import { queryKeys } from '../src/shared/query/keys';
import type { AccountSession } from '../src/app/session-types';
import type { HistoryItem } from '../src/features/history/history-api';
import { createQueryWrapper, createTestQueryClient } from './helpers/query-test-utils';
import type { PublicMediaDto, Vod } from '@hmp/shared';

/**
 * T047(010 US2 测试先行)—— 续播/进度前端契约钉(vod-resume 面):
 *
 * 权威:docs/specs/010-online-vod/contracts/api.md §1(PlaybackDto 010 扩展、
 * ProgressReply、HistorySummary、ObservationSample/Reply)、§4(observations 行)、
 * §7(I4 起播确认与 U2 定位能力)、playback-state.md §3/§7/§8、ui.md §2/§5/§6。
 * mock 层沿用 005 T048/010 T032 惯例:vi.stubGlobal('fetch') 路由式 mock、DTO 以
 * @hmp/shared 生成形状手写最小合法对象、MediaDetailPage 走 SessionProvider+
 * ActionCoordinator+MemoryRouter 基座、PlayerView 直挂(props 驱动,零个人请求)。
 *
 * ── 文件头映射表(基线 2026-10-30;T048 已落地,T049 未实现)──
 *
 * | 用例                            | 契约锚点                                              | 现状基线    |
 * | ------------------------------- | ----------------------------------------------------- | ----------- |
 * | B1 未实际 playing 不得 started  | api.md §4 reason=started/playback-state §7           | 绿          |
 * | B2 本地 seek 不换 generation    | api.md §7 I4/U2(不推进 generation、seq 单调)      | 绿          |
 * | B3 尾段复位(seeking 观测)    | api.md §4 observations/playback-state §7             | 绿(T048 观测通道;T049 共担面已接)|
 * | B4 续播降级显示原因不显示成功   | api.md §1 PlaybackDto.resumeReason/playback-state §3 | 绿(T049)   |
 * | B5 本地续播落点失败不显示成功   | api.md §7 I4/ui.md §6                                | 绿(T049)   |
 * | B6 换档身份清理(取消在途+守卫)| ui.md §5/playback-state §8                           | 绿(个人缓存域清除由 unit/identity-purge.spec.tsx 承担,本文件钉播放链路面)|
 * | B7 duration_unknown 资格面      | ui.md §1/§6、api.md §1 HistorySummary                 | 绿          |
 * | B7b duration_unknown 不可保存提示 | ui.md §6「显示进度不可保存」                        | 绿(T049)   |
 *
 * 契约钉边界(避免过度约束):
 * - 「已续播」成功态与降级/落点提示的文案取 ui.md §6 语义词(已续播/从头播放/重新
 *   选择/进度不可保存),不钉具体组件或样式;B4 以内容级关键词「内容已变化」钉
 *   resumeReason=content_changed 的可见性(T049 可自定完整文案);
 * - B3 只钉观测顺序/同代/单调语义(尾段证据的复位判定在服务端,客户端面=先发
 *   seeking 再 seeked);eventSeq 每 generation 独立,不与 sampleSeq 互代;
 * - 切档清个人缓存的行为级断言(域清除先于新身份可见)已由 006 unit/identity-purge
 *   覆盖,本文件不重复;此处钉播放链路的在途取消与旧响应守卫 + 键身份隔离。
 */

type ProgressReplyDto = Vod.components['schemas']['ProgressReply'];
type VodPlaybackDto = Vod.components['schemas']['PlaybackDto'];

// ────────────────────────── 夹具(按 @hmp/shared 生成类型手写最小合法对象) ──────────────────────────

function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...headers },
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
    ...overrides,
  };
}

/** 合法 ProgressReply 夹具(accepted 形态;stale/superseded 经 overrides 收敛) */
function progressReply(overrides: Partial<ProgressReplyDto> = {}): ProgressReplyDto {
  return {
    applied: true,
    reason: 'accepted',
    historyRevision: 4,
    sessionAccepted: true,
    acceptedSampleSeq: 1,
    acceptedPositionSeconds: 5,
    acceptedGeneration: 1,
    sessionStarted: true,
    ...overrides,
  };
}

/** 010 扩展 PlaybackDto 夹具(T003 冻结形状;005 基座字段+010 追加面) */
function playbackDto(overrides: Partial<VodPlaybackDto> = {}): VodPlaybackDto {
  return {
    id: 'sess-vod-1',
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

function publicMedia(overrides: Partial<PublicMediaDto> = {}): PublicMediaDto {
  return {
    id: 'media-1',
    type: 'episode',
    title: '例牌单集',
    description: null,
    posterRef: null,
    contentLevel: 6,
    availability: 'available',
    ...overrides,
  };
}

/** 005 HistoryItem + 010 HistorySummary 扩展面(计划内;T046/T049 接线后换正式形状) */
interface PlannedHistoryItem extends HistoryItem {
  readonly canAttemptResume?: boolean;
  readonly resumeReason?: 'unavailable' | 'content_changed' | 'continuity_changed' | 'completed' | 'invalid_position' | 'duration_unknown' | null;
  readonly resumeConfidence?: 'operational' | 'verified' | 'none';
}

function historyItem(overrides: Partial<PlannedHistoryItem> = {}): PlannedHistoryItem {
  return {
    media: publicMedia(),
    lastViewedAt: '2026-10-29T20:00:00.000Z',
    positionSeconds: 600,
    durationSeconds: 3600,
    canResume: true,
    revision: 3,
    canAttemptResume: true,
    resumeReason: null,
    resumeConfidence: 'verified',
    ...overrides,
  };
}

// ────────────────────────── fetch mock 布线(005 T048 路由式惯例) ──────────────────────────

let fetchMock: Mock;
type MockRoute = (method: string, path: string, body: unknown) => Response | Promise<Response> | null;
let routes: MockRoute[];
/** POST /playback/resolve 请求体清单(继续/从头 startMode 断言用) */
let resolveBodies: Array<Record<string, unknown>>;

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

function progressBodies(): Array<Record<string, unknown>> {
  return recorded()
    .filter((call) => call.url.endsWith('/progress') && typeof call.init.body === 'string')
    .map((call) => JSON.parse(call.init.body as string) as Record<string, unknown>);
}

function observationBodies(): Array<Record<string, unknown>> {
  return recorded()
    .filter((call) => call.url.endsWith('/observations') && typeof call.init.body === 'string')
    .map((call) => JSON.parse(call.init.body as string) as Record<string, unknown>);
}

type RouteHandler = (body: unknown, path: string) => Response | Promise<Response>;

/** 后注册优先:用例级覆盖压过世界级缺省(005 T048 同款) */
function when(method: string, pathPattern: RegExp, handler: RouteHandler): void {
  routes.unshift((reqMethod, path, reqBody) => {
    if (reqMethod !== method || !pathPattern.test(path)) {
      return null as unknown as Response;
    }
    return handler(reqBody, path);
  });
}

/** 默认世界:已选档会话 + sess-vod-1 播放全链 + 详情/历史取数;未命中 404 problem */
function installDefaultWorld(): void {
  when('GET', /\/auth\/session$/, () => jsonResponse(sessionFixture()));
  when('GET', /\/setup\/status$/, () => jsonResponse({ initialized: true }));
  when('POST', /\/playback\/resolve$/, (body) => {
    resolveBodies.push(body as Record<string, unknown>);
    return jsonResponse(playbackDto({ state: 'preparing', ticketExpiresAt: null, playbackUrl: null }), 201, {
      Location: '/api/playback/sessions/sess-vod-1',
    });
  });
  when('GET', /\/playback\/sessions\/sess-vod-1$/, () => jsonResponse(playbackDto({ state: 'ready' })));
  when('POST', /\/playback\/sessions\/sess-vod-1\/renew$/, () =>
    jsonResponse({
      playbackUrl: '/api/playback/stream/sess-vod-1/1/index?ticket=t',
      ticketExpiresAt: '2026-11-26T00:00:00.000Z',
      generation: 1,
    }),
  );
  when('POST', /\/playback\/sessions\/sess-vod-1\/(progress|observations|heartbeat|stop)$/, () =>
    new Response(null, { status: 204 }),
  );
  when('GET', /\/public\/media\/media-1$/, () => jsonResponse(publicMedia()));
  when('GET', /\/me\/history\/media-1$/, () => jsonResponse(historyItem()));
}

// ────────────────────────── 渲染基座 ──────────────────────────

function getVideo(): HTMLVideoElement {
  const el = document.querySelector('video');
  expect(el).not.toBeNull();
  return el as HTMLVideoElement;
}

/** PlayerView 直挂(props 驱动;票据远期避免续期定时器干扰;fake timers 下心跳可控) */
function renderPlayerView(props: { readonly presentationStartSeconds?: number } = {}): void {
  render(
    <PlayerView
      sessionId="sess-vod-1"
      generation={1}
      playbackUrl="/api/playback/stream/sess-vod-1/1/index?ticket=t"
      ticketExpiresAt="2026-11-26T00:00:00.000Z"
      delivery="hls_proxy"
      presentationStartSeconds={props.presentationStartSeconds ?? 0}
      onTerminated={() => undefined}
      onRenew={() => undefined}
    />,
  );
}

/** 播放意图观察面(005 T048 同款探针):播放入口 + 当前阶段 */
function PlayProbe(): ReactNode {
  const { play, playback } = usePlayAction();
  const sessionStatus = useSession().status;
  return (
    <div>
      <span data-testid="session-status">{sessionStatus}</span>
      <span data-testid="phase">{playback?.phase ?? '-'}</span>
      <button type="button" data-testid="play-a" onClick={() => play({ mediaId: 'media-1', title: '例牌单集' })}>
        play-a
      </button>
    </div>
  );
}

function renderCoordinatorProbe(): void {
  // 每例独立内存 QueryClient(retry:false;T032 基座同款):缓存不跨例泄漏
  const client = createTestQueryClient();
  render(
    <MemoryRouter initialEntries={['/vod']}>
      <SessionProvider>
        <SettingsAccessProvider>
          <ActionCoordinator>
            <PlayProbe />
          </ActionCoordinator>
        </SettingsAccessProvider>
      </SessionProvider>
    </MemoryRouter>,
    { wrapper: createQueryWrapper(client) },
  );
}

function renderMediaDetail(): void {
  const client = createTestQueryClient();
  render(
    <MemoryRouter initialEntries={['/media/media-1']}>
      <SessionProvider>
        <SettingsAccessProvider>
          <ActionCoordinator>
            <Routes>
              <Route path="/media/:id" element={<MediaDetailPage />} />
            </Routes>
          </ActionCoordinator>
        </SettingsAccessProvider>
      </SessionProvider>
    </MemoryRouter>,
    { wrapper: createQueryWrapper(client) },
  );
}

/** 起播确认基座:实际 playing 观测 + 2xx ProgressReply(accepted)→ started 确认 */
async function ackStarted(videoEl: HTMLVideoElement, positionSeconds: number): Promise<void> {
  videoEl.currentTime = positionSeconds;
  await act(async () => {
    videoEl.dispatchEvent(new Event('playing'));
    await vi.advanceTimersByTimeAsync(0);
  });
}

beforeEach(() => {
  fetchMock = vi.fn();
  routes = [];
  resolveBodies = [];
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
  installDefaultWorld();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

// ────────────────────────── B1/B2 · started 门与本地 seek(现行为绿) ──────────────────────────

describe('010 T047 · 首次 started 门与本地 seek', () => {
  it('B1 未实际 playing 不得发 started 样本:静置周期拍与 pause 事件都不替代 playing 观测(现行为绿)', async () => {
    vi.useFakeTimers();
    renderPlayerView();
    const videoEl = getVideo();
    // 静置 30s(越过 3 个周期拍)后显式暂停:全程无实际 playing 观测
    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_000);
    });
    await act(async () => {
      videoEl.dispatchEvent(new Event('pause'));
      await vi.advanceTimersByTimeAsync(0);
    });
    // started 门语义:reason=started 只允许由实际 playing 观测触发(T049「未实际 playing 不得 started」)
    expect(progressBodies().filter((body) => body.reason === 'started')).toHaveLength(0);
  });

  it('B2 本地 seek 不换 generation:seek 后零重建命令、无第二次 started,sampleSeq 同代持续单调且承载新位置(现行为绿)', async () => {
    vi.useFakeTimers();
    renderPlayerView();
    const videoEl = getVideo();
    await ackStarted(videoEl, 5);
    // client seek:媒体 API 定位(seekCapability=client),不走服务端重建
    await act(async () => {
      videoEl.currentTime = 200;
      videoEl.dispatchEvent(new Event('seeking'));
      videoEl.dispatchEvent(new Event('seeked'));
      await vi.advanceTimersByTimeAsync(0);
    });
    // 不推进 generation、不新建输入:零 /seek(服务端重建专用)、零 /stop、零二次 resolve
    expect(recorded().filter((call) => call.url.endsWith('/seek'))).toHaveLength(0);
    expect(recorded().filter((call) => call.url.endsWith('/stop'))).toHaveLength(0);
    expect(recorded().filter((call) => call.url.endsWith('/resolve'))).toHaveLength(0);
    // 同代有序上报:seq 单调推进、expectedGeneration 不变、位置取自 seek 落点
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000);
    });
    const bodies = progressBodies();
    expect(bodies.filter((body) => body.reason === 'started')).toHaveLength(1);
    const periodics = bodies.filter((body) => body.reason === 'periodic');
    expect(periodics.length).toBeGreaterThanOrEqual(1);
    for (const body of periodics) {
      expect(body.expectedGeneration).toBe(1);
      expect(Number(body.sampleSeq)).toBeGreaterThan(1);
    }
    expect(periodics[periodics.length - 1]?.positionSeconds).toBe(200);
    // 本地 seek 不被回弹(ACK 后 seek 放行)
    expect(videoEl.currentTime).toBe(200);
  });
});

// ────────────────────────── B3/B4/B5 · 尾段复位与续播降级(T048/T049 计划内红) ──────────────────────────

describe('010 T047 · 尾段复位与续播降级', () => {
  it('B3 尾段复位(T048 观测通道已落地;T049 共担):client seek 先发 seeking 观测再 seeked,事件流同代且 eventSeq 单调', async () => {
    vi.useFakeTimers();
    renderPlayerView();
    const videoEl = getVideo();
    await ackStarted(videoEl, 5);
    await act(async () => {
      videoEl.currentTime = 200;
      videoEl.dispatchEvent(new Event('seeking'));
      videoEl.dispatchEvent(new Event('seeked'));
      await vi.advanceTimersByTimeAsync(0);
    });
    // api.md §7 I4:client seek「先发 seeking 重置末段证据,再 seeked」;
    // playback-state §7:「seeking 立即重置尾段观测,进度仍在同代有序上报」。
    const observations = observationBodies();
    expect(observations.length).toBeGreaterThanOrEqual(2);
    const seekObservations = observations.filter((o) => o.event === 'seeking' || o.event === 'seeked');
    expect(seekObservations.map((o) => o.event)).toEqual(['seeking', 'seeked']);
    for (const observation of seekObservations) {
      expect(observation.expectedGeneration).toBe(1); // 观测与样本同代,client seek 不换代
      expect(typeof observation.positionSeconds).toBe('number');
    }
    // eventSeq 每 generation 独立单调(playback-state §1:不与 sampleSeq 互代)
    const eventSeqs = seekObservations.map((o) => Number(o.eventSeq));
    expect(new Set(eventSeqs).size).toBe(eventSeqs.length);
  });

  it('B4 续播降级:probe 后 content_changed 回退从头——显示具体降级原因,不显示「已续播」成功', async () => {
    // resolve 与状态轮询均带 probe 后降级结论:回退从头,原因=内容已变化
    const degraded = playbackDto({
      state: 'ready',
      startBasis: 'beginning',
      resumeDisposition: 'beginning',
      resumeReason: 'content_changed',
    });
    when('POST', /\/playback\/resolve$/, () =>
      jsonResponse(playbackDto({ state: 'preparing', resumeDisposition: 'pending', resumeReason: null, startBasis: 'beginning' }), 201),
    );
    when('GET', /\/playback\/sessions\/sess-vod-1$/, () => jsonResponse(degraded));
    renderCoordinatorProbe();
    await waitFor(() => expect(screen.getByTestId('session-status').textContent).toBe('authenticated'));
    fireEvent.click(screen.getByTestId('play-a'));
    // 播放本身继续(降级从头不是失败):authorize → prepare → playing
    await waitFor(() => expect(screen.getByTestId('phase').textContent).toBe('playing'), { timeout: 4000 });
    // playback-state §3:probe 后降级从头必须显示具体 resumeReason;
    // 旧历史保留但「已续播」成功语义绝不出现(ui.md §6)
    expect(screen.getByText(/内容已变化/)).toBeInTheDocument();
    expect(screen.queryByText(/已续播|已恢复到上次位置/)).not.toBeInTheDocument();
  });

  it('B5 本地续播落点失败:client seek 未落入允许误差——不得显示「已续播」,提示从头或重新选择', async () => {
    vi.useFakeTimers();
    // 冻结起点 120s,由播放器媒体就绪后 client 定位(api.md §7 I4)
    renderPlayerView({ presentationStartSeconds: 120 });
    const videoEl = getVideo();
    // 模拟落点失败:媒体拒绝定位(setter 静默丢弃),实际落点 0 与目标 120 偏差超容差
    Object.defineProperty(videoEl, 'currentTime', {
      configurable: true,
      get: () => 0,
      set: () => undefined,
    });
    await act(async () => {
      videoEl.dispatchEvent(new Event('loadedmetadata'));
      await vi.advanceTimersByTimeAsync(0);
    });
    // 未落入允许误差:「已续播」成功语义绝不出现;必须给出显式出路提示(ui.md §6)
    expect(screen.queryByText(/已续播|已恢复到上次位置/)).not.toBeInTheDocument();
    expect(screen.getByText(/从头播放|重新选择/)).toBeInTheDocument();
  });
});

// ────────────────────────── B6/B7 · 切档清理与 duration_unknown ──────────────────────────

describe('010 T047 · 切档/身份清理与 duration_unknown', () => {
  it('B6 换档身份清理:旧会话在途保存被中止(signal aborted)、迟到响应不回写不重试,新会话身份独立(现行为绿)', async () => {
    vi.useFakeTimers();
    interface RecordedProgressCall {
      url: string;
      body: Record<string, unknown>;
      signal: AbortSignal | null;
    }
    const progressCalls: RecordedProgressCall[] = [];
    let releaseOldReply: ((reply: ProgressReplyDto) => void) | null = null;
    fetchMock.mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith('/progress')) {
        const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
        progressCalls.push({
          url,
          body,
          signal: init?.signal instanceof AbortSignal ? init.signal : null,
        });
        if (progressCalls.length === 1) {
          // 旧会话 started 在途挂起(换档打断窗口)
          return await new Promise<Response>((resolve) => {
            releaseOldReply = (reply: ProgressReplyDto): void => resolve(jsonResponse(reply));
          });
        }
        return jsonResponse(progressReply());
      }
      return new Response(null, { status: 204 });
    });
    const { rerender } = render(
      <PlayerView
        sessionId="sess-old"
        generation={1}
        playbackUrl="/api/playback/stream/sess-old/1/index?ticket=t"
        ticketExpiresAt="2026-11-26T00:00:00.000Z"
        delivery="hls_proxy"
        onTerminated={() => undefined}
        onRenew={() => undefined}
      />,
    );
    const videoEl = getVideo();
    videoEl.currentTime = 12;
    await act(async () => {
      videoEl.dispatchEvent(new Event('playing'));
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(progressCalls).toHaveLength(1); // 旧会话 started 在途
    // 换档(切档/退出):sessionId 变化即会话身份变化
    rerender(
      <PlayerView
        sessionId="sess-new"
        generation={1}
        playbackUrl="/api/playback/stream/sess-new/1/index?ticket=t"
        ticketExpiresAt="2026-11-26T00:00:00.000Z"
        delivery="hls_proxy"
        onTerminated={() => undefined}
        onRenew={() => undefined}
      />,
    );
    // 取消在途保存:旧会话请求 signal 已 abort(ui.md §5「旧请求 AbortSignal 取消」)
    expect(progressCalls[0]?.signal?.aborted).toBe(true);
    // 旧响应守卫:迟到响应到达后不得向旧会话回写/重试(playback-state §8)
    await act(async () => {
      releaseOldReply?.(progressReply());
      await vi.advanceTimersByTimeAsync(0);
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_000); // 覆盖 500ms 退避窗口:无重试即无新调用
    });
    expect(progressCalls.filter((call) => call.url.includes('sess-old'))).toHaveLength(1);
    // 新会话身份独立:实际 playing → 新会话 started(seq 从 1 起,不继承旧会话)
    videoEl.currentTime = 12;
    await act(async () => {
      videoEl.dispatchEvent(new Event('playing'));
      await vi.advanceTimersByTimeAsync(0);
    });
    const newStarted = progressCalls.filter(
      (call) => call.url.includes('sess-new') && call.body.reason === 'started',
    );
    expect(newStarted).toHaveLength(1);
    expect(newStarted[0]?.body).toEqual({
      sampleSeq: 1,
      expectedGeneration: 1,
      positionSeconds: 12,
      reason: 'started',
    });
  });

  it('B6b 身份守卫:游客浏览详情零 /me 个人请求;个人进度键按 Profile 隔离(ui.md §5,现行为绿)', async () => {
    when('GET', /\/auth\/session$/, () => problemResponse(401, 'SESSION_INVALID'));
    renderMediaDetail();
    await waitFor(() => expect(screen.getByRole('heading', { name: '例牌单集' })).toBeInTheDocument());
    // 游客(FR-016):身份未知时个人进度查询 enabled 关闭,零 /me 请求
    await new Promise((resolve) => setTimeout(resolve, 20));
    for (const call of recorded()) {
      expect(call.url).not.toMatch(/\/me(\/|$)/);
    }
    // 个人键身份隔离(ui.md §5「Profile 域含服务端验证 Profile」):跨 Profile 键必不同,
    // 切档后的域清除(identity-purge.spec.tsx 行为级覆盖)据此不命中他 Profile 缓存
    expect(queryKeys.profile('profile-a').progress('media-1')).toEqual([
      'profile',
      'profile-a',
      'progress',
      'media-1',
    ]);
    expect(queryKeys.profile('profile-b').progress('media-1')).not.toEqual(
      queryKeys.profile('profile-a').progress('media-1'),
    );
  });

  it('B7 无 duration(duration_unknown):不显示「继续观看」;唯一播放入口以从头发起(现行为绿)', async () => {
    when('GET', /\/me\/history\/media-1$/, () =>
      jsonResponse(
        historyItem({
          durationSeconds: null,
          canResume: false,
          canAttemptResume: false,
          resumeReason: 'duration_unknown',
          resumeConfidence: 'none',
        }),
      ),
    );
    const user = userEvent.setup();
    renderMediaDetail();
    await waitFor(() => expect(screen.getByRole('heading', { name: '例牌单集' })).toBeInTheDocument());
    // duration_unknown → 候选资格为否:零「继续观看」入口,不显示可保存进度
    expect(screen.queryByRole('button', { name: '继续观看 例牌单集' })).not.toBeInTheDocument();
    // 始终有从头入口(ui.md §1):点击以 startMode=beginning 发起(不携带 resume)
    await user.click(screen.getByRole('button', { name: '播放 例牌单集' }));
    await waitFor(() => expect(resolveBodies).toHaveLength(1));
    expect(resolveBodies[0]).toEqual({ mediaId: 'media-1', startMode: 'beginning' });
  });

  it('B7b 无 duration 提示:显示「进度不可保存」,不虚构可保存进度', async () => {
    when('GET', /\/me\/history\/media-1$/, () =>
      jsonResponse(
        historyItem({
          durationSeconds: null,
          canResume: false,
          canAttemptResume: false,
          resumeReason: 'duration_unknown',
          resumeConfidence: 'none',
        }),
      ),
    );
    renderMediaDetail();
    await waitFor(() => expect(screen.getByRole('heading', { name: '例牌单集' })).toBeInTheDocument());
    // ui.md §6「已播放但 duration 未知显示进度不可保存」/api.md §7 I4「此来源暂不支持
    // 进度保存」:详情入口与播放面任一承载即可,此处钉详情页可见性。
    expect(screen.getByText(/进度不可保存|不支持进度保存/)).toBeInTheDocument();
  });
});
