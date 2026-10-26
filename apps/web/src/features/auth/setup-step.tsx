/**
 * 初始化步骤(T041,FR-006/007):仅未初始化时展示的配置弹窗内容。
 * - 仅配置家庭与主账号基础(不含来源/节目单导入字段 —— 契约 strictObject,
 *   多余字段服务端 400);
 * - 201 后仅通知父层进入显式登录(不自动登录);
 * - /setup/status 503(状态未知)不进入本表单 —— 由协调器呈现 setup-unavailable
 *   重试态,不误判为未初始化而开放配置;
 * - 密码仅表单内存,关闭/取消即清(formEpoch 重挂载)。
 */
import { useState, type ReactNode } from 'react';
import { Button, Form } from '@heroui/react';
import { isFetchApiError, privateFetch } from '../../shared/fetch';
import { FormError, FormField } from './field';
import type { InitializedReply } from '../../app/session-types';

export interface SetupStepProps {
  /** 凭据清空信号:变化即重挂载清空内存表单 */
  formEpoch: number;
  onSuccess: () => void;
  onCancel: () => void;
}

export function SetupStep({ formEpoch, onSuccess, onCancel }: SetupStepProps): ReactNode {
  const [householdName, setHouseholdName] = useState('');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function handleSubmit(): Promise<void> {
    if (busy) return; // 忙时防重复提交
    setError(null);
    if (householdName.trim() === '' || username.trim() === '' || password === '') {
      setError('请完整填写家庭名称、管理员用户名与密码');
      return;
    }
    setBusy(true);
    try {
      await privateFetch<InitializedReply>('/setup/initialize', {
        method: 'POST',
        body: { householdName: householdName.trim(), username: username.trim(), password },
      });
      // 201:仅建家庭与账号,进入显式登录(不自动登录,FR-007)
      onSuccess();
    } catch (err) {
      if (isFetchApiError(err)) {
        if (err.status === 409) {
          setError('本部署已完成初始化,请直接登录');
        } else if (err.status === 503) {
          setError('初始化状态未知,请稍后重试');
        } else {
          setError('初始化失败,请检查输入后重试');
        }
      } else {
        setError('网络异常,请稍后重试');
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <Form
      key={`setup-${formEpoch}`}
      onSubmit={(event) => {
        event.preventDefault();
        void handleSubmit();
      }}
      className="flex flex-col gap-4"
    >
      <FormField
        name="householdName"
        label="家庭名称"
        value={householdName}
        onValueChange={setHouseholdName}
        isDisabled={busy}
        autoFocus
        maxLength={100}
      />
      <FormField
        name="username"
        label="管理员用户名"
        value={username}
        onValueChange={setUsername}
        isDisabled={busy}
        maxLength={64}
      />
      <FormField
        name="password"
        label="密码"
        type="password"
        value={password}
        onValueChange={setPassword}
        isDisabled={busy}
        autoComplete="new-password"
      />
      <FormError message={error} />
      <div className="flex justify-end gap-2">
        <Button variant="ghost" size="sm" onPress={onCancel} isDisabled={busy}>
          取消
        </Button>
        <Button variant="primary" size="sm" type="submit" isDisabled={busy}>
          {busy ? '正在创建…' : '创建家庭账号'}
        </Button>
      </div>
    </Form>
  );
}
