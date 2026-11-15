import type { ReactNode } from 'react';
import { useLocation, useNavigate, useParams } from 'react-router';
import { Button, Card, Chip } from '@heroui/react';
import { ArrowLeft, Play, Star } from 'lucide-react';
import type { ChannelPageDto, ChannelRowDto } from '@hmp/shared';
import { formatRangeInZone } from '../live/live-format';
import { fetchLiveChannels } from '../live/live-api';
import { serverNowMs } from '../../shared/time/server-clock';
import { usePlayAction } from '../playback/use-play-action';
import { useSession } from '../../app/session-provider';
import { useAuthAction } from '../../app/action-coordinator';
import { useAppQuery } from '../../shared/query/hooks';
import { queryKeys } from '../../shared/query/keys';
import { useFavoriteState, useFavoriteToggleMutation } from '../favorites/use-favorites';
import { useAppToast } from '../../shared/ui';
import { ProgrammePoster } from './programme-poster';

/**
 * 节目单详情页(非直播节目)。
 *
 * 跳转规则(产品要求):
 * - 正在直播的节目不走本页 —— 由入口直接拉起播放器;
 * - 非直播(即将开始/已结束/无节目)进入本页;本页提供「收藏频道 / 播放当前频道」
 *   两个操作,以及「推荐」频道横排。/live/guide 页面自身不调整,仍保留抽屉交互。
 *
 * 布局(按手稿,2026-11-15):两栏主卡 —— 左 16:9 海报(缺省回退频道台标/首字),
 * 右侧 TITLE / subtitle + 收藏、播放两个按钮;下方「推荐」四列频道卡。
 *
 * 数据来自入口路由 state(节目/频道信息由列表页携带);直接刷新或深链进入时
 * 没有 state,显示「节目信息已过期」并提供返回入口,不臆造节目内容。
 */
export interface ProgrammeDetailNavState {
  readonly channelTitle: string;
  readonly channelPosterRef: string | null;
  readonly groupLabel: string;
  /** 家庭时区(展示时段;入口宿主传入) */
  readonly timezone: string;
  readonly programme: {
    readonly title: string;
    readonly description: string | null;
    readonly posterRef: string | null;
    readonly startsAt: string;
    readonly endsAt: string;
  } | null;
}

type DetailStatus = 'now' | 'upcoming' | 'ended' | 'none';

const STATUS_LABEL: Record<DetailStatus, string> = {
  now: '正在直播',
  upcoming: '即将开始',
  ended: '已结束',
  none: '暂无节目数据',
};

const STATUS_COLOR: Record<DetailStatus, 'success' | 'warning' | 'default'> = {
  now: 'success',
  upcoming: 'warning',
  ended: 'default',
  none: 'default',
};

/** 服务端基准钟 + 节目窗口 → 四状态(入口已按该规则分流,这里只做展示兜底) */
function statusOf(programme: ProgrammeDetailNavState['programme']): DetailStatus {
  if (programme === null) {
    return 'none';
  }
  const now = serverNowMs() ?? Date.now();
  const start = Date.parse(programme.startsAt);
  const end = Date.parse(programme.endsAt);
  if (!Number.isFinite(start) || !Number.isFinite(end)) {
    return 'none';
  }
  if (now < start) {
    return 'upcoming';
  }
  return now < end ? 'now' : 'ended';
}

