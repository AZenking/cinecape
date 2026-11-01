# T085 性能证据:SC001 缓存/搜索总期限 · SQL 批量无 N+1 · 大规模预算 · 全局工作队列上限

**任务**:docs/specs/010-online-vod/tasks.md **T085**(Phase 8 证据任务,依赖 T083 ✓ / T084 ✓)。
**交付**:`apps/server/test/contract/online-vod-budgets.e2e-spec.ts`(新增,12 例)+ 本记录。
**性质**:证据任务 —— 真实执行 + 如实记录;不具备的部分如实标注(见「六、未覆盖项」),不虚标。
**执行日期**:2026-10-31(Asia/Shanghai)。

---

## 一、执行环境与命令

| 项 | 值 |
| --- | --- |
| 主机 | macOS 27.2 / arm64(开发机,受控测试环境) |
| 运行时 | Node v24.19.0 · pnpm 11.28.5 · vitest 3.2.7 |
| 网络 | **零真实外网**:全部上游为 `createControlledMediaServer`(127.0.0.1 随机端口);服务端许可以 `LAN_ALLOWED_TARGETS='127.0.0.1'` 注入 |
| 隔离 | 每用例 `startFreshApp`(os.tmpdir 随机 DATA_DIR + 全量权威迁移 0001–0007);预算收窄经 `process.env` 注入(只许收紧),用例后恢复 |
| 工作目录 | `apps/server/` |

```sh
# 新 spec 单文件(三轮全绿,见 §二)
pnpm --filter @hmp/server exec vitest run test/contract/online-vod-budgets.e2e-spec.ts
# 全量回归(零回归,见 §七)
pnpm --filter @hmp/server run test:unit      # 1484/1484(与 T084 后基线一致)
pnpm --filter @hmp/server run test:contract  # 730/730(718 基线 + 本任务 12)
```

## 二、结果总览(12/12 绿,连续 3 次运行一致)

命令耗时:单文件 ≈ 15.8s/轮(2026-10-31 13:45:57 / 13:46:26 / 证据轮三次采样,断言含真实计时下界,三次逐例结论一致)。

| 组 | 用例 | 钉面 | 实测 |
| --- | --- | --- | --- |
| A | A1 默认契约总期限 | 健康+恒挂起源 → 全链在 `VOD_BUDGETS.search.totalTimeoutMs`(8s)内收敛 200 partial(ok+timeout)+reasons 非空;零源位置泄漏 | 耗时 8,340ms ≥ 8,000ms 下界(期限真实生效)且 ≤ 10,000ms 上界 |
| A | A2 并发队列上限 | 收窄 `VOD_SEARCH_TIMEOUT_MS=1200`:4 挂起源+1 健康,上游**峰值在飞恰为 3**(`search.concurrency`),第 4/5 源排队不并发;5 源全部尝试(ok+4×timeout) | 峰值在飞=3;耗时 1,491ms(≈收窄预算) |
| B | B1 恰界合法(20 线) | =`detail.maxLines` → 200,20 线全量 | ≈0.2s |
| B | B2 env 收窄 | `VOD_DETAIL_MAX_LINES=10`:同 20 线 wire → 422 `VOD_DETAIL_TOO_LARGE` 整次失败;同 ref 物化入口 410(零预览事实残留) | ≈0.2s |
| B | B3 恰界合法(单线 2000) | =`detail.maxEpisodesPerLine` → 200,2000 候选全量 | ≈0.2s |
| B | B4 env 收窄(单线) | `VOD_DETAIL_MAX_EPISODES_PER_LINE=1500` → 422 整次失败 | ≈0.2s |
| B | B5 恰界合法(合计 5000) | 20 线×250=`detail.maxEpisodesTotal` → 200,5000 候选全量 | ≈0.3s |
| B | B6 合计越界 | 19×250+1×251=5001(单线均 ≤2000)→ 422(契约默认值拦截,零 env) | ≈0.2s |
| C | C1 缓存中期上限·淘汰换入 | cap=26,000B(标定见 §四):第二搜索经「淘汰最早项」换入 **200(非 429)**;进程字节有界;被淘汰最早会话 searchId 重放 410 不复活;存活会话重放 200 条数一致 | 单次搜索账面实测 19,396B(26 条目);换入后 bytes ≤ cap,searchEntries=1 |
| C | C2 E1 语义复验 | cap=128B → 429 `VOD_CACHE_CAPACITY` + no-store + 脱敏;拒绝先于上游抓取,零半写入账面 | ≈0.2s |
| D | D1 分集大分页无 N+1 | 经真实链(搜索→预览→物化 105/305 子项→公共分集分页):prepare 语句数 **首页=翻页=跨规模=4 条/页**(基线 ≤8);listMedia 页码无关;每页 100 子项 | 语句计数 4/4/4(实测插桩读数,断言钉相等) |
| E | E1 测速内部并发 3 | 3 挂起候选 → 上游**峰值在飞恰为 3**(`SWITCH_PROBE_BUDGETS.concurrency`;串行峰值 1、无闸 >3 均可区分);全次 ≤5s 预算收敛为 timeout×3;零副作用 | 峰值在飞=3;耗时 3,336ms(≈单候选 3s 预算,远小于全次 5s) |

