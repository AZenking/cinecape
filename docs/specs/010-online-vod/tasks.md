# Tasks: 在线点播接入与追剧体验（010-online-vod）

**Input**: [spec.md](spec.md)、[plan.md](plan.md)、[research.md](research.md)、[data-model.md](data-model.md)、[contracts](contracts/)、[quickstart.md](quickstart.md)。
**Created**: 2026-10-29
**Status**: Proposed任务分解；本次只生成清单，全部未执行，不授权改代码、迁移、提交或部署。
**Prerequisites**: 先核验spec/ADR0016已由维护者接受；任务生成命令不等于接受。工作区无关dirty改动必须保留。Phase1的accept门禁未满足时，不执行后续实现项。
**Tests**: spec SC001–008及宪章1.5.0明确要求测试/负向/迁移/运行证据，因此各故事包含测试先行任务；先观察合理失败，再实现并转绿，不用skip掩盖未实现。
**Organization**: Setup → Foundational → US1/US2/US3/US4（P1）→ US5（P2）→ Final；故事独立验收不等于没有实际先后依赖。

## Format and Path Conventions

`- [ ] Tnnn [P?] [USn?] 具体工作及精确文件路径（依赖ID）`。路径均相对仓库根；新文件是待创建，不代表已存在。不得在此阶段创建所列业务文件。schema/shared/ActionCoordinator等共享文件的变更必须串行，不能因不同故事而同时写。

[P]仅表示在其列出的依赖和阶段入口均完成后，可与同ready wave、不同文件任务并行；不代表可跳过未完成前置。未标[P]按顺序执行。本清单的并行示例只是未来排程，不派生代理或现在执行任务。

迁移路径0007为当前0001–0006基础上的任务目标，必须先由freeze门禁复核并锁定，若同时新增迁移只修订本文路径后再执行，不写占号迁移。技术固定基线：NestJS12/Drizzle、nestjs-best-practices1.2.0；HeroUI v3安装3.2.6、heroui-react3.0.1及根DESIGN.md。

## Phase 1: Setup — 治理与契约基线

**Goal**: 锁定本轮边界、实际文件路径和可生成契约，不重新初始化现有项目。

**Independent Test / Gate**: 仅生成任务不等于接受；accept完成前其余实现任务不可执行。
- [X] T001 在 `docs/specs/010-online-vod/spec.md` 和 `docs/adr/0016-online-vod-playback-transitions.md` 核验维护者明确接受并记录依据；未接受保持Proposed并停止后续实现，不因本任务或命令自动改Accepted。
- [X] T002 在 `docs/specs/010-online-vod/contracts/api.md`、`docs/specs/010-online-vod/data-model.md` 冻结字段与状态：明确slotRevision/pref version的“未有行=0”只属传输初值、持久revision>=1；区分canAttemptResume、最终续播、finish资格；将末尾体积/无源错误及slot重放歧义收敛为明确契约；核验最新迁移后锁定本清单 `apps/server/src/platform/database/migrations/0007_online_vod/up.sql` / `down.sql`（若已有占号，先同步本清单所有引用），任何产品变化先重评spec/ADR。 审查补充：冻结plan末节七项待产品确认取舍，未确认不得默选替代方案；（依赖：T001）
- [X] T003 将全部公共/Settings/个人/播放变更转为 `docs/specs/010-online-vod/contracts/openapi.yaml`，严格oneOf基础resolve/intent resolve，所有required/nullable/enum/长度及API错误与Markdown一致，保留stop204、进度applied旧义；同步 `docs/specs/005-pc-browsing-flow/contracts/openapi.yaml` / `api.md` 的明确扩展，不直接改生成类型。 审查补充：加入候选物化oneOf、next-plans、sourceCheckpoint、cleanup、playbackStarted/seekCapability及新增错误码；（依赖：T002）
- [X] T004 [P] 在 `docs/specs/010-online-vod/implementation-baselines.md` 记录nestjs-best-practices固定1.2.0及heroui-react固定3.0.1实际规则来源；按skill取所用组件/主题官方v3文档并核对安装3.2.6，在 `DESIGN.md` 补已确认项目媒体尺度token，记录明暗主题/键盘/响应式验证基线，不在业务组件发明裸值。（依赖：T002）
- [X] T005 [P] 新增 `apps/server/test/fixtures/online-vod/fixture-world.ts` 和 `apps/server/test/fixtures/online-vod/fixture-upstream.ts`：两Profile/两设备、3健康+1超时源、三集连续/缺集/重复号/版本冲突、相对HLS/key/redirect/时长变化；所有fixture无真实凭据，可控时钟/取消/事务故障钩子供各故事复用。（依赖：T002）
- [X] T006 新增 `apps/server/src/contexts/online-vod/online-vod.module.ts`、`online-vod.tokens.ts`、`index.ts` 和纯TS领域/应用端口骨架，在 `apps/server/src/app.module.ts` 装配；只发布接口，不导出实现/私表，不引入循环依赖或第二播放器。（依赖：T003）

## Phase 2: Foundational — 共享数据、授权与事务基础

**Goal**: 完成所有故事共用的schema、短事务工作集、有效策略与安全读取；不在此实现故事专属页面。

**Independent Test / Gate**: 迁移/授权/事务故障定向检查通过后解锁故事；先写测试并确认预期失败，再实现对应能力。

### Required Tests First
- [X] T007 [P] 先新增 `apps/server/test/contract/online-vod-migration.e2e-spec.ts`：旧静态locator/角色回填、家庭复合FK、唯一/枚举互斥、配额并发、空库up/down/up及非空在线down拒绝；仅隔离副本，不运行用户库。 审查补充：增加偏好操作/下一集计划/登记候选/起播标记迁移与FK/回滚用例；（依赖：T005, T006）
- [X] T008 [P] 先新增 `apps/server/test/unit/online-vod/unit-of-work.spec.ts`：事务参与者同连接可见性、每步注入失败整体回滚、无全局seam重绑、禁止事务await/独立提交。（依赖：T005, T006）
- [X] T009 [P] 先新增 `apps/server/test/unit/policy/vod-parent-child-policy.spec.ts`：父allow/子block、未评级拒绝、非空allow未命中但等级符合仍允许、父子较严格等级/单边继承、策略损坏及静态媒体旧行为。（依赖：T005, T006）

