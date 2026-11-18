# Feature Specification: 播放器控制面体验（自绘控制栏 / 直播切台 / 原地换流 / mini 播放器）

**Feature Branch**: `019-player-control-experience`

**Created**: 2026-11-12（追溯补录，见「流程说明」）

**Status**: Verified（追溯补录）

**Governance**: 遵循 `.specify/memory/constitution.md`。重点对齐原则一（规格驱动与多层证据）、原则三（受控播放鉴权不因 UI 变更放宽）、原则七（频道中心制：播放器只消费逻辑频道与其线路集合），以及技术约束 5/8/9（HeroUI v3 优先、语义 token、`lucide-react` 图标）。

**Related ADRs**:
- [ADR-0016: Online VOD Playback Transitions](../adr/0016-online-vod-playback-transitions.md)（换源/过渡串行流）
- [ADR-0018: 播放器控制面与原地换流](../adr/0018-player-control-surface.md)（本规格的架构决策）

**流程说明（追溯补录，必须保留）**:
本规格对应的实现先于规格合入（2026-11-12 的播放器迭代），违反宪章原则一「写码前必须先有已接受规格」的流程要求。维护者于 2026-11-12 决定按「补录」方式恢复合规：实现与验收事实不变，本文件作为该轮变更的**事实性规格与证据索引**；后续涉及播放器控制面的变更必须先修订本规格再实现。此类追溯补录不得成为常态，也不得被引用为先例。

---

## User Scenarios & Testing *(mandatory)*

### User Story 1 - 观众在播放器内用一条两行 HeroUI 控制栏完成全部高频操作 (Priority: P1)

观众打开任意频道/影片，视频满铺圆角卡片，播放器底部只有一条**两行**控制栏：

- 第 1 行时间轴：直播为节目起止时刻 + 只读 `ProgressBar`（aria-label 节目进度）；点播为当前位置 + 可拖动 `Slider` + 总时长。无节目元数据时整行隐藏，不以假数据占位。
- 第 2 行动作行：左（直播：播放/暂停 + 音量；点播：音量）、中（直播：`Chip` `LIVE · 正在直播`；点播：播放/暂停）、右（业务动作 + 最小化/全屏）。

控制栏在播放中 3 秒无操作自动隐藏，鼠标在画面任意位置移动或键盘聚焦即重新出现；指针停在控制栏上时不自动隐藏。所有控件基于 HeroUI v3 与语义 token，图标统一 `lucide-react`。

**Why this priority**: 原生 video.js 控件与页面视觉体系割裂，且四角浮动按钮（换源/设置/线路）散落、遮挡画面。

**Independent Test**: 打开直播播放面 → 控制栏存在且含 `播放/直播状态/播放设置/音量/全屏/最小化`；3 秒无操作隐藏；鼠标移到画面唤回；指针停留不消失。

### User Story 2 - 直播观众在播放器内直接切台 (Priority: P1)

直播控制栏点击「节目单」图标，在播放器内部呼出「正在直播」列表：每行含频道标识、频道名、当前节目、时段与实时播出进度条；点击任意行立即切到该频道并自动关闭面板；切换在**同一播放会话内原地换装**，播放器不卸载、不回到「准备中」黑屏，旧频道播到新会话就绪那一刻；当前频道行标注「当前」且不可重复点击。

**Why this priority**: 切台是直播最高频动作，退出播放器回频道列表再播的路径过长。

**Independent Test**: 直播播放中打开面板 → 行数 > 0、每行有进度；点击非当前行 → 播放目标切换、面板关闭、播放面保持挂载且 `[data-testid=playback-surface]`/`video` 节点引用不变、全程不出现 `playback-preparing`；切台失败时保持当前频道继续播放并只提示一次。

### User Story 3 - 换流不中断画面（原地换装） (Priority: P1)

观众在多线路频道切换线路（设置面板内「线路」），或在点播中点「换源」选候选：播放器**不卸载、媒体元素不销毁、不回到「准备中」黑屏**，仅在新流就绪后原地换源续播；失败时保持原线路继续播放并给出提示。