## 三、SC001 缓存/搜索总期限记录要点

SC001(quickstart.md Q1):「管理员完成 Settings 验证,添加 3 健康+1 超时源。游客 20 次搜索,每源 100 样本,>=19 次 8s 内看到结果及部分失败。全部失败区别于无匹配。」

**本任务交付的是 SC001 的服务端期限/部分失败/预算语义端到端钉面**(真实装配链+受控上游);其完整 20 次×每源 100 样本的浏览器采样属 T035(`us1-browse.md`)/T088 真实运行时证据任务,**本轮未执行**(诚实标注,见 §六)。服务端侧与既有证据面对应关系:

| SC001 要件 | 服务端证据(本任务) | 既有证据面(引用) |
| --- | --- | --- |
| 8s 总期限内出结果 | A1:共享 deadline 下健康+恒挂起双源,全链 8,340ms 收敛,下界钉死「期限真实生效」;预算值取自 `VOD_BUDGETS.search.totalTimeoutMs` 而非裸数字 | T022 B4(收窄 500ms → partial 形态)/B6(全超时 504);T028 A5(部分源超时+中止传播)/A6(全源失败 502 与全超时 504 区分) |
| 部分失败可见(区别于无匹配) | A1/A2:200 + `partial=true` + `reasons` 非空 + `sources[]` 状态混合(ok/timeout),健康源结果照常返回 | T028 A5/A7(200 空页非 partial 与部分失败区分) |
| 翻页/重试/取消/10min 失效 | —(TTL 推进面 e2e 无时钟快进,不伪称) | T028 A3/A4(分页 20/未消费保留/并发合并)/A8(注入时钟 410);T022 B2(重放不变);T083 E2(伪造游标/searchId 410 可达形态) |
| 10min/2000 结果/每家庭配额 | C1/C2(进程字节上限两分支) | T028 A9(2000 结果上限后不再抓取)/C1(每家庭活对象 429)/C2(进程上限收紧 429);配额值由 `vod-config.ts` 16 个 `VOD_*` env 表承载(只许收紧) |
| 无个人字段/源位置 | A1 抽查:响应零上游 origin/源 api 路径 + no-store | T083 B1/B2(全链零源地址/零个人字段)、B3(错误体脱敏);T022 B1(游客面) |

## 四、缓存全局上限(淘汰最早过期项)

- **上限触达 → 429(C2)**:`VOD_CACHE_MAX_TOTAL_BYTES=128` 时首个会话写入即 `put()=false` → 429 `VOD_CACHE_CAPACITY` + `no-store` + problem 白名单体;拒绝发生在上游抓取之前(缓存零半写入)。与 T083 E1 同源语义复验。
- **淘汰让位 → 换入(C1)**:cap=26,000B 为实测标定 —— 单次搜索(25 条目,整列表覆盖注入)账面 = **19,396 字节**(1 会话 + 25 标题绑定,`stats()` 读数);两次搜索总量必超上限,触发 `evictUntilFits`。实测:第二搜索 **200 换入(非 429)**,换入后 `bytes ≤ cap`、`searchEntries=1`;被淘汰的最早会话(首次搜索,`put()` 替换保留原 `createdAtMs` → 必为全表最老条目,任一淘汰事件必先移除之)searchId 重放 **410 `VOD_SEARCH_EXPIRED` 不复活**;存活会话重放 200 且条数一致。
- **排序语义引用而非重复**:「先淘汰全部已过期项,再按 expiresAtMs 升序 → createdAtMs 升序清在活项」由 `test/unit/online-vod/search-preview.spec.ts` C1/C2(注入时钟)钉面;e2e 无时钟快进(TTL 固定契约 10min),C1 钉的是同一淘汰路径的「最老在活条目先让位 → 换入新写」可达形态。

## 五、SQL 批量查询无 N+1 / 详情·候选大规模预算 / 全局工作队列

