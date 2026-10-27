# Tasks: PC 端 UI 组件与数据请求架构全面调整（HeroUI + 统一数据层 + 共享 Hooks）

**Input**: Design documents from `/docs/specs/006-heroui-react-query-refactor/`

**Prerequisites**: plan.md (required), spec.md (required for user stories), research.md, data-model.md, contracts/, quickstart.md

**Tests**: Tests are REQUIRED by the project constitution. Include unit and integration contract tests, permission/input-tampering negative tests, runtime and network/backend evidence, and migration rollback verification where applicable. Map acceptance criteria to evidence; do not mark Verified before required checks pass.

**Organization**: Tasks are grouped by user story to enable independent implementation and testing of each story.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: Which user story this task belongs to (e.g., US1, US2, US3)
- Include exact file paths in descriptions

## Path Conventions

- 本特性仅涉及 monorepo 内 `apps/web/`（前端呈现层），测试位于 `apps/web/test/`（vitest）与 `apps/web/test/e2e/`（Playwright）
- 设计文档位于 `docs/specs/006-heroui-react-query-refactor/`；ADR 位于 `docs/adr/`

<!-- 泳道说明：US1 只动组件文件与对应测试；US2/US3 只动数据层与页面数据接入；US4 只动共享 hooks。同一文件的任务已显式排依赖，见 Dependencies。 -->

---

## Phase 1: Setup (Shared Infrastructure)

**Purpose**: 治理门禁、基线与依赖——实现工作开始前必须完成

- [x] T001 起草 ADR-0013（统一数据层选型 react-query@^5.105.0 与缓存键/身份域契约 [contracts/query-keys.md]、共享 hooks 库 @mantine/hooks@^9.7.4 与禁用清单 [research.md D1]、遗留 `apps/web/src/lib/api.ts` 退役路径 [research.md D5]）至 `docs/adr/0013-frontend-data-layer-and-ui-kit.md`，并将规格 006 与 ADR-0013 提交维护者接受——**宪法门禁 DOOR：T002 起的全部实现任务以"规格与 ADR 已接受"为前置**（宪法原则一/五；plan.md Constitution Check 第一行）——已完成：ADR-0013 已按维护者实施指令接受，规格转 Accepted（2026-10-28）
- [x] T002 [P] 采集迁移基线（quickstart.md 场景 0）：`pnpm --filter @hmp/web build` 产物体积（dist 总量+JS gzip）、原生控件 grep 计数（预期 8：7 处 `<select>` + 1 处 `window.alert`）、既有测试套件全绿快照，结果记录至 `docs/specs/006-heroui-react-query-refactor/baseline.md`
- [x] T003 安装依赖（仅 `apps/web/package.json`）：`@tanstack/react-query@^5.105.0`、`@mantine/hooks@^9.7.4`（禁用其 `useFetch`）、`-D @tanstack/react-query-devtools`（同 5.x）；确认 `apps/server`、`packages/shared` 零新增依赖（宪法技术约束 4）

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: 数据层骨架与共享 UI 底座——任何用户故事实现前必须完成

**⚠️ CRITICAL**: No user story work can begin until this phase is complete

- [x] T004 创建 `apps/web/src/shared/query/client.ts`：模块级 QueryClient 单例，默认配置按 contracts/data-access.md——查询重试 ≤1（5xx/网络错误 1 次、429 1 次、其余 4xx 0 次）、`mutations: { retry: 0 }`、`QueryCache.onError` 捕获 `FetchApiError(401)`（预留 handleSessionLost 接线点，每轮去重）、devtools 仅开发构建
- [x] T005 在 `apps/web/src/app/providers.tsx` 挂载 `<QueryClientProvider>`（使用 T004 单例，置于 Router 之上；不动既有 SessionProvider 顺序）
- [x] T006 [P] 重写 `apps/web/src/shared/ui/`：`skeleton.tsx`/`loading.tsx` → HeroUI `Skeleton`/`Spinner` 基座；`retryable-alert.tsx` → HeroUI `Alert`+重试动作（错误文案经 shared/query/error.ts 映射链）；`states.tsx` → `EmptyState` 空态；新增 `toast.tsx`（HeroUI Toast 封装：成功/回滚提示）；更新 `index.ts` 导出；写法遵循 contracts/ui-components.md（复合组件、onPress、语义变体、固定暗色）
- [x] T007 [P] 创建 `apps/web/src/shared/hooks/`：`index.ts` 导出约定——@mantine/hooks 具名 re-export（useDebouncedValue/useThrottledValue/useInterval/useMediaQuery/useElementSize/useEventListener/useLocalStorage/useClipboard/useFocusWithin 按需启用）+ 自研 hook 占位结构；文件头注释登记禁用清单（useFetch 禁用；服务端状态/轮询一律 react-query）
- [x] T008 创建数据层测试基座 `apps/web/test/helpers/query-test-utils.ts`：内存 QueryClient 构造、mock publicFetch/privateFetch（可编程延迟/失败/断言 signal）、toast 与路由断言工具
- [x] T009 [P] 基础单测：client 重试矩阵（含 429/4xx 分档）于 `apps/web/test/unit/query-client.spec.ts`；三态组件渲染与重试动作于 `apps/web/test/unit/shared-ui.spec.tsx`

