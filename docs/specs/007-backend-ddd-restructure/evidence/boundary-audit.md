# 007 边界审计归零留档（Boundary Audit Zero · T024）

> 生成时间：2026-10-28 · 任务：T024（US2 收官步，依赖 T022/T023；HEAD 基线 71fc162）
> 结论：**SC-001 达成** —— `audit:boundaries` 软（`AUDIT_ENFORCE=0`）/硬（默认强制）双模式均 **0 violations**，强制模式 exit 0；负向对照证明强制模式对真实违规仍以非零退出拦截。规则事实来源：`apps/server/.dependency-cruiser.cjs`（文件头「编排裁决修正」与「T024 审计强制归零」小节）。

## 1. 双模式归零证据（本步实测，于 apps/server 执行）

| 模式 | 命令 | 退出码 | 输出（末行，逐字） |
| --- | --- | --- | --- |
| 软（报告） | `AUDIT_ENFORCE=0 pnpm audit:boundaries` | **0** ✅ | `✔ no dependency violations found (204 modules, 1074 dependencies cruised)` |
| 硬（强制） | `pnpm audit:boundaries` | **0** ✅ | `✔ no dependency violations found (204 modules, 1074 dependencies cruised)` |

（仓库根等价形态 `pnpm --filter @hmp/server audit:boundaries`，默认即强制模式。）

**负向对照（强制模式确实「会咬人」）**：为排除「配置失效导致恒 0」的可能，向
`src/contexts/epg/domain/` 投放临时探针文件（import `@nestjs/common`，不入库）后重跑
强制模式：`x 2 dependency violations (2 errors, 0 warnings)`，**exit 2**（R1a + R3
双双以 error 命中）；删除探针后恢复 0 violations / exit 0。

## 2. 违规数趋势（40 → 0）

完整链（软审计 infos，每值 = 该步末 `AUDIT_ENFORCE=0` 实测）：

```
40 → 40 → 77 → 95 → 136 → 159 → 214 → 259 → 381 → 572 → 745 → 602 → 431 → 5 → 0
└────────── T008–T019（US1 迁移 12 步，见 evidence/us1-summary.md）┘ └─ T020–T022a ─┘ └ T022b/T023 ┘ T024
```

| 区段 | 任务 | 数值 | 说明 |
| --- | --- | --- | --- |
| US1 | T008–T019 | 40 → … → 745 → 602 | 逐文件迁移期新增的旧树/矩阵边，计划内暂存；T019 终态 602（us1-summary.md §2/§4） |
| US2 前段 | T020–T022a | 602 → 431 | 发布面（index.ts + tokens）建立，跨上下文消费改经发布面（T022a：R2 119→0） |
| US2 治理 | T022b/T023 | 431 → 5 | R4 端口反转真修 2 条 + 裁决 1 合法化 62 条发布面边 + application 合法面（修正②③④）+ 领域错误纯化（修正⑤）；残留 5 条系裁决明确不放松项 |
| **本步** | **T024** | **5 → 0** | 4 条按 ADR-0014 修正案 D-①②③ 合法化（§4），1 条类型上提真修（§3） |

## 3. T024 收口明细：5 条残留逐条裁决

| # | 残留边（T023 末软审计） | 规则 | 裁决 | 处置 |
| --- | --- | --- | --- | --- |
| 1 | `sources/domain/source-target.validation.ts → net` | R1a | D-① 内建标准库 | 白名单放行 |
| 2 | `live-tv/domain/live-grouping.ts → crypto` | R1a | D-① 内建标准库 | 白名单放行 |
| 3 | `policy/domain/policy.rules.ts → src/platform/http-common/domain-error.ts` | R1a | D-② 错误契约 | 白名单放行 |
| 4 | `epg/domain/guide-calendar.ts → @internationalized/date`（.pnpm hoist 落点） | R1a | D-③ 纯值库 | 白名单放行 |
| 5 | `identity-access/application/bootstrap.service.ts → interface/account-session.dto.ts` | R1b | 真修（规则不放松） | 类型上提，见 §3.1 |

### 3.1 任务一：类型上提（唯一真修项，运行时零变化）

- **上提内容**：`ProfileSummaryBody`（契约 B001ProfileDto 类型）与 `toProfileSummary`
  （纯投影函数）自 `interface/account-session.dto.ts` **逐字搬迁**至新文件
  `application/profile-summary.dto.ts`；
- **消费方改动**：
  - `application/bootstrap.service.ts`：import 改指本层 `profile-summary.dto`
    （application→own application 为 R1b 合法面）；
  - `interface/account-session.dto.ts`：改为从 `profile-summary.dto` 导入并**再导出**
    `toProfileSummary` / `ProfileSummaryBody` —— 既有消费方零改动
    （同上下文 auth.controller / bootstrap.controller 照旧直引；跨上下文
    settings/profile 两上下文经发布面 `@contexts/identity-access` 的再导出链路照旧）；
- **零运行时变化**：纯类型 + 纯函数逐字搬迁与再导出，无任何逻辑/签名/HTTP 行为改动
  （门禁 §6 全绿背书，1376/1376 与基线一致）；
- **偏差留痕**：任务原文为「类型上提至 `identity-access.ports.ts`、application 与
  interface 两侧均改从 ports 导入」。实测该落点不可行，理由：(a) bootstrap.service
  同时消费**运行时函数** `toProfileSummary`，非纯类型搬迁即可消除该边；
  (b) `identity-access.ports.ts` 为「仅提取类型」的发布面文件（文件头契约注释），
  不落运行时函数；(c) application→`*.ports.ts` 边不在 R1b pathNot 合法面
  （depcruise 对 type-only 边亦计边），落 ports 将产生**新**违规，与「任务二规则
  改动仅限 R1a」的范围约束冲突。故按既有 `DeviceDtoBody` 落位
  `application/device.service.ts` 的同层先例落位 application 层，并保持 R1b 规则
  零改动。

