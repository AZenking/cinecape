# Tasks: 应用层数据访问仓储化抽取（008-repository-extraction）

**Created**: 2026-10-28
**Spec**: [spec.md](./spec.md)（Accepted）· **ADR**: [ADR-0015](../../adr/0015-repository-extraction.md)（Accepted）
**路径约定**: 源码 `apps/server/src/`；测试 `apps/server/test/`；证据 `docs/specs/008-repository-extraction/evidence/`。
**步末门禁**（每上下文任务）: `pnpm --filter @hmp/server typecheck && pnpm --filter @hmp/server lint && pnpm --filter @hmp/server test && pnpm --filter @hmp/server audit:boundaries && pnpm --filter @hmp/server audit:orphans`；迁移期 R1b 未收紧前 audit:boundaries 恒绿，纯度靠上下文任务自检（本地 purity 探针脚本随 T002 就位）。

## Phase 0: 立项与基线

- [X] T001 规格与 ADR 立项（本批文档；维护者指令显式接受）
- [X] T002 新增 `audit:purity` 符号级门禁脚本（禁符清单见 ADR-0015 D3；`import type` 放行）并接入 `verify:release` 前置链；先以**报告模式**运行记录基线命中数（预期 ≈35 文件），归零门槛在 T013 收紧
- [X] T003 基线证据：全量测试计数、路由清单快照（对照 007 evidence/routes-baseline.md）、双审计输出，存 `evidence/baseline.md`

## Phase 1: 逐上下文抽取（每任务独立提交，模式见 ADR-0015 D1/D2）

- [X] T004 试点 policy（policy.service + policy.batch-context；`loadAvailableMediaIdSet(db,h)`/`loadBatchCatalogContext(db,…)` 签名收敛 + 4 个消费上下文机械适配 + 相关测试 rig 绑定）——验证模式与门禁后作为后续模板
- [X] T005 personal-data（favorites/history/progress-write/progress-clock + signed-cursor 消费边）
- [X] T006 profile（profile/profile-selection/pin/identity-transition；requireOwnedProfile 签名联动）
- [X] T007 epg（epg.service/manual-epg-binding/guide-window；catalog-revision 消费边）
- [X] T008 live-tv（live-projection）
- [X] T009 sources（sources.service/refresh-executor/refresh-publish；`Database` 类引用收敛）
- [X] T010 media-catalog（catalog/catalog-admin/public-catalog；resource-reader 为 infrastructure 原生，仅消费边核对）
- [X] T011 identity-access（household/session/device/setup/bootstrap/parent-verification；`getDb` 发布面保留，application 内部消费清零）
- [X] T012 settings（7 个 settings-* 服务 + access-revocation `Database` 引用；interface 层 getDb 消费仅做端口联动适配）
- [X] T013 playback（authorization/audit/resolver/selection/ticket/retention/rate-limit 等 6+ 文件，最大者殿后；playback.module 内 getDb 属装配区保留）

## Phase 2: 审计收紧与收口

- [X] T014 R1b 收紧：`.dependency-cruiser.cjs` application 行恢复 `@platform/database`/drizzle-orm/better-sqlite3 落点禁止（ADR-0014 修正 3 对应项收回，规则处留裁决注释互链 ADR-0015）；`audit:purity` 切 enforce；双门禁 0 违规 + 负向探针（注入式验证两类走私均被拦截），证据存 `evidence/audit-tightening.md`
- [X] T015 行为零变化证据：路由清单 0 diff、全量测试 + `test:runtime` 全绿（计数对照 T003 基线）、每控制器 ≥1 路由响应快照抽查，存 `evidence/behavior-parity.md`
- [X] T016 零遗留清点 + 文档原子同步：TODO/垫片清零检索；ADR-0014 登记 5 追加「已由规格 008 补救」注记；007 合规清单 arch-use-repository-pattern 挂接更新；本规格状态流转；同批提交

## Dependencies & Execution Order

T002/T003 先行 → T004（试点，阻塞 T005–T013 的模式确认）→ T005–T013 按 D6 先叶后根序（跨上下文签名联动的消费方适配随属主任务同提交）→ T014 依赖 T004–T013 全部完成 → T015 依赖 T014 → T016 收口。
