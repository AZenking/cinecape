# Implementation Plan: ProfilePolicy 内容访问策略

**Branch**: master（speckit feature 标识 `002-profile-policy`；本轮仅设计文档，未创建实现分支） | **Date**: 2026-10-23 | **Spec**: [spec.md](spec.md)

**Input**: Feature specification from `docs/specs/002-profile-policy/spec.md`

**Status**: Accepted（正式 `/speckit-plan` 产出；2026-10-23 维护者接受 spec.md 与 ADR-0006 及全部开放项，宪章门禁 1 闭合）。tasks.md 已授权生成；实现期间规格状态流转 Accepted → Implementing。

## Summary

复用阶段 1 的设备会话、档案归属与 SQL 迁移机制，在服务端建立 ProfilePolicy 存储（一档案一策略、版本化整体保存）与无框架依赖的纯判定核心；前端提供家长验证后的策略配置界面。判定顺序按 spec 策略判定表：会话/归属 → 资源边界 → 策略完整性 → 禁止名单 → 儿童频道白名单 → 未评级开关 → 允许名单覆盖 → 等级上限。目录与播放在阶段 3/4 复用同一授权服务。本轮仅文档，无实现、迁移或测试新增。

## Technical Context

以下均已对照当前仓库核实（2026-10-23）。

- **Language/Version**: TypeScript 5.8 strict / Node >= 24（engines 锁定）/ pnpm 11.28.5（packageManager 锁定）。
- **Primary Dependencies**: 沿用 NestJS 12、drizzle-orm 0.44、better-sqlite3 12、zod 4、argon2 0.44、React 19、HeroUI、react-router 7；无新增框架或外部服务。
- **Storage**: SQLite（本地文件）；配对 SQL 迁移为 DDL 权威（现有 `migrations/0001_init/`），Drizzle schema 同步。
- **Testing**: Vitest 单元/契约（既有 65 用例为回归基线，已复核计数）、Supertest 契约、`test/runtime-smoke.mjs` 真实 HTTP 冒烟、真实浏览器与 Docker/Linux 双架构验收。
- **Target Platform**: 自托管 Docker/Linux NAS，单进程同源前后端。
- **Project Type**: pnpm monorepo Web 服务（apps/server + apps/web + packages/shared）。
- **Performance Goals**: 单次纯判定（evaluatePolicy）不做网络/数据库调用；集成授权先保证正确性，无另立未经测量的性能承诺；沿用阶段 1 性能基线回归。
- **Constraints**: 默认拒绝；服务端事实为唯一信任源；不记录凭据；不扩大到媒体目录或播放器；不改当前 Profile 类型编辑契约。
- **Scale/Scope**: 每 Profile 一条策略，三类名单各至多 1000 个去重标识，单 Household 部署。

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

| # | 门禁 | 设计核对 | 结论 |
| --- | --- | --- | --- |
| 1 | Accepted 规格与关联 ADR；新决策须有 ADR | spec.md 与 [ADR-0006](../../../docs/adr/0006-profile-policy-authorization.md) 于 2026-10-23 被维护者整体接受（含未评级默认值、名单覆盖语义、成人切换保护、锁定 5 次/5 分钟）；领域模型 §6 已同步 | ✅ 已通过（2026-10-23） |
| 2 | Household → Account → Profile 归属；表/缓存/路径显式 household_id；个人数据按 profile_id 隔离 | `profile_policy` 以 (household_id, profile_id) 复合主键并复合外键引用 profile；无 account_id 副本；账号仅做认证与管理 | ✅ 设计满足，实现期以负向测试验证 |
| 3 | 服务端会话 + ProfilePolicy 授权 + 负向测试 | 判定核心为纯函数；资源事实仅服务端构造；授权入口复用受信会话与 activeProfile；quickstart 覆盖篡改/越权/跨家庭负向场景 | ✅ 分阶段设计满足；真实媒体入口在阶段 3/4 验收 |
| 4 | Docker/Linux NAS 交付、本地私有数据、无强制云依赖/遥测 | 无新增外部依赖，SQLite 本地存储，不引入云服务 | ✅ 满足 |
| 5 | 类型/测试门禁、运行时与网络证据、迁移回滚、文档同步 | quickstart 定义 lint/typecheck/test/build/test:runtime、双架构容器证据、0002 up/down/备份恢复演练与 evidence.md；文档同步列入实施顺序 | ⏳ 待实施，不得预先勾选 |

**Phase 1 后重评**：research.md、data-model.md、contracts/api.md、quickstart.md 已完成且与 spec 相互一致（判定表、默认值、锁定参数、名单上限、PUT 契约均对应）。门禁 1 于 2026-10-23 闭合：维护者接受全部开放项，接受值与设计一致，无需修订设计工件；`/speckit-tasks` 已授权执行。

## Project Structure

### Documentation (this feature)

```text
docs/specs/002-profile-policy/
├── plan.md              # 本文件（/speckit-plan 输出）
├── research.md          # Phase 0 输出（/speckit-plan）
├── data-model.md        # Phase 1 输出（/speckit-plan）
├── quickstart.md        # Phase 1 输出（/speckit-plan）
├── contracts/
│   └── api.md           # Phase 1 输出（/speckit-plan）
├── checklists/
│   └── requirements.md  # /speckit-checklist 输出
└── tasks.md             # /speckit-tasks 输出
```

