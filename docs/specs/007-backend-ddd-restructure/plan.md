# Implementation Plan: 后端代码结构宪章对齐调整（007-backend-ddd-restructure）

**Branch**: `007-backend-ddd-restructure` | **Date**: 2026-10-28 | **Spec**: [spec.md](./spec.md)

**Input**: Feature specification from `/docs/specs/007-backend-ddd-restructure/spec.md`

## Summary

按宪章 v1.4.0 技术约束第 6、7 条对 `apps/server` 做纯结构对齐：将 14 个功能模块归并为 10 个限界上下文，每个上下文内部按「领域 / 应用 / 基础设施 / 接口」四层落位，依赖方向单向向内；跨上下文仅经发布接口、领域事件与 `@hmp/shared` 契约协作。以 dependency-cruiser + knip 建立机械化边界与零遗留审计并纳入合并前门禁。全程外部行为零变化：不改路由、不改契约、不改数据库结构，以既有 50+ 契约/负向测试为可执行契约证据。40 条 nestjs-best-practices 规则逐条给出合规/已记录偏离结论（见 [nestjs-best-practices-compliance.md](./nestjs-best-practices-compliance.md)）。

## Technical Context

**Language/Version**: TypeScript ~5.8，Node.js >= 24（`.nvmrc`=24，pnpm 11.28.5）

**Primary Dependencies**: NestJS 12（common/core/platform-express）、Drizzle ORM 0.44 + better-sqlite3 13、zod 4、argon2、rxjs 7、`@hmp/shared`（workspace 契约包）；新增 devDeps：dependency-cruiser、knip（审计工具，见 research.md D4）

**Storage**: SQLite（better-sqlite3，Drizzle 访问），SQL 文件迁移 0001–0006（up/down 成对），DATA_DIR 外置数据目录

**Testing**: Vitest 3（`test/unit` + `test/contract`，契约测试基于 Supertest 7 + `@nestjs/testing`）、运行时冒烟 `test:runtime`、迁移演练 `migration:drill`

**Target Platform**: Docker/Linux 容器，家用 NAS（docker-compose 交付）

**Project Type**: pnpm monorepo 中的 web-service（`apps/server` 后端 + `apps/web` 前端 + `packages/shared` 契约）

**Performance Goals**: 行为零变化，无新增性能预算；既有 `config/import-budgets.ts`、`config/playback-budgets.ts` 预算保持不变

**Constraints**: 外部可观察行为完全不变（路由/契约/错误语义/数据兼容）；零遗留（无孤儿文件/死代码/临时垫片）；审计违规数必须为 0；规格须 Accepted 且结构方案 ADR 须先于实现被接受

**Scale/Scope**: 约 150 个后端源文件、14 个模块 → 10 个上下文、6 对迁移、50+ 契约/负向测试规格

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

| 门槛 | 状态 | 说明 |
|---|---|---|
| 已接受规格 + 已接受 ADR 链接 | ⏳ 前置条件 | 本规格为 Proposed；实现开始前必须完成 Accepted 流转，并新增「后端 DDD 结构方案 ADR」（含规则偏离清单）。计划本身不违反门槛，仅为开工前置条件 |
| Household → Account → Profile 归属与隔离 | ✅ 通过 | 纯结构重构不改任何归属逻辑；FR-005 + 安全负向测试集全绿作为证据 |
| 服务端会话/策略/播放授权 + 负向测试 | ✅ 通过 | 守卫与授权服务原样归位，行为零变化；既有 `privacy-negative`、`playback-anonymous-rejection` 等用例作为回归证据 |
| Docker/Linux NAS 交付、本地数据、无云端依赖 | ✅ 通过 | 不触及部署与数据位置；无新增运行时依赖 |
| 静态检查 + 测试 + 运行时/契约证据 + 迁移回滚 + 文档同步 | ✅ 通过 | 既有 `lint/typecheck/test/migration:drill` 全保留；新增边界审计纳入同一线（research.md D4） |

