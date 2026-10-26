---
description: "Task list for feature 005-pc-browsing-flow implementation"
---

# Tasks: 005 PC 公开浏览与观看操作流程全面调整

**Input**: Design documents from `/docs/specs/005-pc-browsing-flow/`（spec.md、plan.md、research.md、data-model.md、contracts/、quickstart.md、delivery-constraints.md）

**Prerequisites**: plan.md（required）、spec.md（required，用户故事 US1~US8）、research.md、data-model.md、contracts/。**实施门禁**：宪章原则一要求规格与 ADR-0010~0012 先经显式接受（Proposed→Accepted）再进入编码；本清单在门禁通过前不得开工。

**Tests**: 宪章要求测试必选。每个用户故事按 TDD 先写测试并确认 FAIL，覆盖 unit、contract、越权/篡改负向用例、前端组件与 Playwright e2e；运行时/真实网络/浏览器证据在最终阶段按 quickstart.md 归档 evidence.md，不以单元测试替代（宪章原则一）。

**Organization**: 任务按用户故事分阶段（Phase 3~10），支持独立实现与独立验收；Phase 1~2 为共享基础设施，Phase 11 为跨故事收尾。

## Format: `[ID] [P?] [Story] Description`

- **[P]**: 可并行（不同文件、无未完成依赖）
- **[Story]**: 所属用户故事（US1~US8）；Setup/Foundational/Polish 阶段无故事标签
- 描述包含文件路径；data-model.md与contracts为约束权威，任务摘要不得替代或放宽契约。T145～T149为分析修订新增稳定ID，按所属阶段就近插入，不重排旧编号；执行顺序由依赖决定，不按ID大小猜测

## Path Conventions

- **后端**: `apps/server/src/`（模块化 NestJS）、测试 `apps/server/test/{unit,contract}/`
- **前端**: `apps/web/src/`（app/layouts/features/shared）、测试 `apps/web/test/`、e2e `apps/web/test/e2e/`
- **共享类型**: `packages/shared/src/`
- **迁移**: `apps/server/src/database/`

## Status

Generated 2026-10-26 by `$speckit-tasks`（基于 Proposed 设计产物；未执行任何实现）。任务完成时勾选 `[x]` 并按 Checkpoint 留证据。

---

## Phase 1: Setup (Shared Infrastructure)

**Purpose**: 实施门禁、测试与契约工具链、依赖声明

- [x] T001 实施门禁与文档替代落地：经用户显式接受后将 docs/specs/005-pc-browsing-flow/spec.md、plan.md 与 docs/adr/0010~0012 状态 Proposed→Accepted（含日期与决策记录）；按 contracts/api.md §8 同步根目录 homeMediaDomainModel.md 及001/003/004受影响规格的局部替代标注；旧ADR仅按实际被替代条款记录关系，ADR-0006的逐次密码验证不废弃；核对宪章1.2.0仅005/代际2的兼容例外，不自行扩大豁免。T001通过前不得执行编码任务。
- [x] T002 [P] 前端测试工具链声明与配置：仅拥有 apps/web/package.json 的测试devDependencies/scripts以及 apps/web/vitest.config.ts、playwright.config.ts、test/setup文件，声明Vitest、Testing Library、jsdom、Playwright并配置独立DATA_DIR；不安装、不修改pnpm-lock.yaml。与T003不同文件可并行，必须在T004前完成；安装和typecheck由T004统一验证。（depends on T001）
- [x] T003 [P] 005共享契约类型入口：仅拥有 packages/shared/package.json 的gen:types/build脚本与 packages/shared/src/index.ts 导出，契约为 docs/specs/005-pc-browsing-flow/contracts/openapi.yaml（54路径/62操作）；不改锁文件、不与T004同时修改清单。本任务止于清单与导出声明；src/experience-schema.d.ts生成及build验证统一归T004收口，采用已有工具不新增依赖。（depends on T001）
- [x] T004 依赖与锁文件统一收口（唯一pnpm-lock.yaml所有者）：在T002/T003清单变更完成后，apps/server/package.json 与 apps/web/package.json 直接声明 @internationalized/date@3.12.4，web锁定HeroUI React/Styles 3.2.6；不引入Planby或其他生产UI/状态库。先 `pnpm install --lockfile-only` 受控更新并审阅锁文件，再 `pnpm install --frozen-lockfile`；随后执行shared gen:types/build、web typecheck，验证T002/T003产物。禁止与T002并行修改web清单。（depends on T002、T003的清单变更）
- [x] T005 [P] HeroUI v3 组件写法核验记录：按 delivery-constraints.md §2 与 heroui-react 技能阅读当时官方 v3 文档，将核验结论（v3 复合组件结构、按钮用 `onPress`、无 HeroUIProvider、Tailwind CSS v4 样式先于 @heroui/styles 导入、oklch 语义 token）记录到 apps/web/src/shared/theme/HEROUI-NOTES.md，作为后续所有前端组件任务的实现依据

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: 所有用户故事共用的数据代际、守卫、应用骨架与测试夹具；未完成前不得开始任何故事

**⚠️ CRITICAL**: No user story work can begin until this phase is complete

- [x] T006 新数据代际 0006_pc_experience 迁移与 schema：apps/server/src/database/ 新增 0006 迁移（schema generation 2，SQLite `user_version=2`），逐字落实 data-model.md §2~§7——household 增 `version INTEGER >=1 default 1`、`main_profile_version INTEGER >=1 default 1`；account 增 `credential_version INTEGER >=1 default 1`；profile 增 `is_main BOOLEAN default false`、`pin_version INTEGER >=1 default 1`、`version INTEGER >=1 default 1`、唯一索引 `(household_id) WHERE is_main=1`、CHECK"主档案必须 `type=adult,status=active,pin_hash IS NOT NULL`"；device_session 增 `profile_context_version INTEGER >=1 default 1`；playback_session 增 `profile_context_version INTEGER>=1`；media_item 增 `content_revision INTEGER >=1 default 1`；source_entry 增 `group_title TEXT NULL`（"trim 后 1～100 字符，空白为 NULL"）；新表 settings_access_grant、profile_channel_favorite、profile_progress_clock、playback_progress_state、profile_viewing_history（字段见 §3~§7）；programme 补索引 `(household_id,source_id,xmltv_channel_id,starts_at,ends_at)`；"新增FK所需的profile/playback_session等父表`(household_id,id)`复合唯一索引须在0006中显式确认或补齐，不能只在ORM声明而缺数据库约束"；0001~0005 历史迁移保留不改写
- [x] T007 旧库预检与 readiness：apps/server/src/database/ 迁移入口与应用启动 readiness——逐字落实"仅对全新安装的空业务库应用；旧已初始化库拒绝，不能先删数据再尝试升级。启动和迁移入口必须在任何写连接、WAL设置或迁移元数据创建之前以只读方式预检旧库，拒绝时不修改旧文件"；readiness 要求 `user_version=2` 匹配；拒绝原因可判读（区分旧库/损坏/未知）
- [x] T008 [P] 0006 schema与迁移测试：apps/server/test/unit/migration-0006.spec.ts 使用独立临时目录验证T006的全部新表/索引/复合FK、空库up/down/up、旧已初始化库只读拒绝且文件字节不变；此阶段不要求尚未实现的grant撤销/活动播放恢复业务已通过，该完整恢复行为由T140在全部故事完成后验证。T006为唯一DDL所有者，测试可先写失败用例，完成依赖T006/T007。
- [x] T009 服务端守卫与响应底座：apps/server/src/common/——PublicContext 解析（唯一 Household 确定公开范围；零家庭返回 initialized=false 语义、多家庭属配置损坏 503，不接受匿名身份声明）；重构 SessionGuard 不再作为公共浏览前置；新增 CurrentProfileGuard（me/播放）；SettingsAccessGuard 占位注册（US7 填充）；同源校验与统一错误 envelope（稳定错误码，api.md §1/§7）；公共/个人/设置响应 no-store 中间件与"未知 JSON/query 字段一律拒绝"入参过滤；限频底座（public IP 与 DeviceSession 维度）
- [x] T010 前端基础骨架唯一所有者：apps/web/src/app/建立可供故事扩展的路由注册与Provider插槽，公共地址统一 `/`、`/vod`、`/media/:id`、`/live`、`/live/guide`，另有 `/settings/*` 守卫插槽；建立 apps/web/src/layouts/PublicLayout.tsx 和 apps/web/src/shared/fetch.ts（AbortController、错误映射、public credentials omit、个人凭据）。移除旧登录优先根路由与旧页面入口，不建立/catalog别名。T026只接入页面，不重新建壳；T022只做异步状态UI，不重写fetch。
- [x] T011 [P] 主题 token 与全局可访问性基线：apps/web/src/shared/theme/——oklch 语义 token 与 CSS 变量、延续暗色媒体界面基调；apps/web/src/globals.css 中 Tailwind v4 入口先于 @heroui/styles 导入；焦点可见样式、非颜色唯一提示与错误关联的基础约定（ui.md §8、delivery-constraints.md §2~3）
- [x] T012 [P] 规模测试夹具生成器：apps/server/test/fixtures/ 新增 fixture 生成脚本与固定 nowMs 时钟注入——200 频道、500 点播、每频道每天 48 节目、7 天共 67,200 排期，覆盖无 EPG 频道、重叠节目、跨日节目、空档、可用性变化与多分组 group_title；供 US1/US4/US5/US6 契约测试与 Playwright e2e 共用（quickstart.md §1 夹具要求）
- [x] T013 基础阶段工具链与骨架冒烟门禁（只验证Phase 1～2，不承担最终全量验收）：在根package.json定义后续实施脚本 `verify:foundation` 与 `verify:release` 的独立入口；本任务只要求foundation入口通过：①gen:types、lint、全workspace typecheck与build；②新增并实际执行 apps/server/test/unit/foundation-smoke.spec.ts（独立临时库generation2就绪/旧库只读拒绝、守卫拒绝未认证管理读取），apps/web/test/foundation-smoke.spec.tsx（游客公共壳、导航及typed fetch凭据/错误/取消行为），apps/web/test/e2e/foundation-smoke.spec.ts（独立DATA_DIR中公共骨架可加载、导航可达且不强制登录）；三类冒烟均须发现并执行至少1个有效用例且全部通过，保存命令、发现/执行/通过数量与范围记录。采用显式基础测试清单，不提前要求尚未创建的US1～US8业务测试、完整播放/设置/EPG或全量runtime通过；不得以零用例成功、passWithNoTests、临时skip/only或吞掉失败充当基础门禁。verify:release预留完整验证入口，其实现绑定与执行归T144，T013不宣称它已通过。此处是待实施任务，不在文档修订阶段创建脚本或测试文件。（depends on T004、T005、T006、T007、T008、T009、T010、T011、T012）

**Checkpoint**: Foundation ready——T004安装/类型生成、T006～T012基础能力与T013显式基础冒烟清单全部满足；空库进入generation2、旧库只读拒绝、公共骨架可匿名渲染，未实现设置能力保持拒绝。仅声明工具链与基础骨架就绪，不声明业务功能、SC指标、全量测试或runtime验收通过。后续用户故事可按依赖开始；其新增业务测试先失败再随实现转绿，最终完整门禁统一由T144执行。


---

## Phase 3: User Story 1 - 游客直接浏览家庭内容 (Priority: P1) 🎯 MVP
**Goal**: 游客免登录浏览本部署家庭全部可用内容元数据——PublicContext 公共上下文端点、公共媒体目录/详情白名单投影（无源地址/来源凭据/播放票据）、公共导航壳（首页/点播/直播 + 游客登录入口）、基础点播目录搜索/筛选/分页与返回状态恢复（FR-045），以及加载中/空/失败可重试三态区分（FR-004）；直播页与 EPG 墙内容属 US5/US6，本阶段仅保证导航入口路由可用。
**Independent Test**: 在已初始化且有已导入内容的独立测试部署中，用没有会话的浏览器逐一打开公共页面，比较完整可用内容清单，并检查直接访问与刷新。

### Tests for User Story 1 (REQUIRED) ⚠️
> **NOTE**: 先写这些测试并确保 FAIL
- [x] T014 [P] [US1] 契约测试：匿名 GET /api/public/context 返回白名单投影"PublicContext：initialized、displayName（已初始化）、timezone、language、now、catalogRevision；不返回账号、Profile、来源信息。"，覆盖未初始化时 initialized=false 且其余为默认展示值、响应头遵守"公共响应 no-store"、携带失效 Cookie 仍可公开浏览且不返回 Set-Cookie（apps/server/test/contract/public-context.e2e-spec.ts）
- [x] T015 [P] [US1] 契约测试：匿名 GET /api/public/media 目录仅返回本部署家庭（服务端确定）的可用内容且不按 Profile 策略过滤（FR-002），覆盖 q<=100 搜索、type 筛选、page>=1 与 pageSize=20/max100 分页及稳定标题/id 排序，断言仅 available 媒体进入目录、成功空结果与请求失败响应可区分（apps/server/test/contract/public-media-list.e2e-spec.ts）
- [x] T016 [P] [US1] 契约测试：匿名 GET /api/public/media/{mediaId} 详情可读、无个人状态与播放 URL；负向用例——不存在与本部署外（跨家庭猜测）媒体 ID 统一 404；按 FR-003 断言成功与错误响应均不含源地址、路径、来源凭据、密码或 PIN 哈希、播放票据及可直接取得媒体流的地址（apps/server/test/contract/public-media-detail.e2e-spec.ts）
- [x] T017 [P] [US1] 单元测试：公共投影服务逐字执行"PublicMedia：id、type、title、description、posterRef、contentLevel、availability；posterRef 仅服务端认可的同源展示资源或 null，导入任意外部 URL 不直接渲染。只有可用资源进入目录；个人记录的失效媒体使用 unavailable 摘要。"——白名单外的源字段（含 source_entry 原始 URL 与来源身份）不得进入 DTO，未认可外部 posterRef 置 null（apps/server/test/unit/public-media-projection.spec.ts）
- [x] T018 [P] [US1] 契约负向越权测试：匿名或伪造身份请求（query/body 携带 householdId、profileId、isAdmin 等未知字段一律 400 拒绝且不得借此扩大读取范围）、跨家庭目标与不存在资源统一 404；公共错误响应同样遵守"公共响应 no-store"且不泄漏内部策略与源位置，失败可重试而非引导登录（FR-004）（apps/server/test/contract/public-browse-negative.e2e-spec.ts）
- [x] T019 [P] [US1] 前端单元测试：基础点播目录（apps/web/src/features/catalog/）将 q/type/page 写入 URL 查询参数，从详情返回或登录取消后恢复原搜索、筛选与页码且不重置回第一页（FR-045）；加载中、成功空结果（暂无内容/无匹配）与失败可重试三态互不混淆（FR-004）（apps/web/test/catalog-state.spec.tsx）
- [x] T020 [P] [US1] 前端单元测试：PublicLayout 导航壳（apps/web/src/layouts/PublicLayout.tsx）——品牌入口返回首页、左侧首页/点播/直播为真实路由链接、游客右侧显示登录入口（FR-005）；公共数据请求 credentials omit，Layout 不被 RequireSession 包裹，游客视图不渲染空白个人区占位（apps/web/test/public-layout.spec.tsx）
- [x] T021 [P] [US1] Playwright 端到端测试：在已初始化且有已导入内容的部署中，用无会话浏览器直接打开并刷新 `/`、`/vod`、`/media/:id` ，断言不跳转登录、不要求选档、目录/详情元数据可见；/live与/live/guide仅断言入口无登录门槛，节目内容在US5/US6与T141集成后验证（含已登录儿童策略不可播内容仍可见元数据），为 SC-001 游客部分建立自动化基线（apps/web/test/e2e/public-browse-guest.spec.ts）

