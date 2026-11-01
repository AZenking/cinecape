# 010 播放、进度及过渡状态协议（Proposed）

## 1. 不改变的骨架

保留preparing→ready→playing/paused→ended/failed/interrupted的现有播放生命周期，不新增“completed播放状态”。session完成资格在finish receipt，awaitingGesture是客户端状态及未起播回收期限。票据/资源永远绑定session/generation及设备Profile上下文；新目标必须新会话，不通过selection把原mediaId改成另一个。

sampleSeq在同session内跨generation单调，eventSeq观测在每generation独立，operationKey用于命令幂等，slotRevision用于来源阶段单后继互斥，四者不能互代。客户端同一session只有一个seq分配器；排队时即唯一分配序号，不能在同在途样本后排多个相同seq。generation切换不卸载/终止session控制器；取消旧代样本时跳过已分配号但不倒退。

## 2. 进度事务机

输入授权→同事务重读身份上下文/目标政策/源/内容与连续性修订→session非终态/current generation→本次可信duration与已交付→seq/digest→started门→ledger→历史epoch→保存响应。

| 输入 | sessionAccepted | 历史applied | 副作用 |
| --- | --- | --- | --- |
| 有效新started，取得历史权 | true | true | sessionStarted=true；写ledger+历史+结果 |
| 有效样本，失去历史权 | true | false/superseded | 更新本session ledger；不覆盖他设备Profile历史 |
| 相同最新seq/同payload | 原值 | 原值 | 重放结果，不更新时间/epoch |
| seq低于最新 | false | false/stale_sample | 游标不移动 |
| 同seq异payload | 错误409 | 不写 | 不消耗seq |
| generation/修订/授权/时长非法 | 错误 | 不写 | 不产生新接受位置 |

ledger位置允许倒退，不能取MAX。客户端startedAcked依据sessionAccepted+sessionStarted，saved指历史applied，superseded不能显示“已同步到个人历史”但也不能无限重发started。carry只读取ledger中的source session/current generation；generation推进后须有该代有效样本才允许carry（无样本可选从头），不拿历史填补。

## 3. 起点唯一性与续播

普通resolve(startMode=beginning/resume)分别选beginning/target_history；intent resolve禁止startMode，直接选intent mode。创建preparing时冻结版本与carry候选，probe后一次计算frozen_start_seconds；target_history在该时刻读取当前Profile目标历史，carry不读任何目标历史覆盖。完成条件/已知冲突/0<p<本次duration/容差检查详见spec FR016–021。

operational不等于verified。history canAttemptResume仅候选，若本次probe后降级从头，显示具体resumeReason并保留旧历史直到新的有效started。本次无时长可播放兼容输入但不能承诺进度或续播；PROGRESS_NOT_READY不以别的Profile历史duration兜底。任何转换输入/呈现offset使用同一冻结逻辑时间。

## 4. 暂停、自然结束和stop

ProgressController提供awaitable pauseAndFlush、finish、stopOnce。每个命令进入同session泵，先等待/重试在途不可变样本，不能越过未确认started。普通退出/切档仅等1s然后空stop尽力清理及身份撤销，提示未同步；显式换源可继续等待或用户选更早ledger/从头，不谎报保存。

finish流程：停周期→按序flush尾段观测→分配一次final seq/payload→同事务接受final→更新ledger→按epoch可选历史→计算sessionCompleted/autoNextEligible→写receipt→ended。保存硬错误回滚，不部分终态化；stale final可ended但不可auto-next。superseded final可sessionAccepted/completed而historyApplied=false。

完成只是一组可观测产品条件：本次started与交付、可信duration、最终样本落min(5s,d×5%)、尾段min(2s,d×5%)连续推进，observations服务器接收时间/rate可行且无已知中断/seek。观测缺失或gap>3s保守unknown；不要求上次10s进度已在最后5秒。到尾seek立即ended没有新的合格尾段→不连播；seek到稍早位置再连续播放足够尾段可以合格，不声称用户看完整集。所有media observations均不作为播放授权证明。

普通stop仍204：同底层终止服务，终态不会补写。finish先赢后stop仅清理；stop先赢后finish返回not_completed，不能给ended任意升级资格。receipt与session终态同提交，网络丢响应可GET恢复；重试不能刷新末段证据或重新保存不同final。

## 5. 过渡授权及单后继

