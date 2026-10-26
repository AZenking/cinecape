# Implementation Plan: PC 公开浏览与观看操作流程全面调整

**Branch**: `master`（实际Git分支；功能标识 `005-pc-browsing-flow`，路径不依赖分支） | **Date**: 2026-10-26 | **Spec**: [spec.md](spec.md)

**Input**: `docs/specs/005-pc-browsing-flow/spec.md`，包含五项用户澄清。

**Status**: Accepted（2026-10-26 维护者随规格 005 一并接受本计划与 ADR-0010～0012，Phase 0研究与Phase 1设计作为实施基线；实施进度以 tasks.md 勾选为准，不因接受而视为已验证）

## Summary

以新PC观看流程替换旧登录优先骨架：公共首页/目录/详情/直播/EPG匿名可浏览；播放与个人数据要求有效账号会话和当前Profile；设置要求Account管理权限、当前主Profile和独立15分钟PIN授权，敏感修改仍逐次验证账号密码。收藏、历史与跨设备续播以Profile隔离。

前端沿用React/Vite/HeroUI v3，拆公共布局、设置布局及认证/播放意图协调器；后端增加公共投影、个人数据与设置授权模块，复用来源、策略、EPG匹配和受控播放内核。新增持久进度代次/样本序号，防止多设备、seek与stop竞态覆盖；EPG按频道页及时间窗批量读取。不保留旧路由、旧契约或历史业务库兼容，不自动删除任何用户数据。

## Technical Context

**Language/Version**: TypeScript strict，Node.js >=24；pnpm 11.28.5。以当前锁文件为基线，不在规划中升级。

**Primary Dependencies**: React 19.3.1、React Router 7.18.4、Vite 7、Tailwind CSS 4、HeroUI React/Styles 3.2.6、hls.js 1.7.3；NestJS 12、zod 4、Drizzle 0.44/better-sqlite3。计划新增直接依赖 `@internationalized/date@3.12.4` 处理家庭时区日界（现锁文件有传递依赖），不引入Planby、其他UI库、全局状态库、微服务或外部云服务。

**Storage**: 本地SQLite WAL；新0006_pc_experience，schema generation 2，仅全新空业务库；新增收藏、历史、Profile进度时钟、播放进度状态、设置授予；具体字段见data-model.md。

**Testing**: 复用Vitest/Supertest及runtime-smoke；计划加入前端Vitest/Testing Library、Playwright自动化。真实Chrome/Edge/Firefox/Safari仍保留PC验收矩阵。当前只做文档结构、契约引用和类型可生成性检查，不声称运行测试通过。

**Target Platform**: PC浏览器；服务端继续Docker/Linux NAS单实例、单Household、本地数据。尺寸1024/1280/1440/1920/2560×768/1080 CSS px；768窄窗、600高、200%缩放做降级检查。手机专版、TV遥控器和原生客户端不在本轮。

**Project Type**: 既有pnpm monorepo的前后端Web应用整体调整，保留apps/web、apps/server、packages/shared边界。

**Performance Goals**: 200频道、500点播、每频道每天48节目、7天共67,200排期；首个可操作视图<=3秒、切日/回现在<=2秒，20次至少19次达标；家庭基线5个并发浏览器。进度周期<=10秒，正常停止跨设备位置误差<=5秒、异常中断丢失<=15秒；不改变004转换起播时限。

**Constraints**: 无源位置/票据泄漏，公开浏览不执行ProfilePolicy但播放始终执行；七个设置模块需实际可用。设置15分钟固定不续期，5次PIN错误锁5分钟；选档与设置授予独立。单guide默认20/最多50频道、<=6小时时间窗、<=2000节目/2MiB。新版本一致性、备份和恢复仍必须验证，旧业务数据无损迁移不在范围。

**Scale/Scope**: spec FR-001～048、US1～8、SC-001～010；基础点播目录继续可用但不展开独立点播产品设计；不增加录制、预约、回看、推荐算法、自动续播起播或新编解码范围。

## Constitution Check

*GATE: Phase 0前检查，Phase 1后复查。文档规划与业务实现分别判断，不能将Proposed设计写成已接受或已验证。*

