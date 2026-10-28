# Contract: 内部上下文发布接口契约

**Feature**: 007-backend-ddd-restructure | **Date**: 2026-10-28
**性质**: 定义「限界上下文对外发布什么、如何发布」——依赖审计（research.md D4）据此机械判定 FR-003/004。

## 发布面规则

1. **唯一发布点**：每个上下文通过目录下 `index.ts` 导出公共 API；其他上下文**只能** `import` 该 `index.ts`（或 Nest module 的 `exports` 提供者），深导入内部文件即违规。
2. **允许导出**（白名单）：
   - 应用服务**接口**（TS interface / type）+ 对应注入令牌；
   - 领域事件类型定义（如有）；
   - 跨上下文必需的领域值对象/类型（优先放 `@hmp/shared`）。
3. **禁止导出/引用**：具体实现类（application/infrastructure 的 class）、repository、Drizzle schema、DTO、controller、守卫实例。
4. **装配归属**：端口绑定（令牌 → infrastructure 实现）只发生在消费方或根装配的 module 中；domain/application 文件不出现 `@Injectable()`、`@Inject` 以外的 Nest 导入（目标为零 Nest 导入，`@Inject` 仅允许出现在令牌常量定义文件）。
5. **令牌约定**：注入令牌以 `Symbol`/`InjectionToken` 常量集中放在上下文 `<context>.tokens.ts`，随 `index.ts` 导出（对应 skill `di-use-interfaces-tokens`）。
6. **测试例外**：测试文件可经公共入口或 `@nestjs/testing` 装配访问被测对象；禁止为测试在 `index.ts` 之外新增长期导出（防零遗留反弹）。

## 审计映射

| 审计规则 | 判定 |
|---|---|
| 深导入 | `import` 目标路径落在其他上下文 `index.ts` 之外 → 违规 |
| 层逆向 | 依赖矩阵（data-model.md §3）任一 ❌ 边出现 → 违规 |
| 框架渗漏 | domain/application 文件 import `@nestjs/*`、`drizzle-orm`、`better-sqlite3`、`express` → 违规 |
| 遗留物 | knip 报告的孤儿文件/死导出/死依赖 → 违规 |

契约示例（形态示意，非实现代码）：

```text
contexts/policy/
├── index.ts                 # export type { ProfilePolicyPort } from './application/ports'
├── policy.tokens.ts         # export const PROFILE_POLICY_PORT = Symbol('PROFILE_POLICY_PORT')
└── policy.module.ts         # exports: [发布的应用服务提供者]
```
