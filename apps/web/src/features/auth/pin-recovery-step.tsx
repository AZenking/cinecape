/**
 * 主档案 PIN 恢复(T041,FR-030/ADR-0011 决议 6):受限入口 —— 当前账号密码 + 新
 * 6 位 PIN;成功后回到选档 PIN 验证(不直接打开设置、不签设置授权)。
 * 仅当目标受 PIN 保护的档案验证被锁定或用户忘记 PIN 时经「忘记 PIN?」进入。
 * 数据访问(T026):经 auth-api(privateFetch 档)发起,confirmed 语义无缓存
 * 写入;锁定计数在服务端,客户端仅呈现。
 */
import { useState, type ReactNode } from 'react';
import { Button, Form } from '@heroui/react';
import { isFetchApiError } from '../../shared/fetch';
import { validatePinInput, type FieldIssue } from '../../app/action-coordinator-core';
import { recoverMainProfilePin } from './auth-api';
import { FormError, FormField } from './field';
import { PinField } from '../../shared/ui';

export interface PinRecoveryStepProps {
  formEpoch: number;
  /** 恢复成功(204):协调器回到选档 PIN 步骤,以新 PIN 重新验证 */
  onSuccess: () => void;
  onCancel: () => void;
}

export function PinRecoveryStep({ formEpoch, onSuccess, onCancel }: PinRecoveryStepProps): ReactNode {
  const [newPin, setNewPin] = useState('');
  const [ownerPassword, setOwnerPassword] = useState('');
  const [issues, setIssues] = useState<FieldIssue | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function handleSubmit(): Promise<void> {
    if (busy) return;
    setError(null);
    const pinIssue = validatePinInput(newPin);
    if (pinIssue !== null) {
      setIssues(pinIssue);
      return;
    }
    if (ownerPassword === '') {
      setIssues({ field: 'ownerPassword', message: '请输入当前账号密码' });
      return;
    }
    setIssues(null);
    setBusy(true);
    try {
      // T026:经 auth-api 统一 PIN 恢复端点(204;服务端已撤销旧选档授予)
      await recoverMainProfilePin({ newPin, ownerPassword });
      onSuccess();
    } catch (err) {
      if (isFetchApiError(err)) {
        if (err.status === 403) {
          setError(err.detail ?? '账号密码验证失败,请重试');
        } else if (err.status === 423) {
          setError('密码验证已锁定,请稍后重试');
        } else {
          setError('PIN 恢复失败,请重试');
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
      key={`pin-recovery-${formEpoch}`}
      onSubmit={(event) => {
        event.preventDefault();
        void handleSubmit();
      }}
      className="flex flex-col gap-4"
    >
      <p className="text-sm text-muted">通过当前账号密码重设主档案 PIN。重设后需要用新 PIN 重新验证。</p>
      <PinField
        name="newPin"
        label="新 PIN(6 位数字)"
        value={newPin}
        onValueChange={setNewPin}
        isDisabled={busy}
        isInvalid={issues?.field === 'pin'}
        errorMessage={issues?.field === 'pin' ? issues.message : undefined}
        autoFocus
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
          返回
        </Button>
        <Button variant="primary" size="sm" type="submit" isDisabled={busy}>
          {busy ? '正在重设…' : '重设 PIN'}
        </Button>
      </div>
    </Form>
  );
}
