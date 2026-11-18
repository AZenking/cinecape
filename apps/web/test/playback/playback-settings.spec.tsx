/** @jsxImportSource react */
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';

/**
 * 引擎边界 mock(jsdom 无媒体实现;playback-modal.spec 同源语义):
 * vi.hoisted 状态 + 假引擎记录调用面 —— src/play 调用次数即「浮层开关零媒体副作用」
 * 的观测面(FR-023 不中断播放);error 处理器捕获供后续故障类用例复用。
 */
const fakePlayerState = vi.hoisted(() => ({
  calls: [] as string[],
  errorHandlers: [] as Array<() => void>,
  rejectPlayWith: null as unknown | null,
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
    src(): void {
      fakePlayerState.calls.push('src');
    }
    play(): Promise<void> | undefined {
      fakePlayerState.calls.push('play');
      if (fakePlayerState.rejectPlayWith !== null) {
        return Promise.reject(fakePlayerState.rejectPlayWith);
      }
      return undefined;
    }
    dispose(): void {}
  }
  return { default: () => new FakePlayer() };
});
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import type { Vod } from '@hmp/shared';
import { PlayerView } from '../../src/features/playback/player-view';
import { createTestQueryClient } from '../helpers/query-test-utils';

/**
 * 012 T028 · 播放设置浮层钉面(PlayerView 直挂;FR-020 第 4 项/FR-023、ui.md §4.4):
 * - 浮层开/关零媒体副作用(src/play 调用数不变)、零变更请求 —— 播放不中断;
 * - 浮层内无「打开完整设置」入口(FR-023;ui.md §4.4);
 * - 字幕切换:PUT selection CAS(expectedVersion=探针 version、audioTrackId=当前、
 *   subtitleTrackId 目标/null),同会话零 resolve(FR-020 末项同源);同值重复点击
 *   零请求;version 缺位闭门;
 * - 音轨重建:generation+1 → 轮询同会话 → 以新代 renew 换票(onRenew 收新 URL)
 *   —— 零第二 /playback/resolve;ACK 前音轨闭门(泵门,005 T104 同源);
 * - 清晰度:探测交付只读展示(无切换端点);直播状态徽标(时长 null)文字呈现。
 */

type PlaybackDto = Vod.components['schemas']['PlaybackDto'];

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

/** PlaybackDto 夹具(010 冻结形状;轨道为 012 浮层事实面) */
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
    tracks: {
      audio: [
        { id: 'audio-1', label: '国语', language: 'zh', default: true },
        { id: 'audio-2', label: '评论音轨', language: 'zh', default: false },
      ],
      subtitles: [{ id: 'sub-1', label: '简体中文', language: 'zh' }],
    },
    startBasis: 'beginning',
    resumeDisposition: 'beginning',
    resumeReason: null,
    transitionSlot: { revision: 0, status: 'open', activeIntentId: null, successorSessionId: null },
    seekCapability: 'client',
    playbackStarted: false,
    ...overrides,
  };
}

// ────────────────────────── fetch mock(路由式;会话级有状态) ──────────────────────────

let fetchMock: Mock;
/** selection 提交与响应面(用例级重接线) */
let probeDto: PlaybackDto;
let selectionResponder: ((body: Record<string, unknown>) => Response | Promise<Response>) | null = null;
/** PUT selection 后,GET 会话返回的快照(默认仍 probeDto) */
let statusAfterSelection: PlaybackDto | null = null;
let onRenewed: (url: string, expiresAt: string) => void;

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

const selectionBodies = (): Array<Record<string, unknown>> => bodiesEndingWith('/selection');
const renewBodies = (): Array<Record<string, unknown>> => bodiesEndingWith('/renew');
const resolveBodies = (): Array<Record<string, unknown>> => bodiesEndingWith('/playback/resolve');
const progressBodies = (): Array<Record<string, unknown>> => bodiesEndingWith('/progress');

beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
  probeDto = playbackDto();
  statusAfterSelection = null;
  selectionResponder = null;
  onRenewed = () => undefined;
  fakePlayerState.calls = [];
  fakePlayerState.errorHandlers = [];
  fakePlayerState.rejectPlayWith = null;
  fetchMock.mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
    const method = (init?.method ?? 'GET').toUpperCase();
    const url = String(input);
    if (method === 'PUT' && /\/playback\/sessions\/sess-a\/selection$/.test(url)) {
      const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
      if (selectionResponder !== null) {
        return await selectionResponder(body);
      }
      const next = playbackDto({ version: probeDto.version + 1 });
      return jsonResponse(next);
    }
    if (/\/playback\/sessions\/sess-a\/renew$/.test(url)) {
      return jsonResponse({
        playbackUrl: '/api/playback/stream/sess-a/2/index.m3u8?ticket=t2',
        ticketExpiresAt: '2099-01-01T00:00:00.000Z',
        generation: JSON.parse(String(init?.body ?? '{}')).expectedGeneration ?? 1,
      });
    }
    if (/\/playback\/sessions\/sess-a$/.test(url) && method === 'GET') {
      return jsonResponse(statusAfterSelection ?? probeDto);
    }
    if (/\/playback\/sessions\/sess-a\/progress$/.test(url) && method === 'POST') {
      const sample = JSON.parse(String(init?.body ?? '{}')) as { sampleSeq?: number };
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
    }
    if (/\/playback\/sessions\/sess-a\/(stop|heartbeat|observations)$/.test(url)) {
      return new Response(null, { status: 204 });
    }
    return problemResponse(404, 'NOT_FOUND');
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function getVideo(): HTMLVideoElement {
  const el = document.querySelector('video');
  expect(el).not.toBeNull();
  return el as HTMLVideoElement;
}

/** PlayerView 直挂需要 QueryClientProvider(019 直播节目元数据查询;点播 enabled=false) */
function withTestQuery(node: ReactNode): ReactNode {
  return <QueryClientProvider client={createTestQueryClient()}>{node}</QueryClientProvider>;
}

/** PlayerView 直挂(vod-switch 同形;票据远期避免续期定时器干扰) */
function renderPlayer(dtoOverrides: Partial<PlaybackDto> = {}): void {
  probeDto = playbackDto(dtoOverrides);
  render(
    withTestQuery(
      <PlayerView
        sessionId="sess-a"
        generation={1}
        playbackUrl="/api/playback/stream/sess-a/1/index.m3u8?ticket=t1"
        ticketExpiresAt="2099-01-01T00:00:00.000Z"
        delivery="hls_proxy"
        title="例牌单集"
        onExit={() => undefined}
        onTerminated={() => undefined}
        onRenew={(url, expiresAt) => {
          onRenewed(url, expiresAt);
        }}
      />,
    ),
  );
}

async function openSettings(): Promise<void> {
  await waitFor(() => expect(screen.getByRole('button', { name: '播放设置' })).toBeInTheDocument());
  fireEvent.click(screen.getByRole('button', { name: '播放设置' }));
  await waitFor(() => expect(screen.getByTestId('playback-settings')).toBeInTheDocument());
}

/** 实际 playing 观测(泵 started 门;vod-switch 同款) */
async function startPlayback(positionSeconds: number): Promise<void> {
  const videoEl = getVideo();
  videoEl.currentTime = positionSeconds;
  await act(async () => {
    videoEl.dispatchEvent(new Event('playing'));
  });
}

// ────────────────────────── A · 浮层开关零中断 + 无完整设置入口 ──────────────────────────

