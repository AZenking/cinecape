import { useState, type ReactNode } from 'react';
import { AlertDialog, Button } from '@heroui/react';
import { Trash2 } from 'lucide-react';
import { useAppMutation } from '../../../shared/query/hooks';
import { queryKeys } from '../../../shared/query/keys';
import { privateFetch } from '../../../shared/fetch';

/**
 * 来源归档按钮(021-source-governance):产品语义「删除」,实际为软删除。
 * - 归档后来源从列表隐藏、停止同步,已导入数据保留;治理页可恢复/永久清理;
 * - 确认弹层明确说明不是立即物理删除,避免误解;
 * - CAS expectedVersion 来自列表行;409 由 useAppMutation 统一 toast。
 */
export interface ArchiveSourceButtonProps {
  readonly sourceId: string;
  readonly sourceName: string;
  readonly sourceVersion: number;
  readonly sourceKind: 'iptv' | 'epg' | 'nas' | 'vod';
}

export function ArchiveSourceButton({
  sourceId,
  sourceName,
  sourceVersion,
  sourceKind,
}: ArchiveSourceButtonProps): ReactNode {
  const [open, setOpen] = useState(false);
  const archive = useAppMutation({
    domain: 'settings',
    feedback: 'confirmed',
    successToast: `已归档「${sourceName}」，可在数据治理中恢复`,
    mutationFn: () =>
      privateFetch<void>(`/settings/sources/${sourceId}/archive`, {
        method: 'POST',
        body: { expectedVersion: sourceVersion },
      }),
    invalidate: [queryKeys.settings.sources(), queryKeys.settings.epg()],
  });

  return (
    <>
      <Button
        isIconOnly
        size="sm"
        variant="danger-soft"
        aria-label={`删除 ${sourceName}`}
        data-testid={`source-delete-${sourceId}`}
        onPress={() => setOpen(true)}
      >
        <Trash2 aria-hidden="true" className="size-4" />
      </Button>
      <AlertDialog.Backdrop isOpen={open} onOpenChange={setOpen}>
        <AlertDialog.Container>
          <AlertDialog.Dialog className="sm:max-w-[440px]">
            <AlertDialog.CloseTrigger />
            <AlertDialog.Header>
              <AlertDialog.Icon status="danger" />
              <AlertDialog.Heading>删除「{sourceName}」？</AlertDialog.Heading>
            </AlertDialog.Header>
            <AlertDialog.Body>
              <p className="text-sm leading-relaxed text-muted">
                删除后该{sourceKind === 'epg' ? '节目单' : '直播'}源会立即停用并从列表隐藏，
                已导入的频道与节目数据会保留；可在「数据治理」中恢复，或按保留期永久清理。
              </p>
            </AlertDialog.Body>
            <AlertDialog.Footer>
              <Button slot="close" variant="tertiary">
                取消
              </Button>
              <Button
                variant="danger"
                isPending={archive.isPending}
                onPress={() => {
                  void archive
                    .mutateAsync()
                    .then(() => {
                      setOpen(false);
                    })
                    .catch(() => {
                      // 失败经数据层 toast(409 SOURCE_BUSY 等);弹层保留可重试
                    });
                }}
              >
                归档来源
              </Button>
            </AlertDialog.Footer>
          </AlertDialog.Dialog>
        </AlertDialog.Container>
      </AlertDialog.Backdrop>
    </>
  );
}
