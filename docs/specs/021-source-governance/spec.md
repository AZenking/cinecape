# Feature Specification: 来源归档与数据治理

**Feature Branch**: `021-source-governance`

**Created**: 2026-11-13

**Status**: Implementing

**Related ADRs**: [ADR-0022](../adr/0022-source-governance.md)

**Governance**: 遵循 `.specify/memory/constitution.md`。重点对齐原则一（规格驱动与证据）、原则二（Household 边界）、原则五（非破坏性演进）、技术约束 3（可逆迁移）与 6（DDD 边界）。

**Input**: 用户要求：「直播源和节目单都缺少删除按钮；增加过期数据清理的治理页面；导入的 XML/M3U 原始数据希望可以查看；调研市面工具。」

---

## 背景与边界

- `media_source` 既有设计为「无硬删除，禁用保留引用」：来源会被 `source_entry`、`playback_source`、`epg_channel`、`epg_programme`、`manual_epg_binding`、`source_refresh` 等引用；直接物理删除会破坏频道聚合、收藏、节目单与回滚能力。
- 因此「删除」在产品语义上等于**归档**：来源立即停用、从常规列表消失、停止同步，已导入数据保留；管理员可在「数据治理」中恢复，或按保留期永久清理。
- 原始 M3U/XMLTV 当前只被解析、不落盘。本期在每次成功读取后保存一份压缩原始快照，用于预览与下载排错；快照受大小与保留期约束。
- 治理页只做**显式、可预览、可审计**的清理，不做后台静默删除。

## User Scenarios & Testing

### User Story 1 - 归档/恢复来源 (P1)

管理员在「直播源」或「节目单」列表点击「删除」，确认后来源进入归档：从列表消失、停止同步、保留已导入数据。管理员可在治理页恢复。

**Acceptance**:
1. Given 一个已启用的 IPTV/EPG 来源，When 点击删除并确认，Then 常规列表不再返回该来源，刷新入口不再可用，`source_archive` 存在对应行、`enabled=0`。
2. Given 归档来源，When 在治理页点击恢复，Then `source_archive` 行删除且来源保持停用（不自动同步）。
3. Given 来源有 queued/running/awaiting_confirmation 任务，When 删除，Then 返回 409 `SOURCE_BUSY`，不改变来源。
4. Given 版本已变化，When 删除/恢复携带旧 `expectedVersion`，Then 409 `SOURCE_VERSION_CONFLICT`。
5. Given 跨家庭 sourceId，When 删除/恢复，Then 404 同形。

### User Story 2 - 原始数据查看 (P1)

管理员在来源行点击「原始数据」，查看最近一次成功导入的原始 M3U/XMLTV 预览，并可下载完整原文。

**Acceptance**:
1. Given 一次成功 IPTV/EPG 刷新，Then 保存一条 snapshot（gzip 存储、记录 SHA-256、字节数与捕获时间）。
2. Given 快照存在，When 打开查看，Then 返回前 256 KiB 解码文本与 `truncated` 标记；下载返回完整解码原文。
3. Given 无快照，Then 查看器显示「暂无快照，先执行一次同步」。
4. Given 跨家庭/不存在的 snapshotId，Then 404 同形；响应不得包含上游 URL、rootKey、播放地址。
5. 快照写入失败不得使刷新失败（只记录警告）。

### User Story 3 - 数据治理与清理 (P1)

管理员打开「IPTV 管理 → 数据治理」，看到各类过期/冗余数据统计，按目标预览并执行清理。

**Acceptance**:
1. 概览返回：归档来源数、已结束节目数、失效线路数、原始快照数与字节数、过期任务数、保留期默认值。
2. 清理目标（各自可 dry-run 预览）：
   - `expired-programmes`：`ends_at < now - retentionDays` 的 EPG 节目。
   - `stale-entries`：`present=0` 且 `missing_since < cutoff` 的 source_entry 及其 playback_source。
   - `snapshots`：`captured_at < cutoff` 的快照；每个来源保留最新一条。
   - `refresh-jobs`：终态且 `created_at < cutoff` 的 source_refresh 与 refresh_stage_entry。
   - `archived-sources`：归档时间早于 cutoff 的来源，执行永久清理。
3. dry-run 不写库，返回预计删除数量与可释放字节数；真实清理返回相同结构并记录审计行。
4. 永久清理归档来源时删除其 source_entry、playback_source、source_refresh、refresh_stage_entry、source_import_snapshot、epg_channel、epg_programme、manual_epg_binding（解除绑定）与 media_source 行；不删除共享 media_item（留给后续孤立资产治理）。catalog revision +1。
5. 归档来源也可在治理页单条永久清理（`archived-sources/:sourceId/purge`）。
6. 所有清理在单事务内执行；越权/跨家庭 404。

## Requirements

- **FR-001**: 新增 `source_archive(household_id, source_id, archived_at, archived_by)` 归档注册表（有行=归档，无行=active）；常规来源分页、EPG 优先级视图与刷新准入必须排除归档来源。
- **FR-002**: 提供归档/恢复端点，使用 `expectedVersion` CAS；归档设置 `enabled=0`、`version+1`，`catalog_state.revision+1`，等待确认任务标 stale。
- **FR-003**: 活跃刷新任务存在时拒绝归档（409 `SOURCE_BUSY`）。
- **FR-004**: 新增 `source_import_snapshot`（household/source/refresh/kind/content_encoding/content BLOB/byte_size/sha256/captured_at）。内容统一 gzip；预览 256 KiB；下载解码。
- **FR-005**: IPTV/EPG 成功读取后保存快照；快照失败不得影响刷新结果。
- **FR-006**: 提供 snapshot 列表、预览、下载端点；严格 household 归属。
- **FR-007**: 新增 `governance_cleanup_run` 审计表（target/dry_run/deleted/bytes/detail/actor/created_at）。
- **FR-008**: 提供 governance overview 与 cleanup 端点；清理前支持 dry-run。
- **FR-009**: 清理默认保留期 30 天；UI 支持 7/30/90/180 天选择；服务端对非法值 400。
- **FR-010**: UI：IPTV/EPG 列表行增加删除按钮与确认；新增「数据治理」标签页；原始数据查看器（预览、复制、下载）。
- **FR-011**: 迁移 0013 支持 up/down，更新 schema、precheck、EXPECTED_TABLES/COLUMNS。
- **FR-012**: 不改变既有播放、收藏、EPG 匹配语义；不向客户端暴露 remote_url/rootKey/播放地址。

## Out of Scope

- 不自动删除共享 `media_item`/收藏/观看历史；孤立频道资产后续单独治理。
- 不做定时自动清理；本期为管理员显式触发。
- 不做原始快照全文搜索引擎；仅预览 + 浏览器查找 + 下载。