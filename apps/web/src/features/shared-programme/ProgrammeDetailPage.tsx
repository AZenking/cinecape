import type { ReactNode } from 'react';
import { useLocation, useNavigate, useParams } from 'react-router';
import { Button, Card, Chip } from '@heroui/react';
import { ArrowLeft, CalendarClock, Clock3, Play, Tv } from 'lucide-react';
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
 *   不再打开 /live/guide 的详情抽屉;该页自身不调整,仍保留抽屉交互。
 *
 * 视觉沿用当前设计语言:深色 token 卡片 + 通栏 16:9 图像(海报 → 频道台标 → 首字)、
 * 底部压暗层上叠加标题与元信息 chips,下方单独承载简介与频道信息。
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
  const rangeLabel =
    programme === null ? null : formatRangeInZone(programme.startsAt, programme.endsAt, state.timezone);

  return (
    <div className="mx-auto flex w-full max-w-5xl flex-col gap-4">
      <Button variant="ghost" size="sm" className="self-start" aria-label="返回" onPress={() => void navigate(-1)}>
        <ArrowLeft aria-hidden="true" className="size-4" />
        返回
      </Button>

      {/* 主卡:通栏 16:9 图像 + 底部压暗层上的标题/元信息;下方独立承载简介与频道信息 */}
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
              className="absolute inset-0 m-auto h-1/2 w-1/2 object-contain opacity-90"
            />
          ) : (
            <span className="absolute inset-0 flex items-center justify-center text-6xl font-black text-muted/20">
              {state.channelTitle.slice(0, 1).toUpperCase()}
            </span>
          )}

          {/* 压暗层:保证叠加文字在任意海报/台标上都有对比度 */}
          <span className="absolute inset-0 bg-gradient-to-t from-background/95 via-background/40 to-transparent" />
          <span className="absolute inset-0 bg-gradient-to-r from-background/60 via-transparent to-transparent" />

          {/* 叠加信息:分组 → 标题 → 状态/频道/时段 chips */}
          <div className="absolute inset-x-5 bottom-5 z-10 flex flex-col gap-2.5 md:inset-x-8 md:bottom-7">
            <p className="text-xs font-medium text-accent">{state.groupLabel} · 节目详情</p>
            <h1 className="line-clamp-2 text-2xl font-bold leading-tight text-foreground drop-shadow-sm md:text-3xl">
              {programme !== null ? programme.title : '暂无节目单'}
            </h1>
            <div className="flex flex-wrap items-center gap-1.5">
              <Chip size="sm" variant="soft" color={STATUS_COLOR[status]}>
                {STATUS_LABEL[status]}
              </Chip>
              <Chip size="sm" variant="soft" color="default">
                <Tv aria-hidden="true" className="size-3" />
                {state.channelTitle}
              </Chip>
              {rangeLabel !== null ? (
                <Chip size="sm" variant="soft" color="default" className="hmp-tabular-nums">
                  <CalendarClock aria-hidden="true" className="size-3" />
                  {rangeLabel}
                </Chip>
              ) : null}
              {durationMinutes !== null ? (
                <Chip size="sm" variant="soft" color="default">
                  <Clock3 aria-hidden="true" className="size-3" />
                  {`${durationMinutes} 分钟`}
                </Chip>
              ) : null}
            </div>
          </div>
        </div>

        <div className="flex flex-col gap-5 p-5 md:p-6">
          <section className="flex min-w-0 flex-col gap-2">
            <h2 className="text-sm font-semibold text-foreground">节目简介</h2>
            <p className="text-sm leading-relaxed text-muted">
              {programme !== null && programme.description !== null && programme.description !== ''
                ? programme.description
                : '暂无简介。'}
            </p>
          </section>

          <section className="flex min-w-0 flex-col gap-2 border-t border-border/50 pt-4">
            <h2 className="text-sm font-semibold text-foreground">频道信息</h2>
            <div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-sm">
              <span className="inline-flex items-center gap-2 text-foreground">
                {state.channelPosterRef !== null ? (
                  <img
                    src={`/api/public/media/logos/${encodeURIComponent(state.channelPosterRef)}`}
                    alt=""
                    aria-hidden="true"
                    className="h-6 w-6 rounded-sm object-contain"
                  />
                ) : null}
                {state.channelTitle}
              </span>
              {programme !== null ? (
                <span className="hmp-tabular-nums text-muted">
                  时段 {formatRangeInZone(programme.startsAt, programme.endsAt, state.timezone)}
                </span>
              ) : null}
              <span className="text-muted">状态 {STATUS_LABEL[status]}</span>
            </div>
          </section>

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