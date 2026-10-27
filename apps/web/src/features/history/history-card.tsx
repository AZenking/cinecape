import type { ReactNode } from 'react';
import { Link } from 'react-router';
import type { HistoryItem } from './history-api';
import { formatHistoryPosition, formatLastViewedAt } from './history-api';
import { PlayButton } from '../playback/use-play-action';

/**
 * 历史卡(T103,005 US4、ui.md §4):
 *
 * - 显示媒体标题、海报占位、最近观看时间及位置;点击进入详情,不自动播放
 *   (整卡为详情链接;播放入口是独立按钮);
 * - 详情有有效进度时展示「继续观看」(startMode=resume)与「从头播放」
 *   (startMode=beginning),二者都经统一受控播放重新授权;无有效进度/资源变化/
 *   已到结尾只从头(按钮语义由详情页按 canResume 决定,本卡仅承载快捷入口);
 * - 不可用项标注不可用,不提供可运行播放按钮(FR-020);
 * - 快捷继续观看仅在 canResume=true 时渲染;从头播放恒可(重新授权语义由
 *   统一播放流程保证,本组件不预取媒体、不持有任何播放凭据)。
 */

export interface HistoryCardProps {
  readonly item: HistoryItem;
  /** 快捷播放入口(默认开启;窄列表可关闭仅保留详情链接) */
  readonly showPlayActions?: boolean;
}

export function HistoryCard({ item, showPlayActions = true }: HistoryCardProps): ReactNode {
  const unavailable = item.media.availability !== 'available';
  return (
    <article
      data-testid="history-card"
      aria-label={`观看历史:${item.media.title}`}
      className="flex flex-col gap-2 rounded-lg border border-border bg-surface p-3"
    >
      {/* 海报占位(posterRef 仅同源认可资源,当前部署恒为 null;不渲染任意外部 URL) */}
      <div
        aria-hidden={true}
        className="flex aspect-video w-full items-center justify-center rounded border border-border bg-surface-secondary text-xs text-muted"
      >
        {item.media.posterRef === null ? '暂无海报' : ''}
      </div>
      <h3 className="truncate text-sm font-medium text-foreground">
        <Link
          to={`/media/${encodeURIComponent(item.media.id)}`}
          className="rounded focus:outline-none focus-visible:ring-2 focus-visible:ring-focus"
        >
          {item.media.title}
          {unavailable ? <span className="ms-2 text-xs font-normal text-muted">(不可用)</span> : null}
        </Link>
      </h3>
      <p className="text-xs text-muted">
        最近观看:{formatLastViewedAt(item.lastViewedAt)} · 位置:{formatHistoryPosition(item)}
      </p>
      {showPlayActions && !unavailable ? (
        <div className="flex flex-wrap items-center gap-2">
          {item.canResume ? (
            <PlayButton
              mediaId={item.media.id}
              title={item.media.title}
              startMode="resume"
              label="继续观看"
              size="sm"
              ariaLabel={`继续观看 ${item.media.title}`}
            />
          ) : null}
          <PlayButton
            mediaId={item.media.id}
            title={item.media.title}
            startMode="beginning"
            label="从头播放"
            size="sm"
            variant="secondary"
            ariaLabel={`从头播放 ${item.media.title}`}
          />
        </div>
      ) : null}
      {unavailable ? <p className="text-xs text-muted">该内容当前不可用,无法播放。</p> : null}
    </article>
  );
}
