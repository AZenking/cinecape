# nestjs-best-practices 合规处置清单（US3 / SC-005 验收物）

**Feature**: 007-backend-ddd-restructure | **Date**: 2026-10-28
**规则来源**: `nestjs-best-practices` skill v1.2.0（40 条规则、10 类别；全局安装于 `~/.agents/skills/nestjs-best-practices`）
**处置类别**: ✅ 合规 · 🔄 适配执行（意图达成、机制不同，仍须证据）· ⏸ 已记录偏离（须附 ADR 条目）
**裁决依据**: 宪章 v1.4.0 技术约束第 7 条——skill 与宪章/既定技术栈冲突时以宪章与已接受 ADR 为准；技术栈无关模式必须执行。
**使用方式**: 实现阶段逐条填「证据位置」列；任何无记录偏离 = SC-005 不通过。偏离条目统一汇入结构方案 ADR 的「规则偏离清单」章节。

## 1. Architecture（CRITICAL）

| 规则 | 处置 | 说明 | 证据位置 |
|---|---|---|---|
| arch-avoid-circular-deps | ✅ | dependency-cruiser 禁环规则 + 迁移步序化解既有环 | 待填 |
| arch-feature-modules | ✅ | 10 上下文 module 化（plan.md 结构树） | 待填 |
| arch-module-sharing | ✅ | 发布面唯一出口 index.ts（contracts/internal-context-contracts.md） | 待填 |
| arch-single-responsibility | ✅ | 四层拆分后服务职责单一化映射 | 待填 |
| arch-use-repository-pattern | 🔄 | 仓储抽象照做，机制为 Drizzle（非 TypeORM 示例）；playback 已有 repository 先例 | 待填 |
| arch-use-events | 🔄 | 本次不新增事件总线；仅当审计发现必须反转的环时按 D3 化解并补记 | 待填 |

## 2. Dependency Injection（CRITICAL）

| 规则 | 处置 | 说明 | 证据位置 |
|---|---|---|---|
| di-avoid-service-locator | ✅ | 全程构造器注入，无全局容器取用 | 待填 |
| di-interface-segregation | ✅ | 端口按消费方拆分（发布面白名单） | 待填 |
| di-liskov-substitution | ✅ | 端口实现替换不收窄前置条件；测试替身即验证 | 待填 |
| di-prefer-constructor-injection | ✅ | 领域/应用层零属性注入 | 待填 |
| di-scope-awareness | ✅ | 维持全单例现状（行为零变化）；请求态经显式上下文参数传递（现 profile-context 模式） | 待填 |
| di-use-interfaces-tokens | ✅ | `<context>.tokens.ts` 集中 Symbol 令牌 | 待填 |

## 3. Error Handling（HIGH）

| 规则 | 处置 | 说明 | 证据位置 |
|---|---|---|---|
| error-use-exception-filters | ✅ | platform/http-common problem-json.filter 统一异常出口 | 待填 |
| error-throw-http-exceptions | 🔄 | interface 层用 HTTP 异常；domain/application 用 domain-error 契约类型，边界处翻译 | 待填 |
| error-handle-async-errors | ✅ | 迁移步 type+test 全绿含异步路径；拦截器既有行为不变 | 待填 |

## 4. Security（HIGH）

| 规则 | 处置 | 说明 | 证据位置 |
|---|---|---|---|
| security-auth-jwt | 🔄 | 非_jwt_：argon2 + 服务端会话令牌（宪章/ADR-0001 既定），令牌签发/校验/失效安全要求逐项对照执行 | 待填 |
| security-validate-all-input | 🔄 | zod strict-input 管道（非 class-validator）；校验强度对照规则要求核验 | 待填 |
| security-use-guards | ✅ | session/current-profile/same-origin/settings-access 守卫体系原样保持 | 待填 |
| security-sanitize-output | ✅ | public-media-projection 等白名单投影模式；公共响应无个人数据负向测试为证 | 待填 |
| security-rate-limiting | ✅ | 既有 rate-limit 守卫/策略/服务保留并归位 | 待填 |

