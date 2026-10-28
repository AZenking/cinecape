# Migration Map: 逐文件迁移映射核对表（T007）

**Feature**: 007-backend-ddd-restructure · **Task**: T007（细化 data-model.md §4 组级映射为逐文件映射）
**Date**: 2026-10-28 · **范围**: `apps/server/src` 全部 158 个文件（146 个 `.ts` + 12 个迁移 `.sql`），逐文件核对 import 语句后归类，无遗漏。
**范围核对备注**: T007 进行期间（2026-10-28 11:20）`src/contexts/{alpha,beta}/**`、`src/platform/{db,http}.ts` 共 12 个文件由 T002 审计工具工作流并发创建——系 dependency-cruiser 规则探针（故意构造 R1a–R4 违规的临时 fixture），**不属于迁移输入**，故不入表；须在 T006 空跑判定前删除或从规则路径域排除，且不得残留至 T019/T031（零遗留红线）。
**路径约定**: 下表「现路径」「目标路径」均相对 `apps/server/src/`；目标层为 `contexts/<ctx>/{domain,application,infrastructure,interface}/`、`contexts/<ctx>/<ctx>.module.ts`（装配）与 `platform/{http-common,config,database,health}/`。
**判定标准**（= data-model.md §4 脚注「逐文件判定」，逐文件实际核对 import）：

1. **interface**：controller / guard / decorator / DTO / 请求校验 schema / pipe。
2. **domain**：核对后零框架（`@nestjs`/`express`）零 IO 技术（argon2、node:crypto 哈希/签名职责、node:fs(/promises)、node:http(s)/dns/net、node:child_process、better-sqlite3、drizzle-orm、Database/getDb）的纯函数/纯类型/纯常量。
3. **infrastructure**：文件职责本质为技术适配——加密原语封装（argon2、以哈希/签名为核心的 node:crypto）、存储封装与仓储（Database/getDb/schema 直连为主体）、文件系统、网络、子进程（ffmpeg/ffprobe）、流式解析器。
4. **application**：用例编排/事务边界/状态机。现存 `drizzle-orm` 操作符、`getDb`、`@nestjs`、`express`、局部 `node:crypto` import 如实记为「渗漏」，按 tasks.md T022/T023（深导入与框架渗漏收口）处理——T023 的存在即以「US1 先按角色落位、US2 再净化」为设计前提。
5. **platform**：common / config / database / health 横切（data-model.md §4 既定）。

## 统计

| 项 | 值 |
|---|---|
| 总文件数 | **158**（`.ts` 146 + 迁移 `.sql` 12） |
| 组合根（原地保留） | 2（`main.ts`、`app.module.ts`） |
| platform | **42**（http-common 20 · config 4 · database 16〔4 ts + 12 sql〕· health 2） |
| domain | **12** |
| application | **45** |
| infrastructure | **21** |
| interface | **23** |
| 上下文装配 module | **13**（含 `common.module.ts` 拆并后删除） |

| 目标上下文 | 文件数 | 明细（domain/application/infrastructure/interface/装配） |
|---|---|---|
| contexts/personal-data | 7 | 0 / 4 / 1 / 1 / 1 |
| contexts/profile | 6 | 0 / 4 / 0 / 1 / 1 |
| contexts/policy | 4 | 1 / 2 / 0 / 0 / 1 |
| contexts/epg | 10 | 4 / 3 / 1 / 1 / 1 |
| contexts/live-tv | 8 | 4 / 2 / 0 / 1 / 1 |
| contexts/sources | 12 | 1 / 3 / 6 / 0 / 2 |
| contexts/media-catalog | 9 | 1 / 3 / 1 / 2 / 2 |
| contexts/identity-access | 17 | 0 / 6 / 3 / 6 / 2 |
| contexts/settings | 17 | 0 / 8 / 0 / 8 / 1 |
| contexts/playback | 24 | 1 / 10 / 9 / 3 / 1 |
| platform | 42 | — （http-common 20 / config 4 / database 16 / health 2） |
| 组合根 | 2 | — （原地保留，仅更新装配导入） |

### 与 data-model.md §4 / tasks.md T008–T019 组级预估的已识别差异（⚠ 标注于对应行）

1. **auth 服务拆分**：§4/T015 预估以 application 为主；逐文件判定 `password.service`（argon2）、`token.service`（node:crypto 令牌哈希核心）→ **infrastructure**，其余五个 service 保持 application。
2. **epg/catalog-revision.service**：§4/T011 预估 application；实测 better-sqlite3 句柄 + `Database.db.prepare` raw SQL 直连（文件主体即存储访问）→ **infrastructure**。
3. **playback/playback-lifecycle、playback-subtitles**：T017 组级列 application；实测 `node:fs/promises`（转换产物目录扫描 / 字幕文件发现）→ 按 T017 自带 carve-out「涉存储者归 infrastructure」改判 **infrastructure**。
4. **playback/hls-proxy.service**：T017 的 infrastructure 与 application 两个清单**均未列及**（tasks.md 缺口）；实测 `node:http/https/dns/net/stream` 上游代理 → **infrastructure**。
5. **personal/signed-cursor**：§4 预判「若依赖加密库则 infrastructure」；实测 `node:crypto` HMAC-SHA256 签名 + 密钥派生自 `Database.db.name` → **infrastructure**（与 T008「按 T007 判定」一致，无冲突）。
6. **live/live-grouping**：§4/T012 归 domain；实测 import `node:crypto`（sha256 生成不透明分组键，非加密用途）→ 维持 **domain**，但机械化审计若命中「加密库」需注入 hash 端口（T023）或 ADR 记录。
7. **epg/guide-problems**：§4/T011 归 domain；实测 import `@nestjs/common` `HttpException` 并继承（problem+json 载体）→ **domain 框架渗漏**，T023 需纯化为领域错误或改判 interface。
8. **sources/source-target.validation**：§4/T013 预估 interface；实测纯函数（`node:net` 仅 `isIPv6` 纯谓词，非 IO），且被 playback 侧 infrastructure（nas-reader/media-probe）消费——归 interface 将造成 infra→interface 逆向边 → 按「纯函数→domain」改判 **domain**。
9. **sources/refresh-executor、refresh-publish**：T013 归 application；实测 executor import `node:fs`（lstatSync 源探测）、publish import `Database`（发布事务 SQL）→ 维持 **application**（刷新编排/发布事务边界），渗漏待 T022/T023 收口。
10. **epg/guide-calendar**：归 domain；但 import 外部纯值库 `@internationalized/date`——§1「仅内建类型」口径下需 ADR 记录为允许的纯工具库。
11. **跨层/跨上下文渗漏（T022 收口清单）**：`common/domain-error`（→platform/http-common）被 `policy.rules` 等 domain 文件 value-import（domain→platform 边）；`binding-core`/`programme-key.mapper` value 复用 `live-projection.service`（domain→他上下文 application 边）；`auth/db.ts` 的 `getDb` 被全部 9 个业务上下文 30+ 文件消费——迁移后为最普遍跨上下文深导入，需将数据库句柄获取上移 `platform/database` 或改为上下文内注入；`session.guard`→auth `token.service`、`settings-access.guard`→settings 服务（http-common→业务上下文反向边）。
12. **auth/account-session.dto**：名为 DTO（T015 → interface），实测内含 `getDb` 查询与事务（DTO+装配混合体）→ interface + 渗漏记录。
13. tasks.md T012 文本将「live-grouping」重复列举两次（疑为 `live-clock` 笔误）；`live-clock.ts` 零 import 纯函数，本表已归 domain 覆盖。

