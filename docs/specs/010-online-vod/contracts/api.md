# 010 外部接口契约（Accepted，2026-10-30 冻结；2026-10-31 实施同步）

> **实施状态（2026-10-31，T089）**：本契约已随 T001–T090 交付实现，机器契约 `contracts/openapi.yaml` 已生成并经根 `pnpm gen:types` 纳入 `packages/shared`（含 `vod-schema.d.ts`），前端 DTO 均由生成类型承载、未手写绕过（T020/T085/T090 验证，见 [evidence/release-checks.md](evidence/release-checks.md)）。本节字段/端点语义为实施基线；与实现的行为差异按证据文档记录，不在此虚标。

> **T002 冻结记录（2026-10-30）**：维护者确认 plan.md 末节七项取舍（I1–I5、U1、U2）全部按本文已写入的推荐方案冻结，不得默选替代方案；任何产品变化先重评 spec/ADR。本文件与 [data-model](../data-model.md) 为实施基线：语义变化须先改契约再改代码。迁移号经核验（当前最新 0006_pc_experience）锁定为 `apps/server/src/platform/database/migrations/0007_online_vod/`。
>
> **修订初值语义（冻结）**：`Preferences.version=0` 与 `PlaybackDto.transitionSlot.revision=0/open` 仅是"无持久行"时的传输初值/响应默认；任何持久化行 revision>=1，服务端绝不写入 0 作为持久版本。
>
> **资格区分（冻结）**：`canAttemptResume`（HistorySummary）仅为候选资格；最终续播资格在本次 resolve/probe 后由 startBasis/resumeDisposition 判定；finish/auto-next 资格由尾段观测在 finish 时独立判定（见 playback-state.md）。三者互不替代。
>
> **错误收敛（冻结）**：详情/预览超体积与超条目一律 422 整次失败；搜索无可用源按全源失败 502、全部超时 504；slot 重放以 (operationKey,digest) 幂等——同 key 重放返回原结果不续 TTL，consumed 槽任何新 key 409 并附原后继引用，未消费过期 410 不误作可重新消费。

## 0. 交付格式、兼容与安全

**交付格式（实施后实际）**：本文件与[状态协议](playback-state.md)为语义权威；同一契约已落为 `contracts/openapi.yaml`（010 目标操作与 DTO，含 §7 审查闭环字段），并经根 `pnpm gen:types` 生成 `packages/shared` 类型（`vod-schema.d.ts`）供前后端共同消费——`gen:types` 在 T020/T085/T090 实际执行通过。未列变化时严格继承[005 API](../../005-pc-browsing-flow/contracts/api.md)和对应OpenAPI；不新增旧路由兼容别名。

所有路径前缀/api；camelCase，UTC ISO8601，JSON未知字段拒绝；所有响应含Cache-Control:no-store，播放/私密相关Referrer-Policy:no-referrer。写操作继承005同源Origin/CSRF/JSON/Bearer约束；公共读取不根据cookie过滤内容，不设置身份cookie。家庭从部署推导；身份/个人接口从当前验证Session推导，禁止body/query的profileId/householdId/URL/任意起点。

认证失败401；无当前Profile403；不存在/跨家庭/非本设备/旧上下文按既有404同形；策略损坏503；其他策略拒绝媒体404。Schema非法400、冲突409、过期410、预算体积422、限流429+Retry-After、上游502/总期限504。详细上游错误/地址/凭据不公开。所有私有opaque ref不能携带可解码URL。

公共查询每IP120/min上限内，在线搜索另20/min；Profile控制继承004控制桶，phase观测独立120/min/session，progress60/min/DeviceSession；创建intent/测速各10/min/DeviceSession，resolve仍控制桶。所有桶有TTL和全局数量上限，资源忙返回429不堆无界队列。写body<=16KiB；Settings沿用005独立上限。

## 1. DTO（除明确可选外必填；nullable显式说明）

