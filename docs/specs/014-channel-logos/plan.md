# Implementation Plan: 直播频道 Logo 数据链路

**Branch**: 实际checkout=`master`；setup-plan报告的功能标识=`014-channel-logos`，未创建/切换Git分支。 | **Date**: 2026-11-07 | **Spec**: [spec.md](spec.md)

**Input**: `docs/specs/014-channel-logos/spec.md`（Proposed），包含14项需求与6项成功标准。

**Status**: 实施完成（2026-11-07）：Phase 0/1 设计经维护者 `/speckit-implement` 指令确认冻结（T001/T002，010 先例）后交付实现；US1–US5 服务端与 web 代码及自动化测试全绿（typecheck/lint/迁移 drill/边界/单测 2334/契约 12/web 428，逐项见 [evidence.md](evidence.md)）；验证中——真实环境运行时证据（T020/T024/T029/T035/T038，quickstart §4）Not-run，不满足 Verified。逐项证据见 [evidence.md](evidence.md)。

## Summary

让直播频道在「无节目海报是常态」的前提下获得频道身份主视觉：导入管线捕获 M3U `tvg-logo` 与 XMLTV 频道 `<icon>`，原始地址私有落库；发布事务内按「直播源优先、节目单源兜底」写出胜者注册表并把不透明引用写入既有 `media_item.poster_ref`（投影链路零改动即达前端）；新增公共同源代理端点按规格 010 海报代理口径有界取回；前端以「Logo → 现有渐变底板+首字」回退链渲染，EPG 时间轴保持纯文字。

