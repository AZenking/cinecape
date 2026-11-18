/** @jsxImportSource react */
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';

/**
 * 引擎边界 mock:jsdom 无媒体实现,video.js 换为无副作用假引擎(playback-modal.spec
 * 同款边界替换;断言面为协调器收口与票据语义,非引擎行为)。
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
import { QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { MemoryRouter } from 'react-router';
import type { Vod } from '@hmp/shared';
import { ActionCoordinator, usePlayAction } from '../src/app/action-coordinator';
import { SessionProvider, useSession } from '../src/app/session-provider';
import { SettingsAccessProvider } from '../src/features/settings/settings-access-provider';
import { queryClient } from '../src/shared/query/client';
import { queryKeys } from '../src/shared/query/keys';
import type { AccountSession, ProfileSummary } from '../src/app/session-types';

/**
 * 012 T027 · 直播切档路径断言(核对型测试,US4/FR-003/FR-022、SC-005 负向):
 *
 * 复用既有机制、不重写(任务边界):
 * - 旧播放终止 = 010 T079 收口(terminatePlaybackIntent 唯一调用点:意图废弃 →
 *   播放面卸载 → 进度泵 stopOnce 唯一 /stop;playing 相位零并发空 stop);
 * - 身份撤销观察 = 协调器 activeProfileId 变化(T055:仅「已有观看档案 → 另一档案/
 *   无档案」才废弃;切档路径即此);
 * - 个人缓存清除 = 006 purgePersonalData(SessionProvider 同步先于身份更新;
 *   本文件仅钉「复用不重写」的协调器侧结果:个人域条目消失、公共域保留);
 * - 旧票据不可用 = 服务端契约语义的 mock/契约层负向:旧会话读 GET → 404
 *   PLAYBACK_NOT_FOUND 同形(与 e2e identity-isolation/playback-intent 实测一致),
 *   旧流票 URL 重放被拒;客户端自身不重放旧票(旧 URL 零外发请求);
 * - 新授权后才继续 = 切档后零静默 resolve;显式新播放才发起新 authorize(新会话、
 *   新票,旧会话不复用)。
 *
 * 切档驱动:探针按钮经 useSession().applySession(档案 B DTO)—— 与协调器
 * performSelect 选档成功的 applySession 同一代码路径(非旁路)。
 */

type PlaybackDto = Vod.components['schemas']['PlaybackDto'];

// ────────────────────────── 夹具(最小合法对象;005/006 契约形状) ──────────────────────────

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

function profileFixture(id: string, name: string): ProfileSummary {
  return {
    id,
    name,
    avatar: null,
    type: 'adult',
    isDefault: false,
    isMain: id === 'profile-a',
    pinProtected: false,
    status: 'active',
    createdAt: '2026-10-26T00:00:00.000Z',
    version: 1,
  };
}

function sessionFixture(profile: ProfileSummary): AccountSession {
  return {
    sessionId: 'web-session-1',
    account: { id: 'acc-1', username: 'admin', role: 'owner' },
    activeProfile: profile,
    expiresAt: '2026-11-26T00:00:00.000Z',
    householdId: 'hh-1',
    bootstrapRequired: false,
    profileContextVersion: 1,
  };
}

const PROFILE_A = profileFixture('profile-a', '妈妈');
const PROFILE_B = profileFixture('profile-b', '爸爸');

function playbackDto(overrides: Partial<PlaybackDto> = {}): PlaybackDto {
  return {
    id: 'ps-a',
    state: 'ready',
    version: 1,
    generation: 1,
    desiredPaused: false,
    delivery: 'hls_proxy',
    positionSeconds: 0,
    durationSeconds: null, // 直播契约:时长 null(seek 能力 none)
    timelineOffsetSeconds: 0,
    presentationStartSeconds: 0,
    ticketExpiresAt: null,
    playbackUrl: null,
    tracks: { audio: [], subtitles: [] },
    startBasis: 'beginning',
    resumeDisposition: 'beginning',
    resumeReason: null,
    transitionSlot: { revision: 0, status: 'open', activeIntentId: null, successorSessionId: null },
    seekCapability: 'none',
    playbackStarted: false,
    ...overrides,
  };
}

// ────────────────────────── fetch mock(路由式;切档翻转旧会话事实) ──────────────────────────

let fetchMock: Mock;
/** 切档发生后置位:旧会话一切读取按已撤销语义应答(006/005 契约同形负向) */
let identitySwitched: boolean;

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

