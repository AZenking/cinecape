/**
 * 010-online-vod T029:MaterializeWorkSet 应用用例(纯函数模块 + 依赖注入端口函数束)。
 *
 * 契约来源(逐字对照,实现顺序即本文件编排顺序):
 * - contracts/api.md §3 物化幂等段:先查成功重放 → 再要求预览有效 → 同 key 异摘要
 *   409 IDEMPOTENCY_CONFLICT → 新操作预览变化 409 VOD_DETAIL_CHANGED → 过期
 *   410 VOD_PREVIEW_EXPIRED → 满额 409 VOD_QUOTA_EXCEEDED → 旧结果目标内容/连续性
 *   变化 409 VOD_MATERIALIZATION_STALE;幂等 scope=家庭/DeviceSession/contextVersion;
 *   目标 24h 受回收保护;当前权限失效拒绝而非仍返成功;
 * - contracts/internal-ports.md §2 MaterializeWorkSet 步骤顺序:幂等已提交恢复 →
 *   重验上下文 → 预分配稳定身份/人工元数据 → 目标策略 → 预览/配置/详情 CAS →
 *   净配额 → 完整映射/资源 → 幂等结果 → 公共 revision(仅公开变化);
 *   「已有ID复用先查映射;首次ID只内存预分配,不能为了策略先提交占位资源」;
 * - api.md §7 I1 / data-model §10 I1:候选分支先验证绑定与目标策略,再复用
 *   MaterializeWorkSet;registeredCandidateRef 与 operation 结果同事务提交,
 *   至少 24h 保护,重放可恢复原结果;新 key 不得使用过期原候选;
 * - data-model §4:固定 24h 保留、重放不延长;新 key 复用已有映射不要求新媒体配额;
 *   净配额(10 源/5000 父/100000 子)事务内按新增净额检查,并发不能突破。
 *
 * 事务编排(全部写一个 commit;网络/HTML/预览缓存一律不在事务内):
 * - 工作集经 UNIT_OF_WORK.run 同步组装(txStores 键 identityAccess/profile/policy/
 *   sources/catalog/vod;playback/personalData 本用例不消费),任何参与者方法抛错
 *   即整体回滚(T008/T016 契约);
 * - 步骤名与 T024 故障注入点(FIXTURE_MATERIALIZE_STEP_NAMES)对齐,见各步骤注释;
 * - 预分配 ID 只内存,直到策略/CAS/配额全部通过才随映射/资源同事务落库;
 * - 公共 revision 经 publication.service 判定,与资源/幂等结果/登记候选同事务提交。
 *
 * 与 T028/T031 的接口接点(装配桥接归 T031,本服务不 import 其文件):
 * - 解析输入:调用方经 T028 预览缓存把 titleRef/episodeRef 或 candidateRef 解析为
 *   ResolvedMaterializationTarget(经 MaterializeTargetResolver 注入,事务外调用);
 *   解析不可达(伪造/跨家庭 ref)由 resolver 抛 DomainError(404/410),本服务在事务内
 *   以 store 事实(previewRevision/locatorRevision/详情快照/修订指针)做权威 CAS;
 * - 非事务幂等预查:deps.findCommittedOperation 接 T027 OnlineVodStore
 *   (ONLINE_VOD_STORE 令牌装配),命中即跳过解析(「成功重放优先于预览 TTL」,不触碰
 *   可能已过期的预览缓存);事务内仍以 MaterializationOperationStore 权威复读;
 * - 策略端口:deps.effectiveMediaPolicy 接 T017 EffectiveMediaPolicyPort
 *   (组合根注入归 T031;本服务只构造服务端父子事实并消费判定结果);
 * - 目录修订读数:deps.readCatalogRevision 供 operation 行记录「提交时 revision」
 *   (无行视为初版 1;T031/T030 自 media-catalog 侧接事务内同连接读数);
 * - 运行配置:deps.quotas 接 vod-config loadVodRuntimeConfig 的 catalog 净配额
 *   (VOD_MAX_PARENT_TITLES / VOD_MAX_CHILD_EPISODES,env 只允许收紧)。
 *
 * T055 接线点(map/commit 步骤内,本事务):writeMappingsAndResources 在父/线/子项
 * 映射落库后、详情快照同事务调用 episode-sequence.service.publishSequence 发布独立
 * 导航序列——sequenceRevision 递增语义(仅成员/顺序/年季/常规集资格变化时 +1,与
 * detailRevision 一同发布,重复发布不虚增)与行状态推导(ordered/ambiguous/special)
 * 全部在该服务/规则层;本文件只做事实编排,不自行判类。
 */
import { createHash, randomUUID } from 'node:crypto';
import { DomainError } from '@platform/http-common/domain-error';
import { ProblemCode } from '@hmp/shared';
import { parseStoredList } from '@contexts/policy';
import type {
  EffectiveMediaPolicyPort,
  ParentChildMediaFacts,
} from '@contexts/policy';
import type {
  CatalogMediaRow,
  CatalogParticipant,
  IdentitySnapshotReader,
  MaterializationOperationRow,
  MaterializationOperationStore,
  MaterializeCommand,
  MaterializeOutcome,
  PolicyReader,
  PolicyRow,
  ProfileReader,
  QuotaStore,
  RegisteredCandidateParticipant,
  SourceEntryParticipant,
  SourceReader,
  VodEpisodeRow,
  VodLineRow,
  VodParticipant,
  VodTitleRow,
} from './publication-work-set.port';
import type { OnlineVodStore } from './online-vod-store.port';
import {
  publishSequence,
  type PublishSequenceOutcome,
  type SequencePublicationStore,
} from './episode-sequence.service';
import {
  MATERIALIZATION_RETENTION_MS,
  describePublicationChange,
  mintOpaqueRef,
  publishDerivedPresentation,
} from './publication.service';

/* ------------------------- 事务面结构镜像(不深导 platform/database,R1b) ------------------------- */

/**
 * vod 事务参与者全量面:T015 事务端口(稳定映射/详情/序列 + 幂等 + 净配额 + 登记候选)
 * 与 OnlineVodStore 读面(按父媒体/子媒体反查、线路/子项列表)的结构合并,外加 T055
 * 导航序列发布面(SequencePublicationStore:最新快照读/行级幂等守卫/序列行写入)。
 * 运行时对象即 T016/T027 的 createOnlineVodTxParticipants(binding) 返回值
 * (DrizzleOnlineVodTxParticipants 继承 OnlineVodReadStatements,同时具备全部三组面),
 * T031 工作集装配直传即可。
 */
