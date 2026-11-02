# Tasks: Apple 风格直播与设置体验——统一播放链路与布局分组（012-live-settings-experience）

**Input**: [spec.md](spec.md)（含 Clarifications Q1–Q3）、[plan.md](plan.md)、[research.md](research.md)、[data-model.md](data-model.md)、[contracts/](contracts/)、[quickstart.md](quickstart.md)。
**Created**: 2026-11-01
**Status**: Proposed 任务分解；本次只生成清单，全部未执行，不授权改代码、提交或部署。
**Prerequisites**: 先核验 spec 已由维护者接受（T001 门禁）；接受前不执行任何实现项。工作区无关 dirty 改动必须保留。
**Tests**: 宪章原则一与 spec SC-001–SC-009 要求测试/负向/运行证据；各故事测试先行（先观察合理失败，再实现转绿），不用 skip 掩盖未实现。服务端零新增义务（[api-reuse.md](contracts/api-reuse.md) §4），验收面为 web vitest + Playwright e2e + 人工走查。
**Organization**: Setup → Foundational → US1/US2/US3/US4（P1–P4）→ US5（P5）→ Final；故事独立验收不等于无实际先后依赖（US4 依赖 US1 的入口接线；US2/US3 依赖 Foundational 的共享面板）。

## Format and Path Conventions

`- [ ] Tnnn [P?] [USn?] 具体工作及精确文件路径（依赖ID）`。路径均相对仓库根；新文件是待创建，不代表已存在。`[P]` 仅表示不同文件、无未完成依赖时可并行；不代表可跳过前置。共享文件（action-coordinator-core、settings-modules、routes）变更必须串行。边界红线（违反即任务无效）：不改 010 点播入口与其验收（Q3）；不改 settings-unlock-gate 验证判定逻辑（归 011）；不新增服务端端点/迁移/偏好项（Q1、api-reuse §2）；意图/滚动不得写 localStorage/sessionStorage（Q2、url-state §5）。

## Phase 1: Setup — 门禁与基线

**Goal**: 锁定授权边界与现状基线，不初始化任何新结构（复用型规格，无脚手架任务）。

**Independent Test / Gate**: T001 未通过时后续任务全部不可执行。
- [X] T001 核验 `docs/specs/012-live-settings-experience/spec.md` 已由维护者明确接受并记录依据（Accepted）；仍为 Proposed 则停止后续实现，不因本清单或命令自动改状态。同时核对 ADR-0011 与 011 的替代关系现状未变、点播（010）与设置验证（011）边界未被本清单越界。
  **完成记录（2026-11-01）**：维护者在实施会话对 T001 门禁询问明确选择「接受并开始实施」；spec.md Status 已更新为 Accepted（含接受记录），状态流转为维护者显式授权，非自动变更。ADR-0011/011 关系与 010/011 边界核对无越界。
- [X] T002 [P] 记录现状基线证据到 `apps/web/evidence/`（新建目录）：运行 `pnpm lint`、`pnpm typecheck`、`pnpm --filter @hmp/web test`、`pnpm --filter @hmp/server test:unit`、`pnpm --filter @hmp/server test:contract` 并记录结果；基线必须全绿，非绿项先行修复或在本清单登记缺陷（不默认属于 012 范围）。

## Phase 2: Foundational — 共享面板与测试夹具（阻塞 US2/US3 及各故事测试）

**Goal**: 建立两处详情合一的共享内核与测试夹具；不在此实现任何故事专属页面。

**Independent Test / Gate**: 共享面板组件以单测驱动可独立渲染六要素；夹具可让游客/已选档两种会话在 vitest/e2e 中复现。

