# Home Media Platform 领域模型（V1.1 固化版）

- 状态：Frozen
- 版本：V1.1（按宪章 1.0.1 对齐）
- 决策依据：[ADR-0003](docs/adr/0003-constitution-alignment.md)
- 固化日期：2026-10-22
- **005 增补标注（2026-10-26）**：规格005 与 ADR-0010~0012 已接受——新增主 Profile 标识（is_main，区别于 Account 管理角色与 isDefault）、Profile 个人收藏/观看历史/进度时钟（Household+Profile 隔离）、播放进度状态（candidate epoch + sampleSeq 写入权）、15 分钟设置访问授予（绑定 DeviceSession+主 Profile+身份/PIN/主档案版本快照）及 source_entry.group_title/media_item.content_revision 等结构；详见 docs/specs/005-pc-browsing-flow/data-model.md。原 V1.1 身份分工（Household→Account→Profile）不变。
- **016 增补标注（2026-11-09）**：规格016 与 ADR-0007（2026-10-23）/ADR-0008（2026-10-25）已接受，并运行于 ADR-0010、ADR-0015、ADR-0017 语境——新增直播频道物理线路（StreamLine）解耦（单逻辑频道在同一 Household 聚合多条 source_entry/playback_source 线路，normalizeChannelKey 归一键合并）、多 EPG 源五级级联裁决链（manual 锁定失效即停链、绝不静默回退，ADR-0008）与播放解析多线路公开投影（lines 七键，仅在授权链通过后签发）；详见 docs/specs/016-multi-source-live-epg/data-model.md。原 V1.1 身份分工与播放授权次序不变。
- 适用范围：运行在个人或家庭 NAS 上的自托管媒体平台

本文是 Home Media Platform 的领域模型基线。后续接口、数据库、权限和前端流程都应以本文为准；本文只描述领域边界和业务约束，不代表所有功能已经实现。

## 1. 固化结论

### 1.1 Household 是顶层资源边界

`Household` 表示一个家庭媒体空间，是媒体源、媒体库、设备、Profile 和家庭策略的归属边界。

V1 固定为“一次部署实例对应一个 Household”。因此 V1 不引入 `Installation`、Tenant 或多 Household 管理层，但所有资源仍必须保留 Household 边界。未来如果一个部署实例托管多个 Household，必须通过新的 ADR 和数据迁移重新定义查询、缓存、播放授权和文件访问规则。

### 1.2 Account 只负责认证

`Account` 是家庭登录主体，负责用户名/邮箱、密码、会话和管理员权限。

第一阶段采用“一个 Household 一个主要 Account”的模型，不为每个家庭成员建立独立登录账号。未来增加多个管理员时，再扩展 Account 与 Household 的关系。

### 1.3 Profile 代表当前观看者

`Profile` 是家庭成员的观影档案，负责表达“现在是谁在观看”。Profile 归属于 Account，并保留所属 Household 的显式边界，不拥有完整的登录凭据。

观看历史、播放进度、收藏、想看列表、偏好和内容策略都必须以 `profile_id` 为个人数据边界，而不是以 `account_id` 为边界。

### 1.4 DeviceSession 保存设备上下文

设备首次使用时通过 Account 完成认证，之后通过设备会话保持登录。设备会话还要保存当前选中的 Profile 上下文。

服务端必须验证当前 Profile 属于当前会话的 Household。客户端传来的 `profile_id`、浏览器 `localStorage` 或路由参数都不能单独作为授权依据。

### 1.5 Content Policy 才是内容授权依据

Profile 的 `type: adult | child` 只用于界面模式和默认体验，不能直接决定内容权限。

实际授权由 `ProfilePolicy` 完成，至少支持内容等级、未评级内容、媒体黑名单、媒体白名单和频道白名单。

### 1.6 Playback 是统一入口

直播频道、电影、电视剧、剧集和 NAS 文件最终都通过 Playback 领域解析可播放资源。

播放解析必须同时考虑：

1. 当前 Account/DeviceSession 是否有效；
2. 当前 Profile 是否有效；
3. ProfilePolicy 是否允许访问该媒体；
4. 当前 Household 是否拥有或能访问该媒体来源；
5. 当前设备是否支持该播放资源。

## 2. 总体模型

