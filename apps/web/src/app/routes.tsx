/**
 * 路由注册表(T010 公共骨架;T026 接入 US1 页面;T086 接入 US7 设置布局)。
 *
 * 公共地址(ui.md §1,不建立 /catalog 等旧路由别名):
 * - `/` → HomePage(T027 公共区)、`/vod` → VodCatalogPage(T028;010 T033 扩展
 *   媒体库/在线搜索切换)、`/vod/titles/:titleRef` → OnlineVodDetailPage(010
 *   T033 在线预览/选集)、`/media/:id` → MediaDetailPage(T029;010 T033 稳定
 *   父详情)—— 全部挂 PublicLayout,只改 element、不再新建布局壳;
 * - `/live`、`/live/guide` —— 直播和 guide 路由由 US5/US6 填充;
 * - `/settings/*` → SettingsLayout(T086):与公共观看布局职责分离(FR-028),
 *   不嵌套 PublicLayout;布局内置解锁门(最终权限由服务端 API 校验)。
 *   七个子模块全部注册,其中六个为显式占位(标注「模块内容由 US8 填充」),
 *   仅账号与安全为可导航空架(GET /api/settings/account,US8 扩展完整内容);
 * - `*` —— 未知路由:PublicLayout 内的可回首页 404(不跳转登录/档案页)。
 *
 * 旧登录优先骨架(/setup、/login、/profiles、/devices、/sources 及 RequireSession
 * 优先重定向)已整体移除,不保留兼容别名(ui.md §1「不设置长期旧路由兼容」)。
 */
import type { ReactNode } from 'react';
import { Navigate, Route, Routes } from 'react-router';
import { PublicLayout } from '../layouts/PublicLayout';
import { SettingsLayout } from '../layouts/SettingsLayout';
import { MediaDetailPage } from '../features/catalog/MediaDetailPage';
import { OnlineVodDetailPage } from '../features/catalog/OnlineVodDetailPage';
import { VodCatalogPage } from '../features/catalog/VodCatalogPage';
import { HomePage } from '../features/home/HomePage';
import { LivePage } from '../features/live/LivePage';
import { GuidePage } from '../features/epg/GuidePage';
import { SettingsAccountPage } from '../features/settings/settings-account-page';
import { SettingsModulePlaceholder } from '../features/settings/settings-module-placeholder';
import { SETTINGS_MODULES } from '../features/settings/settings-modules';
import { NotFoundPage } from './NotFoundPage';

export function AppRoutes(): ReactNode {
  return (
    <Routes>
      {/* 公共布局:不被 RequireSession 包裹,游客直达、刷新可加载(ui.md §1/§2) */}
      <Route element={<PublicLayout />}>
        <Route path="/" element={<HomePage />} />
        <Route path="/vod" element={<VodCatalogPage />} />
        {/* 010 T033(US1):在线点播临时详情(预览/选集);物化成功跳稳定 /media/:id,
            失败不跳;游客可看、不发个人请求(contracts/ui.md §1) */}
        <Route path="/vod/titles/:titleRef" element={<OnlineVodDetailPage />} />
        <Route path="/media/:id" element={<MediaDetailPage />} />
        {/* T067(US5):直播首页;T116(US6):/live/guide 挂真实 EPG 节目单页 */}
        <Route path="/live" element={<LivePage />} />
        <Route path="/live/guide" element={<GuidePage />} />
        {/* 未知路由:可回首页的 404,不重定向(ui.md §1) */}
        <Route path="*" element={<NotFoundPage />} />
      </Route>
      {/* 设置布局:职责分离,不嵌套 PublicLayout(T086;ui.md §1 /settings/*) */}
      <Route path="/settings" element={<SettingsLayout />}>
        {/* 默认设置模块:/settings/account(ui.md §1) */}
        <Route index element={<Navigate to="/settings/account" replace />} />
        <Route path="account" element={<SettingsAccountPage />} />
        {SETTINGS_MODULES.filter((module) => module.key !== 'account').map((module) => (
          <Route
            key={module.key}
            path={module.key}
            element={<SettingsModulePlaceholder moduleName={module.title} scope={module.scope ?? ''} />}
          />
        ))}
        {/* /settings 下未知子路径:同样经布局回 404(不静默重定向到 account) */}
        <Route path="*" element={<NotFoundPage />} />
      </Route>
    </Routes>
  );
}
