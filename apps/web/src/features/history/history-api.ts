import { privateFetch } from '../../shared/fetch';
import type { FavoriteMediaSummary } from '../favorites/favorites-api';

/**
 * 观看历史 API(T103,005 contracts/api.md §4 /me/history;010 T049 扩展):
 * - 全部经 privateFetch(Session 边界);身份由服务端从当前 Profile 推导;
 * - HistoryItem={media,lastViewedAt,positionSeconds,durationSeconds,canResume,revision};
 *   010 在线媒体在同一 DTO 上追加完成/候选续播信息(api.md §1 HistorySummary 三键面,
 *   api.md §3「GET /me/history 及 /:id 在线追加完成/候选续播信息」)——字段全部可选,
 *   静态媒体/旧响应缺省时渲染与行为零变化;
 * - canResume 要求 available、同 content_revision、可信 duration 且 0<position<duration;
 *   无效或结尾仅从头播放(不删除历史);在线媒体的 canAttemptResume 只是候选资格,
 *   最终续播资格在本次 resolve/probe 后由 startBasis/resumeDisposition 判定(api.md §1
 *   「资格区分」冻结语义),二者不互替;
 * - 无个人记录:GET /me/history/{mediaId} 返回 200 null(不是 404);
 * - GET /me/vod/titles/{parentId}/progress 返回 TitleProgress(父片聚合:latest/
 *   resumeCandidate/nextEpisodeAction;无记录三键 null),供父详情「继续播放/从头播放」。
 */

/** 010 候选续播原因(HistorySummary.resumeReason;probe 前候选形态) */
export type ResumeCandidateReason =
  | 'unavailable'
  | 'content_changed'
  | 'continuity_changed'
  | 'completed'
  | 'invalid_position'
  | 'duration_unknown';

/** 010 候选续播置信度(HistorySummary.resumeConfidence) */
export type ResumeConfidence = 'operational' | 'verified' | 'none';

/** 契约 HistoryItem(与服务端 DTO 白名单逐字对齐;010 追加字段可选,缺省=静态原义) */
export interface HistoryItem {
  readonly media: FavoriteMediaSummary;
  readonly lastViewedAt: string;
  readonly positionSeconds: number;
  readonly durationSeconds: number | null;
  readonly canResume: boolean;
  readonly revision: number;
  /** 010 扩展:本次观看已完成(完成形态,与「接近结尾」区分呈现) */
  readonly completed?: boolean;
  /** 010 扩展:候选续播资格(仅候选;最终资格以 resolve/probe 后为准) */
  readonly canAttemptResume?: boolean;
  /** 010 扩展:候选资格不满足/降级的具体原因(null=无降级原因) */
  readonly resumeReason?: ResumeCandidateReason | null;
  /** 010 扩展:候选置信度(operational=待 probe 复核;verified=已验证;none=无候选) */
  readonly resumeConfidence?: ResumeConfidence;
  /** 010 扩展:分集摘要标签(在线媒体的线路/集名;静态媒体缺省) */
  readonly lineLabel?: string | null;
  readonly episodeLabel?: string | null;
  /** 010 扩展:在线分集所属父片(静态媒体缺省 null) */
  readonly parentMediaId?: string | null;
}

/** 010 HistorySummary(api.md §1;TitleProgress/latest/resumeCandidate 元素形态) */
export interface HistorySummary {
  readonly mediaId: string;
  readonly parentMediaId: string;
  readonly lineLabel: string;
  readonly episodeLabel: string;
  readonly lastViewedAt: string;
  readonly positionSeconds: number;
  readonly durationSeconds: number | null;
  readonly completed: boolean;
  readonly canAttemptResume: boolean;
  readonly resumeReason: ResumeCandidateReason | null;
  readonly resumeConfidence: ResumeConfidence;
  readonly revision: number;
}

/** 010 NextEpisodeAction(仅 {mediaId,label};展示不自动播放) */
export interface NextEpisodeAction {
  readonly mediaId: string;
  readonly label: string;
}

/** 010 TitleProgress(api.md §1:无记录三个 null) */
export interface VodTitleProgress {
  readonly latest: HistorySummary | null;
  readonly resumeCandidate: HistorySummary | null;
  readonly nextEpisodeAction: NextEpisodeAction | null;
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

/**
 * 010 父片聚合进度(T046 服务端已上线;T049 前端接入):
 * GET /me/vod/titles/{parentId}/progress → 200 TitleProgress(身份服务端推导,
 * 不接受任何 body/query 身份声明;父级不存在 404 由调用方静默回落无进度展示)。
 */
export function fetchVodTitleProgress(parentMediaId: string, signal?: AbortSignal): Promise<VodTitleProgress> {
  return privateFetch<VodTitleProgress>(`/me/vod/titles/${encodeURIComponent(parentMediaId)}/progress`, {
    signal,
  });
}

/** 候选续播原因徽标文案(ui.md §1/§6;B7b「进度不可保存」词面取自 ui.md §6) */
export const RESUME_REASON_LABELS: Record<ResumeCandidateReason, string> = {
  unavailable: '内容暂不可用',
  content_changed: '内容已变化',
  continuity_changed: '线路已变化',
  completed: '已看完',
  invalid_position: '上次位置无效',
  duration_unknown: '进度不可保存',
};

/** 候选置信度徽标文案(none=无候选不渲染;operational 仅候选资格、以 probe 为准) */
export const RESUME_CONFIDENCE_LABELS: Record<Exclude<ResumeConfidence, 'none'>, string> = {
  operational: '续播待确认',
  verified: '可续播',
};

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
