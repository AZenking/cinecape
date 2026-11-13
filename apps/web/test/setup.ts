import '@testing-library/jest-dom/vitest';
import { configure } from '@testing-library/dom';
import { cleanup } from '@testing-library/react';
import { afterEach, vi } from 'vitest';

// 并行跑 86 个测试文件时机器会满载,Testing Library 默认 1s 的 waitFor/findBy
// 上限会偶发超时(表现为随机 1–2 例红、单跑必绿)。放宽等待上限只影响"等多久",
// 不放松任何断言;真正的行为回归仍会让断言失败。
configure({ asyncUtilTimeout: 5000 });

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

// Node 26+ 实验性 Storage 缺少 --localstorage-file 时为 undefined，修补 jsdom window.localStorage/sessionStorage
if (typeof window !== 'undefined') {
  const storageCarrier = window as Window & {
    _localStorage?: Storage;
    _sessionStorage?: Storage;
  };
  if (!window.localStorage && storageCarrier._localStorage) {
    Object.defineProperty(window, 'localStorage', {
      value: storageCarrier._localStorage,
      configurable: true,
      writable: true,
    });
  }
  if (!window.sessionStorage && storageCarrier._sessionStorage) {
    Object.defineProperty(window, 'sessionStorage', {
      value: storageCarrier._sessionStorage,
      configurable: true,
      writable: true,
    });
  }
}

// jsdom 未实现 Element.getAnimations(Web Animations API):react-aria-components 的
// SharedElementTransition 在嵌套弹层开/关时调用它(如 创建来源弹层 + 当次密码弹层
// 叠加)。返回空列表 = 无在途动画,过渡立即完成(与上面垫片同一策略)。
if (typeof window !== 'undefined' && typeof window.Element.prototype.getAnimations !== 'function') {
  window.Element.prototype.getAnimations = (): Animation[] => [];
}

// 注册 jest-dom 匹配器(vitest 入口)并在每个用例后卸载已渲染组件,
// 避免 DOM 状态跨用例泄漏(与 Testing Library 官方指南一致)。
afterEach(() => {
  cleanup();
});
