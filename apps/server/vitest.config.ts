import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    // 007-T008a 路径别名基座:与 tsconfig.json paths 对齐
    // (@contexts/* -> src/contexts/*, @platform/* -> src/platform/*)。
    // 相对 apps/server 根(config 文件所在目录)定位,供 test/** 消费别名导入。
    alias: {
      '@contexts': fileURLToPath(new URL('./src/contexts', import.meta.url)),
      '@platform': fileURLToPath(new URL('./src/platform', import.meta.url)),
    },
  },
  test: {
    // tasks.md T016 指定契约测试文件名为 *.e2e-spec.ts(与 *.spec.ts 后缀不同),
    // 此处补一条 include 使其纳入 vitest(脚手架修正,报告已注明)
    include: ['test/**/*.spec.ts', 'test/**/*.e2e-spec.ts'],
    // 契约测试串行:共享同一 SQLite 数据目录,避免跨文件竞争
    fileParallelism: false,
    testTimeout: 30000,
    // better-sqlite3 原生 Statement finalizer 在 fork dispose 期被 GC 收尾会触发
    // (env) != nullptr 原生断言(worker 崩溃)。启用 --expose-gc 并配合
    // test/setup.vitest.ts 在每测后主动 gc(),使 finalizer 在 env 存活期内确定性完成。
    poolOptions: {
      forks: {
        execArgv: ['--expose-gc'],
      },
    },
    setupFiles: ['test/setup.vitest.ts'],
  },
});
