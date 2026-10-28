import { and, eq, sql } from 'drizzle-orm';
import { ProblemCode } from '@hmp/shared';
import { device, deviceSession, mediaItem, profile, profilePolicy } from '../../../database/schema';
import { DomainError } from '../../../common/domain-error';
import type { Db } from '../../../modules/auth/db';
import {
  assertPolicyRowInvariant,
  evaluatePolicy,
  parseStoredList,
  type MediaPolicyFacts,
  type MediaType,
  type PolicyJudgment,
  type ProfileType,
} from '@contexts/policy/domain/policy.rules';

/**
 * 批量目录读取上下文(T036;research R7):
 * 列表在单次同步读取(一个同步函数块,better-sqlite3 同步驱动)内装载
 * 有效会话+设备、activeProfile、最新策略与家庭候选媒体集合(含可用性),
 * 并用与详情相同的判定核心 evaluatePolicy(自 policy.rules 导入,不复制规则)输出允许集合,
 * 供 catalog.service 过滤、搜索、title+id 排序、计数与分页;不先分页后过滤。
 *
 * - 授权键以数据库会话行为准:调用方 householdId 仅作交叉校验,伪造/漂移一律拒绝;
 * - 无 activeProfile 或会话/设备/档案失效 → 403 ACTIVE_PROFILE_REQUIRED;
 * - 策略缺失/损坏 → 503 POLICY_UNAVAILABLE(不伪装空列表、不回落默认,FR-003);
 * - 候选集为有界内存判定(10000 条以内),政策语义不进 SQL(R7);T056 实测把可用性
 *   EXISTS 改为去关联等价集合查询(loadAvailableMediaIdSet,join 链不变、无政策语义),
 *   消除 10k 候选 O(n²) 关联扫描;等价性由双跑对比测试钉住。
 */

/** 家庭候选行(内部目录事实;不含播放地址/路径/凭据/upstream 标识) */
export interface CatalogCandidateRow {
  id: string;
  type: MediaType;
  title: string;
  description: string | null;
  contentLevel: number | null;
  version: number;
  /** 家庭级真实可用性(present 条目 + 来源启用 + 播放资源记录有效) */
  available: boolean;
}

export interface BatchCatalogContext {
  householdId: string;
  sessionId: string;
  profileId: string;
  profileType: 'adult' | 'child';
  /** 已通过存量校验的最新策略判定视图(缺失/损坏已在装载时 503) */
  policy: PolicyJudgment;
  /** 家庭全部候选(单次读取装载,含不可用;诊断与复用) */
  candidates: CatalogCandidateRow[];
  /** evaluatePolicy 过滤后的允许集合(与详情同序同判定) */
  allowed: CatalogCandidateRow[];
}

export interface BatchCatalogContextInput {
  /** 期望家庭(来自会话上下文);仅作与会话行的交叉校验 */
  householdId: string;
  sessionId: string;
}

function activeProfileRequired(): DomainError {
  return new DomainError(403, ProblemCode.ACTIVE_PROFILE_REQUIRED, '请先选择当前观看档案');
}

function policyUnavailable(detail: string): DomainError {
  return new DomainError(503, ProblemCode.POLICY_UNAVAILABLE, detail);
}

/** 存量策略行 → 判定视图;损坏(名单非法/不变量破坏)→ 503,与 loadPolicyForRead 同语义 */
function readPolicyJudgment(row: typeof profilePolicy.$inferSelect): PolicyJudgment {
  assertPolicyRowInvariant(row);
  return {
    maxContentLevel: row.maxContentLevel,
    allowUnrated: row.allowUnrated === 1,
    allowedMediaIds: parseStoredList(row.allowedMediaIds, 'allowedMediaIds'),
    blockedMediaIds: parseStoredList(row.blockedMediaIds, 'blockedMediaIds'),
    allowedChannelIds: parseStoredList(row.allowedChannelIds, 'allowedChannelIds'),
  };
}

/** 内部 MediaPolicyFacts 构造:channelId 仅 channel 等于自身;householdEnabled = 真实可用性 */
function toFacts(householdId: string, candidate: CatalogCandidateRow): MediaPolicyFacts {
  return {
    householdId,
    mediaId: candidate.id,
    type: candidate.type,
    channelId: candidate.type === 'channel' ? candidate.id : null,
    contentLevel: candidate.contentLevel,
    householdEnabled: candidate.available,
  };
}

/**
 * 家庭可用媒体标识集合(T056 性能优化;research R7 允许的「无政策语义等价下推」):
 * 与 resource-reader 的 AVAILABLE_EXISTS 同一条「present 条目 × 启用来源 × 播放资源」
 * join 链与同一组谓词,仅把「对每条 media_item 关联求 EXISTS」改为「一次求出可用
 * media_id 集合」。等价性:media_item.id 是主键,故「id ∈ 集合」与「该行逐条关联
 * EXISTS」逐一对应(谓词逐字一致;media_id IS NOT NULL 与 SQL 等值语义本就排除 NULL)。
 *
 * 为何必须改形:source_entry 没有 (household_id, media_id) 索引,关联 EXISTS 的执行计划
 * 只能用 source_entry_identity_key 的 household_id 前缀,即每条 media_item 重扫全家庭
 * source_entry —— 10k 候选实测 O(n²) ≈ 8.1s/请求(SC-005 不达标根因,证据见
 * batch-policy-context.spec 守卫与 S5);集合式单趟扫描 ≈ 9ms。结构根因修复是迁移补
 * 索引,属迁移文件职责;本集合查询在补索引后同样受益,且语义不受执行计划影响。
 *
 * 等价守卫:batch-policy-context.spec 的双跑对比测试把本查询与
 * loadMediaAvailabilityFacts 逐 id 钉死 —— 修改任何一侧 join 链必须同步另一侧,
 * 否则测试失败。本查询不含黑/白名单与等级等政策语义,判定核心仍是 evaluatePolicy,
 * 不构成第二套规则(R7)。
 */