export type MaterializeVodTx = VodParticipant &
  MaterializationOperationStore &
  QuotaStore &
  RegisteredCandidateParticipant &
  OnlineVodStore &
  SequencePublicationStore;

/**
 * MaterializeWorkSet 消费的绑定后 txStores(键名与组合根 8 键注册表一致,按需取用)。
 * 010 恢复:用 type alias(而非 interface)承载 —— 对象字面量别名具备隐式索引签名,
 * 与平台 UnitOfWork<TxStoresRegistry> 的 BoundTxStores(索引签名面)可做结构相容比较,
 * 装配面 UnitOfWork → MaterializeUnitOfWork 的编译期结构校验因此成立(无需断言桥接)。
 */
export type MaterializeTxBoundStores = {
  readonly credential: { readonly transactionId: string; readonly behavior: 'immediate' };
  readonly identityAccess: IdentitySnapshotReader;
  readonly profile: ProfileReader;
  readonly policy: PolicyReader;
  readonly sources: SourceReader & SourceEntryParticipant;
  readonly catalog: CatalogParticipant;
  readonly vod: MaterializeVodTx;
};

/**
 * 平台 UnitOfWork.run 的结构镜像(R1b:application 不深导 platform/database;
 * T031 以 UNIT_OF_WORK 令牌注入 createUnitOfWork 产物,结构相容由编译期保证):
 * run 全同步,callback 同步签名,失败整体回滚(T008/T016 契约)。
 * 010 恢复:返回面用 SyncResult 同形态镜像(thenable 压 never)——与平台返回类型
 * 逐字相同,使 UnitOfWork<具体注册表> → MaterializeUnitOfWork 的赋值双向成立。
 */
export type MaterializeSyncResult<T> = [T] extends [PromiseLike<unknown>] ? never : T;

export interface MaterializeUnitOfWork {
  run<TWorkSet, TResult>(
    workSetFactory: (txStores: MaterializeTxBoundStores) => TWorkSet,
    callback: (workSet: TWorkSet) => TResult,
    options: { readonly behavior: 'immediate'; readonly busyBudgetMs?: number },
  ): MaterializeSyncResult<TResult>;
}

/* ------------------------ 解析输入(事务外事实,由调用方/装配层提供) ------------------------ */

/** 单集解析事实(来自 T028 预览缓存/上游详情;服务端事实,浏览器不可提供) */
export interface ResolvedEpisodeFacts {
  readonly episodeKey: string;
  readonly label: string;
  readonly ordinal: number;
  readonly seasonKey: string | null;
  readonly sequenceRevision: number;
  readonly sequenceStatus: 'ordered' | 'ambiguous' | 'special';
  /** 0～18 内部等级或 null(未评级);策略判定输入 */
  readonly contentLevel: number | null;
  readonly contentVersionState: 'unverified' | 'verified';
  readonly evidenceKind: string | null;
  readonly evidenceDigest: string | null;
  readonly schemaVersion: string | null;
  readonly continuityRevision: number | null;
  readonly continuitySignature: string | null;
}

/** 单线解析事实 */
export interface ResolvedLineFacts {
  readonly lineKey: string;
  readonly displayName: string;
  readonly sortOrder: number;
  readonly episodes: readonly ResolvedEpisodeFacts[];
}

/** 整片详情解析事实(私有载荷只入库不进公共 DTO) */
export interface ResolvedDetailFacts {
  readonly detailRevision: number;
  readonly locatorRevision: number;
  readonly title: string;
  readonly description: string | null;
  readonly parentContentLevel: number | null;
  readonly payloadDigest: string;
  readonly validatedPrivatePayload: string;
  readonly fetchedAt: string;
  readonly expiresAt: string;
  readonly lines: readonly ResolvedLineFacts[];
}

/** 候选分支溯源(api §7 I1:ref 服务端记录绑定,登记映射所需事实) */
export interface CandidateProvenance {
  readonly sourceSessionId: string;
  readonly sourceGeneration: number;
}

/**
 * 解析后的物化目标:稳定分支由 titleRef/episodeRef 解析,候选分支由 candidateRef 解析;
 * lineKey/episodeKey 为解析产物,服务端不信任浏览器推导的上游键。
 */
export interface ResolvedMaterializationTarget {
  readonly sourceId: string;
  readonly upstreamVodId: string;
  readonly lineKey: string;
  readonly episodeKey: string;
  /** 预览快照修订(必须与命令 previewRevision 一致,失配 409 VOD_DETAIL_CHANGED) */
  readonly previewRevision: number;
  /** 预览缓存 TTL(新目标 410 判定基准;已有目标以 store 详情快照 expires_at 为权威) */
  readonly previewExpiresAt: string;
  readonly detail: ResolvedDetailFacts;
  /** 候选分支必填(resolver 契约,缺失为装配错误) */
  readonly candidate?: CandidateProvenance;
}

/** 解析钩子(事务外调用;网络/预览缓存读在这里,失败以 DomainError 404/410/409 表达) */
export type MaterializeTargetResolver = (
  command: MaterializeCommand,
  context: MaterializationContext,
) => Promise<ResolvedMaterializationTarget>;

/* ---------------------------------------- 上下文与依赖束 ---------------------------------------- */

/** 调用方上下文(Session 守卫推导;幂等 scope=家庭/DeviceSession/contextVersion) */
export interface MaterializationContext {
  readonly householdId: string;
  readonly deviceSessionId: string;
  readonly profileId: string;
  readonly profileContextVersion: number;
}

/** 物化净配额(接 vod-config loadVodRuntimeConfig;契约值 5000 父/100000 子,env 只可收紧) */
export interface MaterializationQuotas {
  readonly maxParentTitles: number;
  readonly maxChildEpisodes: number;
}

