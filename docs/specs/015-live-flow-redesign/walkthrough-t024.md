# T024 · 响应式视口与键盘可访问性走查记录(015-live-flow-redesign)

- **任务**:tasks.md T024 —— 按 `quickstart.md` 在 1440px/1920px 宽屏及 768px~1024px 窄屏走查卡片与播放器自适应,验证 Tab 方向键焦点环可见性。
- **执行日期**:2026-11-08。
- **执行方式**:本地无 IPTV/EPG 真实数据源,无法起全真环境(quickstart §1 前置要求「已有 IPTV 频道源与 EPG 数据导入」不满足),按三层证据完成走查,每条结论标注证据层级:
  - 【源码审阅】源码 + 契约/文档静态对照(文件:行号锚点);
  - 【单测证据】既有自动化用例(文件:行号);
  - 【运行时证据】本次新增 jsdom 钉面 spec `apps/web/test/features/live/responsive-keyboard-walkthrough.spec.tsx`(15 例全绿);
  - 【静态文件钉面】对全局基线文件内容的直接断言(归入运行时 spec §B3/B4);
  - 【无法验证】留待人工走查(§C 清单)。
- **走查对象**(四界面 + 布局 + 全局基线):`apps/web/src/features/live/LivePage.tsx`、`components/LiveHeroPlayer.tsx`、`components/CategorySwimlanes.tsx`、`components/ChannelTile.tsx`、`components/MediaScroller.tsx`、`pages/ChannelGridPage.tsx`、`pages/LiveWatchPage.tsx`、`components/SameTypeLiveStrip.tsx`、`features/epg/GuideWall.tsx`、`layouts/PublicLayout.tsx`、`shared/theme/a11y.css`;契约:`contracts/ui-layout.md`、`DESIGN.md`、`quickstart.md`。
- **验证命令实际执行结果**:
  - `pnpm --filter @hmp/web exec vitest run test/features/live/responsive-keyboard-walkthrough.spec.tsx` → **15 passed (15)**;
  - `pnpm --filter @hmp/web typecheck` → **通过(tsc --noEmit 零错误)**。

---

## A. 响应式视口

### A1 Screen 1:Hero 16:9 舞台宽/窄视口自适应 + 泳道行溢出限制(quickstart 场景 1)

**结论:PASS(证据层级:运行时证据 + 源码审阅)**

| 检查点 | 结论 | 证据锚点 |
| --- | --- | --- |
| Hero 舞台 16:9 语义 token,非固定像素 | ✅ `aspect-video w-full overflow-hidden rounded-xl` 于容器约束内自适应;外层 section `min-w-0` 防父链横向溢出 | 【运行时】walkthrough spec A1;【源码审阅】LiveHeroPlayer.tsx:88-97 |
| 宽窄两档排版:角标/状态签/静音 md 偏移、信息层 md 内边距、标题 md 字阶 | ✅ 频道角标 `right-4 top-4 md:right-6 md:top-6`;LIVE 签 `left-4 top-4 md:left-6 md:top-6`;静音 `md:top-20 md:right-6`;信息层 `p-5 md:p-8`;标题 `text-2xl md:text-4xl`(768px 以下收拢、≥768 放大,覆盖 quickstart 768~1024 窄屏档) | 【运行时】walkthrough spec A1(class 存在性);【源码审阅】LiveHeroPlayer.tsx:106-111、113-120、122-140、144-146 |
| 泳道行横向滚动不撑破页面 | ✅ MediaScroller 外层 `group/scroller relative min-w-0`,滚动收在 `ul.overflow-x-auto snap-x snap-proximity` 行内(ui.md §8「整页无横向溢出」);卡片列固定宽 `li.w-60 shrink-0 snap-start sm:w-64 lg:w-72`(泳道)/`w-56 sm:w-60`(同类横条),按视口自然截断 | 【源码审阅】MediaScroller.tsx:5-13、84、125-131;CategorySwimlanes.tsx:96;SameTypeLiveStrip.tsx:103 |
| 箭头按溢出出现/消失(不虚占 Tab 位) | ✅ 以 `scrollWidth - clientWidth` 判定,内容不溢出不渲染箭头(到边缘隐藏);jsdom scrollWidth=0 自然退化为无箭头 | 【运行时】walkthrough spec A1(断言无 `向左/向右滚动` 按钮);【源码审阅】MediaScroller.tsx:26-36、85、105 |

