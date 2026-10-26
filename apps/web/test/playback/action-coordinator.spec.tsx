import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { MemoryRouter } from 'react-router';
import { ActionCoordinator, usePlayAction } from '../../src/app/action-coordinator';
import { SessionProvider, useSession } from '../../src/app/session-provider';
import { SettingsAccessProvider } from '../../src/features/settings/settings-access-provider';
import type { AccountSession } from '../../src/app/session-types';

function useSessionProviderStatus(): string {
  return useSession().status;
}

/**
 * T048(005 US3 前端单元测试,先 FAIL):ActionCoordinator 播放意图状态机与统一入口。
 * 权威:ui.md §3(play → authorize → prepare → playing,单一意图状态机)、
 * spec FR-011/FR-013 + US3 场景 1/3/5:
 * - 游客 play → login →(bootstrap/picker/selectionPin 需要时)→ 继续原目标起播;
 * - 取消返回原页面、清凭据、不自动播放也不重开弹层;
 * - 登录选档完成前不调用 /playback/resolve、不预取媒体;
 * - 准备中重复点击/换目标仅最新 intentId 可 authorize→prepare→playing,
 *   旧登录回调与旧准备结果不能起播其他内容。
 */

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

type MockRoute = (method: string, path: string, body: unknown) => Response | Promise<Response> | null;

let fetchMock: Mock;
let routes: MockRoute[];

