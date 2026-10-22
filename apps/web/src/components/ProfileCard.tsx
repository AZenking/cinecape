/**
 * 档案卡(T029,纯展示组件)。
 *
 * - Netflix 式大卡:≥160px 方形头像区 + 名称;仅负责展示与 onPress 上抛,
 *   不含任何数据请求(选择/解锁逻辑在 pages/ProfilePicker)。
 * - 角标:类型(adult/child)、默认档案、PIN 保护锁标记;disabled 置灰并抑制点击。
 * - 交互(research D6):原生 button + React Aria Pressable 统一鼠标/键盘 onPress,
 *   焦点环与 :active 缩放由 CSS 完成;触达面积 ≥44px(实际 ≥160px)。
 */
import { Pressable } from '@heroui/react';

export interface ProfileCardProps {
  name: string;
  /** adult = 成人;child = 儿童(角标 + 配色区分) */
  type: 'adult' | 'child';
  isDefault?: boolean;
  pinProtected?: boolean;
  /** 已停用:整卡置灰、不可点击 */
  disabled?: boolean;
  onPress?: () => void;
}

/** 通用锁形图标(内联 SVG,避免引入图标依赖) */
function LockIcon() {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 24 24"
      className="h-3.5 w-3.5"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <rect x="4" y="11" width="16" height="10" rx="2" />
      <path d="M8 11V7a4 4 0 0 1 8 0v4" />
    </svg>
  );
}

export function ProfileCard({
  name,
  type,
  isDefault = false,
  pinProtected = false,
  disabled = false,
  onPress,
}: ProfileCardProps) {
  const initial = name.trim().charAt(0).toUpperCase() || '?';

  /** 纯展示组件只做守卫:停用态吞掉点击,其余原样上抛 */
  const handlePress = () => {
    if (!disabled) {
      onPress?.();
    }
  };

  return (
    <Pressable onPress={handlePress} isDisabled={disabled}>
      <button
        type="button"
        disabled={disabled}
        aria-label={disabled ? `${name}(已停用)` : name}
        className={`group flex w-40 flex-col items-center gap-2 focus:outline-none ${
          disabled ? 'cursor-not-allowed' : 'cursor-pointer'
        }`}
      >
        {/* 方形头像区:≥160px(w-40 = 10rem) */}
        <span
          className={`relative flex h-40 w-40 items-center justify-center overflow-hidden rounded-xl ring-white/60 transition duration-150 group-active:scale-95 ${
            type === 'child'
              ? 'bg-gradient-to-br from-amber-500/70 to-rose-600/70'
              : 'bg-gradient-to-br from-zinc-600/70 to-zinc-800/70'
          } ${
            disabled
              ? 'opacity-40 grayscale'
              : 'group-hover:ring-4 group-focus-visible:ring-4'
          }`}
        >
          <span className="text-5xl font-bold text-white/90">{initial}</span>

          {/* 类型角标(左上) */}
          <span
            className={`absolute left-2 top-2 rounded-full px-2 py-0.5 text-xs font-medium ${
              type === 'child' ? 'bg-amber-400 text-amber-950' : 'bg-white/20 text-white'
            }`}
          >
            {type === 'child' ? '儿童' : '成人'}
          </span>

          {/* 默认标记(右上) */}
          {isDefault && (
            <span className="absolute right-2 top-2 rounded-full bg-accent px-2 py-0.5 text-xs font-medium text-white">
              默认
            </span>
          )}

          {/* PIN 保护锁角标(右下) */}
          {pinProtected && (
            <span
              title="需要 PIN 解锁"
              className="absolute bottom-2 right-2 flex h-7 w-7 items-center justify-center rounded-full bg-black/60 text-white"
            >
              <LockIcon />
            </span>
          )}

          {/* 停用遮罩标记 */}
          {disabled && (
            <span className="absolute inset-x-0 bottom-0 bg-black/60 py-1 text-center text-xs text-foreground">
              已停用
            </span>
          )}
        </span>

        <span
          className={`max-w-40 truncate text-sm font-medium ${
            disabled ? 'text-muted' : 'text-foreground'
          }`}
        >
          {name}
        </span>
      </button>
    </Pressable>
  );
}
