# 合规核验证据：nestjs-best-practices 类别 1–5（24 条）· T026+T027

**Feature**: 007-backend-ddd-restructure | **Date**: 2026-10-28 | **基线**: HEAD `eea2be8`
**核验人**: 子代理（只读分析 + 本证据文件，未改任何源码、未触碰主清单、未运行 git）
**规则原文**: `~/.agents/skills/nestjs-best-practices/rules/`（24 个 .md 全部先读原文再核验）
**核验手段**: grep / 读代码 / 内联 node 脚本（导入图环检测、跨 module 重复提供扫描）/ 引用 T024 `boundary-audit.md` 与 T025 `behavior-parity.md` 结论 / 对照 ADR-0014 与主清单既有处置列。

**结论速览**：合规 17 · 适配 5 · 偏离 2 · 建议改判 0（主清单 24 条处置全部维持；2 处"说明"级不符与 2 处次要缺口见 §6 发现）。

---

## 1. Architecture（6 条）

### 1.1 arch-avoid-circular-deps

| 项 | 内容 |
|---|---|
| 处置 | ✅（主清单：dependency-cruiser 禁环规则 + 迁移步序化解既有环） |
| 核验结论 | **合规**（Nest Module 级）——但主清单**说明列与事实不符**，见备注 |
| 证据位置 | ① Nest module 图为 DAG：`apps/server/src/app.module.ts:54` 组合根平铺导入 10 上下文 + platform；各上下文 module 仅 import `HttpCommonModule`，仅有的跨上下文 module 边为 `playback/playback.module.ts:732`（→PersonalDataModule）与 `settings/settings.module.ts:43`（→SourcesModule），均单向、无回边。② `forwardRef` 全仓 grep = 0；`ModuleRef` grep = 0。③ 内联脚本对 `src/**` 175 个 TS 文件建运行时导入图（剥离 `import type`/`export type` 后 DFS）：**Nest module 级 0 环；文件级运行时环 4 个**，全部经发布面 index.ts（`identity-access/index.ts:16` re-export bootstrap.service → `@contexts/policy`（`bootstrap.service.ts:6` 取 `defaultPolicyValues`）→ `policy.service.ts:7` 取 `getDb/verifyParentPassword` → `@contexts/identity-access` 回环；另经 `profile.service.ts:8,11`、`pin.service.ts:7` 共 4 条环路）。④ 环良性证据：环上绑定值全部在**函数体内调用期**消费（`bootstrap.service.ts:114`、`policy.service.ts:80/101/104` 等），无模块求值期取用；`behavior-parity.md` §0 全量 1376/1376 + 真实构建冒烟 465 断言 PASS + §3.5 双树 65/65 快照一致，运行时零故障。 |
| 备注 | **与主清单说明不符**：`.dependency-cruiser.cjs` 实际仅 7 条规则（L170–L306：R1a/R1b/R1c/R1d/R2/R3/R4），**无任何环检测规则**——"dependency-cruiser 禁环规则"不成立；环不被机械化禁止（上述 4 个文件级环均为审计合法边组成）。规则原文的规制对象是 NestJS **Module** 间环（"Module A imports Module B…#1 cause of runtime crashes"），该层面本仓确证无环且无 forwardRef，故 **处置 ✅ 维持、不改判**；建议主清单修订该条说明文字，并在后续规格（建议 008 连同仓储化）考虑补 `no-circular` 审计规则覆盖发布面值消费环。 |

### 1.2 arch-feature-modules

| 项 | 内容 |
|---|---|
| 处置 | ✅（10 上下文 module 化） |
| 核验结论 | 合规 |
| 证据位置 | `src/contexts/` 恰为 10 上下文目录（epg/identity-access/live-tv/media-catalog/personal-data/playback/policy/profile/settings/sources），每上下文按需含 domain/application/infrastructure/interface 四层 + `<ctx>.module.ts` + `index.ts` + `*.tokens.ts`/`*.ports.ts`；`src/` 顶层仅 `app.module.ts`/`main.ts`/`contexts/`/`platform/`——无技术层组织（全仓顶层无 controllers/、services/ 目录）；`app.module.ts:15-24,54` 逐一导入 10 个上下文 module。 |
| 备注 | 结构事实与 ADR-0014 决策 1 一致；模块更名合并（Auth+Household→IdentityAccess 等）已由 `routes-after.md` 0 diff 背书。 |