---

## T008 ① contexts/personal-data（← modules/personal）

| 现路径 | 目标路径 | 判定依据 |
|---|---|---|
| modules/personal/favorites.service.ts | contexts/personal-data/application/favorites.service.ts | imports drizzle-orm、getDb(auth/db)、database/schema、policy.batch-context、live-projection.service、public-media-projection、signed-cursor —— 收藏用例编排；⚠ 驱动/getDb 渗漏（T022/T023 收口） |
| modules/personal/history.service.ts | contexts/personal-data/application/history.service.ts | imports drizzle-orm、getDb、schema、policy.batch-context、public-media-projection —— 历史用例编排；⚠ 驱动/getDb 渗漏 |
| modules/personal/progress-clock.service.ts | contexts/personal-data/application/progress-clock.service.ts | imports node:crypto（sha256 幂等摘要 progressSampleDigest）、drizzle-orm、getDb、schema；含端口接口（PlaybackProgressBindPort 等）；⚠ §4「时钟端口实现归 infrastructure」拆分预期，随 T008 整体落 application，渗漏收口 |
| modules/personal/progress-write.service.ts | contexts/personal-data/application/progress-write.service.ts | imports drizzle-orm、getDb、schema、progress-clock —— 进度写入状态机编排；⚠ 驱动/getDb 渗漏 |
| modules/personal/signed-cursor.ts | contexts/personal-data/infrastructure/signed-cursor.ts | imports node:crypto（createHmac/timingSafeEqual 游标签名为核心）+ Database（密钥派生自库路径）→ 加密库+驱动 → infrastructure（§4「若依赖加密库则 infrastructure」判定成立） |
| modules/personal/me.controller.ts | contexts/personal-data/interface/me.controller.ts | imports @nestjs Controller/Verbs/UseGuards、express、zod、platform 守卫与管道 —— 请求装配 |
| modules/personal/personal.module.ts | contexts/personal-data/personal-data.module.ts | 装配（更名 PersonalDataModule） |

**Module 装配说明**：`PersonalModule` → **`PersonalDataModule`**（更名，不合并）；原模块对 `ProgressClockService`/`ProgressWriteService` 的 exports 被 playback.module 消费（T017 步保持），上下文发布面在 T020 建 `index.ts`。

## T009 ② contexts/profile（← modules/profile）

| 现路径 | 目标路径 | 判定依据 |
|---|---|---|
| modules/profile/identity-transition.ts | contexts/profile/application/identity-transition.ts | imports drizzle-orm、database/schema、`type Db`(auth/db) —— 会话/档案切换事务边界（T009 既定 application）；⚠ 驱动渗漏，函数均以事务句柄为参 |
| modules/profile/pin.service.ts | contexts/profile/application/pin.service.ts | imports drizzle-orm、getDb、env、schema、password.service(verifyPassword) —— PIN 设置/校验/解锁编排；PIN 哈希经 password.service（→ identity-access/infrastructure），本文件无直接 argon2 |
| modules/profile/profile-selection.service.ts | contexts/profile/application/profile-selection.service.ts | imports drizzle-orm、schema、env、getDb、password/parent-verification 服务 —— 选档编排；⚠ 驱动/getDb 渗漏 |
| modules/profile/profile.service.ts | contexts/profile/application/profile.service.ts | imports node:crypto（randomUUID）、drizzle-orm、schema、getDb、pin/identity-transition、policy.rules —— 档案用例编排；⚠ 渗漏记录 |
| modules/profile/profile.controller.ts | contexts/profile/interface/profile.controller.ts | imports @nestjs、zod、SessionGuard/SameOriginGuard/StrictBodyPipe —— 请求装配 |
| modules/profile/profile.module.ts | contexts/profile/profile.module.ts | 装配（`ProfileModule` 名称不变） |

**Module 装配说明**：`ProfileModule` 名称不变，路径迁至 `contexts/profile/profile.module.ts`；`app.module.ts` 导入路径更新。

## T010 ③ contexts/policy（← modules/policy）

| 现路径 | 目标路径 | 判定依据 |
|---|---|---|
| modules/policy/policy.rules.ts | contexts/policy/domain/policy.rules.ts | imports 仅 DomainError(common/domain-error) 与 `ProblemCode`(@hmp/shared 常量) —— 纯规则函数（defaultPolicyValues、authorize 纯判定等），零框架零 IO → domain；⚠ DomainError 现位于 common（迁移后在 platform/http-common），domain→platform 违 §3 矩阵，T022/T023 收口（错误契约上移或改返回类型） |
| modules/policy/policy.batch-context.ts | contexts/policy/application/policy.batch-context.ts | imports drizzle-orm、schema、getDb、policy.rules —— 批量授权上下文装载（用例编排）；⚠ 驱动/getDb 渗漏 |
| modules/policy/policy.service.ts | contexts/policy/application/policy.service.ts | imports drizzle-orm、schema、getDb、parent-verification、profile.service —— 策略修改用例；⚠ 渗漏记录 |
| modules/policy/policy.module.ts | contexts/policy/policy.module.ts | 装配（`PolicyModule` 不变；现仅 `@Module({})` 空壳） |

