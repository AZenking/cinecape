/**
 * 应用级 Provider 插槽(T010 建立;T040/T043 接线)。
 *
 * HeroUI v3 无需任何 Provider(HEROUI-NOTES §1③),本插槽承载 US2 的两个全局能力:
 * - SessionProvider(T040):启动恢复会话为轻量 restoring 状态、缓存服务端
 *   householdId/账号摘要/当前 Profile/bootstrapRequired/profileContextVersion;
 * - ActionCoordinator(T043):唯一统一受控 Modal 意图状态机
 *   (uninitialized/initialize→login→bootstrap→picker→selectionPin),
 *   并向布局层提供 useAuthAction / useSession。
 * 各故事任务在此插槽内叠加 Provider,不得在页面内另行包裹全局 Provider。
 */
import type { ReactNode } from 'react';
import { SessionProvider } from './session-provider';
import { ActionCoordinator } from './action-coordinator';

export function AppProviders({ children }: { children: ReactNode }): ReactNode {
  return (
    <SessionProvider>
      <ActionCoordinator>{children}</ActionCoordinator>
    </SessionProvider>
  );
}
