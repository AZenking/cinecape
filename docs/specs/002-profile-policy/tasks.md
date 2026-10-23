---
description: "Task list for ProfilePolicy (feature 002) implementation"
---

# Tasks: ProfilePolicy 内容访问策略

**Input**: Design documents from `/docs/specs/002-profile-policy/`

**Prerequisites**: plan.md (Accepted, 2026-10-23), spec.md (Accepted), research.md, data-model.md, contracts/api.md, quickstart.md

**Tests**: 测试为宪章强制要求（多层证据 + 负向用例）。每个故事先写失败测试再实现；单元/契约/真实 HTTP/浏览器/迁移回滚证据映射 SC-001～007，不得以单元通过替代运行时证据。

**Organization**: 任务按用户故事分组（US1/US2/US3 均为 P1，按 spec 顺序交付），支持独立实现与独立验证。

## Format: `[ID] [P?] [Story] Description`

- **[P]**: 可并行（不同文件、无未完成依赖）
- **[Story]**: 所属用户故事（US1/US2/US3）；Setup/Foundational/Polish 阶段无故事标签
- 描述必须含精确文件路径

## Path Conventions

- **Monorepo Web 服务**: 服务端 `apps/server/src/`、前端 `apps/web/src/`、共享契约 `packages/shared/src/`、迁移 `apps/server/src/database/migrations/`
- 测试: `apps/server/test/unit/`、`apps/server/test/contract/`、`apps/server/test/runtime-smoke.mjs`
- 证据: `docs/specs/002-profile-policy/evidence.md`（实施时新建）

---

## Phase 1: Setup（共享契约与常量）

**Purpose**: 阶段 2 契约常量与 OpenAPI 正式化，阻塞全部后续任务

- [x] T001 [P] 在 packages/shared/src/constants.ts 的 ProblemCode 增加阶段 2 稳定错误码：PARENT_VERIFICATION_REQUIRED、PARENT_VERIFICATION_FAILED、PARENT_VERIFICATION_LOCKED、POLICY_VERSION_CONFLICT、POLICY_UNAVAILABLE、ACTIVE_PROFILE_REQUIRED（状态映射按 contracts/api.md 错误表：403/403/423/409/503/403）；不改动既有错误码值
- [x] T002 [P] 将 contracts/api.md 草案正式化为 docs/specs/002-profile-policy/contracts/openapi.yaml（OpenAPI 3.1：GET/PUT /profiles/{profileId}/policy、POST /profiles 与 PATCH /profiles/{profileId} 的 ownerPassword、select 的可选 ownerPassword、RFC 9457 错误响应），并扩展 packages/shared 生成脚本输出独立 policy-schema.d.ts；001 的 schema.d.ts 产物必须保持不变（回归校验）

---

## Phase 2: Foundational（存储迁移与家长验证服务）

**Purpose**: 全部用户故事依赖的表结构、迁移与服务

**⚠️ CRITICAL**: 本阶段完成前不得开始任何用户故事

- [x] T003 [P] 先写迁移契约测试 apps/server/test/contract/policy-migration.e2e-spec.ts（实现前必须失败）：0002 up 后，阶段 1 临时库中每个档案（有/无 PIN 成人、儿童、停用）有且仅有一条默认策略（成人 max_content_level=18/allow_unrated=1，儿童 12/0，三名单 '[]'，version=1）；姓名/PIN/会话令牌不变；含儿童家庭中引用无 PIN 成人的 active_profile_id 被清空；down→up 后阶段 1 业务数据保留、策略恢复默认；就绪检查含新表
- [x] T004 编写 apps/server/src/database/migrations/0002_profile_policy/up.sql，约束逐字取自 data-model.md：profile_policy(household_id 非空引用 household.id, profile_id 非空, PRIMARY KEY(household_id,profile_id), UNIQUE(profile_id), max_content_level 非空整数 CHECK 0～18, allow_unrated 非空整数 CHECK IN(0,1), allowed_media_ids/blocked_media_ids/allowed_channel_ids 非空 JSON 数组文本 DEFAULT '[]' CHECK json_valid 且 json_type='array', version 非空正整数 DEFAULT 1 CHECK, updated_at 非空 UTC)；先为 profile 增加 UNIQUE(household_id,id)，profile_policy 以 (household_id,profile_id) 复合外键引用；parent_verification_state(household_id/account_id 复合主键, 复合外键引用 account(household_id,id), failed_attempts 非空非负 DEFAULT 0, locked_until 可空 UTC)；按既有 Profile.type 回填全部档案（含 disabled）；含 child 家庭清空引用无 PIN adult 的 active_profile_id
- [x] T005 编写 apps/server/src/database/migrations/0002_profile_policy/down.sql：先删 profile_policy、parent_verification_state 子表，再删 profile 上新增的唯一索引；保留全部阶段 1 业务数据
- [x] T006 同步 apps/server/src/database/schema.ts（Drizzle 定义 profile_policy 与 parent_verification_state 及复合外键），并把两张新表加入 apps/server/src/database/database.ts 就绪表清单与 apps/server/src/database/migrate.ts drill 表清单（不能只加迁移版本漏表检查）
- [x] T007 [P] 先写 apps/server/test/unit/parent-verification.spec.ts（实现前必须失败，真实 sqlite 夹具 + 注入哈希）：错误密码累加计数；第 5 次错误触发 5 分钟锁定；锁定中正确密码仍拒绝；到期后恢复可验证；成功清零；计数按账号不按会话；密码明文不进日志
- [x] T008 实现 apps/server/src/modules/auth/parent-verification.service.ts：用既有账号 password_hash（argon2）校验当前账号密码；账号范围持久化失败计数（连续 5 次锁 5 分钟，锁定中不校验密码）；异步哈希返回后在事务内重读锁定状态再累加/清零，不依赖过时内存快照；不发长期管理令牌；沿用敏感键日志脱敏；注册进 auth 模块

