# 019 · Tasks（追溯补录：实现已完成，任务按实际交付倒排）

**说明**：本清单为 2026-11-12 播放器迭代的事实性任务记录。所有任务状态均为 `Done`，对应提交已合入 `master`。后续变更需先修订 `spec.md` 再增补任务。

| ID | 任务 | 交付物 | 状态 | 证据 |
|---|---|---|---|---|
| T001 | 自绘 HeroUI 控制栏（播放/暂停、进度、音量、全屏、最小化） | `apps/web/src/features/playback/player-controls.tsx` | Done | `test/playback/player-controls.spec.tsx`；提交 `15d21b8` |
| T002 | 引擎原生控件开关（`nativeControls`），播放面传 false | `video-player.tsx` | Done | 浏览器实测 `.vjs-control-bar` `display:none`；`15d21b8` |
| T003 | 控制栏接线：设置/换源/线路/节目单收拢，移除四角浮动 | `player-view.tsx` | Done | `15d21b8` |
| T004 | 控制栏自动隐藏 + 容器级唤回（修复隐藏后无法唤出） | `player-controls.tsx` | Done | `player-controls.spec`（隐藏→唤回/悬停不隐藏/暂停可见）；`0978765` |
| T005 | 直播切台面板（全频道当前节目 + 进度 + 一键切台） | `features/live/components/LiveGuidePanel.tsx` | Done | 浏览器实测 14 行含进度、切台后面板关闭；`15d21b8` |
| T006 | 原地换流（同 intentId，保持 playing，不重建播放器） | `app/action-coordinator.tsx` | Done | 浏览器实测播放面不重建；`15d21b8` |
| T007 | mini 播放器（300×200，可拖动，视口 clamp） | `app/action-coordinator.tsx` | Done | 浏览器实测 300×200 + 拖动位移；`15d21b8` |
| T008 | 播放面头部精简为「logo + 频道名 + 退出」，`posterRef` 透传 | `action-coordinator.tsx`、`action-coordinator-core.ts`、`LiveHeroPlayer`/`ChannelTile`/`LiveGuidePanel` | Done | 浏览器实测头部仅「退出播放」、logo 图片加载；`292e09c`、`cf48371` |
| T009 | 移除画面内「正在直播」角标与「进度不可保存」常驻提示 | `player-view.tsx` | Done | 两处 `data-testid` 节点不再存在；`3da9c55` |
| T010 | 换流入口二选一（直播=线路 / 点播=换源），面板限高与线路名截断 | `playback-settings-overlay.tsx` | Done | 浏览器实测 sections 互斥、面板可滚动；`6ca93d8`、`761d3ab` |
| T011 | 测试适配与新增单测（控制栏、设置收敛、直播态无角标） | `apps/web/test/**` | Done | 全量 570 通过 / 1 跳过 |
| T012 | 补录规格与 ADR（本文件、`spec.md`、ADR-0018） | 本目录 + `docs/adr/0018-*` | Done | 本提交 |

## 未完成 / 后续候选

- 播放器手势（双击全屏、滑动调音量）、PiP、倍速 — 未在本轮范围。
- 连播开关的 v1 UI 入口（当前随 v1 只做直播移除，Provider 与持久化保留）。
- 跨源换源在直播语义下的细化（当前直播以「线路」为唯一换流入口）。