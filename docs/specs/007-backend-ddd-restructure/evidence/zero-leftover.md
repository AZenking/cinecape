# 007-T031 零遗留清点证据（zero-leftover）

- 日期：2026-10-28
- 基线 HEAD：`7e9a5d6`（T030 合规清单后）
- 范围：`apps/server`（knip 全类目 + 残留检索），行为零变化（删死代码，1376 测试守护）
- 结论：**knip 全类目 exit 0（零报告项、零 hint）；旧树路径字样检索归零（1 处「原 X」历史溯源注记按语义保留）；TODO/FIXME/注释旧实现/迁移垫片均为零；六项门禁全绿**

---

## 1. knip 类目恢复说明（步骤 1）

T018 曾以整行 `"exclude": ["exports", "types", "nsExports", "nsTypes", "duplicates"]` 暂缓导出类审计（注释注明"T031 恢复该类目后清零"，当时实测残留 23 死导出 + 4 死类型）。T022/T023 重构后按 T031 恢复：

- 编辑 `apps/server/knip.json`：**删除整行 exclude**（该五个类目为 T018 同一笔收口引入，其中 exports/types 为主类目，nsExports/nsTypes 为其文件级衍生的命名空间变体、duplicates 为重复导出——一并恢复才是 T002 原始缺省的"全类目审计"语义，git 基线 `614b6c8`/`626115b~1` 的配置均无 exclude 键）；
- entry（`src/app.module.ts`、`src/contexts/*/index.ts` 发布面、`test/**` 规格树、scale-fixture.cli、runtime-smoke.mjs）、`ignoreExportsUsedInFile: true`、`ignoreBinaries`、`ignoreDependencies: ["sax"]` 全部保留不动；
- 注释同步改写为 T031 收口记录。

**步骤 5（main.ts redundant entry hint）**：`src/main.ts` 不在 entry 数组中（T018 起经 package.json `dev` 脚本自动探测），恢复全类目后 knip 终态输出无任何 hint（`Unused files/exports/...` 均为空、无 `ℹ` 提示行），无需再清理 entry。

## 2. knip 报告项总数与处置分布（步骤 2/3）

恢复类目后首轮 `pnpm --filter @hmp/server audit:orphans`：**Unused exports 23 + Unused exported types 4 = 27 项；无 unused files / unused dependencies / other 类目**。逐项全仓检索核验（src + test + apps/web + packages，含非 TS 文件）后处置；删除过程暴露 1 项级联死类型（knip 二轮暴露），合计删除 **28 项（23 死导出 + 5 死类型）**，二轮复检后归零。无"仅测试消费"保留项、无"发布面预留"项（见 §5）。

处置分布：**删 28 / 留 0 / 改注释（非 knip 项）45 处**。

### 处置决策表（项 | 类别 | 处置 | 理由）

