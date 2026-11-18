# ADR-0018：播放器控制面与原地换流

- 状态：Accepted
- 日期：2026-11-12（追溯记录；决策在实现中形成并即时生效）
- 适用版本：V1.0+
- 依据：项目宪章核心原则一（规格与证据）、三（受控播放鉴权不放宽）、七（频道中心制）；[019-player-control-experience](../specs/019-player-control-experience/spec.md)
- 关联：[ADR-0016 在线点播播放过渡](./0016-online-vod-playback-transitions.md)（换源串行流不变）

## Context

播放面此前由三套互不协调的机制拼成：

1. **引擎原生控制条**（video.js `controls: true`）承载播放/进度/音量/全屏，样式与 HeroUI 语义 token 体系割裂；
2. **四角浮动控件**：右上「换源」、右侧「播放设置」、播放面头部「线路切换 / 连播开关 / 最小化」——同一屏出现 5 个以上入口，遮挡画面且认知负担高；
3. **换线即重建**：手动换线走 `launchPlayback`，相位被打回 `preparing`，`PlayerView` 随之卸载重建，用户看到的是「播放器关闭 → 黑屏 → 重新加载」。

同时直播缺少「在播放器内切台」能力：观众只能退出播放面、回到频道列表、重新点播。画面内还常驻两类文字提示（「正在直播」角标、「进度不可保存」说明），被判定为过度设计。

宪章技术约束 5/8/9 要求 PC 端交互组件一律 HeroUI v3 + 语义 token + lucide 图标；原则七要求播放器只消费逻辑频道与其线路集合，换流应在频道上下文内闭环。

## Decision

1. **自绘 HeroUI 控制栏，关闭引擎原生控件（2026-11-18 修订：两行操作台）**
   新增 `PlayerControls`，以 HeroUI `Button`/`Slider`/`ProgressBar`/`Chip` 实现两行操作台：第 1 行时间轴（直播 = 节目起止时刻 + 只读 `ProgressBar`（aria-label 节目进度）；点播 = 当前位置 + 可拖动 `Slider` + 总时长），第 2 行动作行（左：直播播放/暂停与音量、点播音量；中：直播 `Chip` `LIVE · 正在直播`、点播播放/暂停；右：业务动作 + 最小化/全屏）。`VideoPlayer` 增加 `nativeControls` 开关（默认 true，播放面传 false），底层仍使用同一 `<video>` 元素，媒体事件与 `currentTime`/`paused` 语义不变。控制栏 3 秒自动隐藏，唤出监听挂在**播放器容器**（隐藏态控制栏自身 `pointer-events-none`，只挂栏内会导致「隐藏后再也唤不出」）；容器宽度 `@max-[28rem]` 紧凑档隐藏音量滑杆。直播无节目元数据时第 1 行整行隐藏（不以假数据占位）。

2. **低频动作收敛到「播放设置」**
   线路切换、换源从控制栏移入设置面板（音轨/字幕/清晰度之后）。控制栏只保留高频道具。

3. **换流入口二选一**
   直播（`durationSeconds === null`）只给「线路」（`lines.length ≥ 2`）；点播只给「换源」。同一时刻只存在一个换流入口，避免「线路 vs 换源」并列造成的语义重复。

4. **原地换流（不重建播放器）**
   `handleManualLineSelect` 改为**同 intentId 内**：resolve 新线路 → prepare 轮询 → 换票 → 仅 patch 会话面（`sessionId`/`playbackUrl`/`ticketExpiresAt`/`delivery`/`lines`/`selectedLineId`），**不写 `phase`**，保持 `playing`。旧会话在换装成功后 best-effort `stop`。失败保持原线路继续播放并 Toast 提示；在途去重。

5. **播放器内直播切台面板**
   新增 `LiveGuidePanel`：控制栏「节目单」icon 呼出全频道当前节目列表（复用 `GET /public/live/channels?section=now`），每行含频道标识、节目名、时段与实时进度（服务端基准钟 15s tick），点击后自动关闭；面板为播放器内非模态覆盖层，关闭态零请求。**切台走与原地换线同一通道（2026-11-18 修订）**：同 `intentId` 内 resolve 新频道 → prepare 轮询 → 换票，经 `playRetarget` 改写目标面 + `playPatch` 改写会话面，Phase 始终 `playing`；旧频道播到换装那一刻，播放面与媒体元素不重建（不再走 `play()`，否则 `playStart` 会把相位推到 `authorizing` → `preparing`，播放器先关闭再重开，实测约 700ms 空窗）。失败保持当前频道继续播放并提示一次；同一频道行与在途重复点击不动作。

