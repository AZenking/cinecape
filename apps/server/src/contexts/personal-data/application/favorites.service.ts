import { and, asc, desc, eq, sql } from 'drizzle-orm';
import { DomainError, createDomainError } from '../../../common/domain-error';
import { getDb } from '../../../modules/auth/db';
import {
  mediaItem,
  profileChannelFavorite,
  type ProfileChannelFavorite,
} from '../../../database/schema';
import { loadAvailableMediaIdSet } from '@contexts/policy/application/policy.batch-context';
import { loadLiveChannelWindows, type LiveChannelProjection } from '@contexts/live-tv/application/live-projection.service';
import { toPublicMedia } from '@contexts/media-catalog/domain/public-media-projection';
import type { ExperienceProgrammeDto, PublicMediaDto } from '@hmp/shared';
import { decodePersonalCursor, encodePersonalCursor, type PersonalCursorPayload } from '@contexts/personal-data/infrastructure/signed-cursor';

/**
 * 收藏服务(T098,005 contracts/api.md §4、data-model.md §4):
 *
 * - 主键 (household_id,profile_id,media_id);媒体必须为 channel 且添加时可用;
 *   「created_at 首次收藏固定,重复 PUT 不更新;DELETE 不存在也 204,取消后重新
 *   收藏为新时间」—— INSERT OR IGNORE 保持首行(幂等),DELETE 直接删(幂等);
 * - 列表按 (created_at DESC,media_id DESC) 键集分页;索引同顺序
 *   (profile_channel_favorite_profile_listed_key),signed cursor 绑定
 *   家庭/Profile/列表类型(signed-cursor.ts);不可用频道保留关系并返回
 *   unavailable 摘要,可取消但不可播放;
 * - 身份只从服务端当前 Profile 推导(控制器经 CurrentProfileGuard 注入),
 *   不接受任何 body/query 身份声明。
 */

/** 收藏列表页(契约 GET /me/favorites/channels) */
export interface FavoriteChannelItem {
  readonly media: PublicMediaDto;
  /** 首次收藏时间(重复 PUT 不更新) */
  readonly createdAt: string;
  readonly current: ExperienceProgrammeDto | null;
  readonly next: ExperienceProgrammeDto | null;
}

export interface FavoriteChannelPage {
  readonly items: readonly FavoriteChannelItem[];
  /** null = 没有更多;非空 = 下一页 signed cursor */
  readonly nextCursor: string | null;
}

/** 键集分页键(created_at DESC,media_id DESC) */
interface KeysetKey {
  readonly sortAt: string;
  readonly mediaId: string;
}

function keyOfFavorite(row: ProfileChannelFavorite): KeysetKey {
  return { sortAt: row.createdAt, mediaId: row.mediaId };
}

/** 下一页游标(仅当本页取满 limit 时才可能还有更多) */
function nextCursorFor(
  rows: readonly ProfileChannelFavorite[],
  limit: number,
  identity: { readonly householdId: string; readonly profileId: string },
): string | null {
  if (rows.length < limit) {
    return null;
  }
  const last = rows[rows.length - 1];
  if (last === undefined) {
    return null;
  }
  const key = keyOfFavorite(last);
  const payload: PersonalCursorPayload = {
    type: 'favorites',
    householdId: identity.householdId,
    profileId: identity.profileId,
    sortAt: key.sortAt,
    mediaId: key.mediaId,
  };
  return encodePersonalCursor(payload);
}

