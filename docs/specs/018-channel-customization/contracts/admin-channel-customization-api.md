# Contract: 频道显隐控制与元数据更新接口 (Admin Channel Customization API)

**Feature**: `018-channel-customization`
**Context**: `media-catalog`, `settings`, `live-tv`
**Consumers**: Admin Web Settings (`apps/web/src/features/settings`), Public Live Page (`apps/web/src/features/live`)

---

## 1. 频道元数据与显隐更新 (Patch Channel Metadata & Visibility)

- **Method / Endpoint**: `PATCH /settings/catalog/media/:mediaId` (经 Settings 路由网关) / `PATCH /catalog/media/:mediaId`
- **Access Control**: 主管理员受控通行（主 Profile PIN 校验通过，`SettingsGuard` 放行），免当次主账号密码，严格请求体验证。
- **Request Body**:
  ```json
  {
    "expectedVersion": 1,
    "visible": false,
    "title": "CCTV-1 综合频道",
    "logoUrl": "https://epg.example/logos/cctv1-hd.png"
  }
  ```

### 200 OK Response Schema

```json
{
  "id": "cctv1-channel-uuid",
  "type": "channel",
  "title": "CCTV-1 综合频道",
  "description": null,
  "contentLevel": null,
  "poster": "https://epg.example/logos/cctv1-hd.png",
  "visible": false,
  "version": 2
}
```

### 409 Conflict (CAS 版本冲突)
```json
{
  "code": "MEDIA_VERSION_CONFLICT",
  "message": "媒体已被其他操作修改,请重新加载"
}
```

---

## 2. 频道资产工作台查询 (Query Candidates with Visibility & Logo)

- **Method / Endpoint**: `POST /settings/catalog/candidates/query`
- **Access Control**: 主管理员受控通行。
- **Request Body**:
  ```json
  {
    "type": "channel",
    "page": 1,
    "pageSize": 50
  }
  ```

### 200 OK Response Schema

```json
{
  "items": [
    {
      "id": "cctv1-channel-uuid",
      "type": "channel",
      "title": "CCTV-1 综合频道",
      "visible": true,
      "logoUrl": "https://epg.example/logos/cctv1-hd.png",
      "lineCount": 3,
      "version": 2,
      "available": true,
      "epgBinding": {
        "mode": "manual",
        "xmltvChannelId": "CCTV1",
        "status": "valid"
      }
    },
    {
      "id": "shopping-channel-uuid",
      "type": "channel",
      "title": "购物测试台",
      "visible": false,
      "logoUrl": null,
      "lineCount": 1,
      "version": 1,
      "available": true
    }
  ],
  "total": 2,
  "page": 1,
  "pageSize": 50
}
```

---

## 3. 公开直播大厅频道查询 (Public Live Channels - Filtering out hidden)

- **Method / Endpoint**: `GET /public/live/channels`
- **Access Control**: 公开浏览（无需登录）。
- **Behavior**: 仅返回 `visible = 1` 且有可用流的频道。被隐藏（`visible = 0`）的频道在此端点输出中 100% 被过滤排除。
