# 迁移前基线证据（T004）

**Feature**: 007-backend-ddd-restructure · **Task**: T004（捕获迁移前基线证据）
**生成时间**: 2026-10-28 · **环境**: macOS darwin 27.2.0 arm64 / Apple M4 Pro（12 核）/ Node v24.19.0 / pnpm 11.28.5 · **采集方式**: 仓库根依次执行下列四条命令，未修改任何源码、未运行 git。

## 目的

本文件记录 007 结构迁移开始前的**行为基线**：全部 unit + contract 测试、runtime 冒烟与迁移演练在迁移前的真实结果。用途：

1. **007-US2 行为零变化对照**——迁移完成后重跑同四条命令，结果必须与本基线一致（用例数、通过数、冒烟场景数、迁移终态）；
2. **迁移期间每步门禁参照**——每个迁移步骤完成后按需重跑对应命令，任何与本基线的偏差即视为行为变化，须停止并排查。

**总体结论：✅ 四条命令全部通过（exit 0），基线有效，可开始迁移。**

---

## 1. `pnpm --filter @hmp/server test`（全部 unit + contract）

- **结果**: ✅ 通过（exit 0）
- **执行窗口**: 2026-10-28 11:28:15 → 11:31:06 +08:00（wall clock 2m51.4s）
- **关键统计**:
  - 测试文件: **111 passed (111)**，0 失败、0 跳过
  - 用例: **1376 passed (1376)**，0 失败、0 跳过
  - Vitest Duration 170.13s（transform 1.06s / setup 210ms / collect 34.89s / tests 120.09s / prepare 2.86s）
- **备注**: 套件输出含 `PlaybackLifecycleService.onApplicationShutdown` 栈迹噪音（测试拆栈时的已知日志），不影响判定；全部文件与用例均为 passed。

## 2. `pnpm --filter @hmp/server test:unit` 与 `pnpm --filter @hmp/server test:contract`（分套统计）

### 2a. test:unit

- **结果**: ✅ 通过（exit 0）
- **关键统计**:
  - 测试文件: **60 passed (60)**
  - 用例: **918 passed (918)**，0 失败、0 跳过
  - Vitest Duration 50.59s；wall clock 51.2s

### 2b. test:contract

- **结果**: ✅ 通过（exit 0）
- **关键统计**:
  - 测试文件: **51 passed (51)**
  - 用例: **458 passed (458)**，0 失败、0 跳过
  - Vitest Duration 122.35s；wall clock 2m2.9s

- **交叉核对**: unit 60 + contract 51 = **111 文件**、918 + 458 = **1376 用例**，与第 1 条全量运行完全一致（无仅按目录归类的遗漏）。

## 3. `pnpm test:runtime`（运行时冒烟）

- **结果**: ✅ 通过（`"result":"PASS"`，exit 0）
- **执行窗口**: 2026-10-28 11:34:17 → 11:36:48 +08:00（wall clock 2m30.4s）
- **关键统计**:
  - **断言总数 465**；phase1 登录/引导场景 9 项（初始化+显式登录、bootstrap 主档案、选择解锁、settings access 解锁、家长验证策略保存/423 锁定、重启持久化、备份恢复完整性、注销幂等、编译产物 SPA/API 路由）；phase2Scenarios 8；phase3Scenarios **9**（S1 来源闭环 / S2 目录矩阵 / S3 EPG 全流程 / S4 名单闭环 / S5 性能基准 / S6 手动 EPG 绑定〔81 断言〕/ S7 播放负向矩阵〔92 断言〕/ S8 播放正向鲁棒性〔98 断言〕/ S9 记录查询〔56 断言〕）
  - S5 性能基准: 目录总量 10005；导入 0.6s；20/20 次搜索+翻页 ≤2s；p50 68.8ms / p95 71.4ms（参考线 19/20 达到）
  - 媒体夹具复核 pass 14 / fail 0（totalChecks 119）
- **备注**: 浏览器渲染层证据按脚本设计不在本冒烟范围（HTTP 层即 UI 数据源），与本基线的后续对照同样按 HTTP 层口径。

## 4. `pnpm migration:drill`（up → down → up 演练）

- **结果**: ✅ 通过（`drill 通过`，exit 0）
- **执行窗口**: 2026-10-28 11:37:00 → 11:37:02 +08:00（wall clock 1.6s）
- **步骤结果**:
  1. **预检**: 通过（generation2-ready：user_version=2，迁移记录与目录一致）
  2. **阶段 1/3 up**: 无待应用迁移（6 条迁移均已应用；步前备份 `hmp.db.bak-1793158621873`）
  3. **阶段 2/3 down**: 已回滚 `0006_pc_experience`（备份 `hmp.db.bak-1793158621908`）
  4. **阶段 3/3 up**: 已应用 `0006_pc_experience`（备份 `hmp.db.bak-1793158621952`）
  5. **终态校验**: 已应用 `[0001_init, 0002_profile_policy, 0003_media_catalog, 0004_manual_epg_binding, 0005_playback, 0006_pc_experience]`；EXPECTED_TABLES 全部 **26 张表**存在（含 `_migrations`），关键列校验通过
- **事实备注**: 本实现（`apps/server/src/database/migrate.ts`，SC-006 回滚演练）的 drill 面向**当前配置库** `apps/server/data/hmp.db` 执行 up→down→up，并非临时空库；采集时该库已处于全量应用态，故阶段 1 为 no-op，实际回滚/重放 exercised `0006_pc_experience`。对照时以「终态 = 6 条迁移全部应用 + 26 表齐全」为基准即可；若 007 期间需真正空库演练，须另行准备空库环境（属迁移任务范畴，本基线不改源码、不额外造库）。

---

## 汇总表

| 命令 | 结果 | 用例/步骤数 | 备注 |
|---|---|---|---|
| `pnpm --filter @hmp/server test` | ✅ 通过 | 111 文件 / 1376 用例全过 | Duration 170.13s；0 失败 0 跳过 |
| `pnpm --filter @hmp/server test:unit` | ✅ 通过 | 60 文件 / 918 用例全过 | Duration 50.59s |
| `pnpm --filter @hmp/server test:contract` | ✅ 通过 | 51 文件 / 458 用例全过 | Duration 122.35s；与 unit 相加 = 全量 111/1376，交叉一致 |
| `pnpm test:runtime` | ✅ 通过（PASS） | 断言 465；场景 9+8+9（S1–S9） | S5 性能 20/20 ≤2s（p95 71.4ms）；wall 2m30.4s |
| `pnpm migration:drill` | ✅ 通过 | 4 步（预检 + up/down/up） | down/up 实际回滚重放 `0006_pc_experience`；终态 6 迁移全应用、26 表齐全；面向现存 dev 库（非临时空库，见 §4 事实备注） |

## 基线效力声明

本文件所载结果为 **007 结构迁移的迁移前行为基线**：迁移期间每个步骤的门禁与最终 007-US2「行为零变化」对照，均以本基线为参照（unit 918 / contract 458 / 全量 1376、runtime PASS 465 断言与 S1–S9、drill 终态 6 迁移 + 26 表）。采集时点四条命令**全部一次通过，无任何失败**，故不适用「失败即停」条款；若后续重跑出现与本基线的任何偏差（用例数增减、失败、冒烟场景缺失、迁移终态不一致），按迁移任务定义视为行为变化处理。
