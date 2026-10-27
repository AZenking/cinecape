# 迁移基线（T002 采集，2026-10-28）

对照依据：quickstart.md 场景 0；用途：SC-002/SC-006/SC-009 的前后对比。

## 原生控件计数（FR-002 / SC-001）

| 模式 | 命令 | 基线值 |
| --- | --- | --- |
| 合并扫描 | `grep -rn --include='*.tsx' --include='*.ts' -E '<(select\|dialog\|datalist\|progress\|meter)\b\|alert\(\|confirm\(\|prompt\(' apps/web/src \| wc -l` | **7** |
| 明细 | settings-epg 1、settings-policy 2、settings-sources 1、GuidePage 2（以上 6 处 `<select>`）+ settings-profiles 1（`window.alert`） | 6+1=7 |

（spec 中"7 处原生下拉与 1 处原生提示"表述与实测 6+1=7 行总数差异源于计数口径；验收目标不变：**清零**。）

## 构建产物体积（SC-009，迁移前）

| 指标 | 值 |
| --- | --- |
| `pnpm --filter @hmp/web build` | 成功（vite 7，2.04s） |
| dist 总量 | 1832 KB |
| JS 原始字节 | 1,379,432 |
| **JS gzip 字节** | **413,070** |
| 预算 | 首屏关键路径传输体积增幅 ≤ 15%（JS gzip 上限 ≈ 475,030） |

> 注：构建时新依赖（react-query/@mantine/hooks）尚未引入；后续测量须在等价命令与产物口径下对比（JS gzip 合计，含按需 chunk 首屏清单见任务期细化）。

## 测试套件基线

- 采集时点：依赖安装前；套件命令 `pnpm --filter @hmp/web test` 与 `test:e2e`（基线全绿快照随任务执行留证于本目录 evidence 记录）。

## 依赖安装记录（T003，2026-10-28）

- `@tanstack/react-query@^5.105.0`、`@mantine/hooks@^9.7.4`（dependencies）
- `@tanstack/react-query-devtools@^5.105.0`（devDependencies）
- 变更范围：仅 `apps/web/package.json` + 锁文件（宪法技术约束 4 ✓，`apps/server`、`packages/shared` 零新增）
