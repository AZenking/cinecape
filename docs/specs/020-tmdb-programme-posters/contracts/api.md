# API Contract: 020-tmdb-programme-posters

日期：2026-11-13。机器可读版本见 [openapi.yaml](openapi.yaml)；本文件记录语义与稳定错误形态。

## 1. `Programme.posterRef`（既有端点增补）

适用端点：

- `GET /public/guide` → `GuideWindow.channels[].programmes[]`
- `GET /public/media/{mediaId}/programmes` → `Programmes.current/next`
- `GET /public/live/now-playing`（及既有直播投影）→ `CurrentNextProjection.current/next`
- 管理侧 `EpgBinding` 的 `current/next`

字段：

```text
posterRef: string | null
required: true
description: 节目海报的不透明引用；null=无海报。不可解码，不携带 TMDB ID/上游 URL。
```

规则：
- 值域为 32 位小写 hex；或 null。
- 仅在 `programme_poster.state='matched'` 且未过期时非空；缓存过期/未匹配/失败为 null。
- 与频道 `media.posterRef`（频道 Logo）是不同字段；前端优先节目海报，缺失时回退频道 Logo。
- 旧客户端忽略该增量字段；服务端必须每个 `Programme` 都返回该字段。

## 2. `GET /public/media/programme-posters/{posterRef}`

**授权**：公开只读，不挂 SessionGuard；家庭由 `PublicContextService.requireScope()` 服务端确定；未初始化 404。

**限频**：`MediaImage` 桶（每 IP 600 次/分钟），独立于 `public` 120/min 与 `guide` 30/min；超限 429 + `Retry-After`。

**输入**：
- path `posterRef`：32 位小写 hex；格式非法 404。
- query/body：严格空；未知字段 400。

**成功 200**：
- `Content-Type`: 上游 `image/*`。
- `Content-Length`: 实际字节。
- `Cache-Control: public, max-age=86400`（覆盖全局 no-store）。
- 字节为上游原样、不落盘。

**错误**：

| 状态 | code | 条件 |
| --- | --- | --- |
| 400 | `VALIDATION_FAILED` | 未知 query/body 字段 |
| 404 | `NOT_FOUND` | 格式非法/未签发/跨家庭/非 matched/已过期/poster_path 空/未初始化 |
| 429 | （限频统一） | 超过 `mediaImage` 配额；`Retry-After` |
| 502 | `PROGRAMME_POSTER_UPSTREAM_FAILED` | 上游读取失败、非 image/*、非 identity 编码 |
| 504 | `PROGRAMME_POSTER_UPSTREAM_TIMEOUT` | 总时限/空闲超时/预算中止 |

**安全**：
- 解析按 `(household_id, ref)` 单查；不按 ref 反解任何内容。
- 只允许 `TMDB_IMAGE_BASE_URL` 的精确 host；`poster_path` 仅允许 `^/[A-Za-z0-9._-]+\.(jpg|jpeg|png|webp)$`，禁止 `//`/`..`。
- 经 `SAFE_UPSTREAM_PORT` 有界读取：≤2 MiB、总 8s、空闲 4s、≤3 跳。
- 错误文案不回显上游地址、TMDB ID、Key 或内部匹配键。

## 3. 错误码注册

新增 shared `ProblemCode`：

```text
PROGRAMME_POSTER_UPSTREAM_FAILED  → 502
PROGRAMME_POSTER_UPSTREAM_TIMEOUT → 504
```

404 复用 `NOT_FOUND`，不新增“过期”码，避免泄漏缓存内部状态。

## 4. 读取路径零调用约束

- `GET /public/guide`、`GET /public/media/{id}/programmes`、直播投影：只读 `epg_programme.poster_ref`，不得触发 `search/multi`。
- 图片代理只访问图片 CDN，不访问 TMDB API。
- 契约测试以 fake 客户端计数断言 `searchCalls === 0`。