6. **mini 播放器**
   播放面可最小化为 300×171 悬浮窗（16:9 画面 + 边框，无头部）；mini 只保留**底部右侧一个「还原」按钮**（外壳级、任何相位都在、不参与控制栏自动隐藏），标题、频道 logo、退出与其余播放控件全部隐藏，退出走「还原 → 退出」两步；拖动由整个窗口承担（指针捕获 + 视口 clamp，`cursor-move`），切换仅改外壳定位/尺寸，**不改变 `PlayerView` 子树结构**，避免重挂中断播放。

7. **身份进入 PlayerView 顶栏覆盖层，外壳 header 只服务失败态（2026-11-18 修订）**
   playing 相位不再有外壳 `<header>`：身份信息由 `PlayerView` 顶栏覆盖层承担 —— 左上「返回图标 Button（`aria-label=退出播放`，走协调器 `close`）+ 品牌 `映岬 Cinecape`」，右上「状态（直播：绿点 + 正在直播，频道 logo 保留；点播：`Chip` 点播）/ 大标题 / 元数据（直播 `频道名 · HH:mm–HH:mm`；点播 `点播`）/ 两行直播描述」。身份层常驻可见（身份不是临时 chrome），整层 `pointer-events-none`、仅返回按钮可点；mini 不渲染任何覆盖层。`PlayerView` 新增 `title`/`posterRef`/`onExit` props，`posterRef` 经 `PlayActionRequest`/`PlayTarget` 透传（仅本地展示，不进 resolve 请求体）。unavailable 相位由协调器保留极简 header（logo + 标题 + 退出），使失败态仍有身份与退出。
   直播节目元数据经既有公共端点 `GET /public/media/{mediaId}/programmes`（`useAppQuery` + `queryKeys.public.channelProgrammes(mediaId)`，public 域、staleTime 30s、仅直播且已知频道 id 时 enabled）；只读进度与时刻以 15s tick 的服务端基准钟（`useServerNow`，未校准回落响应 `now`）计算，不冻结在取数瞬间；`now > current.endsAt` 且存在 `next` 时本地提档；数据缺失/失败/`status=unavailable` 隐藏第 1 行与描述；上游占位文案「暂无节目描述」不作为描述呈现；容器 <28rem（手机）时描述隐藏，只保留状态/标题/元数据。

8. **移除画面内常驻提示**
   删除「正在直播」角标与「进度不可保存」常驻说明；直播状态由控制栏 LIVE 胶囊承载（文字 + 脉冲点，不只靠颜色），进度能力判定仍驱动进度条可用性。

9. **大屏/小屏分档（容器宽度优先，视口只决定外壳）**
   同一 `PlayerView` 子树同时服务 1120px 大窗、390px 手机与 300px mini 窗，故**控制栏密度以播放器容器宽度为准**：根节点 `@container`，`@max-[28rem]`（<448px）为紧凑档 —— 隐藏音量滑杆（保留静音按钮）、图标按钮收至 32px、收紧横向/顶部间距；容器 `<24rem`（超窄屏）隐藏第 2 行中央 LIVE Chip（直播状态仍由顶栏「正在直播」呈现），避免三列动作横向溢出；时间不换行、右侧动作组不参与压缩。外壳按视口分档：`<sm`（<640px）播放面改为全出血（`100dvh`、无圆角/边框，16:9 画面垂直居中），大屏保持居中浮层，mini 窗 300px 不变。**不在控制栏里用视口断点**——否则桌面上的 mini 窗会误用大窗排版。

## HeroUI 能力缺口对照（约束 5 要求的偏离记录）

依据 `heroui-react` skill 的组件清单脚本（`scripts/list_components.mjs`，当日返回 73 个组件）与实际文档核对，逐项判定如下。**原则：HeroUI 覆盖的能力一律复用；仅容器/覆盖层/拖动三类布局行为自研。**