```text
Home Media Platform
│
└── Household
    │
    ├── Account
    │   ├── Credentials
    │   ├── Sessions
    │   ├── Admin Permission
    │   └── Profiles
    │       ├── Personalization
    │       │   ├── Watch History
    │       │   ├── Watch Progress
    │       │   ├── Favorites
    │       │   ├── Watchlist
    │       │   └── Preferences
    │       └── Profile Policy
    │           ├── Content Rating
    │           ├── Content Restrictions
    │           ├── Channel Restrictions
    │           └── Profile PIN
    │
    ├── Devices
    │   └── Device Sessions
    │
    └── Media Domain
        ├── Media Catalog
        ├── Media Sources
        ├── Media Library
        ├── Playback Sources
        └── Playback Resolver
```

## 3. 核心实体

### 3.1 Household

职责：家庭级资源、配置和成员档案的归属边界。

属于 Household 的内容：

- 家庭名称和头像；
- 默认语言和时区；
- 媒体源和媒体库；
- Profiles；
- 家庭设备；
- 家庭管理员权限。

不属于 Household 直接维护的内容：

- 个人观看历史；
- 个人播放进度；
- 个人收藏和想看列表；
- 个人推荐偏好。

概念模型：

```ts
interface Household {
  id: string;
  name: string;
  defaultLanguage: string;
  timezone: string;
  createdAt: Date;
}
```

### 3.2 Account

职责：登录认证、会话管理和家庭管理权限。

```ts
interface Account {
  id: string;
  householdId: string;
  username: string;
  passwordHash: string;
  role: "owner" | "admin";
  createdAt: Date;
}
```

约束：

- V1 一个 Household 只有一个主要 Account；
- 密码只存密码哈希，不能进入前端响应；
- Account 不直接拥有观看历史、收藏或播放进度；
- Account 的管理员权限不能替代 Profile 的内容策略检查。

### 3.3 Profile

职责：描述当前观看者及其个人媒体体验。

```ts
interface Profile {
  id: string;
  householdId: string;
  accountId: string;
  name: string;
  avatar?: string;
  type: "adult" | "child";
  isDefault: boolean;
  isActive: boolean;
  pinHash?: string;
  createdAt: Date;
}
```

约束：

- Profile 归属于 Account，必须保留 `account_id` 和 `household_id`，且 Account 的 Household 与 Profile 一致；
- `type` 不是最终授权依据；
- 受 PIN 保护的 Profile 在切换时必须重新验证；
- 被停用的 Profile 不能成为新的会话上下文；
- 一个 Household 至少保留一个可用 Profile；
- 一个 Household 最多只能有一个默认 Profile。

### 3.4 Device 与 DeviceSession

`Device` 表示实际使用 Home Media 的设备，`DeviceSession` 表示该设备经过 Account 认证后的访问会话。

```ts
interface Device {
  id: string;
  householdId: string;
  name?: string;
  type: "web" | "mobile" | "tv" | "nas" | "other";
  lastSeenAt?: Date;
  createdAt: Date;
}

interface DeviceSession {
  id: string;
  householdId: string;
  accountId: string;
  deviceId: string;
  activeProfileId?: string;
  expiresAt: Date;
  revokedAt?: Date;
  createdAt: Date;
}
```

约束：

- `accountId`、`deviceId` 和 `activeProfileId` 必须属于同一个 Household；
- 所选 Profile 的 `accountId` 必须等于 DeviceSession 的 `accountId`；
- 会话失效或被撤销后不能访问媒体；
- `activeProfileId` 由服务端设置和验证；
- 设备能力应由设备注册或能力协商记录，不能只依赖 User-Agent。

### 3.5 ProfilePolicy

职责：定义某个 Profile 能访问哪些内容。

```ts
interface ProfilePolicy {
  householdId: string;
  profileId: string;
  maxContentLevel: number;
  allowUnrated: boolean;
  allowedMediaIds: string[];
  blockedMediaIds: string[];
  allowedChannelIds: string[];
}
```

V1 的策略判定顺序固定为：

1. 明确禁止优先于明确允许；
2. 明确允许的媒体可以覆盖普通等级限制，但不能覆盖家庭级禁用；
3. 未评级内容由 `allowUnrated` 单独控制；
4. 儿童 Profile 默认使用频道白名单；
5. 无法可靠判定直播节目分级时，不能把频道白名单解释为节目级安全保证。

