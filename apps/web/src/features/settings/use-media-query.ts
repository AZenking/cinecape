/**
 * useMediaQuery(T086;SettingsLayout 宽/窄窗降级检查用)。
 *
 * - 订阅 matchMedia 变化(SSR/jsdom 安全:matchMedia 缺失时恒返回 false);
 * - 仅作布局断点消费(768px 宽窗/窄窗,ui.md §8);不承载任何授权事实。
 */
import { useSyncExternalStore } from 'react';

export function useMediaQuery(query: string): boolean {
  return useSyncExternalStore(
    (onStoreChange) => {
      if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
        return () => undefined;
      }
      const list = window.matchMedia(query);
      list.addEventListener('change', onStoreChange);
      return () => {
        list.removeEventListener('change', onStoreChange);
      };
    },
    () =>
      typeof window !== 'undefined' && typeof window.matchMedia === 'function'
        ? window.matchMedia(query).matches
        : false,
    () => false,
  );
}
