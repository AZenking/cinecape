import type { ReactNode } from 'react';
import { Link, useLocation, useParams } from 'react-router';
import type { PublicMediaDto } from '@hmp/shared';
import { useAppQuery } from '../../shared/query/hooks';
import { queryKeys } from '../../shared/query/keys';
import { formatApiError } from '../../shared/query/error';
import { isFetchApiError, publicFetch } from '../../shared/fetch';
import { LoadingSpinner, RetryableAlert } from '../../shared/ui';
import { PlayButton } from '../playback/use-play-action';
import { useSession } from '../../app/session-provider';
import { useHistoryItemQuery, useVodTitleProgressQuery } from '../history/use-history';
import {
  RESUME_CONFIDENCE_LABELS,
  RESUME_REASON_LABELS,
  type VodTitleProgress,
} from '../history/history-api';
import { FavoriteStarButton } from '../favorites/favorite-star-button';
import { ParentEpisodesSection } from './parent-episodes-section';

/**
 * 公共媒体详情页(T029,US1;T103 续播入口,US4;T023 迁移:006 统一数据层;
 * 010 T033 扩展稳定父详情:detailKind/parentMediaId + StableEpisodes 分集区;
 * contracts/ui.md §1、data-model §9):
 * - 渲染 PublicMedia 白名单元数据与海报:posterRef 仅同源资源或 null,当前部署无
 *   同源海报端点(公共投影恒为 null)→ 渲染占位,绝不直接渲染任意外部 URL;
 * - 元数据对游客完全可见、不按儿童/成人策略隐藏(US1 场景2);
 * - 公共详情取数经 useAppQuery(public 域;键取自 queryKeys.public.media 工厂;
 *   signal 透传/缓存/后台刷新由数据层承担):服务端对不存在/跨家庭/不可用统一
 *   404 → 以 FetchApiError.status 404 判定,同形呈现「内容不存在」,不泄露存在性;
 *   其余失败 → 可重试失败态,文案经 formatApiError 映射链(不暴露原始报文);
 * - 010 扩展(消费 detailKind/parentMediaId,字段可选、缺省视同 standalone):
 *   vod_title 父项不可整体播放(服务端对父项 resolve 400 VOD_EPISODE_REQUIRED)
 *   → 播放入口收进分集区子项单独播放;分集经 StableEpisodes 游标分页取数并
 *   跨页按 lineRef 聚合(ParentEpisodesSection);vod_episode 提供回父片入口;
 *   父片另接 TitleProgress 聚合进度(010 T049,GET /me/vod/titles/:parentId/progress,
 *   键 = queryKeys.profile(pid).vodTitleProgress(parentId) 按 Profile 隔离):
 *   继续播放锚定 resumeCandidate 子项、从头播放恒可、nextEpisodeAction 仅展示
 *   不自动播放;候选降级原因以徽标透出,probe 后最终原因由播放器按 PlaybackDto 呈现;
 * - 个人状态(US4):仅已选档经统一数据层 useHistoryItemQuery(profile 域;键 =
 *   queryKeys.profile(pid).progress(id),identity 未知 enabled 关闭,FR-016 不发
 *   任何 /me 请求)读取本档案记录——游客与未选档不发个人请求,进度不进入公共
 *   详情 HTML(公共响应/缓存不含个人数据);查询失败(data undefined)静默回落
 *   无进度展示,公共详情不受阻(FR-009);canResume=true 展示「继续观看」
 *   (startMode=resume)与「从头播放」(startMode=beginning),二者都经统一受控
 *   播放重新授权;无效/到尾/资源变化仅从头(不越界定位);已播放但 duration
 *   未知显示「进度不可保存」(ui.md §6);频道媒体提供独立星标收藏/取消(不
 *   冒泡播放);
 * - 播放入口接入 US3 统一受控播放流程(PlayButton → usePlayAction):本页不自行
 *   发起播放、不伪造可播放承诺;不可用内容禁用并给理由。
 */

const MEDIA_TYPE_LABELS: Record<string, string> = {
  channel: '频道',
  movie: '影片',
  series: '剧集',
  episode: '单集',
  video: '视频',
};

