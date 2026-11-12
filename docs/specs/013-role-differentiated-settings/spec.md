# Feature Specification: 角色差异化设置体系 (Role-Differentiated Settings)

**Feature Branch**: `013-role-differentiated-settings`

**Created**: 2026-11-02

**Status**: Verified

**Governance**: 遵循 `.specify/memory/constitution.md` 核心原则二（三层身份边界严格隔离）与原则五（ADR 演进）；已创建并在项目中被接受 ADR-0017 替代 ADR-0011 中的门禁套娃部分。

**Related ADRs**: 
- [ADR-0001: Household/Account/Profile 三层身份模型](../../adr/0001-household-account-profile.md)
- [ADR-0006: 敏感写操作逐次密码验证](../../adr/0006-profile-policy-authorization.md)
- [ADR-0011: 主 Profile 与设置访问授权（被本规范演进与替代）](../../adr/0011-main-profile-settings-access.md)
- [ADR-0012: 档案恢复存储隔离](../../adr/0012-profile-resume-fresh-storage.md)

**Input**: User description: "按照我们讨论的结果；重新设计设置：采用方案 A（隐藏式/Strict Clean 模式），实现普通用户与管理员设置菜单彻底差异化；移除侧栏底部多余切换提示，统一由右上角头像菜单输入 PIN 切换档案；消除多次重复输入 PIN 的繁琐体验，实现主管理员一次验 PIN 畅行全场，仅在不可逆高危操作二次验证密码。"

## User Scenarios & Testing *(mandatory)*

### User Story 1 - 普通成员直观且无干扰的“个人偏好”设置 (Priority: P1)

作为家庭中的普通成员（例如儿童、老人或只想简单看剧的家人），我点开设置时，看到的是纯粹、干净的个人偏好页面，没有任何家庭资产配置项，也没有任何锁门禁和多余提示，我可以随手调整自己的播放习惯和外观。

**Why this priority**: 解决普通用户被大量系统管理术语（M3U、XMLTV、NAS 路径、IP 白名单）轰炸和频遭密码弹窗阻断的核心体验痛点，实现真正的家庭视听产品易用性。

**Independent Test**: 以普通（非主管理员）Profile 登录系统，点击设置，验证侧栏仅呈现“个人偏好”相关分类（播放习惯、界面外观、我的档案），无任何带锁提示、无家庭管理栏目，且所有表单直接就地保存生效。

**Acceptance Scenarios**:

1. **Given** 当前登录的是普通成人或儿童 Profile，**When** 用户点击导航栏中的“设置”，**Then** 界面进入设置布局，侧栏菜单**仅展示**【个人设置】（包含：播放体验、界面外观、我的档案），不渲染任何媒体源、EPG、分级策略或系统设备配置项。
2. **Given** 普通成员在设置中修改“默认字幕语言”或“自动连播”开关，**When** 用户切换选项并提交，**Then** 配置直接绑定至当前 `profile_id` 并立即生效，过程中无需输入任何 PIN 码或密码。
3. **Given** 普通成员在【我的档案】中查看个人信息，**When** 用户修改自己的昵称或头像，**Then** 本地档案成功更新，不影响其他家庭成员。

---

### User Story 2 - 管理员一次验 PIN 切换，畅行全部家庭管理 (Priority: P1)

作为家庭主管理员，当我想管理家庭媒体资源时，我只需在右上角头像菜单中选择主管理员 Profile 并输入一次 6 位 PIN 码；切换成功后，设置页面自动平滑展开全部家庭管理模块，我添加源、刷 EPG、配策略全流程顺畅无阻，不再被反复索要 PIN。

**Why this priority**: 彻底消除“选档验一次 PIN、进设置又验一次 PIN、改配置再被拦截”的套娃验证痛点，在保障安全的前提下给管理员极致流畅的运维体验。

**Independent Test**: 在普通 Profile 状态下通过头像菜单切换至管理员 Profile（输入 PIN），成功后打开设置，验证侧栏立即展示完整的家庭与系统管理菜单，且进行常规添加媒体源、编辑 EPG 映射等操作均零弹窗即时生效。

**Acceptance Scenarios**:

1. **Given** 用户在右上角头像菜单中选择管理员 Profile，**When** 输入正确的 6 位 Profile PIN，**Then** 会话成功切换至管理员 Profile（`activeProfileId` 为主管理员），设置侧栏立即呈现【家庭管理】（媒体来源、电视与节目单、家庭成员与策略、设备管理）及【系统与安全】分组。
2. **Given** 当前已处于管理员 Profile 下，**When** 用户在设置中进行添加 NAS 目录、输入直播源 URL、刷新节目单或调整分级策略，**Then** 系统直接保存并执行，全程不再弹出“解锁门禁”或“设置 PIN”输入框。
3. **Given** 管理员在设置中停留操作超过 15 分钟但仍保持活动交互，**When** 进行常规设置修改，**Then** 表单正常提交保存，不发生“15 分钟强制过期锁死并卸载草稿”的情况。

