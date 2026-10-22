/**
 * 设备管理页(T037,User Story 3 / FR-011/012)。
 *
 * - GET /devices 表格:名称 / 类型 / 最近活跃 / 状态 + 每行「撤销」按钮。
 * - 撤销:HeroUI AlertDialog 二次确认 → POST /devices/{id}/revoke(幂等,204)
 *   → 刷新列表;随后 await refresh():若撤销的正是当前会话所在设备,
 *   GET /auth/session 返回 401 → SessionProvider 置为 anonymous →
 *   路由守卫(RequireSession)自动重定向 /login(全局处理,见 lib/session)。
 * - SessionDto 未暴露当前设备 id,无法标记「本机」行,属契约限制。
 */
import { useCallback, useEffect, useState } from 'react';
import { Alert, AlertDialog, Button, Spinner, Table } from '@heroui/react';
import { ApiError, api } from '../lib/api';
import { useSession } from '../lib/session';
import type { components } from '@hmp/shared';

type DeviceDto = components['schemas']['DeviceDto'];

interface NoticeState {
  tone: 'success' | 'danger';
  message: string;
}

/** 设备类型中文标签(契约 DeviceDto.type) */
const DEVICE_TYPE_LABELS: Record<DeviceDto['type'], string> = {
  web: '网页',
  mobile: '移动设备',
  tv: '电视',
  nas: 'NAS',
  other: '其他',
};

/** date-time → 本地化展示;空/非法值显示「—」 */
function formatDateTime(iso: string | null | undefined): string {
  if (!iso) {
    return '—';
  }
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) {
    return '—';
  }
  return date.toLocaleString('zh-CN', { hour12: false });
}

function deviceLabel(device: DeviceDto): string {
  return device.name ?? `未命名设备(${DEVICE_TYPE_LABELS[device.type]})`;
}