### 1.3 arch-module-sharing

| 项 | 内容 |
|---|---|
| 处置 | ✅（发布面唯一出口 index.ts） |
| 核验结论 | 合规 |
| 证据位置 | ① 跨上下文访问唯一通道 = 发布面：`contracts/internal-context-contracts.md` 发布面规则 1–3 + R2 深导入禁令（`.dependency-cruiser.cjs:275-276`），T024 双模式审计 0 violations（`boundary-audit.md` §1：`✔ no dependency violations found (204 modules, 1074 dependencies)`，负向探针 exit 2 证明强制有效）。② 重复提供检查：内联脚本解析全部 `*.module.ts` 的 `providers` 数组，76 个不同 provider token，**跨 module 重复提供 = 0**（唯一命中 "PORT" 为脚本解析伪影，实为 `app.module.ts:41/45` 的 `SESSION_VERIFIER_PORT`/`SETTINGS_GRANT_VALIDATOR_PORT`，各自全仓仅一处 provide）。③ `@Global` 全仓仅 1 处：`app.module.ts:37` PlatformPortsModule（平台横切端口），符合规则"仅横切关注点可 Global"的克制要求。 |
| 备注 | `settings.module.ts:33` 注释明确 RefreshExecutorService 单实例语义（"与旧 SourcesModule 同一实例"），迁移未产生双实例。 |

### 1.4 arch-single-responsibility

| 项 | 内容 |
|---|---|
| 处置 | ✅（四层拆分后服务职责单一化映射） |
| 核验结论 | 合规 |
| 证据位置 | ① 典型分解：`playback/application/` 10 个单一职责服务（playback-resolver / playback-authorization / playback-plan / playback-audit / playback-retention / playback-assets / playback-rate-limit / playback-selection / playback-ticket / conversion-watchdog）；`identity-access/application/` 按 session / device / parent-verification / bootstrap / setup / household 分立。② "And"式复合命名服务全仓 find = 0。③ 启动装配专职化：`playback.module.ts:652` PlaybackBootstrapper 仅承担启动引导。 |
| 备注 | 职责映射与 ADR-0014 决策 2 四层落位一致；无 god service 迹象（最大服务文件均围绕单一聚合域）。 |

### 1.5 arch-use-repository-pattern

| 项 | 内容 |
|---|---|
| 处置 | 🔄（仓储抽象照做，机制为 Drizzle；playback 已有 repository 先例） |
| 核验结论 | **适配成立**（意图部分达成 + 登记分阶段合规） |
| 证据位置 | ① 正面先例：`playback/infrastructure/playback.repository.ts`（Drizzle 查询封装，导入 drizzle-orm/schema 于文件头），消费方经注入：`playback/interface/playback.controller.ts:203` `@Inject(PlaybackRepository)`、`playback-stream.controller.ts:134`、`application/playback-resolver.service.ts:293`。② 机制适配：skill 示例为 TypeORM `@InjectRepository`，本仓为 Drizzle + 纯函数/类仓储（ADR-0014 偏离清单登记）。③ 登记 5 数字实测复核（application 层）：`getDb` **35** 文件、`drizzle-orm` **34** 文件、`better-sqlite3` **10** 文件——与 ADR-0014 登记 5（35/34/10，68 条导入边）**逐项一致**。 |
| 备注 | "未按仓储模式抽取"的部分已按宪章约束 7 登记（ADR-0014 登记 5），补救路径规格 008；审计规则（修正 2/3）不将其记为违规（T024 归零背书）。处置方向无需改动。 |

### 1.6 arch-use-events

