/**
 * sources 事务参与者(T016,同连接绑定实现)。
 *
 * 端口归属说明:SourceReader / SourceEntryParticipant 由 online-vod 发布工作集
 * (contexts/online-vod/application/publication-work-set.port.ts)声明、所有者标注为
 * sources(internal-ports.md §1 SourceEntryPublicationParticipant);因 R2 跨上下文
 * 深导入禁令(tsPreCompilationDeps 下 import type 同样成边),本文件以**结构镜像类型**
 * 声明端口形状(逐字段一致,镜像源在注释标明),结构一致性由消费侧工作集装配处
 * (MaterializeWorkSet 组装,编译期赋值)强制。
 *
 * 与 UnitOfWork 的接合:装配期注册进 createUnitOfWork txStores(键 'sources'),
 * 每次 run 由平台以同一连接 TransactionBinding 调用工厂;全部方法同步执行,
 * 任何方法抛错即整体回滚。实现形态为 better-sqlite3 原生 prepared statements,
 * 列名对照 schema.ts / migrations/0007_online_vod。
 */
import type { TransactionBinding } from '@platform/database/unit-of-work';

/* ------------------------------ 跨上下文类型镜像(R2 禁深导入;源: online-vod publication-work-set.port.ts) ------------------------------ */

/** 镜像 OwnedVodSourceSnapshot:本家庭启用 vod 来源快照(配置 CAS 基准) */
export interface OwnedVodSourceSnapshot {
  readonly sourceId: string;
  readonly name: string;
  readonly adapter: 'apple-cms-json';
  readonly enabled: boolean;
  readonly version: number;
  readonly locatorRevision: number;
}

/** 镜像 SourceReader:来源读取端口(MaterializeWorkSet.read 面) */
export interface SourceReader {
  findOwnedVodSource(householdId: string, sourceId: string): OwnedVodSourceSnapshot | undefined;
  listEnabledVodSources(householdId: string): OwnedVodSourceSnapshot[];
}

/** 镜像 OnlineSourceEntryInsert:在线条目登记值集(source_entry 新行) */
export interface OnlineSourceEntryInsert {
  readonly entryId: string;
  readonly householdId: string;
  readonly sourceId: string;
  readonly identityDigest: string;
  readonly mediaId: string;
  readonly firstSeenAt: string;
  readonly lastSeenAt: string;
}

/** 镜像 OnlinePlaybackResourceUpsert:在线播放资源写入值集(playback_source online 分支) */
export interface OnlinePlaybackResourceUpsert {
  readonly playbackSourceId: string;
  readonly householdId: string;
  readonly sourceId: string;
  readonly sourceEntryId: string;
  readonly mediaItemId: string;
  readonly vodEpisodeId: string;
  readonly priority: number;
  readonly requiresProxy: boolean;
  readonly updatedAt: string;
}

/** 镜像 SourceEntryParticipant:来源条目发布参与者端口 */
export interface SourceEntryParticipant {
  findSourceEntryByMedia(householdId: string, sourceId: string, mediaId: string): { entryId: string; present: boolean } | undefined;
  insertOnlineSourceEntry(values: OnlineSourceEntryInsert): void;
  upsertOnlinePlaybackResource(values: OnlinePlaybackResourceUpsert): void;
}

/** 镜像 QuotaStore 来源净额切片(MaterializeWorkSet.quota 的「10 启用源」基数) */
export interface SourceQuotaFragment {
  countEnabledVodSources(householdId: string): number;
}

/**
 * sources 事务参与者绑定实现(来源读取面 + 在线条目/资源发布 + 来源净额)。
 */
export class DrizzleSourcesTxParticipants implements SourceReader, SourceEntryParticipant, SourceQuotaFragment {
  constructor(private readonly binding: TransactionBinding) {}

  /* -------------------------------- SourceReader(来源读取面) -------------------------------- */

  findOwnedVodSource(householdId: string, sourceId: string): OwnedVodSourceSnapshot | undefined {
    // 端口语义:未配置(adapter 缺行,JOIN 不命中)或禁用(enabled≠1)返回 undefined
    const row = this.binding.get<{
      sourceId: string;
      name: string;
      adapter: string;
      enabled: number;
      version: number;
      locatorRevision: number;
    }>(
      `SELECT
        ms.id AS sourceId,
        ms.name AS name,
        c.adapter AS adapter,
        ms.enabled AS enabled,
        ms.version AS version,
        ms.locator_revision AS locatorRevision
       FROM media_source ms
       JOIN vod_source_config c ON c.household_id = ms.household_id AND c.source_id = ms.id
       WHERE ms.household_id = ? AND ms.id = ? AND ms.kind = 'vod' AND ms.enabled = 1`,
      [householdId, sourceId],
    );
    if (row === undefined) return undefined;
    return {
      sourceId: row.sourceId,
      name: row.name,
      // adapter 由 vod_source_config_adapter_check(CHECK = 'apple-cms-json')保证
      adapter: row.adapter as OwnedVodSourceSnapshot['adapter'],
      enabled: row.enabled === 1,
      version: row.version,
      locatorRevision: row.locatorRevision,
    };
  }

