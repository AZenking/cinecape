# Implementation Plan: Apple 风格直播与设置体验——统一播放链路与布局分组

**Branch**: `012-live-settings-experience` | **Date**: 2026-11-01 | **Spec**: [spec.md](spec.md)

**Input**: Feature specification from `/docs/specs/012-live-settings-experience/spec.md`

**Note**: This template is filled in by the `/speckit-plan` command; its definition describes the execution workflow.

## Summary

把 012 规格落地为**以复用为主的收敛计划**：005/006/009/010 已交付统一播放链路（ActionCoordinator：intentId/returnTo/代次守卫/白名单防重定向）、30 秒安静刷新（use-live-refresh + visibilitychange）、EPG URL 状态（date/from/channelPage/pageSize/view）、设置模块注册表与布局壳（T086）。本计划的工作重心是：① 直播播放入口从 GuestActionNotice 占位真正接入 usePlayAction 意图链路并验收游客→登录→选档→授权全链；② 直播与 EPG 两处节目详情（ProgrammeSlotDialog / ProgrammeDetailPanel）统一为同一类面板；③ 验证并补齐「安静刷新不打断、刷新不重置状态、Escape/焦点恢复」等连续性细节；④ 设置左侧按「个人偏好 / 家庭管理 / 系统」分组并标注作用范围（分组先行，不新增偏好项——澄清 Q1）；⑤ 全程键盘/焦点/响应式走查。**零新增服务端端点、零数据库迁移、零新 ADR**（授权链路为 005 既有语义的接线与验证，见 research R6/R8）。

## Technical Context

**Language/Version**: TypeScript 5.x（严格模式）；前端 React 19 + Vite，后端 Node.js + NestJS 12（本规格基本不触后端）

**Primary Dependencies**: @heroui/react 3.2.6 + @heroui/styles（语义 token，宪章第 5/8 条）、react-router（URL 状态）、@tanstack/react-query（查询缓存与 purgePersonalData 隔离）、@internationalized/date（时区/日界）、@hmp/shared（契约类型）；后端 Drizzle ORM + better-sqlite3（本规格不触及）

**Storage**: 无新增（沿用现有 SQLite/Drizzle；频道收藏、播放授权、EPG 排期均为既有持久化，播放意图为前端应用会话内存态——澄清 Q2）

**Testing**: Vitest（web 单测 `pnpm --filter @hmp/web test`、server 单测/契约 `pnpm --filter @hmp/server test:unit|test:contract`）+ Playwright e2e（`pnpm --filter @hmp/web test:e2e`）+ 键盘/响应式人工走查（quickstart）

**Target Platform**: PC 浏览器（Chromium 系优先），交互模型按远距离观看设计；200% 缩放、窄窗/低高度可达

**Project Type**: pnpm monorepo（apps/web + apps/server + packages/shared），前端呈现层收敛为主

**Performance Goals**: 节目状态刷新周期 30 秒（契约下限，既有 LIVE_REFRESH_INTERVAL_MS=30_000）；刷新期间焦点/面板/分页零打断（SC-003 连续观察 ≥10 分钟）

**Constraints**: 授权通过前零媒体流请求（005 既有约束）；意图不含凭据、不写浏览器存储；点播入口不改造、不纳入验收、不触发 010 回归（澄清 Q3）；设置访问验证规则不在本规格定义（归 ADR-0011/011 替代关系）；视觉遵循 DESIGN.md 语义 token，禁止业务组件硬编码

**Scale/Scope**: 7 个业务模块、2 处详情面板合一、3 类直播播放入口（Now/Next/Guide）+ 首页；改动集中于 apps/web/src/features/{live,epg,settings,home,playback}、layouts、app/{routes,action-coordinator}；预期无 schema 变更

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

- **Accepted specification and linked accepted ADRs; new decisions require an ADR** — ⚠️ 条件通过：规格 012 当前 **Proposed**，任务生成与实施前必须经维护者接受（原则一）；本计划判定**无需新 ADR**（播放链路为 005 已接受语义的接线验证，设置分组为呈现层重组，无授权边界/存储结构变更——依据见 research R6/R8），但实施涉及播放授权面时须核对 005 契约同步义务（spec Related ADRs 门禁）。
- **Household → Account → Profile ownership** — 通过：播放意图不含身份与个人数据（FR-006/Q2）；游客态零个人请求；切档失效沿用 session-provider purgePersonalData 与代次守卫（006 已交付），本计划仅验证不重构。
- **Server-side session, ProfilePolicy and playback authorization, with negative tests** — 通过：授权链路全部服务端裁决（005 既有），SC-006 负向标准（未登录/未选档零私有读取、授权前零媒体流）纳入任务验收。
- **Docker/Linux NAS delivery, local private data, no mandatory cloud dependency** — 通过：本计划不引入外部服务、遥测或云依赖。
- **Type/lint checks, passing unit/integration contract tests, runtime evidence; tested migration rollback and synchronized documentation** — 通过：零迁移（无回滚面）；验收 = lint + typecheck + web vitest + e2e + quickstart 人工走查；文档随证据同步。