**Checkpoint**: 存储与验证服务就绪，三个用户故事可开始（注意同文件串行，见依赖说明）

---

## Phase 3: User Story 1 - 策略持久化与管理 (Priority: P1) 🎯 MVP

**Goal**: 每个档案有且仅有一份默认策略；owner 经家长验证读取/整体保存策略（版本化），重启保留，管理界面可用。

**Independent Test**: 新建成人/儿童档案各有唯一默认策略；修改后重启 100% 保留且另一档案不变；旧版本保存 409 且数据不变（SC-001/SC-005）。

### Tests for User Story 1 (REQUIRED) ⚠️

> **NOTE: 先写以下测试并确认失败，再实现**

- [x] T009 [P] [US1] 先写 apps/server/test/contract/policy-api.e2e-spec.ts：GET /profiles/{id}/policy 返回完整 PolicyDto（默认值场景）；PUT 成功 version+1（相同值仍 +1）且三名单原样保留；未知字段 400 VALIDATION_FAILED；非法等级（非整数/<0/>18）与非正 expectedVersion 400；缺 ownerPassword 403 PARENT_VERIFICATION_REQUIRED；错误密码 403 PARENT_VERIFICATION_FAILED 且策略不变；锁定中 423；跨家庭/不存在目标 404 同形；expectedVersion 过期 409 POLICY_VERSION_CONFLICT 且数据不变；策略行缺失/损坏 503 POLICY_UNAVAILABLE；非 owner 403；无效会话 401
- [x] T010 [P] [US1] 先写 apps/server/test/contract/policy-atomicity.e2e-spec.ts：POST /profiles 原子创建档案+默认策略（非法输入失败时两者皆不落库，无孤儿策略行）；保存后重启（新进程/新连接）配置 100% 保留；停用档案策略保留且可编辑；并以服务端 DB 夹具经应用层名单校验路径写入并读回，证明 FR-013 读写：重复项去重排序持久化、第 1001 项确定拒绝（≤1000）、元素为 1～128 非空大小写敏感标识、允许∩禁止交集保留且禁止优先、损坏 JSON 名单读取拒绝（503 语义，不静默当空数组）

### Implementation for User Story 1

- [x] T011 [US1] 实现 apps/server/src/modules/policy/policy.service.ts、policy.controller.ts、policy.module.ts 并注册到 apps/server/src/app.module.ts：GET 走 SessionGuard→owner→requireOwnedProfile→查询；PUT 用严格 zod（仅 ownerPassword/expectedVersion/policy{maxContentLevel,allowUnrated}，未知字段拒绝），经 T008 验证后单事务整体替换可编辑配置（三名单保留、version 递增）；读取时服务端重新解析校验 JSON 名单（损坏→503，不静默放宽）；错误映射按 contracts/api.md；不返回 householdId/凭据/验证计数
- [x] T012 [US1] 修改 apps/server/src/modules/profile/profile.service.ts 创建流程：同事务插入默认策略（成人 18/true、儿童 12/false、空名单）；运行时缺策略一律拒绝，不自动补建（FR-003/FR-008）
- [x] T013 [P] [US1] 新建 apps/web/src/pages/ProfilePolicy.tsx：策略表单（0～18 整数等级、allowUnrated 开关）、保存时家长验证密码弹窗（提交后清空、不缓存不持久化）、三名单只读区显示"媒体目录接入后可配置"与未评级/频道名单局限说明、409 冲突提示重新加载且保留输入、保存失败保留表单
- [x] T014 [US1] 前端接线：apps/web/src/App.tsx 增加管理路由，apps/web/src/pages/ProfileManage.tsx 增加逐档案策略入口，apps/web/src/lib/api.ts 增加类型化客户端方法（类型来自 packages/shared policy-schema），按服务端 ProblemCode 渲染错误