### Shared Models / Infrastructure
- [X] T010 在 `apps/server/src/platform/database/schema.ts` 定义来源/目录扩展，逐字落实模型约束：“所有业务表有household_id”；“引用使用家庭复合FK，唯一键都带家庭；ID服务端生成、不复用”；“时间UTC；整数seq/revision>=1，位置/时长有限非负、duration>0；年龄0–18或null”；“展示名1–255，简介纯文本<=4096；upstreamVodId/lineKey/episodeKey 1–255，NFC+trim不得截断身份”；来源“kind加vod；vod必须remote_url非空、NAS及EPG绑定为空；根地址不可PATCH；改名version+1，启停均locator_revision+1防ABA”；配置“source_id,adapter=apple-cms-json”“一源一行”；媒体“media_role=standalone/vod_title/vod_episode”“旧记录standalone；父movie/series/video、子episode；父没有playback_source”；关系“child唯一父；禁止自环和多层”。（依赖：T007）
- [X] T011 继续在 `apps/server/src/platform/database/schema.ts` 定义vod_title/line/episode/detail/sequence及资源引用：title字段“id,source_id,upstream_vod_id,parent_media_id,current_detail_revision,materialized_at”，“(source_id,upstream_vod_id)唯一，parent_media_id唯一”；line“id,title_id,line_key,display_name,sort_order”“(title_id,line_key)唯一”；episode“id,line_id,episode_key,label,media_id,content_version_state,evidence_kind/digest/schema_version,continuity_revision/signature”“(line_id,episode_key)、media_id唯一；verified需完整证据”；detail“title_id,revision,locator_revision,validated_private_payload,fetched_at,expires_at”“(title_id,revision)唯一，不可变”；sequence“title_id,line_id,detail_revision,sequence_revision,episode_id,season_key,ordinal,sequence_status”“状态ordered/ambiguous/special”；source_entry“identity_kind=vod_episode,identity_digest”；resource“保持entry唯一资源；static时location非空/vod引用空，online时相反且protocol=hls”；vod_episode不反存source_entry_id，避免第二权威/循环必填。 审查补充：新增vod_registered_candidate及operation返回引用同提交约束；（依赖：T010）
- [X] T012 继续在 `apps/server/src/platform/database/schema.ts` 定义ledger/history/preferences/observation/finish：ledger“continuity_revision、ledger_position/duration/generation/accepted_at、session_started、last_result”“seq跨generation递增”；history“continuity_revision、evidence_state/digest、completed”“(家庭,Profile,media)唯一；仅历史owner写；from-head可降低位置；completed只由有效finish写或新实际started重置”；preferences“profile_id,autoplay_next=true,switch_carry_position=true,version”“每Profile唯一；CAS”；observation“session_id,generation,event_seq,digest,event_type,position,rate,server_received_at,tail_anchor_position/time,delivered_seen”；receipt“session_id,generation,operation_key,request_digest,final_seq,final_session_accepted,history_applied/history_revision,session_completed,auto_next_eligible,reason,position,duration,ended_at,content/continuity/locator_revision”“session_id唯一；(家庭,device_session,contextVersion,operationKey)另有唯一幂等索引”；可空状态遵循 `contracts/api.md` DTO，不用0冒充未知时长。 审查补充：新增profile_vod_preference_operation、完整scope/digest/原响应/24h索引；（依赖：T011）
- [X] T013 继续在 `apps/server/src/platform/database/schema.ts` 定义物化operation及输入/过渡：operation字段“id、device_session_id、profile_context_version、profile_id、operation_key、request_digest、parent/selected_media_id、selected_content/continuity_revision、提交的detail/catalog_revision、result、committed_at/expires_at”“唯一(household,device_session,context_version,operation_key)”；input“session_id,generation,playback_source_id,source_id,locator_revision,detail_revision,content_revision,continuity_revision,evidence_state/digest,resolved_input_id,resolved_at/expires_at,start_basis(beginning/target_history/transition_carry),frozen_start_seconds(nullable直到probe),cleanup_state”；slot“from_session_id,from_generation,slot_revision,status(open/reserved/consumed),active_intent_id,successor_session_id”“唯一(household,from_session,generation)”；intent逐字段实现“id、from_session/generation、device_session_id/profile_id/context_version、action(next/manual_next/switch/recover_switch)、target_media_id及修订/来源版本、match_revision/confidence、confirmed_ambiguous、position_mode、carry_position/duration/source_ledger_seq、finish_receipt_id、operation_key/request_digest、slot_revision、created_at/expires_at、status(pending/cancelled/superseded/expired/consumed)、successor_id”。 审查补充：新增playback_next_plan及intent冻结快照/checkpoint、session.playback_started_at/cleanup_requested；（依赖：T012）
- [X] T014 在 `apps/server/src/platform/database/migrations/0007_online_vod/up.sql`、`down.sql` 实现以上字段/索引/枚举及FK，补 `apps/server/src/platform/database/migrate.ts` 所需迁移注册/非空down保护；“旧静态历史completed默认false但保留现有canResume语义；旧记录不冒充在线continuity证据”，保留旧账号/来源/媒体/历史；运行migration_test，不清库。（依赖：T013）
- [X] T015 在 `apps/server/src/contexts/online-vod/application/publication-work-set.port.ts`、`apps/server/src/contexts/playback/application/playback-work-set.port.ts` 定义MaterializeWorkSet/ProgressFinishWorkSet/TransitionConsumeWorkSet及每所有者transaction-aware发布端口；按 `contracts/internal-ports.md` 覆盖身份/策略读取、配额、幂等、session/epoch/ledger写入，application不传ORM句柄。（依赖：T008, T013）
- [X] T016 在 `apps/server/src/platform/database/unit-of-work.ts` 及 `apps/server/src/contexts/online-vod/infrastructure/transaction-participants.ts`、`apps/server/src/contexts/sources/infrastructure/transaction-participants.ts`、`apps/server/src/contexts/media-catalog/infrastructure/transaction-participants.ts`、`apps/server/src/contexts/policy/infrastructure/transaction-participants.ts`、`apps/server/src/contexts/playback/infrastructure/transaction-participants.ts`、`apps/server/src/contexts/personal-data/infrastructure/transaction-participants.ts`，并通过identity-access/profile只读事务端口工厂 实现同连接BEGIN IMMEDIATE仓储工厂、同步工作集和busy预算，在模块根注入；失败回滚/提交后取消，禁止全局seam临时重绑；使uow_test通过。 审查补充：接入RegisteredCandidate、NextPlan、PreferenceWrite、PlayingObservation、TransitionCleanup工作集；（依赖：T015, T014）
- [X] T017 在 `apps/server/src/contexts/policy/domain/effective-media-policy.ts`、`application/effective-media-policy.port.ts` 和 `index.ts` 实现服务端父子事实及名单目标扩展，复用既有判定顺序；跨所有授权入口复用发布端口，不把普通查询强行构造实体；使policy_test通过。（依赖：T009, T015）
- [X] T018 在 `apps/server/src/platform/upstream/safe-upstream.port.ts`、`safe-upstream-reader.ts` 提取/适配可复用有界安全读取，并新增 `apps/server/test/unit/online-vod/safe-upstream.spec.ts`；协议/DNS/每跳redirect/默认拒内网/AbortSignal/字节与嵌套预算覆盖CMS、probe、key/片段/测速，旧sources行为回归，不从online-vod导入sources私有实现。（依赖：T015）
- [X] T019 在 `apps/server/src/contexts/online-vod/domain/vod-budgets.ts` 和 `infrastructure/vod-config.ts` 集中配置搜索8s/并发3、预览8s/4MiB、10启用源/5000父/100000子、详情20线/单线2000/总5000项、每家庭100搜索/1000预览/进程256MiB；独立限流桶/TTL及shutdown取消，禁止无界等待。（依赖：T006）
- [X] T020 在 `packages/shared/package.json`、`packages/shared/src/index.ts` 、`packages/shared/src/constants.ts`、`apps/server/src/platform/http-common/domain-error.ts` 接入010 OpenAPI生成/问题码注册并导出DTO；新增 `packages/shared/src/vod-schema.d.ts` 只由生成器产生，构建复制；严格body<=16KiB/错误no-store/no-referrer及失败码白名单，运行gen:types/typecheck。（依赖：T003）
- [X] T021 新增 `apps/server/test/contract/online-vod-auth-boundaries.e2e-spec.ts` 验证真实装配的Public/Settings/Profile边界、CSRF/未知字段/私有地址白名单、A→B→A、过期grant/错误密码及内网拒绝；暂未实现端点的用例须失败不跳过，按故事补绿，不伪称全量通过。（依赖：T020, T018, T017, T016）