**Module 装配说明**：`PolicyModule` 名称不变；注意 catalog/playback/profile 等上下文直接深导入 policy.rules/policy.service/policy.batch-context —— T022 收口为经 `contexts/policy/index.ts` 发布接口。

## T011 ④ contexts/epg（← modules/epg）

| 现路径 | 目标路径 | 判定依据 |
|---|---|---|
| modules/epg/binding-core.ts | contexts/epg/domain/binding-core.ts | `import type` @hmp/shared + value 复用 live-projection.service 的 `loadChannelAssociationCore`、live-time 的 `pickCurrentNext`（纯）+ 自有纯函数 `pickGuideCurrent`；⚠ value 依赖指向含 DB 实现的 live-projection.service —— T022 需将关联核心下沉 live-tv domain 或经发布接口 |
| modules/epg/guide-calendar.ts | contexts/epg/domain/guide-calendar.ts | imports 仅 `@internationalized/date`（纯日期值库，无 IO/框架）—— 纯日历窗口函数 → domain；⚠ 外部纯库入 domain 需 ADR 记录 |
| modules/epg/guide-problems.ts | contexts/epg/domain/guide-problems.ts | ⚠ imports `@nestjs/common` HttpException 并继承（409 problem 载体）—— 按 T011 归 domain，但为 domain 框架渗漏；T023 需纯化为领域错误（由 interface 层装配 HttpException）或改判 interface，以测试全绿+审计通过为准 |
| modules/epg/programme-key.mapper.ts | contexts/epg/domain/programme-key.mapper.ts | 单行 `export { programmeKeyOf } from '../live/live-projection.service'`（纯转发导出，无其他依赖）→ domain；⚠ 指向 live-projection.service（application）—— T022 将 programmeKeyOf 纯函数下沉 live-tv domain 后改经发布口 |
| modules/epg/catalog-revision.service.ts | contexts/epg/infrastructure/catalog-revision.service.ts | ⚠ imports `type DatabaseConstructor`(better-sqlite3) + `Database`，文件主体为 `Database.db.prepare` raw SQL 读/递增 catalog_state —— 存储访问为本职 → infrastructure（§4/T011 预估 application，按逐文件判定改判） |
| modules/epg/epg.service.ts | contexts/epg/application/epg.service.ts | imports drizzle-orm、getDb、schema、policy.rules/batch-context —— 节目单查询编排；⚠ 驱动/getDb 渗漏 |
| modules/epg/guide-window.service.ts | contexts/epg/application/guide-window.service.ts | imports drizzle-orm、getDb、schema、guide-calendar/guide-problems/catalog-revision/binding-core/programme-key.mapper —— 导览窗口用例编排；⚠ 渗漏记录 |
| modules/epg/manual-epg-binding.service.ts | contexts/epg/application/manual-epg-binding.service.ts | imports `type DatabaseConstructor`、drizzle-orm、schema、getDb、catalog-revision —— 手动绑定用例（事务内绑定+修订递增）；⚠ 渗漏记录 |
| modules/epg/public-guide.controller.ts | contexts/epg/interface/public-guide.controller.ts | imports @nestjs Controller/Inject、zod、@internationalized/date(parseDate)、RateLimit/StrictQueryPipe、live-clock —— 请求装配 |
| modules/epg/epg.module.ts | contexts/epg/epg.module.ts | 装配（`EpgModule` 不变；现 imports CommonModule） |

**Module 装配说明**：`EpgModule` 名称不变；common 收口（T018）后 `CommonModule` 导入替换为 `PlatformModule` 体系对应子模块。

## T012 ⑤ contexts/live-tv（← modules/live）

| 现路径 | 目标路径 | 判定依据 |
|---|---|---|
| modules/live/live-clock.ts | contexts/live-tv/domain/live-clock.ts | 零 import —— 纯时钟/墙钟函数 → domain |
| modules/live/live-time.ts | contexts/live-tv/domain/live-time.ts | imports 仅 `type ExperienceProgrammeDto`(@hmp/shared) —— 纯时间判定（pickCurrentNext 等）→ domain |
| modules/live/live-sections.ts | contexts/live-tv/domain/live-sections.ts | imports 仅 @hmp/shared type —— 纯分页/排序/分区名 → domain |
| modules/live/live-grouping.ts | contexts/live-tv/domain/live-grouping.ts | ⚠ imports `node:crypto` createHash（sha256 截断生成不透明分组键，非加密用途）+ 其余纯分组函数 —— 按 §4/T012 归 domain；审计若机械化命中「加密库」需注入 hash 端口（T023）或 ADR 记录，以测试全绿+审计通过为准 |
| modules/live/live-grouping.service.ts | contexts/live-tv/application/live-grouping.service.ts | imports live-grouping（纯）+ live-projection.service（DB 装载）+ @hmp/shared type —— 分组用例编排 |
| modules/live/live-projection.service.ts | contexts/live-tv/application/live-projection.service.ts | imports node:crypto、drizzle-orm、getDb、schema、live-time/live-grouping、policy.batch-context —— 频道窗口投影编排（含纯函数 programmeKeyOf）；⚠ 渗漏记录 |
| modules/live/live.controller.ts | contexts/live-tv/interface/live.controller.ts | imports @nestjs、zod、RateLimit/StrictQueryPipe、Database、catalog-revision.service —— 请求装配；⚠ Database 深导入渗漏（T022 收口） |
| modules/live/live.module.ts | contexts/live-tv/live.module.ts | 装配（`LiveModule` → **`LiveTvModule`**） |

**Module 装配说明**：`LiveModule` → **`LiveTvModule`**（更名）；现 imports CommonModule，T018 后替换为 platform 子模块导入。

## T013 ⑥ contexts/sources（← modules/sources + modules/imports 合并）

