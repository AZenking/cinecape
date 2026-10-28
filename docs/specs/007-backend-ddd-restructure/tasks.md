# Tasks: 后端代码结构宪章对齐调整（007-backend-ddd-restructure）

**Input**: Design documents from `/docs/specs/007-backend-ddd-restructure/`

**Prerequisites**: plan.md（结构树与宪章检查）、spec.md（US1–US4）、research.md（D1–D7 决策与迁移序列）、data-model.md（层矩阵与迁移映射）、contracts/（冻结不变量与发布面契约）、quickstart.md（每步循环验证）

**Tests**: 依宪章原则一，本特性的"测试"= 既有 50+ 单元/契约（含安全负向）测试全程全绿 + 机械化审计（dependency-cruiser/knip）+ 多层证据留档（`evidence/`）。除审计配置外**不新增测试文件**；严禁修改既有测试断言语义（仅允许导入路径类机械修改）。

**Organization**: 按 spec.md 的 4 个用户故事分阶段；US1 内部按 research.md D6 的 12 步「先叶后根」迁移序列组织，**每步独立提交且必须通过快速门禁**：`pnpm --filter @hmp/server typecheck && pnpm lint && pnpm --filter @hmp/server test` 全绿（quickstart.md「每迁移步循环验证」）。

**路径约定**: 源码 `apps/server/src/`；测试 `apps/server/test/`；证据 `docs/specs/007-backend-ddd-restructure/evidence/`；仓库其余部分（`apps/web`、`packages/shared`、`docs/adr`）除 T001/T032 外零改动。

---

## Phase 1: Setup（开工前置与工具基座）

**Purpose**: 宪章门槛（规格 Accepted + ADR）与审计工具就绪；记录迁移前基线

- [X] T001 依照宪章原则一/五完成开工门槛：将 `docs/specs/007-backend-ddd-restructure/spec.md` 状态流转 Proposed → Accepted，撰写并推动接受结构方案 ADR `docs/adr/0014-backend-ddd-structure.md`（内容：10 上下文划分、四层规则、跨上下文协作机制、platform 归属、规则偏离清单章节——初稿按 `nestjs-best-practices-compliance.md` 中 ⏸/🔄 条目填写）
- [X] T002 [P] 安装并配置审计工具：在 `apps/server` 添加 devDependencies `dependency-cruiser` 与 `knip`；新建 `apps/server/.dependency-cruiser.cjs`（规则 = data-model.md §3 依赖矩阵 + 深导入禁令 + domain/application 框架渗漏禁令，规则路径域限定 `src/contexts/**` 与 `src/platform/**`）与 `apps/server/knip.json`（入口 `src/main.ts`，忽略测试与迁移 SQL）
- [X] T003 [P] 接入门禁脚本：在 `apps/server/package.json` 增加 `"audit:boundaries": "depcruise src --config .dependency-cruiser.cjs"` 与 `"audit:orphans": "knip"`；在根 `package.json` 的 `verify:release` 前置链路（或等价位置）追加两脚本调用
- [X] T004 [P] 捕获迁移前基线证据：运行 `pnpm --filter @hmp/server test`、`pnpm test:runtime`、`pnpm migration:drill`，将结果（含测试数量统计）记录到 `docs/specs/007-backend-ddd-restructure/evidence/baseline.md`
- [X] T005 [P] 生成控制器路由清单快照：提取 `apps/server/src/modules/**` 全部 `@Controller`/方法路由与状态码语义到 `docs/specs/007-backend-ddd-restructure/evidence/routes-baseline.md`（供 US2 零变化比对）

**Checkpoint**: 门槛已过（T001）、审计可空跑（T002/T003）、基线在案（T004/T005）

---

## Phase 2: Foundational（迁移前置，阻塞全部用户故事）

**Purpose**: 审计就绪验证 + 逐文件迁移映射表

- [X] T006 验证审计工具就绪：空跑 `pnpm --filter @hmp/server audit:boundaries` 与 `pnpm --filter @hmp/server audit:orphans`（当前结构下规则不应命中新路径域），结果记录到 `evidence/tooling.md`；如配置错误在此修复
- [X] T007 将 `data-model.md` §4 组级映射细化为逐文件映射核对表 `evidence/migration-map.md`（每行：现路径 → 目标上下文/层；「逐文件判定」项按既定标准标注判定结果——import 加密/文件系统/网络/驱动库即 infrastructure，纯函数与类型即 domain，其余编排在 application）

