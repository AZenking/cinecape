/**
 * 路由注册表(T010;005 Phase 2 公共骨架)。
 *
 * 公共地址(ui.md §1,不建立 /catalog 等旧路由别名):
 * - `/`、`/vod`、`/media/:id`、`/live`、`/live/guide` —— 全部挂 PublicLayout,
 *   本阶段渲染占位页;真实页面由 T026(US1)、T067(US5)、US6 在此表接入,
 *   只改 element、不再新建布局壳。
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
import { NotFoundPage } from './NotFoundPage';
import { PlaceholderPage } from './PlaceholderPage';

export function AppRoutes(): ReactNode {
  return (
    <Routes>
      {/* 公共布局:不被 RequireSession 包裹,游客直达、刷新可加载(ui.md §1/§2) */}
      <Route element={<PublicLayout />}>
        <Route
          path="/"
          element={
            <PlaceholderPage
              title="首页"
              description="公共首页(公共直播摘要、节目单与点播入口)由 US1 T026/T027 接入。"
            />
          }
        />
        <Route
          path="/vod"
          element={
            <PlaceholderPage
              title="点播"
              description="基础点播目录(搜索/类型/分页)由 US1 T026/T028 接入。"
            />
          }
        />
        <Route
          path="/media/:id"
          element={
            <PlaceholderPage
              title="媒体详情"
              description="公共媒体详情(白名单元数据投影)由 US1 T026/T029 接入。"
            />
          }
        />
        <Route
          path="/live"
          element={
            <PlaceholderPage
              title="直播"
              description="公共直播首页(节目单入口/正在直播/即将播放/分组)由 US5 T067 接入。"
            />
          }
        />
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
