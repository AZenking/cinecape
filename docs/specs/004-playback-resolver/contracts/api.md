# Playback API contract（设计，未实现）

统一/api，JSON camelCase，RFC9457 application/problem+json，所有响应Cache-Control:no-store、Referrer-Policy:no-referrer。媒体字节也不得公开缓存。JSON控制写操作须同源/CSRF校验；Cookie浏览器同源，Bearer客户端逐请求携带原认证。token不能单独授权。

## 公共数据类型

PlaybackDto={id,state,version,generation,desiredPaused,delivery,positionSeconds,durationSeconds:null或有限非负数,timelineOffsetSeconds,presentationStartSeconds,ticketExpiresAt,playbackUrl,tracks:{audio:[{id,label,language,default}],subtitles:[{id,label,language}]},failureCode?}；delivery在探测完成前为null；playbackUrl/ticketExpiresAt始终nullable且除renew响应外为空，tracks探测未完成为空。preparing表示请求已接受，ready表示探测/准备完成、可申请票；GET不重签也不复现旧票。URL仅服务端同源路径，无源地址。delivery只展示播放器需要的模式；不返回所选源ID/位置、ffmpeg命令或stderr。

TicketReply={playbackUrl,ticketExpiresAt,generation}，URL携带opaque ticket；访问日志必须去掉ticket，页面不向第三方发送referrer。

## 控制端点

| 方法/路径 | 请求 | 成功 | 行为 |
|---|---|---|---|
| POST /playback/resolve | {mediaId} | 201 PlaybackDto + Location | 认证→当前档案/PIN→最新策略/家庭可用资源；同步授权/家庭可用资源通过后建立preparing session，delivery与URL为空，不等待完整probe，201仅表示接受；无法授权不建session。主动重复请求各建新session |
| GET /playback/sessions/{id} | 无 | 200 PlaybackDto | 仅原有效设备会话+原当前档案，可轮询准备状态；无新票时playbackUrl为空，等待ready后以该generation调用renew取票 |
| POST /playback/sessions/{id}/renew | {expectedGeneration} | 200 TicketReply | 仅ready/playing/paused；完整重授权、终态拒绝，复用任务/session，仅换票；默认5分钟TTL；首次ready后立即申请，以后提前60秒续期 |
| POST /playback/sessions/{id}/heartbeat | {positionSeconds,paused} | 204 | 每15秒；位置是非授权遥测，仅用于本次播放，不作为阶段5观看进度持久化；不能复活终态 |
| POST /playback/sessions/{id}/stop | {} | 204 | 幂等，原设备可重复停止，取消准备也使用此接口 |
| PUT /playback/sessions/{id}/selection | {expectedVersion,positionSeconds,audioTrackId,subtitleTrackId:null或id} | 200 PlaybackDto | 授权后原子换轨/字幕；重建音轨时generation/version各+1并进入preparing无票，ready后renew；纯字幕切换只version+1且返回现状态，不重启视频；不新增session，冲突409 |
| POST /playback/sessions/{id}/seek | {expectedVersion,positionSeconds} | 200 PlaybackDto | NAS定位，新generation+version；旧票立即失效，返回preparing且无票；ready后renew申请新票，目标恢复<=15s；直播400不支持 |
| POST /devices/{deviceId}/playback-records/query | {ownerPassword,cursor?,limit?} | 200 {items,nextCursor} | owner+当次密码，重验家庭目标；limit默认20最大100，按时间/id倒序游标；no-store；返回当前家庭该设备的session及failure事件，无源位置/ticket |

数值有限非NaN；position>=0，不能越duration；选择只能引用已探测轨道；未知字段拒绝。跨设备/家庭session统一404。renew/seek/selection最终提交前重验授权以防异步探测窗口变更；前端以session/generation丢弃旧响应。解析控制请求限每设备每分钟30次（resolve/seek/selection），renew每分钟10次，超限429+Retry-After；媒体分片不套此频率，受并发/backpressure预算。

## 媒体端点

GET/HEAD /playback/stream/{sessionId}/{generation}/{assetId}?ticket=...：入口清单、分片、初始化片、key、字幕均为资产ID，不接受URL或路径参数。每次SessionGuard→ticket hash及TTL→绑定session/device/profile→最新策略与源事实→generation/asset归属→交付。ticket不能用于其他session/generation，asset枚举不存在统一404。

