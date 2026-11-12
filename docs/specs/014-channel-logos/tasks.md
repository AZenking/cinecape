# Tasks: 直播频道 Logo 数据链路 (014-channel-logos)

**Input**: Design documents from `/docs/specs/014-channel-logos/`

**Prerequisites**: [plan.md](plan.md)（必须）、[spec.md](spec.md)（必须，用户故事）、[research.md](research.md)、[data-model.md](data-model.md)、[contracts/](contracts/)、[quickstart.md](quickstart.md)

**Tests**: 宪章原则一强制多层证据：单元/集成契约测试、越权与非法入参负向测试、运行时与真实浏览器证据、迁移回滚演练。契约清单见 [contracts/api.md §4](contracts/api.md)，组件清单见 [contracts/ui.md §4](contracts/ui.md)，运行指南见 [quickstart.md](quickstart.md)。测试任务先写且先失败，再实现。映射到证据后方可宣称 Verified。

**Gate（宪章门禁，不可跳过）**: spec 014 现为 Proposed；T001/T002 是实施前硬门禁（010 T001/T002 先例）。门禁未过，T003 起一律不得开始。

**Organization**: 按用户故事分组。数据管线归 US1（IPTV 主链）与 US4（EPG 兜底 + 生命周期）；代理端点与注册表归 Foundational（全部故事的前置）。

## Format: `[ID] [P?] [Story] Description`

- **[P]**: 可并行（不同文件、无未完成依赖）
- **[Story]**: 所属用户故事（US1–US5 对应 spec.md）
- 描述含精确文件路径；SQLite 列/表约束以 [data-model.md](data-model.md) 为准，实施不得自行放宽

---

## Phase 1: Setup（实施前门禁）

**Purpose**: 宪章硬门禁确认；未确认前不写一行实现代码

- [x] T001 维护者确认接受 spec（将 `docs/specs/014-channel-logos/spec.md` 状态 Proposed → Accepted，附 Acceptance Record；宪章原则一与 010 T001 先例）——2026-11-07 经 `/speckit-implement` 显式指令确认
- [x] T002 设计冻结评审：确认 [plan.md](plan.md)（含 Constitution Check 表）、[research.md](research.md) R1–R10、[data-model.md](data-model.md)、[contracts/](contracts/) 为实施基线；如有修订回写文档后再冻结（010 T002 先例）——随 T001 同批冻结

**Checkpoint**: 门禁通过——spec Accepted + 设计冻结，进入 Phase 2

---

## Phase 2: Foundational（阻塞全部用户故事）

**Purpose**: 迁移、注册表、代理端点——所有故事共用的数据与通道基座

**⚠️ CRITICAL**: 本阶段未完成前，任何用户故事任务不得开始

