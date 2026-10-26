import type DatabaseConstructor from 'better-sqlite3';
import type { M3UEntry } from './m3u.parser';
import type { NasFileEntry } from './nas-scanner';
import {
  canonicalJson,
  computeBatchEntryIdentities,
  computeSnapshotDigest as computeCanonicalSnapshotDigest,
  type EntryIdentity,
  type SnapshotDigestItem,
} from './catalog-diff';

/**
 * 刷新暂存持久化服务(T025;research R5/data-model「source_refresh / refresh_stage_entry」,
 * 满足 T017 的持久化部分):
 * - 解析结果(IPTV/NAS)分批写入 refresh_stage_entry:主键 (household_id,refresh_id,entry_key),
 *   kind 存 'iptv'|'nas'|'epg'(epg 由后续 T026 窗口发布走同表,本服务当前只承载 iptv/nas 身份条目);
 * - payload_json = 原始条目 + identity 字段(identityKind/identityDigest/entryKey)的规范化 JSON
 *   (键递归排序,json_valid 由 DDL CHECK 保证);解析层的位置等信息保持私有,不进入浏览查询;
 * - 重复 IPTV 身份/NAS 路径:写前经 catalog-diff 整批检查,IDENTITY_DUPLICATED 即整体失败
 *   (单事务全有或全无,不以最后一条覆盖);
 * - 同一 refresh 重复暂存为幂等替换(先 DELETE 后 INSERT),供执行器重试恢复;
 * - 不做发布、不写 source_entry/media_item(发布事务属后续执行器任务);
 *   数据库访问用传入的 better-sqlite3 连接(与 src/database/database.ts 的 Database.db 同型,
 *   列名与 src/database/schema.ts 的 Drizzle 定义一一对应)。
 */

/** 暂存写入分批大小(单事务内分批执行,避免单语句/占位符膨胀;规格建议 500 条/批) */
export const STAGE_WRITE_BATCH_SIZE = 500;

/** refresh_stage_entry.kind 的开放枚举(迁移注释:规格未固定,DB 层不设 CHECK) */
export type StageEntryKind = 'iptv' | 'nas' | 'epg';

/** IPTV 暂存参数(条目为 parseM3U 输出) */
export interface StageIptvParams {
  householdId: string;
  refreshId: string;
  kind: 'iptv';
  entries: readonly M3UEntry[];
  /** 测试缝(对照 scanNasRootWithBudgets 先例):覆盖分批大小以小体量验证分批/跨界语义;缺省用 STAGE_WRITE_BATCH_SIZE */
  writeBatchSize?: number;
}

/** NAS 暂存参数(条目为 scanNasRoot 输出) */
export interface StageNasParams {
  householdId: string;
  refreshId: string;
  kind: 'nas';
  entries: readonly NasFileEntry[];
  /** 测试缝:同 StageIptvParams.writeBatchSize */
  writeBatchSize?: number;
}

export type StageEntriesParams = StageIptvParams | StageNasParams;

export interface StageEntriesResult {
  /** 成功写入的条目数(= entries 长度) */
  stagedCount: number;
  /** 本批暂存内容的顺序无关快照摘要(供 source_refresh.snapshot_digest 落库) */
  snapshotDigest: string;
}

/** 回读行:身份键 + kind + 规范化 payload 文本与解析结果 */
export interface LoadedStagedEntry {
  entryKey: string;
  kind: string;
  /** 存储的规范化 JSON 文本(键排序,可直接参与摘要) */
  payloadJson: string;
  /** JSON.parse(payloadJson) 结果:原始条目 + identity 字段 */
  payload: Record<string, unknown>;
}

interface StageRow {
  entryKey: string;
  kind: string;
  payloadJson: string;
}

/** 由解析条目构造暂存行:批量身份计算(含重复身份整批拒绝)+ 规范化 payload */
function buildStageRows(params: StageEntriesParams): StageRow[] {
  // 判别联合窄化:iptv↔M3U 条目、nas↔NAS 扫描记录;写前检查任一 entry_key 重复
  // 即抛 IDENTITY_DUPLICATED,未触达数据库(全有或全无)
  const identities: EntryIdentity[] =
    params.kind === 'iptv'
      ? computeBatchEntryIdentities(params.kind, params.entries)
      : computeBatchEntryIdentities(params.kind, params.entries);
  return params.entries.map((entry, index) => {
    const identity = identities[index];
    if (identity === undefined) {
      throw new Error('身份计算结果与条目数量不一致(编程错误)');
    }
    const payload = {
      ...entry,
      identityKind: identity.identityKind,
      identityDigest: identity.identityDigest,
      entryKey: identity.entryKey,
    };
    return { entryKey: identity.entryKey, kind: params.kind, payloadJson: canonicalJson(payload) };
  });
}