### A2 Screen 2:网格断点带与 ui-layout §2.2 映射、view=list 降级(quickstart 场景 3)

**结论:PASS(证据层级:运行时证据 + 源码审阅 + 单测证据)**

| 检查点 | 结论 | 证据锚点 |
| --- | --- | --- |
| 断点带映射:大屏 ≥1440 4~5 列、1024~1439 3~4 列、768~1023 2 列 | ✅ 实现 `grid-cols-1 md:grid-cols-2 lg:grid-cols-3 min-[1440px]:grid-cols-4 2xl:grid-cols-5`:md(768)=2 列、lg(1024)=3 列、min-[1440px]=4 列、2xl(1536)=5 列(契约 4~5 列上沿);<768 契约未定义,取单列降级(实现头注明示) | 【运行时】walkthrough spec A2(逐段 class 断言);【源码审阅】ChannelGridPage.tsx:318-333、41-43;契约 ui-layout.md §2.2 第 2 条 |
| Tabs 联动 + `?group=` 高亮 | ✅(键盘面另见 B2;此处为响应式:Tabs.ListContainer 溢出自动出滚动 chevron,窄屏 Tab 行不折断布局) | 【源码审阅】ChannelGridPage.tsx:234-256;.heroui-docs react/tabs.mdx:55(ListContainer overflow chevrons) |
| view=list 降级 | ✅ `?view=list` 时多列网格退出,渲染 `ul.divide-y` 紧凑列表(频道名 + 正在播 + 行尾 PlayButton);缺省态不带参数(地址整洁) | 【运行时】walkthrough spec A2-list;【源码审阅】ChannelGridPage.tsx:88、334-358;契约 routing-and-url-state.md §2.2(view 参数) |
| 全局容器约束 | ✅ PublicLayout `main` `mx-auto w-full max-w-6xl px-4 py-6`,窄窗由 px-4 收拢,页面级无横向溢出 | 【源码审阅】PublicLayout.tsx:38 |

### A3 Screen 4:宽屏分栏/窄屏堆叠 + 播放器 16:9 约束(quickstart 场景 4)

**结论:PASS(证据层级:运行时证据 + 源码审阅)**

| 检查点 | 结论 | 证据锚点 |
| --- | --- | --- |
| 断点分栏 | ✅ `grid min-w-0 gap-6 lg:grid-cols-[minmax(0,2fr)_minmax(0,1fr)] lg:items-start`:≥1024 左播放器位(2fr)+ 右伴随面板(1fr);<lg 单列堆叠(面板自然下沉到播放器位下方,同类横条随后),与 ui-layout §4.2 线框一致 | 【运行时】walkthrough spec A3;【源码审阅】LiveWatchPage.tsx:54-57、187-204 |
| 播放器容器 16:9 约束 | ✅ 落位示意容器 `aspect-video`(LiveWatchPage);真实画面由全局播放面浮层承载,其宽度按「视口可用高度反推 16:9 上限」:`w-[min(94vw,1120px,calc((100vh-12rem)*16/9))]`,内容区 `aspect-video`,矮视口(≤720p)不遮蔽公共导航 | 【运行时】walkthrough spec B3(对 action-coordinator.tsx 表达式直接断言);【源码审阅】action-coordinator.tsx:850-871、894 |
| 零第二播放管线约束下的自适应 | ✅ 本页不渲染任何自建播放器(布局容器 = 全局播放面落位语义),画面自适应完全由播放面浮层一处承担(单点实现,无双源不一致风险) | 【源码审阅】LiveWatchPage.tsx:23-29 头注裁决 |

### A4 Screen 3:EPG 墙横向滚动与 sticky 列窄屏行为(quickstart 场景 2)

**结论:PASS(证据层级:运行时证据 + 源码审阅 + 单测证据)**