- `PublicVodCard`：titleRef,title,year:string|null,sourceLabel,posterRef:null。无源配置ID。
- `SearchPage`：searchId,items:PublicVodCard[],sources:[{sourceRef,status:ok|empty|timeout|invalid|unavailable,hasMore:boolean}],nextCursor:string|null,partial:boolean,reasons:string[],expiresAt。
- `VodPreview`：titleRef,title,description:string|null,year:string|null,sourceLabel,posterRef:null,previewRevision,fetchedAt,expiresAt,lines:[{lineRef,name,episodes:[{episodeRef,label,status:candidate|unsupported,reason:null|identity_ambiguous|format_unsupported}]}]。
- `Materialized`：parentMediaId,mediaId,detailRevision,catalogRevision,replayed:boolean,candidateRef:string|null,registeredCandidateRef:string|null。revision为提交时值，不表示当前仍未变化。
- `StableEpisodes`：parentMediaId,detailRevision,fetchedAt,stale:boolean,lines:[{lineRef,name,episodes:[{mediaId,label,availability:candidate|unavailable,sequenceOrdinal:integer|null}]}],nextCursor:string|null。线路可跨页重复，消费者按lineRef聚合，不能把每页线路当新线。
- `HistorySummary`：mediaId,parentMediaId,lineLabel,episodeLabel,lastViewedAt,positionSeconds,durationSeconds:number|null,completed,canAttemptResume:boolean,resumeReason:null|unavailable|content_changed|continuity_changed|completed|invalid_position|duration_unknown,resumeConfidence:operational|verified|none,revision。canAttemptResume不是probe后最终资格；旧HistoryItem.canResume对在线媒体映射为候选资格并追加resumeCheckRequired=true，对静态媒体原语义不变。
- `TitleProgress`：latest:HistorySummary|null,resumeCandidate:HistorySummary|null,nextEpisodeAction:{mediaId,label}|null。无记录三个null；latest取最近实际记录；resumeCandidate取最近未完成且可候选的本Profile子项，无适合项null；下一集action来自latest的确定序列，不自动播放。
- `Preferences`：autoplayNext:boolean,switchCarryPosition:boolean,version。
- `ProgressReply`：保留applied:boolean/reason:accepted|duplicate|stale_sample|superseded/historyRevision:number|null，追加sessionAccepted:boolean,acceptedSampleSeq:integer,acceptedPositionSeconds:number|null,acceptedGeneration:integer,sessionStarted:boolean。applied只指历史写入；superseded可sessionAccepted=true/applied=false；duplicate返回原存储结果不再次写；stale sessionAccepted=false，返回最后会话接受游标供恢复。
- `FinishReceipt`：sessionId,generation,ended:boolean,finalSessionAccepted:boolean,historyApplied:boolean,historyRevision:number|null,sessionCompleted:boolean,autoNextEligible:boolean,reason:completed|stale_final|no_tail_observation|not_started|no_duration|not_completed|stopped_elsewhere,positionSeconds:number|null,durationSeconds:number|null,endedAt,replayed:boolean。没有权限不返回receipt。
- `PlaybackDto`：继承004/005状态DTO，无新增源URL；追加startBasis:beginning|target_history|transition_carry、resumeDisposition:pending|resume|beginning,resumeReason:null|accepted|requested_beginning|no_history|content_changed|continuity_changed|duration_changed|completed|invalid_position|duration_unknown|match_conflict；preparing未冻结= pending。追加transitionSlot:{revision:integer>=0,status:open|reserved|consumed,activeIntentId:string|null,successorSessionId:string|null}供当前归属设备恢复/替换；首次槽不存在revision=0/open。票字段仍只有renew返回，普通GET/resolve不发票。
- `SwitchCandidate`：candidateRef,title,label,year:string|null,season:string|null,versionLabel:string|null,sourceLabel,lineLabel,matchConfidence:high|ambiguous|conflict,matchReasons:string[],previewRevision,expiresAt。source内部ID/位置不下发。
- `ProbeResult`：candidateRef,status:reachable|timeout|incompatible|unavailable,latencyMs:number|null,checkedAt。名称是首清单/有限首片延迟，不宣称带宽/画质。
- `IntentReply`：id,fromSessionId,fromGeneration,action,targetMediaId,positionMode,matchConfidence,slotRevision,status:pending|cancelled|superseded|expired|consumed,expiresAt,successorSessionId:string|null。不返回原始地址；消费前不返回播放票。

## 2. Settings及公共接口

