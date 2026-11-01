import { createDomainError } from '@platform/http-common/domain-error';
import { loadAvailableMediaIdSet } from '@contexts/policy';
import { mediaCatalogStore, type VodEpisodePageRow } from '@contexts/media-catalog';
import { canAttemptResumeCandidate, type ResumeCandidateReason } from '@contexts/online-vod';
import {
  personalDataStore,
  type HistoryRow,
  type KeysetAnchor,
} from '@contexts/personal-data/application/personal-data-store.port';

/**
 * 010 T046 —— 父级标题进度读取面(GET /me/vod/titles/:parentId/progress;api.md §1
 * TitleProgress/HistorySummary、§3 个人接口表「200 TitleProgress;不存在父404;自己的
 * 不可用历史仍能作为latest摘要,不泄露其他Profile」):
 *
 * - **个人查询键明确**:householdId/profileId 只从服务端当前 Session/激活 Profile 推导
 *   (与既有 /me 面同界;controller 层 SessionGuard→CurrentProfileGuard),历史读取恒按
 *   (household, profile, media) 三元组 —— 跨 Profile 历史不可见、不进共享缓存;
 * - **latest=最近实际记录**:本 Profile 对该父级子项的观看历史按 (last_viewed_at DESC,
 *   media_id DESC) 键集序首个命中行(不可用媒体的旧记录仍作为摘要返回,「不删除历史」
 *   旧义);无记录 → 三个 null;
 * - **resumeCandidate=最近未完成且可候选的本 Profile 子项**:键集序首个「未完成
 *   (completed=false)且 canAttemptResumeCandidate=true」的子项;候选判定经 T039
 *   probe 前候选函数(修订失配 content_changed/continuity_changed、completed、
 *   duration_unknown、invalid_position),不可用媒体不作为候选(接口层 'unavailable'
 *   投影,不冒充可尝试);无适合项 null;
 * - **nextEpisodeAction 来自 latest 的确定序列**:latest 子项在其线路当前修订导航序列
 *   中 ordinal+1 且两行均为 ordered(ambiguous/special/缺序不猜,缺集不跳)——仅返回
 *   {mediaId,label} 供 UI 展示,不自动播放(自动连播资格由 finish 观测独立判定);
 * - **静态 canResume 原义保留**:本文件只新增读取面,不改 history.service 的
 *   canResumeOf/readResumeFreezePosition 任何语义(005 静态续播零变化);
 * - resumeConfidence 投影:子项证据 contentVersionState verified→'verified'、
 *   unverified→'operational'、不可用/无在线证据事实→'none'(api.md 枚举
 *   operational|verified|none;不冒充上游证据等级)。
 *
 * 数据面(ADR-0015 D1,全部经各上下文仓储 seam,不直查 SQL):
 * - 父级门面/分集页行:media-catalog `findVodParentFacet` + `listVodEpisodePageRows`
 *   (线路×稳定子项×当前修订序列×子候选单查询;与公共稳定分集面同一事实源 ——
 *   「确定序列」即公共 episodes 面的 sequenceOrdinal 归一口径);
 * - 历史/证据事实:personal-data `listHistoryRowsAfter`(键集分页,命中即止的防御性
 *   扫描上限)+ `findVodEpisodeEvidenceFacts`/`findMediaContentRevision`(T040 读面);
 * - 可用性:policy `loadAvailableMediaIdSet`(与 /me/history 同一可用集合)。
 *
 * 修订比对基准(T039 同款保守投影):保存产生时快照 vs 当前事实,任一侧缺失以
 * NEVER_MATCHES_REVISION 哨兵参与比对(绝不回填历史记录;与 playback
 * vod-start-position.service 的投影先例同形)。
 */

/** 修订比对哨兵(缺失侧参与比对恒不匹配;T041 vod-start-position 同名先例) */
const NEVER_MATCHES_REVISION = -1;

/** 历史键集扫描页大小与防御性页数上限(命中即止;上限仅为失控防御,正常 1-2 页) */
const HISTORY_SCAN_PAGE_SIZE = 200;
const HISTORY_SCAN_MAX_PAGES = 50;

/** HistorySummary(api.md §1;probe 前候选形态) */
export interface VodHistorySummaryDto {
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
  readonly resumeConfidence: 'operational' | 'verified' | 'none';
  readonly revision: number;
}

/** nextEpisodeAction(仅 {mediaId,label};不自动播放) */
export interface VodNextEpisodeActionDto {
  readonly mediaId: string;
  readonly label: string;
}

