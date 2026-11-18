import { createHash, randomUUID } from 'node:crypto';
import { ProblemCode } from '@hmp/shared';
import type { SessionContext } from '@platform/http-common/current-session.decorator';
import { DomainError } from '@platform/http-common/domain-error';
import { Database } from '@platform/database/database';
import { mediaCatalogStore } from '@contexts/media-catalog/application/media-catalog-store.port';
import { issueLogoRef } from '@contexts/media-catalog/domain/logo-ref';

/**
 * 频道管理的数据访问(018/T050;媒体目录基础设施层)。
 *
 * 原先这些 SQL 直写在 application/catalog-admin.service.ts,触发 007 纯度约束
 * (application 只允许 platform/database 的 schema 类型)。按 ADR-0015 D1 的仓储
 * 分层把语句下沉到本文件;用例编排仍留在 application,catalog-admin 通过
 * re-export 保持既有发布面不变。
 */

export interface ChannelStreamDto {
  id: string;
  sourceEntryId: string;
  sourceId: string;
  sourceName: string;
  protocol: string;
  location: string;
  priority: number;
}

export interface UpdateStreamInput {
  location?: string;
  protocol?: string;
  priority?: number;
}

export interface AddStreamInput {
  location: string;
  protocol?: string;
  priority?: number;
}

export interface BatchVisibilityInput {
  mediaIds?: string[];
  all?: boolean;
  visible: boolean;
}

/**
 * 频道自定义台标写入:清空(撤销)或 upsert 一条 custom 记录,返回新 posterRef。
 * 调用方保证 mediaId 已通过家庭边界检查。
 */
export function applyChannelLogoChange(
  householdId: string,
  mediaId: string,
  logoUrl: string | null,
  nowIso: string,
): string | null {
  if (logoUrl === null || logoUrl.trim() === '') {
    Database.db
      .prepare(
        `UPDATE channel_logo
         SET upstream_url = NULL, revoked_at = ?, updated_at = ?
         WHERE household_id = ? AND media_id = ? AND revoked_at IS NULL`,
      )
      .run(nowIso, nowIso, householdId, mediaId);
    return null;
  }

  const customUrl = logoUrl.trim();
  const existingLogo = Database.db
    .prepare('SELECT ref, revision FROM channel_logo WHERE household_id = ? AND media_id = ?')
    .get(householdId, mediaId) as { ref: string; revision: number } | undefined;

  const newRef = issueLogoRef();
  if (existingLogo !== undefined) {
    Database.db
      .prepare(
        `UPDATE channel_logo
         SET ref = ?, upstream_url = ?, source_kind = 'custom', source_id = NULL,
             revision = revision + 1, revoked_at = NULL, updated_at = ?
         WHERE household_id = ? AND media_id = ?`,
      )
      .run(newRef, customUrl, nowIso, householdId, mediaId);
  } else {
    Database.db
      .prepare(
        `INSERT INTO channel_logo (
          household_id, media_id, ref, upstream_url, source_kind, source_id,
          revision, revoked_at, created_at, updated_at
        ) VALUES (?, ?, ?, ?, 'custom', NULL, 1, NULL, ?, ?)`,
      )
      .run(householdId, mediaId, newRef, customUrl, nowIso, nowIso);
  }
  return newRef;
}

/** 批量修改频道显隐状态(计数为实际变更行数) */
export function batchUpdateMediaVisibility(
  context: SessionContext,
  input: BatchVisibilityInput,
): { updatedCount: number } {
  const householdId = context.session.householdId;
  const visibleInt = input.visible ? 1 : 0;
  const nowIso = new Date().toISOString();

  return mediaCatalogStore().withTransaction((tx) => {
    let count = 0;
    if (input.all) {
      const res = Database.db
        .prepare(
          "UPDATE media_item SET visible = ?, version = version + 1, updated_at = ? WHERE household_id = ? AND type = 'channel'",
        )
        .run(visibleInt, nowIso, householdId);
      count = res.changes;
    } else if (input.mediaIds && input.mediaIds.length > 0) {
      const placeholders = input.mediaIds.map(() => '?').join(',');
      const res = Database.db
        .prepare(
          `UPDATE media_item SET visible = ?, version = version + 1, updated_at = ? WHERE household_id = ? AND id IN (${placeholders})`,
        )
        .run(visibleInt, nowIso, householdId, ...input.mediaIds);
      count = res.changes;
    }
    tx.bumpCatalogRevision(householdId);
    return { updatedCount: count };
  });
}

