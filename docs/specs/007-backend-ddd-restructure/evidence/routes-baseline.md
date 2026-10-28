# 007 迁移前路由基线（Route Baseline · Pre-Migration）

> 用途：007-US2「行为零变化」比对基线。迁移完成后重新生成本表并逐行比对，期望 **0 diff**。
> 路径均为源码装饰器**原样值**（`@Controller` 前缀 + 方法级路径原样拼接，保留 `:param` 写法与空路径形态），不做规范化改写。
> 运行时备注（不计入本表）：`apps/server/src/main.ts` 通过 `app.setGlobalPrefix('api')` 施加全局前缀，实际请求路径为 `/api/` + 表内 Path。

## 1. 顶部统计

| 指标 | 数值 |
| --- | --- |
| 控制器类总数 | **22**（分布于 21 个 `*.controller.ts` 文件；`settings-sources.controller.ts` 内含 2 个控制器类） |
| 路由端点总数 | **67** |
| 显式 `@HttpCode` 端点数 | 27（其余 40 个端点走 Nest 默认状态码：POST=201，其余=200） |

### 按动词分布

| Verb | 端点数 |
| --- | --- |
| GET | 29 |
| POST | 24 |
| PUT | 7 |
| PATCH | 4 |
| DELETE | 2 |
| HEAD | 1 |
| 合计 | **67** |

### 按模块分布

| 所属 Module（注册于 AppModule） | 控制器数 | 端点数 |
| --- | --- | --- |
| AuthModule | 3 | 7 |
| CatalogModule | 1 | 3 |
| EpgModule | 1 | 1 |
| HealthModule | 1 | 1 |
| HouseholdModule | 1 | 1 |
| LiveModule | 1 | 3 |
| PersonalModule | 1 | 5 |
| PlaybackModule | 2 | 10 |
| ProfileModule | 1 | 3 |
| PublicCatalogModule | 1 | 3 |
| SettingsModule | 9 | 30 |
| **合计** | **22** | **67** |

无控制器模块（完整性备注）：`PolicyModule`（`controllers: []`）、`SourcesModule`（`controllers: []`，仅 `imports: [RefreshModule]`）、`RefreshModule`（无 controllers，仅 providers/exports）、`CommonModule`（仅共享 providers）。

## 2. 按模块分节路由表

表内 Path = `@Controller('...')` 前缀 + 方法装饰器路径，按源码原样；前缀与方法路径之间以 `/` 连接（源码装饰器值为空时仅保留前缀本身）。HttpCode 列为显式 `@HttpCode(n)` 值；`—` 表示无显式 `@HttpCode`（Nest 默认：POST 201，其余 200）。

### AuthModule（`apps/server/src/modules/auth/`）

| Controller | Verb | Path | Method | HttpCode |
| --- | --- | --- | --- | --- |
| AuthController | POST | auth/login | login | 200 |
| AuthController | GET | auth/session | getSession | — |
| AuthController | POST | auth/logout | logout | 204 |
| BootstrapController | POST | auth/bootstrap-profile | bootstrap | 201 |
| BootstrapController | POST | auth/main-profile/pin-recovery | pinRecovery | 204 |
| SetupController | GET | setup/status | status | — |
| SetupController | POST | setup/initialize | initialize | 201 |

### CatalogModule（`apps/server/src/modules/catalog/`）

| Controller | Verb | Path | Method | HttpCode |
| --- | --- | --- | --- | --- |
| CatalogController | GET | media | list | — |
| CatalogController | GET | media/:mediaId | detail | — |
| CatalogController | GET | media/:mediaId/programmes | programmes | — |

### EpgModule（`apps/server/src/modules/epg/`）

| Controller | Verb | Path | Method | HttpCode |
| --- | --- | --- | --- | --- |
| PublicGuideController | GET | public/guide | guide | — |

### HealthModule（`apps/server/src/modules/health/`）

