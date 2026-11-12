import { render, screen, within } from '@testing-library/react';
import { VOD_ENABLED } from '../../src/shared/feature-flags';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryRouter, Route, Routes } from 'react-router';
import type { AccountSession } from '../../src/app/session-types';
import * as sessionModule from '../../src/app/session-provider';
import { SettingsLayout } from '../../src/layouts/SettingsLayout';

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

function createSession(isMain: boolean, name = isMain ? '主管理员' : '家庭成员'): AccountSession {
  return {
    sessionId: 'session-clean-test',
    account: { id: 'acc-1', username: 'testuser', role: 'owner' },
    activeProfile: {
      id: isMain ? 'profile-main' : 'profile-sub',
      name,
      avatar: null,
      type: 'adult',
      isDefault: isMain,
      isMain,
      pinProtected: isMain,
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

describe('T019 · SettingsSidebarClean (013 US3)', () => {
  beforeEach(() => {
    setWideViewport();
  });

  it('普通成员视图：侧栏仅展示【个人偏好】，底部绝对无提权按钮、切换管理员入口或锁状态', () => {
    vi.spyOn(sessionModule, 'useOptionalSession').mockReturnValue({
      status: 'authenticated',
      session: createSession(false, '小明'),
      needsReselection: false,
      personalCacheKey: 'k-sub',
      refresh: vi.fn(),
      applySession: vi.fn(),
      logout: vi.fn(),
    });

    render(
      <MemoryRouter initialEntries={['/settings/playback']}>
        <Routes>
          <Route path="/settings" element={<SettingsLayout />}>
            <Route path="playback" element={<div data-testid="playback-page">播放体验页</div>} />
          </Route>
        </Routes>
      </MemoryRouter>,
    );

    const sidebar = screen.getByTestId('settings-sidebar');
    expect(sidebar).toBeInTheDocument();

    // 1. 验证仅包含个人偏好分组(我的档案入口已收敛到顶栏身份菜单,不再进侧栏)
    expect(within(sidebar).getByTestId('settings-group-personal')).toBeInTheDocument();
    expect(within(sidebar).getByText('个人偏好')).toBeInTheDocument();
    expect(within(sidebar).getByRole('option', { name: '播放体验' })).toBeInTheDocument();
    expect(within(sidebar).getByRole('option', { name: '界面外观' })).toBeInTheDocument();
    expect(within(sidebar).queryByRole('option', { name: '我的档案' })).toBeNull();

    // 2. 验证严禁展示家庭管理和账号与安全分组
    // (菜单拆分:家庭管理成员名 = IPTV 管理 / NAS/点播;原「来源管理/EPG 管理」已不复存在)
    expect(within(sidebar).queryByTestId('settings-group-household')).toBeNull();
    expect(within(sidebar).queryByTestId('settings-group-system')).toBeNull();
    expect(within(sidebar).queryByText('家庭管理')).toBeNull();
    expect(within(sidebar).queryByText('账号与安全')).toBeNull();
    expect(within(sidebar).queryByRole('option', { name: 'IPTV 管理' })).toBeNull();
    expect(within(sidebar).queryByRole('option', { name: 'NAS/点播' })).toBeNull();
    expect(within(sidebar).queryByRole('option', { name: '内容策略' })).toBeNull();
    expect(within(sidebar).queryByRole('option', { name: '设备管理' })).toBeNull();
    expect(within(sidebar).queryByRole('option', { name: '家庭设置' })).toBeNull();
    expect(within(sidebar).queryByRole('option', { name: '成员管理' })).toBeNull();
    expect(within(sidebar).queryByRole('option', { name: '账号信息' })).toBeNull();

    // 3. 验证侧栏底部纯粹性：无任何提权/解锁/切换管理员的按钮或状态提示
    // 底部唯一交互 = 退出登录入口(维护者 2026-11-06 要求;仍无任何提权/解锁按钮)
    expect(within(sidebar).getAllByRole('button')).toHaveLength(1);
    expect(within(sidebar).getByTestId('sidebar-logout')).toBeInTheDocument();
    expect(within(sidebar).queryByText(/切换至管理员/)).toBeNull();
    expect(within(sidebar).queryByText(/切换管理员/)).toBeNull();
    expect(within(sidebar).queryByText(/提权/)).toBeNull();
    expect(within(sidebar).queryByText(/解锁/)).toBeNull();
    expect(within(sidebar).queryByText(/锁定/)).toBeNull();
    expect(within(sidebar).queryByText(/升级权限/)).toBeNull();
    expect(within(sidebar).queryByTestId('settings-elevation-button')).toBeNull();
    expect(within(sidebar).queryByTestId('settings-lock-status')).toBeNull();
  });

  it('管理员视图：侧栏呈现全量设置分组，底部同样干净纯粹，无多余提权控件或锁状态', () => {
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
      <MemoryRouter initialEntries={['/settings/sources']}>
        <Routes>
          <Route path="/settings" element={<SettingsLayout />}>
            <Route path="sources" element={<div data-testid="sources-page">媒体源管理页</div>} />
          </Route>
        </Routes>
      </MemoryRouter>,
    );

    const sidebar = screen.getByTestId('settings-sidebar');
    expect(sidebar).toBeInTheDocument();

    // 1. 验证包含全部分组及对应链接(菜单拆分:家庭管理 = IPTV 管理 + NAS/点播 + 其余四项)
    expect(within(sidebar).getByTestId('settings-group-personal')).toBeInTheDocument();
    expect(within(sidebar).getByTestId('settings-group-household')).toBeInTheDocument();
    expect(within(sidebar).getByTestId('settings-group-system')).toBeInTheDocument();

    expect(within(sidebar).getByRole('option', { name: '播放体验' })).toBeInTheDocument();
    expect(within(sidebar).getByRole('option', { name: '界面外观' })).toBeInTheDocument();
    expect(within(sidebar).queryByRole('option', { name: '我的档案' })).toBeNull();
    expect(within(sidebar).getByRole('option', { name: '成员管理' })).toBeInTheDocument();
    expect(within(sidebar).getByRole('option', { name: '内容策略' })).toBeInTheDocument();
    expect(within(sidebar).getByRole('option', { name: 'IPTV 管理' })).toBeInTheDocument();
    // v1 只做直播:NAS/点播 入口隐藏(模块与路由保留)
    if (VOD_ENABLED) {
      expect(within(sidebar).getByRole('option', { name: 'NAS/点播' })).toBeInTheDocument();
    } else {
      expect(within(sidebar).queryByRole('option', { name: 'NAS/点播' })).toBeNull();
    }
    expect(within(sidebar).getByRole('option', { name: '设备管理' })).toBeInTheDocument();
    expect(within(sidebar).getByRole('option', { name: '家庭设置' })).toBeInTheDocument();
    expect(within(sidebar).getByRole('option', { name: '账号信息' })).toBeInTheDocument();

    // 2. 侧栏底部纯粹性：全量管理员下底部同样无多余提权或切换按钮
    // 底部唯一交互 = 退出登录入口(维护者 2026-11-06 要求;仍无任何提权/解锁按钮)
    expect(within(sidebar).getAllByRole('button')).toHaveLength(1);
    expect(within(sidebar).getByTestId('sidebar-logout')).toBeInTheDocument();
    expect(within(sidebar).queryByText(/切换管理员/)).toBeNull();
    expect(within(sidebar).queryByText(/提权/)).toBeNull();
    expect(within(sidebar).queryByText(/解锁/)).toBeNull();
    expect(within(sidebar).queryByTestId('settings-elevation-button')).toBeNull();
  });

  it('显式指定 isMainProfile props 时，正确响应差异化侧栏纯粹性渲染', () => {
    const { rerender } = render(
      <MemoryRouter initialEntries={['/settings/playback']}>
        <Routes>
          <Route path="/settings" element={<SettingsLayout isMainProfile={false} />}>
            <Route path="playback" element={<div data-testid="playback-page">播放体验页</div>} />
          </Route>
        </Routes>
      </MemoryRouter>,
    );

    let sidebar = screen.getByTestId('settings-sidebar');
    expect(within(sidebar).getByTestId('settings-group-personal')).toBeInTheDocument();
    expect(within(sidebar).queryByTestId('settings-group-household')).toBeNull();
    // 底部唯一交互 = 退出登录入口(维护者 2026-11-06 要求;仍无任何提权/解锁按钮)
    expect(within(sidebar).getAllByRole('button')).toHaveLength(1);
    expect(within(sidebar).getByTestId('sidebar-logout')).toBeInTheDocument();

    // 动态变更为管理员
    rerender(
      <MemoryRouter initialEntries={['/settings/playback']}>
        <Routes>
          <Route path="/settings" element={<SettingsLayout isMainProfile={true} />}>
            <Route path="playback" element={<div data-testid="playback-page">播放体验页</div>} />
          </Route>
        </Routes>
      </MemoryRouter>,
    );

    sidebar = screen.getByTestId('settings-sidebar');
    expect(within(sidebar).getByTestId('settings-group-household')).toBeInTheDocument();
    // 底部唯一交互 = 退出登录入口(维护者 2026-11-06 要求;仍无任何提权/解锁按钮)
    expect(within(sidebar).getAllByRole('button')).toHaveLength(1);
    expect(within(sidebar).getByTestId('sidebar-logout')).toBeInTheDocument();
  });
});
