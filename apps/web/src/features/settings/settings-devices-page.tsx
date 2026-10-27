/**
 * 设备与会话页(T132,US8;FR-039;T025 数据层迁移):
 * - 设备列表(含已撤销标注)经 useAppQuery(settings.devices 键,硬请求 + isPending
 *   门控 / isError RetryableAlert(formatApiError + 重试)/ 成功出主体);
 * - 撤销:confirmed 变更(确认 + 当次密码弹层),成功后失效 settings.devices 键以
 *   服务端真值回填(替代原手工 load());撤销目标设备全部会话与授予;
 * - 设备播放记录查看:当次密码再验证后按设备查询(POST 敏感读取:凭据不进查询
 *   缓存,结果本页局部承载;不能用作个人历史);
 * - 每敏感操作独立弹当次密码确认,验证失败不丢已输入内容(弹层内保留);
 * - 403 SETTINGS_ACCESS_* 经 handleAccessLost 立即隐藏;重新解锁后重挂硬请求。
 */
import { useEffect, useState, type ReactNode } from 'react';
import { Button } from '@heroui/react';
import { LoadingSpinner, RetryableAlert } from '../../shared/ui';
import { useAppMutation, useAppQuery } from '../../shared/query/hooks';
import { queryKeys } from '../../shared/query/keys';
import { formatApiError } from '../../shared/query/error';
import { privateFetch } from '../../shared/fetch';
import { classifySettingsWriteError } from './shared/access-expiry';
import type { DeviceDto } from './shared/settings-api';
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
  const [revokeTarget, setRevokeTarget] = useState<DeviceDto | null>(null);
  const [recordsTarget, setRecordsTarget] = useState<DeviceDto | null>(null);
  const [pageError, setPageError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [recordsPage, setRecordsPage] = useState<{ device: DeviceDto; items: PlaybackRecordItem[] } | null>(null);

  const devicesQuery = useAppQuery<DeviceDto[]>({
    domain: 'settings',
    queryKey: queryKeys.settings.devices(),
    queryFn: ({ signal }) => privateFetch<DeviceDto[]>('/settings/devices', { signal }),
  });

  // 管理主体读取得到 403 SETTINGS_ACCESS_*:立即回到锁定态(解锁门随之隐藏本页)
  useEffect(() => {
    if (devicesQuery.isError && classifySettingsWriteError(devicesQuery.error) === 'access-lost') {
      access.handleAccessLost();
    }
  }, [devicesQuery.isError, devicesQuery.error, access]);

  // 撤销设备:confirmed 变更(当次密码);成功后失效设备列表以服务端真值回填
  const revokeDevice = useAppMutation({
    domain: 'settings',
    feedback: 'confirmed',
    mutationFn: (vars: { deviceId: string; ownerPassword: string }) =>
      privateFetch<void>(`/settings/devices/${vars.deviceId}/revoke`, {
        method: 'POST',
        body: { ownerPassword: vars.ownerPassword },
      }),
    invalidate: [queryKeys.settings.devices()],
  });

  // 设备播放记录查询:POST 敏感读取(当次密码)——不经查询缓存保留凭据,结果局部承载
  const queryRecords = useAppMutation({
    domain: 'settings',
    feedback: 'confirmed',
    mutationFn: (vars: { deviceId: string; ownerPassword: string }) =>
      privateFetch<{ items: Array<Record<string, unknown>>; nextCursor: string | null }>(
        `/settings/devices/${vars.deviceId}/playback-records/query`,
        { method: 'POST', body: { ownerPassword: vars.ownerPassword, limit: 50 } },
      ),
  });

  const devices = devicesQuery.data ?? null;

  return (
    <section aria-label={`设置 · ${title}`} className="flex flex-1 flex-col gap-4 py-2">
      <h2 className="text-lg font-semibold text-foreground">{title}</h2>
      {devicesQuery.isPending ? <LoadingSpinner label="正在读取设备列表…" /> : null}
      {devicesQuery.isError ? (
        <RetryableAlert
          title="读取失败"
          description={formatApiError(devicesQuery.error)}
          onRetry={() => void devicesQuery.refetch()}
        />
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
            : revokeDevice
                .mutateAsync({ deviceId: revokeTarget.id, ownerPassword })
                .then(() => {
                  setNotice('设备已撤销:其全部会话与授权立即失效');
                })
                .catch((cause: unknown) => {
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
                })
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
            : queryRecords
                .mutateAsync({ deviceId: recordsTarget.id, ownerPassword })
                .then((page) => {
                  setRecordsPage({ device: recordsTarget, items: page.items as unknown as PlaybackRecordItem[] });
                })
                .catch((cause: unknown) => {
                  const kind = classifySettingsWriteError(cause);
                  if (kind === 'access-lost') {
                    access.handleAccessLost();
                    return;
                  }
                  throw cause;
                })
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
