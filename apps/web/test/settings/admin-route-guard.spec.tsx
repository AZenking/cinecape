import { render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { MemoryRouter, Route, Routes } from 'react-router';
import type { ReactNode } from 'react';
import {
  SettingsAccessProvider,
  useSettingsAccess,
} from '../../src/features/settings/settings-access-provider';
import { AdminRouteGuard } from '../../src/features/settings/components/AdminRouteGuard';
import type { AccountSession } from '../../src/app/session-types';
import * as sessionModule from '../../src/app/session-provider';
import { PERSONAL_PREFS_ENABLED } from '../../src/shared/feature-flags';

/** 普通成员被拦截后的回落页(个人偏好关闭时为「我的档案」) */
const MEMBER_FALLBACK = PERSONAL_PREFS_ENABLED ? '/settings/playback' : '/settings/profile';

// Mock useAppToast
const mockToastError = vi.fn();
const mockToastSuccess = vi.fn();
vi.mock('../../src/shared/ui', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    useAppToast: () => ({
      error: mockToastError,
      success: mockToastSuccess,
    }),
  };
});

function createSession(isMain: boolean): AccountSession {
  return {
    sessionId: 'test-session',
    account: { id: 'acc-1', username: 'testuser', role: 'owner' },
    activeProfile: {
      id: isMain ? 'profile-main' : 'profile-sub',
      name: isMain ? 'Main User' : 'Sub User',
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
    householdId: 'house-1',
    bootstrapRequired: false,
    profileContextVersion: 1,
  };
}

describe('T006 · SettingsAccessProvider', () => {
  function TestConsumer(): ReactNode {
    const access = useSettingsAccess();
    return (
      <div>
        <span data-testid="is-main">{String(access.isMainProfile)}</span>
        <span data-testid="is-unlocked">{String(access.isUnlocked)}</span>
        <span data-testid="status">{access.status}</span>
      </div>
    );
  }

  it('透传主档案身份: isMainProfile 为 true, isUnlocked 兼容为 true, 状态为 unlocked', () => {
    vi.spyOn(sessionModule, 'useOptionalSession').mockReturnValue({
      status: 'authenticated',
      session: createSession(true),
      needsReselection: false,
      personalCacheKey: 'k1',
      refresh: vi.fn(),
      applySession: vi.fn(),
      logout: vi.fn(),
    });

    render(
      <SettingsAccessProvider>
        <TestConsumer />
      </SettingsAccessProvider>,
    );

    expect(screen.getByTestId('is-main').textContent).toBe('true');
    expect(screen.getByTestId('is-unlocked').textContent).toBe('true');
    expect(screen.getByTestId('status').textContent).toBe('unlocked');
  });

  it('非主档案身份: isMainProfile 为 false, isUnlocked 兼容为 false, 状态为 locked', () => {
    vi.spyOn(sessionModule, 'useOptionalSession').mockReturnValue({
      status: 'authenticated',
      session: createSession(false),
      needsReselection: false,
      personalCacheKey: 'k2',
      refresh: vi.fn(),
      applySession: vi.fn(),
      logout: vi.fn(),
    });

    render(
      <SettingsAccessProvider>
        <TestConsumer />
      </SettingsAccessProvider>,
    );

    expect(screen.getByTestId('is-main').textContent).toBe('false');
    expect(screen.getByTestId('is-unlocked').textContent).toBe('false');
    expect(screen.getByTestId('status').textContent).toBe('locked');
  });

  it('会话恢复中: 状态呈现 checking', () => {
    vi.spyOn(sessionModule, 'useOptionalSession').mockReturnValue({
      status: 'restoring',
      session: null,
      needsReselection: false,
      personalCacheKey: null,
      refresh: vi.fn(),
      applySession: vi.fn(),
      logout: vi.fn(),
    });

    render(
      <SettingsAccessProvider>
        <TestConsumer />
      </SettingsAccessProvider>,
    );

    expect(screen.getByTestId('status').textContent).toBe('checking');
  });
});

describe('T007 · AdminRouteGuard', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('主管理员访问受保护路由: 允许渲染受保护内容, 不触发重定向或 Toast', () => {
    vi.spyOn(sessionModule, 'useOptionalSession').mockReturnValue({
      status: 'authenticated',
      session: createSession(true),
      needsReselection: false,
      personalCacheKey: 'k1',
      refresh: vi.fn(),
      applySession: vi.fn(),
      logout: vi.fn(),
    });

    render(
      <MemoryRouter initialEntries={['/settings/sources']}>
        <SettingsAccessProvider>
          <Routes>
            <Route
              path="/settings/sources"
              element={
                <AdminRouteGuard>
                  <div data-testid="protected-content">媒体源配置主体</div>
                </AdminRouteGuard>
              }
            />
            <Route path={MEMBER_FALLBACK} element={<div data-testid="member-fallback-page">成员设置回落页</div>} />
          </Routes>
        </SettingsAccessProvider>
      </MemoryRouter>,
    );

    expect(screen.getByTestId('protected-content')).toBeDefined();
    expect(screen.queryByTestId('member-fallback-page')).toBeNull();
    expect(mockToastError).not.toHaveBeenCalled();
  });

  it('普通成员访问受保护路由: 阻断渲染受保护内容, 触发 Toast 并重定向至个人可见设置页', async () => {
    vi.spyOn(sessionModule, 'useOptionalSession').mockReturnValue({
      status: 'authenticated',
      session: createSession(false),
      needsReselection: false,
      personalCacheKey: 'k2',
      refresh: vi.fn(),
      applySession: vi.fn(),
      logout: vi.fn(),
    });

    render(
      <MemoryRouter initialEntries={['/settings/sources']}>
        <SettingsAccessProvider>
          <Routes>
            <Route
              path="/settings/sources"
              element={
                <AdminRouteGuard>
                  <div data-testid="protected-content">媒体源配置主体</div>
                </AdminRouteGuard>
              }
            />
            <Route path={MEMBER_FALLBACK} element={<div data-testid="member-fallback-page">成员设置回落页</div>} />
          </Routes>
        </SettingsAccessProvider>
      </MemoryRouter>,
    );

    // 受保护内容不可见
    expect(screen.queryByTestId('protected-content')).toBeNull();

    // 触发轻提示与平滑重定向
    await waitFor(() => {
      expect(mockToastError).toHaveBeenCalledWith('该页面需要管理员权限');
      expect(screen.getByTestId('member-fallback-page')).toBeDefined();
    });
  });

  it('会话恢复中: 呈现加载状态, 不发生过早拦截重定向', () => {
    vi.spyOn(sessionModule, 'useOptionalSession').mockReturnValue({
      status: 'restoring',
      session: null,
      needsReselection: false,
      personalCacheKey: null,
      refresh: vi.fn(),
      applySession: vi.fn(),
      logout: vi.fn(),
    });

    render(
      <MemoryRouter initialEntries={['/settings/sources']}>
        <SettingsAccessProvider>
          <AdminRouteGuard>
            <div data-testid="protected-content">媒体源配置主体</div>
          </AdminRouteGuard>
        </SettingsAccessProvider>
      </MemoryRouter>,
    );

    expect(screen.queryByTestId('protected-content')).toBeNull();
    expect(mockToastError).not.toHaveBeenCalled();
  });
});
