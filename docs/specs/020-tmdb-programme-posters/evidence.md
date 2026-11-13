# Evidence: 020-tmdb-programme-posters

日期：2026-11-13。实施完成；真实 TMDB 网络/浏览器证据待维护者提供 Key 后执行。以下结果为本次本地执行记录。

## 自动化证据

| 门禁 | 命令 | 结果 |
| --- | --- | --- |
| 类型生成 | `pnpm gen:types` | PASS（003/005 生成物含 `posterRef`） |
| shared 构建 | `pnpm --filter @hmp/shared build` | PASS |
| Lint | `pnpm lint` | PASS |
| Typecheck | `pnpm typecheck` | PASS（shared / server / web） |
| 构建 | `pnpm build` | PASS（server + web + shared） |
| 迁移 drill | 临时 `DATA_DIR` 下 `pnpm --filter @hmp/server migration:drill` | PASS（12 条迁移 up→down→up；`programme_poster` 与两列存在） |
| 迁移单测 | `vitest run test/unit/migration-0012.spec.ts` | PASS（4） |
| Domain 单测 | `programme-title.spec.ts` / `programme-poster-match.spec.ts` | PASS（8 + 7） |
| TMDB client 单测 | `tmdb-client.spec.ts` | PASS（8；0 真实网络） |
| 补全服务单测 | `programme-poster.service.spec.ts` | PASS（8） |
| 代理单测 | `programme-poster-proxy.spec.ts` | PASS（5） |
| 刷新执行器 | `refresh-executor.spec.ts` | PASS（22；含发布写 key/ref、缓存命中 ref 预写） |
| 手工 EPG 迁移 | `manual-epg-migration.e2e-spec.ts` | PASS（7；迁移终态含 0011/0012） |
| Guide 查询 | `guide-window-query.spec.ts` | PASS（21；含 `posterRef` 透传/null） |
| EPG 契约 | `epg-programmes.e2e-spec.ts` | PASS（5；DTO 含 `posterRef:null`） |
| 海报代理契约 | `public-programme-posters.e2e-spec.ts` | PASS（5；200/404/400/502/gzip） |
| Web 全量 | `pnpm --filter @hmp/web test` | PASS（88 文件 / 586 用例，1 skipped） |
| 020 服务端聚合 | 12 文件（migration/domain/client/service/proxy/guide/executor/epg+poster+manual contracts） | PASS（115 用例） |
| 回填 CLI dry-run | `tmdb:backfill -- --limit=10 --dry-run` | PASS（`missingKey/missingRef` 统计，无联网） |
| 回填 CLI 无 Key | `tmdb:backfill -- --limit=10` | PASS（keys=10；lookups=0；skipped=10） |

## 关键行为证据

- **发布预写**：`RefreshExecutorService` 在发布前调用 `resolveCachedRefs`（零网络）；命中缓存时 `epg_programme.poster_ref` 与节目行同事务写入；单测断言缓存 ref 原样落库。
- **发布后补全**：补全服务先恢复有效缓存，再仅对缺失/过期标题联网；第二次同标题运行 `lookups=0`；负缓存 30 天内不重复调用。
- **节流/上限**：单进程串行；`TMDB_LOOKUP_INTERVAL_MS=150`；`TMDB_MAX_LOOKUPS_PER_RUN=300`；`TMDB_RUN_BUDGET_MS=90000`；401 熔断/429 Retry-After/5xx 重试上限均有单测。
- **读取零调用**：guide/live/epg 只读 `epg_programme.poster_ref`；契约/单测通过 fake 客户端计数断言无 `search/multi`。
- **代理安全**：32 hex ref、matched/未过期、poster_path 白名单、精确 image host、SafeUpstream 2MiB/8s/4s/≤3 跳；伪造/过期/非 matched/上游失败均按 404/502/504。
- **UI**：详情抽屉 2:3 海报 + 频道回退；墙宽块缩略图；列表行缩略图；`loading=lazy`；公共 footer TMDB logo + 声明；Web 测试覆盖。

## 已知非本规格的既有失败（透明记录）

本次全量 `pnpm test` 记录为 **2359 passed / 122 failed / 1 skipped（19 个文件失败）**；随后又修复了 `epg-settings` 的 `posterRef` 断言与两处迁移清单，剩余失败仍集中在 playback 等夹具（未逐项重跑全量）。这些夹具只应用部分迁移（不含 0011）或直接以 Drizzle schema 写入 `media_item.visible`，而 018 已把 `visible` 纳入 schema/策略查询，属 018 实现与测试夹具未同步的既有问题；020 未改动这些路径。

