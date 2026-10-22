# 规格驱动开发约定

- 状态：Accepted process
- 适用范围：Home Media Platform 的新功能、跨模块改动和领域模型变更

规格驱动开发（Spec-Driven Development）的核心不是先写大量文档，而是让实现前先明确目标、边界、规则和可验证结果。代码实现规格，测试证明规格，文档记录长期决策。

## 1. 工作流

```text
Project Brief
    ↓
Domain Model
    ↓
Feature Spec
    ↓
ADR（需要时）
    ↓
Implementation
    ↓
Verification Evidence
    ↓
Release Notes
```

### Project Brief

回答为什么做、谁使用、V1 做什么和明确不做什么。产品范围变化时更新。

### Domain Model

回答有哪些实体、谁拥有数据、权限边界在哪里、哪些业务不变量必须始终成立。当前规范源是 [`homeMediaDomainModel.md`](../homeMediaDomainModel.md)。

### Feature Spec

回答一个具体能力要改变什么，以及怎样判断完成。Feature Spec 应放在 `docs/specs/`，一个规格只描述一个可交付能力。

### ADR

记录不可逆或影响多个模块的设计选择、备选方案和代价。ADR 不删除历史，反向决策时新增 ADR 并标记旧决策为 `Superseded`。

### Verification Evidence

验收证据必须区分层次：

| 证据层 | 说明 |
| --- | --- |
| 静态 | 文件、接口、类型、数据库结构和调用关系符合规格 |
| 单元/集成测试 | 规则和失败路径可重复验证 |
| 运行时 | 真实应用流程、设备或浏览器行为符合预期 |
| Network/Backend | 请求 payload、响应和持久化结果符合契约 |

单元测试通过不能代替运行时或后端证据；静态存在接口也不能证明真实请求已经正确。

## 2. Feature Spec 最小模板

```markdown
# Feature: <能力名称>

- Status: Proposed
- Owner: <负责人>
- Target: <目标版本或阶段>
- Related: <领域模型和 ADR>

## Context

为什么需要这个能力，谁受到影响。

## Current State

当前行为和已验证证据。

## Scope

### In scope

- 明确包含的用户行为、接口、数据和失败路径。

### Out of scope

- 明确不包含的相邻需求。

## Domain Rules

1. 可验证的业务规则。
2. 权限、幂等、空值、重复请求和边界输入规则。

## Contract

请求、响应、数据变化、错误码和兼容性要求。

## Acceptance Criteria

1. 通过/失败可判断的验收条件。
2. 失败路径和安全边界的验收条件。

## Testing Plan

| Layer | Evidence | Count/Scope |
| --- | --- | --- |
| Unit | 领域规则和失败路径 | <具体范围> |
| Integration | API、数据库和权限链路 | <具体范围> |
| Runtime | 浏览器、设备或真实流程 | <具体范围> |

## Rollback

如何撤回代码、配置或数据迁移。

## Open Questions

只保留真正阻塞实现的问题。
```

## 3. 规格状态

```text
Proposed → Accepted → Implementing → Verified
                       └────────────→ Superseded
```

- `Proposed`：正在讨论，不能作为实现承诺；
- `Accepted`：范围和契约已确认，可以开始实现；
- `Implementing`：代码和测试正在进行；
- `Verified`：验收标准已有对应证据；
- `Superseded`：被新规格或 ADR 替代，保留用于追溯。

## 4. 本项目的硬规则

1. 新能力先写规格，再写实现；
2. 规格必须写清楚范围和非目标；
3. `profile_id`、`household_id`、`activeProfileId` 的语义不能由单个实现者自行改变；
4. 任何权限相关规格必须包含越权和篡改输入的负向验收条件；
5. 每条验收标准至少对应一种证据；
6. 规格、代码和测试应在同一个交付变更中保持一致；
7. 需求变化不直接覆盖旧决策，使用 ADR 或新规格记录替代关系。

## 5. 规格审查清单

- [ ] 是否说明了用户和业务价值？
- [ ] 是否写出了当前行为，而不是只写理想行为？
- [ ] 是否明确 In Scope 和 Out of Scope？
- [ ] 是否明确 Household、Account、Profile 的数据边界？
- [ ] 是否覆盖空值、重复请求、非法身份和越权输入？
- [ ] 是否给出实际请求、响应或数据结构？
- [ ] 是否有可判定的验收标准？
- [ ] 是否有单元、集成和运行时验证计划？
- [ ] 是否说明迁移和回滚？
- [ ] 是否需要新增 ADR？
