# ADR-0002：V1 一个部署实例对应一个 Household

- 状态：Accepted
- 日期：2026-10-22
- 适用版本：V1.0
- 相关文档：[`homeMediaDomainModel.md`](../../homeMediaDomainModel.md)
- 前置决策：[`ADR-0001`](0001-household-account-profile.md)

## Context

Home Media Platform 的第一目标是运行在个人或家庭 NAS 上，为一个家庭提供统一的媒体入口。当前没有多家庭托管、组织管理或 SaaS 租户的需求。

如果现在引入 `Installation`、Tenant 或多 Household 管理层，会增加认证、资源查询、缓存、文件访问、媒体来源和播放授权的复杂度，但不会为 V1 用户提供直接价值。

## Decision

V1 固定以下关系：

```text
一个部署实例
└── 一个 Household
    ├── 一个主要 Account
    ├── 多个 Profile
    ├── 多个 Device
    └── 多个 Media Source / Media Library
```

V1 不实现：

- 一个部署实例下的多个 Household；
- Household 切换器；
- 多 Household 管理后台；
- 跨 Household 的媒体、用户或设备共享；
- 单独的 `Installation` 或 Tenant 实体。

但是，业务数据仍然保留并验证 `household_id`。单 Household 是部署规模约束，不是取消资源边界的理由。

## Consequences

### 正面影响

- V1 认证和资源授权链更短；
- NAS 部署不需要配置租户选择；
- 缓存、媒体文件和播放来源可以按单一 Household 做一致校验；
- 仍然保留未来扩展多 Household 所需的核心边界字段。

### 代价

- V1 不能在同一个部署实例中隔离多个家庭；
- 如果未来需要多 Household，不能只增加一个切换页面；
- 未来扩展需要重新审查会话、缓存、文件路径、媒体来源和后台任务的边界。

## Invariants

1. 每个 V1 部署实例只能存在一个有效 Household；
2. Account、Profile、Device、MediaSource 和个人数据必须属于该 Household；
3. 客户端不能通过传入另一个 `household_id` 改变当前资源边界；
4. 缓存键、文件路径、播放授权和后台任务不能跨 Household 复用；
5. 多 Household 需求必须新增 ADR，并包含数据迁移、会话迁移和回滚方案。

## Revisit trigger

只有出现以下需求时，才重新评估本决策：

- 一个 NAS 需要服务多个互不信任的家庭；
- 需要提供多用户 SaaS 托管；
- 需要组织级管理员、计费或独立配额；
- 现有 Household 边界无法满足部署隔离要求。
