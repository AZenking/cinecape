/**
 * 当次密码确认弹层(T135,ADR-0011「逐次密码不豁免」+ FR-033):
 *
 * - 每个敏感写操作独立弹出一次:open=true 挂载,提交后服务端校验;成功立即关闭并
 *   清空内存密码(不缓存验证态,下一次敏感写重新输入);
 * - 验证失败(403 FAILED / 423 LOCKED)不关闭弹层、不清空已输入内容(「验证失败
 *   不丢表单内容」),以文字呈现服务端 detail,错误不只靠颜色;
 * - 密码仅组件内存,卸载/关闭即清,不写 localStorage;不进入地址/日志。
 */
import { useEffect, useState, type FormEvent, type ReactNode } from 'react';
import { Button, Form, Modal, TextField, Label, Input } from '@heroui/react';
import { isFetchApiError } from '../../../shared/fetch';

export interface PasswordConfirmModalProps {
  open: boolean;
  title: string;
  description?: string;
  submitLabel?: string;
  /** 提交当次密码;抛错 = 验证失败(弹层保持,内容保留);resolve = 成功(弹层关闭清空) */
  onSubmit: (ownerPassword: string) => Promise<void>;
  onClose: () => void;
}

export function PasswordConfirmModal({
  open,
  title,
  description,
  submitLabel = '确认执行',
  onSubmit,
  onClose,
}: PasswordConfirmModalProps): ReactNode {
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // 每次打开都是全新的一次性验证:清空上次输入与错误(不复用验证态)
  useEffect(() => {
    if (open) {
      setPassword('');
      setError(null);
      setBusy(false);
    }
  }, [open]);

  const handleSubmit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    if (busy) {
      return;
    }
    if (password === '') {
      setError('请输入主账号密码');
      return;
    }
    setBusy(true);
    setError(null);
    void onSubmit(password)
      .then(() => {
        setPassword(''); // 成功即清内存;下一次敏感写重新输入(不设可复用家长态)
        setError(null);
        onClose();
      })
      .catch((cause: unknown) => {
        // 失败:保留已输入内容(验证失败不丢表单),呈现服务端稳定文案
        setError(isFetchApiError(cause) ? (cause.detail ?? cause.title) : '验证失败,请重试');
      })
      .finally(() => {
        setBusy(false);
      });
  };

  return (
    <Modal.Root isOpen={open} onOpenChange={(next: boolean) => { if (!next && !busy) { onClose(); } }}>
      <Modal.Container placement="center" size="sm">
        <Modal.Dialog aria-label={title}>
          <Modal.Header>
            <Modal.Heading className="text-base font-semibold">{title}</Modal.Heading>
          </Modal.Header>
          <Modal.Body>
            <Form onSubmit={handleSubmit}>
              {description !== undefined ? <p className="text-sm text-muted">{description}</p> : null}
              <TextField className="w-full" value={password} onChange={setPassword} isDisabled={busy} autoComplete="off">
                <Label>主账号密码(当次验证)</Label>
                <Input name="ownerPassword" type="password" placeholder="••••••••" />
              </TextField>
              {error !== null ? (
                <p role="alert" className="text-sm text-danger">
                  {error}
                </p>
              ) : null}
              <div className="flex justify-end gap-2 pt-1">
                <Button type="button" variant="ghost" size="sm" onPress={onClose} isDisabled={busy} data-testid="password-cancel">
                  取消
                </Button>
                <Button type="submit" variant="primary" size="sm" isDisabled={busy || password === ''} data-testid="password-submit">
                  {busy ? '验证中…' : submitLabel}
                </Button>
              </div>
            </Form>
          </Modal.Body>
        </Modal.Dialog>
      </Modal.Container>
    </Modal.Root>
  );
}
