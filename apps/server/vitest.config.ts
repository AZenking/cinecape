import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // tasks.md T016 指定契约测试文件名为 *.e2e-spec.ts(与 *.spec.ts 后缀不同),
    // 此处补一条 include 使其纳入 vitest(脚手架修正,报告已注明)
    include: ['test/**/*.spec.ts', 'test/**/*.e2e-spec.ts'],
    // 契约测试串行:共享同一 SQLite 数据目录,避免跨文件竞争
    fileParallelism: false,
    testTimeout: 30000,
  },
});
