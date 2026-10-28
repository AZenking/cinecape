# ADR-0014：后端 DDD 分层与限界上下文结构对齐（007）

- 状态：Accepted（2026-10-28 维护者随规格007实施指令显式接受；实施与证据见 specs/007 tasks.md 及 evidence/）
- 依据：维护者结构对齐指令（宪章 v1.4.0 技术约束6/7、"不得有任何遗留"）；宪章原则一/二/三/五、技术约束3/4；规格007研究 D1–D7。
- 关联：[规格007](../specs/007-backend-ddd-restructure/spec.md)、[研究](../specs/007-backend-ddd-restructure/research.md)、[结构数据模型](../specs/007-backend-ddd-restructure/data-model.md)、[外部契约冻结](../specs/007-backend-ddd-restructure/contracts/external-http-invariants.md)、[发布面契约](../specs/007-backend-ddd-restructure/contracts/internal-context-contracts.md)、[规则合规清单](../specs/007-backend-ddd-restructure/nestjs-best-practices-compliance.md)、ADR-0003（宪章对齐）、ADR-0004（技术栈）、ADR-0001（身份模型）。

## Context

宪章 v1.4.0 生效技术约束第 6 条（后端 DDD 分层与边界不可越界）与第 7 条（后端实现严格执行 `nestjs-best-practices`）。`apps/server` 现状：14 个功能模块扁平布局（约 150 源文件），模块内控制器/服务/适配器混排，跨模块存在深导入，无机械化边界审计。需在不改变任何外部行为的前提下完成结构对齐，且不得遗留孤儿文件、死代码或临时垫片。

## Decision

1. **限界上下文**：14 模块归并为 10 个业务上下文（identity-access、profile、policy、media-catalog、epg、live-tv、playback、personal-data、settings、sources）+ 平台横切 `platform/`（config、database、http-common、health）。Nest Module 按上下文一一对应更名/合并。
2. **四层与框架策略**：每上下文内 `domain/application/infrastructure/interface` 四层，非空才建。`domain` 与 `application` 为纯 TypeScript（禁止 import `@nestjs/*`、`drizzle-orm`、`better-sqlite3`、`express`）；端口接口定义于 domain/application，注入令牌集中于 `<context>.tokens.ts`，绑定只发生在 module 装配处；`infrastructure`/`interface` 允许框架注解。
3. **跨上下文协作**：仅三条合法通道——经上下文 `index.ts` 发布的应用服务接口、领域事件（本次不新增事件总线，仅在依赖审计发现必须反转的环时化解并补记）、`@hmp/shared` 契约。深导入即违规。
4. **机械化审计**：dependency-cruiser（层矩阵 + 深导入禁令 + 框架渗漏禁令）与 knip（孤儿/死导出/死依赖）以 `audit:boundaries` / `audit:orphans` 接入合并前门禁，违规即失败。
5. **迁移序列**：按"先叶后根"12 步（personal-data → profile → policy → epg → live-tv → sources → media-catalog → identity-access → settings → playback → platform → 组合根），每步 = 移动 + 机械导入修正 + 快速门禁（typecheck/lint/全量测试）+ 独立提交。
6. **行为零变化证据**：路由清单快照 0 diff、全量测试与安全负向用例全绿、运行时冒烟、`migration:drill`、响应快照抽查，全部留档 `evidence/`。

### 规则偏离清单（nestjs-best-practices 处置，与合规清单联动）

| 类别 | 条目 | 处置 | 说明 |
|---|---|---|---|
| arch | arch-use-repository-pattern | 适配 | 仓储抽象照做，以 Drizzle 实现（skill 示例为 TypeORM） |
| arch | arch-use-events | 适配 | 不新增事件总线；审计发现必须反转的环时按决策 3 化解并补记本 ADR |
| security | security-auth-jwt | 适配 | 认证为 argon2 + 服务端会话令牌（ADR-0001 既定，非 JWT）；令牌签发/校验/失效安全要求逐项对照执行 |
| security | security-validate-all-input | 适配 | zod strict-input 管道（非 class-validator）；校验强度对照规则核验 |
| error | error-throw-http-exceptions | 适配 | interface 层 HTTP 异常；domain/application 用 domain-error 契约，边界处翻译 |
| perf | perf-use-caching | 偏离 | V1 单家庭 NAS 无度量到的缓存需求，不预加缓存层；出现度量需求按新规格立项 |
| perf | perf-lazy-loading | 偏离 | 应用体量小、启动预算未超，不引入 LazyModule |
| api | api-use-dto-serialization | 适配 | zod DTO + 显式投影函数（非 class-transformer）；公共响应负向测试为证 |
| api | api-versioning | 偏离 | V1 单一消费方（apps/web 同仓同部署），无版本共存需求；演进时按新规格启用 |
| micro | micro-use-patterns | 偏离 | 单体交付（宪章技术约束 1：NAS 单实例），无微服务传输需求 |
| micro | micro-use-health-checks | 适配 | 自定义就绪端点（platform/health，非 terminus）对照规则意图核验 |
| micro | micro-use-queues | 偏离 | 转码监督为进程内 supervisor/watchdog；规模化时按新规格立项 |
| devops | devops-use-config-module | 适配 | 自研 zod env 校验（platform/config，非 @nestjs/config）；"类型安全 + 启动期失败"意图对照核验 |

## Alternatives and consequences

- 六边形命名（ports/adapters）：语义等价但与宪章措辞不一致，核验映射成本高，弃用。
- 立即引入 `@nestjs/event-emitter`：新增运行时依赖且无当前事件需求，违反最小变更，弃用。
- eslint-plugin-boundaries / ts-arch / ts-prune：无法同时覆盖层矩阵、深导入与死代码，弃用 dependency-cruiser+knip 之外的组合。
- 一次性大迁移或按层横向迁移：回归不可定位、中间态不可审计，弃用。
- 全量照搬 skill 字面机制（class-validator/Jest/terminus/@nestjs/config）：与行为零变化、零新增运行时依赖冲突，按宪章第 7 条优先级弃用（见偏离清单）。
- 后果与约束：本结构落地后即成为宪章强制设施——后续新增后端代码必须按上下文四层落位并通过门禁审计；审计脚本与配置本身纳入零遗留清点范围。
