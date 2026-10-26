# Data Model: 003 媒体目录与来源

日期：2026-10-23；设计产物，尚未创建表或执行迁移。DDL 权威继续是成对 up.sql/down.sql，Drizzle 查询 schema 必须同步。

## 通用约束

新表均显式含 household_id，UUID v4 为业务 ID；复合外键以 (household_id,id) 为目标，禁止跨家庭 source/entry/media/job/EPG 关联。引用索引必须显式唯一。版本及修订为正整数、时间为 UTC；文件大小和 mtimeNs 用十进制文本保存，避免 JS 整数精度截断。媒体类型继承已接受枚举，等级 null 或 0～18 整数。无新增 Account/Profile 所有权副本。

## catalog_state

主键 household_id，revision 默认 1。每次目录发布、来源配置/启停/关联修改、人工标题/类型/等级修改均加一；不随只读查询或策略编辑改变。刷新任务捕获此修订，防止等待确认的旧快照覆盖后续人工修改。不同来源的修订冲突也拒绝旧发布，采用保守串行行为。

## media_source

| 字段 | 语义与约束 |
| --- | --- |
| id / household_id | 主键、家庭归属；UNIQUE(household_id,id) |
| kind | iptv / epg / nas，创建后不可转换 |
| name | 1～100 字符 |
| remote_url | iptv/epg 必填，nas 必为 null；私有字段，不直接返回 |
| root_key / relative_directory | nas 必填；root_key 必须出现在部署 MEDIA_ROOTS，其他类型 null |
| private_access_approved | 0/1；远程局域网源仍需部署精确许可 |
| epg_source_id | 仅 iptv 可有值；同家庭 epg，允许关联暂时禁用来源，观看时无节目 |
| enabled / version | 0/1；正整数，默认 1 |
| last_success_at / last_job_id | 可空，只在成功发布后更新成功时间 |
| created_at / updated_at | UTC |

名称不唯一；重复地址的来源不会跨源合并。来源无硬删除，禁用保留引用。epg_source_id 复合 FK 校验同家庭，应用事务额外校验 kind=epg、非自引用。凭据/挂载实际路径不进入列表、DTO、错误和日志。

## media_item

id、household_id、type(channel/movie/series/episode/video)、title(1～255)、description(可空，最多 4096)、poster_ref(可空，首期不主动取外部图片，显示占位)、content_level(null 或 0～18)、title_overridden(0/1)、type_overridden(0/1)、version、created_at、updated_at。

仅首建或未人工覆盖的标题随导入刷新；人工类型和分级不被普通刷新覆盖。type 在非频道四种间可修改，channel 与非 channel 之间禁止转换；不建立尚未定义的 Series/Episode 层级。后续来源复用同一个媒体在结构上允许，但本阶段导入不自动跨来源关联。

可用性不存重复布尔：存在 present 的来源条目且对应来源启用、对应播放资源记录有效即为家庭可用；某来源失效不屏蔽其他有效来源。普通 DTO 不包含不可用项，家长候选可选择其身份，显示 unavailable。

## source_entry

id、household_id、source_id、identity_kind(tvg_id/url/path)、identity_digest(SHA-256)、media_id、upstream_channel_id(可空)、present(0/1)、last_seen_job_id、first_seen_at、last_seen_at、missing_since(可空)、file_size_text/file_mtime_ns(仅 NAS)。

UNIQUE(household_id,source_id,identity_kind,identity_digest)。摘要输入为类型标签与未经标题归一化的完整标识；tvg-id/路径大小写敏感，完整 URL 不删 query、不做名称回退。字面大小写/URL 变化即可能成为新身份，规则有明确测试。原 tvg-id 作为私有上游字段用于 EPG 关联，不能代替本平台 media id。条目消失仅改 present，重现时复用 media_id。

## playback_source

id、household_id、source_id、source_entry_id、media_item_id、protocol(hls/dash/file/flv/http)、location(私有原始 URL 或 rootKey+相对路径)、mime_type(可空)、priority(默认 100)、requires_proxy(默认 false，尚未进行设备解析)、created_at、updated_at。

每 source_entry 首期最多一个资源，UNIQUE(household_id,source_entry_id)，关联 ID 三元组须保持一致（source_entry 对 media/source 的复合目标约束或事务检验，数据库跨家庭约束不可省）。http 与 .m3u8 等协议推断仅描述资源，不保证可播或授权；首期不产生可供客户端播放的响应。

## epg_channel / epg_programme

- epg_channel：(household_id,source_id,xmltv_channel_id) 唯一，display_name、conflicted(0/1)。XMLTV 频道 ID 不与 media_id 混用。
- epg_programme：id、household_id、source_id、xmltv_channel_id、title、description、starts_at、ends_at；结束严格大于开始，复合 FK 绑定 epg_channel；按 (household_id,source_id,xmltv_channel_id,starts_at,ends_at) 唯一，完全相同记录去重，不同记录时间重叠标冲突。
- 成功刷新在同事务替换本 EPG 来源的指南窗口数据；不删除 MediaItem，不改变频道分级。时间窗口：刷新时间前 24h～后 7d；未知外部等级不导入内部等级。
- 查询仅在授权后的频道详情中，用该频道条目所属 IPTV 来源配置的 epg_source_id 查 tvg-id。若多个有效来源共享一个媒体而产生不同指南，首期按 source_id 升序选择第一个有效且精确匹配且不冲突的关联，不合并/模糊猜测；当前自动导入不会创建这类共享情况。

## source_refresh / refresh_stage_entry

source_refresh：id、household_id、source_id、initiator_account_id、initiator_session_id、operation_key、status、version、source_version、baseline_revision、snapshot_digest、item_count、summary_json、error_code、created_at、started_at、finished_at、expires_at。