**Why this priority**: 原实现换线走「新 resolve → 新 session → PlayerView 重建」，表现为播放器关闭后重播，体验断裂。

**Independent Test**: 切换线路 → 播放面节点（`[data-testid=playback-surface]`）不重建、`video` 元素保持、目标线路更新；失败路径保持原线路播放。

### User Story 4 - 播放面可最小化为可拖动的 mini 播放器 (Priority: P2)

观众点击控制栏「最小化」，播放面收起为约 300×200 的右下角悬浮窗；标题栏作为拖动手柄，可自由拖动并按视口边界约束；「还原」回到大窗；关闭播放时复位。切换过程不中断播放。

**Independent Test**: 最小化 → 尺寸/位置为右下角；拖动整窗（画面区域）→ 位置变化且不越界；还原 → 恢复居中大窗；`video` 元素全程未重建。

### User Story 5 - 播放面身份层与单一换流入口 (Priority: P2)

播放面（playing 相位）不再有独立头部：身份信息进入视频画面顶栏覆盖层 —— 左上「返回图标按钮（aria-label 退出播放）+ 品牌 `映岬 Cinecape`」；右上「状态（直播：绿点 + 正在直播，频道 logo 保留；点播：`Chip` 点播）、大标题、元数据（直播 `频道名 · HH:mm–HH:mm`，点播 `点播`）、直播节目描述（两行，数据可用时）」。身份层常驻可见（不参与自动隐藏），整层不拦截画面点击，仅返回按钮可点。mini 不渲染任何覆盖层；unavailable 相位保留极简 header（logo + 标题 + 退出），使失败态仍有身份与退出。

线路、连播、最小化等控件全部收进控制栏/设置。画面内不再有「正在直播」角标与「进度不可保存」常驻提示。换流入口二选一：直播只给「线路」，点播只给「换源」，不并列。

**Independent Test**: playing 相位存在 `[data-testid=player-identity]` 且无独立 `header`；返回按钮可退出；设置面板 sections 中「线路」与「换源」不同时出现；画面内无 `live-status` / `progress-unsavable` 节点。

### Edge Cases

- 直播流无时长（`durationSeconds === null`）→ 控制栏不渲染可拖动进度条，第 1 行改只读节目进度、第 2 行中央改 `Chip` `LIVE · 正在直播`；不出现「进度不可保存」提示。
- 直播节目元数据缺失/失败/`status=unavailable` → 隐藏第 1 行与描述，标题回退频道名，元数据只显示频道名；绝不显示「暂无节目描述」占位。
- 服务端 `now` 已越过当前节目 `endsAt` 且存在下一档 → 本地提档为下一档（标题/时间窗/进度一致切换，零新增请求）。
- 单线路频道（`lines.length < 2`）→ 设置内不渲染「线路」区块；点播不渲染「线路」，直播不渲染「换源」。
- 线路切换进行中重复点击 → 去重（在途忽略）；切换失败 → 原线路继续播放 + Toast 提示，不降级为不可播面。
- mini 态拖动越界 → clamp 到视口内（最小 8px 边距）。
- 无媒体实现环境（jsdom）/自动播放被拒 → 控制栏仍渲染，状态以媒体元素事实为准。
- 播放器内面板打开时视频继续播放（非模态覆盖层），不 aria-hidden 播放器。

