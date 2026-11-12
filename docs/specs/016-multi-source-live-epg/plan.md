# Implementation Plan: 多直播源聚合与多 EPG 源级联匹配及前端实时呈现 (016-multi-source-live-epg)

**Branch**: `016-multi-source-live-epg` | **Date**: 2026-11-09 | **Spec**: [spec.md](spec.md)

**Input**: Feature specification from `docs/specs/016-multi-source-live-epg/spec.md`

---

## Summary

本功能解决家庭媒体平台中多直播源（M3U）与多 EPG 源的数据聚合、级联容灾匹配与前端当前节目高性能渲染问题。核心技术策略如下：
1. **多直播源线路解耦**：逻辑频道（`media_item`）与物理流（`playback_source`）1:N 解耦，导入时自动依据清洗后的标准键归并为“线路 1、线路 2”；
2. **多 EPG 源级联匹配引擎**：在 `live-tv` 上下文中实现“**手动锁定 (ADR-0008) > tvg-id 精确匹配 > 优先级级联回退 > 归一化别名清洗**”的 5 级确定性匹配链；维护固定查询预算（Anti-N+1）；
3. **播放器双保险容灾**：`playback-resolver` 下发可用线路列表，播放器内核实现静默故障转移（Auto-Failover）与 OSD 控制栏手动换线面板；
4. **前端智能事件时钟**：基于 `useCurrentProgramme` Hook 与当前节目的 `end_time` 计算单次精准定时器，到点自动将 `next` 推进为 `current`，进度条由本地轻量定时器驱动，避免死板高频轮询。

---

## Technical Context

**Language/Version**: TypeScript 5.8+, Node.js 20+  
**Primary Dependencies**: React 19, `@heroui/react` 3.0.1, `@heroui/styles`, `lucide-react`, `@tanstack/react-query`, NestJS 10, Drizzle ORM, `better-sqlite3`, `zod`  
**Storage**: SQLite (via `better-sqlite3` and Drizzle ORM 迁移演进)  
**Testing**: Vitest (`apps/web`), Jest / Supertest (`apps/server`), Playwright (E2E)  
**Target Platform**: Linux Docker 容器化 NAS / 现代 PC 桌面浏览器  
**Project Type**: Fullstack Monorepo (`apps/server`, `apps/web`, `packages/shared`)  
**Performance Goals**:
- 200 个频道批量当前节目投影响应时间 < 50ms（固定次数查询，零 N+1）；
- 直播首页卡片与进度条首屏渲染延迟 < 500ms；
- 节目到点自动翻转切换延迟 < 2s（无需页面重载）；
- 播放器流异常自动换线重连恢复 < 3s。  
**Constraints**:
- 严格遵循 `Household -> Account -> Profile` 三层层级结构（宪章原则二）；
- 严格执行公共浏览与播放授权分离（ADR-0010 与宪章原则三）；
- 严格保障儿童频道白名单安全隔离（`allowedChannelIds`）；
- PC 端界面强制遵循 HeroUI v3 与 `lucide-react`，严禁使用原生交互控件（宪章原则五与原则九）。  
**Scale/Scope**: 单部署单 Household（家庭私有 NAS），200+ 频道，多 M3U / EPG 数据源。

---

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