### 3.6 MediaItem、MediaSource 与 PlaybackSource

领域上必须区分三个概念：

- `MediaItem`：内容是什么；
- `MediaSource`：内容从哪里来；
- `PlaybackSource`：当前如何播放。

```ts
type MediaType = "channel" | "movie" | "series" | "episode" | "video";

interface MediaItem {
  id: string;
  householdId: string;
  type: MediaType;
  title: string;
  poster?: string;
  backdrop?: string;
  description?: string;
}

interface MediaSource {
  id: string;
  householdId: string;
  type: "iptv" | "epg" | "nas" | "provider" | "other";
  name: string;
}

interface PlaybackSource {
  id: string;
  householdId: string;
  mediaItemId: string;
  sourceId: string;
  protocol: "hls" | "dash" | "file" | "flv" | "http";
  url: string;
  mimeType?: string;
  priority: number;
  requiresProxy: boolean;
}
```

`MediaItem` 可以在同一 Household 的多个来源之间复用。MediaItem、MediaSource 和 PlaybackSource 的 householdId 必须一致，媒体、播放来源和文件访问必须经过当前 Household 的资源边界检查。

直播领域在上述三概念之上引入“逻辑频道与物理流线路解耦（016 增补；受控导入见 ADR-0007，2026-10-23）”：一个逻辑频道（`MediaItem`，type=channel）在同一 Household 内可挂载多条物理流线路（`PlaybackSource`，存储映射为 source_entry），每条线路对应一个可独立播放的流条目。聚合与线路规则：

- **线路聚合键**：导入与目录装配按频道名归一化纯函数（normalizeChannelKey）生成归一键——清除清晰度/编码/协议噪音后缀与括注段；命中相同归一键的流并入既有逻辑频道（跨来源生效），不再逐物理流新建频道。归一化结果为空表示“无法归一化”，按不同名处理、不合并。
- **不聚合边界**：经人工改名（人工元数据修正覆盖）的频道不参与自动归并，人工修正优先于自动聚合；NAS 视频逐文件建档，永不参与聚合。
- **线路权重**：线路默认顺位权重 = 所属 MediaSource 的 priority（数值越小越优先，缺省 100）+ 清晰度罚分（越清晰罚分越小）。权重只决定默认线路选择与容灾顺位，不参与、不替代任何授权判定。
- **聚合频道展示标题**：未人工覆盖时取聚合首条线路的规范标题，保证重导入与多来源场景标题稳定，不随条目迭代次序漂移。

### 3.7 Personalization

所有个人媒体数据都以 `profile_id` 为主键边界：

| 数据            | 语义                   | 写入方式     |
| --------------- | ---------------------- | ------------ |
| `WatchHistory`  | 已观看记录             | 追加         |
| `WatchProgress` | 当前播放位置           | 持续更新     |
| `Favorites`     | 明确喜欢的内容或频道   | 用户主动维护 |
| `Watchlist`     | 计划以后观看的内容     | 用户主动维护 |
| `Preferences`   | 语言、排序、播放偏好等 | 配置更新     |

电视剧的播放进度必须支持 `playable_item_id`，不能只记录整部 Series 的 `media_id`：

```text
Series
└── Season
    └── Episode  ← WatchProgress.playableItemId
```

### 3.8 直播频道 EPG 排期关联与多源级联裁决（016 增补）

职责：为每个直播频道确定“当前/下一档排期来自哪个已启用 EPG 源的哪个频道”，是当前节目投影的唯一裁决依据。排期关联属 Household 只读投影事实，不改变任何授权结论。

裁决遵循确定性五级级联链，命中即止：

1. **manual 锁定（ADR-0008，2026-10-25）**：频道存在手动绑定时呈三态——绑定有效则终态采用绑定对（无排期也不回退，“无节目”不等于“失效”）；绑定目标失效（源停用或目标频道消失）则排期保持不可用且级联停链，绝不静默回退到自动源；无手动绑定记录才进入后续自动级联。
2. **tvg-id 精确匹配**：频道关联的默认 EPG 源按 tvg-id 精确命中。
3. **优先级级联**：Household 下全部已启用 EPG 源按 priority 升序（同优先级按源标识升序，确定性排序）逐源 tvg-id 精确补位。
4. **归一化别名匹配**：tvg-id 全部未命中时，以频道名归一键与各 EPG 源频道显示名归一键比对命中。
5. **none 缺省**：全链未命中即无排期关联，频道正常可播，前端展示“暂无节目单”。

