# 007 行为零变化证据（T025 · Behavior Parity）

> 任务：US2 最后一步——以「A 路由清单 0 diff + B 全量门禁复跑 + C 新旧树真实 HTTP 响应快照对比」三重证据证明 007 后端 DDD 重组**行为零变化**。
> 当前树：HEAD `deb7700`（会话期间另有 docs-only 提交 `30b76db` 落库，`git diff --stat deb7700..30b76db -- apps/server` 为空，服务端源码零变化，全部证据对当前树继续有效；本文档与证据文件为本任务新增，未改动任何源码）。
> 生成时间：2026-10-28（Asia/Shanghai）。

## 0. 结论速览

| 组成 | 口径 | 结果 |
| --- | --- | --- |
| A 路由清单 | 基线 22 控制器/67 端点 vs 当前树同口径重提取 | **0 diff**（缺失 0 / 新增 0 / 五元组逐行 0 差异） |
| B-1 `pnpm --filter @hmp/server test` | vitest 全量 | **1376/1376 通过**（111 文件，190.03s，exit 0） |
| B-1b 契约子集复跑 | `vitest run test/contract` | **458/458 通过**（51 文件，126.3s，exit 0） |
| B-2 `pnpm test:runtime` | 真实构建产物 + 临时库 + 真实 HTTP 冒烟 | **PASS，assertionCount=465**（exit 0） |
| C 响应快照对比 | 新旧两棵树各自迁移初始化、同序列 65 步真实 HTTP 采样 | **65/65 一致，不一致数 = 0**（全量完成，未降级） |
| 降级条款 | 环境受阻则降级为「A+B+契约等价论证」 | **未触发**——C 全量完成 |

**结论：三重证据全部通过，未发现任何行为破坏信号。T025 验收通过。**

## 1. A — 路由清单 0 diff

- 基线：`evidence/routes-baseline.md`（迁移前，22 控制器 / 67 端点）。
- 迁移后清单：`evidence/routes-after.md`——按基线 §3 记载的同一生成方式（只读静态扫描 `apps/server/src/**/*.controller.ts` 21 文件 + 全仓 `@Controller\(` grep 交叉验证 + 各 `*.module.ts` `controllers: [...]` 与 `app.module.ts` imports 交叉核对），对当前树重新提取，并以脚本对**五元组（Controller/Verb/Path/Method/HttpCode）**逐行程序化比对。
- 比对脚本输出（原文）：

```text
baseline=67 current=67
removed(from baseline, missing now)=0
added(new, not in baseline)=0
sorted-position mismatches=0
RESULT: 0 DIFF
```

- 附带口径核验：显式 `@HttpCode` 端点数 27=27；动词分布 GET 29 / POST 24 / PUT 7 / PATCH 4 / DELETE 2 / HEAD 1 完全一致；`main.ts` 的 `setGlobalPrefix('api')` 保持不变。
- 迁移带来的**结构变化**（不属行为变化，已在 routes-after.md §1 记录映射）：`src/modules/*` 物理重组为 `src/contexts/*`（+ `src/platform/*`）；模块更名/合并 AuthModule+HouseholdModule→IdentityAccessModule、CatalogModule+PublicCatalogModule→MediaCatalogModule、LiveModule→LiveTvModule、PersonalModule→PersonalDataModule。路由五元组无一变化。
- **差异条目：无（若有差异应标红逐条列出——本节为零）。**

## 2. B — 全量门禁复跑

环境：Node v24.19.0 / pnpm 11.28.5（= `packageManager` 钉版）/ macOS arm64（Apple M4 Pro）。

| 命令 | 结果 |
| --- | --- |
| `pnpm --filter @hmp/server test` | **Test Files 111 passed (111)；Tests 1376 passed (1376)**；Duration 190.03s；exit 0 |
| `pnpm --filter @hmp/server exec vitest run test/contract`（单独复跑以钉住契约子集数） | **Test Files 51 passed (51)；Tests 458 passed (458)**；Duration 126.3s；exit 0 |
| `pnpm test:runtime`（`node apps/server/test/runtime-smoke.mjs`） | **`{"result":"PASS",...,"assertionCount":465,...}`**，S1–S9 全场景 OK（来源闭环/目录矩阵/EPG 全流程/名单闭环/性能基准/手动 EPG 绑定/播放负向矩阵/播放正向鲁棒性/记录），exit 0 |

- 契约等价论证：458 个 `test:contract` 用例即**真实 HTTP 契约证据**（supertest 打真实 Nest HTTP server），在迁移前基线（T004，见 §3.1 基线哈希）与当前树上为**同套件、同语义**且全绿——契约层等价的直接证明；B-1 全量 1376 含 unit+contract。
- 冒烟 465 断言为「编译产物 + 临时 SQLite 库 + 真实 HTTP + 本地受控 M3U/XMLTV 夹具」的非 mock 证据，迁移前后同一脚本语义（其 PASS 行逐字样例见本文件 §2 表内）。

