import { privateFetch } from '../../shared/fetch';
import type { FavoriteMediaSummary } from '../favorites/favorites-api';

/**
 * 观看历史 API(T103,005 contracts/api.md §4 /me/history):
 * - 全部经 privateFetch(Session 边界);身份由服务端从当前 Profile 推导;
 * - HistoryItem={media,lastViewedAt,positionSeconds,durationSeconds,canResume,revision};
 * - canResume 要求 available、同 content_revision、可信 duration 且 0<position<duration;
 *   无效或结尾仅从头播放(不删除历史);
 * - 无个人记录:GET /me/history/{mediaId} 返回 200 null(不是 404)。
 */

/** 契约 HistoryItem(与服务端 DTO 白名单逐字对齐) */
export interface HistoryItem {
  readonly media: FavoriteMediaSummary;
  readonly lastViewedAt: string;
  readonly positionSeconds: number;
  readonly durationSeconds: number | null;
  readonly canResume: boolean;
  readonly revision: number;
}

export interface HistoryPage {
  readonly items: readonly HistoryItem[];
  readonly nextCursor: string | null;
}

/** 历史列表(服务端 lastViewedAt 倒序 + 键集游标;首屏 20) */
export function fetchHistory(init: { readonly cursor?: string; readonly limit?: number; readonly signal?: AbortSignal } = {}): Promise<HistoryPage> {
  return privateFetch<HistoryPage>('/me/history', {
    query: { cursor: init.cursor, limit: init.limit },
    signal: init.signal,
  });
}

/** 单媒体个人历史(200 HistoryItem 或 null;进度不进公共详情 HTML) */
export function fetchHistoryItem(mediaId: string, signal?: AbortSignal): Promise<HistoryItem | null> {
  return privateFetch<HistoryItem | null>(`/me/history/${encodeURIComponent(mediaId)}`, { signal });
}

/** 最近观看时间展示文案(服务端时间已为 ISO;本地化呈现,不做排序依据) */
export function formatLastViewedAt(lastViewedAt: string): string {
  const ms = Date.parse(lastViewedAt);
  if (!Number.isFinite(ms)) {
    return lastViewedAt;
  }
  const formatter = new Intl.DateTimeFormat('zh-CN', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
  return formatter.format(new Date(ms));
}

/** 观看位置展示文案(位置缺失显示「开头」;不虚构进度) */
export function formatHistoryPosition(item: Pick<HistoryItem, 'positionSeconds' | 'durationSeconds' | 'canResume'>): string {
  if (!Number.isFinite(item.positionSeconds) || item.positionSeconds <= 0) {
    return '开头';
  }
  const minutes = Math.floor(item.positionSeconds / 60);
  if (item.durationSeconds !== null && Number.isFinite(item.durationSeconds) && item.durationSeconds > 0) {
    const totalMinutes = Math.floor(item.durationSeconds / 60);
    return `${minutes} / ${totalMinutes} 分钟`;
  }
  return `${minutes} 分钟`;
}