---

### User Story 3 - 统一头像切换与侧栏纯粹性 (Priority: P2)

作为任何角色的用户，设置侧栏底部不呈现任何多余的“切换管理员”按钮或提示信息，系统的身份切换保持唯一收敛在全局头像菜单中，界面保持彻底的专业克制感。

**Why this priority**: 遵循单一职责设计原则（Single Source of Truth），避免在侧栏增加冗余的内联提权逻辑和破坏界面的纯粹性。

**Independent Test**: 检查各尺寸屏幕下的设置侧栏底部，确认无多余的辅助文字或提权按钮；验证所有身份切换行为均能通过右上角头像菜单顺畅完成。

**Acceptance Scenarios**:

1. **Given** 普通成员或儿童处于设置界面中，**When** 滚动浏览侧栏底部，**Then** 侧栏底部干净利落，不存在任何诸如“切换至管理员以管理家庭”的提示或链接。
2. **Given** 用户希望从普通用户切换为管理员，**When** 用户点击导航栏右上角的头像打开身份菜单，**Then** 身份菜单正常展示家庭成员列表，点击管理员即可触发既有的标准 PIN 输入流程。

---

### User Story 4 - 针对高危资产破坏操作的单次密码底线防御 (Priority: P2)

作为家庭媒体所有者，为了防止设备未锁屏时同住人意外修改管理员密码或删除核心档案，系统在发生真正具有破坏性、不可逆的高危操作时，执行单次主账号密码安全确认。

**Why this priority**: 守住家庭系统安全底线，遵循 ADR-0006，平衡“免打扰”与“防重大破坏”。

**Independent Test**: 触发修改管理员账号密码或删除家庭成员，验证系统弹出单次凭据确认框，输入正确主密码后同事务原子完成，不留冗余长期缓存。

**Acceptance Scenarios**:

1. **Given** 管理员处于【系统与安全】或【家庭成员】页面，**When** 执行“修改管理员密码”或“删除/注销主档案”，**Then** 系统弹出凭据确认模态框，要求输入当次主账号登录密码。
2. **Given** 输入正确的当次密码，**When** 用户确认提交，**Then** 系统执行高危变更，并在变更生效后撤销受影响的旧会话。

---

### User Story 5 - 非法深链接防越权与优雅重定向 (Priority: P3)

作为普通成员，如果不小心或故意在浏览器地址栏手动输入管理页面的深链接（例如直接访问 `/settings/sources` 或 `/settings/policy`），系统能优雅拦截并引导，不出现白屏、死锁或暴露敏感结构。

**Why this priority**: 保证前端路由与后端 API 的严格纵深安全防御，杜绝基于 URL 探测的越权漏洞。

**Independent Test**: 以普通 Profile 身份在浏览器地址栏直接请求 `/settings/sources`，验证系统不渲染该页面并重定向至个人偏好页，后端对相应接口同样返回 403。

**Acceptance Scenarios**:

1. **Given** 当前为普通成员会话，**When** 用户直接在地址栏请求 `/settings/sources`，**Then** 前端路由守卫拦截该请求，并平滑重定向至 `/settings/preferences`（个人偏好页），可选配友好 Toast 提示“该页面需要管理员身份”。
2. **Given** 恶意客户端伪造或直接请求后端管理接口 `GET /api/settings/sources`，**When** 当前会话的 activeProfile 非主管理员，**Then** 后端 `SettingsGuard` 直接返回 RFC 7807 格式的 403 Forbidden 响应，不泄漏任何内部配置详情。

---

### Edge Cases