## 5. Performance（HIGH）

| 规则 | 处置 | 说明 | 证据位置 |
|---|---|---|---|
| perf-async-hooks | ✅ | 异步生命周期核对（onModuleInit 等用法在迁移中不劣化） | 待填 |
| perf-use-caching | ⏸ | 候选偏离：V1 单家庭 NAS 场景无度量到的缓存需求，不预加缓存层（ADR 记录；出现度量需求时按规格立项） | 待填 |
| perf-optimize-database | ✅ | 迁移中逐仓储核对索引使用与查询形状；禁止新增 N+1（既有查询模式保持） | 待填 |
| perf-lazy-loading | ⏸ | 候选偏离：应用体量小、启动预算未超，不引入 LazyModule（ADR 记录） | 待填 |

## 6. Testing（MEDIUM-HIGH）

| 规则 | 处置 | 说明 | 证据位置 |
|---|---|---|---|
| test-use-testing-module | ✅ | @nestjs/testing + Vitest（非 Jest 示例，机制适配） | 待填 |
| test-e2e-supertest | ✅ | 50+ contract/e2e 规格即证据资产，全程保持全绿 | 待填 |
| test-mock-external-services | ✅ | 既有替身模式沿用；端口化后替身注入更直接 | 待填 |

## 7. Database & ORM（MEDIUM-HIGH）

| 规则 | 处置 | 说明 | 证据位置 |
|---|---|---|---|
| db-use-transactions | ✅ | 事务边界收口在 application；Drizzle 事务适配执行 | 待填 |
| db-avoid-n-plus-one | ✅ | 迁移步审计既有查询；契约测试覆盖列表型端点 | 待填 |
| db-use-migrations | ✅ | 迁移 0001–0006 原样保留 + migration:drill 证据（SQL 文件机制，非代码迁移） | 待填 |

## 8. API Design（MEDIUM）

| 规则 | 处置 | 说明 | 证据位置 |
|---|---|---|---|
| api-use-dto-serialization | 🔄 | zod DTO + 显式投影函数（非 class-transformer 白名单序列化）；公共响应负向测试为证 | 待填 |
| api-use-interceptors | ✅ | logging / security-headers 拦截器保持 | 待填 |
| api-versioning | ⏸ | 候选偏离：V1 单一消费方（apps/web 同仓同部署），无版本共存需求（ADR 记录，演进时按新规格启用） | 待填 |
| api-use-pipes | ✅ | strict-input 管道体系保持 | 待填 |

## 9. Microservices（MEDIUM）

| 规则 | 处置 | 说明 | 证据位置 |
|---|---|---|---|
| micro-use-patterns | ⏸ | 候选偏离：单体交付（宪章技术约束 1：NAS 单实例），无微服务传输需求 | 待填 |
| micro-use-health-checks | 🔄 | 自定义就绪端点（platform/health）对照健康检查规则意图核验（非 terminus） | 待填 |
| micro-use-queues | ⏸ | 候选偏离：转码监督为进程内 supervisor/watchdog（ADR 记录；规模化时按新规格立项） | 待填 |

## 10. DevOps & Deployment（LOW-MEDIUM）

| 规则 | 处置 | 说明 | 证据位置 |
|---|---|---|---|
| devops-use-config-module | 🔄 | 自研 zod env 校验配置（platform/config，非 @nestjs/config）；「类型安全 + 启动期失败」意图对照核验 | 待填 |
| devops-use-logging | ✅ | 结构化日志 + log-redaction 脱敏保持 | 待填 |
| devops-graceful-shutdown | ✅ | 迁移中核验 SIGTERM 处理与连接收尾不劣化（runtime-smoke + docker 交付核对） | 待填 |

## 统计与结论栏（实现完成时填写）

- 合规：__ 条 · 适配执行：__ 条 · 已记录偏离：__ 条 · 覆盖率：40/40
- 偏离条目已在结构方案 ADR「规则偏离清单」章节登记：是 / 否
- 结论：SC-005 通过 / 不通过（原因）
