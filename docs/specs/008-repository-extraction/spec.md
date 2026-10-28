# Feature Specification: 应用层数据访问仓储化抽取（ADR-0014 登记 5 补救）

**Feature Branch**: `008-repository-extraction`

**Created**: 2026-10-28

**Status**: Verified（2026-10-29：Accepted 后同夜完成实施与多层证据验收——10 上下文仓储化全量落地（purity 98→0）、双门禁收紧归零（R1b 收窄 + purity enforce，负向探针四项）、路由 0 diff、全量 1376/1376 + runtime 465 断言 PASS、零遗留清点（db.ts 兼容层收口删除、knip 归零）；证据见 [evidence/](./evidence/)：baseline / purity-baseline / audit-tightening / behavior-parity / completion。Proposed → Accepted（2026-10-28 维护者指令）→ Implementing → Verified（2026-10-29）。）

**Governance**: Follow `.specify/memory/constitution.md`（v1.4.0）。状态流转 Proposed → Accepted → Implementing → Verified。

**Related ADRs**: [ADR-0015（仓储化抽取模式与审计收紧，Accepted）](../../adr/0015-repository-extraction.md)；[ADR-0014（DDD 分层结构 + 登记 5 偏离，Accepted）](../../adr/0014-backend-ddd-structure.md)；ADR-0004（技术栈）。

**Input**: 维护者针对 ADR-0014 登记 5 的补救指令：将 application 层直接数据库交互（drizzle-orm / better-sqlite3 / @platform/database 值导入与 getDb 调用）全部抽取为仓储端口 + infrastructure 实现，行为零变化。

## 背景与问题

