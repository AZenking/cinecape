import { useEffect, useState } from 'react';
import { serverNowMs } from './server-clock';

/**
 * 服务端基准时刻 tick hook(NOW 指示线/直播进度/剩余文案的单一时间来源):
 *
 * - 每 `tickMs`(缺省 15s,与 use-current-programme 的 PROGRESS_TICK_INTERVAL_MS
 *   同档)拉一次 `serverNowMs()`;校准后 NOW 线、进度条、胶囊时刻随真实时间
 *   平滑推进,不再冻结在响应快照;
 * - 未校准(首个带 now 的响应到达前)返回 null:消费方回落各自 `data.now`
 *   快照渲染,不臆造本地时钟;校准发生后的下一个 tick 自动接上;
 * - 组件卸载清理定时器;`tickMs` 变化重建 interval(传常量保持稳定身份)。
 */

export interface UseServerNowResult {
  /** 服务端基准当前时刻(UTC 毫秒);未校准为 null */
  readonly nowMs: number | null;
  /** 是否已校准(等价 nowMs !== null) */
  readonly calibrated: boolean;
}

/** 默认 tick 周期:15s(进度百分比分钟级语义下的轻量档;导出供测试对账) */
export const SERVER_NOW_TICK_MS = 15_000;

export function useServerNow(tickMs: number = SERVER_NOW_TICK_MS): UseServerNowResult {
  const [nowMs, setNowMs] = useState<number | null>(() => serverNowMs());

  useEffect(() => {
    // 挂载即同步一次:校准发生在首个渲染之后时,这里立即接上(不等整个 tick)
    setNowMs(serverNowMs());
    const id = setInterval(() => {
      setNowMs(serverNowMs());
    }, tickMs);
    return () => {
      clearInterval(id);
    };
  }, [tickMs]);

  return { nowMs, calibrated: nowMs !== null };
}
