import { Toast } from '@heroui/react';
import { useMemo } from 'react';
import type { ComponentProps, ReactNode } from 'react';

/**
 * 全局轻反馈 Toast(006 ui-components 契约:轻反馈 Toast)——
 * 基于 HeroUI v3 `Toast` 命名空间(node_modules
 * @heroui/react/dist/components/toast/index.d.ts 实证):
 * - `Toast.toast(message, options?)` 为命令式函数(入模块级共享队列,
 *   另有 .success/.danger/.info/.warning/.update/.promise/.close 等成员);
 * - `Toast.Provider` 即 Toast 区域(region):不传 queue 时默认消费
 *   `toast.getQueue()`(toast.js `return toast.getQueue()` 实证),
 *   不传 children 时按默认模板渲染每条 Toast
 *   (Indicator/Title/Description/ActionButton/CloseButton)。
 *
 * ⚠️ 挂载要求:`AppToastRegion` 必须在应用根部挂载一次
 * (归口 apps/web/src/app/providers.tsx 的 AppProviders——由 providers
 * lane 负责接线,本文件不改动 providers.tsx)。未挂载时命令式调用不报错,
 * 但页面上不会出现任何 Toast(队列无消费者)。
 *
 * v3 契约:无 Provider 概念特例、无 framer-motion;变体走语义值
 * (success/danger 等 ToastContentValue['variant']),不传裸色值。
 */

/**
 * Toast 区域(应用根部挂载一次)——
 * placement 固定「底部居中」(HeroUI `bottom` = `bottom-4 left-1/2 -translate-x-1/2`,
 * 与 `bottom start`/`bottom end` 角位变体相对;媒体界面底部有播放条等控件时依然最不遮挡
 * 视线;如需调整由 providers lane 决定,本组件不引入主题切换/布局分支)。
 * `data-testid="app-toast-region"`:测试统一经该区域断言 toast 文案。
 */
export function AppToastRegion(): ReactNode {
  return <Toast.Provider placement="bottom" data-testid="app-toast-region" />;
}

/** useAppToast 返回的最小面:轻反馈语义 + 冲突类警示(不暴露队列管理细节) */
export interface AppToastWarningOptions {
  /** 次行说明文案(如服务端现值摘要) */
  description?: ReactNode;
  /** 单一动作按钮文案(如「读取现值并放弃我的编辑」);缺省无动作 */
  actionLabel?: string;
  /** 动作按钮回调 */
  onAction?: () => void;
}

/** useAppToast 返回的最小面:仅轻反馈语义,不暴露队列管理细节 */
export interface AppToast {
  /** 成功反馈(语义 success 变体) */
  success: (message: string) => string;
  /** 失败反馈(语义 danger 变体) */
  error: (message: string) => string;
  /** 警示反馈(语义 warning 变体;可携带次行说明与单一动作按钮) */
  warning: (message: string, options?: AppToastWarningOptions) => string;
}

/**
 * 轻反馈 hook——`{ success(msg), error(msg), warning(msg, opts?) }`,底层为 HeroUI
 * 命令式 `Toast.toast.success/danger/warning`(入共享队列,由 AppToastRegion 渲染)。
 * 返回值经 useMemo 保持引用稳定,可直接作为 effect 依赖;
 * 返回 string 为该条 Toast 的队列 id(可用于 Toast.toast.close(id) 手动关闭)。
 * 适用场景:保存成功、复制成功等操作结果轻提示;数据加载失败仍走
 * RetryableAlert(错误态可重试,不只靠转瞬即逝的 Toast)。
 */
export function useAppToast(): AppToast {
  return useMemo<AppToast>(
    () => ({
      success: (message) => Toast.toast.success(message),
      error: (message) => Toast.toast.danger(message),
      warning: (message, options) => {
        if (options === undefined) {
          return Toast.toast.warning(message);
        }
        return Toast.toast.warning(message, {
          ...(options.description !== undefined ? { description: options.description } : {}),
          ...(options.actionLabel !== undefined
            ? {
                actionProps: {
                  children: options.actionLabel,
                  variant: 'outline',
                  size: 'sm',
                  onPress: options.onAction,
                } as ComponentProps<typeof Toast.ActionButton>,
              }
            : {}),
        });
      },
    }),
    [],
  );
}
