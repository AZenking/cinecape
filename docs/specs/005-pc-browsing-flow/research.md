# Research: PC 公开浏览与观看操作流程

日期：2026-10-26；状态：Proposed。以下为设计研究，不是运行验收。依据 spec.md 五项澄清与宪章 1.2.0，未修改源代码、依赖或数据库。

## R1 — 采用公共、个人、播放、设置四个服务边界

**Decision**：公共元数据统一 `/api/public/*`，使用服务端唯一 Household 上下文及现有资源可用性集合，不进入 ProfilePolicy；`/api/me/*` 由当前有效会话推导 Profile；播放保持现有完整授权；管理统一 `/api/settings/*`，增加设置授权守卫。身份选档所需最小数据留在 `/profiles`，不开放管理 DTO。

**Rationale**：当前 CatalogController 类级 SessionGuard 和 EPG 的 Profile 授权链与新浏览规则不相容；直接移除守卫仍会触发服务层拒绝，而且可能误公开管理字段。新的只读投影可以复用 available-media 和 EPG 关联核心而不复用身份授权前置。

**Alternatives considered**：在旧目录接口加入 anonymous=true（身份语义混杂）；游客伪造默认成人会话（违反身份信任源）；只改前端守卫（后端仍拒绝）。最终不保留旧目录契约作为兼容通道。

**Evidence**：CodeGraph 返回的 `catalog.controller.ts`、`session.guard.ts`、`profile.controller.ts`、`database/schema.ts`；旧契约 003/004。来源禁用、跨家庭、不存在仍不可用；公开响应不返回 `canPlay` 策略结果、位置或票据。

## R2 — 初始化与首档案分为两个事务流程

**Decision**：`POST /setup/initialize` 只创建 Household/Account，201 不发会话或设备、不自动登录。随后普通登录。无档案时仅开放 `/auth/bootstrap-profile`：owner+当次密码+name+6 位数字 PIN，在短事务内重验零档案，创建唯一成人主 Profile 与默认策略；不自动激活，之后仍选择/解锁。

**Rationale**：当前 SetupController 在创建家庭后 registerDevice/issueSession/setSessionCookie，必须明确移除；不能靠前端清 cookie 假装不自动登录。首建需解决“没有主档案又必须进入设置才能创建主档案”的循环。

**Alternatives considered**：初始化顺带建主档案、自动成人档案、零档案时绕过全部设置守卫；均不采用。首建冲突返回 409，不改写现值。

## R3 — 主档案、默认档案与 Account 管理角色分别建模

**Decision**：Profile 新增 `is_main` 与 `pin_version`；主档案为唯一 active adult 且有 PIN，默认档案 `is_default` 不代表主档案。首建后事务保持恰好一个主档案，主档案转移验证目标已有 PIN，并在一次事务内切换标识、递增 Household `main_profile_version`、撤销所有设置授予。不能清除现任主档案 PIN，必须重设或先转移主档案。

**Rationale**：Account 仍是管理员权限来源；同家庭 owner 会话可以被儿童使用，仅检查 role 不足。切换到主档案仍走正常选档 PIN，不直接授予设置访问。

**Alternatives considered**：以 `is_default` 或 adult 识别管理员（身份混淆）；引入多账号或新管理员角色（本轮不需要）。

## R4 — 服务器持久化设置授予，固定十五分钟

**Decision**：`settings_access_grant` 每 DeviceSession 最多一行；服务端按会话定位，不向浏览器另发管理 bearer。固定 `expires_at=issued_at+15min`，GET、刷新、返回及修改不续期。保存 `profile_context_version`、`pin_version`、`main_profile_version` 快照，每次设置读取/写入重验；改档 A→B→A 不能复活旧授予。

**Rationale**：只比较最终 activeProfileId 无法察觉中途换档；只在客户端缓存 unlocked 容易绕过；内存存储会使正常刷新以外的服务重启行为难审计。

**Alternatives considered**：localStorage 授权、用选档解锁授予代替、滑动 TTL、长效家长态；不采用。敏感写仍当次验证账号密码，密码验证不缓存。