### Required Tests First
- [X] T003 [P] 先新增 `apps/web/test/components/programme-detail-panel.spec.tsx`：六要素渲染（频道名/标识、标题/简介、起止时间+时长含家庭时区标注、四状态 now/upcoming/ended/none、主操作仅 now 可用、次操作收藏+查看节目单）、Escape 关闭回触发焦点、打开时焦点入面板、刷新数据更新不关闭面板（ui.md §2）。先确认失败再实现。
- [X] T004 [P] 扩充 `apps/web/test/` 会话夹具：游客/已登录未选档/已选档三态会话工厂（复用 session-provider 测试模式）、now/upcoming/ended/none 四状态节目与多频道分组数据桩、Network 断言工具（统计 playback//me 请求次数，供零请求负向断言复用）（依赖：T002）。

### Shared Implementation
- [X] T005 从 `apps/web/src/features/epg/ProgrammeDetailPanel.tsx` 提取共享节目详情面板到 `apps/web/src/features/shared-programme/ProgrammeDetailPanel.tsx`（或按勘察并入 live 侧，二选一记录于代码注释），行为契约 = ui.md §2 + T003 单测；抽屉/浮层呈现、底层页面保持可见、焦点管理遵循 009 惯例与 `--hmp-focus-ring-*` token（依赖：T003）。完成后将**实际落点路径回填**本清单与 plan.md 项目结构（分析 U2）。

**Checkpoint**: 共享面板单测全绿；夹具就绪——US1–US5 可开始。

## Phase 3: User Story 1 — 游客可浏览，播放一次打通登录、选档与授权（P1）🎯 MVP

**Goal**: 全部直播播放入口经 usePlayAction 统一链路；游客意图保存并在登录/选档后回到原目标；授权前零媒体流请求。

**Independent Test**: 游客从直播首页/EPG/首页三类入口点击播放，完成登录选档后回到原目标并直接授权播放（quickstart 场景 1）；全程 Network 面板授权前零 `playback/*`、零 `/me/*` 请求。

### Tests for User Story 1 (REQUIRED) ⚠️
- [X] T006 [P] [US1] 先新增 e2e `apps/web/test/e2e/live-playback-chain.spec.ts`：游客三入口（Now Hero/EPG 频道观看/首页入口）点击播放 → 登录 → 选档 → 回原目标 → 授权播放；断言授权前 playback 与 /me 请求计数为 0；取消登录/选档废弃意图且零写入；刷新后意图丢失可重新点击（FR-004–FR-009、Q2）；并断言 now/next/guide 三入口打开的详情面板**结构与内容一致**（ui.md §2 六要素，SC-002 一致率断言落点）。先确认失败再实现。（依赖：T004）
- [X] T007 [P] [US1] 先新增 `apps/web/test/live-intent-coordinator.spec.tsx`：直播 PlayTarget 填充 intentId/returnTo/entry；代次守卫（旧回调不能起播）；returnTo 白名单拒绝外部路径；意图不含凭据、不写任何浏览器存储（data-model §1 生命周期表逐行断言）（依赖：T004）。