describe('T028 · 播放设置浮层:开/关不中断播放(FR-023)', () => {
  it('A1 打开→关闭:零媒体副作用(src/play 调用数不变)、零变更请求、浮层内无「打开完整设置」', async () => {
    renderPlayer();
    await waitFor(() => expect(screen.getByTestId('playback-video')).toBeInTheDocument());
    const mountsAt = fakePlayerState.calls.length; // 挂载期 src 安装 + 起播尝试
    const requestsAtMount = recorded().length;

    await openSettings();
    expect(screen.getByRole('dialog', { name: '播放设置' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /关闭.*\(当前\)/ })).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: '关闭播放设置' }));
    await waitFor(() => expect(screen.queryByTestId('playback-settings')).not.toBeInTheDocument());

    // 媒体零副作用:开/关浮层不换源、不起播/暂停(引擎调用数不变;播放面存活)
    expect(fakePlayerState.calls.length).toBe(mountsAt);
    expect(screen.getByTestId('playback-video')).toBeInTheDocument();
    // 零变更请求:开/关期间除挂载期既有请求外无新增(probe 恰一次;无 selection)
    expect(recorded().length).toBe(requestsAtMount);
    expect(selectionBodies()).toHaveLength(0);
    // FR-023:浮层内无跳转完整设置页入口
    expect(screen.queryByText('打开完整设置')).not.toBeInTheDocument();
  });

  it('A2 浮层渲染三组当前值:音轨默认轨(当前)、字幕关闭(当前)、清晰度只读交付', async () => {
    renderPlayer();
    await openSettings();
    // 音轨:初始=服务端默认轨(FR-017)
    expect(screen.getByRole('button', { name: '国语(当前)' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '评论音轨' })).toBeInTheDocument();
    // 字幕:初始关闭(FR-017 不自动开启)
    expect(screen.getByRole('button', { name: '关闭(当前)' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '简体中文' })).toBeInTheDocument();
    // 清晰度:只读展示探测交付,无切换入口
    expect(screen.getByTestId('playback-quality').textContent).toContain('当前交付:HLS 直转');
    expect(screen.getByText('清晰度由服务端按内容与家庭网络自动选择。')).toBeInTheDocument();
    expect(screen.queryByText('打开完整设置')).not.toBeInTheDocument();
  });

  it('A3 探测未完成(tracks 空):浮层显示「暂无可切换」不虚构轨道', async () => {
    renderPlayer({ tracks: { audio: [], subtitles: [] } });
    await openSettings();
    expect(screen.getByText('暂无可切换音轨')).toBeInTheDocument();
    expect(screen.getByText('暂无可切换字幕')).toBeInTheDocument();
  });
});

// ────────────────────────── B · 字幕切换(CAS/同会话/零请求冗余) ──────────────────────────

describe('T028 · 字幕当前值控制(恰一会话;FR-020 第 4 项)', () => {
  it('B1 开启字幕:PUT selection 携 CAS 与当前音轨;响应回写版本;同值重复点击零请求', async () => {
    let seenBody: Record<string, unknown> | null = null;
    selectionResponder = (body) => {
      seenBody = body;
      return jsonResponse(playbackDto({ version: 2 }));
    };
    renderPlayer();
    getVideo().currentTime = 42;
    await openSettings();

    fireEvent.click(screen.getByRole('button', { name: '简体中文' }));
    await waitFor(() => expect(screen.getByRole('button', { name: '简体中文(当前)' })).toBeInTheDocument());
    await waitFor(() => expect(screen.getByRole('button', { name: '关闭' })).toBeInTheDocument());

    expect(seenBody).toEqual({
      expectedVersion: 1,
      positionSeconds: 42,
      audioTrackId: 'audio-1',
      subtitleTrackId: 'sub-1',
    });
    // 同会话零新增会话:全程零 /playback/resolve(FR-020 末项同源)
    expect(resolveBodies()).toHaveLength(0);
    // 同值重复点击:零第二次请求(幂等门)
    const afterFirst = selectionBodies().length;
    fireEvent.click(screen.getByRole('button', { name: '简体中文(当前)' }));
    expect(selectionBodies().length).toBe(afterFirst);
    // 关闭字幕:null 语义
    fireEvent.click(screen.getByRole('button', { name: '关闭' }));
    await waitFor(() => expect(selectionBodies().length).toBe(afterFirst + 1));
    expect(selectionBodies()[selectionBodies().length - 1]?.subtitleTrackId).toBeNull();
  });

  it('B2 探针失败(版本/轨道事实缺位):不虚构轨道、零提交外发(事实缺位不冒进)', async () => {
    fetchMock.mockImplementation(async () => problemResponse(404, 'NOT_FOUND')); // probe 失败不回写
    renderPlayer();
    await openSettings();
    expect(screen.getByText('暂无可切换音轨')).toBeInTheDocument();
    expect(screen.getByText('暂无可切换字幕')).toBeInTheDocument();
    expect(selectionBodies()).toHaveLength(0);
  });
});