/** 依赖注入端口函数束(T031 组合根装配;测试以真实参与者 + FakeClock 装配) */
export interface MaterializationServiceDeps {
  readonly uow: MaterializeUnitOfWork;
  /** T017 有效媒体策略端口(父子事实构造在本服务,判定顺序保留在 policy 上下文) */
  readonly effectiveMediaPolicy: EffectiveMediaPolicyPort;
  readonly quotas: MaterializationQuotas;
  /** catalog_state.revision 读数(无行视为初版 1;T031/T030 接事务内同连接读) */
  readonly readCatalogRevision: (householdId: string) => number;
  /** 非事务幂等预查(接 T027 OnlineVodStore seam;只认 committed_at 非空) */
  readonly findCommittedOperation: (
    householdId: string,
    deviceSessionId: string,
    profileContextVersion: number,
    operationKey: string,
  ) => MaterializationOperationRow | undefined;
  /** 时钟(UTC ISO-8601;测试注入 FakeClock,生产注入系统时钟) */
  readonly nowIso: () => string;
  /** ID 工厂(缺省 randomUUID;测试可注入确定性工厂) */
  readonly generateId?: () => string;
}

/* ------------------------------------------ 服务入口 ------------------------------------------ */

/**
 * MaterializeWorkSet(api §3 POST /vod/materializations 应用用例)。
 *
 * 编排:
 * 1. 事务外先查成功重放(T027 非事务读):命中即跳过解析(不触碰预览缓存/网络);
 * 2. 事务外解析目标事实(resolver;网络/预览缓存一律不在事务内);
 * 3. UNIT_OF_WORK.run 同步单事务:幂等已提交恢复 → 重验上下文 → 稳定 ID 查找或
 *    预分配 → 目标策略 → 配置/详情 CAS → 净配额 → 整片映射/资源 → 幂等结果 →
 *    公共 revision(仅公开变化;候选分支同事务登记 registeredCandidateRef);
 * 4. 返回 Materialized(api §1;revision 为提交时值)。
 */
export async function materialize(
  deps: MaterializationServiceDeps,
  command: MaterializeCommand,
  context: MaterializationContext,
  resolveTarget: MaterializeTargetResolver,
): Promise<MaterializeOutcome> {
  const requestDigest = digestMaterializeCommand(command);

  // ── Phase 0(事务外):先查成功重放(api §3 顺序第一)。命中即不解析预览——
  // 「成功重放优先于预览 TTL」:过期预览缓存不得阻断已提交结果恢复(A5/D1 重放)。
  const committedBeforeTx = deps.findCommittedOperation(
    context.householdId,
    context.deviceSessionId,
    context.profileContextVersion,
    command.operationKey,
  );
  // ── Phase 1(事务外):解析预览事实(T028 预览缓存/上游;resolver 契约见类型注释)。
  const resolved =
    committedBeforeTx === undefined ? await resolveTarget(command, context) : null;

  // ── Phase 2(事务内):单事务编排;任何参与者抛错即整体回滚。
  return deps.uow.run(
    (tx) => assembleWorkSet(tx),
    (ws) => runMaterializeWorkSet(deps, ws, command, context, requestDigest, resolved),
    { behavior: 'immediate' },
  );
}

/** 命令摘要(同 key 异载荷判 409 的依据;不含 operationKey 本身/不含上游地址) */
export function digestMaterializeCommand(command: MaterializeCommand): string {
  const canonical =
    command.kind === 'stableRef'
      ? `stableRef\u0000${command.titleRef}\u0000${command.episodeRef}\u0000${command.previewRevision}`
      : `candidateRef\u0000${command.candidateRef}\u0000${command.previewRevision}`;
  return createHash('sha256').update(canonical).digest('hex');
}

/* ------------------------------ 工作集组装(同步,事务内) ------------------------------ */

/** 服务内工作集视图(成员全部来自同一连接绑定的各所有者参与者) */
interface MaterializeWorkSetView {
  readonly identity: IdentitySnapshotReader;
  readonly profileReader: ProfileReader;
  readonly policy: PolicyReader;
  readonly source: SourceReader;
  readonly sourceEntry: SourceEntryParticipant;
  readonly catalog: CatalogParticipant;
  readonly vod: MaterializeVodTx;
}

function assembleWorkSet(tx: MaterializeTxBoundStores): MaterializeWorkSetView {
  return {
    identity: tx.identityAccess,
    profileReader: tx.profile,
    policy: tx.policy,
    source: tx.sources,
    sourceEntry: tx.sources,
    catalog: tx.catalog,
    vod: tx.vod,
  };
}

/* ------------------------------------------ 事务内编排(全同步) ------------------------------------------ */

/** 映射计划(allocate 阶段构建:已有 ID 复用先查映射,首次 ID 只内存预分配) */
interface EpisodeMappingPlan {
  readonly resolved: ResolvedEpisodeFacts;
  /** vod_episode 行 id(已有=复用;首次=内存预分配) */
  readonly episodeRowId: string;
  /** 子媒体 id(已有=复用映射;首次=内存预分配) */
  readonly mediaId: string;
  readonly isNew: boolean;
  readonly existing: VodEpisodeRow | undefined;
}

interface LineMappingPlan {
  readonly resolved: ResolvedLineFacts;
  readonly lineId: string;
  readonly isNew: boolean;
  readonly episodes: EpisodeMappingPlan[];
}

interface TitleMappingPlan {
  readonly parentMediaId: string;
  readonly parentIsNew: boolean;
  readonly titleId: string;
  readonly parentType: 'movie' | 'series' | 'video';
  readonly lines: LineMappingPlan[];
  readonly selected: EpisodeMappingPlan;
  /** 已有父行(复用路径;派生展示/策略事实/内容修订来源) */
  readonly existingParentRow: CatalogMediaRow | undefined;
  /** 已有选中子媒体行(复用路径;contentRevision 事实) */
  readonly existingSelectedRow: CatalogMediaRow | undefined;
  /** 已有稳定映射(复用路径) */
  readonly existingTitle: VodTitleRow | undefined;
}

