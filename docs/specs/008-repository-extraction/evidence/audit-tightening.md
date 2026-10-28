# 008 审计收紧证据（T014，2026-10-29）

## R1b 收紧（.dependency-cruiser.cjs，ADR-0015 D3）

ADR-0014 修正 3 对 application 层的放行（drizzle-orm/better-sqlite3/@platform 全量 + 框架包全量）按登记 5 补救完成收回：

| 项 | 修正 3（迁移期） | T014 收紧后 |
|---|---|---|
| drizzle-orm / better-sqlite3（node_modules 落点） | 放行 | **禁止**（APP_ALLOWED_FRAMEWORK_PKGS 剔除） |
| @nestjs/ / express / @types/express / rxjs | 放行 | 维持放行（修正 2「框架禁令范围=领域核心」裁决不变） |
| `@platform/**` | 全量放行 | 收窄为 `http-common|config` + **仅 schema/drizzle 两文件类型锚点**（`database.ts`/`migrate.ts` 等其余落点全禁） |
| own infrastructure / 他上下文发布面 / node 内建 / @hmp/shared | 放行 | 不变 |

**类型锚点与双轨分工（关键事实修正）**：本项目 depcruise 配置 `tsPreCompilationDeps: true`——`import type` 同样产生依赖边（T004 探针「无边」结论实为「有边但当时合法」）。故 schema/drizzle 的行类型锚点以 R1b pathNot 精确放行两文件；**值/类型之别由 audit:purity 符号级门禁裁决**（`import type` 整句放行、值导入拒绝）——depcruise 模块粒度无法表达该语义，双轨各司其职。

## purity 门禁切强制（scripts/verify-release.sh ④b）

- 迁移期 `PURITY_ENFORCE=0` 报告模式（基线 98 命中）→ T014 起默认 enforce，违规 exit 1；
- 脚本 T014 前置修复：语句级跨行扫描（`s` 标志）替代逐行匹配，消除多行 import 盲区（负向探针：多行 drizzle 值导入命中 1、type-only 零误报；盲区曾隐藏 playback/settings 3 处真实违规，已随 T012/T013 清除）。

## 负向探针矩阵（四探针，2026-10-29 实测）

| 探针 | 注入物 | depcruise（收紧后 R1b） | purity（enforce） | 期望 |
|---|---|---|---|---|
| A | application 值导入 `import { eq } from 'drizzle-orm'` | **error 命中**（r1-application…→ drizzle-orm/index.cjs） | **命中 1** | 双拦截 ✓ |
| B | application 经发布面 `import { getDb } from '@contexts/identity-access'` | 0（发布面合法边，模块粒度盲区——设计已知） | **命中 1** | purity 独拦 ✓ |
| C | application 值导入 `import { Database } from '@platform/database/database'` | **error 命中**（→ platform/database/database.ts） | **命中 1** | 双拦截 ✓ |
| D | application `import type { profile } from '@platform/database/schema'`（行类型锚点） | 0（类型锚点放行） | 0（type-only 整句放行） | 双放行 ✓（单一事实源保留） |

## 收紧后全量门禁

- `audit:boundaries`（enforce）：**✔ no dependency violations（226 modules / 1084 deps）**
- `audit:purity`（enforce）：**✔ 0 violations**（基线 98 → 0，全量趋势见 tasks.md 各任务记录）
- `audit:orphans`：exit 0；typecheck：0 错误；lint：0 问题
- 全量测试：**1376/1376 全绿**（波后串行复跑；迁移前基线 1376 用例同规模，用例零增减——测试仅机械 rig 绑定适配，断言语义零改动）
