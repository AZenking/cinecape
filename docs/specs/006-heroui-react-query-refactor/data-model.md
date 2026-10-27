# Data Model: PC 端 UI 组件与数据请求架构全面调整

**Feature**: `006-heroui-react-query-refactor` | **Date**: 2026-10-27
**Spec**: [spec.md](./spec.md)

> 本特性为呈现层等价重构：**不新增/变更任何服务端领域实体与接口契约**。
> 本文档定义的是前端数据层（缓存）与组件体系的实体模型，全部存在于
> `apps/web` 运行时内存中，不落盘、不入库。

## 实体总览

```text
IdentityCacheScope（身份缓存域）
 ├── QueryEntry（查询条目）×N        —— 键控缓存的服务端数据
 └── MutationEntry（变更条目）×N     —— 有副作用的服务端操作

SharedUiControl（统一控件映射）      —— 原生控件 → HeroUI 组件
SharedHook（共享 Hook）              —— 通用逻辑注册清单
```

---

## 1. IdentityCacheScope（身份缓存域）

**代表**：前端缓存的隔离边界，宪法原则二/三的呈现层落实。

| 属性 | 值域 | 规则 |
| --- | --- | --- |
| `scope` | `public` \| `profile` \| `settings` | 键首段决定域归属（见 contracts/query-keys.md） |
| 生命周期 | 页面会话期 | `profile` 域在切档/登出/401 时整体取消并清除；`public` 域保留 |
| 隔离规则 | — | 公共响应不得进入 `profile` 域；`profile` 键必须携带当前 `profileId`；`settings` 域每次进入请求最新（FR-012/016/020/021） |

**状态转换**（域级）：

- 登录/选档成功 → 建立/切换 `profile` 域命名空间。
- 切换 Profile / 退出登录 / 收到 401 → `cancelQueries(profile.*)` → `removeQueries(profile.*)` → 丢弃在途结果（US3 验收）。
- `public` 域不受身份切换影响（FR-022 的键控与隔离策略由 ADR 复核）。

## 2. QueryEntry（查询条目）

**代表**：按 `资源 + 参数 + 身份域` 键控的服务端数据缓存单位。

| 属性 | 说明 |
| --- | --- |
| `key` | 序列化元组，首段 = 域（`public`/`profile`/`settings`），见 contracts/query-keys.md |
| `data` / `dataUpdatedAt` | 数据与更新时间 |
| `status` | `pending` / `error` / `success` |
| `fetchStatus` | `idle` / `fetching`（驱动"显示旧数据+后台刷新"的组合判定） |
| `staleness` | 新鲜/过期；浏览型允许过期即显（SWR 语义），设置型强制过期 |

**行为规则**：

- 浏览型（目录/详情/指南/直播/收藏/历史）：过期即显 + 后台刷新 + 无缝更新（FR-012）。
- 设置型（账号/档案/策略/来源/设备/EPG 配置）：挂载即取最新、以加载态呈现，禁止旧值先行（FR-012、Q2 澄清）。
- 取消：键参数变化或卸载时在途请求自动取消/结果丢弃（FR-015）。
- **播放解析不在查询缓存中**：播放票据/资源地址走一次性变更动作，凭据不缓存（宪法原则三）。

## 3. MutationEntry（变更条目）

**代表**：一次有副作用的服务端操作。

| 属性 | 说明 |
| --- | --- |
| `key` / `scope` | 操作标识与所属域 |
| `feedback` | `optimistic`（收藏/星标、观看状态、进度类）\| `confirmed`（表单保存、PIN、来源/策略等管理变更）——Q1 澄清 |
| `optimistic` | 乐观快照 + 失败回滚 + 统一提示（toast） |
| `invalidates` | 成功后需失效/更新的相关查询集合（FR-013） |
| `idempotent` | 按服务端契约保持幂等；客户端不自动重试非 GET（FR-014，防重复副作用） |

**状态转换**：`idle → pending →(optimistic: 先应用快照)→ success(失效相关查询) / error(回滚+提示)`；重复触发在 pending 期间去重/禁用。

## 4. SharedUiControl（统一控件映射）

**代表**：原生控件 → HeroUI v3.2.6 组件的等价替换映射（组件清单已在
`apps/web/node_modules/@heroui/react@3.2.6` 本地核验，详见 contracts/ui-components.md）：

| 原生用法（现存 8 处 + 通用） | HeroUI 组件 |
| --- | --- |
| `<select>`（设置×4、EPG×3） | `Select`（Root/Trigger/Value/Indicator/Popover） |
| `window.alert`（档案主档变更提示） | `AlertDialog` / `Modal` + `Toast` 反馈 |
| 手写 loading（shared/ui/loading、skeleton） | `Skeleton` / `Spinner` / `ProgressBar` / `ProgressCircle` |
| 手写错误提示（shared/ui/retryable-alert） | `Alert` + 重试动作封装 |
| 空态 | `EmptyState` |
| 轻量操作反馈（回滚/成功提示） | `Toast` |

**约束**：复合组件写法（`X.Root`/命名空间子组件）、`onPress` 而非 `onClick`、
语义化变体（primary/secondary/danger…）、固定暗色主题（`html.dark`，主题切换不在范围）、
全站 WCAG AA 审计不在范围（Q4 澄清，等价基线）。

## 5. SharedHook（共享 Hook 注册清单）

**代表**：通用逻辑唯一注册入口 `apps/web/src/shared/hooks/`。

| 属性 | 规则 |
| --- | --- |
| `source` | 开源库 re-export（优先）\| 自研（须附"为何不用现成库"理由 + 单测） |
| `coverage` | 防抖/节流、轮询/定时、媒体查询、元素尺寸、事件监听、本地存储等（FR-030/031） |
| 存量迁移 | `features/settings/use-media-query.ts`、live 轮询、EPG 窗口计算的通用部分收编（FR-032） |

具体库选型与对应关系见 [research.md](./research.md) 决策 D1；轮询节奏保留直播 30s 契约现状。

## 验证规则汇总（来自需求）

- FR-002：原生交互控件源码计数 = 0（`grep` 扫描可证）。
- FR-012/Q2：`settings` 域查询 `staleness` 恒为过期 + 挂载必取；渲染门控在加载完成。
- FR-013/Q1：`feedback=optimistic` 的操作必须有回滚路径；`confirmed` 类必须有等待态。
- FR-015：键变化/卸载 → 在途请求取消；过期响应不回写。
- FR-020/021：`profile` 域键含 `profileId`；身份切换触发域级清除（US3 场景）。
- SC-009：首屏关键路径传输体积增幅 ≤ 15%（构建产物测量，基线见 quickstart.md）。
