# API Contract: PC 公开浏览与个人观看体验

状态：Proposed；2026-10-26。机器可读契约为同目录 openapi.yaml；本文件规定授权次序、状态与并发语义。所有路径统一 `/api` 前缀，JSON camelCase，错误 RFC9457 `application/problem+json`。旧接口不作为兼容别名保留。

## 1. 统一安全与响应规则

- 四类边界：Public（匿名、从部署确定 Household），Session（有效设备会话），Profile（Session+服务端当前有效 Profile），Settings（Session+Account owner/admin+当前主 Profile+有效设置 grant）。敏感设置修改额外当次 ownerPassword。
- 设置校验先于读取主体；异步密码/PIN 验证后、事务写入前重验身份/版本/grant。目标不属于本家庭与不存在统一 404；非法输入 400，状态冲突 409，锁定 423，限频 429，缺少新代际存储或内部策略不可用 503。
- 所有响应包括错误 `Cache-Control: no-store`；播放与凭据相关响应 `Referrer-Policy: no-referrer`。公共浏览不返回 Set-Cookie、不读取身份决定内容范围；即便携带失效 cookie 仍可公开浏览。
- Cookie 使用既有 httpOnly、SameSite 会话；Bearer 继续作为非浏览器备用认证。所有写操作和带密码的查询必须校验同源 Origin（存在时必须与配置 origin 精确匹配），拒绝跨站 Cookie 请求与非 JSON 简单表单；无 Origin 的显式 Bearer 客户端仅按认证规则，不以 absence 放宽 Cookie 写入。
- 未知 JSON/query 字段一律拒绝，不能通过 householdId/profileId/isAdmin 解锁或扩大权限。密码和 PIN 只在当次请求 body，不进入地址、日志或本地持久存储。public/个人/播放 JSON 请求体<=16 KiB，名单管理整体写入<=512 KiB，其余设置<=64 KiB。
- 公共读取每连接 IP 120 次/分钟，guide 30 次/分钟；进度每 DeviceSession 60 次/分钟；沿用 004 播放控制限频。429 返回 Retry-After，限制表有 TTL 和数量上限，代理信任显式配置。

## 2. 公共浏览

| 方法与路径 | 输入 | 结果 |
| --- | --- | --- |
| GET /public/context | 无 | `{initialized,displayName,language,timezone,now,catalogRevision}`；无账号/来源/档案；未初始化返回默认展示值 |
| GET /public/media | q<=100,type?,page>=1,pageSize=20/max100 | PublicMediaPage；仅当前家庭可用内容，非策略过滤；可搜索、稳定标题/id排序 |
| GET /public/media/{mediaId} | 媒体 ID | PublicMedia，无个人状态、无播放 URL |
| GET /public/media/{mediaId}/programmes | 频道 ID | 当前/下一节目及now/timezone/catalogRevision；非频道400；无匹配200 unavailable |
| GET /public/live/groups | 无 | `{items:[{key,label}],now,timezone,catalogRevision}`，仅可用频道分组，无源ID |
| GET /public/live/channels | section=now/next/group/all，groupKey?，q?，page,pageSize=20/max50 | ChannelPage={items,page,pageSize,total,now,timezone,catalogRevision}，频道摘要+current/next/group；now/next按 spec 排序；all/group包括无 EPG 可用频道 |
| GET /public/guide | date=YYYY-MM-DD,from,to 为 UTC，page,pageSize=20/max50 | GuideWindow，包含 timezone,now,allowedDates,catalogRevision,频道行及节目块 |

PublicMedia 精确字段：id,type,title,description(nullable),posterRef(nullable),contentLevel(nullable),availability。public 目录/详情只返回 available；个人数据关联摘要可返回 unavailable。posterRef 仅认可的同源资源或 null，绝不转发任意外部带凭据地址。

Programme 精确字段：key,title,description,startsAt,endsAt。key 为不透明标识，不包含 sourceId、XMLTV 原始 ID 或路径。ChannelRow={media,groupKey,groupLabel,current,next}。无current/next为null，频道本身仍存在。直播分组、频道列表与单频道programmes的每个响应都附now/timezone/catalogRevision，三者来自该请求自己的同步快照；不要求不同HTTP请求的now相等。

GuideWindow={date,timezone,now,allowedDates,from,to,page,pageSize,totalChannels,catalogRevision,channels:[{media,programmes:Programme[]}]}。返回起止完整 UTC 时间，UI 按窗口裁剪。重叠当前节目选 startsAt 最近、同起点按 key 升序。手动 EPG 关联失效保持 unavailable，不回退其他来源。

