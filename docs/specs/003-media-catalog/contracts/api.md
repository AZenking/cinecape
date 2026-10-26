# Catalog API 与交互契约

日期：2026-10-23；2026-10-24 追加手动 EPG 设计契约（尚未实现，旧契约实现/证据仍属于基线）。[openapi.yaml](openapi.yaml) 是可生成共享类型的机器契约（JSON 语法属于 YAML 1.2）；本文定义其语义与权限。统一 `/api`，沿用 Cookie/Bearer 和 RFC 9457。

## 权限与验证顺序

观看接口：SessionGuard → 当前数据库会话/设备/档案有效与归属 → 最新策略 → 同家庭真实资源 → 判定 → DTO；列表和详情均无 owner 内容豁免。无档案 403 ACTIVE_PROFILE_REQUIRED，策略缺失/损坏 503 POLICY_UNAVAILABLE，不把它们作为空列表。

管理写入/候选查询：SessionGuard → owner → 严格格式校验 → verifyParentPassword → 重验会话/设备有效 → 目标归属 → 版本检查 → 事务。密码缺失或空串统一 403 REQUIRED；错误/锁定沿用阶段 2，不能以请求校验 400 代替已定义缺密码语义。所有 body 的 ownerPassword 在 schema 可选是为表达 403，业务执行必需。

来源/任务概览 GET 只给 owner 提供名称、类型、状态、版本、数量和脱敏提示，不返回 raw URL、文件路径、内容样本或原始解析错误。任何需要候选内容或实际配置目标的操作另经家长验证；本期没有返回完整私密地址接口。

## 来源管理

- GET /sources：分页，owner；SourceDto 含 id、kind、name、enabled、version、epgSourceId、locationLabel（仅远程 origin 的脱敏主机标签或 rootKey；没有 query/path/userinfo）、lastSuccessAt、lastJobId。未知/跨家庭目标统一 NOT_FOUND。
- POST /sources：ownerPassword、name、kind、enabled（默认 true）、remoteUrl（远程必填且 writeOnly），或 rootKey/relativeDirectory（NAS 必填且 writeOnly）；privateAccessApproved 默认 false；epgSourceId 仅 IPTV 可有值。成功 201，version=1。
- PATCH /sources/{sourceId}：expectedVersion 必填；可更新 name、enabled、remoteUrl、privateAccessApproved、epgSourceId（null 为解除）。kind 不可变，NAS 根不可就地改，配置省略保留，remoteUrl=null/空串/掩码拒绝。改远程地址须再次明确 privateAccessApproved，不能继承旧目标的许可。成功 source.version+1、catalogRevision+1，待确认旧快照标 stale。
- GET /source-roots：owner，仅 rootKey 与展示名，不包含绝对目录；可用于 NAS 创建选择。

## 刷新与待确认

- POST /sources/{sourceId}/refresh：ownerPassword、expectedVersion（来源版本）、operationKey(UUID)，成功 202 返回 RefreshDto 与 Location；不等待网络导入结束。同 key 相同语义返回原任务（仍重新验证身份）；同 key 不同来源/版本 409 IDEMPOTENCY_CONFLICT。
- GET /refreshes/{refreshId}：owner，同家庭；返回状态、版本、时间、counts、confirmationReason，不返回源内容/原始条目/播放地址。
- POST /refreshes/{refreshId}/confirm：ownerPassword、expectedVersion（任务版本）；仅 awaiting_confirmation 可执行。校验当前会话、source.version、catalogRevision、snapshot digest 和 24h 有效期；NAS 文件校验未变才单事务发布；成功 200 succeeded，同终态重复确认拒绝 409 REFRESH_STATE_CONFLICT。
- POST /refreshes/{refreshId}/discard：ownerPassword、expectedVersion；仅 awaiting_confirmation；成功 200 discarded，释放来源锁。过期标 expired；过期/已终态操作拒绝。

RefreshDto.status：queued/running/awaiting_confirmation/succeeded/failed/interrupted/discarded/expired/stale。counts 均非负：added、updated、missing、failed、channels、programmes；confirmationReason 为 empty_snapshot/deletion_ratio_exceeded/null。失败 code 稳定，错误提示不拼原始上游信息。任务 version 每次状态变化加一。