| 项 | 内容 |
|---|---|
| 处置 | 🔄（本次不新增事件总线；仅当审计发现必须反转的环时按 D3 化解并补记） |
| 核验结论 | **适配成立**（以"无事件需求"形态达成意图） |
| 证据位置 | ① `EventEmitter2` / `@OnEvent` / `@nestjs/event-emitter` 全仓 grep = **0**。② 触发条件核验：规则/ADR 的事件化触发器是"出现必须反转的环"——实测 Nest module 级 0 环、0 forwardRef（见 1.1），DI 解析层面无需事件反转；ADR-0014 Alternatives 明确拒绝立即引入 `@nestjs/event-emitter`（最小变更、零新增运行时依赖）。③ 跨上下文解耦由发布面接口通道承担（组合根 + ports，见 §2 各条）。 |
| 备注 | 文件级 4 个运行时环（1.1）均为调用期绑定良性环，不构成"必须反转的环"，未触发 D3 事件化条件；若未来出现模块求值期消费发布面值的形态，需重审本条。 |

---

## 2. Dependency Injection（6 条）

### 2.1 di-avoid-service-locator

| 项 | 内容 |
|---|---|
| 处置 | ✅（全程构造器注入，无全局容器取用） |
| 核验结论 | 合规 |
| 证据位置 | `ModuleRef` 全仓 grep = 0（含规则点名的 `moduleRef.get` 动态取用与其"合法例外"工厂形态）；`getInstance(` / `ServiceContainer` / `globalThis.__` 手写容器 grep = 0；全部依赖经构造器（见 2.4）。 |
| 备注 | 无。 |

### 2.2 di-interface-segregation

| 项 | 内容 |
|---|---|
| 处置 | ✅（端口按消费方拆分，发布面白名单） |
| 核验结论 | 合规 |
| 证据位置 | ① 一服务一接口的窄端口：`epg.ports.ts:17,25`（IEpgManualBindingService/IEpgService）、`identity-access.ports.ts:10,15,20`、`profile.ports.ts:10,18,26`、`policy.ports.ts:18,24`、`settings.ports.ts:10`、`sources.ports.ts:21`、`media-catalog.ports.ts:11`、`live-tv.ports.ts:9`；平台横切按守卫消费拆分：`platform/http-common/platform.ports.ts:22,38`（SESSION_VERIFIER_PORT / SETTINGS_GRANT_VALIDATOR_PORT 各配窄接口）。② 发布面禁止导出实现类（contracts 规则 3；R2/矩阵审计 0 违规背书）。③ 消费方只依赖所用能力：`playback.controller.ts:211` `@Inject(PROGRESS_WRITE_PORT) progressWrite: IProgressWriteService`。 |
| 备注 | 无 fat interface：无任何发布接口聚合多域能力（各接口方法数 ≤ 3，抽样核对）。 |

### 2.3 di-liskov-substitution

| 项 | 内容 |
|---|---|
| 处置 | ✅（端口实现替换不收窄前置条件；测试替身即验证） |
| 核验结论 | 合规（机制为 `satisfies` + 门禁 + 行为等价证据的组合；与 skill 示例的"共享契约测试套件"形态不同，如实记录） |
| 证据位置 | ① 绑定处编译期合同对齐：`epg.module.ts:39,43`、`identity-access.module.ts:49,53,57`、`live-tv.module.ts:26` 等以 `useValue: {...} satisfies I<X>Service` 绑定（token 侧接口与实现函数束逐签名对齐，替换实现必须过 typecheck 门禁）。② 行为侧：`behavior-parity.md` §0 全量 1376/1376（含契约 458/458 真实 HTTP）+ §3.5 双树 65/65 快照一致（含 401/403/409/404 负向形态逐类一致）——真实实现链路与既有行为可互换性成立。③ 测试替身：单测以 plain-object 依赖直接构造服务（vitest 111 文件全绿）。 |
| 备注 | 仓库**无** skill 示例的 `testPaymentGatewayContract` 式共享合同测试套件；LSP 保证由 satisfies+typecheck+契约/快照行为等价组合承担。处置 ✅ 在清单口径（"测试替身即验证"）内成立，证据形态如实留档。 |

### 2.4 di-prefer-constructor-injection

