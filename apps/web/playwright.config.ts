import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defineConfig, devices } from '@playwright/test';

/**
 * 独立 DATA_DIR —— server 侧 env.schema.ts 以 DATA_DIR(默认 ./data)定位 SQLite 业务库。
 * e2e 一律使用按进程隔离的临时数据目录,严禁触碰真实部署数据;
 * 后续任务填充 webServer 启动 server 时,子进程默认继承本进程 env 即可获得该目录;
 * 外部已显式设置时不覆盖。
 */
process.env.DATA_DIR ??= join(tmpdir(), `redroad-e2e-data-${process.pid}`);

/**
 * baseURL 端口取自 apps/web/vite.config.ts 既有 dev server 端口(5173),
 * server API 端口沿用 env.schema.ts 的 PORT 默认值(3000)。
 * webServer(启动 web/server 与 T012 夹具注入)由后续任务填充:
 * 端口协同与启动命令未定,此处预留注释,不猜测实现。
 * 可用 E2E_BASE_URL 覆盖,便于 CI 或固定端口部署。
 */
export default defineConfig({
  testDir: './test/e2e',
  use: {
    baseURL: process.env.E2E_BASE_URL ?? 'http://127.0.0.1:5173',
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
    // PC 验收矩阵的其余真实浏览器(Edge/Firefox/Safari)由后续任务按需扩展 projects
  ],
  reporter: 'list',
});
