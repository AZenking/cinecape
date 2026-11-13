# ADR-0021：TMDB 节目海报与本地最小调用缓存

- 状态：Accepted
- 日期：2026-11-13
- 适用版本：V1.0+
- 依据：项目宪章核心原则一（规格驱动）、三（公开浏览与受控播放分离）、四（自托管/隐私优先/显式 household 边界）、五（ADR）、技术约束 3（可逆迁移）、6（DDD 边界）
- 关联：[020-tmdb-programme-posters](../specs/020-tmdb-programme-posters/spec.md)、[ADR-0002（单部署单家庭）](0002-one-deployment-one-household.md)、[ADR-0010（公开浏览）](0010-public-browsing-playback-separation.md)、[ADR-0015（仓储抽取）](0015-repository-extraction.md)

## Context

EPG 节目单目前只有标题、简介与起止时间，没有节目主视觉。用户希望接入 TMDB，让节目单能按规则匹配电影/剧集海报；同时明确要求「尽量少调用 TMDB 接口」，并把节目单数据缓存起来。

约束与事实：

1. 项目是家庭 NAS 自托管、隐私优先；核心播放不得依赖强制外部云服务。因此 TMDB 必须是**可选**能力，未配置时必须完全降级。
2. TMDB API Terms 要求：缓存内容不得超过 6 个月、必须署名、默认不允许商业使用；启用后节目标题会发送给 TMDB。
3. TMDB 的 `search/multi` 一次返回 movie/tv/person 与 `poster_path`，无需再调详情接口；这是最小调用路径。
4. 节目单读取是高频公共路径，绝不能把外部 API 调用放进去；必须本地持久缓存 + 同源图片代理。
5. 现有 010/014 已形成「不透明 ref + 同源代理 + 有界读取」的成熟模式，本期应复用而不是另造一套。
6. EPG 刷新是串行执行器；网络 IO 不得进入发布事务。

## Decision

1. **TMDB 为可选外部元数据源**：仅通过服务端环境变量启用（`TMDB_API_KEY` 或 `TMDB_READ_ACCESS_TOKEN`）；空值 = 关闭网络查询，但仍恢复已有本地缓存。Key 不落库、不进前端。
2. **一次检索、按标题缓存**：每个归一化标题只调用一次 `GET /search/multi`，不调用详情/图片/季集接口。缓存表 `programme_poster` 以 `(household_id, match_key)` 为主键，状态为 `matched/no_match/failed`；matched TTL 硬上限 180 天，no_match 默认 30 天，failed 默认 60 分钟。
3. **事件驱动、非轮询**：只在 EPG 刷新成功后补全一次；无后台定时任务。读取路径零 TMDB API 调用。单次运行串行、最小间隔 150ms、最多 300 次、总预算 90 秒；401/429/5xx 熔断+退避。
4. **先缓存后联网**：EPG 发布时先从本地缓存取有效 ref 写入 `epg_programme.poster_ref`，保证刷新后海报不丢失；发布后再仅对缺失/过期标题联网补全，并在同一事务更新节目行。
5. **保守匹配**：标题 NFKC/去标点/去季集/去清晰度/年份提取后，只接受与 TMDB `title` 或 `original_title` 归一化后完全相等的 movie/tv；过滤 person/adult/无海报；年份冲突宁缺毋滥。通用栏目停用表直接 no_match。
6. **不透明引用 + 同源代理**：`programme_poster.ref` 为随机 128-bit 32 位 hex；公共 DTO 只出现 `posterRef`。新增 `GET /public/media/programme-posters/:posterRef`，按家庭解析、校验 TTL、经 SafeUpstream 读取 `image.tmdb.org`，失败 404/502/504；不落盘。
7. **独立图片限频**：新增 `mediaImage` 桶（600/min/IP），避免节目单多图占用公共 API 的 120/min 桶。
8. **合规与隐私**：公共布局展示 TMDB logo + 免责声明；README 说明标题外发、缓存期限、非商业限制；留空 Key 即关闭。
9. **可逆迁移**：新增 `0012_programme_posters`（`programme_poster` 表 + `epg_programme` 两列 + 索引），down 可逆；旧数据不做 SQL 回填，由下次刷新或 CLI 补齐。
10. **领域归属**：TMDB 客户端、匹配规则、缓存与代理用例放在 EPG 上下文（节目海报是 EPG 元数据）；`sources` 只通过 `@contexts/epg` 发布面端口调用，不深导入。

## Consequences

**正面**：
- 节目单获得海报，且无 TMDB 时行为与现状完全一致。
- 单标题单次检索 + 持久缓存 + 无读取调用，API 消耗可控且可观测。
- 复用既有 SafeUpstream/不透明 ref/限频模式，安全边界一致。
- 迁移可逆，旧库与旧数据不受影响。

**负面/代价**：
- 引入一个可选外部依赖；启用后节目标题会离开家庭网络。
- 首次导入可能只覆盖前 300 个新标题，需要后续刷新或 CLI 回填。
- 完全匹配策略会漏掉译名差异/副标题差异的节目，需后续别名/手工修正增强。
- 图片仍依赖 TMDB CDN；离线时海报回退，本期不做服务端图片落盘。
- 公共图片请求需要独立限频与缓存头，增加少量运维关注点。

## Alternatives Considered

1. **不接 TMDB，保持纯文字**：视觉目标未达成。
2. **客户端直连 TMDB / 直接使用 image.tmdb.org URL**：泄漏 API Key 或上游结构，跨域/CSP/隐私不可控；放弃。
3. **每次读取节目单实时查 TMDB**：调用量与延迟不可接受，且违反读取路径零外部调用；放弃。
4. **每个节目/每集都调详情接口**：调用量放大数千倍；`search/multi` 已含 poster_path；放弃。
5. **只做内存缓存**：重启即失效，无法满足「尽量少调用」；放弃。
6. **服务端落盘图片字节**：可离线但增加存储/清理/许可复杂度；列为未来增强，本期不做。
7. **宽泛模糊匹配**：会误配新闻/栏目/同名作品；本期采用保守完全匹配，未来可加别名表与人工 override。

## Compliance Notes

- Household 边界：`programme_poster` 显式 `household_id`；代理解析按请求作用域家庭；不信任客户端家庭声明。
- 公开浏览：海报是公共元数据，游客可见；不授予播放权限，不携带个人数据。
- 隐私：不发送 Profile/Account/设备/Cookie/播放地址；只发送归一化后的节目标题与语言/地区。
- 许可：TMDB 内容缓存 ≤180 天；公共 footer 署名；README 说明商业使用需 TMDB 商业授权。
- 迁移：0012 与 schema/readiness/precheck/EXPECTED_* 同批更新；down 可逆；drill 覆盖。