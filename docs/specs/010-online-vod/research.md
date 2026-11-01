# 010 Research — 在线点播及播放过渡

日期：2026-10-29；状态：Proposed设计研究。依据010规格、当前HEAD cb3b39e及工作区源码；未运行真实源/设备，不以研究代替验收。

## R1 现状与技术栈

**Decision**：复用TypeScript 5.8、Node>=24/pnpm11、NestJS12、Drizzle/better-sqlite3、React19、HeroUI3.2.6、TanStack Query5、Video.js8；不迁入LibreTV播放器。验证使用Vitest3、Supertest、Playwright及Linux容器。
**Rationale**：apps/server/package.json、apps/web/package.json、packages/shared/package.json已给出依赖和脚本。CodeGraph直接显示resolve→epoch绑定、progress写入及全局ActionCoordinator→PlayerView→usePlaybackProgress路径。基础源播放仍通过Resolver受控资产。
**Alternatives considered**：独立部署/嵌入LibreTV会形成第二身份/进度体系；整体更换播放器扩大范围，均不采用。本轮不新增外部版本推荐，不需要据此联网选型。

## R2 分层及跨上下文短事务

**Decision**：online-vod拥有协议映射/临时预览；sources拥有配置和来源条目；media-catalog拥有媒体和父子投影；playback拥有输入/过渡/结束；personal-data拥有会话样本及Profile历史。装配根注入用例协调器；发布参与者通过纯TS事务工作集端口操作各自仓储。平台基础设施只负责同一连接/事务及事务仓储工厂，不包含领域策略。
**Rationale**：ADR0014/0015要求依赖向内、仓储隔离；既有seam不能在事务中临时重绑全局槽，不能直接拿其他上下文表写。需要新增显式transaction-aware端口，读取策略/身份与写资源同一BEGIN IMMEDIATE范围，无网络/await。
**Alternatives considered**：分步提交+published标志遗漏授权查询；在全局seam临时换句柄引入并发污染；直接跨表写违背边界。新UnitOfWork及三个事务工作集须先经新增ADR接受，历史决策不静默改写。

## R3 来源身份与匹配

**Decision**：稳定源/VOD ID/唯一线路标识/唯一标签形成定位身份；NFC+trim但不把第01集自动等价为第1集。序列导航另解析明确N+1；缺集/多季/特殊集不自动跳。父、子、来源都不跨源合并。
**Rationale**：URL token不是身份，数组顺序不足以对应集数；一条source_entry仍只有一个playback_source。
**Alternatives considered**：标题合并、列表下标和URL摘要均会错配历史。API根地址原地更换禁止，创建新来源。

## R4 实际续播与变化边界

**Decision**：第一期Apple CMS内容证据unverified，但允许operational续播；独立contentRevision和continuityRevision。本次probe可信时长优先且是在线续播必要条件，当前Profile历史仅提供位置与原可信时长。差异容差max(30s,旧duration×2%)。完成、接近结尾和有效位置分开；没有完成证据且0<p<duration即允许尝试，不沿用讨论稿最后30秒强制从头。
**Rationale**：用户已将实际续播纳入第一期；连续性匹配不是安全授权，不对内容不可变作虚假承诺。准备后只冻结一次起点：beginning、target_history或transition_carry，禁止第二次历史读取覆盖carry。
**Alternatives considered**：强制全片指纹导致基本源不可交付；以旧历史duration兜底在线probe会跨版本误定位；按百分比映射会把剪辑版错误对齐。verified为后续适配预留，本期无需生产支持它。

## R5 样本接受与历史所有权分离

**Decision**：保留005现有applied/reason/historyRevision字段解释为Profile历史写入结果，追加sessionAccepted及会话接受位置。通过完整授权、当前generation/revision/duration/seq/交付校验的superseded样本可推进会话ledger，不改变更高epoch历史。stale不能推进；相同最新seq/payload返回存储结果。首次started可以sessionAccepted=true而applied=false。
**Rationale**：当前ProgressWriteService superseded分支仅簿记且缺会话位置；usePlaybackProgress把全部2xx当ACK。需要前端解析新结果而非privateFetch<void>。seq在同session跨generation单调，不再随generation重置或通过卸载stop旧代。
**Alternatives considered**：把applied改为session接受破坏旧契约；用最新Profile历史作carry被其他设备污染；全面拒绝superseded影响合法并发观看。

## R6 完成结果与可观测尾段

**Decision**：新增finish命令及持久结束receipt；普通stop保持204且不授予auto-next资格。finish在同一事务处理final样本、会话ledger、可选历史、完成判定及ended。superseded可有sessionCompleted=true/historyApplied=false。未知/硬非法样本不部分提交；stale最终样本可结束但autoNextEligible=false。终态不由新命令补写完成。
**Rationale**：现有stopSessionWithFinal丢弃progress返回值，终态重复stop不再写final；自然结束不能从204推导。新增轻量phase观测报告playing/pause/seek/buffering/rate及elapsed，不写个人位置；媒体事件是观测而非证明，按服务器时间上界和本次交付交叉检查。完整细节见状态契约。
**Alternatives considered**：将stop改200破坏现有消费者；只看ended标记/上次10秒样本分别会伪完成/误拒绝；无法证明观看时仍允许手动下一集，因为它独立鉴权。

