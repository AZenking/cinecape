/**
 * 应用级 Provider 插槽(T010)。
 *
 * HeroUI v3 无需任何 Provider(HEROUI-NOTES §1③「无 HeroUIProvider」),本组件
 * 当前为直通实现,仅为后续跨页面 Provider 留出唯一挂载点:
 * - T040(US2):SessionProvider —— 启动恢复会话为轻量 restoring 状态、不阻塞公共区;
 * - T043(US3):ActionCoordinator —— 唯一统一受控 Modal 意图状态机。
 * 各故事任务在此插槽内叠加 Provider,不得在页面内另行包裹全局 Provider。
 */
import type { ReactNode } from 'react';

export function AppProviders({ children }: { children: ReactNode }): ReactNode {
  return <>{children}</>;
}