| 原则 / 门禁 | Phase 0前 | Phase 1后 |
| --- | --- | --- |
| 规格先行、已接受ADR方可实施 | PASS（本轮仅用户授权的规划；spec为Proposed） | 设计产物齐全；实现门禁关闭，需接受spec/本计划/ADR-0010～0012 |
| Household→Account→Profile、显式家庭边界 | PASS（保留身份分工） | PASS（复合FK/个人键/服务端上下文、主档案不等于管理员） |
| 公共浏览与播放分离 | PASS（宪章1.2.0明确允许） | PASS（public白名单，playback完整授权，me隔离，所有媒体资产仍受控） |
| 设置服务端验证与生命周期 | PASS（不缓存密码验证） | PASS（grant/context/PIN/main版本、固定TTL、逐次密码、bootstrap/recovery窄用途） |
| NAS、本地隐私、无强制云依赖 | PASS | PASS（单服务+SQLite，本地日志，不引入外部遥测） |
| 一致性、幂等、迁移与恢复 | 宪章1.2.0已明文限定005/代际2例外 | PASS设计：仅旧业务数据迁移/保留及旧契约兼容豁免；ADR-0012记录实现方案，不创建豁免；新版本恢复/回滚要求保留 |
| 多层证据、负向测试与文档同步 | 需制定验证矩阵 | PASS设计：quickstart映射SC/FR；实现验收仍待执行，不复用旧Verified记录 |

本轮没有已执行的违宪实现或未解释的设计绕过。原模板“Accepted specification”是实施前门禁，不能因用户调用plan而擅自把Proposed改Accepted；允许完成提案研究，禁止进入编码。若新增ADR或规格接受被拒绝，应停止相应实施，不以本计划豁免。

## Project Structure

### Documentation (this feature)

```text
docs/specs/005-pc-browsing-flow/
├── spec.md
├── delivery-constraints.md
├── plan.md
├── research.md
├── data-model.md
├── quickstart.md
├── contracts/
│   ├── api.md
│   ├── openapi.yaml
│   └── ui.md
└── checklists/requirements.md
```

新增ADR：docs/adr/0010-public-browsing-playback-separation.md、0011-main-profile-settings-access.md、0012-profile-resume-fresh-storage.md，均为Proposed。tasks.md须后续由speckit-tasks生成，本阶段不预建、不勾完成。

### Source Code (repository root, target structure)

```text
apps/web/src/
├── app/                    路由、Provider、action coordinator
├── layouts/                PublicLayout / SettingsLayout
├── features/
│   ├── auth/               配置、登录、首建、恢复
│   ├── profiles/           选档、PIN、切档
│   ├── home/               个人区+公共区
│   ├── catalog/            基础点播与公开详情
│   ├── live/               分类直播
│   ├── epg/                日期、频道页、时间窗、列表替代视图
│   ├── favorites/          当前Profile收藏
│   ├── history/            当前Profile历史与续播
│   ├── playback/           意图协调、播放器及progress队列
│   └── settings/           七模块页面与当次密码确认
└── shared/                 fetch底座、主题token、日期/通用UI
apps/server/src/
├── common/                 Session/CurrentProfile/SettingsAccess守卫、同源及错误过滤
├── modules/
│   ├── public-catalog/     可用媒体白名单、部署家庭上下文
│   ├── live/               公共直播批量投影
│   ├── epg/                提取纯关联核心、窗口查询、保留手动管理
│   ├── personal/           收藏、历史、进度时钟/写入
│   ├── settings/           grant、账号/家庭配置、主Profile转移
│   ├── auth/               认证、逐次密码、窄用途bootstrap/recovery
│   ├── profile/            选档最小接口、主档案约束
│   ├── playback/           原授权/转换/流；增加上下文绑定、resume/progress/final stop
│   └── sources/imports/    保留核心，管理加守卫/新路由、发布分组和content revision
└── database/               schema及0006迁移（后续实现）
packages/shared/src/        新005契约生成类型，消除旧默认契约歧义
apps/server/test/           unit/contract/runtime扩展
apps/web/test/              组件/意图状态机与PC浏览器场景（后续建立）
```

