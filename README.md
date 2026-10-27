# Home Media Platform

一个运行在家庭 NAS 上的自托管媒体平台。它以家庭为资源边界，以 Profile 为观看身份，统一管理 Live TV、电影/剧集、本地媒体库和播放体验。

## 当前状态

- 阶段：阶段 1～4 已完成（见下方证据档案）；阶段 5「PC 公开浏览与观看操作流程全面调整」（[规格 005](docs/specs/005-pc-browsing-flow/spec.md)）**实现完成**（2026-10-27：八个用户故事 US1~US8 全部交付，server 1362 用例 / web 100 用例 / e2e 46 用例全绿，见 [005 evidence.md](docs/specs/005-pc-browsing-flow/evidence.md)）；最终 Verified 门禁待 T137～T144 多层证据（真实四浏览器矩阵与 SC-002 真人验收须人工执行——实现完成 ≠ 验收完成）
- 005 交互变更：游客免登录浏览全部可用内容元数据（公开浏览与播放授权分离，ADR-0010）；初始化不再自动登录；主 Profile + 独立 15 分钟设置 PIN 授权（ADR-0011）；收藏/历史/跨设备续播按 Profile 隔离（ADR-0012）；管理入口统一迁入 `/api/settings/*`
- 领域模型：V1.1 Frozen
- 实现状态：身份闭环可用（初始化向导 / 登录 / Profile 选择与切换含 PIN / 设备管理 / 会话生命周期）；内容策略可用（等级 / 未评级 / 名单 / 频道白名单 + 家长验证）；媒体目录与来源可用（IPTV/EPG、NAS 导入、手动 EPG 匹配）；播放解析与受控播放可用（统一授权网关 `POST /playback/resolve`、direct/remux/audio/video 四路径交付、转封装与按需转码、字幕/音轨、家长设备记录）
- 证据档案：[`docs/specs/001-scaffold-identity-foundation/evidence.md`](docs/specs/001-scaffold-identity-foundation/evidence.md)（65 测试 + 真实进程/浏览器 + 迁移恢复 + ARM64/AMD64 容器）；[`docs/specs/002-profile-policy/evidence.md`](docs/specs/002-profile-policy/evidence.md)（109 用例 + 升级/回滚/恢复演练 + 容器内策略链路）；[`docs/specs/003-media-catalog/evidence.md`](docs/specs/003-media-catalog/evidence.md)（456 用例 + runtime 205 断言 + 真实浏览器 + 双架构容器 + 迁移演练）；[`docs/specs/004-playback-resolver/evidence.md`](docs/specs/004-playback-resolver/evidence.md)（961 用例 + runtime 445 断言 + 迁移/恢复演练 + FR/SC 终验核对；浏览器/硬件/镜像缺口如实保留）
- 最高治理依据： [项目宪章](.specify/memory/constitution.md)（1.2.0，含 005/代际2 限定交付例外）
- 当前领域规范：[`homeMediaDomainModel.md`](homeMediaDomainModel.md)

## V1 目标

V1 先解决一个 Household 内的完整观看闭环：

```text
Account 登录
  → 选择 Profile
  → 浏览 Household 可用媒体
  → 按 ProfilePolicy 校验访问权限
  → 解析 PlaybackSource
  → 播放并保存个人进度
```

V1 采用一个 Household、一个主要 Account、多个 Profile 的模型。多 Household、多 Account、复杂转码和社交共享不属于第一阶段。

## 文档入口