| 现路径 | 目标路径 | 判定依据 |
|---|---|---|
| modules/sources/source-target.validation.ts | contexts/sources/domain/source-target.validation.ts | imports 仅 `node:net` 的 `isIPv6`（纯字符串谓词，非 IO）—— NAS/远端目标纯校验规则 → domain；⚠ T013 预估 interface，但 playback infrastructure（nas-reader/media-probe）消费之，归 interface 将致 infra→interface 逆向边，按「纯函数→domain」改判（以测试全绿+审计通过为准） |
| modules/sources/sources.service.ts | contexts/sources/application/sources.service.ts | imports node:crypto（randomUUID）、drizzle-orm、schema、getDb、getConfig、parent-verification、refresh-executor、source-target.validation —— 来源管理用例编排；⚠ 渗漏记录 |
| modules/sources/sources.module.ts | contexts/sources/sources.module.ts | 装配（与 refresh.module 合并为 **`SourcesModule`**） |
| modules/imports/catalog-diff.ts | contexts/sources/infrastructure/catalog-diff.ts | imports `node:crypto` createHash（规范化 JSON 摘要/指纹为本职）→ infrastructure（T013 既定） |
| modules/imports/m3u.parser.ts | contexts/sources/infrastructure/m3u.parser.ts | imports node:stream(type Readable)、node:util TextDecoder、IMPORT_BUDGETS —— 流式解码解析器 → infrastructure |
| modules/imports/xmltv.parser.ts | contexts/sources/infrastructure/xmltv.parser.ts | imports node:string_decoder、node:zlib gunzip、node:stream —— gzip 流解析器 → infrastructure |
| modules/imports/nas-scanner.ts | contexts/sources/infrastructure/nas-scanner.ts | imports node:fs/promises、node:path —— 文件系统扫描 → infrastructure |
| modules/imports/safe-http-reader.ts | contexts/sources/infrastructure/safe-http-reader.ts | imports node:dns/http/https/net/stream —— 网络读取适配器 → infrastructure |
| modules/imports/refresh-staging.service.ts | contexts/sources/infrastructure/refresh-staging.service.ts | imports `type DatabaseConstructor` + m3u/nas/parser 类型 + catalog-diff —— better-sqlite3 句柄暂存持久化（存储为本职）→ infrastructure（T013 既定） |
| modules/imports/refresh-executor.service.ts | contexts/sources/application/refresh-executor.service.ts | ⚠ imports node:fs（lstatSync 源探测）、node:crypto、@nestjs(生命周期)、Database、getConfig、四个 parser/staging/publish —— 刷新流水线编排（T013 既定 application）；fs/驱动渗漏待 T022/T023 以端口收口 |
| modules/imports/refresh-publish.service.ts | contexts/sources/application/refresh-publish.service.ts | ⚠ imports node:crypto、@nestjs、`type DatabaseConstructor`、Database（发布事务 raw SQL）、catalog-diff/staging、policy.rules、xmltv type —— 发布事务边界（T013 既定 application）；驱动渗漏收口 |
| modules/imports/refresh.module.ts | contexts/sources/sources.module.ts | 装配（并入 `SourcesModule`；原 RefreshModule 提供者全量迁入） |

**Module 装配说明**：**`SourcesModule` = sources.module + refresh.module 合并**（sources.module 现为仅 import RefreshModule 的壳，合并后 RefreshExecutorService/RefreshPublishService 直接列入 SourcesModule providers）；settings.module 与 app.module 中对 RefreshModule 的引用同步替换。

## T014 ⑦ contexts/media-catalog（← modules/catalog + modules/public-catalog 合并）

| 现路径 | 目标路径 | 判定依据 |
|---|---|---|
| modules/catalog/catalog.service.ts | contexts/media-catalog/application/catalog.service.ts | imports @hmp/shared、getDb(auth/db)、policy.batch-context/policy.rules —— 目录浏览用例；⚠ getDb 渗漏 |
| modules/catalog/catalog-admin.service.ts | contexts/media-catalog/application/catalog-admin.service.ts | imports drizzle-orm、schema、getDb、parent-verification、resource-reader、policy 类型 —— 目录管理用例；⚠ 驱动/getDb 渗漏 |
| modules/catalog/resource-reader.ts | contexts/media-catalog/infrastructure/resource-reader.ts | imports drizzle-orm、mediaItem(schema)、`type Db`(auth/db) —— 媒体可用性集合查询（存储读取为本职）→ infrastructure（T014 既定） |
| modules/catalog/catalog.controller.ts | contexts/media-catalog/interface/catalog.controller.ts | imports @nestjs、zod、SessionGuard、parseBody(auth/validation)、epg.service —— 请求装配 |
| modules/catalog/catalog.module.ts | contexts/media-catalog/media-catalog.module.ts | 装配（并入 **`MediaCatalogModule`**） |
| modules/public-catalog/public-catalog.service.ts | contexts/media-catalog/application/public-catalog.service.ts | imports @nestjs(Inject/Injectable)、Database、PublicContextService、getDb、policy.batch-context、public-media-projection —— 公共浏览用例；⚠ 渗漏记录 |
| modules/public-catalog/public-media-projection.ts | contexts/media-catalog/domain/public-media-projection.ts | imports 仅 `type PublicMediaDto`(@hmp/shared) —— 纯投影函数（toPublicMedia）→ domain（T014 既定） |
| modules/public-catalog/public-catalog.controller.ts | contexts/media-catalog/interface/public-catalog.controller.ts | imports @nestjs、zod、RateLimit、StrictPipe —— 请求装配 |
| modules/public-catalog/public-catalog.module.ts | contexts/media-catalog/media-catalog.module.ts | 装配（并入；现含 PARAMTYPES_METADATA/Reflector 特殊装配逻辑，合并时原样保留） |

**Module 装配说明**：**`MediaCatalogModule` = CatalogModule + PublicCatalogModule 合并**；两者现均 imports CommonModule，T018 后替换；public-catalog.module 的非常规装配（直接读 PARAMTYPES_METADATA）合并时零语义改动搬运。

## T015 ⑧ contexts/identity-access（← modules/auth + modules/household 合并）

