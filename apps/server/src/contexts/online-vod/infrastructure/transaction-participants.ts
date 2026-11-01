/**
 * online-vod 事务参与者(T016,T027 接管重构;Drizzle/better-sqlite3 同连接绑定实现)。
 *
 * 端口来源(本上下文 application,冻结于 T015):
 * contexts/online-vod/application/publication-work-set.port.ts ——
 * VodParticipant / MaterializationOperationStore / QuotaStore / RegisteredCandidateParticipant。
 *
 * 与 UnitOfWork(T016 @platform/database/unit-of-work)的接合:
 * - createOnlineVodTxParticipants 为 TxStore 工厂(基础设施角色):装配期注册进
 *   createUnitOfWork 的 txStores 注册表(键 'vod',组合根 app.module.ts 与契约 rig 消费),
 *   每次 run 由平台以同一连接的 TransactionBinding 调用;全部方法经绑定同步执行,
 *   事务边界即调用栈边界;
 * - application(workSetFactory/callback)只消费绑定后的端口值,不接触
 *   TransactionBinding / 连接句柄;任何方法抛错即整体回滚(T008 用例 2/3)。
 *
 * T027 重构说明(语义零变化):
 * - 只读方法(稳定映射/详情快照/子项映射/序列/已提交幂等操作/登记候选反查)自本文件
 *   迁至 infrastructure/online-vod-store.drizzle.ts 的共享只读原语 OnlineVodReadStatements,
 *   与非事务读面 OnlineVodStore 共享同一语句文本/谓词/投影(去重不失语义);语句与
 *   T016 逐字一致(真实 DDL 冒烟通过的语义基准),本类经继承获得,SQL 不再双写;
 * - 写入与净配额保留于本类(Tx 面):INSERT 一律幂等靠显式存在性检查/唯一约束冲突
 *   整体回滚(vod_episode_sequence 无行级唯一,行身份为 rowid;vod_detail_snapshot
 *   (title,revision) 主键冲突即冲突拒绝);
 * - QuotaStore.countEnabledVodSources 为与 sources 参与者 canonical 版
 *   (contexts/sources/infrastructure/transaction-participants.ts DrizzleSourcesTxParticipants)
 *   **逐字同句同参**的直读:同 JOIN/同谓词(kind='vod' AND enabled=1)/同 household 条件,
 *   口径一致;保留在本上下文的原因是 MaterializeWorkSet.quota 现由 'vod' tx 键单接口
 *   提供三计数,改由 sources 片段组合属工作集装配裁决(归 T029),非语句语义差异。
 *
 * 编排纪律(消费方 MaterializeWorkSet,api.md §3):intent 先于 reserve、successor
 * session 先于 consumeSlot 的跨参与者顺序由 application 编排,本类各方法保持
 * 单语句同步语义;幂等查询只认 committed_at 非空的成功结果。
 */
import type { TransactionBinding } from '@platform/database/unit-of-work';
import { OnlineVodReadStatements } from '@contexts/online-vod/infrastructure/online-vod-store.drizzle';
import type {
  MaterializationOperationInsert,
  MaterializationOperationStore,
  QuotaStore,
  RegisteredCandidateInsert,
  RegisteredCandidateParticipant,
  VodDetailSnapshotInsert,
  VodEpisodeInsert,
  VodEpisodeSequenceInsert,
  VodLineInsert,
  VodParticipant,
  VodTitleMappingInsert,
} from '@contexts/online-vod/application/publication-work-set.port';

/**
 * online-vod 事务参与者绑定实现(稳定映射/详情/序列 + 物化幂等 + 净配额 + 登记候选)。
 * 只读方法继承自 OnlineVodReadStatements(与非事务 store 共享查询原语)。
 */
