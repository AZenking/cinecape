import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { QueryClientProvider } from '@tanstack/react-query';
import { SettingsAccessProvider } from '../../src/features/settings/settings-access-provider';
import { SettingsUnlockGate } from '../../src/features/settings/settings-unlock-gate';
import { SettingsProfilesPage } from '../../src/features/settings/settings-profiles-page';
import { POST_IDENTITY_CHANGE_NOTICE } from '../../src/features/settings/shared/access-expiry';
import { useAppToast } from '../../src/shared/ui';
import { queryClient as appQueryClient } from '../../src/shared/query/client';
import type { ReactNode } from 'react';

/**
 * T010(006-US1,先 FAIL)· 主档案转移完成提示:window.alert → AlertDialog + Toast:
 * - 弹层正文逐字等于 POST_IDENTITY_CHANGE_NOTICE.mainProfile(文案不丢失,FR-001);
 * - 具备确认动作(浏览器 alert 的「好」等价:单一确认按钮);
 * - 确认后结果经 useAppToast 反馈,并回到首页(原 alert 后 navigate('/') 等价);
 * - 授权同步撤销(access.lock,DELETE /api/settings/access)仍发生在确认链路内。
 */

// 间谍 useAppToast:组件经共享 ui 出口取用轻反馈;这里替换为可断言的 spy
import type * as SharedUiModule from '../../src/shared/ui';

vi.mock('../../src/shared/ui', async (importOriginal) => {
  const actual = await importOriginal<typeof SharedUiModule>();
  return {
    ...actual,
    useAppToast: vi.fn(),
  };
});

vi.mocked(useAppToast).mockReturnValue({ success: vi.fn(() => 'toast-id'), error: vi.fn(() => 'toast-id') });

interface FetchCall {
  method: string;
  path: string;
}

let fetchCalls: FetchCall[] = [];

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

const MAIN = {
  id: 'p-main',
  name: '现任主',
  avatar: null,
  type: 'adult',
  isDefault: true,
  isMain: true,
  pinProtected: true,
  status: 'active',
  createdAt: '2026-01-01T00:00:00.000Z',
  version: 3,
};
const TARGET = { ...MAIN, id: 'p-target', name: '新主档案', isDefault: false, isMain: false, version: 5 };
const HOUSEHOLD = { name: '家', language: 'zh', timezone: 'Asia/Shanghai', version: 1, mainProfileVersion: 3 };

function HomeMarker(): ReactNode {
  return <div data-testid="home-marker">首页</div>;
}

function renderPage(): void {
  // T025:档案页迁移 useAppQuery/useAppMutation 后需 QueryClientProvider;
  // 变更失效固定经应用单例(hooks.ts),观察端必须挂同一实例
  appQueryClient.clear();
  render(
    <MemoryRouter initialEntries={['/settings/profiles']}>
      <QueryClientProvider client={appQueryClient}>
        <SettingsAccessProvider>
          <Routes>
            <Route path="/settings/profiles" element={
              <SettingsUnlockGate onCancel={() => undefined}>
                <SettingsProfilesPage />
              </SettingsUnlockGate>
            } />
            <Route path="/" element={<HomeMarker />} />
          </Routes>
        </SettingsAccessProvider>
      </QueryClientProvider>
    </MemoryRouter>,
  );
}

describe('T015 · 主档案转移完成提示 AlertDialog + Toast(文案不变)', () => {
  beforeEach(() => {
    fetchCalls = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
        const url = new URL(String(input), 'http://localhost:3000');
        const call: FetchCall = { method: (init?.method ?? 'GET').toUpperCase(), path: url.pathname };
        fetchCalls.push(call);
        if (call.path === '/api/settings/access') {
          if (call.method === 'DELETE') {
            return new Response(null, { status: 204 });
          }
          return jsonResponse({ unlocked: true, expiresAt: new Date(Date.now() + 15 * 60_000).toISOString() });
        }
        if (call.path === '/api/settings/profiles') {
          return jsonResponse([MAIN, TARGET]);
        }
        if (call.path === '/api/settings/household') {
          return jsonResponse(HOUSEHOLD);
        }
        if (call.path === '/api/settings/main-profile') {
          return jsonResponse({ mainProfileId: TARGET.id, mainProfileVersion: 4 });
        }
        return jsonResponse({});
      }),
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it('转移成功后弹 AlertDialog:正文逐字等于提示文案,单一确认动作', async () => {
    const user = userEvent.setup();
    renderPage();
    await user.click(await screen.findByTestId(`profile-transfer-${MAIN.id}`));
    await user.click(screen.getByRole('radio', { name: /新主档案/ }));
    await user.click(screen.getByTestId('transfer-main-open'));
    await user.type(screen.getByLabelText('主账号密码(当次验证)'), 'password-123');
    await user.click(screen.getByTestId('password-submit'));
    // 弹层出现:文案逐字一致(不再走 window.alert)
    const notice = await screen.findByTestId('identity-notice-text');
    expect(notice).toHaveTextContent(POST_IDENTITY_CHANGE_NOTICE.mainProfile);
    expect(notice.textContent).toBe(POST_IDENTITY_CHANGE_NOTICE.mainProfile);
    // 单一确认动作存在(alert 的「好」等价)
    expect(screen.getByTestId('identity-notice-confirm')).toBeVisible();
  });

  it('确认后:结果经 useAppToast 反馈(同文案)、授权撤销(DELETE access)、回首页', async () => {
    const user = userEvent.setup();
    renderPage();
    await user.click(await screen.findByTestId(`profile-transfer-${MAIN.id}`));
    await user.click(screen.getByRole('radio', { name: /新主档案/ }));
    await user.click(screen.getByTestId('transfer-main-open'));
    await user.type(screen.getByLabelText('主账号密码(当次验证)'), 'password-123');
    await user.click(screen.getByTestId('password-submit'));
    await screen.findByTestId('identity-notice-text');
    await user.click(screen.getByTestId('identity-notice-confirm'));
    // 结果经 Toast 轻反馈(与弹层同文案)
    const toast = vi.mocked(useAppToast).mock.results.at(-1)?.value;
    await waitFor(() => expect(toast?.success).toHaveBeenCalledWith(POST_IDENTITY_CHANGE_NOTICE.mainProfile));
    // 授权同步撤销仍在链路内(客户端失效态 + 服务端 DELETE)
    await waitFor(() => {
      expect(fetchCalls.some((call) => call.method === 'DELETE' && call.path === '/api/settings/access')).toBe(true);
    });
    // 回首页(原 alert 后 navigate('/'))
    await waitFor(() => expect(screen.getByTestId('home-marker')).toBeInTheDocument());
    // 弹层已关闭
    await waitFor(() => expect(screen.queryByTestId('identity-notice-text')).not.toBeInTheDocument());
  });
});
