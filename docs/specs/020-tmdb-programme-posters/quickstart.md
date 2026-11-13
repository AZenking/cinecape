# Quickstart: TMDB 节目海报（020）

## 1. 前置

- Node 24 / pnpm 11；已按 README 安装依赖、迁移并启动。
- 可选：TMDB v3 API Key 或 v4 Read Access Token。没有 Key 时功能自动关闭，节目单行为与现状一致。

## 2. 配置

在 `apps/server/.env`（或 Docker 环境）加入：

```dotenv
TMDB_API_KEY=你的_v3_key
# 或
# TMDB_READ_ACCESS_TOKEN=你的_v4_token
TMDB_LANGUAGE=zh-CN
TMDB_REGION=CN
# 可选节流（默认值）
# TMDB_MAX_LOOKUPS_PER_RUN=300
# TMDB_LOOKUP_INTERVAL_MS=150
# TMDB_RUN_BUDGET_MS=90000
# TMDB_MATCHED_TTL_DAYS=180
# TMDB_NEGATIVE_TTL_DAYS=30
# TMDB_FAILURE_TTL_MINUTES=60
```

Docker Compose 已支持 `${TMDB_API_KEY:-}` 等可选注入；也可用 `--env-file`。

## 3. 迁移与启动

```bash
pnpm migration:up
pnpm dev
# 或 docker compose up --build
```

`0012_programme_posters` 会新增 `programme_poster` 表与 `epg_programme.poster_match_key/poster_ref` 两列；旧数据不改写。

## 4. 触发匹配

1. 在设置中配置一个 EPG 源并执行刷新（或等待既有刷新任务）。
2. 刷新日志应出现一行汇总：

```text
[tmdb] household=... titles=... cacheHits=... lookups=... matched=... noMatch=... failed=... skipped=... durationMs=...
```

3. 打开 `/live/guide`：墙/列表/详情出现海报；未匹配节目回退频道 Logo。

## 5. 验证最小调用

- 同一 EPG 源再刷新一次：预期 `lookups=0`（只有新标题会增加）。
- 浏览节目单/详情不会产生 `search/multi` 调用；图片只走 `/api/public/media/programme-posters/<ref>`。
- 错误 Key：日志 warn，刷新仍 succeeded，节目单仍可用。
- 移除 Key 重启：无 TMDB 请求，已有缓存海报仍可显示（图片 CDN 可达时）。

## 6. 回填历史数据

```bash
# 统计但不联网
pnpm --filter @hmp/server tmdb:backfill -- --limit=500 --dry-run

# 实际回填（建议避开 EPG 刷新时段）
pnpm --filter @hmp/server tmdb:backfill -- --limit=500

# 标题清洗规则升级后，重算已有行的 match_key（本地操作；--limit 仅限制随后补全的标题数）
pnpm --filter @hmp/server tmdb:backfill -- --rekey --limit=500
```

CLI 默认先补齐旧 `epg_programme.poster_match_key`，再对缺失/过期标题补全；`--household=<id>` 可限定家庭。

## 7. 负向与回滚验证

```bash
# 伪造 ref
curl -i http://localhost:3000/api/public/media/programme-posters/00000000000000000000000000000000
# 期望 404 application/problem+json

# 迁移回滚
pnpm migration:down
pnpm migration:up
pnpm migration:drill
```

- 跨家庭 ref：用另一 household 的缓存行 ref 测试，期望 404。
- 过期 ref：将 `expires_at` 改为过去，期望 404。
- 上游失败：断开外网或把 `TMDB_IMAGE_BASE_URL` 指向不可达 host，期望 502/504，前端回退。

## 8. 验收命令

```bash
pnpm gen:types
pnpm --filter @hmp/shared build
pnpm lint
pnpm typecheck
pnpm test
pnpm --filter @hmp/web test
pnpm build
pnpm migration:drill
pnpm --filter @hmp/server audit:boundaries
pnpm --filter @hmp/server audit:purity
```