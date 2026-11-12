import { createHash, randomUUID } from 'node:crypto';
import { ProblemCode, type CandidateDto, type CandidatePageDto, type EpgBindingDto, type MediaDto } from '@hmp/shared';
import type { SessionContext } from '@platform/http-common/current-session.decorator';
import { DomainError } from '@platform/http-common/domain-error';
import { Database } from '@platform/database/database';
import { mediaCatalogStore } from '@contexts/media-catalog/application/media-catalog-store.port';
import { issueLogoRef } from '@contexts/media-catalog/domain/logo-ref';
import type { CatalogCandidateRow, MediaType } from '@contexts/policy';

/**
 * 家长候选与人工修正服务(T050;US3;013-role-differentiated-settings/ADR-0017:
 * 候选查询与人工修正属常规运维,免当次主账号密码):
 * - 判定次序(contracts/api.md「家长候选与人工修正」):owner(控制器)→ 严格 zod(控制器,400)→
 *   家庭边界(404 同形)→ 版本(409)→ 单事务写入;
 * - 候选查询是独立 owner 管线:绕过观看策略(不做 evaluatePolicy 过滤),但仍以会话 Household
 *   为唯一查询边界;复用 resource-reader 的真实可用性,含 unavailable 候选与 available 布尔;
 *   不复用 policy.batch-context(那是观看授权管线,要求 activeProfile 且按策略过滤);
 * - 人工修正与 catalog_state.revision+1 同事务;title/type 修改置对应 overridden 标志
 *   (contentLevel 修改不动标志),导入刷新据此保留人工标题/类型(data-model「media_item」节);
 * - 013 变更:原「家长验证(403 REQUIRED/FAILED/LOCKED)+ 验证后重读会话行(401)」闸门
 *   整体摘除,会话有效性由 SessionGuard 逐请求承担;高危单次密码仅保留于账号密码/
 *   主档案转移/设备撤销等不可逆操作;
 * - DTO 仅契约字段:poster=null,绝无播放地址/路径/凭据/upstream tvg-id。
 * - 018 增补:支持 visible 显隐切换与自定义 logoUrl 台标更新。
 *
 * 008-repository-extraction(T010,ADR-0015 D1):数据访问经 media-catalog 仓储端口
 * (drizzle 实现位于 infrastructure/media-catalog-store.drizzle.ts,SQL 逐字迁移)。
 */

export interface CandidateQueryInput {
  q?: string;
  type?: MediaType;
  /** 可见性切片(缺省 all;018 频道管理全量过滤修复):counts 恒在可见性过滤前统计 */
  visibility?: 'all' | 'visible' | 'hidden';
  page: number;
  pageSize: number;
}

export interface PatchMediaInput {
  expectedVersion: number;
  title?: string;
  type?: MediaType;
  contentLevel?: number | null;
  visible?: boolean;
  logoUrl?: string | null;
}

interface AdminCandidateRow extends CatalogCandidateRow {
  visible: boolean;
  posterRef: string | null;
}

function notFound(): DomainError {
  // 不存在/跨家庭统一同形,不泄漏归属与可见性
  return new DomainError(404, ProblemCode.NOT_FOUND);
}

function toCandidateDto(
  candidate: AdminCandidateRow,
  lineCount?: number,
  epgBinding?: EpgBindingDto,
  logoUrl?: string | null,
): CandidateDto {
  return {
    id: candidate.id,
    type: candidate.type,
    title: candidate.title,
    description: candidate.description,
    contentLevel: candidate.contentLevel,
    poster: null,
    version: candidate.version,
    available: candidate.available,
    visible: candidate.visible,
    logoUrl: logoUrl ?? null,
    lineCount: lineCount ?? 0,
    ...(epgBinding !== undefined ? { epgBinding } : {}),
  };
}