只允许家庭今天至未来6天；from/to 窗口必须落在该日真实边界内且 to>from（跨度上限即该日真实日长，普通日 24 小时），缺省 from/to 返回该日完整 24 小时全天窗口，查询 `startsAt<to && endsAt>from`。23/25小时日按 IANA 日期边界计算，不以浏览器时区或固定24小时计算。日期已过期409 GUIDE_DATE_EXPIRED，error.allowedDates 为新范围；尚未到允许未来范围400 VALIDATION_FAILED；超过2000节目或2MiB返回422 GUIDE_WINDOW_TOO_LARGE（建议减少每页频道数），不能静默截断。EPG 与绑定读取同一同步快照。

## 3. 账号、首建和最小档案入口

| 方法与路径 | 边界 | 请求 / 结果 |
| --- | --- | --- |
| GET /setup/status | Public | `{initialized}`，未知/存储故障503，不伪装未初始化 |
| POST /setup/initialize | Public+同源 | 原家庭/账号字段；201 `{initialized:true}`，无会话、无设备注册、无 Set-Cookie；重复409 |
| POST /auth/login | Public+同源 | username,password,deviceType,deviceName；200 SessionDto，一次性 sessionToken 仅此返回 |
| GET /auth/session | Session | SessionDto；含服务端householdId、bootstrapRequired、profileContextVersion、账号与当前档案最小摘要 |
| POST /auth/logout | Session/已失效幂等 | 撤销会话和设置授予、清 cookie；204 |
| POST /auth/bootstrap-profile | Session+管理角色+当次密码 | `{name,pin,ownerPassword}`；201 ProfileSummary，不自动选档；已有档案409 BOOTSTRAP_ALREADY_DONE |
| POST /auth/main-profile/pin-recovery | Session+管理角色+当次密码 | `{newPin,ownerPassword}`；204，仅重设当前家庭主档案PIN，清除目标档案活动身份并中断旧播放；不返回管理主体、不签settings grant |
| GET /profiles | Session | 选档摘要数组，禁用状态可见但不可选；不返回策略、锁定计数、失败日志等设置主体 |
| POST /profiles/{profileId}/unlock | Session | `{pin}`，沿用一次性选档授予，成功200；与设置验证共享持久失败计数 |
| POST /profiles/{profileId}/select | Session | `{ownerPassword?}`；目标已保护时要求选档授予；返回当前 SessionDto，实际换档使 contextVersion++、撤销设置授权 |

ProfileSummary={id,name,avatar,type,isDefault,isMain,pinProtected,status,createdAt,version}。无档案时只允许受限首建；PIN 6位数字。bootstrap先校验Session/角色，再严格必填字段；缺ownerPassword为400 VALIDATION_FAILED、合法格式但错误密码403、密码锁定423。账号名/密码错误统一提示，密码验证锁定与既有规则一致。

SessionDto 的 activeProfile 可为 null；bootstrapRequired=true 仅表示零档案，不允许客户端借字段写入身份。会话还原与选档摘要不是一般设置数据，允许在未解锁前读取，但不包含 PIN、设备详情或来源。

## 4. Profile 收藏与续播历史

| 方法与路径 | 输入 | 输出 |
| --- | --- | --- |
| GET /me/favorites/channels | cursor?,limit=20/max100 | `{items:[{media,createdAt,current,next}],nextCursor}` |
| PUT /me/favorites/channels/{mediaId} | `{}` | 204，channel且可用，重复不更新时间 |
| DELETE /me/favorites/channels/{mediaId} | 无 body | 204，已不存在仍成功；允许取消已失效频道收藏 |
| GET /me/history | cursor?,limit=20/max100 | `{items:[HistoryItem],nextCursor}`，按服务端 lastViewedAt/id倒序 |
| GET /me/history/{mediaId} | 无 | HistoryItem 或200 null（没有个人记录）；已不可用也只返回该Profile自己的摘要 |

HistoryItem={media,lastViewedAt,positionSeconds,durationSeconds,canResume,revision}。身份只从 Session 当前 Profile 推导，不接受 profileId。canResume 要求 available、同 content_revision、可信 duration 且 0<position<duration；无效或结尾仅从头播放。该数据不得嵌入公共详情或共享缓存。

游标包含类型、家庭、Profile、排序时间和 ID，使用部署本地密钥签名；篡改或当前 Profile 不匹配400 INVALID_CURSOR，不回落其他身份。公开列表采用页码，不接受个人游标。

## 5. 播放接入与进度协议

现有004的GET状态、renew、媒体交付、seek、selection、15秒heartbeat继续使用受控授权与代次规则，不进入设置PIN。设备播放记录迁入设置范围。所有播放会话新增profileContextVersion绑定，控制/交付/进度均重验；实际换档事务终态化旧上下文播放并撤票，A→B→A不能复活。005明确扩展如下：

### resolve

POST `/playback/resolve` body=`{mediaId,startMode:'beginning'|'resume'}`（默认beginning）；201仍仅表示接受，无票+Location。不能上传 profileId、householdId 或任意 startPosition。resume 仅点播；频道请求resume返回400 PLAYBACK_SEEK_UNSUPPORTED。

