/**
 * 设备与会话页(T132,US8;FR-039):
 * - 设备列表(含已撤销标注);
 * - 撤销:确认 + 当次密码弹层,撤销目标设备全部会话与授予;
 * - 设备播放记录查看:当次密码再验证后按设备查询(不能用作个人历史);
 * - 每敏感操作独立弹当次密码确认,验证失败不丢已输入内容(弹层内保留)。
 */
import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { Button } from '@heroui/react';
import { LoadingSpinner, RetryableAlert } from '../../shared/ui';
import { classifySettingsWriteError } from './shared/access-expiry';
import { errorTextOf, settingsApi, type DeviceDto } from './shared/settings-api';
import { PasswordConfirmModal } from './shared/password-confirm-modal';
import { useSettingsAccess } from './settings-access-provider';
import { useSettingsPageMeta } from './settings-modules';

interface PlaybackRecordItem {
  kind: 'session' | 'failure';
  id: string;
  occurredAt?: string;
  createdAt?: string;
  mediaId?: string | null;
  state?: string;
  stableCode?: string;
}

export function SettingsDevicesPage(): ReactNode {
  const access = useSettingsAccess();
  const { title } = useSettingsPageMeta();
  const [devices, setDevices] = useState<DeviceDto[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [revokeTarget, setRevokeTarget] = useState<DeviceDto | null>(null);
  const [recordsTarget, setRecordsTarget] = useState<DeviceDto | null>(null);
  const [pageError, setPageError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [recordsPage, setRecordsPage] = useState<{ device: DeviceDto; items: PlaybackRecordItem[] } | null>(null);

  const load = useCallback((): void => {
    void (async () => {
      try {
        setDevices(await settingsApi.listDevices());
        setLoadError(null);
      } catch (error) {
        if (classifySettingsWriteError(error) === 'access-lost') {
          access.handleAccessLost();
          return;
        }
        setLoadError(errorTextOf(error));
      }
    })();
  }, [access]);

  useEffect(() => {
    load();
  }, [load, access.reloadEpoch, attempt]);

  return (
    <section aria-label={`设置 · ${title}`} className="flex flex-1 flex-col gap-4 py-2">
      <h2 className="text-lg font-semibold text-foreground">{title}</h2>
      {devices === null && loadError === null ? <LoadingSpinner label="正在读取设备列表…" /> : null}
      {loadError !== null ? (
        <RetryableAlert title="读取失败" description={loadError} onRetry={() => setAttempt((n) => n + 1)} />
      ) : null}
      {pageError !== null ? (
        <p role="alert" className="text-sm text-danger">{pageError}</p>
      ) : null}
      {notice !== null ? (
        <p role="status" className="text-sm text-success" data-testid="devices-notice">{notice}</p>
      ) : null}
      {devices !== null ? (
        <ul className="flex flex-col gap-2" data-testid="device-list">
          {devices.map((device) => (
            <li key={device.id} className="flex flex-wrap items-center justify-between gap-3 rounded border border-border p-3">
              <div className="flex min-w-0 flex-col">
                <span className="truncate text-sm font-medium text-foreground">
                  {device.name ?? '(未命名设备)'}
                  <span className="ml-2 rounded bg-surface px-1.5 py-0.5 text-xs text-muted">{device.type}</span>
                </span>
                <span className="text-xs text-muted">
                  {device.revokedAt !== null ? (
                    <span className="text-danger">已于 {device.revokedAt.slice(0, 19).replace('T', ' ')} 撤销</span>
                  ) : (
                    <>
                      最近活跃:{device.lastSeenAt !== null ? device.lastSeenAt.slice(0, 19).replace('T', ' ') : '未知'}
                    </>
                  )}
                </span>
              </div>
              <div className="flex gap-2">
                <Button
                  variant="ghost"
                  size="sm"
                  isDisabled={device.revokedAt !== null}
                  onPress={() => {
                    setPageError(null);
                    setRecordsTarget(device);
                  }}
                  data-testid={`device-records-${device.id}`}
                >
                  播放记录
                </Button>
                <Button
                  variant="danger"
                  size="sm"
                  isDisabled={device.revokedAt !== null}
                  onPress={() => {
                    setPageError(null);
                    setRevokeTarget(device);
                  }}
                  data-testid={`device-revoke-${device.id}`}
                >
                  撤销设备
                </Button>
              </div>
            </li>
          ))}
        </ul>
      ) : null}

      <PasswordConfirmModal
        open={revokeTarget !== null}
        title="撤销设备"
        description={
          revokeTarget !== null
            ? `将撤销「${revokeTarget.name ?? revokeTarget.id}」上的全部会话与设置授权,该设备需要重新登录。`
            : ''
        }
        submitLabel="确认撤销"
        onSubmit={(ownerPassword: string) =>
          revokeTarget === null
            ? Promise.reject(new Error('no target'))
            : settingsApi.revokeDevice(revokeTarget.id, ownerPassword).then(
                () => {
                  setNotice('设备已撤销:其全部会话与授权立即失效');
                  load();
                },
                (cause: unknown) => {
                  const kind = classifySettingsWriteError(cause);
                  if (kind === 'access-lost') {
                    access.handleAccessLost();
                    return;
                  }
                  if (kind === 'not-found') {
                    setPageError('目标设备不存在或已撤销');
                    return;
                  }
                  throw cause; // 密码错误:弹层保持
                },
              )
        }
        onClose={() => setRevokeTarget(null)}
      />

      <PasswordConfirmModal
        open={recordsTarget !== null}
        title="查询设备播放记录"
        description={recordsTarget !== null ? `查询「${recordsTarget.name ?? recordsTarget.id}」的播放记录(需当次密码)。` : ''}
        submitLabel="查询"
        onSubmit={(ownerPassword: string) =>
          recordsTarget === null
            ? Promise.reject(new Error('no target'))
            : settingsApi.queryPlaybackRecords(recordsTarget.id, { ownerPassword, limit: 50 }).then(
                (page) => {
                  setRecordsPage({ device: recordsTarget, items: page.items as unknown as PlaybackRecordItem[] });
                },
                (cause: unknown) => {
                  const kind = classifySettingsWriteError(cause);
                  if (kind === 'access-lost') {
                    access.handleAccessLost();
                    return;
                  }
                  throw cause;
                },
              )
        }
        onClose={() => setRecordsTarget(null)}
      />
      {recordsPage !== null ? (
        <div className="flex flex-col gap-2" data-testid="device-records">
          <div className="flex items-center justify-between">
            <h3 className="text-sm font-semibold text-foreground">播放记录({recordsPage.device.name ?? recordsPage.device.id})</h3>
            <Button variant="ghost" size="sm" onPress={() => setRecordsPage(null)}>
              关闭
            </Button>
          </div>
          {recordsPage.items.length === 0 ? (
            <p className="text-sm text-muted">该设备暂无播放与失败记录。</p>
          ) : (
            <ul className="flex flex-col gap-1 text-sm">
              {recordsPage.items.map((item) => (
                <li key={item.id} className="rounded border border-border px-3 py-1.5">
                  <span className="mr-2 rounded bg-surface px-1.5 py-0.5 text-xs text-muted">
                    {item.kind === 'session' ? '播放' : '失败'}
                  </span>
                  <span className="text-foreground">
                    {item.kind === 'session'
                      ? `${item.state ?? '未知状态'} · ${(item.createdAt ?? '').slice(0, 19).replace('T', ' ')}`
                      : `${item.stableCode ?? 'UNKNOWN'} · ${(item.occurredAt ?? '').slice(0, 19).replace('T', ' ')}`}
                  </span>
                </li>
              ))}
            </ul>
          )}
          <p className="text-xs text-muted">记录仅用于排查设备侧播放情况,不代表当前 Profile 的个人历史。</p>
        </div>
      ) : null}
    </section>
  );
}
