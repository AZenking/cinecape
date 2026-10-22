# Home Media Platform 项目简报

- 状态：Accepted foundation
- 版本：V1.0
- 固化日期：2026-10-22
- 产品类型：家庭 NAS 自托管媒体平台
- 治理依据：[宪章 1.0.1](../.specify/memory/constitution.md) 与 [ADR-0003](adr/0003-constitution-alignment.md)。

## 1. 为什么做

家庭媒体通常分散在 IPTV、网络媒体、本地 NAS 文件和不同的播放入口中。用户需要重复配置来源，也难以在多个设备之间保留统一的观看进度、收藏和内容限制。

Home Media Platform 的目标是提供一个家庭级入口：家庭只需要登录一次，成员选择自己的 Profile，就能在统一的媒体目录中浏览、播放并保留个人观看状态。

## 2. 谁使用

### 家庭管理员

- 配置家庭基本信息；
- 管理媒体源和媒体库；
- 管理设备和家庭级设置；
- 管理 Profile 与内容策略。

### 家庭成员

- 选择自己的 Profile；
- 浏览可访问的媒体；
- 播放直播、电影、剧集或本地视频；
- 查看自己的继续观看、历史、收藏和想看列表。

### 儿童 Profile

- 使用简化的媒体入口；
- 只能访问 ProfilePolicy 允许的内容；
- 默认使用频道白名单；
- 不能通过客户端状态修改获得成人内容权限。

## 3. 产品承诺

```text
一个家庭账号
      +
多个观看 Profile
      +
统一媒体目录
      +
服务端内容策略
      +
统一播放解析
```

核心区别是：Account 解决“谁能进入家庭媒体平台”，Profile 解决“当前是谁在观看”，ProfilePolicy 解决“当前观看者可以看什么”。

## 4. V1 范围

### 必须包含

- 单个部署实例对应单个 Household 的资源边界；
- 一个主要 Account 的登录和会话；
- 多个成人或儿童 Profile；
- Profile 归属主要 Account，并保留 Household 边界；个人数据以 Profile 隔离；
- Profile 切换和可选 PIN 保护；
- 设备注册与 DeviceSession；
- 媒体源、媒体目录和播放来源的基本模型；
- 服务端 ProfilePolicy 检查；
- 统一 Playback Resolver；
- 个人观看历史、播放进度、收藏和 Watchlist；
- 直播频道、电影、剧集和本地视频的统一媒体抽象。
- Docker/Linux 容器化交付；个人观看记录和媒体元数据保存在本地私有基础设施，核心播放不依赖强制云服务或非授权遥测。

### 明确不包含

- 多 Household 管理界面；
- 一个 Household 内多个独立登录账号；
- 家庭之间的社交关系或媒体共享；
- 只依赖 `adult/child` 字段的内容授权；
- 只依赖前端 `profile_id` 或 `localStorage` 的身份切换；
- 对所有 IPTV 节目提供绝对可靠的实时年龄分级；
- 一开始就拆分微服务；
- 一开始就实现复杂的自动转码和分布式任务系统。

## 5. 首批用户场景

### 场景 A：首次登录

1. 用户打开 Home Media；
2. 使用家庭 Account 登录；
3. 系统创建 DeviceSession；
4. 用户选择 Profile；
5. 系统进入该 Profile 的媒体首页。

### 场景 B：切换观看者

1. 用户发起 Profile 切换；
2. 服务端校验目标 Profile 属于当前 Household；
3. 受保护 Profile 要求 PIN；
4. 服务端更新 `activeProfileId`；
5. 后续媒体和个人数据请求使用新的 Profile 上下文。

### 场景 C：播放媒体

1. 用户选择媒体或剧集中的具体可播放项；
2. 服务端验证 DeviceSession 和 Active Profile；
3. 服务端执行 ProfilePolicy；
4. 服务端选择 Household 可用且设备支持的 PlaybackSource；
5. 客户端播放并更新 `WatchProgress`。

## 6. 成功标准

以下标准可以直接转化为规格和测试：

1. 有效 Account 可以创建或恢复一个 DeviceSession；
2. 一个 Household 可以拥有多个 Profile，但 V1 只有一个主要 Account；
3. 不同 Profile 的历史、进度、收藏和 Watchlist 相互隔离；
4. 儿童 Profile 无法通过修改请求参数、URL 或浏览器存储访问被禁止媒体；
5. Playback Resolver 不返回不属于当前 Household 或不符合 ProfilePolicy 的来源；
6. 电视剧的继续观看可以定位到具体 Episode；
7. 所有媒体和个人数据查询都能追溯到 Household 边界；
8. 每个已实现能力都有对应的规格、测试或运行时证据。

## 7. 实施顺序

```text
项目脚手架与运行约定
        ↓
Household / Account / Profile / DeviceSession
        ↓
ProfilePolicy
        ↓
Media Catalog / Media Source / Media Library
        ↓
Playback Resolver
        ↓
Watch Progress / History / Favorites / Watchlist
```

先建立身份和资源边界，再接入媒体和播放。否则媒体接口会在没有可靠身份上下文的情况下形成难以补救的权限漏洞。

## 8. 变更原则

本简报锁定 V1 的产品边界，不锁定具体 UI 样式或基础设施供应商。新增范围必须先更新本文件，并通过对应的 Feature Spec 和 ADR；不通过口头约定直接扩大 MVP。
