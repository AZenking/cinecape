# Feature Specification: 播放面 Modal 化（全局弹层 · 路由切换不掉）

**Feature Branch**: `009-playback-modal`

**Created**: 2026-10-29

**Status**: Verified（2026-10-29：Accepted 后同次会话完成实施与验收——SC-101/102 单元测试 2 用例绿（路由切换不掉/防误关/统一退出/标题层级）、SC-103 全量 29 文件 175 用例 + typecheck + lint 绿、SC-104 e2e 选择器核对（testid 与 heading level 2 保持，不依赖全屏样式；Playwright 全量留待发布门禁）。证据见 [evidence.md](./evidence.md)。Proposed → Accepted → Verified。）

**Related**: 规格 005（播放闭环，playing 面「全屏挂载」为其 T055 实现决策——本规格仅收编其**呈现形态**为 Modal，播放语义/进度/票据/退出路径全部不变）；ADR-0013（前端数据层与 HeroUI UI 基建）；宪章技术约束 5（弹层必须 HeroUI）。

## 需求（维护者指令逐条映射）

- **FR-001 Modal 呈现**：playing/unavailable 播放面由 `fixed inset-0` 全屏层改为 HeroUI `Modal`（复合 API `Modal.Root/Backdrop/Container/Dialog/Header/Body`，与协调器既有受控 Modal 及 PasswordConfirmModal 同族实现），居中、非全屏、带遮罩，页面在弹层后可见。
- **FR-002 全局性**：Modal 挂载于 `ActionCoordinator`（`AppProviders` 内、路由树之外），不新建路由面（维持 005「不另建路由」决策）；弹层状态属协调器唯一状态机（T053），不引入第二全局状态。
- **FR-003 路由切换不掉**：React Router 路由切换（含 `/`、`/vod`、`/media/:id`、`/live`、`/settings/*` 间任意跳转）不卸载播放面——视频元素、心跳、进度上报、票据续期在导航期间连续。结构保证：协调器包裹 `children`（=Routes），播放面渲染于路由元素之外。
- **FR-004 显式关闭**：播放为长时会话——遮罩点击与 Esc **不**关闭（`ModalBackdrop isDismissable={false}`）；关闭仅经「退出」按钮走既有 `close()` 路径（playEnd + finalProgress flush + 会话卫生清理，语义与 005 完全一致）。
- **FR-005 尺寸与自适配**：Dialog 宽度 `min(94vw, 1120px)` 级响应式上限；Body 为 `aspect-video` 黑底容器承载 PlayerView（`h-full w-full` 假设不变）；标题栏与 unavailable 拒绝面同容器呈现。
- **FR-006 可访问性**：`role="dialog"` + `aria-label="播放 {标题}"`（HeroUI Dialog 原生），标题经 `Modal.Heading`；焦点圈闭于弹层（RAC 默认）。

## 修正案 A（2026-10-29，「设置入口没了」事故裁决）

**FR-001 修订**：播放面呈现由「HeroUI Modal 组件」修订为「**非模态浮层面板**（fixed 居中 div + HeroUI Button + 语义 token，与 preparing 浮动面板同一先例）」。裁决依据（实施实测）：

1. `Modal.Backdrop`（模态链）经 react-aria `useModalOverlay` 把弹层外**全部内容 aria-hidden + inert**（`shouldUseInert: true`）——播放期间导航、身份菜单、设置入口被浏览器级禁用，直击维护者核心诉求（页面继续可用）；
2. `Modal.Root` 为 DialogTrigger 型（Pressable 触发器语义 + 包装层），不适配无触发器的常驻受控浮层（其包装层连带引入整页 aria-hidden 包装）；
3. `Modal.Container` 类型层面 `Exclude` 掉 `isOpen`（假定 state 来自 Root context），standalone 受控不受类型支持。

宪章约束 5 合规说明：播放浮层为媒体容器（与 video.js 播放器同一豁免逻辑），非表单类模态对话框；面板内可交互控件（退出/关闭按钮）仍为 HeroUI Button，样式全部语义 token（border-border/bg-black/text-foreground），未引入第二套硬编码色值。

**FR-004 修订**：防误关由「isDismissable=false」改为「非模态无 dismiss 通道」（无遮罩可点、无 Esc 处理），关闭语义不变（仅「退出」→ close()）。

## 非目标

- 不改播放语义（resolve/prepare/heartbeat/进度/换票/退出路径）、不改任何 API、不改 preparing 浮动面板（已是非阻塞角标）。

## 验收标准（SC）

- **SC-101** 单元测试：playing 态下路由切换（Link 导航至其他路由）后 `playback-surface` 仍挂载、video 元素存活、协调器 playback 状态不变。
- **SC-102** 单元测试：遮罩点击不触发关闭（surface 仍在）；「退出」按钮触发后 surface 卸载且走 close 路径（既有断言路径回归）。
- **SC-103** 既有播放测试全绿（use-play-action 等，testid `playback-surface` 保持）；typecheck/lint 绿。
- **SC-104** e2e 既有播放场景回归（playback-intent 等，DOM 断言不依赖全屏样式——实施时核对选择器）。
