# T090 Phase 8 发布检查证据(release-checks)

> 执行:T090 子代理;时间 2026-10-31 17:53–18:30(Asia/Shanghai)。
> 环境:macOS(darwin arm64,Apple M4 Pro)、Node v24.19.0、pnpm 11.28.5、Playwright Chromium(headless)。
> 工作区:010 实现为未提交脏树(HEAD=cb3b39e);执行期间有并发 agent 活动的既往记录(evidence/us5-global.md §1)。
> 本文件如实记录 exit code/关键输出/时长,含失败;原始日志在会话临时区 `/tmp/t090-logs/`(易失,关键摘录已收录本文)。
> 基线参照(lead 提供):test:unit 1484+/89 文件、test:contract 730+/63 文件、web vitest 265+/36 文件、工具链四项绿、双审计绿、verify:release 首跑未知。
> quickstart 命令与实际脚本名核对:web Vitest 既有脚本名为 `test:vitest`(= `vitest run`),已用脚本名执行;其余命令与 quickstart 一致。

## 0. 命令结果矩阵

| # | 命令 | exit | 结果 | 时长 | 定性 |
| --- | --- | --- | --- | --- | --- |
| 1 | `pnpm gen:types` | 0 | 6 份 OpenAPI → shared DTO 全部生成(含 010 `vod-schema.d.ts`) | 3s | ✅ 绿 |
| 2 | `pnpm lint`(根) | 1 →(修复后)0 | 首跑失败:`action-coordinator.tsx 877:69 Parsing error`;最小 diff 修复后全绿 | 11s / 11s | ⚠️→✅ 新增缺陷已修(§2) |
| 3 | `pnpm -r typecheck` | 0 | shared/server/web `tsc --noEmit` 全过 | 4s(热缓存) | ✅ 绿 |
| 4 | `pnpm -r build` | 0 | shared+server(tsc/tsc-alias/迁移拷贝)+web(vite build,2073 模块);含既有 chunk >500kB advisory(1.58MB js) | 3s(并行+热缓存) | ✅ 绿 |
| 5 | `pnpm --filter @hmp/server test:unit` | 0 | **1484/1484 通过,89 文件** | 89s | ✅ 绿(=基线) |
| 6 | `pnpm --filter @hmp/server test:contract` | 0 | **730/730 通过,63 文件**;伴随既有 shutdown 噪音(§3.1) | 226s | ✅ 绿(=基线) |
| 7 | `pnpm --filter @hmp/web test:vitest` | 0 | **265/265 通过,36 文件**;act(...) 提示为既有非阻断噪音 | 6s | ✅ 绿(=基线) |
| 8a | `pnpm --filter @hmp/server audit:boundaries` | 0 | 286 模块/1452 依赖,零违规 | 1s | ✅ 绿 |
| 8b | `pnpm --filter @hmp/server audit:purity` | 0 | application/domain 零禁值导入 | <1s | ✅ 绿 |
| 9 | `pnpm verify:release` | **1** | 首跑在脚本内步骤⑥(④b `audit:orphans`/knip)失败;①–⑤步全绿;`set -e` 止步。剩余步骤已按脚本等价命令逐条补跑(§4) | 23s(至失败点) | ❌ 门禁红(§4/§5) |

## 1. 执行顺序与隔离复跑记录

按 quickstart 顺序执行;每个失败项均按「先隔离单跑一次再定性」处理:

| 失败项 | 首跑 | 隔离复跑 | 定性 |
| --- | --- | --- | --- |
| #2 lint 解析错误 | exit 1 | 单文件 eslint 复跑同错(确定性) | 新增缺陷 → 已修复(§2) |
| verify:release 步骤⑥ knip | exit 1 | 单跑 `pnpm --filter @hmp/server audit:orphans` 复现一致 | 新增失败,未代修(§4.1) |
| ⑥a 无种子组 A | exit 127(`env: -u: No such file or directory`) | 修正 env 参数顺序后复跑:2 passed(3.1s) | **执行器笔误,非套件失败** |
| ⑥b fresh-deployment-loop | 1 failed(②导入来源 240s 超时) | 隔离复跑同点超时;fake-IP DNS 实测活跃(§4.3) | 环境限制(§4.3) |
| ⑥c playback-intent | 1 failed(spec:268) | 隔离复跑同点同错;**HEAD 工作树复跑同点同错** | 既有缺陷(§4.2) |
| ⑥c settings-access | 1 failed(spec:103) | 隔离复跑同点同错;**HEAD 全绿 6/6;混合树(HEAD server+脏 web)复现** | 新增回归,web 侧(§4.4) |

## 2. 新增缺陷(已修复,最小 diff)

- **现象**:#2 `pnpm lint` 首跑 exit 1:`apps/web/src/app/action-coordinator.tsx 877:69 Parsing error: '...' expected`。
- **隔离定性**:单文件 eslint 复跑同错;`tsc --noEmit` 同点 TS1005(877,70)→ 确定性语法错误,非 flake、非环境。
- **根因**:JSX 注释 `{/* 010 回归修复…T082 Q9 导航 e2e 实测阻塞点 */}` 被写进 `<section>` 开标签的**属性列表内**(876–877 行)——JSX 属性位不允许表达式容器。该文件 mtime=当日 17:49:40(本检查开始前约 2 分钟),系并发 agent 新引入;lint/typecheck/build 三门同被阻塞。
- **修复(最小 diff,净 +1 行)**:注释块整体移出到上方条件表达式前的合法 JSX 子节点位,内容不动,仅追加一行来源备注;属性零改动。修复后单文件 eslint 绿 → 全仓 lint 绿(exit 0);typecheck/build 随后全绿。纯注释位置移动,无行为影响。

## 3. 失败与噪音归类

### 3.1 既有噪音(未阻断,不计失败)

- **契约测试 shutdown 噪音**:#6 打印 22 处 `SqliteError: no such table: playback_conversion`(Nest `onApplicationShutdown` → `PlaybackLifecycleService.listActiveConversionRows`,playback-lifecycle.service.ts:592)。出现在 readiness-owner / public-media-detail / public-context / playback-policy-resource-rejection 等套件的临时库关闭钩子(其建表子集不含 010 `playback_conversion` 表)。**exit 0、730/730 全过,不属失败**;留档供 lead 判断是否需要关闭钩子判表静默(本次未改)。
- **web vitest act(...) 提示**:React `not wrapped in act(...)` 警告若干,既有,非阻断。

### 3.2 既有 flake 清单(本轮观察)

- lead 提供的 flake(action-coordinator「游客选档」满载偶发、conversion-delivery 负载偶发、web 全量偶发单例)本轮均未出现:server unit/contract、web vitest 均一次通过。

### 3.3 环境限制(本机 VPN fake-IP DNS)

- 实测活跃:`node:dns.resolve4('192.168.100.206')` → `198.18.6.129`(RFC 2544 假 IP),`dns.lookup` 同字面量 → 真值。与 evidence/us5-global.md §6/§9 记录一致(c-ares 通道被 VPN fake-IP 模式劫持)。
- 影响:⑥b fresh-deployment-loop 的导入链(T139)在本机当前 DNS 状态下不稳定(§4.3);干净 DNS 环境一条命令可复跑。

## 4. verify:release 分步结果

脚本 `scripts/verify-release.sh`(set -e,日志 `/tmp/t090-logs/verify-release-logs/step-*.log`):

| 脚本步骤 | 内容 | 结果 |
| --- | --- | --- |
| ① gen:types | | ✅ 3s |
| ② lint | | ✅ 11s(此时 lint 已被 §2 修复) |
| ③ typecheck(-r) | | ✅ 4s |
| ④ build(-r) | | ✅ 4s |
| ⑤ audit:boundaries | | ✅ 0s |
| ⑥ **audit:orphans(knip)** | | ❌ **exit 1,整体在此止步** |
| ⑦~⑮(未到达) | audit:purity / server 全量 vitest / web 全量 vitest / E2E ⑥a⑥b⑥c / runtime 冒烟 | 已按脚本等价命令逐条补跑,见下 |