| 检查点 | 结论 | 证据锚点 |
| --- | --- | --- |
| 横向滚动只在墙内 | ✅ GuideScrollContainer `w-full max-w-full overflow-auto`(双轴墙内消化,父链 min-w-0),整页不被墙撑破;768 窄窗/600 高/200% 缩放由 `maxHeight:min(70vh,640px)` 限高收拢为内部滚动 | 【运行时】walkthrough spec A4;【源码审阅】GuideScrollContainer.tsx:6-19、77-89 |
| sticky 列 | ✅ 时间头 `sticky top-0 z-20`、时间头角标与每行频道列 `sticky left-0`(z-30/z-10),窄屏横滚时频道列不漂移、节目块不越轴遮频道名 | 【运行时】walkthrough spec A4(sticky 类存在性);【源码审阅】GuideWall.tsx:130-136、158-161 |
| 首次定位到 NOW 线附近 | ✅ autoPosition 按「窗口 key」一次性定位(手动浏览不拉回,FR-016);会话快照优先恢复 | 【源码审阅】GuideScrollContainer.tsx:51-75 |
| 相关既有证据 | guide 实现另有 epg-channel-watch.spec(3 例)、live-upcoming-ended-no-play.spec(6 例)、guide-detail-panel-host.spec(9 例)覆盖节目块分流语义 | 【单测证据】apps/web/test/epg-channel-watch.spec.tsx 等 |

---

## B. 键盘可访问性

### B1 全部新增交互元素 Tab 可达与 :focus-visible 焦点环(quickstart「Tab 方向键焦点环可见性」)

**结论:PASS(证据层级:运行时证据 + 源码审阅 + 静态文件钉面)**

**全局基线(双通道焦点环,全部交互元素共用)**:a11y.css 以 `!important` 对 `:focus-visible` 与 RAC 的 `[data-focus-visible='true']` 双通道给出 `outline: var(--hmp-focus-ring-width) solid var(--focus)`(含 offset),组件层 `outline-style:none` 与工具类 `focus:outline-none` 均被压过(T087 修复),`.hmp-player` 作用域除外 —— 即 HeroUI Button(Tabs/ToggleButton/SearchField/行尾入口等)与自建原生按钮(GuideWall 节目块/频道列、ChannelTile 无节目占位)两条链路都有可见键盘焦点环。【静态文件钉面】walkthrough spec B3 对 a11y.css:40-44 内容直接断言;DESIGN.md:121「Every interactive element needs a visible focus indicator」。

**逐元素清单(DOM 序 = Tab 序;全走查范围仅 GuideWall 窗口标题一处 `tabIndex={-1}`,为 FR-044 翻页程序化焦点锚,合理例外;无任何正 tabindex):**

