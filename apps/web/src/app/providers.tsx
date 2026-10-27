/**
 * 应用级 Provider 插槽(T010 建立;T040/T043 接线;006 T005 接入数据层)。
 *
 * HeroUI v3 无需任何 Provider(HEROUI-NOTES §1③),本插槽承载 US2 的两个全局能力:
 * - QueryClientProvider(T005;006 数据层):注入 shared/query/client.ts 的
 *   QueryClient 模块级单例,置于最外层——其下的页面 hook(useAppQuery/
 *   useAppMutation)与 SessionProvider 等均可触达同一缓存实例;
 * - SessionProvider(T040):启动恢复会话为轻量 restoring 状态、缓存服务端
 *   householdId/账号摘要/当前 Profile/bootstrapRequired/profileContextVersion;
 * - ActionCoordinator(T043):唯一统一受控 Modal 意图状态机
 *   (uninitialized/initialize→login→bootstrap→picker→selectionPin),
 *   并向布局层提供 useAuthAction / useSession。
 * 各故事任务在此插槽内叠加 Provider,不得在页面内另行包裹全局 Provider。
 */
import type { ReactNode } from 'react';
import { QueryClientProvider } from '@tanstack/react-query';
import { queryClient } from '../shared/query/client';
import { AppToastRegion } from '../shared/ui';
import { SessionProvider } from './session-provider';
import { ActionCoordinator } from './action-coordinator';
import { SettingsAccessProvider } from '../features/settings/settings-access-provider';

export function AppProviders({ children }: { children: ReactNode }): ReactNode {
  return (
    <QueryClientProvider client={queryClient}>
      {/* HeroUI v3 Toast 渲染区:命令式 useAppToast 的挂载点,应用内唯一,缺少则提示不呈现 */}
      <AppToastRegion />
      <SessionProvider>
        <SettingsAccessProvider>
          <ActionCoordinator>{children}</ActionCoordinator>
        </SettingsAccessProvider>
      </SessionProvider>
    </QueryClientProvider>
  );
}