---

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**：控制栏 MUST 由 HeroUI v3 组件与语义 token 构成，禁用 video.js 原生控制条（`display:none`），底层仍使用同一 `<video>` 元素。
- **FR-002**（2026-11-18 修订，控制栏两行布局）：控制栏 MUST 为两行操作台 ——
  - 第 1 行时间轴：直播（`durationSeconds === null`）以 HeroUI `ProgressBar`（只读，`aria-label=节目进度`）夹在节目起止时刻之间；点播以既有 HeroUI `Slider`（seek）夹在当前位置与总时长之间；直播无节目元数据时第 1 行整行隐藏。
  - 第 2 行动作行：左（直播：播放/暂停 + 音量；点播：音量 + 容器宽度 ≥28rem 时显示的音量 Slider）、中（直播：HeroUI `Chip`（soft/success、size sm，圆点 + `LIVE · 正在直播`）；点播：播放/暂停）、右（`节目单`（直播）、`播放设置`、`最小化播放器`、`全屏`）。
  - 容器 <28rem 时图标按钮收至 32px 并收紧间距；容器 <24rem（超窄屏）时隐藏中央 LIVE Chip（直播状态仍由顶栏「正在直播」呈现），保证动作行不横向溢出。
  - 两行均 MUST 提供 播放/暂停、音量、全屏、最小化；点播进度条仅在 `duration > 0` 时渲染，`canSeek=false` 时为只读外观。
- **FR-003**：控制栏 MUST 在播放中 3 秒无操作后隐藏，且在**播放器容器**（非控制栏自身）监听指针移动/按下/触摸以唤回；指针停留控制栏期间不得隐藏；暂停态保持可见。
- **FR-004**：直播控制栏 MUST 提供「节目单」入口，在播放器内部以 `role="dialog"` 覆盖层呈现全频道当前节目列表，含实时进度、当前频道标记与一键切台。
- **FR-005**（2026-11-18 修订）：切台 MUST 在同一播放意图内原地换装（resolve → prepare → 换票 → `playRetarget`+`playPatch`），Phase 保持 `playing`，不得卸载 `PlayerView`、不得销毁媒体元素、不得出现 `playback-preparing`；旧频道播到新会话就绪时再换源，失败保持当前频道并提示一次；面板在切台后自动关闭，同一频道行不得重复触发。原「经统一 `usePlayAction` 播放入口发起」的实现约束由本修订替代（新建意图会经 `playStart` 把相位推到 `authorizing`/`preparing`，表现为播放器关闭后重开）。
- **FR-006**：换线 MUST 在**同一播放意图**内完成（resolve → prepare → 换票 → 仅 patch 会话面），Phase 保持 `playing`，不得卸载 `PlayerView`、不得销毁媒体元素；失败保持原线路并提示。
- **FR-007**：播放面 MUST 可最小化为可拖动悬浮窗，切换仅改变外壳定位/尺寸，不得改变 `PlayerView` 子树结构（避免重挂中断播放）。
- **FR-008**（2026-11-18 修订，身份覆盖层）：playing 相位的身份信息 MUST 由 PlayerView 顶栏覆盖层承担，外壳 MUST NOT 再渲染独立 header ——
  - 左上：返回图标 Button（`aria-label=退出播放`，走协调器 `close` 统一收口）+ 品牌常量 `映岬 Cinecape`；
  - 右上：状态行（直播 = 绿点 + `正在直播` 文字 + 频道 logo（`posterRef` 缺省回退首字徽标）；点播 = `Chip` `点播`），标题（直播取当前节目标题，缺省回退频道标题；点播取影片标题），元数据（直播 `频道名 · HH:mm–HH:mm`；点播 `点播`），直播描述最多两行；
  - 直播节目元数据 MUST 经既有公共端点 `GET /public/media/{mediaId}/programmes`（`useAppQuery` + `queryKeys.public.channelProgrammes(mediaId)`，public 域、staleTime 30s、仅直播且已知频道 id 时 enabled）取得；只读进度与时刻 MUST 以 15s tick 的服务端基准钟（`useServerNow`，未校准回落响应 `data.now`）计算，不得冻结在取数瞬间；`now > current.endsAt` 且存在 `next` 时本地提档；数据不可用或 `status === 'unavailable'` 时 MUST 隐藏第 1 行与描述；MUST NOT 把上游占位文案「暂无节目描述」作为描述呈现；容器 <28rem（手机）时描述 MUST 隐藏，只保留状态/标题/元数据；
  - 身份层常驻可见（身份不是临时 chrome），整层 `pointer-events-none`、仅返回按钮可点；mini MUST NOT 渲染任何覆盖层（上/下均无），只剩外壳级「还原」按钮；
  - unavailable 相位 MUST 保留极简 header（logo + 标题 + 退出）。