**Checkpoint**: US1 独立可验：默认策略、版本化保存、重启持久化、管理界面完整

---

## Phase 4: User Story 2 - 一致判定核心 (Priority: P1)

**Goal**: 纯 evaluatePolicy 按判定表给出一致允许/拒绝与稳定原因；服务端授权入口只接受服务端构造事实。

**Independent Test**: 服务端夹具覆盖判定表全分支与组合场景，断言 allowed 与 reason，无需真实媒体源（SC-002/SC-003）。

### Tests for User Story 2 (REQUIRED) ⚠️

- [x] T015 [P] [US2] 先写 apps/server/test/unit/policy-rules.spec.ts：判定表 9 行逐分支；同一媒体允许∩禁止→禁止；未评级且 allowUnrated=false 时媒体在允许名单仍禁止；儿童频道不在白名单→禁止（即使等级满足），在白名单仍过未评级/等级规则；已评级媒体在允许名单可覆盖等级上限（不覆盖未评级/频道门槛）；成人不受频道白名单限制但受禁止/未评级/等级约束；边界 0/18；空允许名单≠允许所有、儿童空频道名单=全部不可访问；无法映射的外部分级=未评级；事实类型无效或等级越界按损坏拒绝（不静默放行）
- [x] T016 [P] [US2] 先写 apps/server/test/contract/policy-authorization.e2e-spec.ts（测试专用应用装配可信夹具 reader，不得注册进生产 AppModule）：无 activeProfile/停用/策略缺失→按 ACTIVE_PROFILE_REQUIRED/POLICY_UNAVAILABLE 语义拒绝，不回落成人策略；跨家庭 mediaId 统一拒绝且不泄漏资源事实；篡改请求体/URL/localStorage 的 profileId、householdId、contentLevel、资源状态均不影响结果；策略提交后下一次授权即用新值（不靠刷新）

### Implementation for User Story 2

- [x] T017 [US2] 实现 apps/server/src/modules/policy/policy.rules.ts：纯函数 evaluatePolicy(policy, profileType, facts)（无 I/O、无框架依赖、名单转 Set），返回 {allowed, reason}，reason 枚举 RESOURCE_UNAVAILABLE/POLICY_UNAVAILABLE/MEDIA_BLOCKED/CHANNEL_NOT_ALLOWED/UNRATED_DENIED/MEDIA_ALLOWED/LEVEL_ALLOWED/LEVEL_EXCEEDED；同文件导出 MediaPolicyFacts 类型（householdId、mediaId、type=channel|movie|series|episode|video、channelId 仅 channel 时等于 mediaId、contentLevel 0～18|null、householdEnabled）
- [x] T018 [US2] 在 apps/server/src/modules/policy/policy.service.ts 实现授权入口 authorizeCurrentProfile(sessionContext, mediaId, trustedResourceReader)：重新确认会话有效、加载 activeProfile（归属+active）、每次授权查库取最新策略（不缓存）、事实仅由按会话 Household 查询的可信 reader 构造；配套测试专用适配模块（仅测试装配，生产 AppModule 不注册，无公开 HTTP evaluate 端点）

**Checkpoint**: US2 独立可验：判定矩阵与授权入口负向场景全绿

---

## Phase 5: User Story 3 - 防止儿童自助解除限制 (Priority: P1)

**Goal**: owner 会话承载儿童时，所有扩大权限的管理/切换路径无有效家长验证一律失败。

**Independent Test**: 主账号会话选儿童后，直接改策略/建档案/编辑/清 PIN/选无 PIN 成人全部拒绝；正确密码成功；失败计数跨会话共享且重启保留（SC-004）。

### Tests for User Story 3 (REQUIRED) ⚠️