| 项 | 内容 |
|---|---|
| 处置 | ✅（领域/应用层零属性注入） |
| 核验结论 | 合规 |
| 证据位置 | 属性注入形态 `@Inject()`（无 token 的字段注入）全仓 grep = **0**；构造器注入为唯一形态：`playback.module.ts:653-658`、`playback.controller.ts:203,211` 等；`@Inject(TOKEN)` 15 处全部位于构造器参数；domain/application 层零 `@Injectable`（依赖审计 R1a/R1b 归零背书，`boundary-audit.md` §5）。 |
| 备注 | 无。 |

### 2.5 di-scope-awareness

| 项 | 内容 |
|---|---|
| 处置 | ✅（维持全单例；请求态经显式上下文参数传递） |
| 核验结论 | 合规 |
| 证据位置 | ① `Scope.REQUEST` / `Scope.TRANSIENT` / provider `scope:` 全仓 grep = **0**（唯一 "scope:" 命中为 rate-limit 限流域字段 `rate-limit.policies.ts:20,26-30`，系业务概念非 Nest scope）；全部 provider 默认单例，无 scope 气泡。② 请求态显式传参：`playback-resolver.service.ts:309` `resolve(context: SessionContext, mediaId, options)`（服务不持有请求态）；守卫把请求态写入 request 而非服务字段：`session.guard.ts:106`、`current-profile.guard.ts:47`。 |
| 备注 | 与行为零变化目标自洽（单例拓扑未动，`routes-after.md`/快照 0 diff 背书）。 |

### 2.6 di-use-interfaces-tokens

| 项 | 内容 |
|---|---|
| 处置 | ✅（`<context>.tokens.ts` 集中 Symbol 令牌） |
| 核验结论 | 合规 |
| 证据位置 | 9 个上下文令牌文件：`epg.tokens.ts`、`identity-access.tokens.ts`（L30-32 三 Symbol：PARENT_VERIFICATION/BOOTSTRAP/DEVICE）、`live-tv.tokens.ts`、`media-catalog.tokens.ts`、`personal-data.tokens.ts`、`policy.tokens.ts`、`profile.tokens.ts`、`settings.tokens.ts`、`sources.tokens.ts` + 平台 `platform.ports.ts:22,38`；绑定仅发生在 module 装配处（`app.module.ts:41-49`、`identity-access.module.ts:49-57`）；`@Inject(令牌)` 消费 15 处；与 `contracts/internal-context-contracts.md` 规则 5（明文对应 skill `di-use-interfaces-tokens`）一致。 |
| 备注 | 例外形态：playback/personal-data 的 `application/ports.ts` 为上下文内端口（不跨上下文发布），未集中至 `*.tokens.ts`——属上下文内部装配细节，契约未约束，不构成偏离。 |

---

## 3. Error Handling（3 条）

### 3.1 error-use-exception-filters

| 项 | 内容 |
|---|---|
| 处置 | ✅（platform/http-common problem-json.filter 统一异常出口） |
| 核验结论 | 合规 |
| 证据位置 | 全局唯一过滤器：`platform/http-common/problem-json.filter.ts:88-90` `@Catch()` 兜底一切异常，RFC 9457 `application/problem+json` 渲染（`DomainError`→status/code/detail；`HttpException`→对象透传或包装，L18、L48-69 `codeFromHttpStatus`/`wrap`；未知→INTERNAL）；注册于组合根 `app.module.ts:56` `{ provide: APP_FILTER, useClass: ProblemJsonFilter }`；错误路径响应同样被安全响应头兜底覆盖（`response-headers/api-security-headers.interceptor.ts` 文件头 L10 注释及过滤器兜底层）。 |
| 备注 | 控制器层无手工 `res.status(...).json(...)` 错误格式化残留（错误出口统一经过滤器；logout 的 204 手工路径是会话语义特例，见 `session.service.ts:272-276` 注释，非错误格式化）。 |

### 3.2 error-throw-http-exceptions

