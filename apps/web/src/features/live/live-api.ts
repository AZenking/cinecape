import { publicFetch } from '../../shared/fetch';
import type { ChannelPageDto, ExperienceProgrammesDto, GroupPageDto } from '@hmp/shared';

/**
 * 直播公共数据访问(T067;005 ui.md §2、contracts/api.md §2):
 * - 全部经 shared/fetch 的 publicFetch(credentials:'omit')——公共浏览请求
 *   不携带(失效)cookie,服务端公共投影与身份无关;
 * - 错误经统一 FetchApiError(problem+json)上抛,由分区 hook 区分加载/空/失败并保留旧数据;
 * - 取消:调用方传入 AbortSignal,换分区/卸载/刷新代次更替时废止在途请求。
 */

/** 直播分区(005 contracts/api.md §2 GET /public/live/channels) */
export type LiveSection = 'now' | 'next' | 'group' | 'all';

/** 频道列表查询(section/groupKey/q/page/pageSize 全量写 URL 查询参数) */
export interface LiveChannelQuery {
  readonly section: LiveSection;
  readonly groupKey?: string;
  readonly q?: string;
  readonly page: number;
  readonly pageSize: number;
}

/** GET /public/live/groups:分组列表 + 同步快照 */
export function fetchLiveGroups(signal?: AbortSignal): Promise<GroupPageDto> {
  return publicFetch<GroupPageDto>('/public/live/groups', { signal });
}

/** GET /public/live/channels:分区频道行(含 current/next) + 同步快照 */
export function fetchLiveChannels(query: LiveChannelQuery, signal?: AbortSignal): Promise<ChannelPageDto> {
  return publicFetch<ChannelPageDto>('/public/live/channels', {
    signal,
    query: {
      section: query.section,
      groupKey: query.groupKey,
      q: query.q === '' ? undefined : query.q,
      page: query.page,
      pageSize: query.pageSize,
    },
  });
}

/** GET /public/media/{mediaId}/programmes:单频道当前/下一节目 + 同步快照 */
export function fetchChannelProgrammes(mediaId: string, signal?: AbortSignal): Promise<ExperienceProgrammesDto> {
  return publicFetch<ExperienceProgrammesDto>(`/public/media/${encodeURIComponent(mediaId)}/programmes`, { signal });
}