可信probe完成后、任何转换输出启动或direct输出安装之前，服务端读取当前Profile最新有效历史，按资源修订和可信duration冻结本次presentationStartSeconds；无有效位置则0。ready提交仅重验身份版本、资源修订与generation，不改变已经准备输出的offset；冻结后的本次启动不被另一个设备后来的观看悄悄重定向。客户端在第一张播放画面前安装目标，转换交付仍用原影片逻辑时间轴；准备或定位失败不覆盖历史。

### progress

POST `/playback/sessions/{sessionId}/progress` body=`{sampleSeq,expectedGeneration,positionSeconds,reason}`，reason=`started|periodic|pause`；200 `{applied,reason,historyRevision}`，historyRevision可null，reason=`accepted|duplicate|stale_sample|superseded`。

- 每10秒、暂停及首次playing上报；started仅在实际playing时发送。客户端按同seq/payload重试started直到收到确认，确认前周期/暂停样本排队；未确认即停止时空stop并提示未保存，不能跳过started用final建立历史。首次started确认前禁用/排队用户seek及会重建输出的音轨切换，确认后再执行，不能在原generation重试途中推进generation；取消/空stop始终可用。服务端验证Session、当前Profile、最新策略/资源、playback绑定、状态、当前generation、resolve时profileContextVersion、已发生媒体交付和可信duration。duration未知时拒绝进度写入409 PROGRESS_NOT_READY，不由客户端提供时长。
- candidate epoch在resolve事务分配；仅首次有效started使历史可见并领取该媒体写入权，较新已起播意图胜出，旧session上报superseded但不终止其合法播放。
- sampleSeq正整数且跨generation保持递增；等于最后seq+相同规范化载荷返回同一结果（允许reason duplicate，不更新revision/排序）；相同最后seq不同载荷409 PROGRESS_SAMPLE_CONFLICT；较小seq返回stale_sample。generation冲突409 PLAYBACK_GENERATION_STALE，不推进seq。
- 不使用客户端时间或MAX(position)做排序/合并；允许主动后退、从头播放写低位置。资源修订变化409 PROGRESS_RESOURCE_CHANGED，旧播放不改新资源历史。
- 再授权失败拒绝个人数据写入；会话终态后不接收progress。解析成功、未实际起播或直播均不建立点播历史。

### stop 与最终保存

POST `/playback/sessions/{sessionId}/stop` body=`{finalProgress?:{sampleSeq,expectedGeneration,positionSeconds}}`；204。无finalProgress沿用既有取消准备能力。活动态同一事务先验证并处理finalProgress，再终态化；其语义等同reason final且必须已started。stale/superseded的final不覆盖历史但停止成功。invalid position或generation冲突返回409/400且不部分保存，客户端提示未保存后可再以空body停止。

已终态的重复stop保持204，不用新finalProgress重写历史。没有实际started的准备取消不允许伪造最终历史。身份撤销后的stop沿用既有最小幂等清理规则，不允许夹带历史写入。

退出/换档流程先尝试有界1秒final保存/停止，再改变身份；失败不能阻止用户退出，提示进度未同步。卸载keepalive只作尽力补充；所有重试保留原seq和规范化payload，不能用旧身份离线回放。

## 6. 设置授权与管理路由