| 方法/路径 | 输入 | 输出/规则 |
| --- | --- | --- |
| GET /settings/sources | 沿用005分页 | 现有来源DTO扩kind=vod及capabilities:{resume:operational,requiresCurrentProbe:true}；只Settings可读 |
| POST /settings/sources | 现有敏感验证字段+kind=vod,name,remoteUrl,adapter=apple-cms-json | Settings+当次密码；201；限10启用源；新源根URL只接受http(s)并校验 |
| PATCH /settings/sources/:id | 原expectedVersion/ownerPassword + name?/enabled? | Settings+当次密码，CAS；根地址字段拒绝；改名不失效活动locator，启停均失效 |
| POST /settings/sources/:id/test | {ownerPassword} | Settings+当次密码；200{reachable,compatible,capabilities,reason:null|timeout|invalid|unavailable}，不写媒体；授权错误不能包装为测试结果 |
| GET /public/vod/search | 首次{q:1–100}，或后续{searchId,cursor?}，两组互斥 | 200 SearchPage；缺cursor重放第一页；每页20，正常next不是partial；全源失败502，全部超时504 |
| GET /public/vod/titles/:titleRef | 无 | 200 VodPreview；ref失效410；跨家庭/伪造404；最多20线路/单线2000/合计5000/4MiB，超限422整次失败 |
| GET /public/media | 原005参数 | vod只展示已物化且可用父项，不重复铺子项；NAS/IPTV行为保留 |
| GET /public/media/:id | 无 | 现有PublicMedia扩detailKind:standalone|vod_title|vod_episode及parentMediaId:null|string；无个人信息 |
| GET /public/media/:id/episodes | {cursor?} | 200 StableEpisodes，每页总计100子项；修订绑定cursor，变化409 VOD_DETAIL_CHANGED；非父400，不可用404 |

搜索：固定来源轮转缓冲、未消费结果保留、按(source,VOD ID)去重；同cursor并发合并；已生成页重放不变，未抓取实时上游不承诺完整快照。10min/最多2000结果；每家庭100个活搜索、1000个活预览，全进程最多256MiB、单详情4MiB，超额拒绝或淘汰最早过期项，ref失效410。禁源/配置失配先失效缓存再拒绝旧页。稳定详情失败可返回旧完整快照+stale=true；成功明确删除不能stale复活。预览/搜索不物化、不建个人记录。

## 3. 物化和个人接口

| 方法/路径 | 请求 | 返回与边界 |
| --- | --- | --- |
| POST /vod/materializations | 严格oneOf：{titleRef,episodeRef,previewRevision,operationKey:UUID}或{candidateRef,previewRevision,operationKey:UUID} | Profile；首次key201 Materialized、同成功key200；稳定key已存在可复用ID；新key必须有效预览 |
| GET /me/vod/preferences | 无 | Profile；200 Preferences，未有行返回默认true/true/version=0，不偷偷写公共状态 |
| PATCH /me/vod/preferences | {expectedVersion>=0,autoplayNext?,switchCarryPosition?,operationKey:UUID}至少一偏好 | Profile；200 Preferences，CAS409；成功key24h重放不再更新版本，先重验当前身份 |
| GET /me/vod/titles/:parentId/progress | 无 | Profile；200 TitleProgress；不存在父404；自己的不可用历史仍能作为latest摘要，不泄露其他Profile |
| GET /me/history及/:id | 继承005 | 在线追加HistorySummary的完成/候选续播信息；canResume候选语义需与005文档一起接受，静态原义不变 |

物化来源/预览/策略事实和新增净配额在同一短事务检查，资源和幂等结果同提交。先查成功重放，再要求预览有效；同key异摘要409 IDEMPOTENCY_CONFLICT；新操作预览变化409 VOD_DETAIL_CHANGED，过期410 VOD_PREVIEW_EXPIRED；满额409 VOD_QUOTA_EXCEEDED；旧结果目标内容/连续性变化409 VOD_MATERIALIZATION_STALE。幂等scope=家庭/DeviceSession/contextVersion，目标24h受回收保护；当前权限失效拒绝而非仍返成功。

## 4. 播放进度/结束扩展

| 方法/路径 | 请求 | 响应 |
| --- | --- | --- |
| POST /playback/resolve | 基础{mediaId,startMode?:beginning|resume}，或过渡{mediaId,transitionIntentId}；过渡禁止startMode字段 | 201 PlaybackDto+Location；相同已消费intent重放200同后继当前状态。父项400 VOD_EPISODE_REQUIRED在身份/策略检查后判，不尝试找父播放资源 |
| POST /playback/sessions/:id/progress | {sampleSeq>=1,expectedGeneration>=1,positionSeconds>=0,reason:started|periodic|pause} | 200 ProgressReply，独立会话接受与历史应用；seq跨generation单调 |
| POST /playback/sessions/:id/observations | {eventSeq>=1,expectedGeneration,event:playing|pause|seeking|seeked|waiting|ratechange|error,positionSeconds>=0,playbackRate:0.5–2} | 200{accepted,lastEventSeq}；同seq同载荷重放，冲突409、陈旧false；无历史/epoch写；授权/交付/phase检查 |
| POST /playback/sessions/:id/finish | {operationKey:UUID,finalProgress:{sampleSeq,expectedGeneration,positionSeconds},cause:natural_end} | 200 FinishReceipt；同payload重放，不在终态升级；硬非法400/409整次回滚；无证据不等于接口失败，可ended=true/autoNextEligible=false |
| GET /playback/sessions/:id/finish-result | 无 | 200 FinishReceipt|null；只当前原设备/原上下文，可用于丢响应恢复；禁止跨上下文读旧结果 |
| POST /playback/sessions/:id/stop | 保留005 body及行为 | **仍204**；无auto-next资格；先赢的stop使后到finish返回not_completed且不补写final |
| GET状态/renew/seek/selection/heartbeat/资产 | 保留004/005输入 | 仅在定位input/generation上扩内部重验，不能绕过来源/连续性；heartbeat不写历史 |