export class DrizzleOnlineVodTxParticipants
  extends OnlineVodReadStatements
  implements VodParticipant, MaterializationOperationStore, QuotaStore, RegisteredCandidateParticipant
{
  private readonly binding: TransactionBinding;

  constructor(binding: TransactionBinding) {
    // TransactionBinding 与共享执行面结构同形(exec/get/all),直通即绑定
    super(binding);
    this.binding = binding;
  }

  /* -------------------------------- VodParticipant(稳定映射/详情/序列 写面;读面继承) -------------------------------- */

  insertTitleMapping(values: VodTitleMappingInsert): void {
    this.binding.exec(
      'INSERT INTO vod_title (id, household_id, source_id, upstream_vod_id, parent_media_id, current_detail_revision, materialized_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
      [
        values.titleId,
        values.householdId,
        values.sourceId,
        values.upstreamVodId,
        values.parentMediaId,
        values.currentDetailRevision,
        values.materializedAt,
      ],
    );
  }

  insertImmutableDetailSnapshot(values: VodDetailSnapshotInsert): void {
    // (title, revision) 唯一:已存在同 revision 由主键冲突抛错 → 整体回滚(冲突拒绝);
    // 不可变快照只 INSERT 不 UPDATE(当前指针经 advanceCurrentDetailPointer 推进)
    this.binding.exec(
      'INSERT INTO vod_detail_snapshot (household_id, title_id, revision, locator_revision, validated_private_payload, fetched_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
      [
        values.householdId,
        values.titleId,
        values.revision,
        values.locatorRevision,
        values.validatedPrivatePayload,
        values.fetchedAt,
        values.expiresAt,
      ],
    );
  }

  advanceCurrentDetailPointer(householdId: string, titleId: string, detailRevision: number): void {
    this.binding.exec(
      'UPDATE vod_title SET current_detail_revision = ? WHERE household_id = ? AND id = ?',
      [detailRevision, householdId, titleId],
    );
  }

  insertLine(values: VodLineInsert): void {
    this.binding.exec(
      'INSERT INTO vod_line (id, household_id, title_id, line_key, display_name, sort_order) VALUES (?, ?, ?, ?, ?, ?)',
      [values.lineId, values.householdId, values.titleId, values.lineKey, values.displayName, values.sortOrder],
    );
  }

  insertEpisode(values: VodEpisodeInsert): void {
    this.binding.exec(
      `INSERT INTO vod_episode (
        id, household_id, line_id, episode_key, label, media_id,
        content_version_state, evidence_kind, evidence_digest, schema_version,
        continuity_revision, continuity_signature
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        values.episodeId,
        values.householdId,
        values.lineId,
        values.episodeKey,
        values.label,
        values.mediaId,
        values.contentVersionState,
        values.evidenceKind,
        values.evidenceDigest,
        values.schemaVersion,
        values.continuityRevision,
        values.continuitySignature,
      ],
    );
  }

  insertEpisodeSequence(values: VodEpisodeSequenceInsert): void {
    // 010 收敛:vod_episode_sequence 无行级唯一(数据模型「导航与身份分开」,行身份为 rowid),
    // 本语句为纯 INSERT,不依赖主键/唯一冲突做幂等或回滚;重复导航快照按序落行由
    // application 的存在性检查(detail_revision/sequence_revision 复核)负责
    this.binding.exec(
      `INSERT INTO vod_episode_sequence (
        household_id, title_id, line_id, detail_revision, sequence_revision,
        episode_id, season_key, ordinal, sequence_status
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        values.householdId,
        values.titleId,
        values.lineId,
        values.detailRevision,
        values.sequenceRevision,
        values.episodeId,
        values.seasonKey,
        values.ordinal,
        values.sequenceStatus,
      ],
    );
  }

  /* -------------------------------- MaterializationOperationStore(物化幂等;读面继承) -------------------------------- */

  recordCommittedOperation(values: MaterializationOperationInsert): void {
    this.binding.exec(
      `INSERT INTO vod_materialization_operation (
        id, household_id, device_session_id, profile_id, profile_context_version,
        operation_key, request_digest, parent_media_id, selected_media_id,
        selected_content_revision, selected_continuity_revision, detail_revision,
        catalog_revision, result, committed_at, expires_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        values.id,
        values.householdId,
        values.deviceSessionId,
        values.profileId,
        values.profileContextVersion,
        values.operationKey,
        values.requestDigest,
        values.parentMediaId,
        values.selectedMediaId,
        values.selectedContentRevision,
        values.selectedContinuityRevision,
        values.detailRevision,
        values.catalogRevision,
        values.result,
        values.committedAt,
        values.expiresAt,
      ],
    );
  }

  /* -------------------------------- QuotaStore(净配额基数) -------------------------------- */

  countVodTitleParents(householdId: string): number {
    const row = this.binding.get<{ n: number }>(
      'SELECT COUNT(*) AS n FROM vod_title WHERE household_id = ?',
      [householdId],
    );
    return row?.n ?? 0;
  }

  countVodEpisodes(householdId: string): number {
    const row = this.binding.get<{ n: number }>(
      'SELECT COUNT(*) AS n FROM vod_episode WHERE household_id = ?',
      [householdId],
    );
    return row?.n ?? 0;
  }

  countEnabledVodSources(householdId: string): number {
    // 与 sources 参与者 canonical 版逐字同句同参(口径一致;见文件头 T027 重构说明 ——
    // 共享表直读,无跨上下文私表导入;组合方式裁决归 T029 工作集装配)
    const row = this.binding.get<{ n: number }>(
      `SELECT COUNT(*) AS n
       FROM media_source ms
       JOIN vod_source_config c ON c.household_id = ms.household_id AND c.source_id = ms.id
       WHERE ms.household_id = ? AND ms.kind = 'vod' AND ms.enabled = 1`,
      [householdId],
    );
    return row?.n ?? 0;
  }

  /* -------------------------------- RegisteredCandidateParticipant(§5 登记候选;读面继承) -------------------------------- */

  registerCandidateMapping(values: RegisteredCandidateInsert): void {
    // 010 收敛:5+12 列落库 —— 原 candidate_ref 即唯一键 (household, operation_id,
    // candidate_ref) 组成列,别名旧列 source_candidate_ref 已自 0007 删除
    this.binding.exec(
      `INSERT INTO vod_registered_candidate (
        id, household_id, device_session_id, profile_id, profile_context_version,
        registered_candidate_ref, candidate_ref, source_session_id, source_generation,
        preview_revision, target_media_id, target_content_revision, target_continuity_revision,
        target_detail_revision, materialization_operation_id, created_at, expires_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        values.id,
        values.householdId,
        values.deviceSessionId,
        values.profileId,
        values.profileContextVersion,
        values.registeredCandidateRef,
        values.candidateRef,
        values.sourceSessionId,
        values.sourceGeneration,
        values.previewRevision,
        values.targetMediaId,
        values.targetContentRevision,
        values.targetContinuityRevision,
        values.targetDetailRevision,
        values.materializationOperationId,
        values.createdAt,
        values.expiresAt,
      ],
    );
  }
}

/** TxStore 工厂(装配期注册进 UnitOfWork txStores,键 'vod';每次 run 由平台传入绑定) */
export function createOnlineVodTxParticipants(binding: TransactionBinding): DrizzleOnlineVodTxParticipants {
  return new DrizzleOnlineVodTxParticipants(binding);
}