## 4. 修正案放行项清单（本步新增三项，对应 ADR-0014 修正案 D 条目）

| 条目 | 规则 | 白名单项（.dependency-cruiser.cjs 常量） | 放行的既有边 | 裁决理由 |
| --- | --- | --- | --- | --- |
| **D-① 内建标准库** | R1a | `DOMAIN_BUILTINS` = `^(?:net\|crypto\|path\|fs\|fs/promises\|url\|util\|events\|stream\|buffer\|timers)$` | sources→net、live-tv→crypto | depcruise 剥离 `node:` 前缀后的裸名落点形态（T022b 实测）；仅此确定性集合、全名精确匹配，不复用全量 BUILTIN_MODULES、不开放通配 |
| **D-② 错误契约** | R1a | `^src/platform/http-common/domain-error\.ts$` | policy→domain-error | DomainError/createDomainError 为宪章定义的跨上下文错误契约（plain TS class，无框架依赖），豁免逻辑与 `@hmp/shared` 类型契约同理 |
| **D-③ 纯值库** | R1a | `PURE_VALUE_PACKAGES` = `^(?:\.\./)*(?:node_modules/@internationalized/date\|node_modules/\.pnpm/[^/]+/node_modules/@internationalized/date)(?:/|$)` | epg→@internationalized/date | 无 I/O 副作用的纯日期值运算库；pnpm 两分支平铺写法同 SHARED_PACKAGE/FRAMEWORK_PACKAGES（safe-regex 禁嵌套量词），实测落点为仓库根 hoist |

（历史放行项：裁决修正①–⑥ 见规则文件头与 T022b/T023 提交记录；本步未放松其中任何一项。）

## 5. 最终规则集构成（T024 后的 .dependency-cruiser.cjs）

7 条规则 + severity 门禁开关（默认 `error` 强制；`AUDIT_ENFORCE=0` 降级 `info` 报告）。各规则合法面（`to.pathNot` / `to.path` 构成）：

| 规则 | 合法面构成 |
| --- | --- |
| R1a `r1-domain-only-own-domain-and-shared` | own `domain/**` ＋ `SHARED_PACKAGE` ＋ 发布面 `index.ts`（修正①）＋ **`DOMAIN_BUILTINS`（D-①，本步）** ＋ **domain-error 契约（D-②，本步）** ＋ **`PURE_VALUE_PACKAGES`（D-③，本步）** |
| R1b `r1-application-only-own-domain-application-and-shared` | own `domain/**` ＋ own `application/**` ＋ own `infrastructure/**`（修正②(d)）＋ `SHARED_PACKAGE` ＋ 发布面 `index.ts`（修正②(a)）＋ `^src/platform/`（修正②(b)）＋ `BUILTIN_MODULES` ＋ `FRAMEWORK_PACKAGES`（修正②(c)） |
| R1c `r1-infrastructure-own-layers-platform-and-shared-only` | own 三层 ＋ `^src/platform/` ＋ `SHARED_PACKAGE` ＋ 发布面 `index.ts`（修正③）＋ `NODE_MODULES_PACKAGES` ＋ `BUILTIN_MODULES`（修正③偏差留痕） |
| R1d `r1-interface-own-context-published-index-platform-shared-only` | own 上下文全部 ＋ 发布面 `index.ts` ＋ `^src/platform/` ＋ `SHARED_PACKAGE` ＋ `NODE_MODULES_PACKAGES` ＋ `BUILTIN_MODULES`（修正④偏差留痕） |
| R2 `r2-cross-context-deep-import-ban` | 跨上下文落点仅 `index.ts`（2026-10-28 裁决不放松） |
| R3 `r3-no-framework-leakage-into-domain` | from 收窄 domain 层 only（修正⑤）；禁 `FRAMEWORK_PACKAGES`（@nestjs/、drizzle-orm、better-sqlite3、express、rxjs、@types/express） |
| R4 `r4-platform-must-not-depend-on-contexts` | platform→contexts 全禁保持（修正⑥；既有 2 条边已经端口反转真修消失） |

规则名表同步：`evidence/tooling.md` §2 已于本步更新（R3 更名 + R1 系修正案放行项）。

## 6. T024 步末全部门禁

| # | 门禁（仓库根执行） | 结果 |
| --- | --- | --- |
| 1 | `AUDIT_ENFORCE=0 pnpm --filter @hmp/server audit:boundaries` | ✅ 0 violations，exit 0 |
| 2 | `pnpm --filter @hmp/server audit:boundaries`（默认强制） | ✅ 0 violations，**exit 0（SC-001）** |
| 3 | `pnpm --filter @hmp/server typecheck` | ✅ exit 0 |
| 4 | `pnpm lint` | ✅ exit 0 |
| 5 | `pnpm --filter @hmp/server test` | ✅ **1376/1376**（111 files），exit 0 |
| 6 | `pnpm --filter @hmp/server audit:orphans`（knip） | ✅ exit 0，无孤儿告警 |
| 7 | `pnpm --filter @hmp/server build` | ✅ exit 0 |

**结论**：软/硬审计双模式 0 违规（趋势终值 0），强制模式对投放的违规探针以 exit 2
拦截（负向对照），SC-001 达成；七项门禁全绿，运行时行为零变化。