| # | 项 | 位置 | 类别 | 处置 | 理由 |
|---|---|---|---|---|---|
| 1 | `initializeHousehold` | identity-access/application/household.service.ts | 死导出 | 删 | 初始化用例已由 `setup.service.initializeDeployment` 承载（005-US2 迁移遗留）；级联删 `InitializeInput`、`alreadyDone`、`isInitialized` 及孤儿 imports（randomUUID/account/NewAccount/NewHousehold） |
| 2 | `PARENT_STATE_CLEARED` | identity-access/application/parent-verification.service.ts | 死导出 | 删 | 纯常量全仓零引用（锁定状态机以持久化行删除表达清零态，注释为残留说明） |
| 3 | `buildSessionDto` | identity-access/application/session.service.ts | 死导出 | 删 | 登录响应装配已由 `account-session.dto.buildAccountSession` 取代（AccountSession 形契约） |
| 4 | `buildRestoredSessionDto` | 同上 | 死导出 | 删 | 恢复响应装配已由 `restoreAccountSession` 取代；级联删 `RestoredProfileDtoBody`、`RestoredSessionDtoBody`、`activeProfileDtoOf`、`sessionInvalid` 及 profile/SessionContext 孤儿 imports |
| 5 | `revokeSessionByToken` | 同上 | 死导出 | 删 | 注销已由 `auth.controller.revokeSessionWithIdentityCleanup`（同事务身份清理，007 换档语义）取代——旧实现「查无令牌抛 401」与新幂等 no-op 契约相悖，属必须删除的失效副本；级联删 `sessionInvalid` |
| 6 | `verifyTokenHash` | identity-access/infrastructure/token.service.ts | 死导出 | 删 | 会话校验走 token_hash 等值查询（索引命中），无常数时间比对消费方；级联删 `timingSafeEqual` import |
| 7 | `parseParam` | identity-access/interface/validation.ts | 死导出 | 删 | 发布面仅 re-export `parseBody`；参数校验由 strictObject schema + StrictBodyPipe 承担 |
| 8 | `normalizeGroupTitle`（再导出行） | live-tv/application/live-projection.service.ts:426 | 死导出（纯 re-export） | 删再导出行 | 函数本体在 `domain/live-grouping.ts` 活跃（域内 + live-grouping.spec 消费）；仅 live-projection 的转发导出零消费；级联删孤儿 import |
| 9 | `readFavoriteRow` | personal-data/application/favorites.service.ts | 死导出 | 删 | 注释「导出供单测复核」失实——T022/T023 重排后测试改经夹具/HTTP 面；级联删 `asc` import |
| 10 | `listFavoriteRowsOldestFirst` | 同上 | 死导出 | 删 | 同上 |
| 11 | `readHistoryRow` | personal-data/application/history.service.ts | 死导出 | 删 | 同上（进度写路径的直读在 progress-write.service 有本文件私有实现，与此导出无关）；级联删 `asc`、`createDomainError` imports |
| 12 | `listHistoryRowsOldestFirst` | 同上 | 死导出 | 删 | 同上 |
| 13 | `upsertHistoryRowForFixture` | 同上 | 死导出 | 删 | T008 时代夹具直写辅助，夹具已整体改用 seed 路径，零消费 |
| 14 | `mediaNotFound` | 同上 | 死导出 | 删 | 404 同形助手零消费；级联删 `createDomainError` import |
| 15 | `readHistoryFor` | personal-data/application/progress-clock.service.ts | 死导出 | 删 | 「供单测与 flush 协作复用」失实，零消费；级联删 `profileViewingHistory` import |
| 16 | `resetCursorDeploymentKeyForTest` | personal-data/infrastructure/signed-cursor.ts | 死导出 | 删 | 测试注入钩子零消费（游标部署键按库路径派生在测试内无需重置） |
| 17 | `isPlaybackActiveSessionState` | playback/domain/playback.types.ts | 死导出 | 删 | 活动态类型守卫零消费（终态守卫 `isPlaybackTerminalSessionState` 活跃保留）；级联删 `PlaybackActiveSessionState` 派生类型（见 #27）；`PLAYBACK_ACTIVE_SESSION_STATES` 常量本体 3 处消费保留 |
| 18 | `listProfiles` | profile/application/profile.service.ts | 死导出 | 删 | GET /profiles 已由 `profile-selection.service.listSelectableProfiles`（ProfileSummary 白名单）承载；测试/前端的 `listProfiles` 均为同名 HTTP 辅助，非本函数 |
| 19 | `updateProfile` + `UpdateProfileCommand` | 同上 | 死导出 | 删 | 005-US8 管理面迁 settings 后 `settings-profiles.service` 自带同语义实现（自带 drizzle patch/级联逻辑），本副本零消费；级联删 `ne`/`deviceSession`/`revokeUnlockGrantsForProfile`/`clearDeviceSessionsProfile` 孤儿 imports；`toProfileDto`/`swapActiveDefaultTo` 等仍被 createProfile 消费保留 |
| 20 | `countActiveSettingsGrants` | settings/application/settings-access-revocation.ts | 死导出 | 删 | 「只在本模块内部使用」注释失实（`ignoreExportsUsedInFile` 开启下仍被标记 = 文件内亦零引用），撤销路径均以事务句柄实现 |
| 21 | `systemClock` | test/fixtures/clock.ts | 死导出（测试夹具） | 删 | 各服务自带真实时钟实现（StorageClock 等），测试一律注入 `createManualClock`；头注释同步改写 |
| 22 | `createScaleFixtureClock` | test/fixtures/scale-fixture.ts | 死导出（测试夹具） | 删 | 零消费（规模夹具经 CLI/seed 消费，时钟注入指引改写为 `createManualClock({ startMs: SCALE_FIXTURE_FIXED_NOW_MS })` 直引）；级联删 `./clock` 孤儿 import |
| 23 | `request`（supertest 再导出） | test/helpers-settings.ts | 死导出 | 删 | 测试均直从 `supertest` 导入，转发导出零消费；级联删孤儿 import |
| 24 | `ChannelAssociationCore`（再导出） | epg/domain/binding-core.ts:26 | 死类型（纯 re-export） | 删再导出项 | 消费方（live-tv.ports/index）直接从 `@contexts/live-tv` 取该类型；`ChannelMetaRow` 再导出有消费保留；头注释旧路径同步改写 |
| 25 | `StageEntryKind` | sources/infrastructure/refresh-staging.service.ts | 死类型 | 删 | 开放枚举类型零引用（kind 字段以字面量联合在各 Params 接口内定义） |
| 26 | `ImportBudgets` | platform/config/import-budgets.ts | 死类型 | 删 | `typeof IMPORT_BUDGETS` 别名零引用（消费方直接 import 常量） |
| 27 | `PlaybackActiveSessionState` | playback/domain/playback.types.ts | 死类型（级联） | 删 | 唯一引用方为被删的 #17 守卫，knip 二轮暴露；派生自的 `PLAYBACK_ACTIVE_SESSION_STATES` 常量多消费保留 |
| 28 | `RegisteredProblemCode` | platform/http-common/domain-error.ts | 死类型 | 删 | 语义别名零引用（`CatalogProblemCode` 为活跃正名，`createDomainError` 签名消费） |