**Structure Decision**: 保留三workspace，不新建app。已有逻辑按业务迁入目标结构，允许复用正确模块；最终路由与API只有新默认流程，不能把新布局包一层就保留旧身份依赖。媒体内核保持分层，不把React状态带入领域规则。

## Phase 0 — Research Results

完整决定、替代方案与依据见research.md R1～R11。并行研究聚焦HeroUI v3官方文档/PC可访问布局、续播写入一致性/设置授权竞态；仓库结构直接用CodeGraph读取，不委派重复文件调查。关键结论：

- 不把游客伪装成默认成人会话；公共投影复用可用性与EPG关联，播放保留策略。
- 初始化现有自动登录须真正移除服务端发会话，而非前端忽略cookie。
- 选档和设置PIN为不同用途；设置grant与播放session都绑定身份contextVersion，防A→B→A复活。
- 跨设备进度用服务器candidate epoch与session sampleSeq，支持主动后退，首次playing确认后才建历史。
- resume在probe后、准备输出前冻结位置，ready提交不偷换已建输出offset；stop原子保存最终位置。
- HeroUI3.2.6使用v3复合组件和单Modal协调器；EPG为有界按钮/列表，不假称完整ARIA grid。
- 日期使用日历天转换而非固定24小时，测试DST23/25小时。
- 新代际空库交付，不做旧数据兼容；本次无删除或部署动作。

无待定技术选型占位；产品进一步改变范围时应回到spec澄清，不在实现中私自扩展。

## Phase 1 — Design

### 1. Frontend architecture

SessionProvider提供账号/当前Profile/server householdId/contextVersion；SettingsAccessProvider只缓存服务器expiresAt状态；公共浏览不等待会话恢复才能呈现。一个ActionCoordinator管理login→bootstrap/picker/PIN→play/favorite/settings，intentId负责取消与最新目标。SettingsLayout只在守卫通过后加载主体；个人模块各自query key与generation隔离，失败不拖垮公共首页。

无需引入Redux/Zustand/TanStack Query。使用统一typed fetch、AbortController、显式资源hooks与URL查询状态；复杂播放继续独立hook。计划新增前端测试工具，是验证工具而非生产状态依赖。主题使用现有语义token，锁定组件版本，实施前查官方组件文档和本地导出。

### 2. Backend architecture

PublicContext从唯一Household确定范围（零家庭返回未初始化，多个家庭属于配置损坏503）；public服务仅构造无身份投影。SessionGuard保持账号/设备信任，CurrentProfileGuard用于me和播放；SettingsAccessGuard验证持久授予及主档案。敏感写验证当次密码之后再检查会话和授权快照，避免await窗口竞态。

所有管理路由统一settings前缀，原鉴权/验证能力不丢失。Profile列表的公开于登录用户的最小选档摘要与管理读取区分。bootstrap和recovery只拥有单一用途，不读取普通设置主体；新API及guard详见contracts/api.md与openapi.yaml。

### 3. Data and transaction boundaries

模型详见data-model.md。Profile主标识、默认标识、Account角色分离；新settings grant固定TTL并持久保存失败计数；PIN改变清目标档案活动上下文并中断相关播放，设置与选档授予全部失效。

resolve事务分配candidate epoch、绑定profileContextVersion；实际playing的started ACK才使历史可见，未确认前后续样本排队/重试。较新意图有效起播后旧owner不能覆盖，但不抢占合法播放。原始duration与contentRevision由服务器提供，不信任客户端time/identity。正常停止finalProgress与终态在同事务，断网依赖最后已确认周期位置。

### 4. EPG and responsive delivery

关联解析遵循manual失效不回退。source_entry保留分组，新批量只读服务不重复单频道Profile授权；一请求冻结now/timezone/revision并按同步读快照构造。频道分页+时间窗限制DOM与载荷，Guide列表替代视图提供键盘可用性。