| 现路径 | 目标路径 | 判定依据 |
|---|---|---|
| modules/auth/db.ts | contexts/identity-access/infrastructure/db.ts | imports `type DatabaseConstructor`(better-sqlite3)、drizzle-orm/better-sqlite3、Database、schema —— 驱动连接封装 → infrastructure（T015 既定）；⚠ `getDb` 被全部 9 个业务上下文 30+ 文件消费，T022 需上移 platform/database 或改为注入 |
| modules/auth/password.service.ts | contexts/identity-access/infrastructure/password.service.ts | imports argon2（argon2id/hash/verify）—— 加密库为本职 → infrastructure（§4「涉及加密库者归 infrastructure」） |
| modules/auth/token.service.ts | contexts/identity-access/infrastructure/token.service.ts | imports node:crypto（createHash/randomBytes/timingSafeEqual）—— 令牌哈希/生成为本职 → infrastructure（同上判定标准） |
| modules/auth/session.service.ts | contexts/identity-access/application/session.service.ts | ⚠ imports node:crypto(randomUUID)、drizzle-orm、express Response（cookie 写入/解析）、env、schema、getDb、password/token 服务 —— 会话签发/恢复用例编排 → application；加密/驱动/HTTP 渗漏如实记录，T022/T023 收口（T015「按映射归」） |
| modules/auth/device.service.ts | contexts/identity-access/application/device.service.ts | ⚠ imports node:crypto(randomUUID)、drizzle-orm、schema、getDb、identity-transition —— 设备会话管理用例 → application；驱动渗漏收口 |
| modules/auth/parent-verification.service.ts | contexts/identity-access/application/parent-verification.service.ts | ⚠ imports drizzle-orm、schema、getDb、password.service —— 家长口令校验用例（哈希委托 password.service）→ application；驱动渗漏收口 |
| modules/auth/setup.service.ts | contexts/identity-access/application/setup.service.ts | ⚠ imports node:crypto(randomUUID)、schema、getDb —— 部署初始化用例 → application；渗漏收口 |
| modules/auth/bootstrap.service.ts | contexts/identity-access/application/bootstrap.service.ts | ⚠ imports drizzle-orm、schema、getDb、policy.rules、password/parent-verification 服务、identity-transition、pin.service —— 引导/恢复用例编排 → application；渗漏收口 |
| modules/household/household.service.ts | contexts/identity-access/application/household.service.ts | ⚠ imports node:crypto(randomUUID)、drizzle-orm、schema、getDb —— Household 用例（T015 既定 application）；驱动渗漏收口 |
| modules/auth/account-session.dto.ts | contexts/identity-access/interface/account-session.dto.ts | ⚠ 名为 DTO（T015 既定 interface），实测另含 getDb 查询/事务（buildAccountSession/restoreAccountSession）—— interface + 驱动渗漏记录，T022/T023 收口 |
| modules/auth/auth.controller.ts | contexts/identity-access/interface/auth.controller.ts | imports @nestjs、express、zod、drizzle-orm、env、schema、getDb、守卫/管道、device/token/session 服务、account-session.dto —— 请求装配；⚠ drizzle/getDb 渗漏（T023 时随路由装配收口） |
| modules/auth/setup.controller.ts | contexts/identity-access/interface/setup.controller.ts | imports @nestjs、zod、PublicContextService、RateLimit、守卫/管道、password.service、setup.service —— 请求装配 |
| modules/auth/bootstrap.controller.ts | contexts/identity-access/interface/bootstrap.controller.ts | imports @nestjs、zod、SessionGuard/SameOriginGuard、StrictPipe、bootstrap.service —— 请求装配 |
| modules/auth/validation.ts | contexts/identity-access/interface/validation.ts | imports `type ZodType`(zod)、@hmp/shared、DomainError —— 请求校验 schema/装配（parseBody）→ interface |
| modules/household/household.controller.ts | contexts/identity-access/interface/household.controller.ts | imports @nestjs、SessionGuard、household.service —— 请求装配 |
| modules/auth/auth.module.ts | contexts/identity-access/identity-access.module.ts | 装配（并入 **`IdentityAccessModule`**） |
| modules/household/household.module.ts | contexts/identity-access/identity-access.module.ts | 装配（并入；HouseholdController 的路由前缀语义原样保留） |

**Module 装配说明**：**`IdentityAccessModule` = AuthModule + HouseholdModule 合并**；AuthModule 现 imports CommonModule（T018 后替换）；HouseholdController 的路由前缀语义原样保留。

## T016 ⑨ contexts/settings（← modules/settings）

