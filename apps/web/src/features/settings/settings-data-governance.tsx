import { useCallback, useState, type ReactNode } from 'react';
import { AlertDialog, Button, Card, Chip, ListBox, Select, Spinner } from '@heroui/react';
import { AlertTriangle, ArchiveRestore, FileArchive, RefreshCw, Trash2 } from 'lucide-react';
import { RetryableAlert, useAppToast } from '../../shared/ui';
import { useAppQuery } from '../../shared/query/hooks';
import { queryKeys } from '../../shared/query/keys';
import { formatApiError } from '../../shared/query/error';
import { privateFetch } from '../../shared/fetch';
import { formatDateTimeInZone } from '../../shared/time/format-datetime';
import { useHouseholdTimezone } from './shared/use-household-timezone';
import { useSettingsAccess } from './settings-access-provider';

/**
 * 数据治理(021-source-governance):归档来源、过期节目、失效线路、原始快照、
 * 过期同步任务的统计与显式清理。所有清理先 dry-run 预览,再确认执行;
 * 不提供后台静默清理。
 */

type CleanupTarget =
  | 'expired-programmes'
  | 'stale-entries'
  | 'snapshots'
  | 'refresh-jobs'
  | 'archived-sources';

interface ArchivedSource {
  id: string;
  name: string;
  kind: string;
  archivedAt: string;
  lastSuccessAt: string | null;
  version: number;
}

interface GovernanceOverview {
  retentionDays: number;
  archivedSources: ArchivedSource[];
  counts: {
    expiredProgrammes: number;
    staleEntries: number;
    snapshots: number;
    snapshotBytes: number;
    refreshJobs: number;
    archivedSources: number;
  };
}

interface CleanupResult {
  target: CleanupTarget;
  dryRun: boolean;
  deleted: number;
  bytesFreed: number;
  detail: Record<string, number>;
}

