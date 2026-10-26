/**
 * 表单字段基元(T041;HeroUI v3:TextField 仅 Root,Label/Input/FieldError 为
 * 顶层独立组件,经 RAC TextField 上下文自动关联 —— HEROUI-NOTES §3 坑 2)。
 * 密码/PIN 仅经受控 value 保存在表单组件内存中,组件卸载(步骤切换/取消)
 * 即丢弃;禁止写 localStorage。
 */
import type { ReactNode } from 'react';
import { FieldError, Input, Label, TextField } from '@heroui/react';

export interface FormFieldProps {
  name: string;
  label: string;
  value: string;
  onValueChange: (value: string) => void;
  type?: 'text' | 'password';
  isRequired?: boolean;
  isDisabled?: boolean;
  isInvalid?: boolean;
  errorMessage?: string;
  autoComplete?: string;
  autoFocus?: boolean;
  inputMode?: 'text' | 'numeric';
  maxLength?: number;
}

export function FormField(props: FormFieldProps): ReactNode {
  return (
    <TextField
      className="w-full"
      value={props.value}
      onChange={props.onValueChange}
      isRequired={props.isRequired ?? true}
      isDisabled={props.isDisabled}
      isInvalid={props.isInvalid}
      autoComplete="off"
    >
      <Label>{props.label}</Label>
      <Input
        type={props.type ?? 'text'}
        name={props.name}
        autoComplete={props.autoComplete}
        autoFocus={props.autoFocus}
        inputMode={props.inputMode}
        maxLength={props.maxLength}
      />
      <FieldError>{props.errorMessage}</FieldError>
    </TextField>
  );
}

/** 统一错误提示(错误不只靠颜色:文字 + danger 语义 token) */
export function FormError({ message }: { message: string | null }): ReactNode {
  if (message === null || message === '') {
    return null;
  }
  return (
    <p role="alert" className="text-sm text-danger">
      {message}
    </p>
  );
}