/**
 * vod_title 父片聚合进度面板(010 T049;ui.md §1「本 Profile latest/resumeCandidate/
 * nextAction 单独查询」):继续播放锚定 resumeCandidate 的子项(服务端已判定候选,
 * 父项本身 resolve 400 VOD_EPISODE_REQUIRED,入口恒指向具体子项);从头播放恒可;
 * 降级原因(候选资格面)以徽标透出,probe 后最终原因由播放器按 PlaybackDto 呈现;
 * nextEpisodeAction 仅展示、不自动播放(手动按钮发起,api.md §1)。
 */
function VodTitleProgressPanel({
  progress,
  parentTitle,
}: {
  readonly progress: VodTitleProgress | null | undefined;
  readonly parentTitle: string;
}): ReactNode {
  const candidate = progress?.resumeCandidate ?? null;
  const latest = progress?.latest ?? null;
  const nextAction = progress?.nextEpisodeAction ?? null;
  if (candidate === null && latest === null && nextAction === null) {
    return null;
  }
  const target = candidate ?? latest;
  const targetLabel =
    target !== null && target.episodeLabel !== '' ? `${target.episodeLabel}(${parentTitle})` : parentTitle;
  return (
    <section
      data-testid="vod-title-progress"
      className="flex flex-col gap-3 rounded-lg border border-border bg-surface p-4"
    >
      <h2 className="text-sm font-medium text-foreground">观看进度</h2>
      {target !== null ? (
        <div className="flex flex-wrap items-center gap-3">
          {target.canAttemptResume ? (
            <PlayButton
              mediaId={target.mediaId}
              title={targetLabel}
              startMode="resume"
              label="继续播放"
              ariaLabel={`继续播放 ${targetLabel}`}
            />
          ) : null}
          <PlayButton
            mediaId={target.mediaId}
            title={targetLabel}
            startMode="beginning"
            label="从头播放"
            variant="secondary"
            ariaLabel={`从头播放 ${targetLabel}`}
          />
          <span className="text-xs text-muted">
            上次观看至 {Math.floor(target.positionSeconds / 60)} 分钟
            {target.episodeLabel !== '' ? `(${target.episodeLabel})` : ''}。
          </span>
          {target.completed ? (
            <span className="rounded bg-surface-secondary px-1.5 py-0.5 text-xs text-foreground">已看完</span>
          ) : null}
          {target.resumeReason !== null ? (
            <span className="rounded bg-surface-secondary px-1.5 py-0.5 text-xs text-foreground">
              {RESUME_REASON_LABELS[target.resumeReason]}
            </span>
          ) : null}
          {target.resumeConfidence !== 'none' ? (
            <span className="rounded bg-surface-secondary px-1.5 py-0.5 text-xs text-foreground">
              {RESUME_CONFIDENCE_LABELS[target.resumeConfidence]}
            </span>
          ) : null}
        </div>
      ) : null}
      {nextAction !== null ? (
        <p className="flex flex-wrap items-center gap-2 text-xs text-muted">
          <span>
            下一集:{nextAction.label}(不会自动播放,可手动开始)。
          </span>
          <PlayButton
            mediaId={nextAction.mediaId}
            title={parentTitle}
            startMode="beginning"
            label="播放下一集"
            size="sm"
            variant="outline"
            ariaLabel={`播放下一集 ${nextAction.label}`}
          />
        </p>
      ) : null}
    </section>
  );
}

/** 「内容不存在或已下架」视图:路由缺参与服务端 404 同形呈现,不泄露存在性 */
function NotFoundView(): ReactNode {
  return (
    <section className="flex flex-1 flex-col items-center justify-center gap-3 py-16 text-center">
      <h1 className="text-xl font-semibold text-foreground">内容不存在或已下架</h1>
      <p className="max-w-prose text-sm text-muted">该内容当前不可浏览,可返回点播目录查看其他内容。</p>
      <Link
        to="/vod"
        className="rounded px-1 text-sm font-medium text-accent underline-offset-4 hover:underline focus:outline-none focus-visible:ring-2 focus-visible:ring-focus"
      >
        返回点播
      </Link>
    </section>
  );
}

