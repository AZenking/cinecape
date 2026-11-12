# Feature Specification: 逻辑频道显隐控制与名称台标自定义编辑 (Channel Visibility & Metadata Customization)

**Feature Branch**: `018-channel-customization`

**Created**: 2026-11-09

**Status**: Proposed

**Governance**: Follow `.specify/memory/constitution.md`. Strictly compliant with Principle VII (Channel-Centric Logical Abstraction), Principle II (Household Boundary), Principle III (Public Browsing & Controlled Playback Authorization), and Principle VI (Role-Differentiated Settings).

**Related ADRs**:
- [ADR-0007: Media Catalog Import](file:///Volumes/Extends/DevCache/Projects/10-projects/14-epg/redRoad/docs/adr/0007-media-catalog-import.md)
- [ADR-0008: Manual EPG Binding](file:///Volumes/Extends/DevCache/Projects/10-projects/14-epg/redRoad/docs/adr/0008-manual-epg-binding.md)
- [ADR-0010: Public Browsing Playback Separation](file:///Volumes/Extends/DevCache/Projects/10-projects/14-epg/redRoad/docs/adr/0010-public-browsing-playback-separation.md)

**Input**: User description: "当前默认的逻辑频道数据为什么全部展示了？同时逻辑频道需要增加可以编辑频道名称和频道logo的处理"

---

## User Scenarios & Testing *(mandatory)*

### User Story 1 - 管理员在频道工作台一键控制频道显隐，精简前台展示列表 (Priority: P1)

当管理员导入包含大量频道的 M3U 订阅源后，系统内生成了大量逻辑频道。管理员进入“设置 $\rightarrow$ 频道资产”，在列表中直接通过每行直观的显隐开关（Switch）将不想看的频道（如购物台、地方测试台）切换为“隐藏”状态。前端直播大厅（`/live`）和节目指南（`/guide`）即刻生效，只展示处于“显示”状态的精选频道列表，前台页面整洁清爽。

**Why this priority**: 解决导入大体量 M3U 后前台被几百个无关频道严重刷屏的核心痛点，让前台最终只呈现家庭真正关注的优质频道。

**Independent Test**:
- 在频道资产工作台中将频道“QTV-5”切换为“隐藏”；
- 刷新直播大厅（`/live`）与 EPG 指南（`/guide`），验证该频道在公开列表中不再可见；
- 重新在后台将“QTV-5”切换为“显示”，前台页面即刻恢复展示。

**Acceptance Scenarios**:
1. **Given** 频道“测试购物台”初始状态为显示，**When** 管理员在频道工作台点击切换为“隐藏”，**Then** 系统持久化该频道的隐藏状态，且公开直播频道接口不再返回该频道。
2. **Given** 某个频道处于“隐藏”状态，**When** 关联的外部 M3U 订阅源执行例行定时刷新或重新导入，**Then** 系统的导入事务保持该频道的“隐藏”状态不变，绝不会被重新强制置为显示。
3. **Given** 某个被隐藏的频道仍具备有效物理流，**When** 管理员在频道资产后台查看，**Then** 频道依然列出在管理工作台中（带有“已隐藏”徽章），支持随时一键恢复显示。

---

### User Story 2 - 管理员自定义编辑逻辑频道名称并具备防刷新覆盖保护 (Priority: P2)

由于外部 M3U 订阅源中的频道名称常常参差不齐（例如带有冗余后缀、全英文缩写或大小写混乱），管理员点击频道资产工作台中的“编辑”按钮，在弹出的编辑模态框中修改频道名称（例如将 `CCTV-Weapon & Technology (1080p)` 修改为标准中文名 `CCTV-7 国防军事`）。保存后，前台直播大厅与播放器立即展示新名称。同时，系统为该频道打上人工命名覆盖标记，后续 M3U 重新导入时绝不覆盖管理员的自定义名称。

**Why this priority**: 赋予管理员完全规范化频道资产命名的能力，消除上游数据源杂乱命名的困扰，且具备永久防覆盖保护。

**Independent Test**:
- 打开任意频道的编辑模态框，修改名称为自定义新标题并保存；
- 验证前台大厅卡片与播放器顶部标题即时更新为新名称；
- 模拟触发上游 M3U 源重新拉取导入，验证该频道名称依然保持管理员的自定义标题不变（`title_overridden = 1`）。

**Acceptance Scenarios**:
1. **Given** 管理员打开频道编辑弹窗，**When** 将频道标题从“CCTV-11 (720p)”修改为“CCTV-11 戏曲”并点击保存，**Then** 页面提示保存成功，频道列表与大厅立即显示“CCTV-11 戏曲”。
2. **Given** 频道已被管理员重命名，**When** 上游 M3U 源再次刷新发布，**Then** 导入发布服务比对发现 `title_overridden = 1`，跳过标题覆盖，保留人工命名。
3. **Given** 频道正在被编辑，**When** 输入空标题或超过 255 字符的标题，**Then** 界面即时进行表单拦截提示，阻止无效提交。

---

### User Story 3 - 管理员自定义设置频道台标 Logo 与实时视觉预览 (Priority: P3)

由于某些外部 M3U 或 XMLTV 提供的台标图片链接可能失效、低清模糊或样式不搭，管理员可以在频道编辑弹窗中输入自定义台标 Logo 的图片 URL（例如官方矢量 SVG 或透明高清 PNG 图标）。在输入链接后，弹窗右侧即时渲染台标预览图。点击保存后，直播大厅卡片、浮动封面与播放器台标即刻生效展示该高清台标。

**Why this priority**: 彻底解决台标模糊、失效或空白的视觉瑕疵，大幅提升整个家庭流媒体平台的专业质感与观影视觉体验。

**Independent Test**:
- 打开频道编辑弹窗，输入自定义的高清台标链接；
- 验证弹窗右侧台标预览区域即时渲染该图片；
- 保存后访问直播大厅，验证该频道卡片成功显示自定义台标，且上游刷新时不被低清台标重置。

**Acceptance Scenarios**:
1. **Given** 管理员在台标输入框中输入有效的图片地址，**When** 输入完成，**Then** 弹窗预览区即时加载并展示该图片，若图片损坏则提示“预览加载失败”。
2. **Given** 管理员保存了自定义台标，**When** 保存成功，**Then** 该频道的 `poster_ref` 更新为该图片引用，并在前台各端点生效。
3. **Given** 频道已配置自定义台标，**When** M3U 重新导入带有原 `tvg-logo` 时，**Then** 系统优先保留管理员指定的台标，避免回退。

---

### Edge Cases

- **全部频道均被隐藏的极限边界**：当管理员将系统内所有逻辑频道全部设为隐藏时，前台直播大厅与节目单接口返回空列表，前端展示友好空状态提示（如“暂无已上架频道，请在设置中开启显示”），页面不发生崩溃。
- **自定义 Logo 地址失效或跨域受阻**：若管理员输入的自定义 Logo 图片发生 404 或网络加载失败，前端自动降级渲染清晰美观的默认频道图标（Lucide `Tv` 图标），不破坏卡片整体布局。
- **并发编辑冲突（CAS 版本冲突）**：两个管理员同时打开同一频道进行编辑并先后保存时，后提交的请求被系统拦截并提示 409 版本冲突，自动刷新最新数据，防止脏写覆盖。

---

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: 数据库 `media_item` 表**必须**持久化逻辑频道的可见性状态（`visible`，整数 0/1，默认为 1）。
- **FR-002**: 前台公开频道接口（`GET /public/live/channels`、`GET /public/live/groups`）**必须**增加显隐过滤，仅输出 `visible = 1` 且具备可用物理流的频道。
- **FR-003**: 隐藏频道**必须**对公开大厅彻底不可见，但主管理员在后台“频道资产工作台”中**必须**能够查看全量频道（含已隐藏频道），并支持随时切换显隐。
- **FR-004**: 系统管理后台**必须**提供单频道快捷显隐 Switch 开关，点击即时触发原子状态更新并提供反馈。
- **FR-005**: 系统管理后台**必须**提供频道元数据编辑模态框（HeroUI `Modal`），支持修改频道的**名称（Title）**与**台标 Logo（Logo URL）**。
- **FR-006**: 编辑频道名称成功后，系统**必须**自动将 `title_overridden` 置为 1，确保后续外部源刷新发布时永久免于被覆盖。
- **FR-007**: 频道编辑模态框**必须**在输入 Logo URL 时提供即时图片加载预览，并在加载失败时给出非阻塞提示。
- **FR-008**: 频道元数据更新接口**必须**继续执行乐观锁版本控制（CAS 版本校验），当版本冲突时返回清晰的错误提示。

### Key Entities

- **Logical Channel (`media_item`, type='channel')**:
  - 核心属性增加 `visible`（0 表示隐藏，1 表示显示）；继承现有的 `title`, `title_overridden`, `poster_ref`, `version`。
- **Channel Workbench DTO (`CandidateDto` / `ChannelWorkbenchItem`)**:
  - 数据传输对象增加 `visible: boolean`，前端工作台据此呈现 Switch 状态。

---

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: 管理员在频道工作台切换显隐 Switch 后，前台直播大厅在 300 毫秒内同步反映出频道的上架或下架状态。
- **SC-002**: 无论外部 M3U 订阅源重新刷新同步多少次，被管理员重命名的频道名称与自定义台标保持率达到 100%，绝无静默覆盖事故。
- **SC-003**: 管理员完成一个频道的“修改名称 + 更换台标 + 预览确认”全流程操作时间小于 15 秒。
- **SC-004**: 在前台直播大厅隐藏不需要的 100+ 个冗余频道后，终端页面首屏渲染节点数大幅下降 70% 以上，滚动流畅度显著提升。

---

## Assumptions

- **A-001**: 用户输入的自定义 Logo 图片为公网可访问的合规图片或家庭 NAS 本地可读图片地址（支持 HTTP/HTTPS 标准协议）。
- **A-002**: 默认情况下，新导入的频道保持可见（`visible = 1`），管理员可通过工作台手动精简筛选。
