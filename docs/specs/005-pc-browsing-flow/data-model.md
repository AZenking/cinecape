# Data Model: 005 PC 公开浏览与个人观看体验

状态：Proposed；2026-10-26。字段与事务语义为计划阶段设计，不含 SQL 或业务实现。本文件是新增持久字段与一致性规则的权威，接口映射见 contracts/api.md。

## 1. 通用约束与存储代际

- SQLite WAL + Drizzle/better-sqlite3。所有新增业务表显式 `household_id`；复合外键校验同家庭，个人键同时包含 `profile_id`。ID 服务器生成；时间 UTC ISO8601 毫秒，所有位置为有限非负秒数；版本和序号为正的安全整数。
- 新迁移编号 `0006_pc_experience`，仅对全新安装的空业务库应用；按宪章1.2.0特定交付例外拒绝旧已初始化库，不能先删数据再尝试升级。启动和迁移入口必须在任何写连接、WAL设置或迁移元数据创建之前以只读方式预检旧库，拒绝时不修改旧文件。SQLite `user_version=2` 表示新代际，应用 readiness 要求匹配；0001～0005 历史迁移保留，不改写其记录。
- 首次启用时允许零 Profile 的 bootstrap 状态；首建提交后恰好一个 active adult 主档案。新代际自身演练 up/down/up、备份恢复；向旧业务库迁移不在范围内。down/恢复只对独立临时目录执行，真实旧目录和源媒体不在脚本删除范围内。
- 除明确 nullable 的字段，其余 NOT NULL。管理修改采用 expectedVersion；事务 `BEGIN IMMEDIATE`，密码/PIN 哈希计算及 I/O 在事务外，提交前重新校验权限快照。所有 HTTP DTO 使用白名单投影。新增FK所需的profile/playback_session等父表`(household_id,id)`复合唯一索引须在0006中显式确认或补齐，不能只在ORM声明而缺数据库约束。

## 2. 现有实体扩展

### household

新增 `version INTEGER >=1 default 1`、`main_profile_version INTEGER >=1 default 1`。保留 name/default_language/timezone；timezone 必须是运行环境认可的 IANA 时区。通用设置变更用 version CAS。主档案转移增加 main_profile_version，不因普通页面读取递增。

### account

新增 `credential_version INTEGER >=1 default 1`，密码改动递增，并在同一事务撤销该账号全部 device_session 和设置授予。验证旧密码后再重读 credential_version，避免并发密码变化窗口。当前账号 role 仍为管理员授权源。

### profile

新增 `is_main BOOLEAN default false`、`pin_version INTEGER >=1 default 1`、`version INTEGER >=1 default 1`。唯一索引 `(household_id) WHERE is_main=1`；CHECK 主档案必须 `type=adult,status=active,pin_hash IS NOT NULL`。is_default 保留为默认观看偏好，与 is_main 无权限等价关系。

首次 bootstrap 在零档案且 owner+当次密码有效时创建 main adult、6 位 PIN 哈希、默认内容策略和 progress clock，但不设置 active_profile_id。新建其他档案允许可选 PIN；本代际所有新设/重设 PIN 统一 6 位数字。主档案不允许 clearPin；转移主档案时目标必须已启用成人且已有 PIN。

PIN更新增加pin_version，清持久失败计数并撤销该档案的选档授予与所有设置授予；同事务清空所有当前选用该档案的设备会话active_profile_id、递增profile_context_version、终态化相关活动播放并撤票，强制重新选档，不能只撤grant后保留旧活动身份；主档案转移使用expectedCurrentProfileVersion（现任主档案version）、expectedProfileVersion（目标档案version）和expectedVersion（household.main_profile_version）三项CAS，一次事务先去旧标记再设新标记，不允许中间状态提交。不能停用最后一个可用档案；现任主档案须先转移。

### device_session

新增 `profile_context_version INTEGER >=1 default 1`，实际 activeProfile 改变、清空或失效回落时递增；A→B→A 至少递增两次。改变身份、撤销当前 settings grant、终态化该DeviceSession旧身份的活动playback及撤销对应票据在同一事务。选同一仍有效档案不改变身份版本，但不得借此恢复过期设置授予。