- **FR-009**：画面内 MUST NOT 渲染「正在直播」常驻角标与「进度不可保存」常驻提示；直播状态由控制栏 LIVE 胶囊承载。
- **FR-010**：换流入口 MUST 二选一：直播（`isLive`）仅「线路」（`lines.length ≥ 2`），点播仅「换源」；两者不得同时出现。
- **FR-011**（2026-11-18 修订，设置面板改 Popover）：控制栏与设置面板 MUST 保持键盘可达（HeroUI/React Aria 焦点语义），面板限高可滚动，长线路名截断且完整名称进 `aria-label`。设置面板 MUST 为 HeroUI v3 `Popover` 复合组件：portal 渲染并锚定控制栏触发钮（`placement="top end"`、`isNonModal`），Esc 与外部点击 MUST 关闭，390px 全出血面不得被播放器外壳裁切；开关面板 MUST NOT 触媒体元素（FR-023 不中断播放）、MUST NOT 出现跳转完整设置页入口（FR-020 既有不变量不变）。

### HeroUI 能力缺口（约束 5 偏离记录）

自研范围限于「覆盖层容器 / 面板定位 / 悬浮拖动」三类布局行为；播放/暂停、进度、音量、状态芯片、骨架等可交互元素全部复用 HeroUI 组件。逐项对照表（含可用未采用项与技术债登记）见 [ADR-0018 §HeroUI 能力缺口对照](../adr/0018-player-control-surface.md)。

### Key Entities

- **播放意图（Playback Intent）**：`PlaybackTarget{mediaId,title,startMode,lineId?,posterRef?}`；`posterRef` 仅本地展示，不进 resolve 请求体。
- **线路（Stream Line）**：`StreamLineDto{lineId,label,sourceTitle}`，由 resolve 投影，优先级排序；播放器仅消费线路集合。
- **会话面（Session Surface）**：`sessionId / playbackGeneration / playbackUrl / ticketExpiresAt / delivery / presentationStartSeconds`，原地换装时整体替换。
- **目标面（Playback Target）**：同一播放意图内可经 `playRetarget` 改写（原地切台/换线不新建意图），改写与同一批次的会话面 `playPatch` 原子呈现。

---

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**：控制栏隐藏后，鼠标在画面移动 1 次即可唤回（自动化用例覆盖：`player-controls.spec` 3 例全绿）。
- **SC-002**：换线与切台过程中 `[data-testid="playback-surface"]` 与 `video` 节点引用不变，且不出现 `playback-preparing`（2026-11-18 浏览器实测：切台 100ms 采样 surface 恒挂载、video 同一节点、标题由辽宁卫视切到 CCTV-16；自动化 `in-place-zap.spec` 每 20ms 采样相位恒为 `playing`）。
- **SC-003**：mini 播放器宽度 300px，拖动后位置变化 > 100px 且不越界（浏览器实测通过）。
- **SC-004**：设置面板内「线路」与「换源」互斥（浏览器实测：直播 sections = 音轨/字幕/清晰度/线路）。
- **SC-005**：全量前端测试通过（2026-11-18：90 文件、593 通过 / 1 跳过，共 594；新增 3 例控制栏两行/只读节目进度/身份层断言），`tsc --noEmit` 与 eslint 零告警。
- **SC-006**（2026-11-18）：操作台布局在真实浏览器成立 —— 1440×900 与 390×844 下视频满铺卡片、顶栏身份层存在且外壳无 header、直播第 1 行起止时刻 + `progressbar`（节目进度）、第 2 行 `LIVE · 正在直播` Chip、控制栏无横向溢出；mini 只剩 1 个「还原播放器」按钮。节目元数据缺失时第 1 行与描述均不渲染。

### 证据索引（实现与验证留痕）

