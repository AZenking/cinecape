# Research: 020-tmdb-programme-posters

日期：2026-11-13。以下为实施前必须关闭的技术决策；结论已落入 [plan.md](plan.md) 与 [data-model.md](data-model.md)。

## R1 — 为什么用 `search/multi` 而不是 search/movie + search/tv 或详情接口

- `search/multi` 一次返回 movie/tv/person，含 `poster_path`、`title/name`、`original_title/original_name`、`release_date/first_air_date`、`popularity`、`adult`。
- 分两次 `search/movie` + `search/tv` 会让每个标题至少 2 次调用；详情接口还需每个候选 1 次，放大 10 倍以上。
- 结论：**每标题 1 次 `search/multi`**，内存过滤 person/adult/无海报，不调用详情/图片/季集接口。
- 依据：TMDB v3 API Reference / Search - Multi；项目「尽量少调用」要求。

## R2 — 缓存键与归一化

- EPG 标题常带 `《》`、`（2024）`、`第1集`、`S01E02`、`高清/中字/国语`、`电影：` 等噪声；直接搜索会显著降低命中率。
- 缓存键必须与语言/标点/空格无关，才能让同一节目跨频道、跨来源、跨刷新复用。
- 结论：NFKC + 去标签/季集/年份/栏目前缀 + 去标点空白小写，得到 `matchKey`；另保留 `searchQuery` 供 TMDB 检索。年份单独存 `year_hint` 用于消歧。真实 EPG 常见 `上午剧场:伪装者(22)`、`36集连续剧：信者无敌（17）`、`20170921《辉煌中国》…` 形态，故规则同时剥离「…剧场:」槽位前缀、`N集连续剧：`、8 位日期前缀、纯数字括号集数/区间；`电视剧/剧场/宣传片` 等通用槽位进停用表，避免无效调用。
- 停用表只做精确短语匹配，避免把《新闻女郎》等影视误杀。

## R3 — 匹配接受门槛

- 宽泛模糊匹配会误配新闻/栏目/同名作品；家庭场景下错误海报比没有海报更糟。
- 结论：只接受候选 `title`/`original_title` 归一化后与查询键**完全相等**的 movie/tv；年份差 >1 拒绝；多候选按年份、标题来源、popularity、release_date、tmdb_id 确定性决胜。
- 无匹配 → `no_match` 负缓存，不反复查询。

## R4 — 缓存 TTL 与合规

- TMDB API Terms §1.C：不得缓存超过 6 个月；§3 要求署名；§2 默认禁止商业使用。
- 结论：matched TTL 默认 180 天且硬上限 180；no_match 30 天；failed 60 分钟；过期行不再下发；每次补全 GC `expires_at < now-30d`。
- 公共 footer 署名；README 说明隐私/条款/商业授权。

## R5 — 触发时机：事件驱动而非轮询

- 读取路径调用外部 API 会放大延迟与调用量；后台定时器增加生命周期与测试复杂度（014 已确立「无新增后台定时任务」惯例）。
- 结论：只在 EPG 刷新发布成功后补全一次；CLI 处理历史数据；无 cron/定时器。
- 发布前先读本地缓存，把有效 ref 随节目行同事务写入，避免刷新后海报短暂丢失。

## R6 — 并发、间隔、预算

- TMDB 官方说明历史 40 req/10s 限制已停用，当前上限约 40 req/s 且可能变化，必须尊重 429。
- 家庭 NAS 上外部请求应保守；EPG 刷新执行器本身串行。
- 结论：单进程串行 1 in-flight；最小间隔 150ms（≈6.7 req/s）；单次 300 次；总预算 90s；429 解析 Retry-After，401 熔断 60min，连续 5xx/429 熔断 5min；最多 2 次重试。
- CLI 与服务并行时最多 2 条；文档建议避开刷新时段；严格全局 1 条可后续加 SQLite 锁。

## R7 — 存储位置与 ref 模型

- 现有 010/014 已确立「不透明 ref + 注册表 + 同源代理」模式；复用可避免泄漏上游 URL、复用 SafeUpstream/限频/错误映射。
- 结论：`programme_poster` 行持有 32 位 hex `ref`；`epg_programme.poster_ref` 只存 ref；代理按 `(household_id, ref)` 单查。ref 仅在同 `tmdb_id+poster_path` 时保持不变，poster 变化才轮换。
- 不建 `poster_ref` 外键：缓存行可 GC，节目行保留旧 ref 时代理 404，前端回退。

## R8 — EPG 发布事务与网络 IO 分离

- 既有 `publishEpgWindow` 在单事务内删旧窗口/写新窗口；网络 IO 绝不能在事务内。
- 结论：发布前本地 `resolveCachedRefs`（同步只读）→ 发布事务写 `poster_match_key/poster_ref` → 发布后 `await enrichAfterEpgPublish`（事务外网络 + 短事务写回）。补全失败只 warn，不改变刷新成功状态。

## R9 — 图片代理与限频

- 节目单一页可能请求数百张海报；复用 `public` 120/min 桶会误伤 API 并导致图片失败。
- 结论：新增 `mediaImage` 600/min/IP 桶；海报代理 `Cache-Control: public, max-age=86400`；`loading=lazy`；窄块/列表按需渲染；不落盘。
- 上游仅允许 `TMDB_IMAGE_BASE_URL` 的精确 host；poster_path 严格正则；SafeUpstream 2MiB/8s/4s/≤3 跳；非 image/* 或非 identity → 502；超时 → 504。

## R10 — 测试策略（零真实网络）

- 真实 TMDB 调用不可进 CI：会依赖 Key、网络、配额，且不稳定。
- 结论：domain 纯函数单测；client 用 fake fetch（v3/v4/401/429/5xx/timeout/非法 JSON）；service 用 fake store/client 计数；contract 直插缓存行 + stub SafeUpstream；`NODE_ENV=test` 默认禁用真实网络。
- 真实运行时证据（有 Key）由维护者按 quickstart 执行并留档。

## 未关闭问题

无。所有实施所需决策已在本文件与 ADR-0021 中确定。