### Implementation for User Story 1
- [X] T008 [US1] 直播入口接线主改：`apps/web/src/features/live/components/GuestActionNotice.tsx` 占位升级——登录按钮接 ActionCoordinator 意图（或按勘察由卡片直接经 usePlayAction 发起、Notice 仅作解释性提示）；`NowSection.tsx`/`NextSection.tsx`/`GroupSections.tsx` 卡片主按钮统一走 usePlayAction，目标语义为「频道此刻内容」（FR-005/FR-006/FR-008）（依赖：T005 无关，T007 通过后实施）。
- [X] T009 [P] [US1] `apps/web/src/features/epg/` 频道观看按钮接入 usePlayAction（播放该频道当前直播而非未来节目，FR-017 后半）；节目块点击行为保持「开面板不播放」（依赖：T007）。
- [X] T010 [P] [US1] `apps/web/src/features/home/` 直播入口核对接线（已用 PlayButton 则仅补 e2e 覆盖；占位则按 T008 模式接入）（依赖：T007）。
- [X] T011 [US1] 收藏行为约束：`apps/web/src/features/live/components/` 各卡片收藏按钮——游客点击仅显示登录引导零请求（GuestActionNotice 或行内提示），已选档仅调 favorites 不触发播放、成功为行内反馈（FR-011、ui.md §1.5）（依赖：T006）。
- [X] T012 [P] [US1] upcoming/ended 节目播放入口禁用：卡片与面板主操作渲染逻辑（now 才有「播放当前频道」；upcoming 主操作=查看详情/节目单；ended=查看详情）（FR-011、ui.md §1.6）（依赖：T005）。
  **Lead 裁决记录（2026-11-01，跨代理协调）**：① live 旧面板 ProgrammeSlotDialog 由 T016 整体删除，**不做过渡修补**（共享面板已按 §1.6 只给 now/none 播放钮，T003 钉面）；② epg 旧面板修补（US1 已完成，live-upcoming-ended-no-play.spec 5/5 绿）在 T022 删除后**覆盖转移**——删除针对旧组件的用例并在注释登记「宿主 status 门 → GuidePage(US3-T022) + 共享面板 T003」；若 US3 宿主测试未覆盖 status 门，终审补钉；③ ChannelTile 收藏块归 T011（US1 会话感知改造），其他任务不动该块；④ live-page.spec.tsx 的 upcoming 面板文案断言属 T016 既有测试更新点（US2）。
- [X] T013 [US1] 授权拒绝体验核对与补缺：拒绝原因在入口上下文展示、保留节目详情、可重试/返回、不暴露内部错误码（FR-007；逐条对照 contracts/ui.md §7；现状核对为主，缺口在 `apps/web/src/app/action-coordinator.tsx` 错误面最小修补）（依赖：T006）。

**Checkpoint**: US1 独立可验收——三入口游客链路 e2e 全绿 + 授权前零请求负向断言通过（MVP 可交付）。

## Phase 4: User Story 2 — 直播首页「正在直播」优先与统一详情面板（P2）

**Goal**: /live 内容顺序与 Hero 语义达标；三区与 EPG 打开同一共享面板；30s 安静刷新零打断。

**Independent Test**: 键盘走查 /live（quickstart 场景 2/3）：内容顺序、卡片行为、三类入口面板一致性、刷新观察 ≥10 分钟零打断；可独立于 US1 验收（面板与卡片行为不依赖授权接线）。

### Tests for User Story 2 (REQUIRED) ⚠️
- [X] T014 [P] [US2] 先新增 `apps/web/test/live-home-structure.spec.tsx`：页面顺序（节目单入口→正在直播→接下来→按类型）、Now Hero 六信息（频道标识/当前节目/直播状态/进度/起止时间/播放按钮）、无节目单频道保留身份（FR-010/FR-012）。先失败再实现。（依赖：T004）
- [X] T015 [P] [US2] 先新增 `apps/web/test/live-quiet-refresh.spec.tsx`：模拟 refreshKey 递增 ×N，断言焦点元素不变、打开的面板不关闭、分区滚动/分页不重置（FR-014、SC-003 自动化面）（依赖：T004）。

### Implementation for User Story 2
- [X] T016 [US2] 直播三区挂载共享面板：`apps/web/src/features/live/components/ProgrammeSlotDialog.tsx` 改为宿主薄壳或删除并直用 `shared-programme/ProgrammeDetailPanel`（research R2 二选一，删除旧组件需同步清理引用）（FR-013）（依赖：T005、T014）。
- [X] T017 [US2] Now Hero 语义核对与补缺：`apps/web/src/features/live/components/NowHero.tsx` 对照 FR-010 六信息与「非点播宣传横幅」（逐条对照 contracts/ui.md §7）；不达标项最小修补（依赖：T014）。
- [X] T018 [P] [US2] 无节目单频道展示：保留频道身份 +「暂无节目单」+ 频道可用时仍可播放当前内容（FR-012；卡片与面板两处）（依赖：T005）。
- [X] T019 [US2] 安静刷新保持验证落地：`apps/web/src/features/live/hooks/use-live-refresh.ts` 语义零改动声明 + T015 断言转绿；若发现打断缺陷，修复落点在分区组件而非 hook（依赖：T015）。

