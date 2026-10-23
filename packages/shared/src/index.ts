export * from './constants';
export type { paths, components, operations } from './schema';
// 阶段 2 契约类型(独立生成产物 policy-schema.d.ts;001 schema.d.ts 保持不变)
import type { components as policyComponents } from './policy-schema';

/** 002 contracts/openapi.yaml components/schemas/PolicyDto */
export type PolicyDto = policyComponents['schemas']['PolicyDto'];
/** 002 contracts/openapi.yaml components/schemas/PolicyEditable(阶段 2 可编辑配置) */
export type PolicyEditable = policyComponents['schemas']['PolicyEditable'];
/** 002 contracts/openapi.yaml components/schemas/UpdatePolicyRequest */
export type UpdatePolicyRequest = policyComponents['schemas']['UpdatePolicyRequest'];
