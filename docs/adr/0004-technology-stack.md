# ADR-0004:技术栈选型(TypeScript 单体 + SQLite)

- 状态:Accepted(2026-10-22,维护者确认)
- 实施补充：[ADR-0005](0005-stage1-delivery-details.md)（迁移执行器、UUID 与单服务部署细节，2026-10-23）；以下保留原选型正文。
- 日期:2026-10-22
- 依据:[宪章 1.0.1](../../.specify/memory/constitution.md) · [领域模型 V1.1](../../homeMediaDomainModel.md) · [规格 001 research](../../docs/specs/001-scaffold-identity-foundation/research.md)
- 关联:遵循 [ADR-0002](0002-one-deployment-one-household.md) 单部署单 Household;遵循 [ADR-0003](0003-constitution-alignment.md) 身份归属与规格流程

## Context

项目进入阶段 1(应用脚手架与身份基础),必须固定运行时、包管理器、数据库与交付形态(路线图阶段 1 第一项任务)。宪章技术约束要求:Docker/Linux 交付、适配家用 NAS、轻量资源占用、领域核心不反向依赖前端框架、迁移可回滚;原则 IV 要求本地私有数据、无强制云依赖。此前没有任何技术选型 ADR。

完整决策对比见 [research.md](../../docs/specs/001-scaffold-identity-foundation/research.md),本 ADR 只记录结论级决策。

## Decision

1. **语言与运行时**:TypeScript(strict)+ Node.js 24 LTS,全栈单语言;DTO 类型经 `packages/shared` 共享,领域核心不 import 任何前端框架代码。
2. **仓库与包管理**:pnpm workspace monorepo——`apps/server`、`apps/web`、`packages/shared`。
3. **后端**:NestJS(默认 Express 适配器);模块划分对齐领域模型 §7;以 Guard 强制"服务端会话为唯一信任源"。
4. **数据库**:SQLite(WAL)+ better-sqlite3 + Drizzle ORM;drizzle-kit 迁移,每条迁移配对 down 回滚脚本,迁移前自动备份数据库文件,回滚路径必须实际演练。
5. **会话与凭据**:不透明随机会话令牌(仅存 SHA-256 哈希);httpOnly Cookie + Bearer 双通道;argon2id 哈希密码与 PIN;会话 30 天滑动过期、绝对上限 90 天、PIN 锁定 5 次失败锁 5 分钟(均可配置)。
6. **前端**:React 19 + Vite + Tailwind CSS v4;基础组件库采用 HeroUI v3(@heroui/react,React Aria 底座,焦点/键盘/onPress 统一输入),媒体特有组件(海报卡、档案卡、播放器控件)自建于同一 token 体系;UI 参照 Netflix 档案选择页/海报墙与 Netflix Kids 式儿童模式,暗色优先、TV 友好;播放内核 hls.js 于阶段 4 接入。
7. **契约**:OpenAPI 3.1 手写先行契约(contracts/openapi.yaml),openapi-typescript 生成共享类型,zod 做服务端运行时校验,错误格式统一 RFC 9457。
8. **交付**:多阶段 Dockerfile(amd64/arm64)+ docker-compose 单服务 + `/data` 卷 + `/healthz` healthcheck;运行时零外呼、零遥测。

## Alternatives considered

- **Go/Rust 后端**:分发与占用更优,但前后端类型不共享、迭代成本高;对单家庭低并发场景收益不成立。
- **PostgreSQL**:能力过剩,家庭部署需额外维护一个常驻服务,违背轻量约束;若未来多家庭/高并发,经新 ADR 迁移(领域模型已要求显式 household_id,为迁移留了结构余地)。
- **JWT 会话**:无状态签发虽简单,但注销/设备撤销要求立即失效(规格 FR-010/011),服务端会话表才是直接满足该语义的模型。
- **antd/MUI**:管理后台范式与家庭媒体消费场景不匹配;MUI 的 Emotion 与 Tailwind v4 双样式体系并存,违背技术约束 4。
- **shadcn/ui(Base UI/Radix,源码进仓库)**:视觉自由度与生态最大,但基座偏鼠标指针交互,10 英尺焦点导航需自建,默认审美偏管理后台;与 HeroUI 的差距主要在输入/焦点底座而非生态规模。
- **React Aria Components 裸用 / 组件全自建**:控制力最强,但阶段 1 即需手写表单、弹窗、Toast 等全部标准件,成本不成比例;HeroUI 即 React Aria 的预样式封装,选它保留该底座而免掉自建成本。

## Consequences

- 优点:单一语言栈、零运维数据库、开箱即用的 compose 交付、契约类型不漂移、模块边界与领域模型一一对应。
- 代价:SQLite 写并发有限——多设备同时写进度时依赖 WAL 与低频写入模型;若演进为多家庭部署,数据库与部署形态需新 ADR 重新决策。
- Node/NestJS/React 大版本升级遵循常规 semver 维护;破坏性升级需评估但不需新 ADR,改变上述任何**选型方向**(换数据库、换框架、引入微服务)必须新增 ADR。

## Migration and rollback

当前仓库无应用代码与存量数据,本 ADR 生效后由规格 001 的 tasks 建立脚手架与首版迁移;首版迁移起即执行"迁移前备份 + down 脚本演练"制度(规格 SC-006)。撤回本 ADR 需以新 ADR 替代并附迁移路径,不得静默篡改。

## Verification

- 仓库出现 `pnpm-workspace.yaml`、两 apps 一 shared 的目录结构,`package.json` engines 固定 Node 24;
- `docker compose up` 后 `/healthz` 返回就绪;
- 迁移目录中每条 up 迁移存在配对 down 脚本,且 CI 实际执行 up→down→up;
- 会话表中不存在明文令牌列;argon2id 哈希可通过前缀验证;
- 前端未引入本 ADR 之外的 UI 框架;`packages/shared` 不含前端框架 import。
