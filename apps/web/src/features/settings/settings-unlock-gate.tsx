/**
 * 设置解锁门(T087,ui.md §7 + FR-031/FR-032/FR-041)。
 *
 * - 未解锁(checking/locked)只渲染 PIN 输入,绝不预取管理主体(不渲染 children);
 * - PIN 用 HeroUI v3 Form/TextField(TextField 仅 Root,Label/Input/FieldError 为
 *   顶层独立组件 —— HEROUI-NOTES §3 坑 2);仅表单内存,卸载即清,不写 localStorage;
 * - 403(错误 PIN/角色或档案不满足)与 423(共享锁定)以文字呈现服务端 detail,
 *   错误不只靠颜色;忙时阻止重复提交;
 * - 403/过期导致的「编辑未保存」提示由 Provider(unsavedNotice)状态承载,在门上
 *   显示;重新验证成功后由 Provider 清除并递增 reloadEpoch 供模块重读现值;
 * - 取消:清凭据并回到原页面(onCancel 由布局注入),旧回调不得重开已取消的设置
 *   (Provider lock() 先递增代次再撤销)。
 */
import { Form, Button } from '@heroui/react';
import { useState, type FormEvent, type ReactNode } from 'react';
import { isFetchApiError } from '../../shared/fetch';
import { LoadingSpinner, PinField } from '../../shared/ui';
import { useSettingsAccess } from './settings-access-provider';

/** PIN 表单(可被意图协调器 settingsPin 弹层复用;见 settings-access-provider 接线契约) */
export function SettingsPinForm({
  submitLabel = '验证并进入设置',
  cancelLabel = '取消',
  onSubmit,
  onCancel,
}: {
  submitLabel?: string;
  cancelLabel?: string;
  onSubmit: (pin: string) => Promise<void>;
  onCancel: () => void;
}): ReactNode {
  const [pin, setPin] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const handleSubmit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    if (busy) {
      return;
    }
    if (!/^\d{6}$/.test(pin)) {
      setError('PIN 必须为 6 位数字');
      return;
    }
    setBusy(true);
    setError(null);
    void onSubmit(pin)
      .then(() => {
        setPin(''); // 成功即清内存,不落任何持久存储
        setError(null);
      })
      .catch((cause: unknown) => {
        // 服务端 detail 仅含稳定文案/剩余次数;不回显 PIN
        setError(isFetchApiError(cause) ? (cause.detail ?? cause.title) : '验证失败,请重试');
        // 失败即清内存凭据(与上方「成功即清」同一卫生语义)。010 回归修复(T090 遗留 2):
        // PinField(InputOTP)槽位输入不支持「满位后整体替换」手势 —— 满位字段上再
        // fill/选择替换会被 maxLength 截断污染(实测提交 '000001' 而非重输值),
        // 二次验证恒 403 → 弹层永不导航;清空后重输恒从空位开始,导航契约(T079)恢复。
        setPin('');
      })
      .finally(() => {
        setBusy(false);
      });
  };

  const handleCancel = (): void => {
    setPin(''); // 关闭即清凭据(仅表单内存)
    setError(null);
    onCancel();
  };

  return (
    <section aria-label="设置 PIN 验证" className="flex flex-col gap-3">
      <p className="text-sm text-muted">
        设置访问需独立验证主档案 PIN(与选档解锁相互独立;15 分钟内返回设置无需重复输入)。
      </p>
      <Form onSubmit={handleSubmit}>
        <PinField
          name="pin"
          label="设置 PIN(6 位数字)"
          value={pin}
          onValueChange={setPin}
          isDisabled={busy}
          isInvalid={error !== null}
          errorMessage={error ?? undefined}
        />
        {/* 服务端错误为业务失败而非字段校验状态:按既有惯例以 role=alert 文字呈现
            (与 selection-pin-step 同口径;RAC FieldError 仅渲染字段校验状态) */}
        <div className="flex justify-end gap-2 pt-1">
          <Button type="button" variant="ghost" size="sm" onPress={handleCancel} isDisabled={busy}>
            {cancelLabel}
          </Button>
          <Button type="submit" variant="primary" size="sm" isDisabled={busy}>
            {busy ? '验证中…' : submitLabel}
          </Button>
        </div>
      </Form>
    </section>
  );
}

/**
 * 解锁门:checking/locked 渲染 PIN 输入(不渲染 children —— 管理主体零请求);
 * unlocked 渲染 children。unsavedNotice 在门上提示(管理主体已被隐藏)。
 */
export function SettingsUnlockGate({
  children,
  onCancel,
}: {
  children: ReactNode;
  onCancel: () => void;
}): ReactNode {
  const access = useSettingsAccess();

  if (access.status === 'checking') {
    return <LoadingSpinner label="正在核验设置授权…" />;
  }

  if (access.status === 'locked') {
    return (
      <section className="flex flex-1 flex-col items-center justify-center gap-4 py-16">
        <h1 className="text-xl font-semibold text-foreground">设置已锁定</h1>
        {access.unsavedNotice ? (
          <p role="alert" className="max-w-prose text-sm text-warning">
            授权已失效,编辑未保存;重新验证后将读取最新现值,已修改内容不会自动提交。
          </p>
        ) : (
          <p className="max-w-prose text-sm text-muted">输入主档案 PIN 以进入统一设置。</p>
        )}
        <div className="w-full max-w-sm">
          <SettingsPinForm onSubmit={access.unlock} onCancel={onCancel} />
        </div>
      </section>
    );
  }

  return <>{children}</>;
}