| Controller | Verb | Path | Method | HttpCode |
| --- | --- | --- | --- | --- |
| HealthController | GET | healthz | check | — |

### HouseholdModule（`apps/server/src/modules/household/`）

| Controller | Verb | Path | Method | HttpCode |
| --- | --- | --- | --- | --- |
| HouseholdController | GET | household | getHousehold | — |

### LiveModule（`apps/server/src/modules/live/`）

| Controller | Verb | Path | Method | HttpCode |
| --- | --- | --- | --- | --- |
| LivePublicController | GET | public/live/groups | groups | — |
| LivePublicController | GET | public/live/channels | channels | — |
| LivePublicController | GET | public/media/:mediaId/programmes | programmes | — |

### PersonalModule（`apps/server/src/modules/personal/`）

| Controller | Verb | Path | Method | HttpCode |
| --- | --- | --- | --- | --- |
| MeController | GET | me/favorites/channels | listFavorites | — |
| MeController | PUT | me/favorites/channels/:mediaId | addFavorite | 204 |
| MeController | DELETE | me/favorites/channels/:mediaId | removeFavorite | 204 |
| MeController | GET | me/history | listHistoryPage | — |
| MeController | GET | me/history/:mediaId | getOneHistory | — |

### PlaybackModule（`apps/server/src/modules/playback/`）

| Controller | Verb | Path | Method | HttpCode |
| --- | --- | --- | --- | --- |
| PlaybackController | POST | playback/resolve | resolve | —（POST 默认 201，另有 Location 响应头） |
| PlaybackController | GET | playback/sessions/:id | get | — |
| PlaybackController | POST | playback/sessions/:id/renew | renew | 200 |
| PlaybackController | POST | playback/sessions/:id/heartbeat | heartbeat | 204 |
| PlaybackController | POST | playback/sessions/:id/progress | progress | 200 |
| PlaybackController | POST | playback/sessions/:id/stop | stop | 204 |
| PlaybackController | PUT | playback/sessions/:id/selection | select | — |
| PlaybackController | POST | playback/sessions/:id/seek | seek | 200 |
| PlaybackStreamController | GET | playback/stream/:sessionId/:generation/:assetId | deliverByGet | — |
| PlaybackStreamController | HEAD | playback/stream/:sessionId/:generation/:assetId | deliverByHead | — |

### ProfileModule（`apps/server/src/modules/profile/`）

| Controller | Verb | Path | Method | HttpCode |
| --- | --- | --- | --- | --- |
| ProfileController | GET | profiles | list | — |
| ProfileController | POST | profiles/:profileId/select | select | 200 |
| ProfileController | POST | profiles/:profileId/unlock | unlock | 200 |

### PublicCatalogModule（`apps/server/src/modules/public-catalog/`）

| Controller | Verb | Path | Method | HttpCode |
| --- | --- | --- | --- | --- |
| PublicCatalogController | GET | public/context | context | — |
| PublicCatalogController | GET | public/media | listMedia | — |
| PublicCatalogController | GET | public/media/:mediaId | getMedia | — |

### SettingsModule（`apps/server/src/modules/settings/`）

