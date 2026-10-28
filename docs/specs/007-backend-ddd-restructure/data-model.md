# Data Model: 007-backend-ddd-restructure

**性质说明**: 本规格为纯结构对齐，**领域数据实体零变更**——Household / Account / Profile / 内容策略 / 媒体目录 / EPG / 直播 / 播放 / 个人数据等既有实体的字段、关系与持久化结构（迁移 0001–0006）完全不变（证据基线见 [contracts/external-http-invariants.md](./contracts/external-http-invariants.md)）。本文件定义的是本次重组的**结构实体**。

## 1. 结构实体：职责层（Layer）

| 层 | 目录 | 职责 | 允许依赖 | 框架导入 |
|---|---|---|---|---|
| 领域层 domain | `<context>/domain/` | 实体、值对象、领域服务、领域事件、端口接口（interface） | 仅本层与内建类型 | **禁止**（纯 TS） |
| 应用层 application | `<context>/application/` | 用例编排、事务边界、端口消费 | domain + 本层 | **禁止**（纯 TS，经令牌注入） |
| 基础设施 infrastructure | `<context>/infrastructure/` | Drizzle 仓储、NAS/ffmpeg/HTTP/时钟适配器，实现端口 | application/domain + platform 基础设施 | 允许 |
| 接口层 interface | `<context>/interface/` | controller、DTO、上下文内守卫、请求/响应装配 | application（经端口）+ interface 公共件 | 允许 |
| 上下文装配 | `<context>/<context>.module.ts` + `index.ts` | Nest module 装配；**唯一对外发布点** | 全部内层 | 允许 |

依赖方向不变量：`interface → application → domain`，`infrastructure → application/domain`；**任何逆向边都是违规**。`platform/` 各子目录被所有上下文依赖，自身不依赖任何业务上下文。

## 2. 结构实体：限界上下文（Bounded Context）

| 上下文 | 目录 | 来源模块 | Nest Module（装配后） | 主要内聚职责 |
|---|---|---|---|---|
| 身份与账号 | `contexts/identity-access/` | auth、household | IdentityAccessModule | 账号、设备会话、令牌、引导/初始化、Household |
| 档案 | `contexts/profile/` | profile | ProfileModule | Profile、PIN、选档、身份切换 |
| 内容策略 | `contexts/policy/` | policy | PolicyModule | ProfilePolicy 规则与计算 |
| 媒体目录 | `contexts/media-catalog/` | catalog、public-catalog | MediaCatalogModule | 目录管理、公共投影与浏览 |
| EPG | `contexts/epg/` | epg | EpgModule | 节目单、手动绑定、导览窗口 |
| 直播 | `contexts/live-tv/` | live | LiveTvModule | 频道分组、投影、时段 |
| 播放 | `contexts/playback/` | playback | PlaybackModule | 解析、票据、授权、转码、流交付 |
| 个人数据 | `contexts/personal-data/` | personal | PersonalDataModule | 收藏、历史、进度、签名游标 |
| 设置 | `contexts/settings/` | settings | SettingsModule | 管理设置、访问授予与再验证 |
| 来源与导入 | `contexts/sources/` | sources、imports | SourcesModule | 来源配置、刷新执行/暂存/发布、m3u/xmltv/NAS 解析 |
| 平台横切 | `platform/` | common、config、database、health | PlatformModule（+各子模块） | 配置、数据库与迁移、HTTP 横切件、就绪端点 |

## 3. 依赖矩阵（审计规则的事实来源）

| 从 \ 到 | domain | application | infrastructure | interface | 其他上下文 | platform | @hmp/shared |
|---|---|---|---|---|---|---|---|
| domain | ✅ | ❌ | ❌ | ❌ | ❌ | ❌ | 仅类型契约 |
| application | ✅ | ✅ | ❌（经端口） | ❌ | ❌ | ❌ | 仅类型契约 |
| infrastructure | ✅ | ✅ | ✅ | ❌ | ❌ | ✅ | ✅ |
| interface | ✅ | ✅ | ❌（经端口/令牌） | ✅ | 仅发布入口 | ✅ | ✅ |

补充规则：(a) 跨上下文 import 的落点必须是该上下文 `index.ts`（发布入口）；(b) `platform/http-common` 中守卫/过滤器/管道为接口层公共件，可被各上下文 interface 使用；(c) `@hmp/shared` 在 domain/application 中仅允许类型与常量导入。

## 4. 迁移映射（文件组级）

