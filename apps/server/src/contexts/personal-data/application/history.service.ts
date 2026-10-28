import { and, asc, desc, eq, sql } from 'drizzle-orm';
import { createDomainError } from '@platform/http-common/domain-error';
import { getDb } from '@contexts/identity-access/infrastructure/db';
import { mediaItem, profileViewingHistory, type ProfileViewingHistory } from '@platform/database/schema';
import { loadAvailableMediaIdSet } from '@contexts/policy/application/policy.batch-context';
import { toPublicMedia } from '@contexts/media-catalog/domain/public-media-projection';
import type { PublicMediaDto } from '@hmp/shared';
import { decodePersonalCursor, encodePersonalCursor, type PersonalCursorPayload } from '@contexts/personal-data/infrastructure/signed-cursor';

/**
 * 观看历史查询与续播冻结读取(T101,005 contracts/api.md §4/§5、data-model.md §7):
 *
 * - GET /me/history:按服务端 last_viewed_at/id 倒序键集分页(索引同顺序),
 *   HistoryItem={media,lastViewedAt,positionSeconds,durationSeconds,canResume,revision};
 * - GET /me/history/{mediaId}:HistoryItem 或 200 null;已不可用媒体仍返回本 Profile
 *   自己的摘要(unavailable),不公开 writer epoch/当前写入会话标识;
 * - canResume 要求 available、同 content_revision、可信 duration 且 0<position<duration;
 *   无效/结尾仅从头播放(不删除历史);
 * - resume 冻结读取(readResumeFreeze):可信 probe 完成后、转换输出启动前由 resolve
 *   侧调用 —— 返回本次启动应冻结的 presentationStartSeconds(0 = 从头),不信任任何
 *   客户端位置声明;ready 提交仅重验,不改变已冻结输出(冻结值由调用方持有)。
 */

/** 契约 HistoryItem */
export interface HistoryItemDto {
  readonly media: PublicMediaDto;
  readonly lastViewedAt: string;
  readonly positionSeconds: number;
  readonly durationSeconds: number | null;
  readonly canResume: boolean;
  readonly revision: number;
}

export interface HistoryPage {
  readonly items: readonly HistoryItemDto[];
  readonly nextCursor: string | null;
}

/** canResume 判定唯一实现(服务内部与续播冻结共用同一规则) */
export function canResumeOf(input: {
  readonly available: boolean;
  readonly currentRevision: number;
  readonly historyRevision: number;
  readonly positionSeconds: number;
  readonly durationSeconds: number | null;
}): boolean {
  if (!input.available) {
    return false;
  }
  if (input.historyRevision !== input.currentRevision) {
    return false; // content_revision 不匹配 → 禁止续播,允许从头
  }
  if (input.durationSeconds === null || !Number.isFinite(input.durationSeconds) || input.durationSeconds <= 0) {
    return false; // 无已知可信 duration
  }
  const position = input.positionSeconds;
  if (!Number.isFinite(position) || position <= 0) {
    return false; // 非有限/零位置不续播
  }
  if (position >= input.durationSeconds) {
    return false; // 已到结尾
  }
  return true;
}

function toHistoryItem(
  row: ProfileViewingHistory,
  media: typeof mediaItem.$inferSelect | undefined,
  available: boolean,
): HistoryItemDto {
  const durationSeconds = row.durationSeconds !== null && Number.isFinite(row.durationSeconds) ? row.durationSeconds : null;
  return {
    media: toPublicMedia({
      id: row.mediaId,
      type: media?.type ?? 'movie',
      title: media?.title ?? '',
      description: media?.description ?? null,
      posterRef: media?.posterRef ?? null,
      contentLevel: media?.contentLevel ?? null,
      available,
    }),
    lastViewedAt: row.lastViewedAt,
    positionSeconds: row.positionSeconds,
    durationSeconds,
    canResume: canResumeOf({
      available,
      currentRevision: media?.contentRevision ?? 0,
      historyRevision: row.contentRevision,
      positionSeconds: row.positionSeconds,
      durationSeconds,
    }),
    revision: row.revision,
  };
}

