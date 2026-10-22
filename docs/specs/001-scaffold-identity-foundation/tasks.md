---
description: "Task list for 001-scaffold-identity-foundation"
---

# Tasks: 应用脚手架与身份基础(Identity Foundation)

**Input**: Design documents from `/docs/specs/001-scaffold-identity-foundation/`

**Prerequisites**: [plan.md](plan.md)(required) · [spec.md](spec.md)(required,Accepted) · [research.md](research.md) · [data-model.md](data-model.md) · [contracts/openapi.yaml](contracts/openapi.yaml) · [quickstart.md](quickstart.md) · [ADR-0004](../../../docs/adr/0004-technology-stack.md)(Accepted)

**Tests**: Tests are REQUIRED by the project constitution(原则 I/门禁)。每个用户故事先写失败测试(契约 e2e + 单元),FR-019 全部负向场景必须自动化并在合并门禁执行;迁移回滚必须实际演练(SC-006);证据留档后才可标记 Verified。

**Organization**: Tasks are grouped by user story to enable independent implementation and testing of each story.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: Which user story this task belongs to (US1 / US2 / US3)
- Include exact file paths in descriptions

## Path Conventions

pnpm monorepo(plan.md 已定):`apps/server/`(NestJS)、`apps/web/`(React + Vite + Tailwind v4 + HeroUI v3)、`packages/shared/`(契约类型)。

---

## Phase 1: Setup (Shared Infrastructure)

**Purpose**: 建立 monorepo 与两端骨架

- [x] T001 初始化 pnpm workspace:`pnpm-workspace.yaml`、根 `package.json`(packageManager=pnpm@10,engines.node=24)、`.nvmrc`(24)、`tsconfig.base.json`(strict);**创建根 `.gitignore`** —— Node 常规条目(`node_modules/`、`dist/`、`coverage/`、`*.tsbuildinfo`、`.vite/`、日志)+ 密钥(`.env`/`.env.*`,**保留 `.env.example` 可提交**)+ 本项目数据(`*.db`、`*.db-wal`、`*.db-shm`、`hmp.db.bak-*`、`/data/`)+ OS(`.DS_Store`);`packages/shared` 生成类型文件是否 ignore 需在实现时定一(建议 ignore + `gen:types` 构建期再生)
- [x] T002 [P] 脚手架 NestJS 12 服务于 `apps/server/`(`src/main.ts` 全局前缀 `/api`、`AppModule`、Vitest 配置;`/healthz` 先返回占位,T013 接真实 DB 检查)
- [x] T003 [P] 脚手架 Vite + React 19 + Tailwind v4 + HeroUI v3 于 `apps/web/`(globals.css 按 `@import "tailwindcss"` → `@import "@heroui/styles"` 顺序,暗色优先 token,`<html class="dark">`)
- [x] T004 [P] 创建 `packages/shared/`:openapi-typescript 从 `docs/specs/001-scaffold-identity-foundation/contracts/openapi.yaml` 生成类型的脚本(`gen:types`)与导出入口
- [x] T005 [P] 配置根级 ESLint + `pnpm typecheck` + `pnpm lint` 脚本(含 apps 两包与 shared)
- [x] T006 [P] zod 环境配置 `apps/server/src/config/env.schema.ts`(PORT、DATA_DIR、SESSION_TTL_DAYS=30、SESSION_ABSOLUTE_DAYS=90、PIN_MAX_ATTEMPTS=5、PIN_LOCK_MINUTES=5;启动 fail-fast)+ `.env.example`

**Checkpoint**: workspace 可 `pnpm install && pnpm dev`,两端空壳可启动。

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: 数据库、会话信任源、错误契约 —— 所有用户故事的前置

**⚠️ CRITICAL**: 本阶段未完成前不得开始任何用户故事