/** 推荐频道卡:台标 + 频道名 + 当前节目;点击经统一入口播放该频道当前直播 */
function RecommendCard({ row, onPlay }: { readonly row: ChannelRowDto; readonly onPlay: (row: ChannelRowDto) => void }): ReactNode {
  const current = row.current;
  return (
    <button
      type="button"
      aria-label={`播放 ${row.media.title} 当前直播`}
      onClick={() => {
        onPlay(row);
      }}
      className="group/recommend flex min-w-0 flex-col gap-2 rounded-xl border border-border/60 bg-surface p-2.5 text-left transition-colors hover:border-accent/50 hover:bg-surface-secondary/60 focus:outline-none focus-visible:ring-2 focus-visible:ring-focus"
    >
      <span className="relative flex aspect-video w-full items-center justify-center overflow-hidden rounded-lg bg-surface-secondary/70">
        {row.media.posterRef !== null ? (
          <img
            src={`/api/public/media/logos/${encodeURIComponent(row.media.posterRef)}`}
            alt=""
            aria-hidden="true"
            className="h-2/3 w-2/3 object-contain"
          />
        ) : (
          <span className="text-xl font-black text-muted/40">{row.media.title.slice(0, 1).toUpperCase()}</span>
        )}
        <span aria-hidden="true" className="absolute left-2 top-2 size-1.5 rounded-full bg-accent" />
      </span>
      <span className="flex min-w-0 flex-col gap-0.5">
        <span className="hmp-truncate text-xs font-medium text-foreground">{row.media.title}</span>
        <span className="hmp-truncate text-2xs text-muted">{current !== null ? current.title : '暂无节目单'}</span>
      </span>
    </button>
  );
}

