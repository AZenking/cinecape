/**
 * 账号与安全页(T132,US8;FR-035;T025 数据层迁移):
 * - 账号信息(AccountSummary 只读白名单)经 useAppQuery(settings 域硬请求):
 *   isPending 骨架门控 / isError RetryableAlert(formatApiError + 显式重试)/ 成功出主体;
 * - 经旧密码验证的密码修改为 confirmed 变更(等待态门控提交按钮,等待服务端确认):
 *   成功后旧会话与设置解锁全部在服务端失效 —— 变更声明零失效集合,成功回调不再
 *   读取任何设置主体,仅提示以新密码重新登录;收藏与历史保留;
 * - 表单验证失败(旧密码错误)不丢已输入内容;每敏感操作独立当次验证;
 * - 管理主体 403 SETTINGS_ACCESS_* 经 handleAccessLost 立即隐藏(解锁门卸载本页,
 *   重新解锁后重挂 —— settings 域挂载即清硬请求,等价原 reloadEpoch 重读,FR-041)。
 */
import { useEffect, useState, type FormEvent, type ReactNode } from 'react';
import { Button, Chip, Form, Input, Label, Separator, TextField } from '@heroui/react';
import { privateFetch, isFetchApiError } from '../../shared/fetch';
import { LoadingSpinner, RetryableAlert, useAppToast } from '../../shared/ui';
import { useAppMutation, useAppQuery } from '../../shared/query/hooks';
import { queryKeys } from '../../shared/query/keys';
import { formatApiError } from '../../shared/query/error';
import { classifySettingsWriteError, POST_IDENTITY_CHANGE_NOTICE } from './shared/access-expiry';
import type { AccountSummary } from './shared/settings-api';
import { useSettingsAccess } from './settings-access-provider';
import { useSettingsPageMeta } from './settings-modules';
import { SettingsPageHeader } from './shared/settings-page-header';
import { SettingsSection } from './shared/settings-section';

export function SettingsAccountPage(): ReactNode {
  const access = useSettingsAccess();
  const { title } = useSettingsPageMeta();
  const account = useAppQuery<AccountSummary>({
    domain: 'settings',
    queryKey: queryKeys.settings.account(),
    queryFn: ({ signal }) => privateFetch<AccountSummary>('/settings/account', { signal }),
  });

  // 管理主体读取得到 403 SETTINGS_ACCESS_*:立即回到锁定态(解锁门随之隐藏本页)
  useEffect(() => {
    if (account.isError && classifySettingsWriteError(account.error) === 'access-lost') {
      access.handleAccessLost();
    }
  }, [account.isError, account.error, access]);

  return (
    <section aria-label={`设置 · ${title}`} data-testid="settings-account-page" className="flex flex-1 flex-col gap-6 py-2">
      <SettingsPageHeader description="管理登录身份与账号安全" />
      {account.isPending ? <LoadingSpinner label="正在读取账号信息…" /> : null}
      {account.isError ? (
        <RetryableAlert
          title="读取失败"
          description={formatApiError(account.error)}
          onRetry={() => void account.refetch()}
        />
      ) : null}
      {account.data ? (
        <>
          <div className="w-full" data-testid="account-summary">
            <SettingsSection title="账号信息">
              <dl className="flex flex-col gap-3 text-sm">
                <div className="flex items-center justify-between py-1">
                  <dt className="text-muted">用户名</dt>
                  <dd className="font-medium text-foreground">{account.data.username}</dd>
                </div>
                <Separator />
                <div className="flex items-center justify-between py-1">
                  <dt className="text-muted">角色</dt>
                  <dd>
                    <Chip size="sm" variant="soft" color={account.data.role === 'owner' ? 'accent' : 'default'}>
                      {account.data.role === 'owner' ? '所有者' : '管理员'}
                    </Chip>
                  </dd>
                </div>
              </dl>
            </SettingsSection>
          </div>
          <PasswordChangeSection username={account.data.username} />
        </>
      ) : null}
    </section>
  );
}

