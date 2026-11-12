# /live/guide 重设计实现规格（参照 magenta.tv/tv-guide）

> 参考截图：`design/reference-magenta/*.png`（desktop-viewport / probe / detail-open / date-dropdown / tablet-768 等）
> 本规格 = 参考页布局解剖 + 本仓库测试契约（不可破坏清单）+ HeroUI 组件映射。

## 0. 目标与范围

- **只改** `apps/web/src/features/epg/` 内文件的 **展示层**（markup/class/组件替换）；
- **不改**：`useGuideWindow.ts`、`guide-time.ts`、`guide-session-state.ts`、`GuideScrollContainer.tsx` 的定位状态机逻辑、`shared-programme/ProgrammeDetailPanel.tsx`（与 /live 共用）、任何测试文件、主题 token；
- 交互逻辑（URL 契约、点击分流、409/422、焦点恢复）保持现状。

## 1. 参考页布局解剖（magenta.tv/tv-guide）

1. **工具栏条**（暗色 surface 横条）：左侧品牌；右侧控件群：日期下拉、筛选图标、视图切换、搜索、登录。
2. **时间轴头部**：sticky 顶置；小时刻度（HH:00）；NOW 位置处嵌入品红「Jetzt」胶囊徽章；左缘 ‹ 回退箭头。
3. **NOW 线**：品红垂直线纵贯整个网格。
4. **频道列**（窄列）：频道序号 + 频道 logo，白底 logo 居中。
5. **节目块**：暗灰卡片；两行内容——标题（亮色）+ `HH:mm - HH:mm`（次行，muted）；正在播出的块背景更亮；块间细缝分隔；hover 提亮。
6. **响应式**：平板同构收缩（频道列更窄），无独立移动版式。

## 2. 本仓库视觉基线（必须遵守）

- 固定暗色主题；品牌 accent = 红色 `oklch(0.6 0.22 25)`（非 Magenta 品红——**沿用本仓库品牌红**，只借布局不换色）；
- 只用语义 token（`bg-surface`、`text-muted`、`border-border`…），禁裸色值；z 序只允许 0/10/20/30/40/50 与 z-[N]；
- 组件优先 HeroUI v3（`.heroui-docs/react/` 先读再用）：Button / ToggleButton(Group) / Chip / Select / ListBox / Skeleton / Spinner / Separator / Tooltip；
- `onPress` 不是 `onClick`（HeroUI Button 层）；
- 复用工具类：`hmp-tabular-nums`（时间等宽）、`hmp-truncate`（须配 title）、`hmp-sr-only`。

## 3. 不可破坏契约（测试钉面，逐字保留）

### DOM 锚点
- 滚动容器：`role="region"` `aria-label="节目墙"` `tabIndex={0}`（GuideScrollContainer 已有，勿动）；
- 窗口标题：`id="guide-window-title"` `tabIndex={-1}`，文案含「全天节目单」「家庭时区」；
- 节目块：`data-programme-key={programme.key}`；
- NOW 线：`role="status"` `aria-label="当前时间 {HH:mm}({GMT±H})"`；
- 频道播放按钮：`aria-label="播放 {频道} 当前直播"`；
- Select：`data-testid="guide-view-select"` / `"guide-page-size-select"`，`aria-label="视图模式"` / `"每页频道数"`；option 文本 `节目墙`/`按频道列表`/`20`/`30`/`50`；
- 日期组：`role="group"` `aria-label="节目单日期"`，内含 7 个原生可聚焦按钮，`aria-pressed` 标选中，首枚文案含「今天」，日期文案 `M月D日(今天)`/`M月D日`；
- dialog：`ProgrammeDetailPanel` 原样（不动）。

### aria-label 模板（e2e 以**形状**匹配：全角逗号 `,` + en-dash `–`）
- 墙块：`{频道},{标题},{HH:mm–HH:mm}`，current 追加 `,正在直播`；`title="{标题} {区间}"`；
- 列表行：`频道 {频道},正在直播,…` / `频道 {频道},即将播出,…` / `频道 {频道},已结束,…`；
- 列表频道 section：`aria-label="频道 {title}"`；已结束折叠 `<details>` + `<summary>已结束({n})</summary>`（默认收起）；
- 按钮可访问名：「回到现在」「上一页」「下一页」、±2h 的 `aria-label="向左滚动2小时"/"向右滚动2小时"`。

### 文案
- 「暂无节目」（空频道，保留不隐藏）；「正在加载节目单…」（loading role=status，可加 Skeleton/Spinner 但文本保留）；
- 409「日期已更新…」、422「窗口内节目过多…」、RetryableAlert「节目单加载失败」（保持现文案与 role 容器）；
- LIVE 徽章：HeroUI `<Chip color="success" size="sm" variant="soft">` 文字 `LIVE`（测试匹配 `chip--success` 类）。

