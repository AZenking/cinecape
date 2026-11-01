# 010 Data Model（Accepted，2026-10-30 冻结）

> **T002 冻结记录（2026-10-30）**：`profile_vod_preferences.version` 与 `playback_transition_slot.slot_revision` 的"未有行=0"仅属传输初值/响应默认；一切持久行 revision>=1。canAttemptResume（候选）/最终续播（probe 后判定）/finish 资格（尾段观测判定）三者语义分离，不得混用。详细冻结说明见 [contracts/api.md](contracts/api.md) 头部。

依据[spec](spec.md)；事务/接口分别见[internal ports](contracts/internal-ports.md)、[API](contracts/api.md)。全新模型不是已存在schema；类型和迁移在实施时生成，不在本文写DDL。

## 1. 通用约束

所有业务表有household_id；个人表/意图含profile_id；设备播放意图还有device_session_id/profile_context_version。引用使用家庭复合FK，唯一键都带家庭；ID服务端生成、不复用。时间UTC；整数seq/revision>=1，位置/时长有限非负、duration>0；年龄0–18或null。展示名1–255，简介纯文本<=4096；upstreamVodId/lineKey/episodeKey 1–255，NFC+trim不得截断身份。公开ref与私有ID分开，随机状态ref不能编码可解码的上游URL。

## 2. 来源与目录（业务持久）

| 实体/所有者 | 字段（除household_id外） | 唯一/关联与校验 |
| --- | --- | --- |
| media_source / sources扩展 | 现有id/kind/name/remote_url/enabled/version + locator_revision | kind加vod；vod必须remote_url非空、NAS及EPG绑定为空；根地址不可PATCH；改名version+1，启停均locator_revision+1防ABA |
| vod_source_config / sources | source_id,adapter=apple-cms-json | 一源一行；kind=vod；预算由统一配置，不能上传任意头/脚本 |
| media_item / media-catalog扩展 | 现有元数据/content_revision + media_role=standalone/vod_title/vod_episode | 旧记录standalone；父movie/series/video、子episode；父没有playback_source |
| media_relation / media-catalog | parent_id,child_id,kind=vod_episode,sort_order | child唯一父；禁止自环和多层；父子角色、家庭及同一provider标题归属共享领域校验 |
| vod_title / online-vod | id,source_id,upstream_vod_id,parent_media_id,current_detail_revision,materialized_at | (source_id,upstream_vod_id)唯一，parent_media_id唯一；成功物化即公共目录，无enrolledAt |
| vod_line / online-vod | id,title_id,line_key,display_name,sort_order | (title_id,line_key)唯一；重复/空key详情显示unsupported |
| vod_episode / online-vod | id,line_id,episode_key,label,media_id,content_version_state,evidence_kind/digest/schema_version,continuity_revision/signature | (line_id,episode_key)、media_id唯一；verified需完整证据；基础adapter仅unverified但可operational续播 |
| source_entry / sources扩展 | 现有source/media/present + identity_kind=vod_episode,identity_digest | 摘要覆盖稳定定位，不含URL；同源同子项；present为存在性的权威，vod投影不独立改 |
| playback_source / sources登记接口 | 现有IDs/protocol等 + locator_kind/static_location/vod_episode_id | 保持entry唯一资源；static时location非空/vod引用空，online时相反且protocol=hls；判别联合，旧数据回填static |
| vod_detail_snapshot / online-vod | title_id,revision,locator_revision,validated_private_payload,fetched_at,expires_at | (title_id,revision)唯一，不可变；当前指针原子更新；所有地址私有 |
| vod_episode_sequence / online-vod | title_id,line_id,detail_revision,sequence_revision,episode_id,season_key,ordinal,sequence_status | 状态ordered/ambiguous/special；导航与身份分开；只同线明确N+1，缺集/重复/季边界不能跳 |

循环关联避免双向必填：vod_episode不再保存source_entry_id作第二权威；通过source_entry.media_id及source_id定位，playback_source.vod_episode_id单向关联。entry/resource/media/vod映射同事务校验，提交前完整；禁止有两个互相矛盾的entry映射。物化不建历史。父可浏览=至少一个已发布present子项、启用来源、完整locator；与子可解析候选集合分开。

## 3. 修订与连续性

