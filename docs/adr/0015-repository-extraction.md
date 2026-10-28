# ADR-0015：应用层数据访问仓储化抽取（ADR-0014 登记 5 补救）

- 状态：Accepted（2026-10-28 维护者指令显式接受：针对 ADR-0014 登记 5 已记录偏离，指令执行「真正仓储化」补救并立项规格 008）
- 依据：宪章 v1.4.0 原则一/五、技术约束 6/7；ADR-0014 登记 5 补救路径；维护者 2026-10-28 会话指令。
- 关联：[规格 008](../specs/008-repository-extraction/spec.md)、[ADR-0014](0014-backend-ddd-structure.md)、ADR-0004（技术栈）、007 合规清单 arch-use-repository-pattern 条目。

## Context

ADR-0014 治理裁决将 application 层直接数据访问登记为偏离（登记 5：35 文件 / 126 处 `getDb()` / 68 条导入边），并指定补救路径为后续规格立项的仓储化抽取。本 ADR 决策补救的具体模式与审计收紧方案。代码现状关键事实（2026-10-28 实测）：

1. **服务为纯函数模块**（非 @Injectable 类为主）：函数束经 `useValue ... satisfies IPort` 装配于上下文模块；两种数据访问形态并存——函数体内联 `getDb()`（主流）与 `db: Db` 参数传递（如 `loadBatchCatalogContext(db, …)`，跨上下文消费）；
2. **事务脚本式混排**：事务块内联业务校验（如策略版本 CAS），drizzle 谓词/表对象/`sql` 模板与用例逻辑交织；
3. **测试 rig 直连**：单元测试自建内存库 drizzle 句柄直接传入（参数形态）或依赖 `Database` 单例 + `getDb()` 惰性解析（内联形态）；e2e/helpers 经真实 AppModule；
4. **dependency-cruiser 不为 `import type` 产生边**（实测验证）：schema 行类型可以类型导入保留，无需手写重复行类型；
5. **跨上下文 db 参数传递调用点全部为事务外纯读**（逐点核实：history/favorites/live-projection/catalog 对 `loadAvailableMediaIdSet`/`loadBatchCatalogContext` 的调用均不在 `.transaction` 块内）；
6. **模块级审计的盲区**：`getDb` 经 identity-access 发布面（index.ts）导出，application 引入它产生的边是合法的「发布面导入」，depcruise 无法按符号识别。

## Decision

**D1 模式：application 仓储端口 + seam 槽 + infrastructure Drizzle 实现 + 模块装配绑定**

- 端口接口定义于 `application/<ctx>-store.port.ts`（纯 TS；行类型经 `import type` 取自 `@platform/database/schema`）；事务以 `withTransaction<T>(fn: (tx: <Ctx>TxStore) => T): T` 端口形态表达，事务句柄不越出 infrastructure；
- seam：同文件导出 `bind<Ctx>Store(impl)` / 内部 `store()` 访问器；未绑定即调用抛显式错误（含端口名）；重复绑定幂等覆盖（测试 rig 重建需要）；
- 实现：`infrastructure/<ctx>-store.drizzle.ts` 的 `Drizzle<Ctx>Store`，查询代码自 application **逐字迁移**；每方法经 `getDb()` 惰性解析（保留 `Database` 单例 close/重开语义，与现状一致）；`withTransaction` 经 `getDb().transaction((tx) => fn(txStore(tx)))` 透传；
- 装配：`<ctx>.module.ts`（上下文根文件，不在 R1 层规则路径域内）以 `useFactory` 执行绑定；e2e/运行时经 AppModule 实例化自然完成；单元测试在 rig 中显式绑定或经测试工厂构造。

**D2 跨上下文 db 参数收敛**：已发布的 db 参数函数（`loadAvailableMediaIdSet(db, h)` 等）签名收敛为 seam 支撑的无 db 形态，消费方同提交机械适配（删 db 实参）。合法性依据事实 5（事务外纯读，无可见性耦合）；`getDb()` 返回同一缓存包装句柄，连接语义不变。

