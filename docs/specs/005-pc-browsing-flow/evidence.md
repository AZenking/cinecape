# 005-pc-browsing-flow · 验收证据

## T013 foundation 门禁记录

- 日期:2026-10-26(Asia/Shanghai)
- 执行入口:根 `pnpm verify:foundation`(聚合 `&&` 串联,任一步失败即整体失败;本次实跑退出码 0)
- 执行环境:macOS(Darwin),Node >= 24 / pnpm 11.28.5;Playwright 浏览器为 `pnpm --filter @hmp/web exec playwright install chromium` 新下载的 Chromium 156.0.8078.4(headless shell,**下载成功,未启用 channel:'chrome' 回退**)

### verify:foundation 各步命令与结果

| # | 步骤 | 命令 | 结果 |
| --- | --- | --- | --- |
| 1 | 契约类型生成 | `pnpm gen:types` | ok:001~004 加 005 experience 共 5 份 openapi-typescript 输出全部生成 |
| 2 | Lint | `pnpm lint`(eslint .) | ok:0 error 0 warning(本次修复 5 个存量错误后转绿) |
| 3 | 全 workspace typecheck | `pnpm typecheck`(pnpm -r typecheck) | ok:@hmp/shared / @hmp/web / @hmp/server 全部 Done(含 web 新纳入的 test/**) |
| 4 | 全 workspace build | `pnpm build`(pnpm -r build) | ok:三包全部 Done(web vite build 1785 modules;server tsc + migrations 拷贝) |
| 5 | server foundation 冒烟 | `pnpm --filter @hmp/server exec vitest run test/unit/foundation-smoke.spec.ts` | ok:发现 4 / 执行 4 / 通过 4 / 失败 0 |
| 6 | web foundation 冒烟(vitest) | `pnpm --filter @hmp/web exec vitest run test/foundation-smoke.spec.tsx` | ok:发现 7 / 执行 7 / 通过 7 / 失败 0 |
| 7 | e2e foundation 冒烟(playwright 单文件) | `pnpm --filter @hmp/web exec playwright test test/e2e/foundation-smoke.spec.ts` | ok:发现 2 / 执行 2 / 通过 2 / 失败 0(chromium) |

聚合输出节选(步 5~7):

```text
✓ test/unit/foundation-smoke.spec.ts (4 tests) 126ms
  Test Files  1 passed (1)   Tests  4 passed (4)
✓ test/foundation-smoke.spec.tsx (7 tests) 76ms
  Test Files  1 passed (1)   Tests  7 passed (7)
✓ 1 [chromium] › test/e2e/foundation-smoke.spec.ts › 首页渲染品牌与导航,不强制登录 (292ms)
✓ 2 [chromium] › test/e2e/foundation-smoke.spec.ts › /vod 与 /live 可达且仍在公共壳内 (240ms)
  2 passed (1.8s)
```

无 passWithNoTests、无 skip/only、无吞失败;三类冒烟均为真实执行的非零有效用例且全部通过。

### 各类冒烟覆盖点

- **server**(apps/server/test/unit/foundation-smoke.spec.ts):
  1. 全新独立临时库(独立 DATA_DIR/DB_FILENAME):全量迁移(0001~0006)后 generation2 就绪 —— `Database.isReady()===true`、`user_version===2`、迁移前未就绪/迁移后启动预检放行;
  2. 旧已初始化库(0001~0005 + 一行业务数据):`precheckDatabaseFile` 拒绝 `STORAGE_GENERATION_UNSUPPORTED`,`runMigrationCommand('up')` 抛 `MigrationGateError` 同码,主库文件 sha256 前后一致(不自动升级/清空);
  3. 守卫拒绝未认证管理读取:无 Cookie 请求既有管理路由 `GET /api/sources`、`GET /api/devices`(均挂 SessionGuard)→ 401 problem+json、code=SESSION_INVALID;
  4. 伪造会话 Cookie(无效令牌)同样 401 SESSION_INVALID。
- **web**(apps/web/test/foundation-smoke.spec.tsx):
  1. 游客公共壳:真实浏览器地址 `/`、`/vod`、`/live` 渲染 App —— 品牌 HOME MEDIA 与 首页/点播/直播 导航可见、占位页标题可见,地址保持不变、无登录强制跳转;
  2. typed fetch(按 shared/fetch.ts 真实 API):`publicFetch` 发出 credentials:'omit'、`privateFetch` 发出 credentials:'same-origin'(并核 204→undefined、JSON body/Content-Type);非 2xx problem+json 映射 FetchApiError(status/title/code/detail/problem,message=detail??title);AbortController 取消以 AbortError 拒绝(`isAbortError` 真、`isFetchApiError` 假)。
- **e2e**(apps/web/test/e2e/foundation-smoke.spec.ts,真实 Chromium):
  1. 游客打开 `/`:品牌与公共导航渲染、无登录强制跳转(URL 仍为 `/`);
  2. `/vod`、`/live` 可达且仍在公共壳内(占位标题 + 品牌可见,路径不变)。
  独立 DATA_DIR 由 playwright.config.ts 按进程注入临时目录;本冒烟页面不发 API 请求,DATA_DIR 仅作环境语义,不触碰真实部署数据。

### 本次修复的配置/存量问题(T013 授权范围内的最小修复)

1. `eslint.config.mjs`:`projectService.allowDefaultProject` 补 `apps/web/vitest.config.ts`、`apps/web/playwright.config.ts`(此前 parsing error 使 lint 全红);另为 `@typescript-eslint/no-unused-vars` 增加默认约定的 `^_` 参数/变量忽略(settings-access.guard.ts 占位 `authorize(_context)` 为 US7 保留的扩展点,不改其业务代码)。
2. `apps/web/tsconfig.json`:include 由 `["src"]` 扩为 `["src","test"]`,web typecheck 现覆盖测试代码(jest-dom 匹配器经 test/setup.ts 的模块扩充可解析,@playwright/test / vitest 类型直接可解析,无需追加 types 数组)。
3. `apps/server/src/common/profile-context/current-profile.decorator.ts`:删除未使用的 `import type { SessionRequest }`(存量 lint 错误,纯类型导入清理,无行为变化)。
4. `apps/web/playwright.config.ts`:填充 webServer —— 命令 `pnpm --filter @hmp/web exec vite --host 127.0.0.1`(等价 dev 脚本;显式 `--host 127.0.0.1` 与 baseURL 对齐,因 Vite/Node 缺省绑 localhost,在 localhost→::1 的机器上 127.0.0.1 不响应会导致 webServer 就绪探测超时,实测复现后修正),`url: http://127.0.0.1:5173`、`reuseExistingServer:!process.env.CI`、timeout 120s;port/baseURL 与原 config 一致,E2E_BASE_URL 仍可覆盖。e2e 冒烟页为公共骨架占位,不发起 API 请求,server 进程与 T012 夹具注入仍留待后续任务。
5. 新增文件:apps/server/test/unit/foundation-smoke.spec.ts、apps/web/test/foundation-smoke.spec.tsx、apps/web/test/e2e/foundation-smoke.spec.ts;根 package.json 新增 `verify:foundation`(上述 ①~⑦ 聚合)与 `verify:release`(占位 echo)。

### 范围声明

本记录仅声明 **Phase 1~2 基础工具链与骨架冒烟就绪**(T004~T012 能力 + 本任务三类显式冒烟):空库进入 generation2、旧已初始化库只读拒绝、公共骨架游客可匿名渲染、typed fetch 凭据/错误/取消行为、未认证管理读取被拒。**不代表 005 任何用户故事(US1~US8)功能完成,不代表 SC 指标、全量测试或 runtime 验收通过**;后续故事的新增业务测试按"先失败再随实现转绿"推进,完整门禁统一由 T144 的 `verify:release` 执行 —— 该入口本次仅建立占位脚本(仅 echo 绑定说明),未执行、未宣称通过。

---

## Wave A 验证记录(US1/US2/US5,T014~T043/T057~T072/T145/T146)

日期:2026-10-27。范围:三个 P1 用户故事实现完成后的集成验证;非最终 T144 全量门禁。

| 验证项 | 命令 | 结果 |
| --- | --- | --- |
| server 全量 | `pnpm --filter @hmp/server test` | 85 文件 / 1139 tests 全绿 |
| web 全量 | `pnpm --filter @hmp/web test` | 7 文件 / 50 tests 全绿 |
| lint / typecheck / build | `pnpm lint` / `pnpm typecheck`(双端)/ `pnpm build` | 0 错误 / 全 Done |
| e2e foundation | `playwright test test/e2e/foundation-smoke.spec.ts` | 2/2(E2E_SEED_SCALE=1) |
| e2e US1 游客浏览 | `E2E_SEED_SCALE=1 playwright test test/e2e/public-browse-guest.spec.ts` | 4/4 |
| e2e US2 登录选档 | `playwright test test/e2e/auth-profile-flow.e2e.spec.ts` | 3/3 |
| e2e US5 直播 | `E2E_SEED_SCALE=1 playwright test test/e2e/live.spec.ts` | 6/6(SC-005 与 API 100% 一致) |

新增用例计数:US1 server 39 + web 15 + e2e 4;US2 server 27 + web 17 + e2e 3;US5 server 47 + web 11 + e2e 6。

Lead 集成项:app.module 注册 PublicCatalogModule+LiveModule;routes.tsx 挂载 LivePage;PublicLayout 登录插槽接 IdentityMenu(T042/T043);playwright webServer 路径修正(apps/web 相对解析);scripts/e2e-servers.sh 种子模式对齐 DB_FILENAME=scale-fixture.hmp.db 且跳过重复迁移;8 个 T020/T013 用例适配 IdentityMenu 会话恢复异步(AppProviders 包装+401 打桩);lint 清理 12 处未使用导入/注解;退役 2 个并行期 e2e 组合根。

已知边界:bootstrap 非管理角色 403 仅服务级验证(DB CHECK 仅 owner/admin);选档一次性授予为进程内存(单实例语义,ADR-0002);公共海报 posterRef 恒 null(003 导入管线无同源海报资源,扩展点单一函数);US5 q 搜索=频道标题大小写不敏感子串(契约未规定字段)。

---

## Wave B 验证记录(US3/US7,T044~T056/T073~T087)

日期:2026-10-27。范围:两个 P1 故事(受控播放统一入口/设置解锁)实现完成后的集成验证。

| 验证项 | 命令 | 结果 |
| --- | --- | --- |
| server 全量 | `pnpm --filter @hmp/server test` | 93 文件 / 1195 tests 全绿 |
| web 全量 | `pnpm --filter @hmp/web test` | 11 文件 / 72 tests 全绿 |
| lint / typecheck | `pnpm lint` / 双端 tsc | 0 错误 |
| e2e US7 设置解锁 | `E2E_SEED_SCALE=1 playwright test test/e2e/settings-access.spec.ts` | 6/6(SC-007 负向矩阵;15min 自然到期留 T141/T144) |
| e2e US3 播放意图 | `E2E_SEED_SCALE=1 playwright test test/e2e/playback-intent.spec.ts` | 5/5(SC-003 游客点击/竞态/换档撤票) |

新增用例计数:US3 server 29 + web 8 + e2e 5;US7 server 27 + web 14 + e2e 6。

Lead 集成项:app.module 注册 SettingsModule;providers 挂 SettingsAccessProvider;coordinator 增 settingsPin 步骤+startSettings(AuthStep/stepTitles/renderStep/事件桥);identity-menu 设置入口接 startSettings 弹层流;bootstrap pin-recovery 事务补 revokeUnlockGrantsForProfile(US7 发现的选档授予残留缺口);US3/US1 相关 web 测试补 SettingsAccessProvider 包装;settings e2e 两场景适配统一弹层流。

---

## Wave C 验证记录(US4/US6/US8,T088~T136,T147,T148)

日期:2026-10-27。范围:三个 P2 故事(首页个人区/EPG 墙/设置七模块)实现完成后的集成验证。

| 验证项 | 命令 | 结果 |
| --- | --- | --- |
| server 全量 | `pnpm --filter @hmp/server test` | 109 文件 / 1362 tests 全绿 |
| web 全量 | `pnpm --filter @hmp/web test` | 18 文件 / 100 tests 全绿 |
| lint / 双端 typecheck | `pnpm lint` / tsc | 0 错误 |
| e2e US4 首页个人区 | home-personal.e2e.spec.ts(E2E_SEED_SCALE=1) | 5/5(双浏览器上下文) |
| e2e US6 EPG 键盘/恢复 | guide-keyboard-scroll-restore.spec.ts | 7/7 |
| e2e US6 SC-006 性能 | guide-performance.spec.ts | 达标:首个视图 20/20≤3s(中位105ms)、切日 19/20≤2s(1次2049ms离群)、回现在 20/20(本机开发环境;T141 家庭基线复测照旧) |
| e2e US8 设置 | settings.spec.ts(逐文件运行) | 7/7(键盘七子域读写+改密压轴;导入/同步断言至任务层——无 LAN_ALLOWED_TARGETS) |
| e2e US8 设置解锁 | settings-access.spec.ts | 6/6 |
| e2e Wave A/B 回归 | foundation/auth/public-browse/live/playback-intent/auth(全新库) | 2+3+4+6+5 全绿(auth-profile-flow 需无种子全新库) |

新增用例计数:US4 69 server+10 web+5 e2e;US6 60 server+7 web+8 e2e;US8 37 server+11 web+8 e2e+1 server 重启用例。

US8 路由迁移:旧 /api/{profiles(管理),sources,catalog,devices,policy} 管理入口全部迁入 /api/settings/* 并删除,无兼容别名;选档 GET /api/profiles 与 unlock/select 保留。28 个既有测试文件取线/契约同步更新;新增 helpers-management.ts 共享夹具(ensureSettingsUnlocked 等)。

已知遗留(记录于 T144 前收口):①apps/server/test/runtime-smoke.mjs(2195 行)仍按 005 前旧路由编写,迁移后 401——需按新 settings 路由改写后 test:runtime 才能作为 T144 门禁;②旧 POST /api/devices/{id}/playback-records/query 仍由 playback 模块挂载(其迁移涉及 runtime-smoke 收口);③混合多套件同窗 e2e 会触发公共限频抖动——按单文件运行(已文档化);④auth-profile-flow 与 settings 套件的数据前置不同(全新空库 vs 种子库),勿共用 E2E_SEED_SCALE。
