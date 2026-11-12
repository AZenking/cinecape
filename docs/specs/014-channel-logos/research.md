# Research: 014-channel-logos

日期：2026-11-07。全部决策为 Proposed 设计，spec 未 Accepted 前不构成实现承诺。
取证方式：仓库源码只读核对（文件:行号见各条）；010（在线点播）已交付实现作为模式先例。

## R1 解析捕获与归一化

**Decision**: M3U 解析器在 EXTINF 捕获 `tvg-logo`（复用既有 `attrValue` 机制）；XMLTV 解析器在 channel 帧捕获首个 `<icon src>`。两者在**解析层**归一化：trim 后长度 9–2048（下界 9 与迁移 0009 的 DB CHECK 值域一致，避免「解析层放行、发布层撞 CHECK」导致导入失败）、仅 `http://`/`https://` scheme，不满足归一化为 NULL。非法输入一律按缺失处理，绝不让解析失败或抛错。（实施注记 2026-11-07：初稿写 1–2048，实施期对齐 DB 值域修正为 9–2048。）

**Rationale**: 解析层归一化有直接先例——`refresh-publish.service.ts:95` 注释「M3U group_title(解析层已归一化:trim 1~100 或缺失)」；归一化后 stage 载荷干净，发布层无需二次防御。XMLTV 一个频道可含多个 `<icon>`，行业惯例取首个为主图标。
**Alternatives considered**:
- 发布层校验（拒绝）：stage 会携带垃圾数据，且发布侧失败路径更难测；否。
- 捕获全部 icon 后择优：YAGNI，多图标择优无现实数据支撑；否。
- 解析失败即中止导入：违反 FR-010（坏 Logo 不阻塞导入）；否。

## R2 原始 URL 私有落库位置

**Decision**: 新增 `source_entry.logo_url`（IPTV 条目，随既有身份键稳定）与 `epg_channel.icon_url`（XMLTV 频道）两列，均为 `TEXT NULL` + CHECK（NULL 或 https?:// 且 1–2048）。

**Rationale**: 每个源保留自己的原始证据，胜者合并（R5）与重新评估可在任一源刷新时独立进行，不需要重新解析原始文件；与 `source_entry.group_title`（0006 增补）「源属性落条目表」的先例一致。两列均为私有载荷，公共面永不暴露（对齐 010「上游地址只在私有载荷可见」边界）。
**Alternatives considered**:
- 只在发布时写单个合并列：丢失来源证据，无法在 EPG 单独刷新时正确重估优先级；否。
- 仅存 refresh staging：staging 是临时私有暂存（`refreshStageEntry`），不进浏览查询，生命周期不符；否。

## R3 胜者注册表与引用承载

**Decision**: 新表 `channel_logo`（media-catalog 域所有）每频道一行：`(household_id, media_id)` 唯一，含 `ref`（随机 128-bit 不透明令牌，家内唯一）、`upstream_url`（私有）、`source_kind`/`source_id`（来源证据）、`revision`、`revoked_at`（墓碑，见 R4）、时间戳；`media_item.poster_ref` 写入引用值——**复用既有列，不改 media_item 结构**。

**Rationale**: `poster_ref` 本就是 media_item 的身份列，live/catalog 投影已把它透传到公共 DTO（`live.controller.ts:81`、`MEDIA_ITEM_SELECT`）——填值即达前端，投影链路零改动，这是本方案最大的杠杆。归 media-catalog 域是因为 Logo 与 title/description/poster_ref 同属媒体身份属性；010 先例「ref 可逆性只在注册表」（`poster.service.ts` resolve 注释）由持久表满足。
**Alternatives considered**:
- 无状态 HMAC 引用：需密钥生命周期管理，且撤销仍要查库核对版本，等于注册表加复杂度；否。
- 复用 010 VodCache（内存预览缓存）：TTL 短、重启即失，直播墙引用必须跨重启稳定；否。
- live-tv 域建新投影列：重复 poster_ref 语义，且 favorites/catalog 也要用；否。

## R4 引用形态与失效语义（FR-006 的 410）

