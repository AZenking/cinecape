# Implementation Plan: 频道中心制与物理流/EPG源彻底解耦架构 (Channel-Centric Architecture)

**Branch**: `017-channel-centric-architecture` | **Date**: 2026-11-09 | **Spec**: [spec.md](file:///Volumes/Extends/DevCache/Projects/10-projects/14-epg/redRoad/docs/specs/017-channel-centric-architecture/spec.md)

**Input**: Feature specification from `docs/specs/017-channel-centric-architecture/spec.md`

---

## Summary

构建以**逻辑频道（Logical Channel）为唯一核心实体**的端到端直播与电子节目单架构。彻底解耦上层业务（大厅、指南、播放器、管理后台）与底层物理流/EPG 来源：
1. **多流汇聚**：同一频道的多个物理直播流自动汇聚为单频道的播放线路（Playback Lines），提供清晰度加权分级与默认线路选择；
2. **多 EPG 级联**：多 EPG 源构建全局节目单池，频道通过确定性五级级联阶梯（手动锁定 > 精确 tvg-id > 源权重优先 > 频道别名归一 > 兜底降级）获取当前/下一节目与实时进度条；
3. **后台重塑**：彻底移除“直播源 1:1 关联 EPG 源”的残余逻辑，建立以逻辑频道资产为中心的管理工作台（Channel Workbench），支持单频道线路查看与跨源任意 EPG 弹窗锁定；
4. **播放容灾**：播放器集成线路切换菜单与基于 `PlaybackFailoverCoordinator` 的网络断流 5 秒自动容灾。

---

## Technical Context

**Language/Version**: TypeScript 5.8, Node.js 22 LTS / 26
**Primary Dependencies**:
- 后端：NestJS 12, Drizzle ORM, SQLite (`better-sqlite3`), Vitest, Supertest
- 前端：React 19, `@heroui/react` & `@heroui/styles` v3.2.6, `@tanstack/react-query` v5, `lucide-react`
- 契约：`@hmp/shared`

**Storage**: SQLite 嵌入式数据库（WAL 模式），保留 `household_id` 显式边界，基于 Drizzle ORM 严格事务保证。
**Testing**: Vitest（单元测试 + 领域纯函数测试）、Supertest（接口契约测试）、React Testing Library（组件交互测试）。
**Target Platform**: Linux / Docker 家用 NAS 环境，主流现代桌面浏览器。
**Project Type**: Monorepo 全栈媒体平台（DDD 分层后端 + SPA 前端）。
**Performance Goals**:
- EPG 级联内存裁决耗时 < 50ms（防 N+1，批量加载后纯函数计算）；
- 直播大厅当前节目与进度条渲染首屏响应 < 200ms；
- 播放器单线路断流自动切换并恢复播放耗时 < 5s。
**Constraints**:
- 严格遵循宪章原则一至七，特别是新增的核心原则七；
- HeroUI v3 组件规范：禁用一切浏览器原生 `<select>`, `<dialog>` 等原生控件；
- 图标规范：统一使用 `lucide-react` 线型图标；
- 离线优先与局域网私有化，绝不引入外部云端遥测与非授权外连。
**Scale/Scope**: 单家庭私有部署，支持管理约 500~2000 个逻辑频道，数万条 EPG 时序节目条目。

---

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

- [x] **原则一（规格驱动与多层证据验收）**：功能规格 `017-channel-centric-architecture` 已就绪，验收条件包含单元测试、契约测试与前端交互证据。
- [x] **原则二（三层身份边界严格隔离）**：所有频道数据归属 `household_id`，个人收藏与观看进度归属 `profile_id`，绝无跨身份泄漏。
- [x] **原则三（公开浏览与服务端受控播放）**：公开浏览仅下发逻辑频道元数据与节目单，播放资源经 `Playback Resolver` 强校验 `ProfilePolicy`，严禁匿名泄露流凭据。
- [x] **原则四（自托管 NAS 与隐私优先）**：完全本地 SQLite 存储，支持 NAS 局域网容器化运行。
- [x] **原则五（ADR 与非破坏性演进）**：继承 ADR-0007, ADR-0008, ADR-0010, ADR-0017，废弃旧有 1:1 源匹配设计，无破坏性破坏旧数据。
- [x] **原则六（管理设置角色差异化与免套娃授权）**：频道资产工作台受 `SettingsGuard` 保护，主 Profile 验证通过后直接畅行。
- [x] **原则七（频道中心制与物理源/EPG源彻底解耦原则）**：
  - 页面仅与逻辑频道交互；
  - 物理流归集为播放线路；
  - 多 EPG 确定性级联匹配；
  - 设置后台以频道为资产管理中心，彻底废除源到源 1:1 映射。
- [x] **技术约束 5 & 8（HeroUI v3 规范）**：全部交互组件（Select, Modal, Button, Chip, Input）采用 HeroUI v3，无原生控件。
- [x] **技术约束 9（图标规范）**：统一使用 `lucide-react` 线型图标。

---

## Project Structure

### Documentation (this feature)

```text
docs/specs/017-channel-centric-architecture/
├── spec.md              # 功能规格说明书
├── plan.md              # 架构实施计划与设计 (本文件)
├── research.md          # 核心架构决策与技术调研 (Phase 0)
├── data-model.md        # 实体与只读投影数据模型 (Phase 1)
├── quickstart.md        # 快速验证指南与端到端测试用例 (Phase 1)
├── contracts/           # 外部与内部接口契约 (Phase 1)
│   ├── channel-api.md
│   └── admin-workbench-api.md
└── checklists/
    └── requirements.md  # 规格质量检查清单
```

### Source Code (repository layout)

```text
packages/shared/src/
└── contracts/
    ├── catalog.ts                  # 逻辑频道与线路类型契约
    ├── live-tv.ts                  # 直播大厅与级联 EPG 契约
    └── settings.ts                 # 频道资产工作台 DTO 契约

apps/server/src/
├── contexts/
│   ├── media-catalog/              # 媒体目录限界上下文: 逻辑频道管理
│   │   ├── application/
│   │   ├── domain/
│   │   └── infrastructure/
│   ├── sources/                    # 外部源导入上下文: M3U/XMLTV 解析与多流聚合
│   │   ├── application/
│   │   │   └── refresh-publish.service.ts
│   │   └── infrastructure/
│   │       └── m3u.parser.ts
│   ├── epg/                        # EPG 上下文: 级联匹配与手动绑定
│   │   ├── application/
│   │   │   ├── cascading-epg-resolution.service.ts
│   │   │   └── manual-epg-binding.service.ts
│   │   └── infrastructure/
│   ├── live-tv/                    # 直播呈现上下文: 大厅投影与频道时钟计算
│   │   ├── application/
│   │   │   └── live-projection.service.ts
│   │   └── interface/
│   │       └── live.controller.ts
│   ├── playback/                   # 播放解析上下文: 线路下发与受控鉴权
│   │   ├── application/
│   │   │   └── playback-resolver.service.ts
│   │   └── interface/
│   │       └── playback.controller.ts
│   └── settings/                   # 管理设置上下文: 频道资产工作台端点
│       └── interface/
│           └── settings-epg.controller.ts
└── platform/
    └── database/schema.ts

apps/web/src/
├── features/
│   ├── live/                       # 客户端直播功能模块
│   │   ├── components/
│   │   │   ├── PlayerLineSwitcher.tsx   # 播放器多线路切换面板
│   │   │   └── LiveHeroPlayer.tsx       # 播放器断流自动 Failover 协调器
│   │   ├── hooks/
│   │   │   └── use-current-programme.ts # 频道时钟与实时进度条 Hook
│   │   └── pages/
│   └── settings/                   # 管理后台设置模块
│       ├── settings-iptv-page.tsx       # IPTV/EPG 标签容器 (统一频道资产)
│       ├── settings-epg-page.tsx        # 频道资产工作台 (重构后的核心表格与Modal)
│       └── settings-epg-priorities.tsx  # 多 EPG 优先级配置区块
```

**Structure Decision**: 采用 Monorepo + 严格 DDD 分层。后端上下文向内依赖，前端 feature-first 组织，公用类型统一在 `@hmp/shared` 共享。

---

## Complexity Tracking

> 宪章检查无任何违宪妥协，本架构完全对齐原则一至七。

| 模块 | 复杂度决策 | 为什么需要 | 替代方案被否决原因 |
|------|------------|------------|--------------------|
| 多流聚合 | 导入时按清洗键自动归集为 `media_item` 的 `playback_source` | 保证全系统频道实体唯一性，彻底根绝列表重复频道 | 前端虚拟聚合会导致分页与权限状态割裂 |
| EPG 级联 | 批量装载索引 + 内存纯函数无 N+1 裁决 | 保证高并发与复杂多源下毫秒级响应 | 逐频道实时 SQL 查询数据库在频道多时会造成严重慢查 |
| 频道工作台 | HeroUI Modal 跨所有源自由搜索绑定 | 赋予管理员直观治理能力，废除扭曲的源对源对齐 | 旧有 1:1 直播源关联无法处理多源合并与共享 EPG 场景 |