| 项 | 内容 |
|---|---|
| 处置 | 🔄（interface 层用 HTTP 异常；domain/application 用 domain-error 契约，边界处翻译） |
| 核验结论 | **适配成立**——正是规则原文为分层服务指定的形态 |
| 证据位置 | ① domain/application 用领域错误契约：`platform/http-common/domain-error.ts` `DomainError extends Error` 携 status+稳定 ProblemCode（无框架依赖，宪章跨上下文错误契约，ADR 修正 4 D-②）；抛出示例 `identity-access/interface/validation.ts:15`、各 application 服务。② 边界翻译点：`epg/interface/public-guide.controller.ts:114-118` GuideProblemError→HttpException（T023 治理裁决唯一翻译点，ADR-0014 修正 2"已真修"项）。③ domain 层框架纯净：`src/contexts/*/domain/` 对 `@nestjs`/drizzle/better-sqlite3 grep = **0**（`epg/domain/guide-problems.ts` 的 "HttpException" 仅存于注释 L10/20/32，说明翻译契约）；R3 审计规则强制（`.dependency-cruiser.cjs:292-293`，T024 归零）。④ 统一渲染见 3.1。 |
| 备注 | 规则原文："For truly layer-agnostic services, use domain exceptions that map to HTTP status codes."——本仓 DomainError（status 字段）+ 过滤器渲染即该模式的实现；interface 层翻译/抛 HTTP 异常满足规则前半句。🔄 维持。 |

### 3.3 error-handle-async-errors

| 项 | 内容 |
|---|---|
| 处置 | ✅（迁移步 type+test 全绿含异步路径；拦截器既有行为不变） |
| 核验结论 | 合规（后台任务显式处理齐备；一处全局安全网缺省如实记录于备注） |
| 证据位置 | ① 后台循环：sources 刷新执行器 `refresh-executor.service.ts:831` `onModuleInit` 启动串行 `workerLoop`（L839+），单步 `runQueuedOnce`（L356）内部 try/catch 捕获任务级错误，循环不因单任务失败 reject。② 转码看门狗：`conversion-watchdog.service.ts` catch L122/182/325、fire-and-forget 处 `.catch(` L251。③ 定时链 start/stopTimers 配对、`onModuleDestroy` 停转（`refresh-executor.service.ts:837`；`playback.module.ts:668-671` retention 注释）。④ 路由异步错误由全局过滤器兜底（3.1）+ `enableShutdownHooks`（`main.ts:29`）。⑤ 行为侧全绿背书：`behavior-parity.md` §0（1376/1376、冒烟 465 断言含异步全流程场景 S1–S9）。 |
| 备注 | **次要缺口（不改处置）**：`main.ts` 无 `process.on('unhandledRejection'/'uncaughtException')` 全局安全网（规则 correct 示例含此）；`void bootstrap()`（main.ts 末行）启动期 reject 依赖 Node 默认行为。建议后续规格补两行全局 handler；非本特性范围。 |

---

## 4. Security（5 条）

### 4.1 security-auth-jwt

| 项 | 内容 |
|---|---|
| 处置 | 🔄（非 JWT：argon2 + 服务端会话令牌；令牌签发/校验/失效安全要求逐项对照执行） |
| 核验结论 | **适配成立**（规则的安全意图逐项有机制对应，机制非 JWT） |
| 证据位置 | 非 JWT 依据：ADR-0001（身份模型）+ ADR-0014 偏离清单。安全要求对照：① 机密管理——不透明令牌无签名密钥可泄；配置经 zod env 校验（`platform/config/env.schema.ts`），无硬编码密钥。② 令牌寿命——`SESSION_TTL_DAYS` env 注入，`session.service.ts:19,91-100`（expiresAt = now + TTL）。③ 令牌校验/失效——32 字节 CSPRNG 签发、SHA-256 哈希落库（`token.service.ts:10-12`）、`timingSafeEqual` 常时比对防时序侧信道（`token.service.ts:17-26`）、`revoked_at` 撤销含"过期会话补注销"（`session.service.ts:272-287`）、设备级撤销 `device.service` revokeHouseholdDevice（settings 经发布面消费）。④ 敏感数据不入令牌/响应——argon2id 哈希仅落库（`password.service.ts:4-15`，参数 64MB/t=3/p=4），公共响应负向测试（`public-browse-negative.e2e-spec.ts:41,99`）。⑤ 认证负向形态双树一致（`behavior-parity.md` §3.5：游客 401/错误密码 401/logout 204/logout 后 401）。 |
| 备注 | 无 refresh-token 机制（以 TTL + 服务端撤销替代）——ADR 已登记为适配，处置维持。 |

