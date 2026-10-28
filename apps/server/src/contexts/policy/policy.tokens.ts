/**
 * policy 注入令牌集中地（contracts §5）。
 *
 * 令牌面 = 跨上下文被消费的应用服务（T020 grep 实测消费清单）：
 * - policy.batch-context（loadAvailableMediaIdSet / loadBatchCatalogContext）：
 *   epg / live-tv / media-catalog / personal-data 消费；
 * - policy.service（authorizeCurrentProfile / getPolicy / updatePolicy / replacePolicyLists）：
 *   playback / settings 消费。
 *
 * 本上下文服务为纯函数模块（见 policy.module.ts 头注释惯例），无 @Injectable 类；
 * 令牌绑定经 useValue 函数束（T021，`satisfies` 对齐对应接口）。
 * domain/policy.rules 的 defaultPolicyValues / parseStoredList 与 MediaType /
 * MediaPolicyFacts 类型为跨上下文必需的领域纯函数/类型，经 index.ts 再导出（非令牌面）。
 */
export const POLICY_BATCH_CONTEXT_PORT = Symbol('POLICY_BATCH_CONTEXT_PORT');
export const POLICY_SERVICE_PORT = Symbol('POLICY_SERVICE_PORT');

/** 008 仓储端口装配令牌（ADR-0015 D1）：policy.module 装配期绑定 Drizzle 实现到 seam。 */
export const POLICY_STORE = Symbol('POLICY_STORE');
