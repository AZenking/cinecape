# Implementation Plan: 直播全流程重构——即开即看、智能分流与同类切台

**Branch**: `015-live-flow-redesign` | **Date**: 2026-11-08 | **Spec**: [spec.md](spec.md)

**Input**: 用户手绘线框草图（`media_1794127889674_ebb61729.jpg`）、批注修正图（`media_1794134731713_7d429d8b.png`）及规格 `spec.md`。

## Summary

本重构计划基于用户手绘线框图和关键交互批注，全面重构 PC 端直播体验：
1. **彻底消除摩擦力**：卡片 Hover 直出 `▶ 播放` 按钮，相交于当前时间线的节目块直接起播，告别“看电视必须先跳静态详情页”的高摩擦路径；
2. **精准维度分流**：Screen 1 首页的 Live 正在直播行尾点击查看全部直达 Screen 3（EPG 节目单时间墙）；各分类行尾点击查看全部直达 Screen 2（分类平铺网格）且自动联动高亮对应分类 Tab；
3. **开门见山大屏**：Screen 1 顶部 Hero 确立为【直接播放】的实时可收看大屏，下方自上而下【展示各个分类】的完整频道泳道；
4. **沉浸式消费中心**：构建 Screen 4 独立一体化播放与详情页（`/live/watch/:channelId`），进入即自动起播，伴随展示当前节目与下一档预告，底部通过 `sam type live`（同类直播横条）实现不刷页的就地平滑切台换流；
5. **坚守安全底座**：100% 复用现有公共元数据与播放鉴权 API，零数据库迁移，零后端破坏性改动；游客免登录浏览，起播暂存意图并在认证后全链路自动恢复。

---

## Technical Context

**Language/Version**: TypeScript 5.x（严格模式）；前端 React 19 + Vite，后端 Node.js 24 + NestJS 12。

**Primary Dependencies**: HeroUI v3 (`@heroui/react` 3.2.6, `@heroui/styles`，严格遵循 DESIGN.md 语义 token，禁用原生控件)、`lucide-react` 线型图标库、`react-router` v7（路由与 URL 状态）、`@tanstack/react-query`（请求与缓存）、`@internationalized/date`（时区与时间轴计算）、`@hmp/shared`（契约类型共享）。

**Storage**: **零新增数据库迁移**。完全复用既有 SQLite / Drizzle 数据结构（频道分组 `group_title`、EPG 节目时段与播放会话持久化）。

**Testing**: Vitest（前端单元测试 `pnpm --filter @hmp/web test`）、Playwright e2e 测试（`pnpm --filter @hmp/web test:e2e`）及人工场景走查（[quickstart.md](quickstart.md)）。

**Target Platform**: PC 浏览器（支持宽屏 1440px/1920px/2560px，兼顾 768px~1024px 窄屏重排与 200% 缩放）。

**Project Type**: pnpm monorepo 前端核心体验重构（`apps/web` 呈现层收敛）。

**Performance Goals**: 换台切流本地响应 < 100ms；EPG 时间轴渲染流畅无掉帧；30 秒周期静默刷新不打断用户操作。

**Constraints**: 播放前零媒体流请求；意图不落 localStorage；纯粹采用 HeroUI v3 语义 token 与 Lucide 图标；遵循 DDD 分层与单向依赖。

---

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

- **规格驱动与证据验收（原则一）** — 通过：已编写完备的 `spec.md` 与质量检查清单，通过端到端与负向测试多层证据验收。
- **三层身份与数据隔离（原则二）** — 通过：全流程未登录状态零个人数据泄露；收藏与历史严格隔离至 `profile_id`。
- **公开浏览与服务端鉴权分离（原则三）** — 通过：全站内容元数据允许游客浏览；起播强校验会话、ProfilePolicy 与资源可用性，公开可见不承诺可播放。
- **自托管隐私与本地化（原则四）** — 通过：无外部云端依赖与数据上报。
- **UI 规范与 HeroUI 优先（原则五、八、九）** — 通过：界面纯粹采用 HeroUI v3 语义 token，杜绝原生控件；图标统一使用 `lucide-react`。
- **后端 DDD 边界（原则六、七）** — 通过：完全复用既有契约，不侵入内部领域层。