另有 [docs/adr/0006-profile-policy-authorization.md](../../../docs/adr/0006-profile-policy-authorization.md)（Proposed）。

### Source Code（拟修改，尚未执行）

| 文件/区域 | 职责 |
| --- | --- |
| apps/server/src/modules/policy/policy.rules.ts（新增） | 无框架依赖的纯 evaluatePolicy，返回允许/拒绝与稳定原因 |
| apps/server/src/modules/policy/policy.service.ts（新增） | 当前会话档案校验、策略查询/保存、版本一致性与服务端授权入口 |
| apps/server/src/modules/policy/policy.controller.ts、policy.module.ts（新增） | 策略管理契约与模块注册 |
| apps/server/src/modules/auth/parent-verification.service.ts（新增） | 当前账号密码验证、共享失败次数与锁定，不发长期管理令牌 |
| apps/server/src/modules/profile/profile.service.ts、profile.controller.ts | 创建时同事务策略；管理写操作验证；未保护成人切换验证 |
| apps/server/src/common/session.guard.ts | 不改动：继续纯身份与会话归属职责；active Profile 可用性检查由授权入口（policy.service 的 authorizeCurrentProfile，T018）承担，不把内容规则塞入通用 guard |
| apps/server/src/database/schema.ts、migrations/0002_profile_policy/up.sql、down.sql | 策略表、验证计数表、存量回填与成人上下文清空 |
| apps/server/src/database/database.ts、migrate.ts | 就绪与 drill 表清单增加新表；不能只加迁移版本而漏表检查 |
| apps/server/test/unit/、test/contract/、test/runtime-smoke.mjs | 新规则矩阵、授权/验证负向契约与升级回归 |
| apps/web/src/pages/ProfilePolicy.tsx（新增）及 App.tsx、ProfileManage.tsx、ProfilePicker.tsx | 管理路由、策略表单、家长验证弹窗、成人切换验证 |
| packages/shared/ | 实施时新增阶段 2 契约类型和错误码；现有 schema.d.ts 不覆盖或手改 |

**Structure Decision**: 复用阶段 1 既有 pnpm monorepo 布局（apps/server NestJS 分模块、apps/web React 页面、packages/shared 契约），新增 policy 模块与 parent-verification 服务，不新建包或顶层目录。

## 拟定调用流程

管理读取：SessionGuard → owner 校验 → requireOwnedProfile → 查询策略。
管理写入：SessionGuard → owner 校验 → 校验请求 → 家长密码验证 → 目标归属校验 → version 比较 → 单事务替换策略并递增版本。
档案创建/编辑：原流程增加家长验证；创建同事务插入策略。所有字段的编辑都需验证，避免拆分路径遗漏 PIN 清除。
成人切换：归属/可用性 → 有 PIN 时沿用 PIN 授予；无 PIN 且家庭存在任一儿童档案（含停用）时验证主账号密码 → 更新 activeProfile。
未来媒体授权：SessionGuard → 查询当前 activeProfile（归属、active）→ 由 Household 资源适配器加载可信事实 → 读取最新策略 → 纯判定 → 后续设备/来源校验。

不提供接受客户端等级、家庭可用性或目标 Profile 的公开 evaluate 接口。阶段 2 契约测试通过测试专用应用装配可信资源适配器；此入口不得注册到生产 AppModule。阶段 3 必须提供真实适配器并把目录、详情、下载等所有资源入口接入；阶段 4 在 Resolver 返回 URL 前再次授权。

## 实施顺序与依赖

1. **前置（门禁 1）已完成（2026-10-23）**：规格与 ADR-0006 已接受，确认值与设计一致，本计划无需修订。
2. 先写规则矩阵及失败用例，再实现纯规则；无媒体依赖。
3. 迁移与存量回填、创建原子性、缺策略拒绝；同步就绪和迁移夹具。
4. 家长验证计数与锁定、档案管理/切换补强、策略 API 与并发控制；同步 001 契约、quickstart、既有测试夹具的 ownerPassword 入参，保留原负向断言，不能删除失败用例凑通过。
5. 策略管理 UI 与真实后端联调；名单编辑暂不启用，显示接入说明。
6. 临时数据升级/回滚/恢复、全量门禁、真实浏览器与容器证据；完成后才可 Verified。
7. 阶段 3/4 分别补真实目录和播放资源访问的强制授权证据。

## 风险与取舍

- 家长密码每次管理写入都重验，交互较频繁，但避免先引入管理授权票据及其过期/撤销机制。验证弹窗不缓存密码。
- 既有成人无 PIN 不是可靠家长身份。新增成人选择验证与升级时清空相关活动上下文，属于必要且显式的契约变化。
- 本阶段名单编辑延后到目录接入，避免把用户输入 ID 当资源可信事实。服务端持久化与判定核心用真实数据库和服务端夹具验证。
- 允许名单不覆盖未评级与儿童频道门槛；需要维护者接受 ADR 中的细化。
- SQLite 可保证同步写事务；家长密码哈希验证是异步，验证完成后须在事务中重读锁定状态、累加失败或清零，不能依靠过时内存快照。

## Complexity Tracking

无拟议宪章豁免、无待理由化违规。门禁 1 已于 2026-10-23 闭合（规格与 ADR-0006 Accepted），本计划可被引用为实现依据；实现期间按宪章保持规格状态流转与文档同步。