**D3 审计收紧双轨**：

- **depcruise（模块级）**：R1b（application 行）pathNot 恢复对 `@platform/database`、drizzle-orm、better-sqlite3 落点的禁止（ADR-0014 修正 3 的对应项收回；`@platform/http-common`（错误契约）与 node 内建、他上下文发布面维持合法）；
- **符号级 purity 门禁（新增 `audit:purity`）**：脚本扫描 `src/contexts/*/{application,domain}/**`，禁止值形态引用 `drizzle-orm`、`better-sqlite3`、`@platform/database`、`getDb`、`Database`（`import type` 放行）；弥补事实 6 的发布面盲区；接入 `verify:release` 前置链。

**D4 发布面不变**：identity-access `index.ts` 保留 `getDb`/`Db` 导出（interface 层既有合法消费与测试需要）；实现类不上面；防 application 走私由 D3 双轨承担。

**D5 迁移序列**：policy 试点（验证模式与门禁）→ personal-data → profile → epg → live-tv → sources → media-catalog → identity-access → settings → playback（最大者殿后）→ 审计收紧与证据收口。每上下文独立提交，步末门禁全绿，行为零变化纪律与 007 相同。

## Alternatives and consequences

- **参数全线穿引（把 Db/仓储改为全链路显式参数）**：126 处调用点 × 控制器/跨上下文/测试全量改签名，diff 不可控且违背最小变更；弃用。
- **纯 TS 镜像查询构建器端口**（application 持有 `.select().from()…` 结构子集接口）：等于重实现 drizzle 类型面，且查询构造仍滞留 application，未满足「数据访问属基础设施」的宪法约束 6；弃用。
- **整体搬迁服务文件至 infrastructure**：用例编排（事务边界、错误语义）属 application 职责（宪法约束 6 明文），搬迁即换一种违宪；弃用。
- **维持 ADR-0014 登记 5 偏离不动**：治理债留存，审计规则与目标架构长期不一致；维护者已否决。
- **后果**：seam 为模块级可变槽，属受控服务定位器——以「装配期绑定 + 显式未绑定错误 + purity 门禁禁止绕过」约束其风险；换取 126 处调用点零签名震荡与行为零变化。测试 rig 需增加绑定步骤（测试不受层规则约束，属可接受机械适配）。

## 实施修正留痕（2026-10-29，随 T004/T014 落地）

1. **句柄归属上提（D1 修正）**：drizzle 句柄实现自 identity-access/infrastructure/db.ts 原样上提 `@platform/database/drizzle`（平台横切本位）。动因：仓储实现经发布面取 getDb 会令测试 setup 预加载 identity-access 面依赖图，破坏 `vi.mock` 竞态门闩（settings 两份密码/PIN spec 实测回归后定位）；infrastructure→platform 为 R1c 合法边且不经任何发布面。原 db.ts 兼容再导出随 T011 应用层消费清零收口删除（face 的 getDb/Db 改自 platform 再导出，发布面白名单不变）。
2. **D3 事实修正——type-only 边**：本项目 depcruise `tsPreCompilationDeps: true` 令 `import type` 同样产生依赖边（T004「无边」探针结论实为「有边但当时合法」）。收紧设计据此定为双轨：R1b 对 `@platform/database/(schema|drizzle)` 仅保留两文件**类型锚点**（行类型单一事实源），值/类型之别由 `audit:purity` 符号级裁决；drizzle-orm/better-sqlite3 的 node_modules 落点与 platform/database 其余文件全禁。负向探针四项（drizzle 值导入双拦 / 发布面 getDb 走私 purity 独拦 / Database 类值导入双拦 / schema type-only 双放行）验证分工有效。
3. **purity 脚本盲区修复（T014 前置）**：逐行匹配改语句级跨行扫描（多行 import 曾隐藏 3 处真实违规，已随 T012/T013 清除；负向探针复验）。
