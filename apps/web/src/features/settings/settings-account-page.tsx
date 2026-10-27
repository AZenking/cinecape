/**
 * 账号与安全页(T132,US8;FR-035;升级 US7 空架):
 * - 账号信息(AccountSummary 只读白名单);
 * - 经旧密码验证的密码修改:成功后旧会话与设置解锁全部失效 —— 页面立即停止读取
 *   设置主体(成功回调不再继续 GET),提示以新密码重新登录;收藏与历史保留;
 * - 表单验证失败(旧密码错误)不丢已输入内容;每敏感操作独立当次验证;
 * - 管理主体 403 SETTINGS_ACCESS_* 经 handleAccessLost 立即隐藏;重新解锁后以
 *   reloadEpoch 重读现值(FR-041)。
 */
import { useCallback, useEffect, useState, type FormEvent, type ReactNode } from 'react';
import { Button, Form, TextField, Label, Input } from '@heroui/react';
import { privateFetch } from '../../shared/fetch';
import { LoadingSpinner, RetryableAlert } from '../../shared/ui';
import { classifySettingsWriteError, POST_IDENTITY_CHANGE_NOTICE } from './shared/access-expiry';
import { errorTextOf, settingsApi, type AccountSummary } from './shared/settings-api';
import { useSettingsAccess } from './settings-access-provider';
import { useSettingsPageMeta } from './settings-modules';

type LoadState =
  | { phase: 'loading' }
  | { phase: 'ok'; summary: AccountSummary }
  | { phase: 'error'; message: string };

export function SettingsAccountPage(): ReactNode {
  const access = useSettingsAccess();
  const { title } = useSettingsPageMeta();
  const [state, setState] = useState<LoadState>({ phase: 'loading' });
  const [attempt, setAttempt] = useState(0);

  const load = useCallback((): void => {
    setState({ phase: 'loading' });
    void (async () => {
      try {
        const summary = await settingsApi.getAccount();
        setState({ phase: 'ok', summary });
      } catch (error) {
        if (classifySettingsWriteError(error) === 'access-lost') {
          access.handleAccessLost();
          return;
        }
        setState({ phase: 'error', message: errorTextOf(error) });
      }
    })();
  }, [access]);

  useEffect(() => {
    load();
  }, [load, access.reloadEpoch, attempt]);

  return (
    <section aria-label={`设置 · ${title}`} className="flex flex-1 flex-col gap-6 py-2">
      <h2 className="text-lg font-semibold text-foreground">{title}</h2>
      {state.phase === 'loading' ? <LoadingSpinner label="正在读取账号信息…" /> : null}
      {state.phase === 'error' ? (
        <RetryableAlert title="读取失败" description={state.message} onRetry={() => setAttempt((n) => n + 1)} />
      ) : null}
      {state.phase === 'ok' ? (
        <>
          <dl className="flex max-w-md flex-col gap-2 text-sm" data-testid="account-summary">
            <div className="flex justify-between gap-6 border-b border-border pb-2">
              <dt className="text-muted">用户名</dt>
              <dd className="font-medium text-foreground">{state.summary.username}</dd>
            </div>
            <div className="flex justify-between gap-6 border-b border-border pb-2">
              <dt className="text-muted">角色</dt>
              <dd className="font-medium text-foreground">{state.summary.role === 'owner' ? '所有者' : '管理员'}</dd>
            </div>
          </dl>
          <PasswordChangeSection username={state.summary.username} />
        </>
      ) : null}
    </section>
  );
}

function PasswordChangeSection({ username }: { username: string }): ReactNode {
  const [oldPassword, setOldPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);

  const handleSubmit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    if (busy || done) {
      return;
    }
    if (oldPassword === '' || newPassword === '' || confirmPassword === '') {
      setError('请完整填写旧密码与新密码');
      return;
    }
    if (newPassword.length < 8 || newPassword.length > 128) {
      setError('新密码长度须为 8~128 位');
      return;
    }
    if (newPassword !== confirmPassword) {
      setError('两次输入的新密码不一致');
      return;
    }
    setBusy(true);
    setError(null);
    void settingsApi
      .changePassword(oldPassword, newPassword)
      .then(() => {
        // 成功:旧会话/设置授予已服务端撤销 —— 不再读取任何设置主体,仅提示重登
        setDone(true);
        setOldPassword('');
        setNewPassword('');
        setConfirmPassword('');
      })
      .catch((cause: unknown) => {
        // 验证失败不丢表单:仅呈现服务端稳定文案
        setError(errorTextOf(cause));
      })
      .finally(() => {
        setBusy(false);
      });
  };

  if (done) {
    return (
      <div className="flex max-w-md flex-col gap-3" data-testid="password-change-done">
        <p role="status" className="text-sm text-success">{POST_IDENTITY_CHANGE_NOTICE.password}</p>
        <Button
          variant="primary"
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
    );
  }

  return (
    <Form onSubmit={handleSubmit} className="flex max-w-md flex-col gap-3" aria-label="修改密码">
      <h3 className="text-sm font-semibold text-foreground">修改密码</h3>
      <TextField className="w-full" value={oldPassword} onChange={setOldPassword} isDisabled={busy} autoComplete="off">
        <Label>当前密码({username} 的主账号密码)</Label>
        <Input name="ownerPassword" type="password" placeholder="••••••••" />
      </TextField>
      <TextField className="w-full" value={newPassword} onChange={setNewPassword} isDisabled={busy} autoComplete="new-password">
        <Label>新密码(8~128 位)</Label>
        <Input name="newPassword" type="password" placeholder="••••••••" />
      </TextField>
      <TextField className="w-full" value={confirmPassword} onChange={setConfirmPassword} isDisabled={busy} autoComplete="new-password">
        <Label>确认新密码</Label>
        <Input name="confirmPassword" type="password" placeholder="••••••••" />
      </TextField>
      {error !== null ? (
        <p role="alert" className="text-sm text-danger">
          {error}
        </p>
      ) : null}
      <p className="text-xs text-muted">
        修改成功后所有已登录会话与设置解锁立即失效,需要以新密码重新登录;Profile 收藏与观看历史保留。
      </p>
      <div className="flex justify-end">
        <Button type="submit" variant="primary" size="sm" isDisabled={busy} data-testid="password-change-submit">
          {busy ? '提交中…' : '修改密码'}
        </Button>
      </div>
    </Form>
  );
}
