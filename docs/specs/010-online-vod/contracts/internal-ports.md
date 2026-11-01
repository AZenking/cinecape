# 010 内部发布端口与事务工作集（Proposed）

## 1. 所有者与依赖

| 发布能力 | 所有者 | 允许消费方及返回事实 |
| --- | --- | --- |
| VodSourceConfigurationPort | sources | online-vod/playback读取本家庭启用来源、配置CAS与locatorRevision；私有配置不直接暴露Controller |
| OnlineVodProviderPort | online-vod | 搜索/详情/候选匹配/导航；只接受已登记来源ID、稳定上游键或服务器ref；返回纯值快照 |
| SafeUpstreamPort | platform基础设施适配 | sources/online-vod/playback；协议/DNS/每跳重定向/内网许可/timeout/byteBudget/AbortSignal；不从他上下文private HTTP文件导入 |
| CatalogMaterializationParticipant | media-catalog | 发布父子媒体、角色、关系、元数据及公共revision；独立维护目录不混个人历史 |
| SourceEntryPublicationParticipant | sources | 登记present条目、静态/在线判别资源及索引，校验同源同媒体 |
| OnlineVodPublicationParticipant | online-vod | 稳定映射、不可变详情/当前指针、连续性/序列及物化幂等 |
| EffectiveMediaPolicyPort | policy | 全部resolve/control/progress/transition/测速路径；输入服务端父子事实及最新策略；保留ADR0006允许名单规则 |
| OnlineVodLocationPort | online-vod发布业务接口，网络由基础设施实现 | playback授权后获取ResolvedVodInput，期望定位/内容/连续性版本+统一截止/取消；不返回公共DTO |
| SessionProgressPort / HistoryPort | personal-data | playback获取本session ledger/绑定epoch、写有效样本与按epoch可选历史、当前Profile目标历史/偏好；不把历史作为会话位置 |
| PlaybackTransitionSourcePort | playback | online-vod候选/测速、过渡：终态也可读合法来源上下文；不会重新授权旧源媒体交付 |
| PlaybackInputLifecyclePort | playback | probe/资产/转换/seek统一消费输入ID及租约；任务退出持久cleanup |

实现类不经index.ts导出，application只引用纯TS端口；module根装配useFactory/注入token，无forwardRef循环。新代码不扩大全局seam定位器；既有代码保留ADR0015模式，新增事务参与者通过构造器及工作集依赖显式传入。

## 2. UnitOfWork与三类原子范围

平台基础设施提供同步run(workSetFactory, callback, {behavior:immediate})。application声明以下纯TS接口，基础设施工厂把同一连接事务绑定到每个上下文自有TxStore；事务凭证不暴露ORM句柄。不通过AsyncLocalStorage隐式全局替换，不临时修改模块seam，不在callback内await。

### MaterializeWorkSet

Read：IdentitySnapshotReader、ProfileReader、PolicyReader、SourceReader；Write：CatalogParticipant、SourceEntryParticipant、VodParticipant、MaterializationOperationStore、QuotaStore。顺序：幂等已提交恢复→重验上下文→预分配稳定身份/人工元数据→目标策略→预览/配置/详情CAS→净配额→完整映射/资源→幂等结果→公共revision（仅公开变化）。所有写一个commit；网络/HTML不在事务。失败回滚全部。

已有ID复用先查映射；首次ID只内存预分配，不能为了策略先提交占位资源。其他分集登记不代表当前Profile获其播放权限。后台详情更新同工作集但不要求用户物化operationKey，使用(titleId,expectedDetailRevision,newPayloadDigest)内部发布键，公共rev只改一次。

### ProgressFinishWorkSet

Read：当前Identity/Profile/Policy、Catalog与Source版本及本次probe受信事实；Write：PlaybackSessionTx、SessionLedgerTx、HistoryTx、FinishReceiptTx。已授权不能替代事务内重验；必须使用同一source绑定，不可借全局历史时长回填在线probe。

progress：校验→seq/digest→sessionStarted/ledger→epoch历史→结果簿记。finish：上述final→完成资格→receipt→ended+输入待清理。stop无final仍最小幂等；带final同一工作集。finish选用新HTTP入口，不变更旧stop204含义。任务取消/回收在commit后、可恢复标记驱动，不能持写锁等ffmpeg。