- HLS MIME application/vnd.apple.mpegurl；内部相对URI重写后只指向本入口，原清单禁止原样返回。key/octet-stream、字幕text/vtt；字幕只含文字，播放器不以HTML执行。
- NAS direct支持GET/HEAD/单Range：200/206、Accept-Ranges:bytes、Content-Length/Content-Range一致；越界416，多个Range400；HEAD与GET同鉴权，HEAD不发送字节。
- 媒体请求开始后源故障：未发headers时problem；已发字节则关闭流并将session失败码写入，客户端轮询获取友好原因，不能在字节流内注入JSON。
- HLS HTTP读取遵循research R3，重定向不返回给浏览器。拒绝DRM及未知URI标签；客户端断开必须取消读取。
- 逐请求授权拒绝后不再交付新响应；不承诺撤回已缓存内容或已开始发送的响应。后台监督终止无授权转换。

## 稳定错误

401 SESSION_INVALID（包括无会话/失效/撤销）；401 PLAYBACK_TICKET_INVALID / PLAYBACK_TICKET_EXPIRED；403 ACTIVE_PROFILE_REQUIRED或PIN既有错误；404 MEDIA_NOT_FOUND（不存在/跨家庭/不可见/无源同形）；404 PLAYBACK_NOT_FOUND（非本设备会话）；409 PLAYBACK_NOT_READY / PLAYBACK_VERSION_CONFLICT / PLAYBACK_GENERATION_STALE / PLAYBACK_ENDED；400 PLAYBACK_SELECTION_INVALID / PLAYBACK_SEEK_UNSUPPORTED；422 PLAYBACK_FORMAT_UNSUPPORTED；503 PLAYBACK_CONVERSION_BUSY / PLAYBACK_STORAGE_LIMIT / PLAYBACK_PERFORMANCE_INSUFFICIENT / PLAYBACK_RESOURCE_UNAVAILABLE；504 PLAYBACK_PREPARE_TIMEOUT / PLAYBACK_SEEK_TIMEOUT；429 PLAYBACK_RATE_LIMITED。策略变化使媒体不可见时仍统一404，不返回策略明细。失败事件只记录公开稳定码，no source diagnostics。

## 异步失败与兼容

probe/转换异步失败可在已创建session上表现failed，不得与解析拒绝的failure_event混淆；失败准备释放额度。repeat stop幂等，换代请求CAS。renew不改变selection/version；expectedGeneration为>=1整数，在签发票的短事务内比较当前generation，不一致409 PLAYBACK_GENERATION_STALE且不写票。preparing时409 PLAYBACK_NOT_READY。客户端发送seek/换轨前先递增本地operationEpoch，renew响应只有请求epoch仍匹配且session/generation一致才可安装，不能只按响应generation判断；旧票后续因generation变化拒绝。浏览器每次renew取得的URL不可写入localStorage或审计日志。

本契约为人可读设计；实施前转为独立OpenAPI 3.1（含所有JSON/媒体/错误与安全声明），生成playback-schema.d.ts，不覆盖001/002/003类型；契约测试验证状态、字段和无敏感信息，不以类型生成证明运行行为。

## 时间轴及请求预算

NAS的positionSeconds/durationSeconds是原影片逻辑时间；转换manifest的本地时间加timelineOffsetSeconds对应影片时间，presentationStartSeconds指定需要跳过的目标前区间，播放器不展示目标之前的画面。滚动HLS使用应用进度条；seek/换轨响应返回新offset及目标位置。直播duration=null且不提供影片seek。

Native HLS浏览器使用同源Cookie且到期前轮换入口；hls.js加载器对子资源附加最新ticket。所有子资源仍校验asset归属及generation，ticket更新不放宽权限。控制接口JSON体<=16KiB，owner记录查询密码缺失按现有家长验证规则拒绝；日志过滤query ticket。HLS上游不得收到应用Cookie/Bearer，禁止透传其Set-Cookie。

状态机、字段可空性与资源排序以[data-model.md](../data-model.md)为唯一权威。PlaybackDto包含desiredPaused；heartbeat.paused更新该意图，seek/selection从服务器读取并保留；seek保留暂停意图，换轨后同样恢复。renew首次签发与常规轮换共用端点，首次ready前不签票，异步失败无可用URL。stop后GET允许原有效设备查询终态，不能以终态签票。
