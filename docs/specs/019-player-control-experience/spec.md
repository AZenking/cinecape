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

### User Story 1 - 观众在播放器内用一条 HeroUI 控制栏完成全部高频操作 (Priority: P1)

观众打开任意频道/影片，播放器底部只有一条控制栏：播放/暂停、直播状态或播放进度、设置、音量、全屏、最小化。控制栏在播放中 3 秒无操作自动隐藏，鼠标在画面任意位置移动或键盘聚焦即重新出现；指针停在控制栏上时不自动隐藏。所有控件基于 HeroUI v3 与语义 token，图标统一 `lucide-react`。

**Why this priority**: 原生 video.js 控件与页面视觉体系割裂，且四角浮动按钮（换源/设置/线路）散落、遮挡画面。

**Independent Test**: 打开直播播放面 → 控制栏存在且含 `播放/直播状态/播放设置/音量/全屏/最小化`；3 秒无操作隐藏；鼠标移到画面唤回；指针停留不消失。

### User Story 2 - 直播观众在播放器内直接切台 (Priority: P1)

直播控制栏点击「节目单」图标，在播放器内部呼出「正在直播」列表：每行含频道标识、频道名、当前节目、时段与实时播出进度条；点击任意行立即切到该频道并自动关闭面板；当前频道行标注「当前」且不可重复点击。

**Why this priority**: 切台是直播最高频动作，退出播放器回频道列表再播的路径过长。

**Independent Test**: 直播播放中打开面板 → 行数 > 0、每行有进度；点击非当前行 → 播放目标切换、面板关闭、播放面保持挂载。

### User Story 3 - 换流不中断画面（原地换装） (Priority: P1)

观众在多线路频道切换线路（设置面板内「线路」），或在点播中点「换源」选候选：播放器**不卸载、媒体元素不销毁、不回到「准备中」黑屏**，仅在新流就绪后原地换源续播；失败时保持原线路继续播放并给出提示。

**Why this priority**: 原实现换线走「新 resolve → 新 session → PlayerView 重建」，表现为播放器关闭后重播，体验断裂。

**Independent Test**: 切换线路 → 播放面节点（`[data-testid=playback-surface]`）不重建、`video` 元素保持、目标线路更新；失败路径保持原线路播放。

### User Story 4 - 播放面可最小化为可拖动的 mini 播放器 (Priority: P2)

观众点击控制栏「最小化」，播放面收起为约 300×200 的右下角悬浮窗；标题栏作为拖动手柄，可自由拖动并按视口边界约束；「还原」回到大窗；关闭播放时复位。切换过程不中断播放。

**Independent Test**: 最小化 → 尺寸/位置为右下角；拖动标题栏 → 位置变化且不越界；还原 → 恢复居中大窗；`video` 元素全程未重建。

### User Story 5 - 播放面只保留身份信息与单一换流入口 (Priority: P2)

播放面头部仅呈现「频道 logo + 频道名」与「退出」；线路、连播、最小化等控件全部收进控制栏/设置。画面内不再有「正在直播」角标与「进度不可保存」常驻提示。换流入口二选一：直播只给「线路」，点播只给「换源」，不并列。

**Independent Test**: 头部按钮仅「退出播放」；设置面板 sections 中「线路」与「换源」不同时出现；画面内无 `live-status` / `progress-unsavable` 节点。

### Edge Cases

- 直播流无时长（`durationSeconds === null`）→ 控制栏不渲染进度条，改 LIVE 胶囊；不出现「进度不可保存」提示。
- 单线路频道（`lines.length < 2`）→ 设置内不渲染「线路」区块；点播不渲染「线路」，直播不渲染「换源」。
- 线路切换进行中重复点击 → 去重（在途忽略）；切换失败 → 原线路继续播放 + Toast 提示，不降级为不可播面。
- mini 态拖动越界 → clamp 到视口内（最小 8px 边距）。
- 无媒体实现环境（jsdom）/自动播放被拒 → 控制栏仍渲染，状态以媒体元素事实为准。
- 播放器内面板打开时视频继续播放（非模态覆盖层），不 aria-hidden 播放器。

