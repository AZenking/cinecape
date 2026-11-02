/**
 * SettingsLayout(T086,005 contracts/ui.md §1/§7 + FR-028/FR-031/FR-041;012 T033 分组)。
 *
 * - 布局与公共观看职责分离:本布局不经 PublicLayout(routes.tsx 顶层挂载);
 *   宽窗口(≥900px,min-width 媒体查询)左侧子菜单约 220px、右侧主体 min-width:0;
 *   窄窗口(<900px,覆盖 768px 宽/600 高/200% 缩放场景)折叠为菜单按钮(012 T035:
 *   折叠列表限高可滚,低高度下入口可达),面包屑/标题仍显示
 *   当前模块;
 * - 012 T033(ui.md §5.1/FR-024/FR-032):左侧子菜单按组渲染 —— 个人偏好 →
 *   家庭管理 → 系统(SETTINGS_GROUPS 既定顺序);组头显示作用范围标注,家庭
 *   管理组标注「需要管理授权」;个人偏好组本期零支持项整组不渲染(Q1/SC-007,
 *   由 settingsModuleGroups() 统一隐藏空组);「关于与帮助」本期不落位(FR-025
 *   注记)。分组仅改变菜单组织与视觉,不改地址语义(七条 /settings/{key} 与
 *   默认 account 不变);解锁门行为保持既有(本布局仅展示层,判定逻辑零改动);
 * - 七个子模块导航全部注册(SETTINGS_MODULES 单一事实源,数组顺序 = 组间渲染
 *   顺序),地址与菜单同步;
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
import { UnsavedGuardProvider } from '../features/settings/shared/unsaved-guard';
import { settingsModuleGroups, settingsModulePath, useSettingsPageMeta } from '../features/settings/settings-modules';
// T033(006 US4):useMediaQuery 收编至 shared/hooks(原 features/settings/use-media-query.ts 已删除)
import { useMediaQuery } from '../shared/hooks';

/**
 * 左侧分组子菜单(012 T033,ui.md §5.1):每组一个命名 section(组头 + 成员链接)。
 * 组头作用范围标注之外、模块自身 scopeLabel 不同的成员(本期仅 general「含家庭
 * 配置(需管理授权)」)在链接下方以小字另行呈现 —— 不进入链接可访问名称,保持
 * 「链接集合 = 注册表 titles」读屏简洁。
 */
function SettingsSubmenu({ onNavigate }: { onNavigate?: () => void }): ReactNode {
  const groups = settingsModuleGroups();
  return (
    <nav aria-label="设置子菜单" className="flex flex-col gap-5">
      {groups.map((group) => (
        <section
          key={group.key}
          aria-label={group.label}
          data-testid={`settings-group-${group.key}`}
          className="flex flex-col gap-1"
        >
          <div className="flex flex-col gap-0.5 px-3 pb-1">
            <span className="text-xs font-semibold tracking-wide text-muted">{group.label}</span>
            {group.scopeLabel !== null ? (
              <span className="text-xs text-muted" data-testid={`settings-group-${group.key}-scope`}>
                {group.scopeLabel}
              </span>
            ) : null}
          </div>
          {group.modules.map((module) => {
            const hint = module.scopeLabel !== group.scopeLabel ? module.scopeLabel : null;
            return (
              <div key={module.key}>
                <NavLink
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
                {hint !== null ? <p className="px-3 text-xs text-muted">{hint}</p> : null}
              </div>
            );
          })}
        </section>
      ))}
    </nav>
  );
}

function SettingsShell(): ReactNode {
  const navigate = useNavigate();
  const access = useSettingsAccess();
  const current = useSettingsPageMeta();
  const wide = useMediaQuery('(min-width: 900px)');
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
          /* 012 T035(FR-032/ui.md §6.4):折叠列表限高为「视口高 - 头部 3.5rem(h-14)」
              并可滚动 —— 200% 缩放(有效视口高减半)或低高度窗口下,固定定位的面板
              不得把底部模块入口裁出视口(须可达);仅布局尺寸,无发明视觉值。 */
          <div
            id="settings-submenu"
            className="fixed inset-x-0 top-14 z-30 max-h-[calc(100vh-3.5rem)] overflow-y-auto border-b border-border bg-background p-4 shadow-lg"
          >
            <SettingsSubmenu onNavigate={() => setMenuOpen(false)} />
          </div>
        ) : null}
        <main className="min-w-0 flex-1">
          {/* 解锁门:未解锁不渲染 Outlet(管理主体零请求;目标由 URL 保存)。
              门内再挂布局级未保存拦截(T135:子模块切换时 Provider 不卸载,可拦截)。 */}
          <SettingsUnlockGate onCancel={handleCancel}>
            <UnsavedGuardProvider>
              <Outlet />
            </UnsavedGuardProvider>
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
