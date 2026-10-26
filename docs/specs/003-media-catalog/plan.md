# Implementation Plan: 媒体目录与来源

**Branch**: master（实际 Git 分支；003-media-catalog 为功能标识） | **Date**: 2026-10-23 | **Spec**: [spec.md](spec.md)
**Status**: Implemented & Verified（2026-10-24；阶段 3 实现完成并按 quickstart 取得验收证据，详见 [evidence.md](evidence.md)。ADR-0007 已于实施前接受。阶段 4（设备能力匹配、播放 URL、真实播放）另行规划）
**Input**: 已接受的规格 003，含 magi EPG 设置精简迁移及六条已记录澄清。

**2026-10-24 增补**：手动 EPG 匹配设计已追加，状态 Proposed/待实现；上方 Implemented & Verified 仅指原范围。新增任务 T066～T075 未执行，不能用基线证据覆盖增补。

## Summary

在现有单服务内增加来源管理、持久刷新任务、真实目录与 EPG 展示。来源下载/扫描结果先进入私有暂存，校验和异常确认后单事务发布；查询从真实资源生成 MediaPolicyFacts，复用阶段 2 策略核心。名单编辑加入资源归属及乐观并发校验。IPTV/NAS 身份、25% 缺失确认和 NAS 替换权限重置均按规格执行。

## Technical Context

- **Language/Version**: TypeScript strict、Node 24、pnpm@11.28.5（沿用仓库锁定）。
- **Primary Dependencies**: NestJS 12、Drizzle/better-sqlite3、zod、React 19、React Router 7、HeroUI v3、Tailwind v4；拟新增 sax 流式 XML 解析及类型，版本实施时锁定。HTTP/HTTPS、DNS、zlib、fs 使用 Node 内置能力。
- **Storage**: 本地 SQLite WAL；显式 SQL 成对迁移；暂存与任务同库且全部带 Household；不存密码到任务。
- **Testing**: 既有 Vitest/Supertest + 新规则/迁移/真实来源夹具；真实 HTTP/浏览器、ARM64/AMD64 容器。109 用例仅是阶段 2 历史基线，不能代替本次检查。
- **Target Platform**: Docker/Linux NAS，单进程提供 API 和 SPA，NAS 媒体只读挂载。
- **Project Type**: pnpm monorepo Web 服务。
- **Performance Goals**: 10000 条目录连续 20 次搜索/翻页，至少 19 次页面展示 ≤2 秒；记录硬件、数据集、刷新并发条件；初始 512 MiB 容器冒烟预算沿用，不宣称压力保证。
- **Constraints**: 无外部云强依赖；不引入独立队列/数据库/Worker；目录不下发播放 URL；不实现播放器、转码、自动 EPG 匹配工作台、定时任务或实际 magi 配置搬迁。
- **Scale/Scope**: M3U 20000 条/10 MiB，XMLTV 500000 节目/解压 128 MiB，NAS 每来源 100000 文件。详细时间/字节/队列上限见 [research.md](research.md)。

## Constitution Check

### Phase 0 前

| 门禁 | 结论 |
| --- | --- |
| 规格已接受、既有 ADR 对齐 | 通过：完成澄清及门禁说明后再次请求规划，记录为接受；ADR-0002/0005/0006 继续适用 |
| Household → Account → Profile | 设计约束明确：来源/媒体为 Household，观看者为服务端 activeProfile，管理目标不成为观看授权来源 |
| 默认拒绝与核心解耦 | 复用 evaluatePolicy；无前端事实授权；媒体导入不自动将未知评级变为安全等级 |
| NAS、本地隐私、轻量交付 | 单服务/SQLite/只读挂载，不新增云强依赖 |
| 多层验收/回滚 | 作为实施必需门禁列入 quickstart，不提前标记通过 |

### Phase 1 后

复核数据模型的复合归属约束、任务与目录发布事务、读权限过滤、地址边界和回滚；无宪章豁免。技术未知项已在 research 给出决定，无未解决业务澄清。本轮设计产物完成，ADR-0007 在基线实施前已接受；本次新增 ADR-0008 为 Proposed，手动匹配正式实现前须接受它并通过 tasks/analyze，不把本设计宣称为已满足编码门禁。

## Project Structure

### Documentation

```text
docs/specs/003-media-catalog/
├── spec.md
├── plan.md
├── research.md
├── data-model.md
├── contracts/
│   ├── openapi.yaml
│   └── api.md
├── quickstart.md
└── checklists/requirements.md
```

本命令不生成 tasks.md。设计方案与原子发布决策另记录 ADR-0007。

### Source Code（拟修改，尚未执行）