「仅供测试消费」项核验说明：test/**（spec/e2e-spec/setup/cli/smoke）均为 knip entry，27 项中无一呈现「仅测试消费仍被标记」的形态——凡测试真实消费的导出（如 `createManualClock`、`createProfile`）均未被标记，与 T018 的 entry 化设计一致，故本轮无需援引「测试消费保留」条款。

## 3. 残留检索清零（步骤 4，命令与命中数：处置前 → 处置后）

| 检索命令（apps/server 范围） | 处置前 | 处置后 | 说明 |
|---|---|---|---|
| `grep -rn "modules/" apps/server/src apps/server/test` | **21** | **0** | T019 计 19 处注释字样 + T022b 新增 2 处；逐条更新为当前真实路径（明细见 §4） |
| `grep -rnE "src/(database\|common\|config\|modules)" apps/server/src apps/server/test` | **24** | **1** | 23 处更新为 `src/platform/*` 真实路径（含 migrate.ts 用法串、manifest.json planReference、SQL 头部 8 处、e2e 夹具注释、错误消息 1 处）；余 1 处为「原 src/common/common.module.ts」历史溯源注记，见 §6 保留清单 |
| `grep -rnE "TODO\|FIXME\|XXX\|HACK" apps/server/src apps/server/test` | **0** | **0** | 本次迁移无遗留标记（历史任务标记亦为零） |
| 注释掉的旧实现探针：`grep -rnE "^\s*//\s*(import\|export\|const\|function\|class\|return\|if\|for) " apps/server/src` | **0** | **0** | 无被注释的旧实现代码块 |
| 临时绕行垫片检索：`grep -rnE "垫片\|绕行\|shim\|workaround\|暂缓\|过渡" apps/server/src apps/server/test apps/server/knip.json apps/server/.dependency-cruiser.cjs` | 11 | 11（语义重审后全保留） | 命中均为 005 交付设计或事实陈述，非 007 迁移绕行垫片，见 §6 |

（`git grep` 在 HEAD 基线复测：A=21、B=24、TODO=0、注释块=0，与上表处置前一致。）

## 4. 旧路径字样逐条处置明细（45 处更新，零行为）

**A 组：`modules/*` → 当前真实路径（21 处，含 manifest.json planReference 与 1 处错误消息串）**

