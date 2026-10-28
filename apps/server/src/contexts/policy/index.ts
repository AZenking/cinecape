/**
 * policy 发布面（R2：跨上下文 import 的唯一合法落点）。
 * 白名单：应用服务接口 + 注入令牌 + 跨上下文必需类型/纯函数；实现类禁止导出。
 */
export type { IPolicyBatchContextService, IPolicyService } from './policy.ports';
export { POLICY_BATCH_CONTEXT_PORT, POLICY_SERVICE_PORT } from './policy.tokens';

// —— 应用服务纯函数（T020 grep 实测跨上下文消费清单）——
export {
  loadAvailableMediaIdSet,
  loadBatchCatalogContext,
  type BatchCatalogContext,
  type BatchCatalogContextInput,
  type CatalogCandidateRow,
} from './application/policy.batch-context';
export {
  authorizeCurrentProfile,
  getPolicy,
  replacePolicyLists,
  updatePolicy,
  type AuthorizationReason,
  type PolicyDtoBody,
} from './application/policy.service';

// —— 跨上下文必需的领域纯函数/类型再导出（domain/policy.rules）——
export {
  defaultPolicyValues,
  parseStoredList,
  type MediaPolicyFacts,
  type MediaType,
} from './domain/policy.rules';