| 现路径 | 目标路径 | 判定依据 |
|---|---|---|
| modules/settings/settings-access-grant.service.ts | contexts/settings/application/settings-access-grant.service.ts | ⚠ imports drizzle-orm、schema、getDb —— 设置访问授予/校验用例（requireValidSettingsGrant）→ application（T016 既定）；驱动渗漏收口 |
| modules/settings/settings-pin-verification.service.ts | contexts/settings/application/settings-pin-verification.service.ts | ⚠ imports drizzle-orm、schema、env、getDb、password.service、profile/pin.service —— PIN 再验证用例 → application（T016 既定）；渗漏收口 |
| modules/settings/settings-account.service.ts | contexts/settings/application/settings-account.service.ts | ⚠ imports drizzle-orm、schema、getDb、password.service(hashPassword)、bootstrap.service、settings-owner-password、profile 侧、access-revocation —— 账号口令变更用例 → application；渗漏收口 |
| modules/settings/settings-profiles.service.ts | contexts/settings/application/settings-profiles.service.ts | ⚠ imports drizzle-orm、schema、getDb、password.service、bootstrap、owner-password、profile 侧、policy.rules、access-revocation —— 档案管理用例 → application；渗漏收口 |
| modules/settings/settings-household.service.ts | contexts/settings/application/settings-household.service.ts | ⚠ imports drizzle-orm、schema、getDb、bootstrap、owner-password、access-grant —— Household 管理用例 → application；渗漏收口 |
| modules/settings/settings-devices.service.ts | contexts/settings/application/settings-devices.service.ts | ⚠ imports drizzle-orm、schema、playback types、getDb、bootstrap、parent-verification、device.service —— 设备管理/记录查询用例 → application；渗漏收口 |
| modules/settings/settings-owner-password.ts | contexts/settings/application/settings-owner-password.ts | imports @hmp/shared、DomainError、`type SessionContext`、parent-verification.service(verifyParentPassword) —— 零直接 argon2/node:fs/网络/驱动 import（校验委托 parent-verification）→ application（T016「按映射归」判定） |
| modules/settings/settings-access-revocation.ts | contexts/settings/application/settings-access-revocation.ts | ⚠ imports @nestjs(Injectable/OnApplicationBootstrap)、drizzle-orm、schema、Database、getDb —— 授予撤销事务函数 + 启动撤销钩子 → application（T016「按映射归」；事务边界语义）；@nestjs 生命周期与驱动渗漏收口，审计如判 lifecycle 钩子属装配可拆分 |
| modules/settings/settings-access.controller.ts | contexts/settings/interface/settings-access.controller.ts | imports @nestjs、zod、守卫、StrictPipe、access-grant、pin-verification —— 请求装配 |
| modules/settings/settings-account.controller.ts | contexts/settings/interface/settings-account.controller.ts | imports @nestjs、express、zod、drizzle-orm、env、schema、守卫、getDb、account service —— 请求装配；⚠ drizzle/getDb 渗漏记录 |
| modules/settings/settings-devices.controller.ts | contexts/settings/interface/settings-devices.controller.ts | imports @nestjs、express、zod、守卫、parseBody、devices service —— 请求装配 |
| modules/settings/settings-epg.controller.ts | contexts/settings/interface/settings-epg.controller.ts | imports @nestjs、express、drizzle-orm、zod、守卫、schema、Database、getDb、parent-verification、manual-epg-binding —— 请求装配；⚠ 驱动/Database 渗漏记录 |
| modules/settings/settings-household.controller.ts | contexts/settings/interface/settings-household.controller.ts | imports @nestjs、zod、守卫、StrictPipe、household service —— 请求装配 |
| modules/settings/settings-policy.controller.ts | contexts/settings/interface/settings-policy.controller.ts | imports @nestjs、zod、守卫、StrictPipe、policy.service —— 请求装配 |
| modules/settings/settings-profiles.controller.ts | contexts/settings/interface/settings-profiles.controller.ts | imports @nestjs、zod、守卫、StrictPipe、profiles service、account-session.dto type —— 请求装配 |
| modules/settings/settings-sources.controller.ts | contexts/settings/interface/settings-sources.controller.ts | imports @nestjs、express、zod、守卫、RefreshExecutorService、parseBody、source-target.validation、sources.service、catalog-admin —— 请求装配 |
| modules/settings/settings.module.ts | contexts/settings/settings.module.ts | 装配（`SettingsModule` 不变；现 imports RefreshModule —— T013 合并后改引 SourcesModule） |

**Module 装配说明**：`SettingsModule` 名称不变；对 `RefreshModule` 的导入随 T013 合并改为 `SourcesModule`；`SettingsGrantStartupRevocation`（settings-access-revocation 的启动钩子）随 providers 迁移。

## T017 ⑩ contexts/playback（← modules/playback）

