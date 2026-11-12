# Verification Evidence: 013-role-differentiated-settings

**Feature**: `013-role-differentiated-settings`
**Date**: 2026-11-02
**Status**: Verified

## 1. 验证目标与质量门禁

本次落地旨在重构系统设置体验：
- **方案 A（Strict Clean 模式）**：普通成员与儿童 Profile 侧栏仅呈现纯净的【个人设置】（播放体验、界面外观、我的档案），家庭管理与系统安全分类彻底不渲染；
- **单一身份切换入口**：侧栏底部彻底移除任何冗余提权提示，统一由右上角头像菜单输入 PIN 切换；
- **免二次验 PIN 畅行**：主管理员进入设置及执行常规管理配置（媒体源增删改、EPG 刷新、分级名单维护、家庭时区），零弹窗二次索要 PIN 或密码；
- **不可逆高危操作底线**：仅在修改管理员主账号密码、注销关键档案时弹出单次密码确认；
- **端到端纵深安全**：深链接前端 `AdminRouteGuard` 拦截并平滑重定向，后端 `SettingsGuard` 403 严格兜底。

---

## 2. 证据层级汇总

### 2.1 静态检查与类型安全 (Static Layer)
- **TypeScript 编译**：
  - `pnpm --filter @hmp/shared build`: 0 错误
  - `pnpm --filter @hmp/server typecheck`: 0 错误
  - `pnpm --filter @hmp/web typecheck`: 0 错误
- **代码规范 (ESLint)**：
  - `pnpm lint`: 全仓 0 错误，0 警告通过。

### 2.2 自动化测试层级 (Test & Contract Layer)

#### 前端设置模块测试 (`apps/web/test/settings/`)
- `admin-route-guard.spec.tsx` (6/6 passed): 验证非管理员深链接阻断、Toast 提示及平滑重定向至 `/settings/playback`。
- `admin-seamless-settings.spec.tsx` (5/5 passed): 验证主管理员进入设置页面无遮罩门禁阻拦，常规操作零二次 PIN 弹窗。
- `personal-preferences.spec.tsx` (2/2 passed): 验证普通成员读取与保存字幕、音轨、自动连播与外观深浅模式，数据绑定 `profile_id`。
- `settings-nav-filter.spec.ts` (4/4 passed): 验证侧栏菜单根据 `isMainProfile` 精准过滤，普通模式 0 泄漏管理模块。
- `settings-sidebar-clean.spec.tsx` (3/3 passed): 验证侧栏底部无多余提权按钮或锁状态，视觉保持纯粹。
- `settings-deep-link-guard.spec.tsx` (3/3 passed): 覆盖所有受限管理路由的深链接拦截与恢复。
- `sensitive-action-password.spec.tsx` (8/8 passed): 验证修改管理员密码必须携带当前旧密码且单次校验通过，注销档案触发弹窗确认。

*前端设置测试汇总：7 files / 31 passed (100% 绿灯)*

#### 后端设置模块测试 (`apps/server/`)
- `apps/server/test/unit/settings/settings-guard.spec.ts` (12/12 passed): 验证 `SettingsGuard` 基于 `session.activeProfile.isMain === 1` 放行主管理员，免除 `X-Settings-Grant-Token` 临时 Ticket 依赖。
- `apps/server/test/contract/settings-no-ticket.e2e-spec.ts` (10/10 passed): 契约验证主管理员直调管理接口在无 Ticket/伪造 Ticket 下依然 200 放行。
- `apps/server/test/contract/settings-guard-negative.e2e-spec.ts` (10/10 passed): 契约验证普通成员、儿童档案、未选档会话直调管理接口被严格 403 (FORBIDDEN) 拦截。
- `apps/server/test/unit/settings/` (33/33 passed): 既有设置单元测试全量兼容回归通过。

*后端设置测试汇总：7 files / 65 passed (100% 绿灯)*

---

## 3. quickstart.md 验证场景走查记录

| 验证场景 | 对应测试 | 走查结果 |
| :--- | :--- | :--- |
| **场景一：普通成员的纯净个人偏好视图** | `settings-nav-filter.spec.ts`, `personal-preferences.spec.tsx` | **PASS**: 侧栏仅展示播放体验、外观、我的档案，无任何管理项与锁提示，表单就地保存 |
| **场景二：深链接越权拦截与友好提示** | `admin-route-guard.spec.tsx`, `settings-deep-link-guard.spec.tsx` | **PASS**: 手输 `/settings/sources` 自动重定向至 `/settings/playback`，Toast 提示“该页面需要管理员权限” |
| **场景三：管理员一次验 PIN 畅行全场** | `admin-seamless-settings.spec.tsx`, `settings-no-ticket.e2e-spec.ts` | **PASS**: 切换管理员时输入 1 次 PIN，进入设置后添加媒体源、编辑 EPG 零弹窗二次索要 PIN |
| **场景四：高危破坏性操作单次密码确认** | `sensitive-action-password.spec.tsx` | **PASS**: 修改管理员密码强制校验 `currentPassword`，注销档案弹窗二次确认 |

---

## 4. 架构决策记录 (ADR)
- 已归档正式架构决策记录 **[ADR-0017: 角色差异化设置体系与免套娃授权演进](../../adr/0017-role-differentiated-settings.md)**，正式宣布替代 **ADR-0011** 中关于设置二次 PIN 临时 Ticket 的历史决策。