**Post-Phase 1 Re-Check**: Phase 0 与 Phase 1 设计产物（`research.md`、`data-model.md`、`contracts/`、`quickstart.md`）全部符合宪章要求，五大门禁全绿通过。

---

## Project Structure

### Documentation (this feature)

```text
docs/specs/015-live-flow-redesign/
├── spec.md              # 需求规格说明书
├── plan.md              # 实施计划与架构设计 (本文件)
├── research.md          # Phase 0: 技术调研与手稿落地决策
├── data-model.md        # Phase 1: 视图模型与状态转移设计
├── quickstart.md        # Phase 1: 端到端验证与操作指南
├── contracts/           # Phase 1: 契约规范
│   ├── ui-layout.md     # 对应手绘稿 4 大视口的线框布局契约
│   ├── routing-and-url-state.md # 路由与 URL 状态参数契约
│   └── api-reuse.md     # 既有端点复用矩阵与安全性说明
└── checklists/
    └── requirements.md  # 规格质量检查清单
```

### Source Code Changes (Planned)

```text
apps/web/src/
├── app/
│   └── routes.tsx                                   # 注册 /live/channels 与 /live/watch/:id 路由
├── layouts/
│   └── PublicLayout.tsx                             # 保持免登录顶级导航包裹
├── features/
│   ├── live/
│   │   ├── LivePage.tsx                             # Screen 1: 直播首页重构 (Hero大屏直接播放 + 逐行展示各分类)
│   │   ├── components/
│   │   │   ├── LiveHeroPlayer.tsx                   # Screen 1: 顶部直接播放 Hero 播放器大屏
│   │   │   ├── ChannelCard.tsx                      # 通用卡片组件 (Hover ▶ 直接起播 + 详情分流)
│   │   │   └── CategorySwimlanes.tsx                # 各分类逐行展示泳道组件
│   │   ├── pages/
│   │   │   ├── ChannelGridPage.tsx                  # Screen 2: 分类平铺网格页 (Tabs联动 + 搜索)
│   │   │   └── LiveWatchPage.tsx                    # Screen 4: 播放与详情一体化页 (自动起播 + sam type live 切台)
│   │   └── hooks/
│   │       ├── useRelatedLiveChannels.ts            # 获取当前分类下其他正在直播频道
│   │       └── useInPlaceChannelSwitch.ts           # 沉浸式就地切流换台 Hook
│   └── epg/
│       ├── GuidePage.tsx                            # Screen 3: EPG 节目单时间墙
│       └── GuideWall.tsx                            # 相交于 NOW 垂直线的节目块点击直接起播
```

---

## Phased Execution Roadmap

### Phase 0: Outline & Research ✅
- 解析手绘图 4 大界面结构与批注核心诉求；
- 解决即开即看与详情解耦、智能分流、Hero 播放以及同类切台机制（输出 `research.md`）。

### Phase 1: Design & Contracts ✅
- 完成视图模型与状态机定义（输出 `data-model.md`）；
- 完成手绘线框图与 UI 布局契约映射（输出 `contracts/ui-layout.md`）；
- 完成路由与参数契约（输出 `contracts/routing-and-url-state.md`）；
- 完成 API 复用与快速上手验证指南（输出 `contracts/api-reuse.md` 与 `quickstart.md`）。

### Phase 2: Implementation (通过 `/speckit-tasks` 分解生成 tasks.md 并执行)
- **Milestone 1**: 路由扩展与卡片 Hover 快捷起播组件改造；
- **Milestone 2**: Screen 1 直播首页重构（顶部 Hero 直接播放大屏 + 自上而下展示各个分类）；
- **Milestone 3**: Screen 3 EPG 节目单墙打通（Live 行直达 + 相交 NOW 节目直接起播）；
- **Milestone 4**: Screen 2 分类平铺网格页（分类 Tabs 联动高亮 + 搜索筛选）；
- **Milestone 5**: Screen 4 播放与详情一体化页（自动起播 + `sam type live` 无缝平滑切台换台）；
- **Milestone 6**: 游客全链路认证意图保存恢复与端到端自动化测试回归。