**Security details**：PIN 验证和选档共享持久失败计数，5 次锁 5 分钟。哈希比对在事务外；比对结束后短事务重新核对密码/PIN 版本、会话、当前档案和授权快照，再提交。错误不能泄露明文、hash 或来源凭据。密码修改撤销全部旧会话；PIN变更撤销相关全部授予与选档解锁授予，并在同事务清空使用目标档案的active contexts、递增身份版本、终态化相关播放及撤票，要求重新选档。

## R5 — PIN 恢复是窄用途例外，不是设置后门

**Decision**：`POST /auth/main-profile/pin-recovery` 只接受当前 owner 账号密码和新 6 位 PIN；允许在未选主档案或 PIN 锁定时使用，仍要求有效账号会话与账号密码锁定规则。目标由服务器确定，不接受任意 profileId。成功只重设 PIN、清 PIN 锁定、递增版本、撤销旧授予，不返回一般设置数据；之后重新选档及验证设置 PIN。

**Alternatives considered**：要求旧 PIN 才能恢复（死锁）；登录后直接进入全部设置（扩大权限）；匿名凭用户名重置（不允许）。

## R6 — 个人历史与临时播放会话分离，续播使用服务端代次

**Decision**：独立 `profile_viewing_history`，复合键 Household/Profile/Media；`profile_progress_clock` 按 Profile 单调分配 candidate epoch；点播 resolve 接受时写 `playback_progress_state` 但不创建可见历史。首次有效 `started` 观看上报才领取该媒体历史写入权。较新 candidate epoch 起播后，旧 session 仍可播放，但其后续进度不再覆盖此媒体的续播位置。

**Rationale**：仅首次字节交付不足以证明实际开始观看；客户端 `playing` 是观看遥测，服务端仍独立验证会话、资源、代次和位置。用客户端时间排序可被时钟漂移与伪造破坏；取 max(position) 会阻止用户向后定位和从头播放。

**Alternatives considered**：读取设备播放审计作为历史（权限、保留周期与业务不符）；在 resolve 时建立历史（准备失败也被算观看）；多个设备的位置求最大值或合并（违背用户主动回退）。本期“最新观看活动”精确定义为较新有效起播意图持有写入权，并由该 session 的后续有效样本更新时间，不抢夺其他设备的媒体播放权。

**Ordering**：每 session 的 sampleSeq 单调递增，与 playback version/generation 独立；相同最新序号且相同规范化载荷重试不重复写，相同最新序号不同载荷 409，小于最后接受序号返回 applied=false。必须匹配当前 generation；seek 前迟到上报不能覆盖 seek 后进度。不同媒体各有独立历史 owner。

**Resource identity**：`media_item.content_revision` 只在真实媒体文件内容变化时递增，不因改标题或分类变化递增。已保存进度的 revision 不匹配新资源时禁止续播、允许从头；旧资源播放不能更新新资源历史。

## R7 — 续播从服务端历史解析，停止与最终进度原子提交

**Decision**：resolve 增加 `startMode=beginning|resume`，无客户端 profile/position 授权声明；NAS 完成可信probe后、任何转换输出启动前读取当前 Profile 最新有效进度并对可信 duration 校验，冻结本次 startPosition，经现有 presentationStartSeconds/timelineOffsetSeconds 安装。不存在有效进度时从头，UI 不展示无效继续按钮。直接媒体在可播放前定位；转换从冻结目标逻辑位置准备输出，避免先播放零点再跳转。ready提交只重验身份和输入修订，不改已准备输出的offset；期间跨设备新进度不导致偷偷换位置。准备失败不改原历史。

**Decision**：新增 `/playback/sessions/{id}/progress`，首次started按原sampleSeq/payload重试直到确认，确认前暂停或周期样本排队而不越过首次样本；未确认即退出时空stop并提示未保存，不能伪造final。首次started确认前禁用或排队会改变generation的用户seek/重建音轨操作，确认后再执行，避免原generation重试永远失败；取消/空stop仍可操作。每 10 秒及暂停时上报；heartbeat 仍为既有 15 秒存活语义，不把旧 heartbeat 位置自动当成个人历史。stop 增加可选 finalProgress，在同一短事务先验证和保存后终态化。重复 stop 不重写历史、不复活会话。退出/换档先尝试最多 1 秒 flush，再改变身份，失败提示未同步且保留最后确认位置；旧身份切换后不能补写。卸载 keepalive 只是补充，周期保存是主要异常恢复保障。