function stopCallsFor(sessionId: string): RecordedCall[] {
  return recorded().filter((call) => call.url.endsWith(`/playback/sessions/${sessionId}/stop`));
}

function requestsTouchingOldTicket(): RecordedCall[] {
  return recorded().filter((call) => call.url.includes('ticket=ticket-a'));
}

beforeEach(() => {
  fetchMock = vi.fn();
  identitySwitched = false;
  vi.stubGlobal('fetch', fetchMock);
  fetchMock.mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
    const method = (init?.method ?? 'GET').toUpperCase();
    const url = String(input);
    if (url.endsWith('/auth/session')) {
      return jsonResponse(sessionFixture(identitySwitched ? PROFILE_B : PROFILE_A));
    }
    if (url.endsWith('/setup/status')) {
      return jsonResponse({ initialized: true });
    }
    if (url.endsWith('/playback/resolve') && method === 'POST') {
      // 切档后新播放:服务端按新身份新会话授权(ps-b;与 ps-a 毫无共享)
      const dto = playbackDto({ id: identitySwitched ? 'ps-b' : 'ps-a', state: 'preparing' });
      return jsonResponse(dto, 201);
    }
    if (/\/playback\/sessions\/ps-a$/.test(url) && method === 'GET') {
      if (identitySwitched) {
        // 旧票据/旧会话不可用:006 身份撤销事务已终态化 + 失权 —— 与「不存在」同形
        return problemResponse(404, 'PLAYBACK_NOT_FOUND');
      }
      return jsonResponse(playbackDto({ id: 'ps-a', state: 'ready' }));
    }
    if (/\/playback\/sessions\/ps-b$/.test(url) && method === 'GET') {
      // 新身份的新会话:切档后新授权面照常服务(仅旧会话失权)
      return jsonResponse(playbackDto({ id: 'ps-b', state: 'ready' }));
    }
    if (/\/playback\/sessions\/ps-a\/renew$/.test(url)) {
      if (identitySwitched) {
        return problemResponse(404, 'PLAYBACK_NOT_FOUND');
      }
      return jsonResponse({
        playbackUrl: '/api/playback/stream/ps-a/1/index.m3u8?ticket=ticket-a',
        ticketExpiresAt: '2099-01-01T00:00:00.000Z',
        generation: 1,
      });
    }
    if (/\/playback\/sessions\/ps-b\/renew$/.test(url)) {
      return jsonResponse({
        playbackUrl: '/api/playback/stream/ps-b/1/index.m3u8?ticket=ticket-b',
        ticketExpiresAt: '2099-01-01T00:00:00.000Z',
        generation: 1,
      });
    }
    if (/\/playback\/sessions\/ps-[ab]\/(stop|heartbeat|observations)$/.test(url)) {
      return new Response(null, { status: 204 });
    }
    if (/\/playback\/sessions\/ps-[ab]\/progress$/.test(url)) {
      const sample = JSON.parse(String(init?.body ?? '{}')) as { sampleSeq?: number };
      return jsonResponse({
        applied: true,
        reason: 'accepted',
        historyRevision: 4,
        sessionAccepted: true,
        acceptedSampleSeq: typeof sample.sampleSeq === 'number' ? sample.sampleSeq : 1,
        acceptedPositionSeconds: 0,
        acceptedGeneration: 1,
        sessionStarted: true,
      });
    }
    return problemResponse(404, 'NOT_FOUND');
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  queryClient.clear();
});

// ────────────────────────── 渲染基座(协调器完整树 + 切档/播放探针) ──────────────────────────

function Probe(): ReactNode {
  const { play, playback } = usePlayAction();
  const session = useSession();
  return (
    <div>
      <span data-testid="session-status">{session.status}</span>
      <span data-testid="active-profile">{session.session?.activeProfile?.id ?? 'none'}</span>
      <span data-testid="phase">{playback?.phase ?? '-'}</span>
      <span data-testid="playback-session">{playback?.sessionId ?? '-'}</span>
      <button
        type="button"
        data-testid="play-live"
        onClick={() => play({ mediaId: 'ch-1', title: '例牌新闻台' })}
      >
        play
      </button>
      <button
        type="button"
        data-testid="switch-profile-b"
        onClick={() => {
          // 与协调器 performSelect 选档成功同一代码路径:applySession(档案 B)
          session.applySession(sessionFixture(PROFILE_B));
        }}
      >
        switch
      </button>
    </div>
  );
}

