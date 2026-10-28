# Contract: 外部 HTTP 契约冻结不变量

**Feature**: 007-backend-ddd-restructure | **Date**: 2026-10-28
**性质**: 本特性为纯结构重构，对外契约**零变更**。本文件是冻结清单，任何实现 PR 触碰下列任一项即验收失败。

## 冻结不变量

1. **路由**：全部 controller 的方法与路径（含状态码语义）保持不变。既有契约测试中的每一个 `supertest` 请求即本契约的可执行形式。
2. **请求/响应形状**：全部请求体、响应体字段与类型不变；`packages/shared/src/*.schema.d.ts`（catalog / playback / policy / experience / schema）为前后端共享类型契约，**内容零修改**（`pnpm gen:types` 产物不变）。
3. **错误语义**：Problem JSON 结构、错误码与 `problem-json.filter` 行为不变（`common/domain-error.ts` 迁移不改语义）。
4. **安全行为**：会话、Profile 选中、同源、设置访问、限流、安全响应头等守卫/拦截器的判定行为不变；`privacy-negative`、`playback-anonymous-rejection`、`settings-management-negative` 等负向用例必须全绿。
5. **持久化**：数据库结构（迁移 0001–0006）与 DATA_DIR 布局不变；`migration:up/down/drill` 行为不变，`package.json` 脚本路径不变。
6. **预算**：`import-budgets` / `playback-budgets` 数值不变。

## 可执行契约证据

- `pnpm --filter @hmp/server test:contract`（50+ 契约/e2e 规格，含全部安全负向）
- `pnpm test:runtime`（运行时冒烟）
- `pnpm migration:drill`（空库 up/down/up）
- 实现完成时的前后响应快照抽查报告（运行时行为证据层）

## 变更流程

若实现中发现契约确需变更：**停止结构迁移**，按宪章原则一走独立规格/ADR 流程；本特性内严禁夹带契约变更。
