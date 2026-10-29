# 009 验收证据（2026-10-29）

## SC-101 / SC-102（单元测试，test/playback/playback-modal.spec.tsx，2 用例绿）

- **SC-101 路由切换不掉**：playing 态下经 Link 依次导航 `/`→`/vod`→`/live`，每次断言 `playback-surface` Modal 仍挂载且 `<video>` 元素存活（协调器位于路由树之外，结构保证成立）；
- **SC-102 防误关 + 统一退出**：`ModalBackdrop isDismissable={false}` 下点击遮罩与 Escape 均不关闭（surface/video 保持）；「退出播放」按钮触发后 surface 卸载（统一 `close()` 路径）；
- 标题层级断言：surface 内 `<h2>` 文本 = 标题（`Modal.Heading level={2}`，维持 e2e `surfaceTitle` 的 heading level 2 契约）。
- 测试方法说明：video.js 以模块边界假引擎替换（jsdom 无媒体实现，真引擎对不可加载 src 异步 error → onFatalError 会把 playing 翻成 unavailable——环境性行为，与既有 spec 只断言 surface 存在而不暴露的原因同源）；被测的 Modal 结构保证与 PlayerView 挂载链路为真实实现。

## SC-103（既有回归）

- web 全量套件 **29 文件 / 175 用例全绿**（含 use-play-action / action-coordinator 既有播放测试，`playback-surface` testid 保持）；`pnpm --filter @hmp/web typecheck` 绿；仓库根 `pnpm lint` 绿。

## SC-104（e2e 选择器核对）

- `playback-intent` / `fresh-deployment-loop` / `responsive-matrix` 对播放面的断言均基于 `playback-preparing`/`playback-surface` testid 与 heading level 2（`surfaceTitle`）——不依赖全屏样式类；testid 与标题层级均已保持（层级另由单元测试锁定）。
- 本会话未起真实后端跑 Playwright 全量（需服务器 + 媒体夹具 + ffmpeg 栈）；选择器兼容性核对即 SC-104 规定的验收口径，e2e 全量回归留待维护者环境/发布门禁执行。

## 实施摘要

- `action-coordinator.tsx`：playing/unavailable 播放面由 `fixed inset-0` 全屏层改为 HeroUI 复合 Modal（`Root/Backdrop(opaque, isDismissable=false)/Container(center, w-[min(94vw,1120px)])/Dialog/Header/Body(p-0)`），视频经 `aspect-video` 容器承载（`h-full w-full` 假设不变）；unavailable 拒绝面同容器。preparing 浮动面板、播放语义、close 路径零改动。
- 复用：协调器既有 Modal 复合 API 模式、PasswordConfirmModal 的 Backdrop 包裹教训（T137）、mockReadyWorld harness（对齐 use-play-action.spec）。