finish/progress/stop共用payload摘要与seq领域机但不同operation身份；收到finish后停周期链并等待已分配样本完成，不让final先越过未决started。final结果使用本次样本，最后10秒周期缺失不单独拒绝。same operationKey异payload409。finish operationKey必须为UUID；session只能有一份不可变finish结果。同operationKey不同digest409；已有receipt且新key不同则409 FINISH_ALREADY_RECORDED，附恢复路径而不重算；旧stop先赢时首次finish只登记stopped_elsewhere receipt而不写新final，endedAt取原终态时刻。finish重放先校验身份/归属再读receipt，不要求活动态；来源禁用/撤销不授予任何继续播放能力；无权读取时只允许既有最小空stop清理。

## 5. 换源、测速和过渡

| 方法/路径 | 输入 | 输出 |
| --- | --- | --- |
| GET /vod/switch-candidates | {fromSessionId,expectedGeneration,cursor?} | Profile+原设备上下文；200{items:SwitchCandidate[],nextCursor:null|string,partial,reasons}；同线/跨源候选只元数据，服务端从来源标题构造搜索，不接任意q/URL；failed可恢复来源仅60s |
| POST /vod/switch-probes | {fromSessionId,expectedGeneration,candidateRefs:1–3} | Profile；200{items:ProbeResult[]}；逐候选预览有效策略检查后有界请求，单候选3s/1MiB、全次5s，内部并发3；无票/无历史 |
| POST /playback/transition-intents | 见下列判别请求 | 201 IntentReply，新key复用已有pending同选择可200；不同选择必须explicit replace；冲突409 TRANSITION_SLOT_CONFLICT |
| GET /playback/transition-intents/:id | 无 | 当前上下文归属；200 IntentReply（consumed含successor）；过期未消费410；完整IntentReply要求当前源/目标权限；失权时不返回完整结果，使用下述cleanup最小清理接口，不借GET发票 |
| POST /playback/transition-intents/:id/cancel | {} | 200{outcome:cancelled|already_cancelled|superseded|expired|already_consumed,successorSessionId:null|string,slotRevision}；取消与消费CAS竞争 |

IntentRequest严格oneOf：
- next/manual_next：{fromSessionId,expectedGeneration,action,nextPlanRef,positionMode:beginning|target_history,expectedSlotRevision,operationKey}。nextPlanRef绑定服务端确定的目标、序列/详情修订及目标历史revision（无历史=0），请求positionMode表示用户对该快照的位置选择；不接受historyChoiceConfirmed或客户端目标ID。自动next要求finish资格和当前偏好；目标有未完成历史时UI必须显式选择后才提交。manual_next不要求偏好/完成。创建及消费均验证计划，目标/序列或目标历史发生变化409 NEXT_PLAN_CHANGED，重新展示并确认，不重新计算后静默消费。
- switch/recover_switch：{fromSessionId,expectedGeneration,action,targetCandidateRef,previewRevision,positionMode:carry|target_history|beginning,confirmedAmbiguous:boolean,sourceCheckpoint?:{expectedGeneration,sampleSeq},allowEarlierAcceptedPosition?:boolean,expectedSlotRevision,operationKey}。target必须可验证候选；high可carry，ambiguous需confirmed且具体集，conflict只beginning/target_history且不能继承源位置。若目标需物化先调用materializations；intent只接受已登记目标的候选映射，不把临时候选自动登记在本事务。