**Checkpoint**: US1+US2 独立可用（MVP+面板统一增量）。

## Phase 5: User Story 3 — EPG 节目单第二入口（P3）

**Goal**: 定位/回到现在/刷新不重置/URL 状态契约达标；节目单挂载共享面板。

**Independent Test**: quickstart 场景 4：首次定位、手动浏览不被拉回、回到现在不清筛选、URL 复制恢复、刷新语义状态保留——可独立验收（不依赖 US1 接线）。

### Tests for User Story 3 (REQUIRED) ⚠️
- [X] T020 [P] [US3] 先新增 `apps/web/test/guide-url-state.spec.tsx`：url-state.md §1 参数表逐项（date/from/channelPage/pageSize/view+筛选：显式变更写 URL、非法值回落缺省不崩溃、刷新恢复、「回到现在」仅改 date/from 保留筛选）（FR-016/FR-018）。先失败再实现。（依赖：T004）
- [X] T021 [P] [US3] 先新增 e2e `apps/web/test/e2e/guide-state-restore.spec.ts`：设置状态 → 刷新 → 语义状态恢复、滚动回缺省（可接受）；节目块点击开面板不播放（FR-017）（依赖：T004）。

### Implementation for User Story 3
- [X] T022 [US3] 节目单挂载共享面板：`apps/web/src/features/epg/GuidePage.tsx` 宿主改用 `shared-programme/ProgrammeDetailPanel`（T005 落点），原 `features/epg/ProgrammeDetailPanel.tsx` 收敛/删除（FR-013）（依赖：T005、T020）。
- [X] T023 [US3] 首次定位与回到现在语义落地：`apps/web/src/features/epg/GuidePage.tsx` + `useGuideWindow.ts`——首次进入定位当前时间附近并显示时区说明；「回到现在」仅恢复今天+当前窗口不清筛选；手动浏览期间自动刷新不拉回（FR-015/FR-016；逐条对照 contracts/ui.md §7）（依赖：T020）。
- [X] T024 [P] [US3] 时区显示核对：`apps/web/src/features/epg/guide-time.ts`/`live-format.ts` 家庭时区标注零改动确认（FR-019），缺口才修补（依赖：T004）。
- [X] T025 [US3] 滚动位置会话内恢复：详情面板返回后恢复节目单滚动与焦点（内存态，不入 URL/storage；刷新回缺省可接受）（FR-018、url-state §1.3）（依赖：T022）。

**Checkpoint**: US1–US3 独立可用。

## Phase 6: User Story 4 — 播放器连续性（P4）

**Goal**: 直播播放器能力清单达标；退出恢复原上下文；切档失效；失败可重试。

**Independent Test**: quickstart 场景 5：从 guide 进入播放后退出恢复 URL/滚动/焦点；切档后旧票据不可用；浮层开关不中断播放。依赖 US1 的入口接线（无接线则无法从直播进入播放）。

### Tests for User Story 4 (REQUIRED) ⚠️
- [X] T026 [P] [US4] 先新增 e2e `apps/web/test/e2e/live-player-continuity.spec.ts`：guide→播放→退出恢复（URL/筛选/滚动/面板状态/焦点、Escape/返回按钮/遮罩三路径）；播放设置浮层开/关不中断播放且无「打开完整设置」入口（FR-021/FR-023）。先确认失败再实现。（依赖：T006）
- [X] T027 [P] [US4] 先新增 `apps/web/test/live-identity-switch.spec.tsx`：切档路径断言——旧播放终止、旧票据不可用（负向：旧票据重放被拒语义挂在 mock/contract 层）、新授权后才继续；复用 006 purgePersonalData 与 010 收口机制，不重写（FR-003/FR-022）（依赖：T004）。