## 观看目录

- GET /media：q（最多 100 字符，trim，按标题大小写不敏感字面包含，不把 SQL 通配符当输入语法）、type、page（默认 1）、pageSize（默认 20，最大 100）。只返回家庭可用且当前策略允许内容，total 为过滤后数，items 按 title 二进制顺序再 id 稳定排序；无记录 200 空列表。搜索、分页参数只影响筛选，不参与授权。
- GET /media/{mediaId}：200 MediaDto；不可用、不可见、不存在、跨家庭统一 404 NOT_FOUND。
- GET /media/{mediaId}/programmes：先同样授权，再要求 type=channel；返回 current/next（二者可 null）。无手动绑定时指南未关联/禁用/冲突/无匹配返回 200 {current:null,next:null,status:'unavailable'}；频道本身被禁止仍为 404。当前时刻区间 startsAt≤now<endsAt，下一节目为未来 startsAt 最早项。

MediaDto：id、type、title、description、contentLevel（null 或 0～18）、poster=null、version。首期不主动加载外部海报，无跳转到第三方地址；占位由前端渲染。不返回源 URL、NAS 路径、upstream tvg-id 或 PlaybackSource。

## 家长候选与人工修正

- POST /catalog/candidates/query：ownerPassword、q、type、page、pageSize；绕过观看策略仅为家长管理候选，仍限制 Household；包含 unavailable 候选及 available 布尔。不返回位置或流地址。POST body 避免密码出现在 URL，禁止将密码写本地持久化或长期放内存缓存。
- PATCH /catalog/media/{mediaId}：ownerPassword、expectedVersion、至少一项 title/type/contentLevel。contentLevel=null 为恢复未评级；非频道可在 video/movie/series/episode 内改类型，禁止 channel 跨类别转换；不建立 Series/Episode 关系。成功 media.version+1、catalogRevision+1，原手动标题/类型不被普通刷新覆盖。
- PUT /profiles/{profileId}/policy/lists：ownerPassword、expectedVersion（策略版本）、allowedMediaIds、blockedMediaIds、allowedChannelIds（均必填数组，整体替换三名单）；每名单去重后 ≤1000，每 ID 1～128，校验同 Household，频道名单仅 channel。允许/禁止交集保留。目标 Profile 归属 Household+Account，与是否 active 无关。成功返回阶段 2 PolicyDto，version+1。
- 现有 PUT /profiles/{profileId}/policy（等级与未评级）不扩充名单字段，继续保持名单；两入口同一策略版本，NAS 自动清理也参与同一版本。旧版本请求不得覆盖自动清理结果。

## UI 路由

/sources：来源列表 + 内嵌新增/编辑/刷新结果和待确认摘要；EPG 不另建工作台。
/media：受保护目录；/media/:id：详情与当前/下一节目，无播放/下载按钮。
/profiles/:id/policy：在既有页实现中接入资源选择器；具体沿用现有实际路由命名，不建立重复页。选择器逐次查询验证，保存再次验证；取消/失败清空密码但保留非敏感表单。

Profile 切换立即废弃原目录和节目请求结果，刷新/保存冲突显示重新加载，错误保留输入。轮询任务每 2 秒，进入终态或页面离开停止；401 回登录，家长锁定提示沿用原规则。键盘可操作表单、搜索、分页、确认弹窗。

## 错误

沿用 400 VALIDATION_FAILED、401 SESSION_INVALID、403 FORBIDDEN/PARENT_VERIFICATION_REQUIRED/PARENT_VERIFICATION_FAILED/ACTIVE_PROFILE_REQUIRED、423 PARENT_VERIFICATION_LOCKED、404 NOT_FOUND、503 POLICY_UNAVAILABLE。

新增 409 SOURCE_VERSION_CONFLICT/MEDIA_VERSION_CONFLICT/POLICY_VERSION_CONFLICT/REFRESH_STATE_CONFLICT/REFRESH_STALE/SOURCE_BUSY/IDEMPOTENCY_CONFLICT；429 IMPORT_QUEUE_FULL（Retry-After: 5）；422 SOURCE_TARGET_DENIED（URL/挂载目标非法，创建/修改时）和 SOURCE_DISABLED（禁用源刷新）。导入执行期网络/解析/预算错误落 task failed，GET 仍 200 返回终态，而非把后台失败伪装成 HTTP 500。