**Decision**: 引用为随机令牌（非 URL 派生，不泄漏上游结构）。频道胜者变更或源移除 Logo 时：旧行转墓碑（`revoked_at` 置时、`upstream_url` 清空）保留 ≥7 天，窗口内解析返回 410「已失效」；发布事务内集合 DELETE 过期墓碑（无后台任务），之后旧引用 404 同形。频道媒体被删除时注册表行级联删除（FK ON DELETE CASCADE），直接 404。

**Rationale**: FR-006 要求「已失效」与「不存在」形态可区分（客户端据此判断该刷新列表还是该忽略）；010 的 410 语义（过期未淘汰）被映射为墓碑窗口语义，稳定形态一致。7 天窗口覆盖典型刷新周期，墓碑量有界（每频道至多 1 行）。
**Alternatives considered**:
- 立即删除旧行：410 形态无处产生，FR-006 落空；否。
- 长期保留墓碑：无界增长且无收益；否。

## R5 优先级合并规则（FR-003）

**Decision**: **写时合并**，规则表如下，在发布事务内对「受影响频道」集合执行：

| 场景 | 动作 |
| --- | --- |
| IPTV 刷新，条目 logo_url 非空 | 写胜者（source_kind='iptv'），无论当前胜者来源（iptv 必胜）；url 变化 → 旧引用转墓碑、签发新引用 |
| IPTV 刷新，条目 logo_url 为空 | 若当前胜者 source_kind='iptv' → 撤销转墓碑，并尝试以绑定的 epg icon 填补；否则不动 |
| EPG 刷新，icon_url 非空且频道已绑定 | 仅当无胜者或胜者 source_kind='epg' 时写胜者；**绝不覆盖 iptv 胜者** |
| EPG 刷新，icon_url 为空或绑定失效 | 若胜者 source_kind='epg' → 撤销转墓碑；否则不动 |

「受影响频道」= 本次刷新发布涉及的条目；EPG 侧按既有频道关联判定（与 live-projection 的 upstream 精确匹配谓词同源，见 internal-ports）。

**Rationale**: 写时合并让读路径保持单表单查；「EPG 绝不覆盖 iptv」以 source_kind 为证据，确定性可测。绑定关系变化（手动绑定失效）时 EPG 来源 Logo 随之撤销——Logo 非播放授权，不受「手动失效不回退」约束，跟随数据真值即可。
**Alternatives considered**:
- 读时合并：poster_ref 必须是持久引用值，读时选胜者意味着引用随读变动，状态抖动；否。
- 把合并逻辑放进 live-tv 投影：跨域写 media_item 身份列，破坏所有权；否。

## R6 代理端点归属与缓存

**Decision**: `GET /public/media/logos/:logoRef` 落 media-catalog 接口层（`@Controller('public')` + `@RateLimit('public')`，家庭上下文取自 `PublicContextService`，不由客户端指定）。响应 `Cache-Control: public, max-age=300`——引用本身按频道+家庭唯一，公共缓存以引用为键，无跨家庭串味面。

**Rationale**: 直播墙单页可达 50 频道，无缓存则每次渲染产生等量上游回源；引用键控的短缓存把回源压到 ≤1 次/5 分钟/频道，同时保持字节不落盘（缓存发生在浏览器/代理层，非服务端持久化）。010 海报代理走预览态（条目少、TTL 短）故未做缓存，本端点场景不同，属场景差异而非口径偏离；预算与错误形态完全沿用（R7）。
**Alternatives considered**:
- 落 live-tv 域：频道身份图同样服务收藏页/目录，live-tv 只拥有直播投影；否。
- 复用 `/public/vod/posters`：不同注册表、不同 ref 类别证据（`poster:` 前缀门），耦合 VOD 上下文；否。
- 服务端内存缓存字节：新增有界缓存组件 + 失效复杂度，浏览器缓存已够；否。

## R7 有界读取预算与稳定错误形态

**Decision**: 预算沿用 010 `VOD_POSTER_BUDGETS` 数值口径（≤2MiB、总 8s、空闲 4s、重定向 ≤3）作为**数值常量复用**，错误映射同形：伪造/未签发/跨家庭 → 404 `NOT_FOUND` 同形；墓碑窗口内 → 410 专属问题码；上游失败/非 image 或非 identity 编码 → 502；超预算时限 → 504。全部形态不回显上游地址与细节。

