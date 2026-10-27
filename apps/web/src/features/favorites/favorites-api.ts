import { privateFetch } from '../../shared/fetch';

/**
 * 收藏 API(T102,005 contracts/api.md §4 /me/favorites/channels):
 * - 全部经 privateFetch(Session 边界,same-origin Cookie;凭据档位唯一入口);
 * - 身份只由服务端从当前 Profile 推导:客户端不传任何 profileId/householdId;
 * - PUT/DELETE 幂等(204),重复操作不报错;媒体摘要含 unavailable(FR-020);
 * - 契约类型本地白名单声明(@hmp/shared 尚未收录 005 /me 契约,与服务端 DTO 逐字对齐)。
 */

/** PublicMedia 白名单摘要(个人记录可返回 unavailable) */
export interface FavoriteMediaSummary {
  readonly id: string;
  readonly type: 'channel' | 'movie' | 'series' | 'episode' | 'video';
  readonly title: string;
  readonly description: string | null;
  readonly posterRef: string | null;
  readonly contentLevel: number | null;
  readonly availability: 'available' | 'unavailable';
}

/** 节目窗口(与公共直播 Programme 同形) */
export interface ProgrammeSummary {
  readonly key: string;
  readonly title: string;
  readonly description: string | null;
  readonly startsAt: string;
  readonly endsAt: string;
}

/** GET /me/favorites/channels 条目 */
export interface FavoriteChannelItem {
  readonly media: FavoriteMediaSummary;
  /** 首次收藏时间(重复 PUT 不更新) */
  readonly createdAt: string;
  readonly current: ProgrammeSummary | null;
  readonly next: ProgrammeSummary | null;
}

export interface FavoriteChannelPage {
  readonly items: readonly FavoriteChannelItem[];
  readonly nextCursor: string | null;
}

/** 收藏频道列表(键集分页;limit 1~100,首屏 20) */
export function fetchFavoriteChannels(init: { readonly cursor?: string; readonly limit?: number; readonly signal?: AbortSignal } = {}): Promise<FavoriteChannelPage> {
  return privateFetch<FavoriteChannelPage>('/me/favorites/channels', {
    query: { cursor: init.cursor, limit: init.limit },
    signal: init.signal,
  });
}

/** 幂等收藏(重复不更新 created_at);204 */
export function putFavoriteChannel(mediaId: string, signal?: AbortSignal): Promise<void> {
  return privateFetch<void>(`/me/favorites/channels/${encodeURIComponent(mediaId)}`, {
    method: 'PUT',
    body: {},
    signal,
  });
}

/** 幂等取消收藏(已不存在仍成功;允许取消已失效频道收藏);204 */
export function deleteFavoriteChannel(mediaId: string, signal?: AbortSignal): Promise<void> {
  return privateFetch<void>(`/me/favorites/channels/${encodeURIComponent(mediaId)}`, {
    method: 'DELETE',
    signal,
  });
}