@internationalized/date@3.12.4直接声明服务器依赖（前端若使用也直接声明）；无startOfDay导出，使用CalendarDate和toZoned兼容策略转换日界。日期只有今天到+6，窗口与该日交集，跨日过期回今天。UI尺寸/焦点/返回行为见contracts/ui.md。

### 5. New storage generation and rollout

只支持空业务库执行0006进入generation2；旧初始化库显式拒绝并提示新DATA_DIR，自动清库禁止。保留历史代码/迁移作为追溯，不是旧API运行兼容。验证环境用独立临时库与受控源媒体；真实切换需匹配镜像/新数据目录、原库离线备份和明确重配置说明。此计划不运行上线或reset。

新版本备份恢复保留收藏/历史但撤销grant、旧活动播放中断，避免恢复旧授权；down演练不碰用户库。发布阶段旧镜像/旧目录作为成对回退，不把新业务库喂给旧版本。

### 6. Observability and bounds

公共服务只读本地数据，guide<=8次集合查询为目标，响应<=2000节目/2MiB。IP/public与DeviceSession/progress限频见research/API；写事务不含网络/哈希等待；不引入全量EPG渲染或持续无界缓存。

本地记录requestId、模板路由、耗时、状态、响应字节、批量查询数和稳定拒绝原因；禁止任何凭据/源位置/票据明文。性能结果记录测试硬件、浏览器、版本、数据规模和20次测量，目标不是已达成事实。

## Verification Strategy

| 规格范围 | 设计产物 | 证据要求 |
| --- | --- | --- |
| FR001～005、046 / US1 | public API、UI公共布局 | 全目录、失效cookie、公开字段白名单、跨家庭与匿名播放拒绝 |
| FR006～010、029～030 / US2 | setup/bootstrap/session/profiles | 未自动登录、零档案并发、PIN选档、取消/内部返回目标、恢复与失效 |
| FR011～014 / US3 | 004保留+005resolve/context绑定 | 浏览不等于播放、意图取消、旧ticket/旧context拒绝、原播放回归 |
| FR015～020 / US4 | favorites/history/progress/stop | 双Profile双设备、started ACK、epoch/seq乱序、后退seek、final原子、位置精度 |
| FR021～027 / US5～6 | live/guide/timezone与UI墙 | 时间边界、重叠、无节目频道、7天窗口、DST与家庭跨日、200频道性能 |
| FR028～041 / US7～8 | settings/bootstrap/recovery | 七模块实际读写、密码逐次、TTL/版本失效、直接越权、恢复用途和CAS |
| FR042～045 / SC009 | UI合同 | PC尺寸、缩放、焦点、返回状态、自动化加真实四浏览器 |
| FR047～048 / SC010 | 0006代际与ADR0012 | 旧库明确拒绝/不修改、空库闭环、临时库up/down/up、备份恢复、媒体不变 |

### Foundation gate and final release gate

T013与T144是不同完成信号。T013在Phase 1～2后仅证明工具链和基础骨架可用：
执行契约类型生成、lint、全workspace typecheck/build，以及明确列出的服务器基础、
前端组件、浏览器骨架冒烟。每类冒烟须有至少1个真实执行用例、全部通过，保留发现/
执行/通过数量。未实现管理功能保持拒绝，不能为了冒烟通过提前开放设置主体。
此阶段不要求尚未建立的业务用例、完整播放/设置/EPG和全量runtime先通过。

后续每个故事按TDD新增业务测试并通过其检查点。T144才执行完整verify:release：
全量server/web unit/contract/组件、PC E2E、runtime以及静态/构建检查，并核对
FR/SC覆盖与预期测试集合；各类测试必须非零执行，必需用例不跳过。真实四浏览器、
Network、性能、迁移恢复和T149真人验收同样必须留证。禁止把T013过滤清单、
零测试成功、passWithNoTests或临时skip/only带入最终门禁。

verify:foundation/verify:release为后续实施拟建立的独立脚本，本次只修文档，
不创建脚本、不运行上述业务验证、不标记任务或规格完成。

先静态契约/schema/type，后unit/contract，后独立runtime，最后PC Network/浏览器与恢复证据。原有004的真实硬件与镜像未验收项不因本规划自动完成；本轮保留其能力，未扩大硬件承诺。新增前端工具须在实施任务列出，不用现有后端测试冒充UI覆盖。

