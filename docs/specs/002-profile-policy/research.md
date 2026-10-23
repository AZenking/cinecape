# Research: ProfilePolicy 设计依据与决策提案

日期：2026-10-23；状态：Accepted（2026-10-23 随规格与 ADR-0006 一并接受）。来源为当前仓库文档与源码，未进行外部技术选型；以下“决定”均已接受为设计依据，但仍不是已实现事实。

## 当前基线

- homeMediaDomainModel.md §3.5 已定义七个策略字段和禁止优先等顺序；未定义具体等级表、默认等级或管理再验证。
- schema.ts 当前仅有身份表，无策略/媒体表；Profile 创建事务只写档案。
- profile.controller.ts 只校验 owner；同一 owner 会话可选择 child，因而管理角色并不能证明操作者是家长。
- selectProfile 无 PIN 时直接切换；成人无 PIN 档案可成为儿童绕过路径。
- Profile 更新没有 type 字段，本期不新增类型转换，避免默认策略意外重置。
- session.guard.ts 校验会话归属，不检查 active Profile 的 status；停用流程依赖级联清空。策略授权入口需要重新校验当前档案及策略。
- database.ts 和 migrate.ts 存在固定业务表清单，新增迁移必须同步；SQL 为权威。
- packages/shared 的 gen:types 仅指向 001 OpenAPI；新增契约需独立生成导出，不能替换阶段 1 类型造成回归。
- 阶段 1 已有 65 用例与真实 HTTP 冒烟；均是回归基线，不是阶段 2 证据。

## 决策 1：核心规则与资源装配分离

**Decision**: 纯规则接收服务端构造的 policy、Profile 类型和可信资源事实；应用服务完成会话、归属、查询与拒绝。
**Rationale**: 阶段 2 无媒体目录，仍可交付可复用规则；后续入口共用，客户端不能伪造事实。
**Alternatives considered**: 提前做媒体表/Resolver 扩大阶段范围；公开 evaluate 接口接受 rating 等会形成不可信授权。

## 决策 2：内部年龄阈值与保守覆盖顺序

**Decision**: 0～18 整数，adult=18/allowUnrated=true，child=12/false；禁止优先；允许只覆盖已评级内容的等级；儿童频道仍需白名单。
**Rationale**: 提供可测试默认值，避免臆造地区分级标准。外部无法映射的值按未评级。
**Alternatives considered**: 任意整数没有可解释 UI；引入某地区分级未获需求支持；允许名单覆盖全部规则扩大权限。
**Status**: 2026-10-23 随规格与 ADR-0006 接受：年龄阈值 0～18（儿童 12/成人 18）、成人默认允许未评级、儿童默认禁止未评级、名单覆盖顺序按判定表生效。

## 决策 3：家长验证覆盖扩大权限路径

**Decision**: owner 管理写操作每次重新输入主账号密码；有儿童家庭切换未设 PIN 成人也需密码；有 PIN 的选择保留既有 PIN 规则。失败计数落库，账号范围 5 次/5 分钟锁定。
**Rationale**: owner 会话本身由儿童共用，不足以保护策略；封堵新建成人、清 PIN 和选择无 PIN 成人三条路径。
**Alternatives considered**: 只做 owner 校验存在已知绕过；仅检查 activeProfile.type 可先选未保护成人；长期家长模式增加票据被共用和撤销复杂度。
**Status**: 2026-10-23 随规格与 ADR-0006 接受：管理写操作重验主账号密码、儿童家庭未设 PIN 成人切换验证、连续 5 次失败锁 5 分钟及 contracts/api.md 契约。

## 决策 4：策略行 JSON 名单与乐观并发

**Decision**: 单行存储三个 JSON 字符串数组、整数版本。去重排序持久化，版本条件写入防覆盖。
**Rationale**: 每名单最多 1000 项，规则整体保存，一行事务简单；当前无资源表可建立资源外键。
**Alternatives considered**: 提前建立虚构媒体 FK 无依据；拆分名单表增加迁移和整体版本维护成本，可在规模变化后重新评估。

## 决策 5：无目录时不暴露任意 ID 编辑

**Decision**: 普通策略 PUT 暂只更新等级/未评级字段并保留名单，名单通过服务端夹具验证；阶段 3 才接资源选择与归属验证后启用编辑。
**Rationale**: 不能把客户端传入的未知 ID 认定为同家庭媒体；也不把阶段 2 策略核心说成已阻止真实播放。
**Alternatives considered**: 任意 ID 文本输入不可验证且体验差；提前做目录超范围。
