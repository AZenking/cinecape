/**
 * 家长验证弹窗(阶段 2,T013;US1 策略保存与 US3 档案管理/切换共用)。
 *
 * - 每次管理写操作前重新输入主账号密码(FR-004/ADR-0006):owner 会话可能正被
 *   儿童共用,会话角色不能替代家长身份;
 * - 弹窗不缓存密码:打开即清空、提交后立即清空;密码绝不写入
 *   localStorage / URL / 日志(FR-014);
 * - 验证结果仅当次请求有效,服务端不发放长期"家长模式"令牌;
 * - 验证失败(403 FAILED / 423 LOCKED)由调用方以 error 传入展示,弹窗保持打开,
 *   由服务端计数与锁定统一限流。
 */
import { useEffect, useState } from 'react';
import { Alert, Button, FieldError, Input, Label, Modal, TextField } from '@heroui/react';

export interface ParentVerificationModalProps {
  isOpen: boolean;
  /** 弹窗标题(默认「家长验证」) */
  title?: string;
  /** 场景说明,如「保存内容策略」 */
  description?: string;
  /** 提交中:禁用输入与取消,防双击 */
  isPending?: boolean;
  /** 服务端返回的验证错误(403/423 的 detail);null 表示无错误 */
  error?: string | null;
  onCancel: () => void;
  /** 确认:回调收到明文密码,仅用于当次请求;回调返回后弹窗立即清空输入 */
  onConfirm: (password: string) => void;
}

export function ParentVerificationModal({
  isOpen,
  title = '家长验证',
  description,
  isPending = false,
  error = null,
  onCancel,
  onConfirm,
}: ParentVerificationModalProps) {
  const [password, setPassword] = useState('');

  // 打开时重置输入;提交后由 handleSubmit 清空 —— 弹窗内密码不作任何保留
  useEffect(() => {
    if (isOpen) {
      setPassword('');
    }
  }, [isOpen]);

  const handleSubmit = (): void => {
    if (isPending || password === '') {
      return;
    }
    const submitted = password;
    setPassword(''); // 当次提交后立即清空
    onConfirm(submitted);
  };

  return (
    <Modal
      isOpen={isOpen}
      onOpenChange={(open) => {
        if (!open && !isPending) {
          onCancel();
        }
      }}
    >
      <Modal.Backdrop isDismissable={!isPending} isKeyboardDismissDisabled={isPending}>
        <Modal.Container placement="center">
          <Modal.Dialog aria-label={title}>
            <Modal.Body className="space-y-3 pt-4">
              {description && <p className="text-sm text-muted">{description}</p>}
              <p className="text-sm text-muted">请输入主账号密码完成本次操作;验证仅当次有效。</p>
              <form
                className="space-y-3"
                onSubmit={(event) => {
                  event.preventDefault();
                  handleSubmit();
                }}
              >
                <TextField
                  value={password}
                  onChange={(value) => setPassword(value)}
                  isDisabled={isPending}
                  isRequired
                  validationBehavior="aria"
                  fullWidth
                  autoFocus
                >
                  <Label>主账号密码</Label>
                  <Input type="password" autoComplete="current-password" placeholder="主账号登录密码" />
                  <FieldError>{password === '' ? '请输入密码' : undefined}</FieldError>
                </TextField>
                {error && (
                  <Alert status="danger">
                    <Alert.Content>
                      <Alert.Title>验证未通过</Alert.Title>
                      <Alert.Description>{error}</Alert.Description>
                    </Alert.Content>
                  </Alert>
                )}
                <div className="flex justify-end gap-2">
                  <Button type="button" variant="ghost" isDisabled={isPending} onPress={onCancel}>
                    取消
                  </Button>
                  <Button type="submit" variant="primary" isPending={isPending} isDisabled={password === ''}>
                    验证并继续
                  </Button>
                </div>
              </form>
            </Modal.Body>
          </Modal.Dialog>
        </Modal.Container>
      </Modal.Backdrop>
    </Modal>
  );
}
