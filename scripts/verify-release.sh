#!/usr/bin/env bash
# verify:release —— 005 T144 最终全量验证聚合(根 package.json verify:release 入口)。
#
# 步骤(set -e:任一步非零即整体失败):
#   ① pnpm gen:types           共享类型生成(openapi → @hmp/shared)
#   ② pnpm lint                全仓库 eslint
#   ③ pnpm typecheck -r        全 workspace tsc --noEmit
#   ④ pnpm build -r            全 workspace 构建(server 含迁移产物拷贝;web vite build)
#   ④b 结构审计(规格007):server audit:boundaries(dependency-cruiser 层矩阵/
#      深导入/框架渗漏)+ audit:orphans(knip 孤儿文件/死导出)
#   ⑤ 全量组件/契约测试:server+web 两个 filter 的 vitest run(显式两条命令)
#   ⑥ PC E2E 全量(Playwright,cd apps/web;--workers=1 逐文件顺序执行 ——
#      混合并发会触发公共限频抖动,已知问题)。按「种子/无种子」分三组顺序执行,
#      每组各自经 webServer(scripts/e2e-servers.sh)拿到全新 DATA_DIR:
#        6a. 无种子组 A:foundation-smoke + auth-profile-flow(全新空库;
#            auth-profile-flow 首用例即「全新部署」,严禁种子);
#        6b. 无种子组 B:fresh-deployment-loop(T139 新环境完整闭环;需要
#            LAN_UPSTREAM_IP/LAN_ALLOWED_TARGETS/MEDIA_ROOTS 指向本机非回环 IP
#            与临时 NAS 根,套件内显式守卫,缺失即失败);
#        6c. 种子组:E2E_SEED_SCALE=1 的其余全部套件(T012 规模夹具)。
#   ⑦ pnpm test:runtime        runtime-smoke.mjs(真实 HTTP 多场景冒烟)
#
# 用法:bash scripts/verify-release.sh   (各步日志落 $VERIFY_LOG_DIR,默认 mktemp)
set -euo pipefail
cd "$(dirname "$0")/.."

LOG_DIR="${VERIFY_LOG_DIR:-$(mktemp -d /tmp/verify-release-logs.XXXXXX)}"
mkdir -p "$LOG_DIR"
export VERIFY_LOG_DIR="$LOG_DIR"

STEP=0
declare -a STEP_NAMES=()
declare -a STEP_SECONDS=()

run_step() {
  local name="$1"; shift
  STEP=$((STEP + 1))
  STEP_NAMES+=("$name")
  echo ""
  echo "======================================================================"
  echo "[verify:release] 步骤 ${STEP}: ${name}"
  echo "  命令: $*"
  echo "  日志: ${LOG_DIR}/step-${STEP}.log"
  echo "======================================================================"
  local started
  started=$(date +%s)
  local rc=0
  set +e
  "$@" >"${LOG_DIR}/step-${STEP}.log" 2>&1
  rc=$?
  set -e
  if [ "$rc" -ne 0 ]; then
    echo "[verify:release] ❌ 步骤 ${STEP}(${name})失败,退出码 ${rc};日志尾部:"
    tail -40 "${LOG_DIR}/step-${STEP}.log" || true
    exit "$rc"
  fi
  local elapsed=$(( $(date +%s) - started ))
  STEP_SECONDS+=("$elapsed")
  echo "[verify:release] ✅ 步骤 ${STEP}(${name})通过,耗时 ${elapsed}s"
}

# ①~④ 工具链先行(gen:types → lint → typecheck → build)
run_step "① gen:types" pnpm gen:types
run_step "② lint" pnpm lint
run_step "③ typecheck(-r)" pnpm -r typecheck
run_step "④ build(-r)" pnpm -r build

# ④b 结构边界与零遗留审计(规格007 宪章技术约束6/7 门禁)
run_step "④b audit:boundaries(007 结构门禁)" pnpm --filter @hmp/server audit:boundaries
run_step "④b audit:orphans(007 零遗留门禁)" pnpm --filter @hmp/server audit:orphans
# 008 纯度门禁(报告模式接入;T014 起 PURITY_ENFORCE 收紧为强制) — ADR-0015 D3
run_step "④b audit:purity(008 应用层纯度,迁移期报告模式)" env PURITY_ENFORCE=0 pnpm --filter @hmp/server audit:purity

# ⑤ 全量测试(server+web 全部 unit/contract/组件测试;显式 filter,不继承基础清单)
run_step "⑤a server 全量 vitest(unit+contract)" pnpm --filter @hmp/server test
run_step "⑤b web 全量 vitest(组件测试)" pnpm --filter @hmp/web test