**Checkpoint**: 审计可判定、映射到文件级——US1 各步可开工

---

## Phase 3: User Story 1 - 后端源码全量按分层落位、依赖方向向内 (Priority: P1) 🎯 MVP（与 US2 合为可交付增量）

**Goal**: 全部后端源码迁入 `apps/server/src/contexts/`（10 上下文）与 `apps/server/src/platform/`，每上下文按 domain/application/infrastructure/interface 四层落位，依赖方向向内；每步全量测试绿（行为零变化）

**Independent Test**: 对每步迁移后的仓库运行快速门禁 + `audit:boundaries` 分层规则零违规（evidence 留档）

**说明**: 以下每步 = 按 `evidence/migration-map.md` 移动文件 + 机械修正导入路径（含 `apps/server/test/**` 的导入）+ Nest module 重命名/合并 + `app.module.ts` 装配更新；步末通过快速门禁（typecheck / lint / 全量测试 / `audit:orphans`）+ `AUDIT_ENFORCE=0 audit:boundaries` 报告（违规数记录留档；指向旧树的边由 US2 T022 收口，T024 起强制归零）后独立提交。此阶段允许暂存跨上下文深导入（US2 统一收口），但**禁止**改变任何行为语义。**自 T008a 起，T009–T019 各步新增/改动的导入一律采用 `@contexts/*` / `@platform/*` 别名形态（见 T008a 约定）。**

- [X] T008 [US1] 迁移 ① personal-data：`apps/server/src/modules/personal/**` → `apps/server/src/contexts/personal-data/{domain,application,infrastructure,interface}/`（me.controller→interface；favorites/history/progress-write/progress-clock.service→application；signed-cursor 按 T007 判定归位；模块更名 `PersonalDataModule`）
- [X] T008a [US1] 路径别名基座（**维护者 2026-10-28 指令插入**；须在 T008 完成后、T009 发车前执行）：
  1. `apps/server/tsconfig.json` 与 `tsconfig.build.json` 增加 `"baseUrl": "."` 与 `"paths": { "@contexts/*": ["src/contexts/*"], "@platform/*": ["src/platform/*"] }`；
  2. 新增 devDep `tsc-alias`（构建链唯一新增），`apps/server/package.json` build 脚本改为 `tsc -p tsconfig.build.json && tsc-alias -p tsconfig.build.json && cp -R src/database/migrations dist/database/`；
  3. vitest 配置增加 `resolve.alias`（`@contexts` → `src/contexts`、`@platform` → `src/platform`）；`apps/server/.dependency-cruiser.cjs` 开启 `options.tsConfig.fileName`（规则匹配解析后真实路径，规则正则本身不改）；核验 knip 与 eslint projectService 对 paths 的解析；
  4. 回改 T008 已落地的 `src/contexts/personal-data/**`、`personal-data.module.ts`、`app.module.ts` 装配及相关测试导入为别名形态；**旧树（src/modules|common|config|database）保留相对导入，不回改**（随迁移步自然转换）；
  5. 别名约定：`@contexts/<ctx>` 裸导入仅允许指向发布面 `index.ts`（配合 R2 深导入禁令）；上下文内部跨层用 `@contexts/<ctx>/<layer>/...`；platform 用 `@platform/...`；
  6. 治理留痕：在 `docs/adr/0014-backend-ddd-structure.md` 追加「补充决策：路径别名」小节（记录 tsc-alias 构建链变更、别名约定、以及"裸导入=发布面"与 R2 的对应关系）；
  7. 门禁同 T008（typecheck / lint / 全量测试 / `AUDIT_ENFORCE=0 audit:boundaries` 报告 / `audit:orphans`），**另须** `pnpm --filter @hmp/server build` 通过，并验证 dist 产物无残留 `@contexts`/`@platform` specifier（如 `grep -rn "@contexts\|@platform" apps/server/dist` 为空，或等效 node 加载冒烟）；
  8. 独立提交：`refactor(server): 007-T008a path alias foundation (@contexts/*, @platform/*)`
