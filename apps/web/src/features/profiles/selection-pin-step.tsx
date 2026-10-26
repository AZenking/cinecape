/**
 * 选档 PIN 解锁步骤(T042,FR-008/FR-032):受 PIN 保护档案先验证再选择。
 * - 剩余失败次数提示来自服务端 403 detail;
 * - 423 PROFILE_PIN_LOCKED:展示锁定提示与重试入口;契约不提供剩余时间,
 *   不显示任何倒计时(锁定跨刷新/新会话保留,无法绕过);
 * - 忘记 PIN → pinRecovery 受限入口(账号密码恢复,成功后回本步骤用新 PIN 验证);
 * - PIN 仅表单内存,取消/切换步骤即清。
 */
import { useState, type ReactNode } from 'react';
import { Alert, AlertContent, AlertDescription, AlertTitle, Button, Form } from '@heroui/react';
import { isFetchApiError } from '../../shared/fetch';
import { validatePinInput, type FieldIssue } from '../../app/action-coordinator-core';
import { FormField } from '../auth/field';
import type { ProfileSummary } from '../../app/session-types';

export interface SelectionPinStepProps {
  profile: ProfileSummary;
  /** 解锁并选档(协调器执行:unlock → select;错误以 FetchApiError 抛回展示) */
  onSubmit: (pin: string) => Promise<void>;
  onForgotPin: () => void;
  onCancel: () => void;
}

export function SelectionPinStep({
  profile,
  onSubmit,
  onForgotPin,
  onCancel,
}: SelectionPinStepProps): ReactNode {
  const [pin, setPin] = useState('');
  const [issue, setIssue] = useState<FieldIssue | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [locked, setLocked] = useState(false);
  const [busy, setBusy] = useState(false);

  async function handleSubmit(): Promise<void> {
    if (busy || locked) return;
    setError(null);
    const validation = validatePinInput(pin);
    if (validation !== null) {
      setIssue(validation);
      return;
    }
    setIssue(null);
    setBusy(true);
    try {
      await onSubmit(pin);
      // 成功:协调器已完成选档并关闭弹层
    } catch (err) {
      if (isFetchApiError(err)) {
        if (err.code === 'PROFILE_PIN_LOCKED') {
          setLocked(true); // 锁定提示 + 重试入口;不显示契约未提供的剩余时间
        } else if (err.status === 403) {
          setError(err.detail ?? 'PIN 验证失败,请重试');
        } else {
          setError('验证失败,请重试');
        }
      } else {
        setError('网络异常,请稍后重试');
      }
    } finally {
      setBusy(false);
    }
  }

  if (locked) {
    return (
      <div className="flex flex-col gap-4">
        <Alert status="danger">
          <AlertContent>
            <AlertTitle>PIN 已锁定</AlertTitle>
            <AlertDescription>连续错误次数已达上限,请稍后再试。锁定期间正确 PIN 也无法验证。</AlertDescription>
          </AlertContent>
        </Alert>
        <div className="flex justify-between">
          <Button variant="ghost" size="sm" onPress={onCancel}>
            取消
          </Button>
          <Button
            variant="primary"
            size="sm"
            onPress={() => {
              setLocked(false);
              setPin('');
              setError(null);
            }}
          >
            重试
          </Button>
        </div>
      </div>
    );
  }

  return (
    <Form
      onSubmit={(event) => {
        event.preventDefault();
        void handleSubmit();
      }}
      className="flex flex-col gap-4"
    >
      <p className="text-sm text-muted">
        档案「{profile.name}」受 PIN 保护,请输入 6 位数字 PIN 完成选择。
      </p>
      <FormField
        name="pin"
        label="档案 PIN"
        value={pin}
        onValueChange={setPin}
        type="password"
        inputMode="numeric"
        maxLength={6}
        isDisabled={busy}
        isInvalid={issue !== null}
        errorMessage={issue?.message}
        autoFocus
      />
      {error !== null ? (
        <p role="alert" className="text-sm text-danger">
          {error}
        </p>
      ) : null}
      <div className="flex items-center justify-between">
        <button
          type="button"
          className="text-xs text-muted underline focus:outline-none focus-visible:ring-2 focus-visible:ring-focus"
          onClick={onForgotPin}
          disabled={busy}
        >
          忘记 PIN?
        </button>
        <div className="flex gap-2">
          <Button variant="ghost" size="sm" onPress={onCancel} isDisabled={busy}>
            取消
          </Button>
          <Button variant="primary" size="sm" type="submit" isDisabled={busy}>
            {busy ? '正在验证…' : '解锁并选择'}
          </Button>
        </div>
      </div>
    </Form>
  );
}
