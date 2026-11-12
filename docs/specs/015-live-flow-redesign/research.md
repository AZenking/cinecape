# Phase 0: Research & Architecture Decisions (015-live-flow-redesign)

**Feature**: 直播全流程重构——即开即看、智能分流与同类切台
**Input**: 用户手绘线框草图（`media_1794127889674_ebb61729.jpg`）、批注修正图（`media_1794134731713_7d429d8b.png`）及规格文档 `spec.md`

---

## R1: 手稿四大界面的布局与流转落地方案

### Context & Need
用户手绘线框图明确划分了 4 个视口（Screen 1 直播首页、Screen 2 分类网格、Screen 3 EPG 节目单墙、Screen 4 播放与详情一体化页）。必须在保持现有 HeroUI v3 规范与 React Router 架构的前提下，精准落地手稿布局。

### Decision
- **Screen 1 (`/live`)**：
  - 顶部大画幅（Hero）：手绘图顶部大框，定性为**【直接播放】**的实时大屏（Live Hero Player）。默认加载系统排位首选或热播频道直播流，支持静音起播与一键全屏/大屏展开；
  - 泳道 1（`Live` 正在直播）：横滑卡片，行尾“全部”导向 Screen 3；
  - 泳道 2（`next` 即将播放）：横滑预告卡片，展示开播时间；
  - 泳道 3~N（`Movie` / `Music` 等各分类）：手绘图对应行，逐行展示系统内各个分类（`【展示各个分类】`），行尾“全部”导向 Screen 2。
- **Screen 2 (`/live/channels?group=:groupKey`)**：
  - 手绘图 Screen 2：顶部为标题 `Live` 与横向分类 Tabs（`x x x x x`），右侧为搜索与筛选漏斗；
  - 下方为主体多列平铺网格（Card Grid），从 Screen 1 某分类跳转进入时自动激活该 Tab。
- **Screen 3 (`/live/guide`)**：
  - 手绘图 Screen 3：EPG 节目单时间墙。纵轴为频道，横轴为时间，带有倒三角与纵贯全屏的 `NOW` 垂直红线指示器；相交的当前节目点击直接起播，未来节目点击弹轻量抽屉。
- **Screen 4 (`/live/watch/:channelId`)**：
  - 手绘图 Screen 4：独立播放与详情一体化页。左侧大框为实时播放器（进入自动缓冲起播），右侧展示节目标题/副标题/进度与主操作，下方为 `sam type live`（同类型直播推荐横条）。

### Rationale
该布局严格还原了手稿的信息结构与操作动线，既保留了流媒体的沉浸大屏感，又将多分类检索、时间排期与即时消费清晰解耦。

---

## R2: 首页顶部 Hero【直接播放】与一体化播放页的协同机制

### Decision
- **Screen 1 顶部 Hero 采用“静音可播、一键声画入全屏/一体化”模式**：
  - 浏览器对于未经用户交互的音频通常会拦截 `autoplay`，因此首页顶部 Hero 挂载播放器时，默认以 `muted=true` 尝试静音自动起播（若游客未认证，优先展示高保真频道动态预览海报并提供醒目的“直接收看”按钮）；
  - 点击 Hero 正中或全屏控制，无缝切入 Screen 4 一体化大屏播放页或直接原生全屏，声音自动开启；
  - 底部频道悬停点击快速播放时，若在 PC 宽屏下，亦可直接热切换顶部 Hero 的播放流。

### Alternatives Considered
- *全静态图片 Banner*：被用户手绘与批注明确否决（用户明确批注为【直接播放】）。
- *强制弹登录才给看*：违反 ADR-0010 与宪章原则三。游客可在首页看到公共广播画面，点击核心操作或需要 Profile 策略鉴权时再唤起登录。

---

## R3: 智能分流策略：Live 直达 EPG，各分类直达分类平铺网格

### Decision
- **Live 行尾 [查看全部] → EPG 节目单墙 (`/live/guide`)**：
  - 用户查看“正在直播”全部内容时，最关心的并非静态列表，而是全网排期与时间刻度。
  - 路由直接链接到 `/live/guide`，页面启动即自动滚动并聚焦在当前时刻（`NOW` 垂直红线居中）。