| 文件:行（基线） | 原字样 | 更新为 |
|---|---|---|
| contexts/settings/interface/settings-epg.controller.ts:36 | 复用 modules/epg 域核心 | 复用 contexts/epg 域核心 |
| contexts/settings/interface/settings-sources.controller.ts:39-40 | modules/sources 与 modules/imports、modules/catalog | contexts/sources 与 sources 发布面、contexts/media-catalog |
| contexts/settings/application/settings-devices.service.ts:28 | modules/playback/playback-records.controller 已删除 | 旧 playback 管理控制器 playback-records.controller 已删除（去失实路径，保留史实） |
| contexts/settings/application/settings-access-revocation.ts:14 | modules/profile/identity-transition.ts | contexts/profile/application/identity-transition.ts |
| contexts/identity-access/identity-access.module.ts:24 | 已迁入 modules/settings | 已迁入 contexts/settings |
| contexts/identity-access/identity-access.module.ts:32 | 迁入 modules/auth(setup.controller.ts) | 迁入 auth(现 identity-access,setup.controller.ts) |
| contexts/live-tv/interface/live.controller.ts:28 | 平移至 modules/epg/catalog-revision.service | 平移至 contexts/epg/infrastructure/catalog-revision.service |
| contexts/live-tv/live-tv.module.ts:21-23 | 接线示例 `./modules/live/live.module` + LiveModule | `@contexts/live-tv/live-tv.module` + LiveTvModule（007-T012 落位后真实形态） |
| contexts/live-tv/application/live-projection.service.ts:120 | 供 modules/epg/binding-core 复用 | 供 contexts/epg/domain/binding-core 复用 |
| contexts/media-catalog/media-catalog.module.ts:41-43 | 接线示例 `./modules/public-catalog/public-catalog.module` | `@contexts/media-catalog/media-catalog.module` + MediaCatalogModule |
| contexts/profile/application/identity-transition.ts:19 | modules/playback 的 PlaybackLifecycleService | contexts/playback 的 |
| contexts/playback/playback.module.ts:85 | 权威实现在 modules/settings | 权威实现在 contexts/settings |
| contexts/epg/infrastructure/catalog-revision.service.ts:13 | modules/live/live.controller.ts | contexts/live-tv/interface/live.controller.ts |
| contexts/epg/domain/programme-key.mapper.ts:9 | modules/live/live-projection.service.ts | contexts/live-tv/application/live-projection.service.ts |
| contexts/epg/domain/binding-core.ts:14,16 | modules/live/live-projection.service.ts；modules/epg 侧 | contexts/live-tv/application/live-projection.service.ts；epg 侧 |
| platform/http-common/settings-access/settings-access.guard.ts:26 | modules/settings/settings-access.controller.ts | contexts/settings/interface/settings-access.controller.ts |
| test/unit/playback/conversion.spec.ts:83 | 错误消息 `src/modules/playback/${moduleName}.ts 尚未实现` | `src/contexts/playback/**/${moduleName}.ts`（运行时加载目录早已是 contexts） |
| test/unit/modules/live/live-projection-time.spec.ts:25 | 批量核心位于 modules/live | 批量核心位于 contexts/live-tv |
| test/fixtures/playback/manifest.json:14 | planReference 指向 `apps/server/src/modules/playback/playback-plan.service.ts` | `apps/server/src/contexts/playback/application/playback-plan.service.ts`（JSON 可解析性复验通过） |

注：`test/unit/modules/live/` 目录名本身未改——它是 005 特性的测试树布局，`docs/specs/005-pc-browsing-flow/tasks.md` T057-T059/T072 以完整路径钉住这三个 spec 文件，更名将破坏已归档特性文档的准确性；其内部注释已更新（上表第 19 行），且目录不在 knip/depcruise 的旧树判定范围（knip 按文件分析，无影响）。此为本任务唯一「路径字样保留原状」点，属测试树组织名而非失实指引。

**B 组：`src/database|common|config` → `src/platform/*`（23 处更新）**

- `platform/database/migrate.ts`：头注释 L13、CLI 用法串 L337（console.error 文案的事实性修正，零行为——无测试断言该串）、CLI 入口注释 L349；
- `contexts/sources/infrastructure/refresh-staging.service.ts` L23-24：database.ts / schema.ts 路径；
- `test/contract/manual-epg-migration.e2e-spec.ts` L25、L28；`catalog-migration.e2e-spec.ts` L22；`playback-migration.e2e-spec.ts` L22、L69（缺失迁移错误消息，代码本体 L67 早已用 platform 路径）；
- `test/unit/playback/hls-proxy.spec.ts` L28（src/config → src/platform/config）；
- `test/fixtures/scale-fixture.ts` 头注释（src/database/migrations → platform）与 L762（src/database → platform/database）；
- SQL 头部 8 处（0001 up/down、0002-0006 up）：`src/database/schema.ts` → `src/platform/database/schema.ts`；0006 另含 `src/database/precheck.ts` → `src/platform/database/precheck.ts`。SQL 仅注释行改动（执行语义零变化；migration-0006.spec 的 sha256 断言对象是库文件而非 SQL，migration:drill 终态复验见 §7）。

