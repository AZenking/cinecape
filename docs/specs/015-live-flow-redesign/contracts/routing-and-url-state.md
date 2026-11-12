# Contract: Routing & URL State (015-live-flow-redesign)

**Feature**: 直播全流程重构——即开即看、智能分流与同类切台

---

## 1. 路由体系定义

| 页面/视口 | 路由路径 | 呈现方式 | 对应手稿 |
| --- | --- | --- | --- |
| **直播首页** | `/live` | `PublicLayout` 顶级路由 | **Screen 1** |
| **分类平铺网格** | `/live/channels` | `PublicLayout` 顶级路由 | **Screen 2** |
| **EPG 节目单时间墙** | `/live/guide` | `PublicLayout` 顶级路由 | **Screen 3** |
| **播放与详情一体化页** | `/live/watch/:channelId` | `PublicLayout` 沉浸大屏路由 | **Screen 4** |

---

## 2. URL 查询参数契约

### 2.1 Screen 1: 直播首页 (`/live`)
- `q`: 可选。频道搜索关键字，用于快速筛选首页泳道。

### 2.2 Screen 2: 分类平铺网格 (`/live/channels`)
- `group`: 可选。字符串类型（如 `movie`、`sports`、`cctv`）。
  - **联动规则**：当从 Screen 1 的某个分类行末尾点击 `[全部XX频道 >]` 跳转时，URL 必定携带 `?group=:groupKey`；
  - 页面加载时自动解析该参数，并将对应分类 Tab 设为激活状态（`activeTab = group`）；
  - 若参数缺失或不存在，默认激活 `all`（全部频道）。
- `q`: 可选。字符串类型，当前分类下的频道过滤关键词。
- `view`: 可选。`grid`（默认多列网格）或 `list`（紧凑列表）。

### 2.3 Screen 3: EPG 节目单时间墙 (`/live/guide`)
- `date`: 可选。日期格式 `YYYY-MM-DD`（默认家庭时区的“今天”）。
- `from`: 可选。毫秒时间戳，时间轴窗口起点。
- `to`: 可选。毫秒时间戳，时间轴窗口终点。
- `channelPage`: 可选。频道纵向分页页码（默认第 1 页）。

### 2.4 Screen 4: 播放与详情一体化页 (`/live/watch/:channelId`)
- `:channelId`: **必选路径参数**。当前正在播放的频道唯一标识。
- `from`: 可选。标记来源页面（`live` / `channels` / `guide`），用于左上角“返回”按钮的可预测返回导航（未指定时默认返回 `/live`）。
- **动态切台参数同步**：
  - 用户在底部点击同类型频道卡片换台时，调用 `navigate('/live/watch/:newChannelId', { replace: true })`；
  - 浏览器地址栏同步无感知更新，支持用户按 `F5` 刷新或复制 URL 分享当前频道。