### Implementation for User Story 1
- [x] T022 [P] [US1] 新建共享异步状态UI（apps/web/src/shared/ui/）：加载Spinner/骨架、成功空结果、无匹配、可重试Alert及禁用理由，错误不只靠颜色。直接复用T010的typed fetch与PublicLayout，不另建网络底座；为home/catalog提供组件。（depends on T019、T020、T010）
- [x] T023 [P] [US1] 新建公共目录模块骨架与上下文端点（controller/service/模块注册）：GET /api/public/context 从唯一 Household 服务端确定范围，按"PublicContext：initialized、displayName（已初始化）、timezone、language、now、catalogRevision；不返回账号、Profile、来源信息。"投影，未初始化返回 initialized=false 与默认展示值，零家庭/多家庭配置损坏按契约分别处理（apps/server/src/modules/public-catalog/）(depends on T014)
- [x] T024 [P] [US1] 实现 GET /api/public/media 公共目录列表：q<=100 搜索、type 筛选、page>=1/pageSize=20/max100 分页、稳定标题/id 排序；家庭由服务端从部署确定、不接受身份声明扩大范围，仅 available 内容进入目录且不执行 ProfilePolicy 过滤（FR-002），DTO 走 PublicMedia 白名单投影（apps/server/src/modules/public-catalog/）(depends on T015, T023)
- [x] T025 [P] [US1] 实现 GET /api/public/media/{mediaId} 公共详情：复用白名单投影并逐字满足"PublicMedia：id、type、title、description、posterRef、contentLevel、availability；posterRef 仅服务端认可的同源展示资源或 null，导入任意外部 URL 不直接渲染。只有可用资源进入目录；个人记录的失效媒体使用 unavailable 摘要。"；不存在与跨家庭 ID 统一 404，不返回个人状态、播放 URL 或票据（apps/server/src/modules/public-catalog/）(depends on T016, T017, T024)
- [x] T026 [US1] 在T010既有 apps/web/src/app/路由和 PublicLayout 中接入首页公共区、VodCatalogPage与MediaDetailPage；地址只用 `/`、`/vod`、`/media/:id`，直播和guide路由由US5/US6填充。核对品牌回首页与三项真实导航、游客登录入口；未知路由显示可回首页404。不得重复创建布局或恢复旧登录守卫。（depends on T020、T022、T023、T010）
- [x] T027 [P] [US1] 实现首页公共区（apps/web/src/features/home/）：游客可见公共直播摘要入口、所有节目单入口与基础点播入口，菜单不指向空白占位页（FR-046）；游客仅公共区与轻量登录提示、不用空白个人区占首屏（个人区属 US4）；空/加载/失败按 FR-004 三态展示（depends on T026）
- [x] T028 [P] [US1] 实现基础点播目录页（apps/web/src/features/catalog/VodCatalogPage.tsx）：统一公共布局内搜索、类型筛选、翻页，q/type/page 写入 URL 查询参数，详情返回或登录取消后恢复原条件与页码（FR-045）；沿用基础目录交互，不新增推荐算法、专题、剧集编排或独立点播视觉方案（FR-046）（depends on T024, T026）
- [x] T029 [P] [US1] 实现公共媒体详情页（apps/web/src/features/catalog/MediaDetailPage.tsx）：渲染 PublicMedia 元数据与海报（posterRef 仅同源资源或 null，任意外部 URL 不直接渲染），元数据对游客完全可见、不按儿童/成人策略隐藏，页面无任何个人状态与播放凭据；播放入口接入 US3 统一受控播放流程，本页不自行发起播放（depends on T025, T026）

**Checkpoint**: 全部 US1 测试由红转绿；在含 200 频道与 500 点播媒体的独立测试部署中，无会话浏览器直接打开并刷新 `/`、`/vod`、`/media/:id`（及 `/live`、`/live/guide` 入口路由）均可浏览、不跳转登录、不要求选档（SC-001 游客部分）；公共响应仅含白名单字段、Cache-Control: no-store，FR-003 泄漏字段断言为 0；目录搜索/筛选/分页在详情返回后恢复（FR-045），加载中/空/失败可重试三态可区分（FR-004）。


---

## Phase 4: User Story 2 - 账号配置、登录与 Profile 选择顺畅衔接 (Priority: P1)
**Goal**: 打通"未初始化弹窗配置家庭主账号 → 显式登录 → 零档案首建唯一成人主 Profile / 已有档案显式选档 → 会话与当前 Profile 恢复"的完整链路（FR-005~010、FR-029~030）：初始化仅建 Household+Account，201 不发会话、不自动登录、并发只成功一次；首建经 owner+当次密码+名称+6 位数字 PIN 创建成人主 Profile 且不自动激活（409 冲突不改写）；已有档案登录后显式选档，PIN 保护档案先验证，选档后回原目标或首页；会话/当前 Profile 可恢复、失效清理不中断公共浏览；取消返回原页面并拒绝开放重定向。前置依赖：Phase 2 契约/共享类型/新代际基础设施完成；本阶段与 US1 并行。
**Independent Test**: 分别在全新部署和已初始化部署完成配置、手动登录、选档、刷新、退出及取消登录。

### Tests for User Story 2 (REQUIRED) ⚠️
> **NOTE**: 先写这些测试并确保 FAIL
- [x] T030 [US2] 契约测试（先 FAIL）：apps/server/test/contract/setup-initialize.contract.test.ts 覆盖 FR-006/007——POST /api/setup/initialize 合法输入返回 201 `{initialized:true}`，断言响应无 Set-Cookie、无 sessionToken、不注册设备、不自动登录、不接受任何来源/节目单导入字段；负向：并发两次提交仅一次 201、另一次 409，失败不遗留半配置状态；GET /api/setup/status 存储故障/状态未知返回 503 而非伪装 initialized=false（初始化状态未知不得开放重复配置）；已初始化后重复 initialize 返回 409
- [x] T031 [P] [US2] 契约测试（先 FAIL）：apps/server/test/contract/auth-bootstrap.contract.test.ts 覆盖 FR-030/029——零档案会话 POST /api/auth/bootstrap-profile（name+6位数字pin+ownerPassword）返回 201 ProfileSummary（isMain=true、pinProtected=true），随后 GET /auth/session 的 activeProfile 仍为 null（不自动激活、不混入账号初始化）；负向：已有档案再提交返回 409 BOOTSTRAP_ALREADY_DONE 且不改写现值（原 is_main、pin_version 不变）；PIN 非 6 位数字 400；未登录401 SESSION_INVALID；有效会话但非管理角色403；缺少必填ownerPassword为400 VALIDATION_FAILED、合法格式但密码错误403；bootstrap 越权读取负向——响应不得含策略、来源、设备等一般设置数据；错误密码沿用既有错误计数与锁定
- [x] T032 [P] [US2] 契约测试（先 FAIL）：apps/server/test/contract/profiles-selection.contract.test.ts 覆盖 FR-008——GET /api/profiles 仅返回选档摘要（id,name,avatar,type,isDefault,isMain,pinProtected,status），禁用档案可见但 select 拒绝，不返回策略/锁定计数/失败日志；POST /profiles/{id}/unlock 正确 PIN 200（一次性选档授予），负向：连续 5 次错误 PIN 返回 423 PROFILE_PIN_LOCKED 且锁定跨刷新、新会话保留，篡改请求体或换新会话不得清零计数；POST /profiles/{id}/select成功返回SessionDto；仅实际换档使profileContextVersion递增，同一有效档案重选不递增；负向（伪造身份声明）：body/查询携带 householdId、profileId、isAdmin 等未知字段一律 400 拒绝、不能借此解锁或扩大权限，目标档案跨家庭或不存在统一 404，受 PIN 保护档案未 unlock 直接 select 被拒
- [x] T033 [P] [US2] 单元测试（先 FAIL）：apps/server/test/unit/profile-main-constraints.test.ts 与 apps/server/test/unit/device-session-context-version.test.ts 覆盖 data-model §2/§9——profile 唯一索引 `(household_id) WHERE is_main=1`（负向：同家庭第二个 is_main=1 插入被拒）、CHECK 主档案必须 `type=adult,status=active,pin_hash IS NOT NULL`（负向：儿童/停用/无 PIN 写 is_main 被拒）、`pin_version INTEGER >=1 default 1` 初值与递增；device_session `profile_context_version INTEGER >=1 default 1` 在实际 activeProfile 改变、清空或失效回落时递增，A→B→A 至少递增两次（负向：仅比较最终 activeProfileId 的实现必须失败）；首次 bootstrap 创建 main adult、6 位 PIN 哈希、默认内容策略和 progress clock 但"不设置 active_profile_id"；PIN 更新清持久失败计数、撤销选档/设置授予并清空当前选用该档案的 active_profile_id
- [x] T034 [P] [US2] 前端单元测试（先 FAIL）：apps/web/test/app/session-provider.test.tsx 与 apps/web/test/app/action-coordinator.test.ts（Vitest+Testing Library）——SessionProvider 恢复中呈现轻量状态不遮挡公共区、刷新恢复账号+当前 Profile；当前 Profile 失效时清除个人展示并提示重新选档、公共区不中断（FR-009）；ActionCoordinator 意图状态机覆盖 uninitialized→initialize→login 与 noProfile+bootstrapRequired→bootstrap→picker→selectionPin，取消清 intentId 与表单凭据、返回原页面、旧回调不可重开弹层或触发播放；负向：外部/非白名单返回目标被拒绝、不形成开放重定向（FR-010）；首建表单校验档案名称与 6 位数字 PIN
- [x] T035 [US2] E2E 测试（先 FAIL）：apps/web/test/e2e/auth-profile-flow.e2e.test.ts（Playwright，独立临时 DATA_DIR）跑通 SC-002 主链路——全新部署首页弹窗配置家庭主账号→201 后停留在显式登录→手动登录→零档案首建（名称+6位PIN+当次密码）→进入选档并选择/解锁→选档后回到原目标或首页→刷新恢复账号与当前 Profile→退出登录；负向路径：游客在公共页发起登录后取消返回原页面且无媒体请求、无重复弹窗；已初始化部署直接登录选档；错误凭据统一失败提示

