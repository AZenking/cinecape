# 007 审计工具就绪验证（Tooling Readiness · T006）

> 生成时间：2026-10-28 · 任务：T006（依赖 T002/T003 装配的 dependency-cruiser 18.7.0 + knip 6.43.0）
> 目的：作为 **US1 各迁移步门禁的前置验证** —— 确认 `audit:boundaries` / `audit:orphans` 两条审计命令在当前（迁移前）结构下能正确空转通过，随后 T008 起的每个迁移步都以这两条命令作为回归门禁。
> 本文档仅记录验证结果，未修改任何源码与配置（`git status --porcelain -- apps/server/src` 为空可证）。

## 1. 命令执行结果

| # | 命令（于仓库根执行） | 退出码 | 输出摘要 |
| --- | --- | --- | --- |
| 1 | `pnpm --filter @hmp/server audit:boundaries` | **0** ✅ | `✔ no dependency violations found (175 modules, 1000 dependencies cruised)`（实际执行 `depcruise src --config .dependency-cruiser.cjs`） |
| 2 | `pnpm --filter @hmp/server audit:orphans` | **0** ✅ | knip 正常完成，无孤儿/未用依赖告警。附带 1 条非阻断 Configuration hint：`src/main.ts — knip.json: Remove redundant entry pattern`（knip 6.x 认为 `src/main.ts` 入口声明冗余，仅提示，不影响门禁；T006 不改配置，留待后续任务顺手处理） |

两条命令均符合期望（boundaries 输出 "no dependency violations"，orphans exit 0）。

## 2. 规则清单（apps/server/.dependency-cruiser.cjs）

配置含 **7 条规则**；severity 由 `AUDIT_ENFORCE` 门禁开关统一切换（默认 enforce = `error` 违规即非零退出；`AUDIT_ENFORCE=0` 全部降级 `info` 报告模式，007 编排修正 2026-10-28 引入，T024 起强制归零）；路径域刻意限定 `src/contexts/**` 与 `src/platform/**`（迁移前两目录不存在 → 全部规则空转通过）。

> **2026-10-28 T024 同步**：下表「规则名 / 语义」两列已按 `.dependency-cruiser.cjs` 当前实现更新（T006 原表为迁移前快照）。变动：R3 更名 `r3-no-framework-leakage-into-domain-and-application` → `r3-no-framework-leakage-into-domain` 并收窄 from 为 domain 层 only（裁决修正⑤）；R1a–R1d 语义列补入 2026-10-28 编排裁决修正（ADR-0014 修正案①–⑥）与 T024 归零修正案（D-①②③）的放行项。逐条裁决对应关系见规则文件头「编排裁决修正」与「T024 审计强制归零」小节。