### 4.2 security-validate-all-input

| 项 | 内容 |
|---|---|
| 处置 | 🔄（zod strict-input 管道，非 class-validator；校验强度对照规则要求核验） |
| 核验结论 | **适配成立**（未知键拒绝强度达成；覆盖面实测 37/37） |
| 证据位置 | ① 机制：`strict-input/strict-schema.ts:22-23` `strictObject`（未知键一律拒绝，等价 whitelist+forbidNonWhitelisted）；`strict-input/strict-pipes.ts:16-38` StrictBodyPipe/StrictQueryPipe（400 VALIDATION_FAILED）。② 覆盖面实测：全部 37 处 `@Body(` —— 30 处挂管道（如 `auth.controller.ts:53` `@Body(new StrictBodyPipe(loginRequestSchema))`）+ 7 处 playback `@Body() body: unknown` 全部在处理器内 `parseBody(<严格 schema>, body)`（`playback.controller.ts:226,265,288,314,344,368,384`；schema 均带 `.strict()`，如 L71-74）。③ 校验失败统一 400 稳定错误码（`validation.ts:9-17`）；错误形态双树一致（`behavior-parity.md` §3.5"未知载荷 400 同形"）。 |
| 备注 | 非全局 ValidationPipe，逐参数显式挂载——新增端点漏挂无机械化防漏（靠契约负向用例兜底）；与主清单说明一致，处置维持。 |

### 4.3 security-use-guards

| 项 | 内容 |
|---|---|
| 处置 | ✅（session/current-profile/same-origin/settings-access 守卫体系原样保持） |
| 核验结论 | 合规 |
| 证据位置 | 守卫五件套落位 platform 横切：`session.guard.ts:96`（canActivate L106）、`profile-context/current-profile.guard.ts:46`（L47）、`same-origin/same-origin.guard.ts:65`（L66）、`settings-access/settings-access.guard.ts:32`（L39）、`rate-limit/rate-limit.guard.ts:29`；挂载面抽查：`settings-devices.controller.ts:41,53,66`、`settings-household.controller.ts:35,41`、`settings-profiles.controller.ts:65-94`、`public-guide.controller.ts:68`；守卫依赖经组合根 @Global PlatformPortsModule 注入（`app.module.ts:37-49`；`session.guard.ts:101` 注释）。行为证据：授权负向形态双树一致（`behavior-parity.md` §3.5：无授予 403、匿名 401）。 |
| 备注 | 守卫为逐控制器/路由 `@UseGuards` 显式挂载、非 APP_GUARD 全局默认拒绝——系既有契约形态（路由 0 diff 保全），与清单"守卫体系原样保持"口径一致。 |

### 4.4 security-sanitize-output

| 项 | 内容 |
|---|---|
| 处置 | ✅（public-media-projection 等白名单投影模式；公共响应无个人数据负向测试为证） |
| 核验结论 | 合规 |
| 证据位置 | ① 白名单投影唯一出口：`media-catalog/domain/public-media-projection.ts`——`toPublicMedia` 仅输出 7 个白名单字段；posterRef 同源认可门 `approvedPosterRef` 恒 null（存储值绝不透传渲染，文件头 L1-25 契约注释）；"HTTP 层与服务层一律复用本投影，不另建第二套字段映射"。② 负向测试：`test/contract/public-browse-negative.e2e-spec.ts:41`（公共错误响应不含内部信息片段）、`:99`（`not.toHaveProperty('householdId')`）、`:174-184`（公共错误恒 4xx，非 401/403）。③ 传输层加固：`ApiSecurityHeadersInterceptor` 全响应 no-store + Referrer-Policy（`app.module.ts:59`；`response-headers/api-security-headers.interceptor.ts` 文件头契约注释）。 |
| 备注 | 响应为 JSON API（无 HTML 渲染面），XSS 面由白名单投影 + 安全头覆盖，与规则意图一致。 |