| 交互元素 | Tab 可达 | 可读名 | 焦点环通道 | 证据锚点 |
| --- | --- | --- | --- | --- |
| Hero 静音切换 | ✅ | `aria-label=取消静音/静音` + `aria-pressed` 默认静音 | HeroUI Button → data-focus-visible + a11y.css | 【运行时】walkthrough spec B1(DOM 序第 1 位、aria-pressed);【源码审阅】LiveHeroPlayer.tsx:122-140;【单测】live-hero-player.spec.tsx:143-152 |
| Hero「接下来」预告入口 | ✅ | 按钮文字(节目名 + 开播时间) | HeroUI ghost Button | 【运行时】walkthrough spec B1(DOM 序第 2 位);LiveHeroPlayer.tsx:158-175 |
| Hero 主操作(直接收看/全屏播放) | ✅ | `aria-label=直接收看/全屏播放 <频道名>`(游客/已选档分流呈现) | HeroUI primary Button | 【运行时】walkthrough spec B1(第 3 位);LiveHeroPlayer.tsx:177-199;【单测】live-hero-player.spec.tsx:156-174 |
| Hero「节目详情」次操作 | ✅ | `aria-label=节目详情 <频道名>` | HeroUI outline Button | 【运行时】walkthrough spec B1(第 4 位);LiveHeroPlayer.tsx:200-216 |
| 卡片中央 ▶(双层交互) | ✅ 按钮恒在 DOM,键盘聚焦即浮现且焦点环可见;`(hover:hover)` 设备缺省 `pointer-events-none opacity-0`,`group-focus-within` 恢复可点 + 浮现;`(hover:none)` 触屏恒显可点 | `aria-label=播放 <频道名>` | HeroUI Button + a11y.css;浮现态 class 双通道钉面 | 【运行时】walkthrough spec B1(焦点通道 class 逐段断言);【源码审阅】ChannelTile.tsx:175-196;【单测】channel-card-hover-play.spec.tsx:87-104 |
| 卡片右下 收藏 + PlayButton(恒驻) | ✅ 可见性不随悬停变化(键盘/触屏不丢入口) | `收藏 <频道名>` / `播放 <频道名> 当前直播` | HeroUI Button | 【源码审阅】ChannelTile.tsx:198-236;【运行时】walkthrough spec B1(右下 PlayButton 断言) |
| 卡片节目名按钮 / 无节目占位 | ✅ 节目名 ghost Button(Tooltip 悬停可达,RAC Focusable 上下文);无节目占位为原生 button,自佩 `focus-visible:ring-2 ring-focus` | 节目名 / 暂无节目 | HeroUI Button / 显式 ring 类 | 【源码审阅】ChannelTile.tsx:249-309;【运行时】walkthrough spec B1(no-programme 焦点环断言) |
| 行尾入口(全部正在直播 › / 全部XX频道 ›) | ✅ SectionFrame headerAction ghost sm Button,无条件渲染(FR-003/004 MUST) | 按钮文字全称 | HeroUI Button | 【源码审阅】NowSection.tsx:40-47;CategorySwimlanes.tsx:79-91;【运行时】LivePage 行尾入口由 NowSection/CategorySwimlanes 承载 |
| 分类 Tabs | ✅ RAC Tabs(tablist/tab + roving tabindex) | `Tabs.List aria-label=频道分类` | data-focus-visible + a11y.css | 【运行时】walkthrough spec B2;ChannelGridPage.tsx:235-256 |
| SearchField 搜索框 + 一键清空 | ✅ | Label「搜索频道」+ `aria-label`;清空 `aria-label=清空搜索` | HeroUI 字段组件焦点态 | 【运行时】walkthrough spec B1(工具条);ChannelGridPage.tsx:257-273 |
| 视图切换 ToggleButtonGroup | ✅ 单选渲染 `radiogroup`/`radio` + roving tabindex(tabindex=0 在选中项,方向键组内移动) | `aria-label=视图切换`;`网格视图`/`列表视图` | data-focus-visible + a11y.css | 【运行时】walkthrough spec B1(工具条:radiogroup/radio/data-selected/tabindex);ChannelGridPage.tsx:274-292 |
| 同类横条卡片 | ✅ 整卡单 Button(瓦片即按钮,无嵌套可聚焦元素) | `aria-label=切换到 <频道名>` | HeroUI Button + `focus-visible:border-accent/40` | 【运行时】walkthrough spec B1(同类横条);SameTypeLiveStrip.tsx:46-52 |
| EPG 节目块 / 频道列「直播」按钮 | ✅ 节目块为绝对定位原生 button;频道列播放按钮不被节目块遮挡(sticky 独立列) | 块:`<频道名>,<节目名>,<时段>[,正在直播]`;列:`播放 <频道名> 当前直播` | 自建按钮自佩 `focus-visible:ring-2 ring-focus` | 【运行时】walkthrough spec B1/GuideWall;GuideWall.tsx:158-175、189-214;【单测】channel-logo.spec.tsx:375-404 |
| EPG 窗口标题焦点锚 | ✅(程序化)翻页/换窗后焦点定位到新窗口标题(FR-044,翻页不掉页面起点) | `id=guide-window-title`(tabIndex=-1 仅锚点用) | 【源码审阅】GuideWall.tsx:109-113、121-128;GuideScrollContainer.tsx:11-12 |
| EPG 滚动容器 | ✅ role=region 可聚焦,焦点在容器/节目按钮时方向键为原生 overflow 滚动 | `aria-label=节目单时间轴` | 显式 `focus-visible:ring-2 ring-focus` | 【运行时】walkthrough spec A4;GuideScrollContainer.tsx:77-89 |