# ⑥ PC E2E 全量(逐文件顺序:--workers=1;按种子/无种子分组,组内逐文件顺序)
# 6b(T139 fresh-deployment-loop)需要本机非回环 IPv4 与临时 NAS 根(套件内显式守卫):
LAN_IP="$(ipconfig getifaddr en0 2>/dev/null || ifconfig 2>/dev/null | awk '/inet /&&!/127\.0\.0\.1/{print $2; exit}')"
if [ -z "${LAN_IP}" ]; then
  echo "[verify:release] 无法解析本机非回环 IPv4(⑥b T139 需要);导出 LAN_UPSTREAM_IP 后重试" >&2
  exit 2
fi
FRESH_NAS_ROOT="$(mktemp -d /tmp/verify-release-fresh-nas.XXXXXX)"
# 端口预检:vite 代理把 API 钉在 :3000(playwright.config 注释),webServer 固定用
# 5173/3000 —— 并发任务占用时,本运行的 reuseExistingServer/端口冲突会静默测到
# 他人栈(实测:曾复用未种子化的并发 dev server,导致夹具日期/时区全错)。显式失败,
# 由操作者择时重跑,绝不静默换栈。
for port in 5173 3000; do
  if lsof -nP -iTCP:"$port" -sTCP:LISTEN >/dev/null 2>&1; then
    echo "[verify:release] 端口 ${port} 已被占用(vite API 代理钉死 :3000,无法换端口隔离);" >&2
    echo "  请等待占用该端口的并发任务结束再重跑 verify:release。" >&2
    exit 3
  fi
done
# CI=1:playwright 一律新起 webServer(reuseExistingServer=!CI),绝不复用机器上
# 可能存在的他人 dev server —— 保证「本次调用 = 本次种子 = 本次时钟锚定」。
e2e() {
  (cd apps/web && CI=1 "$@")
}
run_step "⑥a E2E 无种子组 A(foundation+auth-profile-flow,全新空库)" \
  e2e env -u E2E_SEED_SCALE pnpm exec playwright test --workers=1 \
  test/e2e/foundation-smoke.spec.ts test/e2e/auth-profile-flow.e2e.spec.ts
run_step "⑥b E2E 无种子组 B(fresh-deployment-loop,T139 新环境闭环)" \
  e2e env -u E2E_SEED_SCALE LAN_UPSTREAM_IP="$LAN_IP" LAN_ALLOWED_TARGETS="$LAN_IP" \
  MEDIA_ROOTS="nas-main=${FRESH_NAS_ROOT}" \
  pnpm exec playwright test --workers=1 test/e2e/fresh-deployment-loop.spec.ts
# ⑥c 种子组:逐文件「一次 playwright 调用 = 一次独立 webServer + 重新种子」。
# 依据:settings-access.spec 末位用例经 pin-recovery 把主 PIN 改为 246813、settings.spec
# 末位用例改掉夹具账号密码 —— 两套件均为「每 run 重新种子,天然隔离」设计(spec 注释
# 明示);聚合运行若多套件共享同一次调用的同一库,后续套件的固定 PIN/密码前置即 403
# (实测复现:settings-access→settings 三文件序列稳定复现 settings:116 403)。
# 故种子组必须逐文件独立调用(同时也是「逐文件顺序执行」的最严格形态,规避公共限频抖动)。
SEEDED_SPECS=(
  test/e2e/guide-keyboard-scroll-restore.spec.ts
  test/e2e/guide-performance.spec.ts
  test/e2e/home-personal.e2e.spec.ts
  test/e2e/live.spec.ts
  test/e2e/playback-intent.spec.ts
  test/e2e/public-browse-guest.spec.ts
  test/e2e/responsive-matrix.spec.ts
  test/e2e/settings-access.spec.ts
  test/e2e/settings.spec.ts
)
for spec in "${SEEDED_SPECS[@]}"; do
  run_step "⑥c E2E 种子组(独立调用,每文件重新种子): $(basename "$spec")" \
    e2e env E2E_SEED_SCALE=1 pnpm exec playwright test --workers=1 "$spec"
done

# ⑦ runtime 冒烟(真实 HTTP 多场景;自带临时 DATA_DIR/夹具,绝不触碰用户数据)
run_step "⑦ test:runtime(runtime-smoke.mjs)" pnpm test:runtime

echo ""
echo "======================================================================"
echo "[verify:release] 全部 ${STEP} 步通过。耗时汇总:"
TOTAL=0
for i in "${!STEP_NAMES[@]}"; do
  printf '  %2d) %-58s %ss\n' "$((i + 1))" "${STEP_NAMES[$i]}" "${STEP_SECONDS[$i]}"
  TOTAL=$((TOTAL + STEP_SECONDS[$i]))
done
printf '  合计 %ss(日志目录 %s)\n' "$TOTAL" "$LOG_DIR"
echo "======================================================================"
