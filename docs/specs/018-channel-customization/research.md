# Implementation Research: 逻辑频道显隐控制与名称台标自定义编辑

**Feature**: `018-channel-customization`
**Created**: 2026-11-09
**Status**: Completed

---

## 核心技术决策 (Key Decisions)

### Decision 1: 逻辑频道显隐字段与公共可用性过滤机制 (Channel Visibility & Availability Filtering)

- **Decision**: 
  1. 在 `media_item` 表增加 `visible` 字段（`integer('visible').notNull().default(1)`，包含 0 或 1 约束校验）。
  2. 既有历史数据与新增 M3U 导入数据默认 `visible = 1`。
  3. 修改公共频道可用性判定核心 `loadAvailableMediaIdSet`（`policy-store.drizzle.ts` 与 `live-tv` 上下文）：
     在查询中连接 `media_item mi`，追加过滤条件 `AND mi.visible = 1`。
  4. 影响结果：所有被管理员置为 `visible = 0` 的频道，即刻从 `GET /public/live/channels`、`GET /public/live/groups` 中剔除，前台直播大厅与节目指南彻底对隐藏频道不可见。
- **Rationale**: 
  - 从源头（SQL/可用性集合层）直接切断隐藏频道向公共投影和播放鉴权的流出，完全杜绝幽灵频道展示，且不影响后台管理员的资产清单管理。
- **Alternatives Considered**: 
  - *仅在前端 React 状态中做隐藏过滤*：被否决。前端过滤无法防止网络爬虫或 API 遍历，且分页计算会导致各页数量不一致甚至白屏。
  - *通过 ProfilePolicy 黑名单来隐藏*：被否决。ProfilePolicy 是成员分级策略，家庭全局层面的频道显隐属于公共内容资产治理，应直接在 `media_item` 实体层控制。

---

### Decision 2: 频道名称与自定义台标防刷新覆盖机制 (Overwrite Protection on Refresh)

- **Decision**: 
  1. `title` 字段已有 `title_overridden: 1` 机制：当管理员修改名称时，置 `title_overridden = 1`，M3U 后续刷新事务检查到该标记时自动跳过标题更新。
  2. 自定义 Logo 支持：允许管理员在编辑弹窗中输入自定义 Logo URL。系统将其写入 `media_item.poster_ref`，同时如果 `channel_logo` 表存在记录，更新或标记人工锁定（如以 `custom` 为来源标记），使得后续 M3U 导入的 `tvg-logo` 不会覆盖管理员自定义的高清 Logo。
- **Rationale**: 
  - 保证管理员的人工治理成果具备持久稳定性，不会因为下一次定时 M3U 刷新而前功尽弃。
- **Alternatives Considered**: 
  - *每次 M3U 刷新都无条件覆写*：被否决。这会严重破坏管理员的心血和平台的专业度。

---

### Decision 3: 接口契约扩展 (API Extension)

- **Decision**: 
  1. 扩展现有 `PATCH /catalog/media/{mediaId}` 契约（在 `catalog-admin.service.ts` 与 `settings-sources.controller.ts`）：
     - 入参扩展为：`{ expectedVersion: number; title?: string; visible?: boolean; logoUrl?: string | null }`；
     - 每次成功修改后，`version` 自增 1，CAS 校验防并发冲突。
  2. 扩展 `POST /catalog/candidates/query`（频道资产工作台查询）：
     - 输出中携带 `visible: boolean` 与 `logoUrl: string | null`。
- **Rationale**: 
  - 遵循已有 DDD 分层规范，保持接口 RESTful 与原子性操作。

---

### Decision 4: 前端交互设计 (HeroUI v3 UX/UI)

- **Decision**: 
  1. **快捷 Switch 开关**：在 `SettingsEpgPage`（频道资产工作台）每个频道列表项的右侧操作区，放置一个 HeroUI `Switch` 组件（带有 `aria-label="切换频道显示状态"`），支持管理员一键切换。点击后自动触发 `PATCH` 更新，提供即时视觉反馈。
  2. **编辑弹窗 (Edit Channel Modal)**：
     - 点击每行的「编辑」按钮，打开 HeroUI `Modal`；
     - 表单包含：
       - 频道标题输入框（`TextField` + `Input`）；
       - 频道台标输入框（`TextField` + `Input`，提示输入图片 URL）；
       - **右侧即时台标预览框**：展示输入 URL 渲染效果，带有 `onError` 优雅回退默认 `Tv` 图标；
       - 保存按钮：保存后自动刷新列表，Toast 提示“频道信息已更新”。
- **Rationale**: 
  - 严格遵循宪章技术约束第 5 条（HeroUI v3 优先、禁用原生控件）与第 9 条（Lucide 图标）。
