# ADR-0022: 来源软删除、数据保留治理与原始导入快照

- **状态**: Accepted
- **日期**: 2026-11-13
- **关联规格**: [021-source-governance](../specs/021-source-governance/spec.md)
- **关联决策**: ADR-0008(EPG 窗口)、ADR-0015(仓储抽取)、ADR-0017(常规管理免二次密码)

## 背景

`media_source` 被 `source_entry`、`playback_source`、`epg_channel`、`epg_programme`、
`manual_epg_binding`、`source_refresh` 多表引用；频道还可能被多个来源共享。直接物理删除
来源会破坏频道聚合、收藏、节目单回退与刷新历史，且不可恢复。

同时，原始 M3U/XMLTV 在刷新时只被解析，不落盘；排错时无法查看「到底导入了什么」。
过期节目、失效线路、历史快照与终态任务也会长期累积。

## 决策

1. **归档优先**：新增 `source_archive(household_id, source_id, archived_at, archived_by)`
   注册表。产品语义的「删除」= 停用 + 写归档行；常规来源列表、EPG 优先级投影与刷新准入
   通过 `NOT EXISTS` 排除归档来源。恢复 = 删除归档行，来源保持停用。
2. **不立即物理删除**：归档保留全部导入数据；永久清理是治理页的显式、带影响预览的
   管理员动作，按保留期或单条来源执行，并在单事务内删除该来源的相关行（不删除共享
   `media_item`）。
3. **原始快照旁路**：IPTV/EPG 成功读取后保存一份 gzip 原文快照
   (`source_import_snapshot`)，记录原始字节数/SHA-256/抓取时间；快照写入失败只告警，
   不影响刷新状态。查看端只返回 256 KiB 预览，完整原文经 download 解码下载。
4. **治理审计**：真实清理写 `governance_cleanup_run`；dry-run 不落库。
5. **保留期**：默认 30 天，UI 可选 7/30/90/180；服务端校验 1..3650。

## 追加决策(2026-11-13:永久清理的外键语义)

真实库清理曾以 `FOREIGN KEY constraint failed` 失败:历史 `playback_session` 以
`NO ACTION` 引用 `playback_source`,直接删线路不合法。明确如下:

1. **历史会话保留、线路解绑**:终态会话(`ended`/`failed`/`interrupted`)清理时把
   `playback_session.playback_source_id` 置 NULL,观看记录保留,仅丢失「当时用的哪条线路」;
2. **活动会话拒绝清理**:`preparing`/`ready`/`playing`/`paused` 期间解绑会违反会话
   CHECK(可播状态必须有源),返回 409 `SOURCE_BUSY`,等播放结束再重试;
3. **输入绑定丢弃**:`playback_input_binding` 是播放准备期临时状态,按线路/来源删除;
4. **EPG/频道解绑**:`media_source.epg_source_id` 指向被清理来源的频道先置 NULL,
   保留频道本身;
5. **VOD 来源暂不物理清理**:仍有 `vod_title` 关联时返回 409 `SOURCE_BUSY` 并给出
   明确 detail,避免只删一半留下孤儿媒资(级联清理媒体库另立需求);
6. 同一套解绑逻辑复用于「失效频道线路」清理,避免同类外键失败。

## 后果

- 删除可恢复，代价是归档行与数据保留占用空间；由治理页显式释放。
- 归档不会自动删除共享逻辑频道，避免误伤其他来源；孤立频道资产后续单独治理。
- 原始快照会增加 SQLite 体积；用「每个来源保留最新一份 + 保留期」限制增长。
- 迁移 0013 可逆；历史迁移测试需识别 0013 为最新尾段。

## 迁移

`0013_source_governance`：新增 `source_archive`、`source_import_snapshot`、
`governance_cleanup_run` 与索引；down 逆序删除，不修改既有 0001~0012。