## R7 单一后继与可重放过渡

**Decision**：每(家庭,fromSession,generation)有持久transition slot，版本CAS；不同operationKey也竞争同slot。pending可被显式替换，替换释放占用并旧意图失效；consumed后不得再生第二后继。intent消费、target preparing、epoch/ledger绑定及slot后继引用同一事务。取消输给消费必须找回目标并停止，不只丢响应。
**Rationale**：客户端编号和单intent消费只去掉相同键重复，无法阻止多标签不同键。source的旧终态不复活。next来源要求finish receipt；switch来源活动且有ledger，失败回收后可在60秒保留窗内以独立只读来源上下文授权构造手动换源，不能借此重新交付源流。
**Alternatives considered**：以Profile历史决定完成、客户端单控制器、每请求新resolve，都不能保证一次过渡。无需全家庭“只播一个”约束，不影响其他设备合法观看。

## R8 前端可靠控制与浏览器播放限制

**Decision**：ActionCoordinator继续唯一全局播放面；新增session级命令泵和awaitable ProgressController，生成seq与final载荷各一次，周期/pause/finish串行。generation变更只丢旧代已分配样本（seq不回退），不触发session stop。路由不卸载控制器；身份退出有界1秒并清旧作用域。play()拒绝进入awaitingGesture，60秒未起播stop；不发送started、不再连跳。
**Rationale**：当前hook generation变化重置seq，清理发stop；requestStop只标记、卸载才发送，无法满足新流程。VideoPlayer捕获play拒绝但吞掉，须显式回调而非当播放失败。
**Alternatives considered**：第二全局状态机会破坏009；简单卸载旧组件隐式flush存在final与新resolve竞态；直接浏览器currentTime决定跨源起点违反服务端意图边界。

## R9 安全读取、预算及部署

**Decision**：复用/提取平台SafeUpstreamPort，协议/DNS/重定向/字节/嵌套预算覆盖CMS、probe、清单/密钥/片段及测速；无任意URL/头、默认拒绝内网。只对本Profile合法目标做内部测活，不向客户端交付测速媒体或票据。搜索8s/并发3，10源上限，预览8s/4MiB/5000项，测试3候选，临时缓存总上限及TTL详见契约。
**Rationale**：不能从online-vod导入sources私有HTTP实现。所有输出白名单，公共响应与个人缓存隔离。管理员测试仍需既有Settings+当次密码。
**Alternatives considered**：浏览器直接访问采集源/片段泄漏地址并旁路；将IPTV内网许可默认复用不成立。

## R10 文档治理及可交付范围

**Decision**：本次仅Phase0/1设计，新增ADR0016为Proposed；spec未Accepted是实施ERROR门禁，不以本次计划调用自动接受。执行本次文档规划符合宪章“编码前接受”边界。不创建tasks、不跑迁移/部署。
**Rationale**：模板的Accepted条目不能标PASS；门禁区分获授权的设计评审与实施。旧讨论稿标记历史设计，并链接010新契约；新契约优先用于后续评审。
**Alternatives considered**：把规划命令视为自动接受、伪造运行证据、为适配旧讨论稿降级新规格均不采用。原研究选择已有推荐；2026-10-30审查新增七项产品取舍见plan末节，尚待确认，不代表已接受；实际公网源稳定性和硬件验收仍为交付证据，不是已完成研究事实。

## 研究复核

按speckit-plan要求分派的只读设计研究对会话ledger/历史分离、finish receipt、终态来源授权、slot竞争、取消输家清理及recover_switch进行了复核；与R5–R8结论一致。代理未重复源码探索、未修改文件。新设计已纳入状态和接口契约，真实执行验证仍未进行。

## R11 规划期间宪章更新

**Decision**：末次核对工作区宪章1.5.0，补充heroui-react 3.0.1固定skill、DESIGN.md入口与语义token/视觉证据约束；实际读取nestjs-best-practices版本1.2.0，与固定基线一致。
**Rationale**：宪章和DESIGN.md由工作区其他工作更新，保留原文件、不回滚；不改变本功能授权设计，但约束后续UI实施。最终设计不只依据旧1.4.0判断合规。
**Alternatives considered**：忽略外部更新或自动采用另一skill基线均不可取。本轮无具体组件props设计，官方组件/主题文档获取是实施前硬要求，不伪称已核验。

## 审查后补充依据（2026-10-30）

候选直接物化避免缺失title/episode桥接；精确接受checkpoint避免把HTTP投递当位置确认；不可变next计划避免确认串目标；独立起播标记允许未知时长播放而不伪造历史；最小cleanup按原归属清理，保留当前内容播放鉴权。偏好operation承载24h原响应，HLS本地seek与服务端generation重建分开。细节与推荐代价见plan/API/model；没有新增代码或运行证明。