## Implementation Sequencing (not tasks.md)

1. 审阅并接受spec/计划/ADR0010～0012，明确旧规格替代范围并同步领域模型；不重写历史Verified事实。
2. 契约/共享类型与新代际结构、主档案/身份版本、设置授予及窄用途账号流程。
3. 公共投影与直播/EPG批量服务，个人收藏/历史/进度协议与受控播放衔接。
4. 公共/设置布局、单弹层协调器、基础目录与统一播放入口，再完成首页、直播、EPG及七模块。
5. 逐项unit/contract/runtime、数据恢复、真实PC与Network证据，最后规格Verified。

上述为依赖顺序而非已派发或完成的实施任务。首次16～22人日粗估未包含已确认跨设备续播的完整竞态实现和本计划所有验证细节，需在tasks生成后重估；此文不再次承诺工期。

## Complexity Tracking

无未解释的宪章例外。旧业务数据兼容豁免来自用户明确要求及宪章1.2.0的限定章节，ADR0012仅记录交付方案；不豁免新版本恢复验证。Proposed状态是实施前待接受门禁，不以复杂度表将其标作已通过。

| 设计复杂度 | 采用原因 | 更简单方案不可用的原因 |
| --- | --- | --- |
| 设置grant与多个版本快照 | 固定TTL、并发验证和换档失效 | 仅前端flag或最终Profile ID会复活旧授权 |
| 进度epoch+sampleSeq | 跨设备续播、后退与迟到重试 | max(position)和客户端时间不能正确表达新旧意图 |
| Public/Me/Settings分离 | 匿名元数据与私有数据安全边界不同 | 将全部旧管理/目录接口删守卫会泄漏或仍被服务层拒绝 |

## Design Review and Handoff

本次只读设计复查已处理：A→B→A旧播放复活、started确认丢失、ready后偷换转换offset、缓存缺家庭scope、PIN恢复后仍处于旧活动身份。修改后的契约与模型需在实施前继续由speckit-analyze检查跨产物一致性。

下一步：`$speckit-tasks` 可基于本Proposed设计生成待执行任务；业务实现前必须显式接受规格及相关ADR。不得自动创建功能代码、运行迁移或把任务标记完成。


## Planning Artifact Validation (2026-10-26)

- 005 OpenAPI：54条路径、62项操作、690处本地组件引用均可解析；operationId唯一、路径参数与公共/设置访问声明检查通过。
- 使用仓库openapi-typescript 7.13.0将005契约生成到 `/tmp/redroad-005-contract-types.d.ts`，并使用tsc进行独立类型检查通过；未覆盖packages/shared源码。
- 设计复查补充首次started确认前禁止/排队generation变更，避免旧generation重试死锁；取消/空stop仍可用。
- 文档链接、需求编号、澄清记录、Proposed状态及空白检查通过；Spec质量清单保持16/16，仅代表需求质量。
- 未执行业务测试、浏览器、Network、迁移、硬件或部署验证；所有运行成功标准仍待实施证明。


## Document Revision (2026-10-26)

依据首次speckit-analyze的12项发现修订文档：宪章升至1.2.0限定005/代际2兼容例外；
统一/vod与/media/:id；直播envelope补齐快照元数据；主档案转移增加现任版本；
区分settings/access入口与主体守卫及401/403/400；明确schema、布局、协调器、依赖和锁文件唯一所有者。
新增T145～T148覆盖真实导入分组写入和内容修订变化，T149单独覆盖SC-002真人完成率。
原T001～T144编号与未执行状态保留，共149任务；本节不是业务验收或规格接受记录。


## Foundation Gate Clarification (2026-10-26)

复分析B1已通过文档修订处理：T013明确基础工具链与三类非零骨架冒烟；T144统一承担
最终全量测试、FR/SC覆盖与多层证据验收；Phase 2检查点与quickstart保持一致。
本说明仅记录修订内容，不声称任何拟建脚本、测试或实现已经执行。