- [x] **原则一：规格驱动与多层证据验收**：规格 `016-multi-source-live-epg/spec.md` 已就绪，已关联 ADR-0007、ADR-0008、ADR-0010、ADR-0015、ADR-0017，验收场景具备独立二元结果与负向测试。
- [x] **原则二：三层身份与数据边界严格隔离**：多源配置与线路数据以 `household_id` 为边界；个人数据（收藏、历史）严格绑定 `profile_id`。
- [x] **原则三：公开浏览与默认安全的服务端播放鉴权**：批量当前 EPG 为公开元数据；播放解析与多线路下发必须基于有效会话并通过 `ProfilePolicy` 裁决。
- [x] **原则四：自托管 NAS 与隐私优先架构**：核心流媒体调度与 EPG 匹配均在本地服务端完成，无强制外部云依赖。
- [x] **原则五：架构决策与非破坏性演进**：兼容 ADR-0008 手动绑定锁定规则，增量扩展 Drizzle 迁移 `0010_multi_source_priority`，具备回滚方案。
- [x] **原则六：角色差异化设置体系（ADR-0017）**：EPG 权重配置与多线路管理路由严格由 `SettingsGuard` 拦截，仅主管理员（`isMain === true`）可访问。
- [x] **规范五/八/九：HeroUI v3 与 图标规范**：进度条采用 `<Progress>`，线路选择器采用 `<Dropdown>`，图标统一采用 `lucide-react`。

---

## Project Structure

### Documentation (this feature)

```text
docs/specs/016-multi-source-live-epg/
├── spec.md              # 业务规格与用户故事
├── plan.md              # 本计划文档 (/speckit-plan 输出)
├── research.md          # Phase 0 技术决策与调研报告
├── data-model.md        # Phase 1 数据库与领域实体模型
├── quickstart.md        # Phase 1 端到端验证指南
├── contracts/           # Phase 1 接口与组件契约
│   ├── api.md           # HTTP 接口契约
│   └── ui-experience.md # 前端组件与交互规范
├── checklists/
│   └── requirements.md  # 规格质量核验清单
└── tasks.md             # Phase 2 实施任务分解 (后续由 /speckit-tasks 生成)
```

### Source Code (repository root)

```text
apps/server/src/
├── contexts/
│   ├── sources/                 # 来源管理：增加 EPG 源优先级权重与刷新调度
│   ├── media-catalog/           # 媒体目录：多直播源线路 (Playback Lines) 聚合
│   ├── epg/                     # EPG 上下文：别名清洗与级联匹配规则
│   ├── live-tv/                 # 直播电视：批量当前/下一档投影 (loadLiveChannelWindows)
│   ├── playback/                # 播放上下文：播放解析器多线路下发与票据签发
│   └── settings/                # 设置上下文：EPG 优先级与线路管理接口 (Admin)
└── platform/database/schema.ts  # Drizzle Schema 扩展 (media_source.priority)

apps/web/src/
├── features/
│   ├── live/
│   │   ├── components/          # 频道卡片 (Progress 进度条)、PlayerLineSwitcher (OSD换线)
│   │   ├── hooks/               # use-current-programme.ts (智能事件时钟)
│   │   └── pages/               # Screen 1~4 接入当前节目与换线交互
│   └── settings/                # EPG 源权重拖拽排序面板
└── shared/                      # 基础 UI 封装与公共状态

packages/shared/src/
├── experience-schema.d.ts       # 扩展 LiveChannelProjection、CurrentNextProgramme
└── playback-schema.d.ts         # 扩展 PlaybackLineDto
```

**Structure Decision**: 严格复用现有 Monorepo 的 DDD 限界上下文分层与 Web 功能模块结构，零跨层直连，跨模块通信遵循显式端口与发布契约。

---

## Complexity Tracking

> 经宪章核验，所有架构决策均严格继承既有已接受的 ADR-0007 / 0008 / 0010 / 0015 / 0017，无违反宪章边界或引入额外复杂模式的违规项。

| 评估项 | 决策 | 收益与取舍 |
| :--- | :--- | :--- |
| **多直播源合并** | 导入时按清洗后频道名聚合，后台保留线路管理 | 保证前台干净无重复卡片，同时保留多线路容灾能力 |
| **多 EPG 匹配** | 静态规则字典 + 优先级级联 | 比起沉重的全文搜索引擎，纯函数与内存 Map 性能更高、可预测且零外部依赖 |
| **当前节目时钟** | 单次 `setTimeout` 事件驱动推进 | 比起 5 秒轮询，节省 99% 的无效 HTTP 请求和服务端 CPU 负荷 |
