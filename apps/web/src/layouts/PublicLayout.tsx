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
import { Link, Outlet } from 'react-router';
import { IdentityMenu } from '../features/profiles/identity-menu';
import { PublicNav } from '../shared/ui';

/**
 * 公共布局宽度策略(统一基准):
 * - 布局壳(**顶栏 + 内容区**)一律铺满视口,不再整体限宽 —— 三个观看页
 *   (直播/节目单/点播)都是数据密集页,统一宽度才有一致体感;
 * - 阅读型内容各自在页面内约束(`max-w-6xl` 等),而不是让整个壳变窄:
 *   这样「壳宽一致」与「内容易读」不互相牺牲。
 */
export function PublicLayout(): ReactNode {
  return (
    <div className="flex min-h-screen flex-col">
      <header className="border-b border-border bg-background/30">
        <div className="mx-auto flex h-14 w-full items-center justify-between gap-4 px-4 lg:px-6">
          <div className="flex items-center gap-6">
            <Link
              to="/"
              className="rounded text-lg font-semibold tracking-widest text-accent focus:outline-none focus-visible:ring-2 focus-visible:ring-focus"
            >
              HOME MEDIA
            </Link>
            <PublicNav />
          </div>
          {/* 登录入口插槽(ui.md §2):IdentityMenu 自足覆盖 游客=登录(restoring=轻量恢复;
              登录未选档=账号+选择 Profile;已选档=账号+头像/名称菜单,切档/设置入口/退出),
              内部经 useAuthAction 走 T043 统一受控弹层(T042/T043 交付,lead 接线)。 */}
          <IdentityMenu />
        </div>
      </header>
      <main className="mx-auto w-full flex-1 px-4 py-6 lg:px-6">
        <Outlet />
      </main>
    </div>
  );
}