export function Devices() {
  const { refresh: refreshSession } = useSession();

  const [devices, setDevices] = useState<DeviceDto[]>([]);
  const [loading, setLoading] = useState(true);
  const [listError, setListError] = useState<string | null>(null);
  const [notice, setNotice] = useState<NoticeState | null>(null);
  /** 待撤销设备(确认弹层目标) */
  const [revokeTarget, setRevokeTarget] = useState<DeviceDto | null>(null);
  const [revoking, setRevoking] = useState(false);

  const loadDevices = useCallback(async (): Promise<void> => {
    setLoading(true);
    setListError(null);
    try {
      const list = await api.get('/devices');
      setDevices(list);
    } catch (error) {
      setListError(
        error instanceof ApiError
          ? (error.detail ?? '设备列表加载失败,请稍后重试。')
          : '设备列表加载失败,请检查网络后重试。',
      );
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadDevices();
  }, [loadDevices]);

  const confirmRevoke = async (): Promise<void> => {
    const target = revokeTarget;
    if (!target || revoking) {
      return;
    }
    setRevoking(true);
    try {
      // 幂等:重复 revoke 同样 204
      await api.post(
        `/devices/${target.id}/revoke` as '/devices/{deviceId}/revoke',
      );
    } catch (error) {
      setRevoking(false);
      setNotice({
        tone: 'danger',
        message:
          error instanceof ApiError
            ? (error.detail ?? '撤销失败,请稍后重试。')
            : '撤销失败,请稍后重试。',
      });
      return;
    }
    setRevoking(false);
    setRevokeTarget(null);
    setNotice({ tone: 'success', message: `已撤销设备「${deviceLabel(target)}」` });
    // 先刷新会话:若本机即被撤销设备 → 401 → anonymous → 路由守卫转登录;
    // 否则再刷新设备列表。列表请求失败只影响展示,静默交给其自身错误态。
    await refreshSession();
    await loadDevices();
  };

  return (
    <section className="space-y-6">
      <div>
        <h1 className="text-xl font-semibold">设备管理</h1>
        <p className="mt-1 text-sm text-muted">
          撤销设备会使其全部会话立即失效;若撤销的是当前设备,将被自动登出。
        </p>
      </div>

      {notice && (
        <Alert status={notice.tone}>
          <Alert.Indicator />
          <Alert.Content>
            <Alert.Title>{notice.tone === 'success' ? '操作成功' : '操作失败'}</Alert.Title>
            <Alert.Description>{notice.message}</Alert.Description>
          </Alert.Content>
        </Alert>
      )}

      {loading ? (
        <div className="flex flex-col items-center gap-3 py-12">
          <Spinner size="lg" />
          <p className="text-sm text-muted">正在加载设备…</p>
        </div>
      ) : listError ? (
        <div className="space-y-4">
          <Alert status="danger">
            <Alert.Indicator />
            <Alert.Content>
              <Alert.Title>设备加载失败</Alert.Title>
              <Alert.Description>{listError}</Alert.Description>
            </Alert.Content>
          </Alert>
          <Button variant="outline" onPress={() => void loadDevices()}>
            重试
          </Button>
        </div>
      ) : devices.length === 0 ? (
        <p className="py-8 text-sm text-muted">还没有登录设备记录。</p>
      ) : (
        <Table.Root>
          <Table.ScrollContainer>
            <Table.Content aria-label="设备列表">
              <Table.Header>
                <Table.Column id="name" isRowHeader>
                  名称
                </Table.Column>
                <Table.Column id="type">类型</Table.Column>
                <Table.Column id="lastSeen">最近活跃</Table.Column>
                <Table.Column id="status">状态</Table.Column>
                <Table.Column id="actions">操作</Table.Column>
              </Table.Header>
              <Table.Body>
                {devices.map((device) => {
                  const revoked = device.revokedAt !== null && device.revokedAt !== undefined;
                  return (
                    <Table.Row key={device.id} id={device.id}>
                      <Table.Cell>{device.name ?? '未命名设备'}</Table.Cell>
                      <Table.Cell>{DEVICE_TYPE_LABELS[device.type]}</Table.Cell>
                      <Table.Cell>{formatDateTime(device.lastSeenAt)}</Table.Cell>
                      <Table.Cell>
                        {revoked ? (
                          <span className="text-warning">
                            已撤销({formatDateTime(device.revokedAt)})
                          </span>
                        ) : (
                          <span className="text-success">活跃</span>
                        )}
                      </Table.Cell>
                      <Table.Cell>
                        <Button
                          size="sm"
                          variant="danger-soft"
                          isDisabled={revoked}
                          onPress={() => setRevokeTarget(device)}
                        >
                          撤销
                        </Button>
                      </Table.Cell>
                    </Table.Row>
                  );
                })}
              </Table.Body>
            </Table.Content>
          </Table.ScrollContainer>
        </Table.Root>
      )}

      {/* 撤销确认对话框(HeroUI AlertDialog) */}
      <AlertDialog
        isOpen={revokeTarget !== null}
        onOpenChange={(open) => {
          if (!open) {
            setRevokeTarget(null);
          }
        }}
      >
        <AlertDialog.Backdrop isDismissable={!revoking}>
          <AlertDialog.Container placement="center">
            <AlertDialog.Dialog aria-label="确认撤销设备">
              <AlertDialog.Header>
                <AlertDialog.Heading>撤销设备</AlertDialog.Heading>
              </AlertDialog.Header>
              <AlertDialog.Body>
                <p>
                  确定撤销「{revokeTarget ? deviceLabel(revokeTarget) : ''}」吗?
                  该设备的全部会话将立即失效,此操作不可恢复。
                </p>
              </AlertDialog.Body>
              <AlertDialog.Footer>
                <Button
                  variant="ghost"
                  isDisabled={revoking}
                  onPress={() => setRevokeTarget(null)}
                >
                  取消
                </Button>
                <Button variant="danger" isPending={revoking} onPress={() => void confirmRevoke()}>
                  确认撤销
                </Button>
              </AlertDialog.Footer>
            </AlertDialog.Dialog>
          </AlertDialog.Container>
        </AlertDialog.Backdrop>
      </AlertDialog>
    </section>
  );
}