/**
 * 暂存解析条目到 refresh_stage_entry(单事务,内部按 STAGE_WRITE_BATCH_SIZE 分批执行 INSERT):
 * 先 DELETE 同 (household_id,refresh_id) 既有行再整批写入 —— 暂存对同一 refresh 幂等,
 * 执行器重试暂存不产生半成品/重复;重复身份在写前已整批拒绝(全有或全无)。
 */
export function stageEntries(db: DatabaseConstructor.Database, params: StageEntriesParams): StageEntriesResult {
  const rows = buildStageRows(params);
  // 分批大小:缺省 STAGE_WRITE_BATCH_SIZE;writeBatchSize 为测试缝(须 ≥1,非法值兜底为 1)
  const batchSize =
    params.writeBatchSize !== undefined && params.writeBatchSize >= 1
      ? Math.floor(params.writeBatchSize)
      : STAGE_WRITE_BATCH_SIZE;
  const insert = db.prepare(
    'INSERT INTO refresh_stage_entry (household_id, refresh_id, entry_key, kind, payload_json) VALUES (?, ?, ?, ?, ?)',
  );
  const clearScope = db.prepare('DELETE FROM refresh_stage_entry WHERE household_id = ? AND refresh_id = ?');
  const writeAll = db.transaction(() => {
    clearScope.run(params.householdId, params.refreshId);
    for (let start = 0; start < rows.length; start += batchSize) {
      const batch = rows.slice(start, start + batchSize);
      for (const row of batch) {
        insert.run(params.householdId, params.refreshId, row.entryKey, row.kind, row.payloadJson);
      }
    }
  });
  writeAll();
  return {
    stagedCount: rows.length,
    snapshotDigest: computeCanonicalSnapshotDigest(
      rows.map((row): SnapshotDigestItem => ({ entryKey: row.entryKey, payload: JSON.parse(row.payloadJson) as unknown })),
    ),
  };
}

/** 按 entry_key 升序读回某次刷新的全部暂存条目(供 diff 计数与发布事务消费) */
export function loadStagedEntries(
  db: DatabaseConstructor.Database,
  params: { householdId: string; refreshId: string },
): LoadedStagedEntry[] {
  const rows = db
    .prepare(
      'SELECT entry_key, kind, payload_json FROM refresh_stage_entry WHERE household_id = ? AND refresh_id = ? ORDER BY entry_key ASC',
    )
    .all(params.householdId, params.refreshId) as Array<{ entry_key: string; kind: string; payload_json: string }>;
  return rows.map((row) => ({
    entryKey: row.entry_key,
    kind: row.kind,
    payloadJson: row.payload_json,
    payload: JSON.parse(row.payload_json) as Record<string, unknown>,
  }));
}

/** 清理某次刷新的暂存行(丢弃/过期/终态归档用);返回删除的行数,重复清理返回 0 */
export function clearStagedEntries(
  db: DatabaseConstructor.Database,
  params: { householdId: string; refreshId: string },
): number {
  const result = db
    .prepare('DELETE FROM refresh_stage_entry WHERE household_id = ? AND refresh_id = ?')
    .run(params.householdId, params.refreshId);
  return Number(result.changes);
}

/**
 * 暂存条目的顺序无关快照摘要(委托 catalog-diff 的规范化实现):
 * 入参为回读行形态 {entryKey, payloadJson}(payload 文本按 JSON 解析后参与规范化,
 * 因此无论存储方是否按规范化 JSON 写入,摘要都稳定一致)。
 */
export function computeSnapshotDigest(
  entries: ReadonlyArray<{ entryKey: string; payloadJson: string }>,
): string {
  return computeCanonicalSnapshotDigest(
    entries.map((entry): SnapshotDigestItem => ({
      entryKey: entry.entryKey,
      payload: JSON.parse(entry.payloadJson) as unknown,
    })),
  );
}