**Post-Phase 1 复核**：设计未引入任何宪章例外——不改契约、不改迁移、不放宽身份边界；分层结构本身即宪章第 6 条的落地。无需要记录的违规。

## Project Structure

### Documentation (this feature)

```text
docs/specs/007-backend-ddd-restructure/
├── plan.md              # 本文件（/speckit-plan 输出）
├── research.md          # Phase 0 产出：D1–D7 结构与技术决策
├── data-model.md        # Phase 1 产出：结构实体（分层规则、上下文映射、迁移映射）
├── contracts/           # Phase 1 产出：外部契约冻结 + 内部发布接口契约
│   ├── external-http-invariants.md
│   └── internal-context-contracts.md
├── quickstart.md        # Phase 1 产出：端到端验证指南
├── nestjs-best-practices-compliance.md  # 40 条规则逐条处置清单（US3 验收物）
└── tasks.md             # Phase 2 产出（/speckit-tasks，本命令不创建）
```

### Source Code (repository root)

```text
apps/server/src/
├── main.ts                          # 组合根（入口装配，接口层）
├── app.module.ts                    # 根模块：仅装配各上下文模块
├── platform/                        # 限界上下文：平台横切（原 common/ + config/ + database/ + health/）
│   ├── config/                      #   env.schema / env / budgets        [基础设施]
│   ├── database/                    #   database / migrate / precheck /
│   │   └── migrations/              #   schema.ts + 0001–0006 SQL 对      [基础设施]
│   ├── http-common/                 #   守卫/拦截器/异常过滤器/管道/装饰器  [接口层横切]
│   │   ├── session.guard.ts、current-profile/、same-origin/、settings-access/
│   │   ├── rate-limit/（守卫=接口，策略/服务=应用，客户端IP=基础设施）
│   │   ├── logging.interceptor.ts、api-security-headers.interceptor.ts
│   │   └── problem-json.filter.ts、strict-input/、domain-error.ts、log-redaction.util.ts
│   └── health/                      #   就绪端点                          [接口层]
└── contexts/                        # 业务限界上下文（原 modules/）
    ├── identity-access/             # ← auth + household
    ├── profile/                     # ← profile
    ├── policy/                      # ← policy
    ├── media-catalog/               # ← catalog + public-catalog
    ├── epg/                         # ← epg
    ├── live-tv/                     # ← live
    ├── playback/                    # ← playback
    ├── personal-data/               # ← personal
    ├── settings/                    # ← settings
    └── sources/                     # ← sources + imports
# 每个业务上下文内部统一四层（仅保留非空层）：
#   <context>/
#   ├── domain/            纯 TS：实体/值对象/领域服务/领域事件/端口接口（零框架导入）
#   ├── application/       纯 TS：用例编排、事务边界（零框架导入，经令牌注入端口）
#   ├── infrastructure/    Drizzle 仓储、NAS/ffmpeg/HTTP 适配器实现（@Injectable 允许）
#   ├── interface/         NestJS controller、DTO、上下文内守卫装配
#   └── <context>.module.ts  模块装配 = 唯一对外发布点（配合 index.ts 公共 API）
apps/server/test/                     # unit/ + contract/ 随导入路径机械更新，语义不变
packages/shared/src/                  # 契约 .d.ts（catalog/playback/policy/experience/schema）不变
```

**Structure Decision**: 采用「上下文内四层 + 平台横切上下文」的单体分层结构（Option「web-service 单后端」扩展），不拆分新包、不新建项目。选型依据与备选方案见 research.md D1；逐文件迁移映射见 data-model.md §4。

## Complexity Tracking

> 本节仅在宪章检查存在需论证的违规时填写。本次设计无宪章违规：分层与审计工具均为宪章第 6/7 条的直接落地，非额外复杂度。

| Violation | Why Needed | Simpler Alternative Rejected Because |
|-----------|------------|-------------------------------------|
| （无） | — | — |
