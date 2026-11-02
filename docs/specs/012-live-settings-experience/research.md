# Research: 012-live-settings-experience

**Date**: 2026-11-01 | **Status**: Complete（全部未知项已定案；无遗留 NEEDS CLARIFICATION）
**Input**: [spec.md](spec.md)（含 Clarifications Q1–Q3）、仓库现状勘察（apps/web/src 与 apps/server/src/contexts/live-tv）

> 总结论：012 是**收敛验证型规格**——005（T043/T053/T054 统一意图链路、T067/T068 直播、T116/T117 节目单、T086 设置布局）、006（身份切换隔离）、009（非阻塞播放面）、010（点播与偏好）已交付绝大部分机制。本规格的研究任务是核对现状、指出缺口与接线点，而不是发明新机制。

## R1: 统一播放链路与播放意图——复用 ActionCoordinator，直播入口补接线

- **Decision**: 播放链路、意图保存与恢复**完全复用** `app/action-coordinator(.core).tsx` 的既有状态机（intentId/returnTo/entry、generation 代次守卫、`sanitizeReturnTarget` 白名单防开放重定向、「选档完成前零 /playback/ 请求」、取消登录/选档废弃暂存播放意图）。规格 FR-005/FR-006 的实现载体即 `usePlayAction`。本规格唯一的新增工作是：核对并完成**直播入口的接线**——`features/live/components/GuestActionNotice.tsx` 头注明示「US5 阶段播放入口为占位，播放统一接入 US3 的 usePlayAction（本阶段未接线）」，其登录按钮 onPress 为空占位；NowHero 已用 PlayButton（统一入口）。任务需逐入口（NowHero/NowSection/NextSection/GroupSections/EPG 频道观看按钮）核实实际路径，把占位升级为真实意图调用。
- **Rationale**: 意图机制已被 005 接受并交付（含代次守卫、防重定向、身份撤销收口 T079），重新发明会产生第二套链路，违反「所有播放入口一条链路」的规格目标本身；澄清 Q2（应用会话内存态）与现有实现天然一致——意图本就保存在 reducer 内存中，不写浏览器存储。
- **Alternatives considered**:
  - 新建独立的「播放意图服务」——否：与 ActionCoordinator 状态机重复，双链路语义分裂。
  - 意图持久化到 sessionStorage——否：Q2 已定案应用会话内；刷新重新点击即可。

## R2: 节目详情面板统一——两处现役组件收敛为同一行为契约

- **Decision**: 现状存在两个节目详情载体：`features/live/components/ProgrammeSlotDialog.tsx`（直播侧）与 `features/epg/ProgrammeDetailPanel.tsx`（节目单侧）。统一策略：**提取共享面板组件**（建议落点 `features/shared-programme/` 或 `shared/ui/`，规划任务阶段定名），两处改为同一组件的两个宿主（右侧抽屉/浮层，底层页面保持可见），内容按规格 FR-013 六要素对齐；「当前节目/即将开始/EPG 来源打开同一类面板」以组件级单测 + 两条 e2e 断言。
- **Rationale**: FR-013 要求「同一类详情面板」；两套组件已各自实现相近 UI（005 US5/US6 分头交付），行为漂移正是本规格要消除的问题。共享组件是最小改动路径——不重写页面，只换面板内核。
- **Alternatives considered**:
  - 保留两组件、仅对齐行为断言——否：无法阻止未来继续漂移，验收成本翻倍。
  - 直接复用 ProgrammeDetailPanel 并删除 Dialog——备选，若勘察发现 Dialog 无直播特有逻辑可并入（任务阶段二选一，验收标准不变）。

## R3: 安静刷新——沿用 use-live-refresh，补「不打断」验收断言

- **Decision**: 刷新机制零改动：`use-live-refresh.ts` 已实现 30s 周期 + visibilitychange 回前台立即刷新 + 失败保留旧数据可重试（分区 hooks 内处理）。本规格工作是**补验收**：焦点不丢、详情面板不关、分页/筛选不重置（SC-003，≥10 分钟连续观察 + 单测模拟 refreshKey 递增断言 UI 状态不变）。刷新周期维持契约值 `LIVE_REFRESH_INTERVAL_MS=30_000`。
- **Rationale**: 机制已符合 FR-014 与 005 FR-022（「至少每 30 秒更新」契约下限）；改动它反而引入回归风险。规格 Assumptions 已声明 30s 为可调默认，SC-003 按观察法验收，不绑定数值。
- **Alternatives considered**: 改为轮询 delta 更新（只更新变化卡片）——否：现实现为 refreshKey 驱动重新拉取 + 查询缓存，TanStack Query 已做 diff 渲染，收益不明确。

## R4: EPG 状态保留——URL 状态已达成，「回到现在」与滚动恢复补齐

- **Decision**: `GuidePage` 已把 `date/from/channelPage/pageSize/view` 写入 URL 查询参数（FR-018 大部分已达成），非法参数回落缺省。本规格补齐三点：① 「回到现在」语义核对——恢复今天+当前时间窗口且**不清除**频道/分类筛选（FR-016）；② 滚动位置恢复——进 URL 不合适（高频变更），采用**应用会话内状态**（与 R1 同层），刷新后回到默认位置即可（URL 语义状态仍完整恢复）；③ 首次进入定位当前时间附近（现有 useGuideWindow 行为核对）。时区显示沿用 `guide-time.ts`/`live-format.ts` 的家庭时区语义（@internationalized/date，UTC 坐标轴 + DST 真实日长），零改动。
- **Rationale**: URL 状态是 005 已接受的公共浏览状态契约；滚动属高频瞬态，写入 URL 会造成历史污染与抖动，与「日期/筛选可分享」的意图分层一致（语义状态可分享、视口状态会话内）。
- **Alternatives considered**: 滚动位置写 URL（scroll 参数）——否：参数噪音 + 恢复精度差；全程 sessionStorage——否：Q2 口径（应用会话内存优先，不新增存储面）。

