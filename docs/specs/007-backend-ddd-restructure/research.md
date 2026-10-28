# Research: 007-backend-ddd-restructure

**Status**: 全部决策已定（无未决 NEEDS CLARIFICATION，规格阶段即以知情默认收敛）
**Date**: 2026-10-28
**输入**: [spec.md](./spec.md)、宪章 v1.4.0 技术约束第 6/7 条、后端现状盘点（约 150 源文件、14 模块、6 对迁移、50+ 契约测试）

## D1. 分层分类法与命名

- **Decision**: 每个业务限界上下文内部统一四层：`domain/`（实体、值对象、领域服务、领域事件、端口接口）、`application/`（用例编排、事务边界）、`infrastructure/`（Drizzle 仓储、NAS/ffmpeg/HTTP/时钟适配器）、`interface/`（NestJS controller、DTO、上下文内守卫）；平台横切归入 `platform/` 上下文（config、database、http-common、health）。非空才建层。
- **Rationale**: 与宪章第 6 条的分层描述逐字对应，审计规则可直接按目录前缀表达；「非空才建层」避免为形式而造空壳（防零遗留红线反弹）。
- **Alternatives considered**: 六边形命名（ports/adapters）——语义等价但与宪章措辞不一致，增加核验映射成本；保持现有扁平模块内部不动——无法满足 FR-001/002，被宪章排除。

## D2. 各层框架依赖策略

- **Decision**: `domain/` 与 `application/` 为纯 TypeScript，禁止导入 NestJS/Drizzle/Express 等任何框架模块；端口以接口定义在 domain/application，由 `interface/` 或上下文模块装配处以注入令牌绑定 `infrastructure/` 实现；`infrastructure/` 适配器与 `interface/` 允许 `@Injectable()` 等框架注解；装饰器零散落在领域/应用层。
- **Rationale**: 宪章第 6 条仅对「领域核心」设禁令；应用层同为纯 TS 可让用例可脱离框架单测（对应 skill `test-use-testing-module` 之外的纯单测路径），令牌绑定同时满足 skill `di-use-interfaces-tokens`。
- **Alternatives considered**: 应用层允许 `@Injectable()`——更省事但引入注解噪音与装配耦合，审计规则更复杂；全域禁注解——会导致基础设施适配器需要大量手工工厂，收益低。

## D3. 跨上下文协作机制

- **Decision**: 三条合法通道：(a) 注入目标上下文「发布接口」——仅经上下文 `index.ts` 导出的应用服务接口（Nest module `exports` 对齐）；(b) 领域事件——本次不新增事件总线依赖，仅当依赖审计发现必须反转的环时，以既有回调端口模式或届时引入的轻量事件机制化解并在 ADR 补记；(c) `@hmp/shared` 契约类型。禁止深导入（`import` 落在上下文 `index.ts` 之外）。
- **Rationale**: 与现状（Nest module 互相 import/exports）最接近，行为零变化风险最小；审计规则可用 dependency-cruiser 的「只许 import 公共入口」表达（对应 skill `arch-avoid-circular-deps`、`arch-module-sharing`）。
- **Alternatives considered**: 立即引入 `@nestjs/event-emitter`——新增运行时依赖且无当前事件需求，违反最小变更；允许直取他处仓储「临时方便」——被 FR-003/004 直接禁止。

## D4. 边界与零遗留审计工具

- **Decision**: 新增两个 devDependencies（仓库根或 `apps/server`）：**dependency-cruiser**（规则：分层禁止逆向依赖；domain/application 禁止导入框架模块；跨上下文只许 import 上下文公共入口）与 **knip**（孤儿文件/死导出/死依赖清点）。以 npm scripts 形式接入合并前门禁（与 `lint/typecheck/test` 同线），违规即门禁失败。
- **Rationale**: 两者均基于静态分析、可机械化判定（FR-009/SC-001/SC-004），输出可留档为多层证据中的静态检查层；knip 直接服务「不得有任何遗留」红线。
- **Alternatives considered**: eslint-plugin-boundaries——能管 import 路径但无死代码能力，需两套工具叠加；ts-arch——社区规模较小；ts-prune/depcheck——仅覆盖死代码单点且维护趋缓。全自研脚本——不可持续。

## D5. 40 条规则与仓库现实的处置原则

- **Decision**: 逐条处置清单落在 [nestjs-best-practices-compliance.md](./nestjs-best-practices-compliance.md)，处置类别三选一：`合规` / `适配执行`（规则意图达成、机制不同）/ `已记录偏离`（附 ADR 条目）。已知适配：输入校验用 zod strict-input（非 class-validator）、认证为 argon2+会话令牌（非 JWT）、ORM 为 Drizzle（非 TypeORM 示例）、测试为 Vitest（非 Jest 示例）、健康检查为自定义就绪端点（非 terminus）、配置为自研 zod env（非 @nestjs/config）。已知偏离候选：API 版本化（V1 单一消费方，推迟）、进程内转换监督（非外部队列）、缓存与懒加载（无度量需求不预加）。
- **Rationale**: 宪章第 7 条明文「skill 与宪章或既定技术栈冲突时以宪章与 ADR 为准，技术栈无关模式必须执行」；该清单即 US3/SC-005 的验收物本体。
- **Alternatives considered**: 全量照搬 skill 字面机制（换 class-validator/Jest/terminus/@nestjs/config）——与行为零变化、零新增运行时依赖冲突，且属无谓重写，被宪章优先级排除。

## D6. 迁移顺序与每步安全网

- **Decision**: 按「先叶后根」序列逐上下文迁移，每步 = 移动文件 + 机械修正导入路径 + `typecheck + lint + 全量测试` 全绿后提交：① personal-data（入边最少）验证模式 → ② profile → ③ policy → ④ epg → ⑤ live-tv → ⑥ sources（含 imports）→ ⑦ media-catalog（catalog+public-catalog 合并）→ ⑧ identity-access（auth+household 合并）→ ⑨ settings → ⑩ playback（最复杂，最后）→ ⑪ platform/（common+config+database+health 收口）→ ⑫ app.module/main 组合根收尾 + 审计接入 + 零遗留清点。测试文件导入路径随步机械更新，断言语义不变。
- **Rationale**: 小步可回滚、每步全量测试做行为回归；入边最少的上下文先验证模式，复杂上下文（playback 24 文件）放在模式成熟后；platform 收口放最后因其被所有上下文依赖。
- **Alternatives considered**: 一次性大迁移——无法定位回归来源，违背小步原子变更；按层横向迁移（先全移 domain）——模块边界与层边界交叉推进，中间态不可审计。

## D7. 行为零变化的证据基线

- **Decision**: 以既有测试资产为可执行契约：`test:contract`（50+ Supertest 契约/e2e，含 `privacy-negative`、`playback-anonymous-rejection` 等安全负向）+ `test:unit` + `test:runtime` 冒烟 + `migration:drill`（空库 up/down/up）。每迁移步全量重跑；实现完成时另做前后响应快照抽查（抽样覆盖全部控制器路由）留档为运行时证据。路由/DTO/状态码零改动由 `interface/` 层机械搬运保证。
- **Rationale**: 宪章原则一要求多层证据；契约测试即「真实契约」层，快照抽查补运行时行为层。
- **Alternatives considered**: 仅靠 typecheck——类型相同仍可能语义漂移，不满足证据层级；引入全新黄金文件全量对比——成本高且既有契约测试已覆盖主要语义，收益边际。

## 未决项

无。所有 NEEDS CLARIFICATION 已在规格阶段以知情默认收敛（见 spec.md Assumptions）。