/** 批量装填历史页(键集 (last_viewed_at DESC, media_id DESC)) */
function loadHistoryPage(input: {
  readonly householdId: string;
  readonly profileId: string;
  readonly cursor?: string;
  readonly limit: number;
}): { rows: ProfileViewingHistory[]; nextCursor: string | null } {
  const identity = { householdId: input.householdId, profileId: input.profileId };
  const db = getDb();
  let anchor: { sortAt: string; mediaId: string } | null = null;
  if (input.cursor !== undefined) {
    const payload = decodePersonalCursor(input.cursor, { type: 'history', ...identity });
    anchor = { sortAt: payload.sortAt, mediaId: payload.mediaId };
  }
  const predicate =
    anchor === null
      ? and(eq(profileViewingHistory.householdId, identity.householdId), eq(profileViewingHistory.profileId, identity.profileId))
      : and(
          eq(profileViewingHistory.householdId, identity.householdId),
          eq(profileViewingHistory.profileId, identity.profileId),
          sql`(${profileViewingHistory.lastViewedAt} < ${anchor.sortAt} OR (${profileViewingHistory.lastViewedAt} = ${anchor.sortAt} AND ${profileViewingHistory.mediaId} < ${anchor.mediaId}))`,
        );
  const rows = db
    .select()
    .from(profileViewingHistory)
    .where(predicate)
    .orderBy(desc(profileViewingHistory.lastViewedAt), desc(profileViewingHistory.mediaId))
    .limit(input.limit)
    .all();
  let nextCursor: string | null = null;
  if (rows.length === input.limit && rows.length > 0) {
    const last = rows[rows.length - 1];
    if (last !== undefined) {
      const payload: PersonalCursorPayload = {
        type: 'history',
        householdId: identity.householdId,
        profileId: identity.profileId,
        sortAt: last.lastViewedAt,
        mediaId: last.mediaId,
      };
      nextCursor = encodePersonalCursor(payload);
    }
  }
  return { rows, nextCursor };
}

/** GET /me/history */
export function listHistory(input: {
  readonly householdId: string;
  readonly profileId: string;
  readonly cursor?: string;
  readonly limit: number;
}): HistoryPage {
  const identity = { householdId: input.householdId, profileId: input.profileId };
  const db = getDb();
  const { rows, nextCursor } = loadHistoryPage({ ...input });
  if (rows.length === 0) {
    return { items: [], nextCursor: null };
  }
  const mediaIds = rows.map((row) => row.mediaId);
  const mediaRows = db
    .select()
    .from(mediaItem)
    .where(
      and(
        eq(mediaItem.householdId, identity.householdId),
        sql`${mediaItem.id} IN (${sql.join(mediaIds.map((id) => sql`${id}`), sql`, `)})`,
      ),
    )
    .all();
  const mediaById = new Map(mediaRows.map((row) => [row.id, row] as const));
  const availableIds = loadAvailableMediaIdSet(db, identity.householdId);
  return {
    items: rows.map((row) => toHistoryItem(row, mediaById.get(row.mediaId), availableIds.has(row.mediaId))),
    nextCursor,
  };
}

/** GET /me/history/{mediaId}:无个人记录 → null(200);不公开 writer 标识 */
export function getHistoryItem(input: {
  readonly householdId: string;
  readonly profileId: string;
  readonly mediaId: string;
}): HistoryItemDto | null {
  const db = getDb();
  const row = db
    .select()
    .from(profileViewingHistory)
    .where(
      and(
        eq(profileViewingHistory.householdId, input.householdId),
        eq(profileViewingHistory.profileId, input.profileId),
        eq(profileViewingHistory.mediaId, input.mediaId),
      ),
    )
    .get();
  if (row === undefined) {
    return null;
  }
  const media = db
    .select()
    .from(mediaItem)
    .where(and(eq(mediaItem.householdId, input.householdId), eq(mediaItem.id, input.mediaId)))
    .get();
  const availableIds = loadAvailableMediaIdSet(db, input.householdId);
  return toHistoryItem(row, media, availableIds.has(input.mediaId));
}

/**
 * 续播冻结读取(api.md §5 resolve:probe 完成后、转换输出启动前由服务端重读当前
 * Profile 历史冻结 presentationStartSeconds)。返回 0 表示从头;永不删除旧历史;
 * 缺少或无效位置一律从头。probeDuration 为本次 probe 的可信时长(历史无 duration 时
 * 以其为界;两者皆无 → 无可信 duration,从头)。
 */
