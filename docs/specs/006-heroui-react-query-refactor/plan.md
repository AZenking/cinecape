# Implementation Plan: PC 端 UI 组件与数据请求架构全面调整（HeroUI + 统一数据层 + 共享 Hooks）

**Branch**: `006-heroui-react-query-refactor` | **Date**: 2026-10-27 | **Spec**: [spec.md](./spec.md)

**Input**: Feature specification from `/docs/specs/006-heroui-react-query-refactor/spec.md`

## Summary

PC 端呈现层等价重构，三条主线：(1) 全部交互控件统一为 HeroUI v3（清除 7 处原生
`<select>` 与 1 处 `window.alert`，落实宪法 v1.3.0 技术约束 5）；(2) 服务端数据
请求收敛到统一查询/变更层（react-query v5，新建 `apps/web/src/shared/query/`，
保留 `shared/fetch.ts` 为唯一传输底座，删除遗留 `lib/api.ts`），按
`public/profile/settings` 三域键控实现"浏览型缓存即显 + 设置型每次最新 +
切档清域"；(3) 通用逻辑沉淀共享 hooks、优先复用成熟开源库、尽量少自研。
服务端接口契约、路由与用户功能保持不变，按用户故事增量交付。

## Technical Context

**Language/Version**: TypeScript 5.8 / React 19.3 / Node >= 24 / pnpm 11（monorepo）

**Primary Dependencies**: Vite 7、Tailwind CSS 4、`@heroui/react` + `@heroui/styles`
3.2.6（已安装未使用）、react-router 7、video.js 8；**新增** `@tanstack/react-query` v5、
通用 hooks 库（决策 D1，见 [research.md](./research.md)）

**Storage**: N/A —— 数据层缓存为前端运行时内存；不涉及服务端存储变更

**Testing**: Vitest 3 + Testing Library（单测/组件）、Playwright 1.64（E2E）、
`pnpm typecheck / lint`（静态门禁）

**Target Platform**: 现代桌面浏览器（PC Web），同源部署于家用 NAS（Docker/Linux）；
开发期 Vite 代理 `/api` → `:3000`

**Project Type**: Web 前端（monorepo 内 `apps/web`），仅呈现层变更

**Performance Goals**: 缓存命中的页面切换零阻塞加载（SC-003）；首屏关键路径
传输体积增幅 ≤ 15%（SC-009，构建产物测量）

**Constraints**: 服务端契约与路由不变；原生交互控件清零；`settings` 域数据每次
进入必取最新；变更幂等保持；`profile` 域切档/登出/401 全清（安全底线）

**Scale/Scope**: `apps/web` 10 个 feature 域（auth/catalog/epg/favorites/history/
home/live/playback/profiles/settings）+ app 外壳 + shared；8 处原生控件替换；
2 个数据访问入口收敛为 1（`shared/query/` 新建、`lib/api.ts` 删除）

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

| 门禁项 | 状态 | 说明 |
| --- | --- | --- |
| 已接受规格与 ADR；新决策需 ADR | ⚠️ **实现前置条件** | 规格 006 现为 `Proposed`；数据层选型（D2）、hooks 库（D1）、`lib/api.ts` 退役（D5）须以新 ADR 记录并与规格一同接受。**不阻塞规划/研究**；tasks 第一批任务必须以"规格 + 相关 ADR 已接受"为起始门禁（宪法原则一、五） |
| Household→Account→Profile 隔离；缓存键显式身份边界 | ✅ 通过（设计） | `profile` 域键强制携带 `profileId`（[query-keys](./contracts/query-keys.md)）；切档/登出/401 域级取消并清除；公共域身份无关（V1 单部署单家庭由服务端决定，前端不引入 household 键段，符合原则三） |
| 服务端会话/策略/播放鉴权 + 负向测试 | ✅ 通过（设计） | 本特性不改服务端授权；播放解析为一次性动作、票据/凭据不入缓存；负向用例（跨档案泄漏/未认证/过期响应不回写）列入测试契约与 E2E |
| 自托管 NAS、本地数据、无强制云依赖/非授权遥测 | ✅ 通过 | 纯前端重构，无运行时外部请求；react-query devtools 仅开发构建；新增依赖均为构建期 npm 包 |
| 类型/lint、单元/集成契约、运行时与 E2E 证据 | ✅ 通过（设计） | 见 [quickstart.md](./quickstart.md) 场景 6 与 [data-access](./contracts/data-access.md) 测试契约 |
| 技术约束 3（幂等/一致性） | ✅ 通过（设计） | mutation 不自动重试；成功后按声明集合失效相关查询；去重防双击 |
| 技术约束 4（领域核心解耦） | ✅ 通过（设计） | `@heroui/*`、`@tanstack/react-query`、hooks 库仅进 `apps/web/package.json`；`@hmp/shared` 保持 type-only 引用 |
| 技术约束 5（HeroUI 优先，v1.3.0） | ✅ 通过 | 本特性即其落实；组件清单已在本地 node_modules 核验（`HEROUI-NOTES.md`） |
| v1.3.0 特定交付例外（仅规格 005） | — 不适用 | 006 为前端重构，不触碰数据迁移/旧接口兼容议题 |