- **分类行尾 [查看全部] → 分类平铺网格 (`/live/channels?group=:groupKey`)**：
  - 用户查看“电影频道”全部内容时，关注的是频道库资产与分类目录。
  - 路由携带参数（如 `/live/channels?group=movie`），Screen 2 读取 `group` 参数后，分类 Tabs 自动高亮选中该项，网格仅呈现该组频道。

### Rationale
精准对应用户手绘图上的两条箭头流向，将时间维度（Time-driven）与分类维度（Category-driven）自然分流。

---

## R4: Screen 4 下方同类型直播（`sam type live`）无缝换台机制

### Decision
- **纯客户端驱动的无刷新换台（In-Place Stream Switching）**：
  - 在 Screen 4 内部，使用 `activeChannelId` 作为受控状态；
  - 点击底部同类卡片时：
    1. 立即更新组件内部 `activeChannelId`，播放器显示轻量缓冲态并就地发起换流解析；
    2. 右侧当前节目信息与下档预告（Next）通过已有的频道详情数据即时响应式切换；
    3. 调用 `window.history.replaceState`（或 React Router 的 `setSearchParams / navigate(..., { replace: true })`）将地址栏静默更新为 `/live/watch/:newChannelId`；
    4. 整个过程**不触发页面卸载与整页重载**，给用户带来类似传统电视快速换台的行云流水体验。

### Alternatives Considered
- *调用 `navigate('/live/watch/:id')` 进行路由重跳*：会导致整个页面组件销毁与重挂载，播放器容器经历闪烁与 DOM 节点重建，破坏沉浸式换台体验。

---

## R5: 卡片 Hover 一键起播交互（消灭二级详情阻断）

### Decision
- **双层交互模式**：
  - 默认态：展示频道 Logo、频道名、当前节目名与进度条。
  - Hover 态（鼠标移入）：卡片正中央平滑淡入半透明深色遮罩，居中显示高亮的强调色 `▶ 播放` 图标按钮；
  - 交互判定：
    - 点击卡片正中央 `▶` 按钮：**直接发起播放**（全屏起播或导航至 Screen 4 立即起播）；
    - 点击卡片底部文字/详情区域：进入 Screen 4 查看完整节目简介与预告。
  - 针对触屏/无 Hover 设备：点击卡片直接弹出轻量动作选择浮层（`[ 立即播放 ]` / `[ 节目详情 ]`）。

---

## R6: EPG 节目单时间墙（Screen 3）NOW 相交节目块的直接起播

### Decision
- **节目块状态计算（相交判定）**：
  - 设节目起止时间为 $[T_{start}, T_{ends})$，服务端参考当前时间为 $T_{now}$；
  - 当 $T_{start} \le T_{now} < T_{ends}$ 时，该节目块判定为 **`current` (正在播出)**，渲染绿色 `LIVE` 角标；
  - 点击此 `current` 节目块，触发直接起播该频道；
  - 当 $T_{start} > T_{now}$ 时，判定为 **`upcoming` (未来节目)**，点击弹出侧边轻量抽屉展示节目简介与开播倒计时，禁止直接触发播放。

---

## R7: 游客播放意图暂存与恢复（ActionCoordinator 协同）

### Decision
- 沿用并深化 [规格 005](docs/specs/005-pc-browsing-flow/spec.md) 与 [规格 012](docs/specs/012-live-settings-experience/spec.md) 的 `ActionCoordinator` 意图状态机：
  - 游客在 Screen 1、2、3、4 任何一处点击播放，状态机生成唯一 `intentId` 并暂存 `PlayTarget: { mediaId, title, startMode: 'beginning' }`；
  - 唤起统一受控认证 Modal（登录 → 选 Profile）；
  - 认证通过后，状态机自动激活目标 `intentId`，继续发起服务端 `POST /playback/resolve` 授权，完成无缝起播；
  - 用户取消则销毁该意图，平滑保留在原浏览页面。
- 整个意图仅保留在应用内存，绝不写入 `localStorage`，不泄露用户敏感状态。
