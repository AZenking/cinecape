# T033 全量终验证据（quickstart「全量终验」逐项执行）

**Feature**: 007-backend-ddd-restructure | **Date**: 2026-10-28 | **Task**: T033 [US4]
**基线 HEAD**: `320dbfd`（T031 zero-leftover，工作区干净）| **分支**: master
**环境**: Node v24.19.0 / pnpm 11.28.5 / macOS darwin 27.2.0 arm64 (Apple M4 Pro)
**方法**: 只读验证 + 本证据文档；未修改任何源码。执行全程「失败即停」条款未被触发（十项一次通过）。

## 一、十项结果总表

| # | 命令 / 检查项 | 期望 | 实测 | 结论 |
|---|---|---|---|---|
| 1 | `pnpm install && pnpm gen:types` → `git status --porcelain packages/shared` | 产物零差异（空输出） | 两命令 exit 0；porcelain **空**；lockfile md5 前后一致（`24d24ef7…`，未改动） | ✅ |
| 2 | `pnpm typecheck && pnpm lint && pnpm build` | 全绿 | typecheck 3 工程（shared/server/web）exit 0；`eslint .` exit 0；build 3 工程 exit 0（web chunk>500kB 为非阻断 vite 提示） | ✅ |
| 3 | `pnpm --filter @hmp/server test` | 1376/1376（111 文件） | **Test Files 111 passed (111)；Tests 1376 passed (1376)**，158.08s，exit 0；flake `conversion-delivery.spec` 未触发（无需同树重跑） | ✅ |
| 4 | `pnpm test:runtime` | PASS（465 断言） | `result=PASS`，**assertionCount=465**，phase2 场景 8 + phase3 S1–S9 全过，exit 0 | ✅ |
| 5 | `pnpm migration:drill` | up→down→up 通过，终态 6 迁移 26 表 | exit 0；up（无待应用）→ down（回滚 `0006_pc_experience`）→ up（重放 `0006_pc_experience`）；终态 **6 条迁移全应用 + 26 业务表 + `_migrations` 簿记表全部存在**；迁移目录零修改 | ✅ |
| 6 | `pnpm --filter @hmp/server audit:boundaries`（默认强制模式） | 0 violations, exit 0 | `✔ no dependency violations found (204 modules, 1069 dependencies cruised)`，exit 0 | ✅ |
| 7 | `pnpm --filter @hmp/server audit:orphans` | exit 0 无 hint | `knip` 零输出，exit 0 | ✅ |
| 8 | `grep -rn "@contexts\|@platform" apps/server/dist` | 空 | **0 命中**（grep exit 1 = no match；dist 为本次步骤 2 新鲜构建，tsc-alias 重写完整） | ✅ |
| 9 | 人工半自动终验清单 | 见 §三 | 零遗留=1（历史溯源注记，无回潮）；合规 40/40 有结论、待填=0；文档同步状态如实记录（见偏差备注） | ✅ |
| 10 | 本证据文档 | 逐项留档 | 即本文件 | ✅ |

## 二、关键输出摘录

### 1. 契约类型产物（步骤 1）

- `pnpm install` exit 0；lockfile 供给链校验通过（`Lockfile is up to date, resolution step is skipped`）；md5 `24d24ef75bd984f59add2c431dfffd67` 执行前后一致，**无 lockfile 改动**。
- `pnpm gen:types` 重生成 5 个 schema 产物（001 scaffold / 002 policy / 003 catalog / 004 playback / 005 experience），exit 0。
- `git status --porcelain packages/shared` 为空——与迁移前（T004 基线，该产物未变）**零差异**成立。

### 3. 单测全量（步骤 3）

```
Test Files  111 passed (111)
     Tests  1376 passed (1376)
   Duration  158.08s
```

对照基线（evidence/baseline.md §总结）：unit 918 + contract 458 = 1376，111 文件——**完全一致，零增减**。

### 4. 运行时冒烟（步骤 4）

- `{"result":"PASS","phase2Scenarios":8,"phase3Scenarios":["S1-source-loop",…,"S9-us2b-playback-records"],"assertionCount":465,…}`
- S5 性能基准：总量 10005；导入 0.6s；20 次搜索+翻页 ≤2s 达 20/20；p50 64.1ms / p95 67.1ms。
- S6/S7/S8/S9 断言分解：81 + 92 + 98 + 56（与 T047 期口径一致）。

### 5. 迁移演练（步骤 5）

```
[migrate] 预检通过(generation2-ready):数据代际 2 就绪(user_version=2,迁移记录与目录一致)
drill 阶段 1/3: up      → 无待应用迁移
drill 阶段 2/3: down    → 已回滚 0006_pc_experience
drill 阶段 3/3: up      → 已应用 0006_pc_experience
drill 通过:已应用 [0001_init, 0002_profile_policy, 0003_media_catalog,
             0004_manual_epg_binding, 0005_playback, 0006_pc_experience],
             表 [household, …, profile_viewing_history, _migrations] 全部存在
```