- [x] T007 Drizzle schema:`apps/server/src/database/schema.ts` 定义 household/account/profile/device/device_session 全部表 —— 逐列遵循 data-model.md(含 `username_normalized` 唯一列、profile 部分唯一索引 `one_default_profile`、device_session.token_hash 唯一、所有表显式 `household_id`)
- [x] T008 首版迁移对:`apps/server/src/database/migrations/0001_init/up.sql` + `0001_init/down.sql`(down 完整 DROP,可回滚到空库)
- [x] T009 迁移执行器 `apps/server/src/database/migrate.ts`:up/down 命令 + 执行前自动备份 `hmp.db.bak-<timestamp>`(SQLite WAL;SC-006 依赖)
- [x] T010 [P] RFC 9457 全局异常过滤器 `apps/server/src/common/problem-json.filter.ts`:领域错误 → `application/problem+json`(稳定 code,如 `INITIALIZATION_ALREADY_DONE`、`INVALID_CREDENTIALS`)
- [x] T011 令牌服务 `apps/server/src/modules/auth/token.service.ts`:32 字节 CSPRNG 签发 + SHA-256 哈希存取 + 常数时间比对(明文 token 不落库)
- [x] T012 会话 Guard `apps/server/src/common/session.guard.ts`:单一校验管线(哈希查找 → 未撤销 → 未过期 → 设备未撤销 → household/account 一致),任何失败统一 401 problem,`apps/server/src/modules/auth/` 暴露 `CurrentSession` 装饰器
- [x] T013 健康检查接真实依赖:`apps/server/src/modules/health/health.controller.ts` 检查 SQLite 打开与迁移版本,`503` problem 表示未就绪
- [x] T014 Web 壳:`apps/web/src/lib/api.ts`(ApiClient:默认 Cookie 通道,持 token 时 Bearer)、`apps/web/src/lib/session.ts`(SessionContext)、`apps/web/src/App.tsx` 路由骨架(受保护路由占位)
- [x] T015 交付骨架:多阶段 `Dockerfile`(pnpm fetch→build→runtime,非 root,amd64/arm64)+ `docker-compose.yml`(单服务 + `/data` 卷 + healthcheck `/api/healthz`)

**Checkpoint**: 基础就绪 —— 用户故事可开始;`migration:up` 后 `/api/healthz` 返回 `{"status":"ok","database":"ok"}`。

---

## Phase 3: User Story 1 - 首次启动:初始化家庭并登录 (Priority: P1) 🎯 MVP

**Goal**: 全新部署完成一次性初始化(唯一 Household + 主 Account),凭据登录建立 DeviceSession,可读取家庭信息与 Profile 列表

**Independent Test**: 全新环境启动 → 初始化 → 登录 → `GET /household` 与 `GET /profiles` 返回数据;重复初始化 409;错误凭据统一 401(quickstart 场景 1)

### Tests for User Story 1 (REQUIRED) ⚠️

> 先写测试并确认 FAIL,再进入实现

- [x] T016 [P] [US1] 契约 e2e `apps/server/test/contract/us1-setup-login.e2e-spec.ts`:setup status → initialize 201(响应含 sessionToken,无哈希字段)→ 重复 initialize 409 → 正确登录 200 → 错误密码/不存在用户均为同一 401 code → GET /household、GET /profiles 200(对照 contracts/openapi.yaml 断言)
- [x] T017 [P] [US1] 单元 `apps/server/test/unit/password.hash.spec.ts`:argon2id 哈希/验证;account 序列化不含 password_hash(PIN 同理在 US2 验证)

### Implementation for User Story 1