| 现路径 | 目标路径 | 判定依据 |
|---|---|---|
| modules/playback/playback.types.ts | contexts/playback/domain/playback.types.ts | 零 import —— 纯类型/错误码/状态常量 → domain（T017 既定） |
| modules/playback/playback.repository.ts | contexts/playback/infrastructure/playback.repository.ts | imports node:crypto、drizzle-orm、drizzle-orm/better-sqlite3、`type DatabaseConstructor`、schema —— 仓储（T017 既定 infrastructure） |
| modules/playback/nas-reader.ts | contexts/playback/infrastructure/nas-reader.ts | imports node:fs(createReadStream)、node:fs/promises、node:path、node:stream、@nestjs、source-target.validation —— NAS 文件流读取（T017 既定） |
| modules/playback/media-probe.service.ts | contexts/playback/infrastructure/media-probe.service.ts | imports node:child_process(ffprobe spawn)、node:fs/promises、node:path、@nestjs、source-target.validation —— 外部探测适配（T017 既定） |
| modules/playback/ffmpeg-subtitle-extract.ts | contexts/playback/infrastructure/ffmpeg-subtitle-extract.ts | imports node:child_process(spawn) —— ffmpeg 字幕提取（T017 既定） |
| modules/playback/conversion-storage.service.ts | contexts/playback/infrastructure/conversion-storage.service.ts | imports node:fs、node:fs/promises、node:path —— 转码产物磁盘存储（T017 既定） |
| modules/playback/conversion-supervisor.service.ts | contexts/playback/infrastructure/conversion-supervisor.service.ts | imports node:child_process(execFile=promisify)、node:path —— ffmpeg 子进程监督（T017 carve-out「涉 ffmpeg」→ infrastructure） |
| modules/playback/hls-proxy.service.ts | contexts/playback/infrastructure/hls-proxy.service.ts | ⚠ imports node:dns/http/https/net/stream、@nestjs —— HLS 上游代理（网络适配为本职）→ infrastructure；**T017 的 infrastructure 与 application 清单均未列及此文件（tasks.md 缺口），本表补判** |
| modules/playback/playback-lifecycle.service.ts | contexts/playback/infrastructure/playback-lifecycle.service.ts | ⚠ imports node:fs/promises（readdir 扫描转换产物目录）、node:path、drizzle-orm、schema、Database、getDb —— 会话生命周期 + 产物 GC；涉存储 → 按 T017 carve-out 归 infrastructure（组级预估 application，逐文件判定改判） |
| modules/playback/playback-subtitles.service.ts | contexts/playback/infrastructure/playback-subtitles.service.ts | ⚠ imports node:fs/promises（readdir 字幕文件发现）、node:path、media-probe、nas-reader type —— 字幕轨事实+文件定位，涉存储 → infrastructure（同上 carve-out 改判） |
| modules/playback/playback-authorization.service.ts | contexts/playback/application/playback-authorization.service.ts | ⚠ imports drizzle-orm、schema、getDb、policy.service/policy.rules、repository —— 授权编排 → application（T017 既定）；驱动渗漏收口 |
| modules/playback/playback-plan.service.ts | contexts/playback/application/playback-plan.service.ts | imports 仅 @nestjs Injectable + playback-budgets/playback.types type —— 纯交付计划决策，零 IO → application |
| modules/playback/playback-selection.service.ts | contexts/playback/application/playback-selection.service.ts | ⚠ imports drizzle-orm、schema、getDb、authorization/resolver/repository type —— 选择用例 → application；渗漏收口 |
| modules/playback/playback-resolver.service.ts | contexts/playback/application/playback-resolver.service.ts | ⚠ imports drizzle-orm、schema、getDb、authorization/repository type、personal 端口 type —— resolve 用例编排 → application；渗漏收口 |
| modules/playback/playback-ticket.service.ts | contexts/playback/application/playback-ticket.service.ts | ⚠ imports drizzle-orm、schema、getDb、auth/token.service(generateToken/hashToken) —— 票据签发用例 → application；加密/驱动渗漏收口（token 侧已归 infrastructure） |
| modules/playback/playback-rate-limit.service.ts | contexts/playback/application/playback-rate-limit.service.ts | imports 仅 @nestjs Injectable + budgets type —— 内存限流桶，零 IO → application |
| modules/playback/conversion-watchdog.service.ts | contexts/playback/application/conversion-watchdog.service.ts | imports 仅 `type`（budgets/types），时钟经注入端口（WatchdogClock）零直接 IO —— 转码裁决状态机 → application（T017 既定；亦可视为领域状态机，随 T017 落位） |
| modules/playback/playback-assets.service.ts | contexts/playback/application/playback-assets.service.ts | ⚠ imports node:crypto（sha1 生成不透明 assetId，非加密用途）、node:path、@nestjs —— 内存资产映射/HLS 清单重写，零 fs/网络/驱动 → application（T017 既定） |
| modules/playback/playback-audit.service.ts | contexts/playback/application/playback-audit.service.ts | ⚠ imports node:crypto(randomUUID)、drizzle-orm、schema、getDb —— 播放失败事件记录用例 → application（T017 既定）；驱动渗漏收口 |
| modules/playback/playback-retention.service.ts | contexts/playback/application/playback-retention.service.ts | ⚠ imports drizzle-orm、schema、getDb —— 过期保留清理用例 → application（T017 既定）；驱动渗漏收口 |
| modules/playback/playback.controller.ts | contexts/playback/interface/playback.controller.ts | imports @nestjs、express、zod、守卫/RateLimit、getConfig/budgets、各应用服务 —— 请求装配 |
| modules/playback/playback-stream.controller.ts | contexts/playback/interface/playback-stream.controller.ts | imports @nestjs、express、node:fs(/promises)、node:stream、getDb、budgets、各应用/基础设施服务 —— 流交付请求装配；⚠ fs 渗漏记录（T023 随装配收口） |
| modules/playback/playback-readiness.guard.ts | contexts/playback/interface/playback-readiness.guard.ts | imports @nestjs(CanActivate/Injectable)、Database —— 上下文内守卫 → interface |
| modules/playback/playback.module.ts | contexts/playback/playback.module.ts | 装配（`PlaybackModule` 不变；现 imports PersonalModule —— T008 后改引 PersonalDataModule，CommonModule 同步替换；内含 spawn/http/probe 等装配工厂代码，搬运时零语义改动） |

**Module 装配说明**：`PlaybackModule` 名称不变；现 imports `PersonalModule`（personal 侧服务消费）与 `CommonModule`，随 T008/T018 更名为对应新模块；内嵌的转换工厂装配逻辑（spawn 注入、HttpAdapterHost 流代理挂载）随 module 原样迁移。

## T018 ⑪ platform（← common + config + database + health）

