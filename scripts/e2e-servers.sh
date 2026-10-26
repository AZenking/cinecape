#!/usr/bin/env bash
# 005 e2e 双服务启动器(Playwright webServer 用):
# - 独立 DATA_DIR(默认 mktemp;可用 E2E_DATA_DIR 指定),应用全部迁移(generation2);
# - E2E_SEED_SCALE=1 时用 T012 规模夹具种子(200频道/500点播/67,200排期,固定时钟);
# - 以后台进程启动 Nest(:3000),前台运行 vite(:5173,--host 127.0.0.1);
#   vite 被 Playwright 终止时 trap 级联清理 Nest 与(未指定 E2E_DATA_DIR 时的)临时目录。
# 环境变量:
#   E2E_DATA_DIR     指定数据目录(不清理;缺省 mktemp 并在退出时清理)
#   E2E_SEED_SCALE   =1 时种子规模夹具(US1/US5 游客浏览场景)
#   E2E_SKIP_MIGRATE =1 时跳过迁移(已就绪库复用)
#   SERVER_PORT/WEB_PORT 覆盖端口(缺省 3000/5173;端口改动需同步 vite 代理与 baseURL)
set -euo pipefail
cd "$(dirname "$0")/.."

SERVER_PORT="${SERVER_PORT:-3000}"
WEB_PORT="${WEB_PORT:-5173}"
OWNED_DATA_DIR=0
if [ -z "${E2E_DATA_DIR:-}" ]; then
  E2E_DATA_DIR="$(mktemp -d /tmp/redroad-e2e.XXXXXX)"
  OWNED_DATA_DIR=1
fi
export DATA_DIR="$E2E_DATA_DIR"
export PUBLIC_ORIGIN="${PUBLIC_ORIGIN:-http://127.0.0.1:${WEB_PORT}}"
export NODE_ENV="${NODE_ENV:-development}"

echo "[e2e-servers] DATA_DIR=$E2E_DATA_DIR seed=${E2E_SEED_SCALE:-0} public_origin=$PUBLIC_ORIGIN"

# 夹具 CLI 产出固定文件名 scale-fixture.hmp.db;种子模式下服务端必须读同一文件。
# CLI 自建完整 generation2 库(含迁移语义),种子模式下跳过独立 migrate 步骤避免表冲突。
if [ "${E2E_SEED_SCALE:-0}" = "1" ]; then
  export DB_FILENAME="scale-fixture.hmp.db"
  pnpm --filter @hmp/server exec tsx test/fixtures/scale-fixture.cli.ts --dir "$E2E_DATA_DIR" --db-filename "$DB_FILENAME"
elif [ "${E2E_SKIP_MIGRATE:-0}" != "1" ]; then
  pnpm --filter @hmp/server exec tsx src/database/migrate.ts up
fi

SERVER_PID=""
cleanup() {
  if [ -n "$SERVER_PID" ]; then kill "$SERVER_PID" 2>/dev/null || true; wait "$SERVER_PID" 2>/dev/null || true; fi
  if [ "$OWNED_DATA_DIR" = "1" ]; then rm -rf "$E2E_DATA_DIR"; fi
}
trap cleanup EXIT INT TERM

pnpm --filter @hmp/server exec tsx src/main.ts &
SERVER_PID=$!

for i in $(seq 1 60); do
  if curl -fsS "http://127.0.0.1:${SERVER_PORT}/api/healthz" >/dev/null 2>&1; then break; fi
  sleep 0.5
done
curl -fsS "http://127.0.0.1:${SERVER_PORT}/api/healthz" >/dev/null || { echo "[e2e-servers] Nest 未就绪"; exit 1; }
echo "[e2e-servers] Nest 就绪(:${SERVER_PORT})"

pnpm --filter @hmp/web exec vite --host 127.0.0.1 --port "$WEB_PORT" --strictPort
