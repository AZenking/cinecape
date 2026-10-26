import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defaultExclude, defineConfig } from 'vitest/config';

/**
 * 独立 DATA_DIR —— server 侧 env.schema.ts 以 DATA_DIR(默认 ./data)定位 SQLite 业务库。
 * web 测试进程缺省注入按进程隔离的临时目录,防止任何会引导真实 server 的测试
 * (如 T013 foundation-smoke)把数据误写进 apps/web 相对路径 ./data 或真实部署库;
 * 外部已显式设置(如 CI、playwright webServer 注入)时不覆盖。
 * 逐测细粒度隔离(T008/T012 语义)仍由各测试自建临时目录负责。
 */
process.env.DATA_DIR ??= join(tmpdir(), `redroad-web-vitest-data-${process.pid}`);

export default defineConfig({
  test: {
    // 前端组件/单元测试运行在 jsdom
    environment: 'jsdom',
    globals: true,
    setupFiles: ['test/setup.ts'],
    // 仅收集前端单测;test/e2e/ 归 Playwright 所有,@playwright/test 的用例文件
    // 不得被 vitest 收集(显式排除,覆盖 *.spec.ts 命名重叠)
    include: ['test/**/*.spec.{ts,tsx}'],
    exclude: [...defaultExclude, 'test/e2e/**'],
  },
});