### 逻辑常量（禁止改动）
- `CHANNEL_COL_PX = 176`、`PX_PER_MINUTE = 2`、`ROW_HEIGHT_PX = 56`（e2e 滚动断言与居中锚都依赖这组数字）；
- `GuideWall`/`GuideChannelList` 的 props 签名、回调分流（current→onPlayChannel；upcoming/ended→onSelectProgramme）、`pickCurrentProgramme`、`assignLanes`；
- `useServerNow()` 唯一时间源（禁 `Date.now()`）。

## 4. 各文件改造点

### GuideDateTabs.tsx（重塑外观）
- 外层保留 `<div role="group" aria-label="节目单日期">`；
- 内部 7 个日期换 **HeroUI `ToggleButton`**（selectionMode single 语义；React Aria 原生 `aria-pressed`）——若文档显示 ToggleButtonGroup 容器会自带 role，可仅用 ToggleButton 平铺在现有 group div 内；
- 样式对齐参考页：紧凑胶囊/分段控件（size sm，选中 = accent 语义态），首枚「今天」用强调样式或徽标点缀。

### GuideWall.tsx（重点重塑）
- **频道列单元格**：序号（小字 muted）+ `ChannelLogo`（posterRef 有则渲染，无则首字回退徽标——复用 list 视图模式）+ 频道名；右下/右侧保留小型「直播」播放按钮（aria 契约不变，视觉收缩为 icon+文字小按钮）；
- **时间轴头部**：保持 sticky 结构与 `频道` 列头；NOW 胶囊徽章挪进头部视觉带（现有顶部胶囊已是此形态，可贴合参考页把 `Jetzt` 风格胶囊吸附在头部内——保持 role=status 元素不变，仅改样式：accent 底 + 前景字 + 圆点脉动）；
- **节目块**：改为两行布局（标题行 + `HH:mm – HH:mm` 行，10–11px muted）；块间 `gap`/细边框近似参考页（保留绝对定位 left/width 数学不变，仅内部排版与配色变）；current 块 = surface 提亮 + accent 细节（进度条保留在块底部）；past 块降透明；hover 提亮；
- NOW 线本身保持 2px accent 竖线 + role=status（颜色从 danger 改 accent 可选——**保留 danger 或改 accent 均可，语义文案不变**；建议 accent 呼应参考页品牌线）。

### GuideChannelList.tsx（轻度重塑）
- 频道 section 卡片化（Surface 语义），当前节目特色行、upcoming 紧凑行、`<details>` 已结束结构不变，仅样式贴近参考页块风格。

### GuidePage.tsx（工具栏重排，逻辑零改动）
- 页头：`节目单` h1 + 时区说明（右侧）；
- **新增工具栏条**（`bg-surface` 圆角横条，参考页工具栏形态）：一行 flex-wrap 收拢——左侧日期组（GuideDateTabs）；右侧控件群：「回到现在」Button(outline + lucide 时钟图标)、视图 Select、每页频道数 Select、 Separator 分隔、‹ 上一页 / 下一页 ›（带频道范围文字 `频道 X–Y，共 N`）、墙视图时 ±2h 按钮；
- 768 窄窗必须 flex-wrap 不溢出（responsive e2e：640×540 下「回到现在」或窗口标题不被遮挡）；
- 布局壳其余部分（Alert 容器、region、面板挂载、sr-only 标签）保持。

### GuideScrollContainer.tsx
- 仅允许改视觉 class（圆角/阴影），**定位 effect、role/tabIndex/aria/maxHeight 一律不动**。

## 5. 验收清单

1. `pnpm --filter @hmp/web typecheck` 通过（若无此脚本用 `pnpm typecheck` 过滤 web）；
2. vitest 指定套件全绿：`test/guide-url-state.spec.tsx`、`test/epg/guide-page.spec.tsx`、`test/epg/guide-list-view.spec.tsx`、`test/guide-detail-panel-host.spec.tsx`、`test/epg/guide-window-query.spec.tsx`、`test/epg/server-clock.spec.ts`；
3. eslint 改动文件无新告警；
4. `http://localhost:5173/live/guide` 浏览器截图与参考页布局对照（工具栏条 / 时间轴头 / NOW 胶囊 / 窄频道列 / 两行节目块 / 暗色风格），无明显破版；
5. 交互抽查：日期切换、回到现在、视图切换、翻页、节目块点击（current 播放 / 非当前详情）。