function runMaterializeWorkSet(
  deps: MaterializationServiceDeps,
  ws: MaterializeWorkSetView,
  command: MaterializeCommand,
  context: MaterializationContext,
  requestDigest: string,
  resolved: ResolvedMaterializationTarget | null,
): MaterializeOutcome {
  const householdId = context.householdId;
  const nowIso = deps.nowIso();
  const nowMs = Date.parse(nowIso);
  const newId = deps.generateId ?? randomUUID;

  // ── 步骤 1 materialize:idempotent-replay(幂等已提交恢复;owner=vod)──
  // 只认 committed_at 非空的成功结果(T027);同 key 异摘要 409(结果固定不刷新)。
  const committed = ws.vod.findCommittedOperation(
    householdId,
    context.deviceSessionId,
    context.profileContextVersion,
    command.operationKey,
  );
  if (committed !== undefined) {
    if (committed.requestDigest !== requestDigest) {
      throw new DomainError(409, ProblemCode.IDEMPOTENCY_CONFLICT);
    }
    return replayCommittedResult(deps, ws, context, committed, nowMs);
  }
  if (resolved === null) {
    // 事务外预查命中而事务内无行(行恰被回收的极端竞态):按内部错误拒绝,
    // 不静默当新操作(结果固定语义优先;客户端重试即新操作)。
    throw new DomainError(500, ProblemCode.INTERNAL, '幂等结果恢复失败,请重试');
  }
  if (command.kind === 'candidateRef' && resolved.candidate === undefined) {
    // resolver 契约:候选分支必须携带服务端绑定溯源(装配错误,非用户错误)。
    throw new DomainError(500, ProblemCode.INTERNAL, '候选解析事实缺失,请重新获取候选');
  }

  // ── 步骤 2 materialize:revalidate-context(重验上下文;owner=identityAccess)──
  // 「已授权不能替代事务内重验」:撤销/过期/档案漂移拒绝而非仍返成功。
  assertSessionContextValid(ws, context, nowMs);

  // ── 步骤 3 materialize:allocate-identity(稳定 ID 查找或预分配;owner=catalog)──
  // 已有 ID 复用先查映射;首次 ID 只内存预分配(策略拒绝不留任何痕迹);
  // 预分配 ID 落库前经 catalog 存在性防撞(同时即 catalog 参与者首个触达点)。
  const plan = planTitleMapping(ws, context, resolved, newId);

  // ── 步骤 4 materialize:verify-policy(目标策略;owner=policy)──
  // 父+选中子按 ADR-0006 顺序判定(T017 端口);拒绝 404 且零落库
  // (其他分集登记不代表当前 Profile 获其播放权限,故仅判定父子目标轴)。
  assertTargetPolicyAllows(deps, ws, context, buildTargetPolicyFacts(ws, context, resolved, plan));

  // ── 步骤 5 materialize:cas-detail(预览/配置/详情 CAS;owner=vod,来源面=sources)──
  assertConfigurationAndDetailCas(ws, context, command, resolved, plan, nowMs);

  // ── 步骤 6 materialize:check-quota(净配额;owner=vod)──
  // 事务内按「新增净额」检查:复用已有映射不占新配额;BEGIN IMMEDIATE 期间
  // 计数与写入同锁,并发不能突破(B1 契约)。
  assertNetQuota(deps, ws, householdId, plan);

  // ── 步骤 7 materialize:map-resource(完整映射/资源;owner=sources)──
  const mapped = writeMappingsAndResources(ws, context, resolved, plan, nowIso, newId);

  // ── 步骤 8 materialize:record-operation(幂等结果;owner=vod)+ §5 候选登记 ──
  // 公共 revision 判定(仅公开变化)→ 记录「提交时 revision」的幂等结果 →
  // 候选分支同事务登记 registeredCandidateRef(api §7 I1)。
  const change = describePublicationChange({
    replayed: false,
    firstPublication: plan.parentIsNew,
    derivedPresentationChanged: mapped.derivedPresentationChanged,
    newLines: mapped.newLines,
    newEpisodes: mapped.newEpisodes,
    newSequences: mapped.newSequences,
    detailSnapshotPublished: mapped.detailSnapshotPublished,
  });
  const currentRevision = deps.readCatalogRevision(householdId);
  const catalogRevision = change.bumpCatalogRevision ? currentRevision + 1 : currentRevision;
  const selectedContentRevision = plan.selected.isNew
    ? 1
    : (plan.existingSelectedRow?.contentRevision ?? 1);
  const selectedContinuityRevision = plan.selected.isNew
    ? (plan.selected.resolved.continuityRevision ?? 1)
    : (plan.selected.existing?.continuityRevision ?? 1);
  const registeredCandidateRef =
    command.kind === 'candidateRef' ? mintOpaqueRef('vod-reg', newId) : null;
  const outcome: MaterializeOutcome = {
    parentMediaId: plan.parentMediaId,
    mediaId: plan.selected.mediaId,
    detailRevision: resolved.detail.detailRevision,
    catalogRevision,
    replayed: false,
    candidateRef: command.kind === 'candidateRef' ? command.candidateRef : null,
    registeredCandidateRef,
  };
  const operationId = newId();
  ws.vod.recordCommittedOperation({
    id: operationId,
    householdId,
    deviceSessionId: context.deviceSessionId,
    profileId: context.profileId,
    profileContextVersion: context.profileContextVersion,
    operationKey: command.operationKey,
    requestDigest,
    parentMediaId: plan.parentMediaId,
    selectedMediaId: plan.selected.mediaId,
    selectedContentRevision,
    selectedContinuityRevision,
    detailRevision: resolved.detail.detailRevision,
    catalogRevision,
    result: JSON.stringify(outcome),
    committedAt: nowIso,
    // 固定 24h 保留(data-model §4):从提交时刻起算,重放绝不延长。
    expiresAt: new Date(nowMs + MATERIALIZATION_RETENTION_MS).toISOString(),
  });
  if (command.kind === 'candidateRef' && resolved.candidate !== undefined) {
    ws.vod.registerCandidateMapping({
      id: newId(),
      householdId,
      deviceSessionId: context.deviceSessionId,
      profileId: context.profileId,
      profileContextVersion: context.profileContextVersion,
      registeredCandidateRef: registeredCandidateRef ?? '',
      candidateRef: command.candidateRef,
      sourceSessionId: resolved.candidate.sourceSessionId,
      sourceGeneration: resolved.candidate.sourceGeneration,
      previewRevision: command.previewRevision,
      targetMediaId: plan.selected.mediaId,
      targetContentRevision: selectedContentRevision,
      targetContinuityRevision: selectedContinuityRevision,
      targetDetailRevision: resolved.detail.detailRevision,
      materializationOperationId: operationId,
      createdAt: nowIso,
      // 登记映射与 operation 同保护期(至少 24h,data-model §10 I1)。
      expiresAt: new Date(nowMs + MATERIALIZATION_RETENTION_MS).toISOString(),
    });
  }

  // ── 步骤 9 materialize:bump-revision(公共 revision 仅公开变化;owner=catalog)──
  // 无变化重放/复用不加(与资源/幂等结果/登记候选同一 commit,重放不虚增)。
  if (change.bumpCatalogRevision) {
    ws.catalog.bumpPublicCatalogRevision(householdId);
  }
  // 步骤 10 materialize:commit = run 边界 COMMIT(平台职责;任何前序失败已整体回滚)。
  return outcome;
}

