/**
 * 路由注册表(T010 公共骨架;T026 接入 US1 页面)。
 *
 * 公共地址(ui.md §1,不建立 /catalog 等旧路由别名):
 * - `/` → HomePage(T027 公共区)、`/vod` → VodCatalogPage(T028)、
 *   `/media/:id` → MediaDetailPage(T029)—— 全部挂 PublicLayout,地址只用
 *   `/`、`/vod`、`/media/:id`,只改 element、不再新建布局壳;
 * - `/live`、`/live/guide` —— 直播和 guide 路由由 US5/US6 填充(占位保持);
 * - `/settings/*` —— US7 守卫插槽:SettingsLayout 与路由守卫由 US7 填充
 *   (路由守卫只做入口收敛,最终权限仍由服务端 API 校验);本阶段仅占位,
 *   不预取任何设置数据。
 * - `*` —— 未知路由:PublicLayout 内的可回首页 404(不跳转登录/档案页)。
 *
 * 旧登录优先骨架(/setup、/login、/profiles、/devices、/sources 及 RequireSession
 * 优先重定向)已整体移除,不保留兼容别名(ui.md §1「不设置长期旧路由兼容」)。
 */
import type { ReactNode } from 'react';
import { Route, Routes } from 'react-router';
import { PublicLayout } from '../layouts/PublicLayout';
import { MediaDetailPage } from '../features/catalog/MediaDetailPage';
import { VodCatalogPage } from '../features/catalog/VodCatalogPage';
import { HomePage } from '../features/home/HomePage';
import { LivePage } from '../features/live/LivePage';
import { NotFoundPage } from './NotFoundPage';
import { PlaceholderPage } from './PlaceholderPage';

export function AppRoutes(): ReactNode {
  return (
    <Routes>
      {/* 公共布局:不被 RequireSession 包裹,游客直达、刷新可加载(ui.md §1/§2) */}
      <Route element={<PublicLayout />}>
        <Route path="/" element={<HomePage />} />
        <Route path="/vod" element={<VodCatalogPage />} />
        <Route path="/media/:id" element={<MediaDetailPage />} />
        {/* T067(US5):直播首页(所有节目单入口占位→正在直播→即将播放→各分组) */}
        <Route path="/live" element={<LivePage />} />
        <Route
          path="/live/guide"
          element={
            <PlaceholderPage
              title="节目单"
              description="EPG 节目墙由 US6 接入(本占位不虚构排期数据)。"
            />
          }
        />
        <Route
          path="/settings/*"
          element={
            <PlaceholderPage
              title="设置"
              description="SettingsLayout 与路由守卫插槽由 US7 填充;最终权限由服务端校验。"
            />
          }
        />
        {/* 未知路由:可回首页的 404,不重定向(ui.md §1) */}
        <Route path="*" element={<NotFoundPage />} />
      </Route>
    </Routes>
  );
}
