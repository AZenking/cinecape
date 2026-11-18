/**
 * PublicNav · 公共导航(单一事实源)。
 *
 * 「首页 / 点播 / 直播」三个观看页入口,由 PublicLayout 顶栏与 SettingsLayout
 * 顶栏共用:设置页顶栏常驻同一组导航,可从设置直达观看页面,样式与公共观看
 * 布局完全一致(react-router NavLink 自动携带 aria-current 激活态)。
 * landmark 名称「公共导航」被 e2e(foundation-smoke / public-browse-guest /
 * online-vod-global)钉住,改名须同步。
 */
import type { ReactNode } from 'react';
import { NavLink } from 'react-router';
import { VOD_ENABLED } from '../feature-flags';

/** 公共导航全量项(单一事实源);`/` 用 end 避免所有路由都命中首页激活态 */
const ALL_NAV_ITEMS = [
  { to: '/', label: '首页', end: true, requiresVod: false },
  { to: '/vod', label: '点播', end: false, requiresVod: true },
  { to: '/live', label: '直播', end: false, requiresVod: false },
] as const;

/**
 * 当前生效的导航项:v1 只做直播时过滤掉「点播」(feature-flags.ts),
 * 项定义本身保留,翻开关即恢复;PUBLIC_NAV_ITEMS 供测试/其它调用方读取同一事实源。
 */
export const PUBLIC_NAV_ITEMS = ALL_NAV_ITEMS.filter((item) => !item.requiresVod || VOD_ENABLED);

export function PublicNav({ className = '' }: { className?: string }): ReactNode {
  return (
    <nav aria-label="公共导航" className={`flex items-center gap-4 ${className}`}>
      {PUBLIC_NAV_ITEMS.map((item) => (
        <NavLink
          key={item.to}
          to={item.to}
          end={item.end}
          className={({ isActive }) =>
            `relative rounded px-1 py-1 text-sm transition-colors hover:text-foreground focus:outline-none focus-visible:ring-2 focus-visible:ring-focus ${
              isActive
                ? 'font-medium text-foreground after:absolute after:-bottom-1 after:left-1/2 after:h-0.5 after:w-4 after:-translate-x-1/2 after:rounded-full after:bg-accent'
                : 'text-muted'
            }`
          }
        >
          {item.label}
        </NavLink>
      ))}
    </nav>
  );
}