/** GET /me/favorites/channels:键集分页 + unavailable 摘要 + current/next */
export function listFavoriteChannels(input: {
  readonly householdId: string;
  readonly profileId: string;
  readonly cursor?: string;
  readonly limit: number;
}): FavoriteChannelPage {
  const identity = { householdId: input.householdId, profileId: input.profileId };
  const db = getDb();
  let anchor: KeysetKey | null = null;
  if (input.cursor !== undefined) {
    const payload = decodePersonalCursor(input.cursor, { type: 'favorites', ...identity });
    anchor = { sortAt: payload.sortAt, mediaId: payload.mediaId };
  }
  const predicate = anchor === null
    ? and(
        eq(profileChannelFavorite.householdId, identity.householdId),
        eq(profileChannelFavorite.profileId, identity.profileId),
      )
    : and(
        eq(profileChannelFavorite.householdId, identity.householdId),
        eq(profileChannelFavorite.profileId, identity.profileId),
        // 键集:(created_at, media_id) 双列 DESC 严格后继
        sql`(${profileChannelFavorite.createdAt} < ${anchor.sortAt} OR (${profileChannelFavorite.createdAt} = ${anchor.sortAt} AND ${profileChannelFavorite.mediaId} < ${anchor.mediaId}))`,
      );
  const rows = db
    .select()
    .from(profileChannelFavorite)
    .where(predicate)
    .orderBy(desc(profileChannelFavorite.createdAt), desc(profileChannelFavorite.mediaId))
    .limit(input.limit)
    .all();
  if (rows.length === 0) {
    return { items: [], nextCursor: null };
  }

  // 媒体摘要(unavailable 保留)+ 可用性 + current/next(复用直播批量投影,查询次数固定)
  const mediaIds = rows.map((row) => row.mediaId);
  const mediaRows = db
    .select()
    .from(mediaItem)
    .where(and(eq(mediaItem.householdId, identity.householdId), sql`${mediaItem.id} IN (${sql.join(mediaIds.map((id) => sql`${id}`), sql`, `)} )`))
    .all();
  const mediaById = new Map(mediaRows.map((row) => [row.id, row] as const));
  const availableIds = loadAvailableMediaIdSet(db, identity.householdId);
  const projections = new Map<string, LiveChannelProjection>(
    loadLiveChannelWindows(identity.householdId, Date.now(), { mediaIds, includeProgrammes: true }).map(
      (projection) => [projection.mediaId, projection] as const,
    ),
  );

  const items = rows.map((row) => {
    const media = mediaById.get(row.mediaId);
    const projection = projections.get(row.mediaId);
    const publicMedia = toPublicMedia({
      id: row.mediaId,
      type: media?.type ?? 'channel',
      title: media?.title ?? '',
      description: media?.description ?? null,
      posterRef: media?.posterRef ?? null,
      contentLevel: media?.contentLevel ?? null,
      available: availableIds.has(row.mediaId),
    });
    return {
      media: publicMedia,
      createdAt: row.createdAt,
      current: projection?.current ?? null,
      next: projection?.next ?? null,
    } satisfies FavoriteChannelItem;
  });
  return { items, nextCursor: nextCursorFor(rows, input.limit, identity) };
}

/**
 * PUT /me/favorites/channels/{mediaId}:幂等添加。
 * - 不存在/跨家庭 → 404 MEDIA_NOT_FOUND 同形(不泄露跨家庭存在性);
 * - 非频道或不可用 → 400 VALIDATION_FAILED;
 * - INSERT OR IGNORE:重复 PUT 不更新 created_at(幂等,不报错)。
 */
export function addFavoriteChannel(input: {
  readonly householdId: string;
  readonly profileId: string;
  readonly mediaId: string;
  readonly at?: string;
}): void {
  const db = getDb();
  const media = db
    .select({ id: mediaItem.id, type: mediaItem.type })
    .from(mediaItem)
    .where(and(eq(mediaItem.householdId, input.householdId), eq(mediaItem.id, input.mediaId)))
    .get();
  if (media === undefined) {
    throw createDomainError('MEDIA_NOT_FOUND');
  }
  if (media.type !== 'channel') {
    throw new DomainError(400, 'VALIDATION_FAILED', '仅频道可以收藏');
  }
  const availableIds = loadAvailableMediaIdSet(db, input.householdId);
  if (!availableIds.has(input.mediaId)) {
    throw new DomainError(400, 'VALIDATION_FAILED', '不可用频道暂不能收藏');
  }
  const createdAt = input.at ?? new Date().toISOString();
  db.transaction((tx) => {
    // INSERT OR IGNORE:主键三元组冲突时保留首行(created_at 首次收藏固定)
    tx.insert(profileChannelFavorite)
      .values({
        householdId: input.householdId,
        profileId: input.profileId,
        mediaId: input.mediaId,
        createdAt,
      })
      .onConflictDoNothing()
      .run();
  });
}

/**
 * DELETE /me/favorites/channels/{mediaId}:幂等取消。
 * 已不存在仍 204;允许取消已失效频道收藏(不校验可用性/类型,仅按主键删除)。
 */
export function removeFavoriteChannel(input: {
  readonly householdId: string;
  readonly profileId: string;
  readonly mediaId: string;
}): void {
  getDb()
    .delete(profileChannelFavorite)
    .where(
      and(
        eq(profileChannelFavorite.householdId, input.householdId),
        eq(profileChannelFavorite.profileId, input.profileId),
        eq(profileChannelFavorite.mediaId, input.mediaId),
      ),
    )
    .run();
}

/* 测试/诊断只读辅助(导出供单测复核主键三元组与首收藏时间固定) */
export function readFavoriteRow(
  householdId: string,
  profileId: string,
  mediaId: string,
): ProfileChannelFavorite | undefined {
  return getDb()
    .select()
    .from(profileChannelFavorite)
    .where(
      and(
        eq(profileChannelFavorite.householdId, householdId),
        eq(profileChannelFavorite.profileId, profileId),
        eq(profileChannelFavorite.mediaId, mediaId),
      ),
    )
    .get();
}

export function listFavoriteRowsOldestFirst(householdId: string, profileId: string): ProfileChannelFavorite[] {
  return getDb()
    .select()
    .from(profileChannelFavorite)
    .where(and(eq(profileChannelFavorite.householdId, householdId), eq(profileChannelFavorite.profileId, profileId)))
    .orderBy(asc(profileChannelFavorite.createdAt))
    .all();
}

