import '@testing-library/jest-dom/vitest';
import { cleanup } from '@testing-library/react';
import { afterEach, vi } from 'vitest';

// jsdom 未实现 window.matchMedia:HeroUI Toast.Provider(经 useMediaQuery)等
// 组件需要它。提供最小可用垫片(默认不匹配,可用属性手动触发)。
if (typeof window !== 'undefined' && typeof window.matchMedia !== 'function') {
  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    value: (query: string): MediaQueryList => ({
      matches: false,
      media: query,
      onchange: null,
      addListener: (): void => undefined,
      removeListener: (): void => undefined,
      addEventListener: (): void => undefined,
      removeEventListener: (): void => undefined,
      dispatchEvent: (): boolean => false,
    }),
  });
}

// 部分组件(虚拟化/尺寸观察)在 jsdom 下缺 ResizeObserver,同样补最小垫片。
if (typeof globalThis.ResizeObserver !== 'function') {
  class ResizeObserverMock {
    observe = vi.fn();
    unobserve = vi.fn();
    disconnect = vi.fn();
  }
  globalThis.ResizeObserver = ResizeObserverMock as unknown as typeof ResizeObserver;
}

// 注册 jest-dom 匹配器(vitest 入口)并在每个用例后卸载已渲染组件,
// 避免 DOM 状态跨用例泄漏(与 Testing Library 官方指南一致)。
afterEach(() => {
  cleanup();
});