创建授权分支：
- switch：活动来源、本设备/同Profile/context/current generation、sessionStarted；carry有合格ledger。
- next：已结束来源且finish.autoNextEligible=true、当前偏好开启、序列确定及目标允许。
- manual_next：不要求自然完成/偏好，但来源为本上下文started活动/正常ended（先停再消费）；目标由服务端序列选择。
- recover_switch：媒体故障终态后60s、本设备原身份/策略/源/修订仍有效。不能用撤销/政策/禁源/修订失败作为恢复旁路。

终态来源不能沿用后续会拒绝终态的活动控制管线；现有authorizeControl本身负责身份/策略，并非活动态判断。新增SourceTransitionContextPort只读历史绑定/receipt/ledger并验证当前身份、当前源及策略；绝不重新发源票。创建与消费均检查；A→B→A的contextVersion不等即404。

slot状态open→reserved(intent)→consumed(successor)，pending替换/取消要CAS revision，旧intent状态不可逆。不同key/目标也受唯一slot限制。消费事务原子执行：当前身份/偏好/来源修订+目标策略→目标可用性→intent未过期/slot仍保留→来源终态校验→新session+epoch/ledger→consumed+后继结果。任何异常不留下新session或消耗槽。

停止来源不使pending失效；TTL/身份变化/修订/政策拒绝使其失效。消费后同intent重放找回successor当前状态，不重建；后继失败的恢复需针对后继或用户普通明确播放，而非重消费旧slot。来源每个generation只能一次成功后继，不限制全家庭并发设备观看。

## 6. 前端换源及连播步骤

switch：选择候选→pauseAndFlush（验sessionAccepted）→必要物化→建pending intent→stopOnce(final)并确认终态→consume resolve→当前操作号/身份守卫接管新session→probe/续票/实际playing→started。停前失败可恢复源，停后失败只能重建；carry冻结后更晚final不会暗改intent位置。

next：finish receipt→倒计时5s（取消/立即播放/关闭）→取目标历史选择→创建intent→消费重验偏好/身份/目标→新播放。下一集已有未完成历史则暂停倒计时询问，不假定beginning；仅页面浏览不触发auto-next。manual_next是单独用户动作，不借自动开关。

取消竞争：cancel赢→intent取消不能消费；consume赢→cancel返回后继ID，客户端恢复并stop不再需要的后继。旧响应不可仅ignore：若可能已建会话必须同身份查询结果并清理；身份变更后服务端上下文撤销+watchdog兜底，不使用旧身份离线重放。

## 7. generation和全局播放

服务端重建seek/转换换轨采用原CAS：同事务推进generation、新输入绑定及旧代撤销；probe后结果只可提交当前代。旧代网络/任务取消后持久cleanup回收；代次推进前失败原代可用，推进后失败新代failed，不回退。session的seq不重置，旧代在途样本明确失败且不能发session stop。

全局ActionCoordinator仍挂在路由外；ProgressController生命周期=session，generation只是上下文更新。组件卸载兜底调用同stopOncePromise/载荷，不另生成final。明确退出清理；内容路由变化不清理。server_rebuild seek须先通过started门并串行处理旧代样本；client seek不换代，但seeking立即重置尾段观测，进度仍在同代有序上报。

play()拒绝→awaitingGesture，不产生started或新连播；UI显示点击播放，readyAt起60s未收到服务端playbackStarted确认则stop未起播session。heartbeat不延长该deadline。用户手势恢复仍使用当前有效票据和授权；过期则新resolve，禁止复活旧会话。

## 8. 审查后的因果顺序

switch：候选物化使用candidateRef分支并取得registeredCandidateRef；pauseAndFlush成功取得本代接受游标，carry创建必须精确匹配sourceCheckpoint。超时只允许重试原样本/用户确认当前已接受游标/从头，不让服务器猜暂停是否完成。意图冻结后更晚final不改carry。

next/manual_next先创建nextPlanRef，UI显示其唯一目标和历史快照，再提交显式位置选择；计划过期或序列/历史变更重新展示，不能沿用旧确认。创建、消费及probe起点检查分别按API契约执行；消费失败保持原槽未消费，消费后prepare失败仅终结后继。

消费成功后的完整恢复仍须当前内容权限；失权时使用仅原设备/Profile/context的cleanup入口，原子取消pending或撤后继交付并标记清理。身份上下文变化仍不可调用最小入口，由撤销扫描兜底；结果清理不授予继续播放。

session的playbackStarted只解除未起播回收，与sessionStarted、saved、completed分别记录。未知duration时允许起播确认，但进度/续播/carry/完成均不能据此放行。hls_proxy本地seek保持generation；服务端重建seek遵守原支持范围，不在第一期扩大。