### 4.5 security-rate-limiting

| 项 | 内容 |
|---|---|
| 处置 | ✅（既有 rate-limit 守卫/策略/服务保留并归位） |
| 核验结论 | 合规 |
| 证据位置 | 完整五件套归位 `platform/http-common/rate-limit/`：`rate-limit.policies.ts:26-30`（public 120/min·ip、guide 30/min·ip、progress 60/min·deviceSession——按端点分级，符合规则"auth 端点更严"意图）、`rate-limit.guard.ts:29`（tracker 按 `ip:`/`deviceSession:` 分型，L73；TRUST_PROXY 显式控制转发头信任 L17-19）、`rate-limit.service.ts`、`rate-limit.decorator.ts`、`client-ip.util.ts`；挂载于公共/敏感面：`public-guide.controller.ts:68`、`setup.controller.ts:40`、`live.controller.ts:96`、playback 控制端（`playback.controller.ts` requireSlot + progress 策略）。 |
| 备注 | 自研实现非 `@nestjs/throttler`（零新增运行时依赖约束）；限流形态双树一致（`behavior-parity.md` §0 冒烟含性能基准场景）。 |

---

## 5. Performance（4 条）

### 5.1 perf-async-hooks

| 项 | 内容 |
|---|---|
| 处置 | ✅（异步生命周期核对，onModuleInit 等用法在迁移中不劣化） |
| 核验结论 | 合规 |
| 证据位置 | ① 重初始化置于 async hook 并 await：`playback.module.ts:659-671` PlaybackBootstrapper `async onModuleInit` → `await this.lifecycle.recoverOnBoot()`（缺表形态库以就绪门禁降级、不阻断启动——刻意的 readiness 语义，L662-665 注释）。② 跨模块启动任务用 onApplicationBootstrap：`settings/application/settings-access-revocation.ts:112-113`。③ 刻意不阻塞启动的后台循环显式文档化 + `timer.unref()`（`refresh-executor.service.ts:831-851`），`onModuleDestroy`（L837）与 `enableShutdownHooks`（`main.ts:29`）收尾配对。④ Hook 语义迁移零变化：`behavior-parity.md` §0（冒烟 S1–S9 含启动/恢复场景 465 断言 PASS）。 |
| 备注 | 无构造器重阻塞反模式（配置加载为 import 期纯 zod 解析，非 IO 阻塞）。 |

### 5.2 perf-use-caching

| 项 | 内容 |
|---|---|
| 处置 | ⏸（V1 单家庭 NAS 无度量到的缓存需求，不预加缓存层；ADR 记录） |
| 核验结论 | **偏离确认成立且登记在案** |
| 证据位置 | ADR-0014「规则偏离清单」perf 行（perf-use-caching | 偏离 | V1 单家庭 NAS…按新规格立项）；代码事实：`CacheModule` / `cache-manager` / `CACHE_MANAGER` / `@nestjs/cache` 全仓 grep = **0**。 |
| 备注 | 偏离与 ADR 登记一致；出现度量需求时按新规格立项，本特性内无需动作。 |

### 5.3 perf-optimize-database

| 项 | 内容 |
|---|---|
| 处置 | ✅（迁移中逐仓储核对索引使用与查询形状；禁止新增 N+1） |
| 核验结论 | 合规 |
| 证据位置 | ① 复合索引在案：`platform/database/schema.ts:629`（manual_epg_binding household+source）、`:731,733`（playback_session household+device/profile+createdAt+id）、`:909`（failure_event household+device+occurredAt+id）、`:1017,1147`（favorite/viewing_history 列表键）；迁移 0001–0006 原样保留（`platform/database/migrations/`，`migration:drill` 证据见清单 db-use-migrations）。② 分页：`public-catalog.service.ts:93,114-118`（page/pageSize/total）。③ 查询形状零变化：`behavior-parity.md` §0（1376/1376 + 契约 458/458 覆盖列表型端点 + 双树 65/65 快照一致）。 |
| 备注 | "逐仓储核对"过程留痕于各迁移步门禁（`us1-summary.md`）；本步以终态证据（索引定义 + 行为等价）复核通过。 |

