import '@testing-library/jest-dom/vitest';
import { cleanup } from '@testing-library/react';
import { afterEach } from 'vitest';

// 注册 jest-dom 匹配器(vitest 入口)并在每个用例后卸载已渲染组件,
// 避免 DOM 状态跨用例泄漏(与 Testing Library 官方指南一致)。
afterEach(() => {
  cleanup();
});