| 能力 | 实现 | 测试/证据 |
|---|---|---|
| 自绘控制栏 | `apps/web/src/features/playback/player-controls.tsx` | `test/playback/player-controls.spec.tsx` |
| 引擎控件关闭 | `video-player.tsx`（`nativeControls`） | 浏览器实测 vjs-control-bar `display:none` |
| 控制栏接线/设置收敛 | `player-view.tsx`、`playback-settings-overlay.tsx`（HeroUI `Popover`） | `test/vod-switch.spec.tsx`（换源入口经设置）；`test/playback/playback-settings.spec.tsx`（Popover Esc/外部点击关闭、开关零媒体副作用） |
| 播放设置 Popover 锚定与常显 | `playback-settings-overlay.tsx`（`Popover.Content`+`Dialog`）、`player-controls.tsx`（`keepVisible`） | `test/playback/player-controls.spec.tsx`（keepVisible 期间不自动隐藏）；浏览器实测 1440×900 / 390×844：面板右缘与齿轮对齐（0/1px）、间距 8px、`role=dialog` 名「播放设置」、Esc/外部点击关闭、视频 `paused=false`、面板开启 >3.6s 控制栏仍可见 |
| 原地换线/切台 | `action-coordinator.tsx`（`switchSessionInPlace` + `playRetarget`） | `test/features/live/in-place-zap.spec.tsx`；浏览器实测（播放面不重建） |
| 直播切台面板 | `features/live/components/LiveGuidePanel.tsx` | 浏览器实测 14 行含进度、点击切台（原地换装，播放面不卸载） |
| mini 播放器 | `action-coordinator.tsx`（`minimized`/拖动） | 浏览器实测 300×200、拖动生效 |
| 身份覆盖层（019 操作台） | `player-view.tsx`（`[data-testid=player-identity]`） | 浏览器实测 1440/390：顶栏存在、外壳无 header、返回/品牌/标题/元数据可见 |
| 两行控制栏与只读节目进度 | `player-controls.tsx`（`ProgressBar`/`Chip`） | `test/playback/player-controls.spec.tsx`；浏览器实测第 1 行 `progressbar` + 起止时刻、第 2 行 LIVE Chip |
| 直播节目元数据 | `player-view.tsx` + `queryKeys.public.channelProgrammes` | 浏览器实测（直播顶栏标题/元数据/描述）；jsdom 覆盖缺失隐藏（无占位文案） |
| unavailable 极简 header | `action-coordinator.tsx` | `test/live-authorize-rejection.spec.tsx`；浏览器实测失败态仍有身份与退出 |

---

## Assumptions

- 换线依赖 `POST /playback/resolve` 支持同 `mediaId` 指定 `lineId`（016 既有契约），本规格不新增接口。
- 切台复用既有公共分区接口 `GET /public/live/channels?section=now`，不新增端点。
- 顶栏节目元数据复用既有公共接口 `GET /public/media/{mediaId}/programmes`（005 契约，返回 `now`/`timezone`/`current`/`next`/`status`），不新增端点、不新增依赖。
- mini 播放器尺寸按「宽 300 × 高约 171（16:9 画面 + 边框，无头部/控制栏）」实现；如需竖版另行修订。
- 播放进度/心跳/票据续期等既有播放协议语义不因控制面重构而改变。

## Out of Scope

- 播放器手势（双击全屏/滑动调音量）、画中画（PiP）、播放速度。
- mock 上出现但域内无数据/引擎支撑的控件，**有意不实现**：上一集/下一集（无相邻集编排动作）、倍速（引擎无 rate 通道）、清晰度徽标（无质量端点，现有清晰度仅供设置面板只读展示）、CC 按钮（字幕切换在「播放设置」内，避免双入口）、PiP（浏览器/引擎未接入）。
- 连播开关的 UI 入口（v1 只做直播，连播与场景无关；组件与偏好 Provider 保留）。
- 跨源「换源」候选在直播下的语义细化（当前直播以「线路」为唯一换流入口）。