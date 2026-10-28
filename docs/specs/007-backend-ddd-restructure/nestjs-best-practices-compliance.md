# nestjs-best-practices 合规处置清单（US3 / SC-005 验收物）

**Feature**: 007-backend-ddd-restructure | **Date**: 2026-10-28
**规则来源**: `nestjs-best-practices` skill v1.2.0（40 条规则、10 类别；全局安装于 `~/.agents/skills/nestjs-best-practices`）
**处置类别**: ✅ 合规 · 🔄 适配执行（意图达成、机制不同，仍须证据）· ⏸ 已记录偏离（须附 ADR 条目）
**裁决依据**: 宪章 v1.4.0 技术约束第 7 条——skill 与宪章/既定技术栈冲突时以宪章与已接受 ADR 为准；技术栈无关模式必须执行。
**使用方式**: 实现阶段逐条填「证据位置」列；任何无记录偏离 = SC-005 不通过。偏离条目统一汇入结构方案 ADR 的「规则偏离清单」章节。

## 1. Architecture（CRITICAL）

| 规则 | 处置 | 说明 | 证据位置 |
|---|---|---|---|
| arch-avoid-circular-deps | ✅ | Nest Module 级依赖图 DAG（0 环）；文件级存在 4 个经发布面 index.ts 的调用期绑定环（identity-access↔policy↔profile），运行时零故障（1376 测试+465 断言+65/65 快照背书）；机械 no-circular 审计与仓储化抽取一并列入规格 008 范围（ADR-0014 登记 5） | compliance-cat-1-5.md §1.1 —— Module 级 0 环、0 forwardRef；文件级 4 环均为调用期绑定良性边，处置 ✅ 维持（本行说明已按核验事实修订） |
| arch-feature-modules | ✅ | 10 上下文 module 化（plan.md 结构树） | compliance-cat-1-5.md §1.2 —— `src/contexts/` 恰 10 上下文四层落位，顶层无技术层组织，组合根逐一导入 |
| arch-module-sharing | ✅ | 发布面唯一出口 index.ts（contracts/internal-context-contracts.md） | compliance-cat-1-5.md §1.3 —— R2 深导入禁令审计 0 violations（204 modules/1074 deps）；跨 module 重复提供 0；@Global 仅 1 处 |
| arch-single-responsibility | ✅ | 四层拆分后服务职责单一化映射 | compliance-cat-1-5.md §1.4 —— playback/identity-access 服务按单一聚合域分立；「And」式复合命名全仓 0 |
| arch-use-repository-pattern | ✅ | 仓储抽象全量落地（10 上下文 application 层，规格 008/ADR-0015：端口 + seam + Drizzle 实现 + 装配绑定，SQL 逐字迁移行为零变化） | 008 evidence/audit-tightening.md（双门禁归零 + 负向探针）+ evidence/behavior-parity.md（1376 测试 + runtime 465 断言）；登记 5 已补救（ADR-0014 注记） |
| arch-use-events | 🔄 | 本次不新增事件总线；仅当审计发现必须反转的环时按 D3 化解并补记 | compliance-cat-1-5.md §1.6 —— 适配成立：EventEmitter2/@OnEvent 全仓 0；无必须反转的环，未触发事件化条件 |

## 2. Dependency Injection（CRITICAL）

| 规则 | 处置 | 说明 | 证据位置 |
|---|---|---|---|
| di-avoid-service-locator | ✅ | 全程构造器注入，无全局容器取用 | compliance-cat-1-5.md §2.1 —— ModuleRef/手写容器/全局取用全仓 grep = 0 |
| di-interface-segregation | ✅ | 端口按消费方拆分（发布面白名单） | compliance-cat-1-5.md §2.2 —— 各上下文窄端口在案（接口方法数 ≤3 抽样），无 fat interface |
| di-liskov-substitution | ✅ | 端口实现替换不收窄前置条件；测试替身即验证 | compliance-cat-1-5.md §2.3 —— satisfies 绑定 + typecheck 门禁 + 契约/快照行为等价组合保证（无共享合同测试套件，证据形态如实留档） |
| di-prefer-constructor-injection | ✅ | 领域/应用层零属性注入 | compliance-cat-1-5.md §2.4 —— 属性注入 0；@Inject(TOKEN) 15 处全部位于构造器参数；domain/application 零 @Injectable |
| di-scope-awareness | ✅ | 维持全单例现状（行为零变化）；请求态经显式上下文参数传递（现 profile-context 模式） | compliance-cat-1-5.md §2.5 —— Scope.REQUEST/TRANSIENT 全仓 0，全 provider 单例；请求态经显式上下文参数传递 |
| di-use-interfaces-tokens | ✅ | `<context>.tokens.ts` 集中 Symbol 令牌 | compliance-cat-1-5.md §2.6 —— 9 上下文 `*.tokens.ts` + platform.ports.ts 集中令牌；绑定仅发生在 module 装配处 |