export function loadAvailableMediaIdSet(db: Db, householdId: string): Set<string> {
  const rows = db.all<{ id: string }>(sql`
    SELECT se.media_id AS id
    FROM source_entry se
    INNER JOIN media_source ms ON ms.household_id = se.household_id AND ms.id = se.source_id AND ms.enabled = 1
    INNER JOIN playback_source ps ON ps.household_id = se.household_id AND ps.source_entry_id = se.id AND ps.media_item_id = se.media_id
    WHERE se.household_id = ${householdId}
      AND se.present = 1
      AND se.media_id IS NOT NULL
  `);
  return new Set(rows.map((row) => row.id));
}

/**
 * 批量策略过滤(T056 自 loadBatchCatalogContext 原内联循环原样抽取,判定顺序与
 * 语义不变):逐候选调用与详情相同的唯一判定核心 evaluatePolicy,保持候选原序。
 * 独立导出仅为性能守卫测试复用同一生产路径(10k 内存候选耗时上界回归哨兵)。
 */
export function filterAllowedCandidates(
  policy: PolicyJudgment,
  profileType: ProfileType,
  householdId: string,
  candidates: CatalogCandidateRow[],
): CatalogCandidateRow[] {
  return candidates.filter(
    (candidate) => evaluatePolicy(policy, profileType, toFacts(householdId, candidate)).allowed,
  );
}

export function loadBatchCatalogContext(db: Db, input: BatchCatalogContextInput): BatchCatalogContext {
  const now = Date.now();

  // 1) 会话/设备信任源(重读数据库行,不信任上下文快照;撤销/过期竞态不放行)
  const session = db.select().from(deviceSession).where(eq(deviceSession.id, input.sessionId)).get();
  if (session === undefined || session.revokedAt !== null || !(Date.parse(session.expiresAt) > now)) {
    throw activeProfileRequired();
  }
  if (session.householdId !== input.householdId) {
    throw activeProfileRequired();
  }
  const deviceRow = db.select().from(device).where(eq(device.id, session.deviceId)).get();
  if (deviceRow === undefined || deviceRow.revokedAt !== null) {
    throw activeProfileRequired();
  }

  // 2) 当前观看者:存在、归属会话家庭+账号、可用(否则拒绝,不回落成人策略)
  if (session.activeProfileId === null) {
    throw activeProfileRequired();
  }
  const activeProfile = db.select().from(profile).where(eq(profile.id, session.activeProfileId)).get();
  if (
    activeProfile === undefined ||
    activeProfile.householdId !== session.householdId ||
    activeProfile.accountId !== session.accountId ||
    activeProfile.status !== 'active'
  ) {
    throw activeProfileRequired();
  }

  // 3) 最新策略(每次读取即取最新,修改后下一次请求即生效):缺失/损坏 → 503
  const policyRow = db
    .select()
    .from(profilePolicy)
    .where(and(eq(profilePolicy.householdId, session.householdId), eq(profilePolicy.profileId, activeProfile.id)))
    .get();
  if (policyRow === undefined) {
    throw policyUnavailable('策略缺失,已拒绝访问,请修复数据');
  }
  const policy = readPolicyJudgment(policyRow);

  // 4) 家庭候选集:两条集合查询(候选 + 可用性标识集合)同步装载,无逐条 N+1;
  //    可用性为 resource-reader EXISTS 链的去关联等价形式(见 loadAvailableMediaIdSet)
  const mediaRows = db
    .select({
      id: mediaItem.id,
      type: mediaItem.type,
      title: mediaItem.title,
      description: mediaItem.description,
      contentLevel: mediaItem.contentLevel,
      version: mediaItem.version,
    })
    .from(mediaItem)
    .where(eq(mediaItem.householdId, session.householdId))
    .all();
  const availableIds = loadAvailableMediaIdSet(db, session.householdId);
  const candidates: CatalogCandidateRow[] = mediaRows.map((row) => ({
    id: row.id,
    type: row.type as MediaType,
    title: row.title,
    description: row.description,
    contentLevel: row.contentLevel,
    version: row.version,
    available: availableIds.has(row.id),
  }));

  // 5) 与详情相同的判定核心与顺序:可用性(RESOURCE_UNAVAILABLE)→ 黑名单优先 →
  //    频道白名单(仅 child×channel)→ 未评级按 allowUnrated → 允许名单覆盖等级 → 等级上限
  const profileType = activeProfile.type as 'adult' | 'child';
  const allowed = filterAllowedCandidates(policy, profileType, session.householdId, candidates);

  return {
    householdId: session.householdId,
    sessionId: session.id,
    profileId: activeProfile.id,
    profileType,
    policy,
    candidates,
    allowed,
  };
}
