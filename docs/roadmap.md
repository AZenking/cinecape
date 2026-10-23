# Home Media Platform 路线图

- 状态：Living document
- 基线：宪章 1.0.1、V1.1 领域模型和 ADR-0003
- 原则：先建立身份和资源边界，再接入媒体和播放

## 阶段 0：项目基线

状态：完成（文档基线 + 规格驱动流程建立）

- 建立 README、Project Brief 和 ADR；
- 固化 Household、Account、Profile、DeviceSession 和 ProfilePolicy；
- 固化 V1 范围、非目标和验收标准；
- 建立规格驱动开发流程。

## 阶段 1：应用脚手架与身份基础

状态：收尾完成（2026-10-23 重新验收，规格 001 Verified；全仓检查、65 测试、真实浏览器、迁移恢复与双架构容器证据见 [evidence.md](specs/001-scaffold-identity-foundation/evidence.md)）。此前未实测的容器及 owner 校验缺口已补齐。

目标：得到可启动、可测试的最小服务。

- 固定运行时、包管理器和本地开发命令；
- 建立配置加载和环境变量约定；
- 建立数据库连接和迁移机制；
- 实现 Household、Account、Profile、Device 和 DeviceSession；
- 实现登录、会话恢复、注销和设备撤销；
- 为身份边界建立单元测试和集成测试。

完成条件：有效 Account 能建立 DeviceSession，且服务端能验证 Household 和 Profile 归属。

## 阶段 2：ProfilePolicy

状态：已完成并验收（2026-10-23：[规格 002](specs/002-profile-policy/spec.md) **Verified**、[ADR-0006](adr/0006-profile-policy-authorization.md) Accepted;109 用例全绿 + 真实浏览器/容器/升级回滚证据齐备,见 [evidence.md](specs/002-profile-policy/evidence.md)。媒体目录接入后开放名单编辑并补目录/播放强制授权证据——阶段 3/4）。

目标：在媒体功能之前建立可靠的内容访问边界。

- 实现 ProfilePolicy 持久化；
- 实现成人/儿童默认策略；
- 实现内容等级、未评级、媒体黑名单和白名单；
- 实现儿童频道白名单；
- 覆盖篡改 `profile_id`、URL、localStorage 和请求体的负向测试。

完成条件：客户端不能绕过服务端策略访问被禁止媒体。

当前方案把阶段 2 的策略核心/管理验收与阶段 3/4 的真实媒体入口接入分开。阶段 2 可用可信服务端夹具证明规则与身份边界，但不能据此宣称已拦截真实目录、下载或播放；原完成条件在真实资源接入前保留为待验证。名单编辑建议等资源目录与归属校验接入后开放，该范围细化已随规格/ADR 接受（2026-10-23）。

## 阶段 3：媒体目录与来源

目标：把不同来源统一为可查询的 MediaItem。

- 实现 MediaItem、MediaSource 和 PlaybackSource；
- 接入 IPTV/EPG；
- 接入 NAS 媒体文件和基础元数据；
- 区分内容身份、来源和可播放资源；
- 保证媒体可见性受 Household 边界控制。

完成条件：一个 Household 可以看到自己的媒体目录，且资源来源不会跨家庭泄露。

## 阶段 4：Playback Resolver

目标：形成统一播放入口。

- 实现 `POST /playback/resolve`；
- 校验 DeviceSession、Active Profile 和 ProfilePolicy；
- 按设备能力筛选播放来源；
- 支持 HLS、DASH、文件和 HTTP/FLV 等协议适配；
- 记录播放会话和失败原因。

完成条件：播放接口只返回当前 Household、当前 Profile 和当前设备都允许使用的 PlaybackSource。

## 阶段 5：Personalization

目标：补齐个人观看体验。

- WatchHistory；
- WatchProgress；
- Favorites；
- Watchlist；
- Preferences；
- 剧集具体 Episode 的继续观看。

完成条件：不同 Profile 的个人数据完全隔离，刷新或更换设备后仍能恢复正确状态。

## 依赖关系

发布前必须完成宪章要求的 Docker/Linux 交付验证、数据库迁移与回滚验证，以及静态检查、单元/集成契约测试、运行时和网络/后端证据验收。阶段 5 功能完成不等于已经满足发布条件。

```text
阶段 0 文档基线
        ↓
阶段 1 身份与会话
        ↓
阶段 2 内容策略
        ↓
阶段 3 媒体目录
        ↓
阶段 4 播放解析
        ↓
阶段 5 个人观看数据
```

不能把阶段 4 提前到阶段 1：没有稳定的 Household、Profile 和策略上下文，播放接口会先形成权限漏洞，再被迫返工。

## 变更规则

- 路线图可记录待细化能力；新功能进入实现前必须有 Accepted Feature Spec，并关联已接受的 ADR；
- 改变身份、资源边界或播放授权的决策必须新增 ADR；
- 阶段完成以可验证的验收标准为准，不以页面完成或代码提交为准；
- 未完成阶段可以调整顺序，但必须在 ADR 或路线图中记录原因和影响。