**无 N+1(D1,复用 T030 手法经真实链)**:同一 prepare 计数代理(`Database.db` 静态 getter 临时替换,`finally` 恢复;drizzle `getDb()` 按连接同一性自动重建)包住单次 HTTP 调用。真实链 = 搜索 → 预览 → 物化(105 与 305 子项整片发布)→ `GET /api/public/media/:id/episodes` 分页。实测语句数:**首页 = 翻页 = 305 子项首页 = 4 条/页**(与子项规模、页码无关;单查询+内存分组),`GET /api/public/media` 列表页码同样无关;每页 100 子项语义同场钉住。

**详情/候选大规模预算(B1–B6)**:恰界合法三面(20 线 / 单线 2000 / 合计 5000)默认预算全量 200;越界三面(env 收窄 `VOD_DETAIL_MAX_LINES=10`、`VOD_DETAIL_MAX_EPISODES_PER_LINE=1500`,以及零 env 的合计 5001)一律 422 `VOD_DETAIL_TOO_LARGE` **整次失败**且零预览事实残留(物化入口 410)。规模契约值(10 启用源/5000 父/100000 子/详情 20 线/单线 2000/总 5000/4MiB)由 `domain/vod-budgets.ts` + `infrastructure/vod-config.ts` 集中承载,fixture-upstream 世界可合成任意规模(D1 已以 105/305 经真实链验证物化→分集投影)。

**全局工作队列上限(A2 + E1)**:搜索 5 源并发闸 = `search.concurrency`(3),受控上游峰值在飞恰为 3,第 4/5 源在闸内排队、预算耗尽后不再发起;测速 3 挂起候选(单次 refs 上限 3,>3 refs 400 由 T067 钉面)峰值在飞恰为 `SWITCH_PROBE_BUDGETS.concurrency`(3),挂起候选按单候选 3s 预算收敛为 timeout(实测 3,336ms < 全次 5s),全程零会话/历史/物化/登记/intent/转换写入。观测面 = 受控服务器 `pendingResponseCount()` 在飞采样峰值。

**失败优化记录**:本任务**未触发任何性能优化** —— 12 例在夹具修正(双胞胎集键宽度、seeding 时间戳错开、5001 形态信封解析)后全绿,未暴露真实瓶颈;**生产逻辑零改动**,公开完整性与安全校验零降低,契约数值零改动。首轮发现的 4 处失败全部为测试夹具问题(与本仓「失败先辨真伪」口径一致),已在 spec 文件头注留痕。另有一处**与验证门禁相关**的最小修复:`src/contexts/online-vod/online-vod.tokens.ts` 两处 `import()` 类型注解改为顶部 `import type`(eslint consistent-type-imports,根级 lint 由此从既有红转绿;纯类型改动、运行时零变化、materialization.service 不回引本文件无环,全量 typecheck/lint/boundaries/purity 复验绿)。

## 六、引用的既有证据面(文件 + 用例号,引用而非重复)

| 面 | 文件 | 用例 |
| --- | --- | --- |
| 搜索轮转/去重/分页/并发合并/2000 上限/TTL/缓存上限 | `apps/server/test/unit/online-vod/search-preview.spec.ts`(16 例) | A1–A9(尤其 A5 部分超时+中止传播、A6 502/504 区分、A8 注入时钟 410、A9 并发闸 ≤3+2000 上限)、B1–B4(B3 预算 422/超时 504)、C1–C3(C1 家庭配额 429、C2 进程上限 429 不淘汰拒新写、C3 零写库) |
| SafeUpstream 预算/SSRF 全维度 | `apps/server/test/unit/online-vod/safe-upstream.spec.ts`(58 例) | 协议/DNS/每跳 redirect/内网/Abort/字节/嵌套预算全量 |
| 分集禁 N+1(单测面) | `apps/server/test/unit/catalog/vod-public-catalog.spec.ts` | 「T030 · 分集查询禁 N+1」:prepare 语句数 105→305 不变、翻页相同、listMedia 规模无关(:740–786);每页 100 子项(:347) |
| 批量目录上下文单次读取 | `apps/server/test/unit/catalog/batch-policy-context.spec.ts` | 「单次同步读取:查询数与候选规模无关(无 N+1)」(:249) |
| 搜索总期限收窄/全超时/超线路 | `apps/server/test/contract/online-vod-catalog.e2e-spec.ts` | B4(收窄 500ms → 200 partial)、B6(全超时 504)、C3(21 线 → 422)、B1/B2(整列表注入 25 条分页) |
| 安全面(预算/缓存/测速收敛) | `apps/server/test/contract/online-vod-security.e2e-spec.ts`(18 例) | A3(候选 hang 混合预算收敛)、C3(详情 >4MiB → 422 整次失败)、E1(缓存 128B → 429)、E2(伪造 ref 410)、D1–D4(限流桶+跨桶隔离) |
| 物化净配额(5000 父/100000 子收窄) | `apps/server/test/contract/online-vod-materialization.e2e-spec.ts` | B1(收窄注入并发净配额无超发)、B2(满额 409) |
| 保留/清理(候选大规模清理语义) | `apps/server/test/contract/online-vod-retention.e2e-spec.ts` | A1(24h 保护→清扫→配额回升/ID 不复用)、D1/D2(登记候选联合回收) |
| 预算契约值/16 env 表 | `apps/server/src/contexts/online-vod/domain/vod-budgets.ts`、`infrastructure/vod-config.ts` | `VOD_BUDGETS` 快照 + env 只许收紧(fail-fast) |
| 测速预算 | `apps/server/src/contexts/online-vod/application/switch-probe.service.ts` | `SWITCH_PROBE_BUDGETS`(单候选 3s/1MiB、全次 5s、内部并发 3,:64–73) |