- [x] T019 [P] [US3] 先写 apps/server/test/contract/profile-protection.e2e-spec.ts：POST /profiles 无 ownerPassword→403 且无部分写入（无孤儿策略行）；PATCH /profiles/{id}（含设 PIN/清除 PIN）无密码或密码错误→拒绝且数据不变，正确密码→成功；type 不可编辑（400）；含儿童家庭（含停用儿童）选择无 PIN 成人：无密码 403、正确密码 200；有 PIN 成人沿用原 PIN 解锁（ownerPassword 不替代 PIN）；非 owner 403；过期/撤销会话 401；伪造"已验证"标记/未知字段无效
- [x] T020 [P] [US3] 先写 apps/server/test/contract/parent-lockout.e2e-spec.ts：连续 5 次错误密码→423 PARENT_VERIFICATION_LOCKED；锁定中正确密码也 423；换新登录会话仍锁定（计数按账号共享）；重启应用后锁定保留；到期后可重新验证且成功清零

### Implementation for User Story 3

- [x] T021 [US3] 修改 apps/server/src/modules/profile/profile.controller.ts 与对应 zod 校验：POST /profiles、PATCH /profiles/{id} 增加 ownerPassword 必填（严格校验；既有身份接口对未知身份字段继续忽略、不作为信任源），写入前经 T008 家长验证（覆盖全部字段编辑与 PIN 清除，防拆分路径遗漏）；其余行为与响应 DTO 不变，密码不回显；同一提交内同步阶段 1 既有夹具：apps/server/test/helpers.ts 与 apps/server/test/contract/us2-profiles.e2e-spec.ts 的既有 POST /profiles、PATCH /profiles/{id} 调用点补传 ownerPassword（测试账号真实密码，不硬编码明文进断言输出），apps/server/test/runtime-smoke.mjs 既有档案创建/编辑调用同步补参；保留原全部负向断言与 65 用例基线，不删不减用例
- [x] T022 [US3] 修改 apps/server/src/modules/profile/profile.service.ts select 流程：归属/可用性优先；有 PIN 目标沿用原一次性 PIN 授予；无 PIN 成人且家庭存在任一儿童档案（含停用）→先家长验证再更新 activeProfile；停用儿童计入"存在儿童"，不得经停用绕过
- [x] T023 [US3] 前端补强：apps/web/src/pages/ProfileManage.tsx 创建/编辑/清 PIN 增加家长验证弹窗；apps/web/src/pages/ProfilePicker.tsx 在受保护成人选择收到 403 PARENT_VERIFICATION_REQUIRED 时弹密码验证（不绕过 PIN 流程）；错误按服务端 ProblemCode 呈现，密码不落浏览器存储

**Checkpoint**: 三个故事均独立可验；US1+US2+US3 合并后 SC-001～005 的服务端证据齐备

---

## Phase 6: Polish & Cross-Cutting Concerns

**Purpose**: 跨故事证据、契约同步与全量门禁

- [x] T024 [P] 同步阶段 1 契约：更新 docs/specs/001-scaffold-identity-foundation/contracts/openapi.yaml（POST /profiles、PATCH /profiles/{id} 增加必填 ownerPassword，select 增加可选 ownerPassword），重新生成共享类型；保留既有全部负向断言，不得削弱阶段 1 用例
- [x] T025 [P] 扩展 apps/server/test/runtime-smoke.mjs：真实 HTTP 校验策略读取/保存（真实后端，非 mock）、错误密码与锁定（423）、版本冲突（409）；沿用独立临时 DATA_DIR/端口约定
- [x] T026 执行 quickstart.md"真实 HTTP 与浏览器"第 1–7 项（真实服务+真实浏览器、独立临时 DATA_DIR/端口/域名）：默认策略与原子创建、全部保护路径拒绝、篡改 localStorage/URL/请求体不扩权、锁定跨会话与重启、两会话版本冲突与下次授权即生效、名单编辑未启用提示、浏览器存储/响应/日志无密码泄漏；将命令/日期/结果写入 docs/specs/002-profile-policy/evidence.md（新建）
- [x] T027 执行 quickstart.md"升级、回滚、恢复"演练（离线临时副本）：阶段 1 数据→0002 up 核对回填与上下文清空；down→up 核对阶段 1 保留且策略恢复默认；恢复回滚前备份核对自定义策略与 integrity_check；结果追加 evidence.md；不对真实用户库执行 drill
- [x] T028 执行 quickstart.md"容器与证据"：ARM64/AMD64 构建（仿真注明）、非 root 启动、独立卷自动升级与持久化重启、缺迁移/缺新表 healthz=503、阶段 1 SPA/API 回归；结果追加 evidence.md
- [x] T029 全量门禁与文档同步：pnpm lint、pnpm typecheck、pnpm test、pnpm build、pnpm test:runtime 全绿且阶段 1 的 65 用例回归不变；核对 roadmap.md 阶段 2 状态与 docs/specs/002-profile-policy/ 各文档一致（实现开始时 spec.md Status 已流转 Accepted→Implementing，全部验收后流转 Verified）；修复发现的问题