### playback_session

新增 `profile_context_version INTEGER>=1`，resolve时从可信DeviceSession捕获；每次控制、renew、交付和个人进度写入必须等于当前DeviceSession版本。实际换档或失效回落事务将旧上下文活动播放标ended/interrupted并撤票，异步准备提交也复查该版本，避免A→B→A复活旧播放；不能仅依赖前端stop。

### media_item / source_entry

`media_item.content_revision INTEGER >=1 default 1`；同一 NAS 身份文件的可信 size/mtime 变化时，导入发布事务递增该值，普通标题/分级修改只改既有 version。老内容修订的进度不能用于新输入续播；旧播放后续交付继续按既有输入校验拒绝。

`source_entry.group_title TEXT NULL`，trim 后 1～100 字符，空白为 NULL；来源发布/条目更新同事务保存 M3U 分组。对多来源可用频道，按启用 present 关联 `(source_id, entry_id)` 升序选第一项非空 group_title；无分组为其他。公开返回仅分组显示名及不透明 groupKey，不带来源身份或源 URL。

## 3. settings_access_grant

| 字段 | 类型 / 规则 |
| --- | --- |
| household_id, device_session_id | 同家庭 FK；联合主键，每设备会话一行 |
| profile_id | 同家庭 profile FK，必须等于当前主 Profile |
| profile_context_version | 创建时的设备会话身份版本 |
| pin_version, main_profile_version | 创建时当前主档案和家庭主档案版本 |
| issued_at, expires_at | expires_at = issued_at + 15 分钟；固定不滑动 |
| revoked_at | nullable；失效后不再恢复 |

若POST设置PIN验证时已存在同上下文的有效grant，成功后返回原issued_at/expires_at，不覆盖或续期；只有已失效且重新验证成功才创建新授予，旧授予不能被缓存标记恢复。

每次设置读取/写入连接 account/device/device_session/profile/household 重新检查 role、归属、当前档案、状态、三个版本及 `expires_at>serverNow`。授予本身无 bearer，浏览器仅收到 expiresAt 元数据；不进入 localStorage。刷新/返回可以重查有效授予，不延长时间。

PIN 验证开始时捕获 pin_version、profile_context_version、main_profile_version、credential_version，在异步哈希完成后事务再读并比对；任一变化拒绝提交，不签发基于旧身份的授予。PIN 验证使用原 profile 持久失败计数，选档与设置共享错误锁定。

设置 grant 在密码改动、会话撤销、PIN 更新、主档案转移、档案停用时显式撤销；服务端逐请求版本检查是竞态兜底。启动时撤销所有 grants，避免恢复备份或进程重启继承不可验证的旧授权；15 分钟是最长有效期，不承诺跨服务重启存活。普通浏览器刷新不属于服务重启。

## 4. profile_channel_favorite

字段 `household_id,profile_id,media_id,created_at`；主键 `(household_id,profile_id,media_id)`，Profile/Media 同家庭复合 FK；媒体必须为 channel，添加时要求可用。`created_at` 首次收藏固定，重复 PUT 不更新；DELETE 不存在也 204，取消后重新收藏为新时间。

列表按 `(created_at DESC,media_id DESC)` 键集分页；索引同顺序，以 signed cursor 绑定家庭/Profile/列表类型。数据不依赖 Account 作为观看归属。不可用频道保留关系并返回 unavailable 状态，可取消但不可播放。媒体身份不硬删除以保持引用。

## 5. profile_progress_clock

字段 `household_id,profile_id,next_epoch INTEGER>=1`，联合主键，同家庭 Profile FK。每次点播 resolve 接受时在短事务分配一个 epoch 并递增；直播不分配。可跳号，不可重置，不接受客户端指定。

即使临时播放会话被清理，epoch 也不回退。各媒体独立比较写入权；较新 session 仅 resolve 未起播不能抢占历史。

## 6. playback_progress_state

