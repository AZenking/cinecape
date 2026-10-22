# ADR-0003：遵循宪章统一身份模型与规格流程

- 状态：Accepted
- 日期：2026-10-22
- 依据：[宪章 1.0.1](../../.specify/memory/constitution.md)
- 替代：[ADR-0001](0001-household-account-profile.md)
- 保留：[ADR-0002](0002-one-deployment-one-household.md) 的单部署单 Household 约束
- 授权依据：维护者要求严格按照现行宪章处理冲突。

## Context

原领域模型让 Profile 直接归属 Household，与宪章要求的 Household → Account → Profile 层级冲突。Spec Kit 的默认生成目录也与宪章指定的 docs/specs/ 不一致。Frozen 或 Accepted 状态不能覆盖宪章。

## Decision

1. Household 拥有 Account，Account 拥有 Profile。Profile 同时保留 householdId 与 accountId，二者必须指向同一家庭。个人观看数据仍以 profileId 隔离，不能以 accountId 替代观看身份。
2. DeviceSession 的 accountId 必须与所选 Profile.accountId 相同；Account、Device、Profile 的 householdId 必须相同。
3. 所有持久化数据库表保留显式 household_id，缓存键与存储路径保留显式家庭边界。个人数据同时保留 household_id 和 profile_id。概念接口不等于数据库表；建表设计必须逐表验证宪章要求。
4. 功能规格统一位于 docs/specs/NNN-feature/spec.md；同目录保存 plan.md、tasks.md 和验收证据。工具默认值必须遵循该路径。
5. 每份规格必须关联已接受的 ADR。宪章工作流中的“ADR，必要时”解释为必要时新增 ADR，不免除已接受 ADR 的关联与合规检查。
6. 继续执行 ADR-0001 中不冲突的规则：Account 负责认证与管理权限，ProfilePolicy 负责内容授权，服务端维护 Active Profile，个人数据隔离，播放经过统一授权入口。

## Alternatives considered

- 修改宪章以保留原模型或根目录 specs/：不采用，维护者明确要求按现行宪章处理。
- 静默覆盖原 ADR：不采用，违反宪章的决策历史保留要求。

## Consequences

Profile 的归属及会话校验需要额外的 Account 一致性约束；家庭共享 Account 仍只需一次登录。将来引入多 Account 时，Profile 转移与授权关系必须另立决策。Spec Kit 升级时必须检查本地目录适配是否被覆盖。

## Migration and rollback

当前仓库尚无应用数据库，本次只同步文档、模板与生成脚本，无存量数据迁移。未来实现必须为 household_id、account_id、profile_id 的一致性建立数据库约束与负向测试。撤回本次身份决策需先走宪章修订流程，再新增替代 ADR；不能直接恢复已被替代的规则。

## Verification

检查当前有效文档不再要求 Profile 独立于 Account；生成脚本的 dry-run 指向 docs/specs/；模板与流程使用相同目录；历史 ADR 标记替代关系。此处仅记录文档与工具校验，不代表运行时身份功能已实现。