beforeEach(() => {
  fetchMock = vi.fn();
  routes = [];
  vi.stubGlobal('fetch', fetchMock);
  mockApi();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

/** 路由式 fetch mock:按 (method, path) 匹配;未命中 404 problem */
function mockApi(): void {
  fetchMock.mockImplementation(async (_input: RequestInfo | URL, init?: RequestInit) => {
    const method = (init?.method ?? 'GET').toUpperCase();
    const url = String(_input);
    const path = url.startsWith('http') ? `/${url.split(/^[a-z]+:\/\/[^/]+\//i)[1] ?? ''}` : url;
    for (const route of routes) {
      const matched = await route(method, path, init?.body === undefined ? undefined : JSON.parse(String(init.body)));
      if (matched !== null && matched !== undefined) {
        return matched;
      }
    }
    return problemResponse(404, 'NOT_FOUND');
  });
}

type RouteHandler = (body: unknown, path: string) => Response | Promise<Response>;

function when(method: string, pathPattern: RegExp, handler: RouteHandler): void {
  // 后注册优先:用例级覆盖(如把 /auth/session 覆盖为 401)压过流程级缺省
  const route: RouteHandler[] = [(reqBody, path) => handler(reqBody, path)];
  routes.unshift((reqMethod, path, body) => {
    if (reqMethod !== method || !pathPattern.test(path)) {
      return null as unknown as Response;
    }
    return route[0]?.(body, path) ?? (null as unknown as Response);
  });
}

/** 已登录可选档世界:登录 → picker(单档案直选)→ 播放链路 */
function mockAuthenticatedFlow(options: { prepareState?: string } = {}): { requests: string[] } {
  const requests: string[] = [];
  when('GET', /\/auth\/session$/, () => jsonResponse(sessionFixture()));
  when('GET', /\/setup\/status$/, () => jsonResponse({ initialized: true }));
  when('POST', /\/auth\/login$/, () => jsonResponse(sessionFixture({ activeProfile: null })));
  when('GET', /\/profiles$/, () =>
    jsonResponse([{ id: 'profile-a', name: '妈妈', avatar: null, type: 'adult', isDefault: true, isMain: true, pinProtected: false, status: 'active', createdAt: '2026-10-26T00:00:00.000Z', version: 1 }]),
  );
  when('POST', /\/profiles\/profile-a\/select$/, () => jsonResponse(sessionFixture()));
  when('POST', /\/playback\/resolve$/, (body) => {
    const mediaId = (body as { mediaId: string }).mediaId;
    requests.push(`resolve:${mediaId}`);
    const suffix = mediaId === 'media-b' ? '-b' : '';
    return jsonResponse(
      { id: `session${suffix || '-a'}`, state: 'preparing', version: 1, generation: 1, desiredPaused: false, delivery: null, positionSeconds: 0, durationSeconds: null, timelineOffsetSeconds: 0, presentationStartSeconds: 0, ticketExpiresAt: null, playbackUrl: null, tracks: { audio: [], subtitles: [] } },
      201,
      { Location: `/api/playback/sessions/session${suffix || '-a'}` },
    );
  });
  when('GET', /\/playback\/sessions\/session-a$/, () => {
    requests.push('status:session-a');
    return jsonResponse({ id: 'session-a', state: options.prepareState ?? 'ready', version: 1, generation: 1, desiredPaused: false, delivery: 'hls_proxy', positionSeconds: 0, durationSeconds: 60, timelineOffsetSeconds: 0, presentationStartSeconds: 0, ticketExpiresAt: null, playbackUrl: null, tracks: { audio: [], subtitles: [] } });
  });
  when('GET', /\/playback\/sessions\/session-b$/, () => {
    requests.push('status:session-b');
    return jsonResponse({ id: 'session-b', state: 'ready', version: 1, generation: 1, desiredPaused: false, delivery: 'hls_proxy', positionSeconds: 0, durationSeconds: 60, timelineOffsetSeconds: 0, presentationStartSeconds: 0, ticketExpiresAt: null, playbackUrl: null, tracks: { audio: [], subtitles: [] } });
  });
  when('POST', /\/playback\/sessions\/session-[ab]\/renew$/, () => {
    requests.push('renew');
    return jsonResponse({ playbackUrl: `/api/playback/stream/session-x/1/index?ticket=t`, ticketExpiresAt: '2026-10-26T01:00:00.000Z', generation: 1 });
  });
  when('POST', /\/playback\/sessions\/session-[ab]\/stop$/, () => {
    requests.push('stop');
    return new Response(null, { status: 204 });
  });
  when('POST', /\/playback\/sessions\/session-[ab]\/heartbeat$/, () => new Response(null, { status: 204 }));
  return { requests };
}

/** 观察面:播放入口按钮 + 当前播放意图状态 */
function PlayProbe(): ReactNode {
  const { play, playback, close } = usePlayAction();
  const session = useSessionProviderStatus();
  return (
    <div>
      <span data-testid="session-status">{session}</span>
      <span data-testid="phase">{playback?.phase ?? '-'}</span>
      <span data-testid="target">{playback?.target.mediaId ?? '-'}</span>
      <span data-testid="intent">{String(playback?.intentId ?? '-')}</span>
      <span data-testid="url">{playback?.playbackUrl ?? '-'}</span>
      <span data-testid="message">{playback?.message ?? '-'}</span>
      <button type="button" data-testid="play-a" onClick={() => play({ mediaId: 'media-a', title: '内容A' })}>
        play-a
      </button>
      <button type="button" data-testid="play-b" onClick={() => play({ mediaId: 'media-b', title: '内容B' })}>
        play-b
      </button>
      <button type="button" data-testid="close" onClick={() => close()}>
        close
      </button>
    </div>
  );
}

function renderCoordinator(): void {
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
  );
}

const PLAYBACK_PATHS = /\/playback\/(resolve|sessions)/;

describe('T048 · 播放意图状态机与统一入口(ui.md §3 / FR-013)', () => {
  it('游客 play → 登录选档意图:选档完成前零 /playback/ 请求;选档完成后继续原目标起播', async () => {
    const { requests } = mockAuthenticatedFlow();
    // 初始会话为游客
    when('GET', /\/auth\/session$/, () => problemResponse(401, 'SESSION_INVALID'));
    renderCoordinator();
    await waitFor(() => expect(screen.getByTestId('phase').textContent).toBe('-'));

    fireEvent.click(screen.getByTestId('play-a'));

    // 游客播放:进入登录选档意图(弹层),暂不放行播放请求
    await waitFor(() => expect(screen.getByRole('dialog')).toBeVisible());
    expect(screen.getByTestId('phase').textContent).toBe('-');
    const beforeLogin = fetchMock.mock.calls.length;
    expect(fetchMock.mock.calls.slice(0, beforeLogin).some(([url]) => PLAYBACK_PATHS.test(String(url)))).toBe(false);

    // 登录 → picker → 直选(无 PIN)→ 选档成功
    fireEvent.change(screen.getByLabelText('用户名'), { target: { value: 'admin' } });
    fireEvent.change(screen.getByLabelText('密码'), { target: { value: 'password-123' } });
    fireEvent.click(screen.getByRole('button', { name: '登录' }));
    await waitFor(() => expect(screen.getByRole('heading', { name: '选择 Profile' })).toBeVisible());
    fireEvent.click(screen.getByRole('button', { name: /妈妈/ }));

    // 选档完成后:继续原目标(media-a)authorize → prepare → playing
    await waitFor(() => expect(screen.getByTestId('target').textContent).toBe('media-a'), { timeout: 3000 });
    expect(requests.filter((r) => r.startsWith('resolve:'))).toEqual(['resolve:media-a']);
    await waitFor(() => expect(screen.getByTestId('phase').textContent).toBe('playing'));
    expect(screen.getByTestId('url').textContent).toContain('/api/playback/stream/');
    // 弹层已关闭,不重开(退出动画中的挂载残留不计;以步骤内容卸载为准)
    await waitFor(() => expect(screen.queryByText('选择 Profile')).toBeNull());
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(screen.queryByText('选择 Profile')).toBeNull();
  });

  it('取消登录:清凭据、不自动播放、不重开弹层、零 /playback/ 请求', async () => {
    mockAuthenticatedFlow();
    when('GET', /\/auth\/session$/, () => problemResponse(401, 'SESSION_INVALID'));
    renderCoordinator();
    await waitFor(() => expect(screen.getByTestId('phase').textContent).toBe('-'));

    fireEvent.click(screen.getByTestId('play-a'));
    await waitFor(() => expect(screen.getByRole('dialog')).toBeVisible());
    expect(fetchMock.mock.calls.some(([url]) => PLAYBACK_PATHS.test(String(url)))).toBe(false);

    // 取消(Esc/遮罩等价于取消按钮):弹层关闭、意图清空
    fireEvent.click(screen.getByRole('button', { name: '取消' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());

    // 不自动播放:无任何 /playback/ 请求,播放面仍为空
    expect(fetchMock.mock.calls.some(([url]) => PLAYBACK_PATHS.test(String(url)))).toBe(false);
    expect(screen.getByTestId('phase').textContent).toBe('-');
    expect(screen.getByTestId('target').textContent).toBe('-');

    // 不重复弹窗:未再触发任何动作时弹层保持关闭
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('准备中换目标:仅最新 intentId 可 authorize→prepare→playing,旧准备结果不得起播', async () => {
    const { requests } = mockAuthenticatedFlow();
    renderCoordinator();
    await waitFor(() => expect(screen.getByTestId('session-status').textContent).toBe('authenticated'));

    // 连续点击 A、B:两次 play 均递增 intentId,B 覆盖 A
    fireEvent.click(screen.getByTestId('play-a'));
    fireEvent.click(screen.getByTestId('play-b'));

    await waitFor(() => expect(screen.getByTestId('target').textContent).toBe('media-b'));
    expect(requests).toContain('resolve:media-a');
    expect(requests).toContain('resolve:media-b');

    // A 的准备结果(即便 ready)不得起播:playing 面只属于 B
    await waitFor(() => expect(screen.getByTestId('phase').textContent).toBe('playing'));
    expect(screen.getByTestId('target').textContent).toBe('media-b');
    expect(screen.getByTestId('url').textContent).toContain('ticket=');
    // A 的会话被废弃:补发幂等 stop(不依赖前端也已被服务端语义覆盖,此处为客户端卫生)
    await waitFor(() => expect(requests.filter((r) => r === 'stop').length).toBeGreaterThanOrEqual(1));
  });

  it('close():关闭播放面并废弃意图(不再渲染播放器),对在途会话发出幂等 stop', async () => {
    const { requests } = mockAuthenticatedFlow();
    renderCoordinator();
    await waitFor(() => expect(screen.getByTestId('session-status').textContent).toBe('authenticated'));

    act(() => {
      fireEvent.click(screen.getByTestId('play-a'));
    });
    await waitFor(() => expect(screen.getByTestId('phase').textContent).toBe('playing'));

    act(() => {
      fireEvent.click(screen.getByTestId('close'));
    });
    await waitFor(() => expect(screen.getByTestId('phase').textContent).toBe('-'));
    expect(screen.getByTestId('target').textContent).toBe('-');
    expect(requests).toContain('stop');
  });

  it('授权拒绝(404 同形)落 unavailable:显示稳定不可播放提示,不进入 playing', async () => {
    mockAuthenticatedFlow();
    when('POST', /\/playback\/resolve$/, () => problemResponse(404, 'MEDIA_NOT_FOUND'));
    renderCoordinator();
    await waitFor(() => expect(screen.getByTestId('session-status').textContent).toBe('authenticated'));

    fireEvent.click(screen.getByTestId('play-a'));

    await waitFor(() => expect(screen.getByTestId('phase').textContent).toBe('unavailable'));
    expect(screen.getByTestId('message').textContent).not.toBe('-');
    expect(screen.getByTestId('url').textContent).toBe('-');
  });
});