- 典型错误：`table media_item has no column named visible` / `no such column: "visible"`（`test/fixtures/playback/playback-fixtures.ts`、playback 授权/selection/ticket/watchdog 等）。
- 020 顺带修正的两处既有偏差：`insertMediaItem` 默认频道可见性改为 1（对齐 018 spec A-002「新导入频道保持可见」）；`manual-programme-priority`/`candidate-ordering` 测试迁移清单补到 0012。相关既有失败已消除（channel-logo merge/convergence、manual-programme-priority、candidate-ordering、epg-settings）。
- 本次 `pnpm test:runtime` 亦在「成人目录 = 3 频道 + 2 视频」断言失败（实际 2）；该 smoke 依赖既有频道可见性/目录行为，020 未改动该路径。

`audit:boundaries` 另有 5 条既有违规（sources→live-tv domain、online-vod→platform/upstream、media-catalog→platform/database）；`audit:purity` 1 条既有违规（catalog-admin.service 值导入 database）。020 新增的 `sources.module → epg.module` 深导入已改为经 `@contexts/epg` 发布面，本条已消除。

## 迁移证据

- 0012 up：`programme_poster` 表、`epg_programme.poster_match_key/poster_ref`、索引存在。
- 0012 down：表/列/索引删除，既有 `epg_programme` 行保留。
- drill：up→down→up 全应用；readiness `REQUIRED_COLUMNS`/`EXPECTED_*` 一致。
- 本地 dev DB 已执行 `pnpm migration:up`（自动备份 `hmp.db.bak-1794540517076`）；未执行 down/drill 于用户库。

## 契约/负向证据

- 有效 ref → 200 image/png + `Cache-Control: public, max-age=86400`。
- 伪造/格式非法/过期/非 matched → 404 `NOT_FOUND` 同形。
- 上游 text/html → 502 `PROGRAMME_POSTER_UPSTREAM_FAILED`；gzip → 502 同码。
- 未知 query → 400 `VALIDATION_FAILED`。
- 响应体不包含上游地址片段。

## 真实运行时证据（2026-11-13 部分执行）

维护者已提供 v4 Read Access Token，写入 `apps/server/.env`（`.env` 被 gitignore，不入库）。

- [x] TMDB API 连通：`GET /3/search/multi?query=沙丘&language=zh-CN&region=CN` → HTTP 200，20 条结果（首条 movie 438631 沙丘，poster `/pJ39749QfmtCJELCct9JzMTtrjE.jpg`）。
- [x] 真实 CLI 回填（小批量，保护 API 配额）：`--limit=20` → lookups=19 / matched=2 / noMatch=17；`--limit=100` → cacheHits=19 / lookups=64 / matched=0 / noMatch=64。缓存行 `expires_at` 为 180 天后。
- [x] 真实海报图片：`https://image.tmdb.org/t/p/w342/bqQ1cZdPwG5rDCoblr3naoHzXHN.jpg` → HTTP 200，`image/jpeg`，342×513，27,643 bytes。
- [x] 同源代理真实请求：运行中的服务 `GET /api/public/media/programme-posters/<matched-ref>` → HTTP 200，`Content-Type: image/jpeg`，`Cache-Control: public, max-age=86400`，57,873 bytes。
- [x] 标题清洗升级后的真实样本：`1001夜剧场:生万物(4)`→生万物、`上午剧场:伪装者(22)`→伪装者、`36集连续剧：信者无敌（17）`→信者无敌、`战狼2`→战狼2、`电视剧：三大队`→三大队 均 matched；`桃花朵朵开` no_match。
- [x] `--rekey` 全量本地重算后：`programme_poster` 7 matched / 184 no_match；`epg_programme` 115 行有 `poster_ref`（此前 1 行）。CLI 已跳过仍有效的 no_match/failed 负缓存，连续 `--limit=5` 第二轮 `cacheHits=0/lookups=5`，证明分批回填会向前推进。
- [x] 真实 EPG 标题统计：7,769 个 distinct title；25 个通用槽位标题占 4,749 条节目；1,570 个标题命中栏目/集数/日期清洗规则（可被新规则重新匹配）。
- [ ] 完整 EPG 刷新链路（自动补全日志）与第二次刷新 `lookups=0`：待重启服务后执行。
- [ ] 移除 Key/错误 Key/断网的回退与无重试风暴：待执行。
- [ ] 浏览器墙/列表/详情视觉与 footer 署名：待浏览器验收。

> 已执行部分为小批量真实调用；未执行项不得标记为 Verified。