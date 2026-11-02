# API 复用矩阵：零新增端点声明（012-live-settings-experience）

**Date**: 2026-11-01 | **Status**: Proposed（随规格接受生效）
**结论**: 本规格**零新增服务端端点、零数据库迁移、零 @hmp/shared 契约类型变更**。全部需求由既有端点的前端消费与既有前端机制（ActionCoordinator/usePlayAction/session-provider/purgePersonalData）达成。此文件是任务阶段的**复用核对清单**与**缺口升级通道**。

## §1 复用矩阵

| 能力 | 端点/机制 | 现役消费方 | 本规格用途 |
| --- | --- | --- | --- |
| 频道分组（按类型浏览） | `GET /public/live/groups` | live-tv live.controller（:108） | GroupSections 数据源，零改动 |
| 频道与当前/接下来节目 | `GET /public/live/channels` | live-tv（:125） | Now/Next/Hero 分区，30s 刷新重拉 |
| 节目排期 | `GET /public/media/:mediaId/programmes` | live-tv（:178） | 详情面板节目信息 |
| EPG 节目单（日期/窗口/分页） | `GET /public/guide` | GuidePage useGuideWindow（查询参数直传） | FR-015–FR-019，参数契约见 [url-state.md](url-state.md) §1 |
| 播放授权链 | 005 playback 链（authorize/prepare/…） | usePlayAction/ActionCoordinator | FR-005–FR-008 直播入口接线复用 |
| 频道收藏 | `GET/DELETE /me/favorites/channels`（favorites-api.ts） | features/favorites | FR-011 收藏交互（仅行为约束） |
| 会话事实 | `GET /auth/session` | session-provider | 身份/Profile 状态，零改动 |
| 身份切换隔离 | purgePersonalData + 代次守卫（006） | session-provider/query scopes | FR-003/FR-022 验证依赖 |
| 登录/选档/PIN | auth/profiles 既有端点 | ActionCoordinator 各 Step | 链路复用，零改动 |
| 偏好（连播/换源） | 010 服务端 Profile 偏好 | vod-autoplay-preference | 澄清 Q1：沿用，不新增 |

## §2 明确不做（防范围蔓延）

1. 不新增「分类聚合」「首页运营位」端点——分组用 live/groups。
2. 不为滚动/焦点状态新增任何持久化端点或存储键。
3. 不为播放意图新增服务端记录（意图纯前端内存态，澄清 Q2）。
4. 不改 settings-access/unlock 相关端点与判定（归 011 替代关系）。
5. 不改 010 点播端点与其前端消费（澄清 Q3）。

## §3 缺口升级通道（唯一例外路径）

任务实施中若发现某 FR 无法以既有端点达成（例：直播 resolve 缺少某返回字段），执行顺序：
1. 停止实施该任务，记录缺口与规格条目引用；
2. 核对 [005 contracts](../../specs/005-pc-browsing-flow/contracts/) 是否已有等价能力（避免重复建设）；
3. 确需新增：按最小端点原则补 005 契约扩展 + server 单测/契约测试，并在 evidence 中同步记录；涉及授权裁决变化的，**先停并走宪章原则五 ADR 门禁**（plan Constitution Check 声明）。

## §4 测试影响面

- server：本规格**零新增** server 测试义务（既有 1484 unit/730 contract 基线保持全绿即可）；若走 §3 例外通道，新增测试随缺口产生。
- web：vitest 单测 + Playwright e2e 为主要验收面（见 [ui.md](ui.md) §7 断言映射）。