// ────────────────────────── C · 音轨切换(ACK 门 + 同会话换代换票) ──────────────────────────

describe('T028 · 音轨当前值控制(重建输出同会话换代;FR-020 第 4 项)', () => {
  it('C1 started ACK 前:音轨按钮禁用,点击闭门给稳定文案(泵门,005 T104 同源)', async () => {
    renderPlayer();
    await openSettings();
    const audioButton = screen.getByRole('button', { name: '评论音轨' });
    expect(audioButton).toBeDisabled();
    fireEvent.click(audioButton);
    expect(selectionBodies()).toHaveLength(0);
  });

  it('C2 ACK 后切音轨:generation+1 → 轮询同会话 → 新代 renew 换票;零第二 resolve', async () => {
    let resolved = false;
    let renewedUrl: string | null = null;
    selectionResponder = () => {
      resolved = true;
      return jsonResponse(playbackDto({ version: 2, generation: 2 }));
    };
    onRenewed = (url) => {
      renewedUrl = url;
    };
    renderPlayer();
    await startPlayback(5);
    await waitFor(() => expect(progressBodies().length).toBeGreaterThanOrEqual(1), { timeout: 3_000 });
    await openSettings();
    const audioButton = screen.getByRole('button', { name: '评论音轨' });
    await waitFor(() => expect(audioButton).toBeEnabled(), { timeout: 3_000 });

    // 重建换轨后的会话快照(preparing→ready 由 mock 一次到位)
    statusAfterSelection = playbackDto({ version: 2, generation: 2, state: 'ready' });
    fireEvent.click(audioButton);
    await waitFor(
      () => {
        expect(renewedUrl).toBe('/api/playback/stream/sess-a/2/index.m3u8?ticket=t2');
      },
      { timeout: 5_000 },
    );
    expect(resolved).toBe(true);
    // 新代换票:expectedGeneration=换代后新代(非初始 1)
    expect(renewBodies()).toEqual([{ expectedGeneration: 2 }]);
    // 恰一会话:全程零 /playback/resolve(FR-020 末项 —— 重试/切换不产生并行会话)
    expect(resolveBodies()).toHaveLength(0);
    expect(screen.getByRole('button', { name: '评论音轨(当前)' })).toBeInTheDocument();
  });

  it('C3 CAS 冲突(409):刷新会话事实后允许重试,不自动重发提交', async () => {
    let conflicts = 0;
    selectionResponder = () => {
      conflicts += 1;
      return problemResponse(409, 'PLAYBACK_VERSION_CONFLICT');
    };
    renderPlayer();
    await startPlayback(5);
    await openSettings();
    const audioButton = screen.getByRole('button', { name: '评论音轨' });
    await waitFor(() => expect(audioButton).toBeEnabled(), { timeout: 3_000 });
    fireEvent.click(audioButton);
    await waitFor(() => expect(screen.getByTestId('playback-settings-failure').textContent).toContain('已变化'));
    expect(conflicts).toBe(1);
    // 不自动重发:仅一次提交 + 一次状态刷新 GET(共两次会话读 + 一次 PUT)
    expect(selectionBodies()).toHaveLength(1);
    // 刷新后版本回写:再次点击以新 version 提交
    const submissions: Array<Record<string, unknown>> = [];
    selectionResponder = (body) => {
      submissions.push(body);
      return jsonResponse(playbackDto({ version: 3 }));
    };
    fireEvent.click(screen.getByRole('button', { name: '评论音轨' }));
    await waitFor(() => expect(submissions).toHaveLength(1));
    expect(submissions[0]?.expectedVersion).toBe(1); // probe 快照版本(冲突刷新同值)
  });
});

