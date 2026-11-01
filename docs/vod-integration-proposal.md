# 在线点播接入方案（第一期，体验扩展修订版）

> 规划同步（2026-10-29）：本文保留为历史讨论稿，不再作为当前接口/状态设计依据。最新需求见[010规格](specs/010-online-vod/spec.md)，设计演进见[计划](specs/010-online-vod/plan.md)及[播放状态契约](specs/010-online-vod/contracts/playback-state.md)。下文最后30秒不续播、stop推导完成、2xx当保存、generation重置或仅operationKey去重等旧描述，已按010设计修正实施；逐项差异见文末[§11 实施对齐](#11-实施对齐2026-10-31讨论稿已实现差异)。


状态：**Proposed，待评审及产品确认**；本文中的推荐不是已接受决策，不授权实施。
日期：2026-10-29
范围：PC；配置源 → 搜索 → 详情 → 选集 → 播放 → 续播、自动连播及便捷换源。
本轮用户明确将上述体验纳入方案；仅修订本文，不改代码、数据库或正式规格状态。工程设计仍为Proposed。

## 1. 接入方向与实际交付

自行实现Apple CMS JSON适配，沿用redRoad的账号、Profile、策略、媒体目录和受控播放，不嵌入LibreTV整站。源由管理员配置；复制上游代码另行核对AGPL-3.0。

第一期交付：多源搜索、详情/选集、VOD HLS、Profile服务端历史和同源续播、播放结束自动下一集、播放器内便捷换线路/来源及有界测速。暂停、seek、停止/重启后的续播均纳入实际验收；来源故障或内容无法匹配时明确降级，不把“全片字节不可变证明”作为普通采集源续播的必要条件。

**调整原决策：授权可信与内容匹配可信分开。** 会话/Profile/策略/资源归属/票据始终由服务端严格验证；采集源续播允许采用稳定定位及结构校验形成的operational匹配，不将其宣称为verified内容指纹。存在上游无提示替换的误定位风险，提供从头播放及变化提示，不因此绕过授权。

不包含全站抓取、榜单、TVBox脚本、HTML兜底、网页解析、DRM、广告删除、跨源身份合并、无人干预的故障轮换源。自动连播限定同一来源/线路内确定的下一集；换源由用户主动操作，不默默试遍所有源。海报首期可占位，兼容性仍受编解码和硬件约束。

## 2. 当前架构与改动面

| 现有位置 | 当前事实 | 拟议变化 |
| --- | --- | --- |
| sources | 来源 kind 为 iptv/epg/nas，配置 version、启停、快照刷新 | 增加 vod；在线按需读取不使用完整扫描的 missing 语义 |
| media-catalog | media_item 有 movie/series/episode/video，但没有本方案的父子关系 | 新增父子关系、浏览父节点和可播放子项的独立投影 |
| playback | resolve 只接 mediaId；授权候选含资源 ID，进度在建会话时绑定 contentRevision | 加私有定位快照、来源版本、内容可信状态；版本变化终止本次准备 |
| personal-data | 历史/进度按 Profile + mediaId；现有 canResume 不判断在线版本可信性 | 扩展唯一续播判定及写入资格，不另建一套在线进度系统 |
| Web | /vod 检索内部目录，/media/:id 展示一个媒体 | 在线搜索/预览、选集、物化后播放、父级最近观看展示 |

当前 playback_source 每个 source_entry 至多一条；保持此约束，一个线路内分集对应一个可播放媒体及一条来源条目。父节点没有播放资源。当前可用性查询依靠 source_entry + enabled source + playback_source，不能直接用它认定父节点可播放。

## 3. 六项架构与续播问题的修订决定（拟议）

### 3.1 统一短事务发布，禁止分步可见

采用**同一 SQLite 连接上的一个短事务**发布某影片完整修订。网络读取、解析、预算验证均在事务外完成；事务内通过来源 version、定位配置版本与影片 detailRevision 的 CAS 检查后，一次写入父子 media_item、media_relation、vod 映射、source_entry、playback_source、内容修订、当前详情指针及 catalogRevision。

任何一步失败全部回滚；首次发布不出现半成品，更新失败仍保留完整旧修订。进程中断由 SQLite 回滚保障。相同 operationKey + 请求摘要返回原发布结果，不分配新 ID；同 key 不同摘要冲突。首次登记或公开字段/可用性变化的成功发布只递增一次catalogRevision；纯私有地址/采集时间刷新不递增。后台详情刷新CAS失败可重读后有限重试，不覆盖新快照；用户物化遇到选择修订冲突直接409，不隐式重试选择。

所有者仍保持分离：sources 拥有配置/来源条目，media-catalog 拥有媒体/关系，online-vod 拥有协议映射/私有详情。新增位于应用编排边界的发布协调器；各上下文发布 transaction-aware 端口，由平台 UnitOfWork 为同一事务绑定各自仓储。业务接口不传 Drizzle 对象、不由 online-vod 导入其他上下文私有表。依赖通过 token/index.ts 装配，不产生模块环。

这是待 ADR 接受的新增跨上下文事务能力，当前项目不能假定已有。发布协调器接口至少包含 expectedSourceVersion、expectedLocatorRevision、expectedDetailRevision、validatedSnapshot、operationKey；内部结果包含 parentMediaId、childMediaIds、detailRevision、catalogRevision。不再使用“先分步提交，最后设置 published”作为隔离机制。

### 3.2 保留 resolve 时绑定；修订变化则失败重建

沿用当前 resolve 建会话并分配 candidate epoch、捕获 contentRevision 的时序，不在原会话内偷偷重绑新内容版本。

授权后的详情重取若发现已确认内容替换，在独立短发布事务递增 contentRevision；原 preparing 会话随后因版本不一致转 failed，清理 probe/转换/资产，再要求重新 resolve。新的 resolve 捕获新版本。只是签名地址更新且内容证据不变，不增加 contentRevision。

ready 提交、转换启动/输出安装前，以及首次 started/后续 progress，均要求会话绑定的内容修订仍等于当前值。已经 ready 的旧内容会话在资源访问重验时同样拒绝，不允许向新修订写进度。不能“旧版本建档、新版本起播、直到上报才报错”。

### 3.3 续播资格：内容证据与实际连续性分开

保留contentVersionState=verified|unverified及evidence字段；基础Apple CMS仍是unverified。新增continuityRevision和continuitySignature（定位/结构匹配摘要，非媒体hash），由服务端完整详情生成：稳定定位键、影片年份/明确季度/版本标签、分集规范标签及映射规则版本。不包含签名URL、抓取时间；顺序新增集数不改变已有集的签名，不因无关集新增使整剧失效。身份歧义或关键字段变化使该子项连续性修订+1。

续播判定按当前Profile历史和目标媒体计算，层级为 verified / operational / none：

- verified：不可变版本证据与历史一致，且内容修订一致；可用于后续适配器，不是基础源的前提。
- operational：相同稳定子项ID、contentRevision及continuityRevision一致，无已知版本冲突、历史未完成且位置有效；普通Apple CMS使用本层级。标题/标签一致只表示操作上匹配，不证明字节一致。
- none：身份歧义、明确版本更换、连续性变化、记录来自其他Profile、位置非法/已完成或本次无可信时长；从头或要求重选。

历史DTO/父级聚合给出canResume、resumeConfidence及resumeReason；这些是候选提示。Resolver必须在本次可信probe之后重算并冻结起点，不信任客户端位置/时长。operational仅使用本次probe时长校验：位置须>0且<duration-30秒；历史时长与新时长差异超过max(30秒,历史时长的2%)时回退从头并提示duration_changed；阈值是可配置初值。无本次可信时长时不可续播，沿用PROGRESS_NOT_READY，不用旧历史时长掩盖probe缺失。

canResume预览可能在probe后降级；会话DTO返回resumeDisposition=resume|beginning和reason，不静默声称续播成功。verified同样检查位置/完成状态；静态NAS现有规则不因本节阈值改变。明确内容替换仍递增contentRevision，绑定后的变化按3.2终止重建。

#### 状态转换

| 成功发布的变化 | 修订处理 | 活动播放及历史 |
| --- | --- | --- |
| 首次unverified | 初始内容/连续性修订 | 首次实际started后形成可候选operational历史 |
| 同定位/结构不变，仅URL token变化 | 两种修订不变 | 不重置进度；新会话仍需probe时长验证 |
| 标签/年份/明确季度或版本等关键匹配字段变化 | 连续性修订+1；明确内容替换则内容修订也+1 | 旧绑定失效；旧历史保留但不继承位置 |
| verified(A)保持A | 内容修订不变 | 通过最新授权与位置验证可续播 |
| verified证据更换、移除，或unverified升级verified | 内容修订+1，更新证据 | 旧会话终结；不追认旧历史为verified；新实际started后写新历史 |
| 超时、协议/证据验证失败、截断 | 不发布修订 | 不把失败当删除；旧输入不可用时本次失败 |

一次发布每类修订最多+1；不批量重写旧历史。unverified相同签名的无提示内容替换可能检测不到，这一限制明确接受为采集源体验取舍，而非授权降级。恢复播放后可随时“从头播放”；已检测的冲突不能被手动“继续”绕过。

### 3.4 定位身份与内容身份分离

定位键为 sourceId + upstreamVodId + lineKey + episodeKey；内容版本另由证据和 contentRevision 表示。同名跨源、跨线路永不自动合并。

lineKey 取上游唯一非空线路标识；episodeKey 取唯一非空标签经 NFC + 首尾空白清理后的值。第一期不做数字/中文集数推断，不将“第01集”自动改成“第1集”。原始标签保留作展示；规范化后碰撞、空值、重复标识返回 identity_ambiguous，不物化这些项。其他无歧义项可展示，但删除判定必须等完整详情验证成功。

改名造成定位键变化时创建新子项，旧项 missing，历史不迁移。原键重现复用原 mediaId，但 resume 必须重新验证内容证据；检测到相同标签的明确内容替换才增加contentRevision；unverified不能检测所有替换，不宣称版本连续性。未知证据保持unverified；可依3.3的operational规则续播，不能标成verified。地址 token 变化不产生新身份。

### 3.5 保留现有允许名单语义，扩展父子匹配事实

公共浏览不按 Profile 策略过滤。播放保持会话 → 当前 Profile → 策略 → 资源顺序。为在线子项构造 EffectiveMediaPolicyFacts，由 policy 发布接口统一计算；只扩展父子匹配目标及有效分级，不把 allowedMediaIds 改成必要白名单。

先计算有效分级：父子均有等级时取较大年龄值；仅一方有等级时使用该值；都无则 null。上游分类文本不换算年龄等级。然后按现有规则的顺序判定：

| 顺序 | 条件 | 结果 |
| --- | --- | --- |
| 1 | 家庭资源不可用，或策略缺失/损坏 | 沿用现有拒绝规则 |
| 2 | 父或当前子 ID 命中 blockedMediaIds | 拒绝；优先于全部 allow |
| 3 | 有效分级为 null | 仅按 allowUnrated；父子允许名单均不能覆盖未评级限制 |
| 4 | 已评级，父或当前子 ID 命中 allowedMediaIds | 允许，覆盖普通等级上限，沿用既有 MEDIA_ALLOWED 语义 |
| 5 | 未命中允许名单，有效分级不超过 maxContentLevel | 允许，沿用 LEVEL_ALLOWED |
| 6 | 其他 | 拒绝 LEVEL_EXCEEDED |

空与非空 allowedMediaIds 都不是播放的必要门槛。例：12岁上限、有效16岁、父在允许名单→允许；有效10岁、父子均不在非空允许名单→允许；父在允许名单但子被禁止→拒绝；父子未评级且allowUnrated=false→即使命中允许名单仍拒绝。

父子只允许一层；普通 NAS/IPTV 无关系时原规则不变，包括儿童频道名单。resolve、revalidate、renew、seek、交付、进度写入使用同一入口，关系/等级/名单变化即时重验。设置按父节点组织并展开子项，不将对某来源整剧的允许扩展到其他来源同名影片。此处保留既有名单语义；父子继承这一新增能力仍须规格/ADR 接受。

### 3.6 会话绑定固定定位输入及 generation 生命周期

新增 playback 所有的会话输入绑定，键为 householdId/sessionId/generation，包含：playbackSourceId、sourceId、locatorRevision、detailRevision、contentRevision、continuityRevision、evidenceDigest/state、resolvedInputId、resolvedAt、expiresAt（可空）。

OnlineVodLocationPort 接收已授权候选和期望版本，返回只在服务端使用的 ResolvedVodInput：上述身份/版本 + 选定入口 URL + 允许的固定请求策略。地址是服务端私有快照，不进入公共 DTO、日志或客户端参数。

source.version 继续用于设置 CAS；新增单调 locatorRevision 用于定位有效性。改名只增加 version，不中断播放；启停均增加 locatorRevision（防禁用再启用的 ABA），定位相关设置变化也增加它。API 根地址不可原地替换，须新建来源。禁用后新的/活动播放资源请求都拒绝，已有快照不能绕过启停。

probe、入口清单、转换及 seek 必须使用当前会话绑定的同一个 resolvedInputId，禁止各阶段重新按 playbackSource.location 查询最新地址。私有快照按引用保留，不能因为详情缓存 TTL 淘汰而断开活动会话。暂停不释放；stop/failed/expired/撤销释放，换代在旧代无引用后回收；进程重启使旧播放失效，重新 resolve。

准备期间允许一次地址刷新，但必须发生在接受 probe/安装输出之前，且内容修订与证据状态一致（unverified一致不构成字节相同的保证）；刷新后的唯一输入同时用于 probe 和交付。seek 创建新 generation 时沿用原定位输入，不自动刷新到另一地址版本。活动播放地址过期则失败并引导新 resolve，不中途自动换线路。重新解析是否续播仍以 3.3 为准。

固定的是服务端定位输入，不是外部媒体字节：入口 URL 相同也可能返回变化的清单/分片。unverified 不承诺跨请求内容不可变；发现明确替换或协议异常时失败，不能因此自动取得 verified 资格。

#### generation 绑定与回收规则

| 阶段 | 原子状态及副作用 |
| --- | --- |
| resolve | 初始会话/进度绑定捕获版本；输入尚未解析时保持 preparing，不允许交付；绑定失败后会话终结并清理，不能留下可用票据 |
| 首次定位完成 | CAS 校验 session/version/generation 与期望来源/证据状态，登记 resolvedInputId 并取得一个 generation 引用；失败的陈旧定位结果直接释放 |
| 同代准备重试 | 最多一次替换尚未接受的定位输入；替换前取消旧 probe 并丢弃结果/资产，再 CAS 切换引用；只接受新输入产生的 probe，不允许同代两个有效输入 |
| seek/会重建输出的选择 | started 已确认且授权有效后，在同一短事务 CAS 推进 generation、建立新代对同一 resolvedInputId 的引用、撤销旧代交付资格并记录旧代待清理；CAS失败不产生新引用 |
| 新代准备成功 | 仅当它仍是当前代且版本重验通过才安装输出/置ready；输入引用不变化；旧代结果永不回写 |
| 推进代次前失败 | 保持原代有效；不改变已有票据/输入，返回既有错误 |
| 推进代次后失败或超时 | 当前新代转failed，撤销其交付并清理；不回退 generation、不复活旧代；用户重新resolve |
| stop/failed/expired/撤销 | 先持久标记不可交付及待清理，再停止任务/取消网络；幂等释放引用。暂停不终结、不释放 |

输入注册由 playback 管理，一个 generation 最多一个有效绑定；resolvedInputId 可被同一会话多个新旧代短暂引用，但仅当前代可授权新交付。代次推进与输入绑定/旧代撤销必须共用 playback 事务，不能先递增 generation 再异步补绑定。

清理不等待网络/ffmpeg 完成而持有事务。旧代取消后，待在途读取租约和转换任务全部退出，再删除资产及释放最后引用；请求级租约必须有期限/可取消，超时强制收敛。终态清理队列/标记持久化，进程内重试和启动时扫描可恢复；重启按既有规则使遗留活动播放失效，回收无活动引用的输入。禁止仅靠内存引用计数或一次性回调保证回收。

## 4. 数据模型与完整性约束

所有业务表、唯一键、仓储查询和缓存带 householdId，关联采用家庭复合外键；既有媒体迁移默认保持原身份/数据，不继承 005 的空库豁免。

| 表/实体 | 拟议字段及修改 | 所有者 |
| --- | --- | --- |
| media_source | kind 加 vod；remoteUrl 必填，NAS 字段/EPG 绑定为空；version、locatorRevision | sources |
| vod_source_config | householdId/sourceId 主键，adapter=apple-cms-json；预算使用统一配置，不接受脚本/任意请求头 | sources |
| media_item | 复用现有字段；父 type=movie/series/video，子 type=episode；新增明确角色/扩展投影，不靠 type 猜父节点 | media-catalog |
| media_relation | householdId/parentId/childId，kind=vod_episode；子项最多一个父级，父不得为子项，禁止自环 | media-catalog |
| vod_title | id/sourceId/upstreamVodId/parentMediaId/detailRevision/materializedAt；parentMediaId 家庭内唯一 | online-vod |
| vod_line | id/titleId/lineKey/displayName/sortOrder/present | online-vod |
| vod_episode | id/lineId/episodeKey/label/sortOrder/playableMediaId/sourceEntryId/present/contentVersionState/evidence/continuityRevision/continuitySignature 字段 | online-vod |
| source_entry | identityKind 加 vod_episode；稳定定位摘要，lastSeenAt；不要求完整刷新 job | sources |
| playback_source | locatorKind 判别；静态记录维持现有 location；online_vod 记录 location 可空，使用独立 vodEpisodeRef 关联；protocol=hls | sources 的资源登记发布接口 |
| vod_detail_snapshot | titleId/revision/locatorRevision/fetchedAt/expiresAt/validatedPayload，私有不可变；title 指向当前修订 | online-vod |
| playback_input_binding | 3.6 所列私有会话版本与快照引用 | playback |
| vod_materialization_operation | scope(家庭/设备会话/上下文版本)/operationKey/requestDigest/status/result/committedAt/expiresAt；唯一(scope,key) | online-vod协调器的持久幂等仓储 |
| 进度状态/历史扩展 | 内容/连续性修订、证据状态、可信duration、completed；延续既有epoch/seq写入规则，静态媒体判定不变 | personal-data |
| profile_vod_preferences | 家庭/Profile主键，autoplayNext默认true、switchCarryPosition默认true、version；仅个人API访问 | personal-data |
| vod_episode_sequence | title/line/detailRevision下的稳定子项顺序、显式集数与冲突状态；与定位身份分开 | online-vod |
| playback_transition_intent | 家庭/设备/上下文版本/Profile绑定，fromSession/generation、目标mediaId、continuityRevision、服务端冻结位置/时长、用途/过期/消费状态；短期且有界 | playback |

静态/在线 locator 使用数据库 CHECK 保证互斥：静态必须 location 非空、vodEpisodeRef 空；online_vod 必须 location 空、vodEpisodeRef 非空。资源读取返回判别联合，不用特殊 URL 前缀；旧数据显式迁移为静态 locator。

约束与一致性要求：

- upstreamVodId 是 1–255 字符字符串；lineKey/episodeKey 1–255，标签最多255；title/description 复用现有 255/4096 上限，简介转纯文本。超限明确校验失败，不截断身份字段。
- 唯一键：(家庭,源,upstreamVodId)、(家庭,title,lineKey)、(家庭,line,episodeKey)、(家庭,playableMediaId)、(家庭,sourceEntryId)。各映射必须指向同源、同父影片且 child mediaId 与 entry/resource.mediaId 相同。
- 跨表类型/同源/一层关系等 CHECK 无法表达的约束，由所有写入口共享领域校验并在统一事务内验证；不得仅靠 UI。复合 FK 防跨家庭，唯一约束防重复占用。
- online_vod resource 与 vod_episode 的循环引用通过“先建映射、再条目/资源、最后补全引用”的同事务步骤解决，必要 FK 延迟至提交检查；不能分事务暴露空引用。
- 发布只有完整验证详情才能标记该影片中移除项 missing；网络失败、搜索未命中、预算截断不是删除依据。present 的权威在 source_entry，vod 映射中的 present 作为事务同步投影，禁止独立更新。
- 父可浏览=至少一个已发布 present 子项 + 启用来源 + 完整 locator；子有候选与 probe 可播放是不同状态。父不可 resolve；父可用性不注入可播放候选集合。
- catalogRevision 覆盖关系、可见元数据/启停、入库展示变化；detailRevision 是详情快照版本；contentRevision 只表示内容更替。三者不可互换。

### 4.1 匿名预览与持久物化

推荐**匿名详情只写有界临时缓存，不创建永久 media_item**。已登录且已选 Profile 的用户点击播放时，先执行幂等 materialize，再用返回的内部 child mediaId 调用现有 resolve。该步骤只登记家庭资源，不写个人历史；来源仍须属于配置的家庭、已启用并经过有效策略检查。

临时 titleRef/episodeRef 不等于永久媒体 ID。物化失败不进入播放；成功但未实际起播也不产生观看记录。物化与 resolve 分开响应，不能假装一个 HTTP 调用具有跨调用原子性；物化接口重试可复用媒体。

**成功物化即登记为家庭媒体，并在同一事务提交后进入公共媒体库和设置策略候选列表**；展示仍需满足来源启用及父级可用性。取消 enrolledAt 和 started 后入库事件，不需要为目录成员资格新增 outbox。started 只负责个人历史/进度，不影响公共目录成员资格。物化成功但后续播放失败，媒体仍可公开浏览；不是个人“看过”标记。

建议初始持久配额为每家庭 5000 父节点/100000 子项，达到上限返回配额错误，不淘汰有历史或策略引用的 ID。未起播、未引用的物化数据保留24小时后可整组回收；幂等结果保留期内不得回收其目标，且必须无活动或保留中的终态会话外键、历史、策略名单和其他持久引用，并通过各所有者事务协调清理。ID 不重复利用。引用检查与删除同事务，避免并发首次 started 丢历史。此配额是可配置产品建议，不是现有实现事实。

### 4.2 物化事务、首次策略事实与幂等重放

事务外：验证请求结构/防跨站请求、当前会话，查找已提交幂等结果；没有已提交结果时再验证临时预览和完整详情。上游网络、解码及解析不进入写事务。

事务内通过同一UnitOfWork显式绑定identity-access、profile、policy只读事务端口，以及sources、media-catalog、online-vod和幂等仓储写端口；这些上下文保持各自所有权，不由协调器直查私表。配额以该事务中的权威行数/计数器检查，不用缓存值；事务回调同步，禁止await网络或独立仓储再提交。建议BEGIN IMMEDIATE，等待锁也受限，锁忙返回可重试错误。

提交顺序：

1. 再查(scope,key)幂等行，处理并发已提交结果；校验最新会话/有效Profile/上下文版本和来源版本/启用状态。
2. 按稳定定位键查已有父子映射、人工分级及策略；不存在的ID仅在内存预分配，构造受信任临时事实，不先提交资源。允许名单始终匹配内部ID，临时ref不参与。已有子项blocked/人工分级不能漏查，默认未评级不能覆盖既有人工设置。
3. 通过3.5同一策略规则检查用户选中的子项。首次未评级且策略拒绝时整个操作不写资源；完整影片的其他分集仅登记元数据，不授予它们播放权限。每个实际resolve仍各自授权。
4. 校验预览所绑定的定位配置及详情修订；有冲突返回409，不对用户已选择的内容做隐式CAS重试。检查新增净条目数与配额、唯一键、关系约束。
5. 首次物化一次发布全影片；已有映射且详情未变化仅复用，不更新detailRevision/catalogRevision；需要更新时通过同一完整发布事务提交差异。仅地址/采集时间更新不改公开catalogRevision；公开字段/可用性变化或首次登记才递增一次，私有详情修订可独立递增。
6. 将规范请求摘要、目标稳定ID、选择的内容修订、提交时详情/目录修订和成功结果写入幂等表，与所有资源变化一起提交。崩溃后要么全部成功可重放，要么全部回滚；没有“业务成功但幂等记录丢失”的窗口。

幂等重放优先于临时预览TTL：已提交相同请求无需旧预览仍有效，但必须用当前身份、当前有效策略、来源和当前目标内容修订重新校验。身份失效沿用现有错误；内容替换/目标missing返回409要求重选，不返回旧的可播放承诺。重放不刷新上游、不再次占配额、不递增修订；返回存储结果（其revision表示原提交时刻，当前详情另行查询）。新operationKey、同一已物化目标可复用现有ID，但仍须有效预览与当前授权。

事务外查到的成功重放也必须在短只读一致性事务中完成幂等记录、身份/策略与资源重验，避免检查过程中被清理；不持锁进行网络读取。

幂等记录建议保留24小时（固定从committedAt起算，重试不续期），成功结果中的目标在此期间受删除保护。清理必须先过期幂等行再检查其余引用，在同一清理事务中完成。过期后该key不再承诺重放，按新请求执行并要求有效预览；稳定映射尚在则复用，已被合法清理则新建ID，绝不返回已删除ID。操作失败回滚资源和成功记录；持久幂等行数量有界，达到上限在写资源前拒绝。不同scope不能重放旧结果，切档需新operationKey和有效候选。

## 5. 接口契约（拟议；统一 /api 前缀）

公共上下文由部署服务端决定，不接受匿名 householdId；公共响应无源配置 ID、上游 URL、locator、播放凭据或 Profile 数据。opaque ref 应是有状态随机映射或不可解密令牌，不能使用仅签名的明文 URL/base64 载荷掩饰地址。所有字段需进入共享 schema/OpenAPI，未知输入字段拒绝。

### 5.1 管理

| 接口 | 契约 |
| --- | --- |
| GET /settings/sources | 扩展 vod；地址沿用现有脱敏，显示 capability.resume=operational（本期apple-cms-json，需本次probe） 和说明 |
| POST /settings/sources | kind=vod/name/remoteUrl/adapter；沿用管理员、设置授予与当次密码规则；新建返回201 |
| PATCH /settings/sources/:id | 沿用现有 CAS/密码 DTO；改名/启停；根地址变更400；版本冲突409；返回新 version |
| POST /settings/sources/:id/test | 设置权限+当次密码；仅对登记地址有界探测；200 返回 reachable/compatible/capabilities，网络不通为测试结果，设置授权失败仍401/403 |

测试不创建媒体、不宣称全部可播；第一期不提供任意 URL 测试接口。vod 不支持旧全量 refresh/快照确认操作，后端也拒绝，不只隐藏按钮。

### 5.2 搜索与分页

`GET /public/vod/search?q=...`：q trim 后1–100字符，200 创建短期 searchId。`GET /public/vod/search?searchId=...&cursor=...`：读取/生成后续页；两种参数互斥，混用400。响应固定结构：

```json
{
  "searchId":"opaque", "items":[{"titleRef":"opaque","title":"示例剧","year":"2026","sourceLabel":"源 A","posterRef":null}],
  "sources":[{"sourceRef":"opaque","status":"ok","hasMore":true}],
  "nextCursor":"opaque-or-null", "partial":false, "reasons":[], "expiresAt":"UTC timestamp"
}
```

不返回伪造总数。每源状态 ok/empty/timeout/invalid/unavailable；正常有下一页不算 partial；失败/截断通过 reasons 明示。全部失败502，预算期限耗尽504，空结果且成功来源无匹配仍200。

服务端按固定来源顺序轮询缓冲队列，保留每源已取页号、未消费条目、(source,VOD ID) 去重集合；按需再取上游页。一次返回最多20条，未展示条目不能丢弃。每个 searchId 最多缓存2000条；达到上限终止并返回 partial/budget_truncated。失败源本次搜索不自动补抓，用户重搜重试。

同 cursor 的并发请求合并，已生成页面不可变且重试同结果；只承诺**已生成页重放稳定**，不承诺实时上游未读取部分的全局快照或无遗漏。cursor 绑定家庭/searchId/页位置，不由客户端修改来源分页。失效/重启丢失返回410 VOD_SEARCH_EXPIRED；版本失配410，跨家庭或伪造 ref 404。禁用等失效优先于缓存重放，不能返回已禁用源旧页。

建议 TTL 为10分钟；页面 URL 保留 mode/q/searchId/cursor，恢复时以 searchId 为准，过期保留 q 重搜；不自动把旧 cursor 套到新搜索。

### 5.3 临时预览、物化与稳定详情

`GET /public/vod/titles/:titleRef` 返回 VodPreviewDto：title/description/year/sourceLabel/posterRef、previewRevision、fetchedAt/expiresAt、lines[{lineRef,name,episodes:[{episodeRef,label,status,reason}]}]。status=candidate|unsupported，reason 可为 identity_ambiguous/format_unsupported；没有永久 mediaId、播放地址或个人状态。详情最多20线路、每线2000项、总计5000项；超限整体422，不截断后据此判 missing。预览缓存过期410，完整协议失败502。

`POST /vod/materializations`：要求有效设备会话、已选Profile及防跨站请求保护；body={titleRef,episodeRef,previewRevision,operationKey}，不接URL/profileId/householdId。按4.2执行事务、预分配内部身份和策略校验，成功即公开入库，不写观看历史。

首次新operationKey成功201（目标可复用已有映射），同scope/key/digest成功重放200；返回 {parentMediaId,mediaId,detailRevision,catalogRevision,replayed}。同key不同摘要409；未提交请求的预览修订变化409、预览过期410、配额409。已提交重放先于预览过期判断，当前身份/策略拒绝沿用既有同形规则；当前内容修订变化或资源已移除返回409 VOD_MATERIALIZATION_STALE。重放前不要求再访问上游。重放结果的revision是原提交版本，不表示此刻详情未变化。

operationKey建议为客户端生成的UUID，长度/格式由共享schema约束；请求摘要覆盖原始ref、previewRevision和选择，不含密码。scope由服务端验证的家庭/设备会话/上下文版本构成，客户端不能指定；保留和清理按4.2。409需重新读取预览并选集，不自动替换目标。若成功提交但响应丢失，即使旧预览随后过期，24小时内也能在当前授权仍有效时重放。

`GET /public/media/:id` 继续 PublicMediaDto，添加可选 detailKind=vod_title|vod_episode、parentMediaId；不混入个人信息。`GET /public/media/:parentId/episodes` 返回 VodEpisodePageDto={parentMediaId,detailRevision,lines,nextCursor}，每页最多100个分集，cursor 绑定详情修订，修订变化409 VOD_DETAIL_CHANGED。它与预览使用不同 DTO：稳定分集含内部 mediaId，无 episodeRef。父不存在/跨家庭/不可用404，非父节点400。

`GET /public/media` 展示所有已成功物化且可用的vod父节点，子项不重复铺卡片；NAS 独立媒体不变。稳定详情缓存过期可重取上游，但所有更新必须经过统一发布事务；上游失败时返回旧完整快照并显式 stale=true/fetchedAt，若无可用旧快照则502；已明确删除的项不能 stale 复活。

第一期推荐 posterRef 全为 null；同源海报代理留后续，不在第一期新增任意远程图片请求链。

### 5.4 播放及续播时序

保留 `POST /playback/resolve {mediaId,startMode}`，不增加客户端 URL、时长或位置字段。执行顺序：

1. 设备/当前Profile校验；读取可信媒体角色和父子有效策略。子项按完整策略及资源授权；父节点仅做家庭/浏览可用性及策略检查后返回下一步的选集错误，不调用要求存在播放候选的collectCandidates。未授权与跨家庭保持现有同形错误。
2. 授权后识别父节点，父 resolve 返回400 VOD_EPISODE_REQUIRED；子项读取已发布来源/内容版本，建立 preparing 会话，绑定 epoch、修订和证据状态。
3. 经 OnlineVodLocationPort 获取会话私有输入；必要时一次详情刷新。若内容/连续性修订、证据或 locatorRevision 与绑定不一致，标记 failed，不继续 probe 或重新绑定。
4. 以该输入执行可信 probe；仅接受标准 VOD HLS（非 live/event 未完结窗口），检查所有重定向、清单、分片、密钥/字幕网络访问。
5. probe 后统一计算 resumeDisposition=resume|beginning；resumeConfidence=verified|operational|none；reason=accepted|requested_beginning|no_history|identity_ambiguous|content_changed|continuity_changed|duration_changed|completed|invalid_position|duration_unknown。冻结服务端位置；前端不指定位置。现有控制 DTO 不返回私有版本/URL。
6. 转换启动/输出安装和 ready 提交前，重验 Profile 上下文、有效策略、来源 locatorRevision/启用状态、内容/连续性修订与证据、session generation/version。失配清理并 failed；短事务不得等待外部网络。
7. 轮询、发票、交付、renew、seek、进度继续重验同一绑定；所有实际输入使用同一 resolvedInputId。地址过期不换源，明确失败并让用户重新 resolve。
8. 只有实际 playing、已交付且 started 被接受才产生历史。started 确认前的 seek/切换、周期样本和 stop/finalProgress 继续遵守005现有排序、重试及 generation 规则。

准备总期限沿用 Resolver 的统一预算，详情刷新、probe 和转换准备不能各自重新领取完整期限。取消后停止网络和转换，陈旧结果不能回写。

历史item扩展在线resumeConfidence和resumeReason，canResume 统一来自3.3；静态媒体原行为不变。`GET /me/vod/titles/:parentId/progress` 为新增个人聚合，当前验证 Profile 域、Cache-Control:no-store；返回 {latest:null|HistorySummary,resumeCandidate:null|HistorySummary,nextEpisodeAction:null|NextEpisodeSummary}；HistorySummary含mediaId/lineLabel/episodeLabel/lastViewedAt/canResume/resumeConfidence/resumeReason，NextEpisodeSummary仅含目标内部ID和可展示元数据。从该父下按 lastViewedAt DESC/mediaId DESC 取最近实际观看记录，已下架/已完成仍返回但canResume=false，并可返回独立nextEpisodeAction（由序列计算、不含票据）；页面不自动跳集。父级继续观看按最近未完成记录选取，latest保持最近实际记录，新增resumeCandidate独立字段，避免混淆。不存在父节点404，无记录200 latest=null；游客不请求，切档清缓存和旧在途响应。

### 5.4a 自动连播与完成状态

新增个人偏好GET/PATCH /me/vod/preferences，按当前验证Profile读取/写入；PATCH带expectedVersion及operationKey，CAS/幂等，响应no-store，不接客户端profileId。自动下一集默认开启，可在播放器关闭；切档重新读取，不沿用上个Profile开关。

适配器生成独立episodeSequence：优先解析“第N集”、纯数字及受支持的SP标签；仅对明确连续的常规集号自动选择N+1，不用数组下标跨过缺集、重复号、季边界、预告/花絮。集数识别只用于导航，不改变3.4稳定定位身份；无法确定时显示手动选集，电影不自动播另一线路。连播只在同源同线路发生，不跨源合并。

播放器收到自然ended，且本次可信duration/服务端已接受进度接近结尾（建议最后5秒），提交现有finalProgress/stop；服务端根据既有可信进度条件标记completed。普通seek到尾、卸载、错误、暂停不触发自动连播；服务端需校验seek记录及末段合理的进度推进/已交付事实，单个客户端ended标记不能作为合法完成证据。重复完成回调按同会话/代次幂等。完成及最后位置更新与stop保持同事务，started未确认不得伪造完成；此处需正式扩展既有final/stop契约的ended语义并补负向测试。

结束后显示5秒“下一集”倒计时（取消/立即播放/关闭连播），只获取下一集元数据，不预先取票或建播放会话。倒计时结束经下述transition-intent明确请求；服务端重新检查当前Profile/偏好、上一会话的合法完成及序列修订，确定下一集。下一集独立策略鉴权，不因上一集允许而自动放行。正常连播从头；若下一集已有未完成历史，提示“继续上次进度/从头”，取消自动倒计时，避免覆盖已有观看。

### 5.4b 便捷换源与服务端过渡意图

播放器内提供“线路/换源”：当前线路候选即时显示，跨源按当前影片名服务端并行搜索，按规范标题+明确年份/季度/语言版本+明确集号生成候选；标题相同不代表同一版本。候选DTO含匹配字段、matchConfidence=high|ambiguous|conflict、集名/来源展示名及测速状态，不含地址或其他Profile进度。high要求规范标题、明确年份、剧集季度及集号一致且版本/语言无冲突；缺少必要年份/季度信息归ambiguous，明确不同年/季/集或剪辑版本归conflict。电影不要求季集号，但仍要求年份及版本匹配。规则版本随候选冻结，用户确认不得把conflict提升为high。

提供有界“测速”POST /vod/switch-probes，body={fromSessionId,expectedGeneration,candidateRefs}（最多3个）；验证当前播放归属/Profile及候选权限后，服务端测可达性/首清单或有限首片延迟，固定超时/字节预算并安全读取，不建历史、不授予播放票据。结果仅称响应延迟/可达性，不冒称持续带宽或实际画质；可取消、限流。政策拒绝不探测，且不暴露详细拒绝原因。由online-vod协调合法候选适配器，禁止客户端URL测速。

用户主动点击目标后，默认“保留当前进度”；目标线路已有目标记录时明确显示“接当前播放位置/继续目标记录/从头”。只有high匹配可默认携带位置，ambiguous必须人工选择具体集并确认版本（仍标operational），conflict不允许携带位置。候选无精确集映射不按原列表下标切换。

新增POST /playback/transition-intents：

- body={fromSessionId,expectedGeneration,action:next|manual_next|switch,targetRef?,targetMediaId?,previewRevision?,positionMode:carry|target_history|beginning,operationKey}；targetRef与targetMediaId互斥；next由服务端选目标，不接任意目标。无客户端position/duration/Profile字段。
- next要求合法completed及本Profile开启自动连播（用户立即手动下一集可使用独立manual_next动作，仍由服务端选目标）；switch要求原会话仍为当前身份所有且允许观看，started已确认。手动切集也可复用switch但默认beginning。
- 切换前暂停原播放，按既有seq提交pause并收到确认；服务端从最新已接受进度冻结carry位置和可信时长，记录来源session/generation与历史revision，不读另一个Profile。未保存的最后几秒不以客户端参数补偿；提示可能略有回退。
- 需要物化时先走4.2幂等物化；其响应不含播放授权。随后创建不透明intent，绑定当前设备/Profile/上下文版本、来源/目标修订及冻结位置，建议TTL60秒，唯一(scope,operationKey)。跨上下文资源物化与intent创建分两次明确提交，可重试，物化成功但intent失败不回滚公共媒体。
- intent只表示播放意图，不是票据。原会话终止后intent仍可在同一上下文消费；授权失效/切档/源禁用/内容变化使其失效。不能让旧intent因切回原Profile复活。

扩展POST /playback/resolve：保留原{mediaId,startMode}，允许可选transitionIntentId；带intent时mediaId必须等于其目标，startMode与intent语义一致且不接受任意起点。消费intent、创建新preparing会话/epoch/进度绑定在同一短事务CAS完成；记录intent→新session结果，相同intent重试返回同一会话的当前状态，不新建多会话；终态不复活。重放也重验当前授权。其余请求继续按既有resolve行为。

切换推荐顺序：暂停并确认位置→物化/建立intent→final/stop旧会话→resolve目标。发生在停旧会话前的失败可恢复原播放；旧会话已终止后失败展示重试/重新播放原源，不能复活旧session。切换目标仍走完整probe与鉴权；carry位置只有目标本次duration与来源duration差异在3.3阈值内且位置有效才使用，否则从头并明确提示，不能用百分比强行映射。target_history只读目标本Profile记录并执行3.3；beginning始终0。

只有目标实际started后才写目标mediaId历史；不修改/合并原媒体历史、策略、contentRevision或内部身份。切换链路中可能有两个preparing/清理中的会话，但前端仅有一个活动播放控制器；重复ended、连点换源和倒计时取消通过operationKey、intent消费CAS及客户端递增操作序号去重。切档/退出/组件卸载撤销倒计时、候选测速及未消费intent，旧响应不能触发下一次播放。失败不自动循环换源。新增DELETE /playback/transition-intents/:id，以当前身份/归属校验幂等取消未消费intent；已消费不停止目标会话，停止仍走现有stop。取消与消费CAS竞争，取消成功不得随后建档，消费成功的重放返回原session。

### 5.5 错误与HTTP缓存

新增错误统一登记 Problem registry：410 搜索/预览过期，409 详情变化/幂等冲突/配额，400 父项不可直接播放，502 上游不兼容/不可用，504 总超时，429 限流。异步准备失败使用已登记的会话 failureCode（必要时扩枚举），不能仅添加 HTTP Problem 却把未知码写入 session；恢复建议=retry_resolve|reselect_episode|beginning_only|retry_transition，均不含上游报文。

认证、策略、跨家庭和旧上下文错误沿用现有同形边界，不能用 VOD 专用错误提前泄露存在性。公共在线搜索/预览使用 no-store，由服务端内部有界缓存；稳定媒体读取按 catalogRevision/详情修订失效。所有个人/控制/设置响应沿用现有私有缓存规则，不允许浏览器公共缓存包含进度。

## 6. 页面与文件改动范围（未来实施）

| 位置 | 修改 |
| --- | --- |
| features/settings/settings-sources-page.tsx | vod 配置、测试、启停、CAS；显示版本证据/续播能力；后端同步拒绝全量刷新 |
| features/catalog/VodCatalogPage.tsx | 媒体库/在线搜索；query URL 与分页快照；部分失败、截断、过期状态 |
| 新 OnlineVodDetailPage.tsx | 临时预览，不自动跳转或永久入库；保留 episodeRef，播放时走登录/选档→materialize→resolve |
| features/catalog/MediaDetailPage.tsx | 稳定父详情、分页线路/选集、分集播放；父级最近观看来自个人接口 |
| features/playback/use-play-action.tsx 对应入口 | 支持物化前置步骤、409重新选择、失败恢复；仅内部 mediaId 进入原 resolve |
| 播放页 | 续播/从头、自然结束倒计时、连播开关、线路/来源抽屉、匹配提示/测速及位置选择；串行处理transition并展示失败恢复 |
| 历史页 | 本Profile最近集数、继续观看/从头、完成状态与operational提示；跨设备使用服务端记录 |
| routes、query keys、共享 schema/OpenAPI | 临时预览和稳定媒体分域；个人键包含身份；旧响应不得跨档案回写 |

PC交互使用HeroUI。详情/历史“继续观看”使用同源同线路记录，进入播放器后可一键从头；服务端probe后回退需显示原因。播放器提供快捷下一集、自动连播开关和换源入口，不强迫退出播放器重搜。匹配警告不显示实现细节，只说明“版本可能不同”及是否保留位置。个人偏好、历史、过渡意图按Profile隔离，公共详情不携带这些状态。

## 7. 预算、缓存与迁移

建议预算：最多10个启用源（设置端超额拒绝，不静默遗漏）、并发3、单次上游5秒、搜索总8秒；预览8秒；搜索页20、每搜索2000；缓存总量/每IP请求/每家庭并发均需配置上限，超额429或明确预算错误。等待并发槽也计入总期限。详情有明确响应字节上限（建议4MiB）和5.3所述条目上限；原始响应不写公开日志。

私有详情缓存建议5分钟，预览/搜索10分钟，活动输入保留至会话释放；所有键含家庭/来源/locatorRevision。来源改名可更新展示并失效搜索缓存，但不使播放输入失效；禁用立刻拒绝新请求，已发出的响应/已缓冲媒体不可撤回。

网络访问经公开安全读取端口或平台能力，不能直接导入 sources 私有实现；明确 DNS、重定向及非公网许可继承，默认不把 IPTV 的内网许可自动扩展给 vod。无任意上游请求头，要求特定 cookie/Referer 的源本期不兼容。

迁移包含 SQLite CHECK 枚举重建、locator 判别、复合FK、索引和旧静态记录回填。不能要求升级清库；在独立副本做 up/down/up、含在线与既有业务的备份恢复，明确 down 对新增在线数据的限制与匹配镜像恢复路径。回滚不能静默丢数据或让已撤销会话复活。

## 8. 实施顺序与验收证据

1. 产品确认第9节，形成 Accepted 功能规格及 ADR：事务协调、身份/版本、有效策略、物化及数据生命周期。
2. 新表、迁移、公开端口和统一事务；用故障注入验证每一步失败/进程中断都无半发布，重复 operationKey 不重复建档。
3. adapter fixture：重复/空标签、改名、地址变化、可信证据不变/变化/缺失、超大详情、部分源失败与分页重放。
4. 先完成私有输入与版本重验，再接页面：测试绑定后内容更新、禁用再启用、改名、切档ABA、seek换代、资产TTL、重启；不得等到 progress 才发现修订失配。
5. 续播与策略：基础源operational续播成功、重启/跨设备同Profile恢复、不同Profile不可互读，内容/连续性变化和时长异常回退；父allow/子deny等全表，原始位置/URL篡改、started前无历史、最终样本幂等。
6. 连播/换源：自然结束与seek到尾区分、缺集/重复号/季边界停止、下一集独立拒绝、重复ended/连点只生成一次新会话；高匹配carry成功、歧义确认、时长异常从头、测速无票/无历史、切档取消，旧会话停止后的失败不复活。
7. 真实浏览器Network和Linux Docker验证：在线HLS master/media/相对路径/密钥/重定向、起播/seek/暂停恢复、停止后同源续播、自动下一集及换源携带位置；至少一组有序多集源和两来源同集样本留证，记录operational匹配限制。真实源不稳定、上游替换风险与硬件能力分别说明；无真实证据不能标Verified。既有静态媒体续播单独回归。

发布前还需证明匿名接口不永久扩库、不泄露地址或个人信息，配额清理不删除活动/历史/策略引用，已有 NAS/IPTV 与静态续播不退化。单元/契约/静态检查不能代替真实起播验证；本文件不声称任何实现或运行验收完成。

## 9. 产品待确认项：推荐与理由

本轮用户已明确要求第一期纳入续播、自动连播和便捷换源，保留Profile隔离及播放鉴权。此前“不交付在线续播/连播”的取舍由本轮范围替代；仍不等于规格Accepted或代码实施授权。待评审的是阈值、交互默认及匹配降级策略。

| 取舍 | 推荐方案 | 理由与代价 |
| --- | --- | --- |
| 在线续播 | 第一期开启operational同源续播，服务端probe复核；真实停止/重启后续播验收 | 接近日常追剧体验；接受上游无提示替换无法完全检测的定位风险，权限不放宽 |
| 自动连播 | 默认开，本Profile可关；5秒可取消，同源同线明确N+1 | 减少操作；有未完成目标记录则询问，不覆盖或自动跨源 |
| 便捷换源 | 主动选择+最多3候选测速，高匹配默认携带服务端已保存位置 | 降低重搜成本；不自动轮换，歧义确认/冲突从头 |
| 电影是否父子建模 | 电影/剧集统一父节点，线路分集为子项 | 统一多线路、名单和历史导航；代价是单片也多一层，UI可隐藏只有一个子项的选择步骤 |
| 不同线路进度 | 历史独立；显式换源可用服务端intent携带位置，不合并身份/历史 | 携带起点与永久共享进度分开，目标实际started才写目标历史 |
| 游客详情与入库 | 游客仅临时预览；认证播放意图物化成功即进入公共目录，与started无关 | 符合全部可用家庭媒体公开浏览；播放失败不会自动撤销物化 |
| 父级继续观看选集 | 默认最近未完成集；最近记录完成则单独显示“播放下一集”，需用户点击，页面不自动开播 | 已完成内容与继续观看分开；播放器自然结束才走自动连播 |
| 父子策略 | 继承匹配事实，保留现有“已评级允许名单覆盖等级上限、未命中仍可按等级通过” | 避免把例外名单误变必要白名单；blocked及未评级规则不放宽 |
| 配额与回收 | 5000父/100000子，未引用未起播24小时回收，引用记录保留 | 控制资源增长且保护个人数据；数值应按NAS实测调整并作为可配置值 |
| 海报 | 首期统一占位 | 减少额外网络/缓存链路，优先验证真实播放闭环 |

## 10. 审查问题对应与参考

| 审查项 | 修订落点 |
| --- | --- |
| 1 半发布可见及物化事务 | 3.1统一事务、4.2身份/策略/配额/幂等同提交、8故障注入 |
| 2 绑定后修订变化 | 3.2失败重建、5.4提交前重验 |
| 3 缺少服务端禁续播依据 | 3.3可信状态/唯一判定/历史时长隔离 |
| 4 标签不是内容身份 | 3.4定位/版本分离及改名规则 |
| 5 父子策略冲突 | 3.5优先级表及全授权链一致 |
| 6 快照未绑定会话 | 3.6固定定位输入、generation原子推进/失败不回退/持久清理 |
| started入库与事件丢失 | 4.1取消enrolledAt及入库事件，物化提交即公开 |
| 预览过期与幂等重放冲突 | 4.2/5.3已提交重放优先，24小时目标保护及当前授权 |
| 证据状态转换和真实交付 | 3.3 operational匹配与转换表、第5.4a/b连播/换源、第8节真实验收 |
| 7 匿名永久扩库 | 4.1临时预览/认证物化/配额清理 |
| 8 搜索分页不稳定 | 5.2缓冲/重放/实时上游限制 |
| 9 父子约束和DTO缺失 | 4唯一性/关联、5.3不同DTO、5.4父节点拒绝顺序 |

本地依据：.specify/memory/constitution.md；docs/specs/005-pc-browsing-flow/contracts/api.md；apps/server/src/platform/database/schema.ts；playback/application/playback-authorization.service.ts、playback-resolver.service.ts；personal-data/application/progress-clock.service.ts、history.service.ts、progress-write.service.ts（均位于apps/server/src/contexts）；Web VodCatalogPage.tsx、MediaDetailPage.tsx。

上游参考：[搜索](https://github.com/LibreSpark/LibreTV/blob/main/src/app/api/search/route.ts)、[详情](https://github.com/LibreSpark/LibreTV/blob/main/src/app/api/detail/route.ts)、[解析](https://github.com/LibreSpark/LibreTV/blob/main/src/lib/cms-parser.ts)、[许可证](https://github.com/LibreSpark/LibreTV/blob/main/LICENSE)。引用沿用前次源码调查，本轮未重新验证上游变化。

## 11. 实施对齐（2026-10-31）：讨论稿→已实现差异

010（online-vod）已实施完成（自动化测试全绿；真实环境采样 Not-run 项见 [specs/010-online-vod/evidence.md](specs/010-online-vod/evidence.md)）。本节列出讨论稿与实际交付语义的关键差异；正文上文按历史讨论稿保留，不回写，冲突处以 010 契约为准：

| 讨论稿旧描述（§出处） | 实际交付语义（010 契约/实现） |
| --- | --- |
| 「2xx 即已保存」（5.4a 暂停上报后默认携带；§3 携带"服务端已保存位置"） | `ProgressReply.applied` 只指**个人历史写入**；`sessionAccepted/acceptedSampleSeq/acceptedGeneration` 是独立会话接受视图（010 api.md §1）。仅投递未接受不得显示为已保存（FR-015/032）；carry 只取来源会话 ledger 已接受游标（I2 checkpoint 精确相等校验） |
| 「stop 推导完成」（5.4a 完成及最后位置更新与 stop 同事务） | stop 仍 **204**，无 auto-next 资格；自然完成由 `POST .../finish` 的 `FinishReceipt` 独立记录（finalSessionAccepted/historyApplied/sessionCompleted/autoNextEligible 分列），先赢 stop 使后到 finish 返回 `stopped_elsewhere` 且不补写 final（010 api.md §4） |
| 「位置须>0且<duration-30秒」最后30秒必从头（§3.3） | 接近结尾窗口 min(30秒,10%) **仅 UI 提示**，不自动算完成；未完成且位置在时长范围内允许尝试续播，不因位于最后30秒强制从头（spec FR-019）。自然结束容差为 min(5秒,5%)，由尾段观测在 finish 判定 |
| 「generation 重置队列/卸载最终保存」（§背景） | session 级命令泵统一周期/最终保存与卸载兜底；generation 切换**不重置 seq、不触发 session stop、不卸载最终保存**（ADR0016 §8；009 非阻塞面保持） |
| 「仅 operationKey 去重」（5.4b） | 每来源 session/generation 一个持久**单后继 slot**；intent 创建/消费双端重验、消费与后继会话同事务、取消输家必须找回并清理（010 api.md §5/§7 I5） |
| `DELETE /playback/transition-intents/:id`（5.4b） | 实际为 `POST .../cancel`（有权上下文，可返回 successor）+ `POST .../cleanup`（I5 失权最小清理，不返回目标信息） |
| 「建议阈值可配置初值」（§3.3/§7） | 预算/配额/容差按 010 契约初值实现并受 `VOD_BUDGETS`/`SWITCH_PROBE_BUDGETS` 契约快照钉面（[evidence/performance.md](specs/010-online-vod/evidence/performance.md)） |
| 「匿名预览/物化/配额/回收」提案（§4.1/4.2） | 按提案方向实现：candidateRef 物化分支（I1）、24h 重放保护、引用图整组清理（`online-vod-materialization.e2e-spec.ts`、`online-vod-retention.e2e-spec.ts`） |

未变的核心取舍（operational 续播、同源同线连播、主动换源不自动轮换、Profile 隔离、普通源不宣称指纹证明）与讨论稿一致，均已交付。