约束：

- 命中方式（manual/precise/cascade/alias/none）随投影只读下发，仅用于诊断，不参与授权，也不泄露绑定管理入口；
- 同一关联对在候选序中只保留最高优先级命中形态；排期裁决取首个“确有节目窗口”的候选（manual 候选为终态，不经排期判定）；
- 防洪预算不变式（防 N+1）：级联不得新增 SQL——EPG 源 priority 与 EPG 频道显示名并入既有投影列，以固定次数集合装载 + 内存索引完成裁决，查询次数不随频道数或源数增长（仓储投影口径见 ADR-0015）；
- 当前/下一档节目窗口一律以 ISO-8601 UTC 下发；进度推进与节目翻转由客户端以本地时钟消费（本地进度平滑推进 + 节目结束点驱动单次翻转），服务端不维护会话级排期推送。

## 4. 关系和数据边界

```text
Household 1 ──── N Profile      （经 Account 归属，并保留 household_id）
Account 1 ────── N Profile
Household 1 ──── N Device
Household 1 ──── N MediaSource
Household 1 ──── N Account       （V1 实际为 1 个主要 Account）

Account 1 ────── N DeviceSession
Device 1 ─────── N DeviceSession
DeviceSession ─── 0..1 ActiveProfile

Profile 1 ─────── 1 ProfilePolicy
Profile 1 ─────── N WatchHistory
Profile 1 ─────── N WatchProgress
Profile 1 ─────── N Favorite
Profile 1 ─────── N Watchlist
```

强制边界：

- 所有数据库表保留显式 `household_id`；个人数据同时保留 `profile_id`，不能以 `account_id` 替代个人数据边界；
- 所有家庭资源查询必须带上 Household 边界；
- 所有个人数据查询必须从服务端会话得到 `activeProfileId`；
- 不允许只用 `account_id` 查询个人观影数据；
- 不允许只用前端传入的 `profile_id` 执行播放授权；
- 文件路径、播放地址和缓存键都必须关联可验证的 Household/媒体来源。

## 5. 认证、Profile 切换与播放流程

### 5.1 首次登录

```text
打开 Home Media
      ↓
Account 登录
      ↓
创建 DeviceSession
      ↓
加载 Household
      ↓
选择 Profile
      ↓
进入个人媒体首页
```

### 5.2 Profile 切换

```text
请求切换 Profile
      ↓
校验 DeviceSession
      ↓
校验目标 Profile 属于当前 Household
      ↓
校验目标 Profile 属于当前 Account
      ↓
如有 PIN，执行 PIN 校验
      ↓
服务端更新 activeProfileId
      ↓
返回新的 Profile 上下文
```

儿童 Profile 不能通过修改 `localStorage`、URL 参数或请求体中的 `profile_id` 获得成人内容权限。

### 5.3 播放解析

```text
POST /playback/resolve
      ↓
验证 DeviceSession
      ↓
读取 activeProfileId
      ↓
校验 ProfilePolicy
      ↓
查询 Household 可用媒体来源
      ↓
匹配设备播放能力
      ↓
选择 PlaybackSource
      ↓
返回 PlaybackCandidate
```

```ts
interface PlaybackRequest {
  mediaId: string;
  playableItemId?: string;
  deviceId?: string;
}

interface PlaybackCandidate {
  id: string;
  url: string;
  protocol: "hls" | "dash" | "file" | "flv" | "http";
  mimeType?: string;
  priority: number;
  requiresProxy: boolean;
}
```

客户端不直接决定最终播放 URL，播放 URL 必须由服务端根据会话、Profile、策略和设备能力解析得到。

多线路直播频道（016 增补）在上述次序之上追加如下不变式：

