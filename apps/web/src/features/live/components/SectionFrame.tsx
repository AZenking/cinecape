import type { ReactNode } from 'react';
import { Alert, Button, Skeleton } from '@heroui/react';

/**
 * 分区框架(T067/T071;ui.md §8「统一加载骨架/空状态/可重试 Alert」、FR-004):
 * - 每区独立四态:加载骨架 / 成功(空列表给空态文案) / 失败可重试(Alert + 重试按钮,
 *   错误不只靠颜色:有文字、有指示图标语义、有显式重试动作) / 正常网格;
 * - 后台刷新失败(已有旧数据)显示「更新失败,显示的是上次内容」横条,不吞内容;
 * - 副标(频道数/分页说明等)与「查看更多」由调用方经 footer/subtitle 传入。
 */

export interface SectionFrameProps {
  /** 分区标题(如「正在直播」) */
  readonly title: string;
  /** 标题前的装饰节点(如正在直播的绿色状态点;纯装饰,可读语义由 title 承担) */
  readonly titleAdornment?: ReactNode;
  /** 副标(频道数/分页说明等;时间说明类文案已于 2026-11-13 移除) */
  readonly subtitle?: string;
  /**
   * 副标是否紧跟标题(inline):true 时左簇为「装饰点 + 标题 + 副标」,右侧只放动作;
   * false(缺省)保持旧布局(副标与动作在右侧同行)——分类泳道沿用旧布局。
   */
  readonly subtitleInline?: boolean;
  /** 标题行右侧动作(「查看全部 / 完整节目单」等入口) */
  readonly headerAction?: ReactNode;
  readonly status: 'loading' | 'ready' | 'error';
  /** 是否有已展示的旧数据(决定失败形态:整区错误 vs 后台刷新横条) */
  readonly hasStaleContent: boolean;
  readonly isEmpty: boolean;
  /** 空态文案(如「暂无节目」) */
  readonly emptyText: string;
  /** 加载骨架卡片数 */
  readonly skeletonCount?: number;
  /** 骨架形态:grid=响应式网格(聚焦视图);row=横向瓦片行(概览行) */
  readonly skeletonVariant?: 'grid' | 'row';
  /** 本区重试 */
  readonly onRetry: () => void;
  /** 分区尾部动作(查看更多/分页) */
  readonly footer?: ReactNode;
  readonly children: ReactNode;
}

export function SectionFrame(props: SectionFrameProps): ReactNode {
  const {
    title,
    titleAdornment,
    subtitle,
    subtitleInline = false,
    headerAction,
    status,
    hasStaleContent,
    isEmpty,
    emptyText,
    skeletonCount = 4,
    skeletonVariant = 'grid',
    onRetry,
    footer,
    children,
  } = props;
  return (
    <section aria-label={title} className="min-w-0">
      {subtitleInline ? (
        <div className="mb-3 flex flex-wrap items-center justify-between gap-x-4 gap-y-1">
          <div className="flex min-w-0 items-center gap-2">
            {titleAdornment ?? null}
            <h2 className="text-lg font-semibold text-foreground">{title}</h2>
            {subtitle !== undefined && subtitle !== '' ? (
              <p className="text-xs text-muted">{subtitle}</p>
            ) : null}
          </div>
          {headerAction !== undefined ? <div className="shrink-0">{headerAction}</div> : null}
        </div>
      ) : (
        /* 分类泳道/频道网格沿用旧标题布局(副标与动作在右侧),避免下方分类区外观变化 */
        <div className="mb-3 flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
          <h2 className="text-lg font-semibold text-foreground">{title}</h2>
          <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
            {subtitle !== undefined && subtitle !== '' ? (
              <p className="text-xs text-muted">{subtitle}</p>
            ) : null}
            {headerAction ?? null}
          </div>
        </div>
      )}

      {status === 'error' && !hasStaleContent ? (
        <Alert status="danger" role="alert" className="mb-3">
          <Alert.Title>本区加载失败</Alert.Title>
          <Alert.Description>
            网络或服务暂时不可用,本区内容未能加载(其他分区不受影响)。
          </Alert.Description>
          <Alert.Content>
            <Button size="sm" variant="outline" onPress={onRetry}>
              重试
            </Button>
          </Alert.Content>
        </Alert>
      ) : null}

      {status === 'error' && hasStaleContent ? (
        <Alert status="danger" role="alert" className="mb-3">
          <Alert.Title>更新失败,显示的是上次内容</Alert.Title>
          <Alert.Description>自动刷新未能取得最新数据,以下为上次成功内容。</Alert.Description>
          <Alert.Content>
            <Button size="sm" variant="outline" onPress={onRetry}>
              重试
            </Button>
          </Alert.Content>
        </Alert>
      ) : null}

      {status === 'loading' && !hasStaleContent ? (
        skeletonVariant === 'row' ? (
          <div className="flex gap-4 overflow-hidden" aria-hidden="true">
            {Array.from({ length: skeletonCount }, (_, index) => (
              <div key={index} className="w-60 shrink-0 rounded-xl border border-border bg-surface p-3 sm:w-64">
                <Skeleton className="mb-3 aspect-video w-full rounded-lg" />
                <Skeleton className="mb-2 h-3 w-2/3 rounded" />
                <Skeleton className="h-3 w-1/2 rounded" />
              </div>
            ))}
          </div>
        ) : (
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3 2xl:grid-cols-4" aria-hidden="true">
            {Array.from({ length: skeletonCount }, (_, index) => (
              <div key={index} className="rounded-lg border border-border p-4">
                <Skeleton className="mb-2 h-4 w-2/3 rounded" />
                <Skeleton className="mb-2 h-3 w-1/2 rounded" />
                <Skeleton className="h-3 w-1/3 rounded" />
              </div>
            ))}
          </div>
        )
      ) : null}

      {status !== 'loading' || hasStaleContent ? (
        <>
          {isEmpty && status === 'ready' ? <p className="py-6 text-sm text-muted">{emptyText}</p> : null}
          {children}
        </>
      ) : null}

      {footer ?? null}
    </section>
  );
}