- [x] T018 [US1] household 模块 `apps/server/src/modules/household/`(`household.module.ts`、`setup.controller.ts`、`household.service.ts`):GET /setup/status、POST /setup/initialize(事务内建 household + owner account;已完成时 409,FR-002/003)
- [x] T019 [US1] 登录:`apps/server/src/modules/auth/auth.controller.ts` + `session.service.ts` + `device.service.ts` —— POST /auth/login(argon2 验证,失败统一 `INVALID_CREDENTIALS`;按 deviceType/deviceName 注册或复用 Device;创建 device_session;set httpOnly Cookie `hmp_session` + 响应返回一次性 sessionToken,FR-007/008/009)
- [x] T020 [US1] GET /household:从服务端会话解析边界,忽略任何查询参数传入的 householdId(FR-018)于 `apps/server/src/modules/household/household.controller.ts`
- [x] T021 [US1] 初始化向导页 `apps/web/src/pages/SetupWizard.tsx`(HeroUI 表单:家庭名/用户名/密码 → initialize → 自动登录跳转;已初始化则重定向登录页)
- [x] T022 [US1] 登录页 `apps/web/src/pages/Login.tsx`(统一错误提示,不区分账号存在性;登录后进入 Profile 选择占位路由)

**Checkpoint**: MVP 可独立验证(quickstart 场景 1 全绿)—— 平台"已可用"价值成立。

---

## Phase 4: User Story 2 - 选择与切换观看 Profile(含 PIN 保护) (Priority: P2)

**Goal**: Profile 生命周期管理与服务端控制的当前观看者切换,受 PIN 保护的档案必须解锁

**Independent Test**: 有效会话创建/编辑/停用 Profile;select 后 `/auth/session` 上下文更新;PIN 档案错误密码 423/403;伪造 profileId 404(quickstart 场景 2)

### Tests for User Story 2 (REQUIRED) ⚠️

- [x] T023 [P] [US2] 契约 e2e `apps/server/test/contract/us2-profiles.e2e-spec.ts`:创建 adult/child+PIN → 默认唯一互换 → 停用唯一可用 409 → select 合法/跨家庭(夹具注入第二家庭)/不存在/已停用矩阵 → unlock 正确/错误 PIN、连续 5 次后 423、锁定窗口内正确 PIN 也 423 → 停用后引用会话 activeProfile 清空(负向:伪造 householdId/profileId 字段被忽略,FR-018/019)
- [x] T024 [P] [US2] 单元 `apps/server/test/unit/profile.rules.spec.ts`:`one_default_profile` 部分唯一索引行为、至少一个可用校验、PIN 计数/锁定窗口状态机(含窗口过期重置)

### Implementation for User Story 2

- [x] T025 [US2] Profile 服务 `apps/server/src/modules/profile/profile.service.ts`:create/update/list —— update 事务内处理 isDefault 互换、clearPin、status 变更;停用最后一个可用 Profile 拒绝 409(FR-013)
- [x] T026 [US2] POST /profiles/{profileId}/select:校验属于当前会话 Household+Account 且 active,事务内更新 device_session.active_profile_id(FR-014)于 `apps/server/src/modules/profile/profile.controller.ts`
- [x] T027 [US2] PIN 服务 `apps/server/src/modules/profile/pin.service.ts` + POST /profiles/{profileId}/unlock:argon2id 验证、failed_pin_count/pin_locked_until 状态机、锁定窗口内 423(FR-015)
- [x] T028 [US2] 停用级联:profile.service 停用事务内清空引用该 Profile 的 device_session.active_profile_id(FR-016;与 T025 同文件,依赖完成)
- [x] T029 [US2] 档案选择页 `apps/web/src/pages/ProfilePicker.tsx` + `apps/web/src/components/ProfileCard.tsx`(Netflix 式大头像卡、默认标记、锁角标;点击无 PIN 直接 select,有 PIN 弹 PinPad)
- [x] T030 [US2] PIN 数字键盘浮层 `apps/web/src/components/PinPad.tsx`(3×4 键盘、错误整排抖动清空、提示剩余次数;HeroUI Modal + onPress)
- [x] T031 [US2] Profile 管理页 `apps/web/src/pages/ProfileManage.tsx`(创建/编辑/停用/设默认/设 PIN;owner 专属路由)

**Checkpoint**: US1+US2 独立可用 —— 阶段 1 完成条件后半句(服务端验证 Profile 归属)成立。

---