| 文档 | 用途 | 状态 |
| --- | --- | --- |
| [`docs/project-brief.md`](docs/project-brief.md) | 产品目标、用户、MVP、范围和成功标准 | Accepted foundation |
| [`homeMediaDomainModel.md`](homeMediaDomainModel.md) | 实体、边界、权限、流程、API 和验收基线 | Frozen V1.1 |
| [项目宪章](.specify/memory/constitution.md) | 工程原则、技术约束与质量门禁 | Ratified 1.0.1 |
| [`docs/adr/0001-household-account-profile.md`](docs/adr/0001-household-account-profile.md) | 原身份模型，保留决策历史 | Superseded by ADR-0003 |
| [`docs/adr/0003-constitution-alignment.md`](docs/adr/0003-constitution-alignment.md) | 按宪章统一身份归属、规格目录与 ADR 门禁 | Accepted |
| [`docs/adr/0004-technology-stack.md`](docs/adr/0004-technology-stack.md) | 技术栈选型（TS 单体 + SQLite + HeroUI v3） | Accepted |
| [`docs/adr/0005-stage1-delivery-details.md`](docs/adr/0005-stage1-delivery-details.md) | 阶段 1 迁移、就绪检查和同源交付实施补充 | Accepted |
| [`docs/specs/001-scaffold-identity-foundation/spec.md`](docs/specs/001-scaffold-identity-foundation/spec.md) | 阶段 1 功能规格：应用脚手架与身份基础 | Verified |
| [`docs/specs/002-profile-policy/spec.md`](docs/specs/002-profile-policy/spec.md) | 阶段 2 功能规格：ProfilePolicy 内容策略 | Verified |
| [`docs/specs/003-media-catalog/spec.md`](docs/specs/003-media-catalog/spec.md) | 阶段 3 功能规格：媒体目录与来源（含 US5 手动 EPG 匹配） | Verified |
| [`docs/specs/004-playback-resolver/spec.md`](docs/specs/004-playback-resolver/spec.md) | 阶段 4 功能规格：播放解析与受控播放 | Accepted；实现完成，Verified 待浏览器/硬件/镜像证据 |
| [`docs/adr/0009-playback-delivery-conversion.md`](docs/adr/0009-playback-delivery-conversion.md) | 播放交付与转换决策（同源网关、票据、转换资源边界） | Accepted |
| [`docs/adr/0006-profile-policy-authorization.md`](docs/adr/0006-profile-policy-authorization.md) | 内容策略顺序与家长管理边界 | Accepted |
| [`docs/adr/0002-one-deployment-one-household.md`](docs/adr/0002-one-deployment-one-household.md) | 固化 V1 部署实例与 Household 的关系 | Accepted |
| [`docs/roadmap.md`](docs/roadmap.md) | 阶段顺序、依赖和完成条件 | Living |

发生冲突时以宪章为准；Accepted ADR 记录宪章下的具体决策，领域模型描述当前有效模型，功能规格与技术计划落实这些约束。Frozen/Accepted 状态不赋予文档覆盖宪章的权限。被替代 ADR 仅用于历史追溯；冲突必须在实现前同步修正。

## Spec Kit 入口

工作流以本地 Spec Kit skills 与项目宪章为准，不另维护自定义规格模板或流程规范：

`speckit-specify → speckit-clarify（需要时）→ speckit-plan → speckit-tasks → speckit-analyze → speckit-implement`

- [specify](.agents/skills/speckit-specify/SKILL.md)：用户场景、需求、成功标准与规格质量清单；
- [plan](.agents/skills/speckit-plan/SKILL.md)：技术计划、研究、数据模型、契约与 quickstart；
- [tasks](.agents/skills/speckit-tasks/SKILL.md)：按用户故事组织可执行任务；
- [analyze](.agents/skills/speckit-analyze/SKILL.md)：跨产物一致性检查；
- [implement](.agents/skills/speckit-implement/SKILL.md)：依据规格、计划和任务实施。

按当前宪章，功能目录使用 `docs/specs/NNN-feature/`。调用 specify 时显式指定 `SPECIFY_FEATURE_DIRECTORY=docs/specs/NNN-feature`（NNN 使用下一个可用编号），使用其支持的目录覆盖能力；后续命令读取 `.specify/feature.json`。不得同时维护根目录 specs/ 的第二份规格。

标准产物包括 `spec.md`、`plan.md`、`tasks.md`、`research.md`、`data-model.md`、`contracts/`、`quickstart.md` 和 `checklists/`，按对应阶段生成，不能预先标记为已完成。

项目简报、领域模型和路线图是项目背景与规划输入，不替代上述功能级产物。ADR 由宪章明确要求，保留决策与替代历史。规格状态及质量门禁以宪章为准。

## 本地启动

前置要求：**Node.js 24**（仓库已带 `.nvmrc`）与 **pnpm 11**（根 `package.json` 的 `packageManager` 锁定 `pnpm@11.28.5`，先执行 `corepack enable` 即可按锁定版本启用；或 `npm i -g pnpm@11.28.5`）。

```bash
# 1) 安装依赖（postinstall 会从 OpenAPI 契约再生成 packages/shared/src/schema.d.ts）
pnpm install

#    若提示 better-sqlite3 缺少原生二进制（Node 版本变化、预编译下载失败等），
#    进入该包目录手动补建。pnpm 11 默认不运行白名单之外依赖的构建脚本
#    （白名单见 pnpm-workspace.yaml 的 allowBuilds：
#    argon2 / better-sqlite3 / esbuild），手动补建不受影响：
cd node_modules/.pnpm/better-sqlite3@*/node_modules/better-sqlite3 && pnpm run install && cd -

# 2) 服务端环境变量（端口、DATA_DIR、会话与 PIN 策略；.env 不入库）
cp apps/server/.env.example apps/server/.env

# 3) 数据库迁移（SQLite；迁移前自动备份 hmp.db.bak-<timestamp>）
pnpm migration:up

# 4) 开发模式（并行启动：server :3000 全局前缀 /api · web :5173，/api 已配置代理）
pnpm dev
```

