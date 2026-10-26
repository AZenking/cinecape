import type { ReactNode } from 'react';
import { Alert, Button, Skeleton } from '@heroui/react';

/**
 * 分区框架(T067/T071;ui.md §8「统一加载骨架/空状态/可重试 Alert」、FR-004):
 * - 每区独立四态:加载骨架 / 成功(空列表给空态文案) / 失败可重试(Alert + 重试按钮,
 *   错误不只靠颜色:有文字、有指示图标语义、有显式重试动作) / 正常网格;
 * - 后台刷新失败(已有旧数据)显示「更新失败,显示的是上次内容」横条,不吞内容;
 * - 时区标注与「查看更多」由调用方经 footer/subtitle 传入。
 */

export interface SectionFrameProps {
  /** 分区标题(如「正在直播」) */
  readonly title: string;
  /** 副标(时区标注/分页说明等) */
  readonly subtitle?: string;
  readonly status: 'loading' | 'ready' | 'error';
  /** 是否有已展示的旧数据(决定失败形态:整区错误 vs 后台刷新横条) */
  readonly hasStaleContent: boolean;
  readonly isEmpty: boolean;
  /** 空态文案(如「暂无节目」) */
  readonly emptyText: string;
  /** 加载骨架卡片数 */
  readonly skeletonCount?: number;
  /** 本区重试 */
  readonly onRetry: () => void;
  /** 分区尾部动作(查看更多/分页) */
  readonly footer?: ReactNode;
  readonly children: ReactNode;
}

export function SectionFrame(props: SectionFrameProps): ReactNode {
  const {
    title,
    subtitle,
    status,
    hasStaleContent,
    isEmpty,
    emptyText,
    skeletonCount = 4,
    onRetry,
    footer,
    children,
  } = props;
  return (
    <section aria-label={title} className="min-w-0">
      <div className="mb-3 flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <h2 className="text-lg font-semibold text-foreground">{title}</h2>
        {subtitle !== undefined && subtitle !== '' ? (
          <p className="text-xs text-muted">{subtitle}</p>
        ) : null}
      </div>

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
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3 2xl:grid-cols-4" aria-hidden="true">
          {Array.from({ length: skeletonCount }, (_, index) => (
            <div key={index} className="rounded-lg border border-border p-4">
              <Skeleton className="mb-2 h-4 w-2/3 rounded" />
              <Skeleton className="mb-2 h-3 w-1/2 rounded" />
              <Skeleton className="h-3 w-1/3 rounded" />
            </div>
          ))}
        </div>
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