关键设计：原始 URL 与胜者引用分离（源各自保留证据、发布时合并）；引用是随机不透明令牌且只在注册表可逆；替换旧引用走墓碑窗口（410「已失效」→ GC 后 404 同形）；代理字节不落盘、仅接受 image/*。技术依据及替代方案见[research.md](research.md)，模型及协议见[data-model.md](data-model.md)、[API](contracts/api.md)、[UI](contracts/ui.md)、[内部边界](contracts/internal-ports.md)。

## Technical Context

**Language/Version**: TypeScript ^5.8，Node >=24，pnpm 11（仓库声明，与 010 基线一致）。
**Primary Dependencies**: NestJS ^12、Drizzle ^0.44/better-sqlite3 ^13、Zod ^4；React ^19、HeroUI 3.2.x、TanStack Query ^5；复用 SafeUpstream 有界读取平台件与 010 海报代理既有口径。
**Storage**: 同部署 SQLite；新增 2 列（`source_entry.logo_url`、`epg_channel.icon_url`）+ 1 表（`channel_logo` 胜者注册表，含家庭外键与墓碑列）；`media_item.poster_ref` 复用既有列承载引用值。
**Testing**: Vitest 3、Supertest/Nest TestingModule、Testing Library、Playwright；迁移 up/down/drill 演练；真实浏览器与网络证据按宪章多层要求留证。
**Target Platform**: PC 浏览器；自托管 Docker/Linux NAS；单部署单家庭，全部表保留显式 `household_id`。
**Project Type**: NestJS 后端 + React Web + shared 契约的现有 pnpm workspace。
**Performance Goals**: 直播墙单页 ≤50 频道；代理端点在预算内（上游总期限 8s）完成或以稳定错误形态返回；引用解析为索引单查（查询次数不随频道数线性增长）。
**Constraints**: 无新增后台定时任务（墓碑 GC 在发布事务内集合执行）；公共响应不泄漏上游地址；字节不落盘；引用不可解码；不新增预算参数（沿用 010 口径数值）。
**Scale/Scope**: 2 个解析器扩展、1 条迁移、1 个公共端点、1 个前端组件 + 5 个接入点；5 个用户故事、14 FR、6 SC。

## Constitution Check

| Gate | Phase0前 | Phase1后 | 依据/后续动作 |
| --- | --- | --- | --- |
| 当前授权为设计，不编码 | PASS | PASS | 用户显式 `/speckit-plan`；仅文档变化 |
| Spec/新ADR已Accepted的实施前门禁 | **ERROR：spec 014 为 Proposed** | **ERROR：仍未通过** | 不自动接受；实现前须维护者确认接受。预计无需新 ADR（复用 010 已交付的「不透明引用+有界同源读取」模式，见 [research R3/R6](research.md)）；若实现发现越出该模式，按宪章原则五先补 ADR |
| Household/Account/Profile 隔离 | 设计约束通过 | 设计通过，负向证据待验 | `channel_logo` 显式 `household_id` 复合外键；引用解析校验家庭；Logo 为频道级公共属性，无 profile 维度、无个人数据 |
| 公开浏览/受控播放/设置再验证 | 设计约束通过 | 设计通过，契约负向待验 | Logo 与直播列表同口径游客可见（ADR-0010）；不触碰播放授权与设置 PIN；代理端点负向契约（伪造/跨家庭/墓碑/上游失败）见 [api.md](contracts/api.md) |
| DDD/仓储与跨界 | 需设计跨上下文发布路径 | 设计通过，实施前按 tasks 锚定 seam | 注册表归 media-catalog 域（`poster_ref` 本就是 media_item 身份列）；sources/epg 经既有事务参与者模式写入；live-tv 投影零改动；无跨上下文直读他域私有服务 |
| NAS/隐私与旧数据 | PASS | 设计通过，迁移证据待验 | 上游 URL 仅服务端私有列；字节不落盘；迁移 0009 含 down 配对与 drill；不继承 005 空库豁免 |
| UI基线与视觉入口 | 需核对当前宪章 | 设计约束通过，视觉运行待验 | Logo 为装饰性 `<img>`（非交互控件，不触宪章技术约束 5 的组件禁令）；底板沿用既有 token 渐变；实施前按 heroui-react 固定基线取组件/主题文档并记录日期 |
| 类型/测试/运行/迁移门禁 | 未运行 | 未运行，不宣称通过 | 文档规划不代替应用、设备或真实契约验收 |

模板「Accepted spec」条目是进入实现的硬门禁，本计划不将其豁免或标绿。无已知需要牺牲宪章原则的设计偏离。

## Project Structure

### Documentation (this feature)

```text
docs/specs/014-channel-logos/
├── spec.md              # 已有（Proposed）
├── plan.md              # 本文件
├── research.md          # Phase 0：R1–R10 决策
├── data-model.md        # Phase 1：列/表/约束/合并规则/生命周期
├── quickstart.md        # Phase 1：可运行验证指南
├── contracts/
│   ├── api.md           # 公共代理端点 + posterRef 语义注记 + 稳定错误形态
│   ├── ui.md            # 回退链组件契约与接入点、a11y、范围守护
│   ├── internal-ports.md# 发布参与者 / 引用解析 / SafeUpstream 复用
│   └── openapi.yaml     # 机器可读契约（gen:types 新增源）
└── checklists/requirements.md  # 已有（全通过）
```

### Source Code (repository root，未来实施路径)

```text
apps/server/src/contexts/sources/infrastructure/
├── m3u.parser.ts                  # R1：EXTINF 捕获 tvg-logo（解析层归一化，沿 group_title 先例）
├── xmltv.parser.ts                # R1：channel 帧捕获首个 <icon src>
apps/server/src/contexts/sources/application/
├── refresh-publish.service.ts     # IPTV 发布：胜者合并（iptv 必胜）+ 引用签发/墓碑
apps/server/src/contexts/epg/application/
└── epg 刷新发布路径               # EPG 发布：仅填补无 iptv 胜者的已绑定频道
apps/server/src/contexts/media-catalog/
├── application/logo.service.ts    # 引用解析 → 有界读取 → image/* 校验（R6/R7）
├── infrastructure/                # channel_logo 仓储 + 发布参与者扩展（既有 mirror 模式）
├── interface/                     # GET /public/media/logos/:logoRef（公共限频）
apps/server/src/platform/database/
├── migrations/0009_channel_logos/ # up.sql/down.sql：2 列 + 1 表
apps/web/src/features/
├── live/components/channel-logo.tsx  # R10：共享回退链组件（装饰性）
├── live/components/{ChannelTile,NowHero}.tsx、epg/GuideChannelList.tsx、home/personal-area.tsx  # 接入点
packages/shared/package.json       # gen:types 追加 014 openapi 源
docs/specs/005-pc-browsing-flow/contracts/openapi.yaml  # posterRef 语义注记增补（010 增补先例）
```

**Structure Decision**: 注册表与代理归 media-catalog 域（频道 Logo 是媒体身份属性，与 title/description/poster_ref 同族）；导入与 EPG 各自经发布事务参与者写入，读路径只有 live/catalog 既有投影（零改动）；前端共享组件一处实现多处接入。

## Phase 0 — Research closure

R1–R10 均已决策并记录 Rationale/Alternatives（见 [research.md](research.md)）：解析归一化沿 group_title 先例；原始 URL 落两列私有保存；胜者写时合并（iptv>epg）进 `channel_logo` 注册表；引用值复用 `media_item.poster_ref` 既有列（投影链路零改动）；墓碑窗口兑现 FR-006 的 410「已失效」；代理端点逐字镜像 010 海报代理安全边界（预算数值沿用、不新增参数），增加引用键控的短浏览器缓存以避免直播墙逐渲染回源。无遗留 NEEDS CLARIFICATION。

## Phase 1 — Design and contracts

1. 数据与合并规则：[data-model.md](data-model.md)——2 列 CHECK、注册表唯一键/外键/墓碑、胜者判定表、生命周期（absent→active→tombstone→deleted）、迁移与 drill。
2. 公共契约：[contracts/api.md](contracts/api.md) + [contracts/openapi.yaml](contracts/openapi.yaml)——端点授权、输入、稳定错误形态、缓存策略、posterRef 语义注记（005 openapi 增补，010 注释先例）。
3. UI 契约：[contracts/ui.md](contracts/ui.md)——回退链、加载/淡入、a11y、5 接入点、SC-006 范围守护断言。
4. 内部边界：[contracts/internal-ports.md](contracts/internal-ports.md)——发布参与者方法面、解析端口、SafeUpstream 复用、事务边界。
5. 运行指南：[quickstart.md](quickstart.md)——区分既有可运行检查与实现后新增场景，不伪造未存在的测试。

## Complexity Tracking

> 无宪章门禁豁免或已论证的复杂度偏离；本节留空。

| Violation | Why Needed | Simpler Alternative Rejected Because |
| --- | --- | --- |
| （无） | — | — |