## 类型与兼容

新 OpenAPI 生成 catalog-schema.d.ts，shared 独立导出；不覆盖既有 schema.d.ts/policy-schema.d.ts。PolicyDto 引用 002 的当前 OpenAPI 类型。未知新字段严格拒绝，不信任 body/query 中的 householdId/profileId/role/facts。已有阶段 1 身份接口的未知字段剥离语义不在本契约修改。

## EPG 手动匹配增补（2026-10-24，待实施）

以下 POST/PUT 均按管理顺序：SessionGuard→owner→格式→当次 ownerPassword（缺失403）→重验会话→同家庭媒体频道/目标来源→版本→事务。被观看策略隐藏的频道可由家长候选入口管理，但这些端点不替代普通观看授权。禁止密码出现在 GET/query；全部管理请求/响应 Cache-Control:no-store。

- POST /catalog/media/{mediaId}/epg-binding/query：body={ownerPassword}。返回 BindingDto（mode=auto/manual、version、epgSourceId/xmltvChannelId 可空、status=auto/valid/invalid、invalidReason 可空）。无行返回 auto/version=0。管理失效绑定仍可读取。
- POST /catalog/media/{mediaId}/epg-candidates/query：body={ownerPassword,epgSourceId,q?,page?,pageSize?}；q≤100，默认page=1/pageSize=20、上限100。家长先选同家庭 EPG（现有来源概览GET只显示来源名/id/状态，不给内容），服务端要求来源启用且已成功导入。按 XMLTV ID/名称字面大小写不敏感包含搜索，按 displayName/xmltvId 稳定排序；排除 conflicted。返回 {items:[{xmltvChannelId,displayName,current,next}],total,page,pageSize,epgGeneration}，只给该来源的候选。不返回源 URL、路径、密钥。
- PUT /catalog/media/{mediaId}/epg-binding：body={ownerPassword,expectedVersion,mode:'manual',epgSourceId,xmltvChannelId,expectedEpgGeneration} 保存；或 {ownerPassword,expectedVersion,mode:'auto'} 解除，auto 禁带目标字段。expectedVersion 非负整数；manual 要求来源+频道同时存在且当前可用、非冲突，generation 与候选所给值相等。两种操作成功200 BindingDto，version+1。解除无行且 expectedVersion=0 创建 version=1 auto 墓碑；其他旧请求409。锁定由 mode=manual 隐含，不提供 locked=false。

普通 GET /media/{mediaId}/programmes：增量加入 bindingMode(auto/manual)、bindingStatus(auto/valid/invalid)、invalidReason(null/source_disabled/channel_missing/channel_conflict)。旧 status=available/unavailable 只表示 current/next 是否至少存在一个：manual valid 但没有节目仍为 unavailable。manual invalid 时 current/next=null，不自动回退；不包含目标来源或 XMLTV ID。现有不可见/跨家庭404与非频道400不变。

错误：沿用家长验证、会话与NOT_FOUND；非频道400 VALIDATION_FAILED；候选来源未启用/从未成功导入422 EPG_SOURCE_NOT_READY；目标不存在或冲突422 EPG_CANDIDATE_INVALID（同家庭来源内的无效目标）；跨家庭来源或媒体404 NOT_FOUND；绑定旧版本409 EPG_BINDING_VERSION_CONFLICT；目标指南已刷新409 EPG_CANDIDATE_STALE（先版本/generation再重验候选，变化后要求重查）。invalid 是读取状态，不将已保存目标失效当成管理GET失败。无请求能修改媒体名单/等级。

UI：在频道详情和已验证家长候选卡上提供“匹配节目单”，打开同一个 HeroUI 对话框：现有绑定/自动状态、EPG 来源选择、候选搜索/预览/分页、选择保存、解除恢复自动、失效说明。取消/失败清密码，409要求重载绑定和重查候选；候选来源改变立即清空旧选择与 generation。无新增独立匹配工作台或批量应用页面。
