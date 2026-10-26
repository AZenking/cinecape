/**
 * 顶栏身份菜单(T042;ui.md §2「右侧身份状态」逐字对照)—— 独立导出组件,
 * 由布局层(PublicLayout,US1 所有)挂载;本组件自足实现全部状态:
 *
 * - session restoring = 轻量恢复状态(不遮挡公共区);
 * - 游客 = 登录按钮(经 useAuthAction 打开统一受控弹层);
 * - 登录未选档 = 账号 + 「选择 Profile」入口(bootstrapRequired 时先首建);
 * - 已选档 = 账号 + 头像/名称菜单(切档 / 退出);
 * - 只有当前主 Profile 显示设置入口(隐藏入口不替代 API 校验,FR-005/US7;
 *   /settings 路由权限最终由服务端 API 校验)。
 */
import type { ReactNode } from 'react';
import { Button, Dropdown } from '@heroui/react';
import { useSession } from '../../app/session-provider';
import { useAuthAction } from '../../app/action-coordinator';

export function IdentityMenu(): ReactNode {
  const { status, session, logout } = useSession();
  const auth = useAuthAction();

  // 轻量恢复状态:仅文字提示,不遮挡公共区(ui.md §2)
  if (status === 'restoring') {
    return (
      <span className="text-sm text-muted" role="status">
        恢复中…
      </span>
    );
  }

  // 游客:登录入口
  if (status !== 'authenticated' || session === null) {
    return (
      <Button size="sm" variant="ghost" onPress={() => auth.startLogin()}>
        登录
      </Button>
    );
  }

  // 登录未选档:账号 + 明确的选择入口(bootstrapRequired 时协调器先引导首建)
  if (session.activeProfile === null) {
    return (
      <div className="flex items-center gap-2">
        <span className="text-sm text-muted">{session.account.username}</span>
        <Button size="sm" variant="secondary" onPress={() => auth.startProfileSelection()}>
          选择 Profile
        </Button>
        <Button size="sm" variant="ghost" onPress={() => void logout()}>
          退出
        </Button>
      </div>
    );
  }

  // 已选档:账号 + 头像/名称菜单(切档/设置/退出)
  const profile = session.activeProfile;
  return (
    <Dropdown>
      <Dropdown.Trigger className="flex items-center gap-2 rounded px-2 py-1 focus:outline-none focus-visible:ring-2 focus-visible:ring-focus">
        <span
          aria-hidden
          className="flex h-6 w-6 items-center justify-center rounded-full bg-accent text-xs text-accent-foreground"
        >
          {profile.name.slice(0, 1)}
        </span>
        <span className="text-sm">{profile.name}</span>
      </Dropdown.Trigger>
      <Dropdown.Popover placement="bottom end">
        <Dropdown.Menu
          aria-label="身份菜单"
          onAction={(key) => {
            if (key === 'switch') {
              auth.startProfileSelection();
            } else if (key === 'settings') {
              auth.startSettings('/settings/account');
            } else if (key === 'logout') {
              void logout();
            }
          }}
        >
          <Dropdown.Item id="account" isDisabled>
            {session.account.username}
          </Dropdown.Item>
          {profile.isMain ? (
            <Dropdown.Item id="settings">
              设置
            </Dropdown.Item>
          ) : null}
          <Dropdown.Item id="switch">切换 Profile</Dropdown.Item>
          <Dropdown.Item id="logout">退出登录</Dropdown.Item>
        </Dropdown.Menu>
      </Dropdown.Popover>
    </Dropdown>
  );
}

/**
 * 接线说明(由 lead 在 PublicLayout 右上插槽替换占位按钮):
 *   import { IdentityMenu } from '../features/profiles/identity-menu';
 *   …
 *   <IdentityMenu />
 * (PublicLayout 本文件由 US1 独占,本任务不改动 —— 见最终报告接线点。)
 */
