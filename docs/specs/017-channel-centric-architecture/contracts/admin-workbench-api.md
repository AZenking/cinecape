# Contract: 管理后台频道资产工作台接口 (Admin Channel Workbench API)

**Feature**: `017-channel-centric-architecture`
**Context**: `settings`, `media-catalog`, `epg`
**Consumers**: Admin Web Settings (`apps/web/src/features/settings`)

---

## 1. 频道资产工作台列表查询 (Query Channel Workbench Items)

- **Method / Endpoint**: `POST /settings/catalog/candidates/query`
- **Access Control**: 主管理员受控通行（主 Profile PIN 校验通过，`SettingsGuard` 放行）。
- **Request Body**:
  ```json
  {
    "type": "channel",
    "search": "CCTV",
    "page": 1,
    "pageSize": 50
  }
  ```

### 200 OK Response Schema

```json
{
  "total": 42,
  "page": 1,
  "pageSize": 50,
  "items": [
    {
      "id": "cctv1-channel-uuid",
      "title": "CCTV-1 综合",
      "type": "channel",
      "logoUrl": "/media/logos/cctv1.png",
      "category": "央视频道",
      "lineCount": 3,
      "lines": [
        {
          "lineId": "line-01",
          "label": "线路 1 · 1080P",
          "sourceName": "电信主源",
          "priority": 14
        },
        {
          "lineId": "line-02",
          "label": "线路 2 · 4K",
          "sourceName": "联通源",
          "priority": 12
        }
      ],
      "epgBinding": {
        "mode": "manual",
        "isLocked": true,
        "epgSourceId": "epg-source-51zmt",
        "epgSourceName": "51zmt 官方节目单",
        "xmltvChannelId": "CCTV1",
        "epgChannelDisplayName": "CCTV-1 综合",
        "effectiveMatchMode": "manual"
      }
    }
  ]
}
```

---

## 2. 跨源 EPG 候选检索 (Query EPG Candidates across any Source)

- **Method / Endpoint**: `POST /settings/catalog/media/:mediaId/epg-candidates/query`
- **Access Control**: 主管理员受控通行。
- **Request Body**:
  ```json
  {
    "epgSourceId": "epg-source-51zmt",
    "q": "CCTV-1",
    "pageSize": 30
  }
  ```

### 200 OK Response Schema

```json
{
  "epgGeneration": 4,
  "items": [
    {
      "xmltvChannelId": "CCTV1",
      "displayName": "CCTV-1 综合",
      "iconUrl": "http://epg.example/cctv1.png",
      "programmeCountToday": 28
    }
  ]
}
```

---

## 3. 频道手动 EPG 绑定锁定 (Lock Manual EPG Binding)

- **Method / Endpoint**: `POST /settings/catalog/media/:mediaId/epg-binding/save`
- **Access Control**: 主管理员受控通行，CAS 版本校验，幂等保障。
- **Request Body**:
  ```json
  {
    "expectedVersion": 2,
    "epgSourceId": "epg-source-51zmt",
    "xmltvChannelId": "CCTV1"
  }
  ```

### 200 OK Response Schema
```json
{
  "mediaId": "cctv1-channel-uuid",
  "mode": "manual",
  "epgSourceId": "epg-source-51zmt",
  "xmltvChannelId": "CCTV1",
  "version": 3,
  "updatedAt": "2026-11-09T08:48:00Z"
}
```

---

## 4. 解除 EPG 手动绑定（恢复自动级联）(Clear Manual EPG Binding)

- **Method / Endpoint**: `POST /settings/catalog/media/:mediaId/epg-binding/clear`
- **Access Control**: 主管理员受控通行，CAS 版本校验。
- **Request Body**:
  ```json
  {
    "expectedVersion": 3
  }
  ```

### 200 OK Response Schema
```json
{
  "mediaId": "cctv1-channel-uuid",
  "mode": "auto",
  "epgSourceId": null,
  "xmltvChannelId": null,
  "version": 4,
  "updatedAt": "2026-11-09T08:49:00Z"
}
```
