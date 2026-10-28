/**
 * 可注入时钟(T012,quickstart 先决条件):
 * - 被测代码面向 Clock 接口取时/等待,测试注入 ManualClock 用 advance() 推进虚拟时间,
 *   覆盖导入预算(总 120s/空闲 15s)与待确认 24h 过期等场景,不真实睡眠;
 *   需要真实时间的组件在实现内自带真实时钟(007-T031:零消费的 systemClock 夹具已删)。
 */

export interface Clock {
  /** 当前时间(毫秒) */
  now(): number;
  /** 等待给定毫秒;ManualClock 下该等待由 advance() 推进到期 */
  delay(ms: number): Promise<void>;
}

interface ManualTimer {
  dueAtMs: number;
  resolve: () => void;
}

export interface ManualClock extends Clock {
  /** 推进虚拟时间到 now()+ms,按到期顺序唤醒等待者(含推进期间新注册者) */
  advance(ms: number): Promise<void>;
  /** 直接设置虚拟时间绝对值(用于跳到过期点) */
  set(nowMs: number): void;
  /** 尚未到期的 delay 等待者数量(断言用) */
  pendingCount(): number;
}

export interface ManualClockOptions {
  /** 虚拟起点(毫秒);缺省为固定常量,保证测试可复现 */
  startMs?: number;
}

/** 默认虚拟起点:2026-01-01T00:00:00Z */
export const MANUAL_CLOCK_DEFAULT_START_MS = 1_767_225_600_000;

export function createManualClock(options: ManualClockOptions = {}): ManualClock {
  let currentMs = options.startMs ?? MANUAL_CLOCK_DEFAULT_START_MS;
  const timers = new Set<ManualTimer>();

  const takeNextDue = (limitMs: number): ManualTimer | undefined => {
    let next: ManualTimer | undefined;
    for (const timer of timers) {
      if (timer.dueAtMs > limitMs) continue;
      if (next === undefined || timer.dueAtMs < next.dueAtMs) {
        next = timer;
      }
    }
    return next;
  };

  return {
    now: () => currentMs,
    delay: (ms: number) =>
      new Promise<void>((resolve) => {
        timers.add({ dueAtMs: currentMs + Math.max(0, ms), resolve });
      }),
    advance: async (ms: number) => {
      const targetMs = currentMs + Math.max(0, ms);
      for (let next = takeNextDue(targetMs); next !== undefined; next = takeNextDue(targetMs)) {
        timers.delete(next);
        currentMs = Math.max(currentMs, next.dueAtMs);
        next.resolve();
        // 让等待者 continuation 先运行(其可能再注册新的 delay),再继续推进
        await Promise.resolve();
      }
      currentMs = targetMs;
    },
    set: (nowMs: number) => {
      currentMs = nowMs;
    },
    pendingCount: () => timers.size,
  };
}
