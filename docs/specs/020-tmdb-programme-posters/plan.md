# Implementation Plan: TMDB 节目海报接入与最小化调用缓存

**Feature**: `020-tmdb-programme-posters` | **Date**: 2026-11-13 | **Spec**: [spec.md](spec.md) | **ADR**: [ADR-0021](../../adr/0021-tmdb-programme-posters.md)

**Status**: Implementing（实现完成，2026-11-13；真实 TMDB 运行时证据待补，见 evidence.md）。

## Summary

为 EPG 节目单增加可选的 TMDB 海报匹配：节目标题归一化后，一次 `search/multi` 调用覆盖电影/剧集检索；结果以 `(household_id, match_key)` 持久化在 SQLite；EPG 刷新先恢复本地缓存 ref，再对缺失/过期标题做有上限、串行、带熔断的补全；公共读取路径零 TMDB API 调用；海报经同源不透明 ref 代理，前端在墙/列表/详情展示并在失败时回退。

## Technical Context

- TypeScript ^5.8 / Node >=24 / pnpm 11；NestJS ^12、Drizzle ^0.44、better-sqlite3 ^13、Zod ^4；React 19、HeroUI 3.2.x、TanStack Query ^5。
- 复用既有 `SAFE_UPSTREAM_PORT`、`PublicContextService`、`RateLimitGuard`、`ProblemJsonFilter`、仓储 seam（ADR-0015）。
- 存储：新增 `programme_poster` 表 + `epg_programme.poster_match_key/poster_ref` 两列 + 索引；迁移 `0012_programme_posters`。
- 外部：TMDB v3/v4 HTTP API（`api.themoviedb.org`）与图片 CDN（`image.tmdb.org`），可选、环境变量启用。
- 测试：Vitest 3、Supertest/Nest TestingModule、Testing Library、Playwright（按需）；真实 TMDB 调用仅由人工运行时验收执行。

## Constitution Check

| Gate | 结论 | 依据 |
| --- | --- | --- |
| 规格先于实现 | PASS | 本规格/ADR 已 Accepted 后开始编码 |
| Household/Profile 边界 | PASS | 缓存显式 household_id；代理按请求家庭解析；无 profile 数据 |
| 公开浏览/受控播放 | PASS | 海报为公共元数据；不触碰播放授权；游客可见 |
| 隐私/自托管 | PASS | 可选依赖；空 Key 完全关闭；不发送个人数据；文档披露标题外发 |
| DDD/跨上下文 | PASS | 实现在 EPG 上下文；sources 仅经发布面端口；不深导入 |
| 迁移可逆 | PASS | 0012 up/down/drill + readiness/precheck 同步 |
| UI 基线 | PASS | HeroUI 语义 token；图片为装饰/非交互；2:3 比例在 contracts/ui.md 记录 |
| 外部许可 | PASS | 缓存 ≤180 天、footer 署名、README 非商业说明 |

## Data Model / Contracts

见 [data-model.md](data-model.md)、[contracts/api.md](contracts/api.md)、[contracts/ui.md](contracts/ui.md)、[contracts/internal-ports.md](contracts/internal-ports.md)、[contracts/openapi.yaml](contracts/openapi.yaml)。

## Implementation Phases

1. **Governance/Contracts**：spec/ADR/contracts；003/005 OpenAPI `Programme.posterRef`；shared ProblemCode；`pnpm gen:types`。
2. **Persistence**：0012 migration、schema、readiness/precheck/EXPECTED_*、migration test。
3. **Domain**：`programme-title.ts` 归一化、`programme-poster-match.ts` 匹配；单测。
4. **TMDB/Service**：client + cache store + enrichment + proxy；fake fetch 单测。
5. **Refresh integration**：executor pre-resolve + post-publish enrich；publish insert columns；capability guard。
6. **Read path**：guide/live/epg/manual binding DTO `posterRef`；contract tests。
7. **Public proxy**：controller + SafeUpstream + `mediaImage` rate limit + problem codes；contract tests。
8. **Web**：ProgrammePoster、detail/wall/list、PublicLayout attribution；web tests。
9. **Ops**：`tmdb:backfill` CLI、`.env.example`、compose、README、quickstart。
10. **Evidence**：全门禁 + migration drill + runtime notes。

## Performance / Call Budget

- 串行 1 in-flight；最小间隔 150ms（≈6.7 req/s）；单次 300 次；总预算 90s。
- 每标题最多一次 `search/multi`；无详情/图片/季集调用；读取路径 0 次；图片代理仅 CDN 字节 + 浏览器缓存 1 天。
- 缓存 TTL：matched 180d / no_match 30d / failed 60min；过期索引 + 每次补全 GC。

## Risks

- 匹配误差：保守完全匹配，年份冲突拒绝；后续可加别名/人工 override。
- 首轮覆盖不足：上限 + CLI 回填。
- 外部条款/隐私：默认关闭、署名、180 天上限、README 披露。
- 图片请求量：独立 `mediaImage` 桶 + lazy + 窄块不加载 + 浏览器缓存。