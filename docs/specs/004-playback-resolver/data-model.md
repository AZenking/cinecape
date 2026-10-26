# Data Model: 004 播放（Proposed）

新增迁移0005_playback，不改0001～0004。所有时间UTC ISO8601，ID服务端生成，所有新表显式household_id；FK通过(household_id,id)约束同家庭。外部DTO不包含源位置或文件路径。

## playback_session

id PK、household_id、device_session_id、device_id、profile_id、media_id、playback_source_id nullable、state(preparing/ready/playing/paused/ended/failed/interrupted)、delivery nullable(direct/hls_proxy/remux/audio_transcode/video_transcode)、generation>=1、version>=1、position_seconds>=0、audio_track_id nullable、subtitle_track_id nullable、created_at/started_at/ended_at/last_heartbeat_at、failure_code nullable。

所有未注明nullable的字段NOT NULL；created_at/last_heartbeat_at必填（创建时均为now），started_at/ended_at nullable。source与delivery在初始preparing允许为空，ready/playing/paused必须非空；终态保留已确定值，准备失败时仍可为空，禁止补造源或delivery。失败码仅failed非空；ended_at在ended/failed/interrupted必填，活动态为空。首次接受请求设generation=version=1、position=0；预先校验至少有家庭内启用资源，完整probe/格式计划异步进行，不在probe前猜测delivery。

绑定device/session/profile/media后不可改变；选定source在同次session后续generation不变，准备阶段可按排序尝试候选，只有ready后固定。preparing→ready/failed/ended/interrupted；ready→playing/paused；playing↔paused；ready/playing/paused→preparing用于seek或需重建输出的换轨；任一活动态→ended/failed/interrupted，终态不可复活。准备完成进ready，首次媒体交付进playing并设置started_at（之后不重置）；暂停恢复进入paused/playing，无需重建输出的暂停不进入preparing。seek保持暂停意图于desired_paused NOT NULL boolean默认false，准备完成后播放器依此继续暂停或恢复。纯字幕切换只递增version，seek/重建音轨同时递增generation与version；heartbeat/ready/playing转换和renew不递增编辑version，避免播放进度打断CAS。preparing拒绝第二次seek/selection为409 PLAYBACK_NOT_READY；暂停期间必须继续heartbeat。

媒体/源FK稳定引用，不因源禁用删除。设备维度索引(household_id,device_id,created_at,id)，档案查询按profile隔离。created_at为请求被接受，started_at为首次交付（可能永不发生）；同步鉴权拒绝不创建session，异步probe/转换失败记录在已有session。

## playback_ticket

id、household_id、session_id、token_hash UNIQUE、issued_at/expires_at、generation、revoked_at nullable。随机256bit ticket只在创建/续期响应出现一次；expires_at>issued_at；所有字段除revoked_at均NOT NULL，generation>=1；绑定播放与设备会话，hash查询必须再校验真实会话。仅ready/playing/paused可签发，preparing不能renew取票；session存hash无法复现明文URL。续期新row，旧票原过期时间不变；seek/需重建输出的换轨升generation，旧generation无论TTL都不可用。终态票拒绝。过期票24小时内清除，不进入审计响应。

## playback_conversion

id、household_id、session_id、generation、mode(remux/audio_transcode/video_transcode)、state(reserved/probing/starting/running/stopping/ended/failed/interrupted)、hardware_backend nullable、output_video_codec/output_audio_codec、started_at/ended_at、failure_code、cleanup_state(pending/complete)、bytes_on_disk>=0、last_progress_at。

除hardware_backend、started_at、ended_at、failure_code、last_progress_at nullable外均NOT NULL；output_video_codec/output_audio_codec为非空服务器输出编码标识，静音合法视频的output_audio_codec为none；预留前已完成计划。started_at为进程成功启动，ended_at在ended/failed/interrupted必填，failure_code仅failed必填、其余为空；last_progress_at首次进度前为空。cleanup_state默认pending，目录删除成功才complete，删除失败仍为pending，不存在cleanup_pending第三枚举；bytes_on_disk默认0。

UNIQUE(household_id,session_id,generation)。无队列；BEGIN IMMEDIATE内按全部reserved～stopping行计算全局额度再reserve，退出后释放；不得跨异步过程持写事务。spawn失败补偿释放；唯一单实例执行器负责回收，重启先标interrupted。任务PID仅进程内持有，不作为重启后杀进程依据。私有产物目录由服务器按实体ID派生，输入/输出路径不进入记录DTO。

## playback_failure_event

id、household_id、device_session_id、device_id、profile_id nullable、media_id nullable、occurred_at、stable_code。所有字段除profile_id/media_id nullable外均NOT NULL；仅有效设备会话可写，媒体不属于该家庭或不可见则media_id=null，不存客户端原始目标ID。不关联所选资源，不产生播放session。索引(household_id,device_id,occurred_at,id)。

## 运行时值对象

PlaybackPlan：可信probe事实、选定服务器轨道ID、输出模式、兼容原因；只在授权后产生。DeviceCapabilities采用保守H.264/AAC输出默认，不信任客户端能力扩大授权。

AssetMap：key=(household,session,generation,assetId)，映射已验证上游URL或私有分片/字幕文件，仅内存私有数据，不返回URL。重启失效、TTL不超过session，清单最多10000资产且只保留最近120秒窗口及其仍使用引用；超限失败，禁止无界直播映射增长。

## 验证与恢复

资源输入size/mtime改变或root授权失效停止旧session，重新解析；不沿用旧probe。音轨/字幕必须属于同一输入；position<=已探测duration（直播禁止seek）。请求version/generation冲突409，不部分启动任务。内部源标识可保存，父级删除采用RESTRICT，审计保留30天后清理，避免删除目录身份。

0005 up对原表数据零修改；down删除本阶段表及索引。临时库验证up/down/up及备份恢复：原身份/PIN/策略/EPG/媒体ID逐值不变；播放记录只在备份恢复后恢复，旧ticket即使恢复也因启动interrupted不可播放。无业务迁移SQL在本轮生成。

## 资源选择与模型权威性

本文件是字段/约束的单一权威，tasks只引用章节，不复制模型。候选资源只取服务端最新家庭内已启用可用资源；每个候选先求其最低成本可用处理方式，再按(direct或hls_proxy=0, remux=1, audio_transcode=2, video_transcode=3)、source_id二进制升序、playback_source_id二进制升序排序。本期不增加可编辑priority字段或来源偏好。probe失败/不支持可尝试下一候选，共用首次30秒期限；无可用路径时失败，不隐藏无限重试。ready后源失效结束该session，下一次主动resolve才重新选择。