- **授权先于线路投影**：多线路信息只在完整授权链（会话 → 当前 Profile/PIN → ProfilePolicy → Household 资源边界）通过之后才读取与下发；指定线路不得先于或绕过授权管线。
- **线路选择**：请求可指定物理线路（lineId），指定值必须是该频道可用线路之一；缺省由系统按线路权重升序选择默认线路（同权重按线路标识确定性决胜）。指定线路不存在、已停用，或对非直播媒体指定线路，一律与“频道不存在”同形拒绝，不泄露线路存在性。
- **线路公开投影**：下发线路清单固定七键——lineId、sourceId、sourceTitle、label、priority、isDefault、isEnabled；绝不下发源地址、凭据或存储位置；清单仅含启用线路，isDefault 至多一条（顺位首条）。单线路频道与非直播媒体不携带线路键面（契约字段可选），保持既有响应形态。
- **换线不重授权**：线路清单是本次授权范围内的线路事实，客户端在清单内切换线路不需要重新解析或重新授权；超出清单的收看诉求必须重新走播放解析与完整授权。
- **播放器容灾（UI 行为契约）**：流致命错误时客户端按顺位自动切换未尝试过的下一线路，并以“已尝试集合”保证终止（全部线路尝试尽才进入不可用缺省屏，不无限循环）；自动换线提示仅属 UI 行为，不改变服务端授权与会话状态。

## 6. V1 API 边界

```text
POST /auth/login
GET  /household
GET  /profiles
POST /profiles/:profileId/select
POST /profiles/:profileId/unlock
POST /playback/resolve
GET  /me/watch-progress
PUT  /me/watch-progress
GET  /me/history
GET  /me/favorites
PUT  /me/favorites/:mediaId
GET  /me/watchlist
PUT  /me/watchlist/:mediaId
```

接口约束：

- `/me/*` 接口从 DeviceSession 的 `activeProfileId` 得到个人身份；
- `:profileId` 只用于 Profile 选择/解锁，以及经 Household 边界校验的 owner 管理目标指定（档案管理、ProfilePolicy 管理）；管理目标不得作为内容授权的观看者来源（ADR-0006，2026-10-23 接受时补充）；
- 播放接口不能绕过 ProfilePolicy；
- 公共浏览投影（当前节目/进度）不携带物理线路与源寻址信息，线路清单只随授权后的播放解析签发（ADR-0010，2026-10-26）；EPG 源权重、手动绑定与线路启停属主管理员设置面（ADR-0017，2026-11-02）；
- API 响应不能返回密码哈希、PIN 哈希或不属于当前 Household 的资源；
- 对外 DTO 使用稳定的领域字段，数据库字段变化不应直接泄露给客户端。

## 7. 推荐模块边界

```text
modules/
├── auth/
│   ├── account
│   ├── session
│   └── device
├── household/
├── profile/
├── policy/
├── media/
│   ├── catalog
│   ├── source
│   └── library
├── playback/
└── personalization/
    ├── history
    ├── progress
    ├── favorites
    ├── watchlist
    └── preferences
```

模块职责：

- `auth`：认证、会话和设备授权；
- `household`：家庭配置和资源边界；
- `profile`：Profile 生命周期、切换和 PIN；
- `policy`：内容策略判定；
- `media`：内容目录、来源、媒体库和元数据；
- `playback`：播放候选解析、设备能力匹配和播放会话；
- `personalization`：所有以 Profile 为边界的个人数据。

## 8. V1 明确不做

- 多 Household 的后台管理界面；
- 一个 Household 内多个独立登录账号；
- 社交关系、跨家庭共享和公开媒体库；
- 仅依赖 `adult/child` 字段的内容授权；
- 仅依赖客户端状态的 Profile 切换；
- 对所有 IPTV 节目提供绝对可靠的实时年龄分级；
- 一开始就拆分成微服务；
- 一开始就实现复杂的自动转码和分布式任务系统。

## 9. 固化后的验收标准

实现或评审任何功能时，应能回答以下问题：

1. 这个数据属于 Household、Account 还是 Profile？
2. 当前请求的 Household 边界从哪里得到？
3. 当前观看者的 Profile 从哪里得到？
4. 是否经过 ProfilePolicy？
5. 是否可能仅靠前端修改状态绕过权限？
6. 个人数据是否错误地关联到了 `account_id`？
7. 播放地址是否经过 Playback Resolver？
8. 缓存键、文件访问和后台任务是否保留同一条 Household 边界？

如果这些问题无法明确回答，功能就还没有符合 V1 模型。