| Controller | Verb | Path | Method | HttpCode |
| --- | --- | --- | --- | --- |
| SettingsAccessController | GET | settings/access | getAccess | — |
| SettingsAccessController | POST | settings/access | postAccess | 200 |
| SettingsAccessController | DELETE | settings/access | deleteAccess | 204 |
| SettingsAccountController | GET | settings/account | getAccount | — |
| SettingsAccountController | PUT | settings/account/password | changePassword | 204 |
| SettingsHouseholdController | GET | settings/household | getHouseholdSettings | — |
| SettingsHouseholdController | PATCH | settings/household | patchHousehold | — |
| SettingsProfilesController | GET | settings/profiles | list | — |
| SettingsProfilesController | POST | settings/profiles | create | 201 |
| SettingsProfilesController | PATCH | settings/profiles/:profileId | patch | — |
| SettingsProfilesController | PUT | settings/main-profile | transferMain | — |
| SettingsPolicyController | GET | settings/profiles/:profileId/policy | get | — |
| SettingsPolicyController | PUT | settings/profiles/:profileId/policy | update | — |
| SettingsPolicyController | PUT | settings/profiles/:profileId/policy/lists | replaceLists | — |
| SettingsSourcesController | GET | settings/sources | list | — |
| SettingsSourcesController | POST | settings/sources | create | 201 |
| SettingsSourcesController | PATCH | settings/sources/:sourceId | patchSource | — |
| SettingsSourcesController | POST | settings/sources/:sourceId/refresh | refresh | 202（另有 Location 响应头） |
| SettingsSourcesController | GET | settings/source-roots | listRoots | — |
| SettingsSourcesController | GET | settings/refreshes/:refreshId | getRefresh | — |
| SettingsSourcesController | POST | settings/refreshes/:refreshId/confirm | confirm | 200 |
| SettingsSourcesController | POST | settings/refreshes/:refreshId/discard | discard | 200 |
| SettingsCatalogController | POST | settings/catalog/candidates/query | queryCandidates | 200 |
| SettingsCatalogController | PATCH | settings/catalog/media/:mediaId | patchMedia | — |
| SettingsEpgBindingController | POST | settings/catalog/media/:mediaId/epg-binding/query | queryBinding | 200 |
| SettingsEpgBindingController | POST | settings/catalog/media/:mediaId/epg-candidates/query | queryCandidates | 200 |
| SettingsEpgBindingController | PUT | settings/catalog/media/:mediaId/epg-binding | updateBinding | — |
| SettingsDevicesController | GET | settings/devices | list | — |
| SettingsDevicesController | POST | settings/devices/:deviceId/revoke | revoke | 204 |
| SettingsDevicesController | POST | settings/devices/:deviceId/playback-records/query | queryRecords | 200 |

## 3. 生成方式与元信息

- **生成命令方式**：人工（AI 代理）只读静态扫描——以 glob 枚举 `apps/server/src/modules/**/*.controller.ts`（21 个文件）并以全仓 `@Controller\(` 装饰器 grep 交叉验证确认无遗漏；逐文件读取每个控制器的路由装饰器（`@Get/@Post/@Put/@Patch/@Delete/@Head`）、`@HttpCode` 与方法名；控制器→Module 归属取自同目录 `*.module.ts` 的 `controllers: [...]` 注册列表，并与 `apps/server/src/app.module.ts` 的 imports 交叉核对。未运行任何构建/服务进程，未运行 git 命令，未修改任何源码。
- **扫描范围**：`apps/server/src/modules/**/*.controller.ts` + 各 `*.module.ts` + `apps/server/src/app.module.ts` + `apps/server/src/main.ts`（全局前缀备注）。`apps/server/src` 下含 `@Controller` 装饰器的文件全部落在 modules 目录内，无范围外控制器。
- **生成时间**：2026-10-28（Asia/Shanghai）
- **用途**：供 007-US2「行为零变化」验收比对——迁移后以同一方式重新生成路由基线，逐行比对 Controller/Verb/Path/Method/HttpCode 五元组，**期望比对结果 0 diff**。任何差异（含顺序无关的路径改写、`HttpCode` 缺省化）均视为行为变化，需阻断合入并回溯。
- **已知口径约定**（比对时同口径处理）：
  - Path 保留源码装饰器原样（`:param` 风格、`@Get()` 空路径 = 仅控制器前缀），不转换为 openapi `{param}` 风格；
  - `HttpCode` 列 `—` 表示源码无显式 `@HttpCode`；比对时应连「有无显式装饰器」一起比对（Nest 默认码不变不等于装饰器未迁移）；
  - 全局前缀 `api` 来自 `main.ts` 的 `setGlobalPrefix`，不随模块迁移变化，不在本表内。
