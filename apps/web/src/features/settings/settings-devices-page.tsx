/**
 * 设备与会话页(T132,US8;FR-039;T025 数据层迁移;013/ADR-0017 演进):
 * - 设备列表(含已撤销标注)经 useAppQuery(settings.devices 键,硬请求 + isPending
 *   门控 / isError RetryableAlert(formatApiError + 重试)/ 成功出主体);
 * - 撤销:高危操作保留单次密码确认(PasswordConfirmModal,服务端 revoke 仍要求
 *   ownerPassword),成功后失效 settings.devices 键以服务端真值回填;撤销目标设备
 *   全部会话与授予;
 * - 设备播放记录查看:常规读取免当次密码(013/ADR-0017),点击直接执行(POST 查询:
 *   结果本页局部承载,不经查询缓存;不能用作个人历史),请求体不带 ownerPassword;
 * - 403 SETTINGS_ACCESS_* 经 handleAccessLost 立即隐藏;重新解锁后重挂硬请求。
 */
import { useEffect, useState, type ReactNode } from 'react';
import { Button, Chip } from '@heroui/react';
import { LoadingSpinner, RetryableAlert, useAppToast } from '../../shared/ui';
import { useAppMutation, useAppQuery } from '../../shared/query/hooks';
import { queryKeys } from '../../shared/query/keys';
import { formatApiError } from '../../shared/query/error';
import { privateFetch } from '../../shared/fetch';
import { formatDateTimeInZone } from '../../shared/time/format-datetime';
import { classifySettingsWriteError } from './shared/access-expiry';
import type { DeviceDto } from './shared/settings-api';
import { PasswordConfirmModal } from './shared/password-confirm-modal';
import { useHouseholdTimezone } from './shared/use-household-timezone';
import { useSettingsAccess } from './settings-access-provider';
import { useSettingsPageMeta } from './settings-modules';
import { SettingsPageHeader } from './shared/settings-page-header';
import { SettingsSection } from './shared/settings-section';

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
  const toast = useAppToast();
  /** 设备时间戳按家庭时区展示(服务端返回 UTC ISO) */
  const timezone = useHouseholdTimezone();
  const [revokeTarget, setRevokeTarget] = useState<DeviceDto | null>(null);
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

  // 撤销设备:高危操作保留单次密码(013/ADR-0017);成功后失效设备列表以服务端真值回填
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

  // 设备播放记录查询:常规读取免当次密码(013/ADR-0017)——结果不经查询缓存,局部承载
  const queryRecords = useAppMutation({
    domain: 'settings',
    feedback: 'confirmed',
    mutationFn: (vars: { deviceId: string }) =>
      privateFetch<{ items: Array<Record<string, unknown>>; nextCursor: string | null }>(
        `/settings/devices/${vars.deviceId}/playback-records/query`,
        { method: 'POST', body: { limit: 50 } },
      ),
  });

  const devices = devicesQuery.data ?? null;

  /** 播放记录按钮:直接执行查询(免当次密码),结果面板局部承载 */
  const openRecords = (device: DeviceDto): void => {
    void queryRecords
      .mutateAsync({ deviceId: device.id })
      .then((page) => {
        setRecordsPage({ device, items: page.items as unknown as PlaybackRecordItem[] });
      })
      .catch((cause: unknown) => {
        const kind = classifySettingsWriteError(cause);
        if (kind === 'access-lost') {
          access.handleAccessLost();
          return;
        }
        // 其余失败由 useAppMutation onError 统一经 toast 呈现
      });
  };

  return (
    <section aria-label={`设置 · ${title}`} data-testid="settings-devices-page" className="flex flex-1 flex-col gap-6 py-2">
      <SettingsPageHeader description="查看并管理已授权设备" />
      {devicesQuery.isPending ? <LoadingSpinner label="正在读取设备列表…" /> : null}
      {devicesQuery.isError ? (
        <RetryableAlert
          title="读取失败"
          description={formatApiError(devicesQuery.error)}
          onRetry={() => void devicesQuery.refetch()}
        />
      ) : null}
      {devices !== null ? (
        <>
          <SettingsSection title="已授权设备" description={`共 ${devices.length} 台设备`}>
            <ul className="flex flex-col gap-2" data-testid="device-list">
              {devices.map((device) => {
                const isRevoked = device.revokedAt !== null;
                return (
                  <li key={device.id} className="flex flex-wrap items-center justify-between gap-4 rounded-xl bg-background/40 px-4 py-3">
                    <div className="flex min-w-0 flex-col gap-1.5">
                      <div className="flex items-center gap-2">
                        <span className="truncate text-sm font-medium text-foreground">
                          {device.name ?? '(未命名设备)'}
                        </span>
                        <Chip size="sm" variant="soft">
                          {device.type}
                        </Chip>
                        {isRevoked ? (
                          <Chip size="sm" variant="soft" color="danger">
                            已撤销
                          </Chip>
                        ) : (
                          <Chip size="sm" variant="soft" color="success">
                            活跃
                          </Chip>
                        )}
                      </div>
                      <div className="text-xs text-muted">
                        {isRevoked ? (
                          <span className="text-danger">已于 {formatDateTimeInZone(device.revokedAt!, timezone, { seconds: true })} 撤销</span>
                        ) : (
                          <>
                            最近活跃:{device.lastSeenAt !== null ? formatDateTimeInZone(device.lastSeenAt, timezone, { seconds: true }) : '未知'}
                          </>
                        )}
                      </div>
                    </div>
                    <div className="flex items-center gap-2">
                      <Button
                        variant="secondary"
                        size="sm"
                        isDisabled={isRevoked}
                        onPress={() => openRecords(device)}
                        data-testid={`device-records-${device.id}`}
                      >
                        播放记录
                      </Button>
                      <Button
                        variant="danger-soft"
                        size="sm"
                        isDisabled={isRevoked}
                        onPress={() => {
                          setRevokeTarget(device);
                        }}
                        data-testid={`device-revoke-${device.id}`}
                      >
                        撤销
                      </Button>
                    </div>
                  </li>
                );
              })}
            </ul>
          </SettingsSection>
          <p className="text-xs text-muted">撤销后，该设备需要重新登录。</p>
        </>
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
                  toast.success('设备已撤销:其全部会话与授权立即失效');
                })
                .catch((cause: unknown) => {
                  const kind = classifySettingsWriteError(cause);
                  if (kind === 'access-lost') {
                    access.handleAccessLost();
                    return;
                  }
                  if (kind === 'not-found') {
                    toast.error('目标设备不存在或已撤销');
                    return;
                  }
                  throw cause; // 密码错误:弹层保持
                })
        }
        onClose={() => setRevokeTarget(null)}
      />

      {recordsPage !== null ? (
        <div data-testid="device-records">
          <SettingsSection
            title={`播放记录(${recordsPage.device.name ?? recordsPage.device.id})`}
            description="该设备最近的播放历史与异常记录"
            actions={
              <Button variant="ghost" size="sm" onPress={() => setRecordsPage(null)}>
                关闭
              </Button>
            }
            footer={<p className="text-xs text-muted">记录仅用于排查设备侧播放情况,不代表当前 Profile 的个人历史。</p>}
          >
            {recordsPage.items.length === 0 ? (
              <p className="py-4 text-center text-sm text-muted">该设备暂无播放与失败记录。</p>
            ) : (
              <ul className="flex flex-col gap-2 text-sm">
                {recordsPage.items.map((item) => (
                  <li key={item.id} className="flex items-center gap-2 rounded-lg border border-border/40 p-2.5">
                    <Chip size="sm" variant="soft" color={item.kind === 'session' ? 'accent' : 'danger'}>
                      {item.kind === 'session' ? '播放' : '失败'}
                    </Chip>
                    <span className="text-foreground">
                      {item.kind === 'session'
                        ? `${item.state ?? '未知状态'} · ${formatDateTimeInZone(item.createdAt ?? '', timezone, { seconds: true })}`
                        : `${item.stableCode ?? 'UNKNOWN'} · ${formatDateTimeInZone(item.occurredAt ?? '', timezone, { seconds: true })}`}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </SettingsSection>
        </div>
      ) : null}
    </section>
  );
}
