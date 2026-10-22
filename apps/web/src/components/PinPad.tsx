/**
 * PIN 数字键盘浮层(T030,User Story 2 / FR-015)。
 *
 * - HeroUI Modal 居中浮层,内嵌 3×4 数字键盘:1-9、清除、0、退格(契约交互范式,
 *   research D6「错误整排抖动清空,仅提示剩余次数」)。
 * - PIN 圆点回显;数字补满 maxLength 时自动提交(快捷路径),同时保留底部「确认」
 *   按钮以支持 4-12 位变长 PIN(契约 CreateProfileRequest.pin minLength=4)。
 * - 错误:整排抖动(globals.css `hmp-pin-shake`)+ 清空 + 展示服务端 detail
 *   (如剩余尝试次数);423/PROFILE_PIN_LOCKED → 锁定提示并禁用键盘,
 *   连续错误计数与锁定窗口完全由后端维护。
 * - 成功:POST /profiles/{id}/unlock 200 → onClose + onSuccess()(父级随后 select)。
 * - 触达面积:每个按键 min-h-12(48px ≥ 44px),全部 onPress 驱动。
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { Alert, Button, Modal } from '@heroui/react';
import type { KeyboardEvent as ReactKeyboardEvent } from 'react';
import { ApiError, api } from '../lib/api';

export interface PinPadProps {
  isOpen: boolean;
  /** 关闭请求(取消/成功/遮罩)统一经此回传父级 */
  onOpenChange: (open: boolean) => void;
  /** 待解锁档案 id;弹层打开期间发起 POST /profiles/{id}/unlock */
  profileId: string;
  /** 弹层标题,默认「输入 PIN 码」 */
  title?: string;
  /** PIN 最大位数(契约 4-12),默认 12 */
  maxLength?: number;
  /** 解锁成功回调(父级随后 POST select) */
  onSuccess: () => void;
}

/** 契约 PIN 最小位数 */
const MIN_PIN_LENGTH = 4;