### 5.4 perf-lazy-loading

| 项 | 内容 |
|---|---|
| 处置 | ⏸（应用体量小、启动预算未超，不引入 LazyModule；ADR 记录） |
| 核验结论 | **偏离确认成立且登记在案** |
| 证据位置 | ADR-0014「规则偏离清单」perf 行（perf-lazy-loading | 偏离）；代码事实：`LazyModuleLoader` 全仓 grep = **0**；体量事实：204 modules / 1074 deps（`boundary-audit.md` §1），启动路径冒烟 PASS（`behavior-parity.md` §0）——启动预算未超的判断成立。 |
| 备注 | 与 5.2 同类：登记在案，无需动作。 |

---

## 6. 与既有处置不符之处 / 其他发现

1. **arch-avoid-circular-deps 的"说明"列与事实不符（处置 ✅ 本身维持）**：主清单称"dependency-cruiser 禁环规则"，但 `.dependency-cruiser.cjs` 的 7 条规则（R1a/R1b/R1c/R1d/R2/R3/R4，L170–L306）**不含任何环检测规则**；且本步实测存在 **4 个文件级运行时导入环**（identity-access↔policy↔profile，全部经双方发布面 index.ts 组成审计合法边，环上值均在调用期消费、运行时零故障）。规则原文规制对象为 Nest Module 间环，该层面确证无环、无 forwardRef，故处置 ✅ 维持、不改判；建议：主清单修订该条说明文字（改为"Nest module 图无环（人工+脚本核验）+ 无 forwardRef"），并在规格 008 一并考虑补 `no-circular` 机械审计（连同登记 5 仓储化）。
2. **error-handle-async-errors 次要缺口（不改处置）**：`main.ts` 缺 `process.on('unhandledRejection'/'uncaughtException')` 全局安全网；规则主体（后台任务显式错误处理）合规且证据充分，建议后续规格低成本补齐。
3. **di-liskov-substitution 证据形态（不改处置）**：无 skill 示例的共享合同测试套件；LSP 由绑定处 `satisfies` + typecheck 门禁 + 契约/快照行为等价组合保证，主清单"测试替身即验证"口径成立，证据形态已如实留档（2.3）。
4. **登记 5 数字独立复核一致**：application 层 getDb 35 文件 / drizzle-orm 34 / better-sqlite3 10，与 ADR-0014 登记 5 逐项吻合——"分阶段合规"裁决的代码事实基础无漂移。
5. 其余 20 条的处置、说明与代码事实一致，未发现其他不符。

## 7. 统计

| 类别 | 条数 | 明细 |
|---|---|---|
| 合规（✅ 维持） | **17** | arch-avoid-circular-deps、arch-feature-modules、arch-module-sharing、arch-single-responsibility；di-avoid-service-locator、di-interface-segregation、di-liskov-substitution、di-prefer-constructor-injection、di-scope-awareness、di-use-interfaces-tokens；error-use-exception-filters、error-handle-async-errors；security-use-guards、security-sanitize-output、security-rate-limiting；perf-async-hooks、perf-optimize-database |
| 适配执行（🔄 维持） | **5** | arch-use-repository-pattern、arch-use-events；error-throw-http-exceptions；security-auth-jwt、security-validate-all-input |
| 已记录偏离（⏸ 维持） | **2** | perf-use-caching、perf-lazy-loading（均在 ADR-0014 偏离清单登记，本步确认登记与代码事实一致） |
| 建议改判 | **0** | 无处置级改判；2 条"说明"级修正建议见 §6.1 |

**类别 1–5 合计 24/24 条核验完成；全部核验为只读操作（grep / 读码 / 内联只读脚本 / 引用既有证据），未修改任何源码与主清单，未运行 git。**