## R5: 设置分组——扩展模块注册表元数据，呈现层重组

- **Decision**: `features/settings/settings-modules.tsx` 的 `SettingsModuleMeta` 增加 `group: 'personal' | 'household' | 'system'` 分组字段与作用范围标注；`SettingsLayout` 左侧菜单按组渲染（个人偏好 / 家庭管理 / 系统），家庭管理组标注「需要管理授权」（解锁门 `settings-unlock-gate` 既有逻辑不动）。七个子模块映射：account→账号组?——按规格 FR-024 三组定义：个人偏好（本期无新增项，Q1「分组先行」：确有支持才显示，当前评估**可能零项→整组隐藏**）、家庭管理（profiles/policy/sources/epg/devices + general 的家庭区域）、账号与系统（account + 关于帮助）。路由 `/settings/{key}` 七条不变，仅布局分组视觉变化。
- **Rationale**: 注册表已是「导航/标题/页面单一事实源」（T131 注释），加元数据是最小改动；澄清 Q1 定案不新增偏好项，避免个人分组出现空模块（SC-007）。设置访问验证（unlock-gate）归 011 替代关系，本规格不触碰其判定逻辑。
- **Alternatives considered**:
  - 新增 /settings/preferences 路由页——否：无支持偏好项，空页违反 FR-024/SC-007。
  - 把 011 的任务流/验证重构提前并入——否：越界，012 只做布局分组（spec 边界）。

## R6: 无新 ADR 论证——授权链路为零新语义

- **Decision**: 不新增 ADR。理由：① 播放授权链路（登录→选档→PIN→服务端授权、授权前零媒体流）是 005 已接受并交付的语义，本规格是**接线与验证**；② 设置分组与详情面板统一是呈现层重组，不涉原则五所列重大结构/业务边界/不可逆选型；③ 设置访问验证规则明确让位给 ADR-0011 与 011 的替代关系（规格 FR-023/边界）；④ 零迁移、零新端点、零跨上下文变更。实施中若发现必须改动授权判定或新增服务端裁决，即为触发宪章原则五门禁的信号——先停、先补 ADR。
- **Rationale**: 宪章原则五要求「重大结构设计、业务边界调整或不可逆技术选型」须有 ADR；本计划逐项核对均不命中。规格 Related ADRs 已预声明此判定路径。
- **Alternatives considered**: 为「意图保存」单独立 ADR——否：005 契约已覆盖（returnTo 白名单、代次守卫），非新决策。

## R7: 焦点/键盘/响应式——沿用既有 token 与弹层惯例

- **Decision**: 焦点环几何沿用 `shared/theme/tokens.css` 的 `--hmp-focus-ring-*`（:root 级，010 已修复 light 主题回退问题）；焦点可见、Escape 关闭恢复触发焦点、弹层至多一层等行为遵循 009 修正案 A 与 a11y.css 既有规则；键盘方向移动/Enter/Space 在卡片与列表项上按既有 ChannelTile/GuideWall 模式核对补齐。断点与折叠（窄屏收拢侧栏）按现有 PublicLayout/SettingsLayout 响应式类扩展，数值遵循 DESIGN.md/既有 token，不发明裸值。
- **Rationale**: 宪章第 8 条要求语义 token 与既有基线；009 已沉淀弹层焦点管理惯例（挂载/关闭/返回）。
- **Alternatives considered**: 引入新的焦点管理库——否：既有实现足够且已验收。

## R8: 服务端零改动评估——复用矩阵与缺口清单

- **Decision**: 评估结论为**零新增端点、零迁移**。复用矩阵（详见 [contracts/api-reuse.md](contracts/api-reuse.md)）：live/groups、live/channels、media/:id/programmes、public/guide（日期/窗口/分页参数已支持）、/me/favorites/channels、auth/session、playback 授权链。缺口核对：直播播放入口所需的授权端点与 005 既有 playback 链一致；「播放该频道当前直播」的 resolve 语义已由 005 US3/US5 覆盖。若任务实施中发现缺口，按 plan 门禁先核对 005 契约同步义务再最小补充。
- **Rationale**: 规格全部 FR 均为前端行为与既有服务面消费；后端改动会把本规格拖入迁移/回滚/契约重审的高成本路径，且无需求支撑。
- **Alternatives considered**: 为「按类型浏览」新增分类聚合端点——否：现有 groups 端点已承载频道分组（GroupSections 现役）。

## R9: 点播与设置的边界执行

- **Decision**: 点播入口不改造、不纳入本规格验收、不触发 010 回归（澄清 Q3）——tasks 不得包含改写 OnlineVodDetailPage/MediaDetailPage 播放链路的任务（其既有 usePlayAction 消费即视为合规）。设置任务流（保存/草稿/验证合并）全部归属 011，本规格设置任务仅限分组/标注/布局行为与 FR-026–FR-029 的交互规则核对，且不得预实现 011 的验证模型。
- **Rationale**: 澄清定案 + 规格 Assumptions 边界；跨规格改动会造成 011 的替代关系与验收基线混乱。
- **Alternatives considered**: 顺手统一设置访问入口为 011 模型——否：011 尚 Proposed，提前实现未接受模型违反宪章原则一。
