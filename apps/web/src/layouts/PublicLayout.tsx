/**
 * 公共布局(T010;005 Phase 2)。
 *
 * - 顶部品牌「HOME MEDIA」回首页;左侧 首页/点播/直播 为真实 NavLink(react-router,
 *   自动带 aria-current);右侧登录入口插槽 —— 本阶段为静态占位按钮,由 US2
 *   (T042 身份菜单 / T043 ActionCoordinator 统一登录意图)接管(ui.md §2)。
 * - 本布局不被 RequireSession 包裹(ui.md §1):游客直达、刷新可加载;
 *   登录/选档弹层由 T040/T043 挂在 app/providers 插槽,不在此引入会话依赖。
 * - 样式仅用 @heroui/styles 语义 token 工具类(background/foreground/muted/accent/
 *   border/focus;HEROUI-NOTES §2.4),暗色基调由根元素 dark 类 + globals.css 提供;
 *   深度响应式(768 窄窗收拢、身份菜单)归 US5/Polish,本阶段保证宽窗横排导航。
 */
import type { ReactNode } from 'react';
import { Link, NavLink, Outlet } from 'react-router';
import { Button } from '@heroui/react';

/** 公共导航项;`/` 用 end 避免所有路由都命中首页激活态 */
const NAV_ITEMS = [
  { to: '/', label: '首页', end: true },
  { to: '/vod', label: '点播', end: false },
  { to: '/live', label: '直播', end: false },
] as const;

export function PublicLayout(): ReactNode {
  return (
    <div className="flex min-h-screen flex-col">
      <header className="border-b border-border bg-black/30">
        <div className="mx-auto flex h-14 w-full max-w-6xl items-center justify-between gap-4 px-4">
          <div className="flex items-center gap-6">
            <Link
              to="/"
              className="rounded text-lg font-semibold tracking-widest text-accent focus:outline-none focus-visible:ring-2 focus-visible:ring-focus"
            >
              HOME MEDIA
            </Link>
            <nav aria-label="公共导航" className="flex items-center gap-4">
              {NAV_ITEMS.map((item) => (
                <NavLink
                  key={item.to}
                  to={item.to}
                  end={item.end}
                  className={({ isActive }) =>
                    `rounded px-1 py-1 text-sm transition-colors hover:text-foreground focus:outline-none focus-visible:ring-2 focus-visible:ring-focus ${
                      isActive ? 'font-medium text-foreground' : 'text-muted'
                    }`
                  }
                >
                  {item.label}
                </NavLink>
              ))}
            </nav>
          </div>
          {/* 登录入口插槽:US2 接管(游客=登录;restoring=轻量恢复;已选档=账号+头像/名称菜单,ui.md §2)。
              本阶段为占位按钮,不做导航(/login 旧路由已移除,登录走 T043 统一受控弹层)。 */}
          <Button
            size="sm"
            variant="ghost"
            onPress={() => {
              // US2/T043 接管:经 ActionCoordinator 打开统一登录意图弹层;本阶段不产生任何行为
            }}
          >
            登录
          </Button>
        </div>
      </header>
      <main className="mx-auto w-full max-w-6xl flex-1 px-4 py-6">
        <Outlet />
      </main>
    </div>
  );
}
