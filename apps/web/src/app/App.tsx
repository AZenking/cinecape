/**
 * 应用根组件(T010):Provider 插槽 + 公共路由表。
 * 由 main.tsx 挂载;旧登录优先骨架(RequireSession 重定向结构)已移除。
 */
import type { ReactNode } from 'react';
import { AppProviders } from './providers';
import { AppRoutes } from './routes';

export function App(): ReactNode {
  return (
    <AppProviders>
      <AppRoutes />
    </AppProviders>
  );
}