**Post-Phase 1 re-check**: 设计未引入新服务面/存储/跨上下文越界（见 data-model「零持久化增量」），五项门禁维持通过；唯一遗留为规格接受门禁（Proposed），在 tasks 阶段作为 T001 式前置项。

## Project Structure

### Documentation (this feature)

```text
docs/specs/012-live-settings-experience/
├── plan.md              # This file (/speckit-plan command output)
├── research.md          # Phase 0 output (/speckit-plan command)
├── data-model.md        # Phase 1 output (/speckit-plan command)
├── quickstart.md        # Phase 1 output (/speckit-plan command)
├── contracts/           # Phase 1 output (/speckit-plan command)
│   ├── ui.md            # 交互与焦点契约（详情面板/播放器/设置布局行为）
│   ├── url-state.md     # URL 可恢复状态契约（/live、/live/guide、/settings）
│   └── api-reuse.md     # 既有端点复用矩阵（零新增端点、零迁移声明）
└── tasks.md             # Phase 2 output (/speckit-tasks command - NOT created by /speckit-plan)
```

### Source Code (repository root)

```text
apps/web/src/
├── app/
│   ├── action-coordinator.tsx      # 统一播放/登录/选档状态机（005 已建；本规格接线验证+必要微调）
│   ├── action-coordinator-core.ts  # 意图状态机纯函数（intentId/returnTo/代次）
│   ├── routes.tsx                  # 路由注册表（/live、/live/guide、/settings/* 已注册）
│   └── session-provider.tsx        # 会话事实与身份切换隔离（006 已建；只验证）
├── layouts/
│   ├── PublicLayout.tsx            # 顶部主导航（首页/点播/直播 + 身份菜单）
│   └── SettingsLayout.tsx          # 设置布局壳（本规格：左侧分组导航 + 作用范围标注）
├── features/
│   ├── live/                       # 直播首页（NowHero/NowSection/NextSection/GroupSections）
│   │   ├── components/GuestActionNotice.tsx   # 占位提示 → 本规格升级为真实意图接线
│   │   ├── components/ProgrammeSlotDialog.tsx # 直播侧节目详情 → 统一面板（R2）
│   │   └── hooks/use-live-refresh.ts          # 30s 安静刷新（R3：保持语义+补断言）
│   ├── epg/                        # 节目单（GuidePage/useGuideWindow/GuideWall/…）
│   │   └── ProgrammeDetailPanel.tsx           # EPG 侧节目详情 → 统一面板（R2）
│   ├── home/                       # 公共首页（个人区/游客提示，验证入口一致性）
│   ├── playback/                   # 播放器（player-view/video-player；本规格补直播能力清单核对）
│   ├── favorites/                  # 频道收藏（既有 /me/favorites/channels；仅行为约束）
│   └── settings/                   # 设置七模块（settings-modules 注册表 → 本规格加分组元数据）
└── shared/
    ├── theme/{tokens,a11y}.css     # 焦点环/语义 token（宪章第 8 条；只消费不硬编码）
    └── ui/                         # 共享 UI（pin-field 等；Escape/焦点惯例参考 009）

apps/server/src/
└── contexts/live-tv/interface/live.controller.ts  # 既有 public/live/* 端点（本规格零改动，复用矩阵见 contracts/api-reuse.md）

apps/web/test/                      # web vitest 单测 + playwright e2e（新增验收测试落点）
```

**Structure Decision**: 复用既有 monorepo 布局，全部改动落在 `apps/web`（呈现层与状态接线），`apps/server` 仅在复用矩阵核对中发现契约缺口时才允许最小补端点（当前评估为零缺口）；不新建上下文/目录/迁移。文档产物全部位于 `docs/specs/012-live-settings-experience/`。

## Complexity Tracking

> Fill ONLY if Constitution Check has violations that must be justified

（无违宪项需要记录——零新增项目、零迁移、零新 ADR；唯一门禁为规格 Proposed → Accepted 需维护者确认，属流程而非复杂度。）
