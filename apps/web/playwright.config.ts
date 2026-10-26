import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defineConfig, devices } from '@playwright/test';

/**
 * 独立 DATA_DIR —— server 侧 env.schema.ts 以 DATA_DIR(默认 ./data)定位 SQLite 业务库。
 * e2e 一律使用按进程隔离的临时数据目录(等价 mktemp 语义),严禁触碰真实部署数据;
 * 后续任务填充 webServer 启动 server 时,子进程默认继承本进程 env 即可获得该目录;
 * 外部已显式设置时不覆盖。
 */
process.env.DATA_DIR ??= join(tmpdir(), `redroad-e2e-data-${process.pid}`);

/**
 * baseURL 端口取自 apps/web/vite.config.ts 既有 dev server 端口(5173),
 * server API 端口沿用 env.schema.ts 的 PORT 默认值(3000)。
 * webServer(T013):启动 @hmp/web 的 Vite dev server(等价 `pnpm --filter @hmp/web dev`,
 * 显式 `--host 127.0.0.1` 与 baseURL 对齐 —— Vite/Node 缺省绑 localhost,在
 * localhost→::1 的机器上 127.0.0.1 不响应,webServer 就绪探测会超时);
 * 自 005 Wave A 起 webServer 改用 scripts/e2e-servers.sh:独立 DATA_DIR + 迁移
 * (+ E2E_SEED_SCALE=1 时种子 T012 规模夹具)+ 后台 Nest(:3000)+ 前台 vite(:5173),
 * 级联清理;005 各 e2e 套件由此共享同一套双服务基建。
 * reuseExistingServer:本地复用已运行的 dev server,CI 一律新起;E2E_BASE_URL 覆盖
 * baseURL(指向外部已启动服务时请同时设 CI=1 或自行停管 5173,避免双服务器歧义)。
 */
const baseURL = process.env.E2E_BASE_URL ?? 'http://127.0.0.1:5173';

export default defineConfig({
  testDir: './test/e2e',
  use: {
    baseURL,
  },
  webServer: {
    command: 'bash scripts/e2e-servers.sh',
    url: 'http://127.0.0.1:5173',
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
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