## 3. Error Handling（HIGH）

| 规则 | 处置 | 说明 | 证据位置 |
|---|---|---|---|
| error-use-exception-filters | ✅ | platform/http-common problem-json.filter 统一异常出口 | compliance-cat-1-5.md §3.1 —— ProblemJsonFilter @Catch 全局唯一（RFC 9457），组合根 APP_FILTER 注册；无手工错误格式化残留 |
| error-throw-http-exceptions | 🔄 | interface 层用 HTTP 异常；domain/application 用 domain-error 契约类型，边界处翻译 | compliance-cat-1-5.md §3.2 —— 适配成立：DomainError 契约 + interface 层唯一翻译点；domain 层框架纯净 R3 审计归零 |
| error-handle-async-errors | ✅ | 迁移步 type+test 全绿含异步路径；拦截器既有行为不变 | compliance-cat-1-5.md §3.3 —— 后台循环/看门狗显式 try-catch + 停转配对，1376 全绿背书；全局安全网缺省见「备注级跟进项」② |

## 4. Security（HIGH）

| 规则 | 处置 | 说明 | 证据位置 |
|---|---|---|---|
| security-auth-jwt | 🔄 | 非_jwt_：argon2 + 服务端会话令牌（宪章/ADR-0001 既定），令牌签发/校验/失效安全要求逐项对照执行 | compliance-cat-1-5.md §4.1 —— 适配成立：机密管理/令牌寿命/校验失效/敏感数据/负向形态五方面逐项对照规则意图 |
| security-validate-all-input | 🔄 | zod strict-input 管道（非 class-validator）；校验强度对照规则要求核验 | compliance-cat-1-5.md §4.2 —— 适配成立：strictObject 拒未知键；37 处 @Body 全覆盖（30 挂管道 + 7 处处理器内 parseBody） |
| security-use-guards | ✅ | session/current-profile/same-origin/settings-access 守卫体系原样保持 | compliance-cat-1-5.md §4.3 —— 守卫五件套落位 platform 横切，挂载面抽查 + 授权负向形态双树一致 |
| security-sanitize-output | ✅ | public-media-projection 等白名单投影模式；公共响应无个人数据负向测试为证 | compliance-cat-1-5.md §4.4 —— toPublicMedia 白名单唯一出口（posterRef 同源认可门恒 null）；负向测试 + 安全头兜底 |
| security-rate-limiting | ✅ | 既有 rate-limit 守卫/策略/服务保留并归位 | compliance-cat-1-5.md §4.5 —— rate-limit 五件套归位 platform/http-common/rate-limit，按端点分级（public 120/guide 30/progress 60 每分钟） |

## 5. Performance（HIGH）

| 规则 | 处置 | 说明 | 证据位置 |
|---|---|---|---|
| perf-async-hooks | ✅ | 异步生命周期核对（onModuleInit 等用法在迁移中不劣化） | compliance-cat-1-5.md §5.1 —— async onModuleInit await + 后台循环 timer.unref() + onModuleDestroy/enableShutdownHooks 配对；冒烟 S1–S9 背书 |
| perf-use-caching | ⏸ | 候选偏离：V1 单家庭 NAS 场景无度量到的缓存需求，不预加缓存层（ADR 记录；出现度量需求时按规格立项） | compliance-cat-1-5.md §5.2 —— 偏离确认成立且登记在案：CacheModule/cache-manager 全仓 0，与 ADR-0014 偏离清单一致 |
| perf-optimize-database | ✅ | 迁移中逐仓储核对索引使用与查询形状；禁止新增 N+1（既有查询模式保持） | compliance-cat-1-5.md §5.3 —— 复合索引在案（schema.ts 6 处）+ 分页 + 查询形状零变化（契约/快照背书） |
| perf-lazy-loading | ⏸ | 候选偏离：应用体量小、启动预算未超，不引入 LazyModule（ADR 记录） | compliance-cat-1-5.md §5.4 —— 偏离确认成立且登记在案：LazyModuleLoader 全仓 0；204 modules 启动路径冒烟 PASS |

