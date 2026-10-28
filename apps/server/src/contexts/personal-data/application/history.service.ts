import { loadAvailableMediaIdSet } from '@contexts/policy';
import { toPublicMedia } from '@contexts/media-catalog';
import type { PublicMediaDto } from '@hmp/shared';
import { decodePersonalCursor, encodePersonalCursor, type PersonalCursorPayload } from '@contexts/personal-data/infrastructure/signed-cursor';
import {
  personalDataStore,
  type HistoryRow,
  type KeysetAnchor,
  type MediaItemRow,
} from '@contexts/personal-data/application/personal-data-store.port';

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
 *
 * 008-repository-extraction(T005):数据访问经 PersonalDataStore 端口(ADR-0015 D1,
 * 查询逐字迁移至 infrastructure/personal-data-store.drizzle.ts)。
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
  row: HistoryRow,
  media: MediaItemRow | undefined,
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
}): { rows: HistoryRow[]; nextCursor: string | null } {
  const identity = { householdId: input.householdId, profileId: input.profileId };
  let anchor: KeysetAnchor | null = null;
  if (input.cursor !== undefined) {
    const payload = decodePersonalCursor(input.cursor, { type: 'history', ...identity });
    anchor = { sortAt: payload.sortAt, mediaId: payload.mediaId };
  }
  const rows = personalDataStore().listHistoryRowsAfter(identity.householdId, identity.profileId, anchor, input.limit);
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
  const store = personalDataStore();
  const { rows, nextCursor } = loadHistoryPage({ ...input });
  if (rows.length === 0) {
    return { items: [], nextCursor: null };
  }
  const mediaIds = rows.map((row) => row.mediaId);
  const mediaRows = store.listMediaRowsByIds(identity.householdId, mediaIds);
  const mediaById = new Map<string, MediaItemRow>(mediaRows.map((row) => [row.id, row] as const));
  const availableIds = loadAvailableMediaIdSet(identity.householdId);
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
  const store = personalDataStore();
  const row = store.findHistoryRow(input.householdId, input.profileId, input.mediaId);
  if (row === undefined) {
    return null;
  }
  const media = store.findMediaRow(input.householdId, input.mediaId);
  const availableIds = loadAvailableMediaIdSet(input.householdId);
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
  const store = personalDataStore();
  const row = store.findHistoryRow(input.householdId, input.profileId, input.mediaId);
  if (row === undefined) {
    return 0;
  }
  const mediaRevision = store.findMediaContentRevision(input.householdId, input.mediaId);
  if (mediaRevision === undefined || mediaRevision !== row.contentRevision) {
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