### Implementation for User Story 4
- [X] T028 [US4] 播放器直播能力清单核对与补缺：`apps/web/src/features/playback/player-view.tsx`/`video-player.tsx` 对照 FR-020 六项（频道+节目名、状态进度、切台、字幕/音轨/清晰度、退出、失败原因+重试；逐条对照 contracts/ui.md §7）；缺口最小修补，禁止重写播放面（009 框架不动）（依赖：T026）。
- [X] T029 [US4] 失败重试幂等验证：重试复用同一意图/会话、不产生并行第二会话（FR-020 末项、SC-005；现状核对为主）（依赖：T026）。

**Checkpoint**: US1–US4 独立可用。

## Phase 7: User Story 5 — 设置布局分组与交互规则（P5）

**Goal**: 左侧三组分组 + 作用范围标注；URL 分类/即时生效/二次确认/模块级失败等交互规则达标；访问验证逻辑零改动。

**Independent Test**: quickstart 场景 6：分组渲染与空组隐藏、URL 刷新回原模块、模块级失败重试、四类危险操作确认；窄屏与键盘走查。验证规则（解锁门）不计入本故事验收。

### Tests for User Story 5 (REQUIRED) ⚠️
- [X] T030 [P] [US5] 先新增 `apps/web/test/settings-groups.spec.tsx`：SettingsModuleMeta 分组渲染（三组顺序与成员映射 household=profiles/policy/sources/epg/devices、system=account——边界表「关于与帮助」本期不落位，断言其**不被渲染**，见 FR-025 注记）、家庭管理组标注「需要管理授权」、个人偏好组零支持项时整组不渲染（Q1/FR-024/SC-007）、七条 /settings/{key} 路由与默认 account 不变。先失败再实现。（依赖：T004）
- [X] T031 [P] [US5] 先新增 `apps/web/test/settings-interactions.spec.tsx`：URL 分类保留刷新回原模块、模块级失败仅影响该模块且左侧导航可用可重试、开关/单选即时生效无全页保存按钮、危险操作二次确认（FR-026–FR-028；现状审计型测试，缺什么测什么）（依赖：T004）。

### Implementation for User Story 5
- [X] T032 [US5] `apps/web/src/features/settings/settings-modules.tsx`：`SettingsModuleMeta` 增加 `group: 'personal'|'household'|'system'` 与作用范围标注字段；七模块映射（data-model §4；personal 本期零项不注册虚假模块；「关于与帮助」本期不注册——显式延后，分析 U1/FR-025 注记）（FR-024）（依赖：T030）。
- [X] T033 [US5] `apps/web/src/layouts/SettingsLayout.tsx` 左侧按组渲染分组菜单与范围标注；家庭管理组（即 spec FR-024 之「家庭管理区域」）解锁门行为保持既有（仅展示层，判定逻辑零改动）；窄屏折叠为列表（FR-024/FR-032）（依赖：T032）。
- [X] T034 [US5] 交互规则审计与最小补缺：`apps/web/src/features/settings/` 各模块页对照 FR-026–FR-029（即时生效/局部保存位置/二次确认清单/焦点返回 Profile 菜单；逐条对照 contracts/ui.md §7）；只修行为缺口，不改 011 范围的任务流与验证模型（依赖：T031）。
- [X] T035 [P] [US5] 响应式核对：`apps/web/src/layouts/PublicLayout.tsx` 侧栏与 `SettingsLayout` 折叠断点走查（200% 缩放/低高度保存取消可达），缺口按 DESIGN.md token 修补（FR-032/FR-034）（依赖：T033）。

**Checkpoint**: 全部五故事独立可用。

## Phase 8: Polish & Cross-Cutting

**Purpose**: 跨故事验收、可访问性、证据与文档。

