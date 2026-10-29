import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';

/**
 * 引擎边界 mock:jsdom 无媒体实现,video.js 对不可加载 src 会异步抛 error →
 * onFatalError → playing→unavailable(视频分支被替换)。本规格断言的是 Modal
 * 结构保证(挂载存活/路由不掉/防误关),非引擎行为 —— 模块边界替换 video.js
 * 为无副作用假引擎(video-player.tsx 的「无媒体环境兜底」语义同源)。
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
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { Link, MemoryRouter, Route, Routes } from 'react-router';
import { ActionCoordinator } from '../../src/app/action-coordinator';
import { SettingsAccessProvider } from '../../src/features/settings/settings-access-provider';
import { SessionProvider } from '../../src/app/session-provider';
import { usePlayAction } from '../../src/features/playback/use-play-action';
import type { AccountSession } from '../../src/app/session-types';

/**
 * 规格 009(playback-modal)SC-101/102:播放面 Modal 化的结构性保证 ——
 * - SC-101 路由切换不掉:playing 态下经 Link 导航到其他路由,playback-surface
 *   仍挂载、video 元素存活(协调器位于路由树之外,弹层随协调器状态存活);
 * - SC-102 遮罩不关闭:isDismissable=false,点击遮罩后 surface 仍在;
 *   「退出」按钮触发后 surface 卸载(统一 close 路径)。
 */

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function sessionFixture(): AccountSession {
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

function mockReadyWorld(): void {
  fetchMock.mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
    const method = (init?.method ?? 'GET').toUpperCase();
    const url = String(input);
    if (url.endsWith('/auth/session')) {
      return jsonResponse(sessionFixture());
    }
    if (url.endsWith('/playback/resolve') && method === 'POST') {
      return jsonResponse(
        { id: 'session-a', state: 'preparing', version: 1, generation: 1, desiredPaused: false, delivery: 'hls_proxy', positionSeconds: 0, durationSeconds: null, timelineOffsetSeconds: 0, presentationStartSeconds: 0, ticketExpiresAt: null, playbackUrl: null, tracks: { audio: [], subtitles: [] } },
        201,
      );
    }
    if (/\/playback\/sessions\/session-a$/.test(url)) {
      return jsonResponse({ id: 'session-a', state: 'ready', version: 1, generation: 1, desiredPaused: false, delivery: 'hls_proxy', positionSeconds: 0, durationSeconds: 60, timelineOffsetSeconds: 0, presentationStartSeconds: 0, ticketExpiresAt: null, playbackUrl: null, tracks: { audio: [], subtitles: [] } });
    }
    if (/\/playback\/sessions\/session-a\/renew$/.test(url)) {
      return jsonResponse({ playbackUrl: '/api/playback/stream/session-a/1/index?ticket=t', ticketExpiresAt: '2099-01-01T00:00:00.000Z', generation: 1 });
    }
    if (/\/playback\/sessions\/session-a\/(stop|heartbeat)$/.test(url)) {
      return new Response(null, { status: 204 });
    }
    return jsonResponse({});
  });
}

function PlayProbe(): ReactNode {
  const { play } = usePlayAction();
  return (
    <button type="button" data-testid="start-play" onClick={() => play({ mediaId: 'media-a', title: '影片A' })}>
      start
    </button>
  );
}

function renderAppAt(initialPath: string): void {
  render(
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
    </MemoryRouter>,
  );
}

async function startPlayback(): Promise<void> {
  await waitFor(() => expect(screen.getByTestId('start-play')).toBeEnabled());
  fireEvent.click(screen.getByTestId('start-play'));
  await waitFor(() => expect(document.querySelector('[data-testid="playback-surface"]')).not.toBeNull(), { timeout: 2000 });
  await waitFor(() => expect(document.querySelector('video')).not.toBeNull(), { timeout: 2000 });
  // 标题层级 h2(维持 e2e surfaceTitle 的 heading level 2 契约)
  const heading = document.querySelector('[data-testid="playback-surface"] h2');
  expect(heading?.textContent).toBe('影片A');
}

describe('009 · 播放面 Modal 化(全局弹层 · 路由切换不掉)', () => {
  it('SC-101: playing 态路由切换(Link 导航)后 Modal 仍挂载、video 元素存活', async () => {
    mockReadyWorld();
    renderAppAt('/');
    await startPlayback();

    // 路由切换:home → vod → live(导航链接在 Modal 下层仍可聚焦/按压)
    fireEvent.click(screen.getByTestId('nav-vod'));
    await waitFor(() => expect(screen.getByTestId('page-vod')).not.toBeNull());
    expect(document.querySelector('[data-testid="playback-surface"]')).not.toBeNull();
    expect(document.querySelector('video')).not.toBeNull();

    fireEvent.click(screen.getByTestId('nav-live'));
    await waitFor(() => expect(screen.getByTestId('page-live')).not.toBeNull());
    expect(document.querySelector('[data-testid="playback-surface"]')).not.toBeNull();
    expect(document.querySelector('video')).not.toBeNull();
  });

  it('SC-102: 非模态结构——无遮罩层、外部内容无 inert/aria-hidden 包装;「退出」走统一路径', async () => {
    mockReadyWorld();
    renderAppAt('/');
    await startPlayback();

    // 非模态(009 修正「设置入口没了」):不渲染全视口遮罩层,
    // 弹层外内容(导航)不被打 aria-hidden/inert —— 页面保持可点可用
    expect(document.querySelector('.modal__backdrop')).toBeNull();
    // 导航链接本体不被 inert(点击/聚焦不被浏览器禁用) —— 设置入口可用的硬保证
    const navHome = document.querySelector('[data-testid="nav-home"]');
    expect(navHome?.getAttribute('inert')).toBeNull();
    expect(navHome?.hasAttribute('aria-hidden')).toBe(false);
    // 祖先链无整页 aria-hidden 包装(读屏可见导航与设置入口)
    expect(navHome?.closest('[aria-hidden="true"]')).toBeNull();

    // Esc 无 dismiss 通道(非模态);播放面保持
    fireEvent.keyDown(document.body, { key: 'Escape' });
    expect(document.querySelector('[data-testid="playback-surface"]')).not.toBeNull();
    expect(document.querySelector('video')).not.toBeNull();

    // 显式退出:统一 close 路径 → surface 卸载
    fireEvent.click(screen.getByRole('button', { name: '退出播放' }));
    await waitFor(() => expect(document.querySelector('[data-testid="playback-surface"]')).toBeNull());
  });
});
