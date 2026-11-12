# Implementation Research: 频道中心制与物理流/EPG源彻底解耦架构

**Feature**: `017-channel-centric-architecture`
**Created**: 2026-11-09
**Status**: Completed

---

## 核心技术决策 (Key Decisions)

### Decision 1: 逻辑频道作为面向客户端的唯一实体与物理流线路聚合机制 (Channel-Centric Client Abstraction & Stream Lines Aggregation)

- **Decision**: 
  1. 客户端（PC 网页端、播放器、EPG 节目单、未来移动端）消费与请求的唯一顶层实体为「逻辑频道」（`MediaItem`, `type='channel'`）。
  2. 导入 M3U 直播源时，系统通过标准频道名清洗算法（`channelKeyOf`，剥离 `4K`, `1080P`, `IPv6`, `(备用)` 等噪音后缀）进行归一化。
  3. 属于同一 `channelKey` 的同名物理流，自动汇聚至该逻辑频道下的物理播放线路集合（`playback_source` / `source_entry`）。
  4. 每条线路根据来源全局优先级（`media_source.priority`）与清晰度加权（4K +2, 1080P +4, 备用 -2 等）计算出 `linePriority`，默认首选最高优先级线路作为主线路，其余线路作为备用线路。
- **Rationale**: 
  - 彻底解决用户导入多源后在界面看到大量同名重复频道（如 3 个 CCTV-1）的混乱体验。
  - 将多直播源从“污染频道列表”转变为“单频道高可用线路保障”，极大提升流媒体播放的容灾抗卡顿能力。
- **Alternatives Considered**: 
  - *方案 B：导入时保持物理条目独立，仅在前端展示时做虚拟聚合*：被否决。前端做虚拟聚合会导致分页计算、EPG 匹配、收藏夹同步、播放记录和权限校验变得极其脆弱复杂，且容易造成跨组件数据不一致。
  - *方案 C：完全由管理员手动合并频道*：被否决。一个 M3U 动辄几百上千个频道，完全依靠手动合并运维成本极高，自动归一化汇聚 + 后台微调是最佳实践。

---

### Decision 2: 多 EPG 源全局池化与五级级联确定性归一匹配算法 (Multi-EPG Pool & Cascading Resolution)

- **Decision**: 
  1. 彻底废除“某一个 IPTV 直播源绑定某一个 EPG 源”的 1:1 强绑定限制。所有已启用的 XMLTV EPG 源汇聚为一个全局节目排期数据池。
  2. EPG 源在系统内配置全局优先级权重（`priority` 数值越小优先级越高，支持拖拽或数字调整）。
  3. 逻辑频道在解析当前/未来节目单时，遵循严格的五级确定性级联策略：
     - **Level 1 (Manual Lock, ADR-0008)**: 管理员对该逻辑频道手动锁定绑定的目标 EPG 源及频道（最高优先级，一旦锁定永不被自动逻辑覆盖）；若绑定的 EPG 源被禁用或目标频道已删除，明确标记为失效（Disabled），绝不隐式穿透回退。
     - **Level 2 (Precise tvg-id match across priority cascade)**: 在已启用的 EPG 源中，按源优先级升序（`priority ASC`），使用物理流清洗出的标准 `tvg-id` 检索，首个命中且具备有效排期的 EPG 频道胜出。
     - **Level 3 (Normalized Alias match across priority cascade)**: 若 `tvg-id` 未命中，在已启用的 EPG 源中，按源优先级升序（`priority ASC`），使用频道标准名称（`normalizeChannelName`）在 EPG 频道的 `displayName` 与别名索引中模糊归一检索。
     - **Level 4 (Fallback)**: 所有源均未匹配，或匹配源节目排期为空，频道正常返回，`currentProgramme` 与 `nextProgramme` 标记为 `null`，前端优雅呈现“暂无节目单”。
- **Rationale**: 
  - 现实中单一 EPG 源通常无法 100% 覆盖所有电视频道，或者某些特定频道排期经常断更。多 EPG 源级联可以互为备用，大幅提高 EPG 覆盖率与准确率。
  - 内存无 N+1 查询架构（先批量加载 EPG 频道索引与窗口节目，再在纯函数内进行级联裁决）保证高并发查询下的毫秒级响应。