## Phase 5: User Story 3 - 会话生命周期:恢复、注销与设备撤销 (Priority: P3)

**Goal**: 会话可恢复、可注销,设备可撤销且立即全量失效

**Independent Test**: 重启服务后会话恢复;过期 401;logout 后旧凭证 401 且重复 logout 204;revoke 后该设备全部会话 401(quickstart 场景 3)

### Tests for User Story 3 (REQUIRED) ⚠️

- [x] T032 [P] [US3] 契约 e2e `apps/server/test/contract/us3-session.e2e-spec.ts`:恢复 200(含 TTL 缩短配置的过期 401、边界:恰好过期=已过期)→ logout 204/幂等 204 → 同设备多会话下 revoke 设备全部失效、重复 revoke 204 → 服务重启后数据与会话保留(测试内重启 app 实例)

### Implementation for User Story 3

- [x] T033 [US3] GET /auth/session:Guard 通过后返回 SessionDto;滑动续期(last_active_at 前移、expires_at 重算,不超过绝对上限)于 `apps/server/src/modules/auth/session.service.ts`
- [x] T034 [US3] POST /auth/logout:幂等写 revoked_at(reason=logout)于 `apps/server/src/modules/auth/auth.controller.ts`(FR-011/012)
- [x] T035 [US3] 设备管理:GET /devices + POST /devices/{deviceId}/revoke(事务内 device.revoked_at + 该设备全部会话 revoked,幂等)于 `apps/server/src/modules/auth/device.controller.ts`
- [x] T036 [US3] Web 会话恢复:`apps/web/src/lib/session.ts` 启动时 GET /auth/session 重建上下文;受保护路由守卫;AppShell 加退出按钮(activeProfile 被停用时静默回落 + 轻提示,research D6 交互范式)
- [x] T037 [US3] 设备管理页 `apps/web/src/pages/Devices.tsx`(列表 + 撤销确认对话框,HeroUI Table/Dialog)

**Checkpoint**: 三个用户故事全部独立可用;阶段 1 完成条件整体成立。

---

## Phase 6: Polish & Cross-Cutting Concerns

**Purpose**: 宪章门禁证据与收尾

- [x] T038 FR-019 负向完备性审计:对照规格逐条核对 T016/T023/T032 覆盖矩阵(无效/过期/撤销会话、跨家庭 profile、伪造标识、绕过 PIN),缺口补测试于 `apps/server/test/contract/`
- [x] T039 迁移演练:package.json `migration:drill` 脚本(up→down→up)并实际执行,确认备份可恢复(SC-006)
- [x] T040 [P] 运行时与网络证据:按 `docs/specs/001-scaffold-identity-foundation/quickstart.md` 场景 1-5 执行,输出与结论留档 `docs/specs/001-scaffold-identity-foundation/evidence.md`(宪章多层证据验收)
- [x] T041 日志脱敏:日志拦截器确保 password/PIN/token 任何形式不入日志(`apps/server/src/common/log-redaction.interceptor.ts`)+ 验证用例
- [x] T042 [P] 性能冒烟:本地登录 p95 < 300ms、会话校验 < 20ms、容器内存 < 512MB(记录到 evidence.md)
- [x] T043 文档同步:README「本地启动」补全(运行时版本、install/migration/dev/test/build)+ 当前状态更新;spec.md 状态流转(证据齐备后 Verified);同一变更内提交(宪章门禁 4)

---

## Dependencies & Execution Order

### Phase Dependencies

- **Phase 1 Setup**: 无依赖,立即开始;T002/T003/T004/T005/T006 可并行
- **Phase 2 Foundational**: 依赖 Phase 1;T007→T008→T009 串行(同一迁移链),T010-T015 可与 T007-T009 并行;**完成前阻塞全部用户故事**
- **Phase 3 US1(MVP)**: 依赖 Phase 2
- **Phase 4 US2**: 依赖 Phase 2;建议在 US1 后(复用其登录夹具),测试与实现不依赖 US1 的新代码
- **Phase 5 US3**: 依赖 Phase 2;与 US2 可并行(不同文件域,共享 Guard)
- **Phase 6 Polish**: 依赖全部故事;T038 完成并 T040 证据齐备后方可流转 Verified

