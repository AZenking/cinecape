/**
 * 首建主档案步骤(T041,FR-030):零档案会话经名称 + 6 位数字 PIN + 当次账号密码
 * 创建成人主 Profile;成功后仅通知父层进入选档(不静默激活主档案),可取消返回
 * 公共浏览。客户端先行校验(名称与 6 位数字 PIN),密码仅表单内存。
 */
import { useState, type ReactNode } from 'react';
import { Button, Form } from '@heroui/react';
import { isFetchApiError, privateFetch } from '../../shared/fetch';
import { validateBootstrapInput } from '../../app/action-coordinator-core';
import { FormError, FormField } from './field';
import type { ProfileSummary } from '../../app/session-types';

export interface BootstrapStepProps {
  formEpoch: number;
  onSuccess: (profile: ProfileSummary) => void;
  onCancel: () => void;
}

export function BootstrapStep({ formEpoch, onSuccess, onCancel }: BootstrapStepProps): ReactNode {
  const [name, setName] = useState('');
  const [pin, setPin] = useState('');
  const [ownerPassword, setOwnerPassword] = useState('');
  const [issues, setIssues] = useState<{ field: string; message: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function handleSubmit(): Promise<void> {
    if (busy) return;
    setError(null);
    const validation = validateBootstrapInput({ name, pin, ownerPassword });
    if (validation !== null) {
      setIssues(validation);
      return;
    }
    setIssues(null);
    setBusy(true);
    try {
      const profile = await privateFetch<ProfileSummary>('/auth/bootstrap-profile', {
        method: 'POST',
        body: { name: name.trim(), pin, ownerPassword },
      });
      // 成功:进入选档(picker),不自动激活主档案(服务端不设置 active_profile_id)
      onSuccess(profile);
    } catch (err) {
      if (isFetchApiError(err)) {
        if (err.status === 409) {
          setError('家庭已存在档案,请直接选择 Profile');
        } else if (err.status === 403) {
          setError(err.detail ?? '账号密码验证失败,请重试');
        } else if (err.status === 423) {
          setError('密码验证已锁定,请稍后重试');
        } else {
          setError('首建失败,请重试');
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
      key={`bootstrap-${formEpoch}`}
      onSubmit={(event) => {
        event.preventDefault();
        void handleSubmit();
      }}
      className="flex flex-col gap-4"
    >
      <p className="text-sm text-muted">首次使用需要先创建家庭的主档案。创建后即可选择观看者。</p>
      <FormField
        name="name"
        label="档案名称"
        value={name}
        onValueChange={setName}
        isDisabled={busy}
        isInvalid={issues?.field === 'name'}
        errorMessage={issues?.field === 'name' ? issues.message : undefined}
        autoFocus
        maxLength={50}
      />
      <FormField
        name="pin"
        label="档案 PIN(6 位数字)"
        value={pin}
        onValueChange={setPin}
        type="password"
        inputMode="numeric"
        maxLength={6}
        isDisabled={busy}
        isInvalid={issues?.field === 'pin'}
        errorMessage={issues?.field === 'pin' ? issues.message : undefined}
      />
      <FormField
        name="ownerPassword"
        label="当前账号密码"
        value={ownerPassword}
        onValueChange={setOwnerPassword}
        type="password"
        isDisabled={busy}
        isInvalid={issues?.field === 'ownerPassword'}
        errorMessage={issues?.field === 'ownerPassword' ? issues.message : undefined}
        autoComplete="current-password"
      />
      <FormError message={error} />
      <div className="flex justify-end gap-2">
        <Button variant="ghost" size="sm" onPress={onCancel} isDisabled={busy}>
          取消
        </Button>
        <Button variant="primary" size="sm" type="submit" isDisabled={busy}>
          {busy ? '正在创建…' : '创建主档案'}
        </Button>
      </div>
    </Form>
  );
}