```text
apps/server/src/
├── modules/sources/       # 来源配置、owner 验证、刷新查询控制器
├── modules/catalog/       # 列表/详情/家长候选、ResourceReader、元数据修改
├── modules/epg/           # XMLTV 暂存/节目查询与来源关联校验
├── modules/imports/       # 单执行器、M3U/NAS 适配、暂存/差异/原子发布
│   ├── safe-http-reader.ts
│   ├── m3u.parser.ts
│   ├── xmltv.parser.ts
│   └── nas-scanner.ts
├── modules/policy/        # 批量读取上下文、名单事务；保留纯判定核心
├── database/              # schema + 0003_media_catalog/{up,down}.sql
└── config/                # MEDIA_ROOTS、精确 LAN 许可及导入技术预算
apps/web/src/
├── pages/                 # MediaCatalog、MediaDetail、Sources；延伸 ProfilePolicy
├── components/            # 来源表单、任务状态/待确认摘要、资源选择器
└── lib/                   # API 契约绑定、会话切换后请求废弃
packages/shared/           # 独立 catalog-schema.d.ts 生成与导出、错误码
apps/server/test/          # 单元/契约/迁移/导入安全/运行时回归
```

**Structure Decision**：沿用函数式服务与 Nest 控制器，不做全仓架构重写；引入少量显式接口（可信资源读取、受控下载、扫描适配器），便于真实夹具和时钟/网络失败测试。

## 主要流程

### 来源与 EPG 设置

来源管理页展示 IPTV/EPG/NAS 类型、启用、版本、最近成功和任务状态。编辑 EPG 只有名称、地址、启用；IPTV 表单可选同 Household EPG，关联禁用 EPG 允许但提示暂无节目。所有写入和刷新要求 owner、当前请求主账号密码、格式/目标/版本校验；密码验证后重验会话，防异步验证期间撤销。

配置地址省略保持现值，替换必须新完整地址，脱敏掩码禁止提交。NAS 根通过只读部署 MEDIA_ROOTS 给出 rootKey，不开放任意服务器路径；既有 NAS 来源不允许修改根域，换根建新来源并禁用旧源。

### 刷新与确认

POST refresh 带 expectedVersion 与 operationKey → 同事务创建任务、获取来源部分唯一锁 → 202 返回任务 id → 单执行器异步有界读取/解析/暂存 → 差异与异常判定。格式非法失败，成功空快照必须确认（有非空基线时）。25% 缺失用 missing/currentPresent，不能用历史所有行做分母。

普通有效结果自动发布；异常结果 awaiting_confirmation，摘要只含数量与稳定错误码。确认/丢弃重新验证家长及 job.version；来源 version、家庭 catalog revision 或快照 digest 失效则 409 stale，不重用旧确认。NAS 确认前再核对 root 授权与暂存文件大小/mtime；已变化则 stale 重扫。待确认 24h 到期清除暂存，任务只保留脱敏统计。重启 queued/running 变 interrupted，前端可重试，不自动继续。

网络/文件 IO 不在数据库写事务内；发布事务中只处理已暂存数据与约束。后台任务不保存明文密码，自动发布前重验发起会话/设备仍有效。全局排队上限和有界解析防止后台任务耗尽 NAS。

### 目录与授权

新建资源事实适配器按 (householdId,mediaId) 查询 media/entry/source，派生启用可用性；媒体详情和节目查询经过 SessionGuard 与 authorizeCurrentProfile 后返回 DTO。列表新建批量上下文读取，单次同步读取快照内加载有效会话/档案/策略及候选，调用同一 evaluatePolicy，再搜索、标题/id 排序、计数和分页；不逐条 await 造成 N+1，不在授权前计算计数。

客户端切换 Profile 后取消旧请求，返回前仅接受仍对应当前会话代次的响应；不复用上个 Profile 的目录/节目缓存。无档案/损坏策略明确错误，不伪装空结果；跨家庭/不可见详情统一 404。

### 名单与 NAS 替换

家长候选 POST 查询每次带 ownerPassword（不创建长期家长令牌），可查家庭不可见/不可用媒体，返回已授权管理需要的标题/类型/可用性，不返回文件路径或播放地址。新增独立名单 PUT；三类名单去重、上限、每 ID 归属、频道类型、expectedVersion 同事务检查。现有等级 PUT 不改变名单，二者共享 version。

NAS 同路径 size/mtime 变化：同一发布事务改事实、contentLevel=null、所有 Household Profile 的 allowedMediaIds 移除该 ID，保留 blockedMediaIds，每个有名单变化的档案只加一次 version。大小和 mtime 相同的替换是已接受局限。读取最新损坏策略导致发布失败，不能带着旧允许项继续。

## Phase 0 / Phase 1 Outputs