**Alternatives considered**：先 stop 后请求 progress（终态守卫会拒绝）；点击从头播放立即删除旧进度（准备失败会丢失历史）；把详细页旧位置直接当起播位置（跨设备变化无法反映）。probe后冻结位置前重读最新历史；输出准备期间及已ready后的新设备活动不偷偷改变冻结位置，首次播放后按epoch竞争写入权。

## R8 — 直播与 EPG 使用批量关联及有界窗口

**Decision**：复用 manual 优先、manual 失效不自动回退、否则自动精确关联的既有语义，提取不包含 ProfilePolicy 的关联解析核心。来源发布同事务保留 `source_entry.group_title`，主分组取启用 present 条目按 sourceId/entryId 排序的第一个非空分组；缺失为其他，不按名称猜测。

**Decision**：频道每页默认 20、最多 50；guide 时间窗口一次覆盖所选日历日（跨度上限即该日真实日长，普通日 24 小时）、最多返回 2000 节目，超出要求减少频道页，不静默截断。客户端按选中家庭日期遍历，查询窗口与当日边界相交。当前节目的边界为 start<=now<end，重叠取 startsAt 最近者、相同开始按不透明 programme key 排序；next 取 startsAt>now 的最早项。直播每 30 秒刷新；服务端返回 now/timezone/revision，避免依赖浏览器本地时区。

**Rationale**：200×48×7=67,200 条排期可以本地持久保存，但不能一次渲染全部节目。按日分页加频道分页即可满足本轮规模（单页 20 频道 × 全天 48 档 ≈ 960 节目，低于 2000 上限），无需新增复杂 EPG 依赖；无 EPG 频道保留频道卡片和播放入口。

**Alternatives considered**：逐频道请求（N+1）；一次全量节目墙（DOM/载荷无界）；引入 Planby（讨论稿仅候选，许可和运行未核验，不作为本轮依赖）。公开 programme key 使用家庭内媒体/节目生成不透明 key，不返回上游 XMLTV 标识或源 ID。

## R9 — HeroUI v3、PC 响应式与可访问节目墙

**Decision**：以当前锁文件 HeroUI React/Styles 3.2.6、React 19.3.1、React Router 7.18.4 为研究基线，实施时锁定并核验导出，不随 package.json 的 latest 盲升。继续 Tailwind v4，不增加另一套通用 UI 库。

**Decision**：统一受控 Modal 状态机承载初始化/登录/首建/选档/PIN，避免多模态叠加；密码仅表单内存，关闭即清除。公共导航采用路由链接；Profile 操作用 Dropdown。表单使用 Form/TextField/Label/Input/FieldError，aria 校验时应用自行阻断不合法提交。

**Decision**：EPG 使用有界二维滚动、固定频道列和时间头，节目为可访问按钮，并提供同数据的按频道列表视图；本轮不伪装成已完成 ARIA grid 键盘模型。1024～2560 CSS px 自适应网格，768 窄窗、600 高度、200% 缩放使用收拢导航和内部滚动。设置宽屏左菜单右主体，窄屏可收拢菜单。

**Primary sources（本次研究已查阅，非浏览器实现证据）**：