| 需要的 UI 能力 | HeroUI 现有能力（3.2.6 实测） | 判定 | 本实现做法 |
|---|---|---|---|
| 播放/暂停、设置、音量、全屏、最小化按钮 | `Button`（`isIconOnly` + `variant`/`isDisabled`） | ✅ 覆盖 | 直接使用 |
| 进度条、音量条 | `Slider`（`value`/`onChange`/`onChangeEnd`/`isDisabled` + `Track/Fill/Thumb`） | ✅ 覆盖 | 点播 seek/音量直接使用（拖动期本地值、松手写回媒体） |
| 只读进度（直播节目进度） | `ProgressBar`（`value`/`minValue`/`maxValue`/`color`/`size` + `Track/Fill`，React Aria progressbar 语义） | ✅ 覆盖 | 直接使用（`aria-label=节目进度`，只读，不接受拖动） |
| 直播/点播状态标识 | `Chip`（`variant=soft`、`color`、`size` + `Chip.Label`） | ✅ 覆盖 | 直播 = `Chip` `LIVE · 正在直播`（圆点 + 文字）；点播 = `Chip` `点播` |
| 面板加载态 | `Skeleton` | ✅ 覆盖 | 切台面板加载骨架 |
| 面板容器视觉 | `Surface` / `Card` | ✅ 覆盖 | 以语义 token 表达（面板为绝对定位覆盖层，未套 Surface 壳） |
| 设置菜单面板 | `Popover`（portal 弹层，支持非模态） | ⚠️ 可用但未采用 | 现为自绘绝对定位弹层（`bottom-full end-0`），功能/键盘等价；**可迁移项，登记为技术债** |
| 切台列表行 | `ListBox`（支持 Section/Virtualizer，Item 可含自定义子节点） | ⚠️ 可用但未采用 | 现为原生 `button` + 行内进度条；行内进度与「当前」标记属自定义内容，迁移收益低，登记为可选优化 |
| 控制栏容器（画面覆盖、自动隐藏、暂停常显） | `Toolbar` 仅为布局分组原语，无播放器覆盖层/自动隐藏语义 | ❌ 无覆盖 | 自研 `PlayerControls` 容器（Button/Slider 仍来自 HeroUI） |
| 播放器内**非模态**覆盖面板（不 portal、不 aria-hidden 播放器、不拦截播放） | `Sheet`/`Drawer` 带 backdrop 与拖拽关闭（模态覆盖）；`Popover` 为 portal 弹层 | ❌ 无覆盖 | 自研 `LiveGuidePanel`（`role="dialog"` + 绝对定位覆盖，播放器保持可交互） |
| 可拖动 mini 悬浮窗（指针捕获 + 视口边界约束） | 无悬浮/拖拽原语（`Sheet` 的拖拽仅限关闭手势） | ❌ 无覆盖 | 自研：外壳定位 + `setPointerCapture` + clamp |
| 视频解码与 HLS 播放 | 无媒体引擎组件 | ❌ 无覆盖（且属引擎层） | 沿用既有 `video.js`（本 ADR 不改引擎选型） |

**自研范围边界**：仅限「覆盖层容器 / 面板定位 / 悬浮拖动」这三类**布局与定位行为**；其中所有可交互元素（按钮、滑块、状态芯片、骨架）均为 HeroUI 组件，样式只用语义 token，图标只用 `lucide-react`。这与约束 5 的例外条款一致，也是本条偏离记录的全部范围。

**mock 上出现、但有意不实现的控件（2026-11-18，操作台 mock 对照）**：上一集/下一集（域内无相邻集编排动作，连播倒计时是既有唯一「下一集」通道）、倍速（引擎未暴露 rate 通道）、清晰度徽标（无质量端点，清晰度仅在「播放设置」只读展示）、CC 按钮（字幕切换在「播放设置」内，避免双入口）、PiP（浏览器/引擎未接入）。这些不新增假控件、不伪造数据；当前能力仍全部可达：播放/暂停、点播 seek、音量/静音、全屏、最小化/还原、节目单（直播）、播放设置（音轨/字幕/清晰度/线路/换源）、退出。

**版本口径**：skill 文档索引当日为 v3.2.7，仓库实际安装 `@heroui/react`/`@heroui/styles` 3.2.6。按宪章「组件 API 与 token 以安装版本为准」，上表判定以 3.2.6 的类型检查与运行时实测为准；`Slider`/`Button`/`Chip`/`Skeleton` 所用 props 在 3.2.6 均可用（`tsc --noEmit` 与浏览器实测通过）。若后续升级 HeroUI，需按约束 8 走宪章修订记录。

## 全仓 UI 合规扫描（2026-11-12，宪章约束 5/8/9）

对 `apps/web/src` 做了一轮机械扫描，结论与处置：

