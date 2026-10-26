/**
 * 显式登录步骤(T041,FR-007):初始化成功或游客主动登录时展示。
 * - 错误凭据统一失败提示(不区分账号不存在/密码错误);忙时防重复提交;
 * - 成功后将 AccountSession 交回协调器(继续首建/选档意图或返回原目标);
 * - 密码仅表单内存,取消/关闭即清(formEpoch 重挂载),不写 localStorage。
 */
import { useState, type ReactNode } from 'react';
import { Button, Form } from '@heroui/react';
import { isFetchApiError, privateFetch } from '../../shared/fetch';
import { FormError, FormField } from './field';
import type { AccountSession } from '../../app/session-types';

export interface LoginStepProps {
  formEpoch: number;
  onSuccess: (session: AccountSession) => void;
  onCancel: () => void;
}

export function LoginStep({ formEpoch, onSuccess, onCancel }: LoginStepProps): ReactNode {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function handleSubmit(): Promise<void> {
    if (busy) return;
    setError(null);
    if (username.trim() === '' || password === '') {
      setError('请输入用户名与密码');
      return;
    }
    setBusy(true);
    try {
      const session = await privateFetch<AccountSession>('/auth/login', {
        method: 'POST',
        body: { username: username.trim(), password, deviceType: 'web' },
      });
      onSuccess(session);
    } catch (err) {
      // 统一失败提示:凭据相关失败不区分账号存在性
      if (isFetchApiError(err) && err.status === 401) {
        setError('用户名或密码错误');
      } else {
        setError('登录失败,请稍后重试');
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <Form
      key={`login-${formEpoch}`}
      onSubmit={(event) => {
        event.preventDefault();
        void handleSubmit();
      }}
      className="flex flex-col gap-4"
    >
      <FormField
        name="username"
        label="用户名"
        value={username}
        onValueChange={setUsername}
        isDisabled={busy}
        autoFocus
      />
      <FormField
        name="password"
        label="密码"
        type="password"
        value={password}
        onValueChange={setPassword}
        isDisabled={busy}
        autoComplete="current-password"
      />
      <FormError message={error} />
      <div className="flex justify-end gap-2">
        <Button variant="ghost" size="sm" onPress={onCancel} isDisabled={busy}>
          取消
        </Button>
        <Button variant="primary" size="sm" type="submit" isDisabled={busy}>
          {busy ? '正在登录…' : '登录'}
        </Button>
      </div>
    </Form>
  );
}
