# API Contract: 014-channel-logos（公共面）

日期：2026-11-07。Proposed 设计。错误形态措辞与既有公共面（live/vod）同风格；机器可读版见 [openapi.yaml](openapi.yaml)，以 tasks 冻结版为准。

## 1. 新增端点

### GET /public/media/logos/:logoRef

频道 Logo 同源代理（media-catalog 接口层；010 `GET /public/vod/posters/:posterRef` 的同口径镜像）。

**授权**：公开浏览（ADR-0010）——无会话要求；家庭上下文由服务端部署配置确定（`PublicContextService.requireScope()`），绝不取自客户端；限频 `@RateLimit('public')`（与 live 控制器同档）。

**输入**：

| 参数 | 位置 | 约束 |
| --- | --- | --- |
| `logoRef` | path | 非空字符串；不透明令牌，服务端不解析其内容 |

**成功响应**：

- `200`；`Content-Type: image/*`（上游响应原样回传，仅接受上游 image/* 且 identity 编码）；body 为图片字节。
- `Cache-Control: public, max-age=300`（引用键控缓存；引用按频道+家庭唯一，无跨家庭串味面）。
- 字节不落盘、不写服务端缓存；纯读用例。

**稳定错误形态**（FR-006/SC-003；全部不回显上游地址、上游错误细节、注册表内部形态）：

| 条件 | 状态 | 问题码（新增，shared ProblemCode 注册） | 形态要点 |
| --- | --- | --- | --- |
| ref 未签发/伪造/格式非法 | 404 | `NOT_FOUND` | 与目录资源不存在完全同形，不透露「曾存在」 |
| ref 属其他家庭 | 404 | `NOT_FOUND` | 与上一行不可区分（负向验收：跨家庭探测不得有差异） |
| 命中墓碑（revoked_at 窗口内） | 410 | `MEDIA_LOGO_REVOKED` | 「已失效，请刷新列表」语义；不含上游信息 |
| 上游读取失败/非图片/非 identity 编码 | 502 | `MEDIA_LOGO_UPSTREAM_FAILED` | 脱敏「上游失败，请稍后重试」 |
| 上游超预算（总时限/空闲超时/中断） | 504 | `MEDIA_LOGO_UPSTREAM_TIMEOUT` | 与 502 可区分但不泄漏是哪项预算 |

错误响应体沿用既有 ProblemJsonFilter 信封（`{type,title,status,code,detail}`，脱敏文案在 `title`/`detail`，无 `message` 键）；契约测试须断言：五类请求 100% 稳定形态 + 序列化响应体 0 处出现上游 URL 片段。

## 2. 既有端点行为增补（无契约结构变化）

以下端点的响应**结构不变**，仅 `posterRef` 字段开始出现非空值：

| 端点 | 字段 | 变更 |
| --- | --- | --- |
| `GET /public/live/channels`（及分组/all 区投影） | `items[].media.posterRef` | NULL → 引用值或 NULL |
| `GET /public/media`（目录列表/详情） | `items[].posterRef` | 频道类媒体开始可能有值（movie/series 行为不变） |
| 个人收藏/收藏频道列表 | 列表项 posterRef | 同上透传 |

**语义注记（005 openapi 增补，随本规格实施）**：`PublicMedia.posterRef` 与直播频道行 `posterRef` 的 description 更新为——「频道 Logo 同源引用（经 `/public/media/logos/{logoRef}` 服务端代理取回）；上游未提供 Logo → null。不得携带可解码的上游地址。010 海报域继续使用 `/public/vod/posters/{posterRef}`，两域引用不可互用（ref 类别由各自注册表证明，互用 404 同形）」。

## 3. 幂等与一致性

- 本端点纯读；`logoRef` 取回可重复（GET 幂等）。
- 引用生命周期由发布事务决定（[data-model §5](../data-model.md)）；刷新列表（live/channels）是客户端从 410 恢复的唯一途径——410 形态的 message 面向用户「请刷新」，契约上面向客户端「引用已失效」。

## 4. 契约测试清单（实现后必须存在，现不存在——不伪造）

1. 伪造 ref（随机 32 hex）→ 404，形态与「目录不存在」逐字同形。
2. 跨家庭 ref（双家庭 fixture，B 家庭取 A 家庭引用）→ 404，与 1 不可区分。
3. 墓碑 ref → 410 `MEDIA_LOGO_REVOKED`。
4. 上游 200 text/html → 502 `MEDIA_LOGO_UPSTREAM_FAILED`；上游非 identity 编码 → 502 同码。
5. 上游挂起超总期限 → 504 `MEDIA_LOGO_UPSTREAM_TIMEOUT`。
6. 上游 200 image/png ≤2MiB → 200 字节一致 + `Content-Type` 透传 + `Cache-Control: public, max-age=300`。
7. 以上全部响应体（含 message）断言不含上游 URL 任何片段。
8. 限频触发 → 429 + Retry-After（沿用公共限频既有行为）。