pending替换通过同POST新operationKey+expectedSlotRevision显式替代旧intent，旧标superseded；只有相同选择/digest的成功key可以重放。slot消费后任何新key也409带原后继引用（仅原上下文可见）。同key重放不续TTL。carry必须提供sourceCheckpoint，不接用户position。pauseAndFlush返回sessionAccepted的游标后，以该generation/sampleSeq请求；事务读取的当前代ledger必须精确等于该游标，否则409 SOURCE_PROGRESS_PENDING。pause丢响应先按原seq/载荷重试恢复；选择更早位置时，用户明确确认已显示的接受游标，以新operationKey、该游标及allowEarlierAcceptedPosition=true提交，仍须精确相等；不自动挑另一个旧位置。ledger已前进则重新展示/确认；未接受样本不作为checkpoint。beginning/target_history禁止sourceCheckpoint和allowEarlierAcceptedPosition字段。

消费位置语义：带transitionIntentId时不允许startMode，intent.positionMode映射唯一startBasis；carry来自冻结ledger，target_history在probe后读当前Profile目标历史并冻结一次，beginning=0。目标时长/匹配不兼容回退beginning并有reason；禁止第二次resume读取覆盖carry。发票仍走renew。

正常switch旧来源必须先stop到ended；next必须有finish receipt；recover_switch允许网络/格式/媒体上游故障failed后60s，权限/修订/禁源导致终态不能恢复。manual_next允许本上下文started的活动或正常ended来源（先停止再消费），不得使用撤销来源。source stop响应丢失先恢复状态，未确认终态不消费；409 SOURCE_NOT_TERMINAL不会消耗intent。

意图TTL60s从createdAt固定计时；已消费不按TTL丢重放映射，至少24h保留（会话FK保护）；找回后继失败/ended仍返回终态，不能再次消费造新播放。取消已经输给消费返回successor，协调器显式stop不需要的后继；服务器watchdog回收无人接管preparing/60s awaitingGesture会话。

## 6. 问题码与恢复动作

| 错误/结果 | 状态 | 恢复 |
| --- | --- | --- |
| VOD_SEARCH_EXPIRED / VOD_PREVIEW_EXPIRED | 410 | 保留q，重新搜索/预览 |
| VOD_DETAIL_CHANGED / VOD_MATERIALIZATION_STALE | 409 | 重读并明确重选，不复用旧位置 |
| VOD_QUOTA_EXCEEDED | 409 | 管理来源/配额，不删除个人历史 |
| IDEMPOTENCY_CONFLICT / TRANSITION_SLOT_CONFLICT | 409 | 恢复已有操作/slot，不能无限新建key |
| TRANSITION_EXPIRED | 410 | 用户重新发起；不自动携带过期carry |
| NEXT_PLAN_CHANGED / NEXT_PLAN_EXPIRED | 409 / 410 | 重新取计划，展示目标及历史并重新确认 |
| VOD_NEXT_UNAVAILABLE | 404 | 无确定下一集，停止连播 |
| SOURCE_PROGRESS_PENDING / SOURCE_NOT_TERMINAL | 409 | 等待/恢复保存或停止状态，必要时显式从头 |
| PLAYBACK_GENERATION_STALE / PROGRESS_SAMPLE_CONFLICT / PROGRESS_RESOURCE_CHANGED | 既有409 | 重新读取会话/重建播放，禁止篡改重试原载荷 |
| 自动播放被浏览器拒绝 | UI awaitingGesture，不是媒体错误码 | 点击播放或60s释放，不自动换源 |
| 来源网络/格式失败 | 已有稳定session failureCode | 用户recover_switch或新resolve；不绕过策略 |

所有新增failureCode须同步注册，未登记枚举不可写入session。来源/上下文授权失败优先于专用错误，防止借新错误判别旧会话存在性。超出缓存/工作队列上限明确429/422；取消传播AbortSignal，不能仅取消UI等待。

## 7. 审查闭环契约（2026-10-30 提出；同日随 T002 冻结并入 Accepted 契约，已实施）

### I1 候选物化

candidateRef服务端记录绑定家庭、原设备/Profile/context、来源session/generation、预览修订与准确title/episode键，响应不暴露上游键或地址。候选物化分支先验证该绑定及当前目标策略，再复用MaterializeWorkSet；不要求前端推导titleRef/episodeRef。返回Materialized追加candidateRef:string|null、registeredCandidateRef:string|null；候选分支返回不可变的已登记映射引用，普通分支为null。intent.targetCandidateRef使用registeredCandidateRef，previewRevision仍须匹配。首次事务同时提交operation结果及该登记映射，成功重放可在原预览失效后恢复原结果，仍受24h保留及当前鉴权限制；新key不得使用过期原候选。候选绑定冲突404、过期410 VOD_PREVIEW_EXPIRED、修订改变409 VOD_DETAIL_CHANGED。登记映射包含目标media及修订，受operation保护，源阶段/权限变化不能据它创建意图。

