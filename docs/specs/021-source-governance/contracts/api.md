# API Contract: 021-source-governance

前缀 `/api/settings`，全部要求有效主管理员会话（SessionGuard + SettingsGuard）；写操作挂 SameOriginGuard；请求体为 strictObject。

## 1. 来源归档/恢复

### POST `/sources/:sourceId/archive`

```json
{ "expectedVersion": 3 }
```

- 204 No Content。
- 404 NOT_FOUND（不存在/跨家庭/已归档）。
- 409 SOURCE_VERSION_CONFLICT / SOURCE_BUSY。
- 归档后常规 `GET /sources` 不再返回；刷新/测试/PATCH 对归档来源按 404 处理。

### POST `/sources/:sourceId/restore`

```json
{ "expectedVersion": 4 }
```

- 204 No Content；恢复后删除 `source_archive` 行、`enabled=0`（需管理员手动启用）。
- 404（不存在/未归档/跨家庭）；409 版本冲突。

## 2. 原始快照

### GET `/sources/:sourceId/snapshots`

```json
{
  "items": [
    {
      "id": "uuid",
      "kind": "epg",
      "capturedAt": "2026-11-13T...",
      "byteSize": 123456,
      "sha256": "64hex"
    }
  ]
}
```

按 `captured_at DESC`，最多 20 条；不返回内容与上游地址。

### GET `/sources/:sourceId/snapshots/:snapshotId/preview`

```json
{
  "id": "uuid",
  "kind": "epg",
  "capturedAt": "...",
  "byteSize": 123456,
  "previewText": "...",
  "truncated": true
}
```

预览上限 256 KiB（UTF-8 安全截断）；404 同形。

### GET `/sources/:sourceId/snapshots/:snapshotId/download`

`text/plain; charset=utf-8`，`Content-Disposition: attachment; filename="<source>-<capturedAt>.<xml|m3u>"`。完整解码后原文；不缓存（`Cache-Control: no-store`）。

## 3. 数据治理

### GET `/governance/overview`

```json
{
  "retentionDays": 30,
  "archivedSources": [
    { "id": "...", "name": "...", "kind": "iptv", "archivedAt": "...", "lastSuccessAt": "..." }
  ],
  "counts": {
    "expiredProgrammes": 0,
    "staleEntries": 0,
    "snapshots": 0,
    "snapshotBytes": 0,
    "refreshJobs": 0,
    "archivedSources": 0
  }
}
```

所有清除数量按默认保留期计算；`now` 由服务端生成，不信任客户端。

### POST `/governance/cleanup`

```json
{ "target": "expired-programmes", "retentionDays": 30, "dryRun": true }
```

`target` ∈ `expired-programmes | stale-entries | snapshots | refresh-jobs | archived-sources`；`retentionDays` 1..3650，缺省 30。

响应：

```json
{ "target": "expired-programmes", "dryRun": true, "deleted": 120, "bytesFreed": 0, "detail": {} }
```

真实清理（dryRun=false）追加审计行。`archived-sources` 对全部早于 cutoff 的归档来源执行永久清理。

### POST `/governance/archived-sources/:sourceId/purge`

```json
{ "expectedVersion": 5 }
```

- 200 `{ "deleted": 1, "bytesFreed": 0 }`。
- 404（非归档/不存在/跨家庭）；409 版本冲突。

## 4. 负向边界

- 非法 target、retentionDays 越界、未知字段 → 400 VALIDATION_FAILED。
- 非主管理员 → 403；跨家庭 sourceId/snapshotId/purge → 404 同形。
- 响应不包含 `remote_url`、`root_key`、`relative_directory`、播放地址、原始上游 URL。