**Checkpoint**: 数据层骨架与共享 UI 底座就绪——用户故事可开始（US1 可与 US2 并行，注意 T025 对 T011–T013 的同文件依赖）

---

## Phase 3: User Story 1 - 全站交互控件统一为组件库，清除原生控件 (Priority: P1) 🎯 MVP

**Goal**: 8 处原生控件（7 `<select>` + 1 `window.alert`）全部替换为 HeroUI 等价组件，能力与文案不丢失，全站扫描清零

**Independent Test**: 逐页操作设置 6 子页与 EPG 指南页 + grep 扫描原生控件计数 = 0（quickstart.md 场景 1）

### Tests for User Story 1 (REQUIRED) ⚠️

> **NOTE: Write these tests FIRST, ensure they FAIL before implementation**

- [x] T010 [P] [US1] 组件测试：各设置页 Select 替换后选项集合/当前值/变更回调等价、键盘可开合焦点可见——`apps/web/test/components/settings-selects.spec.tsx`；主档变更提示 AlertDialog 文案与确认动作不变、结果经 Toast 反馈——`apps/web/test/components/profiles-alert.spec.tsx`（依赖 T008）

### Implementation for User Story 1

- [x] T011 [P] [US1] `apps/web/src/features/settings/settings-epg-page.tsx:280` `<select>` → HeroUI `Select`（Root/Trigger/Value/Indicator/Popover），选项与当前值等价
- [x] T012 [P] [US1] `apps/web/src/features/settings/settings-policy-page.tsx:139,167` 两处 `<select>` → `Select`，策略选项语义等价
- [x] T013 [P] [US1] `apps/web/src/features/settings/settings-sources-page.tsx:478` `<select>` → `Select`，来源类型选项等价
- [x] T014 [P] [US1] `apps/web/src/features/epg/GuidePage.tsx:263,286` 两处 `<select>`（日期/频道筛选）→ `Select`，筛选行为不变
- [x] T015 [US1] `apps/web/src/features/settings/settings-profiles-page.tsx:520` `window.alert(POST_IDENTITY_CHANGE_NOTICE.mainProfile)` → `AlertDialog` 确认 + `Toast` 结果反馈，提示文案不变
- [x] T016 [US1] 修正受影响测试断言：`apps/web/test/` 与 `apps/web/test/e2e/` 中依赖原生 `<select>`/alert 的用例改按用户可见角色/文本断言；如需 `data-testid` 集中登记
- [x] T017 [US1] US1 独立验收：quickstart.md 场景 1——grep 原生控件计数 = 0（FR-002）、6 设置子页 + 指南页走查（键盘/焦点/文案等价，FR-003 无障碍等价基线）

**Checkpoint**: US1 可独立交付验收（宪法技术约束 5 合规达成）；US2 可并行推进

---

## Phase 4: User Story 2 - 数据请求统一：一致的加载、错误、缓存与刷新体验 (Priority: P2)

**Goal**: 全部服务端数据经统一查询/变更层（三域键控、浏览型 SWR、设置型强制最新、乐观更新分档），遗留 `lib/api.ts` 删除

**Independent Test**: quickstart.md 场景 2/3/5——缓存即显+后台刷新、设置页每次最新、乐观回滚、统一错误重试

### Tests for User Story 2 (REQUIRED) ⚠️

> **NOTE: Write these tests FIRST, ensure they FAIL before implementation**

- [x] T018 [P] [US2] 数据层单测（依赖 T008）：SWR 缓存即显+后台刷新无缝更新、设置型 `gcTime:0` 每次硬请求且以 isPending 门控、乐观更新失败回滚+toast、键变化/卸载在途取消且过期响应不回写、重试矩阵端到端——`apps/web/test/unit/query-layer.spec.tsx`
- [x] T019 [P] [US2] 键工厂契约单测：同参同键/异参异键、序列化稳定性、`public`/`profile`/`settings` 域前缀与谓词匹配——`apps/web/test/unit/query-keys.spec.ts`

