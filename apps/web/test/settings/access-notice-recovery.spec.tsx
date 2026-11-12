/**
 * 设置授权提示生命周期(013 FR-041 + 恢复清除语义):
 * - 管理请求 403(FORBIDDEN / SETTINGS_ACCESS_*)经 handleAccessLost 置真布局级提示;
 * - 此前该提示无任何清除路径(仅 /settings 布局卸载重置),用户经头像菜单切回
 *   主管理员后,提示仍与正常渲染的管理主体长期同屏,自相矛盾;
 * - 现语义:status 从非 unlocked 回到 unlocked(重新成为主管理员)即自动清除 ——
 *   与 013「重新解锁后重挂硬请求重读最新现值」一致,提示完成使命即退场。
 */
import { useEffect, useRef, type ReactNode } from 'react';
import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryRouter, Route, Routes } from 'react-router';
import type { AccountSession } from '../../src/app/session-types';
import * as sessionModule from '../../src/app/session-provider';
import { SettingsLayout } from '../../src/layouts/SettingsLayout';
import { useSettingsAccess } from '../../src/features/settings/settings-access-provider';

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
    sessionId: 'session-notice-test',
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

function sessionContext(session: AccountSession) {
  return {
    status: 'authenticated' as const,
    session,
    needsReselection: false,
    personalCacheKey: `k-${session.activeProfile?.id ?? 'none'}`,
    refresh: vi.fn(),
    applySession: vi.fn(),
    logout: vi.fn(),
  };
}

/** 挂载即模拟一次 403(handleAccessLost):复现「非主档案窗口期吃到拒绝」的场景 */
function AccessLostProbe(): ReactNode {
  const access = useSettingsAccess();
  const firedRef = useRef(false);
  useEffect(() => {
    if (firedRef.current) {
      return;
    }
    firedRef.current = true;
    access.handleAccessLost();
  }, [access]);
  return <div data-testid="access-lost-probe">probe</div>;
}

function renderSettings(): ReactNode {
  return (
    <MemoryRouter initialEntries={['/settings/playback']}>
      <Routes>
        <Route path="/settings" element={<SettingsLayout />}>
          <Route path="playback" element={<AccessLostProbe />} />
        </Route>
      </Routes>
    </MemoryRouter>
  );
}

describe('013 · 设置授权提示生命周期(SettingsAccessProvider.unsavedNotice)', () => {
  beforeEach(() => {
    setWideViewport();
  });

  it('403 提示出现后,切回主管理员(locked→unlocked)自动清除,不与正常主体长期同屏', () => {
    const sessionSpy = vi.spyOn(sessionModule, 'useOptionalSession');
    // 初始:非主档案(status=locked);probe 挂载即模拟一次管理请求 403
    sessionSpy.mockReturnValue(sessionContext(createSession(false, '小明')));
    const view = render(renderSettings());

    expect(screen.getByTestId('settings-access-lost-notice')).toBeInTheDocument();

    // 经头像菜单切回主档案:status locked→unlocked,提示应随授权恢复自动清除
    sessionSpy.mockReturnValue(sessionContext(createSession(true)));
    view.rerender(renderSettings());

    expect(screen.queryByTestId('settings-access-lost-notice')).toBeNull();
    expect(screen.getByTestId('access-lost-probe')).toBeInTheDocument();
  });

  it('保持主管理员(status 恒为 unlocked)时提示不被误清:403 后仍展示直至授权恢复', () => {
    const sessionSpy = vi.spyOn(sessionModule, 'useOptionalSession');
    sessionSpy.mockReturnValue(sessionContext(createSession(true)));
    const view = render(renderSettings());

    // 主档案会话内的 403(如 010 过渡码 SETTINGS_ACCESS_EXPIRED):无状态翻转,提示保留
    expect(screen.getByTestId('settings-access-lost-notice')).toBeInTheDocument();

    // 重渲染(status 仍 unlocked)不得误清
    view.rerender(renderSettings());
    expect(screen.getByTestId('settings-access-lost-notice')).toBeInTheDocument();
  });
});