| 字段 | 类型 / 规则 |
| --- | --- |
| household_id, playback_session_id | 联合主键，复合 FK 到 playback_session；随临时 session 清理 |
| profile_id, media_id | 同家庭复合 FK，来自可信 playback 绑定，不接受 body 身份声明 |
| candidate_epoch | clock 分配值，>0 |
| content_revision | resolve/可信输入快照的内容修订 |
| profile_context_version | resolve时身份上下文版本，与playback_session和当前DeviceSession一致 |
| started | boolean default false；首次有效客户端 playing 上报后 true；客户端必须收到started确认才提交后续样本 |
| last_sample_seq | >=0，初始 0 |
| last_sample_digest | nullable；最后一个已接受样本的规范化摘要 |
| last_generation | >=1，最后接受的 playback generation |
| last_result | nullable；最后样本 applied/reason/revision，供相同序号重试稳定返回 |

`sampleSeq` 是该 playback_session 生命周期内单调序号，不在换轨、seek 或组件重渲染时重置；与编辑 version 分离。post-progress 仅可在 ready/playing/paused 接受，当前 generation 必须匹配且当前身份/资源仍放行。没有媒体真正播放过时，pause/periodic/final 不可伪造首次 started。服务器可验证播放已交付及会话状态，客户端 playing 仍只是经过身份约束的观看遥测，不声称能证明人的观看行为。

## 7. profile_viewing_history

| 字段 | 类型 / 规则 |
| --- | --- |
| household_id, profile_id, media_id | 联合主键，Profile/Media 同家庭 FK；仅点播 |
| writer_epoch | 当前媒体历史写入权代次 |
| writer_playback_session_id | 不透明 ID TEXT，无强引用临时 session 的 FK，避免审计清理影响历史 |
| last_sample_seq | 当前 owner 已接受序号 |
| content_revision | 该位置对应的内容修订 |
| position_seconds, duration_seconds | position 有限非负；duration nullable，已可信探测后为有限非负；位置不超过可信时长 |
| last_viewed_at | 服务端接受有效观看活动时间；客户端不能指定排序时间 |
| revision | >=1，实际更新递增 |

历史索引 `(household_id,profile_id,last_viewed_at DESC,media_id DESC)`。临时 session/失败事件保留策略不清理历史。档案本轮停用不硬删除历史；显式维护重置或后续批准的档案移除才删除，不提供本轮历史手动删除。

### 写入状态转换

1. resolve：分配 candidate，创建 progress state并记录身份版本；不写可见历史。客户端首次started未确认前按同seq/payload重试，后续样本排队；停止时若仍未确认则只空stop并提示未保存，不能跳过首次确认写final。首次started确认前禁用/排队用户seek及会重建输出的音轨切换，确认后再执行，防generation变化使首次重试失去可达路径；取消/空stop不受阻。
2. first started：会话、真实交付、当前 generation、资源修订和位置校验通过；若历史无行或 candidate_epoch > writer_epoch，取得写入权并 upsert 历史；同 owner 继续；旧 candidate 返回 applied=false/superseded。
3. periodic/pause/final：仅已 started 且 owner 匹配的 session 可更新；允许 position 降低，以支持后退 seek 与从头播放，不能使用 MAX(position)。
4. seq==last 且 digest 相同：返回上次结果，不改变排序或 revision。seq==last 但 digest 不同：409 PROGRESS_SAMPLE_CONFLICT。seq<last：200 applied=false/stale_sample，不覆盖。generation 不同：409 PLAYBACK_GENERATION_STALE，不消耗新序号，客户端以当前样本新 seq 重试。
5. 不同设备较新 session 实际起播后，旧 owner 后续始终 applied=false/superseded；它可继续媒体播放，不再改变这个媒体的续播。不同媒体独立。
6. normal stop：在同一事务内进行可选 finalProgress 验证及更新，再将 playback 置终态；记录该 stop 的结果。已终态重复 stop 204，不接受新 final 更新，不能复活；无 started 的准备取消不建立历史。
7. logout/换档：先尝试最多 1 秒 final flush，结束旧播放，再提交身份变化；失败保存提示，最后确认值保留，身份变化之后旧进度写入拒绝。

### 续播读取