ADR-0014 治理裁决修正 3 允许 application 导入 drizzle-orm/better-sqlite3/@platform/**，并将 35 个 application 文件、126 处 `getDb()` 调用点的直接数据访问登记为偏离（登记 5），补救路径为本规格。现状问题：

1. application 层用例编排与 SQL 查询构造混排（事务脚本式），Drizzle 查询构建器、表对象、`getDb()` 单例直接出现在用例代码中；
2. 宪章技术约束 6 要求依赖方向向内、数据访问属于基础设施层职责；约束 7（nestjs-best-practices）要求仓储抽象（arch-use-repository-pattern，007 合规清单中因偏离登记降为「适配-未做」）；
3. 审计规则被放宽以容纳该偏离（R1b 放行 drizzle-orm 等），规则与目标架构不一致。

## 目标与非目标

**目标**：
- application 层（含 domain，已纯净，维持）不再出现 drizzle-orm / better-sqlite3 / @platform/database 的**值导入**与 `getDb`/`Database` 符号引用；行类型经 `import type`（dependency-cruiser 不产生边，已实测验证）保留 schema 单一事实源；
- 每上下文按需抽取仓储端口（application 内纯 TS 接口）+ Drizzle 实现（infrastructure），事务语义原样保留（`withTransaction` 端口形态）；
- 行为零变化：路由清单 0 diff、全量测试与运行时测试全绿、响应采样一致；
- 审计收紧并归零：R1b 恢复对 drizzle-orm / better-sqlite3 / @platform/database 的禁止 + 新增符号级纯度门禁（`audit:purity`，弥补模块级审计无法识别「从发布面拿 getDb」的盲区）。

**非目标**：
- interface 层既有 drizzle/getDb 使用（合法层）不在本规格强制范围，仅随端口签名联动做机械适配；
- 不改任何 SQL 语义、路由、契约与领域规则；不引入事件总线、不拆分上下文；
- 不做表所有权重划（仓储方法可跨表服务本上下文用例，维持 ADR-0014 DDD-lite 裁决）。

## 模式（详见 ADR-0015）

- `application/<ctx>-store.port.ts`：纯 TS 仓储端口接口 + 模块级 seam（bind/get，未绑定时显式失败）；
- `infrastructure/<ctx>-store.drizzle.ts`：`Drizzle<Ctx>Store implements <Ctx>Store`，查询代码**逐字迁移**，每方法经 `getDb()` 惰性解析（保持单例重开语义）；事务经 `withTransaction((txStore) => ...)` 端口；
- `<ctx>.module.ts`（审计自由区）装配时 `useFactory` 绑定 seam；
- 跨上下文 db 参数传递的已发布函数（如 `loadAvailableMediaIdSet(db, h)`）收敛为 seam 支撑的无 db 签名，消费方同提交机械适配（已核实全部此类调用点均在事务外，纯读，无可见性耦合）；
- 单元测试 rig 在测试侧绑定/构造 Drizzle store（测试不受层规则约束）。

## User Scenarios & Testing *(mandatory)*

### User Story 1 - application 层数据访问全部经端口 (Priority: P1) 🎯 MVP

后端维护者检索任一 `src/contexts/*/application/**` 文件时，看不到任何 ORM 查询构建、表对象或数据库句柄获取；数据访问只以仓储端口方法调用出现，端口的 Drizzle 实现位于同上下文 infrastructure 并在模块装配处绑定。

**Independent Test**: 符号级纯度门禁 + 依赖审计双规则在 enforce 模式下 0 违规。

**Acceptance Scenarios**:

1. **Given** 全部 application 文件，**When** 执行 `audit:purity`（禁符：`from 'drizzle-orm`、`from 'better-sqlite3`、`@platform/database`、`getDb`、`Database` 值引用于 application/domain），**Then** 命中数为 0。
2. **Given** 同批文件，**When** 执行 `audit:boundaries`（R1b 恢复禁止后，enforce 模式），**Then** 0 违规。
3. **Given** 任一上下文删除其模块装配中的 seam 绑定，**When** 该上下文应用服务被调用，**Then** 得到显式「仓储端口未绑定」错误而非静默空转（防呆负向）。
4. **Given** 负向探针：向任一 application 文件注入 `import { eq } from 'drizzle-orm'` 或 `import { getDb } from '@contexts/identity-access'`，**When** 执行双门禁，**Then** 至少一条门禁失败（证明门禁有效，非空转）。

### User Story 2 - 行为零变化 (Priority: P1)

迁移前后对外行为完全一致：同一请求得到同一响应（含错误码与错误体），同一测试套件全绿。

**Independent Test**: 路由清单 0 diff + 全量测试/运行时测试全绿 + 响应快照抽查。

**Acceptance Scenarios**:

1. **Given** T005 路由基线，**When** 重新生成路由清单，**Then** 0 diff。
2. **Given** 全量测试套件（基线计数留档），**When** 迁移完成运行，**Then** 全绿且用例数不减。
3. **Given** 事务语义，**When** 仓储化后执行同事务内读-校验-写路径（如策略版本 CAS），**Then** 行为与迁移前一致（同一连接、同一事务可见性）。

## 功能需求 (FR)

- **FR-001 逐上下文抽取**：按 D6 先叶后根序（policy 试点 → personal-data → profile → epg → live-tv → sources → media-catalog → identity-access → settings → playback），每上下文独立提交，步末门禁（typecheck / lint / 全量测试 / audit）全绿。
- **FR-002 查询逐字迁移**：仓储方法内的 SQL 构造与谓词逐字搬运（不改 join 链、不改分块参数、不改返回形态）；行→DTO/判定视图的映射留在 application。
- **FR-003 事务端口**：跨校验的事务块经 `withTransaction` 端口原样包裹；不存在事务句柄越出 infrastructure 的路径。
- **FR-004 seam 防呆**：未绑定即调用 → 显式错误（含上下文与端口名）；重复绑定允许（幂等，后绑覆盖，服务测试 rig 重建）。
- **FR-005 审计收紧**：R1b pathNot 恢复 `@platform/database`、drizzle-orm、better-sqlite3 落点禁止（仅对 application from-path；domain 已由 R1a 覆盖）；新增 `audit:purity` 脚本并入 `verify:release` 前置链。
- **FR-006 发布面不变**：`<ctx>/index.ts` 白名单不新增实现类；`getDb`/`Db` 保留在 identity-access 发布面（interface 层与测试仍需），其防走私由 purity 门禁承担。

## 验收标准 (SC)

- **SC-001** 双门禁归零：`audit:boundaries`（enforce）与 `audit:purity` 0 违规，负向探针证明有效，证据存 `evidence/`。
- **SC-002** 行为零变化：路由 0 diff、全量测试与 `test:runtime` 全绿、响应快照抽查一致，证据存 `evidence/behavior-parity.md`。
- **SC-003** 零遗留：无临时垫片、无被注释旧实现、无 TODO 占位（迁移标记类注释按 007 口径允许保留历史编号引用）。
- **SC-004** 文档原子同步：本规格、ADR-0015、ADR-0014（登记 5 状态更新为「已补救」）、合规清单挂接在同批提交更新。

## 宪法合规评估

- 原则一（规格驱动）：本规格 Accepted 后方动代码；证据层级含静态（双门禁）、单元/集成（全量测试）、运行时（test:runtime + 路由/快照）。
- 原则五（ADR）：ADR-0015 记录模式、替代方案与审计收紧；ADR-0014 历史**不篡改**，仅追加登记 5 补救状态注记。
- 技术约束 6/7：直接满足（依赖向内 + arch-use-repository-pattern 补课）。
- 负向验收：SC-001 探针项 + US1 场景 3/4。