### 4.1 步骤⑥ knip(007 零遗留门禁)——新增失败,未代修

- 报告:**1 个死文件 + 18 个死导出 + 109 个死导出类型**(共 128 项)。死文件:`src/contexts/online-vod/application/location.service.ts`。
- 归属核验(既有/新增判定):12 个涉事文件中 **11 个在 HEAD 不存在**(online-vod contexts、playback work-set port、safe-upstream、online-vod fixtures 等均为本工作树新增);`schema.ts` 在 HEAD 为 1199 行、现 2293 行,被标记类型全部位于 010 新增段(2272–2293)。**失败面 100% 为 010 实现树新增**。
- 处置:未代为批量删除。理由:① 128 项清理集中在 online-vod/playback 热区,该区有并发 agent 持续编辑,批量删导出冲突风险高、不属「最小 diff」;② 死导出不破坏产品行为,属 007 卫生门禁,应由 010 实现 agent 收口。**移交 lead 派发**:删 `location.service.ts` + 清理未消费导出/类型;`test/fixtures/online-vod/fixture-world.ts` 的 18 项中部分可能属「仅测试消费」,按 knip.json 既有约定可评估纳入 entry。

### 4.2 脚本步骤⑤ 等价补跑:server/web 全量 vitest——绿

- `pnpm --filter @hmp/server test`:**2214/2214 通过,152 文件**(unit+contract 合跑),332s,exit 0。
- `pnpm --filter @hmp/web test`:265/265,36 文件,7s,exit 0。

### 4.3 脚本步骤⑥b 等价补跑:fresh-deployment-loop——环境限制

- 命令(与脚本一致):`CI=1 LAN_UPSTREAM_IP=192.168.100.206 LAN_ALLOWED_TARGETS=192.168.100.206 MEDIA_ROOTS=nas-main=<mktemp 临时NAS根> playwright test --workers=1 test/e2e/fresh-deployment-loop.spec.ts`。
- 结果:8 用例,①账号自举 passed;**②「导入来源:IPTV+NAS 双双发布成功」240s 测试超时**;③–⑧未运行。exit 1,245s。
- 定性:**环境限制,非产品缺陷**。隔离复跑同点超时;fake-IP DNS 实测活跃(§3.3);与 us5-global.md §9 记录的 lead 17:40 复跑同型(导入 job failed,归因 VPN fake-IP DNS)。干净 DNS 环境复跑后再定性。

### 4.4 脚本步骤⑥a/⑥c 等价补跑:Playwright 种子/无种子组

| 组 | 套件 | 结果 | 用时 | 定性 |
| --- | --- | --- | --- | --- |
| ⑥a 无种子 A | foundation-smoke + auth-profile-flow | 2 passed | 3.1s | ✅(首跑 127 为执行器 env 参数顺序笔误,非套件失败) |
| ⑥c | guide-keyboard-scroll-restore | 7 passed | 9s | ✅ |
| ⑥c | guide-performance(SC-006,20 次×3 采样) | 1 passed(首视图 p50 183.5ms/切日 182ms/回到现在 161ms,全部 20/20 达标) | 140s | ✅ |
| ⑥c | home-personal | 5 passed | 13s | ✅ |
| ⑥c | live | 6 passed | 7s | ✅ |
| ⑥c | **playback-intent** | 2 passed,1 failed,2 未运行 | 10s | ❌ **既有缺陷**(见下) |
| ⑥c | public-browse-guest | 4 passed | 6s | ✅ |
| ⑥c | responsive-matrix | 12 passed | 23s | ✅ |
| ⑥c | **settings-access** | 0 passed,1 failed,5 未运行 | 10s | ❌ **新增回归**(见下) |
| ⑥c | settings | 7 passed | 13s | ✅ |