- catalogRevision只在公共可见字段/关系/可用性或首次物化改变时+1；无变化重放、URL token/采集时间变化不加。
- sequenceRevision为同标题/线路导航快照版本（>=1），仅成员/顺序/年季/常规集资格变化时递增，与引用的detailRevision一同发布；不因签名URL变化单独推进。next计划固定两者，详情版本变化即要求重选，以保守处理无法可靠区分的外部变化。
- detailRevision反映完整私有详情；contentRevision表示已知内容替换/可信证据更换；continuityRevision反映该子项稳定定位/已知年季版本匹配条件变化。新增其他集不使已有子revision改变。
- continuitySignature包含规范身份/已知年份季度语言版本/匹配规则版本，不含URL/采集时间，不是媒体hash；缺关键字段不自动制造“内容一致”的证据。
- verified证据更换/降级/从unverified升级均contentRevision+1；unverified结构相同仅地址更新不变。关键结构变更continuityRevision+1，明确内容替换两者可同次变更，各最多+1。失败/截断不发布。
- 历史保存产生时的内容/连续性修订及证据，不能批量跟随当前状态升级。旧会话修订不匹配时拒绝新交付/进度，准备转failed，需新resolve。

## 4. 物化幂等与配额

vod_materialization_operation：id、device_session_id、profile_context_version、profile_id、operation_key、request_digest、parent/selected_media_id、selected_content/continuity_revision、提交的detail/catalog_revision、result、committed_at/expires_at。

唯一(household,device_session,context_version,operation_key)。成功结果与资源在一个事务提交；同key/digest重放，异digest409；已提交重放优先于预览TTL，但仍检查当前上下文/资源/策略。同key结果固定不刷新网络；内容冲突409。固定24h保留，重放不延长；期间父及其完整关联组受回收保护。新key可复用已有映射，不能要求新媒体配额。

10启用源/5000父/100000子，事务内按新增净额检查；并发不能突破。未观看且无历史/名单/会话FK/意图/幂等保护/其他持久引用的组，materialized_at至少24h后才可整组清理，ID不复用。先过期幂等/意图，再按完整引用图清理；活动/保留的终态记录不能破坏FK。schema不能靠删除历史释放配额。

## 5. 会话ledger、历史及观测

| 实体/所有者 | 字段 | 规则 |
| --- | --- | --- |
| playback_progress_state / personal-data扩展 | 原epoch/seq/digest/started/context/content + continuity_revision、ledger_position/duration/generation/accepted_at、session_started、last_result | seq跨generation递增；新有效样本先更新ledger，再按epoch决定历史；superseded仍sessionAccepted=true；stale不更新；与历史同事务 |
| profile_viewing_history / personal-data扩展 | 原Profile/media/位置/时长/epoch/revision + continuity_revision、evidence_state/digest、completed | (家庭,Profile,media)唯一；仅历史owner写；from-head可降低位置；completed只由有效finish写或新实际started重置 |
| profile_vod_preferences / personal-data | profile_id,autoplay_next=true,switch_carry_position=true,version | 每Profile唯一；CAS；开关消费过渡时重读 |
| playback_phase_observation / playback | session_id,generation,event_seq,digest,event_type,position,rate,server_received_at,tail_anchor_position/time,delivered_seen | 最新event_seq幂等；seek/pause/buffering/error/未知跳跃重置anchor；不写个人历史；最高2Hz/会话，正常playing每1s，固定TTL会话生命周期 |
| playback_finish_receipt / playback | session_id,generation,operation_key,request_digest,final_seq,final_session_accepted,history_applied/history_revision,session_completed,auto_next_eligible,reason,position,duration,ended_at,content/continuity/locator_revision | session_id唯一；(家庭,device_session,contextVersion,operationKey)另有唯一幂等索引，相关来源身份从session绑定；finish原子写并终态；旧stop先赢则receipt=not_completed；终态不得由新finish升级；重放仅返回既有结果 |

观测不是不可伪造观看证明：仅作用于产品连播资格。final位置先被验证接受，再计算尾部min(5s,duration×5%)及末段min(2s,duration×5%)。观测匹配generation、服务端接收时间和已交付；允许0.5–2倍速，推进不得大于服务器间隔×rate+0.5s；gap>3s、跳跃/暂停/缓冲使资格unknown，需新的连续末段。finish前flush有序末段观测再提交final。末段太短且无法收集有效观测则拒绝auto-next，允许manual_next。completed是会话观测结果，不影响目标授权。