**Tab 顺序语义**:四屏幕均为自然 DOM 序(视觉顺序 = 阅读顺序 = Tab 序),无 tabindex 干预 —— Hero 屏实测按钮序为「静音 → 接下来 → 主操作 → 节目详情」与视觉层序一致。【运行时】walkthrough spec B1 Hero DOM 序断言;【源码审阅】LivePage.tsx:238-324(Screen 1 装配顺序)。

### B2 Tabs 方向键导航(HeroUI v3 Tabs = React Aria Components)

**结论:PASS(证据层级:运行时证据 + 文档审阅)**

- 文档核对(`.heroui-docs/react/components/(navigation)/tabs.mdx`):`rac: Tabs`(:6)—— 组件构建于 React Aria Components Tabs;Interactive States 提供 `:focus-visible` / `[data-focus-visible="true"]`(:181);Tab 列表溢出时 ListContainer 自动渲染滚动 chevron(:55,窄屏可达性);HeroUI 发布说明背书组件族键盘模型(v3-0-0-beta-6.mdx:61「Accessible by Default: Full keyboard navigation and screen reader support」;v3-2-6.mdx:59 焦点环仅在真实键盘焦点出现,由 `[data-focus-visible]` 承载)。
- 运行时证据:jsdom 中对选中 Tab 触发 `ArrowRight` keyDown → 相邻「电影」Tab `aria-selected=true`、原「全部」`aria-selected=false`、URL 同步为 `/live/channels?group=movie`(RAC Tabs 选择随方向键移动的 WAI-ARIA tabs 语义)。【运行时】walkthrough spec B2。
- 补充:既有单测已断言 URL `?group=movie` 直达时「电影」Tab 自动高亮(aria-selected)。【单测】channel-grid-page.spec.tsx:240-251。

### B3 reduced-motion 下动效降级

**结论:PASS(证据层级:静态文件钉面 + 源码审阅)**

- 全局基线:`@media (prefers-reduced-motion: reduce)` 下 `animation-duration: 0.01ms !important; animation-iteration-count: 1 !important; transition-duration: 0.01ms !important; scroll-behavior: auto !important` —— 组件一切 transition(卡片抬升 `hover:-translate-y-0.5` duration-200、中央 ▶ `transition-opacity duration-200`、光斑 `duration-300`)均被全局收敛。【静态文件钉面】walkthrough spec B3;a11y.css:50-59。
- JS 滚动例外已自行处理:MediaScroller `scrollByPage` 显式检查 `matchMedia('(prefers-reduced-motion: reduce)')`,reduce 时 `behavior:'auto'`(全局 CSS 基线管不到 JS `scrollBy` 显式 behavior)。【源码审阅】MediaScroller.tsx:64-78。
- 其余动效均为 opacity/transform 过渡(无遮蔽性动画);播放面浮层无 enter/exit 动画依赖(fixed 浮层直出)。

### B4 状态不依赖单一颜色(DESIGN.md:121「Pair color with text or an accessible label」)

**结论:PASS(证据层级:运行时证据 + 源码审阅 + 单测证据)**

| 状态 | 表达 | 证据锚点 |
| --- | --- | --- |
| EPG LIVE 角标 | 绿色 Chip(success)**+ 可见文字「LIVE」** + 块 `aria-label` 追加「,正在直播」(颜色非唯一区分) | 【运行时】walkthrough spec B1/GuideWall;【单测】live-routing-epg.spec.tsx:179-189;GuideWall.tsx:222-235、194 |
| 卡片正在直播标注 | 红点(aria-hidden 装饰)+ **文字**(正在直播/即将播放/暂无排期,随档位对齐,避免「正在直播」签 + 未来节目名误读) | 【源码审阅】ChannelTile.tsx:117-129、165-173;【运行时】walkthrough spec B1(同类横条 getAllByText 正在直播) |
| Hero 直播标注 | 状态点(aria-hidden)+ **文字「正在直播」** | 【运行时】walkthrough spec A1/B1;LiveHeroPlayer.tsx:113-120 |
| 播出进度(Hero/瓦片) | 进度线为 `aria-hidden` 装饰,数值以**文字「已播出 N%」**并行(非仅红线长度) | 【运行时】walkthrough spec A1;LiveHeroPlayer.tsx:149-157、220-225 |
| 播出进度(watch 伴随面板) | `ProgressBar aria-label=当前节目播出进度 + aria-valuetext=已播 N%`(读屏可感知值),段落另有「已播 N%」可见文字 | 【运行时】walkthrough spec B4;LiveWatchPage.tsx:246-263 |
| NOW 时刻线 | 红线 `role=status + aria-label=当前时间 <时刻>(<偏移>)`,时间值文字化 | 【运行时】walkthrough spec B1/GuideWall;GuideWall.tsx:246-259 |
| 无节目/无预告 | 「暂无节目」「暂无节目单」「暂无预告」明确文字占位(非空白/仅色块) | ChannelTile.tsx:289-308;LiveWatchPage.tsx:279-281 |

