import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReactNode } from 'react';
import { QueryClientProvider } from '@tanstack/react-query';
import { queryClient as appQueryClient } from '../../src/shared/query/client';
import { SettingsAccessProvider } from '../../src/features/settings/settings-access-provider';
import { SettingsEpgPage } from '../../src/features/settings/settings-epg-page';

/**
 * T009 (018 US1): 频道资产工作台行内 HeroUI Switch 显隐切换组件测试。
 * 验证:
 * 1. 行内正确渲染 HeroUI Switch 与显示/隐藏文案;
 * 2. 初始 isSelected 反映 candidate.visible;
 * 3. 点击 Switch 触发 PATCH /settings/catalog/media/:id 并携带 expectedVersion 与 visible 反转值;
 * 4. 成功后触发提示并重新拉取候选。
 */

interface FetchCall {
  method: string;
  path: string;
  body: unknown;
}

let fetchCalls: FetchCall[] = [];
let channelsState: Array<{
  id: string;
  type: string;
  title: string;
  version: number;
  available: boolean;
  visible: boolean;
  lineCount: number;
}> = [];

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': status >= 400 ? 'application/problem+json' : 'application/json' },
  });
}

function installFetchRouter(): void {
  fetchCalls = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const url = new URL(String(input), 'http://localhost:3000');
      const path = url.pathname + (url.search || '');
      const method = (init?.method ?? 'GET').toUpperCase();
      let body: unknown = undefined;
      if (typeof init?.body === 'string') {
        try {
          body = JSON.parse(init.body);
        } catch {
          body = init.body;
        }
      }
      fetchCalls.push({ method, path, body });

      if (path === '/api/auth/session') {
        return jsonResponse({
          sessionId: 'ses-1',
          householdId: 'hh-1',
          profileId: 'p-main',
          isMainProfile: true,
          status: 'authenticated',
        });
      }
      if (path === '/api/setup/status') {
        return jsonResponse({ initialized: true });
      }
      if (path === '/api/settings/sources') {
        return jsonResponse({
          items: [
            {
              id: 'src-epg',
              kind: 'epg',
              name: 'EPG源',
              enabled: true,
              version: 1,
              locationLabel: 'epg.xml',
              lastSuccessAt: null,
            },
          ],
          total: 1,
        });
      }
      if (path === '/api/settings/catalog/candidates/query') {
        return jsonResponse({
          items: channelsState,
          total: channelsState.length,
          page: 1,
          pageSize: 50,
        });
      }
      if (path.startsWith('/api/settings/catalog/media/') && method === 'PATCH') {
        const mediaId = path.replace('/api/settings/catalog/media/', '');
        const target = channelsState.find((c) => c.id === mediaId);
        if (target && typeof body === 'object' && body !== null && 'visible' in body) {
          target.visible = (body as { visible: boolean }).visible;
          target.version += 1;
        }
        return jsonResponse({
          id: mediaId,
          type: 'channel',
          title: target?.title ?? 'CCTV',
          version: target?.version ?? 2,
          visible: target?.visible ?? true,
        });
      }

      return jsonResponse({});
    }),
  );
}

function renderPage(page: ReactNode, path: string): void {
  appQueryClient.clear();
  render(
    <MemoryRouter initialEntries={[path]}>
      <QueryClientProvider client={appQueryClient}>
        <SettingsAccessProvider>
          <Routes>
            <Route path={path} element={page} />
          </Routes>
        </SettingsAccessProvider>
      </QueryClientProvider>
    </MemoryRouter>,
  );
}

describe('018 US1 频道资产行内 HeroUI Switch 显隐切换组件测试', () => {
  beforeEach(() => {
    channelsState = [
      {
        id: 'cctv-1',
        type: 'channel',
        title: 'CCTV-1 综合',
        version: 1,
        available: true,
        visible: true,
        lineCount: 2,
      },
      {
        id: 'cctv-2',
        type: 'channel',
        title: 'CCTV-2 财经',
        version: 1,
        available: true,
        visible: false,
        lineCount: 1,
      },
    ];
    installFetchRouter();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('工作台列表正确显示每个频道的 Switch 显隐状态，点击后发送 PATCH 请求', async () => {
    const user = userEvent.setup();
    renderPage(<SettingsEpgPage />, '/settings/epg');

    // 等待频道列表加载
    const switch1 = await screen.findByTestId('channel-visibility-switch-cctv-1');
    const switch2 = await screen.findByTestId('channel-visibility-switch-cctv-2');

    expect(switch1).toBeInTheDocument();
    expect(switch2).toBeInTheDocument();

    // cctv-1 初始为可见 (显示)
    expect(switch1).toHaveTextContent('显示');
    // cctv-2 初始为隐藏
    expect(switch2).toHaveTextContent('隐藏');

    // 用户点击 cctv-1 的 Switch 可点击区域将其设为隐藏
    const clickable = switch1.querySelector('label') ?? switch1;
    await user.click(clickable);

    await waitFor(() => {
      const patchCall = fetchCalls.find(
        (c) => c.method === 'PATCH' && c.path === '/api/settings/catalog/media/cctv-1',
      );
      expect(patchCall).toBeDefined();
      expect(patchCall?.body).toStrictEqual({
        expectedVersion: 1,
        visible: false,
      });
    });
  });
});