## Project Structure

### Documentation (this feature)

```text
docs/specs/006-heroui-react-query-refactor/
├── plan.md              # 本文件
├── research.md          # Phase 0：D1–D5 决策（hooks 库、react-query 策略等）
├── data-model.md        # Phase 1：缓存域/查询/变更实体模型
├── quickstart.md        # Phase 1：端到端验证指南
├── contracts/           # Phase 1：query-keys / data-access / ui-components
└── tasks.md             # Phase 2 产出（/speckit-tasks，本命令不创建）
```

### Source Code (repository root)

```text
apps/web/src/
├── app/
│   ├── providers.tsx        # 追加 QueryClientProvider + 身份切换时域级清缓存
│   ├── session-provider.tsx # 注入经验证 profileId 供键工厂使用
│   └── routes.tsx / App.tsx # 路由不变
├── shared/
│   ├── fetch.ts             # 传输底座保留（唯一 fetch 入口，problem+json 映射）
│   ├── query/               # 【新增】client.ts / keys.ts / scopes.ts / error.ts
│   │                        #   + 封装 useAppQuery / useAppMutation（域、反馈分档）
│   ├── hooks/               # 【新增】共享 hooks：开源库 re-export + 少量自研（附单测）
│   └── ui/                  # 【重构】HeroUI 重导出与三态组件（Skeleton/Alert+重试/EmptyState/Toast）
├── features/                # 逐域迁移：组件→HeroUI；数据→统一数据层
│   ├── auth|catalog|epg|favorites|history|home|live|playback|profiles|settings/
│   └── settings/use-media-query.ts → 收编至 shared/hooks
└── lib/api.ts               # 【删除】遗留封装，迁移完成后移除

apps/web/test/               # vitest 单测/组件测试（新增数据层与负向用例）
apps/web/test/e2e/           # Playwright：US1–US3 + 安全负向场景
```

**Structure Decision**: 复用现有 `apps/web` 单应用结构；新增 `shared/query/` 与
`shared/hooks/` 两个共享层目录承载本次架构增量；不新增应用、不拆分包——
最小结构满足三域缓存与共享逻辑收口（替代方案"独立 data-layer 包"因
仅单应用消费、且须避免 `@hmp/shared` 被 UI 依赖污染而否决）。

## Post-Design Constitution Re-check（Phase 1 设计后复核）

- **身份隔离（原则二）**：✅ 机制具体化——`profile` 域键强制含 `profileId`；
  切档/登出/401 执行 `cancelQueries → removeQueries → mutationCache.clear()`
  且同步先于身份状态更新（research D4）；在途个人响应随取消丢弃（SC-005 可验）。
- **公开浏览边界（原则三）**：✅ 公共域键 `[0]==='public'` 在清除谓词中显式豁免，
  游客浏览不中断；播放凭据不进缓存、解析为一次性动作。
- **设置强制最新（Q2/FR-012）**：✅ `gcTime:0 + staleTime:0 + isPending 门控`
  配方经官方语义确认（缓存旧值无处渲染）。
- **幂等（技术约束 3）**：✅ `mutations retry:0`、pending 去重、失效对账。
- **领域解耦（技术约束 4）**：✅ 新依赖（react-query/@mantine/hooks/devtools）仅入
  `apps/web/package.json`；`@hmp/shared` 保持 type-only。
- **体积预算（SC-009）**：✅ 数据层 ≈13.2KB gzip + hooks 库按需导入（实测等价
  9 hooks ≈2.62KB gzip，零运行时依赖），相对 15% 预算可行；基线在任务期实测
  （quickstart 场景 0）。
- **不变项**：⚠️ 规格与 ADR 的"已接受"门禁维持为实现前置条件（见上表第一行），
  tasks 首任务必须以其为 DOOR；设计本身未引入新违规，Complexity Tracking 保持"无"。

## Complexity Tracking

> 仅在存在必须辩护的门禁违规时填写。

| Violation | Why Needed | Simpler Alternative Rejected Because |
| --- | --- | --- |
| （无） | — | — |

## Phase 0 / Phase 1 决策索引

- **D1 通用 hooks 库选型** → [research.md](./research.md)
- **D2 react-query v5 版本/默认配置与三域策略** → [research.md](./research.md)
- **D3 乐观更新与回滚统一封装** → [research.md](./research.md)
- **D4 身份切换/401 缓存清除 API 选择** → [research.md](./research.md)
- **D5 遗留 `lib/api.ts` 退役路径** → [research.md](./research.md)
- 组件映射与 UI 契约 → [contracts/ui-components.md](./contracts/ui-components.md)
- 键契约与域行为 → [contracts/query-keys.md](./contracts/query-keys.md)
