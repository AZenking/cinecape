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

1. **自绘 HeroUI 控制栏，关闭引擎原生控件**
   新增 `PlayerControls`，以 HeroUI `Button`/`Slider` 实现播放/暂停、进度、音量、全屏、最小化；`VideoPlayer` 增加 `nativeControls` 开关（默认 true，播放面传 false），底层仍使用同一 `<video>` 元素，媒体事件与 `currentTime`/`paused` 语义不变。控制栏 3 秒自动隐藏，唤出监听挂在**播放器容器**（隐藏态控制栏自身 `pointer-events-none`，只挂栏内会导致「隐藏后再也唤不出」）。

2. **低频动作收敛到「播放设置」**
   线路切换、换源从控制栏移入设置面板（音轨/字幕/清晰度之后）。控制栏只保留高频道具。

3. **换流入口二选一**
   直播（`durationSeconds === null`）只给「线路」（`lines.length ≥ 2`）；点播只给「换源」。同一时刻只存在一个换流入口，避免「线路 vs 换源」并列造成的语义重复。

4. **原地换流（不重建播放器）**
   `handleManualLineSelect` 改为**同 intentId 内**：resolve 新线路 → prepare 轮询 → 换票 → 仅 patch 会话面（`sessionId`/`playbackUrl`/`ticketExpiresAt`/`delivery`/`lines`/`selectedLineId`），**不写 `phase`**，保持 `playing`。旧会话在换装成功后 best-effort `stop`。失败保持原线路继续播放并 Toast 提示；在途去重。

5. **播放器内直播切台面板**
   新增 `LiveGuidePanel`：控制栏「节目单」icon 呼出全频道当前节目列表（复用 `GET /public/live/channels?section=now`），每行含频道标识、节目名、时段与实时进度（服务端基准钟 15s tick），点击经统一 `play()` 切台并自动关闭；面板为播放器内非模态覆盖层，关闭态零请求。

6. **mini 播放器**
   播放面可最小化为 300×200 悬浮窗；拖动以标题栏为手柄、指针捕获 + 视口 clamp；切换仅改外壳定位/尺寸，**不改变 `PlayerView` 子树结构**，避免重挂中断播放。

7. **播放面头部只留身份与退出**
   头部呈现「频道/影片 logo + 名称」+「退出」；`posterRef` 经 `PlayActionRequest`/`PlayTarget` 透传（仅本地展示，不进 resolve 请求体）。

8. **移除画面内常驻提示**
   删除「正在直播」角标与「进度不可保存」常驻说明；直播状态由控制栏 LIVE 胶囊承载（文字 + 脉冲点，不只靠颜色），进度能力判定仍驱动进度条可用性。

## HeroUI 能力缺口对照（约束 5 要求的偏离记录）

依据 `heroui-react` skill 的组件清单脚本（`scripts/list_components.mjs`，当日返回 73 个组件）与实际文档核对，逐项判定如下。**原则：HeroUI 覆盖的能力一律复用；仅容器/覆盖层/拖动三类布局行为自研。**

| 需要的 UI 能力 | HeroUI 现有能力（3.2.6 实测） | 判定 | 本实现做法 |
|---|---|---|---|
| 播放/暂停、设置、音量、全屏、最小化按钮 | `Button`（`isIconOnly` + `variant`/`isDisabled`） | ✅ 覆盖 | 直接使用 |
| 进度条、音量条 | `Slider`（`value`/`onChange`/`onChangeEnd`/`isDisabled` + `Track/Fill/Thumb`） | ✅ 覆盖 | 直接使用（拖动期本地值、松手写回媒体） |
| 直播状态标识 | `Chip` / `Badge` | ✅ 覆盖 | LIVE 胶囊 = Chip 语义色 + 文字 |
| 面板加载态 | `Skeleton` | ✅ 覆盖 | 切台面板加载骨架 |
| 面板容器视觉 | `Surface` / `Card` | ✅ 覆盖 | 以语义 token 表达（面板为绝对定位覆盖层，未套 Surface 壳） |
| 设置菜单面板 | `Popover`（portal 弹层，支持非模态） | ⚠️ 可用但未采用 | 现为自绘绝对定位弹层（`bottom-full end-0`），功能/键盘等价；**可迁移项，登记为技术债** |
| 切台列表行 | `ListBox`（支持 Section/Virtualizer，Item 可含自定义子节点） | ⚠️ 可用但未采用 | 现为原生 `button` + 行内进度条；行内进度与「当前」标记属自定义内容，迁移收益低，登记为可选优化 |
| 控制栏容器（画面覆盖、自动隐藏、暂停常显） | `Toolbar` 仅为布局分组原语，无播放器覆盖层/自动隐藏语义 | ❌ 无覆盖 | 自研 `PlayerControls` 容器（Button/Slider 仍来自 HeroUI） |
| 播放器内**非模态**覆盖面板（不 portal、不 aria-hidden 播放器、不拦截播放） | `Sheet`/`Drawer` 带 backdrop 与拖拽关闭（模态覆盖）；`Popover` 为 portal 弹层 | ❌ 无覆盖 | 自研 `LiveGuidePanel`（`role="dialog"` + 绝对定位覆盖，播放器保持可交互） |
| 可拖动 mini 悬浮窗（指针捕获 + 视口边界约束） | 无悬浮/拖拽原语（`Sheet` 的拖拽仅限关闭手势） | ❌ 无覆盖 | 自研：外壳定位 + `setPointerCapture` + clamp |
| 视频解码与 HLS 播放 | 无媒体引擎组件 | ❌ 无覆盖（且属引擎层） | 沿用既有 `video.js`（本 ADR 不改引擎选型） |