- [X] T009 [US1] 迁移 ② profile：`modules/profile/**` → `contexts/profile/`（profile.controller→interface；profile/profile-selection/pin.service、identity-transition→application，PIN 加密实现→infrastructure；`ProfileModule`）
- [X] T010 [US1] 迁移 ③ policy：`modules/policy/**` → `contexts/policy/`（policy.rules 纯规则函数→domain；policy.service/batch-context→application；`PolicyModule`）
- [X] T011 [US1] 迁移 ④ epg：`modules/epg/**` → `contexts/epg/`（binding-core/guide-calendar/programme-key.mapper/guide-problems→domain；epg/manual-epg-binding/catalog-revision/guide-window.service→application；public-guide.controller→interface；`EpgModule`）
- [ ] T012 [US1] 迁移 ⑤ live-tv：`modules/live/**` → `contexts/live-tv/`（live-grouping/live-sections/live-time/live-grouping 纯投影函数→domain；两个 *.service→application；live.controller→interface；`LiveTvModule`）
- [ ] T013 [US1] 迁移 ⑥ sources（合并 sources+imports）：`modules/sources/**` 与 `modules/imports/**` → `contexts/sources/`（m3u/xmltv.parser、catalog-diff、nas-scanner、safe-http-reader、refresh-staging→infrastructure；refresh-executor/refresh-publish/sources.service→application；source-target.validation→interface；`SourcesModule`）
- [ ] T014 [US1] 迁移 ⑦ media-catalog（合并 catalog+public-catalog）：`modules/catalog/**`、`modules/public-catalog/**` → `contexts/media-catalog/`（resource-reader→infrastructure；catalog/catalog-admin/public-catalog.service→application；public-media-projection 纯投影→domain；两个 controller→interface；`MediaCatalogModule`）
- [ ] T015 [US1] 迁移 ⑧ identity-access（合并 auth+household）：`modules/auth/**`、`modules/household/**` → `contexts/identity-access/`（auth/db.ts→infrastructure；password/token/session/device/parent-verification/setup/bootstrap.service 按映射归 application 或 infrastructure；controller/dto/validation→interface；household.controller→interface、household.service→application；`IdentityAccessModule`）
- [ ] T016 [US1] 迁移 ⑨ settings：`modules/settings/**` → `contexts/settings/`（settings-* controller→interface；access-grant/pin-verification/account/profiles/household/devices.service→application；owner-password/access-revocation 按映射归 application 或 infrastructure；`SettingsModule`）
- [ ] T017 [US1] 迁移 ⑩ playback：`modules/playback/**` → `contexts/playback/`（playback.repository/nas-reader/conversion-storage/media-probe/ffmpeg-subtitle-extract→infrastructure；playback.types→domain；playback-authorization/plan/selection/resolver/ticket/lifecycle/assets/subtitles/rate-limit/conversion-supervisor/conversion-watchdog/retention/audit.service→application（涉 ffmpeg/存储者按映射归 infrastructure）；playback/playback-stream.controller、playback-readiness.guard→interface；`PlaybackModule`）
- [ ] T018 [US1] 迁移 ⑪ platform（收口横切）：`src/common/**`→`src/platform/http-common/**`（rate-limit.service/policies 随横切件就近归位并在 ADR 记录归属；domain-error/log-redaction→http-common）；`src/config/**`→`platform/config/`；`src/database/**`→`platform/database/`（**文件内容零修改**，`package.json` 迁移脚本路径核对不变）；`modules/health/**`→`platform/health/`；`common/common.module.ts` 拆分后删除；`HealthModule` 等归入 `PlatformModule` 体系
- [ ] T019 [US1] 迁移 ⑫ 组合根收尾：`apps/server/src/main.ts` 与 `app.module.ts` 仅保留装配（导入全部走 `contexts/*` 与 `platform/*`）；确认 `apps/server/src/modules/` 目录已空并删除；全量门禁 + `audit:boundaries`（分层与框架渗漏规则对 `src/contexts|platform` 全量生效）

**Checkpoint**: US1 完成 = 全部源码落位四层 + modules 树消失；`typecheck/lint/test/audit:boundaries` 全绿

---

## Phase 4: User Story 2 - 限界上下文边界收口，行为零变化 (Priority: P1)

**Goal**: 跨上下文访问全部收敛到发布面（index.ts / module exports / @hmp/shared），深导入与框架渗漏清零；以路由快照与全量测试证明行为零变化