- [X] T036 键盘全流程人工走查（quickstart 场景 7）：主导航→直播→详情→播放/取消→Escape 返回→EPG→设置；逐项记录焦点环可见、非颜色状态表达、Escape 焦点恢复（FR-030–FR-033、SC-008）；**含 FR-001 核对项**：设置仅从 Profile 菜单进入，直播/公共内容一级浏览区无设置入口（分析 E1 回归锚点）。
- [X] T037 [P] a11y 审计：grep 审查新增/触碰组件无硬编码色值/裸焦点样式（宪章第 8 条），状态表达均含文字/图标/形状之一（ui.md §6.1）；输出审计清单到 evidence。
- [X] T038 运行 `docs/specs/012-live-settings-experience/quickstart.md` 全部场景并记录（SC-001–SC-009 逐项对照），失败项回修后复跑。
- [X] T039 汇总证据文档 `docs/specs/012-live-settings-experience/evidence.md`（实现面清单、自动化结果、人工走查记录、Not-run 诚实标注）；spec 状态按 constitution 流转记录（不虚标 Verified）。
- [X] T040 最终静态门与回归：`pnpm lint && pnpm typecheck` + web vitest + e2e + server unit/contract 基线全绿确认（server 零新增零破坏）。

## Dependencies & Execution Order

### Phase Dependencies
- **Setup（T001–T002）**：T001 门禁阻塞一切实现；T002 基线与 T003/T004 可并行。
- **Foundational（T003–T005）**：T005 依赖 T003；阻塞 US2/US3 的面板任务（T016/T022）。T004 夹具阻塞全部测试任务。
- **US1（Phase 3）**：依赖 T004/T007；**US4 依赖 US1 的 T008 接线**（无接线无法从直播进入播放）。
- **US2/US3（Phase 4/5）**：依赖 T005；与 US1 并行无文件冲突（live 卡片主按钮 T008 与面板宿主 T016 都触 live 组件——串行建议：T008 先、T016 后，或按文件分工）。
- **US5（Phase 7）**：完全独立，可随时并行。
- **Polish（Phase 8）**：依赖全部故事完成。

### Parallel Opportunities
- T002/T003/T004（Setup/Foundational 测试与夹具，不同文件）。
- T009/T010/T012（不同入口文件，均只依赖 T007）。
- T014/T015、T020/T021、T026/T027、T030/T031（各故事测试先行可并行）。
- US5 全阶段可与 US1–US4 并行（settings/ 与 live//epg/ 文件零交集）。

## Implementation Strategy

### MVP First（仅 US1）
1. T001 门禁通过 → T002 基线 → T003/T004/T005 Foundational。
2. US1 测试先行（T006/T007 失败）→ T008–T013 转绿。
3. **STOP and VALIDATE**：quickstart 场景 1/2 独立验收——游客链路 + 零请求负向即是最小可交付增量。

### Incremental Delivery
1. MVP（US1）→ 2. US2 面板统一（直播首页体验完整）→ 3. US3（EPG 第二入口达标）→ 4. US4（连续性闭环）→ 5. US5（设置分组）→ 6. Polish 证据与走查。
每步独立可验证，不破坏既有故事；任一步失败回退不影响已交付故事。

### 边界红线复述（每任务实施前自查）
不改 010 点播入口/验收（Q3）；不动 settings-unlock-gate 判定（011）；不新增端点/迁移/偏好项（Q1、api-reuse §2）；意图与滚动不写浏览器存储（Q2）；视觉只用 DESIGN.md/HeroUI 语义 token。

## Notes

- [P] = 不同文件且无未完成依赖；共享文件（action-coordinator-core、settings-modules、routes）变更串行。
- 测试先行的意义：先观察合理失败锚定断言，再实现转绿；禁止用 skip/放宽断言掩盖未实现。
- 每个 Checkpoint 可独立演示；提交按逻辑分组（对齐仓库「按功能提交」惯例）。
- 服务器端零改动是本规格的验收承诺：若实施中发现必须改服务端，走 api-reuse.md §3 升级通道并停下核对门禁。