## Phase 3: User Story 1 — 配置来源并公开浏览 (Priority: P1) · 最小演示增量

**Goal**: 来源配置、聚合搜索、临时详情及认证物化，物化成功即公共入库。

**Independent Test / Gate**: 独立1健康+1超时源：游客可搜可看却不能播放，物化不留半成品；成功丢响应且预览过期后24h内仍恢复原目标。

### Required Tests First
- [X] T022 [P] [US1] 先新增 `apps/server/test/contract/online-vod-catalog.e2e-spec.ts` 覆盖Settings配置/测试/启停、公共search/preview/media/episodes及materializations所有接口，验证首次201/重放200/过期410/变更409/超限422、无个人字段/源位置。（依赖：T021）
- [X] T023 [P] [US1] 先新增 `apps/server/test/unit/online-vod/provider-parser.spec.ts` 覆盖NFC/trim、空/重复线路/标签、URL token更新、同名不同版本、截断与协议失败不判missing；“不把第01集自动等价为第1集”。（依赖：T005, T020）
- [X] T024 [P] [US1] 先新增 `apps/server/test/contract/online-vod-materialization.e2e-spec.ts` 覆盖每步故障回滚、预分配ID策略拒绝、净配额并发、异key目标复用、同key异摘要冲突、成功重放优先于预览TTL、24h目标保护和目录revision不虚增。 审查补充：测试candidateRef首次物化、丢响应/过期重放、登记映射与结果原子回滚；（依赖：T021）

### Models → Services → Interfaces → Integration
- [X] T025 [US1] 在 `apps/server/src/contexts/online-vod/domain/provider-model.ts`、`infrastructure/apple-cms.adapter.ts` 实现Apple CMS JSON搜索/详情/多线HLS定位解析，基础证据unverified；逐字保留“upstreamVodId/lineKey/episodeKey 1–255，NFC+trim不得截断身份”“简介纯文本<=4096”；预算和完整性校验失败整体拒绝。（依赖：T023, T018, T019）
- [X] T026 [US1] 在 `apps/server/src/contexts/sources/application/sources.service.ts`、`domain/source-target.validation.ts`、`infrastructure/sources-store.drizzle.ts` 支持vod配置/能力、Settings当次密码、CAS及10源净配额，禁止根地址PATCH和vod旧refresh；改名不杀流，启停递增locator防ABA。（依赖：T022, T014, T017）
- [X] T027 [US1] 新增 `apps/server/src/contexts/online-vod/application/online-vod-store.port.ts`、`infrastructure/online-vod-store.drizzle.ts`，实现稳定映射、私有详情、operation仓储及事务participant；“(source_id,upstream_vod_id)唯一，parent_media_id唯一”“(line_id,episode_key)、media_id唯一”，所有查询带家庭，无其他上下文私表导入。（依赖：T024, T016, T025）
- [X] T028 [US1] 在 `apps/server/src/contexts/online-vod/application/search.service.ts`、`preview.service.ts`、`infrastructure/vod-cache.ts` 实现轮转缓冲/去重/未消费队列、cursor并发合并、已生成页重放、opaque ref、10min/2000结果及总缓存上限；预览不物化，无源/全失败/部分失败/空结果分别响应。（依赖：T025, T027）
- [X] T029 [US1] 在 `apps/server/src/contexts/online-vod/application/materialization.service.ts`、`publication.service.ts` 实现MaterializeWorkSet：成功key恢复→身份/策略→稳定ID查找或预分配→配置/详情CAS→净配额→整片映射/资源→幂等结果→公开revision同提交；“固定24h保留，重放不延长”；移除enrolledAt/started入库依赖。 审查补充：物化候选严格分支同事务发布registeredCandidateRef及结果，重放保护至少24h；（依赖：T027, T024, T017）
- [X] T030 [US1] 在 `apps/server/src/contexts/media-catalog/application/public-catalog.service.ts`、`infrastructure/media-catalog-store.drizzle.ts`、`application/media-catalog-store.port.ts` 实现父级公共可用性/角色/分页分集投影；父不进入可播放候选集合、子不重复铺卡片；同步既有可用性等价查询与策略候选树，NAS/IPTV不变。（依赖：T029）
- [X] T031 [US1] 在 `apps/server/src/contexts/online-vod/interface/public-vod.controller.ts`、`materialization.controller.ts` 及 `apps/server/src/contexts/settings/interface/settings-sources.controller.ts` 装配对应接口/Guards/DTO/限流；后端拒绝非法URL/Profile字段、全量refresh，返回同形授权错误及白名单输出，使us1_contract/us1_atomic_test通过。 审查补充：开放candidateRef请求分支并返回登记引用，不让前端推导上游键；（依赖：T028, T026, T030, T020）
- [X] T032 [P] [US1] 先新增 `apps/web/test/online-vod-catalog.spec.tsx`：搜索恢复/过期/partial、跨页线路聚合、游客不发个人请求、物化幂等和选档后候选过期重选；按已冻结共享DTO mock，不依赖真实上游。（依赖：T020, T004）
- [X] T033 [US1] 在 `apps/web/src/features/catalog/VodCatalogPage.tsx`、`OnlineVodDetailPage.tsx`、`MediaDetailPage.tsx` 和 `apps/web/src/app/routes.tsx` 实现媒体库/在线搜索、预览/选集及稳定父详情；HeroUI v3/语义token；物化成功跳稳定详情，不在预览时永久入库或写历史。（依赖：T032, T031）
- [X] T034 [US1] 在 `apps/web/src/shared/query/keys.ts`、`apps/web/src/features/settings/settings-sources-page.tsx` 接入公共查询键、来源配置/测试/启停UI、后台grant失效处理；搜索mode/q/searchId/cursor可恢复，设置按钮隐藏不代替服务端拒绝。（依赖：T033）
- [ ] T035 [US1] 在 `apps/web/test/e2e/online-vod-browse.spec.ts` 和 `docs/specs/010-online-vod/evidence/us1-browse.md` 执行Q1/Q2：20次3健康+1超时搜索/每源100样本，19次<=8s；记录游客边界、物化20组故障/并发及脱敏Network证据，不能用静态断言冒充播放通过。（依赖：T034, T022, T024）