/* ------------------------------------------ 幂等重放(已提交结果恢复) ------------------------------------------ */

/**
 * 已提交重放:原结果原样返回(replayed=true;不重算/不刷新网络/不延长 24h),
 * 但仍按契约重验当前上下文/策略/资源(A8:目标内容/连续性变化 → 409 STALE;
 * 权限失效 → 拒绝而非仍返成功)。预览 TTL 不参与(已提交重放优先于预览 TTL)。
 */
function replayCommittedResult(
  deps: MaterializationServiceDeps,
  ws: MaterializeWorkSetView,
  context: MaterializationContext,
  committed: MaterializationOperationRow,
  nowMs: number,
): MaterializeOutcome {
  assertSessionContextValid(ws, context, nowMs);
  const parentRow = ws.catalog.findCatalogMedia(context.householdId, committed.parentMediaId);
  const selectedRow = ws.catalog.findCatalogMedia(context.householdId, committed.selectedMediaId);
  const episodeRow = ws.vod.findEpisodeByMedia(context.householdId, committed.selectedMediaId);
  if (parentRow === undefined || selectedRow === undefined || episodeRow === undefined) {
    // 目标组已不可见(回收/清理后):旧结果目标变化,拒绝重放(409 同形,不泄露存在性)。
    throw new DomainError(409, ProblemCode.VOD_MATERIALIZATION_STALE);
  }
  assertTargetPolicyAllows(deps, ws, context, factsFromCatalogRows(context, parentRow, selectedRow));
  if (
    selectedRow.contentRevision !== committed.selectedContentRevision ||
    (episodeRow.continuityRevision ?? 1) !== committed.selectedContinuityRevision
  ) {
    throw new DomainError(409, ProblemCode.VOD_MATERIALIZATION_STALE);
  }
  let stored: MaterializeOutcome;
  try {
    stored = JSON.parse(committed.result) as MaterializeOutcome;
  } catch {
    throw new DomainError(500, ProblemCode.INTERNAL, '幂等结果损坏,请重新物化');
  }
  if (
    typeof stored.parentMediaId !== 'string' ||
    typeof stored.mediaId !== 'string' ||
    typeof stored.detailRevision !== 'number'
  ) {
    throw new DomainError(500, ProblemCode.INTERNAL, '幂等结果损坏,请重新物化');
  }
  return { ...stored, replayed: true };
}

/* ------------------------------------------ 上下文/策略/事实 ------------------------------------------ */

/** 事务内身份/档案重验:缺失/撤销/过期 401;档案漂移 403;跨家庭/不存在 404 同形 */
function assertSessionContextValid(
  ws: MaterializeWorkSetView,
  context: MaterializationContext,
  nowMs: number,
): void {
  const identity = ws.identity.findDeviceContext(context.deviceSessionId);
  if (identity === undefined || identity.revokedAt !== null || Date.parse(identity.expiresAt) <= nowMs) {
    throw new DomainError(401, ProblemCode.SESSION_INVALID);
  }
  if (identity.profileId !== context.profileId || identity.profileContextVersion !== context.profileContextVersion) {
    throw new DomainError(403, ProblemCode.ACTIVE_PROFILE_REQUIRED);
  }
  const profile = ws.profileReader.findProfile(context.householdId, context.profileId);
  if (profile === undefined || profile.householdId !== context.householdId) {
    throw new DomainError(404, ProblemCode.NOT_FOUND);
  }
  if (profile.accountId !== identity.accountId) {
    throw new DomainError(404, ProblemCode.NOT_FOUND);
  }
  if (profile.status !== 'active') {
    throw new DomainError(403, ProblemCode.ACTIVE_PROFILE_REQUIRED);
  }
}

/** 策略判定视图(结构相容 policy.domain PolicyJudgment;不深导跨上下文类型) */
interface EffectivePolicyJudgment {
  readonly maxContentLevel: number;
  readonly allowUnrated: boolean;
  readonly allowedMediaIds: string[];
  readonly blockedMediaIds: string[];
  readonly allowedChannelIds: string[];
}

/** 策略行 → 判定视图;损坏(不变量破坏/名单非法)一律 503 POLICY_UNAVAILABLE,绝不静默放行 */
function readPolicyJudgment(row: PolicyRow): EffectivePolicyJudgment {
  if (
    !Number.isInteger(row.maxContentLevel) ||
    row.maxContentLevel < 0 ||
    row.maxContentLevel > 18 ||
    (row.allowUnrated !== 0 && row.allowUnrated !== 1) ||
    !Number.isInteger(row.version) ||
    row.version < 1
  ) {
    throw new DomainError(503, ProblemCode.POLICY_UNAVAILABLE, '策略损坏(数值不变量),已拒绝访问,请修复数据');
  }
  return {
    maxContentLevel: row.maxContentLevel,
    allowUnrated: row.allowUnrated === 1,
    allowedMediaIds: parseStoredList(row.allowedMediaIds, 'allowedMediaIds'),
    blockedMediaIds: parseStoredList(row.blockedMediaIds, 'blockedMediaIds'),
    allowedChannelIds: parseStoredList(row.allowedChannelIds, 'allowedChannelIds'),
  };
}

/** 父子目标策略判定(T017 端口);父或选中子任一拒绝 → 404 同形(不泄露判定轴) */
function assertTargetPolicyAllows(
  deps: MaterializationServiceDeps,
  ws: MaterializeWorkSetView,
  context: MaterializationContext,
  facts: ParentChildMediaFacts,
): void {
  const policyRow = ws.policy.findEffectivePolicy(context.householdId, context.profileId);
  if (policyRow === undefined) {
    throw new DomainError(503, ProblemCode.POLICY_UNAVAILABLE, '策略缺失,已拒绝访问,请修复数据');
  }
  const decision = deps.effectiveMediaPolicy.evaluate({
    householdId: context.householdId,
    profileId: context.profileId,
    policy: readPolicyJudgment(policyRow),
    facts,
  });
  if (!decision.parent.allowed || decision.children.some((child) => !child.allowed)) {
    throw new DomainError(404, ProblemCode.NOT_FOUND, '内容当前不可用');
  }
}

