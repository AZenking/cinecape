import { useAppQuery } from '../../shared/query/hooks';
import { queryKeys } from '../../shared/query/keys';
import {
  fetchHistory,
  fetchHistoryItem,
  fetchVodTitleProgress,
  type HistoryItem,
  type HistoryPage,
  type VodTitleProgress,
} from './history-api';

/**
 * 观看历史/单媒体进度数据访问 hooks(T024;006 contracts/data-access.md + query-keys.md):
 *
 * - 历史列表:useAppQuery(profile 域,浏览型 SWR 30s,键 =
 *   queryKeys.profile(pid).history({page,pageSize}));服务端契约是键集游标分页,
 *   「查看更多」的游标追加由组件层承接(键工厂只含页参,见 query-keys.md Page);
 * - 单媒体观看进度:键 = queryKeys.profile(pid).progress(id)
 *   (GET /me/history/{mediaId} → 200 HistoryItem | null;200 null 表示无记录,非 404);
 * - 010 父片聚合进度(T049):键 = queryKeys.profile(pid).vodTitleProgress(parentId)
 *   (GET /me/vod/titles/{parentId}/progress → 200 TitleProgress;仅 vod_title 父项
 *   详情启用),键恒携带 profileId 且按 Profile 隔离,切档随个人域清除;
 * - 全部经 history-api(privateFetch + signal 透传),身份未知时 enabled 关闭
 *   (FR-016:未选档不发任何 /me 请求);
 * - 进度上报(POST /playback/sessions/{id}/progress)不在此处:该链路是
 *   use-playback-progress.ts 的有序上报队列(乐观上报 + sampleSeq 幂等 +
 *   断网退避,005 research R7 契约),不适用查询缓存语义,保持独立。
 */

/**
 * 观看历史列表查询(profile 域,SWR 30s):
 * - 键携带当前 profileId(身份未知传入 null → enabled 关闭);
 * - signal 透传至 privateFetch;过期即显 + 后台刷新(SWR 缺省 30s)。
 */
export function useHistoryPageQuery(
  profileId: string | null,
  options: { readonly limit: number },
): ReturnType<typeof useAppQuery<HistoryPage>> {
  return useAppQuery<HistoryPage>({
    domain: 'profile',
    queryKey: queryKeys.profile(profileId ?? '').history({ page: 1, pageSize: options.limit }),
    queryFn: ({ signal }) => fetchHistory({ limit: options.limit, signal }),
    enabled: Boolean(profileId),
  });
}

/**
 * 单媒体观看进度查询(queryKeys.profile(pid).progress(id)):
 * - 媒体详情「继续观看」语义的数据源(200 HistoryItem 或 null,不 404);
 * - profileId/mediaId 任一未知即不启用(条件取数,FR-016)。
 */
export function useHistoryItemQuery(
  profileId: string | null,
  mediaId: string | null,
): ReturnType<typeof useAppQuery<HistoryItem | null>> {
  return useAppQuery<HistoryItem | null>({
    domain: 'profile',
    queryKey: queryKeys.profile(profileId ?? '').progress(mediaId ?? ''),
    queryFn: ({ signal }) => fetchHistoryItem(mediaId ?? '', signal),
    enabled: Boolean(profileId && mediaId),
  });
}

/**
 * 010 父片聚合进度查询(T049;queryKeys.profile(pid).vodTitleProgress(parentId)):
 * - vod_title 父详情「继续播放 X / 从头播放 / 下一集」的数据源(200 TitleProgress;
 *   无记录三键 null;父级不存在 404 → 调用方按 data undefined 静默回落无进度展示);
 * - profileId/parentMediaId 任一未知即不启用(条件取数,FR-016);standalone/单集
 *   详情传 null,零 /me/vod 请求。
 */
export function useVodTitleProgressQuery(
  profileId: string | null,
  parentMediaId: string | null,
): ReturnType<typeof useAppQuery<VodTitleProgress | null>> {
  return useAppQuery<VodTitleProgress | null>({
    domain: 'profile',
    queryKey: queryKeys.profile(profileId ?? '').vodTitleProgress(parentMediaId ?? ''),
    queryFn: ({ signal }) => fetchVodTitleProgress(parentMediaId ?? '', signal),
    enabled: Boolean(profileId && parentMediaId),
  });
}