## Phase 4: User Story 2 — Profile播放与续播 (Priority: P1)

**Goal**: 固定在线输入、会话接受ledger、单起点冻结及跨设备实际续播。

**Independent Test / Gate**: 两Profile/两设备同集位置隔离；20次停止/重开含重启至少19次恢复到最后确认位置±3s，已知内容/时长冲突明确回退。

### Required Tests First
- [X] T036 [P] [US2] 先新增 `apps/server/test/contract/online-vod-progress-resume.e2e-spec.ts` 覆盖resolve/progress/历史/状态/受控资源及再授权，断言superseded可sessionAccepted=true/applied=false、跨generation seq单调、准备不建历史及时长未知拒绝旧历史兜底。（依赖：T031）
- [X] T037 [P] [US2] 先新增 `apps/server/test/unit/online-vod/continuity-resume.spec.ts`：内容/连续性转换、token不重置、追加别集不影响旧集、尾部未完成允许续播、短片、差异max(30s,旧duration×2%)及冻结后他设备更新不改变起点。（依赖：T005, T020）
- [X] T038 [P] [US2] 先新增 `apps/server/test/unit/playback/vod-input-binding.spec.ts`：probe/资产/转换同input、一次准备重试/取消、修订变更终止、generation原子换绑、旧代输出不能ready、重启清理及readyAt60s未playback_started_at回收。 审查补充：测试未知duration合格playing后超过60s保留、无playing仍回收及watchdog CAS竞争；（依赖：T005, T014）

### Models → Services → Interfaces → Integration
- [X] T039 [US2] 在 `apps/server/src/contexts/online-vod/domain/continuity.rules.ts`、`application/continuity.service.ts` 实现“contentRevision表示已知内容替换/可信证据更换”“新增其他集不使已有子revision改变”；signature不含URL/采集时间；证据升降级和关键结构修订各最多+1，失败不发布，不批量升级历史。（依赖：T037, T029）
- [X] T040 [US2] 在 `apps/server/src/contexts/personal-data/application/progress-write.service.ts`、`progress-clock.service.ts`、`personal-data-store.port.ts` 及 `infrastructure/personal-data-store.drizzle.ts` 实现会话ledger与epoch历史分离：“seq跨generation递增；新有效样本先更新ledger，再按epoch决定历史；superseded仍sessionAccepted=true；stale不更新；与历史同事务”；session+epoch/完整ledger首次建档同事务，保留applied旧义。（依赖：T036, T016）
- [X] T041 [US2] 在 `apps/server/src/contexts/personal-data/application/history.service.ts`、`apps/server/src/contexts/playback/application/vod-start-position.service.ts` 实现唯一beginning/target_history/transition_carry起点计算端口（carry输入留给US4接线），本次probe后只冻结一次；“nearEnd只是UI提示”；线上duration不从历史或其他Profile兜底，静态规则不变。 审查补充：next目标历史带expectedHistoryRevision，probe前变化失败NEXT_PLAN_CHANGED；（依赖：T039, T040）
- [X] T042 [US2] 在 `apps/server/src/contexts/online-vod/application/location.port.ts`、`location.service.ts` 和 `apps/server/src/contexts/playback/infrastructure/playback-input-store.drizzle.ts` 返回固定ResolvedVodInput及私有绑定；逐字落实“每session/generation最多一有效绑定”“frozen_start_seconds(nullable直到probe)”和“start_basis(beginning/target_history/transition_carry)”；地址不进入公共DTO或日志。（依赖：T038, T039, T027）
- [X] T043 [US2] 在 `apps/server/src/contexts/playback/application/playback-resolver.service.ts`、`playback-authorization.service.ts`、`playback.module.ts` 接入事务建档/ledger、有效父子策略、固定定位和本次probe起点；父只返回授权后的选集错误；ready前重验Profile/context/locator/content/continuity/CAS，不默默重绑或二次历史覆盖。（依赖：T041, T042）
- [X] T044 [US2] 在 `apps/server/src/contexts/playback/infrastructure/media-probe.service.ts`、`hls-proxy.service.ts`、`application/playback-assets.service.ts` 及 `apps/server/src/contexts/playback/infrastructure/conversion-supervisor.service.ts` 接固定input/租约和SafeUpstream；涵盖master/media/相对URI/key/redirect；ffmpeg不得直接任意上游联网，无法安全支持则明确拒绝该转换，不承诺全格式。（依赖：T043, T018）
- [X] T045 [US2] 在 `apps/server/src/contexts/playback/application/playback-selection.service.ts`、`infrastructure/playback-lifecycle.service.ts`、`application/playback-retention.service.ts` 实现代次CAS+同input新绑定+旧代撤销/持久cleanup；“失败前无变化，失败后新代failed不倒退，seq不归零”；readyAt起60s未playback_started_at回收，heartbeat/renew不续命。 审查补充：未起播期限改以独立playback_started_at解除；保留hls_proxy服务端seek拒绝并发布seekCapability；（依赖：T044, T038）
- [X] T046 [US2] 在 `apps/server/src/contexts/personal-data/interface/vod-personal.controller.ts`、`application/vod-history.service.ts` 及playback现有控制器输出ProgressReply/startBasis/候选续播/父级TitleProgress，个人查询键明确；“latest取最近实际记录”“resumeCandidate取最近未完成且可候选的本Profile子项”，静态canResume原义保留。（依赖：T045, T040, T020）
- [X] T047 [P] [US2] 先扩展 `apps/web/test/playback-progress-queue.spec.ts` 并新增 `apps/web/test/vod-resume.spec.tsx`：session生命周期seq分配、2xx不等于接受、superseded提示、generation不stop、首次started门与续播降级/切档清理；记录失败再实现。 审查补充：测试本地seek不换generation、尾段复位及本地续播落点失败不显示成功；（依赖：T033, T020）
- [X] T048 [US2] 在 `apps/web/src/features/playback/progress-controller.ts`、`use-playback-progress.ts` 实现session级唯一seq/命令泵基础、不可变载荷及awaitable pauseAndFlush/stopOnce接口；generation更新只更新phase，队列合并未分配号periodic；对接实际ProgressReply，不再privateFetch<void>或2xx当保存，卸载兜底复用同Promise。 审查补充：pauseAndFlush返回精确接受checkpoint，丢响应原样重试，ledger前进需重新选择；（依赖：T047, T046）
- [X] T049 [US2] 在 `apps/web/src/features/playback/player-view.tsx`、`apps/web/src/features/catalog/MediaDetailPage.tsx`、`apps/web/src/features/history/use-history.ts` 、`apps/web/src/features/history/history-api.ts`、`apps/web/src/features/history/history-card.tsx` 接继续/从头、候选资格与probe后原因；本Profile缓存/旧响应守卫，未实际playing不得started，更新 `apps/web/src/shared/query/keys.ts` 相关个人键。 审查补充：按seekCapability及实际范围执行client/server_rebuild定位，无duration显示不可保存；（依赖：T048, T046）
- [ ] T050 [US2] 新增 `apps/web/test/e2e/online-vod-resume.spec.ts`，执行Q3/Q4并在 `docs/specs/010-online-vod/evidence/us2-resume.md` 记录20次恢复/重启/两设备、19次±3s、两Profile负向及内容/时长变化回退；既有NAS/直播独立回归，缺真实环境记录未完成不标通过。（依赖：T049, T036, T038）

