# Phase 0: Research & Architecture Decisions (016-multi-source-live-epg)

**Feature**: 多直播源聚合与多 EPG 源级联匹配及前端实时呈现  
**Spec Reference**: `docs/specs/016-multi-source-live-epg/spec.md`  
**Governing ADRs**: ADR-0007 (媒体受控导入), ADR-0008 (手动 EPG 绑定锁定), ADR-0010 (浏览与鉴权分离), ADR-0015 (仓储提取), ADR-0017 (免套娃设置体系)

---

## R1: 多直播源（Multi-Streams）的聚合与线路模型

### Context & Problem
不同 IPTV 提供商（M3U 源）经常包含相同的电视台（例如源 A 提供 `CCTV-1 综合 1080P`，源 B 提供 `CCTV-1 综合 4K`）。如果粗暴地按物理条目入库，用户在直播列表中会看到多条重复的 CCTV-1，界面杂乱无章；更严重的是，当某个源失效时用户只能手动盲猜切换其他行。

### Decision
1. **逻辑频道（MediaItem）与物理流线路（Playback Line）解耦**：
   - 保持一个逻辑频道（`media_item`, type=`channel`）拥有全局唯一的 `mediaId`；
   - 逻辑频道下挂载多条 `source_entry` (kind=`iptv`)，每条条目对应一条可播放的“物理线路（Line）”；
   - 自动清洗与聚合规则：在 M3U 导入与目录装配时，通过纯函数 `normalizeChannelKey(rawName)` 清除噪音后缀（`[4K]`, `1080P`, `HEVC`, `高清`, `[IPv6]`, `(备份)` 等），命中相同规范化 key 且在同一个 Household 下的流自动合并为该逻辑频道的备用线路。
2. **线路元数据（Line Attributes）**：
   - 每条线路携带：`lineId` (即 entry ID 或 stream hash), `label` (根据原始标签提取如 "官方高清" / "备用 4K"), `priority` (由来源优先级与清晰度加权), `isEnabled` (启用状态)。

### Alternatives Considered
- *完全不合并，平铺展示多行*：被业界与用户体验彻底否决（如同一频道占 5 行卡片，严重破坏界面整洁）。
- *仅允许单主流，其余物理流直接丢弃*：不可取，失去了多直播源的核心价值（抗卡顿、备用容灾）。

---

## R2: 多 EPG 源的级联匹配算法与锁定防覆盖策略

### Context & Problem
单 EPG 源常面临覆盖率有限、时段缺失或频道 ID（tvg-id）不统一的问题。接入多个 EPG 源时，需要明确在发生冲突或缺失时的裁决顺序，并且必须严格兼容已接受的 ADR-0008（单频道手动绑定锁定）。

### Decision
建立五级级联判定链（Cascading Resolution Chain）：
1. **Level 1 (Manual Lock 优先)**：
   - 检查 `manual_epg_binding` 表；
   - 若存在且目标有效，直接使用绑定的 EPG 源及目标频道；
   - 若手动绑定的目标 EPG 源失效或被删除，**保持 `unavailable`，绝不静默回退**（严格遵守 ADR-0008，防止覆盖家长配置）。
2. **Level 2 (绑定源精确匹配 tvg-id)**：
   - 若频道配置了关联的 IPTV 默认 EPG 源，优先按 `source_entry.tvg_id == epg_channel.upstream_channel_id` 进行精确命中。
3. **Level 3 (多 EPG 源优先级级联回退)**：
   - 若 Level 2 未命中或排期为空，按 Household 下所有已启用的 EPG 源的 `priority ASC`（数值越小优先级越高）进行排序遍历；
   - 在高优先级源中依 `tvg-id` 查找匹配的节目单。
4. **Level 4 (频道名称归一化模糊/别名匹配)**：
   - 若 tvg-id 仍未命中，通过 `normalizeChannelName` 对频道名和 EPG 库中频道名进行去除标点、大小写和常见清晰度后缀的归一化比对；
   - 可辅以本地常驻别名映射表（如 `{"cctv1": ["CCTV-1", "CCTV-1 综合", "CCTV1HD"]}`）。
5. **Level 5 (缺省降级)**：
   - 全链路未命中返回 `null`，前台展示“暂无节目单”，但频道正常可播。

### Invariant & Performance Budget
- **防 N+1 查询**：依然沿用 `live-projection.service.ts` 的内存集合比对机制，通过单次抓取当前家庭的有效 EPG 源清单与频道候选集，在内存 Map 中完成 O(1) 关联判定，SQL 查询总数保持固定。

---

## R3: 前端“当前节目（Now Playing）”高效渲染与智能时钟推进

### Context & Problem
如果客户端为每个频道定时轮询（Polling）后端拉取当前节目，当频道量达数百个时会产生巨大的网络与 CPU 浪费；而若完全不刷新，用户停留页面时节目信息会很快过时。

### Decision
1. **服务端下发轻量聚合窗口**：
   - 服务端返回频道时直接注入：
     ```ts
     current: { key: string; title: string; start: string; end: string } | null;
     next: { key: string; title: string; start: string; end: string } | null;
     ```
   - 时间戳一律使用标准 ISO-8601 UTC 字符串，由客户端统一转换。
2. **客户端智能事件定时器（Event-Driven Smart Timer）**：
   - 频道卡片不使用盲目轮询；
   - 基于 `current.end` 计算距离节目结束的剩余时间：
     `delay = new Date(current.end).getTime() - Date.now() + 1000`；
   - 使用精准 `setTimeout(delay)`，在节目结束点将 `next` 平滑推进为 `current`，并触发一次静默增量更新拉取下一档；
   - 内部每 15 秒通过本地时钟计算刷新一次进度条（`((now - start) / (end - start)) * 100%`），完全零网络开销。

---

## R4: 播放器端多线路自动容灾（Failover）与手动换线交互

### Context & Problem
直播切片或流媒体经常由于 CDN 拥堵、上游断流或网络波动出现卡顿或报错（HLS Fatal Error、HTTP 404/500、Network Timeout）。需要给观影者提供“无感自愈 + 手动选择”双保险。

### Decision
1. **播放解析契约扩展（Playback Lines Contract）**：
   - `/api/playback/channels/:mediaId/resolve` 返回可用线路清单：
     ```ts
     {
       ticket: string;
       streamUrl: string;
       lines: Array<{
         lineId: string;
         label: string;
         priority: number;
         isCurrent: boolean;
       }>
     }
     ```
2. **播放器自动故障转移（Auto-Failover）**：
   - 播放器内核监听流媒体致命异常（如 HLS `ERROR` 事件或原生 `<video>` 连续触发 `stalled` / `error` 超过 3 秒）；
   - 自动按优先级顺位请求切换至下一线路重连；
   - 触发轻量 UI Toast：“当前线路异常，已自动切换至线路 2（备用）”；
   - 若所有线路均尝试失败，才进入不可用缺省屏，避免死循环。
3. **播放控制栏（OSD）手动换线**：
   - 控制栏增加“线路”下拉控件（使用 HeroUI `Dropdown` + `DropdownMenu` + `DropdownItem`）；
   - 用户可随时手动强制选择指定线路。