/**
 * 物化目标父子事实(父+选中子轴):已有目标以目录行等级为权威
 * (批量装载,禁每集 N+1);新目标以预览事实等级为输入;householdEnabled=true
 * ——来源启用已由配置 CAS 保证,物化即时可用性由本事务建立。
 */
function buildTargetPolicyFacts(
  ws: MaterializeWorkSetView,
  context: MaterializationContext,
  resolved: ResolvedMaterializationTarget,
  plan: TitleMappingPlan,
): ParentChildMediaFacts {
  // 批量装载(父/子一次集合查询);新预分配行尚未落库,自然缺席,等级回落到解析事实。
  const targetRows = ws.policy.listPolicyTargetMedia(context.householdId, [
    plan.parentMediaId,
    plan.selected.mediaId,
  ]);
  const parentLevel =
    targetRows.find((row) => row.id === plan.parentMediaId)?.contentLevel ??
    plan.existingParentRow?.contentLevel ??
    resolved.detail.parentContentLevel ??
    null;
  const selectedLevel =
    targetRows.find((row) => row.id === plan.selected.mediaId)?.contentLevel ??
    (plan.selected.isNew ? (plan.selected.resolved.contentLevel ?? null) : null);
  return {
    householdId: context.householdId,
    parent: {
      mediaId: plan.parentMediaId,
      role: plan.parentType,
      contentLevel: parentLevel,
      householdEnabled: true,
    },
    children: [
      {
        mediaId: plan.selected.mediaId,
        role: 'episode',
        contentLevel: selectedLevel,
        householdEnabled: true,
      },
    ],
  };
}

/** 已有目标的策略事实(目录行等级/角色;重放路径复用) */
function factsFromCatalogRows(
  context: MaterializationContext,
  parentRow: CatalogMediaRow,
  selectedRow: CatalogMediaRow,
): ParentChildMediaFacts {
  return {
    householdId: context.householdId,
    parent: {
      mediaId: parentRow.id,
      role: parentRow.type as 'movie' | 'series' | 'video',
      contentLevel: parentRow.contentLevel,
      householdEnabled: true,
    },
    children: [
      {
        mediaId: selectedRow.id,
        role: 'episode',
        contentLevel: selectedRow.contentLevel,
        householdEnabled: true,
      },
    ],
  };
}

/* --------------------------------- 步骤 3:稳定 ID 查找或预分配 --------------------------------- */

/** 物化映射计划构建:已有映射复用(不占新配额);首次身份全部内存预分配(不落库) */
function planTitleMapping(
  ws: MaterializeWorkSetView,
  context: MaterializationContext,
  resolved: ResolvedMaterializationTarget,
  newId: () => string,
): TitleMappingPlan {
  const householdId = context.householdId;
  const existingTitle = ws.vod.findTitleMapping(householdId, resolved.sourceId, resolved.upstreamVodId);
  let parentMediaId: string;
  let parentIsNew: boolean;
  let existingParentRow: CatalogMediaRow | undefined;
  if (existingTitle === undefined) {
    parentIsNew = true;
    parentMediaId = newId();
    // 预分配父 ID 防撞(只在内存;此处仅读 catalog,不产生任何写入)。
    assertIdAvailable(ws, householdId, parentMediaId);
  } else {
    parentIsNew = false;
    parentMediaId = existingTitle.parentMediaId;
    existingParentRow = ws.catalog.findCatalogMedia(householdId, parentMediaId);
    if (existingParentRow === undefined) {
      // 稳定映射指向的父媒体缺失(目录行被外部删除):旧目标已变化,拒绝而非重建。
      throw new DomainError(409, ProblemCode.VOD_MATERIALIZATION_STALE);
    }
  }

  const titleId = existingTitle === undefined ? newId() : existingTitle.id;
  const existingLines: VodLineRow[] =
    existingTitle === undefined ? [] : ws.vod.listLinesByTitle(householdId, titleId);
  const linesByKey = new Map(existingLines.map((line) => [line.lineKey, line]));
  const totalEpisodes = resolved.detail.lines.reduce((sum, line) => sum + line.episodes.length, 0);
  const parentType: 'movie' | 'series' | 'video' =
    resolved.detail.lines.length > 1 || totalEpisodes > 1 ? 'series' : 'movie';

  const lines: LineMappingPlan[] = resolved.detail.lines.map((line) => {
    const existingLine = linesByKey.get(line.lineKey);
    const lineId = existingLine === undefined ? newId() : existingLine.id;
    const existingEpisodes =
      existingLine === undefined ? [] : ws.vod.listEpisodesByLine(householdId, lineId);
    const episodesByKey = new Map(existingEpisodes.map((episode) => [episode.episodeKey, episode]));
    const episodes: EpisodeMappingPlan[] = line.episodes.map((episode) =>
      existingEpisodePlanOrNew(episode, episodesByKey.get(episode.episodeKey), newId),
    );
    return { resolved: line, lineId, isNew: existingLine === undefined, episodes };
  });
  const selected = lines
    .flatMap((line) => line.episodes)
    .find(
      (episode) => episode.resolved.episodeKey === resolved.episodeKey,
    );
  if (selected === undefined) {
    // 解析事实与目标选中集不一致(resolver 契约违约):拒绝,不猜测映射。
    throw new DomainError(409, ProblemCode.VOD_DETAIL_CHANGED, '目标选中集不在详情内,请重新预览');
  }
  const existingSelectedRow = selected.isNew
    ? undefined
    : ws.catalog.findCatalogMedia(householdId, selected.mediaId);
  return {
    parentMediaId,
    parentIsNew,
    titleId,
    parentType,
    lines,
    selected,
    existingParentRow,
    existingSelectedRow,
    existingTitle,
  };
}

/** 单集映射计划:已有 (line, episode_key) 复用既有行/媒体 ID;首次全部内存预分配 */
function existingEpisodePlanOrNew(
  resolved: ResolvedEpisodeFacts,
  existing: VodEpisodeRow | undefined,
  newId: () => string,
): EpisodeMappingPlan {
  if (existing === undefined) {
    return { resolved, episodeRowId: newId(), mediaId: newId(), isNew: true, existing: undefined };
  }
  return { resolved, episodeRowId: existing.id, mediaId: existing.mediaId, isNew: false, existing };
}

