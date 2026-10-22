# Home Media Platform

一个运行在家庭 NAS 上的自托管媒体平台。它以家庭为资源边界，以 Profile 为观看身份，统一管理 Live TV、电影/剧集、本地媒体库和播放体验。

## 当前状态

- 阶段：阶段 1「应用脚手架与身份基础」收尾完成（2026-10-23 重新验收）
- 领域模型：V1.1 Frozen
- 实现状态：身份闭环可用（初始化向导 / 登录 / Profile 选择与切换含 PIN / 设备管理 / 会话生命周期）；阶段 2「ProfilePolicy」尚未开始
- 证据档案：[`docs/specs/001-scaffold-identity-foundation/evidence.md`](docs/specs/001-scaffold-identity-foundation/evidence.md)（65 测试 + 真实进程/浏览器 + 迁移恢复 + ARM64/AMD64 容器）
- 最高治理依据： [项目宪章](.specify/memory/constitution.md)（1.0.1）
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