**Rationale**: spec Assumptions 明确不新增预算参数；`poster.service.ts` 的 mapUpstreamFailure 分类（IDLE_TIMEOUT/ABORTED/BUDGET_EXCEEDED → TIMEOUT，其余 FAILED）与「仅接受 image/* 且 identity 编码」门逐字可搬。新问题码注册进 shared 常量（`ProblemCode`），命名沿 `*_UPSTREAM_FAILED/TIMEOUT` 惯例（如 `MEDIA_LOGO_*`）。
**Alternatives considered**: 自定预算数值：违反既定假设，且无证据支持新数值；否。

## R8 契约与类型生成

**Decision**: 新建 `contracts/openapi.yaml`（014 公共面：logo 代理端点 + 请求路径参数 + 错误形态），`packages/shared/package.json` 的 `gen:types` 追加该源（沿 010 追加 `vod-schema.d.ts` 的先例）。`posterRef` 的语义注记增补在 `docs/specs/005-pc-browsing-flow/contracts/openapi.yaml`（PublicMedia/直播频道行的 posterRef description 更新为「频道 Logo 同源引用或 null」）——010 曾在 005 openapi 增补 detailKind/parentMediaId（见 experience-schema.d.ts 内「010 扩展」注释），属既定做法。

**Rationale**: 每 spec 一份 openapi + gen:types 链是仓库既定交付格式；描述注记随实现规格增补有直接先例，不改 005 的既有字段结构。
**Alternatives considered**: 把端点塞进 003 catalog openapi（003 已 Verified 收卷）；新开 yaml 更清晰且不动历史契约的既有路径定义。

## R9 迁移与回滚

**Decision**: 单条迁移 `0009_channel_logos`（migrations 目录现到 0008）：up 加 2 列 + 1 表（含 CHECK/唯一索引/复合外键/级联），down 逆序删除；`migration:drill`（up→down→up）+ `VACUUM INTO` 备份照平台既有执行器（`migrate.ts` 既有机制，无需新代码）。存量数据零回填：迁移后 `poster_ref` 仍为 NULL，Logo 在下一次源刷新时出现（符合 FR-009「Logo 随源刷新生效」）。

**Rationale**: 005 例外不适用本规格（非代际切换）；「向前兼容 + 经测试回滚」是宪章技术约束 3 的硬要求，drill 是既有门禁命令。
**Alternatives considered**: 迁移时立即全量刷新源以回填 Logo：导入是显式管理操作且可能失败，迁移内做网络抓取不可接受；否。

## R10 前端回退链组件与接入点

**Decision**: 共享装饰组件 `channel-logo.tsx`（live/components 下，与 ChannelTile 的底板逻辑同域）：`posterRef` 非空 → 渲染 `<img src="/public/media/logos/{posterRef}">`（`alt=""` + aria-hidden，纯装饰），onLoad 淡入（尊重 reduced-motion）；加载失败/无引用/引用失效 → 不渲染 img，露出下层**现有**渐变底板+首字（ChannelTile.tsx:105–121 的实现原样保留为回退层）。接入点 5 处：ChannelTile 主视觉、NowHero、GuideChannelList 频道列头、home/personal-area 收藏频道卡、收藏页频道列表。HTTP 缓存由 R6 的 max-age 承担，组件不自行做内存缓存。

**Rationale**: 回退层已是「有设计的没图」，新组件只做增量，任何失败路径的观感不会比现状差（SC-002）。装饰性 img 不属宪章技术约束 5 禁用的交互控件；底板颜色全部沿用既有语义 token（DESIGN.md 契约）。
**Alternatives considered**:
- HeroUI Image 组件：装饰性纯展示 + 细粒度加载状态控制用原生 img 更直接，且 HeroUI 未提供「错误隐形回退」能力，自定义更符合约束 5 的「偏离记录」路径（记录于 ui.md）；否。
- 每接入点各自实现：回退链逻辑五处重复，漂移风险；否。

## 遗留与开放项

- 无 NEEDS CLARIFICATION。两处 spec 假设已在本轮锚定：来源优先顺序（R5，iptv>epg 落到 source_kind 证据）、预算口径（R7，数值复用 010）。
- 实施期待 tasks 锚定的 seam：EPG 发布侧「受影响频道」集合查询与 live-projection 关联谓词的复用方式；`gen:types` 链追加位置。