/** 预分配 ID 防撞:目标 ID 已被占用即内部错误(随机 UUID 冲突为装配级异常,不静默换号) */
function assertIdAvailable(ws: MaterializeWorkSetView, householdId: string, mediaId: string): void {
  if (ws.catalog.findCatalogMedia(householdId, mediaId) !== undefined) {
    throw new DomainError(500, ProblemCode.INTERNAL, '媒体身份分配冲突,请重试');
  }
}

/* --------------------------------- 步骤 5:配置/详情 CAS --------------------------------- */

/**
 * 预览/配置/详情 CAS(api §3:新操作必须有效预览;配置失配拒绝旧预览消费):
 * - 来源必须为本家庭启用 vod 来源(T026 配置面),否则 404 同形;
 * - 来源 locatorRevision 与预览事实基线失配(启停/改名后)→ 410(旧预览失效);
 * - 命令 previewRevision 与解析预览修订失配 → 409 VOD_DETAIL_CHANGED(修订改变);
 * - 已有目标:预览修订必须等于当前详情指针(落后 409),当前详情快照存在即可
 *   (缺失 410;不再以 expires_at 拦截过期——解析桥预览 TTL 门已保证事实新鲜,
 *   过期拦截曾令已入库标题在快照到期后永久 410、恢复指引自相矛盾);
 * - 新目标:预览缓存 TTL 内有效(过期 410)。
 */
function assertConfigurationAndDetailCas(
  ws: MaterializeWorkSetView,
  context: MaterializationContext,
  command: MaterializeCommand,
  resolved: ResolvedMaterializationTarget,
  plan: TitleMappingPlan,
  nowMs: number,
): void {
  const source = ws.source.findOwnedVodSource(context.householdId, resolved.sourceId);
  if (source === undefined) {
    throw new DomainError(404, ProblemCode.NOT_FOUND, '来源当前不可用');
  }
  if (source.locatorRevision !== resolved.detail.locatorRevision) {
    throw new DomainError(410, ProblemCode.VOD_PREVIEW_EXPIRED);
  }
  if (command.previewRevision !== resolved.previewRevision) {
    throw new DomainError(409, ProblemCode.VOD_DETAIL_CHANGED);
  }
  if (plan.existingTitle === undefined) {
    if (Date.parse(resolved.previewExpiresAt) <= nowMs) {
      throw new DomainError(410, ProblemCode.VOD_PREVIEW_EXPIRED);
    }
    return;
  }
  const currentRevision = plan.existingTitle.currentDetailRevision;
  if (resolved.detail.detailRevision !== currentRevision) {
    throw new DomainError(409, ProblemCode.VOD_DETAIL_CHANGED);
  }
  const snapshot = ws.vod.findDetailSnapshot(context.householdId, plan.existingTitle.id, currentRevision);
  // 快照过期不再拦截:解析桥仅放行 TTL 内预览事实,新鲜度由预览门保证;
  // snapshot.expires_at 只服务稳定详情 stale 判定,不构成物化 CAS 条件
  if (snapshot === undefined) {
    throw new DomainError(410, ProblemCode.VOD_PREVIEW_EXPIRED);
  }
}

/* --------------------------------------- 步骤 6:净配额 --------------------------------------- */

/** 净配额(新增净额):复用已有映射不占新配额;父/子双基数检查,超额 409 */
function assertNetQuota(
  deps: MaterializationServiceDeps,
  ws: MaterializeWorkSetView,
  householdId: string,
  plan: TitleMappingPlan,
): void {
  const newParents = plan.parentIsNew ? 1 : 0;
  const newEpisodes = plan.lines.reduce(
    (sum, line) => sum + line.episodes.filter((episode) => episode.isNew).length,
    0,
  );
  if (ws.vod.countVodTitleParents(householdId) + newParents > deps.quotas.maxParentTitles) {
    throw new DomainError(409, ProblemCode.VOD_QUOTA_EXCEEDED);
  }
  if (ws.vod.countVodEpisodes(householdId) + newEpisodes > deps.quotas.maxChildEpisodes) {
    throw new DomainError(409, ProblemCode.VOD_QUOTA_EXCEEDED);
  }
}

/* --------------------------------- 步骤 7:完整映射/资源 --------------------------------- */

interface MappingWriteReport {
  readonly derivedPresentationChanged: boolean;
  readonly newLines: number;
  readonly newEpisodes: number;
  readonly newSequences: number;
  readonly detailSnapshotPublished: boolean;
}

