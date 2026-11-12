# Implementation Plan: 角色差异化设置体系 (Role-Differentiated Settings)

**Branch**: `013-role-differentiated-settings` | **Date**: 2026-11-02 | **Spec**: [docs/specs/013-role-differentiated-settings/spec.md](./spec.md)

**Input**: Feature specification from `docs/specs/013-role-differentiated-settings/spec.md`

## Summary

本特性旨在彻底重构 Home Media Platform 的“设置”体验：
1. **方案 A 隐藏式菜单**：基于当前会话的 `activeProfile.isMain`，普通成员设置侧栏彻底隐藏全部家庭管理与系统安全模块，仅暴露纯净的【个人设置】（播放偏好、界面外观、我的档案）；
2. **单一身份切换入口**：移除侧栏底部所有冗余的提权按钮，统一切换收敛于右上角头像菜单；
3. **消除重复 PIN 阻断**：主管理员在切换 Profile 时验过 1 次 PIN 码后，进入设置即可畅行全部常规管理配置，废除独立的“设置 PIN”与 15 分钟临时 Ticket，仅在修改密码等不可逆高危操作上保留单次密码确认；
4. **端到端纵深安全**：前端路由守卫拦截深链接重定向，后端 `SettingsGuard` 继续严格校验 `activeProfile.isMain`。

## Technical Context

**Language/Version**: TypeScript 5.8 / Node.js 22 LTS  
**Primary Dependencies**: React 19, Vite, TailwindCSS v4, HeroUI v3, TanStack Query v5, NestJS 11, Drizzle ORM  
**Storage**: SQLite 3 (通过 Drizzle ORM 操作 `profile` 及相关设置表)  
**Testing**: Vitest (单元与契约测试), Playwright (E2E 走查)  
**Target Platform**: Linux (家用自托管 NAS / Docker 环境) & 现代桌面/移动浏览器  
**Project Type**: Monorepo Web Application (Full-Stack)  
**Performance Goals**: 菜单角色切换响应延迟 < 50ms，偏好本地保存延迟 < 100ms  
**Constraints**: 遵循项目宪章原则二（三层身份边界不妥协）及原则三（默认安全的服务端鉴权）  
**Scale/Scope**: 重构前端 `apps/web/src/features/settings` 侧栏导航与路由守卫，简化后端 `apps/server/src/contexts/settings` 鉴权门禁并移除冗余 Ticket 机制。

## Constitution Check

*GATE: Passed before Phase 0 research. Re-checked after Phase 1 design.*

- [x] **原则一：规格驱动与多层证据验收**：规格 `013-role-differentiated-settings/spec.md` 已建立并通过质量审查，配套契约设计与走查指南已完备。
- [x] **原则二：三层身份与数据边界隔离**：个人偏好（默认字幕/音轨/自动连播）严格绑定 `profile_id`，家庭资源（源/EPG/策略）严格绑定 `household_id`，绝不混淆。
- [x] **原则三：默认安全的服务端鉴权**：移除前端重复输 PIN 并未降低后端安全门禁，所有管理写操作依然由服务端 `SettingsGuard` 强校验 `activeProfile.isMain`。
- [x] **原则四：自托管 NAS 与隐私优先**：纯本地运行，不引入任何外部云端遥测与认证依赖。
- [x] **原则五：ADR 演进记录**：伴随本特性的落地，将提交 ADR-0017 形式化替代 ADR-0011 中的过时套娃决策，不静默破坏历史记录。

## Project Structure

### Documentation (this feature)

```text
docs/specs/013-role-differentiated-settings/
├── spec.md              # 需求规格说明书
├── checklists/
│   └── requirements.md  # 规格质量审查清单 (Pass)
├── plan.md              # 架构与实施计划 (本文件)
├── research.md          # 核心架构与决策研究
├── data-model.md        # 实体与状态流转模型
├── contracts/
│   └── settings-contracts.md # 前端导航与 API 接口契约
└── quickstart.md        # 快速验证走查指南
```

### Source Code Layout & Changes

```text
apps/web/src/features/settings/
├── settings-modules.tsx         # [重构] 增加 scope 声明，实现基于 isMainProfile 的动态菜单过滤
├── settings-access-provider.tsx # [精简] 废除 15分钟 Ticket 轮询与复杂的锁状态，简化为基于 session 的轻量上下文
├── settings-unlock-gate.tsx     # [废除/精简] 移除常规管理页面的门禁包裹
├── components/
│   └── AdminRouteGuard.tsx      # [新增] 针对深链接越权的前端路由守卫
├── settings-playback-page.tsx   # [新增/调整] 个人播放体验设置页 (字幕/音轨/自动连播)
├── settings-appearance-page.tsx # [新增/调整] 个人外观设置页 (主题模式)
├── layouts/
│   └── SettingsLayout.tsx       # [重构] 侧栏彻底移除底部提权按钮，接入角色过滤菜单

apps/server/src/contexts/settings/
├── infrastructure/
│   └── settings.guard.ts        # [精简优化] 直接核验 session.activeProfile.isMain，移除对 X-Settings-Grant-Token 的硬性依赖
└── interface/
    └── settings-unlock.controller.ts # [废止或保留向后兼容]
```