---

## C. 汇总

### 结论表

| 编号 | 走查项 | 结论 | 最高证据层级 |
| --- | --- | --- | --- |
| A1 | Hero 16:9 舞台自适应 + 泳道行内溢出 | PASS | 运行时证据(jsdom) |
| A2 | 网格断点带映射 + view=list 降级 | PASS | 运行时证据(jsdom) |
| A3 | Screen 4 分栏断点 + 播放面 16:9 上限 | PASS | 运行时证据(jsdom)+ 静态文件钉面 |
| A4 | EPG 墙横滚 + sticky 列窄屏 | PASS | 运行时证据(jsdom) |
| B1 | 交互元素 Tab 可达 + 焦点环 | PASS | 运行时证据(jsdom)+ 静态文件钉面 |
| B2 | Tabs 方向键导航(RAC) | PASS | 运行时证据(jsdom) |
| B3 | reduced-motion 降级 | PASS | 静态文件钉面 + 源码审阅 |
| B4 | 状态非仅颜色 | PASS | 运行时证据 + 单测证据 |

### 待人工走查清单(jsdom/静态面无法覆盖;附 quickstart 场景编号)

1. **真实流媒体画面自适应**:起播后 HLS 真实画面在 1440/1920 宽屏与 768~1024 窄屏下的播放面浮层视觉(清晰度/黑边/控件重叠)——jsdom 无媒体引擎(quickstart 场景 1/4)。
2. **真机 hover 手感与触屏降级**:hover 设备中央 ▶ 浮现节奏/遮挡感、`(hover:none)` 触屏恒显可点、Tooltip 悬停手感 —— CSS 媒体查询行为与指针精度需真机(quickstart 场景 1)。
3. **200% 浏览器缩放 reflow**:EPG 墙 200% 缩放收拢为容器内滚动(GuideScrollContainer 头注声明)、网格/分栏在缩放视口下的实际折行(quickstart 场景 2/3/4)。
4. **真实键盘纵走全屏 Tab 环**:全页连 Tab(含播放面浮层打开/关闭前后焦点去向、认证弹层焦点陷阱)的体感顺序与焦点环肉眼可见度 —— jsdom 仅能钉 DOM 序与 class,不能度量对比度/遮挡(quickstart 场景 1~4 全程)。
5. **真实数据量下的 EPG 横滚与 sticky 表现**:数百频道 × 24h 窗口的滚动性能、sticky 列与 NOW 线在长墙上的层叠遮挡(quickstart 场景 2)。
6. **屏幕阅读器走查**(VoiceOver/NVDA):region/progressbar/radiogroup 等语义的实际播报顺序(本记录仅验证语义标注存在性)。

### 最终结论

**PASS with pending manual items** —— 上表 A1~A4、B1~B4 全部通过(可静态化/jsdom 验证面);真实画面自适应、hover 手感、200% 缩放、真机焦点环肉眼可见度、读屏播报等 6 项留待人工走查(清单见上,均已在实现层具备对应静态约束)。

**新增自动化证据**:`apps/web/test/features/live/responsive-keyboard-walkthrough.spec.tsx` —— 15 例(A 区 6 例 + B 区 9 例),`pnpm --filter @hmp/web exec vitest run test/features/live/responsive-keyboard-walkthrough.spec.tsx` → **15 passed (15)**;`pnpm --filter @hmp/web typecheck` 通过。本任务未改动任何被走查源码、其他测试文件与 tasks.md。