/** 稳定映射(整片:父/线/全集/详情/序列)+ 在线条目/播放资源;全部同事务,失败整体回滚 */
function writeMappingsAndResources(
  ws: MaterializeWorkSetView,
  context: MaterializationContext,
  resolved: ResolvedMaterializationTarget,
  plan: TitleMappingPlan,
  nowIso: string,
  newId: () => string,
): MappingWriteReport {
  const householdId = context.householdId;
  let newLines = 0;
  let newEpisodes = 0;
  let newSequences = 0;
  let relationSortOrder = 1;

  // 父媒体(首次物化才建;复用路径仅派生展示可覆盖,人工修正保留)。
  if (plan.parentIsNew) {
    ws.catalog.insertVodTitleMedia({
      id: plan.parentMediaId,
      householdId,
      type: plan.parentType,
      title: resolved.detail.title,
      description: resolved.detail.description,
      createdAt: nowIso,
      updatedAt: nowIso,
    });
  }
  const derivedPresentationChanged = plan.parentIsNew
    ? false
    : publishDerivedPresentation(
        ws.catalog,
        householdId,
        plan.parentMediaId,
        { title: resolved.detail.title, description: resolved.detail.description },
        nowIso,
      );

  // 稳定标题映射(首次;current 指针即本次详情修订,后续推进走后台详情更新路径)。
  if (plan.existingTitle === undefined) {
    ws.vod.insertTitleMapping({
      titleId: plan.titleId,
      householdId,
      sourceId: resolved.sourceId,
      upstreamVodId: resolved.upstreamVodId,
      parentMediaId: plan.parentMediaId,
      currentDetailRevision: resolved.detail.detailRevision,
      materializedAt: nowIso,
    });
  }

  // 线路/子项(已有身份一律复用;「新增其他集不使已有子revision改变」)。
  // 导航序列不经本循环逐集落行——映射完成后由 episode-sequence.service.publishSequence
  // 整片发布(T055 接线点,见下方调用)。
  for (const line of plan.lines) {
    if (line.isNew) {
      ws.vod.insertLine({
        lineId: line.lineId,
        householdId,
        titleId: plan.titleId,
        lineKey: line.resolved.lineKey,
        displayName: line.resolved.displayName,
        sortOrder: line.resolved.sortOrder,
      });
      newLines += 1;
    }
    for (const episode of line.episodes) {
      if (episode.isNew) {
        ws.catalog.insertVodEpisodeMedia({
          id: episode.mediaId,
          householdId,
          title: episode.resolved.label,
          description: null,
          createdAt: nowIso,
          updatedAt: nowIso,
        });
        ws.catalog.insertEpisodeParentRelation({
          householdId,
          parentId: plan.parentMediaId,
          childId: episode.mediaId,
          sortOrder: relationSortOrder,
        });
        ws.vod.insertEpisode({
          episodeId: episode.episodeRowId,
          householdId,
          lineId: line.lineId,
          episodeKey: episode.resolved.episodeKey,
          label: episode.resolved.label,
          mediaId: episode.mediaId,
          contentVersionState: episode.resolved.contentVersionState,
          evidenceKind: episode.resolved.evidenceKind,
          evidenceDigest: episode.resolved.evidenceDigest,
          schemaVersion: episode.resolved.schemaVersion,
          // T015 值集要求 continuityRevision 为 number(静态基线 1);解析事实缺证据
          // (null)时落基线 1,signature 保持 null(不冒充 verified 证据,CHECK 允许)。
          continuityRevision: episode.resolved.continuityRevision ?? 1,
          continuitySignature: episode.resolved.continuitySignature,
        });
        newEpisodes += 1;
      }
      relationSortOrder += 1;
    }
  }

  // 导航序列发布(T055 接线点):父/线/子项映射落库后、详情快照同事务发布序列修订。
  // 修订判定(初版 1 / 成员·顺序·年季·常规集资格未变沿用 / 变化 +1)与行写入全部在
  // episode-sequence.service.publishSequence;行状态取规则推导值(ordered/ambiguous/
  // special),special 由解析事实的 sequenceStatus==='special' 裸事实输入,规则层
  // 依重复键/序位重推其余分类;无序位集不入序列行(DDL ordinal NOT NULL)。
  const sequencePublication: PublishSequenceOutcome = publishSequence(ws.vod, {
    householdId,
    sourceId: resolved.sourceId,
    titleId: plan.titleId,
    detailRevision: resolved.detail.detailRevision,
    lines: plan.lines.map((line) => ({
      lineId: line.lineId,
      lineKey: line.resolved.lineKey,
      displayName: line.resolved.displayName,
      sortOrder: line.resolved.sortOrder,
      episodes: line.episodes.map((episode) => ({
        episodeId: episode.episodeRowId,
        episodeKey: episode.resolved.episodeKey,
        mediaId: episode.mediaId,
        seasonKey: episode.resolved.seasonKey,
        ordinal: episode.resolved.ordinal,
        special: episode.resolved.sequenceStatus === 'special',
      })),
    })),
  });
  newSequences = sequencePublication.rowsWritten;

  // 不可变详情快照((title, revision) 唯一;同 revision 已存在即复用,不重复发布)。
  let detailSnapshotPublished = false;
  if (ws.vod.findDetailSnapshot(householdId, plan.titleId, resolved.detail.detailRevision) === undefined) {
    ws.vod.insertImmutableDetailSnapshot({
      householdId,
      titleId: plan.titleId,
      revision: resolved.detail.detailRevision,
      locatorRevision: resolved.detail.locatorRevision,
      validatedPrivatePayload: resolved.detail.validatedPrivatePayload,
      fetchedAt: resolved.detail.fetchedAt,
      expiresAt: resolved.detail.expiresAt,
    });
    detailSnapshotPublished = true;
  }
  // 当前指针:首次映射已随行落为本次修订;复用路径 CAS 已保证指针==本次修订,
  // 故用户物化不推进指针(后台详情更新走 advanceCurrentDetailPointer,公共 rev 只改一次)。

  // 在线条目 + 播放资源(entry 唯一资源;新子项必无既有 entry,已有子项查重后补写)。
  for (const line of plan.lines) {
    for (const episode of line.episodes) {
      const existingEntry = episode.isNew
        ? undefined
        : ws.sourceEntry.findSourceEntryByMedia(householdId, resolved.sourceId, episode.mediaId);
      const entryId = existingEntry?.entryId ?? newId();
      if (existingEntry === undefined) {
        ws.sourceEntry.insertOnlineSourceEntry({
          entryId,
          householdId,
          sourceId: resolved.sourceId,
          identityDigest: episodeIdentityDigest(resolved, line.resolved.lineKey, episode.resolved.episodeKey),
          mediaId: episode.mediaId,
          firstSeenAt: nowIso,
          lastSeenAt: nowIso,
        });
      }
      ws.sourceEntry.upsertOnlinePlaybackResource({
        playbackSourceId: newId(),
        householdId,
        sourceId: resolved.sourceId,
        sourceEntryId: entryId,
        mediaItemId: episode.mediaId,
        vodEpisodeId: episode.episodeRowId,
        priority: 100,
        // 在线地址私有于详情快照,交付必经代理(requires_proxy=1;online 判别分支 protocol=hls)。
        requiresProxy: true,
        updatedAt: nowIso,
      });
    }
  }

  return { derivedPresentationChanged, newLines, newEpisodes, newSequences, detailSnapshotPublished };
}

/** source_entry 身份摘要:覆盖稳定定位(source/upstream/line/episode 键),不含 URL/采集时间 */
function episodeIdentityDigest(
  resolved: ResolvedMaterializationTarget,
  lineKey: string,
  episodeKey: string,
): string {
  return createHash('sha256')
    .update(`vod_episode\u0000${resolved.sourceId}\u0000${resolved.upstreamVodId}\u0000${lineKey}\u0000${episodeKey}`)
    .digest('hex');
}
