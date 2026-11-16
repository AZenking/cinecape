# ADR-0024：后端分层瘦身（文件粒度、端口与模块边界）

- 状态：Proposed（草案；待维护者接受后生效，接受前不得作为实现承诺）
- 日期：2026-11-16
- 适用版本：V1.x
- 依据：宪章 v1.10.0 原则一（规格驱动/行为可证）、原则五（ADR 治理）、技术约束 6（DDD 分层与边界）；[ADR-0014](0014-backend-ddd-structure.md)（分层矩阵）、[ADR-0015](0015-repository-extraction.md)（仓储抽取）
- 关联：规格 007（结构对齐）、008（仓储抽取）；审计基线提交 `0714fbb`（knip / depcruise / purity 三闸全绿）
- 影响面：`apps/server` 的**文件组织与装配方式**；不改 API、DTO、数据库 schema、URL、领域规则

## Context

ADR-0014 把后端固定为「限界上下文 × 四层」，落地后行为零变化、边界审计归零，这是正确的结构基线。运行两个月后，成本结构已经可以量化（2026-11-16 实测）：

| 指标 | 现状 |
|---|---|
| 上下文数 | 11（epg / live-tv / playback / sources / settings / identity-access / profile / policy / media-catalog / online-vod / personal-data） |
| TS 文件 | 277，contexts 约 62.9k 行 |
| 控制器 / 端点 | 33 / 112 |
| 端口 / 注入令牌 | 45 个 `*Port` 接口；11 个 tokens 文件、40 个 Symbol 令牌 |
| 单文件规模 | `playback.module.ts` 1825 行、`schema.ts` 2557 行、`playback-resolver.service.ts` 1452 行、`hls-proxy.service.ts` 1330 行 |

复杂度里有三块是**产品固有**的，不能也不应通过“拍平”消除：

1. **playback**：转码/HLS 代理/探测/会话状态机（`generation/version` CAS、票据、心跳、清理）；
2. **EPG / 直播**：UTC 存储、家庭时区日界、DST 23/25 小时日、跨午夜与零时长脏数据修复；
3. **安全边界**：公共/会话双凭据、SSRF 白名单、限流、按 Household/Profile 的作用域校验。

真正属于“分层仪式”的成本有三块，且都可量化：

1. **薄上下文的过度拆分**：`settings`（domain 0 文件、2 个 provider、9 个 controller）、`profile`（domain 0、application 5 文件、interface 1 文件）、`identity-access`、`personal-data` 的业务只是 CRUD/投影，但仍按“一用例一文件/一端口一令牌”铺开；
2. **单实现端口**：45 个 `*Port` 中相当一部分只有一个实现、且没有测试替身或第二实现的实际需求，每加一个字段要动 port + impl + token + module 四处；
3. **巨型文件**：`playback.module.ts`（1825 行 / 35 个 provider）与 `schema.ts`（2557 行）与分层无关，已经把“找一处配置”变成全文检索。

结论：**问题不在 DDD 分层本身，而在“层内的文件粒度”和“抽象的数量”**。因此本 ADR 不合并限界上下文、不取消四层，只收紧粒度与抽象准入。

## Decision

### D1 · 分层保留，粒度分级（graded granularity）

1. 四层目录仍是**强制骨架**（`interface` / `application` / `infrastructure` / `domain`）；跨层依赖方向仍由 depcruise 强制。
2. **层内文件粒度按用例规模决定**，不再“一用例一文件”：
   - 同一上下文、同一资源的 CRUD/投影用例，**允许合并为一个 application service 文件**（建议 ≤400 行）；
   - controller 按资源聚合，**允许一个 controller 承载同一资源的多个路由**（既有 9 个 settings controller 可收敛为 3–4 个）；
   - `domain/` 只在存在**纯规则**（时间窗、匹配、状态机、归一化）时存在；纯 CRUD 上下文不得为“凑四层”新建空 domain 目录或纯转发文件。
3. 事务边界仍留在 application/仓储端口，controller 不得直接调用 `Database`/store。

**适用判定**：

| 上下文 | 处置 |
|---|---|
| playback、epg、sources、live-tv、policy | 保持现有四层与端口（核心规则/安全面） |
| online-vod、media-catalog | 保持四层；模块装配按 D3 拆分 |
| settings、profile、identity-access、personal-data | 允许 D1.2 的文件合并；端口按 D2 清理 |

### D2 · 端口与注入令牌的准入规则

一个 `*Port` + Symbol token **只有满足以下任一条才保留**：

1. 跨上下文发布面（`contexts/*/index.ts` 导出）；
2. 安全/授权边界（如 `SafeUpstreamPort`、`SettingsGrantValidator`、播放解析/票据相关）；
3. 有 ≥2 个真实实现（如 HLS/直连、不同媒体后端）；
4. 测试需要在运行时替换实现（非仅类型 mock）。