## Phase 5: User Story 3 — 自动下一集 (Priority: P1)

**Goal**: 自然finish与普通stop分离；实现可取消连播和供US4复用的单后继过渡核心。

**Independent Test / Gate**: 有序三集自然结束10次只播正确下一集一次；拒绝/缺集/开关关闭/切档/手势阻止不误播。

### Required Tests First
- [X] T051 [P] [US3] 先新增 `apps/server/test/contract/online-vod-finish.e2e-spec.ts`：observations/finish/finish-result/stop接口，final先接受再判尾段、superseded独立完成、stale final不连播、stop先赢不升级、同key重放/异key冲突及旧上下文不可读receipt。（依赖：T046）
- [X] T052 [P] [US3] 先新增 `apps/server/test/contract/online-vod-next-transition.e2e-spec.ts`：next/manual_next创建/查询/取消、resolve消费、不同key单slot、丢响应重放、每步事务故障、取消与消费CAS、目标独立策略及偏好消费时重验。 审查补充：测试nextPlan目标/序列/历史变更、过期、消费后禁源且响应丢失的最小cleanup及重试；（依赖：T046）
- [X] T053 [P] [US3] 先新增 `apps/server/test/unit/online-vod/episode-sequence.spec.ts` 和 `apps/server/test/unit/playback/vod-completion.spec.ts`，覆盖同线明确N+1/缺集/重复/季界/special，以及0.5–2倍速/短片/seek到尾/周期样本距尾8s/断网尾段未知等规则。（依赖：T005, T039）

### Models → Services → Interfaces → Integration
- [X] T054 [US3] 新增 `apps/server/src/contexts/playback/domain/finish.rules.ts`、`transition.rules.ts`：receipt“session_id唯一”“终态不得由新finish升级”；slot“status(open/reserved/consumed)”及唯一来源代次；intent“status(pending/cancelled/superseded/expired/consumed)”和action枚举；“TTL固定60s，重试不续期”“consumed槽永久不能再建立第二后继”，先实现next/manual_next业务规则而不开放未完成switch路径。（依赖：T053, T013）
- [X] T055 [US3] 在 `apps/server/src/contexts/online-vod/application/episode-sequence.service.ts`、`infrastructure/online-vod-store.drizzle.ts` 发布独立导航序列，“状态ordered/ambiguous/special”；只同源同线常规N+1，不改稳定标签身份，不因特殊集/空/重复编号猜下一集。 审查补充：发布序列修订，并由playback/application/next-plan.service.ts持久有界不可变计划；（依赖：T054, T027）
- [X] T056 [US3] 在 `apps/server/src/contexts/personal-data/application/vod-preferences.service.ts`、`vod-personal.controller.ts` 及个人仓储实现偏好GET/PATCH：“profile_id,autoplay_next=true,switch_carry_position=true,version”“每Profile唯一；CAS；开关消费过渡时重读”；未有行返回version=0，成功key固定24h重放，实际持久版>=1。 审查补充：偏好CAS与operation同事务；测试A成功/B更新/重放A仅返回原值不覆盖B、异摘要与24h清理；（依赖：T054, T046）
- [X] T057 [US3] 在 `apps/server/src/contexts/playback/application/phase-observation.service.ts`、`interface/playback-observation.controller.ts` 实现“最新event_seq幂等；seek/pause/buffering/error/未知跳跃重置anchor；不写个人历史；最高2Hz/会话，正常playing每1s，固定TTL会话生命周期”；rate0.5–2、推进<=服务器间隔×rate+0.5s、gap>3s为unknown；不能用观测当授权证明。 审查补充：playing观测与session.playback_started_at同事务，交付/身份/代次校验，不写ledger/history；（依赖：T054, T044）
- [X] T058 [US3] 在 `apps/server/src/contexts/playback/application/playback-finish.service.ts`、`interface/playback-finish.controller.ts` 和 `infrastructure/playback-lifecycle.service.ts` 实现ProgressFinishWorkSet+receipt/终态原子提交，final先校验再尾段min(5s,d×5%)/连续min(2s,d×5%)判定；stop仍204；返回finalSessionAccepted/historyApplied/sessionCompleted/autoNextEligible独立值，硬错误回滚、stale可停止不连播。（依赖：T057, T051, T016）
- [X] T059 [US3] 新增 `apps/server/src/contexts/playback/application/playback-transition-store.port.ts`、`infrastructure/playback-transition-store.drizzle.ts` 及 `application/transition-source-context.service.ts`：slot/intent/receipt持久查询、同上下文终态只读来源授权、scope幂等、60s固定TTL/24h消费结果保护，初始revision=0/open只作响应默认；禁止复用活动控制授权重发旧源票。 审查补充：持久NextPlan快照及intent引用保留，创建/消费校验序列/目标/历史revision；（依赖：T054, T052）
- [X] T060 [US3] 在 `apps/server/src/contexts/playback/application/playback-transition.service.ts`、`interface/playback-transition.controller.ts` 实现next/manual_next、显式替换pending、GET恢复及cancel输家返回successor；NEXT_HISTORY_CHOICE_REQUIRED阻止覆盖目标记录，重验偏好/序列/双方上下文及目标权限；switch分支在US4完成前明确拒绝。 审查补充：增加next-plans端点，next/manual_next必须nextPlanRef，禁止旧historyChoiceConfirmed；（依赖：T059, T055, T056, T058）
- [X] T061 [US3] 在 `apps/server/src/contexts/playback/application/playback-resolver.service.ts`、`playback-work-set.port.ts` 和输入仓储中接入intent resolve判别输入，禁止同时startMode；同事务slot CAS+新preparing+epoch/ledger+consumed/后继结果，重放200同session而非新201；carry/target_history/beginning只一个起点，已消费不复活或再生第二后继。 审查补充：消费精确计划快照，成功重放不因计划过期再建会话；（依赖：T060, T043）
- [X] T062 [US3] 在 `apps/server/src/contexts/playback/application/playback-retention.service.ts`、`infrastructure/playback-input-store.drizzle.ts` 实现receipt/已消费intent/slot至少24h且不短于会话保留、引用图清理及启动恢复；“资产可按原短TTL清理，但不能连带删去受这些引用保护的session行/ledger”；无人接管preparing/ready固定60s兜底回收。 审查补充：新增transition-cleanup.service.ts及controller最小cleanup端点/工作集，先撤交付再commit后stop，重启可重试；（依赖：T061, T045）
- [X] T063 [P] [US3] 先新增 `apps/web/test/vod-autoplay.spec.tsx`：自然结束receipt驱动倒计时、取消/关闭/切档、目标已有历史询问、play拒绝手势恢复、60s释放及重复事件不造会话。 审查补充：测试倒计时目标改变重新确认及未知duration起播不误杀；（依赖：T049, T020）
- [X] T064 [US3] 在 `apps/web/src/features/playback/progress-controller.ts` 实现finish队列与观察flush、一次final Promise及保存结果恢复，结束后卸载不再补final；新增 `apps/web/src/features/playback/use-vod-autoplay.ts` 仅在receipt资格后倒计时/建意图，next/manual_next和偏好Profile键接入。 审查补充：倒计时前取nextPlanRef，历史变化/过期重新展示；（依赖：T063, T061）
- [X] T065 [US3] 在 `apps/web/src/features/playback/player-view.tsx`、`video-player.tsx`、`apps/web/src/app/action-coordinator.tsx` 添加连播开关/5s取消/立即下一集/目标历史确认及NotAllowedError回调；awaitingGesture不发started、不再跳集；server readyAt60s为回收准时源，UI点击只恢复有效目标，过期重新授权。（依赖：T064, T062, T004）
- [ ] T066 [US3] 新增 `apps/web/test/e2e/online-vod-autoplay.spec.ts`，执行Q5/Q7并在 `docs/specs/010-online-vod/evidence/us3-autoplay.md` 记录自然结束10组、缺集/受限/开关/手势及20组不同key单后继/事务故障；无真实连播证据不得标Verified。（依赖：T065, T051, T052）