### Within Each User Story

Tests(先写,确认 FAIL)→ 实现按依赖序(T025→T026/T027→T028 这类同文件依赖已标注)→ Web 页面在对应 API 就绪后 → Checkpoint 独立验证

### Parallel Opportunities

- Phase 1:T002-T006 五任务全并行
- Phase 2:T010/T011(+T012)、T014、T015 与迁移链并行
- 各故事内 [P] 测试任务先行并行;US2 与 US3 可由两名执行者并行

---

## Parallel Example: User Story 1

```bash
# 测试先行(并行):
Task: "T016 契约 e2e us1-setup-login.e2e-spec.ts"
Task: "T017 单元 password.hash.spec.ts"
# 确认 FAIL 后进入实现:
Task: "T018 household 模块"  →  Task: "T019 登录"  →  Task: "T020 /household"
# Web(依赖 T019 契约可用):
Task: "T021 SetupWizard"  +  Task: "T022 Login"
```

---

## Implementation Strategy

### MVP First (User Story 1 Only)

1. Phase 1 Setup → 2. Phase 2 Foundational(阻塞项,不可跳)→ 3. Phase 3 US1 → 4. **STOP:quickstart 场景 1 独立验证** → 平台可演示

### Incremental Delivery

- +US2 → Profile 闭环(阶段 1 完成条件后半句)→ 验证
- +US3 → 会话生命周期完整 → 验证
- +Polish → FR-019 审计、迁移演练、证据留档 → 规格状态可流转 `Verified`

### Notes

- 每任务或逻辑组完成即提交(原子变更含文档,宪章门禁)
- 涉及 `.sql` 迁移与 schema 的任务(T007-T009)不得与其他写库任务并行执行于同一工作区
- [P] = 不同文件、无未完成依赖;[Story] 用于追溯 FR/SC 映射

## Phase 7: Convergence

本阶段由 2026-10-23 收尾核对追加；原阶段勾选仅代表历史记录，当前验收以本阶段与 evidence.md 为准。

- [x] T044 CRITICAL 修复根 ESLint project-service 配置，使 pnpm lint 覆盖源码和工具配置并通过（宪章质量门禁；contradicts）。
- [x] T045 [US1] 补齐健康检查的迁移/表结构就绪判断与空库、缺表、迁移版本负向契约测试（FR-001、T013；partial）。
- [x] T046 [US2] 实现 Profile 创建/编辑 owner 服务端校验及前端管理路由限制，验证非 owner 403、owner 成功（FR-013、T031、FR-019；partial）。
- [x] T047 修复 Docker 构建、SQL 迁移复制、启动迁移、前端静态资源与 SPA 路由；验证非 root 启动、持久化重启、内存和双架构镜像（plan:Docker/Linux、T015/T042；partial）。
- [x] T048 使用独立临时数据库执行迁移/备份恢复、全量自动化检查与真实浏览器初始化/登录/Profile/PIN/设备流程，不接触用户家庭数据（SC-001～007、T039/T040；partial）。
- [x] T049 同步 spec/plan/research/quickstart/README/roadmap 与验收证据，未验证项不得计入 Verified；核查提交清单排除凭据和运行数据并提交（宪章质量门禁、T043；partial）。

历史 T001 的 pnpm@10、T007 每表边界、T034 reason 文案和 T041 文件名按当前落地解释：pnpm@11.28.5；Household 主键 id 为根边界，版本表为部署元数据；撤销状态使用 revoked_at；脱敏由 logging.interceptor.ts 与 log-redaction.util.ts 实现。当前执行方式以 ADR-0005、data-model.md 和 evidence.md 为准，未实现的字段或工具不作为验收证据。
