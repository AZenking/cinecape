# API Contracts: 多直播源与多 EPG 源 (016-multi-source-live-epg)

**Feature**: 多直播源聚合与多 EPG 源级联匹配及前端实时呈现  
**Spec Reference**: `docs/specs/016-multi-source-live-epg/spec.md`  
**Governing ADRs**: ADR-0007, ADR-0008, ADR-0010, ADR-0015, ADR-0017

---

## 1. 公共直播与 EPG 聚合接口 (Public Browsing)

### 1.1 批量当前/下一档节目投影
- **Path**: `GET /api/public/live/channels/now-playing`
- **Auth**: 无需认证（游客公开浏览，遵守 ADR-0010）
- **Query Params**:
  - `mediaIds` (optional): 逗号分隔的媒体 ID 列表。若缺省则返回当前家庭全部可用频道的当前节目。
  - `now` (optional): 基准 UTC 毫秒时间戳（用于走查测试，默认当前服务器时间）。

**Response 200 OK**:
```json
{
  "now": "2026-11-09T10:00:00.000Z",
  "programmes": {
    "media_cctv1": {
      "current": {
        "key": "a1b2c3d4e5f6...",
        "title": "朝闻天下",
        "start": "2026-11-09T06:00:00.000Z",
        "end": "2026-11-09T10:30:00.000Z",
        "progress": 0.88
      },
      "next": {
        "key": "f6e5d4c3b2a1...",
        "title": "共同关注",
        "start": "2026-11-09T10:30:00.000Z",
        "end": "2026-11-09T12:00:00.000Z"
      },
      "matchMode": "cascade"
    },
    "media_ch2": {
      "current": null,
      "next": null,
      "matchMode": "none"
    }
  }
}
```

---

## 2. 播放解析与线路列表接口 (Playback Resolver)

### 2.1 频道播放解析（扩展多线路）
- **Path**: `GET /api/playback/channels/:mediaId/resolve`
- **Auth**: 需要有效会话（严格执行 ProfilePolicy 与家长控制，遵守宪章原则三）
- **Query Params**:
  - `lineId` (optional): 指定收看的物理线路 ID。若不传则由系统选择默认优选线路。

**Response 200 OK**:
```json
{
  "ticket": "pb_ticket_89a0b1c2...",
  "streamUrl": "/api/playback/stream/hls/ticket_89a0b1c2/master.m3u8",
  "selectedLineId": "entry_line_1",
  "lines": [
    {
      "lineId": "entry_line_1",
      "sourceId": "src_telecom_01",
      "sourceTitle": "电信高清",
      "label": "线路 1 [1080P]",
      "priority": 10,
      "isDefault": true,
      "isEnabled": true
    },
    {
      "lineId": "entry_line_2",
      "sourceId": "src_unicom_02",
      "sourceTitle": "联通备用",
      "label": "线路 2 [4K]",
      "priority": 20,
      "isDefault": false,
      "isEnabled": true
    }
  ]
}
```

**Negative Response**:
- `403 Forbidden`: 当前 Profile 未通过 ProfilePolicy（如儿童收看未授权频道）。
- `404 Not Found`: 频道不存在或该频道所有线路均被停用。

---

## 3. 管理者 EPG 权重与线路管理接口 (Admin Settings)

> **权限要求**：仅主管理员（`isMain === true`，通过 PIN 认证）可访问，非主管理员直接 403 阻断（遵循 ADR-0017）。

### 3.1 查询已启用的 EPG 源优先级列表
- **Path**: `GET /api/settings/sources/epg-priorities`
- **Query**: 可选 `includeDisabled=true|false`，默认 `false` 保持只返回已启用来源。管理页传 `true` 时包含停用来源的真实权重、频道数和最后成功同步时间，保证排序草稿保存后完整回显；始终限定当前家庭且按权重、创建时间、ID 稳定排序。
- **Response 200 OK**:
```json
{
  "sources": [
    {
      "sourceId": "src_epg_official",
      "name": "官方 XMLTV",
      "priority": 10,
      "channelCount": 180,
      "lastSyncAt": "2026-11-09T08:00:00Z"
    },
    {
      "sourceId": "src_epg_backup",
      "name": "社区备用 EPG",
      "priority": 20,
      "channelCount": 240,
      "lastSyncAt": "2026-11-09T08:05:00Z"
    }
  ]
}
```

### 3.2 批量更新 EPG 源优先级
- **Path**: `PUT /api/settings/sources/epg-priorities`
- **Request Body**:
```json
{
  "priorities": [
    { "sourceId": "src_epg_backup", "priority": 10 },
    { "sourceId": "src_epg_official", "priority": 20 }
  ]
}
```
- **Response 200 OK**:
```json
{
  "success": true,
  "updatedCount": 2
}
```
*(保存后后台自动触发一次全量级联匹配刷新，原子递增 catalog revision)*

### 3.3 管理单频道的物理线路
- **Path**: `GET /api/settings/channels/:mediaId/lines`
- **Path**: `PUT /api/settings/channels/:mediaId/lines`
- **Request Body (PUT)**:
```json
{
  "lines": [
    { "lineId": "entry_line_1", "isEnabled": true, "isDefault": true },
    { "lineId": "entry_line_2", "isEnabled": false, "isDefault": false }
  ]
}
```