### I3 下一集计划

新增POST /playback/next-plans，请求{fromSessionId,expectedGeneration,action:next|manual_next}；Profile鉴权、来源资格及目标策略检查后200 {nextPlanRef,targetMediaId,label,sequenceRevision,detailRevision,historyRevision,historyChoiceRequired,history:HistorySummary|null,expiresAt}；无确定下一集404 VOD_NEXT_UNAVAILABLE。只生成有界服务端计划，不建播放/epoch/历史，不占slot，不测速。计划按设备/Profile/context/来源代次/action绑定，TTL60s固定；倒计时开始前取计划，选择历史时使用同一快照，超期410 NEXT_PLAN_EXPIRED并重新展示。每设备最多20活计划，按最早过期淘汰；沿用过渡10/min限流和no-store。

创建事务验证计划与当前序列/详情、目标修订、历史revision及偏好，冻结到intent；消费再验同一快照，任一改变409 NEXT_PLAN_CHANGED，不消耗槽且不建后继。pending到期不晚于计划expiresAt与intent.createdAt+60s中的较早者。成功消费重放不再执行计划过期/变化检查。target_history在probe后仍读取当前历史；若与计划historyRevision不同，准备失败NEXT_PLAN_CHANGED，不用新位置替换用户确认；会话进入failed，不复活源。冻结起点后历史更新不改起点。

### I5 仅清理的授权分支

新增POST /playback/transition-intents/:id/cleanup，body={}，200 {outcome:cancelled|already_cancelled|cleanup_pending|stopped}。仅当前有效DeviceSession、原Profile及完全相同contextVersion可用；跨家庭/设备/Profile/旧context及不存在均404。该分支不要求源或目标当前内容策略放行，不返回目标ID、元数据、位置或票据。事务内：pending则取消/释放槽；consumed则为唯一已关联后继写持久cleanup_requested，标记后拒绝其renew/新资产并投递幂等空stop；已终态仍清理资源。提交后执行任务取消，不写final/history、不重建、不重消费。失败/重启扫描重试，GET完整结果被拒时客户端直接调用此入口；响应丢失重试同入口。该请求不依赖已知successorSessionId。context变更后禁止调用，由撤销处理与持久cleanup扫描负责清理。正常有权cancel可返回successor，失权时使用cleanup，不能放宽原stop/control鉴权。

### I4 起播确认与U2定位能力

observations回复追加playbackStarted:boolean；服务器在当前身份/策略、generation、ready/playing/paused及受控交付事实均有效时，接受playing观测并原子设置独立playback_started_at。它仅解除readyAt+60s未起播期限，不设置sessionStarted、不写ledger/history、不授予完成/carry资格。收到playing的HTTP确认后UI才视为解除等待；若进度不可保存显示“此来源暂不支持进度保存”，不无限重试started。无playing/无交付、仅heartbeat/renew不解除期限。已起播沿用现有失联/回收规则，暂停不重新开启该60s期限；服务端重建generation不重置session级起播事实。playing接受先后与watchdog用同一session CAS竞争，终态不可复活。

PlaybackDto追加seekCapability:none|client|server_rebuild、playbackStarted:boolean；能力由可信probe/交付与可用seek范围产生。hls_proxy VOD第一期仅可client（已知duration且客户端确认可定位范围）或none，保留现有POST seek拒绝hls_proxy；直播为none。client seek通过媒体API定位，先发seeking重置末段证据，再seeked；不推进generation，不新建输入，sampleSeq持续单调。server_rebuild仅现有受支持交付，调用原CAS接口推进generation、绑定同输入及撤销旧代。能力/范围不满足时不显示可用拖动入口；服务端返回client仅声明许可，前端还须检查实际seekable范围。续播/carry冻结位置在client模式由播放器媒体就绪后定位，未落到允许误差内不得显示“已续播”，失败提示从头或重新选择；server_rebuild以逻辑输出offset定位。

新增稳定问题码：NEXT_PLAN_CHANGED(409)、NEXT_PLAN_EXPIRED(410)、VOD_NEXT_UNAVAILABLE(404)。SOURCE_PROGRESS_PENDING不暴露其他设备游标；cleanup仅最小结果。所有新增字段纳入T003严格DTO/OpenAPI。