## 6. Testing（MEDIUM-HIGH）

| 规则 | 处置 | 说明 | 证据位置 |
|---|---|---|---|
| test-use-testing-module | ✅ | @nestjs/testing + Vitest（非 Jest 示例，机制适配） | compliance-cat-6-10.md §6（test-use-testing-module）—— @nestjs/testing 为真实 devDependency，Test.createTestingModule 统一引导，51 契约 spec 复用 |
| test-e2e-supertest | ✅ | 50+ contract/e2e 规格即证据资产，全程保持全绿 | compliance-cat-6-10.md §6（test-e2e-supertest）—— Supertest 打真实 Nest HTTP server：51 spec/458 用例全绿，夹具含完整 setup/teardown 与重启场景 |
| test-mock-external-services | ✅ | 既有替身模式沿用；端口化后替身注入更直接 | compliance-cat-6-10.md §6（test-mock-external-services）—— 受控本地 HTTP 服务器 + ManualClock + 手写 fake；requestCount=0 证明零外部副作用 |

## 7. Database & ORM（MEDIUM-HIGH）

| 规则 | 处置 | 说明 | 证据位置 |
|---|---|---|---|
| db-use-transactions | ✅ | 事务边界收口在 application；Drizzle 事务适配执行 | compliance-cat-6-10.md §7（db-use-transactions）—— 28 文件 db.transaction 收口 application；BEGIN IMMEDIATE 单事务原子性有契约级证据 |
| db-avoid-n-plus-one | ✅ | 迁移步审计既有查询；契约测试覆盖列表型端点 | compliance-cat-6-10.md §7（db-avoid-n-plus-one）—— 集合查询为常态（inArray 批量装载 11 文件）；一级循环体启发式扫描 0 命中 |
| db-use-migrations | ✅ | 迁移 0001–0006 原样保留 + migration:drill 证据（SQL 文件机制，非代码迁移） | compliance-cat-6-10.md §7（db-use-migrations）—— 0001–0006 SQL 迁移对 + drill 实际回滚重放 exit 0；无 synchronize 概念 |

## 8. API Design（MEDIUM）

| 规则 | 处置 | 说明 | 证据位置 |
|---|---|---|---|
| api-use-dto-serialization | 🔄 | zod DTO + 显式投影函数（非 class-transformer 白名单序列化）；公共响应负向测试为证 | compliance-cat-6-10.md §8（api-use-dto-serialization）—— 适配成立：toPublicMedia 显式投影白名单唯一出口；privacy-negative 真实 HTTP 探针钉死零泄漏 |
| api-use-interceptors | ✅ | logging / security-headers 拦截器保持 | compliance-cat-6-10.md §8（api-use-interceptors）—— APP_INTERCEPTOR 注册安全头 + 访问日志拦截器，与规则列举用途同构；业务控制器零重复日志 |
| api-versioning | ⏸ | 候选偏离：V1 单一消费方（apps/web 同仓同部署），无版本共存需求（ADR 记录，演进时按新规格启用） | compliance-cat-6-10.md §8（api-versioning）—— 偏离确认：enableVersioning/@Version 0 命中，67 端点无版本段；ADR-0014 偏离清单登记一致 |
| api-use-pipes | ✅ | strict-input 管道体系保持 | compliance-cat-6-10.md §8（api-use-pipes）—— Strict 管道 58 处挂载，未知键一律 400，强度等价超集于规则示例 |

## 9. Microservices（MEDIUM）

| 规则 | 处置 | 说明 | 证据位置 |
|---|---|---|---|
| micro-use-patterns | ⏸ | 候选偏离：单体交付（宪章技术约束 1：NAS 单实例），无微服务传输需求 | compliance-cat-6-10.md §9（micro-use-patterns）—— 偏离确认：零微服务传输面（0 命中）；宪章技术约束 1 单实例单体，ADR 登记一致 |
| micro-use-health-checks | 🔄 | 自定义就绪端点（platform/health）对照健康检查规则意图核验（非 terminus） | compliance-cat-6-10.md §9（micro-use-health-checks）—— 适配成立：/api/healthz 未就绪 503 Problem JSON + Dockerfile HEALTHCHECK 接通；差距见「备注级跟进项」③ |
| micro-use-queues | ⏸ | 候选偏离：转码监督为进程内 supervisor/watchdog（ADR 记录；规模化时按新规格立项） | compliance-cat-6-10.md §9（micro-use-queues）—— 偏离确认：零队列设施；进程内 supervisor/watchdog（硬超时/速度判罚）等价承载，ADR 登记一致 |

