/**
 * 父子有效策略发布端口(010-online-vod T017;ADR-0015 端口形态,ADR-0016 第 1/3 条)。
 *
 * 纯类型端口:同步 evaluate,输入=服务端父子事实 + 最新策略判定目标,输出=父子逐轴
 * allow/deny+reason(ParentChildPolicyDecision)。语义为领域纯函数
 * evaluateEffectiveMediaPolicy 的提升(发布端口=领域纯函数的提升,
 * 见 vod-parent-child-policy.spec「EffectiveMediaPolicyPort 端口契约」节:
 * 端口面与直接调用领域函数同结果)。
 * 跨所有授权入口复用本端口;不把普通查询强行构造实体(调用方按需构造事实)。
 * application 不接 ORM:本文件零运行时依赖,类型均经 import type 取自本上下文 domain。
 */

import type {
  ParentChildMediaFacts,
  ParentChildPolicyDecision,
} from '@contexts/policy/domain/effective-media-policy';
import type { PolicyJudgment } from '@contexts/policy/domain/policy.rules';

/**
 * 端口输入(与 vod-parent-child-policy.spec 端口契约节同构:字段
 * householdId/profileId/policy/facts)。policy=null=策略缺失/损坏,经领域函数
 * 归一为 POLICY_UNAVAILABLE 默认拒绝,绝不静默放行。
 */
export interface EffectiveMediaPolicyInput {
  householdId: string;
  profileId: string;
  policy: PolicyJudgment | null;
  facts: ParentChildMediaFacts;
}

/** 跨所有授权入口复用的发布端口(同步;纯类型,无 ORM/框架依赖) */
export interface EffectiveMediaPolicyPort {
  evaluate(input: EffectiveMediaPolicyInput): ParentChildPolicyDecision;
}
