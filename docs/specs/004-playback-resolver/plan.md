# Implementation Plan: 播放解析与受控播放

**Branch**: 实际 Git 分支 master；功能标识 004-playback-resolver（setup-plan 返回的逻辑标识） | **Date**: 2026-10-25 | **Spec**: [spec.md](spec.md)

**Status**: Accepted（2026-10-25 维护者接受，授权实现；实现完成——T059 六门禁全绿；Verified 待浏览器/硬件/镜像证据，缺口见 evidence.md T060 FR/SC 终验核对）

## Maintainer Acceptance Record（T001）

- **接受对象**: [spec.md](spec.md) 与 [ADR-0009](../../adr/0009-playback-delivery-conversion.md)
- **接受依据**: 维护者于 2026-10-25（Asia/Shanghai）在本实现会话中，经 T001 门禁问询明确选择「接受并开始实现」，授权进入实现；同轮确认执行范围为 tasks.md 全部 61 个任务。
- **效力**: spec 与 ADR-0009 状态流转 Proposed → Accepted → Implementing；tasks.md 中全部未执行任务的实现授权自此生效。
- **边界**: 本记录不预填任何任务勾选或验收证据；真实浏览器三内核、NAS 硬件加速、双架构容器等本机环境无法产生的证据按任务要求如实保留为环境缺口，不得以仿真替代宣称通过。

## Summary

统一授权解析与同源播放网关，支持 IPTV HLS、NAS 直接播放、转封装、音频转换及视频转换；1080p SDR 兼容范围按 FR-014。每个媒体请求重验设备会话、绑定档案、最新策略与资源可用性。FFmpeg/ffprobe 作为受控子进程，业务授权与转换执行解耦。hls.js 支持 MSE 浏览器，Safari 使用原生 HLS。不承诺任意 NAS 实时转换。

## Technical Context

- Language/Version：现有 Node >=24、TypeScript ^5.8、pnpm 11.28.5。
- Primary Dependencies：现有 NestJS ^12、React ^19、HeroUI、Drizzle/better-sqlite3；拟新增 hls.js，系统 FFmpeg/ffprobe；实施时锁定已验证版本、镜像 digest、编译特性与许可证清单。本轮不修改包文件。
- Storage：SQLite 新增 0005_playback；私有 DATA_DIR/playback/<household>/<session>/<generation>/ 临时目录；无共享转换缓存、无云依赖。
- Testing：现有 Vitest/Supertest、runtime-smoke；补真实 Chromium/Firefox/Safari、Linux amd64/arm64 容器及真实硬件加速样本。
- Target Platform：Docker/Linux NAS，非 root；硬件设备显式映射，默认无特权容器。硬件不可用允许软件回退。
- Project Type：现有 pnpm web/server/shared 单仓库，不增加独立数据库、队列或常驻工作服务。
- Performance Goals：解析 P95 <=1s（不等待完整探测/转换）；转换首帧有声 <=30s、跳转恢复 <=15s；连续播放跨两次续期。参数见 research R4。
- Scale/Scope：单实例单家庭；转换并发默认1、可配置1～8；直接播放不占转换额度；无排队。
- Constraints：只读媒体、逐请求授权、地址脱敏、私有产物；1080p SDR、不烧录字幕、不做自适应清晰度；有界探测、CPU线程与磁盘预算。

## Constitution Check

| 原则 | 设计前 | 设计后 |
|---|---|---|
| 先规格、ADR，后实现 | 本轮调用 plan 作为对已澄清需求的规划授权；spec 仍 Proposed，不推断为技术设计接受 | PASS（设计阶段）；进入实现必须显式接受 spec 与 ADR-0009，否则禁止实现 |
| Household/Account/Profile | 复用会话可信源，不接受客户端授权事实 | 所有新表、目录、查询带 household；播放关联 profile；复合外键和负向测试 |
| 服务端播放鉴权 | SessionGuard + authorizeCurrentProfile 现有入口可复用 | 所有清单、分片、key、字幕、Range 重验；不以能力声明扩大权限 |
| NAS/隐私 | 本地存储，无云依赖 | 非 root、受限子进程、只读源文件、私有短期产物 |
| 非破坏演进与证据 | 新迁移，不改0001～0004 | down/up、备份恢复、全量回归及真实浏览器/Network 分层验证 |

无宪章例外。实现门禁未通过不阻止本轮 Proposed 设计，但阻止任何实现承诺。

## Project Structure

设计产物：plan.md、research.md、data-model.md、contracts/api.md、quickstart.md；架构决策 docs/adr/0009-playback-delivery-conversion.md。tasks.md 由后续 speckit-tasks 生成。

拟实现位置：

```text
apps/server/src/modules/playback/  # 授权、解析、tickets、网关、探测、转换监督、审计
apps/server/src/database/migrations/0005_playback/
apps/server/test/{unit/playback,contract}/
apps/web/src/components/playback/  # 播放器、字幕/音轨、准备状态
apps/web/src/pages/MediaDetail.tsx
packages/shared/src/playback-schema.d.ts
```

复用 common/session.guard.ts、policy/authorizeCurrentProfile 与可信目录事实；不修改策略规则。MediaDetail 继续使用代次守卫，档案变化销毁播放器并拒绝旧异步结果。新增共享契约独立生成，不覆盖旧 schema。Dockerfile 仅在实施阶段加入受审查的 FFmpeg 运行依赖。

## Phase 0 — Research

见 [research.md](research.md)：交付、身份、HLS代理、格式矩阵、资源预算、故障回收与迁移决策均给出默认设计，无 NEEDS CLARIFICATION；硬件性能是待验证证据，不是假定已通过。

## Phase 1 — Design

见 [data-model.md](data-model.md)、[contracts/api.md](contracts/api.md)、[quickstart.md](quickstart.md)。迁移0005创建播放会话、凭据、转换、失败事件；不改变目录、名单、EPG身份。资源定位不进入对外 DTO；记录查询 owner+当次密码，普通播放器仅能读取自己的会话。

### Integration order

先契约与失败测试→0005/就绪与恢复→统一授权及凭据→NAS Range/HLS代理→探测与计划→转换监督及跳转→字幕/音轨→播放器与自动续期→审计→真实端到端/容器/硬件性能。生成与迁移串行，所有阶段保留003回归。具体任务由后续命令生成。

## Complexity Tracking

无宪章偏离。子进程用于媒体处理隔离，并发监督保留在同一 Nest 进程；不引入外部服务。FFmpeg 编译特性、NAS设备权限和不同浏览器编码支持必须在部署证据中记录；缺少任一必验路径不得标 Verified。

## 分析修订（2026-10-25）

201只接受请求，preparing异步探测/准备→ready→首次交付playing；接口P95<=1秒与首次有声画<=30秒分别验证。delivery/source仅准备期可空，状态与所有字段约束唯一权威为data-model.md。所有同步拒绝无session且记有效设备失败事件，异步失败更新session。

资源按最低可用处理成本→source_id→playback_source_id排序，无人工priority字段；ready后固定来源。seek/需重建音轨以generation+version CAS回到preparing，不签票，ready后renew；纯字幕只增version。renew携expectedGeneration，短事务比较+前端operationEpoch，避免旧响应覆盖新操作。cleanup_state仅pending/complete。迁移完整测试在四表齐备后跑；US2b记录API调用在其UI任务内完成，不依赖后续US3。任务不再复制模型。