| 检查项 | 扫描结果 | 处置 |
|---|---|---|
| 原生 `<select>` / `<datalist>` / `<dialog>` / `<progress>` / `<meter>` / `input[type=date\|time]` | **0 处** | 合规 |
| `window.alert/confirm/prompt` | **1 处**（`ChannelEditModal` 删除最后一条线路的确认） | **已修复** → HeroUI `AlertDialog`（危险态图标 + 取消/确认删除，`data-testid` 供测试） |
| `input[type=file]` | 1 处（频道 Logo 上传） | **合规**：隐藏 input 仅作浏览器能力载体，交互面是 HeroUI `Button`，符合约束 5 的「封装原生元素不在禁令内」 |
| 内联 `<svg>` | **0 处** | 合规（图标全部 `lucide-react`） |
| 第二套图标库（phosphor/heroicons/tabler/react-icons） | **0 处** | 合规 |
| 硬编码颜色（hex/rgb/hsl/oklch 字面量） | **0 处** | 合规 |
| Tailwind 原始调色板类（`bg-black`/`text-white`/`border-white/10` 等） | **37 处**（播放面、控制栏、公共顶栏） | **已修复** → 全部换为语义 token（`bg-background`、`text-foreground`、`text-muted`、`border-border/60`、`bg-foreground/15` 等），运行时实测背景 `oklch(0.12 …)`、前景 `oklch(0.9911 0 0)` |
| 任意值字号（`text-[10px]`/`text-[11px]`） | **23 处** | **已修复** → 新增项目 token `text-3xs`(10px)/`text-2xs`(11px)（`shared/theme/tokens.css` 的 `@theme`），并在 `DESIGN.md` 登记用途；实测 10px/11px 渲染不变 |
| 任意值布局宽高（`w-[220px]`/`max-w-[960px]` 等） | **25 处** | **已登记未改造**：均为布局/媒体尺寸，已在 `DESIGN.md`「项目补充设计 token」逐项登记用途；后续如重复出现再收敛为 `@theme` 容器 token |
| 原生 `<button>` | **12 处**（EPG 节目块/列表行、切台行、候选行、PIN 数字键等复合内容项） | **保留为已记录的自定义组件**：这些是承载复合内容（进度条、绝对定位、多位输入）的"行/块"，HeroUI `Button` 无法在不破坏布局与语义的前提下承载；均使用语义 token、`:focus-visible` 焦点环与完整 `aria-label` |
| 原生 `<details>`（EPG 已结束折叠） | 1 处 | **保留**：非宪章列举的禁用控件；`<details>/<summary>` 提供无 JS 语义与键盘行为，且被既有测试按 `DETAILS` 结构钉住。若后续统一为 HeroUI `Disclosure`，需同步修订规格 019 与相关测试 |

**结论**：宪章明文禁止的原生交互控件已清零（`window.confirm` 修复后）；颜色与字号已全量 token 化；剩余偏离（原生 `<button>` 复合项 12 处、`<details>` 1 处、布局任意值 25 处）均属「HeroUI 未覆盖 + 已记录原因」的合规例外。

## Consequences

**正**
- 控制面统一为一套 HeroUI 语义视觉，与页面其余部分一致（约束 5/8/9 落地）。
- 身份层移入画面顶栏后，playing 相位不再占用独立 header 高度，视频在圆角卡片内满铺；状态/标题/元数据与节目进度同屏可读，失败态仍保留极简 header。
- 换流从「卸载重建」变为「原地换源」，播放中断只剩一次缓冲；`PlayerView` 的进度泵、探针、票据续期随 `sessionId` 变化自然重挂，无需额外生命周期。
- 直播切台路径从「退出→列表→重播」缩短为「面板内一键」，且切台不再拆播放面（同一 `video` 节点、无 `preparing` 空窗）；切台数据与直播首页同源，无新增端点。
- mini 播放器让「边看边浏览」成立，且不产生第二套播放器实例。

