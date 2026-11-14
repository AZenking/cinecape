import type { ReactNode } from 'react';
import { useLocation, useNavigate, useParams } from 'react-router';
import { Button, Card } from '@heroui/react';
import { ArrowLeft, Play } from 'lucide-react';
import { formatRangeInZone } from '../live/live-format';
import { serverNowMs } from '../../shared/time/server-clock';
import { usePlayAction } from '../playback/use-play-action';
import { ProgrammePoster } from './programme-poster';

/**
 * 节目单详情页(非直播节目)。
 *
 * 跳转规则(产品要求):
 * - 正在直播的节目不走本页 —— 由入口直接拉起播放器;
 * - 非直播(即将开始/已结束/无节目)进入本页,以 16:9 海报 + 标题/简介/元信息呈现,
 *   不再打开 /live/guide 的详情抽屉;
 * - /live/guide 页面自身不调整,仍保留抽屉交互。
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

function statusOf(programme: ProgrammeDetailNavState['programme']): 'now' | 'upcoming' | 'ended' | 'none' {
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

const STATUS_LABEL = { now: '正在直播', upcoming: '即将开始', ended: '已结束', none: '暂无节目数据' } as const;

export function ProgrammeDetailPage(): ReactNode {
  const location = useLocation();
  const navigate = useNavigate();
  const params = useParams();
  const { play } = usePlayAction();
  const state = (location.state ?? null) as ProgrammeDetailNavState | null;
  const programme = state?.programme ?? null;
  const status = statusOf(programme);

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

  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-4">
      <Button variant="ghost" size="sm" className="self-start" aria-label="返回" onPress={() => void navigate(-1)}>
        <ArrowLeft aria-hidden="true" className="size-4" />
        返回
      </Button>

      <Card className="overflow-hidden p-0">
        <div className="relative aspect-video w-full overflow-hidden bg-gradient-to-br from-surface-secondary via-surface-tertiary to-surface">
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
              className="absolute inset-0 m-auto h-2/3 w-2/3 object-contain"
            />
          ) : (
            <span className="absolute inset-0 flex items-center justify-center text-4xl font-black text-muted/30">
              {state.channelTitle.slice(0, 1).toUpperCase()}
            </span>
          )}
        </div>

        <div className="flex flex-col gap-4 p-6">
          <div className="flex min-w-0 flex-col gap-2">
            <p className="text-xs font-medium text-accent">{state.groupLabel} · 节目详情</p>
            <h1 className="text-2xl font-bold leading-snug text-foreground">
              {programme !== null ? programme.title : '暂无节目单'}
            </h1>
            {programme !== null && programme.description !== null && programme.description !== '' ? (
              <p className="text-sm leading-relaxed text-muted">{programme.description}</p>
            ) : null}
          </div>

          <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 text-sm">
            <dt className="text-muted">频道</dt>
            <dd className="min-w-0 truncate text-foreground">{state.channelTitle}</dd>
            {programme !== null ? (
              <>
                <dt className="text-muted">时段</dt>
                <dd className="hmp-tabular-nums text-foreground">
                  {formatRangeInZone(programme.startsAt, programme.endsAt, state.timezone)}
                  <span className="text-muted">{` · ${durationMinutes} 分钟`}</span>
                </dd>
              </>
            ) : null}
            <dt className="text-muted">状态</dt>
            <dd className="text-foreground">{STATUS_LABEL[status]}</dd>
          </dl>

          {status === 'now' ? (
            <Button
              variant="primary"
              className="self-start"
              onPress={() => {
                play({ mediaId: params.channelId ?? '', title: state.channelTitle });
              }}
            >
              <Play aria-hidden="true" className="size-4" />
              播放当前频道
            </Button>
          ) : null}
        </div>
      </Card>
    </div>
  );
}