不满足者改为**直接注入具体类**（Nest 构造器注入，无需 Symbol token），删除对应 `*.tokens.ts` 条目与 module 里的 `useValue/useClass` 声明。playback 状态机、EPG 发布、policy 评估相关端口**不在本轮清理范围**。

### D3 · 文件与模块规模上限

1. 单文件软上限 **400 行**、硬上限 **600 行**（生成物 `schema.ts` 与迁移除外）；超限必须按子域拆分。
2. Nest module 只保留“装配清单”，provider 工厂/实现注册拆到同目录 `*.providers.ts`；`playback.module.ts`、`online-vod.module.ts` 为首批拆分对象。
3. `platform/database/schema.ts` 按表域拆为 `schema/*.ts`，原 `schema.ts` 仅做 re-export，保持 knip entry 与既有 `@platform/database/schema` 导入面不变。
4. 拆分不得改变 provider 的 token、作用域（singleton/request）与初始化顺序；拆分后必须通过全量 typecheck 与启动冒烟。

### D4 · 迁移波次与验收

按“先无边界变化、后有边界变化”排序，每波独立提交、可单独 revert：

| 波次 | 内容 | 边界变化 | 验收 |
|---|---|---|---|
| W1 | `schema.ts` 拆分 + `playback.module`/`online-vod.module` 装配拆分 | 无 | typecheck、全量测试、构建、启动冒烟；OpenAPI 快照 diff 为空 |
| W2 | 薄上下文文件合并（settings/profile/identity-access/personal-data） | 无（层不变） | 同上 + contract 测试逐字不变 |
| W3 | 单实现端口/Token 清理（按 D2 判定，逐个附理由） | 依赖结构变化 | 同上 + 依赖图 diff 评审 |
| W4 | 度量复盘：文件数、平均文件行数、module 行数、端到端耗时 | — | 目标：文件数 −15%，`playback.module` ≤600 行，`schema.ts` ≤80 行（仅 re-export） |

**每波统一门禁**：`typecheck`、`eslint`、`test`（全量）、`audit:orphans`、`audit:boundaries`、`audit:purity`、`build`；W3 额外要求 depcruise 模块/依赖数与预期一致，禁止出现新的跨上下文边。

### D5 · 度量与停止条件

- 以 `0714fbb` 为基线记录：277 文件 / 62.9k 行 / 45 个端口 / 三闸全绿；
- 每波结束更新本 ADR 的“实施状态”表（追加，不改历史决策文本）；
- 若某波导致行为差异、测试需要改断言语义、或审计需放宽规则，**停止该波并回退**，另立 ADR。

## Non-goals

1. 不把后端改写为传统 MVC；不合并 playback / epg / sources / live-tv / policy 上下文；
2. 不改任何 HTTP 契约、DTO、DB schema、迁移、URL、错误码；
3. 不移除 Guard/Filter/限流/SSRF/家庭作用域校验；
4. 不删除历史 ADR/规格；ADR-0014 主体继续有效，本 ADR 仅细化其“层内粒度与抽象准入”。

## Alternatives considered

- **全量 MVC 重写**：文件数会下降，但 playback（4k+ 行）与 EPG（时区/日界）会集中成巨型 service，安全边界散落；与宪章原则二/三冲突，弃用。
- **维持现状**：三闸虽绿，但薄上下文与单实现端口持续增加每次改动的触点；量化成本已可感知，弃用。
- **大爆炸式重构**：回归不可定位、中间态不可审计；与本 ADR 的分波次、可回退原则冲突，弃用。

## Consequences

**正面**

- 新增字段/端点时触点减少（尤其 settings/profile 类 CRUD）；
- 模块与 schema 可读性提升，`playback.module` 不再需要全文检索；
- 抽象数量与真实需求对齐，端口重新变成“有意义的设计决策”。

**负面 / 风险**

- 文件合并会让单文件变长，需靠 D3 上限与代码评审约束；
- 端口清理会改动 DI 装配，可能出现运行期注入错误——由 W3 的启动冒烟与全量测试兜底；
- 迁移期间 `contexts/*/index.ts` 发布面必须保持稳定，否则会引入跨上下文回归。

## 实施状态

| 波次 | 状态 | 备注 |
|---|---|---|
| W1 | 未开始 | |
| W2 | 未开始 | |
| W3 | 未开始 | |
| W4 | 未开始 | |

## 合规声明

- 本 ADR 不改变业务行为，不新增/修改规格验收条款（原则一）；
- 本 ADR 为新增决策记录，不删除、不改写 ADR-0014/0015 的历史文本（原则五）；如与 ADR-0014 的“四层强制”表述存在粒度差异，以本 ADR 的 D1.2/D2 作为**细化解释**，分层与依赖方向仍以 ADR-0014 为准（技术约束 6）；
- 本 ADR 处于 Proposed 期间，不执行任何代码调整；接受后再按 D4 分波实施。