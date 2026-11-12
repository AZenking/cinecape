import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryRouter, Route, Routes } from 'react-router';
import { QueryClientProvider } from '@tanstack/react-query';
import { AppToastRegion } from '../../src/shared/ui';
import { queryClient as appQueryClient } from '../../src/shared/query/client';
import * as sessionModule from '../../src/app/session-provider';
import type { AccountSession } from '../../src/app/session-types';
import { SettingsAccountPage } from '../../src/features/settings/settings-account-page';
import { SettingsProfilesPage } from '../../src/features/settings/settings-profiles-page';
import { SettingsAccessProvider } from '../../src/features/settings/settings-access-provider';
import { POST_IDENTITY_CHANGE_NOTICE } from '../../src/features/settings/shared/access-expiry';

/**
 * T022 · 针对高危资产破坏操作的单次密码底线防御测试 (013 US4)
 *
 * 覆盖：
 * 1. 修改主账号密码：必须提供当前旧密码 (currentPassword)，缺省或校验失败不发网络请求或提示错误并保留表单；
 * 2. 提交修改密码时完整传递 currentPassword 并妥善处理 403/401 响应；
 * 3. 校验通过时服务端返回 204，提示使用新密码重新登录；
 * 4. 档案注销/停用高危破坏操作：二次弹窗确认，强制要求输入当次主账号密码。
 */

function createSession(isMain = true): AccountSession {
  return {
    sessionId: 'session-sensitive-test-id',
    account: { id: 'acc-1', username: 'owner_user', role: 'owner' },
    activeProfile: {
      id: isMain ? 'profile-main' : 'profile-sub',
      name: isMain ? '主管理员' : '普通家庭成员',
      avatar: null,
      type: 'adult',
      isDefault: isMain,
      isMain,
      pinProtected: false,
      status: 'active',
      createdAt: '2026-01-01T00:00:00Z',
      version: 1,
    },
    expiresAt: '2026-12-31T23:59:59Z',
    householdId: 'hh-1',
    bootstrapRequired: false,
    profileContextVersion: 1,
  };
}

function mockSessionValue(isMain = true) {
  return {
    status: 'authenticated' as const,
    session: createSession(isMain),
    needsReselection: false,
    personalCacheKey: 'admin-cache-key',
    refresh: vi.fn(),
    applySession: vi.fn(),
    logout: vi.fn(),
  };
}

interface CapturedRequest {
  url: string;
  method: string;
  body: unknown;
}

let capturedRequests: CapturedRequest[] = [];
let mockPasswordChangeResponse: { status: number; body?: unknown } = { status: 204 };
let mockProfilePatchResponse: { status: number; body?: unknown } = { status: 200, body: {} };

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': status >= 400 ? 'application/problem+json' : 'application/json' },
  });
}

function installFetchMock(): void {
  capturedRequests = [];
  mockPasswordChangeResponse = { status: 204 };
  mockProfilePatchResponse = { status: 200, body: {} };

  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const url = String(input);
      const method = (init?.method ?? 'GET').toUpperCase();
      let body: Record<string, unknown> | null = null;
      if (init?.body) {
        try {
          body = JSON.parse(String(init.body)) as Record<string, unknown>;
        } catch {
          body = { raw: String(init.body) };
        }
      }
      capturedRequests.push({ url, method, body });

      if (url.includes('/settings/account/password')) {
        if (mockPasswordChangeResponse.status === 204) {
          return new Response(null, { status: 204 });
        }
        return jsonResponse(mockPasswordChangeResponse.body, mockPasswordChangeResponse.status);
      }

      if (url.includes('/settings/account')) {
        return jsonResponse({
          id: 'acc-1',
          username: 'owner_user',
          role: 'owner',
        });
      }

      if (url.includes('/settings/household')) {
        return jsonResponse({
          id: 'hh-1',
          name: '我的家庭',
          language: 'zh-CN',
          timezone: 'Asia/Shanghai',
          version: 1,
          mainProfileVersion: 1,
        });
      }

      if (url.includes('/settings/profiles/prof-sub') && method === 'PATCH') {
        if (mockProfilePatchResponse.status >= 400) {
          return jsonResponse(mockProfilePatchResponse.body, mockProfilePatchResponse.status);
        }
        return jsonResponse({
          id: 'prof-sub',
          name: '次要成员',
          isMain: false,
          status: body?.status ?? 'active',
          type: 'adult',
          version: 2,
          pinProtected: false,
        });
      }

      if (url.includes('/settings/profiles')) {
        return jsonResponse([
          {
            id: 'prof-main',
            name: '主管理员',
            isMain: true,
            status: 'active',
            type: 'adult',
            version: 1,
            pinProtected: true,
          },
          {
            id: 'prof-sub',
            name: '次要成员',
            isMain: false,
            status: 'active',
            type: 'adult',
            version: 1,
            pinProtected: false,
          },
        ]);
      }

      return jsonResponse({});
    }),
  );
}