---

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**：控制栏 MUST 由 HeroUI v3 组件与语义 token 构成，禁用 video.js 原生控制条（`display:none`），底层仍使用同一 `<video>` 元素。
- **FR-002**：控制栏 MUST 提供 播放/暂停、直播状态（LIVE 胶囊）或进度条、音量、全屏、最小化；进度条仅在点播且 `duration > 0` 时渲染。
- **FR-003**：控制栏 MUST 在播放中 3 秒无操作后隐藏，且在**播放器容器**（非控制栏自身）监听指针移动/按下/触摸以唤回；指针停留控制栏期间不得隐藏；暂停态保持可见。
- **FR-004**：直播控制栏 MUST 提供「节目单」入口，在播放器内部以 `role="dialog"` 覆盖层呈现全频道当前节目列表，含实时进度、当前频道标记与一键切台。
- **FR-005**：切台 MUST 经统一播放入口发起（`usePlayAction`），面板在切台后自动关闭；同一频道行不得重复触发。
- **FR-006**：换线 MUST 在**同一播放意图**内完成（resolve → prepare → 换票 → 仅 patch 会话面），Phase 保持 `playing`，不得卸载 `PlayerView`、不得销毁媒体元素；失败保持原线路并提示。
- **FR-007**：播放面 MUST 可最小化为可拖动悬浮窗，切换仅改变外壳定位/尺寸，不得改变 `PlayerView` 子树结构（避免重挂中断播放）。
- **FR-008**：播放面头部 MUST 仅呈现「频道/影片 logo + 名称」与「退出」；logo 缺省时回退首字徽标。
- **FR-009**：画面内 MUST NOT 渲染「正在直播」常驻角标与「进度不可保存」常驻提示；直播状态由控制栏 LIVE 胶囊承载。
- **FR-010**：换流入口 MUST 二选一：直播（`isLive`）仅「线路」（`lines.length ≥ 2`），点播仅「换源」；两者不得同时出现。
- **FR-011**：控制栏与设置面板 MUST 保持键盘可达（HeroUI/React Aria 焦点语义），面板限高可滚动，长线路名截断且完整名称进 `aria-label`。

### HeroUI 能力缺口（约束 5 偏离记录）

自研范围限于「覆盖层容器 / 面板定位 / 悬浮拖动」三类布局行为；播放/暂停、进度、音量、状态芯片、骨架等可交互元素全部复用 HeroUI 组件。逐项对照表（含可用未采用项与技术债登记）见 [ADR-0018 §HeroUI 能力缺口对照](../adr/0018-player-control-surface.md)。

### Key Entities

- **播放意图（Playback Intent）**：`PlaybackTarget{mediaId,title,startMode,lineId?,posterRef?}`；`posterRef` 仅本地展示，不进 resolve 请求体。
- **线路（Stream Line）**：`StreamLineDto{lineId,label,sourceTitle}`，由 resolve 投影，优先级排序；播放器仅消费线路集合。
- **会话面（Session Surface）**：`sessionId / playbackGeneration / playbackUrl / ticketExpiresAt / delivery / presentationStartSeconds`，原地换装时整体替换。

---

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**：控制栏隐藏后，鼠标在画面移动 1 次即可唤回（自动化用例覆盖：`player-controls.spec` 3 例全绿）。
- **SC-002**：换线过程中 `[data-testid="playback-surface"]` 与 `video` 节点引用不变（浏览器实测：切台后面板关闭、播放面仍在、目标已更新）。
- **SC-003**：mini 播放器宽度 300px，拖动后位置变化 > 100px 且不越界（浏览器实测通过）。
- **SC-004**：设置面板内「线路」与「换源」互斥（浏览器实测：直播 sections = 音轨/字幕/清晰度/线路）。
- **SC-005**：全量前端测试通过（2026-11-12：84→85 文件、570 通过 / 1 跳过），`tsc --noEmit` 与 eslint 零告警。

### 证据索引（实现与验证留痕）

| 能力 | 实现 | 测试/证据 |
|---|---|---|
| 自绘控制栏 | `apps/web/src/features/playback/player-controls.tsx` | `test/playback/player-controls.spec.tsx` |
| 引擎控件关闭 | `video-player.tsx`（`nativeControls`） | 浏览器实测 vjs-control-bar `display:none` |
| 控制栏接线/设置收敛 | `player-view.tsx`、`playback-settings-overlay.tsx` | `test/vod-switch.spec.tsx`（换源入口经设置） |
| 原地换线 | `action-coordinator.tsx`（`lineSwitchInPlace` 逻辑） | 浏览器实测（播放面不重建） |
| 直播切台面板 | `features/live/components/LiveGuidePanel.tsx` | 浏览器实测 14 行含进度、点击切台 |
| mini 播放器 | `action-coordinator.tsx`（`minimized`/拖动） | 浏览器实测 300×200、拖动生效 |
| 头部精简 | `action-coordinator.tsx` 播放面 header | 浏览器实测：仅「退出播放」 |

---

## Assumptions

- 换线依赖 `POST /playback/resolve` 支持同 `mediaId` 指定 `lineId`（016 既有契约），本规格不新增接口。
- 切台复用既有公共分区接口 `GET /public/live/channels?section=now`，不新增端点。
- mini 播放器尺寸按「宽 300 × 总高约 200（16:9 画面 + 控制栏）」实现；如需竖版另行修订。
- 播放进度/心跳/票据续期等既有播放协议语义不因控制面重构而改变。

## Out of Scope

- 播放器手势（双击全屏/滑动调音量）、画中画（PiP）、播放速度。
- 连播开关的 UI 入口（v1 只做直播，连播与场景无关；组件与偏好 Provider 保留）。
- 跨源「换源」候选在直播下的语义细化（当前直播以「线路」为唯一换流入口）。