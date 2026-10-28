# 007 迁移后路由清单（Route Inventory · Post-Migration）

> 用途：007-US2「行为零变化」比对——以 `routes-baseline.md` 文档头/§3 记载的同一生成方式，对**迁移后当前树（HEAD `deb7700`）**重新提取全部 `@Controller` 路由，并与基线逐行比对。
> 路径均为源码装饰器**原样值**（`@Controller` 前缀 + 方法级路径原样拼接，保留 `:param` 写法与空路径形态），不做规范化改写。
> 运行时备注（不计入本表）：`apps/server/src/main.ts:24` 仍为 `app.setGlobalPrefix('api')`，实际请求路径为 `/api/` + 表内 Path（与基线口径一致）。
> **比对结论：控制器数 22、端点数 67，与基线一致；五元组（Controller/Verb/Path/Method/HttpCode）逐行 0 diff。** 详见 §4。

## 1. 顶部统计

| 指标 | 本次（迁移后） | 基线（迁移前） | 一致 |
| --- | --- | --- | --- |
| 控制器类总数 | **22**（分布于 21 个 `*.controller.ts` 文件；`settings-sources.controller.ts` 内含 2 个控制器类） | **22**（同口径） | ✅ |
| 路由端点总数 | **67** | **67** | ✅ |
| 显式 `@HttpCode` 端点数 | 27（其余 40 个端点走 Nest 默认状态码：POST=201，其余=200） | 27 | ✅ |

### 按动词分布

| Verb | 本次端点数 | 基线端点数 | 一致 |
| --- | --- | --- | --- |
| GET | 29 | 29 | ✅ |
| POST | 24 | 24 | ✅ |
| PUT | 7 | 7 | ✅ |
| PATCH | 4 | 4 | ✅ |
| DELETE | 2 | 2 | ✅ |
| HEAD | 1 | 1 | ✅ |
| 合计 | **67** | **67** | ✅ |

### 按模块分布

> 迁移将原 `src/modules/*` 物理重组为 `src/contexts/*`（+ `src/platform/*`）。模块更名/合并属**结构变化**（DI 装配图等价迁移，见 migration-map.md），不在路由五元组比对范围内；对应关系：AuthModule+HouseholdModule → IdentityAccessModule，CatalogModule+PublicCatalogModule → MediaCatalogModule，LiveModule → LiveTvModule，PersonalModule → PersonalDataModule，HealthModule → platform/health。

| 所属 Module（注册于 AppModule） | 控制器数 | 端点数 | 基线对应 | 基线控制器数/端点数 |
| --- | --- | --- | --- | --- |
| IdentityAccessModule | 4 | 8 | AuthModule + HouseholdModule | 3+1 / 7+1 |
| MediaCatalogModule | 2 | 6 | CatalogModule + PublicCatalogModule | 1+1 / 3+3 |
| EpgModule | 1 | 1 | EpgModule | 1 / 1 |
| HealthModule（`src/platform/health/`） | 1 | 1 | HealthModule | 1 / 1 |
| LiveTvModule | 1 | 3 | LiveModule | 1 / 3 |
| PersonalDataModule | 1 | 5 | PersonalModule | 1 / 5 |
| PlaybackModule | 2 | 10 | PlaybackModule | 2 / 10 |
| ProfileModule | 1 | 3 | ProfileModule | 1 / 3 |
| SettingsModule | 9 | 30 | SettingsModule | 9 / 30 |
| **合计** | **22** | **67** | — | **22 / 67** |

无控制器模块（完整性备注）：`PolicyModule`（`controllers: []`）、`SourcesModule`（`controllers: []`）、`HttpCommonModule`（无 controllers 注册行）、`PlatformModule`（仅聚合 imports）。与基线备注口径一致（原 `CommonModule` 共享 providers 由此平台模块承接）。

## 2. 按模块分节路由表

表内 Path = `@Controller('...')` 前缀 + 方法装饰器路径，按源码原样；前缀与方法路径之间以 `/` 连接（源码装饰器值为空时仅保留前缀本身）。HttpCode 列为显式 `@HttpCode(n)` 值；`—` 表示无显式 `@HttpCode`（Nest 默认：POST 201，其余 200）。各节内行序与基线保持一致以便逐行比对。

### IdentityAccessModule（`apps/server/src/contexts/identity-access/interface/`）

| Controller | Verb | Path | Method | HttpCode |
| --- | --- | --- | --- | --- |
| AuthController | POST | auth/login | login | 200 |
| AuthController | GET | auth/session | getSession | — |
| AuthController | POST | auth/logout | logout | 204 |
| BootstrapController | POST | auth/bootstrap-profile | bootstrap | 201 |
| BootstrapController | POST | auth/main-profile/pin-recovery | pinRecovery | 204 |
| HouseholdController | GET | household | getHousehold | — |
| SetupController | GET | setup/status | status | — |
| SetupController | POST | setup/initialize | initialize | 201 |