function renderAccountPage() {
  return render(
    <MemoryRouter initialEntries={['/settings/account']}>
      <QueryClientProvider client={appQueryClient}>
        {/* 设置页操作提示统一走 Toast:挂区域消费模块级队列 */}
        <AppToastRegion />
        <SettingsAccessProvider>
          <Routes>
            <Route path="/settings/account" element={<SettingsAccountPage />} />
          </Routes>
        </SettingsAccessProvider>
      </QueryClientProvider>
    </MemoryRouter>,
  );
}

function renderProfilesPage() {
  return render(
    <MemoryRouter initialEntries={['/settings/profiles']}>
      <QueryClientProvider client={appQueryClient}>
        {/* 设置页操作提示统一走 Toast:挂区域消费模块级队列 */}
        <AppToastRegion />
        <SettingsAccessProvider>
          <Routes>
            <Route path="/settings/profiles" element={<SettingsProfilesPage />} />
          </Routes>
        </SettingsAccessProvider>
      </QueryClientProvider>
    </MemoryRouter>,
  );
}

describe('T022 · 高危破坏操作单次密码确认保护 (013 US4 / T022~T024)', () => {
  beforeEach(() => {
    appQueryClient.clear();
    installFetchMock();
    const sessionVal = mockSessionValue(true);
    vi.spyOn(sessionModule, 'useOptionalSession').mockReturnValue(sessionVal);
    vi.spyOn(sessionModule, 'useSession').mockReturnValue(sessionVal);
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  describe('修改主账号密码必须提供当前旧密码校验 (T022, T023)', () => {
    it('当缺少当前密码时，表单拦截提交并报错提示，不发起任何改密网络请求', async () => {
      const user = userEvent.setup();
      renderAccountPage();

      expect(await screen.findByRole('heading', { name: '修改密码' })).toBeVisible();

      const newPasswordInput = screen.getByTestId('new-password-input');
      const confirmPasswordInput = screen.getByTestId('confirm-password-input');
      const submitButton = screen.getByTestId('password-change-submit');

      await user.type(newPasswordInput, 'new-secret-password-1');
      await user.type(confirmPasswordInput, 'new-secret-password-1');

      // 当前密码为空，点击提交
      await user.click(submitButton);

      expect(await screen.findByTestId('app-toast-region')).toHaveTextContent('请完整填写当前密码与新密码');
      // 确认未发起 PUT /settings/account/password
      const pwdCalls = capturedRequests.filter((r) => r.url.includes('/settings/account/password'));
      expect(pwdCalls).toHaveLength(0);
    });

    it('当两次输入的新密码不一致或长度小于8位时，拦截提交并提示校验错误', async () => {
      const user = userEvent.setup();
      renderAccountPage();

      expect(await screen.findByRole('heading', { name: '修改密码' })).toBeVisible();

      const currentPasswordInput = screen.getByTestId('current-password-input');
      const newPasswordInput = screen.getByTestId('new-password-input');
      const confirmPasswordInput = screen.getByTestId('confirm-password-input');
      const submitButton = screen.getByTestId('password-change-submit');

      // 长度小于 8 位
      await user.type(currentPasswordInput, 'old-password-123');
      await user.type(newPasswordInput, 'short');
      await user.type(confirmPasswordInput, 'short');
      await user.click(submitButton);

      expect(await screen.findByTestId('app-toast-region')).toHaveTextContent('新密码长度须为 8~128 位');
      expect(capturedRequests.filter((r) => r.url.includes('/settings/account/password'))).toHaveLength(0);

      // 两次新密码不一致
      await user.clear(newPasswordInput);
      await user.clear(confirmPasswordInput);
      await user.type(newPasswordInput, 'valid-secret-password-1');
      await user.type(confirmPasswordInput, 'different-secret-password-2');
      await user.click(submitButton);

      expect(await screen.findByTestId('app-toast-region')).toHaveTextContent('两次输入的新密码不一致');
      expect(capturedRequests.filter((r) => r.url.includes('/settings/account/password'))).toHaveLength(0);
    });

    it('提交时完整携带 currentPassword 与 newPassword 字段', async () => {
      const user = userEvent.setup();
      renderAccountPage();

      expect(await screen.findByRole('heading', { name: '修改密码' })).toBeVisible();

      const currentPasswordInput = screen.getByTestId('current-password-input');
      const newPasswordInput = screen.getByTestId('new-password-input');
      const confirmPasswordInput = screen.getByTestId('confirm-password-input');
      const submitButton = screen.getByTestId('password-change-submit');

      await user.type(currentPasswordInput, 'old-master-pass-123');
      await user.type(newPasswordInput, 'new-master-pass-456');
      await user.type(confirmPasswordInput, 'new-master-pass-456');
      await user.click(submitButton);

      await waitFor(() => {
        const pwdCalls = capturedRequests.filter((r) => r.url.includes('/settings/account/password'));
        expect(pwdCalls).toHaveLength(1);
        expect(pwdCalls[0]?.method).toBe('PUT');
        expect(pwdCalls[0]?.body).toMatchObject({
          currentPassword: 'old-master-pass-123',
          newPassword: 'new-master-pass-456',
        });
      });
    });

    it('当前旧密码错误时后端返回 403：提示错误并保留表单已输入内容（容错不丢状态）', async () => {
      mockPasswordChangeResponse = {
        status: 403,
        body: {
          code: 'PARENT_VERIFICATION_FAILED',
          detail: '当前旧密码不正确，请重新输入',
        },
      };

      const user = userEvent.setup();
      renderAccountPage();

      expect(await screen.findByRole('heading', { name: '修改密码' })).toBeVisible();

      const currentPasswordInput = screen.getByTestId('current-password-input');
      const newPasswordInput = screen.getByTestId('new-password-input');
      const confirmPasswordInput = screen.getByTestId('confirm-password-input');
      const submitButton = screen.getByTestId('password-change-submit');

      await user.type(currentPasswordInput, 'wrong-old-password');
      await user.type(newPasswordInput, 'new-master-pass-456');
      await user.type(confirmPasswordInput, 'new-master-pass-456');
      await user.click(submitButton);

      // 断言显示了服务端返回的 403 错误信息(操作提示统一走 Toast)
      const region = await screen.findByTestId('app-toast-region');
      expect(region).toHaveTextContent('当前旧密码不正确，请重新输入');

      // 断言输入框内容保留，用户无需全量重填
      expect(currentPasswordInput).toHaveValue('wrong-old-password');
      expect(newPasswordInput).toHaveValue('new-master-pass-456');
      expect(confirmPasswordInput).toHaveValue('new-master-pass-456');
    });

    it('当前会话过期时后端返回 401：正确呈现会话已失效提示', async () => {
      mockPasswordChangeResponse = {
        status: 401,
        body: {
          code: 'SESSION_INVALID',
          detail: '会话已过期',
        },
      };

      const user = userEvent.setup();
      renderAccountPage();

      expect(await screen.findByRole('heading', { name: '修改密码' })).toBeVisible();

      await user.type(screen.getByTestId('current-password-input'), 'current-password-123');
      await user.type(screen.getByTestId('new-password-input'), 'new-master-pass-456');
      await user.type(screen.getByTestId('confirm-password-input'), 'new-master-pass-456');
      await user.click(screen.getByTestId('password-change-submit'));

      const region = await screen.findByTestId('app-toast-region');
      expect(region).toHaveTextContent('会话已失效');
    });

    it('当前旧密码正确并通过时：成功返回 204 并展示以新密码重新登录的提示', async () => {
      mockPasswordChangeResponse = { status: 204 };

      const user = userEvent.setup();
      renderAccountPage();

      expect(await screen.findByRole('heading', { name: '修改密码' })).toBeVisible();

      await user.type(screen.getByTestId('current-password-input'), 'correct-old-pass-123');
      await user.type(screen.getByTestId('new-password-input'), 'brand-new-pass-888');
      await user.type(screen.getByTestId('confirm-password-input'), 'brand-new-pass-888');
      await user.click(screen.getByTestId('password-change-submit'));

      const doneContainer = await screen.findByTestId('password-change-done');
      expect(doneContainer).toBeVisible();
      // 完成提示统一走 Toast(底部居中),面板保留「使用新密码重新登录」动作
      expect(await screen.findByTestId('app-toast-region')).toHaveTextContent(POST_IDENTITY_CHANGE_NOTICE.password);
      expect(within(doneContainer).getByRole('button', { name: '使用新密码重新登录' })).toBeVisible();
    });
  });

  describe('档案注销/停用时的二次单次密码弹窗确认 (T024)', () => {
    it('点击停用档案时弹出 PasswordConfirmModal 二次确认，取消则不发起破坏性变更', async () => {
      const user = userEvent.setup();
      renderProfilesPage();

      expect(await screen.findByTestId('profile-list')).toBeVisible();

      // 点击次要成员的停用按钮
      const disableBtn = screen.getByTestId('profile-disable-prof-sub');
      await user.click(disableBtn);

      // 断言弹出密码确认模态框
      const dialog = await screen.findByRole('dialog', { name: '停用档案「次要成员」' });
      expect(dialog).toBeVisible();
      expect(dialog).toHaveTextContent('停用后该档案不可再被选择');

      // 点击取消
      const cancelBtn = within(dialog).getByTestId('password-cancel');
      await user.click(cancelBtn);

      await waitFor(() => {
        expect(screen.queryByRole('dialog', { name: '停用档案「次要成员」' })).toBeNull();
      });

      // 验证未发起任何 PATCH 请求
      const patchCalls = capturedRequests.filter((r) => r.method === 'PATCH');
      expect(patchCalls).toHaveLength(0);
    });

    it('在模态框中输入主账号密码确认后，方才携带 ownerPassword 触发注销/停用请求', async () => {
      const user = userEvent.setup();
      renderProfilesPage();

      expect(await screen.findByTestId('profile-list')).toBeVisible();

      // 点击停用
      await user.click(screen.getByTestId('profile-disable-prof-sub'));
      const dialog = await screen.findByRole('dialog', { name: '停用档案「次要成员」' });

      // 输入主账号密码并确认
      const passwordInput = within(dialog).getByLabelText(/主账号密码/);
      await user.type(passwordInput, 'admin-master-password-1');

      const submitBtn = within(dialog).getByTestId('password-submit');
      await user.click(submitBtn);

      await waitFor(() => {
        const patchCalls = capturedRequests.filter(
          (r) => r.url.includes('/settings/profiles/prof-sub') && r.method === 'PATCH',
        );
        expect(patchCalls).toHaveLength(1);
        expect(patchCalls[0]?.body).toMatchObject({
          status: 'disabled',
          clearPin: false,
          ownerPassword: 'admin-master-password-1',
        });
      });

      // 验证页面展示成功提示
      expect(await screen.findByTestId('app-toast-region')).toHaveTextContent('档案「次要成员」已停用');
    });
  });
});