  listEnabledVodSources(householdId: string): OwnedVodSourceSnapshot[] {
    const rows = this.binding.all<{
      sourceId: string;
      name: string;
      adapter: string;
      enabled: number;
      version: number;
      locatorRevision: number;
    }>(
      `SELECT
        ms.id AS sourceId,
        ms.name AS name,
        c.adapter AS adapter,
        ms.enabled AS enabled,
        ms.version AS version,
        ms.locator_revision AS locatorRevision
       FROM media_source ms
       JOIN vod_source_config c ON c.household_id = ms.household_id AND c.source_id = ms.id
       WHERE ms.household_id = ? AND ms.kind = 'vod' AND ms.enabled = 1
       ORDER BY ms.created_at, ms.id`,
      [householdId],
    );
    return rows.map((row) => ({
      sourceId: row.sourceId,
      name: row.name,
      adapter: row.adapter as OwnedVodSourceSnapshot['adapter'],
      enabled: row.enabled === 1,
      version: row.version,
      locatorRevision: row.locatorRevision,
    }));
  }

  /* -------------------------------- SourceEntryParticipant(条目/资源发布面) -------------------------------- */

  findSourceEntryByMedia(
    householdId: string,
    sourceId: string,
    mediaId: string,
  ): { entryId: string; present: boolean } | undefined {
    // 在线发布面查重限定 identity_kind='vod_episode'(在线条目唯一身份种类);
    // present 为存在性权威。同媒体多行时取 id 最小行保证确定性。
    const row = this.binding.get<{ entryId: string; present: number }>(
      `SELECT id AS entryId, present FROM source_entry
       WHERE household_id = ? AND source_id = ? AND media_id = ? AND identity_kind = 'vod_episode'
       ORDER BY id LIMIT 1`,
      [householdId, sourceId, mediaId],
    );
    if (row === undefined) return undefined;
    return { entryId: row.entryId, present: row.present === 1 };
  }

  insertOnlineSourceEntry(values: OnlineSourceEntryInsert): void {
    // identity_kind='vod_episode';present=1;无 refresh job(last_seen_job_id NULL)、
    // 无 NAS 文件事实与分组(upstream_channel_id/missing_since/file_*/group_title NULL)
    this.binding.exec(
      `INSERT INTO source_entry (
        id, household_id, source_id, identity_kind, identity_digest, media_id,
        upstream_channel_id, present, last_seen_job_id, first_seen_at, last_seen_at,
        missing_since, file_size_text, file_mtime_ns, group_title
      ) VALUES (?, ?, ?, 'vod_episode', ?, ?, NULL, 1, NULL, ?, ?, NULL, NULL, NULL, NULL)`,
      [
        values.entryId,
        values.householdId,
        values.sourceId,
        values.identityDigest,
        values.mediaId,
        values.firstSeenAt,
        values.lastSeenAt,
      ],
    );
  }

  upsertOnlinePlaybackResource(values: OnlinePlaybackResourceUpsert): void {
    // entry 唯一资源(playback_source_entry_key 唯一索引):有行更新、无行插入;
    // online 判别分支由 CHECK 落实(location NULL/vod 引用非空/protocol='hls')
    const existing = this.binding.get<{ id: string }>(
      'SELECT id FROM playback_source WHERE household_id = ? AND source_entry_id = ?',
      [values.householdId, values.sourceEntryId],
    );
    if (existing !== undefined) {
      this.binding.exec(
        `UPDATE playback_source SET
          source_id = ?, media_item_id = ?, vod_episode_id = ?, priority = ?, requires_proxy = ?,
          locator_kind = 'online', protocol = 'hls', location = NULL, updated_at = ?
         WHERE id = ? AND household_id = ?`,
        [
          values.sourceId,
          values.mediaItemId,
          values.vodEpisodeId,
          values.priority,
          values.requiresProxy ? 1 : 0,
          values.updatedAt,
          existing.id,
          values.householdId,
        ],
      );
      return;
    }
    this.binding.exec(
      `INSERT INTO playback_source (
        id, household_id, source_id, source_entry_id, media_item_id,
        protocol, location, mime_type, priority, requires_proxy,
        locator_kind, vod_episode_id, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, 'hls', NULL, NULL, ?, ?, 'online', ?, ?, ?)`,
      [
        values.playbackSourceId,
        values.householdId,
        values.sourceId,
        values.sourceEntryId,
        values.mediaItemId,
        values.priority,
        values.requiresProxy ? 1 : 0,
        values.vodEpisodeId,
        values.updatedAt,
        values.updatedAt,
      ],
    );
  }

  /* -------------------------------- QuotaStore 来源净额切片 -------------------------------- */

  countEnabledVodSources(householdId: string): number {
    const row = this.binding.get<{ n: number }>(
      `SELECT COUNT(*) AS n
       FROM media_source ms
       JOIN vod_source_config c ON c.household_id = ms.household_id AND c.source_id = ms.id
       WHERE ms.household_id = ? AND ms.kind = 'vod' AND ms.enabled = 1`,
      [householdId],
    );
    return row?.n ?? 0;
  }
}

/** TxStore 工厂(装配期注册进 UnitOfWork txStores,键 'sources') */
export function createSourcesTxParticipants(binding: TransactionBinding): DrizzleSourcesTxParticipants {
  return new DrizzleSourcesTxParticipants(binding);
}
