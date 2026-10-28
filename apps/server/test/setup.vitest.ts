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


/**
 * 008-repository-extraction(ADR-0015 D1):测试工作进程级仓储 seam 默认绑定。
 * - 惰性 getDb 解析:跟随 Database 单例 close/重开(helpers 每测试重建库仍正确);
 * - 内存库 rig(如 batch-policy-context.spec)在自身 createRig 中以固定句柄重绑,
 *   后绑覆盖本默认(每个测试文件独立模块域,互不串扰);
 * - 经 Nest AppModule 装配的 e2e 会在 PolicyModule 实例化时再次绑定同一工厂,幂等。
 */
import { bindPolicyStore } from '../src/contexts/policy/application/policy-store.port';
import { drizzlePolicyStore } from '../src/contexts/policy/infrastructure/policy-store.drizzle';

bindPolicyStore(drizzlePolicyStore());