### MediaCatalogModule（`apps/server/src/contexts/media-catalog/interface/`）

| Controller | Verb | Path | Method | HttpCode |
| --- | --- | --- | --- | --- |
| CatalogController | GET | media | list | — |
| CatalogController | GET | media/:mediaId | detail | — |
| CatalogController | GET | media/:mediaId/programmes | programmes | — |
| PublicCatalogController | GET | public/context | context | — |
| PublicCatalogController | GET | public/media | listMedia | — |
| PublicCatalogController | GET | public/media/:mediaId | getMedia | — |

### EpgModule（`apps/server/src/contexts/epg/interface/`）

| Controller | Verb | Path | Method | HttpCode |
| --- | --- | --- | --- | --- |
| PublicGuideController | GET | public/guide | guide | — |

### HealthModule（`apps/server/src/platform/health/`）

| Controller | Verb | Path | Method | HttpCode |
| --- | --- | --- | --- | --- |
| HealthController | GET | healthz | check | — |

### LiveTvModule（`apps/server/src/contexts/live-tv/interface/`）

| Controller | Verb | Path | Method | HttpCode |
| --- | --- | --- | --- | --- |
| LivePublicController | GET | public/live/groups | groups | — |
| LivePublicController | GET | public/live/channels | channels | — |
| LivePublicController | GET | public/media/:mediaId/programmes | programmes | — |

### PersonalDataModule（`apps/server/src/contexts/personal-data/interface/`）

| Controller | Verb | Path | Method | HttpCode |
| --- | --- | --- | --- | --- |
| MeController | GET | me/favorites/channels | listFavorites | — |
| MeController | PUT | me/favorites/channels/:mediaId | addFavorite | 204 |
| MeController | DELETE | me/favorites/channels/:mediaId | removeFavorite | 204 |
| MeController | GET | me/history | listHistoryPage | — |
| MeController | GET | me/history/:mediaId | getOneHistory | — |

### PlaybackModule（`apps/server/src/contexts/playback/interface/`）

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

### ProfileModule（`apps/server/src/contexts/profile/interface/`）

| Controller | Verb | Path | Method | HttpCode |
| --- | --- | --- | --- | --- |
| ProfileController | GET | profiles | list | — |
| ProfileController | POST | profiles/:profileId/select | select | 200 |
| ProfileController | POST | profiles/:profileId/unlock | unlock | 200 |

### SettingsModule（`apps/server/src/contexts/settings/interface/`）

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

- **生成命令方式**：与基线 §3 相同口径——只读静态扫描。脚本（`/tmp/t025/extract-routes.mjs`，未入仓）枚举 `apps/server/src/**/*.controller.ts`（21 个文件；迁移后控制器物理落点为 `src/contexts/*/interface/` 与 `src/platform/health/`），剥离块注释后逐文件解析 `@Controller` 前缀、路由装饰器（`@Get/@Post/@Put/@Patch/@Delete/@Head`）、`@HttpCode` 与方法名；以全仓 `@Controller\(` grep 交叉验证——除 21 个控制器文件外仅 `src/platform/http-common/rate-limit/rate-limit.decorator.ts` 命中，且为 JSDoc 注释示例，非真实控制器；控制器→Module 归属取自各 `*.module.ts` 的 `controllers: [...]` 注册列表，并与 `apps/server/src/app.module.ts` 的 imports 交叉核对。脚本结果再与 `routes-baseline.md` §2 表逐行程序化比对（`/tmp/t025/diff-routes.mjs`）。
- **扫描范围**：`apps/server/src/**/*.controller.ts` + 各 `*.module.ts` + `apps/server/src/app.module.ts` + `apps/server/src/main.ts`（全局前缀备注）。`apps/server/src` 下含 `@Controller` 装饰器的文件全部落在 contexts/platform 目录内，无范围外控制器。
- **生成时间**：2026-10-28（Asia/Shanghai）；当前树 HEAD：`deb7700`（工作区干净）
- **用途**：007-US2「行为零变化」验收——与 `routes-baseline.md` 逐行比对 Controller/Verb/Path/Method/HttpCode 五元组。

## 4. 与基线逐行比对结果

比对脚本输出（五元组 multiset + 排序后逐位比对）：

```text
baseline=67 current=67
removed(from baseline, missing now)=0
added(new, not in baseline)=0
sorted-position mismatches=0
RESULT: 0 DIFF
```

| 比对维度 | 结果 |
| --- | --- |
| 控制器类总数 | 22 = 22 ✅ |
| 端点总数 | 67 = 67 ✅ |
| 缺失端点（基线有、当前无） | **0** |
| 新增端点（当前有、基线无） | **0** |
| 五元组逐行 diff | **0 行** |
| 显式 `@HttpCode` 端点数 | 27 = 27 ✅ |

**结论：路由清单 0 diff，无行为破坏信号，比对通过。**