const RETENTION_OPTIONS = [7, 30, 90, 180] as const;

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MiB`;
}

const TARGET_META: Record<
  CleanupTarget,
  { title: string; description: string; icon: ReactNode }
> = {
  'expired-programmes': {
    title: '已结束节目',
    description: '清理结束时间早于保留期的 EPG 节目，释放节目表单空间。',
    icon: <FileArchive aria-hidden="true" className="size-4" />,
  },
  'stale-entries': {
    title: '失效频道线路',
    description: '清理已标记缺失且超过保留期的来源条目及其播放线路，不删除逻辑频道。',
    icon: <RefreshCw aria-hidden="true" className="size-4" />,
  },
  snapshots: {
    title: '原始导入快照',
    description: '每个来源保留最新一份快照，清理更早的历史快照。',
    icon: <FileArchive aria-hidden="true" className="size-4" />,
  },
  'refresh-jobs': {
    title: '过期同步任务',
    description: '清理已结束且超过保留期的同步任务与暂存记录。',
    icon: <RefreshCw aria-hidden="true" className="size-4" />,
  },
  'archived-sources': {
    title: '归档来源',
    description: '永久清理归档时间早于保留期的来源及其导入数据，不可恢复。',
    icon: <Trash2 aria-hidden="true" className="size-4" />,
  },
};

export function SettingsDataGovernance(): ReactNode {
  const access = useSettingsAccess();
  const toast = useAppToast();
  /** 归档/上次成功时间按家庭时区展示(服务端为 UTC ISO) */
  const timezone = useHouseholdTimezone();
  const [retentionDays, setRetentionDays] = useState(30);
  const [preparing, setPreparing] = useState<CleanupTarget | null>(null);
  const [cleanupTarget, setCleanupTarget] = useState<CleanupTarget | null>(null);
  const [preview, setPreview] = useState<CleanupResult | null>(null);
  const [running, setRunning] = useState(false);
  const [purgeTarget, setPurgeTarget] = useState<ArchivedSource | null>(null);
  const [purging, setPurging] = useState(false);

  const overview = useAppQuery<GovernanceOverview>({
    domain: 'settings',
    queryKey: [...queryKeys.settings.sources(), 'governance'],
    queryFn: ({ signal }) =>
      privateFetch<GovernanceOverview>('/settings/governance/overview', { signal }),
  });

  const prepareCleanup = useCallback(
    async (target: CleanupTarget): Promise<void> => {
      setPreparing(target);
      try {
        const result = await privateFetch<CleanupResult>('/settings/governance/cleanup', {
          method: 'POST',
          body: { target, retentionDays, dryRun: true },
        });
        setPreview(result);
        setCleanupTarget(target);
      } catch (error) {
        if (error instanceof Error && 'status' in error && (error as { status?: number }).status === 403) {
          access.handleAccessLost();
        }
        toast.error(formatApiError(error));
      } finally {
        setPreparing(null);
      }
    },
    [access, retentionDays, toast],
  );

  const runCleanup = useCallback(async (): Promise<void> => {
    if (cleanupTarget === null) return;
    setRunning(true);
    try {
      const result = await privateFetch<CleanupResult>('/settings/governance/cleanup', {
        method: 'POST',
        body: { target: cleanupTarget, retentionDays, dryRun: false },
      });
      toast.success(`清理完成：删除 ${result.deleted} 条${result.bytesFreed > 0 ? `，释放 ${formatBytes(result.bytesFreed)}` : ''}`);
      setCleanupTarget(null);
      setPreview(null);
      await overview.refetch();
    } catch (error) {
      toast.error(formatApiError(error));
    } finally {
      setRunning(false);
    }
  }, [cleanupTarget, overview, retentionDays, toast]);

  const restoreSource = useCallback(
    async (source: ArchivedSource): Promise<void> => {
      try {
        await privateFetch<void>(`/settings/sources/${source.id}/restore`, {
          method: 'POST',
          body: { expectedVersion: source.version },
        });
        toast.success(`已恢复「${source.name}」，来源保持停用，请按需启用`);
        await overview.refetch();
      } catch (error) {
        toast.error(formatApiError(error));
      }
    },
    [overview, toast],
  );

  const purgeSource = useCallback(async (): Promise<void> => {
    if (purgeTarget === null) return;
    setPurging(true);
    try {
      await privateFetch<{ deleted: number; bytesFreed: number }>(
        `/settings/governance/archived-sources/${purgeTarget.id}/purge`,
        { method: 'POST', body: { expectedVersion: purgeTarget.version } },
      );
      toast.success(`已永久清理「${purgeTarget.name}」`);
      setPurgeTarget(null);
      await overview.refetch();
    } catch (error) {
      toast.error(formatApiError(error));
    } finally {
      setPurging(false);
    }
  }, [overview, purgeTarget, toast]);

  if (overview.isPending) {
    return (
      <div className="flex items-center gap-2 py-16 text-sm text-muted">
        <Spinner size="sm" /> 正在统计可清理数据…
      </div>
    );
  }
  if (overview.isError) {
    return (
      <RetryableAlert
        title="数据治理加载失败"
        description={formatApiError(overview.error)}
        onRetry={() => void overview.refetch()}
      />
    );
  }
  const data = overview.data;
  if (data === undefined) return null;

  const cards: Array<{ target: CleanupTarget; count: string }> = [
    { target: 'expired-programmes', count: `${data.counts.expiredProgrammes} 条节目` },
    { target: 'stale-entries', count: `${data.counts.staleEntries} 条失效条目` },
    {
      target: 'snapshots',
      count: `${data.counts.snapshots} 份 · ${formatBytes(data.counts.snapshotBytes)}`,
    },
    { target: 'refresh-jobs', count: `${data.counts.refreshJobs} 个任务` },
    { target: 'archived-sources', count: `${data.counts.archivedSources} 个归档来源` },
  ];

  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="flex flex-col gap-1">
          <h2 className="text-base font-semibold text-foreground">数据治理</h2>
          <p className="text-sm text-muted">
            按保留期清理过期节目、失效线路、原始快照与同步任务。清理前会先显示预计影响。
          </p>
        </div>
        <div className="flex items-center gap-2">
          <span className="text-xs text-muted">保留期</span>
          <Select
            aria-label="清理保留期"
            className="w-32"
            value={String(retentionDays)}
            onChange={(value) => setRetentionDays(Number(value ?? 30))}
          >
            <Select.Trigger>
              <Select.Value />
              <Select.Indicator />
            </Select.Trigger>
            <Select.Popover>
              <ListBox>
                {RETENTION_OPTIONS.map((days) => (
                  <ListBox.Item key={String(days)} id={String(days)} textValue={`${days} 天`}>
                    {days} 天
                    <ListBox.ItemIndicator />
                  </ListBox.Item>
                ))}
              </ListBox>
            </Select.Popover>
          </Select>
        </div>
      </div>

      <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
        {cards.map(({ target, count }) => {
          const meta = TARGET_META[target];
          return (
            <Card key={target} className="rounded-2xl border border-border/40 bg-surface/50 p-0 shadow-none">
              <Card.Content className="flex h-full flex-col gap-3 p-4">
                <div className="flex items-start justify-between gap-3">
                  <div className="flex items-center gap-2 text-sm font-medium text-foreground">
                    <span className="text-muted">{meta.icon}</span>
                    {meta.title}
                  </div>
                  <Chip size="sm" variant="soft" color="default" className="text-xs">
                    {count}
                  </Chip>
                </div>
                <p className="flex-1 text-xs leading-relaxed text-muted">{meta.description}</p>
                <Button
                  size="sm"
                  variant={target === 'archived-sources' ? 'danger-soft' : 'secondary'}
                  className="self-start"
                  isPending={preparing === target}
                  onPress={() => void prepareCleanup(target)}
                >
                  预览并清理
                </Button>
              </Card.Content>
            </Card>
          );
        })}
      </div>

      <Card className="rounded-2xl border border-border/40 bg-surface/40 p-0 shadow-none">
        <Card.Content className="flex flex-col gap-3 p-4">
          <div className="flex items-center justify-between gap-3">
            <div>
              <h3 className="text-sm font-semibold text-foreground">已归档来源</h3>
              <p className="text-xs text-muted">归档来源已停用并从常规列表隐藏；可恢复或永久清理。</p>
            </div>
            <Chip size="sm" variant="soft" color="default" className="text-xs">
              {data.archivedSources.length} 个
            </Chip>
          </div>
          {data.archivedSources.length === 0 ? (
            <p className="rounded-xl border border-border/40 bg-surface-secondary/20 p-3 text-xs text-muted">
              暂无归档来源。
            </p>
          ) : (
            <ul className="flex flex-col divide-y divide-border/30">
              {data.archivedSources.map((source) => (
                <li key={source.id} className="flex flex-wrap items-center justify-between gap-3 py-2.5">
                  <div className="flex min-w-0 flex-col gap-0.5">
                    <div className="flex items-center gap-2">
                      <span className="truncate text-sm font-medium text-foreground">{source.name}</span>
                      <Chip size="sm" variant="soft" color="default" className="text-xs uppercase">
                        {source.kind}
                      </Chip>
                    </div>
                    <span className="text-xs text-muted">
                      归档于 {formatDateTimeInZone(source.archivedAt, timezone, { seconds: true })}
                      {source.lastSuccessAt !== null ? ` · 上次成功 ${formatDateTimeInZone(source.lastSuccessAt, timezone, { seconds: true })}` : ''}
                    </span>
                  </div>
                  <div className="flex items-center gap-2">
                    <Button
                      size="sm"
                      variant="secondary"
                      onPress={() => void restoreSource(source)}
                      data-testid={`governance-restore-${source.id}`}
                    >
                      <ArchiveRestore aria-hidden="true" className="size-4" />
                      恢复
                    </Button>
                    <Button
                      size="sm"
                      variant="danger-soft"
                      onPress={() => setPurgeTarget(source)}
                      data-testid={`governance-purge-${source.id}`}
                    >
                      <Trash2 aria-hidden="true" className="size-4" />
                      永久清理
                    </Button>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </Card.Content>
      </Card>

      {/* 清理预览确认 */}
      <AlertDialog.Backdrop
        isOpen={cleanupTarget !== null}
        onOpenChange={(open) => {
          if (!open) {
            setCleanupTarget(null);
            setPreview(null);
          }
        }}
      >
        <AlertDialog.Container>
          <AlertDialog.Dialog className="sm:max-w-[440px]">
            <AlertDialog.CloseTrigger />
            <AlertDialog.Header>
              <AlertDialog.Icon status={cleanupTarget === 'archived-sources' ? 'danger' : 'warning'} />
              <AlertDialog.Heading>
                {cleanupTarget !== null ? `清理${TARGET_META[cleanupTarget].title}？` : '清理数据？'}
              </AlertDialog.Heading>
            </AlertDialog.Header>
            <AlertDialog.Body>
              {preview === null ? (
                <p className="text-sm text-muted">正在计算影响…</p>
              ) : (
                <div className="flex flex-col gap-2 text-sm text-muted">
                  <p>
                    按 {retentionDays} 天保留期，预计删除 <strong className="text-foreground">{preview.deleted}</strong> 条
                    {preview.bytesFreed > 0 ? `，释放 ${formatBytes(preview.bytesFreed)}` : ''}。
                  </p>
                  {cleanupTarget === 'archived-sources' ? (
                    <p className="flex items-start gap-2 rounded-lg border border-danger/30 bg-danger-soft/20 p-2 text-xs text-danger">
                      <AlertTriangle aria-hidden="true" className="mt-0.5 size-3.5 shrink-0" />
                      永久清理不可恢复；共享的逻辑频道条目不会被删除。
                    </p>
                  ) : null}
                </div>
              )}
            </AlertDialog.Body>
            <AlertDialog.Footer>
              <Button slot="close" variant="tertiary">
                取消
              </Button>
              <Button
                variant={cleanupTarget === 'archived-sources' ? 'danger' : 'primary'}
                isPending={running}
                onPress={() => void runCleanup()}
              >
                确认清理
              </Button>
            </AlertDialog.Footer>
          </AlertDialog.Dialog>
        </AlertDialog.Container>
      </AlertDialog.Backdrop>

      {/* 单条永久清理确认 */}
      <AlertDialog.Backdrop
        isOpen={purgeTarget !== null}
        onOpenChange={(open) => {
          if (!open) setPurgeTarget(null);
        }}
      >
        <AlertDialog.Container>
          <AlertDialog.Dialog className="sm:max-w-[440px]">
            <AlertDialog.CloseTrigger />
            <AlertDialog.Header>
              <AlertDialog.Icon status="danger" />
              <AlertDialog.Heading>永久清理「{purgeTarget?.name ?? ''}」？</AlertDialog.Heading>
            </AlertDialog.Header>
            <AlertDialog.Body>
              <p className="text-sm leading-relaxed text-muted">
                将删除该来源的频道线路、节目单、原始快照、同步任务与 EPG 绑定，并从来源表移除。
                此操作不可恢复；共享的逻辑频道条目不会删除。
              </p>
            </AlertDialog.Body>
            <AlertDialog.Footer>
              <Button slot="close" variant="tertiary">
                取消
              </Button>
              <Button variant="danger" isPending={purging} onPress={() => void purgeSource()}>
                永久清理
              </Button>
            </AlertDialog.Footer>
          </AlertDialog.Dialog>
        </AlertDialog.Container>
      </AlertDialog.Backdrop>
    </div>
  );
}
