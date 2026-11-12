# Interface Contracts: 角色差异化设置体系

**Feature**: `013-role-differentiated-settings`
**Date**: 2026-11-02

## 1. 前端组件与导航契约

### 1.1 导航配置接口 (`settings-nav.contract.ts`)

```typescript
export interface NavGroupVisibilityInput {
  readonly isMainProfile: boolean;
  readonly isChild: boolean;
}

/**
 * 依据当前 Profile 计算可见菜单分组
 */
export function getVisibleSettingsGroups(input: NavGroupVisibilityInput): readonly SettingsNavGroup[];
```

### 1.2 路由守卫高阶组件 (`AdminRouteGuard.tsx`)

```typescript
export interface AdminRouteGuardProps {
  readonly children: ReactNode;
  readonly fallbackPath?: string; // 默认 '/settings/playback'
}
```
- **行为契约**：如果 `session.activeProfile?.isMain !== true`，阻止 children 挂载，通过 `useNavigate` 重定向至 `fallbackPath`。

---

## 2. HTTP API 契约（保持并精简后端防护）

### 2.1 个人偏好接口 (`/api/profile/preferences`)

- **GET `/api/profile/preferences`**
  - **鉴权**：有效 Session（含任意已选 Profile）
  - **响应 (200 OK)**：
    ```json
    {
      "defaultAudioLanguage": "zh",
      "defaultSubtitleLanguage": "zh",
      "autoPlayNext": true,
      "themeMode": "system",
      "posterDensity": "comfortable"
    }
    ```

- **PUT `/api/profile/preferences`**
  - **鉴权**：有效 Session（含任意已选 Profile；个人偏好零 PIN/密码/临时 Ticket，ADR-0017）
  - **请求体（合并语义）**：全部字段可选、至少一项；仅提交要修改的字段，
    未提交字段保留现值/默认值 —— 播放体验页与界面外观页各自提交子集互不覆盖。
    未知字段或空 body 一律 400。
    ```json
    {
      "defaultAudioLanguage": "zh",
      "defaultSubtitleLanguage": "none",
      "autoPlayNext": false,
      "themeMode": "dark"
    }
    ```
  - **响应 (200 OK)**：更新后的**完整**偏好对象（含未提交字段的现值）。
  - **实现落点**：`personal-data` 上下文 `ProfilePreferencesController`
    （GET/PUT 经 SessionGuard→CurrentProfileGuard 推导身份；存储 `profile_preferences` 表，
    迁移 `0008_profile_preferences`）。

---

### 2.2 家庭管理接口鉴权演进说明
所有 `/api/settings/*`（媒体源、EPG 映射、分级策略配置等）：
- **移除要求**：请求头不再强制要求传入 `X-Settings-Grant-Token`（即废弃独立 15 分钟临时 Ticket）。
- **保留要求**：服务端 `SettingsGuard` 直接校验当前会话关联的 `activeProfile.isMain === 1`。只要是主管理员会话，接口一律直接放行。
- **高危操作接口**（如 `POST /api/settings/account/password`）：
  - 请求体必须包含 `{ currentPassword: "..." }` 进行单次校验；
  - 校验失败返回 `401 / 403` Problem Detail（`PASSWORD_INVALID`）。
