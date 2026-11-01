import {
  InputOTP,
  Label,
  REGEXP_ONLY_DIGITS,
} from '@heroui/react';
import { useId, type ReactNode } from 'react';
import './pin-field.css';

const PIN_LENGTH = 6;

export interface PinFieldProps {
  name: string;
  label: string;
  value: string;
  onValueChange: (value: string) => void;
  description?: string;
  isRequired?: boolean;
  isDisabled?: boolean;
  isInvalid?: boolean;
  errorMessage?: string;
  autoFocus?: boolean;
}

/**
 * 统一的六位数字 PIN 字段。
 * Slot 仅展示遮蔽后的视觉状态，底层 InputOTP input 负责实际表单值和可访问性。
 */
export function PinField({
  name,
  label,
  value,
  onValueChange,
  description,
  isRequired = true,
  isDisabled,
  isInvalid,
  errorMessage,
  autoFocus,
}: PinFieldProps): ReactNode {
  const generatedId = useId();
  const inputId = `pin-field-${generatedId.replace(/:/g, '')}`;
  const descriptionId = `${inputId}-description`;
  const errorId = `${inputId}-error`;

  return (
    <div className="flex w-full flex-col gap-1">
      <Label htmlFor={inputId} isDisabled={isDisabled}>
        {label}
      </Label>
      {description !== undefined ? (
        <p id={descriptionId} className="text-sm text-muted">
          {description}
        </p>
      ) : null}
      <InputOTP
        id={inputId}
        name={name}
        maxLength={PIN_LENGTH}
        value={value}
        onChange={onValueChange}
        pattern={REGEXP_ONLY_DIGITS}
        inputMode="numeric"
        type="password"
        autoComplete="off"
        pushPasswordManagerStrategy="none"
        autoFocus={autoFocus}
        required={isRequired}
        isDisabled={isDisabled}
        isInvalid={isInvalid}
        aria-label={label}
        aria-describedby={[description !== undefined ? descriptionId : null, errorMessage !== undefined ? errorId : null]
          .filter((id): id is string => id !== null)
          .join(' ') || undefined}
        aria-invalid={isInvalid || undefined}
      >
        <InputOTP.Group>
          {Array.from({ length: PIN_LENGTH }, (_, index) => (
            <InputOTP.Slot
              key={index}
              index={index}
              className="hmp-pin-field__slot"
              aria-hidden="true"
            />
          ))}
        </InputOTP.Group>
      </InputOTP>
      {errorMessage !== undefined ? (
        <p id={errorId} role="alert" className="text-sm text-danger">
          {errorMessage}
        </p>
      ) : null}
    </div>
  );
}