export function ProgrammeDetailPage(): ReactNode {
  const location = useLocation();
  const navigate = useNavigate();
  const params = useParams();
  const { play } = usePlayAction();
  const session = useSession();
  const { startLogin } = useAuthAction();
  const toast = useAppToast();
  const state = (location.state ?? null) as ProgrammeDetailNavState | null;
  const programme = state?.programme ?? null;
  const status = statusOf(programme);
  const mediaId = params.channelId ?? '';

  const activeProfileId = session.status === 'authenticated' ? (session.session?.activeProfile?.id ?? null) : null;
  const favorited = useFavoriteState(activeProfileId, mediaId === '' ? null : mediaId, mediaId !== '');
  const favoriteToggle = useFavoriteToggleMutation(activeProfileId, {
    id: mediaId,
    title: state?.channelTitle ?? '',
    unavailable: false,
  });

  // 推荐:正在直播的前 4 个频道(排除当前频道),复用公共直播分区接口
  const recommendResource = useAppQuery<ChannelPageDto>({
    domain: 'public',
    queryKey: queryKeys.public.liveChannels({ section: 'now', page: 1, pageSize: 6 }),
    queryFn: ({ signal }) => fetchLiveChannels({ section: 'now', page: 1, pageSize: 6 }, signal),
  });
  const recommendations = (recommendResource.data?.items ?? []).filter((row) => row.media.id !== mediaId).slice(0, 4);

  if (state === null) {
    return (
      <div className="mx-auto flex w-full max-w-xl flex-col items-start gap-4 py-10">
        <h1 className="text-lg font-semibold text-foreground">节目信息已过期</h1>
        <p className="text-sm text-muted">该节目详情需要通过节目单或直播列表进入。</p>
        <Button variant="secondary" onPress={() => void navigate('/live')}>
          返回直播
        </Button>
      </div>
    );
  }

  const durationMinutes =
    programme === null
      ? null
      : Math.max(1, Math.round((Date.parse(programme.endsAt) - Date.parse(programme.startsAt)) / 60_000));
  const rangeLabel =
    programme === null ? null : formatRangeInZone(programme.startsAt, programme.endsAt, state.timezone);
  const subtitle = [state.channelTitle, rangeLabel, durationMinutes !== null ? `${durationMinutes} 分钟` : null]
    .filter((part): part is string => part !== null && part !== '')
    .join(' · ');

  const playCurrentChannel = (): void => {
    play({ mediaId, title: state.channelTitle, startMode: 'beginning', posterRef: state.channelPosterRef ?? undefined });
  };

  return (
    <div className="mx-auto flex w-full max-w-5xl flex-col gap-6">
      <Button variant="ghost" size="sm" className="self-start" aria-label="返回" onPress={() => void navigate(-1)}>
        <ArrowLeft aria-hidden="true" className="size-4" />
        返回
      </Button>

      {/* 主卡:左 16:9 海报,右侧 TITLE / subtitle + 收藏、播放 */}
      <Card className="overflow-hidden p-0">
        <div className="grid md:grid-cols-[minmax(0,1.1fr)_minmax(0,1fr)]">
          <div className="relative aspect-video w-full overflow-hidden bg-gradient-to-br from-surface-secondary via-surface-tertiary to-surface md:aspect-auto md:min-h-[20rem]">
            {programme !== null && programme.posterRef !== null ? (
              <ProgrammePoster
                posterRef={programme.posterRef}
                title={programme.title}
                decorative={false}
                className="absolute inset-0 h-full w-full object-cover"
              />
            ) : state.channelPosterRef !== null ? (
              <img
                src={`/api/public/media/logos/${encodeURIComponent(state.channelPosterRef)}`}
                alt=""
                aria-hidden="true"
                className="absolute inset-0 m-auto h-1/2 w-1/2 object-contain opacity-90"
              />
            ) : (
              <span className="absolute inset-0 flex items-center justify-center text-6xl font-black text-muted/20">
                {state.channelTitle.slice(0, 1).toUpperCase()}
              </span>
            )}
          </div>

          <div className="flex min-w-0 flex-col gap-3 p-5 md:p-6">
            <p className="text-xs font-medium text-accent">{state.groupLabel} · 节目详情</p>
            <div className="flex min-w-0 flex-col gap-1.5">
              <h1 className="line-clamp-2 text-2xl font-bold leading-tight text-foreground">
                {programme !== null ? programme.title : '暂无节目单'}
              </h1>
              <p className="text-sm text-muted">{subtitle}</p>
            </div>
            <Chip size="sm" variant="soft" color={STATUS_COLOR[status]} className="self-start">
              {STATUS_LABEL[status]}
            </Chip>
            {programme !== null && programme.description !== null && programme.description !== '' ? (
              <p className="line-clamp-4 text-sm leading-relaxed text-muted">{programme.description}</p>
            ) : null}

            <div className="mt-auto flex flex-col gap-2 pt-2">
              <Button
                variant="secondary"
                className="w-full"
                aria-pressed={favorited}
                onPress={() => {
                  if (activeProfileId === null) {
                    startLogin(`${location.pathname}${location.search}`);
                    return;
                  }
                  if (favoriteToggle.isPending) {
                    return;
                  }
                  favoriteToggle.mutate(!favorited, {
                    onSuccess: () => {
                      toast.success(!favorited ? `已收藏 ${state.channelTitle}` : `已取消收藏 ${state.channelTitle}`);
                    },
                  });
                }}
              >
                <Star aria-hidden="true" className={`size-4 ${favorited ? 'fill-current text-accent' : ''}`} />
                {favorited ? '已收藏' : '收藏频道'}
              </Button>
              <Button variant="primary" className="w-full" onPress={playCurrentChannel}>
                <Play aria-hidden="true" className="size-4 fill-current" />
                播放当前频道
              </Button>
            </div>
          </div>
        </div>
      </Card>

      {/* 推荐:正在直播的其他频道 */}
      <section aria-label="推荐" className="flex min-w-0 flex-col gap-3">
        <h2 className="text-base font-semibold text-foreground">推荐</h2>
        {recommendations.length > 0 ? (
          <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
            {recommendations.map((row) => (
              <RecommendCard
                key={row.media.id}
                row={row}
                onPlay={(channel) => {
                  play({
                    mediaId: channel.media.id,
                    title: channel.media.title,
                    startMode: 'beginning',
                    posterRef: channel.media.posterRef,
                  });
                }}
              />
            ))}
          </div>
        ) : (
          <p className="text-sm text-muted">{recommendResource.isPending ? '正在加载推荐…' : '暂无推荐频道'}</p>
        )}
      </section>
    </div>
  );
}