GET `/me/history/{mediaId}` 基于当前 Profile 返回进度、canResume 与状态，不公开 writer ID/epoch；resume在probe完成后、启动转换或安装direct输出前由服务器重读历史并冻结起播位置，不信任详情页旧position。ready提交重验身份版本、资源修订和generation，不改变已构建输出的offset；若重验失败则取消准备。content_revision 不匹配、非有限位置、位置到结尾或无已知可信 duration 时 canResume=false。缺少或无效位置的 resume resolve 从零开始，不删除旧历史；新媒体实际播放后才覆盖新修订。

seek/音轨转换使用原影片逻辑秒数；direct 媒体在准备完成并可定位时先定位后 play，转换输出通过 timelineOffset/presentationStart 安装目标。继续观看不是自动起播，也不扩大直播 seek、回看或转码范围。

## 8. EPG 查询与时间值对象

以固定 `nowMs` + Household IANA timezone 求今天，日期范围今天～today+6；7 个日历日整体区间 `[todayStart,todayPlus7Start)`。使用直接依赖 `@internationalized/date@3.12.4` 的 CalendarDate、fromAbsolute、toCalendarDate、parseDate、toZoned(date,zone,'compatible')；相邻日历日期分别转换为 UTC 日界。该版本无 startOfDay 导出，不采用此 API；禁止简单加 24 小时构造日期边界。

导入排期本身 UTC 保存，查询交叠条件 `starts_at < to AND ends_at > from`；当前 start<=now<end。DST 的重复小时 UI 附 offset；缺失小时不补造。请求 date 必须在允许范围内，from/to 必须在该日真实边界且 to>from（跨度上限即该日真实日长，普通日 24 小时）；缺省 from/to 返回该日完整 24 小时全天窗口。家庭跨日后过期 date 返回 409 GUIDE_DATE_EXPIRED 和新的 allowedDates；UI 回到今天。

每页最多 50 频道、默认 20；先集合计算媒体可用性及手动/自动绑定映射，再批量取 programme 窗口，不在循环调用单频道授权服务。一次响应最多 2000 节目/2 MiB，超限 422 GUIDE_WINDOW_TOO_LARGE，返回建议减少每页频道数，不静默截断。页面可分页遍历所有频道，包括无节目频道。

现有 programme 表补索引 `(household_id,source_id,xmltv_channel_id,starts_at,ends_at)`；EPG 发布/绑定修改同事务递增家庭 catalog revision，读取将 revision 与 now、timezone 一起返回。programme 公共 key 由内部 ID 经不透明映射生成，不下发源或 XMLTV ID。

## 9. 只读视图与公开 DTO

- PublicContext：initialized、displayName（已初始化）、timezone、language、now、catalogRevision；不返回账号、Profile、来源信息。未初始化 public context 可返回 initialized=false，其余字段为默认展示值；只有配置弹层可提交初始化。
- PublicMedia：id、type、title、description、posterRef、contentLevel、availability；posterRef 仅服务端认可的同源展示资源或 null，导入任意外部 URL 不直接渲染。只有可用资源进入目录；个人记录的失效媒体使用 unavailable 摘要。
- PublicChannelProgramme：频道摘要、groupKey/groupLabel、current/next，可用性与节目有无分离。
- AccountSession：服务端householdId、账号与当前 Profile 的最小摘要、bootstrapRequired、profileContextVersion；不含 PIN hash 或设置主体。
- SettingsAccess：unlocked、expiresAt nullable；普通 GET 元数据不返回来源/设备/策略，不代表可跳过每次设置守卫。

## 10. 恢复、日志与数据保护

所有新业务 FK 保留家庭边界；恢复备份后先撤销授予、标记活动播放中断，再提供 readiness。history 与 favorites 保留，不能复用旧 session 写入权绕过重授权；下次新 session 的 epoch 比旧值更大。

日志仅本地 requestId、模板路由、耗时、状态、查询数、公开稳定原因。敏感值不进入日志；公共响应 no-store，个人与设置 no-store，前端个人缓存键包含 household/Profile/contextVersion。此阶段不写 migration SQL、不执行 up/down、不创建新业务数据。
