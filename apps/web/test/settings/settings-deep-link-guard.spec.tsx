import { render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryRouter, useLocation } from 'react-router';
import { QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import type { AccountSession } from '../../src/app/session-types';
import * as sessionModule from '../../src/app/session-provider';
import { AppRoutes } from '../../src/app/routes';
import { queryClient } from '../../src/shared/query/client';

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

function LocationProbe(): ReactNode {
  const { pathname } = useLocation();
  return <span data-testid="current-location">{pathname}</span>;
}

function setWideViewport(): void {
  vi.stubGlobal(
    'matchMedia',
    vi.fn().mockImplementation((query: string) => ({
      matches: query.includes('min-width'),
      media: query,
      onchange: null,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })),
  );
}

function createSession(isMain: boolean, name = isMain ? '主管理员' : '普通成员'): AccountSession {
  return {
    sessionId: 'session-deep-link-test',
    account: { id: 'acc-1', username: 'testuser', role: 'owner' },
    activeProfile: {
      id: isMain ? 'profile-main' : 'profile-sub',
      name,
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

describe('T025 · SettingsDeepLinkGuard (013 US5)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setWideViewport();
    queryClient.clear();

    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL): Promise<Response> => {
        const url = String(input);
        if (url.includes('/api/profile/preferences')) {
          return new Response(
            JSON.stringify({
              defaultAudioLanguage: 'zh',
              defaultSubtitleLanguage: 'zh',
              autoPlayNext: true,
              themeMode: 'system',
              posterDensity: 'comfortable',
            }),
            { status: 200, headers: { 'Content-Type': 'application/json' } },
          );
        }
        if (url.includes('/api/settings/sources')) {
          return new Response(JSON.stringify({ sources: [], total: 0 }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          });
        }
        return new Response(JSON.stringify({}), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }),
    );
  });

  it('普通成员直接访问受限管理路由 /settings/sources：被 AdminRouteGuard 拦截，弹出友好 Toast 并平滑重定向至 /settings/playback', async () => {
    vi.spyOn(sessionModule, 'useOptionalSession').mockReturnValue({
      status: 'authenticated',
      session: createSession(false, '子成员'),
      needsReselection: false,
      personalCacheKey: 'k-sub',
      refresh: vi.fn(),
      applySession: vi.fn(),
      logout: vi.fn(),
    });

    render(
      <QueryClientProvider client={queryClient}>
        <MemoryRouter initialEntries={['/settings/sources']}>
          <LocationProbe />
          <AppRoutes />
        </MemoryRouter>
      </QueryClientProvider>,
    );

    // 1. 验证 AdminRouteGuard 触发 Toast 提示
    await waitFor(() => {
      expect(mockToastError).toHaveBeenCalledWith('该页面需要管理员权限');
    });

    // 2. 验证受保护的媒体源页面主体未渲染
    expect(screen.queryByTestId('sources-page')).toBeNull();
    expect(screen.queryByText('添加来源')).toBeNull();

    // 3. 验证页面被平滑重定向至 /settings/playback
    await waitFor(() => {
      expect(screen.getByTestId('current-location')).toHaveTextContent('/settings/playback');
    });

    // 4. 验证播放体验设置表单正常展示
    await waitFor(() => {
      expect(screen.getByRole('heading', { name: '播放体验' })).toBeInTheDocument();
      expect(screen.getByTestId('switch-autoplay-next')).toBeInTheDocument();
    });
  });

  it('普通成员深链接直接访问其他受保护路由（如 /settings/policy, /settings/iptv, /settings/devices, /settings/general, /settings/profiles）均被拦截并重定向', async () => {
    vi.spyOn(sessionModule, 'useOptionalSession').mockReturnValue({
      status: 'authenticated',
      session: createSession(false, '子成员'),
      needsReselection: false,
      personalCacheKey: 'k-sub',
      refresh: vi.fn(),
      applySession: vi.fn(),
      logout: vi.fn(),
    });

    const restrictedRoutes = [
      '/settings/policy',
      // 菜单拆分:IPTV 管理(/settings/iptv)为管理路由;旧 /settings/epg 深链在守卫内重定向
      '/settings/iptv',
      '/settings/devices',
      '/settings/general',
      '/settings/profiles',
    ];

    for (const route of restrictedRoutes) {
      mockToastError.mockClear();

      const { unmount } = render(
        <QueryClientProvider client={queryClient}>
          <MemoryRouter initialEntries={[route]}>
            <LocationProbe />
            <AppRoutes />
          </MemoryRouter>
        </QueryClientProvider>,
      );

      await waitFor(() => {
        expect(mockToastError).toHaveBeenCalledWith('该页面需要管理员权限');
        expect(screen.getByTestId('current-location')).toHaveTextContent('/settings/playback');
      });

      unmount();
    }
  });

  it('主管理员深链接访问 /settings/sources(NAS/点播):正常进入并允许渲染管理主体,零拦截且不触发错误 Toast', async () => {
    vi.spyOn(sessionModule, 'useOptionalSession').mockReturnValue({
      status: 'authenticated',
      session: createSession(true, '主管理员'),
      needsReselection: false,
      personalCacheKey: 'k-main',
      refresh: vi.fn(),
      applySession: vi.fn(),
      logout: vi.fn(),
    });

    render(
      <QueryClientProvider client={queryClient}>
        <MemoryRouter initialEntries={['/settings/sources']}>
          <LocationProbe />
          <AppRoutes />
        </MemoryRouter>
      </QueryClientProvider>,
    );

    // 验证未被重定向
    expect(screen.getByTestId('current-location')).toHaveTextContent('/settings/sources');
    expect(mockToastError).not.toHaveBeenCalled();

    // 验证面包屑指示为当前模块(菜单拆分:sources 键标题 = NAS/点播)
    await waitFor(() => {
      expect(screen.getByTestId('settings-current-module')).toHaveTextContent('NAS/点播');
    });
  });
});
