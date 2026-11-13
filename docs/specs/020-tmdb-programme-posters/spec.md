# Feature Specification: TMDB 节目海报接入与最小化调用缓存

**Feature Branch**: `020-tmdb-programme-posters`

**Created**: 2026-11-13

**Status**: Implementing（实现完成；自动化门禁通过，真实 TMDB 运行时证据待补）

**Governance**: 遵循 `.specify/memory/constitution.md`。重点对齐原则一（规格驱动与多层证据）、原则三（公开浏览与受控播放分离）、原则四（自托管/隐私优先、显式 household 边界）、原则五（ADR 与非破坏性演进）、技术约束 3（可逆迁移）、6（DDD 边界）、8（HeroUI v3 + 语义 token）。

**Related ADRs**:
- [ADR-0021: TMDB 节目海报与本地缓存](../adr/0021-tmdb-programme-posters.md)
- [ADR-0010: 公开浏览与播放分离](../adr/0010-public-browsing-playback-separation.md)
- [ADR-0015: 仓储抽取](../adr/0015-repository-extraction.md)

**Input**: 用户要求：「接入 TMDB；节目单海报通过一定规则匹配；以尽量少调用 TMDB 接口的方式缓存节目单数据。」

---

## User Scenarios & Testing *(mandatory)*

### User Story 1 - 游客在节目单看到节目海报 (Priority: P1)

游客打开 `/live/guide`，选择任意频道。已匹配到 TMDB 电影/剧集海报的节目在节目单墙、列表与详情抽屉展示 2:3 海报；未匹配、通用栏目、TMDB 未配置或图片加载失败时，回退为频道 Logo/首字，节目单文字与时间轴不受影响。

**Why this priority**: 海报是节目单可读性的核心视觉信息，同时必须保证无外部依赖时页面完整可用。

**Independent Test**: 启动服务并配置 TMDB Key，导入一个包含已知电影标题的 XMLTV 源；刷新后在墙/列表/详情看到海报。移除 Key 重启后，同一节目单仍正常展示，海报位置回退且无控制台错误。

**Acceptance Scenarios**:
1. **Given** 某频道节目标题归一化后与 TMDB movie/tv 标题完全一致且存在 poster_path，**When** EPG 刷新成功，**Then** 该节目 DTO 返回非空 `posterRef`，墙/列表/详情通过同源代理加载海报。
2. **Given** 节目为新闻/天气/广告或标题无法匹配，**When** 节目单加载，**Then** `posterRef` 为 null，界面回退频道 Logo 或首字，不显示裂图。
3. **Given** 海报图片请求失败，**When** 图片 onError，**Then** 仅该海报位置回退，不阻塞节目块点击、播放或键盘操作。
4. **Given** 未配置 TMDB Key，**When** 用户浏览节目单，**Then** 页面与未接入前一致，服务端不发起任何 TMDB 请求。

---

### User Story 2 - 管理员以最小 API 调用完成匹配与回填 (Priority: P1)

管理员只在服务端环境变量中配置 TMDB Key。EPG 刷新后系统自动对去重后的节目标题做一次本地缓存查询，仅对缺失/过期标题调用 `search/multi`；重复标题、有效缓存标题和读取请求均不产生调用。首次导入未覆盖的标题可用 CLI 回填。

**Why this priority**: 用户明确要求「尽量少调用接口」；缓存与节流是功能成立的前提。

**Independent Test**: 同一 EPG 源连续刷新两次；第一次日志有 lookups，第二次 `lookups=0`。浏览节目单期间 fake TMDB 客户端计数不增加。执行 `tmdb:backfill -- --limit=500` 可继续补全。

**Acceptance Scenarios**:
1. **Given** 一次 XMLTV 解析出 1000 条节目但只有 80 个不同标题，**When** 刷新发布，**Then** 网络检索次数 ≤80，且同一标题只查一次。
2. **Given** 某标题已 matched 且未过期，**When** 下一次 EPG 刷新，**Then** 直接复用缓存 ref，不调用 TMDB。
3. **Given** 某标题 no_match 未过期，**When** 下一次刷新，**Then** 不重复检索；过期后才重新检索。
4. **Given** 单次刷新标题数超过 `TMDB_MAX_LOOKUPS_PER_RUN`，**When** 补全运行，**Then** 达到上限即停止，剩余标题留待下次刷新或 CLI。
5. **Given** TMDB 返回 401/429/5xx/超时，**When** 补全运行，**Then** 按熔断/退避/短 TTL 处理，EPG 刷新仍标记成功。