/** TitleProgress(api.md §1:无记录三个null) */
export interface VodTitleProgressDto {
  readonly latest: VodHistorySummaryDto | null;
  readonly resumeCandidate: VodHistorySummaryDto | null;
  readonly nextEpisodeAction: VodNextEpisodeActionDto | null;
}

export interface VodTitleProgressInput {
  readonly householdId: string;
  readonly profileId: string;
  readonly parentMediaId: string;
}

/** 历史可信时长归一(非有限/非正 → null;不冒充保存事实) */
function historyDurationSecondsOf(row: HistoryRow): number | null {
  return row.durationSeconds !== null && Number.isFinite(row.durationSeconds) && row.durationSeconds > 0
    ? row.durationSeconds
    : null;
}

/**
 * 候选裁决输入投影(T039 canAttemptResumeCandidate;布尔化比对由调用方完成 ——
 * 修订缺失以哨兵参与,任一侧缺失即视为失配候选的保守面)。
 */
function candidateVerdictOf(input: {
  readonly row: HistoryRow;
  readonly available: boolean;
  readonly currentContentRevision: number | null;
  readonly currentContinuityRevision: number | null;
}): { readonly canAttemptResume: boolean; readonly resumeReason: ResumeCandidateReason | null } {
  // 不可用媒体不作为候选:接口层 'unavailable' 投影(T039 纯函数不产出该原因)
  if (!input.available) {
    return { canAttemptResume: false, resumeReason: 'unavailable' };
  }
  return canAttemptResumeCandidate({
    positionSeconds: input.row.positionSeconds,
    durationSeconds: historyDurationSecondsOf(input.row),
    completed: input.row.completed === 1,
    contentRevisionChanged: input.row.contentRevision !== (input.currentContentRevision ?? NEVER_MATCHES_REVISION),
    continuityRevisionChanged:
      (input.row.continuityRevision ?? NEVER_MATCHES_REVISION) !==
      (input.currentContinuityRevision ?? NEVER_MATCHES_REVISION),
  });
}

/** resumeConfidence 投影(证据等级不冒充:无事实/不可用 → none) */
function resumeConfidenceOf(input: {
  readonly available: boolean;
  readonly contentVersionState: 'unverified' | 'verified' | undefined;
}): 'operational' | 'verified' | 'none' {
  if (!input.available || input.contentVersionState === undefined) {
    return 'none';
  }
  return input.contentVersionState === 'verified' ? 'verified' : 'operational';
}

/** 历史行 + 分集页行 → HistorySummary 摘要 */
function summaryOf(input: {
  readonly row: HistoryRow;
  readonly child: VodEpisodePageRow;
  readonly parentMediaId: string;
  readonly available: boolean;
  readonly verdict: { readonly canAttemptResume: boolean; readonly resumeReason: ResumeCandidateReason | null };
  readonly contentVersionState: 'unverified' | 'verified' | undefined;
}): VodHistorySummaryDto {
  return {
    mediaId: input.row.mediaId,
    parentMediaId: input.parentMediaId,
    lineLabel: input.child.lineName,
    episodeLabel: input.child.label,
    lastViewedAt: input.row.lastViewedAt,
    positionSeconds: input.row.positionSeconds,
    durationSeconds: historyDurationSecondsOf(input.row),
    completed: input.row.completed === 1,
    canAttemptResume: input.verdict.canAttemptResume,
    resumeReason: input.verdict.resumeReason,
    resumeConfidence: resumeConfidenceOf({
      available: input.available,
      contentVersionState: input.contentVersionState,
    }),
    revision: input.row.revision,
  };
}

/**
 * nextEpisodeAction:latest 子项在线路确定序列中的 ordinal+1(两行均 ordered;
 * ambiguous/special/缺序/缺集不猜 → null)。分集页行的 sequenceOrdinal 已由 store
 * 归一(ordered 取 ordinal,其余 null),此处按行内序号精确 +1 匹配。
 */
function nextEpisodeActionOf(rows: readonly VodEpisodePageRow[], latestRow: HistoryRow): VodNextEpisodeActionDto | null {
  const latestChild = rows.find((row) => row.mediaId === latestRow.mediaId);
  if (latestChild === undefined || latestChild.sequenceOrdinal === null) {
    return null; // latest 非确定序列成员(special/ambiguous)→ 不猜下一集
  }
  const wanted = latestChild.sequenceOrdinal + 1;
  const next = rows.find(
    (row) => row.lineId === latestChild.lineId && row.sequenceOrdinal === wanted,
  );
  return next === undefined ? null : { mediaId: next.mediaId, label: next.label };
}