个人历史归属和会话完成独立：superseded可ledger接受且session_completed=true，绝不把其完成写到另设备owner历史。epoch不回退；普通stop204不生成成功完成证据。短片/尾部未完成位置0<p<duration仍可尝试续播；本次probe未知则不能用历史duration作为在线兜底。nearEnd只是UI提示。

## 6. 固定输入、generation及起点

playback_input_binding / playback：session_id,generation,playback_source_id,source_id,locator_revision,detail_revision,content_revision,continuity_revision,evidence_state/digest,resolved_input_id,resolved_at/expires_at,start_basis(beginning/target_history/transition_carry),frozen_start_seconds(nullable直到probe),cleanup_state。

resolved_input / playback私有：id、source identity、入口URL、固定请求策略/修订、引用及租约；不对客户端公开。每session/generation最多一有效绑定。仅current generation可新交付；seek/会重建输出选择：CAS推进generation+新绑定同resolved_input_id+旧代撤销/cleanup标记同事务；失败前无变化，失败后新代failed不倒退，seq不归零。新代沿用输入，不暗换最新地址。

首次定位允许一次替换未接受的probe输入；先取消旧probe及输出再原子换引用。长期输入过期进入failed，不在分片中间换源。消费过渡只确定start_basis和carry快照；本次probe后统一冻结一次位置；ready提交只重验不再读取不同历史覆盖。转换以逻辑媒体时间起点处理。

租约必须可取消/有界；旧代/终态先撤交付资格，待在途任务退出后回收；cleanup状态持久化可启动扫描，不能靠内存refcount唯一保障。重启中断旧播放/意图，已保存Profile历史保留以新认证resolve续播。

## 7. 单后继槽与意图

playback_transition_slot / playback：from_session_id,from_generation,slot_revision,status(open/reserved/consumed),active_intent_id,successor_session_id。唯一(household,from_session,generation)。并发不同operationKey也争用同槽。

playback_transition_intent / playback：id、from_session/generation、device_session_id/profile_id/context_version、action(next/manual_next/switch/recover_switch)、target_media_id及修订/来源版本、match_revision/confidence、confirmed_ambiguous、position_mode、carry_position/duration/source_ledger_seq、finish_receipt_id、operation_key/request_digest、slot_revision、created_at/expires_at、status(pending/cancelled/superseded/expired/consumed)、successor_id。

同设备上下文操作key唯一；TTL固定60s，重试不续期。pending显式替换需expectedSlotRevision，旧意图superseded、slot_revision+1；取消成功open+revision，旧意图不可再用。consumed槽永久不能再建立第二后继；保留到来源及消费结果一同合法清理，不早于重放期。successor引用保护后继记录。

消费事务：来源只读上下文授权+目标最新策略/版本+偏好 → intent/slot CAS → 旧来源必须终态（switch正常路径先stop；next来自finish；recover来自可恢复failed） → 建target preparing → 分配epoch/ledger → intent consumed与slot successor写入。全部失败回滚。取消输给消费返回successor；找回并stop不需要的后继。目标未接管由preparing/awaitingGesture watchdog兜底；不消费旧槽重建第二目标。

原会话网络/格式故障后60s内允许recover_switch，必须原上下文及来源权限仍有效；切档/撤销/禁源/修订失配的终态不允许carry恢复。超时走普通明确新播放，无旧carry。已消费intent结果在会话元数据保留期内重放，至少24h；未消费过期410，不误作可重新消费。

## 8. 迁移和恢复

新迁移编号2026-10-30经核验当前最新迁移为 `0006_pc_experience`，本轮锁定为 `0007_online_vod`（`apps/server/src/platform/database/migrations/0007_online_vod/up.sql` / `down.sql`）；若实施期间同时新增迁移，须先修订 tasks.md 与本记录再执行，不写占号迁移。SQLite枚举CHECK重建、静态locator回填、角色standalone回填、个人扩展默认值必须保留既有数据及FK。旧静态历史completed默认false但保留现有canResume语义；旧记录不冒充在线continuity证据。