## 3. C — 新旧树响应快照对比（全量完成）

### 3.1 基线树导出与构建（含基线哈希修正，须阅）

**基线哈希修正（可疑之处如实报告，未做任何修改）**：任务指定的 `88e6365` 经实测**不可构建、不可运行**——该提交本身执行了 `modules/personal/* → contexts/personal-data/*` 的**纯重命名移动**（`git show --stat 88e6365`：7 个 rename、0 增删行 + tasks.md 编辑），而 `playback.module.ts` 仍 `import ... from '../personal/personal.module'`，`tsc -p tsconfig.build.json` 报 5+ 个 TS2307（模块不存在）。因此：

- 真正的「迁移前最后可用提交」为其父提交 **`c0bbf90`**（`chore(007): T004/T006 evidence + audit soft-mode switch`）——这正是 T004 基线契约测试所在提交，且其目录布局与 `routes-baseline.md` §2 完全吻合（PersonalModule 位于 `src/modules/personal/`）。
- `88e6365` 相对 `c0bbf90` 在 `apps/server` 下**零内容变化**（纯 rename），对任何可运行代码行为无影响；以 `c0bbf90` 作旧树是**更严格且唯一可行**的选择。建议维护方后续修订 T008a/T025 相应口径记录。

**导出方式（择稳记录）**：未用 `git worktree add`（外置卷 worktree 元数据风险）也未用 `git clone --shared`，采用 **`git archive c0bbf90 | tar -x -C /tmp/007-baseline-tree`** 纯内容导出——先行核验 lockfile 无 git 依赖（`grep -c "git+" pnpm-lock.yaml` = 0），导出无需 `.git`，最稳。

| 步骤 | 命令（要点） | 耗时 | 结果 |
| --- | --- | --- | --- |
| 导出 | `git archive c0bbf90 \| tar -x -C /tmp/007-baseline-tree` | <1s | 21 个 `*.controller.ts`，`modules/personal/` 在位 |
| 安装 | `pnpm install --frozen-lockfile`（基线 monorepo 根；lockfile 与 `c0bbf90` 逐字节一致经 `cmp` 验证） | **6.7s**（温热 store；首次对 88e6365 的试装为 9.2s） | exit 0，postinstall（openapi-typescript + shared 构建）成功 |
| 基线构建 | `pnpm --filter @hmp/server build` | **2.6s** | `dist/main.js` + `dist/database/migrations/`(6 条) 生成 |
| 当前树构建 | `pnpm --filter @hmp/server build` | **2.5s** | `dist/main.js` + `dist/platform/database/migrations/`(6 条)；构建后 `git status` 仅新增证据文档，源码零改动 |

### 3.2 双树独立初始化与启动

- 各自空库迁移至**相同迁移终态**（6/6 条一致：`0001_init → 0006_pc_experience`）：
  - 旧树：`DATA_DIR=/tmp/007-data-old node apps/server/dist/database/migrate.js up` → 已应用 0001…0006，fresh-empty 预检通过；
  - 新树：`DATA_DIR=/tmp/007-data-new node apps/server/dist/platform/database/migrate.js up` → 已应用 0001…0006，fresh-empty 预检通过。
- 服务启动（同构 env，仅端口/DATA_DIR 不同）：`NODE_ENV=test PORT=3901|3902 DATA_DIR=… MEDIA_ROOTS=nas-main=/tmp/007-nas-root LAN_ALLOWED_TARGETS=127.0.0.1 node apps/server/dist/main.js`；两树 **1s 内** `/api/healthz` 同时 200，`{"status":"ok","database":"ok"}` 逐字一致。

### 3.3 采样矩阵（65 步 · 22/22 控制器全覆盖 + 三类强制负向）

采样器：`evidence/snapshot-parity/sampler.mjs`（同序列、同载荷对两树各跑一轮；Bearer 会话取自各自树登录）。夹具凭据（一次性临时库，已销毁）：`parityqa / Parity-passw0rd!`，主档案 PIN `135790`。

