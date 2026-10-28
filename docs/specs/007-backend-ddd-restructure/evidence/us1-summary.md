# US1 完成总结（T008–T019）

**Feature**: 007-backend-ddd-restructure · **US1 全部十四步收口**（任务编号 T008、T008a、T009–T019，共 13 个条目/提交）
**生成时间**: 2026-10-28 · **终态 HEAD**: 见文末 T019 提交哈希 · **基线**: `evidence/baseline.md`（T004）
**铁律核验**: 全程零行为语义变化——每步均为按 `evidence/migration-map.md` 的文件移动 + 机械导入修正 + Nest module 重命名/合并 + 装配更新；全量测试 1376/1376 与基线一致。

---

## 1. US1 提交清单（T008–T019）

| 步骤 | 内容 | 提交哈希 | 软审计违规（infos） |
|---|---|---|---|
| T008 | ① personal-data → contexts/personal-data | `b170d42` | 40 |
| T008a | 路径别名基座（@contexts/*、@platform/*、tsc-alias） | `3879a8f` | 40（持平，未引入新违规） |
| T009 | ② profile → contexts/profile | `4148eae` | 77 |
| T010 | ③ policy → contexts/policy | `3cd98fa` | 95 |
| T011 | ④ epg → contexts/epg | `9197d93` | 136 |
| T012 | ⑤ live-tv → contexts/live-tv | `84f952a` | 159 |
| T013 | ⑥ sources（+imports 合并）→ contexts/sources | `d5fb2f9` | 214 |
| T014 | ⑦ media-catalog（catalog+public-catalog 合并） | `426e8eb` | 259 |
| T015 | ⑧ identity-access（auth+household 合并） | `92a3933` | 381 |
| T016 | ⑨ settings → contexts/settings | `0f429c4` | 572 |
| T017 | ⑩ playback → contexts/playback | `77d2187` | 745 |
| T018 | ⑪ platform（common+config+database+health 收口） | `626115b` | 602 |
| T019 | ⑫ 组合根收尾（本步，纯核验零改动） | 见 git log（本文随本提交落库） | 602（与 T018 持平） |

**软审计违规趋势**（AUDIT_ENFORCE=0，规则对 `src/contexts|platform` 全量生效）:
`40 → 40 → 77 → 95 → 136 → 159 → 214 → 259 → 381 → 572 → 745 → 602 → 602`
（各步增量均为 `migration-map.md` 预注记的旧树渗漏边与消费半径边；T018 因 common/config/database/health 收口使规则覆盖面扩大而回落；T019 零代码改动故持平。归零目标在 T024，收口在 US2 T022/T023。）

> 注：任务书表述"十四步"，tasks.md 实际任务编号为 13 个条目（T008 + T008a + T009–T019），上表如全收录，无遗漏。

## 2. modules 树消亡确认

- `ls apps/server/src/modules` → `No such file or directory`（目录不存在，无需 git rm，无残留空目录/文件）。
- `apps/server/src/` 终态仅含：`app.module.ts`、`contexts/`、`main.ts`、`platform/`。
- 组合根核验结论（T019 第 1 步，**无需改动，纯核验通过**）：
  - `main.ts`：仅装配职责（启动预检门禁 `@platform/database/precheck`、NestFactory 创建、全局前缀、shutdown hooks、SPA 静态资源挂载、监听）。无业务逻辑、无工具函数、无旧树相对导入（仅 `./app.module` 自身装配引用，属组合根语义）。
  - `app.module.ts`：纯装配——`imports` 全部来自 `@contexts/*`（10 个上下文模块）与 `@platform/*`（PlatformModule、全局拦截器/过滤器），无相对路径、无业务逻辑。

## 3. 旧树残留字样统计（仅报告，清理属 T031）

`grep -rn "src/modules|modules/auth|modules/profile|...|modules/public-catalog" apps/server/src --include=*.ts`
→ **19 处命中，全部位于注释（JSDoc/行内注释中的历史字样），零真实导入语句**。分布：epg 4、settings 4、identity-access 2、live-tv 3、platform(http-common) 2、media-catalog 1、playback 1、profile 1、sources 相关(settings 控制器注释)计 1。

## 4. 剩余待收口边分类计数（供 US2 T022 输入）

T019 终态软审计共 **602 infos（0 errors / 0 warnings）**，175 modules / 995 dependencies。按规则与边类型分类：

| 规则 | 数量 | 细分 |
|---|---|---|
| r1-application（application 仅限本域+shared） | 285 | 跨上下文 82（identity-access 51、policy 16、profile 10、media-catalog 2、playback/personal-data/live-tv 各 1）；同上下文跨层 29；platform 深导入 112（getDb/env/common 等）；node_modules 47（drizzle-orm 为主）；node 内建 15 |
| r2-cross-context-deep-import-ban | 119 | 全部跨上下文：identity-access 65、policy 17、profile 12、sources 7、personal-data 6、live-tv 5、media-catalog 3、epg 3、playback 1 |
| r1-interface（interface 仅发布面+platform+shared） | 80 | 跨上下文 23（identity-access 11、sources/epg 各 3、其余 6）；node_modules 54；node 内建 3 |
| r1-infrastructure | 61 | 跨上下文 6（sources 3、identity-access 2、personal-data 1）；node_modules 15；node 内建 40 |
| r3-no-framework-leakage（domain/application） | 47 | drizzle-orm 34、@nestjs/common 11、better-sqlite3 2 |
| r1-domain | 8 | node 内建 2（net/crypto）；node_modules 2（@nestjs/common、@internationalized/date）；platform 深导入 1（policy.domain→domain-error）；跨上下文 3（epg.domain→live-tv） |
| r4-platform-must-not-depend-on-contexts | 2 | settings-access.guard→settings.application；session.guard→identity-access.infrastructure（**反向依赖，建议 T022 优先**） |
| **合计** | **602** | |

**T022 输入要点**：最大簇为"消费半径边"（application/interface 直连 identity-access 上下文内部，126 条 r1+r2 合计指向 identity-access），其次 platform 深导入 112 条（getDb/env/common，可经 re-export 门面批量收口）、drizzle 渗漏 34 条（仓储抽取）。r4 两条反向依赖语义上应将 guard 归位回上下文或经接口倒置。

## 5. T019 七项门禁结果（全绿）

| 门禁 | 结果 |
|---|---|
| `pnpm --filter @hmp/server typecheck` | ✅ exit 0 |
| `pnpm lint` | ✅ exit 0 |
| `pnpm --filter @hmp/server test` | ✅ **1376/1376**（111 文件全绿；见下方 flake 备注） |
| `AUDIT_ENFORCE=0 pnpm --filter @hmp/server audit:boundaries` | ✅ exit 0，**602 infos**（0 errors/0 warnings，与 T018 基线持平；T024 起强制归零） |
| `pnpm --filter @hmp/server audit:orphans`（knip） | ✅ exit 0 |
| `pnpm --filter @hmp/server build` | ✅ exit 0，`grep -rn "@contexts\|@platform" dist` = **0 残留** |
| `pnpm migration:drill` | ✅ drill 通过（up→down→up，0001–0006 全部就位，备份正常） |

**Flake 备注（如实记录，非 T019 引入）**：test 首次运行出现 1 例失败（1375/1376），未复现；第 2、3 次运行均 1376/1376（exit 0，以第三次为门禁权威结果）。失败与噪声同源：`PlaybackLifecycleService.onApplicationShutdown` 在部分 schema 测试库上查询 `playback_conversion` 抛 `SqliteError: no such table`（每次全量运行记录约 18 次日志，多数场景被 Nest 吞掉仅留日志，偶发竞态升级为用例失败）。该关闭钩子查询自 `029fa5d`（2026-10-26，007 迁移前旧树时代）即存在，且 T004 `baseline.md` 已记载此"已知日志"。属既有 flake，本步零改动未触碰，建议后续独立工单处理（关闭钩子对表缺失容错）。

---

**结论**: US1 完成 ✅——全部源码落位四层（contexts × 10 / platform），modules 树消失，组合根纯装配，七项门禁全绿，行为零变化（1376/1376 与 T004 基线一致）。下一步进入 Phase 4（US2）：T020/T021 可先行，T022/T023 收口 602 条软审计边。
