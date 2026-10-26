/**
 * 来源行内任务摘要(T030;T045 增强)。
 *
 * - 状态为「文字 + 图标」,不依赖颜色 alone;
 * - counts 按 kind 相关性取舍(契约:added/updated/missing/failed/channels/programmes),
 *   以「/」分隔展示(EPG 来源即「频道 N / 节目 M」);
 * - awaiting_confirmation 显示原因与「确认发布」「丢弃」入口,终态后摘要由页面隐藏;
 * - failed/interrupted 提供行内「重试」入口(重新发起刷新,经页面家长验证;FR-018);
 * - 失败仅显示稳定 code 对应的友好文案,不渲染原始错误细节。
 */
import { Fragment } from 'react';
import { Button, Chip, Spinner } from '@heroui/react';
import type { RefreshDto, SourceDto } from '@hmp/shared';
import {
  REFRESH_STATUS_ICONS,
  REFRESH_STATUS_LABELS,
  confirmationReasonText,
  formatDateTime,
  jobCountEntries,
  jobFailureMessage,
  type SourceKind,
} from './messages';

export interface SourceJobSummaryProps {
  /** 最近一次任务的最新快照 */
  job: RefreshDto;
  /** 任务所属来源(用于 kind 相关性取舍;列表中找不到时退化为通用展示) */
  source: SourceDto | undefined;
  /** 任务是否仍在轮询中(排队/执行/待确认) */
  polling: boolean;
  isActionPending: boolean;
  onConfirm: () => void;
  onDiscard: () => void;
  /** failed/interrupted 时的行内「重试」入口(重新发起刷新;缺省则不显示) */
  onRetry?: () => void;
}

/** 任务状态 → Chip 颜色语义(仅作视觉强化,信息由文字承载) */
function statusColor(status: RefreshDto['status']): 'accent' | 'success' | 'warning' | 'danger' | 'default' {
  switch (status) {
    case 'queued':
    case 'running':
      return 'accent';
    case 'awaiting_confirmation':
      return 'warning';
    case 'succeeded':
      return 'success';
    case 'failed':
    case 'interrupted':
    case 'expired':
    case 'stale':
      return 'danger';
    default:
      return 'default';
  }
}

export function SourceJobSummary({
  job,
  source,
  polling,
  isActionPending,
  onConfirm,
  onDiscard,
  onRetry,
}: SourceJobSummaryProps) {
  const kind: SourceKind | undefined = source?.kind;
  const awaiting = job.status === 'awaiting_confirmation';
  /** failed/interrupted 为可重试终态(重新发起刷新;同来源此时无占用中任务) */
  const retryable = job.status === 'failed' || job.status === 'interrupted';

  return (
    <div className="space-y-2 rounded-lg border border-border bg-surface p-3 text-sm">
      <div className="flex flex-wrap items-center gap-2">
        <Chip size="sm" variant="soft" color={statusColor(job.status)}>
          {REFRESH_STATUS_ICONS[job.status]} {REFRESH_STATUS_LABELS[job.status]}
        </Chip>
        {polling && (
          <span className="flex items-center gap-1.5 text-xs text-muted">
            <Spinner size="sm" />
            每 2 秒自动查询任务状态…
          </span>
        )}
        {job.finishedAt !== null && <span className="text-xs text-muted">完成于 {formatDateTime(job.finishedAt)}</span>}
      </div>

      {/* 终态 counts(kind 相关性取舍;「/」分隔,EPG 即「频道 N / 节目 M」) */}
      {(job.status === 'succeeded' || job.status === 'failed') && (
        <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted">
          {jobCountEntries(kind, job.counts).map((entry, index) => (
            <Fragment key={entry.label}>
              {index > 0 && (
                <span aria-hidden="true" className="text-muted">
                  /
                </span>
              )}
              <span>
                {entry.label} {entry.value}
              </span>
            </Fragment>
          ))}
        </p>
      )}

      {/* 失败:仅稳定 code 的友好文案,不显示原始错误细节 */}
      {job.status === 'failed' && (
        <p className="text-xs text-danger">✕ {jobFailureMessage(job.errorCode)}</p>
      )}
      {job.status === 'interrupted' && (
        <p className="text-xs text-warning">⚠ 任务已中断(如服务重启),可重新发起刷新。</p>
      )}

      {/* failed/interrupted 行内重试:重新发起刷新(页面经家长验证后 POST refresh) */}
      {retryable && onRetry !== undefined && (
        <div>
          <Button size="sm" variant="outline" isDisabled={isActionPending} onPress={onRetry}>
            重试(需家长验证)
          </Button>
        </div>
      )}

      {/* 待确认摘要:原因 + 确认发布 / 丢弃;确认或丢弃后进入终态,摘要随之消失 */}
      {awaiting && (
        <div className="space-y-2">
          <p className="text-xs text-warning">! 待确认:{confirmationReasonText(job.confirmationReason)}</p>
          <p className="text-xs text-muted">
            确认发布将把该快照发布为当前目录;丢弃则保留现有目录不变。
          </p>
          <div className="flex gap-2">
            <Button size="sm" variant="primary" isDisabled={isActionPending} onPress={onConfirm}>
              确认发布(需家长验证)
            </Button>
            <Button size="sm" variant="danger-soft" isDisabled={isActionPending} onPress={onDiscard}>
              丢弃(需家长验证)
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