## Phase 6: User Story 4 — 播放器内便捷换源 (Priority: P1)

**Goal**: 扩展单后继核心至主动switch/recover_switch、候选匹配、有界测速和carry。

**Independent Test / Gate**: 两来源同集10次carry误差<=3s；同Profile他设备历史不能劫持位置，歧义/冲突/时长异常明确降级。

### Required Tests First
- [X] T067 [P] [US4] 先新增 `apps/server/test/contract/online-vod-switch.e2e-spec.ts` 覆盖候选/测速/switch/recover_switch及resolve消费，未授权目标不探测、无票/历史、source ledger不取他设备history、源未终态不消费、停止丢响应恢复和媒体故障60s分支。 审查补充：测试candidateRef物化贯通、checkpoint缺失/不等/明确旧游标、内容失权清理与旧context拒绝；（依赖：T061）
- [X] T068 [P] [US4] 先新增 `apps/server/test/unit/online-vod/source-match.spec.ts`：high/ambiguous/conflict、电影年/剧集年季集、版本语言冲突、缺字段降歧义、确认不提升冲突、不能按列表下标对应。（依赖：T005, T025）
- [X] T069 [P] [US4] 先新增 `apps/web/test/vod-switch.spec.tsx`：pause非接受、用更早ledger/从头、目标历史三选一、停前失败恢复/停后不复活、取消输给消费需追查并stop、重复key/不同目标并发及切档旧响应。（依赖：T065, T020）

### Models → Services → Interfaces → Integration
- [X] T070 [US4] 在 `apps/server/src/contexts/online-vod/domain/source-match.rules.ts`、`application/switch-candidates.service.ts` 实现“matchConfidence=high|ambiguous|conflict”及匹配规则版本/候选TTL；从已授权fromSession可信标题构造搜索，返回opaque具体集，不接受任意q/URL；可恢复failed仅60s。 审查补充：候选映射绑定原session/Profile/context/准确集，并发布registeredCandidateRef映射；（依赖：T068, T059）
- [X] T071 [US4] 新增 `apps/server/src/contexts/online-vod/application/switch-probe.service.ts`、`interface/vod-switch.controller.ts`，逐候选复用policy服务端事实先授权再测；“单候选3s/1MiB、全次5s，内部并发3”，最多3个ref，取消传播；只首响应延迟，无客户端清单/片段/票据，不物化/写历史。（依赖：T067, T070, T018）T091 审计补勾（2026-10-31）：两实现文件与 `unit/online-vod/switch-probe.spec.ts`（14 例）均在树且全绿（release-checks §0；`SWITCH_PROBE_BUDGETS` 见 performance.md §六），系漏标非补实现。
- [X] T072 [US4] 在 `apps/server/src/contexts/playback/application/playback-transition.service.ts`、`transition-source-context.service.ts`、`interface/playback-transition.controller.ts` 开放switch/recover_switch请求：绑定候选/内容/连续性/locator/match版本、当前session ledger seq冻结carry；allowEarlierAcceptedPosition显式旧样本回退、歧义需确认/冲突禁carry；故障恢复仅媒体故障60s，禁权/切档/禁源不得借恢复。 审查补充：carry只接受sourceCheckpoint精确匹配当前代ledger，不自动选择旧游标；（依赖：T071, T060）
- [X] T073 [US4] 在 `apps/server/src/contexts/playback/application/vod-start-position.service.ts`、`playback-resolver.service.ts` 实现carry基于冻结source ledger、target_history基于目标Profile历史及beginning=0三互斥路径；目标本次duration差异超max(30s,源duration×2%)或位置越界回退并提示，不用百分比、不被普通resume读取覆盖，目标started才写目标历史。 审查补充：冻结精确checkpoint读取的position/duration，之后final不覆盖；（依赖：T072, T041）
- [X] T074 [US4] 新增 `apps/web/src/features/playback/vod-source-switcher.tsx`、`use-vod-transition.ts`，候选/最多3测速/版本警告/保留当前位置或目标记录或从头；串行暂停确认→必要物化→intent→stopOnce确认→resolve；停前失败恢复，停后重建；遵循HeroUI v3/语义token，不退出播放器重搜。 审查补充：通过candidateRef物化取登记引用，显式展示接受游标并提交sourceCheckpoint；（依赖：T069, T073, T004）
- [X] T075 [US4] 在 `apps/web/src/app/action-coordinator.tsx`、`apps/web/src/features/playback/use-vod-transition.ts` 实现source slotRevision冲突恢复、cancel/consume赢家追查、不同ui操作号的已创建后继显式stop及不可见预备超时；注册recover_switch提示、60s过期新普通播放；不自动循环尝试来源。 审查补充：完整恢复失权时调用cleanup无需后继ID，处理cleanup_pending/重试，不借旧context清理；（依赖：T074, T062）
- [ ] T076 [US4] 新增 `apps/web/test/e2e/online-vod-switch.spec.ts` 并在 `docs/specs/010-online-vod/evidence/us4-switch.md` 执行Q6/Q7：两真实来源10次carry±3s、他设备不同历史、歧义确认/冲突/时长回退、20组不同key及取消竞争；记录源地址脱敏Network，测速无票/历史。（依赖：T075, T067, T069）

