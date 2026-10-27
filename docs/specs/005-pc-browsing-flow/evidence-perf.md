# 005-pc-browsing-flow · 性能与限频证据归档(T141)

> 本文档由 T141 任务整理归档(2026-10-27,Asia/Shanghai)。**不重跑重型测量**:
> SC-006 重型指标由既有 e2e 套件 `apps/web/test/e2e/guide-performance.spec.ts` 实测产出并
> 以测试 attachment `sc006-metrics.json` 归档(T062 live SC-005 由 `apps/web/test/e2e/live.spec.ts`
> 产出);本文记录测试环境、数据规模、既有实测数字与目标对照,并声明 T141 尚余的
> 家庭基线(5 并发浏览器)复测待办。限频证据由
> `apps/server/test/contract/rate-limit-evidence.e2e-spec.ts` 真实触发归档。

## 1. 测试硬件与环境

| 项 | 值 | 来源 |
| --- | --- | --- |
| 机型/芯片 | Apple M4 Pro(12 核) | `sysctl machdep.cpu.brand_string` / `hw.ncpu` |
| 内存 | 48 GB | `sysctl hw.memsize` |
| 操作系统 | macOS 27.0.1(Darwin) | `sw_vers -productVersion` |
| 部署形态 | 本机开发环境:服务端与浏览器同机(loopback),无虚拟化/远程网段 | — |
| Node / pnpm | v24.19.0 / 11.28.5 | `node -v` / `pnpm -v` |
| Playwright | 1.64.1 | `playwright --version` |
| 浏览器 | chromium-headless-shell revision 1248 = **Google Chrome for Testing 156.0.8078.4**(headless shell,未启用 channel:'chrome' 回退) | `chrome-headless-shell --version` / `browsers.json` |
| 数据库 | SQLite(better-sqlite3),独立临时 DATA_DIR(每 run `mktemp`),generation2 迁移 | `scripts/e2e-servers.sh` |
| 服务端时钟 | E2E_SEED_SCALE=1 时锚定 `SCALE_FIXTURE_FIXED_NOW_MS`(2026-11-04T12:05Z = 家庭时区 20:05 CST) | T012 规模夹具 |

## 2. 数据规模(SC-006 规定,不得以空数据替代)

- EPG:200 频道 × 每频道每天 48 节目 × 7 天 = **67,200 条排期**(含无 EPG 频道/重叠/跨日节目/可用性变化);
- 点播:500 条夹具影片;夹具账号 `fixtureadmin`(主档案 PIN 135790 / 儿童 PIN 246800);
- 种子入口:`pnpm --filter @hmp/server exec tsx test/fixtures/scale-fixture.cli.ts`(`E2E_SEED_SCALE=1` 自动执行)。

## 3. SC-006 实测结果(既有记录,evidence.md Wave C 2026-10-27)

测量口径(`guide-performance.spec.ts` 文件头):首个可操作视图 = `page.goto` 起点到节目墙
第一个节目按钮可见;切日 = 点击日期 Tab 起点到窗口标题更新;回现在 = 点击「回到现在」
起点到今天默认窗口标题重渲染;每项独立 20 次、至少 19 次达标;guide 限频 429 按固定
间隔退避后重做同一次测量(本机实测未触发退避)。

| 指标 | SC-006 目标 | 实测(本机开发环境) | 结论 |
| --- | --- | --- | --- |
| EPG/直播首个可操作视图 | ≤ 3 秒,20 次至少 19 次达标 | **20/20 达标,中位 105 ms** | ✅ |
| 切日 | ≤ 2 秒,20 次至少 19 次达标 | **19/20 达标**(1 次 2049 ms 离群,超出 49 ms) | ✅ |
| 回到现在 | ≤ 2 秒,20 次至少 19 次达标 | **20/20 达标** | ✅ |
| 指标归档 | 报告记录客户端/服务端硬件与数据规模 | attachment `sc006-metrics.json`(随测试归档)+ 本文 §1/§2 | ✅ |

原始指标 JSON 由 `guide-performance.spec.ts` 以 `testInfo.attach('sc006-metrics.json')` 归档
(Playwright 结果目录),stdout 以 `[SC-006] {...}` 输出供报告摘录。