| 编号 | 规则名 | 语义（一句话） | 对应 data-model.md §3 条目 |
| --- | --- | --- | --- |
| R1a | `r1-domain-only-own-domain-and-shared` | domain 只能 import 自身上下文 `domain/**`、`@hmp/shared`（仅类型契约）与他上下文发布面 `index.ts`（裁决修正①）；T024 归零按 ADR-0014 修正案 D-①②③ 追加三项确定性放行（node 内建标准库集合 / `platform/http-common/domain-error.ts` 错误契约 / `@internationalized/date` 纯值库），其余一律违规 | §3 依赖矩阵「domain」行 |
| R1b | `r1-application-only-own-domain-application-and-shared` | application 只能 import 自身 `domain/**`、`application/**`、`infrastructure/**`（修正②(d)）、发布面 `index.ts`（修正②(a)）、`src/platform/**`（修正②(b)）、`@hmp/shared`，以及 node 内建与框架包 node_modules 形态（修正②(c)：drizzle-orm/better-sqlite3/rxjs/@nestjs/express 含 @types/express） | §3 依赖矩阵「application」行 |
| R1c | `r1-infrastructure-own-layers-platform-and-shared-only` | infrastructure 只能 import 自身三层（domain/application/infrastructure）、发布面 `index.ts`（修正③）、`src/platform/**`、`@hmp/shared`，以及外部包与 node 内建（修正③偏差留痕：外部包不属矩阵管辖）；不得触及其他上下文或任何 `interface/**` | §3 依赖矩阵「infrastructure」行 |
| R1d | `r1-interface-own-context-published-index-platform-shared-only` | interface 只能 import 自身上下文全部层、发布入口 `index.ts`、`src/platform/**`、`@hmp/shared`，以及外部包与 node 内建（修正④偏差留痕，理由同修正③）；不得 import 其他上下文的非 index 文件 | §3 依赖矩阵「interface」行 |
| R2 | `r2-cross-context-deep-import-ban` | 跨上下文 import 的落点必须是目标上下文 `index.ts`（发布入口），任何非 index 文件即违规 | §3 补充规则 (a)（另见 contracts/internal-context-contracts.md「审计映射」第 1 条） |
| R3 | `r3-no-framework-leakage-into-domain` | domain 必须保持纯 TS，禁止 import `@nestjs/*`、drizzle-orm、better-sqlite3、express、rxjs（含 @types/express）；2026-10-28 裁决修正⑤自 `…-and-application` 更名并收窄 from 为 domain 层 only（application 层框架使用由 R1b 合法面 (c) 覆盖） | §3 矩阵 domain 行「框架列 ❌」（另见 contracts「审计映射」第 3 条 + rxjs） |
| R4 | `r4-platform-must-not-depend-on-contexts` | `src/platform/**` 被所有上下文依赖，自身不得反向依赖任何业务上下文（裁决修正⑥保持全禁；既有 2 条反向边经组合根端口反转真修消失） | data-model.md §1 依赖方向不变量（§3 矩阵无 platform 行，属补充约束） |

配置其余要点：`doNotFollow: ^(node_modules|\.\./)`（不深入 node_modules 与仓库其他包）、`tsPreCompilationDeps: true`；`@hmp/shared` 与框架包的匹配正则已平铺 pnpm `.pnpm` 硬链接形态以规避 safe-regex 嵌套量词禁令。

## 3. knip 孤儿审计范围（apps/server/knip.json）

- **entry**：`src/main.ts`、`src/app.module.ts`（组合根 + Nest 装配根）。
- **ignore**（旧结构 + 测试，注释注明 **待 T018 platform 迁移收口、modules 树删除后移除**，届时孤儿审计对全量源码生效，对应 tasks.md US4 零遗留清点）：
  - `src/modules/**`
  - `src/common/**`
  - `src/config/**`
  - `src/database/**`
  - `test/**`
- **ignoreDependencies**：`sax`（在 `src/modules/imports/xmltv.parser.ts` 中以非字面量动态导入加载，静态分析不可见；T013 迁移落位后由本文件复核）。

ignore 范围与预期一致：旧结构 + test 暂不纳入，注释明确 T018 移除节点。

## 4. 探针残留双重检查

T002 的规则探针 fixture 应已清除，此处双重确认：

| 检查 | 命令 | 结果 |
| --- | --- | --- |
| 目录探针 | `find apps/server/src -maxdepth 2 -type d -name 'contexts' -o -maxdepth 2 -type d -name 'platform'` | **无输出 → 无残留** ✅ |
| git 工作区（只读确认） | `git status --porcelain -- apps/server/src` | **无输出 → src 干净、无未提交变更** ✅ |

**结论：无探针残留。**

## 5. 结论

✅ **审计就绪（audit tooling READY）**：两条审计命令在当前迁移前结构下均按设计空转通过（exit 0），7 条边界规则与 knip ignore 范围经抽查全部符合规格，探针零残留、工作区干净。

**US1 各迁移步可以启用本门禁，进入迁移实施。** 自 T008 起，每个迁移步完成后运行：

```bash
pnpm --filter @hmp/server audit:boundaries
pnpm --filter @hmp/server audit:orphans
```

两条命令必须保持 exit 0，任一命中即阻断该迁移步。