| 现路径 | 目标路径 | 判定依据 |
|---|---|---|
| common/domain-error.ts | platform/http-common/domain-error.ts | imports 仅 `type ProblemCode`(@hmp/shared) —— 跨上下文错误契约，纯类型+工厂（§4 既定 http-common） |
| common/log-redaction.util.ts | platform/http-common/log-redaction.util.ts | 零 import —— 纯脱敏函数（§4 既定） |
| common/current-session.decorator.ts | platform/http-common/current-session.decorator.ts | imports @nestjs createParamDecorator、express type、@hmp/shared、DomainError —— 接口层横切装饰器（§4 既定） |
| common/session.guard.ts | platform/http-common/session.guard.ts | imports @nestjs、express、@hmp/shared、Database、auth/token.service(hashToken) —— 公共认证守卫；⚠ 深导入 auth 侧（T022 收口为令牌注入） |
| common/profile-context/current-profile.decorator.ts | platform/http-common/profile-context/current-profile.decorator.ts | imports @nestjs、express type、@hmp/shared、DomainError —— 横切装饰器 |
| common/profile-context/current-profile.guard.ts | platform/http-common/profile-context/current-profile.guard.ts | imports @nestjs、express type、Database、DomainError —— 公共档案上下文守卫（Database 为 platform 内部依赖） |
| common/public-context/public-context.service.ts | platform/http-common/public-context/public-context.service.ts | imports @nestjs、@hmp/shared、Database、DomainError —— 公共上下文服务（@Injectable 横切件） |
| common/same-origin/same-origin.guard.ts | platform/http-common/same-origin/same-origin.guard.ts | imports @nestjs、express type、getConfig、DomainError —— 横切守卫 |
| common/settings-access/settings-access.guard.ts | platform/http-common/settings-access/settings-access.guard.ts | ⚠ imports @nestjs、@hmp/shared、DomainError、settings 侧 requireValidSettingsGrant —— 横切守卫；对业务上下文反向深导入，T022 收口 |
| common/strict-input/strict-pipes.ts | platform/http-common/strict-input/strict-pipes.ts | imports @nestjs(type PipeTransform)、zod type、strict-schema —— 公共管道 |
| common/strict-input/strict-schema.ts | platform/http-common/strict-input/strict-schema.ts | imports zod、@hmp/shared、DomainError —— 公共 strict 解析 |
| common/problem-json.filter.ts | platform/http-common/problem-json.filter.ts | imports @nestjs、express type、zod、@hmp/shared、DomainError —— 公共异常过滤器 |
| common/logging.interceptor.ts | platform/http-common/logging.interceptor.ts | imports @nestjs、express type、rxjs、log-redaction —— 公共拦截器 |
| common/response-headers/api-security-headers.interceptor.ts | platform/http-common/response-headers/api-security-headers.interceptor.ts | imports @nestjs、express type、rxjs —— 公共拦截器 |
| common/rate-limit/rate-limit.decorator.ts | platform/http-common/rate-limit/rate-limit.decorator.ts | imports @nestjs SetMetadata —— 横切装饰器 |
| common/rate-limit/rate-limit.guard.ts | platform/http-common/rate-limit/rate-limit.guard.ts | imports @nestjs、express type、DomainError、rate-limit 服务/策略、client-ip —— 横切守卫 |
| common/rate-limit/rate-limit.service.ts | platform/http-common/rate-limit/rate-limit.service.ts | imports @nestjs Injectable、rate-limit.policies —— 内存限流服务（§4「随横切件就近放置，ADR 记录归属」） |
| common/rate-limit/rate-limit.policies.ts | platform/http-common/rate-limit/rate-limit.policies.ts | 零 import —— 纯策略常量/命名 |
| common/rate-limit/client-ip.util.ts | platform/http-common/rate-limit/client-ip.util.ts | imports express type、getConfig —— IP 提取工具（§4 既定 http-common） |
| common/common.module.ts | platform/（各子模块）拆并后**删除** | imports @nestjs、public-context、rate-limit 服务 —— 装配壳；按 §4 拆并入 platform 子模块后删除 |
| config/env.schema.ts | platform/config/env.schema.ts | imports node:net(isIPv4/isIPv6 纯谓词)、node:path(isAbsolute)、zod —— 环境校验 schema（§4 既定 platform/config） |
| config/env.ts | platform/config/env.ts | imports node:fs(existsSync)、node:process(loadEnvFile)、env.schema —— 环境加载（文件系统读取）→ platform/config |
| config/import-budgets.ts | platform/config/import-budgets.ts | 零 import —— 纯预算常量 |
| config/playback-budgets.ts | platform/config/playback-budgets.ts | imports getConfig、env.schema type —— 预算构造 → platform/config |
| database/database.ts | platform/database/database.ts | imports node:fs、node:path、better-sqlite3、config/env —— 驱动单例（§4 既定，文件内容零修改） |
| database/schema.ts | platform/database/schema.ts | imports drizzle-orm、drizzle-orm/sqlite-core —— Drizzle 表定义（零修改） |
| database/migrate.ts | platform/database/migrate.ts | imports node:fs、node:path、better-sqlite3 type、env、database、precheck —— 迁移执行器（零修改；package.json 脚本路径核对不变） |
| database/precheck.ts | platform/database/precheck.ts | imports node:fs、node:path、better-sqlite3、env —— 启动预检（零修改） |
| database/migrations/0001_init/up.sql | platform/database/migrations/0001_init/up.sql | SQL 迁移资产，随目录归位（内容零修改） |
| database/migrations/0001_init/down.sql | platform/database/migrations/0001_init/down.sql | 同上 |
| database/migrations/0002_profile_policy/up.sql | platform/database/migrations/0002_profile_policy/up.sql | 同上 |
| database/migrations/0002_profile_policy/down.sql | platform/database/migrations/0002_profile_policy/down.sql | 同上 |
| database/migrations/0003_media_catalog/up.sql | platform/database/migrations/0003_media_catalog/up.sql | 同上 |
| database/migrations/0003_media_catalog/down.sql | platform/database/migrations/0003_media_catalog/down.sql | 同上 |
| database/migrations/0004_manual_epg_binding/up.sql | platform/database/migrations/0004_manual_epg_binding/up.sql | 同上 |
| database/migrations/0004_manual_epg_binding/down.sql | platform/database/migrations/0004_manual_epg_binding/down.sql | 同上 |
| database/migrations/0005_playback/up.sql | platform/database/migrations/0005_playback/up.sql | 同上 |
| database/migrations/0005_playback/down.sql | platform/database/migrations/0005_playback/down.sql | 同上 |
| database/migrations/0006_pc_experience/up.sql | platform/database/migrations/0006_pc_experience/up.sql | 同上 |
| database/migrations/0006_pc_experience/down.sql | platform/database/migrations/0006_pc_experience/down.sql | 同上 |
| modules/health/health.controller.ts | platform/health/health.controller.ts | imports @nestjs、Database —— 就绪端点（§4 既定 platform/health） |
| modules/health/health.module.ts | platform/health/health.module.ts | 装配（`HealthModule` 归入 **`PlatformModule`** 体系） |

**Module 装配说明**：`CommonModule` 拆并入 platform 各子模块（http-common 公共件 providers + config/database 单例绑定）后删除；新增 **`PlatformModule`** 聚合 `HealthModule` 与 config/database/http-common 子模块；`app.module.ts` 中 `APP_FILTER`/`APP_INTERCEPTOR` 全局注册改为指向 platform/http-common 新路径。

## T019 ⑫ 组合根收尾（原地保留）

| 现路径 | 目标路径 | 判定依据 |
|---|---|---|
| main.ts | main.ts（原地保留） | imports reflect-metadata、@nestjs/core、config/env、app.module、database/precheck、node:path/fs、express type —— 组合根（§4：仅更新装配导入） |
| app.module.ts | app.module.ts（原地保留） | imports @nestjs、全部 14 个业务 module 与 CommonModule —— 组合根；T019 时导入全部改为 `contexts/*` 与 `platform/*`，modules 树清空后删除 |

**Module 装配说明**：`AppModule` 仅保留 contexts(10) + platform 装配；确认 `apps/server/src/modules/` 已空并删除。

---

**生成时间**: 2026-10-28
**效力说明**: 本表是 tasks.md T008–T019 各迁移步的执行依据（每步 = 按本表移动文件 + 机械修正导入路径 + module 更名/合并 + 全量门禁）。实现时如个别文件的判定与实际依赖冲突（含上列 ⚠ 项与 T022/T023 收口过程中产生的结构调整），以「使测试全绿且审计通过（`audit:boundaries` / `audit:orphans` 零违规）」为准修正，并回填本表保持映射与仓库一致。
