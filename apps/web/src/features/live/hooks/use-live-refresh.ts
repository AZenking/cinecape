import { useCallback, useEffect, useState } from 'react';
import { useInterval } from '../../../shared/hooks';

/**
 * 直播 30 秒周期刷新(T068;FR-022「直播展示至少每 30 秒更新一次,过期节目不得永久停留」、
 * ui.md §5「页面回到前台立即刷新」):
 * - 每 intervalMs(默认 30 秒,契约下限)递增 refreshKey,驱动全部分区重新拉取;
 * - visibilitychange 回前台(document.visibilityState === 'visible')立即刷新;
 * - 刷新失败的处理在分区资源(hooks/use-live-sections)内:保留旧数据 + 可重试提示,
 *   本 hook 只负责「何时应当刷新」;组件卸载即清理定时器,不积累。
 *
 * US4/T034 收编决议:interval 原语改用 shared/hooks 的 useInterval(autoInvoke)。
 * 与原手写 window.setInterval 逐条等价,语义无变化:
 * - 挂载即启动(autoInvoke),interval 只在 hook 存活期间运行;
 * - 卸载时 useInterval 内部 stop() 清理定时器(等价原 clearInterval);
 * - intervalMs 变更时重启(等价原 effect 依赖 [intervalMs] 的重建);
 * - 底层同为 setInterval 原语,无额外漂移;LIVE_REFRESH_INTERVAL_MS=30_000 契约值不变。
 * visibilitychange「回前台立即刷新」保持原生 document.addEventListener(本决议仅
 * 收编 interval 原语,事件监听语义不动)。
 */

export interface LiveRefreshController {
  /** 每次应当刷新时 +1;分区资源以其为依赖重新拉取 */
  readonly refreshKey: number;
  /** 立即刷新(手动/回前台) */
  readonly refreshNow: () => void;
}

export const LIVE_REFRESH_INTERVAL_MS = 30_000;

export function useLiveRefresh(intervalMs: number = LIVE_REFRESH_INTERVAL_MS): LiveRefreshController {
  const [refreshKey, setRefreshKey] = useState(0);

  const refreshNow = useCallback((): void => {
    setRefreshKey((key) => key + 1);
  }, []);

  // 周期递增 refreshKey:声明式 interval(shared/hooks allowlist;卸载自动清理)
  useInterval(
    () => {
      setRefreshKey((key) => key + 1);
    },
    intervalMs,
    { autoInvoke: true },
  );

  // 回前台立即刷新:原生 visibilitychange 监听(T034 决议:仅收编 interval 原语)
  useEffect(() => {
    const onVisibilityChange = (): void => {
      if (document.visibilityState === 'visible') {
        setRefreshKey((key) => key + 1);
      }
    };
    document.addEventListener('visibilitychange', onVisibilityChange);
    return () => {
      document.removeEventListener('visibilitychange', onVisibilityChange);
    };
  }, []);

  return { refreshKey, refreshNow };
}
