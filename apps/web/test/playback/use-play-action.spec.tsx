import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { MemoryRouter } from 'react-router';
import { ActionCoordinator } from '../../src/app/action-coordinator';
import { SettingsAccessProvider } from '../../src/features/settings/settings-access-provider';
import { SessionProvider } from '../../src/app/session-provider';
import { PlayButton, usePlayAction } from '../../src/features/playback/use-play-action';
import type { AccountSession } from '../../src/app/session-types';

/**
 * T048(005 US3 前端单元测试,先 FAIL):use-play-action 统一入口与共享 PlayButton。
 * - 所有播放入口只经同一 usePlayAction 发起(T054);
 * - 游客点击进入登录选档意图,仅选档完成后才发起 resolve;
 * - startMode 占位透传(beginning|resume;进度语义归 US4);
 * - 挂载层安全:在协调器外使用抛出明确错误(单一全局状态机,禁止旁路)。
 */

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

let fetchMock: Mock;

beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function mockReadyWorld(): { resolveBodies: Array<Record<string, unknown>> } {
  const resolveBodies: Array<Record<string, unknown>> = [];
  fetchMock.mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
    const method = (init?.method ?? 'GET').toUpperCase();
    const url = String(input);
    if (url.endsWith('/auth/session')) {
      return jsonResponse(sessionFixture());
    }
    if (url.endsWith('/playback/resolve') && method === 'POST') {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      resolveBodies.push(body);
      return jsonResponse(
        { id: 'session-a', state: 'preparing', version: 1, generation: 1, desiredPaused: false, delivery: null, positionSeconds: 0, durationSeconds: null, timelineOffsetSeconds: 0, presentationStartSeconds: 0, ticketExpiresAt: null, playbackUrl: null, tracks: { audio: [], subtitles: [] } },
        201,
      );
    }
    if (/\/playback\/sessions\/session-a$/.test(url)) {
      return jsonResponse({ id: 'session-a', state: 'ready', version: 1, generation: 1, desiredPaused: false, delivery: 'hls_proxy', positionSeconds: 0, durationSeconds: 60, timelineOffsetSeconds: 0, presentationStartSeconds: 0, ticketExpiresAt: null, playbackUrl: null, tracks: { audio: [], subtitles: [] } });
    }
    if (/\/playback\/sessions\/session-a\/renew$/.test(url)) {
      return jsonResponse({ playbackUrl: '/api/playback/stream/session-a/1/index?ticket=t', ticketExpiresAt: '2026-10-26T01:00:00.000Z', generation: 1 });
    }
    if (/\/playback\/sessions\/session-a\/(stop|heartbeat)$/.test(url)) {
      return new Response(null, { status: 204 });
    }
    return problemResponse(404, 'NOT_FOUND');
  });
  return { resolveBodies };
}

function PlayPhaseProbe(): ReactNode {
  const { playback } = usePlayAction();
  return (
    <span>
      <span data-testid="phase">{playback?.phase ?? '-'}</span>
      <span data-testid="url">{playback?.playbackUrl ?? '-'}</span>
    </span>
  );
}

describe('T048 · usePlayAction 与共享 PlayButton(T054 统一入口)', () => {
  it('PlayButton 按压 → 经统一入口发起播放:resolve 携带 mediaId 与 startMode(缺省 beginning)', async () => {
    const { resolveBodies } = mockReadyWorld();
    render(
      <MemoryRouter initialEntries={['/media/x']}>
        <SessionProvider>
          <SettingsAccessProvider>
            <ActionCoordinator>
            <PlayButton mediaId="media-a" title="影片A" />
            <PlayPhaseProbe />
            </ActionCoordinator>
          </SettingsAccessProvider>
        </SessionProvider>
      </MemoryRouter>,
    );
    await waitFor(() => expect(screen.getByRole('button', { name: '播放 影片A' })).toBeEnabled());
    fireEvent.click(screen.getByRole('button', { name: '播放 影片A' }));

    await waitFor(() => expect(resolveBodies).toHaveLength(1));
    expect(resolveBodies[0]).toEqual({ mediaId: 'media-a', startMode: 'beginning' });
    // 起播完成:进入 playing(UI 经协调器全屏播放面)
    await waitFor(() => expect(document.querySelector('[data-testid="playback-surface"]')).not.toBeNull(), { timeout: 2000 });
  });

  it('usePlayAction.play 携带 startMode=resume 透传(US4 前仅参数校验面)', async () => {
    const { resolveBodies } = mockReadyWorld();
    function Probe(): ReactNode {
      const { play } = usePlayAction();
      return (
        <button type="button" data-testid="resume-play" onClick={() => play({ mediaId: 'media-a', title: '影片A', startMode: 'resume' })}>
          resume
        </button>
      );
    }
    render(
      <MemoryRouter>
        <SessionProvider>
          <SettingsAccessProvider>
            <ActionCoordinator>
            <Probe />
            </ActionCoordinator>
          </SettingsAccessProvider>
        </SessionProvider>
      </MemoryRouter>,
    );
    await waitFor(() => expect(screen.getByTestId('resume-play')).toBeEnabled());
    fireEvent.click(screen.getByTestId('resume-play'));

    await waitFor(() => expect(resolveBodies).toHaveLength(1));
    expect(resolveBodies[0]).toEqual({ mediaId: 'media-a', startMode: 'resume' });
  });

  it('协调器外使用 usePlayAction / PlayButton 抛出明确错误(禁止第二个全局状态机旁路)', () => {
    function Bare(): ReactNode {
      usePlayAction();
      return null;
    }
    expect(() => render(<Bare />)).toThrow(/usePlayAction/);
    function BareButton(): ReactNode {
      return <PlayButton mediaId="m" title="t" />;
    }
    expect(() => render(<BareButton />)).toThrow(/usePlayAction/);
  });
});
