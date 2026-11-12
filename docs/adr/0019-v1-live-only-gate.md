# ADR-0019：V1「只做直播」的点播门禁

- 状态：Accepted
- 日期：2026-11-12
- 适用版本：V1.0（直播优先发布）
- 依据：项目宪章原则一（规格与证据）、原则七（频道中心制）
- 关联：[019-player-control-experience](../specs/019-player-control-experience/spec.md)

## Context

V1 的发布目标是「直播优先」：先把直播（频道、EPG、播放、切台）打磨到可交付质量，点播（NAS 媒体库、在线点播目录/搜索/追剧、观看历史）随后开放。当前代码库已完整实现点播链路，如果直接发布，用户会看到半成品入口（目录、在线搜索、观看历史），与 V1 的定位不符。

产品要求：**隐藏点播入口，但不删除任何实现**，后续开放时零成本恢复。

## Decision

引入单一前端开关 `apps/web/src/shared/feature-flags.ts`：

```ts
export const VOD_ENABLED = false;
```

关闭时仅隐藏**入口**，实现、路由定义、接口、数据模型全部保留：

| 面 | 处理 |
|---|---|
| 公共导航「点播」 | 过滤该导航项（项定义保留，`PUBLIC_NAV_ITEMS` 为单一事实源） |
| 首页「点播」卡 / 「点播观看历史」分区 | 条件不渲染（组件与查询代码保留；关闭态不发历史请求） |
| `/vod`、`/vod/titles/:titleRef`、`/media/:id` | 路由保留，重定向到 `/live` |
| 设置侧栏「NAS/点播」 | `inNav: VOD_ENABLED`（菜单隐藏，路由与配置页保留，深链仍可达） |

**不隐藏**：播放器内的点播播放路径、播放设置里的「自动播放下一集」偏好、后端点播接口与数据模型——它们不构成 v1 的用户可达入口。

## Consequences

**正**
- 发布面与 V1 定位一致；恢复点播只需把常量改回 `true`，无其它改动。
- 测试以开关/注册表派生期望值（`PUBLIC_NAV_ITEMS`、`getVisibleSettingsGroups`），翻开关不需要重写断言。

**负 / 风险**
- 门禁是**前端可见性**控制，不是授权边界：直接调用点播 API 仍可用（V1 本就不要求拦截）。若未来需要真正的权限隔离，必须由服务端策略承担（原则三），不得依赖此开关。
- 长期保留必须显式声明：若 V1 后仍不开放点播，应在后续 ADR 中重新评估该实现的存在成本（维护、测试、依赖）。
- 隐藏入口但保留实现的写法增加了「死代码」风险；由该 ADR 与规格 019 承担说明义务，避免后人误删。

## Verification

- `test/public-layout.spec.tsx`、`test/foundation-smoke.spec.tsx`（含 `/vod → /live` 重定向显式用例）、`test/home-personal-area.spec.tsx`、`test/settings/settings-nav-filter.spec.ts`、`test/settings/settings-sidebar-clean.spec.tsx`、`test/features/settings/settings-nav.spec.tsx` 均以开关为源派生期望。
- 浏览器实测：导航仅 `首页/直播`；首页无点播卡与历史分区；三条点播路由均落 `/live`；设置侧栏无「NAS/点播」且 `/settings/sources` 深链仍可用。