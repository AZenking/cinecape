import type { ReactNode } from 'react';
import { Button } from '@heroui/react';
import type { ChannelRowDto, ExperienceProgrammeDto } from '@hmp/shared';
import { formatRangeInZone, formatTimeInZone } from '../live-format';
import { PlayButton } from '../../playback/use-play-action';

/**
 * 直播频道节目卡(T069/T070/T071;FR-021/023/024、ui.md §5/§8):
 * - 显示频道名称、分组、当前/下一节目及起止时间(家庭时区、等宽数字);
 * - 无节目频道显示「暂无节目」明确占位,播放入口保留(可用性不由 EPG 决定,FR-023);
 * - 点击节目标题/时间打开节目时段详情(频道与起止时间;不伪装可播放未来节目,FR-024);
 * - 播放按钮与收藏按钮分离:播放经共享 PlayButton 走 US3 统一受控播放
 *   (usePlayAction;游客点击进入登录选档意图,选档完成前零 /playback/ 请求);
 *   收藏按钮保持 onRequireAuth(US4 接管);
 * - 长节目名 .hmp-truncate + title 提供完整可读名称;时间 .hmp-tabular-nums。
 */

export interface ProgrammeCardProps {
  readonly row: ChannelRowDto;
  /** 服务端同步快照时区(家庭时区标注与换算唯一依据) */
  readonly timezone: string;
  /** 节目时段详情回调(即将播放/当前节目共用;打开频道/节目信息) */
  readonly onOpenProgramme: (input: {
    readonly mediaId: string;
    readonly channelTitle: string;
    readonly groupLabel: string;
    readonly programme: ExperienceProgrammeDto;
    readonly kind: 'current' | 'upcoming';
  }) => void;
  /** 游客收藏:进入登录选档提示(收藏属 US4;播放不经此,走共享 PlayButton) */
  readonly onRequireAuth: (actionLabel: string) => void;
}

export function ProgrammeCard({ row, timezone, onOpenProgramme, onRequireAuth }: ProgrammeCardProps): ReactNode {
  const channelTitle = row.media.title;
  const hasCurrent = row.current !== null;
  const hasNext = row.next !== null;

  return (
    <article
      className="flex min-w-0 flex-col gap-2 rounded-lg border border-border bg-surface p-4"
      aria-label={`频道 ${channelTitle}`}
    >
      <div className="flex min-w-0 items-start justify-between gap-2">
        <div className="min-w-0">
          <h3 className="hmp-truncate text-base font-semibold text-foreground" title={channelTitle}>
            {channelTitle}
          </h3>
          <p className="mt-0.5 text-xs text-muted">{row.groupLabel}</p>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          <Button
            size="sm"
            variant="ghost"
            isIconOnly
            aria-label={`收藏 ${channelTitle}`}
            onPress={() => {
              onRequireAuth(`收藏 ${channelTitle}`);
            }}
          >
            ☆
          </Button>
          <PlayButton
            mediaId={row.media.id}
            title={channelTitle}
            size="sm"
            label="播放"
            ariaLabel={`播放 ${channelTitle} 当前直播`}
          />
        </div>
      </div>

      {hasCurrent && row.current !== null ? (
        <button
          type="button"
          className="min-w-0 rounded p-1 text-left focus:outline-none focus-visible:ring-2 focus-visible:ring-focus"
          onClick={(event) => {
            event.preventDefault();
            onOpenProgramme({
              mediaId: row.media.id,
              channelTitle,
              groupLabel: row.groupLabel,
              programme: row.current as ExperienceProgrammeDto,
              kind: 'current',
            });
          }}
        >
          <span className="block min-w-0 text-sm text-foreground" title={row.current.title}>
            <span className="me-1 rounded bg-accent/15 px-1 text-xs text-accent">正在直播</span>
            <span className="hmp-truncate align-middle">{row.current.title}</span>
          </span>
          <span className="hmp-tabular-nums mt-1 block text-xs text-muted">
            {formatRangeInZone(row.current.startsAt, row.current.endsAt, timezone)}
          </span>
        </button>
      ) : (
        <p className="rounded p-1 text-sm text-muted" data-testid="no-programme">
          暂无节目
        </p>
      )}

      {hasNext && row.next !== null ? (
        <button
          type="button"
          className="min-w-0 rounded p-1 text-left focus:outline-none focus-visible:ring-2 focus-visible:ring-focus"
          onClick={(event) => {
            event.preventDefault();
            onOpenProgramme({
              mediaId: row.media.id,
              channelTitle,
              groupLabel: row.groupLabel,
              programme: row.next as ExperienceProgrammeDto,
              kind: 'upcoming',
            });
          }}
        >
          <span className="block min-w-0 text-sm text-muted" title={row.next.title}>
            <span className="me-1 rounded bg-surface-secondary px-1 text-xs">即将播放</span>
            <span className="hmp-truncate align-middle">{row.next.title}</span>
          </span>
          <span className="hmp-tabular-nums mt-1 block text-xs text-muted">
            {formatTimeInZone(row.next.startsAt, timezone)} 开始 · 至 {formatTimeInZone(row.next.endsAt, timezone)}
          </span>
        </button>
      ) : null}
    </article>
  );
}