function matchesFilter(candidate: CatalogCandidateRow, query: { q?: string; type?: MediaType }): boolean {
  if (query.type !== undefined && candidate.type !== query.type) {
    return false;
  }
  const needle = (query.q ?? '').trim().toLowerCase();
  if (needle === '') {
    return true;
  }
  return candidate.title.toLowerCase().includes(needle);
}

/**
 * 排序规则：显示项优先展示（visible: true 排在 visible: false 之前）；
 * 同显隐状态下按 UTF-8 字节序(= SQLite BINARY collation)升序；
 * 同题按 id 升序稳定(目录同惯例)。
 */
function compareVisibleThenTitleBinaryThenId(a: AdminCandidateRow, b: AdminCandidateRow): number {
  if (a.visible !== b.visible) {
    return a.visible ? -1 : 1;
  }
  const byTitle = Buffer.compare(Buffer.from(a.title, 'utf8'), Buffer.from(b.title, 'utf8'));
  if (byTitle !== 0) {
    return byTitle;
  }
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/**
 * POST /catalog/candidates/query:owner 管线候选分页(绕过观看策略,仅限会话家庭;013 免当次密码)。
 * 先装载家庭全集(含不可用与可用性布尔),再按固定次序:
 * 基础过滤(家庭 + 关键词 + 类型)→ counts 统计 → 可见性过滤 → 稳定排序(显示优先/
 * 标题 UTF-8 字节序/id)→ 分页(不先分页后过滤)。
 * - counts.{all,visible,hidden} 恒为可见性过滤前的统计(前端三个切片的总数即真值);
 * - total 为可见性过滤后的总数(分页依据);visibility 缺省 all(向后兼容)。
 */
export async function queryCandidates(context: SessionContext, input: CandidateQueryInput): Promise<CandidatePageDto> {
  const store = mediaCatalogStore();
  const householdId = context.session.householdId;

  const rows = store.listHouseholdMediaRows(householdId);
  const availability = store.loadMediaAvailabilityFacts({ householdId });
  const candidates: AdminCandidateRow[] = rows.map((row) => ({
    id: row.id,
    type: row.type as MediaType,
    title: row.title,
    description: row.description,
    contentLevel: row.contentLevel,
    version: row.version,
    available: availability.get(row.id) === true,
    visible: row.visible !== 0,
    posterRef: row.posterRef ?? null,
  }));

  const baseFiltered = candidates.filter((candidate) => matchesFilter(candidate, input));
  const counts = {
    all: baseFiltered.length,
    visible: baseFiltered.filter((candidate) => candidate.visible).length,
    hidden: baseFiltered.filter((candidate) => !candidate.visible).length,
  };
  const filtered =
    input.visibility === undefined || input.visibility === 'all'
      ? baseFiltered
      : baseFiltered.filter((candidate) => (input.visibility === 'visible') === candidate.visible);
  filtered.sort(compareVisibleThenTitleBinaryThenId);
  const start = (input.page - 1) * input.pageSize;
  const pageItems = filtered.slice(start, start + input.pageSize);
  const pageIds = pageItems.map((item) => item.id);

  const lineCounts = store.loadMediaLineCounts(householdId, pageIds);
  const epgBindings = store.loadManualEpgBindings(householdId, pageIds);
  const logoUrls = store.loadChannelLogoUrls(householdId, pageIds);

  return {
    items: pageItems.map((candidate) =>
      toCandidateDto(
        candidate,
        lineCounts.get(candidate.id),
        epgBindings.get(candidate.id),
        logoUrls.get(candidate.id),
      ),
    ),
    total: filtered.length,
    counts,
    page: input.page,
    pageSize: input.pageSize,
  };
}

/**
 * PATCH /catalog/media/{mediaId}:人工元数据修正(013 免当次密码)。
 * 顺序:家庭边界 404 同形 → 频道跨类别转换 400(语义校验,需先读行)→ 版本 409 →
 * 同事务更新字段+version+1+overridden 标志+catalog_state.revision+1。
 * type 仅允许非频道四类互转(channel↔非频道一律 400);不建立 Series/Episode 层级关系。
 */
export async function patchMediaMetadata(mediaId: string, context: SessionContext, input: PatchMediaInput): Promise<MediaDto> {
  const householdId = context.session.householdId;

  return mediaCatalogStore().withTransaction((tx) => {
    const row = tx.findMediaItemRow(householdId, mediaId);
    if (row === undefined) {
      throw notFound();
    }
    if (input.type !== undefined && (row.type === 'channel') !== (input.type === 'channel')) {
      throw new DomainError(400, ProblemCode.VALIDATION_FAILED, '频道与非频道之间不能互相转换类型');
    }
    if (row.version !== input.expectedVersion) {
      throw new DomainError(409, ProblemCode.MEDIA_VERSION_CONFLICT, '媒体已被其他操作修改,请重新加载');
    }

    let nextPosterRef: string | null | undefined = undefined;
    if (input.logoUrl !== undefined) {
      const nowIso = new Date().toISOString();
      if (input.logoUrl === null || input.logoUrl.trim() === '') {
        nextPosterRef = null;
        Database.db
          .prepare(
            `UPDATE channel_logo
             SET upstream_url = NULL, revoked_at = ?, updated_at = ?
             WHERE household_id = ? AND media_id = ? AND revoked_at IS NULL`,
          )
          .run(nowIso, nowIso, householdId, mediaId);
      } else {
        const customUrl = input.logoUrl.trim();
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
        nextPosterRef = newRef;
      }
    }

    tx.updateMediaItemRow(householdId, mediaId, {
      ...(input.title !== undefined ? { title: input.title, titleOverridden: 1 } : {}),
      ...(input.type !== undefined ? { type: input.type, typeOverridden: 1 } : {}),
      ...(input.visible !== undefined ? { visible: input.visible ? 1 : 0 } : {}),
      ...(nextPosterRef !== undefined ? { posterRef: nextPosterRef } : {}),
      // contentLevel 修改(含 null 恢复未评级)不改 overridden 标志:普通刷新按现行导入规则覆盖分级
      ...(input.contentLevel !== undefined ? { contentLevel: input.contentLevel } : {}),
      version: row.version + 1,
      updatedAt: new Date().toISOString(),
    });
    tx.bumpCatalogRevision(householdId);

    const fresh = tx.findMediaItemRow(householdId, mediaId);
    if (fresh === undefined) {
      throw notFound();
    }
    return {
      id: fresh.id,
      type: fresh.type as MediaType,
      title: fresh.title,
      description: fresh.description,
      contentLevel: fresh.contentLevel,
      poster: null,
      version: fresh.version,
      visible: fresh.visible === 1,
      posterRef: fresh.posterRef,
    };
  });
}

export interface BatchVisibilityInput {
  mediaIds?: string[];
  all?: boolean;
  visible: boolean;
}

/** 批量修改频道显隐状态 */
export async function batchUpdateMediaVisibility(
  context: SessionContext,
  input: BatchVisibilityInput,
): Promise<{ updatedCount: number }> {
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

/** 查询频道的所有播放线路 */
export function listMediaStreams(householdId: string, mediaId: string): ChannelStreamDto[] {
  const rows = Database.db
    .prepare(
      `SELECT ps.id, ps.source_entry_id AS sourceEntryId, ps.source_id AS sourceId,
              ps.protocol, ps.location, ps.priority,
              COALESCE(ms.name, '自定义来源') AS sourceName
       FROM playback_source ps
       LEFT JOIN media_source ms ON ms.household_id = ps.household_id AND ms.id = ps.source_id
       WHERE ps.household_id = ? AND ps.media_item_id = ?
       ORDER BY ps.priority DESC, ps.created_at ASC`,
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
  const priority = input.priority ?? 100;

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
export function deleteMediaStream(
  householdId: string,
  mediaId: string,
  streamId: string,
): void {
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