UNIQUE(household_id,operation_key)。initiator_session_id/account_id 必须属于同家庭，仅存 ID 不存密码/token。运行锁：同来源 queued/running/awaiting_confirmation 至多一个（部分唯一索引）。全局执行器只运行一个任务，额外已接受任务最多排队 20 个；满载 429。确认中的任务不占运行槽。

refresh_stage_entry：(household_id,refresh_id,entry_key) 主键，kind、payload_json；解析数据分批暂存，payload 内位置等仍是私有信息。每条归属指向本次任务；重复 IPTV identity 拒绝，不以最后一条覆盖。阶段结果不会直接进入浏览查询；内容摘要按顺序无关规范化条目计算。

### 状态流转

queued → running → succeeded 或 awaiting_confirmation 或 failed。
awaiting_confirmation → succeeded（家长确认）/discarded/expired/stale。
queued/running 在进程恢复时 → interrupted；不自动重跑。

awaiting_confirmation 有效期 24h，客户端断开不批准；只有当前 owner 家长验证可确认/丢弃，不限于原会话，但必须属于同 Household。自动发布 running 的发起会话若已撤销或过期，任务失败。确认发布时使用本次请求会话重新校验。终态 immutable；同 operationKey 同来源与预期版本重试返回原任务，改变请求语义则 409。

### 发布事务

重验来源启用、来源 version、catalog revision、job version/hash、会话/设备有效；执行稳定 upsert、mark missing、资源/指南更新。NAS 同路径变化连同 content_level=null 和全 Household 各 Profile 的 allowedMediaIds 清理一起提交；blockedMediaIds 与其他字段保留，每个受影响策略 version 加一；损坏策略导致本次整体发布失败，不能跳过。最后 source 成功信息、job=succeeded、catalog revision+1 同事务提交。

修改源配置使旧 job 失效；修改根目录/远程地址仍属于同一 source，不删除其历史 entry，后续刷新应用同样稳定键规则。NAS 修改 rootKey/relativeDirectory 是根身份域变更，必须视为旧源禁用并新建来源；禁止就地改根后继承旧 path 身份。

## 迁移与回滚

拟新增 0003_media_catalog/up.sql 与 down.sql，新建上述表与索引，并为既有 Household 建 catalog_state。全新部署迁移时尚无家庭，因此后续 initializeHousehold 的家庭/账号创建事务必须同事务插入唯一 catalog_state(revision=1)；重复初始化不得重置修订，只读请求不得隐式补建。阶段 1/2 表不重建；只在正常业务发布时按规则修改已有策略 JSON/版本。database.ts 的就绪清单、migrate.ts 的 drill、复制到 dist 的迁移、旧测试固定表清单同步。

down 只删除本阶段新表/索引，保留身份、PIN、现有策略；因本阶段新增媒体 ID 不再存在，策略中的引用仍保留为失效引用，不自行清空或重建已清除允许项。再次 up 会创建空目录，不恢复原媒体 ID 或指南；完整恢复必须使用停服下回滚前一致性备份。恢复需验证 integrity_check、foreign_key_check、原策略版本和目录 ID。所有演练仅使用临时库和独立容器卷。

## 0004 增补：manual_epg_binding（设计，未实施）

| 字段 | 约束 |
| --- | --- |
| household_id / media_id | 复合主键；FK 到 media_item(household_id,id)，应用事务只允许 type=channel 且存在 IPTV 来源条目（允许暂时 missing） |
| mode | manual / auto；auto 是解除后的版本墓碑，不代表另建自动匹配结果 |
| epg_source_id / xmltv_channel_id | manual 时两者非空，auto 时两者均 null；XMLTV ID 长度 1～255、大小写敏感 |
| version | 正整数；无行读取为 version=0，首次写为1，之后保存/解除均递增；不删除墓碑 |
| updated_at | UTC |

目标 epg_source_id 以 (household_id,epg_source_id) 复合 FK 到 media_source，事务另校验 kind=epg；不对随 EPG 窗口替换的 epg_channel 行建 FK，避免刷新删除手动配置。目标 ID 和配置仅管理 DTO 展示；普通节目响应不暴露管理候选或目标 ID。

另给 media_source 加 epg_generation 非负整数默认0：每次成功发布 EPG 窗口加一，与节目替换同事务；失败/中断不加。既有已成功来源迁移后也为0，以 last_success_at 和实际 epg_channel 判断已导入，不以 generation>0 代替。候选响应给 epgGeneration，保存必须与最新 generation 相等，否则 409 EPG_CANDIDATE_STALE，即使目标 ID 仍存在也要求重新查询。

读取状态派生：mode=auto（或无行）使用原 FR-007；mode=manual 时目标源禁用→source_disabled，目标缺失→channel_missing，目标 conflicted→channel_conflict，均 invalid 且节目不回退；来源启用且目标有效但无当前节目为 valid，current/next 可 null。频道自身被禁止或不可用的观看请求先统一404，不通过失效信息泄漏内容。

写入事务：家长验证后重验 session/device/account/Household，校验媒体频道与来源及候选 generation、binding expectedVersion → upsert manual 或 auto 墓碑、version+1、catalog_state.revision+1 同事务。旧请求不能通过删除/重建绕过版本；无需更改媒体 ID/等级/策略列表。节目查询在同一读取快照中取得绑定与目标指南，避免模式/指南混代。

迁移 0004 up：新增此表、索引和 media_source.epg_generation，既有频道不生成手动绑定，自动行为不变。同步 schema、isReady 必需表/列、drill 和契约夹具。down 仅删新表/列，原目录/节目/媒体身份/PIN/策略不变，手动配置丢失、行为恢复自动；恢复原手动配置须恢复回滚前备份。任何迁移不修改原 0003 SQL。
