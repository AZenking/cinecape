# Home Media Platform

一个运行在家庭 NAS 上的自托管媒体平台。它以家庭为资源边界，以 Profile 为观看身份，统一管理 Live TV、电影/剧集、本地媒体库和播放体验。

## 当前状态

- 阶段：项目启动与领域模型固化
- 领域模型：V1.0 Frozen
- 实现状态：尚未开始应用代码脚手架
- 当前规范源：[`homeMediaDomainModel.md`](homeMediaDomainModel.md)

## V1 目标

V1 先解决一个 Household 内的完整观看闭环：

```text
Account 登录
  → 选择 Profile
  → 浏览 Household 可用媒体
  → 按 ProfilePolicy 校验访问权限
  → 解析 PlaybackSource
  → 播放并保存个人进度
```

V1 采用一个 Household、一个主要 Account、多个 Profile 的模型。多 Household、多 Account、复杂转码和社交共享不属于第一阶段。

## 文档入口

| 文档 | 用途 | 状态 |
| --- | --- | --- |
| [`docs/project-brief.md`](docs/project-brief.md) | 产品目标、用户、MVP、范围和成功标准 | Accepted foundation |
| [`homeMediaDomainModel.md`](homeMediaDomainModel.md) | 实体、边界、权限、流程、API 和验收基线 | Frozen V1.0 |
| [`docs/adr/0001-household-account-profile.md`](docs/adr/0001-household-account-profile.md) | 固化 Household、Account、Profile 的关键决策 | Accepted |
| [`docs/roadmap.md`](docs/roadmap.md) | 阶段顺序、依赖和完成条件 | Living |
| [`docs/spec-driven-development.md`](docs/spec-driven-development.md) | 新功能如何从规格进入实现和验证 | Accepted process |
| [`docs/specs/README.md`](docs/specs/README.md) | Feature Spec 存放位置和命名约定 | Accepted process |

发生冲突时，以状态为 `Frozen` 或 `Accepted` 的规范文档为准。

## 规格驱动工作方式

新增能力按下面的顺序推进：

1. 在 Project Brief 中确认目标和范围；
2. 在领域模型中确认实体、边界和不变量；
3. 为跨模块或有业务风险的能力编写 Feature Spec；
4. 对持久架构决策编写 ADR；
5. 实现代码和测试；
6. 用验收标准记录静态、测试和运行时证据。

没有被 `Accepted` 的规格，不作为实现承诺。规格发生变化时，先更新规格和 ADR，再修改代码。

## 本地启动

当前目录只有项目文档，尚未提交应用运行时、依赖清单或启动脚本。因此暂时没有可执行的 `install` 或 `dev` 命令；脚手架建立后必须在本节补充：

- 运行时版本；
- 依赖安装命令；
- 环境变量和示例配置；
- 数据库迁移命令；
- 开发、测试和生产构建命令。

## 变更规则

- 业务边界和身份模型的变化必须新增或更新 ADR；
- 新功能必须有可验证的验收标准；
- 个人数据默认关联 `profile_id`，家庭资源默认关联 `household_id`；
- 播放授权必须经过服务端 ProfilePolicy 和 Playback Resolver；
- 文档、代码和测试应在同一个变更中保持一致。