| 现路径 | 目标层 | 分类依据（代表性文件） |
|---|---|---|
| `modules/auth/{password,token,session,device,parent-verification,setup,bootstrap}.service.ts` | identity-access / application（密码哈希、令牌签发等涉及加密库者视对外部库的依赖归 infrastructure，映射表在 tasks 落实到文件） | 用例编排 |
| `modules/auth/db.ts` | identity-access / infrastructure | 直连存储 |
| `modules/auth/{auth,setup,bootstrap}.controller.ts`、`account-session.dto.ts`、`validation.ts` | identity-access / interface | 请求装配与校验 schema |
| `modules/household/household.{controller,service}.ts` | identity-access（controller→interface，service→application） | 同上 |
| `modules/profile/{profile,profile-selection,pin}.service.ts`、`identity-transition.ts` | profile / application+infrastructure（PIN 加密归 infrastructure） | 规则与编排 |
| `modules/profile/profile.controller.ts` | profile / interface | — |
| `modules/policy/{policy.service,policy.rules,policy.batch-context}.ts` | policy / application（rules 中纯规则函数归 domain） | 策略计算 |
| `modules/catalog/{catalog,catalog-admin}.service.ts` | media-catalog / application | 编排 |
| `modules/catalog/resource-reader.ts` | media-catalog / infrastructure | 外部读取 |
| `modules/catalog/catalog.controller.ts` | media-catalog / interface | — |
| `modules/public-catalog/{public-catalog.service,public-media-projection}.ts` | media-catalog / application（投影纯函数归 domain） | 公共浏览投影 |
| `modules/public-catalog/public-catalog.controller.ts` | media-catalog / interface | — |
| `modules/epg/{epg,manual-epg-binding,catalog-revision,guide-window}.service.ts` | epg / application | 编排 |
| `modules/epg/{binding-core,guide-calendar,live 相关纯函数,programme-key.mapper,guide-problems}.ts` | epg / domain | 纯规则/映射/错误定义 |
| `modules/epg/public-guide.controller.ts` | epg / interface | — |
| `modules/live/{live-grouping,live-projection,live-grouping.service,live-projection.service}.ts` 等 | live-tv / domain+application（纯分组/投影函数→domain，服务→application） | — |
| `modules/live/live.controller.ts` | live-tv / interface | — |
| `modules/playback/playback.repository.ts`、`nas-reader.ts`、`conversion-storage.service.ts`、`ffmpeg-subtitle-extract.ts`、`media-probe.service.ts` | playback / infrastructure | 存储与外部适配 |
| `modules/playback/{playback-authorization,playback-plan,playback-selection,playback-resolver,playback-ticket,playback-lifecycle,playback-assets,playback-subtitles,playback-rate-limit,conversion-supervisor,conversion-watchdog,playback-retention,playback-audit}.service.ts` | playback / application（涉及 ffmpeg/存储者归 infrastructure，逐文件判定） | 编排与状态机 |
| `modules/playback/playback.types.ts` | playback / domain | 领域类型 |
| `modules/playback/{playback,playback-stream}.controller.ts`、`playback-readiness.guard.ts` | playback / interface | — |
| `modules/personal/{favorites,history,progress-write,progress-clock}.service.ts` | personal-data / application（时钟端口实现归 infrastructure） | 编排 |
| `modules/personal/signed-cursor.ts` | personal-data / domain | 纯算法（签名）——若依赖加密库则 infrastructure，逐文件判定 |
| `modules/personal/me.controller.ts` | personal-data / interface | — |
| `modules/settings/*.service.ts`（含 `settings-owner-password.ts`、`settings-access-revocation.ts`） | settings / application+infrastructure | 编排与凭据 |
| `modules/settings/settings-access-grant.service.ts`、`settings-pin-verification.service.ts` | settings / application | 授予与再验证 |
| `modules/settings/settings-*.controller.ts` | settings / interface | — |
| `modules/sources/sources.{service}.ts`、`source-target.validation.ts` | sources / application+interface | — |
| `modules/imports/{refresh-executor,refresh-publish,refresh-staging}.service.ts` | sources / application | 刷新编排 |
| `modules/imports/{m3u,xmltv}.parser.ts`、`catalog-diff.ts`、`nas-scanner.ts`、`safe-http-reader.ts` | sources / infrastructure（纯解析函数若零依赖可归 domain，逐文件判定） | 外部读取与解析 |
| `modules/health/*` | platform / health | 平台就绪端点 |
| `common/session.guard.ts`、`current-profile/`、`same-origin/`、`settings-access/`、`rate-limit/rate-limit.{decorator,guard}.ts`、`problem-json.filter.ts`、`logging.interceptor.ts`、`response-headers/`、`strict-input/`、`current-session.decorator.ts` | platform / http-common | 接口层横切 |
| `common/rate-limit/{rate-limit.service,rate-limit.policies}.ts` | platform / http-common（应用语义，随横切件就近放置并在 ADR 记录归属） | 限流策略与服务 |
| `common/rate-limit/client-ip.util.ts` | platform / http-common | 基础设施 |
| `common/domain-error.ts`、`common/log-redaction.util.ts` | platform / http-common（domain-error 为跨上下文错误契约） | 错误契约与日志脱敏 |
| `common/common.module.ts` | 拆并入 platform 各子模块后删除 | — |
| `config/{env.schema,env,import-budgets,playback-budgets}.ts` | platform / config | 环境与预算 |
| `database/{database,migrate,precheck,schema}.ts`、`migrations/` | platform / database（**文件内容零修改，仅随目录归位**；`package.json` 迁移脚本路径不变） | 存储基础设施 |
| `main.ts`、`app.module.ts` | 组合根（原地保留，仅更新装配导入） | 入口 |
| `test/unit/**`、`test/contract/**` | 测试随导入路径机械更新；`runtime-smoke.mjs`、迁移脚本不变 | 证据资产 |

> 逐文件到层的最终归类在 tasks.md 的各上下文任务中以映射核对表落实并经审计验证；上表为组级规划，含「逐文件判定」项的判定标准：文件若 import 加密/文件系统/网络/驱动库即 infrastructure，纯函数与类型即 domain，其余编排在 application。

## 5. 领域实体（未变更，仅供边界核对）

Household / Account / Profile / ProfilePolicy / 媒体目录条目 / EPG 节目单 / 直播频道 / 播放票据与进度 / 收藏与历史 / 来源与刷新批次——全部保持既有定义、归属与隔离规则（宪章核心原则二）；本次仅移动承载它们的代码，不改其任何语义。
