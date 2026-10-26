/**
 * SettingsLayout(T086,005 contracts/ui.md §1/§7 + FR-028/FR-031/FR-041)。
 *
 * - 布局与公共观看职责分离:本布局不经 PublicLayout(routes.tsx 顶层挂载);
 *   宽窗口左侧子菜单约 220px、右侧主体 min-width:0;窄窗口(768px 宽/600 高/
 *   200% 缩放断点,以 768px 媒体查询承载)折叠为菜单按钮,面包屑/标题仍显示
 *   当前模块;
 * - 七个子模块导航全部注册(SETTINGS_MODULES 单一事实源),地址与菜单同步;
 * - 首次进入先经 SettingsUnlockGate(GET /api/settings/access),未解锁不渲染
 *   <Outlet/>(管理主体零请求;未解锁直达子模块保存目标 —— URL 不变 —— 但不预取);
 * - 403/过期立即隐藏管理主体(Provider 状态驱动),提示编辑未保存;重新验证后
 *   子模块以 reloadEpoch 重读最新现值;
 * - 「返回观看」是普通路由跳转(保留登录);独立的退出入口属身份菜单职责;
 * - 授权事实全在服务端:客户端 expiresAt 仅作提示(SettingsAccessProvider)。
 */
import { useState, type ReactNode } from 'react';
import { Link, NavLink, Outlet, useNavigate } from 'react-router';
import { Button } from '@heroui/react';
import { SettingsAccessProvider, useSettingsAccess } from '../features/settings/settings-access-provider';
import { SettingsUnlockGate } from '../features/settings/settings-unlock-gate';
import { SETTINGS_MODULES, settingsModulePath, useSettingsPageMeta } from '../features/settings/settings-modules';
import { useMediaQuery } from '../features/settings/use-media-query';

function SettingsSubmenu({ onNavigate }: { onNavigate?: () => void }): ReactNode {
  return (
    <nav aria-label="设置子菜单" className="flex flex-col gap-1">
      {SETTINGS_MODULES.map((module) => (
        <NavLink
          key={module.key}
          to={settingsModulePath(module.key)}
          onClick={onNavigate}
          className={({ isActive }) =>
            `rounded px-3 py-2 text-sm transition-colors hover:bg-surface-hover focus:outline-none focus-visible:ring-2 focus-visible:ring-focus ${
              isActive ? 'bg-surface font-medium text-foreground' : 'text-muted'
            }`
          }
        >
          {module.title}
        </NavLink>
      ))}
    </nav>
  );
}

function SettingsShell(): ReactNode {
  const navigate = useNavigate();
  const access = useSettingsAccess();
  const current = useSettingsPageMeta();
  const wide = useMediaQuery('(min-width: 768px)');
  const [menuOpen, setMenuOpen] = useState(false);

  /** 取消 PIN 输入:清凭据(门内已清)并回到原页面 —— 返回观看保留登录 */
  const handleCancel = (): void => {
    if (window.history.length > 1) {
      void navigate(-1);
    } else {
      void navigate('/');
    }
  };

  return (
    <div className="flex min-h-screen flex-col">
      <header className="border-b border-border bg-black/30">
        <div className="mx-auto flex h-14 w-full max-w-6xl items-center justify-between gap-4 px-4">
          <div className="flex min-w-0 items-center gap-2">
            {wide ? null : (
              <Button
                size="sm"
                variant="ghost"
                aria-expanded={menuOpen}
                aria-controls="settings-submenu"
                onPress={() => setMenuOpen((open) => !open)}
              >
                菜单
              </Button>
            )}
            {/* 面包屑/标题:当前模块(宽窄窗均可见,ui.md §7) */}
            <nav aria-label="设置面包屑" className="flex min-w-0 items-center gap-2 text-sm">
              <Link to="/" className="rounded text-muted hover:text-foreground focus:outline-none focus-visible:ring-2 focus-visible:ring-focus">
                返回观看
              </Link>
              <span aria-hidden className="text-muted">
                /
              </span>
              <span className="text-muted">设置</span>
              <span aria-hidden className="text-muted">
                /
              </span>
              <span className="truncate font-medium text-foreground" data-testid="settings-current-module">
                {current.title}
              </span>
            </nav>
          </div>
          {access.status === 'unlocked' && access.expiresAt !== null ? (
            <span className="shrink-0 text-xs text-muted" data-testid="settings-expires-hint">
              授权至 {access.expiresAt.slice(11, 16)}
            </span>
          ) : null}
        </div>
      </header>
      <div className="mx-auto flex w-full max-w-6xl flex-1 gap-6 px-4 py-6">
        {wide ? (
          <aside className="w-[220px] shrink-0">
            <SettingsSubmenu />
          </aside>
        ) : null}
        {!wide && menuOpen ? (
          <div id="settings-submenu" className="fixed inset-x-0 top-14 z-30 border-b border-border bg-background p-4 shadow-lg">
            <SettingsSubmenu onNavigate={() => setMenuOpen(false)} />
          </div>
        ) : null}
        <main className="min-w-0 flex-1">
          {/* 解锁门:未解锁不渲染 Outlet(管理主体零请求;目标由 URL 保存) */}
          <SettingsUnlockGate onCancel={handleCancel}>
            <Outlet />
          </SettingsUnlockGate>
        </main>
      </div>
    </div>
  );
}

export function SettingsLayout(): ReactNode {
  return (
    <SettingsAccessProvider>
      <SettingsShell />
    </SettingsAccessProvider>
  );
}
