import { afterEach } from 'vitest';

/**
 * better-sqlite3 原生 Statement finalizer 在 vitest fork dispose 期被 GC 收尾时,
 * 可能触发 `(env) != nullptr` 原生断言导致 worker 崩溃(ERR_IPC_CHANNEL_CLOSED)。
 * 配合 vitest.config.ts 的 forks.execArgv: ['--expose-gc'],在每个测试结束后
 * 主动触发一次 GC,让原生 finalizer 在 env 存活期内确定性地完成。
 * 未注入 --expose-gc 时 globalThis.gc 为 undefined,此处 no-op(行为不变)。
 */
afterEach(() => {
  globalThis.gc?.();
});