**Independent Test**: `audit:boundaries` 全规则 0 违规（evidence/boundary-audit.md）+ 路由清单与 T005 基线 0 diff + `test`/`test:runtime` 全绿

- [ ] T020 [US2] 建立发布面：为 `apps/server/src/contexts/` 下 10 个上下文各创建 `index.ts` 与 `<context>.tokens.ts`（导出白名单 = contracts/internal-context-contracts.md：应用服务接口 + 注入令牌 + 跨上下文类型；禁止导出实现类/repository/DTO/controller）
- [ ] T021 [US2] Nest module exports 对齐：各上下文 `<context>.module.ts` 仅 `exports` 发布的应用服务提供者（令牌绑定经 `useClass`/`useFactory` 指向 infrastructure 实现）；`app.module.ts` 相应更新；端口绑定不落在 domain/application 文件中
- [ ] T022 [US2] 深导入改造：按 `audit:boundaries` 报告将全部跨上下文深导入改为经发布接口或 `@hmp/shared` 契约；确需反转的环按 research.md D3 处理并在 ADR 补记
- [ ] T023 [US2] 框架渗漏清零：将 `@nestjs/*`、`drizzle-orm`、`better-sqlite3`、`express` 导入移出全部 `contexts/*/domain` 与 `contexts/*/application` 文件（端口移至 infrastructure，令牌绑定移至装配处）
- [ ] T024 [US2] 边界审计归零留档：`audit:boundaries` 全规则 0 违规，输出存 `evidence/boundary-audit.md`
- [ ] T025 [US2] 行为零变化证据：重新生成路由清单与 `evidence/routes-baseline.md` 比对（0 diff）；运行全量 `test` 与 `test:runtime`；对全部控制器路由做迁移前后响应快照抽查（抽样口径：每控制器 ≥1 路由，含公开浏览、播放拒绝、设置访问负向各 1）；结果存 `evidence/behavior-parity.md`

**Checkpoint**: US2 完成 = 边界机械化收口且行为证据在案；US1+US2 构成本特性 MVP

---

## Phase 5: User Story 3 - 后端实现规则全量合规，偏离必须留痕 (Priority: P2)

**Goal**: `nestjs-best-practices-compliance.md` 40 条规则逐条核验并填写证据位置；偏离条目在 ADR「规则偏离清单」终版登记

**Independent Test**: 清单 40/40 有结论、证据列全非空、⏸ 条目均附 ADR 链接（SC-005）

- [ ] T026 [P] [US3] 核验类别 1–2（arch-×6、di-×6 共 12 条）：对照 `apps/server/src/contexts/**` 实际结构逐条判定，填写 `nestjs-best-practices-compliance.md` 对应「证据位置」列（引用具体文件/审计输出）
- [ ] T027 [P] [US3] 核验类别 3–5（error-×3、security-×5、perf-×4 共 12 条）：含 🔄 适配项（argon2+会话对照 security-auth-jwt、zod strict-input 对照 security-validate-all-input）的意图达成核验；⏸ 条目（缓存/懒加载）核对 ADR 登记在案
- [ ] T028 [P] [US3] 核验类别 6–7（test-×3、db-×3 共 6 条）：@nestjs/testing/Vitest 适配、事务边界收口在 application、N+1 迁移步审计记录、migration:drill 证据引用
- [ ] T029 [P] [US3] 核验类别 8–10（api-×4、micro-×3、devops-×3 共 10 条）：含 ⏸ 候选偏离（api-versioning、micro-use-patterns、micro-use-queues）与 🔄 适配（DTO 序列化、health-checks、config-module）核验
- [ ] T030 [US3] 偏离终版登记与结论：将全部 ⏸/最终判定为偏离的条目整理进 `docs/adr/0014-backend-ddd-structure.md`「规则偏离清单」章节；填写清单末尾「统计与结论栏」（覆盖率 40/40、SC-005 结论）（依赖 T026–T029）

**Checkpoint**: US3 完成 = 清单全结论 + ADR 偏离登记完毕

---

## Phase 6: User Story 4 - 零遗留收尾与文档原子同步 (Priority: P2)

**Goal**: 零遗留红线达成（孤儿文件/死代码/注释旧实现/临时垫片 = 0）；规格、ADR、证据在同一原子变更中同步归档

