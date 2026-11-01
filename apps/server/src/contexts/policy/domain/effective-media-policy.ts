/**
 * 父子有效策略纯规则模块(010-online-vod T017;ADR-0006 Proposed Decision 2 +
 * ADR-0016 第 3 条「父子有效策略保留 ADR0006 顺序」)。
 *
 * 本文件不依赖任何框架/数据库:输入为服务端目录侧构造的纯值对象(父子媒体事实),
 * 输出为父子逐轴 PolicyDecision。判定顺序逐条复用 policy.rules 的 evaluatePolicy
 * (ADR0006 判定表,顺序固定,首条命中即结束),本文件不重写规则机、不引入新 reason:
 * - 父轴:父事实按旧入口单媒体语义原样判定(type=父 role、channelId=null;vod 父子无频道,
 *   表5 儿童频道白名单不在父子面),与 evaluatePolicy 直接同构
 *   (vod-parent-child-policy.spec「父轴与旧入口同构」用例钉住);
 * - 子轴:每子项与父轴成对判定,父子语义只经两处等价编译进旧入口的输入视图,
 *   判定表本体零改动(表2/3/4/6/7/8/9 逐行仍由 evaluatePolicy 给出):
 *   1) 合成事实:householdEnabled=父且子(表2「父或子任一不可用即不可用」)、
 *      contentLevel=父子有效等级(FR-010「取较严格者,只有一方有等级时继承它」;
 *      继承后按已评级走表6/7,双未评级才触发未评级策略);
 *   2) 策略视图(ADR-0016 Scope「仅增加父子事实/名单匹配目标,旧允许名单优先级不替代」):
 *      父或子任一命中禁止名单 → 子轴视图并入该禁止(表4 禁止优先;
 *      父∈允许名单不能救回被禁子项);父未命中允许名单 → 清空子轴允许视图
 *      (表7 父与子双双命中才覆盖等级上限,单边命中不隐式继承系列允许,
 *      对齐既有 policy-rules.spec「episode 按自身 id 判定」;名单也绝不是必要条件)。
 *
 * 损坏事实(父/子角色非法、等级越界、标识非法、父子自环、子项标识重复)在任何判定前
 * 稳定抛错(含「损坏」可识别语义,与 policy.rules 事实校验同旨),绝不静默放行。
 * profileType 固定按 'child' 走旧入口:profileType 仅作用于表5 儿童频道判定,
 * vod 父子面无频道,对判定结果无差异;与父轴同构用例的对照调用保持一致。
 */

import {
  evaluatePolicy,
  MEDIA_ID_MAX_LENGTH,
  type MediaPolicyFacts,
  type MediaType,
  type PolicyDecision,
  type PolicyJudgment,
} from './policy.rules';

/** vod 父子角色子集(data-model §2:父 movie/series/video、子 episode;频道不在父子面) */
const PARENT_MEDIA_ROLES: ReadonlySet<string> = new Set(['movie', 'series', 'video']);
const CHILD_MEDIA_ROLES: ReadonlySet<string> = new Set(['episode']);

/**
 * 父轴媒体事实。类型面保留完整 MediaType(与旧入口 MediaPolicyFacts.type 同构,
 * 授权入口可直传目录行 type);vod 子集由 assertGroupFactsValid 在运行期收窄,越界即损坏。
 */
export interface ParentMediaFacts {
  mediaId: string;
  role: MediaType;
  /** 0～18 内部年龄阈值;null = 未评级 */
  contentLevel: number | null;
  householdEnabled: boolean;
}

/** 子轴(episode)媒体事实;约束同 ParentMediaFacts(vod 子角色仅 episode) */
export interface ChildMediaFacts {
  mediaId: string;
  role: MediaType;
  /** 0～18 内部年龄阈值;null = 未评级 */
  contentLevel: number | null;
  householdEnabled: boolean;
}

/**
 * 服务端父子事实(T009 输入形态契约:纯值对象,仅可由服务端目录侧构造,客户端不可提供
 * 任何事实;media_id 全局唯一 → 父子自环/子项标识重复均为关系损坏)。
 */
export interface ParentChildMediaFacts {
  householdId: string;
  parent: ParentMediaFacts;
  children: ChildMediaFacts[];
}

/** 父子判定输出:父轴单媒体语义 + 子项按输入顺序逐项对齐 */
export interface ParentChildPolicyDecision {
  parent: PolicyDecision;
  children: PolicyDecision[];
}

function corruptFacts(detail: string): Error {
  return new Error(`父子媒体事实损坏(${detail}),已拒绝判定`);
}

function assertValidMediaId(mediaId: string): void {
  // 标识约束与 policy.rules 一致:1～128 的非空字符串
  if (typeof mediaId !== 'string' || mediaId.length < 1 || mediaId.length > MEDIA_ID_MAX_LENGTH) {
    throw corruptFacts('媒体标识非法');
  }
}

function assertValidContentLevel(contentLevel: number | null): void {
  // 等级约束与 policy.rules 一致:0～18 整数或 null(未评级)
  if (contentLevel !== null && (!Number.isInteger(contentLevel) || contentLevel < 0 || contentLevel > 18)) {
    throw corruptFacts('等级越界(内部等级为 0～18 整数或 null)');
  }
}

