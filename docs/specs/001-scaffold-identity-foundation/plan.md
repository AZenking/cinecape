# Implementation Plan: 应用脚手架与身份基础(Identity Foundation)

**Branch**: `001-scaffold-identity-foundation` | **Date**: 2026-10-22 | **Spec**: [spec.md](spec.md)

**Input**: Feature specification from `/docs/specs/001-scaffold-identity-foundation/spec.md`

## Summary

为单家庭自托管媒体平台建立可启动、可测试的最小服务骨架与身份基础:一次性初始化唯一 Household 与主 Account,用户名/密码登录建立服务端 DeviceSession,Profile 管理与服务端控制的"当前观看者"切换(含 PIN),会话恢复/注销/设备撤销。技术路线:TypeScript + Node 24 的 pnpm monorepo,NestJS API,SQLite + Drizzle(配对回滚迁移),不透明服务端会话令牌(argon2id 凭据哈希),React + Vite + Tailwind v4 前端,OpenAPI 契约先行,多阶段 Docker 交付。选型依据见 [research.md](research.md),决策记录见 [ADR-0004(Accepted)](../../../docs/adr/0004-technology-stack.md)。

## Technical Context

**Language/Version**: TypeScript 5.x(strict)+ Node.js 24 LTS(Active LTS,engines 固定)

**Primary Dependencies**: NestJS 12(Express 适配器)· Drizzle ORM + better-sqlite3 · zod · React 19 + Vite + Tailwind CSS v4 · HeroUI v3(@heroui/react + @heroui/styles,React Aria 底座)· openapi-typescript · Vitest + Supertest

**Storage**: SQLite(WAL 模式)单文件数据库,Docker `/data` 卷持久化;仓库 SQL 执行器迁移（ADR-0005） + 配对 down 回滚脚本 + 迁移前自动备份

**Testing**: Vitest(单元)· NestJS e2e + Supertest(集成/契约)· OpenAPI 契约断言 · up→down→up 迁移演练;FR-019 负向场景为合并门禁

**Target Platform**: Docker/Linux(NAS:amd64 + arm64),家庭局域网访问;Web 浏览器客户端(TV/平板/手机三档响应式)

**Project Type**: web-service + web 前端的 pnpm monorepo(apps/server、apps/web、packages/shared)

**Performance Goals**: 局域网登录 p95 < 300ms;会话校验额外开销 < 20ms;冷启动 < 10s

**Constraints**: 容器内存 < 512MB;运行时零外呼、零遥测(宪章原则 IV);单实例单 Household(ADR-0002);密钥仅环境注入

**Scale/Scope**: 1 Household / 1 Account / ≤ 20 Profiles / ≤ 50 Devices;本阶段交付:初始化向导、登录、Profile 选择/切换(含 PIN)、设备管理、会话生命周期、身份边界负向测试

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

- ✅ **Accepted specification and linked accepted ADRs**: 规格已接受并进入收尾验收；关联 ADR-0002/0003/0004/0005 均已 Accepted。
- ✅ **Household → Account → Profile ownership**: data-model 逐表保留显式 `household_id`;Profile 同时保留 `account_id` 且一致性由约束与负向测试保证;个人数据表本阶段不存在,结构已预留 `profile_id` 边界。
- ✅ **Server-side session with negative tests**: 不透明会话令牌存哈希,注销/撤销即时生效;FR-018/019/020 与 SC-003/004/007 覆盖越权、篡改、绕过 PIN 的负向门禁。
- ✅ **Docker/Linux NAS delivery**: 多阶段 Dockerfile(amd64/arm64)+ compose 单服务;数据全部本地 `/data` 卷;无强制云依赖、无遥测。
- ✅ **Quality gates**: 静态检查(tsc/eslint)、单元/集成契约测试、运行时与网络证据(quickstart curl 序列)、迁移 up→down→up 演练、文档与代码同变更提交。

**Gate 结论**: 设计依据已接受；完成状态必须以 Phase 7 收敛任务和最新 evidence.md 为准，历史勾选不能替代验证。

## Project Structure

### Documentation (this feature)

```text
docs/specs/001-scaffold-identity-foundation/
├── plan.md              # This file (/speckit-plan command output)
├── research.md          # Phase 0 output (/speckit-plan command)
├── data-model.md        # Phase 1 output (/speckit-plan command)
├── quickstart.md        # Phase 1 output (/speckit-plan command)
├── contracts/           # Phase 1 output (/speckit-plan command)
│   └── openapi.yaml     # 身份边界先行契约(OpenAPI 3.1)
└── tasks.md             # Phase 2 output (/speckit-tasks command - NOT created by /speckit-plan)
```

### Source Code (repository root)

```text
apps/
├── server/                      # NestJS API —— 本阶段实现身份边界
│   ├── src/
│   │   ├── modules/
│   │   │   ├── auth/            # 登录/注销/会话恢复(含 account、session、device 子域)
│   │   │   ├── household/       # 家庭信息与一次性初始化
│   │   │   └── profile/         # Profile 生命周期、选择/切换、PIN
│   │   ├── common/              # Guard(会话信任源)、problem+json 过滤器、幂等辅助
│   │   ├── config/              # zod 环境配置(fail-fast)
│   │   ├── database/            # drizzle schema、迁移目录(up + 配对 down)、备份脚本
│   │   └── main.ts
│   └── test/
│       ├── unit/                # 领域规则(归属校验、默认/停用约束、锁定窗口)
│       └── contract/            # e2e:OpenAPI 断言 + FR-019 负向场景
├── web/                         # React + Vite + Tailwind v4
│   └── src/
│       ├── pages/               # 初始化向导 / 登录 / Profile 选择 / 设备管理
│       ├── components/          # HeroUI v3 基础件 + 自建媒体组件(海报卡、档案卡、焦点环)
│       └── lib/                 # 会话通道(Cookie/Bearer)与 API 客户端
packages/
└── shared/                      # openapi-typescript 生成类型 + 会话/错误契约常量
Dockerfile                       # 多阶段构建(amd64/arm64)
docker-compose.yml               # 单服务 + /data 卷 + healthcheck
```

**Structure Decision**: 采用 pnpm workspace 三包结构(research D2):`apps/server` 实现本阶段全部身份能力,`apps/web` 提供最小可用的初始化/登录/选择 Profile 界面(UI 参照见 research D6),`packages/shared` 承载契约类型以保证领域核心与 UI 解耦(宪章技术约束 4)。

## Complexity Tracking

> 无宪章违规,无需记录。