| 方法与路径 | 请求 / 响应 | 额外条件 |
| --- | --- | --- |
| GET /settings/access | `{unlocked,expiresAt}` | 仅Session；任一有效会话（含未选档/普通档案）可读最小状态，无有效grant则200 unlocked=false、expiresAt=null；不读管理主体 |
| POST /settings/access | `{pin}` → 200同上 | Session+当前主Profile+管理角色；独立PIN验证，15分钟固定TTL；不得要求已有grant；已有有效grant时成功重验仍返回原到期时间，不续期 |
| DELETE /settings/access | 204 | 仅Session，撤销当前授予，幂等；不要求现有有效grant |
| GET /settings/account | AccountSummary | Settings |
| PUT /settings/account/password | `{ownerPassword,newPassword}` →204，清cookie | Settings+当次密码；撤销全部旧会话、设置授予和选档授予 |
| GET/PATCH /settings/household | HouseholdSettings；PATCH `{expectedVersion,name?,language?,timezone?,ownerPassword}` | Settings；PATCH当次密码+CAS |
| GET/POST /settings/profiles | ProfileSummary[] /创建Profile | Settings；POST当次密码 |
| PATCH /settings/profiles/{profileId} | 编辑/停用/PIN，新增expectedVersion | Settings+当次密码+CAS；不能清主PIN或停用最后档案 |
| PUT /settings/main-profile | `{profileId,expectedVersion,expectedCurrentProfileVersion,expectedProfileVersion,ownerPassword}` | Settings+当次密码；expectedVersion为家庭mainProfileVersion，expectedCurrentProfileVersion为现任主档案version，expectedProfileVersion为目标version；三项CAS，目标必须active adult有PIN；完成撤销全部设置授予 |
| GET/PUT /settings/profiles/{profileId}/policy | 继承002字段 | Settings；PUT当次密码+CAS |
| PUT /settings/profiles/{profileId}/policy/lists | 继承003名单整体替换 | Settings+当次密码+CAS |
| GET/POST /settings/sources，PATCH /settings/sources/{sourceId} | 继承003来源DTO | Settings；写入当次密码+既有CAS |
| GET /settings/source-roots | 继承003root列表 | Settings |
| POST /settings/sources/{sourceId}/refresh | 继承003 RefreshRequest | Settings+当次密码，幂等operationKey |
| GET /settings/refreshes/{refreshId} | 继承003任务状态 | Settings，轮询失效即停止 |
| POST /settings/refreshes/{refreshId}/confirm、discard | 继承003 JobAction | Settings+当次密码+CAS |
| POST /settings/catalog/candidates/query | 继承003候选查询 | Settings+当次密码 |
| PATCH /settings/catalog/media/{mediaId} | 继承003人工修正 | Settings+当次密码+CAS |
| POST /settings/catalog/media/{mediaId}/epg-binding/query、epg-candidates/query | 继承003绑定/候选查询 | Settings+当次密码 |
| PUT /settings/catalog/media/{mediaId}/epg-binding | 继承003设置/解除 | Settings+当次密码+CAS |
| GET /settings/devices | 继承001设备列表 | Settings |
| POST /settings/devices/{deviceId}/revoke | `{ownerPassword}` →204 | Settings+当次密码；撤销目标设备所有会话和授予 |
| POST /settings/devices/{deviceId}/playback-records/query | 继承004设备记录查询 | Settings+当次密码，不能用作个人历史 |

管理迁移保留既有数据校验、源URL脱敏、外部读取许可、快照确认与手动绑定语义。新settings前缀是替代，不保留旧`/sources`、`/catalog`、`/devices`等管理入口。`/profiles`只保留选档GET/unlock/select，旧POST/PATCH移入settings；bootstrap与PIN恢复是经过用途限制的唯一例外。

主档案转移请求必须同时提供家庭主档案版本、现任档案版本和目标档案版本，任一不符409且无部分写入。管理写入统一服务端expectedVersion检查；旧001缺Profile版本的契约在005新增，未知属性拒绝。主档案转移成功的响应只返回新主档案ID与mainProfileVersion，不返回已无权读取的设置主体。前端关闭设置并进入切档验证；不静默激活目标。

## 7. 稳定错误与授权次序

新增：SETTINGS_PIN_REQUIRED/SETTINGS_ACCESS_REQUIRED/SETTINGS_ACCESS_EXPIRED（403），PROFILE_PIN_LOCKED（423），BOOTSTRAP_ALREADY_DONE/MAIN_PROFILE_CONFLICT/VERSION_CONFLICT（409），GUIDE_DATE_EXPIRED（409），GUIDE_WINDOW_TOO_LARGE（422），INVALID_CURSOR（400），PROGRESS_NOT_READY/PROGRESS_SAMPLE_CONFLICT/PROGRESS_RESOURCE_CHANGED（409），STORAGE_GENERATION_UNSUPPORTED（503）。保留既有SESSION_INVALID（401）、ACTIVE_PROFILE_REQUIRED（403）、播放404同形与限频429。

一般设置主体次序：存储就绪→Session→角色/当前主Profile→grant有效性→严格入参→当次密码（敏感操作）→重读身份/grant/目标归属/版本→事务。/settings/access为独立入口：GET/DELETE仅Session；POST校验Session、管理角色、当前主档案及PIN，不先查已有grant。Session已因注销、撤销或改密失效时先401；仅Session仍有效但档案/grant不满足时403，不能统一改成403。公共只读不执行SessionGuard；me要求Session→activeProfile归属/状态→严格入参→数据归属，不以target profileId切换身份。

## 8. 契约权威与替代矩阵

openapi.yaml包含005最终目标操作、复用的004播放/媒体操作和迁入settings的既有DTO。以本文件和data-model.md覆盖新的授权/进度语义；机器契约不能仅凭security字段表达主Profile/PIN，操作描述与x-access补充其要求。

001自动登录初始化与旧管理路径、003策略过滤的观看目录、004“详情不可见则无入口”的展示要求，由005提出替代；004受控播放、资源交付、转换/字幕能力及15秒heartbeat仍保留。旧heartbeat明确不直接写个人历史，新progress与finalProgress是新增个人业务，不静默改变heartbeat含义。所有替代仍需新ADR接受与领域/旧规格显式同步后才能实施。