### Implementation for User Story 2

- [x] T020 [US2] 创建 `apps/web/src/shared/query/keys.ts`：按 contracts/query-keys.md 实现三域键工厂（public.context/catalog/media/guide/live/epg；profile(profileId).favorites/history/progress；settings.account/profiles/policy/sources/devices/epg）；键不含凭据/票据，日期参数用 `YYYY-MM-DD` 字符串
- [x] T021 [US2] 创建 `apps/web/src/shared/query/error.ts`：文案映射链 `errors.{code}` → `detail` → `title` → 通用兜底（`type` URI 永不直出）；`FetchApiError` 原样直通；AbortError 原样上抛不包装
- [x] T022 [US2] 创建 `apps/web/src/shared/query/hooks.ts`：`useAppQuery`/`useAppMutation` 封装——域→凭据档位（public→publicFetch；profile/settings→privateFetch）、`signal` 透传、`feedback` 分档（optimistic：onMutate 取消+快照 → onError 回滚+Toast → onSettled 返回失效 Promise；confirmed：等待态+成功失效）、pending 去重门控
- [x] T023 [P] [US2] 迁移公共域页面至 useAppQuery（浏览型 staleTime 30s/EPG 60s、分页 placeholderData:keepPreviousData）：`apps/web/src/features/catalog/VodCatalogPage.tsx`、`MediaDetailPage.tsx`、`features/epg/GuidePage.tsx`+`GuideWall.tsx`+`useGuideWindow.ts`、`features/live/LivePage.tsx`+`use-live-sections.ts`、`features/home/HomePage.tsx`；删除各页手写加载/错误状态机，三态改用 shared/ui 组件
- [x] T024 [P] [US2] 迁移个人域：`features/favorites/favorites-api.ts`+`favorite-star-button.tsx`（收藏=optimistic+回滚 toast）、`features/history/history-api.ts`+`history-card.tsx`、`features/playback/use-playback-progress.ts`（进度上报=optimistic、幂等契约不变）；播放解析保持一次性动作（use-play-action.ts），凭据/票据不入缓存
- [x] T025 [US2] 迁移设置域 6 页（`gcTime:0+staleTime:0`、isPending 骨架门控、confirmed 变更）：`features/settings/settings-account-page.tsx`、`settings-profiles-page.tsx`、`settings-policy-page.tsx`、`settings-sources-page.tsx`、`settings-devices-page.tsx`、`settings-epg-page.tsx`、`settings-general-page.tsx`——**依赖 T011–T013 完成（同文件，避免冲突）**
- [x] T026 [US2] 迁移会话与敏感动作：`apps/web/src/app/session-provider.tsx`/`bootstrap`、`features/auth/*`（登录/PIN/选档=confirmed）、`features/profiles/*`；`apps/web/src/lib/session.ts` 收编；fetch 调用统一走 privateFetch 档位
- [x] T027 [US2] 删除 `apps/web/src/lib/api.ts` 并扫描双轨：`features/` 与 `app/` 下无裸 `fetch(`、无第二套封装（FR-018）；`shared/fetch.ts` 仍为唯一传输底座
- [x] T028 [US2] US2 独立验收（自动化承载:query-layer a/b/c 单测 + T032 用例4 + guide-window-query;场景 2/3/5 体验级走查移交维护者抽验）：quickstart.md 场景 2（缓存即显/设置最新/共享缓存）、场景 3（乐观回滚/去重）、场景 5（统一错误+重试）——对照 SC-002/SC-003/SC-004

**Checkpoint**: US1+US2 独立可用；US3 在数据层之上接线身份清除

---

## Phase 5: User Story 3 - 个人数据缓存与身份严格隔离（安全底线）(Priority: P2)

**Goal**: 切档/登出/401 时 profile+settings 域整体取消并清除、在途结果丢弃，公共域不受影响（SC-005）

**Independent Test**: quickstart.md 场景 4 四个验收（切档无上一身份数据、在途丢弃、重登仅新身份、401 引导登录）

### Tests for User Story 3 (REQUIRED) ⚠️

> **NOTE: Write these tests FIRST, ensure they FAIL before implementation**

- [x] T029 [P] [US3] 负向单测（依赖 T008）：切档后旧档案键不可命中、慢响应在清除后返回被丢弃、401 触发域清除且仅一次/轮、公共域键在谓词外保留——`apps/web/test/unit/identity-purge.spec.tsx`