export function MediaDetailPage(): ReactNode {
  const { id } = useParams<{ id: string }>();
  const location = useLocation();
  const session = useSession();

  // 公共详情查询(public 域):路由 id 缺失时不发请求,直接按不存在呈现
  const hasMediaId = id !== undefined && id !== '';
  const {
    data: media,
    isPending,
    isError,
    error,
    refetch,
  } = useAppQuery<PublicMediaDto>({
    domain: 'public',
    queryKey: queryKeys.public.media(id ?? ''),
    queryFn: ({ signal }) =>
      publicFetch<PublicMediaDto>(`/public/media/${encodeURIComponent(id ?? '')}`, { signal }),
    enabled: hasMediaId,
  });

  // 个人历史(US4 T103;T023 迁移统一数据层):useHistoryItemQuery(profile 域,
  // 键 = queryKeys.profile(pid).progress(id));profileId/mediaId 任一未知即不启用
  // (游客/未选档零个人请求,FR-016);mediaId 取路由参数(与公共详情并行取数,
  // 续播面不等待公共元数据往返);失败(data undefined)静默回落为无进度展示,
  // 公共详情不受阻(与原直接 fetch 的 401/403/网络失败回落一致)。
  const profileId = session.session?.activeProfile?.id ?? null;
  const historyQuery = useHistoryItemQuery(profileId, hasMediaId ? id : null);
  const history = historyQuery.data;

  // 010 父片聚合进度(T049;仅 vod_title 父项启用,键 =
  // queryKeys.profile(pid).vodTitleProgress(parentId),按 Profile 隔离、切档随
  // 个人域清除):继续播放锚定 resumeCandidate 子项,nextEpisodeAction 仅展示;
  // 取数失败静默回落无进度展示(与单媒体历史同策略,不阻塞公共详情)。
  const titleProgress = useVodTitleProgressQuery(
    profileId,
    media?.detailKind === 'vod_title' ? media.id : null,
  ).data;

  // 单媒体降级提示(B7b/ui.md §6):已播放但 duration 未知 → 「进度不可保存」;
  // 其余候选资格不满足原因透出(仅一个提示元素,避免同词面重复命中)。
  let degradedHint: string | null = null;
  if (history != null && history.canResume !== true) {
    if (
      history.resumeReason === 'duration_unknown' ||
      (history.durationSeconds === null && history.positionSeconds > 0)
    ) {
      degradedHint = '此来源暂不支持进度保存:内容时长未知,进度不可保存。';
    } else if (history.resumeReason != null) {
      degradedHint = `上次进度不可继续(${RESUME_REASON_LABELS[history.resumeReason]}),可从头播放。`;
    }
  }

  if (!hasMediaId) {
    return <NotFoundView />;
  }

  if (isPending) {
    return <LoadingSpinner label="加载详情…" />;
  }

  if (isError) {
    // 服务端对不存在/跨家庭/不可用统一 404:同形呈现,不泄露存在性
    if (isFetchApiError(error) && error.status === 404) {
      return <NotFoundView />;
    }
    return (
      <RetryableAlert
        title="详情加载失败"
        description={formatApiError(error)}
        onRetry={() => {
          void refetch();
        }}
      />
    );
  }

  // 个人进度首轮在途时详情体一次成形(010 T049):「继续观看/从头播放/进度不可保存」
  // 等续播面依赖本 Profile 进度态,随详情首帧同帧呈现,不中途闪现(pop-in);
  // 游客/未选档(query disabled)与查询失败/离位(retry:false → isLoading=false)
  // 均直通不受阻 —— FR-009「公共详情不受阻」语义保持。
  if (historyQuery.isLoading) {
    return <LoadingSpinner label="加载详情…" />;
  }

  if (media === undefined) {
    return null; // 不可达:成功态必有数据(类型收窄辅助)
  }

  // 010 扩展:detailKind 可选(缺省视同 standalone);vod_title 父项不可整体播放,
  // 播放入口收进分集区(服务端对父项 resolve 一律 400 VOD_EPISODE_REQUIRED)
  const isVodTitleParent = media.detailKind === 'vod_title';

  return (
    <section className="flex flex-col gap-6">
      <nav aria-label="路径" className="text-sm text-muted">
        <Link
          to="/vod"
          className="rounded text-accent underline-offset-4 hover:underline focus:outline-none focus-visible:ring-2 focus-visible:ring-focus"
        >
          点播
        </Link>
        <span aria-hidden="true"> / </span>
        <span className="text-foreground">{media.title}</span>
      </nav>

      <div className="flex flex-col gap-5 sm:flex-row">
        {/* posterRef 仅同源资源或 null:为 null 渲染占位;导入的任意外部 URL 不直接渲染 */}
        <div className="flex aspect-video w-full max-w-md items-center justify-center rounded-lg border border-border bg-surface-secondary text-sm text-muted">
          {media.posterRef === null ? '暂无海报' : ''}
        </div>
        <div className="flex min-w-0 flex-col gap-3">
          <h1 className="text-2xl font-semibold text-foreground">{media.title}</h1>
          <dl className="flex flex-wrap gap-x-6 gap-y-1 text-sm text-muted">
            <div className="flex gap-1">
              <dt>类型</dt>
              <dd className="text-foreground">{MEDIA_TYPE_LABELS[media.type] ?? media.type}</dd>
            </div>
            <div className="flex gap-1">
              <dt>分级</dt>
              <dd className="text-foreground">{media.contentLevel !== null ? media.contentLevel : '未评级'}</dd>
            </div>
            <div className="flex gap-1">
              <dt>状态</dt>
              <dd className="text-foreground">{media.availability === 'available' ? '可浏览' : '不可用'}</dd>
            </div>
          </dl>
          {media.description !== null ? (
            <p className="max-w-prose text-sm leading-6 text-foreground">{media.description}</p>
          ) : null}

          {/* 播放入口(US3 统一受控播放 + US4 续播入口):
              - vod_title 父项不可整体播放,入口收进下方分集区(010 T033);
              - canResume=true:「继续观看」(resume)与「从头播放」(beginning),均经
                统一受控播放重新授权;无效/到尾/资源变化仅从头(不越界定位);
              - 不可用内容禁用并给理由;频道提供独立星标收藏/取消(不冒泡播放)。 */}
          {!isVodTitleParent ? (
            <div className="flex flex-wrap items-center gap-3">
              {media.type === 'channel' ? (
                <FavoriteStarButton
                  mediaId={media.id}
                  title={media.title}
                  favorited={(location.state as { favorited?: boolean } | null)?.favorited ?? false}
                  unavailable={media.availability !== 'available'}
                />
              ) : null}
              {media.type !== 'channel' && history?.canResume === true && media.availability === 'available' ? (
                <PlayButton
                  mediaId={media.id}
                  title={media.title}
                  startMode="resume"
                  label="继续观看"
                  ariaLabel={`继续观看 ${media.title}`}
                />
              ) : null}
              {media.type !== 'channel' && media.availability === 'available' ? (
                <PlayButton
                  mediaId={media.id}
                  title={media.title}
                  startMode="beginning"
                  label={history?.canResume === true ? '从头播放' : '播放'}
                  variant={history?.canResume === true ? 'secondary' : 'primary'}
                  ariaLabel={`${history?.canResume === true ? '从头播放' : '播放'} ${media.title}`}
                />
              ) : (
                <PlayButton
                  mediaId={media.id}
                  title={media.title}
                  disabled={media.availability !== 'available'}
                  disabledReason={media.availability !== 'available' ? '该内容当前不可用' : undefined}
                  ariaLabel={`播放 ${media.title}`}
                />
              )}
            </div>
          ) : null}
          {!isVodTitleParent && history?.canResume === true ? (
            <p className="text-xs text-muted" data-testid="detail-resume-hint">
              上次观看至 {Math.floor(history.positionSeconds / 60)} 分钟,可继续观看或从头播放。
            </p>
          ) : null}
          {!isVodTitleParent && degradedHint !== null ? (
            <p className="text-xs text-muted" data-testid="detail-resume-degraded" role="note">
              {degradedHint}
            </p>
          ) : null}
          {media.detailKind === 'vod_episode' && media.parentMediaId !== null ? (
            <p className="text-sm text-muted">
              本条目为在线剧集单集，
              <Link
                to={`/media/${media.parentMediaId}`}
                className="rounded text-accent underline-offset-4 hover:underline focus:outline-none focus-visible:ring-2 focus-visible:ring-focus"
              >
                查看父片全部集数
              </Link>
              。
            </p>
          ) : null}
        </div>
      </div>

      {/* 010 稳定父详情:StableEpisodes 游标分页,跨页按 lineRef 聚合,子项单独播放。
          key=父 id:父变化时重建分页聚合状态,不串页。 */}
      {isVodTitleParent && titleProgress != null ? (
        // 父片聚合进度(T049):继续播放锚定 resumeCandidate 子项;从头播放恒可;
        // 下一集仅展示不自动播放;降级原因以徽标透出(probe 后原因由播放器呈现)。
        <VodTitleProgressPanel progress={titleProgress} parentTitle={media.title} />
      ) : null}
      {isVodTitleParent ? (
        <ParentEpisodesSection key={media.id} parentMediaId={media.id} parentTitle={media.title} />
      ) : null}
    </section>
  );
}
