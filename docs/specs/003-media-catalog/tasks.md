# Tasks: 媒体目录与来源（003-media-catalog）

**Input**: 设计文档来自 `/docs/specs/003-media-catalog/`

**Prerequisites**: plan.md（必需）、spec.md（必需）、research.md、data-model.md、contracts/（api.md + openapi.yaml）、quickstart.md 均已就绪；[ADR-0007](../../adr/0007-media-catalog-import.md) 目前为 Proposed，实施前必须接受（见 T001）。

**Tests**: 项目宪章要求测试为必需。每个用户故事包含单元测试与集成契约测试，且必须包含越权/篡改/非法入参负向用例；运行时（真实 HTTP/浏览器）与迁移回滚证据在 quickstart.md 对应章节执行；未取得证据前不得标记 Verified。

**Organization**: 任务按用户故事分组，按明确依赖逐步交付；后续故事可使用前序已完成能力进行验收。优先级顺序：US1(P1) → US2(P1) → US4(P1) → US3(P2)。

**2026-10-24 范围增补**：原任务勾选和验收记录保留为基线历史，不覆盖新增 EPG 手动匹配；T066～T075 全部待执行，SC-010 未验收。当前命令只更新文档，不执行下列实施任务。

## Format: `[ID] [P?] [Story] Description`

- **[P]**: 可并行执行（不同文件、无未完成依赖）
- **[Story]**: 所属用户故事（US1、US2、US3、US4）
- 所有描述含精确文件路径

## Path Conventions

- pnpm monorepo Web 服务：`apps/server/src/`（NestJS）、`apps/web/src/`（React 19 + HeroUI v3）、`packages/shared/src/`、`apps/server/test/`
- 迁移：`apps/server/src/database/migrations/0003_media_catalog/{up,down}.sql`
- 测试约定沿用现有：契约测试 `apps/server/test/contract/*.e2e-spec.ts`、单元测试 `apps/server/test/unit/*.spec.ts`

---

## Phase 1: Setup（前置门禁与依赖）

**Purpose**: 满足宪章与计划门禁，锁定新依赖，确认基线绿色。

- [x] T001 实施前接受门禁：核对维护者对 docs/adr/0007-media-catalog-import.md 的明确接受依据（日期及本次会话/评审记录），有依据后才更新 ADR 状态；未获接受不得由执行代理自行改成 Accepted，也不得启动 T002 或业务实现。门禁满足且正式开始实现时，才将 docs/specs/003-media-catalog/spec.md 从 Accepted 流转 Implementing。本轮文档修复不执行本任务。
- [x] T003 基线验证：在改动前运行 pnpm install --frozen-lockfile、pnpm lint、pnpm typecheck、pnpm test，确认阶段 2 既有用例（109 基线）全部通过并记录数量，作为后续不删旧用例的对照
- [x] T002 新增 sax 流式 XML 解析依赖到 apps/server/package.json（锁定确切版本，启用 strict 模式所需 API），执行 pnpm install 更新锁文件，并把锁定版本回写记录到 docs/specs/003-media-catalog/research.md R2 节

**Checkpoint**: ADR 已接受、依赖锁定、基线绿色，可进入基础层。

---

## Phase 2: Foundational（阻塞所有用户故事的先决条件）

**Purpose**: 0003 数据库迁移、共享类型、配置边界、错误码与测试夹具。⚠️ 本阶段完成前不得开始任何用户故事实现。