function PasswordChangeSection({ username }: { username: string }): ReactNode {
  const access = useSettingsAccess();
  const toast = useAppToast();
  const [oldPassword, setOldPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [done, setDone] = useState(false);

  // 改密:confirmed 变更(无乐观写,等待服务端确认)。invalidate 刻意为空:
  // 成功后旧会话与全部设置授予已被服务端撤销,任何设置域重读都不应再发生。
  const changePassword = useAppMutation({
    domain: 'settings',
    feedback: 'confirmed',
    mutationFn: (vars: { currentPassword: string; newPassword: string }) =>
      privateFetch<void>('/settings/account/password', {
        method: 'PUT',
        body: { currentPassword: vars.currentPassword, newPassword: vars.newPassword },
      }),
  });
  const busy = changePassword.isPending;

  const handleSubmit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    if (busy || done) {
      return;
    }
    if (oldPassword === '' || newPassword === '' || confirmPassword === '') {
      toast.error('请完整填写当前密码与新密码');
      return;
    }
    if (newPassword.length < 8 || newPassword.length > 128) {
      toast.error('新密码长度须为 8~128 位');
      return;
    }
    if (newPassword !== confirmPassword) {
      toast.error('两次输入的新密码不一致');
      return;
    }
    void changePassword
      .mutateAsync({ currentPassword: oldPassword, newPassword })
      .then(() => {
        // 成功:旧会话/设置授予已服务端撤销 —— 不再读取任何设置主体,仅提示重登
        setDone(true);
        setOldPassword('');
        setNewPassword('');
        setConfirmPassword('');
        toast.success(POST_IDENTITY_CHANGE_NOTICE.password);
      })
      .catch((cause: unknown) => {
        // 验证失败不丢表单:结果提示统一走 toast(底部居中),表单内容保留
        const kind = classifySettingsWriteError(cause);
        if (kind === 'access-lost') {
          access.handleAccessLost();
          return;
        }
        if (isFetchApiError(cause)) {
          if (cause.status === 401) {
            toast.error('会话已失效，请重新登录');
            return;
          }
          if (cause.status === 403) {
            toast.error(cause.detail ?? cause.title ?? '当前密码错误或无权限修改');
            return;
          }
        }
        toast.error(formatApiError(cause));
      });
  };

  if (done) {
    return (
      <div className="w-full">
        <SettingsSection title="修改密码" description="主账号密码修改已完成">
          <div className="flex flex-col gap-4" data-testid="password-change-done">
            <div className="flex justify-end">
              <Button
                variant="secondary"
                size="sm"
                onPress={() => {
                  // 跳转登录:服务端会话已失效;由公共登录弹层流程重新建立会话
                  void privateFetch<void>('/auth/logout', { method: 'POST' })
                    .catch(() => undefined)
                    .finally(() => {
                      window.location.assign('/?intent=login');
                    });
                }}
              >
                使用新密码重新登录
              </Button>
            </div>
          </div>
        </SettingsSection>
      </div>
    );
  }

  return (
    <div className="w-full">
      <Form onSubmit={handleSubmit} data-testid="account-password-form" className="flex flex-col gap-4" aria-label="修改密码">
        <SettingsSection title="修改密码" description="新密码须为 8~128 位">
          <div className="flex flex-col gap-5">
            <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
              <div className="flex flex-col gap-1">
                <span className="text-sm font-medium text-foreground">当前密码</span>
                <span className="text-xs text-muted">{username} 的主账号密码</span>
              </div>
              <TextField className="w-full shrink-0 sm:w-64" value={oldPassword} onChange={setOldPassword} isDisabled={busy} autoComplete="off">
                <Label className="sr-only">当前密码({username} 的主账号密码)</Label>
                <Input name="currentPassword" type="password" placeholder="••••••••" variant="secondary" data-testid="current-password-input" />
              </TextField>
            </div>
            <Separator />
            <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
              <div className="flex flex-col gap-1">
                <span className="text-sm font-medium text-foreground">新密码</span>
                <span className="text-xs text-muted">8~128 位</span>
              </div>
              <TextField className="w-full shrink-0 sm:w-64" value={newPassword} onChange={setNewPassword} isDisabled={busy} autoComplete="new-password">
                <Label className="sr-only">新密码(8~128 位)</Label>
                <Input name="newPassword" type="password" placeholder="••••••••" variant="secondary" data-testid="new-password-input" />
              </TextField>
            </div>
            <Separator />
            <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
              <div className="flex flex-col gap-1">
                <span className="text-sm font-medium text-foreground">确认新密码</span>
                <span className="text-xs text-muted">再次输入新密码</span>
              </div>
              <TextField className="w-full shrink-0 sm:w-64" value={confirmPassword} onChange={setConfirmPassword} isDisabled={busy} autoComplete="new-password">
                <Label className="sr-only">确认新密码</Label>
                <Input name="confirmPassword" type="password" placeholder="••••••••" variant="secondary" data-testid="confirm-password-input" />
              </TextField>
            </div>
          </div>
          <Button type="submit" variant="secondary" size="sm" className="self-start" isDisabled={busy} data-testid="password-change-submit">
            {busy ? '提交中…' : '修改密码'}
          </Button>
        </SettingsSection>
        <p className="text-xs text-muted">修改后所有设备需要重新登录；收藏与观看历史会保留。</p>
      </Form>
    </div>
  );
}