**负 / 风险**
- 自绘控制栏接管了原生控件的键盘可达性与移动端手势，需持续维护；当前未实现手势与 PiP（见 spec Out of Scope）。
- 原地换流的失败分支只能「保持原线路 + 提示」，无法回滚到中间态；依赖旧会话 stop 的幂等性做卫生清理。
- 自动隐藏的可发现性依赖容器级监听，属易回归点（已用单测钉住）。
- 控制栏密度与播放器容器宽度绑定（28rem 单断点）：新增控件或放宽间距时，320px 全出血面是最紧的实测界（当前无横向溢出）；mini 窗不挂控制栏，只看视频。
- 手机全出血面覆盖页面，「边看边浏览」在 `<sm` 由 mini 窗承担；浮层的非模态语义只在大屏成立。
- mini 只留「还原」一个控件：暂停、音量、退出都要先还原，窗口不可直退。这是本设计的取舍（最小化＝纯看画面）。
- 播放面身份层的频道 logo 盒必须自带定位上下文（`relative`）：`ChannelLogo` 装饰层是 `absolute inset-0`，宿主若是 `static`，装饰层会锚到整个 fixed 播放面并被 `overflow-hidden` 裁掉（2026-11-18 修复，实测装饰层 1118×678 vs 盒 32×32）。
- 两行控制栏在窄容器（<28rem）把动作拆到三列，390px 全出血面为最紧实测界；新增图标或长文案必须先量行宽（当前无溢出，见 Verification）。
- 顶栏身份层依赖 publics programmes 请求；元数据失败不阻塞播放，但第 1 行与描述会缺席（设计如此，不显示假数据）。
- 头部去掉线路/连播后，连播开关在 v1 无 UI 入口（偏好 Provider 与其持久化仍在），若后续开放点播需补回入口。

**被否方案**
- 保留 video.js 原生控件、仅把浮动按钮挪进底部条：改动小，但控制条样式仍与 HeroUI 割裂，不满足约束 8 的视觉一致性要求。
- 换流继续走 `launchPlayback`（重建播放器）：实现最省事，但正是本次要消除的体验断裂。
- 引入第三方 EPG/时间轴库（如 Planby）承载播放器内列表：许可为 Custom License 且会引入 emotion/date-fns，仓库既有决策明确不纳入（见 `docs/frontend-home-live-epg-design.md` §6.3）。

## Verification

- 单元：`test/playback/player-controls.spec.tsx`（隐藏/唤回/悬停不隐藏/暂停可见 + 两行布局/只读节目进度/LIVE Chip）、`test/playback/playback-modal.spec.tsx`（身份层存在、外壳无 header、返回退出）、`test/vod-switch.spec.tsx`（换源入口经设置）、`test/playback/playback-settings.spec.tsx`（直播态无角标、设置面板）。
- 运行/浏览器：两行控制栏（时间轴 + 动作行）、vjs 控制条 `display:none`、mini 尺寸与拖动、切台面板 14 行含进度且切台生效、playing 相位无外壳 header（身份在 PlayerView 顶栏，退出为返回图标）、unavailable 保留极简 header、设置面板线路/换源互斥。
- 分档实测（2026-11-18，真实 Chromium，播放中暂停常显控制栏）：外壳 1288/1024/768/640 为居中浮层（圆角 8、边框 1）、480/390/320 为全出血（0,0、无圆角边框）；控制栏行宽 1094/937/696/576/456/374/304 全部等于可用宽度（无溢出，紧凑档在 390/320 命中：音量 `display:none`、LIVE 胶囊 44×19 单行）；mini 300 窗行宽 282/282、音量隐藏。真机点播档的「当前时间 / 总时长」截断由 mock 会话与生成 CSS 探针各验一次（`@container (width < 28rem)` / `>= 28rem` 规则均在产物 CSS 内）。
- 切台实测（2026-11-18，真实 Chromium，播放 CCTV-16 打开节目单点 CCTV-13）：修复前 100ms 采样 `surface=false, playback-preparing=true`，约 700ms 后才重挂；修复后全程 `surface=true`、`preparing=false`、`video` 同一节点、`paused=false`，约 660ms 标题由旧频道切到新频道，服务端日志为 `resolve 201 → session GET → renew 200 → stop 旧会话 204`（无新 `playStart`）。自动化：`test/features/live/in-place-zap.spec.tsx`（20ms 采样相位恒 `playing`；失败保持当前频道）。
- mini/头部实测（2026-11-18，真实 Chromium）：头部 logo 装饰层 30×30 落在 32×32 盒内（修复前 1118×678 溢出被裁，图不可见），img natural 119、opacity 1、首字回退 opacity 0；mini 外壳 300×170、`header` 0 个、`PlayerControls` 不挂载、只剩 1 个「还原播放器」按钮（z-30、opacity 1），默认停机位底部留白 17px，从画面拖动 (−180, −120) 生效，真实鼠标点「还原」回到大窗。
- 全量：`pnpm --filter @hmp/web exec vitest run` → 90 文件、593 通过 / 1 跳过（2026-11-18 操作台改版全量；新增 3 例两行控制栏/只读节目进度/身份层断言）；`tsc --noEmit`、eslint 零告警。