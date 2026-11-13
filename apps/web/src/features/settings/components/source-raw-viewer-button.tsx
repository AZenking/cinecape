import { useEffect, useState, type ReactNode } from 'react';
import { Button, Label, ListBox, Modal, Select, Spinner } from '@heroui/react';
import { FileCode2 } from 'lucide-react';
import { useAppQuery } from '../../../shared/query/hooks';
import { queryKeys } from '../../../shared/query/keys';
import { formatApiError } from '../../../shared/query/error';
import { privateFetch } from '../../../shared/fetch';
import { formatDateTimeInZone } from '../../../shared/time/format-datetime';
import { useHouseholdTimezone } from '../shared/use-household-timezone';

/**
 * 原始导入快照查看器(021-source-governance,UI 契约 §2)。
 * - 列表按来源读取最近 20 条元数据;默认选中最新一条;
 * - 预览接口只返回前 256 KiB,完整内容经同源 download 端点下载;
 * - 不展示 remote_url/rootKey/播放地址;无快照时给出「先同步一次」的可执行提示。
 */

interface SnapshotMeta {
  id: string;
  kind: 'iptv' | 'epg';
  capturedAt: string;
  byteSize: number;
  sha256: string;
}

interface SnapshotPreview {
  id: string;
  kind: string;
  capturedAt: string;
  byteSize: number;
  previewText: string;
  truncated: boolean;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MiB`;
}

export interface SourceRawViewerButtonProps {
  readonly sourceId: string;
  readonly sourceName: string;
  readonly sourceKind: 'iptv' | 'epg';
}

export function SourceRawViewerButton({
  sourceId,
  sourceName,
  sourceKind,
}: SourceRawViewerButtonProps): ReactNode {
  const timezone = useHouseholdTimezone();
  const [open, setOpen] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const snapshotsQuery = useAppQuery<{ items: SnapshotMeta[] }>({
    domain: 'settings',
    queryKey: [...queryKeys.settings.sources(), sourceId, 'snapshots'],
    queryFn: ({ signal }) =>
      privateFetch<{ items: SnapshotMeta[] }>(`/settings/sources/${sourceId}/snapshots`, { signal }),
    enabled: open,
  });

  // 列表回填后默认选中最新快照;快照切换/刷新时保持当前选择若仍存在
  useEffect(() => {
    const items = snapshotsQuery.data?.items ?? [];
    if (items.length === 0) {
      setSelectedId(null);
      return;
    }
    setSelectedId((current) =>
      current !== null && items.some((item) => item.id === current) ? current : items[0]!.id,
    );
  }, [snapshotsQuery.data]);

  const previewQuery = useAppQuery<SnapshotPreview>({
    domain: 'settings',
    queryKey: [...queryKeys.settings.sources(), sourceId, 'snapshots', selectedId, 'preview'],
    queryFn: ({ signal }) =>
      privateFetch<SnapshotPreview>(
        `/settings/sources/${sourceId}/snapshots/${selectedId ?? ''}/preview`,
        { signal },
      ),
    enabled: open && selectedId !== null,
  });

  const snapshots = snapshotsQuery.data?.items ?? [];
  const selected = snapshots.find((item) => item.id === selectedId) ?? null;
  const downloadHref =
    selectedId !== null
      ? `/api/settings/sources/${encodeURIComponent(sourceId)}/snapshots/${encodeURIComponent(selectedId)}/download`
      : null;

  return (
    <>
      <Button
        size="sm"
        variant="ghost"
        aria-label={`查看 ${sourceName} 原始数据`}
        data-testid={`source-raw-open-${sourceId}`}
        onPress={() => setOpen(true)}
      >
        <FileCode2 aria-hidden="true" className="size-4" />
        原始数据
      </Button>

      <Modal.Backdrop isOpen={open} onOpenChange={setOpen}>
        <Modal.Container>
          <Modal.Dialog className="sm:max-w-5xl">
            <Modal.CloseTrigger />
            <Modal.Header>
              <Modal.Heading>原始导入数据 · {sourceName}</Modal.Heading>
              <p className="text-xs text-muted">
                {sourceKind === 'epg' ? 'XMLTV 节目单原文' : 'M3U 播放列表原文'} · 仅保存最近一次成功读取
              </p>
            </Modal.Header>
            <Modal.Body className="flex min-h-0 flex-col gap-3">
              {snapshotsQuery.isPending ? (
                <div className="flex items-center gap-2 py-10 text-sm text-muted">
                  <Spinner size="sm" /> 正在读取快照…
                </div>
              ) : snapshotsQuery.isError ? (
                <p role="alert" className="rounded-xl border border-danger/30 bg-danger-soft/20 p-3 text-sm text-danger">
                  {formatApiError(snapshotsQuery.error)}
                </p>
              ) : snapshots.length === 0 ? (
                <div className="rounded-xl border border-border/50 bg-surface-secondary/30 p-4 text-sm text-muted">
                  暂无原始快照。执行一次「立即同步」成功后，系统会保存一份压缩原文，可在这里查看与下载。
                </div>
              ) : (
                <>
                  <div className="flex flex-wrap items-center gap-2">
                    <Select
                      aria-label="选择快照"
                      className="w-[18rem]"
                      value={selectedId}
                      onChange={(value) => setSelectedId(value === null ? null : String(value))}
                    >
                      <Label className="text-xs text-muted">快照</Label>
                      <Select.Trigger>
                        <Select.Value />
                        <Select.Indicator />
                      </Select.Trigger>
                      <Select.Popover>
                        <ListBox>
                          {snapshots.map((snapshot) => (
                            <ListBox.Item
                              key={snapshot.id}
                              id={snapshot.id}
                              textValue={`${formatDateTimeInZone(snapshot.capturedAt, timezone, { seconds: true })} · ${formatBytes(snapshot.byteSize)}`}
                            >
                              {formatDateTimeInZone(snapshot.capturedAt, timezone, { seconds: true })} · {formatBytes(snapshot.byteSize)}
                              <ListBox.ItemIndicator />
                            </ListBox.Item>
                          ))}
                        </ListBox>
                      </Select.Popover>
                    </Select>
                    {selected !== null ? (
                      <span className="text-xs text-muted">
                        {selected.kind === 'epg' ? 'XMLTV' : 'M3U'} · SHA-256 {selected.sha256.slice(0, 12)}…
                      </span>
                    ) : null}
                    {downloadHref !== null ? (
                      <a
                        href={downloadHref}
                        className="ml-auto inline-flex h-8 items-center rounded-lg border border-border/60 bg-surface px-3 text-xs font-medium text-foreground transition-colors hover:bg-surface-secondary focus:outline-none focus-visible:ring-2 focus-visible:ring-focus"
                      >
                        下载完整原文
                      </a>
                    ) : null}
                  </div>

                  {previewQuery.isPending ? (
                    <div className="flex items-center gap-2 py-10 text-sm text-muted">
                      <Spinner size="sm" /> 正在解码预览…
                    </div>
                  ) : previewQuery.isError ? (
                    <p role="alert" className="rounded-xl border border-danger/30 bg-danger-soft/20 p-3 text-sm text-danger">
                      {formatApiError(previewQuery.error)}
                    </p>
                  ) : (
                    <div className="flex min-h-0 flex-col gap-2">
                      <pre
                        data-testid={`source-raw-preview-${sourceId}`}
                        className="max-h-[55vh] min-h-[16rem] overflow-auto rounded-xl border border-border/50 bg-background/60 p-4 font-mono text-xs leading-relaxed text-foreground/90 whitespace-pre-wrap break-words"
                      >
                        {previewQuery.data?.previewText ?? ''}
                      </pre>
                      {previewQuery.data?.truncated === true ? (
                        <p className="text-xs text-muted">
                          仅展示前 256 KiB；完整文件请使用「下载完整原文」。
                        </p>
                      ) : null}
                    </div>
                  )}
                </>
              )}
            </Modal.Body>
          </Modal.Dialog>
        </Modal.Container>
      </Modal.Backdrop>
    </>
  );
}