---

## Dependencies & Execution Order

### Phase Dependencies

- **Setup (Phase 1)**: 无依赖，立即开始（T001/T002 可并行）
- **Foundational (Phase 2)**: 依赖 Phase 1（错误码/契约类型）；**阻塞全部用户故事**；T003/T007 测试先行，T004→T005→T006 顺序执行
- **User Stories (Phase 3–5)**: 均依赖 Phase 2 完成
- **Polish (Phase 6)**: 依赖全部用户故事完成（T024/T025 可在 US1/US3 完成后提前并行）

### User Story Dependencies

- **US1 (Phase 3)**: 依赖 Phase 2；无其他故事依赖
- **US2 (Phase 4)**: 依赖 Phase 2（策略表）与 T011（policy.service.ts 骨架）；纯规则（T015/T017）可与 US1 并行
- **US3 (Phase 5)**: 依赖 Phase 2（T008 验证服务）；与 US1/US2 逻辑独立，但 **T012 与 T022 同改 profile.service.ts、T011 与 T018 同改 policy.service.ts**——同文件任务须串行，单人执行按 US1→US2→US3 顺序最稳

### Within Each User Story

- 测试先行：先写测试并确认失败，再实现
- 规则/模型 → 服务 → 控制器/端点 → 前端接线
- 每个故事完成后在其 Checkpoint 独立验证

### Parallel Opportunities

- Phase 1: T001 ∥ T002（不同文件）
- Phase 2: T003 ∥ T007（不同测试文件）
- US1: T009 ∥ T010（不同测试文件）；T013（前端）∥ T011/T012（后端，不同文件）
- US2: T015 ∥ T016（不同测试文件）
- US3: T019 ∥ T020（不同测试文件）
- Phase 6: T024 ∥ T025（不同文件）；T026/T027/T028 均写 evidence.md，须串行

---

## Parallel Example: User Story 1

```bash
# 先并行启动全部失败测试：
Task: "T009 contract test for policy API in apps/server/test/contract/policy-api.e2e-spec.ts"
Task: "T010 atomicity test in apps/server/test/contract/policy-atomicity.e2e-spec.ts"

# 再并行推进前后端（不同文件）：
Task: "T013 [US1] ProfilePolicy page in apps/web/src/pages/ProfilePolicy.tsx"   # 前端
Task: "T011 [US1] policy module in apps/server/src/modules/policy/"              # 后端
```

---

## Implementation Strategy

### MVP First (User Story 1 Only)

1. Complete Phase 1: Setup
2. Complete Phase 2: Foundational（迁移+验证服务，CRITICAL）
3. Complete Phase 3: User Story 1（策略持久化+管理+界面）
4. **STOP and VALIDATE**: 默认策略/版本化保存/重启保留/409 冲突独立验证
5. 可演示：家长验证下的策略管理闭环

### Incremental Delivery

1. Setup + Foundational → 存储与验证基座
2. + US1 → 策略管理 MVP（演示点）
3. + US2 → 判定核心就绪（阶段 3/4 复用）
4. + US3 → 全部绕过路径封堵
5. + Polish → 多层证据与 Verified 前置条件齐备

### Parallel Team Strategy

- 后端 A：US1（T011/T012）→ US2（T018）
- 后端 B：US3（T021/T022）——注意与 A 的 profile.service.ts/policy.service.ts 串行协调
- 前端 C：T013/T014 → T023（与后端联调收口）
- 测试/证据 D：Phase 6（T024 起）

---

## Notes

- [P] 任务 = 不同文件且无未完成依赖；同文件任务一律串行
- 实现开始时（/speckit-implement）将 spec.md Status 流转 Accepted → Implementing；全部证据通过后流转 Verified
- 不得删除/削弱阶段 1 既有 65 用例与负向断言来凑通过
- 名单编辑本阶段不开放：服务端持久化与判定用夹具验证；UI 只读+说明（FR-013）
- 阶段 3/4 不得以本阶段测试宣称已拦截真实目录/下载/播放（FR-015）
- 完成实现后运行 /speckit-analyze 做跨工件一致性核对
