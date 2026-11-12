import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { QueryClientProvider } from '@tanstack/react-query';
import { SettingsAccessProvider } from '../../src/features/settings/settings-access-provider';
import { SettingsProfilesPage } from '../../src/features/settings/settings-profiles-page';
import { POST_IDENTITY_CHANGE_NOTICE } from '../../src/features/settings/shared/access-expiry';
import { useAppToast } from '../../src/shared/ui';
import { queryClient as appQueryClient } from '../../src/shared/query/client';
import type { ReactNode } from 'react';

/**
 * 主档案转移完成提示(设置页操作提示统一走 Toast):
 * - 转移成功即经 useAppToast.success 反馈,文案逐字等于
 *   POST_IDENTITY_CHANGE_NOTICE.mainProfile(文案不丢失,FR-001);
 * - 不再挂页面级 AlertDialog(设置页操作提示统一 Toast,AppToastRegion 挂应用
 *   根部,路由跳转/页面卸载后仍可见);
 * - 反馈后直接回首页(013:客户端无锁态,不再 DELETE /api/settings/access)。
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

vi.mocked(useAppToast).mockReturnValue({
  success: vi.fn(() => 'toast-id'),
  error: vi.fn(() => 'toast-id'),
  warning: vi.fn(() => 'toast-id'),
});

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
              <SettingsProfilesPage />
            } />
            <Route path="/" element={<HomeMarker />} />
          </Routes>
        </SettingsAccessProvider>
      </QueryClientProvider>
    </MemoryRouter>,
  );
}

async function transferMain(): Promise<void> {
  const user = userEvent.setup();
  await user.click(await screen.findByTestId(`profile-transfer-${MAIN.id}`));
  await user.click(screen.getByRole('radio', { name: /新主档案/ }));
  await user.click(screen.getByTestId('transfer-main-open'));
  await user.type(screen.getByLabelText('主账号密码(当次验证)'), 'password-123');
  await user.click(screen.getByTestId('password-submit'));
}

describe('主档案转移完成提示(设置页操作提示统一走 Toast)', () => {
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

  it('转移成功即出 Toast:文案逐字等于提示文案,不再挂页面级 AlertDialog', async () => {
    renderPage();
    await transferMain();
    const toast = vi.mocked(useAppToast).mock.results.at(-1)?.value;
    await waitFor(() => expect(toast?.success).toHaveBeenCalledWith(POST_IDENTITY_CHANGE_NOTICE.mainProfile));
    // 页面级确认弹层已移除(设置页操作提示统一走 Toast)
    expect(screen.queryByTestId('identity-notice-text')).not.toBeInTheDocument();
    expect(screen.queryByTestId('identity-notice-confirm')).not.toBeInTheDocument();
  });

  it('反馈后直接回首页(013:客户端无锁态,不再 DELETE access)', async () => {
    renderPage();
    await transferMain();
    // 013(ADR-0017):客户端无锁态可翻 —— 不再调用 DELETE /api/settings/access,
    // 授权事实由服务端主档案转移事务收敛;完成提示经 Toast 后直接回首页
    expect(fetchCalls.some((call) => call.method === 'DELETE' && call.path === '/api/settings/access')).toBe(false);
    await waitFor(() => expect(screen.getByTestId('home-marker')).toBeInTheDocument());
  });
});