## 5. 发布面预留清单

**空。** 恢复 exports/types 类目后，`contexts/*/index.ts` 发布面导出经 knip entry 声明（`src/contexts/*/index.ts`）全部判定为已用——发布面的「未来消费方契约」语义由 entry 入口地位承载（contracts/internal-context-contracts.md R2），本轮零误报、零预留豁免、零 ignoreExports 白名单。knip 报告的 28 项均为深路径（application/infrastructure/domain/interface 内部文件）导出，不属发布面。

## 6. 保留项清单（逐条判定留痕）

非删除、经语义重审判定保留的命中：

1. `platform/http-common/http-common.module.ts:6`「原 src/common/common.module.ts 的 CommonModule…」——`原`前缀的历史溯源注记，事实准确（该模块确由 common 迁入并更名），非失实指引。B 组检索唯一残留命中。
2. `contexts/media-catalog/media-catalog.module.ts:30` PolicyListsController「T063 过渡托管」——005 交付的宿主安排描述，非 007 迁移遗留。
3. `contexts/playback/playback.module.ts:550,676`「HTTP 服务器生命周期 shim（仅 NODE_ENV=test 安装；生产零改动）」——005 既定的测试管线设计（生产门控惰性），非绕行垫片。
4. `platform/http-common/domain-error.ts:5`「后续由共享包收编时迁移,本常量为唯一过渡登记点」——T009 既定路线图说明，登记处为当前权威实现。
5. `contexts/policy/application/policy.service.ts:240`「T063 过渡期由…」——同 #2，005 宿主安排。

垫片结论：**007 迁移过程（T008-T023）未遗留任何临时绕行垫片**；T022b 的 platform 端口反转（SESSION_VERIFIER_PORT / SETTINGS_GRANT_VALIDATOR_PORT）为 ADR-0014 修正案载明的终态架构，非临时措施。

## 7. 终态门禁结果（步骤 6）

| 门禁 | 命令 | 结果 |
|---|---|---|
| 孤儿/死导出审计（全类目） | `pnpm --filter @hmp/server audit:orphans` | **exit 0，零报告项，零 hint**（knip 静默通过） |
| 类型检查 | `pnpm --filter @hmp/server typecheck` | **exit 0**（tsc --noEmit 无错） |
| 代码规范 | `pnpm lint`（仓库根） | **exit 0**（见下方门禁偏差①） |
| 测试 | `pnpm --filter @hmp/server test` | **1376/1376 passed（111 files）**，Duration 158s；`test/contract/conversion-delivery.spec` 首过无 flake，未触发同树重跑 |
| 边界审计（软） | `AUDIT_ENFORCE=0 pnpm --filter @hmp/server audit:boundaries` | **exit 0，no dependency violations（204 modules / 1069 dependencies）** |
| 边界审计（强制） | `pnpm --filter @hmp/server audit:boundaries` | **exit 0，no dependency violations**（同上，维持 0） |

**门禁偏差（1 项，lint 基建修复）**：`pnpm lint` 在基线 HEAD 即红（与本次改动无关的 pre-existing 缺口）——T025 提交的证据脚本 `docs/specs/007-backend-ddd-restructure/evidence/snapshot-parity/{sampler,compare}.mjs` 未被任何 tsconfig include，typescript-eslint projectService 报 2 个解析错误。按仓库既有惯例（一次性证据工具不入 lint 项目服务）在 `eslint.config.mjs` ignores 增加该目录 `*.mjs`（与 node_modules/dist 同级的 ignore 语义），修复后 lint 全绿。零运行时影响。

## 8. 与 T018 基准的差异说明

T018 实测「23 死导出 + 4 死类型」，本轮首轮实测同为 23 + 4（条目构成已随 T020-T023 重排部分变化，如发布面令牌化消解了部分导出、T022b 守卫重构新增 `settings-access.guard` 注记），另暴露 1 项级联死类型，合计删除 28 项。T022/T023 的「重排后再删一次」成本权衡按预期兑现。