export function readResumeFreezePosition(input: {
  readonly householdId: string;
  readonly profileId: string;
  readonly mediaId: string;
  readonly probeDurationSeconds: number | null;
}): number {
  const db = getDb();
  const row = db
    .select()
    .from(profileViewingHistory)
    .where(
      and(
        eq(profileViewingHistory.householdId, input.householdId),
        eq(profileViewingHistory.profileId, input.profileId),
        eq(profileViewingHistory.mediaId, input.mediaId),
      ),
    )
    .get();
  if (row === undefined) {
    return 0;
  }
  const media = db
    .select({ contentRevision: mediaItem.contentRevision })
    .from(mediaItem)
    .where(and(eq(mediaItem.householdId, input.householdId), eq(mediaItem.id, input.mediaId)))
    .get();
  if (media === undefined || media.contentRevision !== row.contentRevision) {
    return 0; // 资源修订变化:不继承旧位置(旧历史保留)
  }
  const candidates = [row.durationSeconds, input.probeDurationSeconds].filter(
    (value): value is number => value !== null && Number.isFinite(value) && value > 0,
  );
  const trustedDuration = candidates.length > 0 ? Math.min(...candidates) : null;
  const position = row.positionSeconds;
  if (trustedDuration === null || !Number.isFinite(position) || position <= 0 || position >= trustedDuration) {
    return 0;
  }
  return position;
}

/* 供单测/夹具使用的直读辅助(不进入 HTTP 面) */
export function readHistoryRow(
  householdId: string,
  profileId: string,
  mediaId: string,
): ProfileViewingHistory | undefined {
  return getDb()
    .select()
    .from(profileViewingHistory)
    .where(
      and(
        eq(profileViewingHistory.householdId, householdId),
        eq(profileViewingHistory.profileId, profileId),
        eq(profileViewingHistory.mediaId, mediaId),
      ),
    )
    .get();
}

export function listHistoryRowsOldestFirst(householdId: string, profileId: string): ProfileViewingHistory[] {
  return getDb()
    .select()
    .from(profileViewingHistory)
    .where(and(eq(profileViewingHistory.householdId, householdId), eq(profileViewingHistory.profileId, profileId)))
    .orderBy(asc(profileViewingHistory.lastViewedAt))
    .all();
}

export function upsertHistoryRowForFixture(input: {
  readonly householdId: string;
  readonly profileId: string;
  readonly mediaId: string;
  readonly writerEpoch: number;
  readonly writerPlaybackSessionId: string;
  readonly lastSampleSeq: number;
  readonly contentRevision: number;
  readonly positionSeconds: number;
  readonly durationSeconds: number | null;
  readonly lastViewedAt: string;
  readonly revision: number;
}): void {
  getDb()
    .insert(profileViewingHistory)
    .values({
      householdId: input.householdId,
      profileId: input.profileId,
      mediaId: input.mediaId,
      writerEpoch: input.writerEpoch,
      writerPlaybackSessionId: input.writerPlaybackSessionId,
      lastSampleSeq: input.lastSampleSeq,
      contentRevision: input.contentRevision,
      positionSeconds: input.positionSeconds,
      durationSeconds: input.durationSeconds,
      lastViewedAt: input.lastViewedAt,
      revision: input.revision,
    })
    .onConflictDoUpdate({
      target: [profileViewingHistory.householdId, profileViewingHistory.profileId, profileViewingHistory.mediaId],
      set: {
        writerEpoch: input.writerEpoch,
        writerPlaybackSessionId: input.writerPlaybackSessionId,
        lastSampleSeq: input.lastSampleSeq,
        contentRevision: input.contentRevision,
        positionSeconds: input.positionSeconds,
        durationSeconds: input.durationSeconds,
        lastViewedAt: input.lastViewedAt,
        revision: input.revision,
      },
    })
    .run();
}

/** 非法媒体定位统一 404 同形(不存在/跨家庭不可区分) */
export function mediaNotFound(): never {
  throw createDomainError('MEDIA_NOT_FOUND');
}
