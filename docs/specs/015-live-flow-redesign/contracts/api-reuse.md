# Contract: API Reuse Matrix (015-live-flow-redesign)

**Feature**: 直播全流程重构——即开即看、智能分流与同类切台
**Principle**: 零新增后端端点、零修改服务端核心逻辑，100% 复用现有公共与播放 API。

---

## 1. 既有 API 端点复用矩阵

| 业务场景 | 调用端点与方式 | 输入参数 | 输出 DTO 投影 | 鉴权与安全约束 |
| --- | --- | --- | --- | --- |
| **首页分组清单** | `GET /api/public/live/groups` | 无 | `ChannelGroupListDto` | 公开只读，免登录，RateLimitGuard |
| **首页分区分页频道** | `GET /api/public/live/channels` | `section=now\|next\|all`, `page`, `pageSize`, `q` | `ChannelListDto` (含 `timezone`, `now`, `items`) | 公开只读，白名单投影，不暴露源地址 |
| **分类频道列表 (Screen 2)** | `GET /api/public/live/channels` | `section=group`, `groupKey=:key`, `q`, `page` | `ChannelListDto` | 公开只读，支持按 `groupKey` 精确提取 |
| **EPG 节目单窗口 (Screen 3)** | `GET /api/public/guide` | `date=YYYY-MM-DD`, `from`, `to`, `channelPage` | `GuideWindowDto` (含频道排期与时间轴) | 公开只读，家庭时区对齐 |
| **同类直播推荐 (Screen 4)** | `GET /api/public/live/channels` | `section=group`, `groupKey=:targetGroup` | `ChannelListDto` | 前端过滤排除当前 `activeChannelId` |
| **受控起播与切台换流** | `POST /api/playback/resolve` | `{ mediaId: string, startMode: "beginning" }` | `PlaybackDto` (201 Created + Location) | SessionGuard，ProfilePolicy 强鉴权 |
| **频道收藏切换** | `POST /api/me/favorites/channels` | `{ mediaId: string }` | 200 OK | 需要活跃 Profile，乐观更新与服务端对账 |

---

## 2. 安全与性能守卫合规性
1. **公开只读隔离**：所有获取频道元数据的请求均调用 `/api/public/*`，响应 Header 均包含 `Cache-Control: no-store`，不向匿名客户端暴露物理路径、流地址或鉴权票据。
2. **播放强鉴权**：无论是首页 Hero 起播、卡片快捷播放还是换台切流，所有流获取必须通过 `POST /api/playback/resolve`，严格校验当前会话与 ProfilePolicy。
3. **防抖与缓存**：Screen 2 的搜索输入框配备 300ms 客户端防抖；公共查询使用 React Query 维持 30 秒缓存并静默后台更新。