**Independent Test**: `audit:orphans` 0 + 全库残留检索 0 + quickstart.md 全量终验通过 + 证据链完整（SC-001..006 逐条可勾验）

- [ ] T031 [US4] 零遗留清点：运行 `pnpm --filter @hmp/server audit:orphans` 清零；全库检索被注释的旧实现、迁移占位标记（属于本次迁移的 TODO/FIXME）、临时绕行垫片并清零；结果存 `evidence/zero-leftover.md`（含检索命令与命中数）
- [ ] T032 [US4] 文档原子同步：在同一提交中完成——`docs/specs/007-backend-ddd-restructure/spec.md` 状态流转（Implementing → Verified 的前置状态推进）、`docs/adr/0014-backend-ddd-structure.md` 链接核对、宪章无涉改确认（本次不改宪章）；提交信息按宪章惯例注明规格与 ADR
- [ ] T033 [US4] 执行 `docs/specs/007-backend-ddd-restructure/quickstart.md`「全量终验」全部命令（含 `pnpm gen:types` 产物 diff 为空核对、`migration:drill`、双审计归零），输出存 `evidence/final-validation.md`
- [ ] T034 [US4] 完成对照与验收报告：对照 spec.md SC-001..006 逐条勾验并汇总全部 evidence 文件索引，产出 `evidence/completion.md`；确认 `nestjs-best-practices-compliance.md` 统计栏与 T030 一致后提交最终状态

**Checkpoint**: US4 完成 = 零遗留 + 文档同步 + 全量终验通过；本特性整体交付

---

## Dependencies & Execution Order

### Phase Dependencies

- **Phase 1（Setup）**: 无前置，立即可开工；T001 阻塞一切实现类任务（T008 起）；T002/T003 先于 T006
- **Phase 2（Foundational）**: 依赖 T002/T003；T007 依赖 T004 前的代码现状（须在 T008 前完成）；T006/T007 共同阻塞 US1
- **Phase 3（US1）**: T008 → T008a（别名基座，T009 的导入形态前提）→ T009→T019 严格按序（D6 先叶后根，前步的导入稳定是后步前提）；每步内含门禁自检
- **Phase 4（US2）**: 依赖 US1 全部完成（T019）；T020/T021 可先行，T022/T023 依赖 T020/T021，T024 依赖 T022/T023，T025 依赖 T024
- **Phase 5（US3）**: 依赖 US2（T024）——规则核验对象是收口后的结构；T030 依赖 T026–T029
- **Phase 6（US4）**: 依赖 US3（T030）与 US2 证据（T025）；T033 依赖 T031；T034 依赖 T032/T033

### User Story Dependencies

- US1 与 US2 同为 P1 且天然串联（先落位后收口），合为本特性 MVP 增量；US1 单独不构成可交付终点（边界未收口不满足 FR-003/004）
- US3、US4 依赖 US1+US2 的产物，不可并行于其之前

### Parallel Opportunities

- Phase 1 内：T002、T003、T004、T005 互不依赖可并行（T001 独立并行）
- Phase 5 内：T026、T027、T028、T029 按类别切分不同清单区段，可并行核验后由 T030 汇总
- 单个迁移步内部（US1）：同层多文件移动可并行执行，但步与步之间保持串行

---

## Implementation Strategy

- **MVP**: Phase 1–4（US1+US2）= 结构对齐与边界收口的最小可交付增量；在此暂停即可获得全部宪章第 6 条收益与零行为风险的证明
- **增量交付**: 每个迁移步独立提交、独立可回滚（git 层面）；审计规则随结构落地自动收紧，杜绝"最后一次性补合规"
- **风险控制**: playback（T017）与 platform（T018）风险最高，置于序列末尾；任何一步门禁失败即停下修复，禁止带病前进（quickstart.md 故障排查速查）
- **证据纪律**: 每阶段产物即时写入 `evidence/`，Spec 状态仅在对应证据齐备后流转——不得在 T033 前声称 Verified

---

## Notes

- [P] = 不同文件、不依赖未完成任务；迁移步之间一律串行
- [Story] 标签与 spec.md 的 US1–US4 一一对应，便于追溯
- 本特性零新增运行时依赖（仅 devDeps 审计工具）；零契约变更；零数据库变更
- 验收语言：所有"完成"判定均为二元可判定项（审计归零 / diff 为空 / 测试全绿 / 清点为零）