## Phase 7: User Story 5 — 稳定退出与全局播放 (Priority: P2)

**Goal**: 收口前述共享控制器的全局导航、退出、切档和失联恢复；不能等到本阶段才加入必要session控制基础。

**Independent Test / Gate**: 20次导航不断播；断网退出/切档保存最多1s后继续，重复卸载无异载荷final，无主后继可找回/回收。

### Required Tests First
- [ ] T077 [P] [US5] 先新增 `apps/web/test/vod-global-playback.spec.tsx` 和扩展 `apps/web/test/unit/identity-purge.spec.tsx`，覆盖路由不中断、全局非阻塞/设置入口、1s退出、A→B→A清缓存/倒计时/测速、generation更新不触发session stop、同final Promise清理。（依赖：T075）
- [X] T078 [P] [US5] 先新增 `apps/server/test/contract/online-vod-transition-revocation.e2e-spec.ts`：创建/消费/GET重放/cancel每步旧上下文同形拒绝；更换Profile/禁源ABA/目标修订/偏好关闭后不能消费；已消费后继取消输家、watchdog及重启不复活。 审查补充：增加禁源但同context仅清理、跨设备/Profile/ABA拒绝及清理标记阻断新票/资产；（依赖：T072）

### Integration / Hardening
- [X] T079 [US5] 在 `apps/web/src/app/action-coordinator.tsx`、`apps/web/src/features/playback/progress-controller.ts` 和 `apps/web/src/app/session-provider.tsx` 统一明确退出/切档/卸载stopOnce和有界1s保存，身份撤销不能被保存阻塞；保存失败提示与superseded/仅投递区别，不能使用旧身份离线补报。（依赖：T077, T075）T091 审计补勾（2026-10-31）：`BOUNDED_SAVE_MS=1_000`/`boundedSave` 在 progress-controller.ts:120、stopOnce 统一收口在 action-coordinator.tsx/session-provider.tsx 均在树（us5-global.md §4.2/§5.1），web vitest 265 全绿覆盖其单测面；e2e ≤1s 实测属 T082/FR-034 Not-run，不因此冒充；系漏标非补实现。
- [X] T080 [US5] 在 `apps/web/src/shared/query/keys.ts`、`apps/web/src/features/playback/use-vod-autoplay.ts`、`use-vod-transition.ts` 实现当前服务端Profile/contextVersion个人键和每await守卫，身份变化取消倒计时/测速/未消费意图；公共浏览保持可用，普通路由变化不清理全局会话。（依赖：T079）
- [X] T081 [US5] 在 `apps/server/src/contexts/playback/application/playback-retention.service.ts`、`infrastructure/playback-input-store.drizzle.ts`、`playback-transition-store.drizzle.ts` 收口重启扫描/cleanup持久标记、租约取消/超时、元数据FK保护及已消费后继找回；“未playback_started_at的ready会话以服务器readyAt起60s固定期限回收”“heartbeat/renew不续命”，末次检查身份撤销立即拒绝而不等TTL。 审查补充：以playback_started_at解除未起播期限，扫描持久cleanup并保护受引用nextPlan/登记映射；（依赖：T078, T062, T072）
- [X] T082 [US5] 新增 `apps/web/test/e2e/online-vod-global.spec.ts` 并在 `docs/specs/010-online-vod/evidence/us5-global.md` 执行Q9/Q7：20次导航、弱网退出/切档<=1s保存尝试、重复关闭/StrictMode、消费响应丢失后找回/stop、浏览器退出watchdog，保留无主会话为0与终态复活为0证据。（依赖：T080, T081）

## Phase 8: Polish & Cross-Cutting — 发布质量与真实证据

**Goal**: 完成跨故事安全/性能/迁移/视觉证据、同步文档及全量门禁。

**Independent Test / Gate**: 所有SC有对应统计及真实浏览器/Linux证据；缺证据保持未验收，不能靠勾选任务提升Verified。
- [X] T083 新增 `apps/server/test/contract/online-vod-security.e2e-spec.ts` 并扩展 `apps/server/test/unit/online-vod/safe-upstream.spec.ts`：CMS/redirect/manifest/key/segment/ffmpeg/测速的SSRF与预算、未知字段/大体积/源位置/其他Profile泄露、限流桶与缓存全局上限；同源或测速成功不能绕过目标策略。（依赖：T081, T067）
- [X] T084 在 `apps/server/src/contexts/online-vod/application/vod-retention.service.ts`、`apps/server/test/contract/online-vod-retention.e2e-spec.ts` 实现/验证物化24h保护后按引用图整组清理：历史/名单/活动或保留终态session/slot/intent/operation保护、先过期幂等/意图；不删历史释放配额，重复运行不破坏FK。 审查补充：补偏好operation24h、计划受引用保护、登记候选与operation联合回收；（依赖：T081, T029）
- [X] T085 新增 `apps/server/test/contract/online-vod-budgets.e2e-spec.ts` 并在 `docs/specs/010-online-vod/evidence/performance.md` 记录SC001缓存/搜索总期限、SQL批量查询无N+1、详情/候选大规模预算及全局工作队列上限；失败优化只改真实瓶颈，不降低公开完整性或安全校验。（依赖：T083, T084）
- [X] T086 在 `docs/specs/010-online-vod/evidence/migration-recovery.md` 记录隔离旧业务副本升级、空库up/down/up、非空在线down拒绝和升级前备份+匹配镜像恢复；核对账号/历史/NAS/IPTV摘要保留、旧session/grant/intent不复活，禁止当前用户库演练。（依赖：T084, T014）
- [X] T087 在 `docs/specs/010-online-vod/evidence/visual-accessibility.md` 保存HeroUI v3官方文档日期/固定skill版本及 `DESIGN.md` token核对，覆盖两主题、键盘/屏幕阅读提示、响应式、非阻塞播放/设置入口、倒计时/测速/警告/awaitingGesture状态；不以静态截图替代交互证据。（依赖：T082, T004）
- [ ] T088 在 `docs/specs/010-online-vod/evidence/runtime-network.md` 执行 `docs/specs/010-online-vod/quickstart.md` 的真实浏览器+目标Linux容器播放：HLS/key/redirect、停止/重启续播、多集连播、两来源carry、编解码/CPU/网络环境及私有字段零泄漏；外部故障和软件失败分列，未具备环境时保持任务未完成。 审查补充：真实HLS client seek/续播落点及未知时长>60s播放；不把未支持server seek标通过；（依赖：T050, T066, T076, T082, T083, T087）
- [X] T089 同步 `docs/specs/010-online-vod/spec.md`、`plan.md`、`quickstart.md`、`contracts/api.md`、`docs/specs/005-pc-browsing-flow/contracts/api.md`、`docs/adr/0016-online-vod-playback-transitions.md`、`docs/vod-integration-proposal.md` 与实际交付；文档移除历史“2xx已保存/stop完成/末30秒必从头”推断，不重写旧ADR接受记录；维护 `docs/specs/010-online-vod/evidence.md` 的FR/SC证据矩阵。（依赖：T088, T086, T085）
- [X] T090 按 `docs/specs/010-online-vod/quickstart.md` 运行gen:types、lint、typecheck、build、server单元/契约、web Vitest/Playwright、audit:boundaries/purity和verify:release，将命令/结果归档 `docs/specs/010-online-vod/evidence/release-checks.md`；既有静态/直播回归失败先定位，不把无关失败默认为通过。（依赖：T089）
- [X] T091 在 `docs/specs/010-online-vod/evidence.md` 对SC001–008逐项列出样本/成功数/±3s误差/时间/负向结果及证据链接，复核 `docs/specs/010-online-vod/tasks.md` 只有完成事项可勾选；接受、实施和Verified各需真实依据，缺Linux/浏览器/迁移/视觉证据不标Verified，不自动commit/push/部署。（依赖：T090）完成记录：evidence.md §2.1（SC 可判定口径）+ §4（终审记录：订正 7 项、回归 265/730/1484 三链绿、未完成项完成条件重述）；T035/T050/T066/T076/T077/T088 保持未勾选，010 维持 Implementing。