export function PinPad({
  isOpen,
  onOpenChange,
  profileId,
  title = '输入 PIN 码',
  maxLength = 12,
  onSuccess,
}: PinPadProps) {
  const [digits, setDigits] = useState('');
  const [error, setError] = useState<string | null>(null);
  /** 423 锁定:键盘整体禁用,等待后端锁定窗口结束 */
  const [locked, setLocked] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  /** 抖动计数:每次错误 +1,作为 key 强制重启 CSS 动画 */
  const [shakeCount, setShakeCount] = useState(0);
  const shakeTimerRef = useRef<number | null>(null);

  /** 打开时重置全部状态;关闭时兜底清抖动定时器 */
  useEffect(() => {
    if (isOpen) {
      setDigits('');
      setError(null);
      setLocked(false);
      setSubmitting(false);
      setShakeCount(0);
    }
  }, [isOpen]);

  useEffect(() => {
    return () => {
      if (shakeTimerRef.current !== null) {
        window.clearTimeout(shakeTimerRef.current);
      }
    };
  }, []);

  /** 整排抖动一次(约 0.45s,见 globals.css keyframes) */
  const triggerShake = useCallback(() => {
    setShakeCount((count) => count + 1);
    if (shakeTimerRef.current !== null) {
      window.clearTimeout(shakeTimerRef.current);
    }
    shakeTimerRef.current = window.setTimeout(() => {
      shakeTimerRef.current = null;
    }, 500);
  }, []);

  const submit = useCallback(
    async (pin: string): Promise<void> => {
      if (submitting) {
        return;
      }
      setSubmitting(true);
      setError(null);
      try {
        await api.post(
          `/profiles/${profileId}/unlock` as '/profiles/{profileId}/unlock',
          { pin },
        );
        // 先回调成功(父级凭此继续 select),再请求关闭;
        // 顺序不能反:父级在关闭时会清空目标档案引用
        onSuccess();
        onOpenChange(false);
      } catch (err) {
        if (err instanceof ApiError && (err.status === 423 || err.code === 'PROFILE_PIN_LOCKED')) {
          setLocked(true);
          setError(err.detail ?? '尝试次数过多,该档案已被临时锁定,请稍后再试。');
        } else if (err instanceof ApiError) {
          // 服务端 detail 携带剩余次数等信息(如「PIN 不正确,还可尝试 3 次」)
          setError(err.detail ?? 'PIN 不正确,请重试。');
        } else {
          setError('解锁失败,请稍后重试。');
        }
        setDigits('');
        triggerShake();
      } finally {
        setSubmitting(false);
      }
    },
    [onOpenChange, onSuccess, profileId, submitting, triggerShake],
  );

  const pressDigit = useCallback(
    (digit: string): void => {
      if (locked || submitting || digits.length >= maxLength) {
        return;
      }
      const next = digits + digit;
      setDigits(next);
      // 补满上限位数自动提交;更短 PIN 用底部「确认」按钮
      if (next.length === maxLength) {
        void submit(next);
      }
    },
    [digits, locked, maxLength, submit, submitting],
  );

  const clearDigits = useCallback((): void => {
    if (!locked && !submitting) {
      setDigits('');
      setError(null);
    }
  }, [locked, submitting]);

  const backspace = useCallback((): void => {
    if (!locked && !submitting) {
      setDigits((prev) => prev.slice(0, -1));
      setError(null);
    }
  }, [locked, submitting]);

  /** 底部「确认」:变长 PIN(4 至 maxLength-1 位)的手动提交入口 */
  const confirm = useCallback((): void => {
    if (digits.length >= MIN_PIN_LENGTH && !locked && !submitting) {
      void submit(digits);
    }
  }, [digits, locked, submit, submitting]);

  /** 数字与退格在按钮焦点下仍可输入；Enter/空格保留按钮原生行为。 */
  const handleKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>): void => {
    const target = event.target;
    if (event.nativeEvent.isComposing || event.ctrlKey || event.metaKey || event.altKey) return;
    if (/^[0-9]$/.test(event.key)) {
      event.preventDefault();
      pressDigit(event.key);
    } else if (event.key === 'Backspace') {
      event.preventDefault();
      backspace();
    } else if (event.key === 'Enter' && !(target instanceof HTMLElement && target.closest('button'))) {
      event.preventDefault();
      confirm();
    }
  };

  const keypadDisabled = locked || submitting;

  return (
    <Modal
      isOpen={isOpen}
      onOpenChange={(open) => {
        // 锁定/提交中不允许误触关闭?允许取消离开;仅把状态回传父级
        if (!submitting) onOpenChange(open);
      }}
    >
      <Modal.Backdrop isDismissable={false} isKeyboardDismissDisabled={submitting}>
        <Modal.Container placement="center">
          <Modal.Dialog aria-label="PIN 输入键盘">
            <Modal.Body>
              <div
                role="group"
                aria-label="PIN 数字键盘"
                onKeyDownCapture={handleKeyDown}
                className="flex flex-col items-center gap-5 py-2 text-center"
              >
                <div>
                  <p className="text-lg font-semibold text-foreground">{title}</p>
                  <p className="mt-1 text-sm text-muted">
                    请输入 {MIN_PIN_LENGTH}-{maxLength} 位 PIN 码
                  </p>
                </div>

                {/* PIN 圆点回显;错误时整排抖动(key 重挂载重启动画) */}
                <div
                  key={shakeCount}
                  className={`flex items-center justify-center gap-2 ${
                    shakeCount > 0 ? 'hmp-pin-shake' : ''
                  }`}
                  aria-label={`已输入 ${digits.length} 位`}
                >
                  {Array.from({ length: maxLength }, (_, index) => (
                    <span
                      key={index}
                      aria-hidden="true"
                      className={`h-2.5 w-2.5 rounded-full ${
                        index < digits.length
                          ? 'bg-white'
                          : 'border border-white/40 bg-transparent'
                      }`}
                    />
                  ))}
                </div>

                {/* 错误 / 锁定提示:展示服务端 detail(剩余次数、锁定窗口) */}
                <div className="min-h-6">
                  {error ? (
                    locked ? (
                      <Alert status="warning">
                        <Alert.Indicator />
                        <Alert.Content>
                          <Alert.Title>已临时锁定</Alert.Title>
                          <Alert.Description>{error}</Alert.Description>
                        </Alert.Content>
                      </Alert>
                    ) : (
                      <p className="text-sm text-danger" role="alert">
                        {error}
                      </p>
                    )
                  ) : (
                    <span className="sr-only">等待输入</span>
                  )}
                </div>

                {/* 3×4 键盘:1-9 / 清除 / 0 / 退格;全部 onPress,≥44px */}
                <div className="grid w-56 grid-cols-3 gap-3">
                  {['1', '2', '3', '4', '5', '6', '7', '8', '9'].map((digit) => (
                    <Button
                      key={digit}
                      variant="outline"
                      isDisabled={keypadDisabled}
                      onPress={() => pressDigit(digit)}
                      className="min-h-12 min-w-12 text-lg font-semibold"
                    >
                      {digit}
                    </Button>
                  ))}
                  <Button
                    variant="ghost"
                    isDisabled={keypadDisabled}
                    onPress={clearDigits}
                    className="min-h-12 min-w-12 text-sm"
                  >
                    清除
                  </Button>
                  <Button
                    variant="outline"
                    isDisabled={keypadDisabled}
                    onPress={() => pressDigit('0')}
                    className="min-h-12 min-w-12 text-lg font-semibold"
                  >
                    0
                  </Button>
                  <Button
                    variant="ghost"
                    isDisabled={keypadDisabled}
                    onPress={backspace}
                    aria-label="退格"
                    className="min-h-12 min-w-12 text-sm"
                  >
                    退格
                  </Button>
                </div>
              </div>
            </Modal.Body>
            <Modal.Footer>
              <Button
                variant="ghost"
                isDisabled={submitting}
                onPress={() => {
                  onOpenChange(false);
                }}
              >
                取消
              </Button>
              <Button
                variant="primary"
                isDisabled={digits.length < MIN_PIN_LENGTH || locked}
                isPending={submitting}
                onPress={confirm}
              >
                确认
              </Button>
            </Modal.Footer>
          </Modal.Dialog>
        </Modal.Container>
      </Modal.Backdrop>
    </Modal>
  );
}