Docker 交付（单服务；数据持久化在具名卷 `hmp-data` → 容器 `/data`）：

```bash
docker compose up --build
# 探活：http://localhost:3000/api/healthz
```

质量门禁：

```bash
pnpm test        # server Vitest（单元 + 契约 e2e）
pnpm lint        # 根级 ESLint
pnpm typecheck   # 全 workspace tsc --noEmit
pnpm build      # 编译生产前后端，复制 SQL 迁移
pnpm test:runtime # 独立临时数据库：真实 HTTP、重启、备份读取恢复与迁移回滚
```

## 部署依赖与许可

| 组件 | 版本 / 来源 | 许可 | 用途 |
| --- | --- | --- | --- |
| hls.js | 1.7.3（`apps/web` 锁定完整构建，禁用 light 版——音轨/字幕依赖完整版） | Apache-2.0 | 浏览器 HLS 播放（MSE），Safari 另走原生 HLS |
| FFmpeg / ffprobe | 部署镜像 Debian bookworm `5.1.x`（当前 5.1.9，随 security 更新浮动；单一 `ffmpeg` 包同供两个可执行）；本机开发任意 ≥5 版本 | GPL 组件启用构建（`--enable-gpl`，含 libx264/libx265；各链接库按各自许可，libx264 为 GPL-2.0+） | 服务端媒体探测、转封装与按需转码（仅子进程调用） |

许可汇总：hls.js 为 Apache-2.0；FFmpeg 为发行版 GPL 组件启用构建。应用仅在服务器端以子进程调用 FFmpeg、不分发其本体，无整体传染义务；**再分发镜像时需按各组件许可逐项审查**。完整许可与版本记录见 [`docs/specs/004-playback-resolver/research.md`](docs/specs/004-playback-resolver/research.md)「依赖版本锁定（T004）」节。注意：本机开发 FFmpeg（参考环境 8.1.1）的性能结论不得外推到镜像 5.1.9。

## 迁移与恢复

- 迁移 `0005_playback` 新增受控播放四表：`playback_session` / `playback_ticket` / `playback_conversion` / `playback_failure_event`。
- up 按目录名字典序应用：0001 → 0005；down 单次逆序回滚最近一条已应用迁移（连续执行即 0005 → 0001；当前一轮 `down` 删除播放四表及 `device_household_id_id_key` 复合索引，0001–0004 数据零修改；播放记录随表删除、不自行恢复）。
- **down 与 drill 仅允许对独立临时 DATA_DIR 执行；用户库禁止 down/drill**（容器路径同形：stop → `compose run` 迁移 → start，见 004 quickstart SC-006 节）。
- 每次 up/down 均自动以 `VACUUM INTO` 生成停服一致性快照（`hmp.db.bak-<timestamp>`，WAL 下为已检查点完整快照）；用该备份恢复后旧票据不可复活（重启时活动会话标 `interrupted`，票签发谓词不再满足）。细节见 [004 quickstart SC-006](docs/specs/004-playback-resolver/quickstart.md) 与 [evidence T056](docs/specs/004-playback-resolver/evidence.md)。

## 已知限制（阶段 4 播放）

- 兼容范围：NAS 必验上限为 **1080p SDR**（MP4/MKV/AVI/MOV/TS × H.264 / HEVC 8/10bit / MPEG-4 × AAC/AC-3/E-AC-3/DTS，FR-014）；**4K/HDR 仅尽力直放**，不做转换、不自动降分辨率。
- 转码输出固定 H.264 8-bit yuv420p + AAC 的 HLS，**无自适应清晰度**；字幕仅 SRT/WebVTT 文本显示，**不烧录字幕**，无 ASS/图片字幕。
- 转换并发默认 **1**（可配 1–8），remux/transcode 共用额度，超额立即返回忙、**无排队**；直接播放不占额度。
- 验收状态：实现完成（T059 六门禁全绿），但浏览器 Network（US3-01～10）、真实 Linux 硬件加速与资源画像（T058 G1–G6）、linux/amd64+arm64 镜像实测（T057）证据待验收，相关 SC 条目未验收——缺口清单见 [evidence T060](docs/specs/004-playback-resolver/evidence.md)。
