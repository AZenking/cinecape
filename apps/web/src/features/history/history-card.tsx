import type { ReactNode } from 'react';
import { Link } from 'react-router';
import type { HistoryItem } from './history-api';
import { formatHistoryPosition, formatLastViewedAt, RESUME_CONFIDENCE_LABELS, RESUME_REASON_LABELS } from './history-api';
import { PlayButton } from '../playback/use-play-action';

/**
 * 历史卡(T103,005 US4、ui.md §4;010 T049 在线扩展渲染):
 *
 * - 显示媒体标题、海报占位、最近观看时间及位置;点击进入详情,不自动播放
 *   (整卡为详情链接;播放入口是独立按钮);
 * - 详情有有效进度时展示「继续观看」(startMode=resume)与「从头播放」
 *   (startMode=beginning),二者都经统一受控播放重新授权;无有效进度/资源变化/
 *   已到结尾只从头(按钮语义由详情页按 canResume 决定,本卡仅承载快捷入口);
 * - 010 扩展(字段可选,静态历史缺省时零变化):分集记录展示线路/集名标签
 *   (ui.md §1「分集带父/线/集标签」);completed 完成形态徽标;resumeReason 降级
 *   原因徽标与 resumeConfidence 候选置信度徽标 —— 仅是候选资格展示,最终续播
 *   资格以本次 resolve/probe 后为准(api.md §1「资格区分」);
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
  const episodeLabel =
    item.lineLabel !== null && item.lineLabel !== undefined && item.lineLabel !== ''
      ? item.episodeLabel !== null && item.episodeLabel !== undefined && item.episodeLabel !== ''
        ? `${item.lineLabel} · ${item.episodeLabel}`
        : item.lineLabel
      : null;
  const reasonLabel = item.resumeReason != null ? RESUME_REASON_LABELS[item.resumeReason] : null;
  const confidenceLabel =
    item.resumeConfidence !== undefined && item.resumeConfidence !== 'none'
      ? RESUME_CONFIDENCE_LABELS[item.resumeConfidence]
      : null;
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
      {/* 010 在线扩展(可选字段,静态历史不渲染):分集标签 + 完成/原因/置信度徽标(文字承载,不只靠颜色) */}
      {episodeLabel !== null || item.completed === true || reasonLabel !== null || confidenceLabel !== null ? (
        <p className="flex flex-wrap items-center gap-2 text-xs text-muted" data-testid="history-card-summary">
          {episodeLabel !== null ? <span>{episodeLabel}</span> : null}
          {item.completed === true ? (
            <span className="rounded bg-surface-secondary px-1.5 py-0.5 text-foreground">已看完</span>
          ) : null}
          {reasonLabel !== null ? (
            <span className="rounded bg-surface-secondary px-1.5 py-0.5 text-foreground">{reasonLabel}</span>
          ) : null}
          {confidenceLabel !== null ? (
            <span className="rounded bg-surface-secondary px-1.5 py-0.5 text-foreground">{confidenceLabel}</span>
          ) : null}
        </p>
      ) : null}
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