/**
 * 查询频道的所有播放线路。
 *
 * 排序口径与播放解析一致:priority ASC(数值越小越优先;同权重按创建时间/行序稳定)。
 * 视图与该序对齐后,「线路 #1 = 首选主线路」就是播放实际首 probe 的线路 —— 曾按 DESC
 * 展示导致管理侧标「首选」的线路在播放时排在最后(与 016 契约 isDefault=首个 priority
 * 最小线路的语义相反)。
 */
export function listMediaStreams(householdId: string, mediaId: string): ChannelStreamDto[] {
  const rows = Database.db
    .prepare(
      `SELECT ps.id, ps.source_entry_id AS sourceEntryId, ps.source_id AS sourceId,
              ps.protocol, ps.location, ps.priority,
              COALESCE(ms.name, '自定义来源') AS sourceName
       FROM playback_source ps
       LEFT JOIN media_source ms ON ms.household_id = ps.household_id AND ms.id = ps.source_id
       WHERE ps.household_id = ? AND ps.media_item_id = ?
       ORDER BY ps.priority ASC, ps.created_at ASC, ps.id ASC`,
    )
    .all(householdId, mediaId) as ChannelStreamDto[];
  return rows;
}

/** 修改指定播放线路 (直播 URL / 协议 / 优先级) */
export function updateMediaStream(
  householdId: string,
  mediaId: string,
  streamId: string,
  input: UpdateStreamInput,
): ChannelStreamDto {
  const existing = Database.db
    .prepare(
      'SELECT id, source_entry_id, protocol, location, priority FROM playback_source WHERE household_id = ? AND media_item_id = ? AND id = ?',
    )
    .get(householdId, mediaId, streamId) as
    | { id: string; source_entry_id: string; protocol: string; location: string; priority: number }
    | undefined;

  if (!existing) {
    throw new DomainError(404, ProblemCode.NOT_FOUND, '未找到指定的播放线路');
  }

  const nextLocation = input.location !== undefined ? input.location.trim() : existing.location;
  if (!nextLocation) {
    throw new DomainError(400, ProblemCode.VALIDATION_FAILED, '播放地址不能为空');
  }
  const nextPriority = input.priority !== undefined ? input.priority : existing.priority;
  const nextProtocol =
    input.protocol !== undefined
      ? input.protocol
      : nextLocation.includes('.m3u8')
        ? 'hls'
        : existing.protocol;
  const nowIso = new Date().toISOString();

  Database.db
    .prepare(
      'UPDATE playback_source SET location = ?, protocol = ?, priority = ?, updated_at = ? WHERE household_id = ? AND id = ?',
    )
    .run(nextLocation, nextProtocol, nextPriority, nowIso, householdId, streamId);

  // 如果对应 source_entry 是 url 类型，同步更新 identity_digest
  const digest = createHash('sha256').update(`url:${nextLocation}`).digest('hex');
  Database.db
    .prepare(
      "UPDATE source_entry SET identity_digest = ?, last_seen_at = ? WHERE household_id = ? AND id = ? AND identity_kind = 'url'",
    )
    .run(digest, nowIso, householdId, existing.source_entry_id);

  mediaCatalogStore().bumpCatalogRevision(householdId);

  const streams = listMediaStreams(householdId, mediaId);
  const found = streams.find((s) => s.id === streamId);
  if (!found) {
    throw new DomainError(500, ProblemCode.INTERNAL, '更新线路失败');
  }
  return found;
}