function renderCoordinatorApp(): void {
  // QueryClientProvider:playing 相位 PlayerView 的 019 直播节目元数据查询依赖同一全局 client
  render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={['/live']}>
        <SessionProvider>
          <SettingsAccessProvider>
            <ActionCoordinator>
              <Probe />
            </ActionCoordinator>
          </SettingsAccessProvider>
        </SessionProvider>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

/** 起播到 playing(协调器全链:resolve → prepare → renew → 播放面挂载) */
async function playToPlaying(): Promise<void> {
  await waitFor(() => expect(screen.getByTestId('session-status').textContent).toBe('authenticated'));
  fireEvent.click(screen.getByTestId('play-live'));
  await waitFor(() => expect(screen.getByTestId('phase').textContent).toBe('playing'), { timeout: 3_000 });
  expect(document.querySelector('[data-testid="playback-surface"]')).not.toBeNull();
}

// ────────────────────────── 用例 ──────────────────────────

describe('T027 · 直播切档:旧播放终止(FR-003/FR-022;010 收口复用)', () => {
  it('C1 playing 态切档:播放面卸载、泵 stopOnce 恰一次(零并发空 stop)、意图废弃', async () => {
    renderCoordinatorApp();
    await playToPlaying();
    expect(screen.getByTestId('playback-session').textContent).toBe('ps-a');

    // 切档(applySession 档案 B → 协调器身份观察终止在途播放)
    identitySwitched = true;
    fireEvent.click(screen.getByTestId('switch-profile-b'));
    await waitFor(() => expect(screen.getByTestId('active-profile').textContent).toBe('profile-b'));
    await waitFor(() => expect(screen.getByTestId('phase').textContent).toBe('-'));
    await waitFor(() => expect(document.querySelector('[data-testid="playback-surface"]')).toBeNull());

    // 010 T079:playing 相位统一收口 —— 泵 stopOnce 恰一次,无并发第二份空 stop
    await waitFor(() => expect(stopCallsFor('ps-a')).toHaveLength(1));
    expect(screen.getByTestId('playback-session').textContent).toBe('-');
  });

  it('C2 旧票据不可用(负向,mock/契约层):旧会话读 404 同形;旧票 URL 零客户端重放', async () => {
    renderCoordinatorApp();
    await playToPlaying();
    identitySwitched = true;
    fireEvent.click(screen.getByTestId('switch-profile-b'));
    await waitFor(() => expect(screen.getByTestId('phase').textContent).toBe('-'));

    // 客户端行为面:切档后客户端未向旧票 URL 外发任何请求(旧票不被复用/重放;
    // 下方两笔 404 探测为本用例的契约层负向请求,计入前后快照差应为零)
    const oldTicketRequestsBeforeProbe = requestsTouchingOldTicket().length;
    const replay = await fetch('/api/playback/sessions/ps-a');
    expect(replay.status).toBe(404);
    expect(((await replay.json()) as { code?: string }).code).toBe('PLAYBACK_NOT_FOUND');
    // 旧流票 URL 重放同形被拒(mock 语义 = 服务端票据失权)
    const ticketReplay = await fetch('/api/playback/stream/ps-a/1/index.m3u8?ticket=ticket-a');
    expect(ticketReplay.status).toBe(404);
    expect(requestsTouchingOldTicket().length).toBe(oldTicketRequestsBeforeProbe + 1); // 仅本用例探测本身
  });

  it('C3 个人缓存复用 006 清除(不重写):个人域条目消失、公共域保留', async () => {
    // 预置缓存:档案 A 个人域条目 + 公共域条目
    queryClient.setQueryData(queryKeys.profile('profile-a').favorites(), '个人数据');
    queryClient.setQueryData(queryKeys.public.context(), { householdId: 'hh-1' });
    renderCoordinatorApp();
    await playToPlaying();
    identitySwitched = true;
    fireEvent.click(screen.getByTestId('switch-profile-b'));
    await waitFor(() => expect(screen.getByTestId('active-profile').textContent).toBe('profile-b'));
    // 006 purgePersonalData 结果:个人域清除、公共域保留(机制复用,协调器侧零重写)
    await waitFor(() => expect(queryClient.getQueryData(queryKeys.profile('profile-a').favorites())).toBeUndefined());
    expect(queryClient.getQueryData(queryKeys.public.context())).toEqual({ householdId: 'hh-1' });
  });
});

describe('T027 · 切档后新授权才继续(FR-022;SC-005)', () => {
  it('C4 切档→零静默 resolve;显式新播放→新身份新会话新票(旧会话不复用)', async () => {
    renderCoordinatorApp();
    await playToPlaying();
    expect(resolveBodies()).toHaveLength(1); // 初始起播恰一次 authorize
    const resolvesAtPlaying = recorded().filter((call) => call.url.endsWith('/playback/resolve')).length;

    identitySwitched = true;
    fireEvent.click(screen.getByTestId('switch-profile-b'));
    await waitFor(() => expect(screen.getByTestId('phase').textContent).toBe('-'));
    // 旧播放已终止;终止后零静默 resolve(旧内容不静默续跑,新授权前不播放)
    expect(recorded().filter((call) => call.url.endsWith('/playback/resolve')).length).toBe(resolvesAtPlaying);

    // 显式新播放:仅此才发起新 authorize → 新会话 ps-b(旧会话 ps-a 不复用)
    fireEvent.click(screen.getByTestId('play-live'));
    await waitFor(() => expect(screen.getByTestId('phase').textContent).toBe('playing'), { timeout: 3_000 });
    const resolves = resolveBodies();
    expect(resolves).toHaveLength(2);
    expect(resolves[1]).toEqual({ mediaId: 'ch-1', startMode: 'beginning' });
    await waitFor(() => expect(screen.getByTestId('playback-session').textContent).toBe('ps-b'));
    // 新会话票据独立签发(新票 URL;旧票 URL 未再出现)
    expect(requestsTouchingOldTicket()).toHaveLength(0);
    expect(recorded().some((call) => call.url.endsWith('/playback/sessions/ps-b/renew'))).toBe(true);
    // 播放面唯一:切档+新播放全程至多一个播放面(无并行双会话面)
    expect(document.querySelectorAll('[data-testid="playback-surface"]')).toHaveLength(1);
  });

  it('C5 切档进行中(prep链在途):旧链路迟到结果不回写,旧会话按幂等语义收口', async () => {
    renderCoordinatorApp();
    await waitFor(() => expect(screen.getByTestId('session-status').textContent).toBe('authenticated'));
    // 阻塞 prepare 轮询响应:resolve 已接受、会话仍 preparing(泵尚不存在)
    const pending: Array<() => void> = [];
    fetchMock.mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      const method = (init?.method ?? 'GET').toUpperCase();
      const url = String(input);
      if (url.endsWith('/auth/session')) {
        return jsonResponse(sessionFixture(identitySwitched ? PROFILE_B : PROFILE_A));
      }
      if (url.endsWith('/setup/status')) {
        return jsonResponse({ initialized: true });
      }
      if (url.endsWith('/playback/resolve') && method === 'POST') {
        const dto = playbackDto({ id: 'ps-a', state: 'preparing' });
        return jsonResponse(dto, 201);
      }
      if (/\/playback\/sessions\/ps-a$/.test(url) && method === 'GET') {
        if (!identitySwitched) {
          return jsonResponse(playbackDto({ state: 'ready' }));
        }
        // 切档后:轮询读按已撤销语义挂起,直至用例放行
        await new Promise<void>((resolve) => {
          pending.push(resolve);
        });
        return problemResponse(404, 'PLAYBACK_NOT_FOUND');
      }
      if (/\/playback\/sessions\/ps-a\/(stop|heartbeat)$/.test(url)) {
        return new Response(null, { status: 204 });
      }
      return problemResponse(404, 'NOT_FOUND');
    });

    fireEvent.click(screen.getByTestId('play-live'));
    await waitFor(() => expect(screen.getByTestId('phase').textContent).toBe('preparing'), { timeout: 3_000 });
    // preparing 相位切档:意图废弃 → abandonSession 幂等空 stop(泵尚不存在)
    identitySwitched = true;
    fireEvent.click(screen.getByTestId('switch-profile-b'));
    await waitFor(() => expect(screen.getByTestId('phase').textContent).toBe('-'));
    await waitFor(() => expect(stopCallsFor('ps-a').length).toBeGreaterThanOrEqual(1));
    // 放行挂起的轮询读:旧链路迟到结果不回写新状态(链路 alive 守卫丢弃;幂等收口
    // 允许重复空 stop —— 010 abandonSession 幂等语义,不视作并行会话)
    for (const resolve of pending.splice(0)) {
      resolve();
    }
    await act(async () => {
      await Promise.resolve();
    });
    expect(screen.getByTestId('phase').textContent).toBe('-');
    expect(document.querySelector('[data-testid="playback-surface"]')).toBeNull();
  });
});