### TransitionConsumeWorkSet

Read：当前Identity/Profile/Policy、来源receipt/ledger、source/target revision、当前偏好；Write：IntentTx、SlotTx、PlaybackSessionTx、ProgressClockTx、SessionLedgerTx、InputBindingTx。校验slot→创建preparing session→分配epoch+完整进度绑定→intent consumed/slot successor/幂等结果；任何失败整体回滚。不仅intent路径，普通resolve也要把session+epoch绑定改为同一用例事务，避免现有createSession先成功而后bind失败的半建档。

网络probe在commit后启动，携统一截止及取消token；重复消费不再次启动probe。进程commit后尚未启动probe就退出，启动恢复将旧preparing中断；不重消费旧槽产生第二会话。失败结果由已有watchdog/cleanup收口。

## 3. 固定输入与安全访问

ResolvedVodInput包含resource/source/locator/detail/content/continuity revision、证据、私有入口、resolvedAt/expiresAt和请求策略ID；playback registry持有会话引用/租约。probe、HLS代理、ffmpeg输入/seek均用该ID，不各自重读最新location。ffmpeg不能绕过SafeUpstream校验直接对任意嵌套地址联网；通过现有受控输入代理或已验证输入通路执行，若现有转换无法保证此约束则该在线输入拒绝转换，不宣称全面兼容。

测速是Profile授权后的内部诊断，不能直接向浏览器返回清单/片段。临时候选策略使用同一预分配/已有映射事实，不能把ref当媒体ID或只按adult展示模式放行。每次最多3、固定字节及总截止，DNS/redirect/密钥同样校验；不登记媒体、不创建session/epoch。

## 4. NestJS规则核对

- CRITICAL：按限界上下文模块；显式tokens/constructor注入；端口小接口；事务协调不反向导入实现，不做“一个万能Service”。
- HIGH：已有DomainError/Problem过滤器优先于引入另一套HttpException；Zod严格输入延续项目，不为照搬skill引入class-validator；Guards/CSRF/限流/白名单序列化；所有异步prepare错误落终态/稳定码。
- 性能/DB：批量父子/策略可用性查询，禁止每集N+1；所有网络前置到事务外、网络有deadline；缓存含家庭/定位版本且有总上限。
- 测试：Nest TestingModule/Supertest验证真实装配和越界；Vitest fixture控制上游；故障注入验证rollback/CAS/幂等；新迁移必须备份/恢复演练。
- 部署：ConfigModule汇总预算；结构化脱敏日志，不输出原URL/payload；shutdown取消网络/ffmpeg并持久cleanup；无需队列云服务或微服务拆分。

这些是本功能未来实施约束，不是本轮代码合规审计通过声明；按仓库Drizzle/现有异常规范替代skill的TypeORM或JWT示例不构成绕过宪章。

## 5. 审查新增工作集与端口约束

MaterializeWorkSet增加RegisteredCandidateParticipant：候选分支从本上下文发布的候选快照读取真实键，身份/来源/目标策略重验后提交登记映射+operation结果；Controller不能解析ref猜上游键。

NextPlanPort由playback拥有，借OnlineVodProviderPort读确定序列、HistoryPort读当前Profile历史；事务内复核修订后持久不可变计划。TransitionConsumeWorkSet增加NextPlanTx及历史revision读取；创建/消费检查计划精确快照，carry读取ledger精确checkpoint。probe起点通过HistoryPort带expectedHistoryRevision读取，不一致终结准备。

PreferenceWriteWorkSet：Identity/ProfileReader+PreferenceTx+PreferenceOperationTx；同事务先成功重放、再CAS、写偏好及不可变成功响应。PlayingObservationWorkSet：当前Identity/Policy/交付事实+ObservationTx+PlaybackSessionTx，同事务设置playback_started_at而不写个人ledger。

TransitionCleanupWorkSet：当前Identity/Profile/context及intent归属+IntentTx/SlotTx/PlaybackSessionTx/InputBindingTx；不执行内容放行以授予播放，只标记取消/撤交付/cleanup，session终止由既有生命周期发布端口执行。提交后任务取消可重试；新资产/renew检查持久清理标记。不得以最小清理分支替代正常resolve/renew/progress权限检查。
