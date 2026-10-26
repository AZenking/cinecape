import { useCallback, useEffect, useState } from 'react';

/**
 * 直播 30 秒周期刷新(T068;FR-022「直播展示至少每 30 秒更新一次,过期节目不得永久停留」、
 * ui.md §5「页面回到前台立即刷新」):
 * - 每 intervalMs(默认 30 秒,契约下限)递增 refreshKey,驱动全部分区重新拉取;
 * - visibilitychange 回前台(document.visibilityState === 'visible')立即刷新;
 * - 刷新失败的处理在分区资源(hooks/use-live-sections)内:保留旧数据 + 可重试提示,
 *   本 hook 只负责「何时应当刷新」;组件卸载/文档隐藏时不积累定时器。
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

  useEffect(() => {
    const timer = window.setInterval(() => {
      setRefreshKey((key) => key + 1);
    }, intervalMs);
    const onVisibilityChange = (): void => {
      if (document.visibilityState === 'visible') {
        setRefreshKey((key) => key + 1);
      }
    };
    document.addEventListener('visibilitychange', onVisibilityChange);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisibilityChange);
    };
  }, [intervalMs]);

  return { refreshKey, refreshNow };
}