- [x] T003 创建迁移 `apps/server/src/platform/database/migrations/0009_channel_logos/{up.sql,down.sql}`：按 [data-model §1/§2](data-model.md) 逐字落实——`source_entry.logo_url TEXT NULL`（CHECK：NULL 或 https?:// 且 length 9–2048）、`epg_channel.icon_url TEXT NULL`（同形态 CHECK）、`channel_logo` 表（`(household_id, media_id)` 唯一、`(household_id, ref)` 唯一、`source_kind IN ('iptv','epg')`、`revision >= 1`、`revoked_at IS NULL OR upstream_url IS NULL`、media_item 复合外键 ON DELETE CASCADE、media_source 来源外键）；down 逆序删除；零回填
- [x] T004 在 `apps/server/src/platform/database/schema.ts` 注册同名 drizzle 定义（与 T003 逐列一致）；执行 `pnpm migration:up` 与 `pnpm migration:drill`（up→down→up 全应用 + VACUUM INTO 备份），记录演练输出备 evidence
- [x] T005 [P] 在 shared 问题码常量处注册 `MEDIA_LOGO_REVOKED`/`MEDIA_LOGO_UPSTREAM_FAILED`/`MEDIA_LOGO_UPSTREAM_TIMEOUT`（命名沿 `VOD_UPSTREAM_*` 惯例；packages/shared 问题码注册处）
- [x] T006 [P] `packages/shared/package.json` 的 `gen:types` 追加 `docs/specs/014-channel-logos/contracts/openapi.yaml` 源（010 追加 vod-schema 先例）；执行 `pnpm gen:types` 并通过 typecheck
- [x] T007 [P] 引用签发工具（media-catalog 域）：`crypto.randomBytes(16)` → 32 字符小写 hex；同家庭冲突重签（唯一约束兜底）；单元测试覆盖形态与唯一性（位置：`apps/server/src/contexts/media-catalog/` 域或基础设施层，沿 ADR-0015 仓储 seam 风格）
- [x] T008 `channel_logo` 仓储 + media-catalog 事务参与者镜像方法（`apps/server/src/contexts/media-catalog/infrastructure/transaction-participants.ts` 扩展，沿既有 `DrizzleMediaCatalogTxParticipants` binding 模式）：`findChannelLogo` / `upsertChannelLogoWinner`（url 不变且 active 同源 ⇒ 无操作不换 ref，见 [internal-ports §2](contracts/internal-ports.md)）/ `revokeChannelLogo`（清 upstream_url、置 revoked_at）/ `gcExpiredChannelLogoTombstones` / `setChannelPosterRef`；单元测试覆盖 M1–M4 执行体与墓碑 CHECK
- [x] T009 `LogoProxyService`（`apps/server/src/contexts/media-catalog/application/logo.service.ts`）：`resolveForHousehold`（命中 active → upstreamUrl；墓碑 → 'revoked'；未命中/跨家庭 → undefined）+ SafeUpstream 有界读取（预算数值复用 010 `VOD_POSTER_BUDGETS`：≤2MiB/8s/4s/≤3 跳，不新增参数）+ 仅接受 image/* 且 identity 编码 + 404/410/502/504 DomainError 映射（错误码用 T005）；单元测试用 fake upstream 覆盖全部分支（research R7 分类逐字对照 poster.service mapUpstreamFailure）
- [x] T010 公共控制器 `GET /public/media/logos/:logoRef`（`apps/server/src/contexts/media-catalog/interface/` 新 controller）：`@Controller('public')` + `@RateLimit('public')` + 家庭作用域经 `PublicContextService.requireScope()`（不由客户端指定）；模块装配 + MaxGetDto/参数校验；不缓存字节、响应 `Cache-Control: public, max-age=300`
- [x] T011 契约测试：happy path（fake 上游 image/png ≤2MiB → 200 字节一致 + Content-Type 透传 + `Cache-Control: public, max-age=300`，对照 [api.md §4.6](contracts/api.md)）；fixture 经 T008 仓储直接插注册表行

**Checkpoint**: 基座就绪——代理端点可用，注册表可写，全部用户故事可开工

---

## Phase 3: User Story 1 — 有 Logo 的频道一眼可辨 (Priority: P1) 🎯 MVP

**Goal**: 导入含 `tvg-logo` 的 IPTV 源后，直播墙/首页频道卡片以频道 Logo 为主视觉，跨刷新稳定

**Independent Test**: 导入一份含 tvg-logo 的 M3U 源 → 打开 `/live`：有 Logo 频道显示 Logo，无 Logo 频道维持底板；刷新 3 次无闪变（quickstart §4-1）

### Tests for User Story 1 (REQUIRED) ⚠️

> 先写先失败，再实现

- [x] T012 [P] [US1] 单元测试：M3U 解析捕获与归一化矩阵——`tvg-logo` 正常捕获、缺失→null、trim 后超 2048→丢弃、非 http(s) scheme→丢弃、解析含坏 logo 的整份文件不失败（`apps/server/src/contexts/sources/` 测试目录，对照 FR-001/FR-010）
- [x] T013 [P] [US1] 单元测试：IPTV 发布 M1 合并——有 logo 条目发布后 `channel_logo` 出现 active(iptv) 行、`media_item.poster_ref` = 新引用、url 变化换 ref 且 revision+1、同 url 重发布不换 ref（对照 [data-model §4 M1](data-model.md)）

### Implementation for User Story 1

- [x] T014 [US1] `apps/server/src/contexts/sources/infrastructure/m3u.parser.ts`：EXTINF 经既有 `attrValue` 捕获 `tvg-logo`，解析层归一化（trim、1–2048、仅 http/https，非法→NULL，沿 group_title 先例）；staging 载荷透传（依赖 T012 失败先行）
- [x] T015 [US1] `apps/server/src/contexts/sources/application/refresh-publish.service.ts` + refresh-executor 载荷：IPTV 发布事务内按 M1 调 `upsertChannelLogoWinner(sourceKind='iptv')` → `setChannelPosterRef` → `gcExpiredChannelLogoTombstones`（依赖 T008/T014）；导入成败不受 logo 影响（FR-010 断言入 T013）
- [x] T016 [P] [US1] `docs/specs/005-pc-browsing-flow/contracts/openapi.yaml`：PublicMedia 与直播频道行 `posterRef` description 增补频道 Logo 同源引用语义（含「与 vod posterRef 两域不可互用」）；执行 `pnpm gen:types`（依赖 T006）
- [x] T017 [US1] 新建 `apps/web/src/features/live/components/channel-logo.tsx`：装饰性组件（posterRef 非空 → `<img src="/public/media/logos/{posterRef}">` onLoad 淡入、绝对定位不参与布局流、`alt=""` + aria-hidden）；**实施前按宪章技术约束 8 读 heroui-react 固定基线 3.0.1 相关文档并记录获取日期**；组件测试（加载/成功淡入/同 ref 重渲染不闪变，对照 [ui.md §4](contracts/ui.md) 1/2/5 项的成功路径部分）
- [x] T018 [US1] `apps/web/src/features/live/components/ChannelTile.tsx` 接入：Logo 层置于渐变底板之上、状态签/进度线/播放收藏入口 z 序之上；有 Logo 时首字隐藏（互斥）；布局零位移
- [x] T019 [US1] `apps/web/src/features/live/components/NowHero.tsx` 接入（复用底板与 progressOf 既有结构，仅加 Logo 层）
- [ ] T020 [US1] 运行时证据：真实导入含 tvg-logo 源 → `/live` 与首页直播区块呈现；刷新 3 次无闪变；游客无痕窗口一致；截图/录屏入 `evidence/`（quickstart §4-1；依赖 T015/T018/T019）

**Checkpoint**: US1 独立可用——MVP 交付面；此时 US2–US5 的前置（组件、端点、注册表）均已存在

---

## Phase 4: User Story 2 — 无 Logo 是常态，降级呈现始终成立 (Priority: P1)

**Goal**: 引用缺失、加载失败、上游异常时 100% 回退现有渐变底板+首字；0 裂图、0 空白、0 布局位移

**Independent Test**: 构造 logo 地址失效的频道 → 卡片回退底板呈现，无裂图图标与错误提示（quickstart §4-2）

### Tests for User Story 2 (REQUIRED) ⚠️

- [x] T021 [P] [US2] 契约测试：上游失败族——上游 200 text/html → 502 `MEDIA_LOGO_UPSTREAM_FAILED`；非 identity 编码 → 502 同码；上游挂起超总期限 → 504 `MEDIA_LOGO_UPSTREAM_TIMEOUT`；断言响应体无上游片段（对照 [api.md §4.4/4.5](contracts/api.md)）
- [x] T022 [P] [US2] 组件测试：回退链不变量——posterRef=null 无 img 且首字可见；onError 卸载 Logo 无裂图痕迹；容器尺寸不变；加载中播放/收藏/详情可交互；prefers-reduced-motion 直接显示（对照 [ui.md §4](contracts/ui.md) 1/3/4 项 + a11y 断言）

### Implementation for User Story 2

- [x] T023 [US2] `channel-logo.tsx` 回退态补全：error 卸载、null 直通回退层（依赖 T017；底板层由 T018/T019 宿主承担，本任务不改底板实现——FR-008 原样保留）
- [ ] T024 [US2] 运行时证据：源中某频道 logo 改失效地址并刷新 → 回退底板、DevTools 可见 502/410、页面无错误提示与裂图；截图入 `evidence/`（quickstart §4-2；依赖 T023/T021）

**Checkpoint**: US1+US2 合流——任意 Logo 数据质量下呈现面无劣化（SC-002 可判定）

---

## Phase 5: User Story 3 — 节目单与收藏列表的频道身份辅助 (Priority: P2)

**Goal**: 节目单频道列/收藏列表小 Logo；时间轴网格保持 0 图片

**Independent Test**: 打开节目单：频道列头有 Logo 显示小图、行高不变；时间轴节目格无任何 `<img>`

### Tests for User Story 3 (REQUIRED) ⚠️

- [x] T025 [P] [US3] 组件测试：GuideChannelList 行高不因 Logo 有无变化；收藏区/收藏页有则显示无则现状文字（对照 FR 规则）；**范围守护断言：GuideWall/GuideScrollContainer 渲染结果 img 元素数为 0（SC-006）**

### Implementation for User Story 3

- [x] T026 [P] [US3] `apps/web/src/features/epg/GuideChannelList.tsx` 接入：频道列头小尺寸 Logo（行高不变；依赖 T017）
- [x] T027 [P] [US3] `apps/web/src/features/home/personal-area.tsx` 收藏频道卡接入（依赖 T017）
- [x] T028 [P] [US3] 收藏页频道列表条目接入（`apps/web/src/features/favorites/` 渲染面，依赖 T017）
- [ ] T029 [US3] 运行时证据：节目单列头小 Logo + 时间轴 Elements 搜索 `<img` 为 0 + 收藏条目规则；截图入 `evidence/`（quickstart §4-4；依赖 T025–T028）

**Checkpoint**: 呈现面全覆盖（US1–US3），EPG 网格范围守护自动化

---

## Phase 6: User Story 4 — 源刷新自动同步 Logo，坏数据不阻塞导入 (Priority: P2)

**Goal**: XMLTV icon 捕获与受限合并（M3/M4）、M2 撤销、墓碑 GC、刷新收敛与导入对等性

**Independent Test**: 同频道两版源（含 logo→不含）先后刷新 → Logo 失效回退、旧引用 410；含非法 logo 地址的源导入成功率与不含时相同

### Tests for User Story 4 (REQUIRED) ⚠️

- [x] T030 [P] [US4] 单元测试：XMLTV channel 帧捕获矩阵（首个 icon、缺失、非法丢弃、解析不失败）；M2/M3/M4 合并规则表逐条（epg 绝不覆盖 iptv 胜者、绑定失效撤销 epg 胜者、墓碑 GC 集合删除，对照 [data-model §4](data-model.md)）
- [x] T031 [P] [US4] 单元/集成测试：导入对等性（SC-005，含坏 logo 源 vs 不含对照，成功率相同、耗无可感知劣化）与刷新收敛（SC-004：新增/变更/移除均在刷新后生效）

### Implementation for User Story 4

- [x] T032 [US4] `apps/server/src/contexts/sources/infrastructure/xmltv.parser.ts`：channel 帧捕获首个 `<icon src>`（帧模式照 display-name，受既有限额；归一化同 R1；依赖 T030 失败先行）
- [x] T033 [US4] EPG 发布链：`epg_channel.icon_url` 写入 + EPG 刷新发布事务内受限合并（受影响且已绑定频道集合——绑定判定核心复用 live-projection 的 upstream 精确匹配谓词，禁止复制第三份逻辑，见 [internal-ports §4](contracts/internal-ports.md)）+ M2 撤销 + 墓碑 GC 挂入 IPTV/EPG 两发布事务（依赖 T008/T032）
- [x] T034 [US4] 契约测试：墓碑 410 `MEDIA_LOGO_REVOKED`——发布撤销后旧引用 → 410，窗口 GC 后 → 404 同形（对照 [api.md §4.3](contracts/api.md)；依赖 T033 fixture）
- [ ] T035 [US4] 运行时证据：删除源 logo 属性刷新 → 回退底板；`curl -i` 旧 ref → 410；换新地址刷新 → 新 Logo（quickstart §4-3；依赖 T033/T035 测试绿）

**Checkpoint**: Logo 全生命周期随源数据（SC-004/SC-005 可判定）

---

## Phase 7: User Story 5 — 公共面安全边界 (Priority: P2)

**Goal**: 不泄漏上游地址、伪造/跨家庭不可区分拒绝、游客与登录一致

**Independent Test**: 四类负向请求全部稳定形态且 0 上游片段；网络扫描 0 第三方地址；游客可见一致

### Tests for User Story 5 (REQUIRED) ⚠️

- [x] T036 [P] [US5] 契约测试：伪造随机 32 hex ref → 404 且与「目录资源不存在」逐字同形；双家庭 fixture 跨家庭 ref → 404 与伪造**不可区分**（对照 [api.md §4.1/4.2](contracts/api.md)；宪章原则一负向验收）
- [x] T037 [P] [US5] 契约测试：泄漏面断言——T011/T021/T034/T036 全部响应体（含 message）0 处上游 URL 片段（脚本化断言）；429 + Retry-After 限频行为（§4.8）

### Implementation for User Story 5

- [ ] T038 [US5] 运行时证据：DevTools Network 全量扫描——Logo 请求全部同源 `/public/media/logos/…`、0 第三方地址；游客无痕与登录呈现一致；记录入 `evidence/`（quickstart §4-5；依赖 T036/T037 绿 + US1 呈现面）

**Checkpoint**: 安全边界负向证据闭环（SC-003 可判定）

---

## Phase 8: Polish & Cross-Cutting

**Purpose**: 证据归档、全量门禁、治理流转

- [x] T039 归档 `docs/specs/014-channel-logos/evidence.md` + `evidence/`：迁移演练输出、契约/单元/组件测试全量结果、US1–US5 真实浏览器证据与泄漏扫描记录（quickstart §6；多层证据逐层留证）——自动化层证据已归档（[evidence.md](evidence.md) §2）；真实浏览器证据 Not-run 如实标注（evidence.md §3），T020/T024/T029/T035/T038 执行后补录
- [ ] T040 全量门禁 `pnpm verify:release` + 文档同步核查（README/roadmap 若引用需更新；spec 状态流转 Implementing → Verified 仅在 quickstart §3 全部场景真实通过后）——组件门禁已由 Lead 亲自复跑：typecheck 0 / lint 014 面 0（2 处 013 遗留未提交文件留档）/ server 2334 绿（1 环境性 EPERM 留档）/ web 428 绿 / 迁移 drill 绿 / audit r2=0；`verify:release` 整脚本因 010 既有 poster r1×2 与 knip 等既有缺口未跑绿（evidence.md §2.5），属既有遗留非 014 债务

---

## Dependencies & Execution Order

### Phase Dependencies

- **Phase 1（门禁）**：无依赖，立即开始；T001/T002 未完成前 **T003 起全部禁止**
- **Phase 2（基座）**：依赖 Phase 1；T003→T004 顺序（先 SQL 后 drizzle 演练）；T005/T006/T007 可并行；T008 依赖 T007；T009 依赖 T005/T008；T010 依赖 T009；T011 依赖 T008/T010
- **Phase 3–7（用户故事）**：全部依赖 Phase 2 完成；US2 依赖 US1 的 T017（组件）；US3 依赖 T017；US4 服务端任务只依赖 Phase 2（T033 依赖 T032），US5 依赖对应契约 fixture 存在
- **Phase 8**：依赖全部故事完成

### User Story Dependencies

- **US1（P1，MVP）**：Phase 2 后即可开工，无跨故事依赖
- **US2（P1）**：依赖 T017（复用其组件状态机）；契约测试 T021 仅依赖 Phase 2，可提前
- **US3（P2）**：依赖 T017；三个接入点互相独立可并行
- **US4（P2）**：服务端链路依赖 Phase 2；T035 证据依赖 US1/US2 呈现面
- **US5（P2）**：T036/T037 依赖 Phase 2 + T034 墓碑 fixture；T038 依赖 US1

### Parallel Opportunities

- Phase 2：T005 ∥ T006 ∥ T007（互不同文件）
- US1：T012 ∥ T013（测试先行并行）；T016 ∥ T017（契约注记 vs web 组件）
- US3：T026 ∥ T027 ∥ T028（三接入点不同文件）
- US4：T030 ∥ T031（测试并行）；US5：T036 ∥ T037
- 跨故事：US4 服务端链（T032/T033）与 US3 呈现面（T026–T028）无交集，可并行推进

### Parallel Example: User Story 1

```bash
# 测试先行（并行）:
Task: T012 m3u 解析矩阵单元测试
Task: T013 M1 合并发布单元测试
# 实现期并行:
Task: T016 005 openapi posterRef 注记 + gen:types
Task: T017 ChannelLogo 组件 + 组件测试（先读 heroui 基线文档）
```

---

## Implementation Strategy

### MVP First (US1 only)

1. Phase 1 门禁 → Phase 2 基座（迁移/注册表/端点全绿）
2. Phase 3 US1 → **STOP & VALIDATE**：真实源导入后直播墙呈现 Logo，T020 证据落档
3. 此时可演示：有 Logo 频道主视觉 + 无 Logo 频道不受影响

### Incremental Delivery

- +US2 → 任意数据质量下呈现无劣化（SC-002 闭环）
- +US3 → 节目单/收藏身份辅助 + SC-006 范围守护
- +US4 → 生命周期闭环（SC-004/005）
- +US5 → 安全负向闭环（SC-003）→ Phase 8 全量门禁 → Verified 条件核对

### Notes

- 每任务后或逻辑组后提交；[P] = 不同文件无依赖
- 测试先写先失败（宪章：仅单元测试绝不替代运行时/真实契约证据）
- 禁止跨故事同文件并行：ChannelLogo 组件（T017/T023 顺序）、publish service（T015/T033 分属 US1/US4 但同文件族——T033 在 T015 合并后 rebase 实施并重跑 T013/T030 全套）
