# Contract: 客户端逻辑频道与播放接口 (Client Channel & Playback API)

**Feature**: `017-channel-centric-architecture`
**Context**: `live-tv`, `playback`
**Consumers**: Web Client (`apps/web`), Live Watch Page, EPG Guide

---

## 1. 直播大厅频道聚合列表 (Public Live Channels with Cascaded EPG)

- **Method / Endpoint**: `GET /live/channels`
- **Access Control**: 公开浏览（Public Browsing），无需登录；遵循 Household 单一实例隔离。
- **Response Format**: `application/json`

### 200 OK Response Schema

```json
{
  "channels": [
    {
      "id": "cctv1-channel-uuid",
      "name": "CCTV-1 综合",
      "logoUrl": "/media/logos/cctv1.png",
      "category": "央视频道",
      "lineCount": 3,
      "defaultLineId": "line-01",
      "matchMode": "cascade",
      "epgSourceId": "epg-source-51zmt",
      "currentProgramme": {
        "title": "今日说法",
        "start": "2026-11-09T04:30:00Z",
        "end": "2026-11-09T05:00:00Z"
      },
      "nextProgramme": {
        "title": "晚间新闻",
        "start": "2026-11-09T05:00:00Z",
        "end": "2026-11-09T05:30:00Z"
      }
    }
  ]
}
```

---

## 2. 播放解析与多线路下发 (Controlled Playback Resolver with Stream Lines)

- **Method / Endpoint**: `POST /playback/resolve`
- **Access Control**: 受控鉴权。必须携带有效设备会话与 `activeProfileId`，经 `ProfilePolicy` 校验频道分级与白名单。
- **Request Body**:
  ```json
  {
    "mediaId": "cctv1-channel-uuid",
    "lineId": "line-02" // 可选: 指定线路切换;缺省时由服务端选择默认线路
  }
  ```

### 200 OK Response Schema

```json
{
  "ticket": "signed-playback-ticket-jwt",
  "streamUrl": "/playback/stream/line-02.m3u8?ticket=...",
  "mediaId": "cctv1-channel-uuid",
  "title": "CCTV-1 综合",
  "selectedLineId": "line-02",
  "streamLines": [
    {
      "lineId": "line-01",
      "label": "线路 1 · 1080P",
      "priority": 14,
      "isDefault": true,
      "isEnabled": true
    },
    {
      "lineId": "line-02",
      "label": "线路 2 · 备用",
      "priority": 10,
      "isDefault": false,
      "isEnabled": true
    }
  ]
}
```

### 403 Forbidden Response Schema
```json
{
  "error": "PROFILE_POLICY_BLOCKED",
  "message": "当前档案未被授权观看该频道"
}
```