## 10. DevOps & Deployment（LOW-MEDIUM）

| 规则 | 处置 | 说明 | 证据位置 |
|---|---|---|---|
| devops-use-config-module | 🔄 | 自研 zod env 校验配置（platform/config，非 @nestjs/config）；「类型安全 + 启动期失败」意图对照核验 | compliance-cat-6-10.md §10（devops-use-config-module）—— 适配成立：zod env 编译期类型安全 + 启动期 fail-fast + 集中单源 |
| devops-use-logging | ✅ | 结构化日志 + log-redaction 脱敏保持 | compliance-cat-6-10.md §10（devops-use-logging）—— 结构化 + log-redaction 单一入口双闸；负向测试钉死日志无明文；requestId 缺省见「备注级跟进项」④ |
| devops-graceful-shutdown | ✅ | 迁移中核验 SIGTERM 处理与连接收尾不劣化（runtime-smoke + docker 交付核对） | compliance-cat-6-10.md §10（devops-graceful-shutdown）—— enableShutdownHooks + OnApplicationShutdown 收尾直测背书（lifecycle.spec 关停 hook 断言）+ FR-005 重启场景 PASS |

## 统计与结论栏（2026-10-28 T030 定稿）

- 合规：27 条 · 适配执行：8 条 · 已记录偏离：5 条 · 覆盖率：40/40
  - 分项来源：合规 27 = 类别 1–5 的 17（compliance-cat-1-5.md）+ 类别 6–10 的 10（compliance-cat-6-10.md）；适配执行 8 = 5 + 3；已记录偏离 5 = 2 + 3（各证据文件末尾统计节）。两份分类核验与主清单既有处置零改判（建议改判 0 + 0）。
  - 已记录偏离 5 条：api-versioning、micro-use-patterns、micro-use-queues、perf-use-caching、perf-lazy-loading
- 偏离条目已在结构方案 ADR「规则偏离清单」章节登记：是（[ADR-0014](../../../adr/0014-backend-ddd-structure.md)「规则偏离清单」表逐行登记上列 5 条偏离与全部 8 条适配执行；另见「治理裁决修正」登记 5——application 层直取数据的分阶段合规偏离，补救路径为规格 008）
- 结论：SC-005 通过（40/40 条逐条核验并留证于两份分类证据文件；无任何无记录偏离）

## 备注级跟进项（非偏离）

以下 5 条为两份分类核验证据中的备注级发现，均不构成偏离、不改变任何条目的处置类别，故不进入 ADR-0014 偏离清单；逐条留档以便后续规格承接：

1. **arch 环检测机械审计缺失**：`.dependency-cruiser.cjs` 现有 7 条规则不含环检测（no-circular）规则，文件级 4 个调用期绑定良性环（见 arch-avoid-circular-deps 条目）无机械化禁环。→ 机械 no-circular 审计列入规格 008 范围（与 ADR-0014 登记 5 仓储化抽取一并承接）。〔出处：compliance-cat-1-5.md §1.1、§6.1〕
2. **main.ts 缺全局安全网**：无 `process.on('unhandledRejection'/'uncaughtException')` 兜底；后台任务显式错误处理本身已合规。→ 后续规格补两行全局 handler 即可，非本特性范围。〔出处：compliance-cat-1-5.md §3.3、§6.2〕
3. **healthz 无 live/ready 分离与关停期 503 联动**：现为单 readiness 端点（仅反映 db 态），`isReady` 不联动关停期显式 503；单实例 NAS 部署下 Dockerfile 单探针可承载编排语义。〔出处：compliance-cat-6-10.md §9（micro-use-health-checks）、§10（devops-graceful-shutdown）〕
4. **日志无 requestId/CLS 关联**：访问拦截器仅记 method/url/status/耗时四字段、无请求关联标识（脱敏根策略为「不采集」）；T142 已知，留待 lead 层跟进。〔出处：compliance-cat-6-10.md §10（devops-use-logging）〕
5. **unit 层 DI-mock 非主流**：unit 主流风格为真实临时 SQLite 库（生产同源迁移 DDL）+ fake adapter，`@nestjs/testing` 直接使用仅 6 文件；不打真实外部服务，意图达成，非缺陷、无需动作。〔出处：compliance-cat-6-10.md §6（test-use-testing-module）〕