### Implementation for User Story 3

- [x] T030 [US3] 创建 `apps/web/src/shared/query/scopes.ts`：`purgePersonalData(qc)` = `cancelQueries(谓词 键[0]!=='public')` → `removeQueries(同谓词)` → `mutationCache.clear()`；`apps/web/src/app/session-provider.tsx` 在 profileId 变更/登出时**同步先于**身份状态更新调用
- [x] T031 [US3] 接线 401 与登出：T004 预留的 `handleSessionLost` 实现（purgePersonalData + 登录引导路由，每轮去重）；登出处理器调用点确认；个人数据使用点复核均以经验证 profileId 键控（FR-021）
- [x] T032 [US3] E2E 负向场景：`apps/web/test/e2e/identity-isolation.spec.ts` 覆盖 quickstart.md 场景 4 全部四验收（含限速下在途丢弃）——安全负向证据归档

**Checkpoint**: US1+US2+US3 全部独立可用；安全底线（宪法原则二）有正反两侧证据

---

## Phase 6: User Story 4 - 公共逻辑沉淀为共享 Hooks，优先复用成熟库 (Priority: P3)

**Goal**: 页面级重复通用逻辑收编 shared/hooks（@mantine/hooks 优先），自研仅限缺口且带理由与单测（SC-006）

**Independent Test**: 清点通用逻辑重复实现与来源清单，重复实现较基线下降 ≥50%，自研均有理由+单测

### Implementation for User Story 4

- [x] T033 [P] [US4] 收编 `apps/web/src/features/settings/use-media-query.ts` → `apps/web/src/shared/hooks/`（@mantine/hooks `useMediaQuery` re-export），更新引用点
- [x] T034 [P] [US4] 收编 `apps/web/src/features/live/hooks/use-live-refresh.ts`：30s 轮询契约语义保留（LIVE_REFRESH_INTERVAL_MS 不变），实现改经共享 hook；评估直播分区是否改 `refetchInterval` 并在 hooks README 记录结论
- [x] T035 [US4] 页面重复逻辑清扫：防抖/节流/本地存储/事件监听改经 `shared/hooks` re-export；`features/epg/guide-time.ts`/`GuideScrollContainer.tsx` 通用部分评估收编；页面内私有通用实现清除
- [x] T036 [US4] 自研 hooks 单测 + 清单文档：`apps/web/src/shared/hooks/README.md`（每个 hook：用途、来源列 = @mantine/hooks / 自研+理由、测试链接）；自研项（如倒计时/滚动锁定/播放器领域 hook，仅按实际需要）逐一附 vitest
- [x] T037 [US4] US4 验收：对照 T002 基线清点重复实现（SC-006：重复实现 −50%、自研=0 或全有理由、所选库活跃维护）

---

## Phase 7: Polish & Cross-Cutting Concerns

**Purpose**: 跨故事收尾与宪法证据归档

- [x] T038 [P] 体积预算验证：`pnpm --filter @hmp/web build` 产物对比 `docs/specs/006-heroui-react-query-refactor/baseline.md`，首屏关键路径传输体积增幅 ≤15%（SC-009）；超出则按需加载优化（组件/lazy 路由级代码分割）并复测
- [x] T039 全量自动化验收：`pnpm typecheck && pnpm lint && pnpm --filter @hmp/web test && pnpm --filter @hmp/web test:e2e` 全绿（FR-040/042）；quickstart.md 场景 6 完整执行并留证
- [x] T040 文档与状态同步：README/架构文档更新数据层与组件约定链接；规格状态流转记录（Proposed→Accepted→Implementing→Verified 节点与证据链接，宪法原则一）；`docs/specs/006-heroui-react-query-refactor/` 内验收证据索引
- [x] T041 宪章合规终审：FR-001..004/010..018/020..022/030..033/040..043 逐项核对签名表；负向用例（跨档案泄漏/未认证/过期响应）证据归档；原生控件计数=0 复扫（SC-001）——完成后方可标记 Verified

---

## Dependencies & Execution Order

### Phase Dependencies