研究选择与替代方案见 research；全部字段/状态/约束见 data-model；外部契约见 contracts；验证步骤见 quickstart。需求追溯：FR-001/004/016/017→数据模型；FR-002/005/014/015→导入/原子发布；FR-003/009/011/012/022→授权与名单；FR-006/007/008/013→目录/EPG；FR-018～021→来源 UI 与契约。SC-001～009 均在 quickstart 有对应实测层级。

## 实施阶段建议（非任务清单）

1. 接受 ADR-0007，生成 tasks 与 analyze；先落失败规则/迁移契约测试。
2. 0003 schema/迁移/回滚与共享类型，扩展就绪表清单和测试夹具；迁移回填既有家庭，新家庭初始化事务插入 catalog_state。
3. 受控导入适配、持久刷新任务和原子发布（含 EPG 窗口发布）；先验来源侧闭环，观看目录可见性待下一步目录接口完成再验。
4. 真实目录 ResourceReader 与授权过滤、EPG 精确关联；同时扩展名单和文件变化事务。
5. HeroUI 来源/目录/详情/人工元数据编辑/名单 UI 联调，复用现有家长弹窗；无播放按钮。
6. 临时库升级/回滚、109 既有用例回归、新安全矩阵、真实 HTTP/浏览器、双架构容器和性能证据，满足后流转 Verified。

## Complexity Tracking

无宪章例外。新增 sax 是单一解析依赖；单执行器和有界暂存满足当前单实例部署。限制：100000 文件扫描及 SQLite 大事务持锁时间需测量；若 SC-005 不满足，先优化批量查询/索引，不擅自增加外部服务。待确认快照存敏感位置，必须在私有 DATA_DIR 下、24h 到期清理，日志只含脱敏摘要。

## 阶段 3 增补：手动 EPG 匹配（2026-10-24）

### 参考与边界

magi 的 UpdateManualEpgBindingUseCase 校验来源/频道配对和 expectedVersion，EpgMatchDialog 支持搜索、选择、清空和锁定，ApplyEpgMatchUseCase 跳过锁定项。借鉴用户能力和锁定保护，不复制其全局候选查询、独立的 canonical 更新事务或 Ant Design 组件：redRoad 必须额外验证 Household、当次家长身份和原子版本写入。这里保存即锁定，不设置可被自动覆盖的 unlocked 手动状态；仅显式解除恢复自动。

### 服务与 UI

扩展现有 modules/epg，不新增工作台路由。新 manual-epg-binding.service.ts 处理候选、管理读取与版本写入；epg.service.ts 先读手动绑定，manual 存在则唯一尝试该目标，invalid 时不回退；auto 模式再执行原来源级匹配。普通节目接口只新增 bindingMode/bindingStatus/invalidReason，隐藏管理目标身份；所有观看请求仍先授权。无节目但目标存在时 bindingStatus=valid、current/next=null。

Sources 页面来源信息和频道详情/家长候选选择器复用一个 EpgBindingDialog.tsx：选择同家庭 EPG 来源、搜索频道 ID/名称、分页和当前/下一节目预览、显示当前手动/自动与失效原因、选择保存或解除。被观看策略隐藏频道从已验证家长候选打开同一对话框，不绕过普通详情授权。读取、每次候选查询、保存和解除均要求当次密码，不建立长期家长模式；提交后清空密码，失败保留非敏感选择。

### 一致性与导入接线

新表保留 manual/auto tombstone，初始不存在 version=0，首次保存为 1，解除递增不删除行，避免旧 version=0 请求在解除后误成功。绑定版本独立于 media.version（导入无需无故使编辑失效）。保存还检查候选 epgGeneration；在每次 EPG 成功发布事务中递增对应来源 epg_generation，排除候选查询后指南已变化的旧请求。绑定保存/解除与 catalog revision+1 同事务，待确认导入基线因此失效并要求重扫；刷新任务绝不更新/删除绑定表。

目标 XMLTV ID 不建指向可被窗口替换删除的 epg_channel 外键，只对目标 media_source 做家庭复合外键；保存时校验真实频道存在，读取时派生 invalid。IPTV 默认来源换成其他 EPG 不改手动绑定；家长可主动重选任一同家庭启用 EPG。候选已禁用或 conflicted 不可新建，已有配置失效时仍可查看/解除。重启后配置持久，目标恢复自动恢复有效（仅派生状态变化，不变更绑定版本）。

### 交付与验收

新增 0004_manual_epg_binding，禁止修改已经实施的 0003 SQL。先迁移/契约失败测试，再服务、节目优先级与发布 generation 接线、UI、真实 HTTP/浏览器和迁移证据。保留全部原任务标记及历史验收，追加 SC-010 证据并在新范围完成前不宣称整个扩展 Verified。变更接口生成类型在未来实施任务执行，本轮只更新 OpenAPI 文档，不生成仓库源文件。
