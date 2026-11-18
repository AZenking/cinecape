/**
 * 路由注册表(T010 公共骨架;T026 接入 US1 页面;T086 接入 US7 设置布局)。
 *
 * 公共地址(ui.md §1,不建立 /catalog 等旧路由别名):
 * - `/` → HomePage(T027 公共区)、`/vod` → VodCatalogPage(T028;010 T033 扩展
 *   媒体库/在线搜索切换)、`/vod/titles/:titleRef` → OnlineVodDetailPage(010
 *   T033 在线预览/选集)、`/media/:id` → MediaDetailPage(T029;010 T033 稳定
 *   父详情)—— 全部挂 PublicLayout,只改 element、不再新建布局壳;
 * - `/live`、`/live/guide` —— 直播和 guide 路由由 US5/US6 填充;
 *   T002(015)追加:`/live/channels` → ChannelGridPage(US3/T019 分类平铺网格,
 *   Screen 2;?group/?q/?view URL 状态)与 `/live/watch/:channelId` → LiveWatchPage
 *   (US4/T014 播放与详情一体化页,Screen 4)挂同一 PublicLayout;
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
import { ChannelGridPage } from '../features/live/pages/ChannelGridPage';
import { LiveWatchPage } from '../features/live/pages/LiveWatchPage';
import { GuidePage } from '../features/epg/GuidePage';
import { ProgrammeDetailPage } from '../features/shared-programme/ProgrammeDetailPage';
import { AdminRouteGuard } from '../features/settings/components/AdminRouteGuard';
import { SettingsAccountPage } from '../features/settings/settings-account-page';
import { SettingsAppearancePage } from '../features/settings/settings-appearance-page';
import { SettingsDevicesPage } from '../features/settings/settings-devices-page';
import { SettingsIptvPage } from '../features/settings/settings-iptv-page';
import { SettingsGeneralPage } from '../features/settings/settings-general-page';
import { SettingsPlaybackPage } from '../features/settings/settings-playback-page';
import { SettingsPolicyPage } from '../features/settings/settings-policy-page';
import { SettingsProfilePage } from '../features/settings/settings-profile-page';
import { SettingsProfilesPage } from '../features/settings/settings-profiles-page';
import { SettingsNasVodSourcesPage } from '../features/settings/settings-sources-page';
import { NotFoundPage } from './NotFoundPage';
import { PERSONAL_PREFS_ENABLED, VOD_ENABLED } from '../shared/feature-flags';

export function AppRoutes(): ReactNode {
  return (
    <Routes>
      {/* 公共布局:不被 RequireSession 包裹,游客直达、刷新可加载(ui.md §1/§2) */}
      <Route element={<PublicLayout />}>
        <Route path="/" element={<HomePage />} />
        {/* v1 只做直播(feature-flags.ts):点播内容页路由保留,关闭时重定向到 /live。
            翻开关即恢复原组件,不删除页面实现。 */}
        <Route path="/vod" element={VOD_ENABLED ? <VodCatalogPage /> : <Navigate to="/live" replace />} />
        {/* 010 T033(US1):在线点播临时详情(预览/选集);物化成功跳稳定 /media/:id,
            失败不跳;游客可看、不发个人请求(contracts/ui.md §1) */}
        <Route
          path="/vod/titles/:titleRef"
          element={VOD_ENABLED ? <OnlineVodDetailPage /> : <Navigate to="/live" replace />}
        />
        <Route path="/media/:id" element={VOD_ENABLED ? <MediaDetailPage /> : <Navigate to="/live" replace />} />
        {/* T067(US5):直播首页(自然高度) */}
        <Route path="/live" element={<LivePage />} />
        {/* T002(015):/live/channels 分类平铺网格(US3/T019,Screen 2;Screen 1 行尾
            「全部XX频道」直达并携带 ?group= Tab 高亮参数);/live/watch/:channelId
            播放与详情一体化页(US4/T014,Screen 4;ChannelTile 文字区导航目标) */}
        <Route path="/live/channels" element={<ChannelGridPage />} />
        <Route path="/live/watch/:channelId" element={<LiveWatchPage />} />
        {/* 节目单详情页(非直播节目):直播/频道库点节目时,now 直接起播,其余进本页 */}
        <Route path="/live/programmes/:channelId" element={<ProgrammeDetailPage />} />
        {/* 未知路由:可回首页的 404,不重定向(ui.md §1) */}
        <Route path="*" element={<NotFoundPage />} />
      </Route>
      {/* 满屏布局变体:节目单(EPG)铺满一屏高度,墙内滚动(普通页仍自然高度) */}
      <Route element={<PublicLayout fill />}>
        <Route path="/live/guide" element={<GuidePage />} />
      </Route>
      {/* 设置布局:职责分离,不嵌套 PublicLayout(T086;ui.md §1 /settings/*) */}
      <Route path="/settings" element={<SettingsLayout />}>
        {/* 默认设置模块:/settings/account */}
        <Route index element={<Navigate to="/settings/account" replace />} />
        <Route path="account" element={<SettingsAccountPage />} />

        {/* 个人偏好模块: 零门禁直达 (013 US1 / T010)
            v1 暂未接入生效链路(feature-flags.PERSONAL_PREFS_ENABLED=false):
            入口隐藏,深链重定向到「我的档案」;页面组件与接口保留,翻开关即恢复。 */}
        <Route
          path="playback"
          element={PERSONAL_PREFS_ENABLED ? <SettingsPlaybackPage /> : <Navigate to="/settings/profile" replace />}
        />
        <Route
          path="appearance"
          element={PERSONAL_PREFS_ENABLED ? <SettingsAppearancePage /> : <Navigate to="/settings/profile" replace />}
        />
        <Route path="profile" element={<SettingsProfilePage />} />

        {/* 管理路由: 受 AdminRouteGuard 保护拦截 (013 US5 / T027) */}
        <Route element={<AdminRouteGuard />}>
          {/* IPTV 管理:直播源 / EPG 来源 / 频道匹配 三标签(菜单拆分;?tab= 深链) */}
          <Route path="iptv" element={<SettingsIptvPage />} />
          {/* 旧 EPG 管理深链:重定向到 IPTV 管理的 EPG 来源标签(旧地址簿续) */}
          <Route path="epg" element={<Navigate to="/settings/iptv?tab=epg" replace />} />
          <Route path="sources" element={<SettingsNasVodSourcesPage />} />
          <Route path="policy" element={<SettingsPolicyPage />} />
          <Route path="devices" element={<SettingsDevicesPage />} />
          <Route path="general" element={<SettingsGeneralPage />} />
          <Route path="profiles" element={<SettingsProfilesPage />} />
        </Route>

        {/* /settings 下未知子路径:同样经布局回 404(不静默重定向到 account) */}
        <Route path="*" element={<NotFoundPage />} />
      </Route>
    </Routes>
  );
}