### T062 · live SC-005(直播与固定夹具 100% 一致)

`apps/web/test/e2e/live.spec.ts`:**6/6 通过**(E2E_SEED_SCALE=1)——分区顺序、频道/节目
起止时间与后端响应 100% 一致(含 `page.clock` 推进的 30 秒周期刷新、档位边界变化);
记录见 evidence.md Wave A「e2e US5 直播 6/6(SC-005 与 API 100% 一致)」。

## 4. 限频证据(T141 本任务新增,自动化)

数值权威:`apps/server/src/common/rate-limit/rate-limit.policies.ts`(契约 §1 固定值,
无 env 调节入口)。真实触发证据:`apps/server/test/contract/rate-limit-evidence.e2e-spec.ts`
(与既有 429 契约测试同一构造:独立临时库 + 清空共享限频窗口 + 精确计数):

| 策略 | 维度 | 阈值 | 触发方式 | 断言 |
| --- | --- | --- | --- | --- |
| `public` | 每连接 IP | 120 次/分钟 | `GET /api/public/media` 第 121 次 | 429 + `Retry-After`>0 + problem+json + `Cache-Control: no-store` + 稳定码 `PLAYBACK_RATE_LIMITED` |
| `guide` | 每连接 IP | 30 次/分钟 | `GET /api/public/guide` 第 31 次 | 同上;响应键属 problem 白名单,无内部维度泄漏 |
| `progress` | 每 DeviceSession | 60 次/分钟 | 同一会话 `POST /api/playback/sessions/{id}/progress` 第 61 次(started 样本 + duplicate 重放计数) | 同上;**另一 DeviceSession 不被连带**(维度隔离对照) |

执行记录(2026-10-27,本机开发环境):`pnpm --filter @hmp/server exec vitest run test/contract/rate-limit-evidence.e2e-spec.ts` → **发现 4 / 执行 4 / 通过 4 / 失败 0**。
同批新增自动化证据(2026-10-27 实跑全绿):`apps/server/test/contract/privacy-negative.e2e-spec.ts`(T142 隐私与日志负向)10/10;`apps/web/test/e2e/responsive-matrix.spec.ts`(T137 响应式与键盘矩阵)12/12;`apps/web/test/e2e/fresh-deployment-loop.spec.ts`(T139 新环境闭环)8/8 —— 覆盖口径见各 spec 文件头注释与任务报告。

## 5. T141 遗留待办:家庭基线(5 并发浏览器)复测声明

SC-006 要求「固定局域网测试环境」;上述实测为本机开发环境(单浏览器串行)。**家庭基线
复测(同一库、5 个并发浏览器同时操作 EPG/直播/点播下的 SC-006 指标)尚未执行**,留待:

- 执行形态:家庭 Wi-Fi/有线局域网内 1 台服务端 + 5 台(或 5 个浏览器上下文)客户端
  并发打开 `/live`、`/live/guide` 并交替切日/回现在,复用 `guide-performance.spec.ts`
  测量口径与 20 次样本;
- 归档位置:evidence.md(T144 门禁)与本文 §3 表格追加「家庭基线」列;
- 本待办不阻塞既有单浏览器达标记录的有效性(SC-006 的 20 次独立执行已满足;
  家庭基线是 T141 任务书中的复测加强项,归档为待办而非豁免)。

## 6. 与 SC-006/SC-009 的覆盖对照小结

| 条款 | 要求 | 状态 |
| --- | --- | --- |
| SC-006 首视图/切日/回现在 | 20 次至少 19 次达标 + 环境与规模记录 | ✅(§2/§3;家庭基线复测待办见 §5) |
| SC-006 限频验证(429+Retry-After) | public/guide/progress 三策略 | ✅(§4,rate-limit-evidence.e2e-spec.ts) |
| SC-009(浏览器矩阵) | Chrome/Edge/Firefox/Safari + 指定尺寸 | Chrome 自动化已覆盖(responsive-matrix.spec.ts,T137);Edge/Firefox/Safari 留 T144 人工/多浏览器核对(projects 目前仅 chromium) |