**⑥c playback-intent「准备中连点/换目标:仅最新内容可起播」——既有缺陷(3/3 确定性,非 flake)**

- 失败点:`test/e2e/playback-intent.spec.ts:268` `expect(firstTitle).not.toBe(secondTitle)`,两枚直播播放按钮 aria-label 解析出同名频道「夹具频道 002」。
- 隔离复跑 ×2 同点同错;**HEAD 工作树(cb3b39e,与 010 脏改动完全隔离)复跑同点同错** → HEAD 上即失败,010 实现未引入,亦不在 lead flake 清单。属既有真实问题(或夹具数据/选择器假设过时),移交 lead 定位(最小线索:E2E_SEED_SCALE=1 下 /live 列表前两枚「当前直播」按钮同名;可先核对种子频道命名与去重)。

**⑥c settings-access「主 Profile:菜单设置入口 → 独立 PIN 验证 → …」——新增回归(web 侧,2/2 确定性)**

- 失败点:`test/e2e/settings-access.spec.ts:103` `toHaveURL(/\/settings\/account$/)`——正确 PIN 验证后弹层关闭,但 URL 停留 `/`(快照:无弹窗、停在首页;错误 PIN 分支的正常告警路径通过)。
- 三角定位:
  1. HEAD 工作树复跑 **6/6 全绿**(8.7s);
  2. 混合树(**HEAD server + 脏 apps/web + 脏 packages/shared**)复现同点失败 → **回归在 web 侧脏改动,非 server**;
  3. 静态排查:`sanitizeReturnTarget('/settings/account')` 合法且未改;`routes.tsx` diff 仅新增 `/vod/titles/:titleRef` 路由、无新守卫;`settings-access-provider.tsx` 未改;coordinator diff 未触碰 `handleSettingsPinSubmit`/`startSettings`/`isStaleIntent`/`'complete'` 机制(仅 `playEnd` 派发位与 010 换源恢复面板)。
- 最小定位(移交):失败面收口在 `apps/web/src/app/action-coordinator.tsx` `handleSettingsPinSubmit` 成功路径(现 578–590 行)——`await settingsAccess.unlock(pin)` 后弹层消失但导航未发生,机制上与「intent 在 await 期间被判 stale 提前 return(弹层因 intent 清理而消失)」或「navigate 未生效」相容;需带 instrumentation 的交互调试定分派者。嫌疑面:010 T079/T080 的协调器观看身份观察/`terminatePlaybackIntent` 收口、`shared/query/keys.ts` 个人键改造、settings 各页 PinField 化(`settings-unlock-gate.tsx` 已改用 `PinField`,其错误告警路径工作正常)。**未代修**:根因未闭合前在热区改认证/导航流风险高。

### 4.5 脚本步骤⑦ 等价补跑:runtime 冒烟——绿

- `pnpm test:runtime`:**PASS**,151s,exit 0;phase2+phase3 共 9 场景、465 断言(来源闭环/目录矩阵/EPG/名单/性能 20/20≤2s p95 69.4ms/手动绑定/播放负向矩阵/播放正向鲁棒性/SC-004 记录),含转码交付与额度 BUSY 真实出现。

## 5. 结论(T090 发布门禁:未通过,如实判定)

**发布门禁判定:❌ 不通过(本次树,本机环境)。** 无虚标;逐类归因如下:

| 类别 | 项 | 状态 |
| --- | --- | --- |
| ✅ 已修复(本任务,最小 diff) | lint/typecheck/build 三门被阻塞的 JSX 属性位注释语法错误(action-coordinator.tsx) | 修复后三门全绿 |
| ✅ 绿(=基线或更好) | gen:types;typecheck;build;server unit 1484/1484(89 文件);server contract 730/730(63 文件);server 全量 2214/2214;web vitest 265/265(36 文件);audit:boundaries;audit:purity;runtime 冒烟(465 断言);E2E 10/12 套件(56 用例) | — |
| ❌ 新增失败(待 lead 派发修复) | ① knip 零遗留门禁:128 项死文件/死导出/死类型,100% 为 010 树新增(§4.1);② settings-access e2e 新增回归:PIN 验证成功后不导航,web 侧(§4.4) | 阻塞 verify:release |
| ❌ 既有缺陷(非 010 引入) | playback-intent「准备中连点/换目标」:HEAD 同点同错,3/3 确定性(§4.4) | 不阻塞 010 定性,但阻塞门禁绿 |
| ⚠️ 环境限制 | ⑥b fresh-deployment-loop 导入超时:本机 VPN fake-IP DNS 实测活跃,与 us5-global §6/§9 同型;干净 DNS 复跑后再定性(§4.3) | 不定性为产品缺陷 |
| ➖ 未覆盖 | T090 quickstart 提及的 web Playwright 中 `online-vod-global.spec.ts`、`identity-isolation.e2e.spec.ts` 不在 verify-release.sh 套件清单内(脚本为 005 时代清单);两者此轮未在门禁内运行 | 留档供 lead 决策 |

- **对 T090 任务字面项**:10 项命令全部实际执行并有记录;除 lint 缺陷已修外,其余失败均未隐瞒、未虚标通过。
- **verify:release 结论**:首跑红(knip 止步);剩余步骤等价补跑后,工具链/单元/契约/组件/审计/冒烟全绿,E2E 12 套件中 10 绿、1 既有红(playback-intent)、1 新增回归红(settings-access),⑥b 环境受限。**在 knip 清理 + settings-access 回归修复 + ⑥b 干净 DNS 复跑完成前,发布门禁不得标绿。**
- 本任务产品代码改动仅 §2 的 1 处最小修复(净 +1 行注释移位);另归档本文件。无 commit/push。

---

## §-final lead 复跑与归并（2026-10-31 19:52–20:05 +08:00）

1. **全量 verify:release 复跑**（lead）：①gen:types✅2s ②lint✅12s ③typecheck✅4s ④build✅ ⑤a server unit✅（进行中转 ⑤b）——**⑤b web vitest 失败 1/265**：action-coordinator「游客选档」已知负载 flake（隔离复跑 **5/5 绿**×即时确认，见 flake 清单）；脚本止步于此。
2. **隔离复跑补全**（等价命令同 env）：
   - web vitest 隔离：action-coordinator.spec **5/5 绿**（flake 确认，非回归）
   - **⑥c 九套件逐文件重跑：48/48 全绿**——含 **settings-access 6/6**（T090 遗留项 2 的 web 回归已由修复 agent 收口：根因=PinField(input-otp) 满位替换截断，失败清凭据 1 行修复）与 **playback-intent 2/2**（T090 记录的「同名双按钮」既有缺陷本次未复现，通过）
   - **⑦ test:runtime：PASS，465 断言**（当前树复跑；S1–S9 全场景含 SC-004 记录/转码交付/额度 BUSY/watchdog）
3. **knip 门禁**：T090 遗留项 1（128 项死面）已由清理 agent 收口——`audit:orphans` **128→0（exit 0）**，146 项处置（死文件/死导出/死类型删除 + schema.ts 投影按 drizzle 发布面惯例 entry），post-cleanup verify:release ①–⑩ 全绿（清理 agent 报告）。
4. **⑥b fresh-deployment-loop**：环境限制（本机 VPN fake-IP DNS 劫持 c-ares，需真实 LAN m3u 上游 192.168.100.206 可达）——维持 T090 归类，干净 DNS/目标网络环境一条命令可复跑。

### 最终门禁判定
- ①–⑤a＋⑥a＋⑥c＋⑦：**全绿**（含隔离复跑定性）
- ⑤b：负载 flake（隔离 5/5 绿）
- ⑥b：环境限制（Not-run，证据 us5-global §6/§10）
- 结论：**010 发布门禁在可执行范围内全部通过**；Not-run 项（⑥b/T050/T066/T076/T088 真实环境采样）已按任务约定如实记录未完成，不标 Verified。