## Dependencies & Execution Order

### Phase / Story Graph

```mermaid
flowchart LR
  G[接受与契约门禁] --> F[共享基础]
  F --> U1[US1 公开浏览/物化]
  U1 --> U2[US2 受控播放/续播]
  U2 --> U3[US3 finish/单后继/连播]
  U3 --> U4[US4 主动换源/carry]
  U4 --> U5[US5 全局退出/身份收口]
  U5 --> V[跨域/迁移/真实Linux及浏览器验收]
```

US1可单独演示浏览/物化，测试用预登记静态夹具可验证后续单故事规则；US2真实播放需要US1来源和资源。US3建立US4共用slot/intent/finish基础，US4不能反过来作为US3前置。US5的session命令泵基础已经前置到US2、finish前置US3，US5只做全局整合/收口，避免形成循环依赖。

### Within Each Story

测试合同/领域边界先写并观察失败；模型/仓储→用例/原子事务→接口/真实装配→UI与证据；阶段检查点不是Verified。前端测试可以依固定生成DTO先行，真实集成仍须等后端。修改schema.ts、共享OpenAPI、控制器或ActionCoordinator的任务串行；各条依赖显式列出。

### Parallel Execution Examples

- **US1**：各自依赖满足后，T022、T023、T024、T032可并行编写（测试文件互不重叠）；实现共享文件仍按后续串行依赖，不把全部故事并行。
- **US2**：各自依赖满足后，T036、T037、T038、T047可并行编写（测试文件互不重叠）；实现共享文件仍按后续串行依赖，不把全部故事并行。
- **US3**：各自依赖满足后，T051、T052、T053、T063可并行编写（测试文件互不重叠）；实现共享文件仍按后续串行依赖，不把全部故事并行。
- **US4**：各自依赖满足后，T067、T068、T069可并行编写（测试文件互不重叠）；实现共享文件仍按后续串行依赖，不把全部故事并行。
- **US5**：各自依赖满足后，T077、T078可并行编写（测试文件互不重叠）；实现共享文件仍按后续串行依赖，不把全部故事并行。

## Implementation Strategy

### MVP First

最小可演示增量=Setup+Foundational+US1：管理员配置、游客搜索/详情、认证物化及公开入库，独立验证不匿名播放与无半成品。该MVP只供分阶段演示，不冒称在线播放完整交付。

可用观看增量=再完成US2的真实起播/历史/续播及本阶段证据；第一期最终范围必须再完成US3自动连播、US4便捷换源和US5稳定退出，不能以MVP名义取消用户已要求的三项体验。每个增量保持既有NAS/IPTV/静态续播回归。

### Incremental Delivery

先治理/合同冻结，再落共享结构与所有权；按故事递增验证。运行真实来源/设备前用fixture查清状态机和权限负向；真实浏览器/Linux验收另留证。未完成迁移/备份恢复、安全或运行证据时保持Implementing或原状态，不批量勾选或自动提升Verified。代码、生成类型、契约和对应证据同一逻辑变更交付，但本清单不授权commit/push。

## Coverage & Independent Acceptance

| 故事/领域 | 需求 | 独立验收入口 | 成功标准 |
| --- | --- | --- | --- |
| US1 | FR001–007、FR039公开边界 | Q1/Q2：游客+1健康1超时、物化与24h重放 | SC001/005/006 |
| US2 | FR008–021（共享策略/授权跨故事复验） | Q3/Q4：两Profile两设备、停止/重启恢复、内容变化 | SC002/005/008 |
| US3 | FR022–028、FR035–037共用过渡 | Q5/Q7：finish、下一集独立授权、单后继、手势拒绝 | SC003/005/006/008 |
| US4 | FR029–032、FR033–038换源分支 | Q6/Q7：两源carry、候选冲突、保存失败、取消赢家 | SC004/005/006/008 |
| US5 | FR033–040全局收口 | Q9/Q7：20次导航、1s退出、身份ABA、无主后继回收 | SC005/006/007/008 |
| Final | 全部尤其FR007/013/039 | Q8迁移恢复/配额回收；真实环境及视觉 | SC001–008 |

## Generation Summary / Validation

- 任务总数：**91**；US1=14、US2=15、US3=16、US4=10、US5=6。
- Setup=6；Foundational=15；Final=9；标记[P]任务=22，仅供同ready wave并行。
- 全部任务保持未勾选；每项有连续ID、精确文件路径、故事阶段正确标签及前置依赖，生成时校验无前向依赖/环。模型枚举、唯一/复合FK、可空、长度及数值约束在相应schema/领域任务中逐字引用，不留给实现者自选。
- 测试任务的“先失败”不要求故意破坏代码：先让新增场景对未实现能力合理失败，随后实现；运行/真机环境不足即保留未完成，不生成假证据。