- **Alternatives Considered**: 
  - *按物理流来源就近寻找 EPG 源*：被否决。这正是导致用户感到怪异的根源。直播流通常来自运营商或公开订阅，而 EPG 通常来自专门的 XMLTV 提供商，两者不存在天然物理绑定关系。

---

### Decision 3: 管理后台体验重塑——从“来源关联”彻底走向“频道资产工作台” (Admin Channel Asset Workbench)

- **Decision**: 
  1. **彻底移除** `SettingsEpgPage` 中怪异的「直播来源关联 (Live Source Association)」区块。
  2. 在 `SettingsIptvPage` 中，将标签页规范化定义：
     - `iptv` 标签：管理 IPTV 播放列表源（M3U）及导入任务；
     - `epg` 标签：管理 EPG 节目单源（XMLTV）、同步任务及源优先级排序；
     - `channels` (原 `matching`) 标签：重塑为**频道资产工作台 (Channel Asset Workbench)**。
  3. **频道资产工作台**核心能力：
     - **频道概览表格**：频道台标（Logo）、频道名称、分类、已汇聚物理线路数（以 Chip/Badge 显示，如 "3 条线路"）、当前匹配的 EPG 源与节目单状态（如 "CCTV-1 [手动锁定: 51zmt]" 或 "智能级联: epg.pw" 或 "暂无节目单"）。
     - **线路详情抽屉/卡片**：展开后可查看各条线路的流格式、所属来源、清晰度标签、权重并可测试可用性。
     - **统一 EPG 绑定弹窗 (HeroUI Modal)**：在弹窗顶部提供 `<Select>` 切换系统内任意 EPG 源，提供模糊搜索输入框实时检索候选 XMLTV 频道，支持一键“手动锁定”或“解除锁定（恢复自动级联）”。
- **Rationale**: 
  - 消除管理员认知负担，管理员管理的是“频道”这一媒体资产，而不是一堆混乱的物理链接。
  - 完全符合宪章技术约束第 5 条（HeroUI v3 优先、禁用原生控件）、第 8 条（语义 Token）及新增的核心原则七。
- **Alternatives Considered**: 
  - *保留来源关联作为折中配置*：被否决。保留旧逻辑不仅代码维护冗余，更会持续混淆管理员的心智模型，必须彻底移除。

---

### Decision 4: 播放器多线路切换与断流自动容灾协议 (Playback Multi-Line Switching & Failover)

- **Decision**: 
  1. 服务端 `POST /playback/resolve` 接口统一在响应中返回当前频道的可用线路列表：
     ```json
     {
       "streamUrl": "/playback/stream/...",
       "lineId": "line-01",
       "streamLines": [
         { "lineId": "line-01", "label": "线路 1 · 1080P", "priority": 14, "isDefault": true },
         { "lineId": "line-02", "label": "线路 2 · 备用", "priority": 10, "isDefault": false }
       ]
     }
     ```
  2. 前端播放器控制栏集成 `PlayerLineSwitcher` 组件，支持用户手动点选线路。
  3. 播放器监听 HLS/HTML5 播放错误事件（如 `MEDIA_ERR_NETWORK`, `hlsError` 致命网络断流、加载超时超过 6 秒等）。当首选线路故障时，播放器协调器（`PlaybackFailoverCoordinator`）自动按优先级获取下一条候选线路，重新请求播放凭据并无缝切流，同时给用户短暂显示非侵入式 Toast 提示“已自动切换至备用线路”。
- **Rationale**: 
  - 极大改善家用 IPTV 的稳定性，单个源挂掉时无需用户手动刷新或退出播放。
  - 整个过程在同一个逻辑频道的上下文内自洽完成，不影响当前频道的 EPG 进度与播放历史。
- **Alternatives Considered**: 
  - *由服务端负责代理转流并在服务端自动 Failover*：被否决。服务端代理多条外网流会耗费 NAS 宝贵的 CPU 和带宽，对于 Direct Stream 直连流，客户端自主 Failover 延迟更低且对 NAS 性能零损耗。
