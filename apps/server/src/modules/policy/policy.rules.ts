/**
 * ProfilePolicy 纯规则模块(阶段 2,002 spec/ADR-0006)。
 * 本文件不依赖任何框架/数据库:默认值、名单校验/解析均为纯函数,
 * 供 policy.service(存储/编排)与 profile.service(创建时默认策略)共享。
 * 判定核心 evaluatePolicy 见同文件下半部分(US2/T017)。
 */

import { DomainError } from '../../common/domain-error';
import { ProblemCode } from '@hmp/shared';

export type ProfileType = 'adult' | 'child';

/** 每名单去重后至多 1000 个标识(FR-013) */
export const POLICY_LIST_MAX_ITEMS = 1000;
/** 媒体标识:大小写敏感、长度 1～128 的不透明字符串(data-model.md) */
export const MEDIA_ID_MAX_LENGTH = 128;

export interface PolicyListTriple {
  allowedMediaIds: string[];
  blockedMediaIds: string[];
  allowedChannelIds: string[];
}

/**
 * 默认策略(FR-002,维护者 2026-10-23 确认):
 * 成人 maxContentLevel=18、allowUnrated=true;儿童 12、false;三类名单均为空。
 * 默认值仅用于创建与迁移回填,不覆盖已保存策略(FR-008)。
 */
export function defaultPolicyValues(profileType: ProfileType): { maxContentLevel: number; allowUnrated: boolean } {
  return profileType === 'adult'
    ? { maxContentLevel: 18, allowUnrated: true }
    : { maxContentLevel: 12, allowUnrated: false };
}

function isInvalidMediaId(value: unknown): value is string {
  return typeof value !== 'string' || value.length < 1 || value.length > MEDIA_ID_MAX_LENGTH;
}

/**
 * 应用层名单写入校验(FR-013):元素非空、1～128、大小写敏感;去重;排序;
 * 去重后至多 1000 项,超出确定拒绝(400 VALIDATION_FAILED)。
 */
export function normalizeMediaIdList(input: string[]): string[] {
  for (const item of input) {
    if (isInvalidMediaId(item)) {
      throw new DomainError(
        400,
        ProblemCode.VALIDATION_FAILED,
        `名单元素非法:须为 ${1}～${MEDIA_ID_MAX_LENGTH} 个字符的非空字符串`,
      );
    }
  }
  const unique = [...new Set(input)].sort();
  if (unique.length > POLICY_LIST_MAX_ITEMS) {
    throw new DomainError(400, ProblemCode.VALIDATION_FAILED, `名单去重后至多 ${POLICY_LIST_MAX_ITEMS} 项`);
  }
  return unique;
}

/**
 * 存量名单读取校验:JSON 数组且元素全部合法、数量 ≤1000;
 * 任何损坏(非数组 JSON、非字符串元素、超限、等级/版本越界)→ 503 POLICY_UNAVAILABLE,
 * 绝不静默当作空数组或默认值(默认拒绝,FR-003)。
 */
export function parseStoredList(stored: string, field: string): string[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stored);
  } catch {
    throw policyCorrupt(field);
  }
  if (!Array.isArray(parsed) || parsed.some((item) => isInvalidMediaId(item)) || parsed.length > POLICY_LIST_MAX_ITEMS) {
    throw policyCorrupt(field);
  }
  return parsed as string[];
}

/** 校验单行策略的数值不变量;违反即损坏(防御性,写路径已有 DB CHECK) */
export function assertPolicyRowInvariant(row: {
  maxContentLevel: number;
  allowUnrated: number;
  version: number;
}): void {
  if (
    !Number.isInteger(row.maxContentLevel) ||
    row.maxContentLevel < 0 ||
    row.maxContentLevel > 18 ||
    (row.allowUnrated !== 0 && row.allowUnrated !== 1) ||
    !Number.isInteger(row.version) ||
    row.version < 1
  ) {
    throw policyCorrupt('数值不变量');
  }
}

function policyCorrupt(field: string): DomainError {
  return new DomainError(503, ProblemCode.POLICY_UNAVAILABLE, `策略损坏(${field}),已拒绝访问,请修复数据`);
}

// ---------------------------------------------------------------------------
// 判定核心(US2/T017):纯函数,按 spec「策略判定表」逐行实现
// ---------------------------------------------------------------------------

export type MediaType = 'channel' | 'movie' | 'series' | 'episode' | 'video';

/**
 * 受信任媒体事实(data-model「内部 MediaPolicyFacts 契约」):仅可由服务端目录适配器构造。
 * 未知外部分级在适配器中显式映射为 null(未评级); householdEnabled 表示家庭级可用性。
 */
export interface MediaPolicyFacts {
  householdId: string;
  mediaId: string;
  type: MediaType;
  /** 仅 type=channel 时等于 mediaId;其余类型必须为 null */
  channelId: string | null;
  /** 0～18 内部年龄阈值;null = 未评级 */
  contentLevel: number | null;
  householdEnabled: boolean;
}