/** 为频道新增一条直播源线路 */
export function addMediaStream(
  householdId: string,
  mediaId: string,
  input: AddStreamInput,
): ChannelStreamDto {
  const media = Database.db
    .prepare("SELECT id FROM media_item WHERE household_id = ? AND id = ? AND type = 'channel'")
    .get(householdId, mediaId);
  if (!media) {
    throw new DomainError(404, ProblemCode.NOT_FOUND, '未找到指定的频道');
  }

  const trimmedLoc = input.location.trim();
  if (!trimmedLoc) {
    throw new DomainError(400, ProblemCode.VALIDATION_FAILED, '播放地址不能为空');
  }

  // 寻找该频道的默认 sourceId，或者取第一个可用的 iptv 来源
  const existingSource = Database.db
    .prepare('SELECT source_id FROM playback_source WHERE household_id = ? AND media_item_id = ? LIMIT 1')
    .get(householdId, mediaId) as { source_id: string } | undefined;

  let sourceId = existingSource?.source_id;
  if (!sourceId) {
    const firstIptv = Database.db
      .prepare("SELECT id FROM media_source WHERE household_id = ? AND kind = 'iptv' LIMIT 1")
      .get(householdId) as { id: string } | undefined;
    if (!firstIptv) {
      throw new DomainError(400, ProblemCode.VALIDATION_FAILED, '未找到可用的 IPTV 来源以挂载新线路');
    }
    sourceId = firstIptv.id;
  }

  const sourceEntryId = randomUUID();
  const playbackId = randomUUID();
  const nowIso = new Date().toISOString();
  const digest = createHash('sha256').update(`url:${trimmedLoc}:${playbackId}`).digest('hex');
  const protocol = input.protocol || (trimmedLoc.includes('.m3u8') ? 'hls' : 'http');
  // 缺省权重 = 追加为末位备用线路(ASC 序:现有最大权重 +10),不因「新增一条」而顶掉
  // 当前首选;无既有线路时沿用 100 的既有缺省。显式 priority 仍以调用方为准。
  const maxExisting = Database.db
    .prepare('SELECT MAX(priority) AS maxPriority FROM playback_source WHERE household_id = ? AND media_item_id = ?')
    .get(householdId, mediaId) as { maxPriority: number | null } | undefined;
  const priority = input.priority ?? (maxExisting?.maxPriority == null ? 100 : maxExisting.maxPriority + 10);

  Database.db
    .prepare(
      `INSERT INTO source_entry (id, household_id, source_id, identity_kind, identity_digest, media_id, present, first_seen_at, last_seen_at)
       VALUES (?, ?, ?, 'url', ?, ?, 1, ?, ?)`,
    )
    .run(sourceEntryId, householdId, sourceId, digest, mediaId, nowIso, nowIso);

  Database.db
    .prepare(
      `INSERT INTO playback_source (id, household_id, source_id, source_entry_id, media_item_id, protocol, location, priority, requires_proxy, locator_kind, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, 'static', ?, ?)`,
    )
    .run(playbackId, householdId, sourceId, sourceEntryId, mediaId, protocol, trimmedLoc, priority, nowIso, nowIso);

  Database.db
    .prepare('UPDATE media_item SET version = version + 1, updated_at = ? WHERE household_id = ? AND id = ?')
    .run(nowIso, householdId, mediaId);

  mediaCatalogStore().bumpCatalogRevision(householdId);

  const streams = listMediaStreams(householdId, mediaId);
  const found = streams.find((s) => s.id === playbackId);
  if (!found) {
    throw new DomainError(500, ProblemCode.INTERNAL, '添加线路失败');
  }
  return found;
}

/** 删除频道的某条播放线路 */
export function deleteMediaStream(householdId: string, mediaId: string, streamId: string): void {
  const existing = Database.db
    .prepare('SELECT id, source_entry_id FROM playback_source WHERE household_id = ? AND media_item_id = ? AND id = ?')
    .get(householdId, mediaId, streamId) as { id: string; source_entry_id: string } | undefined;

  if (!existing) {
    throw new DomainError(404, ProblemCode.NOT_FOUND, '未找到指定的播放线路');
  }

  Database.db.transaction(() => {
    const nowIso = new Date().toISOString();

    // 1. 若有活跃会话在使用此线路，先更新状态为 interrupted 并记录 ended_at
    Database.db
      .prepare(
        `UPDATE playback_session
         SET state = 'interrupted',
             ended_at = COALESCE(ended_at, ?),
             playback_source_id = NULL
         WHERE household_id = ? AND playback_source_id = ? AND state IN ('ready', 'playing', 'paused')`,
      )
      .run(nowIso, householdId, streamId);

    // 2. 将所有引用此线路的历史会话中的外键置空，解除复合外键锁定
    Database.db
      .prepare(
        `UPDATE playback_session
         SET playback_source_id = NULL
         WHERE household_id = ? AND playback_source_id = ?`,
      )
      .run(householdId, streamId);

    // 3. 清理引用该线路的 input bindings
    Database.db
      .prepare(
        `DELETE FROM playback_input_binding
         WHERE household_id = ? AND playback_source_id = ?`,
      )
      .run(householdId, streamId);

    // 4. 删除 playback_source
    Database.db
      .prepare('DELETE FROM playback_source WHERE household_id = ? AND id = ?')
      .run(householdId, streamId);

    // 5. 删除对应的 source_entry
    Database.db
      .prepare('DELETE FROM source_entry WHERE household_id = ? AND id = ?')
      .run(householdId, existing.source_entry_id);

    // 6. 递增媒体版本与触发目录版本更新
    Database.db
      .prepare('UPDATE media_item SET version = version + 1, updated_at = ? WHERE household_id = ? AND id = ?')
      .run(nowIso, householdId, mediaId);

    mediaCatalogStore().bumpCatalogRevision(householdId);
  })();
}