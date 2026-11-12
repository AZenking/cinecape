# Implementation Plan: 逻辑频道显隐控制与名称台标自定义编辑 (Channel Visibility & Metadata Customization)

**Branch**: `018-channel-customization` | **Date**: 2026-11-09 | **Spec**: [spec.md](file:///Volumes/Extends/DevCache/Projects/10-projects/14-epg/redRoad/docs/specs/018-channel-customization/spec.md)

**Input**: Feature specification from `docs/specs/018-channel-customization/spec.md`

---

## Summary

实现逻辑频道的精细化管理与个性化定制能力，彻底解决外部 M3U 导入后前台被全量冗余频道刷屏的问题：
1. **显隐控制**：在 `media_item` 增加 `visible` 列并在公共直播接口增加过滤，前台仅展示 `visible=1` 的精选频道；
2. **快捷开关**：在管理后台「频道资产」工作台行内集成 HeroUI `Switch`，支持一键切换上架/隐藏；
3. **名称与台标编辑**：提供 HeroUI `Modal`，支持修改频道标准名称并开启 `title_overridden=1` 防覆盖保护，支持输入自定义 Logo URL 并提供即时视觉预览。

---

## Technical Context

**Language/Version**: TypeScript 5.8, Node.js 22 LTS / 26
**Primary Dependencies**:
- 后端：NestJS 12, Drizzle ORM, SQLite (`better-sqlite3`), Vitest, Supertest
- 前端：React 19, `@heroui/react` & `@heroui/styles` v3.2.6, `@tanstack/react-query` v5, `lucide-react`
- 契约：`@hmp/shared`

**Storage**: SQLite 嵌入式数据库（WAL 模式），单表 DDL 迁移追加 `media_item.visible` 字段，保留 `household_id` 显式边界。
**Testing**: Vitest（单元测试）、Supertest（接口契约测试）、React Testing Library（组件交互测试）。
**Target Platform**: Linux / Docker 家用 NAS 环境，主流现代桌面浏览器。
**Project Type**: Monorepo 全栈媒体平台。
**Performance Goals**:
- 显隐 Switch 切换到前台列表响应生效耗时 < 300ms；
- 批量过滤隐藏频道纯 SQL 索引完成，查询耗时增长为 0。
**Constraints**:
- 严格遵循宪章原则一至七；
- HeroUI v3 组件规范：Switch、Modal、Input、Button 禁用任何原生控件；
- 统一使用 `lucide-react` 线型图标；
- 离线优先与局域网私有化。

---

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

- [x] **原则一（规格驱动与多层证据验收）**：功能规格 `018-channel-customization` 已就绪，验收条件包含单元测试、契约测试与前端交互证据。
- [x] **原则二（三层身份边界严格隔离）**：所有频道数据归属 `household_id`，个人数据隔离由 Profile 承担。
- [x] **原则三（公开浏览与服务端受控播放）**：公开浏览接口（`/live/channels`）仅输出 `visible=1` 的可用频道，隐藏频道不泄露。
- [x] **原则四（自托管 NAS 与隐私优先）**：完全本地 SQLite 存储，支持 NAS 局域网容器化运行。
- [x] **原则五（ADR 与非破坏性演进）**：继承 ADR-0007, ADR-0008, ADR-0010, ADR-0014，平滑数据库迁移（向前兼容）。
- [x] **原则六（管理设置角色差异化与免套娃授权）**：频道资产工作台受 `SettingsGuard` 保护，主 Profile 验证通过后直接畅行。
- [x] **原则七（频道中心制与物理源/EPG源彻底解耦原则）**：
  - 显隐与名称/台标均绑定于逻辑频道（`media_item`）本身，不影响底层物理线路；
  - 外部 M3U 刷新不破坏管理员的治理成果。
- [x] **技术约束 5 & 8（HeroUI v3 规范）**：全部交互组件（Switch, Modal, Button, Input）采用 HeroUI v3，无原生控件。
- [x] **技术约束 9（图标规范）**：统一使用 `lucide-react` 线型图标。

---

## Project Structure

### Documentation (this feature)

```text
docs/specs/018-channel-customization/
├── spec.md              # 功能规格说明书
├── plan.md              # 架构实施计划与设计 (本文件)
├── research.md          # 核心架构决策与技术调研 (Phase 0)
├── data-model.md        # 实体与只读投影数据模型 (Phase 1)
├── quickstart.md        # 快速验证指南与端到端测试用例 (Phase 1)
├── contracts/           # 外部与内部接口契约 (Phase 1)
│   └── admin-channel-customization-api.md
└── checklists/
    └── requirements.md  # 规格质量检查清单
```

### Source Code (repository layout)

```text
packages/shared/src/
└── catalog-schema.d.ts             # 扩展 CandidateDto 与 PatchMediaRequest

apps/server/src/
├── contexts/
│   ├── media-catalog/
│   │   ├── application/
│   │   │   └── catalog-admin.service.ts # patchMediaMetadata 支持 visible 与 logoUrl
│   │   └── infrastructure/
│   │       └── media-catalog-store.drizzle.ts
│   ├── live-tv/
│   │   └── application/
│   │       └── live-projection.service.ts # loadAvailableMediaIdSet 增加 visible=1 过滤
│   └── sources/
│       └── application/
│           └── refresh-publish.service.ts # 刷新发布保护 title_overridden 与 custom logo
└── platform/
    └── database/
        ├── schema.ts               # mediaItem 增加 visible 字段
        └── migrations/
            └── 0011_channel_visibility/

apps/web/src/
└── features/
    └── settings/
        └── settings-epg-page.tsx   # 频道资产工作台增加 Switch 开关与 Edit Modal
```

---

## Complexity Tracking

> 宪章检查无任何违宪妥协，本架构完全对齐原则一至七。

| 模块 | 复杂度决策 | 为什么需要 | 替代方案被否决原因 |
|------|------------|------------|--------------------|
| 显隐控制 | SQL 层 `media_item.visible` 过滤 | 彻底杜绝前台刷屏并保证接口分页数据一致性 | 前端纯状态过滤会导致分页和网络泄露漏洞 |
| 防覆盖 | `title_overridden` 与 `custom` 台标锁 | 保护管理员劳动成果不受外部订阅源拉取冲刷 | 每次刷新强刷会导致用户命名与好台标反复丢失 |