| 类别 | 步数 | 覆盖 |
| --- | --- | --- |
| 匿名/游客面（含 401 形态） | 20 | setup/status、healthz、public/context、public/live/groups、public/live/channels、public/guide、public/media(+/bogus/programmes)、media、me/favorites、me/history、playback resolve/sessions/renew/stream、household、profiles、settings/access、settings/profiles |
| 强制负向 N1 游客访问受保护路由 | 含上 | `GET /me/favorites/channels`、`GET /media` 等 → **两树均 401** |
| 初始化+认证编排 | 12 | initialize 201 → 重复 initialize **409** → 错误密码登录 **401** → 登录 200 → session → household → bootstrap-profile 201（主档案）→ profiles 列表 → unlock/select 200 |
| 强制负向 N2 匿名播放解析 | 含匿名面 | `POST /playback/resolve`（无凭证，合法载荷形态）→ **两树均 401** |
| 强制负向 N3 未解锁设置访问 | 10 | session 有效、无设置授予时 `GET /settings/{access,household,profiles,account,devices,sources,source-roots}`、`GET /settings/profiles/{id}/policy`、`POST /settings/catalog/candidates/query`、`PATCH /settings/household` → **两树均 403**（`GET /settings/access` 均返回未解锁态 200） |
| 设置授予后管理面 | 15 | POST /settings/access {pin} → access/household/profiles/account/devices/sources/source-roots/refreshes(bogus 404)/policy/candidates-query/epg-binding-query(404 同形)/epg-candidates-query(400 同形)/playback-records-query(404 同形)/device-revoke(400 同形) |
| 认证后用户面 | 8 | media 列表/详情/programmes、me favorites/history(+bogus)、playback session(bogus 404)、logout **204** → logout 后 session **401** |

控制器覆盖核对（22/22，每控制器 ≥1 路由）：Auth✓ Bootstrap✓ Setup✓ Household✓ Catalog✓ PublicCatalog✓ PublicGuide✓ LivePublic✓ Me✓ Playback✓ PlaybackStream✓ Profile✓ Health✓ SettingsAccess✓ SettingsAccount✓ SettingsDevices✓ SettingsEpgBinding✓ SettingsHousehold✓ SettingsPolicy✓ SettingsProfiles✓ SettingsSources✓ SettingsCatalog✓

### 3.4 规范化与对比方法（`evidence/snapshot-parity/compare.mjs`）

- 逐路由保存**状态码 + Content-Type + 响应体**；响应体做确定性规范化后再比：
  1. 易变值掩蔽：UUID/ULID 形 → `<uuid>`，ISO-8601 时间戳 → `<ts>`，13 位 epoch 毫秒 → `<ms>`，`token|secret|cookie` 键值 → `<token>`（两树各自生成的会话/实体 id 必然不同，掩蔽后比较结构与其他字段逐字节）；
  2. 对象键递归排序（排序规范化）；
  3. 状态码与 Content-Type 精确相等；网络错误视为不一致（实际 0 个）。
- 两树差异若存在将逐字节打印（比对脚本内置输出）；**本轮无任何差异输出**。

### 3.5 对比结果

```json
{"steps":65,"mismatches":0,"pass":true}
```

- **65/65 步一致；不一致数 = 0**（逐路由「状态码+规范化响应体」双树对照全量存档于 `evidence/snapshot-parity/compare.json`）。
- 状态语义抽查（两树同值）：游客 401、匿名 resolve 401、无授予 403、重复初始化 409、错误密码 401、logout 204、logout 后 401、bogus 引用 404 同形、未知载荷 400 同形——负向形态逐类一致。
- 唯二 400（`epg-candidates/query`、`devices/{id}/revoke` 的最小载荷）为两树**同 schema 同报文**的校验拒绝，本身即等价证据。

### 3.6 清理（C6）

- 两服务进程已终止（端口 3901/3902 连接拒绝 + `pgrep` 无残留）；
- `git worktree list` 仅主工作树（全程未使用 worktree，无 worktree 残留可清）；
- `/tmp/007-baseline-tree`、`/tmp/007-data-old`、`/tmp/007-data-new`、`/tmp/007-nas-root` 已删除；
- 基线树与临时库含一次性夹具数据，销毁即完成数据清零。

## 4. 降级条款

**未触发。** C 因环境受阻需降级为「A+B+契约等价论证」的条件（端口冲突/依赖安装失败/种子数据不可行）均未发生；C 以全量 65 步真实 HTTP 对比完成，证据强度高于降级口径。

## 5. 结论与限制

- A：路由清单 **0 diff**；B：**1376/1376 + 458/458 契约 + 465 断言冒烟**全绿；C：**65/65 快照一致、不一致数 0**。US2「行为零变化」验收通过。
- 限制（如实记录）：C 采样为「每控制器 ≥1 路由 + 三类强制负向」的 65 步矩阵（非 67 端点全量逐路由；未覆盖路由的行为由 B 的 458 契约用例与 1376 全量用例背书）；响应体比较对自生成 id/时间戳做掩蔽（结构与其余字段逐字节比较）；基线树以任务指定 `88e6365` 的父提交 `c0bbf90` 替代（§3.1，该指定提交本身不可构建，纯 rename 与父提交无行为差异）。
- 全程未修改当前树任何源码；未使用 `git stash`；仅新增证据文件。