### Implementation for User Story 2
- [x] T036 [US2] 后端初始化改造：apps/server/src/modules/auth/ 重构 SetupController 与初始化服务，真正移除创建家庭后的 registerDevice/issueSession/setSessionCookie 自动登录链路（research R2：不能靠前端清 cookie 假装不自动登录）；实现 GET /setup/status（存储未知/故障返回 503，不误判未初始化）与 POST /setup/initialize——`BEGIN IMMEDIATE` 单事务仅创建 Household+Account（含 account `credential_version INTEGER >=1 default 1`），201 `{initialized:true}` 无 Set-Cookie、无设备注册、请求体未知字段（含来源/节目单字段）一律 400；并发提交借唯一性约束只成功一次、重复 409，失败回滚不遗留半配置状态（depends on T030）
- [x] T037 [P] [US2] 后端 bootstrap-profile 窄用途端点：apps/server/src/modules/auth/ 实现 POST /auth/bootstrap-profile——Session+管理角色+当次 ownerPassword 逐次验证（密码哈希在事务外，提交前重读 credential_version 与零档案状态）；零档案短事务内创建唯一成人主 Profile：is_main=true 且满足 CHECK `type=adult,status=active,pin_hash IS NOT NULL`，写 6 位数字 PIN 哈希、`pin_version INTEGER >=1 default 1`、默认内容策略与 progress clock，"不设置 active_profile_id"不自动激活；已有档案返回 409 BOOTSTRAP_ALREADY_DONE 不改写现值；响应仅 ProfileSummary、不读取一般设置数据；同模块实现 POST /auth/main-profile/pin-recovery 窄用途恢复（owner+当次密码+newPin：仅重设当前家庭主档案 PIN、清锁定与失败计数、递增 pin_version、撤销目标档案选档/设置授予，不签 settings grant、不返回管理主体）（depends on T031, T033）
- [x] T038 [P] [US2] 后端最小选档接口：apps/server/src/modules/profile/ 实现 GET /profiles（登录会话的选档摘要：禁用可见但不可选、不含策略/锁定计数）、POST /profiles/{profileId}/unlock（`{pin}`，签发一次性选档授予；与设置验证共享原 profile 持久失败计数，连续 5 次失败锁 5 分钟返回 423 PROFILE_PIN_LOCKED，成功清计数；PIN 哈希比对在事务外、提交前重验 pin_version/profile_context_version 快照）、POST /profiles/{profileId}/select（目标受 PIN 保护须先 unlock；实际换档同事务递增 device_session `profile_context_version INTEGER >=1 default 1`、撤销设置授予、终态化旧上下文活动播放；选同一仍有效档案不递增版本、不得借恢复过期设置授予）；身份只从服务端会话推导，body 携带 householdId/profileId/isAdmin 等未知字段一律拒绝，跨家庭/不存在统一 404（depends on T032, T033）
- [x] T039 [P] [US2] 后端守卫与会话生命周期：apps/server/src/common/ 落地 SessionGuard/CurrentProfileGuard 及统一授权次序（Session→角色→严格入参→事务），GET /auth/session 返回 §9 AccountSession DTO（服务端 householdId、账号与当前 Profile 最小摘要、bootstrapRequired、profileContextVersion；不含 PIN hash 或设置主体，bootstrapRequired=true 仅表示零档案、不允许客户端借字段写入身份）；POST /auth/logout 撤销会话与设置授予、清 cookie、幂等 204；FR-009 失效语义——当前 Profile 停用/失效时 me 与播放接口拒绝并指示重新选档，/public/* 不读取身份、携带失效 cookie 仍可公开浏览（depends on T032）
- [x] T040 [P] [US2] 前端 SessionProvider：apps/web/src/app/ 实现——启动恢复会话为轻量 restoring 状态、不阻塞公共区渲染；缓存服务端 householdId/账号摘要/当前 Profile/bootstrapRequired/profileContextVersion；刷新恢复有效身份，Profile 失效时清空个人区（缓存键包含 Household/Profile/contextVersion）并提示重新选档；登出/换档先清旧个人展示、递增前端 generation 阻止迟到响应回填（depends on T034, T039）
- [x] T041 [P] [US2] 前端认证组件：apps/web/src/features/auth/ 实现配置弹窗（仅未初始化展示；/setup/status 503 时显示重试、不误判为未初始化而开放配置）、显式登录表单（错误凭据统一失败提示、忙时防重复提交、成功后继续原意图）、首建表单（档案名称+6 位数字 PIN+当次账号密码，成功后进入选档、不静默激活主档案、可取消返回公共浏览）、PIN 恢复受限流程入口；HeroUI v3 Modal/Form/TextField，密码与 PIN 仅保留表单内存、关闭即清、禁止写 localStorage（depends on T034, T037）
- [x] T042 [P] [US2] 前端选档组件：apps/web/src/features/profiles/ 实现选档列表（ProfileSummary 投影、禁用档案置灰不可选）、PIN 解锁表单（剩余失败次数提示、423 PROFILE_PIN_LOCKED展示锁定提示与重试入口，不显示契约未提供的剩余时间且刷新/新会话不可绕过）、顶栏身份菜单切档/退出（登录未选档=账号+选择 Profile；已选档=账号+头像/名称；只有当前主 Profile 显示设置入口，隐藏入口不替代 API 校验）（depends on T034, T038）
- [x] T043 [US2] 前端 ActionCoordinator 登录→选档流：apps/web/src/app/action-coordinator.tsx 实现唯一统一受控Modal意图状态机（单 Modal 分步切换：uninitialized/initialize→login→bootstrap→picker→selectionPin，不同时叠出多个弹层）；每动作保存 intentId/原目标/入口，新动作递增代次，旧登录/选档回调不可起播或重开已取消弹层；选档成功回到原业务目标或首页、不停留在仅有成功通知的选档界面；取消清凭据与意图、返回原页面、不自动播放、不重复弹窗；返回目标仅接受本应用白名单内部路径，拒绝外部跳转目标防开放重定向（FR-010）（depends on T034, T040, T041, T042）

**Checkpoint**: 全部 US2 测试由 FAIL 转 PASS（pnpm test 覆盖 apps/server/test/unit、apps/server/test/contract，前端 Vitest 与 Playwright 新入口通过）；负向矩阵逐项有证据——并发初始化只成功一次、初始化状态未知(503)不开放配置、bootstrap 越权读取与非管理会话拒绝、PIN 篡改/错误计数锁定(423 跨刷新/新会话保留)、伪造 householdId/profileId/isAdmin 声明被 400/404 拒绝；POST /setup/initialize 201 响应无 Set-Cookie、无 sessionToken；bootstrap 后 activeProfile 仍为 null、`(household_id) WHERE is_main=1` 唯一索引与 CHECK 约束生效、A→B→A 时 device_session.profile_context_version 至少递增两次；取消登录返回原页面且无外部重定向；FR-009 失效清理不阻塞公共浏览。宪章原则一/二/六要求的越权、跨 Profile 篡改与防篡改负向用例全部显式存在且通过后，方可进入下一阶段审阅。

---

## Phase 5: User Story 3 - 从任何页面发起同一套受控播放 (Priority: P1)
**Goal**: 首页收藏/历史入口占位、直播卡片与频道/节目详情、点播详情全部共享同一套受控播放：游客点击→登录选档→继续原目标播放，登录与选档完成前不请求/交付媒体流；服务端 resolve 事务绑定当前身份上下文版本，按 Session→当前 Profile→最新策略→可用家庭资源动态校验，策略/资源失效稳定拒绝且不泄露内部细节（FR-011、FR-012）；准备中重复点击/换目标仅最新 intentId 意图可起播（FR-013）；退出/换档/会话撤销在同一事务终态化旧播放并撤票，A→B→A 不能复活（FR-014）；登录期间目标失效在完成选档后重新判定（US3 场景 5）。播放网关、票据、转换与交付沿用 004 受控播放基线（ADR-0009），不扩大编解码范围。本阶段全部任务依赖 US2（登录/选档流）阶段任务完成。
**Independent Test**: 对可用频道和受支持的点播媒体分别验证游客点击、登录选档、拒绝、切换档案及退出，播放器能力沿用既有受控播放范围。

### Tests for User Story 3 (REQUIRED) ⚠️
> **NOTE**: 先写这些测试并确保 FAIL
- [x] T044 [P] [US3] 契约负向测试：匿名与失效会话直接播放全链拒绝——新增 apps/server/test/contract/playback-anonymous-rejection.e2e-spec.ts：无 cookie/失效 cookie 直接 POST /api/playback/resolve、携带或猜测旧 ticket 调用状态与控制端点、请求媒体/字幕/转换交付端点均被拒绝（401 SESSION_INVALID、403 ACTIVE_PROFILE_REQUIRED、播放 404 同形、限频 429 保留），错误响应不含策略细节、源位置、路径或票据字段（FR-011"游客直接调用播放、票据或媒体交付均被拒绝"；依赖 US2 阶段登录/选档契约与测试基建完成）
- [x] T045 [P] [US3] 契约测试：resolve 上下文绑定与旧 ticket/旧 context 拒绝、A→B→A 复活——新增 apps/server/test/contract/playback-context-binding.e2e-spec.ts：resolve 201 仅表示接受、无票+Location；换档（A→B→A 使 device_session.profile_context_version 至少递增两次）、登出、会话撤销后，旧 playback_session 的状态读取、renew、seek/selection、媒体交付与进度写入全部按稳定错误拒绝，旧 ticket 不能转用于新身份（FR-014、SC-003 负向矩阵）
- [x] T046 [P] [US3] 契约负向测试：策略/资源失效拒绝不泄露细节与登录期间目标失效重判——新增 apps/server/test/contract/playback-policy-resource-rejection.e2e-spec.ts：儿童 Profile 请求策略禁止内容、来源停用/资源不可用、跨家庭或不存在 mediaId 均拒绝且错误同形，不泄露内部策略与源位置（FR-012）；构造"游客点击时可用、选档完成时已禁用"的频道/媒体，resolve 重新判定被拒且不使用登录前取得的过期事实（FR-014、US3 场景 5）；body 夹带 profileId/householdId/startPosition 等未知字段一律 400，不能扩大权限
- [x] T047 [P] [US3] 单元测试：身份变化事务终态化旧播放并撤票——新增 apps/server/test/unit/playback/identity-finalization.spec.ts：换档/登出/会话撤销/PIN 变更/设备撤销的同一事务递增 profile_context_version、将旧上下文活动 playback_session 标 ended/interrupted、撤销对应票据；异步准备提交复查版本不符被拒；断言不依赖前端 stop 也完成终态化（FR-014）
- [x] T048 [P] [US3] 前端单元测试：ActionCoordinator 意图状态机与统一入口——新增 apps/web/test/playback/action-coordinator.spec.tsx、apps/web/test/playback/use-play-action.spec.tsx（沿用 US2 阶段建立的 Vitest/Testing Library 基建）：游客 play→login→（bootstrap/picker/selectionPin 需要时）→继续原目标起播；取消返回原页面、清凭据、不自动播放也不重开弹层；登录选档完成前不调用 /playback/resolve、不预取媒体；准备中重复点击/换目标仅最新 intentId 可 authorize→prepare→playing，旧登录回调与旧准备结果不能起播其他内容（FR-013、ui.md §3）
- [x] T049 [P] [US3] 前端 e2e：游客继续原目标与竞态负向——新增 apps/web/test/e2e/playback-intent.spec.ts（Playwright，沿用 US2 基建）：游客点直播/点播详情播放→完成登录选档→继续原频道当前直播/原媒体，无需重新找内容；取消登录时 Network 断言零 /playback/ 与媒体分段请求；准备中连点/换目标仅最新内容起播；换档与退出后旧播放停止、旧请求被拒（SC-003 游客点击与竞态场景）

### Implementation for User Story 3
- [x] T050 [P] [US3] 服务端 resolve 上下文绑定与授权次序（depends on T044, T045）——扩展 apps/server/src/modules/playback/playback-resolver.service.ts、playback.controller.ts、playback.repository.ts、playback.types.ts：resolve 短事务内按有效 DeviceSession→当前 activeProfile 归属/状态→最新 ProfilePolicy→可用家庭资源校验后落库会话，逐字遵循 data-model.md §2 约束「playback_session 新增 `profile_context_version INTEGER>=1`，resolve时从可信DeviceSession捕获；每次控制、renew、交付和个人进度写入必须等于当前DeviceSession版本」；201 仅表示接受、无票+Location，不接受 profileId/householdId/startPosition 上传（api.md §5）；startMode 先做透传校验（频道请求 resume 返回 400 PLAYBACK_SEEK_UNSUPPORTED），resume 位置冻结与进度协议归 US4
- [x] T051 [US3] 控制与交付链路版本重验（depends on T045, T050）——扩展 apps/server/src/modules/playback/playback-authorization.service.ts、playback-stream.controller.ts、playback.controller.ts：GET 状态、renew、seek/selection、票据签发、媒体/字幕/转换交付及 heartbeat 每次重验 playback_session.profile_context_version 等于当前 DeviceSession 版本，不等即按稳定错误拒绝且不泄露内部细节；落实「异步准备提交也复查该版本，避免A→B→A复活旧播放」；沿用 004 的 15 秒 heartbeat、限频与受控网关语义，不扩大编解码范围（ADR-0009）
- [x] T052 [P] [US3] 身份变化终态化与撤票事务挂钩（depends on T047）——扩展 apps/server/src/modules/playback/playback-lifecycle.service.ts、playback-ticket.service.ts，并在选档/登出/会话与设备撤销/PIN 变更事务（apps/server/src/modules/profile/ 与 auth 相关模块）挂钩：同一事务逐字落实 device_session 约束「实际 activeProfile 改变、清空或失效回落时递增；A→B→A 至少递增两次。改变身份、撤销当前 settings grant、终态化该DeviceSession旧身份的活动playback及撤销对应票据在同一事务」，旧上下文活动播放标 ended/interrupted 并撤票，「不能仅依赖前端stop」（FR-014）
- [x] T053 [US3] 扩展T043唯一的 apps/web/src/app/action-coordinator.tsx：在既有login/bootstrap/picker/selectionPin状态上增加play→authorize→prepare→playing分支，绑定intentId/目标/入口，取消与换目标废弃旧回调。禁止另建features/playback/action-coordinator作为第二个全局状态机；播放模块仅消费既有协调器。（depends on T048、T043）
- [x] T054 [P] [US3] 统一播放入口接入所有页面（depends on T053）——新增 apps/web/src/features/playback/use-play-action.ts 与共享 PlayButton 入口组件，接入首页收藏/历史入口占位（apps/web/src/features/home/）、直播卡片与频道/节目详情（apps/web/src/features/live/）、点播详情（apps/web/src/features/catalog/）：所有入口只经同一 usePlayAction 发起（startMode 占位，进度数据与继续/从头按钮语义由 US4 补全）；游客点击进入登录选档意图，仅选档完成后才发起 resolve，使登录期间目标失效在服务端按最新状态重新判定（FR-011、FR-014、US3 场景 5）
- [x] T055 [P] [US3] 播放器视图与拒绝/终止状态（depends on T053）——新增 apps/web/src/features/playback/player-view.tsx 并经 apps/web/src/app/ 页面挂载：复用 004 受控网关输出与 hls.js 消费，起播与准备结果安装绑定当前 intentId 代次；授权拒绝/资源不可用显示不可播放或不可用提示，不展示内部策略或源位置；退出/换档/会话撤销时停止播放、废弃在途请求与票据（final 进度保存与 started 确认协议归 US4）；沿用既有起播时限与转换能力，不新增转码承诺（ADR-0009、SC-003）
- [x] T056 [US3] 原播放回归与本阶段用例转绿（depends on T046, T049, T050, T051, T052, T054, T055）——修复实现使 T044～T049 全部转绿并纳入 pnpm test、前端 Vitest/Playwright 与 pnpm test:runtime 入口；核对 004 既有用例（apps/server/test/unit/playback/、apps/server/test/contract/playback-*.e2e-spec.ts）无回退，覆盖 plan.md 验证策略第 3 行"浏览不等于播放、意图取消、旧ticket/旧context拒绝、原播放回归"

**Checkpoint**: pnpm lint、pnpm typecheck、pnpm test（server unit/contract + 前端 Vitest）与 pnpm test:runtime 全绿；quickstart §5.2 负向矩阵第 2 条（匿名播放拒绝、旧 ticket/旧 context 拒绝、A→B→A 不复活）与重复点击/换目标竞态用例通过，SC-003 匿名与越权播放负向用例通过率 100%；004 受控播放、转换与限频行为零回退、编解码范围未扩大；真实 PC 浏览器 Network 证据（游客零媒体请求、拒绝响应无源位置/票据泄漏、换档后旧流终止）留待最终验收阶段按 quickstart §4/§8 归档 evidence.md。

---

## Phase 6: User Story 5 - 按节目浏览直播首页 (Priority: P1)
**Goal**: 交付公共直播首页：任何访客无需登录即可在 /live 按固定顺序浏览所有节目单入口（本阶段先占位路由，US6 落地 EPG 墙）、正在直播、即将播放与各来源主分组的正在直播（FR-021）；时间判定与 30 秒更新遵循 FR-022，分类按来源主分组、缺失归其他（FR-023），无节目可用频道显示"暂无节目"仍可经 US3 统一受控播放，即将播放点击仅显示节目时段详情、不伪装可播放未来节目（FR-024），排序与各区 20 项分页按 A-007。本阶段依赖 Phase 2（005 共享契约类型、公共家庭上下文与公共浏览基础/测试夹具）完成，可与 US1 并行推进。
**Independent Test**: 准备多种分类频道、跨日节目、无 EPG 频道及固定时间场景，验证页面顺序和节目时间边界。

### Tests for User Story 5 (REQUIRED) ⚠️
> **NOTE**: 先写这些测试并确保 FAIL
- [x] T057 [P] [US5] 编写直播投影时间边界单元测试 apps/server/test/unit/modules/live/live-projection-time.spec.ts：用固定 nowMs 夹具（不依赖系统时钟）覆盖 FR-022"当前节目 MUST 满足开始时间包含、结束时间不包含"（data-model §8 原文"当前 start<=now<end"）、"下一节目为最早未来节目"（next 取 startsAt>now 的最早项）、跨午夜节目归属、节目间空档（current 为 null 而非误取相邻节目）、重叠节目（api.md §2 原文"重叠当前节目选 startsAt 最近、同起点按 key 升序"，同一频道不得同时出现两个当前节目）、无 EPG 频道（current/next 为 null 但频道仍返回），并断言 EPG 同步失败与成功但无节目区分、频道可用性不由 EPG 是否存在决定（spec Edge Cases）
- [x] T058 [P] [US5] 编写来源主分组解析单元测试 apps/server/test/unit/modules/live/live-grouping.spec.ts：按 data-model §2 逐字验证 source_entry.group_title"TEXT NULL，trim 后 1～100 字符，空白为 NULL"、"对多来源可用频道，按启用 present 关联 (source_id, entry_id) 升序选第一项非空 group_title；无分组为其他"、"公开返回仅分组显示名及不透明 groupKey，不带来源身份或源 URL"，覆盖 FR-023"优先采用频道来源的类型或分组，缺失归入其他，不按标题臆测类型"、多来源多分组时主分组选取稳定、空白/超长 group_title 归一化
- [x] T059 [P] [US5] 编写直播分区排序与分页单元测试 apps/server/test/unit/modules/live/live-sections.spec.ts：按 A-007 原文"正在直播与即将播放分别按当前节目结束时间、下一节目开始时间排序，同时间按频道名称和稳定标识排序"断言 section=now/next/group/all 的顺序在重复运行下稳定、即将播放不施加未确认的 2 小时窗口限制（ui.md §5）、每区默认 20 项可继续查看、pageSize 上限 50（api.md §2"pageSize=20/max50"）、分页可遍历包含无 EPG 可用频道
- [x] T060 [P] [US5] 编写公共直播契约测试 apps/server/test/contract/public-live.contract.spec.ts：以无会话与失效 cookie 两种匿名方式调用 GET /api/public/live/groups、GET /api/public/live/channels（section=now/next/group/all，groupKey?，q?，page，pageSize=20/max50）与 GET /api/public/media/{mediaId}/programmes（非频道 400；无匹配 200 unavailable），断言 ChannelRow={media,groupKey,groupLabel,current,next}；ChannelPage、GroupPage与Programmes三个envelope均含now/timezone/catalogRevision、无 current/next 为 null 时频道本身仍存在、每个响应各自携带now/timezone/catalogRevision同步快照，不要求独立HTTP请求的now相等且 Cache-Control: no-store；负向用例：伪造 householdId/profileId/isAdmin 未知字段一律 400 且不扩大公开查询范围（api.md §1"未知 JSON/query 字段一律拒绝"）、pageSize>50 与非法 section 400、公共响应不含源地址、来源凭据、播放票据或任何 Profile 个人数据（宪章原则三"公开浏览不得授予播放权限，也不得暴露源地址、物理路径、来源凭据、播放票据"）
- [x] T061 [P] [US5] 编写直播页组件测试 apps/web/test/features/live/live-page.spec.tsx 与 apps/web/test/features/live/live-refresh.spec.tsx（Vitest + Testing Library，vi.useFakeTimers 模拟时钟）：断言 FR-021 分区顺序"所有节目单入口、正在直播、即将播放、各类型正在直播"且每区可继续查看、FR-022"直播展示至少每 30 秒更新一次，过期节目不得永久停留"、visibilitychange 回前台立即刷新、时间按服务端返回的家庭时区显示并标注（不依赖浏览器本地时区）、无节目频道显示"暂无节目"占位且保留播放入口、即将播放点击仅展示节目时段（频道与起止时间）且文案不出现预约/回看/立即播放未来节目（FR-024）、公共数据请求 credentials: 'omit'
- [x] T062 [P] [US5] 编写 Playwright e2e apps/web/test/e2e/live.spec.ts：在 Phase 2 建立的 200 频道/7 天 67,200 排期受控夹具（含无 EPG 频道、重叠、跨日）上以游客身份打开 /live，验证分区顺序与频道名/节目名/起止时间展示（FR-021）、固定时间夹具下正在直播与即将播放和后端响应 100% 一致（SC-005）、用 page.clock 模拟推进验证节目变化 30 秒内反映（FR-022）、点击无 EPG 可用频道发起受控播放进入 US3 统一登录选档流程且登录前无媒体流请求、1024/2560 宽与 768 窄窗无整页横向溢出

- [x] T145 [P] [US5] 导入发布分组契约测试：apps/server/test/contract/import-channel-groups.spec.ts 从真实受控M3U导入group-title，刷新后断言source_entry.group_title持久化、空白归NULL、超长输入按既定验证失败处理且不截断伪造分组；多来源稳定主分组、失败刷新保留旧值、重启后/public/live/groups及channels仍正确。不能只直接写分组夹具。（depends on T058、T012）

### Implementation for User Story 5
- [x] T063 [P] [US5] 新建 apps/server/src/modules/live/live.module.ts 与 live-projection.service.ts：从既有 EPG 匹配核心提取不含 ProfilePolicy 的关联解析（manual 失效不回退、否则自动精确关联），单个请求内冻结 now/timezone/catalogRevision 并按同一同步读快照构造公共直播批量投影，实现时间判定核心"当前 start<=now<end"、next 取 startsAt>now 的最早项、重叠节目"选开始时间最近者，同起点按稳定标识确定"，programme 公共 key 由内部 ID 经不透明映射生成、不下发源或 XMLTV ID（depends on T057）
- [x] T146 [US5] 扩展 apps/server/src/modules/imports/ 的M3U解析→暂存→refresh-publish链路，在成功发布事务保存source_entry.group_title（trim后1～100字符，空白NULL）；失败/未确认快照不更新旧目录分组。T006已建字段，本任务只改导入写入与测试；T064/T065须依赖本发布链路验证分类闭环。（depends on T145、T006）
- [x] T064 [US5] 新建 apps/server/src/modules/live/live-grouping.service.ts 并在 apps/server/src/modules/live/live.controller.ts 实现 GET /api/public/live/groups：读取 source_entry.group_title（"TEXT NULL，trim 后 1～100 字符，空白为 NULL"），按"对多来源可用频道，按启用 present 关联 (source_id, entry_id) 升序选第一项非空 group_title；无分组为其他"计算稳定主分组，返回{items:[{key,label}],now,timezone,catalogRevision} 仅含可用频道分组、无源 ID，"公开返回仅分组显示名及不透明 groupKey，不带来源身份或源 URL"（depends on T058、T063、T146）
- [x] T065 [US5] 在 apps/server/src/modules/live/live.controller.ts 实现 GET /api/public/live/channels：支持 section=now/next/group/all、groupKey?、q?、page、pageSize=20/max50，now/next 按 A-007"正在直播与即将播放分别按当前节目结束时间、下一节目开始时间排序，同时间按频道名称和稳定标识排序"，all/group 包含无 EPG 可用频道且 ChannelRow 无 current/next 时为 null、频道本身仍存在，先集合计算媒体可用性与手动/自动绑定映射再批量取节目窗口（不在循环调用单频道授权服务，集合查询次数不随频道数线性增长），响应附 now/timezone/catalogRevision（depends on T059, T063, T064）
- [x] T066 [US5] 在 apps/server/src/modules/live/ 实现 GET /api/public/media/{mediaId}/programmes：返回该频道当前/下一节目（复用 T063 投影与不透明 programme key），按 api.md §2"非频道400；无匹配200 unavailable"，无个人状态、无播放 URL，注册进 live.module.ts（depends on T060, T063）
- [x] T067 [P] [US5] 新建 apps/web/src/features/live/LivePage.tsx、hooks/use-live-sections.ts 与分区组件（NowSection/NextSection/GroupSections），并在 apps/web/src/app/ 注册 /live 路由与 /live/guide 占位路由：页面自上而下为所有节目单入口（本阶段指向占位路由，US6 替换为完整 EPG 墙，占位页不虚构排期数据）→ 正在直播 → 即将播放 → 各类型正在直播（FR-021），section/group/q/page 写入 URL 查询参数作为公共浏览状态、详情返回或登录取消后恢复（FR-045），公共请求 credentials: 'omit' 且失败仅重试本区不拖垮其他区（depends on T061）
- [x] T068 [P] [US5] 新建 apps/web/src/features/live/hooks/use-live-refresh.ts 实现 30 秒周期刷新：FR-022"直播展示至少每 30 秒更新一次，过期节目不得永久停留；时间按家庭时区显示并标注"，时间标签使用服务端返回的 now/timezone/catalogRevision 按家庭时区渲染（R8"服务端返回 now/timezone/revision，避免依赖浏览器本地时区"），页面 visibilitychange 回前台立即刷新，刷新失败保留旧数据并显示可重试提示（depends on T067）
- [x] T069 [P] [US5] 在 apps/web/src/features/live/components/ 实现节目卡与节目时段详情：点击即将播放或历史节目打开频道/节目信息，展示频道与节目起止时间并注明非回看或预约（FR-024"本期不提供预约、录制、回看，频道播放始终指向当前直播，不能伪装成未来节目播放"）；播放按钮与收藏按钮分离，播放统一接入 US3 播放入口播放该频道当前直播，游客收藏先登录选档但不触发播放（depends on T067）
- [x] T070 [P] [US5] 在 apps/web/src/features/live/ 实现无节目频道呈现：无 EPG 或无匹配节目数据的频道卡片显示"暂无节目"明确占位（FR-021"无节目数据时显示明确占位"），该可用频道在全部频道/其他分组区仍可被发现并发起受控播放（FR-023"无节目单的可用频道仍可被发现和播放"，Edge Cases"频道可用性不由 EPG 是否存在决定"，不能将无节目等同无频道）（depends on T067）
- [x] T071 [P] [US5] 直播页响应式与视觉状态 apps/web/src/features/live/：1024/1280/1440/1920/2560×768/1080 卡片列数自适应，768 窄窗/600 高/200% 缩放收拢布局无整页横向溢出（ui.md §8），长节目名截断同时提供完整可读名称、时间数字用等宽数字，加载骨架/空状态/可重试 Alert 齐备且错误不仅靠颜色区分（depends on T067）
- [x] T072 [US5] US5 前后端联调与证据核对：在受控夹具（多分类频道、跨日节目、无 EPG 频道）上运行本阶段全部 unit/contract/组件/e2e 测试（apps/server/test/unit/modules/live/、apps/server/test/contract/public-live.contract.spec.ts、apps/web/test/features/live/、apps/web/test/e2e/live.spec.ts）并确认由 FAIL 转 PASS，核对 SC-005"正在直播和即将播放结果与固定时间夹具 100% 一致，跨日与起止边界不误判；持续打开直播时节目变化在 30 秒内反映"，记录集合查询次数与响应字节供性能验证（depends on T062, T065, T066, T068, T069, T070, T071）

**Checkpoint**: 固定时间夹具下正在直播/即将播放与预期 100% 一致，开始含/结束不含、跨日、空档、重叠、无 EPG 频道用例全部通过；节目变化 30 秒内反映且回前台立即刷新；匿名负向用例（伪造 householdId/profileId、pageSize 超限、公共响应无源地址/票据/个人数据）100% 通过；无节目可用频道可发现并可经 US3 统一流程受控播放；即将播放仅展示节目时段详情；/live/guide 仍为占位路由，EPG 墙本体由 US6 交付。

---

## Phase 7: User Story 7 - 主 Profile 验证后进入统一设置 (Priority: P1)
**Goal**: 主 Profile 管理员从菜单进入设置，经独立 PIN 验证后由服务端签发绑定会话+主档案+三个版本快照的 15 分钟固定授权，设置读取/写入逐请求服务端校验（role、归属、当前档案、状态、版本、expires_at>serverNow）；选档解锁与设置解锁彼此独立，敏感操作仍逐次账号密码（FR-033），忘记 PIN 走账号密码窄用途恢复（FR-030 后半）；本阶段交付设置布局+解锁门+一个可导航空架，七模块内容由 US8 填充。前置依赖：User Story 2（账号配置、登录、首建与选档）全部任务完成后方可开始本阶段。
**Independent Test**: 准备主 Profile、普通成人和儿童档案，分别尝试直接进入设置、PIN 验证、过期后访问及敏感管理操作。

### Tests for User Story 7 (REQUIRED) ⚠️
> **NOTE**: 先写这些测试并确保 FAIL
- [x] T073 [P] [US7] 编写 grant 签发/校验/撤销单元测试（先 FAIL）：验证 settings_access_grant "每设备会话一行"、`expires_at = issued_at + 15 分钟；固定不滑动`（GET/刷新/返回/再次验证均不续期）、`revoked_at` nullable 且"失效后不再恢复"、"授予本身无 bearer，浏览器仅收到 expiresAt 元数据；不进入 localStorage"、profile_id 必须等于当前主 Profile、创建时捕获 profile_context_version/pin_version/main_profile_version 三个版本快照（apps/server/test/unit/settings/settings-access-grant.service.spec.ts）
- [x] T074 [P] [US7] 编写 PIN 验证竞态与失败锁定单元测试（先 FAIL）：覆盖"PIN 验证开始时捕获 pin_version、profile_context_version、main_profile_version、credential_version，在异步哈希完成后事务再读并比对；任一变化拒绝提交，不签发基于旧身份的授予"；哈希计算在事务外、`BEGIN IMMEDIATE` 提交前重验权限快照；连续 5 次错误 PIN 锁 5 分钟且跨刷新、新会话、服务重启保留（持久失败计数，与选档共享错误锁定）；成功验证清除失败计数；PIN 变更/篡改计数不可绕过锁定；错误不泄露 PIN 或哈希（apps/server/test/unit/settings/settings-pin-verification.spec.ts）
- [x] T075 [P] [US7] /settings/access分层契约测试：GET仅要求Session，任何有效会话（含未选档/普通Profile）均200最小SettingsAccess，无有效授予时unlocked=false、expiresAt=null，不读管理主体；POST要求Session+管理角色+当前主Profile+正确PIN，但不得要求已有grant，未选档/普通档案403、PIN锁定423、未知body400；DELETE仅Session、204幂等。游客/无效会话三种操作均401。（apps/server/test/contract/settings-access.routes.spec.ts）
- [x] T076 [US7] SettingsAccessGuard失效矩阵：GET /settings/account代表管理主体；有效Session但grant过期、换档、目标停用、主档案变化或PIN更新导致授权不可用时403；注销、会话/设备撤销、账号密码改动导致Session无效时先401 SESSION_INVALID，不得强行改成403。验证A→B→A不复活、固定15分钟不滑动、启动撤销grant；access最小状态接口仍按T075单独处理。（apps/server/test/contract/settings-access-guard.matrix.spec.ts；depends on T075）
- [x] T077 [P] [US7] 编写忘记 PIN 恢复窄用途契约测试（先 FAIL）：POST /api/auth/main-profile/pin-recovery 仅接受当前管理账号当次密码+新 6 位数字 PIN，目标由服务器确定、伪造 profileId 拒绝；成功仅重设 PIN、清锁定与旧授予、清空目标档案活动身份并中断旧播放，不返回管理主体、不签发 settings grant，之后仍须完成设置 PIN 验证；无密码/错误密码请求不得读取设置或变更 PIN（FR-033：有效设置 grant 也不豁免当次密码）（apps/server/test/contract/main-profile-pin-recovery.spec.ts）
- [x] T078 [P] [US7] 编写前端解锁门与设置布局组件测试（先 FAIL，Vitest/Testing Library）：首次进入 /settings/* 先 GET access，未解锁只显示 PIN 输入且不预取来源/设备/策略等管理主体；403/过期时立即隐藏管理主体、终止轮询、不自动提交草稿并显示"编辑未保存"，重新验证后重读最新现值；有效期内返回/刷新经服务端核验后继续访问无需再输 PIN 且不重置到期时间，客户端定时器只作提示不作为权限事实；宽窗口左菜单/右主体、窄窗口收拢为菜单按钮（apps/web/test/settings-unlock-gate.test.tsx、apps/web/test/settings-layout.test.tsx）
- [x] T079 [P] [US7] 编写 Playwright e2e 测试（先 FAIL）：主 Profile 菜单设置入口→独立 PIN 验证→进入左侧子菜单/右侧主体布局并可导航空架模块；选档解锁与设置解锁独立（选档后进设置仍要求 PIN）；15 分钟到期后访问被服务端拒绝；解锁期间执行要求账号密码的操作（如 PIN 恢复）仍逐次验证（FR-033）；普通成人/儿童档案无设置入口且直达 /settings/* URL 被拒；取消 PIN 输入返回原页面且旧回调不得重开已取消的设置（apps/web/test/e2e/settings-access.spec.ts）

### Implementation for User Story 7
- [x] T080 [US7] settings grant持久化映射与约束复核：在 apps/server/src/modules/settings/使用T006已建立的settings_access_grant及父表复合索引，按T073验证字段、每DeviceSession一行及固定TTL；必要的ORM声明修正仍回到T006的统一schema，不在本任务新建或重复执行0006 DDL。（depends on T073、T006）
- [x] T081 [P] [US7] 新建 apps/server/src/modules/settings/settings-access-grant.service.ts 及模块注册：签发时绑定 household+device_session+当前主 Profile 并捕获三个版本快照、按"每设备会话一行"覆盖写、固定 15 分钟 TTL；校验时"每次设置读取/写入连接 account/device/device_session/profile/household 重新检查 role、归属、当前档案、状态、三个版本及 expires_at>serverNow"；撤销写 revoked_at 且不可恢复；响应仅含 expiresAt 元数据、不发 bearer（depends on T073, T080）
- [x] T082 [P] [US7] 新建 apps/server/src/modules/settings/settings-pin-verification.service.ts：6 位数字 PIN 校验，哈希计算在事务外；"PIN 验证开始时捕获 pin_version、profile_context_version、main_profile_version、credential_version，在异步哈希完成后事务再读并比对；任一变化拒绝提交"；持久失败计数连续 5 次锁 5 分钟、跨刷新/新会话/服务重启保留、成功验证清零、与选档 PIN 共享同一计数；PIN 不进入地址、日志或公共响应（depends on T074, T080）
- [x] T083 [US7] 实现 apps/server/src/common/SettingsAccessGuard.ts，仅挂到一般设置主体读取/写入，次序为Session→角色/当前主Profile→grant→严格入参→敏感操作当次密码→提交前重验。apps/server/src/modules/settings/settings-access.controller.ts单独注册GET/POST/DELETE：GET仅Session返回最小状态，POST用Session+主Profile+管理角色+PIN签发、绝不经过已有grant守卫，DELETE仅Session并204；挂载代表主体GET/settings/account使用SettingsAccessGuard。（depends on T075、T076、T081、T082）
- [x] T084 [P] [US7] 实现 POST /api/auth/main-profile/pin-recovery 窄用途流程（apps/server/src/modules/settings/main-profile-pin-recovery.service.ts + 控制器注册）：仅当前 owner 当次账号密码验证（沿用既有密码错误计数与锁定），目标由服务器确定、不接受 profileId；成功在同一事务重设 6 位 PIN、递增 pin_version、清持久失败计数、撤销该档案选档授予与所有设置授予、清空 active_profile_id、递增 profile_context_version、终态化相关活动播放并撤票；不返回管理主体、不签发 settings grant（depends on T077, T082）
- [x] T085 [P] [US7] 接入授权生命周期撤销钩子（apps/server/src/modules/settings/settings-access-revocation.ts，挂接 auth/profile 模块事务）：在密码改动、会话撤销、实际换档（active_profile_id 变化）、档案停用、主档案转移事务中显式撤销相关 grants，服务端逐请求版本检查作竞态兜底；应用启动 readiness 时"启动时撤销所有 grants"，使备份恢复或进程重启不继承旧授权；普通浏览器刷新不触发撤销（depends on T076, T081）
- [x] T086 [P] [US7] 新建 apps/web/src/layouts/SettingsLayout.tsx 与 /settings/* 路由注册（apps/web/src/app/）：宽窗口左侧子菜单约 220px、右侧主体 min-width:0，窄窗口（768px/600 高/200% 缩放）折叠为菜单按钮或 Select，面包屑/标题显示当前模块；七个子模块导航项全部注册，其中六个为显式占位并标注"模块内容由 US8 填充"，仅账号与安全作为可导航空架经 GET /api/settings/account 读取只读 AccountSummary，不以空白页宣称整合完成；未解锁直达子模块保存目标但不预取管理内容（depends on T078）
- [x] T087 [US7] 新建 apps/web/src/features/settings/ 解锁门与 SettingsAccessProvider：Provider 仅缓存服务器 expiresAt 状态；首次进入先 GET /api/settings/access，未解锁只渲染 PIN 输入（HeroUI v3 Form/TextField，PIN 仅表单内存、关闭即清、不写 localStorage），POST 成功后进入布局；403/过期立即隐藏管理主体、终止轮询、提示未保存编辑，重新验证后重读最新现值；主 Profile 菜单设置入口经统一意图协调器 settings→settingsPin→settingsPage（取消返回原页面并清凭据，旧回调不得重开已取消的设置）；普通 Profile 隐藏入口但所有校验仍在服务端（depends on T079, T083, T086）

**Checkpoint**: T073～T079 全部由 FAIL 转 GREEN，`pnpm lint && pnpm typecheck && pnpm test` 通过；SC-007 负向矩阵通过率 100%（游客/未选档/普通 Profile/仅选档 PIN/伪造解锁/过期/撤销/跨家庭目标全部拒绝，且不返回来源、设备或其他管理数据）；连续 5 次错误 PIN 锁 5 分钟跨刷新/新会话/重启保留；PIN 验证四版本任一变化拒绝提交；"启动时撤销所有 grants"生效；恢复 PIN 仅窄用途、不签发 grant；设置解锁不替代敏感操作当次账号密码（FR-033）；七模块仅占位并标注 US8 填充，不以空白页宣称整合。

---

## Phase 8: User Story 4 - 首页展示当前 Profile 的收藏与点播历史 (Priority: P2)
**Goal**: 游客与未选档用户首页仅见公共区（直播摘要、所有节目单、基础点播入口，FR-015）；登录选档后按 A-005 顺序"收藏频道→点播观看历史"展示当前 Profile 个人区（FR-016）；收藏 PUT/DELETE 幂等（FR-017）、历史仅真正 started 后产生且同 Profile 同媒体单条（FR-018）、进度 10 秒周期+暂停+停止保存、跨设备续播按 epoch 写入权隔离（FR-019）、失效媒体不可用可取消不可播放（FR-020）、换档保留公共浏览条件并即时清个人区废弃在途请求（FR-045）。本阶段依赖 US2（会话/选档/profileContextVersion）与 US3（统一受控播放 resolve/意图协调）已完成。
**Independent Test**: 用两个 Profile 分别收藏不同频道、播放不同点播媒体，在两个设备上刷新并切换 Profile，比较首页。

### Tests for User Story 4 (REQUIRED) ⚠️
> **NOTE**: 先写这些测试并确保 FAIL
- [ ] T088 [P] [US4] 编写收藏服务单元测试（apps/server/test/unit/personal/favorites.service.spec.ts）：断言 data-model.md §4 "主键 (household_id,profile_id,media_id)"、"created_at 首次收藏固定，重复 PUT 不更新；DELETE 不存在也 204，取消后重新收藏为新时间"、非频道或不可用媒体添加拒绝、重复 PUT/DELETE 幂等、"列表按 (created_at DESC,media_id DESC) 键集分页；索引同顺序，以 signed cursor 绑定家庭/Profile/列表类型"、"不可用频道保留关系并返回 unavailable 状态，可取消但不可播放"
- [ ] T089 [P] [US4] 编写进度写入状态机单元测试（apps/server/test/unit/personal/progress-write-machine.spec.ts）：覆盖 resolve→first started→periodic/pause/final 全链——resolve"每次点播 resolve 接受时在短事务分配一个 epoch 并递增；直播不分配。可跳号，不可重置，不接受客户端指定"、只建 playback_progress_state 不写可见历史；"若历史无行或 candidate_epoch > writer_epoch，取得写入权并 upsert 历史；同 owner 继续；旧 candidate 返回 applied=false/superseded"（epoch 抢占）与"各媒体独立比较写入权；较新 session 仅 resolve 未起播不能抢占历史"；"started boolean default false；首次有效客户端 playing 上报后 true；客户端必须收到started确认才提交后续样本"；"允许 position 降低，以支持后退 seek 与从头播放，不能使用 MAX(position)"（后退 seek）；"seq==last 且 digest 相同：返回上次结果，不改变排序或 revision""seq==last 但 digest 不同：409 PROGRESS_SAMPLE_CONFLICT""seq<last：200 applied=false/stale_sample，不覆盖""generation 不同：409 PLAYBACK_GENERATION_STALE，不消耗新序号"（seq/digest 冲突与重复幂等）；"sampleSeq 是该 playback_session 生命周期内单调序号，不在换轨、seek 或组件重渲染时重置"
- [ ] T090 [P] [US4] 编写停止终态与续播读取单元测试（apps/server/test/unit/personal/progress-stop-resume.spec.ts）："normal stop：在同一事务内进行可选 finalProgress 验证及更新，再将 playback 置终态"（final 与终态同事务、失败整体回滚不部分保存）；stale/superseded final 停止成功但不覆盖历史；"已终态重复 stop 204，不接受新 final 更新，不能复活；无 started 的准备取消不建立历史"；未确认 started 即停止只空 stop 不伪造 final；"logout/换档：先尝试最多 1 秒 final flush，结束旧播放，再提交身份变化；失败保存提示，最后确认值保留，身份变化之后旧进度写入拒绝"；续播读取断言"content_revision 不匹配、非有限位置、位置到结尾或无已知可信 duration 时 canResume=false""缺少或无效位置的 resume resolve 从零开始，不删除旧历史"
- [ ] T091 [P] [US4] 编写 /me 收藏与历史契约测试（apps/server/test/contract/me-personal.contract.spec.ts）：正向验证 GET /me/favorites/channels 返回 {items:[{media,createdAt,current,next}],nextCursor}、PUT "204，channel且可用，重复不更新时间"、DELETE "204，已不存在仍成功；允许取消已失效频道收藏"、GET /me/history 按服务端 lastViewedAt 倒序+游标分页、GET /me/history/{mediaId} 返回 HistoryItem 或 200 null；负向用例（宪章原则一/二）：游客/未选档 401 与 403 ACTIVE_PROFILE_REQUIRED、跨 Profile 篡改游标 400 INVALID_CURSOR 不回落其他身份、body 伪造 profileId/householdId 等未知字段拒绝（不接受 body 身份声明）、失效会话（退出/撤销）写入 401、越权收藏（不存在/他家庭/非频道/不可用媒体）400/404、双 Profile 并发读写不串档、个人响应 Cache-Control: no-store 且不嵌入公共详情或共享缓存
- [ ] T092 [P] [US4] 编写播放 progress/stop 协议契约测试（apps/server/test/contract/playback-progress.contract.spec.ts）：POST /playback/resolve 拒绝 body 携带 profileId/householdId/任意 startPosition、频道 startMode=resume 返回 400 PLAYBACK_SEEK_UNSUPPORTED；POST /playback/sessions/{id}/progress 验证会话/当前 Profile/资源修订（409 PROGRESS_RESOURCE_CHANGED）/duration 未知（409 PROGRESS_NOT_READY）/generation 不匹配/会话终态后拒绝/换档后 profileContextVersion 不匹配拒绝；stop 空 body 结束准备、finalProgress 原子提交、无效 final 返回 409/400 且不部分保存；限频"进度每 DeviceSession 60 次/分钟"超限 429+Retry-After；progress 请求体<=16KiB 且未知字段拒绝
- [ ] T093 [P] [US4] 编写 SC-004 指标用例（apps/server/test/contract/resume-precision.contract.spec.ts，双 Profile 双设备夹具）：同 Profile 设备 A 观看至 120 秒并正常停止，设备 B 选择继续观看的位置误差不超过 5 秒、选择从头播放则从零开始；正常局域网播放后模拟异常断开（仅 10 秒周期样本已落库），恢复位置相对断开前最后观看位置的丢失不超过 15 秒；相同 started/periodic 重试不新增历史行；另一 Profile 读取同媒体返回 null 且响应不泄漏 writer_epoch/session 标识（个人数据串档次数为 0）
- [ ] T094 [P] [US4] 编写前端首页个人区隔离单元测试（apps/web/test/home-personal-area.test.tsx）：游客/登录未选档仅渲染公共区（直播摘要前 4、所有节目单入口、点播入口）且不发个人数据请求（场景1）；选档后按 ui.md §4"收藏频道→点播观看历史"顺序渲染，各分区独立加载/空/失败/可重试状态且失败不阻塞公共区（FR-015/016）；切换 Profile/退出立即清空个人区并递增前端 generation，A 的在途迟到响应不得回写 B 或游客页面（场景4、FR-019）；失效收藏/历史媒体显示不可用、可取消收藏、无可运行播放按钮且不当作正在直播节目（场景5、FR-020）；换档后公共浏览条件（搜索/筛选/分页）保留并重载个人数据（FR-045）
- [ ] T095 [P] [US4] 编写前端进度队列单元测试（apps/web/test/playback-progress-queue.test.ts）：首次实际 playing 上报 reason=started 且未收到 ACK 前按同 sampleSeq/payload 重试、周期/暂停样本排队不越过首次样本；每 10 秒周期与暂停立即上报；"首次started确认前禁用/排队用户seek及会重建输出的音轨切换，确认后再执行"；未确认即停止发送空 stop 并提示未保存；断网保留最后成功保存值并提示同步失败、恢复后以原 seq/payload 重试；换档/退出废弃在途请求
- [ ] T096 [P] [US4] 编写 E2E 首页个人区场景测试（apps/web/test/e2e/home-personal.e2e.spec.ts，双浏览器上下文模拟双设备）：复现 spec.md US4 全部 8 个场景——公共区可见性与未选档选档入口、收藏/取消幂等且刷新后一致、真正 started 后才出现历史且重复观看更新同条排最前（仅看详情/解析失败/直播不进历史）、切换即清档、失效媒体不可用可取消、A 正常停止后 B 提供继续观看/从头播放且均经统一受控播放重新授权、位置缺失/无效/到尾仅从头且另一 Profile 无该进度、乱序/重复/伪造他档/失效会话写入被拒且断网退出后恢复此前已保存位置

- [ ] T147 [P] [US4] 内容修订失效集成测试：apps/server/test/contract/import-content-revision.spec.ts 以临时NAS文件导入后产生续播，再改变可信size/mtime并成功发布，断言media_item.content_revision只递增一次、旧canResume=false、旧播放进度拒绝；重复相同发布、只改标题/分级不递增，失败或未确认快照不影响当前修订。（depends on T090、T012）

### Implementation for User Story 4
- [ ] T097 [US4] 个人数据映射与夹具复核：在 apps/server/src/modules/personal/及测试工厂中使用T006已建立的收藏、进度时钟、进度状态、历史四表，核对家庭复合FK、唯一键、排序索引和临时session与历史分离；本任务不重复建表或另改0006。SQL/schema唯一所有者为T006。（depends on T088、T089、T090、T006）
- [ ] T148 [US4] 扩展 apps/server/src/modules/imports/refresh-publish.service.ts 的可信NAS内容变化分支：在发布事务比较已存size/mtime，真实内容变化时递增media_item.content_revision；同一成功快照重试幂等，标题/分级修改不触发。与既有文件输入失效和进度修订校验衔接；T101须在此完成后证明旧位置不继承。（depends on T147、T006）
- [ ] T098 [P] [US4] 实现 apps/server/src/modules/personal/favorites.service.ts 与 /me/favorites/channels 接口（GET/PUT/DELETE）：PUT 幂等（重复不更新 created_at，添加时要求 channel 且可用）、DELETE 不存在也 204 且允许取消已失效频道收藏、(created_at DESC,media_id DESC) 键集分页 signed cursor 绑定家庭/Profile/列表类型、不可用频道保留关系返回 unavailable 摘要、身份仅从服务端当前 Profile 推导（depends on T088, T097）
- [ ] T099 [P] [US4] 实现 apps/server/src/modules/personal/progress-clock.service.ts 并接入 apps/server/src/modules/playback/ 的 resolve 事务：点播 resolve 接受时在短事务分配并递增 epoch（直播不分配、可跳号不可重置、不接受客户端指定），创建 playback_progress_state 记录 candidate_epoch/content_revision/profile_context_version 且不写可见历史；校验 startMode=beginning|resume，频道 resume 返回 400 PLAYBACK_SEEK_UNSUPPORTED，拒绝 body 中 profileId/householdId/startPosition（depends on T089, T097）
- [ ] T100 [US4] 实现 apps/server/src/modules/personal/progress-write.service.ts（写入状态机）与 POST /playback/sessions/{sessionId}/progress 端点：first started 全量校验（会话/真实交付/当前 generation/资源修订/位置）后按"若历史无行或 candidate_epoch > writer_epoch，取得写入权并 upsert 历史；同 owner 继续；旧 candidate 返回 applied=false/superseded"授予写入权；periodic/pause/final 仅已 started 且 owner 匹配可更新且允许 position 降低；seq==last 同 digest 幂等返回上次结果、异 digest 409 PROGRESS_SAMPLE_CONFLICT、seq<last stale_sample、generation 不同 409 PLAYBACK_GENERATION_STALE 不消耗新序号；duration 未知 409 PROGRESS_NOT_READY、资源修订变化 409 PROGRESS_RESOURCE_CHANGED、会话终态或换档后拒绝；限频每 DeviceSession 60 次/分钟（depends on T092, T099）
- [ ] T101 [US4] 实现 apps/server/src/modules/playback/ 的 stop 终态与续播读取及历史查询：stop 在同一事务先验证保存可选 finalProgress 再将 playback 置终态、已终态重复 stop 204 不改历史、无 started 的准备取消不建立历史、stale/superseded final 停止成功不覆盖；换档/退出前最多 1 秒 final flush、身份变化后拒绝旧进度写入；GET /me/history 与 GET /me/history/{mediaId} 返回 HistoryItem={media,lastViewedAt,positionSeconds,durationSeconds,canResume,revision}，canResume"要求 available、同 content_revision、可信 duration 且 0<position<duration"，无记录 200 null；resume 在可信 probe 后、转换输出启动前由服务端重读当前 Profile 历史冻结 presentationStartSeconds，ready 提交仅重验身份/修订/generation 不改已构建输出 offset（depends on T090、T100、T148）
- [ ] T102 [P] [US4] 实现 apps/web/src/features/favorites/：频道详情与直播卡片的独立星标收藏/取消（不冒泡触发播放），游客点击先经统一意图协调器走登录选档（复用 US3），幂等乐观更新+失败回滚可重试，不可用频道显示不可用状态仍可取消收藏（depends on T094, T098）
- [ ] T103 [P] [US4] 实现 apps/web/src/features/history/ 与媒体详情页续播入口：历史卡显示标题/海报占位/最近观看时间/位置，点击进入详情不自动播放；详情按 GET /me/history/{mediaId} 的 canResume 展示"继续观看"与"从头播放"（分别携带 startMode=resume/beginning 进入统一受控播放入口，两者都重新授权），位置无效/到尾/资源变化仅提供从头播放；游客与未选档不发起个人请求、进度不进入公共详情 HTML（depends on T094, T101）
- [ ] T104 [P] [US4] 实现 apps/web/src/features/playback/ 的进度上报队列（usePlaybackProgress）：首次实际 playing 上报 started 并在 ACK 前按原 sampleSeq/payload 重试、其余样本排队；10 秒周期+暂停+停止即时上报；ACK 前禁用/排队用户 seek 与重建输出的音轨切换、ACK 后恢复；停止携 finalProgress、未确认时空 stop 并提示未保存；断网保留最后确认值并提示同步失败；换档/退出废弃在途请求（depends on T095, T100, T101）
- [ ] T105 [US4] 实现 apps/web/src/features/home/ 首页组装：游客公共区（直播摘要前 4/所有节目单入口/点播入口）+选档后个人区（收藏频道→点播历史，首屏各 20 项、本区"查看更多"分页展开）；公共区请求 credentials omit 与个人请求 Session 认证分离、个人缓存键含 Household/Profile/contextVersion；切换 Profile/退出递增前端 generation 即时清空个人区并丢弃迟到响应；个人区失败仅本区重试不阻塞公共区；公共浏览条件跨换档保留（depends on T096, T102, T103, T104）

**Checkpoint**: 运行 pnpm gen:types / lint / typecheck / test / build / test:runtime，US4 新增 unit/contract/web/e2e 全部由 FAIL 转 GREEN；按 quickstart.md §4~§6 以两个 Profile、两台设备浏览器核验 SC-004——设备 A 观看 120 秒正常停止后设备 B 继续观看误差≤5 秒、从头播放为 0、异常断开恢复丢失≤15 秒、相同重试不新增记录、换档/退出/无效位置/失效会话/迟到请求负向用例通过率 100% 且个人数据串档为 0；游客首页无任何个人数据、公共区不因个人区失败受阻；未实测项如实记录，不得将 Proposed 设计提前标为 Verified。

---

## Phase 9: User Story 6 - 在 EPG 墙查看全部频道排期 (Priority: P2)
**Goal**: 从直播页"所有节目单"入口（US5 提供，本阶段开始前 US5 必须已完成）进入 /live/guide 公共 EPG 墙：纵向为频道、横向为时间，按家庭时区展示今天及未来 6 天共 7 天已有排期，默认今天、现在前 30 分钟起 6 小时窗口，支持日期切换、频道分批遍历（含无节目频道）、时间窗浏览、当前时间标识、回到现在与节目详情；未来节目仅展示信息，正在直播节目经 US3 统一受控播放流程播放当前频道；详情返回或取消播放登录恢复原日期、频道与时间位置（FR-025～027、FR-042～045、A-008）。
**Independent Test**: 用 200 个频道、每频道每天 48 个节目、7 天排期的测试数据，完成日期切换、滚动、当前时间定位和节目选择。

### Tests for User Story 6 (REQUIRED) ⚠️
> **NOTE**: 先写这些测试并确保 FAIL
- [ ] T106 [P] [US6] 编写后端单元测试（先 FAIL）apps/server/test/unit/epg/guide-calendar.spec.ts：按 data-model.md §8"以固定 `nowMs` + Household IANA timezone 求今天，日期范围今天～today+6；7 个日历日整体区间 `[todayStart,todayPlus7Start)`"验证日历日转换；DST 23/25 小时日（America/New_York 2026-03-08 / 2026-11-01）按 IANA 真实日界（"该版本无 startOfDay 导出，不采用此 API；禁止简单加 24 小时构造日期边界"）；家庭时区跨日后 allowedDates 滚动、过期 date 返回 409 GUIDE_DATE_EXPIRED
- [ ] T107 [P] [US6] 编写后端单元测试（先 FAIL）apps/server/test/unit/epg/guide-window-query.spec.ts：窗口交叠条件 `starts_at < to AND ends_at > from`、当前判定 `start<=now<end`、跨日节目按窗口交叠；"from/to 必须在该日真实边界且 to>from、跨度<=6 小时"；"一次响应最多 2000 节目/2 MiB，超限 422 GUIDE_WINDOW_TOO_LARGE"不静默截断；"每页最多 50 频道、默认 20"、频道按名称及稳定标识排序、分页可遍历含无节目频道
- [ ] T108 [P] [US6] 编写契约测试（先 FAIL）apps/server/test/contract/public-guide.spec.ts：无 Cookie 匿名 GET /public/guide 返回 GuideWindow{date,timezone,now,allowedDates,from,to,page,pageSize,totalChannels,catalogRevision,channels:[{media,programmes}]}，默认窗口为现在前 30 分钟起 6 小时、响应 no-store、guide 限频 30 次/分钟；负向（宪章原则一/三）：昨天或已过期 date→409 且 error.allowedDates 为新范围、尚未到允许未来范围→400 VALIDATION_FAILED、跨日或>6 小时窗口→422 GUIDE_WINDOW_TOO_LARGE、伪造 householdId/profileId 与未知字段（含夹带 revision）→400 拒绝、EPG 发布或绑定变更后 catalogRevision 递增且不得返回旧快照、响应不含源 ID、XMLTV 原始 ID、路径、个人数据或播放凭据
- [ ] T109 [P] [US6] 编写前端组件测试（先 FAIL）apps/web/test/epg/guide-page.test.tsx：7 日期 Tab 仅今天+6 并标注家庭时区；默认今天、定位"现在前 30 分钟起 6 小时"窗口（A-008，裁剪在可浏览日期范围内）；当前时间标识与"回到现在"；空档与无节目频道显示"暂无节目"、频道不隐藏（FR-026）；频道页默认 20/可改最多 50；409 GUIDE_DATE_EXPIRED 回今天并提示日期已更新、丢弃旧窗口响应；422 时提示缩短窗口并保留频道页
- [ ] T110 [P] [US6] 编写 Playwright 用例（先 FAIL）apps/web/test/e2e/guide-keyboard-scroll-restore.spec.ts：从直播页"所有节目单"入口进入（US5 已建）；键盘 Tab 到可见节目、焦点可见，翻页/换窗后焦点定位到新窗口标题或对应频道，不掉到页面起点或被困于隐藏元素（FR-044）；EPG 局部二维滚动、横向滚动不扩散到页面外，768 窄窗/600 高/200% 缩放无整页横向溢出（FR-043、Edge Cases）；查看节目详情返回或取消播放登录后恢复原日期、频道与时间位置（FR-045）
- [ ] T111 [P] [US6] 编写 Playwright 性能用例与测试夹具（先 FAIL）apps/web/test/e2e/guide-performance.spec.ts：生成 200 频道×每频道每天 48 节目×7 天共 67,200 条排期夹具（含无 EPG 频道、重叠、跨日节目与可用性变化）；以 SC-006 为验证目标：EPG 首个可操作视图≤3 秒、日期切换或回到现在≤2 秒，独立执行 20 次至少 19 次达标，报告记录客户端、服务端硬件与数据规模，不能用空数据结果替代

### Implementation for User Story 6
- [ ] T112 [P] [US6] 时区依赖使用核验：检查T004已在server/web直接声明 @internationalized/date@3.12.4，使用锁定版本完成日界/DST测试；不得再次修改package.json、锁文件或安装依赖，不引入Planby。核验报告记录API无startOfDay导出。（depends on T004）
- [ ] T113 [US6] 实现后端 EPG 纯关联核心与窗口查询 apps/server/src/modules/epg/binding-core.ts、guide-calendar.ts、guide-window.service.ts：复用T063已提取的不含策略关联核心，不重复新建第二套匹配算法；提取 manual 优先、manual 失效不自动回退、否则自动精确关联且不含 ProfilePolicy 的关联解析核心；"使用直接依赖 `@internationalized/date@3.12.4` 的 CalendarDate、fromAbsolute、toCalendarDate、parseDate、toZoned(date,zone,'compatible')；相邻日历日期分别转换为 UTC 日界"；导入排期 UTC 保存、交叠条件 `starts_at < to AND ends_at > from`；programme 补索引 `(household_id,source_id,xmltv_channel_id,starts_at,ends_at)`；"先集合计算媒体可用性及手动/自动绑定映射，再批量取 programme 窗口，不在循环调用单频道授权服务"，guide 集合查询≤8 次（depends on T106, T107, T112）
- [ ] T114 [US6] 实现 catalog revision 与不透明节目 key apps/server/src/modules/epg/catalog-revision.service.ts、programme-key.mapper.ts："EPG 发布/绑定修改同事务递增家庭 catalog revision，读取将 revision 与 now、timezone 一起返回"；"programme 公共 key 由内部 ID 经不透明映射生成，不下发源或 XMLTV ID"（depends on T113）
- [ ] T115 [US6] 实现公共 guide 端点 apps/server/src/modules/epg/public-guide.controller.ts 及 service：GET /public/guide，date=YYYY-MM-DD、from/to 为 UTC、page/pageSize（"每页最多 50 频道、默认 20"），频道按名称及稳定标识排序、"页面可分页遍历所有频道，包括无节目频道"；校验"请求 date 必须在允许范围内，from/to 必须在该日真实边界且 to>from、跨度<=6 小时"，跨日过期"返回 409 GUIDE_DATE_EXPIRED 和新的 allowedDates"，超额"422 GUIDE_WINDOW_TOO_LARGE，返回建议缩短窗口，不静默截断"；匿名可访问、不读身份、no-store、guide 限频 30 次/分钟、未知字段拒绝（contracts/api.md §2）（depends on T113, T114）
- [ ] T116 [US6] 实现前端 EPG 数据层与日期选择 apps/web/src/features/epg/GuidePage.tsx（/live/guide 路由接入 apps/web/src/app）、useGuideWindow.ts、GuideDateTabs.tsx：date/from/channelPage 及视图模式写入 URL 查询参数、公共请求 credentials omit、AbortController 取消过期请求；7 日期 Tab 仅今天+6 并标注家庭时区；默认今天、现在前 30 分钟起 6 小时窗口（裁剪日界）；"回到现在"恢复今天及当前窗口；409 回今天提示日期已更新并丢弃旧窗口响应（depends on T109, T115）
- [ ] T117 [P] [US6] 实现 EPG 墙视图 apps/web/src/features/epg/GuideWall.tsx：纵向为频道、横向为时间，固定频道列与时间头，节目位置用同一 UTC 坐标轴计算并按家庭时区格式化（DST 重复小时 UI 附 offset、缺失小时不补造）；节目展示名称与起止时间、当前时间标识；按前后 6 小时窗口浏览当日全部时段、23/25 小时按真实日长计算；重叠节目当前判定沿用 R8（start<=now<end、取 startsAt 最近、同起点按 key 升序）且视觉不遮住频道点击对象；422 时提示缩短窗口、保留频道页（depends on T116）
- [ ] T118 [P] [US6] 实现按频道列表替代视图 apps/web/src/features/epg/GuideChannelList.tsx：复用同一 GuideWindow 响应、每频道节目按时间排序；空档与无节目频道显示"暂无节目"；使用原生 button/语义列表，节目按钮可读标签含频道、标题、起止，不声明尚未实现的 ARIA grid（contracts/ui.md §6）（depends on T116）
- [ ] T119 [US6] 实现节目详情面板与统一播放衔接 apps/web/src/features/epg/ProgrammeDetailPanel.tsx：宽窗口侧栏、窄窗口 Modal，不与登录模态并行；未来节目仅显示节目时段与频道信息，不提供预约、回看或未来内容播放，提供"观看该频道当前直播"明确按钮并进入 US3 统一播放流程（游客先登录选档，登录前不请求媒体流）；正在直播节目提供当前频道播放；详情返回或取消播放登录后恢复原日期、频道与时间位置（FR-045，滚动锚点保存在当前导航状态）（depends on T117, T118）
- [ ] T120 [US6] 实现 EPG 局部二维滚动、响应式与键盘焦点 apps/web/src/features/epg/GuideScrollContainer.tsx：横向滚动只在墙内、不扩散到页面外；1024/1280/1440/1920/2560×768/1080 自适应无整页横向溢出，768 窄窗/600 高/200% 缩放提供收拢导航或内部滚动（FR-042/043）；键盘完成日期切换、频道分批、窗口与节目操作，焦点可见、翻页/换窗后定位到新窗口标题或对应频道（FR-044）；长名称截断并提供完整可读名称、时间用等宽数字、加载/空/失败状态可辨识，节目标题与简介按不可信内容展示（depends on T117, T118）

**Checkpoint**: T106～T111 测试全部由 FAIL 转 PASS（unit/contract/前端组件/Playwright）；匿名 GET /public/guide 与 /live/guide 页面达到 SC-006 验证目标（200 频道×48 节目×7 天：首个可操作视图≤3 秒、切日/回到现在≤2 秒，20 次至少 19 次达标）；负向用例（伪造日期范围、越权 householdId/profileId、篡改 revision/未知字段）100% 拒绝，公共响应无个人数据、源位置、XMLTV ID 或播放凭据（宪章原则一/三/四）；FR-025～027、FR-042～045 及 Edge Cases（跨午夜、重叠节目、刷新中换日、无节目频道、超长名称）验收通过后，方可进入下一阶段。

---

## Phase 10: User Story 8 - 在 PC 设置中完成配置闭环 (Priority: P2)
**Goal**: 在 US7 交付的 SettingsAccess 守卫与 /api/settings/access 授权之上，落地 FR-034～041 与 FR-048 的配置闭环：后端新建 apps/server/src/modules/settings/ 七个管理子模块并把 household/profile/policy/sources/imports/epg 既有管理路由迁入 /api/settings/* 前缀（领域核心留在原模块仅加守卫），前端在 apps/web/src/features/settings/ 提供七个真实可用页面与逐次密码确认，对应 plan.md 验证矩阵第 6 行"七模块实际读写、密码逐次、TTL/版本失效、直接越权、恢复用途和 CAS"。本阶段全部任务依赖 US7 阶段全部完成。
**Independent Test**: 在已解锁设置中逐项完成代表性读写，刷新并重启服务核对；同时在不同 PC 窗口宽度下完成键盘操作。

### Tests for User Story 8 (REQUIRED) ⚠️
> **NOTE**: 先写这些测试并确保 FAIL
- [ ] T121 [P] [US8] 后端单元测试（先 FAIL）：新建 apps/server/test/unit/settings/version-cas.spec.ts、password-rollback.spec.ts——① 通用设置/档案编辑/PIN重设/策略与名单的expectedVersion CAS及主档案转移的expectedVersion/expectedCurrentProfileVersion/expectedProfileVersion三项CAS：旧版本与伪造版本一律 409 VERSION_CONFLICT、不静默覆盖现值；② 密码改版事务断言 data-model.md"account.credential_version 密码改动递增，并在同一事务撤销该账号全部 device_session 和设置授予"，旧会话与设置解锁立即失效而 Profile 收藏与历史保留；③ 事务纪律断言"管理修改采用 expectedVersion；事务 BEGIN IMMEDIATE，密码/PIN 哈希计算及 I/O 在事务外，提交前重新校验权限快照"：哈希 await 窗口内换档/改 PIN/撤销会话时提交被拒且无部分写入；④ 设备撤销与设备播放记录查询的归属校验
- [ ] T122 [P] [US8] 后端契约测试（先 FAIL）：新建 apps/server/test/contract/settings-management.e2e-spec.ts（可按子模块拆文件）——覆盖 contracts/api.md §6 全部路由代表性读写（account、account/password、household、profiles、profiles/{id}、main-profile、policy、policy/lists、sources、source-roots、refresh、refreshes/{id}、confirm/discard、catalog/candidates/query、catalog/media/{id}、epg-binding 三组、devices 三组）；验证 Settings 次序"存储就绪→Session→角色/当前主Profile→grant有效性→严格入参→当次密码→重读身份/grant/目标归属/版本→事务"与 no-store；负向：游客/普通 Profile/仅选档解锁/伪造 grant 直接请求 403 SETTINGS_ACCESS_REQUIRED、grant 过期 403 SETTINGS_ACCESS_EXPIRED、跨家庭目标 404、缺或错 ownerPassword 拒绝且沿用既有密码错误计数与锁定、旧 expectedVersion 409 不覆盖、未知字段 400、响应不含 PIN/源 URL/票据
- [ ] T123 [P] [US8] 前端单元测试（先 FAIL）：新建 apps/web/test/features/settings/{unsaved-guard,password-confirm,settings-nav,sources-flow}.test.tsx——FR-041 未保存编辑离开或授权过期时明确提示且不自动保存，重新解锁后重读现值再显式继续；每次敏感写独立弹当次密码确认、成功不复用验证态；未解锁只显示 PIN 输入且不预取来源/设备/策略；URL 与选中子模块一致；来源创建成功出现"开始导入"下一步、失败保留上次成功目录状态
- [ ] T124 [P] [US8] Playwright e2e（先 FAIL）：新建 apps/web/test/e2e/settings.spec.ts——已解锁设置中纯键盘（Tab/Enter/Esc，焦点可见、弹窗内部滚动）在 1024/1280/1440/1920/2560 宽度及 768 窄窗/600 高/200% 缩放下完成七子模块各一项代表性读写（改密、建档案+PIN、改策略名单、建 IPTV 来源+手动导入+快照确认、EPG 手动同步+逐频道匹配与解除、撤销设备、改家庭名称/时区）；刷新与服务重启后核对数据持久（data-model.md §3"启动时撤销所有 grants"，重启需重新 PIN 解锁、不复活旧授权）；改密后旧会话失效、新密码重登且收藏历史仍在；返回观看页不重登、节目时间随家庭时区更新

### Implementation for User Story 8
- [ ] T125 [US8] 后端 settings 模块骨架与管理路由迁移：新建 apps/server/src/modules/settings/（settings.module.ts + account/profiles/policy/sources/epg/devices/household 的 controller 与 service），复用 US7 的 apps/server/src/common/ SettingsAccess 守卫与逐次密码验证链；把 apps/server/src/modules/{household,profile,policy,sources,epg} 既有管理端点迁入 /api/settings/* 前缀，sources|imports|epg|profile|policy 保留领域核心仅加守卫，删除旧 /sources、/catalog、/devices 管理入口不保留兼容别名（depends on T121、T122，且 US7 阶段全部完成）
- [ ] T126 [P] [US8] 账号与安全后端：apps/server/src/modules/settings/{account.controller,account.service}.ts——GET /api/settings/account 返回账号信息；PUT /api/settings/account/password 经旧密码验证（沿用既有错误计数锁定规则）后递增 credential_version，落实"account.credential_version 密码改动递增，并在同一事务撤销该账号全部 device_session 和设置授予"（含选档授予、清 cookie），Profile 收藏与历史保留（FR-035）（depends on T125）
- [ ] T127 [P] [US8] Profile 管理与内容权限后端：apps/server/src/modules/settings/{profiles,policy}.*.ts——GET/POST /api/settings/profiles 与 PATCH /{profileId}（创建/编辑/停用/PIN 管理，expectedVersion CAS，"主档案不允许 clearPin"、"不能停用最后一个可用档案；现任主档案须先转移"）；PUT /api/settings/main-profile 主档案转移（expectedVersion校验household.main_profile_version，expectedCurrentProfileVersion校验现任主档案version，expectedProfileVersion校验目标version，三者均CAS，一次事务先去旧标记再设新标记并撤销全部设置授予，响应只返回新主档案 ID 与 mainProfileVersion）；GET/PUT /settings/profiles/{id}/policy 与 policy/lists（等级、未评级、媒体允许/禁止名单、频道白名单，继承 002/003 字段，归属校验+当次密码+CAS）（depends on T125）
- [ ] T128 [P] [US8] 媒体来源后端：apps/server/src/modules/settings/sources.*.ts——迁移 GET/POST /api/settings/sources、PATCH /{sourceId}、GET /settings/source-roots、POST /{sourceId}/refresh（幂等 operationKey）、GET /settings/refreshes/{refreshId} 状态、POST confirm/discard 异常快照确认、POST /settings/catalog/candidates/query、PATCH /settings/catalog/media/{mediaId}；复用 apps/server/src/modules/sources 与 imports 导入内核并加守卫，分组持久化由T146、内容修订发布由T148唯一负责，不在本任务重复实现，写入当次密码+既有 CAS 与源 URL 脱敏；导入失败保留上次成功目录结果（FR-037）（depends on T125）
- [ ] T129 [P] [US8] 节目单管理后端：apps/server/src/modules/settings/epg.*.ts——迁移 EPG 来源配置、手动同步、同步状态、IPTV 关联及 /api/settings/catalog/media/{id}/epg-binding/query、epg-candidates/query、PUT epg-binding（逐频道手动匹配与解除，manual 失效不自动回退）；复用 apps/server/src/modules/epg 核心加守卫，不引入定时同步、模糊匹配或批量匹配（FR-038）（depends on T125）
- [ ] T130 [P] [US8] 设备与会话及通用设置后端：apps/server/src/modules/settings/{devices,household}.*.ts——GET /api/settings/devices、POST /{deviceId}/revoke（当次密码，撤销目标设备全部会话与授予）、POST /{deviceId}/playback-records/query（经必要再验证的播放记录，不能用作个人历史）；GET/PATCH /api/settings/household（家庭名称/语言/时区，timezone 须为运行环境认可的 IANA 时区，"通用设置变更用 version CAS"），节目时间统一按实际家庭时区返回（FR-039）（depends on T125）
- [ ] T131 [US8] 在T086唯一的 apps/web/src/layouts/SettingsLayout.tsx 和既有settings路由中绑定七个实际模块，替换US7阶段的明确占位内容；/settings默认到/settings/account，子路由profiles/policy/sources/epg/devices/general，菜单与地址同步，返回观看保留登录。不得新建layouts/settings-layout.tsx、第二个解锁门或重写共享布局。（depends on T123、T086、T087）
- [ ] T132 [P] [US8] 前端账号与安全/通用设置/设备与会话页面：apps/web/src/features/settings/{account,general,devices}/——账号信息与旧密码改密（成功提示以新密码重新登录）；家庭名称/语言/时区表单带 expectedVersion CAS 保存；设备列表、撤销确认（当次密码）、设备播放记录查看；每敏感操作弹当次密码确认，验证失败不丢表单内容（depends on T131）
- [ ] T133 [P] [US8] 前端 Profile 管理与内容权限页面：apps/web/src/features/settings/{profiles,policy}/——创建/编辑/停用档案、PIN 管理、主档案转移（成功后关闭设置进入切档验证，不静默激活目标）；等级、未评级、媒体允许/禁止名单与频道白名单编辑；409 VERSION_CONFLICT 提示冲突并重读现值，不静默覆盖用户编辑（depends on T131）
- [ ] T134 [P] [US8] 前端媒体来源与节目单管理页面：apps/web/src/features/settings/{sources,epg}/——IPTV/NAS 配置、启停、手动导入、任务状态轮询（授权失效即终止）、异常快照确认；创建成功明确"开始导入"下一步，刷新/发布成功提供查看内容入口，失败提示重试并保留上次成功目录；EPG 手动同步、状态、IPTV 关联、逐频道手动匹配与解除，界面不提供定时/模糊/批量匹配入口（depends on T131）
- [ ] T135 [US8] 未保存编辑与授权过期统一处理：apps/web/src/features/settings/shared/{unsaved-guard.ts,access-expiry.ts,password-confirm-modal.tsx}——离开或切换子模块前拦截未保存编辑并明确提示不自动提交（FR-041）；grant 过期或服务端 403 立即隐藏管理主体、终止轮询，重新 PIN 验证后重读最新版本再显式继续；改密/主档案转移成功回调不再继续读取设置主体（depends on T132、T133、T134）
- [ ] T136 [US8] 阶段验证与证据：T121～T124 测试全部红转绿并随实现通过 pnpm lint、typecheck、test；按 quickstart.md §4"设置模块"行、§5 负向矩阵 1/3、§6 宽度/缩放/键盘项执行，结果留档 docs/specs/005-pc-browsing-flow/evidence.md（SC-008 七模块代表性读写+刷新重启核对、SC-009 宽度与键盘，对应 FR-034～044、FR-048 新环境配置闭环）（depends on T121～T135）

**Checkpoint**: 七个子模块均有真实读写、无空白占位：改密撤销旧会话与设置解锁且保留收藏历史；档案/策略/主档案转移/来源/家庭设置全部 CAS 拒绝旧版本与伪造版本；未保存离开与授权过期不静默覆盖；来源创建有导入下一步、失败保留上次成功结果；EPG 仅手动同步与逐频道匹配；设备可撤销；刷新与重启后数据持久且重启不复活旧 grant；1024～2560 宽度下键盘全流程可用；返回观看页不重登——SC-008 达成，方可进入规格 Verified 前总验收。

---

## Phase 11: Polish & Cross-Cutting Concerns

**Purpose**: 跨用户故事的响应式/浏览器矩阵、新代际闭环、恢复演练、性能与隐私证据、文档同步

- [ ] T137 [P] PC 响应式与键盘全矩阵自动化：apps/web/test/e2e/responsive-matrix.spec.ts——在 1024/1280/1440/1920/2560×768/1080 视口组合及 768 窄窗、600 高、200% 缩放下跑浏览、登录、选档、播放、设置、节目单主操作；断言关键操作遮挡与非预期整页横向溢出为 0、弹窗内容内部滚动、键盘完成全部主流程且无焦点陷阱（FR-042~044、SC-009 自动化部分）
- [ ] T138 真实四浏览器矩阵人工验收：在当前稳定版 Chrome、Edge、Firefox、Safari 中完成 SC-009 主流程（浏览、登录选档、播放、设置、EPG），记录浏览器版本、硬件、时间与结果到 docs/specs/005-pc-browsing-flow/evidence.md（新建，按 quickstart.md 证据格式）；自动化 WebKit 不替代真实 Safari 证据
- [ ] T139 新环境完整闭环 e2e（SC-010）：apps/web/test/e2e/fresh-deployment-loop.spec.ts + apps/server/test/runtime 冒烟——独立临时 DATA_DIR 从空库完成账号配置→首建档案→导入来源→公开浏览→收藏→播放→历史→设置的完整闭环（FR-048）；全程断言源媒体与备份误删次数为 0、无自动清库动作
- [ ] T140 备份恢复与回滚演练：apps/server/test/（或 scripts/演练脚本）——仅对独立临时目录执行 0006 up/down/up；备份恢复验证 data-model.md §10"恢复备份后先撤销授予、标记活动播放中断，再提供 readiness。history 与 favorites 保留"，且下次新 session 的 epoch 大于旧值；演练记录归档 evidence.md；不触碰真实用户库
- [ ] T141 性能与限频证据：在 200 频道×48 节目×7 天夹具、5 个并发浏览器与家庭基线环境下独立执行 20 次测量——EPG/直播首个可操作视图≤3 秒、切日/回现在≤2 秒至少 19 次达标（SC-006）；public IP 与 DeviceSession/progress 限频（429+Retry-After）验证；报告记录测试硬件、浏览器版本与数据规模并归档 evidence.md（SC-001 覆盖率一并核对）
- [ ] T142 隐私与日志复查（负向网络证据）：抓包核对公共/个人/设置响应 no-store、公共响应无任何 Profile 个人数据（FR-003）、日志仅含 requestId、模板路由、耗时、状态、响应字节、批量查询数与稳定拒绝原因——凭据/源位置/票据明文为 0；PIN 与密码不出现在地址、日志、个人缓存或公共响应（FR-033）
- [ ] T143 文档同步收尾：更新 README.md 阶段状态、homeMediaDomainModel.md 与 001/003/004 旧规格的替代关系标注、ADR Superseded/关联标注、docs/specs/005-pc-browsing-flow/checklists/requirements.md 核对；回填 tasks.md 完成状态与证据引用
- [ ] T149 SC-002首次使用者人工验收：邀请至少5名首次使用者，在固定PC/局域网环境无指导完成账号建立→手动登录→首档案→选档→原业务目标，记录匿名参与者编号、任务开始/结束时间、是否求助和完成结果；至少4名在3分钟内独立完成才通过。与T035自动化分开留证到evidence.md，不以脚本执行时间替代真人结果。（depends on T035、T139）
- [ ] T144 最终全量测试与多层证据门禁（verify:release）：在T013基础入口之外完成根package.json的verify:release完整聚合，实际执行全量gen:types、lint、typecheck、build、server与web全部unit/contract/组件测试、全部PC E2E及pnpm test:runtime；每类测试必须发现并执行非零有效用例，所有必需用例通过，按FR/SC核对覆盖清单与预期测试集合。严禁继承基础测试过滤清单、passWithNoTests、业务跳过/only或吞掉失败；完整命令、发现/执行/通过/跳过数量与失败处置须归档。再按quickstart.md §2～§8核对T137～T143/T149的真实浏览器、Network、性能、隐私、恢复和真人验收证据；任何必需项未验证或失败不得发布或标Verified，自动化全绿不替代人工证据。写入docs/specs/005-pc-browsing-flow/evidence.md，全部门禁通过后才将spec从Implementing转Verified。此处是待实施任务，本次不新增实际脚本、执行业务测试或改变完成标记。（depends on T013、T136、T137、T138、T139、T140、T141、T142、T143、T149及全部必需用户故事检查点）

**Checkpoint**: SC-009/SC-010 达成且证据归档 evidence.md；宪章"开发质量门禁"（单元/集成 100%、负向用例通过、运行时与真实契约证据、迁移回滚验证）全部满足；文档与代码同步（原则五原子变更）。

---

## Dependencies & Execution Order

### Phase Dependencies

- **Setup (Phase 1)**: 无依赖，立即可开始；T001 是实施门禁（规格/ADR 接受），未通过不得进入编码任务
- **Foundational (Phase 2)**: 依赖Phase 1完成；T013工具链/骨架冒烟通过后才开放用户故事，不要求后续故事测试提前通过；**阻塞所有用户故事**
- **User Stories (Phase 3~10)**: 均依赖 Phase 2 完成后开始；P1 故事（US1/US2/US3/US5/US7）先于 P2 故事（US4/US6/US8）
- **Polish (Phase 11)**: 依赖全部所需用户故事完成；T144负责最终完整自动化及人工/runtime/Network/恢复门禁，不复用基础清单冒充全量

### User Story Dependencies

- **US1 游客浏览 (P1)**: Phase 2 后即可开始；无故事间依赖（与 US2/US5 可并行）
- **US2 账号配置登录选档 (P1)**: Phase 2 后即可开始；与 US1 并行
- **US3 统一受控播放 (P1)**: 依赖 **US2** 完成（登录/选档流与测试基建）
- **US5 直播首页 (P1)**: Phase 2 后即可开始（与 US1/US2 并行）；播放按钮依赖 US3 才可用（先渲染入口）
- **US7 设置解锁 (P1)**: 依赖 **US2** 完成（选档/主 Profile 语义）
- **US4 首页收藏与历史 (P2)**: 依赖 **US2 + US3** 完成（身份上下文 + 统一播放 started 协议）
- **US6 EPG 墙 (P2)**: 依赖 **US5** 完成（直播页"所有节目单"入口）；节目播放衔接复用 US3
- **US8 设置七模块 (P2)**: 依赖 **US7** 完成（SettingsAccess 守卫与解锁门）

### Within Each User Story

- 测试先行：先写测试并确认 FAIL，再实现
- 后端先于前端联调：模型/迁移 → 服务 → 端点 → 前端数据层 → 页面
- 每个故事按其 Checkpoint 独立验收后再进入下一优先级
- 阶段内[P]仅表示依赖完成后的就绪任务可并行；同一文件/清单/锁文件按所有权串行，不得仅凭标记同时修改

### Parallel Opportunities

- Phase 1: T001后T002（web清单/测试配置）、T003（shared清单/导出）、T005（核验文档）可并行；T004必须等待T002/T003清单完成，独占锁文件并完成安装和生成验证
- Phase 2: T008测试可与T006/T007实现交错编写，但通过须等待实现；T011主题文件与T012夹具可在不同文件并行；T010独占app/PublicLayout/fetch；T013在基础任务完成后只执行工具链与显式骨架冒烟清单，全量聚合留给T144。跨故事同一模块文件由依赖边串行，不按目录不同臆断可并行
- 故事并行（多开发者）：Wave A = US1 + US2 + US5（Phase 2 后同时开工）；Wave B = US3 + US7（US2 完成后）；Wave C = US4 + US6 + US8（各自前置完成后）
- 每个故事内部测试任务 [P] 并行；同故事后端/前端标注 [P] 的任务可按 depends on 边界并行

---

## Parallel Example: User Story 1

```bash
# 并行启动 US1 全部测试任务（先确认 FAIL）：
Task: "T014 契约测试 public-context（apps/server/test/contract/public-context.e2e-spec.ts）"
Task: "T015 契约测试 public-media-list"
Task: "T017 单元测试 public-media-projection"
Task: "T019 前端单元测试 catalog-state"

# 再并行启动互不依赖的实现任务：
Task: "T023 public-catalog 上下文端点（apps/server/src/modules/public-catalog/）"
Task: "T022 前端 shared 底座（apps/web/src/shared/）"

# 三人并行示例（Phase 2 完成后）：
Developer A: US1（公共浏览）
Developer B: US2（账号/登录/选档）
Developer C: US5（直播首页）
```

---

## Implementation Strategy

### MVP First (Phase 1 + 2 + US1)

1. 完成 Phase 1: Setup（T001 门禁是硬前置）
2. 完成 Phase 2: Foundational（CRITICAL——阻塞所有故事）
3. 完成 Phase 3: User Story 1（游客公共浏览）
4. **STOP and VALIDATE**: 用独立测试部署 + 无会话浏览器按 US1 Independent Test 验证
5. 此时即可演示"免登录浏览全部内容"的核心调整价值

### Incremental Delivery

1. Setup + Foundational → 基础就绪
2. +US1 游客浏览 → MVP，可演示
3. +US2 登录选档 → 完整身份链路（SC-002）
4. +US3 统一播放 → 浏览→登录→播放闭环（SC-003）
5. +US5 直播 → 核心公共页面（SC-005）
6. +US7 设置解锁 → 管理边界恢复（SC-007）
7. +US4 首页个人区 → 收藏/历史/续播（SC-004）
8. +US6 EPG 墙 → 节目单全景（SC-006）
9. +US8 设置七模块 → 配置闭环（SC-008）
10. Phase 11 Polish → SC-009/SC-010 与规格 Verified

### Parallel Team Strategy

- 阶段 1~2 全员协作完成
- Wave A（3 人）：US1 / US2 / US5 并行
- Wave B（US2 完成后）：US3 / US7 并行（+US1 完成者转 US6 前置无、可支援 US5）
- Wave C：US4 / US6 / US8 按前置就绪并行
- Polish 阶段全员：浏览器矩阵、性能证据、恢复演练分工归档

---

## Notes

- [P] 任务 = 不同文件且无未完成依赖；同文件任务串行
- [Story] 标签映射 spec.md 用户故事，便于追溯
- 每个故事先写测试并确认 FAIL；宪章要求负向用例（越权/篡改/防伪造）显式存在且通过
- 任务描述中引号内约束逐字来自 data-model.md / contracts，实现不得放宽
- 每完成一个任务或逻辑组提交一次 commit；Checkpoint 处停下验证
- 工作量复核：plan.md 的 16~22 人日粗估未含本清单全部验证细节，以本任务清单实际拆分重估为准（A-011）
- 004 受控播放/转换/限频能力保持零回退（ADR-0009 基线）；FR-047 唯一新流程，不保留旧路由/旧契约双轨