**自研范围边界**：仅限「覆盖层容器 / 面板定位 / 悬浮拖动」这三类**布局与定位行为**；其中所有可交互元素（按钮、滑块、状态芯片、骨架）均为 HeroUI 组件，样式只用语义 token，图标只用 `lucide-react`。这与约束 5 的例外条款一致，也是本条偏离记录的全部范围。

**版本口径**：skill 文档索引当日为 v3.2.7，仓库实际安装 `@heroui/react`/`@heroui/styles` 3.2.6。按宪章「组件 API 与 token 以安装版本为准」，上表判定以 3.2.6 的类型检查与运行时实测为准；`Slider`/`Button`/`Chip`/`Skeleton` 所用 props 在 3.2.6 均可用（`tsc --noEmit` 与浏览器实测通过）。若后续升级 HeroUI，需按约束 8 走宪章修订记录。

## Consequences

**正**
- 控制面统一为一套 HeroUI 语义视觉，与页面其余部分一致（约束 5/8/9 落地）。
- 换流从「卸载重建」变为「原地换源」，播放中断只剩一次缓冲；`PlayerView` 的进度泵、探针、票据续期随 `sessionId` 变化自然重挂，无需额外生命周期。
- 直播切台路径从「退出→列表→重播」缩短为「面板内一键」；切台数据与直播首页同源，无新增端点。
- mini 播放器让「边看边浏览」成立，且不产生第二套播放器实例。

**负 / 风险**
- 自绘控制栏接管了原生控件的键盘可达性与移动端手势，需持续维护；当前未实现手势与 PiP（见 spec Out of Scope）。
- 原地换流的失败分支只能「保持原线路 + 提示」，无法回滚到中间态；依赖旧会话 stop 的幂等性做卫生清理。
- 自动隐藏的可发现性依赖容器级监听，属易回归点（已用单测钉住）。
- 头部去掉线路/连播后，连播开关在 v1 无 UI 入口（偏好 Provider 与其持久化仍在），若后续开放点播需补回入口。

**被否方案**
- 保留 video.js 原生控件、仅把浮动按钮挪进底部条：改动小，但控制条样式仍与 HeroUI 割裂，不满足约束 8 的视觉一致性要求。
- 换流继续走 `launchPlayback`（重建播放器）：实现最省事，但正是本次要消除的体验断裂。
- 引入第三方 EPG/时间轴库（如 Planby）承载播放器内列表：许可为 Custom License 且会引入 emotion/date-fns，仓库既有决策明确不纳入（见 `docs/frontend-home-live-epg-design.md` §6.3）。

## Verification

- 单元：`test/playback/player-controls.spec.tsx`（隐藏/唤回/悬停不隐藏/暂停可见）、`test/vod-switch.spec.tsx`（换源入口经设置）、`test/playback/playback-settings.spec.tsx`（直播态无角标、设置面板）。
- 运行/浏览器：控制栏 7 控件、vjs 控制条 `display:none`、mini 尺寸与拖动、切台面板 14 行含进度且切台生效、头部仅「退出播放」、设置面板线路/换源互斥。
- 全量：`pnpm --filter @hmp/web exec vitest run` → 570 通过 / 1 跳过；`tsc --noEmit`、eslint 零告警。