// ────────────────────────── D · 直播状态呈现(FR-020 第 2 项) ──────────────────────────

describe('T028 · 直播状态文字呈现(时长 null 契约)', () => {
  it('D1 探针确认直播(时长 null):控制栏 LIVE 胶囊承载状态,画面内不再有常驻角标', async () => {
    renderPlayer({ durationSeconds: null, seekCapability: 'none' });
    await waitFor(() => expect(screen.getByTestId('player-controls')).toBeInTheDocument());
    // 产品要求:画面内的「正在直播」常驻角标属过度提示,已移除;
    // 直播状态由控制栏 LIVE 胶囊给出(文字 + 非颜色手段)
    expect(screen.queryByTestId('live-status')).not.toBeInTheDocument();
    expect(screen.getByTestId('player-controls').textContent).toContain('直播');
  });

  it('D2 点播(时长已知):不渲染直播徽标(不虚构状态)', async () => {
    renderPlayer();
    await waitFor(() => expect(screen.getByTestId('playback-video')).toBeInTheDocument());
    await waitFor(() => expect(recorded().some((call) => call.url.endsWith('/sess-a') && call.init.method === 'GET')).toBe(true));
    expect(screen.queryByTestId('live-status')).not.toBeInTheDocument();
  });
});

// ────────────────────────── E · 会话身份变化重置(旧会话选择不迁移) ──────────────────────────

describe('T028 · 浮层选择随会话身份重置', () => {
  it('E1 sessionId 变化:浮层关闭、选择态清空(旧会话结果不迁移)', async () => {
    const view = render(<SessionSwapProbe />);
    await waitFor(() => expect(screen.getByTestId('session-label').textContent).toBe('sess-a'));
    fireEvent.click(screen.getByRole('button', { name: '播放设置' }));
    await waitFor(() => expect(screen.getByTestId('playback-settings')).toBeInTheDocument());
    // 切换 sessionId(会话身份变化 = 旧选择不迁移)
    view.rerender(<SessionSwapProbe sessionId="sess-b" />);
    await waitFor(() => expect(screen.queryByTestId('playback-settings')).not.toBeInTheDocument());
    await waitFor(() => expect(screen.getByTestId('session-label').textContent).toBe('sess-b'));
    // 重新打开:无旧会话残留态(默认关闭)
    fireEvent.click(screen.getByRole('button', { name: '播放设置' }));
    await waitFor(() => expect(screen.getByTestId('playback-settings')).toBeInTheDocument());
    expect(screen.getByRole('button', { name: '关闭(当前)' })).toBeInTheDocument();
  });
});

/** 会话换挂探针(直挂 PlayerView 并可重挂 sessionId;E1 专用) */
function SessionSwapProbe({ sessionId = 'sess-a' }: { readonly sessionId?: string }): ReactNode {
  // key 缺省:sessionId 变化走同一 PlayerView 实例的 props 更新(与协调器换装同形)
  return withTestQuery(
    <div>
      <span data-testid="session-label">{sessionId}</span>
      <PlayerView
        sessionId={sessionId}
        generation={1}
        playbackUrl={`/api/playback/stream/${sessionId}/1/index.m3u8?ticket=t1`}
        ticketExpiresAt="2099-01-01T00:00:00.000Z"
        delivery="hls_proxy"
        title="例牌单集"
        onExit={() => undefined}
        onTerminated={() => undefined}
        onRenew={() => undefined}
      />
    </div>,
  );
}