- [HeroUI Modal](https://heroui.com/en/docs/react/components/modal)：Backdrop 控制开合、Container 管理尺寸与内部滚动，Dialog 标题及焦点语义。
- [Form](https://heroui.com/en/docs/react/components/form)、[TextField](https://heroui.com/en/docs/react/components/text-field)：复合字段与验证行为。
- [Dropdown](https://heroui.com/en/docs/react/components/dropdown)、[Tabs](https://heroui.com/en/docs/react/components/tabs)、[Select](https://heroui.com/en/docs/react/components/select)、[Button](https://heroui.com/en/docs/react/components/button)。
- [ScrollShadow](https://heroui.com/en/docs/react/components/scroll-shadow)：溢出提示不是虚拟化或网格导航。
- [Theming](https://heroui.com/docs/react/getting-started/theming.mdx)：统一语义 token、Tailwind 先于 HeroUI 样式。
- [WAI-ARIA Grid Pattern](https://www.w3.org/WAI/ARIA/apg/patterns/grid/)：不能仅添加 grid role 而缺少 roving focus 与方向键等完整行为。

**Alternatives considered**：HeroUI v2 API、额外 provider、一次性手写全部基础组件、页面独立颜色体系，不采用。`frontend-home-live-epg-design.md` 为未接受设计建议；与本规格冲突的无续播、EPG 3 小时和 Planby 候选不覆盖本次澄清。

时区运算使用直接依赖 `@internationalized/date@3.12.4`，不依赖HeroUI间接提升；采用CalendarDate与toZoned显式compatible策略逐日转换，不能用固定24小时。该版本不导出startOfDay。官方依据：[CalendarDate](https://react-aria.adobe.com/internationalized/date/CalendarDate)、[时区转换](https://react-aria.adobe.com/internationalized/date/CalendarDateTime#to-a-zoneddatetime)。研究仅验证日期计算示例，未形成完整功能验收。

## R10 — 新数据代际，禁止静默清库或维护两套流程

**Decision**：保留现有 0001～0005 历史迁移和核心代码，在全新空业务库上应用新的 0006_pc_experience；它只允许未初始化的空业务库进入新 schema generation 2。旧已初始化数据库在任何写连接/WAL或迁移元数据创建前只读预检并拒绝，明确提示使用新DATA_DIR，不自动升级、重置或删除。标记使用 SQLite user_version，不新建无 Household 归属的业务表。

**Rationale**：用户免除历史业务数据兼容，不要求删除原始媒体，也没有授权本次规划清理任何现有库。保留旧数据目录与离线备份，可显式回退镜像/数据对；不能把新库直接交给旧镜像声称无损回退。

**Recovery**：在独立临时库做空库 up/down/up 与新代际的备份恢复；已初始化新库的 schema 回退仅在停服备份后演练，重新启用采用已匹配版本备份恢复。恢复后撤销 settings grants，活动播放标 interrupted；原媒体文件不变。宪章1.2.0中本轮明确豁免的是旧库数据迁移，不是新版本数据一致性、幂等与恢复验证。

## R11 — 测试与运行预算

**Decision**：保留 Vitest/Supertest 与 runtime-smoke，多加前端 Vitest + Testing Library、Playwright 的 PC 流程测试；这些是后续计划新增依赖，本次不安装。Playwright Chromium/Firefox/WebKit 作为自动化，真实 Chrome/Edge/Safari 仍需对应运行证据，不把 WebKit 自动化等同于 Safari。

**Budget**：目标数据 200 频道、500 点播、67,200 排期；public 查询只读本地库，不触发上游下载。guide 单响应上限 2000 节目/2 MiB，DB 批量查询不按频道线性增加次数（目标<=8 次）；200/500 基线下全新页面可交互 3 秒、切日/回现在 2 秒，20 次至少 19 次达标。家庭内同时浏览基线 5 个浏览器；保留现有转换并发默认 1。

**Protection/observability**：公共读取按真实连接 IP 每分钟 120 次，guide 每分钟 30 次，429 带 Retry-After；不信任未配置反向代理的 forwarded header。个人进度每设备每分钟 60 次，单体 JSON<=16 KiB；既有播放限频保留。只记录请求 ID、模板路由、耗时、结果码、查询数/响应字节和授予/进度 applied 原因；不得记录 query ticket、密码、PIN、源 URL、路径或明文会话。保持本地日志，无外部遥测。

**Reliability**：公共区与个人区独立失败；10 秒周期进度+停止最终提交满足异常恢复目标，断网显示最后确认值。SQLite 写事务短且无外部 I/O，读 EPG 使用同一同步快照；启动 readiness 必须确认 schema generation 2，不能把缺表解释为空列表。

## Research completion

无未解决的技术选型问题。上述均为 Proposed 决策，等待相关 ADR 与规格接受；时区日界算法与数据字段的最终权威见 data-model.md 和 contracts/api.md。本文件不把原阶段测试结果当作本阶段证据。