独立副本up/down/up验证；down遇到在线业务非空拒绝破坏性删除，正式回滚采用升级前一致备份+匹配镜像，新在线业务另导出留存；恢复后会话/grant/intent失效，不复活权限。临时空库可down；不在当前用户库执行任何演练。幂等表/finish receipt和私有地址受备份保密控制，公开日志只含脱敏ID/稳定错误码。

## 9. 保留与watchdog细化

finish receipt、已消费intent/slot及后继映射至少24h且不短于关联会话元数据保留期；资产可按原短TTL清理，但不能连带删去受这些引用保护的session行/ledger。过期后先删不再可消费/重放的intent，再按依赖清理slot/receipt/终态ledger/session；Profile历史长期保留且不依赖这些行。cleanup未完成或活动租约不允许清理输入。

未有playback_started_at的ready会话以服务器readyAt起60s固定期限回收（等待手势不延长、heartbeat/renew不续命），独立playback_started_at由已交付后的合格playing观测设置后解除该期限（不要求进度可保存）并沿用正常生命周期。客户端显示awaitingGesture不作为安全信任源。pending source slot/intent创建不能延长来源播放存活或未起播期限。

## 10. I1–I5 / U1–U2新增持久边界

- `vod_registered_candidate`（online-vod）：household/device/Profile/context、registered_candidate_ref、原candidate_ref、source session/generation、preview_revision、目标media及content/continuity/detail修订、materialization_operation_id、created/expires。唯一(家庭,operation_id,candidate_ref)；与物化结果同事务，operation保存完整返回引用；至少24h保护映射/目标，过期按引用清理。原临时候选保留在有界预览缓存，失效不影响已提交成功结果重放。
- `playback_next_plan`（playback）：id/ref、household/device/Profile/context、from_session/generation、action、target_media_id、sequence_revision/detail_revision、target content/continuity/locator修订、history_revision(无历史0)、history_choice_required、created/expires。不可变60s、有界、无slot/epoch写；intent增加next_plan_id及上述冻结快照。计划被pending/consumed intent引用后按intent保留，不能因活计划配额淘汰受引用记录；每设备20上限只计未引用活计划，过期不再允许新建意图。序列修订/详情/历史变更不修改旧计划；创建/消费拒绝，成功消费重放只回原结果。历史选择标记只表示UI必须显式动作，不构成授权。
- `playback_transition_intent`增加source_checkpoint_generation/seq及allow_earlier_accepted_position，仅carry必填；与当前ledger精确匹配后复制position/duration及修订，所有值服务端读取。同key的checkpoint/回退选择属于摘要，改变须新key+slot CAS；不需要保留全部历史样本。source_checkpoint_seq是接受游标，不是尚待接受的暂停seq。
- playback session增加playback_started_at nullable，与个人ledger.session_started分离；playing观测与session标记同短事务、CAS重验当前代/活动态/交付及授权；无时长仍可设置，不能据此写历史、完成或carry。起播标记session级跨generation保留，启动恢复中断旧会话不复活标记。
- playback session/输入cleanup增加cleanup_requested、cleanup_reason与持久执行状态；TransitionCleanupWorkSet读取当前身份及intent原归属，取消pending或为已关联唯一后继标记撤交付+清理同提交。策略失权不阻止最小清理；context失配仍404。标记先阻止新票/资产，网络和进程取消在commit后执行；不依赖前端取得后继ID，不写个人进度。
- `profile_vod_preference_operation`（personal-data）：id、household_id/device_session_id/profile_id/context_version、operation_key(UUID)、request_digest、result_json(当时Preferences)、committed_at/expires_at。唯一(家庭,device_session,context_version,operation_key)；Profile为同家庭FK，expires>=committed+24h。偏好CAS写与成功operation同事务；先查成功key并校验原Profile/context及digest，再做expectedVersion校验。成功重放返回原响应，不恢复旧偏好、不增加版本；异digest409 IDEMPOTENCY_CONFLICT；失败不占成功key。不同key并发按CAS仅一者成功。清理过期operation不删偏好，幂等记录不进入公共缓存或日志。U1迁移/回滚与既有数据保留规则一致。

全部新增表沿用家庭复合FK/索引、revision规则；计划history_revision=0仅表示快照时无历史，不是持久历史revision。U2 seekCapability为当前probe/交付推导DTO，不作为长期媒体能力缓存；本地seek不创建generation/input行。