---

### User Story 3 - 安全、可回滚的公共海报代理 (Priority: P2)

客户端只看到不透明 `posterRef`，不接触 TMDB ID、API Key 或上游 URL。代理按家庭边界解析引用，有界读取图片，跨家庭/伪造/过期引用 404 同形，上游失败 502/504。

**Why this priority**: 公共浏览不得泄漏内部标识或引入 SSRF/滥用面；迁移必须可逆。

**Independent Test**: 伪造 ref、其他家庭 ref、过期 ref 均 404；有效 ref 返回 image/*；上游注入失败返回 502/504；`pnpm migration:down` 可回滚 0012。

**Acceptance Scenarios**:
1. **Given** 客户端提交 31 位或非 hex ref，**When** 请求代理，**Then** 404 NOT_FOUND，不查询上游。
2. **Given** ref 属于另一家庭，**When** 当前家庭请求，**Then** 404 同形。
3. **Given** 缓存行 `expires_at <= now`，**When** 请求代理，**Then** 404，前端回退。
4. **Given** 上游返回非 image/* 或非 identity 编码，**When** 代理读取，**Then** 502 `PROGRAMME_POSTER_UPSTREAM_FAILED`。
5. **Given** 迁移已应用，**When** 执行 down→up，**Then** 表/列/索引恢复且既有 `epg_programme` 数据不丢失。
6. **Given** 同一 IP 一分钟内请求超过 `mediaImage` 限频，**When** 继续请求，**Then** 429 + Retry-After，不影响其他公共 API 的 120/min 桶。

---

### User Story 4 - 合规署名与隐私说明 (Priority: P3)

应用在公共布局底部展示 TMDB 署名与声明；README/`.env.example` 说明启用后节目标题会发送给 TMDB，留空 Key 即关闭。

**Why this priority**: TMDB API Terms 与项目隐私优先原则要求。

**Independent Test**: 任意公共页面底部可见 TMDB logo + 声明链接；README 有启用/关闭/缓存期限/非商业说明。

**Acceptance Scenarios**:
1. **Given** 任意公共页面，**When** 页面渲染，**Then** footer 含 TMDB 署名与「未获 TMDB 认可、认证或批准」声明。
2. **Given** 未配置 Key，**When** 阅读 README，**Then** 明确功能默认关闭且不发送标题。

---

### Edge Cases

- 标题含全角/半角标点、`《》`、季集后缀、清晰度后缀、年份：归一化后精确匹配；年份冲突拒绝。
- 同名不同年份/影剧：按年份优先、popularity/release date/tmdb id 确定性决胜；无法确定则 no_match。
- TMDB 返回 person、adult、无 poster_path：忽略。
- 标题为通用栏目（新闻联播/天气预报等）：停用表直接 no_match，不调用 TMDB。
- 标题过长/为空/归一化后不足 2 字符：跳过，不写缓存。
- 同一标题在多个频道/多个来源：一个 household 缓存键，所有节目共享。
- 同一刷新内重复标题：只查一次。
- 缓存过期但 TMDB 不可用：不再下发旧 ref，前端回退；下次刷新重试。
- 缓存 ref 因 post_path 变化而轮换：旧 ref 404；新 ref 在同一事务更新到节目行。
- 服务端与 CLI 同时运行：最多 2 条请求；建议避开刷新时段。
- 部分迁移库缺列：发布路径走旧 SQL，功能静默跳过，不崩溃。
- 图片 CDN 不可达：502/504，前端回退；本期不做服务端图片落盘。

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: 后端 MUST 支持通过环境变量启用/关闭 TMDB；Key 为空时不得发起任何 TMDB 网络请求。
- **FR-002**: 节目标题 MUST 经确定性归一化后作为缓存键；归一化规则 MUST 处理中文/英文、全角/半角、年份、季集、清晰度、栏目前缀与通用栏目停用表。
- **FR-003**: 匹配 MUST 只接受归一化标题完全相等的 movie/tv 候选；MUST 过滤 person/adult/无海报；年份冲突 MUST 拒绝。
- **FR-004**: 每个新/过期标题 MUST 最多一次 `search/multi` 调用；MUST NOT 调用详情/图片/季集接口。
- **FR-005**: 匹配结果 MUST 持久化到 `programme_poster`，包含 state/ref/TTL/来源元数据；matched TTL MUST ≤180 天；no_match 默认 30 天；failed 默认 60 分钟。
- **FR-006**: EPG 发布事务 MUST 写入 `epg_programme.poster_match_key`；缓存命中的 `poster_ref` MUST 在发布时写入，避免刷新后海报丢失窗口。
- **FR-007**: 发布后补全 MUST 先恢复有效缓存，再仅对缺失/过期标题联网；MUST 受单次上限、最小间隔、总预算与熔断约束。
- **FR-008**: 公共读取路径 MUST 只读本地 `poster_ref`；MUST NOT 在请求路径调用 TMDB API。
- **FR-009**: 公共 DTO `Programme` MUST 增加 `posterRef: string|null`；guide/live/epg/manual-binding 全部生产者一致返回。
- **FR-010**: 公共海报代理 MUST 按 `(household_id, ref)` 解析；MUST 校验 32 位小写 hex、matched 状态、未过期、poster_path 形态；失败 404 同形。
- **FR-011**: 图片读取 MUST 经 SafeUpstream 有界读取，仅接受 image/* 且 identity；失败 502/504；不落盘。
- **FR-012**: 代理 MUST 使用独立 `mediaImage` 限频桶（600/min/IP），不占用公共 API 的 120/min 桶。
- **FR-013**: 前端 MUST 在墙/列表/详情展示海报；加载失败/无 ref MUST 回退；图片 MUST lazy/async。
- **FR-014**: 公共布局 MUST 展示 TMDB 署名与免责声明。
- **FR-015**: 迁移 0012 MUST 支持 up/down/drill；readiness/precheck/EXPECTED_* MUST 同步。
- **FR-016**: 提供 `tmdb:backfill` CLI，复用同一补全服务，支持 `--limit`/`--dry-run`/`--household`，默认补齐旧行 `poster_match_key`。
- **FR-017**: 日志 MUST 脱敏：不得输出 API Key、完整检索 URL、标题列表；只输出汇总计数与稳定码。
- **FR-018**: 无 Key/断网/401/429/5xx MUST 不改变 EPG 刷新成功状态与公共接口 200 语义。

### Key Entities

- **ProgrammePosterCache**: `(household_id, match_key)` → state/ref/TTL/TMDB 元数据；每标题一行。
- **EpgProgramme（扩展）**: 增加 `poster_match_key`、`poster_ref`；节目行可被删除重建，缓存跨刷新保留。
- **Programme DTO（扩展）**: `posterRef` 为不透明引用，public 只读。
- **TmdbMatch**: 纯值对象，包含 tmdbId/mediaType/posterPath/title/originalTitle/year/popularity/score。

## Success Criteria *(mandatory)*

- **SC-001**: 配置 Key + 一次 EPG 刷新后，至少一个可精确匹配节目在墙/列表/详情展示海报；无匹配节目回退且无裂图。
- **SC-002**: 同一标题在 TTL 内跨刷新/跨频道只产生一次 API 调用；第二次刷新日志 `lookups=0`。
- **SC-003**: 公共 guide/live/programmes 请求对 fake TMDB 客户端产生 0 次 search 调用。
- **SC-004**: 1000 条节目/80 个不同标题的刷新，网络检索 ≤80；超过单次上限时按上限停止。
- **SC-005**: 无 Key/断网/401/429/5xx 场景，EPG 刷新状态仍为 succeeded，guide 仍 200。
- **SC-006**: 伪造/跨家庭/过期/格式非法 ref 100% 404；有效 ref 返回 image/*；上游失败 502/504。
- **SC-007**: `migration:drill` 通过；0012 up→down→up 后既有 `epg_programme` 行数不变。
- **SC-008**: `pnpm lint`、`pnpm typecheck`、server/web tests、`pnpm build` 全绿。
- **SC-009**: 公共页面 footer 含 TMDB 署名与声明；README 含启用/关闭/隐私/条款说明。
- **SC-010**: `tmdb:backfill -- --dry-run` 可统计且不联网；有 Key 时能减少 pending。

## Assumptions

- 维护者会提供 TMDB v3 API Key 或 v4 Read Access Token；自动化测试不依赖真实网络。
- 默认语言/地区 `zh-CN`/`CN`；如内容以繁中为主可改为 `zh-TW`/`TW`。
- 单部署单 Household（ADR-0002），但缓存与 ref 仍显式带 `household_id`。
- 本期只做节目海报，不做 TMDB 简介/评分/演员/图片落盘。
- 首轮导入允许部分标题暂未匹配，由后续刷新或 CLI 补齐。