## 七、验证矩阵

| 项 | 命令 | 结果 |
| --- | --- | --- |
| 新 spec | `vitest run test/contract/online-vod-budgets.e2e-spec.ts` | **12/12 绿 ×3 次**(13:45:57 / 13:46:26 / 证据轮)+ tokens.ts 类型修复后复验 12/12,红 0,无 skip |
| 单测全量 | `pnpm --filter @hmp/server run test:unit` | **1484/1484**(89 文件,≈97s;与 T084 后基线一致,零回归) |
| 契约全量 | `pnpm --filter @hmp/server run test:contract` | **730/730**(63 文件;718 基线 + 本任务 12,零回归;tokens.ts 类型修复后 13:59 复跑再证 730/730) |
| typecheck | `pnpm typecheck`(根) | 绿(server + web,含新文件与 tokens.ts 类型改动) |
| eslint | `pnpm lint`(根) | 修复前**红(既有)**:`online-vod.tokens.ts` 2 处 `import()` 注解违规(前序遗留,与本任务文件无关);按门禁要求做最小类型修复后**绿**(0 error/0 warning) |
| audit:boundaries | `pnpm --filter @hmp/server run audit:boundaries` | 绿(286 模块/1452 依赖无违规;tokens.ts 修复后复验) |
| audit:purity | `pnpm --filter @hmp/server run audit:purity` | 绿(application/domain 无禁止值导入) |
| audit:orphans | `pnpm --filter @hmp/server run audit:orphans` | **红(既有,与本任务无关)**:已验证移除本任务文件后同样失败(Unused files: location.service.ts 等 18 导出/109 类型,均为前序阶段遗留);本任务文件零新增 orphan |
| 生产代码 | `git status`/`git diff` | 本任务生产逻辑零改动;唯一 src 触碰为 `online-vod.tokens.ts` 纯类型 lint 修复(见 eslint 行);其余为新增测试文件 + 本证据文档 + tasks.md 勾选 |

## 八、未覆盖项(诚实标注,不虚标)

1. **SC001 完整浏览器采样**(20 次×每源 100 样本、游客边界脱敏 Network 证据):属 T035(`apps/web/test/e2e/online-vod-browse.spec.ts` + `evidence/us1-browse.md`)/T088 真实运行时证据任务,本轮未执行;本任务只钉其服务端期限/部分失败语义(A1/A2)。
2. **真实外网/真实硬件播放性能**(quickstart Q4 续播 20 次、Q6 双源切换 10 次等):属 T088,本轮未执行。
3. **TTL 推进面**(搜索/预览/候选 10min/60s 到期 410):e2e 无时钟快进,引用 search-preview A8/B3(注入时钟)与 T083 E2(伪造 ref 可达形态)。
4. **每家庭 100 活搜索/1000 活预览与 256MiB 缺省量级**:缺省值属 10²–10³ 活对象窗口,非 e2e 可构造;注入收窄面已钉(C1/C2、T083 E1、search-preview C1/C2)。
5. **预览 8s 总期限与 4MiB 读预算的挂起/超大 wire 形态**:引用 T028 B3(504/422)与 T083 C3(4MiB → 422),本文件不重复。
6. **缓存淘汰排序全序**(expiresAtMs 升序 → createdAtMs 升序):由 search-preview C1/C2 注入时钟钉面;C1 只钉「最老在活条目先让位 → 换入」可达形态。

## 九、结论

T085 的四类预算钉面(搜索总期限+并发队列、SQL 批量无 N+1、详情/候选大规模预算、缓存全局上限、测速内部并发)全部在真实装配链上端到端成立,预算断言值均取自契约快照(`VOD_BUDGETS`/`SWITCH_PROBE_BUDGETS`)而非裸数字;全量 1484+730 零回归;未暴露真实瓶颈,生产源码零改动。SC001 的服务端语义侧证据齐备,其浏览器全量采样按任务分工留待 T035/T088,不在此伪称通过。
