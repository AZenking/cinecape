# Data Model: 角色差异化设置体系

**Feature**: `013-role-differentiated-settings`
**Date**: 2026-11-02

## 1. 实体定义与字段扩展

### 1.1 设置模块导航元数据 (SettingsNavigationModule)
纯前端运行时的导航结构，声明模块的归属作用域：

```typescript
export type SettingsScope = 'personal' | 'household_admin' | 'system_admin';

export interface SettingsNavModule {
  readonly id: string;
  readonly path: string;
  readonly title: string;
  readonly scope: SettingsScope;
  readonly iconName?: string;
  readonly description?: string;
}

export interface SettingsNavGroup {
  readonly key: string;
  readonly label: string;
  readonly scope: SettingsScope;
  readonly modules: readonly SettingsNavModule[];
}
```

#### 模块清单与作用域划分：
1. **个人设置分组 (`scope: 'personal'`)**：
   - `playback`: 播放体验（默认音轨/字幕、自动连播）➔ 对应路由 `/settings/playback`
   - `appearance`: 界面外观（主题深浅色、海报尺寸）➔ 对应路由 `/settings/appearance`
   - `profile`: 我的档案（头像、昵称、个人 PIN）➔ 对应路由 `/settings/profile`
2. **家庭管理分组 (`scope: 'household_admin'`)**：
   - `sources`: 媒体来源（NAS、M3U 直播、在线 VOD）➔ 对应路由 `/settings/sources`
   - `epg`: 电视与节目单（频道映射、XMLTV 同步）➔ 对应路由 `/settings/epg`
   - `profiles`: 档案与分级（家庭成员增删、分级限制）➔ 对应路由 `/settings/profiles`
   - `devices`: 设备管理（活动设备列表、下线设备）➔ 对应路由 `/settings/devices`
   - `general`: 通用设置（家庭名称、家庭时区）➔ 对应路由 `/settings/general`
3. **系统与安全分组 (`scope: 'system_admin'`)**：
   - `account`: 账号与安全（修改主管理员密码、系统备份与存储状态）➔ 对应路由 `/settings/account`

---

### 1.2 个人偏好数据模型 (PersonalPreferences)
严格绑定在 `profile_id` 上的偏好存储结构：

```typescript
export interface ProfilePreferences {
  readonly defaultAudioLanguage: string;     // e.g. "zh", "en", "original"
  readonly defaultSubtitleLanguage: string;  // e.g. "zh", "none"
  readonly autoPlayNext: boolean;            // true | false
  readonly themeMode: 'system' | 'dark' | 'light';
  readonly posterDensity: 'comfortable' | 'compact';
}
```

*存储落点*：扩展 `profile` 表中的 `preferences` JSON 字段，或通过现有的个人偏好存储端口读写。

---

## 2. 状态流转模型

### 2.1 菜单过滤状态机 (Menu Visibility State)

```text
[用户打开设置]
       │
       ▼
[读取当前 Session 中的 activeProfile]
       │
       ├── isMain === false (普通成员/儿童)
       │      │
       │      ▼
       │   仅提取 scope === 'personal' 的分组
       │   渲染简洁侧栏 (播放体验 / 界面外观 / 我的档案)
       │
       └── isMain === true (主管理员已完成选档 PIN 验证)
              │
              ▼
           提取全部 groups (个人设置 + 家庭管理 + 系统安全)
           渲染全量侧栏并默认高亮上次或首个模块
```

### 2.2 路由守卫拦截状态流转 (Route Guard Transition)

```text
[用户请求目标路由: /settings/:module]
       │
       ▼
[查询该 module 的 scope]
       │
       ├── scope === 'personal' ──► 放行渲染页面
       │
       └── scope !== 'personal'
              │
              ├── 当前 activeProfile.isMain === true ──► 放行渲染页面
              │
              └── 当前 activeProfile.isMain !== true ──► 拦截！
                     │
                     ▼
                  平滑重定向至 `/settings/playback`
                  触发轻提示: "该配置项需要主管理员权限"
```