- **未设置主 Profile 的初始状态（冷启动 Bootstrap）**：全新安装首次启动时，家庭尚无任何 Profile，系统引导走初始创建向导（通过主账号密码建立第一个主管理员 Profile），避免菜单无主管理员的死锁。
- **管理员切回普通 Profile 时的状态清理**：当管理员在头像菜单中主动切换为普通成员时，设置页当前如果停留在媒体源等管理子路由上，系统自动迁移重定向至 `/settings/preferences`，防止页面残留已加载的敏感管理字段。
- **草稿保护**：管理员正在配置复杂的媒体源 URL 或网络参数时，若因网络波动，表单内容暂存在组件或本地草稿中，不因界面失焦或偶发错误清空输入内容。

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: 系统 **MUST** 基于当前会话的 `activeProfile.isMain` 属性实现设置菜单的动态过滤渲染：非主 Profile 仅呈现个人偏好分类，主 Profile 呈现个人偏好、家庭管理与系统安全全量分类。
- **FR-002**: 系统 **MUST** 移除原先进入设置时的独立“设置 PIN 码”二次门禁；只要当前处于已完成验 PIN 认证的主管理员 Profile 下，进入设置即获得管理访问权限。
- **FR-003**: 系统 **MUST** 保持所有身份切换行为唯一收敛于全局头像菜单（Identity Menu），设置侧栏底部 **MUST NOT** 呈现冗余的切换管理员提示或内联提权控件。
- **FR-004**: 系统 **MUST** 移除进入各个子管理页面时的 `SettingsUnlockGate` 阻断层；常规管理配置（添加/删除媒体源、触发 EPG 抓取、调整分级策略、修改家庭通用信息）在主管理员身份下直接提交并生效，零弹窗索要凭据。
- **FR-005**: 系统 **MUST** 仅在执行不可逆的高危操作（修改管理员主密码、重置主档案 PIN、注销档案）时，要求输入单次当前主账号密码进行原子确认。
- **FR-006**: 前端路由 **MUST** 具备声明式权限守卫（`AdminRouteGuard`）；当非管理员访问 `/settings/sources`、`/settings/policy` 等受保护管理路由时，强制拦截并立即平滑重定向至安全页面（`/settings/playback`），同时弹出轻量 Toast 提示“该页面需要管理员权限”，严禁就地弹提权或暴露白屏。
- **FR-007**: 服务端 **MUST** 继续保留坚固的安全门禁（`SettingsGuard`），严格核验设备会话中的 `activeProfileId` 是否具备主管理员资质，杜绝前端绕过风险。
- **FR-008**: 个人偏好模块 **MUST** 支持保存当前 Profile 专属的播放配置（如默认音轨、默认字幕、自动连播）与界面主题，数据严格隔离在 `profile_id` 作用域内。
- **FR-009**: 针对儿童 Profile（`type === 'child'`），个人设置页面 **MUST** 启用双重隔离保护：界面仅支持查看个人偏好，不可任意修改核心观影分级相关配置；对于仅在当前设备/浏览器生效的外观偏好（如海报密度），界面 **MUST** 在字段旁清晰弱提示标注“（仅当前设备有效）”。

### Clarified Decisions *(from clarify workflow)*

1. **管理深链接拦截行为**：确认直接重定向至 `/settings/playback`，并弹 Toast“该页面需要管理员权限”，不在当前路由弹管理员提权 PIN。
2. **儿童 Profile 权限收敛**：未成年模式下仅允许查看当前偏好（或受限调整基础视听），绝不允许修改为成人专属分级偏好。
3. **设备特有偏好范围透明化**：涉及仅本地设备/浏览器生效的项目，以弱提示文本（如“仅当前设备有效”）清晰告知用户，不弹打断式弹窗。

### Key Entities *(include if feature involves data)*

- **Profile**: 档案实体。关键属性包括 `id`、`name`、`isMain`（是否为主管理员）、`type`（adult / child）、`pinHash`。
- **PersonalPreferences**: 个人偏好实体（或 Profile 上的偏好字段）。关键属性包括 `defaultAudioLang`、`defaultSubtitleLang`、`autoPlayNext`、`theme`，完全归属于 `profile_id`。
- **SettingsNavigationModule**: 设置导航菜单元数据。定义模块 `id`、`label`、`route`、`scope`（`personal` 或 `household_admin`）。

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: 普通成员进入设置页面时，管理相关配置项的暴露率为 **0%**，无多余干扰项。
- **SC-002**: 管理员从日常观看切换至家庭管理并完成一次来源新增的流转中，凭据输入次数由原先的 2~3 次减少为**仅在换人时输入 1 次 PIN 码**（减少 66% 以上的重复打断）。
- **SC-003**: 普通用户在设置内修改个人播放习惯（字幕/音轨/自动连播），从点击到生效的交互时间缩短至 **3 秒以内**，无需跨越任何门禁。
- **SC-004**: 针对管理路由的非法越权探测拦截率达到 **100%**，前端自动重定向，后端 403 严格阻断。

## Assumptions

- **已有主管理员 PIN 机制**：系统已具备通过头像菜单输入 6 位 PIN 码切换为管理员的成熟能力，无需重新开发选档身份校验流程。
- **单部署单家庭原则（ADR-0002）**：家庭管理范围固定服务于当前 NAS 实例上的唯一 Household，不涉及跨租户管理切换。
- **高危操作范围约定**：日常的媒体源增删改、频道 EPG 调整、分级名单修改属于常规运维范围，不列入需要二次输密码的高危操作；仅修改账号密码与销毁性操作属于高危。
