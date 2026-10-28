# 008 基线证据（T002/T003，2026-10-28）

## 纯度门禁基线（audit:purity，enforce 语义计数）

- 命中：**98 条**（值导入/值引用违规行），分布：

| 上下文 | 命中行数 |
|---|---|
| settings | 20 |
| playback | 17 |
| identity-access | 17 |
| profile | 9 |
| personal-data | 9 |
| epg | 8 |
| media-catalog | 6 |
| policy | 5 |
| sources | 4 |
| live-tv | 3 |

- 明细存档：[purity-baseline.txt](./purity-baseline.txt)
- 违规种类：值导入 `drizzle-orm`（运算符）、值导入 `@platform/database/schema`（表对象）、值导入 `@platform/database/database`（Database 类）、值引用 `getDb`（含经发布面 `@contexts/identity-access` 走私形态）。

## 依赖审计基线（audit:boundaries，enforce）

- `✔ no dependency violations found (204 modules, 1069 dependencies cruised)`（R1b 仍为 ADR-0014 修正 3 放宽态；T014 收紧后须复跑归零）。

## 路由基线

- 沿用 007 [routes-baseline.md](../../007-backend-ddd-restructure/evidence/routes-baseline.md)（T015 以 0 diff 比对；本规格不改路由）。

## 全量测试基线

- **1376 用例（1375 passed + 1 skipped）**；111 个测试文件中 1 个文件级失败：`test/unit/playback/input-security.spec.ts`「真实 FFmpeg 层 canary」在 $HOME 写 `/Users/charles/hmp-t036-canary` 被本会话沙箱拒绝（EPERM）——**环境性失败**：已在 pristine HEAD（de8e14e）worktree 上复现同样失败（32 passed + 1 skipped + 同一 EPERM），与代码状态无关；维护者本机（007 证据）该套件为绿。

## 技术事实核验（设计依据，ADR-0015 Context）

1. `import type` 不产生 depcruise 边：探针文件实测（policy/application 下仅类型导入 → 强制模式 0 违规）。
2. 跨上下文 db 参数调用点事务外纯读核验：history.service L166/L199、favorites.service L122/L175、live-projection.service L161、catalog.service L80/L89 —— 均不在 `.transaction` 块内。
3. `getDb()` 返回缓存包装句柄（identity-access/infrastructure/db.ts L13-21），`Database` 单例 close/重开自动重建——仓储实现按方法惰性解析即可保持该语义。
