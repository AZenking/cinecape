# Data Model: 012-live-settings-experience

**Date**: 2026-11-01 | **Spec**: [spec.md](spec.md) | **Research**: [research.md](research.md)

> **零持久化增量声明**：本规格**不新增数据库表/列/迁移**，不改动任何既有持久化 schema。以下实体均为**前端应用会话内状态**或**既有服务端实体的只读消费**。身份隔离原则不变：任何状态不得包含凭据/令牌，个人数据归属 Profile，游客态零个人数据。

## 1. 播放意图（PlaybackIntent）— 前端应用会话内存态

> 既有载体：`app/action-coordinator-core.ts` 的 reducer 状态（005 T043/T053 已交付）。本规格**不新增字段**，仅核对直播入口的填充与消费。

| 属性 | 类型/语义 | 约束（来源） |
| --- | --- | --- |
| intentId | 单调递增序号 | 代次守卫：仅最新 intentId 可 authorize→prepare（005 FR-013） |
| target（PlayTarget） | 频道或节目的播放目标引用 | 不含 URL 外部目标；不含凭据/令牌 |
| returnTo（原目标） | 应用内路径 + 入口上下文 | 经 `sanitizeReturnTarget` 白名单校验，拒绝外部跳转（005 FR-010） |
| entry（入口） | now / next / guide / home 等 | 仅影响返回恢复的页面状态（规格 FR-013） |

**生命周期（澄清 Q2 定案）**：创建于游客/未选档点击播放 → 登录+选档完成后消费（回到原目标继续授权）→ 取消登录/选档即废弃（不自动播放）→ 身份失效（登出/换档/会话撤销）即清除。**不持久化**：页面刷新即消失，重新点击播放即可；绝不写入 localStorage/sessionStorage。

**状态机**：沿用既有 coordinator 状态机（uninitialized→login→bootstrap→picker→selectionPin→play 分支 authorize→prepare→playing），本规格零改动语义，仅补直播入口 e2e 断言。

## 2. 节目详情面板上下文（ProgrammeDetailContext）— 前端组件状态

统一面板（research R2）的输入契约：

| 属性 | 语义 | 约束 |
| --- | --- | --- |
| channel | 频道名称与标识 | 必填 |
| programme | 标题、简介、开始/结束时间、时长 | 暂无节目数据时 programme 为空、显示「暂无节目单」 |
| status | now / upcoming / ended / none | 决定主操作可用性：仅 now 可「播放当前频道」 |
| source | now / next / guide | 仅影响返回恢复的页面状态（FR-013），不影响面板结构 |

**行为约束**：右侧抽屉/浮层呈现、底层页面保持可见；同一面板服务三类入口；Escape 关闭并恢复触发焦点；自动刷新不得关闭面板。

## 3. 直播/节目单页面可恢复状态（LivePageState）— URL 语义状态 + 会话内视口状态

| 状态项 | 载体 | 载体依据 |
| --- | --- | --- |
| date（节目单日期） | URL 查询参数 | 既有 GuidePage readUrlState |
| from / to（时间窗口） | URL 查询参数 | 既有 |
| channelPage / pageSize | URL 查询参数 | 既有 |
| view（节目墙/列表模式） | URL 查询参数 | 既有 |
| 频道/分类筛选 | URL 查询参数（既有项核对） | 「回到现在」不得清除（FR-016） |
| 滚动位置 / 焦点 | 应用会话内存 | research R4：高频瞬态不入 URL |
| 直播首页分区滚动/入口 | 应用会话内存 | 同上 |

**非法值处理**：沿用既有「非法值回落缺省，不因伪造参数崩溃」。

## 4. 设置模块注册表（SettingsModuleMeta 扩展）— 前端常量

既有注册表（T086/T131）扩展分组元数据：

| 属性 | 语义 | 变更 |
| --- | --- | --- |
| key / title / scope / component | 既有 | 不变（七模块、/settings/{key} 路由不变） |
| group | `'personal' \| 'household' \| 'system'` | **新增**：左侧分组渲染依据 |
| scopeLabel（作用范围标注） | 「仅当前设备/本人」「需要管理授权」等 | **新增**：FR-024 标注要求 |

映射基线：household = profiles/policy/sources/epg/devices（+ general 的家庭区域）；system = account（边界表之「关于与帮助」分类本期**不落位**——现行系统无该模块，经分析 U1 显式延后，见 spec FR-025 注记；七模块与路由不变）；personal = 本期无新增项（澄清 Q1「分组先行」，零支持项则整组隐藏，SC-007）。解锁门（settings-unlock-gate）判定逻辑**不动**（归 011 替代关系）。

## 5. 既有服务端实体（只读消费，零改动）

| 实体 | 消费面 | 备注 |
| --- | --- | --- |
| 频道 / 频道分组 | live/groups、live/channels | 分组即「按类型浏览」来源（research R8） |
| 节目排期（programmes） | media/:id/programmes、public/guide | 家庭时区格式化沿用 guide-time/live-format |
| 频道收藏 | /me/favorites/channels | Profile 级，既有；本规格仅约束「收藏不触发播放」交互 |
| 播放授权会话/票据 | 005 playback 链 | 服务端裁决；旧票据身份撤销不可用（FR-022 验证） |
| 会话事实 | GET /auth/session | session-provider 缓存 householdId/Profile/contextVersion，零改动 |

## 6. 状态转换与失效汇总

| 触发 | 失效/转换 | 规格 |
| --- | --- | --- |
| 游客点击播放 | 创建意图 → 登录选档 → 回原目标 → 授权 | FR-006 |
| 取消登录/选档 | 意图废弃，无写入 | FR-006/005 既有 |
| 刷新页面 | 意图与滚动/焦点消失；URL 语义状态保留 | FR-018/Q2 |
| 切换 Profile | 旧个人缓存/授权/在途请求失效（purgePersonalData + 代次） | FR-003 |
| 退出/会话撤销 | 意图清除；旧票据不可用 | FR-022 |
| 30s 刷新 | 数据更新；面板/焦点/分页不变 | FR-014 |