- **Setup (Phase 1)**: T001 是宪法 DOOR——**T002/T003 及之后全部实现任务以规格+ADR-0013 已接受为前置**；T002/T003 可与 ADR 起草并行准备但不合入
- **Foundational (Phase 2)**: 依赖 T003；T004→T005 顺序；T006/T007/T009 可并行；T008 先于 T009/T018/T029
- **US1 (Phase 3)**: 依赖 Phase 2；与 US2 并行安全（不同文件泳道）
- **US2 (Phase 4)**: 依赖 Phase 2；T020→T022 顺序（T021 可并行）；T025 **依赖 US1 的 T011–T013**（settings 同文件）；T027 在 T023–T026 全部迁完后执行
- **US3 (Phase 5)**: 依赖 T020–T022（键与封装存在）；T030→T031 顺序；T032 依赖 T030–T031 与 US2 页面迁移
- **US4 (Phase 6)**: 依赖 Phase 2；T034 涉及 live 页数据接入，建议在 T023 之后执行
- **Polish (Phase 7)**: 依赖全部用户故事完成；T038→T039 顺序（体积优化后再全量验证）

### User Story Dependencies

- **US1 (P1)**: Foundational 后即可开始；不依赖其他故事（MVP）
- **US2 (P2)**: Foundational 后即可开始；settings 迁移与 US1 有同文件顺序依赖（已显式标注）
- **US3 (P2)**: 依赖 US2 的数据层骨架（T020–T022）；验收与 US2 联合回归（spec 约定）
- **US4 (P3)**: 依赖 Foundational；收编任务触及 US2 已迁移文件时以 US2 完成态为基线

### Within Each User Story

- 测试（T010/T018/T019/T029）先写并确认 FAIL，再实现
- 共享层（keys/error/hooks 封装）先于页面迁移
- 页面迁移先于删除遗留（T027 最后）
- 每故事 Checkpoint 处独立验证后再进入下一故事

### Parallel Opportunities

- Phase 2 内：T006 ∥ T007 ∥ T009（T008 完成后）
- US1 内：T011 ∥ T012 ∥ T013 ∥ T014（不同文件）；T010 测试先行
- US2 内：T023 ∥ T024（public 域 ∥ profile 域，不同文件）；T018 ∥ T019
- US4 内：T033 ∥ T034
- 跨故事：US1 与 US2 的非 settings 文件泳道可全程并行

---

## Parallel Example: User Story 1

```bash
# 测试先行（T008 基座就绪后）:
Task: "T010 [P] [US1] 组件测试 settings-selects.spec.tsx + profiles-alert.spec.tsx"
# 实现并行（四个不同文件）:
Task: "T011 [P] [US1] settings-epg-page.tsx select→Select"
Task: "T012 [P] [US1] settings-policy-page.tsx select×2→Select"
Task: "T013 [P] [US1] settings-sources-page.tsx select→Select"
Task: "T014 [P] [US1] GuidePage.tsx select×2→Select"
# 串行收尾:
Task: "T015 [US1] profiles window.alert→AlertDialog+Toast" → "T016 选择器修正" → "T017 验收"
```

---

## Implementation Strategy

### MVP First (User Story 1 Only)

1. T001 治理门禁通过（规格+ADR 接受）→ T002/T003 基线与依赖
2. Phase 2 基础设施就绪
3. Phase 3 (US1) 全部完成 → **STOP and VALIDATE**: quickstart 场景 1 + 场景 6 的 typecheck/lint/test
4. 原生控件清零即可独立交付（宪法技术约束 5 合规）

### Incremental Delivery

1. Setup + Foundational → 底座就绪
2. US1 → 独立验收（MVP!）
3. US2 + US3 → 数据统一与身份隔离（US3 负向证据与 US2 联合回归）
4. US4 → 共享 hooks 收编与少自研目标
5. Polish → 体积预算、全量验证、宪法终审归档

### Same-File Conflict Notes

- settings 各页文件被 US1（T011–T013）与 US2（T025）先后触及：按阶段顺序执行，不并行
- `GuidePage.tsx` 被 US1（T014 控件）与 US2（T023 数据接入）先后触及：同上
- `session-provider.tsx` 被 T005（Provider 挂载）、T026（迁移）、T030（purge 接线）顺序触及：按 ID 顺序

---

## Notes

- [P] tasks = different files, no dependencies
- [Story] label maps task to specific user story for traceability
- 治理提醒：T001 是唯一 DOOR 任务；未接受前不得执行任何 T002 之后的任务（宪法原则一）
- 替换组件时严禁引入新的原生控件或绕过 shared/ui 三态组件（FR-001/011/004）
- 每任务/逻辑组提交一次；Checkpoints 处独立验证
- 迁移全程保持 `pnpm typecheck && pnpm lint && pnpm --filter @hmp/web test` 绿（FR-042）
