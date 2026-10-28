/**
 * policy 发布面接口（contracts 白名单：应用服务接口 + 令牌 + 跨上下文类型）。
 * 方法签名与实现逐字一致（仅提取类型；实现对象在 policy.module.ts 以
 * useValue + satisfies 对齐本文件接口）。
 */
import type { SessionContext } from '@platform/http-common/current-session.decorator';
import type { Db } from '@contexts/identity-access';
import type { BatchCatalogContext, BatchCatalogContextInput } from './application/policy.batch-context';
import type {
  AuthorizationReason,
  PolicyDtoBody,
  ReplacePolicyListsInput,
  TrustedResourceReader,
  UpdatePolicyInput,
} from './application/policy.service';

/** policy.batch-context 发布面（消费方：epg / live-tv / media-catalog / personal-data） */
export interface IPolicyBatchContextService {
  loadAvailableMediaIdSet(db: Db, householdId: string): Set<string>;
  loadBatchCatalogContext(db: Db, input: BatchCatalogContextInput): BatchCatalogContext;
}

/** policy.service 发布面（消费方：playback 授权管线 / settings 策略契约路由） */
export interface IPolicyService {
  authorizeCurrentProfile(
    context: SessionContext,
    mediaId: string,
    readTrustedResource: TrustedResourceReader,
  ): Promise<{ allowed: boolean; reason: AuthorizationReason }>;
  getPolicy(profileId: string, context: SessionContext): PolicyDtoBody;
  updatePolicy(profileId: string, context: SessionContext, input: UpdatePolicyInput): Promise<PolicyDtoBody>;
  replacePolicyLists(
    profileId: string,
    context: SessionContext,
    input: ReplacePolicyListsInput,
  ): Promise<PolicyDtoBody>;
}
