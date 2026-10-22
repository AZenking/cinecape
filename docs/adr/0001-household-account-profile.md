# ADR-0001：采用 Household、Account、Profile 三层身份模型

- 状态：Superseded
- 替代决策： [ADR-0003](0003-constitution-alignment.md)（2026-10-22）
- 历史说明：以下正文保留原始决策；Profile 直接归属 Household 的规则不再有效，当前模型以 ADR-0003 和宪章为准。
- 日期：2026-10-22
- 适用版本：V1.0
- 相关文档：[`homeMediaDomainModel.md`](../../homeMediaDomainModel.md)

## Context

Home Media Platform 需要同时满足三个不同问题：

1. 家庭媒体资源属于谁；
2. 哪台设备被允许访问家庭媒体平台；
3. 当前是谁在观看，以及当前观看者可以访问哪些内容。

如果只使用一个 User 或 Account，家庭成员的观看数据和内容限制会混在一起。如果完全依赖客户端保存当前成员，则 Profile 切换可以被修改，无法作为授权依据。

## Decision

V1 固定采用以下模型：

```text
Household
├── Account
│   └── DeviceSession
│       └── activeProfileId
├── Profiles
│   └── ProfilePolicy
└── Media Sources / Media Library / Devices
```

### Household

作为顶层资源和权限边界。第一阶段每个部署只支持一个 Household，但所有资源查询、缓存、播放授权和文件访问都保留 Household 校验。

### Account

只负责认证、会话和管理员权限。V1 一个 Household 只有一个主要 Account，不为每个家庭成员建立独立密码。

### Profile

表示当前观看者。Profile 直接归属 Household，不直接归属 Account。观看历史、播放进度、收藏、Watchlist、偏好和内容策略都以 `profile_id` 为个人数据边界。

### DeviceSession

把 Account、Device 和当前 Profile 绑定起来。`activeProfileId` 必须由服务端验证和更新，不能信任前端传入值、URL 或 `localStorage`。

### ProfilePolicy

负责内容授权。`adult/child` 只表示默认体验和界面模式，不是最终授权依据。实际授权必须结合内容等级、黑名单、白名单、未评级策略和频道白名单。

## Alternatives considered

### 为每个家庭成员建立独立 Account

不采用。它会让家庭登录、设备授权和家庭管理员管理复杂化，也不能替代 Profile 级别的观看数据隔离。

### 不设置 Household，直接让 Account 拥有所有资源

不采用。这样无法清晰表达家庭资源边界，也会让未来的多家庭部署、缓存隔离和文件授权更难补救。

### 只在前端保存当前 Profile

不采用。客户端状态可以被修改，不能保护成人内容、儿童频道限制或个人数据。

## Consequences

### 正面影响

- 家庭只需一次登录，Profile 切换体验简单；
- 个人数据天然以 `profile_id` 隔离；
- 家庭资源和个人观看状态边界清楚；
- 后续可以在不改变 Profile 数据模型的情况下增加多个 Account 或多个 Household；
- 播放授权有统一的服务端入口。

### 代价

- 每个个人数据查询都必须携带并验证 Profile 上下文；
- DeviceSession 需要保存当前 Profile，并处理过期、撤销和 PIN；
- 不能把前端路由或本地存储当成权限系统；
- 未来扩展多 Account 时需要增加 Account 与 Household 的授权关系。

## Invariants

1. `accountId`、`deviceId`、`activeProfileId` 必须属于同一个 Household；
2. 个人媒体数据不能只关联 `account_id`；
3. 播放请求必须经过服务端 ProfilePolicy；
4. 不允许通过修改客户端 Profile 状态绕过内容限制；
5. 所有家庭资源、缓存和文件访问都必须能追溯到 Household；
6. 变更身份模型必须新增 ADR，并同步更新领域模型、规格和测试。

## Migration and rollback

V1 的实现可以从单 Household、单 Account 开始，但数据结构保留 `household_id`、`account_id` 和 `profile_id`。如果该决策需要撤回，先停止新数据写入，再通过迁移将 Profile 数据和 DeviceSession 转换到新的身份关系；不得直接删除这些边界字段。