/**
 * GET /me/vod/titles/:parentId/progress 服务面(个人查询键=服务端推导 household+profile):
 * 父级不存在/跨家庭 → 404 MEDIA_NOT_FOUND 同形(不泄露存在性,与收藏面同码);
 * 父级存在但本 Profile 无子项历史 → {latest:null,resumeCandidate:null,nextEpisodeAction:null}。
 */
export function getVodTitleProgress(input: VodTitleProgressInput): VodTitleProgressDto {
  const store = personalDataStore();
  const catalog = mediaCatalogStore();
  // 父级门面(vod_title 物化事实;不存在/跨家庭统一 404 同形)
  const facet = catalog.findVodParentFacet(input.householdId, input.parentMediaId);
  if (facet === undefined) {
    throw createDomainError('MEDIA_NOT_FOUND');
  }
  const childRows = catalog.listVodEpisodePageRows(input.householdId, input.parentMediaId, facet.detailRevision);
  const childByMedia = new Map<string, VodEpisodePageRow>(childRows.map((row) => [row.mediaId, row] as const));
  if (childRows.length === 0) {
    return { latest: null, resumeCandidate: null, nextEpisodeAction: null };
  }
  const availableIds = loadAvailableMediaIdSet(input.householdId);

  // 历史键集序(latest_viewed_at DESC, media_id DESC)首个命中/首个可候选 —— 命中即止
  let latestRow: HistoryRow | undefined;
  let candidateRow: HistoryRow | undefined;
  let anchor: KeysetAnchor | null = null;
  for (let page = 0; page < HISTORY_SCAN_MAX_PAGES && candidateRow === undefined; page += 1) {
    const rows = store.listHistoryRowsAfter(input.householdId, input.profileId, anchor, HISTORY_SCAN_PAGE_SIZE);
    if (rows.length === 0) {
      break;
    }
    for (const row of rows) {
      if (!childByMedia.has(row.mediaId)) {
        continue;
      }
      if (latestRow === undefined) {
        latestRow = row;
      }
      // 未完成且可候选(T039 probe 前候选;completed 行直接落选)
      if (row.completed !== 1) {
        const verdict = candidateVerdictOf({
          row,
          available: availableIds.has(row.mediaId),
          currentContentRevision: store.findMediaContentRevision(input.householdId, row.mediaId) ?? null,
          currentContinuityRevision:
            store.findVodEpisodeEvidenceFacts(input.householdId, row.mediaId)?.continuityRevision ?? null,
        });
        if (verdict.canAttemptResume) {
          candidateRow = row;
          break;
        }
      }
    }
    if (rows.length < HISTORY_SCAN_PAGE_SIZE) {
      break;
    }
    const last = rows[rows.length - 1];
    if (last === undefined) {
      break;
    }
    anchor = { sortAt: last.lastViewedAt, mediaId: last.mediaId };
  }

  const summaryOfRow = (row: HistoryRow): VodHistorySummaryDto => {
    const child = childByMedia.get(row.mediaId);
    // childRows 非空且命中行均来自 childByMedia 命中;防御性兜底不触碰(不可达分支)
    if (child === undefined) {
      throw createDomainError('MEDIA_NOT_FOUND');
    }
    const available = availableIds.has(row.mediaId);
    return summaryOf({
      row,
      child,
      parentMediaId: input.parentMediaId,
      available,
      verdict: candidateVerdictOf({
        row,
        available,
        currentContentRevision: store.findMediaContentRevision(input.householdId, row.mediaId) ?? null,
        currentContinuityRevision:
          store.findVodEpisodeEvidenceFacts(input.householdId, row.mediaId)?.continuityRevision ?? null,
      }),
      contentVersionState: store.findVodEpisodeEvidenceFacts(input.householdId, row.mediaId)?.contentVersionState,
    });
  };

  return {
    latest: latestRow === undefined ? null : summaryOfRow(latestRow),
    resumeCandidate: candidateRow === undefined ? null : summaryOfRow(candidateRow),
    // 下一集 action 依 latest 的确定序列;无 latest 记录恒 null
    nextEpisodeAction: latestRow === undefined ? null : nextEpisodeActionOf(childRows, latestRow),
  };
}