- [x] T004 创建 apps/server/src/database/migrations/0003_media_catalog/up.sql：新建 catalog_state（主键 household_id、revision 默认 1）、media_source（kind CHECK 枚举 iptv/epg/nas 且创建后不可转换、name 1~100 字符、remote_url 仅 iptv/epg 必填 nas 必为 null、root_key/relative_directory 仅 nas、private_access_approved 0/1、epg_source_id 仅 iptv 可有值、enabled 0/1、version 正整数默认 1、last_success_at/last_job_id 可空、UNIQUE(household_id,id)）、media_item（type 枚举 channel/movie/series/episode/video、title 1~255、description 可空≤4096、poster_ref 可空、content_level null 或 0~18、title_overridden/type_overridden 0/1、version 正整数）、source_entry（identity_kind 枚举 tvg_id/url/path、identity_digest SHA-256、present 0/1、UNIQUE(household_id,source_id,identity_kind,identity_digest)、file_size_text/file_mtime_ns 十进制文本仅 NAS）、playback_source（protocol 枚举 hls/dash/file/flv/http、priority 默认 100、requires_proxy 默认 0、UNIQUE(household_id,source_entry_id)）、epg_channel（UNIQUE(household_id,source_id,xmltv_channel_id)、conflicted 0/1）、epg_programme（CHECK ends_at>starts_at、UNIQUE(household_id,source_id,xmltv_channel_id,starts_at,ends_at)、复合 FK 绑定 epg_channel）、source_refresh（UNIQUE(household_id,operation_key)、status CHECK、initiator 仅存 account/session ID、expires_at 可空；建部分唯一索引：同 (household_id,source_id) 在 status IN (queued,running,awaiting_confirmation) 至多一个）、refresh_stage_entry（主键 (household_id,refresh_id,entry_key)、kind、payload_json）；全部表显式 household_id，主键逐表遵循 data-model.md：catalog_state 以 household_id 为主键，refresh_stage_entry 以 (household_id,refresh_id,entry_key) 为复合主键，epg_channel 的唯一键为 (household_id,source_id,xmltv_channel_id)，独立业务 id 使用 UUID v4 TEXT；复合外键引用对应表的实际唯一键（不强制所有表新增 id），时间为 UTC，禁止跨家庭关联（对照 docs/specs/003-media-catalog/data-model.md）
- [x] T005 [P] 创建 apps/server/src/database/migrations/0003_media_catalog/down.sql：仅删除本阶段新建的表、索引与 catalog_state 初始化数据，保留阶段 1/2 的身份、PIN 与策略值；注释说明「媒体 ID 不再存在时策略引用保留为失效引用，不自行清空」（对照 data-model.md 迁移与回滚节）
- [x] T006 在 apps/server/src/database/schema.ts 新增 9 张表的 Drizzle 查询 schema（catalogState/mediaSource/mediaItem/sourceEntry/playbackSource/epgChannel/epgProgramme/sourceRefresh/refreshStageEntry），逐列对照 T004 的 DDL，保持「DDL 权威是 migrations/*.sql，查询层同步」的既有约定
- [x] T007 同步运行时基础设施：apps/server/src/database/database.ts 就绪清单加入全部新表（缺表 503）；apps/server/src/database/migrate.ts 的 drill 支持 0003；确认 apps/server/package.json build 脚本将 0003 复制进 dist/database/；同步 apps/server/test/ 中引用固定表清单的既有断言
- [x] T008 创建 apps/server/test/contract/catalog-migration.e2e-spec.ts：在临时库从 0002 升级应用 0003，断言既有 Household 自动获得 catalog_state、阶段 1/2 的身份/PIN/策略值不变；执行 down 后旧数据保留且新表移除、再 up 得到空目录不恢复原媒体 ID；PRAGMA integrity_check 与 foreign_key_check 通过（SC-006 前置）
- [x] T009 [P] 共享契约类型：在 packages/shared/package.json 的 gen:types 追加第 3 条命令，从 docs/specs/003-media-catalog/contracts/openapi.yaml 生成 src/catalog-schema.d.ts（不覆盖 schema.d.ts/policy-schema.d.ts）；在 packages/shared/src/index.ts 独立导出 catalog 类型别名；packages/shared/package.json build 脚本补充复制 catalog-schema.d.ts 到 dist/
- [x] T010 [P] 扩展 apps/server/src/config/env.schema.ts 与 apps/server/src/config/env.ts：MEDIA_ROOTS（rootKey→绝对只读挂载路径映射）、精确 LAN 许可（部署级 host/port/IP 列表，无「允许全部内网」开关）、导入技术预算常量（M3U 10 MiB/20000 条/单行 64 KiB；XMLTV 传输 32 MiB/解压 128 MiB/500000 节目/单字段 64 KiB/嵌套 32 层；NAS 每来源 100000 文件/深度 64/扫描 10 分钟；网络总预算 120 秒/空闲 15 秒/重定向≤3 跳；全局并发执行 1/每来源 1/排队上限 20/待确认 24h），对照 docs/specs/003-media-catalog/research.md R2/R3
- [x] T011 [P] 新增错误码：在 packages/shared/src/constants.ts 与 apps/server/src/common/domain-error.ts 登记 SOURCE_VERSION_CONFLICT、MEDIA_VERSION_CONFLICT、POLICY_VERSION_CONFLICT、REFRESH_STATE_CONFLICT、REFRESH_STALE、SOURCE_BUSY、IDEMPOTENCY_CONFLICT、IMPORT_QUEUE_FULL（附 Retry-After: 5）、SOURCE_TARGET_DENIED、SOURCE_DISABLED 的 RFC 9457 Problem 映射（对照 docs/specs/003-media-catalog/contracts/api.md 错误节）
- [x] T012 [P] 创建测试夹具：apps/server/test/fixtures/ 下新增受控 M3U/XMLTV HTTP 夹具服务（支持 gzip、重定向、超时、非法格式、空文件、大文件与凭据 URL 场景）与临时 NAS 只读根夹具（可构造符号链接/越界路径/size、mtime 变化），并在 apps/server/test/helpers.ts 注册统一启停与注入式时钟（quickstart 先决条件）

- [ ] T061 创建 apps/server/test/contract/catalog-initialization.e2e-spec.ts（先于 T062）：空库先完成 0003 迁移再调用真实 /setup/initialize，断言新家庭唯一 catalog_state revision=1；重复初始化不新增/重置；注入初始化事务失败时家庭/账号/catalog_state 均不部分提交（依赖 T007/T012，FR-001/017）。
- [ ] T062 在 apps/server/src/modules/household/household.service.ts 的 initializeHousehold 现有事务内原子插入 catalog_state（依赖 T004/T006/T061）；0003 migration 只回填已有家庭，新家庭由本事务建立状态，不在只读查询中临时补建。确认 setup.controller.ts 继续调用同一事务入口，不新增绕过；回跑 T061 的初始化断言；首次来源创建后的修订推进在 T018/T020 集成验证。

**Checkpoint**: 基础层就绪——迁移可升可降、共享类型可生成、配置/错误码/夹具齐备，用户故事可开始。

---

## Phase 3: User Story 1 - 接入并维护家庭媒体来源 (Priority: P1) 🎯 MVP

**Goal**: 主账号添加 IPTV 播放列表、节目指南和 NAS 媒体目录，手动刷新后获得可查询目录，并能禁用来源；重复刷新身份稳定，失败保留上次成功目录。

**Independent Test**: 使用受控播放列表、节目指南和临时媒体目录分别完成导入、重复刷新、失败刷新与禁用（quickstart A，SC-001/002）。

### Tests for User Story 1 (REQUIRED) ⚠️

> **NOTE: 先写测试并确认失败，再进入实现**

- [x] T013 [P] [US1] 创建 apps/server/test/unit/imports/m3u.parser.spec.ts：同来源优先 tvg-id、缺失时用完整播放地址作为身份、缺少播放地址的条目非法、重复频道标识冲突拒绝、不使用名称兜底、tvg-id/路径大小写敏感、完整 URL 不删 query、URL 变化视为新身份；预算 10 MiB/20000 条/单行 64 KiB 超限失败；无 EXTINF 频道记录的 M3U8 拒绝作为频道列表（FR-004、research R2/R6）
- [x] T014 [P] [US1] 创建 apps/server/test/unit/imports/safe-http-reader.spec.ts：拒绝 loopback/link-local/unspecified/multicast/云元数据目标/IPv4-mapped IPv6；DNS 解析多地址混入非法地址时拒绝；DNS 重绑定防护（连接固定已验证 IP，每跳重新解析并校验全部 A/AAAA）；重定向≤3 跳且每跳独立连接重新校验；不跟随自动重定向、不继承环境代理；120 秒总/15 秒空闲预算超限失败（research R3）
- [x] T015 [P] [US1] 创建 apps/server/test/unit/imports/nas-scanner.spec.ts：rootKey 必须存在于 MEDIA_ROOTS；拒绝绝对子路径、`..`、空字节、所有符号链接与根外目标（逐层 lstat/realpath 校验）；仅记录相对路径、大小与 mtime 纳秒十进制文本；深度 64/100000 受支持文件/10 分钟超限失败；只读不修改原文件；异步扫描让出事件循环（FR-014、research R4）
- [x] T016 [P] [US1] 创建 apps/server/test/unit/imports/xmltv.parser.spec.ts：sax strict 拒绝 DOCTYPE、自定义/未知实体、畸形 XML、超过 32 层嵌套；gzip 压缩前后独立计数（32 MiB 传输/128 MiB 解压/500000 节目/单字段 64 KiB）；节目时间缺时区即非法、结束必须严格大于开始；仅保留刷新时刻前 24h～后 7d 窗口；channel id 重复或单频道节目时间重叠标 conflicted；缺必要字段使整个导入失败（research R2/R6）
- [x] T017 [P] [US1] 创建 apps/server/test/unit/imports/catalog-diff.spec.ts：暂存 entry_key 与顺序无关规范化摘要 snapshot_digest；added/updated/missing 计数正确；已有非空基线时合法空快照→empty_snapshot、缺失比例 missing/currentPresent≥25%→deletion_ratio_exceeded（分母不得用历史所有行）；首次导入不触发确认；重复 IPTV 身份拒绝且不以最后一条覆盖（FR-005）
- [x] T018 [P] [US1] 创建 apps/server/test/contract/sources-api.e2e-spec.ts：GET /sources、POST /sources、PATCH /sources/{sourceId}、GET /source-roots（对照 contracts/api.md 来源管理节）——owner+当次密码，密码缺失/空串统一 403 REQUIRED 而非 400；locationLabel 仅脱敏远程 origin 主机标签或 rootKey（无 query/path/userinfo）；kind 不可变；NAS 根不可就地修改；remoteUrl 为 null/空串/掩码拒绝；换远程地址须重新 privateAccessApproved 不能继承；expectedVersion 冲突 409 SOURCE_VERSION_CONFLICT；跨家庭/未知目标统一 404；成功 source.version+1 且 catalogRevision+1、旧待确认快照标 stale；非 owner 403；名称 1~100 字符边界；在全新家庭上首次创建来源成功且 catalogRevision 从 1 增到 2，source.version=1；创建与编辑均覆盖 IPTV 合法 epgSourceId 成功、EPG/NAS 携带该字段拒绝、跨家庭/错误类型/自引用目标拒绝
- [x] T019 [P] [US1] 创建 apps/server/test/contract/sources-refresh.e2e-spec.ts（对照 contracts/api.md 刷新与待确认节）：POST /sources/{sourceId}/refresh 返回 202+Location 不等待导入；同 operationKey 相同语义重试返回原任务且仍重新验证身份，改变语义 409 IDEMPOTENCY_CONFLICT；同来源已有 queued/running/awaiting_confirmation 时第二任务 409 SOURCE_BUSY；队列满 429 IMPORT_QUEUE_FULL+Retry-After: 5；网络超时/无法读取/整体格式非法→failed 且保留上次成功目录；空快照与 25% 缺失进入 awaiting_confirmation 后 confirm/discard 流程（ownerPassword+expectedVersion，终态重复操作 409 REFRESH_STATE_CONFLICT，来源/目录基线变化 409 REFRESH_STALE，24h 过期 expired）；禁用源刷新 422 SOURCE_DISABLED；进程重启后 queued/running→interrupted；自动发布前发起会话已撤销→任务失败；RefreshDto counts 全部非负；补 EPG 初次、重复、失败发布的数据库与任务统计断言，失败保留旧窗口，不等待 US4 实现

### Implementation for User Story 1

- [x] T020 [US1] 创建 apps/server/src/modules/sources/sources.module.ts、sources.controller.ts、sources.service.ts 并注册到 apps/server/src/app.module.ts：实现来源三端点+source-roots，SourceDto 按 openapi.yaml Source schema（含 locationLabel 脱敏映射），zod 按 CreateSource/PatchSource 的 allOf 跨字段规则校验（创建 IPTV/EPG 必须 remoteUrl，PATCH 省略地址保留原值；IPTV/EPG 禁 rootKey/relativeDirectory；仅 IPTV 可传 epgSourceId，EPG/NAS 禁传；NAS 必须 rootKey/relativeDirectory 且禁 remoteUrl；IPTV 的 EPG 目标须同家庭 kind=epg、非自引用，允许暂时禁用目标），创建时 source.version=1，更新时 source.version+1；两者事务内 catalogRevision+1，更新时旧 awaiting_confirmation 快照标 stale（依赖 T004/T011/T062）
- [x] T021 [US1] 实现 apps/server/src/modules/imports/safe-http-reader.ts：Node http/https custom lookup 固定已验证 IP、保留原 hostname 的 Host/TLS 验证；每跳独立连接、重新解析校验全部 A/AAAA 并规范化 IPv4-mapped IPv6；拒绝非法地址类别与混合解析；执行 T010 预算（满足 T014）
- [x] T022 [US1] 实现 apps/server/src/modules/imports/m3u.parser.ts：UTF-8 流式解码逐行状态机，支持明确 Extended M3U 字段（tvg-id、tvg-name 等）；执行 T010 预算与单行 64 KiB 上限；任一条目非法则整次导入失败并给出稳定错误码（满足 T013）
- [x] T023 [US1] 实现 apps/server/src/modules/imports/nas-scanner.ts：按 rootKey 解析 MEDIA_ROOTS 绝对路径，逐层 lstat/realpath 校验边界并拒绝符号链接/`..`/空字节/越界；产出相对路径+十进制文本 size/mtimeNs；执行扫描预算并让出事件循环；只读不触碰原文件（满足 T015）
- [x] T024 [US1] 实现 apps/server/src/modules/imports/xmltv.parser.ts：sax strict 流式解析+zlib gzip 流，压缩前后独立计数，禁外部实体；时间必须携带合法时区并统一 UTC 存储；窗口过滤前 24h～后 7d；channel id 重复/时间重叠标 conflicted；缺字段整次失败（满足 T016）
- [x] T025 [US1] 实现 apps/server/src/modules/imports/refresh-staging.service.ts 与 apps/server/src/modules/imports/catalog-diff.ts：解析结果分批写入 refresh_stage_entry（payload 内位置保持私有）；计算顺序无关 snapshot_digest 与条目计数；差异与异常判定（empty_snapshot/deletion_ratio_exceeded，分母 currentPresent，首次导入豁免），阶段结果不进入浏览查询（满足 T017）
- [x] T026 [US1] 实现 apps/server/src/modules/imports/refresh-executor.service.ts（含任务状态机）：请求事务内创建 source_refresh 并依赖部分唯一锁同来源互斥；全局单执行器、排队上限 20 满载 429；任务只存 initiator ID 不存密码；网络/文件 IO 在写事务外；operationKey 幂等（同语义返回原任务）；状态机 queued→running→succeeded/awaiting_confirmation/failed、重启时 queued/running→interrupted、awaiting_confirmation 24h 过期→expired、终态 immutable；自动发布前重验发起会话/设备仍有效；发布单事务：重验来源启用、source.version、catalog revision、job version/摘要、会话有效→稳定 upsert 媒体/条目/资源+mark missing→来源成功信息+job succeeded+catalog revision+1 同事务提交；在本任务内完成 kind=epg 的窗口原子发布、完全相同节目去重、冲突标记和 counts.channels/programmes，不创建 MediaItem 或改变频道分级，不依赖 US4 的节目查询服务。以 T019 中新增的 EPG 初次/重复/失败发布测试先行证明（满足 T019，依赖 T021-T025/T062）
- [x] T027 [US1] 实现 NAS 同路径替换事务（FR-022/SC-009）：在 T026 发布事务内，同来源同相对路径文件 size 或 mtimeNs 变化→保留媒体身份、content_level 置 null、移除当前 Household 全部 Profile 的 allowedMediaIds 该项、保留 blockedMediaIds、每个受影响档案 version 只加一次；读取到损坏策略时整个发布失败不得跳过；size 与 mtime 均未变化保留原配置；并在 apps/server/test/unit/imports/nas-replacement.spec.ts 断言上述规则与「发布失败无部分成功」
- [x] T028 [US1] 在 apps/server/src/modules/sources/sources.controller.ts 扩展刷新端点：POST /sources/{sourceId}/refresh、GET /refreshes/{refreshId}、POST /refreshes/{refreshId}/confirm、POST /refreshes/{refreshId}/discard（对照 contracts/api.md）；确认前 NAS 来源再核对 root 授权与暂存文件 size/mtime 未变否则 REFRESH_STALE 重扫；确认只能发布所确认快照、须当前 owner 家长验证+job expectedVersion；RefreshDto 全字段（status/version/时间/counts/confirmationReason/errorCode）
- [x] T029 [P] [US1] 扩展 apps/web/src/lib/api.ts：按 catalog-schema.d.ts 类型绑定来源/刷新/目录端点封装，提供 2 秒轮询工具（进入终态或页面离开自动停止）、401 回登录处理（依赖 T009）
- [x] T030 [US1] 创建 apps/web/src/pages/Sources.tsx 并在 apps/web/src/App.tsx 注册 /sources 路由：来源列表展示类型/启用/版本/最近成功/任务状态；新增与编辑表单按 kind 显示字段（IPTV：名称/地址/privateAccessApproved；NAS：rootKey/relativeDirectory；地址省略保留现值、掩码禁提交）；刷新按钮+任务状态轮询；待确认摘要与确认/丢弃弹窗（复用 apps/web/src/components/ParentVerificationModal.tsx）；错误仅显示脱敏提示；表单/搜索/弹窗键盘可操作（满足 spec US1 场景 1-4）
- [x] T031 [US1] 扩展 apps/server/test/runtime-smoke.mjs：通过真实 HTTP 创建/刷新三类受控来源并轮询终态，使用独立临时库只读断言媒体/资源/节目持久化、重复导入身份不变、失败保留成功快照；验证禁用来源配置即时生效。此阶段不调用尚未实现的 /media，不宣称已证明观看目录不可见；该观看断言由 T039 完成（依赖 T026/T027/T028/T030；quickstart A，SC-001/002 的来源侧证据）。

**Checkpoint**: 来源管理与导入阶段可独立演示：三类来源原子导入、幂等刷新及失败保留均验证；仅验证启停配置，不宣称观看目录闭环。US1 中“禁用后内容不可见”的验收在 US2 的 T039 补齐后完成，EPG 节目展示在 US4 验收。

---

## Phase 4: User Story 2 - 按当前观看者浏览媒体 (Priority: P1)

**Goal**: 观看者浏览、搜索和查看家庭允许的频道、电影及本地视频；只有当前档案允许的内容可见。

**Independent Test**: 导入真实受控来源，用成人和儿童档案分别查看列表、搜索、详情，比较允许与禁止结果（quickstart B，SC-003/007）。

### Tests for User Story 2 (REQUIRED) ⚠️

- [x] T032 [P] [US2] 创建 apps/server/test/contract/catalog-api.e2e-spec.ts（对照 contracts/api.md 观看目录节）：GET /media（q 最多 100 字符 trim、大小写不敏感字面包含且不把 SQL 通配符当语法；type 枚举；page 默认 1；pageSize 默认 20 最大 100）与 GET /media/{mediaId}——成人/儿童×允许/禁止交集×未评级×儿童频道门槛矩阵；total 与 items 均在权限过滤后产生；被禁内容不出现在计数、详情或关联数据；不可用/不可见/跨家庭/不存在统一同形 404；无 activeProfile 403 ACTIVE_PROFILE_REQUIRED、策略缺失/损坏 503 POLICY_UNAVAILABLE（不作空列表）；伪造 householdId/profileId/role/facts 拒绝；响应不含播放地址、物理路径、来源凭据、upstream tvg-id 或 PlaybackSource；搜索/分页参数只影响筛选不参与授权；poster=null
- [x] T033 [P] [US2] 创建 apps/server/test/unit/catalog/batch-policy-context.spec.ts：列表在单次同步读取中装载有效会话/档案/策略与家庭候选集，调用与详情相同的 evaluatePolicy 顺序；先过滤后搜索/排序/计数/分页（不得先分页后过滤）；排序为 title 二进制顺序再 id 稳定；不逐条 await 造成 N+1（research R7）

### Implementation for User Story 2

- [x] T034 [US2] 实现 apps/server/src/modules/catalog/resource-reader.ts：按 (householdId,mediaId) 读取 media/source_entry/media_source/playback_source 事实，派生「存在 present 条目且来源启用且播放资源记录有效」的可用性（data-model.md media_item 可用性节），供详情授权与批量上下文复用
- [x] T036 [US2] 在 apps/server/src/modules/policy/ 新增批量读取上下文（新文件 policy.batch-context.ts）：单次同步事务内加载会话/档案/策略与有界候选集并复用 evaluatePolicy，输出允许集合供 catalog.service 过滤、搜索、title+id 排序、计数与分页（满足 T033，SC-005 的 10000 条初步实现即为内存有界判定）
- [x] T035 [US2] 创建 apps/server/src/modules/catalog/catalog.module.ts、catalog.controller.ts、catalog.service.ts 并注册到 apps/server/src/app.module.ts：GET /media 与 GET /media/{mediaId} 走 SessionGuard→当前数据库会话/设备/档案有效与归属→最新 ProfilePolicy→同家庭真实资源→判定→MediaDto（id/type/title/description/contentLevel/poster=null/version）；无档案与损坏策略按契约错误返回（依赖 T034/T036）
- [x] T037 [US2] 创建 apps/web/src/pages/MediaCatalog.tsx 并在 apps/web/src/App.tsx 注册 /media 路由：标题搜索、类型筛选、分页控件（默认 20/最大 100）；缺失海报用前端占位；空态区分「无来源/无可见内容/请求失败」三种；键盘可操作搜索与翻页；切换 Profile 后取消在途请求且仅接受仍对应当前会话代次的响应（扩展 apps/web/src/lib/api.ts 请求废弃逻辑）（满足 spec US2 场景 1-4）
- [x] T038 [US2] 创建 apps/web/src/pages/MediaDetail.tsx 并在 apps/web/src/App.tsx 注册 /media/:id 路由：展示标题/类型/描述/分级占位信息；无播放/下载按钮、无第三方跳转；404 时与不存在同形提示（依赖 T035）
- [x] T039 [US2] 扩展 apps/server/test/runtime-smoke.mjs：真实服务+浏览器证据——成人/儿童档案分别列表/搜索/翻页/详情的允许与禁止结果矩阵、直接访问已知被禁 ID 与不存在 ID 同形 404、切换档案后旧在途请求不覆盖新档案目录；补齐 US1 禁用来源后目录不可见、其他启用来源仍可见的真实 HTTP/浏览器断言（依赖 T031/T035/T036/T037/T038；quickstart A/B1/B2/B5，SC-002/003/007）

**Checkpoint**: US1 来源侧与 US2 观看目录侧联合验收完成——目录仅对当前档案允许内容可见。

---

## Phase 5: User Story 4 - 迁移 magi 的 EPG 设置能力 (Priority: P1)

**Goal**: 家长在来源管理页配置独立 EPG/XMLTV 来源并手动刷新查看状态；IPTV 来源可选择可选 EPG，频道详情展示当前/下一节目。

**Independent Test**: 使用受控 XMLTV 来源完成创建、编辑、家长验证、手动刷新、停用、重新启用和 IPTV 关联，核对当前/下一节目；刷新及重启后设置保留（quickstart D，SC-008）。依赖 US1（刷新管线）与 US2（频道授权与详情页）。

### Tests for User Story 4 (REQUIRED) ⚠️

- [x] T040 [P] [US4] 创建 apps/server/test/contract/epg-programmes.e2e-spec.ts：GET /media/{mediaId}/programmes——先同样授权再要求 type=channel（非频道 400）；current 为 startsAt≤now<endsAt、next 为未来 startsAt 最早项；未关联/EPG 禁用/标识冲突/无匹配返回 200 {current:null,next:null,status:'unavailable'}；频道本身被禁止仍 404；仅按频道条目所属 IPTV 来源的 epg_source_id 内 tvg-id 与 XMLTV 频道标识精确匹配；同一 EPG 可被多个 IPTV 来源复用；多有效来源共享媒体时按 source_id 升序取第一个有效且精确且不冲突的关联；节目跨日与显式时区断言（FR-007/FR-020）
- [x] T041 [P] [US4] 创建 apps/server/test/contract/epg-settings.e2e-spec.ts：PATCH /sources/{sourceId} 的 epgSourceId 校验（仅 IPTV 可有值、必须同家庭 kind=epg、不得自引用、允许关联暂时禁用的 EPG）；EPG 地址省略保留现值、掩码不能作为新地址保存；列表/错误/日志中地址凭据脱敏；并发旧 expectedVersion 409；EPG 刷新成功 counts.channels/programmes 正确；失败不清空上次成功指南；重启后 running→interrupted 可见且可手动重试；非 owner/错误密码/跨家庭/过期版本全部拒绝（FR-018/FR-019/FR-021）

### Implementation for User Story 4

- [x] T042 [US4] 创建 apps/server/src/modules/epg/epg.module.ts 与 epg.service.ts 并注册到 apps/server/src/app.module.ts：基于 T020 已校验的来源级关联和 T026 已发布的指南窗口，查询当前/下一节目（UTC 存储、家庭时区展示）；精确匹配、无匹配/冲突/禁用降级和多来源取舍按 T040。此服务只读，不承担 US1 发布前置职责（依赖 T020/T026/T034；满足 T040）。
- [x] T043 [US4] 在 apps/server/test/contract/epg-settings.e2e-spec.ts 与 apps/server/test/runtime-smoke.mjs 联调复核 T026 已实现的 EPG 发布链：通过真实设置/刷新 API 验证窗口替换、去重、冲突、频道/节目 counts、失败保留、重启中断与重试，确认发布结果可被 T042 查询。不得把首次 EPG 发布接线延后到此任务（依赖 T026/T028/T041/T042；供 T047 汇总）。
- [x] T044 [US4] 在 apps/server/src/modules/catalog/catalog.controller.ts 增加 GET /media/{mediaId}/programmes：复用 T035 授权链后调用 epg.service，按契约返回 Programmes（status available/unavailable）（依赖 T042）
- [x] T045 [US4] 扩展 apps/web/src/pages/Sources.tsx：EPG 来源表单仅名称/地址/启用三字段，首次刷新即完成导入（无重复「导入」入口、无单独连通性检查）；IPTV 编辑表单提供同家庭可选 EPG 下拉（关联禁用 EPG 允许并提示暂无节目）；展示执行中/成功/失败状态、最近成功时间、频道/节目数量与脱敏错误；失败/中断提供重试入口（依赖 T030/T043）（满足 spec US4 场景 1-5）
- [x] T046 [US4] 扩展 apps/web/src/pages/MediaDetail.tsx：展示当前/下一节目标题与起止时间（按家庭时区渲染）；未关联/禁用/冲突/无匹配显示「暂无节目」；不显示任何来源地址（依赖 T038/T044）（满足 spec US4 场景 6）
- [x] T047 [US4] 扩展 apps/server/test/runtime-smoke.mjs：EPG 全流程真实证据——保存设置持久化、手动刷新成功/失败、并发刷新拒绝、禁用/重新启用、重启中断与手动重试、IPTV 关联后频道详情当前/下一节目；失败/中断保留上次成功数据；负向（非 owner/错误密码/跨家庭/过期版本/敏感值泄漏）全部拒绝或不泄漏（quickstart D、SC-008）

**Checkpoint**: EPG 设置、同步与展示闭环可用，且不影响 US1/US2 已验证行为。

---

## Phase 6: User Story 3 - 配置真实媒体黑白名单 (Priority: P2)

**Goal**: 主账号通过独立家长管理入口选择同家庭媒体，编辑媒体允许/禁止名单与儿童频道允许名单。

**Independent Test**: 将超限媒体加入允许名单、再加入禁止名单，验证儿童下一次目录查询分别允许和拒绝（quickstart B3/B4，SC-004）。

### Tests for User Story 3 (REQUIRED) ⚠️

- [x] T048 [P] [US3] 创建 apps/server/test/contract/catalog-candidates.e2e-spec.ts（对照 contracts/api.md 家长候选与人工修正节）：POST /catalog/candidates/query——owner+当次密码（密码缺失 403 REQUIRED），绕过观看策略但仍限同家庭、可含 unavailable 候选及 available 布尔、不返回文件路径或流地址、密码不出现在 URL；PATCH /catalog/media/{mediaId}——expectedVersion 必填、title（1~255）/type/contentLevel（null 为恢复未评级、0~18）至少一项；禁止 channel 与非频道互转；非频道四类间可改；不建立 Series/Episode 层级；成功 media.version+1 且 catalogRevision+1；人工标题/类型不被普通刷新覆盖；跨家庭/不存在 404 同形；版本冲突 409 MEDIA_VERSION_CONFLICT
- [x] T049 [P] [US3] 创建 apps/server/test/contract/policy-lists.e2e-spec.ts：PUT /profiles/{profileId}/policy/lists——三名单（allowedMediaIds/blockedMediaIds/allowedChannelIds）必填数组整体替换；每名单去重后≤1000（含 1000/1001 边界）、每 ID 长度 1~128、大小写敏感；allowedChannelIds 仅接受 type=channel 的媒体；每个 ID 校验同 Household 归属，任一非法整体失败且原策略不变；目标 Profile 归属 Household+Account 校验与是否 active 无关；expectedVersion 冲突 409 POLICY_VERSION_CONFLICT；允许/禁止交集保留；现有 PUT /profiles/{profileId}/policy（等级与未评级）不扩充名单字段且共享同一策略版本；NAS 自动清理递增版本后旧版本保存被拒（FR-012/FR-022）

### Implementation for User Story 3

- [x] T050 [US3] 在 apps/server/src/modules/catalog/ 实现家长候选查询与人工修正：POST /catalog/candidates/query 与 PATCH /catalog/media/{mediaId}（candidates 查询每次带 ownerPassword、不创建长期家长令牌、不将密码写入日志或缓存）；候选查询可含不可用媒体但同样不返回位置（依赖 T035；满足 T048）
- [x] T051 [US3] 扩展 apps/server/src/modules/policy/policy.service.ts 的 writePolicyLists：增加 expectedVersion 同事务检查与每 ID 资源归属/频道类型校验（整体成功或失败），返回阶段 2 PolicyDto 且 version+1；保持现有等级写入入口语义不变、两入口共享版本（依赖 T011/T034/T049；满足 T049）


- [ ] T063 [US3] 在 apps/server/src/modules/policy/policy.controller.ts 注册 PUT /profiles/{profileId}/policy/lists，复用既有 policy.module.ts 注册链；严格校验三名单/expectedVersion，SessionGuard→owner→当次主账号密码→重验会话/设备→Profile 归属→T051 的版本/资源归属/类型校验事务，明确密码缺失 403、越权 403、跨家庭目标 404、旧版本 409，保留既有等级 PUT 不变（依赖 T049/T051，补齐控制器/模块/API 调用接线）。
- [ ] T065 [US3] 在 apps/server/test/runtime-smoke.mjs 中补人工元数据修改的真实 HTTP 断言，并在 docs/specs/003-media-catalog/quickstart.md B 的实际浏览器执行场景中先定义失败验收：家长编辑标题、非频道类型、分级/恢复未评级；错误密码、非法等级、跨类别频道变更、409 不改原值，表单保留非敏感输入且清空密码；保存后重载持久、后续普通刷新不覆盖人工标题/类型，分级改变后目录权限按新值生效。真实浏览器结果回填 evidence.md，不将 Node HTTP 脚本宣称为浏览器证明（依赖 T048/T050/T038，先于 T064）。
- [ ] T064 [US3] 新增 apps/web/src/components/MediaMetadataEditor.tsx 可复用表单，并在 apps/web/src/pages/MediaDetail.tsx 接入 owner 可见的人工标题/非频道类型/分级编辑（复用 ParentVerificationModal.tsx），必要时扩展 apps/web/src/lib/api.ts 和 App.tsx 的已存在路由；读取用已授权详情，本任务只接已授权详情，隐藏内容的编辑由后续 T052 在已验证家长候选中接入同一组件，不把未实现的 T052 当作本任务前置；不能绕开观看权限。PATCH 通过 T050，携带当前 media version，成功更新界面版本、409 提示重载；仅家长验证成功后保存，清空密码、错误保留非敏感表单；复跑 T065 的详情侧浏览器场景，候选侧场景待 T052/T053 联合验收（依赖 T050/T063/T065，T064 与 T052 串行；FR-006/013、SC-007）。
- [x] T052 [US3] 扩展 apps/web/src/pages/ProfilePolicy.tsx 并按需在 apps/web/src/components/ 新增资源选择器组件：逐次家长密码查询候选（含不可用标记），接入 T064 的 MediaMetadataEditor.tsx 为隐藏/不可用的已验证候选提供人工修正，再选择加入允许/禁止/儿童频道名单、保存时再次验证；取消/失败清空密码但保留非敏感表单；409 冲突提示重新加载；全程键盘可操作（依赖 T050/T051/T063/T064）（满足 spec US3 场景 1-4）
- [x] T053 [US3] 扩展 apps/server/test/runtime-smoke.mjs：真实流程证据——超限媒体加入允许名单后儿童可见、再加入禁止名单后不可见（禁止优先）；owner 未验证时不能查询候选或保存；两设备查询在策略变更后另一设备下一请求生效；完成 T065 候选侧真实浏览器编辑与保存后的权限变化验收（依赖 T052/T064/T065；quickstart B3/B4/B5/B6，SC-004/007）

**Checkpoint**: 四个用户故事在所列依赖满足后全部可用，前序回归不被破坏。

---

## Phase 7: Polish & Cross-Cutting Concerns

**Purpose**: 跨故事的安全、性能、迁移演练与验收证据。

- [x] T054 [P] 扩展 apps/server/test/unit/log-redaction.spec.ts：断言 sources/catalog/epg/imports 新模块的日志、错误与暂存输出不含 URL 凭据、物理路径、原始 XML/上游报文或请求体，仅含稳定 code、来源/任务 id 与数量（FR-015、research R3）
- [x] T055 [P] 创建 docs/specs/003-media-catalog/evidence.md：按 SC-001～SC-009 建立证据骨架（命令、日期、脱敏 Network/后端响应、浏览器结果、新增用例数），实施过程中逐项回填，不预填通过（quickstart 证据与完成条件）
- [x] T056 SC-005 性能证据：构造 10000 条内容数据集，真实浏览器连续 20 次搜索/翻页至少 19 次页面展示≤2 秒；刷新期间仍可浏览上次成功快照；记录硬件、容器限制、数据集与内存实际值（不将空闲样本当峰值）；不达标先优化批量查询/索引，不引入外部服务（quickstart G）
- [x] T057 SC-006 升级/回滚/恢复演练：按 docs/specs/003-media-catalog/quickstart.md F 在临时库建立阶段 2 身份/PIN/策略→升级 0003 核对旧值不变→导入目录并设名单→停服取得一致性备份和媒体 ID/节目/策略版本快照。分两段验证并回填 evidence.md：①独立副本 down/up 后身份/PIN/策略及失效名单引用保留，目录为空、旧媒体 ID 未恢复；②再实际恢复回滚前备份，核对原媒体 ID、资源、节目和策略版本恢复，并运行 integrity_check、foreign_key_check。不能以 down/up 替代备份恢复，全程仅临时库/独立卷。
- [x] T058 容器双架构冒烟：ARM64 原生与 AMD64（如仿真须注明）容器验证非 root、只读 NAS 挂载、独立卷、自动迁移、SPA 与 healthz、重启持久化、缺新表/迁移 503（quickstart G）
- [x] T059 全量回归与验收执行：pnpm lint、pnpm typecheck、pnpm test、pnpm build、pnpm test:runtime 全绿；确认阶段 2 既有 109 用例未被删除或削弱；按 quickstart A～G 逐项执行并将结果回填 docs/specs/003-media-catalog/evidence.md
- [x] T060  **暂缓执行（非完成）**：门禁要求「全部 SC 证据通过」；当前证据齐备除两项环境门控缺口——①真实浏览器渲染层证据（仓库无浏览器测试工具）②容器双架构冒烟 T058（本机 Docker daemon 不可用），均已在 docs/specs/003-media-catalog/evidence.md「当前验收状态」节如实记录。两项证据在具备浏览器与容器运行时的验收环境补测后，执行本任务将 spec.md 状态流转为 Verified 并同步 plan.md；此前 spec 保持 Implementing（宪章：不预填通过）。

---

## Dependencies & Execution Order

### Phase Dependencies

- **Setup (Phase 1)**: 无依赖，立即开始；T001（接受 ADR-0007）是宪章硬门禁，必须最先完成
- **Foundational (Phase 2)**: 依赖 Phase 1；完成前**阻塞所有用户故事**
- **US1 (Phase 3)**: 依赖 Phase 2
- **US2 (Phase 4)**: 依赖 US1（需要真实导入的媒体数据验证授权矩阵）
- **US4 (Phase 5)**: 依赖 US1（刷新管线）与 US2（频道授权/详情页/programmes 端点挂载点）
- **US3 (Phase 6)**: 依赖 US1 和 US2 的 T035/T038；默认在 US4 后执行，避免共享控制器、详情页、App.tsx、api.ts 与运行时脚本并行写入
- **Polish (Phase 7)**: 依赖全部所需用户故事完成

### User Story Dependencies

- **US1 (P1)**: Foundational 后即可开始，无其他故事依赖
- **US2 (P1)**: 依赖 US1 的目录数据；不依赖 US3/US4
- **US4 (P1)**: 依赖 US1 执行器与 US2 catalog 模块；不依赖 US3
- **US3 (P2)**: 依赖 US1 与 US2（T035/T038）；US4 完成后按阶段顺序执行，或仅在明确文件所有权后安排不重叠部分

### Within Each User Story

- 测试先行：先写本故事测试并确认失败，再写实现
- 模型/服务在端点之前；核心实现之后才做 UI 集成
- 故事完成即可在 checkpoint 独立验证

### Parallel Opportunities

- Phase 1：T001 → T003（原始基线）→ T002（安装依赖）严格串行；两个 pnpm install 不可并行
- Phase 2：T004→T005/T006→T007→T008/T061（先失败）→T062（初始化实现并复跑）；T009→T011 串行（共享 index.ts/构建类型），T010、T012 可在依赖明确且不运行冲突安装时并行。所有 pnpm 依赖/生成/构建操作串行
- Phase 3：T013-T019（7 个测试任务）全部可并行；T029 与服务端实现并行；T021-T025 在接口约定确定后可并行
- Phase 4：T032、T033 可并行；T034/T036 完成后 T035；T037→T038 串行（共享 App.tsx）
- Phase 5：T040、T041 并行
- Phase 6：T048、T049 可并行；T050/T051/T063 完成后，T065 先建立失败浏览器场景，再 T064/T052 串行接 UI；同控制器、App.tsx、api.ts 不并行写
- 跨故事默认 US1→US2→US4→US3；可并行仅限不同文件的测试/纯模块，必须满足显式依赖；runtime-smoke.mjs 的 T031/T039/T043/T047/T053 串行

---

## Parallel Example: User Story 1

```bash
# 并行启动全部 US1 测试（7 个独立文件，互不依赖）：
Task: "apps/server/test/unit/imports/m3u.parser.spec.ts"
Task: "apps/server/test/unit/imports/safe-http-reader.spec.ts"
Task: "apps/server/test/unit/imports/nas-scanner.spec.ts"
Task: "apps/server/test/unit/imports/xmltv.parser.spec.ts"
Task: "apps/server/test/unit/imports/catalog-diff.spec.ts"
Task: "apps/server/test/contract/sources-api.e2e-spec.ts"
Task: "apps/server/test/contract/sources-refresh.e2e-spec.ts"

# 测试失败确认后并行启动解析器实现（独立文件）：
Task: "apps/server/src/modules/imports/safe-http-reader.ts"
Task: "apps/server/src/modules/imports/m3u.parser.ts"
Task: "apps/server/src/modules/imports/nas-scanner.ts"
Task: "apps/server/src/modules/imports/xmltv.parser.ts"
```

---

## Implementation Strategy

### MVP First (User Story 1 Only)

1. 完成 Phase 1：Setup（先接受 ADR-0007）
2. 完成 Phase 2：Foundational（迁移/类型/配置/夹具——阻塞所有故事）
3. 完成 Phase 3：User Story 1
4. **STOP and VALIDATE**：执行 quickstart A 的来源侧导入/刷新/启停配置验证；观看目录断言待 US2 T039
5. 此时只演示来源管理；完成 US2 后才可演示授权目录 MVP

### Incremental Delivery

1. Setup + Foundational → 基础就绪
2. +US1 → 独立验证来源侧导入能力（不宣称观看目录闭环）
3. +US2 → 观看授权目录可浏览
4. +US4 → EPG 设置与节目展示闭环
5. +US3 → 名单管理闭环
6. Polish → 性能/迁移/容器证据齐备后流转 Verified

### Parallel Team Strategy

1. 团队共同完成 Setup + Foundational
2. 之后：开发者 A → US1；开发者 B → （US1 完成后）US2→US4；开发者 C → （US2 完成后、且 US4 共享文件改动合入后）US3
3. 各故事在独立 checkpoint 验证后合入，互不破坏

---

## Notes

- [P] 任务 = 不同文件、无未完成依赖
- [Story] 标签对应 spec.md 用户故事以便追溯
- 每个故事满足前序依赖后可验收；测试先失败后通过
- 每任务或逻辑组完成后提交一次
- 任意 checkpoint 可停下独立验证当前故事
- 避免：模糊任务、同文件并行冲突、破坏故事独立性的跨故事依赖
- 宪章红线：所有权限相关任务必须包含负向用例证据；单测不能替代运行时/真实契约证据


## Phase 8: User Story 5 — EPG 手动匹配增补（2026-10-24，待实施）

**Goal**: 在详情/家长候选中搜索并绑定指南频道，手动优先、刷新保留、失效不回退，解除后恢复自动；不放宽观看权限。
**Prerequisites**: 原 US1/US2/US4 服务与来源级自动匹配可用（T020/T026/T034/T035/T042/T044/T045/T046）；隐藏频道管理复用 US3 已验证候选（T050/T052/T063/T064）。原任务勾选不替代检查其真实实现；缺失依赖须先完成，不能通过切换未授权详情绕过。

- [x] T066 [US5] 增补实施门禁已过：维护者于 2026-10-25 在实施会话中明确接受 ADR-0008 与 spec 增补（FR-023～026/SC-010），依据已记录于 ADR-0008 状态行与 spec.md 增补状态（Proposed → Implementing）。本轮只设计，保留原范围 Verified 的历史证据，新增范围不得预填通过（FR-023～026）。
- [x] T067 [US5] 先在 apps/server/test/contract/manual-epg-migration.e2e-spec.ts 编写失败测试：既有0003库→0004后原目录/节目/身份/PIN/策略不变、既有来源 generation=0、频道无手动配置且自动行为不变；down/up 不宣称恢复手动配置；实际恢复回滚前备份后绑定/版本/指南恢复，integrity_check/foreign_key_check通过（依赖 T066，SC-010）。
- [x] T068 [US5] 新增 apps/server/src/database/migrations/0004_manual_epg_binding/{up,down}.sql、同步 database/schema.ts、database.ts 必需表/列就绪检查、migrate.ts 演练清单与契约夹具；只新增 manual_epg_binding 和 media_source.epg_generation，复合家庭 FK、mode/目标配对 CHECK、version约束；无绑定/auto墓碑/手动模式规则按 data-model.md。禁止修改已实施0003。回跑T067；更新 packages/shared/package.json 的既有 catalog 类型生成链，不覆盖旧schema（依赖 T067）。
- [x] T069 [US5] 先在 apps/server/test/contract/manual-epg-binding.e2e-spec.ts 和 test/unit/epg/manual-binding.spec.ts 建立失败矩阵：管理读取/搜索/预览/保存/解除；同家庭不同默认EPG可选、非频道400、跨家庭404、owner与密码/锁定/撤销校验；无行version0→manual1→auto2→重配3，旧0/1保存409；来源/频道必须成对、候选非冲突且已启用成功导入，候选generation变化409；无节目仍是有效绑定，候选无源地址（依赖 T066/T068，FR-023～026）。
- [x] T070 [US5] 在 apps/server/src/modules/epg/manual-epg-binding.service.ts 实现管理读取与版本事务；manual保存即锁定，解除写auto墓碑不删行；校验媒体频道/Household/来源/候选generation，写绑定version+1与catalog_state.revision+1同事务。修改 apps/server/src/modules/imports/refresh-executor.service.ts 实际EPG成功发布路径（必要时其发布模块）：同事务epg_generation+1，失败不加，不写/删绑定表；在T069中注入写失败证明无部分提交（依赖 T068/T069，与原导入实现共享文件串行）。
- [x] T071 [US5] 在 apps/server/src/modules/epg/ 新增管理控制器并注册既有 epg.module.ts；接线 POST /catalog/media/{mediaId}/epg-binding/query、POST /catalog/media/{mediaId}/epg-candidates/query、PUT /catalog/media/{mediaId}/epg-binding。每次owner+密码、校验后重验会话和目标，返回no-store。扩展 epg.service.ts 普通节目读取：授权后manual唯一优先，invalid不自动回退，无manual/auto才沿用FR-007。新增响应元数据和错误码，生成 packages/shared/src/catalog-schema.d.ts（只在实施时），补404不泄漏与旧自动行为回归（依赖 T070/T069，FR-023～026）。
- [x] T072 [US5] 在 apps/web/src/components/epg/EpgBindingDialog.tsx 实现来源选择、ID/名称搜索、分页/节目预览、现绑定/失效原因、保存锁定/解除恢复自动；接入 pages/MediaDetail.tsx 和已验证家长候选组件（沿用既有实际结构，不另建工作台）。复用ParentVerificationModal，扩展lib/api.ts类型调用；来源切换清空旧候选/generation，409重载，取消/失败清密码并保留非敏感表单；隐藏频道只经已验证候选管理。与T052/T064和已有api.ts编辑串行（依赖 T071/T050/T052/T064）。
- [x] T073 [US5] 扩展 apps/server/test/runtime-smoke.mjs 的真实HTTP与重启证据：不相同tvg/XMLTV ID绑定后手动节目正确，来源默认EPG改变不覆盖，IPTV/EPG刷新/重启保留，目标消失/禁用/冲突invalid且无回退，恢复同ID重新有效；无当前节目valid+unavailable；解除恢复自动；新/旧version及generation冲突、撤销会话/越权不改数据。记录SC-010，不能复用旧128断言数字冒充新增结果（依赖 T071）。
- [x] T074 [US5] 已完成（2026-10-25）：迁移演练 7 场景全过（0004 升级不变量/down 手动丢失/up 只恢复自动/备份恢复原绑定与版本/drill 含 0004 校验）；容器双架构（arm64 原生+amd64 仿真）0004 自动迁移、必需列缺失 503、深度冒烟（绑定非默认源+刷新/重启保留）全过；浏览器全链路（ego-browser Chromium：详情入口/密码/来源选择/候选预览/保存锁定/409 CANDIDATE_STALE/解除恢复自动/密码清除）；全部回填 evidence.md「手动 EPG 增补证据（US5，SC-010）」节（依赖 T067/T068/T072/T073）。
- [x] T075 [US5] 已完成（2026-10-25）：全仓 lint/typecheck/test/build/runtime 回归全绿（406→456 用例、runtime 128→205 断言，旧场景未删）；FR-023～026/SC-010 证据齐备后 spec.md 增补状态流转 Verified、plan.md 与 evidence.md 同步；无环境缺口（依赖 T074）。

**Execution order**: T066→T067→T068→T069→T070→T071→T072/T073→T074→T075。T072与T073仅在没有共享文件写入时可并行；所有schema/迁移、发布模块、shared生成和旧控制器写入串行协调。本文不自动执行接受或实现。
**Requirement coverage**: FR-023→T069/T071/T072；FR-024→T069/T070/T071/T073；FR-025→T070/T071/T073/T074；FR-026→T067/T069/T070/T071；SC-010→T067/T073/T074/T075。