/** 结构校验先于任何判定:角色/等级/标识/自环/重复,任一损坏即全组拒绝 */
function assertGroupFactsValid(facts: ParentChildMediaFacts): void {
  assertValidMediaId(facts.parent.mediaId);
  if (!PARENT_MEDIA_ROLES.has(facts.parent.role)) {
    throw corruptFacts(`父角色非法(${String(facts.parent.role)};vod 父为 movie/series/video)`);
  }
  assertValidContentLevel(facts.parent.contentLevel);
  if (!Array.isArray(facts.children)) {
    throw corruptFacts('children 非数组');
  }
  const seenChildIds = new Set<string>();
  for (const child of facts.children) {
    assertValidMediaId(child.mediaId);
    if (!CHILD_MEDIA_ROLES.has(child.role)) {
      throw corruptFacts(`子角色非法(${String(child.role)};vod 子为 episode)`);
    }
    assertValidContentLevel(child.contentLevel);
    if (child.mediaId === facts.parent.mediaId) {
      throw corruptFacts('父子自环(media_id 全局唯一)');
    }
    if (seenChildIds.has(child.mediaId)) {
      throw corruptFacts('子项标识重复(media_id 全局唯一)');
    }
    seenChildIds.add(child.mediaId);
  }
}

/** 父/子事实 → 旧入口 MediaPolicyFacts(vod 父子无频道:channelId 恒为 null) */
function toStaticFacts(householdId: string, item: ParentMediaFacts | ChildMediaFacts): MediaPolicyFacts {
  return {
    householdId,
    mediaId: item.mediaId,
    type: item.role,
    channelId: null,
    contentLevel: item.contentLevel,
    householdEnabled: item.householdEnabled,
  };
}

/** FR-010 父子有效等级:两侧已评级取较严(max,方向无关);仅一方有等级则继承它;双未评级为 null */
function effectiveContentLevel(parent: ParentMediaFacts, child: ChildMediaFacts): number | null {
  if (parent.contentLevel === null) {
    return child.contentLevel;
  }
  if (child.contentLevel === null) {
    return parent.contentLevel;
  }
  return Math.max(parent.contentLevel, child.contentLevel);
}

/**
 * 子轴成对判定的合成事实:mediaId/role 取子项自身(名单/禁止按子项 id 判定),
 * contentLevel=父子有效等级,householdEnabled=父且子(表2「父或子任一不可用」)。
 */
function toChildPairFacts(householdId: string, parent: ParentMediaFacts, child: ChildMediaFacts): MediaPolicyFacts {
  return {
    householdId,
    mediaId: child.mediaId,
    type: child.role,
    channelId: null,
    contentLevel: effectiveContentLevel(parent, child),
    householdEnabled: parent.householdEnabled && child.householdEnabled,
  };
}

/**
 * 表4/表7 名单目标扩展(仅映射进子轴策略视图,判定表本体零改动):
 * - 父或子任一命中禁止名单 → 视图并入子项 id(表4 禁止优先;可用性/策略缺失仍先于禁止,
 *   由 evaluatePolicy 判定顺序天然保证);
 * - 父未命中允许名单 → 清空允许视图(表7 双命中才覆盖等级上限,单边命中不覆盖;
 *   非空名单未命中仍按等级正常放行——名单不是必要白名单)。
 */
function toChildPairPolicyView(policy: PolicyJudgment, parent: ParentMediaFacts, child: ChildMediaFacts): PolicyJudgment {
  const pairBlocked =
    policy.blockedMediaIds.includes(parent.mediaId) || policy.blockedMediaIds.includes(child.mediaId);
  const parentAllowed = policy.allowedMediaIds.includes(parent.mediaId);
  return {
    ...policy,
    blockedMediaIds: pairBlocked ? [...policy.blockedMediaIds, child.mediaId] : policy.blockedMediaIds,
    allowedMediaIds: parentAllowed ? policy.allowedMediaIds : [],
  };
}

/**
 * 纯判定入口(010 FR-010;ADR0006 判定顺序逐条复用,首条命中即结束):
 * 父轴按单媒体语义判定;每个子项与父轴成对判定后按输入顺序对齐输出。
 * 抛错:父子事实损坏(角色/等级/标识/自环/重复)——先于任何判定,绝不静默放行。
 */
export function evaluateEffectiveMediaPolicy(
  policy: PolicyJudgment | null,
  facts: ParentChildMediaFacts,
): ParentChildPolicyDecision {
  assertGroupFactsValid(facts);
  return {
    // 父轴:单媒体语义原样走旧入口(与 evaluatePolicy 同构,静态回归/同构用例钉住)
    parent: evaluatePolicy(policy, 'child', toStaticFacts(facts.householdId, facts.parent)),
    // 子轴:每子项与父轴成对判定,逐项按输入顺序对齐输出
    children: facts.children.map((child) =>
      evaluatePolicy(
        policy === null ? null : toChildPairPolicyView(policy, facts.parent, child),
        'child',
        toChildPairFacts(facts.householdId, facts.parent, child),
      ),
    ),
  };
}
