/**
 * 公共布局(T010;005 Phase 2)。
 *
 * - 顶部品牌「映岬 Cinecape」回首页;左侧 首页/点播/直播 为真实 NavLink(react-router,
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
import { BrandLogo } from '../shared/ui/brand-logo';

/**
 * 公共布局宽度策略(统一基准):
 * - 布局壳(**顶栏 + 内容区**)一律铺满视口,不再整体限宽 —— 三个观看页
 *   (直播/节目单/点播)都是数据密集页,统一宽度才有一致体感;
 * - 阅读型内容各自在页面内约束(`max-w-6xl` 等),而不是让整个壳变窄:
 *   这样「壳宽一致」与「内容易读」不互相牺牲。
 */
export interface PublicLayoutProps {
  /**
   * 满屏变体:根高度锁定为一屏(dvh),内容区在页面内部滚动。
   * 供需要「铺满可视高度」的数据密集页(节目单)使用;普通阅读页保持自然高度。
   */
  readonly fill?: boolean;
}

export function PublicLayout({ fill = false }: PublicLayoutProps = {}): ReactNode {
  return (
    <div className={fill ? 'flex h-dvh min-h-0 flex-col overflow-hidden' : 'flex min-h-screen flex-col'}>
      <header className="border-b border-border bg-background/30">
        {/* 三段网格:左品牌 / 中导航(页面级居中)/ 右身份;两侧 1fr 等宽保证导航真正居中 */}
        <div className="mx-auto grid h-14 w-full grid-cols-[1fr_auto_1fr] items-center gap-4 px-4 lg:px-6">
          <div className="flex items-center justify-self-start">
            <Link
              to="/"
              aria-label="映岬 Cinecape"
              className="rounded text-lg font-semibold tracking-widest text-accent focus:outline-none focus-visible:ring-2 focus-visible:ring-focus"
            >
              <BrandLogo />
            </Link>
          </div>
          <div className="justify-self-center">
            <PublicNav />
          </div>
          {/* 登录入口插槽(ui.md §2):IdentityMenu 自足覆盖 游客=登录(restoring=轻量恢复;
              登录未选档=账号+选择 Profile;已选档=账号+头像/名称菜单,切档/设置入口/退出),
              内部经 useAuthAction 走 T043 统一受控弹层(T042/T043 交付,lead 接线)。 */}
          <div className="justify-self-end">
            <IdentityMenu />
          </div>
        </div>
      </header>
            {/* min-h-0 + flex:让「需铺满视口」的页面(节目单)能拿到确定高度并内部滚动 */}
      <main
        className={`mx-auto flex w-full flex-col px-4 py-6 lg:px-6 ${
          fill ? 'min-h-0 flex-1 overflow-hidden' : 'flex-1'
        }`}
      >
        <Outlet />
      </main>
    </div>
  );
}
