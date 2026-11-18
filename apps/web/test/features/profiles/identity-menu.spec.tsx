import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { IdentityMenu } from '../../../src/features/profiles/identity-menu';
import * as sessionModule from '../../../src/app/session-provider';
import * as authModule from '../../../src/app/action-coordinator';
import type { AccountSession } from '../../../src/app/session-types';
import type { AuthActionApi } from '../../../src/app/action-coordinator';
import { PERSONAL_PREFS_ENABLED } from '../../../src/shared/feature-flags';

/**
 * 顶栏身份菜单入口(我的档案入口收敛):
 * - 侧栏不再渲染「我的档案」(settings-modules inNav=false),入口唯一收敛到本菜单;
 * - 本规格钉住菜单契约:已选档会话的菜单含「我的档案」项,
 *   点击经 auth.startSettings('/settings/profile') 直达档案页;
 * - 其余既有项(设置/切换 Profile/退出登录)保持不变。
 */

function createSession(isMain: boolean): AccountSession {
  return {
    sessionId: 'session-identity-menu-test',
    account: { id: 'acc-1', username: 'testuser', role: 'owner' },
    activeProfile: {
      id: isMain ? 'profile-main' : 'profile-sub',
      name: isMain ? '主管理员' : '家庭成员',
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

function mockAuthAction(): AuthActionApi {
  return {
    isOpen: false,
    step: 'idle',
    startLogin: vi.fn(),
    startProfileSelection: vi.fn(),
    startSettings: vi.fn(),
    cancel: vi.fn(),
  };
}

/** 主管理员/普通成员双角色共 用例:菜单项 → startSettings 目标路径契约 */
const NAV_CASES = [
  { isMain: true, settingsVisible: true, settingsTarget: '/settings/account' },
  {
    isMain: false,
    // 普通成员的「设置」只通向个人偏好;偏好隐藏时没有可用设置页,入口一并隐藏
    settingsVisible: PERSONAL_PREFS_ENABLED,
    settingsTarget: '/settings/playback',
  },
] as const;

describe('顶栏身份菜单 · 我的档案入口(settings/profile 入口收敛)', () => {
  for (const { isMain, settingsVisible, settingsTarget } of NAV_CASES) {
    it(`${isMain ? '主管理员' : '普通成员'}菜单含「我的档案」,点击直达 /settings/profile;「设置」目标保持 ${settingsTarget}`, async () => {
      const user = userEvent.setup();
      const auth = mockAuthAction();
      vi.spyOn(authModule, 'useOptionalAuthAction').mockReturnValue(auth);

      vi.spyOn(sessionModule, 'useOptionalSession').mockReturnValue({
        status: 'authenticated',
        session: createSession(isMain),
        needsReselection: false,
        personalCacheKey: `k-${String(isMain)}`,
        refresh: vi.fn(),
        applySession: vi.fn(),
        logout: vi.fn(),
      });

      render(
        <MemoryRouter initialEntries={['/']}>
          <IdentityMenu />
        </MemoryRouter>,
      );

      // 触发器 = 头像 + 档案名
      const trigger = screen.getByText(isMain ? '主管理员' : '家庭成员');
      await user.click(trigger);

      // 菜单含「我的档案」入口(侧栏已移除,本菜单为唯一导航入口)
      const profileItem = screen.getByRole('menuitem', { name: '我的档案' });
      expect(profileItem).toBeInTheDocument();
      await user.click(profileItem);
      expect(auth.startSettings).toHaveBeenCalledWith('/settings/profile');

      // 「设置」项:个人偏好可用时保持既有目标;隐藏时普通成员不出现空入口
      await user.click(trigger);
      const settingsItem = screen.queryByRole('menuitem', { name: '设置' });
      if (settingsVisible) {
        expect(settingsItem).not.toBeNull();
        await user.click(settingsItem!);
        expect(auth.startSettings).toHaveBeenCalledWith(settingsTarget);
      } else {
        expect(settingsItem).toBeNull();
        expect(auth.startSettings).not.toHaveBeenCalledWith('/settings/playback');
      }
    });
  }

  afterEach(() => {
    vi.restoreAllMocks();
  });
});