/** 判定输入的策略视图(PolicyDto 的判定相关字段;null = 策略缺失/损坏) */
export interface PolicyJudgment {
  maxContentLevel: number;
  allowUnrated: boolean;
  allowedMediaIds: string[];
  blockedMediaIds: string[];
  allowedChannelIds: string[];
}

export type PolicyDecisionReason =
  | 'RESOURCE_UNAVAILABLE'
  | 'POLICY_UNAVAILABLE'
  | 'MEDIA_BLOCKED'
  | 'CHANNEL_NOT_ALLOWED'
  | 'UNRATED_DENIED'
  | 'UNRATED_ALLOWED'
  | 'MEDIA_ALLOWED'
  | 'LEVEL_ALLOWED'
  | 'LEVEL_EXCEEDED';

export interface PolicyDecision {
  allowed: boolean;
  reason: PolicyDecisionReason;
}

const MEDIA_TYPES: ReadonlySet<string> = new Set(['channel', 'movie', 'series', 'episode', 'video']);

/** 事实损坏(类型无效/等级越界/标识非法/channelId 不一致)→ 抛错拒绝,绝不静默放行 */
function assertFactsValid(facts: MediaPolicyFacts): void {
  if (
    !MEDIA_TYPES.has(facts.type) ||
    typeof facts.mediaId !== 'string' ||
    facts.mediaId.length < 1 ||
    facts.mediaId.length > MEDIA_ID_MAX_LENGTH ||
    (facts.contentLevel !== null &&
      (!Number.isInteger(facts.contentLevel) || facts.contentLevel < 0 || facts.contentLevel > 18)) ||
    (facts.type === 'channel' ? facts.channelId !== facts.mediaId : facts.channelId !== null)
  ) {
    throw new Error('媒体事实损坏(类型/等级/标识/channelId 不一致),已拒绝判定');
  }
}

/**
 * 纯判定核心(spec 策略判定表,顺序固定,第一条命中即结束):
 * 2. 资源家庭禁用 → 拒绝 RESOURCE_UNAVAILABLE(不存在/跨家庭由授权入口归一);
 * 3. 策略缺失/损坏(null)→ 拒绝 POLICY_UNAVAILABLE;
 * 4. 禁止名单 → 拒绝 MEDIA_BLOCKED(允许∩禁止时禁止优先);
 * 5. 儿童观看频道且频道不在允许名单 → 拒绝 CHANNEL_NOT_ALLOWED(空名单=全部不可访问;成人豁免);
 * 6. 未评级 → 仅按 allowUnrated(允许名单不覆盖;允许时 reason=UNRATED_ALLOWED);
 * 7. 已评级且在允许名单 → 允许 MEDIA_ALLOWED(仅覆盖普通等级上限,不覆盖 5/6);
 * 8. 已评级且等级 ≤ 最高等级 → 允许 LEVEL_ALLOWED;
 * 9. 其他 → 拒绝 LEVEL_EXCEEDED。
 * 账号角色/档案类型的"成人"身份不产生 4/6/8 之外的豁免(FR-005)。
 */
export function evaluatePolicy(
  policy: PolicyJudgment | null,
  profileType: ProfileType,
  facts: MediaPolicyFacts,
): PolicyDecision {
  assertFactsValid(facts);

  // 表2:家庭级可用性
  if (!facts.householdEnabled) {
    return { allowed: false, reason: 'RESOURCE_UNAVAILABLE' };
  }
  // 表3:策略缺失/损坏(授权入口将损坏行归一为 null)
  if (policy === null) {
    return { allowed: false, reason: 'POLICY_UNAVAILABLE' };
  }

  const mediaId = facts.mediaId;
  // 表4:禁止优先
  if (policy.blockedMediaIds.includes(mediaId)) {
    return { allowed: false, reason: 'MEDIA_BLOCKED' };
  }
  // 表5:儿童频道允许名单为必要条件
  if (profileType === 'child' && facts.type === 'channel' && !policy.allowedChannelIds.includes(mediaId)) {
    return { allowed: false, reason: 'CHANNEL_NOT_ALLOWED' };
  }
  // 表6:未评级仅按 allowUnrated(允许名单不覆盖)
  if (facts.contentLevel === null) {
    return policy.allowUnrated
      ? { allowed: true, reason: 'UNRATED_ALLOWED' }
      : { allowed: false, reason: 'UNRATED_DENIED' };
  }
  // 表7:允许名单覆盖普通等级上限(仅已评级)
  if (policy.allowedMediaIds.includes(mediaId)) {
    return { allowed: true, reason: 'MEDIA_ALLOWED' };
  }
  // 表8/表9:等级上限
  return facts.contentLevel <= policy.maxContentLevel
    ? { allowed: true, reason: 'LEVEL_ALLOWED' }
    : { allowed: false, reason: 'LEVEL_EXCEEDED' };
}