- 终态：**6 条迁移全部应用；26 张业务表 + `_migrations` 共 27 表全部存在**（quickstart「26 表」按业务表口径）。
- **口径声明（与 baseline.md §4 事实备注同口径）**：drill 面向现存配置库 `apps/server/data/hmp.db` 执行，非字面临时空库；采集时库已处全量应用态，故阶段 1 为 no-op，实际回滚/重放 exercised `0006_pc_experience`。与 T004 基线行为完全一致；「真正空库演练」属迁移任务范畴，不在本验证改动范围。
- drill 产生的 `hmp.db.bak-*` 备份均被 gitignore，工作区保持干净；迁移目录内容零修改。

### 6–8. 审计与产物红线（步骤 6/7/8）

- boundaries：`depcruise src --config .dependency-cruiser.cjs` → 0 violations（204 modules / 1069 dependencies），默认强制模式 exit 0。
- orphans：`knip` exit 0 零输出（孤儿文件/死导出/死依赖 = 0，无 hint）。
- dist 别名残留：`@contexts` / `@platform` 0 命中。

## 三、人工半自动终验清单（步骤 9）

### 9.1 零遗留复核

命令：`grep -rn "modules/\|src/database\|src/common\|src/config" apps/server/src --include=*.ts`

命中 **1 处**（期望唯一残留，无回潮）：

```
apps/server/src/platform/http-common/http-common.module.ts:6: * http-common 基础设施模块(007-T018:原 src/common/common.module.ts 的 CommonModule
```

该命中为 JSDoc 注释内的**历史溯源注记**（T031 已处置的既定保留项），非活引用、非被注释旧实现、非迁移占位标记、非临时绕行垫片。除此之外全库 0 残留。

### 9.2 规则合规清单

`nestjs-best-practices-compliance.md`：

- 规则行计数：**40/40**（`^\| [a-z]+-[a-z0-9-]+ \|` 精确匹配 40 行）；
- 处置分布：**27 ✅ 合规 / 8 🔄 适配执行 / 5 ⏸ 已记录偏离**（与 T030 提交口径 `27 pass / 8 adapted / 5 recorded deviations` 一致）；
- 40 行**全部附证据位置**（均引用 `compliance-cat-1-5.md` / `compliance-cat-6-10.md` 具体小节）；
- `grep -c "待填"` = **0**（`待定`/`TBD` 亦为 0）。

### 9.3 文档同步状态（如实记录）

- `spec.md` **Status: Accepted**（2026-10-28，结构方案与规则偏离清单见 ADR-0014）——**尚未流转 Verified**。按 tasks.md 证据纪律「Spec 状态仅在对应证据齐备后流转——不得在 T033 前声称 Verified」，本验证不代行状态流转；Implementing → Verified 的推进属 T032（文档原子同步）/T034（验收报告）编排方决策。
- `tasks.md` 勾选计数：**[X] = 26，[ ] = 7**。未勾项：T026–T029（其产出 `compliance-cat-*.md` 与 T030 终稿已在，勾选未打）、T032（文档原子同步）、T033（本次勾选）、T034（验收报告）。本次仅勾 **T033**，其余不动。

## 四、终验结论

**✅ 通过（ALL GATES GREEN）**——quickstart「全量终验」十项全部一次通过，无失败、无 flake 触发、无 lockfile/产物漂移：

1. 契约类型产物与迁移前零差异（行为零变化的结构面证据）；
2. 单测 1376/1376、运行时 465 断言与 T004 基线数字完全一致（行为零变化的动态面证据）；
3. drill 终态 6 迁移 + 26 表与基线同口径一致（迁移可逆性证据）；
4. 双审计归零 + dist 别名 0 残留 + 旧路径残留仅 1 处既定历史注记（零遗留红线证据）。

**偏差备注（不阻断，如实上报编排方）**：① spec Status 为 Accepted 未流转 Verified、tasks.md 尚有 T026–T029/T032/T034 未勾——均属编排方 T032/T034 决策范围，本任务按授权仅勾 T033；② drill 口径为现存配置库非字面空库（与基线 §4 声明一致，非本次偏差）。

## 附：执行环境与可复现性

| 项 | 值 |
|---|---|
| HEAD | `320dbfd`（refactor(server): 007-T031 zero-leftover…） |
| Node / pnpm | v24.19.0 / 11.28.5 |
| lockfile md5（install 前后） | `24d24ef75bd984f59add2c431dfffd67`（一致） |
| store 备注 | 项目卷不可硬链用户级 store，自动切换 `/Volumes/Extends/DevCache/.pnpm-store/v11`（无影响） |
| 全程工作区 | 除本文件与 tasks.md T033 勾选外零改动（每步后 `git status --porcelain` 核对） |
